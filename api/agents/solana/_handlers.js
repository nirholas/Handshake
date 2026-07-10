// Consolidated public Solana agent handlers.
// Reached via api/agents/solana/[action].js dispatcher.
// Named exports (taskHash, buildPayload, verifyPumpkitSignature) are kept
// for backward-compat with the test suite.

import crypto from 'node:crypto';
import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';
import { solanaConnection, solanaRpcEndpoints, isEndpointCooling } from '../../_lib/solana/connection.js';
import { sql } from '../../_lib/db.js';
import { cors, json, method, wrap, error, readJson, rateLimited, serverError, respondError } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { getSessionUser } from '../../_lib/auth.js';
import { parse } from '../../_lib/validate.js';
import { randomToken } from '../../_lib/crypto.js';
import { env } from '../../_lib/env.js';
import { publicUrl, thumbnailUrl } from '../../_lib/r2.js';
import { buildAgentManifest, buildAgentOnchainAttributes, agentRoyaltyConfig, skillCollectionSymbol, THREE_WS } from '../../_lib/three-brand.js';
import {
	getAgentCollection,
	loadCollectionAuthorityKeypair,
	collectionAuthoritySigner,
	AGENT_COLLECTION,
} from '../../_lib/solana-collection.js';
import { KIND_MAP, crawlAgentAttestations } from '../../_lib/solana-attestations.js';
import {
	mintAttestation,
	loadAttesterKeypair,
	taskHash as _taskHash,
	buildPayload as _buildPayload,
} from '../../_lib/attest-event.js';

// ── Named exports preserved for tests ────────────────────────────────────────

export const taskHash = _taskHash;
export const buildPayload = _buildPayload;

const REPLAY_WINDOW_SECS = 5 * 60;
const MAX_BODY_BYTES = 64_000;

export function verifyPumpkitSignature({ secret, timestamp, signature, raw, nowSecs = Math.floor(Date.now() / 1000) }) {
	if (!secret || !timestamp || !signature) return { ok: false, reason: 'missing' };
	const ts = Number(timestamp);
	if (!Number.isFinite(ts)) return { ok: false, reason: 'bad_timestamp' };
	if (Math.abs(nowSecs - ts) > REPLAY_WINDOW_SECS) return { ok: false, reason: 'stale' };
	const expect = crypto.createHmac('sha256', secret).update(`${ts}.`).update(raw).digest();
	let got;
	try { got = Buffer.from(signature, 'hex'); } catch { return { ok: false, reason: 'bad_signature' }; }
	if (got.length !== expect.length) return { ok: false, reason: 'bad_signature' };
	return { ok: crypto.timingSafeEqual(got, expect), reason: 'ok' };
}

// ── solana-attestations ───────────────────────────────────────────────────────

export const handleAttestations = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url     = new URL(req.url, `http://${req.headers.host}`);
	const asset   = url.searchParams.get('asset');
	const kindArg = url.searchParams.get('kind') || 'all';
	const network = url.searchParams.get('network') === 'mainnet' ? 'mainnet' : 'devnet';
	const limit   = Math.min(Number(url.searchParams.get('limit') || 100), 500);
	const includeRevoked = url.searchParams.get('include_revoked') === '1';
	// One-shot on-demand reindex. The crawl cron only runs every 5 min, so a
	// visitor who just submitted feedback would otherwise wait minutes to see it.
	// `refresh=1` (already rate-limited by authIp above) pulls the latest
	// signatures for this agent before answering, closing the submit→see-it loop.
	const force = url.searchParams.get('refresh') === '1';

	if (!asset) return error(res, 400, 'validation_error', 'asset query param required');
	try { new PublicKey(asset); } catch { return error(res, 400, 'validation_error', 'invalid asset pubkey'); }

	const wantKind = kindArg === 'all' ? null : KIND_MAP[kindArg];
	if (kindArg !== 'all' && !wantKind) {
		return error(res, 400, 'validation_error', 'kind must be one of: feedback, validation, task, accept, revoke, dispute, all');
	}

	let [cursor] = await sql`select last_indexed_at from solana_attestations_cursor where agent_asset = ${asset} limit 1`;
	if (!cursor || force) {
		const [agent] = await sql`select wallet_address as owner from agent_identities where meta->>'sol_mint_address' = ${asset} and deleted_at is null limit 1`;
		try { await crawlAgentAttestations({ agentAsset: asset, network, ownerWallet: agent?.owner || null }); } catch {}
		[cursor] = await sql`select last_indexed_at from solana_attestations_cursor where agent_asset = ${asset} limit 1`;
	}

	const rows = wantKind
		? await sql`select signature, slot, block_time, attester, kind, payload, verified, revoked, disputed from solana_attestations where agent_asset = ${asset} and network = ${network} and kind = ${wantKind} and (${includeRevoked} or revoked = false) order by slot desc limit ${limit}`
		: await sql`select signature, slot, block_time, attester, kind, payload, verified, revoked, disputed from solana_attestations where agent_asset = ${asset} and network = ${network} and (${includeRevoked} or revoked = false) order by slot desc limit ${limit}`;

	return json(res, 200, { data: rows, agent: asset, network, kind: kindArg, count: rows.length, last_indexed_at: cursor?.last_indexed_at || null });
});

// ── solana-attest-event ───────────────────────────────────────────────────────

async function readBuffered(req) {
	const chunks = [];
	let total = 0;
	for await (const c of req) {
		chunks.push(c);
		total += c.length;
		if (total > MAX_BODY_BYTES) throw Object.assign(new Error('payload too large'), { status: 413 });
	}
	return Buffer.concat(chunks);
}

const attestEventSchema = z.object({
	event_id:    z.string().min(1).max(128),
	event_type:  z.enum(['graduation', 'fee_claim', 'whale_trade', 'cto_detected']),
	agent_asset: z.string().min(32).max(44),
	network:     z.enum(['mainnet', 'devnet']),
	token_mint:  z.string().min(32).max(44),
	task_id:     z.string().min(1).max(128),
	detail:      z.record(z.unknown()).optional(),
});

export const handleAttestEvent = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const startedAt = Date.now();
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const secret = process.env.PUMPKIT_WEBHOOK_SECRET;
	if (!secret) return error(res, 500, 'internal', 'webhook secret not configured');

	const raw = await readBuffered(req);
	const verdict = verifyPumpkitSignature({
		secret,
		timestamp: req.headers['x-pumpkit-timestamp'],
		signature: req.headers['x-pumpkit-signature'],
		raw,
	});
	if (!verdict.ok) return error(res, 401, 'unauthorized', `invalid webhook signature (${verdict.reason})`);

	let parsed;
	try { parsed = JSON.parse(raw.toString('utf8')); } catch { return error(res, 400, 'validation_error', 'invalid JSON'); }
	const body = parse(attestEventSchema, parsed);

	const [agent] = await sql`select id, user_id from agent_identities where meta->'onchain'->>'sol_asset' = ${body.agent_asset} or meta->>'sol_mint_address' = ${body.agent_asset} limit 1`;
	if (!agent) return error(res, 404, 'not_found', 'agent_asset not registered');

	const result = await mintAttestation({
		event_id:    body.event_id,
		event_type:  body.event_type,
		source:      `pumpkit.${body.event_type === 'cto_detected' ? 'cto' : body.event_type === 'whale_trade' ? 'whale' : body.event_type}`,
		agent_asset: body.agent_asset,
		network:     body.network,
		token_mint:  body.token_mint,
		task_id:     body.task_id,
		detail:      body.detail,
		attester:    loadAttesterKeypair(),
	});

	const baseLog = { userId: agent.user_id, agentId: agent.id, kind: 'attest_event', tool: `pumpkit.${body.event_type}`, latencyMs: Date.now() - startedAt, meta: { network: body.network, event_id: body.event_id, signature: result.signature } };
	const { recordEvent } = await import('../../_lib/usage.js');

	if (result.status === 'minted') {
		recordEvent({ ...baseLog, status: 'ok', meta: { ...baseLog.meta, kind: result.kind } });
		return json(res, 201, { data: { signature: result.signature, kind: result.kind, deduped: false } });
	}
	if (result.status === 'deduped') {
		recordEvent({ ...baseLog, status: 'deduped' });
		return json(res, 200, { data: { signature: result.signature, deduped: true } });
	}
	recordEvent({ ...baseLog, status: 'in_progress' });
	return json(res, 202, { data: { deduped: true, status: 'in_progress' } });
});

// ── solana-validate (write: glTF/schema validation attestation) ────────────────

import { attestValidationSolana, SolanaAttestError } from '../../_lib/solana-validation-attest.js';
import { SUBKIND_GLB_SCHEMA } from '../../_lib/solana-attestations.js';

const SOLANA_ATTEST_ERROR_STATUS = {
	unsupported_network: 400,
	invalid_asset: 400,
	invalid_glb_url: 400,
	glb_fetch_failed: 502,
	glb_too_large: 413,
	attester_key_not_configured: 500,
	record_failed: 502,
};

const validateSchema = z.object({
	asset_pubkey: z.string().min(32).max(44),
	network:      z.enum(['mainnet', 'devnet']).default('mainnet'),
	glb_url:      z.string().url().optional(),
});

export const handleValidate = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(validateSchema, await readJson(req));
	const { asset_pubkey, network } = body;
	try { new PublicKey(asset_pubkey); } catch { return error(res, 400, 'validation_error', 'invalid asset pubkey'); }

	// Ownership: the agent must belong to the signed-in user (mirrors handleEdit).
	const [agent] = await sql`select id, avatar_id from agent_identities where (meta->>'sol_mint_address') = ${asset_pubkey} and user_id = ${user.id} and deleted_at is null limit 1`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found for your account');

	// Resolve the GLB to validate: explicit glb_url wins; otherwise the agent's
	// avatar GLB. validateGlb SSRF-guards whatever URL we pass.
	let glbUrl = body.glb_url || null;
	if (!glbUrl && agent.avatar_id) {
		const [av] = await sql`select storage_key from avatars where id = ${agent.avatar_id} and deleted_at is null limit 1`;
		if (av?.storage_key) glbUrl = publicUrl(av.storage_key);
	}
	if (!glbUrl) return error(res, 422, 'no_model', 'agent has no GLB to validate — attach an avatar or pass glb_url');

	let result;
	try {
		result = await attestValidationSolana({
			network,
			agentAsset: asset_pubkey,
			glbUrl,
			validatedAt: new Date().toISOString(),
		});
	} catch (e) {
		if (e instanceof SolanaAttestError) {
			const status = SOLANA_ATTEST_ERROR_STATUS[e.code] || 500;
			if (status >= 500) console.error('[agents/solana] attest failed', e.code, e?.message);
			return respondError(res, status, e.code, e);
		}
		throw e;
	}

	const { recordEvent } = await import('../../_lib/usage.js');
	recordEvent({
		userId: user.id, agentId: agent.id, kind: 'solana_validation', tool: 'glb-schema',
		status: 'ok', meta: { network, signature: result.signature, passed: result.passed, deduped: result.status === 'deduped' },
	});

	return json(res, result.status === 'deduped' ? 200 : 201, {
		ok: true,
		passed: result.passed,
		signature: result.signature,
		proof_hash: result.proofHash,
		proof_uri: result.proofUri,
		model_sha256: result.modelSha256,
		kind: result.kind,
		subkind: SUBKIND_GLB_SCHEMA,
		validator: result.validator,
		network,
		asset_pubkey,
		deduped: result.status === 'deduped',
		explorer: `https://explorer.solana.com/tx/${result.signature}${network === 'devnet' ? '?cluster=devnet' : ''}`,
	});
});

// ── solana-validation (read: latest + history of glTF/schema validations) ──────

export const handleValidation = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url     = new URL(req.url, `http://${req.headers.host}`);
	const asset   = url.searchParams.get('asset');
	const network = url.searchParams.get('network') === 'mainnet' ? 'mainnet' : 'devnet';
	const limit   = Math.min(Number(url.searchParams.get('limit') || 25), 200);
	const force   = url.searchParams.get('refresh') === '1';

	if (!asset) return error(res, 400, 'validation_error', 'asset query param required');
	try { new PublicKey(asset); } catch { return error(res, 400, 'validation_error', 'invalid asset pubkey'); }

	// Refresh-on-demand so a just-recorded validation is visible immediately.
	let [cursor] = await sql`select last_indexed_at from solana_attestations_cursor where agent_asset = ${asset} limit 1`;
	if (!cursor || force) {
		const [a] = await sql`select wallet_address as owner from agent_identities where meta->>'sol_mint_address' = ${asset} and deleted_at is null limit 1`;
		try { await crawlAgentAttestations({ agentAsset: asset, network, ownerWallet: a?.owner || null }); } catch {}
		[cursor] = await sql`select last_indexed_at from solana_attestations_cursor where agent_asset = ${asset} limit 1`;
	}

	const rows = await sql`
		select signature, slot, block_time, attester, payload, verified, revoked, disputed
		from solana_attestations
		where agent_asset = ${asset} and network = ${network}
		  and kind = 'threews.validation.v1'
		  and payload->>'subkind' = ${SUBKIND_GLB_SCHEMA}
		  and revoked = false
		order by slot desc nulls first, block_time desc
		limit ${limit}
	`;

	const history = rows.map((r) => ({
		signature: r.signature,
		slot: r.slot,
		block_time: r.block_time,
		validator: r.attester,
		passed: r.payload?.passed === true,
		proof_hash: r.payload?.proof_hash || null,
		proof_uri: r.payload?.proof_uri || null,
		model_sha256: r.payload?.model_sha256 || null,
		verified: r.verified,
		disputed: r.disputed,
		explorer: `https://explorer.solana.com/tx/${r.signature}${network === 'devnet' ? '?cluster=devnet' : ''}`,
	}));

	return json(res, 200, {
		agent: asset,
		network,
		kind: SUBKIND_GLB_SCHEMA,
		latest: history[0] || null,
		count: history.length,
		history,
		last_indexed_at: cursor?.last_indexed_at || null,
	}, { 'cache-control': 'public, max-age=30', 'access-control-allow-origin': '*' });
});

// ── solana-metadata ──────────────────────────────────────────────────────────

export const handleMetadata = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const url     = new URL(req.url, `http://${req.headers.host}`);
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	let   asset   = url.searchParams.get('asset');
	if (asset) { try { new PublicKey(asset); } catch { asset = null; } }

	// Defaults come from the query (mint-time, agent not yet in the DB). Once the
	// agent is registered + confirmed, we serve its live name/skills/avatar.
	let name        = url.searchParams.get('name') || 'Agent';
	let description = url.searchParams.get('desc') || '';
	let skills      = [];
	let ownerAddress = null;
	let avatarId    = null;
	let image;          // real avatar thumbnail (PNG) when available
	let animationUrl;   // real avatar GLB when available

	if (asset) {
		const [a] = await sql`select name, description, skills, wallet_address as owner, avatar_id from agent_identities where meta->>'sol_mint_address' = ${asset} and deleted_at is null limit 1`;
		if (a) {
			name         = a.name || name;
			description  = a.description || description;
			skills       = a.skills || [];
			ownerAddress = a.owner || null;
			avatarId     = a.avatar_id || null;
			if (a.avatar_id) {
				const [av] = await sql`select storage_key, thumbnail_key from avatars where id = ${a.avatar_id} and deleted_at is null limit 1`;
				image = thumbnailUrl(av?.thumbnail_key) || image;
				if (av?.storage_key) animationUrl = publicUrl(av.storage_key);
			}
		}
	}

	// Prep bakes the resolved avatar media into the mint URI (img/anim) so the
	// manifest is complete on the FIRST fetch — before the agent row above
	// exists. The live DB values (when present) win; these are the fallback.
	// Only http(s)/ipfs URLs are honoured: they are echoed into JSON, never
	// fetched server-side, so this can't be turned into an SSRF vector.
	const SAFE_MEDIA = /^(https?:|ipfs:)/i;
	if (!image) { const q = url.searchParams.get('img'); if (q && SAFE_MEDIA.test(q)) image = q; }
	if (!animationUrl) { const q = url.searchParams.get('anim'); if (q && SAFE_MEDIA.test(q)) animationUrl = q; }

	const manifest = buildAgentManifest({
		name,
		description,
		image,
		animationUrl,
		externalUrl: asset ? `${env.APP_ORIGIN}/agent-passport.html?asset=${asset}&network=${network}` : undefined,
		avatarId,
		skills,
		ownerAddress,
	});

	return json(res, 200, manifest, { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' });
});

// ── solana-card ───────────────────────────────────────────────────────────────

export const handleCard = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, `http://${req.headers.host}`);
	const asset = url.searchParams.get('asset');
	if (!asset) return error(res, 400, 'validation_error', 'asset required');
	try { new PublicKey(asset); } catch { return error(res, 400, 'validation_error', 'invalid asset pubkey'); }

	const [a] = await sql`select id, name, description, skills, wallet_address as owner, meta, avatar_id from agent_identities where meta->>'sol_mint_address' = ${asset} and deleted_at is null limit 1`;
	if (!a) return error(res, 404, 'not_found', 'agent not found');

	const network = a.meta?.network || 'mainnet';
	const origin = env.APP_ORIGIN;

	// Sections sourced from independent reads below. A read that throws on a
	// transient DB error is recorded here so the response can tell the client
	// "temporarily unavailable" apart from a genuine "no data" (null), instead of
	// silently conflating the two.
	const degraded = [];

	let pumpfun = null;
	try {
		const rows = await sql`select kind, count(*)::int as n, max(seen_at) as last_seen from pumpfun_signals where agent_asset = ${asset} group by kind`;
		if (rows.length > 0) {
			const byKind = {};
			let total = 0, last = null;
			for (const r of rows) {
				byKind[r.kind] = { count: r.n, last_seen: r.last_seen };
				total += r.n;
				if (!last || (r.last_seen && r.last_seen > last)) last = r.last_seen;
			}
			pumpfun = { signal_count: total, by_kind: byKind, last_seen: last, feed_url: `${origin}/api/agents/pumpfun-feed` };
		}
	} catch (err) {
		degraded.push('pumpfun');
		console.warn('[agent-card] pumpfun signals read failed:', err?.message || err);
	}

	let token_stats = null;
	try {
		const [s] = await sql`select s.graduated, s.bonding_curve, s.amm, s.last_signature, s.last_signature_at, s.recent_tx_count, s.refreshed_at, m.mint, m.network from pump_agent_stats s join pump_agent_mints m on m.id = s.mint_id where m.mint = ${asset} limit 1`;
		if (s) token_stats = { mint: s.mint, network: s.network, graduated: s.graduated, bonding_curve: s.bonding_curve, amm: s.amm, last_signature: s.last_signature, last_signature_at: s.last_signature_at, recent_tx_count: s.recent_tx_count, refreshed_at: s.refreshed_at };
	} catch (err) {
		degraded.push('token_stats');
		console.warn('[agent-card] token_stats read failed:', err?.message || err);
	}

	let validation = null;
	try {
		const [v] = await sql`select signature, attester, payload, block_time from solana_attestations where agent_asset = ${asset} and network = ${network} and kind = 'threews.validation.v1' and payload->>'subkind' = ${SUBKIND_GLB_SCHEMA} and revoked = false order by slot desc nulls first, block_time desc limit 1`;
		if (v) validation = { passed: v.payload?.passed === true, proof_hash: v.payload?.proof_hash || null, proof_uri: v.payload?.proof_uri || null, validator: v.attester, signature: v.signature, validated_at: v.block_time };
	} catch (err) {
		degraded.push('validation');
		console.warn('[agent-card] validation read failed:', err?.message || err);
	}

	return json(res, 200, {
		schema_version: '1.0',
		name: a.name,
		description: a.description,
		capabilities: {
			extensions: [
				{
					uri: 'https://github.com/google-a2a/a2a-x402/v0.1',
					description: 'Supports payments using the x402 protocol for on-chain settlement.',
					required: true,
				},
			],
		},
		identity: {
			chain: 'solana', network, asset_pubkey: asset, owner: a.owner,
			passport_url: `${origin}/agent-passport.html?asset=${asset}&network=${network}`,
			...(a.meta?.vanity_prefix ? { vanity_prefix: a.meta.vanity_prefix } : {}),
			...(a.meta?.solana_address ? { operator_wallet: { address: a.meta.solana_address, ...(a.meta.solana_vanity_prefix ? { vanity_prefix: a.meta.solana_vanity_prefix } : {}), ...(a.meta.solana_wallet_source ? { source: a.meta.solana_wallet_source } : {}) } } : {}),
		},
		skills: a.skills || [],
		endpoints: {
			chat: `${origin}/api/agents/${a.id}/chat`,
			a2a_paid: `${origin}/api/agents/a2a-paid`,
			attestations: `${origin}/api/agents/solana-attestations?asset=${asset}&network=${network}`,
			reputation: `${origin}/api/agents/solana-reputation?asset=${asset}&network=${network}`,
			validation: `${origin}/api/agents/solana-validation?asset=${asset}&network=${network}`,
			...(token_stats ? { quote: `${origin}/api/pump/quote?mint=${asset}&network=${network}`, price_history: `${origin}/api/agents/solana-price-history?asset=${asset}&network=${network}` } : {}),
		},
		attestation: {
			schemas_url: `${origin}/.well-known/agent-attestation-schemas`,
			transport: 'spl-memo',
			memo_program: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
			usage: 'Sign an SPL Memo tx with one of the published schemas as JSON, including this asset_pubkey as a non-signer key.',
		},
		...(validation ? { validation } : {}),
		...(pumpfun ? { pumpfun } : {}),
		...(token_stats ? { token_stats } : {}),
		...(degraded.length ? { degraded } : {}),
	}, { 'cache-control': degraded.length ? 'no-store' : 'public, max-age=120', 'access-control-allow-origin': '*' });
});

// ── solana-price-history ──────────────────────────────────────────────────────

export const handlePriceHistory = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, `http://${req.headers.host}`);
	const asset = url.searchParams.get('asset');
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	const hours = Math.max(1, Math.min(720, Number(url.searchParams.get('hours') || 24)));
	if (!asset) return error(res, 400, 'validation_error', 'asset required');

	const [mintRow] = await sql`select id from pump_agent_mints where mint=${asset} and network=${network} limit 1`;
	if (!mintRow) return error(res, 404, 'not_found', 'mint not tracked');

	const points = await sql`select ts, sol_per_token, market_cap_lamports, source from pump_agent_price_points where mint_id=${mintRow.id} and ts > now() - (${hours} || ' hours')::interval order by ts asc`;

	return json(res, 200, {
		mint: asset, network, hours, point_count: points.length,
		points: points.map((p) => ({ ts: p.ts, sol_per_token: p.sol_per_token, market_cap_lamports: p.market_cap_lamports?.toString?.() ?? p.market_cap_lamports, source: p.source })),
	}, { 'cache-control': 'public, max-age=60', 'access-control-allow-origin': '*' });
});

// ── solana-register-prep ──────────────────────────────────────────────────────

import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplCore, create, ruleSet, updatePlugin, update, fetchAsset, fetchCollection } from '@metaplex-foundation/mpl-core';
import { generateSigner, publicKey as umiPublicKey, signerIdentity, createNoopSigner } from '@metaplex-foundation/umi';
import bs58 from 'bs58';
import { limits as _limits } from '../../_lib/rate-limit.js';
import { mplAgentIdentity, getAgentIdentityV2AccountDataSerializer, findAgentIdentityV1Pda } from '@metaplex-foundation/mpl-agent-registry';

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const VANITY_FREE_THRESHOLD = 5;

const registerPrepSchema = z.object({
	name:           z.string().trim().min(1).max(60),
	description:    z.string().trim().max(280).default(''),
	avatar_id:      z.string().uuid().optional(),
	wallet_address: z.string().min(32).max(44),
	metadata_uri:   z.string().url().optional(),
	network:        z.enum(['mainnet', 'devnet']).default('mainnet'),
	asset_pubkey:   z.string().min(32).max(44).optional(),
	vanity_prefix:  z.string().min(1).max(6).optional(),
});

export const handleRegisterPrep = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(registerPrepSchema, await readJson(req));
	const { name, description, avatar_id, wallet_address, network, asset_pubkey, vanity_prefix } = body;

	const [walletRow] = await sql`select id from user_wallets where user_id = ${user.id} and address = ${wallet_address} and chain_type = 'solana' limit 1`;
	if (!walletRow) return error(res, 403, 'forbidden', 'wallet not linked to your account');

	// Resolve the avatar's media up front so it can be baked into the metadata
	// URI as query-param fallbacks (img/anim). This makes the off-chain JSON
	// complete from the very FIRST indexer fetch — before solana-register-confirm
	// writes the agent row that handleMetadata normally joins against — closing
	// the race where a DAS provider caches a body-less, image-less manifest.
	let avatarImg = null;
	let avatarAnim = null;
	if (avatar_id) {
		const [av] = await sql`select id, storage_key, thumbnail_key from avatars where id=${avatar_id} and owner_id=${user.id} and deleted_at is null limit 1`;
		if (!av) return error(res, 404, 'not_found', 'avatar not found');
		avatarImg = thumbnailUrl(av.thumbnail_key) || avatarImg;
		if (av.storage_key) avatarAnim = publicUrl(av.storage_key);
	}

	if (vanity_prefix && !asset_pubkey) return error(res, 400, 'validation_error', 'vanity_prefix requires asset_pubkey');
	if (asset_pubkey) {
		if (!BASE58_RE.test(asset_pubkey)) return error(res, 400, 'validation_error', 'asset_pubkey is not valid base58');
		if (vanity_prefix) {
			if (!BASE58_RE.test(vanity_prefix)) return error(res, 400, 'validation_error', 'vanity_prefix is not valid base58');
			if (!asset_pubkey.startsWith(vanity_prefix)) return error(res, 400, 'validation_error', 'asset_pubkey does not start with vanity_prefix');
			if (vanity_prefix.length >= VANITY_FREE_THRESHOLD && (user.plan ?? 'free') === 'free') {
				return error(res, 402, 'payment_required', `vanity prefixes of ${VANITY_FREE_THRESHOLD}+ characters require a paid plan`);
			}
		}
	}

	// Pick the first non-cooling endpoint from the full Helius → Alchemy → Ankr →
	// public chain. When Helius is parked in _endpointCooldown (e.g. quota 429)
	// this silently skips it rather than burning a 503 on the user.
	const rpcEndpoints = solanaRpcEndpoints(network);
	const liveEndpoint = rpcEndpoints.find((ep) => !isEndpointCooling(ep)) || rpcEndpoints[0];

	const appOrigin = env.APP_ORIGIN;

	// Resolve the asset signer up front so its pubkey can be baked into the
	// metadata URI and the on-chain attributes before the tx is built.
	// generateSigner is local crypto (no RPC), so this is safe even if the
	// configured RPC is unreachable.
	const assetSigner = asset_pubkey
		? createNoopSigner(umiPublicKey(asset_pubkey))
		: generateSigner(createUmi(liveEndpoint).use(mplCore()));
	const assetPubkey = assetSigner.publicKey;

	const passportUrl = `${appOrigin}/agent-passport.html?asset=${assetPubkey}&network=${network}`;
	const metadataUri = body.metadata_uri
		|| `${appOrigin}/api/agents/solana-metadata?asset=${assetPubkey}&network=${network}`
			+ `&name=${encodeURIComponent(name)}&desc=${encodeURIComponent(description)}`
			+ (avatarImg ? `&img=${encodeURIComponent(avatarImg)}` : '')
			+ (avatarAnim ? `&anim=${encodeURIComponent(avatarAnim)}` : '');

	// On-chain brand written into the asset account itself: three.ws identity,
	// our links, and the $THREE mint (Attributes plugin) + an enforced 5%
	// secondary-sale royalty to the owner (Royalties plugin).
	const attributeList = buildAgentOnchainAttributes({
		name,
		agentUrl: passportUrl,
		createdAt: new Date().toISOString(),
	});
	const royalty = agentRoyaltyConfig(wallet_address);
	const plugins = [
		{ type: 'Attributes', attributeList },
		...(royalty
			? [{
					type: 'Royalties',
					basisPoints: royalty.basisPoints,
					creators: royalty.creators.map((c) => ({ address: umiPublicKey(c.address), percentage: c.percentage })),
					ruleSet: ruleSet('None'),
				}]
			: []),
	];

	// If a three.ws Agent Collection is deployed for this network, mint the asset
	// INTO it so the asset's update authority resolves to the collection (held by
	// three.ws) — the authority-managed model that lets us edit on-chain metadata
	// on the owner's behalf. Adding to a collection requires the collection
	// authority to co-sign, so the server partial-signs with it; the owner still
	// pays + signs in their wallet. When no collection is configured we fall back
	// to the legacy standalone mint (owner = update authority) unchanged.
	const collectionAddr = getAgentCollection(network);
	if (collectionAddr) {
		try {
			loadCollectionAuthorityKeypair();
		} catch (e) {
			return error(res, 500, 'authority_unconfigured', e.message);
		}
	}

	const buildTx = async (rpc) => {
		// Failover Connection rather than the bare `rpc` URL: buildAndSign's
		// getLatestBlockhash rotates across the endpoint chain, so a single node's
		// malformed/empty 200 body fails over to a healthy provider instead of
		// throwing `StructError: … but received:` and failing the whole registration.
		const umi = createUmi(solanaConnection({ url: rpc, network })).use(mplCore());
		const ownerPubkey = umiPublicKey(wallet_address);
		umi.use(signerIdentity(createNoopSigner(ownerPubkey)));
		const createArgs = { asset: assetSigner, owner: ownerPubkey, name, uri: metadataUri, plugins };
		if (collectionAddr) {
			createArgs.collection = umiPublicKey(collectionAddr);
			createArgs.authority = collectionAuthoritySigner(umi);
		}
		const builder = create(umi, createArgs);
		const tx = await builder.buildAndSign(umi);
		return umi.transactions.serialize(tx);
	};

	let txBytes;
	try {
		txBytes = await buildTx(liveEndpoint);
	} catch (rpcErr) {
		console.error('[solana/register-prep] RPC error after all fallbacks:', rpcErr.message);
		return error(res, 503, 'rpc_unavailable', 'Solana RPC temporarily unavailable — try again in a moment.');
	}

	const txBase64 = Buffer.from(txBytes).toString('base64');

	const prepId = await randomToken(24);
	const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

	await sql`insert into agent_registrations_pending (user_id, cid, metadata_uri, payload, expires_at) values (${user.id}, ${assetSigner.publicKey}, ${metadataUri}, ${JSON.stringify({ name, description, avatar_id, wallet_address, asset_pubkey: assetSigner.publicKey, network, prep_id: prepId, vanity_prefix: vanity_prefix || null, collection: collectionAddr || null })}::jsonb, ${expiresAt})`;

	return json(res, 201, {
		prep_id: prepId,
		asset_pubkey: assetSigner.publicKey,
		tx_base64: txBase64,
		network,
		metadata_uri: metadataUri,
		expires_at: expiresAt.toISOString(),
		instructions: 'Sign and submit the transaction with your Solana wallet, then call /api/agents/solana-register-confirm with the tx signature.',
	});
});

// ── solana-register-confirm ───────────────────────────────────────────────────

const registerConfirmSchema = z.object({
	tx_signature:   z.string().min(80).max(100),
	asset_pubkey:   z.string().min(32).max(44),
	wallet_address: z.string().min(32).max(44),
	network:        z.enum(['mainnet', 'devnet']).default('mainnet'),
	name:           z.string().trim().min(1).max(60).optional(),
	description:    z.string().trim().max(280).optional(),
	avatar_id:      z.string().uuid().optional(),
});

export const handleRegisterConfirm = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(registerConfirmSchema, await readJson(req));
	const { tx_signature, asset_pubkey, wallet_address, network } = body;

	const [walletRow] = await sql`select id from user_wallets where user_id=${user.id} and address=${wallet_address} and chain_type='solana' limit 1`;
	if (!walletRow) return error(res, 403, 'forbidden', 'wallet not linked to your account');

	const rpcEndpoint = network === 'devnet'
		? (process.env.SOLANA_RPC_URL_DEVNET || 'https://api.devnet.solana.com')
		: (process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

	const connection = solanaConnection({ url: rpcEndpoint, commitment: 'confirmed' });
	let tx;
	try { tx = await connection.getParsedTransaction(tx_signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }); }
	catch { return error(res, 422, 'tx_not_found', 'transaction not found — try again after a few seconds'); }
	if (!tx) return error(res, 422, 'tx_not_found', 'transaction not found');
	if (tx.meta?.err) return error(res, 422, 'tx_failed', 'transaction failed on-chain');

	const accountKeys = tx.transaction.message.accountKeys.map((k) => k.pubkey?.toString());
	if (!accountKeys.includes(asset_pubkey)) return error(res, 422, 'asset_not_in_tx', 'The asset pubkey was not found in the transaction accounts');

	const [existing] = await sql`select id from agent_identities where (meta->>'sol_mint_address') = ${asset_pubkey} and deleted_at is null limit 1`;
	if (existing) return error(res, 409, 'conflict', 'agent already registered for this mint');

	const [pending] = await sql`select payload from agent_registrations_pending where user_id=${user.id} and payload->>'asset_pubkey'=${asset_pubkey} and expires_at > now() order by created_at desc limit 1`;
	const payload = pending?.payload || {};
	const name = body.name || payload.name || `Agent ${asset_pubkey.slice(0, 6)}`;
	const description = body.description || payload.description || '';
	const avatar_id = body.avatar_id || payload.avatar_id || null;

	const [agent] = await sql`insert into agent_identities (user_id, name, description, avatar_id, wallet_address, meta) values (${user.id}, ${name}, ${description}, ${avatar_id}, ${wallet_address}, ${JSON.stringify({ chain_type: 'solana', network, sol_mint_address: asset_pubkey, tx_signature, ...(payload.vanity_prefix ? { vanity_prefix: payload.vanity_prefix } : {}), ...(payload.collection ? { collection: payload.collection, update_authority: 'threews' } : {}) })}::jsonb) returning id, name, description, wallet_address, meta, created_at`;

	await sql`delete from agent_registrations_pending where user_id=${user.id} and payload->>'asset_pubkey'=${asset_pubkey}`;

	// Best-effort glTF/schema validation attestation, recorded on-chain by the
	// platform validator. Mirrors the EVM auto-validation path: a failure here
	// (missing key, RPC trouble, no avatar GLB) must never fail the registration.
	let validation = null;
	try {
		if (avatar_id) {
			const [av] = await sql`select storage_key from avatars where id = ${avatar_id} and deleted_at is null limit 1`;
			if (av?.storage_key) {
				const r = await attestValidationSolana({
					network,
					agentAsset: asset_pubkey,
					glbUrl: publicUrl(av.storage_key),
					validatedAt: new Date().toISOString(),
				});
				validation = { passed: r.passed, signature: r.signature, proof_hash: r.proofHash, deduped: r.status === 'deduped' };
			}
		}
	} catch (e) {
		validation = { error: e.code || 'validation_failed' };
	}

	return json(res, 201, { ok: true, agent: { ...agent, home_url: `${env.APP_ORIGIN}/agent/${agent.id}` }, sol_mint_address: asset_pubkey, tx_signature, network, ...(validation ? { validation } : {}) });
});

// ── solana-collection-metadata ─────────────────────────────────────────────────
// Off-chain JSON for the three.ws Agent Collection account (its `uri`). Standard
// Metaplex collection metadata so wallets/explorers render it as a real
// collection that groups every deployed three.ws agent.

export const handleCollectionMetadata = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, `http://${req.headers.host}`);
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';

	return json(
		res,
		200,
		{
			name: AGENT_COLLECTION.name,
			symbol: 'AGENT',
			description: AGENT_COLLECTION.description,
			image: THREE_WS.ogImage,
			external_url: THREE_WS.website,
			properties: {
				category: 'image',
				files: [{ uri: THREE_WS.ogImage, type: 'image/png' }],
			},
			platform: { name: THREE_WS.name, url: THREE_WS.website, x: THREE_WS.x, github: THREE_WS.github },
			network,
		},
		{ 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' },
	);
});

// ── skill-collection-metadata ───────────────────────────────────────────────
// Off-chain JSON for a per-agent skill NFT collection (the master identifier
// for every "skill ownership" NFT minted to buyers of that agent's skills).
// Pointed at by the collection's on-chain URI; see
// scripts/create-agent-collection.mjs. Resolvable by agent id so the document
// always reflects the agent's live name + avatar.

export const handleSkillCollectionMetadata = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, `http://${req.headers.host}`);
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	const agentId = url.searchParams.get('agent');
	if (!agentId || !/^[0-9a-f-]{36}$/i.test(agentId)) {
		return error(res, 400, 'validation_error', 'agent (uuid) required');
	}

	const [agent] = await sql`select name, description, avatar_id, skill_collection_mint from agent_identities where id = ${agentId} and deleted_at is null limit 1`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	let image = THREE_WS.ogImage;
	if (agent.avatar_id) {
		const [av] = await sql`select thumbnail_key from avatars where id = ${agent.avatar_id} and deleted_at is null limit 1`;
		image = thumbnailUrl(av?.thumbnail_key) || image;
	}

	const name = `${agent.name} — Skills`;
	const description =
		`Verifiable on-chain ownership of skills offered by ${agent.name} on ${THREE_WS.name}. ` +
		`Each NFT in this collection certifies that its holder has purchased the named skill from this agent.`;

	return json(
		res,
		200,
		{
			name,
			symbol: skillCollectionSymbol(agent.name),
			description,
			image,
			external_url: `${env.APP_ORIGIN}/agents/${agentId}`,
			properties: {
				category: 'image',
				files: [{ uri: image, type: 'image/png' }],
			},
			platform: { name: THREE_WS.name, url: THREE_WS.website, x: THREE_WS.x, github: THREE_WS.github },
			agent_id: agentId,
			collection_mint: agent.skill_collection_mint || null,
			network,
		},
		{ 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' },
	);
});

// ── skill-nft-metadata ──────────────────────────────────────────────────────
// Off-chain JSON for an individual "skill ownership" NFT minted to a buyer. The
// asset's on-chain URI points here; see api/_lib/skill-nft.js. Resolvable by
// (agent, skill) so the document always reflects the agent's live name + avatar.

export const handleSkillNftMetadata = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, `http://${req.headers.host}`);
	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	const agentId = url.searchParams.get('agent');
	const skill = (url.searchParams.get('skill') || '').trim().slice(0, 100);
	if (!agentId || !/^[0-9a-f-]{36}$/i.test(agentId)) {
		return error(res, 400, 'validation_error', 'agent (uuid) required');
	}
	if (!skill) return error(res, 400, 'validation_error', 'skill required');

	const [agent] = await sql`select name, avatar_id, skill_collection_mint from agent_identities where id = ${agentId} and deleted_at is null limit 1`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	let image = THREE_WS.ogImage;
	if (agent.avatar_id) {
		const [av] = await sql`select thumbnail_key from avatars where id = ${agent.avatar_id} and deleted_at is null limit 1`;
		image = thumbnailUrl(av?.thumbnail_key) || image;
	}

	const name = `${agent.name}: ${skill}`;
	const description =
		`On-chain proof of ownership and a perpetual license for the “${skill}” skill ` +
		`offered by ${agent.name} on ${THREE_WS.name}. Holding this NFT certifies the wallet ` +
		`purchased this skill and may invoke it.`;

	return json(
		res,
		200,
		{
			name,
			symbol: skillCollectionSymbol(agent.name),
			description,
			image,
			external_url: `${env.APP_ORIGIN}/agents/${agentId}`,
			attributes: [
				{ trait_type: 'Type', value: 'Skill License' },
				{ trait_type: 'Agent', value: agent.name },
				{ trait_type: 'Skill', value: skill },
				{ trait_type: 'Platform', value: THREE_WS.name },
			],
			properties: {
				category: 'image',
				files: [{ uri: image, type: 'image/png' }],
			},
			platform: { name: THREE_WS.name, url: THREE_WS.website, x: THREE_WS.x, github: THREE_WS.github },
			agent_id: agentId,
			skill,
			collection_mint: agent.skill_collection_mint || null,
			network,
		},
		{ 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' },
	);
});

// ── solana-edit ───────────────────────────────────────────────────────────────
// Authority-managed edit of a deployed agent's ON-CHAIN metadata. The user owns
// the asset, but three.ws holds the collection update authority, so edits to the
// Attributes plugin (and the asset name) are signed + paid server-side by the
// three.ws authority — no owner-wallet round-trip. Only agents minted into the
// three.ws collection (meta.update_authority='threews') are editable this way;
// legacy standalone (owner-managed) assets are rejected with a clear message.

const editSchema = z
	.object({
		asset_pubkey: z.string().min(32).max(44),
		network:      z.enum(['mainnet', 'devnet']).default('mainnet'),
		name:         z.string().trim().min(1).max(60).optional(),
		description:  z.string().trim().max(280).optional(),
		skills:       z.array(z.string().regex(/^[a-z0-9-]{1,40}$/i)).max(16).optional(),
		avatar_id:    z.string().uuid().nullable().optional(),
	})
	.refine(
		(b) => b.name !== undefined || b.description !== undefined || b.skills !== undefined || b.avatar_id !== undefined,
		{ message: 'at least one editable field is required' },
	);

const base58Sig = (sig) => bs58.encode(sig);

export const handleEdit = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = parse(editSchema, await readJson(req));
	const { asset_pubkey, network } = body;
	try { new PublicKey(asset_pubkey); } catch { return error(res, 400, 'validation_error', 'invalid asset pubkey'); }

	// Ownership: the agent must belong to the signed-in user.
	const [agent] = await sql`select id, name, description, avatar_id, wallet_address, meta from agent_identities where (meta->>'sol_mint_address') = ${asset_pubkey} and user_id = ${user.id} and deleted_at is null limit 1`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found for your account');

	const collectionAddr = agent.meta?.collection || null;
	if (!collectionAddr || agent.meta?.update_authority !== 'threews') {
		return error(res, 409, 'not_authority_managed', 'this agent is owner-managed (minted before the three.ws collection); on-chain edits must be signed by the owner wallet');
	}

	if (body.avatar_id) {
		const [av] = await sql`select id from avatars where id=${body.avatar_id} and owner_id=${user.id} and deleted_at is null limit 1`;
		if (!av) return error(res, 404, 'not_found', 'avatar not found');
	}

	// Merge requested edits over current DB values. Skills are stored on-chain in
	// the Attributes plugin (and in the off-chain manifest), not as an
	// agent_identities column, so they are not written to the DB here.
	const next = {
		name: body.name ?? agent.name,
		description: body.description ?? agent.description,
		avatar_id: body.avatar_id === undefined ? agent.avatar_id : body.avatar_id,
	};

	const rpc = network === 'devnet'
		? (process.env.SOLANA_RPC_URL_DEVNET || 'https://api.devnet.solana.com')
		: (process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

	let umi;
	try {
		// Failover Connection rather than the bare `rpc` URL: every on-chain read
		// (fetchAsset/fetchCollection) and write (sendAndConfirm → getLatestBlockhash)
		// below rotates across the endpoint chain, so a single node's malformed/empty
		// 200 body fails over to a healthy provider instead of throwing
		// `StructError: … but received:` and failing the whole edit.
		umi = createUmi(solanaConnection({ url: rpc, network })).use(mplCore());
		umi.use(signerIdentity(collectionAuthoritySigner(umi)));
	} catch (e) {
		console.error('[agents/solana] authority/umi init failed', e?.message);
		return serverError(res, 500, 'authority_unconfigured', e);
	}

	const assetPk = umiPublicKey(asset_pubkey);
	const collectionPk = umiPublicKey(collectionAddr);
	const passportUrl = `${env.APP_ORIGIN}/agent-passport.html?asset=${asset_pubkey}&network=${network}`;

	// Only name/skills live in the on-chain Attributes plugin (and name in the
	// asset's name field). Description/avatar are served dynamically from the
	// metadata endpoint via the asset URI, so they need no on-chain write.
	const nameChanged = body.name !== undefined && body.name !== agent.name;
	const skillsChanged = body.skills !== undefined;

	const signatures = {};
	if (nameChanged || skillsChanged) {
		try {
			// Read current on-chain attributes so unedited fields (skills, the
			// original created timestamp) are preserved rather than dropped.
			const onchainAsset = await fetchAsset(umi, assetPk);
			const existingAttrs = onchainAsset.attributes?.attributeList || [];
			const attrMap = new Map(existingAttrs.map((a) => [a.key, a.value]));
			const existingSkills = attrMap.get('skills')
				? String(attrMap.get('skills')).split(',').filter(Boolean)
				: [];

			const attributeList = buildAgentOnchainAttributes({
				name: next.name,
				agentUrl: passportUrl,
				skills: body.skills ?? existingSkills,
				createdAt: attrMap.get('created') || undefined,
			});
			const attrRes = await updatePlugin(umi, {
				asset: assetPk,
				collection: collectionPk,
				plugin: { type: 'Attributes', attributeList },
			}).sendAndConfirm(umi, { confirm: { commitment: 'confirmed' } });
			signatures.attributes = base58Sig(attrRes.signature);

			// If the display name changed, update the asset's on-chain name too.
			if (nameChanged) {
				const onchainCollection = await fetchCollection(umi, collectionPk);
				const nameRes = await update(umi, {
					asset: onchainAsset,
					collection: onchainCollection,
					name: next.name,
				}).sendAndConfirm(umi, { confirm: { commitment: 'confirmed' } });
				signatures.name = base58Sig(nameRes.signature);
			}
		} catch (e) {
			console.error('[agents/solana] on-chain edit failed', e?.message || e);
			return serverError(res, 502, 'onchain_edit_failed', e);
		}
	}

	// Keep the off-chain row in sync (name/description/avatar are real columns).
	const [updated] = await sql`update agent_identities set name=${next.name}, description=${next.description}, avatar_id=${next.avatar_id}, updated_at=now() where id=${agent.id} returning id, name, description, avatar_id, wallet_address, meta, updated_at`;

	return json(res, 200, {
		ok: true,
		agent: { ...updated, home_url: `${env.APP_ORIGIN}/agent/${updated.id}` },
		asset_pubkey,
		network,
		signatures,
	});
});

// ── solana-reputation ─────────────────────────────────────────────────────────

export const handleReputation = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host}`);
	const asset = url.searchParams.get('asset');
	const network = url.searchParams.get('network') === 'mainnet' ? 'mainnet' : 'devnet';

	if (!asset) return error(res, 400, 'validation_error', 'asset query param required');
	try { new PublicKey(asset); } catch { return error(res, 400, 'validation_error', 'invalid asset pubkey'); }

	const [fb] = await sql`
		with feedback as (
			select f.signature, f.attester, f.disputed, f.revoked,
				(f.payload->>'score')::int as score, f.payload->>'task_id' as task_id,
				exists (select 1 from solana_attestations a where a.agent_asset = f.agent_asset and a.kind = 'threews.accept.v1' and a.payload->>'task_id' = f.payload->>'task_id' and a.verified = true and f.payload->>'task_id' is not null) as task_accepted,
				exists (select 1 from solana_credentials c where c.subject = f.attester and c.network = f.network and c.kind = 'threews.verified-client.v1' and c.closed = false and (c.expiry is null or c.expiry > now())) as credentialed,
				(f.payload->>'source' like 'pumpkit.%' or f.payload->>'source' like 'pumpfun.%') as event_attested
			from solana_attestations f where f.agent_asset = ${asset} and f.network = ${network} and f.kind = 'threews.feedback.v1' and f.revoked = false
		),
		per_attester as (select attester, avg(score)::float as score_avg, bool_or(task_accepted) as any_verified, bool_or(credentialed) as any_credentialed, bool_or(event_attested) as any_event_attested from feedback group by attester)
		select
			(select count(*)::int from feedback) as total,
			(select count(*) filter (where task_accepted)::int from feedback) as verified,
			(select count(*) filter (where credentialed)::int from feedback) as credentialed,
			(select count(*) filter (where event_attested)::int from feedback) as event_attested,
			(select count(*) filter (where disputed)::int from feedback) as disputed,
			(select coalesce(avg(score), 0)::float from feedback) as score_avg,
			(select coalesce(avg(score) filter (where task_accepted), 0)::float from feedback) as score_avg_verified,
			(select coalesce(avg(score) filter (where credentialed), 0)::float from feedback) as score_avg_credentialed,
			(select coalesce(avg(score) filter (where event_attested), 0)::float from feedback) as score_avg_event_attested,
			(select count(*)::int from per_attester) as unique_attesters,
			(select count(*) filter (where any_verified)::int from per_attester) as unique_verified_attesters,
			(select count(*) filter (where any_credentialed)::int from per_attester) as unique_credentialed_attesters,
			(select coalesce(avg(score_avg), 0)::float from per_attester) as score_avg_weighted,
			(select coalesce(avg(score_avg) filter (where any_verified), 0)::float from per_attester) as score_avg_weighted_verified,
			(select coalesce(avg(score_avg) filter (where any_credentialed), 0)::float from per_attester) as score_avg_weighted_credentialed
	`;

	const [val] = await sql`select count(*) filter (where (payload->>'passed')::bool)::int as passed, count(*) filter (where not (payload->>'passed')::bool)::int as failed, count(*) filter (where (payload->>'passed')::bool and (payload->>'source' like 'pumpkit.%' or payload->>'source' like 'pumpfun.%'))::int as event_passed, count(*) filter (where not (payload->>'passed')::bool and (payload->>'source' like 'pumpkit.%' or payload->>'source' like 'pumpfun.%'))::int as event_failed from solana_attestations where agent_asset = ${asset} and network = ${network} and kind = 'threews.validation.v1' and revoked = false`;

	const [auditedVal] = await sql`select count(*) filter (where (data->>'passed')::bool)::int as passed, count(*) filter (where not (data->>'passed')::bool)::int as failed from solana_credentials where subject = ${asset} and network = ${network} and kind = 'threews.audited-validation.v1' and closed = false and (expiry is null or expiry > now())`;

	const [counts] = await sql`select count(*) filter (where kind = 'threews.task.v1')::int as tasks_offered, count(*) filter (where kind = 'threews.accept.v1' and verified)::int as tasks_accepted, count(*) filter (where kind = 'threews.dispute.v1' and verified)::int as disputes_filed, count(*) filter (where revoked)::int as revoked_count from solana_attestations where agent_asset = ${asset} and network = ${network}`;

	const [cursor] = await sql`select last_indexed_at from solana_attestations_cursor where agent_asset = ${asset} limit 1`;

	const [stakeAgg] = await sql`
		select
			coalesce(sum((payload->>'lamports')::numeric), 0)::text as total_lamports,
			count(*)::int as stake_count,
			count(distinct attester)::int as unique_stakers
		from solana_attestations
		where agent_asset = ${asset} and network = ${network}
		  and kind = 'threews.stake.v1' and verified = true and revoked = false
	`;

	const topStakers = await sql`
		select attester,
			sum((payload->>'lamports')::numeric)::text as lamports,
			max((payload->>'score')::int) as score
		from solana_attestations
		where agent_asset = ${asset} and network = ${network}
		  and kind = 'threews.stake.v1' and verified = true and revoked = false
		group by attester
		order by sum((payload->>'lamports')::numeric) desc
		limit 5
	`;

	let pumpfunRows = [];
	try {
		pumpfunRows = await sql`select kind, count(*)::int as n, coalesce(sum(weight), 0)::float as w from pumpfun_signals where agent_asset = ${asset} group by kind`;
	} catch {}
	const pumpfunByKind = {};
	let pumpfunTotal = 0, pumpfunWeight = 0;
	for (const r of pumpfunRows) {
		pumpfunByKind[r.kind] = { count: r.n, weight: Number(r.w.toFixed(3)) };
		pumpfunTotal += r.n; pumpfunWeight += r.w;
	}

	const [actRow] = await sql`select s.graduated, s.recent_tx_count, (select count(*)::int from pump_agent_trades t where t.mint_id = m.id) as trade_count from pump_agent_stats s join pump_agent_mints m on m.id = s.mint_id where m.mint = ${asset} and m.network = ${network} limit 1`;
	const tokenActivity = actRow ? { graduated: !!actRow.graduated, recent_tx_count: actRow.recent_tx_count || 0, trade_count: actRow.trade_count || 0, weight: Number(((actRow.graduated ? 0.3 : 0) + Math.min(0.4, (actRow.recent_tx_count || 0) * 0.005) + Math.min(0.3, (actRow.trade_count || 0) * 0.01)).toFixed(3)) } : { graduated: false, recent_tx_count: 0, trade_count: 0, weight: 0 };

	const [payRow] = await sql`select count(*) filter (where p.status='confirmed')::int as confirmed_count, count(distinct p.payer_wallet) filter (where p.status='confirmed')::int as unique_payers, coalesce(sum(p.amount_atomics) filter (where p.status='confirmed'), 0)::text as total_atomics from pump_agent_payments p join pump_agent_mints m on m.id = p.mint_id join agent_identities a on a.id = m.agent_id where (a.meta->>'sol_mint_address') = ${asset} and m.network = ${network}`;

	return json(res, 200, {
		agent: asset, network,
		pump_payments: payRow || { confirmed_count: 0, unique_payers: 0, total_atomics: '0' },
		pumpfun_signals: { count: pumpfunTotal, weight: Number(pumpfunWeight.toFixed(3)), by_kind: pumpfunByKind },
		token_activity: tokenActivity,
		feedback: {
			total: fb.total, verified: fb.verified, credentialed: fb.credentialed, event_attested: fb.event_attested, disputed: fb.disputed,
			unique_attesters: fb.unique_attesters, unique_verified_attesters: fb.unique_verified_attesters, unique_credentialed_attesters: fb.unique_credentialed_attesters,
			score_avg: Number(fb.score_avg.toFixed(3)), score_avg_verified: Number(fb.score_avg_verified.toFixed(3)),
			score_avg_credentialed: Number(fb.score_avg_credentialed.toFixed(3)), score_avg_event_attested: Number(fb.score_avg_event_attested.toFixed(3)),
			score_avg_weighted: Number(fb.score_avg_weighted.toFixed(3)), score_avg_weighted_verified: Number(fb.score_avg_weighted_verified.toFixed(3)), score_avg_weighted_credentialed: Number(fb.score_avg_weighted_credentialed.toFixed(3)),
		},
		validation: { self_passed: val.passed, self_failed: val.failed, event_passed: val.event_passed, event_failed: val.event_failed, audited_passed: auditedVal.passed, audited_failed: auditedVal.failed },
		tasks: { offered: counts.tasks_offered, accepted: counts.tasks_accepted },
		disputes_filed: counts.disputes_filed, revoked_count: counts.revoked_count,
		stake: {
			total_lamports: stakeAgg?.total_lamports || '0',
			count: stakeAgg?.stake_count || 0,
			unique_stakers: stakeAgg?.unique_stakers || 0,
			top_stakers: topStakers.map((r) => ({
				attester: r.attester,
				lamports: r.lamports,
				score: r.score,
			})),
		},
		last_indexed_at: cursor?.last_indexed_at || null,
	});
});

// ── solana-reputation-history ─────────────────────────────────────────────────

const MAX_DAYS = 90;

export const handleReputationHistory = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url   = new URL(req.url, `http://${req.headers.host}`);
	const asset = url.searchParams.get('asset');
	const network = url.searchParams.get('network') === 'mainnet' ? 'mainnet' : 'devnet';
	const days  = Math.min(Math.max(Number(url.searchParams.get('days') || 30), 1), MAX_DAYS);

	if (!asset) return error(res, 400, 'validation_error', 'asset query param required');
	try { new PublicKey(asset); } catch { return error(res, 400, 'validation_error', 'invalid asset pubkey'); }

	const rows = await sql`
		with feedback as (
			select date_trunc('day', f.block_time) as day, f.attester, (f.payload->>'score')::int as score,
				exists (select 1 from solana_attestations a where a.agent_asset = f.agent_asset and a.kind = 'threews.accept.v1' and a.payload->>'task_id' = f.payload->>'task_id' and a.verified = true and f.payload->>'task_id' is not null) as task_accepted,
				exists (select 1 from solana_credentials c where c.subject = f.attester and c.network = f.network and c.kind = 'threews.verified-client.v1' and c.closed = false and (c.expiry is null or c.expiry > f.block_time)) as credentialed,
				(f.payload->>'source' like 'pumpkit.%') as event_attested
			from solana_attestations f where f.agent_asset = ${asset} and f.network = ${network} and f.kind = 'threews.feedback.v1' and f.revoked = false and f.block_time >= now() - (${days} || ' days')::interval
		)
		select day, count(*)::int as n,
			coalesce(avg(score) filter (where credentialed), 0)::float as score_credentialed,
			coalesce(avg(score) filter (where task_accepted), 0)::float as score_verified,
			coalesce(avg(score) filter (where event_attested), 0)::float as score_event,
			coalesce(avg(score), 0)::float as score_raw,
			count(*) filter (where credentialed)::int as n_credentialed,
			count(*) filter (where task_accepted)::int as n_verified,
			count(*) filter (where event_attested)::int as n_event
		from feedback group by day order by day asc
	`;

	const series = rows.map((r) => {
		const tier = r.n_credentialed > 0 ? { tier: 'credentialed', score: r.score_credentialed, n: r.n_credentialed } : r.n_verified > 0 ? { tier: 'verified', score: r.score_verified, n: r.n_verified } : r.n_event > 0 ? { tier: 'event', score: r.score_event, n: r.n_event } : { tier: 'community', score: r.score_raw, n: r.n };
		return { day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10), tier: tier.tier, score: Number(tier.score.toFixed(3)), n: tier.n };
	});

	return json(res, 200, { agent: asset, network, days, series });
});

// ── solana-registration-card ──────────────────────────────────────────────────
// Resolves an asset pubkey → Metaplex Agent Registry registration card JSON.
//
// Resolution chain:
//   1. On-chain identity PDA: if agentRegistrationUri is present —
//      - data: URI  → decode base64 payload, return inline as application/json
//      - https: URI → 302 redirect so callers always get the live card
//   2. DB lookup by sol_mint_address: redirect to /api/agents/{id}/registration
//      (the platform's stable, mutable endpoint for this agent)
//   3. 404 with a clear description of what was tried
//
// Note: the current on-chain program (mpl-agent-registry v0.2.5) stores only
// a membership marker in the identity PDA; agentRegistrationUri is not persisted
// in the account bytes (confirmed by reading 104-byte V2 accounts for all
// tested assets). Step 2 is therefore the primary resolution path today.

export const handleRegistrationCard = wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const url = new URL(req.url, `http://${req.headers.host}`);
	const asset = url.searchParams.get('asset');
	if (!asset) return error(res, 400, 'validation_error', 'asset query param required');
	try { new PublicKey(asset); } catch { return error(res, 400, 'validation_error', 'invalid asset pubkey'); }

	const network = url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
	const rpcUrl = network === 'devnet'
		? (process.env.SOLANA_RPC_URL_DEVNET || 'https://api.devnet.solana.com')
		: (process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

	const origin = env.APP_ORIGIN;

	// ── Step 1: on-chain identity PDA ────────────────────────────────────────
	let pdaUri = null;
	try {
		// Failover Connection so the best-effort on-chain PDA read rotates across the
		// endpoint chain rather than silently failing (→ DB fallback) every time the
		// single configured node returns a malformed/empty body.
		const umi = createUmi(solanaConnection({ url: rpcUrl, network })).use(mplCore()).use(mplAgentIdentity());
		const assetPk = umiPublicKey(asset);
		const [pdaAddr] = findAgentIdentityV1Pda(umi, { asset: assetPk });
		const acct = await umi.rpc.getAccount(pdaAddr).catch(() => null);
		if (acct?.exists && acct.data?.length) {
			const ser = getAgentIdentityV2AccountDataSerializer();
			const [parsed] = ser.deserialize(acct.data, 0);
			// The current program version does not write agentRegistrationUri into
			// the account, so this will be absent for all existing assets. The
			// check is here for forward-compatibility when the program is upgraded.
			if (parsed?.agentRegistrationUri) pdaUri = parsed.agentRegistrationUri;
		}
	} catch { /* RPC or deserialize failure — fall through to DB */ }

	if (pdaUri) {
		if (pdaUri.startsWith('data:')) {
			// Decode inline registration document and return it as JSON.
			try {
				const [meta, b64] = pdaUri.slice('data:'.length).split(',', 2);
				if (!b64) return error(res, 502, 'bad_data_uri', 'malformed data: URI in identity PDA');
				const encoding = meta.includes('base64') ? 'base64' : 'utf8';
				const raw = encoding === 'base64' ? Buffer.from(b64, 'base64').toString('utf8') : decodeURIComponent(b64);
				const doc = JSON.parse(raw);
				return json(res, 200, doc, {
					'cache-control': 'public, max-age=3600',
					'access-control-allow-origin': '*',
					'x-registration-source': 'onchain-data-uri',
					'x-asset': asset,
				});
			} catch {
				return error(res, 502, 'bad_data_uri', 'failed to decode data: URI from identity PDA');
			}
		}
		if (pdaUri.startsWith('https://') || pdaUri.startsWith('http://')) {
			res.setHeader('access-control-allow-origin', '*');
			res.setHeader('x-registration-source', 'onchain-https-uri');
			res.setHeader('x-asset', asset);
			res.writeHead(302, { Location: pdaUri });
			res.end();
			return;
		}
	}

	// ── Step 2: DB lookup by sol_mint_address ────────────────────────────────
	const [agent] = await sql`
		select id from agent_identities
		where (meta->>'sol_mint_address') = ${asset} and deleted_at is null
		limit 1
	`;
	if (agent) {
		const registrationUrl = `${origin}/api/agents/${agent.id}/registration`;
		res.setHeader('access-control-allow-origin', '*');
		res.setHeader('x-registration-source', 'db-registration-endpoint');
		res.setHeader('x-asset', asset);
		res.writeHead(302, { Location: registrationUrl });
		res.end();
		return;
	}

	// ── Step 3: not found ────────────────────────────────────────────────────
	return error(res, 404, 'not_found', `no registration card found for asset ${asset} — identity PDA has no agentRegistrationUri and asset is not registered on three.ws`);
});
