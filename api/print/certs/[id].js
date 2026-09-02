/**
 * GET /api/print/certs/:id — one Materialize certificate, publicly readable.
 *
 * A certificate is a public proof by design: the QR printed on the box has to
 * resolve for whoever is holding the box, which is frequently not the buyer and
 * never a signed-in session. So this endpoint takes no credentials and returns
 * no PII: no shipping address, no buyer, no order id beyond the certificate's
 * own identity.
 *
 * One field is conditional. A print of a PRIVATE forge creation renders its
 * certificate in full (the holder owns the object and deserves the proof) but
 * withholds the prompt, which is the creator's, and reports
 * `creation.prompt_withheld: true` so the page can say so instead of showing a
 * blank where the lineage should be.
 *
 * The response carries the raw `memo` string that was signed on-chain, so a
 * verifier can compare hashes without trusting this endpoint, this database, or
 * any block explorer.
 */

import { cors, json, method, wrap, rateLimited } from '../../_lib/http.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { getPublicCertificate, CERT_ID_RE } from '../../_lib/print/certificate.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcp3dStatus(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://localhost');
	const raw = url.searchParams.get('id') || '';
	const id = String(raw).trim().toLowerCase();
	if (!CERT_ID_RE.test(id)) {
		return json(res, 400, { error: 'invalid certificate id' });
	}

	const certificate = await getPublicCertificate(id);
	if (!certificate) {
		return json(res, 404, { error: 'certificate not found' });
	}

	// Certificates are immutable except for the attestation landing, so a short
	// public cache is safe and keeps a scanned QR fast on a phone network.
	return json(res, 200, { certificate }, {
		'cache-control': certificate.solana_signature
			? 'public, max-age=300, s-maxage=3600'
			: 'public, max-age=15, s-maxage=15',
	});
});
