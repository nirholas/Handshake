// Fixture: a tool with no annotations at all. destructiveHint defaults to TRUE
// when omitted, so the tool is advertised as destructive by accident.
export const toolDefs = [
	{
		name: 'fixture_unannotated',
		title: 'Fixture unannotated',
		description: 'Declares no safety annotations.',
		inputSchema: { type: 'object', properties: {} },
		async handler() {
			return { content: [{ type: 'text', text: 'ok' }] };
		},
	},
];
