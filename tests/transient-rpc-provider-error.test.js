// isTransientRpcError decides whether a money-surface caller treats an RPC
// failure as "we could not ask" (retry next tick) or "this is a real defect"
// (throw, page someone). Getting it wrong on the first side is expensive in a
// specific way: treasury-topup IS the self-heal for a starved engine wallet, so
// an unclassified lane fault takes the remedy down exactly when the ring needs
// it.
//
// Production 2026-08-08, every Solana lane cooling at once:
//   [api] unhandled Error: failed to get balance of account Wwwu...WwW:
//     Error: solana rpc provider error -16401 @ solana-mainnet.gateway.tatum.io
// That is the LAST lane's own JSON-RPC error, surfaced because rotation ran out
// before it could report the tidy "all solana rpc endpoints failed" summary, and
// it 500ed the cron every few ticks. These pin both directions of the call.

import { describe, expect, it } from 'vitest';
import { isTransientRpcError } from '../api/_lib/solana/connection.js';

describe('isTransientRpcError: provider errors are upstream weather', () => {
	it('classifies the exact production message that 500ed treasury-topup', () => {
		const err = new Error(
			'failed to get balance of account WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW: ' +
				'Error: solana rpc provider error -16401 @ https://solana-mainnet.gateway.tatum.io',
		);
		expect(isTransientRpcError(err)).toBe(true);
	});

	it('matches the wrapper, not one vendor code, so a new code still fails over', () => {
		// isProviderTierError already treats -16401 as a failover signal; the point
		// here is that the NEXT provider to invent a code needs no code change.
		for (const code of ['-16401', '-32011', '-99999', '7']) {
			expect(isTransientRpcError(new Error(`solana rpc provider error ${code} @ https://x.example`))).toBe(
				true,
			);
		}
	});

	it('is case-insensitive and survives wrapping', () => {
		expect(isTransientRpcError(new Error('SOLANA RPC PROVIDER ERROR -16401'))).toBe(true);
		expect(isTransientRpcError('solana rpc provider error -16401')).toBe(true);
	});

	it('classifies the web3.js response-shape failure that 500ed treasury-topup again', () => {
		// Production 2026-08-13T10:32:04Z. classifyRpcBody had already passed the
		// body (it was well-formed JSON-RPC), but web3.js's superstruct check
		// rejected it: createRpcResult pins `id: string()` and
		// `jsonrpc: literal('2.0')`, so a lane echoing a numeric id or a
		// non-string error.message throws here instead of answering. The sweep
		// rethrew it as a hard 500 and took the engine self-heal down with it.
		const err = new Error(
			'failed to get balance of account WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW: ' +
				'StructError: Expected the value to satisfy a union of `type | type`, but received: [object Object]',
		);
		expect(isTransientRpcError(err)).toBe(true);
	});

	it('classifies the same failure wherever web3.js validates a node answer', () => {
		// Every superstruct call in web3.js validates something the NODE sent, so
		// the shape recurs on other reads. Same day, same cause, different caller:
		//   [sdk-bridge] getBondingCurveState failed: StructError: …
		for (const m of [
			'getBondingCurveState failed: StructError: Expected the value to satisfy a union of `type | type`, but received: [object Object]',
			'StructError: Expected the value to satisfy a union of `type | type`, but received: [object Object]',
			'Expected the value to satisfy a union of `type | type`, but received: [object Object]',
		]) {
			expect(isTransientRpcError(new Error(m))).toBe(true);
		}
	});

	it('still classifies the pre-existing transient shapes', () => {
		for (const m of [
			'Server responded with 429 Too Many Requests',
			'max usage reached',
			'all solana rpc endpoints failed',
			'all rpc endpoints exhausted',
			'fetch failed',
			'ECONNRESET',
			'request timed out',
		]) {
			expect(isTransientRpcError(new Error(m))).toBe(true);
		}
	});

	it('does NOT swallow a genuine caller defect', () => {
		// These must keep throwing: they are the caller asking for something
		// impossible, not the infrastructure failing to answer.
		for (const m of [
			'Invalid public key input',
			'Endpoint URL must start with `http:` or `https:`.',
			'insufficient funds for rent',
			'Transaction simulation failed: Blockhash not found',
		]) {
			expect(isTransientRpcError(new Error(m))).toBe(false);
		}
	});

	it('handles a null or undefined error without throwing', () => {
		expect(isTransientRpcError(null)).toBe(false);
		expect(isTransientRpcError(undefined)).toBe(false);
	});
});
