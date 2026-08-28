// api/_lib/x402/pipelines/forge-content.js
//
// 3D Forge Content Generation: autonomous pipeline (self/014).
//
// On each run it pays the paid three.ws Forge (standard tier) to generate one
// procedural prop from a combinatorial, platform-aligned catalog (club decor,
// AR objects, diorama set-dressing, avatar items, vehicles, containers,
// furniture, terrain tiles), hash-walked per hour so the /forged gallery stays
// varied and balanced across families.
// Each call is a real on-chain USDC payment from the seed wallet via the shared
// payX402 client. The pipeline:
//
//   1. Picks the next prop prompt (deterministic category rotation, varied
//      prompt) and pays /api/x402/forge for the generation (real x402, never
//      mocked).
//   2. Embeds the prop prompt (free NIM / OpenAI when configured, deterministic
//      feature-hash fallback otherwise) and scores its diversity against the
//      recent catalog: novelty = 1 − max cosine similarity, plus a k-means
//      cluster id: both within a single embedder vector space.
//   3. Inserts the generated prop into forge_autonomous_props (the asset-library
//      + diversity table) carrying the public glb_url, prompt, category, tier,
//      embedding, novelty and cluster id.
//   4. Records a row in x402_autonomous_log for the call (success or failure),
//      with the extracted prop summary in value_extracted.
//
// Wiring: declared as a run()-style entry in autonomous-registry.js. The per-tick
// loop (api/cron/x402-autonomous-loop.js) hands run() a shared payment context
// (buyer, conn, blockhash, mintInfo, remainingCap); called standalone (manual
// test) it bootstraps its own via bootstrapSolanaContext().
//
// DOWNSTREAM CONSUMER: the forge gallery / diversity dashboard reads
// forge_autonomous_props: `glb_url` renders the prop, `category` filters the
// feed, and `novelty` + `cluster_id` drive the "how varied is the generated
// catalog" metric (the embedding-clustering diversity measure). Inline-completed
// draft jobs carry a directly-renderable public R2 `glb_url`; async jobs carry a
// `job_id` poll token with status 'queued', so the table is the single source of
// truth for everything the autonomous forge has produced.

import { randomUUID } from 'node:crypto';

import { sql } from '../../db.js';
import { env } from '../../env.js';
import { logger } from '../../usage.js';
import { payX402, bootstrapSolanaContext, USDC_MINT } from '../pay.js';
import {
	embeddingsConfigured,
	defaultIngestEmbedderTag,
	embedPassages,
	cosine,
} from '../../embeddings.js';
import { kmeans, suggestClusterCount, unit } from '../../embedding-math.js';
import { fetchUpstream } from '../../upstream-fetch.js';
import { PROP_CATALOG, STYLES, FINISHES, CATEGORIES } from './forge-catalog.js';

const log = logger('x402-forge-content');

const ASSET = USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Vector space tag for the dependency-free fallback embedding. Tagged distinctly
// so it is NEVER compared against real NIM/OpenAI vectors: cosine only ever runs
// within a single embedder space (the rule embeddings.js enforces everywhere).
const LOCAL_EMBED_TAG = 'local/feature-hash@96';
const LOCAL_EMBED_DIM = 96;

// How many recent same-space rows to weigh novelty + clustering against. Bounded
// so the per-call k-means stays trivial inside the serverless window.
const DIVERSITY_WINDOW = 200;

// Small deterministic integer hash (xorshift-style avalanche). Turns the hour
// counter into an effectively random (but reproducible) walk over the prompt
// space, so consecutive hours land on unrelated (category, subject, style)
// combinations instead of marching through the lists in order.
function mix(n, salt) {
	let h = (n ^ (salt * 0x9e3779b1)) >>> 0;
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b) >>> 0;
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35) >>> 0;
	h ^= h >>> 16;
	return h >>> 0;
}

// Deterministic, non-random selector over the combinatorial space. No
// Math.random — two runs in the same hour pick the same prop, which the paid
// endpoint's idempotency guard collapses rather than double-charging. The hash
// walk makes successive hours look random while covering all categories evenly
// in expectation (~5k distinct prompts before any repeat is likely).
export function nextForgeProp(now = Date.now()) {
	const hour = Math.floor(now / 3_600_000);
	const category = CATEGORIES[mix(hour, 1) % CATEGORIES.length];
	const subjects = PROP_CATALOG[category];
	const subject = subjects[mix(hour, 2) % subjects.length];
	const style = STYLES[mix(hour, 3) % STYLES.length];
	const finish = FINISHES[mix(hour, 4) % FINISHES.length];
	return { category, prompt: `${subject}, ${style}, ${finish}, 3D prop` };
}

// ── Embedding ──────────────────────────────────────────────────────────────────

// Signed feature hashing (FNV-1a → bucket, top bit → sign). A real, deterministic
// bag-of-words embedding used only when no embedding provider is configured, so
// the diversity metric still works with zero external calls.
function featureHashEmbed(text, dim = LOCAL_EMBED_DIM) {
	const v = new Array(dim).fill(0);
	const tokens = String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
	for (const tok of tokens) {
		let h = 2166136261;
		for (let i = 0; i < tok.length; i++) {
			h ^= tok.charCodeAt(i);
			h = Math.imul(h, 16777619);
		}
		const idx = (h >>> 0) % dim;
		const sign = (h >>> 31) & 1 ? -1 : 1;
		v[idx] += sign;
	}
	return v;
}

// Embed the prop prompt. Prefer the configured free-first provider; on any
// failure fall back to the local hash embedding so a provider outage degrades
// the diversity metric rather than failing the call's bookkeeping.
async function embedProp(prompt) {
	if (embeddingsConfigured()) {
		const tag = defaultIngestEmbedderTag();
		if (tag) {
			try {
				const [vec] = await embedPassages(tag, [prompt]);
				if (vec?.length) return { embedder: tag, vector: Array.from(vec) };
			} catch {
				/* provider hiccup: fall through to the deterministic local space */
			}
		}
	}
	return { embedder: LOCAL_EMBED_TAG, vector: featureHashEmbed(prompt) };
}

// ── Diversity (novelty + cluster) ──────────────────────────────────────────────

// novelty = 1 − max cosine similarity to the recent catalog in the SAME space;
// cluster_id = k-means assignment of the new prop within that space. The first
// prop in a space is maximally novel (1) and forms cluster 0.
async function scoreDiversity(embedder, vector) {
	let recent = [];
	try {
		recent = await sql`
			SELECT embedding FROM forge_autonomous_props
			WHERE embedder = ${embedder}
			ORDER BY ts DESC
			LIMIT ${DIVERSITY_WINDOW}
		`;
	} catch {
		// Table briefly unavailable: treat as an empty catalog (max novelty).
		return { novelty: 1, clusterId: 0, neighbors: 0 };
	}

	const peers = recent
		.map((r) => r.embedding)
		.filter((a) => Array.isArray(a) && a.length === vector.length);

	if (peers.length === 0) return { novelty: 1, clusterId: 0, neighbors: 0 };

	let maxSim = 0;
	for (const p of peers) {
		const s = cosine(vector, p);
		if (s > maxSim) maxSim = s;
	}
	const novelty = Math.max(0, Math.min(1, 1 - maxSim));

	// Cluster the new prop against the recent catalog. Unit-normalise so squared
	// euclidean distance ranks the same as cosine (semantic clusters).
	const all = [...peers, vector].map((v) => unit(v));
	const k = suggestClusterCount(all.length);
	const { assignments } = kmeans(all, k);
	const clusterId = assignments[assignments.length - 1] ?? 0;

	return { novelty, clusterId, neighbors: peers.length };
}

// ── Schema ──────────────────────────────────────────────────────────────────────

async function ensureSchema() {
	// forge_autonomous_props: the public asset-library + diversity table for
	// autonomously-forged props. glb_url is the renderable asset; novelty +
	// cluster_id are the embedding-clustering diversity metric.
	await sql`
		CREATE TABLE IF NOT EXISTS forge_autonomous_props (
			id          bigserial PRIMARY KEY,
			run_id      uuid,
			ts          timestamptz DEFAULT now(),
			prompt      text NOT NULL,
			category    text NOT NULL,
			tier        text,
			mode        text,
			backend     text,
			job_id      text,
			glb_url     text,
			status      text,
			embedder    text,
			embedding   jsonb,
			novelty     numeric(6,5),
			cluster_id  int
		)
	`;
	await sql`
		CREATE INDEX IF NOT EXISTS forge_autonomous_props_cat_ts_idx
		ON forge_autonomous_props (category, ts DESC)
	`;
	// Payment provenance: every prop links back to the on-chain USDC payment that
	// bought it (payer wallet, price, settlement signature). This is what the
	// public /forged gallery renders as the receipts trail.
	await sql`ALTER TABLE forge_autonomous_props ADD COLUMN IF NOT EXISTS tx_sig text`;
	await sql`ALTER TABLE forge_autonomous_props ADD COLUMN IF NOT EXISTS payer text`;
	await sql`ALTER TABLE forge_autonomous_props ADD COLUMN IF NOT EXISTS amount_atomic bigint`;
	// The autonomous log predates the run()-style pipelines; add the
	// value_extracted column this pipeline records its prop summary into (idempotent).
	await sql`ALTER TABLE x402_autonomous_log ADD COLUMN IF NOT EXISTS value_extracted jsonb`;
}

// Resolve previously-queued generations. Async forge jobs hand back a job_id
// poll token; the FREE poll endpoint (GET /api/forge?job=<id>) reports 'queued',
// 'done' (with glb_url) or 'failed'. Each run sweeps a few pending rows so the
// public gallery converges on renderable assets without a dedicated cron.
// Never throws: a poll hiccup just retries on the next run.
const RESOLVE_BATCH = 5;
async function resolveQueuedJobs(origin) {
	let rows = [];
	try {
		rows = await sql`
			SELECT id, job_id FROM forge_autonomous_props
			WHERE status = 'queued' AND job_id IS NOT NULL
			ORDER BY ts ASC
			LIMIT ${RESOLVE_BATCH}
		`;
	} catch {
		return 0;
	}
	let resolved = 0;
	for (const row of rows) {
		try {
			// Bounded: this resolver runs inside a cron tick over a batch of rows, so
			// one hung status read used to cost every remaining row its resolution.
			const res = await fetchUpstream(`${origin}/api/forge?job=${encodeURIComponent(row.job_id)}`, {
				headers: { 'user-agent': 'threews-x402-autonomous/1.0' },
			}, { name: 'self:forge-poll', timeoutMs: 10_000, attempts: 1, okWhen: () => true });
			if (!res.ok) continue;
			const job = await res.json();
			if (job?.status === 'done' && job.glb_url) {
				await sql`UPDATE forge_autonomous_props SET status = 'done', glb_url = ${job.glb_url} WHERE id = ${row.id}`;
				resolved += 1;
			} else if (job?.status === 'failed') {
				await sql`UPDATE forge_autonomous_props SET status = 'failed' WHERE id = ${row.id}`;
			}
		} catch { /* poll hiccup: retry next run */ }
	}
	return resolved;
}

// Per-call row into x402_autonomous_log including value_extracted. The loop also
// records one aggregate summary row for the run() entry; this is the granular
// row the pipeline owns (carrying the parsed prop value).
async function recordCall(runId, { endpointUrl, amountAtomic, txSig, responseData, durationMs, success, errorMsg, valueExtracted }) {
	try {
		await sql`
			INSERT INTO x402_autonomous_log
				(run_id, endpoint_type, service_name, endpoint_url,
				 network, amount_atomic, asset, tx_signature,
				 response_data, value_extracted, duration_ms, success, error_msg, pipeline)
			VALUES
				(${runId}, ${'self'}, ${'3D Forge: procedural prop generation'}, ${endpointUrl},
				 ${'solana:mainnet'}, ${amountAtomic || 0}, ${ASSET}, ${txSig || null},
				 ${responseData ? JSON.stringify(responseData) : null},
				 ${valueExtracted ? JSON.stringify(valueExtracted) : null},
				 ${durationMs || 0}, ${success}, ${errorMsg || null}, ${'forge'})
		`;
	} catch (err) {
		log.warn('forge_content_log_insert_failed', { message: err?.message });
	}
}

// Embed, score diversity, and insert the generated prop. Returns the compact
// summary used as value_extracted. Never throws: a DB/embedding hiccup returns a
// summary carrying the error so the call is still recorded.
async function persistProp({ runId, prompt, category, response, txSig = null, payer = null, amountAtomic = null }) {
	const r = response && typeof response === 'object' ? response : {};
	const tier = r.tier || 'draft';
	const mode = r.mode || 'text_to_3d';
	const backend = r.backend || null;
	const jobId = r.job_id || null;
	const glbUrl = r.glb_url || null;
	const status = r.status || (glbUrl ? 'done' : jobId ? 'queued' : 'unknown');

	let novelty = null;
	let clusterId = null;
	let embedder = null;
	let neighbors = 0;
	let stored = false;
	let storeError = null;

	try {
		const embedded = await embedProp(prompt);
		embedder = embedded.embedder;

		const diversity = await scoreDiversity(embedder, embedded.vector);
		novelty = diversity.novelty;
		clusterId = diversity.clusterId;
		neighbors = diversity.neighbors;

		await sql`
			INSERT INTO forge_autonomous_props
				(run_id, prompt, category, tier, mode, backend,
				 job_id, glb_url, status, embedder, embedding, novelty, cluster_id,
				 tx_sig, payer, amount_atomic)
			VALUES
				(${runId || null}, ${prompt}, ${category}, ${tier}, ${mode}, ${backend},
				 ${jobId}, ${glbUrl}, ${status}, ${embedder},
				 ${JSON.stringify(embedded.vector)}::jsonb, ${novelty}, ${clusterId},
				 ${txSig}, ${payer}, ${amountAtomic})
		`;
		stored = true;
	} catch (err) {
		storeError = err?.message || 'persist_failed';
		log.warn('forge_content_persist_failed', { message: storeError });
	}

	return {
		stored,
		category,
		tier,
		mode,
		backend,
		status,
		job_id: jobId,
		glb_url: glbUrl,
		embedder,
		novelty,
		cluster_id: clusterId,
		diversity_neighbors: neighbors,
		...(storeError ? { error: storeError } : {}),
	};
}

/**
 * Run the forge content generation. Conforms to the run()-style registry
 * contract: the loop hands over { origin, buyer, conn, blockhash, mintInfo,
 * remainingCap, runId }; standalone (manual test) it bootstraps its own Solana
 * context via bootstrapSolanaContext().
 *
 * Returns the aggregate outcome the loop records as one summary row:
 *   { success, amountAtomic, txSig, errorMsg, responseData, signalData, skipped, note }
 */
export async function run(ctx = {}) {
	const runId = ctx.runId || randomUUID();
	const origin = ctx.origin || env.APP_ORIGIN || 'https://three.ws';
	const endpointUrl = `${origin}/api/x402/forge`;
	const remainingCap = ctx.remainingCap ?? Number.POSITIVE_INFINITY;

	// Schema first: without the sink there is no value to extract, so don't pay.
	try {
		await ensureSchema();
	} catch (err) {
		log.warn('forge_content_schema_failed', { message: err?.message });
		return { success: false, skipped: true, amountAtomic: 0, errorMsg: `schema_failed: ${err?.message}` };
	}

	// Solana payment context: reuse the loop's, else bootstrap. A bootstrap
	// failure means the wallet/RPC is unconfigured: exit gracefully, logged, no
	// payment attempted.
	let { buyer, conn, blockhash, mintInfo } = ctx;
	if (!buyer || !conn || !blockhash || !mintInfo) {
		try {
			({ buyer, conn, blockhash, mintInfo } = await bootstrapSolanaContext({ buyer }));
		} catch (err) {
			log.info('forge_content_skipped', { reason: err.message });
			return { success: false, skipped: true, amountAtomic: 0, errorMsg: err.message, note: 'wallet_or_rpc_unconfigured' };
		}
	}

	// Sweep previously-queued jobs toward 'done' before paying for a new one so
	// the gallery keeps converging even if this tick's generation is skipped.
	const resolvedCount = await resolveQueuedJobs(origin);
	if (resolvedCount) log.info('forge_content_jobs_resolved', { count: resolvedCount });

	const { category, prompt } = nextForgeProp();
	const body = { prompt, tier: 'standard', aspect_ratio: '1:1' };
	const t0 = Date.now();

	// Pay for the generation. payX402 never throws for protocol/network faults
	// (it returns a structured outcome): but a hard fetch abort can still throw,
	// so guard it and record the failed call rather than crash the tick.
	let result;
	try {
		result = await payX402({ url: endpointUrl, method: 'POST', body, buyer, conn, blockhash, mintInfo, remainingCap });
	} catch (err) {
		const errorMsg = err?.message || 'forge_pay_error';
		await recordCall(runId, {
			endpointUrl, amountAtomic: 0, txSig: null, responseData: null,
			durationMs: Date.now() - t0, success: false, errorMsg, valueExtracted: null,
		});
		return { success: false, amountAtomic: 0, errorMsg, skipped: false, note: `forge ${category} fetch_failed` };
	}

	// Only extract + persist when the call actually produced a generation. A 402
	// rejection / cap-skip / HTTP error still gets a recorded log row below.
	let value = null;
	if (result.success) {
		value = await persistProp({
			runId, prompt, category,
			response: result.responseBody,
			txSig: result.txSig || null,
			payer: buyer?.publicKey?.toBase58?.() || null,
			amountAtomic: result.paid ? result.amountAtomic : 0,
		});
	}

	await recordCall(runId, {
		endpointUrl,
		amountAtomic: result.amountAtomic,
		txSig: result.txSig,
		// Keep the response lean: the prop row in forge_autonomous_props holds the
		// durable detail; log just the call status and key job pointers.
		responseData: result.responseBody
			? { status: result.responseBody.status, job_id: result.responseBody.job_id || null, glb_url: result.responseBody.glb_url || null, backend: result.responseBody.backend || null }
			: { status: result.status },
		durationMs: Date.now() - t0,
		success: result.success,
		errorMsg: result.errorMsg,
		valueExtracted: value,
	});

	log.info('forge_content_complete', {
		run_id: runId,
		category,
		paid: result.paid,
		status: result.responseBody?.status || result.status,
		novelty: value?.novelty,
		cluster_id: value?.cluster_id,
		spent_usdc: (result.amountAtomic / 1e6).toFixed(4),
	});

	// Aggregate outcome for the loop's single summary row. signalData mirrors the
	// compact prop summary so the loop's row is useful on its own too.
	return {
		success: result.success,
		amountAtomic: result.paid ? result.amountAtomic : 0,
		txSig: result.txSig,
		errorMsg: result.errorMsg,
		skipped: result.skipped ?? false,
		responseData: { category, status: result.responseBody?.status || result.status, stored: value?.stored ?? false },
		signalData: value
			? { category: value.category, status: value.status, novelty: value.novelty, cluster_id: value.cluster_id, glb_url: value.glb_url, job_id: value.job_id }
			: null,
		note: `forge ${category} ${value?.status || result.status}${value?.novelty != null ? ` novelty=${value.novelty}` : ''}`,
	};
}
