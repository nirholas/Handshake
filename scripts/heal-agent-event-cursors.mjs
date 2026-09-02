#!/usr/bin/env node
// Clear Solana agent-event cursors that are wedged on an unresolvable cursor.
//
// The sweep in api/_lib/solana-agent-events.js resumes each agent from the
// newest signature it saw, passed back as getSignaturesForAddress({ until }).
// The lane router answers from whichever RPC provider is not cooling, and
// providers disagree about which signatures they still hold, so a cursor written
// by one lane is regularly unresolvable by the next. That fails the whole call,
// the cursor is only written on the success path, and the agent stops indexing
// forever while the cron keeps returning 200.
//
// crawlAgentEvents() now recovers on its own (it drops `until`, re-scans from
// the head and clears the dead value), so the sweep heals the backlog by itself
// at one batch per tick. This script is the way to drain the backlog in one pass
// instead of waiting out a full sweep cycle, and the way to re-run the recovery
// on demand the next time a lane change wedges a block of agents.
//
// Usage:
//   node --env-file=.env.local scripts/heal-agent-event-cursors.mjs            # report only
//   node --env-file=.env.local scripts/heal-agent-event-cursors.mjs --apply
//   node --env-file=.env.local scripts/heal-agent-event-cursors.mjs --apply --limit 200
//
// Reads DATABASE_URL, so run it with --env-file=.env.local. Safe to re-run:
// every event lands through `on conflict do nothing`, so a re-scanned window
// inserts nothing twice, and an agent that is already healthy costs one RPC call.

import { sql } from '../api/_lib/db.js';
import { crawlAgentEvents, markAgentEventError } from '../api/_lib/solana-agent-events.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? Math.max(1, parseInt(args[limitArg + 1], 10) || 0) : 5000;

const shape = (e) => String(e || '').replace(/[1-9A-HJ-NP-Za-km-z]{32,}/g, '<sig>');

const rows = await sql`
	SELECT agent_ref, network, error
	FROM agent_event_cursor
	WHERE chain = 'solana' AND error IS NOT NULL
	ORDER BY last_indexed_at ASC
	LIMIT ${limit}
`;

const byShape = new Map();
for (const r of rows) byShape.set(shape(r.error), (byShape.get(shape(r.error)) || 0) + 1);

console.log(`${rows.length} erroring cursor(s), by error class:`);
for (const [k, n] of [...byShape.entries()].sort((a, b) => b[1] - a[1])) {
	console.log(`  ${String(n).padStart(5)}  ${k.slice(0, 110)}`);
}

if (!apply) {
	console.log('\nreport only. Re-run with --apply to re-crawl each of these agents.');
	process.exit(0);
}

let healed = 0;
let stillFailing = 0;
let events = 0;

for (const [i, row] of rows.entries()) {
	try {
		const r = await crawlAgentEvents({ agentRef: row.agent_ref, network: row.network || 'mainnet' });
		healed += 1;
		events += r.inserted;
	} catch (err) {
		stillFailing += 1;
		// Same contract as the cron: stamp the failure so one unreadable account
		// cannot hold the oldest-first queue head forever.
		await markAgentEventError({
			agentRef: row.agent_ref,
			network: row.network || 'mainnet',
			error: err?.message || String(err),
		}).catch(() => {});
	}
	if ((i + 1) % 50 === 0) {
		console.log(`  ${i + 1}/${rows.length}  healed=${healed} stillFailing=${stillFailing} events=${events}`);
	}
}

const [after] = await sql`
	SELECT count(*)::int AS agents, count(error)::int AS errored
	FROM agent_event_cursor WHERE chain = 'solana'
`;
const pct = after.agents ? ((after.errored / after.agents) * 100).toFixed(1) : '0.0';
console.log(`\nhealed ${healed}, still failing ${stillFailing}, ${events} new event(s).`);
console.log(`agent_event_cursor now: ${after.errored}/${after.agents} erroring (${pct}%).`);
process.exit(0);
