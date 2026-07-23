import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	normalizeShopDomain,
	shopOrigin,
	detectShop,
	htmlToText,
	money,
	normalizeProduct,
	fetchCatalog,
	fetchPolicies,
	parseIntent,
	searchProducts,
	catalogSummary,
	buildShoppingPayload,
} from '../src/shopify.js';

// A tiny fake Shopify products.json product.
function raw(overrides = {}) {
	return {
		id: 100,
		title: 'Merino Wool Scarf',
		handle: 'merino-wool-scarf',
		body_html: '<p>A <b>soft</b> blue scarf for cold days.</p>',
		vendor: 'Highland',
		product_type: 'Scarves',
		tags: ['wool', 'blue', 'winter'],
		images: [{ src: 'http://cdn/scarf.jpg' }],
		variants: [
			{ id: 1, price: '48.00', compare_at_price: '60.00', available: true },
			{ id: 2, price: '52.00', available: false },
		],
		...overrides,
	};
}

test('normalizeShopDomain accepts bare domains and full URLs', () => {
	assert.equal(normalizeShopDomain('shop.example.com'), 'shop.example.com');
	assert.equal(normalizeShopDomain('https://Shop.Example.com/products'), 'shop.example.com');
	assert.equal(normalizeShopDomain('store.myshopify.com/collections/all'), 'store.myshopify.com');
	assert.equal(normalizeShopDomain(''), '');
	assert.equal(shopOrigin('shop.example.com'), 'https://shop.example.com');
});

test('detectShop reads the Shopify global, null when absent', () => {
	assert.equal(detectShop({}), null);
	const win = { Shopify: { shop: 'acme.myshopify.com', currency: { active: 'GBP' } } };
	assert.deepEqual(detectShop(win), { shop: 'acme.myshopify.com', currency: 'GBP' });
});

test('htmlToText strips tags, entities, and caps length', () => {
	assert.equal(htmlToText('<p>Hello&nbsp;&amp; welcome</p>'), 'Hello & welcome');
	assert.equal(htmlToText('<b>x</b>'.repeat(400), 40).length <= 40, true);
});

test('money formats with currency, degrades on a malformed code', () => {
	assert.match(money('48.00', 'USD'), /\$48\.00/);
	assert.equal(money(10, 'US'), '10.00 US'); // 2-letter code throws in Intl → fallback
});

test('normalizeProduct compacts variants, price range, sale, https image', () => {
	const p = normalizeProduct(raw(), 'https://shop.example.com', 'USD');
	assert.equal(p.title, 'Merino Wool Scarf');
	assert.equal(p.url, 'https://shop.example.com/products/merino-wool-scarf');
	assert.equal(p.priceMin, 48);
	assert.equal(p.priceMax, 52);
	assert.equal(p.available, true);
	assert.equal(p.onSale, true); // compare_at 60 > 48
	assert.equal(p.image, 'https://cdn/scarf.jpg'); // http upgraded
	assert.equal(p.variantId, 1); // first available variant
	assert.match(p.summary, /soft blue scarf/);
	assert.equal(normalizeProduct({}, 'https://x'), null); // no handle → dropped
});

test('fetchCatalog paginates products and reads collections', async () => {
	const pages = {
		'https://shop.example.com/products.json?limit=250&page=1': {
			products: Array.from({ length: 250 }, (_, i) => raw({ id: i, handle: `p${i}`, title: `Product ${i}` })),
		},
		'https://shop.example.com/products.json?limit=250&page=2': {
			products: [raw({ id: 999, handle: 'last', title: 'Last One' })],
		},
		'https://shop.example.com/collections.json?limit=250': {
			collections: [{ id: 1, title: 'Winter', handle: 'winter' }],
		},
	};
	const fetchImpl = async (url) => ({
		ok: url in pages,
		status: url in pages ? 200 : 404,
		json: async () => pages[url],
	});
	const cat = await fetchCatalog({ shop: 'shop.example.com', fetchImpl });
	assert.equal(cat.products.length, 251);
	assert.equal(cat.products[250].title, 'Last One');
	assert.equal(cat.collections[0].url, 'https://shop.example.com/collections/winter');
});

test('fetchCatalog throws only when the very first page is unreachable', async () => {
	const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) });
	await assert.rejects(fetchCatalog({ shop: 'shop.example.com', fetchImpl }), /products\.json/);
});

test('fetchPolicies strips HTML and omits 404s', async () => {
	const fetchImpl = async (url) => {
		if (url.endsWith('/policies/shipping-policy')) {
			return { ok: true, status: 200, text: async () => '<main>We ship worldwide within 3 business days.</main>' };
		}
		return { ok: false, status: 404, text: async () => '' };
	};
	const pol = await fetchPolicies({ shop: 'shop.example.com', fetchImpl });
	assert.match(pol.shipping, /ship worldwide within 3 business days/);
	assert.equal(pol.returns, undefined);
});

test('parseIntent reads price ceiling and sort hints', () => {
	assert.deepEqual(parseIntent('scarf under $50'), { maxPrice: 50, sort: null, onSale: false });
	assert.equal(parseIntent('cheapest hoodie').sort, 'price-asc');
	assert.equal(parseIntent('your best jacket').sort, 'price-desc');
	assert.equal(parseIntent('anything on sale').onSale, true);
});

const CATALOG = {
	store: 'shop.example.com',
	currency: 'USD',
	collections: [{ title: 'Winter', handle: 'winter', url: 'https://shop.example.com/collections/winter' }],
	products: [
		normalizeProduct(raw({ id: 1, handle: 'scarf', title: 'Merino Wool Scarf', product_type: 'Scarves', tags: ['blue', 'wool'], variants: [{ id: 11, price: '48', available: true }] }), 'https://shop.example.com'),
		normalizeProduct(raw({ id: 2, handle: 'beanie', title: 'Cashmere Beanie', product_type: 'Hats', tags: ['grey', 'wool'], body_html: 'A warm hat.', variants: [{ id: 21, price: '30', available: true }] }), 'https://shop.example.com'),
		normalizeProduct(raw({ id: 3, handle: 'gloves', title: 'Leather Gloves', product_type: 'Gloves', tags: ['brown'], body_html: 'Sold out gloves.', variants: [{ id: 31, price: '75', available: false }] }), 'https://shop.example.com'),
	],
};

test('searchProducts ranks by weighted overlap, title wins', () => {
	const hits = searchProducts(CATALOG.products, 'do you have a wool scarf');
	assert.equal(hits[0].title, 'Merino Wool Scarf'); // title "scarf" + tag "wool"
	assert.ok(hits.length >= 1);
});

test('searchProducts honors a price ceiling and cheapest sort', () => {
	const under40 = searchProducts(CATALOG.products, 'a hat under $40');
	assert.equal(under40[0].title, 'Cashmere Beanie');
	const cheap = searchProducts(CATALOG.products, 'cheapest thing you have');
	assert.equal(cheap[0].priceMin, 30); // beanie, the cheapest in-stock
});

test('searchProducts returns nothing for an off-catalog ask', () => {
	assert.deepEqual(searchProducts(CATALOG.products, 'do you sell airplanes'), []);
});

test('catalogSummary describes count, categories, price range', () => {
	const s = catalogSummary(CATALOG);
	assert.match(s, /3 products/);
	assert.match(s, /Scarves/);
	assert.match(s, /\$30\.00 to \$75\.00/);
});

test('buildShoppingPayload sends only recommended products + relevant policy', () => {
	const recs = searchProducts(CATALOG.products, 'wool scarf');
	const payload = buildShoppingPayload(CATALOG, recs, { shipping: 'Ships in 3 days.', returns: '30 day returns.' }, 'do you ship fast?');
	assert.equal(payload.store, 'shop.example.com');
	assert.match(payload.products, /Merino Wool Scarf/);
	assert.deepEqual(payload.collections, ['Winter']);
	assert.match(payload.policies, /Ships in 3 days/);
	assert.doesNotMatch(payload.policies, /30 day returns/); // shipping question → shipping policy only
});
