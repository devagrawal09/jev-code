import type { JsonValue } from "../core/types.ts";
import type { RedactionPort } from "../workflows/ports.ts";

/**
 * Obvious credential shapes. This is a best-effort scrubber, not a secret scanner:
 * it lowers the chance of forwarding or persisting a credential, nothing more.
 */
const PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  {
    kind: "private_key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  },
  { kind: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github_token", pattern: /\b(?:gh[oprsu]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g },
  { kind: "slack_token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "api_key", pattern: /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)[-_][A-Za-z0-9_-]{16,}\b/g },
  { kind: "api_key", pattern: /\bsk-[A-Za-z0-9_-]{32,}\b/g },
  { kind: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: "bearer_token", pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g },
  { kind: "url_credentials", pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi },
  {
    kind: "assigned_secret",
    pattern:
      /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|password|passwd|token|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_]*["']?\s*[:=]\s*)(["']?)([^\s"'`,;]{8,})\2/gi,
  },
];

export interface RedactionResult {
  text: string;
  count: number;
}

export function redactText(input: string, extraSecrets: readonly string[] = envSecrets()): RedactionResult {
  let text = input;
  let count = 0;
  for (const secret of extraSecrets) {
    if (secret.length < 8) continue;
    const parts = text.split(secret);
    if (parts.length > 1) {
      count += parts.length - 1;
      text = parts.join("[REDACTED:env_secret]");
    }
  }
  for (const { kind, pattern } of PATTERNS) {
    text = text.replace(pattern, (...match: string[]) => {
      count += 1;
      if (kind === "url_credentials") return `${match[1]}[REDACTED:${kind}]@`;
      if (kind === "bearer_token") return `${match[1]} [REDACTED:${kind}]`;
      if (kind === "assigned_secret") {
        const value = match[3] ?? "";
        // Leave obvious non-secrets (references, calls, placeholders, plain words) alone.
        if (
          /^(?:process\.env|env\.|\$\{|<|\[REDACTED)/.test(value) ||
          /[()]/.test(value) ||
          (!/\d/.test(value) && value.length < 20)
        ) {
          count -= 1;
          return match[0]!;
        }
        return `${match[1]}${match[2]}[REDACTED:${kind}]${match[2]}`;
      }
      return `[REDACTED:${kind}]`;
    });
  }
  return { text, count };
}

/** Redact every string in a JSON value. Returns a new value and the redaction count. */
export function redactJson<T extends JsonValue>(
  value: T,
  extraSecrets: readonly string[] = envSecrets(),
): { value: T; count: number } {
  let count = 0;
  const visit = (node: JsonValue): JsonValue => {
    if (typeof node === "string") {
      const result = redactText(node, extraSecrets);
      count += result.count;
      return result.text;
    }
    if (Array.isArray(node)) return node.map(visit);
    if (node !== null && typeof node === "object") {
      const output: Record<string, JsonValue> = {};
      for (const [key, entry] of Object.entries(node)) {
        output[key] = /^(?:api[_-]?key|authorization|x-api-key)$/i.test(key)
          ? "[REDACTED:field]"
          : visit(entry);
      }
      return output;
    }
    return node;
  };
  return { value: visit(value) as T, count };
}

/** Credential values present in this process that must never leave it. */
export function envSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const values: string[] = [];
  for (const name of ["TYPESAFE_API_KEY", "AI_GATEWAY_API_KEY", "COPILOT_MCP_TYPESAFE_API_KEY"]) {
    const value = env[name];
    if (value && value.trim().length >= 8) values.push(value.trim());
  }
  return values;
}

/**
 * Redaction that always covers both the supplied environment and the live
 * process environment: a custom environment must not silently lose redaction
 * of the process's credentials (or vice versa) just because it was passed in.
 */
export function createRedaction(
  env: NodeJS.ProcessEnv = process.env,
  extraSecrets: readonly string[] = [],
): RedactionPort {
  const secrets = [...new Set([...envSecrets(env), ...envSecrets(), ...extraSecrets])];
  return {
    json: <T extends JsonValue>(value: T) => redactJson(value, secrets) as { value: T; count: number },
    text: (value: string) => redactText(value, secrets),
    message: (error: unknown, max = 300) => safeMessage(error, max, secrets),
  };
}

/** Make an error message safe to print: redact and bound its length. */
export function safeMessage(error: unknown, max = 300, extraSecrets?: readonly string[]): string {
  const raw = error instanceof Error ? error.message : String(error);
  const { text } = extraSecrets ? redactText(raw, extraSecrets) : redactText(raw);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
