// Agent Economy: two 3D AI agents transacting on-chain.
//
// Nova (buyer, left) picks a service from Oracle's catalog, pays real SOL,
// and Oracle delivers the analysis. Every transaction is real: a live Solana
// wallet sends lamports, the tx signature links to a Solana explorer.
//
// Architecture:
//   - Two <agent-3d> avatars loaded into iframes (the existing embed pattern).
//   - A POST to /api/agent-economy/transact triggers the real payment + LLM
//     delivery on the server. No x402 client lib needed in the browser: the
//     server signs with AVATAR_WALLET_SECRET.
//   - Speech bubbles + avatar animations driven by postMessage to each iframe.
//   - A payment particle arc animates from buyer to seller on real tx confirmation.
//   - /api/agent-economy/status polled on load to show live wallet balances.
//   - The tx feed in the center column is pure DOM, no framework.

import { buildReceiptHTML, buildReceiptText } from './shared/payment-receipt.js';
import { showAddFunds } from './shared/add-funds.js';
import { log } from './shared/log.js';

const $ = (id) => document.getElementById(id);

// ── Wallet status ─────────────────────────────────────────────────────────────
// Fetched on load; re-fetched after each trade to show updated balances.
// Kept in module scope so the "Add funds" handler can read the agent address.
let currentWalletStatus = null;

async function fetchWalletStatus() {
	try {
		const res = await fetch('/api/agent-economy/status');
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

function renderBal(elId, info) {
	const el = $(elId);
	if (!el) return;
	if (!info || !info.configured) {
		el.className = 'av-label-bal bal-unknown';
		el.textContent = 'wallet not set';
		return;
	}
	const sol = typeof info.sol === 'number' ? info.sol : null;
	if (sol === null) {
		// Configured wallet, unreadable balance: say so rather than showing a
		// dash the reader has to guess at.
		el.className = 'av-label-bal bal-unknown';
		el.textContent = 'balance unavailable';
		return;
	}
	const usdStr = info.usd != null ? ` · $${info.usd.toFixed(2)}` : '';
	el.className = `av-label-bal ${sol > 0.0001 ? 'bal-funded' : 'bal-empty'}`;
	el.textContent = `${sol.toFixed(5)} SOL${usdStr}`;
}

function renderFundAlert(status) {
	const el = $('fund-alert');
	if (!el) return;
	const aOk = status?.agentA?.configured && (status.agentA.sol ?? 0) > 0.001;
	const aCfg = status?.agentA?.configured;
	if (aOk) { el.classList.remove('visible'); return; }
	let html = '';
	if (!aCfg) {
		// Technical detail (env var name) goes to console only
		log.info('[three.ws] agent-economy: AVATAR_WALLET_SECRET not configured');
		html = '<strong>Live transactions are paused.</strong> This feature is temporarily unavailable. Check back shortly.';
	} else {
		const addr = status.agentA.address;
		const exp = status.agentA.explorer || `https://solscan.io/account/${addr}`;
		html = `<strong>Nova needs a small amount of SOL to transact.</strong> Fund her wallet to get started:
			<span class="fund-addr">${escHtml(addr)} <a href="${escHtml(exp)}" target="_blank" rel="noopener">↗ Solscan</a></span>
			<button class="fund-alert-btn" type="button" data-addr="${escHtml(addr)}">Add funds →</button>`;
	}
	el.innerHTML = html;
	el.classList.add('visible');

	el.querySelector('.fund-alert-btn')?.addEventListener('click', (e) => {
		const addr = e.currentTarget.dataset.addr;
		// Nova pays in native lamports, so the onramp has to deliver SOL. Funding
		// her with USDC would leave her exactly as unable to transact as before.
		if (addr) showAddFunds({ walletAddress: addr, asset: 'SOL' }).then(() => refreshWalletStatus());
	});
}

// The status read failing left both balance chips spinning forever and the
// addresses on their em-dash placeholder: a permanent loading state with no way
// out. Say what happened and offer the retry instead.
function renderStatusUnavailable() {
	for (const id of ['buyer-bal', 'seller-bal']) {
		const el = $(id);
		if (!el) continue;
		el.className = 'av-label-bal bal-unknown';
		el.textContent = 'balance unavailable';
	}
	const el = $('fund-alert');
	if (!el) return;
	el.innerHTML = `<strong>Live wallet balances are unavailable.</strong> They could not be read just now. You can still request a service.
		<button class="fund-alert-btn" type="button" data-retry-status="1">Retry</button>`;
	el.classList.add('visible');
	el.querySelector('[data-retry-status]')?.addEventListener('click', (e) => {
		e.currentTarget.disabled = true;
		for (const id of ['buyer-bal', 'seller-bal']) {
			const chip = $(id);
			if (chip) { chip.className = 'av-label-bal bal-unknown'; chip.innerHTML = '<span class="bal-spin"></span>'; }
		}
		refreshWalletStatus();
	});
}

async function refreshWalletStatus() {
	const status = await fetchWalletStatus();
	if (!status) { renderStatusUnavailable(); return; }
	currentWalletStatus = status;
	renderBal('buyer-bal', status.agentA);
	renderBal('seller-bal', status.agentB);
	renderFundAlert(status);
	if (status.agentA?.address) renderAddr('buyer-addr', status.agentA.address, status.agentA.explorer);
	if (status.agentB?.address) renderAddr('seller-addr', status.agentB.address, status.agentB.explorer);
}

// ── Payment particle ──────────────────────────────────────────────────────────
function firePaymentParticle() {
	const root = $('root');
	const buyer = document.getElementById('col-buyer');
	const seller = document.getElementById('col-seller');
	if (!root || !buyer || !seller) return;

	const rootRect  = root.getBoundingClientRect();
	const buyerRect = buyer.getBoundingClientRect();
	const sellerRect = seller.getBoundingClientRect();

	const startX = buyerRect.left  + buyerRect.width  / 2 - rootRect.left;
	const startY = buyerRect.top   + buyerRect.height / 2 - rootRect.top;
	const endX   = sellerRect.left + sellerRect.width / 2 - rootRect.left;
	const dx     = endX - startX;

	const p = document.createElement('div');
	p.className = 'pay-particle';
	p.style.left = `${startX}px`;
	p.style.top  = `${startY}px`;
	p.style.setProperty('--tx-full', `${dx}px`);
	p.style.setProperty('--tx-half', `${dx / 2}px`);
	root.appendChild(p);

	// Trigger reflow then start animation.
	p.getBoundingClientRect();
	p.classList.add('arc');
	setTimeout(() => p.remove(), 1000);
}

// ── Avatar frames ─────────────────────────────────────────────────────────────
const frameBuyer  = $('frame-buyer');
const frameSeller = $('frame-seller');
const colBuyer    = $('col-buyer');
const colSeller   = $('col-seller');

const BUYER_GLB  = '/avatars/default.glb';
// Use a slightly different tint for the seller so they look distinct.
const SELLER_GLB = '/avatars/cz.glb';

// Track readiness: iframes fire v1.avatar.ready when the 3D scene is live.
let buyerReady  = false;
let sellerReady = false;
const buyerQueue  = [];
const sellerQueue = [];

function postToAvatar(frame, queue, ready, msg) {
	if (ready) frame.contentWindow?.postMessage(msg, location.origin);
	else queue.push(msg);
}

function buyerSay(text)  { postToAvatar(frameBuyer,  buyerQueue,  buyerReady,  { type: 'v1.avatar.speak', text }); }
function sellerSay(text) { postToAvatar(frameSeller, sellerQueue, sellerReady, { type: 'v1.avatar.speak', text }); }
function buyerAnim(name) { postToAvatar(frameBuyer,  buyerQueue,  buyerReady,  { type: 'v1.avatar.animation', name }); }
function sellerAnim(name){ postToAvatar(frameSeller, sellerQueue, sellerReady, { type: 'v1.avatar.animation', name }); }

window.addEventListener('message', (e) => {
	if (e.data?.type !== 'v1.avatar.ready') return;
	if (e.source === frameBuyer.contentWindow) {
		buyerReady = true;
		$('loading-buyer').classList.add('gone');
		buyerQueue.forEach((m) => frameBuyer.contentWindow?.postMessage(m, location.origin));
		buyerQueue.length = 0;
		buyerSay('Ready to transact. Browsing Oracle\'s catalog now.');
	} else if (e.source === frameSeller.contentWindow) {
		sellerReady = true;
		$('loading-seller').classList.add('gone');
		sellerQueue.forEach((m) => frameSeller.contentWindow?.postMessage(m, location.origin));
		sellerQueue.length = 0;
		sellerSay('Open for business. Services start at $0.001.');
	}
});

// Build the embed URL for each avatar (same pattern as demo-economy.html).
function avatarUrl(glb) {
	const q = new URLSearchParams({ model: glb, brain: '/api/chat', 'hide-chrome': '1', kiosk: '1', eager: '1' });
	return `/a-embed?${q}`;
}

frameBuyer.src  = avatarUrl(BUYER_GLB);
frameSeller.src = avatarUrl(SELLER_GLB);

// Load wallet status immediately — updates balance chips and fund alert.
refreshWalletStatus();

// ── Speech bubbles ────────────────────────────────────────────────────────────
const speechBuyer  = $('speech-buyer');
const speechSeller = $('speech-seller');
const speechTimers = { buyer: null, seller: null };

function showSpeech(el, text, key, ms = 6000) {
	clearTimeout(speechTimers[key]);
	el.textContent = text;
	el.classList.add('visible');
	speechTimers[key] = setTimeout(() => el.classList.remove('visible'), ms);
}

// ── Status bar ────────────────────────────────────────────────────────────────
function setStatus(text) { $('status-text').textContent = text; }

// ── Transaction feed ──────────────────────────────────────────────────────────
let txCount = 0;

function addFeedItem({ icon, type, title, sub, time }) {
	const empty = $('feed-empty');
	if (empty) empty.remove();
	txCount++;
	$('tx-count').textContent = `${txCount} tx`;

	const now = time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	const item = document.createElement('div');
	item.className = `tx-item tx-${type}`;
	item.innerHTML = `
		<div class="tx-icon">${icon}</div>
		<div class="tx-body">
			<div class="tx-title">${escHtml(title)}</div>
			<div class="tx-sub">${sub}</div>
		</div>
		<div class="tx-time">${escHtml(now)}</div>`;
	const feed = $('feed');
	feed.prepend(item);
	return item;
}

function escHtml(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// ── Service buttons ───────────────────────────────────────────────────────────
let busy = false;

document.querySelectorAll('.svc-btn').forEach((btn) => {
	btn.addEventListener('click', () => {
		if (busy) return;
		purchase(btn.dataset.service);
	});
});

function setButtons(disabled) {
	document.querySelectorAll('.svc-btn').forEach((b) => (b.disabled = disabled));
}

// ── Wallet address display (from the API response) ────────────────────────────
function shortenAddr(addr) {
	if (!addr || addr.length < 10) return addr;
	return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function renderAddr(elId, addr, explorerUrl) {
	const el = $(elId);
	if (!el || !addr) return;
	el.innerHTML = explorerUrl
		? `<a href="${escHtml(explorerUrl)}" target="_blank" rel="noopener" title="${escHtml(addr)}">${escHtml(shortenAddr(addr))} ↗</a>`
		: escHtml(shortenAddr(addr));
}

// ── Purchase flow ─────────────────────────────────────────────────────────────
// A request that never reached the server leaves the page with nothing to show,
// so the failure row carries the retry: the reader should not have to guess that
// clicking the same catalog row again is the recovery.
function requestFailed(message, service) {
	setStatus(message);
	const row = addFeedItem({
		icon: '⚠️',
		type: 'pay',
		title: 'Request failed',
		sub: `${escHtml(message)} <button class="tx-retry-btn" type="button">Try again</button>`,
	});
	row?.querySelector('.tx-retry-btn')?.addEventListener('click', () => {
		if (busy) return;
		purchase(service);
	});
	busy = false;
	setButtons(false);
}

async function purchase(service) {
	if (busy) return;
	busy = true;
	setButtons(true);

	const topic = $('topic').value.trim() || null;
	const serviceNames = {
		'market-analysis': 'Market Analysis',
		'onchain-insight': 'On-Chain Insight',
		'risk-score': 'Risk Score',
	};
	const name = serviceNames[service] || service;

	setStatus(`Nova is requesting ${name}…`);
	showSpeech(speechBuyer, `Oracle, I need ${name}. Sending payment now.`, 'buyer', 7000);
	buyerAnim('idle');
	colBuyer.classList.add('paying');
	setTimeout(() => colBuyer.classList.remove('paying'), 600);
	buyerAnim('wave');

	addFeedItem({
		icon: '📡',
		type: 'pay',
		title: `Nova → Oracle: ${name}`,
		sub: topic ? `Topic: ${escHtml(topic)}` : 'Service request initiated',
	});

	const txStartTime = Date.now();
	let data;
	try {
		const res = await fetch('/api/agent-economy/transact', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			// Omit `topic` entirely when the field is empty. Sending `topic: null`
			// failed the endpoint's schema, so the page's most common path (click a
			// service, type nothing) answered 400 instead of transacting.
			body: JSON.stringify(topic ? { service, topic } : { service }),
		});
		// A gateway can answer a 502 with HTML, and res.json() throws on it. Read
		// the body once and parse defensively so an infrastructure hiccup reads as
		// "the service is unavailable", not as a bare parser error.
		const raw = await res.text();
		try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
		if (!res.ok || !data) {
			requestFailed(
				data?.error_description ||
					data?.error ||
					`The agent economy service is unavailable right now (HTTP ${res.status}). Try again in a moment.`,
				service,
			);
			return;
		}
	} catch (e) {
		// The raw fetch rejection ("Failed to fetch") told the reader nothing and
		// nothing to do about it. Keep the detail in the console.
		log.warn('[three.ws] agent-economy: transact request failed:', e.message);
		requestFailed('Could not reach the agent economy service. Check your connection and try again.', service);
		return;
	}

	const tx = data.transaction;

	// Update wallet address labels on first successful response
	if (tx?.buyerAddress)  renderAddr('buyer-addr',  tx.buyerAddress,  tx.buyerExplorerUrl);
	if (tx?.sellerAddress) renderAddr('seller-addr', tx.sellerAddress, tx.sellerExplorerUrl);

	// Nova speaks her request
	if (data.buyerSaid) {
		showSpeech(speechBuyer, data.buyerSaid, 'buyer', 7000);
		buyerSay(data.buyerSaid);
	}

	// Slight delay so Oracle "receives" the payment before responding
	await delay(900);

	// Transaction outcome
	if (tx?.signature) {
		// Real on-chain payment confirmed — fire the particle then flash the seller.
		firePaymentParticle();
		await delay(500);
		colSeller.classList.add('receiving');
		setTimeout(() => colSeller.classList.remove('receiving'), 600);

		const solStr = tx.solAmount ? `${tx.solAmount.toFixed(6)} SOL` : '';
		const usdStr = tx.usdAmount ? `$${tx.usdAmount.toFixed(4)} USD` : '';
		const amountStr = [solStr, usdStr].filter(Boolean).join(' · ');

		const receiptHtml = buildReceiptHTML({
			usdAmount: tx.usdAmount || null,
			recipientLabel: 'Oracle',
			elapsedMs: Date.now() - txStartTime,
			explorerUrl: tx.explorerUrl,
			signature: tx.signature,
		});
		addFeedItem({
			icon: '💸',
			type: 'pay',
			title: `Payment sent · ${amountStr}`,
			sub: receiptHtml,
		});
		setStatus(buildReceiptText({
			usdAmount: tx.usdAmount || null,
			recipientLabel: 'Oracle',
			elapsedMs: Date.now() - txStartTime,
		}));
	} else if (tx?.error === 'wallet_unconfigured') {
		// Log technical detail privately; never surface env-var names to users
		log.info('[three.ws] agent-economy: wallet_unconfigured:', tx.message);
		addFeedItem({
			icon: '⏸️',
			type: 'pay',
			title: 'Live transactions paused',
			sub: 'This feature is temporarily unavailable. Check back shortly.',
		});
		setStatus('Live transactions are temporarily unavailable');
	} else if (tx?.error === 'insufficient_balance') {
		const agentAddr = currentWalletStatus?.agentA?.address;
		const fundBtn = agentAddr
			? `<button class="tx-add-funds-btn" type="button" data-addr="${escHtml(agentAddr)}">Add funds →</button>`
			: '';
		const feedEl = addFeedItem({
			icon: '💰',
			type: 'pay',
			title: 'Not enough funds',
			sub: `Nova's wallet needs a small top-up to cover this transaction. ${fundBtn}`,
		});
		feedEl?.querySelector('.tx-add-funds-btn')?.addEventListener('click', (e) => {
			const addr = e.currentTarget.dataset.addr;
			if (addr) showAddFunds({ walletAddress: addr, asset: 'SOL' }).then(() => refreshWalletStatus());
		});
		setStatus('Nova\'s wallet needs funds. Use "Add funds" to top her up.');
	} else if (tx?.error === 'no_recipient') {
		// Log technical detail privately; never surface env-var names to users
		log.info('[three.ws] agent-economy: no_recipient:', tx.message);
		addFeedItem({
			icon: '⏸️',
			type: 'pay',
			title: 'Live transactions paused',
			sub: 'This feature is temporarily unavailable. Check back shortly.',
		});
		setStatus('Live transactions are temporarily unavailable');
	} else if (tx?.error === 'rate_limited') {
		// A spent budget is not a failure, and telling the reader "the network
		// rejected it" would send them retrying against a ceiling that only
		// clears tomorrow.
		addFeedItem({
			icon: '🧾',
			type: 'pay',
			title: 'Daily demo budget reached',
			sub: 'Oracle still delivered the service. Live payments resume tomorrow.',
		});
		setStatus('Daily demo transaction budget reached. Payments resume tomorrow.');
	} else if (tx?.error) {
		log.warn('[three.ws] agent-economy tx error:', tx.error, tx.message);
		addFeedItem({ icon: '⚠️', type: 'pay', title: 'Transaction didn\'t go through', sub: 'The network rejected this transaction. Try again in a moment.' });
		setStatus('Payment failed. Try another service or retry in a moment.');
	}

	// Oracle delivers the service
	await delay(400);
	sellerAnim('idle');

	if (data.sellerSaid) {
		showSpeech(speechSeller, data.sellerSaid, 'seller', 9000);
		sellerSay(data.sellerSaid);

		addFeedItem({
			icon: '✅',
			type: 'data',
			title: `${name} delivered`,
			sub: escHtml(data.sellerSaid.slice(0, 140) + (data.sellerSaid.length > 140 ? '…' : '')),
		});
	}

	// Only a settled payment gets the "complete" line. This used to run
	// unconditionally, so an unfunded wallet or a spent daily budget ended on
	// "Transaction complete", wiping the one line that told the reader what had
	// actually happened and what to do about it.
	if (!tx?.error) setStatus('Transaction complete · Select another service to continue');
	busy = false;
	setButtons(false);

	// Refresh wallet balances to reflect the just-completed trade.
	refreshWalletStatus();
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
