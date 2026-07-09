// Avatar service — CRUD + quota enforcement + URL resolution.
// Keep handler code small by routing through this.

import { createHash } from 'node:crypto';
import { sql } from './db.js';
import { publicUrl, presignGet, deleteObject } from './r2.js';
import { defaultStorageMode } from './storage-mode.js';
import { isUuid } from './validate.js';

export async function listAvatars({
	userId,
	limit = 50,
	cursor,
	visibility,
	includePublic = false,
}) {
	limit = Math.min(Math.max(limit, 1), 200);
	const params = [userId];
	const conds = ['a.deleted_at is null'];
	conds.push(includePublic ? `(a.owner_id = $1 or a.visibility = 'public')` : `a.owner_id = $1`);
	if (visibility) {
		params.push(visibility);
		conds.push(`a.visibility = $${params.length}`);
	}
	if (cursor) {
		params.push(new Date(cursor));
		conds.push(`a.created_at < $${params.length}`);
	}
	params.push(limit + 1);
	// usdz_key / halfbody_key are intentionally NOT selected here yet — the
	// 20260515 migration adds them but is rolled out separately. The decorate()
	// helper falls back to null if the columns are missing from the row, so
	// listAvatars stays safe on prod before the migration runs.
	const rows = await sql(
		`select a.id, a.owner_id, a.slug, a.name, a.description, a.storage_key, a.thumbnail_key,
		        a.alt_text,
		        a.appearance, a.appearance_hash, a.baked_storage_key, a.baked_at,
		        a.size_bytes, a.content_type, a.source, a.source_meta, a.fork_count, a.visibility, a.tags, a.version,
		        a.model_category,
		        a.created_at, a.updated_at, a.parent_avatar_id,
		        ai.id as agent_id, ai.wallet_address as agent_wallet_address,
		        ai.solana_address as agent_solana_address,
		        ai.solana_vanity_prefix as agent_solana_vanity_prefix,
		        ai.solana_vanity_suffix as agent_solana_vanity_suffix
		 from avatars a
		 left join lateral (
		   select id, wallet_address,
		          meta->>'solana_address' as solana_address,
		          meta->>'solana_vanity_prefix' as solana_vanity_prefix,
		          meta->>'solana_vanity_suffix' as solana_vanity_suffix
		   from agent_identities
		   where avatar_id = a.id and user_id = $1 and deleted_at is null
		   order by created_at asc limit 1
		 ) ai on true
		 where ${conds.join(' and ')}
		 order by a.created_at desc limit $${params.length}`,
		params,
	);
	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	return {
		avatars: page.map(decorate),
		next_cursor: hasMore ? new Date(page[page.length - 1].created_at).toISOString() : null,
	};
}

export async function getAvatar({ id, requesterId = null }) {
	// Non-UUID ids (e.g. "badid", "undefined") would cause a Postgres 22P02
	// error when cast to uuid. Short-circuit with null — callers already
	// handle null as "not found".
	if (!isUuid(id)) return null;

	const rows = await sql`
		select a.*, ai.id as agent_id, ai.wallet_address as agent_wallet_address,
		       ai.solana_address as agent_solana_address,
		       ai.solana_vanity_prefix as agent_solana_vanity_prefix,
		       ai.solana_vanity_suffix as agent_solana_vanity_suffix
		from avatars a
		left join lateral (
			select id, wallet_address,
			       meta->>'solana_address' as solana_address,
			       meta->>'solana_vanity_prefix' as solana_vanity_prefix,
			       meta->>'solana_vanity_suffix' as solana_vanity_suffix
			from agent_identities
			where avatar_id = a.id and user_id = ${requesterId} and deleted_at is null
			order by created_at asc limit 1
		) ai on true
		where a.id = ${id} and a.deleted_at is null limit 1
	`;
	const row = rows[0];
	if (!row) return null;
	if (row.visibility === 'private' && row.owner_id !== requesterId) return null;
	return decorate(row);
}

export async function getAvatarBySlug({ ownerId, slug, requesterId = null }) {
	const rows = await sql`
		select * from avatars where owner_id = ${ownerId} and slug = ${slug} and deleted_at is null limit 1
	`;
	const row = rows[0];
	if (!row) return null;
	if (row.visibility === 'private' && row.owner_id !== requesterId) return null;
	return decorate(row);
}

export async function createAvatar({ userId, input, storageKey }) {
	await enforceQuotas(userId, input.size_bytes);
	const finalSlug = input.slug || (await generateSlug(userId, input.name));
	const storageMode = defaultStorageMode({
		storage_key: storageKey,
		checksum_sha256: input.checksum_sha256 ?? null,
	});
	// Internal-only seed thumbnail (deliberately absent from createAvatarBody, so
	// API clients cannot set it): callers that already have a rendered preview in
	// R2 (auto-rig siblings cloning their source's thumbnail, seed crons adopting
	// a forge preview) pass its key so the avatar never sits thumbnail-less
	// waiting for the backfill cron. Relative R2 keys only — an absolute URL in
	// thumbnail_key resolves against an origin where no object lives (see
	// api/_lib/avatar-thumbs.js).
	const thumbnailKey =
		typeof input.thumbnail_key === 'string' && input.thumbnail_key && !/^https?:\/\//.test(input.thumbnail_key)
			? input.thumbnail_key
			: null;
	const [row] = await sql`
		insert into avatars (
			owner_id, slug, name, description, storage_key, size_bytes, content_type,
			source, source_meta, thumbnail_key, visibility, tags, checksum_sha256, parent_avatar_id,
			storage_mode, appearance
		) values (
			${userId}, ${finalSlug}, ${input.name}, ${input.description ?? null},
			${storageKey}, ${input.size_bytes}, ${input.content_type},
			${input.source}, ${JSON.stringify(input.source_meta)}::jsonb,
			${thumbnailKey},
			${input.visibility}, ${input.tags}, ${input.checksum_sha256 ?? null},
			${input.parent_avatar_id ?? null},
			${JSON.stringify(storageMode)}::jsonb,
			${input.appearance ? JSON.stringify(input.appearance) : null}::jsonb
		) returning *
	`;
	return decorate(row);
}

export async function updateAvatar({ id, userId, patch }) {
	const hasAppearance = Object.prototype.hasOwnProperty.call(patch, 'appearance');
	const hasBaked = Object.prototype.hasOwnProperty.call(patch, 'baked_storage_key');

	if (
		patch.name === undefined &&
		patch.description === undefined &&
		patch.visibility === undefined &&
		patch.tags === undefined &&
		patch.thumbnail_key === undefined &&
		patch.usdz_key === undefined &&
		patch.halfbody_key === undefined &&
		patch.model_category === undefined &&
		!hasAppearance &&
		!hasBaked
	) {
		return getAvatar({ id, requesterId: userId });
	}
	// Storage keys are scoped under u/<userId>/ — refuse to write keys that
	// point outside the caller's namespace, which would let one user claim an
	// object uploaded into another user's prefix.
	for (const k of ['thumbnail_key', 'usdz_key', 'halfbody_key', 'baked_storage_key']) {
		const v = patch[k];
		if (v !== undefined && v !== null && !v.startsWith(`u/${userId}/`)) {
			throw Object.assign(new Error(`${k} must live under u/${userId}/`), {
				status: 400,
				code: 'invalid_storage_key',
			});
		}
	}
	// Two distinct write paths so the JSON-only PATCH stays cheap and so a bake
	// completion can land its three fields atomically without re-reading the row.
	if (hasBaked) {
		const [row] = await sql`
			update avatars set
				baked_storage_key = ${patch.baked_storage_key ?? null},
				appearance_hash   = ${patch.appearance_hash ?? null},
				baked_at          = case when ${patch.baked_storage_key ?? null}::text is not null
				                         then now() else null end,
				updated_at        = now()
			where id = ${id} and owner_id = ${userId} and deleted_at is null
			returning *
		`;
		return row ? decorate(row) : null;
	}

	// Coalesce-style update keeps the statement static and safe against dynamic composition.
	// `appearance` uses the explicit `hasAppearance` flag because null is a valid value
	// (means "clear the dress-up state"); coalesce would let null fall through unchanged.
	//
	// NOTE on usdz_key / halfbody_key: the 20260515 migration adds those columns
	// but ships separately. Referencing them in this static UPDATE would crash
	// every avatar edit on prod before the migration runs. Until the migration
	// is rolled out, those PATCH fields are silently dropped here; the demo
	// pages under /demos/ write them via a separate code path that no-ops on
	// "column does not exist".
	const [row] = await sql`
		update avatars set
			name           = coalesce(${patch.name ?? null}, name),
			description    = coalesce(${patch.description ?? null}, description),
			visibility     = coalesce(${patch.visibility ?? null}, visibility),
			tags           = coalesce(${patch.tags ?? null}::text[], tags),
			thumbnail_key  = coalesce(${patch.thumbnail_key ?? null}, thumbnail_key),
			model_category = coalesce(${patch.model_category ?? null}, model_category),
			appearance     = case when ${hasAppearance}::bool
			                      then ${patch.appearance ? JSON.stringify(patch.appearance) : null}::jsonb
			                      else appearance end,
			updated_at     = now()
		where id = ${id} and owner_id = ${userId} and deleted_at is null
		returning *
	`;
	return row ? decorate(row) : null;
}

export async function deleteAvatar({ id, userId }) {
	const rows = await sql`
		update avatars set deleted_at = now()
		where id = ${id} and owner_id = ${userId} and deleted_at is null
		returning storage_key, thumbnail_key
	`;
	const row = rows[0];
	if (!row) return false;
	// Fire-and-forget object delete — DB row is source of truth.
	queueMicrotask(async () => {
		try {
			await deleteObject(row.storage_key);
		} catch (e) {
			console.warn('r2 delete failed', e?.message);
		}
		if (row.thumbnail_key)
			try {
				await deleteObject(row.thumbnail_key);
			} catch {}
	});
	return true;
}

// Normalize the public `rigged` query param into one of the classifier buckets,
// or null for "no rig filter". Accepts the booleanish forms the UI sends
// (true/false/1/0/yes/no) plus the explicit bucket names.
function normalizeRigFilter(rigged) {
	if (rigged == null || rigged === '') return null;
	const v = String(rigged).trim().toLowerCase();
	if (v === 'true' || v === '1' || v === 'yes' || v === 'rigged') return 'rigged';
	if (v === 'false' || v === '0' || v === 'no' || v === 'static') return 'static';
	if (v === 'unknown') return 'unknown';
	return null;
}

export async function searchPublicAvatars({
	q,
	tag,
	category,
	rigged,
	limit = 24,
	cursor,
	withTotals = false,
}) {
	limit = Math.min(Math.max(limit, 1), 100);
	const params = [];
	const conds = [`deleted_at is null`, `visibility = 'public'`];
	if (q) {
		params.push('%' + q + '%');
		conds.push(`(name ilike $${params.length} or description ilike $${params.length})`);
	}
	if (tag) {
		params.push(tag);
		conds.push(`$${params.length} = any(tags)`);
	}
	if (category) {
		params.push(category);
		conds.push(`model_category = $${params.length}`);
	}
	// Rig classifier filter. Mirrors classifyRig() in src/shared/rig-classify.js
	// exactly so a server-filtered list and a client-painted badge never disagree:
	// a model is "rigged" iff source_meta.is_rigged is true OR it carries a
	// positive skeleton_joint_count. The joint test uses a regex (matching any
	// integer ≥ 1) rather than an ::int cast so a malformed JSONB value can never
	// throw — it simply fails to match and the model reads as "not rigged".
	const RIG_SIGNAL = `(
		(source_meta->>'is_rigged') = 'true'
		or source_meta->>'skeleton_joint_count' ~ '^[1-9][0-9]*$'
	)`;
	const rigState = normalizeRigFilter(rigged);
	if (rigState === 'rigged') {
		conds.push(RIG_SIGNAL);
	} else if (rigState === 'static') {
		// Everything that is NOT rigged — both confirmed-static meshes and
		// never-inspected uploads. From a user's standpoint both need rigging
		// before they animate, so they belong in the same "not rigged" bucket.
		conds.push(`not ${RIG_SIGNAL}`);
	} else if (rigState === 'unknown') {
		// Never skeleton-inspected: no is_rigged flag and no joint count.
		conds.push(
			`(source_meta->>'is_rigged') is null and (source_meta->>'skeleton_joint_count' is null or source_meta->>'skeleton_joint_count' !~ '^[1-9][0-9]*$')`,
		);
	}
	const filterParams = params.slice();
	const filterConds = conds.join(' and ');
	if (cursor) {
		params.push(new Date(cursor));
		conds.push(`created_at < $${params.length}`);
	}
	params.push(limit + 1);
	// usdz_key / halfbody_key are intentionally NOT selected here yet — see the
	// matching comment in listAvatars(). decorate() returns null for both when
	// the columns are absent from the row.
	// Surface the on-chain status of the agent this avatar represents so the
	// public gallery can show the same "deployed on-chain" badge as everywhere
	// else. Only the public `meta->'onchain'` block is exposed (never secrets);
	// a deployed agent is preferred over an undeployed one for the same avatar.
	const rows = await sql(
		`select av.id, av.owner_id, av.slug, av.name, av.description, av.storage_key, av.thumbnail_key,
		        av.alt_text, av.model_category,
		        av.appearance, av.appearance_hash, av.baked_storage_key, av.baked_at,
		        av.size_bytes,
		        av.content_type, av.source, av.source_meta, av.fork_count, av.visibility, av.tags, av.view_count, av.created_at,
		        ai.id as agent_id, ai.onchain as agent_onchain,
		        ai.solana_address as agent_solana_address,
		        ai.solana_vanity_prefix as agent_solana_vanity_prefix,
		        ai.solana_vanity_suffix as agent_solana_vanity_suffix
		 from avatars av
		 left join lateral (
		   select id, meta->'onchain' as onchain,
		          meta->>'solana_address' as solana_address,
		          meta->>'solana_vanity_prefix' as solana_vanity_prefix,
		          meta->>'solana_vanity_suffix' as solana_vanity_suffix
		   from agent_identities
		   where avatar_id = av.id and owner_id = av.owner_id and deleted_at is null
		   order by (meta->'onchain') is not null desc, created_at asc limit 1
		 ) ai on true
		 where ${conds.join(' and ')}
		 order by av.created_at desc limit $${params.length}`,
		params,
	);
	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	const result = {
		avatars: page.map(decorate),
		next_cursor: hasMore ? new Date(page[page.length - 1].created_at).toISOString() : null,
	};
	if (withTotals) {
		const totalsRow = await sql(
			`select count(*)::int as total,
			        coalesce(sum(view_count), 0)::bigint as total_views
			 from avatars where ${filterConds}`,
			filterParams,
		);
		result.total = totalsRow[0]?.total ?? 0;
		result.total_views = Number(totalsRow[0]?.total_views ?? 0);
	}
	return result;
}

// Public forks of an avatar — the GitHub-style "forked by" network. Only
// public/unlisted forks are listed (private forks stay invisible to the source
// owner), newest first, with the forker's display name for attribution.
export async function listForks({ avatarId, limit = 24, cursor }) {
	if (!isUuid(avatarId)) return { forks: [], next_cursor: null };
	limit = Math.min(Math.max(limit, 1), 100);
	const params = [avatarId];
	const conds = [
		'a.parent_avatar_id = $1',
		'a.deleted_at is null',
		`a.visibility in ('public','unlisted')`,
	];
	if (cursor) {
		params.push(new Date(cursor));
		conds.push(`a.created_at < $${params.length}`);
	}
	params.push(limit + 1);
	const rows = await sql(
		`select a.id, a.slug, a.name, a.thumbnail_key, a.storage_key, a.visibility,
		        a.created_at, a.fork_count, u.display_name as owner_name
		 from avatars a join users u on u.id = a.owner_id
		 where ${conds.join(' and ')}
		 order by a.created_at desc limit $${params.length}`,
		params,
	);
	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	return {
		forks: page.map((r) => ({
			id: r.id,
			slug: r.slug,
			name: r.name,
			owner_name: r.owner_name || null,
			visibility: r.visibility,
			fork_count: Number(r.fork_count || 0),
			created_at: r.created_at,
			thumbnail_url: r.thumbnail_key ? publicUrl(r.thumbnail_key) : null,
			model_url:
				r.visibility === 'public' || r.visibility === 'unlisted'
					? publicUrl(r.storage_key)
					: null,
		})),
		next_cursor: hasMore ? new Date(page[page.length - 1].created_at).toISOString() : null,
	};
}

export async function resolveAvatarUrl(row, { expiresIn = 600 } = {}) {
	const key = _servedStorageKey(row);
	if (row.visibility === 'public' || row.visibility === 'unlisted') {
		return { url: publicUrl(key), cdn: true };
	}
	return {
		url: await presignGet({ key, expiresIn }),
		cdn: false,
		expires_in: expiresIn,
	};
}

// Public so the PATCH handler can decide whether to bake without re-reading.
export function isBakedFresh(row) {
	if (!row.baked_storage_key || !row.appearance_hash || !row.appearance) return false;
	return row.appearance_hash === _hashAppearance(row.appearance);
}

export { _hashAppearance as appearanceHash };

function _servedStorageKey(row) {
	if (isBakedFresh(row)) return row.baked_storage_key;
	return row.storage_key;
}

// ── quotas ───────────────────────────────────────────────────────────────────
export async function enforceQuotas(userId, incomingBytes) {
	const rows = await sql`
		select u.plan, q.max_avatars, q.max_bytes_per_avatar, q.max_total_bytes,
		       (select count(*) from avatars a where a.owner_id = u.id and a.deleted_at is null) as avatar_count,
		       (select coalesce(sum(size_bytes),0) from avatars a where a.owner_id = u.id and a.deleted_at is null) as total_bytes
		from users u join plan_quotas q on q.plan = u.plan
		where u.id = ${userId}
		limit 1
	`;
	const q = rows[0];
	if (!q) throw Object.assign(new Error('user not found'), { status: 404 });
	if (incomingBytes > q.max_bytes_per_avatar) {
		throw Object.assign(new Error(`file too large for plan ${q.plan}`), {
			status: 413,
			code: 'plan_limit_size',
		});
	}
	if (q.avatar_count >= q.max_avatars) {
		throw Object.assign(new Error(`avatar count limit reached on plan ${q.plan}`), {
			status: 402,
			code: 'plan_limit_count',
		});
	}
	if (Number(q.total_bytes) + incomingBytes > Number(q.max_total_bytes)) {
		throw Object.assign(new Error(`storage limit reached on plan ${q.plan}`), {
			status: 402,
			code: 'plan_limit_storage',
		});
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────
function decorate(row) {
	const bakedFresh = isBakedFresh(row);
	const servedStorageKey = _servedStorageKey(row);

	return {
		id: row.id,
		owner_id: row.owner_id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		storage_key: row.storage_key,
		size_bytes: Number(row.size_bytes),
		content_type: row.content_type,
		source: row.source,
		source_meta: row.source_meta || {},
		// GitHub-style fork lineage. `forked_from` (captured at fork time in
		// source_meta) names the original avatar + owner so the UI can render a
		// "Forked from @owner" link without a join. `fork_count` is how many
		// times THIS avatar has itself been forked by others.
		forked_from: (row.source_meta && row.source_meta.forked_from) || null,
		fork_count: row.fork_count == null ? 0 : Number(row.fork_count),
		model_category: row.model_category || 'avatar',
		visibility: row.visibility,
		tags: row.tags || [],
		version: row.version,
		// Vision-generated accessibility description of the thumbnail (T4.1).
		// Null until generated/backfilled; gallery falls back to the name.
		alt_text: row.alt_text || null,
		view_count: row.view_count == null ? 0 : Number(row.view_count),
		created_at: row.created_at,
		updated_at: row.updated_at,
		model_url:
			row.visibility === 'public' || row.visibility === 'unlisted'
				? publicUrl(servedStorageKey)
				: null,
		base_model_url:
			row.visibility === 'public' || row.visibility === 'unlisted'
				? publicUrl(row.storage_key)
				: null,
		parent_avatar_id: row.parent_avatar_id || null,
		thumbnail_url: row.thumbnail_key ? publicUrl(row.thumbnail_key) : null,
		usdz_url: row.usdz_key ? publicUrl(row.usdz_key) : null,
		halfbody_url: row.halfbody_key ? publicUrl(row.halfbody_key) : null,
		appearance: row.appearance || null,
		appearance_hash: row.appearance_hash || null,
		baked: bakedFresh,
		baked_at: row.baked_at || null,
		agent_id: row.agent_id || null,
		agent_wallet_address: row.agent_wallet_address || null,
		agent_solana_address: row.agent_solana_address || null,
		agent_solana_vanity_prefix: row.agent_solana_vanity_prefix || null,
		agent_solana_vanity_suffix: row.agent_solana_vanity_suffix || null,
		// On-chain block of the agent this avatar represents (public gallery only;
		// null for callers whose query doesn't join it). Shape mirrors meta.onchain
		// so the shared onchain badge can read it directly via `{ onchain }`.
		onchain: row.agent_onchain || null,
	};
}

// Local copy of the canonical-JSON hash from bake.js so getAvatar()/listAvatars()
// stay cheap (no @gltf-transform import). Must stay identical to bake.js's
// appearanceHash() output — change both together.
function _hashAppearance(appearance) {
	return createHash('sha256').update(_canonicalize(appearance)).digest('hex');
}
function _canonicalize(obj) {
	if (obj === undefined || obj === null) return 'null';
	if (typeof obj === 'number') return Number.isFinite(obj) ? String(obj) : 'null';
	if (typeof obj === 'boolean' || typeof obj === 'string') return JSON.stringify(obj);
	if (Array.isArray(obj)) return '[' + obj.map(_canonicalize).join(',') + ']';
	if (typeof obj === 'object') {
		const keys = Object.keys(obj).sort();
		return (
			'{' + keys.map((k) => JSON.stringify(k) + ':' + _canonicalize(obj[k])).join(',') + '}'
		);
	}
	return 'null';
}

// Hide owner_id and storage_key from callers who don't own the row. The raw
// user UUID is the primary segment of R2 storage keys, so leaking either helps
// an attacker guess object paths in other users' namespaces.
export function stripOwnerFor(avatar, requesterId) {
	if (!avatar) return avatar;
	if (requesterId && avatar.owner_id === requesterId) return avatar;
	const { owner_id: _o, storage_key: _sk, ...rest } = avatar;
	return rest;
}

async function generateSlug(userId, name) {
	const base =
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || 'avatar';
	for (let i = 0; i < 5; i++) {
		const candidate = i === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
		const rows =
			await sql`select 1 from avatars where owner_id = ${userId} and slug = ${candidate} limit 1`;
		if (!rows[0]) return candidate;
	}
	return `${base}-${Date.now().toString(36)}`;
}

export function storageKeyFor({ userId, slug }) {
	const ts = Date.now().toString(36);
	return `u/${userId}/${slug}/${ts}.glb`;
}
