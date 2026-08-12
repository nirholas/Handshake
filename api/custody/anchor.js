// GET /api/custody/anchor?epoch=N : public anchor reference for one epoch. It
// carries the Merkle root, the on-chain anchor tx signature, and the network it
// was committed on. Lets a verifier cross-check the root it computed against
// what the platform recorded, though the authoritative check reads the root
// straight off-chain.
//
// Returns only public epoch metadata; no per-wallet leaves.

import { cors, json, method, error, serverError } from '../_lib/http.js';
import { getAnchorRef, getLatestAnchorRef } from '../_lib/custody-proof.js';

// Epochs are a bigint column starting at 1. Bound the accepted input to 18
// digits so an oversized number is a client error here rather than a Postgres
// "out of range for type bigint" that surfaces as a 500 (which is what
// ?epoch=99999999999999999999999999 used to return).
const EPOCH_RE = /^\d{1,18}$/;

export default async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;
	try {
		const url = new URL(req.url, 'http://x');
		const epochRaw = url.searchParams.get('epoch');
		let ref;
		if (epochRaw == null || epochRaw === '' || epochRaw === 'latest') {
			ref = await getLatestAnchorRef();
		} else if (EPOCH_RE.test(epochRaw) && Number(epochRaw) >= 1) {
			ref = await getAnchorRef(Number(epochRaw));
		} else {
			return error(res, 400, 'bad_request', 'epoch must be a positive integer (1 to 18 digits) or "latest"');
		}
		if (!ref) return error(res, 404, 'not_found', 'no such epoch');
		res.setHeader('cache-control', 'public, s-maxage=60, stale-while-revalidate=300');
		return json(res, 200, { data: ref });
	} catch (err) {
		return serverError(res, 500, 'anchor_lookup_failed', err);
	}
}
