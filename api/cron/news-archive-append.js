// GET /api/cron/news-archive-append — hourly continuous archiver for the
// crypto-news corpus on gs://three-ws-news-archive.
//
// The recovered historical archive ends at 2025-12; this cron keeps it
// current by appending the live aggregator's articles (api/_lib/news.js,
// the full publisher registry) to the current month's JSONL, in the exact enriched
// schema the corpus already uses. Records are content-addressed (16-hex id
// of the link), so appends are idempotent — an article seen by ten cron
// runs lands exactly once.
//
// Writes go through the GCS JSON API with the platform's own credentials
// (api/_lib/gcp-auth.js — GCP_SERVICE_ACCOUNT_JSON or the Cloud Run runtime
// SA, which holds roles/storage.objectAdmin on the bucket) and are guarded
// with x-goog-if-generation-match so two overlapping runs can't clobber
// each other; the loser retries next hour.
//
// ?dry_run=1 computes and reports without writing.

import { error, json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { getGcpAccessToken } from '../_lib/gcp-auth.js';
import { getNews } from '../_lib/news.js';
import { geckoFetch } from '../_lib/coingecko.js';

const BUCKET = 'three-ws-news-archive';
const API = `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o`;
const UPLOAD = `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o`;

function requireCron(req, res) {
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) {
		error(res, 503, 'not_configured', 'CRON_SECRET unset');
		return false;
	}
	const auth = req.headers['authorization'] || '';
	const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!constantTimeEquals(presented, secret)) {
		error(res, 401, 'unauthorized', 'invalid cron secret');
		return false;
	}
	return true;
}

// ── GCS helpers (JSON API, no client-library dependency) ────────────────────

async function gcsGetObject(token, name) {
	// metadata (for generation) + content in two small calls
	const metaResp = await fetch(`${API}/${encodeURIComponent(name)}`, {
		headers: { authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(15_000),
	});
	if (metaResp.status === 404) return { exists: false, generation: '0', text: '' };
	if (!metaResp.ok) throw new Error(`GCS meta ${name} → ${metaResp.status}`);
	const meta = await metaResp.json();
	const dataResp = await fetch(`${API}/${encodeURIComponent(name)}?alt=media`, {
		headers: { authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(60_000),
	});
	if (!dataResp.ok) throw new Error(`GCS read ${name} → ${dataResp.status}`);
	return { exists: true, generation: meta.generation, text: await dataResp.text() };
}

async function gcsPutObject(token, name, body, generation, contentType) {
	const resp = await fetch(
		`${UPLOAD}?uploadType=media&name=${encodeURIComponent(name)}&ifGenerationMatch=${generation}`,
		{
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': contentType,
				'x-goog-if-generation-match': generation,
			},
			body,
			signal: AbortSignal.timeout(60_000),
		},
	);
	if (resp.status === 412) throw Object.assign(new Error(`GCS precondition failed on ${name}`), { code: 'race' });
	if (!resp.ok) throw new Error(`GCS write ${name} → ${resp.status} ${(await resp.text()).slice(0, 120)}`);
	return resp.json();
}

// ── Record conversion — live article → enriched archive schema ──────────────

function detectLanguage(title) {
	if (/[぀-ヿ]/.test(title)) return 'ja'; // hiragana/katakana
	if (/[一-鿿]/.test(title)) return 'zh';
	return 'en';
}

function toArchiveRecord(a, marketContext, nowIso) {
	return {
		id: a.id,
		schema_version: '2.0.0',
		title: a.title,
		link: a.link,
		canonical_link: a.link,
		description: a.description,
		source: a.source,
		source_key: a.source_key,
		category: a.category,
		pub_date: a.pub_date,
		first_seen: nowIso,
		last_seen: nowIso,
		fetch_count: 1,
		tickers: a.tickers,
		entities: { people: [], companies: [], protocols: [] },
		tags: [],
		sentiment: a.sentiment,
		market_context: marketContext,
		content_hash: a.id,
		meta: {
			word_count: (a.description || a.title).split(/\s+/).length,
			has_numbers: /\d/.test(`${a.title} ${a.description || ''}`),
			is_breaking: false,
			is_opinion: false,
			has_url: true,
			import_source: 'three.ws-live-archiver',
			language: detectLanguage(a.title),
		},
	};
}

// Market context at capture time — real values or null, never fabricated.
async function currentMarketContext() {
	try {
		const [global, fng] = await Promise.all([
			geckoFetch('/global', { ttlMs: 120_000 }),
			fetch('https://api.alternative.me/fng/?limit=1', { signal: AbortSignal.timeout(6000) })
				.then((r) => (r.ok ? r.json() : null))
				.catch(() => null),
		]);
		const prices = await geckoFetch('/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd', {
			ttlMs: 120_000,
		});
		return {
			btc_price: prices?.bitcoin?.usd ?? null,
			eth_price: prices?.ethereum?.usd ?? null,
			sol_price: prices?.solana?.usd ?? null,
			total_market_cap: global?.data?.total_market_cap?.usd ?? null,
			btc_dominance: global?.data?.market_cap_percentage?.btc ?? null,
			fear_greed_index: fng?.data?.[0]?.value != null ? Number(fng.data[0].value) : null,
		};
	} catch {
		return null;
	}
}

// ─────────────────────────────────────────────────────────────────────────────

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	const params = new URL(req.url, 'http://x').searchParams;
	const dryRun = params.get('dry_run') === '1';
	const nowIso = new Date().toISOString();
	const month = nowIso.slice(0, 7); // YYYY-MM

	let token = null;
	if (!dryRun) token = await getGcpAccessToken();

	// Live sweep across every source — the aggregator serves from its
	// per-source cache, so this is one bounded fan-out at most.
	const live = await getNews({ limit: 2000 });
	if (!live.articles.length) {
		return json(res, 200, { ok: true, month, appended: 0, note: 'aggregator returned no articles' });
	}

	const objectName = `articles/${month}.jsonl`;
	const existing = dryRun
		? { exists: false, generation: '0', text: '' }
		: await gcsGetObject(token, objectName);
	const seen = new Set();
	for (const line of existing.text.split('\n')) {
		if (!line.trim()) continue;
		try {
			seen.add(JSON.parse(line).id);
		} catch {
			// malformed line — leave it in place, it just can't dedupe
		}
	}

	// Only archive articles actually published (or first seen) this month, so
	// a long-lived feed backlog doesn't leak into the wrong month file.
	const fresh = live.articles.filter(
		(a) => !seen.has(a.id) && (!a.pub_date || a.pub_date.slice(0, 7) === month),
	);
	if (!fresh.length) {
		return json(res, 200, {
			ok: true, month, appended: 0, live_considered: live.articles.length,
			already_archived: seen.size, dry_run: dryRun,
		});
	}

	const marketContext = await currentMarketContext();
	const lines = fresh.map((a) => JSON.stringify(toArchiveRecord(a, marketContext, nowIso)));

	if (!dryRun) {
		const body = existing.text
			? `${existing.text.replace(/\n$/, '')}\n${lines.join('\n')}\n`
			: `${lines.join('\n')}\n`;
		await gcsPutObject(token, objectName, body, existing.generation, 'application/x-ndjson');

		// Keep corpus stats truthful for /markets/archive and the API's
		// stats mode. Best-effort: a stats race loses to next hour's run.
		try {
			const stats = await gcsGetObject(token, 'meta/stats.json');
			if (stats.exists) {
				const parsed = JSON.parse(stats.text);
				parsed.total_articles += fresh.length;
				parsed.total_with_url += fresh.length;
				parsed.total_with_date += fresh.filter((a) => a.pub_date).length;
				parsed.total_with_description += fresh.filter((a) => a.description).length;
				const newest = fresh.map((a) => a.pub_date).filter(Boolean).sort().pop();
				if (newest && (!parsed.last_article_date || newest > parsed.last_article_date)) {
					parsed.last_article_date = newest;
				}
				for (const a of fresh) {
					parsed.sources[a.source_key] = (parsed.sources[a.source_key] || 0) + 1;
				}
				await gcsPutObject(token, 'meta/stats.json', JSON.stringify(parsed, null, 2), stats.generation, 'application/json');
			}
		} catch (err) {
			if (err?.code !== 'race') console.error('news-archive-append: stats update skipped:', err.message);
		}
	}

	return json(res, 200, {
		ok: true,
		month,
		appended: fresh.length,
		live_considered: live.articles.length,
		already_archived: seen.size,
		sources_live: `${live.sources_ok}/${live.sources_total}`,
		market_context: marketContext ? 'captured' : 'unavailable',
		dry_run: dryRun,
	});
});
