/**
 * Bounded-concurrency async map. Keeps the public RPC happy (no 500-call
 * bursts) while still running work in parallel. Preserves input order.
 */
export async function pMap<In, Out>(
  items: readonly In[],
  mapper: (item: In, index: number) => Promise<Out>,
  concurrency = 8,
): Promise<Out[]> {
  const results = new Array<Out>(items.length)
  let cursor = 0
  const limit = Math.max(1, Math.min(concurrency, items.length || 1))

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await mapper(items[index] as In, index)
    }
  }

  await Promise.all(Array.from({ length: limit }, worker))
  return results
}
