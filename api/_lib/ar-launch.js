// AR launch: device-aware "View in your space" routing for a generated GLB.
//
// The pure core behind GET /api/ar (api/ar.js) and the export_ar MCP tool. Given
// a GLB URL and a User-Agent, it decides how to place the model in AR:
//
//   • Android  → Google Scene Viewer via an ARCore intent:// URL (the GLB is the
//                Scene Viewer source), with a browser fallback to the WebGL viewer.
//   • iOS / desktop / any live avatar → a 302 to /ar/view (pages/ar-view.html,
//                src/ar-view.js), a Vite-bundled page that generates a real USDZ
//                from the GLB on the device (three.js USDZExporter) and sets it
//                as <model-viewer>'s ios-src before Quick Look is offered.
//                <model-viewer> does NOT convert GLB to USDZ on its own: an
//                earlier version of this file inlined a <model-viewer> with no
//                ios-src and a comment claiming otherwise, which is why iOS
//                visitors silently fell back to the plain 3D viewer instead of
//                Quick Look. Never inline that HTML again: any surface that
//                needs real Quick Look must route through a page Vite bundles
//                (bare `three` imports don't resolve in a raw server-rendered
//                string or an unbundled static file).
//
// AR here is not a prop viewer: it is how three.ws agents cross into physical
// space. A static object gets Quick Look / Scene Viewer placement; a LIVE asset
// (a rigged avatar, an agent's body) additionally gets the IRL handoff
// (/irl?avatar=<glb>): camera passthrough, animation, movement, and conversation
// with the AI in the user's real room. `live: true` in planArLaunch marks that
// lane; it keeps Android on /ar/view (instead of the blind Scene Viewer
// redirect) so the living-agent path is always visible.
//
// It is dependency-free and side-effect-free so the routing decision is unit-
// tested in isolation, and carries ZERO payment/wallet/coin surface: AR is pure
// consumer value and ships on both the Claude and OpenAI tracks.

// A GLB URL must be https and point at a .glb/.gltf asset (query string allowed).
// AR viewers refuse other schemes, and we never hand a non-https URL to a device
// AR intent. Returns the normalized URL or throws a coded error the boundary maps
// to a clean message.
export function assertArAssetUrl(glbUrl) {
	let u;
	try {
		u = new URL(String(glbUrl));
	} catch {
		throw arError('invalid_url', 'Provide a valid https URL to a .glb model.');
	}
	if (u.protocol !== 'https:') throw arError('not_https', 'The model URL must be https.');
	if (!/\.(glb|gltf)$/i.test(u.pathname)) throw arError('not_glb', 'The model URL must point at a .glb or .gltf file.');
	return u.toString();
}

function arError(code, message) {
	const e = new Error(message);
	e.code = code;
	e.arUserMessage = true;
	return e;
}

/** Classify the AR target from a User-Agent string. */
export function detectArTarget(userAgent) {
	const ua = String(userAgent || '');
	// iPadOS 13+ reports a Mac UA; the "Mobile" token + touch is the tell, but
	// server-side we only have the string, so match the explicit iOS device tokens.
	if (/\b(iphone|ipad|ipod)\b/i.test(ua)) return 'ios';
	if (/\bandroid\b/i.test(ua)) return 'android';
	return 'desktop';
}

/**
 * Build the Android Scene Viewer ARCore intent URL for a GLB. `fallbackUrl` is
 * where the browser lands if ARCore is unavailable (the WebGL viewer).
 */
export function buildSceneViewerUrl(glbUrl, { title = '', fallbackUrl = '' } = {}) {
	const params = new URLSearchParams({ file: glbUrl, mode: 'ar_preferred' });
	if (title) params.set('title', title);
	const fallback = fallbackUrl ? `S.browser_fallback_url=${encodeURIComponent(fallbackUrl)};` : '';
	return (
		`intent://arvr.google.com/scene-viewer/1.2?${params.toString()}` +
		`#Intent;scheme=https;package=com.google.ar.core;` +
		`action=android.intent.action.VIEW;${fallback}end;`
	);
}

/** The interactive WebGL viewer URL for a GLB on a given origin. */
export function buildViewerUrl(origin, glbUrl, title = '') {
	const base = String(origin || 'https://three.ws').replace(/\/$/, '');
	const t = title ? `&title=${encodeURIComponent(title)}` : '';
	return `${base}/viewer?src=${encodeURIComponent(glbUrl)}${t}`;
}

/** The device-aware AR launch URL (this endpoint) for a GLB. `live` marks a rigged avatar. */
export function buildArLaunchUrl(origin, glbUrl, title = '', { live = false } = {}) {
	const base = String(origin || 'https://three.ws').replace(/\/$/, '');
	const t = title ? `&title=${encodeURIComponent(title)}` : '';
	const k = live ? '&kind=avatar' : '';
	return `${base}/api/ar?src=${encodeURIComponent(glbUrl)}${t}${k}`;
}

/**
 * The IRL living-agent URL for an avatar GLB: /irl loads it as the user's agent
 * body: camera AR passthrough, retargeted animation, joystick movement, and
 * conversation. The full digital-to-physical experience, not a frozen placement.
 */
export function buildIrlUrl(origin, glbUrl) {
	const base = String(origin || 'https://three.ws').replace(/\/$/, '');
	return `${base}/irl?avatar=${encodeURIComponent(glbUrl)}`;
}

/**
 * The /ar/view URL for a GLB: the shared, Vite-bundled "place this in AR" page
 * (pages/ar-view.html, src/ar-view.js) that does the real on-device USDZ
 * conversion Quick Look needs. `irlUrl`, when set, adds the "Bring it to life"
 * hand-off for a live avatar.
 */
export function buildArViewUrl(origin, glbUrl, title = '', { irlUrl = '' } = {}) {
	const base = String(origin || 'https://three.ws').replace(/\/$/, '');
	const params = new URLSearchParams({ src: glbUrl });
	if (title) params.set('title', title);
	if (irlUrl) params.set('irl', irlUrl);
	return `${base}/ar/view?${params.toString()}`;
}

/**
 * Resolve the launch plan for a request. Every branch is a 302:
 *   Android, static model → Scene Viewer's ARCore intent:// URL
 *   iOS / desktop / any live avatar → /ar/view, which renders the right thing
 *     per device (Quick Look with a real ios-src on iOS, the interactive
 *     WebGL viewer on desktop) and carries the "Bring it to life" hand-off
 *     when `irlUrl` is set.
 * `viewerUrl` and `sceneViewerUrl` are still returned for callers (the
 * export_ar MCP tool) that want the raw URLs alongside the launch link.
 */
export function planArLaunch({ glbUrl, userAgent, origin, title = '', live = false }) {
	const asset = assertArAssetUrl(glbUrl);
	const target = detectArTarget(userAgent);
	const viewerUrl = buildViewerUrl(origin, asset, title);
	const sceneViewerUrl = buildSceneViewerUrl(asset, { title, fallbackUrl: viewerUrl });
	const irlUrl = live ? buildIrlUrl(origin, asset) : '';
	// Live avatars always get /ar/view: a straight Scene Viewer redirect would
	// place a frozen body and hide the "bring it to life" path entirely.
	if (target === 'android' && !live) {
		return { target, action: 'redirect', url: sceneViewerUrl, asset, viewerUrl, sceneViewerUrl, irlUrl };
	}
	const viewUrl = buildArViewUrl(origin, asset, title, { irlUrl });
	return { target, action: 'redirect', url: viewUrl, asset, viewerUrl, sceneViewerUrl, irlUrl, live };
}
