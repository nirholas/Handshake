// Public verification for signed agent manifests.
//
//   GET /api/manifest-verify?cid=<ipfs-cid>
//   GET /api/manifest-verify?digest=<sha256-hex>
//   GET /api/manifest-verify?agent=<uuid>
//
// Anyone holding a CID can check three things here without an account, a key, or
// our permission:
//
//   1. the document really was signed by the three.ws attester identity,
//   2. the system prompt inside it is the one that was signed (its own hash), and
//   3. whether the agent running today still matches what was pinned — the diff
//      names every field that moved.
//
// The envelope is fetched from public IPFS gateways, not from our database, so a
// green result is evidence about the network's copy rather than about ours. The
// stored copy is only used as a fallback when every gateway is unreachable, and
// the response says so in `source`.
//
// Spec: specs/AGENT_MANIFEST.md (§ Signed envelope). Docs: docs/agent-manifest.md.

import { sql } from './_lib/db.js';
import { cors, json, method, wrap, error, rateLimited } from './_lib/http.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { verifyAgentManifest, diffAgentManifest } from './_lib/agent-manifest-sign.js';
import {
	fetchEnvelopeFromIPFS,
	findStoredManifest,
	buildLiveAgentManifest,
	platformIssuer,
	IPFS_GATEWAYS,
} from './_lib/agent-manifest-publish.js';

const CID_RE = /^[A-Za-z0-9]{40,80}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.pinStatusIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://x');
	const cid = (req.query?.cid || url.searchParams.get('cid') || '').trim();
	const digest = (req.query?.digest || url.searchParams.get('digest') || '').trim().toLowerCase();
	const agentParam = (req.query?.agent || url.searchParams.get('agent') || '').trim();

	if (!cid && !digest && !agentParam) {
		return error(res, 400, 'validation_error', 'pass one of cid, digest, or agent');
	}
	if (cid && !CID_RE.test(cid)) return error(res, 400, 'validation_error', 'cid is not a valid IPFS CID');
	if (digest && !DIGEST_RE.test(digest)) return error(res, 400, 'validation_error', 'digest must be a 64-char sha256 hex');
	if (agentParam && !UUID_RE.test(agentParam)) return error(res, 400, 'validation_error', 'agent must be a uuid');

	// Resolve an agent id to whatever it currently has pinned, then verify that.
	let targetCid = cid;
	let targetDigest = digest;
	if (!targetCid && !targetDigest && agentParam) {
		const [row] = await sql`
			SELECT manifest_cid, manifest_digest FROM agent_identities
			WHERE id = ${agentParam} AND deleted_at IS NULL LIMIT 1
		`;
		if (!row || !row.manifest_digest) {
			return error(res, 404, 'not_published', 'this agent has no signed manifest yet');
		}
		targetCid = row.manifest_cid || '';
		targetDigest = row.manifest_digest;
	}

	const stored = await findStoredManifest({ cid: targetCid || undefined, digest: targetDigest || undefined });

	let envelope = null;
	let source = null;
	let gateway = null;
	let fetchError = null;
	if (targetCid) {
		try {
			const got = await fetchEnvelopeFromIPFS(targetCid);
			envelope = got.envelope;
			source = 'ipfs';
			gateway = got.gateway;
		} catch (err) {
			fetchError = err?.message || 'gateway fetch failed';
		}
	}
	if (!envelope && stored?.envelope) {
		envelope = stored.envelope;
		source = 'three.ws';
	}
	if (!envelope) {
		return error(
			res,
			404,
			'manifest_unavailable',
			fetchError
				? `no IPFS gateway served that CID and three.ws has no copy of it (${fetchError})`
				: 'no signed manifest matches that identifier',
		);
	}

	const issuer = platformIssuer();
	const verdict = verifyAgentManifest(envelope);

	// A signature that verifies against an unknown key proves authorship by that
	// key, not by three.ws. Report the distinction rather than blurring it: the
	// key is trusted if it is the live attester, or if we recorded this exact
	// document under that issuer when we published it.
	const issuerTrusted = Boolean(
		envelope.issuer && ((issuer && envelope.issuer === issuer) || (stored && stored.envelope?.issuer === envelope.issuer)),
	);

	// The bytes IPFS served must be the bytes we recorded for that CID.
	let matchesRecord = null;
	if (stored) matchesRecord = stored.digest === verdict.digest;

	const agentId = stored?.agent_id || envelope.manifest?.id?.agentId || null;
	let drift = null;
	let agentStatus = 'unknown';
	if (agentId && UUID_RE.test(String(agentId))) {
		const live = await buildLiveAgentManifest(String(agentId));
		if (!live) {
			agentStatus = 'deleted';
		} else if (!live.manifest) {
			agentStatus = 'no_persona';
		} else {
			agentStatus = 'live';
			drift = diffAgentManifest(envelope.manifest, live.manifest);
		}
	}

	return json(
		res,
		200,
		{
			cid: targetCid || null,
			digest: verdict.digest,
			source,
			gateway,
			gatewayUrls: targetCid ? IPFS_GATEWAYS.map((g) => `${g}${targetCid}`) : [],
			verified: verdict.valid && issuerTrusted && matchesRecord !== false,
			signature_valid: verdict.valid,
			reason: verdict.reason,
			issuer: envelope.issuer || null,
			issuer_trusted: issuerTrusted,
			platform_issuer: issuer,
			known_to_platform: Boolean(stored),
			matches_platform_record: matchesRecord,
			signed_at: envelope.signedAt || null,
			agent_id: agentId,
			agent_status: agentStatus,
			// null when we cannot compare (agent gone, or a manifest we never issued).
			drift,
			manifest: envelope.manifest,
		},
		{
			'access-control-allow-origin': '*',
			'cache-control': 'public, max-age=30, s-maxage=120, stale-while-revalidate=600',
		},
	);
});
