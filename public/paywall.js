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

		// Wire the close button
		var closeBtn = document.getElementById('close-btn');
		if (closeBtn) closeBtn.href = returnUrl;

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

	// ── Wallet click ───────────────────────────────────────────────────────

	/**
	 * Show an "Opening wallet…" message with the raw payment requirements.
	 * Full on-chain wallet integration is browser-wallet-specific; this UI
	 * explains what would happen and surfaces the requirements for dev use.
	 */
	function handleWalletClick(walletName, net, requirements) {
		var statusId = 'wallet-status-' + net;
		var statusEl = document.getElementById(statusId);
		if (!statusEl) return;

		var req = (requirements || []).find(function (r) {
			return net === 'solana' ? isSolana(r.network) : isBase(r.network);
		});

		statusEl.classList.add('visible');

		if (walletName === 'metamask' || walletName === 'coinbase' || walletName === 'walletconnect') {
			statusEl.innerHTML =
				'<strong>Opening ' + escHtml(walletName.charAt(0).toUpperCase() + walletName.slice(1)) + ' Wallet…</strong><br />' +
				'Full browser wallet integration is coming to three.ws. To pay manually as a developer, ' +
				'use the x402 CLI or SDK with the requirements shown in the Advanced panel below.' +
				(req ? '<br /><br /><strong>Pay to:</strong> <code>' + escHtml(req.payTo || '') + '</code>' +
					'<br /><strong>Amount:</strong> ' + escHtml(formatAmount(req.amount, (req.extra && req.extra.decimals) || 6)) +
					'<br /><strong>Asset:</strong> <code>' + escHtml(req.asset || '') + '</code>' : '');
		} else if (walletName === 'phantom' || walletName === 'solflare') {
			statusEl.innerHTML =
				'<strong>Opening ' + escHtml(walletName.charAt(0).toUpperCase() + walletName.slice(1)) + '…</strong><br />' +
				'Solana wallet signing is coming soon. Use the x402 Solana SDK to pay programmatically.' +
				(req ? '<br /><br /><strong>Pay to:</strong> <code>' + escHtml(req.payTo || '') + '</code>' +
					'<br /><strong>Amount:</strong> ' + escHtml(formatAmount(req.amount, 6)) : '');
		}

		// Open the accordion automatically so the developer sees the raw requirements
		var advBody = document.getElementById('adv-body');
		var advToggle = document.getElementById('adv-toggle');
		if (advBody && !advBody.classList.contains('open')) {
			advBody.classList.add('open');
			if (advToggle) advToggle.classList.add('open');
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
