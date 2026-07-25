/**
 * Manage Permissions Panel
 *
 * Renders a list of all delegations granted for an agent, with revoke support.
 *
 * Public API:
 *   mountManagePanel({ container, agentId, agentWalletAddress?, agentChainId? })
 *     → { unmount }
 */

import { BrowserProvider, Contract } from 'ethers';
import { apiFetch } from '../api.js';
import { CHAIN_META, addressExplorerUrl, txExplorerUrl } from '../erc8004/chain-meta.js';
import { DELEGATION_MANAGER_DEPLOYMENTS, DELEGATION_MANAGER_ABI } from '../erc7710/abi.js';
import { GrantPermissionsModal } from './grant-modal.js';
import { log } from '../shared/log.js';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   container: HTMLElement,
 *   agentId: string,
 *   agentWalletAddress?: string,  // The agent's on-chain address (used as delegate)
 *   agentChainId?: number,        // Default chain to grant on; if absent the modal asks
 * }} opts
 * @returns {{ unmount: () => void }}
 */
export function mountManagePanel({ container, agentId, agentWalletAddress, agentChainId }) {
	const panel = new ManagePanel(container, agentId, { agentWalletAddress, agentChainId });
	panel.mount();
	return { unmount: () => panel.unmount() };
}

// ── Panel class ───────────────────────────────────────────────────────────────

class ManagePanel {
	constructor(container, agentId, { agentWalletAddress, agentChainId } = {}) {
		this._container = container;
		this._agentId = agentId;
		this._agentWalletAddress = agentWalletAddress || null;
		this._agentChainId = agentChainId || null;
		this._root = null;
		this._delegations = [];
		this._onFocus = null;
	}

	mount() {
		this._root = document.createElement('div');
		this._root.className = 'mp-panel';
		this._root.innerHTML = `
			<div class="mp-header">
				<span class="mp-title">Permissions</span>
				<div class="mp-header-actions">
					<button class="mp-grant-header-btn" id="mp-grant-header-btn" title="Grant new permission" hidden>
						+ Grant
					</button>
					<button class="mp-refresh-btn" title="Refresh">
						<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
							<path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
						</svg>
					</button>
				</div>
			</div>
			<div class="mp-list" id="mp-list-${this._agentId}">
				<div class="mp-loading">Loading…</div>
			</div>
		`;
		this._container.appendChild(this._root);

		this._root.querySelector('.mp-refresh-btn').addEventListener('click', () => this._load());
		this._root
			.querySelector('#mp-grant-header-btn')
			.addEventListener('click', () => this._openGrantModal());

		this._onFocus = () => this._load();
		window.addEventListener('focus', this._onFocus);

		this._load();
	}

	unmount() {
		if (this._onFocus) window.removeEventListener('focus', this._onFocus);
		this._root?.remove();
	}

	async _load() {
		try {
			const res = await fetch(
				`/api/permissions/list?agentId=${encodeURIComponent(this._agentId)}&status=all&limit=200`,
				{ credentials: 'include' },
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			if (!data.ok) throw new Error(data.message || 'list failed');
			this._delegations = data.delegations || [];
			this._render();
		} catch (err) {
			this._listEl().innerHTML = `<div class="mp-error">Failed to load: ${_esc(err.message)}</div>`;
		}
	}

	_render() {
		const el = this._listEl();
		const headerGrantBtn = this._root.querySelector('#mp-grant-header-btn');

		if (!this._delegations.length) {
			if (headerGrantBtn) headerGrantBtn.hidden = true;
			const canGrant = Boolean(this._agentWalletAddress);
			const empty = document.createElement('div');
			empty.className = 'mp-empty';
			empty.innerHTML = `
				<p>No permissions granted yet.</p>
				${
					canGrant
						? `<button class="mp-grant-btn" id="mp-grant-btn">Grant permissions</button>`
						: `<p class="mp-empty-hint">Register the agent on-chain first to grant it permissions.</p>`
				}
			`;
			el.innerHTML = '';
			el.appendChild(empty);
			el.querySelector('#mp-grant-btn')?.addEventListener('click', () =>
				this._openGrantModal(),
			);
			return;
		}

		if (headerGrantBtn) headerGrantBtn.hidden = !this._agentWalletAddress;

		el.innerHTML = '';
		for (const d of this._delegations) {
			el.appendChild(this._buildCard(d));
		}
	}

	async _openGrantModal() {
		if (!this._agentWalletAddress) {
			// Defensive: button shouldn't be visible without an agent wallet,
			// but fail loud just in case.
			log.warn('[manage-panel] cannot grant: agent has no wallet address');
			return;
		}

		const result = await new GrantPermissionsModal({
			agentId: this._agentId,
			chainId: this._agentChainId || undefined,
			delegateAddress: this._agentWalletAddress,
			// delegatorAddress is filled by ensureWallet() inside the modal
		}).open();

		if (result?.ok) {
			this._load();
		}
	}

	_buildCard(d) {
		const card = document.createElement('div');
		card.className = `mp-card mp-card--${d.status}`;
		card.dataset.id = d.id;

		const chainMeta = CHAIN_META[d.chain_id];
		const chainName = chainMeta?.shortName ?? `${d.chain_id}`;
		const explorerBase = chainMeta?.explorer ?? '';

		const delegatorUrl = explorerBase
			? addressExplorerUrl(d.chain_id, d.delegator_address)
			: '#';
		const delegateUrl = explorerBase ? addressExplorerUrl(d.chain_id, d.delegate_address) : '#';

		const scopeText = _scopeSentence(d.scope);
		const usageLine = _usageLine(d.redemption_count, d.last_redeemed_at);
		const badgeClass =
			{
				active: 'mp-badge--active',
				revoked: 'mp-badge--revoked',
				expired: 'mp-badge--expired',
			}[d.status] || '';
		const hashShort = d.delegation_hash
			? `${d.delegation_hash.slice(0, 8)}…${d.delegation_hash.slice(-6)}`
			: 'unknown hash';
		const isPendingIndexer = !d.delegation_hash;

		card.innerHTML = `
			<div class="mp-card-top">
				<span class="mp-badge ${badgeClass}">${d.status}</span>
				<span class="mp-chain-chip">${_esc(chainName)}</span>
				${isPendingIndexer ? '<span class="mp-indexer-pending">pending indexer</span>' : ''}
			</div>
			<div class="mp-card-scope">${_esc(scopeText)}</div>
			<div class="mp-card-hash">${_esc(hashShort)}</div>
			<div class="mp-card-usage">${_esc(usageLine)}</div>
			<div class="mp-card-addresses">
				<a class="mp-addr-link" href="${_esc(delegatorUrl)}" target="_blank" rel="noopener noreferrer"
					title="Delegator">
					${_shortAddr(d.delegator_address)}
				</a>
				<span class="mp-addr-arrow" aria-hidden="true">→</span>
				<a class="mp-addr-link" href="${_esc(delegateUrl)}" target="_blank" rel="noopener noreferrer"
					title="Delegate (agent)">
					${_shortAddr(d.delegate_address)}
				</a>
			</div>
			<div class="mp-card-actions">
				${
					d.status === 'active'
						? `<button class="mp-revoke-btn" data-id="${_esc(d.id)}" data-hash="${_esc(d.delegation_hash || '')}" data-chain="${d.chain_id}">Revoke</button>`
						: ''
				}
			</div>
			<div class="mp-card-error" style="display:none"></div>
			<div class="mp-card-pending" style="display:none"></div>
		`;

		const revokeBtn = card.querySelector('.mp-revoke-btn');
		if (revokeBtn) {
			revokeBtn.addEventListener('click', () => this._handleRevoke(card, d));
		}

		return card;
	}

	async _handleRevoke(card, d) {
		const revokeBtn = card.querySelector('.mp-revoke-btn');
		const errorEl = card.querySelector('.mp-card-error');
		const pendingEl = card.querySelector('.mp-card-pending');

		const _showError = (msg) => {
			errorEl.textContent = msg;
			errorEl.style.display = '';
			revokeBtn.disabled = false;
			revokeBtn.textContent = 'Revoke';
		};

		errorEl.style.display = 'none';
		pendingEl.style.display = 'none';

		if (!window.ethereum) {
			_showError('No wallet detected. Please install MetaMask.');
			return;
		}

		let provider, signer, signerAddress;
		try {
			provider = new BrowserProvider(window.ethereum);
			await provider.send('eth_requestAccounts', []);
			signer = await provider.getSigner();
			signerAddress = (await signer.getAddress()).toLowerCase();
		} catch (err) {
			_showError(`Wallet connect failed: ${err.message}`);
			return;
		}

		const delegatorAddr = (d.delegator_address || '').toLowerCase();
		if (signerAddress !== delegatorAddr) {
			_showError(`Connect with ${_shortAddr(d.delegator_address)} to revoke.`);
			return;
		}

		if (!d.delegation_hash) {
			_showError('Delegation hash unknown — cannot revoke on-chain yet.');
			return;
		}

		const managerAddr = DELEGATION_MANAGER_DEPLOYMENTS[d.chain_id];
		if (!managerAddr) {
			_showError(`No DelegationManager deployment for chain ${d.chain_id}.`);
			return;
		}

		// Switch to the correct chain
		try {
			const network = await provider.getNetwork();
			if (Number(network.chainId) !== d.chain_id) {
				await provider.send('wallet_switchEthereumChain', [
					{ chainId: '0x' + d.chain_id.toString(16) },
				]);
			}
		} catch (err) {
			_showError(`Chain switch failed: ${err.message}`);
			return;
		}

		revokeBtn.disabled = true;
		revokeBtn.textContent = 'Sending…';

		let tx;
		try {
			const manager = new Contract(managerAddr, DELEGATION_MANAGER_ABI, signer);
			tx = await manager.disableDelegation(d.delegation_hash);
		} catch (err) {
			_showError(err.message);
			return;
		}

		// Show pending state with explorer link
		const explorerTxUrl = txExplorerUrl(d.chain_id, tx.hash);
		pendingEl.innerHTML = `
			<span class="mp-spinner" aria-hidden="true"></span>
			Revoking…
			${explorerTxUrl ? `<a href="${_esc(explorerTxUrl)}" target="_blank" rel="noopener noreferrer" class="mp-tx-link">view tx</a>` : ''}
		`;
		pendingEl.style.display = '';
		revokeBtn.textContent = 'Pending…';

		try {
			await tx.wait();
		} catch (err) {
			pendingEl.style.display = 'none';
			_showError(`Transaction failed: ${err.message}`);
			return;
		}

		// Mirror to server
		try {
			const res = await apiFetch('/api/permissions/revoke', {
				method: 'POST',
				credentials: 'include',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: d.id, txHash: tx.hash }),
			});
			const data = await res.json();
			if (!data.ok) throw new Error(data.message || 'revoke mirror failed');
		} catch (err) {
			// Server mirror failure is non-fatal — on-chain is source of truth.
			log.warn('[manage-panel] server mirror failed:', err.message);
		}

		// Flip card to revoked optimistically
		pendingEl.style.display = 'none';
		card.classList.remove('mp-card--active');
		card.classList.add('mp-card--revoked');
		card.querySelector('.mp-badge').className = 'mp-badge mp-badge--revoked';
		card.querySelector('.mp-badge').textContent = 'revoked';
		revokeBtn.remove();

		// Background refetch to sync any other changes
		setTimeout(() => this._load(), 2000);
	}

	_listEl() {
		return this._root.querySelector(`#mp-list-${this._agentId}`);
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _esc(str) {
	return String(str ?? '').replace(
		/[<>&"]/g,
		(c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c],
	);
}

function _shortAddr(addr) {
	if (!addr) return 'unknown';
	return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function _scopeSentence(scope) {
	if (!scope) return 'Unknown scope';
	const { token, maxAmount, period, targets, expiry } = scope;
	const tokenLabel =
		token && token !== 'native'
			? _shortAddr(token)
			: token === 'native'
				? 'native token'
				: 'token';
	const amountLabel = maxAmount ? _formatAmount(maxAmount) : '?';
	const periodLabel =
		{ daily: 'per day', weekly: 'per week', once: 'once' }[period] || period || '';
	const targetLabel =
		targets?.length === 1
			? `on ${_shortAddr(targets[0])}`
			: targets?.length > 1
				? `on ${targets.length} contracts`
				: '';
	const expiryLabel = expiry ? `until ${_formatDate(expiry)}` : '';
	const parts = [
		`Up to ${amountLabel} ${tokenLabel}`,
		periodLabel,
		targetLabel,
		expiryLabel,
	].filter(Boolean);
	return parts.join(' ');
}

function _formatAmount(raw) {
	const n = Number(raw);
	if (!Number.isFinite(n)) return raw;
	// Assume 6 decimals (USDC-style) for display. Real code would look up token decimals.
	const display = n / 1e6;
	return display >= 1 ? display.toLocaleString() : raw;
}

function _formatDate(unixSeconds) {
	const d = new Date(unixSeconds * 1000);
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function _usageLine(count, lastAt) {
	const c = count ?? 0;
	const redemptionPart = `${c} redemption${c !== 1 ? 's' : ''}`;
	if (!lastAt) return redemptionPart;
	const diff = Date.now() - new Date(lastAt).getTime();
	let ago;
	if (diff < 60_000) ago = 'just now';
	else if (diff < 3_600_000) ago = `${Math.floor(diff / 60_000)}m ago`;
	else if (diff < 86_400_000) ago = `${Math.floor(diff / 3_600_000)}h ago`;
	else ago = _formatDate(Math.floor(new Date(lastAt).getTime() / 1000));
	return `${redemptionPart} · last used ${ago}`;
}
