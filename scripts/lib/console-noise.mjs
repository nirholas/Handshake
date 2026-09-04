// Shared console/network noise filters for the browser audit harnesses.
//
// A headless sweep sees plenty of output that is never a defect in our code:
// Vite HMR chatter, browser autoplay policy, third-party telemetry, auth-gated
// API statuses, and dev-only asset paths that only exist as real CDN files in
// production. Both `npm run audit:console` (every route) and
// `npm run audit:play-failures` (deliberate failure injection on /play) judge
// findings against this one list, so a filter fixed in one is fixed in both.

// ── Noise filters ────────────────────────────────────────────────────────────
// Console text that is never a real defect from our code (dev infra, browser
// policy, third-party telemetry, auth-gated API statuses, external CDN CORS).
export const IGNORE_CONSOLE = [
	// Vite HMR / dev infra. In Codespaces the HMR wss handshake 302s through the
	// proxy, documented environment noise, not a page bug.
	/\[vite\]/i,
	/@vite\/client/i,
	/WebSocket closed without opened/i,
	/WebSocket connection to .* failed/i,
	/Error during WebSocket handshake/i,
	/failed to connect to websocket/i,
	/\[HMR\]/i,
	// Browser policy / environment
	/the AudioContext was not allowed to start/i,
	/Tracking Prevention/i,
	/autoplay/i,
	/Permissions policy violation/i,
	/Unrecognized feature:/i,
	// Third-party analytics / telemetry (never our code)
	/posthog/i,
	/sentry/i,
	/segment\.com/i,
	/google-analytics/i,
	/cdn\.vercel-insights/i,
	/vercel\.live/i,
	// API calls judged by HTTP status, not console, auth/payment-gate is expected
	/Failed to load resource.*\/api\//i,
	/\b(401|402|403|429|503)\b.*\/api\//i,
	/Failed to load resource: the server responded with a status of 40[0-3]/i,
	/Failed to load resource: the server responded with a status of 429/i,
	/Failed to load resource: the server responded with a status of 5(02|03)/i,
	// Walk multiplayer / live socket servers not running in dev (graceful fallback)
	/Failed to load resource: net::ERR_CONNECTION_REFUSED/i,
	/net::ERR_CONNECTION_REFUSED/i,
	/\[walk-net\]/i,
	// R2/CDN CORS from dev origins (localhost), only blocks in dev, not production
	/r2\.dev.*Access-Control/i,
	/r2\.dev.*CORS policy/i,
	/CORS policy.*r2\.dev/i,
	/Access-Control-Allow-Origin.*r2\.dev/i,
	/pub-[a-f0-9]+\.r2\.dev.*blocked/i,
	/blocked by CORS policy.*r2\.dev/i,
	// User-generated data with expired signed URLs, not our code
	/private-user-images\.githubusercontent\.com.*404/i,
	/X-Amz-Signature.*404/i,
	// Three.js / WebGL expected notices
	/THREE\.WebGLRenderer: WebGL 1 is not supported/i,
	// SwiftShader (headless CI GL) lacks this optional extension; three.js notes
	// it once per renderer. Real GPUs have it, and our code never emits this.
	/KHR_parallel_shader_compile extension not supported/i,
	/THREE\.BufferGeometry\.computeBoundingSphere/i,
	/WebGL.*swiftshader/i,
	/Automatic fallback to software WebGL/i,
	// Headless Chromium's software GL driver narrating its own perf on a CI box.
	// Emitted by the driver, never by our code, and absent on real GPUs.
	/GL Driver Message/i,
	/GPU stall due to ReadPixels/i,
	// MediaPipe's native (WASM) logger narrating its own GL setup on /create/selfie
	// and the other vision surfaces: glog-formatted lines the C++ library writes
	// directly, with no JS frame of ours anywhere in them. The verbosity is not
	// reachable from the JS API, so there is nothing on our side to turn down.
	/\bgl_context\.cc:\d+\]/i,
	// Content-Security-Policy noise from third-party embeds
	/content security policy/i,
	/Refused to (load|connect|execute|frame)/i,
	// Solana / wallet adapter expected console output
	/StandardWalletAdapter/i,
	/wallet adapter/i,
	// dev tooling
	/Download the React DevTools/i,
	// iframe sandbox noise
	/Allow attribute/i,
	/Blocked.*frame/i,
	// Font loading via CSS (browser-level, not our JS)
	/OTS parsing error/i,
	/downloadable font/i,
	// Colyseus/socket deprecation warnings
	/using deprecated parameters for the initialization/i,
	// Vite dep-optimizer race: when the optimizer re-bundles mid-navigation,
	// in-flight requests for the old dep hash 504 and Vite auto-reloads the page.
	// Purely a dev-server artifact, production ships pre-bundled deps, never 504s.
	/504 \(Outdated Optimize Dep\)/i,
	/Outdated Optimize Dep/i,
];

export function isIgnorableConsole(text) {
	return IGNORE_CONSOLE.some((re) => re.test(text));
}

// First-party URLs whose 4xx/5xx is a dev-server artifact, never a prod defect:
//   • /.vite/deps/*, optimizer re-bundle race (504), Vite auto-reloads
//   • /agent-3d/.../agent-3d.js, the <agent-3d> custom-element bundle. In dev a
//     plugin serves it from dist-lib/ (needs `npm run build:lib`); in production
//     it's a real CDN asset at https://three.ws/agent-3d/latest/agent-3d.js.
//   • *.map, source maps; browsers probe them, 404 is harmless
export function isDevOnlyAsset(u) {
	if (/\/.vite\/deps\//.test(u)) return true;
	if (/\/agent-3d\/[^/]+\/agent-3d\.(js|umd\.cjs)(\?|$)/.test(u)) return true;
	if (/\.map(\?|$)/.test(u)) return true;
	return false;
}
