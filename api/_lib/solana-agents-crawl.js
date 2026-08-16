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
import { solanaConnection, solanaRpcEndpoints } from './solana/connection.js';
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

// The `key` account discriminator, byte 0 of every identity account
// (Uninitialized 0, AgentIdentityV1 1, AgentIdentityV2 2). Both GPA builders
// register `key` at offset 0 but neither filters on it, so an unfiltered
// getDeserialized() hands EVERY account in the program to one version's
// deserializer. Measured 2026-08-16: the program holds 1503 v2 and 68 v1
// accounts, and unfiltered the v2 scan threw on the first v1 account it met
// ("not of the expected type [AgentIdentityV2AccountData]") while the v1 scan
// silently accepted all 1571 and read v2 bytes through the v1 layout. Pinning
// each builder to its own key is what makes the two scans disjoint and correct;
// the filter is a memcmp the node applies, so it also shrinks the response.
// The SDK does not re-export its Key enum from the package root, so the values
// are named here against the on-chain contract they encode.
const IDENTITY_KEY = { v1: 1, v2: 2 };

const FETCH_TIMEOUT_MS = 6_000;
// On-chain metadata JSON is small by convention; anything larger is not a
// metadata document. Also the streaming cap the pinned guard enforces.
const MAX_METADATA_BYTES = 1024 * 1024;

// Cap for a single registry-enumeration call when the caller passes no deadline.
// Enumeration is the phase that actually blocks: a getProgramAccounts scan over
// a whole program routinely takes tens of seconds and can hang for minutes on a
// throttled, rate-limited, or 504-ing RPC.
const SCAN_BUDGET_MS = 90_000;

/** Milliseconds left before `deadline`, or `fallbackMs` when the caller set none. */
export function remainingMs(deadline, fallbackMs = SCAN_BUDGET_MS) {
	if (!deadline) return fallbackMs;
	return deadline - Date.now();
}

// Bound a call that takes no timeout of its own.
//
// Neither umi's GPA builder nor Anchor's account fetcher accepts a deadline, and
// the per-account `deadline` checks in the crawl loops below are only reached
// AFTER enumeration returns. So a slow upstream blew straight through the budget
// the cron hands down: an audit run measured 272s against a declared 240s, which
// is inside 48s of the 320s attempt deadline Cloud Scheduler gives the job
// (scripts/create-gcp-scheduler.mjs). Past that the request is abandoned and
// retried, and the crawl never completes at all. Bounding the enumeration itself
// is what makes that budget real.
export async function withDeadline(promise, ms, label) {
	// `tracked` never rejects, so an enumeration that settles AFTER the timer
	// fired resolves quietly instead of surfacing as an unhandled rejection on an
	// instance that has already moved on.
	const tracked = promise.then((value) => ({ value }), (error) => ({ error }));
	if (ms <= 0) throw new Error(`${label}: no time left in the crawl budget`);
	let timer;
	const expiry = new Promise((resolve) => {
		timer = setTimeout(
			() => resolve({ error: new Error(`${label}: exceeded its ${Math.round(ms / 1000)}s budget`) }),
			ms,
		);
	});
	try {
		const settled = await Promise.race([tracked, expiry]);
		if (settled.error) throw settled.error;
		return settled.value;
	} finally {
		clearTimeout(timer);
	}
}

// Pick the best available mainnet RPC. solanaRpcEndpoints prefers Helius (which
// also answers DAS getAsset on the same URL), falling back to public nodes.
//
// This is the URL for the DAS `getAsset` enrichment ONLY, which is a
// vendor-specific method a generic lane cannot serve anyway, and whose failure is
// already soft (the structural row is upserted without a name/image). The
// registry ENUMERATION must never use it: see scanConnection below.
function mainnetRpc() {
	const [url] = solanaRpcEndpoints('mainnet');
	if (!url) throw new Error('no Solana mainnet RPC configured (set SOLANA_RPC_URL or HELIUS_API_KEY)');
	return url;
}

// The connection both registry scans enumerate over.
//
// Enumeration is getProgramAccounts, and gPA is the method free lanes are most
// likely to refuse: it is expensive, so providers gate it behind a paid plan, an
// IP allowlist, or nothing at all. Pinning the single highest-priority URL
// therefore fails in the one way that leaves no trace: the crawl records a
// per-stage error string, returns HTTP 200 to Cloud Scheduler, which discards the
// body, and writes nothing. Measured 2026-08-16 against the live lane chain, one
// gPA on the identity program per lane:
//   rpc.magicblock.app        403 "Your IP or provider is blocked from this endpoint"
//   solana-rpc.publicnode.com no answer in 25s
//   api.mainnet-beta.solana.com   200, 1571 accounts in 1.1s
//   solana.leorpc.com         200 + JSON-RPC -32603
//   public.rpc.solanavibestation.com  200, 1571 accounts in 0.5s
//   api.tatum.io / gateway.tatum.io   200 + -16401 "available for paid plans only"
// magicblock is the configured SOLANA_RPC_URL, so it is lane 0, so every tick
// since it became primary scanned nothing: solana_agents_index had not taken an
// upsert since 2026-08-06 while the cron reported 200 every 30 minutes.
//
// solanaConnection rotates the whole chain on exactly these signals (403 and 5xx
// rotate, a provider-tier error code fails the lane over, a 10s attempt timeout
// demotes the shape) so the scan lands on a lane that answers instead of dying on
// the first that does not. The full 1571-account scan is ~559 KB and answers in
// about a second, comfortably inside that attempt bound.
function scanConnection() {
	// Fail the same way mainnetRpc does when nothing is configured at all, rather
	// than handing web3.js a bare default and reporting a confusing lane error.
	mainnetRpc();
	return solanaConnection({ network: 'mainnet', commitment: 'confirmed' });
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
		// createUmi takes an endpoint string OR a ready web3.js Connection; the
		// Connection form is what lets the scan inherit the rotating lane chain.
		umi = createUmi(scanConnection());
		// The GPA builder reads the identity program id from umi via
		// context.programs.getPublicKey('mplAgentIdentity', <default>); the SDK's
		// baked-in default is MPL_AGENT_IDENTITY_PROGRAM, so an unmodified umi scans
		// the right program. Register it explicitly too, in case a future SDK build
		// drops the default — then getPublicKey resolves it from the registry.
		try {
			umi.programs.add({ name: 'mplAgentIdentity', publicKey: publicKey(MPL_AGENT_IDENTITY_PROGRAM), getErrorFromCode: () => null, getErrorFromName: () => null, isOnCluster: () => true });
		} catch { /* already registered or registry shape differs — default still applies */ }
		gpaV2 = typeof reg.getAgentIdentityV2GpaBuilder === 'function'
			? reg.getAgentIdentityV2GpaBuilder(umi).whereField('key', IDENTITY_KEY.v2)
			: null;
		gpaV1 = typeof reg.getAgentIdentityV1GpaBuilder === 'function'
			? reg.getAgentIdentityV1GpaBuilder(umi).whereField('key', IDENTITY_KEY.v1)
			: null;
	} catch (err) {
		report.errors.push({ stage: 'init', error: err.message || String(err) });
		return report;
	}

	// Enumerate both account versions. Each builder is pinned to its own
	// discriminator above, so getDeserialized() reads every account of THAT type,
	// the full registry rather than just ours, and nothing else.
	const accounts = [];
	// Split whatever budget is left evenly across the scans still to run, so a
	// slow v2 cannot silently starve v1 of every remaining millisecond.
	const scans = [['v2', gpaV2], ['v1', gpaV1]].filter(([, gpa]) => gpa);
	for (let i = 0; i < scans.length; i++) {
		const [label, gpa] = scans[i];
		const share = Math.floor(remainingMs(deadline) / (scans.length - i));
		try {
			const list = await withDeadline(gpa.getDeserialized(), share, `gpa-${label}`);
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

	let program, bs58;
	try {
		const { Keypair } = await import('@solana/web3.js');
		const anchor = await import('@coral-xyz/anchor');
		const { AGENC_COORDINATION_IDL } = await import('@tetsuo-ai/protocol');
		bs58 = (await import('bs58')).default;

		// Anchor's account fetcher offers no timeout of its own, and this scan is
		// the same getProgramAccounts that dies on a refusing lane 0 (see
		// scanConnection). The rotating connection supplies both halves: failover
		// across the chain, and a 10s per-attempt bound, stricter than the 30s
		// hand-rolled cap this replaced, so a stalled socket is released rather
		// than held for the whole scan budget.
		const connection = scanConnection();
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
		accounts = await withDeadline(
			program.account.agentRegistration.all(),
			remainingMs(deadline),
			'agenc account scan',
		);
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
