// @ts-check
// Recovery for a Solana signature cursor the RPC node can no longer resolve.
//
// Every incremental Solana crawl in this repo stores the newest signature it
// saw and presents it back as getSignaturesForAddress({ until }). That call
// resolves `until` against the answering node's OWN history and fails the whole
// request with "Transaction <sig> not found" the moment that signature is not
// in the ledger it holds. Two things make that terminal rather than transient:
// the stored cursor never changes on the failure path, so every later tick
// presents the same dead signature and gets the same error forever; and the
// crawl crons catch per agent, so the job keeps reporting 200 while the agent
// silently stops indexing.
//
// It is not only pruning that triggers it. The lane router rotates across many
// RPC providers with different retention, and a directory row can carry a
// signature that the answering lane never had, so a cursor written by one lane
// is unreadable by the next. The recovery is the same either way: drop `until`,
// re-scan from the head, and tell the caller its cursor was abandoned so it
// clears the dead value instead of writing it back.

/**
 * Does this RPC error mean our stored cursor is no longer resolvable by the
 * node that answered? Deliberately narrow: a 429, a TLS fault or a provider
 * error must still propagate, because dropping the cursor on a transient
 * failure would re-scan the whole history on every blip.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isPrunedCursorError(err) {
	const msg = (err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err || ''));
	return /Transaction .* not found/i.test(msg) || /failed to get signatures for address/i.test(msg);
}

/**
 * Signatures newer than the cursor, self-healing past an unresolvable cursor.
 *
 * The retry drops `until` and takes the most recent `limit` signatures instead.
 * That is safe to replay: both call sites insert through a unique constraint
 * with `on conflict do nothing`, so re-reading a window already indexed inserts
 * nothing twice.
 *
 * @param {{ getSignaturesForAddress: (key: any, opts: object) => Promise<any[]> }} conn
 * @param {any} agentKey
 * @param {number} limit
 * @param {string|undefined} until
 * @returns {Promise<{ sigs: any[], cursorReset: boolean }>}
 */
export async function signaturesSinceCursor(conn, agentKey, limit, until) {
	try {
		return { sigs: await conn.getSignaturesForAddress(agentKey, { limit, until }), cursorReset: false };
	} catch (err) {
		if (!until || !isPrunedCursorError(err)) throw err;
		const sigs = await conn.getSignaturesForAddress(agentKey, { limit });
		return { sigs, cursorReset: true };
	}
}
