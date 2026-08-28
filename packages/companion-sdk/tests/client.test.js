import { describe, it, expect, vi } from 'vitest';
import { createCompanionClient, readSse, CompanionError } from '../src/client.js';

function jsonResponse(body, { status = 200 } = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => JSON.stringify(body),
	};
}

function sseResponse(frames) {
	const encoder = new TextEncoder();
	const chunks = frames.map((frame) => encoder.encode(frame));
	let index = 0;
	return {
		ok: true,
		status: 200,
		body: {
			getReader: () => ({
				read: async () => (index < chunks.length
					? { value: chunks[index++], done: false }
					: { value: undefined, done: true }),
			}),
		},
	};
}

describe('createCompanionClient', () => {
	it('sends a message with the bridge token as a bearer', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ accepted: true, event: { importance: 88 } }));
		const client = createCompanionClient({ token: 'cmp_test', fetch: fetchImpl, apiBase: 'https://example.test' });
		const result = await client.send({ title: 'Build finished' });

		expect(result.event.importance).toBe(88);
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe('https://example.test/api/companion/ingest');
		expect(init.headers.authorization).toBe('Bearer cmp_test');
		expect(JSON.parse(init.body)).toEqual({ title: 'Build finished' });
	});

	it('refuses an event with no title before it reaches the network', () => {
		const client = createCompanionClient({ token: 't', fetch: vi.fn() });
		expect(() => client.send({ body: 'no title' })).toThrow(CompanionError);
	});

	it('surfaces the server error message and status', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse({ code: 'unauthorized', message: 'unknown bridge token' }, { status: 401 }),
		);
		const client = createCompanionClient({ token: 'bad', fetch: fetchImpl });
		await expect(client.send({ title: 'hi' })).rejects.toMatchObject({
			status: 401,
			code: 'unauthorized',
			message: 'unknown bridge token',
		});
	});

	it('builds the list query from its options', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ events: [] }));
		const client = createCompanionClient({ token: 't', fetch: fetchImpl, apiBase: 'https://example.test' });
		await client.list({ limit: 5, minImportance: 70 });
		expect(fetchImpl.mock.calls[0][0]).toBe('https://example.test/api/companion/events?limit=5&min_importance=70');
	});

	it('streams deliveries over a token-authenticated fetch', async () => {
		const frames = [
			'event: hello\ndata: {"threshold":60}\n\n',
			'event: delivery\ndata: {"id":"e1","spoken_line":"Sarah is at the door","created_at":"2026-08-28T12:00:00.000Z"}\n\n',
			':hb\n\n',
		];
		const fetchImpl = vi.fn().mockImplementation(async (url) => {
			if (String(url).includes('/api/companion/stream')) return sseResponse(frames);
			return jsonResponse({ ok: true });
		});
		const client = createCompanionClient({ token: 't', fetch: fetchImpl, retryMs: 10_000 });

		const seen = [];
		let opened = null;
		const stop = client.stream({
			onDelivery: (d) => seen.push(d),
			onOpen: (hello) => { opened = hello; },
		});
		await vi.waitFor(() => expect(seen).toHaveLength(1));
		stop();

		expect(opened).toEqual({ threshold: 60 });
		expect(seen[0].spoken_line).toBe('Sarah is at the door');
		expect(fetchImpl.mock.calls[0][1].headers.accept).toBe('text/event-stream');
	});
});

describe('readSse', () => {
	it('reassembles frames split across chunk boundaries', async () => {
		const encoder = new TextEncoder();
		const pieces = ['event: deliv', 'ery\ndata: {"id"', ':"e2"}\n\nevent: hello\ndata: {}\n\n'].map((p) => encoder.encode(p));
		let index = 0;
		const stream = {
			getReader: () => ({
				read: async () => (index < pieces.length ? { value: pieces[index++], done: false } : { done: true }),
			}),
		};
		const frames = [];
		for await (const frame of readSse(stream)) frames.push(frame);
		expect(frames).toEqual([
			{ event: 'delivery', data: '{"id":"e2"}' },
			{ event: 'hello', data: '{}' },
		]);
	});
});
