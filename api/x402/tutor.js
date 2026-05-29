// POST /api/x402/tutor
//
// Pay-As-You-Learn Tutor — paid x402 micropayment endpoint. Each answered
// question is one $0.01 charge ("1 cent per response"). The response carries the
// running session tab so the UI can render a live, itemized invoice; the free
// GET /api/tutor/session endpoint re-loads that tab for session resume.
//
// Settlement model: this implements the simple per-call settlement — one
// micropayment per explanation, which is the honest, fully-functional form of
// the spec's "bill per explanation". The batch-settlement channel + cooperative
// on-chain refund of unused balance (USE-05/09) is a separate optimization that
// requires the live payment rail to verify and is intentionally not faked here.
//
// Body: { sessionId?: string, question: string, context?: string, level?: "beginner"|"intermediate"|"expert" }
// Response 200: { sessionId, answer, keyPoints, example, followUp, level, model,
//                 costThisCharge, costThisChargeUsd, sessionTotal, sessionTotalUsd,
//                 questionCount, attestation }

import { randomUUID, createHash } from 'crypto';
import { paidEndpoint } from '../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../_lib/x402-spec.js';
import { installAccessControl } from '../_lib/x402/access-control.js';
import { withService } from '../_lib/x402/bazaar-helpers.js';
import { teach, LEVEL_NAMES } from '../../agents/tutor/src/teach.js';
import { appendCharge, atomicsToUsd } from '../../agents/tutor/src/session.js';

const ROUTE = '/api/x402/tutor';
const PRICE_ATOMICS = 10_000; // $0.01 per response

// ── Bazaar schema ──────────────────────────────────────────────────────────────

const DESCRIPTION =
	'three.ws Pay-As-You-Learn Tutor — ask a question (optionally with code or ' +
	'context) and receive a structured, level-appropriate explanation with key ' +
	'takeaways, a worked example, and a suggested follow-up. Billed $0.01 per ' +
	'answer on Base or Solana USDC. Pass a stable sessionId to accumulate an ' +
	'itemized running tab; each response returns the live session total and a ' +
	'SHA-256 attestation over the tab.';

const INPUT_EXAMPLE = {
	sessionId: '8f1c0c2e-2a4d-4b6e-9b1a-3c5d7e9f0a1b',
	question: 'Why does my recursive function overflow the stack?',
	context: 'function f(n){ return f(n-1); }',
	level: 'beginner',
};

const INPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: ['question'],
	properties: {
		sessionId: {
			type: 'string',
			maxLength: 100,
			description: 'Stable session identifier to accumulate a running tab. Omit to start a new session.',
		},
		question: {
			type: 'string',
			minLength: 5,
			maxLength: 2000,
			description: 'The question to be explained.',
		},
		context: {
			type: 'string',
			maxLength: 6000,
			description: 'Optional code or context to ground the explanation.',
		},
		level: {
			type: 'string',
			enum: LEVEL_NAMES,
			default: 'intermediate',
			description: 'Target expertise level — controls depth and assumed background.',
		},
	},
};

const OUTPUT_EXAMPLE = {
	sessionId: '8f1c0c2e-2a4d-4b6e-9b1a-3c5d7e9f0a1b',
	answer:
		'Each call to f() adds a frame to the call stack and never returns, so the stack ' +
		'grows until it exceeds its limit. Recursion needs a base case that stops the calls.',
	keyPoints: [
		'Every function call consumes a stack frame.',
		'Recursion without a base case never unwinds.',
		'Add a condition that returns without recursing.',
	],
	example: 'function f(n){ if (n <= 0) return 0; return n + f(n - 1); }',
	followUp: 'How would you convert this recursion into an iterative loop?',
	level: 'beginner',
	model: 'llama-3.3-70b-versatile',
	costThisCharge: '10000',
	costThisChargeUsd: '0.010000',
	sessionTotal: '30000',
	sessionTotalUsd: '0.030000',
	questionCount: 3,
	attestation: 'sha256:abcd1234...',
};

const OUTPUT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	required: [
		'sessionId',
		'answer',
		'keyPoints',
		'level',
		'costThisCharge',
		'costThisChargeUsd',
		'sessionTotal',
		'sessionTotalUsd',
		'questionCount',
		'attestation',
	],
	properties: {
		sessionId: { type: 'string' },
		answer: { type: 'string' },
		keyPoints: { type: 'array', items: { type: 'string' } },
		example: { type: ['string', 'null'] },
		followUp: { type: ['string', 'null'] },
		level: { type: 'string' },
		model: { type: 'string' },
		costThisCharge: { type: 'string', description: 'Atomics (USDC 6dp) charged for this response.' },
		costThisChargeUsd: { type: 'string' },
		sessionTotal: { type: 'string', description: 'Running session total in atomics.' },
		sessionTotalUsd: { type: 'string' },
		questionCount: { type: 'number' },
		attestation: { type: 'string' },
	},
};

const BAZAAR = {
	discoverable: true,
	info: {
		input: { type: 'http', method: 'POST', bodyType: 'json', body: INPUT_EXAMPLE },
		output: { type: 'json', example: OUTPUT_EXAMPLE },
	},
	schema: buildBazaarSchema({
		method: 'POST',
		bodyType: 'json',
		bodySchema: INPUT_SCHEMA,
		outputSchema: OUTPUT_SCHEMA,
	}),
};

// ── Endpoint ──────────────────────────────────────────────────────────────────

export default paidEndpoint({
	route: ROUTE,
	method: 'POST',
	priceAtomics: PRICE_ATOMICS,
	networks: ['base', 'solana'],
	description: DESCRIPTION,
	bazaar: BAZAAR,
	service: withService({
		serviceName: 'three.ws Pay-As-You-Learn Tutor',
		tags: ['tutor', 'education', 'llm', 'explain'],
	}),
	requiredScope: 'x402:bypass',
	accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),

	async handler({ req }) {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const rawBody = Buffer.concat(chunks).toString();

		let body;
		try {
			body = JSON.parse(rawBody);
		} catch {
			const err = new Error('Request body must be valid JSON');
			err.status = 400;
			err.code = 'invalid_json';
			throw err;
		}

		const question = String(body?.question || '').trim();
		if (question.length < 5) {
			const err = new Error('"question" must be at least 5 characters');
			err.status = 400;
			err.code = 'invalid_question';
			throw err;
		}
		if (question.length > 2000) {
			const err = new Error('"question" must be at most 2000 characters');
			err.status = 400;
			err.code = 'question_too_long';
			throw err;
		}

		const level = LEVEL_NAMES.includes(body?.level) ? body.level : 'intermediate';
		const context = typeof body?.context === 'string' ? body.context : '';
		const sessionId =
			typeof body?.sessionId === 'string' && body.sessionId.trim()
				? body.sessionId.trim().slice(0, 100)
				: randomUUID();

		// Generate the explanation on the platform's funded free providers
		// (Anthropic only when the operator supplies their own key).
		const taught = await teach({ question, context, level, anthropicKey: process.env.ANTHROPIC_API_KEY });

		// Record the flat per-response charge on the session tab.
		const session = await appendCharge(sessionId, {
			question,
			level,
			costAtomics: PRICE_ATOMICS,
			outputTokens: taught.outputTokens,
		});

		const attestation =
			'sha256:' +
			createHash('sha256')
				.update(
					JSON.stringify({
						sessionId,
						question,
						answer: taught.explanation,
						sessionTotal: session.totalAtomics,
					}),
				)
				.digest('hex');

		return {
			sessionId,
			answer: taught.explanation,
			keyPoints: taught.keyPoints,
			example: taught.example,
			followUp: taught.followUp,
			level: taught.level,
			model: taught.model,
			costThisCharge: String(PRICE_ATOMICS),
			costThisChargeUsd: atomicsToUsd(PRICE_ATOMICS),
			sessionTotal: String(session.totalAtomics),
			sessionTotalUsd: atomicsToUsd(session.totalAtomics),
			questionCount: session.entries.length,
			attestation,
		};
	},
});
