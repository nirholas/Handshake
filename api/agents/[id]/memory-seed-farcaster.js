// GET    /api/agents/:id/memory/seed/farcaster — link + consent status
// POST   /api/agents/:id/memory/seed/farcaster — challenge, grant, or re-seed
// DELETE /api/agents/:id/memory/seed/farcaster — revoke consent, delete every seeded memory
//
// Consent-first. Farcaster has no OAuth and we deliberately do not ask for a
// signer, so proof of ownership comes from the protocol itself: a fid publishes
// the wallets it controls as verification messages, and the user signs a
// one-time challenge with one of those wallets. That is the least-privilege
// method available. We get read-only public data, the user grants nothing that
// could post as them, and nothing is stored until the signature verifies.
//
// Solana leads: verified Solana wallets are offered first and are the default
// path in the UI. An EVM verification is accepted as a second leg so a fid that
// only ever verified an Ethereum address is not locked out.
//
// POST intents:
//   { intent: 'challenge', fid | fname }        → nonce + the exact text to sign
//   { intent: 'grant', nonce, address, chain, signature } → verify, store consent, seed
//   { intent: 'reseed' }                        → re-run ingest under a live grant
//
// Auth: session (or bearer) user must own the agent. Rate limit: 1 seed per
// agent per 6 hours, matching the X and GitHub lanes.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { verifyMessage } from 'ethers';
import { sql } from '../../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../../_lib/auth.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../../_lib/http.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { limits } from '../../_lib/rate-limit.js';
import { llmComplete } from '../../_lib/llm.js';
import { isUuid, parse } from '../../_lib/validate.js';
import { env } from '../../_lib/env.js';
import { randomToken } from '../../_lib/crypto.js';
import { verifySiwsSignature } from '../../_lib/siws.js';
import {
	FarcasterError,
	fetchRecentCasts,
	fetchVerifiedAddresses,
	resolveFarcasterUser,
} from '../../_lib/farcaster-client.js';
import {
	CONSENT_SCOPE,
	CONSENT_TTL_MS,
	MEMORY_SOURCE,
	addressMatches,
	buildConsentMessage,
	buildSeedMemories,
	distillationInput,
	normalizeAddress,
	parseDistilledFacts,
	selectSeedCasts,
} from '../../_lib/farcaster-seed.js';

const CAST_LIMIT = 100;
const MAX_FACTS = 15;

const SEED_SYSTEM_PROMPT =
	'You distill Farcaster casts into concise memory facts for an AI agent that ' +
	'speaks as this person. Focus on recurring topics, stated opinions, projects ' +
	'they work on, communication style, and community ties. Never invent detail ' +
	'that is not in the casts. Output ONLY a JSON array of up to ' +
	`${MAX_FACTS} single-sentence strings, no other text.`;

// The "fid or fname" requirement is enforced in handlePost rather than as a
// refine, because z.discriminatedUnion only accepts plain object members.
const challengeSchema = z.object({
	intent: z.literal('challenge'),
	fid: z.number().int().positive().optional(),
	fname: z.string().trim().min(1).max(64).optional(),
	// Which verified wallet to sign with. Omitted on the first call, when the
	// server picks Solana first; sent when the user chooses another of their
	// verified wallets, which needs a fresh message naming that address.
	address: z.string().trim().min(8).max(128).optional(),
});

const grantSchema = z.object({
	intent: z.literal('grant'),
	nonce: z.string().trim().min(8).max(128),
	address: z.string().trim().min(8).max(128),
	chain: z.enum(['solana', 'ethereum']),
	signature: z.string().trim().min(1).max(512),
});

const reseedSchema = z.object({ intent: z.literal('reseed') });

const bodySchema = z.discriminatedUnion('intent', [challengeSchema, grantSchema, reseedSchema]);

// ── Preconditions ───────────────────────────────────────────────────────────

async function requireOwnedAgent(req, agentId) {
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id ?? bearer?.userId;
	if (!userId) throw Object.assign(new Error('sign in required'), { status: 401, code: 'unauthorized' });

	const [agent] = await sql`
		SELECT id, farcaster_fid, farcaster_fname, farcaster_seeded_at
		FROM agent_identities
		WHERE id = ${agentId} AND user_id = ${userId} AND deleted_at IS NULL
	`;
	if (!agent) throw Object.assign(new Error('agent not found'), { status: 404, code: 'not_found' });
	return { userId, agent };
}

async function activeConsent(agentId) {
	const [row] = await sql`
		SELECT id, fid, fname, scope, proof_chain, proof_address, source_lane,
		       granted_at, last_seeded_at, memories_seeded, casts_ingested
		FROM farcaster_memory_consents
		WHERE agent_id = ${agentId} AND revoked_at IS NULL
		LIMIT 1
	`;
	return row ?? null;
}

async function seededCount(agentId) {
	const [row] = await sql`
		SELECT count(*)::int AS memory_count, max(created_at) AS seeded_at
		FROM agent_memories
		WHERE agent_id = ${agentId} AND context->>'source' = ${MEMORY_SOURCE}
	`;
	return { memory_count: row?.memory_count ?? 0, seeded_at: row?.seeded_at ?? null };
}

function consentView(consent) {
	if (!consent) return null;
	return {
		id: consent.id,
		fid: consent.fid,
		fname: consent.fname,
		scope: consent.scope,
		proof_chain: consent.proof_chain,
		proof_address: consent.proof_address,
		source_lane: consent.source_lane,
		granted_at: consent.granted_at,
		last_seeded_at: consent.last_seeded_at,
		memories_seeded: consent.memories_seeded,
		casts_ingested: consent.casts_ingested,
	};
}

// ── GET — status ────────────────────────────────────────────────────────────

async function handleGet(req, res, agentId) {
	const { agent } = await requireOwnedAgent(req, agentId);
	const [consent, stats] = await Promise.all([activeConsent(agentId), seededCount(agentId)]);

	return json(res, 200, {
		connected: Boolean(consent),
		fid: consent?.fid ?? agent.farcaster_fid ?? null,
		fname: consent?.fname ?? agent.farcaster_fname ?? null,
		scope: CONSENT_SCOPE,
		consent: consentView(consent),
		cast_limit: CAST_LIMIT,
		...stats,
	});
}

// ── POST: challenge ─────────────────────────────────────────────────────────

async function handleChallenge(req, res, agentId, userId, body) {
	const user = await resolveFarcasterUser({ fid: body.fid ?? null, fname: body.fname ?? null });
	const verified = await fetchVerifiedAddresses(user.fid);

	const solana = verified.solana ?? [];
	const ethereum = verified.ethereum ?? [];
	if (solana.length === 0 && ethereum.length === 0) {
		return error(
			res,
			409,
			'no_verified_wallet',
			'this Farcaster account has no verified wallet, so ownership cannot be proved. ' +
				'Verify a Solana wallet on your Farcaster account, then try again.',
			{ fid: user.fid, fname: user.fname },
		);
	}

	// Solana first: it is the home chain and the wallet UX we lead with. A caller
	// may name another of the fid's verified wallets instead.
	let chain = solana.length > 0 ? 'solana' : 'ethereum';
	let address = chain === 'solana' ? solana[0] : ethereum[0];
	if (body.address) {
		if (addressMatches(body.address, solana, 'solana')) {
			chain = 'solana';
			address = normalizeAddress(body.address, 'solana');
		} else if (addressMatches(body.address, ethereum, 'ethereum')) {
			chain = 'ethereum';
			address = normalizeAddress(body.address, 'ethereum');
		} else {
			return error(
				res,
				403,
				'address_not_verified',
				'that wallet is not one of the addresses this Farcaster account has verified',
				{ wallets: { solana, ethereum } },
			);
		}
	}

	// 24 alphanumeric chars from the CSPRNG, same shape as the SIWS nonce.
	let nonce = '';
	while (nonce.length < 24) nonce += randomToken(24).replace(/[^A-Za-z0-9]/g, '');
	nonce = nonce.slice(0, 24);

	const issuedAt = new Date();
	const expiresAt = new Date(issuedAt.getTime() + CONSENT_TTL_MS);
	const domain = new URL(env.APP_ORIGIN).host;

	const message = buildConsentMessage({
		domain,
		agentId,
		fid: user.fid,
		fname: user.fname,
		address,
		chain,
		nonce,
		issuedAt: issuedAt.toISOString(),
		expiresAt: expiresAt.toISOString(),
		castLimit: CAST_LIMIT,
	});

	await sql`
		INSERT INTO farcaster_seed_challenges (nonce, user_id, agent_id, fid, fname, message, cast_limit, expires_at)
		VALUES (${nonce}, ${userId}, ${agentId}, ${user.fid}, ${user.fname}, ${message}, ${CAST_LIMIT}, ${expiresAt.toISOString()})
	`;

	return json(res, 200, {
		nonce,
		message,
		chain,
		address,
		scope: CONSENT_SCOPE,
		cast_limit: CAST_LIMIT,
		expires_at: expiresAt.toISOString(),
		profile: {
			fid: user.fid,
			fname: user.fname,
			display_name: user.displayName,
			bio: user.bio,
			pfp_url: user.pfpUrl,
			follower_count: user.followerCount,
		},
		wallets: { solana, ethereum },
		lane: user.lane,
	});
}

// ── POST: grant ─────────────────────────────────────────────────────────────

function signatureValid({ chain, message, signature, address }) {
	if (chain === 'solana') {
		try {
			return verifySiwsSignature(message, signature, address);
		} catch {
			return false;
		}
	}
	try {
		return normalizeAddress(verifyMessage(message, signature), 'ethereum') === normalizeAddress(address, 'ethereum');
	} catch {
		return false;
	}
}

async function handleGrant(req, res, agentId, userId, body) {
	const [challenge] = await sql`
		SELECT nonce, fid, fname, message, cast_limit, expires_at, consumed_at
		FROM farcaster_seed_challenges
		WHERE nonce = ${body.nonce} AND agent_id = ${agentId} AND user_id = ${userId}
	`;
	if (!challenge) return error(res, 404, 'challenge_not_found', 'no such challenge for this agent');
	if (challenge.consumed_at) return error(res, 409, 'challenge_used', 'this challenge has already been used');
	if (new Date(challenge.expires_at) <= new Date()) {
		return error(res, 410, 'challenge_expired', 'this challenge expired, request a new one');
	}

	// Re-read the fid's verifications live rather than trusting the list handed
	// out with the challenge: a wallet unverified since then must stop working.
	const verified = await fetchVerifiedAddresses(challenge.fid);
	if (!addressMatches(body.address, verified[body.chain] ?? [], body.chain)) {
		return error(
			res,
			403,
			'address_not_verified',
			'that wallet is not one of the addresses this Farcaster account has verified',
		);
	}

	// The message is compared against the copy WE stored, so a client cannot
	// present a different agent, fid, or scope than the one it was issued.
	const expected = challenge.message;
	const signedAddress = /^Wallet: (.+)$/m.exec(expected)?.[1];
	if (normalizeAddress(signedAddress, body.chain) !== normalizeAddress(body.address, body.chain)) {
		return error(res, 400, 'address_mismatch', 'this challenge was issued for a different wallet');
	}
	if (!signatureValid({ chain: body.chain, message: expected, signature: body.signature, address: body.address })) {
		return error(res, 401, 'invalid_signature', 'the signature does not match the consent message');
	}

	const consentId = randomUUID();
	const proofAddress = normalizeAddress(body.address, body.chain);

	// Burn the nonce and record the grant together: a replay must not be able to
	// slip between the two, and a failed insert must not leave a spent nonce.
	await sql.transaction([
		sql`UPDATE farcaster_seed_challenges SET consumed_at = now() WHERE nonce = ${challenge.nonce} AND consumed_at IS NULL`,
		sql`
			UPDATE farcaster_memory_consents SET revoked_at = now()
			WHERE agent_id = ${agentId} AND revoked_at IS NULL
		`,
		sql`
			INSERT INTO farcaster_memory_consents
				(id, user_id, agent_id, fid, fname, scope, proof_chain, proof_address, proof_signature, proof_message)
			VALUES (
				${consentId}, ${userId}, ${agentId}, ${challenge.fid}, ${challenge.fname}, ${CONSENT_SCOPE},
				${body.chain}, ${proofAddress}, ${body.signature}, ${expected}
			)
		`,
	]);

	const consent = {
		id: consentId,
		fid: challenge.fid,
		fname: challenge.fname,
		cast_limit: challenge.cast_limit,
	};
	const result = await ingest(agentId, consent);

	return json(res, 200, {
		granted: true,
		consent_id: consentId,
		scope: CONSENT_SCOPE,
		proof: { chain: body.chain, address: proofAddress },
		...result,
	});
}

// ── POST: reseed ────────────────────────────────────────────────────────────

async function handleReseed(req, res, agentId) {
	const consent = await activeConsent(agentId);
	if (!consent) {
		return error(res, 412, 'not_connected', 'grant Farcaster consent for this agent before seeding');
	}
	const result = await ingest(agentId, { ...consent, cast_limit: CAST_LIMIT });
	return json(res, 200, { granted: true, consent_id: consent.id, scope: consent.scope, ...result });
}

// ── Ingest ──────────────────────────────────────────────────────────────────

/**
 * Read the consented casts, distil them, and replace this grant's memories.
 * Only rows carrying THIS consent id are touched, so a re-seed never deletes
 * memories the agent earned anywhere else.
 */
async function ingest(agentId, consent) {
	const profile = await resolveFarcasterUser({ fid: consent.fid });
	const { casts, lane } = await fetchRecentCasts(consent.fid, consent.cast_limit ?? CAST_LIMIT);
	const selected = selectSeedCasts(casts, { limit: consent.cast_limit ?? CAST_LIMIT });

	let facts = [];
	if (selected.length > 0) {
		const input = distillationInput({ profile, casts: selected });
		try {
			const { text: raw } = await llmComplete({
				maxTokens: 1024,
				system: SEED_SYSTEM_PROMPT,
				user: `Profile: ${input.header}\n\nRecent casts (newest first):\n${input.casts.join('\n')}`,
			});
			facts = parseDistilledFacts(raw, { max: MAX_FACTS });
		} catch (e) {
			// The profile and cast memories below are derived without a model, so a
			// distillation outage degrades the seed instead of failing it.
			console.warn('[memory-seed-farcaster] distillation unavailable', e?.message || e);
		}
	}

	const rows = buildSeedMemories({
		fid: consent.fid,
		fname: consent.fname ?? profile.fname,
		profile,
		casts: selected,
		facts,
		consentId: consent.id,
	});

	// Replace this grant's memories atomically: a mid-loop failure must never
	// leave the agent with the old set deleted and only part of the new one.
	await sql.transaction([
		sql`
			DELETE FROM agent_memories
			WHERE agent_id = ${agentId}
			  AND context->>'source' = ${MEMORY_SOURCE}
			  AND context->>'consent_id' = ${consent.id}
		`,
		...rows.map(
			(row) => sql`
				INSERT INTO agent_memories (agent_id, type, content, tags, context, salience)
				VALUES (${agentId}, ${row.type}, ${row.content}, ${row.tags}, ${JSON.stringify(row.context)}::jsonb, ${row.salience})
			`,
		),
		sql`
			UPDATE farcaster_memory_consents
			SET last_seeded_at = now(), memories_seeded = ${rows.length}, casts_ingested = ${selected.length},
			    source_lane = ${lane}, fname = ${consent.fname ?? profile.fname}
			WHERE id = ${consent.id}
		`,
		sql`
			UPDATE agent_identities
			SET farcaster_fid = ${consent.fid}, farcaster_fname = ${consent.fname ?? profile.fname}, farcaster_seeded_at = now()
			WHERE id = ${agentId}
		`,
	]);

	return {
		fid: consent.fid,
		fname: consent.fname ?? profile.fname,
		seeded: rows.length,
		casts_ingested: selected.length,
		facts,
		lane,
		seeded_at: new Date().toISOString(),
	};
}

// ── DELETE — revoke ─────────────────────────────────────────────────────────

async function handleDelete(req, res, agentId) {
	const consent = await activeConsent(agentId);

	// Revocation deletes every Farcaster-seeded memory on the agent, not just the
	// live grant's rows: a user asking to be forgotten means all of it, including
	// anything a superseded grant left behind.
	const deleted = await sql`
		DELETE FROM agent_memories
		WHERE agent_id = ${agentId} AND context->>'source' = ${MEMORY_SOURCE}
		RETURNING id
	`;
	await sql`
		UPDATE farcaster_memory_consents SET revoked_at = now()
		WHERE agent_id = ${agentId} AND revoked_at IS NULL
	`;
	await sql`
		UPDATE agent_identities
		SET farcaster_fid = NULL, farcaster_fname = NULL, farcaster_seeded_at = NULL
		WHERE id = ${agentId}
	`;

	return json(res, 200, {
		revoked: Boolean(consent),
		consent_id: consent?.id ?? null,
		deleted: deleted.length,
	});
}

// ── dispatch ────────────────────────────────────────────────────────────────

async function handlePost(req, res, agentId) {
	const { userId } = await requireOwnedAgent(req, agentId);
	if (!(await requireCsrf(req, res, userId))) return;

	const body = parse(bodySchema, (await readJson(req)) ?? {});

	if (body.intent === 'challenge') {
		if (body.fid == null && body.fname == null) {
			return error(res, 400, 'validation_error', 'fid or fname required');
		}
		return handleChallenge(req, res, agentId, userId, body);
	}

	// Only the paths that actually read Farcaster and call a model consume the
	// seed budget, and only after ownership is proven.
	const rl = await limits.farcasterSeed(agentId);
	if (!rl.success) return rateLimited(res, rl, 'this agent can only be re-seeded every 6 hours');

	if (body.intent === 'grant') return handleGrant(req, res, agentId, userId, body);
	return handleReseed(req, res, agentId);
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,DELETE,OPTIONS', credentials: true })) return;

	const url = new URL(req.url, 'http://x');
	const agentId = req.query?.id || url.pathname.split('/').filter(Boolean)[2];
	if (!agentId) return error(res, 400, 'validation_error', 'agent id required');
	// This route has its own rewrite, so the uuid gate in api/agents/[id].js never
	// runs for it. A malformed id would otherwise reach a uuid column and turn a
	// Postgres 22P02 into a 500.
	if (!isUuid(agentId)) return error(res, 404, 'not_found', 'agent not found');

	try {
		if (req.method === 'GET') return await handleGet(req, res, agentId);
		if (req.method === 'POST') return await handlePost(req, res, agentId);
		if (req.method === 'DELETE') {
			const { userId } = await requireOwnedAgent(req, agentId);
			if (!(await requireCsrf(req, res, userId))) return;
			return await handleDelete(req, res, agentId);
		}
		return method(req, res, ['GET', 'POST', 'DELETE']);
	} catch (e) {
		// Somebody else's downtime is an upstream failure, not an internal one: a
		// bare throw here would surface as a 500 plus an ops alert.
		if (e instanceof FarcasterError) return error(res, e.status, e.code, e.message);
		throw e;
	}
});
