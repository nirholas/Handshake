// Shared shape for an agent's activity line.
//
// Two surfaces read `agent_actions` and hand it to the same client renderer: the
// per-agent SSE stream (api/agent-screen-stream.js, `log` events) and the batched
// wall endpoint (api/agents/activity.js). They MUST emit the identical entry
// shape, or a card would render a streamed row differently from a batched one.
// The mapping lives here once so the two can never drift apart.

/**
 * Map an `agent_actions` row to the wire entry `{ ts, activity, type, mm? }`.
 *
 * The holder-readable line lives in payload.summary (falling back to a
 * detail/title or the bare type). A market-maker action (type `mm_*`) carries
 * its structured floor/price context as `mm`, so a reconnect's DB backfill
 * drives the arena floor line and the card badge exactly like a live push does.
 *
 * @param {{ type?: string, payload?: unknown, created_at?: string | Date }} row
 * @returns {{ ts: number, activity: string, type: string, mm?: object }}
 */
export function rowToEntry(row) {
	const p = row.payload && typeof row.payload === 'object' ? row.payload : {};
	const entry = {
		ts: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
		activity: p.summary || p.detail || p.title || row.type || 'action',
		type: row.type || 'action',
	};
	if (typeof row.type === 'string' && row.type.startsWith('mm_') && (p.floorSol != null || p.priceSol != null)) {
		entry.mm = {
			type: row.type,
			floorSol: Number(p.floorSol) || 0,
			priceSol: Number(p.priceSol) || 0,
			sizeSol: Number(p.sizeSol) || 0,
			sideBuy: p.sideBuy === true ? true : p.sideBuy === false ? false : null,
			simulate: !!p.simulate,
			signature: p.signature || null,
			mint: p.mint || null,
		};
	}
	return entry;
}
