// Oracle — conviction alerts via Telegram.
//
// When the oracle-score cron produces a high-conviction coin for the first
// time, this module fires a Telegram message to the signals channel. A coin
// qualifies by tier (prime ≥86 / strong ≥72, see ORACLE_ALERT_MIN_TIER) OR by
// raw score (ORACLE_FEED_MIN_SCORE, default 56 = the Lean floor). The score
// path exists because tier-only gating starved the channel: the live score
// distribution tops out in the low 60s, so a strong-only feed never posts.
// The channel is separate from the ops alerts (TELEGRAM_ALERTS_CHAT_ID)
// and the changelog channel (TELEGRAM_CHANGELOG_CHAT_ID) — holders subscribe to
// it for actionable pump.fun conviction signals.
//
// Env:
//   TELEGRAM_BOT_TOKEN            — same bot used across the platform
//   TELEGRAM_ORACLE_CHAT_ID       — signals channel (@handle or -100… numeric)
//   ORACLE_FEED_MIN_SCORE         — score floor for channel posts (default 56;
//                                   set 101 to disable the score path)
//
// Dedup: an in-memory Set of alerted mints per process restart, plus a DB flag
// (oracle_conviction.alerted_at) that persists across restarts so we never fire
// twice for the same coin even if the worker cold-starts.
//
// Fire-and-forget with a 4s abort — never delays the scoring loop.

import { sql } from '../db.js';

const ALERT_TIMEOUT_MS = 4000;
// Minimum tier to alert on. 'prime' only = exclusive. 'strong' = more volume.
const MIN_ALERT_TIER = process.env.ORACLE_ALERT_MIN_TIER || 'strong';
const TIER_ORDER = { prime: 3, strong: 2, lean: 1, watch: 0, avoid: -1 };
const MIN_TIER_RANK = TIER_ORDER[MIN_ALERT_TIER] ?? 2;

// Score floor for the channel feed. 56 is the Lean tier boundary
// (api/_lib/oracle/conviction.js TIERS) — the top slice of the real score
// distribution, roughly a dozen coins a day at current volume.
const FEED_MIN_SCORE = clampScore(process.env.ORACLE_FEED_MIN_SCORE, 56);

function clampScore(raw, fallback) {
	const n = Number(raw);
	return Number.isFinite(n) ? Math.max(0, Math.min(101, n)) : fallback;
}

/**
 * Whether a scored coin qualifies for the channel feed: by tier
 * (ORACLE_ALERT_MIN_TIER, default strong) OR by raw score
 * (ORACLE_FEED_MIN_SCORE, default 56). Exported for tests.
 */
export function feedEligible(coin) {
	const rank = TIER_ORDER[coin?.tier] ?? -1;
	const score = Number(coin?.score) || 0;
	return rank >= MIN_TIER_RANK || score >= FEED_MIN_SCORE;
}

// In-memory dedup for this process lifetime — prevents double-fire within the
// same worker even if alerted_at DB write is slow.
const _alerted = new Set();

// Personal signal dedup: map of "chatId:mint" → last alerted timestamp (ms).
// Prevents the 15-min cron window from firing the same personal signal 3×
// in a row. 1-hour cooldown per (subscriber, coin) pair.
const _personalSignalAt = new Map();
const PERSONAL_SIGNAL_COOLDOWN_MS = 60 * 60 * 1000;

const TIER_EMOJI = { prime: '🟣', strong: '🔵', lean: '🟡', watch: '⚪', avoid: '🔴' };

function tierEmoji(tier) { return TIER_EMOJI[tier] || '⚪'; }

function format(coin) {
	const emoji = tierEmoji(coin.tier);
	const pct = (n) => (n != null ? `${Math.round(Number(n))}` : '?');
	const pillars = coin.pillars
		? `Who ${pct(coin.pillars.pedigree)} · How ${pct(coin.pillars.structure)} · What ${pct(coin.pillars.narrative)} · Move ${pct(coin.pillars.momentum)}`
		: '';
	const category = coin.category ? ` · ${coin.category}` : '';
	const smart = coin.smart_wallet_count ? ` · ${coin.smart_wallet_count} smart in` : '';
	return [
		`${emoji} <b>${escHtml(coin.symbol || '—')}</b> <code>${coin.score}</code> conviction <i>${escHtml(coin.tier)}</i>`,
		escHtml(coin.name || ''),
		pillars ? `<i>${pillars}</i>` : '',
		`<code>${escHtml(coin.mint)}</code>`,
		`${category}${smart}`,
		`<a href="https://pump.fun/coin/${encodeURIComponent(coin.mint)}">pump.fun</a>  ·  <a href="https://three.ws/oracle/coin/${encodeURIComponent(coin.mint)}">Oracle</a>`,
	].filter(Boolean).join('\n');
}

function escHtml(s) {
	return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function send(text) {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	const chatId = process.env.TELEGRAM_ORACLE_CHAT_ID;
	if (!token || !chatId) return;

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), ALERT_TIMEOUT_MS);
	try {
		await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				chat_id: chatId,
				text: text.slice(0, 4000),
				parse_mode: 'HTML',
				disable_web_page_preview: true,
			}),
			signal: ctrl.signal,
		});
	} catch { /* fire-and-forget */ } finally {
		clearTimeout(timer);
	}
}

/**
 * Mark a coin as alerted in oracle_conviction so the flag survives restarts.
 * Best-effort — never throws into the alert path.
 */
async function markAlerted(mint, network) {
	try {
		await sql`
			update oracle_conviction set alerted_at = now()
			where mint = ${mint} and network = ${network} and alerted_at is null
		`;
	} catch { /* non-fatal */ }
}

/**
 * Fire a Telegram alert when an agent's open position resolves as a win.
 * Called by the settle-loop after grading.
 *
 * @param {Array<{agent_name:string, agent_id:string, symbol:string, mint:string, tier:string, conviction:number, mode:string, size_sol:number, realized_pnl_sol:number, peak_multiple:number, network:string}>} exits
 * @returns {Promise<number>} number of alerts sent
 */
export async function alertProfitableExit(exits) {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	const chatId = process.env.TELEGRAM_ORACLE_CHAT_ID;
	if (!token || !chatId || !exits?.length) return 0;

	let sent = 0;
	for (const e of exits) {
		// Only alert live-mode wins with positive PnL or a meaningful ATH.
		if (e.mode !== 'live' && e.mode !== 'simulate') continue;
		if ((e.realized_pnl_sol ?? 0) <= 0 && (e.peak_multiple ?? 0) < 2) continue;

		const pnlStr = e.realized_pnl_sol != null
			? `+${Number(e.realized_pnl_sol).toFixed(4)} SOL`
			: `${(e.peak_multiple ?? 0).toFixed(2)}× peak`;
		const peakStr = e.peak_multiple != null ? `${Number(e.peak_multiple).toFixed(2)}×` : '?';
		const sizeStr = e.size_sol != null ? `${Number(e.size_sol).toFixed(3)} SOL` : '?';
		const emoji = e.mode === 'simulate' ? '🤖 [sim]' : '🤖';
		const tierE = tierEmoji(e.tier);
		const agentName = escHtml(e.agent_name || e.agent_id || 'Agent');
		const sym = escHtml(e.symbol || '?');
		const modeLabel = e.mode === 'simulate' ? ' <i>(simulated)</i>' : '';

		const text = [
			`${emoji} <b>${agentName}</b> made <b>${escHtml(pnlStr)}</b> on <b>$${sym}</b>${modeLabel}`,
			`Peak: <b>${peakStr}</b>  ·  Size: ${escHtml(sizeStr)}  ·  Entry: ${tierE} ${escHtml(e.tier)} conviction (${e.conviction ?? '?'})`,
			`<a href="https://pump.fun/coin/${encodeURIComponent(e.mint)}">pump.fun</a>  ·  <a href="https://three.ws/oracle/coin/${encodeURIComponent(e.mint)}">Oracle</a>  ·  <a href="https://three.ws/agents/${encodeURIComponent(e.agent_id)}">Track record</a>`,
		].join('\n');

		await send(text);
		sent++;
	}
	return sent;
}

/**
 * Fire a Telegram alert the moment an agent makes a live oracle buy.
 * Called by the agent-loop after each filled action so followers can copy
 * before the coin moves.
 *
 * Only live-mode actions are alerted. Simulate actions generate too much
 * volume and carry no real cost.
 *
 * @param {Array<{agent_id:string, agent_name?:string, symbol:string, mint:string, tier:string, conviction:number, size_sol:number, network:string}>} entries
 * @returns {Promise<number>} number of alerts sent
 */
export async function alertAgentEntry(entries) {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	const chatId = process.env.TELEGRAM_ORACLE_CHAT_ID;
	if (!token || !chatId || !entries?.length) return 0;

	let sent = 0;
	for (const e of entries) {
		const tierE = tierEmoji(e.tier);
		const agentName = escHtml(e.agent_name || 'Agent');
		const sym = escHtml((e.symbol || e.mint.slice(0, 6)).toUpperCase());
		const sizeStr = e.size_sol != null ? `${Number(e.size_sol).toFixed(3)} SOL` : '?';
		const convStr = e.conviction != null ? ` (${e.conviction})` : '';

		const text = [
			`${tierE} <b>${agentName}</b> entered <b>$${sym}</b>`,
			`${escHtml(e.tier)} conviction${convStr}  ·  ${escHtml(sizeStr)}`,
			`<a href="https://pump.fun/coin/${encodeURIComponent(e.mint)}">pump.fun</a>  ·  <a href="https://three.ws/oracle/coin/${encodeURIComponent(e.mint)}">Oracle ↗</a>  ·  <a href="https://three.ws/trader/${encodeURIComponent(e.agent_id)}">Copy trades →</a>`,
		].join('\n');

		await send(text);
		sent++;
	}
	return sent;
}

/**
 * Fire alerts for newly-scored coins that cross the tier threshold for the
 * first time. Called by the oracle-score cron after each score pass.
 *
 * @param {Array<{mint:string, symbol:string, name:string, score:number, tier:string, pillars?:object, category?:string, smart_wallet_count?:number}>} coins
 * @param {string} network
 * @returns {Promise<number>} number of alerts sent
 */
export async function alertNewHighConviction(coins, network = 'mainnet') {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	const chatId = process.env.TELEGRAM_ORACLE_CHAT_ID;
	if (!token || !chatId) return 0; // silently no-op when not configured

	// Filter to coins that qualify (by tier OR by raw score) and haven't been
	// alerted. The score path keeps the feed alive at the top of the real
	// distribution even while no coin reaches the strong/prime tiers.
	const candidates = coins.filter((c) => feedEligible(c) && !_alerted.has(c.mint));
	if (!candidates.length) return 0;

	// Check the DB to skip any already-alerted mints (across restarts).
	const mints = candidates.map((c) => c.mint);
	let alreadyAlerted = new Set();
	try {
		const rows = await sql`
			select mint from oracle_conviction
			where mint = any(${mints}::text[]) and network = ${network} and alerted_at is not null
		`;
		alreadyAlerted = new Set(rows.map((r) => r.mint));
	} catch { /* treat as empty on DB error */ }

	let sent = 0;
	for (const coin of candidates) {
		if (alreadyAlerted.has(coin.mint)) { _alerted.add(coin.mint); continue; }
		_alerted.add(coin.mint);
		await send(format(coin));
		await markAlerted(coin.mint, network);
		sent++;
	}
	return sent;
}

/**
 * Send a personal entry alert directly to one subscriber's Telegram chat.
 * Called by the agent-loop for every watch that has a telegram_chat_id, whether
 * simulate or live (marked clearly in the message).
 *
 * @param {string} chatId
 * @param {{agent_name?:string, symbol:string, mint:string, tier:string, conviction:number, size_sol:number, mode:string, network:string}} entry
 * @returns {Promise<void>}
 */
export async function alertPersonalEntry(chatId, entry) {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	if (!token || !chatId) return;

	const tierE = tierEmoji(entry.tier);
	const sym = escHtml((entry.symbol || entry.mint.slice(0, 6)).toUpperCase());
	const sizeStr = entry.size_sol != null ? `${Number(entry.size_sol).toFixed(3)} SOL` : '?';
	const convStr = entry.conviction != null ? ` (score ${entry.conviction})` : '';
	const modeLabel = entry.mode === 'simulate' ? ' <i>[simulated]</i>' : '';
	const agentName = escHtml(entry.agent_name || 'Your agent');

	const text = [
		`${tierE} <b>${agentName}</b> entered <b>$${sym}</b>${modeLabel}`,
		`${escHtml(entry.tier)} conviction${convStr}  ·  ${escHtml(sizeStr)}`,
		`<a href="https://pump.fun/coin/${encodeURIComponent(entry.mint)}">pump.fun</a>  ·  <a href="https://three.ws/oracle/coin/${encodeURIComponent(entry.mint)}">Oracle ↗</a>`,
	].join('\n');

	await sendTo(chatId, text);
}

/**
 * Send a personal conviction signal to one subscriber when a coin crosses their
 * agent's min_score threshold. Only fires for coins the platform hasn't already
 * alerted in this run — the platform channel gets one alert per coin, but the
 * personal alert fires for every subscriber whose threshold the coin crosses.
 *
 * @param {string} chatId
 * @param {object} coin  oracle_conviction row (score, tier, symbol, mint, pillars, …)
 * @param {number} minScore  subscriber's personal threshold
 * @returns {Promise<void>}
 */
export async function alertPersonalSignal(chatId, coin, minScore) {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	if (!token || !chatId) return;
	if ((Number(coin.score) || 0) < minScore) return;

	const dedupKey = `${chatId}:${coin.mint}`;
	const last = _personalSignalAt.get(dedupKey) || 0;
	if (Date.now() - last < PERSONAL_SIGNAL_COOLDOWN_MS) return;
	_personalSignalAt.set(dedupKey, Date.now());

	const text = format(coin) + `\n<i>Your agent threshold: ${minScore}</i>`;
	await sendTo(chatId, text);
}

/**
 * Fire a personal conviction-drop warning when a coin's score falls
 * significantly below the subscriber's entry conviction AND below their
 * min_score threshold. Signals that the thesis for an open position is
 * weakening — the subscriber should reassess.
 *
 * @param {string} chatId
 * @param {{ symbol:string, mint:string, newScore:number, newTier:string, entryScore:number, minScore:number }} drop
 */
export async function alertPersonalConvictionDrop(chatId, drop) {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	if (!token || !chatId) return;

	const sym     = escHtml((drop.symbol || drop.mint.slice(0, 6)).toUpperCase());
	const newTier = escHtml(drop.newTier || 'unknown');
	const emoji   = TIER_EMOJI[drop.newTier] || '⚪';
	const delta   = Math.round(drop.entryScore - drop.newScore);
	const mintLink = encodeURIComponent(drop.mint);

	const text = [
		`⚠️ <b>$${sym}</b> conviction weakened`,
		`${emoji} ${newTier} · score <b>${drop.newScore}</b>  (was ${drop.entryScore} at entry,  −${delta} pts)`,
		`Below your threshold of ${drop.minScore} — consider reviewing your position.`,
		`<a href="https://pump.fun/coin/${mintLink}">pump.fun</a>  ·  <a href="https://three.ws/oracle/coin/${mintLink}">Oracle ↗</a>`,
	].join('\n');

	await sendTo(chatId, text);
}

/**
 * Fan-out entry alert to all Telegram subscribers of a given agent.
 * Called by the agent-loop after every filled action (simulate or live).
 * Each follower only receives the alert if the coin's score meets their
 * personal min_score threshold.
 *
 * @param {string} agentId       UUID of the agent that acted
 * @param {{ symbol:string, mint:string, tier:string, score:number, size_sol?:number, mode:string, network:string }} entry
 * @returns {Promise<number>} followers alerted
 */
export async function alertFollowers(agentId, entry) {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	if (!token || !agentId) return 0;

	const network = entry.network || 'mainnet';
	const score   = Number(entry.score) || 0;

	const rows = await sql`
		select f.chat_id
		from oracle_followers f
		where f.agent_id = ${agentId}
		  and f.network  = ${network}
		  and f.min_score <= ${score}
	`.catch(() => []);
	if (!rows.length) return 0;

	const tierE  = tierEmoji(entry.tier);
	const sym    = escHtml((entry.symbol || entry.mint.slice(0, 6)).toUpperCase());
	const sizeStr = entry.size_sol != null ? `${Number(entry.size_sol).toFixed(3)} SOL` : '?';
	const modeLabel = entry.mode === 'simulate' ? ' <i>[sim]</i>' : '';

	const text = [
		`${tierE} Followed agent entered <b>$${sym}</b>${modeLabel}`,
		`${escHtml(entry.tier)} conviction (${score})  ·  ${escHtml(sizeStr)}`,
		`<a href="https://pump.fun/coin/${encodeURIComponent(entry.mint)}">pump.fun</a>  ·  <a href="https://three.ws/oracle/coin/${encodeURIComponent(entry.mint)}">Oracle ↗</a>`,
	].join('\n');

	let sent = 0;
	for (const { chat_id } of rows) {
		sendTo(chat_id, text).catch(() => {});
		sent++;
	}
	return sent;
}

/** Send to a specific chat ID (not the platform channel). */
async function sendTo(chatId, text) {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	if (!token) return;

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), ALERT_TIMEOUT_MS);
	try {
		await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				chat_id: chatId,
				text: text.slice(0, 4000),
				parse_mode: 'HTML',
				disable_web_page_preview: true,
			}),
			signal: ctrl.signal,
		});
	} catch { /* fire-and-forget */ } finally {
		clearTimeout(timer);
	}
}
