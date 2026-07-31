/**
 * Bounded-concurrency map. Third-party hosts punish a fleet-wide fan-out, and
 * an unbounded Promise.all over 300 repositories is exactly that fan-out.
 */
export async function mapPool(items, limit, worker) {
	const list = [...items];
	const results = new Array(list.length);
	const width = Math.max(1, Math.min(limit, list.length));
	let cursor = 0;

	const run = async () => {
		for (;;) {
			const index = cursor++;
			if (index >= list.length) return;
			results[index] = await worker(list[index], index);
		}
	};

	await Promise.all(Array.from({ length: width }, run));
	return results;
}

/** Resolve after `ms`, used only for backoff between retries. */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
