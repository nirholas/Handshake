/**
 * add-funds.js: in-product "Add funds" overlay.
 *
 * Opens a Coinbase Onramp popup (or shows a wallet-address fallback) so a
 * zero-balance wallet can be funded without leaving the app.  Polls the wallet
 * balance every 5 s and resolves when the balance increases.
 *
 * Funds USDC by default.  Pass `asset: 'SOL'` for a wallet that spends native
 * lamports (the agent-economy demo wallet, for one): the copy, the onramp
 * asset, and the balance being watched all switch together, so a caller can
 * never send a wallet an asset it cannot spend.
 *
 * Usage:
 *   const newBalance = await showAddFunds({ walletAddress, requiredUsdc });
 *   // newBalance: { usdc: 1.23 } or null if dismissed
 *   const solBalance = await showAddFunds({ walletAddress, asset: 'SOL' });
 *   // solBalance: { sol: 0.05 } or null if dismissed
 */

import { ensureRiskAck } from './risk-ack.js';

const USDC_MINT_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Per-asset copy, precision, and balance reader. Everything that differs
// between a USDC top-up and a SOL top-up lives here, so the overlay itself
// stays asset-agnostic.
const ASSETS = {
	USDC: {
		label: 'USDC',
		desc: 'Buy USDC to use skills and pay for services. Funds are deposited directly to your connected wallet.',
		altLabel: 'Or send USDC directly to your wallet:',
		note: 'Solana network · USDC only',
		decimals: 2,
		resultKey: 'usdc',
		readBalance: fetchUsdcBalance,
	},
	SOL: {
		label: 'SOL',
		desc: 'Buy SOL to cover this wallet\'s on-chain transactions. Funds are deposited directly to the wallet address below.',
		altLabel: 'Or send SOL directly to this wallet:',
		note: 'Solana network · native SOL only',
		decimals: 5,
		resultKey: 'sol',
		readBalance: fetchSolBalance,
	},
};
const DEFAULT_ASSET = 'USDC';
const POLL_INTERVAL_MS = 5000;
// Stop actively polling after this long with no deposit, then surface a manual
// "Check again" affordance instead of spinning forever. Card buys land in
// seconds; bank-funded onramps can take a few minutes, so give it a wide window.
const POLL_MAX_MS = 12 * 60 * 1000;

function esc(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

const overlayHtml = (asset) => `
<div class="af-overlay" id="af-overlay" role="dialog" aria-modal="true" aria-labelledby="af-title">
	<div class="af-box">
		<div class="af-head">
			<span class="af-title" id="af-title">Add funds</span>
			<button class="af-close" id="af-close" aria-label="Close">×</button>
		</div>
		<div class="af-body">
			<p class="af-desc">${esc(asset.desc)}</p>
			<div class="af-amounts" id="af-amounts">
				<button class="af-amt" data-amount="10">$10</button>
				<button class="af-amt" data-amount="25">$25</button>
				<button class="af-amt" data-amount="50">$50</button>
			</div>
			<button class="af-cta" id="af-cta">Buy ${esc(asset.label)}</button>
			<div class="af-alt" id="af-alt">
				<div class="af-alt-label">${esc(asset.altLabel)}</div>
				<div class="af-addr-row">
					<code class="af-addr" id="af-addr"></code>
					<button class="af-copy" id="af-copy" title="Copy address">Copy</button>
				</div>
				<div class="af-alt-note">${esc(asset.note)}</div>
			</div>
			<div class="af-status" id="af-status" role="status" aria-live="polite"></div>
			<div class="af-poll" id="af-poll" hidden>
				<div class="af-poll-live" id="af-poll-live">
					<div class="af-poll-indicator"></div>
					<span>Watching for deposit…</span>
				</div>
				<button class="af-recheck" id="af-recheck" hidden>Check again</button>
			</div>
		</div>
	</div>
</div>
`;

const OVERLAY_STYLE = `
.af-overlay {
	position: fixed; inset: 0; z-index: 10000;
	background: rgba(0,0,0,0.72);
	display: flex; align-items: center; justify-content: center;
	font-family: system-ui, -apple-system, sans-serif;
	animation: af-fade-in 0.15s ease;
}
.af-overlay[hidden] { display: none; }
@keyframes af-fade-in { from { opacity: 0; } to { opacity: 1; } }

.af-box {
	background: #111827; border: 1px solid rgba(255,255,255,0.1);
	border-radius: 16px; padding: 28px 24px; width: 92%; max-width: 400px;
	color: #f0f0f0; box-shadow: 0 24px 64px rgba(0,0,0,0.7);
	animation: af-slide-up 0.2s cubic-bezier(.22,1,.36,1);
}
@keyframes af-slide-up { from { transform: translateY(16px); opacity: 0; } to { transform: none; opacity: 1; } }

.af-head {
	display: flex; align-items: center; justify-content: space-between;
	margin-bottom: 18px;
}
.af-title { font-size: 18px; font-weight: 700; letter-spacing: .01em; }
.af-close {
	background: none; border: none; color: rgba(255,255,255,0.45);
	font-size: 24px; cursor: pointer; line-height: 1; padding: 0;
	transition: color 0.15s;
}
.af-close:hover { color: #fff; }
.af-close:focus-visible { outline: 2px solid rgba(255,255,255,0.4); border-radius: 4px; }

.af-desc {
	font-size: 13px; color: rgba(255,255,255,0.55);
	margin: 0 0 18px; line-height: 1.5;
}

.af-amounts {
	display: flex; gap: 8px; margin-bottom: 14px;
}
.af-amt {
	flex: 1; padding: 9px 0; border-radius: 8px;
	border: 1px solid rgba(255,255,255,0.15);
	background: rgba(255,255,255,0.06); color: #fff;
	font-size: 15px; font-weight: 600; cursor: pointer;
	transition: background 0.12s, border-color 0.12s;
}
.af-amt:hover { background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.3); }
.af-amt.selected { background: rgba(255,255,255,0.10); border-color: rgba(255,255,255,0.30); color: #ffffff; }
.af-amt:focus-visible { outline: 2px solid #6366f1; outline-offset: 2px; }

.af-cta {
	display: block; width: 100%; padding: 13px;
	border-radius: 10px; border: none;
	background: rgba(255,255,255,0.12); color: #fff; border: 1px solid rgba(255,255,255,0.18);
	font-size: 15px; font-weight: 700; cursor: pointer;
	transition: opacity 0.15s; letter-spacing: .02em;
	margin-bottom: 16px;
}
.af-cta:hover:not(:disabled) { opacity: 0.88; }
.af-cta:disabled { opacity: 0.4; cursor: default; }
.af-cta:focus-visible { outline: 2px solid rgba(255,255,255,0.4); outline-offset: 2px; }

.af-alt { padding-top: 14px; border-top: 1px solid rgba(255,255,255,0.07); }
.af-alt-label { font-size: 12px; color: rgba(255,255,255,0.4); margin-bottom: 8px; }
.af-addr-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.af-addr {
	flex: 1; font-family: ui-monospace, monospace; font-size: 12px;
	color: rgba(255,255,255,0.7); overflow: hidden; text-overflow: ellipsis;
	white-space: nowrap; background: rgba(255,255,255,0.05);
	border-radius: 6px; padding: 5px 8px;
}
.af-copy {
	flex-shrink: 0; font-size: 12px; padding: 5px 10px;
	border-radius: 6px; border: 1px solid rgba(255,255,255,0.2);
	background: transparent; color: rgba(255,255,255,0.5); cursor: pointer;
	transition: background 0.12s, color 0.12s;
}
.af-copy:hover { background: rgba(255,255,255,0.1); color: #fff; }
.af-copy.copied { color: #34d399; border-color: #34d399; }
.af-alt-note { font-size: 11px; color: rgba(255,255,255,0.3); }

.af-status {
	margin-top: 12px; font-size: 13px; min-height: 18px;
	text-align: center; color: rgba(255,255,255,0.55);
}
.af-status.err { color: #f87171; }
.af-status.ok  { color: #34d399; font-weight: 600; }

.af-poll {
	display: flex; align-items: center; gap: 8px;
	justify-content: center; margin-top: 12px;
	font-size: 12px; color: rgba(255,255,255,0.35);
}
.af-poll[hidden] { display: none; }
.af-poll-indicator {
	width: 6px; height: 6px; border-radius: 50%;
	background: #4f46e5;
	animation: af-pulse 1.4s ease-in-out infinite;
}
@keyframes af-pulse {
	0%, 100% { opacity: 1; transform: scale(1); }
	50% { opacity: 0.4; transform: scale(0.7); }
}
.af-poll-live { display: flex; align-items: center; gap: 8px; }
.af-poll-live[hidden] { display: none; }
.af-recheck {
	font-size: 12px; padding: 6px 14px; border-radius: 8px;
	border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.06);
	color: #fff; cursor: pointer; transition: background 0.12s, border-color 0.12s;
}
.af-recheck:hover:not(:disabled) { background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.32); }
.af-recheck:disabled { opacity: 0.5; cursor: default; }
.af-recheck:focus-visible { outline: 2px solid rgba(255,255,255,0.4); outline-offset: 2px; }
.af-recheck[hidden] { display: none; }
`;

/**
 * Fetch USDC balance for a Solana address via our existing wallet/balances endpoint.
 * Returns the decimal USDC amount (e.g. 1.5 for 1.5 USDC) or null on failure.
 * @param {string} address
 * @returns {Promise<number|null>}
 */
async function fetchUsdcBalance(address) {
	try {
		const r = await fetch('/api/wallet/balances', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({ chain: 'solana', address }),
		});
		if (!r.ok) return null;
		const data = await r.json();
		const usdcToken = (data.tokens || []).find(
			(t) => t.mint === USDC_MINT_SOLANA || t.symbol === 'USDC',
		);
		return usdcToken ? Number(usdcToken.amount) || 0 : 0;
	} catch {
		return null;
	}
}

/**
 * Fetch the native SOL balance for a Solana address via the same wallet
 * endpoint, which reports native holdings separately from SPL tokens.
 * Returns the decimal SOL amount (e.g. 0.05) or null on failure.
 * @param {string} address
 * @returns {Promise<number|null>}
 */
async function fetchSolBalance(address) {
	try {
		const r = await fetch('/api/wallet/balances', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({ chain: 'solana', address }),
		});
		if (!r.ok) return null;
		const data = await r.json();
		return Number(data.native?.amount) || 0;
	} catch {
		return null;
	}
}

/**
 * Fetch an onramp URL from our server endpoint.
 * Returns { url, mode, asset } or null on failure.
 * @param {string} address  Solana wallet address
 * @param {number} [amount] suggested USD amount
 * @param {string} [asset]  asset to buy (USDC or SOL)
 */
async function fetchOnrampLink(address, amount = 25, asset = DEFAULT_ASSET) {
	try {
		const params = new URLSearchParams({ address, amount: String(amount), asset });
		const r = await fetch(`/api/onramp/link?${params}`, { credentials: 'include' });
		if (!r.ok) return null;
		return await r.json();
	} catch {
		return null;
	}
}

/**
 * Show the "Add funds" overlay.
 *
 * @param {object} opts
 * @param {string}  opts.walletAddress    the Phantom/Solana wallet to fund
 * @param {number}  [opts.requiredUsdc]   minimum amount needed (shows as suggestion)
 * @param {string}  [opts.asset]          'USDC' (default) or 'SOL'
 * @param {Element} [opts.container]      defaults to document.body
 * @returns {Promise<{usdc: number}|{sol: number}|null>}  new balance, or null if dismissed
 */
export async function showAddFunds({ walletAddress, requiredUsdc, asset: assetName, container } = {}) {
	const assetKey = Object.hasOwn(ASSETS, String(assetName || '').toUpperCase())
		? String(assetName).toUpperCase()
		: DEFAULT_ASSET;
	const asset = ASSETS[assetKey];
	// Buying crypto is a real-money commitment, so require the risk acknowledgment.
	if (!(await ensureRiskAck({ context: 'onramp' }))) return null;
	return new Promise((resolve) => {
		const root = container || document.body;

		// Inject styles once
		if (!document.getElementById('af-styles')) {
			const style = document.createElement('style');
			style.id = 'af-styles';
			style.textContent = OVERLAY_STYLE;
			document.head.appendChild(style);
		}

		const wrapper = document.createElement('div');
		wrapper.innerHTML = overlayHtml(asset);
		root.appendChild(wrapper);

		const overlay = wrapper.querySelector('#af-overlay');
		const addrEl  = wrapper.querySelector('#af-addr');
		const copyBtn = wrapper.querySelector('#af-copy');
		const ctaBtn  = wrapper.querySelector('#af-cta');
		const closeBtn = wrapper.querySelector('#af-close');
		const statusEl = wrapper.querySelector('#af-status');
		const pollEl  = wrapper.querySelector('#af-poll');
		const pollLive = wrapper.querySelector('#af-poll-live');
		const recheckBtn = wrapper.querySelector('#af-recheck');
		const amtBtns = wrapper.querySelectorAll('.af-amt');

		let selectedAmount = 25;
		let pollTimer = null;
		let pollStart = 0;
		let baselineBalance = null;
		let popupWindow = null;
		let destroyed = false;

		// Mark first preset selected by default
		amtBtns.forEach((btn) => {
			if (Number(btn.dataset.amount) === selectedAmount) btn.classList.add('selected');
			btn.addEventListener('click', () => {
				amtBtns.forEach((b) => b.classList.remove('selected'));
				btn.classList.add('selected');
				selectedAmount = Number(btn.dataset.amount);
			});
		});

		// Show wallet address
		if (walletAddress) {
			addrEl.textContent = `${walletAddress.slice(0, 12)}…${walletAddress.slice(-8)}`;
			addrEl.title = walletAddress;
		}

		// Copy address button
		copyBtn.addEventListener('click', async () => {
			if (!walletAddress) return;
			try {
				await navigator.clipboard.writeText(walletAddress);
				copyBtn.textContent = 'Copied!';
				copyBtn.classList.add('copied');
				setTimeout(() => {
					copyBtn.textContent = 'Copy';
					copyBtn.classList.remove('copied');
				}, 1800);
			} catch {
				copyBtn.textContent = 'Copy';
			}
		});

		function setStatus(msg, kind = '') {
			statusEl.textContent = msg;
			statusEl.className = 'af-status' + (kind ? ` ${kind}` : '');
		}

		function dismiss(result = null) {
			if (destroyed) return;
			destroyed = true;
			clearInterval(pollTimer);
			if (popupWindow && !popupWindow.closed) popupWindow.close();
			overlay.style.animation = 'af-fade-in 0.12s ease reverse forwards';
			setTimeout(() => wrapper.remove(), 130);
			resolve(result);
		}

		// Snapshot the current balance so we can detect an increase
		async function snapshotBalance() {
			if (!walletAddress) return;
			baselineBalance = await asset.readBalance(walletAddress);
		}

		// Detect the deposit landing and resolve the overlay.
		function showSuccess(current) {
			clearInterval(pollTimer);
			pollEl.setAttribute('hidden', '');
			setStatus(`✓ Deposit confirmed: ${current.toFixed(asset.decimals)} ${asset.label} added`, 'ok');
			setTimeout(() => dismiss({ [asset.resultKey]: current }), 1800);
		}

		// Resolves true (and shows success) once the asset lands above the baseline.
		async function checkForDeposit() {
			const current = await asset.readBalance(walletAddress);
			if (current === null) return false;
			if (baselineBalance !== null && current > baselineBalance) {
				showSuccess(current);
				return true;
			}
			return false;
		}

		// Watch the balance for up to POLL_MAX_MS, then hand off to a manual re-check
		// instead of polling forever.
		function beginPollWindow() {
			if (!walletAddress || destroyed) return;
			pollStart = Date.now();
			pollEl.removeAttribute('hidden');
			pollLive.removeAttribute('hidden');
			recheckBtn.setAttribute('hidden', '');
			setStatus('Waiting for your deposit to confirm…');
			clearInterval(pollTimer);
			pollTimer = setInterval(async () => {
				if (destroyed) { clearInterval(pollTimer); return; }
				if (await checkForDeposit()) return;
				if (Date.now() - pollStart >= POLL_MAX_MS) pausePolling();
			}, POLL_INTERVAL_MS);
		}

		// Stop the active loop and surface a manual "Check again" affordance.
		function pausePolling() {
			clearInterval(pollTimer);
			pollLive.setAttribute('hidden', '');
			recheckBtn.removeAttribute('hidden');
			setStatus("Haven't seen your deposit yet. Card buys are usually instant; bank transfers can take a few minutes.", '');
		}

		recheckBtn.addEventListener('click', async () => {
			recheckBtn.disabled = true;
			setStatus('Checking for your deposit…');
			const landed = await checkForDeposit();
			recheckBtn.disabled = false;
			if (!landed) beginPollWindow();
		});

		// Main CTA: open onramp popup + start polling
		ctaBtn.addEventListener('click', async () => {
			ctaBtn.disabled = true;
			setStatus('Opening Coinbase checkout…');

			await snapshotBalance();

			const onramp = await fetchOnrampLink(walletAddress, selectedAmount, assetKey);

			if (onramp?.url) {
				popupWindow = window.open(
					onramp.url,
					'af_coinbase_pay',
					'width=480,height=720,menubar=no,toolbar=no,location=no,status=no',
				);
			}

			if (!popupWindow || popupWindow.closed) {
				// Popup blocked or no URL — fall back to same-tab link
				if (onramp?.url) {
					setStatus('Popup blocked. Opening in new tab…');
					window.open(onramp.url, '_blank', 'noopener');
				} else {
					setStatus(`Copy the address below and send ${asset.label} from any exchange.`, '');
				}
			} else {
				setStatus('');
			}

			ctaBtn.disabled = false;
			beginPollWindow();
		});

		// Close handlers
		closeBtn.addEventListener('click', () => dismiss(null));
		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) dismiss(null);
		});

		// Keyboard dismiss
		const keyHandler = (e) => {
			if (e.key === 'Escape') { document.removeEventListener('keydown', keyHandler); dismiss(null); }
		};
		document.addEventListener('keydown', keyHandler);

		// Focus the CTA on open
		requestAnimationFrame(() => ctaBtn.focus());
	});
}
