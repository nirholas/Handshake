/**
 * Reputation panel — surfaces ERC-8004 ReputationRegistry state on an
 * agent's public profile.
 *
 * Reads:
 *   • getReputation(agentId) → { total, count, average }
 *   • Recent ReputationSubmitted events (best-effort; some RPCs cap log
 *     queries so we ask for the last ~50k blocks and degrade gracefully)
 *
 * Writes (only when signed-in visitor has a wallet):
 *   • submitReputation(agentId, score, comment)  — the "vouch" CTA
 *
 * Mounted on agent pages when the agent has chain_id and
 * erc8004_agent_id, so visitors see real on-chain reputation rather
 * than a generic identity card.
 */

import { BrowserProvider } from 'ethers';
import { CHAIN_META, switchChain, txExplorerUrl, readProvider } from './chain-meta.js';
import { REGISTRY_DEPLOYMENTS } from './abi.js';
import { submitReputation, stakeReputation, getTotalStake, getReputation, getRecentReviews } from './reputation.js';
import { log } from '../shared/log.js';
import { getEthPriceUsd } from '../shared/usd-price.js';

const REVIEWS_LOOKBACK_BLOCKS = 50_000;
const MIN_STAKE_ETH = 0.001;

let _ethPriceUsd = null;
let _ethPriceFetchedAt = 0;

async function fetchEthPriceUsd() {
	const now = Date.now();
	if (_ethPriceUsd && now - _ethPriceFetchedAt < 5 * 60 * 1000) return _ethPriceUsd;
	try {
		// Four feeds with per-provider cooldowns, not one un-timed CoinGecko call:
		// a throttle there used to blank the USD figure printed beside a real ETH
		// stake amount.
		_ethPriceUsd = await getEthPriceUsd();
		_ethPriceFetchedAt = now;
	} catch {
		/* best-effort */
	}
	return _ethPriceUsd;
}

export class ReputationPanel {
	/**
	 * @param {object} opts
	 * @param {HTMLElement} opts.container
	 * @param {{ id: string, chainId: number, erc8004AgentId: number|string,
	 *           registryAddress?: string, ownerUserId?: string|null }} opts.agent
	 * @param {{ id: string }|null} [opts.viewer]  Current signed-in user, or null.
	 */
	constructor({ container, agent, viewer = null }) {
		this._container = container;
		this._agent = agent;
		this._viewer = viewer;
		this._root = null;
		this._stats = null;
		this._totalStakeWei = 0n;
		this._reviews = [];
	}

	async mount() {
		this._root = document.createElement('section');
		this._root.className = 'agent-reputation';
		this._root.setAttribute('aria-labelledby', 'agent-reputation-heading');
		this._root.innerHTML = `
			<h2 class="agent-reputation__heading" id="agent-reputation-heading">Reputation</h2>
			<div class="agent-reputation__loading" role="status">Loading reputation…</div>
		`;
		this._container.appendChild(this._root);
		await this._refresh();
	}

	async _refresh() {
		const meta = CHAIN_META[this._agent.chainId];
		if (!meta?.rpcUrl) {
			this._renderEmpty(`No public RPC configured for chain ${this._agent.chainId}.`);
			return;
		}

		const deployment = REGISTRY_DEPLOYMENTS[this._agent.chainId];
		if (!deployment?.reputationRegistry) {
			this._renderEmpty(`No Reputation Registry deployed on ${meta.name}.`);
			return;
		}

		const provider = readProvider(this._agent.chainId);

		try {
			[this._stats, this._totalStakeWei] = await Promise.all([
				getReputation({
					agentId: this._agent.erc8004AgentId,
					runner: provider,
					chainId: this._agent.chainId,
				}),
				getTotalStake({
					agentId: this._agent.erc8004AgentId,
					runner: provider,
					chainId: this._agent.chainId,
				}).catch(() => 0n),
			]);
		} catch (err) {
			log.warn('[reputation-panel] getReputation failed:', err?.message);
			this._renderEmpty('Could not read reputation from the chain.');
			return;
		}

		// Recent reviews are best-effort. Some RPCs (free tiers) reject open-
		// ended log queries — fall back to "no reviews shown" without breaking
		// the rest of the panel.
		try {
			const head = await provider.getBlockNumber();
			const fromBlock = Math.max(0, head - REVIEWS_LOOKBACK_BLOCKS);
			this._reviews = await getRecentReviews({
				agentId: this._agent.erc8004AgentId,
				runner: provider,
				chainId: this._agent.chainId,
				fromBlock,
			});
		} catch {
			this._reviews = [];
		}

		this._render();
	}

	_render() {
		const stats = this._stats || { count: 0, average: 0, total: 0 };
		const meta = CHAIN_META[this._agent.chainId];
		const chainName = meta?.name || `Chain ${this._agent.chainId}`;

		const summary =
			stats.count > 0
				? `<span class="agent-reputation__avg">${_fmtAvg(stats.average)}</span>
				 <span class="agent-reputation__sep">·</span>
				 <span class="agent-reputation__count">${stats.count} ${
						stats.count === 1 ? 'vouch' : 'vouches'
					}</span>`
				: `<span class="agent-reputation__empty">No reputation submitted yet.</span>`;

		const canVouch = this._canVouch();
		const vouchHtml = canVouch
			? `<button class="agent-reputation__vouch" type="button">
					Vouch for this agent
				 </button>`
			: this._viewer
				? `<span class="agent-reputation__hint">Owners can't vouch for their own agent.</span>`
				: `<span class="agent-reputation__hint">
					 <a href="/login?next=${encodeURIComponent(`/agents/${this._agent.id}`)}">Sign in</a>
					 to vouch for this agent.
				   </span>`;

		const reviewsHtml = this._reviews.length
			? `<ul class="agent-reputation__list">${this._reviews
					.slice(-8)
					.reverse()
					.map(
						(r) => `
				<li class="agent-reputation__row">
					<span class="agent-reputation__row-score">${_score(r.score)}</span>
					<span class="agent-reputation__row-from" title="${_esc(r.from)}">${_shortAddr(r.from)}</span>
					${r.comment ? `<span class="agent-reputation__row-comment">${_esc(r.comment)}</span>` : ''}
					<a class="agent-reputation__row-tx"
					   href="${_esc(txExplorerUrl(this._agent.chainId, r.txHash))}"
					   target="_blank" rel="noopener noreferrer"
					   aria-label="Open transaction in block explorer">↗</a>
				</li>`,
					)
					.join('')}</ul>`
			: stats.count > 0
				? `<p class="agent-reputation__no-recent">
					Vouches exist on-chain but couldn't be enumerated by this RPC. Open
					${chainName}'s explorer to see them.
				   </p>`
				: '';

		const stakeEth = Number(this._totalStakeWei) / 1e18;
		const stakeHtml =
			this._totalStakeWei > 0n
				? `<div class="agent-reputation__stake">Total staked: <strong>${stakeEth.toFixed(4)} ETH</strong></div>`
				: '';

		this._root.innerHTML = `
			<h2 class="agent-reputation__heading" id="agent-reputation-heading">Reputation</h2>
			<div class="agent-reputation__summary">${summary}</div>
			${stakeHtml}
			<div class="agent-reputation__action">${vouchHtml}</div>
			${reviewsHtml}
		`;

		const vouchBtn = this._root.querySelector('.agent-reputation__vouch');
		if (vouchBtn) vouchBtn.addEventListener('click', () => this._openVouchDialog());
	}

	_renderEmpty(reason) {
		this._root.innerHTML = `
			<h2 class="agent-reputation__heading" id="agent-reputation-heading">Reputation</h2>
			<p class="agent-reputation__hint">${_esc(reason)}</p>
		`;
	}

	_canVouch() {
		if (!this._viewer) return false;
		// Owners can't review their own agent — that would be self-promotion
		// noise and the contract may reject it anyway.
		if (this._agent.ownerUserId && this._viewer.id === this._agent.ownerUserId) {
			return false;
		}
		if (typeof window === 'undefined' || !window.ethereum) return false;
		return true;
	}

	async _openVouchDialog() {
		// Inline modal — keeps dependency surface small. Prompts for a 1-5
		// star score and an optional comment.
		const dialog = document.createElement('div');
		dialog.className = 'agent-vouch-modal';
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		dialog.setAttribute('aria-labelledby', 'agent-vouch-title');
		dialog.innerHTML = `
			<div class="agent-vouch-modal__inner">
				<button class="agent-vouch-modal__close" type="button" aria-label="Cancel">×</button>
				<h3 id="agent-vouch-title" class="agent-vouch-modal__title">Vouch on-chain</h3>
				<p class="agent-vouch-modal__desc">
					Submits a signed reputation entry to ERC-8004 on
					${_esc(CHAIN_META[this._agent.chainId]?.name || 'chain')}. Costs gas.
				</p>
				<fieldset class="agent-vouch-modal__rating">
					<legend>Score</legend>
					${[1, 2, 3, 4, 5]
						.map(
							(n) => `
						<label>
							<input type="radio" name="score" value="${n}" ${n === 5 ? 'checked' : ''} />
							${'★'.repeat(n)}
						</label>`,
						)
						.join('')}
				</fieldset>
				<label class="agent-vouch-modal__comment">
					<span>Comment (optional, public, on-chain)</span>
					<input type="text" maxlength="280" placeholder="e.g. Great agent for X" />
				</label>
				<label class="agent-vouch-modal__stake-toggle" style="display:flex;align-items:center;gap:8px;margin-top:12px;cursor:pointer">
					<input type="checkbox" class="agent-vouch-modal__stake-check" />
					Stake ETH (optional, makes reputation economically meaningful)
				</label>
				<div class="agent-vouch-modal__stake-inputs" style="display:none;margin-top:8px">
					<label style="display:block;font-size:13px">
						Amount ETH (min ${MIN_STAKE_ETH})
						<input type="number" class="agent-vouch-modal__stake-amount"
							value="0.01" min="${MIN_STAKE_ETH}" max="10" step="0.001"
							style="display:block;width:120px;margin-top:4px" />
					</label>
					<div class="agent-vouch-modal__stake-usd" style="font-size:12px;color:#888;margin-top:4px"></div>
				</div>
				<div class="agent-vouch-modal__actions">
					<button type="button" class="agent-vouch-modal__cancel">Cancel</button>
					<button type="button" class="agent-vouch-modal__submit">Sign &amp; submit</button>
				</div>
				<p class="agent-vouch-modal__status" role="status" aria-live="polite"></p>
			</div>
		`;
		document.body.appendChild(dialog);

		const close = () => dialog.remove();
		dialog.querySelector('.agent-vouch-modal__close').addEventListener('click', close);
		dialog.querySelector('.agent-vouch-modal__cancel').addEventListener('click', close);
		dialog.addEventListener('click', (e) => {
			if (e.target === dialog) close();
		});

		const submitBtn = dialog.querySelector('.agent-vouch-modal__submit');
		const statusEl = dialog.querySelector('.agent-vouch-modal__status');
		const stakeCheck = dialog.querySelector('.agent-vouch-modal__stake-check');
		const stakeInputs = dialog.querySelector('.agent-vouch-modal__stake-inputs');
		const stakeAmountEl = dialog.querySelector('.agent-vouch-modal__stake-amount');
		const stakeUsdEl = dialog.querySelector('.agent-vouch-modal__stake-usd');

		stakeCheck.addEventListener('change', () => {
			stakeInputs.style.display = stakeCheck.checked ? 'block' : 'none';
		});

		const updateUsdEstimate = async () => {
			const eth = parseFloat(stakeAmountEl.value) || 0;
			const price = await fetchEthPriceUsd();
			stakeUsdEl.textContent = price ? `≈ $${(eth * price).toFixed(2)} USD` : '';
		};
		stakeAmountEl.addEventListener('input', updateUsdEstimate);

		submitBtn.addEventListener('click', async () => {
			const score = Number(dialog.querySelector('input[name="score"]:checked')?.value || 0);
			const comment = dialog.querySelector('.agent-vouch-modal__comment input').value.trim();
			const useStake = stakeCheck.checked;
			const stakeEth = useStake ? parseFloat(stakeAmountEl.value) || 0 : 0;

			if (useStake && stakeEth < MIN_STAKE_ETH) {
				statusEl.textContent = `Minimum stake is ${MIN_STAKE_ETH} ETH.`;
				return;
			}

			submitBtn.disabled = true;
			statusEl.textContent = 'Connecting wallet…';

			try {
				const provider = new BrowserProvider(window.ethereum);
				const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
				if (!accounts || !accounts.length) throw new Error('Wallet returned no account');

				const network = await provider.getNetwork();
				if (Number(network.chainId) !== this._agent.chainId) {
					statusEl.textContent = `Switching network to ${
						CHAIN_META[this._agent.chainId]?.name || 'target chain'
					}…`;
					await switchChain(this._agent.chainId);
				}

				const signer = await provider.getSigner();
				statusEl.textContent = 'Sign transaction in your wallet…';

				let txHash;
				if (useStake) {
					const stakeWei = BigInt(Math.round(stakeEth * 1e18));
					txHash = await stakeReputation({
						agentId: this._agent.erc8004AgentId,
						score,
						comment,
						stakeWei,
						signer,
						chainId: this._agent.chainId,
					});
				} else {
					txHash = await submitReputation({
						agentId: this._agent.erc8004AgentId,
						score,
						comment,
						signer,
						chainId: this._agent.chainId,
					});
				}

				statusEl.innerHTML = `Submitted ✓ <a href="${_esc(
					txExplorerUrl(this._agent.chainId, txHash),
				)}" target="_blank" rel="noopener noreferrer">view tx</a>`;

				// Refresh stats in the background — the chain reflects new state on the next block.
				setTimeout(() => this._refresh().catch(() => {}), 4000);
				setTimeout(close, 2400);
			} catch (err) {
				if (_isUserRejection(err)) {
					statusEl.textContent = 'Cancelled.';
				} else {
					statusEl.textContent = `Failed: ${err?.shortMessage || err?.message || 'unknown error'}`;
				}
				submitBtn.disabled = false;
			}
		});
	}
}

function _isUserRejection(err) {
	if (!err) return false;
	if (err.code === 4001 || err.code === 'ACTION_REJECTED') return true;
	return /user rejected|user denied|rejected by user/i.test(err.message || '');
}

function _fmtAvg(avg) {
	if (!avg) return '0.0';
	if (avg <= 5) return avg.toFixed(1) + ' / 5';
	if (avg <= 100) return Math.round(avg) + ' / 100';
	return String(Math.round(avg));
}

function _score(n) {
	const x = Math.max(0, Math.min(5, Math.round(Number(n))));
	return '★'.repeat(x) + '☆'.repeat(5 - x);
}

function _shortAddr(addr) {
	if (!addr || typeof addr !== 'string' || addr.length < 10) return addr || '';
	return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function _esc(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
