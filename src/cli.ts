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
import { WORKFLOWS, type WorkflowDefinition } from "./cli/registry.ts";
import { type InputShape, routeIntent, type WorkflowName } from "./cli/router.ts";
import type { JevPort } from "./core/types.ts";
import { InputError } from "./workflows/errors.ts";
import type { WorkflowDependencies } from "./workflows/ports.ts";
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
class ClarificationError extends UsageError {}

const OPTIONS = {
  json: { type: "boolean" },
  model: { type: "string" },
  "no-persist": { type: "boolean" },
  repo: { type: "string" },
  concurrency: { type: "string" },
  "max-requests": { type: "string" },
  "max-input-tokens": { type: "string" },
  "timeout-seconds": { type: "string" },
  task: { type: "string" },
  "task-file": { type: "string" },
  scope: { type: "string" },
  base: { type: "string" },
  "task-source": { type: "string" },
  rules: { type: "string" },
  criteria: { type: "string" },
  "criteria-file": { type: "string" },
  "test-results": { type: "string" },
  "max-hunks": { type: "string" },
  "max-pairs": { type: "string" },
  "max-evidence": { type: "string" },
  input: { type: "string" },
  "no-diff": { type: "boolean" },
  "max-items": { type: "string" },
  paths: { type: "string", multiple: true },
  top: { type: "string" },
  excerpts: { type: "boolean" },
  "max-files": { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

type Values = Record<string, string | boolean | string[] | undefined>;

const WORKFLOW_OPTIONS = [
  "task",
  "task-file",
  "scope",
  "base",
  "task-source",
  "rules",
  "criteria",
  "criteria-file",
  "test-results",
  "max-hunks",
  "max-pairs",
  "max-evidence",
  "input",
  "no-diff",
  "max-items",
  "paths",
  "top",
  "excerpts",
  "max-files",
] as const;

const ALLOWED_OPTIONS: Record<WorkflowName, readonly string[]> = {
  find: ["task", "task-file", "paths", "top", "excerpts", "max-files"],
  check: [
    "task",
    "task-file",
    "scope",
    "base",
    "task-source",
    "rules",
    "criteria",
    "criteria-file",
    "test-results",
    "max-hunks",
    "max-pairs",
    "max-evidence",
  ],
  triage_failures: ["task", "task-file", "scope", "base", "input", "no-diff", "max-items"],
  triage_comments: ["scope", "base", "input", "no-diff", "max-items"],
};

const USAGE = 'jev-code "<request>" [options]';

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
  return `jev-code ${version()} - judgment for coding agents

Usage: ${USAGE}

Describe what you need in plain language. Jev routes the request to one bounded workflow:
  find relevant code
  check the current diff against a task and optional requirements
  triage supplied test or CI failures
  triage supplied review comments

Examples:
  jev-code "Find the code that retries webhook deliveries"
  jev-code "Check whether these changes fix null config values"
  npm test 2>&1 | jev-code "Triage these test failures"
  jev-code "Triage the review comments" --input comments.json

Input options:
  --input <path|->          Failure log or review-comment JSON (stdin is detected automatically)
  --task <text>             Exact task text when it differs from the request
  --task-file <path|->      Read exact task text from a workspace file or stdin
  --scope <kind>            Diff scope: worktree, staged, or branch (default worktree)
  --base <ref>              Base ref for a branch diff
  --no-diff                 Do not attach a diff to triage

Check options:
  --task-source <source>    user, issue, or agent
  --rules <path>            JSON project-rules file
  --criteria <text>         Numbered or bulleted acceptance criteria
  --criteria-file <path|->  Read acceptance criteria from a file or stdin
  --test-results <path|->   JSON or JUnit evidence for supplied criteria
  --max-hunks <n>           Maximum changed blocks eligible for judgment
  --max-pairs <n>           Maximum rule/hunk pairs eligible for judgment
  --max-evidence <n>        Maximum criteria evidence units

Find and triage options:
  --paths <glob>            Limit find candidates (repeatable)
  --top <n>                 Number of ranked files to return
  --excerpts                Include bounded excerpts from ranked files
  --max-files <n>           Maximum files eligible for find
  --max-items <n>           Maximum failures or comment threads eligible for triage

Run options:
  --json                    Emit the versioned JSON packet (schema jev-code.packet/v1)
  --model <id>              Jev model (default ${DEFAULT_MODEL}, or ${MODEL_ENV})
  --no-persist              Do not write .jev-code/runs artifacts
  --repo <dir>              Repository root (default: current Git repository)
  --concurrency <n>         Parallel workflow requests (1-16, default 4)
  --max-requests <n>        Workflow request budget; routing uses one additional request
  --max-input-tokens <n>    Workflow input-token budget
  --timeout-seconds <n>     Workflow wall-clock budget
  -h, --help                Show help
  -v, --version             Print the version

Exit codes: 0 complete; 10 incomplete coverage; 12 budget exhausted;
            64 usage or clarification; 65 invalid input; 70 internal error
Results are advisory. jev-code never edits code, runs tests, posts comments, or approves work.
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

function validateOptions(name: WorkflowName, values: Values): void {
  const allowed = ALLOWED_OPTIONS[name];
  for (const option of WORKFLOW_OPTIONS) {
    if (values[option] !== undefined && !allowed.includes(option)) {
      throw new UsageError(`--${option} is not used when the request routes to ${name.replace("_", " ")}`);
    }
  }
}

function classifyInput(text: string | null, dependencies: WorkflowDependencies): InputShape {
  if (!text?.trim()) return "none";
  try {
    dependencies.evidence.reviewComments(text);
    return "review_comments";
  } catch {
    // It is not review-comment JSON; test failure parsing is intentionally more permissive.
  }
  try {
    if (dependencies.evidence.failureLog(text).blocks.length > 0) return "failure_log";
  } catch {
    // The workflow will report detailed parser errors if this input is selected explicitly.
  }
  return "text";
}

function clarification(diff: "present" | "absent", input: InputShape): string {
  const context =
    input === "text"
      ? " The supplied input was not recognized as failures or review-comment JSON."
      : diff === "absent" && input === "none"
        ? " There is no current diff or recognized input to disambiguate the request."
        : "";
  return (
    "cannot tell what analysis you want. Should jev-code find relevant code, check the current diff, " +
    `triage test failures, or triage review comments?${context}`
  );
}

export async function runCli(
  argv: string[],
  io: CliIO,
  injected: { adapter?: JevPort } = {},
): Promise<number> {
  const wantsJson = argv.includes("--json");
  let selected: WorkflowName | null = null;
  try {
    if (argv.length === 0) {
      io.stdout.write(mainHelp());
      return EXIT.usage;
    }
    const { values, positionals } = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    const v = values as Values;
    if (v.help || (positionals.length === 1 && positionals[0] === "help")) {
      io.stdout.write(mainHelp());
      return EXIT.ok;
    }
    if (v.version) {
      io.stdout.write(`${version()}\n`);
      return EXIT.ok;
    }

    const request = positionals.join(" ").trim();
    if (!request) throw new UsageError("a natural-language request is required");
    if (request.includes("\0") || Buffer.byteLength(request) > 16 * 1024) {
      throw new UsageError("the request must be at most 16384 bytes and contain no null bytes");
    }
    if (typeof v.task === "string" && typeof v["task-file"] === "string") {
      throw new UsageError("use either --task or --task-file, not both");
    }
    if (typeof v.criteria === "string" && typeof v["criteria-file"] === "string") {
      throw new UsageError("use either --criteria or --criteria-file, not both");
    }
    const stdinOptions = ["input", "task-file", "criteria-file", "test-results"].filter(
      (name) => v[name] === "-",
    );
    if (stdinOptions.length > 1) throw new UsageError("only one input may be read from stdin");

    const jev = injected.adapter ?? jevFromEnvironment(io.env);
    const root = typeof v.repo === "string" ? await repoRoot(v.repo) : await repoRoot(io.cwd);
    const dependencies = createWorkflowDependencies(root, jev);
    const model = configuredModel(v.model as string | undefined, io.env);
    const options: RunOptions = {
      root,
      dependencies,
      persist: !v["no-persist"],
      budget: {
        requests: integer(v["max-requests"] as string | undefined, "max-requests", 1, 10_000),
        inputTokens: integer(v["max-input-tokens"] as string | undefined, "max-input-tokens", 1, 50_000_000),
        wallMs: ((seconds) => (seconds === undefined ? undefined : seconds * 1000))(
          integer(v["timeout-seconds"] as string | undefined, "timeout-seconds", 1, 3600),
        ),
      } as RunOptions["budget"],
    };
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
    const readTask = async (required: boolean, fallback?: string) => {
      if (typeof v["task-file"] === "string") return (await readInput(v["task-file"], "task")).text;
      if (typeof v.task === "string") return v.task;
      if (fallback) return fallback;
      if (required) throw new UsageError("task text is required in the request, --task, or --task-file");
      return undefined;
    };
    const diffSelection = () => {
      const scope =
        enumValue(v.scope as string | undefined, "scope", ["worktree", "staged", "branch"] as const) ??
        "worktree";
      return { scope, ...(typeof v.base === "string" ? { base: v.base } : {}) };
    };

    let supplied: { text: string; source: string } | null = null;
    if (typeof v.input === "string") supplied = await readInput(v.input, "input");
    else if (stdinOptions.length === 0 && !(io.stdin as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY) {
      stdinUsed = true;
      const text = await readStdin(io.stdin);
      if (text.trim()) supplied = { text, source: "stdin" };
    }

    const selection = diffSelection();
    const diffSource = await dependencies.source.collectDiff(selection);
    const diff = diffSource.text.trim() ? "present" : "absent";
    const input = classifyInput(supplied?.text ?? null, dependencies);
    const capabilities: Record<WorkflowName, boolean> = {
      find: true,
      check: diff === "present",
      triage_failures: input === "failure_log",
      triage_comments: input === "review_comments",
    };
    const decision = await routeIntent(
      {
        request,
        diff,
        input,
        capabilities,
        options: WORKFLOW_OPTIONS.filter((name) => v[name] !== undefined),
      },
      dependencies,
      model ?? DEFAULT_MODEL,
    );
    if (decision.outcome === "cannot_tell") throw new ClarificationError(clarification(diff, input));
    selected = decision.outcome;
    validateOptions(selected, v);
    if (supplied && selected !== "triage_failures" && selected !== "triage_comments") {
      throw new UsageError(`supplied input is not used when the request routes to ${selected}`);
    }

    let packet: Packet<unknown>;
    switch (selected) {
      case "check": {
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
        const task = (await readTask(true, request))!;
        const rules = typeof v.rules === "string" ? await readInput(v.rules, "rules", 512 * 1024) : null;
        const criteria =
          typeof v.criteria === "string"
            ? { text: v.criteria, source: "argument" }
            : typeof v["criteria-file"] === "string"
              ? await readInput(v["criteria-file"], "criteria")
              : null;
        const testResults =
          typeof v["test-results"] === "string" ? await readInput(v["test-results"], "test results") : null;
        packet = await WORKFLOWS.check.run(
          {
            task,
            rules,
            criteria,
            testResults,
            ...selection,
            ...(taskSource ? { taskSource } : {}),
            ...(maxHunks ? { maxHunks } : {}),
            ...(maxPairs ? { maxPairs } : {}),
            ...(maxEvidence ? { maxEvidenceUnits: maxEvidence } : {}),
          },
          options,
        );
        break;
      }
      case "triage_failures": {
        if (!supplied) throw new UsageError("test or CI failure input is required with --input or stdin");
        const maxItems = integer(v["max-items"] as string | undefined, "max-items", 1, 1000);
        const task = await readTask(false);
        packet = await WORKFLOWS.triage_failures.run(
          {
            text: supplied.text,
            source: supplied.source,
            ...(task ? { task } : {}),
            diff: v["no-diff"] ? null : selection,
            ...(maxItems ? { maxItems } : {}),
          },
          options,
        );
        break;
      }
      case "triage_comments": {
        if (!supplied) throw new UsageError("review-comment JSON is required with --input or stdin");
        const maxItems = integer(v["max-items"] as string | undefined, "max-items", 1, 1000);
        packet = await WORKFLOWS.triage_comments.run(
          {
            text: supplied.text,
            source: supplied.source,
            diff: v["no-diff"] ? null : selection,
            ...(maxItems ? { maxItems } : {}),
          },
          options,
        );
        break;
      }
      case "find": {
        const task = (await readTask(true, request))!;
        const top = integer(v.top as string | undefined, "top", 1, 50);
        const maxFiles = integer(v["max-files"] as string | undefined, "max-files", 1, 20_000);
        packet = await WORKFLOWS.find.run(
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
      const definition = WORKFLOWS[selected] as unknown as WorkflowDefinition<unknown, unknown>;
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
        `${JSON.stringify(
          { schema: "jev-code.error/v1", workflow: selected, error: { kind, message } },
          null,
          2,
        )}\n`,
      );
    }
    io.stderr.write(`jev-code${selected ? ` ${selected}` : ""}: ${kind} error: ${message}\n`);
    if (usage && !(error instanceof ClarificationError)) io.stderr.write(`usage: ${USAGE}\n`);
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
