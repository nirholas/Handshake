// Fixture: annotations declared in a name-keyed overlay map with spreads instead
// of inline on the tool def, the way the pump.fun server declares them. The gate
// must read through the overlay and the spread.
const LIVE_READ = Object.freeze({
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
});

export const TOOL_ANNOTATIONS = Object.freeze({
	fixture_overlay: { title: 'Fixture Overlay', ...LIVE_READ },
});

export const TOOLS = [
	{
		name: 'fixture_overlay',
		description: 'Annotated through the overlay map.',
		inputSchema: { type: 'object', properties: {} },
		async handler() {
			return { content: [{ type: 'text', text: 'ok' }] };
		},
	},
];
