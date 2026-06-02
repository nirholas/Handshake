// Native (client-composed) tools for the pump.fun MCP bridge.
//
// These don't exist on the backend as single endpoints — they orchestrate
// several backend read tools and add value on top (here: a deep-link into the
// three.ws /coin3d viewer). Keeping them in the bridge means the package is
// useful the moment it's installed, with no backend deploy required, while
// still sourcing every number from the same canonical on-chain reads.

// Derive the public site origin (for viewer links) from the backend URL, so a
// self-hosted backend produces self-hosted viewer links automatically.
function siteBaseFrom(backendUrl) {
	try {
		return new URL(backendUrl).origin;
	} catch {
		return 'https://three.ws';
	}
}

function ipfsToHttp(url) {
	if (typeof url !== 'string') return null;
	if (url.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${url.slice(7)}`;
	return url;
}

// The token logo lives in the off-chain metadata JSON pointed to by the
// on-chain `uri`. Resolve it best-effort: a direct image field wins, otherwise
// fetch the uri JSON and read .image. Returns null rather than guessing.
async function resolveImage(d) {
	const direct = d.image || d.imageUrl || d.metadata?.image;
	if (direct) return ipfsToHttp(direct);
	const uri = d.uri || d.metadata?.uri;
	if (!uri) return null;
	try {
		const res = await fetch(ipfsToHttp(uri), { signal: AbortSignal.timeout(6000) });
		if (!res.ok) return null;
		const meta = await res.json();
		return meta?.image ? ipfsToHttp(meta.image) : null;
	} catch {
		return null;
	}
}

function num(v) {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function pct01(v) {
	const n = num(v);
	if (n === null) return null;
	const p = n > 1 ? n / 100 : n;
	return Math.max(0, Math.min(1, p));
}

// pumpfun_token_3d — assemble a live 3D snapshot of a token and return a
// shareable viewer deep-link plus the underlying data.
async function token3dHandler(args, { call, siteBase }) {
	const mint = String(args?.mint || '').trim();
	if (!mint) {
		const err = new Error('mint is required');
		err.rpcCode = -32602;
		throw err;
	}
	const network = args?.network === 'devnet' ? 'devnet' : 'mainnet';

	const [details, curve, holders] = await Promise.allSettled([
		call('getTokenDetails', { mint }),
		call('getBondingCurve', { mint, network }),
		call('getTokenHolders', { mint, limit: 12, network }),
	]);

	const d = details.status === 'fulfilled' ? details.value || {} : {};
	const c = curve.status === 'fulfilled' ? curve.value || null : null;
	const h = holders.status === 'fulfilled' ? holders.value || null : null;

	if (details.status === 'rejected' && curve.status === 'rejected' && holders.status === 'rejected') {
		const err = new Error(`no on-chain data for ${mint}: ${details.reason?.message || 'unavailable'}`);
		err.rpcCode = -32004;
		throw err;
	}

	const name = d.name || d.metadata?.name || null;
	const symbol = (d.symbol || d.metadata?.symbol || '') || null;
	const image = await resolveImage(d);

	const q = new URLSearchParams({ mint });
	if (network === 'devnet') q.set('network', 'devnet');
	const viewerUrl = `${siteBase}/coin3d?${q.toString()}`;

	return {
		mint,
		network,
		name,
		symbol: symbol ? symbol.toUpperCase() : null,
		image,
		marketCapUsd: num(d.marketCapUsd ?? d.usdMarketCap ?? d.market_cap),
		graduated: Boolean(c?.graduated || c?.complete),
		graduationProgress: pct01(c?.graduationProgress ?? c?.progress),
		topHolderPercent: num(h?.topHolderPercent),
		topHolders: Array.isArray(h?.holders) ? h.holders : [],
		viewerUrl,
		embedHtml: `<iframe src="${viewerUrl}" width="640" height="420" frameborder="0" allow="fullscreen" style="border:0;border-radius:16px"></iframe>`,
		rendering: {
			coin: image ? 'token logo textured onto a spinning 3D medallion' : 'brand-tinted disc (no logo found)',
			holderGalaxy: (h?.holders?.length || 0) > 0
				? `${h.holders.length} top holders as balance-sized, concentration-tinted orbiting spheres`
				: 'no holder data available',
			graduationRing: c
				? (c.graduated || c.complete ? 'full ring (graduated to Raydium)' : 'arc filled to bonding-curve progress')
				: 'no bonding-curve data available',
		},
	};
}

export const NATIVE_TOOLS = [
	{
		def: {
			name: 'pumpfun_token_3d',
			description:
				'Live 3D snapshot of a pump.fun / Solana token. Composes on-chain token metadata, bonding-curve graduation progress, and top-holder distribution, and returns a shareable three.ws /coin3d viewer deep-link (a spinning coin medallion textured with the token logo, a holder galaxy, and a graduation ring) plus an embeddable iframe and the underlying data. Read-only, free.',
			inputSchema: {
				type: 'object',
				properties: {
					mint: { type: 'string', description: 'SPL / pump.fun token mint address (base58).' },
					network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
				},
				required: ['mint'],
			},
		},
		handler: token3dHandler,
	},
];

export function buildNativeRegistry(backendUrl, call) {
	const siteBase = siteBaseFrom(backendUrl);
	const defs = NATIVE_TOOLS.map((t) => t.def);
	const handlers = new Map(
		NATIVE_TOOLS.map((t) => [t.def.name, (args) => t.handler(args, { call, siteBase })]),
	);
	return { defs, handlers };
}
