// x402-discover.js — optional companion to x402.js for buyer-side discovery.
//
// Merchants embedding x402.js for payments can opt into the Bazaar discovery
// layer by also loading this module. It calls /api/bazaar/list and
// /api/bazaar/search on the origin that hosts the script (same as x402.js),
// so the merging across facilitators + CORS handling happens server-side.
//
//   <script type="module" src="https://three.ws/x402.js"></script>
//   <script type="module" src="https://three.ws/x402-discover.js"></script>
//   <script>
//     const { items } = await X402.discover.list({ type: 'http', maxPrice: 100000 });
//     await X402.pay({ endpoint: items[0].resource });
//   </script>

const ORIGIN = (() => {
	try {
		const script = document.currentScript;
		if (script?.src) return new URL(script.src).origin;
		const found = document.querySelector('script[src*="/x402-discover.js"]');
		if (found?.src) return new URL(found.src).origin;
	} catch (_) {}
	return location.origin;
})();

function appendFilters(u, filters) {
	const set = (k, v) => v != null && v !== '' && u.searchParams.set(k, String(v));
	set('type', filters.type || 'http');
	set('network', filters.network);
	set('maxPrice', filters.maxPrice);
	set('asset', filters.asset);
	set('extension', filters.extension);
	set('tag', filters.tag);
	set('sort', filters.sort);
	set('maxItems', filters.maxItems);
	set('limit', filters.limit);
	if (Array.isArray(filters.facilitators) && filters.facilitators.length) {
		u.searchParams.set('facilitators', filters.facilitators.join(','));
	}
}

async function call(path, filters) {
	const u = new URL(`${ORIGIN}${path}`);
	appendFilters(u, filters);
	const r = await fetch(u.toString(), { headers: { accept: 'application/json' } });
	if (!r.ok) {
		const body = await r.json().catch(() => ({}));
		throw new Error(body?.error_description || body?.error || `discover HTTP ${r.status}`);
	}
	return r.json();
}

export const discover = Object.freeze({
	list(filters = {}) {
		return call('/api/bazaar/list', filters);
	},
	search({ query, ...rest } = {}) {
		const u = new URL(`${ORIGIN}/api/bazaar/search`);
		if (query) u.searchParams.set('query', query);
		appendFilters(u, rest);
		return fetch(u.toString(), { headers: { accept: 'application/json' } }).then(async (r) => {
			if (!r.ok) {
				const body = await r.json().catch(() => ({}));
				throw new Error(body?.error_description || body?.error || `discover HTTP ${r.status}`);
			}
			return r.json();
		});
	},
});

if (typeof window !== 'undefined') {
	const existing = window.X402;
	if (existing && !existing.discover) {
		// `existing` is Object.freeze'd by x402.js — we replace it with a new
		// frozen object that includes the discover surface, preserving pay/init.
		try {
			window.X402 = Object.freeze({ ...existing, discover });
		} catch (_) {
			// If reassignment is blocked (defineProperty configurable:false), fall
			// back to a sibling global so callers can still reach discover.
			window.X402Discover = discover;
		}
	} else {
		window.X402Discover = discover;
	}
}
