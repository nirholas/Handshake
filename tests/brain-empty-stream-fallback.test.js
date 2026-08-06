// A brain route can finish a stream having emitted NOTHING and reported no error:
// the per-attempt abort fires before the first token on a slow free route, or the
// upstream returns an empty completion. That used to be written out as a
// successful `done` event with no text, which ended the response 200-with-no-text
// AND skipped the entire fallback chain — healthy routes sat unused while the
// caller got a blank answer. Observed in production 2026-08-06: a Scribe citizen's
// /api/brain/chat call returned `firstTokenMs: null, usage: null` and zero text.
//
// Zero visible output is a failed attempt. These tests pin that: an empty primary
// falls through to the next route, and an all-empty chain surfaces a real `error`
// event rather than a fake success.

import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { streamBrain } from '../api/brain/chat.js';

// Minimal ServerResponse stand-in: collects the SSE frames streamBrain writes.
function fakeRes() {
	return {
		statusCode: 0,
		headers: {},
		chunks: [],
		writableEnded: false,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		write(s) {
			this.chunks.push(s);
			return true;
		},
		end() {
			this.writableEnded = true;
		},
		get body() {
			return this.chunks.join('');
		},
	};
}

// Parse the SSE body into [{ event, data }] the way a client does.
function events(res) {
	return res.body
		.split('\n\n')
		.filter(Boolean)
		.map((frame) => {
			let event = 'message';
			const data = [];
			for (const line of frame.split('\n')) {
				if (line.startsWith('event:')) event = line.slice(6).trim();
				else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
			}
			return { event, data: data.join('\n') };
		});
}

// The visible text a client would assemble from the unnamed data frames.
function streamedText(res) {
	return events(res)
		.filter((e) => e.event === 'message' && e.data !== '[DONE]')
		.map((e) => {
			try {
				const v = JSON.parse(e.data);
				return typeof v === 'string' ? v : '';
			} catch {
				return '';
			}
		})
		.join('');
}

// A model whose stream carries no text deltas and throws nothing — the exact
// shape a slow free route leaves behind when its abort fires pre-first-token.
function emptyModel() {
	return new MockLanguageModelV3({
		doStream: async () => ({
			stream: simulateReadableStream({
				chunks: [{ type: 'finish', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5 } }],
			}),
		}),
	});
}

function textModel(text) {
	return new MockLanguageModelV3({
		doStream: async () => ({
			stream: simulateReadableStream({
				chunks: [
					{ type: 'text-start', id: '0' },
					{ type: 'text-delta', id: '0', delta: text },
					{ type: 'text-end', id: '0' },
					{ type: 'finish', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } },
				],
			}),
		}),
	});
}

const SPEC = { label: 'Test Route', network: 'test', tier: 'balanced', maxOutput: 512 };
const MESSAGES = [{ role: 'user', content: 'write the artifact' }];

describe('streamBrain: a route that streams nothing is a failed attempt', () => {
	it('falls through to the next route instead of ending 200 with no text', async () => {
		const res = fakeRes();
		await streamBrain(res, {
			plan: { spec: SPEC, primary: { kind: 'ai-sdk', model: emptyModel() }, fallbackModel: textModel('real output') },
			providerKey: 'gpt-oss-120b',
			messages: MESSAGES,
		});

		expect(streamedText(res)).toBe('real output');
		const names = events(res).map((e) => e.event);
		expect(names).toContain('fallback');
		expect(names).toContain('done');
		expect(names).not.toContain('error');
	});

	it('surfaces a real error event when every route comes up empty', async () => {
		const res = fakeRes();
		await streamBrain(res, {
			plan: { spec: SPEC, primary: { kind: 'ai-sdk', model: emptyModel() }, fallbackModel: emptyModel() },
			providerKey: 'gpt-oss-120b',
			messages: MESSAGES,
		});

		expect(streamedText(res)).toBe('');
		const names = events(res).map((e) => e.event);
		expect(names).toContain('error');
		// The old bug reported success: a `done` frame with no text at all.
		expect(names).not.toContain('done');
		expect(res.writableEnded).toBe(true);
	});

	it('still completes normally when the primary streams real text', async () => {
		const res = fakeRes();
		await streamBrain(res, {
			plan: { spec: SPEC, primary: { kind: 'ai-sdk', model: textModel('hello world') }, fallbackModel: null },
			providerKey: 'gpt-oss-120b',
			messages: MESSAGES,
		});

		expect(streamedText(res)).toBe('hello world');
		const names = events(res).map((e) => e.event);
		expect(names).toContain('done');
		expect(names).not.toContain('fallback');
		expect(names).not.toContain('error');
	});
});
