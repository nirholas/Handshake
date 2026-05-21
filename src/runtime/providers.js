// LLM provider abstraction. Calls go through a proxy URL by default —
// never ship API keys in the browser. The server-side proxy at
// /api/llm/anthropic accepts an Anthropic-shape body and routes to
// Anthropic, Groq, or OpenRouter based on the model id — so this client
// keeps emitting Anthropic-shape requests for every supported model
// (paid Claude *and* free Llama/Hermes/GPT-OSS).

export class AnthropicProvider {
	constructor({
		// Free OpenRouter Llama 3.3 70B — no per-token cost to the host.
		// Owners can override with a paid Claude model via embed-policy.
		model = 'meta-llama/llama-3.3-70b-instruct:free',
		proxyURL,
		apiKey,
		agentId,
		apiOrigin,
		temperature = 0.7,
		maxTokens = 4096,
		thinking = 'auto',
	} = {}) {
		this.model = model;
		this.apiKey = apiKey;
		this.temperature = temperature;
		this.maxTokens = maxTokens;
		this.thinking = thinking;

		// Priority: explicit proxyURL > direct key > we-pay fallback.
		// Direct-key mode is only safe for Claude models (apiKey is then an
		// Anthropic key); free Groq/OR models always go through the proxy.
		if (proxyURL) {
			this.proxyURL = proxyURL;
		} else if (!apiKey && agentId && apiOrigin) {
			this.proxyURL = `${apiOrigin}/api/llm/anthropic?agent=${encodeURIComponent(agentId)}`;
		} else {
			this.proxyURL = null;
		}
	}

	/**
	 * Send a completion request to Anthropic.
	 * Streams the response via SSE and calls `onChunk` for each text delta.
	 * @param {{ system, messages, tools, onChunk?, signal? }} opts
	 * @returns {Promise<{ text, toolCalls, thinking, stopReason }>}
	 */
	async complete({ system, messages, tools, onChunk, signal }) {
		const body = {
			model: this.model,
			max_tokens: this.maxTokens,
			temperature: this.temperature,
			system,
			messages,
			stream: true,
		};
		if (tools && tools.length) body.tools = tools;
		if (this.thinking === 'always') {
			body.thinking = { type: 'enabled', budget_tokens: 2048 };
		}

		const url = this.proxyURL || 'https://api.anthropic.com/v1/messages';
		const headers = { 'content-type': 'application/json' };
		if (this.apiKey) {
			headers['x-api-key'] = this.apiKey;
			headers['anthropic-version'] = '2023-06-01';
			headers['anthropic-dangerous-direct-browser-access'] = 'true';
		}

		const res = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal,
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Anthropic ${res.status}: ${text}`);
		}

		const out = { text: '', toolCalls: [], thinking: '', stopReason: 'end_turn' };
		let currentToolCall = null;
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buf = '';

		signal?.addEventListener('abort', () => reader.cancel());

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (signal?.aborted) break;
				buf += decoder.decode(value, { stream: true });
				const lines = buf.split('\n');
				buf = lines.pop();
				for (const line of lines) {
					if (!line.startsWith('data: ')) continue;
					const payload = line.slice(6).trim();
					if (payload === '[DONE]') break;
					let evt;
					try {
						evt = JSON.parse(payload);
					} catch {
						continue;
					}
					if (evt.type === 'message_delta' && evt.delta?.stop_reason) {
						out.stopReason = evt.delta.stop_reason;
					} else if (evt.type === 'content_block_start') {
						const block = evt.content_block;
						if (block?.type === 'tool_use') {
							currentToolCall = { id: block.id, name: block.name, input: '' };
						}
					} else if (evt.type === 'content_block_delta') {
						const delta = evt.delta;
						if (delta?.type === 'text_delta') {
							out.text += delta.text;
							onChunk?.(delta.text);
						} else if (delta?.type === 'thinking_delta') {
							out.thinking += delta.thinking;
						} else if (delta?.type === 'input_json_delta' && currentToolCall) {
							currentToolCall.input += delta.partial_json;
						}
					} else if (evt.type === 'content_block_stop') {
						if (currentToolCall) {
							try {
								currentToolCall.input = JSON.parse(currentToolCall.input);
							} catch {
								currentToolCall.input = {};
							}
							out.toolCalls.push(currentToolCall);
							currentToolCall = null;
						}
					}
				}
			}
		} catch (err) {
			if (err.name === 'AbortError') return out;
			throw err;
		}

		return out;
	}

	_normalize(data) {
		// Convert Anthropic response shape into the runtime's common shape:
		// { text, toolCalls: [{ id, name, input }], stopReason }
		const out = { text: '', toolCalls: [], thinking: '', stopReason: data.stop_reason };
		for (const block of data.content || []) {
			if (block.type === 'text') out.text += block.text;
			else if (block.type === 'thinking') out.thinking += block.thinking || '';
			else if (block.type === 'tool_use') {
				out.toolCalls.push({ id: block.id, name: block.name, input: block.input });
			}
		}
		return out;
	}

	// Convert normalized tool results back into a user-role message
	formatToolResults(results) {
		return {
			role: 'user',
			content: results.map((r) => ({
				type: 'tool_result',
				tool_use_id: r.id,
				content: typeof r.output === 'string' ? r.output : JSON.stringify(r.output),
				is_error: !!r.isError,
			})),
		};
	}

	formatAssistantWithToolCalls(text, toolCalls) {
		const content = [];
		if (text) content.push({ type: 'text', text });
		for (const c of toolCalls) {
			content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
		}
		return { role: 'assistant', content };
	}
}

export class NullProvider {
	// Used when brain.provider === "none" — skills drive the agent.
	async complete() {
		return { text: '', toolCalls: [], stopReason: 'end_turn' };
	}
	formatToolResults() {
		return { role: 'user', content: [] };
	}
	formatAssistantWithToolCalls(text) {
		return { role: 'assistant', content: text || '' };
	}
}

export function createProvider(config = {}) {
	const provider = config.provider || 'anthropic';
	if (provider === 'anthropic') return new AnthropicProvider(config);
	if (provider === 'none') return new NullProvider();
	throw new Error(`Unsupported provider: ${provider}. Supported: anthropic, none`);
}
