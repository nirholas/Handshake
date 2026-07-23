// Crawlers for external Solana agent registries → solana_agents_index.
//
// Two upstreams, one table (discriminated by `source`):
//   • Metaplex Agent Registry — enumerate AgentIdentity (v1 + v2) program
//     accounts via getProgramAccounts, then enrich each from its Metaplex Core
//     asset's DAS record (name/image/json_uri/owner).
//   • AgenC coordination protocol (Tetsuo Corp) — enumerate `agentRegistration`
//     accounts via Anchor, then enrich each from its on-chain metadataUri JSON.
//
// Both are idempotent upserts keyed on (source, ref); re-running re-syncs state
// and refreshes last_seen_at. The big SDKs are dynamically imported so this
// module only pulls them in when the crawl cron actually runs.

import { sql } from './db.js';
import { solanaRpcEndpoints } from './solana/connection.js';
import { fetchSafePublicUrlPinned } from './ssrf-guard.js';
import {
	truncate,
	resolveGateway,
	normalizeDasAsset,
	agencStatusLabel,
	agencActive,
	MAX_NAME,
	MAX_DESC,
} from './solana-agents-normalize.js';

// Metaplex Agent Registry identity program. The mpl-agent-registry generated
// client bakes this default in, but we pin it here too so a getProgramAccounts
// scan targets the right program even if the SDK's default ever drifts.
const MPL_AGENT_IDENTITY_PROGRAM = '1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p';

const FETCH_TIMEOUT_MS = 6_000;
// On-chain metadata JSON is small by convention; anything larger is not a
// metadata document. Also the streaming cap the pinned guard enforces.
const MAX_METADATA_BYTES = 1024 * 1024;

// Pick the best available mainnet RPC. solanaRpcEndpoints prefers Helius (which
// also answers DAS getAsset on the same URL), falling back to public nodes.
function mainnetRpc() {
	const [url] = solanaRpcEndpoints('mainnet');
	if (!url) throw new Error('no Solana mainnet RPC configured (set SOLANA_RPC_URL or HELIUS_API_KEY)');
	return url;
}

async function fetchJsonWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
	const resolved = resolveGateway(url);
	if (!resolved) return null;
	try {
		// metadataUri / json_uri values come from on-chain accounts anyone can
		// register, i.e. attacker-controlled URLs. The pinned guard keeps the
		// crawl from being turned into an SSRF against internal services from
		// the Cloud Run network, and caps the body so a hostile host cannot
		// stream unbounded bytes into the instance.
		const r = await fetchSafePublicUrlPinned(
			resolved,
			{
				signal: AbortSignal.timeout(timeoutMs),
				headers: { accept: 'application/json', 'user-agent': 'three.ws-onchain-indexer/1.0 (+https://three.ws)' },
			},
			{ maxBytes: MAX_METADATA_BYTES },
		);
		if (!r.ok) return null;
		return await r.json();
	} catch {
		return null;
	}
}

// Pure normalization of a DAS getAsset result into the index fields. Extracted
// Single Helius/DAS getAsset call. Returns the normalized fields the index needs.
async function dasGetAsset(rpcUrl, assetId) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	try {
		const r = await fetch(rpcUrl, {
			method: 'POST',
			signal: ctrl.signal,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 'das', method: 'getAsset', params: { id: assetId } }),
		});
		if (!r.ok) return null;
		const body = await r.json();
		return normalizeDasAsset(body?.result);
	} catch {
		return null;
	} finally {
		clearTimeout(t);
	}
}

// Upsert one external Solana agent. registered_at is set to now() only on first
// insert (a stable "first seen" proxy — these registries expose no cheap on-chain
// creation timestamp) and preserved on every later sync.
async function upsertAgent(row) {
	await sql`
		INSERT INTO solana_agents_index
			(source, ref, network, owner, asset, agent_id, name, description, image,
			 glb_url, metadata_uri, endpoint, capabilities, reputation, status,
			 has_3d, x402_support, active, registered_at, last_metadata_at, metadata_error, last_seen_at)
		VALUES
			(${row.source}, ${row.ref}, ${row.network || 'mainnet'}, ${row.owner || null},
			 ${row.asset || null}, ${row.agent_id || null}, ${row.name || null},
			 ${row.description || null}, ${row.image || null}, ${row.glb_url || null},
			 ${row.metadata_uri || null}, ${row.endpoint || null}, ${row.capabilities || null},
			 ${row.reputation ?? null}, ${row.status || null}, ${!!row.glb_url},
			 ${!!row.x402_support}, ${row.active !== false},
			 now(), ${row.enriched ? sql`now()` : null}, ${row.metadata_error || null}, now())
		ON CONFLICT (source, ref) DO UPDATE SET
			owner        = COALESCE(excluded.owner, solana_agents_index.owner),
			asset        = COALESCE(excluded.asset, solana_agents_index.asset),
			agent_id     = COALESCE(excluded.agent_id, solana_agents_index.agent_id),
			name         = COALESCE(excluded.name, solana_agents_index.name),
			description  = COALESCE(excluded.description, solana_agents_index.description),
			image        = COALESCE(excluded.image, solana_agents_index.image),
			glb_url      = COALESCE(excluded.glb_url, solana_agents_index.glb_url),
			metadata_uri = COALESCE(excluded.metadata_uri, solana_agents_index.metadata_uri),
			endpoint     = COALESCE(excluded.endpoint, solana_agents_index.endpoint),
			capabilities = COALESCE(excluded.capabilities, solana_agents_index.capabilities),
			reputation   = COALESCE(excluded.reputation, solana_agents_index.reputation),
			status       = COALESCE(excluded.status, solana_agents_index.status),
			has_3d       = solana_agents_index.has_3d OR excluded.has_3d,
			x402_support = solana_agents_index.x402_support OR excluded.x402_support,
			active       = excluded.active,
			last_metadata_at = CASE WHEN ${!!row.enriched} THEN now() ELSE solana_agents_index.last_metadata_at END,
			metadata_error   = excluded.metadata_error,
			last_seen_at = now()
	`;
}

// ── Metaplex Agent Registry ────────────────────────────────────────────────

export async function crawlMetaplexAgents({ deadline } = {}) {
	const report = { source: 'metaplex', scanned: 0, upserted: 0, enriched: 0, errors: [] };
	const rpcUrl = mainnetRpc();

	let umi, gpaV1, gpaV2;
	try {
		const { createUmi } = await import('@metaplex-foundation/umi-bundle-defaults');
		const { publicKey } = await import('@metaplex-foundation/umi');
		const reg = await import('@metaplex-foundation/mpl-agent-registry');
		umi = createUmi(rpcUrl);
		// The GPA builder reads the identity program id from umi via
		// context.programs.getPublicKey('mplAgentIdentity', <default>); the SDK's
		// baked-in default is MPL_AGENT_IDENTITY_PROGRAM, so an unmodified umi scans
		// the right program. Register it explicitly too, in case a future SDK build
		// drops the default — then getPublicKey resolves it from the registry.
		try {
			umi.programs.add({ name: 'mplAgentIdentity', publicKey: publicKey(MPL_AGENT_IDENTITY_PROGRAM), getErrorFromCode: () => null, getErrorFromName: () => null, isOnCluster: () => true });
		} catch { /* already registered or registry shape differs — default still applies */ }
		gpaV2 = typeof reg.getAgentIdentityV2GpaBuilder === 'function'
			? reg.getAgentIdentityV2GpaBuilder(umi)
			: null;
		gpaV1 = typeof reg.getAgentIdentityV1GpaBuilder === 'function'
			? reg.getAgentIdentityV1GpaBuilder(umi)
			: null;
	} catch (err) {
		report.errors.push({ stage: 'init', error: err.message || String(err) });
		return report;
	}

	// Enumerate both account versions. getDeserialized() returns every account of
	// the type owned by the program — the full registry, not just ours.
	const accounts = [];
	for (const [label, gpa] of [['v2', gpaV2], ['v1', gpaV1]]) {
		if (!gpa) continue;
		try {
			const list = await gpa.getDeserialized();
			for (const acc of list) accounts.push({ label, acc });
		} catch (err) {
			report.errors.push({ stage: `gpa-${label}`, error: err.message || String(err) });
		}
	}
	report.scanned = accounts.length;

	for (const { acc } of accounts) {
		if (deadline && Date.now() > deadline) break;
		try {
			const ref = String(acc.publicKey);
			const asset = acc.asset ? String(acc.asset) : null;
			// Structural upsert first so the row exists even if enrichment fails.
			let enriched = null;
			if (asset) enriched = await dasGetAsset(rpcUrl, asset);
			await upsertAgent({
				source: 'metaplex',
				ref,
				asset,
				owner: enriched?.owner || null,
				name: enriched?.name || null,
				description: enriched?.description || null,
				image: enriched?.image || null,
				glb_url: enriched?.glb_url || null,
				metadata_uri: enriched?.metadata_uri || null,
				active: true,
				enriched: !!enriched,
				metadata_error: asset && !enriched ? 'das fetch failed' : null,
			});
			report.upserted += 1;
			if (enriched) report.enriched += 1;
		} catch (err) {
			report.errors.push({ stage: 'upsert', error: err.message || String(err) });
		}
	}
	return report;
}

// ── AgenC coordination protocol ────────────────────────────────────────────

function bytesToBase58(bytes, bs58) {
	try {
		return bs58.encode(Uint8Array.from(bytes));
	} catch {
		return null;
	}
}

export async function crawlAgencAgents({ deadline } = {}) {
	const report = { source: 'agenc', scanned: 0, upserted: 0, enriched: 0, errors: [] };
	const rpcUrl = mainnetRpc();

	let program, bs58;
	try {
		const { Connection, Keypair } = await import('@solana/web3.js');
		const anchor = await import('@coral-xyz/anchor');
		const { AGENC_COORDINATION_IDL } = await import('@tetsuo-ai/protocol');
		bs58 = (await import('bs58')).default;

		const connection = new Connection(rpcUrl, 'confirmed');
		// Read-only provider: an ephemeral wallet that never signs. Anchor needs a
		// payer/publicKey slot to construct the provider; the account namespace we
		// use (.all()) only reads.
		const ephemeral = Keypair.generate();
		const wallet = {
			payer: ephemeral,
			publicKey: ephemeral.publicKey,
			signTransaction: async (tx) => tx,
			signAllTransactions: async (txs) => txs,
		};
		const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
		program = new anchor.Program(AGENC_COORDINATION_IDL, provider);
	} catch (err) {
		report.errors.push({ stage: 'init', error: err.message || String(err) });
		return report;
	}

	let accounts = [];
	try {
		// `agentRegistration` is the AgenC agent account (verified against
		// @tetsuo-ai/sdk's getAccount2(program, "agentRegistration")).
		accounts = await program.account.agentRegistration.all();
	} catch (err) {
		report.errors.push({ stage: 'all', error: err.message || String(err) });
		return report;
	}
	report.scanned = accounts.length;

	for (const entry of accounts) {
		if (deadline && Date.now() > deadline) break;
		try {
			const acc = entry.account || {};
			const ref = String(entry.publicKey);
			const agentIdBytes = acc.agentId ?? acc.agent_id;
			const agentId = agentIdBytes ? bytesToBase58(agentIdBytes, bs58) : null;
			const owner = acc.authority ? String(acc.authority) : null;
			const capabilities = acc.capabilities != null ? String(acc.capabilities) : null;
			const endpoint = typeof acc.endpoint === 'string' ? acc.endpoint : null;
			const metadataUriRaw = acc.metadataUri ?? acc.metadata_uri;
			const metadataUri = typeof metadataUriRaw === 'string' && metadataUriRaw.length ? metadataUriRaw : null;
			const reputation = acc.reputation != null ? Number(acc.reputation) : null;
			const status = agencStatusLabel(acc.status);

			// Enrich name/description/image from the off-chain metadata JSON.
			let meta = null;
			if (metadataUri) meta = await fetchJsonWithTimeout(metadataUri);
			const image = meta?.image ? resolveGateway(meta.image) : null;
			const glb = (meta?.animation_url && /\.glb($|\?)/i.test(meta.animation_url))
				? resolveGateway(meta.animation_url)
				: (Array.isArray(meta?.services)
					? resolveGateway(meta.services.find((s) => String(s?.name || '').toLowerCase() === 'avatar')?.endpoint)
					: null);

			await upsertAgent({
				source: 'agenc',
				ref,
				agent_id: agentId,
				owner,
				endpoint,
				capabilities,
				reputation,
				status,
				metadata_uri: metadataUri,
				name: truncate(meta?.name, MAX_NAME),
				description: truncate(meta?.description, MAX_DESC),
				image,
				glb_url: glb || null,
				x402_support: !!(meta?.x402Support || meta?.x402),
				active: agencActive(status),
				enriched: !!meta,
				metadata_error: metadataUri && !meta ? 'metadata fetch failed' : null,
			});
			report.upserted += 1;
			if (meta) report.enriched += 1;
		} catch (err) {
			report.errors.push({ stage: 'upsert', error: err.message || String(err) });
		}
	}
	return report;
}
