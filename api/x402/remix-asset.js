// POST /api/x402/remix-asset — paid remix with automatic creator royalties.
//
// The composable, economic half of conversational 3D: an agent pays a fixed
// remix fee in USDC (x402) to generate a NEW model derived from another
// creator's PUBLISHED, remixable asset. The platform collects the fee, generates
// the remix (a real anchored regeneration off the source), links the durable
// parent → child provenance edge, and then routes the source creator's royalty
// slice on-chain from the platform payout wallet — a real second USDC transfer,
// capped at 20%, with the remixer always keeping the clear majority of value.
//
// Why this shape: the x402 rail settles to ONE recipient (the platform), so the
// split is composed — fee in via x402, royalty out via a guarded treasury
// transfer (api/_lib/remix-settlement.js). Split + caps are pure and unit-tested
// (api/_lib/remix-royalty.js). Provenance is stored on the existing
// forge_creations rows (parent_creation_id + remix_settlement_ref) — no parallel
// store. $THREE-policy clean: USDC is the settlement asset only.
//
// The pre-remix disclosure (a source's terms + royalty rate) is free on
// GET /api/remix-feed; this endpoint is the paid execution.

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { readJson, json } from '../_lib/http.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { getRemixSource, linkRefinement } from '../_lib/forge-store.js';
import { settleRemixRoyalty } from '../_lib/remix-settlement.js';
import { atomicsToUsd } from '../_lib/remix-royalty.js';
import { composeRefinement } from '../../mcp-server/src/tools/_lineage.js';
import { generate, originFromReq, viewerUrl } from '../_mcp-studio/forge-client.js';
import remixAssetListing from '../_lib/service-catalog/services/remix-asset.js';
import { unlockBadge, BADGES } from '../_lib/streaks.js';
import { publishUserEvent } from '../_lib/feed.js';

// $0.25 — the cost of a generation. The creator royalty comes OUT of this fee
// (the platform's share), never as an extra charge to the remixer.
const PRICE_ATOMICS = '250000';

const INPUT_SCHEMA = {
	type: 'object',
	required: ['source_creation_id', 'instruction'],
	properties: {
		source_creation_id: { type: 'string', minLength: 1, maxLength: 64, description: 'The id of a remixable creation (from GET /api/remix-feed).' },
		instruction: { type: 'string', minLength: 1, maxLength: 500, description: 'The change to make, in plain language.' },
	},
};

const OUTPUT_SCHEMA = {
	type: 'object',
	properties: {
		ok: { type: 'boolean' },
		remix: { type: 'object' },
		source: { type: 'object' },
		royalty: { type: 'object' },
		fee: { type: 'object' },
	},
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: {
			type: 'http',
			method: 'POST',
			bodyType: 'json',
			body: { source_creation_id: '00000000-0000-0000-0000-000000000000', instruction: 'make it metallic' },
		},
		output: {
			type: 'json',
			example: {
				ok: true,
				remix: { glbUrl: 'https://three.ws/cdn/creations/def456/mesh.glb', creationId: 'def456' },
				source: { id: '00000000-0000-0000-0000-000000000000', royaltyPercent: 10 },
				royalty: { paid: true, creatorUsd: 0.025, creatorTx: '5eyk…', capped: false },
				fee: { usd: 0.25, atomics: '250000' },
			},
		},
	},
	schema: buildBazaarSchema({ method: 'POST', bodySchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA }),
};

class RemixError extends Error {
	constructor(status, code, message) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

async function handleRemix({ req, requirement }) {
	const body = await readJson(req).catch(() => ({}));
	const sourceId = String(body?.source_creation_id || '').trim();
	const instruction = String(body?.instruction || '').trim();
	if (!sourceId) throw new RemixError(400, 'missing_source', 'source_creation_id is required');
	if (!instruction) throw new RemixError(400, 'missing_instruction', 'instruction is required (e.g. "make it metallic")');
	if (instruction.length > 500) throw new RemixError(400, 'instruction_too_long', 'instruction must be 500 characters or fewer');

	// Load the source and enforce that it is actually opted into the bazaar.
	const source = await getRemixSource({ creationId: sourceId });
	if (!source) throw new RemixError(404, 'source_not_found', 'no finished, stored creation with that id');
	if (!source.remixable) throw new RemixError(403, 'not_remixable', 'this creation is not published as remixable');

	// Real anchored regeneration: carry the source prompt forward + fold in the
	// change, and anchor on the source's reference image when one exists (image→3D).
	const composed = composeRefinement(source.prompt || '', instruction);
	const base = originFromReq(req);
	const anchorImage =
		typeof source.previewImageUrl === 'string' && /^https?:\/\//i.test(source.previewImageUrl)
			? source.previewImageUrl
			: null;

	let job;
	try {
		job = await generate(
			base,
			anchorImage ? { prompt: composed, imageUrls: [anchorImage], aspect: source.aspect || '1:1' } : { prompt: composed },
			{ timeoutEnv: 'REMIX_ASSET_TIMEOUT_MS' },
		);
	} catch (err) {
		throw new RemixError(502, err.code === 'timeout' ? 'generation_timeout' : 'generation_failed', `remix generation failed: ${err.message}`);
	}
	if (job._timedOut || !job.glb_url) {
		// Nothing was delivered, so we do NOT settle — the remixer keeps their
		// funds and can retry the same payment (payment-identifier makes it safe).
		throw new RemixError(504, 'generation_timeout', 'remix generation did not finish in time — no fee was charged; retry with the same payment');
	}

	// Durable provenance: link the derived creation to its source.
	const remixCreationId = job.creation_id ?? null;
	if (remixCreationId) {
		await linkRefinement({
			creationId: remixCreationId,
			clientKey: null, // platform-authoritative link; remixer is not the owner
			parentCreationId: source.id,
			refineInstruction: instruction,
			lineageIndex: (source.lineageIndex ?? 0) + 1,
		});
	}

	// Route the creator royalty out of the collected fee. settleRemixRoyalty is
	// honest about every outcome (paid / no wallet / sub-dust / unconfigured).
	const feeAtomics = requirement?.amount || PRICE_ATOMICS;
	let royalty;
	try {
		royalty = await settleRemixRoyalty({ source, priceAtomics: feeAtomics, remixCreationId });
	} catch (err) {
		// The remix WAS generated and the fee WILL settle; the royalty transfer
		// alone failed. Report it truthfully rather than pretending it paid.
		royalty = { paid: false, reason: 'royalty_transfer_failed', error: err.message };
	}

	// Notify the source creator (real signed-in creators only — anonymous
	// forge_creations rows have no user_id to notify). Fire-and-forget, never
	// blocks the response; folds the royalty outcome into the same notice so a
	// creator learns "you were remixed" and "you got paid" in one line.
	if (source.userId) {
		publishUserEvent(source.userId, {
			type: 'remix',
			actor: 'Someone',
			link: remixCreationId ? viewerUrl(base, job.glb_url) : '/profile',
			sourcePrompt: source.prompt,
			creationId: remixCreationId,
			royaltyPaid: royalty.paid,
			royaltyUsd: royalty.creatorUsd ?? 0,
		});
		// First-remix-received badge — a real earned record, awarded once.
		unlockBadge(source.userId, BADGES.FIRST_REMIX_RECEIVED).catch(() => {});
	}

	return {
		ok: true,
		remix: {
			glbUrl: job.glb_url,
			viewerUrl: viewerUrl(base, job.glb_url),
			creationId: remixCreationId,
			prompt: composed,
			instruction,
			anchored: Boolean(anchorImage),
		},
		source: {
			id: source.id,
			prompt: source.prompt,
			royaltyBps: source.royaltyBps,
			royaltyPercent: Math.round((source.royaltyBps / 100) * 10) / 10,
		},
		royalty: {
			paid: royalty.paid,
			...(royalty.reason ? { reason: royalty.reason } : {}),
			royaltyBps: royalty.royaltyBps ?? source.royaltyBps,
			capped: royalty.capped ?? false,
			creatorUsd: royalty.creatorUsd ?? 0,
			platformUsd: royalty.platformUsd ?? atomicsToUsd(feeAtomics),
			creatorAtomics: royalty.creatorAtomics ?? '0',
			...(royalty.creatorTx ? { creatorTx: royalty.creatorTx } : {}),
			...(royalty.settlement ? { settlement: royalty.settlement } : {}),
		},
		fee: { usd: atomicsToUsd(feeAtomics), atomics: String(feeAtomics) },
		note:
			'The remix fee settled to the platform via x402 (see X-PAYMENT-RESPONSE). ' +
			(royalty.paid
				? `The creator royalty of ${royalty.creatorUsd} USDC settled on-chain (creatorTx above).`
				: `No creator royalty was routed (${royalty.reason || 'no payout'}).`),
	};
}

// Single source of truth: api/_lib/service-catalog/services/remix-asset.js is
// the storefront listing copy — importing it here keeps the live 402 challenge
// from drifting from what /.well-known/x402.json and the OKX projection
// advertise (same pattern as forge.js → forge-listing.js).
export default paidEndpoint({
	route: '/api/x402/remix-asset',
	method: 'POST',
	priceAtomics: PRICE_ATOMICS,
	networks: ['solana', 'base'],
	description: remixAssetListing.description,
	mimeType: 'application/json',
	bazaar: BAZAAR,
	// A duplicate call is materially expensive (a GPU generation + an on-chain
	// royalty transfer), so require the payment-identifier idempotency extension.
	paymentIdentifier: { required: true },
	service: withService({
		serviceName: 'Remix a 3D asset + royalties',
		tags: ['3d', 'remix', 'royalties', 'generation'],
	}),
	handler: async ({ req, res, requirement }) => {
		try {
			return await handleRemix({ req, requirement });
		} catch (err) {
			if (err instanceof RemixError) {
				json(res, err.status, { error: err.code, message: err.message });
				return undefined; // response already written; paidEndpoint skips settle
			}
			throw err;
		}
	},
});
