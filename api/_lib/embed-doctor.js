// Embed Doctor — tells a developer exactly why their `<agent-3d>` embed is not
// showing up, by loading their real page in a real browser and watching it boot.
//
// The problem it replaces: an embed that renders nothing produces no error the
// developer can act on. The tag is present, the console may be empty, and the
// cause is one of a dozen unrelated things — a Content-Security-Policy that
// silently dropped the module, a container with zero height, a private agent id,
// WebGL disabled in a hardened browser, a copy-pasted duplicate script. Until
// now the answer lived in a wall of troubleshooting prose in the embed tutorial,
// which is documentation standing in for a missing tool.
//
// ── Shape ─────────────────────────────────────────────────────────────────────
// The module is split so the decision logic never needs a browser:
//
//   collectFromUrl / collectFromSnippet → an `observations` object (raw facts)
//   analyze(observations)               → { verdict, findings[] }   ← PURE
//
// `analyze` is a pure function over a plain object. Every rule in it is unit
// tested against synthetic observations, so the catalogue of failures is
// verified without booting chromium. The browser layer only gathers facts; it
// never decides anything.
//
// ── Honesty rules ─────────────────────────────────────────────────────────────
// Two behaviours exist to stop the report lying, and they matter more than any
// individual check:
//
//   1. A check that could not run reports `status: 'unknown'`, never `'pass'`.
//      Reporting an unrun check as healthy is how a diagnostic tool teaches
//      people to distrust it.
//   2. Findings are ordered by how much they explain. The first finding is the
//      one to fix; the rest are frequently downstream of it (a blocked loader
//      guarantees an un-upgraded element, and saying both with equal weight
//      sends the developer to the wrong line).

import { assertSafePublicUrl, SsrfBlockedError } from './ssrf-guard.js';

/** The canonical custom element, used in every fix snippet the report writes. */
export const EMBED_TAG = 'agent-3d';

/** Every element name a platform loader registers. `agent-3d` comes from the
 *  full runtime (src/element.js); the three aliases come from the lightweight
 *  v1 loader (public/embed/v1.js), which is what the gated-embed snippet in
 *  api/embed/gate-create.js hands developers. Recognising only the first one
 *  made the doctor report a perfectly healthy v1 embed as "never upgraded". */
export const EMBED_TAGS = ['agent-3d', 'three-d', 'three-agent', 'three-ws'];

/** One CSS selector matching any of {@link EMBED_TAGS}, for the in-page probes. */
export const EMBED_SELECTOR = EMBED_TAGS.join(',');

/** Loader bundles that register an element in {@link EMBED_TAGS}. Order is
 *  longest-first so a versioned path is recognised before the generic prefix
 *  match. */
export const LOADER_PATTERNS = [
	/\/agent-3d\/[^/]+\/agent-3d(\.min)?\.js(\?|$)/i,
	/\/embed(\/v1)?\.js(\?|$)/i,
];

/** Attributes that give the element something to load. Without one of these the
 *  element deliberately does nothing (see `src/element.js` → `_hasSource`). */
export const SOURCE_ATTRIBUTES = ['agent-id', 'src', 'manifest', 'body', 'avatar-id'];

const SEVERITY_RANK = { fatal: 0, error: 1, warn: 2, info: 3 };

/** Verdict from the worst severity present. */
function verdictFor(findings) {
	const failing = findings.filter((f) => f.status === 'fail');
	if (failing.some((f) => f.severity === 'fatal')) return 'broken';
	if (failing.some((f) => f.severity === 'error')) return 'broken';
	if (failing.some((f) => f.severity === 'warn')) return 'degraded';
	if (findings.some((f) => f.status === 'unknown')) return 'inconclusive';
	return 'healthy';
}

function isLoaderUrl(url) {
	if (!url) return false;
	return LOADER_PATTERNS.some((re) => re.test(String(url)));
}

/**
 * Classify a URL as belonging to the embed runtime so network noise from the
 * host page (analytics, fonts, the site's own bundles) never lands in a report
 * about the embed.
 */
export function isEmbedRelated(url, { platformOrigin = 'https://three.ws' } = {}) {
	if (!url) return false;
	const s = String(url);
	if (isLoaderUrl(s)) return true;
	try {
		const host = new URL(s, platformOrigin).host;
		const platformHost = new URL(platformOrigin).host;
		if (host === platformHost) return true;
		// The runtime pulls model + animation bytes from the asset CDN.
		return /(^|\.)three\.ws$/i.test(host) || /(^|\.)storage\.googleapis\.com$/i.test(host);
	} catch {
		return false;
	}
}

/**
 * Does this console message describe the browser refusing to run the loader?
 * CSP violations are the single most common invisible cause: the tag is in the
 * DOM, the file is fine, and the browser declined to execute it.
 */
export function looksLikeCspBlock(text) {
	if (!text) return false;
	return /refused to (load|execute|connect)|content security policy|violates the following/i.test(
		String(text),
	);
}

// ── Finding constructors ──────────────────────────────────────────────────────
// Each returns the full user-facing record: what is wrong, the evidence that
// proves it, and the exact change that fixes it. A finding with no `fix` is a
// finding the developer cannot act on, so every failure carries one.

function finding(id, severity, status, title, detail, fix, evidence) {
	return { id, severity, status, title, detail, fix, evidence: evidence ?? null };
}

const pass = (id, title, detail, evidence) =>
	finding(id, 'info', 'pass', title, detail, null, evidence);
const unknown = (id, title, detail, evidence) =>
	finding(id, 'info', 'unknown', title, detail, null, evidence);

/**
 * Turn raw page observations into a ranked, actionable report.
 *
 * Pure: no I/O, no clock, no randomness. Everything it knows arrives in `obs`.
 *
 * @param {object} obs Observations from {@link collectFromUrl} or {@link collectFromSnippet}.
 * @returns {{verdict: string, findings: object[], summary: object}}
 */
export function analyze(obs) {
	const findings = [];
	const page = obs?.page || {};
	const el = obs?.element || null;
	const net = Array.isArray(obs?.network) ? obs.network : [];
	const consoleMsgs = Array.isArray(obs?.console) ? obs.console : [];
	const pageErrors = Array.isArray(obs?.pageErrors) ? obs.pageErrors : [];
	const scripts = Array.isArray(obs?.scripts) ? obs.scripts : [];
	// Name the tag the developer actually wrote. Falling back to the canonical
	// one only matters when there is no element to name.
	const tag = EMBED_TAGS.includes(el?.tag) ? el.tag : EMBED_TAG;

	// ── 1. The page itself ────────────────────────────────────────────────────
	if (page.reachable === false) {
		findings.push(
			finding(
				'page_unreachable',
				'fatal',
				'fail',
				'The page could not be loaded',
				page.error
					? `Loading the URL failed: ${page.error}`
					: 'The browser could not load this URL, so nothing about the embed could be checked.',
				'Confirm the page is published and reachable from the public internet. A page behind a login, a firewall, or on localhost cannot be inspected from our servers — use the snippet mode instead and paste the two tags directly.',
				{ status: page.status ?? null, error: page.error ?? null },
			),
		);
		// Nothing downstream is knowable. Return early rather than reporting a
		// cascade of "missing" findings that are all the same problem.
		return { verdict: 'broken', findings, summary: summarize(findings, obs) };
	}
	if (page.status && page.status >= 400) {
		findings.push(
			finding(
				'page_error_status',
				'fatal',
				'fail',
				`The page returned HTTP ${page.status}`,
				'The server answered with an error status, so the browser rendered an error page rather than your site.',
				'Check the URL for a typo and confirm the page is published. If the page requires a login, our servers see the signed-out version.',
				{ status: page.status, finalUrl: page.finalUrl ?? null },
			),
		);
		return { verdict: 'broken', findings, summary: summarize(findings, obs) };
	}

	// ── 2. The loader script ──────────────────────────────────────────────────
	const loaderTags = scripts.filter((s) => isLoaderUrl(s.src));
	const loaderRequests = net.filter((r) => isLoaderUrl(r.url));
	const loaderOk = loaderRequests.find((r) => r.ok);
	const cspMessages = consoleMsgs.filter((m) => looksLikeCspBlock(m.text));

	if (!loaderTags.length && !loaderRequests.length) {
		findings.push(
			finding(
				'loader_missing',
				'fatal',
				'fail',
				'The embed runtime script is not on the page',
				`Nothing on the page loads the three.ws runtime, so <${EMBED_TAG}> is never registered as a custom element and the browser treats it as an unknown, invisible tag.`,
				'Add the loader above your embed tag:\n<script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>',
				{ scriptsSeen: scripts.slice(0, 12).map((s) => s.src).filter(Boolean) },
			),
		);
	} else if (cspMessages.length && !loaderOk) {
		findings.push(
			finding(
				'loader_blocked_csp',
				'fatal',
				'fail',
				'Your Content-Security-Policy blocked the runtime',
				'The script tag is on the page but the browser refused to execute it. This is the most common cause of an embed that fails silently: there is no visible error, and the console message is easy to miss.',
				"Allow the three.ws origin in your CSP. At minimum:\nscript-src 'self' https://three.ws;\nconnect-src 'self' https://three.ws;\nimg-src 'self' data: blob: https://three.ws;\nworker-src 'self' blob:;",
				{
					csp: page.csp ?? null,
					messages: cspMessages.slice(0, 3).map((m) => m.text),
				},
			),
		);
	} else if (loaderRequests.length && !loaderOk) {
		const failed = loaderRequests[0];
		findings.push(
			finding(
				'loader_failed',
				'fatal',
				'fail',
				'The runtime script failed to download',
				failed.failure
					? `The request for the runtime failed: ${failed.failure}`
					: `The runtime URL answered HTTP ${failed.status}, so no code ran.`,
				'Check the src for a typo. The current URL is https://three.ws/agent-3d/latest/agent-3d.js — a pinned version must exist (for example /agent-3d/1.5.2/agent-3d.js).',
				{ url: failed.url, status: failed.status ?? null, failure: failed.failure ?? null },
			),
		);
	} else if (loaderOk) {
		findings.push(
			pass(
				'loader_loaded',
				'The embed runtime loaded',
				`The runtime downloaded successfully${loaderOk.bytes ? ` (${Math.round(loaderOk.bytes / 1024)} KB)` : ''}.`,
				{ url: loaderOk.url, status: loaderOk.status ?? 200 },
			),
		);
	} else {
		findings.push(
			unknown(
				'loader_loaded',
				'Could not confirm the runtime loaded',
				'A loader tag is present but no matching network request was observed before the check timed out.',
				{ tags: loaderTags.map((s) => s.src) },
			),
		);
	}

	// A module bundle loaded without type="module" throws a syntax error on its
	// first `import` and registers nothing — a one-word fix that is invisible
	// unless you read the console carefully.
	const moduleLoaders = loaderTags.filter((s) => /\/agent-3d\//i.test(String(s.src)));
	const nonModule = moduleLoaders.filter((s) => (s.type || '').toLowerCase() !== 'module');
	if (moduleLoaders.length && nonModule.length === moduleLoaders.length) {
		findings.push(
			finding(
				'loader_not_module',
				'error',
				'fail',
				'The runtime script is missing type="module"',
				'The agent-3d bundle is an ES module. Loaded as a classic script it fails on its first import statement and registers nothing.',
				'Add type="module" to the script tag:\n<script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>',
				{ tags: nonModule.map((s) => ({ src: s.src, type: s.type || '(none)' })) },
			),
		);
	}

	if (loaderTags.length > 1) {
		findings.push(
			finding(
				'duplicate_loader',
				'warn',
				'fail',
				`The runtime is loaded ${loaderTags.length} times`,
				'Each copy downloads and parses the full bundle. The first one wins the custom-element registration, so the extra copies are pure download cost for your visitors.',
				'Keep exactly one loader script tag, usually in your site template rather than on individual pages.',
				{ srcs: loaderTags.map((s) => s.src) },
			),
		);
	}

	// ── 3. The element ────────────────────────────────────────────────────────
	if (!el && obs?.probeFailed) {
		// The DOM was never read, so "no element" is not a fact we hold. Saying it
		// anyway would send a developer hunting for a tag that is right there.
		findings.push(
			unknown(
				'page_not_inspected',
				'The page could not be inspected in the time available',
				obs.timedOut
					? 'The page was still busy when the time budget ran out, so its contents were never read. A page that keeps the browser occupied this long usually has heavy scripts of its own running ahead of the embed.'
					: 'The browser closed the page before its contents could be read, so nothing below the loader is knowable.',
				{ timedOut: !!obs.timedOut },
			),
		);
		return { verdict: verdictFor(findings), findings: rank(findings), summary: summarize(findings, obs) };
	}
	if (!el || !el.count) {
		findings.push(
			finding(
				'element_missing',
				'fatal',
				'fail',
				`There is no <${EMBED_TAG}> element on the page`,
				`The runtime only renders where you place the tag. With no <${EMBED_TAG}> in the DOM there is nothing for it to bring to life.`,
				`Add the element where you want the agent to appear:\n<${EMBED_TAG} agent-id="YOUR_AGENT_ID" mode="floating"></${EMBED_TAG}>\n\nCustom elements are never self-closing — the separate closing tag is required.`,
				null,
			),
		);
		return { verdict: verdictFor(findings), findings: rank(findings), summary: summarize(findings, obs) };
	}

	if (el.count > 1) {
		findings.push(
			finding(
				'duplicate_element',
				'warn',
				'fail',
				`There are ${el.count} embed elements on this page`,
				'Each element boots its own WebGL context and downloads its own model. Browsers cap the number of live contexts, so beyond a handful the later ones silently fail to render.',
				'Keep one element per page unless you deliberately want several agents on screen at once.',
				{ count: el.count },
			),
		);
	}

	if (el.defined === true) {
		findings.push(
			pass(
				'element_upgraded',
				'The element was upgraded by the runtime',
				`customElements.get('${tag}') resolved, so the tag is a live component rather than an unknown element.`,
				null,
			),
		);
	} else if (el.defined === false) {
		findings.push(
			finding(
				'element_not_upgraded',
				'fatal',
				'fail',
				'The element was never upgraded',
				`The tag is in the DOM but the browser does not know what <${tag}> is, so it renders as an empty inline element with no size. This is always a consequence of the runtime not executing.`,
				'Fix the loader finding above first. If the loader reports healthy, check that the script tag comes from https://three.ws and is not deferred behind a consent gate that never fires.',
				null,
			),
		);
	} else {
		findings.push(unknown('element_upgraded', 'Could not confirm the element was upgraded', 'The page did not finish booting within the time budget.', null));
	}

	// ── 4. What the element was told to load ──────────────────────────────────
	const source = SOURCE_ATTRIBUTES.find((a) => el.attributes && el.attributes[a]);
	if (!source) {
		findings.push(
			finding(
				'source_missing',
				'fatal',
				'fail',
				'The element has nothing to load',
				`<${tag}> stays deliberately inert until it is given a source. Without one of ${SOURCE_ATTRIBUTES.map((a) => `\`${a}\``).join(', ')} it renders nothing rather than guessing.`,
				`Add your agent id:\n<${tag} agent-id="YOUR_AGENT_ID" mode="floating"></${tag}>\n\nYour agent id is the string after /agent/ in its three.ws profile URL.`,
				{ attributes: el.attributes || {} },
			),
		);
	} else if (source === 'agent-id' && obs.agent) {
		if (obs.agent.resolved === false) {
			findings.push(
				finding(
					'agent_unresolved',
					'fatal',
					'fail',
					'That agent id does not resolve',
					obs.agent.error
						? `Looking the agent up returned: ${obs.agent.error}`
						: 'The platform has no public agent with that id, so the runtime has no body, personality, or animations to load.',
					'Copy the id again from the agent\'s profile URL (the part after /agent/). If the agent is private, publish it or embed one that is public — the embed runs in your visitors\' browsers and can only read public agents.',
					{ agentId: obs.agent.id, status: obs.agent.status ?? null },
				),
			);
		} else if (obs.agent.resolved === true) {
			findings.push(
				pass(
					'agent_resolved',
					'The agent id resolves',
					obs.agent.name
						? `The embed points at "${obs.agent.name}", which is public and loadable.`
						: 'The agent exists and is publicly readable.',
					{ agentId: obs.agent.id },
				),
			);
		}
	}

	// ── 5. Is it actually visible? ────────────────────────────────────────────
	// An embed that boots perfectly and is 0px tall is indistinguishable from a
	// broken one at the only place it matters: the visitor's screen.
	const rect = el.rect || null;
	const styles = el.styles || {};
	const hiddenReason =
		styles.display === 'none'
			? 'display: none'
			: styles.visibility === 'hidden'
				? 'visibility: hidden'
				: Number(styles.opacity) === 0
					? 'opacity: 0'
					: null;

	if (hiddenReason) {
		findings.push(
			finding(
				'element_hidden',
				'error',
				'fail',
				'The embed is hidden by CSS',
				`The element resolves to ${hiddenReason}, usually inherited from a collapsed parent (a closed accordion, an inactive tab panel, or a "hidden until loaded" wrapper that never un-hides).`,
				'Inspect the element in devtools and walk up the tree to find the ancestor applying it. If the embed lives inside a tab or accordion, mount it when that panel opens rather than hiding it.',
				{ styles, hiddenBy: el.hiddenAncestor || null },
			),
		);
	} else if (rect && (rect.width < 2 || rect.height < 2)) {
		findings.push(
			finding(
				'element_zero_size',
				'error',
				'fail',
				`The embed has no size (${Math.round(rect.width)}×${Math.round(rect.height)}px)`,
				'In inline mode the element fills its container, and a container with no height collapses it to nothing. The runtime is running correctly and drawing into a box with zero area.',
				`Give the element or its parent a height:\n<${tag} agent-id="…" style="display:block;width:100%;height:480px"></${tag}>\n\nOr switch to mode="floating", which pins itself to a corner and sizes itself.`,
				{ rect, mode: el.attributes?.mode || '(default)' },
			),
		);
	} else if (rect) {
		findings.push(
			pass(
				'element_visible',
				`The embed occupies ${Math.round(rect.width)}×${Math.round(rect.height)}px`,
				'The element has real layout size and is not hidden by CSS.',
				{ rect },
			),
		);
	}

	// Clipping is checked even when the element itself measures fine, because
	// that is exactly the case: every style on the element is correct and an
	// ancestor is throwing the pixels away.
	if (el.clippedBy) {
		findings.push(
			finding(
				'element_clipped',
				'error',
				'fail',
				'An ancestor is clipping the embed out of view',
				`The element has real size, but \`${el.clippedBy.selector}\` is ${el.clippedBy.width}×${el.clippedBy.height}px with \`overflow: ${el.clippedBy.overflow}\`, so the agent is drawn and then cut away. Everything about the embed itself is correct here.`,
				`Give \`${el.clippedBy.selector}\` room, or move the embed out of it. If that wrapper is a collapsed accordion or an inactive carousel slide, mount the embed when the panel opens instead of hiding it.`,
				el.clippedBy,
			),
		);
	}

	if (el.offscreen === true) {
		findings.push(
			finding(
				'element_offscreen',
				'warn',
				'fail',
				'The embed sits outside the visible viewport',
				'It renders, but at a position no visitor scrolls to. This is usually an absolutely-positioned ancestor with a negative offset.',
				'Check for a parent with a negative top/left or a transform that moves it off-canvas.',
				{ rect },
			),
		);
	}

	// ── 6. Can the browser draw 3D at all? ────────────────────────────────────
	if (obs.webgl?.available === false) {
		findings.push(
			finding(
				'webgl_unavailable',
				'fatal',
				'fail',
				'WebGL is unavailable in this browser session',
				'The runtime needs a WebGL2 context to draw. Without one it cannot render regardless of how correct your markup is. Hardened browsers, some privacy extensions, and remote desktop sessions all disable it.',
				'Test in a standard browser profile with hardware acceleration enabled. For visitors who genuinely cannot run WebGL, render a static portrait instead: https://three.ws/api/avatar/render?avatar=YOUR_AVATAR_ID',
				{ renderer: obs.webgl?.renderer || null },
			),
		);
	} else if (obs.webgl?.available === true) {
		findings.push(
			pass('webgl_available', 'WebGL is available', obs.webgl.renderer ? `Renderer: ${obs.webgl.renderer}` : 'The browser can create a WebGL context.', null),
		);
	}

	// ── 7. Did anything actually get drawn? ───────────────────────────────────
	const canvas = el.canvas || null;
	if (canvas?.present === true && canvas.blank === false) {
		findings.push(
			pass(
				'canvas_rendered',
				'The agent rendered pixels',
				`A ${Math.round(canvas.width)}×${Math.round(canvas.height)}px canvas is drawing inside the element.`,
				{ width: canvas.width, height: canvas.height },
			),
		);
	} else if (canvas?.present === true && canvas.blank === null) {
		// The canvas exists with real dimensions but the paint measurement could
		// not run (an off-screen box, a screenshot that failed). Reporting it as
		// blank would invent a failure; reporting it as rendered would invent a
		// success.
		findings.push(
			unknown(
				'canvas_rendered',
				'A canvas exists, but we could not confirm it painted',
				`The element built a ${Math.round(canvas.width)}×${Math.round(canvas.height)}px drawing surface. Measuring whether pixels landed in it needs the element inside the viewport, and it was not.`,
				{ width: canvas.width, height: canvas.height },
			),
		);
	} else if (canvas?.present === true && canvas.blank === true) {
		findings.push(
			finding(
				'canvas_blank',
				'warn',
				'fail',
				'The canvas is present but still blank',
				'The runtime created its drawing surface but had not painted a frame when we looked. On a slow connection the model may simply still be downloading; if it stays blank, the model bytes failed.',
				'Re-run the check. If it stays blank, look at the failed-request finding below — a 404 or CORS failure on the model is the usual cause.',
				{ width: canvas.width, height: canvas.height },
			),
		);
	} else if (el.defined === true) {
		findings.push(
			finding(
				'canvas_missing',
				'error',
				'fail',
				'No canvas was created',
				'The element upgraded but never built its renderer, which means it stopped during boot rather than while drawing.',
				'Check the console findings below for the error the runtime threw, and confirm the agent id resolves.',
				null,
			),
		);
	}

	// ── 8. Transport-level problems ───────────────────────────────────────────
	if (page.https === true) {
		const insecure = net.filter((r) => /^http:\/\//i.test(String(r.url)) && isEmbedRelated(r.url));
		if (insecure.length) {
			findings.push(
				finding(
					'mixed_content',
					'error',
					'fail',
					'Insecure requests on an HTTPS page',
					'The browser blocks plain-http subresources on an https page. Any embed asset requested over http is dropped before it reaches the network.',
					'Change every three.ws URL in your markup from http:// to https://.',
					{ urls: insecure.slice(0, 5).map((r) => r.url) },
				),
			);
		}
	}

	const failedEmbedRequests = net.filter(
		(r) => !r.ok && isEmbedRelated(r.url) && !isLoaderUrl(r.url),
	);
	if (failedEmbedRequests.length) {
		findings.push(
			finding(
				'asset_requests_failed',
				'error',
				'fail',
				`${failedEmbedRequests.length} embed request${failedEmbedRequests.length === 1 ? '' : 's'} failed`,
				'The runtime booted but could not fetch something it needs — typically the agent manifest or the GLB body.',
				'Open each URL below directly. A 404 means the agent or its model was removed; a CORS error means a proxy in front of your site is rewriting the request.',
				{
					requests: failedEmbedRequests.slice(0, 6).map((r) => ({
						url: r.url,
						status: r.status ?? null,
						failure: r.failure ?? null,
					})),
				},
			),
		);
	}

	// ── 9. What the page said out loud ────────────────────────────────────────
	const relevantErrors = [
		...pageErrors,
		...consoleMsgs.filter((m) => m.type === 'error').map((m) => m.text),
	].filter(Boolean);
	if (relevantErrors.length) {
		findings.push(
			finding(
				'console_errors',
				'warn',
				'fail',
				`${relevantErrors.length} console error${relevantErrors.length === 1 ? '' : 's'} on the page`,
				'Errors from anywhere on the page are listed because a crash in unrelated code can abort the script that would have booted the embed.',
				'Read the messages below in order. The first one is usually the cause; the rest are often consequences of it.',
				{ messages: relevantErrors.slice(0, 6).map((t) => String(t).slice(0, 400)) },
			),
		);
	}

	if (typeof el.bootMs === 'number' && el.bootMs > 6000) {
		findings.push(
			finding(
				'slow_boot',
				'warn',
				'fail',
				`The agent took ${(el.bootMs / 1000).toFixed(1)}s to appear`,
				'It works, but a visitor on a slower connection may leave before the agent arrives.',
				'Pin a version instead of "latest" so the bundle caches for longer, and keep the model under a few megabytes.',
				{ bootMs: el.bootMs },
			),
		);
	}

	return { verdict: verdictFor(findings), findings: rank(findings), summary: summarize(findings, obs) };
}

/** Failures first, worst severity first, then passes. Stable within a bucket so
 *  the report reads in the order the checks run. */
function rank(findings) {
	return findings
		.map((f, i) => ({ f, i }))
		.sort((a, b) => {
			const af = a.f.status === 'fail' ? 0 : a.f.status === 'unknown' ? 1 : 2;
			const bf = b.f.status === 'fail' ? 0 : b.f.status === 'unknown' ? 1 : 2;
			if (af !== bf) return af - bf;
			const as = SEVERITY_RANK[a.f.severity] ?? 9;
			const bs = SEVERITY_RANK[b.f.severity] ?? 9;
			if (as !== bs) return as - bs;
			return a.i - b.i;
		})
		.map((x) => x.f);
}

function summarize(findings, obs) {
	const failed = findings.filter((f) => f.status === 'fail');
	return {
		checks: findings.length,
		failed: failed.length,
		passed: findings.filter((f) => f.status === 'pass').length,
		unknown: findings.filter((f) => f.status === 'unknown').length,
		headline: failed.length ? failed[0].title : 'The embed is working',
		target: obs?.target || null,
	};
}

// ── Browser layer ─────────────────────────────────────────────────────────────
// Everything below drives a real chromium. It gathers facts and hands them to
// `analyze`; it makes no judgements of its own.

const DEFAULT_CHROMIUM_PACK =
	'https://github.com/Sparticuz/chromium/releases/download/v148.0.0/chromium-v148.0.0-pack.x64.tar';

let _browserPromise = null;

/**
 * Boot (or reuse) a headless chromium. Mirrors `render-clip.js`: puppeteer-core
 * plus @sparticuz/chromium-min are imported lazily so route bundling never has
 * to statically trace the chromium tree.
 */
async function getBrowser() {
	if (_browserPromise) return _browserPromise;
	_browserPromise = (async () => {
		const { default: puppeteer } = await import('puppeteer-core');

		// A workstation already has a chromium (the one Playwright installs for
		// the test suite). Pointing at it keeps the diagnostic runnable locally
		// without downloading the 100 MB serverless pack, which is what makes it
		// possible to develop a new check and see it fire on a real page.
		const local = process.env.CHROMIUM_EXECUTABLE_PATH;
		if (local) {
			return puppeteer.launch({
				args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
				defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
				executablePath: local,
				headless: true,
			});
		}

		const { default: chromium } = await import('@sparticuz/chromium-min');
		const pack = process.env.CHROMIUM_PACK_URL || DEFAULT_CHROMIUM_PACK;
		const executablePath = await chromium.executablePath(pack);
		return puppeteer.launch({
			args: chromium.args,
			defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
			executablePath,
			headless: chromium.headless,
		});
	})().catch((err) => {
		_browserPromise = null;
		throw err;
	});
	return _browserPromise;
}

/** Released between requests in serverless-style environments where a warm
 *  browser would outlive its usefulness. Safe to call when none is open. */
export async function closeBrowser() {
	const p = _browserPromise;
	_browserPromise = null;
	if (!p) return;
	try {
		const b = await p;
		await b.close();
	} catch {
		/* already gone */
	}
}

/** Runs inside the page. Returns the DOM facts `analyze` needs. Written as a
 *  plain string-serialisable function: it cannot close over anything.
 *  `selector` matches every tag in EMBED_TAGS, so a page using the v1 loader's
 *  <three-d> is inspected exactly like one using <agent-3d>. */
function inPageProbe(selector, sourceAttrs) {
	function deepQueryAll(selector) {
		const out = [];
		const walk = (root) => {
			for (const el of root.querySelectorAll(selector)) out.push(el);
			for (const el of root.querySelectorAll('*')) {
				if (el.shadowRoot) walk(el.shadowRoot);
			}
		};
		walk(document);
		return out;
	}

	const scripts = Array.from(document.querySelectorAll('script[src]')).map((s) => ({
		src: s.getAttribute('src') || '',
		type: s.getAttribute('type') || '',
	}));

	let webglAvailable = false;
	let webglRenderer = null;
	try {
		const c = document.createElement('canvas');
		const gl = c.getContext('webgl2') || c.getContext('webgl');
		if (gl) {
			webglAvailable = true;
			const dbg = gl.getExtension('WEBGL_debug_renderer_info');
			if (dbg) webglRenderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
		}
	} catch {
		webglAvailable = false;
	}

	const els = deepQueryAll(selector);
	let element = null;
	if (els.length) {
		const node = els[0];
		const tag = node.tagName.toLowerCase();
		const cs = getComputedStyle(node);
		const rect = node.getBoundingClientRect();

		const attributes = {};
		for (const a of Array.from(node.attributes || [])) attributes[a.name] = a.value;

		// Which ancestor applies the hiding, so the report can name it rather
		// than telling the developer to go hunting.
		let hiddenAncestor = null;
		for (let p = node; p && p !== document.documentElement; p = p.parentElement) {
			const s = getComputedStyle(p);
			if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) {
				hiddenAncestor =
					p === node
						? 'the element itself'
						: p.tagName.toLowerCase() +
							(p.id ? '#' + p.id : '') +
							(p.className && typeof p.className === 'string'
								? '.' + p.className.trim().split(/\s+/).slice(0, 2).join('.')
								: '');
				break;
			}
		}

		// The runtime draws into a canvas inside its shadow root. Whether it
		// PAINTED cannot be answered here: a WebGL canvas without
		// preserveDrawingBuffer is cleared the moment it composites, so reading
		// it back in-page reports a blank surface for a perfectly good render.
		// The screenshot pass in `harvest` answers that from composited pixels
		// instead; `blank` is deliberately left null until then.
		let canvas = { present: false, width: 0, height: 0, blank: null };
		const root = node.shadowRoot || node;
		const cv = root.querySelector('canvas');
		if (cv) canvas = { present: true, width: cv.width, height: cv.height, blank: null };

		// An ancestor that clips is the other way an embed disappears while every
		// style on the element itself looks correct: a collapsed accordion, a
		// carousel slide, or a "height: 0 until loaded" wrapper that never grows.
		let clippedBy = null;
		for (let p = node.parentElement; p && p !== document.documentElement; p = p.parentElement) {
			const s = getComputedStyle(p);
			const clips = s.overflow !== 'visible' || s.overflowX !== 'visible' || s.overflowY !== 'visible';
			if (!clips) continue;
			const pr = p.getBoundingClientRect();
			const noRoom = pr.width < 2 || pr.height < 2;
			const outside =
				rect.bottom <= pr.top || rect.top >= pr.bottom ||
				rect.right <= pr.left || rect.left >= pr.right;
			if (noRoom || outside) {
				clippedBy = {
					selector:
						p.tagName.toLowerCase() +
						(p.id ? '#' + p.id : '') +
						(p.className && typeof p.className === 'string'
							? '.' + p.className.trim().split(/\s+/).slice(0, 2).join('.')
							: ''),
					width: Math.round(pr.width),
					height: Math.round(pr.height),
					overflow: s.overflow,
				};
				break;
			}
		}

		element = {
			count: els.length,
			tag,
			defined: !!(window.customElements && window.customElements.get(tag)),
			attributes,
			rect: { width: rect.width, height: rect.height, top: rect.top, left: rect.left },
			styles: { display: cs.display, visibility: cs.visibility, opacity: cs.opacity },
			hiddenAncestor,
			offscreen:
				rect.width > 0 &&
				rect.height > 0 &&
				(rect.bottom < 0 ||
					rect.right < 0 ||
					rect.left > document.documentElement.clientWidth ||
					rect.top > document.documentElement.scrollHeight),
			canvas,
			clippedBy,
			source: sourceAttrs.find((a) => attributes[a]) || null,
		};
	}

	return {
		scripts,
		element,
		webgl: { available: webglAvailable, renderer: webglRenderer },
		title: document.title || '',
	};
}

/**
 * Wait until the embed has clearly settled — a painted canvas — or the budget
 * runs out. Polls rather than racing a fixed sleep so a fast page returns fast
 * and a slow one still gets its full allowance.
 */
async function waitForEmbed(page, selector, budgetMs) {
	const started = Date.now();
	while (Date.now() - started < budgetMs) {
		const state = await page
			.evaluate((sel) => {
				const el = document.querySelector(sel);
				if (!el) return { canBoot: false, painted: false };
				const root = el.shadowRoot || el;
				const cv = root.querySelector('canvas');
				return {
					canBoot: !!(
						window.customElements && window.customElements.get(el.tagName.toLowerCase())
					),
					painted: !!(cv && cv.width > 0 && cv.height > 0),
				};
			}, selector)
			.catch(() => ({ canBoot: false, painted: false }));

		if (state.painted) return Date.now() - started;

		// Nothing to wait for. With no element in the DOM, or an element the
		// runtime never registered, a canvas will never appear and burning the
		// remaining budget only makes the developer stare at a spinner for the
		// most common failures of all.
		if (!state.canBoot && Date.now() - started > 1200) return null;

		await new Promise((r) => setTimeout(r, 250));
	}
	return null;
}

/**
 * Did the embed actually paint? Answered from composited pixels, because the
 * canvas itself cannot be read back (see the note in the in-page probe).
 * A screenshot of the element's box is measured for per-channel variance: a
 * flat fill has none, a rendered character has plenty.
 *
 * Returns null when the question could not be answered, never a guess.
 */
async function measurePainted(page, selector, budgetMs) {
	const deadline = Date.now() + budgetMs;
	try {
		const box = await withDeadline(page.evaluate((sel) => {
			const el = document.querySelector(sel);
			if (!el) return null;
			const r = el.getBoundingClientRect();
			if (r.width < 4 || r.height < 4) return null;
			// Clamp into the viewport: a clip that runs off-screen is rejected by
			// the screenshot API rather than silently shrunk.
			const x = Math.max(0, r.left);
			const y = Math.max(0, r.top);
			const w = Math.min(r.right, window.innerWidth) - x;
			const h = Math.min(r.bottom, window.innerHeight) - y;
			if (w < 4 || h < 4) return null;
			return { x, y, width: w, height: h };
		}, selector), Math.max(1000, deadline - Date.now()), null);
		if (!box) return null;

		const png = await withDeadline(
			page.screenshot({ type: 'png', clip: box }),
			Math.max(1000, deadline - Date.now()),
			null,
		);
		if (!png) return null;
		const { default: sharp } = await import('sharp');
		const stats = await sharp(png).stats();
		// Three channels of near-zero deviation means every pixel is the same
		// colour: the element is on screen and nothing was drawn into it.
		const spread = Math.max(...stats.channels.slice(0, 3).map((c) => c.stdev));
		return spread > 1.5;
	} catch {
		return null;
	}
}

/** Resolve an agent id against the live platform so "that id is wrong" is an
 *  answer the report can give instead of a guess. */
async function resolveAgent(agentId, { platformOrigin, timeoutMs = 6000 } = {}) {
	if (!agentId) return null;
	// Only plain platform ids are resolvable here; CAIP-10 / on-chain forms are
	// resolved by the runtime itself against a registry, so we report unknown
	// rather than pretending to check them.
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentId)) {
		return { id: agentId, resolved: null, note: 'on-chain or URI form, not resolvable here' };
	}
	try {
		const res = await fetch(`${platformOrigin}/api/agents/${encodeURIComponent(agentId)}`, {
			signal: AbortSignal.timeout(timeoutMs),
			headers: { accept: 'application/json' },
		});
		if (!res.ok) {
			return { id: agentId, resolved: false, status: res.status, error: `HTTP ${res.status}` };
		}
		const json = await res.json().catch(() => null);
		const name = json?.name || json?.agent?.name || json?.displayName || null;
		return { id: agentId, resolved: true, status: res.status, name };
	} catch (err) {
		return { id: agentId, resolved: false, error: String(err?.message || err) };
	}
}

/** Attach network + console recorders to a page. Returns the arrays they fill. */
function instrument(page) {
	const network = [];
	const consoleMsgs = [];
	const pageErrors = [];

	page.on('response', (res) => {
		try {
			const headers = res.headers() || {};
			network.push({
				url: res.url(),
				status: res.status(),
				ok: res.status() < 400,
				bytes: Number(headers['content-length']) || null,
			});
		} catch {
			/* response gone */
		}
	});
	page.on('requestfailed', (req) => {
		try {
			network.push({
				url: req.url(),
				status: null,
				ok: false,
				failure: req.failure()?.errorText || 'request failed',
			});
		} catch {
			/* request gone */
		}
	});
	page.on('console', (msg) => {
		try {
			consoleMsgs.push({ type: msg.type(), text: String(msg.text()).slice(0, 600) });
		} catch {
			/* message gone */
		}
	});
	page.on('pageerror', (err) => pageErrors.push(String(err?.message || err).slice(0, 600)));

	return { network, console: consoleMsgs, pageErrors };
}

/** Everything a diagnosis needs from a booted page, once it has settled.
 *  `deadlineAt` is the wall-clock instant every remaining step shares, so a
 *  slow page cannot spend the whole request in one of them. */
async function harvest(page, { recorders, response, bootMs, platformOrigin, screenshot, deadlineAt }) {
	const left = (max) => Math.min(max, Math.max(1000, deadlineAt - Date.now()));

	// A page that never yields its main thread never runs the probe, and
	// `page.evaluate` has no deadline of its own. Giving up on it is "we could
	// not look", not "there is nothing there", and the difference has to survive
	// into the report: honesty rule 1.
	const probed = await withDeadline(
		page.evaluate(inPageProbe, EMBED_SELECTOR, SOURCE_ATTRIBUTES),
		left(PROBE_MAX_MS),
		null,
	);
	const probeFailed = probed === null;
	const probe = probed || {
		scripts: [],
		element: null,
		webgl: { available: null, renderer: null },
		title: '',
	};

	const headers = (() => {
		try {
			return response?.headers?.() || {};
		} catch {
			return {};
		}
	})();

	const finalUrl = page.url();
	const agentId = probe.element?.attributes?.['agent-id'] || null;
	const agent = agentId
		? await resolveAgent(agentId, { platformOrigin, timeoutMs: left(AGENT_LOOKUP_MAX_MS) })
		: null;

	if (probe.element?.canvas?.present) {
		const painted = await measurePainted(page, EMBED_SELECTOR, left(PAINT_MAX_MS));
		probe.element.canvas.blank = painted === null ? null : !painted;
	}

	// A screenshot of a busy WebGL page is the single slowest call here, and it
	// is the least load-bearing: the report is complete without it.
	let shot = null;
	if (screenshot) {
		shot = await withDeadline(
			page.screenshot({ type: 'jpeg', quality: 62, encoding: 'base64', fullPage: false }),
			left(SCREENSHOT_MAX_MS),
			null,
		);
	}

	return {
		page: {
			reachable: true,
			status: response?.status?.() ?? 200,
			finalUrl,
			https: /^https:/i.test(finalUrl),
			csp: headers['content-security-policy'] || null,
			title: probe.title,
		},
		scripts: probe.scripts,
		element: probe.element ? { ...probe.element, bootMs } : null,
		webgl: probe.webgl,
		network: recorders.network,
		console: recorders.console,
		pageErrors: recorders.pageErrors,
		agent,
		screenshot: shot,
		probeFailed,
	};
}

// ── Deadlines ─────────────────────────────────────────────────────────────────
// The caller's `budgetMs` bounds how long the embed is given to paint, and
// navigation has its own timeout, but every remaining page call (the probe, the
// paint measurement, the screenshot) had none. On a page that keeps chromium
// busy those calls dominate: inspecting the three.ws home page took 260 s for a
// 10 s budget, four times the handler's declared 60 s ceiling, holding a request
// and a browser open the whole time. So the whole inspection now shares one
// wall-clock deadline, each step draws from what is left of it, and none of them
// can be the reason a request outlives the handler.

/** Navigation gets its own timeout; a page that will not load is not worth the
 *  rest of the budget. */
const NAV_TIMEOUT_MS = 25000;
/** Per-step ceilings, each also clamped to whatever remains of the deadline. */
const PROBE_MAX_MS = 8000;
const AGENT_LOOKUP_MAX_MS = 6000;
const PAINT_MAX_MS = 8000;
const SCREENSHOT_MAX_MS = 8000;
/** What the harvest steps above may add on top of navigation and the boot
 *  budget, and the hard ceiling on one page's total lifetime. The ceiling is the
 *  number that matters: it keeps the worst case inside the handler's
 *  `maxDuration = 60`, whatever budget the caller asked for. */
const HARVEST_GRACE_MS = 15000;
const MAX_PAGE_LIFETIME_MS = 50000;

function pageDeadline(budgetMs) {
	return Math.min(MAX_PAGE_LIFETIME_MS, NAV_TIMEOUT_MS + budgetMs + HARVEST_GRACE_MS);
}

/**
 * Bound a page call that has no timeout of its own, resolving to `fallback`
 * when the deadline passes or the call rejects. The abandoned call is cancelled
 * for real when the caller closes the page in its `finally`, so nothing is left
 * running behind the response.
 */
function withDeadline(promise, ms, fallback) {
	let timer = null;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => resolve(fallback), ms);
		if (typeof timer.unref === 'function') timer.unref();
	});
	return Promise.race([Promise.resolve(promise).catch(() => fallback), timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

/**
 * Last-resort backstop: close the page once its lifetime is spent, so a call
 * nothing else bounded cannot hold a chromium instance open. Every page API used
 * here treats a rejection as "unknown", so the request unwinds into an honest
 * inconclusive report rather than hanging.
 */
function pageWatchdog(page, ms) {
	const state = { firedAt: null };
	const timer = setTimeout(() => {
		state.firedAt = Date.now();
		page.close().catch(() => {});
	}, ms);
	if (typeof timer.unref === 'function') timer.unref();
	state.clear = () => clearTimeout(timer);
	return state;
}

/**
 * Diagnose a live URL.
 *
 * @param {object} opts
 * @param {string} opts.url            The page to inspect. Validated against the SSRF guard.
 * @param {number} [opts.budgetMs]     How long to wait for the embed to paint.
 * @param {boolean} [opts.screenshot]  Include a base64 JPEG of what actually rendered.
 * @param {string} [opts.platformOrigin]
 */
export async function collectFromUrl({
	url,
	budgetMs = 12000,
	screenshot = true,
	platformOrigin = 'https://three.ws',
} = {}) {
	// The URL comes from an anonymous caller and is fetched by our servers, so
	// it goes through the same guard as every other user-supplied fetch target.
	await assertSafePublicUrl(url, { allowHttp: true });

	const browser = await getBrowser();
	const page = await browser.newPage();
	const target = { kind: 'url', url };
	const lifetimeMs = pageDeadline(budgetMs);
	const deadlineAt = Date.now() + lifetimeMs;
	// The backstop fires a beat after the shared deadline, so the harvest steps
	// get their full allowance and only a call that ignored it loses its page.
	const watchdog = pageWatchdog(page, lifetimeMs + 2000);
	try {
		await page.setUserAgent(
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 three.ws-EmbedDoctor/1.0 (+https://three.ws/embed-doctor)',
		);
		const recorders = instrument(page);
		let response = null;
		try {
			response = await page.goto(url, {
				waitUntil: 'domcontentloaded',
				timeout: NAV_TIMEOUT_MS,
			});
		} catch (err) {
			return {
				target,
				page: { reachable: false, error: String(err?.message || err).slice(0, 300) },
				scripts: [],
				element: null,
				network: recorders.network,
				console: recorders.console,
				pageErrors: recorders.pageErrors,
			};
		}
		const bootMs = await waitForEmbed(page, EMBED_SELECTOR, budgetMs);
		const obs = await harvest(page, {
			recorders,
			response,
			bootMs,
			platformOrigin,
			screenshot,
			deadlineAt,
		});
		return { target, ...obs, timedOut: obs.probeFailed || watchdog.firedAt !== null };
	} finally {
		watchdog.clear();
		await page.close().catch(() => {});
	}
}

/** The minimal, dependency-free host document a snippet is tested inside. Kept
 *  deliberately plain so any failure belongs to the snippet, not the harness. */
export function snippetHostHtml(snippet) {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Embed Doctor sandbox</title>
<style>html,body{margin:0;min-height:100vh;background:#0a0a0a;color:#eee;font:15px/1.5 system-ui,sans-serif}
main{padding:24px;min-height:60vh}</style></head>
<body><main>${snippet}</main></body></html>`;
}

/**
 * Diagnose a snippet before it is deployed anywhere. The snippet is loaded in a
 * blank sandbox page served from the platform origin, so the result isolates
 * mistakes in the markup itself from anything the host site does to it.
 */
export async function collectFromSnippet({
	snippet,
	budgetMs = 12000,
	screenshot = true,
	platformOrigin = 'https://three.ws',
} = {}) {
	const browser = await getBrowser();
	const page = await browser.newPage();
	const target = { kind: 'snippet', snippet: String(snippet).slice(0, 4000) };
	const lifetimeMs = pageDeadline(budgetMs);
	const deadlineAt = Date.now() + lifetimeMs;
	const watchdog = pageWatchdog(page, lifetimeMs + 2000);
	try {
		const recorders = instrument(page);
		// Served from the platform origin so relative URLs and module imports
		// resolve exactly as they would in a browser, which `data:` URLs break.
		let response = null;
		await page.setRequestInterception(true);
		const sandboxUrl = `${platformOrigin}/__embed-doctor-sandbox`;
		page.on('request', (req) => {
			if (req.url() === sandboxUrl) {
				req
					.respond({
						status: 200,
						contentType: 'text/html; charset=utf-8',
						body: snippetHostHtml(snippet),
					})
					.catch(() => {});
				return;
			}
			req.continue().catch(() => {});
		});
		response = await page.goto(sandboxUrl, {
			waitUntil: 'domcontentloaded',
			timeout: NAV_TIMEOUT_MS,
		});
		const bootMs = await waitForEmbed(page, EMBED_SELECTOR, budgetMs);
		const obs = await harvest(page, {
			recorders,
			response,
			bootMs,
			platformOrigin,
			screenshot,
			deadlineAt,
		});
		return { target, ...obs, timedOut: obs.probeFailed || watchdog.firedAt !== null };
	} finally {
		watchdog.clear();
		await page.close().catch(() => {});
	}
}

/** Collect + analyze in one call. */
export async function diagnose(input) {
	const started = Date.now();
	const observations = input.snippet
		? await collectFromSnippet(input)
		: await collectFromUrl(input);
	const report = analyze(observations);
	return {
		...report,
		target: observations.target,
		screenshot: observations.screenshot || null,
		pageTitle: observations.page?.title || null,
		timedOut: !!observations.timedOut,
		durationMs: Date.now() - started,
	};
}

export { SsrfBlockedError };
