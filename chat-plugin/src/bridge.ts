/**
 * Host-side PostMessage bridge wrapping the agent embed iframe.
 *
 * Wire protocol v1 — envelope shape:
 *   { v: 1, source: 'agent-host' | 'agent-3d', id, inReplyTo?, kind, op, payload }
 *
 * Canonical spec: the "Wire protocol (v1)" section of chat-plugin/README.md
 */

export type BridgeOp =
	| 'ping'
	| 'pong'
	| 'ready'
	| 'speak'
	| 'gesture'
	| 'emote'
	| 'look'
	| 'setAgent'
	| 'subscribe'
	| 'error';
export type BridgeKind = 'request' | 'response' | 'event';

export interface BridgeEnvelope {
	v: 1;
	source: 'agent-3d' | 'agent-host';
	id: string;
	inReplyTo?: string;
	kind: BridgeKind;
	op: BridgeOp | string;
	payload: Record<string, unknown>;
}

export interface BridgeReadyPayload {
	agentId: string;
	capabilities: string[];
}

export interface BridgeOptions {
	agentId: string;
	iframeRef: React.RefObject<HTMLIFrameElement>;
	allowedOrigin?: string;
	onReady?: (payload: BridgeReadyPayload) => void;
	onResize?: (height: number) => void;
	onAction?: (action: Record<string, unknown>) => void;
}

function newId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

type PendingEntry = {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

export class AgentBridge {
	private readonly agentId: string;
	private readonly iframeRef: React.RefObject<HTMLIFrameElement>;
	private readonly allowedOrigin: string | null;
	private readonly onReady?: (payload: BridgeReadyPayload) => void;
	private readonly onResize?: (height: number) => void;
	private readonly onAction?: (action: Record<string, unknown>) => void;

	private readonly messageHandler: (ev: MessageEvent) => void;
	private readonly pending = new Map<string, PendingEntry>();
	private queue: BridgeEnvelope[] = [];
	private connected = false;

	constructor(opts: BridgeOptions) {
		this.agentId = opts.agentId;
		this.iframeRef = opts.iframeRef;
		this.allowedOrigin = opts.allowedOrigin ?? null;
		this.onReady = opts.onReady;
		this.onResize = opts.onResize;
		this.onAction = opts.onAction;
		this.messageHandler = (ev: MessageEvent) => this.handleMessage(ev);
	}

	mount(): void {
		window.addEventListener('message', this.messageHandler);
	}

	unmount(): void {
		window.removeEventListener('message', this.messageHandler);
		for (const { reject, timer } of this.pending.values()) {
			clearTimeout(timer);
			reject(new Error('Bridge unmounted'));
		}
		this.pending.clear();
	}

	// ── Incoming ──────────────────────────────────────────────────────────────

	private handleMessage(ev: MessageEvent): void {
		const frame = this.iframeRef.current;
		if (frame?.contentWindow && ev.source !== frame.contentWindow) return;

		const msg = ev.data as Partial<BridgeEnvelope> & Record<string, unknown>;
		if (!msg || typeof msg !== 'object') return;

		// Legacy boot.js format: { v:1, ns:'3d-agent', type:'embed:resize', payload }
		if (msg['ns'] === '3d-agent' && typeof msg['type'] === 'string') {
			const type = msg['type'] as string;
			const payload = (msg['payload'] as Record<string, unknown>) ?? {};
			if (type === 'embed:resize' && typeof payload['height'] === 'number') {
				this.onResize?.(payload['height'] as number);
			}
			if (type === 'embed:hello' || type === 'embed:ready') {
				this.onReady?.({
					agentId: this.agentId,
					capabilities: (payload['capabilities'] as string[]) ?? [],
				});
			}
			return;
		}

		// v1 spec envelope
		if (msg.v !== 1 || msg.source !== 'agent-3d') return;
		const env = msg as BridgeEnvelope;

		if (env.kind === 'event') {
			this.handleEvent(env);
		} else if (env.kind === 'response') {
			this.handleResponse(env);
		}
	}

	private handleEvent(env: BridgeEnvelope): void {
		switch (env.op) {
			case 'ready': {
				const p = env.payload as unknown as BridgeReadyPayload;
				this.connected = true;
				// Complete handshake: send ping, wait for pong.
				this.request('ping', {}).catch(() => undefined);
				this.onReady?.(p);
				for (const queued of this.queue) this.transmit(queued);
				this.queue = [];
				break;
			}
			case 'resize':
				if (typeof env.payload['height'] === 'number') {
					this.onResize?.(env.payload['height'] as number);
				}
				break;
			default:
				if (env.op === 'action') {
					this.onAction?.(env.payload);
				}
		}
	}

	private handleResponse(env: BridgeEnvelope): void {
		if (!env.inReplyTo) return;
		const entry = this.pending.get(env.inReplyTo);
		if (!entry) return;
		clearTimeout(entry.timer);
		this.pending.delete(env.inReplyTo);
		entry.resolve(env.payload);
	}

	// ── Outgoing ─────────────────────────────────────────────────────────────

	private request(op: BridgeOp, payload: Record<string, unknown>): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = newId();
			const env: BridgeEnvelope = {
				v: 1,
				source: 'agent-host',
				id,
				kind: 'request',
				op,
				payload,
			};
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Bridge request "${op}" timed out`));
			}, 10_000);
			this.pending.set(id, { resolve, reject, timer });
			if (this.connected) {
				this.transmit(env);
			} else {
				this.queue.push(env);
			}
		});
	}

	private transmit(env: BridgeEnvelope): void {
		const frame = this.iframeRef.current;
		if (!frame?.contentWindow) return;
		try {
			frame.contentWindow.postMessage(env, this.allowedOrigin ?? '*');
		} catch (_) {
			// Silently drop — frame may have been removed.
		}
	}

	// ── Public API ────────────────────────────────────────────────────────────

	speak(text: string, opts?: { sentiment?: number }): Promise<void> {
		return this.request('speak', { text, sentiment: opts?.sentiment ?? 0 }) as Promise<void>;
	}

	gesture(name: string): Promise<void> {
		return this.request('gesture', { name }) as Promise<void>;
	}

	emote(opts: { trigger: string; weight?: number }): Promise<void> {
		return this.request('emote', {
			trigger: opts.trigger,
			weight: opts.weight ?? 1,
		}) as Promise<void>;
	}

	look(opts: { target: unknown }): Promise<void> {
		return this.request('look', { target: opts.target }) as Promise<void>;
	}

	setAgent(nextAgentId: string): Promise<void> {
		return this.request('setAgent', { agentId: nextAgentId }) as Promise<void>;
	}
}
