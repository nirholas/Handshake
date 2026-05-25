/**
 * @3d-agent/sdk — minimal chat + embed SDK for the three.ws agent fabric.
 *
 * Defaults point at https://three.ws. Override via the `baseUrl` option on
 * the constructor (or via the `THREE_WS_BASE_URL` env var for Node consumers).
 */

export interface AgentOptions {
	/** API base URL. Defaults to https://three.ws or the THREE_WS_BASE_URL env. */
	baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://three.ws';

function resolveBaseUrl(opts?: AgentOptions): string {
	if (opts?.baseUrl) return stripTrailingSlash(opts.baseUrl);
	if (typeof process !== 'undefined' && process.env?.THREE_WS_BASE_URL) {
		return stripTrailingSlash(process.env.THREE_WS_BASE_URL);
	}
	return DEFAULT_BASE_URL;
}

function stripTrailingSlash(s: string): string {
	return s.endsWith('/') ? s.slice(0, -1) : s;
}

export class Agent {
	private apiKey: string;
	private agentId: string;
	private baseUrl: string;

	constructor(apiKey: string, agentId: string, options?: AgentOptions) {
		this.apiKey = apiKey;
		this.agentId = agentId;
		this.baseUrl = resolveBaseUrl(options);
	}

	async chat(
		message: string,
		history: { role: 'user' | 'assistant'; content: string }[] = [],
	): Promise<AsyncIterable<any>> {
		const response = await fetch(`${this.baseUrl}/api/chat`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				agentId: this.agentId,
				message,
				history,
			}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Chat API request failed: ${response.status} ${errorText}`);
		}

		if (!response.body) {
			throw new Error('No response body from chat API');
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		return {
			[Symbol.asyncIterator]: () => ({
				async next() {
					while (true) {
						const { done, value } = await reader.read();
						if (done) {
							if (buffer.length > 0) {
								// Final fragment — server-sent-events streams sometimes
								// terminate mid-buffer if the connection closes between
								// events. We surface the parse error so consumers can
								// log it instead of silently dropping the last chunk.
								try {
									return { value: JSON.parse(buffer), done: false };
								} catch (err) {
									console.warn(
										'[3d-agent/sdk] dropped trailing chat fragment',
										(err as Error)?.message,
									);
								}
							}
							return { done: true, value: undefined };
						}

						buffer += decoder.decode(value, { stream: true });
						const lines = buffer.split('\n');
						buffer = lines.pop() || '';

						for (const line of lines) {
							if (line.startsWith('data: ')) {
								const json = line.slice(6);
								try {
									return { value: JSON.parse(json), done: false };
								} catch (err) {
									// Mid-stream parse error — log and continue to the
									// next line rather than silently swallowing the
									// failure (which used to mask malformed payloads).
									console.warn(
										'[3d-agent/sdk] skipped malformed SSE chunk',
										(err as Error)?.message,
									);
								}
							}
						}
					}
				},
			}),
		};
	}

	embed(element: HTMLElement) {
		const iframe = document.createElement('iframe');
		iframe.src = `${this.baseUrl}/agent/${this.agentId}/embed`;
		iframe.width = '100%';
		iframe.height = '100%';
		iframe.style.border = 'none';
		element.appendChild(iframe);
	}
}

export function createAgent(apiKey: string, agentId: string, options?: AgentOptions): Agent {
	return new Agent(apiKey, agentId, options);
}
