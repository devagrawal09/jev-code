import { createHash } from "node:crypto";

/** JSON serialization with sorted object keys, so equal values hash equally. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined && typeof entry !== "function")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashValue(value: unknown): string {
  return sha256(stableStringify(value));
}

/** A short stable ID such as `h_3f2a9c01d4`. */
export function stableId(prefix: string, value: unknown, length = 10): string {
  return `${prefix}_${hashValue(value).slice(0, length)}`;
}

/** Deterministic PRNG (mulberry32) seeded from a string. */
export function seededRandom(seed: string): () => number {
  let state = Number.parseInt(sha256(seed).slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const random = seededRandom(seed);
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}
