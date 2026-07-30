// Fixture: a genuinely read-only tool. Its name contains a word the old
// name-based heuristic treated as a mutation ("resolve", "open"), and it imports
// a module that can write without ever calling the writing function. The gate
// must stay silent on both counts.
import { sql } from '../../../api/_lib/db.js';

const LIVE_READ = Object.freeze({
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
});

async function unusedWriter(id) {
	await sql`update fixture_visits set seen = true where agent_id = ${id}`;
}

export const toolDefs = [
	{
		name: 'fixture_resolve_open',
		title: 'Fixture resolve open',
		annotations: LIVE_READ,
		description: 'Resolves a name and lists open items. Reads only.',
		inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
		async handler(args) {
			const rows = await sql`select id from fixture_visits where agent_id = ${args.name}`;
			return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
		},
	},
];

export { unusedWriter };
