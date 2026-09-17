export interface BudgetLimits {
  requests: number;
  inputTokens: number;
  wallMs: number;
}

export type BudgetDenial = "requests" | "input_tokens" | "wall_clock";

/** Deterministic run budget. Input tokens are reserved from a byte estimate before each call. */
export class Budget {
  readonly limits: BudgetLimits;
  readonly startedAt: number;
  requests = 0;
  inputTokens = 0;
  exhausted: BudgetDenial | null = null;
  private readonly now: () => number;

  constructor(limits: BudgetLimits, now: () => number = Date.now) {
    this.limits = limits;
    this.now = now;
    this.startedAt = now();
  }

  /** Reserve one request. Returns a denial reason instead of throwing. */
  reserve(estimatedInputTokens: number): BudgetDenial | null {
    let denial: BudgetDenial | null = null;
    if (this.requests + 1 > this.limits.requests) denial = "requests";
    else if (this.inputTokens + estimatedInputTokens > this.limits.inputTokens) denial = "input_tokens";
    else if (this.now() - this.startedAt > this.limits.wallMs) denial = "wall_clock";
    if (denial) {
      this.exhausted ??= denial;
      return denial;
    }
    this.requests++;
    this.inputTokens += estimatedInputTokens;
    return null;
  }

  /** Replace the estimate with reported usage once a response arrives. */
  settle(estimatedInputTokens: number, reportedInputTokens: number | null): void {
    if (reportedInputTokens !== null) this.inputTokens += reportedInputTokens - estimatedInputTokens;
  }
}

const encoder = new TextEncoder();

/** Rough upper-bound token estimate from serialized request size. */
export function estimateTokens(value: unknown): number {
  return Math.ceil(encoder.encode(JSON.stringify(value)).length / 3);
}
