/**
 * Public user profile page — /u/:address
 *
 * Shows all ERC-8004 agents registered by a given Ethereum address across
 * all supported chains. Uses existing query layer (listAgentsByOwner,
 * fetchAgentMetadata, findAvatar3D) — no new backend needed.
 */

import { Contract } from 'ethers';
import { IDENTITY_REGISTRY_ABI, REGISTRY_DEPLOYMENTS } from './abi.js';
import { listAgentsByOwner, fetchAgentMetadata, findAvatar3D } from './queries.js';
import { CHAIN_META, supportedChainIds, readProvider } from './chain-meta.js';
import { resolveURI } from '../ipfs.js';
import { walletChipHTML, wireWalletChips } from '../shared/agent-wallet-chip.js';

const SOLANA_BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Pull a Solana custodial/mint address out of ERC-8004 agent metadata. Agents
// registered on Solana carry it under registrations[].onchain (family 'solana')
// as `contract_or_mint`, or sometimes a top-level solana_address. Returns a
// base58 address or '' so the wallet chip stays silent for EVM-only agents.
function solanaAddressFromMetadata(data) {
	if (!data || typeof data !== 'object') return '';
	const direct = data.solana_address || data.solanaAddress;
	if (typeof direct === 'string' && SOLANA_BASE58_RE.test(direct)) return direct;
	const regs = Array.isArray(data.registrations) ? data.registrations : [];
	for (const reg of regs) {
		const oc = reg?.onchain || reg || {};
		const fam = String(oc.family || reg?.family || '').toLowerCase();
		const candidate = oc.contract_or_mint || oc.address || oc.mint;
		if (fam === 'solana' && typeof candidate === 'string' && SOLANA_BASE58_RE.test(candidate)) {
			return candidate;
		}
	}
	return '';
}

const esc = (s) =>
	String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);

const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

/**
 * Mount the user profile into `rootEl`.
 * @param {HTMLElement} rootEl
 * @param {string} address  Ethereum address (0x…)
 */
export async function mountUserProfile(rootEl, address) {
	rootEl.innerHTML = renderShell(address);

	const grid = rootEl.querySelector('.up-grid');
	const header = rootEl.querySelector('.up-header-count');
	const chainBar = rootEl.querySelector('.up-chain-bar');

	// Scan all mainnet chains in parallel
	const mainnetChains = supportedChainIds().filter((id) => !CHAIN_META[id]?.testnet);

	let totalAgents = 0;
	let chainsWithAgents = [];

	// Per-chain results accumulate into the grid as they resolve
	const chainResults = await Promise.allSettled(
		mainnetChains.map(async (chainId) => {
			const { ids, count, partial } = await listAgentsByOwner({
				chainId,
				owner: address,
			}).catch(() => ({ ids: [], count: 0, partial: false }));

			if (count === 0) return { chainId, count: 0, cards: [] };

			// Fetch metadata for each agent (cap at 50 per chain to avoid rate limits)
			const toFetch = ids.slice(0, 50);
			const cards = await Promise.all(
				toFetch.map((agentId) => resolveAgentCard({ chainId, agentId, address })),
			);

			return { chainId, count, partial, cards };
		}),
	);

	const allCards = [];
	for (const result of chainResults) {
		if (result.status !== 'fulfilled') continue;
		const { chainId, count, cards } = result.value;
		if (count === 0) continue;
		totalAgents += count;
		chainsWithAgents.push(chainId);
		allCards.push(...cards);
	}

	// Update header count
	if (header) {
		header.textContent =
			totalAgents === 0
				? 'No agents registered yet'
				: `${totalAgents} agent${totalAgents === 1 ? '' : 's'} across ${chainsWithAgents.length} chain${chainsWithAgents.length === 1 ? '' : 's'}`;
	}

	// Render chain filter pills
	if (chainBar && chainsWithAgents.length > 1) {
		chainBar.innerHTML =
			`<button class="up-chain-pill up-chain-pill--active" data-chain="all">All</button>` +
			chainsWithAgents
				.map((id) => {
					const meta = CHAIN_META[id];
					return `<button class="up-chain-pill" data-chain="${id}">${esc(meta?.shortName || id)}</button>`;
				})
				.join('');

		chainBar.addEventListener('click', (e) => {
			const btn = e.target.closest('.up-chain-pill');
			if (!btn) return;
			chainBar.querySelectorAll('.up-chain-pill').forEach((b) => b.classList.remove('up-chain-pill--active'));
			btn.classList.add('up-chain-pill--active');
			const chain = btn.dataset.chain;
			grid.querySelectorAll('.up-card').forEach((card) => {
				card.hidden = chain !== 'all' && card.dataset.chain !== chain;
			});
		});
	} else if (chainBar) {
		chainBar.hidden = true;
	}

	// Render cards
	if (allCards.length === 0) {
		grid.innerHTML = `<p class="up-empty">No agents registered on-chain yet. <a href="/create">Create one →</a></p>`;
		return;
	}

	// Sort: newest agent ID first (higher ID = more recent mint on same chain)
	allCards.sort((a, b) => Number(b.agentId) - Number(a.agentId));

	grid.innerHTML = allCards.map(renderCard).join('');
	wireWalletChips(grid);

	// Lazy-load thumbnails via model-viewer after card DOM is present
	grid.querySelectorAll('.up-card[data-glb]').forEach((card) => {
		const glb = card.dataset.glb;
		if (!glb) return;
		const thumb = card.querySelector('.up-card-thumb');
		if (!thumb) return;
		thumb.innerHTML = `<model-viewer
			src="${esc(glb)}"
			camera-controls
			auto-rotate
			rotation-per-second="15deg"
			exposure="0.9"
			shadow-intensity="0"
			interaction-prompt="none"
			style="width:100%;height:100%;background:transparent"
			loading="lazy"
		></model-viewer>`;
	});
}

async function resolveAgentCard({ chainId, agentId, address }) {
	const base = {
		chainId,
		agentId,
		owner: address,
		name: `Agent #${agentId}`,
		description: '',
		image: '',
		glb: '',
		solanaAddress: '',
	};

	try {
		const meta = CHAIN_META[chainId];
		if (!meta) return base;

		const provider = readProvider(chainId);
		const addr = REGISTRY_DEPLOYMENTS[chainId]?.identityRegistry;
		if (!addr) return base;

		const registry = new Contract(addr, IDENTITY_REGISTRY_ABI, provider);
		const tokenURI = await registry.tokenURI(agentId).catch(() => null);
		if (!tokenURI) return base;

		const { ok, data } = await fetchAgentMetadata(tokenURI);
		if (!ok || !data) return base;

		const rawGlb = findAvatar3D(data);
		const glb = rawGlb ? await resolveURI(rawGlb).catch(() => rawGlb) : '';

		return {
			...base,
			name: data.name || base.name,
			description: data.description || '',
			image: data.image || '',
			glb,
			solanaAddress: solanaAddressFromMetadata(data),
		};
	} catch {
		return base;
	}
}

function renderCard({ chainId, agentId, name, description, image, glb, solanaAddress }) {
	const meta = CHAIN_META[chainId];
	const agentUrl = `/a/${chainId}/${agentId}`;
	// Shared wallet chip when the on-chain agent also has a Solana custodial
	// address. This is a public profile with no reliable viewer-ownership signal,
	// so isOwner:false — visitors get the Tip action, never owner controls.
	// Renders nothing for EVM-only agents (showPending:false).
	const walletChip = walletChipHTML(
		{ id: `${chainId}/${agentId}`, name, solana_address: solanaAddress || '', avatar_thumbnail_url: image || '' },
		{ isOwner: false, showPending: false },
	);
	const hasThumb = !!glb || !!image;
	const thumbContent = glb
		? '' // filled lazily
		: image
			? `<img loading="lazy" decoding="async" src="${esc(image)}" alt="${esc(name)} thumbnail" style="width:100%;height:100%;object-fit:cover">`
			: `<div class="up-card-thumb-placeholder">◎</div>`;

	const editUrl = `/a/${chainId}/${agentId}/edit`;

	return `<article
		class="up-card"
		data-chain="${chainId}"
		${glb ? `data-glb="${esc(glb)}"` : ''}
	>
		<a href="${esc(agentUrl)}" class="up-card-thumb-link" tabindex="-1" aria-hidden="true">
			<div class="up-card-thumb">${thumbContent}</div>
		</a>
		<div class="up-card-body">
			<div class="up-card-chain">${esc(meta?.shortName || chainId)}</div>
			<a href="${esc(agentUrl)}" class="up-card-name">${esc(name)}</a>
			${description ? `<p class="up-card-desc">${esc(description)}</p>` : ''}
			${walletChip ? `<div class="up-card-wallet">${walletChip}</div>` : ''}
			<div class="up-card-footer">
				<span class="up-card-id">#${agentId}</span>
				<a href="${esc(editUrl)}" class="up-card-edit">Edit →</a>
			</div>
		</div>
	</article>`;
}

function renderShell(address) {
	return `
		<div class="up-hero">
			<div class="up-avatar-ring">
				<span class="up-avatar-glyph">◎</span>
			</div>
			<div class="up-hero-info">
				<h1 class="up-address">${esc(shortAddr(address))}</h1>
				<p class="up-header-count up-muted">Loading agents…</p>
				<p class="up-full-address up-muted">${esc(address)}</p>
			</div>
		</div>
		<div class="up-chain-bar"></div>
		<div class="up-grid"></div>
	`;
}
