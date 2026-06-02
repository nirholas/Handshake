/**
 * Agent Solana wallet — provisioning UI + client.
 *
 * Owner-only card on the agent home panel. Two flows:
 *   1. Random wallet     → POST /api/agents/:id/solana with empty body.
 *   2. Vanity wallet     → grind in-browser (or accept a CLI-ground keypair
 *                          via the paste field) then POST { secret_key,
 *                          vanity_prefix }. Server verifies and stores the
 *                          encrypted secret.
 *
 * On mount the card pulls fresh state from GET /api/agents/:id/solana.
 * Server-side ownership is enforced; a 403 hides the card. A 404 means
 * no wallet yet → show the provisioning UI.
 *
 * Existing wallets are non-destructive: a "Replace" button calls DELETE first.
 */

import { grindVanity } from './solana/vanity/grinder.js';

const ENDPOINT = (id, qs = '') =>
	`/api/agents/${encodeURIComponent(id)}/solana${qs ? `?${qs}` : ''}`;

/**
 * Fetch current wallet state from the server.
 * @returns {Promise<{ status: 'ok'|'none'|'forbidden'|'error',
 *                     data?: { address: string, lamports: number|null, sol: number|null,
 *                              vanity_prefix: string|null, source: string|null, network: string },
 *                     error?: string }>}
 */
export async function fetchAgentSolanaWallet(agentId, network = 'mainnet') {
	const resp = await fetch(ENDPOINT(agentId, `network=${encodeURIComponent(network)}`), {
		credentials: 'include',
	});
	if (resp.status === 401 || resp.status === 403) return { status: 'forbidden' };
	const json = await resp.json().catch(() => ({}));
	if (resp.status === 404) return { status: 'none' };
	if (!resp.ok) return { status: 'error', error: json?.error?.message || `HTTP ${resp.status}` };
	return { status: 'ok', data: json.data };
}

/**
 * Provision (or replace) the agent's Solana wallet.
 *
 * @param {object} opts
 * @param {string} opts.agentId
 * @param {string} [opts.vanityPrefix]      — base58 prefix to grind for.
 * @param {Uint8Array} [opts.preGround]     — pre-ground 64-byte secret key.
 * @param {AbortSignal} [opts.signal]
 * @param {(p: { rate: number, attempts: number, eta: string }) => void} [opts.onProgress]
 * @returns {Promise<{ address: string, source: string, vanity_prefix: string|null }>}
 */
export async function provisionAgentSolanaWallet({
	agentId,
	vanityPrefix = '',
	preGround = null,
	signal,
	onProgress,
} = {}) {
	if (!agentId) throw new Error('agentId required');

	let body = null;
	if (preGround) {
		body = {
			secret_key: Array.from(preGround),
			...(vanityPrefix ? { vanity_prefix: vanityPrefix } : {}),
		};
	} else if (vanityPrefix) {
		const ground = await grindVanity({ prefix: vanityPrefix, signal, onProgress });
		body = {
			secret_key: Array.from(ground.secretKey),
			vanity_prefix: vanityPrefix,
		};
	}

	const resp = await fetch(ENDPOINT(agentId), {
		method: 'POST',
		credentials: 'include',
		headers: body ? { 'Content-Type': 'application/json' } : {},
		body: body ? JSON.stringify(body) : undefined,
		signal,
	});
	const json = await resp.json().catch(() => ({}));
	if (!resp.ok) {
		const msg = json?.error?.message || json?.message || `provision failed (${resp.status})`;
		const err = new Error(msg);
		err.status = resp.status;
		throw err;
	}
	return json.data;
}

export async function deleteAgentSolanaWallet(agentId) {
	const resp = await fetch(ENDPOINT(agentId), { method: 'DELETE', credentials: 'include' });
	if (!resp.ok) {
		const j = await resp.json().catch(() => ({}));
		throw new Error(j?.error?.message || `delete failed (${resp.status})`);
	}
}

/** Fetch the agent wallet's recent on-chain activity. */
export async function fetchAgentSolanaActivity(agentId, network = 'mainnet', limit = 10) {
	const url = `/api/agents/${encodeURIComponent(agentId)}/solana/activity?network=${encodeURIComponent(network)}&limit=${limit}`;
	const resp = await fetch(url, { credentials: 'include' });
	if (!resp.ok) {
		const j = await resp.json().catch(() => ({}));
		throw new Error(j?.error_description || j?.error?.message || `activity fetch failed (${resp.status})`);
	}
	const json = await resp.json();
	return json.data;
}

/** Request a 1 SOL devnet airdrop into the agent's wallet. */
export async function requestAgentSolanaAirdrop(agentId) {
	const url = `/api/agents/${encodeURIComponent(agentId)}/solana/airdrop`;
	const resp = await fetch(url, { method: 'POST', credentials: 'include' });
	const json = await resp.json().catch(() => ({}));
	if (!resp.ok) {
		throw new Error(json?.error_description || json?.error?.message || `airdrop failed (${resp.status})`);
	}
	return json.data;
}

// ── UI card ─────────────────────────────────────────────────────────────────

const STYLE = `
.agent-sol-wallet-details { margin: .85rem 0; }
.agent-sol-wallet-summary { font: 11px/1.4 system-ui, sans-serif; color: rgba(230,230,234,0.4); cursor: pointer; list-style: none; padding: .2rem 0; user-select: none; }
.agent-sol-wallet-summary::-webkit-details-marker { display: none; }
.agent-sol-wallet-summary::before { content: '▸ '; font-size: .65rem; }
.agent-sol-wallet-details[open] .agent-sol-wallet-summary::before { content: '▾ '; }
.agent-sol-wallet { border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: .85rem 1rem; margin: .4rem 0 0; font: 13px/1.4 system-ui, sans-serif; background: rgba(255,255,255,0.03); color: #e6e6ea; }
.agent-sol-wallet h3 { margin: 0 0 .25rem; font-size: .85rem; font-weight: 600; color: #f2f2f5; }
.agent-sol-wallet .sub { color: rgba(230,230,234,0.6); font-size: .78rem; margin: 0 0 .65rem; }
.agent-sol-wallet .addr { font-family: ui-monospace, monospace; font-size: .8rem; background: rgba(255,255,255,0.05); color: #e6e6ea; padding: .4rem .55rem; border-radius: 5px; word-break: break-all; border: 1px solid rgba(255,255,255,0.06); }
.agent-sol-wallet .addr .pfx { background: linear-gradient(90deg,#ffd54f,#ff8a65); color: #1a1a1a; padding: 0 2px; border-radius: 2px; font-weight: 600; }
.agent-sol-wallet .sns { display: inline-flex; align-items: center; gap: .35rem; margin-top: .35rem; padding: .2rem .55rem; font-family: ui-monospace, monospace; font-size: .78rem; font-weight: 600; color: #1a1a1a; background: linear-gradient(90deg,#a5d6a7,#80cbc4); border-radius: 999px; }
.agent-sol-wallet .sns::before { content: '◎'; font-weight: 700; }
.agent-sol-wallet .row { display: flex; gap: .5rem; align-items: center; margin-top: .65rem; flex-wrap: wrap; }
.agent-sol-wallet button { font: inherit; padding: .4rem .8rem; border-radius: 6px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.04); color: #e6e6ea; cursor: pointer; }
.agent-sol-wallet button:hover:not(:disabled) { background: rgba(255,255,255,0.08); }
.agent-sol-wallet button.primary { background: #f2f2f5; color: #111; border-color: #f2f2f5; }
.agent-sol-wallet button.primary:hover:not(:disabled) { background: #fff; }
.agent-sol-wallet button:disabled { opacity: .5; cursor: not-allowed; }
.agent-sol-wallet .progress { font-size: .75rem; color: rgba(230,230,234,0.7); margin-top: .55rem; font-family: ui-monospace, monospace; }
.agent-sol-wallet .err { color: #ff8a80; font-size: .75rem; margin-top: .5rem; }
.agent-sol-wallet .src { font-size: .7rem; color: rgba(230,230,234,0.5); margin-left: .35rem; }
.agent-sol-wallet .balance { display: flex; align-items: center; gap: .5rem; margin-top: .55rem; font-size: .8rem; color: rgba(230,230,234,0.85); }
.agent-sol-wallet .balance .sol { font-family: ui-monospace, monospace; font-weight: 600; }
.agent-sol-wallet .balance .sol.unavailable { font-family: system-ui, sans-serif; font-weight: 500; font-size: .75rem; color: #ffb74d; cursor: help; }
.agent-sol-wallet .balance .net { margin-left: auto; font-size: .7rem; }
.agent-sol-wallet .balance select { font: inherit; font-size: .7rem; padding: .15rem .25rem; border: 1px solid rgba(255,255,255,0.12); border-radius: 4px; background: rgba(255,255,255,0.04); color: #e6e6ea; }
.agent-sol-wallet .skel { color: rgba(230,230,234,0.4); font-size: .75rem; padding: .35rem 0; }
.agent-sol-wallet .activity { margin-top: .65rem; border-top: 1px solid rgba(255,255,255,0.06); padding-top: .5rem; }
.agent-sol-wallet .activity-h { font-size: .72rem; color: rgba(230,230,234,0.5); text-transform: uppercase; letter-spacing: .05em; margin-bottom: .35rem; display: flex; align-items: center; gap: .35rem; }
.agent-sol-wallet .activity-h button { padding: .1rem .4rem; font-size: .7rem; line-height: 1; }
.agent-sol-wallet .activity-row { display: flex; align-items: center; gap: .5rem; font-size: .75rem; padding: .25rem 0; border-bottom: 1px dashed rgba(255,255,255,0.06); }
.agent-sol-wallet .activity-row:last-child { border-bottom: none; }
.agent-sol-wallet .activity-row .sig { font-family: ui-monospace, monospace; color: rgba(230,230,234,0.7); }
.agent-sol-wallet .activity-row .delta { font-family: ui-monospace, monospace; margin-left: auto; }
.agent-sol-wallet .activity-row .delta.pos { color: #81c784; }
.agent-sol-wallet .activity-row .delta.neg { color: #ff8a80; }
.agent-sol-wallet .activity-row .ts { color: rgba(230,230,234,0.4); font-size: .7rem; }
.agent-sol-wallet .activity-empty { color: rgba(230,230,234,0.4); font-size: .75rem; padding: .35rem 0; }
.agent-sol-wallet .badge-airdrop { background: rgba(129,199,132,0.15); color: #81c784; padding: .1rem .45rem; border-radius: 999px; font-size: .65rem; font-weight: 600; margin-left: .35rem; }
`;

let _styleInjected = false;
function _injectStyle() {
	if (_styleInjected || typeof document === 'undefined') return;
	const tag = document.createElement('style');
	tag.id = 'agent-sol-wallet-style';
	tag.textContent = STYLE;
	document.head.appendChild(tag);
	_styleInjected = true;
}

function _esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
	})[c]);
}

function _shortSig(sig) { return sig ? `${sig.slice(0, 6)}…${sig.slice(-4)}` : ''; }
function _ago(ts) {
	if (!ts) return '';
	const sec = Math.max(0, Math.floor(Date.now() / 1000 - ts));
	if (sec < 60)    return `${sec}s ago`;
	if (sec < 3600)  return `${Math.floor(sec / 60)}m ago`;
	if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
	return `${Math.floor(sec / 86400)}d ago`;
}
function _explorerTxUrl(sig, network) {
	return network === 'devnet'
		? `https://explorer.solana.com/tx/${sig}?cluster=devnet`
		: `https://solscan.io/tx/${sig}`;
}
function _renderActivityRow(a, network) {
	const sigShort = _shortSig(a.signature);
	const url = _explorerTxUrl(a.signature, network);
	const delta = a.sol_delta;
	let deltaCls = '', deltaText = '—';
	if (typeof delta === 'number') {
		deltaCls = delta > 0 ? 'pos' : delta < 0 ? 'neg' : '';
		deltaText = `${delta > 0 ? '+' : ''}${delta.toFixed(4)} SOL`;
	}
	const failed = a.success === false ? '<span class="ts" style="color:#c62828">·failed</span>' : '';
	const summary = a.summary ? `<span class="ts">· ${_esc(a.summary)}</span>` : '';
	return `
		<div class="activity-row">
			<a class="sig" href="${_esc(url)}" target="_blank" rel="noopener">${_esc(sigShort)}</a>
			<span class="ts">${_esc(_ago(a.block_time))}</span>
			${summary}${failed}
			<span class="delta ${deltaCls}">${_esc(deltaText)}</span>
		</div>`;
}

/**
 * Mount the wallet card into the agent home panel.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.panel
 * @param {{ id: string, name?: string, meta?: object, solana_address?: string }} opts.identity
 * @param {(data: { address: string, vanity_prefix: string|null, source: string }) => void} [opts.onProvisioned]
 */
export function mountAgentSolanaWalletCard({ panel, identity, onProvisioned }) {
	if (!panel || !identity?.id) return null;
	_injectStyle();

	const wrapper = document.createElement('details');
	wrapper.className = 'agent-sol-wallet-details';
	wrapper.hidden = true; // unhide once we know the user is allowed to see it
	const summary = document.createElement('summary');
	summary.className = 'agent-sol-wallet-summary';
	summary.textContent = 'Solana wallet';
	wrapper.appendChild(summary);
	panel.appendChild(wrapper);

	const root = document.createElement('section');
	root.className = 'agent-sol-wallet';
	wrapper.appendChild(root);

	let state = {
		loaded: false,
		address: null,
		vanityPrefix: null,
		source: null,
		network: 'mainnet',
		sol: null,
		lamports: null,
		balanceError: null,
		snsDomain: null,
		busy: false,
		err: null,
		activity: [],
		activityLoaded: false,
		airdropping: false,
		airdropMsg: null,
	};
	let balanceTimer = null;

	async function loadFromServer() {
		const r = await fetchAgentSolanaWallet(identity.id, state.network);
		if (r.status === 'forbidden') {
			wrapper.remove();
			return false;
		}
		wrapper.hidden = false;
		if (r.status === 'ok') {
			state.address = r.data.address;
			state.vanityPrefix = r.data.vanity_prefix || null;
			state.source = r.data.source || null;
			state.lamports = r.data.lamports;
			state.sol = r.data.sol;
			state.balanceError = r.data.balance_error || null;
			state.snsDomain = r.data.sns_domain || null;
			_propagate(identity, r.data);
		} else if (r.status === 'none') {
			state.address = null;
		} else {
			state.err = r.error || 'failed to load wallet';
		}
		state.loaded = true;
		render();
		return true;
	}

	async function refreshBalance() {
		if (!state.address) return;
		// Host detached (route changed, parent re-rendered) — tear down and exit.
		if (!wrapper.isConnected) { stopBalancePoll(); return; }
		const r = await fetchAgentSolanaWallet(identity.id, state.network);
		// Session lost or ownership revoked mid-poll — stop hammering the API.
		if (r.status === 'forbidden') { stopBalancePoll(); return; }
		if (r.status === 'ok') {
			state.lamports = r.data.lamports;
			state.sol = r.data.sol;
			state.balanceError = r.data.balance_error || null;
			state.snsDomain = r.data.sns_domain || null;
			render();
		}
	}

	function startBalancePoll() {
		stopBalancePoll();
		if (!wrapper.isConnected) return;
		balanceTimer = setInterval(refreshBalance, 30_000);
	}
	function stopBalancePoll() {
		if (balanceTimer) clearInterval(balanceTimer);
		balanceTimer = null;
	}

	async function refreshActivity() {
		if (!state.address) return;
		try {
			const data = await fetchAgentSolanaActivity(identity.id, state.network, 10);
			state.activity = data?.signatures || [];
			state.activityLoaded = true;
			const host = root.querySelector('[data-host="activity-list"]');
			if (host) {
				host.innerHTML = state.activity.length
					? state.activity.map((a) => _renderActivityRow(a, state.network)).join('')
					: '<div class="activity-empty">No on-chain activity yet.</div>';
			}
		} catch (e) {
			state.activityLoaded = true;
			const host = root.querySelector('[data-host="activity-list"]');
			if (host) host.innerHTML = `<div class="activity-empty" style="color:#b71c1c">Could not load activity: ${_esc(e.message)}</div>`;
		}
	}

	async function onAirdrop() {
		state.airdropping = true;
		state.airdropMsg = 'Requesting devnet airdrop…';
		state.err = null;
		render();
		try {
			const data = await requestAgentSolanaAirdrop(identity.id);
			state.airdropMsg = `Airdrop confirmed: +${data.sol} SOL`;
			// Wait a moment for RPC to reflect, then refresh.
			setTimeout(() => {
				refreshBalance();
				refreshActivity();
				state.airdropMsg = null;
				render();
			}, 1500);
		} catch (e) {
			state.err = e.message;
			state.airdropMsg = null;
		} finally {
			state.airdropping = false;
			render();
		}
	}

	function render() {
		if (!state.loaded) {
			root.innerHTML = `<div class="skel">Loading Solana wallet…</div>`;
			return;
		}
		if (state.address) {
			const pfx = state.vanityPrefix || '';
			const rest = state.address.slice(pfx.length);
			const balUnavailable = state.balanceError != null;
			const balTitle = state.balanceError === 'rpc_rate_limited'
				? 'Solana RPC is rate-limited — balance will refresh automatically.'
				: state.balanceError
					? 'Could not reach the Solana RPC — balance will refresh automatically.'
					: '';
			const solDisplay = balUnavailable
				? 'Balance unavailable'
				: state.sol == null ? '—' : `${state.sol.toFixed(4)} SOL`;
			const isDevnet = state.network === 'devnet';
			root.innerHTML = `
				<h3>Solana wallet${state.source ? `<span class="src">· ${_esc(state.source)}</span>` : ''}</h3>
				<div class="addr"><span class="pfx">${_esc(pfx)}</span>${_esc(rest)}</div>
				${state.snsDomain ? `<div><span class="sns" title="Primary .sol domain for this wallet">${_esc(state.snsDomain)}</span></div>` : ''}
				<div class="balance">
					<span class="sol${balUnavailable ? ' unavailable' : ''}"${balTitle ? ` title="${_esc(balTitle)}"` : ''}>${_esc(solDisplay)}</span>
					<span class="net">
						<select data-act="network" aria-label="Network">
							<option value="mainnet" ${state.network === 'mainnet' ? 'selected' : ''}>Mainnet</option>
							<option value="devnet" ${state.network === 'devnet' ? 'selected' : ''}>Devnet</option>
						</select>
					</span>
				</div>
				<div class="row">
					<button data-act="copy">Copy</button>
					<button data-act="explorer">Explorer ↗</button>
					${isDevnet ? `<button data-act="airdrop" ${state.airdropping ? 'disabled' : ''}>${state.airdropping ? 'Requesting…' : 'Airdrop 1 SOL'}</button>` : ''}
					<button data-act="refresh-activity">Refresh</button>
					<button data-act="replace">Replace</button>
				</div>
				${state.airdropMsg ? `<div class="progress">${_esc(state.airdropMsg)}</div>` : ''}
				${state.err ? `<div class="err">${_esc(state.err)}</div>` : ''}
				<div class="activity" data-host="activity">
					<div class="activity-h">Recent activity <button data-act="refresh-activity-mini" type="button">↻</button></div>
					<div data-host="activity-list">
						${state.activityLoaded
							? (state.activity.length
								? state.activity.map((a) => _renderActivityRow(a, state.network)).join('')
								: '<div class="activity-empty">No on-chain activity yet.</div>')
							: '<div class="activity-empty">Loading…</div>'}
					</div>
				</div>
			`;
			root.querySelector('[data-act="copy"]').addEventListener('click', (e) => {
				navigator.clipboard?.writeText(state.address).catch(() => {});
				e.currentTarget.textContent = 'Copied';
				setTimeout(() => { const b = root.querySelector('[data-act="copy"]'); if (b) b.textContent = 'Copy'; }, 1200);
			});
			root.querySelector('[data-act="explorer"]').addEventListener('click', () => {
				const cluster = isDevnet ? '?cluster=devnet' : '';
				window.open(`https://explorer.solana.com/address/${state.address}${cluster}`, '_blank', 'noopener');
			});
			root.querySelector('[data-act="replace"]').addEventListener('click', onReplace);
			root.querySelector('[data-act="network"]').addEventListener('change', (e) => {
				state.network = e.target.value;
				state.activityLoaded = false;
				state.activity = [];
				refreshBalance();
				refreshActivity();
			});
			root.querySelector('[data-act="refresh-activity"]')?.addEventListener('click', () => {
				refreshBalance();
				refreshActivity();
			});
			root.querySelector('[data-act="refresh-activity-mini"]')?.addEventListener('click', () => {
				refreshActivity();
			});
			if (isDevnet) {
				root.querySelector('[data-act="airdrop"]').addEventListener('click', onAirdrop);
			}
			startBalancePoll();
			if (!state.activityLoaded) refreshActivity();
			return;
		}
		stopBalancePoll();

		root.innerHTML = `
			<h3>Solana wallet</h3>
			<p class="sub">Provision a wallet for this agent.</p>
			<div class="row">
				<button class="primary" data-act="random" ${state.busy ? 'disabled' : ''}>
					${state.busy ? 'Working…' : 'Generate wallet'}
				</button>
			</div>
			${state.err ? `<div class="err">${_esc(state.err)}</div>` : ''}
		`;
		root.querySelector('[data-act="random"]')?.addEventListener('click', onRandom);
	}

	async function onRandom() {
		state.busy = true; state.err = null; render();
		try {
			const data = await provisionAgentSolanaWallet({ agentId: identity.id });
			state.address = data.address;
			state.vanityPrefix = data.vanity_prefix || null;
			state.source = data.source || 'generated';
			state.lamports = data.lamports ?? 0;
			state.sol = data.sol ?? 0;
			state.balanceError = data.balance_error || null;
			_propagate(identity, data);
			onProvisioned?.(data);
			refreshBalance();
		} catch (e) {
			state.err = e.message;
		} finally {
			state.busy = false; render();
		}
	}

	async function onReplace() {
		if (!confirm('Replace the existing Solana wallet? The old key will be discarded — funds will be lost if not transferred first.')) return;
		state.busy = true; state.err = null; render();
		try {
			await deleteAgentSolanaWallet(identity.id);
			state.address = null;
			state.vanityPrefix = null;
			state.source = null;
			state.lamports = null;
			state.sol = null;
			_propagate(identity, { address: null, vanity_prefix: null, source: null });
		} catch (e) {
			state.err = e.message;
		} finally {
			state.busy = false; render();
		}
	}

	render();
	loadFromServer().catch((e) => {
		state.err = e.message || 'failed to load wallet';
		state.loaded = true;
		wrapper.hidden = false;
		render();
	});

	return {
		destroy: () => {
			stopBalancePoll();
			wrapper.remove();
		},
		refresh: () => loadFromServer().catch(() => {}),
	};
}

function _propagate(identity, data) {
	if (!identity || !data) return;
	identity.solana_address = data.address;
	identity.meta = {
		...(identity.meta || {}),
		solana_address: data.address,
		solana_vanity_prefix: data.vanity_prefix || null,
		solana_wallet_source: data.source || null,
	};
}

