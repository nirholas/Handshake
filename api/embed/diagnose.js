// POST /api/embed/diagnose — the Embed Doctor API.
//
// Loads a developer's page (or a bare snippet) in a real headless browser and
// reports exactly why their `<agent-3d>` embed is not appearing. The decision
// logic lives in api/_lib/embed-doctor.js; this file is transport, validation,
// and abuse control.
//
// Body (JSON), exactly one of:
//   { "url": "https://your-site.example/page" }   inspect a live page
//   { "snippet": "<script …></script><agent-3d …></agent-3d>" }
//                                                  inspect markup before deploy
//
// Options:
//   screenshot: boolean   include a base64 JPEG of what actually rendered (default true)
//   budgetMs:   number    how long to wait for the agent to paint (2000-20000, default 12000)
//
// Response 200:
//   {
//     verdict: "healthy" | "degraded" | "broken" | "inconclusive",
//     summary: { checks, failed, passed, unknown, headline },
//     findings: [{ id, severity, status, title, detail, fix, evidence }],
//     screenshot: "<base64 jpeg>" | null,
//     durationMs: number
//   }
//
// Safety:
//   - The URL goes through the shared SSRF guard, so an internal address, cloud
//     metadata endpoint, or a redirect into one is refused rather than fetched.
//   - Booting chromium is expensive, so the budget is small and per-IP: 12 runs
//     per 10 minutes is far more than a developer debugging one embed needs and
//     well under what makes this a free browser-as-a-service for someone else.
//   - Snippets are capped at 8 KB. The sandbox they run in is a blank page on
//     our origin with no credentials, so a snippet can reach the public web and
//     nothing else.

import { cors, error, json, method, readJson, rateLimited, wrap } from '../_lib/http.js';
import { clientIp } from '../_lib/rate-limit.js';
import { diagnose, SsrfBlockedError } from '../_lib/embed-doctor.js';

export const maxDuration = 60;

const MAX_SNIPPET_BYTES = 8 * 1024;
const MIN_BUDGET_MS = 2000;
const MAX_BUDGET_MS = 20000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 12;

// Per-instance limiter, matching /api/render/glb. The resource being protected
// is this instance's CPU and memory (one chromium per run), so a per-instance
// cap is the honest unit: it bounds exactly what it is defending.
const rateMap = new Map();
function rateCheck(ip) {
	const now = Date.now();
	if (!ip) return { success: true, limit: RATE_MAX, remaining: RATE_MAX, reset: now + RATE_WINDOW_MS };
	const hits = (rateMap.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
	if (hits.length >= RATE_MAX) {
		rateMap.set(ip, hits);
		return { success: false, limit: RATE_MAX, remaining: 0, reset: hits[0] + RATE_WINDOW_MS };
	}
	hits.push(now);
	rateMap.set(ip, hits);
	// Unbounded growth would be a slow leak on a long-lived instance; entries
	// are only useful for one window.
	if (rateMap.size > 5000) {
		for (const [k, v] of rateMap) {
			if (!v.length || now - v[v.length - 1] > RATE_WINDOW_MS) rateMap.delete(k);
		}
	}
	return { success: true, limit: RATE_MAX, remaining: RATE_MAX - hits.length, reset: now + RATE_WINDOW_MS };
}

function platformOrigin(req) {
	const envOrigin = process.env.PUBLIC_ORIGIN || process.env.SITE_ORIGIN;
	if (envOrigin) return String(envOrigin).replace(/\/$/, '');
	const host = req.headers['x-forwarded-host'] || req.headers.host;
	if (!host) return 'https://three.ws';
	const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
	return `${proto}://${host}`;
}

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const ip = clientIp(req);
	const rate = rateCheck(ip);
	if (!rate.success) {
		return rateLimited(
			res,
			rate,
			'Too many diagnoses from this address. Each run boots a real browser, so the budget is small. Try again shortly.',
		);
	}

	const body = await readJson(req, 32 * 1024).catch(() => null);
	if (!body || typeof body !== 'object') {
		return error(res, 400, 'invalid_body', 'Send a JSON body with either a `url` or a `snippet`.');
	}

	const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
	const rawSnippet = typeof body.snippet === 'string' ? body.snippet : '';

	if (rawUrl && rawSnippet) {
		return error(
			res,
			400,
			'ambiguous_target',
			'Send either `url` or `snippet`, not both. A snippet is checked in a clean sandbox; a URL is checked on your real page.',
		);
	}
	if (!rawUrl && !rawSnippet.trim()) {
		return error(
			res,
			400,
			'missing_target',
			'Send `url` (a public page carrying your embed) or `snippet` (the two tags, to check before you deploy).',
		);
	}

	if (rawSnippet && Buffer.byteLength(rawSnippet, 'utf8') > MAX_SNIPPET_BYTES) {
		return error(
			res,
			413,
			'snippet_too_large',
			`Snippets are capped at ${MAX_SNIPPET_BYTES / 1024} KB. Paste just the script tag and the embed element.`,
		);
	}

	let url = '';
	if (rawUrl) {
		let parsed;
		try {
			parsed = new URL(rawUrl.includes('://') ? rawUrl : `https://${rawUrl}`);
		} catch {
			return error(res, 400, 'invalid_url', 'That does not look like a URL. Include the full address, for example https://example.com/page.');
		}
		if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
			return error(res, 400, 'unsupported_scheme', 'Only http and https pages can be inspected.');
		}
		url = parsed.toString();
	}

	const budgetMs = Math.min(
		MAX_BUDGET_MS,
		Math.max(MIN_BUDGET_MS, Number(body.budgetMs) || 12000),
	);
	const screenshot = body.screenshot !== false;

	try {
		const report = await diagnose({
			...(url ? { url } : { snippet: rawSnippet }),
			budgetMs,
			screenshot,
			platformOrigin: platformOrigin(req),
		});
		// A diagnosis is about one moment in time on someone else's server, so it
		// must never be cached and handed to the next caller as fresh.
		return json(res, 200, report, { 'cache-control': 'no-store' });
	} catch (err) {
		if (err instanceof SsrfBlockedError || err?.code === 'ssrf_blocked') {
			return error(
				res,
				400,
				'url_not_public',
				'That address is not reachable from the public internet (it resolves to a private or internal host). Paste your snippet instead and we will check the markup in a sandbox.',
			);
		}
		if (/executablePath|chromium|Failed to launch/i.test(String(err?.message || ''))) {
			return error(
				res,
				503,
				'browser_unavailable',
				'The diagnostic browser could not start. This is on our side, not your page. Please try again in a minute.',
			);
		}
		return error(
			res,
			502,
			'diagnosis_failed',
			`The diagnosis could not complete: ${String(err?.message || err).slice(0, 200)}`,
		);
	}
});
