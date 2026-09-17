import { mapPool } from "./batch.ts";
import { Budget, type BudgetDenial, type BudgetLimits, estimateTokens } from "./budget.ts";
import type { Questions } from "./questions.ts";
import type {
  Frame,
  JevPort,
  JevRequest,
  JevStatus,
  JevUsage,
  JsonObject,
  TransportFailure,
} from "./types.ts";
import { readEnvelope, ValidationError } from "./validation.ts";

export type FrameFailure =
  | "offline"
  | "unavailable"
  | "budget"
  | "invalid"
  | "too_large"
  | "failed"
  | "aborted";

export type FrameOutcome<A> =
  | { ok: true; value: A; frameId: string; model: string }
  | { ok: false; reason: FrameFailure; detail: string; frameId: string };

/** One request attempt, reported to an optional sink after it settles. */
export interface FrameAttempt<P = unknown> {
  frameId: string;
  template: string;
  scope: string;
  provenance: P[];
  attempt: number;
  requestedModel: string;
  startedAt: string;
  latencyMs: number;
  request: { state: JsonObject; questions: Questions };
  result: "ok" | "invalid" | TransportFailure;
  resolvedModel?: string;
  usage?: { inputTokens: number; outputTokens: number };
  response?: unknown;
  parsed?: unknown;
  error?: string;
}

/** Abstract observer for execution events, such as an artifact recorder. */
export interface FrameSink<P = unknown> {
  attempt?(record: FrameAttempt<P>): Promise<void>;
  budgetExhausted?(frameId: string, limit: BudgetDenial): Promise<void>;
}

export interface FrameExecutorOptions<P = unknown> {
  /** Null when no port is configured; frames then fail as unavailable. */
  port: JevPort | null;
  model: string;
  budget: BudgetLimits;
  /** Never call the port; frames fail as offline. */
  offline?: boolean;
  concurrency?: number;
  /** Retries for transient failures only. */
  retries?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Rewrite a request before it is sent and recorded; returns how many changes were made. */
  prepare?: (request: JevRequest) => { request: JevRequest; changes: number };
  classifyError?: (error: unknown) => TransportFailure;
  /** Describe a thrown error safely; defaults to its message. */
  describeError?: (error: unknown) => string;
  sink?: FrameSink<P>;
  retryDelayMs?: (attempt: number) => number;
}

export const EXECUTOR_LIMITS = {
  maxConcurrency: 16,
  maxRetries: 5,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 120_000,
} as const;

/**
 * Generic budgeted executor for independent typed frames: reserves budget before each call,
 * validates every response, retries transient failures, stops after authentication failures,
 * and asks identical frames once.
 */
export class FrameExecutor<P = unknown> {
  readonly model: string;
  readonly budget: Budget;
  readonly concurrency: number;
  readonly retries: number;
  readonly timeoutMs: number;
  /** Total changes reported by `prepare` across all sent requests. */
  preparedChanges = 0;
  private readonly options: FrameExecutorOptions<P>;
  private port: JevPort | null;
  private status: JevStatus = "not_needed";
  private reason: string | null = null;
  private readonly counters = {
    requests: 0,
    failedRequests: 0,
    invalidResponses: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
  };
  private readonly models = new Set<string>();
  private readonly cache = new Map<string, Promise<FrameOutcome<unknown>>>();

  constructor(options: FrameExecutorOptions<P>) {
    this.options = options;
    this.model = options.model;
    this.budget = new Budget(options.budget);
    this.concurrency = clamp(options.concurrency ?? 4, 1, EXECUTOR_LIMITS.maxConcurrency);
    this.retries = clamp(options.retries ?? 2, 0, EXECUTOR_LIMITS.maxRetries);
    this.timeoutMs = clamp(
      options.timeoutMs ?? 30_000,
      EXECUTOR_LIMITS.minTimeoutMs,
      EXECUTOR_LIMITS.maxTimeoutMs,
    );
    this.port = options.offline ? null : options.port;
    if (options.offline) {
      this.status = "offline";
      this.reason = "offline mode";
    } else if (!options.port) {
      this.status = "unavailable";
      this.reason = "Jev adapter is not configured";
    }
  }

  /** Why the port is not being called, or null when it is available. */
  get unavailableReason(): string | null {
    return this.reason;
  }

  /** Run many frames with bounded concurrency; outcomes keep frame order. */
  runAll<A>(frames: readonly Frame<A, P>[]): Promise<FrameOutcome<A>[]> {
    return mapPool(frames, this.concurrency, (frame) => this.run(frame));
  }

  /** Run one frame. Identical frames are asked once. */
  run<A>(frame: Frame<A, P>): Promise<FrameOutcome<A>> {
    const existing = this.cache.get(frame.id);
    if (existing) return existing as Promise<FrameOutcome<A>>;
    const pending = this.execute(frame);
    this.cache.set(frame.id, pending as Promise<FrameOutcome<unknown>>);
    return pending;
  }

  usage(): JevUsage {
    return {
      status: this.status,
      requestedModel: this.model,
      resolvedModels: [...this.models].sort(),
      ...this.counters,
    };
  }

  private describe(error: unknown): string {
    if (this.options.describeError) return this.options.describeError(error);
    return error instanceof Error ? error.message : String(error);
  }

  private async execute<A>(frame: Frame<A, P>): Promise<FrameOutcome<A>> {
    const fail = (reason: FrameFailure, detail: string): FrameOutcome<A> => ({
      ok: false,
      reason,
      detail,
      frameId: frame.id,
    });
    if (!this.port || this.reason) {
      return fail(this.status === "offline" ? "offline" : "unavailable", this.reason ?? "no port");
    }
    const raw: JevRequest = { state: frame.state, questions: frame.questions, model: this.model };
    const prepared = this.options.prepare?.(raw) ?? { request: raw, changes: 0 };
    this.preparedChanges += prepared.changes;
    const request = prepared.request;
    const estimate = estimateTokens(request);
    const sink = this.options.sink;
    const signal = this.options.signal;

    for (let attempt = 1; attempt <= this.retries + 1; attempt++) {
      if (signal?.aborted) return fail("aborted", "run aborted");
      // A port can be disabled by an authentication failure in a concurrent frame.
      const port = this.port;
      if (!port) return fail("unavailable", this.reason ?? "no port");
      const denial = this.budget.reserve(estimate);
      if (denial) {
        await sink?.budgetExhausted?.(frame.id, denial);
        return fail("budget", `budget exhausted: ${denial}`);
      }
      this.status = "used";
      this.counters.requests++;
      const started = performance.now();
      const base = {
        frameId: frame.id,
        template: frame.template,
        scope: frame.scope,
        provenance: frame.provenance,
        attempt,
        requestedModel: this.model,
        startedAt: new Date().toISOString(),
        request: { state: request.state, questions: request.questions },
      };
      let response: unknown;
      try {
        response = await port.ask(request, {
          timeoutMs: this.timeoutMs,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        const latencyMs = Math.round(performance.now() - started);
        this.counters.latencyMs += latencyMs;
        this.counters.failedRequests++;
        this.budget.settle(estimate, 0);
        const failure = this.options.classifyError?.(error) ?? "unknown";
        const message = this.describe(error);
        await sink?.attempt?.({ ...base, latencyMs, result: failure, error: message });
        if (failure === "auth") {
          this.port = null;
          this.reason = "authentication failed";
          this.status = "unavailable";
          return fail("unavailable", "authentication failed");
        }
        if (failure === "transient" && attempt <= this.retries) {
          await delay(this.options.retryDelayMs?.(attempt) ?? 250 * 2 ** (attempt - 1), signal);
          continue;
        }
        if (failure === "too_large") return fail("too_large", message);
        if (failure === "aborted") return fail("aborted", message);
        return fail("failed", `${failure}: ${message}`);
      }
      const latencyMs = Math.round(performance.now() - started);
      this.counters.latencyMs += latencyMs;
      try {
        const envelope = readEnvelope(response);
        this.budget.settle(estimate, envelope.usage.inputTokens);
        this.counters.inputTokens += envelope.usage.inputTokens;
        this.counters.outputTokens += envelope.usage.outputTokens;
        this.models.add(envelope.model);
        const value = frame.parse(envelope.answers);
        await sink?.attempt?.({
          ...base,
          latencyMs,
          result: "ok",
          resolvedModel: envelope.model,
          usage: envelope.usage,
          response,
          parsed: value,
        });
        return { ok: true, value, frameId: frame.id, model: envelope.model };
      } catch (error) {
        this.counters.invalidResponses++;
        const message =
          error instanceof ValidationError ? error.message : `parser error: ${this.describe(error)}`;
        await sink?.attempt?.({ ...base, latencyMs, result: "invalid", response, error: message });
        return fail("invalid", message);
      }
    }
    return fail("failed", "retries exhausted");
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
