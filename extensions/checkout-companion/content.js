// The content script: notice a checkout, read it, show what it found.
//
// Runs on every page, does almost nothing on nearly all of them. The order of
// operations is deliberate and is the privacy design:
//
//   1. Cheap local check. Does this page even look like a checkout? A URL
//      pattern and a page-language score, both computed in the tab. A news
//      article never gets past this line and never touches the network.
//   2. Read visible text only, refusing every input (extract.js).
//   3. Redact in the tab, before anything is sent.
//   4. Send to three.ws only if the person turned the extension on, only for a
//      page that passed step 1, and only once per page.
//
// A page that is not a checkout produces no request, no storage write, and no
// UI. Silence is the correct behaviour almost all of the time, and an extension
// that announces itself on every page would be uninstalled within a day.

const STATE = {
	ran: false,
	panel: null,
};

const SETTINGS_DEFAULTS = {
	enabled: true,
	speak: true,
	rememberPrices: true,
};

async function settings() {
	const stored = await chrome.storage.local.get(SETTINGS_DEFAULTS);
	return { ...SETTINGS_DEFAULTS, ...stored };
}

/**
 * The price this site last showed before checkout, kept per origin.
 *
 * This is the honest version of "the agent follows you across the flow": no
 * screen reading, no cross-app surveillance, just one number per site so the
 * total on the payment page can be compared against the price on the page that
 * sent you there. It expires after an hour, because a price you saw yesterday
 * is not what you think you are buying today, and it never leaves the browser
 * except as the single integer sent with the checkout read.
 */
const PRICE_TTL_MS = 60 * 60 * 1000;

async function rememberedPrice(origin) {
	const { prices = {} } = await chrome.storage.local.get({ prices: {} });
	const entry = prices[origin];
	if (!entry) return null;
	if (Date.now() - entry.at > PRICE_TTL_MS) return null;
	return { value: entry.value, currency: entry.currency };
}

async function rememberPrice(origin, amount) {
	const { prices = {} } = await chrome.storage.local.get({ prices: {} });
	prices[origin] = { value: amount.value, currency: amount.currency, at: Date.now() };
	// Keep the map small: twenty origins is more than a browsing session needs
	// and stops this from becoming a shopping history by accident.
	const entries = Object.entries(prices).sort((a, b) => b[1].at - a[1].at).slice(0, 20);
	await chrome.storage.local.set({ prices: Object.fromEntries(entries) });
}

async function run() {
	if (STATE.ran) return;
	const config = await settings();
	if (!config.enabled) return;

	const extract = await import(chrome.runtime.getURL('extract.js'));
	const text = extract.collectText(document.body, { view: window });
	const url = location.href;
	const origin = location.origin;

	const amounts = extract.collectAmounts(document.body, { view: window });
	const total = extract.primaryTotal(amounts);

	if (!extract.looksLikeCheckout({ url, text })) {
		// Not a checkout. The only thing worth doing on a product page is
		// noting the price for later, and only if the person allowed it.
		if (config.rememberPrices && total) await rememberPrice(origin, total);
		return;
	}

	STATE.ran = true;
	const quoted = config.rememberPrices ? await rememberedPrice(origin) : null;
	const payload = extract.buildExtract({ url, title: document.title, text, amounts, quoted });

	const panel = await import(chrome.runtime.getURL('panel.js'));
	STATE.panel = panel.mount({ speak: config.speak });
	STATE.panel.setState('reading');

	const reply = await chrome.runtime.sendMessage({ type: 'checkout:analyze', payload });

	if (!reply || reply.error) {
		STATE.panel.setState('error', reply?.error || { code: 'unknown', message: 'The read did not complete.' });
		return;
	}
	STATE.panel.setState('done', reply.result);
}

// A checkout is usually rendered after the first paint and often replaced in
// place by a single-page flow, so one pass at document_idle would miss most of
// them. Re-check on url change and on a settled DOM, and stop once a real
// checkout has been read: one payment page is one reading.
function watch() {
	let lastUrl = location.href;
	let timer = null;
	const schedule = () => {
		if (STATE.ran) return;
		clearTimeout(timer);
		timer = setTimeout(() => {
			run().catch(() => {
				// A page that breaks the read gets no panel rather than a broken
				// one. Nothing here is important enough to interrupt a checkout
				// with an extension error.
			});
		}, 700);
	};

	schedule();
	new MutationObserver(() => {
		if (location.href !== lastUrl) {
			lastUrl = location.href;
			STATE.ran = false;
			STATE.panel?.destroy();
			STATE.panel = null;
		}
		schedule();
	}).observe(document.documentElement, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', watch, { once: true });
} else {
	watch();
}
