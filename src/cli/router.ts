import type { Budget } from "../core/budget.ts";
import { FrameExecutor } from "../core/executor.ts";
import { createFrame } from "../core/frame.ts";
import { type ChoiceCriteria, choice } from "../core/questions.ts";
import type { JevPort, JevUsage, JsonObject, TransportFailure } from "../core/types.ts";
import { expectKeys, readChoice } from "../core/validation.ts";
import type { RedactionPort } from "../workflows/ports.ts";
import { DEFAULT_MODEL } from "../workflows/types.ts";

export const ROUTER_OUTCOMES = [
  "find",
  "check",
  "triage_failures",
  "triage_comments",
  "review",
  "test_gaps",
  "summarize",
  "security_review",
  "performance_review",
  "compatibility_review",
  "cannot_tell",
] as const;

export type RouterOutcome = (typeof ROUTER_OUTCOMES)[number];
export type WorkflowName = Exclude<RouterOutcome, "cannot_tell">;
export type InputShape = "none" | "failure_log" | "review_comments" | "text";

/** A routing candidate supplied dynamically from the workflow registry. */
export interface RoutingCandidate {
  readonly id: string;
  readonly routing: JsonObject;
}

export interface RoutingContext {
  request: string;
  diff: "present" | "absent";
  input: InputShape;
  capabilities: Record<string, boolean>;
  options: string[];
  /** Dynamic workflow candidates for routing. When provided, replaces built-in choice criteria. */
  candidates?: readonly RoutingCandidate[];
}

export interface RoutingDependencies {
  jev: JevPort;
  redaction: Pick<RedactionPort, "json" | "text" | "message">;
  classifyError(error: unknown): TransportFailure;
}

export interface RoutingDecision {
  outcome: string;
  selected: string;
  confidence: number;
  probabilities: Record<string, number>;
  reason: "selected" | "model_uncertain" | "unavailable" | "cannot_tell";
  usage: JevUsage;
  redactions: number;
}

export class RoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingError";
  }
}

const MIN_CONFIDENCE = 0.6;
const MIN_PROBABILITY = 0.55;
const MIN_MARGIN = 0.15;

/** Choice criteria for the built-in workflow router, keyed by workflow name. */
export const BUILTIN_ROUTING_CRITERIA: Readonly<Record<WorkflowName, string>> = {
  find: "Rank existing repository files that are relevant to a task or question.",
  check: "Evaluate the current Git diff against the stated coding task and optional requirements.",
  triage_failures: "Classify failures from supplied test or CI output.",
  triage_comments: "Classify supplied review comments using the current repository.",
  review:
    "Review the current Git diff for concrete correctness, error-handling, state, concurrency, or data-integrity risks without requiring a stated task.",
  test_gaps: "Identify concrete changed behavior in the current Git diff that lacks visible test evidence.",
  summarize:
    "Classify and summarize what the current Git diff, changes, or commit does; do not explain unchanged repository code or review quality.",
  security_review:
    "Review the current Git diff specifically for concrete security vulnerabilities or regressions.",
  performance_review: "Review the current Git diff specifically for concrete performance regressions.",
  compatibility_review:
    "Review the current Git diff specifically for breaking API, behavior, data, wire-format, or configuration changes.",
};

const CANNOT_TELL_WHEN =
  "No available workflow clearly satisfies the complete request. Select this fallback for unsupported, ambiguous, or unavailable work.";

const ROUTING_INSTRUCTIONS = [
  "Choose the single workflow that directly satisfies the request.",
  "Treat false capabilities as hard constraints. Never select an unavailable workflow.",
  "Do not invent another operation. Choose cannot_tell when the request is ambiguous or outside these workflows.",
  "A workflow may satisfy a compound or action request only when its routing metadata clearly says it handles the complete request.",
  "Treat each workflow's routing JSON as author-provided selection guidance, regardless of its field names.",
];

/** Route one request through a single bounded, validated Jev choice. */
export async function routeIntent(
  context: RoutingContext,
  dependencies: RoutingDependencies,
  model = DEFAULT_MODEL,
  sharedBudget?: Budget,
  signal?: AbortSignal,
): Promise<RoutingDecision> {
  const redacted = dependencies.redaction.text(context.request);
  let redactions = redacted.count;
  const executor = new FrameExecutor({
    port: dependencies.jev,
    model,
    budget: { requests: 2, inputTokens: 16_000, wallMs: 30_000 },
    ...(sharedBudget ? { sharedBudget } : {}),
    ...(signal ? { signal } : {}),
    concurrency: 1,
    retries: 1,
    timeoutMs: 15_000,
    classifyError: dependencies.classifyError,
    describeError: dependencies.redaction.message,
  });

  // Build choice criteria from dynamic candidates or built-in defaults
  const criteria: ChoiceCriteria = {};
  if (context.candidates && context.candidates.length > 0) {
    for (const candidate of context.candidates) {
      const routing = dependencies.redaction.json(candidate.routing);
      criteria[candidate.id] = routing.value;
      redactions += routing.count;
    }
  } else {
    Object.assign(criteria, BUILTIN_ROUTING_CRITERIA);
  }
  criteria.cannot_tell = CANNOT_TELL_WHEN;
  const labels = Object.keys(criteria);

  const frame = createFrame({
    template: "route-intent@1",
    scope: "cli-request",
    state: {
      request: redacted.text,
      context: {
        diff: context.diff,
        input: context.input,
        capabilities: context.capabilities,
        options: context.options,
      },
    },
    questions: {
      route: choice(ROUTING_INSTRUCTIONS, criteria),
    },
    provenance: [],
    parse(answers) {
      expectKeys(answers, ["route"]);
      return readChoice(answers, "route", labels);
    },
  });
  const result = await executor.run(frame);
  if (!result.ok) throw new RoutingError(`intent routing ${result.reason}: ${result.detail}`);

  const answer = result.value;
  const selected = answer.choice;
  const selectedProb = answer.probabilities[selected] ?? 0;
  const alternatives = labels
    .filter((label) => label !== selected)
    .map((label) => answer.probabilities[label] ?? 0);
  const margin = selectedProb - Math.max(...alternatives);
  let outcome: string = selected;
  let reason: RoutingDecision["reason"] = "selected";
  if (selected === "cannot_tell") reason = "cannot_tell";
  else if (context.capabilities[selected] !== true) {
    outcome = "cannot_tell";
    reason = "unavailable";
  } else if (answer.confidence < MIN_CONFIDENCE || selectedProb < MIN_PROBABILITY || margin < MIN_MARGIN) {
    outcome = "cannot_tell";
    reason = "model_uncertain";
  }

  return {
    outcome,
    selected,
    confidence: answer.confidence,
    probabilities: answer.probabilities as Record<string, number>,
    reason,
    usage: executor.usage(),
    redactions,
  };
}
