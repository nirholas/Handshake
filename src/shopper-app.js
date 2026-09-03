// Endpoint Shopper UI — wires the form to /api/agents/endpoint-shopper-run
// and renders the execution timeline with step-by-step animation.

const STEP_ICONS = {
	discover: '🔍',
	plan: '🗺',
	call: '⚡',
	synthesize: '🧠',
};

const ACTION_LABELS = {
	discover: 'Discover',
	plan: 'Plan',
	call: 'Call',
	synthesize: 'Synthesize',
};

// The agent charges a $0.01 base fee and spends up to the budget on downstream
// calls, so a budget below the base fee can't fund a single paid step.
const MIN_BUDGET_USD = 0.01;

const RUN_ROUTE = '/api/agents/endpoint-shopper-run';

// The browser payment core is a static asset in public/, so it is pulled in as a
// script tag (the interface it exposes is window.PaywallWallet, exactly what the
// full-page paywall consumes) rather than a bundler import, and only once a 402
// actually arrives, so the wallet + web3 code never costs the first paint.
const PAY_CORE_URL = '/x402-pay-core.js';

let payCorePromise = null;

function loadPayCore() {
	if (window.PaywallWallet) return Promise.resolve(window.PaywallWallet);
	if (payCorePromise) return payCorePromise;
	payCorePromise = new Promise((resolve, reject) => {
		const tag = document.createElement('script');
		tag.type = 'module';
		tag.src = PAY_CORE_URL;
		tag.addEventListener('load', () => {
			if (window.PaywallWallet) resolve(window.PaywallWallet);
			else reject(new Error('The payment module loaded but did not initialise. Reload the page and try again.'));
		});
		tag.addEventListener('error', () => {
			payCorePromise = null;
			tag.remove();
			reject(new Error('The payment module failed to load. Check your connection and try again.'));
		});
		document.head.appendChild(tag);
	});
	return payCorePromise;
}

const WALLETS = {
	base: [
		{ id: 'coinbase', label: 'Coinbase Wallet' },
		{ id: 'metamask', label: 'MetaMask' },
		{ id: 'walletconnect', label: 'WalletConnect' },
	],
	solana: [
		{ id: 'phantom', label: 'Phantom' },
		{ id: 'solflare', label: 'Solflare' },
	],
};

const RUN_BTN_HTML =
	'<svg width="14" height="14" fill="none" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 2l9 5-9 5V2z" fill="currentColor"/></svg> Run Task';

// The empty state ships in the page markup so it paints before this module
// loads. Captured once here so any later state can hand the panel back to it.
let emptyStateHtml = '';

function renderEmptyState(panel) {
	panel.innerHTML = emptyStateHtml;
}

export function init() {
	const taskInput = document.getElementById('task-input');
	const runBtn = document.getElementById('run-btn');
	const budgetSlider = document.getElementById('budget-slider');
	const budgetDisplay = document.getElementById('budget-display');
	const resultPanel = document.getElementById('result-panel');
	const chipRow = document.getElementById('chip-row');
	const runHint = document.getElementById('run-hint');

	if (!taskInput || !runBtn || !resultPanel) return;

	emptyStateHtml = resultPanel.innerHTML;

	// Gate the CTA on a non-empty task and a fundable budget. Distinct hints
	// tell the user exactly which precondition is unmet before they pay.
	function refreshGate() {
		const task = taskInput.value.trim();
		const budget = parseFloat(budgetSlider.value);
		let reason = '';

		if (!task) {
			reason = 'Describe a task to run.';
		} else if (!(budget >= MIN_BUDGET_USD)) {
			reason = `Raise the budget to at least $${MIN_BUDGET_USD.toFixed(2)} — the agent can't fund a paid call below that.`;
		}

		runBtn.disabled = !!reason;
		if (runHint) {
			runHint.textContent = reason;
			runHint.classList.toggle('warn', !!reason);
		}
		return !reason;
	}

	// Budget slider
	budgetSlider.addEventListener('input', () => {
		budgetDisplay.textContent = `$${parseFloat(budgetSlider.value).toFixed(2)}`;
		refreshGate();
	});

	taskInput.addEventListener('input', refreshGate);

	// Example task chips
	chipRow.addEventListener('click', (e) => {
		const chip = e.target.closest('.chip');
		if (!chip) return;
		taskInput.value = chip.dataset.task || '';
		taskInput.focus();
		refreshGate();
	});

	// Form submit
	runBtn.addEventListener('click', () => {
		if (!refreshGate()) {
			taskInput.focus();
			return;
		}
		const task = taskInput.value.trim();
		const maxCostUsd = parseFloat(budgetSlider.value) || 0.5;
		runTask({ task, maxCostUsd, resultPanel, runBtn, refreshGate });
	});

	taskInput.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			runBtn.click();
		}
	});

	// Establish the initial gate state (empty task → disabled, hint shown).
	refreshGate();
}

async function runTask({ task, maxCostUsd, resultPanel, runBtn, refreshGate }) {
	runBtn.disabled = true;
	runBtn.textContent = 'Running…';

	showSkeleton(resultPanel);

	let data;
	try {
		const res = await fetch(RUN_ROUTE, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ task, maxCostUsd }),
		});

		if (res.status === 402) {
			const body = await res.json().catch(() => ({}));
			showPaymentRequired(resultPanel, {
				body,
				header: res.headers.get('payment-required'),
				task,
				maxCostUsd,
			});
			return;
		}

		if (res.status === 400) {
			const body = await res.json().catch(() => ({}));
			showError(
				resultPanel,
				body.error || body.message || 'That task or budget was rejected. Adjust your inputs and try again.',
			);
			return;
		}

		if (!res.ok) {
			const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
			const isServer = res.status >= 500;
			showError(
				resultPanel,
				body.error || body.message || (isServer
					? 'The agent service is temporarily unavailable. Please try again in a moment.'
					: `Request failed (HTTP ${res.status}).`),
			);
			return;
		}

		data = await res.json();
	} catch (err) {
		showError(resultPanel, err.message || 'Network error. Check your connection and try again.');
		return;
	} finally {
		runBtn.innerHTML = RUN_BTN_HTML;
		// Re-evaluate preconditions so the CTA only re-enables when valid.
		if (typeof refreshGate === 'function') refreshGate();
		else runBtn.disabled = false;
	}

	renderResults(resultPanel, data, task);
}

function showSkeleton(panel) {
	panel.innerHTML = `
		<div class="skeleton-list">
			<div class="skeleton-item"></div>
			<div class="skeleton-item"></div>
			<div class="skeleton-item"></div>
		</div>
	`;
}

function showError(panel, message) {
	panel.innerHTML = `
		<div class="error-card">
			<p>${escHtml(message)}</p>
			<button class="btn" type="button" id="error-retry">Run again</button>
		</div>
	`;
	const retry = panel.querySelector('#error-retry');
	if (retry) {
		retry.addEventListener('click', () => {
			// Keep the user's task and budget; just re-trigger the run.
			const runBtn = document.getElementById('run-btn');
			if (runBtn && !runBtn.disabled) runBtn.click();
			else document.getElementById('task-input')?.focus();
		});
	}
}

// ── Payment (402) ─────────────────────────────────────────────────────────
//
// The run route is a real x402 paid endpoint. Rather than bounce the user to
// the generic /paywall.html (which loses the task and budget they typed, and
// replays the resource as a bodyless GET that this POST route cannot answer),
// the payment happens inline: the wallet signs against the advertised
// requirement, and the SAME request that earned the 402 is replayed with the
// X-PAYMENT proof, so the buyer gets the run they paid for.

// Pull the payment requirements out of a 402. The canonical copy is the JSON
// body's `accepts`; the base64 `payment-required` header carries the same
// envelope for proxies that rewrite bodies, so it is the fallback.
export function readAccepts(body, header) {
	const fromBody = Array.isArray(body?.accepts) ? body.accepts : null;
	if (fromBody?.length) return fromBody;

	const decoded = decodeChallengeHeader(header);
	const fromHeader = Array.isArray(decoded?.accepts)
		? decoded.accepts
		: Array.isArray(decoded)
			? decoded
			: null;
	return fromHeader?.length ? fromHeader : [];
}

function decodeChallengeHeader(header) {
	if (!header || typeof header !== 'string') return null;
	try {
		let b64 = header.replace(/-/g, '+').replace(/_/g, '/');
		while (b64.length % 4 !== 0) b64 += '=';
		return JSON.parse(decodeURIComponent(escape(atob(b64))));
	} catch {
		return null;
	}
}

// Pick the requirement to sign for one network. The server advertises several
// entries per chain (a plain USDC transfer, a Permit2 sibling, and a $THREE
// option); the wallet flow signs EIP-3009 typed data on EVM, and a stablecoin
// price is the one a first-time buyer expects to see quoted.
export function pickAccept(accepts, net) {
	const onNet = accepts.filter((a) =>
		net === 'solana' ? isSolanaNet(a?.network) : isEvmNet(a?.network) && isEip3009(a),
	);
	if (!onNet.length) return null;
	const stable = onNet.find((a) => /usdc|usd coin/i.test(String(a?.extra?.name || '')));
	return stable || onNet[0];
}

function isSolanaNet(net) {
	return typeof net === 'string' && (net === 'solana' || net.startsWith('solana:'));
}

function isEvmNet(net) {
	return typeof net === 'string' && net.startsWith('eip155:');
}

function isEip3009(accept) {
	const method = accept?.extra?.assetTransferMethod;
	return !method || method === 'eip3009';
}

export function networkLabel(network) {
	const n = String(network || '');
	if (n.startsWith('eip155:8453')) return 'Base';
	if (n.startsWith('eip155:84532')) return 'Base Sepolia';
	if (n.startsWith('solana:') || n === 'solana') return 'Solana';
	return n || 'Unknown';
}

// Atomic amount to a human price. BigInt because token amounts can exceed
// Number's safe range.
export function formatAmount(atomic, decimals = 6) {
	let n;
	try {
		n = BigInt(String(atomic ?? '0'));
	} catch {
		return '0';
	}
	const base = 10n ** BigInt(decimals);
	const whole = n / base;
	const frac = (n % base).toString().padStart(decimals, '0').replace(/0+$/, '');
	return frac ? `${whole}.${frac}` : String(whole);
}

function showPaymentRequired(panel, { body, header, task, maxCostUsd }) {
	const accepts = readAccepts(body, header);
	const options = [
		{ net: 'base', accept: pickAccept(accepts, 'base') },
		{ net: 'solana', accept: pickAccept(accepts, 'solana') },
	].filter((o) => o.accept);

	if (!options.length) {
		showError(
			panel,
			'This run needs a USDC payment, but the endpoint did not return a payment option this browser can sign. Try again in a moment.',
		);
		return;
	}

	const quoted = options[0].accept;
	const price = formatAmount(quoted.amount, Number(quoted.extra?.decimals ?? 6));
	const asset = quoted.extra?.name || 'USDC';

	panel.innerHTML = `
		<div class="pay-card">
			<div class="pay-head">
				<div class="pay-eyebrow">Payment required</div>
				<div class="pay-price">${escHtml(price)} <span>${escHtml(asset)}</span></div>
				<p class="pay-desc">
					Base fee to start the agent. It then spends up to
					$${maxCostUsd.toFixed(2)} of your budget on the endpoints it calls, and
					reports every cent in the trace.
				</p>
			</div>
			<div class="pay-body">
				<div class="pay-net-label" id="pay-net-label">Pay with</div>
				<div class="pay-wallets" role="group" aria-labelledby="pay-net-label">
					${options.map(renderWalletGroup).join('')}
				</div>
				<p class="pay-status" id="pay-status" role="status" aria-live="polite"></p>
			</div>
			<div class="pay-foot">
				<button class="btn pay-cancel" type="button" id="pay-cancel">Edit the task instead</button>
			</div>
		</div>
	`;

	const statusEl = panel.querySelector('#pay-status');
	const cancel = panel.querySelector('#pay-cancel');
	if (cancel) {
		cancel.addEventListener('click', () => {
			renderEmptyState(panel);
			document.getElementById('task-input')?.focus();
		});
	}

	let inFlight = false;
	panel.querySelectorAll('.wallet-btn').forEach((btn) => {
		btn.addEventListener('click', async () => {
			if (inFlight) return;
			const option = options.find((o) => o.net === btn.dataset.net);
			if (!option) return;
			inFlight = true;
			setWalletsDisabled(panel, true);
			try {
				const outcome = await payAndRun({
					accept: option.accept,
					walletName: btn.dataset.wallet,
					task,
					maxCostUsd,
					statusEl,
				});
				renderPaidRun(panel, outcome, task);
			} catch (err) {
				// A mobile browser with no injected wallet navigates into the
				// wallet app; the page is unloading, so leave the status as-is.
				if (err?.code === 'mobile_redirect') return;
				inFlight = false;
				setWalletsDisabled(panel, false);
				setPayError(statusEl, err?.message || 'Payment failed. Please try again.');
			}
		});
	});
}

function renderWalletGroup({ net, accept }) {
	const wallets = WALLETS[net] || [];
	return `
		<div class="pay-net">
			<div class="pay-net-name">${escHtml(networkLabel(accept.network))}</div>
			${wallets
				.map(
					(w) => `<button class="btn wallet-btn" type="button" data-net="${escHtml(net)}" data-wallet="${escHtml(w.id)}">
						<span>${escHtml(w.label)}</span>
						<span class="wallet-arrow" aria-hidden="true">→</span>
					</button>`,
				)
				.join('')}
		</div>
	`;
}

function setWalletsDisabled(panel, disabled) {
	panel.querySelectorAll('.wallet-btn').forEach((b) => {
		b.disabled = disabled;
	});
}

function setPayStatus(statusEl, message) {
	if (!statusEl) return;
	statusEl.classList.remove('pay-status-error');
	statusEl.setAttribute('role', 'status');
	statusEl.textContent = message;
}

function setPayError(statusEl, message) {
	if (!statusEl) return;
	statusEl.classList.add('pay-status-error');
	statusEl.setAttribute('role', 'alert');
	statusEl.textContent = message;
}

const PHASE_TEXT = {
	connecting: 'Connecting wallet…',
	building: 'Building payment…',
	signing: 'Waiting for your signature…',
	confirming: 'Settling on-chain…',
};

// Sign the payment, then replay the ORIGINAL POST (task + budget) with the
// X-PAYMENT proof so the paid run returns the answer the buyer asked for.
async function payAndRun({ accept, walletName, task, maxCostUsd, statusEl }) {
	setPayStatus(statusEl, PHASE_TEXT.connecting);
	const core = await loadPayCore();
	const resourceUrl = core.resolveResourceUrl(accept, RUN_ROUTE);

	return core.pay({
		accept,
		resourceUrl,
		walletName,
		onStatus: (phase, text) => {
			if (phase === 'done') return;
			if (phase === 'error') setPayError(statusEl, text);
			else setPayStatus(statusEl, text || PHASE_TEXT[phase] || 'Working…');
		},
		request: {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ task, maxCostUsd }),
		},
	});
}

// Render the paid run: the settlement receipt above the normal execution
// trace, so the buyer can see both what they paid and what they got.
function renderPaidRun(panel, outcome, task) {
	const data = typeof outcome?.result === 'object' && outcome.result !== null ? outcome.result : {};
	renderResults(panel, data, task);

	const receipt = document.createElement('div');
	receipt.className = 'receipt-row';
	const explorer = outcome?.transaction
		? explorerLink(outcome.network || null, outcome.transaction)
		: null;
	receipt.innerHTML = `
		<span class="receipt-lbl">Paid on ${escHtml(networkLabel(outcome?.network))}</span>
		<span class="receipt-val">${
			explorer
				? `<a href="${escHtml(explorer)}" target="_blank" rel="noopener noreferrer">${escHtml(shortId(outcome.transaction))}</a>`
				: 'Settled'
		}</span>
	`;
	panel.insertBefore(receipt, panel.firstChild);
}

function explorerLink(network, tx) {
	if (!tx) return null;
	if (isSolanaNet(network)) return `https://solscan.io/tx/${tx}`;
	if (String(network || '').startsWith('eip155:84532')) return `https://sepolia.basescan.org/tx/${tx}`;
	if (isEvmNet(network)) return `https://basescan.org/tx/${tx}`;
	return null;
}

function shortId(value) {
	const v = String(value || '');
	return v.length > 20 ? `${v.slice(0, 10)}…${v.slice(-8)}` : v;
}

function renderResults(panel, data, task) {
	panel.innerHTML = '';

	const steps = Array.isArray(data.steps) ? data.steps : [];
	const answer = data.result?.answer || '';
	const totalCost = data.totalCostUsdc || '0.000000';

	// Render step cards with staggered animation delays
	const timeline = document.createElement('div');
	timeline.className = 'timeline';

	steps.forEach((step, i) => {
		const card = buildStepCard(step, i);
		timeline.appendChild(card);
	});

	panel.appendChild(timeline);

	// Total cost row
	if (steps.length > 0) {
		const totalRow = document.createElement('div');
		totalRow.className = 'total-row';
		const costFloat = parseFloat(totalCost);
		totalRow.innerHTML = `
			<span class="total-lbl">Total spent</span>
			<span class="total-val">${costFloat > 0 ? '$' + costFloat.toFixed(6) + ' USDC' : 'Free (no paid calls executed)'}</span>
		`;
		panel.appendChild(totalRow);
	}

	// Final answer card
	if (answer) {
		const answerCard = document.createElement('div');
		answerCard.className = 'answer-card';
		answerCard.style.animationDelay = `${steps.length * 120 + 80}ms`;
		answerCard.style.opacity = '0';
		answerCard.style.animation = `step-in 0.4s ease ${steps.length * 120 + 80}ms forwards`;
		answerCard.innerHTML = `
			<div class="answer-eyebrow">Final Answer</div>
			<div class="answer-text">${escHtml(answer)}</div>
		`;
		panel.appendChild(answerCard);
	}
}

function buildStepCard(step, index) {
	const card = document.createElement('div');
	card.className = 'step-card';
	card.style.animationDelay = `${index * 120}ms`;

	const action = step.action || 'call';
	const icon = STEP_ICONS[action] || '•';
	const actionLabel = ACTION_LABELS[action] || action;
	const costFloat = parseFloat(step.costUsdc || '0');
	const costNonzero = costFloat > 0;

	let outputHtml = '';
	if (step.output !== undefined && step.output !== null) {
		const outputStr = typeof step.output === 'string'
			? step.output
			: JSON.stringify(step.output, null, 2);

		// Check for payment_required flag
		const is402 = step.output?.payment_required === true;
		if (is402) {
			outputHtml = `<div class="step-output"><span class="badge-402">402 Payment Required</span> ${escHtml(JSON.stringify(step.output?.requirements || {}, null, 2)).slice(0, 300)}</div>`;
		} else if (outputStr && outputStr !== '{}' && outputStr !== '[]') {
			outputHtml = `<div class="step-output">${escHtml(outputStr.slice(0, 600))}${outputStr.length > 600 ? '\n…' : ''}</div>`;
		}
	}

	const endpointHtml = step.endpoint
		? `<div class="step-endpoint">${escHtml(step.endpoint)}</div>`
		: '';

	card.innerHTML = `
		<div class="step-icon">${icon}</div>
		<div class="step-body">
			<div class="step-meta">
				<span class="step-num">Step ${step.step}</span>
				<span class="step-action">${escHtml(actionLabel)}</span>
				<span class="step-cost${costNonzero ? ' nonzero' : ''}">${costNonzero ? '$' + costFloat.toFixed(6) : '0'}</span>
			</div>
			<div class="step-desc">${escHtml(step.description || '')}</div>
			${endpointHtml}
			${outputHtml}
		</div>
	`;

	return card;
}

function escHtml(str) {
	return String(str)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// Auto-init on DOMContentLoaded. Guarded on a DOM so the 402-parsing helpers
// above stay importable outside a browser (tests/shopper-402.test.js).
if (typeof document !== 'undefined') {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
}
