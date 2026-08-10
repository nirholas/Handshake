/**
 * Portable & Verifiable Brain — ownership endpoints.
 *
 *   GET  /api/agents/:id/brain            — brain passport: storage mode, signed/
 *                                           verified counts, pin status + CIDs,
 *                                           on-chain anchor + drift, persona status.
 *   GET  /api/agents/:id/brain/export     — download a schema-versioned, signed
 *                                           .brain bundle (private memories stay
 *                                           encrypted unless explicitly opted in).
 *   POST /api/agents/:id/brain/verify     — verify one memory by id, or a posted
 *                                           bundle, against its signatures.
 *   POST /api/agents/:id/brain/anchor     — anchor the current brain_hash on-chain.
 *   POST /api/agents/:id/brain/storage    — set the agent default storage mode and/
 *                                           or a per-memory override + record a CID.
 *   POST /api/agents/:id/brain/import     — reconstitute a bundle into THIS owned
 *                                           (forked) agent, preserving provenance,
 *                                           with diff/merge against existing memories.
 *
 * All routes are owner-only. Mutations require CSRF. The verify route accepts an
 * unauthenticated bundle body too (public verification of a shared brain), but
 * never reveals private content.
 */

import { getSessionUser, authenticateBearer, extractBearer } from '../../_lib/auth.js';
import { sql } from '../../_lib/db.js';
import { cors, json, method, readJson, error } from '../../_lib/http.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { parse } from '../../_lib/validate.js';
import { z } from 'zod';

import {
	verifyMemorySignature,
	memoryDigest,
	signMemoryWithAgent,
	loadAgentSigner,
} from '../../_lib/brain-sign.js';
import {
	buildBundle,
	buildMemoryEntry,
	verifyBundle,
	brainBundleSchema,
} from '../../_lib/brain-bundle.js';
import {
	anchorBrain,
	latestAnchor,
	BrainAnchorError,
} from '../../_lib/brain-anchor.js';

const STORAGE_MODES = ['local', 'ipfs', 'encrypted-ipfs', 'none'];

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

async function ownedAgent(id, userId) {
	const [agent] = await sql`
		SELECT id, user_id, name, description, avatar_id, chain_id, erc8004_agent_id,
		       wallet_address, memory_storage_mode,
		       persona_prompt, persona_prompt_hash, persona_prompt_sig,
		       persona_tone_tags, persona_extracted_at, meta
		FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL
	`;
	if (!agent) return { agent: null, code: 404 };
	if (agent.user_id !== userId) return { agent: null, code: 403 };
	return { agent, code: 200 };
}

function personaFrom(agent, { includePrompt }) {
	if (!agent.persona_prompt_hash) return null;
	return {
		prompt: includePrompt ? agent.persona_prompt : null,
		prompt_hash: agent.persona_prompt_hash,
		prompt_sig: agent.persona_prompt_sig,
		tone_tags: agent.persona_tone_tags || [],
		extracted_at: agent.persona_extracted_at
			? new Date(agent.persona_extracted_at).toISOString()
			: null,
	};
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} id agent id
 * @param {string} [action] the segment after /brain (export|verify|anchor|storage|import)
 */
export async function handleBrain(req, res, id, action) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	// Public bundle verification: POST /brain/verify with a `bundle` body and no
	// session is allowed — it reveals nothing private.
	if (req.method === 'POST' && action === 'verify') {
		const body = await readJson(req);
		if (body && body.bundle) return verifyPostedBundle(res, body.bundle);
		// else fall through to authenticated per-memory verify
	}

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const { agent, code } = await ownedAgent(id, auth.userId);
	if (!agent) {
		return code === 403
			? error(res, 403, 'forbidden', 'not your agent')
			: error(res, 404, 'not_found', 'agent not found');
	}

	if (req.method === 'GET' && !action) return getPassport(res, agent);
	if (req.method === 'GET' && action === 'export') return exportBundle(req, res, agent);

	// Mutations below require CSRF.
	if (req.method === 'POST') {
		if (!(await requireCsrf(req, res, auth.userId))) return;
		if (action === 'verify') return verifyMemory(req, res, agent);
		if (action === 'anchor') return anchor(req, res, agent);
		if (action === 'storage') return setStorage(req, res, agent);
		if (action === 'import') return importBundle(req, res, agent, auth.userId);
	}

	return error(res, 404, 'not_found', 'unknown brain action');
}

// ── GET /brain — passport ─────────────────────────────────────────────────────

async function getPassport(res, agent) {
	const rows = await sql`
		SELECT id, type, content, tags, salience, tier, is_public,
		       content_hash, signature, signer_address, signed_at, storage_mode, ipfs_cid, created_at
		FROM agent_memories
		WHERE agent_id = ${agent.id} AND (expires_at IS NULL OR expires_at > now())
	`;

	let signed = 0;
	let verified = 0;
	let publicCount = 0;
	let encrypted = 0;
	for (const r of rows) {
		if (r.is_public) publicCount++;
		if (r.ipfs_cid) encrypted++;
		if (r.signature) {
			signed++;
			const v = verifyMemorySignature(r, {
				signature: r.signature,
				signer_address: r.signer_address,
				content_hash: r.content_hash,
			});
			if (v.valid) verified++;
		}
	}

	const pins = await sql`
		SELECT cid, filename, bytes, created_at FROM agent_memory_pins
		WHERE agent_id = ${agent.id}
		ORDER BY created_at DESC LIMIT 200
	`;

	let anchorState = { anchor: null, currentBrainHash: null, inSync: false };
	try {
		anchorState = await latestAnchor(agent.id);
	} catch (err) {
		console.error('[brain] latestAnchor failed', agent.id, err?.message);
	}

	return json(res, 200, {
		agent: {
			id: agent.id,
			name: agent.name,
			wallet_address: agent.wallet_address,
			chain_id: agent.chain_id,
			erc8004_agent_id: agent.erc8004_agent_id != null ? String(agent.erc8004_agent_id) : null,
			registered_onchain: agent.erc8004_agent_id != null,
		},
		storage_mode: agent.memory_storage_mode || 'local',
		persona: agent.persona_prompt_hash
			? {
					has_persona: true,
					prompt_hash: agent.persona_prompt_hash,
					tone_tags: agent.persona_tone_tags || [],
					extracted_at: agent.persona_extracted_at,
				}
			: { has_persona: false },
		memories: {
			total: rows.length,
			public: publicCount,
			private: rows.length - publicCount,
			signed,
			verified,
			unsigned: rows.length - signed,
			encrypted_pinned: encrypted,
		},
		pins: pins.map((p) => ({
			cid: p.cid,
			filename: p.filename,
			bytes: p.bytes,
			created_at: p.created_at,
			gateway_url: `https://dweb.link/ipfs/${p.cid}`,
		})),
		anchor: anchorState.anchor,
		current_brain_hash: anchorState.currentBrainHash,
		anchor_in_sync: anchorState.inSync,
		provenance: agent.meta?.brain_provenance || null,
	});
}

// ── GET /brain/export ───────────────────────────────────────────────────────

async function exportBundle(req, res, agent) {
	const url = new URL(req.url, 'http://x');
	const includePrivate = url.searchParams.get('includePrivate') === 'true';
	const publicOnly = url.searchParams.get('publicOnly') === 'true';

	const rows = await sql`
		SELECT id, agent_id, type, content, tags, salience, tier, is_public,
		       content_hash, signature, signer_address, signed_at, storage_mode, ipfs_cid, created_at
		FROM agent_memories
		WHERE agent_id = ${agent.id} AND (expires_at IS NULL OR expires_at > now())
		${publicOnly ? sql`AND is_public = true` : sql``}
		ORDER BY created_at ASC
	`;

	// Encrypted private memories travel as a CID reference (ciphertext stays on
	// IPFS, key never leaves the owner's wallet).
	const cipherRefs = new Map();
	for (const r of rows) {
		if (!r.is_public && r.ipfs_cid) {
			cipherRefs.set(String(r.id), { cid: r.ipfs_cid, filename: `${r.id}.enc` });
		}
	}

	const memoryEntries = rows
		.map((r) => buildMemoryEntry(r, { includePrivatePlaintext: includePrivate, cipherRefs }))
		.filter(Boolean);

	// Sign the bundle with the agent wallet when available.
	let signerPrivKey = null;
	try {
		const signer = await loadAgentSigner(agent.id, { agentId: agent.id, reason: 'brain_export' });
		if (signer) signerPrivKey = signer.privKey;
	} catch (err) {
		console.error('[brain] export signer load failed', agent.id, err?.message);
	}

	const bundle = await buildBundle({
		agent,
		persona: personaFrom(agent, { includePrompt: true }),
		memoryEntries,
		anchor: await safeAnchorForExport(agent.id),
		exportedAt: new Date().toISOString(),
		signerPrivKey,
	});

	const filename = `${(agent.name || 'agent').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${agent.id.slice(0, 8)}.brain.json`;
	res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
	return json(res, 200, bundle);
}

async function safeAnchorForExport(agentId) {
	try {
		const { anchor } = await latestAnchor(agentId);
		if (!anchor) return null;
		return {
			brain_hash: anchor.brain_hash,
			proof_uri: anchor.proof_uri || undefined,
			proof_hash: anchor.proof_hash || undefined,
			tx_hash: anchor.tx_hash || undefined,
			chain_id: anchor.chain_id || undefined,
			anchored_at: anchor.anchored_at ? new Date(anchor.anchored_at).toISOString() : undefined,
			explorer_url: anchor.explorer_url || null,
		};
	} catch {
		return null;
	}
}

// ── POST /brain/verify ──────────────────────────────────────────────────────

const verifyBody = z.object({ memoryId: z.string().uuid() });

async function verifyMemory(req, res, agent) {
	const body = parse(verifyBody, await readJson(req));
	const [row] = await sql`
		SELECT id, agent_id, type, content, tags, content_hash, signature, signer_address, signed_at
		FROM agent_memories WHERE id = ${body.memoryId} AND agent_id = ${agent.id}
	`;
	if (!row) return error(res, 404, 'not_found', 'memory not found');

	const v = verifyMemorySignature(row, {
		signature: row.signature,
		signer_address: row.signer_address,
		content_hash: row.content_hash,
	});

	// Cross-check the recovered signer against the agent's known wallet — a
	// signature can be valid yet authored by a different key.
	const matchesAgentWallet =
		v.recovered && agent.wallet_address
			? v.recovered.toLowerCase() === agent.wallet_address.toLowerCase()
			: null;

	return json(res, 200, {
		memoryId: row.id,
		valid: v.valid,
		reason: v.reason,
		recovered_signer: v.recovered,
		expected_signer: row.signer_address || null,
		matches_agent_wallet: matchesAgentWallet,
		current_hash: v.digest,
		stored_hash: row.content_hash || null,
	});
}

function verifyPostedBundle(res, bundle) {
	const result = verifyBundle(bundle);
	return json(res, 200, result);
}

// ── POST /brain/anchor ──────────────────────────────────────────────────────

const anchorReq = z.object({ publicOnly: z.boolean().optional() });

async function anchor(req, res, agent) {
	const body = parse(anchorReq, (await readJson(req)) || {});
	try {
		const result = await anchorBrain({
			agentId: agent.id,
			anchoredAt: new Date().toISOString(),
			publicOnly: body.publicOnly === true,
		});
		return json(res, 200, {
			ok: true,
			brain_hash: result.brain_hash,
			tx_hash: result.tx_hash,
			proof_uri: result.proof_uri,
			chain_id: result.chain_id,
			explorer_url: result.explorer_url,
			anchored_at: result.anchored_at,
		});
	} catch (err) {
		if (err instanceof BrainAnchorError) {
			// Honest, actionable failure — never a fake success.
			const status = err.code === 'not_registered' ? 409 : 502;
			return error(res, status, err.code, err.message);
		}
		console.error('[brain] anchor failed', agent.id, err?.message);
		return error(res, 500, 'anchor_failed', 'could not anchor brain');
	}
}

// ── POST /brain/storage ─────────────────────────────────────────────────────

const storageReq = z.object({
	defaultMode: z.enum(STORAGE_MODES).optional(),
	memoryId: z.string().uuid().optional(),
	memoryMode: z.enum(STORAGE_MODES).nullable().optional(),
	// When the client has pinned an encrypted copy, it records the CID here.
	cid: z.string().min(1).max(120).optional(),
});

async function setStorage(req, res, agent) {
	const body = parse(storageReq, await readJson(req));

	if (body.defaultMode) {
		await sql`
			UPDATE agent_identities SET memory_storage_mode = ${body.defaultMode}, updated_at = now()
			WHERE id = ${agent.id}
		`;
	}

	if (body.memoryId) {
		const [mem] = await sql`SELECT id FROM agent_memories WHERE id = ${body.memoryId} AND agent_id = ${agent.id}`;
		if (!mem) return error(res, 404, 'not_found', 'memory not found');
		await sql`
			UPDATE agent_memories
			SET storage_mode = ${body.memoryMode ?? null},
			    ipfs_cid = ${body.cid ?? sql`ipfs_cid`}
			WHERE id = ${body.memoryId} AND agent_id = ${agent.id}
		`;
	}

	const [updated] = await sql`SELECT memory_storage_mode FROM agent_identities WHERE id = ${agent.id}`;
	return json(res, 200, { ok: true, storage_mode: updated.memory_storage_mode });
}

// ── POST /brain/import ──────────────────────────────────────────────────────

const importReq = z.object({
	bundle: brainBundleSchema,
	strategy: z.enum(['merge', 'replace']).default('merge'),
	importPersona: z.boolean().default(false),
});

async function importBundle(req, res, agent, userId) {
	const body = parse(importReq, await readJson(req));
	const bundle = body.bundle;

	// Reject a bundle that fails its own integrity check before it can
	// reconstitute a broken or forged mind.
	const verdict = verifyBundle(bundle);
	if (!verdict.schemaValid) {
		return error(res, 422, 'invalid_bundle', `bundle failed schema validation: ${verdict.errors.join('; ')}`);
	}
	if (!verdict.brainHashValid) {
		return error(res, 422, 'integrity_failed', 'bundle brain_hash does not match its memory set');
	}
	if (verdict.bundleSignatureValid === false) {
		return error(res, 422, 'integrity_failed', 'bundle signature failed verification');
	}
	// A forged plaintext memory (signed but tampered) is a hard reject.
	const forged = verdict.memories.find((m) => m.signed && !m.valid && m.reason !== 'encrypted');
	if (forged) {
		return error(res, 422, 'integrity_failed', `memory ${forged.id} has an invalid signature (${forged.reason})`);
	}

	// Diff against the target agent's existing memories so a merge is idempotent
	// and the response is a real, reviewable diff.
	//
	// Two hashes per row, and both are load-bearing. A row's own `content_hash` is
	// the digest of THAT row (memoryDigest folds in the row id and created_at), so
	// an imported copy hashes differently from the bundle entry it came from: on a
	// re-import the source hash would miss every time and the merge would insert a
	// fresh duplicate of every memory, forever. The source digest recorded in
	// provenance at import time is the stable key across that boundary, so match on
	// either.
	const existing = await sql`
		SELECT content_hash, context->'provenance'->>'source_content_hash' AS source_hash
		FROM agent_memories
		WHERE agent_id = ${agent.id}
		  AND (content_hash IS NOT NULL OR context->'provenance'->>'source_content_hash' IS NOT NULL)
	`;
	const existingHashes = new Set(
		existing
			.flatMap((r) => [r.content_hash, r.source_hash])
			.filter(Boolean)
			.map((h) => h.toLowerCase()),
	);

	if (body.strategy === 'replace') {
		await sql`DELETE FROM agent_memories WHERE agent_id = ${agent.id}`;
		existingHashes.clear();
	}

	// Only plaintext memories can be reconstituted here — encrypted entries
	// require the owner's key client-side and are reported as skipped.
	const toImport = bundle.memories.filter((m) => typeof m.content === 'string');
	const skippedEncrypted = bundle.memories.length - toImport.length;

	let imported = 0;
	let duplicates = 0;
	const newSignings = [];

	for (const m of toImport) {
		const hash = (m.content_hash || memoryDigest({ id: m.id, agent_id: bundle.agent.id, type: m.type, content: m.content, tags: m.tags, created_at: m.created_at })).toLowerCase();
		if (existingHashes.has(hash)) {
			duplicates++;
			continue;
		}
		existingHashes.add(hash);

		// Preserve the original authorship as provenance; the new agent re-signs
		// for its own chain of custody (handled after insert). `source_content_hash`
		// doubles as the dedupe key above, so record the digest actually matched on
		// rather than the bundle's optional field: an entry that shipped without one
		// would otherwise leave the next re-import nothing to match against.
		const provenance = {
			source_agent_id: bundle.agent.id,
			source_memory_id: m.id,
			source_content_hash: hash,
			source_signature: m.signature || null,
			source_signer_address: m.signer_address || null,
		};

		const [row] = await sql`
			INSERT INTO agent_memories
				(agent_id, type, content, tags, context, salience, tier, is_public, created_at)
			VALUES (
				${agent.id}, ${m.type}, ${String(m.content).slice(0, 10000)}, ${m.tags || []},
				${JSON.stringify({ provenance })}::jsonb, ${m.salience ?? 0.5},
				${m.tier || 'recall'}, ${m.is_public === true}, now()
			)
			RETURNING id, agent_id, type, content, tags, created_at
		`;
		imported++;
		newSignings.push(row);
	}

	// Re-sign imported memories under the new agent's wallet (best-effort).
	for (const row of newSignings) {
		try {
			await signMemoryWithAgent(row);
		} catch (err) {
			console.error('[brain] import re-sign failed', row.id, err?.message);
		}
	}

	// Optionally adopt the source persona (only if the target has none, unless
	// replace strategy). Persona prompt is signed with the platform HMAC the same
	// way the persona extractor does — but we keep the source hash as provenance.
	let personaImported = false;
	if (body.importPersona && bundle.persona?.prompt) {
		const adopt = body.strategy === 'replace' || !agent.persona_prompt_hash;
		if (adopt) {
			await sql`
				UPDATE agent_identities
				SET persona_prompt = ${bundle.persona.prompt},
				    persona_prompt_hash = ${bundle.persona.prompt_hash || null},
				    persona_tone_tags = ${JSON.stringify(bundle.persona.tone_tags || [])}::jsonb,
				    persona_extracted_at = now(),
				    updated_at = now()
				WHERE id = ${agent.id}
			`;
			personaImported = true;
		}
	}

	// Record provenance on the agent so the fork's lineage is legible.
	const meta = { ...(agent.meta || {}) };
	meta.brain_provenance = {
		source_agent_id: bundle.agent.id,
		source_agent_name: bundle.agent.name || null,
		source_brain_hash: bundle.manifest.brain_hash,
		imported_at: new Date().toISOString(),
		imported_count: imported,
		strategy: body.strategy,
	};
	await sql`UPDATE agent_identities SET meta = ${JSON.stringify(meta)}::jsonb WHERE id = ${agent.id}`;

	return json(res, 200, {
		ok: true,
		imported,
		duplicates,
		skipped_encrypted: skippedEncrypted,
		persona_imported: personaImported,
		strategy: body.strategy,
		provenance: meta.brain_provenance,
		verification: { verifiedCount: verdict.verifiedCount, signedCount: verdict.signedCount },
	});
}

export default function handler(req, res) {
	const url = new URL(req.url, 'http://x');
	const parts = url.pathname.split('/').filter(Boolean); // api agents :id brain [action]
	return handleBrain(req, res, parts[2], parts[4]);
}
