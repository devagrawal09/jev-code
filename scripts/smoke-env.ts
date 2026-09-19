/** Shared skip logic for live smoke scripts. */
export interface SkipVerdict {
  skip: string | null;
}

/**
 * Decide whether a live smoke test should run: it must be explicitly requested
 * and the matching credential must be present. Returns the skip reason or null.
 */
export function checkEnvironment(
  env: NodeJS.ProcessEnv,
  options: { provider: "typesafe" | "vercel" },
): SkipVerdict {
  if (!/^(?:1|true|yes)$/i.test(env.JEV_SMOKE ?? "")) {
    return { skip: "set JEV_SMOKE=1 to run live smoke tests" };
  }
  const key = options.provider === "vercel" ? env.AI_GATEWAY_API_KEY?.trim() : env.TYPESAFE_API_KEY?.trim();
  if (!key) {
    return {
      skip: `${options.provider === "vercel" ? "AI_GATEWAY_API_KEY" : "TYPESAFE_API_KEY"} is not set`,
    };
  }
  return { skip: null };
}
