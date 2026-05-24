// GET /api/users/:username/avatar — resolve a username to their canonical avatar.
//
// Returns a minimal payload designed to drive both:
//   • the portable <script src="…/embed.js" data-avatar="@username"> snippet
//   • the public /@username live profile page
//
// Resolution priority:
//   1. Most-recent PUBLIC avatar owned by the user
//   2. If no public avatars, return 404 (we never leak a private GLB by handle)
//
// Optimization knobs (passed through to the model_url):
//   ?lod=0|1|2
//   ?textureSize=128|256|512|1024|2048
//   ?morphs=arkit52|all
//   ?draco=1
//   ?baked=1            prefer baked_storage_key when fresh (default ON;
//                       pass baked=0 to force the base GLB).
//
// Embed knob (for iframe/script consumers):
//   ?bg=transparent|dark|light
//   ?idle=on|off
//   ?mocap=off|webcam
//
// The returned `embed_url` is a fully-formed iframe src — drop it into an
// <iframe src="…"> and you get a live, lipsynced avatar with idle behaviors
// running. The `model_url` is a direct GLB pointer for SDK consumers (RPM
// Visage style) who want to render it themselves.

import { sql } from '../../_lib/db.js';
import { cors, json, method, wrap, error } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { publicUrl } from '../../_lib/r2.js';
import { env } from '../../_lib/env.js';

const VALID_LOD = new Set(['0', '1', '2']);
const VALID_TEX = new Set(['128', '256', '512', '1024', '2048']);
const VALID_MORPHS = new Set(['arkit52', 'all']);
const VALID_BG = new Set(['transparent', 'dark', 'light']);
const VALID_MOCAP = new Set(['off', 'webcam']);

function originFor(req) {
	const fromEnv = env.APP_ORIGIN;
	if (fromEnv) return fromEnv.replace(/\/$/, '');
	const proto = req.headers['x-forwarded-proto'] || 'https';
	const host = req.headers['x-forwarded-host'] || req.headers.host;
	if (!host) return '';
	return `${proto}://${host}`.replace(/\/$/, '');
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: false })) return;
	if (!method(req, res, ['GET'])) return;

	const usernameRaw =
		req.query?.username ||
		new URL(req.url, 'http://x').pathname.split('/').filter(Boolean).slice(-2)[0] ||
		'';
	const username = String(usernameRaw).toLowerCase().replace(/^@/, '').trim();
	if (!username || !/^[a-z0-9_-]{3,30}$/.test(username)) {
		return error(res, 400, 'validation_error', 'invalid username');
	}

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const url = new URL(req.url, 'http://x');
	const lod = url.searchParams.get('lod');
	const textureSize = url.searchParams.get('textureSize');
	const morphs = url.searchParams.get('morphs');
	const draco = url.searchParams.get('draco');
	const baked = url.searchParams.get('baked') !== '0';
	const bg = url.searchParams.get('bg') || 'transparent';
	const idle = url.searchParams.get('idle') || 'on';
	const mocap = url.searchParams.get('mocap') || 'off';

	if (lod != null && !VALID_LOD.has(lod))
		return error(res, 400, 'validation_error', 'lod must be 0|1|2');
	if (textureSize != null && !VALID_TEX.has(textureSize))
		return error(res, 400, 'validation_error', 'textureSize must be 128|256|512|1024|2048');
	if (morphs != null && !VALID_MORPHS.has(morphs))
		return error(res, 400, 'validation_error', 'morphs must be arkit52|all');
	if (!VALID_BG.has(bg))
		return error(res, 400, 'validation_error', 'bg must be transparent|dark|light');
	if (!VALID_MOCAP.has(mocap))
		return error(res, 400, 'validation_error', 'mocap must be off|webcam');

	const [user] = await sql`
		select id, username, display_name
		from users
		where lower(username) = ${username} and deleted_at is null
		limit 1
	`;
	if (!user) return error(res, 404, 'not_found', 'user not found');

	const [avatar] = await sql`
		select id, slug, name, description,
		       storage_key, baked_storage_key, baked_at, appearance_hash,
		       thumbnail_key, size_bytes, source, version,
		       tags, created_at, updated_at
		from avatars
		where owner_id = ${user.id}
		  and visibility = 'public'
		  and deleted_at is null
		order by updated_at desc nulls last, created_at desc
		limit 1
	`;
	if (!avatar) return error(res, 404, 'not_found', 'user has no public avatar');

	// Base storage key — prefer the baked (dressed) version when fresh.
	const sourceKey =
		baked && avatar.baked_storage_key ? avatar.baked_storage_key : avatar.storage_key;
	const baseModelUrl = publicUrl(sourceKey);

	const origin = originFor(req);

	// model_url — optimization-knob URL. If no optimization params, hand back
	// the raw R2 URL (CDN-cached). Otherwise route through /api/avatar/optimize.
	let modelUrl = baseModelUrl;
	const transcode = lod != null || textureSize != null || morphs != null || draco === '1';
	if (transcode && origin) {
		const u = new URL(origin + '/api/avatar/optimize');
		u.searchParams.set('id', avatar.id);
		if (lod != null) u.searchParams.set('lod', lod);
		if (textureSize != null) u.searchParams.set('textureSize', textureSize);
		if (morphs != null) u.searchParams.set('morphs', morphs);
		if (draco === '1') u.searchParams.set('draco', '1');
		modelUrl = u.toString();
	}

	// embed_url — points at /embed/avatar/:username so the script-tag and
	// iframe both land on the same Vite entry. URL params control bg, idle,
	// mocap, and any optimization knobs.
	let embedUrl = '';
	if (origin) {
		const u = new URL(origin + `/embed/avatar/${user.username}`);
		if (lod != null) u.searchParams.set('lod', lod);
		if (textureSize != null) u.searchParams.set('textureSize', textureSize);
		if (morphs != null) u.searchParams.set('morphs', morphs);
		if (draco === '1') u.searchParams.set('draco', '1');
		if (bg !== 'transparent') u.searchParams.set('bg', bg);
		if (idle !== 'on') u.searchParams.set('idle', idle);
		if (mocap !== 'off') u.searchParams.set('mocap', mocap);
		if (!baked) u.searchParams.set('baked', '0');
		embedUrl = u.toString();
	}

	res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
	return json(res, 200, {
		user: {
			username: user.username,
			display_name: user.display_name || user.username,
		},
		avatar: {
			id: avatar.id,
			slug: avatar.slug,
			name: avatar.name,
			description: avatar.description,
			thumbnail_url: avatar.thumbnail_key ? publicUrl(avatar.thumbnail_key) : null,
			model_url: modelUrl,
			base_model_url: baseModelUrl,
			size_bytes: Number(avatar.size_bytes || 0),
			source: avatar.source,
			version: avatar.version,
			tags: avatar.tags || [],
			created_at: avatar.created_at,
			updated_at: avatar.updated_at,
			baked: baked && !!avatar.baked_storage_key,
		},
		embed_url: embedUrl,
		embed: {
			script: origin
				? `<script async src="${origin}/embed.js" data-avatar="@${user.username}"></script>`
				: '',
			iframe: embedUrl
				? `<iframe src="${embedUrl}" width="420" height="600" frameborder="0" allow="autoplay; camera; clipboard-write; xr-spatial-tracking" style="border-radius:12px;"></iframe>`
				: '',
		},
	});
});
