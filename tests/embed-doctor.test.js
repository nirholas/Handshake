// The Embed Doctor's verdict logic, exercised without a browser.
//
// `analyze()` is deliberately pure so the whole failure catalogue can be pinned
// here: each test builds the observations a real page would have produced and
// asserts the report a developer would read. The browser layer only gathers
// facts, so these tests cover every decision the tool makes.

import { describe, it, expect } from 'vitest';
import {
	analyze,
	isEmbedRelated,
	looksLikeCspBlock,
	snippetHostHtml,
	EMBED_TAG,
	EMBED_TAGS,
	EMBED_SELECTOR,
	SOURCE_ATTRIBUTES,
} from '../api/_lib/embed-doctor.js';

const LOADER = 'https://three.ws/agent-3d/latest/agent-3d.js';

/** A page where everything works. Individual tests break one thing at a time,
 *  which is also how the report is meant to be read. */
function healthyObservations(overrides = {}) {
	return {
		target: { kind: 'url', url: 'https://example.com/' },
		page: { reachable: true, status: 200, finalUrl: 'https://example.com/', https: true, csp: null },
		scripts: [{ src: LOADER, type: 'module' }],
		network: [
			{ url: LOADER, status: 200, ok: true, bytes: 4214540 },
			{ url: 'https://three.ws/api/agents/abc123', status: 200, ok: true },
		],
		console: [],
		pageErrors: [],
		webgl: { available: true, renderer: 'ANGLE' },
		agent: { id: 'abc123', resolved: true, name: 'Nova' },
		element: {
			count: 1,
			defined: true,
			attributes: { 'agent-id': 'abc123', mode: 'floating' },
			rect: { width: 320, height: 420, top: 100, left: 40 },
			styles: { display: 'block', visibility: 'visible', opacity: '1' },
			hiddenAncestor: null,
			offscreen: false,
			canvas: { present: true, width: 640, height: 840, blank: false },
			bootMs: 1800,
		},
		...overrides,
	};
}

const idsOf = (report) => report.findings.map((f) => f.id);
const byId = (report, id) => report.findings.find((f) => f.id === id);
const failed = (report) => report.findings.filter((f) => f.status === 'fail');

describe('analyze — a working embed', () => {
	it('reports healthy and fails nothing', () => {
		const report = analyze(healthyObservations());
		expect(report.verdict).toBe('healthy');
		expect(failed(report)).toHaveLength(0);
		expect(report.summary.headline).toBe('The embed is working');
	});

	it('confirms each stage of the boot rather than a single opaque pass', () => {
		const ids = idsOf(analyze(healthyObservations()));
		// A developer needs to see WHICH parts are proven working, otherwise a
		// green result is unfalsifiable.
		expect(ids).toEqual(
			expect.arrayContaining([
				'loader_loaded',
				'element_upgraded',
				'agent_resolved',
				'element_visible',
				'webgl_available',
				'canvas_rendered',
			]),
		);
	});
});

describe('analyze — the page itself', () => {
	it('stops at an unreachable page instead of cascading downstream failures', () => {
		const report = analyze({
			target: { kind: 'url', url: 'https://nope.example/' },
			page: { reachable: false, error: 'net::ERR_NAME_NOT_RESOLVED' },
			scripts: [],
			element: null,
			network: [],
			console: [],
			pageErrors: [],
		});
		expect(report.verdict).toBe('broken');
		// Exactly one finding: everything else is unknowable, and reporting
		// "element missing" here would send the developer to the wrong file.
		expect(report.findings).toHaveLength(1);
		expect(report.findings[0].id).toBe('page_unreachable');
		expect(report.findings[0].evidence.error).toContain('ERR_NAME_NOT_RESOLVED');
	});

	it('treats an HTTP error status as terminal and names the status', () => {
		const report = analyze(healthyObservations({ page: { reachable: true, status: 404 } }));
		expect(report.findings).toHaveLength(1);
		expect(report.findings[0].id).toBe('page_error_status');
		expect(report.findings[0].title).toContain('404');
	});
});

describe('analyze — the loader script', () => {
	it('flags a missing runtime as fatal and shows what scripts it did see', () => {
		const report = analyze(
			healthyObservations({
				scripts: [{ src: 'https://cdn.example/analytics.js', type: '' }],
				network: [],
				element: { ...healthyObservations().element, defined: false, canvas: { present: false, width: 0, height: 0, blank: true } },
			}),
		);
		const f = byId(report, 'loader_missing');
		expect(f.severity).toBe('fatal');
		expect(f.evidence.scriptsSeen).toContain('https://cdn.example/analytics.js');
		expect(f.fix).toContain('type="module"');
	});

	it('identifies a CSP block, which is otherwise invisible', () => {
		const report = analyze(
			healthyObservations({
				page: { reachable: true, status: 200, https: true, csp: "script-src 'self'" },
				network: [],
				console: [
					{
						type: 'error',
						text: "Refused to load the script 'https://three.ws/agent-3d/latest/agent-3d.js' because it violates the following Content Security Policy directive: \"script-src 'self'\".",
					},
				],
				element: { ...healthyObservations().element, defined: false, canvas: { present: false, width: 0, height: 0, blank: true } },
			}),
		);
		const f = byId(report, 'loader_blocked_csp');
		expect(f).toBeTruthy();
		expect(f.severity).toBe('fatal');
		expect(f.evidence.csp).toBe("script-src 'self'");
		expect(f.fix).toContain('script-src');
		// The blocked loader must outrank the un-upgraded element it caused.
		expect(report.findings[0].id).toBe('loader_blocked_csp');
	});

	it('reports a 404 on the runtime separately from a CSP block', () => {
		const report = analyze(
			healthyObservations({
				scripts: [{ src: 'https://three.ws/agent-3d/9.9.9/agent-3d.js', type: 'module' }],
				network: [{ url: 'https://three.ws/agent-3d/9.9.9/agent-3d.js', status: 404, ok: false }],
				element: { ...healthyObservations().element, defined: false },
			}),
		);
		const f = byId(report, 'loader_failed');
		expect(f.severity).toBe('fatal');
		expect(f.evidence.status).toBe(404);
	});

	it('catches a module bundle loaded without type="module"', () => {
		const report = analyze(
			healthyObservations({ scripts: [{ src: LOADER, type: '' }] }),
		);
		const f = byId(report, 'loader_not_module');
		expect(f.severity).toBe('error');
		expect(f.evidence.tags[0].type).toBe('(none)');
	});

	it('does not flag type="module" when at least one loader has it', () => {
		const report = analyze(
			healthyObservations({
				scripts: [
					{ src: LOADER, type: '' },
					{ src: LOADER, type: 'module' },
				],
			}),
		);
		expect(byId(report, 'loader_not_module')).toBeUndefined();
	});

	it('warns about a duplicated loader without calling the page broken', () => {
		const report = analyze(
			healthyObservations({
				scripts: [
					{ src: LOADER, type: 'module' },
					{ src: LOADER, type: 'module' },
				],
			}),
		);
		const f = byId(report, 'duplicate_loader');
		expect(f.severity).toBe('warn');
		expect(report.verdict).toBe('degraded');
	});
});

describe('analyze — the element', () => {
	it('stops after a missing element, since nothing below it is knowable', () => {
		const report = analyze(healthyObservations({ element: null }));
		expect(byId(report, 'element_missing').severity).toBe('fatal');
		// The loader still gets reported (it is upstream and independently useful).
		expect(idsOf(report)).toContain('loader_loaded');
		expect(idsOf(report)).not.toContain('element_visible');
	});

	it('explains an un-upgraded element as downstream of the runtime', () => {
		const report = analyze(
			healthyObservations({ element: { ...healthyObservations().element, defined: false } }),
		);
		const f = byId(report, 'element_not_upgraded');
		expect(f.severity).toBe('fatal');
		expect(f.fix).toMatch(/loader/i);
	});

	it('flags an element with no source attribute', () => {
		const report = analyze(
			healthyObservations({
				element: { ...healthyObservations().element, attributes: { mode: 'floating' } },
				agent: null,
			}),
		);
		const f = byId(report, 'source_missing');
		expect(f.severity).toBe('fatal');
		for (const attr of SOURCE_ATTRIBUTES) expect(f.detail).toContain(attr);
	});

	it('accepts any documented source attribute, not just agent-id', () => {
		for (const attr of SOURCE_ATTRIBUTES) {
			const report = analyze(
				healthyObservations({
					element: { ...healthyObservations().element, attributes: { [attr]: 'x' } },
					agent: null,
				}),
			);
			expect(byId(report, 'source_missing'), `${attr} should count as a source`).toBeUndefined();
		}
	});

	it('warns when several embeds share a page, because contexts are capped', () => {
		const report = analyze(
			healthyObservations({ element: { ...healthyObservations().element, count: 4 } }),
		);
		expect(byId(report, 'duplicate_element').evidence.count).toBe(4);
	});
});

// The v1 loader (public/embed/v1.js) registers <three-d>, <three-agent> and
// <three-ws> rather than <agent-3d>, and it is what the gated-embed snippet in
// api/embed/gate-create.js hands developers. The doctor accepted that loader
// but knew only the canonical tag, so a working v1 embed came back "broken".
describe('analyze — the v1 loader element aliases', () => {
	const V1_LOADER = 'https://three.ws/embed/v1.js';

	function v1Observations(elementOverrides = {}) {
		const base = healthyObservations();
		return healthyObservations({
			scripts: [{ src: V1_LOADER, type: '' }],
			network: [
				{ url: V1_LOADER, status: 200, ok: true, bytes: 31835 },
				{ url: 'https://three.ws/api/agents/abc123', status: 200, ok: true },
			],
			element: { ...base.element, tag: 'three-d', ...elementOverrides },
		});
	}

	for (const tag of EMBED_TAGS) {
		it(`reports a healthy <${tag}> embed as healthy`, () => {
			const report = analyze(v1Observations({ tag }));
			expect(report.verdict).toBe('healthy');
			expect(failed(report)).toHaveLength(0);
			expect(byId(report, 'element_upgraded').detail).toContain(`customElements.get('${tag}')`);
		});
	}

	it('names the tag the developer actually wrote when it was never upgraded', () => {
		const report = analyze(v1Observations({ defined: false }));
		const f = byId(report, 'element_not_upgraded');
		expect(f.severity).toBe('fatal');
		expect(f.detail).toContain('<three-d>');
		expect(f.detail).not.toContain(`<${EMBED_TAG}>`);
	});

	it('writes the fix snippet with the caller tag, not the canonical one', () => {
		const report = analyze(
			v1Observations({ attributes: { mode: 'floating' } }),
		);
		expect(byId(report, 'source_missing').fix).toContain('<three-d agent-id=');
	});

	it('falls back to the canonical tag when there is no element to name', () => {
		const report = analyze(healthyObservations({ element: null }));
		expect(byId(report, 'element_missing').title).toContain(`<${EMBED_TAG}>`);
	});

	it('ignores a tag the platform does not register, so a report cannot echo page markup', () => {
		const report = analyze(v1Observations({ tag: 'script', defined: false }));
		expect(byId(report, 'element_not_upgraded').detail).toContain(`<${EMBED_TAG}>`);
	});
});

// The in-page probe has no deadline of its own, so a page that pegs its main
// thread gets its page closed by the watchdog in collectFrom*. What comes back
// then is "we could not look", and the report has to say exactly that instead of
// claiming the developer's element is missing.
describe('analyze — a page that could not be inspected', () => {
	it('reports inconclusive rather than inventing a missing element', () => {
		const report = analyze(
			healthyObservations({ element: null, probeFailed: true, timedOut: true }),
		);
		expect(report.verdict).toBe('inconclusive');
		expect(idsOf(report)).not.toContain('element_missing');
		const f = byId(report, 'page_not_inspected');
		expect(f.status).toBe('unknown');
		expect(f.evidence.timedOut).toBe(true);
		// The loader evidence is upstream of the probe and still worth reporting.
		expect(idsOf(report)).toContain('loader_loaded');
	});

	it('distinguishes a closed page from an expired budget in the wording', () => {
		const report = analyze(
			healthyObservations({ element: null, probeFailed: true, timedOut: false }),
		);
		expect(byId(report, 'page_not_inspected').detail).toMatch(/closed the page/i);
	});

	it('still calls a genuinely missing element missing when the probe did run', () => {
		const report = analyze(healthyObservations({ element: null, probeFailed: false }));
		expect(byId(report, 'element_missing').severity).toBe('fatal');
		expect(idsOf(report)).not.toContain('page_not_inspected');
	});
});

describe('analyze — the agent id', () => {
	it('reports an unresolvable id as fatal with the lookup status', () => {
		const report = analyze(
			healthyObservations({ agent: { id: 'ghost', resolved: false, status: 404, error: 'HTTP 404' } }),
		);
		const f = byId(report, 'agent_unresolved');
		expect(f.severity).toBe('fatal');
		expect(f.evidence.agentId).toBe('ghost');
		expect(f.fix).toMatch(/public/i);
	});

	it('stays silent when the id form cannot be resolved server-side', () => {
		// On-chain / CAIP-10 ids are resolved by the runtime against a registry.
		// Claiming either verdict here would be a guess.
		const report = analyze(
			healthyObservations({ agent: { id: 'eip155:8453:0xabc:42', resolved: null } }),
		);
		expect(byId(report, 'agent_unresolved')).toBeUndefined();
		expect(byId(report, 'agent_resolved')).toBeUndefined();
	});
});

describe('analyze — visibility', () => {
	it('names the ancestor that hid the embed', () => {
		const report = analyze(
			healthyObservations({
				element: {
					...healthyObservations().element,
					styles: { display: 'none', visibility: 'visible', opacity: '1' },
					hiddenAncestor: 'div#tab-panel-2.tab-panel',
				},
			}),
		);
		const f = byId(report, 'element_hidden');
		expect(f.evidence.hiddenBy).toBe('div#tab-panel-2.tab-panel');
		expect(f.detail).toContain('display: none');
	});

	it('treats opacity:0 as hidden, not merely faint', () => {
		const report = analyze(
			healthyObservations({
				element: {
					...healthyObservations().element,
					styles: { display: 'block', visibility: 'visible', opacity: '0' },
				},
			}),
		);
		expect(byId(report, 'element_hidden').detail).toContain('opacity: 0');
	});

	it('catches the collapsed-container case and offers both fixes', () => {
		const report = analyze(
			healthyObservations({
				element: {
					...healthyObservations().element,
					rect: { width: 900, height: 0, top: 10, left: 0 },
					attributes: { 'agent-id': 'abc123' },
				},
			}),
		);
		const f = byId(report, 'element_zero_size');
		expect(f.title).toContain('900×0');
		expect(f.fix).toMatch(/height/);
		expect(f.fix).toMatch(/floating/);
	});

	it('names the ancestor that clips a correctly-sized embed out of view', () => {
		// The nastiest visibility bug: every style on the element is right, and a
		// wrapper throws the pixels away.
		const report = analyze(
			healthyObservations({
				element: {
					...healthyObservations().element,
					clippedBy: { selector: 'div.slide', width: 900, height: 0, overflow: 'hidden' },
				},
			}),
		);
		const f = byId(report, 'element_clipped');
		expect(f.severity).toBe('error');
		expect(f.detail).toContain('div.slide');
		expect(f.detail).toContain('overflow: hidden');
		expect(f.fix).toContain('div.slide');
		// It must not be masked by the element's own measurements passing.
		expect(byId(report, 'element_visible').status).toBe('pass');
	});

	it('stays quiet when no ancestor clips', () => {
		expect(byId(analyze(healthyObservations()), 'element_clipped')).toBeUndefined();
	});

	it('reports an off-screen embed as a warning, not a failure to render', () => {
		const report = analyze(
			healthyObservations({ element: { ...healthyObservations().element, offscreen: true } }),
		);
		expect(byId(report, 'element_offscreen').severity).toBe('warn');
	});
});

describe('analyze — rendering', () => {
	it('calls missing WebGL fatal and points at the image fallback', () => {
		const report = analyze(
			healthyObservations({ webgl: { available: false, renderer: null } }),
		);
		const f = byId(report, 'webgl_unavailable');
		expect(f.severity).toBe('fatal');
		expect(f.fix).toContain('/api/avatar/render');
	});

	it('separates "still blank" from "never built a canvas"', () => {
		const blank = analyze(
			healthyObservations({
				element: {
					...healthyObservations().element,
					canvas: { present: true, width: 640, height: 480, blank: true },
				},
			}),
		);
		expect(byId(blank, 'canvas_blank').severity).toBe('warn');

		const missing = analyze(
			healthyObservations({
				element: {
					...healthyObservations().element,
					canvas: { present: false, width: 0, height: 0, blank: true },
				},
			}),
		);
		expect(byId(missing, 'canvas_missing').severity).toBe('error');
		expect(byId(missing, 'canvas_blank')).toBeUndefined();
	});

	it('flags a slow boot without calling it broken', () => {
		const report = analyze(
			healthyObservations({ element: { ...healthyObservations().element, bootMs: 9400 } }),
		);
		expect(byId(report, 'slow_boot').title).toContain('9.4s');
		expect(report.verdict).toBe('degraded');
	});
});

describe('analyze — transport', () => {
	it('reports mixed content only on an https page', () => {
		const insecure = { url: 'http://three.ws/agent-3d/latest/agent-3d.js', status: 0, ok: false };
		const onHttps = analyze(
			healthyObservations({ network: [...healthyObservations().network, insecure] }),
		);
		expect(byId(onHttps, 'mixed_content')).toBeTruthy();

		const onHttp = analyze(
			healthyObservations({
				page: { reachable: true, status: 200, https: false, finalUrl: 'http://example.com/' },
				network: [...healthyObservations().network, insecure],
			}),
		);
		expect(byId(onHttp, 'mixed_content')).toBeUndefined();
	});

	it('reports failed embed asset requests but ignores unrelated site noise', () => {
		const report = analyze(
			healthyObservations({
				network: [
					...healthyObservations().network,
					{ url: 'https://three.ws/cdn/forge/body.glb', status: 404, ok: false },
					{ url: 'https://ads.example/track.gif', status: 500, ok: false },
				],
			}),
		);
		const f = byId(report, 'asset_requests_failed');
		expect(f.evidence.requests).toHaveLength(1);
		expect(f.evidence.requests[0].url).toContain('body.glb');
	});

	it('surfaces console errors from anywhere on the page', () => {
		const report = analyze(
			healthyObservations({
				pageErrors: ['TypeError: t.init is not a function'],
				console: [{ type: 'error', text: 'Uncaught (in promise) NetworkError' }],
			}),
		);
		const f = byId(report, 'console_errors');
		expect(f.evidence.messages).toHaveLength(2);
		expect(f.title).toContain('2 console errors');
	});
});

describe('analyze — report ordering and shape', () => {
	it('puts the finding that explains the failure first', () => {
		const report = analyze(
			healthyObservations({
				scripts: [],
				network: [],
				element: {
					...healthyObservations().element,
					defined: false,
					canvas: { present: false, width: 0, height: 0, blank: true },
				},
			}),
		);
		expect(report.findings[0].id).toBe('loader_missing');
		expect(report.findings[0].severity).toBe('fatal');
	});

	it('sorts failures above passes and never buries a fatal', () => {
		const report = analyze(
			healthyObservations({
				element: {
					...healthyObservations().element,
					rect: { width: 300, height: 0, top: 0, left: 0 },
				},
			}),
		);
		const firstPass = report.findings.findIndex((f) => f.status === 'pass');
		const lastFail = report.findings.map((f) => f.status).lastIndexOf('fail');
		expect(lastFail).toBeLessThan(firstPass);
	});

	it('gives every failure an actionable fix', () => {
		// A finding without a fix is a finding the developer cannot act on.
		const cases = [
			healthyObservations({ scripts: [], network: [] }),
			healthyObservations({ element: null }),
			healthyObservations({ webgl: { available: false } }),
			healthyObservations({ agent: { id: 'x', resolved: false } }),
			healthyObservations({
				element: { ...healthyObservations().element, rect: { width: 0, height: 0, top: 0, left: 0 } },
			}),
		];
		for (const obs of cases) {
			for (const f of analyze(obs).findings.filter((x) => x.status === 'fail')) {
				expect(f.fix, `${f.id} must tell the developer what to change`).toBeTruthy();
			}
		}
	});

	it('never reports an unrun check as passing', () => {
		const report = analyze(
			healthyObservations({
				element: { ...healthyObservations().element, defined: null },
			}),
		);
		const f = byId(report, 'element_upgraded');
		expect(f.status).toBe('unknown');
		expect(report.verdict).toBe('inconclusive');
	});

	it('summarises with the headline a developer should act on', () => {
		const report = analyze(healthyObservations({ element: null }));
		expect(report.summary.failed).toBeGreaterThan(0);
		expect(report.summary.headline).toBe(report.findings[0].title);
		expect(report.summary.checks).toBe(report.findings.length);
	});
});

describe('helpers', () => {
	it('recognises both the versioned and legacy loader URLs', () => {
		expect(isEmbedRelated('https://three.ws/agent-3d/1.5.2/agent-3d.js')).toBe(true);
		expect(isEmbedRelated('https://three.ws/embed.js')).toBe(true);
		expect(isEmbedRelated('https://cdn.jsdelivr.net/npm/three')).toBe(false);
	});

	it('treats platform and asset-CDN hosts as embed traffic', () => {
		expect(isEmbedRelated('https://three.ws/api/agents/x')).toBe(true);
		expect(isEmbedRelated('https://storage.googleapis.com/three-ws/body.glb')).toBe(true);
		expect(isEmbedRelated('https://analytics.example/p.gif')).toBe(false);
	});

	it('does not mistake a lookalike hostname for the platform', () => {
		expect(isEmbedRelated('https://three.ws.evil.example/agent.js')).toBe(false);
		expect(isEmbedRelated('https://notthree.ws/x.js')).toBe(false);
	});

	it('probes with a selector covering every tag a platform loader registers', () => {
		expect(EMBED_TAGS).toContain(EMBED_TAG);
		expect(EMBED_SELECTOR.split(',')).toEqual(EMBED_TAGS);
		// The v1 loader's aliases, which public/embed/v1.js defines.
		for (const alias of ['three-d', 'three-agent', 'three-ws']) {
			expect(EMBED_TAGS).toContain(alias);
		}
	});

	it('detects the wording browsers actually use for a CSP refusal', () => {
		expect(looksLikeCspBlock("Refused to load the script 'https://three.ws/x.js'")).toBe(true);
		expect(looksLikeCspBlock('because it violates the following Content Security Policy directive')).toBe(true);
		expect(looksLikeCspBlock('Failed to fetch')).toBe(false);
		expect(looksLikeCspBlock('')).toBe(false);
	});

	it('builds a sandbox page that adds nothing the snippet could trip over', () => {
		const html = snippetHostHtml(`<${EMBED_TAG} agent-id="x"></${EMBED_TAG}>`);
		expect(html).toContain(`<${EMBED_TAG} agent-id="x">`);
		expect(html).toContain('<!doctype html>');
		// No framework, no CSP, no third-party script: any failure belongs to the
		// snippet rather than the harness.
		expect(html).not.toMatch(/<script src=/i);
		expect(html).not.toMatch(/content-security-policy/i);
	});
});
