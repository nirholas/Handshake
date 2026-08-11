// Contract test for /api/artifact. The artifact endpoint must produce HTML
// that survives Claude.ai's actual sandbox CSP — otherwise the artifact
// silently breaks when pasted into a Claude conversation. We pin against the
// real CSP scraped at github.com/simonw/scrape-claude-artifacts (vendored at
// public/claude-artifact-csp.txt, which is also what the builder page at
// /artifact displays; refresh via `node scripts/refresh-claude-csp.mjs`).
//
// What "survive" means here: for every directive that controls fetchable
// resources (script-src, style-src, connect-src, img-src, font-src), every
// reference in our HTML must use a scheme/origin that the directive allows.
// Inline scripts/styles need 'unsafe-inline' (Claude's CSP grants both).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '../../public/claude-artifact-csp.txt');
const BUNDLE = resolve(__dirname, '../../public/artifact-viewer.bundle.js');

vi.mock('../../api/_lib/zauth.js', () => ({ instrument: () => {}, drain: async () => {} }));
vi.mock('../../api/_lib/sentry.js', () => ({ captureException: () => {} }));
vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { widgetRead: async () => ({ success: true }) },
	clientIp: () => '127.0.0.1',
}));

const sqlMock = vi.fn();
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

const getObjectBufferMock = vi.fn();
vi.mock('../../api/_lib/r2.js', () => ({
	getObjectBuffer: (...a) => getObjectBufferMock(...a),
}));

// A tiny but valid GLB. The test parses no actual geometry — we only need
// the byte stream to round-trip through base64 and into the HTML.
const FAKE_GLB = Buffer.from('glTF\x02\x00\x00\x00' + 'A'.repeat(1024));

// agent_identities.id is a uuid column, so every accepted ?agent= value is one.
const AGENT_UUID = '27a0f649-3b59-4552-bb0b-faf616ac448b';

function makeReq(qs) {
	return {
		url: '/api/artifact?' + qs,
		method: 'GET',
		headers: { 'x-forwarded-host': 'three.ws', 'x-forwarded-proto': 'https' },
	};
}
function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		setHeader(k, v) {
			this._h[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this._h[k.toLowerCase()];
		},
		end(body) {
			this._body = body;
			this.writableEnded = true;
		},
	};
}

function parseCsp(raw) {
	const text = raw.replace(/^content-security-policy:\s*/i, '').replace(/\s+/g, ' ').trim();
	const out = {};
	for (const part of text.split(';')) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const [name, ...sources] = trimmed.split(/\s+/);
		out[name.toLowerCase()] = sources;
	}
	return out;
}

function loadClaudeCsp() {
	if (!existsSync(FIXTURE)) {
		throw new Error(`Missing CSP fixture at ${FIXTURE}`);
	}
	return parseCsp(readFileSync(FIXTURE, 'utf8'));
}

// Effective directive lookup: fall back to default-src per CSP spec.
function effective(csp, directive) {
	if (csp[directive]) return csp[directive];
	if (csp['default-src']) return csp['default-src'];
	return ['*'];
}

function urlAllowedBy(rawUrl, sources) {
	if (sources.includes('*')) return true;

	for (const src of sources) {
		// Scheme sources: data:, blob:, https:
		if (src.endsWith(':')) {
			if (rawUrl.startsWith(src)) return true;
			continue;
		}
		if (src === "'self'") continue; // 'self' is the document origin — claudeusercontent.com — so external URLs aren't 'self'
		if (src.startsWith("'")) continue; // 'unsafe-inline', 'unsafe-eval', 'none' don't gate URLs
		// Origin/path sources: e.g. https://cdnjs.cloudflare.com or https://cdn.jsdelivr.net/pyodide/
		try {
			const allowed = new URL(src);
			const target = new URL(rawUrl, 'https://www.claudeusercontent.com/');
			const originMatch = target.protocol === allowed.protocol && target.host === allowed.host;
			if (!originMatch) continue;
			if (allowed.pathname && allowed.pathname !== '/') {
				if (target.pathname.startsWith(allowed.pathname)) return true;
			} else {
				return true;
			}
		} catch {
			// not a URL; ignore
		}
	}
	return false;
}

// Pull every URL-shaped string out of HTML attributes and inline JS we care about.
function extractExternalUrls(html) {
	const urls = [];
	const hits = html.matchAll(/(?:src|href)=["']([^"']+)["']/gi);
	for (const m of hits) {
		const u = m[1];
		if (!/^https?:\/\//i.test(u)) continue;
		urls.push({ url: u, kind: 'attr' });
	}
	return urls;
}

let handler;

beforeEach(async () => {
	vi.resetModules();
	sqlMock.mockReset();
	getObjectBufferMock.mockReset();
	const mod = await import('../../api/artifact.js');
	handler = mod.default;
});

describe('/api/artifact contract', () => {
	it('viewer bundle exists (run `npm run build:artifact-viewer` if this fails)', () => {
		expect(existsSync(BUNDLE)).toBe(true);
	});

	it('vendored Claude CSP fixture parses with the directives we depend on', () => {
		const csp = loadClaudeCsp();
		expect(csp['script-src']).toContain("'unsafe-inline'");
		expect(csp['style-src']).toContain("'unsafe-inline'");
		expect(csp['img-src']).toContain('data:');
		expect(csp['img-src']).toContain('blob:');
		expect(csp['object-src']).toContain("'none'");
	});

	describe('?agent=<id>', () => {
		it('returns 404 when agent missing', async () => {
			sqlMock.mockResolvedValueOnce([]);
			const res = makeRes();
			await handler(makeReq('agent=' + AGENT_UUID + ''), res);
			expect(res.statusCode).toBe(404);
		});

		it('returns 422 when agent has no avatar', async () => {
			sqlMock.mockResolvedValueOnce([{ id: 'a1', name: 'Test', storage_key: null }]);
			const res = makeRes();
			await handler(makeReq('agent=' + AGENT_UUID + ''), res);
			expect(res.statusCode).toBe(422);
		});

		it('returns 400 for malformed agent id', async () => {
			const res = makeRes();
			await handler(makeReq('agent=' + encodeURIComponent('not legal!')), res);
			expect(res.statusCode).toBe(400);
		});

		// A hand-typed handle used to reach Postgres and blow up on
		// "invalid input syntax for type uuid", which surfaced to the caller as a
		// 500 with a support ref. It must be rejected before the query runs.
		it('returns 400 for a non-UUID agent id without touching the database', async () => {
			const res = makeRes();
			await handler(makeReq('agent=alice'), res);
			expect(res.statusCode).toBe(400);
			expect(JSON.parse(res._body).error).toBe('invalid_request');
			expect(sqlMock).not.toHaveBeenCalled();
		});

		it('returns 200 self-contained HTML for a valid agent', async () => {
			sqlMock.mockResolvedValueOnce([
				{ id: 'a1', name: 'Aurora', storage_key: 'u/123/aurora.glb' },
			]);
			getObjectBufferMock.mockResolvedValueOnce(FAKE_GLB);
			const res = makeRes();
			await handler(makeReq('agent=' + AGENT_UUID + ''), res);
			expect(res.statusCode).toBe(200);
			expect(res.getHeader('content-type')).toMatch(/text\/html/);
			expect(res._body).toContain('<html');
			expect(res._body).toContain('artifact-config');
			expect(res._body).toContain('artifact-stage');
		});

		it('embeds the GLB as base64 in the config script tag', async () => {
			sqlMock.mockResolvedValueOnce([
				{ id: 'a1', name: 'Aurora', storage_key: 'u/123/aurora.glb' },
			]);
			getObjectBufferMock.mockResolvedValueOnce(FAKE_GLB);
			const res = makeRes();
			await handler(makeReq('agent=' + AGENT_UUID + ''), res);
			const m = res._body.match(/id="artifact-config">([^<]+)</);
			expect(m).not.toBeNull();
			const cfg = JSON.parse(m[1]);
			expect(cfg.glb).toBe(FAKE_GLB.toString('base64'));
			expect(cfg.name).toBe('Aurora');
		});

		it('rejects oversized GLB (>6 MB)', async () => {
			sqlMock.mockResolvedValueOnce([
				{ id: 'a1', name: 'Big', storage_key: 'u/big.glb' },
			]);
			getObjectBufferMock.mockResolvedValueOnce(Buffer.alloc(7 * 1024 * 1024));
			const res = makeRes();
			await handler(makeReq('agent=' + AGENT_UUID + ''), res);
			expect(res.statusCode).toBe(413);
		});

		it('escapes name to prevent HTML injection', async () => {
			sqlMock.mockResolvedValueOnce([
				{ id: 'a1', name: '<script>alert(1)</script>', storage_key: 'u/x.glb' },
			]);
			getObjectBufferMock.mockResolvedValueOnce(FAKE_GLB);
			const res = makeRes();
			await handler(makeReq('agent=' + AGENT_UUID + ''), res);
			expect(res._body).not.toMatch(/<script>alert\(1\)<\/script>/);
			expect(res._body).toContain('&lt;script&gt;');
		});
	});

	describe('input validation', () => {
		it('400s when neither agent nor model is provided', async () => {
			const res = makeRes();
			await handler(makeReq(''), res);
			expect(res.statusCode).toBe(400);
		});

		it('400s when both agent and model are provided', async () => {
			const res = makeRes();
			await handler(
				makeReq('agent=' + AGENT_UUID + '&model=https://three.ws/x.glb'),
				res,
			);
			expect(res.statusCode).toBe(400);
		});

		it('400s for non-whitelisted model origin', async () => {
			const res = makeRes();
			await handler(makeReq('model=' + encodeURIComponent('https://evil.com/x.glb')), res);
			expect(res.statusCode).toBe(400);
		});

		it('rejects non-GET/HEAD', async () => {
			const res = makeRes();
			await handler({ ...makeReq('agent=' + AGENT_UUID + ''), method: 'POST' }, res);
			expect(res.statusCode).toBe(405);
		});
	});

	describe('CSP compliance vs Claude.ai sandbox', () => {
		// Generate one valid response to inspect.
		async function generate() {
			sqlMock.mockResolvedValueOnce([
				{ id: 'a1', name: 'Aurora', storage_key: 'u/123/aurora.glb' },
			]);
			getObjectBufferMock.mockResolvedValueOnce(FAKE_GLB);
			const res = makeRes();
			await handler(makeReq('agent=' + AGENT_UUID + ''), res);
			return res;
		}

		it("contains no <script src=> — only inline scripts (Claude allows 'unsafe-inline')", async () => {
			const res = await generate();
			const externalScripts = res._body.match(/<script[^>]*\bsrc=/gi);
			expect(externalScripts).toBeNull();
		});

		it('contains no <link rel="stylesheet"> — only inline styles', async () => {
			const res = await generate();
			expect(res._body).not.toMatch(/<link[^>]+rel=["']stylesheet["']/i);
		});

		it('contains no external https:// URLs in src/href attributes', async () => {
			const res = await generate();
			const externals = extractExternalUrls(res._body);
			expect(externals).toEqual([]);
		});

		it('every script-src reference is allowed by Claude\'s real script-src', async () => {
			const res = await generate();
			const csp = loadClaudeCsp();
			const allowed = effective(csp, 'script-src');
			const scriptSrcs = [...res._body.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/gi)].map(
				(m) => m[1],
			);
			for (const src of scriptSrcs) {
				expect(urlAllowedBy(src, allowed), `script src ${src} blocked by ${allowed}`).toBe(true);
			}
		});

		it('our response CSP allows itself (we serve a CSP that mirrors Claude\'s)', async () => {
			const res = await generate();
			const ourCsp = parseCsp(res.getHeader('content-security-policy'));
			expect(effective(ourCsp, 'script-src')).toContain("'unsafe-inline'");
			expect(effective(ourCsp, 'style-src')).toContain("'unsafe-inline'");
			expect(effective(ourCsp, 'img-src')).toEqual(expect.arrayContaining(['data:', 'blob:']));
			expect(effective(ourCsp, 'object-src')).toContain("'none'");
			expect(ourCsp['frame-ancestors']).toContain('*');
		});
	});

	describe('headers', () => {
		it('sets cache-control with stale-while-revalidate', async () => {
			sqlMock.mockResolvedValueOnce([
				{ id: 'a1', name: 'Aurora', storage_key: 'u/123/aurora.glb' },
			]);
			getObjectBufferMock.mockResolvedValueOnce(FAKE_GLB);
			const res = makeRes();
			await handler(makeReq('agent=' + AGENT_UUID + ''), res);
			expect(res.getHeader('cache-control')).toMatch(/stale-while-revalidate/);
		});

		it('HEAD returns no body', async () => {
			sqlMock.mockResolvedValueOnce([
				{ id: 'a1', name: 'Aurora', storage_key: 'u/123/aurora.glb' },
			]);
			getObjectBufferMock.mockResolvedValueOnce(FAKE_GLB);
			const res = makeRes();
			await handler({ ...makeReq('agent=' + AGENT_UUID + ''), method: 'HEAD' }, res);
			expect(res.statusCode).toBe(200);
			expect(res._body).toBeUndefined();
			expect(res.getHeader('content-length')).toBeDefined();
		});
	});
});
