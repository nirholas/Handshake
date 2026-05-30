#!/usr/bin/env node
// Link an already-launched pump.fun mint (e.g. from direct-pump-launch.mjs) to an
// agent_identity, so it surfaces as that agent's coin. Mirrors the insert the
// native /api/agents/{id}/pumpfun/launch endpoint performs into pump_agent_mints.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/link-direct-launch.mjs \
//     --agent <agent_id> --mint <mint> --uri <metadataUrl> \
//     --name <name> --symbol <symbol> --authority <creatorWallet> [--network mainnet]
//
// Idempotent on (mint, network). Verifies the agent exists before writing.

import process from 'node:process';
import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	console.error('DATABASE_URL not set.');
	process.exit(2);
}

function parseArgs(argv) {
	const opts = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith('--')) opts[argv[i].slice(2)] = argv[++i];
	}
	return opts;
}
const o = parseArgs(process.argv.slice(2));
const required = ['agent', 'mint', 'uri', 'authority'];
for (const k of required) {
	if (!o[k]) {
		console.error(`Missing --${k}`);
		process.exit(2);
	}
}
const network = o.network || 'mainnet';
const name = o.name ?? '';
const symbol = o.symbol ?? '';

const sql = neon(DATABASE_URL);

const [agent] = await sql`
	select id, name, user_id from agent_identities
	where id = ${o.agent} and deleted_at is null limit 1
`;
if (!agent) {
	console.error(`agent_identities.id=${o.agent} not found (or deleted). Nothing written.`);
	process.exit(3);
}
console.log(`agent:     ${agent.id}  "${agent.name}"  (user ${agent.user_id})`);

const existing = await sql`
	select id, agent_id from pump_agent_mints where mint = ${o.mint} and network = ${network} limit 1
`;
if (existing.length) {
	console.log(`note:      mint already in pump_agent_mints (id ${existing[0].id}, agent ${existing[0].agent_id}) — updating.`);
}

const inserted = await sql`
	insert into pump_agent_mints
		(agent_id, user_id, network, mint, name, symbol, metadata_uri, agent_authority)
	values
		(${agent.id}, ${agent.user_id}, ${network}, ${o.mint},
		 ${name}, ${symbol}, ${o.uri}, ${o.authority})
	on conflict (mint, network) do update set
		updated_at   = now(),
		agent_id     = excluded.agent_id,
		name         = excluded.name,
		symbol       = excluded.symbol,
		metadata_uri = excluded.metadata_uri
	returning id, agent_id, created_at, updated_at
`;
const row = inserted[0];
console.log(`linked:    pump_agent_mints.id=${row.id}  agent_id=${row.agent_id}`);
console.log(`           created ${row.created_at}  updated ${row.updated_at}`);
console.log(`\nDone. /agent/${agent.id} (and /agent-next?id=${agent.id}) should now show mint ${o.mint}.`);
