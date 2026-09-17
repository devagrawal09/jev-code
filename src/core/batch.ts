/** Split items into consecutive shards of at most `size`, preserving order. */
export function shard<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error("shard size must be a positive integer");
  const shards: T[][] = [];
  for (let index = 0; index < items.length; index += size) shards.push(items.slice(index, index + size));
  return shards;
}

/** Run `fn` over items with bounded concurrency; results keep input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Judge a shard; when the service reports it too large, split it in half deterministically
 * and retry the halves. Single items that are still too large are reported, not dropped.
 */
export async function withSplitting<T, R>(
  items: readonly T[],
  run: (items: readonly T[]) => Promise<{ tooLarge: true } | { tooLarge: false; value: R }>,
): Promise<Array<{ items: readonly T[]; value: R | null }>> {
  const outcome = await run(items);
  if (!outcome.tooLarge) return [{ items, value: outcome.value }];
  if (items.length <= 1) return [{ items, value: null }];
  const middle = Math.ceil(items.length / 2);
  return [
    ...(await withSplitting(items.slice(0, middle), run)),
    ...(await withSplitting(items.slice(middle), run)),
  ];
}
