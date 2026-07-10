// POST /api/avatars/fork — GitHub-style "save someone else's avatar".
//
// Saving another user's avatar never produces shared ownership of one row.
// It creates a NEW avatar in the caller's namespace: the source GLB (and
// thumbnail) are server-side copied into `u/{callerId}/…`, a fresh avatar row
// is inserted with owner_id = caller, source = 'fork', parent_avatar_id = source,
// and full attribution captured in source_meta.forked_from. The new avatar gets
// its own agent + freshly provisioned custodial wallet — the caller controls it
// alone; the original owner's avatar, agent, and wallet are untouched.

import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { createAvatar, storageKeyFor, listForks } from '../_lib/avatars.js';
import { copyObject, headObject } from '../_lib/r2.js';
import { provisionAgentWallets } from '../_lib/agent-wallet.js';
import { sql } from '../_lib/db.js';
import { withDbRetry } from '../_lib/db-retry.js';
import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { isUuid } from '../_lib/validate.js';
import { recordEvent } from '../_lib/usage.js';
import { dispatchWebhooks } from '../_lib/webhook-dispatch.js';
import { resolveScheduleForSource, snapshotForkRoyaltyTerms } from '../_lib/fork-royalties.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	// GET /api/avatars/fork?of=<avatarId> — public fork network of an avatar.
	// Anonymous-safe: it only exposes public/unlisted forks.
	if (req.method === 'GET') {
		const url = new URL(req.url, 'http://x');
		const of = String(url.searchParams.get('of') || '').trim();
		if (!isUuid(of)) return error(res, 400, 'validation_error', 'of=<avatarId> required');

		// ?royalty=1 — the upstream royalty terms a fork of this avatar WOULD carry,
		// so the fork CTA can show them before the user consents. Public-safe: it
		// reveals only the decayed/capped rate + creator names, no wallets-as-secrets.
		if (url.searchParams.get('royalty')) {
			const schedule = await resolveScheduleForSource(of);
			return json(res, 200, { royalty: publicRoyaltyTerms(schedule) });
		}

		const result = await listForks({
			avatarId: of,
			limit: Math.min(Math.max(Number(url.searchParams.get('limit')) || 24, 1), 100),
			cursor: url.searchParams.get('cursor'),
		});
		return json(res, 200, result);
	}

	const auth = await resolveAuth(req, 'avatars:write');
	if (!auth) return error(res, 401, 'unauthorized', 'avatars:write scope required');

	const body = await readJson(req);
	const sourceId = String(body.source_avatar_id || body.avatar_id || '').trim();
	if (!isUuid(sourceId)) return error(res, 400, 'validation_error', 'source_avatar_id required');

	// Consent gate: if this avatar's lineage carries a fork royalty, the forker
	// must be shown and accept the EXACT terms before the fork is created. The
	// client previews via GET ?royalty=1, then re-POSTs with accept_royalty:true.
	// A fork whose terms they reject simply isn't created — no surprise taxation.
	const royaltySchedule = await resolveScheduleForSource(sourceId);
	if (royaltySchedule.total_bps > 0 && body.accept_royalty !== true) {
		return error(res, 409, 'royalty_consent_required',
			'this avatar charges a fork royalty — review and accept the terms to fork it',
			{ royalty: publicRoyaltyTerms(royaltySchedule) });
	}

	// Load the raw source row (need storage_key/thumbnail_key, which decorate hides).
	const [src] = await sql`
		select a.id, a.owner_id, a.name, a.description, a.storage_key, a.thumbnail_key,
		       a.content_type, a.size_bytes, a.visibility, a.tags, a.appearance,
		       a.model_category, a.slug, u.display_name as owner_name
		from avatars a
		join users u on u.id = a.owner_id
		where a.id = ${sourceId} and a.deleted_at is null
		limit 1
	`;
	if (!src) return error(res, 404, 'not_found', 'avatar not found');

	// Only public / unlisted avatars (or your own) can be forked. A private
	// avatar you don't own must not even be discoverable as forkable.
	if (src.visibility === 'private' && src.owner_id !== auth.userId) {
		return error(res, 404, 'not_found', 'avatar not found');
	}

	// Copy the model object into the caller's namespace so the fork is fully
	// independent. Absolute-URL ("first-party hosted") sources live outside the
	// bucket — reference the URL directly rather than copying.
	const slugBase =
		(src.slug || src.name || 'avatar')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || 'avatar';
	let newStorageKey = storageKeyFor({ userId: auth.userId, slug: slugBase });
	const copiedGlb = await copyObject({ fromKey: src.storage_key, toKey: newStorageKey });
	if (!copiedGlb) newStorageKey = src.storage_key; // hosted URL — pass through

	// Best-effort thumbnail copy. Never fatal — the gallery falls back to its
	// initial-letter placeholder and the backfill cron renders a real thumbnail
	// for the fork later. Two rules, both load-bearing (docs/avatar-thumbnails.md):
	//
	//   • copyObject() returns false when the source key is an absolute URL —
	//     there is no bucket object to copy. Adopting that URL as the fork's
	//     thumbnail_key would clone a key publicUrl() resolves against an origin
	//     that holds no object.
	//   • A thumbnail_key is persisted only after its object is confirmed present.
	//     A silently-failed copy would otherwise leave the fork pointing at a 404,
	//     which the browser blocks as ORB rather than rendering.
	let newThumbKey = null;
	if (src.thumbnail_key) {
		try {
			const candidate = `u/${auth.userId}/${slugBase}/${Date.now().toString(36)}-thumb.png`;
			const copiedThumb = await copyObject({ fromKey: src.thumbnail_key, toKey: candidate });
			if (copiedThumb && (await headObject(candidate))) newThumbKey = candidate;
		} catch (e) {
			console.warn('[fork] thumbnail copy failed', e?.message);
		}
	}

	// Confirm the copied object is real before we register a row pointing at it.
	if (copiedGlb) {
		const head = await headObject(newStorageKey);
		if (!head) return error(res, 502, 'copy_failed', 'failed to copy source model');
	}

	const forked_from = {
		avatar_id: src.id,
		owner_id: src.owner_id,
		owner_name: src.owner_name || null,
		name: src.name,
		slug: src.slug,
	};

	const avatar = await createAvatar({
		userId: auth.userId,
		input: {
			name: src.name,
			description: src.description ?? null,
			size_bytes: Number(src.size_bytes),
			content_type: src.content_type || 'model/gltf-binary',
			source: 'fork',
			source_meta: { forked_from },
			// Default a fork to unlisted: usable + shareable by the new owner, but
			// not injected into the public gallery until they choose to publish.
			visibility: 'unlisted',
			tags: src.tags || [],
			checksum_sha256: null,
			parent_avatar_id: src.id,
			appearance: src.appearance || null,
		},
		storageKey: newStorageKey,
	});

	if (newThumbKey) {
		await sql`update avatars set thumbnail_key = ${newThumbKey} where id = ${avatar.id}`.catch(
			() => {},
		);
	}

	// Bump the source's fork counter (best-effort; never blocks the fork).
	sql`update avatars set fork_count = fork_count + 1 where id = ${src.id}`.catch(() => {});

	// Create the fork's own agent and provision its custodial wallet synchronously
	// so the response can hand back the new wallet address. Owned by the caller.
	let agent = null;
	try {
		agent = await withDbRetry(async () => {
			const [row] = await sql`
				insert into agent_identities (user_id, name, avatar_id, is_public, created_at, updated_at)
				values (${auth.userId}, ${avatar.name || 'My Agent'}, ${avatar.id}, false, now(), now())
				returning id
			`;
			return row;
		});
		if (agent?.id) {
			const wallets = await provisionAgentWallets(agent.id);
			agent = { id: agent.id, wallet_address: wallets.evm, solana_address: wallets.solana };
			// Freeze the consent snapshot the forker just accepted. Immutable: a later
			// change to an ancestor's rate never retroactively re-taxes this fork.
			if (royaltySchedule.total_bps > 0) {
				await snapshotForkRoyaltyTerms({
					forkAgentId: agent.id,
					forkAvatarId: avatar.id,
					acceptedBy: auth.userId,
					schedule: royaltySchedule,
				}).catch((e) => console.error('[fork] royalty snapshot failed', { avatarId: avatar.id, error: e?.message }));
			}
		}
	} catch (e) {
		// A wallet provisioning hiccup must not fail the fork — the avatar + agent
		// still exist and the wallet can be (re)provisioned from any avatar surface.
		console.error('[fork] agent/wallet provision failed', { avatarId: avatar.id, error: e?.message });
	}

	dispatchWebhooks({
		userId: auth.userId,
		eventType: 'avatar.created',
		data: { id: avatar.id, name: avatar.name, slug: avatar.slug, source: 'fork', forked_from: src.id },
	}).catch(() => {});

	recordEvent({
		userId: auth.userId,
		apiKeyId: auth.apiKeyId,
		clientId: auth.clientId,
		avatarId: avatar.id,
		kind: 'fork',
		bytes: avatar.size_bytes,
		meta: { source_avatar_id: src.id },
	});

	return json(res, 201, { avatar, agent, royalty: publicRoyaltyTerms(royaltySchedule) });
});

// Shape a resolved royalty schedule for the client: the decayed/capped total, the
// majority the forker keeps, and a per-creator receipt. Wallets are included
// (they are public custodial addresses) so the forker sees exactly who is paid.
function publicRoyaltyTerms(schedule) {
	return {
		total_bps: schedule.total_bps,
		total_pct: schedule.total_bps / 100,
		keep_bps: schedule.keep_bps,
		keep_pct: schedule.keep_bps / 100,
		has_royalty: schedule.total_bps > 0,
		creators: schedule.entries.map((e) => ({
			depth: e.depth,
			owner_name: e.ancestor_owner_name || null,
			ancestor_agent_id: e.ancestor_agent_id,
			ancestor_avatar_id: e.ancestor_avatar_id || null,
			wallet: e.ancestor_wallet || null,
			bps: e.bps,
			pct: e.bps / 100,
			set_bps: e.set_bps,
			eligible: e.eligible || { tips: true, stream: true },
		})),
	};
}

async function resolveAuth(req, requiredScope) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id, source: 'session' };
	const bearer = await authenticateBearer(extractBearer(req));
	if (!bearer) return null;
	if (!hasScope(bearer.scope, requiredScope)) return null;
	return bearer;
}
