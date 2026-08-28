// @ts-check
// Automatic commit-feed delivery to Telegram: every commit that lands on
// `main` gets its own message, independent of (and much noisier than) the
// curated holder changelog in changelog-push.js. Driven by
// /api/cron/commit-feed-push on Cloud Scheduler.
//
// State (app_settings key `commit_feed_push_telegram`):
//   { lastSha: string|null, lastDate: string|null }
// The cron walks GitHub's commit list for `main`, finds lastSha, and posts
// everything newer, oldest-first, so message order matches commit order.
// On first run (no state yet) it seeds lastSha from the newest commit
// without posting anything, so deploying this feature never dumps repo
// history into the channel.
//
// Two properties keep the feed honest on a repo that commits in bursts of
// 20-30 at a time (which this one does, several times a day):
//
//   1. The commit list is PAGINATED until lastSha is found, not capped at a
//      single page. With one page, any gap wider than that page (a burst, or
//      a few missed ticks) put lastSha out of view, and the lane then reseeded
//      to HEAD and dropped every commit in between without a trace. On
//      2026-08-14 that stranded 117 commits: the feed went quiet at 06:45 UTC
//      and could not have recovered on its own.
//   2. The per-run cap posts the OLDEST pending commits, not the newest, and
//      advances state one commit at a time. A backlog bigger than one run
//      therefore drains in commit order over the following ticks instead of
//      being skipped.
//
// `lastDate` is the fallback ordering key for the case pagination still can't
// cover (state older than the whole lookback window): selection falls back to
// "committed after lastDate", so the lane resyncs without either duplicating
// or silently skipping. CUTOFF_DAYS bounds any catch-up, so a reset can never
// flood the channel with history.

import { sql } from './db.js';

import { fetchUpstream } from './upstream-fetch.js';
import { classify, headline, parseCommit, summaryLine } from '../../packages/shipfeed/src/index.js';
const REPO = 'nirholas/three.ws';
const BASE = 'https://three.ws';
const TELEGRAM_LIMIT = 15; // per run; Bot API allows ~20 msg/min per chat
const PER_PAGE = 100; // GitHub's maximum for /commits
// Five pages = 500 commits of catch-up. Comfortably covers a day of this
// repo's output, so a lane that stalls for a full day still resumes exactly
// where it left off. A normal tick finds lastSha on page 1 and stops there,
// so the steady-state cost stays one GitHub request per run.
const MAX_LOOKBACK_PAGES = 5;
// Nothing older than this is ever posted, however far behind the state is.
// A catch-up drains a backlog; it must never replay history.
const CUTOFF_DAYS = 3;
const TELEGRAM_PACE_MS = 3500;
const LOCK_KEY = 'commit_feed_push_lock';
const LOCK_TTL_S = 240;
const STATE_KEY = 'commit_feed_push_telegram';
// Parts of the product a reader has actually seen. Naming them lifts a commit
// in one of them above the machinery around it when the lane scores what is
// worth posting; everything unnamed is still scored on its own merits.
const PRODUCT_SCOPES = [
	'agent',
	'agents',
	'avatar',
	'avatars',
	'chat',
	'companion',
	'crews',
	'discover',
	'embed',
	'embeds',
	'forge',
	'launch',
	'marketplace',
	'oracle',
	'payments',
	'pump',
	'seeker',
	'studio',
	'viewer',
	'wallet',
	'x402',
];
// Every outbound call is bounded, and deliberately well under LOCK_TTL_S. The
// lock is what stops two ticks posting the same commit twice, but it only holds
// for its TTL: a request that hangs longer than that outlives its own lock, and
// the next tick (this cron runs every 5 minutes, i.e. 300s > 240s) acquires it
// and re-posts commits the stalled tick is still working through. Bounding the
// requests is what keeps the lock's guarantee true.
const GITHUB_TIMEOUT_MS = 20_000;
const TELEGRAM_TIMEOUT_MS = 20_000;

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

async function fetchCommitPage(page) {
	const headers = { accept: 'application/vnd.github+json', 'user-agent': 'three.ws-commit-feed' };
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
	if (token) headers.authorization = `Bearer ${token}`;
	const url = `https://api.github.com/repos/${REPO}/commits?sha=main&per_page=${PER_PAGE}&page=${page}`;
	const res = await fetch(url, { headers, signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) });
	if (!res.ok) {
		// An exhausted rate limit and a broken request both surface as 403.
		// Name the difference: unauthenticated GitHub allows 60 requests/hour
		// per egress IP, which a shared Cloud Run address can burn through
		// without this cron doing anything wrong.
		if (res.headers.get('x-ratelimit-remaining') === '0') {
			const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
			const until = Number.isFinite(reset) ? new Date(reset).toISOString() : 'unknown';
			throw new Error(
				`GitHub rate limit exhausted (resets ${until}); set GITHUB_TOKEN to raise it above 60/hour`,
			);
		}
		throw new Error(`GitHub commits fetch failed (${res.status})`);
	}
	return res.json();
}

// The ordering key GitHub itself sorts /commits by. Author date survives a
// rebase unchanged and can therefore run backwards through the list, so it is
// only the fallback.
export function commitDate(commit) {
	return commit?.commit?.committer?.date || commit?.commit?.author?.date || '';
}

// Walks back through the commit list until `lastSha` is in hand, so a gap
// wider than one page still resolves to an exact resume point. Stops early on
// the first page that has fallen past the cutoff (nothing older is postable
// anyway) and on a short page (end of history).
export async function fetchCommitsSince(lastSha, { getPage = fetchCommitPage, now = Date.now() } = {}) {
	const oldestPostable = now - CUTOFF_DAYS * 86_400_000;
	const commits = [];
	for (let page = 1; page <= MAX_LOOKBACK_PAGES; page++) {
		const batch = await getPage(page);
		if (!Array.isArray(batch) || batch.length === 0) break;
		commits.push(...batch);
		if (!lastSha) break; // first run seeds from HEAD; one page is plenty
		if (batch.some((c) => c.sha === lastSha)) return { commits, found: true };
		if (batch.length < PER_PAGE) break;
		const oldest = Date.parse(commitDate(batch[batch.length - 1]));
		if (Number.isFinite(oldest) && oldest < oldestPostable) break;
	}
	return { commits, found: lastSha ? commits.some((c) => c.sha === lastSha) : false };
}

// Returns the commits to post, oldest-first, from a newest-first GitHub list.
//
// `found` selects by position, which is exact. Otherwise the state is older
// than the whole lookback window and `lastDate` selects by commit time, which
// resyncs without duplicating already-posted commits. With neither, the caller
// has nothing to anchor to and reseeds.
export function newCommitsSince(commits, { lastSha, lastDate } = {}, now = Date.now()) {
	if (!lastSha) return { commits: [], reseed: true };
	const oldestPostable = now - CUTOFF_DAYS * 86_400_000;
	const postable = (c) => {
		const t = Date.parse(commitDate(c));
		return Number.isFinite(t) && t >= oldestPostable;
	};

	const idx = commits.findIndex((c) => c.sha === lastSha);
	if (idx !== -1) {
		return { commits: commits.slice(0, idx).reverse().filter(postable), reseed: false };
	}
	if (!lastDate) return { commits: [], reseed: true };

	const after = Date.parse(lastDate);
	if (!Number.isFinite(after)) return { commits: [], reseed: true };
	const newer = commits.filter((c) => {
		const t = Date.parse(commitDate(c));
		return Number.isFinite(t) && t > after;
	});
	return { commits: newer.reverse().filter(postable), reseed: false, resynced: true };
}

const escapeHtml = (s) =>
	String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);

// Headline and description come from @three-ws/shipfeed's conventional-commit
// parser, so `feat(resilience): ...` reads as "Feature · resilience" instead of
// the raw `feat(resilience)` this lane used to print, and a subject with no
// convention at all still falls back to the repo's older "Scope: text" habit.
// Only the subject line is ever posted: full commit bodies are hard-wrapped by
// git and written for engineers, not holders, so they stay on GitHub.
export function commitHeadline(commit) {
	return headline(parseCommit(commit));
}

export function commitSummary(commit) {
	return summaryLine(parseCommit(commit));
}

export function commitPreviewUrl(commit) {
	const author = commit.author?.login || commit.commit?.author?.name || 'unknown';
	const date = (commit.commit?.author?.date || '').slice(0, 10);
	const params = new URLSearchParams({
		sha: commit.sha,
		t: commitHeadline(commit),
		d: commitSummary(commit),
		date,
		author,
	});
	return `${BASE}/api/commit-og?${params.toString()}`;
}

export function formatTelegramMessage(commit) {
	const shortSha = commit.sha.slice(0, 7);
	const author = commit.author?.login || commit.commit?.author?.name || 'unknown';
	const date = (commit.commit?.author?.date || '').slice(0, 10);
	const url = commit.html_url || `https://github.com/${REPO}/commit/${commit.sha}`;
	const linkText = `github.com/${REPO}/commit/${shortSha}`;
	return [
		`<b>${escapeHtml(commitHeadline(commit))}</b>`,
		'',
		escapeHtml(commitSummary(commit)),
		'',
		`<a href="${url}">${escapeHtml(linkText)}</a> · ${escapeHtml(date)} · ${escapeHtml(author)}`,
	].join('\n');
}

async function sendTelegram(botToken, chatId, text, previewUrl) {
	const res = await fetchUpstream(`https://api.telegram.org/bot${botToken}/sendMessage`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			chat_id: chatId,
			text,
			parse_mode: 'HTML',
			// Preview the branded three.ws poster (not the GitHub link that also
			// sits in the text), rendered below the message like the changelog feed.
			link_preview_options: { is_disabled: false, url: previewUrl, show_above_text: false },
		}),
		signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
	}, { name: 'telegram', timeoutMs: 10_000, attempts: 2, okWhen: () => true });
	const body = await res.json().catch(() => ({}));
	if (!res.ok || !body.ok) {
		throw new Error(`Telegram sendMessage failed (${res.status}): ${body.description || 'unknown error'}`);
	}
}

export async function pushTelegramLane() {
	const botToken = process.env.TELEGRAM_BOT_TOKEN;
	const chatId = process.env.TELEGRAM_COMMITS_CHAT_ID || process.env.TELEGRAM_CHANGELOG_CHAT_ID;
	if (!botToken || !chatId) return { skipped: 'not_configured' };

	const state = (await getState(STATE_KEY)) || { lastSha: null, lastDate: null };
	const { commits, found } = await fetchCommitsSince(state.lastSha);
	if (commits.length === 0) return { posted: 0 };

	if (state.lastSha && !found) {
		console.warn(
			`[commit-feed] lastSha ${state.lastSha} is outside the last ${MAX_LOOKBACK_PAGES * PER_PAGE} commits; resyncing by commit date`,
		);
	}

	const { commits: pending, reseed, resynced } = newCommitsSince(commits, state, Date.now());
	if (reseed) {
		await setState(STATE_KEY, { lastSha: commits[0].sha, lastDate: commitDate(commits[0]) });
		return { posted: 0, seeded: true };
	}
	if (pending.length === 0) {
		// Caught up, or everything still pending has aged past the cutoff.
		// Either way, pin state to HEAD so the next tick starts from a sha that
		// is inside the lookback window.
		if (!found) {
			await setState(STATE_KEY, { lastSha: commits[0].sha, lastDate: commitDate(commits[0]) });
		}
		return { posted: 0, resynced: Boolean(resynced) };
	}

	// Oldest-first: a backlog larger than one run drains across the following
	// ticks in commit order. Taking the newest instead would advance state past
	// everything older and lose it.
	const batch = pending.slice(0, TELEGRAM_LIMIT);
	const backlog = pending.length - batch.length;
	if (backlog > 0) {
		console.warn(`[commit-feed] ${backlog} commits still queued after this run; draining ${TELEGRAM_LIMIT}/tick`);
	}

	let sent = 0;
	let skipped = 0;
	let { lastSha, lastDate } = state;
	try {
		for (const commit of batch) {
			// A merge commit, a lockfile bump or a `chore(deps):` bump carries no
			// content a reader can act on: the merged commits already said what
			// changed, and nobody follows this channel to learn that `ws` moved a
			// patch version. Skipping them still advances state, so the lane never
			// re-reads a commit it decided not to post.
			if (classify(commit, { productScopes: PRODUCT_SCOPES }).noise) {
				lastSha = commit.sha;
				lastDate = commitDate(commit);
				skipped++;
				await setState(STATE_KEY, { lastSha, lastDate });
				continue;
			}
			await sendTelegram(botToken, chatId, formatTelegramMessage(commit), commitPreviewUrl(commit));
			lastSha = commit.sha;
			lastDate = commitDate(commit);
			sent++;
			// Written per commit, not per run: a tick killed mid-batch (the Cloud
			// Run request deadline is shorter than a full paced run) resumes at
			// the next commit rather than repeating the ones already delivered.
			await setState(STATE_KEY, { lastSha, lastDate });
			await sleep(TELEGRAM_PACE_MS);
		}
	} catch (err) {
		return { posted: sent, skipped, backlog, error: String(err?.message || err) };
	}
	return { posted: sent, skipped, backlog, resynced: Boolean(resynced) };
}
