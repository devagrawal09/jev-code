import type { JevPort } from "../core/types.ts";
import { createSdkAdapter } from "./jev.ts";

export const MODEL_ENV = "TYPESAFE_MODEL";

/** The requested model: an explicit flag wins, then TYPESAFE_MODEL; undefined means the workflow default. */
export function configuredModel(flag: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (flag !== undefined) return flag;
  const value = env[MODEL_ENV]?.trim();
  return value ? value : undefined;
}

/**
 * The SDK-backed Jev port when credentials are present in the environment. Missing or unusable
 * credentials yield undefined, which workflows report as Jev being unavailable.
 */
export function jevFromEnvironment(env: NodeJS.ProcessEnv): JevPort | undefined {
  try {
    return createSdkAdapter(env);
  } catch {
    return undefined;
  }
}
