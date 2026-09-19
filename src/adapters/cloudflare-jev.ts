import { estimateTokens } from "../core/budget.ts";
import type { Questions } from "../core/questions.ts";
import type { JevCallOptions, JevPort, JevRequest, TransportFailure } from "../core/types.ts";
import { MissingCredentialError } from "./jev.ts";

export { MissingCredentialError };

/**
 * Canonical Jev model alias on Cloudflare Workers AI. Cloudflare runs its own
 * model namespace and currently exposes one always-current Jev alias instead
 * of TypeSafe's pinned versions, so TypeSafe-direct ids (`jev-1.13.0`,
 * `jev-latest`) are never forwarded.
 */
export const CLOUDFLARE_MODEL = "typesafe/jev";

/** Environment override for the Cloudflare Jev model alias. */
export const CLOUDFLARE_MODEL_ENV = "JEV_CLOUDFLARE_MODEL";

/** Default Cloudflare API base URL. */
export const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";

/** Cloudflare Jev answers use Jev's native contract (noul/choice/score). */
export type CloudflareAnswer =
  | { type: "noul"; noul: number }
  | {
      type: "choice";
      choice: string;
      confidence?: number;
      probabilities?: Record<string, number>;
    }
  | {
      type: "score";
      score: number;
      confidence?: number;
      legend?: Record<string, string>;
      probabilities?: Record<string, number>;
    };

/**
 * The slice of `fetch` the provider needs; injectable for tests and for
 * pointing the adapter at a local server.
 */
export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface CloudflareJevProviderOptions {
  accountId: string;
  apiToken: string;
  /** Cloudflare API base URL override (without the /accounts path). */
  baseURL?: string;
  /** Cloudflare Jev model alias; TypeSafe-direct request models never override it. */
  model?: string;
  /** fetch override for tests. */
  fetchFn?: FetchFn;
  /** Credential values used by this port; consumed by dependency redaction. */
  credentialSecrets?: string[];
}

/**
 * Cloudflare's v4 REST envelope error: HTTP status plus short safe Cloudflare
 * diagnostics. Classified by status; the message carries no credentials and
 * only bounded Cloudflare error text.
 */
export class CloudflareStatusError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CloudflareStatusError";
    this.status = status;
  }
}

/**
 * Cloudflare Workers AI Jev provider: one Jev port backed by the Cloudflare
 * REST run endpoint (`POST /accounts/{id}/ai/run`). Cloudflare speaks Jev's
 * native noul/choice/score contract, so questions pass through unchanged and
 * answers need only structural validation — no translation to gateway shapes.
 * Nothing here reads the process environment.
 */
export class CloudflareJevProvider implements JevPort {
  /** This port's error classifier, so callers can pair port and classifier. */
  readonly classifyError: (error: unknown) => TransportFailure = classifyCloudflareError;

  /** Credential values used by this port; consumed by dependency redaction. */
  readonly credentialSecrets: string[];

  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly baseURL: string;
  private readonly model: string;
  private readonly fetchFn: FetchFn;

  constructor(options: CloudflareJevProviderOptions) {
    this.accountId = options.accountId;
    this.apiToken = options.apiToken;
    this.baseURL = options.baseURL ?? CLOUDFLARE_API_BASE_URL;
    this.model = options.model ?? CLOUDFLARE_MODEL;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.credentialSecrets = options.credentialSecrets ?? [];
  }

  async ask(request: JevRequest, options: JevCallOptions): Promise<unknown> {
    if (options.signal?.aborted) throw aborted(options.signal.reason);
    // The REST run endpoint has no timeout parameter; enforce the executor's
    // timeout by aborting the shared signal, which surfaces as an AbortError
    // fetch rejection carrying the TimeoutError reason.
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new DOMException(`cloudflare run timed out after ${options.timeoutMs}ms`, "TimeoutError"),
        ),
      options.timeoutMs,
    );
    const external = options.signal;
    const forward = () => controller.abort(aborted(external?.reason));
    external?.addEventListener("abort", forward, { once: true });
    const cloudflareModel = cloudflareModelFor(request.model, this.model);
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseURL}/accounts/${encodeURIComponent(this.accountId)}/ai/run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: cloudflareModel,
          input: { state: request.state, questions: request.questions },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      external?.removeEventListener("abort", forward);
    }
    // Read and classify transport-level failures (HTTP errors, non-JSON body,
    // failed execution state). These throw so the executor classifies them.
    const payload = await readCloudflareResponse(response);
    // Malformed Jev payloads must NOT throw out of port.ask(): a rejection
    // lands in the executor's transport-error block (classified unknown, never
    // retried). An empty answer map lets readEnvelope accept the envelope and
    // the frame parser reject it as a ValidationError — the invalid-response
    // path, which retries.
    if (payload === null) return emptyEnvelope(cloudflareModel, request);
    let answers: Record<string, unknown> = {};
    try {
      answers = translateAnswers(request.questions, payload.answers);
    } catch {
      // Deliberately answered by the empty map above.
    }
    return {
      model: modelOf(payload, cloudflareModel),
      answers,
      usage: {
        // A missing usage report must not zero out the budgeted input estimate
        // (Budget.settle would subtract it), or --max-input-tokens stops
        // guarding anything. Report the same deterministic estimate the
        // executor reserved so the counter keeps advancing conservatively.
        input_tokens: payload.usage?.input_tokens ?? estimateTokens(request),
        output_tokens: payload.usage?.output_tokens ?? 0,
      },
    };
  }
}

/** The unwrapped Jev payload shape expected inside a Cloudflare result. */
interface JevPayload {
  model?: unknown;
  answers?: Record<string, unknown>;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

function emptyEnvelope(model: string, request: JevRequest): unknown {
  return {
    model,
    answers: {},
    usage: { input_tokens: estimateTokens(request), output_tokens: 0 },
  };
}

/**
 * Read and unwrap a Cloudflare REST response. The v4 envelope wraps results as
 * `{success, errors, messages, result}`; for Jev runs Cloudflare may also wrap
 * the model output in an execution-state envelope (`result.state` +
 * `result.result`). Returns the Jev payload object, or null when the result
 * does not look like a Jev response. HTTP errors, `success:false` envelopes,
 * and non-completed execution states throw CloudflareStatusError — a failed
 * execution must never masquerade as an empty answer set.
 */
async function readCloudflareResponse(response: Response): Promise<JevPayload | null> {
  const bodyText = await response.text();
  let body: unknown;
  try {
    body = bodyText.length > 0 ? JSON.parse(bodyText) : {};
  } catch {
    throw new CloudflareStatusError(
      response.status,
      `cloudflare returned a non-JSON body (HTTP ${response.status})`,
    );
  }
  if (!response.ok || (body as { success?: unknown }).success === false) {
    throw new CloudflareStatusError(
      response.status,
      `cloudflare run failed (HTTP ${response.status}): ${cloudflareDiagnostics(body)}`,
    );
  }
  const outer = (body as { result?: unknown }).result;
  // Execution-state envelope: {state, result}. Completed runs unwrap to the
  // inner result; any other state is a provider error.
  let candidate: unknown = outer;
  if (isExecutionState(outer)) {
    const state = outer.state;
    if (state !== "Completed" && state !== "Succeeded") {
      throw new CloudflareStatusError(
        response.status,
        `cloudflare run state is "${state}": ${cloudflareDiagnostics(body)}`,
      );
    }
    candidate = outer.result;
  }
  // Some responses carry the Jev payload directly as `result`; others only as
  // the whole body (no envelope fields). Accept both.
  const jev = jevPayloadOf(candidate) ?? jevPayloadOf(body);
  return jev;
}

/** Detect the Cloudflare execution-state envelope around a model result. */
function isExecutionState(value: unknown): value is { state: string; result: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { state?: unknown }).state === "string" &&
    "result" in value
  );
}

/** The Jev payload of an unwrapped result, or null when it is not one. */
function jevPayloadOf(value: unknown): JevPayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const answers = (value as { answers?: unknown }).answers;
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) return null;
  return value as JevPayload;
}

/**
 * The effective model for the normalized envelope: the Jev payload's own model
 * id when Cloudflare reports one (e.g. the pinned version behind the alias),
 * else the alias actually called.
 */
function modelOf(payload: JevPayload, called: string): string {
  const model = payload.model;
  return typeof model === "string" && model.length > 0 ? model : called;
}

/** Short, safe Cloudflare error diagnostics from a v4 envelope. */
function cloudflareDiagnostics(body: unknown): string {
  const errors = (body as { errors?: unknown })?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return "no diagnostics";
  return errors
    .slice(0, 3)
    .map((entry: unknown) => {
      if (typeof entry === "string") return entry.slice(0, 120);
      if (typeof entry === "object" && entry !== null) {
        const { code, message } = entry as { code?: unknown; message?: unknown };
        const codePart = typeof code === "number" ? ` ${code}` : "";
        const messagePart = typeof message === "string" ? `: ${message.slice(0, 160)}` : "";
        return `error${codePart}${messagePart}`;
      }
      return "error";
    })
    .join("; ")
    .slice(0, 300);
}

/**
 * The model for one request. Cloudflare's namespace is separate from TypeSafe
 * direct: unqualified ids (`jev-1.13.0`, `jev-latest`) are TypeSafe-direct ids
 * and are never forwarded — they select the configured Cloudflare alias. Only
 * `typesafe/`-qualified ids are Cloudflare catalog slugs and pass through.
 */
export function cloudflareModelFor(requested: string, configured: string): string {
  return requested.startsWith("typesafe/") ? requested : configured;
}

/**
 * Validate native Cloudflare Jev answers into the answer shape the review
 * engine validates. Cloudflare speaks Jev's native contract (unlike Vercel's
 * boolean translation), so this only enforces the structural rules the frame
 * validators rely on: own-property key checks, exact canonical score level
 * keys, valid probabilities, and distributions readChoice/readScore accept.
 * Optional fields (probabilities, confidence, legend) get conservative
 * fallbacks so a sparse-but-valid answer is not burned as invalid.
 */
export function translateAnswers(
  questions: Questions,
  answers: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
    throw new Error("cloudflare returned no answers object");
  }
  // Own-property check: prototype names like "constructor" must count as
  // unexpected answers, not as questions inherited through Object.prototype.
  const unexpected = Object.keys(answers).filter((name) => !Object.hasOwn(questions, name));
  if (unexpected.length > 0) {
    throw new Error(`cloudflare returned unexpected answers: ${unexpected.join(", ")}`);
  }
  const out: Record<string, unknown> = {};
  for (const [name, question] of Object.entries(questions)) {
    const answer = answers[name];
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
      throw new Error(`cloudflare returned no answer for question "${name}"`);
    }
    const record = answer as Record<string, unknown>;
    if (question.type === "noul") {
      if (record.type !== "noul") throw new Error(`answer "${name}" is not a noul answer`);
      out[name] = { type: "noul", noul: probabilityField(record.noul, `${name}.noul`) };
    } else if (question.type === "choice") {
      if (record.type !== "choice") throw new Error(`answer "${name}" is not a choice answer`);
      out[name] = choiceAnswer(question, record, name);
    } else {
      if (record.type !== "score") throw new Error(`answer "${name}" is not a score answer`);
      out[name] = scoreAnswer(question, record, name);
    }
  }
  return out;
}

function choiceAnswer(
  question: Extract<Questions[string], { type: "choice" }>,
  record: Record<string, unknown>,
  name: string,
): { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> } {
  const labels = Object.keys(question.criteria);
  const choice = record.choice;
  if (typeof choice !== "string" || !labels.includes(choice)) {
    throw new Error(`answer "${name}" reports a choice outside the question's labels`);
  }
  const probabilities = choiceDistribution(record.probabilities, labels, choice, name);
  const confidence = confidenceOf(record, name) ?? probabilities[choice] ?? 0;
  return { type: "choice", choice, confidence, probabilities };
}

/**
 * The reported choice distribution, or a point mass on the selected choice
 * when Cloudflare omits probabilities — an all-zero map would be rejected by
 * readChoice (sum 0) and burn every retry on a valid answer.
 */
function choiceDistribution(
  reported: unknown,
  labels: readonly string[],
  choice: string,
  name: string,
): Record<string, number> {
  if (reported === undefined || reported === null) {
    return Object.fromEntries(labels.map((label) => [label, label === choice ? 1 : 0]));
  }
  return distribution(reported, labels, name, "choices");
}

function scoreAnswer(
  question: Extract<Questions[string], { type: "score" }>,
  record: Record<string, unknown>,
  name: string,
): {
  type: "score";
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
} {
  const levelCount = question.criteria.length;
  const score = record.score;
  if (typeof score !== "number" || !Number.isFinite(score)) {
    throw new Error(`answer "${name}" reports an invalid score`);
  }
  if (score < -1e-6 || score > levelCount - 1 + 1e-6) {
    throw new Error(`answer "${name}" reports an out-of-range score: ${score}`);
  }
  const labels = Array.from({ length: levelCount }, (_, index) => String(index));
  const probabilities = scoreDistribution(record.probabilities, labels, score, name);
  const confidence = confidenceOf(record, name) ?? Math.max(...Object.values(probabilities));
  const legend = legendOf(record.legend, levelCount, name);
  return { type: "score", score, confidence, legend, probabilities };
}

/**
 * The reported score distribution, or a synthesized one consistent with the
 * reported score when Cloudflare omits probabilities: a point mass for
 * integral scores, linear interpolation between adjacent levels for
 * fractional ones (readScore accepts fractional scores like 1.2 and expects
 * an interpolated distribution).
 */
function scoreDistribution(
  reported: unknown,
  labels: readonly string[],
  score: number,
  name: string,
): Record<string, number> {
  if (reported === undefined || reported === null) {
    const lower = Math.floor(score);
    const frac = score - lower;
    return Object.fromEntries(
      labels.map((label, index) => {
        if (index === lower) return [label, Number((1 - frac).toFixed(4))];
        if (index === lower + 1) return [label, Number(frac.toFixed(4))];
        return [label, 0];
      }),
    );
  }
  return distribution(reported, labels, name, "score levels");
}

/**
 * Validate a reported distribution. Exact canonical keys only:
 * Number("1.5")/Number("01")/Number("1e0") coercion would let noncanonical
 * level keys slip into range and get silently dropped.
 */
function distribution(
  reported: unknown,
  labels: readonly string[],
  name: string,
  kind: string,
): Record<string, number> {
  if (typeof reported !== "object" || reported === null || Array.isArray(reported)) {
    throw new Error(`answer "${name}" carries malformed probabilities`);
  }
  const extra = Object.keys(reported).filter((key) => !labels.includes(key));
  if (extra.length > 0) {
    throw new Error(`answer "${name}" carries probabilities for unknown ${kind}: ${extra.join(", ")}`);
  }
  const out: Record<string, number> = {};
  for (const label of labels) {
    out[label] = probabilityField(
      (reported as Record<string, unknown>)[label],
      `${name}.probabilities.${label}`,
    );
  }
  return out;
}

/** A probability in [0, 1], or undefined when the field is genuinely absent. */
function confidenceOf(record: Record<string, unknown>, name: string): number | undefined {
  const value = record.confidence;
  if (value === undefined || value === null) return undefined;
  return probabilityField(value, `${name}.confidence`);
}

function probabilityField(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number within [0, 1]`);
  }
  return value;
}

/** The score legend keyed by canonical level keys; absent means empty. */
function legendOf(legend: unknown, levelCount: number, name: string): Record<string, string> {
  if (legend === undefined || legend === null) return {};
  if (typeof legend !== "object" || Array.isArray(legend)) {
    throw new Error(`answer "${name}" carries a malformed legend`);
  }
  const canonical = Array.from({ length: levelCount }, (_, index) => String(index));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(legend as Record<string, unknown>)) {
    if (!canonical.includes(key) || typeof value !== "string") {
      throw new Error(`answer "${name}" carries an invalid legend entry: ${key}`);
    }
    out[key] = value;
  }
  return out;
}

/** The cloudflare adapter environment read by createCloudflareAdapter. */
export interface CloudflareAdapterEnv {
  CLOUDFLARE_ACCOUNT_ID?: string | undefined;
  CLOUDFLARE_API_TOKEN?: string | undefined;
  JEV_CLOUDFLARE_API_TOKEN?: string | undefined;
  JEV_CLOUDFLARE_MODEL?: string | undefined;
}

/**
 * Build the Cloudflare-backed Jev port. The account id and API token are read
 * only from the given environment; `JEV_CLOUDFLARE_API_TOKEN` is an
 * application-specific alias that wins over the canonical
 * `CLOUDFLARE_API_TOKEN` when both are set.
 */
export function createCloudflareAdapter(
  env: CloudflareAdapterEnv | NodeJS.ProcessEnv = process.env,
  options: { baseURL?: string; fetchFn?: FetchFn } = {},
): JevPort {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!accountId) {
    throw new MissingCredentialError(
      "CLOUDFLARE_ACCOUNT_ID is required; set it in the process environment before running jev-code with JEV_PROVIDER=cloudflare",
    );
  }
  const apiToken = (env.JEV_CLOUDFLARE_API_TOKEN ?? env.CLOUDFLARE_API_TOKEN)?.trim();
  if (!apiToken) {
    throw new MissingCredentialError(
      "CLOUDFLARE_API_TOKEN is required; set it in the process environment before running jev-code with JEV_PROVIDER=cloudflare",
    );
  }
  const model = env[CLOUDFLARE_MODEL_ENV]?.trim() || CLOUDFLARE_MODEL;
  return new CloudflareJevProvider({
    accountId,
    apiToken,
    model,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    credentialSecrets: apiToken.trim().length >= 8 ? [apiToken.trim()] : [],
  });
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

/** Map Cloudflare REST and network errors onto transport failure classes. */
export function classifyCloudflareError(error: unknown): TransportFailure {
  const value = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const status = typeof value.status === "number" ? value.status : null;
  const name = typeof value.name === "string" ? value.name : "";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (name === "AbortError" || name === "APIUserAbortError") return "aborted";
  if (
    status === 401 ||
    status === 403 ||
    /authentication|permissiondenied/i.test(name) ||
    /invalid api key|unauthenticated|authentication error|authentication failed/i.test(message)
  ) {
    return "auth";
  }
  if (status === 413 || /too large|payload|context length|exceeds the limit/.test(message)) {
    return "too_large";
  }
  const cause = value.cause;
  const causeMessage =
    typeof cause === "object" && cause !== null && "message" in cause
      ? String((cause as { message: unknown }).message).toLowerCase()
      : "";
  // Plain connection failures (TypeError: fetch failed with ECONNREFUSED etc.
  // on `cause`) must retry like other transient transport problems.
  const connectionFailure =
    /fetch failed|network|connection/.test(name.toLowerCase()) ||
    /econnrefused|enotfound|eai_again|econnreset|epipe/.test(message) ||
    /econnrefused|enotfound|eai_again|econnreset|epipe/.test(causeMessage);
  if (
    status === 408 ||
    status === 429 ||
    (status !== null && status >= 500) ||
    /timeout|ratelimit/i.test(name) ||
    /econnreset|etimedout|socket hang up|rate limit|fetch failed|timed out/.test(message) ||
    connectionFailure
  ) {
    return "transient";
  }
  if (status !== null && status >= 400) return "rejected";
  return "unknown";
}
