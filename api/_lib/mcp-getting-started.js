// Shared free "getting_started" MCP tool, the one public, no-payment entry
// point every hosted three.ws MCP server exposes so any client (including
// non-x402 hosts and unauthenticated discovery probes) can learn what the
// server does before connecting or paying.
//
// The tool carries NO `scope` and NO price, so it passes the dispatcher's scope
// check and is served by the anonymous "free" principal. The HTTP endpoints gate
// the no-auth bypass on this exact tool name (isPublicTool), never on merely
// being unpriced, so scoped tools stay locked.

export const GETTING_STARTED_TOOL = 'getting_started';

// First sentence of a tool description: a compact one-liner for the overview.
function firstSentence(text = '') {
	const t = String(text).trim().replace(/\s+/g, ' ');
	const m = t.match(/^.*?[.!?](\s|$)/);
	return (m ? m[0] : t).trim();
}

/**
 * Build the free getting_started toolDef for a server.
 *
 * @param {object} cfg
 * @param {string} cfg.server     Human server name (e.g. "three.ws 3D Studio").
 * @param {string} cfg.tagline    One-line description of what the server does.
 * @param {Array}  cfg.tools      The server's other toolDefs ({ name, description }).
 * @param {Function} [cfg.priceFor]  Optional (name) → { amount_usdc } for priced tools.
 * @param {string[]} [cfg.access] How to access/pay for the server (ordered notes).
 * @param {object} [cfg.links]    Named links (homepage, docs, source, …).
 * @returns {object} toolDef: { name, title, description, inputSchema, handler }
 */
export function buildGettingStartedTool({ server, tagline, tools = [], priceFor, access = [], links = {} }) {
	const toolSummaries = tools
		.filter((t) => t && t.name && t.name !== GETTING_STARTED_TOOL)
		.map((t) => {
			const price = priceFor ? priceFor(t.name) : null;
			return {
				name: t.name,
				summary: firstSentence(t.description),
				...(price && price.amount_usdc > 0 ? { price: `$${price.amount_usdc}/call` } : {}),
			};
		});

	const description =
		`FREE, start here. Returns an overview of the ${server} MCP server: every tool and what it ` +
		`does, how to access it, and useful links. No payment or account required. Call this first to orient.`;

	const inputSchema = {
		type: 'object',
		additionalProperties: false,
		properties: {
			section: {
				type: 'string',
				enum: ['overview', 'tools', 'access', 'links'],
				default: 'overview',
				description:
					'Which part to return. Defaults to "overview" (everything). Use "tools", "access", or "links" to focus.',
			},
		},
	};

	function buildPayload(section) {
		const full = {
			ok: true,
			server,
			tagline,
			tools: toolSummaries,
			access,
			links,
			next_step:
				'Pick a tool from `tools` and call it. ' +
				(access[0] || 'This getting_started tool is free; other tools may require a connection or payment.'),
		};
		if (section === 'tools') return { ok: true, server, tools: toolSummaries };
		if (section === 'access') return { ok: true, server, access };
		if (section === 'links') return { ok: true, server, links };
		return full;
	}

	function renderText(p) {
		if (!p.tagline) return JSON.stringify(p, null, 2);
		return [
			`# ${p.server}: Getting Started`,
			'',
			p.tagline,
			'',
			'## Tools (this getting_started tool is free)',
			...p.tools.map(
				(t) => `- ${t.name}${t.price ? ` (${t.price})` : ''}: ${t.summary}`,
			),
			...(p.access.length ? ['', '## Access', ...p.access.map((a) => `- ${a}`)] : []),
			...(Object.keys(p.links).length
				? ['', '## Links', ...Object.entries(p.links).map(([k, v]) => `- ${k}: ${v}`)]
				: []),
			'',
			`Next: ${p.next_step}`,
		].join('\n');
	}

	return {
		name: GETTING_STARTED_TOOL,
		title: 'Getting Started (free)',
		description,
		// Deliberately no `scope`: callable by the anonymous free principal.
		inputSchema,
		async handler(args = {}) {
			const payload = buildPayload(args?.section || 'overview');
			return {
				content: [{ type: 'text', text: renderText(payload) }],
				structuredContent: payload,
			};
		},
	};
}

// Strict public-tool predicate for the HTTP no-auth bypass. Only the
// getting_started tool qualifies; being unpriced is NOT sufficient.
export function isPublicTool(name) {
	return name === GETTING_STARTED_TOOL;
}
