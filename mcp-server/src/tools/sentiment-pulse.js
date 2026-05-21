// `sentiment_pulse` — paid MCP tool that returns a real-time sentiment
// pulse for a Solana token by pulling recent pump.fun comments and
// scoring them with the three.ws lexicon scorer. Callers may attach
// additional texts (e.g. X posts they have collected) to fold into the
// overall score.
//
// Pricing: $0.003 USDC, settled `exact` on Base or Solana.
//
// Implementation: calls POST /api/social/sentiment-pulse on the three.ws
// API surface. No keys are required — the endpoint relies on the public
// pump.fun frontend-api-v3 replies route.

import { z } from 'zod';

import { paid } from '../payments.js';

const TOOL_NAME = 'sentiment_pulse';
const TOOL_DESCRIPTION =
	'Sentiment pulse for a Solana token: fetches the most recent pump.fun comments via frontend-api-v3, optionally folds in caller-supplied snippets (e.g. recent X cashtag posts), and scores the combined stream with the three.ws deterministic lexicon. Returns overall + per-source breakdown with examples. Pairs naturally with pump_snapshot. Paid: $0.003 USDC.';

function env(k, def) {
	const v = process.env[k];
	return v && String(v).trim() ? String(v).trim() : def;
}

const SOLANA_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const inputJsonSchema = {
	type: 'object',
	properties: {
		token: {
			type: 'string',
			description: 'Solana SPL or pump.fun mint pubkey (base58).',
			minLength: 32,
			maxLength: 44,
		},
		limit: {
			type: 'integer',
			minimum: 1,
			maximum: 200,
			default: 100,
			description: 'Max pump.fun comments to score.',
		},
		extraTexts: {
			type: 'array',
			items: { type: 'string', maxLength: 2000 },
			maxItems: 200,
			description: 'Extra text snippets to include (e.g. X posts you have already collected).',
		},
	},
	required: ['token'],
	additionalProperties: false,
};

const inputZodShape = {
	token: z.string().refine((v) => SOLANA_MINT_RE.test(v), 'token must be a base58 Solana mint pubkey'),
	limit: z.number().int().min(1).max(200).optional(),
	extraTexts: z.array(z.string().max(2000)).max(200).optional(),
};

export async function buildSentimentPulseTool() {
	const handler = await paid(
		{
			toolName: TOOL_NAME,
			description: TOOL_DESCRIPTION,
			scheme: 'exact',
			priceUsd: '$0.003',
			inputSchema: inputJsonSchema,
			example: { token: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', limit: 100 },
			outputExample: {
				ok: true,
				token: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
				overall: { score: 0.42, posPct: 58, negPct: 16, neuPct: 26, count: 100 },
				breakdown: { pumpfun: { score: 0.4, count: 90 }, extra: { score: 0.5, count: 10 } },
			},
		},
		async ({ token, limit, extraTexts }) => {
			const endpoint = env('MCP_SENTIMENT_PULSE_ENDPOINT', 'https://three.ws/api/social/sentiment-pulse');
			let res;
			try {
				res = await fetch(endpoint, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ token, limit, extraTexts }),
				});
			} catch (err) {
				return { ok: false, error: 'upstream_unreachable', message: err?.message || 'fetch failed' };
			}
			const data = await res.json().catch(() => null);
			if (!res.ok || !data || data.ok === false) {
				return {
					ok: false,
					error: data?.code || data?.error || 'sentiment_failed',
					message: data?.message || `endpoint returned ${res.status}`,
				};
			}
			return data;
		},
	);
	return {
		name: TOOL_NAME,
		title: 'Sentiment pulse ($0.003)',
		description: TOOL_DESCRIPTION,
		inputSchema: inputZodShape,
		handler,
	};
}
