// Solana token metadata resolver — Postgres cache primary, Helius DAS on miss.
//
// Why: getAsset/searchAssets are the most expensive Helius calls (~10 credits
// each). Mint metadata (symbol, name, logo, decimals) is effectively immutable,
// so we resolve a mint *once* and serve from `token_metadata` forever after.
//
// Cache flow for getMetadataForMints(mints[]):
//   1. SELECT cached rows from token_metadata
//   2. Resolve cache misses via Helius getAssetBatch (single RPC, up to 1000 mints)
//   3. INSERT new rows (ON CONFLICT DO UPDATE — refresh stale logos)
//
// Falls back gracefully:
//   - no Helius key → returns only cached + bare {mint, symbol: mint.slice(0,6)}
//   - DB unreachable → in-memory map for the request lifetime

import { sql } from './db.js';

const REFRESH_AFTER_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

function heliusRpcUrl() {
	const key = process.env.HELIUS_API_KEY;
	return key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : null;
}

function bareEntry(mint) {
	return { mint, symbol: mint.slice(0, 6), name: mint.slice(0, 6), logo: null, decimals: null };
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
			if (age > REFRESH_AFTER_MS) continue; // stale — re-resolve
			out.set(r.mint, {
				mint: r.mint,
				symbol: r.symbol,
				name: r.name,
				logo: r.logo,
				decimals: r.decimals,
			});
		}
		return out;
	} catch (err) {
		console.warn('[token-metadata] cache read failed:', err?.message);
		return new Map();
	}
}

async function persist(entries) {
	if (entries.length === 0) return;
	try {
		await sql`
			INSERT INTO token_metadata (mint, chain, symbol, name, logo, decimals, source, refreshed_at)
			SELECT * FROM ${sql(
				entries.map((e) => [e.mint, 'solana', e.symbol, e.name, e.logo, e.decimals, 'helius-das', new Date()]),
			)}
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
					symbol: md.symbol || asset.id.slice(0, 6),
					name: md.name || md.symbol || asset.id.slice(0, 6),
					logo: asset?.content?.links?.image || asset?.content?.files?.[0]?.uri || null,
					decimals,
				};
			});
	} catch (err) {
		console.warn('[token-metadata] helius resolve failed:', err?.message);
		return [];
	}
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
	const missing = unique.filter((m) => !cached.has(m));

	if (missing.length > 0) {
		// Helius getAssetBatch caps at 1000 per request — chunk safely.
		const resolved = [];
		for (let i = 0; i < missing.length; i += 1000) {
			const chunk = missing.slice(i, i + 1000);
			const part = await resolveViaHelius(chunk);
			resolved.push(...part);
		}
		if (resolved.length > 0) {
			await persist(resolved);
			for (const r of resolved) cached.set(r.mint, r);
		}
	}

	// Fill any remaining gaps with bare placeholders so the caller gets a stable shape.
	for (const m of unique) {
		if (!cached.has(m)) cached.set(m, bareEntry(m));
	}
	return cached;
}
