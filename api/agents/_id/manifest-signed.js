// Signed manifest endpoints for a single agent.
//
//   GET  /api/agents/:id/manifest/signed   — public: the signed envelope that is
//        currently pinned, its CID, and the gateways it can be fetched from.
//   POST /api/agents/:id/manifest/publish  — owner-only: re-sign and re-pin now
//        (also the way to publish a non-public agent's manifest deliberately).
//   GET  /api/agents/:id/manifest/history  — public: every CID ever published.
//
// The public verification entry point that needs nothing but a CID lives at
// /api/manifest-verify. Spec: specs/AGENT_MANIFEST.md (§ Signed envelope).

import { sql } from '../../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer, isSameSiteOrigin } from '../../_lib/auth.js';
import { cors, json, method, wrap, error, rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { publishAgentManifest, IPFS_GATEWAYS } from '../../_lib/agent-manifest-publish.js';
import { verifyAgentManifest } from '../../_lib/agent-manifest-sign.js';

function gatewayUrls(cid) {
	return cid ? IPFS_GATEWAYS.map((g) => `${g}${cid}`) : [];
}

async function ownerOf(req, agentId) {
	const session = await getSessionUser(req);
	if (session) {
		if (!isSameSiteOrigin(req)) {
			return { error: [403, 'forbidden', 'cross-site request blocked'] };
		}
		const [row] = await sql`SELECT user_id FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL`;
		if (!row) return { error: [404, 'not_found', 'agent not found'] };
		if (row.user_id !== session.id) return { error: [403, 'forbidden', 'not your agent'] };
		return { userId: session.id };
	}
	const bearer = await authenticateBearer(extractBearer(req));
	if (!bearer) return { error: [401, 'unauthorized', 'sign in required'] };
	const [row] = await sql`SELECT user_id FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL`;
	if (!row) return { error: [404, 'not_found', 'agent not found'] };
	if (row.user_id !== bearer.userId) return { error: [403, 'forbidden', 'not your agent'] };
	return { userId: bearer.userId };
}

export const handleSignedManifest = wrap(async (req, res, id, action) => {
	// ── POST /publish — owner-initiated re-sign + re-pin ─────────────────────
	if (action === 'publish') {
		if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
		if (!method(req, res, ['POST'])) return;

		const auth = await ownerOf(req, id);
		if (auth.error) return error(res, ...auth.error);

		const rl = await limits.widgetWrite(auth.userId);
		if (!rl.success) return rateLimited(res, rl, 'too many manifest publishes, slow down');

		// force: the owner asking explicitly IS the consent to publish a
		// not-yet-public agent's configuration to IPFS, which is permanent.
		const result = await publishAgentManifest(id, { reason: 'manual_publish', force: true });
		const status = result.status === 'skipped' ? 409 : 200;
		return json(res, status, { ...result, gatewayUrls: gatewayUrls(result.cid) });
	}

	// ── GET /history — every manifest this agent ever published ──────────────
	if (action === 'history') {
		if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
		if (!method(req, res, ['GET'])) return;

		const rl = await limits.pinStatusIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl);

		const rows = await sql`
			SELECT cid, digest, issuer, provider, reason, created_at
			FROM agent_manifest_pins WHERE agent_id = ${id}
			ORDER BY created_at DESC LIMIT 50
		`;
		return json(
			res,
			200,
			{
				agent_id: id,
				publishes: rows.map((r) => ({
					cid: r.cid,
					digest: r.digest,
					issuer: r.issuer,
					provider: r.provider,
					reason: r.reason,
					pinned: Boolean(r.cid),
					created_at: r.created_at,
					gatewayUrls: gatewayUrls(r.cid),
				})),
			},
			{ 'access-control-allow-origin': '*' },
		);
	}

	// ── GET /signed — the currently published envelope ───────────────────────
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.pinStatusIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const [row] = await sql`
		SELECT p.cid, p.digest, p.issuer, p.signature, p.provider, p.envelope, p.created_at
		FROM agent_identities a
		JOIN agent_manifest_pins p ON p.digest = a.manifest_digest
		WHERE a.id = ${id} AND a.deleted_at IS NULL
		LIMIT 1
	`;
	if (!row) {
		return error(
			res,
			404,
			'not_published',
			'this agent has no signed manifest yet — save its persona, or POST /api/agents/:id/manifest/publish',
		);
	}

	const verdict = verifyAgentManifest(row.envelope);
	return json(
		res,
		200,
		{
			agent_id: id,
			cid: row.cid,
			pinned: Boolean(row.cid),
			provider: row.provider,
			digest: row.digest,
			issuer: row.issuer,
			signature: row.signature,
			signed_at: row.created_at,
			verified: verdict.valid,
			verify_reason: verdict.reason,
			gatewayUrls: gatewayUrls(row.cid),
			verifyUrl: row.cid ? `/api/manifest-verify?cid=${encodeURIComponent(row.cid)}` : null,
			envelope: row.envelope,
		},
		{
			'access-control-allow-origin': '*',
			'cache-control': 'public, max-age=30, s-maxage=120, stale-while-revalidate=600',
		},
	);
});
