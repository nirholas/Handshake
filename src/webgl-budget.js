// Shared WebGL context accounting.
//
// Browsers cap simultaneous WebGL contexts (~16 in Chrome). The <agent-3d>
// element (see element.js) caps how many live viewers it keeps so a grid of
// avatars never exhausts that budget — but it only counts *its own* viewers.
// Standalone renderers on the same page (the homepage avatar-drop, walk
// preview, footer bot, pricing avatar, …) are invisible to that accounting,
// so a busy landing page can still cross the limit and trigger
// "Too many active WebGL contexts. Oldest context will be lost."
//
// These helpers let any standalone renderer reserve a slot against the shared
// budget. element.js subtracts the reserved count from its own cap, so the
// total number of live contexts on the page stays within the browser limit.
// State lives on `window` so it is shared across the CDN agent-3d bundle and
// the app's own modules, which are separate module graphs.

export function reserveWebGLContext() {
	if (typeof window === 'undefined') return;
	const n = Number(window.__agent3dReservedContexts) || 0;
	window.__agent3dReservedContexts = n + 1;
	// Re-run the agent-3d budget now that fewer slots are available, so an
	// offscreen viewer is evicted immediately instead of on the next boot.
	if (typeof window.__agent3dEnforceBudget === 'function') {
		try {
			window.__agent3dEnforceBudget();
		} catch {}
	}
}

export function releaseWebGLContext() {
	if (typeof window === 'undefined') return;
	const n = Number(window.__agent3dReservedContexts) || 0;
	window.__agent3dReservedContexts = Math.max(0, n - 1);
}
