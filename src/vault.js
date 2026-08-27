// /vault — browse, buy, unlock, and view encrypted 3D models gated by a
// BNB Chain purchase (prompt 12, BNB Chain campaign Track B).
//
// Wallet model (see src/bnb/vault-session.js's docstring for the full
// rationale): the vault's unlock key delivery is ECIES over secp256k1 —
// recovering the wrapped content key needs the buyer's RAW private key,
// which a browser-extension wallet (MetaMask) deliberately never exposes.
// So the actual "buyer" identity for buy() + the unlock signature + the
// client-side decrypt is a local session key (src/bnb/vault-session.js,
// same pattern src/agora/onchain-presence.js already established on this
// platform). MetaMask's ONLY role on the buy side is funding that session
// key with a plain native-token transfer. Sellers, by contrast, use a
// directly-connected MetaMask wallet (no ECIES involved in list()).
//
// Flow: browse (GET /list) -> select -> connect/fund session -> buy() on
// GreenfieldVault -> poll GET /status ("granting access on Greenfield…" is
// surfaced honestly, never hidden) -> POST /unlock -> unwrap the content key
// + download ciphertext (GET /download) -> decrypt client-side -> render in
// <model-viewer>.

import { escapeHtml as esc } from './shared/coin-format.js';
import {
	createPublicClient,
	createWalletClient,
	http,
	custom,
	formatEther,
	parseEther,
} from 'viem';
import {
	buildVaultUnlockMessage,
	generateUnlockNonce,
} from '../api/_lib/bnb/vault-unlock-message.js';
import {
	getVaultSessionAccount,
	getVaultSessionPrivateKey,
	resetVaultSession,
} from './bnb/vault-session.js';
import { quoteBuyRelayFee, sendBuyTx, sendListTx } from './bnb/vault-buy.js';
import { unwrapKey, decryptGlb } from './bnb/vault-crypto-browser.js';
import {
	deriveListingState,
	nextFlowStep,
	formatBnbAtomic,
	truncateAddress,
	pollDelayMs,
} from './vault-fsm.js';

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);

// Dev/E2E-proof escape hatches ONLY — mirror the server's own `?contractAddress=`
// override (api/vault/list.js) and `BNB_VAULT_RPC_OVERRIDE_TESTNET` (vault-contract.js).
// Unset in normal use; a real visitor's URL never carries these.
const DEV_RPC = qs.get('devRpc') || '';
const DEV_CONTRACT = qs.get('contractAddress') || '';

const BSC_TESTNET = {
	id: 97,
	name: 'BNB Smart Chain Testnet',
	nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 },
	rpcUrls: { default: { http: [DEV_RPC || 'https://data-seed-prebsc-1-s1.bnbchain.org:8545'] } },
	blockExplorers: { default: { name: 'BscScan', url: 'https://testnet.bscscan.com' } },
	testnet: true,
};

const NETWORK = 'testnet';
const POLL_ATTEMPTS_BEFORE_MANUAL = 12; // ~90s of bounded backoff before "still settling"

const state = {
	listings: [],
	listStatus: 'loading', // loading | ready | empty | error
	listError: null,
	contractAddress: null,
	contractDeployed: false,
	session: null, // { address, balance }
	detail: null, // { listing, flow, pollAttempt, glbBlobUrl, glbFilename }
	message: null, // { tone, text }
};

const publicClient = createPublicClient({
	chain: BSC_TESTNET,
	transport: http(undefined, { timeout: 10_000, retryCount: 2 }),
});

function apiUrl(path, extra = {}) {
	const u = new URL(path, location.origin);
	u.searchParams.set('network', NETWORK);
	if (DEV_CONTRACT) u.searchParams.set('contractAddress', DEV_CONTRACT);
	for (const [k, v] of Object.entries(extra)) if (v != null) u.searchParams.set(k, v);
	return u.toString();
}

const svgAlert =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>';

// ── Session (buyer identity) ────────────────────────────────────────────

async function refreshSessionBalance() {
	const account = getVaultSessionAccount();
	let balance = state.session?.balance ?? 0n;
	try {
		balance = await publicClient.getBalance({ address: account.address });
	} catch {
		/* RPC hiccup — keep the last known balance rather than showing 0 */
	}
	state.session = { address: account.address, balance };
	$('vlt-session-addr').textContent = truncateAddress(account.address);
	$('vlt-session-addr').title = account.address;
	$('vlt-session-balance').textContent = `${formatEther(balance)} tBNB`;
}

/** Write an in-page status line into the fund panel (never a native alert/prompt). */
function fundNote(text, tone = 'info') {
	const el = $('vlt-fund-note');
	if (!el) return;
	el.dataset.tone = tone;
	el.innerHTML = text;
}

function setFundPanelOpen(open) {
	const panel = $('vlt-fund-panel');
	const toggle = $('vlt-fund-btn');
	if (!panel || !toggle) return;
	panel.hidden = !open;
	toggle.setAttribute('aria-expanded', String(open));
	if (open) {
		if (!window.ethereum) {
			fundNote(
				`No browser wallet detected. Install one, or send tBNB to your session address from any BSC testnet wallet or faucet: <code>${esc(state.session?.address || '')}</code>`,
				'info',
			);
		} else if ($('vlt-fund-note').textContent.trim() === '') {
			fundNote('Your wallet will ask you to confirm a plain tBNB transfer to your session address.');
		}
		$('vlt-fund-amount')?.focus();
	}
}

/** Copy the session address so a visitor can fund it from a faucet or any other wallet. */
async function copySessionAddress() {
	const addr = state.session?.address;
	if (!addr) return;
	const btn = $('vlt-copy-btn');
	const prev = btn.textContent;
	try {
		await navigator.clipboard.writeText(addr);
		btn.textContent = 'Copied';
	} catch {
		// Clipboard is permission-gated (and absent over plain http): fall back to
		// showing the address in full so it can still be selected by hand.
		fundNote(`Copy your session address by hand: <code>${esc(addr)}</code>`, 'info');
		btn.textContent = 'Shown below';
	}
	setTimeout(() => {
		btn.textContent = prev;
	}, 1600);
}

/**
 * Two-step, in-page reset of the buyer session key. Destructive (a new key
 * cannot unlock anything the old one bought, and cannot spend its tBNB), so
 * the first click arms the warning and only the second click acts.
 */
function resetSessionKey() {
	const btn = $('vlt-reset-btn');
	if (btn.dataset.armed !== 'true') {
		btn.dataset.armed = 'true';
		btn.textContent = 'Confirm new key';
		fundNote(
			'A new session key cannot unlock models the current key bought, and cannot spend the tBNB sitting in it. Click again to confirm.',
			'error',
		);
		clearTimeout(resetSessionKey.timer);
		resetSessionKey.timer = setTimeout(() => {
			btn.dataset.armed = 'false';
			btn.textContent = 'New session key';
		}, 8000);
		return;
	}
	clearTimeout(resetSessionKey.timer);
	btn.dataset.armed = 'false';
	btn.textContent = 'New session key';
	resetVaultSession();
	refreshSessionBalance();
	fundNote('New session key minted. Fund it before buying.', 'success');
}

/** Connect MetaMask (or any EIP-1193 injected wallet) purely to fund the session key with a plain native-token transfer. */
async function fundSessionFromWallet() {
	// Validate the field before the wallet check, so a bad amount is reported as
	// a bad amount even on a machine with no injected wallet at all.
	const amountStr = ($('vlt-fund-amount')?.value || '').trim();
	if (!amountStr) {
		fundNote('Enter how much tBNB to send, for example 0.02', 'error');
		$('vlt-fund-amount')?.focus();
		return;
	}
	let amount;
	try {
		amount = parseEther(amountStr);
	} catch {
		fundNote('Enter a valid tBNB amount, for example 0.02', 'error');
		$('vlt-fund-amount')?.focus();
		return;
	}
	if (amount <= 0n) {
		fundNote('Enter an amount greater than zero.', 'error');
		$('vlt-fund-amount')?.focus();
		return;
	}
	if (!window.ethereum) {
		fundNote(
			`No browser wallet detected. Send tBNB to your session address from any BSC testnet wallet or faucet: <code>${esc(state.session?.address || '')}</code>`,
			'error',
		);
		return;
	}
	const btn = $('vlt-fund-send');
	const prevLabel = btn.textContent;
	btn.disabled = true;
	btn.textContent = 'Confirm in wallet…';
	fundNote('Waiting for your wallet to confirm the transfer…');
	try {
		const walletClient = createWalletClient({
			chain: BSC_TESTNET,
			transport: custom(window.ethereum),
		});
		const [from] = await walletClient.requestAddresses();
		try {
			await walletClient.switchChain({ id: BSC_TESTNET.id });
		} catch (switchErr) {
			if (
				switchErr?.code === 4902 ||
				/Unrecognized chain/i.test(String(switchErr?.message))
			) {
				await walletClient.addChain({ chain: BSC_TESTNET });
				await walletClient.switchChain({ id: BSC_TESTNET.id });
			} else {
				throw switchErr;
			}
		}
		const hash = await walletClient.sendTransaction({
			account: from,
			chain: BSC_TESTNET,
			to: state.session.address,
			value: amount,
		});
		btn.textContent = 'Confirming…';
		fundNote(`Transfer submitted (${esc(truncateAddress(hash))}). Waiting for confirmation…`);
		await publicClient.waitForTransactionReceipt({ hash });
		await refreshSessionBalance();
		fundNote(`Session funded with ${esc(formatEther(amount))} tBNB.`, 'success');
	} catch (err) {
		fundNote(
			`Funding failed: ${esc(err?.shortMessage || err?.message || 'the wallet rejected the transaction')}`,
			'error',
		);
	} finally {
		btn.disabled = false;
		btn.textContent = prevLabel;
	}
}

// ── Browse ───────────────────────────────────────────────────────────────

function renderBanner() {
	const el = $('vlt-banner-slot');
	if (state.contractDeployed !== false || state.listStatus === 'loading') {
		el.innerHTML = '';
		return;
	}
	el.innerHTML = `<div class="vlt-banner" role="status">${svgAlert}<p><strong>The GreenfieldVault contract isn't deployed on this network yet.</strong> Nothing can be bought or listed until it is. This page shows that plainly rather than faking an empty catalogue. <a href="/bnb">See what this vault does</a>.</p></div>`;
}

async function loadListings() {
	state.listStatus = 'loading';
	renderGrid();
	try {
		const res = await fetch(apiUrl('/api/vault/list'), {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(10000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const body = await res.json();
		state.contractAddress = body.contractAddress;
		state.contractDeployed = body.contractDeployed;
		state.listings = body.listings || [];
		state.listStatus = state.listings.length ? 'ready' : 'empty';
	} catch (err) {
		state.listStatus = 'error';
		state.listError = err.message;
	}
	renderBanner();
	renderGrid();
}

function listingCard(listing) {
	const name = listing.glbObjectRef?.object?.split('/').pop() || 'Untitled model';
	return `
		<button type="button" class="vlt-card" data-object-id="${esc(listing.objectId)}">
			<div class="vlt-card-art" aria-hidden="true">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 2 3 7v10l9 5 9-5V7l-9-5Z" /><path d="M3 7l9 5 9-5M12 12v10" /></svg>
			</div>
			<div class="vlt-card-body">
				<div class="vlt-card-title" title="${esc(name)}">${esc(name)}</div>
				<div class="vlt-card-row"><span class="vlt-card-price">${esc(formatBnbAtomic(listing.priceAtomic))}</span><span class="vlt-badge" data-state="locked">Locked</span></div>
				<div class="vlt-card-row">Seller <code>${esc(truncateAddress(listing.seller))}</code></div>
			</div>
		</button>
	`;
}

function renderGrid() {
	const el = $('vlt-grid');
	if (state.listStatus === 'loading') {
		el.innerHTML = Array.from({ length: 6 })
			.map(() => '<div class="vlt-skel" aria-hidden="true"></div>')
			.join('');
		return;
	}
	if (state.listStatus === 'error') {
		el.innerHTML = `<div class="vlt-error" role="alert">${svgAlert}<h3>Couldn't load vault listings</h3><p>${esc(state.listError || 'the API is unreachable')}</p><div class="vlt-state-actions"><button type="button" class="vlt-btn vlt-btn-primary" id="vlt-error-retry">Try again</button><a class="vlt-btn" href="/bnb">What this vault does</a></div></div>`;
		$('vlt-error-retry')?.addEventListener('click', loadListings);
		return;
	}
	if (state.listStatus === 'empty') {
		const actions = state.contractDeployed
			? '<button type="button" class="vlt-btn vlt-btn-primary" id="vlt-empty-sell">List a model</button><a class="vlt-btn" href="/create">Make one first</a>'
			: '<button type="button" class="vlt-btn" id="vlt-error-retry">Check again</button><a class="vlt-btn" href="/bnb">What this vault does</a>';
		el.innerHTML = `<div class="vlt-empty">${svgAlert}<h3>${state.contractDeployed ? 'No models listed yet' : 'Nothing to browse yet'}</h3><p>${
			state.contractDeployed
				? 'Be the first seller: encrypt a GLB, upload it to Greenfield, and list it on the vault contract.'
				: 'Once the vault contract is deployed and a seller lists a model, it shows up here automatically.'
		}</p><div class="vlt-state-actions">${actions}</div></div>`;
		$('vlt-error-retry')?.addEventListener('click', loadListings);
		$('vlt-empty-sell')?.addEventListener('click', openSellPanel);
		return;
	}
	el.innerHTML = state.listings.map(listingCard).join('');
	el.querySelectorAll('[data-object-id]').forEach((card) =>
		card.addEventListener('click', () => {
			const listing = state.listings.find((l) => l.objectId === card.dataset.objectId);
			if (listing) openDetail(listing, card);
		}),
	);
}

// ── Detail drawer: buy → settle → unlock → view ─────────────────────────

const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** Visible, focusable elements inside the open drawer, in DOM order. */
function drawerFocusables() {
	return [...$('vlt-drawer').querySelectorAll(FOCUSABLE)].filter(
		(el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement,
	);
}

/** Keep Tab inside the modal drawer instead of letting it walk the page behind it. */
function trapDrawerTab(e) {
	if (e.key !== 'Tab' || $('vlt-drawer').dataset.open !== 'true') return;
	const items = drawerFocusables();
	if (!items.length) return;
	const first = items[0];
	const last = items[items.length - 1];
	const active = document.activeElement;
	if (e.shiftKey && (active === first || !$('vlt-drawer').contains(active))) {
		e.preventDefault();
		last.focus();
	} else if (!e.shiftKey && (active === last || !$('vlt-drawer').contains(active))) {
		e.preventDefault();
		first.focus();
	}
}

function openDrawer(opener) {
	state.drawerOpener = opener || null;
	$('vlt-backdrop').dataset.open = 'true';
	$('vlt-drawer').dataset.open = 'true';
	$('vlt-drawer').setAttribute('aria-hidden', 'false');
	$('vlt-drawer-close').focus();
}

function closeDrawer() {
	if ($('vlt-drawer').dataset.open !== 'true') return;
	stopPolling();
	$('vlt-backdrop').dataset.open = 'false';
	$('vlt-drawer').dataset.open = 'false';
	$('vlt-drawer').setAttribute('aria-hidden', 'true');
	if (state.detail?.glbBlobUrl) URL.revokeObjectURL(state.detail.glbBlobUrl);
	state.detail = null;
	// Return focus to whatever opened the drawer, so a keyboard user lands back
	// on the card they were reading rather than at the top of the document.
	const opener = state.drawerOpener;
	state.drawerOpener = null;
	if (opener?.isConnected) opener.focus();
	else $('vlt-refresh-btn')?.focus();
}

function stopPolling() {
	if (state.detail?.pollTimer) clearTimeout(state.detail.pollTimer);
	if (state.detail) state.detail.pollTimer = null;
}

async function openDetail(listing, opener) {
	state.detail = {
		listing,
		// Not 'available' yet: the real answer comes from GET /api/vault/status,
		// so the drawer opens in a checking state instead of flashing a Buy
		// button for something this session may already own.
		flow: 'checking',
		pollAttempt: 0,
		glbBlobUrl: null,
		glbFilename: null,
		note: null,
		noteTone: 'info',
	};
	$('vlt-drawer-title').textContent = listing.glbObjectRef?.object?.split('/').pop() || 'Model';
	openDrawer(opener);
	renderDetail();
	await refreshSessionBalance();
	await refreshStatus();
}

async function refreshStatus() {
	const d = state.detail;
	if (!d) return;
	try {
		const res = await fetch(
			apiUrl('/api/vault/status', {
				objectId: d.listing.objectId,
				buyer: state.session.address,
			}),
			{
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(10000),
			},
		);
		const body = await res.json();
		if (!res.ok) throw new Error(body?.message || `HTTP ${res.status}`);
		const derived = deriveListingState({
			contractDeployed: body.contractDeployed,
			listingActive: body.listing?.active,
			saleId: body.saleId,
			saleStatus: body.saleStatus,
		});
		const step = nextFlowStep({
			walletConnected: true,
			listingState: derived,
			hasDecrypted: !!d.glbBlobUrl,
		});
		d.flow = step === 'buy' ? 'available' : step;
		// A recovered read clears its own stale failure note but leaves any note
		// the buy flow put there (the tx hash, "granting access…") intact.
		if (d.statusFailed) d.note = null;
		d.statusFailed = false;
		if (d.flow === 'pending-grant') schedulePoll();
		else stopPolling();
	} catch (err) {
		stopPolling();
		d.statusFailed = true;
		d.note = `Couldn't read purchase status: ${err.message}`;
		d.noteTone = 'error';
	}
	renderDetail();
}

function schedulePoll() {
	const d = state.detail;
	if (!d) return;
	stopPolling();
	if (d.pollAttempt >= POLL_ATTEMPTS_BEFORE_MANUAL) {
		renderDetail(); // shows the "still settling — check back" manual-refresh state
		return;
	}
	d.pollTimer = setTimeout(() => {
		if (state.detail !== d) return; // drawer closed, or reopened on another listing
		d.pollAttempt += 1;
		refreshStatus();
	}, pollDelayMs(d.pollAttempt));
}

async function buyListing() {
	const d = state.detail;
	if (!d) return;
	d.note = 'Preparing purchase…';
	d.noteTone = 'info';
	renderDetail();
	try {
		const account = getVaultSessionAccount();
		const priceAtomic = BigInt(d.listing.priceAtomic);
		const { total: relayFeeTotal } = await quoteBuyRelayFee(NETWORK, state.contractAddress, {
			client: publicClient,
		});
		const needed = priceAtomic + relayFeeTotal;
		if (state.session.balance < needed) {
			d.note = `Session needs ${formatEther(needed)} tBNB (price + relay fee) — currently has ${formatEther(state.session.balance)}. Fund it above first.`;
			d.noteTone = 'error';
			renderDetail();
			return;
		}
		d.note = 'Confirming purchase on-chain…';
		renderDetail();
		const { hash, mode } = await sendBuyTx(
			{
				account,
				network: NETWORK,
				contractAddress: state.contractAddress,
				objectId: d.listing.objectId,
				priceAtomic,
			},
			{ publicClient },
		);
		d.note = `Purchase tx ${mode === 'sponsored' ? '(gasless via MegaFuel) ' : ''}submitted: ${truncateAddress(hash)} — waiting for confirmation…`;
		renderDetail();
		await publicClient.waitForTransactionReceipt({ hash });
		d.flow = 'pending-grant';
		d.note = 'Purchase confirmed on-chain. Granting access on Greenfield…';
		d.noteTone = 'success';
		d.pollAttempt = 0;
		renderDetail();
		await refreshSessionBalance();
		schedulePoll();
	} catch (err) {
		d.note = `Purchase failed: ${err?.shortMessage || err?.message || 'wallet rejected the transaction'}`;
		d.noteTone = 'error';
		renderDetail();
	}
}

async function unlockAndView() {
	const d = state.detail;
	if (!d) return;
	d.note = 'Signing unlock request…';
	d.noteTone = 'info';
	renderDetail();
	try {
		const account = getVaultSessionAccount();
		const message = buildVaultUnlockMessage({
			objectId: d.listing.objectId,
			buyer: account.address,
			network: NETWORK,
			nonce: generateUnlockNonce(),
			issuedAt: new Date().toISOString(),
		});
		const signature = await account.signMessage({ message });

		d.note = 'Verifying purchase and fetching your wrapped key…';
		renderDetail();
		const res = await fetch('/api/vault/unlock', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				objectId: d.listing.objectId,
				buyer: account.address,
				network: NETWORK,
				message,
				signature,
			}),
			signal: AbortSignal.timeout(15000),
		});
		const body = await res.json();
		if (!res.ok) throw new Error(body?.message || `HTTP ${res.status}`);
		if (body.state === 'pending-grant') {
			d.note = body.pollHint || 'Still settling — try again shortly.';
			d.noteTone = 'info';
			d.flow = 'pending-grant';
			renderDetail();
			schedulePoll();
			return;
		}

		d.note = 'Unwrapping content key…';
		renderDetail();
		const contentKey = await unwrapKey(body.wrappedKey, getVaultSessionPrivateKey());

		d.note = 'Downloading encrypted model…';
		renderDetail();
		const dl = await fetch(
			`/api/vault/download?objectId=${d.listing.objectId}&network=${NETWORK}&buyer=${account.address}&token=${encodeURIComponent(body.downloadToken)}`,
			{ signal: AbortSignal.timeout(60000) },
		);
		if (!dl.ok) {
			const errBody = await dl.json().catch(() => ({}));
			throw new Error(errBody?.message || `download failed (HTTP ${dl.status})`);
		}
		const ciphertext = new Uint8Array(await dl.arrayBuffer());

		d.note = 'Decrypting…';
		renderDetail();
		const plaintext = await decryptGlb(
			{
				ciphertext,
				contentKey,
				iv: body.manifest?.encryption?.iv,
				authTag: body.manifest?.encryption?.authTag,
			},
			{ expectedSha256: body.manifest?.sha256 },
		);

		const blob = new Blob([plaintext], { type: 'model/gltf-binary' });
		d.glbBlobUrl = URL.createObjectURL(blob);
		d.glbFilename = (d.listing.glbObjectRef?.object || 'vault-model').split('/').pop();
		d.flow = 'viewing';
		d.note = 'Unlocked — model decrypted and sha256-verified locally.';
		d.noteTone = 'success';
		renderDetail();
	} catch (err) {
		d.note = `Unlock failed: ${err.message || 'unknown error'} — likely the wrong key or corrupted ciphertext.`;
		d.noteTone = 'error';
		renderDetail();
	}
}

const STEP_LABELS = [
	{ key: 'buy', label: 'Purchase confirmed on-chain' },
	{ key: 'grant', label: 'Greenfield permission granted' },
	{ key: 'unlock', label: 'Key unwrapped & model decrypted' },
];

function stepState(stepKey, flow) {
	const order = { checking: 0, available: 0, pending: 0, 'pending-grant': 1, unlocked: 2, viewing: 3 };
	const idx = order[flow] ?? 0;
	const target = { buy: 1, grant: 2, unlock: 3 }[stepKey];
	if (idx >= target) return 'done';
	if (idx === target - 1) return 'active';
	return 'pending';
}

function renderDetail() {
	const d = state.detail;
	const el = $('vlt-drawer-body');
	if (!d || !el) return;

	const progressHtml = `<div class="vlt-progress">${STEP_LABELS.map(
		(s) =>
			`<div class="vlt-step" data-state="${stepState(s.key, d.flow)}"><span class="vlt-step-dot" aria-hidden="true"></span>${esc(s.label)}</div>`,
	).join('')}</div>`;

	let actionHtml = '';
	let viewerHtml = '';
	if (d.flow === 'checking') {
		actionHtml = d.statusFailed
			? `<button type="button" class="vlt-btn vlt-btn-primary" id="vlt-refresh-detail-btn">Try again</button>`
			: `<button type="button" class="vlt-btn" disabled>Checking purchase status…</button>`;
	} else if (d.flow === 'available') {
		actionHtml = `<button type="button" class="vlt-btn vlt-btn-primary" id="vlt-buy-btn">Buy for ${esc(formatBnbAtomic(d.listing.priceAtomic))} (+ relay fee)</button>`;
	} else if (d.flow === 'pending-grant') {
		const stuck = d.pollAttempt >= POLL_ATTEMPTS_BEFORE_MANUAL;
		actionHtml = stuck
			? `<button type="button" class="vlt-btn" id="vlt-refresh-detail-btn">Check again</button>`
			: `<button type="button" class="vlt-btn" disabled>Granting access…</button>`;
	} else if (d.flow === 'unlocked') {
		actionHtml = `<button type="button" class="vlt-btn vlt-btn-primary" id="vlt-unlock-btn">Unlock &amp; view</button>`;
	} else if (d.flow === 'viewing') {
		actionHtml = `<a class="vlt-btn vlt-btn-primary" id="vlt-download-btn" download="${esc(d.glbFilename || 'model.glb')}" href="${d.glbBlobUrl}">Download GLB</a>`;
		viewerHtml = `<model-viewer id="vlt-viewer" src="${d.glbBlobUrl}" camera-controls auto-rotate shadow-intensity="1" alt="Unlocked 3D model"></model-viewer>`;
	} else if (d.flow === 'unlisted') {
		actionHtml = `<p class="vlt-drawer-note">This listing is no longer active.</p>`;
	}

	el.innerHTML = `
		${viewerHtml}
		<div class="vlt-detail-meta">
			<div class="vlt-detail-row"><span>Price</span><b>${esc(formatBnbAtomic(d.listing.priceAtomic))}</b></div>
			<div class="vlt-detail-row"><span>Seller</span><code>${esc(truncateAddress(d.listing.seller))}</code></div>
			${d.listing.sha256 ? `<div class="vlt-detail-row"><span>sha256</span><code>${esc(d.listing.sha256.slice(0, 16))}…</code></div>` : ''}
		</div>
		${progressHtml}
		<div class="vlt-drawer-actions">
			${actionHtml}
			${d.note ? `<p class="vlt-drawer-note" data-tone="${d.noteTone || 'info'}">${esc(d.note)}</p>` : ''}
		</div>
	`;
	$('vlt-buy-btn')?.addEventListener('click', buyListing);
	$('vlt-unlock-btn')?.addEventListener('click', unlockAndView);
	$('vlt-refresh-detail-btn')?.addEventListener('click', () => {
		d.pollAttempt = 0;
		refreshStatus();
	});
}

// ── Sell panel ───────────────────────────────────────────────────────────

function sellLog(text) {
	const el = $('vlt-sell-log');
	el.hidden = false;
	el.textContent += (el.textContent ? '\n' : '') + text;
	el.scrollTop = el.scrollHeight;
}

/** Expand the "Sell a model" drawer and put the cursor in its first field. */
function openSellPanel() {
	const details = $('vlt-sell');
	if (!details) return;
	details.open = true;
	details.scrollIntoView({ behavior: 'smooth', block: 'center' });
	$('vlt-sell-url')?.focus();
}

async function connectAndList() {
	const glbUrl = $('vlt-sell-url').value.trim();
	const priceStr = $('vlt-sell-price').value.trim();
	$('vlt-sell-log').textContent = '';
	if (!glbUrl || !priceStr) {
		sellLog('Enter a GLB URL and a price first.');
		(glbUrl ? $('vlt-sell-price') : $('vlt-sell-url')).focus();
		return;
	}
	if (!window.ethereum) {
		sellLog('No browser wallet detected. Install one to sign the listing transaction.');
		return;
	}
	let priceWei;
	try {
		priceWei = parseEther(priceStr);
	} catch {
		sellLog('Enter a valid tBNB price, for example 0.01');
		$('vlt-sell-price').focus();
		return;
	}
	if (priceWei <= 0n) {
		sellLog('Enter a price greater than zero.');
		$('vlt-sell-price').focus();
		return;
	}
	const btn = $('vlt-sell-connect');
	btn.disabled = true;
	try {
		const walletClient = createWalletClient({
			chain: BSC_TESTNET,
			transport: custom(window.ethereum),
		});
		const [seller] = await walletClient.requestAddresses();
		sellLog(`Connected: ${seller}`);
		try {
			await walletClient.switchChain({ id: BSC_TESTNET.id });
		} catch (switchErr) {
			if (switchErr?.code === 4902) {
				await walletClient.addChain({ chain: BSC_TESTNET });
				await walletClient.switchChain({ id: BSC_TESTNET.id });
			} else throw switchErr;
		}

		sellLog('Uploading + encrypting GLB on Greenfield…');
		const upRes = await fetch('/api/bnb/vault-upload', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				glbUrl,
				sellerAddress: seller,
				priceAtomic: priceWei.toString(),
				network: NETWORK,
			}),
			signal: AbortSignal.timeout(60000),
		});
		const upBody = await upRes.json();
		if (!upRes.ok) throw new Error(upBody?.message || `upload failed (HTTP ${upRes.status})`);
		sellLog(`Uploaded — objectId ${upBody.objectId}`);

		if (!state.contractDeployed) {
			sellLog(
				'GreenfieldVault is not deployed on this network yet — the object is encrypted and stored, but cannot be listed until deploy funding lands.',
			);
			return;
		}

		sellLog('Listing on GreenfieldVault…');
		const hash = await sendListTx(
			walletClient,
			state.contractAddress,
			upBody.objectId,
			priceWei,
			seller,
		);
		sellLog(`list() submitted: ${hash} — waiting for confirmation…`);
		await publicClient.waitForTransactionReceipt({ hash });
		sellLog('Listed. Refreshing the grid…');
		await loadListings();
	} catch (err) {
		sellLog(`Failed: ${err?.shortMessage || err?.message || String(err)}`);
	} finally {
		btn.disabled = false;
	}
}

// ── Boot ─────────────────────────────────────────────────────────────────

function init() {
	$('vlt-fund-btn')?.addEventListener('click', () =>
		setFundPanelOpen($('vlt-fund-panel').hidden),
	);
	$('vlt-fund-cancel')?.addEventListener('click', () => {
		setFundPanelOpen(false);
		$('vlt-fund-btn')?.focus();
	});
	$('vlt-fund-send')?.addEventListener('click', fundSessionFromWallet);
	$('vlt-fund-amount')?.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') fundSessionFromWallet();
	});
	$('vlt-copy-btn')?.addEventListener('click', copySessionAddress);
	$('vlt-reset-btn')?.addEventListener('click', resetSessionKey);
	$('vlt-refresh-btn')?.addEventListener('click', loadListings);
	$('vlt-drawer-close')?.addEventListener('click', closeDrawer);
	$('vlt-backdrop')?.addEventListener('click', closeDrawer);
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && $('vlt-drawer').dataset.open === 'true') closeDrawer();
		else trapDrawerTab(e);
	});
	$('vlt-sell-connect')?.addEventListener('click', connectAndList);
	refreshSessionBalance();
	loadListings();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
