// @vitest-environment jsdom
//
// Regression guard for the checkout's price-discovery request (public/x402.js).
//
// window.X402.pay() defaulted the discovery method to GET while still attaching
// the caller's request body, and fetch() refuses that combination outright
// ("Request with GET/HEAD method cannot have body"). The throw landed before the
// endpoint was ever contacted, so every page paying a POST route without naming
// the method died at "Confirming price" and no payment was ever attempted. The
// /tutor page hit this on every question. A body now implies POST, matching what
// the data-attribute binding in the same file has always inferred.
//
// Fixtures use $THREE (the only coin) as the Solana asset/payTo, per CLAUDE.md.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pay } from '../../public/x402.js';

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

const solanaAccept = {
	scheme: 'exact',
	network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
	amount: '10000',
	asset: THREE_MINT,
	payTo: THREE_MINT,
	maxTimeoutSeconds: 60,
	resource: 'https://three.ws/api/x402/tutor',
	extra: { name: 'USDC', decimals: 6, feePayer: THREE_MINT },
};

function stub402() {
	return {
		status: 402,
		headers: { get: () => null },
		json: async () => ({ accepts: [solanaAccept] }),
		text: async () => '{"error":"payment required"}',
	};
}

// The discovery fetch runs in a microtask after mount; the promise pay() returns
// stays pending at the wallet-connect step, which is where these assertions end.
function flush() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function discoveryRequest(opts) {
	const fetchSpy = vi.fn(async () => stub402());
	global.fetch = fetchSpy;
	pay(opts).catch(() => {});
	await flush();
	const call = fetchSpy.mock.calls.find(([url]) => String(url).includes('/api/x402/tutor'));
	expect(call, 'discovery never reached the endpoint').toBeTruthy();
	return { url: call[0], init: call[1] };
}

describe('x402 price discovery: request method', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
	});

	afterEach(() => {
		document.querySelector('.x402-overlay')?.remove();
		vi.restoreAllMocks();
	});

	it('sends POST when the caller supplies a body but no method', async () => {
		const { init } = await discoveryRequest({
			endpoint: '/api/x402/tutor',
			body: { sessionId: 'sess-1', question: 'Why does recursion overflow the stack?', level: 'beginner' },
			merchant: 'three.ws Tutor',
			action: 'Explain',
		});
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body).question).toContain('recursion');
		expect(init.headers['content-type']).toBe('application/json');
	});

	it('leaves a body-less call on GET', async () => {
		const { init } = await discoveryRequest({ endpoint: '/api/x402/tutor', merchant: 'three.ws Tutor' });
		expect(init.method).toBe('GET');
		expect(init.body).toBeUndefined();
	});

	it('never overrides a method the caller named', async () => {
		const { init } = await discoveryRequest({
			endpoint: '/api/x402/tutor',
			method: 'PUT',
			body: { question: 'What is a stack frame?' },
		});
		expect(init.method).toBe('PUT');
	});
});
