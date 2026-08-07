// POST /api/agent/run - the general server-side agent loop.
//
// Speaks the OpenAI chat-completions wire format both ways: the request body
// is `{ messages, stream }` exactly as a chat client would send to any
// OpenAI-compatible provider, and the response is either a standard
// chat.completion JSON or an SSE stream of chat.completion.chunk deltas. That
// makes the loop a drop-in "model" for the chat client's Built-in lane
// (model id `three-ws/agent`), with zero client-side protocol work.
//
// Inside one request, @three-ws/agent-runtime's AgentRuntime drives the loop:
// call the LLM over the shared tool-calling chain (api/_lib/llm-tool-chain.js,
// free lanes first, Vertex credits anchor last), execute any requested tools
// server-side from the READ-ONLY registry (api/_lib/agent-tools.js: web
// search, token prices, trending, SOL balances, the trade-firewall safety
// verdict, smart money, SNS), feed results back, repeat, then stream the
// final answer. Every planned tool call is preflighted through the GuardChain
// in headless mode first; a blacklisted call is returned to the model as a
// blocked-tool error, never executed. No tool here can sign, send, or mutate;
// fund-moving tools live client-side behind the wallet modal and
// /api/agent/guard.
//
// Tool activity is surfaced as SSE comment lines (`: tool web_search …`),
// which every OpenAI SSE parser ignores by spec, so observability rides along
// without breaking any client.

import { cors, error, json, method, rateLimited, readJson, wrap } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { providerChain, streamRound } from '../_lib/llm-tool-chain.js';
import { agentToolSchemas, agentToolHandlers } from '../_lib/agent-tools.js';
import { AgentRuntime, GuardChain, TradeGuard } from '@three-ws/agent-runtime';

export const AGENT_MODEL_ID = 'three-ws/agent';

const MAX_TOOL_ROUNDS = 4;
const MAX_MESSAGES = 40;
const MAX_BODY_BYTES = 512_000;

const guardChain = new GuardChain({ defiGuard: new TradeGuard() });

const SYSTEM_NOTE = [
	'You have server-side tools: live token prices and trends, web search, Solana balances, a rug/honeypot safety verdict, smart-money activity, and .sol name resolution.',
	'Use them instead of guessing; never invent prices, balances, or safety verdicts. If a tool returns no data, say so plainly.',
	'You cannot move funds: no tool here transfers, swaps, or signs anything.',
].join(' ');

function sanitizeMessages(raw) {
	if (!Array.isArray(raw)) return null;
	const out = [];
	for (const m of raw.slice(-MAX_MESSAGES)) {
		if (!m || typeof m !== 'object') continue;
		const role = ['system', 'user', 'assistant'].includes(m.role) ? m.role : null;
		if (!role) continue;
		const content =
			typeof m.content === 'string'
				? m.content
				: Array.isArray(m.content)
					? m.content
							.map((p) => (typeof p?.text === 'string' ? p.text : ''))
							.join('\n')
							.trim()
					: '';
		out.push({ role, content });
	}
	return out.length ? out : null;
}

/** OpenAI chat.completion.chunk SSE frame. */
function chunkFrame(id, delta, finishReason = null) {
	return `data: ${JSON.stringify({
		id,
		object: 'chat.completion.chunk',
		created: Math.floor(Date.now() / 1000),
		model: AGENT_MODEL_ID,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	})}\n\n`;
}

/**
 * Run one full agent completion over `body.messages` and answer in OpenAI
 * format (SSE when body.stream, JSON otherwise). Shared by POST /api/agent/run
 * and the chat proxy's `three-ws/agent` model branch; `opts.rateLimited` skips
 * the limiter when the caller already applied its own.
 */
export async function runAgentCompletion(req, res, body, opts = {}) {
	if (!opts.rateLimited) {
		const rl = await limits.agentRunIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl);
	}

	const chain = providerChain();
	if (!chain.length) {
		return error(res, 503, 'llm_unavailable', 'No LLM provider is configured for the agent loop.');
	}

	const messages = sanitizeMessages(body?.messages);
	if (!messages) return error(res, 400, 'bad_messages', 'Provide `messages: [{ role, content }]`.');

	// The server note rides as a second system message so a client-authored
	// persona keeps the first slot.
	const sysIdx = messages[0]?.role === 'system' ? 1 : 0;
	messages.splice(sysIdx, 0, { role: 'system', content: SYSTEM_NOTE });

	const stream = body?.stream !== false;
	const completionId = `agentrun-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

	let sseOpen = false;
	const sse = (text) => {
		if (!sseOpen) {
			res.statusCode = 200;
			res.setHeader('content-type', 'text/event-stream; charset=utf-8');
			res.setHeader('cache-control', 'no-store');
			res.setHeader('x-accel-buffering', 'no');
			res.write(chunkFrame(completionId, { role: 'assistant' }));
			sseOpen = true;
		}
		res.write(text);
	};

	const toolSchemas = agentToolSchemas();
	const toolHandlers = agentToolHandlers();
	let streamedAny = false;
	let finalContent = '';

	// The model runtime the loop's built-in call_llm executor consumes: one
	// round over the provider chain, failing over BEFORE any byte streams and
	// aborting (not retrying) after a mid-stream death so the client never sees
	// the same sentence twice.
	async function* modelRuntime(payload) {
		let lastErr = null;
		for (const provider of chain) {
			let emittedHere = false;
			try {
				const out = await streamRound(provider, {
					messages: payload.messages,
					tools: toolSchemas,
					onContent: (delta) => {
						emittedHere = true;
						streamedAny = true;
						if (stream) sse(chunkFrame(completionId, { content: delta }));
					},
				});
				yield {
					content: out.content,
					tool_calls: out.toolCalls.map((tc) => ({
						id: tc.id,
						type: 'function',
						function: { name: tc.name, arguments: tc.args || '{}' },
					})),
				};
				return;
			} catch (err) {
				lastErr = err;
				if (emittedHere) throw err;
			}
		}
		throw lastErr || new Error('No LLM provider available');
	}

	// The "brain": plan from the phase the runtime reports. Tool rounds are
	// bounded; past the budget the model is asked to answer with what it has.
	const runner = async (context, state) => {
		switch (context.phase) {
			case 'init':
			case 'user_input':
				return { type: 'call_llm', payload: { messages: state.messages } };

			case 'llm_result': {
				const { result, toolCalls } = context.payload || {};
				const content = result?.content || '';
				const roundsUsed = state.messages.filter((m) => m.role === 'assistant' && m.tool_calls).length;

				if (Array.isArray(toolCalls) && toolCalls.length > 0 && roundsUsed < MAX_TOOL_ROUNDS) {
					state.messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });

					const allowed = [];
					for (const tc of toolCalls) {
						const name = tc.function?.name || '';
						let args = {};
						try {
							args = JSON.parse(tc.function?.arguments || '{}');
						} catch {
							args = {};
						}
						if (!toolHandlers[name]) {
							state.messages.push({
								role: 'tool',
								tool_call_id: tc.id,
								content: JSON.stringify({ error: `Unknown tool: ${name}` }),
							});
							continue;
						}
						const verdict = await guardChain.evaluate({
							identifier: name,
							apiName: name,
							arguments: args,
							approvalMode: 'headless',
						});
						if (verdict.decision === 'block') {
							state.messages.push({
								role: 'tool',
								tool_call_id: tc.id,
								content: JSON.stringify({ blocked: true, error: verdict.reason }),
							});
							continue;
						}
						if (stream) sse(`: tool ${name}\n\n`);
						allowed.push(tc);
					}

					if (allowed.length > 0) return { type: 'call_tools_batch', payload: allowed };
					// Everything was blocked or unknown: let the model read the errors.
					return { type: 'call_llm', payload: { messages: state.messages } };
				}

				finalContent = content;
				state.messages.push({ role: 'assistant', content });
				return { type: 'finish', reason: 'completed' };
			}

			case 'tool_result':
			case 'tools_batch_result':
				return { type: 'call_llm', payload: { messages: state.messages } };

			case 'error':
				return { type: 'finish', reason: 'error_recovery' };

			default:
				return { type: 'finish', reason: 'agent_decision' };
		}
	};

	const agent = { runner, modelRuntime, tools: toolHandlers };
	const runtime = new AgentRuntime(agent);
	let state = AgentRuntime.createInitialState({
		operationId: completionId,
		maxSteps: MAX_TOOL_ROUNDS * 2 + 3,
	});
	state.messages = messages;

	let context;
	try {
		while (state.status !== 'done' && state.status !== 'error') {
			const step = await runtime.step(state, context);
			state = step.newState;
			context = step.nextContext;
			if (!context && state.status !== 'done' && state.status !== 'error') break;
		}
	} catch (err) {
		if (sseOpen) {
			sse(`: error ${String(err?.message || err).slice(0, 200)}\n\n`);
			sse(chunkFrame(completionId, {}, 'stop'));
			sse('data: [DONE]\n\n');
			return res.end();
		}
		return error(res, 502, 'agent_loop_failed', String(err?.message || err).slice(0, 300));
	}

	if (state.status === 'error') {
		const detail = String(state.error?.message || state.error || 'agent loop error').slice(0, 300);
		if (sseOpen) {
			sse(`: error ${detail}\n\n`);
			sse(chunkFrame(completionId, {}, 'stop'));
			sse('data: [DONE]\n\n');
			return res.end();
		}
		return error(res, 502, 'agent_loop_failed', detail);
	}

	if (stream) {
		// A run whose final round emitted no deltas (e.g. everything came from a
		// non-streaming provider quirk) still owes the client the content.
		if (!streamedAny && finalContent) sse(chunkFrame(completionId, { content: finalContent }));
		sse(chunkFrame(completionId, {}, 'stop'));
		sse('data: [DONE]\n\n');
		return res.end();
	}

	return json(res, 200, {
		id: completionId,
		object: 'chat.completion',
		created: Math.floor(Date.now() / 1000),
		model: AGENT_MODEL_ID,
		choices: [
			{ index: 0, message: { role: 'assistant', content: finalContent }, finish_reason: 'stop' },
		],
	});
}

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'POST, OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	let body;
	try {
		body = await readJson(req, MAX_BODY_BYTES);
	} catch (err) {
		return error(res, err?.status || 400, 'bad_json', err?.message || 'Body must be JSON.');
	}

	return runAgentCompletion(req, res, body);
});
