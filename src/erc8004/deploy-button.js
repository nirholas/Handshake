/**
 * DeployButton — minimal "Deploy on-chain" UI for an agent's home page.
 *
 * Flow (matches the canonical 3-step pipeline used by /deploy):
 *   1. POST /api/agents/register-prep    — server pins a manifest to IPFS,
 *                                          returns { cid, metadataURI, prepId }.
 *      The prepId is cached in localStorage so retries reuse the same prep
 *      record (idempotency: never pin twice on a flaky network).
 *   2. registry.register(metadataURI)    — user signs the on-chain mint.
 *   3. POST /api/agents/register-confirm — server verifies the receipt against
 *                                          the prep record and upserts
 *                                          agent_identities.{chain_id,
 *                                          erc8004_agent_id, erc8004_registry,
 *                                          registration_cid}.
 *
 * Distinct from register-ui.js (the full multi-tab wizard) — this is the
 * one-click chip surfaced on the agent's profile page for the owner.
 */

import { ensureWallet, getIdentityRegistry } from './agent-registry.js';
import { REGISTRY_DEPLOYMENTS } from './abi.js';
import {
	CHAIN_META,
	supportedChainIdsGrouped,
	switchChain,
	addressExplorerUrl,
} from './chain-meta.js';
import { runSolanaDeploy, solanaTxExplorerUrl, detectSolanaWallet } from './solana-deploy.js';
import { openVanityModal } from './vanity-modal.js';
import { log } from '../shared/log.js';

const VANITY_LS_KEY = (agentId) => `3dagent:vanity-prefix:${agentId}`;
const VANITY_TTL_MS = 30 * 60 * 1000;

function _loadVanity(agentId) {
	try {
		const raw = localStorage.getItem(VANITY_LS_KEY(agentId));
		if (!raw) return '';
		const { prefix, ts } = JSON.parse(raw);
		if (Date.now() - ts > VANITY_TTL_MS) return '';
		return prefix || '';
	} catch { return ''; }
}
function _saveVanity(agentId, prefix) {
	try {
		if (prefix) localStorage.setItem(VANITY_LS_KEY(agentId), JSON.stringify({ prefix, ts: Date.now() }));
		else localStorage.removeItem(VANITY_LS_KEY(agentId));
	} catch {}
}

// Sentinel chain selections for non-EVM targets. The chain dropdown stores
// these as option values; _chainId may be a number (EVM chainId) or one of
// these strings.
const SOLANA_MAINNET = 'solana-mainnet';
const SOLANA_DEVNET = 'solana-devnet';
const SOLANA_LABELS = {
	[SOLANA_MAINNET]: 'Solana',
	[SOLANA_DEVNET]: 'Solana Devnet',
};
function _isSolana(id) {
	return id === SOLANA_MAINNET || id === SOLANA_DEVNET;
}
function _solanaNetwork(id) {
	return id === SOLANA_DEVNET ? 'devnet' : 'mainnet';
}

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

const WALLET_INSTALL_URL = 'https://metamask.io/download/';

function _hasWallet() {
	return typeof window !== 'undefined' && !!window.ethereum;
}

// localStorage key for caching the active prep record across retries.
function _prepCacheKey(agentId) {
	return `3dagent:deploy-prep:${agentId}`;
}

export class DeployButton {
	/**
	 * @param {object} opts
	 * @param {object} opts.agent              Agent record. Required: id, name.
	 *                                          Optional but recommended for a
	 *                                          richer manifest: avatarId,
	 *                                          description, skills.
	 * @param {HTMLElement} opts.container     Where to mount.
	 * @param {number|string} [opts.preferredChainId] Defaults to Solana mainnet.
	 */
	constructor({ agent, container, preferredChainId = SOLANA_MAINNET }) {
		this._agent = agent;
		this._container = container;
		this._chainId = preferredChainId;
		this._root = null;
	}

	mount() {
		this._root = document.createElement('div');
		this._root.className = 'deploy-button-root';
		this._container.appendChild(this._root);
		this._render();
	}

	unmount() {
		if (this._root) {
			this._root.remove();
			this._root = null;
		}
	}

	_render() {
		if (!this._root) return;
		const agent = this._agent;

		if (agent.chainId && agent.txHash) {
			this._renderSuccessChip(agent.chainId, agent.txHash, agent.contractAddress);
		} else if (!_isSolana(this._chainId) && !REGISTRY_DEPLOYMENTS[this._chainId]) {
			this._renderDisabled('No registry on this chain');
		} else {
			this._renderDeployButton();
		}
	}

	_renderDeployButton() {
		const { mainnets, testnets } = supportedChainIdsGrouped();
		const evmOptionsFor = (ids) =>
			ids
				.map(
					(id) =>
						`<option value="${id}"${id === this._chainId ? ' selected' : ''}>${_esc(
							CHAIN_META[id]?.name || `Chain ${id}`,
						)}</option>`,
				)
				.join('');
		const solanaOptionFor = (id) =>
			`<option value="${id}"${id === this._chainId ? ' selected' : ''}>${_esc(SOLANA_LABELS[id])}</option>`;

		const showVanity = _isSolana(this._chainId);
		// Hydrate from localStorage on first render.
		if (this._vanityPrefix == null) this._vanityPrefix = _loadVanity(this._agent?.id) || '';

		this._root.innerHTML = `
			<div class="deploy-chain-row">
				<select class="deploy-chain-select" title="Choose chain to deploy to" aria-label="Target chain">
					<optgroup label="Solana (recommended)">${solanaOptionFor(SOLANA_MAINNET)}${solanaOptionFor(SOLANA_DEVNET)}</optgroup>
					<optgroup label="EVM Mainnets">${evmOptionsFor(mainnets)}</optgroup>
					<optgroup label="EVM Testnets">${evmOptionsFor(testnets)}</optgroup>
				</select>
				<button class="deploy-btn" title="Deploy this agent as an ERC-8004 token on-chain">
					&#x2B22; Deploy on-chain
				</button>
			</div>
			<div class="deploy-vanity-link-row" style="${showVanity ? '' : 'display:none'};margin-top:4px;font-size:12px;">
				<button type="button" class="deploy-vanity-link"
					style="background:none;border:none;color:rgba(255,255,255,0.6);cursor:pointer;padding:0;font-size:12px;text-decoration:underline">
					${this._vanityPrefix
						? `&#10024; Vanity: <span style="font-family:monospace;font-weight:600">${_esc(this._vanityPrefix)}</span> &middot; change`
						: '&#10024; Customize address (optional)'}
				</button>
			</div>
		`;

		const select = this._root.querySelector('.deploy-chain-select');
		const vanityLinkRow = this._root.querySelector('.deploy-vanity-link-row');
		const vanityLink = this._root.querySelector('.deploy-vanity-link');

		vanityLink.addEventListener('click', async () => {
			const chosen = await openVanityModal({
				agentName: this._agent?.name || '',
				initial: this._vanityPrefix || '',
			});
			if (chosen === null) return; // dismissed

			// Modal returns either a string (prefix to grind in browser) or
			// { prefix, secretKey } when the user pasted a CLI-ground keypair.
			if (chosen && typeof chosen === 'object') {
				this._vanityPrefix = chosen.prefix || '';
				this._preGroundSecretKey = chosen.secretKey;
			} else {
				this._vanityPrefix = chosen;
				this._preGroundSecretKey = null;
			}
			_saveVanity(this._agent?.id, this._vanityPrefix);
			this._renderDeployButton(); // re-render to update label
		});

		select.addEventListener('change', async (ev) => {
			const raw = ev.target.value;
			const newChainId = _isSolana(raw) ? raw : Number(raw);
			this._chainId = newChainId;
			vanityLinkRow.style.display = _isSolana(newChainId) ? '' : 'none';
			if (!_isSolana(newChainId) && _hasWallet()) {
				select.disabled = true;
				try {
					await switchChain(newChainId);
				} catch (err) {
					if (!_isUserRejection(err)) {
						log.warn('[deploy-button] switchChain failed:', err?.message);
					}
				} finally {
					select.disabled = false;
				}
			}
		});

		this._root
			.querySelector('.deploy-btn')
			.addEventListener('click', () => this._startDeploy());
	}

	_renderDisabled(reason) {
		this._root.innerHTML = `
			<button class="deploy-btn deploy-btn--disabled" disabled title="${_esc(reason)}">
				&#x2B22; Deploy on-chain
			</button>
			<span class="deploy-tooltip">${_esc(reason)}</span>
		`;
	}

	_renderSuccessChip(chainId, txHash, contractAddress, vanityPrefix) {
		let chainName, explorerUrl;
		if (_isSolana(chainId)) {
			const network = _solanaNetwork(chainId);
			chainName = SOLANA_LABELS[chainId];
			explorerUrl = solanaTxExplorerUrl(network, txHash);
		} else {
			const meta = CHAIN_META[chainId];
			chainName = meta ? meta.name : `Chain ${chainId}`;
			// Use the registry contract URL on the explorer — it's the most
			// universally available link, since some chains' explorers don't
			// surface tx hashes for arbitrary contracts.
			explorerUrl = contractAddress ? addressExplorerUrl(chainId, contractAddress) : '#';
		}
		const vanityNote = vanityPrefix
			? ` &middot; <span style="background:linear-gradient(90deg,#ffd54f,#ff8a65);color:#1a1a1a;padding:0 6px;border-radius:999px;font-weight:600">&#10024; ${_esc(vanityPrefix)}</span>`
			: '';
		this._root.innerHTML = `
			<a class="deploy-chip deploy-chip--success" href="${_esc(explorerUrl)}" target="_blank" rel="noopener noreferrer"
			   aria-label="View this agent's registry on the ${_esc(chainName)} block explorer">
				&#x2B22; On-chain on ${_esc(chainName)}${vanityNote} &middot; view on explorer
			</a>
		`;
	}

	_renderProgress(steps, activeIdx, extra) {
		// Inject keyframes once into the document head
		if (!document.getElementById('db-progress-kf')) {
			const style = document.createElement('style');
			style.id = 'db-progress-kf';
			style.textContent = `
				@keyframes db-pulse { 0%,100%{box-shadow:0 0 0 0 rgba(99,102,241,.55)} 50%{box-shadow:0 0 0 10px rgba(99,102,241,0)} }
				@keyframes db-spin  { to{transform:rotate(360deg)} }
				@keyframes db-flow  { to{background-position:0 -16px} }
				@keyframes db-rise  { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:none} }
				@keyframes db-blink { 0%,100%{opacity:.35} 50%{opacity:1} }
				.db-step{display:flex;align-items:center;gap:11px;padding:11px 14px;border-radius:10px;font-size:13px;transition:background .25s,border-color .25s,color .25s,opacity .25s}
				.db-step--done{background:rgba(99,102,241,.92);border:1px solid rgba(99,102,241,.55);color:#fff;font-weight:600;opacity:1}
				.db-step--active{background:rgba(99,102,241,.14);border:1px solid rgba(99,102,241,.85);color:#c7d2fe;font-weight:700;opacity:1;animation:db-pulse 1.7s ease-in-out infinite}
				.db-step--pending{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);color:#5b6270;font-weight:500;opacity:.6}
				.db-connector{width:2px;height:16px;margin-left:27px;border-radius:2px}
				.db-connector--filled{background:rgba(99,102,241,.7)}
				.db-connector--flow{background:linear-gradient(180deg,rgba(99,102,241,.85) 0 8px,transparent 8px 16px);background-size:2px 16px;animation:db-flow .55s linear infinite}
				.db-connector--idle{background:rgba(255,255,255,.07)}
				.db-status{margin-top:14px;font-size:16px;font-weight:700;letter-spacing:-.01em;line-height:1.2;background:linear-gradient(90deg,#c7d2fe,#a5b4fc);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:db-rise .35s ease both}
				.db-status--done{background:linear-gradient(90deg,#a7f3d0,#6ee7b7)}
				.db-cancel{margin-top:14px;font-size:12.5px;font-weight:600;background:transparent;border:1px solid rgba(255,255,255,.16);border-radius:8px;padding:8px 16px;cursor:pointer;color:#9ca3af;transition:border-color .15s,color .15s,background .15s}
				.db-cancel:hover{border-color:rgba(248,113,113,.6);color:#fca5a5;background:rgba(248,113,113,.08)}
				.db-cancel:focus-visible{outline:2px solid rgba(165,180,252,.8);outline-offset:2px}
				.db-spinner{animation:db-spin .85s linear infinite}
				.db-detail--busy{animation:db-blink 1.6s ease-in-out infinite}
				@media (prefers-reduced-motion: reduce){
					.db-step--active{animation:none}
					.db-connector--flow{animation:none;background:rgba(99,102,241,.7)}
					.db-status{animation:none}
					.db-detail--busy{animation:none}
				}
			`;
			document.head.appendChild(style);
		}

		const isDone = activeIdx >= steps.length;
		const liveText = isDone ? 'Deployed on-chain' : `${steps[activeIdx]}…`;

		const rows = steps.map((s, i) => {
			const done   = i < activeIdx;
			const active = i === activeIdx;
			const cls = done ? 'db-step--done' : active ? 'db-step--active' : 'db-step--pending';
			const icon = done
				? `<span style="font-size:16px;line-height:1;width:18px;text-align:center;flex-shrink:0">✓</span>`
				: active
					? `<svg width="18" height="18" viewBox="0 0 18 18" class="db-spinner" style="flex-shrink:0" aria-hidden="true"><circle cx="9" cy="9" r="7" fill="none" stroke="rgba(165,180,252,.22)" stroke-width="2"/><path d="M9 2A7 7 0 0 1 16 9" fill="none" stroke="#c7d2fe" stroke-width="2" stroke-linecap="round"/></svg>`
					: `<span style="width:18px;height:18px;flex-shrink:0;display:inline-block;border-radius:50%;border:1.5px solid rgba(255,255,255,.1)"></span>`;
			const tile = `<div class="db-step ${cls}">${icon}<span>${_esc(s)}</span></div>`;
			if (i === steps.length - 1) return tile;
			// Connector below this tile: filled if next step reached, flowing if
			// this step is the active one (work in progress), idle otherwise.
			const conn = done
				? (i + 1 <= activeIdx ? 'db-connector--filled' : 'db-connector--flow')
				: active
					? 'db-connector--flow'
					: 'db-connector--idle';
			return `${tile}<div class="db-connector ${conn}" aria-hidden="true"></div>`;
		}).join('');

		this._root.innerHTML = `
			<div role="status" aria-live="polite" aria-label="Deployment progress"
				style="display:flex;flex-direction:column;align-items:stretch;gap:0">
				${rows}
			</div>
			<div class="db-status ${isDone ? 'db-status--done' : ''}">${_esc(liveText)}</div>
			<div class="deploy-progress-detail${extra?.text ? ' db-detail--busy' : ''}" aria-live="polite"
				style="margin-top:7px;font-size:11.5px;color:#6b7280;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;min-height:1.2em;letter-spacing:.01em">
				${extra?.text ? _esc(extra.text) : ''}
			</div>
			${extra?.cancelable ? `<button class="db-cancel deploy-cancel-btn" type="button">⊘ Stop grinding</button>` : ''}
		`;
		if (extra?.onCancel) {
			const cb = this._root.querySelector('.deploy-cancel-btn');
			if (cb) cb.addEventListener('click', extra.onCancel);
		}
	}

	_renderError(msg, action) {
		const actionHtml = action
			? `<button class="deploy-action-btn">${_esc(action.label)}</button>`
			: '<button class="deploy-action-btn deploy-action-btn--reset">Try again</button>';
		this._root.innerHTML = `
			<div class="deploy-error" role="alert">
				<span class="deploy-error-msg" title="${_esc(msg)}">${_esc(msg)}</span>
				${actionHtml}
			</div>
		`;
		const btn = this._root.querySelector('.deploy-action-btn');
		if (action) {
			btn.addEventListener('click', action.handler);
		} else {
			btn.addEventListener('click', () => this._renderDeployButton());
		}
	}

	// ─── Deploy state machine ──────────────────────────────────────────────

	async _startSolanaDeploy() {
		if (!detectSolanaWallet()) {
			this._renderError('No Solana wallet detected. Install Phantom to continue.', {
				label: 'Install Phantom',
				handler: () => window.open('https://phantom.app', '_blank', 'noopener'),
			});
			return;
		}

		const agent = this._agent;
		if (!agent?.id) {
			this._renderError('This agent is missing an ID — cannot deploy.');
			return;
		}

		const network = _solanaNetwork(this._chainId);
		const vanityPrefix = (this._vanityPrefix || '').trim();
		const preGround    = this._preGroundSecretKey || null;
		const willGrind    = vanityPrefix && !preGround;
		const steps = preGround
			? ['Loading pre-ground keypair', 'Sign tx', 'Confirming on-chain', 'Saving']
			: willGrind
				? ['Grinding vanity address', 'Sign tx', 'Confirming on-chain', 'Saving']
				: ['Connecting wallet', 'Sign tx', 'Confirming on-chain', 'Saving'];
		const abort = new AbortController();
		this._renderProgress(steps, 0, willGrind ? {
			text: `searching for "${vanityPrefix}…"`,
			cancelable: true,
			onCancel: () => abort.abort(),
		} : preGround ? {
			text: `using CLI-ground keypair${vanityPrefix ? ` for "${vanityPrefix}…"` : ''}`,
		} : undefined);

		let result;
		try {
			result = await runSolanaDeploy({
				agent,
				network,
				vanity: (vanityPrefix || preGround) ? {
					prefix: vanityPrefix || undefined,
					preGroundSecretKey: preGround || undefined,
					signal: abort.signal,
					onProgress: willGrind ? ({ attempts, rate, eta }) => {
						const detail = this._root.querySelector('.deploy-progress-detail');
						if (detail) {
							detail.textContent =
								`🔍 "${vanityPrefix}…"  ${attempts.toLocaleString()} tries · ${Math.round(rate).toLocaleString()}/s · eta ${eta}`;
						}
					} : undefined,
				} : undefined,
			});
			this._renderProgress(steps, 1);
			this._renderProgress(steps, 3);
		} catch (err) {
			if (_isUserRejection(err) || err?.name === 'AbortError') return this._renderDeployButton();
			if (err.code === 'forbidden') {
				this._renderError(
					'Your Solana wallet is not linked to this account. Sign in with your Solana wallet first.',
					{
						label: 'Open wallet sign-in',
						handler: () => (window.location.href = '/login'),
					},
				);
				return;
			}
			if (err.code === 'payment_required') {
				this._renderError(
					`${err.message || 'Paid plan required'} — upgrade to use 5+ character vanity prefixes.`,
					{
						label: 'View plans',
						handler: () => (window.location.href = '/pricing'),
					},
				);
				return;
			}
			this._renderError(`Solana deploy failed: ${_humanError(err)}`);
			return;
		}

		this._agent.chainId = this._chainId;
		this._agent.txHash = result.txSignature;
		this._agent.contractAddress = result.assetPubkey;
		_saveVanity(this._agent?.id, ''); // clear after successful deploy
		this._preGroundSecretKey = null;
		this._renderSuccessChip(this._chainId, result.txSignature, result.assetPubkey, result.vanityPrefix);

		// Redirect to the cinematic reveal page after a brief success flash
		const agentId    = this._agent.id;
		const txSig      = result.txSignature || '';
		const assetPk    = result.assetPubkey  || '';
		const chain      = this._chainId;
		setTimeout(() => {
			window.location.href = `/mint-success?id=${encodeURIComponent(agentId)}&tx=${encodeURIComponent(txSig)}&asset=${encodeURIComponent(assetPk)}&chain=${encodeURIComponent(chain)}`;
		}, 900);
	}

	async _startDeploy() {
		// Newcomers deploying on-chain for the first time get the plain-language
		// wallet/USDC/fees explainer + guided setup before any wallet prompt.
		// Returning/ready users pass straight through. Lazy-loaded.
		try {
			const { ensureOnchainPrimer } = await import('../shared/onchain-primer.js');
			if (!(await ensureOnchainPrimer({ action: 'deploy' }))) return;
		} catch (err) {
			log.warn('[deploy-button] onchain primer unavailable', err);
		}

		if (_isSolana(this._chainId)) return this._startSolanaDeploy();

		if (!_hasWallet()) {
			this._renderError('No wallet detected. Install one to deploy on-chain.', {
				label: 'Install MetaMask',
				handler: () => window.open(WALLET_INSTALL_URL, '_blank', 'noopener'),
			});
			return;
		}

		const agent = this._agent;
		if (!agent?.id) {
			this._renderError('This agent is missing an ID — cannot deploy.');
			return;
		}
		if (!agent.avatarId && !agent.avatar_id) {
			this._renderError('This agent has no avatar attached. Add a body before deploying.', {
				label: 'Open editor',
				handler: () =>
					(window.location.href = `/app?agent=${encodeURIComponent(agent.id)}`),
			});
			return;
		}

		const steps = ['Preparing manifest', 'Sign tx', 'Confirming on-chain', 'Saving'];
		this._renderProgress(steps, 0);

		// ── Step 0: prep + IPFS pin ────────────────────────────────────────
		// Reuse a recent prep record so retries don't re-pin and don't waste
		// time. Server expires prep records after 1h.
		let prep;
		try {
			prep = await this._getOrCreatePrep();
		} catch (err) {
			this._renderError(`Could not prepare manifest: ${err.message}`);
			return;
		}

		// ── Connect wallet on the selected chain ───────────────────────────
		let signer, walletChainId;
		try {
			({ signer, chainId: walletChainId } = await ensureWallet());
		} catch (err) {
			if (_isUserRejection(err)) return this._renderDeployButton();
			this._renderError(`Wallet connection failed: ${_humanError(err)}`);
			return;
		}

		if (walletChainId !== this._chainId) {
			const targetName = CHAIN_META[this._chainId]?.name || `chain ${this._chainId}`;
			this._renderError(`Wallet is on a different network. Switch to ${targetName}.`, {
				label: `Switch to ${targetName}`,
				handler: async () => {
					try {
						await switchChain(this._chainId);
						this._renderDeployButton();
					} catch (e) {
						if (_isUserRejection(e)) return this._renderDeployButton();
						this._renderError(`Network switch failed: ${_humanError(e)}`);
					}
				},
			});
			return;
		}

		const deployment = REGISTRY_DEPLOYMENTS[walletChainId];
		if (!deployment?.identityRegistry) {
			this._renderDisabled('No ERC-8004 registry deployed on this chain');
			return;
		}

		// ── Step 1: sign tx ────────────────────────────────────────────────
		this._renderProgress(steps, 1);
		const registry = getIdentityRegistry(walletChainId, signer);
		let tx;
		try {
			tx = await registry['register(string)'](prep.metadataURI);
		} catch (err) {
			this._handleSignError(err, walletChainId);
			return;
		}

		// ── Step 2: wait for confirmation ──────────────────────────────────
		this._renderProgress(steps, 2);
		let receipt;
		try {
			receipt = await tx.wait();
		} catch (err) {
			this._renderError(`Transaction reverted: ${_humanError(err)}`);
			return;
		}
		if (receipt?.status !== 1) {
			this._renderError('Transaction failed on-chain.');
			return;
		}

		// Pull the agentId out of the Registered event so the confirm call
		// can cross-check it against the on-chain receipt server-side.
		const onchainAgentId = _parseRegisteredAgentId(receipt, registry);
		if (onchainAgentId == null) {
			this._renderError(
				'Could not parse Registered event from the receipt. The tx is on-chain — please retry "Save".',
				{
					label: 'Retry save',
					handler: () =>
						this._confirmAndFinish(prep, walletChainId, tx, null, deployment),
				},
			);
			return;
		}

		// ── Step 3: server-side confirm (verify + upsert) ──────────────────
		this._renderProgress(steps, 3);
		await this._confirmAndFinish(prep, walletChainId, tx, onchainAgentId, deployment);
	}

	/**
	 * Cache layer for register-prep so retries reuse the same IPFS pin
	 * (idempotent across reloads / network blips).
	 */
	async _getOrCreatePrep() {
		const agent = this._agent;
		const cacheKey = _prepCacheKey(agent.id);

		try {
			const raw = localStorage.getItem(cacheKey);
			if (raw) {
				const cached = JSON.parse(raw);
				if (cached?.prepId && cached?.metadataURI && cached?.expiresAt > Date.now()) {
					return cached;
				}
			}
		} catch {
			/* fall through to a fresh prep */
		}

		const body = {
			name: agent.name || 'Agent',
			description: agent.description || '',
			avatarId: agent.avatarId || agent.avatar_id,
			...(Array.isArray(agent.skills) && agent.skills.length > 0
				? { skills: agent.skills }
				: {}),
		};

		const resp = await fetch('/api/agents/register-prep', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		if (!resp.ok) {
			const data = await resp.json().catch(() => ({}));
			throw new Error(data.error_description || `register-prep returned ${resp.status}`);
		}
		const prep = await resp.json();
		const cached = {
			prepId: prep.prepId,
			cid: prep.cid,
			metadataURI: prep.metadataURI,
			expiresAt: Date.now() + 50 * 60 * 1000, // server keeps prep 1h, expire ours at 50m
		};
		try {
			localStorage.setItem(cacheKey, JSON.stringify(cached));
		} catch {
			/* quota or disabled storage — fine, we just lose retry caching */
		}
		return cached;
	}

	async _confirmAndFinish(prep, chainId, tx, onchainAgentId, deployment) {
		try {
			const resp = await fetch('/api/agents/register-confirm', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					prepId: prep.prepId,
					chainId,
					agentId: String(onchainAgentId ?? 0),
					txHash: tx.hash,
				}),
			});
			if (!resp.ok) {
				const data = await resp.json().catch(() => ({}));
				throw new Error(
					data.error_description || `register-confirm returned ${resp.status}`,
				);
			}
		} catch (err) {
			this._renderError(
				`Mint succeeded on-chain but server save failed: ${err.message}. Reload the page to retry — your tx is at ${tx.hash.slice(0, 10)}…`,
			);
			return;
		}

		// Clear the prep cache — it's been consumed server-side.
		try {
			localStorage.removeItem(_prepCacheKey(this._agent.id));
		} catch {
			/* ignore */
		}

		// Reflect in local agent state and flip to the success chip.
		this._agent.chainId = chainId;
		this._agent.txHash = tx.hash;
		this._agent.contractAddress = deployment.identityRegistry;
		this._agent.erc8004AgentId = onchainAgentId;
		this._renderSuccessChip(chainId, tx.hash, deployment.identityRegistry);

		// Redirect to the cinematic reveal page after a brief success flash
		const agentId = this._agent.id;
		setTimeout(() => {
			window.location.href = `/mint-success?id=${encodeURIComponent(agentId)}&tx=${encodeURIComponent(tx.hash)}&asset=${encodeURIComponent(deployment.identityRegistry || '')}&chain=${encodeURIComponent(chainId)}`;
		}, 900);
	}

	// ─── Error classification ──────────────────────────────────────────────

	_handleSignError(err, chainId) {
		if (_isUserRejection(err)) {
			this._renderDeployButton();
			return;
		}
		if (_isInsufficientFunds(err)) {
			const faucetUrl = FAUCETS[chainId];
			this._renderError('Insufficient funds in this wallet.', {
				label: faucetUrl ? 'Get testnet funds' : 'Try again',
				handler: () => {
					if (faucetUrl) window.open(faucetUrl, '_blank');
					else this._renderDeployButton();
				},
			});
			return;
		}
		if (_isReplacementUnderpriced(err)) {
			this._renderError(
				'A pending transaction from this wallet is blocking the new one. Cancel it in your wallet and try again.',
			);
			return;
		}
		this._renderError(`Transaction failed: ${_humanError(err)}`);
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * EIP-1193 user-rejection detection.
 * Spec: error code 4001 = user rejected request.
 * ethers also wraps errors with `code: 'ACTION_REJECTED'`.
 */
function _isUserRejection(err) {
	if (!err) return false;
	if (err.code === 4001) return true;
	if (err.code === 'ACTION_REJECTED') return true;
	if (err?.info?.error?.code === 4001) return true;
	return /user rejected|user denied|rejected by user|user cancel/i.test(err.message || '');
}

function _isInsufficientFunds(err) {
	if (!err) return false;
	if (err.code === 'INSUFFICIENT_FUNDS') return true;
	if (err?.info?.error?.code === -32000) {
		// Some RPCs surface insufficient funds via -32000 + body text.
		return /insufficient funds/i.test(err?.info?.error?.message || '');
	}
	return /insufficient funds|insufficient balance|not enough.*funds/i.test(err.message || '');
}

function _isReplacementUnderpriced(err) {
	if (!err) return false;
	if (err.code === 'REPLACEMENT_UNDERPRICED') return true;
	return /replacement.*underpriced|already known|nonce too low/i.test(err.message || '');
}

/** Pull a human-readable string from a ProviderError / ethers error. */
function _humanError(err) {
	if (!err) return 'unknown error';
	const inner = err?.info?.error?.message || err?.shortMessage || err?.message;
	return String(inner || 'unknown error')
		.replace(/\s+/g, ' ')
		.slice(0, 240);
}

/** Decode the Registered event's agentId from a confirmed receipt. */
function _parseRegisteredAgentId(receipt, registry) {
	if (!receipt?.logs) return null;
	for (const log of receipt.logs) {
		try {
			const parsed = registry.interface.parseLog(log);
			if (parsed?.name === 'Registered') {
				return Number(parsed.args.agentId);
			}
		} catch {
			/* not our event */
		}
	}
	return null;
}

/** Escape HTML attribute/text content to prevent XSS. */
function _esc(str) {
	return String(str ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
