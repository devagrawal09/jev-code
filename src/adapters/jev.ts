import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { JevPort, TransportFailure } from "../core/types.ts";

export class MissingCredentialError extends Error {
  constructor() {
    super("TYPESAFE_API_KEY is required; set it in the process environment before running jev-code");
    this.name = "MissingCredentialError";
  }
}

/** Build the SDK-backed Jev port. The API key is read only from the given environment. */
export function createSdkAdapter(env: NodeJS.ProcessEnv = process.env): JevPort {
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) throw new MissingCredentialError();
  // Retries are owned by the executor so they count against run budgets; SDK logging is
  // disabled because debug logging would include request bodies.
  const client = new TypeSafeClient({ apiKey, retry: { maxRetries: 0 }, logLevel: "off" });
  return {
    async ask(request, options) {
      return client.systemOne(
        { state: request.state, questions: request.questions, model: request.model },
        { timeout: options.timeoutMs, ...(options.signal ? { signal: options.signal } : {}) },
      );
    },
  };
}

/** Map TypeSafe SDK and network errors onto transport failure classes. */
export function classifyError(error: unknown): TransportFailure {
  const value = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
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
