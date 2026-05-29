// Endpoint Shopper orchestrator.
//
// Executes a full discover → plan → call → synthesize cycle for a given task,
// respecting a caller-supplied budget ceiling. Each paid endpoint call is
// attempted directly; a 402 response is captured in the step output so the
// caller knows payment would be required in a fully-funded flow.

import { discoverEndpoints } from './discover.js';
import { planSteps } from './planner.js';
import { llmComplete } from '../../../api/_lib/llm.js';

const BASE = process.env.PUBLIC_APP_ORIGIN || process.env.APP_ORIGIN || 'https://three.ws';

/**
 * Run the full agent loop.
 *
 * @param {object} opts
 * @param {string} opts.task             Natural-language task
 * @param {number} [opts.maxCostUsd=0.50] Maximum spend in USD
 * @returns {Promise<{
 *   result: { answer: string, data: any },
 *   steps: Array,
 *   totalCostUsdc: string
 * }>}
 */
export async function run({ task, maxCostUsd = 0.50 }) {
	const maxCostAtomics = Math.round(Math.min(maxCostUsd, 2.0) * 1_000_000);
	let totalCostAtomics = 0;
	const steps = [];

	// ── Step 1: Discover relevant endpoints ───────────────────────────────
	let catalog = [];
	try {
		catalog = await discoverEndpoints({ query: task, maxResults: 10 });
	} catch {
		catalog = [];
	}
	steps.push({
		step: 1,
		action: 'discover',
		description: `Searched Bazaar for "${task.slice(0, 60)}${task.length > 60 ? '…' : ''}" — found ${catalog.length} endpoint${catalog.length === 1 ? '' : 's'}`,
		costUsdc: '0.000000',
		output: catalog.slice(0, 5).map((e) => ({ url: e.url, serviceName: e.serviceName, priceUsdc: e.priceUsdc })),
	});

	// ── Step 2: Plan ───────────────────────────────────────────────────────
	let plan = [];
	try {
		plan = await planSteps({ task, catalog, maxSteps: 5 });
	} catch {
		plan = [{ action: 'synthesize', description: 'Synthesize answer from available context' }];
	}
	steps.push({
		step: 2,
		action: 'plan',
		description: `Planned ${plan.length} execution step${plan.length === 1 ? '' : 's'}`,
		costUsdc: '0.000000',
		output: plan.map((s) => ({ action: s.action, description: s.description })),
	});

	// ── Step 3: Execute call steps (budget-gated) ─────────────────────────
	const callSteps = plan.filter((s) => s.action === 'call').slice(0, 3);
	const results = [];

	for (const step of callSteps) {
		// Resolve cost — find matching catalog entry or use floor
		const matched = catalog.find((e) => step.endpoint && step.endpoint.includes(e.url));
		const stepCostAtomics = matched?.priceAtomics || 1_000;

		if (totalCostAtomics + stepCostAtomics > maxCostAtomics) {
			steps.push({
				step: steps.length + 1,
				action: 'call',
				endpoint: step.endpoint,
				description: `Skipped: "${step.description}" — would exceed budget`,
				costUsdc: '0.000000',
				output: { skipped: true, reason: 'budget_exceeded' },
			});
			continue;
		}

		// Build the call URL — attach args as query params for GET endpoints
		let callUrl = step.endpoint || `${BASE}/api/x402/model-check`;
		if (step.args && typeof step.args === 'object' && Object.keys(step.args).length) {
			const qs = new URLSearchParams(
				Object.entries(step.args).map(([k, v]) => [k, String(v)]),
			).toString();
			callUrl = `${callUrl}${callUrl.includes('?') ? '&' : '?'}${qs}`;
		}

		let callOutput;
		let callStatus;
		try {
			const r = await fetch(callUrl, {
				signal: AbortSignal.timeout(15_000),
				headers: { 'accept': 'application/json' },
			});
			callStatus = r.status;
			const raw = await r.json().catch(() => ({ error: 'response parse failed' }));
			if (r.status === 402) {
				callOutput = { payment_required: true, requirements: raw?.accepts || raw };
			} else {
				callOutput = raw;
			}
		} catch (err) {
			callStatus = 502;
			callOutput = { error: err.message };
		}

		const usedAtomics = callStatus !== 402 ? stepCostAtomics : 0;
		totalCostAtomics += usedAtomics;

		steps.push({
			step: steps.length + 1,
			action: 'call',
			endpoint: callUrl,
			description: step.description,
			costUsdc: (usedAtomics / 1_000_000).toFixed(6),
			output: callOutput,
		});

		if (callOutput && !callOutput.error && !callOutput.payment_required) {
			results.push(callOutput);
		}
	}

	// ── Step 4: Synthesize ─────────────────────────────────────────────────
	const answer = await synthesize({ task, results, catalog, plan });
	steps.push({
		step: steps.length + 1,
		action: 'synthesize',
		description: 'Synthesized final answer from all collected results',
		costUsdc: '0.000000',
		output: { answer },
	});

	return {
		result: { answer, data: results[0] || null },
		steps,
		totalCostUsdc: (totalCostAtomics / 1_000_000).toFixed(6),
	};
}

/**
 * LLM synthesis — combine collected data into a concise final answer.
 *
 * @param {object} opts
 * @param {string} opts.task
 * @param {Array}  opts.results   Data returned by endpoint calls
 * @param {Array}  opts.catalog   Discovered endpoints (used when results are empty)
 * @param {Array}  opts.plan      The execution plan
 * @returns {Promise<string>}
 */
async function synthesize({ task, results, catalog, plan }) {
	let context;
	if (results.length > 0) {
		context = `Collected data from endpoint calls:\n${JSON.stringify(results, null, 2)}`;
	} else if (catalog.length > 0) {
		context =
			`No endpoint data was collected (calls returned 402 or were skipped). ` +
			`Available endpoints in the Bazaar for this task:\n${catalog
				.slice(0, 5)
				.map((e) => `- ${e.serviceName}: ${e.description} (${e.url}, $${e.priceUsdc} USDC)`)
				.join('\n')}`;
	} else {
		context = 'No endpoint data was collected and no relevant endpoints were found in the Bazaar.';
	}

	const prompt =
		`Task: "${task}"\n\n` +
		`${context}\n\n` +
		`Provide a concise, direct answer to the task based on this information. ` +
		`If data was collected, summarize the key findings. ` +
		`If calls required payment (402), explain what endpoints are available and what they would return. ` +
		`2-4 sentences maximum.`;

	try {
		const { text } = await llmComplete({
			user: prompt,
			maxTokens: 256,
			anthropicKey: process.env.ANTHROPIC_API_KEY,
			timeoutMs: 15_000,
		});
		return text || 'Unable to synthesize answer.';
	} catch {
		return 'Unable to synthesize answer — request timed out or failed.';
	}
}
