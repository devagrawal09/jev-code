import type { JevPort, TransportFailure } from "../core/types.ts";
import { classifyCloudflareError, createCloudflareAdapter } from "./cloudflare-jev.ts";
import { classifyError, createSdkAdapter } from "./jev.ts";
import { classifyVercelError, createVercelAdapter } from "./vercel-jev.ts";

export const MODEL_ENV = "TYPESAFE_MODEL";
export const PROVIDER_ENV = "JEV_PROVIDER";
export const DEFAULT_PROVIDER = "typesafe";
export const PROVIDER_NAMES = ["typesafe", "vercel", "cloudflare"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export class InvalidProviderError extends Error {
  constructor(name: string) {
    super(
      `JEV_PROVIDER must be one of ${PROVIDER_NAMES.join(", ")} (got "${name}"); ` +
        "set it in the process environment before running jev-code",
    );
    this.name = "InvalidProviderError";
  }
}

/** The requested model: an explicit flag wins, then TYPESAFE_MODEL; undefined means the workflow default. */
export function configuredModel(flag: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (flag !== undefined) return flag;
  const value = env[MODEL_ENV]?.trim();
  return value ? value : undefined;
}

/** The selected provider name; unset or blank means the default (typesafe). */
export function configuredProvider(env: NodeJS.ProcessEnv): ProviderName {
  const raw = env[PROVIDER_ENV]?.trim();
  if (!raw) return DEFAULT_PROVIDER;
  if (!(PROVIDER_NAMES as readonly string[]).includes(raw)) throw new InvalidProviderError(raw);
  return raw as ProviderName;
}

/** Create the configured Jev provider. */
export function createJevProvider(name: ProviderName, env: NodeJS.ProcessEnv): JevPort {
  if (name === "vercel") return createVercelAdapter(env);
  if (name === "cloudflare") return createCloudflareAdapter(env);
  return createSdkAdapter(env);
}

/** Build the configured Jev port from the process environment. */
export function jevFromEnvironment(env: NodeJS.ProcessEnv): JevPort {
  return createJevProvider(configuredProvider(env), env);
}

/** The error classifier of the selected provider. */
export function classifierFor(name: ProviderName): (error: unknown) => TransportFailure {
  if (name === "vercel") return classifyVercelError;
  if (name === "cloudflare") return classifyCloudflareError;
  return classifyError;
}
