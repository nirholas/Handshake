// The OpenRouter usage-accounting fetch: it must ask for the cost, read the
// cost, and never damage the response the AI SDK is about to stream.
//
// Both halves matter. Without the opt-in OpenRouter omits `usage.cost` entirely,
// so /brain metered paid Claude mirrors at nothing. And a metering wrapper that
// consumes or reorders the body would break streaming, which is a far worse
// outcome than missing telemetry: the rule here is that the completion always
// wins and metering is best-effort.

import { describe, it, expect, vi } from 'vitest';
import {
	withUsageAccounting,
	readReportedCost,
	openrouterUsageFetch,
} from '../../api/_lib/openrouter-usage.js';

const SSE = [
	'data: {"choices":[{"delta":{"content":"hel"}}]}',
	'data: {"choices":[{"delta":{"content":"lo"}}]}',
	// OpenRouter's final frame carries usage, including the charged amount and a
	// cost_details block whose keys also end in "cost" (a naive scan reads the
	// wrong number here).
	'data: {"choices":[],"usage":{"prompt_tokens":69,"completion_tokens":16,"cost":0.0004312,"cost_details":{"upstream_inference_cost":0.0000021}}}',
	'data: [DONE]',
	'',
].join('\n\n');

function streamOf(text) {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			// Deliberately chunked mid-frame: the reader must reassemble.
			const bytes = encoder.encode(text);
			controller.enqueue(bytes.slice(0, 40));
			controller.enqueue(bytes.slice(40));
			controller.close();
		},
	});
}

describe('withUsageAccounting', () => {
	it('adds the usage opt-in to a JSON body', () => {
		const out = withUsageAccounting({ body: JSON.stringify({ model: 'anthropic/claude-opus-5', messages: [] }) });
		expect(JSON.parse(out.body).usage).toEqual({ include: true });
		expect(JSON.parse(out.body).model).toBe('anthropic/claude-opus-5');
	});

	it('leaves a caller-supplied usage block alone', () => {
		const body = JSON.stringify({ model: 'm', usage: { include: false } });
		expect(withUsageAccounting({ body }).body).toBe(body);
	});

	it('passes through a non-JSON body untouched', () => {
		expect(withUsageAccounting({ body: 'not json' }).body).toBe('not json');
		expect(withUsageAccounting({}).body).toBeUndefined();
	});
});

describe('readReportedCost', () => {
	it('reads the cost from the final SSE usage frame, not from cost_details', () => {
		return expect(readReportedCost(SSE)).resolves.toBe(0.0004312);
	});

	it('reads the cost from a plain JSON completion', () => {
		return expect(readReportedCost(JSON.stringify({ usage: { prompt_tokens: 1, cost: 0.25 } }))).resolves.toBe(0.25);
	});

	it('returns a reported zero as zero (a free route really did cost nothing)', () => {
		return expect(readReportedCost(JSON.stringify({ usage: { cost: 0 } }))).resolves.toBe(0);
	});

	it('returns null when nothing reported a cost', () => {
		return expect(readReportedCost(JSON.stringify({ usage: { prompt_tokens: 3 } }))).resolves.toBeNull();
	});

	it('survives a truncated stream without throwing', () => {
		return expect(readReportedCost('data: {"choices":[{"delta":{"conte')).resolves.toBeNull();
	});
});

describe('openrouterUsageFetch', () => {
	it('reports the cost while handing the stream through intact', async () => {
		let seen = null;
		const base = vi.fn(async () => new Response(streamOf(SSE), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
		const f = openrouterUsageFetch((usd) => { seen = usd; }, base);

		const res = await f('https://openrouter.ai/api/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({ model: 'anthropic/claude-opus-5', messages: [] }),
		});
		// The consumer gets every byte, in order.
		const body = await res.text();
		expect(body).toBe(SSE);
		expect(res.status).toBe(200);
		// The opt-in went out on the wire.
		expect(JSON.parse(base.mock.calls[0][1].body).usage).toEqual({ include: true });
		// The cost arrives out-of-band once the copied stream drains.
		await vi.waitFor(() => expect(seen).toBe(0.0004312));
	});

	it('does not call back when the upstream failed', async () => {
		const onCost = vi.fn();
		const base = async () => new Response('{"error":{"message":"nope"}}', { status: 402 });
		const res = await openrouterUsageFetch(onCost, base)('https://openrouter.ai/x', { body: '{}' });
		expect(res.status).toBe(402);
		expect(onCost).not.toHaveBeenCalled();
	});

	it('returns the original response when the body cannot be teed', async () => {
		const onCost = vi.fn();
		// A response-like object whose body has no tee(): metering must degrade,
		// not throw into the request path.
		const fake = { ok: true, status: 200, body: {} };
		const res = await openrouterUsageFetch(onCost, async () => fake)('https://openrouter.ai/x', { body: '{}' });
		expect(res).toBe(fake);
		expect(onCost).not.toHaveBeenCalled();
	});
});
