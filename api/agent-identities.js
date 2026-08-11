// GET /api/agent-identities: the Agent Identity Studio showcase feed.
//
// Serves the demo identities behind three.ws/agent-identities: real runs of the
// production identity pipeline, recorded in data/agent-identities.json by
// scripts/okx-identity-demo.mjs (never hand-written). The showcase page fetches
// this at runtime instead of inlining the file at build time, so a fresh demo
// run is live the moment the data lands, and so the price and endpoint the page
// quotes come from the OKX catalog (api/_lib/okx-catalog.js), the single source
// of truth for what the service actually costs.
//
// Public and unauthenticated: agents shopping the marketplace can read the same
// feed to see what the studio produces before they pay for a run.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { cors, json, method, wrap, error } from './_lib/http.js';
import { catalogEntry } from './_lib/okx-catalog.js';

const SERVICE_ID = 'identity-studio';

async function loadShowcase() {
	const file = path.join(process.cwd(), 'data', 'agent-identities.json');
	const parsed = JSON.parse(await readFile(file, 'utf8'));
	return Array.isArray(parsed.identities) ? parsed.identities : [];
}

// One showcase row. `status` is what the page renders on: an entry whose
// pipeline run has not completed yet is `pending` and carries no result, so the
// client never has to guess from a missing field.
function shape(identity) {
	// A result without a PFP never made it past the render stage, so it is not a
	// showable identity: treat it as pending rather than half-rendering it.
	const r = identity.result?.pfp?.url ? identity.result : null;
	const base = {
		slug: identity.slug,
		agentName: identity.agentName,
		kind: identity.kind,
		brief: identity.brief,
		styleHints: identity.styleHints || null,
		status: r ? 'ready' : 'pending',
	};
	if (!r) return base;
	return {
		...base,
		pfp: { url: r.pfp.url, previewUrl: r.pfp.preview_128_url || null, pose: r.pfp.pose || null },
		fullBody: (r.fullBody || []).map((shot) => ({
			url: shot.url,
			pose: shot.pose,
			width: shot.width,
			height: shot.height,
		})),
		riggedGlbUrl: r.riggedGlbUrl,
		viewerUrl: r.viewerUrl,
		poseStudioUrl: r.poseStudioUrl,
		backend: r.backend || null,
		// scripts/okx-identity-demo.mjs only records rigVerification for a run whose
		// GLB parsed with a real skin, so a joint count is the proof of rigging.
		rigged: Number(r.rigVerification?.joints) > 0,
		joints: r.rigVerification?.joints ?? null,
		durationSeconds: r.durationSeconds ?? null,
		completedAt: r.completedAt || null,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	let identities;
	try {
		identities = await loadShowcase();
	} catch (err) {
		return error(
			res,
			503,
			'showcase_unavailable',
			`identity showcase data could not be read: ${err.message}`,
		);
	}

	const entry = catalogEntry(SERVICE_ID);
	const rows = identities.map(shape);

	return json(
		res,
		200,
		{
			service: entry
				? {
						id: entry.id,
						name: entry.name,
						priceUsd: entry.priceUsd,
						currency: 'USDC',
						endpoint: entry.endpoint,
						tool: entry.tool,
						docs: 'https://three.ws/docs/okx-marketplace',
						catalog: 'https://three.ws/api/okx/3d/catalog',
					}
				: null,
			count: rows.length,
			ready: rows.filter((r) => r.status === 'ready').length,
			identities: rows,
		},
		{ 'cache-control': 'public, s-maxage=600, stale-while-revalidate=86400' },
	);
});
