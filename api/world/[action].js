// api/world/[action] — the generic per-world persistence service (T3).
//
//   GET  /api/world/load?worldId=<id>
//     Public. Returns the world's current document + concurrency metadata, or
//     { doc: null } if it has never been saved. Builds are shared, visible
//     places, so reads are open (rate-limited by IP).
//
//   POST /api/world/save   { worldId, doc, ifMatch?, owner? }
//     Authenticated. The authoritative multiplayer server writes with a service
//     token (Authorization: Bearer <world-service-token>); a browser session may
//     write subject to the per-world permission model (world-store.canWriteWorld,
//     the hook T16 tightens). `ifMatch` carries the etag the caller last read for
//     optimistic concurrency — a stale etag returns 409.
//
// Storage lives in api/_lib/world-store.js (Postgres index + R2 blob offload).

import { cors, json, method, wrap, error, readJson } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { extractBearer } from '../_lib/auth.js';
import { resolveAccount } from '../_lib/account-auth.js';
import { verifyWorldServiceToken } from '../_lib/world-service-auth.js';
import {
	loadWorld,
	saveWorld,
	canWriteWorld,
	isValidWorldId,
	ConflictError,
	TooLargeError,
	PermissionError,
	MAX_DOC_BYTES,
} from '../_lib/world-store.js';

function actionOf(req) {
	return (req.query?.action || new URL(req.url, 'http://x').pathname.split('/').pop() || '').toLowerCase();
}

export default wrap(async (req, res) => {
	// Public reads + server-to-server writes use a wildcard origin. Browser saves
	// are same-origin (three.ws → three.ws), so the session cookie rides along
	// without needing credentialed CORS.
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;

	const action = actionOf(req);
	if (action === 'load') return handleLoad(req, res);
	if (action === 'save') return handleSave(req, res);
	return error(res, 404, 'not_found', 'unknown world action');
});

async function handleLoad(req, res) {
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many requests');

	const worldId = new URL(req.url, 'http://x').searchParams.get('worldId') || '';
	if (!isValidWorldId(worldId)) return error(res, 400, 'validation_error', 'invalid or missing worldId');

	const world = await loadWorld(worldId);
	if (!world) return json(res, 200, { worldId, doc: null, version: 0, etag: null });

	return json(res, 200, {
		worldId: world.worldId,
		doc: world.doc,
		version: world.version,
		etag: world.etag,
		schemaVersion: world.schemaVersion,
		ownerId: world.ownerId,
		updatedAt: world.updatedAt,
	});
}

async function handleSave(req, res) {
	if (!method(req, res, ['POST'])) return;

	// Principal resolution: a valid service token outranks a session and marks the
	// write as authoritative (the game server). Otherwise fall back to the caller's
	// browser session / bearer identity.
	const service = await verifyWorldServiceToken(extractBearer(req));
	let writer = null;
	let account = null;
	if (service) {
		writer = 'service';
	} else {
		account = await resolveAccount(req, res);
		if (!account) return error(res, 401, 'unauthorized', 'authentication required to write a world');
		writer = account.userId;
		const rl = await limits.prefsWrite(account.userId);
		if (!rl.success) return error(res, 429, 'rate_limited', 'too many world saves');
	}

	let body;
	try {
		body = await readJson(req, MAX_DOC_BYTES + 1024);
	} catch (err) {
		return error(res, err.status || 400, 'validation_error', err.message || 'invalid body');
	}

	const { worldId, doc, ifMatch, owner } = body || {};
	if (!isValidWorldId(worldId)) return error(res, 400, 'validation_error', 'invalid or missing worldId');
	if (doc === undefined || doc === null || typeof doc !== 'object') {
		return error(res, 400, 'validation_error', 'doc must be a JSON object or array');
	}
	if (ifMatch != null && ifMatch !== '*' && typeof ifMatch !== 'string') {
		return error(res, 400, 'validation_error', 'ifMatch must be an etag string, "*", or null');
	}

	// Permission gate. Service writes are always allowed; user writes depend on the
	// world's current owner. We need the existing owner to decide, so peek first —
	// loadWorld returns null for a brand-new world (unowned → first writer allowed).
	if (!service) {
		const existing = await loadWorld(worldId);
		const allowed = canWriteWorld({
			isService: false,
			account: account.userId,
			currentOwner: existing?.ownerId ?? null,
		});
		if (!allowed) return error(res, 403, 'forbidden', 'not permitted to build in this world');
	}

	// On first save by a user, stamp them as the owner so they keep edit rights.
	const ownerToSet = service ? (typeof owner === 'string' ? owner : null) : account.userId;

	try {
		const result = await saveWorld({ worldId, doc, ifMatch: ifMatch ?? null, writer, owner: ownerToSet });
		return json(res, 200, result);
	} catch (err) {
		if (err instanceof ConflictError) {
			return error(res, 409, err.code, err.message, { etagMismatch: true });
		}
		if (err instanceof TooLargeError) {
			return error(res, 413, err.code, err.message);
		}
		if (err instanceof PermissionError) {
			return error(res, 403, err.code, err.message);
		}
		throw err;
	}
}
