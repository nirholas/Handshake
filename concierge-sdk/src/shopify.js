/**
 * Shopify storefront adapter: @three-ws/concierge
 * ================================================
 *
 * Turns the concierge into a real shopping assistant on a Shopify store, with
 * the same no-crawler / no-index / no-setup ethos as the page harvester: every
 * Shopify storefront serves its catalog and policies as PUBLIC endpoints that
 * need no API key and no app install.
 *
 *   GET /products.json?limit=250&page=N   → the live catalog (variants, prices,
 *                                            images, tags, product_type)
 *   GET /collections.json?limit=250       → the collections
 *   GET /policies/<handle>                → shipping / refund / privacy / terms
 *                                            (HTML; stripped to text here)
 *
 * The widget fetches these once (same-origin when embedded on the store, so no
 * CORS wall), caches them, then per question runs a small keyword retrieval to
 * pick the handful of products the shopper actually asked about. Only that
 * handful plus a compact store summary is sent to the answer endpoint, and the
 * widget renders real product cards (image, price, live link, add-to-cart) for
 * them. No vector DB, no embeddings service, no product feed to maintain.
 *
 * Everything here is pure data-in / data-out with `fetch` and the DOM injected,
 * so it is unit-testable with a fake fetch and a fake window.
 */

/** Hard caps so a huge catalog can never blow the request budget. */
export const MAX_PRODUCTS = 500; // fetched + indexed locally
export const MAX_RECOMMENDATIONS = 4; // shown as cards / sent to the model
export const MAX_SUMMARY_CHARS = 500;
export const MAX_POLICY_CHARS = 1400; // per policy, sent to the model
export const MAX_PRODUCT_SUMMARY_CHARS = 220;

const POLICY_HANDLES = {
	shipping: 'shipping-policy',
	returns: 'refund-policy',
	privacy: 'privacy-policy',
	terms: 'terms-of-service',
};

const STOPWORDS = new Set([
	'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'is', 'are',
	'do', 'does', 'i', 'you', 'me', 'my', 'we', 'it', 'this', 'that', 'with',
	'can', 'have', 'get', 'want', 'need', 'show', 'find', 'looking', 'look',
	'any', 'some', 'what', 'which', 'whats', 'about', 'please', 'would', 'like',
	'buy', 'purchase', 'shop', 'product', 'products', 'item', 'items', 'store',
]);

// ── Domain / detection ──────────────────────────────────────────────────────

/**
 * Normalize any store reference (a bare domain, a full URL, a myshopify host)
 * into a plain hostname. Returns '' for junk so callers can guard on it.
 */
export function normalizeShopDomain(input) {
	const raw = String(input || '').trim();
	if (!raw) return '';
	try {
		const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
		return url.hostname.toLowerCase();
	} catch {
		return '';
	}
}

/** Origin (`https://host`) for a normalized domain. */
export function shopOrigin(domain) {
	const host = normalizeShopDomain(domain);
	return host ? `https://${host}` : '';
}

/**
 * Detect a Shopify store from the runtime. Returns `{ shop, currency }` when the
 * page is a Shopify storefront (the global object Shopify injects), else null.
 * `window.Shopify` is present on every themed storefront and carries the shop
 * domain and active currency, so an on-store embed needs zero configuration.
 */
export function detectShop(win = typeof window !== 'undefined' ? window : undefined) {
	const S = win?.Shopify;
	if (!S) return null;
	const shop = normalizeShopDomain(S.shop || win.location?.hostname);
	if (!shop) return null;
	return { shop, currency: S.currency?.active || 'USD' };
}

// ── Normalization ───────────────────────────────────────────────────────────

/** Strip HTML to a trimmed, single-spaced text summary. */
export function htmlToText(html, max = MAX_PRODUCT_SUMMARY_CHARS) {
	const text = String(html || '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&#39;|&rsquo;|&lsquo;/g, "'")
		.replace(/&quot;|&ldquo;|&rdquo;/g, '"')
		.replace(/\s+/g, ' ')
		.trim();
	return max && text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

/** Parse a Shopify decimal price string ("19.99") into a number; NaN → 0. */
function priceNumber(v) {
	const n = Number.parseFloat(v);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Format a price as a localized currency string. Shopify products.json prices
 * are major-unit decimal strings, not cents.
 */
export function money(amount, currency = 'USD') {
	const n = typeof amount === 'number' ? amount : priceNumber(amount);
	try {
		return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n);
	} catch {
		// Unknown currency code: fall back to a plain amount + code.
		return `${n.toFixed(2)} ${currency}`;
	}
}

/**
 * Normalize a raw Shopify product (from products.json) into the compact shape
 * the widget and prompt use. Keeps only what a shopper cares about.
 */
export function normalizeProduct(raw, origin, currency = 'USD') {
	if (!raw || !raw.handle) return null;
	const variants = Array.isArray(raw.variants) ? raw.variants : [];
	const prices = variants.map((v) => priceNumber(v.price)).filter((n) => n > 0);
	const priceMin = prices.length ? Math.min(...prices) : 0;
	const priceMax = prices.length ? Math.max(...prices) : 0;
	const available = variants.some((v) => v.available !== false);
	const firstAvailable = variants.find((v) => v.available !== false) || variants[0];
	const compareAt = variants
		.map((v) => priceNumber(v.compare_at_price))
		.filter((n) => n > 0);
	const onSale = compareAt.some((c) => c > priceMin);
	const image =
		raw.image?.src || (Array.isArray(raw.images) && raw.images[0]?.src) || '';
	const tags = Array.isArray(raw.tags)
		? raw.tags.map((t) => String(t).trim()).filter(Boolean)
		: String(raw.tags || '')
				.split(',')
				.map((t) => t.trim())
				.filter(Boolean);

	return {
		id: raw.id,
		handle: raw.handle,
		title: String(raw.title || '').trim(),
		url: `${origin}/products/${raw.handle}`,
		type: String(raw.product_type || '').trim(),
		vendor: String(raw.vendor || '').trim(),
		tags,
		priceMin,
		priceMax,
		currency,
		available,
		onSale,
		image: image ? String(image).replace(/^http:/, 'https:') : '',
		variantId: firstAvailable?.id || variants[0]?.id || null,
		summary: htmlToText(raw.body_html),
	};
}

// ── Fetching ────────────────────────────────────────────────────────────────

async function getJson(url, { fetchImpl, signal }) {
	const res = await fetchImpl(url, {
		signal,
		headers: { accept: 'application/json' },
		credentials: 'omit',
	});
	if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
	return res.json();
}

/**
 * Fetch the full catalog + collections for a store. Paginates products.json
 * until it runs dry or the cap is hit. Never rejects on a partial failure: a
 * store with collections disabled still yields its products.
 *
 * @returns {Promise<{ store:string, origin:string, currency:string,
 *                      products:object[], collections:{title,handle,url}[] }>}
 */
export async function fetchCatalog({
	shop,
	fetchImpl = typeof fetch !== 'undefined' ? fetch : undefined,
	signal,
	currency = 'USD',
	limit = 250,
	maxProducts = MAX_PRODUCTS,
} = {}) {
	const domain = normalizeShopDomain(shop);
	const origin = shopOrigin(domain);
	if (!origin) throw new Error('fetchCatalog: a Shopify shop domain is required');
	if (!fetchImpl) throw new Error('fetchCatalog: no fetch implementation available');

	const products = [];
	for (let page = 1; products.length < maxProducts; page++) {
		let batch;
		try {
			const data = await getJson(
				`${origin}/products.json?limit=${limit}&page=${page}`,
				{ fetchImpl, signal },
			);
			batch = Array.isArray(data?.products) ? data.products : [];
		} catch (err) {
			if (page === 1) throw err; // the store has no public catalog: surface it
			break; // a later page failed: keep what we have
		}
		if (!batch.length) break;
		for (const raw of batch) {
			const p = normalizeProduct(raw, origin, currency);
			if (p) products.push(p);
			if (products.length >= maxProducts) break;
		}
		if (batch.length < limit) break; // last page
	}

	let collections = [];
	try {
		const data = await getJson(`${origin}/collections.json?limit=250`, { fetchImpl, signal });
		collections = (Array.isArray(data?.collections) ? data.collections : [])
			.filter((c) => c?.handle && c?.title)
			.map((c) => ({
				title: String(c.title).trim(),
				handle: c.handle,
				url: `${origin}/collections/${c.handle}`,
			}));
	} catch {
		/* collections endpoint disabled or empty: products alone still work */
	}

	return { store: domain, origin, currency, products, collections };
}

/**
 * Fetch the store's published policies. Each lives at a stable public URL and
 * is HTML; we strip it to text. Missing policies (404) are simply omitted.
 */
export async function fetchPolicies({
	shop,
	fetchImpl = typeof fetch !== 'undefined' ? fetch : undefined,
	signal,
} = {}) {
	const origin = shopOrigin(shop);
	if (!origin || !fetchImpl) return {};
	const out = {};
	await Promise.all(
		Object.entries(POLICY_HANDLES).map(async ([key, handle]) => {
			try {
				const res = await fetchImpl(`${origin}/policies/${handle}`, {
					signal,
					credentials: 'omit',
				});
				if (!res.ok) return;
				const html = await res.text();
				// Policy pages wrap the body in a <main>/<article>; strip everything
				// to text and cap. Good enough to ground shipping/return answers.
				const text = htmlToText(html, MAX_POLICY_CHARS);
				if (text && text.length > 40) out[key] = text;
			} catch {
				/* one policy failing must not sink the others */
			}
		}),
	);
	return out;
}

// ── Retrieval ───────────────────────────────────────────────────────────────

function tokenize(s) {
	return String(s || '')
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.split(/\s+/)
		.filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * Parse light shopping intent from a question: a max price ("under $50") and a
 * cheap/premium sort hint. Real shoppers ask this way; honoring it makes the
 * recommendations feel like a person, not a search box.
 */
export function parseIntent(query) {
	const q = String(query || '').toLowerCase();
	let maxPrice = null;
	const under = q.match(/(?:under|below|less than|up to|max)\s*\$?\s*(\d+(?:\.\d+)?)/);
	if (under) maxPrice = Number.parseFloat(under[1]);
	const cheap = /\b(cheap|cheapest|budget|affordable|inexpensive|lowest)\b/.test(q);
	const premium = /\b(premium|luxury|best|top|high[- ]?end|nicest)\b/.test(q);
	const onSale = /\b(sale|discount|deal|deals|clearance|reduced)\b/.test(q);
	return {
		maxPrice,
		sort: cheap ? 'price-asc' : premium ? 'price-desc' : null,
		onSale,
	};
}

/**
 * Rank products against a question by weighted keyword overlap. No embeddings:
 * a compact catalog and honest term matching answer "do you have a blue wool
 * scarf" better than a cosine score nobody can debug.
 *
 * @returns {object[]} the top-k matching products (may be empty)
 */
export function searchProducts(products, query, k = MAX_RECOMMENDATIONS) {
	const list = Array.isArray(products) ? products : [];
	const tokens = tokenize(query);
	const intent = parseIntent(query);
	const phrase = String(query || '').toLowerCase().trim();

	const pool = intent.maxPrice
		? list.filter((p) => p.priceMin <= intent.maxPrice)
		: list;

	const scored = pool.map((p) => {
		const title = p.title.toLowerCase();
		const type = p.type.toLowerCase();
		const vendor = p.vendor.toLowerCase();
		const tags = p.tags.join(' ').toLowerCase();
		const summary = p.summary.toLowerCase();
		let score = 0;
		for (const tok of tokens) {
			if (title.includes(tok)) score += 6;
			else if (type.includes(tok)) score += 4;
			else if (tags.includes(tok)) score += 3;
			else if (vendor.includes(tok)) score += 2;
			else if (summary.includes(tok)) score += 1;
		}
		if (phrase.length >= 4 && title.includes(phrase)) score += 8; // exact phrase in title
		if (intent.onSale && p.onSale) score += 4;
		if (intent.onSale && !p.onSale) score -= 2;
		if (!p.available) score -= 3; // in-stock first, never hide entirely
		return { p, score };
	});

	let matched = scored.filter((s) => s.score > 0);

	// A bare "what's cheapest / on sale" with no product noun still deserves an
	// answer: fall back to the whole (price-filtered) pool so the sort applies.
	if (!matched.length && (intent.sort || intent.onSale || intent.maxPrice)) {
		matched = pool.map((p) => ({ p, score: p.available ? 1 : 0 }));
		if (intent.onSale) matched = matched.filter((s) => s.p.onSale);
	}

	matched.sort((a, b) => {
		if (intent.sort === 'price-asc') return a.p.priceMin - b.p.priceMin || b.score - a.score;
		if (intent.sort === 'price-desc') return b.p.priceMin - a.p.priceMin || b.score - a.score;
		return b.score - a.score || a.p.priceMin - b.p.priceMin;
	});

	return matched.slice(0, k).map((s) => s.p);
}

// ── Formatting for the answer endpoint ──────────────────────────────────────

/** A compact one-line store overview, always sent so the model knows its shape. */
export function catalogSummary(catalog) {
	const products = catalog?.products || [];
	if (!products.length) return '';
	const types = [...new Set(products.map((p) => p.type).filter(Boolean))].slice(0, 12);
	const prices = products.map((p) => p.priceMin).filter((n) => n > 0);
	const lo = prices.length ? Math.min(...prices) : 0;
	const hi = prices.length ? Math.max(...prices) : 0;
	const currency = catalog.currency || 'USD';
	const parts = [`${products.length} products`];
	if (types.length) parts.push(`categories: ${types.join(', ')}`);
	if (prices.length) parts.push(`prices from ${money(lo, currency)} to ${money(hi, currency)}`);
	return parts.join(' · ').slice(0, MAX_SUMMARY_CHARS);
}

/** Compact prompt line for one product. */
function productLine(p) {
	const price =
		p.priceMax > p.priceMin
			? `${money(p.priceMin, p.currency)}–${money(p.priceMax, p.currency)}`
			: money(p.priceMin, p.currency);
	const bits = [`- ${p.title} (${price}${p.available ? '' : ', sold out'}${p.onSale ? ', on sale' : ''})`];
	if (p.type) bits.push(`type: ${p.type}`);
	if (p.summary) bits.push(p.summary);
	bits.push(`link: ${p.url}`);
	return bits.join(' · ');
}

/**
 * Build the bounded `shopping` payload the /api/concierge endpoint grounds on.
 * Only the retrieved products (not the whole catalog) plus a store summary,
 * collection names, and relevant policies are sent, keeping the request small.
 */
export function buildShoppingPayload(catalog, recommended, policies = {}, question = '') {
	if (!catalog) return null;
	const currency = catalog.currency || 'USD';
	const collections = (catalog.collections || []).slice(0, 24).map((c) => c.title);

	// Pull the policy the question is actually about, so a "do you ship to
	// Canada" answer is grounded without spending budget on the refund text.
	const q = question.toLowerCase();
	const wantShip = /ship|deliver|postage|arrive|dispatch/.test(q);
	const wantReturn = /return|refund|exchange|money back|warranty/.test(q);
	const policyText = [];
	if (policies.shipping && (wantShip || !wantReturn)) policyText.push(`Shipping policy: ${policies.shipping}`);
	if (policies.returns && (wantReturn || !wantShip)) policyText.push(`Returns policy: ${policies.returns}`);
	if (!policyText.length && policies.shipping) policyText.push(`Shipping policy: ${policies.shipping}`);

	return {
		store: catalog.store || '',
		currency,
		summary: catalogSummary(catalog),
		collections,
		policies: policyText.join('\n\n').slice(0, MAX_POLICY_CHARS * 2),
		products: (recommended || []).map(productLine).join('\n'),
	};
}
