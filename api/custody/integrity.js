// GET /api/custody/integrity : public, no-auth aggregate for the Proof-of-Custody
// integrity page. Returns the latest attestation epoch, its Merkle root, the
// on-chain anchor tx, the wallet count, and aggregate SOL. Never any per-wallet
// private data. The public face of "our custody is provable".

import { cors, json, method, serverError } from '../_lib/http.js';
import { getPublicIntegrity } from '../_lib/custody-proof.js';

export default async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;
	try {
		const data = await getPublicIntegrity();
		// Public aggregate, safe to CDN-cache briefly so the integrity page stays
		// snappy without hammering the DB. New epochs land at most every few hours.
		res.setHeader('cache-control', 'public, s-maxage=60, stale-while-revalidate=300');
		return json(res, 200, { data });
	} catch (err) {
		return serverError(res, 500, 'integrity_failed', err);
	}
}
