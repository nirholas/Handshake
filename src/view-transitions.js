// Native View Transitions for internal navigation.
//
// Chrome 111+, Safari 18+, Firefox flagged. Falls back to a normal location
// change in browsers that don't support it — no UX regression.
//
// Behavior:
//   - Intercept clicks on same-origin <a> links that aren't downloads, hash-
//     only, or external-target.
//   - Wrap the navigation in document.startViewTransition() so the browser
//     auto-morphs old → new page state. Pages opt into per-element morphs by
//     setting CSS `view-transition-name` on shared elements (avatar card →
//     hero, marketplace tile → product page, etc.).
//
// No JS framework dependency — just a single delegated listener.

const SUPPORTED = typeof document !== 'undefined' && 'startViewTransition' in document;

function isInternalLink(a) {
	if (!a || !a.href) return false;
	if (a.target && a.target !== '_self') return false;
	if (a.hasAttribute('download')) return false;
	if (a.dataset?.noTransition === '1') return false;
	const url = new URL(a.href, location.href);
	if (url.origin !== location.origin) return false;
	// Same path + hash-only navigation — let the browser handle it.
	if (url.pathname === location.pathname && url.search === location.search && url.hash) return false;
	// Avoid stealing modifier-key clicks (open in new tab/window).
	return true;
}

function handleClick(e) {
	if (e.defaultPrevented) return;
	if (e.button !== 0) return;
	if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
	const a = e.target.closest?.('a[href]');
	if (!a || !isInternalLink(a)) return;
	e.preventDefault();
	const dest = a.href;
	document.startViewTransition(() => {
		location.href = dest;
	});
}

export function enableViewTransitions() {
	if (!SUPPORTED) return false;
	// Idempotent — safe to call from every page entry.
	if (document._viewTransitionsWired) return true;
	document._viewTransitionsWired = true;
	document.addEventListener('click', handleClick, { capture: true });
	return true;
}
