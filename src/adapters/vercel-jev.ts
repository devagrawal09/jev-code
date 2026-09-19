import type { Experimental_EvaluationModel } from "ai";
import { experimental_evaluate as aiEvaluate, createGateway } from "ai";
import { estimateTokens } from "../core/budget.ts";
import type { Entry, Question, Questions } from "../core/questions.ts";
import type { JevCallOptions, JevPort, JevRequest, TransportFailure } from "../core/types.ts";
import { MissingCredentialError } from "./jev.ts";

export { MissingCredentialError };

/** Canonical Jev model id on the Vercel AI Gateway, verified against ai@7.0.107. */
export const GATEWAY_MODEL = "typesafe-ai/jev";

/** Environment override for the gateway model id used by the Vercel provider. */
export const GATEWAY_MODEL_ENV = "JEV_GATEWAY_MODEL";

/** Environment override for zero data retention; defaults to enabled. */
export const ZERO_DATA_RETENTION_ENV = "JEV_GATEWAY_ZERO_DATA_RETENTION";

/** Gateway evaluation questions: choice, score, and boolean (their name for noul). */
export type GatewayQuestion =
  | { type: "choice"; instructions: Entry; criteria: Record<string, Entry | null> }
  | { type: "score"; instructions: Entry; criteria: readonly (Entry | null)[] }
  | { type: "boolean"; instructions: Entry; criteria?: { true?: Entry | null; false?: Entry | null } };

export type GatewayAnswer =
  | { type: "choice"; choice: string; probabilities?: Record<string, number> }
  | { type: "score"; score: number; probabilities?: Record<string, number> }
  | { type: "boolean"; probability: number };

/**
 * The slice of `experimental_evaluate()` from the `ai` package that the provider
 * needs. `model` is a gateway evaluation model instance (or a gateway model id
 * string resolved through the default provider). `providerMetadata` carries
 * provider-specific statistics such as TypeSafe's per-question confidence.
 */
export type EvaluateFn = (options: {
  model: string | Experimental_EvaluationModel;
  state: Entry;
  questions: Record<string, GatewayQuestion>;
  maxRetries: number;
  abortSignal?: AbortSignal;
  providerOptions?: Record<string, unknown>;
}) => Promise<{
  answers: Record<string, GatewayAnswer>;
  usage?: { inputTokens?: number; outputTokens?: number };
  providerMetadata?: Record<string, unknown>;
  response?: { modelId?: string };
}>;

/** Builds the evaluation model for a gateway model id. */
export type ModelFactory = (id: string) => string | Experimental_EvaluationModel;

export interface VercelJevProviderOptions {
  /** Performs one evaluation; defaults to `experimental_evaluate` from the `ai` package. */
  evaluate?: EvaluateFn;
  /** Builds the model for a gateway id; defaults to a plain pass-through. */
  modelFactory?: ModelFactory;
  /** Default gateway model id; per-request slash-qualified ids override it. */
  model?: string;
  /** Routes only to providers with zero data retention agreements. Default: true. */
  zeroDataRetention?: boolean;
  /** Credential values used by this port; consumed by dependency redaction. */
  credentialSecrets?: string[];
}

/**
 * Vercel AI Gateway Jev provider: one Jev port backed by the gateway evaluation
 * API instead of the TypeSafe API. Authentication is bound by the model factory
 * (createGateway({ apiKey }).evaluationModel(id)); nothing here reads the
 * process environment.
 */
export class VercelJevProvider implements JevPort {
  /** This port's error classifier, so callers can pair port and classifier. */
  readonly classifyError: (error: unknown) => TransportFailure = classifyVercelError;

  /** Credential values used by this port; consumed by dependency redaction. */
  readonly credentialSecrets: string[];

  private readonly evaluate: EvaluateFn;
  private readonly modelFactory: ModelFactory;
  private readonly model: string;
  private readonly zeroDataRetention: boolean;

  constructor(options: VercelJevProviderOptions = {}) {
    this.evaluate = options.evaluate ?? (aiEvaluate as unknown as EvaluateFn);
    this.modelFactory = options.modelFactory ?? ((id) => id);
    this.model = options.model ?? GATEWAY_MODEL;
    this.zeroDataRetention = options.zeroDataRetention ?? true;
    this.credentialSecrets = options.credentialSecrets ?? [];
  }

  async ask(request: JevRequest, options: JevCallOptions): Promise<unknown> {
    if (options.signal?.aborted) throw aborted(options.signal.reason);
    // The gateway evaluate API has no timeout parameter; enforce the executor's
    // timeout by aborting the shared signal, which surfaces as a TimeoutError.
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new DOMException(`gateway evaluation timed out after ${options.timeoutMs}ms`, "TimeoutError"),
        ),
      options.timeoutMs,
    );
    const external = options.signal;
    const forward = () => controller.abort(aborted(external?.reason));
    external?.addEventListener("abort", forward, { once: true });
    const gatewayModel = gatewayModelFor(request.model, this.model);
    let result: Awaited<ReturnType<EvaluateFn>>;
    try {
      result = await this.evaluate({
        model: this.modelFactory(gatewayModel),
        state: request.state as Entry,
        questions: translateQuestions(request.questions),
        maxRetries: 0,
        abortSignal: controller.signal,
        ...(this.zeroDataRetention ? { providerOptions: { gateway: { zeroDataRetention: true } } } : {}),
      });
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", forward);
    }
    // Malformed gateway answers (missing or wrong-typed) become an empty
    // answer map: readEnvelope accepts the envelope and the frame parser then
    // rejects it as a ValidationError, which is the executor's invalid-response
    // path — the one that retries. Throwing here would instead take the
    // transport-error path, which classifies as unknown and never retries.
    let answers: Record<string, unknown> = {};
    try {
      answers = translateAnswers(
        request.questions,
        result.answers,
        typesafeConfidence(result.providerMetadata),
      );
    } catch {
      // Deliberately answered by the empty map above.
    }
    return {
      model: result.response?.modelId ?? gatewayModel,
      answers,
      usage: {
        // A missing usage report must not zero out the budgeted input estimate
        // (Budget.settle would subtract it), or --max-input-tokens stops
        // guarding anything. Report the same deterministic estimate the
        // executor reserved so the counter keeps advancing conservatively.
        input_tokens: result.usage?.inputTokens ?? estimateTokens(request),
        output_tokens: result.usage?.outputTokens ?? 0,
      },
    };
  }
}

/** Options for test injection; production code uses the defaults. */
export interface VercelAdapterOptions {
  /** Gateway base URL override, forwarded to createGateway. */
  baseURL?: string;
  /** Evaluation function override. */
  evaluate?: EvaluateFn;
}

/** Build the gateway-backed Jev port. The API key is read only from the given environment. */
export function createVercelAdapter(
  env: NodeJS.ProcessEnv = process.env,
  options: VercelAdapterOptions = {},
): JevPort {
  const apiKey = env.AI_GATEWAY_API_KEY?.trim();
  if (!apiKey)
    throw new MissingCredentialError(
      "AI_GATEWAY_API_KEY is required; set it in the process environment before running jev-code with JEV_PROVIDER=vercel",
    );
  // Bind the key to an explicit gateway instance instead of relying on the
  // process-global default provider; process.env is never mutated.
  const gateway = createGateway({ apiKey, ...(options.baseURL ? { baseURL: options.baseURL } : {}) });
  const model = env[GATEWAY_MODEL_ENV]?.trim() || GATEWAY_MODEL;
  const zeroDataRetention = !/^(?:0|false|no|off)$/i.test(env[ZERO_DATA_RETENTION_ENV]?.trim() ?? "");
  return new VercelJevProvider({
    model,
    zeroDataRetention,
    credentialSecrets: apiKey.trim().length >= 8 ? [apiKey.trim()] : [],
    ...(options.evaluate ? { evaluate: options.evaluate } : {}),
    modelFactory: (id) => gateway.evaluationModel(id),
  });
}

/**
 * The model for one request. Gateway ids are provider-qualified (contain a "/"),
 * TypeSafe-direct ids (jev-1.13.0) are a different namespace and are never
 * forwarded: an unqualified request model selects the configured gateway model.
 */
function gatewayModelFor(requested: string, configured: string): string {
  return requested.includes("/") ? requested : configured;
}

/** Extract TypeSafe's per-question confidence map from gateway provider metadata. */
function typesafeConfidence(
  providerMetadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const typesafe = providerMetadata?.typesafe;
  if (typeof typesafe !== "object" || typesafe === null) return undefined;
  const confidence = (typesafe as Record<string, unknown>).confidence;
  if (typeof confidence !== "object" || confidence === null) return undefined;
  return confidence as Record<string, unknown>;
}

/** Translate jev questions to gateway evaluation questions. */
export function translateQuestions(questions: Questions): Record<string, GatewayQuestion> {
  const out: Record<string, GatewayQuestion> = {};
  for (const [name, question] of Object.entries(questions)) out[name] = translateQuestion(question);
  return out;
}

function translateQuestion(question: Question): GatewayQuestion {
  if (question.type === "noul") {
    if (question.instructions === undefined) {
      throw new Error("the Vercel provider requires instructions on every noul question");
    }
    const criteria =
      question.criteria === undefined || question.criteria === null ? undefined : { ...question.criteria };
    return {
      type: "boolean",
      instructions: question.instructions,
      ...(criteria ? { criteria } : {}),
    };
  }
  if (question.type === "choice") {
    if (question.instructions === undefined) {
      throw new Error("the Vercel provider requires instructions on every choice question");
    }
    return { type: "choice", instructions: question.instructions, criteria: question.criteria };
  }
  if (question.instructions === undefined) {
    throw new Error("the Vercel provider requires instructions on every score question");
  }
  return { type: "score", instructions: question.instructions, criteria: question.criteria };
}

/**
 * Translate gateway answers into the answer shape the review engine validates.
 *
 * Confidence: TypeSafe's separate confidence statistic is read from
 * `providerMetadata.typesafe.confidence[questionId]` when the gateway supplies
 * it. Only when that metadata is genuinely unavailable does the provider fall
 * back to a value derived from the distribution (the mass of the selected
 * choice, or the maximum level mass for score) — an approximation, not the
 * model's own confidence. Noul/boolean answers carry probability only; TypeSafe
 * reports no confidence for them either.
 */
export function translateAnswers(
  questions: Questions,
  answers: Record<string, GatewayAnswer>,
  confidence?: Record<string, unknown>,
): Record<string, unknown> {
  const reported = (name: string): number | undefined => {
    const value = confidence?.[name];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  // Own-property check: prototype names like "constructor" must count as
  // unexpected answers, not as questions inherited through Object.prototype.
  const unexpected = Object.keys(answers).filter((name) => !Object.hasOwn(questions, name));
  if (unexpected.length > 0) {
    throw new Error(`the gateway returned unexpected answers: ${unexpected.join(", ")}`);
  }
  const out: Record<string, unknown> = {};
  for (const [name, question] of Object.entries(questions)) {
    const answer = answers[name];
    if (!answer) throw new Error(`the gateway returned no answer for question "${name}"`);
    if (question.type === "noul") {
      if (answer.type !== "boolean") throw new Error(`answer "${name}" is not a boolean answer`);
      out[name] = { type: "noul", noul: answer.probability };
    } else if (question.type === "choice") {
      if (answer.type !== "choice") throw new Error(`answer "${name}" is not a choice answer`);
      const labels = Object.keys(question.criteria);
      // The gateway shape permits omitting probabilities entirely. An all-zero
      // distribution would be rejected by readChoice (sum 0) and burn every
      // retry; synthesize a point mass on the selected choice instead.
      const probabilities =
        answer.probabilities ?? Object.fromEntries(labels.map((l) => [l, l === answer.choice ? 1 : 0]));
      const extraLabels = Object.keys(probabilities).filter(
        (label) => !labels.includes(label) && label !== answer.choice,
      );
      if (extraLabels.length > 0) {
        throw new Error(
          `answer "${name}" carries probabilities for unknown choices: ${extraLabels.join(", ")}`,
        );
      }
      out[name] = {
        type: "choice",
        choice: answer.choice,
        confidence: reported(name) ?? probabilities[answer.choice] ?? 0,
        probabilities: Object.fromEntries(labels.map((label) => [label, probabilities[label] ?? 0])),
      };
    } else {
      if (answer.type !== "score") throw new Error(`answer "${name}" is not a score answer`);
      const levelCount = question.criteria.length;
      // Probabilities may be omitted (an allowed gateway shape). Synthesize a
      // distribution consistent with the reported score: a point mass for
      // integral scores, linear interpolation between adjacent levels for
      // fractional ones (readScore accepts and expects those).
      const probabilities =
        answer.probabilities ??
        Object.fromEntries(
          Array.from({ length: levelCount }, (_, i) => {
            const lower = Math.floor(answer.score);
            const frac = answer.score - lower;
            if (i === lower) return [String(i), Number((1 - frac).toFixed(4))];
            if (i === lower + 1) return [String(i), Number(frac.toFixed(4))];
            return [String(i), 0];
          }),
        );
      // Exact canonical keys only: Number("1.5")/Number("01")/Number("1e0")
      // would coerce into range and get silently dropped otherwise.
      const canonicalLevels = Array.from({ length: levelCount }, (_, i) => String(i));
      const extraLevels = Object.keys(probabilities).filter((key) => !canonicalLevels.includes(key));
      if (extraLevels.length > 0) {
        throw new Error(
          `answer "${name}" carries probabilities for unknown score levels: ${extraLevels.join(", ")}`,
        );
      }
      if (answer.score < -1e-6 || answer.score > levelCount - 1 + 1e-6) {
        throw new Error(`answer "${name}" reports an out-of-range score: ${answer.score}`);
      }
      const values = Array.from({ length: levelCount }, (_, index) => probabilities[String(index)] ?? 0);
      out[name] = {
        type: "score",
        score: answer.score,
        confidence: reported(name) ?? Math.max(...values),
        legend: {},
        probabilities: Object.fromEntries(values.map((value, index) => [String(index), value])),
      };
    }
  }
  return out;
}

/**
 * An abort-typed error for any caller-supplied reason. Plain Error reasons
 * would surface as unknown transport failures instead of "aborted".
 */
function aborted(reason: unknown): unknown {
  if (reason instanceof Error && /abort/i.test(reason.name)) return reason;
  const detail =
    reason instanceof Error ? reason.message : reason === undefined ? "run aborted" : String(reason);
  return new DOMException(detail, "AbortError");
}

/** Map gateway and network errors onto transport failure classes. */
export function classifyVercelError(error: unknown): TransportFailure {
  const value = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  // RetryError carries every attempt; classify the last cause. The provider asks
  // for maxRetries 0, so this only fires when callers enable SDK retries.
  const attempts = value.errors;
  if (Array.isArray(attempts) && attempts.length > 0) {
    return classifyVercelError(attempts[attempts.length - 1]);
  }
  const status = typeof value.statusCode === "number" ? value.statusCode : null;
  const name = typeof value.name === "string" ? value.name : "";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (name === "AbortError" || name === "APIUserAbortError") return "aborted";
  if (
    status === 401 ||
    status === 403 ||
    /authentication|permissiondenied/i.test(name) ||
    /invalid api key|unauthenticated/i.test(message)
  ) {
    return "auth";
  }
  if (status === 413 || /max_tokens_exceeded|too large|payload|context length/.test(message))
    return "too_large";
  const cause = value.cause;
  const causeMessage =
    typeof cause === "object" && cause !== null && "message" in cause
      ? String((cause as { message: unknown }).message).toLowerCase()
      : "";
  // Plain connection failures (TypeError: fetch failed with ECONNREFUSED etc.
  // on `cause`, or AI SDK errors flagged retryable) must retry like other
  // transient transport problems.
  const connectionFailure =
    /fetch failed|network|connection/.test(name.toLowerCase()) ||
    /econnrefused|enotfound|eai_again|econnreset|epipe/.test(message) ||
    /econnrefused|enotfound|eai_again|econnreset|epipe/.test(causeMessage) ||
    value.isRetryable === true;
  if (
    status === 408 ||
    status === 429 ||
    (status !== null && status >= 500) ||
    /timeout|connection|ratelimit/i.test(name) ||
    /econnreset|etimedout|socket hang up|rate limit|fetch failed/.test(message) ||
    connectionFailure
  ) {
    return "transient";
  }
  if (status !== null && status >= 400) return "rejected";
  return "unknown";
}
