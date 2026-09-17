#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { configuredModel, jevFromEnvironment, MODEL_ENV } from "./adapters/config.ts";
import { createWorkflowDependencies } from "./adapters/dependencies.ts";
import { GitError, repoRoot } from "./adapters/git.ts";
import { MissingCredentialError } from "./adapters/jev.ts";
import { readStdin, readWorkspaceFile } from "./adapters/paths.ts";
import { safeMessage } from "./adapters/redact.ts";
import { EXIT, exitCodeFor, renderHuman } from "./cli/output.ts";
import { WORKFLOWS, type WorkflowDefinition, type WorkflowName } from "./cli/registry.ts";
import type { JevPort } from "./core/types.ts";
import { InputError } from "./workflows/errors.ts";
import type { RunOptions } from "./workflows/run.ts";
import { TRIAGE_KINDS } from "./workflows/triage.ts";
import { DEFAULT_MODEL, type Packet } from "./workflows/types.ts";

export interface CliIO {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  stdin: NodeJS.ReadableStream;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

class UsageError extends Error {}

const GLOBAL_OPTIONS = {
  json: { type: "boolean" },
  model: { type: "string" },
  "no-persist": { type: "boolean" },
  repo: { type: "string" },
  concurrency: { type: "string" },
  "max-requests": { type: "string" },
  "max-input-tokens": { type: "string" },
  "timeout-seconds": { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

const DIFF_OPTIONS = { scope: { type: "string" }, base: { type: "string" } } as const;
const TASK_OPTIONS = { task: { type: "string" }, "task-file": { type: "string" } } as const;

const COMMAND_OPTIONS = {
  check: {
    ...TASK_OPTIONS,
    ...DIFF_OPTIONS,
    "task-source": { type: "string" },
    rules: { type: "string" },
    criteria: { type: "string" },
    "criteria-file": { type: "string" },
    "test-results": { type: "string" },
    "max-hunks": { type: "string" },
    "max-pairs": { type: "string" },
    "max-evidence": { type: "string" },
  },
  triage: {
    ...TASK_OPTIONS,
    ...DIFF_OPTIONS,
    kind: { type: "string" },
    input: { type: "string" },
    "no-diff": { type: "boolean" },
    "max-items": { type: "string" },
  },
  find: {
    ...TASK_OPTIONS,
    paths: { type: "string", multiple: true },
    top: { type: "string" },
    excerpts: { type: "boolean" },
    "max-files": { type: "string" },
  },
} as const;

const COMMAND_USAGE: Record<WorkflowName, string> = {
  check:
    "jev-code check --task <text> | --task-file <path|-> [--task-source user|issue|agent] [--rules <path>] [--criteria <text> | --criteria-file <path|->] [--test-results <json|junit path>] [--scope worktree|staged|branch] [--base <ref>] [--max-hunks N] [--max-pairs N] [--max-evidence N]",
  triage:
    "jev-code triage --kind failures|comments --input <path|-> [--task <text> | --task-file <path>] [--scope worktree|staged|branch] [--base <ref>] [--no-diff] [--max-items N]",
  find: 'jev-code find "<task>" | --task <text> | --task-file <path> [--paths <glob>]... [--top N] [--excerpts] [--max-files N]',
};

const COMMAND_NOTES: Record<WorkflowName, string[]> = {
  check: [
    "The task is required. Rules, criteria, and test results are optional and add sections to the same report.",
    "--rules is a JSON rules file. Criteria are a numbered or bulleted list. --test-results needs criteria.",
    'Inline criteria that start with "-" must be written as --criteria="- item"; numbered lists need no special form.',
  ],
  triage: [
    "--kind failures reads a test or CI log. --kind comments reads exported review comments as JSON.",
    "--task is context for failures only. --max-items defaults to 40 failures or 100 comment threads.",
  ],
  find: [],
};

function version(): string {
  try {
    return (
      JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
    ).version;
  } catch {
    return "unknown";
  }
}

function mainHelp(): string {
  const width = Math.max(...Object.keys(WORKFLOWS).map((name) => name.length));
  const entries = Object.entries(WORKFLOWS) as Array<[string, WorkflowDefinition<unknown, unknown>]>;
  const commands = entries
    .map(([name, workflow]) => `  ${name.padEnd(width)}  ${workflow.summary}`)
    .join("\n");
  return `jev-code ${version()} — judgment tools for coding agents

Usage: jev-code <command> [options]

Experimental: every command and report may change.

Commands:
${commands}

Global options:
  --json                    Emit the versioned JSON packet (schema jev-code.packet/v1)
  --model <id>              Jev model (default ${DEFAULT_MODEL}, or ${MODEL_ENV})
  --no-persist              Do not write .jev-code/runs artifacts
  --repo <dir>              Repository root (default: git top level of the current directory)
  --concurrency <n>         Parallel Jev requests (1-16, default 4)
  --max-requests <n>        Override the workflow request budget
  --max-input-tokens <n>    Override the workflow input-token budget
  --timeout-seconds <n>     Override the workflow wall-clock budget
  -h, --help                Show help (use "jev-code <command> --help" for a command)
  --version                 Print the version

Exit codes: 0 complete · 10 incomplete coverage · 12 budget exhausted ·
            64 usage error · 65 invalid input · 70 internal error
Results are advisory. No command edits your code, runs tests, posts comments, or approves anything.
Every report lists what was not checked. "No flags" is not an approval.
TYPESAFE_API_KEY is required and read from the process environment only.
`;
}

function integer(value: string | undefined, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError(`--${name} must be a whole number`);
  const parsed = Number(value);
  if (parsed < min || parsed > max) throw new UsageError(`--${name} must be between ${min} and ${max}`);
  return parsed;
}

function enumValue<T extends string>(
  value: string | undefined,
  name: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) throw new UsageError(`--${name} must be one of ${allowed.join(", ")}`);
  return value as T;
}

export async function runCli(argv: string[], io: CliIO, deps: { adapter?: JevPort } = {}): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    io.stdout.write(mainHelp());
    return command ? EXIT.ok : EXIT.usage;
  }
  if (command === "--version" || command === "-v") {
    io.stdout.write(`${version()}\n`);
    return EXIT.ok;
  }
  if (!Object.hasOwn(WORKFLOWS, command)) {
    io.stderr.write(`jev-code: unknown command "${command.slice(0, 40)}"\n\n${mainHelp()}`);
    return EXIT.usage;
  }
  const name = command as WorkflowName;
  const wantsJson = rest.includes("--json");
  try {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { ...GLOBAL_OPTIONS, ...COMMAND_OPTIONS[name] },
      allowPositionals: name === "find",
      strict: true,
    });
    const v = values as Record<string, string | boolean | string[] | undefined>;
    if (v.help) {
      const notes = COMMAND_NOTES[name].map((note) => `${note}\n`).join("");
      io.stdout.write(
        `${WORKFLOWS[name].summary}\n\nUsage: ${COMMAND_USAGE[name]}\n\n${notes}${notes ? "\n" : ""}Experimental: this command and its report may change.\n\nRun "jev-code --help" for global options.\n`,
      );
      return EXIT.ok;
    }
    const jev = deps.adapter ?? jevFromEnvironment(io.env);
    const root = typeof v.repo === "string" ? await repoRoot(v.repo) : await repoRoot(io.cwd);
    const options: RunOptions = {
      root,
      dependencies: createWorkflowDependencies(root, jev),
      persist: !v["no-persist"],
      budget: {
        requests: integer(v["max-requests"] as string | undefined, "max-requests", 1, 10_000),
        inputTokens: integer(v["max-input-tokens"] as string | undefined, "max-input-tokens", 1, 50_000_000),
        wallMs: ((seconds) => (seconds === undefined ? undefined : seconds * 1000))(
          integer(v["timeout-seconds"] as string | undefined, "timeout-seconds", 1, 3600),
        ),
      } as RunOptions["budget"],
    };
    const model = configuredModel(v.model as string | undefined, io.env);
    if (model !== undefined) options.model = model;
    const concurrency = integer(v.concurrency as string | undefined, "concurrency", 1, 16);
    if (concurrency !== undefined) options.concurrency = concurrency;

    let stdinUsed = false;
    const readInput = async (value: string, label: string, maxBytes?: number) => {
      if (value === "-") {
        if (stdinUsed) throw new UsageError("only one input may be read from stdin");
        stdinUsed = true;
        return { text: await readStdin(io.stdin, maxBytes), source: "stdin" };
      }
      const file = await readWorkspaceFile(root, value, maxBytes);
      if (file.text.length === 0) throw new InputError(`${label} file is empty`);
      return { text: file.text, source: file.path };
    };
    const readTask = async (required: boolean) => {
      if (typeof v.task === "string" && typeof v["task-file"] === "string") {
        throw new UsageError("use either --task or --task-file, not both");
      }
      if (typeof v["task-file"] === "string") return (await readInput(v["task-file"], "task")).text;
      if (typeof v.task === "string") return v.task;
      if (required) throw new UsageError("a task is required (--task or --task-file)");
      return undefined;
    };
    const diffSelection = () => {
      const scope =
        enumValue(v.scope as string | undefined, "scope", ["worktree", "staged", "branch"] as const) ??
        "worktree";
      return { scope, ...(typeof v.base === "string" ? { base: v.base } : {}) };
    };

    let packet: Packet<unknown>;
    switch (name) {
      case "check": {
        if (typeof v.criteria === "string" && typeof v["criteria-file"] === "string") {
          throw new UsageError("use either --criteria or --criteria-file, not both");
        }
        if (v.rules === "-") throw new UsageError("--rules must be an explicit file, not stdin");
        const hasCriteria = typeof v.criteria === "string" || typeof v["criteria-file"] === "string";
        if (typeof v["test-results"] === "string" && !hasCriteria) {
          throw new UsageError("--test-results needs --criteria or --criteria-file");
        }
        const taskSource = enumValue(v["task-source"] as string | undefined, "task-source", [
          "user",
          "issue",
          "agent",
        ] as const);
        const maxHunks = integer(v["max-hunks"] as string | undefined, "max-hunks", 1, 2000);
        const maxPairs = integer(v["max-pairs"] as string | undefined, "max-pairs", 1, 5000);
        const maxEvidence = integer(v["max-evidence"] as string | undefined, "max-evidence", 1, 1000);
        const task = (await readTask(true))!;
        const rules = typeof v.rules === "string" ? await readInput(v.rules, "rules", 512 * 1024) : null;
        const criteria =
          typeof v.criteria === "string"
            ? { text: v.criteria, source: "argument" }
            : typeof v["criteria-file"] === "string"
              ? await readInput(v["criteria-file"], "criteria")
              : null;
        const testResults =
          typeof v["test-results"] === "string" ? await readInput(v["test-results"], "test results") : null;
        packet = await WORKFLOWS[name].run(
          {
            task,
            rules,
            criteria,
            testResults,
            ...diffSelection(),
            ...(taskSource ? { taskSource } : {}),
            ...(maxHunks ? { maxHunks } : {}),
            ...(maxPairs ? { maxPairs } : {}),
            ...(maxEvidence ? { maxEvidenceUnits: maxEvidence } : {}),
          },
          options,
        );
        break;
      }
      case "triage": {
        const kind = enumValue(v.kind as string | undefined, "kind", TRIAGE_KINDS);
        if (!kind) throw new UsageError(`--kind ${TRIAGE_KINDS.join("|")} is required`);
        if (typeof v.input !== "string") throw new UsageError("--input <path|-> is required");
        const hasTask = typeof v.task === "string" || typeof v["task-file"] === "string";
        if (hasTask && kind !== "failures") throw new UsageError("--task is only used with --kind failures");
        const maxItems = integer(v["max-items"] as string | undefined, "max-items", 1, 1000);
        const input = await readInput(v.input, kind === "failures" ? "log" : "comments");
        const task = await readTask(false);
        packet = await WORKFLOWS[name].run(
          {
            kind,
            text: input.text,
            source: input.source,
            ...(task ? { task } : {}),
            diff: v["no-diff"] ? null : diffSelection(),
            ...(maxItems ? { maxItems } : {}),
          },
          options,
        );
        break;
      }
      case "find": {
        if (positionals.length > 1) throw new UsageError("pass the task as one quoted argument");
        const flagTask = await readTask(false);
        if (flagTask && positionals.length > 0)
          throw new UsageError("pass the task either positionally or with --task");
        const task = flagTask ?? positionals[0];
        if (!task) throw new UsageError("a task is required");
        const top = integer(v.top as string | undefined, "top", 1, 50);
        const maxFiles = integer(v["max-files"] as string | undefined, "max-files", 1, 20_000);
        packet = await WORKFLOWS[name].run(
          {
            task,
            ...(Array.isArray(v.paths) ? { paths: v.paths } : {}),
            ...(top ? { top } : {}),
            ...(maxFiles ? { maxFiles } : {}),
            includeExcerpts: Boolean(v.excerpts),
          },
          options,
        );
        break;
      }
    }
    if (v.json) io.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
    else {
      const definition = WORKFLOWS[name] as unknown as WorkflowDefinition<unknown, unknown>;
      io.stdout.write(renderHuman(packet, definition.render(packet)));
    }
    return exitCodeFor(packet);
  } catch (error) {
    const usage =
      error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
    const input =
      error instanceof MissingCredentialError || error instanceof InputError || error instanceof GitError;
    const code = usage ? EXIT.usage : input ? EXIT.input : EXIT.internal;
    const kind = usage ? "usage" : input ? "input" : "internal";
    const message = safeMessage(error);
    if (wantsJson) {
      io.stdout.write(
        `${JSON.stringify({ schema: "jev-code.error/v1", command: name, error: { kind, message } }, null, 2)}\n`,
      );
    }
    io.stderr.write(`jev-code ${name}: ${kind} error: ${message}\n`);
    if (usage) io.stderr.write(`usage: ${COMMAND_USAGE[name]}\n`);
    return code;
  }
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const code = await runCli(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    cwd: process.cwd(),
    env: process.env,
  });
  process.exitCode = code;
}
