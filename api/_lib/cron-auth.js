// The one cron gate. Every scheduled handler (api/cron/*, plus the few tick
// endpoints Cloud Scheduler drives directly) authenticates through this module
// and nowhere else.
//
// Why it is shared: the gate used to be copy-pasted per file. All the copies
// were fail-closed, but there were eleven distinct spellings of the same eight
// lines, two of them with INVERTED return semantics ("true" meant "handled",
// i.e. rejected) — so a future paste had a real chance of landing an accidental
// fail-open, and no single place existed to review or harden. One export, one
// review surface, one set of semantics.
//
// The contract, deliberately fail-closed at every step:
//   • CRON_SECRET unset            → 503, never a pass. A misconfigured deploy
//     must not expose money-moving sweeps (custody attestation, buybacks,
//     wallet intents, budget refunds) to the open internet.
//   • credential compared in constant time → no timing oracle on the secret.
//   • Authorization: Bearer <secret> (case-insensitive scheme, per Cloud
//     Scheduler / Vercel cron) OR X-Cron-Secret: <secret>, which several
//     handlers were already invoked with. Both are the same secret; accepting
//     either is a superset of what each call site accepted before, never a
//     weakening.
//   • The presence of an `x-vercel-cron` (or any other) header is NOT
//     authorization on its own — an inbound header is spoofable if it ever
//     reaches the function unstripped.
//
// Returns true when the caller is the scheduler (handler may proceed). On
// failure it has already written the response and returns false, so every call
// site is `if (!requireCron(req, res)) return;`.

import { error } from './http.js';
import { env } from './env.js';
import { constantTimeEquals } from './crypto.js';

function presentedSecret(req) {
	const auth = req.headers?.['authorization'] || '';
	if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
		return auth.slice(7).trim();
	}
	const header = req.headers?.['x-cron-secret'];
	return typeof header === 'string' ? header.trim() : '';
}

// Is this request the scheduler? No response is written; use requireCron in a
// handler. Exported for the internal fan-out callers that need the verdict
// without the 401/503 side effect.
export function isCronAuthorized(req) {
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) return false;
	return constantTimeEquals(presentedSecret(req), secret);
}

export function requireCron(req, res) {
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) {
		error(res, 503, 'not_configured', 'CRON_SECRET unset');
		return false;
	}
	if (!constantTimeEquals(presentedSecret(req), secret)) {
		error(res, 401, 'unauthorized', 'invalid cron secret');
		return false;
	}
	return true;
}
