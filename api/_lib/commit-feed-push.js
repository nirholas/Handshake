// @ts-check
// Automatic commit-feed delivery to Telegram: every commit that lands on
// `main` gets its own message, independent of (and much noisier than) the
// curated holder changelog in changelog-push.js. Driven by
// /api/cron/commit-feed-push on Cloud Scheduler.
//
// State (app_settings key `commit_feed_push_telegram`):
//   { lastSha: string|null }
// The cron walks GitHub's commit list for `main`, finds lastSha, and posts
// everything newer, oldest-first, so message order matches commit order.
// On first run (no state yet) it seeds lastSha from the newest commit
// without posting anything, so deploying this feature never dumps repo
// history into the channel.

import { sql } from './db.js';

const REPO = 'nirholas/three.ws';
const TELEGRAM_LIMIT = 15; // per run; Bot API allows ~20 msg/min per chat
const TELEGRAM_PACE_MS = 3500;
const LOCK_KEY = 'commit_feed_push_lock';
const LOCK_TTL_S = 240;
const STATE_KEY = 'commit_feed_push_telegram';

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

async function fetchRecentCommits() {
	const headers = { accept: 'application/vnd.github+json', 'user-agent': 'three.ws-commit-feed' };
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
	if (token) headers.authorization = `Bearer ${token}`;
	const res = await fetch(`https://api.github.com/repos/${REPO}/commits?sha=main&per_page=30`, { headers });
	if (!res.ok) throw new Error(`GitHub commits fetch failed (${res.status})`);
	return res.json();
}

// Returns commits newer than `lastSha`, oldest-first. If lastSha is absent
// from the fetched page (unset, or more than 30 commits stale), returns []
// and lets the caller reseed from the newest commit instead of flooding the
// channel with backlog.
function newCommitsSince(commits, lastSha) {
	if (!lastSha) return { commits: [], reseed: true };
	const idx = commits.findIndex((c) => c.sha === lastSha);
	if (idx === -1) return { commits: [], reseed: true };
	return { commits: commits.slice(0, idx).reverse(), reseed: false };
}

const escapeHtml = (s) =>
	String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);

// Most commit subjects in this repo follow a loose "scope: description"
// convention ("agent-sniper: stop LLM judge calls…", "docs: cover ASL
// fingerspelling…"). Split on the first colon when it looks like that
// convention so the scope reads as a small headline and the rest as the
// body, matching the changelog message's headline/body/footer shape.
// Subjects without that convention fall back to a generic headline with the
// full subject as the body.
function splitSubject(subjectLine) {
	const idx = subjectLine.indexOf(': ');
	if (idx > 0 && idx < 60) {
		return { headline: subjectLine.slice(0, idx), body: subjectLine.slice(idx + 2) };
	}
	return { headline: 'New commit', body: subjectLine };
}

export function formatTelegramMessage(commit) {
	const shortSha = commit.sha.slice(0, 7);
	const subjectLine = (commit.commit?.message || '').split('\n')[0];
	const { headline, body } = splitSubject(subjectLine);
	const author = commit.author?.login || commit.commit?.author?.name || 'unknown';
	const date = (commit.commit?.author?.date || '').slice(0, 10);
	const url = commit.html_url || `https://github.com/${REPO}/commit/${commit.sha}`;
	const linkText = `github.com/${REPO}/commit/${shortSha}`;
	return [
		`<b>${escapeHtml(headline)}</b>`,
		'',
		escapeHtml(body),
		'',
		`<a href="${url}">${escapeHtml(linkText)}</a> · ${escapeHtml(date)} · ${escapeHtml(author)}`,
	].join('\n');
}

async function sendTelegram(botToken, chatId, text) {
	const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			chat_id: chatId,
			text,
			parse_mode: 'HTML',
			link_preview_options: { is_disabled: true },
		}),
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok || !body.ok) {
		throw new Error(`Telegram sendMessage failed (${res.status}): ${body.description || 'unknown error'}`);
	}
}

export async function pushTelegramLane() {
	const botToken = process.env.TELEGRAM_BOT_TOKEN;
	const chatId = process.env.TELEGRAM_COMMITS_CHAT_ID || process.env.TELEGRAM_CHANGELOG_CHAT_ID;
	if (!botToken || !chatId) return { skipped: 'not_configured' };

	const state = (await getState(STATE_KEY)) || { lastSha: null };
	const commits = await fetchRecentCommits();
	if (commits.length === 0) return { posted: 0 };

	const { commits: pending, reseed } = newCommitsSince(commits, state.lastSha);
	if (reseed) {
		await setState(STATE_KEY, { lastSha: commits[0].sha });
		return { posted: 0, seeded: true };
	}
	if (pending.length === 0) return { posted: 0 };

	const capped = pending.slice(-TELEGRAM_LIMIT);
	const dropped = pending.length - capped.length;

	let sent = 0;
	let lastSha = state.lastSha;
	try {
		for (const commit of capped) {
			await sendTelegram(botToken, chatId, formatTelegramMessage(commit));
			lastSha = commit.sha;
			sent++;
			await setState(STATE_KEY, { lastSha });
			await sleep(TELEGRAM_PACE_MS);
		}
	} catch (err) {
		return { posted: sent, dropped, error: String(err?.message || err) };
	}
	return { posted: sent, dropped };
}
