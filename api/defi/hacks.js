// GET /api/defi/hacks
// ---------------------------------------------------------------------------
// DeFi exploit / hack history for the /hacks page. Fetches DeFiLlama's keyless
// /hacks feed (no API key), normalizes each incident to the fields the page
// renders, computes whole-dataset headline stats, then applies an optional
// case-insensitive search over name+technique+classification and paginates.
// The raw upstream is cached ~10 min in-memory + CDN. DeFiLlama's hacks
// database is the data source — see the page's attribution line.
//
// Amount unit: DeFiLlama reports `amount` in raw USD (verified at build time
// against incidents of known magnitude — the largest bridge exploits land at
// hundreds of millions to billions, matching their public post-mortems), so no
// scaling is applied. `returnedFunds` uses the same unit. `chain` is an array
// of chain names (or null); it is normalized to an array.

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';

const UPSTREAM = 'https://api.llama.fi/hacks';
const TTL_MS = 600_000;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;

let _cache = null; // { value, expiresAt }

const finiteOrNull = (n) => (Number.isFinite(n) ? n : null);

function normalizeChains(chain) {
	if (Array.isArray(chain)) return chain.filter((c) => typeof c === 'string' && c.length);
	if (typeof chain === 'string' && chain.length) return [chain];
	return [];
}

// Fetch + normalize the whole upstream feed once, cache it. Returns the full
// sorted, normalized incident list plus the dataset-wide headline stats — the
// per-request search/pagination happens on top of this cached whole.
async function loadDataset() {
	const now = Date.now();
	if (_cache && _cache.expiresAt > now) return _cache.value;

	const resp = await fetch(UPSTREAM, {
		headers: { accept: 'application/json', 'user-agent': 'three.ws/1.0' },
		signal: AbortSignal.timeout(10_000),
	});
	if (!resp.ok) throw new Error(`llama ${resp.status}`);
	const raw = await resp.json();
	if (!Array.isArray(raw)) throw new Error('unexpected upstream shape');

	const hacks = [];
	for (const h of raw) {
		const dateSec = Number(h?.date);
		if (!Number.isFinite(dateSec)) continue;
		const amount = Number(h?.amount);
		const returned = Number(h?.returnedFunds);
		hacks.push({
			date: dateSec * 1000, // epoch ms
			name: typeof h.name === 'string' && h.name.length ? h.name : 'Unknown',
			classification: typeof h.classification === 'string' ? h.classification : null,
			technique: typeof h.technique === 'string' ? h.technique : null,
			amount_usd: Number.isFinite(amount) && amount >= 0 ? amount : null,
			chains: normalizeChains(h.chain),
			bridge: h.bridgeHack === true,
			target_type: typeof h.targetType === 'string' ? h.targetType : null,
			// `source` is a post-mortem/reference URL when present; DeFiLlama
			// frequently ships it empty, so keep it null rather than render a
			// dead link.
			source: typeof h.source === 'string' && /^https?:\/\//i.test(h.source) ? h.source : null,
			returned_usd: Number.isFinite(returned) && returned > 0 ? returned : null,
		});
	}

	// Newest first.
	hacks.sort((a, b) => b.date - a.date);

	// Headline stats span the entire dataset, independent of any search/paging.
	const cutoff = now - YEAR_MS;
	let totalAllTime = 0;
	let total12mo = 0;
	let incidents12mo = 0;
	let bridgeAllTime = 0;
	for (const h of hacks) {
		const amt = h.amount_usd || 0;
		totalAllTime += amt;
		if (h.bridge) bridgeAllTime += amt;
		if (h.date >= cutoff) {
			total12mo += amt;
			incidents12mo += 1;
		}
	}

	const value = {
		hacks,
		stats: {
			total_stolen_all_time: totalAllTime,
			total_stolen_12mo: total12mo,
			incidents_12mo: incidents12mo,
			bridge_hack_share_pct: totalAllTime > 0 ? (bridgeAllTime / totalAllTime) * 100 : 0,
		},
		updated_at: now,
	};
	_cache = { value, expiresAt: now + TTL_MS };
	return value;
}

function clampInt(raw, fallback, min, max) {
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.marketDataIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	let url;
	try {
		url = new URL(req.url, 'http://local');
	} catch {
		url = new URL('/api/defi/hacks', 'http://local');
	}
	const search = (url.searchParams.get('search') || '').trim().toLowerCase();
	const limit = clampInt(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
	const offset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);

	try {
		const dataset = await loadDataset();

		let filtered = dataset.hacks;
		if (search) {
			filtered = filtered.filter((h) => {
				const hay = `${h.name} ${h.technique || ''} ${h.classification || ''}`.toLowerCase();
				return hay.includes(search);
			});
		}

		const page = filtered.slice(offset, offset + limit);

		return json(
			res,
			200,
			{
				stats: {
					total_stolen_all_time: dataset.stats.total_stolen_all_time,
					total_stolen_12mo: dataset.stats.total_stolen_12mo,
					incidents_12mo: dataset.stats.incidents_12mo,
					bridge_hack_share_pct: finiteOrNull(dataset.stats.bridge_hack_share_pct) ?? 0,
				},
				hacks: page,
				count: filtered.length,
				updated_at: dataset.updated_at,
			},
			{
				'cache-control':
					'public, max-age=120, s-maxage=600, stale-while-revalidate=1200',
			},
		);
	} catch {
		return error(
			res,
			502,
			'upstream_error',
			'DeFi hacks data is unavailable right now — retry shortly',
		);
	}
});
