/**
 * OnchainDeployButton: the one-click "Deploy on-chain" chip.
 *
 * Drives the unified prep → sign → confirm pipeline (src/onchain/deploy.js →
 * /api/agents/onchain/*) against any chain in the chain-ref registry (CAIP-2
 * keyed: Solana, EVM, and any future family share one dropdown).
 *
 * The persisted wire shape for `agent.onchain` is snake_case (`tx_hash`,
 * `onchain_id`, `contract_or_mint`: see api/agents/onchain/[action].js and
 * src/onchain/README.md). Every read in this file goes through
 * `normalizeOnchain()` so a page reload always rehydrates the success chip
 * instead of offering a second (paid) mint.
 *
 * Mounting:
 *   const btn = new OnchainDeployButton({ agent, container });
 *   btn.mount();
 */

import { CHAIN_META } from '../erc8004/chain-meta.js';
import { REGISTRY_DEPLOYMENTS } from '../erc8004/abi.js';
import {
	buildRegistry,
	groupRegistry,
	entryByCaip2,
	toCaip2,
	fromCaip2,
	evm,
} from './chain-ref.js';
import { deployAgent } from './deploy.js';
import { isUserRejection } from './adapters/index.js';
import { log } from '../shared/log.js';

// Solana mainnet-beta. Deploying here mints the agent as a Metaplex Core asset
// (see api/agents/onchain prepSolana), which is our default on-chain home.
const DEFAULT_REF_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

const STEP_LABELS = {
	connect: 'Connecting wallet',
	prep: 'Preparing manifest',
	sign: 'Sign tx',
	confirm: 'Confirming on-chain',
	save: 'Saving',
};
const STEP_ORDER = ['connect', 'prep', 'sign', 'confirm', 'save'];

// Faucet links for testnets where users commonly run out of gas.
const FAUCETS = {
	84532: 'https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet',
	11155111: 'https://sepoliafaucet.com/',
	421614: 'https://www.alchemy.com/faucets/arbitrum-sepolia',
	11155420: 'https://app.optimism.io/faucet',
	80002: 'https://faucet.polygon.technology/',
	43113: 'https://faucet.avax.network/',
	97: 'https://testnet.bnbchain.org/faucet-smart',
};

/**
 * Canonicalize an `onchain` block to the snake_case wire shape, accepting the
 * legacy camelCase shape written by pre-2026-08 client code. Returns null when
 * the block has no usable tx reference.
 */
export function normalizeOnchain(onchain) {
	if (!onchain || typeof onchain !== 'object') return null;
	const tx_hash = onchain.tx_hash ?? onchain.txHash ?? null;
	const chain = onchain.chain ?? null;
	if (!tx_hash || !chain) return null;
	return {
		...onchain,
		chain,
		tx_hash,
		onchain_id: onchain.onchain_id ?? onchain.onchainId ?? null,
		contract_or_mint: onchain.contract_or_mint ?? onchain.contractOrMint ?? null,
	};
}

function _esc(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function _isInsufficientFunds(err) {
	if (!err) return false;
	if (err.code === 'INSUFFICIENT_FUNDS') return true;
	if (err?.info?.error?.code === -32000) {
		return /insufficient funds/i.test(err?.info?.error?.message || '');
	}
	return /insufficient funds|insufficient balance|insufficient lamports|not enough.*(funds|sol)/i.test(err.message || '');
}

function _isReplacementUnderpriced(err) {
	if (!err) return false;
	if (err.code === 'REPLACEMENT_UNDERPRICED') return true;
	return /replacement.*underpriced|already known|nonce too low/i.test(err.message || '');
}

// The chain param /mint-success understands: a Solana cluster sentinel or a
// bare EVM chainId (pages/mint-success.html parses exactly these two forms).
function _mintSuccessChainParam(ref) {
	if (ref.family === 'solana') return ref.cluster === 'devnet' ? 'solana-devnet' : 'solana-mainnet';
	return String(ref.chainId);
}

export class OnchainDeployButton {
	/**
	 * @param {object} opts
	 * @param {object} opts.agent
	 * @param {HTMLElement} opts.container
	 * @param {string} [opts.preferredChain]   CAIP-2 string. Defaults to Solana mainnet (Metaplex Core).
	 * @param {boolean} [opts.reveal]          Redirect to the /mint-success cinematic
	 *                                          reveal after a successful deploy (default true).
	 */
	constructor({ agent, container, preferredChain = DEFAULT_REF_CAIP2, reveal = true }) {
		this._agent = agent;
		this._container = container;
		this._registry = buildRegistry(CHAIN_META, REGISTRY_DEPLOYMENTS);
		this._refCaip2 = preferredChain;
		this._reveal = reveal;
		this._root = null;
	}

	mount() {
		this._root = document.createElement('div');
		this._root.className = 'deploy-button-root';
		this._container.appendChild(this._root);
		this._render();
	}

	unmount() {
		this._root?.remove();
		this._root = null;
	}

	// ── Render ─────────────────────────────────────────────────────────────

	_render() {
		if (!this._root) return;
		const onchain = normalizeOnchain(this._agent.onchain);
		if (onchain) {
			const entry = entryByCaip2(this._registry, onchain.chain);
			if (entry) {
				this._renderSuccessChip(entry, onchain.tx_hash, onchain.contract_or_mint);
				return;
			}
		}
		const entry = entryByCaip2(this._registry, this._refCaip2);
		if (!entry) {
			this._renderDisabled('Selected chain is not configured');
			return;
		}
		this._renderDeployButton();
	}

	_renderDeployButton() {
		const { mainnets, testnets } = groupRegistry(this._registry);
		const optsHtml = (entries) =>
			entries
				.map((e) => {
					const c = toCaip2(e.ref);
					return `<option value="${_esc(c)}"${c === this._refCaip2 ? ' selected' : ''}>${_esc(e.name)}</option>`;
				})
				.join('');

		this._root.innerHTML = `
			<div class="deploy-chain-row">
				<select class="deploy-chain-select" aria-label="Target chain">
					<optgroup label="Mainnets">${optsHtml(mainnets)}</optgroup>
					<optgroup label="Testnets">${optsHtml(testnets)}</optgroup>
				</select>
				<button class="deploy-btn" title="Deploy this agent on-chain">
					&#x2B22; Deploy on-chain
				</button>
			</div>
		`;
		const sel = this._root.querySelector('.deploy-chain-select');
		sel.addEventListener('change', (ev) => {
			this._refCaip2 = ev.target.value;
		});
		this._root.querySelector('.deploy-btn').addEventListener('click', () => this._start());
	}

	_renderDisabled(msg) {
		this._root.innerHTML = `
			<button class="deploy-btn deploy-btn--disabled" disabled title="${_esc(msg)}">
				&#x2B22; Deploy on-chain
			</button>
			<span class="deploy-tooltip">${_esc(msg)}</span>
		`;
	}

	_renderProgress(activeStep) {
		const idx = STEP_ORDER.indexOf(activeStep);
		const html = STEP_ORDER.map((s, i) => {
			const cls = i < idx ? 'done' : i === idx ? 'active' : 'pending';
			return `<span class="progress-step progress-step--${cls}">${_esc(STEP_LABELS[s])}</span>`;
		}).join('<span class="progress-sep" aria-hidden="true">&#x2192;</span>');
		this._root.innerHTML = `
			<div class="deploy-progress" role="status" aria-live="polite">
				${html}
			</div>
		`;
	}

	_renderError(msg, action) {
		// Every error state keeps a way back to the deploy button: an external
		// action (install a wallet, open a faucet) never becomes a one-way door.
		const actionHtml = action
			? `<button class="deploy-action-btn">${_esc(action.label)}</button>` +
				`<button class="deploy-action-btn deploy-action-btn--reset">Try again</button>`
			: '<button class="deploy-action-btn deploy-action-btn--reset">Try again</button>';
		this._root.innerHTML = `
			<div class="deploy-error" role="alert">
				<span class="deploy-error-msg" title="${_esc(msg)}">${_esc(msg)}</span>
				${actionHtml}
			</div>
		`;
		if (action) {
			this._root.querySelector('.deploy-action-btn').addEventListener('click', action.handler);
		}
		this._root
			.querySelector('.deploy-action-btn--reset')
			.addEventListener('click', () => this._renderDeployButton());
	}

	_renderSuccessChip(entry, txHash, contractOrMint) {
		// Prefer the tx explorer link — it survives across chains and works for
		// both EVM (tx hash) and Solana (signature).
		const url = entry.explorerTx(txHash);
		this._root.innerHTML = `
			<a class="deploy-chip deploy-chip--success" href="${_esc(url)}" target="_blank" rel="noopener noreferrer"
			   aria-label="View on ${_esc(entry.name)} explorer">
				&#x2B22; On-chain on ${_esc(entry.name)} &middot; view on explorer
			</a>
		`;
	}

	// ── Drive ──────────────────────────────────────────────────────────────

	async _start() {
		// First-time deployers get the plain-language wallet/fees explainer before
		// any wallet prompt; returning users pass straight through. Lazy-loaded.
		try {
			const { ensureOnchainPrimer } = await import('../shared/onchain-primer.js');
			if (!(await ensureOnchainPrimer({ action: 'deploy' }))) return;
		} catch (err) {
			log.warn('[deploy-button] onchain primer unavailable', err);
		}

		let ref;
		try {
			ref = fromCaip2(this._refCaip2);
		} catch (e) {
			this._renderError(`Invalid chain: ${e.message}`);
			return;
		}

		// A deploy mints the agent's identity + avatar; without a body the mint
		// would be a hollow asset. Guard on every family (Solana included).
		if (!this._agent.avatarId && !this._agent.avatar_id) {
			this._renderError('This agent has no avatar attached. Add a body before deploying.', {
				label: 'Open editor',
				handler: () => (window.location.href = `/app?agent=${encodeURIComponent(this._agent.id)}`),
			});
			return;
		}

		try {
			const result = await deployAgent({
				agent: this._agent,
				ref,
				onProgress: (step) => this._renderProgress(step),
			});
			// Persist the canonical snake_case wire shape locally: the same block
			// the server just wrote: so badges, guards, and rehydration all agree.
			this._agent.onchain = normalizeOnchain(result.agent?.onchain) ?? {
				chain: toCaip2(result.ref),
				family: ref.family,
				tx_hash: result.txHash,
				onchain_id: result.onchainId ?? null,
				contract_or_mint: result.contractOrMint ?? null,
			};
			const entry = entryByCaip2(this._registry, this._refCaip2);
			this._renderSuccessChip(entry, result.txHash, result.contractOrMint);

			if (this._reveal && this._agent.id) {
				// Brief success flash, then the cinematic reveal page.
				const q = new URLSearchParams({
					id: this._agent.id,
					tx: result.txHash || '',
					asset: result.contractOrMint || '',
					chain: _mintSuccessChainParam(ref),
				});
				setTimeout(() => {
					window.location.href = `/mint-success?${q}`;
				}, 900);
			}
		} catch (err) {
			if (isUserRejection(err)) return this._renderDeployButton();
			if (err.code === 'NO_PROVIDER') {
				this._renderError(err.message, {
					label: 'Install wallet',
					handler: () => window.open(err.installUrl, '_blank', 'noopener'),
				});
				return;
			}
			if (_isInsufficientFunds(err)) {
				const faucetUrl = ref.family === 'evm' ? FAUCETS[ref.chainId] : null;
				this._renderError(
					ref.family === 'solana'
						? 'Not enough SOL in this wallet to cover the mint.'
						: 'Insufficient funds in this wallet.',
					faucetUrl
						? { label: 'Get testnet funds', handler: () => window.open(faucetUrl, '_blank', 'noopener') }
						: null,
				);
				return;
			}
			if (_isReplacementUnderpriced(err)) {
				this._renderError(
					'A pending transaction from this wallet is blocking the new one. Cancel it in your wallet and try again.',
				);
				return;
			}
			this._renderError(err.message || 'Deploy failed.');
		}
	}
}

// Re-export building blocks for callers that want to compose differently.
export { evm, fromCaip2, toCaip2 } from './chain-ref.js';
export { deployAgent } from './deploy.js';
