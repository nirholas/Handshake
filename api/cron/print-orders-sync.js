// GET /api/cron/print-orders-sync — the Materialize reconciliation sweep.
//
// One cron owns everything that has to be reconciled after a print order leaves
// the request path, so the print lane never grows a second scheduler.
//
// Lane in place today: certificate attestation. Issuing a certificate is
// deliberately fail-soft (a shipment is a physical fact and is never rolled
// back because Solana had a bad minute), so a certificate can exist with its
// memo unsent. This sweep finds those, backfills any missing QR, and retries
// the send, oldest first, with a bounded attempt count so a permanently
// unsendable certificate stops burning RPC calls and stays visible in ops
// instead.
//
// Mainnet certificates whose owner approval is not yet recorded come back as
// `refused` rather than `failed`: nothing is wrong with them, they are waiting
// on a person. See api/_lib/print/certificate.js.

import { cors, json, method, wrapCron } from '../_lib/http.js';
import { requireCron } from '../_lib/cron-auth.js';
import { retryPendingAttestations, certCluster } from '../_lib/print/certificate.js';

export const maxDuration = 120;

const BATCH_LIMIT = Number(process.env.PRINT_CERT_RETRY_BATCH) || 10;
const MAX_ATTEMPTS = Number(process.env.PRINT_CERT_MAX_ATTEMPTS) || 8;

export default wrapCron(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	const certificates = await retryPendingAttestations({
		limit: BATCH_LIMIT,
		maxAttempts: MAX_ATTEMPTS,
	});

	return json(res, 200, { ok: true, cluster: certCluster(), certificates });
});
