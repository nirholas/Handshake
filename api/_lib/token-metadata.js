// Solana token metadata resolver: Postgres cache primary, Helius DAS on miss,
// keyless Jupiter as the rung that keeps working when Helius does not.
//
// Why: getAsset/searchAssets are the most expensive Helius calls (~10 credits
// each). Mint metadata (symbol, name, logo, decimals) is effectively immutable,
// so we resolve a mint *once* and serve from `token_metadata` forever after.
//
// Cache flow for getMetadataForMints(mints[]):
//   1. SELECT cached rows from token_metadata (fabricated placeholders re-resolve)
//   2. Resolve cache misses via Helius getAssetBatch (single RPC, up to 1000 mints)
//   3. Resolve whatever Helius could not name via Jupiter token search (keyless)
//   4. INSERT new rows (ON CONFLICT DO UPDATE, refreshing stale logos)
//
// Falls back gracefully:
//   - no Helius key or exhausted Helius quota: Jupiter names the mint instead
//   - no source knows the mint: symbol/name are null, never a slice of the mint
//   - DB unreachable: in-memory map for the request lifetime

import { sql, sqlValues } from './db.js';

const REFRESH_AFTER_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

function heliusRpcUrl() {
	const key = process.env.HELIUS_API_KEY;
	return key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : null;
}

// A mint no source could name. symbol/name stay null rather than a slice of the
// mint: a fabricated "So1111" reads as a real ticker to every downstream caller
// and to any agent consuming /api/crypto/wallet. Presentation layers
// (src/portfolio.js, api/_lib/portfolio-overview.js) already derive a short-mint
// label from a null symbol, so the honest null costs nothing on screen.
function bareEntry(mint) {
	return { mint, symbol: null, name: null, logo: null, decimals: null };
}

// Rows written before the Jupiter rung existed (and any Helius row that fell back
// to a mint slice) carry a fabricated symbol. Treat those as cache misses so the
// cache heals itself on the next read instead of serving the fake forever.
function isFabricated(entry) {
	if (!entry?.symbol) return false;
	return entry.symbol === entry.mint.slice(0, 6) || entry.symbol === entry.mint.slice(0, 8);
}

async function fetchFromCache(mints) {
	if (mints.length === 0) return new Map();
	try {
		const rows = await sql`
			SELECT mint, symbol, name, logo, decimals, refreshed_at
			FROM token_metadata
			WHERE mint = ANY(${mints}) AND chain = 'solana'
		`;
		const out = new Map();
		const now = Date.now();
		for (const r of rows) {
			const age = now - new Date(r.refreshed_at).getTime();
			if (age > REFRESH_AFTER_MS) continue; // stale, re-resolve
			const entry = {
				mint: r.mint,
				symbol: r.symbol,
				name: r.name,
				logo: r.logo,
				decimals: r.decimals,
			};
			if (isFabricated(entry)) continue; // mint-slice placeholder, re-resolve
			out.set(r.mint, entry);
		}
		return out;
	} catch (err) {
		console.warn('[token-metadata] cache read failed:', err?.message);
		return new Map();
	}
}

async function persist(entries, source) {
	if (entries.length === 0) return;
	try {
		const now = new Date();
		const rows = entries.map((e) => [
			e.mint, 'solana', e.symbol, e.name, e.logo, e.decimals, source, now,
		]);
		await sql`
			INSERT INTO token_metadata (mint, chain, symbol, name, logo, decimals, source, refreshed_at)
			VALUES ${sqlValues(rows)}
			ON CONFLICT (mint) DO UPDATE SET
				symbol = EXCLUDED.symbol,
				name = EXCLUDED.name,
				logo = EXCLUDED.logo,
				decimals = EXCLUDED.decimals,
				refreshed_at = EXCLUDED.refreshed_at
		`;
	} catch (err) {
		console.warn('[token-metadata] cache write failed:', err?.message);
	}
}

async function resolveViaHelius(mints) {
	const rpc = heliusRpcUrl();
	if (!rpc || mints.length === 0) return [];
	try {
		const r = await fetch(rpc, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 'getAssetBatch',
				method: 'getAssetBatch',
				params: { ids: mints },
			}),
		});
		if (!r.ok) {
			console.warn('[token-metadata] helius getAssetBatch failed:', r.status);
			return [];
		}
		const json = await r.json();
		const results = Array.isArray(json?.result) ? json.result : [];
		return results
			.filter(Boolean)
			.map((asset) => {
				const md = asset?.content?.metadata || {};
				const decimals = asset?.token_info?.decimals ?? null;
				return {
					mint: asset.id,
					symbol: md.symbol || null,
					name: md.name || md.symbol || null,
					logo: asset?.content?.links?.image || asset?.content?.files?.[0]?.uri || null,
					decimals,
				};
			})
			.filter((e) => e.symbol || e.name || e.logo);
	} catch (err) {
		console.warn('[token-metadata] helius resolve failed:', err?.message);
		return [];
	}
}

// Keyless metadata rung. Jupiter's token search names any mint that has ever
// traded on a Solana AMM, needs no key, and is the same host already used for
// prices in api/_lib/balances.js. It is what keeps symbols real when the Helius
// quota is exhausted (which returns HTTP 429 "max usage reached" on every call,
// including getAssetBatch) or when no HELIUS_API_KEY is configured at all.
const JUPITER_SEARCH_BATCH = 100;

async function resolveViaJupiter(mints) {
	if (mints.length === 0) return [];
	const out = [];
	for (let i = 0; i < mints.length; i += JUPITER_SEARCH_BATCH) {
		const chunk = mints.slice(i, i + JUPITER_SEARCH_BATCH);
		try {
			const r = await fetch(
				`https://lite-api.jup.ag/tokens/v2/search?query=${chunk.join(',')}`,
				{ signal: AbortSignal.timeout(15_000) },
			);
			if (!r.ok) {
				console.warn('[token-metadata] jupiter search failed:', r.status);
				continue;
			}
			const rows = await r.json();
			if (!Array.isArray(rows)) continue;
			for (const t of rows) {
				if (!t?.id || !(t.symbol || t.name)) continue;
				out.push({
					mint: t.id,
					symbol: t.symbol || null,
					name: t.name || t.symbol || null,
					logo: t.icon || null,
					decimals: Number.isFinite(t.decimals) ? t.decimals : null,
				});
			}
		} catch (err) {
			console.warn('[token-metadata] jupiter chunk failed:', err?.message);
		}
	}
	return out;
}

/**
 * Resolve metadata for a list of mints. Always returns one entry per input mint
 * (bare placeholder if everything else fails).
 * @param {string[]} mints
 * @returns {Promise<Map<string, {mint,symbol,name,logo,decimals}>>}
 */
export async function getMetadataForMints(mints) {
	const unique = Array.from(new Set(mints.filter(Boolean)));
	if (unique.length === 0) return new Map();

	const cached = await fetchFromCache(unique);
	let missing = unique.filter((m) => !cached.has(m));

	if (missing.length > 0) {
		// Helius getAssetBatch caps at 1000 per request, so chunk safely.
		const resolved = [];
		for (let i = 0; i < missing.length; i += 1000) {
			const chunk = missing.slice(i, i + 1000);
			const part = await resolveViaHelius(chunk);
			resolved.push(...part);
		}
		if (resolved.length > 0) {
			await persist(resolved, 'helius-das');
			for (const r of resolved) cached.set(r.mint, r);
		}
		missing = missing.filter((m) => !cached.has(m));
	}

	// Anything Helius could not name (no key, exhausted quota, or a mint DAS has
	// no metadata for) gets the keyless Jupiter rung before we give up on it.
	if (missing.length > 0) {
		const viaJup = await resolveViaJupiter(missing);
		if (viaJup.length > 0) {
			await persist(viaJup, 'jupiter');
			for (const r of viaJup) cached.set(r.mint, r);
		}
	}

	// Fill any remaining gaps with bare placeholders so the caller gets a stable shape.
	for (const m of unique) {
		if (!cached.has(m)) cached.set(m, bareEntry(m));
	}
	return cached;
}
