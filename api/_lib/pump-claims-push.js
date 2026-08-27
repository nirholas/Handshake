// @ts-check
// Automatic first-claim delivery to Telegram: every time a pump.fun creator
// pulls their accrued creator fees out of the fee vault for the FIRST time,
// that claim gets its own message. Driven by /api/cron/pump-claims-push on
// Cloud Scheduler.
//
// A first claim is an on-chain, irreversible signal that a creator is live and
// engaged with their coin, which is why it is worth its own channel rather
// than a line in the holder changelog. The scan itself lives in
// ./pump-claims.js and is shared with GET /api/pump/first-claims.
//
// Destination: TELEGRAM_PUMP_CLAIMS_CHAT_ID. There is deliberately NO fallback
// to the holder channel (TELEGRAM_CHANGELOG_CHAT_ID): this feed is high-volume
// third-party coin activity and holder-facing release notes are not the same
// audience. An unset chat id reports { skipped: 'not_configured' }.
//
// State (app_settings key `pump_claims_push_telegram`):
//   { lastTs: number|null, seen: string[] }
// `lastTs` is the block time of the newest claim posted; `seen` is a bounded
// ring of recently posted transaction signatures. Both are needed because the
// two failure modes are different:
//
//   1. Claims arriving inside the same second as the last posted one share
//      `lastTs`, so a timestamp cursor alone would drop them. `seen` catches
//      those exactly, by signature.
//   2. `seen` is bounded, so it cannot answer for a claim older than the ring.
//      `lastTs` bounds the query window so the ring never has to.
//
// On first run (no state) the lane seeds from the current scan WITHOUT posting,
// so enabling this feature never dumps a backlog of history into the channel.

import { sql } from './db.js';
import { scanFirstClaims } from './pump-claims.js';

import { fetchUpstream } from './upstream-fetch.js';
const TELEGRAM_LIMIT = 10; // per run; Bot API allows ~20 msg/min per chat
const TELEGRAM_PACE_MS = 3500;
// How far back each tick scans. The cron runs every 5 minutes, so a 30-minute
// window tolerates five consecutive missed ticks without losing a claim.
const SCAN_MINUTES = 30;
// Nothing older than this is ever posted, however far behind the state is. A
// catch-up drains a backlog; it must never replay history into the channel.
const CUTOFF_MINUTES = 180;
// Bounded at roughly the number of claims a very busy hour could produce, so
// the state row stays small while still covering the whole scan window.
const SEEN_LIMIT = 400;
const LOCK_KEY = 'pump_claims_push_lock';
const LOCK_TTL_S = 240;
const STATE_KEY = 'pump_claims_push_telegram';
// Bounded, and deliberately well under LOCK_TTL_S. The lock is what stops two
// ticks posting the same claim twice, but it only holds for its TTL: a request
// that hangs longer outlives its own lock and the next tick re-posts what the
// stalled one is still working through.
const TELEGRAM_TIMEOUT_MS = 20_000;

const LAMPORTS_PER_SOL = 1e9;

async function ensureTable() {
	await sql`
		CREATE TABLE IF NOT EXISTS app_settings (
			key text PRIMARY KEY,
			value jsonb NOT NULL,
			updated_at timestamptz NOT NULL DEFAULT now()
		)
	`;
}

async function getState(key) {
	const [row] = await sql`SELECT value FROM app_settings WHERE key = ${key}`;
	return row?.value ?? null;
}

async function setState(key, value) {
	await sql`
		INSERT INTO app_settings (key, value) VALUES (${key}, ${JSON.stringify(value)}::jsonb)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()
	`;
}

export async function acquireLock() {
	await ensureTable();
	const rows = await sql`
		INSERT INTO app_settings (key, value)
		VALUES (${LOCK_KEY}, jsonb_build_object('until', extract(epoch from now()) + ${LOCK_TTL_S}))
		ON CONFLICT (key) DO UPDATE
			SET value = excluded.value, updated_at = now()
			WHERE (app_settings.value->>'until')::numeric < extract(epoch from now())
		RETURNING key
	`;
	return rows.length > 0;
}

export async function releaseLock() {
	await setState(LOCK_KEY, { until: 0 });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Returns the claims to post, oldest-first, from a newest-first scan result.
 *
 * Selection is by signature against `seen` (exact) and by age against the
 * cutoff (so a long outage drains recent claims and drops stale ones rather
 * than replaying an hour of history). `lastTs` is not used to select: it only
 * bounds the scan window upstream, because a claim can share a second with the
 * last one posted and would be lost by a strictly-greater timestamp compare.
 *
 * @param {Array<{creator:string, mint:string, signature:string, lamports:number, ts:number}>} claims
 * @param {{ seen?: string[] }} state
 * @param {number} [nowMs]
 */
export function newClaimsSince(claims, state = {}, nowMs = Date.now()) {
	const seen = new Set(state.seen || []);
	const oldestPostableTs = Math.floor(nowMs / 1000) - CUTOFF_MINUTES * 60;
	return claims
		.filter((c) => c.signature && !seen.has(c.signature))
		.filter((c) => Number.isFinite(c.ts) && c.ts >= oldestPostableTs)
		.sort((a, b) => a.ts - b.ts);
}

/** Appends signatures to the bounded ring, newest kept. */
export function rememberSignatures(seen = [], signatures = []) {
	const merged = [...seen, ...signatures];
	return merged.slice(Math.max(0, merged.length - SEEN_LIMIT));
}

const escapeHtml = (s) =>
	String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);

/** Middle-truncates a base58 address so a message stays one line on mobile. */
export function shortAddress(addr) {
	const s = String(addr || '');
	return s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

/** Lamports rendered as SOL with a precision that stays readable at any size. */
export function formatSol(lamports) {
	const sol = Number(lamports || 0) / LAMPORTS_PER_SOL;
	if (!Number.isFinite(sol) || sol <= 0) return '0 SOL';
	if (sol < 0.001) return '<0.001 SOL';
	if (sol < 1) return `${sol.toFixed(3)} SOL`;
	if (sol < 1000) return `${sol.toFixed(2)} SOL`;
	return `${Math.round(sol).toLocaleString('en-US')} SOL`;
}

// Every field below is derived from on-chain data supplied by a third party.
// Addresses are base58 and cannot carry markup, but they are escaped anyway so
// a malformed scan result can never break out of the HTML entity structure and
// smuggle a clickable link posted under the platform bot's identity.
/**
 * @param {{creator:string, mint:string, signature:string, lamports:number, ts:number}} claim
 */
export function formatTelegramMessage(claim) {
	const when = Number.isFinite(claim.ts)
		? new Date(claim.ts * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
		: '';
	const lines = [
		'<b>First creator fee claim</b>',
		'',
		`Creator <code>${escapeHtml(claim.creator)}</code>`,
	];
	if (claim.mint) lines.push(`Coin <code>${escapeHtml(claim.mint)}</code>`);
	lines.push('', `Claimed ${escapeHtml(formatSol(claim.lamports))}`);

	const refs = [
		`<a href="https://solscan.io/tx/${encodeURIComponent(claim.signature)}">tx ${escapeHtml(shortAddress(claim.signature))}</a>`,
	];
	if (claim.mint) {
		refs.push(
			`<a href="https://pump.fun/coin/${encodeURIComponent(claim.mint)}">pump.fun</a>`,
		);
	}
	lines.push('', `${refs.join(' · ')}${when ? ` · ${escapeHtml(when)}` : ''}`);
	return lines.join('\n');
}

async function sendTelegram(botToken, chatId, text) {
	const res = await fetchUpstream(`https://api.telegram.org/bot${botToken}/sendMessage`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			chat_id: chatId,
			text,
			parse_mode: 'HTML',
			// The links are block explorers, not three.ws pages, and a preview
			// card per claim would bury the text in a high-volume feed.
			link_preview_options: { is_disabled: true },
		}),
		signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
	}, { name: 'telegram', timeoutMs: 10_000, attempts: 2, okWhen: () => true });
	const body = await res.json().catch(() => ({}));
	if (!res.ok || !body.ok) {
		throw new Error(
			`Telegram sendMessage failed (${res.status}): ${body.description || 'unknown error'}`,
		);
	}
}

export async function pushTelegramLane({ scan = scanFirstClaims, now = Date.now } = {}) {
	const botToken = process.env.TELEGRAM_BOT_TOKEN;
	const chatId = process.env.TELEGRAM_PUMP_CLAIMS_CHAT_ID;
	if (!botToken || !chatId) return { skipped: 'not_configured' };

	const nowMs = now();
	const state = (await getState(STATE_KEY)) || { lastTs: null, seen: [] };
	// A resumed lane re-scans from its cursor so a gap wider than one window
	// still resolves, bounded by the cutoff so it can never replay history.
	const windowStart = Math.floor(nowMs / 1000) - SCAN_MINUTES * 60;
	const cutoffStart = Math.floor(nowMs / 1000) - CUTOFF_MINUTES * 60;
	const sinceTs = state.lastTs
		? Math.max(cutoffStart, Math.min(windowStart, state.lastTs))
		: windowStart;

	const claims = await scan({ sinceTs, limit: 50 });

	if (!state.lastTs) {
		// Seed: record what is already on-chain so enabling the lane posts
		// nothing, then start posting from the next tick onward.
		await setState(STATE_KEY, {
			lastTs: claims.length ? Math.max(...claims.map((c) => c.ts)) : Math.floor(nowMs / 1000),
			seen: rememberSignatures([], claims.map((c) => c.signature)),
		});
		return { posted: 0, seeded: true, scanned: claims.length };
	}

	const pending = newClaimsSince(claims, state, nowMs);
	if (pending.length === 0) return { posted: 0, scanned: claims.length };

	// Oldest-first: a backlog larger than one run drains across the following
	// ticks in claim order. Taking the newest would strand everything older.
	const batch = pending.slice(0, TELEGRAM_LIMIT);
	const backlog = pending.length - batch.length;
	if (backlog > 0) {
		console.warn(
			`[pump-claims] ${backlog} claims still queued after this run; draining ${TELEGRAM_LIMIT}/tick`,
		);
	}

	let sent = 0;
	let { lastTs, seen } = state;
	try {
		for (const claim of batch) {
			await sendTelegram(botToken, chatId, formatTelegramMessage(claim));
			lastTs = Math.max(Number(lastTs) || 0, claim.ts);
			seen = rememberSignatures(seen, [claim.signature]);
			sent++;
			// Written per claim, not per run: a tick killed mid-batch (the Cloud
			// Run request deadline is shorter than a full paced run) resumes at
			// the next claim rather than repeating the ones already delivered.
			await setState(STATE_KEY, { lastTs, seen });
			await sleep(TELEGRAM_PACE_MS);
		}
	} catch (err) {
		return { posted: sent, backlog, error: String(err?.message || err) };
	}
	return { posted: sent, backlog, scanned: claims.length };
}
