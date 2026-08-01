/**
 * Trade card model: the shared truth behind a single shareable pump.fun trade.
 *
 * One closed `agent_sniper_positions` row becomes one card. Both the OG image
 * (api/trade-og.js) and the share page (api/trade-share.js) render from THIS
 * model, so the picture that unfurls on X and the page a click lands on can
 * never disagree about a number.
 *
 * Everything here is pure: row in, view model out. No database, no network, no
 * clock. That is what makes the numbers testable (tests/trade-card.test.js).
 *
 * Honesty rules baked into the model, per the Arena trust standard:
 *   - A paper fill (simulate mode) is FLAGGED, never dressed up as a live trade.
 *     `paper: true` drives a visible marker on the card and in the share text.
 *   - A moon-bag exit is not a full exit. `moonbag: true` says the initials came
 *     out and the rest still rides, so a "+180%" headline is not read as "sold".
 *   - Losses render exactly like wins. There is no branch that hides a red card.
 */

import { holdTime, fmtSol, fmtPct, shortAddr } from '../../src/trader-format.js';

export const LAMPORTS_PER_SOL = 1e9;

/** The paper-fill sentinel the sniper writes into buy_sig/sell_sig in simulate mode. */
export const SIMULATED_SIG = 'SIMULATED';

/** Exit reasons the engine can write, mapped to language a spectator understands. */
const EXIT_LABELS = {
	take_profit: 'Take-profit',
	stop_loss: 'Stop-loss',
	trailing_stop: 'Trailing stop',
	timeout: 'Max hold reached',
	manual: 'Closed by owner',
	kill_switch: 'Kill switch',
	graduated: 'Graduated to AMM',
	error: 'Closed on error',
};

/** Accent per outcome. Used by the SVG card and the share page alike. */
export const TONE_ACCENT = { win: '#34d399', loss: '#f87171', flat: '#94a3b8' };

export function exitReasonLabel(reason) {
	if (!reason) return 'Closed';
	return EXIT_LABELS[reason] || String(reason).replace(/_/g, ' ');
}

function num(v) {
	if (v == null) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function lamportsToSol(v) {
	if (v == null) return null;
	try {
		return Number(BigInt(v)) / LAMPORTS_PER_SOL;
	} catch {
		const n = Number(v);
		return Number.isFinite(n) ? n / LAMPORTS_PER_SOL : null;
	}
}

/** A real on-chain signature, or null for a paper fill / missing leg. */
function realSig(sig) {
	const s = typeof sig === 'string' ? sig.trim() : '';
	return s && s !== SIMULATED_SIG ? s : null;
}

export function solscanTx(sig, network) {
	const s = realSig(sig);
	if (!s) return null;
	return network === 'devnet' ? `https://solscan.io/tx/${s}?cluster=devnet` : `https://solscan.io/tx/${s}`;
}

export function solscanToken(mint, network) {
	if (!mint) return null;
	return network === 'devnet'
		? `https://solscan.io/token/${mint}?cluster=devnet`
		: `https://solscan.io/token/${mint}`;
}

/**
 * Seconds held, from the two timestamps the engine stamps. Returns null when
 * either end is missing or the clock ran backwards, so the card shows a dash
 * instead of inventing a duration.
 */
export function heldSeconds(openedAt, closedAt) {
	if (!openedAt || !closedAt) return null;
	const a = new Date(openedAt).getTime();
	const b = new Date(closedAt).getTime();
	if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
	return (b - a) / 1000;
}

/**
 * Return multiple on the entry: 4.12 for a +312% trade. Null when the entry
 * size is unknown or zero, which is the only case where a multiple is undefined.
 */
export function returnMultiple(pnlPct) {
	const p = num(pnlPct);
	if (p == null) return null;
	const m = 1 + p / 100;
	return m > 0 ? m : 0;
}

/**
 * The single biggest number on the card. Percent is the memecoin lingua franca,
 * so it leads; the multiple rides alongside once a trade more than doubled.
 */
export function headlineFor(pnlPct) {
	const p = num(pnlPct);
	if (p == null) return { primary: 'CLOSED', secondary: null };
	const primary = fmtPct(p, { sign: true, dp: Math.abs(p) >= 100 ? 0 : 1 });
	const mult = returnMultiple(p);
	const secondary = mult != null && mult >= 2 ? `${mult.toFixed(mult >= 10 ? 0 : 1)}x` : null;
	return { primary, secondary };
}

export function toneFor(pnlPct) {
	const p = num(pnlPct);
	if (p == null || Math.abs(p) < 0.05) return 'flat';
	return p > 0 ? 'win' : 'loss';
}

/**
 * Shape a joined position + agent row into the card model.
 *
 * @param {object} row  agent_sniper_positions joined to agent_identities:
 *   id, agent_id, network, mint, symbol, name, status, exit_reason,
 *   entry_quote_lamports, exit_quote_lamports, realized_pnl_lamports,
 *   realized_pnl_pct, buy_sig, sell_sig, moonbag_base_amount,
 *   moonbag_last_value_lamports, opened_at, closed_at,
 *   agent_name, agent_image
 * @param {{ origin?: string }} [opts]
 * @returns {object} the view model both renderers read
 */
export function shapeTradeCard(row, { origin = 'https://three.ws' } = {}) {
	const network = row.network === 'devnet' ? 'devnet' : 'mainnet';
	const pnlPct = num(row.realized_pnl_pct);
	const pnlSol = lamportsToSol(row.realized_pnl_lamports);
	const entrySol = lamportsToSol(row.entry_quote_lamports);
	const exitSol = lamportsToSol(row.exit_quote_lamports);

	const buyUrl = solscanTx(row.buy_sig, network);
	const sellUrl = solscanTx(row.sell_sig, network);
	// A fill is paper when the engine wrote the sentinel (or no signature at all)
	// on the entry leg. The entry is the honest test: every live position has one.
	const paper = !realSig(row.buy_sig);

	const secs = heldSeconds(row.opened_at, row.closed_at);
	const moonbagTokens = num(row.moonbag_base_amount) || 0;
	const moonbagSol = moonbagTokens > 0 ? lamportsToSol(row.moonbag_last_value_lamports) : null;

	const tone = toneFor(pnlPct);
	const headline = headlineFor(pnlPct);
	const symbol = String(row.symbol || row.name || 'coin').replace(/^\$+/, '') || 'coin';
	const agentName = String(row.agent_name || 'Agent').trim() || 'Agent';

	const pnlSolStr = pnlSol != null ? fmtSol(pnlSol) : null;
	const holdLabel = secs != null ? holdTime(secs) : null;

	const model = {
		id: row.id,
		agentId: row.agent_id,
		agentName,
		agentImage: row.agent_image || row.agent_avatar || null,
		network,
		mint: row.mint,
		mintShort: shortAddr(row.mint, 4, 4),
		symbol,
		coinName: row.name || null,

		paper,
		moonbag: moonbagTokens > 0,
		moonbagSol,
		tone,
		accent: TONE_ACCENT[tone],
		win: tone === 'win',

		pnlPct,
		pnlSol,
		entrySol,
		exitSol,
		multiple: returnMultiple(pnlPct),
		headline: headline.primary,
		multipleLabel: headline.secondary,

		heldSeconds: secs,
		holdLabel,
		exitReason: row.exit_reason || null,
		exitLabel: exitReasonLabel(row.exit_reason),

		buyUrl,
		sellUrl,
		mintUrl: solscanToken(row.mint, network),
		agentUrl: `${origin}/trader/${encodeURIComponent(row.agent_id)}`,
		shareUrl: `${origin}/trade/${encodeURIComponent(row.id)}`,
		ogImageUrl: `${origin}/api/trade-og?id=${encodeURIComponent(row.id)}`,

		pnlSolStr,
		entrySolStr: entrySol != null ? fmtSol(entrySol, { sign: false }) : null,
		exitSolStr: exitSol != null ? fmtSol(exitSol, { sign: false }) : null,
	};

	model.title = buildTitle(model);
	model.description = buildDescription(model);
	model.shareText = buildShareText(model);
	return model;
}

/** Page + OG title. Leads with the outcome, names the agent, never hypes. */
export function buildTitle(m) {
	const result = m.pnlPct != null ? m.headline : 'Closed';
	const paper = m.paper ? ' (paper)' : '';
	return `${m.agentName} ${result} on $${m.symbol}${paper} · three.ws Arena`;
}

/** OG description. Every clause is a number that exists on the row. */
export function buildDescription(m) {
	const parts = [];
	if (m.paper) parts.push('Paper trade (simulate mode), not a live fill');
	if (m.entrySolStr && m.exitSolStr) parts.push(`${m.entrySolStr} in, ${m.exitSolStr} out`);
	else if (m.entrySolStr) parts.push(`${m.entrySolStr} in`);
	if (m.pnlSolStr) parts.push(`${m.pnlSolStr} realized`);
	if (m.holdLabel) parts.push(`held ${m.holdLabel}`);
	parts.push(m.exitLabel.toLowerCase());
	if (m.moonbag) parts.push('initials out, moon-bag still riding');
	parts.push(m.paper ? 'labeled paper, never counted as live' : 'every leg links to its on-chain transaction');
	return parts.join(' · ');
}

/**
 * The text pre-filled into an X post. Short, factual, no price call, no promise.
 * The link carries the proof, so the copy does not have to oversell.
 */
export function buildShareText(m) {
	const lead = m.paper
		? `${m.agentName} paper-traded $${m.symbol}`
		: `${m.agentName} traded $${m.symbol} on pump.fun`;
	const result = m.pnlPct != null ? `${m.headline}${m.multipleLabel ? ` (${m.multipleLabel})` : ''}` : 'closed';
	const held = m.holdLabel ? ` in ${m.holdLabel}` : '';
	const proof = m.paper ? 'Paper mode, labeled as such.' : 'On-chain, verifiable.';
	return `${lead}: ${result}${held}. ${proof}`;
}
