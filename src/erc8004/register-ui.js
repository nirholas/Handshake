/**
 * ERC-8004 registration UI.
 *
 * Tabbed interface for creating, listing, searching, and auditing ERC-8004
 * agents. Inspired by erc8004.agency but extended with GLB uploads and 3D
 * viewer links specific to 3D-Agent.
 *
 * Tabs:
 *   - Create Agent  (4-step wizard: Identity → Services → Configuration → Deploy)
 *   - My Agents     (owned-by-wallet, current chain)
 *   - Search        (by Agent ID)
 *   - Templates     (pre-fills Create Agent)
 *   - History       (Registered events for the connected wallet)
 *
 * Uses plain DOM — consistent with the rest of the project.
 */

import {
	registerAgent,
	connectWallet,
	eagerConnectWallet,
	onWalletChange,
	pinFile,
	getIdentityRegistry,
	buildRegistrationJSON,
} from './agent-registry.js';
import { glbFileToThumbnail } from './thumbnail.js';
import { DEFAULT_AVATARS, getDefaultAvatar } from './default-avatars.js';
import { REGISTRY_DEPLOYMENTS } from './abi.js';
import { renderBatchTab } from './batch-tab.js';
import { renderQRToCanvas } from './qr.js';
import {
	CHAIN_META,
	switchChain,
	addressExplorerUrl,
	tokenExplorerUrl,
	txExplorerUrl,
	supportedChainIds,
} from './chain-meta.js';
import {
	getReadRegistry,
	listAgentsByOwner,
	listRegisteredEvents,
	getAgentOnchain,
	fetchAgentMetadata,
	findAvatar3D,
	getRegistryVersion,
	getTotalSupply,
} from './queries.js';
import {
	detectInputType,
	resolveByAddress,
	resolveByTxHash,
	resolveENSAddress,
	INPUT_TYPES,
} from './resolve-avatar.js';
import { runSolanaDeploy, solanaTxExplorerUrl, detectSolanaWallet } from './solana-deploy.js';
import {
	getEphemeralAccount,
	registerAgentGaslessAttempt,
	registerAgentSelfPayRetry,
	BSC_TESTNET_CHAIN_ID,
} from './gasless-register.js';
import { onchainBadgeHTML, ensureOnchainBadgeStyles } from '../shared/onchain-badge.js';
import { log } from '../shared/log.js';
ensureOnchainBadgeStyles();

// ───────────────────────────────────────────────────────────────────────────
// Solana sentinels — chain dropdown stores these strings instead of a numeric
// chainId for non-EVM targets. Most EVM-specific code paths early-return when
// _isSolana(this.selectedChainId) is true.
// ───────────────────────────────────────────────────────────────────────────

const SOLANA_MAINNET = 'solana-mainnet';
const SOLANA_DEVNET = 'solana-devnet';
const SOLANA_LABELS = {
	[SOLANA_MAINNET]: 'Solana',
	[SOLANA_DEVNET]: 'Solana Devnet',
};
const _isSolana = (id) => id === SOLANA_MAINNET || id === SOLANA_DEVNET;
const _solanaNetwork = (id) => (id === SOLANA_DEVNET ? 'devnet' : 'mainnet');

/**
 * Map an external `?network=` argument to one of our chain IDs.
 * Accepts canonical Solana strings ("mainnet-beta", "devnet"), bare chain
 * names ("base", "polygon", "bsc"), or numeric EVM chainIds. Returns null
 * when the value is empty or unknown so the caller can fall back.
 */
function _resolveNetworkArg(raw) {
	if (!raw) return null;
	const s = String(raw).trim().toLowerCase();
	if (!s) return null;
	if (s === 'mainnet-beta' || s === 'solana' || s === 'solana-mainnet' || s === 'mainnet')
		return SOLANA_MAINNET;
	if (s === 'devnet' || s === 'solana-devnet') return SOLANA_DEVNET;
	if (/^\d+$/.test(s)) {
		const id = Number(s);
		return REGISTRY_DEPLOYMENTS[id] ? id : null;
	}
	const aliases = {
		ethereum: 1, eth: 1, mainnet_eth: 1,
		optimism: 10, op: 10,
		bsc: 56, bnb: 56,
		polygon: 137, matic: 137, pol: 137,
		base: 8453,
		arbitrum: 42161, arb: 42161,
		avalanche: 43114, avax: 43114,
		linea: 59144, scroll: 534352, celo: 42220,
		'bsc-testnet': 97, sepolia: 11155111,
		'base-sepolia': 84532, 'arbitrum-sepolia': 421614,
	};
	const id = aliases[s];
	return id && REGISTRY_DEPLOYMENTS[id] ? id : null;
}

// ───────────────────────────────────────────────────────────────────────────
// Error classification — turns raw error messages into user-readable copy
// ───────────────────────────────────────────────────────────────────────────

function _classifyDeployError(raw, err = null) {
	const m = String(raw || '').toLowerCase();
	const code = err?.code;
	// Wallet rejection (MetaMask 4001, ethers ACTION_REJECTED, Phantom)
	if (code === 4001 || code === 'ACTION_REJECTED' ||
		/user rejected|user denied|cancelled|reject/i.test(m)) {
		return 'You cancelled the signature request — no transaction was sent. Click Deploy to try again.';
	}
	// Insufficient gas / funds
	if (/insufficient funds|not enough|gas/i.test(m)) {
		return 'Insufficient funds — make sure your wallet has enough ETH (or SOL) to cover gas. Top up and retry.';
	}
	// Wrong chain
	if (/wrong chain|wrong network|mismatched chain/i.test(m)) {
		return 'Wrong chain — switch your wallet to the target network and click Deploy again.';
	}
	// Network / RPC errors
	if (/network|rpc|fetch|timeout|econnrefused|http 5/i.test(m)) {
		return 'Network error — check your connection and retry. If the problem persists the RPC may be down.';
	}
	// Contract revert
	if (/revert|execution reverted/i.test(m)) {
		return `Transaction reverted by the contract — ${raw}. Check the registry address and retry.`;
	}
	return `Deploy failed: ${raw}`;
}

// ───────────────────────────────────────────────────────────────────────────
// SRI integrity cache
// ───────────────────────────────────────────────────────────────────────────

let _cachedIntegrity = undefined; // undefined = not yet fetched, null = fetch failed

async function fetchAgentIntegrity() {
	if (_cachedIntegrity !== undefined) return _cachedIntegrity;
	try {
		const res = await fetch('/agent-3d/versions.json');
		if (!res.ok) { _cachedIntegrity = null; return null; }
		const data = await res.json();
		const ver = data.latest;
		_cachedIntegrity = data?.channels?.[ver]?.integrity?.['agent-3d.js'] ?? null;
	} catch {
		_cachedIntegrity = null;
	}
	return _cachedIntegrity;
}

// ───────────────────────────────────────────────────────────────────────────
// Templates (for the Templates tab → prefills Create)
// ───────────────────────────────────────────────────────────────────────────

// Service presets per template. Types match SERVICE_TYPES; endpoints are blank
// so the wizard shows empty rows the user fills in with their own URLs.
const S = {
	a2a: { type: 'A2A', name: 'A2A', endpoint: '' },
	mcp: { type: 'MCP', name: 'MCP', endpoint: '' },
	web: { type: 'web', name: 'Website', endpoint: '' },
	x402: { type: 'x402', name: 'x402', endpoint: '' },
};

const TEMPLATES = [
	{
		id: 'companion',
		emoji: '🤝',
		name: 'Virtual Companion',
		description:
			'Always-on digital friend with persistent memory and empathy for daily check-ins and emotional support.',
		services: [S.a2a],
	},
	{
		id: 'influencer',
		emoji: '🎭',
		name: 'Virtual Influencer',
		description:
			'On-brand 3D persona for social posts, livestreams, and AMAs with a consistent face and voice.',
		services: [S.a2a, S.web],
	},
	{
		id: 'vtuber',
		emoji: '📺',
		name: 'VTuber Co-Host',
		description:
			'Livestream co-host with reactive expressions, chat moderation, superchat shoutouts, and lore memory.',
		services: [S.a2a],
	},
	{
		id: 'tutor',
		emoji: '🎓',
		name: 'Language Tutor',
		description:
			'One-on-one conversation practice with pronunciation feedback, spaced repetition, and adaptive lessons.',
		services: [S.a2a, S.mcp],
	},
	{
		id: 'gallery',
		emoji: '🖼️',
		name: 'Gallery Guide',
		description:
			'Embodied docent for 3D galleries, NFT exhibitions, and metaverse rooms with scripted tours and Q&A.',
		services: [S.a2a, S.web],
	},
	{
		id: 'npc',
		emoji: '🎮',
		name: 'Game NPC',
		description:
			'Questgiver and dialog partner for game worlds with persistent lore, per-player memory, and branching scripts.',
		services: [S.a2a],
	},
	{
		id: 'wellness',
		emoji: '🧘',
		name: 'Wellness Coach',
		description:
			'Breathwork, meditation, and daily mood check-ins with a calm, empathetic embodied presence.',
		services: [S.a2a],
	},
	{
		id: 'concierge',
		emoji: '🪪',
		name: 'NFT Concierge',
		description:
			'Token-gated holder assistant — perks, drops, private channel access, and holder-specific analytics.',
		services: [S.a2a, S.mcp],
	},
	{
		id: 'dao',
		emoji: '🏛️',
		name: 'DAO Delegate',
		description:
			'Reads governance proposals, summarizes sentiment, and votes on behalf of delegators within a mandate.',
		services: [S.a2a, S.mcp],
	},
	{
		id: 'portfolio',
		emoji: '💼',
		name: 'Portfolio Manager',
		description:
			'Tracks wallet positions across chains, alerts on drawdown and risk, and rebalances on schedule.',
		services: [S.a2a, S.mcp],
	},
	{
		id: 'defi',
		emoji: '📈',
		name: 'DeFi Trading Agent',
		description:
			'Automated DeFi yield optimization, liquidity management, and token swaps across protocols.',
		services: [S.a2a, S.mcp, S.x402],
		x402Support: true,
	},
	{
		id: 'support',
		emoji: '🎧',
		name: 'Avatar Support Agent',
		description:
			'Face-of-the-brand support — tickets, FAQ, and multi-language help with a consistent embodied persona.',
		services: [S.a2a, S.web],
	},
	{
		id: 'code',
		emoji: '🔍',
		name: 'Code Review Agent',
		description:
			'Automated code analysis, security auditing, gas optimization, and best-practice enforcement.',
		services: [S.a2a, S.mcp, S.x402],
		x402Support: true,
	},
	{
		id: 'data',
		emoji: '📊',
		name: 'Data Analysis Agent',
		description:
			'On-chain and off-chain data analysis, reporting, visualization, and pattern recognition.',
		services: [S.a2a, S.mcp],
	},
	{
		id: 'content',
		emoji: '✍️',
		name: 'Content Creator',
		description:
			'AI content generation for social posts, documentation, technical writing, and marketing copy.',
		services: [S.a2a, S.x402],
		x402Support: true,
	},
	{
		id: 'research',
		emoji: '🔬',
		name: 'Research Assistant',
		description: 'Deep research on protocols, tokens, governance proposals, and market trends.',
		services: [S.a2a, S.mcp],
	},
];

const SERVICE_TYPES = ['A2A', 'MCP', 'OASF', 'x402', 'web', 'custom'];

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

const esc = (s) =>
	String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
const shortAddr = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');

/**
 * True if `url` is already a content-addressed or durable public URL that
 * doesn't need to be fetched and re-pinned before referencing in a
 * registration JSON. Avoids wasted uploads for avatars users created
 * earlier (or default avatars shipped on the same domain).
 */
const _isStableUrl = (url) => {
	if (!url || typeof url !== 'string') return false;
	const u = url.trim();
	return (
		u.startsWith('ipfs://') ||
		u.startsWith('ar://') ||
		u.startsWith('https://') ||
		u.startsWith('http://') ||
		u.startsWith('/') // same-origin public asset (e.g. /avatars/cz.glb)
	);
};

// ───────────────────────────────────────────────────────────────────────────
// RegisterUI
// ───────────────────────────────────────────────────────────────────────────

export class RegisterUI {
	/**
	 * @param {HTMLElement} containerEl
	 * @param {(result: { agentId: number, txHash: string, chainId: number }) => void} [onRegistered]
	 * @param {{ initial?: { name?: string, description?: string, imageUrl?: string, glbUrl?: string } }} [opts]
	 */
	constructor(containerEl, onRegistered, opts = {}) {
		this.container = containerEl;
		this.onRegistered = onRegistered || (() => {});
		this.mode = opts.mode === 'page' ? 'page' : 'modal';
		this._viewer = opts.viewer || null;
		this._avatarId = opts.avatarId || null;

		// Wallet state
		this.wallet = null; // { address, chainId }

		// Selected chain for reads + writes. Defaults to Solana mainnet, where a
		// deploy mints the agent as a Metaplex Core asset. Because the Solana
		// default is non-EVM, the wallet-chain adoption below leaves it intact
		// unless the user explicitly picks an EVM chain.
		// `initial.network` (from ?network= URL param) overrides the default
		// when it maps to a known chain.
		this.selectedChainId = _resolveNetworkArg(opts.initial?.network) ?? SOLANA_MAINNET;

		// Tab state
		this.activeTab = opts.initialTab || 'create';

		const initial = opts.initial || {};

		// Wizard state — pre-populate from the user's current avatar/session so
		// the on-chain JSON points to the GLB they just uploaded/created.
		// `avatarSource` drives Step 3 behaviour:
		//   'current' → use `glbUrl` pre-filled from the live SPA viewer
		//   'saved'   → pick one from the signed-in user's saved avatars
		//   'upload'  → user drops a new .glb in the wizard
		//   'url'     → user pastes a hosted GLB URL directly
		//   'skip'    → deploy as a metadata-only agent (no 3D body)
		this.wizardStep = 1;
		this.form = {
			name: initial.name || '',
			description: initial.description || '',
			imageUrl: initial.imageUrl || '',
			glbUrl: initial.glbUrl || '',
			glbFile: null,
			pastedGlbUrl: '',
			savedAvatar: null, // { id, name, modelUrl, thumbnailUrl }
			defaultAvatarId: null, // id of a pre-pinned DEFAULT_AVATARS entry
			avatarSource: initial.glbUrl ? 'current' : 'upload',
			services: [], // [{ name, type, endpoint }]
			x402Support: false,
			apiToken: '', // optional Pinata JWT
		};

		// Cache of signed-in user's backend agent id (if any) — linked after deploy
		this._backendAgentId = null;
		this._signedIn = false;
		this._savedAvatars = null; // loaded lazily when user switches source to 'saved'

		// True when the form was pre-filled from URL params (?name=, ?avatar=,
		// ?agent=). In this case the quickstart bar is hidden — the user already
		// has a specific deployment context and the chips would just confuse them
		// (or silently overwrite the pre-filled data).
		this._urlPrefilled = !!(initial.name || initial.imageUrl || opts.avatarId);

		this._build();
		this._bind();
		this._fetchBackendAgent(); // fire & forget
		this._eagerConnectWallet(); // silent reconnect if wallet already authorized

		// Keep the UI in sync when the user switches account/chain in the wallet,
		// or when another tab/page on this origin connects/disconnects.
		this._unsubscribeWallet = onWalletChange(({ address, chainId }) => {
			if (!address) {
				this.wallet = null;
			} else {
				this.wallet = { address, chainId: Number(chainId) };
				// Don't clobber an explicit Solana selection when an EVM wallet
				// reports its chain.
				if (
					!_isSolana(this.selectedChainId) &&
					REGISTRY_DEPLOYMENTS[this.wallet.chainId]
				) {
					this.selectedChainId = this.wallet.chainId;
					const sel = this.el.querySelector('.erc8004-chain-select');
					if (sel) sel.value = String(this.selectedChainId);
				}
			}
			this._refreshWalletButton();
			this._renderActiveTab();
			this._refreshMainnetBanner();
		});
	}

	// -----------------------------------------------------------------------
	// Top-level DOM
	// -----------------------------------------------------------------------

	_build() {
		const pageMode = this.mode === 'page';
		this.el = document.createElement('div');
		this.el.className = 'erc8004-register' + (pageMode ? ' erc8004-register--page' : '');

		if (pageMode) {
			this.el.innerHTML = `
				<div class="deploy-shell">
					<header class="deploy-hero">
						<div class="deploy-hero-text">
							<div class="deploy-hero-eyebrow">
								<span class="deploy-hero-dot" aria-hidden="true"></span>
								<span>Deploy on-chain</span>
							</div>
							<h1 class="deploy-hero-title">Give your agent an on-chain identity</h1>
							<p class="deploy-hero-sub">
								Mint your agent as an NFT on Solana (Metaplex Core) or EVM (ERC-8004).
								Your 3D body, services, and metadata live in a single discoverable record.
							</p>
							<div class="deploy-hero-meta">
								<a class="deploy-hero-link" href="/dashboard">My agents →</a>
								<a class="deploy-hero-link" href="https://eips.ethereum.org/EIPS/eip-8004" target="_blank" rel="noopener">ERC-8004 spec ↗</a>
								<a class="deploy-hero-link" href="https://developers.metaplex.com/core" target="_blank" rel="noopener">Metaplex Core ↗</a>
							</div>
						</div>
						<div class="deploy-hero-controls">
							<label class="deploy-chain-control">
								<span class="deploy-chain-label">Target network</span>
								<select class="erc8004-chain-select" title="Target chain"></select>
							</label>
							<button class="erc8004-btn erc8004-btn--wallet deploy-wallet-btn btn btn--secondary" type="button">
								Connect wallet
							</button>
						</div>
					</header>

					<div class="erc8004-mainnet-banner deploy-banner" data-role="mainnet-banner" style="display:none"></div>

					<div class="deploy-grid">
						<main class="deploy-main">
							<div class="erc8004-tab-body" data-role="tab-body"></div>
						</main>
						<aside class="deploy-preview" data-role="preview" aria-label="Agent preview"></aside>
					</div>
				</div>
			`;
		} else {
			this.el.innerHTML = `
				<div class="erc8004-card erc8004-card--wide">
					<div class="erc8004-header">
						<div class="erc8004-controls">
							<select class="erc8004-chain-select" title="Target chain"></select>
							<button class="erc8004-btn erc8004-btn--wallet btn btn--secondary" type="button">
								Connect MetaMask
							</button>
							<button class="erc8004-btn erc8004-btn--close btn btn--ghost btn--icon" type="button" title="Close">✕</button>
						</div>
					</div>

					<div class="erc8004-mainnet-banner" data-role="mainnet-banner" style="display:none"></div>

					<nav class="erc8004-tabs" role="tablist">
						<button class="erc8004-tab erc8004-tab--active" data-tab="create">Create Agent</button>
						<button class="erc8004-tab" data-tab="my">My Agents</button>
						<button class="erc8004-tab" data-tab="search">Search</button>
						<button class="erc8004-tab" data-tab="templates">Templates</button>
						<button class="erc8004-tab" data-tab="batch">Batch</button>
						<button class="erc8004-tab" data-tab="history">History</button>
					</nav>

					<div class="erc8004-tab-body" data-role="tab-body"></div>
				</div>
			`;
		}
		this.container.appendChild(this.el);

		this._populateChainSelect();
		this._renderActiveTab();
		this._refreshMainnetBanner();
		this._refreshWalletButton();
	}

	_isPageMode() {
		return this.mode === 'page';
	}

	_refreshMainnetBanner() {
		const banner = this.el.querySelector('[data-role="mainnet-banner"]');
		if (!banner) return;
		if (_isSolana(this.selectedChainId)) {
			if (this.selectedChainId === SOLANA_MAINNET) {
				banner.style.display = '';
				banner.innerHTML = `⚠️ <strong>Mainnet Mode</strong> — Transactions use real SOL. Test on devnet first.`;
			} else {
				banner.style.display = 'none';
				banner.innerHTML = '';
			}
			return;
		}
		const meta = CHAIN_META[this.selectedChainId];
		if (meta && !meta.testnet) {
			banner.style.display = '';
			banner.innerHTML = `⚠️ <strong>Mainnet Mode</strong> — Transactions use real ${esc(
				meta.currency.symbol,
			)}. Test on a testnet first.`;
		} else {
			banner.style.display = 'none';
			banner.innerHTML = '';
		}
	}

	_bind() {
		this.el
			.querySelector('.erc8004-btn--wallet')
			.addEventListener('click', () => this._connectWallet());
		const closeBtn = this.el.querySelector('.erc8004-btn--close');
		if (closeBtn) closeBtn.addEventListener('click', () => this.destroy());

		this.el.querySelector('.erc8004-chain-select').addEventListener('change', async (e) => {
			const raw = e.target.value;
			const newChain = _isSolana(raw) ? raw : Number(raw);
			this.selectedChainId = newChain;
			this._refreshWalletButton();
			// If we just selected an EVM chain and the user has an EVM wallet on a
			// different chain, prompt to switch. Solana chains skip this entirely.
			if (
				!_isSolana(newChain) &&
				this.wallet &&
				this.wallet.chainId !== newChain &&
				window.ethereum
			) {
				try {
					await switchChain(newChain);
					this.wallet.chainId = newChain;
					this._refreshWalletButton();
				} catch (err) {
					this._toast('Chain switch rejected: ' + err.message, true);
				}
			}
			this._renderActiveTab();
			this._refreshMainnetBanner();
		});

		this.el.querySelectorAll('.erc8004-tab').forEach((btn) => {
			btn.addEventListener('click', () => this._setTab(btn.dataset.tab));
		});
	}

	destroy() {
		if (this._unsubscribeWallet) this._unsubscribeWallet();
		this.el.remove();
	}

	// -----------------------------------------------------------------------
	// Wallet & chain
	// -----------------------------------------------------------------------

	async _connectWallet() {
		// On Solana, route to Phantom instead of MetaMask.
		if (_isSolana(this.selectedChainId)) {
			try {
				const provider = detectSolanaWallet();
				if (!provider) {
					window.open('https://phantom.app/', '_blank', 'noopener');
					return;
				}
				const res = await provider.connect();
				const pk = res?.publicKey?.toBase58?.() || provider.publicKey?.toBase58?.();
				if (pk) this._toast('Connected ' + shortAddr(pk));
				this._refreshWalletButton();
				this._renderActiveTab();
			} catch (err) {
				this._toast('Phantom: ' + (err?.message || String(err)), true);
			}
			return;
		}
		try {
			const { address, chainId } = await connectWallet();
			this.wallet = { address, chainId: Number(chainId) };

			// Adopt wallet's chain if supported; otherwise keep selected and offer
			// switch. Don't clobber an explicit Solana selection.
			if (
				!_isSolana(this.selectedChainId) &&
				REGISTRY_DEPLOYMENTS[this.wallet.chainId]
			) {
				this.selectedChainId = this.wallet.chainId;
				const sel = this.el.querySelector('.erc8004-chain-select');
				if (sel) sel.value = String(this.selectedChainId);
			}

			this._refreshWalletButton();
			this._renderActiveTab();
			this._refreshMainnetBanner();
		} catch (err) {
			this._toast('Wallet: ' + err.message, true);
		}
	}

	// Silent reconnect on mount — uses `eth_accounts` (no popup). If the wallet
	// has previously authorized this origin and is unlocked, we restore the
	// connection transparently so the user doesn't see "Connect MetaMask" twice.
	// Also tries a silent Phantom reconnect so users signed in with Solana
	// land on the Solana chain by default instead of the EVM fallback.
	async _eagerConnectWallet() {
		const result = await eagerConnectWallet();
		if (result) {
			this.wallet = { address: result.address, chainId: Number(result.chainId) };
			if (
				!_isSolana(this.selectedChainId) &&
				REGISTRY_DEPLOYMENTS[this.wallet.chainId]
			) {
				this.selectedChainId = this.wallet.chainId;
				const sel = this.el.querySelector('.erc8004-chain-select');
				if (sel) sel.value = String(this.selectedChainId);
			}
		}

		// If no EVM wallet adopted the selection and a Solana wallet is
		// already trusted by this origin, prefer Solana. `onlyIfTrusted` is
		// silent — no popup if the user hasn't previously connected.
		if (!_isSolana(this.selectedChainId) && !result) {
			const solProvider = detectSolanaWallet();
			if (solProvider) {
				try {
					if (!solProvider.publicKey && typeof solProvider.connect === 'function') {
						await solProvider.connect({ onlyIfTrusted: true });
					}
					if (solProvider.publicKey) {
						this.selectedChainId = SOLANA_MAINNET;
						const sel = this.el.querySelector('.erc8004-chain-select');
						if (sel) sel.value = String(this.selectedChainId);
					}
				} catch {
					// Silent — user hasn't trusted this origin yet.
				}
			}
		}

		this._refreshWalletButton();
		this._renderActiveTab();
		this._refreshMainnetBanner();
	}

	_refreshWalletButton() {
		const btn = this.el.querySelector('.erc8004-btn--wallet');
		if (!btn) return;
		const solana = _isSolana(this.selectedChainId);
		if (solana) {
			// Solana — `this.wallet` tracks EVM only; show Phantom CTA / connected state
			// from window.solana when available.
			const hasPhantom = !!detectSolanaWallet();
			const pk = window.solana?.publicKey?.toBase58?.() || null;
			if (pk) {
				btn.textContent = shortAddr(pk);
				btn.classList.add('erc8004-btn--connected');
			} else {
				btn.textContent = hasPhantom ? 'Connect Phantom' : 'Install Phantom';
				btn.classList.remove('erc8004-btn--connected');
			}
			return;
		}
		if (!this.wallet) {
			btn.textContent = window.ethereum ? 'Connect MetaMask' : 'Install MetaMask';
			btn.classList.remove('erc8004-btn--connected');
			return;
		}
		btn.textContent = shortAddr(this.wallet.address);
		btn.classList.add('erc8004-btn--connected');
	}

	_populateChainSelect() {
		const sel = this.el.querySelector('.erc8004-chain-select');
		const ids = supportedChainIds();
		// Mainnets first (production-default), then testnets
		const mainnets = ids.filter((id) => !CHAIN_META[id].testnet);
		const testnets = ids.filter((id) => CHAIN_META[id].testnet);
		const groupS = document.createElement('optgroup');
		groupS.label = 'Solana';
		for (const id of [SOLANA_MAINNET, SOLANA_DEVNET]) {
			const opt = document.createElement('option');
			opt.value = id;
			opt.textContent = SOLANA_LABELS[id];
			groupS.appendChild(opt);
		}
		const groupM = document.createElement('optgroup');
		groupM.label = 'EVM Mainnets';
		const groupT = document.createElement('optgroup');
		groupT.label = 'EVM Testnets';
		for (const id of mainnets) {
			const opt = document.createElement('option');
			opt.value = String(id);
			opt.textContent = CHAIN_META[id].name;
			groupM.appendChild(opt);
		}
		for (const id of testnets) {
			const opt = document.createElement('option');
			opt.value = String(id);
			opt.textContent = CHAIN_META[id].name;
			groupT.appendChild(opt);
		}
		sel.appendChild(groupS);
		sel.appendChild(groupM);
		sel.appendChild(groupT);
		sel.value = String(this.selectedChainId);
	}

	async _refreshStats() {
		const el = (k) => this.el.querySelector(`[data-stat="${k}"]`);
		try {
			const [total, version] = await Promise.all([
				getTotalSupply(this.selectedChainId).catch(() => null),
				getRegistryVersion(this.selectedChainId).catch(() => null),
			]);
			const totalEl = el('total');
			const versionEl = el('version');
			if (total !== null && totalEl) totalEl.textContent = String(total);
			if (version && versionEl) versionEl.textContent = version;
		} catch {
			/* swallow; stats are cosmetic */
		}
	}

	// -----------------------------------------------------------------------
	// Backend agent link (optional)
	// -----------------------------------------------------------------------

	async _fetchBackendAgent() {
		try {
			const res = await fetch('/api/agents/me', { credentials: 'include' });
			if (!res.ok) return;
			this._signedIn = true;
			const { agent } = await res.json();
			if (agent && agent.id) this._backendAgentId = agent.id;
			// If Step 3 is already rendered (signed-in detection raced with UI),
			// re-render so the "Use a saved avatar" option appears.
			if (this.wizardStep === 3 && this.activeTab === 'create') this._renderActiveTab();
		} catch {
			/* anon user or endpoint unavailable — fine */
		}
	}

	/**
	 * Lazily fetch the signed-in user's saved avatars for the Step 3 picker.
	 * Returns [] on any failure (anonymous, endpoint down, etc) so the UI can
	 * silently fall back to the upload/skip options.
	 */
	async _loadSavedAvatars() {
		if (this._savedAvatars) return this._savedAvatars;
		try {
			const res = await fetch('/api/avatars?limit=50', { credentials: 'include' });
			if (!res.ok) {
				this._savedAvatars = [];
				return this._savedAvatars;
			}
			const payload = await res.json();
			const rows = payload.avatars || payload.data || [];
			this._savedAvatars = rows.map((r) => ({
				id: r.id,
				name: r.name || 'Untitled',
				modelUrl: r.model_url || null, // null for private — resolved on select
				thumbnailUrl: r.thumbnail_url || null,
				visibility: r.visibility,
			}));
		} catch {
			this._savedAvatars = [];
		}
		return this._savedAvatars;
	}

	/**
	 * Resolve a saved avatar's download URL. Public/unlisted expose `model_url`
	 * directly; private avatars require a per-object signed-URL fetch.
	 */
	async _resolveSavedAvatarUrl(avatar) {
		if (avatar.modelUrl) return avatar.modelUrl;
		const res = await fetch(`/api/avatars/${encodeURIComponent(avatar.id)}`, {
			credentials: 'include',
		});
		if (!res.ok) throw new Error(`avatar fetch failed (${res.status})`);
		const { avatar: detail } = await res.json();
		return detail?.url || null;
	}

	async _linkAgentToAccount({ agentId, chainId, txHash, throwOnError = false }) {
		if (!this._backendAgentId || !this.wallet) {
			if (throwOnError) throw new Error('Sign in and connect a wallet first');
			return;
		}
		try {
			const res = await fetch(
				`/api/agents/${encodeURIComponent(this._backendAgentId)}/wallet`,
				{
					method: 'POST',
					credentials: 'include',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						wallet_address: this.wallet.address,
						chain_id: chainId,
						erc8004_agent_id: agentId,
						tx_hash: txHash,
					}),
				},
			);
			if (!res.ok) {
				const text = await res.text().catch(() => res.status);
				throw new Error(`link failed (${res.status}): ${text}`);
			}
		} catch (err) {
			log.warn('[erc8004] Failed to link on-chain agentId to account:', err.message);
			if (throwOnError) throw err;
		}
	}

	// -----------------------------------------------------------------------
	// Tabs
	// -----------------------------------------------------------------------

	_setTab(tab) {
		this.activeTab = tab;
		this.el.querySelectorAll('.erc8004-tab').forEach((btn) => {
			btn.classList.toggle('erc8004-tab--active', btn.dataset.tab === tab);
		});
		this._renderActiveTab();
	}

	_renderActiveTab() {
		const body = this.el.querySelector('[data-role="tab-body"]');
		body.innerHTML = '';
		// In page mode (/deploy) we hide the tab strip and always render the
		// Create wizard — this URL is single-purpose. The preview rail mirrors
		// the form state on the right.
		if (this._isPageMode()) {
			this.activeTab = 'create';
			this._renderCreate(body);
			this._refreshPreview();
			return;
		}
		switch (this.activeTab) {
			case 'create':
				this._renderCreate(body);
				break;
			case 'my':
				this._renderMyAgents(body);
				break;
			case 'search':
				this._renderSearch(body);
				break;
			case 'templates':
				this._renderTemplates(body);
				break;
			case 'batch':
				this._renderBatch(body);
				break;
			case 'history':
				this._renderHistory(body);
				break;
		}
	}

	// ----- Preview rail (page mode only) -----------------------------------

	_refreshPreview() {
		const rail = this.el.querySelector('[data-role="preview"]');
		if (!rail) return;
		const f = this.form;
		const solana = _isSolana(this.selectedChainId);
		const chainLabel = solana
			? SOLANA_LABELS[this.selectedChainId]
			: (CHAIN_META[this.selectedChainId]?.name || `Chain ${this.selectedChainId}`);
		const standard = solana ? 'Metaplex Core NFT' : 'ERC-8004 (ERC-721)';
		const costLabel = solana ? '~0.003 SOL' : `gas on ${esc(chainLabel)}`;
		const avatarLine = this._avatarSummary();
		const services = (f.services || []).filter((s) => s.endpoint?.trim());

		const thumb = this._previewThumbSource();
		const thumbKey = `${thumb.kind}|${thumb.src || ''}`;
		const needsRebuild =
			this._lastPreviewThumbKey !== thumbKey || !rail.querySelector('.deploy-preview-card');

		const infoHtml = `
			<div class="deploy-preview-name">${esc(f.name) || '<span class="deploy-preview-dim">Untitled agent</span>'}</div>
			<div class="deploy-preview-desc">${esc(f.description) || '<span class="deploy-preview-dim">Add a description in Step 1.</span>'}</div>
			<dl class="deploy-preview-meta">
				<dt>Chain</dt><dd>${esc(chainLabel)}</dd>
				<dt>Standard</dt><dd>${standard}</dd>
				<dt>Avatar</dt><dd>${avatarLine}</dd>
				<dt>Services</dt><dd>${services.length ? services.map((s) => `<span class="deploy-svc-pill">${esc(s.type)}</span>`).join(' ') : '<span class="deploy-preview-dim">none</span>'}</dd>
				<dt>Cost</dt><dd>${esc(costLabel)}</dd>
			</dl>
			<div class="deploy-preview-checklist">
				<div class="deploy-check ${f.name?.trim() ? 'is-ok' : ''}">${f.name?.trim() ? '✓' : '○'} Name</div>
				<div class="deploy-check ${f.description?.trim() ? 'is-ok' : ''}">${f.description?.trim() ? '✓' : '○'} Description</div>
				<div class="deploy-check ${this._hasAvatar() ? 'is-ok' : ''}">${this._hasAvatar() ? '✓' : '○'} Avatar</div>
				<div class="deploy-check ${this._walletReady() ? 'is-ok' : ''}">${this._walletReady() ? '✓' : '○'} Wallet</div>
			</div>
		`;

		if (needsRebuild) {
			rail.innerHTML = `
				<div class="deploy-preview-card">
					<div class="deploy-preview-eyebrow">Live preview</div>
					<div class="deploy-preview-thumb" data-role="thumb">${this._previewThumbHtml(thumb)}</div>
					<div data-role="info">${infoHtml}</div>
				</div>
			`;
			this._lastPreviewThumbKey = thumbKey;
			if (thumb.kind === 'glb') this._ensureModelViewer();
		} else {
			const info = rail.querySelector('[data-role="info"]');
			if (info) info.innerHTML = infoHtml;
		}
	}

	_previewThumbSource() {
		const f = this.form;
		const url = f.imageUrl?.trim();
		if (url) return { kind: 'img', src: url };
		const glb = this._currentGlbUrl();
		if (glb) return { kind: 'glb', src: glb };
		return { kind: 'none' };
	}

	_previewThumbHtml(thumb) {
		if (thumb.kind === 'img') {
			return `<img loading="lazy" decoding="async" src="${esc(thumb.src)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />
				<div class="deploy-preview-ph" style="display:none">Image failed to load</div>`;
		}
		if (thumb.kind === 'glb') {
			return `<model-viewer
				class="deploy-preview-mv"
				src="${esc(thumb.src)}"
				alt="Agent avatar preview"
				camera-controls
				auto-rotate
				rotation-per-second="14deg"
				interaction-prompt="none"
				exposure="1.05"
				shadow-intensity="0.6"
				environment-image="neutral"
				reveal="auto"
			></model-viewer>`;
		}
		return `<div class="deploy-preview-ph">No image yet</div>`;
	}

	_currentGlbUrl() {
		const f = this.form;
		const s = f.avatarSource;
		if (s === 'current' && f.glbUrl) return f.glbUrl;
		if (s === 'saved' && f.savedAvatar?.url) return f.savedAvatar.url;
		if (s === 'upload' && f.glbFile) {
			if (this._uploadedGlbFile !== f.glbFile) {
				if (this._uploadedGlbObjectUrl) URL.revokeObjectURL(this._uploadedGlbObjectUrl);
				this._uploadedGlbObjectUrl = URL.createObjectURL(f.glbFile);
				this._uploadedGlbFile = f.glbFile;
			}
			return this._uploadedGlbObjectUrl;
		}
		if (s === 'url' && f.pastedGlbUrl?.trim()) return f.pastedGlbUrl.trim();
		if (s === 'default' && f.defaultAvatarId) {
			const def = getDefaultAvatar(f.defaultAvatarId);
			return def?.url || null;
		}
		// Fall back to viewer's current model even when avatarSource isn't 'current'
		// — so the user always sees something during early form editing.
		if (f.glbUrl) return f.glbUrl;
		return null;
	}

	_ensureModelViewer() {
		if (customElements.get('model-viewer')) return Promise.resolve();
		if (this._mvLoading) return this._mvLoading;
		this._mvLoading = new Promise((resolve, reject) => {
			const s = document.createElement('script');
			s.type = 'module';
			s.src = 'https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js';
			s.onload = () => resolve();
			s.onerror = () => reject(new Error('model-viewer failed to load'));
			document.head.appendChild(s);
		});
		return this._mvLoading;
	}

	_hasAvatar() {
		const f = this.form;
		const s = f.avatarSource;
		if (s === 'current') return !!f.glbUrl;
		if (s === 'saved') return !!f.savedAvatar;
		if (s === 'upload') return !!f.glbFile;
		if (s === 'url') return !!f.pastedGlbUrl?.trim();
		if (s === 'default') return !!f.defaultAvatarId;
		if (s === 'skip') return true;
		return false;
	}

	_walletReady() {
		if (_isSolana(this.selectedChainId)) {
			return !!window.solana?.publicKey;
		}
		return !!this.wallet;
	}

	_renderBatch(body) {
		if (_isSolana(this.selectedChainId)) {
			body.innerHTML = `
				<h3 class="erc8004-h3">Batch Register</h3>
				<p class="erc8004-p erc8004-muted">Batch registration is EVM-only. Switch to an EVM chain to use this tab.</p>
			`;
			return;
		}
		renderBatchTab(body, {
			getWallet: () => this.wallet,
			getChainId: () => this.selectedChainId,
			toast: (msg, err) => this._toast(msg, err),
		});
	}

	// -----------------------------------------------------------------------
	// Tab: Create Agent (4-step wizard)
	// -----------------------------------------------------------------------

	_renderCreate(body) {
		const step = this.wizardStep;
		const pageMode = this._isPageMode();
		const stepLabels = ['Identity', 'Services', 'Avatar', 'Deploy'];
		// Completed steps render as real <button>s so they are keyboard-operable
		// and get a visible focus ring; the current step carries aria-current.
		const stepBar = `
			<ol class="erc8004-steps deploy-steps" role="list" aria-label="Deploy steps">
				${[1, 2, 3, 4]
					.map((n) => {
						const state = n === step ? 'active' : (n < step ? 'done' : '');
						const cls = `erc8004-step deploy-step ${state ? 'deploy-step--' + state : ''} ${n === step ? 'erc8004-step--active' : ''} ${n < step ? 'erc8004-step--done' : ''}`;
						const inner = `
							<span class="erc8004-step-num" aria-hidden="true">${n < step ? '✓' : n}</span>
							<span class="erc8004-step-lbl">${stepLabels[n - 1]}</span>`;
						if (n < step) {
							return `
						<li class="${cls}">
							<button type="button" class="deploy-step-btn" data-role="goto-step" data-step="${n}" aria-label="Back to step ${n}: ${stepLabels[n - 1]} (completed)">${inner}</button>
						</li>`;
						}
						return `
						<li class="${cls}"${n === step ? ' aria-current="step"' : ''}>
							<span class="deploy-step-static">${inner}</span>
						</li>`;
					})
					.join('')}
			</ol>`;
		// Hide the quickstart bar when the form was seeded from URL params —
		// the user has a specific deployment context and the chips add noise.
		const quickstart = pageMode && !this._urlPrefilled
			? `
				<div class="deploy-quickstart-bar">
					<span class="deploy-quickstart-bar-label">Start from</span>
					<button class="deploy-qs-chip" data-role="qs-current" type="button">Current session</button>
					<button class="deploy-qs-chip" data-role="qs-saved" type="button" ${this._signedIn ? '' : 'disabled'}>Saved agent</button>
					<button class="deploy-qs-chip" data-role="qs-scratch" type="button">Scratch</button>
					<button class="deploy-qs-chip" data-role="qs-update" type="button">Edit existing →</button>
				</div>`
			: pageMode ? '' : `
				<div class="erc8004-quickstart" data-role="quickstart">
					<div class="erc8004-quickstart-title">How would you like to start?</div>
					<div class="erc8004-quickstart-grid">
						<button class="erc8004-quickstart-btn" data-role="qs-saved" ${this._signedIn ? '' : 'disabled'}>
							<div class="erc8004-quickstart-btn-title">🧑 My saved agent</div>
							<div class="erc8004-quickstart-btn-hint">Prefill from the agent linked to your account.</div>
						</button>
						<button class="erc8004-quickstart-btn" data-role="qs-current">
							<div class="erc8004-quickstart-btn-title">🪄 Current session</div>
							<div class="erc8004-quickstart-btn-hint">Use the avatar loaded in the viewer right now.</div>
						</button>
						<button class="erc8004-quickstart-btn" data-role="qs-scratch">
							<div class="erc8004-quickstart-btn-title">📝 From scratch</div>
							<div class="erc8004-quickstart-btn-hint">Metadata-only agent — add a GLB later if you want.</div>
						</button>
						<button class="erc8004-quickstart-btn" data-role="qs-update">
							<div class="erc8004-quickstart-btn-title">✏️ Update on-chain</div>
							<div class="erc8004-quickstart-btn-hint">Edit an agent you've already registered.</div>
						</button>
					</div>
				</div>`;
		body.innerHTML = `
			<div class="erc8004-wizard ${pageMode ? 'deploy-wizard' : ''}">
				${quickstart}
				${stepBar}
				<div class="erc8004-wizard-body" data-role="wizard-body"></div>
			</div>
		`;
		body.querySelector('[data-role="qs-saved"]')?.addEventListener('click', () =>
			this._applyQuickStart('saved'),
		);
		body.querySelector('[data-role="qs-current"]')?.addEventListener('click', () =>
			this._applyQuickStart('current'),
		);
		body.querySelector('[data-role="qs-scratch"]')?.addEventListener('click', () =>
			this._applyQuickStart('scratch'),
		);
		body.querySelector('[data-role="qs-update"]')?.addEventListener('click', () =>
			this._applyQuickStart('update'),
		);
		body.querySelectorAll('[data-role="goto-step"]').forEach((el) => {
			el.addEventListener('click', () => {
				const n = Number(el.dataset.step);
				if (n >= 1 && n < this.wizardStep) this._goToStep(n);
			});
		});
		const wbody = body.querySelector('[data-role="wizard-body"]');
		if (step === 1) this._renderStepIdentity(wbody);
		else if (step === 2) this._renderStepServices(wbody);
		else if (step === 3) this._renderStepConfig(wbody);
		else this._renderStepDeploy(wbody);
	}

	/**
	 * Navigate the wizard to step `n` and move keyboard/screen-reader focus to
	 * the new step's heading, so keyboard users aren't dumped back at the top
	 * of the document after each transition.
	 */
	_goToStep(n) {
		this.wizardStep = n;
		this._renderActiveTab();
		this._focusWizardHeading();
	}

	_focusWizardHeading() {
		const h = this.el.querySelector('[data-role="wizard-body"] .erc8004-h3');
		if (!h) return;
		h.setAttribute('tabindex', '-1');
		h.focus();
	}

	/**
	 * Apply one of the Step-0 quick-start modes. Resets wizard state appropriately
	 * and returns to Step 1. Signed-in-only modes bail with a toast if no session.
	 */
	async _applyQuickStart(mode) {
		if (mode === 'update') {
			this._setTab('my');
			this._toast('Pick an agent and click "Edit on-chain ✏️".');
			return;
		}
		if (mode === 'scratch') {
			this.form = {
				name: '',
				description: '',
				imageUrl: '',
				glbUrl: '',
				glbFile: null,
				savedAvatar: null,
				avatarSource: 'skip',
				services: [],
				x402Support: false,
				apiToken: this.form.apiToken || '',
			};
			this.wizardStep = 1;
			this._renderActiveTab();
			return;
		}
		if (mode === 'current') {
			this.form.avatarSource = this.form.glbUrl ? 'current' : 'upload';
			this.wizardStep = 1;
			this._renderActiveTab();
			return;
		}
		if (mode === 'saved') {
			if (!this._signedIn) {
				this._toast('Sign in to use a saved agent.', true);
				return;
			}
			try {
				const res = await fetch('/api/agents/me', { credentials: 'include' });
				const body = await res.json().catch(() => ({}));
				const agent = body?.agent;
				if (!agent) {
					this._toast('No saved agent on this account yet.', true);
					return;
				}
				this.form.name = agent.name || this.form.name;
				this.form.description = agent.description || this.form.description;
				this.form.avatarSource = 'saved';
				this.wizardStep = 1;
				this._renderActiveTab();
				this._loadSavedAvatars?.();
			} catch (err) {
				this._toast('Could not load saved agent: ' + err.message, true);
			}
		}
	}

	_renderStepIdentity(body) {
		body.innerHTML = `
			<h3 class="erc8004-h3">Agent Identity</h3>
			<p class="erc8004-p">Define your agent's core identity: name, description, and image.</p>

			<label class="erc8004-label">Agent Name <span class="erc8004-req">*</span>
				<input class="erc8004-input" name="name" maxlength="100" placeholder="e.g., DeFi Yield Optimizer"
					autocomplete="off" spellcheck="false" aria-required="true"
					aria-describedby="deploy-name-hint deploy-name-error" value="${esc(this.form.name)}" />
			</label>
			<p class="erc8004-field-error" id="deploy-name-error" hidden>Give your agent a name before continuing.</p>
			<p class="erc8004-hint erc8004-hint-row" id="deploy-name-hint"><span>A short, memorable name</span><span class="erc8004-count" data-role="name-count" aria-hidden="true">${this.form.name.length}/100</span></p>

			<label class="erc8004-label">Description <span class="erc8004-req">*</span>
				<textarea class="erc8004-input erc8004-textarea" name="description" maxlength="1000" rows="4"
					aria-required="true" aria-describedby="deploy-desc-hint deploy-desc-error"
					placeholder="Describe what your agent does, capabilities, pricing…">${esc(this.form.description)}</textarea>
			</label>
			<p class="erc8004-field-error" id="deploy-desc-error" hidden>Add a description: it is written into the on-chain record.</p>
			<p class="erc8004-hint erc8004-hint-row" id="deploy-desc-hint"><span>Required before deploying on-chain</span><span class="erc8004-count" data-role="desc-count" aria-hidden="true">${this.form.description.length}/1000</span></p>

			<label class="erc8004-label">Image URL
				<div class="erc8004-image-row">
					<input class="erc8004-input" name="imageUrl" inputmode="url" autocomplete="off" spellcheck="false"
						aria-describedby="deploy-image-hint" placeholder="https://example.com/avatar.png or ipfs://…" value="${esc(this.form.imageUrl)}" />
					${this._viewer ? `<button type="button" class="erc8004-btn erc8004-btn--ghost erc8004-capture-btn btn btn--ghost" data-role="capture3d" title="Snapshot the current 3D viewer and use it as the agent image">📸 Use 3D view</button>` : ''}
				</div>
			</label>
			<p class="erc8004-hint" id="deploy-image-hint">Avatar or logo for your agent NFT. Optional: leave blank to auto-render one from your 3D model.</p>

			<div class="erc8004-wizard-nav">
				<span></span>
				<button class="erc8004-btn erc8004-btn--primary btn btn--primary" data-role="next">Next: Services →</button>
			</div>
		`;
		const nameInput = body.querySelector('[name="name"]');
		const descInput = body.querySelector('[name="description"]');
		const nameError = body.querySelector('#deploy-name-error');
		const descError = body.querySelector('#deploy-desc-error');
		const nameCount = body.querySelector('[data-role="name-count"]');
		const descCount = body.querySelector('[data-role="desc-count"]');
		const clearInvalid = (input, error) => {
			error.hidden = true;
			input.removeAttribute('aria-invalid');
			input.classList.remove('erc8004-input--invalid');
		};
		const markInvalid = (input, error) => {
			error.hidden = false;
			input.setAttribute('aria-invalid', 'true');
			input.classList.add('erc8004-input--invalid');
		};
		const updateCount = (el, len, max) => {
			el.textContent = `${len}/${max}`;
			el.classList.toggle('erc8004-count--limit', len >= max * 0.9);
		};
		nameInput.addEventListener('input', (e) => {
			this.form.name = e.target.value;
			updateCount(nameCount, e.target.value.length, 100);
			if (e.target.value.trim()) clearInvalid(nameInput, nameError);
			this._refreshPreview();
		});
		descInput.addEventListener('input', (e) => {
			this.form.description = e.target.value;
			updateCount(descCount, e.target.value.length, 1000);
			if (e.target.value.trim()) clearInvalid(descInput, descError);
			this._refreshPreview();
		});
		body.querySelector('[name="imageUrl"]').addEventListener('input', (e) => {
			this.form.imageUrl = e.target.value;
			this._refreshPreview();
		});
		body.querySelector('[data-role="capture3d"]')?.addEventListener('click', () => {
			this._captureFromViewer(body);
		});
		body.querySelector('[data-role="next"]').addEventListener('click', () => {
			// Inline validation next to the fields (both are minted on-chain, so
			// catching them here beats a failed deploy three steps later).
			const invalid = [];
			if (!this.form.name.trim()) invalid.push([nameInput, nameError]);
			if (!this.form.description.trim()) invalid.push([descInput, descError]);
			if (invalid.length) {
				invalid.forEach(([input, error]) => markInvalid(input, error));
				invalid[0][0].focus();
				return;
			}
			this._goToStep(2);
		});
	}

	async _captureFromViewer(stepBody) {
		const viewer = this._viewer;
		if (!viewer) return;
		const renderer = viewer.renderer;
		const scene = viewer.scene;
		const camera = viewer.activeCamera || viewer.camera;
		const srcCanvas = renderer?.domElement;
		if (!renderer || !scene || !camera || !srcCanvas) {
			this._toast('3D preview not ready — wait for the avatar to load.', true);
			return;
		}
		const btn = stepBody?.querySelector('[data-role="capture3d"]');
		if (btn) { btn.disabled = true; btn.textContent = '📸 Capturing…'; }
		try {
			renderer.render(scene, camera);
			const w = srcCanvas.width, h = srcCanvas.height;
			const size = Math.min(w, h);
			const sx = (w - size) >> 1, sy = (h - size) >> 1;
			const out = document.createElement('canvas');
			out.width = out.height = Math.min(1024, size);
			const ctx = out.getContext('2d');
			ctx.drawImage(srcCanvas, sx, sy, size, size, 0, 0, out.width, out.height);
			const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
			if (!blob) throw new Error('canvas toBlob failed');

			if (this._avatarId) {
				const b64 = await new Promise((resolve, reject) => {
					const reader = new FileReader();
					reader.onload = () => resolve(reader.result);
					reader.onerror = reject;
					reader.readAsDataURL(blob);
				});
				const resp = await fetch('/api/avatars/thumbnail', {
					method: 'POST',
					credentials: 'include',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ avatar_id: this._avatarId, png_base64: b64 }),
				});
				if (!resp.ok) throw new Error(`thumbnail upload failed: HTTP ${resp.status}`);
				const { data } = await resp.json();
				this.form.imageUrl = data.thumbnail_url;
			} else {
				// No avatar row to attach to — pin the PNG to get a stable hosted
				// URL. Embedding the raw base64 data: URL would bloat the minted
				// metadata JSON (tens of KB) and render unusably in the Review UI.
				const file = new File([blob], 'agent-3d-capture.png', { type: 'image/png' });
				this.form.imageUrl = await pinFile(file, this.form.apiToken || undefined);
			}

			const input = stepBody?.querySelector('[name="imageUrl"]');
			if (input) input.value = this.form.imageUrl;
			this._refreshPreview();
			this._toast('3D view captured.');
		} catch (err) {
			this._toast('Could not capture 3D view: ' + err.message, true);
		} finally {
			if (btn) { btn.disabled = false; btn.textContent = '📸 Use 3D view'; }
		}
	}

	_renderStepServices(body) {
		body.innerHTML = `
			<h3 class="erc8004-h3">Service Endpoints</h3>
			<p class="erc8004-p">Add one or more endpoints so other agents can discover and talk to yours. Optional but recommended.</p>

			<div class="erc8004-services" data-role="list"></div>

			<button class="erc8004-btn erc8004-btn--ghost btn btn--ghost" data-role="add">+ Add endpoint</button>

			<label class="erc8004-checkbox" style="margin-top:12px">
				<input type="checkbox" data-role="x402" ${this.form.x402Support ? 'checked' : ''} />
				Accept x402 payments (HTTP-native micropayments)
			</label>

			<div class="erc8004-wizard-nav">
				<button class="erc8004-btn btn btn--secondary" data-role="back">← Back</button>
				<button class="erc8004-btn erc8004-btn--primary btn btn--primary" data-role="next">Next: Configuration →</button>
			</div>
		`;
		const list = body.querySelector('[data-role="list"]');
		const renderList = () => {
			if (!this.form.services.length) {
				list.innerHTML = `<div class="erc8004-svc-empty">No endpoints yet. They're optional: add one if other agents should reach yours over A2A, MCP, or x402.</div>`;
				return;
			}
			list.innerHTML = this.form.services
				.map(
					(svc, i) => `
				<div class="erc8004-svc-row" data-i="${i}">
					<select class="erc8004-input erc8004-input--tight" data-field="type" aria-label="Service type">
						${SERVICE_TYPES.map((t) => `<option value="${t}" ${svc.type === t ? 'selected' : ''}>${t}</option>`).join('')}
					</select>
					<input class="erc8004-input" data-field="name" placeholder="Name" aria-label="Service name" autocomplete="off" spellcheck="false" value="${esc(svc.name)}" />
					<input class="erc8004-input" data-field="endpoint" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://… or ipfs://…" aria-label="Service endpoint URL" value="${esc(svc.endpoint)}" />
					<button class="erc8004-btn erc8004-btn--ghost erc8004-btn--x btn btn--ghost btn--icon" data-role="rm" title="Remove endpoint" aria-label="Remove endpoint ${i + 1}">✕</button>
				</div>
				<p class="erc8004-field-error" data-role="svc-error" data-i="${i}" hidden>Endpoint must be an http(s)://, ipfs:// or ar:// URL.</p>
			`,
				)
				.join('');

			list.querySelectorAll('.erc8004-svc-row').forEach((row) => {
				const i = Number(row.dataset.i);
				row.querySelectorAll('[data-field]').forEach((input) => {
					input.addEventListener('input', (e) => {
						this.form.services[i][e.target.dataset.field] = e.target.value;
						if (e.target.dataset.field === 'endpoint') {
							const err = list.querySelector(`[data-role="svc-error"][data-i="${i}"]`);
							if (err) err.hidden = true;
							e.target.removeAttribute('aria-invalid');
							e.target.classList.remove('erc8004-input--invalid');
						}
					});
				});
				row.querySelector('[data-role="rm"]').addEventListener('click', () => {
					this.form.services.splice(i, 1);
					renderList();
				});
			});
		};
		renderList();

		body.querySelector('[data-role="add"]').addEventListener('click', () => {
			this.form.services.push({ type: 'A2A', name: '', endpoint: '' });
			renderList();
			// Land the keyboard in the new row so the user can type immediately.
			const rows = list.querySelectorAll('.erc8004-svc-row');
			rows[rows.length - 1]?.querySelector('[data-field="name"]')?.focus();
		});
		body.querySelector('[data-role="x402"]').addEventListener('change', (e) => {
			this.form.x402Support = e.target.checked;
		});
		body.querySelector('[data-role="back"]').addEventListener('click', () => {
			this._goToStep(1);
		});
		body.querySelector('[data-role="next"]').addEventListener('click', () => {
			// Non-empty endpoints must look like a real URL before they're minted
			// into the registration JSON. Empty rows are simply skipped at deploy.
			const badIndex = this.form.services.findIndex((s) => {
				const v = (s.endpoint || '').trim();
				return v && !/^(https?:\/\/|ipfs:\/\/|ar:\/\/)\S+$/i.test(v);
			});
			if (badIndex !== -1) {
				const err = list.querySelector(`[data-role="svc-error"][data-i="${badIndex}"]`);
				if (err) err.hidden = false;
				const input = list.querySelector(`.erc8004-svc-row[data-i="${badIndex}"] [data-field="endpoint"]`);
				if (input) {
					input.setAttribute('aria-invalid', 'true');
					input.classList.add('erc8004-input--invalid');
					input.focus();
				}
				return;
			}
			this._goToStep(3);
		});
	}

	_renderStepConfig(body) {
		const hasCurrent = !!this.form.glbUrl;
		const canPickSaved = this._signedIn;
		const src = this.form.avatarSource;
		const radio = (value, label, hint, disabled = false) => `
			<label class="erc8004-avatar-source ${src === value ? 'erc8004-avatar-source--active' : ''} ${disabled ? 'erc8004-avatar-source--disabled' : ''}">
				<input type="radio" name="avatarSource" value="${value}" ${src === value ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
				<div>
					<div class="erc8004-avatar-source-title">${label}</div>
					<div class="erc8004-avatar-source-hint">${hint}</div>
				</div>
			</label>
		`;

		body.innerHTML = `
			<h3 class="erc8004-h3">3D Avatar</h3>
			<p class="erc8004-p">Attach a GLB so any 3D-aware client can render your agent's body, or deploy as metadata-only. ERC-8004 doesn't require a 3D avatar — a 2D <code>image</code> works too.</p>

			<div class="erc8004-avatar-sources" data-role="sources">
				${hasCurrent ? radio('current', 'Use current avatar', `From your active session — <code>${esc(this.form.glbUrl)}</code>`) : ''}
				${radio('saved', 'Use a saved avatar', canPickSaved ? 'Pick one from your account library.' : 'Sign in to pick from your saved avatars.', !canPickSaved)}
				${DEFAULT_AVATARS.length ? radio('default', 'Use a default avatar', 'Pick a pre-pinned starter avatar — no upload needed.') : ''}
				${radio('upload', 'Upload a new GLB', 'Drop or browse a .glb / .gltf file from your machine.')}
				${radio('url', 'Paste a GLB URL', 'Use a GLB already hosted on IPFS, Arweave, or HTTPS.')}
				${radio('skip', 'Skip — no 3D body', 'Deploy as a metadata-only agent. You can attach an avatar later via setAgentURI.')}
			</div>

			<div class="erc8004-avatar-panel" data-role="panel"></div>

			<label class="erc8004-label">IPFS Pinning Token (optional)
				<input class="erc8004-input" type="password" name="apiToken" autocomplete="off" placeholder="Pinata JWT — leave blank to use built-in R2 storage" value="${esc(this.form.apiToken)}" />
			</label>
			<p class="erc8004-hint">Without a token, uploads go through our backend (R2). Paste a Pinata JWT to pin directly to IPFS.</p>

			<div class="erc8004-wizard-nav">
				<button class="erc8004-btn btn btn--secondary" data-role="back">← Back</button>
				<button class="erc8004-btn erc8004-btn--primary btn btn--primary" data-role="next">Next: Deploy →</button>
			</div>
		`;

		const panel = body.querySelector('[data-role="panel"]');

		const renderPanel = () => {
			const s = this.form.avatarSource;
			if (s === 'current') {
				panel.innerHTML = `
					<div class="erc8004-avatar-summary">
						<span class="erc8004-avatar-summary-badge">✓</span>
						<div>
							<div>Using your current avatar.</div>
							<div class="erc8004-hint"><code>${esc(this.form.glbUrl)}</code></div>
						</div>
					</div>
				`;
			} else if (s === 'saved') {
				panel.innerHTML = `<div class="erc8004-saved-grid" data-role="grid"><div class="erc8004-muted">Loading your avatars…</div></div>`;
				this._loadSavedAvatars().then((list) => {
					const grid = panel.querySelector('[data-role="grid"]');
					if (!grid) return;
					if (!list.length) {
						grid.innerHTML = `<div class="erc8004-muted">No saved avatars yet. <a href="/create" class="erc8004-link">Create one</a> or choose another option above.</div>`;
						return;
					}
					grid.innerHTML = list
						.map(
							(a) => `
								<button type="button" class="erc8004-saved-card ${this.form.savedAvatar?.id === a.id ? 'erc8004-saved-card--active' : ''}" data-id="${esc(a.id)}">
									${a.thumbnailUrl ? `<img src="${esc(a.thumbnailUrl)}" alt="" loading="lazy" />` : `<div class="erc8004-saved-card-ph">GLB</div>`}
									<div class="erc8004-saved-card-name">${esc(a.name)}</div>
								</button>
							`,
						)
						.join('');
					grid.querySelectorAll('.erc8004-saved-card').forEach((btn) => {
						btn.addEventListener('click', () => {
							const id = btn.dataset.id;
							const picked = list.find((x) => x.id === id);
							this.form.savedAvatar = picked || null;
							renderPanel();
						});
					});
				});
			} else if (s === 'upload') {
				panel.innerHTML = `
					<div class="erc8004-file-drop" data-role="drop">
						<input type="file" accept=".glb,.gltf" class="erc8004-file-input" />
						<span class="erc8004-file-text">${this.form.glbFile ? esc(this.form.glbFile.name) : 'Drop .glb file or click to browse'}</span>
					</div>
				`;
				const drop = panel.querySelector('[data-role="drop"]');
				const input = drop.querySelector('.erc8004-file-input');
				const label = drop.querySelector('.erc8004-file-text');
				const setFile = (f) => {
					if (!f) return;
					if (!/\.(glb|gltf)$/i.test(f.name)) {
						this._toast('Must be a .glb or .gltf file', true);
						return;
					}
					this.form.glbFile = f;
					label.textContent = f.name;
				};
				input.addEventListener('change', (e) => setFile(e.target.files[0]));
				drop.addEventListener('dragover', (e) => {
					e.preventDefault();
					drop.classList.add('erc8004-file-drop--active');
				});
				drop.addEventListener('dragleave', () =>
					drop.classList.remove('erc8004-file-drop--active'),
				);
				drop.addEventListener('drop', (e) => {
					e.preventDefault();
					drop.classList.remove('erc8004-file-drop--active');
					setFile(e.dataTransfer.files[0]);
				});
			} else if (s === 'url') {
				panel.innerHTML = `
					<div class="erc8004-url-paste">
						<input class="erc8004-input" type="url" inputmode="url" autocomplete="off" spellcheck="false" aria-label="GLB file URL" placeholder="https://… or ipfs://… or ar://…" value="${esc(this.form.pastedGlbUrl)}" data-role="glb-url-input" />
						<p class="erc8004-hint">The GLB must include <strong>ARKit / Oculus viseme morph targets</strong> for lip-sync to work.</p>
					</div>
				`;
				panel.querySelector('[data-role="glb-url-input"]').addEventListener('input', (e) => {
					this.form.pastedGlbUrl = e.target.value.trim();
				});
			} else if (s === 'default') {
				panel.innerHTML = `<div class="erc8004-saved-grid" data-role="grid"></div>`;
				const grid = panel.querySelector('[data-role="grid"]');
				if (!DEFAULT_AVATARS.length) {
					grid.innerHTML = `<div class="erc8004-muted">No default avatars available yet.</div>`;
				} else {
					grid.innerHTML = DEFAULT_AVATARS.map(
						(a) => `
							<button type="button" class="erc8004-saved-card ${this.form.defaultAvatarId === a.id ? 'erc8004-saved-card--active' : ''}" data-id="${esc(a.id)}">
								${a.thumbnailUrl ? `<img src="${esc(a.thumbnailUrl)}" alt="" loading="lazy" />` : `<div class="erc8004-saved-card-ph">GLB</div>`}
								<div class="erc8004-saved-card-name">${esc(a.name)}</div>
							</button>
						`,
					).join('');
					grid.querySelectorAll('.erc8004-saved-card').forEach((btn) => {
						btn.addEventListener('click', () => {
							this.form.defaultAvatarId = btn.dataset.id;
							renderPanel();
						});
					});
				}
			} else if (s === 'skip') {
				panel.innerHTML = `
					<div class="erc8004-avatar-summary">
						<span class="erc8004-avatar-summary-badge erc8004-avatar-summary-badge--muted">∅</span>
						<div>
							<div>Deploying as a metadata-only agent.</div>
							<div class="erc8004-hint">Your registration JSON will include <code>image</code> (from Step 1) and services but no GLB. You can attach an avatar later from My Agents → Edit.</div>
						</div>
					</div>
				`;
			}
		};

		renderPanel();

		body.querySelectorAll('input[name="avatarSource"]').forEach((r) => {
			r.addEventListener('change', (e) => {
				this.form.avatarSource = e.target.value;
				this._renderActiveTab(); // re-render to update active-class + panel
			});
		});

		body.querySelector('[name="apiToken"]').addEventListener(
			'input',
			(e) => (this.form.apiToken = e.target.value),
		);
		body.querySelector('[data-role="back"]').addEventListener('click', () => {
			this._goToStep(2);
		});
		body.querySelector('[data-role="next"]').addEventListener('click', () => {
			// Validate the selected source before advancing.
			const s = this.form.avatarSource;
			if (s === 'saved' && !this.form.savedAvatar) {
				this._toast('Pick one of your saved avatars, or choose another option.', true);
				return;
			}
			if (s === 'upload' && !this.form.glbFile) {
				this._toast('Drop a .glb file, or choose another option.', true);
				return;
			}
			if (s === 'url' && !this.form.pastedGlbUrl) {
				this._toast('Paste a GLB URL, or choose another option.', true);
				return;
			}
			if (s === 'default' && !this.form.defaultAvatarId) {
				this._toast('Pick a default avatar, or choose another option.', true);
				return;
			}
			this._goToStep(4);
		});
	}

	_renderStepDeploy(body) {
		if (_isSolana(this.selectedChainId)) {
			return this._renderStepDeploySolana(body);
		}
		const meta = CHAIN_META[this.selectedChainId];
		const walletOk = !!this.wallet;
		const chainOk = walletOk && this.wallet.chainId === this.selectedChainId;
		body.innerHTML = `
			<h3 class="erc8004-h3">Review &amp; Deploy</h3>
			<p class="erc8004-p">Your agent will be minted as an ERC-721 NFT on <b>${esc(meta.name)}</b>. This is the only step that costs gas.</p>

			<dl class="erc8004-summary">
				<dt>Name</dt>        <dd>${esc(this.form.name)}</dd>
				<dt>Description</dt> <dd>${esc(this.form.description)}</dd>
				${this.form.imageUrl ? `<dt>Image</dt>      <dd>${this._imageSummaryHtml()}</dd>` : ''}
				<dt>Avatar</dt>      <dd>${this._avatarSummary()}</dd>
				<dt>Services</dt>    <dd>${this.form.services.length ? this.form.services.map((s) => `${esc(s.type)}: ${esc(s.endpoint || '—')}`).join('<br>') : '<span class="erc8004-muted">none</span>'}</dd>
				<dt>Chain</dt>       <dd>${esc(meta.name)} (chainId ${this.selectedChainId})</dd>
				<dt>Registry</dt>    <dd><code>${esc(REGISTRY_DEPLOYMENTS[this.selectedChainId].identityRegistry)}</code></dd>
			</dl>

			${!walletOk ? `<div class="erc8004-alert">${window.ethereum ? 'Connect a wallet before deploying.' : 'No EVM wallet detected. Install <a class="erc8004-link" href="https://metamask.io/download/" target="_blank" rel="noopener">MetaMask</a>, then reload this page.'} ${window.ethereum ? '<button type="button" class="erc8004-link" data-role="connect-inline">Connect wallet</button>' : ''}</div>` : ''}
			${walletOk && !chainOk ? `<div class="erc8004-alert">Your wallet is on ${esc(CHAIN_META[this.wallet.chainId]?.name || `chain ${this.wallet.chainId}`)}, but this deploy targets ${esc(meta.name)}. <button type="button" class="erc8004-link" data-role="switch">Switch to ${esc(meta.name)}</button></div>` : ''}

			${this.selectedChainId === BSC_TESTNET_CHAIN_ID ? `
				<div class="erc8004-gasless-panel" data-role="gasless-panel">
					<div class="erc8004-gasless-head">
						<span class="erc8004-gasless-badge">⚡ Zero gas</span>
						<div>
							<h4 class="erc8004-h4">Try gasless registration on BNB Chain</h4>
							<p class="erc8004-p erc8004-muted">Mints your agent from a brand-new wallet holding <b>0 tBNB</b> — sponsored by MegaFuel's paymaster, no faucet, no funding, no wallet connection needed.</p>
						</div>
					</div>
					<div class="erc8004-log" data-role="gasless-log"></div>
					<div class="erc8004-result deploy-result" data-role="gasless-result" style="display:none"></div>
					<button type="button" class="erc8004-btn btn btn--secondary" data-role="gasless-deploy">⚡ Register gasless (0 tBNB wallet)</button>
				</div>
			` : ''}

			<details class="erc8004-accordion">
				<summary class="erc8004-accordion-head">📦 Export Options</summary>
				<div class="erc8004-accordion-body">
					<div class="erc8004-export-grid">
						<button type="button" class="erc8004-export-opt" data-role="exp-json">
							<div class="erc8004-export-emoji">📄</div>
							<div class="erc8004-export-title">Export JSON</div>
							<div class="erc8004-export-sub">Raw registration config</div>
						</button>
						<button type="button" class="erc8004-export-opt" data-role="exp-cast">
							<div class="erc8004-export-emoji">⌨️</div>
							<div class="erc8004-export-title">cast / forge</div>
							<div class="erc8004-export-sub">Copy shell command</div>
						</button>
						<button type="button" class="erc8004-export-opt" data-role="exp-viem">
							<div class="erc8004-export-emoji">🧩</div>
							<div class="erc8004-export-title">viem snippet</div>
							<div class="erc8004-export-sub">Copy TS snippet</div>
						</button>
						<button type="button" class="erc8004-export-opt" data-role="exp-curl">
							<div class="erc8004-export-emoji">🌐</div>
							<div class="erc8004-export-title">curl</div>
							<div class="erc8004-export-sub">Query registry via curl</div>
						</button>
					</div>
				</div>
			</details>

			<div class="deploy-phase-track" data-role="phase-track" hidden aria-live="polite">
				<div class="deploy-phase deploy-phase--pending" data-phase="prepare">
					<span class="deploy-phase-dot" aria-hidden="true"></span>
					<div class="deploy-phase-content">
						<span class="deploy-phase-label">Prepare</span>
						<span class="deploy-phase-hint">Pinning metadata to IPFS and building the on-chain record</span>
					</div>
				</div>
				<div class="deploy-phase deploy-phase--pending" data-phase="sign">
					<span class="deploy-phase-dot" aria-hidden="true"></span>
					<div class="deploy-phase-content">
						<span class="deploy-phase-label">Sign</span>
						<span class="deploy-phase-hint">One wallet signature mints your agent as an ERC-721 NFT — no other approvals needed</span>
					</div>
				</div>
				<div class="deploy-phase deploy-phase--pending" data-phase="confirm">
					<span class="deploy-phase-dot" aria-hidden="true"></span>
					<div class="deploy-phase-content">
						<span class="deploy-phase-label">Confirm</span>
						<span class="deploy-phase-hint">Waiting for the transaction to land and the agent ID to be assigned</span>
					</div>
				</div>
			</div>

			<div class="erc8004-log" data-role="log" role="log" aria-live="polite" aria-label="Deploy log"></div>

			<div class="deploy-error-panel" data-role="deploy-error" role="alert" hidden>
				<div class="deploy-error-panel-title">Deploy failed</div>
				<p class="deploy-error-panel-msg" data-role="deploy-error-msg"></p>
				<button type="button" class="erc8004-btn btn btn--secondary" data-role="deploy-retry">Try again</button>
			</div>

			<div class="erc8004-result deploy-result" data-role="result" style="display:none" tabindex="-1">
				<div class="deploy-result-badge" data-role="res-badge"></div>
				<h4 class="erc8004-h4 deploy-result-heading">🎉 Agent registered on-chain</h4>
				<dl class="erc8004-result-dl">
					<dt>Agent ID</dt> <dd data-role="res-id"></dd>
					<dt>Metadata</dt> <dd data-role="res-uri"></dd>
					<dt>Tx Hash</dt>  <dd data-role="res-tx"></dd>
				</dl>
				<div class="erc8004-row">
					<a class="erc8004-btn erc8004-btn--primary btn btn--primary" data-role="view-explorer" target="_blank" rel="noopener">View on explorer ↗</a>
					<button class="erc8004-btn btn btn--secondary" data-role="view-3d">View agent page →</button>
					<button class="erc8004-btn btn btn--secondary" data-role="res-embed">Embed &lt;/&gt;</button>
					<a class="erc8004-btn btn btn--secondary" data-role="res-launch" style="display:none">Launch a coin 🚀</a>
					<a class="erc8004-btn btn btn--secondary" href="/showcase">Browse showcase ↗</a>
				</div>
			</div>

			<div class="erc8004-wizard-nav">
				<button class="erc8004-btn btn btn--secondary" data-role="back">← Back</button>
				<button class="erc8004-btn erc8004-btn--primary btn btn--primary" data-role="deploy" ${walletOk ? '' : 'disabled title="Connect a wallet first"'}>🚀 Register Agent On-Chain</button>
			</div>
		`;
		body.querySelector('[data-role="back"]').addEventListener('click', () => {
			this._goToStep(3);
		});

		body.querySelector('[data-role="connect-inline"]')?.addEventListener('click', () =>
			this._connectWallet(),
		);

		body.querySelector('[data-role="deploy-retry"]').addEventListener('click', () =>
			this._doDeploy(body),
		);

		const switchBtn = body.querySelector('[data-role="switch"]');
		if (switchBtn) {
			switchBtn.addEventListener('click', async () => {
				try {
					await switchChain(this.selectedChainId);
					if (this.wallet) this.wallet.chainId = this.selectedChainId;
					this._renderActiveTab();
				} catch (err) {
					this._toast('Switch failed: ' + err.message, true);
				}
			});
		}

		body.querySelector('[data-role="deploy"]').addEventListener('click', () =>
			this._doDeploy(body),
		);

		body.querySelector('[data-role="gasless-deploy"]')?.addEventListener('click', () =>
			this._doGaslessDeploy(body),
		);

		this._wireExportOptions(body);
	}

	// -----------------------------------------------------------------------
	// Gasless BNB Chain registration (api/bnb/register-agent.js) — a fresh,
	// page-local ephemeral wallet with 0 tBNB mints its identity sponsored by
	// MegaFuel. Independent of the wallet-connect flow above: no signer, no
	// gas, no faucet. See src/erc8004/gasless-register.js for the signing.
	// -----------------------------------------------------------------------

	async _doGaslessDeploy(body) {
		const log = body.querySelector('[data-role="gasless-log"]');
		const resultEl = body.querySelector('[data-role="gasless-result"]');
		const btn = body.querySelector('[data-role="gasless-deploy"]');
		const say = (msg, err = false) => {
			const line = document.createElement('div');
			line.className = 'erc8004-log-line' + (err ? ' erc8004-log-error' : '');
			line.textContent = msg;
			log.appendChild(line);
			log.scrollTop = log.scrollHeight;
		};
		btn.disabled = true;
		resultEl.style.display = 'none';
		resultEl.innerHTML = '';
		log.innerHTML = '';

		const agentURI = this._currentGlbUrl() || this.form.imageUrl || '';

		try {
			const account = getEphemeralAccount();
			say(`Ephemeral wallet: ${account.address} — 0 tBNB, no funding needed.`);
			say('Signing register() with gasPrice: 0…');
			const result = await registerAgentGaslessAttempt({ agentURI, chainId: BSC_TESTNET_CHAIN_ID, network: 'bscTestnet' });

			if (result.alreadyRegistered) {
				say(`This wallet already holds agent #${result.agentId ?? '(id unavailable on this registry)'} — no new mint.`);
				this._renderGaslessResult(resultEl, { mode: 'already', agentURI, ...result });
				return;
			}
			if (result.mode === 'declined') {
				say(`MegaFuel declined sponsorship: ${result.reason || 'no policy for this address'}.`, true);
				say(result.hint || 'Fund the wallet above with a small amount of tBNB, then retry.');
				this._renderGaslessResult(resultEl, { mode: 'declined', agentURI, ...result });
				return;
			}

			say(`Relayed via MegaFuel — mode: ${result.mode}. Tx: ${result.hash}`);
			say(
				result.pending
					? 'Submitted — still confirming (BSC blocks land in well under a second; a slow RPC can lag behind). Check the explorer link.'
					: `Confirmed. Agent ID: ${result.agentId ?? '(pending indexer)'}.`,
			);
			this._renderGaslessResult(resultEl, { mode: 'success', agentURI, ...result });
		} catch (err) {
			say(`Gasless registration failed: ${err.message}`, true);
		} finally {
			btn.disabled = false;
		}
	}

	async _doGaslessSelfPayRetry(el, agentURI) {
		el.innerHTML = `<div class="erc8004-muted">Retrying with a real gasPrice…</div>`;
		try {
			const result = await registerAgentSelfPayRetry({ agentURI, chainId: BSC_TESTNET_CHAIN_ID, network: 'bscTestnet' });
			if (result.alreadyRegistered) {
				this._renderGaslessResult(el, { mode: 'already', agentURI, ...result });
				return;
			}
			this._renderGaslessResult(el, { mode: 'success', agentURI, ...result });
		} catch (err) {
			el.innerHTML = `<div class="erc8004-alert">Self-pay retry failed: ${esc(err.message)}</div>`;
		}
	}

	_renderGaslessResult(el, data) {
		el.style.display = '';
		const address = data.walletAddress || data.address || '';
		if (data.mode === 'already') {
			el.innerHTML = `<div class="erc8004-alert">Wallet <code>${esc(address)}</code> already owns agent <b>#${esc(data.agentId ?? '?')}</b> on this registry.</div>`;
			return;
		}
		if (data.mode === 'declined') {
			el.innerHTML = `
				<div class="erc8004-alert">Sponsorship declined for <code>${esc(address)}</code>: ${esc(data.reason || 'unavailable right now')}.</div>
				<p class="erc8004-p erc8004-muted">${esc(data.hint || 'Fund this wallet with a small amount of tBNB and retry to self-pay.')}</p>
				<button type="button" class="erc8004-btn btn btn--secondary" data-role="gasless-selfpay-retry">I funded it — self-pay retry</button>
			`;
			el.querySelector('[data-role="gasless-selfpay-retry"]').addEventListener('click', () =>
				this._doGaslessSelfPayRetry(el, data.agentURI),
			);
			return;
		}
		el.innerHTML = `
			<div class="deploy-result-badge">${data.mode === 'sponsored' ? '⚡ Sponsored — zero gas' : '⛽ Self-pay'}</div>
			<h4 class="erc8004-h4 deploy-result-heading">Agent registered on BNB Chain testnet</h4>
			<dl class="erc8004-result-dl">
				<dt>Agent ID</dt> <dd>${esc(data.agentId ?? (data.pending ? 'confirming…' : 'unknown'))}</dd>
				<dt>Wallet</dt>   <dd><code>${esc(address)}</code></dd>
				<dt>Tx Hash</dt>  <dd><code>${esc(data.hash || '')}</code></dd>
			</dl>
			${data.explorerUrl ? `<a class="erc8004-btn btn btn--secondary" href="${esc(data.explorerUrl)}" target="_blank" rel="noopener">View on BscScan ↗</a>` : ''}
		`;
	}

	_renderStepDeploySolana(body) {
		const network = _solanaNetwork(this.selectedChainId);
		const chainLabel = SOLANA_LABELS[this.selectedChainId];
		const hasSolanaWallet = !!detectSolanaWallet();
		body.innerHTML = `
			<h3 class="erc8004-h3">Review &amp; Deploy</h3>
			<p class="erc8004-p">Your agent will be minted as a Metaplex Core NFT on <b>${esc(chainLabel)}</b>. This is the only step that costs SOL.</p>

			<dl class="erc8004-summary">
				<dt>Name</dt>        <dd>${esc(this.form.name)}</dd>
				<dt>Description</dt> <dd>${esc(this.form.description)}</dd>
				${this.form.imageUrl ? `<dt>Image</dt>      <dd>${this._imageSummaryHtml()}</dd>` : ''}
				<dt>Avatar</dt>      <dd>${this._avatarSummary()}</dd>
				<dt>Chain</dt>       <dd>${esc(chainLabel)} (${esc(network)})</dd>
				<dt>Standard</dt>    <dd>Metaplex Core (mpl-core)</dd>
			</dl>

			${
				!hasSolanaWallet
					? `<div class="erc8004-alert">No Solana wallet detected. Install <a class="erc8004-link" href="https://phantom.app" target="_blank" rel="noopener">Phantom</a> (or Backpack / Solflare), then reload this page and click Mint.</div>`
					: ''
			}
			<div class="erc8004-alert erc8004-alert--note">
				<b>Note:</b> your Solana wallet must already be linked to this account
				(via Sign-In-with-Solana). If you haven't, <a class="erc8004-link" href="/login.html">link it first</a>.
			</div>

			<div class="deploy-phase-track" data-role="phase-track" hidden aria-live="polite">
				<div class="deploy-phase deploy-phase--pending" data-phase="prepare">
					<span class="deploy-phase-dot" aria-hidden="true"></span>
					<div class="deploy-phase-content">
						<span class="deploy-phase-label">Prepare</span>
						<span class="deploy-phase-hint">Pinning metadata to IPFS and generating the Metaplex Core mint</span>
					</div>
				</div>
				<div class="deploy-phase deploy-phase--pending" data-phase="sign">
					<span class="deploy-phase-dot" aria-hidden="true"></span>
					<div class="deploy-phase-content">
						<span class="deploy-phase-label">Sign</span>
						<span class="deploy-phase-hint">Phantom (or Backpack) will request one transaction — approve to mint the agent NFT</span>
					</div>
				</div>
				<div class="deploy-phase deploy-phase--pending" data-phase="confirm">
					<span class="deploy-phase-dot" aria-hidden="true"></span>
					<div class="deploy-phase-content">
						<span class="deploy-phase-label">Confirm</span>
						<span class="deploy-phase-hint">Waiting for the Solana transaction to finalize</span>
					</div>
				</div>
			</div>

			<div class="erc8004-log" data-role="log"></div>

			<div class="erc8004-result deploy-result" data-role="result" style="display:none">
				<div class="deploy-result-badge" data-role="res-badge"></div>
				<h4 class="erc8004-h4 deploy-result-heading">Agent minted on Solana</h4>
				<dl class="erc8004-result-dl">
					<dt>Asset</dt>      <dd data-role="res-id"></dd>
					<dt>Network</dt>    <dd data-role="res-uri"></dd>
					<dt>Tx Signature</dt><dd data-role="res-tx"></dd>
				</dl>
				<div class="erc8004-row">
					<a class="erc8004-btn btn btn--secondary" data-role="view-explorer" target="_blank" rel="noopener">Explorer ↗</a>
					<a class="erc8004-btn btn btn--secondary" href="/showcase">Browse showcase ↗</a>
				</div>
			</div>

			<div class="erc8004-wizard-nav">
				<button class="erc8004-btn btn btn--secondary" data-role="back">← Back</button>
				<button class="erc8004-btn erc8004-btn--primary btn btn--primary" data-role="deploy" ${hasSolanaWallet ? '' : 'disabled'}>🚀 Mint on ${esc(chainLabel)}</button>
			</div>
		`;
		body.querySelector('[data-role="back"]').addEventListener('click', () => {
			this.wizardStep = 3;
			this._renderActiveTab();
		});
		body.querySelector('[data-role="deploy"]').addEventListener('click', () =>
			this._doSolanaDeploy(body),
		);
	}

	// -----------------------------------------------------------------------
	// Avatar persistence — turn the chosen Step-3 source into a REAL avatars
	// row (GLB stored in R2 + a rendered poster) so the minted asset resolves a
	// 3D body and an image. The mint pipeline keys everything off a real
	// avatar_id; a session/draft GLB that only ever lived in the viewer has no
	// row, so without this the asset mints hollow (generic logo, empty body) —
	// the exact bug being fixed. Returns { avatarId, modelUrl, imageUrl }, or
	// null for the explicit metadata-only ("skip") choice.
	// -----------------------------------------------------------------------

	async _ensurePersistedAvatar(say = () => {}) {
		const f = this.form;
		const src = f.avatarSource;
		if (src === 'skip') return null;

		// Already a persisted row (saved-avatar pick, or a current-session avatar
		// that was loaded from one). Reuse it — but guarantee it has a poster so
		// the NFT image isn't blank.
		const existingId =
			(src === 'saved' && f.savedAvatar?.id) ? f.savedAvatar.id
			: (src === 'current' && this._avatarId) ? this._avatarId
			: null;

		if (existingId) {
			// The row already exists; prep resolves its poster + body server-side
			// from thumbnail_key/storage_key by avatar_id, so no client fetch is
			// needed. Pass through whatever URLs we have for the live preview.
			const imageUrl = (src === 'saved' ? f.savedAvatar?.thumbnailUrl : null) || f.imageUrl || null;
			const modelUrl = (src === 'saved' ? f.savedAvatar?.modelUrl : null) || f.glbUrl || null;
			return { avatarId: existingId, modelUrl, imageUrl };
		}

		// A new row is required (current-draft / upload / pasted-url / default).
		const { blob, filename } = await this._acquireGlbBlob(say);
		say('Saving your avatar…');
		const { storageKey, sizeBytes } = await this._ensureOwnedGlb(blob, filename, say);
		const avatar = await this._createAvatarRow({ storageKey, sizeBytes, name: f.name, blob });
		const imageUrl = await this._renderAndAttachThumbnail(avatar.id, blob, say);

		// Cache so a back-and-retry doesn't re-upload the same bytes.
		this._avatarId = avatar.id;
		f.savedAvatar = { id: avatar.id, name: avatar.name, modelUrl: avatar.model_url || null, thumbnailUrl: imageUrl };
		return { avatarId: avatar.id, modelUrl: avatar.model_url || null, imageUrl };
	}

	/** Fetch the chosen source's GLB bytes (needed for upload + poster render). */
	async _acquireGlbBlob(say = () => {}) {
		const f = this.form;
		const src = f.avatarSource;
		if (src === 'upload' && f.glbFile) {
			return { blob: f.glbFile, filename: f.glbFile.name || 'avatar.glb' };
		}
		let url = '';
		if (src === 'current') url = f.glbUrl;
		else if (src === 'url') url = (f.pastedGlbUrl || '').trim();
		else if (src === 'default') url = getDefaultAvatar(f.defaultAvatarId)?.url || '';
		else url = f.glbUrl || (f.pastedGlbUrl || '').trim();
		if (!url) throw new Error('No 3D model to attach — choose an avatar in the Avatar step first.');

		const fetchUrl = url.startsWith('ipfs://')
			? url.replace('ipfs://', 'https://ipfs.io/ipfs/')
			: url;
		const sameOrigin = (() => { try { return new URL(fetchUrl, location.href).origin === location.origin; } catch { return false; } })();
		say('Fetching 3D model…');
		let resp;
		try {
			resp = await fetch(fetchUrl, { credentials: sameOrigin ? 'include' : 'omit' });
		} catch {
			throw new Error('Could not fetch the 3D model (network or CORS). Re-upload the GLB and retry.');
		}
		if (!resp.ok) throw new Error(`Could not fetch the 3D model (HTTP ${resp.status}).`);
		const blob = await resp.blob();
		if (!blob.size) throw new Error('The 3D model is empty.');
		const base = (url.split('/').pop() || 'avatar.glb').split('?')[0];
		return { blob, filename: base.toLowerCase().endsWith('.glb') ? base : 'avatar.glb' };
	}

	/**
	 * Return a caller-owned R2 storage key for the GLB. Reuses an already-uploaded
	 * draft when the current source points straight at our bucket (no re-upload);
	 * otherwise uploads the bytes via the presign+PUT path.
	 */
	async _ensureOwnedGlb(blob, filename, say = () => {}) {
		const derived = this.form.avatarSource === 'current' ? this._deriveOwnedGlbKey(this.form.glbUrl) : null;
		if (derived) return { storageKey: derived, sizeBytes: blob.size };
		return this._uploadGlb(blob, filename, say);
	}

	/** Map a public R2 URL back to its `u/<userId>/…/*.glb` object key, or null. */
	_deriveOwnedGlbKey(url) {
		if (!url) return null;
		let path;
		try { path = new URL(url, location.href).pathname; } catch { return null; }
		const key = decodeURIComponent(path.replace(/^\/+/, ''));
		return /^u\/[^/]+\/.+\.glb$/i.test(key) ? key : null;
	}

	/** Upload GLB bytes to R2 via a presigned PUT; returns the owned storage key. */
	async _uploadGlb(blob, filename, say = () => {}) {
		say('Uploading 3D model…');
		const presignRes = await fetch('/api/avatar/presign-glb', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ filename: filename || 'avatar.glb', content_type: 'model/gltf-binary', bytes: blob.size }),
		});
		if (!presignRes.ok) {
			const e = await presignRes.json().catch(() => ({}));
			throw new Error(e.error_description || `Could not presign upload (HTTP ${presignRes.status}).`);
		}
		const { upload_url, storage_key } = await presignRes.json();
		const put = await fetch(upload_url, {
			method: 'PUT',
			headers: { 'content-type': 'model/gltf-binary' },
			body: blob,
		});
		if (!put.ok) throw new Error(`Upload to storage failed (HTTP ${put.status}).`);
		return { storageKey: storage_key, sizeBytes: blob.size };
	}

	/** Create the avatars row from an owned storage key. Re-uploads + retries once
	 *  if a reused draft key fails server validation. */
	async _createAvatarRow({ storageKey, sizeBytes, name, blob }) {
		const res = await fetch('/api/avatars', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				name: (name || 'Agent').trim().slice(0, 80) || 'Agent',
				storage_key: storageKey,
				size_bytes: sizeBytes,
				content_type: 'model/gltf-binary',
				source: 'upload',
				visibility: 'unlisted',
			}),
		});
		if (res.ok) return (await res.json()).avatar;

		const e = await res.json().catch(() => ({}));
		if (blob && ['size_mismatch', 'upload_missing', 'invalid_storage_key'].includes(e.error)) {
			const fresh = await this._uploadGlb(blob, 'avatar.glb');
			return this._createAvatarRow({ storageKey: fresh.storageKey, sizeBytes: fresh.sizeBytes, name });
		}
		throw new Error(e.error_description || `Could not save avatar (HTTP ${res.status}).`);
	}

	/** Render a 512² poster from the GLB and attach it to the avatar row. A missing
	 *  poster never blocks the mint — the body still resolves and the manifest
	 *  falls back to the brand image. */
	async _renderAndAttachThumbnail(avatarId, blob, say = () => {}) {
		try {
			say('Rendering preview image…');
			const png = await glbFileToThumbnail(blob, { size: 512 });
			const b64 = await this._blobToDataUrl(png);
			const res = await fetch('/api/avatars/thumbnail', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ avatar_id: avatarId, png_base64: b64 }),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return (await res.json())?.data?.thumbnail_url || null;
		} catch (err) {
			say(`Preview image skipped (${err.message}) — minting with the brand image.`);
			return null;
		}
	}

	_blobToDataUrl(blob) {
		return new Promise((resolve, reject) => {
			const r = new FileReader();
			r.onload = () => resolve(r.result);
			r.onerror = reject;
			r.readAsDataURL(blob);
		});
	}

	async _doSolanaDeploy(body) {
		const log = body.querySelector('[data-role="log"]');
		const say = (msg, err = false) => {
			const line = document.createElement('div');
			line.className = 'erc8004-log-line' + (err ? ' erc8004-log-error' : '');
			line.textContent = msg;
			log.appendChild(line);
			log.scrollTop = log.scrollHeight;
		};
		const deployBtn = body.querySelector('[data-role="deploy"]');
		deployBtn.disabled = true;

		// Guard: name + description are required before any on-chain transaction.
		if (!this.form.name.trim() || !this.form.description.trim()) {
			this._toast('Name and description are required before deploying.', true);
			deployBtn.disabled = false;
			return;
		}

		const setPhase = this._makePhaseTracker(body);
		setPhase('prepare');

		const network = _solanaNetwork(this.selectedChainId);

		try {
			// Persist the chosen avatar into a real avatars row (GLB + rendered
			// poster) BEFORE spending SOL, so the minted asset resolves a 3D body
			// and an image. The prior code forwarded only a saved-avatar id and
			// silently dropped the live session/draft avatar — minting a hollow
			// asset (generic logo, empty body). A metadata-only deploy is only ever
			// the explicit "Skip — no 3D body" choice; any other source that can't
			// be saved aborts here instead of writing an empty NFT.
			let avatar = null;
			if (this.form.avatarSource !== 'skip') {
				avatar = await this._ensurePersistedAvatar(say);
				if (!avatar?.avatarId) {
					throw new Error('Could not prepare your avatar — fix the Avatar step and retry, or choose “Skip — no 3D body”.');
				}
				if (avatar.imageUrl) {
					this.form.imageUrl = avatar.imageUrl;
					try { this._refreshPreview(); } catch { /* preview is best-effort */ }
				}
			}

			const synthAgent = {
				id: this._backendAgentId || 'wizard',
				name: this.form.name,
				description: this.form.description,
				avatarId: avatar?.avatarId || undefined,
			};

			say(avatar ? 'Avatar saved — connecting Solana wallet…' : 'Connecting Solana wallet…');
			setPhase('sign');
			const result = await runSolanaDeploy({ agent: synthAgent, network });
			setPhase('confirm');
			say(`Minted asset ${result.assetPubkey}`);
			say(`Tx ${result.txSignature}`);
			setPhase('done');

			body.querySelector('[data-role="result"]').style.display = '';
			body.querySelector('[data-role="res-id"]').textContent = result.assetPubkey;
			body.querySelector('[data-role="res-uri"]').textContent = network;
			body.querySelector('[data-role="res-tx"]').textContent = result.txSignature;
			body.querySelector('[data-role="view-explorer"]').href = solanaTxExplorerUrl(
				network,
				result.txSignature,
			);

			const badgeEl = body.querySelector('[data-role="res-badge"]');
			if (badgeEl) {
				const cluster = network === 'devnet' ? 'devnet' : 'mainnet';
				const caip2 = cluster === 'devnet'
					? 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
					: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
				badgeEl.innerHTML = onchainBadgeHTML(
					{ onchain: { family: 'solana', chain: caip2, cluster, contract_or_mint: result.assetPubkey, tx_hash: result.txSignature } },
					{ size: 'md', showChain: true },
				);
			}

			this.onRegistered({
				agentId: result.agent?.id || result.assetPubkey,
				txHash: result.txSignature,
				chainId: this.selectedChainId,
			});
		} catch (err) {
			if (err?.code === 'forbidden') {
				say(
					'Wallet not linked — sign in with your Solana wallet first, then retry.',
					true,
				);
			} else if (err?.code === 'payment_required') {
				say(`${err.message || 'Paid plan required'} — upgrade to use 5+ char vanity prefixes.`, true);
			} else {
				say(_classifyDeployError(err.message || String(err), err), true);
			}
			deployBtn.disabled = false;
		}
	}

	/**
	 * One-line summary of the user's Step 3 avatar choice, shown on the Deploy
	 * review screen.
	 */
	_avatarSummary() {
		const s = this.form.avatarSource;
		// On Solana, a source that still needs a row gets saved + rendered into a
		// poster at deploy time — say so, so "✓ Avatar" doesn't imply it's already
		// attached. (EVM pins its own registration JSON via a different path.)
		const willSave = _isSolana(this.selectedChainId)
			? ' <span class="erc8004-muted">· saved &amp; rendered on deploy</span>'
			: '';
		if (s === 'current' && this.form.glbUrl) {
			const saved = this._avatarId ? '' : willSave;
			return `Current session avatar — <code>${esc(this.form.glbUrl)}</code>${saved}`;
		}
		if (s === 'saved' && this.form.savedAvatar) {
			return `Saved: ${esc(this.form.savedAvatar.name)}`;
		}
		if (s === 'upload' && this.form.glbFile) {
			return `Uploaded: ${esc(this.form.glbFile.name)} (${(this.form.glbFile.size / 1024).toFixed(1)} KB)${willSave}`;
		}
		if (s === 'url' && this.form.pastedGlbUrl) {
			return `URL: <code>${esc(this.form.pastedGlbUrl)}</code>${willSave}`;
		}
		if (s === 'default' && this.form.defaultAvatarId) {
			const def = getDefaultAvatar(this.form.defaultAvatarId);
			return def ? `Default: ${esc(def.name)}` : `Default avatar`;
		}
		if (s === 'skip') return `<span class="erc8004-muted">None — metadata-only</span>`;
		return `<span class="erc8004-muted">Not selected</span>`;
	}

	/**
	 * Compact, human-readable summary of the agent image for the Review step.
	 * A 3D-capture ("📸 Use 3D view") can leave an inline base64 data: URL of
	 * tens of thousands of characters — never dump that raw into the page.
	 * Render the actual thumbnail plus a short label instead of the string.
	 */
	_imageSummaryHtml() {
		const url = (this.form.imageUrl || '').trim();
		if (!url) return '';
		const thumb = `<img loading="lazy" decoding="async" src="${esc(url)}" alt="Agent image" class="erc8004-img-thumb"
			onerror="this.style.display='none'" />`;
		if (url.startsWith('data:')) {
			const kb = Math.round((url.length * 0.75) / 1024);
			return `<span class="erc8004-img-summary">${thumb}<span class="erc8004-muted">Captured from 3D view · inline image (~${kb} KB)</span></span>`;
		}
		const label = url.length > 64 ? url.slice(0, 48) + '…' + url.slice(-12) : url;
		return `<span class="erc8004-img-summary">${thumb}<a href="${esc(url)}" target="_blank" rel="noopener"><code>${esc(label)}</code></a></span>`;
	}

	/**
	 * Drives the deploy-phase-track indicator in Step 4.
	 * Returns (phaseName) => void to advance to a given phase.
	 * Pass 'done' to mark all phases complete.
	 */
	_makePhaseTracker(body) {
		const track = body.querySelector('[data-role="phase-track"]');
		if (!track) return () => {};
		const order = ['prepare', 'sign', 'confirm'];
		return (phase) => {
			track.hidden = false;
			if (phase === 'done') {
				track.querySelectorAll('[data-phase]').forEach((el) => {
					el.classList.remove('deploy-phase--pending', 'deploy-phase--active');
					el.classList.add('deploy-phase--done');
				});
				return;
			}
			const idx = order.indexOf(phase);
			track.querySelectorAll('[data-phase]').forEach((el) => {
				const pi = order.indexOf(el.dataset.phase);
				el.classList.toggle('deploy-phase--done', pi < idx);
				el.classList.toggle('deploy-phase--active', pi === idx);
				el.classList.toggle('deploy-phase--pending', pi > idx);
			});
		};
	}

	/**
	 * Wrap say() with keyword-based phase advancement so the phase tracker
	 * automatically advances when registerAgent / runSolanaDeploy emit known
	 * status strings. setPhase is always called explicitly at the right points
	 * too — the keyword detection is a belt-and-suspenders safety net.
	 */
	_phaseAwareSay(say, setPhase) {
		return (msg, err = false) => {
			say(msg, err);
			if (err) return;
			const m = String(msg || '').toLowerCase();
			if (m.includes('sign') || m.includes('approv') || m.includes('phantom') ||
				m.includes('wallet') || m.includes('metamask')) {
				setPhase('sign');
			} else if (m.includes('wait') || m.includes('confirm') || m.includes('broadcast') ||
				m.includes('mining') || m.includes('block') || m.includes('finali')) {
				setPhase('confirm');
			}
		};
	}

	_wireExportOptions(body) {
		const buildJSON = () => {
			const identityAddr = REGISTRY_DEPLOYMENTS[this.selectedChainId].identityRegistry;
			// Preview JSON should match the shape `_doRegister` actually mints so
			// users export what they're about to deploy.
			const extra = (this.form.services || [])
				.filter((s) => s.endpoint?.trim())
				.map((s) => ({
					name: s.name || s.type,
					type: s.type,
					endpoint: s.endpoint,
					version: '1.0',
				}));
			// Best-effort glbUrl preview: 'current' uses pre-fill; 'saved' uses the
			// picked avatar's known URL; 'default' uses the picked default's known
			// URL; 'upload' is unknown until pin; 'skip' is omitted entirely.
			let glbUrl = null;
			if (this.form.avatarSource === 'current') glbUrl = this.form.glbUrl || null;
			else if (this.form.avatarSource === 'saved')
				glbUrl = this.form.savedAvatar?.modelUrl || null;
			else if (this.form.avatarSource === 'default' && this.form.defaultAvatarId)
				glbUrl = getDefaultAvatar(this.form.defaultAvatarId)?.url || null;
			else if (this.form.avatarSource === 'upload' && this.form.glbFile)
				glbUrl = `<pending-upload:${this.form.glbFile.name}>`;
			else if (this.form.avatarSource === 'url' && this.form.pastedGlbUrl)
				glbUrl = this.form.pastedGlbUrl;

			return buildRegistrationJSON({
				name: this.form.name,
				description: this.form.description,
				imageUrl: this.form.imageUrl || glbUrl || '',
				glbUrl: glbUrl || undefined,
				agentId: 'PENDING',
				chainId: this.selectedChainId,
				registryAddr: identityAddr,
				services: extra,
			});
		};
		const download = (text, filename, mime = 'application/json') => {
			const blob = new Blob([text], { type: mime });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = filename;
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 2000);
		};
		const copy = async (text) => {
			try {
				await navigator.clipboard.writeText(text);
				this._toast('Copied to clipboard');
			} catch {
				this._toast('Copy failed', true);
			}
		};

		const jsonBtn = body.querySelector('[data-role="exp-json"]');
		const castBtn = body.querySelector('[data-role="exp-cast"]');
		const viemBtn = body.querySelector('[data-role="exp-viem"]');
		const curlBtn = body.querySelector('[data-role="exp-curl"]');
		if (!jsonBtn) return;

		jsonBtn.addEventListener('click', () => {
			download(JSON.stringify(buildJSON(), null, 2), 'agent-registration.json');
			this._toast('JSON downloaded');
		});
		castBtn.addEventListener('click', () => {
			const identityAddr = REGISTRY_DEPLOYMENTS[this.selectedChainId].identityRegistry;
			const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(buildJSON()))));
			const uri = `data:application/json;base64,${b64}`;
			const cmd = `cast send ${identityAddr} "register(string)" '${uri}' \\\n  --rpc-url ${CHAIN_META[this.selectedChainId].rpcUrl} \\\n  --private-key $PRIVATE_KEY`;
			copy(cmd);
		});
		viemBtn.addEventListener('click', () => {
			const identityAddr = REGISTRY_DEPLOYMENTS[this.selectedChainId].identityRegistry;
			const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(buildJSON()))));
			const uri = `data:application/json;base64,${b64}`;
			const snippet = `import { createWalletClient, http, parseAbi } from 'viem';\nimport { privateKeyToAccount } from 'viem/accounts';\n\nconst account = privateKeyToAccount(process.env.PRIVATE_KEY);\nconst client = createWalletClient({ account, transport: http('${CHAIN_META[this.selectedChainId].rpcUrl}') });\n\nawait client.writeContract({\n  address: '${identityAddr}',\n  abi: parseAbi(['function register(string) external returns (uint256)']),\n  functionName: 'register',\n  args: ['${uri}'],\n});`;
			copy(snippet);
		});
		curlBtn.addEventListener('click', () => {
			const identityAddr = REGISTRY_DEPLOYMENTS[this.selectedChainId].identityRegistry;
			const query = `query { agents(where: { registry: "${identityAddr.toLowerCase()}" }, first: 5) { id agentId agentURI owner } }`;
			const cmd = `curl -X POST https://api.thegraph.com/subgraphs/name/erc-8004/registry \\\n  -H 'content-type: application/json' \\\n  -d '${JSON.stringify({ query })}'`;
			copy(cmd);
		});
	}

	async _doDeploy(body) {
		const log = body.querySelector('[data-role="log"]');
		const say = (msg, err = false) => {
			const line = document.createElement('div');
			line.className = 'erc8004-log-line' + (err ? ' erc8004-log-error' : '');
			line.textContent = msg;
			log.appendChild(line);
			log.scrollTop = log.scrollHeight;
		};
		const deployBtn = body.querySelector('[data-role="deploy"]');
		deployBtn.disabled = true;

		// Guard: name + description are required before any on-chain transaction.
		if (!this.form.name.trim() || !this.form.description.trim()) {
			this._toast('Name and description are required before deploying.', true);
			deployBtn.disabled = false;
			return;
		}

		const setPhase = this._makePhaseTracker(body);
		const phaseSay = this._phaseAwareSay(say, setPhase);
		setPhase('prepare');

		try {
			// Ensure we're on the target chain
			if (this.wallet && this.wallet.chainId !== this.selectedChainId) {
				say(`Switching to ${CHAIN_META[this.selectedChainId].name}…`);
				await switchChain(this.selectedChainId);
				this.wallet.chainId = this.selectedChainId;
			}

			const result = await this._doRegister(phaseSay);

			setPhase('done');
			body.querySelector('[data-role="result"]').style.display = '';
			body.querySelector('[data-role="res-id"]').textContent = String(result.agentId);
			body.querySelector('[data-role="res-uri"]').textContent = result.registrationUrl;
			body.querySelector('[data-role="res-tx"]').textContent = result.txHash;

			const view3D = body.querySelector('[data-role="view-3d"]');
			view3D.addEventListener('click', () => {
				window.location.href = `/a/${this.selectedChainId}/${result.agentId}`;
			});
			body.querySelector('[data-role="view-explorer"]').href = txExplorerUrl(
				this.selectedChainId,
				result.txHash,
			);

			const badgeEl = body.querySelector('[data-role="res-badge"]');
			if (badgeEl) {
				badgeEl.innerHTML = onchainBadgeHTML(
					{ agentId: String(result.agentId), chainId: this.selectedChainId },
					{ size: 'md', showChain: true },
				);
			}

			this.onRegistered({ ...result, chainId: this.selectedChainId });
			await this._linkAgentToAccount({
				agentId: result.agentId,
				chainId: this.selectedChainId,
				txHash: result.txHash,
			});
			this._refreshStats();
		} catch (err) {
			const raw = err.shortMessage || err.message || String(err);
			const errMsg = _classifyDeployError(raw, err);
			say(errMsg, true);
			deployBtn.disabled = false;
		}
	}

	/**
	 * Unified deploy flow covering all avatar scenarios:
	 *   - 'upload'  → pin the dropped File
	 *   - 'current' → reference existing stable URL (ipfs/https) without re-pinning,
	 *                 or fetch+pin if it's a blob:/data: URL
	 *   - 'saved'   → same bypass logic for stable saved-avatar URLs
	 *   - 'skip'    → no GLB, metadata-only agent
	 *
	 * If a GLB is present but no 2D `imageUrl` was supplied, auto-render a
	 * 512×512 PNG thumbnail from the GLB and pin it so ERC-721 marketplaces
	 * have a valid value for the `image` field.
	 */
	async _doRegister(say) {
		const {
			name,
			description,
			imageUrl: userImageUrl,
			services,
			apiToken,
			avatarSource,
		} = this.form;
		const extraServices = services
			.filter((s) => s.endpoint.trim())
			.map((s) => ({
				name: s.name || s.type,
				type: s.type,
				endpoint: s.endpoint,
				version: '1.0',
			}));

		// Resolve avatarSource → { glbFile?, glbUrl?, imageUrl? }. Stable URLs skip
		// re-pinning; everything else is fetched into a File so `registerAgent` can
		// pin it (and render a 2D thumbnail) uniformly. Defaults ship their own
		// thumbnail, so we pre-seed `imageUrl` to skip client-side re-rendering.
		let glbFile = null;
		let glbUrl = null;
		let imageUrl = userImageUrl;

		if (avatarSource === 'upload') {
			glbFile = this.form.glbFile;
		} else if (avatarSource === 'default' && this.form.defaultAvatarId) {
			const def = getDefaultAvatar(this.form.defaultAvatarId);
			if (def) {
				glbUrl = def.url;
				if (!imageUrl && def.thumbnailUrl) imageUrl = def.thumbnailUrl;
				say(`Using default avatar: ${def.name}`);
			}
		} else if (avatarSource === 'current' && this.form.glbUrl) {
			if (_isStableUrl(this.form.glbUrl)) {
				glbUrl = this.form.glbUrl;
				say(`Reusing existing avatar URL (no re-upload): ${glbUrl}`);
			} else {
				glbFile = await this._fetchUrlAsFile(this.form.glbUrl, say, 'current avatar');
			}
		} else if (avatarSource === 'url' && this.form.pastedGlbUrl) {
			if (_isStableUrl(this.form.pastedGlbUrl)) {
				glbUrl = this.form.pastedGlbUrl;
				say(`Using pasted GLB URL (no re-upload): ${glbUrl}`);
			} else {
				glbFile = await this._fetchUrlAsFile(this.form.pastedGlbUrl, say, 'pasted GLB');
			}
		} else if (avatarSource === 'saved' && this.form.savedAvatar) {
			try {
				say(`Resolving saved avatar: ${this.form.savedAvatar.name}…`);
				const url = await this._resolveSavedAvatarUrl(this.form.savedAvatar);
				if (!url) throw new Error('no download URL');
				if (_isStableUrl(url)) {
					glbUrl = url;
					say(`Reusing saved avatar URL (no re-upload): ${url}`);
				} else {
					glbFile = await this._fetchUrlAsFile(url, say, this.form.savedAvatar.name);
				}
			} catch (err) {
				say(
					`Could not load saved avatar (${err.message}) — deploying metadata-only.`,
					true,
				);
			}
		}

		return await registerAgent({
			name,
			description,
			glbFile: glbFile || undefined,
			glbUrl: glbUrl || undefined,
			imageUrl: imageUrl || undefined,
			apiToken: apiToken || undefined,
			services: extraServices,
			x402Support: !!this.form.x402Support,
			onStatus: say,
		});
	}

	/**
	 * Fetch a URL and wrap the response as a File for the pinning pipeline.
	 * Returns null on failure (after logging via `say`).
	 */
	async _fetchUrlAsFile(url, say, label = 'avatar') {
		try {
			say(`Fetching ${label}…`);
			const res = await fetch(url, { credentials: 'include' });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const blob = await res.blob();
			const fileName = url.split('/').pop()?.split('?')[0] || 'avatar.glb';
			return new File([blob], fileName, { type: blob.type || 'model/gltf-binary' });
		} catch (err) {
			say(`Could not fetch ${label} (${err.message}) — continuing without GLB.`, true);
			return null;
		}
	}

	// -----------------------------------------------------------------------
	// Tab: My Agents
	// -----------------------------------------------------------------------

	_renderMyAgents(body) {
		if (_isSolana(this.selectedChainId)) {
			body.innerHTML = `
				<h3 class="erc8004-h3">Your Registered Agents</h3>
				<p class="erc8004-p">Listing on-chain Solana agents from this tab isn't wired up yet —
				use <a class="erc8004-link" data-role="goto-create" href="#">Create Agent →</a> to mint
				a new agent on <b>${esc(SOLANA_LABELS[this.selectedChainId])}</b>.</p>
			`;
			body.querySelector('[data-role="goto-create"]').addEventListener('click', (e) => {
				e.preventDefault();
				this._setTab('create');
			});
			return;
		}
		body.innerHTML = `
			<h3 class="erc8004-h3">Your Registered Agents</h3>
			${
				this.wallet
					? `<p class="erc8004-p">Connected as <code>${esc(this.wallet.address)}</code> on <b>${esc(CHAIN_META[this.selectedChainId]?.name || '?')}</b>.</p>`
					: `<p class="erc8004-p erc8004-muted">Connect a wallet to see agents you own.</p>`
			}
			<div data-role="list"></div>
		`;
		if (!this.wallet) return;

		const list = body.querySelector('[data-role="list"]');
		list.innerHTML = `<div class="erc8004-muted">Scanning…</div>`;

		listAgentsByOwner({
			chainId: this.selectedChainId,
			owner: this.wallet.address,
			ethProvider: window.ethereum,
		})
			.then(async (res) => {
				if (res.count === 0) {
					list.innerHTML = `<div class="erc8004-muted">No agents registered on this chain yet. <a class="erc8004-link" data-role="goto-create">Create one →</a> or <a class="erc8004-link" href="/discover" target="_blank" rel="noopener">browse other on-chain agents ↗</a>.</div>`;
					list.querySelector('[data-role="goto-create"]').addEventListener(
						'click',
						(e) => {
							e.preventDefault();
							this._setTab('create');
						},
					);
					return;
				}
				if (res.ids.length === 0 && res.partial) {
					const explorer = addressExplorerUrl(this.selectedChainId, this.wallet.address);
					list.innerHTML = `
					<div class="erc8004-muted">
						You own ${res.count} agent(s) but details could not be loaded from recent blocks.
						<a href="${esc(explorer)}" target="_blank" rel="noopener" class="erc8004-link">Check explorer ↗</a>
					</div>`;
					return;
				}
				list.innerHTML = '';
				for (const id of res.ids) {
					const card = document.createElement('div');
					card.className = 'erc8004-agent-card';
					card.innerHTML = `<div class="erc8004-muted">Loading #${id}…</div>`;
					list.appendChild(card);
					this._fillAgentCard(card, id, { withQR: true, withEdit: true });
				}
				if (res.partial) {
					const note = document.createElement('div');
					note.className = 'erc8004-muted';
					note.textContent = `Showing ${res.ids.length} of ${res.count} agents — older mints may be outside the scanned block window.`;
					list.appendChild(note);
				}
			})
			.catch((err) => {
				list.innerHTML = `<div class="erc8004-log-error">Query failed: ${esc(err.message)}</div>`;
			});
	}

	async _fillAgentCard(card, agentId, opts = {}) {
		try {
			const { uri, owner } = await getAgentOnchain({
				chainId: this.selectedChainId,
				agentId,
				ethProvider: window.ethereum,
			});
			const meta = uri ? await fetchAgentMetadata(uri) : { ok: false, error: 'no uri' };
			const registryAddr = REGISTRY_DEPLOYMENTS[this.selectedChainId].identityRegistry;
			const tokenUrl = tokenExplorerUrl(this.selectedChainId, registryAddr, agentId);

			const name = meta.ok ? meta.data.name || `Agent #${agentId}` : `Agent #${agentId}`;
			const description = meta.ok ? meta.data.description : '';
			const image = meta.ok ? meta.data.image : '';
			const glbUrl = meta.ok ? findAvatar3D(meta.data) : null;
			const hasX402 = meta.ok && (meta.data.x402Support || meta.data.x402);
			card._meta = meta.ok ? meta.data : null;
			card._owner = owner;
			const publicUrl = `/a/${this.selectedChainId}/${agentId}`;

			const isOwner =
				this.wallet && owner && this.wallet.address.toLowerCase() === owner.toLowerCase();
			const showLink = isOwner && this._signedIn && this._backendAgentId;

			card.innerHTML = `
				<div class="erc8004-agent-card-inner">
					<div class="erc8004-agent-card-img">
						${image ? `<img src="${esc(resolveGateway(image))}" alt="" loading="lazy" />` : `<div class="erc8004-agent-card-ph">🤖</div>`}
					</div>
					<div class="erc8004-agent-card-body">
						<div class="erc8004-agent-card-head">
							<strong>${esc(name)}</strong>
							<span class="erc8004-tag">#${agentId}</span>
							${hasX402 ? `<span class="erc8004-tag erc8004-tag--x402">x402 💳</span>` : ''}
							${isOwner ? `<span class="erc8004-tag erc8004-tag--owner">You own this</span>` : ''}
							${glbUrl ? `<span class="erc8004-tag" title="Resolvable 3D avatar">3D</span>` : ''}
						</div>
						${description ? `<p class="erc8004-p erc8004-clip">${esc(description)}</p>` : ''}
						<div class="erc8004-agent-card-actions">
							${tokenUrl ? `<a class="erc8004-link" href="${esc(tokenUrl)}" target="_blank" rel="noopener">Details ↗</a>` : ''}
							${glbUrl ? `<a class="erc8004-link" href="${esc(publicUrl)}">Open in 3D ↗</a>` : `<a class="erc8004-link" href="#agent=${agentId}">Open in viewer</a>`}
							<button type="button" class="erc8004-link" data-role="embed">Embed &lt;/&gt;</button>
							${opts.withQR && tokenUrl ? `<button type="button" class="erc8004-link" data-role="qr">QR</button>` : ''}
							${opts.withEdit ? `<button type="button" class="erc8004-link" data-role="edit">Edit on-chain ✏️</button>` : ''}
							${isOwner ? `<button type="button" class="erc8004-link" data-role="redeploy">Deploy on another chain 🌐</button>` : ''}
							${isOwner ? `<button type="button" class="erc8004-link" data-role="transfer">Transfer 🔁</button>` : ''}
							${showLink ? `<button type="button" class="erc8004-link" data-role="link">Link to my account 🔗</button>` : ''}
						</div>
					</div>
				</div>
			`;

			const embedBtn = card.querySelector('[data-role="embed"]');
			if (embedBtn)
				embedBtn.addEventListener('click', () =>
					this._openEmbedModal({ agentId, name, glbUrl }),
				);
			if (opts.withQR && tokenUrl) {
				const qrBtn = card.querySelector('[data-role="qr"]');
				if (qrBtn)
					qrBtn.addEventListener('click', () =>
						this._openQRModal({ agentId, url: tokenUrl }),
					);
			}
			if (opts.withEdit) {
				const editBtn = card.querySelector('[data-role="edit"]');
				if (editBtn)
					editBtn.addEventListener('click', () =>
						this._openEditModal({ agentId, currentMeta: card._meta, card }),
					);
			}
			const redeployBtn = card.querySelector('[data-role="redeploy"]');
			if (redeployBtn)
				redeployBtn.addEventListener('click', () =>
					this._openRedeployModal({ agentId, currentMeta: card._meta }),
				);
			const transferBtn = card.querySelector('[data-role="transfer"]');
			if (transferBtn)
				transferBtn.addEventListener('click', () =>
					this._openTransferModal({ agentId, card }),
				);
			const linkBtn = card.querySelector('[data-role="link"]');
			if (linkBtn)
				linkBtn.addEventListener('click', async () => {
					linkBtn.disabled = true;
					linkBtn.textContent = 'Linking…';
					try {
						await this._linkAgentToAccount({
							agentId: Number(agentId),
							chainId: this.selectedChainId,
							throwOnError: true,
						});
						linkBtn.textContent = 'Linked ✓';
						this._toast('Agent linked to your account');
					} catch (err) {
						linkBtn.disabled = false;
						linkBtn.textContent = 'Link to my account 🔗';
						this._toast(`Link failed: ${err.message}`, true);
					}
				});
		} catch (err) {
			card.innerHTML = `<div class="erc8004-log-error">Agent #${agentId}: ${esc(err.message)}</div>`;
		}
	}

	_openQRModal({ agentId, url }) {
		const chainName = CHAIN_META[this.selectedChainId]?.name || '?';
		const modal = document.createElement('div');
		modal.className = 'erc8004-modal';
		modal.innerHTML = `
			<div class="erc8004-modal-card">
				<div class="erc8004-modal-head">
					<div class="erc8004-h4" style="margin:0">Agent QR Code</div>
					<button class="erc8004-btn erc8004-btn--x" data-role="close" title="Close">✕</button>
				</div>
				<p class="erc8004-muted erc8004-small">Agent #${String(agentId)} on ${esc(chainName)}</p>
				<div class="erc8004-qr-canvas-wrap" data-role="canvas"></div>
				<p class="erc8004-muted erc8004-small erc8004-qr-url">${esc(url)}</p>
				<div class="erc8004-row" style="justify-content:center">
					<button class="erc8004-btn erc8004-btn--primary btn btn--primary" data-role="download">Download PNG</button>
					<button class="erc8004-btn btn btn--secondary" data-role="copy">Copy Link</button>
				</div>
			</div>
		`;
		this.el.appendChild(modal);

		let canvas;
		try {
			canvas = renderQRToCanvas(url, { scale: 6, margin: 2 });
			modal.querySelector('[data-role="canvas"]').appendChild(canvas);
		} catch (err) {
			modal.querySelector('[data-role="canvas"]').innerHTML =
				`<div class="erc8004-log-error">QR error: ${esc(err.message)}</div>`;
		}

		const close = () => modal.remove();
		modal.addEventListener('click', (e) => {
			if (e.target === modal) close();
		});
		modal.querySelector('[data-role="close"]').addEventListener('click', close);
		modal.querySelector('[data-role="download"]').addEventListener('click', () => {
			if (!canvas) return;
			const a = document.createElement('a');
			a.href = canvas.toDataURL('image/png');
			a.download = `agent-${String(agentId)}-qr.png`;
			a.click();
		});
		modal.querySelector('[data-role="copy"]').addEventListener('click', async () => {
			try {
				await navigator.clipboard.writeText(url);
				this._toast('Link copied!');
			} catch {
				this._toast('Copy failed', true);
			}
		});
	}

	/**
	 * Embed-snippet modal. Gives the owner four ready-to-paste surfaces for
	 * their on-chain agent: a web-component tag, a plain iframe, a share URL,
	 * and the oEmbed discovery URL. Any page that discovers this agent can
	 * render it the same way — chain is the source of truth.
	 */
	async _openEmbedModal({ agentId, name, glbUrl }) {
		const chainId = this.selectedChainId;
		const origin = location.origin;
		const pageUrl = `${origin}/a/${chainId}/${agentId}`;
		const embedUrl = `${origin}/a/${chainId}/${agentId}/embed`;
		const oembedUrl = `${origin}/api/oembed?url=${encodeURIComponent(pageUrl)}`;
		const cdnBase = `${origin}/agent-3d/latest/agent-3d.js`;

		const integrity = await fetchAgentIntegrity();
		const scriptTag = integrity
			? `<script type="module"\n  src="${cdnBase}"\n  integrity="${integrity}"\n  crossorigin="anonymous"></script>`
			: `<script type="module" src="${cdnBase}"></script>`;

		const snippetWC =
			`${scriptTag}\n` +
			`<agent-3d chain-id="${chainId}" agent-id="${agentId}" style="width:420px;height:520px"></agent-3d>`;
		const snippetIframe =
			`<iframe src="${embedUrl}" width="420" height="520" ` +
			`style="border:0;border-radius:12px" ` +
			`allow="autoplay; xr-spatial-tracking" ` +
			`sandbox="allow-scripts allow-same-origin allow-popups"></iframe>`;

		const modal = document.createElement('div');
		modal.className = 'erc8004-modal';
		modal.innerHTML = `
			<div class="erc8004-modal-card" style="max-width:640px">
				<div class="erc8004-modal-head">
					<div class="erc8004-h4" style="margin:0">Embed ${esc(name || 'agent')}</div>
					<button class="erc8004-btn erc8004-btn--x" data-role="close" title="Close">✕</button>
				</div>
				<p class="erc8004-muted erc8004-small">
					Any surface can render this agent from chain data alone — no backend account needed.
					${glbUrl ? '' : '<br><b>Note:</b> this agent has no 3D body registered yet. Add one via Edit on-chain.'}
				</p>
				<div class="erc8004-embed-tabs" role="tablist">
					<button type="button" data-tab="wc" class="erc8004-tab is-active">Web component</button>
					<button type="button" data-tab="if" class="erc8004-tab">iframe</button>
					<button type="button" data-tab="sh" class="erc8004-tab">Share URL</button>
					<button type="button" data-tab="oe" class="erc8004-tab">oEmbed</button>
				</div>
				<div class="erc8004-embed-panels">
					<div data-panel="wc" class="is-active">
						<p class="erc8004-muted erc8004-small">Drop into any HTML page. Self-contained, no build step.</p>
						<textarea class="erc8004-code" data-role="code-wc" readonly rows="4">${esc(snippetWC)}</textarea>
						<button class="erc8004-btn erc8004-btn--primary btn btn--primary" data-copy="wc">Copy</button>
					</div>
					<div data-panel="if" hidden>
						<p class="erc8004-muted erc8004-small">Works everywhere iframes do — Notion, Ghost, WordPress, Substack.</p>
						<textarea class="erc8004-code" data-role="code-if" readonly rows="4">${esc(snippetIframe)}</textarea>
						<button class="erc8004-btn erc8004-btn--primary btn btn--primary" data-copy="if">Copy</button>
					</div>
					<div data-panel="sh" hidden>
						<p class="erc8004-muted erc8004-small">Paste anywhere (Discord, Slack, X, Farcaster) — OG preview + Twitter Player Card auto-render.</p>
						<textarea class="erc8004-code" data-role="code-sh" readonly rows="2">${esc(pageUrl)}</textarea>
						<button class="erc8004-btn erc8004-btn--primary btn btn--primary" data-copy="sh">Copy</button>
					</div>
					<div data-panel="oe" hidden>
						<p class="erc8004-muted erc8004-small">For apps that consume <a href="https://oembed.com" target="_blank" rel="noopener">oEmbed</a> directly (Notion, some CMSes).</p>
						<textarea class="erc8004-code" data-role="code-oe" readonly rows="2">${esc(oembedUrl)}</textarea>
						<button class="erc8004-btn erc8004-btn--primary btn btn--primary" data-copy="oe">Copy</button>
					</div>
				</div>
				<details class="erc8004-embed-policy">
					<summary>Restrict where this agent can be embedded</summary>
					<p class="erc8004-muted erc8004-small">
						Add <code>embedPolicy</code> to your registration JSON (via Edit on-chain):
					</p>
					<pre class="erc8004-code" style="user-select:text">{
  "embedPolicy": {
    "mode": "allowlist",
    "hosts": ["example.com", "*.mysite.xyz"]
  }
}</pre>
					<p class="erc8004-muted erc8004-small">
						Chain is the source of truth — policy is enforced by every embed surface.
					</p>
				</details>
			</div>
		`;
		this.el.appendChild(modal);

		const close = () => modal.remove();
		modal.addEventListener('click', (e) => {
			if (e.target === modal) close();
		});
		modal.querySelector('[data-role="close"]').addEventListener('click', close);

		modal.querySelectorAll('.erc8004-tab').forEach((tab) => {
			tab.addEventListener('click', () => {
				const id = tab.getAttribute('data-tab');
				modal
					.querySelectorAll('.erc8004-tab')
					.forEach((t) => t.classList.toggle('is-active', t === tab));
				modal.querySelectorAll('[data-panel]').forEach((p) => {
					const match = p.getAttribute('data-panel') === id;
					p.hidden = !match;
					p.classList.toggle('is-active', match);
				});
			});
		});

		modal.querySelectorAll('[data-copy]').forEach((btn) => {
			btn.addEventListener('click', async () => {
				const which = btn.getAttribute('data-copy');
				const ta = modal.querySelector(`[data-role="code-${which}"]`);
				if (!ta) return;
				try {
					await navigator.clipboard.writeText(ta.value);
					const prev = btn.textContent;
					btn.textContent = 'Copied ✓';
					setTimeout(() => (btn.textContent = prev), 1400);
				} catch {
					ta.select();
					document.execCommand('copy');
					this._toast('Copied');
				}
			});
		});
	}

	/**
	 * Edit modal for an existing on-chain agent. Lets the owner update
	 * name / description / 2D image / 3D body, then pins a new registration
	 * JSON and calls setAgentURI(agentId, newURI). Preserves unrelated
	 * fields from the current metadata (services, registrations, trust, etc.).
	 */
	_openEditModal({ agentId, currentMeta, card }) {
		const meta = currentMeta || {};
		const modal = document.createElement('div');
		modal.className = 'erc8004-modal';
		modal.innerHTML = `
			<div class="erc8004-modal-card">
				<div class="erc8004-modal-head">
					<div class="erc8004-h4" style="margin:0">Edit Agent #${String(agentId)}</div>
					<button class="erc8004-btn erc8004-btn--x" data-role="close" title="Close">✕</button>
				</div>
				<p class="erc8004-muted erc8004-small">Updates are written on-chain via <code>setAgentURI()</code>. Re-pins the registration JSON and points <code>agentURI</code> at the new CID.</p>

				<label class="erc8004-label">Name
					<input class="erc8004-input" name="name" value="${esc(meta.name || '')}" />
				</label>
				<label class="erc8004-label">Description
					<textarea class="erc8004-input" name="description" rows="3">${esc(meta.description || '')}</textarea>
				</label>
				<label class="erc8004-label">Image URL (2D — for marketplaces)
					<input class="erc8004-input" name="imageUrl" value="${esc(meta.image || '')}" placeholder="https://… or ipfs://…" />
				</label>
				<label class="erc8004-label">3D Avatar (GLB) — optional, replaces existing body
					<input type="file" accept=".glb,.gltf" class="erc8004-file-input" name="glb" />
				</label>
				${
					currentMeta?.body?.uri ||
					(currentMeta?.services || []).some((s) => s?.name === 'avatar')
						? `<label class="erc8004-checkbox">
								<input type="checkbox" name="removeAvatar" />
								Remove 3D avatar from this agent (clears body + avatar service)
							</label>`
						: ''
				}
				<label class="erc8004-checkbox">
					<input type="checkbox" name="x402Support" ${currentMeta?.x402Support || currentMeta?.x402 ? 'checked' : ''} />
					Accept x402 payments (HTTP-native micropayments)
				</label>
				<label class="erc8004-label">Pinata JWT (optional)
					<input class="erc8004-input" name="apiToken" placeholder="leave blank for R2 backend" />
				</label>

				<div class="erc8004-log" data-role="log"></div>

				<div class="erc8004-row" style="justify-content:flex-end">
					<button class="erc8004-btn btn btn--secondary" data-role="cancel">Cancel</button>
					<button class="erc8004-btn erc8004-btn--primary btn btn--primary" data-role="save">Save on-chain</button>
				</div>
			</div>
		`;
		this.el.appendChild(modal);

		const close = () => modal.remove();
		modal.addEventListener('click', (e) => {
			if (e.target === modal) close();
		});
		modal.querySelector('[data-role="close"]').addEventListener('click', close);
		modal.querySelector('[data-role="cancel"]').addEventListener('click', close);

		modal.querySelector('[data-role="save"]').addEventListener('click', async () => {
			const saveBtn = modal.querySelector('[data-role="save"]');
			const log = modal.querySelector('[data-role="log"]');
			const say = (msg, err = false) => {
				const line = document.createElement('div');
				line.className = 'erc8004-log-line' + (err ? ' erc8004-log-error' : '');
				line.textContent = msg;
				log.appendChild(line);
				log.scrollTop = log.scrollHeight;
			};
			saveBtn.disabled = true;
			try {
				const name = modal.querySelector('[name="name"]').value.trim();
				const description = modal.querySelector('[name="description"]').value.trim();
				const imageUrlInput = modal.querySelector('[name="imageUrl"]').value.trim();
				const apiToken = modal.querySelector('[name="apiToken"]').value.trim() || undefined;
				const fileInput = modal.querySelector('[name="glb"]');
				const glbFile = fileInput.files?.[0] || null;
				const removeAvatar = !!modal.querySelector('[name="removeAvatar"]')?.checked;
				const x402Support = !!modal.querySelector('[name="x402Support"]')?.checked;

				await this._doUpdateAgent({
					agentId,
					name,
					description,
					imageUrl: imageUrlInput,
					glbFile,
					removeAvatar,
					x402Support,
					apiToken,
					currentMeta: meta,
					say,
				});

				this._toast('Agent updated on-chain');
				close();
				if (card) this._fillAgentCard(card, agentId, { withQR: true, withEdit: true });
			} catch (err) {
				say('Update failed: ' + (err.shortMessage || err.message || String(err)), true);
				saveBtn.disabled = false;
			}
		});
	}

	/**
	 * Build + pin a new registration JSON and call setAgentURI on-chain.
	 * Preserves `services`, `registrations`, `supportedTrust`, `x402Support`
	 * from the existing metadata; only touches the fields the user edited.
	 */
	async _doUpdateAgent({
		agentId,
		name,
		description,
		imageUrl,
		glbFile,
		removeAvatar = false,
		x402Support,
		apiToken,
		currentMeta,
		say,
	}) {
		// Find the current GLB URL from the metadata (it lives in services[name=avatar]
		// or the top-level body field — check both).
		const existingGlbUrl =
			currentMeta?.body?.uri ||
			(currentMeta?.services || []).find((s) => s?.name === 'avatar' && s?.endpoint)
				?.endpoint;

		let glbUrl = removeAvatar ? undefined : existingGlbUrl || undefined;
		let newImageUrl = imageUrl;

		if (removeAvatar) {
			say('Avatar will be removed from this agent.');
		}

		// If user uploaded a new GLB, pin it and re-render thumbnail when image is empty.
		// Uploading a new GLB overrides a `removeAvatar` checkbox — user likely meant to
		// replace rather than delete.
		if (glbFile) {
			say('Uploading new 3D model…');
			glbUrl = await pinFile(glbFile, apiToken);
			say(`Model uploaded: ${glbUrl}`);
			if (!newImageUrl) {
				try {
					say('Rendering 2D thumbnail from new GLB…');
					const thumb = await glbFileToThumbnail(glbFile);
					newImageUrl = await pinFile(thumb, apiToken);
					say(`Thumbnail uploaded: ${newImageUrl}`);
				} catch (err) {
					say(`Thumbnail render failed (${err.message}) — keeping existing image.`);
					newImageUrl = currentMeta?.image || '';
				}
			}
		}

		// Preserve non-avatar services (user-added A2A/MCP/etc.) and other fields.
		const preservedServices = (currentMeta?.services || []).filter(
			(s) => s?.name !== 'avatar' && s?.name !== '3D',
		);

		say('Connecting wallet…');
		const { signer, chainId } = await connectWallet();
		if (chainId !== this.selectedChainId) {
			throw new Error(
				`Wallet is on chain ${chainId} but this agent lives on ${this.selectedChainId} (${CHAIN_META[this.selectedChainId]?.name || 'unknown'}). Switch chains in your wallet and try again.`,
			);
		}
		const registry = getIdentityRegistry(chainId, signer);
		const registryAddr = REGISTRY_DEPLOYMENTS[chainId].identityRegistry;

		const registrationJSON = buildRegistrationJSON({
			name,
			description,
			imageUrl: newImageUrl || '',
			glbUrl,
			agentId,
			chainId,
			registryAddr,
			services: preservedServices,
			x402Support:
				typeof x402Support === 'boolean'
					? x402Support
					: !!(currentMeta?.x402Support || currentMeta?.x402),
		});

		say('Uploading new registration metadata…');
		const jsonBlob = new Blob([JSON.stringify(registrationJSON, null, 2)], {
			type: 'application/json',
		});
		const newUri = await pinFile(jsonBlob, apiToken);
		say(`New metadata: ${newUri}`);

		say('Calling setAgentURI on-chain…');
		const tx = await registry.setAgentURI(agentId, newUri);
		say(`Transaction submitted: ${tx.hash}`);
		await tx.wait();
		say('Agent URI updated ✓');
	}

	// -----------------------------------------------------------------------
	// Transfer ownership — ERC-721 safeTransferFrom
	// -----------------------------------------------------------------------

	_openTransferModal({ agentId, card }) {
		const modal = document.createElement('div');
		modal.className = 'erc8004-modal';
		modal.innerHTML = `
			<div class="erc8004-modal-card">
				<div class="erc8004-modal-head">
					<div class="erc8004-h4" style="margin:0">Transfer Agent #${String(agentId)}</div>
					<button class="erc8004-btn erc8004-btn--x" data-role="close" title="Close">✕</button>
				</div>
				<p class="erc8004-muted erc8004-small">Transfers the agent NFT to a new owner on <b>${esc(CHAIN_META[this.selectedChainId]?.name || '?')}</b>. The new owner gains full control — they can update the URI, transfer it again, or burn it.</p>
				<label class="erc8004-label">Recipient address
					<input class="erc8004-input" name="to" placeholder="0x…" />
				</label>
				<div class="erc8004-log" data-role="log"></div>
				<div class="erc8004-row" style="justify-content:flex-end">
					<button class="erc8004-btn btn btn--secondary" data-role="cancel">Cancel</button>
					<button class="erc8004-btn erc8004-btn--primary btn btn--primary" data-role="go">Transfer</button>
				</div>
			</div>
		`;
		this.el.appendChild(modal);
		const close = () => modal.remove();
		modal.addEventListener('click', (e) => {
			if (e.target === modal) close();
		});
		modal.querySelector('[data-role="close"]').addEventListener('click', close);
		modal.querySelector('[data-role="cancel"]').addEventListener('click', close);

		modal.querySelector('[data-role="go"]').addEventListener('click', async () => {
			const btn = modal.querySelector('[data-role="go"]');
			const log = modal.querySelector('[data-role="log"]');
			const say = (msg, err = false) => {
				const line = document.createElement('div');
				line.className = 'erc8004-log-line' + (err ? ' erc8004-log-error' : '');
				line.textContent = msg;
				log.appendChild(line);
			};
			const to = modal.querySelector('[name="to"]').value.trim();
			if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
				say('Invalid recipient address.', true);
				return;
			}
			btn.disabled = true;
			try {
				say('Connecting wallet…');
				const { signer, address } = await connectWallet();
				const registry = getIdentityRegistry(this.selectedChainId, signer);
				say('Submitting safeTransferFrom…');
				const tx = await registry['safeTransferFrom(address,address,uint256)'](
					address,
					to,
					agentId,
				);
				say(`Transaction: ${tx.hash}`);
				await tx.wait();
				say('Transfer complete ✓');
				this._toast('Agent transferred');
				close();
				if (card) this._fillAgentCard(card, agentId, { withQR: true, withEdit: true });
			} catch (err) {
				say('Transfer failed: ' + (err.shortMessage || err.message || String(err)), true);
				btn.disabled = false;
			}
		});
	}

	// -----------------------------------------------------------------------
	// Deploy on another chain — re-mint using the current agent's metadata
	// -----------------------------------------------------------------------

	_openRedeployModal({ agentId, currentMeta }) {
		const meta = currentMeta || {};
		const chainOptions = supportedChainIds()
			.filter((id) => id !== this.selectedChainId)
			.map(
				(id) =>
					`<option value="${id}">${esc(CHAIN_META[id]?.name || id)} ${CHAIN_META[id]?.testnet ? '(testnet)' : ''}</option>`,
			)
			.join('');

		const modal = document.createElement('div');
		modal.className = 'erc8004-modal';
		modal.innerHTML = `
			<div class="erc8004-modal-card">
				<div class="erc8004-modal-head">
					<div class="erc8004-h4" style="margin:0">Deploy #${String(agentId)} on another chain</div>
					<button class="erc8004-btn erc8004-btn--x" data-role="close" title="Close">✕</button>
				</div>
				<p class="erc8004-muted erc8004-small">Mints a new agent on the selected chain reusing this agent's name, description, image, and 3D body. The new agent gets its own on-chain ID — nothing about the original changes.</p>
				<label class="erc8004-label">Target chain
					<select class="erc8004-input" name="chain">${chainOptions}</select>
				</label>
				<label class="erc8004-label">Pinata JWT (optional)
					<input class="erc8004-input" name="apiToken" placeholder="leave blank for R2 backend" />
				</label>
				<div class="erc8004-log" data-role="log"></div>
				<div class="erc8004-row" style="justify-content:flex-end">
					<button class="erc8004-btn btn btn--secondary" data-role="cancel">Cancel</button>
					<button class="erc8004-btn erc8004-btn--primary btn btn--primary" data-role="go">Deploy</button>
				</div>
			</div>
		`;
		this.el.appendChild(modal);
		const close = () => modal.remove();
		modal.addEventListener('click', (e) => {
			if (e.target === modal) close();
		});
		modal.querySelector('[data-role="close"]').addEventListener('click', close);
		modal.querySelector('[data-role="cancel"]').addEventListener('click', close);

		modal.querySelector('[data-role="go"]').addEventListener('click', async () => {
			const btn = modal.querySelector('[data-role="go"]');
			const log = modal.querySelector('[data-role="log"]');
			const say = (msg, err = false) => {
				const line = document.createElement('div');
				line.className = 'erc8004-log-line' + (err ? ' erc8004-log-error' : '');
				line.textContent = msg;
				log.appendChild(line);
			};
			const targetChainId = Number(modal.querySelector('[name="chain"]').value);
			const apiToken = modal.querySelector('[name="apiToken"]').value.trim() || undefined;
			btn.disabled = true;
			try {
				say(`Switching wallet to ${CHAIN_META[targetChainId]?.name || targetChainId}…`);
				await switchChain(targetChainId);
				const existingGlb = (meta.services || []).find(
					(s) => s?.name === 'avatar' && s?.endpoint,
				)?.endpoint;
				let glbFile = null;
				if (existingGlb) {
					glbFile = await this._fetchUrlAsFile(
						existingGlb.startsWith('ipfs://')
							? 'https://ipfs.io/ipfs/' + existingGlb.slice(7)
							: existingGlb,
						say,
						'3D body',
					);
				}
				const preservedServices = (meta.services || []).filter(
					(s) => s?.name !== 'avatar' && s?.name !== '3D',
				);
				say('Registering on new chain…');
				const result = await registerAgent({
					glbFile,
					name: meta.name || `Agent #${agentId}`,
					description: meta.description || '',
					imageUrl: meta.image || '',
					apiToken,
					services: preservedServices,
					x402Support: !!(meta.x402Support || meta.x402),
					onStatus: (m) => say(m),
				});
				say(`Deployed! New agentId = ${result.agentId} on chain ${targetChainId}`);
				this._toast(`Deployed as #${result.agentId} on ${CHAIN_META[targetChainId]?.name}`);
				close();
			} catch (err) {
				say('Deploy failed: ' + (err.shortMessage || err.message || String(err)), true);
				btn.disabled = false;
			}
		});
	}

	// -----------------------------------------------------------------------
	// Tab: Search
	// -----------------------------------------------------------------------

	_renderSearch(body) {
		if (_isSolana(this.selectedChainId)) {
			body.innerHTML = `
				<h3 class="erc8004-h3">Agent Search</h3>
				<p class="erc8004-p erc8004-muted">On-chain search isn't supported for Solana from this tab yet.</p>
			`;
			return;
		}
		if (!this._searchFilter) this._searchFilter = 'all';
		const chainName = esc(CHAIN_META[this.selectedChainId]?.name);
		body.innerHTML = `
			<h3 class="erc8004-h3">Agent Search</h3>
			<p class="erc8004-p">
				Look up agents on <b>${chainName}</b> by ID, wallet address, ENS name, tx hash, or <code>agent://</code> URI.
				Need cross-chain? <a class="erc8004-link" href="/discover" target="_blank" rel="noopener">Open /discover ↗</a>.
			</p>
			<div class="erc8004-row">
				<input class="erc8004-input" name="q" placeholder="Agent ID · 0x address · ENS · tx hash · agent://chain/id" />
				<button class="erc8004-btn erc8004-btn--primary btn btn--primary" data-role="go">Search</button>
			</div>
			<div class="erc8004-filter-chips" data-role="chips">
				<button class="erc8004-chip ${this._searchFilter === 'all' ? 'erc8004-chip--active' : ''}" data-filter="all">All</button>
				<button class="erc8004-chip ${this._searchFilter === 'A2A' ? 'erc8004-chip--active' : ''}" data-filter="A2A">A2A</button>
				<button class="erc8004-chip ${this._searchFilter === 'MCP' ? 'erc8004-chip--active' : ''}" data-filter="MCP">MCP</button>
				<button class="erc8004-chip ${this._searchFilter === 'OASF' ? 'erc8004-chip--active' : ''}" data-filter="OASF">OASF</button>
				<button class="erc8004-chip ${this._searchFilter === 'x402' ? 'erc8004-chip--active' : ''}" data-filter="x402">x402 💳</button>
			</div>
			<div data-role="result" style="margin-top:14px"></div>
		`;
		const q = body.querySelector('[name="q"]');
		const out = body.querySelector('[data-role="result"]');

		body.querySelectorAll('[data-role="chips"] .erc8004-chip').forEach((chip) => {
			chip.addEventListener('click', () => {
				this._searchFilter = chip.dataset.filter;
				body.querySelectorAll('[data-role="chips"] .erc8004-chip').forEach((c) => {
					c.classList.toggle(
						'erc8004-chip--active',
						c.dataset.filter === this._searchFilter,
					);
				});
				this._applySearchFilter(out);
			});
		});

		const go = async () => {
			const raw = q.value.trim();
			if (!raw) return;
			const type = detectInputType(raw);
			out.innerHTML = `<div class="erc8004-muted">Resolving…</div>`;

			try {
				let agentIds = [];
				if (type === INPUT_TYPES.AGENT_ID) {
					agentIds = [BigInt(raw)];
				} else if (type === INPUT_TYPES.AGENT_URI) {
					const match = raw.match(/^agent:\/\/([^/]+)\/(\d+)$/i);
					if (!match) throw new Error('Malformed agent:// URI');
					const aliases = {
						base: 8453,
						'base-sepolia': 84532,
						ethereum: 1,
						mainnet: 1,
						optimism: 10,
						arbitrum: 42161,
						polygon: 137,
						bsc: 56,
					};
					const uriChain = aliases[match[1].toLowerCase()] || Number(match[1]);
					if (uriChain !== this.selectedChainId) {
						out.innerHTML = `<div class="erc8004-log-error">
							This agent is on <b>${esc(CHAIN_META[uriChain]?.name || `Chain ${uriChain}`)}</b>, not the selected chain.
							<a class="erc8004-link" href="/discover?q=${encodeURIComponent(raw)}" target="_blank" rel="noopener">Open in /discover ↗</a>
						</div>`;
						return;
					}
					agentIds = [BigInt(match[2])];
				} else if (type === INPUT_TYPES.ADDRESS) {
					const results = await resolveByAddress({
						address: raw,
						chainIds: [this.selectedChainId],
						ethProvider: window.ethereum,
					});
					agentIds = results.map((r) => BigInt(r.agentId));
				} else if (type === INPUT_TYPES.ENS) {
					const addr = await resolveENSAddress(raw);
					const results = await resolveByAddress({
						address: addr,
						chainIds: [this.selectedChainId],
						ethProvider: window.ethereum,
					});
					agentIds = results.map((r) => BigInt(r.agentId));
				} else if (type === INPUT_TYPES.TX_HASH) {
					const results = await resolveByTxHash({
						txHash: raw,
						chainId: this.selectedChainId,
						ethProvider: window.ethereum,
					});
					agentIds = results.map((r) => BigInt(r.agentId));
				} else {
					out.innerHTML = `<div class="erc8004-log-error">Unrecognized input. Try an agent ID, 0x address, ENS name, tx hash, or agent:// URI.</div>`;
					return;
				}

				if (!agentIds.length) {
					out.innerHTML = `
						<div class="erc8004-muted">
							No agents resolved on ${chainName} for <code>${esc(raw)}</code>.
							<a class="erc8004-link" href="/discover?q=${encodeURIComponent(raw)}" target="_blank" rel="noopener">Try across all chains ↗</a>
						</div>
					`;
					return;
				}

				out.innerHTML = '';
				for (const id of agentIds) {
					const card = document.createElement('div');
					card.className = 'erc8004-agent-card';
					card.innerHTML = `<div class="erc8004-muted">Loading #${id}…</div>`;
					out.appendChild(card);
					this._fillAgentCard(card, id, { withQR: true, withEdit: true });
				}
				this._applySearchFilter(out);
			} catch (err) {
				out.innerHTML = `<div class="erc8004-log-error">${esc(err.message)}</div>`;
			}
		};
		body.querySelector('[data-role="go"]').addEventListener('click', go);
		q.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') go();
		});
	}

	_applySearchFilter(out) {
		const filter = this._searchFilter || 'all';
		out.querySelectorAll('.erc8004-agent-card').forEach((card) => {
			if (filter === 'all') {
				card.style.display = '';
				return;
			}
			const meta = card._meta;
			if (!meta) {
				card.style.display = '';
				return;
			}
			const services = Array.isArray(meta.services) ? meta.services : [];
			const types = services.map((s) => String(s.type || s.name || '').toUpperCase());
			const hasX402 = !!meta.x402Support || !!meta.x402;
			let match = false;
			if (filter === 'x402') match = hasX402;
			else match = types.includes(filter.toUpperCase());
			card.style.display = match ? '' : 'none';
		});
	}

	// -----------------------------------------------------------------------
	// Tab: Templates
	// -----------------------------------------------------------------------

	_renderTemplates(body) {
		body.innerHTML = `
			<h3 class="erc8004-h3">Agent Templates</h3>
			<p class="erc8004-p">Pre-built configurations — one click to prefill the Create Agent wizard.</p>
			<div class="erc8004-template-grid">
				${TEMPLATES.map(
					(t) => `
					<button class="erc8004-template" data-id="${t.id}">
						<div class="erc8004-template-emoji">${t.emoji}</div>
						<div class="erc8004-template-name">${esc(t.name)}</div>
						<div class="erc8004-template-desc">${esc(t.description)}</div>
					</button>
				`,
				).join('')}
			</div>
		`;
		body.querySelectorAll('.erc8004-template').forEach((btn) => {
			btn.addEventListener('click', () => {
				const t = TEMPLATES.find((x) => x.id === btn.dataset.id);
				if (!t) return;
				this.form.name = t.name;
				this.form.description = t.description;
				if (Array.isArray(t.services)) {
					this.form.services = t.services.map((s) => ({ ...s }));
				}
				this.form.x402Support = !!t.x402Support;
				this.wizardStep = 1;
				this._setTab('create');
			});
		});
	}

	// -----------------------------------------------------------------------
	// Tab: History
	// -----------------------------------------------------------------------

	_renderHistory(body) {
		if (_isSolana(this.selectedChainId)) {
			body.innerHTML = `
				<h3 class="erc8004-h3">Transaction History</h3>
				<p class="erc8004-p erc8004-muted">Solana history isn't surfaced here yet — check
				<a class="erc8004-link" href="https://solscan.io" target="_blank" rel="noopener">solscan.io</a>
				for your wallet's mints.</p>
			`;
			return;
		}
		body.innerHTML = `
			<h3 class="erc8004-h3">Transaction History</h3>
			<p class="erc8004-p">Recent <code>Registered</code> events on <b>${esc(CHAIN_META[this.selectedChainId]?.name)}</b>${this.wallet ? ` for <code>${esc(this.wallet.address)}</code>` : ''}.</p>
			<div data-role="list"></div>
		`;
		const list = body.querySelector('[data-role="list"]');
		list.innerHTML = `<div class="erc8004-muted">Loading…</div>`;

		listRegisteredEvents({
			chainId: this.selectedChainId,
			owner: this.wallet?.address,
			ethProvider: window.ethereum,
			limit: 50,
		})
			.then((events) => {
				if (events.length === 0) {
					list.innerHTML = `<div class="erc8004-muted">No events in the scanned window.</div>`;
					return;
				}
				list.innerHTML = events
					.map(
						(ev) => `
				<div class="erc8004-history-row">
					<div class="erc8004-history-main">
						<div><strong>Agent #${ev.agentId}</strong> <span class="erc8004-muted">by ${esc(shortAddr(ev.owner))}</span></div>
						<div class="erc8004-muted erc8004-small">Block ${ev.blockNumber} · <code>${esc(ev.agentURI).slice(0, 60)}${ev.agentURI.length > 60 ? '…' : ''}</code></div>
					</div>
					<a class="erc8004-link" href="${esc(txExplorerUrl(this.selectedChainId, ev.txHash))}" target="_blank" rel="noopener">tx ↗</a>
				</div>
			`,
					)
					.join('');
			})
			.catch((err) => {
				list.innerHTML = `<div class="erc8004-log-error">Failed to load: ${esc(err.message)}</div>`;
			});
	}

	// -----------------------------------------------------------------------
	// Toast
	// -----------------------------------------------------------------------

	_toast(msg, isError = false) {
		const t = document.createElement('div');
		t.className = 'erc8004-toast' + (isError ? ' erc8004-toast--error' : '');
		t.textContent = msg;
		this.el.appendChild(t);
		setTimeout(() => t.remove(), 4000);
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function resolveGateway(uri) {
	if (!uri) return '';
	if (uri.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + uri.slice(7);
	if (uri.startsWith('ar://')) return 'https://arweave.net/' + uri.slice(5);
	return uri;
}
