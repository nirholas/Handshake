// Bounded-concurrency helpers, backed by `p-limit`.
//
// Five independent pool implementations existed under api/ before this. Two
// were near-identical copies of the same `Array.from({length: n}, worker)`
// pattern; one (custody-proof) chunked the input into fixed batches and awaited
// each batch, so one slow item stalled every other item in its batch and left
// the pool idle until the batch drained. `p-limit` keeps every slot busy.

import pLimit from 'p-limit';

/**
 * Map over `items` with at most `concurrency` operations in flight, preserving
 * input order in the result. Rejects on the first error, like `Promise.all`.
 *
 * @template T, R
 * @param {Iterable<T>} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export function mapPool(items, concurrency, fn) {
	const limit = pLimit(Math.max(1, concurrency));
	return Promise.all([...items].map((item, i) => limit(() => fn(item, i))));
}

/**
 * Like `mapPool`, but a failing item yields `{ ok: false, error }` instead of
 * rejecting the whole batch — for backfills and sweeps where one bad row must
 * not abort the run.
 *
 * @template T, R
 * @param {Iterable<T>} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<Array<{ ok: true, value: R } | { ok: false, error: unknown }>>}
 */
export function mapPoolSettled(items, concurrency, fn) {
	return mapPool(items, concurrency, async (item, i) => {
		try {
			return { ok: true, value: await fn(item, i) };
		} catch (error) {
			return { ok: false, error };
		}
	});
}
