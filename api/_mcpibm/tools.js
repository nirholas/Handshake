// IBM Granite MCP tool implementations for the hosted Streamable HTTP server.
//
// These are the same five tools shipped by the @three-ws/ibm-x402-mcp npm
// package (stdio transport) — chat, code, embed, analyze, forecast — re-bound to
// the platform's proven server-side watsonx.ai clients (api/_lib/watsonx.js and
// api/_lib/watsonx-forecast.js). Prompts, input schemas, prices, and output
// shapes are kept identical to the package so the two transports behave the
// same; the package remains the canonical reference for tool semantics.
//
// The server operator supplies WATSONX_* credentials; end users pay USDC per
// call via x402 (gated in api/ibm-mcp.js) and never need an IBM Cloud account.

import { watsonxConfig, watsonxChatComplete, watsonxEmbed } from '../_lib/watsonx.js';
import { watsonxForecast } from '../_lib/watsonx-forecast.js';
import { formatUsdPrice } from './pricing.js';

function rpcError(code, message, data) {
	const e = new Error(message);
	e.code = code;
	e.data = data;
	return e;
}

// Resolve watsonx config or fail with a clear, secret-free message. The hosted
// endpoint is operator-funded: when credentials are absent the whole server is
// unusable, so we surface that plainly rather than letting an IAM call fail deep
// in a tool handler.
function graniteConfig() {
	const cfg = watsonxConfig();
	if (!cfg.configured) {
		throw new Error(
			'IBM watsonx.ai credentials are not configured on this server (set WATSONX_API_KEY and WATSONX_PROJECT_ID).',
		);
	}
	return cfg;
}

// Relaxed config for the TEXT-generation tools (chat / code / analyze). Those run
// on Granite via watsonxChatComplete(), which serves OpenRouter-hosted Granite
// (ibm-granite/*) when watsonx creds are absent — so they only need SOME Granite
// lane. The embed and forecast tools stay on the strict graniteConfig() above:
// Granite embeddings and TimeSeries forecasting have no OpenRouter equivalent.
function graniteChatConfig() {
	const cfg = watsonxConfig();
	if (cfg.configured) return cfg;
	const openrouterAvailable = Boolean(
		process.env.OPENROUTER_API_KEY?.trim() || (process.env.OPENROUTER_FALLBACK_KEYS || '').trim(),
	);
	if (openrouterAvailable) return cfg; // watsonxChatComplete falls over to OpenRouter Granite
	throw new Error(
		'IBM Granite is not configured on this server (set WATSONX_API_KEY and WATSONX_PROJECT_ID, or an OPENROUTER_API_KEY backstop).',
	);
}

// MCP tool annotations (2025-06-18 spec) — mirrors the constants shipped in
// packages/ibm-x402-mcp/src/tools/_shared.js so the hosted and stdio transports
// advertise identical semantics. Granite inference reads the operator's models
// without touching caller state (readOnlyHint true); generative tools can
// return different output for identical input, embeddings are deterministic
// for a given model. destructiveHint defaults to TRUE when omitted, so the
// hosted catalog sets it explicitly.
const generativeAnnotations = Object.freeze({
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
});

const deterministicAnnotations = Object.freeze({
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
});

// MCP tool result helper. structuredContent carries the full machine-readable
// object (the same shape the npm package returns); content[0].text is a concise
// human-readable view for clients that render text.
function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolResult(humanText, structured) {
	return {
		content: [{ type: 'text', text: humanText }],
		structuredContent: structured,
	};
}

// ──────────────────────── getting started (FREE) ────────────────────────────
//
// The one tool with no price. It is deliberately excluded from TOOL_PRICING so
// graniteX402Amount() returns null and api/ibm-mcp.js serves it without an x402
// payment or OAuth token — a public entry point any client (including non-x402
// hosts like watsonx Orchestrate) can call to discover the server before paying.
// Mirrors the npm package's ibm_granite_getting_started tool.

const GETTING_STARTED_DESCRIPTION =
	'FREE — start here. Returns an overview of this server: the IBM Granite tools available, ' +
	'their per-call USDC prices, how the x402 pay-per-call flow works, and runnable example calls. ' +
	'No payment or account required. Call this first to orient before invoking a paid tool.';

// Prices come from pricing.js (the same map the 402 challenge and the settle
// path read) so this free orientation payload can never quote a number the
// caller is not actually charged.
const GS_TOOLS = [
	{ name: 'ibm_granite_chat', summary: 'Conversational AI via IBM Granite 3 8B Instruct.' },
	{ name: 'ibm_granite_code', summary: 'Code generate / review / refactor / explain / test / document.' },
	{ name: 'ibm_granite_embed', summary: 'Batch multilingual text embeddings for RAG and search.' },
	{ name: 'ibm_granite_analyze', summary: 'Structured document analysis: entities, sentiment, risk, summary, next steps.' },
	{ name: 'ibm_granite_forecast', summary: 'Zero-shot time-series forecasting via IBM Granite TTM.' },
].map(({ name, summary }) => ({ name, price: formatUsdPrice(name), summary }));

const GS_PAYMENT_FLOW = [
	'Call any ibm_granite_* tool. With no payment, the server returns an x402 PaymentRequired envelope quoting the exact USDC price and a pay-to address (Base or Solana).',
	'Your x402 client signs a USDC transfer for that amount and retries with the payment attached.',
	'The server verifies + settles the payment, runs the IBM watsonx.ai inference, and returns the result with a settlement receipt. x402-capable clients do this automatically.',
	'Authenticated three.ws principals (Bearer/OAuth) call the paid tools without per-call payment — the operator-funded path for watsonx Orchestrate connections.',
];

const GS_LINKS = {
	homepage: 'https://three.ws',
	npm: 'https://www.npmjs.com/package/@three-ws/ibm-x402-mcp',
	source: 'https://github.com/nirholas/three.ws/tree/main/packages/ibm-x402-mcp',
	support: 'https://three.ws/support',
	x402: 'https://x402.org',
};

function gettingStartedPayload(section) {
	const full = {
		ok: true,
		server: 'ibm-x402-mcp',
		version: '1.0.0',
		transport: 'streamable-http',
		overview:
			'x402 pay-per-use IBM Granite AI over MCP. Five inference tools, each settled in USDC on ' +
			'Base or Solana via the x402 protocol — no IBM Cloud account required for callers. This tool ' +
			'is free; every other tool quotes its price below.',
		tools: GS_TOOLS,
		pricing: GS_TOOLS.map((t) => `${t.name}: ${t.price}/call`),
		payment_flow: GS_PAYMENT_FLOW,
		links: GS_LINKS,
		next_step:
			'Pick a tool, send its arguments, and your x402 client handles the USDC payment automatically. ' +
			'Or authenticate with a three.ws Bearer token for the operator-funded path.',
	};
	if (section === 'pricing') return { ok: true, pricing: full.pricing, tools: GS_TOOLS };
	if (section === 'payment') return { ok: true, payment_flow: GS_PAYMENT_FLOW };
	if (section === 'tools') return { ok: true, tools: GS_TOOLS };
	if (section === 'links') return { ok: true, links: GS_LINKS };
	return full;
}

function gettingStartedText(p) {
	if (!p.overview) return JSON.stringify(p, null, 2);
	return [
		'# IBM Granite x402 MCP — Getting Started',
		'',
		p.overview,
		'',
		'## Tools (this getting_started tool is free; the rest are pay-per-call)',
		...p.tools.map((t) => `- ${t.name} — ${t.price}/call — ${t.summary}`),
		'',
		'## How payment works (x402)',
		...p.payment_flow.map((s, i) => `${i + 1}. ${s}`),
		'',
		'## Links',
		...Object.entries(p.links).map(([k, v]) => `- ${k}: ${v}`),
		'',
		`Next: ${p.next_step}`,
	].join('\n');
}

const gettingStartedTool = {
	name: 'ibm_granite_getting_started',
	title: 'Getting Started (free)',
	description: GETTING_STARTED_DESCRIPTION,
	// Static, local overview — same annotations the npm package ships.
	annotations: Object.freeze({
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	}),
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			section: {
				type: 'string',
				enum: ['overview', 'pricing', 'payment', 'tools', 'links'],
				default: 'overview',
				description:
					'Which part to return. Defaults to "overview" (everything). Use "pricing", "payment", "tools", or "links" to focus.',
			},
		},
	},
	example: { section: 'overview' },
	async handler({ section = 'overview' } = {}) {
		const payload = gettingStartedPayload(section);
		return toolResult(gettingStartedText(payload), payload);
	},
};

// ───────────────────────────────── chat ─────────────────────────────────────

const CHAT_DESCRIPTION =
	'Chat completion powered by IBM Granite foundation models (default: ibm/granite-3-8b-instruct). ' +
	'Send a conversation as role/content message pairs and receive the assistant reply with token usage. ' +
	'No IBM Cloud account required — pay $0.02 USDC per call via x402.';

const chatTool = {
	name: 'ibm_granite_chat',
	title: 'IBM Granite Chat ($0.02)',
	description: CHAT_DESCRIPTION,
	annotations: generativeAnnotations,
	inputSchema: {
		type: 'object',
		properties: {
			messages: {
				type: 'array',
				minItems: 1,
				maxItems: 50,
				description: 'Conversation history. Must include at least one user message.',
				items: {
					type: 'object',
					properties: {
						role: {
							type: 'string',
							enum: ['system', 'user', 'assistant'],
							description: 'Message role.',
						},
						content: {
							type: 'string',
							minLength: 1,
							maxLength: 32_000,
							description: 'Message text.',
						},
					},
					required: ['role', 'content'],
					additionalProperties: false,
				},
			},
			model: {
				type: 'string',
				description:
					'Override the Granite model id (e.g. ibm/granite-3-2b-instruct). Defaults to ibm/granite-3-8b-instruct.',
			},
			max_new_tokens: {
				type: 'integer',
				minimum: 1,
				maximum: 4096,
				description: 'Maximum tokens to generate. Defaults to 1024.',
			},
			temperature: {
				type: 'number',
				minimum: 0,
				maximum: 2,
				description: 'Sampling temperature (0 = deterministic). Defaults to 0.7.',
			},
		},
		required: ['messages'],
		additionalProperties: false,
	},
	example: {
		messages: [{ role: 'user', content: 'Explain quantum entanglement in two sentences.' }],
	},
	output: {
		example: {
			ok: true,
			text: 'Quantum entanglement is a phenomenon where two particles...',
			finishReason: 'stop',
			usage: { prompt_tokens: 14, completion_tokens: 38 },
			model: 'ibm/granite-3-8b-instruct',
		},
	},
	async handler({ messages, model, max_new_tokens, temperature }) {
		const cfg = graniteChatConfig();
		const result = await watsonxChatComplete(cfg, {
			messages,
			model,
			maxTokens: max_new_tokens ?? 1024,
			temperature: temperature ?? 0.7,
		});
		return toolResult(result.text, { ok: true, ...result });
	},
};

// ───────────────────────────────── code ─────────────────────────────────────

const CODE_DESCRIPTION =
	'Code generation, review, refactoring, and explanation via IBM Granite instruct models. ' +
	'Provide a task type and code/prompt; receive the generated or reviewed code with explanation. ' +
	'No IBM Cloud account required — pay $0.025 USDC per call via x402.';

const TASK_DESCRIPTIONS = {
	generate: 'Generate new code from the prompt description.',
	review: 'Review the provided code for bugs, security issues, and improvements.',
	refactor: 'Refactor the code for clarity, performance, and best practices.',
	explain: 'Explain what the code does in plain language.',
	test: 'Generate unit tests for the provided code.',
	document: 'Add inline documentation and docstrings to the code.',
};

function buildCodeSystemPrompt(task, language) {
	const lang = language ? ` in ${language}` : '';
	const base = `You are an expert software engineer${lang}. ${TASK_DESCRIPTIONS[task]}`;
	const format =
		task === 'review'
			? ' Structure your response as: FINDINGS (bulleted issues with severity), then RECOMMENDATIONS.'
			: task === 'explain'
				? ' Be concise and clear. Use plain language suitable for a code review.'
				: ' Return only the code block, then a brief explanation of key decisions.';
	return base + format;
}

const codeTool = {
	name: 'ibm_granite_code',
	title: 'IBM Granite Code ($0.025)',
	description: CODE_DESCRIPTION,
	annotations: generativeAnnotations,
	inputSchema: {
		type: 'object',
		properties: {
			task: {
				type: 'string',
				enum: ['generate', 'review', 'refactor', 'explain', 'test', 'document'],
				description:
					'Code task: generate (new code from description), review (bugs/security), refactor (quality), explain (plain language), test (unit tests), or document (add docstrings).',
			},
			prompt: {
				type: 'string',
				minLength: 1,
				maxLength: 16_000,
				description:
					'For "generate": describe what to build. For all others: paste the code to process.',
			},
			language: {
				type: 'string',
				description:
					'Target programming language (e.g. "TypeScript", "Python", "Rust"). Optional for explain/review.',
			},
			context: {
				type: 'string',
				maxLength: 4_000,
				description:
					'Additional context: architecture notes, constraints, or example usage.',
			},
		},
		required: ['task', 'prompt'],
		additionalProperties: false,
	},
	example: {
		task: 'generate',
		prompt: 'A debounce function with TypeScript generics and a cancel method.',
		language: 'TypeScript',
	},
	output: {
		example: {
			ok: true,
			task: 'generate',
			text: 'function debounce<T extends (...args: unknown[]) => void>(fn: T, delay: number) { ... }',
			model: 'ibm/granite-3-8b-instruct',
		},
	},
	async handler({ task, prompt, language, context }) {
		const cfg = graniteChatConfig();
		const systemContent = buildCodeSystemPrompt(task, language);
		const userContent = context ? `${prompt}\n\nContext: ${context}` : prompt;
		const result = await watsonxChatComplete(cfg, {
			messages: [
				{ role: 'system', content: systemContent },
				{ role: 'user', content: userContent },
			],
			maxTokens: 2048,
			temperature: task === 'generate' ? 0.3 : 0.1,
		});
		return toolResult(result.text, { ok: true, task, ...result });
	},
};

// ──────────────────────────────── embed ─────────────────────────────────────

const EMBED_DESCRIPTION =
	'Generate embedding vectors for one or more texts using IBM Granite ' +
	'(default: ibm/granite-embedding-278m-multilingual). Returns one float array per input, ' +
	'suitable for semantic search, RAG retrieval, and similarity scoring. ' +
	'Up to 64 texts per call. No IBM Cloud account required — pay $0.005 USDC per call via x402.';

const embedTool = {
	name: 'ibm_granite_embed',
	title: 'IBM Granite Embed ($0.005)',
	description: EMBED_DESCRIPTION,
	annotations: deterministicAnnotations,
	inputSchema: {
		type: 'object',
		properties: {
			inputs: {
				type: 'array',
				minItems: 1,
				maxItems: 64,
				items: { type: 'string', minLength: 1, maxLength: 8_000 },
				description: 'Texts to embed. 1–64 strings per call, up to 8,000 characters each.',
			},
			model: {
				type: 'string',
				description:
					'Override the embedding model id (e.g. ibm/granite-embedding-125m-english). Defaults to ibm/granite-embedding-278m-multilingual.',
			},
		},
		required: ['inputs'],
		additionalProperties: false,
	},
	example: { inputs: ['enterprise AI platform', 'cloud-native machine learning'] },
	output: {
		example: {
			ok: true,
			model: 'ibm/granite-embedding-278m-multilingual',
			inputCount: 2,
			dimensions: 768,
			vectors: [
				[0.012, -0.034, 0.091],
				[0.008, -0.027, 0.088],
			],
		},
	},
	async handler({ inputs, model }) {
		const cfg = graniteConfig();
		const result = await watsonxEmbed(cfg, { inputs, model });
		const summary = `Embedded ${result.inputCount} input${result.inputCount === 1 ? '' : 's'} → ${result.inputCount}×${result.dimensions} vectors (${result.model}).`;
		return toolResult(summary, { ok: true, ...result });
	},
};

// ─────────────────────────────── analyze ────────────────────────────────────

const ANALYZE_DESCRIPTION =
	'Structured document analysis powered by IBM Granite: extract entities, sentiment, risk signals, ' +
	'a concise summary, and recommended next steps from any text (contracts, reports, emails, code reviews, etc.). ' +
	'Returns a machine-readable JSON analysis. ' +
	'No IBM Cloud account required — pay $0.04 USDC per call via x402.';

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

const analyzeTool = {
	name: 'ibm_granite_analyze',
	title: 'IBM Granite Analyze ($0.04)',
	description: ANALYZE_DESCRIPTION,
	annotations: generativeAnnotations,
	inputSchema: {
		type: 'object',
		properties: {
			document: {
				type: 'string',
				minLength: 1,
				maxLength: 24_000,
				description: 'The document, report, email, or text to analyze.',
			},
			analysis_type: {
				type: 'string',
				enum: ['general', 'contract', 'financial', 'technical', 'medical', 'sentiment'],
				default: 'general',
				description:
					'Analysis focus: general (universal), contract (legal terms, obligations), ' +
					'financial (metrics, risks, forecasts), technical (architecture, issues), ' +
					'medical (clinical entities, findings), or sentiment (tone, emotions).',
			},
			language: {
				type: 'string',
				description:
					'Document language hint (e.g. "Spanish", "French"). Defaults to auto-detect.',
			},
		},
		required: ['document'],
		additionalProperties: false,
	},
	example: {
		document:
			'This Services Agreement is entered into between Acme Corp and Vendor Inc effective January 1, 2026...',
		analysis_type: 'contract',
	},
	output: {
		example: {
			ok: true,
			analysis_type: 'contract',
			summary:
				'This agreement establishes a 12-month SaaS subscription between Acme Corp and Vendor Inc...',
			entities: [{ name: 'Acme Corp', type: 'organization', relevance: 'party' }],
			sentiment: { overall: 'neutral', score: 0.1 },
			key_findings: ['Auto-renewal clause on 60-day notice'],
			risk_flags: [{ flag: 'One-sided IP assignment clause', severity: 'high' }],
			next_steps: ['Legal review of IP assignment clause section 8.2'],
			model: 'ibm/granite-3-8b-instruct',
		},
	},
	async handler({ document, analysis_type = 'general', language }) {
		const cfg = graniteChatConfig();
		const systemPrompt = buildAnalysisPrompt(analysis_type, language);
		const result = await watsonxChatComplete(cfg, {
			messages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: document },
			],
			maxTokens: 2048,
			temperature: 0.1,
		});

		let parsed;
		try {
			const raw = result.text.trim();
			// Strip any accidental markdown code fence.
			const jsonStr = raw.startsWith('```')
				? raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
				: raw;
			parsed = JSON.parse(jsonStr);
			// A bare JSON scalar or array parses fine but is not an analysis object,
			// and spreading one below would splatter per-character/per-index keys
			// into the result. Treat it as an unparseable response.
			if (!isPlainObject(parsed)) throw new Error('analysis JSON was not an object');
		} catch {
			// Granite didn't return clean JSON: surface text so the client can decide.
			const fallback = {
				ok: true,
				analysis_type,
				raw_response: result.text,
				usage: result.usage,
				model: result.model,
				parse_error:
					'Model did not return a JSON analysis object; see raw_response.',
			};
			return toolResult(result.text, fallback);
		}

		const structured = {
			ok: true,
			analysis_type,
			...parsed,
			usage: result.usage,
			model: result.model,
		};
		return toolResult(JSON.stringify(structured, null, 2), structured);
	},
};

// ─────────────────────────────── forecast ───────────────────────────────────

const FORECAST_DESCRIPTION =
	'Zero-shot time-series forecasting via IBM Granite TTM (Tiny Time Mixer). ' +
	'Provide a numeric series with ISO-8601 timestamps and a cadence, receive the forecast horizon. ' +
	'No training required. Suitable for revenue, traffic, sensor, energy, and financial series. ' +
	'No IBM Cloud account required — pay $0.05 USDC per call via x402.';

const FREQ_EXAMPLES = '1min, 5min, 15min, 30min, 1h, 2h, 4h, 12h, 1D, 1W, 1ME';

const forecastTool = {
	name: 'ibm_granite_forecast',
	title: 'IBM Granite Forecast ($0.05)',
	description: FORECAST_DESCRIPTION,
	annotations: generativeAnnotations,
	inputSchema: {
		type: 'object',
		properties: {
			timestamps: {
				type: 'array',
				minItems: 64,
				maxItems: 1024,
				items: { type: 'string', minLength: 1 },
				description:
					'ISO-8601 timestamps at a uniform cadence, oldest to newest (e.g. ["2025-01-01T00:00:00Z", ...]).',
			},
			values: {
				type: 'array',
				minItems: 64,
				maxItems: 1024,
				items: { type: 'number' },
				description:
					'Numeric series aligned to timestamps, oldest to newest. Must be the same length as timestamps.',
			},
			freq: {
				type: 'string',
				minLength: 1,
				description: `Cadence of the series as a pandas-style frequency string. Examples: ${FREQ_EXAMPLES}.`,
			},
			prediction_length: {
				type: 'integer',
				minimum: 1,
				maximum: 96,
				description:
					'Number of steps to forecast ahead. Defaults to the model horizon (typically 96 for 1h data).',
			},
			label: {
				type: 'string',
				maxLength: 64,
				description:
					'Human label for the series (e.g. "daily_revenue_usd"). Returned in output for traceability.',
			},
		},
		required: ['timestamps', 'values', 'freq'],
		additionalProperties: false,
	},
	example: {
		timestamps: ['2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z'],
		values: [1200, 1350],
		freq: '1D',
		prediction_length: 7,
		label: 'daily_revenue_usd',
	},
	output: {
		example: {
			ok: true,
			label: 'daily_revenue_usd',
			model: 'ibm/granite-ttm-512-96-r2',
			inputWindow: 512,
			forecastSteps: 7,
			forecast: [{ timestamp: '2025-06-07T00:00:00Z', value: 1420 }],
		},
	},
	async handler({ timestamps, values, freq, prediction_length, label }) {
		if (timestamps.length !== values.length) {
			throw rpcError(
				-32602,
				`timestamps and values must have equal length (got ${timestamps.length} timestamps, ${values.length} values).`,
			);
		}
		const cfg = graniteConfig();
		const result = await watsonxForecast(cfg, {
			timestamps,
			values,
			freq,
			predictionLength: prediction_length,
		});

		const forecast = result.timestamps.map((ts, i) => ({
			timestamp: ts,
			value: result.values[i] ?? null,
		}));

		const structured = {
			ok: true,
			...(label ? { label } : {}),
			model: result.model,
			inputWindow: result.inputWindow,
			forecastSteps: forecast.length,
			forecast,
		};
		const summary = `Forecast ${forecast.length} step${forecast.length === 1 ? '' : 's'} ahead from ${result.inputWindow} points (${result.model}).`;
		return toolResult(summary, structured);
	},
};

export const toolDefs = [
	gettingStartedTool,
	chatTool,
	codeTool,
	embedTool,
	analyzeTool,
	forecastTool,
];
