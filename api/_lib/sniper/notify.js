// Sniper trade notifications — Telegram.
//
// Fires when the agent-sniper worker opens or closes a position. Uses
// TELEGRAM_SNIPER_CHAT_ID if set (a dedicated sniper alerts channel), falling
// back to TELEGRAM_ALERTS_CHAT_ID (the general ops channel). Either way it's
// fire-and-forget with a 3s abort — never delays the trade path.
//
// Env:
//   TELEGRAM_BOT_TOKEN          — shared bot (same as oracle/alerts)
//   TELEGRAM_SNIPER_CHAT_ID     — dedicated sniper notifications channel (preferred)
//   TELEGRAM_ALERTS_CHAT_ID     — ops fallback if the dedicated channel is absent

import { fetchUpstream } from '../upstream-fetch.js';

const TIMEOUT_MS = 5000;

function defaultChatId() {
	return process.env.TELEGRAM_SNIPER_CHAT_ID || process.env.TELEGRAM_ALERTS_CHAT_ID || null;
}

function send(text, chatIdOverride) {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	const id = chatIdOverride || defaultChatId();
	if (!token || !id) return;
	// Still fire-and-forget so it never delays the trade path, but a single
	// dropped packet no longer loses the notification silently: fetchUpstream
	// retries a transient failure and honours Retry-After, and a final failure
	// is logged instead of swallowed.
	fetchUpstream(
		`https://api.telegram.org/bot${token}/sendMessage`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				chat_id: id,
				text: text.slice(0, 4000),
				disable_web_page_preview: true,
			}),
			keepalive: true,
		},
		{ name: 'telegram:sniper', timeoutMs: TIMEOUT_MS, attempts: 2 },
	).catch((err) => {
		console.warn(`[sniper-notify] telegram delivery failed after retries: ${err?.message || err}`);
	});
}

const n2 = (v) => (v != null ? Number(v).toFixed(4) : '—');
const pct = (v) => (v != null ? `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(1)}%` : '—');
const icon = (r) => ({ take_profit: '✅', trailing_stop: '✅', stop_loss: '🛑', timeout: '⏱', kill_switch: '☠️', graduated: '🎓' }[r] || '📤');

/**
 * Notify when the sniper opens a position (buy confirmed).
 * chatId overrides the default ops channel — used for per-strategy personal alerts.
 */
export function notifyBuy({ agentName, symbol, mint, solSpent, mode, sig, chatId }) {
	const modeTag = mode === 'live' ? '' : ' [sim]';
	const pumpLink = mint ? `https://pump.fun/coin/${mint}` : null;
	const solLink = sig && sig !== 'SIMULATED' ? `https://solscan.io/tx/${sig}` : null;
	const lines = [
		`🎯 Sniper BUY${modeTag}`,
		`Agent: ${agentName || 'unknown'}`,
		`Coin:  ${symbol || '?'}`,
		`Size:  ${n2(solSpent)} SOL`,
	];
	if (pumpLink) lines.push(`pump.fun: ${pumpLink}`);
	if (solLink) lines.push(`tx: ${solLink}`);
	send(lines.join('\n'), chatId || null);
}

/**
 * Notify when the sniper closes a position (sell confirmed or failed).
 * chatId overrides the default ops channel — used for per-strategy personal alerts.
 */
export function notifySell({ agentName, symbol, mint, pnlSol, pnlPct, exitReason, mode, sig, chatId }) {
	const modeTag = mode === 'live' ? '' : ' [sim]';
	const solLink = sig && sig !== 'SIMULATED' ? `https://solscan.io/tx/${sig}` : null;
	const pumpLink = mint ? `https://pump.fun/coin/${mint}` : null;
	const lines = [
		`${icon(exitReason)} Sniper SELL${modeTag}  (${exitReason || 'exit'})`,
		`Agent: ${agentName || 'unknown'}`,
		`Coin:  ${symbol || '?'}`,
		`PnL:   ${n2(pnlSol)} SOL  ${pct(pnlPct)}`,
	];
	if (pumpLink) lines.push(`pump.fun: ${pumpLink}`);
	if (solLink) lines.push(`tx: ${solLink}`);
	send(lines.join('\n'), chatId || null);
}
