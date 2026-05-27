// GET /api/avatars        — list caller's avatars (+ optional public)
// POST /api/avatars       — create avatar metadata after upload

import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { listAvatars, createAvatar } from '../_lib/avatars.js';
import { headObject, r2 } from '../_lib/r2.js';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../_lib/env.js';
import { sql } from '../_lib/db.js';
import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { parse, createAvatarBody } from '../_lib/validate.js';
import { recordEvent } from '../_lib/usage.js';
import { defaultStorageMode } from '../_lib/storage-mode.js';
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
		limit: Number(url.searchParams.get('limit')) || 50,
		cursor: url.searchParams.get('cursor'),
		visibility: url.searchParams.get('visibility'),
		includePublic: url.searchParams.get('include_public') === 'true',
	});
	return json(res, 200, result);
}

async function handleCreate(req, res) {
	const auth = await resolveAuth(req, 'avatars:write');
	if (!auth) return error(res, 401, 'unauthorized', 'avatars:write scope required');
	const body = parse(createWithStorage, await readJson(req));

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

	// Auto-link selfie-derived avatars to the user's primary agent if it has no avatar yet.
	// Fire-and-forget — if this UPDATE fails, the 201 still returns.
	const providerHint = body.source_meta && typeof body.source_meta === 'object'
		? String(body.source_meta.provider || '').toLowerCase()
		: '';
	const autoLink = body.source === 'avaturn'
		|| body.source === 'readyplayer'
		|| providerHint === 'readyplayer'
		|| providerHint === 'readyplayerme'
		|| providerHint === 'avaturn';
	if (autoLink && auth.source === 'session') {
		queueMicrotask(async () => {
			try {
				await sql`
					WITH agent_to_update AS (
						SELECT id FROM agent_identities
						WHERE user_id = ${auth.userId}
							AND avatar_id IS NULL
							AND deleted_at IS NULL
						ORDER BY created_at ASC
						LIMIT 1
					)
					UPDATE agent_identities
					SET avatar_id = ${avatar.id}
					FROM agent_to_update
					WHERE agent_identities.id = agent_to_update.id
				`;
			} catch (err) {
				console.error('[avatars] auto-link to agent_identities failed', {
					avatarId: avatar.id,
					userId: auth.userId,
					error: err?.message,
				});
			}
		});
	}

	recordEvent({
		userId: auth.userId,
		apiKeyId: auth.apiKeyId,
		clientId: auth.clientId,
		avatarId: avatar.id,
		kind: 'upload',
		bytes: avatar.size_bytes,
	});
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
