// GET /api/users/:username/collectibles — a user's on-chain collectibles + wallets.
//
// One lazy endpoint that powers the profile's NFTs, Accessories, and Wallets
// surfaces. It is deliberately split out of /api/users/:username so the main
// profile paints instantly: the NFT lookups here hit billed providers (Helius
// DAS for Solana, Alchemy for EVM) and are slow, so they load after the fold.
//
// Wallets are derived from the user's own custodial address plus every public
// agent's wallet (EVM + Solana). NFTs are aggregated across all Solana/EVM
// wallets, deduped, and capped. Accessories are the premium cosmetics the user's
// wallets have actually purchased over the x402 rail (real ownership, not the
// free base pack).
//
// Cost controls (NFT providers are billed per call):
//   • whole response cached by username (10 min) — repeat profile views are free
//   • the shared Helius DAS global hourly ceiling gates every cache MISS
//   • per-IP rate limit on top
// Public, no auth: the profile it backs is public.

import { sql } from '../../_lib/db.js';
import { cors, json, method, wrap, error, rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { env } from '../../_lib/env.js';
import { cacheGet, cacheSet } from '../../_lib/cache.js';
import { isValidSolanaAddress, isValidEvmAddress } from '../../_lib/validate.js';
import { buildCatalog } from '../../_lib/cosmetics.js';
import { readOwnedCosmetics, normalizeAccountId } from '../../_lib/cosmetics-ownership.js';

const CACHE_TTL_SECONDS = 10 * 60; // 10m — NFT metadata is effectively static
const NFT_CAP = 60; // max NFTs surfaced across all wallets
const MAX_WALLETS_PER_CHAIN = 8; // cap billed upstream calls per request

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['GET'])) return;

	const usernameRaw =
		req.query?.username ||
		new URL(req.url, 'http://x').pathname.split('/').filter(Boolean).slice(-2)[0] ||
		'';
	const username = String(usernameRaw).toLowerCase().replace(/^@/, '').trim();
	if (!username || !/^[a-z0-9_-]{3,30}$/.test(username)) {
		return error(res, 400, 'validation_error', 'invalid username');
	}

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const [user] = await sql`
		select id, wallet_address
		from users
		where lower(username) = ${username} and deleted_at is null
		limit 1
	`;
	if (!user) return error(res, 404, 'not_found', 'user not found');

	// Serve a warm cache without touching any billed provider.
	const cacheKey = `collectibles:${username}`;
	const cached = await cacheGet(cacheKey).catch(() => null);
	if (cached) {
		res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=900');
		return json(res, 200, cached);
	}

	// Gather every wallet tied to this identity: the user's own custodial wallet
	// plus the wallets of their public agents (EVM + Solana).
	const agentWallets = await sql`
		select wallet_address, chain_id,
		       meta->>'solana_address' as solana_address
		from agent_identities
		where user_id = ${user.id}
		  and is_public = true
		  and deleted_at is null
	`;

	const evm = new Map(); // lowercased addr -> { address, chainId, source }
	const sol = new Map(); // addr -> { address, source }

	const addWallet = (addr, source, chainId = null) => {
		if (!addr) return;
		const a = String(addr).trim();
		if (isValidEvmAddress(a)) {
			const key = a.toLowerCase();
			if (!evm.has(key)) evm.set(key, { address: a, chainId: chainId || 1, source });
		} else if (isValidSolanaAddress(a)) {
			if (!sol.has(a)) sol.set(a, { address: a, source });
		}
	};

	addWallet(user.wallet_address, 'user');
	for (const w of agentWallets) {
		addWallet(w.wallet_address, 'agent', w.chain_id);
		addWallet(w.solana_address, 'agent');
	}

	const wallets = [
		...[...sol.values()].map((w) => ({
			chain: 'solana',
			address: w.address,
			source: w.source,
			explorer: `https://solscan.io/account/${w.address}`,
		})),
		...[...evm.values()].map((w) => ({
			chain: 'evm',
			address: w.address,
			chain_id: w.chainId,
			source: w.source,
			explorer: explorerForEvm(w.chainId, w.address),
		})),
	];

	// Accessories: premium cosmetics any of the user's wallets actually own.
	// Pass ORIGINAL-case addresses — cosmetic ownership is keyed on the exact
	// account string the buyer signed with (normalizeAccountId never lowercases),
	// so a lowercased EVM key would miss a checksummed purchase.
	const accessories = await loadAccessories(
		[...sol.values(), ...evm.values()].map((w) => w.address),
	);

	// NFTs across all wallets. Each cache MISS that reaches a billed provider
	// must pass the shared Helius DAS ceiling — a hard cost cap independent of
	// caching (which can't stop enumeration of distinct usernames).
	let nfts = [];
	let nftFetchBlocked = false;
	const solWallets = [...sol.keys()].slice(0, MAX_WALLETS_PER_CHAIN);
	const evmWallets = [...evm.values()].slice(0, MAX_WALLETS_PER_CHAIN);

	if (solWallets.length || evmWallets.length) {
		const ceiling = await limits.heliusDasGlobal();
		if (ceiling.success) {
			const batches = await Promise.all([
				...solWallets.map((w) => fetchSolanaNfts(w).catch(() => [])),
				...evmWallets.map((w) => fetchEvmNfts(w.address, w.chainId).catch(() => [])),
			]);
			// Sort models-first across the WHOLE set before capping, so 3D NFTs are
			// never dropped by the cap in favour of plain images.
			const all = batches.flat().filter(Boolean);
			all.sort((a, b) => (b.model ? 1 : 0) - (a.model ? 1 : 0));
			const seen = new Set();
			for (const item of all) {
				if (seen.has(item.id)) continue;
				seen.add(item.id);
				nfts.push(item);
				if (nfts.length >= NFT_CAP) break;
			}
		} else {
			// Ceiling hit: nfts stays []; the tab shows its empty state. Don't cache
			// this degraded result — a cache write here would pin empty NFTs for the
			// full TTL even after the ceiling resets.
			nftFetchBlocked = true;
		}
	}

	const payload = {
		wallets,
		nfts,
		accessories,
		counts: {
			wallets: wallets.length,
			nfts: nfts.length,
			accessories: accessories.length,
		},
	};

	if (!nftFetchBlocked) await cacheSet(cacheKey, payload, CACHE_TTL_SECONDS).catch(() => {});

	res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=900');
	return json(res, 200, payload);
});

function explorerForEvm(chainId, address) {
	const bases = {
		1: 'https://etherscan.io',
		8453: 'https://basescan.org',
		137: 'https://polygonscan.com',
		10: 'https://optimistic.etherscan.io',
		42161: 'https://arbiscan.io',
	};
	const base = bases[Number(chainId)] || bases[1];
	return `${base}/address/${address}`;
}

// Premium cosmetics the user's wallets purchased over the x402 rail. The free
// base accessory pack is owned by everyone, so it isn't profile-specific — we
// surface only purchased (premium) items here.
async function loadAccessories(accountIds) {
	const owned = new Set();
	for (const raw of accountIds) {
		const account = normalizeAccountId(raw);
		if (!account) continue;
		const ids = await readOwnedCosmetics(account).catch(() => []);
		for (const id of ids) owned.add(id);
	}
	if (!owned.size) return [];
	return buildCatalog({ ownedIds: [...owned] })
		.filter((c) => c.premium && c.owned)
		.map((c) => ({
			id: c.id,
			name: c.name,
			slot: c.slot,
			rarity: c.rarity,
			previewImage: c.previewImage,
			glbUrl: c.glbUrl || null,
		}));
}

// Solana NFTs via Helius DAS getAssetsByOwner. Non-fungible only.
async function fetchSolanaNfts(wallet) {
	const resp = await fetch(env.SOLANA_RPC_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 'collectibles',
			method: 'getAssetsByOwner',
			params: {
				ownerAddress: wallet,
				page: 1,
				limit: NFT_CAP,
				displayOptions: {
					showFungible: false,
					showNativeBalance: false,
					showCollectionMetadata: true,
					showUnverifiedCollections: false,
					showZeroBalance: false,
				},
			},
		}),
	});
	if (!resp.ok) throw new Error(`Helius DAS ${resp.status}`);
	const data = await resp.json();
	if (data.error) throw new Error('Helius DAS rpc error');
	const items = data.result?.items || [];
	return items
		.filter((a) => !a.burnt)
		.map((a) => {
			const image =
				a.content?.links?.image ||
				a.content?.files?.find((f) => f.mime?.startsWith('image/'))?.uri ||
				null;
			const model = a.content?.files?.find((f) => f.mime?.startsWith('model/'))?.uri || null;
			return {
				id: a.id,
				chain: 'solana',
				name: a.content?.metadata?.name || a.id,
				collection:
					a.grouping?.find((g) => g.group_key === 'collection')?.collection_metadata?.name ||
					null,
				image,
				model,
				explorer: `https://solscan.io/token/${a.id}`,
			};
		})
		.filter((n) => n.image || n.model);
}

// EVM NFTs via Alchemy getNFTsForOwner. Skipped silently when ALCHEMY_API_KEY
// is absent (no key → no EVM NFTs, never an error).
async function fetchEvmNfts(wallet, chainId) {
	// env has no ALCHEMY getter — read the raw var. No key ⇒ no EVM NFTs (Solana
	// still works), never an error.
	const apiKey = process.env.ALCHEMY_API_KEY;
	if (!apiKey) return [];
	const hosts = {
		1: 'eth-mainnet',
		8453: 'base-mainnet',
		137: 'polygon-mainnet',
		10: 'opt-mainnet',
		42161: 'arb-mainnet',
	};
	const host = hosts[Number(chainId)] || 'eth-mainnet';
	const url = `https://${host}.g.alchemy.com/nft/v3/${apiKey}/getNFTsForOwner?owner=${encodeURIComponent(wallet)}&withMetadata=true&pageSize=${NFT_CAP}&excludeFilters[]=SPAM`;
	const resp = await fetch(url);
	if (!resp.ok) throw new Error(`Alchemy ${resp.status}`);
	const data = await resp.json();
	const base = explorerForEvm(chainId, '').replace(/\/address\/$/, '');
	return (data.ownedNfts || [])
		.map((n) => {
			const image = n.image?.cachedUrl || n.image?.originalUrl || n.media?.[0]?.gateway || null;
			const anim = n.raw?.metadata?.animation_url || null;
			const model = anim && /\.(glb|gltf)(\?|$)/i.test(anim) ? anim : null;
			const contract = n.contract?.address;
			return {
				id: `${chainId}:${contract}:${n.tokenId}`,
				chain: 'evm',
				name: n.name || n.contract?.name || `#${n.tokenId}`,
				collection: n.collection?.name || n.contract?.name || null,
				image,
				model,
				explorer: contract ? `${base}/nft/${contract}/${n.tokenId}` : null,
			};
		})
		.filter((n) => n.image || n.model);
}
