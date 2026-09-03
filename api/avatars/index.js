// GET /api/avatars        — list caller's avatars (+ optional public)
// POST /api/avatars       — create avatar metadata after upload

import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { listAvatars, createAvatar, defaultAvatarVisibilityFor } from '../_lib/avatars.js';
import { headObject, r2 } from '../_lib/r2.js';
import { inspectStorageKeyRig } from '../_lib/rig-inspect.js';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../_lib/env.js';
import { sql } from '../_lib/db.js';
import { provisionAvatarAgent } from '../_lib/avatar-agent.js';
import { maybeAutoRigAvatar } from '../_lib/auto-rig.js';
import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { parse, createAvatarBody } from '../_lib/validate.js';
import { recordEvent } from '../_lib/usage.js';
import { markActivated } from '../_lib/activation.js';
import { dispatchWebhooks } from '../_lib/webhook-dispatch.js';
import { z } from 'zod';

const createWithStorage = createAvatarBody.extend({
	storage_key: z.string().min(1).max(512),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	if (req.method === 'GET') return handleList(req, res);
	return handleCreate(req, res);
});

async function handleList(req, res) {
	const auth = await resolveAuth(req, 'avatars:read');
	if (!auth) return error(res, 401, 'unauthorized', 'sign in or provide a valid bearer token');
	const url = new URL(req.url, 'http://x');
	const result = await listAvatars({
		userId: auth.userId,
		limit: Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200),
		cursor: url.searchParams.get('cursor'),
		visibility: url.searchParams.get('visibility'),
		includePublic: url.searchParams.get('include_public') === 'true',
	});
	return json(res, 200, result);
}

async function handleCreate(req, res) {
	const auth = await resolveAuth(req, 'avatars:write');
	if (!auth) return error(res, 401, 'unauthorized', 'avatars:write scope required');
	const raw = await readJson(req);
	const body = parse(createWithStorage, raw);

	// A caller that names a visibility always wins. Only when the request is
	// silent does the owner's "Default avatar visibility" preference from
	// /settings apply; with no preference stored it resolves to the same
	// 'private' the schema has always defaulted to.
	if (raw?.visibility === undefined) {
		body.visibility = await defaultAvatarVisibilityFor(auth.userId, 'private');
	}

	// Storage keys are scoped by userId (see storageKeyFor). Enforce that the
	// caller can only register objects under their own prefix — otherwise a
	// user could claim another user's freshly uploaded object.
	const expectedPrefix = `u/${auth.userId}/`;
	if (!body.storage_key.startsWith(expectedPrefix) || body.storage_key.includes('..')) {
		return error(res, 400, 'invalid_storage_key', 'storage_key not owned by caller');
	}

	// Verify the object actually exists in R2 and matches the claimed size.
	const head = await headObject(body.storage_key);
	if (!head) return error(res, 400, 'upload_missing', 'no object at storage_key; upload first');
	if (Number(head.ContentLength) !== body.size_bytes) {
		return error(res, 400, 'size_mismatch', 'size_bytes does not match uploaded object');
	}

	// Attempt to read sha256 from R2 (only present if the browser upload included it).
	// Use ChecksumMode: ENABLED for a lightweight HEAD — no body download.
	if (!body.checksum_sha256) {
		try {
			const headChecked = await r2.send(
				new HeadObjectCommand({
					Bucket: env.S3_BUCKET,
					Key: body.storage_key,
					ChecksumMode: 'ENABLED',
				}),
			);
			if (headChecked?.ChecksumSHA256) {
				// R2 returns base64; convert to lowercase hex.
				body.checksum_sha256 = Buffer.from(headChecked.ChecksumSHA256, 'base64').toString(
					'hex',
				);
			}
		} catch {
			// ChecksumMode unsupported or object has no checksum — leave null, not fatal.
		}
	}

	// Validate parent_avatar_id ownership — prevents user B from pointing at user A's avatar chain.
	if (body.parent_avatar_id) {
		const rows = await sql`
			select 1 from avatars
			where id = ${body.parent_avatar_id} and owner_id = ${auth.userId} and deleted_at is null
			limit 1
		`;
		if (!rows[0]) return error(res, 404, 'not_found', 'parent_avatar_id not found');
	}

	// Skeleton-inspect the uploaded GLB so the rig classifier (gallery filter,
	// per-card badge, "Rigged first" sort) knows whether it can animate. Only the
	// glTF JSON chunk is read via a ranged request — never the mesh binary — so
	// this is one small round trip. Best-effort: any failure leaves the rig fields
	// absent and the avatar reads as "unknown", exactly as before. Paths that
	// already stamp the signal (reconstruct, forge, studio) pass their own
	// source_meta; we only fill what inspection found and never clobber it.
	const looksGlb =
		/\.glb$/i.test(body.storage_key) ||
		(body.content_type || head.ContentType || '').includes('gltf-binary');
	if (looksGlb && (!body.source_meta || body.source_meta.is_rigged == null)) {
		try {
			const rig = await inspectStorageKeyRig(body.storage_key);
			if (rig) body.source_meta = { ...rig, ...(body.source_meta || {}) };
		} catch {
			// non-fatal — classifier degrades to "unknown" for this avatar
		}
	}

	const avatar = await createAvatar({
		userId: auth.userId,
		input: body,
		storageKey: body.storage_key,
	});

	dispatchWebhooks({
		userId: auth.userId,
		eventType: 'avatar.created',
		data: { id: avatar.id, name: avatar.name, slug: avatar.slug, source: body.source },
	}).catch(() => {});

	// Re-point any agent identity that currently uses the parent avatar.
	// agentId, wallet_address, chain_id, and erc8004_agent_id are unchanged.
	if (body.parent_avatar_id) {
		await sql`
			update agent_identities
			set avatar_id = ${avatar.id}
			where user_id = ${auth.userId}
			  and avatar_id = ${body.parent_avatar_id}
			  and deleted_at is null
		`;
	}

	// Every new avatar gets an agent. Skip if this is a re-upload of an existing avatar
	// (parent_avatar_id set) — the re-point above already handled that case.
	// Fire-and-forget — 201 returns regardless.
	if (!body.parent_avatar_id) {
		queueMicrotask(() =>
			provisionAvatarAgent({
				userId: auth.userId,
				avatarId: avatar.id,
				avatarName: avatar.name,
				provenance: {
					prompt: body.source_meta?.source_prompt || body.source_meta?.prompt || null,
					generationModel: body.source_meta?.generator || body.source_meta?.model || null,
					generationProvider: body.source_meta?.provider || null,
					parentAvatarId: null,
				},
			}),
		);

		// Auto-rig any static upload/import so the agent's avatar can animate, the
		// same way Avaturn ships rigged avatars. A no-op when the GLB already has a
		// skeleton (the inspection above stamped is_rigged) or no rerig model is
		// configured. Fire-and-forget — the avatar is upgraded in place once the
		// rig job lands (webhook / status poll); 201 returns immediately.
		queueMicrotask(() =>
			maybeAutoRigAvatar({
				userId: auth.userId,
				avatar,
				rigInfo: body.source_meta,
				source: body.source || 'upload',
				visibility: avatar.visibility,
				prompt: body.source_meta?.source_prompt || body.source_meta?.prompt || null,
			}),
		);
	}

	recordEvent({
		userId: auth.userId,
		apiKeyId: auth.apiKeyId,
		clientId: auth.clientId,
		avatarId: avatar.id,
		kind: 'upload',
		bytes: avatar.size_bytes,
	});
	// First win: a real avatar in hand. Activates the account once (and pays the
	// two-sided referral reward if this user was referred). Fire-and-forget.
	queueMicrotask(() => markActivated(auth.userId, { source: 'avatar_create', meta: { avatarId: avatar.id } }));
	return json(res, 201, { avatar });
}

async function resolveAuth(req, requiredScope) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id, source: 'session' };
	const bearer = await authenticateBearer(extractBearer(req));
	if (!bearer) return null;
	if (!hasScope(bearer.scope, requiredScope)) return null;
	return bearer;
}
