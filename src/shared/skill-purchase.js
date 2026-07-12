/**
 * Shared skill / asset purchase engine (Solana Pay).
 *
 * Extracted so any agent surface — the marketplace SPA and the standalone
 * /agents/:id detail page — drives the exact same on-chain purchase flow
 * instead of forking a second, divergent payment path.
 *
 * One-shot Solana Pay purchase: the server mints a unique reference Pubkey, the
 * buyer's connected wallet (Phantom / Solflare / Backpack) sends USDC + the
 * reference in a single tx, the server verifies on-chain via
 * findReference / validateTransfer, and the (user, agent, skill) tuple lands in
 * skill_purchases as 'confirmed'. A mobile QR path (Solana Pay URL) is offered
 * when no browser wallet is present.
 *
 * Usage:
 *   import { configureSkillPurchase, openPurchaseFlow } from './shared/skill-purchase.js';
 *   configureSkillPurchase({ getAgent: () => currentAgent, onPurchased: (id) => reload(id) });
 *   openPurchaseFlow(agentId, skillName);
 *
 * The payment modal DOM is injected lazily into <body> on first use, so host
 * pages do not need to ship the markup. If a page already contains an element
 * with id="payment-modal-overlay" (e.g. the marketplace), that one is reused.
 */

import { log } from './log.js';
import { showToast } from '../ui-helpers.js';

export const USDC_MAINNET_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
	);
}

// ── Host configuration ──────────────────────────────────────────────────────

let cfg = {
	getAgent: () => null,
	// Called with the agentId after a successful skill purchase / trial so the
	// host can refresh the user's owned-skills state and re-render badges.
	onPurchased: async () => {},
};

export function configureSkillPurchase(next = {}) {
	cfg = { ...cfg, ...next };
	ensureModal();
}

// ── Modal injection ─────────────────────────────────────────────────────────

const MODAL_HTML = `
<div class="market-modal-overlay" id="payment-modal-overlay" hidden aria-modal="true" role="dialog" aria-labelledby="payment-modal-title">
	<div class="market-modal">
		<div class="market-modal-head">
			<h2 id="payment-modal-title">Unlock skill</h2>
			<button class="market-modal-close" id="payment-modal-close" aria-label="Close">×</button>
		</div>
		<div class="payment-modal-body" id="payment-modal-body">
			<div class="payment-modal-badge" id="payment-modal-badge" hidden></div>
			<p id="payment-modal-lede">You are purchasing access to the following skill:</p>
			<div class="payment-item">
				<strong id="payment-skill-name"></strong>
				<span id="payment-item-from">from agent</span>
				<em id="payment-agent-name"></em>
			</div>
			<div class="payment-price">
				<span>Total</span>
				<strong id="payment-price-display"></strong>
			</div>
			<div class="payment-pwyw" id="payment-pwyw-area" hidden>
				<label class="payment-pwyw-label" for="payment-pwyw-input">Name your price</label>
				<div class="payment-pwyw-row">
					<input type="number" id="payment-pwyw-input" class="payment-pwyw-input"
						inputmode="decimal" min="0" step="0.01"
						autocomplete="off" aria-describedby="payment-pwyw-hint" />
					<span class="payment-pwyw-unit" id="payment-pwyw-unit">USDC</span>
				</div>
				<div class="payment-pwyw-hint" id="payment-pwyw-hint" role="status" aria-live="polite"></div>
			</div>
			<div class="payment-gift" id="payment-gift-area" hidden>
				<label class="payment-gift-toggle">
					<input type="checkbox" id="payment-gift-toggle-input" />
					<span class="payment-gift-toggle-text"><span aria-hidden="true">🎁</span> Gift this skill to someone</span>
				</label>
				<div class="payment-gift-recipient" id="payment-gift-recipient" hidden>
					<input type="text" id="payment-gift-input" class="payment-gift-input"
						placeholder="Recipient username or wallet address"
						autocomplete="off" autocapitalize="off" spellcheck="false"
						aria-label="Recipient username or wallet address" />
					<div class="payment-gift-status" id="payment-gift-status" role="status" aria-live="polite"></div>
				</div>
			</div>
			<div class="payment-wallet-area" id="payment-wallet-area"></div>
			<button class="btn-primary payment-confirm-btn" id="payment-confirm-btn" disabled>Confirm purchase</button>
			<div class="payment-qr" id="payment-qr" aria-live="polite"></div>
			<div class="payment-status" id="payment-status" role="status" aria-live="polite"></div>
		</div>
		<div class="payment-modal-success" id="payment-modal-success" hidden role="status" aria-live="polite"></div>
	</div>
</div>`;

let modalReady = false;

function ensureModal() {
	if (modalReady) return;
	if (!$('payment-modal-overlay')) {
		const wrap = document.createElement('div');
		wrap.innerHTML = MODAL_HTML.trim();
		document.body.appendChild(wrap.firstChild);
	}
	$('payment-modal-close')?.addEventListener('click', closePaymentModal);
	$('payment-confirm-btn')?.addEventListener('click', handlePurchase);
	$('payment-pwyw-input')?.addEventListener('input', onPwywInput);
	$('payment-gift-toggle-input')?.addEventListener('change', onGiftToggle);
	$('payment-gift-input')?.addEventListener('input', onGiftInput);
	$('payment-modal-overlay')?.addEventListener('click', (e) => {
		if (e.target.id === 'payment-modal-overlay') closePaymentModal();
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && !$('payment-modal-overlay')?.hidden) closePaymentModal();
	});
	modalReady = true;
}

// ── Price formatting ────────────────────────────────────────────────────────

export function formatAssetPrice(price) {
	if (!price || price.amount == null) return null;
	const decimals = Number(price.mint_decimals ?? 6);
	const amount = Number(price.amount);
	if (!Number.isFinite(amount) || amount <= 0) return null;
	const value = amount / Math.pow(10, decimals);
	const symbol =
		price.currency_mint === USDC_MAINNET_MINT ? 'USDC' : (price.currency_mint || '').slice(0, 4) + '…';
	const formatted = value >= 100 ? value.toFixed(0) : value >= 1 ? value.toFixed(2) : value.toFixed(3);
	return `${formatted.replace(/\.?0+$/, '')} ${symbol}`;
}

export function shortMintLabel(mint) {
	if (mint === USDC_MAINNET_MINT) return 'USDC';
	return (mint || '').slice(0, 4) + '…';
}

// ── Modal chrome helpers ────────────────────────────────────────────────────

function setStatus(text, kind) {
	const el = $('payment-status');
	if (!el) return;
	el.textContent = text;
	el.className = 'payment-status' + (kind ? ' ' + kind : '');
}
function setPaymentTitle(text) { const el = $('payment-modal-title'); if (el) el.textContent = text; }
function setPaymentLede(text) { const el = $('payment-modal-lede'); if (el) el.textContent = text; }
function setPaymentFromLabel(text) { const el = $('payment-item-from'); if (el) el.textContent = text; }
function setPaymentBadge(html, kind) {
	const el = $('payment-modal-badge');
	if (!el) return;
	if (!html) { el.hidden = true; el.innerHTML = ''; el.className = 'payment-modal-badge'; return; }
	el.hidden = false;
	el.className = 'payment-modal-badge' + (kind ? ' ' + kind : '');
	el.innerHTML = html;
}

function renderPaymentSuccess({ title, message, primaryHref, primaryLabel, secondaryLabel = 'Done' }) {
	const body = $('payment-modal-body');
	const success = $('payment-modal-success');
	if (!body || !success) return;
	body.hidden = true;
	const primary = primaryHref
		? `<a class="btn-primary" href="${escapeHtml(primaryHref)}" data-success-primary>${escapeHtml(primaryLabel || 'View')}</a>`
		: '';
	success.innerHTML = `
		<div class="ps-check" aria-hidden="true">✓</div>
		<h3 class="ps-title">${escapeHtml(title)}</h3>
		${message ? `<p class="ps-sub">${escapeHtml(message)}</p>` : ''}
		<div class="ps-actions">
			${primary}
			<button type="button" class="btn-secondary" data-success-close>${escapeHtml(secondaryLabel)}</button>
		</div>`;
	success.hidden = false;
	success.querySelector('[data-success-close]')?.addEventListener('click', closePaymentModal);
}

function renderPaymentVerifyAgain({ txid, message, retryFn }) {
	const status = $('payment-status');
	const confirmBtn = $('payment-confirm-btn');
	if (confirmBtn) confirmBtn.hidden = true;
	if (!status) return;
	const explorer = txid ? `https://solscan.io/tx/${encodeURIComponent(txid)}` : '';
	status.className = 'payment-status';
	status.innerHTML = `
		<div class="payment-modal-retry">
			<p>${escapeHtml(message || "We couldn't confirm with the server in time. Your payment is safe — re-verify below.")}</p>
			${explorer ? `<div class="retry-tx">Tx: <a href="${escapeHtml(explorer)}" target="_blank" rel="noopener">${escapeHtml(txid.slice(0, 12))}…</a></div>` : ''}
			<div class="retry-actions">
				<button type="button" class="retry-primary" data-retry-verify>Verify again</button>
				<button type="button" class="retry-secondary" data-retry-close>Close</button>
			</div>
		</div>`;
	const retryBtn = status.querySelector('[data-retry-verify]');
	retryBtn?.addEventListener('click', async () => {
		retryBtn.disabled = true;
		retryBtn.textContent = 'Verifying…';
		try {
			await retryFn();
		} catch (err) {
			retryBtn.disabled = false;
			retryBtn.textContent = 'Verify again';
			setStatus(err.message || 'Verification failed', 'err');
		}
	});
	status.querySelector('[data-retry-close]')?.addEventListener('click', closePaymentModal);
}

// ── Gift recipient ──────────────────────────────────────────────────────────
//
// Skill purchases can be bought for another user. When the gift toggle is on we
// resolve the typed username / wallet to a real account via /api/users/lookup
// (debounced), gate the confirm button on a valid recipient, and send the
// resolved user id to the server, which re-resolves and records it as the
// purchase's recipient.

// ── Pay-what-you-want ─────────────────────────────────────────────────────────
//
// When a skill is priced PWYW the modal shows an amount input instead of a fixed
// total. The buyer types a human amount; we enforce the creator's minimum
// client-side (the server re-validates), gate the confirm button on a valid
// figure, and pass the chosen atomic amount to the purchase create call.

let pwywState = { active: false, decimals: 6, minAtomics: 0n, symbol: 'USDC' };

function setupPwywUI({ active, price }) {
	const area = $('payment-pwyw-area');
	const input = $('payment-pwyw-input');
	const unit = $('payment-pwyw-unit');
	if (!active) {
		pwywState = { active: false, decimals: 6, minAtomics: 0n, symbol: 'USDC' };
		if (area) area.hidden = true;
		setPwywHint('');
		return;
	}
	const decimals = Number(price.mint_decimals ?? 6);
	const minAtomics = price.minimum_amount != null ? BigInt(price.minimum_amount) : 0n;
	const symbol = shortMintLabel(price.currency_mint);
	pwywState = { active: true, decimals, minAtomics, symbol };
	const suggested = Number(price.amount) / Math.pow(10, decimals);
	if (input) input.value = suggested > 0 ? suggested.toFixed(decimals === 6 ? 2 : 4).replace(/\.?0+$/, '') : '';
	if (unit) unit.textContent = symbol;
	if (area) area.hidden = false;
	updatePwywHint();
}

function pwywMinHuman() {
	return Number(pwywState.minAtomics) / Math.pow(10, pwywState.decimals);
}

// Parse the input into atomic units; null when blank or non-numeric.
function pwywChosenAtomics() {
	const raw = ($('payment-pwyw-input')?.value || '').trim();
	if (!raw) return null;
	const human = Number(raw);
	if (!Number.isFinite(human) || human < 0) return null;
	return BigInt(Math.round(human * Math.pow(10, pwywState.decimals)));
}

function setPwywHint(text, kind) {
	const el = $('payment-pwyw-hint');
	if (!el) return;
	el.textContent = text || '';
	el.className = 'payment-pwyw-hint' + (kind ? ' ' + kind : '');
}

function updatePwywHint() {
	if (!pwywState.active) return;
	const chosen = pwywChosenAtomics();
	if (chosen == null) {
		setPwywHint(
			pwywState.minAtomics > 0n
				? `Minimum ${pwywMinHuman()} ${pwywState.symbol}.`
				: `Enter how much you'd like to pay.`,
		);
		return;
	}
	if (chosen <= 0n) {
		setPwywHint('Enter an amount greater than zero.', 'err');
		return;
	}
	if (chosen < pwywState.minAtomics) {
		setPwywHint(`That's below the ${pwywMinHuman()} ${pwywState.symbol} minimum.`, 'err');
		return;
	}
	setPwywHint(`You'll pay ${(Number(chosen) / Math.pow(10, pwywState.decimals))} ${pwywState.symbol}.`, 'ok');
}

function onPwywInput() {
	updatePwywHint();
	refreshConfirmEnabled();
}

// Is the current PWYW amount valid? Trivially true when not in PWYW mode.
function pwywAmountValid() {
	if (!pwywState.active) return true;
	const chosen = pwywChosenAtomics();
	return chosen != null && chosen > 0n && chosen >= pwywState.minAtomics;
}

let giftState = { enabled: false, active: false, recipient: null, resolving: false, seq: 0 };
let giftLookupTimer = null;

function setGiftStatus(text, kind) {
	const el = $('payment-gift-status');
	if (!el) return;
	el.textContent = text || '';
	el.className = 'payment-gift-status' + (kind ? ' ' + kind : '');
}

function giftLabel(recipient) {
	if (!recipient) return 'They';
	if (recipient.username) return '@' + recipient.username;
	return recipient.display_name || 'They';
}

// The active gift recipient at confirm time, or null for a self-purchase.
function activeGiftRecipient() {
	return giftState.active && giftState.recipient ? giftState.recipient : null;
}

// Single source of truth for whether the confirm button is clickable. All modes
// require a connected wallet; skill gifting additionally requires a resolved,
// non-self recipient.
function refreshConfirmEnabled() {
	const btn = $('payment-confirm-btn');
	if (!btn) return;
	let enabled = !!connectedWallet;
	if (giftState.active && (!giftState.recipient || giftState.resolving)) enabled = false;
	if (!pwywAmountValid()) enabled = false;
	btn.disabled = !enabled;
}

// Reset + show/hide the gift controls. Enabled only for skill flows; assets and
// subscriptions pass enabled:false so the section stays hidden.
function setupGiftUI({ enabled }) {
	clearTimeout(giftLookupTimer);
	giftState = { enabled, active: false, recipient: null, resolving: false, seq: giftState.seq + 1 };
	const area = $('payment-gift-area');
	const toggle = $('payment-gift-toggle-input');
	const recip = $('payment-gift-recipient');
	const input = $('payment-gift-input');
	if (toggle) toggle.checked = false;
	if (input) input.value = '';
	if (recip) recip.hidden = true;
	if (area) area.hidden = !enabled;
	setGiftStatus('');
}

function onGiftToggle() {
	const toggle = $('payment-gift-toggle-input');
	const recip = $('payment-gift-recipient');
	const input = $('payment-gift-input');
	giftState.active = !!toggle?.checked;
	giftState.recipient = null;
	giftState.resolving = false;
	giftState.seq++;
	clearTimeout(giftLookupTimer);
	if (recip) recip.hidden = !giftState.active;
	setGiftStatus('');
	if (giftState.active) {
		if (input) input.value = '';
		input?.focus();
	}
	refreshConfirmEnabled();
}

function onGiftInput() {
	const q = ($('payment-gift-input')?.value || '').trim();
	giftState.recipient = null;
	clearTimeout(giftLookupTimer);
	const seq = ++giftState.seq;
	if (!q) {
		giftState.resolving = false;
		setGiftStatus('');
		refreshConfirmEnabled();
		return;
	}
	giftState.resolving = true;
	setGiftStatus('Looking up…');
	refreshConfirmEnabled();
	giftLookupTimer = setTimeout(() => resolveGiftRecipient(q, seq), 400);
}

async function resolveGiftRecipient(q, seq) {
	let resp, j;
	try {
		resp = await fetch(`/api/users/lookup?q=${encodeURIComponent(q)}`, { credentials: 'include' });
		j = await resp.json().catch(() => ({}));
	} catch {
		if (seq !== giftState.seq) return;
		giftState.resolving = false;
		giftState.recipient = null;
		setGiftStatus('Lookup failed — check your connection.', 'err');
		refreshConfirmEnabled();
		return;
	}
	if (seq !== giftState.seq) return; // a newer keystroke superseded this lookup
	giftState.resolving = false;
	if (!resp.ok) {
		giftState.recipient = null;
		if (resp.status === 404) setGiftStatus('No user found with that username or wallet.', 'err');
		else if (resp.status === 401) setGiftStatus('Sign in to send a gift.', 'err');
		else setGiftStatus(j?.error_description || 'Lookup failed.', 'err');
		refreshConfirmEnabled();
		return;
	}
	const user = j?.data;
	if (!user || user.is_self) {
		giftState.recipient = null;
		setGiftStatus("That's your own account — pick someone else to gift to.", 'err');
	} else {
		giftState.recipient = user;
		setGiftStatus(`🎁 Gifting to ${giftLabel(user)}`, 'ok');
	}
	refreshConfirmEnabled();
}

function closePaymentModal() {
	const overlay = $('payment-modal-overlay');
	if (overlay) overlay.hidden = true;
	const qr = $('payment-qr'); if (qr) qr.innerHTML = '';
	const confirmBtn = $('payment-confirm-btn');
	if (confirmBtn) {
		delete confirmBtn.dataset.durationHours;
		delete confirmBtn.dataset.mode;
		confirmBtn.hidden = false;
		confirmBtn.disabled = true;
	}
	const body = $('payment-modal-body');
	const success = $('payment-modal-success');
	if (body) body.hidden = false;
	if (success) { success.hidden = true; success.innerHTML = ''; }
	setPaymentBadge('');
	setStatus('');
	setupPwywUI({ active: false });
	setupGiftUI({ enabled: false });
	pendingAssetPurchase = null;
	pendingSubscription = null;
}

// ── Wallet plumbing ─────────────────────────────────────────────────────────

let solanaConnection;
let solanaWeb3Mod;
let splTokenMod;
let connectedWallet = null; // { provider, name, publicKey }

const WALLET_PROVIDERS = [
	// Seeker/Saga TWA: solana-mobile/src/index.js injects a Seed-Vault-backed
	// wallet with isThreeWs=true (and isPhantom=false, on purpose). Its
	// detect() only returns truthy inside the TWA, so this entry is inert
	// everywhere else.
	{ key: 'seeker', name: 'Seeker Wallet', detect: () => (window.threeWsWallet?.isThreeWs && window.threeWsWallet) || (window.solana?.isThreeWs && window.solana) },
	{ key: 'phantom', name: 'Phantom', detect: () => window.phantom?.solana || (window.solana?.isPhantom && window.solana) },
	{ key: 'solflare', name: 'Solflare', detect: () => window.solflare },
	{ key: 'backpack', name: 'Backpack', detect: () => window.backpack?.solana || (window.solana?.isBackpack && window.solana) },
];

async function loadSolanaModules() {
	if (!solanaWeb3Mod) solanaWeb3Mod = await import('@solana/web3.js');
	if (!splTokenMod) splTokenMod = await import('@solana/spl-token');
	return { web3: solanaWeb3Mod, spl: splTokenMod };
}

async function getSolanaConnection() {
	if (solanaConnection) return solanaConnection;
	const { web3 } = await loadSolanaModules();
	const rpcOrigin = window.location?.origin || 'https://three.ws';
	solanaConnection = new web3.Connection(`${rpcOrigin}/api/solana-rpc`, 'confirmed');
	return solanaConnection;
}

function listAvailableWallets() {
	return WALLET_PROVIDERS.map((p) => ({ ...p, provider: p.detect() })).filter((p) => p.provider);
}

async function connectWalletProvider(providerKey) {
	const entry = WALLET_PROVIDERS.find((p) => p.key === providerKey);
	if (!entry) throw new Error('unknown wallet');
	const provider = entry.detect();
	if (!provider) throw new Error(`${entry.name} not installed`);
	const { web3 } = await loadSolanaModules();
	const resp = await provider.connect();
	const pubKey = resp?.publicKey ?? provider.publicKey;
	if (!pubKey) throw new Error('wallet did not return a public key');
	connectedWallet = {
		provider,
		name: entry.name,
		publicKey: typeof pubKey === 'string' ? new web3.PublicKey(pubKey) : pubKey,
	};
	updateWalletUI();
}

function disconnectWallet() {
	try { connectedWallet?.provider?.disconnect?.(); } catch {}
	connectedWallet = null;
	updateWalletUI();
}

function updateWalletUI() {
	const walletArea = $('payment-wallet-area');
	if (!walletArea) return;

	if (connectedWallet) {
		const pk = connectedWallet.publicKey.toBase58();
		walletArea.innerHTML = `
			<p>Connected via <strong>${escapeHtml(connectedWallet.name)}</strong>: ${pk.slice(0, 4)}…${pk.slice(-4)}</p>
			<button class="btn-secondary" id="payment-disconnect-btn">Disconnect</button>`;
		$('payment-disconnect-btn').addEventListener('click', disconnectWallet);
		refreshConfirmEnabled();
		return;
	}

	const available = listAvailableWallets();
	if (!available.length) {
		walletArea.innerHTML = `
			<p class="muted">No browser wallet detected.</p>
			<button class="btn-primary" id="payment-show-qr">Use a mobile wallet (QR)</button>
			<p class="muted small">Install <a href="https://phantom.app" target="_blank" rel="noopener">Phantom</a>,
			<a href="https://solflare.com" target="_blank" rel="noopener">Solflare</a>, or
			<a href="https://backpack.app" target="_blank" rel="noopener">Backpack</a>.</p>`;
	} else {
		const btns = available
			.map((w) => `<button class="btn-primary wallet-pick" data-wallet="${w.key}">Connect ${escapeHtml(w.name)}</button>`)
			.join('');
		walletArea.innerHTML = `${btns}<button class="btn-secondary" id="payment-show-qr">Use a mobile wallet (QR)</button>`;
		walletArea.querySelectorAll('.wallet-pick').forEach((btn) => {
			btn.addEventListener('click', async () => {
				const key = btn.dataset.wallet;
				btn.textContent = 'Connecting…';
				btn.disabled = true;
				try {
					await connectWalletProvider(key);
				} catch (e) {
					const name = WALLET_PROVIDERS.find((p) => p.key === key)?.name ?? key;
					btn.textContent = `Connect ${name}`;
					btn.disabled = false;
					setStatus(e.message, 'err');
				}
			});
		});
	}
	$('payment-show-qr')?.addEventListener('click', startQrPurchase);
	refreshConfirmEnabled();
}

// ── CSRF ────────────────────────────────────────────────────────────────────

let _csrf = null;
async function getCsrfToken() {
	if (_csrf && _csrf.expiresAt > Date.now() + 5_000) return _csrf.token;
	const r = await fetch('/api/csrf-token', { credentials: 'include' });
	if (!r.ok) throw new Error('Could not obtain CSRF token; sign in again.');
	const j = await r.json();
	_csrf = { token: j.data.token, expiresAt: Date.now() + (j.data.expires_in - 30) * 1000 };
	return _csrf.token;
}
export async function apiPostWithCsrf(url, body) {
	const token = await getCsrfToken();
	_csrf = null;
	return fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
		credentials: 'include',
		body: body == null ? undefined : JSON.stringify(body),
	});
}

async function buildSplTransferWithReference({ payer, recipient, mint, amount, reference }) {
	const { web3, spl } = await loadSolanaModules();
	const { PublicKey, Transaction } = web3;
	const { getAssociatedTokenAddress, createTransferInstruction } = spl;

	const recipientKey = new PublicKey(recipient);
	const mintKey = new PublicKey(mint);
	const referenceKey = new PublicKey(reference);

	const fromAta = await getAssociatedTokenAddress(mintKey, payer);
	const toAta = await getAssociatedTokenAddress(mintKey, recipientKey);

	const ix = createTransferInstruction(fromAta, toAta, payer, amount);
	ix.keys.push({ pubkey: referenceKey, isSigner: false, isWritable: false });

	const { blockhash } = await (await getSolanaConnection()).getLatestBlockhash('confirmed');
	const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash }).add(ix);
	return tx;
}

function base64ToBytes(b64) {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

// Sign + send a platform-prepared, gasless VersionedTransaction. The platform
// payer is the fee-payer and has already partially signed it server-side, so
// the wallet only adds the buyer's authority signature — the buyer needs no SOL.
async function signAndSendPreparedTx(base64Tx) {
	const { web3 } = await loadSolanaModules();
	const tx = web3.VersionedTransaction.deserialize(base64ToBytes(base64Tx));
	const provider = connectedWallet.provider;
	if (typeof provider.signAndSendTransaction === 'function') {
		const result = await provider.signAndSendTransaction(tx);
		return result?.signature ?? result;
	}
	if (typeof provider.signTransaction === 'function') {
		const signed = await provider.signTransaction(tx);
		return (await getSolanaConnection()).sendRawTransaction(signed.serialize());
	}
	throw new Error('Your wallet cannot sign this transaction.');
}

// Submit the purchase. Prefers the server-prepared gasless transaction (fee
// sponsored by three.ws); falls back to a buyer-pays transfer built client-side
// when no sponsorship is available. Returns the on-chain signature.
async function sendPurchaseTransaction(purchase) {
	if (purchase.transaction) return signAndSendPreparedTx(purchase.transaction);

	const tx = await buildSplTransferWithReference({
		payer: connectedWallet.publicKey,
		recipient: purchase.recipient,
		mint: purchase.currency_mint,
		amount: BigInt(purchase.amount),
		reference: purchase.reference,
	});
	const provider = connectedWallet.provider;
	if (typeof provider.signAndSendTransaction === 'function') {
		const result = await provider.signAndSendTransaction(tx);
		return result?.signature ?? result;
	}
	return provider.sendTransaction(tx, await getSolanaConnection());
}

// ── Server purchase records ─────────────────────────────────────────────────

async function createPendingPurchase(agentId, skill, durationHours = null, buyerPublicKey = null, recipient = null, payAmountAtomics = null) {
	const body = { agent_id: agentId, skill };
	if (durationHours) body.duration_hours = durationHours;
	// Hand the server our wallet pubkey so it can return a gasless, pre-signed
	// transaction (network fee sponsored by the platform).
	if (buyerPublicKey) body.buyer_public_key = buyerPublicKey;
	// Gift: the resolved recipient's user id; the server re-resolves + validates.
	if (recipient) body.recipient = recipient;
	// Pay-what-you-want: the buyer's chosen amount in atomic units. The server
	// validates it against the skill's minimum + ceiling and ignores it for
	// fixed-price skills.
	if (payAmountAtomics != null) body.pay_amount = String(payAmountAtomics);
	const r = await apiPostWithCsrf('/api/marketplace/purchase', body);
	const j = await r.json();
	if (!r.ok) throw new Error(j.error_description || j.error || 'Failed to create purchase');
	return j.data;
}

async function pollConfirm(reference, windowMs = 60_000) {
	const deadline = Date.now() + windowMs;
	while (Date.now() < deadline) {
		const r = await apiPostWithCsrf(`/api/marketplace/purchase/${reference}/confirm`, null);
		const j = await r.json().catch(() => ({}));
		if (r.ok && j.data?.status === 'confirmed') return true;
		if (j.status === 'tipped') {
			throw new Error('Payment received but amount/mint did not match — seller has been notified.');
		}
		if (r.status === 410) throw new Error('Pending purchase expired. Please try again.');
		if (r.status === 409 && !j.status) throw new Error(j.error_description || 'Transfer did not match.');
		await new Promise((res) => setTimeout(res, 2500));
	}
	return false;
}

// ── Skill purchase flows ────────────────────────────────────────────────────

export async function openPurchaseFlow(agentId, skill) {
	ensureModal();
	const agent = cfg.getAgent();
	if (!agent || agent.id !== agentId) { alert('Agent not loaded; refresh and try again.'); return; }
	const price = agent.skill_prices?.[skill];
	if (!price) { alert('No price set for this skill.'); return; }

	const decimals = Number(price.mint_decimals ?? 6);
	const human = (Number(price.amount) / Math.pow(10, decimals)).toFixed(decimals === 6 ? 2 : 4);
	const isPwyw = price.pricing_type === 'pwyw';

	setPaymentTitle('Unlock skill');
	setPaymentLede(isPwyw
		? 'Choose how much to pay for permanent access to this skill:'
		: 'You are purchasing permanent access to this skill:');
	setPaymentFromLabel('on agent');
	setPaymentBadge('');
	$('payment-skill-name').textContent = skill;
	$('payment-agent-name').textContent = agent.name;
	// For PWYW the amount input below carries the total, so the static "Total"
	// line shows the floor (or "Pay what you want") instead of a fixed figure.
	if (isPwyw) {
		const minAtomics = price.minimum_amount != null ? Number(price.minimum_amount) : 0;
		const minHuman = (minAtomics / Math.pow(10, decimals)).toString();
		$('payment-price-display').textContent = minAtomics > 0
			? `From ${minHuman} ${shortMintLabel(price.currency_mint)}`
			: 'Pay what you want';
	} else {
		$('payment-price-display').textContent = `${human} ${shortMintLabel(price.currency_mint)}`;
	}
	const confirmBtn = $('payment-confirm-btn');
	if (confirmBtn) confirmBtn.textContent = 'Confirm purchase';
	const qr = $('payment-qr'); if (qr) qr.innerHTML = '';
	setStatus('');
	setupPwywUI({ active: isPwyw, price });
	setupGiftUI({ enabled: true });
	$('payment-modal-overlay').hidden = false;
	updateWalletUI();
}

export async function openTimePassFlow(agentId, skill, durationHours, btn) {
	ensureModal();
	const agent = cfg.getAgent();
	if (!agent || agent.id !== agentId) { alert('Agent not loaded; refresh and try again.'); return; }
	const price = agent.skill_prices?.[skill];
	if (!price) { alert('No price set for this skill.'); return; }

	if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }

	setPaymentTitle(`Get ${durationHours}h access`);
	setPaymentLede('You are renting temporary access to this skill:');
	setPaymentFromLabel('on agent');
	setPaymentBadge(
		`<span class="payment-modal-badge-icon" aria-hidden="true">⏱</span><span>Access expires ${durationHours} hour${durationHours === 1 ? '' : 's'} after purchase. Not a permanent unlock.</span>`,
		'warn',
	);
	$('payment-skill-name').textContent = skill;
	$('payment-agent-name').textContent = agent.name;
	const tpAmount = price.time_pass_amount || price.amount;
	const decimals = Number(price.mint_decimals ?? 6);
	const human = (Number(tpAmount) / Math.pow(10, decimals)).toFixed(decimals === 6 ? 2 : 4);
	$('payment-price-display').textContent = `${human} ${shortMintLabel(price.currency_mint)}`;
	const qr = $('payment-qr'); if (qr) qr.innerHTML = '';
	setStatus('');
	setupPwywUI({ active: false });
	setupGiftUI({ enabled: true });
	$('payment-modal-overlay').hidden = false;
	updateWalletUI();

	const confirmBtn = $('payment-confirm-btn');
	confirmBtn.dataset.durationHours = String(durationHours);
	confirmBtn.textContent = `Pay & unlock ${durationHours}h access`;

	if (btn) { btn.disabled = false; btn.textContent = `Get ${durationHours}h access`; }
}

export async function openTrialFlow(agentId, skill, btn) {
	const agent = cfg.getAgent();
	if (!agent || agent.id !== agentId) { alert('Agent not loaded; refresh and try again.'); return; }
	if (btn) { btn.disabled = true; btn.textContent = 'Starting trial…'; }
	try {
		const r = await apiPostWithCsrf('/api/marketplace/start-trial', { agent_id: agentId, skill });
		const j = await r.json().catch(() => ({}));
		if (!r.ok) {
			if (j.error === 'already_owned') showToast('You already own this skill.', { type: 'info' });
			else if (j.error === 'trial_used') showToast('You have already used the trial for this skill.', { type: 'warning' });
			else if (r.status === 401) { location.href = `/login?next=${encodeURIComponent(location.pathname)}`; return; }
			else showToast(j.error_description || j.error || 'Failed to start trial', { type: 'error' });
			return;
		}
		await cfg.onPurchased(agentId);
		showToast(`Free trial of ${skill} started.`, { type: 'success' });
	} catch (err) {
		showToast(err.message || 'Failed to start trial', { type: 'error' });
	} finally {
		if (btn) { btn.disabled = false; btn.textContent = 'Try free'; }
	}
}

// ── Asset purchase (agent / avatar / plugin) ────────────────────────────────

let pendingAssetPurchase = null;

export function openAssetPurchaseFlow(asset) {
	ensureModal();
	const confirmBtn = $('payment-confirm-btn');
	const skillName = $('payment-skill-name');
	const agentName = $('payment-agent-name');
	const priceDisplay = $('payment-price-display');
	if (!confirmBtn || !skillName || !priceDisplay) { alert('Payment UI not available on this page.'); return; }

	pendingAssetPurchase = asset;
	confirmBtn.dataset.mode = 'asset';
	confirmBtn.disabled = false;
	confirmBtn.hidden = false;
	delete confirmBtn.dataset.durationHours;

	const typeLabel = asset.item_type ? asset.item_type.charAt(0).toUpperCase() + asset.item_type.slice(1) : 'Asset';
	setPaymentTitle(`Buy ${typeLabel}`);
	setPaymentLede(`You are buying this ${asset.item_type || 'asset'}:`);
	setPaymentFromLabel(typeLabel);
	setPaymentBadge('');
	confirmBtn.textContent = 'Confirm purchase';

	skillName.textContent = asset.label || 'Asset';
	if (agentName) agentName.textContent = '';

	const decimals = Number(asset.price?.mint_decimals ?? 6);
	const human = (Number(asset.price?.amount || 0) / Math.pow(10, decimals)).toFixed(decimals === 6 ? 2 : 4);
	priceDisplay.textContent = `${human} ${shortMintLabel(asset.price?.currency_mint || '')}`;

	const qr = $('payment-qr'); if (qr) qr.innerHTML = '';
	setStatus('');
	setupPwywUI({ active: false });
	setupGiftUI({ enabled: false });
	$('payment-modal-overlay').hidden = false;
	updateWalletUI();
}

async function createPendingAssetPurchase(itemType, itemId, buyerPublicKey = null) {
	const body = { item_type: itemType, item_id: itemId };
	if (buyerPublicKey) body.buyer_public_key = buyerPublicKey;
	const r = await apiPostWithCsrf('/api/marketplace/buy-asset', body);
	const j = await r.json();
	if (!r.ok) throw new Error(j.error_description || j.error || 'Failed to create purchase');
	return j.data;
}

async function pollAssetConfirm(reference, windowMs = 60_000) {
	const deadline = Date.now() + windowMs;
	while (Date.now() < deadline) {
		const r = await apiPostWithCsrf(`/api/marketplace/buy-asset/${reference}/confirm`, null);
		const j = await r.json().catch(() => ({}));
		if (r.ok && j.data?.status === 'confirmed') return true;
		if (r.status === 410) throw new Error('Pending purchase expired. Please try again.');
		if (r.status === 409) throw new Error(j.error_description || 'Transfer did not match expected amount.');
		await new Promise((res) => setTimeout(res, 2500));
	}
	return false;
}

function assetViewTarget(asset) {
	const type = asset?.item_type;
	if (type === 'avatar') return { href: '/dashboard/avatars', label: 'View avatar' };
	if (type === 'agent') return { href: '/dashboard/agents', label: 'View agent' };
	if (type === 'plugin') return { href: '/dashboard', label: 'View plugin' };
	return { href: '/dashboard', label: 'View in dashboard' };
}

// ── Confirm handlers ────────────────────────────────────────────────────────

async function handlePurchase() {
	const confirmBtn = $('payment-confirm-btn');
	if (confirmBtn?.dataset.mode === 'asset') return handleAssetPurchase();
	if (confirmBtn?.dataset.mode === 'subscription') return handleSubscription();
	if (!connectedWallet) { setStatus('Connect a wallet first.', 'err'); return; }
	const agent = cfg.getAgent();
	if (!agent) return;

	confirmBtn.disabled = true;
	setStatus('Creating purchase…');

	const agentId = agent.id;
	const skill = $('payment-skill-name').textContent;
	const durationHours = confirmBtn.dataset.durationHours ? Number(confirmBtn.dataset.durationHours) : null;
	// Snapshot the gift recipient at click time so a late keystroke can't change
	// who the in-flight purchase is for.
	const giftRecipient = activeGiftRecipient();
	// Snapshot the PWYW amount the same way — the figure in flight must be the one
	// the buyer saw when they clicked. Guarded by refreshConfirmEnabled (the button
	// is disabled until the amount clears the minimum), but re-checked here so a
	// programmatic call can't bypass it.
	let payAmountAtomics = null;
	if (pwywState.active) {
		const chosen = pwywChosenAtomics();
		if (!pwywAmountValid() || chosen == null) {
			confirmBtn.disabled = false;
			setStatus(
				pwywState.minAtomics > 0n
					? `Enter at least ${pwywMinHuman()} ${pwywState.symbol}.`
					: 'Enter how much you want to pay.',
				'err',
			);
			return;
		}
		payAmountAtomics = chosen.toString();
	}

	const onUnlocked = async () => {
		await cfg.onPurchased(agentId);
		if (giftRecipient) {
			showToast(`Gift sent to ${giftLabel(giftRecipient)} — ${skill} unlocked.`, { type: 'success' });
			renderPaymentSuccess({
				title: 'Gift sent 🎁',
				message: durationHours
					? `${giftLabel(giftRecipient)} now has ${durationHours}h access to ${skill} on ${agent.name}. We've let them know.`
					: `${giftLabel(giftRecipient)} now has access to ${skill} on ${agent.name}. We've let them know.`,
				primaryHref: null,
				secondaryLabel: 'Done',
			});
			return;
		}
		showToast(
			durationHours ? `${durationHours}h access to ${skill} unlocked.` : `${skill} unlocked.`,
			{ type: 'success' },
		);
		renderPaymentSuccess({
			title: durationHours ? `${durationHours}h access unlocked` : 'Skill unlocked',
			message: durationHours
				? `${skill} is now usable. Access ends ${durationHours} hour${durationHours === 1 ? '' : 's'} from now.`
				: `${skill} is now part of your library on ${agent.name}.`,
			primaryHref: null,
			secondaryLabel: 'Done',
		});
	};

	let purchase;
	try {
		purchase = await createPendingPurchase(agentId, skill, durationHours, connectedWallet.publicKey.toBase58(), giftRecipient?.id || null, payAmountAtomics);
		if (purchase.already_owned) {
			await cfg.onPurchased(agentId);
			renderPaymentSuccess({
				title: giftRecipient ? 'Already owned' : 'Already unlocked',
				message: giftRecipient
					? `${giftLabel(giftRecipient)} already has access to ${skill}, so there's nothing to gift.`
					: `You already have access to ${skill}.`,
				primaryHref: null,
				secondaryLabel: 'Continue',
			});
			return;
		}
	} catch (e) {
		setStatus(e.message, 'err');
		confirmBtn.disabled = false;
		return;
	}

	let txid;
	try {
		setStatus(purchase.gasless ? 'Approve in wallet — gas is on us…' : 'Approve in wallet…');
		txid = await sendPurchaseTransaction(purchase);

		setStatus('Waiting for on-chain confirmation…');
		await (await getSolanaConnection()).confirmTransaction(txid, 'confirmed');

		setStatus('Verifying with server…');
		const ok = await pollConfirm(purchase.reference, 60_000);
		if (!ok) {
			renderPaymentVerifyAgain({
				txid,
				message: "Payment is on-chain but the server hasn't seen it yet. Re-verify below.",
				retryFn: async () => {
					const ok2 = await pollConfirm(purchase.reference, 60_000);
					if (!ok2) throw new Error('Still not confirmed — wait a few seconds and try again.');
					await onUnlocked();
				},
			});
			return;
		}
		await onUnlocked();
	} catch (e) {
		log.error('[skill-purchase] purchase failed', e);
		if (txid) {
			renderPaymentVerifyAgain({
				txid,
				message: e.message || 'Payment sent but verification failed — re-verify below.',
				retryFn: async () => {
					const ok2 = await pollConfirm(purchase.reference, 60_000);
					if (!ok2) throw new Error('Still not confirmed — wait a few seconds and try again.');
					await onUnlocked();
				},
			});
			return;
		}
		showToast(e.message || 'Purchase failed', { type: 'error' });
		setStatus(e.message || 'Purchase failed', 'err');
		confirmBtn.disabled = false;
	}
}

async function handleAssetPurchase() {
	const confirmBtn = $('payment-confirm-btn');
	const asset = pendingAssetPurchase;
	if (!asset) { setStatus('No asset selected.', 'err'); return; }
	if (!connectedWallet) { setStatus('Connect a wallet first.', 'err'); return; }

	confirmBtn.disabled = true;
	setStatus('Creating purchase…');

	let purchase;
	try {
		purchase = await createPendingAssetPurchase(asset.item_type, asset.item_id, connectedWallet.publicKey.toBase58());
		if (purchase.already_owned) {
			const target = assetViewTarget(asset);
			renderPaymentSuccess({
				title: 'Already owned',
				message: `You already purchased ${asset.label}.`,
				primaryHref: target.href,
				primaryLabel: target.label,
			});
			return;
		}
	} catch (e) {
		setStatus(e.message, 'err');
		confirmBtn.disabled = false;
		return;
	}

	let txid;
	try {
		setStatus(purchase.gasless ? 'Approve in wallet — gas is on us…' : 'Approve in wallet…');
		txid = await sendPurchaseTransaction(purchase);

		setStatus('Waiting for on-chain confirmation…');
		await (await getSolanaConnection()).confirmTransaction(txid, 'confirmed');

		setStatus('Verifying with server…');
		const ok = await pollAssetConfirm(purchase.reference, 60_000);
		const succeed = () => {
			const target = assetViewTarget(asset);
			showToast(`${asset.label} purchased.`, { type: 'success' });
			renderPaymentSuccess({
				title: `${asset.label} purchased`,
				message: `${asset.item_type === 'avatar' ? 'Your new avatar' : asset.item_type === 'agent' ? 'Your new agent' : 'Your purchase'} is in your dashboard.`,
				primaryHref: target.href,
				primaryLabel: target.label,
			});
			cfg.onPurchased(asset.item_id).catch(() => {});
		};
		if (!ok) {
			renderPaymentVerifyAgain({
				txid,
				message: "We couldn't verify the transfer with the server in 60s. The on-chain transaction is safe — re-verify below.",
				retryFn: async () => {
					const ok2 = await pollAssetConfirm(purchase.reference, 60_000);
					if (!ok2) throw new Error('Still not confirmed — wait a few seconds and try again.');
					succeed();
				},
			});
			return;
		}
		succeed();
	} catch (e) {
		log.error('[skill-purchase] asset purchase failed', e);
		if (txid) {
			renderPaymentVerifyAgain({
				txid,
				message: e.message || 'Payment sent but verification failed — re-verify below.',
				retryFn: async () => {
					const ok2 = await pollAssetConfirm(purchase.reference, 60_000);
					if (!ok2) throw new Error('Still not confirmed — wait a few seconds and try again.');
					const target = assetViewTarget(asset);
					showToast(`${asset.label} purchased.`, { type: 'success' });
					renderPaymentSuccess({
						title: `${asset.label} purchased`,
						message: `${asset.item_type === 'avatar' ? 'Your new avatar' : 'Your purchase'} is in your dashboard.`,
						primaryHref: target.href,
						primaryLabel: target.label,
					});
				},
			});
			return;
		}
		showToast(e.message || 'Purchase failed', { type: 'error' });
		setStatus(e.message || 'Purchase failed', 'err');
		confirmBtn.disabled = false;
	}
}

// ── Subscription (agent tier) ───────────────────────────────────────────────
//
// Unlike skills/assets — where the browser builds a single-leg transfer — the
// subscription server returns a fully-built VersionedTransaction (creator + fee
// split, platform pre-signed as fee-payer for gasless UX). The wallet just adds
// the buyer's signature and broadcasts; we then activate via /verify.

let pendingSubscription = null;

/**
 * Open the confirmation modal for subscribing to an agent tier.
 * @param {string} agentId
 * @param {{ id: string, name: string, price_usd: number, interval: string, perks?: string[] }} tier
 */
export async function openSubscribeFlow(agentId, tier) {
	ensureModal();
	const agent = cfg.getAgent();
	if (!agent || agent.id !== agentId) { alert('Agent not loaded; refresh and try again.'); return; }
	if (!tier?.id) { alert('Tier unavailable; refresh and try again.'); return; }

	pendingSubscription = { agentId, tier };
	const cycle = tier.interval === 'weekly' ? 'week' : 'month';
	const price = Number(tier.price_usd);

	setPaymentTitle('Subscribe');
	setPaymentLede('You are starting a subscription to this tier:');
	setPaymentFromLabel('tier on');
	setPaymentBadge(
		`<span class="payment-modal-badge-icon" aria-hidden="true">↻</span><span>Recurring ${cycle}ly billing. The first ${cycle} is charged now; you can cancel anytime.</span>`,
		'info',
	);
	$('payment-skill-name').textContent = tier.name;
	$('payment-agent-name').textContent = agent.name;
	$('payment-price-display').textContent = `$${price.toFixed(2)} / ${cycle}`;

	const confirmBtn = $('payment-confirm-btn');
	if (confirmBtn) {
		confirmBtn.dataset.mode = 'subscription';
		confirmBtn.textContent = `Subscribe · $${price.toFixed(2)}/${cycle === 'week' ? 'wk' : 'mo'}`;
		confirmBtn.hidden = false;
	}
	const qr = $('payment-qr'); if (qr) qr.innerHTML = '';
	setStatus('');
	setupPwywUI({ active: false });
	setupGiftUI({ enabled: false });
	$('payment-modal-overlay').hidden = false;
	updateWalletUI();
}

async function createSubscriptionCheckout(tierId, buyerPublicKey) {
	const r = await apiPostWithCsrf('/api/subscriptions/subscribe', { tierId, buyerPublicKey });
	const j = await r.json().catch(() => ({}));
	if (!r.ok) {
		if (j.error === 'already_subscribed') throw new Error('You already have an active subscription to this tier.');
		if (j.error === 'creator_wallet_missing') throw new Error('This creator has not set up a payout wallet yet.');
		if (r.status === 401) { location.href = `/login?next=${encodeURIComponent(location.pathname)}`; throw new Error('Sign in to subscribe.'); }
		throw new Error(j.error_description || j.error || 'Failed to start subscription');
	}
	return j.data;
}

// Sign + broadcast a server-built base64 VersionedTransaction with the connected
// wallet, returning the tx signature.
async function signAndSendServerTx(base64) {
	const { web3 } = await loadSolanaModules();
	const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
	const vtx = web3.VersionedTransaction.deserialize(bytes);
	const provider = connectedWallet.provider;
	if (typeof provider.signAndSendTransaction === 'function') {
		const result = await provider.signAndSendTransaction(vtx);
		return result?.signature ?? result;
	}
	const signed = await provider.signTransaction(vtx);
	return (await getSolanaConnection()).sendRawTransaction(signed.serialize());
}

async function pollSubscriptionVerify(tierId, signature, windowMs = 60_000) {
	const deadline = Date.now() + windowMs;
	while (Date.now() < deadline) {
		const r = await apiPostWithCsrf('/api/subscriptions/verify', { tierId, transactionSignature: signature });
		const j = await r.json().catch(() => ({}));
		if (r.ok && j.data?.success) return true;
		if (r.ok && j.data?.status === 'pending') { await new Promise((res) => setTimeout(res, 2500)); continue; }
		if (r.status === 410) throw new Error('Checkout expired. Please start the subscription again.');
		if (r.status === 409) throw new Error(j.error_description || 'On-chain transfer did not match the quoted amount.');
		throw new Error(j.error_description || j.error || 'Could not activate subscription');
	}
	return false;
}

async function handleSubscription() {
	const confirmBtn = $('payment-confirm-btn');
	const ctx = pendingSubscription;
	if (!ctx) { setStatus('No tier selected.', 'err'); return; }
	if (!connectedWallet) { setStatus('Connect a wallet first.', 'err'); return; }

	const { agentId, tier } = ctx;
	const agent = cfg.getAgent();
	const cycle = tier.interval === 'weekly' ? 'week' : 'month';
	confirmBtn.disabled = true;

	const succeed = () => {
		cfg.onPurchased(agentId).catch(() => {});
		showToast(`Subscribed to ${tier.name}.`, { type: 'success' });
		renderPaymentSuccess({
			title: `Subscribed to ${tier.name}`,
			message: `You now have access to ${agent?.name || 'this agent'}'s paid skills. Billed every ${cycle}.`,
			primaryHref: null,
			secondaryLabel: 'Done',
		});
	};

	let checkout;
	try {
		setStatus('Preparing subscription…');
		checkout = await createSubscriptionCheckout(tier.id, connectedWallet.publicKey.toBase58());
	} catch (e) {
		setStatus(e.message, 'err');
		confirmBtn.disabled = false;
		return;
	}

	let txid;
	try {
		setStatus('Approve in wallet…');
		txid = await signAndSendServerTx(checkout.transaction);

		setStatus('Waiting for on-chain confirmation…');
		await (await getSolanaConnection()).confirmTransaction(txid, 'confirmed');

		setStatus('Activating subscription…');
		const ok = await pollSubscriptionVerify(tier.id, txid, 60_000);
		if (!ok) {
			renderPaymentVerifyAgain({
				txid,
				message: "Payment is on-chain but the server hasn't seen it yet. Re-verify below.",
				retryFn: async () => {
					const ok2 = await pollSubscriptionVerify(tier.id, txid, 60_000);
					if (!ok2) throw new Error('Still not confirmed — wait a few seconds and try again.');
					succeed();
				},
			});
			return;
		}
		succeed();
	} catch (e) {
		log.error('[skill-purchase] subscription failed', e);
		if (txid) {
			renderPaymentVerifyAgain({
				txid,
				message: e.message || 'Payment sent but activation failed — re-verify below.',
				retryFn: async () => {
					const ok2 = await pollSubscriptionVerify(tier.id, txid, 60_000);
					if (!ok2) throw new Error('Still not confirmed — wait a few seconds and try again.');
					succeed();
				},
			});
			return;
		}
		showToast(e.message || 'Subscription failed', { type: 'error' });
		setStatus(e.message || 'Subscription failed', 'err');
		confirmBtn.disabled = false;
	}
}

// Mobile-wallet path: render a Solana Pay QR. Buyer scans + signs on phone.
async function startQrPurchase() {
	const agent = cfg.getAgent();
	if (!agent) return;
	const agentId = agent.id;
	const skill = $('payment-skill-name').textContent;
	const giftRecipient = activeGiftRecipient();

	// PWYW over the mobile QR path: enforce the same amount validity before we
	// mint the Solana Pay reference, so the QR encodes the buyer-chosen amount.
	let payAmountAtomics = null;
	if (pwywState.active) {
		const chosen = pwywChosenAtomics();
		if (!pwywAmountValid() || chosen == null) {
			setStatus(
				pwywState.minAtomics > 0n
					? `Enter at least ${pwywMinHuman()} ${pwywState.symbol}.`
					: 'Enter how much you want to pay.',
				'err',
			);
			return;
		}
		payAmountAtomics = chosen.toString();
	}

	setStatus('Creating purchase…');
	let purchase;
	try {
		purchase = await createPendingPurchase(agentId, skill, null, null, giftRecipient?.id || null, payAmountAtomics);
		if (purchase.already_owned) {
			await cfg.onPurchased(agentId);
			renderPaymentSuccess({
				title: giftRecipient ? 'Already owned' : 'Already unlocked',
				message: giftRecipient
					? `${giftLabel(giftRecipient)} already has access to ${skill}, so there's nothing to gift.`
					: `You already have access to ${skill}.`,
				primaryHref: null,
				secondaryLabel: 'Continue',
			});
			return;
		}
	} catch (e) {
		setStatus(e.message, 'err');
		return;
	}

	const decimals = Number(purchase.mint_decimals ?? 6);
	const human = (Number(purchase.amount) / Math.pow(10, decimals)).toString();
	const url = new URL(`solana:${purchase.recipient}`);
	url.searchParams.set('amount', human);
	url.searchParams.set('spl-token', purchase.currency_mint);
	url.searchParams.set('reference', purchase.reference);
	url.searchParams.set('label', purchase.label || `Skill: ${skill}`);
	url.searchParams.set('message', purchase.message || `Unlock '${skill}'`);

	const qrEl = $('payment-qr');
	if (qrEl) {
		qrEl.innerHTML = `<canvas id="payment-qr-canvas" width="240" height="240"></canvas>
			<p class="muted small">Scan with a Solana Pay wallet (Phantom mobile, Solflare mobile, etc.)</p>`;
		const QRCode = await import('qrcode');
		await (QRCode.default ?? QRCode).toCanvas(document.getElementById('payment-qr-canvas'), url.toString(), { width: 240 });
	}

	const qrSuccess = async () => {
		await cfg.onPurchased(agentId);
		showToast(
			giftRecipient ? `Gift sent to ${giftLabel(giftRecipient)} — ${skill} unlocked.` : `${skill} unlocked.`,
			{ type: 'success' },
		);
		renderPaymentSuccess({
			title: giftRecipient ? 'Gift sent 🎁' : 'Skill unlocked',
			message: giftRecipient
				? `${giftLabel(giftRecipient)} now has access to ${skill} on ${agent.name}. We've let them know.`
				: `${skill} is now part of your library on ${agent.name}.`,
			primaryHref: null,
			secondaryLabel: 'Done',
		});
	};

	setStatus('Waiting for payment on your phone…');
	const ok = await pollConfirm(purchase.reference, 300_000);
	if (ok) {
		await qrSuccess();
	} else {
		renderPaymentVerifyAgain({
			txid: null,
			message: 'No confirmation in 5 minutes. If you paid, re-verify below; otherwise the pending purchase will expire automatically.',
			retryFn: async () => {
				const ok2 = await pollConfirm(purchase.reference, 60_000);
				if (!ok2) throw new Error('Still no confirmation — give it another minute.');
				await qrSuccess();
			},
		});
	}
}
