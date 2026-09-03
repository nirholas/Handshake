// GET /api/cron/home-relay-sweep, housekeeping for the dial-out relay.
//
// Two jobs, both small, both the kind of thing that quietly rots if nobody owns
// it:
//
//   1. Prune pairings that can never be redeemed again. A redeemed pairing has
//      no further use and an expired one is noise, so neither should accumulate
//      in a table whose only hot query is "is this code live". The row is kept
//      for a day after it dies so an owner asking "did my house pair, and what
//      paired with it" still has an answer the same afternoon.
//
//   2. Reconcile status for relayed homes that are still waiting. A home whose
//      code expired without a house ever arriving sits in `pending` forever with
//      a status_detail that stopped being true ten minutes in. The connect UI
//      reads that line verbatim, so leaving it stale is how a page ends up
//      confidently telling somebody the wrong thing.
//
// Deliberately NOT here: anything that decides a home is broken because its
// house is offline right now. A house goes away every time Home Assistant
// restarts and comes back on its own, and a cron that marked those unreachable
// would generate a stream of false alarms about houses that are perfectly fine.

import { sql } from '../_lib/db.js';
import { requireCron } from '../_lib/cron-auth.js';
import { prunePairings } from '../_lib/home/relay.js';
import { json, method, wrapCron } from '../_lib/http.js';

/** How long a dead pairing is kept so the owner can still read what happened. */
const KEEP_HOURS = 24;

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const { pruned } = await prunePairings({ olderThanHours: KEEP_HOURS });

	// A relayed home still pending, with no live pairing left, is waiting for
	// something that will never arrive. Say so, once, in the column the connect
	// screen renders.
	const stalled = await sql`
		update home_connections c
		set status_detail = 'The pairing code expired before this home connected. Generate a new one to pair it.',
		    updated_at = now()
		where c.transport = 'relay'
		  and c.status = 'pending'
		  and c.revoked_at is null
		  and c.created_at < now() - interval '20 minutes'
		  and c.status_detail is distinct from 'The pairing code expired before this home connected. Generate a new one to pair it.'
		  and not exists (
		    select 1 from home_relay_pairings p
		    where p.home_id = c.id and p.redeemed_at is null and p.expires_at > now()
		  )
		returning c.id
	`;

	return json(res, 200, { ok: true, pruned, stalled: stalled.length });
});
