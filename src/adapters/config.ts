import type { JevPort } from "../core/types.ts";
import { createSdkAdapter } from "./jev.ts";

export const MODEL_ENV = "TYPESAFE_MODEL";

/** The requested model: an explicit flag wins, then TYPESAFE_MODEL; undefined means the workflow default. */
export function configuredModel(flag: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (flag !== undefined) return flag;
  const value = env[MODEL_ENV]?.trim();
  return value ? value : undefined;
}

/** Build the SDK-backed Jev port from the process environment. */
export function jevFromEnvironment(env: NodeJS.ProcessEnv): JevPort {
  return createSdkAdapter(env);
}
