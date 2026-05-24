// GET    /api/avatars/:id            — fetch one (public if visibility allows, else requires auth)
// PATCH  /api/avatars/:id            — update metadata (owner only)
// DELETE /api/avatars/:id            — soft-delete (owner only)
// Also dispatches: presign, public, regenerate, regenerate-status (action endpoints)

import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import {
	getAvatar,
	updateAvatar,
	deleteAvatar,
	resolveAvatarUrl,
	stripOwnerFor,
} from '../_lib/avatars.js';
import { bakeAndUploadAppearance, isBakeable } from '../_lib/bake.js';
import { sql } from '../_lib/db.js';
import { logAudit } from '../_lib/audit.js';
import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { headObject } from '../_lib/r2.js';
import { limits } from '../_lib/rate-limit.js';
import { recordEvent } from '../_lib/usage.js';
import { z } from 'zod';
import { avatarVisibility, avatarAppearance, parse } from '../_lib/validate.js';
import { DEMO_AVATARS } from '../_lib/demo-avatars.js';

const patchSchema = z.object({
	name: z.string().trim().min(1).max(120).optional(),
	description: z.string().trim().max(2000).optional(),
	visibility: avatarVisibility.optional(),
	tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
	thumbnail_key: z.string().min(1).max(512).optional(),
	usdz_key: z.string().min(1).max(512).optional(),
	halfbody_key: z.string().min(1).max(512).optional(),
	// `null` clears the dress-up state. Omit the field entirely to leave it untouched.
	appearance: avatarAppearance.nullable().optional(),
});

// Action endpoints that share this file (no id needed)
const ACTION_ENDPOINTS = new Set([
	'presign',
	'upload',
	'presign-thumbnail',
	'presign-usdz',
	'presign-halfbody',
	'auto-tag',
	'public',
	'reconstruct',
	'regenerate',
	'regenerate-status',
]);

export default wrap(async (req, res) => {
	const id = req.query?.id || new URL(req.url, 'http://x').pathname.split('/').pop();
	if (!id) return error(res, 400, 'invalid_request', 'id required');

	// Dispatch named action endpoints (presign, public, regenerate, regenerate-status)
	if (ACTION_ENDPOINTS.has(id)) {
		const mod = await import('./_actions.js');
		return mod.dispatch(id, req, res);
	}

	if (cors(req, res, { methods: 'GET,PATCH,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'PATCH', 'DELETE'])) return;

	const auth = await resolveAuth(req);

	if (req.method === 'GET') {
		// Demo avatars (avatar_demo_*) are seeded fixtures, not DB rows.
		// Resolve them from DEMO_AVATARS so the detail page works for them too.
		if (id.startsWith('avatar_demo_')) {
			const demo = DEMO_AVATARS.find((a) => a.avatarId === id);
			if (!demo) return error(res, 404, 'not_found', 'avatar not found');
			return json(res, 200, {
				avatar: {
					id: demo.avatarId,
					slug: demo.slug,
					name: demo.name,
					description: demo.description,
					tags: demo.tags,
					visibility: 'public',
					source: 'demo',
					storage_key: null,
					size_bytes: null,
					content_type: 'model/gltf-binary',
					created_at: demo.createdAt,
					updated_at: demo.createdAt,
					thumbnail_url: demo.image,
					model_url: demo.glbUrl,
					url: demo.glbUrl,
					cdn: true,
					attribution: demo.attribution || null,
					author: demo.author || null,
					demo: true,
				},
			});
		}
		const avatar = await getAvatar({ id, requesterId: auth?.userId });
		if (!avatar) return error(res, 404, 'not_found', 'avatar not found');
		const urlInfo = await resolveAvatarUrl(avatar);
		const [priceRow] = await sql`
			SELECT amount, currency_mint, chain, mint_decimals
			FROM asset_prices
			WHERE item_type = 'avatar' AND item_id = ${id} AND is_active = true
			LIMIT 1
		`;
		const price = priceRow
			? {
				amount: String(priceRow.amount),
				currency_mint: priceRow.currency_mint,
				chain: priceRow.chain,
				mint_decimals: priceRow.mint_decimals ?? 6,
			}
			: null;
		recordEvent({
			userId: auth?.userId,
			clientId: auth?.clientId,
			apiKeyId: auth?.apiKeyId,
			avatarId: id,
			kind: 'avatar_fetch',
		});
		return json(res, 200, { avatar: stripOwnerFor({ ...avatar, ...urlInfo, price }, auth?.userId) });
	}

	if (!auth?.userId) return error(res, 401, 'unauthorized', 'authentication required');

	if (req.method === 'PATCH') {
		if (auth.source === 'oauth' || auth.source === 'apikey') {
			if (!hasScope(auth.scope, 'avatars:write'))
				return error(res, 403, 'insufficient_scope', 'avatars:write required');
		}
		const body = await readJson(req);
		if (body && typeof body.glbUrl === 'string') {
			return handleGlbPatch(res, auth, id, body.glbUrl);
		}
		const patch = parse(patchSchema, body);
		const appearanceChanged = Object.prototype.hasOwnProperty.call(patch, 'appearance');

		let avatar = await updateAvatar({ id, userId: auth.userId, patch });
		if (!avatar) return error(res, 404, 'not_found', 'avatar not found or not yours');

		// When the appearance just changed, run the bake synchronously so the
		// caller sees the dressed GLB on the very next GET. A failure here is
		// non-fatal — the appearance is already persisted; the lazy-bake path on
		// the next read will retry. Bake of an empty appearance clears the cached
		// baked GLB so the base is served again.
		if (appearanceChanged) {
			try {
				if (isBakeable(patch.appearance)) {
					const result = await bakeAndUploadAppearance({
						baseStorageKey: avatar.storage_key,
						appearance: patch.appearance,
					});
					if (result) {
						avatar = await updateAvatar({
							id,
							userId: auth.userId,
							patch: {
								baked_storage_key: result.baked_storage_key,
								appearance_hash: result.appearance_hash,
							},
						});
					}
				} else {
					// Empty / cleared appearance — drop the stale baked pointer so the
					// base GLB is served again.
					avatar = await updateAvatar({
						id,
						userId: auth.userId,
						patch: { baked_storage_key: null, appearance_hash: null },
					});
				}
			} catch (err) {
				console.warn('[avatars] bake failed', {
					avatarId: id,
					message: err?.message,
				});
				avatar.bake_error = err?.message || 'bake_failed';
			}
		}

		return json(res, 200, { avatar });
	}

	// DELETE
	if (auth.source === 'oauth' || auth.source === 'apikey') {
		if (!hasScope(auth.scope, 'avatars:delete'))
			return error(res, 403, 'insufficient_scope', 'avatars:delete required');
	}
	const ok = await deleteAvatar({ id, userId: auth.userId });
	if (!ok) return error(res, 404, 'not_found', 'avatar not found or not yours');
	logAudit({
		userId: auth.userId,
		action: 'delete_avatar',
		resourceId: id,
		meta: { via: auth.source },
	});
	return json(res, 200, { ok: true });
});

const MAX_GLB_BYTES = 25 * 1024 * 1024;
const VALID_GLB_TYPES = new Set(['model/gltf-binary', 'application/octet-stream']);

async function handleGlbPatch(res, auth, id, glbUrl) {
	const rl = await limits.avatarPatch(auth.userId);
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many patch requests');

	if (!/^u\/[^/]+\/.+\.glb$/.test(glbUrl)) {
		return error(
			res,
			400,
			'invalid_request',
			'glbUrl must be a valid R2 storage key (u/{userId}/...)',
		);
	}
	if (!glbUrl.startsWith(`u/${auth.userId}/`)) {
		return error(res, 403, 'forbidden', 'key does not belong to your storage namespace');
	}

	const head = await headObject(glbUrl);
	if (!head) return error(res, 404, 'not_found', 'glb object not found in storage');
	if (head.ContentLength > MAX_GLB_BYTES) {
		return error(res, 413, 'payload_too_large', 'glb exceeds 25 MB limit');
	}
	if (!VALID_GLB_TYPES.has(head.ContentType)) {
		return error(
			res,
			415,
			'unsupported_media_type',
			'content-type must be model/gltf-binary or application/octet-stream',
		);
	}

	const rows =
		await sql`select id, owner_id from avatars where id = ${id} and deleted_at is null limit 1`;
	const avatar = rows[0];
	if (!avatar) return error(res, 404, 'not_found', 'avatar not found');
	if (avatar.owner_id !== auth.userId)
		return error(res, 403, 'forbidden', 'you do not own this avatar');

	try {
		await sql`insert into avatar_versions (avatar_id, storage_key, created_by) values (${id}, ${glbUrl}, ${auth.userId})`;
	} catch (e) {
		if (e?.code === '42P01' || String(e?.message).includes('does not exist')) {
			console.warn('avatar_versions table missing — skipping version insert');
		} else {
			throw e;
		}
	}

	const [updated] = await sql`
		update avatars set storage_key = ${glbUrl}, updated_at = now()
		where id = ${id} and owner_id = ${auth.userId} and deleted_at is null
		returning id, storage_key, updated_at
	`;

	return json(res, 200, {
		ok: true,
		avatar: {
			id: updated.id,
			currentGlbUrl: updated.storage_key,
			updatedAt: updated.updated_at,
		},
	});
}

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session)
		return {
			userId: session.id,
			source: 'session',
			scope: 'avatars:read avatars:write avatars:delete',
		};
	const bearer = await authenticateBearer(extractBearer(req));
	return bearer;
}
