// @ts-check
// The fulfillment adapter registry.
//
// Adapters declare themselves as data plus a module; this file is the only
// place that knows which ones exist. Registration is conditional on
// configured(), so a lane whose credentials are absent is invisible rather
// than present-and-broken: nothing can route an order into it, and the console
// never offers it.
//
// The registry is rebuilt per call rather than frozen at import, because
// `configured()` reads process.env and a container's env can be updated
// (gcloud run services update --update-env-vars) without a code change. The
// cost is a handful of string checks; the benefit is that turning a partner on
// is a config change, which is the entire point of the adapter layer.

import { assertAdapterShape, adapterSupportsOrder } from './contract.js';
import manual from './manual.js';
import partnerCn from './partner-cn.js';

// Order matters: the first configured adapter that supports an order is the
// default route, and `manual` is deliberately last. A contracted partner
// should take a job it can run; a human should take everything else.
const ALL = [partnerCn, manual].map(assertAdapterShape);

/** Every adapter that exists in the build, configured or not. Diagnostics. */
export function allAdapters() {
	return ALL.map((a) => ({ ...a }));
}

/** Adapters this deployment can actually use right now. */
export function listAdapters() {
	return ALL.filter((a) => {
		try {
			return a.configured() === true;
		} catch {
			return false;
		}
	});
}

/**
 * Resolve one adapter by key. Returns null for an unknown or unconfigured key,
 * which every caller treats as "this lane is not available here".
 * @param {string} key
 */
export function getAdapter(key) {
	return listAdapters().find((a) => a.key === key) || null;
}

/**
 * The lane an order should go to: the first configured adapter whose declared
 * capabilities cover it. Returns the adapter plus the reasons the earlier ones
 * declined, so a routing decision is explainable in the console rather than a
 * silent fallback.
 * @param {object} order
 * @returns {{ adapter: any|null, declined: Array<{ key: string, reason: string }> }}
 */
export function routeOrder(order) {
	const declined = [];
	for (const adapter of listAdapters()) {
		const verdict = adapterSupportsOrder(adapter, order);
		if (verdict.ok) return { adapter, declined };
		declined.push({ key: adapter.key, reason: verdict.reason });
	}
	return { adapter: null, declined };
}

/** Capability summary for the console and for docs. Never includes secrets. */
export function adapterSummaries() {
	return ALL.map((a) => ({
		key: a.key,
		label: a.label,
		configured: (() => {
			try {
				return a.configured() === true;
			} catch {
				return false;
			}
		})(),
		capabilities: a.capabilities,
	}));
}
