// POST /api/print/quote: printability and price for a real print, in one call.
//
// The /materialize page asks this endpoint every time the buyer changes a
// material, a size or a quantity, so it does two things at once:
//
//   1. Analyzes the mesh (api/_lib/print/analyze.js) and returns the printability
//      report: manifold, shells, open edges, the thinnest wall, the volume money
//      hangs off, and a score with named deductions.
//   2. Prices it (api/_lib/print/quote.js) and returns the itemization plus an
//      HMAC-signed quote token that checkout later charges against.
//
// Omit `materialId` and it is a pure analyze call: free, keyless, no price. That
// is the shape an agent uses to decide whether a mesh is worth printing at all.
//
// Why the server analyzes rather than accepting a client-supplied report: the
// volume in that report IS the price. A report that arrived in the request body
// would let a caller quote a 200 cm3 figure at 2 cm3. The analysis is cached per
// source URL for the life of the process, so dragging the size slider re-prices
// against an already-parsed mesh and never re-downloads it.
//
// Every number here comes from the quote engine. No price is computed anywhere
// else, in this file or in any frontend module.

import { createHash } from 'node:crypto';

import { cors, error, json, method, rateLimited, readJson, wrap } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { getSessionUser } from '../_lib/auth.js';
import { createCache, cached } from '../_lib/mem-cache.js';
import { loadMeshFromUrl, MeshIoError } from '../_lib/print/mesh-io.js';
import { analyzeMesh } from '../_lib/print/analyze.js';
import { loadCatalog, materialFits, quotePrint, signQuote } from '../_lib/print/quote.js';
import { getPublicCreation } from '../_lib/forge-store.js';
import { loadLineage, runFabricationGate } from '../_lib/print/gate.js';
import { holderDiscountBps } from '../_lib/three-tier.js';

// One analysis per source model, held for an hour. The report is deterministic
// for given bytes, so a cache hit is the same answer the analysis would produce,
// and a model whose URL content changed gets a new URL from the forge anyway.
const reports = createCache({ max: 256, ttlMs: 60 * 60 * 1000 });

// MeshIoError codes carry their own correct HTTP status: a mesh that is too big
// is the caller's input, not our failure, and a fetch that died upstream is a 502.
const MESH_ERROR_STATUS = {
	invalid_model: 422,
	no_geometry: 422,
	too_large: 413,
	too_complex: 413,
	invalid_url: 400,
	fetch_failed: 502,
};

function reportHashOf(report) {
	return createHash('sha256')
		.update(JSON.stringify([report.version, report.volume_cm3, report.bbox_mm, report.min_wall_mm, report.triangles]))
		.digest('hex')
		.slice(0, 32);
}

async function resolveSource(body) {
	const creationId = typeof body.creationId === 'string' ? body.creationId.trim() : '';
	if (creationId) {
		const creation = await getPublicCreation({ id: creationId });
		if (!creation) return { error: { status: 404, code: 'creation_not_found', message: 'No finished public creation with that id.' } };
		if (!creation.glb_url) return { error: { status: 409, code: 'creation_has_no_model', message: 'That creation has no finished model to print yet.' } };
		return {
			url: creation.glb_url,
			creationId: creation.id,
			creation: {
				id: creation.id,
				prompt: creation.prompt,
				preview_image_url: creation.preview_image_url ?? null,
				model_category: creation.model_category ?? null,
				creator_username: creation.creator_username ?? null,
			},
		};
	}
	const glbUrl = typeof body.glbUrl === 'string' ? body.glbUrl.trim() : '';
	if (!glbUrl) {
		return { error: { status: 400, code: 'validation_error', message: 'Pass a creationId or a glbUrl to print.' } };
	}
	return { url: glbUrl, creationId: null, creation: null };
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const rate = await limits.printQuoteIp(clientIp(req));
	if (!rate.success) return rateLimited(res, rate, 'too many quote requests');

	const body = await readJson(req, 8_000).catch(() => null);
	if (!body || typeof body !== 'object') {
		return error(res, 400, 'validation_error', 'a JSON body is required');
	}

	const source = await resolveSource(body);
	if (source.error) {
		return error(res, source.error.status, source.error.code, source.error.message);
	}

	let report;
	try {
		report = await cached(reports, source.url, async () => {
			const mesh = await loadMeshFromUrl(source.url);
			return analyzeMesh(mesh, { sourceUrl: source.url });
		});
	} catch (err) {
		if (err instanceof MeshIoError) {
			return error(res, MESH_ERROR_STATUS[err.code] ?? 422, err.code, err.message, err.extra || {});
		}
		throw err;
	}

	// The fabrication gate, first run point. It is deterministic here (no model
	// call) so a price is never gated on a third-party provider being up, and it
	// runs BEFORE any money is quoted: a refusal at this point costs the buyer
	// nothing. The paid order is screened again, thoroughly, on the way to the
	// printer. See api/_lib/print/gate.js and specs/PRINT_PIPELINE.md.
	const lineage = await loadLineage(source.creationId);
	const gate = await runFabricationGate({
		stage: 'quote',
		lineageText: lineage.text || source.creation?.prompt || '',
		modelTitle: typeof body.title === 'string' ? body.title : '',
		buyerNote: typeof body.note === 'string' ? body.note : '',
		analysis: report,
	});
	if (gate.verdict === 'refuse') {
		// 451 rather than a 200 with a flag: an agent lane must be able to branch
		// on the status alone, and a refused order must never reach a paid call.
		return error(res, 451, 'fabrication_refused', gate.message, {
			category: gate.category,
			label: gate.label,
			allowed: gate.allowed,
			policy_url: gate.policy_url,
			stage: gate.stage,
		});
	}

	const catalog = loadCatalog();
	const base = {
		report,
		creation: source.creation,
		sourceUrl: source.url,
		reportHash: reportHashOf(report),
		// Every material measured against this mesh: the height band it can be
		// printed at, or the reason it cannot. The page builds its material cards
		// and bounds its size slider from this, so a buyer never drags into a
		// rejection the server could have predicted.
		fits: materialFits({ report, catalog: loadCatalog() }),
		// The verdict rides along so the page and the agent lane can see that a
		// screening pass will run after payment, rather than discovering it as a
		// surprise rejection later.
		screening: { verdict: gate.verdict, stage: gate.stage, policy_url: gate.policy_url },
	};

	// No material chosen: this is the analyze call. Free, keyless, no price.
	if (!body.materialId) return json(res, 200, base, { 'cache-control': 'no-store' });

	// The holder discount reads the signed-in user's $THREE tier. Anonymous
	// buyers quote at list price and the panel says so, rather than showing a
	// discount they cannot claim at checkout.
	const user = await getSessionUser(req).catch(() => null);
	const discountBps = user ? await holderDiscountBps(user) : 0;

	const priced = quotePrint({
		report,
		materialId: String(body.materialId),
		finishId: body.finishId ? String(body.finishId) : null,
		targetHeightMm: Number(body.targetHeightMm),
		quantity: Number(body.quantity) || 1,
		country: body.country,
		hollow: Boolean(body.hollow),
		holderDiscountBps: discountBps,
		catalog,
	});

	if (!priced.ok) {
		// A rejection is guidance, not an error: it names the measured number, the
		// required number, the fix, and every material that would take this mesh.
		return json(res, 200, { ...base, quote: null, rejection: priced.rejection }, { 'cache-control': 'no-store' });
	}

	// A quote-on-request material (metal) is priced as an estimate and gets no
	// token: nothing can be checked out at a number an engineer has not confirmed.
	const token = priced.quote.quoteOnRequest
		? null
		: signQuote(priced.quote, {
				reportHash: base.reportHash,
				sourceUrl: source.url,
				creationId: source.creationId,
			});

	return json(
		res,
		200,
		{
			...base,
			quote: priced.quote,
			rejection: null,
			token,
			holderTierApplied: discountBps > 0,
			expiresInSeconds: token ? catalog.pricing.quoteTtlSeconds : null,
		},
		{ 'cache-control': 'no-store' },
	);
});
