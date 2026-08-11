// @three-ws/x402-modal — global / CDN entry.
//
// This is the side-effectful build that ships as the drop-in <script>. It:
//   1. reads `data-x402-*` config off its own <script> tag (apiOrigin, brand,
//      builderCode) so a self-hosted deployment can repoint the backend without
//      a line of JS,
//   2. binds every `[data-x402-endpoint]` element and re-scans the DOM as
//      merchants inject buttons,
//   3. exposes `window.X402 = { pay, discover, init, configure, version }`.
//
// For bundler / npm consumers, import the side-effect-free core instead:
//   import { pay, configure } from '@three-ws/x402-modal';

import { pay, discover, init, configure, version } from './x402-modal.js';

// Pull optional config off the script tag, e.g.
//   <script src=".../x402.global.js"
//           data-x402-api-origin="https://pay.example.com"
//           data-x402-brand-label="Powered by Acme"
//           data-x402-brand-href="https://acme.com"
//           data-x402-builder-wallet="acme"
//           data-x402-builder-service="acme_checkout"></script>
// Find the <script> tag that loaded us, so its `data-x402-*` attributes can be
// read. `document.currentScript` answers this for a classic script but is null
// inside a module, which is exactly how the CDN drop-in is documented
// (`<script type="module" src="https://unpkg.com/@three-ws/x402-modal/global">`).
// Matching on the src filename cannot cover that: the CDN subpath is
// `/global`, with no `x402` in it at all, so a merchant's api-origin/brand
// attributes were silently ignored on the very URL the README prints. Look for
// the config itself instead: a <script> carrying any `data-x402-*` attribute is
// ours, whatever the URL looks like.
function findOwnScript() {
	if (document.currentScript) return document.currentScript;
	const scripts = document.querySelectorAll('script');
	for (let i = scripts.length - 1; i >= 0; i--) {
		const ds = scripts[i].dataset;
		if (ds && Object.keys(ds).some((k) => k.startsWith('x402'))) return scripts[i];
	}
	return null;
}

function readScriptConfig() {
	if (typeof document === 'undefined') return;
	const el = findOwnScript();
	const ds = el?.dataset;
	if (!ds) return;
	const cfg = {};
	if (ds.x402ApiOrigin !== undefined) cfg.apiOrigin = ds.x402ApiOrigin;
	if (ds.x402BrandLabel !== undefined || ds.x402BrandHref !== undefined) {
		cfg.brand = {};
		if (ds.x402BrandLabel !== undefined) cfg.brand.label = ds.x402BrandLabel;
		if (ds.x402BrandHref !== undefined) cfg.brand.href = ds.x402BrandHref;
	}
	if (ds.x402BuilderDisable === 'true' || ds.x402BuilderDisable === '') {
		cfg.builderCode = null;
	} else if (ds.x402BuilderWallet !== undefined || ds.x402BuilderService !== undefined) {
		cfg.builderCode = {};
		if (ds.x402BuilderWallet !== undefined) cfg.builderCode.wallet = ds.x402BuilderWallet;
		if (ds.x402BuilderService !== undefined) cfg.builderCode.service = ds.x402BuilderService;
	}
	if (ds.x402SolanaWeb3Url) cfg.solanaWeb3Url = ds.x402SolanaWeb3Url;
	if (ds.x402NobleHashesUrl) cfg.nobleHashesUrl = ds.x402NobleHashesUrl;
	if (Object.keys(cfg).length) configure(cfg);
}

if (typeof document !== 'undefined') {
	readScriptConfig();
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init, { once: true });
	} else {
		init();
	}
	// Re-scan when merchants dynamically inject buttons.
	const mo = new MutationObserver(() => init());
	mo.observe(document.documentElement, { childList: true, subtree: true });
}

// Expose to merchants' inline scripts.
if (typeof window !== 'undefined') {
	window.X402 = Object.freeze({ pay, discover, init, configure, version });
}

export { pay, discover, init, configure, version };
