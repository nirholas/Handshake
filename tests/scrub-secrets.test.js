import { describe, it, expect } from 'vitest';
import { scrubSecrets, redactUrlSecrets } from '../api/_lib/scrub-secrets.js';

describe('scrubSecrets', () => {
	it('redacts secret-bearing keys at the top level', () => {
		const out = scrubSecrets({ amount: 5, secret: 'abc', privateKey: 'xyz' });
		expect(out).toEqual({ amount: 5, secret: '[redacted]', privateKey: '[redacted]' });
	});

	it('redacts nested secrets at any depth', () => {
		const out = scrubSecrets({
			wallet: { address: 'W1', encrypted_solana_secret: 'deadbeef', meta: { mnemonic: 'a b c' } },
		});
		expect(out.wallet.address).toBe('W1');
		expect(out.wallet.encrypted_solana_secret).toBe('[redacted]');
		expect(out.wallet.meta.mnemonic).toBe('[redacted]');
	});

	it('walks arrays element-wise', () => {
		const out = scrubSecrets({ keys: [{ apiKey: 'k1' }, { apiKey: 'k2' }] });
		expect(out.keys).toEqual([{ apiKey: '[redacted]' }, { apiKey: '[redacted]' }]);
	});

	it('matches case-insensitively and as a substring (keypair, signingKey, bearer)', () => {
		const out = scrubSecrets({ KeyPair: 'x', signingKey: 'y', bearerToken: 'z', mint: 'MINT' });
		expect(out).toEqual({ KeyPair: '[redacted]', signingKey: '[redacted]', bearerToken: '[redacted]', mint: 'MINT' });
	});

	it('leaves non-secret data (mints, signatures, amounts) untouched', () => {
		const detail = { mint: 'So111…', signature: '5xk…', amount_sol: 0.01, symbol: 'THREE' };
		expect(scrubSecrets(detail)).toEqual(detail);
	});

	it('passes primitives through and handles cycles without throwing', () => {
		expect(scrubSecrets(42)).toBe(42);
		expect(scrubSecrets('hi')).toBe('hi');
		expect(scrubSecrets(null)).toBe(null);
		const a = { name: 'a' };
		a.self = a; // circular
		expect(() => scrubSecrets(a)).not.toThrow();
		expect(scrubSecrets(a).name).toBe('a');
	});

	it('does not mutate the input object', () => {
		const input = { secret: 'keep-me-in-original' };
		scrubSecrets(input);
		expect(input.secret).toBe('keep-me-in-original');
	});

	it('does NOT reach credentials inside a plain string (that is redactUrlSecrets job)', () => {
		// Pinning the division of labour: scrubSecrets matches on object KEYS, so a
		// bare error message is invisible to it. If someone ever "fixes" that by
		// making it walk strings, this test says where the real tool lives.
		const msg = 'FetchError: request to https://rpc.example/?api-key=SECRET failed';
		expect(scrubSecrets(msg)).toBe(msg);
	});
});

describe('redactUrlSecrets', () => {
	it('masks a keyed RPC URL inside a network error message', () => {
		// The exact shape Solana web3.js produces when the RPC call fails — the leak
		// this exists to stop (HELIUS_API_KEY into console / Sentry / ops alerts).
		const out = redactUrlSecrets('FetchError: request to https://mainnet.helius-rpc.com/?api-key=abc123secret failed');
		expect(out).not.toContain('abc123secret');
		expect(out).toContain('api-key=REDACTED');
		// The rest of the message must survive, or the log is useless for debugging.
		expect(out).toContain('FetchError');
		expect(out).toContain('mainnet.helius-rpc.com');
	});

	it('masks every credential parameter spelling and multiple occurrences', () => {
		const out = redactUrlSecrets(
			'a=https://x/?api_key=A1 b=https://y/?access-token=B2 c=https://z/?secret=C3&token=D4&auth=E5',
		);
		for (const leaked of ['A1', 'B2', 'C3', 'D4', 'E5']) expect(out).not.toContain(leaked);
	});

	it('stops at the parameter boundary, keeping following params readable', () => {
		const out = redactUrlSecrets('https://rpc/?api-key=SECRET&cluster=devnet');
		expect(out).toBe('https://rpc/?api-key=REDACTED&cluster=devnet');
	});

	it('leaves a clean message and non-credential params untouched', () => {
		const clean = 'Transaction simulation failed: insufficient lamports for rent';
		expect(redactUrlSecrets(clean)).toBe(clean);
		expect(redactUrlSecrets('https://rpc/?cluster=devnet&commitment=confirmed')).toBe(
			'https://rpc/?cluster=devnet&commitment=confirmed',
		);
	});

	it('coerces non-strings instead of throwing', () => {
		expect(redactUrlSecrets(null)).toBe('');
		expect(redactUrlSecrets(undefined)).toBe('');
		expect(redactUrlSecrets(42)).toBe('42');
	});
});
