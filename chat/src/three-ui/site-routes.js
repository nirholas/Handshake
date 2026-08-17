// Retired marketing routes -> the real three.ws pages that own them.
//
// The chat app once carried its own copy of a marketing site (pricing, blog,
// updates, use cases, a trust center, events, per-solution landing pages). None
// of it was backed by real data, and the top nav stopped linking to any of it
// when it switched to the shared CHAT_SITE_LINKS list, so the pages survived
// only as hash routes that anyone with an old link could still land on.
//
// The platform already publishes every one of those surfaces for real at the
// site root. Rather than 404 the old links, each retired hash resolves to the
// live page that owns the topic, and App.svelte replaces the location with it.
// Keeping this a pure function is deliberate: it is the one piece of the
// removal that a test can hold onto.

/** Exact hash route -> site path. */
const EXACT = {
	pricing: '/pricing',
	'resources/blog': '/blog',
	'resources/updates': '/changelog',
	'resources/docs': '/docs',
	'resources/use-cases': '/features',
	'resources/trust-center': '/docs/security',
	'business/security': '/docs/security',
	'business/contact-sales': '/support',
};

/** Route prefix -> site path, applied when no exact match wins. */
const PREFIXES = [
	['resources/docs/', null], // handled below: carries the doc slug through
	['features/', '/features'],
	['solutions/', '/features'],
	['business/', '/features'],
	['events/', '/community'],
];

const DOC_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Resolve a chat hash route to the real site page that replaced it.
 *
 * @param {string} route hash route without the leading '#', e.g. 'resources/blog'
 * @returns {string|null} an absolute site path, or null when the chat SPA still
 *   owns this route and must render it itself.
 */
export function siteRouteFor(route) {
	if (typeof route !== 'string') return null;
	const clean = route.trim().replace(/^\/+/, '').replace(/\/+$/, '');
	if (!clean) return null;

	if (Object.prototype.hasOwnProperty.call(EXACT, clean)) return EXACT[clean];

	if (clean.startsWith('resources/docs/')) {
		const slug = clean.slice('resources/docs/'.length);
		return DOC_SLUG.test(slug) ? `/docs/${slug}` : '/docs';
	}

	for (const [prefix, target] of PREFIXES) {
		if (target && clean.startsWith(prefix)) return target;
	}

	// A bare `resources` landing, or any resources sub-page the removal did not
	// name, belongs with the docs.
	if (clean === 'resources' || clean.startsWith('resources/')) return '/docs';

	return null;
}
