// POST /api/avatars/from-forge
//
// Save a generated GLB (by URL) straight into the caller's avatar library,
// server-side. This is the durable end of the chat "text → 3D avatar" pipeline:
// the chat tool forges a mesh and auto-rigs it (both return public GLB URLs),
// then hands the final URL here. Doing the copy on the server — instead of the
// browser fetching the GLB and presigning a PUT — sidesteps cross-origin (CORS)
// reads of provider/R2 URLs, the 16 MB browser-upload cap, and the
// size-match race on /api/avatars, and it routes through the same
// createAvatar + agent-provisioning path as a normal upload so the result is a
// first-class, agent-backed avatar.
//
// Mirrors the MCP studio save_avatar tool, but session/bearer authed for the
// browser instead of x402.
//
// Request body (JSON):
//   glb_url       string  — public https URL of the GLB to save (required)
//   name          string  — avatar name, 1–80 chars (required)
//   visibility    enum?   — public | unlisted | private (default unlisted)
//   source_prompt string? — the prompt that generated it, kept as provenance
//   rigged        bool?   — whether the GLB is auto-rigged (provenance only)
//   tags          string[]? — up to 20 organizing tags
//
// Response 201: { avatar, view_url }

import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { storageKeyFor, createAvatar, defaultAvatarVisibilityFor } from '../_lib/avatars.js';
import { putObject } from '../_lib/r2.js';
import { isValidGlbHeader, inspectGlb } from '../_lib/glb-inspect.js';
import { fetchSafePublicUrl, SsrfBlockedError } from '../_lib/ssrf-guard.js';
import { provisionAvatarAgent } from '../_lib/avatar-agent.js';
import { maybeAutoRigAvatar } from '../_lib/auto-rig.js';
import { limits } from '../_lib/rate-limit.js';
import { recordEvent } from '../_lib/usage.js';
import { markActivated } from '../_lib/activation.js';
import { env } from '../_lib/env.js';

// Match the studio/reconstruct ceiling so a runaway model can't ingest an
// unbounded blob. The avatars table allows far more, but a generated avatar is
// realistically 5–25 MB.
const MAX_GLB_BYTES = 64 * 1024 * 1024;
const VISIBILITIES = new Set(['public', 'unlisted', 'private']);

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id, source: 'session' };
	const bearer = await authenticateBearer(extractBearer(req));
	if (!bearer) return null;
	if (!hasScope(bearer.scope, 'avatars:write')) return null;
	return bearer;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth?.userId) {
		return error(res, 401, 'unauthorized', 'sign in (or provide an avatars:write token) to save an avatar');
	}

	const rl = await limits.upload(auth.userId);
	if (!rl.success) {
		res.setHeader('Retry-After', Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000)));
		return error(res, 429, 'rate_limited', 'too many avatar saves; try again shortly');
	}

	let body;
	try {
		body = await readJson(req);
	} catch (err) {
		return error(res, 400, 'bad_request', err?.message || 'invalid JSON body');
	}

	const glbUrl = typeof body?.glb_url === 'string' ? body.glb_url.trim() : '';
	const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
	if (!glbUrl) return error(res, 400, 'invalid_request', 'glb_url is required');
	if (!name) return error(res, 400, 'invalid_request', 'name is required (1–80 chars)');

	// An explicit visibility from the caller wins; otherwise the owner's
	// "Default avatar visibility" preference from /settings decides, falling back
	// to the unlisted default this endpoint has always used.
	const visibility = VISIBILITIES.has(body?.visibility)
		? body.visibility
		: await defaultAvatarVisibilityFor(auth.userId, 'unlisted');
	const sourcePrompt =
		typeof body?.source_prompt === 'string' ? body.source_prompt.slice(0, 1000) : null;
	const rigged = body?.rigged === true;
	const tags = Array.isArray(body?.tags)
		? body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20)
		: [];

	// Fetch the GLB server-side through the SSRF guard (https-only, no
	// private/loopback/metadata targets) — glb_url is model-influenced, so it is
	// never trusted to point at our own network.
	let resp;
	try {
		resp = await fetchSafePublicUrl(glbUrl, {}, { allowHttp: false });
	} catch (err) {
		if (err instanceof SsrfBlockedError) {
			return error(res, 400, 'invalid_url', 'glb_url must be a public https URL');
		}
		console.warn('[from-forge] glb fetch failed:', err?.message);
		return error(res, 502, 'fetch_failed', 'Could not fetch that GLB URL — check the link and try again.');
	}
	if (!resp.ok) {
		return error(res, 502, 'fetch_failed', `glb_url returned ${resp.status}`);
	}

	const declared = Number(resp.headers.get('content-length') || 0);
	if (declared && declared > MAX_GLB_BYTES) {
		return error(res, 413, 'payload_too_large', `glb is ${declared} bytes; max is ${MAX_GLB_BYTES}`);
	}
	const buf = Buffer.from(await resp.arrayBuffer());
	if (buf.length > MAX_GLB_BYTES) {
		return error(res, 413, 'payload_too_large', `glb is ${buf.length} bytes; max is ${MAX_GLB_BYTES}`);
	}
	if (!isValidGlbHeader(buf)) {
		return error(res, 422, 'invalid_glb', 'that URL did not return a valid binary glTF (.glb)');
	}
	// inspectGlb does a deeper parse and can still return null on a header-valid
	// but malformed GLB — fall back to an empty meta object so a save never 500s.
	const info = inspectGlb(buf) || {};

	// Durable copy under the caller's own storage namespace, then register it.
	const slug = `studio-${Math.random().toString(36).slice(2, 8)}`;
	const storageKey = storageKeyFor({ userId: auth.userId, slug });
	await putObject({
		key: storageKey,
		body: buf,
		contentType: 'model/gltf-binary',
		metadata: { source: 'studio', user_id: auth.userId },
	});

	const avatar = await createAvatar({
		userId: auth.userId,
		storageKey,
		input: {
			slug,
			name,
			description: null,
			size_bytes: buf.length,
			content_type: 'model/gltf-binary',
			source: 'studio',
			source_meta: {
				source_glb_url: glbUrl,
				source_prompt: sourcePrompt,
				generator: 'chat-forge-avatar',
				// Server-side GLB inspection is the ONLY rig truth (definite true/
				// false, or null when a header-valid blob couldn't be parsed). The
				// client `rigged` body flag is never trusted to decide rig state — it
				// is kept separately, clearly labelled, as provenance only.
				is_rigged: typeof info.isRigged === 'boolean' ? info.isRigged : null,
				client_claimed_rigged: rigged,
				mesh_count: info.meshCount ?? null,
				animation_count: info.animationCount ?? null,
			},
			visibility,
			tags,
			checksum_sha256: null,
			parent_avatar_id: null,
		},
	});

	// First-class like a normal upload: provision the agent + custodial wallet,
	// and record signed generation provenance on the agent_actions ledger once
	// it resolves (creator, prompt, generation model, timestamp).
	queueMicrotask(() =>
		provisionAvatarAgent({
			userId: auth.userId,
			avatarId: avatar.id,
			avatarName: avatar.name,
			provenance: {
				prompt: sourcePrompt,
				generationModel: 'chat-forge-avatar',
				generationProvider: null,
				parentAvatarId: null,
			},
		}),
	);

	// Auto-rig if the forged mesh arrived static (e.g. a mesh_forge save) so the
	// agent's avatar can animate. The rig decision derives from the SERVER-side
	// GLB inspection (info.isRigged / skeletonJointCount), never the untrusted
	// client `rigged` flag: a client can't send rigged:true on a static mesh to
	// skip the gate, nor rigged:false on a skinned mesh to force a paid rig. A
	// no-op when inspection finds a real skeleton or no rerig model is configured.
	queueMicrotask(() =>
		maybeAutoRigAvatar({
			userId: auth.userId,
			avatar,
			rigInfo: { is_rigged: info.isRigged === true, skeleton_joint_count: info.skeletonJointCount ?? null },
			source: 'studio',
			visibility: avatar.visibility,
			prompt: sourcePrompt,
		}),
	);

	recordEvent({
		userId: auth.userId,
		apiKeyId: auth.apiKeyId,
		clientId: auth.clientId,
		avatarId: avatar.id,
		kind: 'upload',
		bytes: buf.length,
		meta: { source: 'chat-forge-avatar', rigged: Boolean(rigged) },
	});
	// First win: claimed a forged 3D model as an avatar. Activates the account
	// once and pays the two-sided referral reward when referred. Fire-and-forget.
	queueMicrotask(() => markActivated(auth.userId, { source: 'forge_save', meta: { avatarId: avatar.id } }));

	const viewUrl = `${env.APP_ORIGIN || ''}/avatars/${avatar.id}`;
	return json(res, 201, { avatar, view_url: viewUrl });
});
