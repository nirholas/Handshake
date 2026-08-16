// `sentiment_pulse` — paid MCP tool that returns a real-time sentiment
// pulse for a Solana token by pulling the coin's recent pump.fun callouts
// (the community commentary the coin page renders) and scoring them with
// the three.ws lexicon scorer. Callers may attach additional texts (e.g. X
// posts they have collected) to fold into the overall score.
//
// Pricing: $0.003 USDC, settled `exact` in USDC on Solana mainnet.
//
// Implementation: calls POST /api/social/sentiment-pulse on the three.ws
// API surface. No keys are required: the endpoint reads the public
// pump.fun frontend-api-v3 callout route. When that source is down and the
// caller supplied no texts, the endpoint answers 502 and this tool reports
// the outage instead of a fabricated neutral reading.

import { z } from 'zod';

import { paid, toolError } from '../payments.js';
import { jsonSchemaFromZod } from './_shared.js';
import { resilientFetch } from '../lib/resilient-fetch.js';

const TOOL_NAME = 'sentiment_pulse';
const TOOL_DESCRIPTION =
	'Sentiment pulse for a Solana token: fetches the coin\'s most recent pump.fun callouts (the community commentary the coin page renders) via frontend-api-v3, optionally folds in caller-supplied snippets (e.g. recent X cashtag posts), and scores the combined stream with the three.ws deterministic lexicon. Returns overall + per-source breakdown with examples. Pairs naturally with pump_snapshot. Paid: $0.003 USDC.';

function env(k, def) {
	const v = process.env[k];
	return v && String(v).trim() ? String(v).trim() : def;
}

const SOLANA_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Single source of truth: Zod shape carries the base58 refinement + bounds +
// descriptions; JSON Schema derived. (The previous JSON Schema declared a
// `default: 100` on limit, which Zod cannot express as a JSON-Schema default
// while keeping the field optional — the handler already treats an absent
// limit as "use the endpoint default", so dropping the advertised default is
// the correct, drift-free outcome.)
const inputZodShape = {
	token: z
		.string()
		.min(32)
		.max(44)
		.refine((v) => SOLANA_MINT_RE.test(v), 'token must be a base58 Solana mint pubkey')
		.describe('Solana SPL or pump.fun mint pubkey (base58).'),
	limit: z.number().int().min(1).max(200).describe('Max pump.fun callouts to score.').optional(),
	extraTexts: z
		.array(z.string().max(2000))
		.max(200)
		.describe('Extra text snippets to include (e.g. X posts you have already collected).')
		.optional(),
};

const inputJsonSchema = jsonSchemaFromZod(inputZodShape);

export async function buildSentimentPulseTool() {
	const handler = await paid(
		{
			toolName: TOOL_NAME,
			description: TOOL_DESCRIPTION,
			scheme: 'exact',
			priceUsd: '$0.003',
			inputSchema: inputJsonSchema,
			example: { token: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump', limit: 100 },
			outputExample: {
				ok: true,
				token: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
				overall: { score: 0.42, posPct: 58, negPct: 16, neuPct: 26, count: 100 },
				breakdown: { pumpfun: { score: 0.4, count: 90 }, extra: { score: 0.5, count: 10 } },
			},
		},
		async ({ token, limit, extraTexts }) => {
			const endpoint = env(
				'MCP_SENTIMENT_PULSE_ENDPOINT',
				'https://three.ws/api/social/sentiment-pulse',
			);
			let res;
			try {
				// Read-only scoring computation — safe to retry on a transient blip.
				res = await resilientFetch(
					endpoint,
					{
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ token, limit, extraTexts }),
					},
					{
						timeoutMs: 15_000,
						retries: 2,
						retryNonIdempotent: true,
						label: 'sentiment-pulse',
					},
				);
			} catch (err) {
				return toolError('upstream_unreachable', err?.message || 'fetch failed');
			}
			const data = await res.json().catch(() => null);
			if (!res.ok || !data || data.ok === false) {
				return toolError(
					data?.code || data?.error || 'sentiment_failed',
					data?.message || `endpoint returned ${res.status}`,
				);
			}
			return data;
		},
	);
	return {
		name: TOOL_NAME,
		title: 'Sentiment pulse ($0.003)',
		description: TOOL_DESCRIPTION,
		inputSchema: inputZodShape,
		// Read-only live market feed — re-calls with the same args return
		// fresh data, so not idempotent.
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		handler,
	};
}
