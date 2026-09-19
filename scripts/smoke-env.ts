/**
 * Shared skip logic for live smoke scripts.
 */
export interface SkipVerdict {
  skip: string | null;
}

export type SmokeProvider = "typesafe" | "vercel" | "cloudflare";

/** The credential variable each provider's live smoke needs. */
const PROVIDER_KEYS: Record<SmokeProvider, { names: string[]; label: string; extra?: string[] }> = {
  typesafe: { names: ["TYPESAFE_API_KEY"], label: "TYPESAFE_API_KEY" },
  vercel: { names: ["AI_GATEWAY_API_KEY"], label: "AI_GATEWAY_API_KEY" },
  cloudflare: {
    names: ["JEV_CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_TOKEN"],
    label: "CLOUDFLARE_API_TOKEN",
    extra: ["CLOUDFLARE_ACCOUNT_ID"],
  },
};

/**
 * Decide whether a live smoke test should run: it must be explicitly requested
 * and the matching credential(s) must be present. Returns the skip reason or null.
 */
export function checkEnvironment(env: NodeJS.ProcessEnv, options: { provider: SmokeProvider }): SkipVerdict {
  if (!/^(?:1|true|yes)$/i.test(env.JEV_SMOKE ?? "")) {
    return { skip: "set JEV_SMOKE=1 to run live smoke tests" };
  }
  const needs = PROVIDER_KEYS[options.provider];
  const key = needs.names.some((name) => env[name]?.trim());
  if (!key) {
    return { skip: `${needs.label} is not set` };
  }
  for (const extra of needs.extra ?? []) {
    if (!env[extra]?.trim()) {
      return { skip: `${extra} is not set` };
    }
  }
  return { skip: null };
}
