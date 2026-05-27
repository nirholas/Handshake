// LLM-based task decomposition for the Endpoint Shopper agent.
//
// Given a task string and a Bazaar catalog summary, generates a structured
// step plan that the orchestrator can execute. Uses claude-haiku for fast,
// cheap planning — the heavy work is in the endpoint calls themselves.

const SYSTEM_PROMPT =
	'You are a task planner for an AI agent. Given a task and a catalog of available paid API endpoints, ' +
	'create a step plan. Respond with JSON only: an array of steps with fields: ' +
	'action ("discover"|"call"|"synthesize"), ' +
	'description (what this step does), ' +
	'endpoint (URL if calling — must match a URL from the catalog), ' +
	'args (object of query params or body fields if calling). ' +
	'Keep to 3-5 steps. Always end with a "synthesize" step. ' +
	'Only emit "call" steps for endpoints that are plausibly relevant to the task. ' +
	'If no catalog endpoints fit, still include the synthesize step and note the gap.';

/**
 * Plan a multi-step execution for a task using available Bazaar endpoints.
 *
 * @param {object} opts
 * @param {string} opts.task           Natural-language task description
 * @param {Array}  opts.catalog        Array of { url, serviceName, description, tags, priceUsdc }
 * @param {number} [opts.maxSteps=5]   Max steps to request
 * @returns {Promise<Array<{ action: string, endpoint?: string, args?: object, description: string }>>}
 */
export async function planSteps({ task, catalog, maxSteps = 5 }) {
	const catalogSummary = catalog
		.slice(0, 20)
		.map(
			(e, i) =>
				`${i + 1}. [${e.serviceName || 'unknown'}] ${e.url}\n   ${e.description || '(no description)'}\n   Price: $${e.priceUsdc || '?'} USDC  Tags: ${(e.tags || []).join(', ')}`,
		)
		.join('\n\n');

	const prompt =
		`Task: "${task}"\n\n` +
		`Available endpoints (catalog):\n${catalogSummary || '(none found)'}\n\n` +
		`Create a plan of at most ${maxSteps} steps to complete the task. ` +
		`Respond with a JSON array only — no markdown, no explanation.`;

	const response = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': process.env.ANTHROPIC_API_KEY,
			'anthropic-version': '2023-06-01',
		},
		body: JSON.stringify({
			model: 'claude-haiku-4-5-20251001',
			max_tokens: 512,
			system: SYSTEM_PROMPT,
			messages: [{ role: 'user', content: prompt }],
		}),
		signal: AbortSignal.timeout(15_000),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => '');
		throw Object.assign(new Error(`Anthropic API error ${response.status}: ${text}`), {
			status: 502,
			code: 'planner_api_error',
		});
	}

	const data = await response.json();
	const raw = data.content?.[0]?.text || '[]';

	// Strip possible markdown code fence wrapping
	const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();

	let plan;
	try {
		plan = JSON.parse(cleaned);
	} catch {
		// LLM returned non-JSON — fall back to a minimal plan
		plan = [
			{
				action: 'synthesize',
				description: 'Synthesize answer from available context (planning failed to parse)',
			},
		];
	}

	if (!Array.isArray(plan)) {
		plan = [
			{
				action: 'synthesize',
				description: 'Synthesize answer from available context',
			},
		];
	}

	// Sanitize each step — ensure required fields exist
	return plan.slice(0, maxSteps).map((s) => ({
		action: ['discover', 'call', 'synthesize'].includes(s.action) ? s.action : 'call',
		description: String(s.description || 'Execute step'),
		...(s.endpoint ? { endpoint: String(s.endpoint) } : {}),
		...(s.args && typeof s.args === 'object' ? { args: s.args } : {}),
	}));
}
