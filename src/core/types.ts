import type { Questions } from "./questions.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** A judgment frame: one evidence scope, its questions, provenance of type `P`, and an answer parser. */
export interface Frame<A, P = unknown> {
  id: string;
  template: `${string}@${number}`;
  scope: string;
  state: JsonObject;
  questions: Questions;
  provenance: P[];
  parse(answers: Record<string, unknown>): A;
}

export interface JevRequest {
  state: JsonObject;
  questions: Questions;
  model: string;
}

export interface JevCallOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

/** The only way core reaches Jev. Implementations live outside core and return the raw response. */
export interface JevPort {
  ask(request: JevRequest, options: JevCallOptions): Promise<unknown>;
}

/** Transport failure classes a port implementation reports for a thrown error. */
export type TransportFailure = "auth" | "too_large" | "transient" | "rejected" | "aborted" | "unknown";

export type JevStatus = "used" | "not_needed" | "unavailable";

export interface JevUsage {
  status: JevStatus;
  requestedModel: string;
  resolvedModels: string[];
  requests: number;
  failedRequests: number;
  invalidResponses: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}
