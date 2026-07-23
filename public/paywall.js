(function () {
	'use strict';

	// ── URL param helpers ──────────────────────────────────────────────────

	function getParams() {
		return new URLSearchParams(location.search);
	}

	/**
	 * Decode the base64url-encoded PaymentRequirements from ?req=
	 * Handles both base64url (from Buffer.toString('base64url')) and
	 * standard base64 (from btoa).
	 *
	 * @returns {Array|null}
	 */
	function decodeRequirements() {
		var params = getParams();
		var raw = params.get('req');
		if (!raw) return null;
		try {
			// Normalise base64url → base64
			var b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
			// Pad to multiple of 4
			while (b64.length % 4 !== 0) b64 += '=';
			var json = decodeURIComponent(escape(atob(b64)));
			var parsed = JSON.parse(json);
			// Accept either a single object (one requirement) or an array
			return Array.isArray(parsed) ? parsed : [parsed];
		} catch (e) {
			return null;
		}
	}

	// safeNavUrl: inline copy of src/safe-next.js (tests/safe-next.test.js drift-guards it).
function safeNavUrl(raw, fallback = '/') {
	if (typeof raw !== 'string' || raw.length === 0) return fallback;
	// eslint-disable-next-line no-control-regex
	if (raw.includes('\\') || /[ -]/.test(raw)) return fallback;
	// Same-origin relative path.
	if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
	// Absolute URL: http(s) only, so javascript:/data:/vbscript: can never
	// reach an href or location sink. The WHATWG parser strips leading
	// whitespace and C0 controls before scheme parsing, and lowercases the
	// scheme, so ' javascript:...' and 'JaVaScRiPt:...' both fail here.
	try {
		const u = new URL(raw);
		if (u.protocol === 'https:' || u.protocol === 'http:') return u.href;
	} catch {
		// Not a parseable absolute URL: fall through to the fallback.
	}
	return fallback;
}

	function getReturnUrl() {
		var params = getParams();
		var ret = params.get('return');
		if (!ret) return '/';
		try { return decodeURIComponent(ret); } catch (e) { return '/'; }
	}

	// ── Price formatting ───────────────────────────────────────────────────

	/**
	 * Format atomics amount to human-readable USD string.
	 * @param {string|number} amount  raw atomics (USDC has 6 decimals)
	 * @param {number} [decimals=6]
	 * @returns {string}  e.g. "$0.001"
	 */
	function formatAmount(amount, decimals) {
		decimals = decimals || 6;
		var n = Number(amount || 0);
		var usd = n / Math.pow(10, decimals);
		// Show enough decimal places to make small amounts readable
		var str;
		if (usd === 0) {
			str = '0.00';
		} else if (usd < 0.000001) {
			str = usd.toFixed(8).replace(/\.?0+$/, '');
		} else if (usd < 0.01) {
			str = usd.toFixed(6).replace(/\.?0+$/, '');
		} else if (usd < 1) {
			str = usd.toFixed(4).replace(/\.?0+$/, '');
		} else {
			str = usd.toFixed(2);
		}
		return '$' + str;
	}

	// ── Network detection ──────────────────────────────────────────────────

	var SOLANA_NETWORK_PREFIX = 'solana:';
	var BASE_NETWORK_PREFIX = 'eip155:8453';
	var BASE_SEP_PREFIX = 'eip155:84532';
	var TESTNET_NETWORKS = ['eip155:84532', 'eip155:11155111', 'solana:devnet'];

	function isTestnet(network) {
		return TESTNET_NETWORKS.some(function (t) { return String(network || '').startsWith(t); });
	}

	function isSolana(network) {
		return String(network || '').startsWith(SOLANA_NETWORK_PREFIX);
	}

	function isBase(network) {
		var n = String(network || '');
		return n.startsWith(BASE_NETWORK_PREFIX) || n.startsWith(BASE_SEP_PREFIX) || n.startsWith('eip155:');
	}

	// ── Render ─────────────────────────────────────────────────────────────

	function render(requirements) {
		var returnUrl = getReturnUrl();

		// Wire the close button. The return URL comes from the query string, so
		// it must pass the scheme guard: a crafted link could otherwise turn the
		// close button into a javascript: execution sink in this origin.
		var closeBtn = document.getElementById('close-btn');
		if (closeBtn) closeBtn.href = safeNavUrl(returnUrl);

		if (!requirements || !requirements.length) {
			// No requirements decoded — show generic message
			setEl('service-name', 'Payment Required');
			setEl('service-desc', 'This endpoint requires a micropayment.');
			setEl('price-amount', '—');
			setEl('raw-json', '(no payment requirements found in URL)');
			return;
		}

		// Find the cheapest non-zero requirement for the price display
		var cheapest = requirements.reduce(function (a, b) {
			return Number(b.amount || 0) < Number(a.amount || 0) ? b : a;
		}, requirements[0]);

		var decimals = (cheapest.extra && cheapest.extra.decimals) || 6;
		var price = formatAmount(cheapest.amount, decimals);
		var assetName = (cheapest.extra && cheapest.extra.name) || 'USDC';

		setEl('price-amount', price);
		setEl('price-currency', assetName + ' on ' + networkLabel(cheapest.network));

		// Service name / description from tags or resource URL
		var serviceName = cheapest.serviceName || extractServiceName(cheapest.resource);
		var desc = cheapest.description || 'Access this paid endpoint with a single micropayment.';
		setEl('service-name', serviceName);
		setEl('service-desc', desc);

		// Check which networks are actually present
		var hasBase = requirements.some(function (r) { return isBase(r.network); });
		var hasSolana = requirements.some(function (r) { return isSolana(r.network); });

		// Show/hide tabs
		var tabBase = document.getElementById('tab-base');
		var tabSolana = document.getElementById('tab-solana');
		var tabRow = document.getElementById('tab-row');

		if (!hasBase && hasSolana) {
			// Solana only — hide Base tab, activate Solana
			if (tabBase) tabBase.style.display = 'none';
			activateTab('solana');
		} else if (!hasSolana) {
			// Base only — hide Solana tab
			if (tabSolana) tabSolana.style.display = 'none';
		}

		// Testnet hint
		var hasTestnet = requirements.some(function (r) { return isTestnet(r.network); });
		if (hasTestnet) {
			var hint = document.getElementById('testnet-hint-base');
			if (hint) hint.classList.add('visible');
		}

		// Raw JSON
		setEl('raw-json', JSON.stringify(requirements, null, 2));
	}

	function networkLabel(network) {
		var n = String(network || '');
		if (n.startsWith('eip155:8453')) return 'Base';
		if (n.startsWith('eip155:84532')) return 'Base Sepolia';
		if (n.startsWith('solana:')) return 'Solana';
		if (n.startsWith('eip155:56')) return 'BNB Chain';
		return network || 'Unknown';
	}

	function extractServiceName(resourceUrl) {
		if (!resourceUrl) return 'Paid Endpoint';
		try {
			var u = new URL(resourceUrl);
			var parts = u.pathname.split('/').filter(Boolean);
			if (parts.length >= 2) {
				return parts[parts.length - 1]
					.replace(/-/g, ' ')
					.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
			}
			return u.hostname;
		} catch (e) { return 'Paid Endpoint'; }
	}

	function setEl(id, text) {
		var el = document.getElementById(id);
		if (el) el.textContent = text;
	}

	// ── Tab switching ──────────────────────────────────────────────────────

	function activateTab(net) {
		var tabs = document.querySelectorAll('.tab-btn');
		var panels = document.querySelectorAll('.net-panel');
		tabs.forEach(function (t) {
			t.classList.toggle('active', t.dataset.net === net);
		});
		panels.forEach(function (p) {
			p.classList.toggle('active', p.id === 'net-' + net);
		});
	}

	// ── Wallet click — real x402 payment flow ───────────────────────────────

	var paymentInFlight = false;

	var PHASE_TEXT = {
		connecting: 'Connecting wallet…',
		building: 'Building payment…',
		signing: 'Waiting for signature…',
		confirming: 'Confirming on-chain…',
	};

	function spinnerSvg() {
		return '<svg class="pw-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
			'<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3" stroke-opacity="0.25" />' +
			'<path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round" />' +
			'</svg>';
	}

	function setWalletStatus(statusEl, phase, text) {
		statusEl.classList.add('visible');
		statusEl.classList.remove('pw-status-error');
		statusEl.setAttribute('role', 'status');
		var msg = text || PHASE_TEXT[phase] || 'Working…';
		statusEl.innerHTML =
			'<span class="pw-status-row">' + spinnerSvg() + '<span>' + escHtml(msg) + '</span></span>';
	}

	function setWalletError(statusEl, message) {
		statusEl.classList.add('visible');
		statusEl.classList.add('pw-status-error');
		statusEl.setAttribute('role', 'alert');
		statusEl.innerHTML = '<strong>Payment failed.</strong> ' + escHtml(message);
	}

	function setButtonsDisabled(disabled) {
		document.querySelectorAll('.wallet-btn').forEach(function (b) {
			b.disabled = disabled;
		});
	}

	/**
	 * Connect the chosen wallet, build + sign the x402 payment per the surfaced
	 * requirement, settle on-chain, retry the gated resource with the proof, and
	 * reveal the unlocked content. Drives real connecting/signing/confirming
	 * states throughout — no fake progress.
	 */
	function handleWalletClick(walletName, net, requirements) {
		if (paymentInFlight) return;
		var statusEl = document.getElementById('wallet-status-' + net);
		if (!statusEl) return;

		var api = window.PaywallWallet;
		if (!api || typeof api.pay !== 'function') {
			setWalletError(statusEl, 'Payment module failed to load. Reload the page and try again.');
			return;
		}

		var accept = (requirements || []).find(function (r) {
			return net === 'solana' ? isSolana(r.network) : isBase(r.network);
		});
		if (!accept) {
			setWalletError(statusEl, 'No payment option is available for this network.');
			return;
		}

		var resourceUrl = api.resolveResourceUrl(accept, getReturnUrl());

		paymentInFlight = true;
		setButtonsDisabled(true);
		setWalletStatus(statusEl, 'connecting');

		api.pay({
			accept: accept,
			resourceUrl: resourceUrl,
			walletName: walletName,
			onStatus: function (phase, text) {
				if (phase === 'error') setWalletError(statusEl, text);
				else if (phase !== 'done') setWalletStatus(statusEl, phase, text);
			},
		}).then(function (outcome) {
			paymentInFlight = false;
			revealUnlocked(outcome, accept);
		}).catch(function (err) {
			// On mobile with no injected wallet, pay() redirects into the wallet's
			// in-app browser — the page is unloading, so keep the "Opening…" status
			// instead of flashing a failure.
			if (err && err.code === 'mobile_redirect') return;
			paymentInFlight = false;
			setButtonsDisabled(false);
			setWalletError(statusEl, (err && err.message) || 'Payment failed. Please try again.');
		});
	}

	// ── Unlocked state ───────────────────────────────────────────────────────

	function receiptRow(label, valueHtml, isRaw) {
		return '<div class="pw-receipt-row"><span class="pw-k">' + escHtml(label) + '</span>' +
			'<span class="pw-v">' + (isRaw ? valueHtml : escHtml(valueHtml)) + '</span></div>';
	}

	function shortId(value, head, tail) {
		if (!value) return '—';
		return value.slice(0, head) + '…' + value.slice(-tail);
	}

	function revealUnlocked(outcome, accept) {
		var card = document.getElementById('pay-card');
		if (!card) return;
		var net = accept.network;
		var explorer = window.PaywallWallet.explorerUrl(net, outcome.transaction);
		var txCell = null;
		if (outcome.transaction) {
			var txShort = escHtml(shortId(outcome.transaction, 10, 8));
			txCell = explorer
				? '<a href="' + escHtml(explorer) + '" target="_blank" rel="noopener">' + txShort + ' ↗</a>'
				: txShort;
		}

		var isHtml = (outcome.contentType || '').indexOf('html') !== -1 && typeof outcome.result === 'string';
		var contentHtml = isHtml
			? '<iframe id="pw-content-frame" class="pw-content-frame" sandbox="allow-same-origin" title="Unlocked content"></iframe>'
			: '<pre class="pw-content-pre">' + escHtml(
				typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result, null, 2)
			) + '</pre>';

		card.innerHTML =
			'<div class="card-head">' +
				'<div class="service-row">' +
					'<div class="service-icon pw-ok-icon">✓</div>' +
					'<div><div class="service-name">Payment confirmed</div>' +
					'<div class="service-desc">Content unlocked — settled on-chain via x402.</div></div>' +
				'</div>' +
				'<div class="pw-receipt">' +
					receiptRow('Network', networkLabel(net)) +
					receiptRow('Payer', shortId(outcome.payer, 6, 4)) +
					(txCell ? receiptRow('Transaction', txCell, true) : '') +
				'</div>' +
			'</div>' +
			'<div class="card-body">' +
				'<div class="pw-unlocked-label">Unlocked content</div>' +
				contentHtml +
			'</div>' +
			'<div class="card-foot">' +
				'<span class="foot-text">Settled on ' + escHtml(networkLabel(net)) + ' · powered by x402</span>' +
			'</div>';

		if (isHtml) {
			var frame = document.getElementById('pw-content-frame');
			if (frame) frame.srcdoc = outcome.result;
		}
	}

	function escHtml(str) {
		return String(str)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	// ── Wire events ────────────────────────────────────────────────────────

	document.addEventListener('DOMContentLoaded', function () {
		var requirements = decodeRequirements();
		render(requirements);

		// Tab clicks
		var tabRow = document.getElementById('tab-row');
		if (tabRow) {
			tabRow.addEventListener('click', function (e) {
				var btn = e.target.closest('.tab-btn');
				if (!btn) return;
				activateTab(btn.dataset.net);
			});
		}

		// Wallet button clicks — delegate from both panels
		var payCard = document.getElementById('pay-card');
		if (payCard) {
			payCard.addEventListener('click', function (e) {
				var btn = e.target.closest('.wallet-btn');
				if (!btn) return;
				// Determine which network panel is active
				var activePanel = payCard.querySelector('.net-panel.active');
				var net = activePanel ? activePanel.id.replace('net-', '') : 'base';
				handleWalletClick(btn.dataset.wallet, net, requirements);
			});
		}

		// Accordion toggle
		var advToggle = document.getElementById('adv-toggle');
		var advBody = document.getElementById('adv-body');
		if (advToggle && advBody) {
			advToggle.addEventListener('click', function () {
				var open = advBody.classList.toggle('open');
				advToggle.classList.toggle('open', open);
			});
		}
	});
})();
