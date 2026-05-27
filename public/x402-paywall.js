// x402-paywall.js — drop-in content paywall component.
//
// Usage:
//
//   <div data-x402-paywall="/api/x402/dance-tip?dancer=1&dance=rumba">
//     <p>This content is premium. Pay to unlock.</p>
//   </div>
//
// Or programmatically:
//
//   window.X402Paywall.init({
//     selector: '[data-x402-paywall]',
//     onUnlock: (el, data) => { ... }
//   });
//
// The component:
//   1. Fetches the 402 body from the endpoint to read price/description.
//   2. Renders a frosted glass overlay with price, network, and unlock button.
//   3. On click, delegates to window.X402.pay() for the wallet flow.
//   4. On success, removes the overlay and reveals the content.
//   5. Saves access in localStorage so repeat visits skip the paywall.

(function () {
	'use strict';

	var STORAGE_PREFIX = 'x402_paywall_';
	var CSS_INJECTED = false;

	// ── Styles ────────────────────────────────────────────────────────────

	function injectStyles() {
		if (CSS_INJECTED) return;
		CSS_INJECTED = true;
		var style = document.createElement('style');
		style.textContent = [
			'[data-x402-paywall] {',
			'  position: relative;',
			'  overflow: hidden;',
			'}',

			'.x402-pw-overlay {',
			'  position: absolute;',
			'  inset: 0;',
			'  z-index: 100;',
			'  display: flex;',
			'  flex-direction: column;',
			'  align-items: center;',
			'  justify-content: center;',
			'  gap: 16px;',
			'  padding: 32px 24px;',
			'  background: rgba(5, 5, 5, 0.75);',
			'  backdrop-filter: blur(16px);',
			'  -webkit-backdrop-filter: blur(16px);',
			'  border: 1px solid rgba(255, 255, 255, 0.06);',
			'  border-radius: inherit;',
			'  text-align: center;',
			'  font-family: "Inter", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;',
			'  -webkit-font-smoothing: antialiased;',
			'  transition: opacity 0.35s ease, backdrop-filter 0.35s ease;',
			'}',

			'.x402-pw-overlay.x402-pw-unlocking {',
			'  opacity: 0;',
			'  pointer-events: none;',
			'}',

			'.x402-pw-badge {',
			'  display: inline-flex;',
			'  align-items: center;',
			'  gap: 6px;',
			'  padding: 4px 12px;',
			'  border-radius: 100px;',
			'  background: rgba(255, 255, 255, 0.06);',
			'  border: 1px solid rgba(255, 255, 255, 0.08);',
			'  font-size: 11px;',
			'  letter-spacing: 0.08em;',
			'  text-transform: uppercase;',
			'  color: #a8a8a8;',
			'}',

			'.x402-pw-badge-dot {',
			'  width: 6px;',
			'  height: 6px;',
			'  border-radius: 50%;',
			'  background: #2dd4bf;',
			'}',

			'.x402-pw-price {',
			'  font-size: 36px;',
			'  font-weight: 700;',
			'  letter-spacing: -0.04em;',
			'  color: #f6f6f6;',
			'  line-height: 1.1;',
			'  font-variant-numeric: tabular-nums;',
			'}',

			'.x402-pw-desc {',
			'  font-size: 14px;',
			'  color: #a8a8a8;',
			'  max-width: 320px;',
			'  line-height: 1.5;',
			'}',

			'.x402-pw-unlock {',
			'  display: inline-flex;',
			'  align-items: center;',
			'  gap: 8px;',
			'  padding: 12px 28px;',
			'  border: none;',
			'  border-radius: 10px;',
			'  background: #f6f6f6;',
			'  color: #050505;',
			'  font-size: 14.5px;',
			'  font-weight: 600;',
			'  font-family: inherit;',
			'  cursor: pointer;',
			'  transition: transform 0.12s, box-shadow 0.12s, background 0.12s;',
			'}',
			'.x402-pw-unlock:hover {',
			'  transform: translateY(-1px);',
			'  box-shadow: 0 4px 16px rgba(255, 255, 255, 0.08);',
			'}',
			'.x402-pw-unlock:active {',
			'  transform: translateY(0);',
			'}',
			'.x402-pw-unlock:disabled {',
			'  opacity: 0.5;',
			'  cursor: not-allowed;',
			'  transform: none;',
			'  box-shadow: none;',
			'}',

			'.x402-pw-siwx {',
			'  display: inline-flex;',
			'  align-items: center;',
			'  gap: 6px;',
			'  padding: 8px 20px;',
			'  border: 1px solid rgba(255, 255, 255, 0.1);',
			'  border-radius: 8px;',
			'  background: transparent;',
			'  color: #a8a8a8;',
			'  font-size: 13px;',
			'  font-weight: 500;',
			'  font-family: inherit;',
			'  cursor: pointer;',
			'  transition: border-color 0.12s, color 0.12s;',
			'}',
			'.x402-pw-siwx:hover {',
			'  border-color: rgba(255, 255, 255, 0.25);',
			'  color: #f6f6f6;',
			'}',

			'.x402-pw-network {',
			'  font-size: 12px;',
			'  color: #6a6a6a;',
			'}',

			'.x402-pw-error {',
			'  font-size: 13px;',
			'  color: #f87171;',
			'  max-width: 320px;',
			'}',

			'.x402-pw-footer {',
			'  font-size: 11px;',
			'  color: #4a4a4a;',
			'}',
			'.x402-pw-footer a {',
			'  color: #6a6a6a;',
			'  text-decoration: none;',
			'}',
			'.x402-pw-footer a:hover {',
			'  color: #a8a8a8;',
			'}',

			// Blur the content behind the paywall
			'[data-x402-paywall]:not(.x402-pw-unlocked) > :not(.x402-pw-overlay) {',
			'  filter: blur(8px);',
			'  pointer-events: none;',
			'  user-select: none;',
			'}',
			'[data-x402-paywall].x402-pw-unlocked > :not(.x402-pw-overlay) {',
			'  filter: none;',
			'  pointer-events: auto;',
			'  user-select: auto;',
			'}',
		].join('\n');
		document.head.appendChild(style);
	}

	// ── Price formatting ──────────────────────────────────────────────────

	function formatAmount(amount, decimals) {
		decimals = decimals || 6;
		var n = Number(amount || 0);
		var usd = n / Math.pow(10, decimals);
		if (usd === 0) return '$0.00';
		if (usd < 0.000001) return '$' + usd.toFixed(8).replace(/\.?0+$/, '');
		if (usd < 0.01) return '$' + usd.toFixed(6).replace(/\.?0+$/, '');
		if (usd < 1) return '$' + usd.toFixed(4).replace(/\.?0+$/, '');
		return '$' + usd.toFixed(2);
	}

	function networkLabel(network) {
		var n = String(network || '');
		if (n.startsWith('eip155:8453') && !n.startsWith('eip155:84532')) return 'Base';
		if (n.startsWith('eip155:84532')) return 'Base Sepolia';
		if (n.startsWith('eip155:42161')) return 'Arbitrum';
		if (n.startsWith('eip155:10')) return 'Optimism';
		if (n.startsWith('eip155:56')) return 'BNB Chain';
		if (n.startsWith('solana:')) return 'Solana';
		return 'Unknown';
	}

	function explorerUrl(network, txHash) {
		var n = String(network || '');
		if (n.startsWith('eip155:8453') && !n.startsWith('eip155:84532')) return 'https://basescan.org/tx/' + txHash;
		if (n.startsWith('eip155:84532')) return 'https://sepolia.basescan.org/tx/' + txHash;
		if (n.startsWith('eip155:42161')) return 'https://arbiscan.io/tx/' + txHash;
		if (n.startsWith('eip155:10')) return 'https://optimistic.etherscan.io/tx/' + txHash;
		if (n.startsWith('eip155:56')) return 'https://bscscan.com/tx/' + txHash;
		if (n.startsWith('solana:')) return 'https://solscan.io/tx/' + txHash;
		return null;
	}

	// ── Storage helpers ───────────────────────────────────────────────────

	function storageKey(endpoint) {
		return STORAGE_PREFIX + btoa(endpoint).replace(/=/g, '');
	}

	function hasAccess(endpoint) {
		try {
			var data = localStorage.getItem(storageKey(endpoint));
			if (!data) return false;
			var parsed = JSON.parse(data);
			if (parsed.expiresAt && Date.now() > parsed.expiresAt) {
				localStorage.removeItem(storageKey(endpoint));
				return false;
			}
			return true;
		} catch (_) {
			return false;
		}
	}

	function grantAccess(endpoint, meta) {
		try {
			localStorage.setItem(storageKey(endpoint), JSON.stringify({
				grantedAt: Date.now(),
				expiresAt: null,
				...meta,
			}));
		} catch (_) {}
	}

	// ── Fetch 402 requirements ────────────────────────────────────────────

	function fetchRequirements(endpoint) {
		return fetch(endpoint, {
			method: 'GET',
			headers: { 'Accept': 'application/json' },
		}).then(function (res) {
			if (res.status === 402) return res.json();
			if (res.ok) return null;
			throw new Error('Unexpected status ' + res.status);
		});
	}

	// ── Render overlay ────────────────────────────────────────────────────

	function buildOverlay(endpoint, data) {
		var overlay = document.createElement('div');
		overlay.className = 'x402-pw-overlay';

		var accepts = data && data.accepts;
		if (!accepts || !accepts.length) {
			overlay.innerHTML =
				'<div class="x402-pw-badge"><span class="x402-pw-badge-dot"></span>Premium</div>' +
				'<div class="x402-pw-price">Locked</div>' +
				'<div class="x402-pw-desc">Payment required to access this content.</div>';
			return overlay;
		}

		// Find cheapest non-zero, non-auth-hint accept
		var paid = accepts.filter(function (a) { return Number(a.amount || 0) > 0; });
		var cheapest = paid.length ? paid.reduce(function (a, b) {
			return Number(b.amount || 0) < Number(a.amount || 0) ? b : a;
		}, paid[0]) : accepts[0];

		var decimals = (cheapest.extra && cheapest.extra.decimals) || 6;
		var price = formatAmount(cheapest.amount, decimals);
		var assetName = (cheapest.extra && cheapest.extra.name) || 'USDC';

		var networks = [];
		var seen = {};
		paid.forEach(function (a) {
			var label = networkLabel(a.network);
			if (!seen[label]) {
				seen[label] = true;
				networks.push(label);
			}
		});

		var hasSiwx = data.extensions && data.extensions['sign-in-with-x'];
		var description = '';
		if (data.resource && data.resource.description) {
			description = data.resource.description;
		} else if (data.description) {
			description = data.description;
		}
		if (description.length > 120) {
			description = description.slice(0, 117) + '...';
		}

		var html =
			'<div class="x402-pw-badge"><span class="x402-pw-badge-dot"></span>Premium Content</div>' +
			'<div class="x402-pw-price">' + escHtml(price) + '</div>' +
			'<div class="x402-pw-desc">' + escHtml(description || 'Unlock this content with a single micropayment.') + '</div>' +
			'<button class="x402-pw-unlock" data-x402-pw-action="pay">' +
			'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>' +
			'Unlock with ' + escHtml(assetName) +
			'</button>';

		if (hasSiwx) {
			html +=
				'<button class="x402-pw-siwx" data-x402-pw-action="siwx">' +
				'Already paid? Sign in with wallet' +
				'</button>';
		}

		html +=
			'<div class="x402-pw-network">Available on ' + escHtml(networks.join(', ')) + '</div>' +
			'<div class="x402-pw-error" style="display:none" data-x402-pw-error></div>' +
			'<div class="x402-pw-footer">Powered by <a href="https://x402.org" target="_blank" rel="noopener">x402</a></div>';

		overlay.innerHTML = html;
		return overlay;
	}

	function escHtml(str) {
		return String(str)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	// ── Unlock animation ──────────────────────────────────────────────────

	function unlockElement(el, overlay, txHash, network) {
		overlay.classList.add('x402-pw-unlocking');
		setTimeout(function () {
			if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
			el.classList.add('x402-pw-unlocked');
		}, 350);
	}

	// ── Initialize one paywall element ────────────────────────────────────

	function initElement(el, opts) {
		var endpoint = el.getAttribute('data-x402-paywall');
		if (!endpoint) return;

		// Already unlocked from localStorage
		if (hasAccess(endpoint)) {
			el.classList.add('x402-pw-unlocked');
			if (opts && opts.onUnlock) opts.onUnlock(el, { cached: true });
			return;
		}

		// Fetch requirements
		var overlay = document.createElement('div');
		overlay.className = 'x402-pw-overlay';
		overlay.innerHTML = '<div class="x402-pw-badge"><span class="x402-pw-badge-dot"></span>Loading...</div>';
		el.appendChild(overlay);

		fetchRequirements(endpoint).then(function (data) {
			if (!data) {
				// Not a 402 — content is free
				el.classList.add('x402-pw-unlocked');
				if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
				if (opts && opts.onUnlock) opts.onUnlock(el, { free: true });
				return;
			}

			// Replace loading overlay with real content
			if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
			var realOverlay = buildOverlay(endpoint, data);
			el.appendChild(realOverlay);

			// Wire pay button
			realOverlay.addEventListener('click', function (e) {
				var btn = e.target.closest('[data-x402-pw-action]');
				if (!btn) return;
				var action = btn.getAttribute('data-x402-pw-action');

				if (action === 'pay') {
					handlePay(el, realOverlay, endpoint, data, opts);
				} else if (action === 'siwx') {
					handleSiwx(el, realOverlay, endpoint, opts);
				}
			});
		}).catch(function (err) {
			// Network error — show generic paywall
			if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
			var errorOverlay = buildOverlay(endpoint, null);
			el.appendChild(errorOverlay);
		});
	}

	function handlePay(el, overlay, endpoint, data, opts) {
		var btn = overlay.querySelector('[data-x402-pw-action="pay"]');
		var errorEl = overlay.querySelector('[data-x402-pw-error]');
		if (btn) {
			btn.disabled = true;
			btn.textContent = 'Connecting wallet...';
		}
		if (errorEl) errorEl.style.display = 'none';

		// Check for window.X402
		if (!window.X402 || typeof window.X402.pay !== 'function') {
			showError(overlay, 'Payment SDK not loaded. Include x402.js on this page.');
			if (btn) {
				btn.disabled = false;
				btn.textContent = 'Unlock with USDC';
			}
			return;
		}

		var serviceName = '';
		if (data && data.resource && data.resource.description) {
			serviceName = data.resource.description.split(' ').slice(0, 4).join(' ');
		}

		window.X402.pay({
			endpoint: endpoint,
			merchant: 'three.ws',
			action: serviceName || 'Unlock Content',
		}).then(function (result) {
			var txHash = result && result.payment && result.payment.transaction;
			var network = result && result.payment && result.payment.network;

			grantAccess(endpoint, {
				txHash: txHash,
				network: network,
				payer: result && result.payment && result.payment.payer,
			});

			unlockElement(el, overlay, txHash, network);

			if (opts && opts.onUnlock) {
				opts.onUnlock(el, { result: result, cached: false });
			}
		}).catch(function (err) {
			showError(overlay, err.message || 'Payment failed. Please try again.');
			if (btn) {
				btn.disabled = false;
				btn.textContent = 'Unlock with USDC';
			}
		});
	}

	function handleSiwx(el, overlay, endpoint, opts) {
		var siwxBtn = overlay.querySelector('[data-x402-pw-action="siwx"]');
		var errorEl = overlay.querySelector('[data-x402-pw-error]');
		if (siwxBtn) {
			siwxBtn.disabled = true;
			siwxBtn.textContent = 'Connecting...';
		}
		if (errorEl) errorEl.style.display = 'none';

		if (!window.X402 || typeof window.X402.siwx !== 'function') {
			// Fallback: try pay flow which may handle SIWX internally
			if (window.X402 && typeof window.X402.pay === 'function') {
				handlePay(el, overlay, endpoint, null, opts);
				return;
			}
			showError(overlay, 'SIWX not available. Include x402.js on this page.');
			if (siwxBtn) {
				siwxBtn.disabled = false;
				siwxBtn.textContent = 'Already paid? Sign in with wallet';
			}
			return;
		}

		window.X402.siwx({ endpoint: endpoint }).then(function (result) {
			grantAccess(endpoint, {
				siwx: true,
				address: result && result.address,
			});
			unlockElement(el, overlay);
			if (opts && opts.onUnlock) opts.onUnlock(el, { siwx: true, cached: false });
		}).catch(function (err) {
			showError(overlay, err.message || 'Wallet sign-in failed.');
			if (siwxBtn) {
				siwxBtn.disabled = false;
				siwxBtn.textContent = 'Already paid? Sign in with wallet';
			}
		});
	}

	function showError(overlay, message) {
		var el = overlay.querySelector('[data-x402-pw-error]');
		if (el) {
			el.textContent = message;
			el.style.display = 'block';
		}
	}

	// ── Public API ────────────────────────────────────────────────────────

	function init(opts) {
		opts = opts || {};
		injectStyles();
		var selector = opts.selector || '[data-x402-paywall]';
		var elements = document.querySelectorAll(selector);
		for (var i = 0; i < elements.length; i++) {
			initElement(elements[i], opts);
		}
	}

	// ── Auto-init on DOMContentLoaded ─────────────────────────────────────

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', function () { init(); });
	} else {
		// DOM already loaded (script loaded async/deferred)
		setTimeout(function () { init(); }, 0);
	}

	// ── Export ─────────────────────────────────────────────────────────────

	window.X402Paywall = {
		init: init,
		hasAccess: hasAccess,
		grantAccess: grantAccess,
		clearAccess: function (endpoint) {
			try { localStorage.removeItem(storageKey(endpoint)); } catch (_) {}
		},
	};
})();
