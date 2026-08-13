// @vitest-environment jsdom
//
// Core-path coverage for @three-ws/chat-plugin's host-side AgentBridge
// (chat-plugin/src/bridge.ts): the v1 postMessage envelope a LobeChat /
// SperaxOS host uses to drive the embedded avatar iframe. Verifies the
// ready handshake, request/response resolution, pre-ready queueing, the
// legacy boot.js resize channel, and pending-request rejection on unmount.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentBridge } from '../chat-plugin/src/bridge.ts';

describe('AgentBridge (chat-plugin host bridge, wire protocol v1)', () => {
	let frame;
	let iframeRef;
	let posted;
	let bridge;

	beforeEach(() => {
		frame = document.createElement('iframe');
		document.body.appendChild(frame);
		posted = [];
		vi.spyOn(frame.contentWindow, 'postMessage').mockImplementation((msg) => {
			posted.push(msg);
		});
		iframeRef = { current: frame };
	});

	afterEach(() => {
		bridge?.unmount();
		frame.remove();
	});

	// Deliver an iframe-side envelope to the bridge, with event.source pinned
	// to the frame's contentWindow (the bridge drops messages from any other
	// source once the frame is mounted).
	function iframeSend(env) {
		const ev = new MessageEvent('message', { data: env });
		Object.defineProperty(ev, 'source', { value: frame.contentWindow });
		window.dispatchEvent(ev);
	}

	function ready(capabilities = ['speak', 'gesture', 'emote']) {
		iframeSend({
			v: 1,
			source: 'agent-3d',
			id: 'evt-ready',
			kind: 'event',
			op: 'ready',
			payload: { agentId: 'agent-1', capabilities },
		});
	}

	it('fires onReady and flushes queued requests once the iframe signals ready', async () => {
		const onReady = vi.fn();
		bridge = new AgentBridge({ agentId: 'agent-1', iframeRef, onReady });
		bridge.mount();

		// Requested before the handshake: must queue, not transmit.
		const speakP = bridge.speak('hello', { sentiment: 0.5 });
		expect(posted).toHaveLength(0);

		ready();
		expect(onReady).toHaveBeenCalledWith({
			agentId: 'agent-1',
			capabilities: ['speak', 'gesture', 'emote'],
		});

		// The queued speak flushed as a v1 agent-host request envelope.
		const speakEnv = posted.find((m) => m.op === 'speak');
		expect(speakEnv).toMatchObject({
			v: 1,
			source: 'agent-host',
			kind: 'request',
			payload: { text: 'hello', sentiment: 0.5 },
		});
		expect(typeof speakEnv.id).toBe('string');

		// Responding with inReplyTo resolves the caller's promise.
		iframeSend({
			v: 1,
			source: 'agent-3d',
			id: 'resp-1',
			inReplyTo: speakEnv.id,
			kind: 'response',
			op: 'speak',
			payload: { ok: true },
		});
		await expect(speakP).resolves.toEqual({ ok: true });
	});

	it('transmits gesture/emote/setAgent immediately after ready, with defaults applied', () => {
		bridge = new AgentBridge({ agentId: 'agent-1', iframeRef });
		bridge.mount();
		ready();
		posted.length = 0;

		bridge.gesture('wave').catch(() => undefined);
		bridge.emote({ trigger: 'joy' }).catch(() => undefined);
		bridge.setAgent('agent-2').catch(() => undefined);

		expect(posted.map((m) => m.op)).toEqual(['gesture', 'emote', 'setAgent']);
		expect(posted[0].payload).toEqual({ name: 'wave' });
		expect(posted[1].payload).toEqual({ trigger: 'joy', weight: 1 });
		expect(posted[2].payload).toEqual({ agentId: 'agent-2' });
	});

	it('ignores envelopes not sourced from the mounted iframe', () => {
		const onReady = vi.fn();
		bridge = new AgentBridge({ agentId: 'agent-1', iframeRef, onReady });
		bridge.mount();

		// No pinned source: event.source is null, not frame.contentWindow.
		window.dispatchEvent(
			new MessageEvent('message', {
				data: {
					v: 1,
					source: 'agent-3d',
					id: 'evt-x',
					kind: 'event',
					op: 'ready',
					payload: { agentId: 'spoofed', capabilities: [] },
				},
			}),
		);
		expect(onReady).not.toHaveBeenCalled();
	});

	it('handles the legacy boot.js channel: embed:resize drives onResize, embed:ready drives onReady', () => {
		const onReady = vi.fn();
		const onResize = vi.fn();
		bridge = new AgentBridge({ agentId: 'agent-1', iframeRef, onReady, onResize });
		bridge.mount();

		iframeSend({ ns: '3d-agent', type: 'embed:resize', payload: { height: 512 } });
		expect(onResize).toHaveBeenCalledWith(512);

		iframeSend({ ns: '3d-agent', type: 'embed:ready', payload: { capabilities: ['speak'] } });
		expect(onReady).toHaveBeenCalledWith({ agentId: 'agent-1', capabilities: ['speak'] });
	});

	it('rejects every pending request on unmount', async () => {
		bridge = new AgentBridge({ agentId: 'agent-1', iframeRef });
		bridge.mount();
		ready();
		const p = bridge.speak('bye');
		bridge.unmount();
		await expect(p).rejects.toThrow('Bridge unmounted');
	});
});
