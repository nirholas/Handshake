// Page lifecycle for persistent-shell pages.
//
// On a shell page (<html data-shell>), navigating to another shell page swaps
// only <main> — the document, and therefore every loaded module, survives.
// A page module that initializes at import time would then run exactly once
// and never again. onPageReady() is the contract that fixes that:
//
//   import { onPageReady } from './shell/page-lifecycle.js';
//   onPageReady(({ signal }) => init(), { match: (p) => p === '/markets' });
//
// Semantics:
//   • Runs the initializer immediately on import (first load — also covers a
//     module injected mid-swap by view-transitions.js).
//   • Re-runs it on every 'shell:navigated' event whose destination pathname
//     passes `match` — with a fresh AbortSignal, the previous run's signal
//     aborted first, so document/window listeners registered with { signal }
//     clean themselves up.
//   • Runs at most once per navigation: window.__shellNavId (incremented by
//     view-transitions.js before scripts/events fire) is the dedupe token, so
//     an injected module that inits on import doesn't init again when the
//     same navigation's event reaches it.

export function onPageReady(init, { match = () => true } = {}) {
	let lastNavId = null;
	let controller = null;

	const run = () => {
		const navId = window.__shellNavId || 0;
		if (navId === lastNavId) return;
		if (!match(location.pathname)) {
			// Navigated away from this module's page — tear down its listeners.
			controller?.abort();
			controller = null;
			lastNavId = navId;
			return;
		}
		lastNavId = navId;
		controller?.abort();
		controller = new AbortController();
		init({ signal: controller.signal });
	};

	if (match(location.pathname)) {
		lastNavId = window.__shellNavId || 0;
		controller = new AbortController();
		init({ signal: controller.signal });
	}
	document.addEventListener('shell:navigated', run);
}
