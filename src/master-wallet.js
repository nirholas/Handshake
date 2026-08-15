/**
 * Your master wallet (/wallet): page controller.
 *
 * The per-user custodial hub described in docs/user-wallet.md. Until this page
 * existed the four /api/user/wallet endpoints were reachable only by curl, so
 * no account had ever provisioned a wallet. This is the surface that makes the
 * feature real for a person instead of a script.
 *
 * Not to be confused with src/wallet.js, which connects an EXTERNAL wallet
 * (Phantom, or the Seed Vault on Solana Mobile). This file never touches a
 * browser wallet: the keys here are platform-custodied and server-side, and the
 * page only ever asks the API to act on them.
 *
 * Page states, all designed, none of them a blank screen:
 *   loading      skeleton matching the final layout, so nothing jumps
 *   signed out   an explanation plus a sign-in link that returns here
 *   no wallet    the invitation to provision, with what actually gets created
 *   ready        balances, addresses, and the three actions
 *   error        what failed, in plain words, with a retry that re-runs the read
 *
 * Money movement is deliberately two-step. Send prices the transfer first
 * through the server's simulate path (real balance, rent and fee checks, signs
 * nothing), then shows recipient, amount, asset and network for explicit
 * confirmation before anything is broadcast. No amount leaves this page
 * without the user reading it back.
 */

import {
	fetchWallet,
	createWallet,
	fetchHistory,
	previewSend,
	send as sendFunds,
	fetchMyAgents,
	previewFundAgent,
	fundAgent,
} from './wallet-api.js';
import { openDepositSheet } from './wallet-deposit.js';

const root = document.getElementById('wlt-root');
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Live page state. Re-rendered wholesale; small enough that diffing is noise. */
const state = {
	phase: 'loading', // loading | anon | empty | ready | error
	wallet: null,
	error: null,
	tab: 'send', // send | fund | history
	history: { status: 'idle', items: [], error: null },
	agents: { status: 'idle', items: [], error: null },
	pending: null, // a priced, unconfirmed transfer awaiting the user's yes
	busy: false,
	notice: null, // { kind: 'ok' | 'err', title, body, href, hrefLabel }
};

function esc(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

/** Middle-truncate an address: enough head and tail to verify by eye. */
function shortAddr(a, head = 6, tail = 6) {
	const s = String(a || '');
	return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/**
 * Format a token amount without lying about precision. Balances arrive as
 * floats; nine decimals of SOL is noise and two hides dust, so scale the
 * decimals to the magnitude and mark a non-zero amount that would otherwise
 * round away to nothing.
 */
function fmtAmount(n, maxDecimals = 6) {
	if (n == null || !Number.isFinite(n)) return null;
	if (n === 0) return '0';
	if (Math.abs(n) < 10 ** -maxDecimals) return `<${10 ** -maxDecimals}`;
	const decimals = Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 1 ? 4 : maxDecimals;
	return n.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

function fmtUsd(n) {
	if (n == null || !Number.isFinite(n)) return null;
	return n.toLocaleString(undefined, {
		style: 'currency',
		currency: 'USD',
		maximumFractionDigits: 2,
	});
}

function fmtWhen(unixSeconds) {
	if (!unixSeconds) return 'pending confirmation';
	const then = new Date(unixSeconds * 1000);
	const secs = Math.round((Date.now() - then.getTime()) / 1000);
	if (secs < 60) return 'just now';
	if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
	if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
	if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`;
	return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Human copy for the API's machine codes. A raw `insufficient_sol_for_fees`
 * tells the user nothing about what to do next; these say what to do next.
 */
const ERROR_COPY = {
	invalid_destination: 'That is not a valid Solana address. Check it and try again.',
	invalid_amount: 'Enter an amount greater than zero.',
	invalid_asset: 'That token mint could not be read on Solana.',
	insufficient_balance: 'Your balance is too low for that amount.',
	insufficient_sol_for_fees:
		'You need a little more SOL to cover the network fee. Around 0.01 SOL is enough.',
	no_agent_wallet: 'That agent has no Solana wallet yet. Open the agent and provision one first.',
	forbidden: 'That agent is not yours.',
	rpc_error: 'Solana did not answer in time. Nothing was sent. Try again in a moment.',
	send_failed: 'The network rejected the transaction. Nothing was charged.',
	rate_limited: 'Too many requests. Wait a few seconds and try again.',
	not_found: 'No master wallet yet. Create one first.',
	network_error: 'You appear to be offline. Nothing was sent.',
	// The five envelopes api/_lib/http.js produces on its own. Without these the
	// page printed the raw operator text ("internal error, quote ref 515ac8… to
	// support") as the entire explanation, which tells a user nothing they can act
	// on. The reference is still shown, as a reference, by humanError below.
	internal_error: 'Something broke on our side. Nothing was charged. Try again in a moment.',
	service_unavailable: 'Our database is briefly unavailable. Nothing was charged. Try again in a moment.',
	not_configured: 'This part of the wallet is not switched on for this deployment yet.',
	validation_error: 'Something in that request was not accepted. Check the values and try again.',
	unauthorized: 'Your session expired. Sign in again to continue.',
	csrf_missing: 'That request expired before it was sent. Reload the page and try again.',
	csrf_invalid: 'That request expired before it was sent. Reload the page and try again.',
};

/**
 * Plain-language copy for an API failure, with the server's support reference
 * appended when there is one. A `ref` only ever accompanies a 5xx, and it is the
 * exact string support will ask for, so it earns its place next to the sentence
 * rather than in place of it.
 */
function humanError(res) {
	const copy = ERROR_COPY[res?.code] || res?.message || 'Something went wrong.';
	return res?.ref ? `${copy} (reference ${res.ref})` : copy;
}

/**
 * A hover/focus explainer for one idea. The body text lives in the DOM and is
 * wired with aria-describedby, so it reaches assistive tech and shows on
 * keyboard focus. Visibility is pure CSS: a tooltip that needs JavaScript to
 * appear is one that disappears when the JavaScript does.
 */
let tipSeq = 0;
function tip(subject, text) {
	const id = `wlt-tip-${++tipSeq}`;
	// The label names its subject: three buttons all announcing "Explain this"
	// give a screen-reader user no way to tell which one they landed on.
	return `<span class="wlt-tip"
		><button class="wlt-tip-btn" type="button" aria-describedby="${id}" aria-label="Explain ${esc(subject)}"
			>?</button
		><span class="wlt-tip-body" role="tooltip" id="${id}">${esc(text)}</span
	></span>`;
}

/** Amount fields all offer the same escape hatch: let the server work out max. */
function maxHint(targetId) {
	return `<p class="wlt-help">Type an amount, or <button class="wlt-linkbtn" type="button"
		data-act="max" data-target="${targetId}">use my full balance</button>.</p>`;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function skeleton() {
	return `
		<div class="wlt-skel" aria-busy="true" aria-label="Loading your wallet">
			<div class="wlt-skel-hero"></div>
			<div class="wlt-skel-row">
				<div class="wlt-skel-card"></div>
				<div class="wlt-skel-card"></div>
				<div class="wlt-skel-card"></div>
				<div class="wlt-skel-card"></div>
			</div>
			<div class="wlt-skel-panel"></div>
		</div>`;
}

function anonState() {
	const next = encodeURIComponent(location.pathname);
	return `
		<section class="wlt-hero">
			<span class="wlt-eyebrow">Master wallet</span>
			<h1 class="wlt-hero-title">One wallet for your account</h1>
			<p class="wlt-hero-sub">
				Separate from your agents' wallets. Fund it once, then top up any agent you
				own, send SOL or USDC to any Solana address, and read its on-chain history.
			</p>
			<div class="wlt-hero-actions">
				<a class="wlt-btn wlt-btn--primary wlt-btn--lg" href="/login?next=${next}">Sign in to continue</a>
				<a class="wlt-btn wlt-btn--lg" href="/docs/user-wallet">How it works</a>
			</div>
		</section>`;
}

function errorState() {
	return `
		<section class="wlt-msg" role="alert">
			<h1 class="wlt-msg-title">We could not load your wallet</h1>
			<p class="wlt-msg-body">${esc(state.error || 'Unknown error.')}</p>
			<div class="wlt-hero-actions">
				<button class="wlt-btn wlt-btn--primary" type="button" data-act="reload">Try again</button>
				<a class="wlt-btn" href="/docs/user-wallet">Read the docs</a>
			</div>
		</section>`;
}

function emptyState() {
	return `
		<section class="wlt-hero">
			<span class="wlt-eyebrow">Master wallet</span>
			<h1 class="wlt-hero-title">You do not have a master wallet yet</h1>
			<p class="wlt-hero-sub">
				Creating one generates a Solana keypair and an EVM keypair, held by the
				platform for your account and encrypted at rest with AES-256-GCM. There is
				no seed phrase to write down, and no funds move until you send them.
			</p>
			<ul class="wlt-bullets">
				<li><strong>Fund your agents</strong> without touching an external wallet.</li>
				<li><strong>Send SOL or any SPL token</strong> to any Solana address.</li>
				<li><strong>Hold USDC on Solana and Base</strong> in one place.</li>
			</ul>
			<div class="wlt-hero-actions">
				<button class="wlt-btn wlt-btn--primary wlt-btn--lg" type="button" data-act="create" ${state.busy ? 'disabled' : ''}>
					${state.busy ? 'Creating your wallet…' : 'Create my master wallet'}
				</button>
				<a class="wlt-btn wlt-btn--lg" href="/docs/user-wallet">How it works</a>
			</div>
		</section>`;
}

function balanceCards(b) {
	const cards = [
		{
			label: 'Total value',
			value: fmtUsd(b?.total_usd),
			sub: 'Solana + Base',
			accent: true,
			tip: 'Both chains added together, priced live. A balance the network did not answer for is left out rather than counted as zero.',
			tipSubject: 'total value',
		},
		{
			label: 'SOL',
			value: fmtAmount(b?.sol, 6),
			sub: 'Solana',
			tip: 'Solana charges every transaction a fee in SOL, so a wallet holding only USDC cannot send anything. Around 0.01 SOL covers a lot of activity.',
			tipSubject: 'your SOL balance',
		},
		{ label: 'USDC', value: fmtAmount(b?.sol_usdc, 2), sub: 'Solana' },
		{ label: 'USDC', value: fmtAmount(b?.evm_usdc, 2), sub: 'Base' },
	];
	return cards
		.map(
			(c) => `
			<div class="wlt-bal${c.accent ? ' wlt-bal--accent' : ''}">
				<span class="wlt-bal-label">${esc(c.label)}${c.tip ? tip(c.tipSubject, c.tip) : ''}</span>
				<span class="wlt-bal-value">${
					c.value == null
						? '<span class="wlt-bal-na" title="This balance could not be read just now">unavailable</span>'
						: esc(c.value)
				}</span>
				<span class="wlt-bal-sub">${esc(c.sub)}</span>
			</div>`,
		)
		.join('');
}

function addressRow(label, address, explorer) {
	if (!address) return '';
	return `
		<div class="wlt-addr">
			<span class="wlt-addr-label">${esc(label)}</span>
			<code class="wlt-addr-value" title="${esc(address)}">${esc(shortAddr(address, 10, 10))}</code>
			<button class="wlt-icon-btn" type="button" data-act="copy" data-copy="${esc(address)}"
				aria-label="Copy ${esc(label)} address">Copy</button>
			<a class="wlt-icon-btn" href="${esc(explorer)}" target="_blank" rel="noopener noreferrer"
				aria-label="View ${esc(label)} address on the block explorer">Explorer</a>
		</div>`;
}

function tabButton(id, label) {
	const on = state.tab === id;
	return `<button class="wlt-tab${on ? ' is-active' : ''}" type="button" role="tab"
		aria-selected="${on}" aria-controls="wlt-panel" id="wlt-tab-${id}"
		tabindex="${on ? '0' : '-1'}" data-act="tab" data-tab="${id}">${esc(label)}</button>`;
}

/** The priced, unconfirmed transfer. Nothing is signed until Confirm is hit. */
function confirmPanel() {
	const p = state.pending;
	const usd = fmtUsd(p.usdValue);
	return `
		<div class="wlt-confirm" role="group" aria-labelledby="wlt-confirm-title">
			<h3 class="wlt-confirm-title" id="wlt-confirm-title">Confirm this transfer</h3>
			<p class="wlt-confirm-note">Checked against the chain. Nothing has been signed or sent yet.</p>
			<dl class="wlt-confirm-rows">
				<div>
					<dt>Amount</dt>
					<dd class="wlt-confirm-amount">${esc(fmtAmount(p.humanAmount, 9) ?? p.amount)} ${esc(p.assetLabel)}${
						usd ? ` <span class="wlt-confirm-usd">${esc(usd)}</span>` : ''
					}</dd>
				</div>
				<div>
					<dt>${p.kind === 'fund' ? 'To agent' : 'To address'}</dt>
					<dd><code>${esc(p.kind === 'fund' ? p.agentName : p.destination)}</code></dd>
				</div>
				${
					p.kind === 'fund'
						? `<div><dt>Agent wallet</dt><dd><code>${esc(shortAddr(p.destination, 8, 8))}</code></dd></div>`
						: ''
				}
				<div><dt>Network</dt><dd>Solana mainnet</dd></div>
			</dl>
			${
				p.rentSol
					? `<p class="wlt-confirm-flag">This agent has no ${esc(p.assetLabel)} account yet, so the transfer also opens one.
						That costs an extra <strong>${esc(fmtAmount(p.rentSol, 6))} SOL</strong> in rent from this wallet, once.
						The agent keeps the account afterwards.</p>`
					: ''
			}
			<div class="wlt-confirm-actions">
				<button class="wlt-btn wlt-btn--primary" type="button" data-act="confirm" ${state.busy ? 'disabled' : ''}>
					${state.busy ? 'Sending…' : 'Confirm and send'}
				</button>
				<button class="wlt-btn" type="button" data-act="cancel" ${state.busy ? 'disabled' : ''}>Cancel</button>
			</div>
		</div>`;
}

function sendPanel() {
	if (state.pending?.kind === 'send') return confirmPanel();
	return `
		<form class="wlt-form" data-form="send" novalidate>
			<div class="wlt-field">
				<label for="wlt-dest">Destination address</label>
				<input class="wlt-input" id="wlt-dest" name="destination" type="text" required
					spellcheck="false" autocomplete="off"
					placeholder="A Solana address" aria-describedby="wlt-dest-help" />
				<p class="wlt-help" id="wlt-dest-help">Solana mainnet only. Check it carefully: a transfer cannot be reversed.</p>
			</div>
			<div class="wlt-field-row">
				<div class="wlt-field">
					<label for="wlt-asset">Asset</label>
					<select class="wlt-input" id="wlt-asset" name="asset">
						<option value="SOL">SOL</option>
						<option value="${USDC_MINT}">USDC</option>
					</select>
				</div>
				<div class="wlt-field">
					<label for="wlt-amount">Amount</label>
					<input class="wlt-input" id="wlt-amount" name="amount" type="text" required
						spellcheck="false" autocomplete="off" inputmode="decimal" placeholder="0.0" />
					${maxHint('wlt-amount')}
				</div>
			</div>
			<button class="wlt-btn wlt-btn--primary" type="submit" ${state.busy ? 'disabled' : ''}>
				${state.busy ? 'Checking…' : 'Review transfer'}
			</button>
		</form>`;
}

function fundPanel() {
	if (state.pending?.kind === 'fund') return confirmPanel();
	const { status, items, error } = state.agents;
	if (status === 'loading' || status === 'idle') {
		return `<div class="wlt-inline-skel" aria-busy="true" aria-label="Loading your agents"></div>`;
	}
	if (status === 'error') {
		return `
			<div class="wlt-msg wlt-msg--inline" role="alert">
				<p class="wlt-msg-body">${esc(error)}</p>
				<button class="wlt-btn" type="button" data-act="reload-agents">Try again</button>
			</div>`;
	}
	const fundable = items.filter((a) => a.solana_address);
	if (!fundable.length) {
		return `
			<div class="wlt-empty">
				<h3>No agent to fund yet</h3>
				<p>${
					items.length
						? 'Your agents do not have Solana wallets yet. Open an agent to provision one, then come back.'
						: 'Once you create an agent, you can top up its wallet from here in one step.'
				}</p>
				<a class="wlt-btn wlt-btn--primary" href="${items.length ? '/agents' : '/create'}">
					${items.length ? 'Open my agents' : 'Create an agent'}
				</a>
			</div>`;
	}
	return `
		<form class="wlt-form" data-form="fund" novalidate>
			<div class="wlt-field">
				<label for="wlt-agent">Agent</label>
				<select class="wlt-input" id="wlt-agent" name="agent_id" required>
					${fundable
						.map(
							(a) =>
								`<option value="${esc(a.id)}">${esc(a.name || 'Untitled agent')} · ${esc(shortAddr(a.solana_address, 4, 4))}</option>`,
						)
						.join('')}
				</select>
				<p class="wlt-help">Only agents you own appear here, and the server checks ownership again before sending.</p>
			</div>
			<div class="wlt-field-row">
				<div class="wlt-field">
					<label for="wlt-fund-asset">Asset</label>
					<select class="wlt-input" id="wlt-fund-asset" name="asset">
						<option value="USDC">USDC</option>
						<option value="SOL">SOL</option>
					</select>
				</div>
				<div class="wlt-field">
					<label for="wlt-fund-amount">Amount</label>
					<input class="wlt-input" id="wlt-fund-amount" name="amount" type="text" required
						spellcheck="false" autocomplete="off" inputmode="decimal" placeholder="0.0" />
					${maxHint('wlt-fund-amount')}
				</div>
			</div>
			<button class="wlt-btn wlt-btn--primary" type="submit" ${state.busy ? 'disabled' : ''}>
				${state.busy ? 'Checking…' : 'Review top-up'}
			</button>
		</form>`;
}

function historyPanel() {
	const { status, items, error } = state.history;
	if (status === 'loading' || status === 'idle') {
		return `<div class="wlt-inline-skel" aria-busy="true" aria-label="Loading transaction history"></div>`;
	}
	if (status === 'error') {
		return `
			<div class="wlt-msg wlt-msg--inline" role="alert">
				<p class="wlt-msg-body">${esc(error)}</p>
				<button class="wlt-btn" type="button" data-act="reload-history">Try again</button>
			</div>`;
	}
	if (!items.length) {
		return `
			<div class="wlt-empty">
				<h3>No transactions yet</h3>
				<p>Once you fund this wallet or send from it, every transaction appears here, read straight from Solana.</p>
			</div>`;
	}
	return `
		<ul class="wlt-tx-list">
			${items
				.map((t) => {
					const delta = t.lamport_delta == null ? null : t.lamport_delta / 1e9;
					const dir = delta == null || delta === 0 ? 'neutral' : delta > 0 ? 'in' : 'out';
					const amount =
						delta == null || delta === 0
							? null
							: `${delta > 0 ? '+' : '−'}${fmtAmount(Math.abs(delta), 6)} SOL`;
					return `
					<li class="wlt-tx${t.success ? '' : ' wlt-tx--failed'}">
						<span class="wlt-tx-dot wlt-tx-dot--${t.success ? dir : 'failed'}" aria-hidden="true"></span>
						<span class="wlt-tx-main">
							<span class="wlt-tx-summary">${esc(t.summary || 'Transaction')}</span>
							<span class="wlt-tx-meta">${esc(fmtWhen(t.block_time))}${t.success ? '' : ' · failed'}</span>
						</span>
						${amount ? `<span class="wlt-tx-amount wlt-tx-amount--${dir}">${esc(amount)}</span>` : ''}
						<a class="wlt-tx-link" href="${esc(t.explorer)}" target="_blank" rel="noopener noreferrer"
							aria-label="View transaction ${esc(shortAddr(t.signature))} on Solscan">View</a>
					</li>`;
				})
				.join('')}
		</ul>`;
}

function noticeBanner() {
	const n = state.notice;
	if (!n) return '';
	return `
		<div class="wlt-notice wlt-notice--${n.kind === 'ok' ? 'ok' : 'err'}" role="${n.kind === 'ok' ? 'status' : 'alert'}">
			<div class="wlt-notice-text">
				<strong>${esc(n.title)}</strong>
				${n.body ? `<span>${esc(n.body)}</span>` : ''}
			</div>
			${
				n.href
					? `<a class="wlt-btn wlt-btn--sm" href="${esc(n.href)}" target="_blank" rel="noopener noreferrer">${esc(n.hrefLabel || 'View')}</a>`
					: ''
			}
			<button class="wlt-icon-btn" type="button" data-act="dismiss" aria-label="Dismiss this message">Dismiss</button>
		</div>`;
}

function readyState() {
	const w = state.wallet;
	const panels = { send: sendPanel, fund: fundPanel, history: historyPanel };
	return `
		<header class="wlt-head">
			<div>
				<span class="wlt-eyebrow">Master wallet</span>
				<div class="wlt-title-row">
					<h1 class="wlt-title">Your wallet</h1>
					${tip(
						'how this wallet relates to your agents',
						'Your account holds this one. Each agent has its own separate wallet, funded from here, so an agent can only ever spend what you moved into it.',
					)}
				</div>
			</div>
			<div class="wlt-head-actions">
				<button class="wlt-btn wlt-btn--primary" type="button" data-act="deposit">Add funds</button>
				<button class="wlt-btn wlt-btn--sm" type="button" data-act="refresh" ${state.busy ? 'disabled' : ''}
					aria-label="Re-read balances from Solana and Base">Refresh</button>
			</div>
		</header>

		${noticeBanner()}

		<section class="wlt-balances" aria-label="Balances">
			${balanceCards(w.balances)}
		</section>

		<section class="wlt-addresses" aria-label="Wallet addresses">
			${addressRow('Solana', w.solana_address, `https://solscan.io/account/${w.solana_address}`)}
			${addressRow('Base', w.evm_address, `https://basescan.org/address/${w.evm_address}`)}
			<p class="wlt-addr-note">
				Copying an address by hand is the slow way in.
				<button class="wlt-linkbtn" type="button" data-act="deposit">Add funds</button>
				shows a scannable payment request instead, and this page announces the deposit the moment it lands on chain.
			</p>
		</section>

		<section class="wlt-actions">
			<div class="wlt-tabs" role="tablist" aria-label="Wallet actions">
				${tabButton('send', 'Send')}
				${tabButton('fund', 'Fund an agent')}
				${tabButton('history', 'History')}
			</div>
			<div class="wlt-panel" id="wlt-panel" role="tabpanel" aria-labelledby="wlt-tab-${state.tab}" tabindex="0">
				${panels[state.tab]()}
			</div>
		</section>`;
}

function render() {
	const views = {
		loading: skeleton,
		anon: anonState,
		empty: emptyState,
		error: errorState,
		ready: readyState,
	};
	root.innerHTML = (views[state.phase] || skeleton)();
}

// ── Data loading ─────────────────────────────────────────────────────────────

async function loadWallet() {
	state.phase = 'loading';
	render();
	const res = await fetchWallet();
	if (!res.ok) {
		if (res.status === 401) {
			state.phase = 'anon';
		} else {
			state.phase = 'error';
			state.error = humanError(res);
		}
		render();
		return;
	}
	if (!res.data?.wallet) {
		state.phase = 'empty';
		render();
		return;
	}
	state.wallet = res.data.wallet;
	state.phase = 'ready';
	render();
}

async function loadHistory() {
	state.history = { status: 'loading', items: [], error: null };
	if (state.phase === 'ready' && state.tab === 'history') render();
	const res = await fetchHistory(20);
	state.history = res.ok
		? { status: 'ready', items: res.data?.history || [], error: null }
		: { status: 'error', items: [], error: humanError(res) };
	if (state.phase === 'ready' && state.tab === 'history') render();
}

async function loadAgents() {
	state.agents = { status: 'loading', items: [], error: null };
	if (state.phase === 'ready' && state.tab === 'fund') render();
	const res = await fetchMyAgents();
	state.agents = res.ok
		? { status: 'ready', items: res.data?.agents || [], error: null }
		: { status: 'error', items: [], error: humanError(res) };
	if (state.phase === 'ready' && state.tab === 'fund') render();
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function onCreate() {
	state.busy = true;
	render();
	const res = await createWallet();
	state.busy = false;
	if (!res.ok) {
		state.phase = 'error';
		state.error = humanError(res);
		render();
		return;
	}
	state.notice = {
		kind: 'ok',
		title: 'Your master wallet is ready.',
		body: 'It is empty until you fund it. Scan the code to send it something.',
	};
	await loadWallet();
	// A wallet with nothing in it can do nothing, so the very next step is
	// always funding. Opening the sheet here removes the hunt for the button
	// that every new user would otherwise have to make on their own.
	if (state.phase === 'ready') onDeposit();
}

/**
 * Price a send. The server does the arithmetic against real balances, rent and
 * fees, so the confirmation shows chain truth rather than a browser estimate.
 */
async function onReviewSend(form) {
	const destination = form.destination.value.trim();
	const asset = form.asset.value;
	const amount = form.amount.value.trim();
	if (!destination || !amount) {
		state.notice = { kind: 'err', title: 'Fill in a destination and an amount.' };
		render();
		return;
	}
	state.busy = true;
	state.notice = null;
	render();
	const res = await previewSend({ destination, asset, amount });
	state.busy = false;
	if (!res.ok) {
		state.notice = { kind: 'err', title: 'That transfer was not accepted.', body: humanError(res) };
		render();
		return;
	}
	const sim = res.data?.simulation || {};
	state.pending = {
		kind: 'send',
		destination: sim.destination || destination,
		asset,
		assetLabel: asset === 'SOL' ? 'SOL' : asset === USDC_MINT ? 'USDC' : shortAddr(asset),
		amount,
		humanAmount: sim.human_amount,
		usdValue: sim.usd_value,
	};
	render();
}

/**
 * Price an agent top-up the same way a send is priced: ask the server, which
 * resolves it against the chain and signs nothing. This is why the confirmation
 * can state what "max" actually means and warn when the transfer also opens a
 * token account for the agent at the sender's expense.
 */
async function onReviewFund(form) {
	const agentId = form.agent_id.value;
	const asset = form.asset.value;
	const amount = form.amount.value.trim();
	if (!agentId || !amount) {
		state.notice = { kind: 'err', title: 'Pick an agent and enter an amount.' };
		render();
		return;
	}
	state.busy = true;
	state.notice = null;
	render();
	const res = await previewFundAgent({ agentId, asset, amount });
	state.busy = false;
	if (!res.ok) {
		state.notice = { kind: 'err', title: 'That top-up was not accepted.', body: humanError(res) };
		render();
		return;
	}
	const sim = res.data?.simulation || {};
	const agent = state.agents.items.find((a) => a.id === agentId);
	state.pending = {
		kind: 'fund',
		agentId,
		agentName: agent?.name || 'Your agent',
		destination: sim.agent_wallet || agent?.solana_address || '',
		asset,
		assetLabel: asset,
		amount,
		humanAmount: sim.human_amount,
		usdValue: sim.usd_value,
		rentSol: sim.creates_token_account ? sim.token_account_rent_sol : 0,
	};
	render();
}

async function onConfirm() {
	const p = state.pending;
	if (!p) return;
	state.busy = true;
	render();
	const res =
		p.kind === 'fund'
			? await fundAgent({ agentId: p.agentId, asset: p.asset, amount: p.amount })
			: await sendFunds({ destination: p.destination, asset: p.asset, amount: p.amount });
	state.busy = false;
	state.pending = null;
	if (!res.ok) {
		state.notice = { kind: 'err', title: 'The transfer did not go through.', body: humanError(res) };
		render();
		return;
	}
	const sent = res.data || {};
	state.notice = {
		kind: 'ok',
		title: `Sent ${fmtAmount(sent.human_amount, 9) ?? p.amount} ${p.assetLabel}.`,
		body:
			p.kind === 'fund'
				? `${p.agentName} has been topped up.`
				: `Delivered to ${shortAddr(p.destination)}.`,
		href: sent.explorer,
		hrefLabel: 'View on Solscan',
	};
	// Balances and history both moved; re-read rather than guess the new numbers.
	await loadWallet();
	if (state.history.status !== 'idle') loadHistory();
}

/**
 * Open the scan-to-fund sheet.
 *
 * `readBalances` is handed to the sheet rather than a whole API client: the
 * watcher only ever needs the balance object, and passing a narrow function
 * keeps the sheet testable without a network. Whatever the sheet last read is
 * already the truth, so on close the page adopts it instead of issuing another
 * request for a number it just saw.
 */
async function onDeposit() {
	const w = state.wallet;
	if (!w) return;
	let latest = null;
	const arrival = await openDepositSheet({
		solanaAddress: w.solana_address,
		evmAddress: w.evm_address,
		balances: w.balances,
		async readBalances() {
			const res = await fetchWallet();
			if (!res.ok || !res.data?.wallet?.balances) return null;
			latest = res.data.wallet;
			return latest.balances;
		},
	});
	if (latest) state.wallet = latest;
	if (arrival) {
		state.notice = {
			kind: 'ok',
			title: `${fmtAmount(arrival.delta, arrival.asset === 'sol' ? 6 : 2)} ${arrival.label} landed in your wallet.`,
			body: 'You can send it, or top up an agent with it, right now.',
		};
		// A deposit is a history event too, so a tab already showing history
		// should not keep showing the list from before the money arrived.
		if (state.history.status !== 'idle') loadHistory();
	}
	render();
}

async function onCopy(text, btn) {
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
		state.notice = {
			kind: 'err',
			title: 'Could not copy automatically.',
			body: 'Select the address and copy it manually.',
		};
		render();
	}
}

function switchTab(tab) {
	if (state.tab === tab) return;
	state.tab = tab;
	state.pending = null;
	render();
	if (tab === 'history' && state.history.status === 'idle') loadHistory();
	if (tab === 'fund' && state.agents.status === 'idle') loadAgents();
}

// ── Wiring ───────────────────────────────────────────────────────────────────

root.addEventListener('click', (e) => {
	const el = e.target.closest('[data-act]');
	if (!el) return;
	const act = el.dataset.act;
	if (act === 'create') return void onCreate();
	if (act === 'reload' || act === 'refresh') return void loadWallet();
	if (act === 'deposit') return void onDeposit();
	if (act === 'reload-history') return void loadHistory();
	if (act === 'reload-agents') return void loadAgents();
	if (act === 'tab') return switchTab(el.dataset.tab);
	if (act === 'copy') return void onCopy(el.dataset.copy, el);
	if (act === 'confirm') return void onConfirm();
	if (act === 'cancel') {
		state.pending = null;
		render();
		return;
	}
	if (act === 'dismiss') {
		state.notice = null;
		render();
		return;
	}
	if (act === 'max') {
		// "max" is a server-side word, not a number: only the API knows what is
		// left after rent and fees. The review step reads back what it resolved to.
		const input = root.querySelector(`#${el.dataset.target}`);
		if (input) {
			input.value = 'max';
			input.focus();
		}
	}
});

root.addEventListener('submit', (e) => {
	const form = e.target.closest('form[data-form]');
	if (!form) return;
	e.preventDefault();
	if (state.busy) return;
	if (form.dataset.form === 'send') return void onReviewSend(form);
	if (form.dataset.form === 'fund') return void onReviewFund(form);
});

// Arrow-key navigation across the tablist, per the WAI-ARIA tabs pattern.
root.addEventListener('keydown', (e) => {
	if (!e.target.classList?.contains('wlt-tab')) return;
	if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
	e.preventDefault();
	const order = ['send', 'fund', 'history'];
	const i = order.indexOf(state.tab);
	const next = order[(i + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
	switchTab(next);
	root.querySelector(`#wlt-tab-${next}`)?.focus();
});

loadWallet();
