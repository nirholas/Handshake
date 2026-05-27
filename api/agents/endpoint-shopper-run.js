// POST /api/agents/endpoint-shopper-run
//
// Paid endpoint that runs the Endpoint Shopper agent: discovers relevant x402
// endpoints in the Bazaar, plans a multi-step execution, calls each endpoint
// within the requested budget, and synthesizes a final answer.
//
// Price: $0.01 base (10_000 atomics). The agent itself may spend up to
// maxCostUsd from the body (capped at $2.00) on downstream endpoint calls.
//
// Body: { task: string, maxCostUsd?: number }
//
// Response 200: { result, steps, totalCostUsdc, cachedAt? }

import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../_lib/x402-prices.js';
import { run } from '../../agents/endpoint-shopper/src/orchestrator.js';

const ROUTE = '/api/agents/endpoint-shopper-run';

const DESCRIPTION =
	'three.ws Endpoint Shopper — given a task description and a budget ceiling, ' +
	'the agent discovers relevant paid x402 endpoints in the Bazaar, plans a ' +
	'multi-step execution, calls each endpoint within budget, and synthesizes a ' +
	'concise final answer. Returns the full step trace with per-step cost breakdowns ' +
	'so agents and builders can see exactly where funds were spent.';

const INPUT_EXAMPLE = {
	task: "What's Ethereum's current price?",
	maxCostUsd: 0.5,
};

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['task'],
	properties: {
		task: {
			type: 'string',
			description: 'Natural-language task for the agent to complete.',
			minLength: 1,
			maxLength: 500,
		},
		maxCostUsd: {
			type: 'number',
			description: 'Maximum spend on downstream endpoint calls in USD (default 0.50, max 2.00).',
			minimum: 0.01,
			maximum: 2.0,
		},
	},
};

const OUTPUT_EXAMPLE = {
	result: {
		answer: 'Ethereum is currently trading at $3,245.12 USD.',
		data: null,
	},
	steps: [
		{
			step: 1,
			action: 'discover',
			description: 'Found 4 relevant endpoints',
			costUsdc: '0.000000',
			output: [],
		},
		{
			step: 2,
			action: 'plan',
			description: 'Planned 3 execution steps',
			costUsdc: '0.000000',
			output: [],
		},
		{
			step: 3,
			action: 'call',
			endpoint: 'https://three.ws/api/x402/eth-price',
			description: 'Fetch current ETH price',
			costUsdc: '0.001000',
			output: { price: 3245.12 },
		},
		{
			step: 4,
			action: 'synthesize',
			description: 'Synthesized final answer',
			costUsdc: '0.000000',
			output: { answer: 'Ethereum is currently trading at $3,245.12 USD.' },
		},
	],
	totalCostUsdc: '0.001000',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['result', 'steps', 'totalCostUsdc'],
	properties: {
		result: {
			type: 'object',
			required: ['answer'],
			properties: {
				answer: { type: 'string' },
				data: {},
			},
		},
		steps: {
			type: 'array',
			items: {
				type: 'object',
				required: ['step', 'action', 'description', 'costUsdc'],
				properties: {
					step: { type: 'integer' },
					action: { type: 'string', enum: ['discover', 'plan', 'call', 'synthesize'] },
					endpoint: { type: 'string' },
					description: { type: 'string' },
					costUsdc: { type: 'string' },
					output: {},
				},
			},
		},
		totalCostUsdc: { type: 'string' },
		cachedAt: { type: 'string', format: 'date-time' },
	},
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: {
			type: 'http',
			method: 'POST',
			bodyType: 'json',
			body: INPUT_EXAMPLE,
		},
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodyType: 'json',
		bodySchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

export default paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: priceFor('endpoint-shopper-run', '10000'),
	networks: ['base', 'solana'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Endpoint Shopper',
		tags: ['agent', 'orchestration', 'bazaar', 'x402'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
	async handler({ req }) {
		// Parse body — Vercel parses JSON automatically when content-type is set
		const body = typeof req.body === 'object' && req.body !== null ? req.body : {};

		const task = String(body.task || '').trim();
		if (!task) {
			const err = new Error('body field "task" is required');
			err.status = 400;
			err.code = 'missing_task';
			throw err;
		}
		if (task.length > 500) {
			const err = new Error('"task" must be 500 characters or fewer');
			err.status = 400;
			err.code = 'task_too_long';
			throw err;
		}

		const rawCost = body.maxCostUsd;
		const maxCostUsd =
			rawCost != null ? Math.min(2.0, Math.max(0.01, Number(rawCost) || 0.5)) : 0.5;

		const result = await run({ task, maxCostUsd });
		return { ...result, cachedAt: new Date().toISOString() };
	},
});
