// Unit tests for the SDK AgentClient — verifies it speaks the live three.ws
// x402 contract (`api/agents/x402/[action].js` + `api/_lib/x402.js`): the
// intent-based 402 → pay → retry-with-`x-payment-intent` flow, the real
// `/api/agents/:id/pricing` (`{ prices }`) and
// `/api/agents/x402/manifest?agent_id=&skill=` routes, and the 409-means-free
// semantics. No network calls — fetch is mocked and request shapes are asserted.

import { describe, it, expect, vi } from 'vitest';
import { AgentClient, PaymentRequiredError } from '../../sdk/src/agent-client.js';

function res(status, body) {
	return {
		status,
		ok: status >= 200 && status < 300,
		statusText: String(status),
		json: async () => body,
	};
}

// Sequential fetch mock: returns queued responses in order and records calls.
function makeFetch(responses) {
	const queue = [...responses];
	const calls = [];
	const fn = async (url, opts = {}) => {
		calls.push({ url: String(url), opts });
		if (queue.length === 0) throw new Error(`unexpected fetch call: ${url}`);
		return queue.shift();
	};
	fn.calls = calls;
	return fn;
}

const MANIFEST = {
	version: '1',
	kind: 'agent-skill',
	agent_id: 'agent_1',
	skill: 'analyze',
	amount: '10000',
	currency: 'EPjF...USDC',
	recipient: 'So1aNa...wallet',
	recipient_name: 'Demo Agent',
	valid_until: 9999999999,
	intent_url: '/api/agents/payments/pay-prep',
	verify_url: '/api/agents/payments/pay-confirm',
	retry_with_header: 'x-payment-intent',
};

describe('AgentClient.getSkillPrices', () => {
	it('unwraps the { prices } envelope and hits /api/agents/:id/pricing', async () => {
		const prices = [
			{ skill: 'analyze', amount: '10000', currency_mint: 'USDC', chain: 'solana' },
		];
		const fetchImpl = makeFetch([res(200, { prices })]);
		const client = new AgentClient({ baseUrl: 'https://three.ws', fetch: fetchImpl });

		const out = await client.getSkillPrices('agent_1');

		expect(out).toEqual(prices);
		expect(fetchImpl.calls[0].url).toBe('https://three.ws/api/agents/agent_1/pricing');
	});

	it('tolerates a bare array response', async () => {
		const arr = [{ skill: 'x', amount: '1' }];
		const client = new AgentClient({ fetch: makeFetch([res(200, arr)]) });
		expect(await client.getSkillPrices('a')).toEqual(arr);
	});

	it('throws on a non-OK pricing response', async () => {
		const client = new AgentClient({ fetch: makeFetch([res(404, { error: 'not_found' })]) });
		await expect(client.getSkillPrices('missing')).rejects.toThrow(
			/getSkillPrices failed: 404/,
		);
	});
});

describe('AgentClient.getManifest', () => {
	it('returns the manifest on 200 and uses the query-param route', async () => {
		const fetchImpl = makeFetch([res(200, MANIFEST)]);
		const client = new AgentClient({ baseUrl: 'https://three.ws', fetch: fetchImpl });

		const manifest = await client.getManifest('agent_1', 'analyze');

		expect(manifest).toEqual(MANIFEST);
		expect(fetchImpl.calls[0].url).toBe(
			'https://three.ws/api/agents/x402/manifest?agent_id=agent_1&skill=analyze',
		);
	});

	it('returns null when the skill is free/unpriced (409)', async () => {
		const client = new AgentClient({ fetch: makeFetch([res(409, { error: 'no_payments' })]) });
		expect(await client.getManifest('agent_1', 'free_skill')).toBeNull();
	});
});

describe('AgentClient.invokeSkill', () => {
	it('POSTs the correct body to /api/agents/x402/invoke', async () => {
		const fetchImpl = makeFetch([res(402, MANIFEST)]);
		const client = new AgentClient({ baseUrl: 'https://three.ws', fetch: fetchImpl });

		await client.invokeSkill('agent_1', 'analyze', { ticker: 'SOL' }).catch(() => {});

		const call = fetchImpl.calls[0];
		expect(call.url).toBe('https://three.ws/api/agents/x402/invoke');
		expect(call.opts.method).toBe('POST');
		expect(JSON.parse(call.opts.body)).toEqual({
			agent_id: 'agent_1',
			skill: 'analyze',
			args: { ticker: 'SOL' },
		});
	});

	it('attaches the Authorization bearer header when an apiKey is set', async () => {
		const fetchImpl = makeFetch([res(402, MANIFEST)]);
		const client = new AgentClient({ apiKey: 'sk_test_123', fetch: fetchImpl });

		await client.invokeSkill('agent_1', 'analyze').catch(() => {});

		expect(fetchImpl.calls[0].opts.headers.authorization).toBe('Bearer sk_test_123');
	});

	it('throws PaymentRequiredError (carrying the manifest) when 402 and no payer', async () => {
		const client = new AgentClient({ fetch: makeFetch([res(402, MANIFEST)]) });

		const err = await client.invokeSkill('agent_1', 'analyze').then(
			() => null,
			(e) => e,
		);

		expect(err).toBeInstanceOf(PaymentRequiredError);
		expect(err.manifest).toEqual(MANIFEST);
		expect(err.message).toContain('10000');
	});

	it('settles the intent and retries with x-payment-intent, returning the result', async () => {
		const result = { ok: true, intent_id: 'intent_abc', result: { score: 0.91 } };
		const fetchImpl = makeFetch([res(402, MANIFEST), res(200, result)]);
		const client = new AgentClient({ baseUrl: 'https://three.ws', fetch: fetchImpl });

		const payIntent = vi.fn(async (manifest) => {
			expect(manifest).toEqual(MANIFEST);
			return { intentId: 'intent_abc' };
		});

		const out = await client.invokeSkill(
			'agent_1',
			'analyze',
			{ ticker: 'SOL' },
			{ payIntent },
		);

		expect(out).toEqual(result);
		expect(payIntent).toHaveBeenCalledOnce();

		// First call carries no payment header; the retry does, with the same body.
		expect(fetchImpl.calls[0].opts.headers['x-payment-intent']).toBeUndefined();
		const retry = fetchImpl.calls[1];
		expect(retry.url).toBe('https://three.ws/api/agents/x402/invoke');
		expect(retry.opts.headers['x-payment-intent']).toBe('intent_abc');
		expect(JSON.parse(retry.opts.body)).toEqual({
			agent_id: 'agent_1',
			skill: 'analyze',
			args: { ticker: 'SOL' },
		});
	});

	it('accepts a bare intent-id string from payIntent', async () => {
		const fetchImpl = makeFetch([res(402, MANIFEST), res(200, { ok: true })]);
		const client = new AgentClient({ fetch: fetchImpl });

		await client.invokeSkill('agent_1', 'analyze', {}, { payIntent: async () => 'intent_xyz' });

		expect(fetchImpl.calls[1].opts.headers['x-payment-intent']).toBe('intent_xyz');
	});

	it('supports a signer object exposing payIntent', async () => {
		const fetchImpl = makeFetch([res(402, MANIFEST), res(200, { ok: true })]);
		const client = new AgentClient({ fetch: fetchImpl });
		const signer = { payIntent: vi.fn(async () => ({ intentId: 'intent_signer' })) };

		await client.invokeSkill('agent_1', 'analyze', {}, { signer });

		expect(signer.payIntent).toHaveBeenCalledOnce();
		expect(fetchImpl.calls[1].opts.headers['x-payment-intent']).toBe('intent_signer');
	});

	it('throws a clear error for a free skill (409 from invoke)', async () => {
		const client = new AgentClient({ fetch: makeFetch([res(409, { error: 'no_payments' })]) });
		await expect(client.invokeSkill('agent_1', 'free_skill')).rejects.toThrow(
			/not a paid skill/,
		);
	});

	it('surfaces a payIntent that resolves without an intent id', async () => {
		const client = new AgentClient({ fetch: makeFetch([res(402, MANIFEST)]) });
		await expect(
			client.invokeSkill('agent_1', 'analyze', {}, { payIntent: async () => ({}) }),
		).rejects.toThrow(/paid intent id/);
	});
});
