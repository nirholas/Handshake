// Runtime — wires LLM + tool dispatch + speech + memory into a single agent brain.
// Replaces the pattern-matched chatbot stub in nich-agent.js.

import { createProvider } from './providers.js';
import { createTTS, createSTT } from './speech.js';
import { BUILTIN_TOOLS, BUILTIN_HANDLERS, STAGE_TOOLS } from './tools.js';
import { protocol } from '../agent-protocol.js';
import { PaymentRequiredError, alwaysAllow } from './skill-access.js';

export { PaymentRequiredError, alwaysAllow } from './skill-access.js';
export {
	fromAgentDetail as skillAccessFromAgentDetail,
	remoteCheck as skillAccessRemote,
	autoBuying as skillAccessAutoBuying,
} from './skill-access.js';

const MAX_TOOL_ITERATIONS = 8;

export class Runtime extends EventTarget {
	constructor({
		manifest,
		viewer,
		memory,
		skills,
		providerConfig = {},
		voiceConfig = {},
		stage = null,
		agentId = null,
		skillAccess = null,
	} = {}) {
		super();
		this.manifest = manifest || {};
		this.viewer = viewer;
		this.memory = memory;
		this.skills = skills;
		this.stage = stage;
		this.agentId = agentId;
		this.skillAccess = skillAccess || alwaysAllow();

		this.provider = createProvider({
			...this.manifest.brain,
			...providerConfig,
		});
		// agentId goes in first so an explicit manifest/voiceConfig value still wins,
		// but a runtime that knows which agent it is never has to be told twice: the
		// /api/tts/eleven proxy needs it to serve a voice cloned on the owner's own
		// ElevenLabs key, which is the only lane that works without a platform key.
		this.tts = createTTS({
			...(this.agentId ? { agentId: this.agentId } : {}),
			...this.manifest.voice?.tts,
			...voiceConfig.tts,
		});
		this.stt = createSTT({ ...this.manifest.voice?.stt, ...voiceConfig.stt });

		this.messages = [];
		this._busy = false;
	}

	get systemPrompt() {
		const parts = [];
		if (this.manifest.instructions) parts.push(this.manifest.instructions);
		if (this.memory) {
			parts.push(
				'\n\n<memory>\n' +
					this.memory.contextBlock({
						maxTokens: this.manifest.memory?.maxTokens || 8192,
					}) +
					'\n</memory>',
			);
		}
		if (this.skills) parts.push(this.skills.systemPrompt());
		return parts.join('');
	}

	get tools() {
		const builtinNames = new Set(this.manifest.tools || BUILTIN_TOOLS.map((t) => t.name));
		const builtins = BUILTIN_TOOLS.filter((t) => builtinNames.has(t.name));
		const skillTools = this.skills ? this.skills.allTools() : [];
		const stageTools = this.stage ? STAGE_TOOLS : [];
		return [...builtins, ...stageTools, ...skillTools];
	}

	/**
	 * Abort the current in-flight LLM request, if any.
	 * Resolves the pending `send()` call immediately.
	 */
	cancel() {
		this._abortController?.abort();
	}

	async send(userText, { voice = false } = {}) {
		if (this._busy) {
			throw new Error('Runtime busy — wait for current turn to finish');
		}
		this._busy = true;
		this._abortController = new AbortController();
		try {
			this.memory?.note('user_said', { text: userText });
			this.messages.push({ role: 'user', content: userText });
			this.dispatchEvent(
				new CustomEvent('brain:message', {
					detail: { role: 'user', content: userText },
				}),
			);

			const reply = await this._loop(this._abortController.signal);

			if (voice && reply.text && this.tts) {
				this.dispatchEvent(
					new CustomEvent('voice:speech-start', { detail: { text: reply.text } }),
				);
				await this.tts.speak(reply.text, { scene: this.viewer?.content });
				this.dispatchEvent(new CustomEvent('voice:speech-end', {}));
			}

			return reply;
		} finally {
			this._busy = false;
			this._abortController = null;
		}
	}

	async _loop(signal) {
		let iter = 0;
		let finalText = '';

		while (iter++ < MAX_TOOL_ITERATIONS) {
			this.dispatchEvent(new CustomEvent('brain:thinking', { detail: { thinking: true } }));
			const response = await this.provider.complete({
				system: this.systemPrompt,
				messages: this.messages,
				tools: this.tools,
				signal,
				onChunk: (chunk) => {
					if (signal?.aborted) return;
					this.dispatchEvent(new CustomEvent('brain:stream', { detail: { chunk } }));
				},
			});
			this.dispatchEvent(
				new CustomEvent('brain:thinking', {
					detail: { thinking: false, content: response.thinking || '' },
				}),
			);

			if (!response.toolCalls.length) {
				finalText = response.text;
				this.messages.push({ role: 'assistant', content: response.text });
				this.dispatchEvent(
					new CustomEvent('brain:message', {
						detail: { role: 'assistant', content: response.text },
					}),
				);
				break;
			}

			// Record assistant turn with tool calls
			this.messages.push(
				this.provider.formatAssistantWithToolCalls(response.text, response.toolCalls),
			);
			if (response.text) {
				this.dispatchEvent(
					new CustomEvent('brain:message', {
						detail: { role: 'assistant', content: response.text },
					}),
				);
			}

			// Dispatch each tool call
			const results = [];
			for (const call of response.toolCalls) {
				this.dispatchEvent(
					new CustomEvent('skill:tool-start', {
						detail: { tool: call.name, args: call.input },
					}),
				);
				let output,
					isError = false;
				try {
					output = await this._dispatchTool(call);
				} catch (err) {
					if (err instanceof PaymentRequiredError) {
						// Surface payment requirements as a structured event so the host
						// page can pop the purchase modal. Feed a 402-style result back
						// to the LLM so it can react gracefully (or, for autonomous
						// agents, trigger its own purchase via skillAccess.autoPay).
						this.dispatchEvent(
							new CustomEvent('skill:payment-required', { detail: err.payload }),
						);
						output = {
							error: 'payment_required',
							skill: err.payload.skill,
							price: err.payload.price,
							message:
								err.payload.message ||
								`Skill '${err.payload.skill}' requires a purchase before it can be used.`,
						};
					} else {
						output = { error: err.message || String(err) };
					}
					isError = true;
				}
				this.dispatchEvent(
					new CustomEvent('skill:tool-called', {
						detail: { tool: call.name, args: call.input, result: output },
					}),
				);
				results.push({ id: call.id, output, isError });
			}
			const hasImage = results.some((r) => r.output?.imageData);
			if (hasImage) {
				const content = results.map((r) => {
					const block = {
						type: 'tool_result',
						tool_use_id: r.id,
						is_error: !!r.isError,
					};
					if (r.output?.imageData) {
						const b64 = r.output.imageData.replace(/^data:[^;]+;base64,/, '');
						block.content = [
							{ type: 'text', text: r.output.description || 'Screen captured.' },
							{
								type: 'image',
								source: { type: 'base64', media_type: 'image/jpeg', data: b64 },
							},
						];
					} else {
						block.content =
							typeof r.output === 'string' ? r.output : JSON.stringify(r.output);
					}
					return block;
				});
				this.messages.push({ role: 'user', content });
			} else {
				this.messages.push(this.provider.formatToolResults(results));
			}
		}

		return { text: finalText };
	}

	async _dispatchTool(call) {
		const ctx = this._context();

		// Skill-provided tools first (they can shadow built-ins intentionally)
		const skill = this.skills?.findSkillForTool(call.name);
		if (skill) {
			// Paid-skill gate: ask the access checker before invoking. Built-in
			// and stage tools never go through the gate — only skill-provided ones.
			const access = await this.skillAccess(call.name);
			if (!access?.allowed) {
				throw new PaymentRequiredError({ skill: call.name, ...access });
			}
			return skill.invoke(call.name, call.input, ctx);
		}

		// Built-in
		const handler = BUILTIN_HANDLERS[call.name];
		if (!handler) throw new Error(`Unknown tool: ${call.name}`);
		return handler(call.input, ctx);
	}

	_context() {
		const skills = this.skills;
		return {
			viewer: this.viewer,
			memory: this.memory,
			llm: {
				complete: (prompt, opts) =>
					this.provider.complete({
						system: opts?.system || '',
						messages: [{ role: 'user', content: prompt }],
						tools: opts?.tools,
					}),
			},
			speak: async (text) => {
				if (!this.tts) return;
				this.dispatchEvent(new CustomEvent('voice:speech-start', { detail: { text } }));
				await this.tts.speak(text, { scene: this.viewer?.content });
				this.dispatchEvent(new CustomEvent('voice:speech-end', {}));
			},
			listen: (opts) => this.stt?.listen(opts),
			fetch: (url, opts) => fetch(url, opts),
			loadGLB: async (uri) => {
				// Delegates to viewer's loader. Actual wiring in element.js binds this.
				return this.viewer.loadGLB?.(uri);
			},
			loadClip: async (uri) => this.viewer.loadClip?.(uri),
			loadJSON: async (uri) => (await fetch(uri)).json(),
			call: async (toolName, args) => this._dispatchTool({ name: toolName, input: args }),
			stage: this.stage,
			agentId: this.agentId,
		};
	}

	async listen({ onInterim, onFinal } = {}) {
		if (!this.stt) throw new Error('STT not configured');
		this.dispatchEvent(new CustomEvent('voice:listen-start', {}));
		const text = await this.stt.listen({
			onInterim: (t) => {
				this.dispatchEvent(
					new CustomEvent('voice:transcript', { detail: { text: t, final: false } }),
				);
				onInterim?.(t);
			},
			onFinal: (t) => {
				this.dispatchEvent(
					new CustomEvent('voice:transcript', { detail: { text: t, final: true } }),
				);
				onFinal?.(t);
			},
		});
		return text;
	}

	clearConversation() {
		this.messages = [];
	}

	pause() {
		this.tts?.cancel(protocol);
		this.stt?.stop();
	}
	destroy() {
		this.pause();
		this.messages = [];
	}
}
