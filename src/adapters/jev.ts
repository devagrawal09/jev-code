import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { JevCallOptions, JevPort, JevRequest, TransportFailure } from "../core/types.ts";

export class MissingCredentialError extends Error {
  constructor(
    message = "TYPESAFE_API_KEY is required; set it in the process environment before running jev-code",
  ) {
    super(message);
    this.name = "MissingCredentialError";
  }
}

/** The slice of TypeSafeClient the provider needs; injectable for tests. */
export interface TypeSafeClientLike {
  systemOne(request: unknown, options?: { timeout?: number; signal?: AbortSignal }): Promise<unknown>;
}

export interface TypeSafeJevProviderOptions {
  apiKey: string;
  /** Prebuilt client, for tests; defaults to the real SDK client. */
  client?: TypeSafeClientLike;
}

/**
 * Direct TypeSafe Jev provider: the reference implementation of the Jev port.
 * Authentication and the TypeSafe wire format stay inside this class.
 */
export class TypeSafeJevProvider implements JevPort {
  /** Credential values used by this port; consumed by dependency redaction. */
  readonly credentialSecrets: string[];

  private readonly client: TypeSafeClientLike;

  constructor(options: TypeSafeJevProviderOptions) {
    // Retries are owned by the executor so they count against run budgets; SDK logging is
    // disabled because debug logging would include request bodies.
    const apiKey = options.apiKey;
    this.client = options.client ?? new TypeSafeClient({ apiKey, retry: { maxRetries: 0 }, logLevel: "off" });
    this.credentialSecrets = apiKey.trim().length >= 8 ? [apiKey.trim()] : [];
  }

  async ask(request: JevRequest, options: JevCallOptions): Promise<unknown> {
    return this.client.systemOne(
      { state: request.state, questions: request.questions, model: request.model },
      { timeout: options.timeoutMs, ...(options.signal ? { signal: options.signal } : {}) },
    );
  }
}

/** Build the direct TypeSafe Jev port. The API key is read only from the given environment. */
export function createSdkAdapter(env: NodeJS.ProcessEnv = process.env): JevPort {
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) throw new MissingCredentialError();
  return new TypeSafeJevProvider({ apiKey });
}

/** The port's own credential values, so redaction never depends on env visibility. */
export function portSecrets(jev: JevPort): string[] {
  const candidate = (jev as { credentialSecrets?: unknown }).credentialSecrets;
  return Array.isArray(candidate) ? candidate.filter((v): v is string => typeof v === "string") : [];
}

/** Map provider and network errors onto transport failure classes. */
export function classifyError(error: unknown): TransportFailure {
  const value = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  // AI SDK RetryError carries every attempt; classify the last cause (defense in depth:
  // the Vercel provider disables SDK retries, so this rarely triggers).
  const attempts = value.errors;
  if (Array.isArray(attempts) && attempts.length > 0) return classifyError(attempts[attempts.length - 1]);
  const status = typeof value.status === "number" ? value.status : null;
  const name = typeof value.name === "string" ? value.name : "";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (name === "APIUserAbortError" || name === "AbortError") return "aborted";
  if (status === 401 || status === 403 || /authentication|permissiondenied/i.test(name)) return "auth";
  if (status === 413 || /max_tokens_exceeded|too large|payload|context length/.test(message))
    return "too_large";
  if (
    status === 408 ||
    status === 429 ||
    (status !== null && status >= 500) ||
    /timeout|connection|ratelimit/i.test(name) ||
    /econnreset|etimedout|socket hang up|rate limit/.test(message)
  ) {
    return "transient";
  }
  if (status !== null && status >= 400) return "rejected";
  return "unknown";
}
