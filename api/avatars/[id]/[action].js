// Dispatcher for /api/avatars/:id/:action
// Vercel populates req.query.id (from [id] parent dir) and req.query.action
// (from [action] filename) automatically. Each handler below is unchanged
// from its prior single-file form.

import { GetObjectCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';

import {
	getSessionUser,
	authenticateBearer,
	extractBearer,
	hasScope,
} from '../../_lib/auth.js';
import { sql } from '../../_lib/db.js';
import { cors, json, method, readJson, wrap, error } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { parse } from '../../_lib/validate.js';
import {
	readStorageMode,
	storageModeSchema,
	defaultStorageMode,
} from '../../_lib/storage-mode.js';
import { getAvatar, resolveAvatarUrl } from '../../_lib/avatars.js';
import { r2, publicUrl } from '../../_lib/r2.js';
import { env } from '../../_lib/env.js';
import { DEMO_AVATARS } from '../../_lib/demo-avatars.js';

const PINATA_ENDPOINT = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default wrap(async (req, res) => {
	const action = req.query?.action;
	// Every sub-action below ends up querying `WHERE id = $1` against a uuid
	// column. A malformed id leaks Postgres 22P02 to the caller as a 500;
	// short-circuit with a clean 404 unless it's a demo-fixture id.
	const id = req.query?.id;
	if (id && !UUID_RE.test(id) && !String(id).startsWith('avatar_demo_')) {
		return error(res, 404, 'not_found', 'avatar not found');
	}
	switch (action) {
		case 'agents':
			return handleAgentsByAvatar(req, res);
		case 'glb-versions':
			return handleGlbVersions(req, res);
		case 'pin-ipfs':
			return handlePinIpfs(req, res);
		case 'rollback':
			return handleRollback(req, res);
		case 'session':
			return handleSession(req, res);
		case 'storage-mode':
			return handleStorageMode(req, res);
		case 'thumbnail':
			return handleThumbnail(req, res);
		case 'versions':
			return handleVersions(req, res);
		default:
			return error(res, 404, 'not_found', 'unknown avatar action');
	}
});

// ── agents (public agents wearing this avatar) ────────────────────────────
// GET /api/avatars/:id/agents
// Returns up to 12 public agents (is_public = true) whose avatar_id matches.
// Public endpoint, rate-limited by IP. Demo avatars never have wearers (they
// are seeded fixtures), so we short-circuit with an empty list.

async function handleAgentsByAvatar(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const id = req.query?.id;
	if (!id) return error(res, 400, 'invalid_request', 'id required');

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	if (String(id).startsWith('avatar_demo_')) {
		return json(res, 200, { agents: [] });
	}

	const rows = await sql`
		SELECT i.id, i.name, i.description, i.profile_image_url, i.created_at,
		       i.erc8004_agent_id, i.chain_id
		  FROM agent_identities i
		 WHERE i.avatar_id = ${id}
		   AND i.deleted_at IS NULL
		   AND i.is_public = true
		 ORDER BY (i.erc8004_agent_id IS NOT NULL) DESC, i.created_at DESC
		 LIMIT 12
	`;

	const agents = rows.map((r) => ({
		id: r.id,
		name: r.name,
		description: r.description || '',
		profileImage: r.profile_image_url || null,
		onchain: r.erc8004_agent_id != null,
		chainId: r.chain_id || null,
		createdAt: r.created_at,
		url: `/agent/${r.id}`,
	}));

	res.setHeader('cache-control', 'public, max-age=30, s-maxage=120, stale-while-revalidate=600');
	return json(res, 200, { agents });
}

// ── glb-versions ───────────────────────────────────────────────────────────

async function handleGlbVersions(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const id = req.query?.id;
	if (!id) return error(res, 400, 'invalid_request', 'id required');

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	const userId = session?.id ?? bearer.userId;

	const [avatar] = await sql`
		select id from avatars
		where id = ${id} and owner_id = ${userId} and deleted_at is null
		limit 1
	`;
	if (!avatar) return error(res, 404, 'not_found', 'avatar not found');

	const rows = await sql`
		select id, glb_url, created_at, metadata
		from avatar_versions
		where avatar_id = ${id}
		order by created_at desc
		limit 50
	`;

	return json(res, 200, {
		versions: rows.map((v) => ({
			id: v.id,
			glbUrl: v.glb_url,
			createdAt: v.created_at,
			metadata: v.metadata ?? null,
		})),
	});
}

// ── pin-ipfs ───────────────────────────────────────────────────────────────

async function handlePinIpfs(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const id =
		req.query?.id || new URL(req.url, 'http://x').pathname.split('/').filter(Boolean)[2];
	if (!id) return error(res, 400, 'validation_error', 'avatar id required');

	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');

	const [row] = await sql`
		SELECT id, owner_id, checksum_sha256, storage_key, content_type, name
		FROM avatars WHERE id = ${id} AND deleted_at IS NULL
	`;
	if (!row) return error(res, 404, 'not_found', 'avatar not found');
	if (row.owner_id !== session.id) return error(res, 403, 'forbidden', 'not your avatar');

	const mode = await readStorageMode(id);
	if (!mode) return error(res, 500, 'internal', 'storage_mode unavailable');

	const pinataJwt = env.PINATA_JWT;
	let cid;
	let isStub = false;

	if (pinataJwt && row.storage_key) {
		try {
			cid = await pinToPinata({
				jwt: pinataJwt,
				key: row.storage_key,
				name: row.name || `avatar-${id}`,
				contentType: row.content_type || 'model/gltf-binary',
			});
		} catch (err) {
			return error(res, 502, 'upstream_error', `Pinata upload failed: ${err.message}`);
		}
	} else {
		isStub = true;
		cid = row.checksum_sha256 ? `stub:sha256-${row.checksum_sha256}` : `stub:no-hash-${id}`;
	}

	const next = {
		...mode,
		ipfs: { pinned: true, cid, pinned_at: new Date().toISOString() },
	};

	await sql`UPDATE avatars SET storage_mode = ${JSON.stringify(next)}::jsonb WHERE id = ${id}`;
	return json(res, 200, { storage_mode: next, stub: isStub });
}

async function pinToPinata({ jwt, key, name, contentType }) {
	const obj = await r2.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
	const bytes = await streamToBuffer(obj.Body);
	const blob = new Blob([bytes], { type: contentType });

	const form = new FormData();
	form.append('file', blob, name);
	form.append('pinataMetadata', JSON.stringify({ name }));

	const res = await fetch(PINATA_ENDPOINT, {
		method: 'POST',
		headers: { Authorization: `Bearer ${jwt}` },
		body: form,
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
	}
	const data = await res.json();
	if (!data?.IpfsHash) throw new Error('no IpfsHash in Pinata response');
	return data.IpfsHash;
}

async function streamToBuffer(stream) {
	if (stream instanceof Uint8Array) return stream;
	if (typeof stream?.transformToByteArray === 'function') {
		return stream.transformToByteArray();
	}
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	return Buffer.concat(chunks);
}

// ── rollback ───────────────────────────────────────────────────────────────

const rollbackBodySchema = z.object({
	versionId: z.coerce.number().int().positive(),
});

async function handleRollback(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const id = req.query?.id;
	if (!id) return error(res, 400, 'invalid_request', 'id required');

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	const userId = session?.id ?? bearer.userId;

	const rl = await limits.avatarRollback(userId);
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const { versionId } = parse(rollbackBodySchema, await readJson(req));

	const [avatar] = await sql`
		select id from avatars
		where id = ${id} and owner_id = ${userId} and deleted_at is null
		limit 1
	`;
	if (!avatar) return error(res, 404, 'not_found', 'avatar not found');

	const [ver] = await sql`
		select id, glb_url from avatar_versions
		where id = ${versionId} and avatar_id = ${id}
		limit 1
	`;
	if (!ver) return error(res, 404, 'not_found', 'version not found');

	const [updated] = await sql`
		update avatars
		set storage_key = ${ver.glb_url}, updated_at = now()
		where id = ${id} and owner_id = ${userId}
		returning id, owner_id, slug, name, description, storage_key, size_bytes,
		          content_type, source, visibility, tags, version, created_at, updated_at
	`;

	await sql`
		insert into avatar_versions (avatar_id, glb_url, metadata, created_by)
		values (
			${id},
			${ver.glb_url},
			${JSON.stringify({ rollback_of: versionId })}::jsonb,
			${userId}
		)
	`;

	return json(res, 200, { ok: true, avatar: updated });
}

// ── session ────────────────────────────────────────────────────────────────

async function handleSession(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const id = req.query?.id;
	if (!id) return error(res, 400, 'invalid_request', 'id required');

	const auth = await resolveSessionAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.upload(auth.userId);
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests, try again later');

	// 404 (not 403) when not found or not owned — mirrors [id].js.
	const avatar = await getAvatar({ id, requesterId: auth.userId });
	if (!avatar || avatar.owner_id !== auth.userId) {
		return error(res, 404, 'not_found', 'avatar not found');
	}

	if (!env.AVATURN_API_KEY) {
		return error(
			res,
			501,
			'not_configured',
			'Avaturn is not configured on this deployment. Set AVATURN_API_KEY.',
		);
	}

	// Resolve a time-limited URL the Avaturn upstream can fetch (works for private too).
	const { url: glbUrl } = await resolveAvatarUrl(avatar, { expiresIn: 3600 });

	try {
		const result = await createAvaturnEditSession({
			apiKey: env.AVATURN_API_KEY,
			apiUrl: env.AVATURN_API_URL,
			userId: auth.userId,
			avatarUrl: glbUrl,
		});
		return json(res, 200, result);
	} catch (err) {
		const status = err?.status || 502;
		const code = err?.code || 'upstream_error';
		const message = err?.message || 'avatar provider rejected request';
		if (status >= 500) console.error('[avatars/session] upstream failure:', err);
		return error(res, status >= 500 ? 502 : status, code, message);
	}
}

async function resolveSessionAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (!bearer) return null;
	if (!hasScope(bearer.scope, 'avatars:write')) return null;
	return { userId: bearer.userId };
}

/**
 * Opens an existing avatar in Avaturn for editing.
 * Passes `avatar_url` so Avaturn pre-populates the editor with the existing mesh.
 * If Avaturn's API uses a different field (e.g. `avatarUrl`, `model_url`), update
 * the payload mapping below and the AVATURN_API_URL env var accordingly.
 */
async function createAvaturnEditSession({ apiKey, apiUrl, userId, avatarUrl }) {
	const url = `${apiUrl}/api/v1/sessions`;
	const payload = {
		external_user_id: userId,
		avatar_url: avatarUrl,
	};

	const upstream = await fetch(url, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${apiKey}`,
			'content-type': 'application/json',
			accept: 'application/json',
		},
		body: JSON.stringify(payload),
	});

	if (!upstream.ok) {
		const text = await upstream.text().catch(() => '');
		const err = new Error(`avaturn upstream ${upstream.status}: ${text.slice(0, 200)}`);
		err.status = upstream.status >= 500 ? 502 : upstream.status;
		err.code = upstream.status === 401 ? 'upstream_auth' : 'upstream_error';
		throw err;
	}

	const data = await upstream.json();
	const sessionUrl = data?.session_url || data?.url || data?.iframe_url;
	if (!sessionUrl) {
		const err = new Error('avaturn response missing session_url');
		err.status = 502;
		err.code = 'upstream_error';
		throw err;
	}
	return { session_url: sessionUrl, expires_at: data.expires_at ?? null };
}

// ── storage-mode ───────────────────────────────────────────────────────────

async function handleStorageMode(req, res) {
	if (cors(req, res, { methods: 'GET,PUT,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'PUT'])) return;

	const id =
		req.query?.id || new URL(req.url, 'http://x').pathname.split('/').filter(Boolean)[2];
	if (!id) return error(res, 400, 'validation_error', 'avatar id required');

	const [row] = await sql`
		SELECT id, owner_id, visibility FROM avatars WHERE id = ${id} AND deleted_at IS NULL
	`;
	if (!row) return error(res, 404, 'not_found', 'avatar not found');

	if (req.method === 'GET') {
		if (row.visibility === 'private') {
			const session = await getSessionUser(req);
			if (!session || session.id !== row.owner_id)
				return error(res, 403, 'forbidden', 'private avatar');
		}
		const mode = await readStorageMode(id);
		return json(res, 200, { storage_mode: mode });
	}

	// PUT — owner only
	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');
	if (session.id !== row.owner_id) return error(res, 403, 'forbidden', 'not your avatar');

	const body = parse(storageModeSchema, await readJson(req));

	// Read current stored mode to preserve attestation fields — clients must not
	// be able to forge tx_hash / chain_id / attested_at from the UI.
	const current = await readStorageMode(id);
	const safeBody = {
		...body,
		attestation: current?.attestation ?? defaultStorageMode().attestation,
	};

	await sql`UPDATE avatars SET storage_mode = ${JSON.stringify(safeBody)}::jsonb WHERE id = ${id}`;
	return json(res, 200, { storage_mode: safeBody });
}

// ── versions ───────────────────────────────────────────────────────────────

async function handleVersions(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const id = req.query?.id;
	if (!id) return error(res, 400, 'invalid_request', 'id required');

	const auth = await resolveVersionsAuth(req);

	// Walk upward through parent_avatar_id to collect the full ancestor chain,
	// then walk downward from the root to collect all descendants.
	// Two-phase CTE keeps the query readable and avoids a self-join cycle.
	const rows = await sql`
		WITH RECURSIVE
		ancestors AS (
			SELECT id, parent_avatar_id, created_at
			FROM avatars
			WHERE id = ${id} AND deleted_at IS NULL
			UNION ALL
			SELECT a.id, a.parent_avatar_id, a.created_at
			FROM avatars a
			JOIN ancestors anc ON a.id = anc.parent_avatar_id
			WHERE a.deleted_at IS NULL
		),
		root AS (
			SELECT id FROM ancestors WHERE parent_avatar_id IS NULL LIMIT 1
		),
		chain AS (
			SELECT a.id, a.parent_avatar_id, a.created_at
			FROM avatars a
			JOIN root r ON a.id = r.id
			WHERE a.deleted_at IS NULL
			UNION ALL
			SELECT a.id, a.parent_avatar_id, a.created_at
			FROM avatars a
			JOIN chain c ON a.parent_avatar_id = c.id
			WHERE a.deleted_at IS NULL
		)
		SELECT id, created_at FROM chain ORDER BY created_at ASC
	`;

	// If the seed avatar wasn't found (deleted or wrong id), the ancestor CTE
	// returns empty → chain is also empty.
	if (!rows.length) return error(res, 404, 'not_found', 'avatar not found');

	// Determine the caller's current avatar so is_current can be set.
	let currentAvatarId = null;
	if (auth?.userId) {
		const [agent] = await sql`
			SELECT avatar_id FROM agent_identities
			WHERE user_id = ${auth.userId} AND deleted_at IS NULL
			ORDER BY created_at ASC LIMIT 1
		`;
		currentAvatarId = agent?.avatar_id ?? null;
	}

	const total = rows.length;
	const versions = rows.map((row, i) => ({
		id: row.id,
		version: i + 1,
		total,
		created_at: row.created_at,
		is_current: row.id === currentAvatarId,
	}));

	return json(res, 200, { versions });
}

async function resolveVersionsAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	return bearer ? { userId: bearer.userId } : null;
}

// ── thumbnail ──────────────────────────────────────────────────────────────
// GET /api/avatars/:id/thumbnail — 302 to the avatar's R2-hosted PNG poster.
// Public/unlisted avatars: anyone. Private: owner (session or bearer) only.
// Demo avatars: redirect to the bundled demo image. No thumbnail → 404.

async function handleThumbnail(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const id =
		req.query?.id || new URL(req.url, 'http://x').pathname.split('/').filter(Boolean)[2];
	if (!id) return error(res, 400, 'invalid_request', 'avatar id required');

	if (id.startsWith('avatar_demo_')) {
		const demo = DEMO_AVATARS.find((a) => a.avatarId === id);
		if (!demo?.image) return error(res, 404, 'not_found', 'demo avatar has no thumbnail');
		return redirect(res, demo.image);
	}

	const [row] = await sql`
		SELECT id, owner_id, visibility, thumbnail_key
		FROM avatars WHERE id = ${id} AND deleted_at IS NULL
		LIMIT 1
	`;
	if (!row) return error(res, 404, 'not_found', 'avatar not found');

	if (row.visibility === 'private') {
		const auth = await resolveVersionsAuth(req);
		if (!auth) return error(res, 401, 'unauthorized', 'sign in required');
		if (auth.userId !== row.owner_id) return error(res, 403, 'forbidden', 'not your avatar');
	}

	if (!row.thumbnail_key) return error(res, 404, 'not_found', 'avatar has no thumbnail');

	return redirect(res, publicUrl(row.thumbnail_key));
}

function redirect(res, url) {
	// 302 keeps the URL cacheable for short windows without sticking permanently —
	// the underlying thumbnail_key can change after a re-render.
	res.statusCode = 302;
	res.setHeader('location', url);
	res.setHeader('cache-control', 'public, max-age=60, s-maxage=300');
	res.end();
}
