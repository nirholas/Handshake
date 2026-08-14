# Add a 3D AI shopping assistant to your Shopify store

Give your store a shopping assistant with a face: a floating chat where a rigged 3D avatar answers questions, recommends real products from your live catalog, and helps shoppers check out, all from one script tag. It is the [Concierge](/concierge) widget in **shopping mode**, and it needs no app install, no API key, and no product feed to maintain.

This is different from the [3D Store Guide](/tutorials/shopify-store-guide), which walks a visitor through your storefront like a tour. The shopping assistant is a persistent chat: the shopper types (or speaks) what they want, and the assistant finds it.

What you need: a Shopify store and two minutes. That is genuinely all.

---

## What it does

- **Knows your live catalog.** It reads your store's public `/products.json`, `/collections.json`, and policy pages at ask-time. Change a price or add a product and the assistant knows immediately, with nothing to re-sync.
- **Recommends real products as cards.** When a shopper asks "help me find a rain jacket under $120," it shows product cards with the real image, live price, and a link, plus an **Add to cart** button that works on the store.
- **Answers shipping and returns** grounded in your published policies, not made up.
- **Has a face and a voice.** A 3D avatar blinks, idles, and lipsyncs the answer aloud, with push-to-talk voice input where the browser supports it.

Prices and links on the cards come straight from your catalog, so the assistant can never invent a product, a price, or a discount.

## Step 1: paste one tag

In your Shopify admin go to **Online Store → Themes → Edit code → `theme.liquid`**, and paste this just before `</body>`:

```html
<script type="module"
        src="https://three.ws/concierge/concierge.global.js"
        data-concierge
        data-site-name="Your Store"
        data-avatar="nova"
        data-accent="#3f7d5b"></script>
```

Save. Open your store. A launcher appears in the corner; click it and ask "what do you recommend?" Shopping mode turned itself on because the widget detected your Shopify storefront.

## Step 2: make it yours

Every attribute is optional. The ones that matter for a store:

| Attribute | What it does |
| --- | --- |
| `data-site-name` | Your store name, used in the greeting and answers. |
| `data-avatar` | `sol`, `nova`, `vera`, `atlas`, or `echo`. Or bring your own with `data-custom-avatar="<glb-url>"`. |
| `data-accent` | Any CSS color; restyles the whole widget to match your brand. |
| `data-currency` | ISO code (`USD`, `GBP`, `EUR`, …) if prices should show in a specific currency. |
| `data-max-products` | How many product cards to show per answer (1–8, default 4). |
| `data-persona` | One line of tone, e.g. `"a warm, expert associate who keeps it brief"`. |
| `data-suggestions` | Starter chips, pipe-separated: `"Help me pick a gift\|What's on sale?\|Do you ship to Canada?"`. |

Force shopping mode on or off with `data-shopping="true"` / `"false"`, or point it at a specific storefront with `data-shop="your-store.myshopify.com"` (useful if you embed it somewhere that is not the store origin).

## Step 3: see it work

Ask the assistant the way a customer would. It understands shopping intent, not just keywords:

- **"a warm wool scarf"** → ranks your catalog by relevance and shows the closest matches.
- **"a gift under $75"** → filters to products at or below that price.
- **"cheapest hoodie you have"** → sorts by price.
- **"anything on sale?"** → surfaces products with a compare-at price.
- **"do you ship to Canada?"** → answers from your shipping policy.

If nothing in the catalog fits, it says so honestly and points the shopper to a collection to browse, instead of inventing a product.

## How it works (for the curious)

There is no crawler and no vector database. Every Shopify storefront exposes its catalog publicly, and the widget reads it directly:

```
GET https://your-store.myshopify.com/products.json?limit=250&page=N  → catalog (paginated)
GET https://your-store.myshopify.com/collections.json?limit=250      → collections
GET https://your-store.myshopify.com/policies/shipping-policy        → shipping
GET https://your-store.myshopify.com/policies/refund-policy          → returns
GET https://your-store.myshopify.com/policies/privacy-policy         → privacy
GET https://your-store.myshopify.com/policies/terms-of-service       → terms
```

On the store these are same-origin, so there is no CORS wall. The widget fetches them once, caches them for the session, and for each question runs a small keyword retrieval to pick the handful of products the shopper asked about. Only that handful, plus a compact store summary and the relevant policy, is sent to the answer endpoint. The answer streams back grounded in exactly those products, and the cards are rendered from the same set, so what the assistant says and what it shows always match.

Add-to-cart posts to Shopify's public `/cart/add.js` and fires a `cart:refresh` event so your theme updates its cart count.

## Do it in code

Prefer to drive the pieces yourself instead of letting the widget do it? Loading the same one-tag build exposes every building block on `window.ThreeWsConcierge`, so you can run the retrieval step by hand and render your own cards:

```html
<script type="module" src="https://three.ws/concierge/concierge.global.js"></script>
<script type="module">
	const { fetchCatalog, fetchPolicies, searchProducts, buildShoppingPayload } =
		window.ThreeWsConcierge;

	const shop = 'your-store.myshopify.com';
	const catalog = await fetchCatalog({ shop });
	const policies = await fetchPolicies({ shop });

	const question = 'a warm wool scarf under $60';
	const recommended = searchProducts(catalog.products, question, 4);
	const shopping = buildShoppingPayload(catalog, recommended, policies, question);
	// POST { message: question, shopping } to /api/concierge, render `recommended` as cards
</script>
```

`fetchCatalog` paginates `products.json` and returns `{ store, origin, currency, products, collections }`, where each product is normalized to `{ title, handle, url, priceMin, priceMax, currency, image, variantId, available, onSale, tags, summary }`. `searchProducts` returns already-ranked, price-filtered products (cap 8, default 4). `buildShoppingPayload` bounds what is sent to the model, returning `{ store, currency, summary, collections, policies, products }`.

Run this **on the store's own origin**. Shopify serves `products.json` and the policy pages without CORS headers, so the same calls from another domain fetch the catalog but come back with empty policies. Pass `fetchImpl` to either function to route them through your own proxy if you need them off-origin.

The [wire format](/docs/concierge) for the answer endpoint is documented, so you can point a self-hosted SSE server at the same payload.

## Related

- [Concierge](/concierge) — the widget this is built on, for any website.
- [3D Store Guide for Shopify](/tutorials/shopify-store-guide) — a guided storefront tour (complementary: run both, hand off from the tour to the assistant).
- [Assistant widget](/docs/assistant-widget) — a full-body avatar assistant, the sibling surface.
- Use it from an AI agent: [`@three-ws/concierge-mcp`](https://www.npmjs.com/package/@three-ws/concierge-mcp).
