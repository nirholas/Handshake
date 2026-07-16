// Clip Director, the content engine (pumpfun-trading-wedge §2.2 / §4.4).
// ---------------------------------------------------------------------------
// "We're a media company that happens to trade." Every notable close emits a
// piece of content: a ticker, a multiple, an avatar reaction, and a REASON. This
// module turns ONE real closed trade into the optimal shareable artifact per
// surface (X / Telegram / in-app Feed), the acquisition channel, not a nicety.
//
// It never invents a number: every stat traces to the closed round-trip it was
// handed. Losses get an honest card too (downside-transparency is the brand),
// never hidden. The LLM (free-first llmComplete chain) writes the copy; a
// deterministic director produces the same-shaped artifact when no provider is
// available, so the engine never fails.
//
// The avatar_gesture resolves to a REAL animation clip in the manifest so the
// arena / trader avatar can actually perform the reaction, not just label it.

import { llmComplete, llmConfigured, LlmUnavailableError } from './llm.js';
import { extractJson } from './bounty-judge.js';

export const SURFACES = new Set(['x', 'telegram', 'feed']);

// §4.4 gesture vocabulary -> a real playable clip in public/animations/manifest.json.
// "sweat" has no dedicated clip; the honest loss reaction is `defeated`.
const GESTURE_CLIP = {
	celebrate: 'celebrate',
	point: 'point',
	wave: 'wave',
	shrug: 'shrug',
	sweat: 'defeated',
};
const GESTURES = Object.keys(GESTURE_CLIP);

const round2 = (x) => Math.round(x * 100) / 100;

const SYSTEM_PROMPT = `You turn ONE closed trade into the optimal shareable artifact for one surface. You are a content director, not a trader. Truthful, human, no hype, no price predictions.

Output STRICT JSON only, no prose, no code fence:
{ "hook": "<=80 chars, the scroll-stopping first line, true",
  "feature_stat": "the single most compelling REAL number to headline",
  "avatar_gesture": "celebrate|shrug|sweat|point|wave",
  "body": "1-2 lines: what happened + why, plain language",
  "cta": "fork-this-trade|copy-the-agent|view-track-record",
  "alt_text": "accessibility description of the card" }

Rules: feature the real number. If the trade was a LOSS, still produce an honest card (brand = transparency) with a 'live to trade again' tone. Tune length/voice to the surface (X punchier, Telegram chattier, Feed mid). Reference no token other than the traded one or $THREE. Always keep a verifiable angle (the record is on-chain). Never invent numbers not present in the input.`;

// Build the compact, real trade view the director reasons over. Accepts a raw
// agent_sniper_positions row (or an equivalent object) and derives only from
// present fields, hold time, multiple, realized P&L, never fabricating mcap.
export function tradeFromPosition(pos) {
	const LAMPORTS = 1e9;
	const lam = (v) => (v == null ? null : Number(v) / LAMPORTS);
	const entrySol = lam(pos.entry_quote_lamports);
	const exitSol = lam(pos.exit_quote_lamports);
	const pnlSol = lam(pos.realized_pnl_lamports);
	const multiple = entrySol && exitSol != null && entrySol > 0 ? round2(exitSol / entrySol) : null;
	const pnlPct = pos.realized_pnl_pct != null ? round2(Number(pos.realized_pnl_pct)) : null;
	let holdMin = null;
	if (pos.opened_at && pos.closed_at) {
		holdMin = Math.max(0, Math.round((new Date(pos.closed_at) - new Date(pos.opened_at)) / 60000));
	}
	return {
		mint: pos.mint,
		symbol: pos.symbol || null,
		name: pos.name || null,
		multiple,
		pnl_pct: pnlPct,
		entry_sol: entrySol == null ? null : round2(entrySol),
		exit_sol: exitSol == null ? null : round2(exitSol),
		realized_pnl_sol: pnlSol == null ? null : round2(pnlSol),
		hold_min: holdMin,
		exit_reason: pos.exit_reason || null,
		quote_symbol: 'SOL',
		is_win: pnlSol != null ? pnlSol >= 0 : (pnlPct != null ? pnlPct >= 0 : null),
		sell_sig: pos.sell_sig || null,
	};
}

export async function directClip({ agentName, avatarStyle = null, trade, copiedByCount = 0, surface = 'feed', userId = null } = {}) {
	const surf = SURFACES.has(surface) ? surface : 'feed';
	let artifact = null;
	let source = 'deterministic';

	if (llmConfigured()) {
		try {
			artifact = await llmClip({ agentName, avatarStyle, trade, copiedByCount, surface: surf, userId });
			if (artifact) source = 'llm';
		} catch (err) {
			if (!(err instanceof LlmUnavailableError)) artifact = null;
		}
	}
	if (!artifact) artifact = deterministicClip({ agentName, trade, copiedByCount, surface: surf });

	return finalize({ artifact, source, trade, surface: surf });
}

async function llmClip({ agentName, avatarStyle, trade, copiedByCount, surface, userId }) {
	const input = {
		agent_name: agentName || 'the agent',
		avatar_style: avatarStyle || 'default',
		trade: {
			symbol: trade.symbol || trade.name || trade.mint?.slice(0, 6),
			multiple: trade.multiple,
			pnl_pct: trade.pnl_pct,
			entry_sol: trade.entry_sol,
			exit_sol: trade.exit_sol,
			hold_min: trade.hold_min,
			exit_reason: trade.exit_reason,
			realized_pnl_quote: trade.realized_pnl_sol,
			quote_symbol: trade.quote_symbol,
			is_win: trade.is_win,
		},
		copied_by_count: copiedByCount,
		surface,
	};
	const out = await llmComplete({
		system: SYSTEM_PROMPT,
		user: JSON.stringify(input),
		maxTokens: 600,
		timeoutMs: 25_000,
		track: userId ? { userId, tool: 'clip-director' } : null,
	});
	const parsed = extractJson(out?.text);
	if (!parsed || typeof parsed.hook !== 'string') return null;
	return parsed;
}

// Deterministic director, honest, surface-tuned copy from the real numbers.
function deterministicClip({ agentName, trade, copiedByCount, surface }) {
	const sym = trade.symbol || trade.name || (trade.mint ? `$${trade.mint.slice(0, 4).toUpperCase()}` : 'the coin');
	const ticker = sym.startsWith('$') ? sym : `$${sym}`;
	const win = trade.is_win !== false;
	const mult = trade.multiple != null ? `${trade.multiple}x` : null;
	const pnl = trade.realized_pnl_sol != null ? `${trade.realized_pnl_sol > 0 ? '+' : ''}${trade.realized_pnl_sol} SOL` : null;
	const hold = trade.hold_min != null ? holdLabel(trade.hold_min) : null;
	const featureStat = mult || pnl || (trade.pnl_pct != null ? `${trade.pnl_pct}%` : 'closed on-chain');

	let hook;
	let body;
	let gesture;
	if (win) {
		gesture = trade.multiple != null && trade.multiple >= 2 ? 'celebrate' : 'point';
		hook = surface === 'x'
			? `${ticker} closed ${featureStat}${hold ? ` in ${hold}` : ''}. On-chain, no screenshots.`
			: `${agentName || 'The agent'} closed ${ticker} for ${featureStat}${hold ? ` after ${hold}` : ''}.`;
		body = `${trimReason(trade.exit_reason)} Every number is a real closed round-trip you can verify on-chain.`;
	} else {
		gesture = 'sweat';
		hook = surface === 'x'
			? `${ticker} stopped out ${pnl || featureStat}. We show the losers too.`
			: `${agentName || 'The agent'} took a loss on ${ticker}: ${pnl || featureStat}. Shown, not hidden.`;
		body = `${trimReason(trade.exit_reason)} Live to trade again. Every trade is on the record, wins and losses.`;
	}
	if (copiedByCount > 0) body += ` Copied by ${copiedByCount}.`;

	return {
		hook,
		feature_stat: featureStat,
		avatar_gesture: gesture,
		body: surface === 'telegram' ? `${body} Fork it from the room and ride the next one.` : body,
		cta: win ? 'copy-the-agent' : 'view-track-record',
		alt_text: `${agentName || 'A three.ws agent'} ${win ? 'closed a winning' : 'closed a losing'} trade on ${ticker}: ${featureStat}${hold ? `, held ${hold}` : ''}. Verifiable on-chain.`,
	};
}

function holdLabel(min) {
	if (min < 60) return `${min}m`;
	if (min < 1440) return `${Math.round(min / 60)}h`;
	return `${Math.round(min / 1440)}d`;
}
function trimReason(reason) {
	const map = {
		take_profit: 'Took profit at target.',
		stop_loss: 'Stopped out at the risk line.',
		trailing_stop: 'Trailing stop locked the gain.',
		timeout: 'Closed on the time exit.',
		manual: 'Closed the position by hand.',
		graduated: 'Rode it through graduation.',
		kill_switch: 'Kill-switch closed it.',
		error: 'Closed after an execution hiccup.',
	};
	return map[reason] || 'Position closed.';
}

const VALID_CTA = new Set(['fork-this-trade', 'copy-the-agent', 'view-track-record']);

function finalize({ artifact, source, trade, surface }) {
	const gesture = GESTURES.includes(artifact.avatar_gesture) ? artifact.avatar_gesture : (trade.is_win === false ? 'sweat' : 'celebrate');
	const cta = VALID_CTA.has(artifact.cta) ? artifact.cta : (trade.is_win === false ? 'view-track-record' : 'copy-the-agent');
	return {
		source,
		surface,
		hook: String(artifact.hook || '').slice(0, 120).trim(),
		feature_stat: String(artifact.feature_stat || '').slice(0, 60).trim(),
		avatar_gesture: gesture,
		gesture_clip: GESTURE_CLIP[gesture],
		body: String(artifact.body || '').slice(0, 320).trim(),
		cta,
		alt_text: String(artifact.alt_text || '').slice(0, 300).trim(),
		verifiable: true,
		trade,
	};
}
