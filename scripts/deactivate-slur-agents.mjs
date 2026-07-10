#!/usr/bin/env node
/**
 * Withhold already-indexed ERC-8004 agents whose on-chain metadata carries a hate slur.
 *
 * The crawler hydrates every registered agent's display name, description and image
 * from attacker-controlled on-chain metadata, and until the gate in
 * api/_lib/display-name-safety.js existed, `active` was decided solely by the agent's
 * own `meta.active`. The hydration cron now withholds new offenders, but rows indexed
 * before it landed are still `active = true`. This script cleans those up.
 *
 * Every public feed (explore, marketplace, agents, search) filters `active = true`,
 * so flipping that one flag removes the row from every surface at once. The row is
 * kept — not deleted — so a re-hydration can restore it if the owner renames the
 * agent on-chain, and so the reason is auditable.
 *
 * Slurs only, never general profanity: every false positive silently delists a
 * legitimate agent. Run with --dry-run first; it prints counts, never the names.
 *
 * Usage:
 *   node --env-file=.env.local scripts/deactivate-slur-agents.mjs --dry-run
 *   node --env-file=.env.local scripts/deactivate-slur-agents.mjs
 */

import { neon } from '@neondatabase/serverless';
import { matchedSlurStem } from '../api/_lib/display-name-safety.js';

const DRY = process.argv.includes('--dry-run');

if (!process.env.DATABASE_URL) {
	console.error('[slur-scan] DATABASE_URL unset — run with: node --env-file=.env.local ' + process.argv[1]);
	process.exit(1);
}
const sql = neon(process.env.DATABASE_URL);

// Scan only rows that could actually surface. The matcher is cheap, but the index
// has >120k rows, so pull just what a feed could render.
const rows = await sql`
	SELECT chain_id, agent_id, name, description
	  FROM erc8004_agents_index
	 WHERE active = true
	   AND (name IS NOT NULL OR description IS NOT NULL)
`;

console.log(`[slur-scan] scanning ${rows.length} active indexed agents`);

const hits = [];
for (const r of rows) {
	const stem = matchedSlurStem(`${r.name || ''} ${r.description || ''}`);
	if (stem) hits.push({ ...r, stem });
}

if (!hits.length) {
	console.log('[slur-scan] clean — no active agent carries a slur');
	process.exit(0);
}

// Report the stem and the chain/agent id, never the offending text itself.
const byStem = hits.reduce((a, h) => ((a[h.stem] = (a[h.stem] || 0) + 1), a), {});
console.log(`[slur-scan] ${hits.length} offending row(s):`, byStem);
for (const h of hits) console.log(`  chain ${h.chain_id} agent ${h.agent_id} — matched "${h.stem}"`);

if (DRY) {
	console.log('[slur-scan] --dry-run: nothing written');
	process.exit(0);
}

let n = 0;
for (const h of hits) {
	await sql`
		UPDATE erc8004_agents_index
		   SET active = false
		 WHERE chain_id = ${h.chain_id} AND agent_id = ${h.agent_id}
	`;
	n++;
}
console.log(`[slur-scan] withheld ${n} agent(s) — they no longer appear on any public feed`);
process.exit(0);
