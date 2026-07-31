/**
 * Deposit sheet: scan-to-fund with live on-chain arrival detection.
 *
 * The hardest step in a custodial wallet is the first one. A page that prints a
 * base58 string and stops has handed the user a transcription job: switch to a
 * phone, retype 44 characters, send, then come back and refresh until something
 * changes. Every part of that is a place to lose someone, and mistyping the
 * address loses the funds outright.
 *
 * This replaces all of it with two real mechanisms:
 *
 *   1. A payment-request QR, not an address QR. The code encodes a Solana Pay
 *      URI (`solana:<addr>?amount=&spl-token=`) or, for Base, an EIP-681 token
 *      transfer. Scanning it opens Phantom or Solflare with the recipient, the
 *      token AND the amount already filled in, so the sender confirms rather
 *      than types. On a phone the same URI is a tappable deep link, so the
 *      handoff works without a second device.
 *
 *   2. A watcher that notices the money land. While the sheet is open it re-reads
 *      the wallet's real balances and compares them to the baseline captured at
 *      open. When a balance rises it reports the exact delta, from the chain, and
 *      the user never refreshes anything.
 *
 * The watcher is deliberately polite: it backs off as the wait gets longer, it
 * suspends entirely while the tab is hidden (a user who switched to their phone
 * is not watching this tab, and their rate-limit budget should not be spent on
 * an invisible page), and it gives up after WATCH_CEILING_MS rather than polling
 * a forgotten tab forever.
 *
 * `readBalances` is injected rather than imported so this module owns no
 * transport and can be exercised without a network.
 */

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_CHAIN_ID = 8453;

/**
 * Backoff schedule. Deposits usually confirm inside a few seconds on Solana, so
 * the early polls are tight; a wait that has already run minutes is unlikely to
 * resolve in the next four seconds, so the later ones relax. Cumulative cost
 * stays far under the 60/min the wallet read endpoint allows.
 */
const WATCH_STEPS = [
	{ until: 5, delay: 4000 },
	{ until: 15, delay: 8000 },
];
const WATCH_TAIL_DELAY = 15000;
const WATCH_CEILING_MS = 10 * 60 * 1000;

/** The three things a user can actually deposit, and how each is encoded. */
const ASSETS = {
	sol: {
		id: 'sol',
		label: 'SOL',
		network: 'Solana',
		balanceKey: 'sol',
		decimals: 6,
		hint: 'Native SOL. Also what pays network fees, so keep a little here.',
	},
	usdc: {
		id: 'usdc',
		label: 'USDC',
		network: 'Solana',
		balanceKey: 'sol_usdc',
		decimals: 2,
		hint: 'USDC on Solana. The token agents spend for x402 calls.',
	},
	base: {
		id: 'base',
		label: 'USDC',
		network: 'Base',
		balanceKey: 'evm_usdc',
		decimals: 2,
		hint: 'USDC on Base. Sent to your EVM address, not the Solana one.',
	},
};

function esc(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

function fmt(n, decimals = 6) {
	if (n == null || !Number.isFinite(n)) return null;
	if (n === 0) return '0';
	if (Math.abs(n) < 10 ** -decimals) return `<${10 ** -decimals}`;
	return n.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

/**
 * Build the wallet-openable request URI for one asset.
 *
 * Solana Pay for the Solana assets, EIP-681 for Base. Both are read by the
 * mainstream wallets, and both carry the amount, so the sender is confirming a
 * prepared request rather than composing one. An amount of zero or blank is
 * omitted, which yields a valid open-ended request the sender fills in.
 */
export function buildRequestUri({ asset, solanaAddress, evmAddress, amount }) {
	const n = Number(amount);
	const hasAmount = Number.isFinite(n) && n > 0;

	if (asset === 'base') {
		if (!evmAddress) return null;
		if (!hasAmount) return `ethereum:${evmAddress}@${BASE_CHAIN_ID}`;
		// EIP-681 ERC-20 transfer: the target is the token contract, and the
		// recipient rides in the `address` parameter. USDC has 6 decimals.
		const raw = BigInt(Math.round(n * 1e6)).toString();
		return `ethereum:${BASE_USDC}@${BASE_CHAIN_ID}/transfer?address=${evmAddress}&uint256=${raw}`;
	}

	if (!solanaAddress) return null;
	const params = new URLSearchParams();
	if (hasAmount) params.set('amount', String(n));
	if (asset === 'usdc') params.set('spl-token', USDC_MINT);
	params.set('label', 'three.ws');
	params.set('message', 'Fund your master wallet');
	return `solana:${solanaAddress}?${params.toString()}`;
}

/** Which address a given asset actually lands on. Getting this wrong loses funds. */
export function addressFor(asset, { solanaAddress, evmAddress }) {
	return asset === 'base' ? evmAddress : solanaAddress;
}

/**
 * Compare a fresh balance snapshot against the baseline and return the first
 * asset that grew, with its delta.
 *
 * A balance the API could not read comes back as null. Treating null as zero
 * would invent an arrival the moment an RPC hiccup resolved, so an unreadable
 * side of the comparison is skipped rather than guessed at. The epsilon keeps
 * float noise in a re-quoted balance from reading as a deposit.
 */
export function detectArrival(baseline, current) {
	for (const asset of Object.values(ASSETS)) {
		const before = baseline?.[asset.balanceKey];
		const after = current?.[asset.balanceKey];
		if (typeof before !== 'number' || typeof after !== 'number') continue;
		const delta = after - before;
		if (delta > 1e-9) {
			return { asset: asset.id, label: asset.label, network: asset.network, delta };
		}
	}
	return null;
}

/** The poll delay for the nth check, per the backoff schedule above. */
export function watchDelay(pollCount) {
	for (const step of WATCH_STEPS) {
		if (pollCount < step.until) return step.delay;
	}
	return WATCH_TAIL_DELAY;
}

/**
 * Watch for an inbound deposit.
 *
 * Returns a handle with `.stop()`. Never throws: a failed read is a skipped
 * poll, because a transient RPC error mid-wait is not something to show a user
 * who is busy sending money on their phone.
 */
export function watchForDeposit({ baseline, readBalances, onArrival, onTick }) {
	let stopped = false;
	let polls = 0;
	let timer = null;
	const startedAt = Date.now();

	function schedule() {
		if (stopped) return;
		if (Date.now() - startedAt > WATCH_CEILING_MS) {
			stopped = true;
			onTick?.({ state: 'timeout', polls });
			return;
		}
		timer = setTimeout(tick, watchDelay(polls));
	}

	async function tick() {
		if (stopped) return;
		// A hidden tab is not being watched. Re-check later instead of spending a
		// read; the timer keeps the loop alive without touching the network.
		if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
			timer = setTimeout(tick, watchDelay(polls));
			return;
		}
		polls += 1;
		let balances = null;
		try {
			balances = await readBalances();
		} catch {
			balances = null;
		}
		if (stopped) return;
		const arrival = balances ? detectArrival(baseline, balances) : null;
		if (arrival) {
			stopped = true;
			onArrival?.(arrival);
			return;
		}
		// Balances ride along so a caller can show a live figure without issuing
		// a second read of its own for the number it just fetched.
		onTick?.({ state: 'waiting', polls, balances });
		schedule();
	}

	schedule();
	return {
		stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
		},
		get stopped() {
			return stopped;
		},
	};
}

// ── The sheet ────────────────────────────────────────────────────────────────

/**
 * Open the deposit sheet. Resolves when it closes.
 *
 * Uses a native <dialog>, which brings the focus trap, the Esc handler, the
 * inert background and the top-layer stacking with it rather than
 * reimplementing four accessibility behaviours by hand.
 */
export function openDepositSheet({ solanaAddress, evmAddress, balances, readBalances, defaultAsset = 'sol' }) {
	const dlg = document.createElement('dialog');
	dlg.className = 'wlt-sheet';
	dlg.setAttribute('aria-labelledby', 'wlt-sheet-title');

	const view = {
		asset: ASSETS[defaultAsset] ? defaultAsset : 'sol',
		amount: '',
		phase: 'request', // request | arrived
		arrival: null,
		polls: 0,
		qrError: false,
	};
	// `baseline` is frozen at open and is what an arrival is measured against.
	// `live` tracks the most recent read, so the footer figure stays honest
	// during a long wait without a second request.
	const baseline = { ...(balances || {}) };
	const live = { ...(balances || {}) };
	let watcher = null;

	function currentUri() {
		return buildRequestUri({
			asset: view.asset,
			solanaAddress,
			evmAddress,
			amount: view.amount,
		});
	}

	function assetTabs() {
		return Object.values(ASSETS)
			.filter((a) => (a.id === 'base' ? Boolean(evmAddress) : Boolean(solanaAddress)))
			.map((a) => {
				const on = view.asset === a.id;
				return `<button class="wlt-chip${on ? ' is-active' : ''}" type="button" role="tab"
					aria-selected="${on}" data-dep="asset" data-asset="${a.id}">
					${esc(a.label)}<span class="wlt-chip-net">${esc(a.network)}</span>
				</button>`;
			})
			.join('');
	}

	function arrivedView() {
		const a = view.arrival;
		return `
			<div class="wlt-sheet-done" role="status">
				<div class="wlt-sheet-tick" aria-hidden="true">
					<svg viewBox="0 0 52 52" width="52" height="52"><circle cx="26" cy="26" r="24" fill="none" stroke="currentColor" stroke-width="2.5" opacity="0.35"/><path fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" d="M15 27l8 8 15-16"/></svg>
				</div>
				<h2 class="wlt-sheet-done-title" id="wlt-sheet-title">
					${esc(fmt(a.delta, a.asset === 'sol' ? 6 : 2))} ${esc(a.label)} arrived
				</h2>
				<p class="wlt-sheet-done-sub">Confirmed on ${esc(a.network)}. Your balance is already up to date.</p>
				<div class="wlt-sheet-done-actions">
					<button class="wlt-btn wlt-btn--primary" type="button" data-dep="close">Done</button>
					<button class="wlt-btn" type="button" data-dep="again">Deposit more</button>
				</div>
			</div>`;
	}

	function requestView() {
		const asset = ASSETS[view.asset];
		const addr = addressFor(view.asset, { solanaAddress, evmAddress });
		const uri = currentUri();
		const held = live[asset.balanceKey];
		return `
			<header class="wlt-sheet-head">
				<h2 class="wlt-sheet-title" id="wlt-sheet-title">Add funds</h2>
				<button class="wlt-icon-btn" type="button" data-dep="close" aria-label="Close">Close</button>
			</header>

			<div class="wlt-chips" role="tablist" aria-label="Which asset to deposit">${assetTabs()}</div>
			<p class="wlt-sheet-hint">${esc(asset.hint)}</p>

			<div class="wlt-sheet-body">
				<div class="wlt-qr-wrap">
					<div class="wlt-qr" id="wlt-qr" aria-hidden="true"></div>
					${
						view.qrError
							? `<p class="wlt-qr-fallback">The QR could not be drawn here. The address below is the same request, copy it instead.</p>`
							: `<p class="wlt-qr-cap">Scan with Phantom, Solflare or any wallet that reads ${esc(view.asset === 'base' ? 'EIP-681' : 'Solana Pay')}.</p>`
					}
				</div>

				<div class="wlt-sheet-fields">
					<div class="wlt-field">
						<label for="wlt-dep-amount">Amount <span class="wlt-optional">optional</span></label>
						<input class="wlt-input" id="wlt-dep-amount" type="text" inputmode="decimal"
							spellcheck="false" autocomplete="off" placeholder="0.0" value="${esc(view.amount)}"
							data-dep="amount" aria-describedby="wlt-dep-amount-help" />
						<p class="wlt-help" id="wlt-dep-amount-help">
							Fill this in and the sending wallet opens with the amount already set, so there is nothing to type on the other device.
						</p>
					</div>

					<div class="wlt-field">
						<span class="wlt-field-label">${esc(asset.network)} address</span>
						<code class="wlt-dep-addr">${esc(addr || '')}</code>
						<div class="wlt-sheet-actions">
							<button class="wlt-btn wlt-btn--sm" type="button" data-dep="copy-addr" data-copy="${esc(addr || '')}">Copy address</button>
							${uri ? `<button class="wlt-btn wlt-btn--sm" type="button" data-dep="copy-uri" data-copy="${esc(uri)}">Copy payment link</button>` : ''}
							${uri ? `<a class="wlt-btn wlt-btn--sm wlt-btn--primary" href="${esc(uri)}" data-dep="open">Open in wallet</a>` : ''}
						</div>
					</div>
				</div>
			</div>

			<footer class="wlt-sheet-foot">
				<span class="wlt-watch" aria-live="polite">
					<span class="wlt-watch-pulse" aria-hidden="true"></span>
					Watching ${esc(asset.network)} for your deposit. It appears here on its own.
				</span>
				<span class="wlt-watch-held" id="wlt-watch-held">${
					held == null ? '' : `Holding ${esc(fmt(held, asset.decimals))} ${esc(asset.label)} now`
				}</span>
			</footer>`;
	}

	function paint() {
		dlg.innerHTML = view.phase === 'arrived' ? arrivedView() : requestView();
		if (view.phase === 'request') drawQr();
	}

	/**
	 * Render the QR from the `qrcode` package, loaded on demand so the wallet
	 * page does not carry it for the majority of visits that never deposit.
	 * A failure downgrades to the copyable address rather than an empty box.
	 */
	async function drawQr() {
		const host = dlg.querySelector('#wlt-qr');
		const uri = currentUri();
		if (!host || !uri) return;
		try {
			const mod = await import('qrcode');
			const QRCode = mod.default ?? mod;
			const canvas = document.createElement('canvas');
			host.replaceChildren(canvas);
			await QRCode.toCanvas(canvas, uri, {
				width: 208,
				margin: 1,
				errorCorrectionLevel: 'M',
				color: { dark: '#0b0714', light: '#ffffff' },
			});
		} catch {
			if (!view.qrError) {
				view.qrError = true;
				paint();
			}
		}
	}

	function startWatching() {
		watcher?.stop();
		watcher = watchForDeposit({
			baseline,
			readBalances,
			onArrival(arrival) {
				view.phase = 'arrived';
				view.arrival = arrival;
				paint();
			},
			onTick(t) {
				view.polls = t.polls;
				if (!t.balances) return;
				Object.assign(live, t.balances);
				// Patch the one figure that changed rather than repainting: a
				// repaint here would drop the caret out of the amount field
				// mid-typing.
				const asset = ASSETS[view.asset];
				const held = live[asset.balanceKey];
				const node = dlg.querySelector('#wlt-watch-held');
				if (node) {
					node.textContent =
						held == null ? '' : `Holding ${fmt(held, asset.decimals)} ${asset.label} now`;
				}
			},
		});
	}

	async function copy(text, btn) {
		try {
			await navigator.clipboard.writeText(text);
			const prev = btn.textContent;
			btn.textContent = 'Copied';
			btn.classList.add('is-copied');
			setTimeout(() => {
				btn.textContent = prev;
				btn.classList.remove('is-copied');
			}, 1400);
		} catch {
			// Selecting the code element is the manual path, and it is right there.
			dlg.querySelector('.wlt-dep-addr')?.focus?.();
		}
	}

	dlg.addEventListener('click', (e) => {
		const el = e.target.closest('[data-dep]');
		if (!el) return;
		const act = el.dataset.dep;
		if (act === 'close') return dlg.close();
		if (act === 'asset') {
			view.asset = el.dataset.asset;
			paint();
			return;
		}
		if (act === 'copy-addr' || act === 'copy-uri') return void copy(el.dataset.copy, el);
		if (act === 'again') {
			// A second deposit needs a fresh baseline, or the first one's delta
			// would be re-detected the instant the watcher restarts.
			view.phase = 'request';
			view.arrival = null;
			paint();
			rebaselineThenWatch();
		}
	});

	// Re-encode the QR as the amount is typed, but only once typing settles:
	// redrawing on every keystroke burns work nobody sees.
	let amountTimer = null;
	dlg.addEventListener('input', (e) => {
		if (e.target?.dataset?.dep !== 'amount') return;
		view.amount = e.target.value.trim();
		clearTimeout(amountTimer);
		amountTimer = setTimeout(drawQr, 280);
	});

	async function rebaselineThenWatch() {
		try {
			const fresh = await readBalances();
			if (fresh) {
				Object.assign(baseline, fresh);
				Object.assign(live, fresh);
			}
		} catch {
			/* keep the previous baseline; a stale one only delays detection */
		}
		startWatching();
	}

	document.body.appendChild(dlg);
	paint();
	dlg.showModal();
	startWatching();

	return new Promise((resolve) => {
		dlg.addEventListener('close', () => {
			watcher?.stop();
			clearTimeout(amountTimer);
			dlg.remove();
			resolve(view.arrival);
		});
	});
}
