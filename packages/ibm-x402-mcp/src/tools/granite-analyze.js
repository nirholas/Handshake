// `ibm_granite_analyze` — paid MCP tool: structured document analysis via IBM Granite.
//
// Price: $0.04 USDC (exact, Solana). Applies IBM Granite to extract structured
// insights from any document: key entities, sentiment, risk flags, a summary,
// and actionable next steps — all in one call.

import { z } from 'zod';
import { paid, toolError } from '../payments.js';
import { jsonSchemaFromZod, generativeAnnotations } from './_shared.js';
import { WatsonxError } from '../watsonx.js';

const TOOL_NAME = 'ibm_granite_analyze';
const TOOL_DESCRIPTION =
	'Structured document analysis powered by IBM Granite: extract entities, sentiment, risk signals, ' +
	'a concise summary, and recommended next steps from any text (contracts, reports, emails, code reviews, etc.). ' +
	'Returns a machine-readable JSON analysis. ' +
	'No IBM Cloud account required — pay $0.04 USDC per call via x402.';

const ANALYSIS_TYPES = ['general', 'contract', 'financial', 'technical', 'medical', 'sentiment'];

const inputZodShape = {
	document: z
		.string()
		.min(1)
		.max(24_000)
		.describe('The document, report, email, or text to analyze.'),
	analysis_type: z
		.enum(['general', 'contract', 'financial', 'technical', 'medical', 'sentiment'])
		.default('general')
		.describe(
			'Analysis focus: general (universal), contract (legal terms, obligations), ' +
				'financial (metrics, risks, forecasts), technical (architecture, issues), ' +
				'medical (clinical entities, findings), or sentiment (tone, emotions).',
		),
	language: z
		.string()
		.optional()
		.describe('Document language hint (e.g. "Spanish", "French"). Defaults to auto-detect.'),
};

const inputJsonSchema = jsonSchemaFromZod(inputZodShape);

function buildAnalysisPrompt(analysis_type, language) {
	const langHint = language ? ` The document is written in ${language}.` : '';

	const typeInstructions = {
		general:
			'Identify key entities (people, organizations, places, dates), overall sentiment (positive/neutral/negative), ' +
			'main topics, critical risk flags, a 3-sentence summary, and 3 actionable next steps.',
		contract:
			'Extract: parties involved, effective date, termination clauses, obligations per party, ' +
			'penalty/liability clauses, renewal terms, risk flags (one-sided terms, missing protections), ' +
			'a 3-sentence summary, and 3 recommended legal review steps.',
		financial:
			'Extract: key financial metrics and figures, growth indicators, risk factors, market signals, ' +
			'forward-looking statements, red flags (inconsistencies, unusual items), ' +
			'a 3-sentence summary, and 3 investment/operational recommendations.',
		technical:
			'Extract: technologies mentioned, architecture patterns, identified issues or bugs, ' +
			'security concerns, performance risks, dependencies, ' +
			'a 3-sentence technical summary, and 3 engineering recommendations.',
		medical:
			'Extract: clinical entities (diagnoses, medications, procedures, lab values), ' +
			'findings and observations, risk factors, contraindications, ' +
			'a 3-sentence clinical summary, and 3 recommended follow-up actions.',
		sentiment:
			'Analyze: overall sentiment score (-1.0 to 1.0), emotion breakdown (joy, anger, fear, sadness, surprise, disgust), ' +
			'sentiment per paragraph or section, strongest positive and negative signals, ' +
			'a 3-sentence sentiment summary, and 3 communication recommendations.',
	};

	return (
		`You are an expert document analyst specializing in ${analysis_type} analysis.${langHint}\n\n` +
		`Analyze the provided document and return a JSON object with these exact keys:\n` +
		`- "summary": string (3 concise sentences)\n` +
		`- "entities": array of { name, type, relevance } objects\n` +
		`- "sentiment": { overall: string, score: number -1.0 to 1.0 }\n` +
		`- "key_findings": array of strings (top 5 findings)\n` +
		`- "risk_flags": array of { flag: string, severity: "low"|"medium"|"high" }\n` +
		`- "next_steps": array of strings (top 3 actionable recommendations)\n` +
		`- "analysis_type": "${analysis_type}"\n\n` +
		`${typeInstructions[analysis_type]}\n\n` +
		`Return ONLY valid JSON. No markdown code blocks, no prose outside the JSON.`
	);
}

export async function buildGraniteAnalyzeTool(client) {
	const handler = await paid(
		{
			toolName: TOOL_NAME,
			description: TOOL_DESCRIPTION,
			priceUsd: '$0.04',
			inputSchema: inputJsonSchema,
			example: {
				document:
					'This Services Agreement is entered into between Acme Corp and Vendor Inc effective January 1, 2026...',
				analysis_type: 'contract',
			},
			outputExample: {
				ok: true,
				analysis_type: 'contract',
				summary:
					'This agreement establishes a 12-month SaaS subscription between Acme Corp and Vendor Inc...',
				entities: [
					{ name: 'Acme Corp', type: 'organization', relevance: 'party' },
					{ name: 'Vendor Inc', type: 'organization', relevance: 'party' },
					{ name: 'January 1, 2026', type: 'date', relevance: 'effective_date' },
				],
				sentiment: { overall: 'neutral', score: 0.1 },
				key_findings: ['Auto-renewal clause on 60-day notice', 'Liability capped at 3 months fees'],
				risk_flags: [
					{ flag: 'One-sided IP assignment clause', severity: 'high' },
					{ flag: 'No SLA penalties defined', severity: 'medium' },
				],
				next_steps: [
					'Legal review of IP assignment clause section 8.2',
					'Negotiate SLA penalties and uptime guarantees',
					'Add data processing addendum for GDPR compliance',
				],
			},
		},
		async ({ document, analysis_type = 'general', language }) => {
			try {
				const systemPrompt = buildAnalysisPrompt(analysis_type, language);
				const result = await client.chat(
					[
						{ role: 'system', content: systemPrompt },
						{ role: 'user', content: document },
					],
					{ parameters: { max_new_tokens: 2048, temperature: 0.1 } },
				);

				let parsed;
				try {
					const raw = result.text.trim();
					// Strip any accidental markdown code fence
					const jsonStr = raw.startsWith('```')
						? raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
						: raw;
					parsed = JSON.parse(jsonStr);
					// A bare JSON scalar or array parses fine but is not an analysis
					// object, and spreading one below would splatter per-character or
					// per-index keys into the result. Treat it as unparseable.
					if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
						throw new Error('analysis JSON was not an object');
					}
				} catch {
					// Granite didn't return a clean JSON object: surface the text so the
					// client can decide what to do with it.
					return {
						ok: true,
						analysis_type,
						raw_response: result.text,
						usage: result.usage,
						model: result.model,
						parse_error: 'Model did not return a JSON analysis object; see raw_response.',
					};
				}

				return { ok: true, analysis_type, ...parsed, usage: result.usage, model: result.model };
			} catch (err) {
				if (err instanceof WatsonxError) {
					return toolError('watsonx_error', err.message, { status: err.status });
				}
				return toolError('internal_error', err.message);
			}
		},
	);

	return {
		name: TOOL_NAME,
		title: 'IBM Granite Analyze ($0.04)',
		description: TOOL_DESCRIPTION,
		annotations: generativeAnnotations,
		inputSchema: inputZodShape,
		handler,
	};
}
