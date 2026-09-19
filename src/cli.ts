#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { configuredModel, jevFromEnvironment, MODEL_ENV } from "./adapters/config.ts";
import { createWorkflowDependencies } from "./adapters/dependencies.ts";
import { GitError, repoRoot } from "./adapters/git.ts";
import {
  CANDIDATE_DIRECTORY,
  enqueueImprovement,
  IMPROVEMENT_DIRECTORY,
  listCandidates,
  PromotionError,
  pendingImprovements,
  promoteCandidate,
  quarantinePluginFiles,
  runImprovementWorker,
  spawnImprovementWorker,
  WORKER_FLAG,
  workerRunning,
} from "./adapters/improvements.ts";
import { MissingCredentialError } from "./adapters/jev.ts";
import { readStdin, readWorkspaceFile } from "./adapters/paths.ts";
import {
  AGENT_ENV,
  AGENT_MODEL_ENV,
  type AgentAvailability,
  agentFromEnvironment,
  NESTED_ENV,
  PI_BINARY_ENV,
} from "./adapters/pi.ts";
import {
  cleanupPlugins,
  type LoadedPlugin,
  PLUGIN_DIRECTORY,
  pluginDirectoryChanges,
  pluginDirectoryFingerprint,
} from "./adapters/plugins.ts";
import { safeMessage } from "./adapters/redact.ts";
import { createPluginJudge } from "./cli/judge.ts";
import { EXIT } from "./cli/output.ts";
import {
  jsonPromptResult,
  packetPromptResult,
  promptResultExitCode,
  renderPromptResult,
  unsupportedPromptResult,
} from "./cli/plugin-output.ts";
import { type FallbackReason, PluginPromptRuntime } from "./cli/plugin-runtime.ts";
import {
  createDefaultRegistry,
  type RegisteredWorkflow,
  registerRepositoryPlugins,
  WORKFLOWS,
  type WorkflowDefinition,
  type WorkflowName,
} from "./cli/registry.ts";
import { type InputShape, type RoutingDecision, RoutingError, routeIntent } from "./cli/router.ts";
import { Budget } from "./core/budget.ts";
import { isPluginValue, type PluginValue, type PromptResult } from "./core/plugin.ts";
import type { JevPort } from "./core/types.ts";
import {
  AGENT_LIMITS,
  type CodingAgentPort,
  delegationInstructions,
  delegationResult,
} from "./workflows/agent.ts";
import { InputError } from "./workflows/errors.ts";
import { CODE_CHANGE_FALLBACK_NOTICE } from "./workflows/find.ts";
import { createImprovementJob } from "./workflows/improve.ts";
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
  "no-agent": { type: "boolean" },
  "agent-timeout-seconds": { type: "string" },
  "improve-worker": { type: "boolean" },
  "promote-candidate": { type: "string" },
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
  review: ["task", "task-file", "scope", "base", "max-hunks"],
  test_gaps: ["task", "task-file", "scope", "base", "max-hunks"],
  summarize: ["scope", "base", "max-hunks"],
  security_review: ["task", "task-file", "scope", "base", "max-hunks"],
  performance_review: ["task", "task-file", "scope", "base", "max-hunks"],
  compatibility_review: ["task", "task-file", "scope", "base", "max-hunks"],
};

const USAGE = 'stanley "<request>" [options]';

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
  return `stanley ${version()} - Jev-first, self-improving coding agent

Usage: ${USAGE}

Describe what you need in plain language. Jev routes the request to one available workflow. Built-ins can:
  find relevant code
  check the current diff against a task and optional requirements
  review the current diff for correctness, test gaps, security, performance, or compatibility
  summarize the current diff as structured change categories
  triage supplied test or CI failures
  triage supplied review comments
Trusted repository plugins from .stanley/plugins/ extend this list. Requests no workflow supports are delegated
to the installed Pi coding agent, and Stanley then queues a bounded attempt to write a workflow for next time.

Examples:
  stanley "Find the code that retries webhook deliveries"
  stanley "Check whether these changes fix null config values"
  stanley "Review these changes for bugs"
  stanley "Are there security issues in this diff?"
  stanley "Summarize what changed"
  npm test 2>&1 | stanley "Triage these test failures"
  stanley "Triage the review comments" --input comments.json

Input options:
  --input <path|->          Workflow text/JSON, a failure log, or review comments (stdin is detected automatically)
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
  --json                    Emit a versioned result (schema stanley.prompt-result/v1)
  --model <id>              Jev model (default ${DEFAULT_MODEL}, or ${MODEL_ENV})
  --no-persist              Do not write .stanley/runs artifacts
  --repo <dir>              Repository root (default: current Git repository)
  --concurrency <n>         Parallel workflow requests (1-16, default 4)
  --max-requests <n>        Shared request budget for routing and composed workflows
  --max-input-tokens <n>    Shared input-token budget for the invocation tree
  --timeout-seconds <n>     Shared wall-clock budget for the invocation tree
  -h, --help                Show help
  -v, --version             Print the version

Agent fallback and self-improvement:
  --no-agent                Never delegate to the coding agent or queue improvements (also ${AGENT_ENV}=off)
  --agent-timeout-seconds <n>  Wall-clock limit for one delegated agent run (default ${AGENT_LIMITS.defaultTimeoutMs / 1000})
  ${WORKER_FLAG}          Run queued improvement jobs in the foreground, then exit (no request)
  --promote-candidate <id>  Activate a validated candidate from ${CANDIDATE_DIRECTORY}/ into .stanley/plugins/
  ${PI_BINARY_ENV}, ${AGENT_MODEL_ENV}  Pi binary path (default: pi on PATH) and optional Pi model

Exit codes: 0 complete; 10 incomplete coverage; 12 budget exhausted;
            64 usage or unsupported request; 65 invalid input; 70 internal error
Bundled results are advisory and read-only. Trusted repository plugins and the coding agent may change files.
Delegated results are reported as the agent's own account and are never verified by Stanley.
Without an agent, unsupported implement or fix requests return exit 64 after a read-only relevant-code analysis.
Every bundled report lists what was not checked. "No flags" is not an approval.
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

function validateOptions(name: string, values: Values): void {
  if (!(name in ALLOWED_OPTIONS)) {
    for (const option of WORKFLOW_OPTIONS) {
      if (values[option] !== undefined && !["input", "scope", "base"].includes(option)) {
        throw new UsageError(`--${option} is not used when the request routes to ${name}`);
      }
    }
    return;
  }
  const allowed = ALLOWED_OPTIONS[name as WorkflowName];
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
    "cannot tell what analysis you want. Should Stanley find relevant code; check, review, or summarize the current diff; " +
    `inspect its test, security, performance, or compatibility risks; or triage supplied failures or comments?${context}`
  );
}

type UnsupportedAction = "code_change" | "external_action" | null;

function unsupportedAction(request: string): UnsupportedAction {
  const normalized = request
    .trim()
    .toLowerCase()
    .replace(/^(?:(?:please|can you|could you|would you|i (?:need|want) you to|help me|let's)\s+)+/, "");
  if (
    /^(?:fix|implement|build|create|develop|refactor|edit|modify|update|write|add|remove|make|solve|apply)\b/.test(
      normalized,
    )
  ) {
    return "code_change";
  }
  if (
    /^(?:commit|push|deploy|reply|resolve|merge|revert)\b/.test(normalized) ||
    /^(?:run|execute)\s+(?:the\s+)?(?:tests?|build|lint|typecheck|command|script)\b/.test(normalized)
  ) {
    return "external_action";
  }
  return null;
}

const DEFAULT_TREE_BUDGET = {
  requests: 600,
  inputTokens: 1_200_000,
  wallMs: 180_000,
} as const;

/** Deterministic capability gates for every registered workflow. */
function capabilitiesFor(
  registry: ReturnType<typeof createDefaultRegistry>,
  shape: InputShape,
  currentDiff: "present" | "absent",
  excluded: ReadonlySet<string>,
): Record<string, boolean> {
  const capabilities: Record<string, boolean> = {
    find: !excluded.has("find"),
    check: currentDiff === "present" && !excluded.has("check"),
    triage_failures: shape === "failure_log" && !excluded.has("triage_failures"),
    triage_comments: shape === "review_comments" && !excluded.has("triage_comments"),
    review: currentDiff === "present" && !excluded.has("review"),
    test_gaps: currentDiff === "present" && !excluded.has("test_gaps"),
    summarize: currentDiff === "present" && !excluded.has("summarize"),
    security_review: currentDiff === "present" && !excluded.has("security_review"),
    performance_review: currentDiff === "present" && !excluded.has("performance_review"),
    compatibility_review: currentDiff === "present" && !excluded.has("compatibility_review"),
  };
  for (const workflow of registry.workflows()) {
    if (workflow.kind === "plugin") capabilities[workflow.id] = !excluded.has(workflow.id);
  }
  return capabilities;
}

/** Why the top-level request was not routed to a workflow. */
type RouteReason = RoutingDecision["reason"] | "no_candidates" | "routing_error" | "action_guard" | "skipped";

export interface CliInjections {
  adapter?: JevPort;
  signal?: AbortSignal;
  /** The coding agent; `null` disables delegation. Defaults to Pi from the environment. */
  agent?: CodingAgentPort | null;
  /** Starts the detached improvement worker. Defaults to spawning `node cli.js --improve-worker`. */
  spawnWorker?: (root: string) => void;
}

function pluginInput(text: string | null): PluginValue | undefined {
  if (text === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isPluginValue(parsed)) return parsed;
  } catch {
    // Plain text is a valid plugin input.
  }
  return text;
}

function pluginInputText(value: PluginValue | undefined): string | null {
  if (value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function writePromptResult(result: PromptResult, json: boolean, io: CliIO): number {
  io.stdout.write(
    json ? `${JSON.stringify(jsonPromptResult(result), null, 2)}\n` : renderPromptResult(result),
  );
  return promptResultExitCode(result);
}

type DiffSelection = {
  scope: "worktree" | "staged" | "branch";
  base?: string;
};

async function runNestedBuiltin(
  workflow: RegisteredWorkflow,
  request: string,
  input: PluginValue | undefined,
  selection: DiffSelection,
  options: RunOptions,
  fallback: (
    request: string,
    input: PluginValue | undefined,
    reason: FallbackReason,
  ) => Promise<PromptResult>,
): Promise<PromptResult> {
  if (!(workflow.id in WORKFLOWS)) return fallback(request, input, "unavailable");
  const name = workflow.id as WorkflowName;
  const text = pluginInputText(input);
  let packet: Packet<unknown>;
  switch (name) {
    case "find":
      packet = await WORKFLOWS.find.run({ task: request }, options);
      break;
    case "check":
      packet = await WORKFLOWS.check.run({ task: request, ...selection }, options);
      break;
    case "triage_failures":
      if (text === null) return fallback(request, input, "unavailable");
      packet = await WORKFLOWS.triage_failures.run(
        { text, source: "plugin prompt", diff: selection },
        options,
      );
      break;
    case "triage_comments":
      if (text === null) return fallback(request, input, "unavailable");
      packet = await WORKFLOWS.triage_comments.run(
        { text, source: "plugin prompt", diff: selection },
        options,
      );
      break;
    case "review":
    case "test_gaps":
    case "summarize":
    case "security_review":
    case "performance_review":
    case "compatibility_review": {
      const definition = WORKFLOWS[name] as unknown as WorkflowDefinition<
        {
          request: string;
          scope: "worktree" | "staged" | "branch";
          base?: string;
        },
        unknown
      >;
      packet = await definition.run({ request, ...selection }, options);
      break;
    }
  }
  const definition = WORKFLOWS[name] as unknown as WorkflowDefinition<unknown, unknown>;
  return packetPromptResult(packet, definition.render(packet));
}

export async function runCli(argv: string[], io: CliIO, injected: CliInjections = {}): Promise<number> {
  const wantsJson = argv.includes("--json");
  let selected: string | null = null;
  let loadedPlugins: readonly LoadedPlugin[] = [];
  const signal = injected.signal ?? new AbortController().signal;
  const warnPlugin = (message: string) => {
    io.stderr.write(`${safeMessage(message)}\n`);
  };
  const nested = Boolean(io.env[NESTED_ENV]?.trim());
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
    const workerMode = Boolean(v["improve-worker"]);
    const promotion = typeof v["promote-candidate"] === "string" ? v["promote-candidate"] : null;
    if (workerMode && promotion !== null) {
      throw new UsageError(`use either ${WORKER_FLAG} or --promote-candidate, not both`);
    }
    if ((workerMode || promotion !== null) && request) {
      throw new UsageError(`${workerMode ? WORKER_FLAG : "--promote-candidate"} does not take a request`);
    }
    if (!request && !workerMode && promotion === null) {
      throw new UsageError("a natural-language request is required");
    }
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
    const sharedBudget = new Budget({
      requests: options.budget?.requests ?? DEFAULT_TREE_BUDGET.requests,
      inputTokens: options.budget?.inputTokens ?? DEFAULT_TREE_BUDGET.inputTokens,
      wallMs: options.budget?.wallMs ?? DEFAULT_TREE_BUDGET.wallMs,
    });
    options.sharedBudget = sharedBudget;
    options.signal = signal;
    if (model !== undefined) options.model = model;
    const concurrency = integer(v.concurrency as string | undefined, "concurrency", 1, 16);
    if (concurrency !== undefined) options.concurrency = concurrency;

    const availability: AgentAvailability = nested
      ? { agent: null, reason: "nested" }
      : v["no-agent"]
        ? { agent: null, reason: "disabled" }
        : injected.agent !== undefined
          ? injected.agent
            ? { agent: injected.agent }
            : { agent: null, reason: "disabled" }
          : agentFromEnvironment(io.env);
    const agent = availability.agent;
    const agentTimeoutMs =
      (integer(v["agent-timeout-seconds"] as string | undefined, "agent-timeout-seconds", 1, 3600) ??
        AGENT_LIMITS.defaultTimeoutMs / 1000) * 1000;
    let workerStarted = false;
    const startWorker = () => {
      if (workerStarted) return;
      workerStarted = true;
      if (injected.spawnWorker) injected.spawnWorker(root);
      else spawnImprovementWorker({ root, cliPath: fileURLToPath(import.meta.url), env: io.env });
    };
    const judgeFor = () =>
      createPluginJudge({
        jev: dependencies.jev,
        model: model ?? DEFAULT_MODEL,
        sharedBudget,
        redaction: dependencies.redaction,
        classifyError: dependencies.classifyError,
        signal,
        ...(concurrency === undefined ? {} : { concurrency }),
      });

    if (workerMode || promotion !== null) {
      const registry = createDefaultRegistry();
      loadedPlugins = (await registerRepositoryPlugins(registry, { root, signal, warn: warnPlugin })).loaded;
      if (promotion !== null) {
        const promoted = await promoteCandidate(root, promotion, registry.ids());
        const summary = {
          schema: "stanley.promotion/v1",
          candidate: promotion,
          workflow: promoted.pluginId,
          path: promoted.destination,
        };
        io.stdout.write(
          v.json
            ? `${JSON.stringify(summary, null, 2)}\n`
            : `stanley: activated candidate ${promotion} as workflow ${promoted.pluginId} at ${promoted.destination}; review and commit it like any repository script\n`,
        );
        return EXIT.ok;
      }
      if (!agent) {
        io.stderr.write(`stanley: improvement worker not started: agent ${availability.reason}\n`);
        return EXIT.usage;
      }
      const workerScope =
        enumValue(v.scope as string | undefined, "scope", ["worktree", "staged", "branch"] as const) ??
        "worktree";
      const currentDiff = (
        await dependencies.source.collectDiff({
          scope: workerScope,
          ...(typeof v.base === "string" ? { base: v.base } : {}),
        })
      ).text.trim()
        ? "present"
        : "absent";
      const summary = await runImprovementWorker({
        root,
        agent,
        reservedIds: registry.ids(),
        signal,
        routeCheck: async (candidate, candidateRequest) => {
          try {
            const decision = await routeIntent(
              {
                request: candidateRequest,
                diff: currentDiff,
                input: "none",
                capabilities: {
                  ...capabilitiesFor(registry, "none", currentDiff, new Set()),
                  [candidate.id]: true,
                },
                options: [],
                candidates: [...registry.candidates(), candidate],
              },
              dependencies,
              model ?? DEFAULT_MODEL,
              undefined,
              signal,
            );
            return decision.outcome === candidate.id;
          } catch (error) {
            if (error instanceof RoutingError) return null;
            throw error;
          }
        },
      });
      const report = { schema: "stanley.improvement-worker/v1", ...summary };
      io.stdout.write(
        v.json
          ? `${JSON.stringify(report, null, 2)}\n`
          : summary.ran
            ? `stanley: improvement worker processed ${summary.processed.length} job(s)${summary.processed.map((job) => `\n  ${job.id}: ${job.status}`).join("")}\n`
            : "stanley: improvement worker already running for this repository\n",
      );
      return EXIT.ok;
    }

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
    const registry = createDefaultRegistry();
    const loaded = await registerRepositoryPlugins(registry, {
      root,
      signal,
      warn: warnPlugin,
    });
    loadedPlugins = loaded.loaded;
    const topInput = pluginInput(supplied?.text ?? null);
    const validatedCandidates = (await listCandidates(root)).filter((c) => c.status === "validated");
    if (validatedCandidates.length > 0) {
      io.stderr.write(
        `stanley: ${validatedCandidates.length} validated improvement candidate(s) await review under ${CANDIDATE_DIRECTORY}/ (activate with --promote-candidate <id>)\n`,
      );
    }
    if (agent && (await pendingImprovements(root)).length > 0 && !(await workerRunning(root))) startWorker();
    const decide = async (
      childRequest: string,
      childInput: PluginValue | undefined,
      excluded: ReadonlySet<string>,
      usedOptions: string[] = [],
    ): Promise<{ selected: string | null; reason: RouteReason }> => {
      const childText = pluginInputText(childInput);
      const childShape = classifyInput(childText, dependencies);
      const currentDiffSource = await dependencies.source.collectDiff(selection);
      const currentDiff = currentDiffSource.text.trim() ? "present" : "absent";
      const candidates = registry.candidates().filter((candidate) => !excluded.has(candidate.id));
      if (candidates.length === 0) return { selected: null, reason: "no_candidates" };
      try {
        const decision = await routeIntent(
          {
            request: childRequest,
            diff: currentDiff,
            input: childShape,
            capabilities: capabilitiesFor(registry, childShape, currentDiff, excluded),
            options: usedOptions,
            candidates,
          },
          dependencies,
          model ?? DEFAULT_MODEL,
          sharedBudget,
          signal,
        );
        if (decision.outcome === "cannot_tell") return { selected: null, reason: decision.reason };
        const routed = registry.get(decision.outcome);
        if (unsupportedAction(childRequest) && routed?.kind !== "plugin") {
          return { selected: null, reason: "action_guard" };
        }
        return { selected: decision.outcome, reason: "selected" };
      } catch (error) {
        if (error instanceof RoutingError) {
          signal.throwIfAborted();
          return { selected: null, reason: "routing_error" };
        }
        throw error;
      }
    };
    const route = async (
      childRequest: string,
      childInput: PluginValue | undefined,
      excluded: ReadonlySet<string>,
    ): Promise<string | null> => (await decide(childRequest, childInput, excluded)).selected;
    const action = unsupportedAction(request);
    const topDecision: { selected: string | null; reason: RouteReason } =
      action && loadedPlugins.length === 0
        ? { selected: null, reason: "skipped" }
        : await decide(
            request,
            topInput,
            new Set(),
            WORKFLOW_OPTIONS.filter((name) => v[name] !== undefined),
          );
    selected = topDecision.selected;
    const selectedWorkflow = selected ? registry.get(selected) : undefined;
    const delegate = async (): Promise<PromptResult> => {
      const inputText = pluginInputText(topInput);
      // The plugin directory is the trust boundary: a task agent may edit the repository, but nothing it
      // writes there is activated. Added files are quarantined; other changes are reported for review.
      const pluginsBefore = await pluginDirectoryFingerprint(root);
      const result = await agent!.run(
        { kind: "delegate", instructions: delegationInstructions(request, inputText), cwd: root },
        { signal, timeoutMs: agentTimeoutMs },
      );
      signal.throwIfAborted();
      const caveats: string[] = [];
      const changes = pluginDirectoryChanges(pluginsBefore, await pluginDirectoryFingerprint(root));
      if (changes.added.length > 0) {
        const quarantine = await quarantinePluginFiles(root, changes.added);
        caveats.push(
          `the agent added ${changes.added.length} file(s) under ${PLUGIN_DIRECTORY}/; they were moved to ${quarantine}/ and are not active (${changes.added.join(", ")})`,
        );
      }
      if (changes.modified.length > 0 || changes.removed.length > 0) {
        caveats.push(
          `the agent changed trusted plugin files that were not restored; review them with git before the next run (modified: ${changes.modified.join(", ") || "none"}; removed: ${changes.removed.join(", ") || "none"})`,
        );
      }
      for (const caveat of caveats) io.stderr.write(`stanley: warning: ${safeMessage(caveat)}\n`);
      const job = createImprovementJob(
        dependencies.redaction.text(request).text,
        classifyInput(inputText, dependencies),
      );
      const queued = await enqueueImprovement(root, job);
      if (queued === "queued") startWorker();
      else if (queued === "already_queued" && !(await workerRunning(root))) startWorker();
      const note: Record<typeof queued, string> = {
        queued: `queued improvement job ${job.id} under ${IMPROVEMENT_DIRECTORY}/`,
        already_queued: `improvement job ${job.id} is already queued`,
        already_attempted: `an improvement for this request was already attempted (${CANDIDATE_DIRECTORY}/${job.id})`,
        queue_full: "the improvement queue is full; no job was queued",
      };
      io.stderr.write(`stanley: delegated to the coding agent; ${note[queued]}\n`);
      return delegationResult(result, dependencies.redaction, caveats);
    };
    const fallback = async (
      fallbackRequest: string,
      fallbackInput: PluginValue | undefined,
      reason: FallbackReason,
    ): Promise<PromptResult> => {
      signal.throwIfAborted();
      const requestedAction = unsupportedAction(fallbackRequest);
      if (requestedAction === "code_change" && !sharedBudget.exhausted) {
        const packet = await WORKFLOWS.find.run(
          {
            task: `Identify repository code relevant to planning this requested change: ${fallbackRequest}`,
            includeExcerpts: true,
            mode: "code_change_fallback",
          },
          options,
        );
        const analysis = packetPromptResult(packet, WORKFLOWS.find.render(packet));
        return {
          status: "unsupported",
          output: {
            text: `${CODE_CHANGE_FALLBACK_NOTICE}\n\n${
              typeof analysis.output === "object" &&
              analysis.output !== null &&
              !Array.isArray(analysis.output) &&
              typeof analysis.output.text === "string"
                ? analysis.output.text
                : ""
            }`.trimEnd(),
            data: { reason, requested: requestedAction, analysis: analysis.output },
          },
        };
      }
      const detail = {
        reason,
        ...(requestedAction ? { requested: requestedAction } : {}),
        ...(fallbackInput === undefined ? {} : { inputProvided: true }),
      };
      if (sharedBudget.exhausted) {
        return {
          status: "budget_exhausted",
          output: {
            text: `The request could not be routed because the shared ${sharedBudget.exhausted} budget was exhausted.`,
            data: detail,
          },
        };
      }
      if (requestedAction === "external_action") {
        return unsupportedPromptResult(
          "No installed plugin can perform this action. Built-in workflows are read-only and cannot run commands, commit, push, deploy, reply, or resolve.",
          detail,
        );
      }
      const messages: Record<Exclude<FallbackReason, "unroutable">, string> = {
        unavailable: "The selected capability is not currently available.",
        cycle: "The request was stopped because it would re-enter an active workflow.",
        depth: "The request was stopped at the nested prompt depth limit.",
        calls: "The request was stopped at the child prompt call limit.",
      };
      if (reason !== "unroutable") return unsupportedPromptResult(messages[reason], detail);
      const fallbackDiffSource = await dependencies.source.collectDiff(selection);
      const fallbackDiff = fallbackDiffSource.text.trim() ? "present" : "absent";
      const fallbackShape = classifyInput(pluginInputText(fallbackInput), dependencies);
      return unsupportedPromptResult(
        `No installed workflow can confidently handle the complete request. ${clarification(
          fallbackDiff,
          fallbackShape,
        )}`,
        detail,
      );
    };
    if (!selectedWorkflow || (action && selectedWorkflow.kind !== "plugin")) {
      // Delegate only what is confidently unsupported: an action no plugin claims, or a request the router
      // explicitly placed outside every workflow. Uncertain or capability-gated requests ask for clarification.
      const unsupported = action !== null || topDecision.reason === "cannot_tell";
      if (agent && unsupported && !sharedBudget.exhausted) {
        return writePromptResult(await delegate(), Boolean(v.json), io);
      }
      return writePromptResult(await fallback(request, topInput, "unroutable"), Boolean(v.json), io);
    }
    const selectedId = selected!;
    validateOptions(selectedId, v);
    if (
      supplied &&
      selectedWorkflow.kind !== "plugin" &&
      selectedId !== "triage_failures" &&
      selectedId !== "triage_comments"
    ) {
      throw new UsageError(`supplied input is not used when the request routes to ${selectedId}`);
    }

    const runTopLevelBuiltin = async (builtinId: string): Promise<PromptResult> => {
      if (!(builtinId in WORKFLOWS)) {
        throw new RoutingError(`no built-in dispatch for workflow: ${builtinId}`);
      }
      const builtinName = builtinId as WorkflowName;
      let packet: Packet<unknown>;
      switch (builtinName) {
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
        case "review":
        case "test_gaps":
        case "summarize":
        case "security_review":
        case "performance_review":
        case "compatibility_review": {
          const maxHunks = integer(v["max-hunks"] as string | undefined, "max-hunks", 1, 2000);
          const task = await readTask(false);
          const workflow = WORKFLOWS[builtinName] as unknown as WorkflowDefinition<
            {
              request: string;
              task?: string;
              scope: "worktree" | "staged" | "branch";
              base?: string;
              maxHunks?: number;
            },
            unknown
          >;
          packet = await workflow.run(
            {
              request,
              ...(task ? { task } : {}),
              ...selection,
              ...(maxHunks ? { maxHunks } : {}),
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
              mode: "find",
            },
            options,
          );
          break;
        }
        default:
          throw new RoutingError(`no built-in dispatch for workflow: ${builtinName}`);
      }

      const definition = WORKFLOWS[builtinName] as unknown as WorkflowDefinition<unknown, unknown>;
      return packetPromptResult(packet, definition.render(packet));
    };
    const runtime = new PluginPromptRuntime({
      root,
      registry,
      signal,
      route,
      runBuiltin: async (workflow, childRequest, childInput, depth) =>
        depth === 0
          ? runTopLevelBuiltin(workflow.id)
          : runNestedBuiltin(workflow, childRequest, childInput, selection, options, fallback),
      fallback,
      judge: judgeFor,
    });
    return writePromptResult(await runtime.run(selectedId, request, topInput), Boolean(v.json), io);
  } catch (error) {
    const usage =
      error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
    const input =
      error instanceof MissingCredentialError ||
      error instanceof InputError ||
      error instanceof GitError ||
      error instanceof PromotionError;
    const code = usage ? EXIT.usage : input ? EXIT.input : EXIT.internal;
    const kind = usage ? "usage" : input ? "input" : "internal";
    const message = safeMessage(error);
    if (wantsJson) {
      io.stdout.write(
        `${JSON.stringify(
          {
            schema: "stanley.error/v1",
            error: { kind, message },
          },
          null,
          2,
        )}\n`,
      );
    }
    io.stderr.write(`stanley${selected ? ` ${selected}` : ""}: ${kind} error: ${message}\n`);
    if (usage) io.stderr.write(`usage: ${USAGE}\n`);
    return code;
  } finally {
    await cleanupPlugins(loadedPlugins, warnPlugin);
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
