// Fact Checker UI — drives pages/fact-checker.html.
// Calls POST /api/x402/fact-check. Handles 402 payment required, errors,
// loading skeleton, result rendering with source cards and attestation.

import { sanitizeUrl } from './shared/sanitize-url.js';

const API_URL = '/api/x402/fact-check';

// ── DOM refs ──────────────────────────────────────────────────────────────────

function el(id) {
	return document.getElementById(id);
}

// ── State ─────────────────────────────────────────────────────────────────────

let lastClaim = '';
let lastStrictness = 'medium';

// ── Visibility helpers ────────────────────────────────────────────────────────

function showOnly(panelId) {
	for (const id of ['skeleton', 'result-panel', 'error-panel', 'payment-panel', 'empty-state']) {
		const node = el(id);
		if (!node) continue;
		if (id === panelId) {
			node.classList.add('active');
		} else {
			node.classList.remove('active');
		}
	}
}

function setLoading(active) {
	const btn = el('check-btn');
	const status = el('loading-status');
	if (btn) {
		btn.disabled = active;
		btn.setAttribute('aria-busy', String(active));
	}
	if (status) status.classList.toggle('active', active);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

const VERDICT_LABELS = {
	supported: 'SUPPORTED',
	contradicted: 'CONTRADICTED',
	mixed: 'MIXED',
	insufficient: 'INSUFFICIENT',
};

function renderVerdict(data) {
	const banner = el('verdict-banner');
	const label = el('verdict-label');
	const conf = el('verdict-confidence');
	const claimEl = el('verdict-claim');

	if (!banner || !label || !conf || !claimEl) return;

	banner.className = `verdict-banner ${data.verdict}`;
	label.textContent = VERDICT_LABELS[data.verdict] || data.verdict.toUpperCase();
	conf.textContent = `${Math.round(data.confidence * 100)}% confidence`;
	claimEl.textContent = `"${data.claim}"`;
}

function faviconUrl(sourceUrl) {
	try {
		const { hostname } = new URL(sourceUrl);
		return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32`;
	} catch {
		return '';
	}
}

function stancePill(stance) {
	const labels = { supports: 'Supports', contradicts: 'Contradicts', neutral: 'Neutral' };
	return `<span class="stance-pill ${stance}">${labels[stance] || stance}</span>`;
}

function renderSources(sources) {
	const grid = el('sources-grid');
	if (!grid) return;

	grid.innerHTML = sources
		.map((s) => {
			const favicon = faviconUrl(s.url);
			const authorityPct = Math.round(s.weight * 100);
			const shortUrl = (() => {
				try {
					return new URL(s.url).hostname.replace(/^www\./, '');
				} catch {
					return s.url.slice(0, 40);
				}
			})();
			return `
				<div class="source-card">
					<div class="source-header">
						${favicon ? `<img class="source-favicon" src="${favicon}" alt="" loading="lazy" data-fallback="hide" />` : ''}
						<div class="source-title">
							<a href="${escHtml(sanitizeUrl(s.url))}" target="_blank" rel="noopener noreferrer">${escHtml(s.title || shortUrl)}</a>
						</div>
					</div>
					${s.excerpt ? `<div class="source-excerpt">${escHtml(s.excerpt)}</div>` : ''}
					<div class="source-footer">
						${stancePill(s.stance)}
						<span class="source-authority">${shortUrl} · ${authorityPct}% authority</span>
					</div>
				</div>
			`;
		})
		.join('');
}

function renderCostBreakdown(cost) {
	const grid = el('cost-grid');
	if (!grid) return;

	const usdcVal = parseFloat(cost.totalUsdc || 0).toFixed(4);
	grid.innerHTML = `
		<div class="cost-item">
			<span class="cost-key">Search calls</span>
			<span class="cost-val">${cost.searchCalls}</span>
		</div>
		<div class="cost-item">
			<span class="cost-key">LLM tokens</span>
			<span class="cost-val">${cost.llmTokens.toLocaleString()}</span>
		</div>
		<div class="cost-item">
			<span class="cost-key">Total USDC</span>
			<span class="cost-val">$${usdcVal}</span>
		</div>
		${cost.cachedAt ? `
		<div class="cost-item">
			<span class="cost-key">Cached</span>
			<span class="cost-val" style="font-size:12px;">${new Date(cost.cachedAt).toLocaleString()}</span>
		</div>` : ''}
	`;
}

function renderAttestation(attestation) {
	const hash = el('attest-hash');
	if (hash) hash.textContent = attestation;
}

function renderResult(data) {
	renderVerdict(data);
	renderSources(data.sources || []);
	renderCostBreakdown({
		...data.costBreakdown,
		cachedAt: data.cachedAt,
	});
	renderAttestation(data.attestation || '');
	showOnly('result-panel');
}

// ── 402 Payment required ──────────────────────────────────────────────────────

function renderPaymentRequired(responseData) {
	// Parse the per-network prices from the live 402 challenge. We never fall back
	// to a hardcoded number: if the challenge can't be read, the UI says so plainly
	// rather than quoting a possibly-stale price.
	const accepts = Array.isArray(responseData?.accepts) ? responseData.accepts : [];
	const baseEl = el('payment-price-base');
	const solEl = el('payment-price-sol');
	const UNAVAILABLE = 'price unavailable';

	let basePrice = null;
	let solPrice = null;
	for (const acc of accepts) {
		const atomics = parseInt(acc?.amount || '0', 10);
		if (!Number.isFinite(atomics) || atomics <= 0) continue;
		const usdc = `$${(atomics / 1_000_000).toFixed(2)}`;
		if (acc.network?.includes('8453') || acc.network === 'base') basePrice = usdc;
		if (acc.network?.includes('solana') || acc.network?.includes('5eykt')) solPrice = usdc;
	}

	if (baseEl) baseEl.textContent = basePrice || UNAVAILABLE;
	if (solEl) solEl.textContent = solPrice || UNAVAILABLE;

	// A single authoritative price for the description: prefer the server's own
	// priceUsdc, else the lowest network quote we parsed, else admit it's unknown.
	const descEl = el('payment-desc');
	if (descEl) {
		const headline = responseData?.priceUsdc || basePrice || solPrice;
		descEl.textContent = headline
			? `This endpoint costs ${headline} per check. Connect your wallet to pay with USDC on Base or Solana.`
			: 'This endpoint requires a USDC payment per check, but the live price could not be read just now. Connect your wallet to pay with USDC on Base or Solana — the exact amount is confirmed in your wallet before you sign.';
	}

	showOnly('payment-panel');
}

// ── API call ──────────────────────────────────────────────────────────────────

async function runCheck(claim, strictness) {
	setLoading(true);
	updateLoadingStatus('Checking — searching sources and weighing evidence…');
	showOnly('skeleton');

	try {
		const res = await fetch(API_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ claim, strictness }),
		});

		if (res.status === 402) {
			let body = null;
			try {
				body = await res.json();
			} catch {
				body = null;
			}
			renderPaymentRequired(body);
			return;
		}

		if (!res.ok) {
			let errBody = null;
			try {
				errBody = await res.json();
			} catch {
				errBody = null;
			}
			showError(
				errBody?.error || errBody?.message || friendlyHttpError(res.status),
				errBody?.code || `http_${res.status}`,
			);
			return;
		}

		const data = await res.json();
		renderResult(data);
	} catch (err) {
		showError(err.message || 'Network error — check your connection.', 'network_error');
	} finally {
		setLoading(false);
		updateLoadingStatus('');
	}
}

// ── Error rendering ───────────────────────────────────────────────────────────

function showError(message, code) {
	const msg = el('error-msg');
	const codeEl = el('error-code');
	if (msg) msg.textContent = message;
	if (codeEl) codeEl.textContent = code ? `Error code: ${code}` : '';
	showOnly('error-panel');
}

// ── Char counter ──────────────────────────────────────────────────────────────

function updateCharCounter(len) {
	const counter = el('char-counter');
	if (!counter) return;
	counter.textContent = `${len} / 1000`;
	counter.className = 'char-counter';
	if (len > 900) counter.classList.add('warn');
	if (len >= 1000) counter.classList.add('over');
}

// ── Loading status text ───────────────────────────────────────────────────────

// The /api/x402/fact-check endpoint returns a single JSON response — it does not
// stream per-stage progress. So we show one honest indicator for the whole wait
// rather than inventing timed "stages" that bear no relation to the backend.
function updateLoadingStatus(text) {
	const el2 = el('loading-status');
	if (!el2) return;
	el2.textContent = text || '';
}

// ── HTTP status → friendly copy ────────────────────────────────────────────────

function friendlyHttpError(status) {
	switch (status) {
		case 429:
			return 'Too many checks right now. Wait a moment and try again.';
		case 500:
			return 'The fact-checker hit an internal error. Please try again.';
		case 502:
		case 503:
			return 'The fact-checker is temporarily unavailable. Please try again in a few seconds.';
		case 504:
			return 'The check took too long to respond. Please try again.';
		default:
			return `The request failed (HTTP ${status}). Please try again.`;
	}
}

// ── Attestation toggle ────────────────────────────────────────────────────────

function initAttestationToggle() {
	const toggle = el('attest-toggle');
	const body = el('attest-body');
	if (!toggle || !body) return;

	toggle.addEventListener('click', () => {
		const expanded = toggle.getAttribute('aria-expanded') === 'true';
		toggle.setAttribute('aria-expanded', String(!expanded));
		body.classList.toggle('open', !expanded);
	});
}

// ── Escape HTML ───────────────────────────────────────────────────────────────

function escHtml(str) {
	return String(str)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function init() {
	const textarea = el('claim-input');
	const checkBtn = el('check-btn');
	const retryBtn = el('retry-btn');

	// Char counter.
	textarea?.addEventListener('input', () => {
		updateCharCounter(textarea.value.length);
	});

	// Example chips.
	document.querySelectorAll('.example-chip').forEach((chip) => {
		chip.addEventListener('click', () => {
			if (textarea) {
				textarea.value = chip.dataset.claim || '';
				updateCharCounter(textarea.value.length);
				textarea.focus();
			}
		});
	});

	// Form submit.
	checkBtn?.addEventListener('click', () => {
		const claim = textarea?.value.trim() || '';
		if (!claim) {
			textarea?.focus();
			return;
		}
		if (claim.length > 1000) {
			showError('Claim is too long. Maximum is 1000 characters.', 'claim_too_long');
			return;
		}

		const strictness =
			document.querySelector('input[name="strictness"]:checked')?.value || 'medium';

		lastClaim = claim;
		lastStrictness = strictness;

		// Hide empty state immediately.
		const emptyState = el('empty-state');
		if (emptyState) emptyState.classList.remove('active');

		runCheck(claim, strictness);
	});

	// Retry button.
	retryBtn?.addEventListener('click', () => {
		if (lastClaim) {
			runCheck(lastClaim, lastStrictness);
		}
	});

	// Textarea keyboard shortcut (Ctrl/Cmd + Enter).
	textarea?.addEventListener('keydown', (e) => {
		if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
			checkBtn?.click();
		}
	});

	// Attestation collapsible.
	initAttestationToggle();

	// Show empty state on load.
	showOnly('empty-state');
}

// Auto-init when the module is loaded.
init();
