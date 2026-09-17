#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { configuredModel, jevFromEnvironment, MODEL_ENV } from "./adapters/config.ts";
import { createWorkflowDependencies } from "./adapters/dependencies.ts";
import { GitError, repoRoot } from "./adapters/git.ts";
import { readStdin, readWorkspaceFile } from "./adapters/paths.ts";
import { safeMessage } from "./adapters/redact.ts";
import { EXIT, exitCodeFor, renderHuman } from "./cli/output.ts";
import { type Stability, WORKFLOWS, type WorkflowDefinition, type WorkflowName } from "./cli/registry.ts";
import type { JevPort } from "./core/types.ts";
import { InputError } from "./workflows/errors.ts";
import type { RunOptions } from "./workflows/run.ts";
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
  offline: { type: "boolean" },
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
  "flag-diff": {
    ...TASK_OPTIONS,
    ...DIFF_OPTIONS,
    "task-source": { type: "string" },
    "max-hunks": { type: "string" },
  },
  "triage-failures": {
    ...TASK_OPTIONS,
    ...DIFF_OPTIONS,
    log: { type: "string" },
    "no-diff": { type: "boolean" },
    "max-failures": { type: "string" },
  },
  "flag-rules": { ...DIFF_OPTIONS, rules: { type: "string" }, "max-pairs": { type: "string" } },
  "map-criteria": {
    ...DIFF_OPTIONS,
    criteria: { type: "string" },
    "criteria-file": { type: "string" },
    "test-results": { type: "string" },
    "max-evidence": { type: "string" },
  },
  "triage-comments": {
    ...DIFF_OPTIONS,
    comments: { type: "string" },
    "no-diff": { type: "boolean" },
    "max-comments": { type: "string" },
  },
  locate: {
    ...TASK_OPTIONS,
    paths: { type: "string", multiple: true },
    top: { type: "string" },
    excerpts: { type: "boolean" },
    "max-files": { type: "string" },
  },
  "run-frame": { file: { type: "string" } },
} as const;

const COMMAND_USAGE: Record<WorkflowName, string> = {
  "flag-diff":
    "jev-code flag-diff --task <text> | --task-file <path> [--task-source user|issue|agent] [--scope worktree|staged|branch] [--base <ref>] [--max-hunks N]",
  "triage-failures":
    "jev-code triage-failures --log <path|-> [--task <text> | --task-file <path>] [--scope ...] [--base <ref>] [--no-diff] [--max-failures N]",
  "flag-rules": "jev-code flag-rules --rules <path> [--scope ...] [--base <ref>] [--max-pairs N]",
  "map-criteria":
    "jev-code map-criteria --criteria <text> | --criteria-file <path|-> [--test-results <json|junit path>] [--scope ...] [--base <ref>] [--max-evidence N]",
  "triage-comments":
    "jev-code triage-comments --comments <path|-> [--scope ...] [--base <ref>] [--no-diff] [--max-comments N]",
  locate:
    'jev-code locate "<task>" | --task <text> | --task-file <path> [--paths <glob>]... [--top N] [--excerpts] [--max-files N]',
  "run-frame": "jev-code run-frame --file <workspace-relative frame.json>",
};

const STABILITY_NOTE: Record<Stability, string> = {
  stable: "",
  preview: "Preview: works, but output and thresholds may change in a minor release.",
  experimental: "Experimental: not part of the 0.1 launch surface; may change or be removed.",
  advanced:
    "Advanced: a constrained escape hatch, not a workflow. No thresholds or decisions are applied to answers.",
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
  const group = (title: string, stability: Stability) =>
    `${title}:\n${entries
      .filter(([, workflow]) => workflow.stability === stability)
      .map(([name, workflow]) => `  ${name.padEnd(width)}  ${workflow.summary}`)
      .join("\n")}`;
  return `jev-code ${version()} — pre-review triage for coding-agent changes

Usage: jev-code <command> [options]

${group("Commands", "stable")}

${group("Preview commands (output may change)", "preview")}

${group("Experimental commands (not part of the 0.1 launch surface)", "experimental")}

${group("Advanced", "advanced")}

Global options:
  --json                    Emit the stable JSON packet (schema jev-code.packet/v1)
  --model <id>              Jev model (default ${DEFAULT_MODEL}, or ${MODEL_ENV})
  --offline                 Run built-in checks only; never call Jev
  --no-persist              Do not write .jev-code/runs artifacts
  --repo <dir>              Repository root (default: git top level of the current directory)
  --concurrency <n>         Parallel Jev requests (1-16, default 4)
  --max-requests <n>        Override the workflow request budget
  --max-input-tokens <n>    Override the workflow input-token budget
  --timeout-seconds <n>     Override the workflow wall-clock budget
  -h, --help                Show help (use "jev-code <command> --help" for a command)
  --version                 Print the version

Exit codes: 0 complete · 10 incomplete coverage · 11 Jev not called (built-in checks only) ·
            12 budget exhausted · 64 usage error · 65 invalid input · 70 internal error
Results are advisory. No command edits your code, runs tests, posts comments, or approves anything.
Every report lists what was not checked. "No flags" is not an approval.
TYPESAFE_API_KEY is read from the process environment only.
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
      allowPositionals: name === "locate",
      strict: true,
    });
    const v = values as Record<string, string | boolean | string[] | undefined>;
    if (v.help) {
      const note = STABILITY_NOTE[WORKFLOWS[name].stability];
      io.stdout.write(
        `${WORKFLOWS[name].summary}\n${note ? `\n${note}\n` : ""}\nUsage: ${COMMAND_USAGE[name]}\n\nRun "jev-code --help" for global options.\n`,
      );
      return EXIT.ok;
    }
    const root = typeof v.repo === "string" ? await repoRoot(v.repo) : await repoRoot(io.cwd);
    // Missing credentials leave the port unset, which the run reports as Jev unavailable.
    const jev = deps.adapter ?? (v.offline ? undefined : jevFromEnvironment(io.env));
    const options: RunOptions = {
      root,
      dependencies: createWorkflowDependencies(root, jev),
      persist: !v["no-persist"],
      offline: Boolean(v.offline),
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
      case "flag-diff": {
        const taskSource = enumValue(v["task-source"] as string | undefined, "task-source", [
          "user",
          "issue",
          "agent",
        ] as const);
        const maxHunks = integer(v["max-hunks"] as string | undefined, "max-hunks", 1, 2000);
        packet = await WORKFLOWS[name].run(
          {
            task: (await readTask(true))!,
            ...diffSelection(),
            ...(taskSource ? { taskSource } : {}),
            ...(maxHunks ? { maxHunks } : {}),
          },
          options,
        );
        break;
      }
      case "triage-failures": {
        if (typeof v.log !== "string") throw new UsageError("--log <path|-> is required");
        const log = await readInput(v.log, "log");
        const task = await readTask(false);
        const maxFailures = integer(v["max-failures"] as string | undefined, "max-failures", 1, 500);
        packet = await WORKFLOWS[name].run(
          {
            log: log.text,
            logSource: log.source,
            ...(task ? { task } : {}),
            diff: v["no-diff"] ? null : diffSelection(),
            ...(maxFailures ? { maxFailures } : {}),
          },
          options,
        );
        break;
      }
      case "locate": {
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
      case "map-criteria": {
        if ((typeof v.criteria === "string") === (typeof v["criteria-file"] === "string")) {
          throw new UsageError("supply exactly one of --criteria or --criteria-file");
        }
        const criteria =
          typeof v.criteria === "string"
            ? { text: v.criteria, source: "argument" }
            : await readInput(v["criteria-file"] as string, "criteria");
        const testResults =
          typeof v["test-results"] === "string" ? await readInput(v["test-results"], "test results") : null;
        const maxEvidence = integer(v["max-evidence"] as string | undefined, "max-evidence", 1, 1000);
        packet = await WORKFLOWS[name].run(
          {
            criteria: criteria.text,
            criteriaSource: criteria.source,
            testResults,
            ...diffSelection(),
            ...(maxEvidence ? { maxEvidenceUnits: maxEvidence } : {}),
          },
          options,
        );
        break;
      }
      case "flag-rules": {
        if (typeof v.rules !== "string" || v.rules === "-")
          throw new UsageError("--rules <path> (an explicit file) is required");
        const rules = await readInput(v.rules, "rules", 512 * 1024);
        const maxPairs = integer(v["max-pairs"] as string | undefined, "max-pairs", 1, 5000);
        packet = await WORKFLOWS[name].run(
          {
            rules: rules.text,
            rulesSource: rules.source,
            ...diffSelection(),
            ...(maxPairs ? { maxPairs } : {}),
          },
          options,
        );
        break;
      }
      case "triage-comments": {
        if (typeof v.comments !== "string") throw new UsageError("--comments <path|-> is required");
        const comments = await readInput(v.comments, "comments");
        const maxComments = integer(v["max-comments"] as string | undefined, "max-comments", 1, 1000);
        packet = await WORKFLOWS[name].run(
          {
            comments: comments.text,
            commentsSource: comments.source,
            diff: v["no-diff"] ? null : diffSelection(),
            ...(maxComments ? { maxComments } : {}),
          },
          options,
        );
        break;
      }
      case "run-frame": {
        if (typeof v.file !== "string" || v.file === "-")
          throw new UsageError("--file <workspace-relative path> is required");
        packet = await WORKFLOWS[name].run({ file: v.file }, options);
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
    const input = error instanceof InputError || error instanceof GitError;
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
