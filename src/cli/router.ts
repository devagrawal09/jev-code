import { FrameExecutor } from "../core/executor.ts";
import { createFrame } from "../core/frame.ts";
import { choice } from "../core/questions.ts";
import type { JevPort, JevUsage, TransportFailure } from "../core/types.ts";
import { expectKeys, readChoice } from "../core/validation.ts";
import type { RedactionPort } from "../workflows/ports.ts";
import { DEFAULT_MODEL } from "../workflows/types.ts";

export const ROUTER_OUTCOMES = [
  "find",
  "check",
  "triage_failures",
  "triage_comments",
  "cannot_tell",
] as const;

export type RouterOutcome = (typeof ROUTER_OUTCOMES)[number];
export type WorkflowName = Exclude<RouterOutcome, "cannot_tell">;
export type InputShape = "none" | "failure_log" | "review_comments" | "text";

export interface RoutingContext {
  request: string;
  diff: "present" | "absent";
  input: InputShape;
  capabilities: Record<WorkflowName, boolean>;
  options: string[];
}

export interface RoutingDependencies {
  jev: JevPort;
  redaction: Pick<RedactionPort, "text" | "message">;
  classifyError(error: unknown): TransportFailure;
}

export interface RoutingDecision {
  outcome: RouterOutcome;
  selected: RouterOutcome;
  confidence: number;
  probabilities: Record<RouterOutcome, number>;
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

/** Route one request through a single bounded, validated Jev choice. */
export async function routeIntent(
  context: RoutingContext,
  dependencies: RoutingDependencies,
  model = DEFAULT_MODEL,
): Promise<RoutingDecision> {
  const redacted = dependencies.redaction.text(context.request);
  const executor = new FrameExecutor({
    port: dependencies.jev,
    model,
    budget: { requests: 1, inputTokens: 8_000, wallMs: 15_000 },
    concurrency: 1,
    retries: 0,
    timeoutMs: 15_000,
    classifyError: dependencies.classifyError,
    describeError: dependencies.redaction.message,
  });
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
      route: choice(
        [
          "Choose the single workflow that directly satisfies the request.",
          "Treat false capabilities as hard constraints. Never select an unavailable workflow.",
          "Do not invent another operation. Choose cannot_tell when the request is ambiguous or outside these workflows.",
        ],
        {
          find: "Rank existing repository files that are relevant to a task or question.",
          check: "Evaluate the current Git diff against the stated coding task and optional requirements.",
          triage_failures: "Classify failures from supplied test or CI output.",
          triage_comments: "Classify supplied review comments using the current repository.",
          cannot_tell: "The intended workflow is unclear, unsupported, or lacks required evidence.",
        },
      ),
    },
    provenance: [],
    parse(answers) {
      expectKeys(answers, ["route"]);
      return readChoice(answers, "route", ROUTER_OUTCOMES);
    },
  });
  const result = await executor.run(frame);
  if (!result.ok) throw new RoutingError(`intent routing ${result.reason}: ${result.detail}`);

  const answer = result.value;
  const selected = answer.choice;
  const alternatives = ROUTER_OUTCOMES.filter((outcome) => outcome !== selected).map(
    (outcome) => answer.probabilities[outcome],
  );
  const margin = answer.probabilities[selected] - Math.max(...alternatives);
  let outcome: RouterOutcome = selected;
  let reason: RoutingDecision["reason"] = "selected";
  if (selected === "cannot_tell") reason = "cannot_tell";
  else if (!context.capabilities[selected]) {
    outcome = "cannot_tell";
    reason = "unavailable";
  } else if (
    answer.confidence < MIN_CONFIDENCE ||
    answer.probabilities[selected] < MIN_PROBABILITY ||
    margin < MIN_MARGIN
  ) {
    outcome = "cannot_tell";
    reason = "model_uncertain";
  }

  return {
    outcome,
    selected,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
    reason,
    usage: executor.usage(),
    redactions: redacted.count,
  };
}
