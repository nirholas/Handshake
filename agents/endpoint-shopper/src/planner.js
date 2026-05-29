// LLM-based task decomposition for the Endpoint Shopper agent.
//
// Given a task string and a Bazaar catalog summary, generates a structured
// step plan that the orchestrator can execute. Planning is fast/cheap work, so
// it runs on the platform's funded free providers (Groq/OpenRouter) by default,
// using Anthropic only when the operator supplies their own key.

import { llmComplete } from '../../../api/_lib/llm.js';

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

	const { text } = await llmComplete({
		system: SYSTEM_PROMPT,
		user: prompt,
		maxTokens: 512,
		anthropicKey: process.env.ANTHROPIC_API_KEY,
		timeoutMs: 15_000,
	});
	const raw = text || '[]';

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
