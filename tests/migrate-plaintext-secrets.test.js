// Cover the one decision in scripts/migrate-plaintext-secrets.mjs that carries
// real risk: which Cloud Run env vars are credentials that must move into Secret
// Manager, and which are public identifiers that should stay as plaintext config.
//
// A false negative leaves a wallet key readable by anyone with run.services.get.
// A false positive buries a public address behind an IAM grant and makes the
// service config unreadable to an operator for no gain. Both cases are named
// below with the real env vars this platform runs on (api/_lib/solana-signers.js,
// docs/ops/gcp-production.md).

import { describe, it, expect } from 'vitest';
import { classify, defaultSecretName, mapLimit, urlCarriesCredential } from '../scripts/migrate-plaintext-secrets.mjs';

describe('credential classifier', () => {
	it('treats the wallet secret keys as credentials', () => {
		for (const name of [
			'ECONOMY_MASTER_SECRET_BASE58',
			'X402_TREASURY_SECRET_BASE58',
			'X402_SEED_SOLANA_SECRET_BASE58',
			'LAUNCHER_MASTER_SECRET_KEY_B64',
			'PUMP_CRON_RELAYER_SECRET_KEY_B64',
			'PLATFORM_TREASURY_KEYPAIR',
			'WALLET_ENCRYPTION_KEY',
			'JWT_SECRET',
			'CRON_SECRET',
		]) {
			expect(classify(name).secret, name).toBe(true);
		}
	});

	it('treats API tokens and connection strings as credentials', () => {
		for (const name of [
			'UPSTASH_REDIS_REST_TOKEN',
			'ANTHROPIC_API_KEY',
			'TELEGRAM_BOT_TOKEN',
			'DATABASE_URL',
			'A2A_PAYER_SOLANA_SECRET',
		]) {
			expect(classify(name).secret, name).toBe(true);
		}
	});

	it('leaves public identifiers as plaintext config', () => {
		for (const name of [
			'ECONOMY_MASTER_ADDRESS',
			'X402_FEE_PAYER_SOLANA',
			'THREE_TOKEN_MINT',
			'NEXT_PUBLIC_API_KEY',
		]) {
			expect(classify(name).secret, name).toBe(false);
		}
	});

	it('leaves a handle that merely names a credential', () => {
		for (const name of ['KMS_KEY_RING', 'VANITY_KEY_ID', 'GCS_KEY_FILE', 'WALLET_SECRET_NAME']) {
			expect(classify(name).secret, name).toBe(false);
		}
	});

	// A URL's name says nothing about whether it carries a key, so the value
	// decides. Every one of the 19 URL vars on production was checked this way on
	// 2026-09-02 and only DATABASE_URL carried a credential.
	it('leaves a provider URL alone when its value carries no credential', () => {
		for (const [name, value] of [
			['SOLANA_RPC_URL', 'https://rpc.example.com/v2/abc'],
			['UPSTASH_REDIS_REST_URL', 'http://10.128.15.228'],
			['GCP_STYLIZE_URL', 'https://stylize-abc-uc.a.run.app'],
		]) {
			expect(classify(name, value).secret, name).toBe(false);
		}
	});

	it('migrates a provider URL that does carry one', () => {
		for (const [name, value] of [
			['SOLANA_RPC_URL', 'https://rpc.example.com/?api-key=abc123'],
			['AGENT_WALLET_RPC_URL', 'https://eth.example.com/v2?apiKey=zzz'],
			['LIQUIDATION_COLLECTOR_URL', 'https://user:pw@collector.example.com/hook'],
		]) {
			expect(classify(name, value).secret, name).toBe(true);
		}
	});

	it('always reports a reason, so a wrong call is visible before --apply', () => {
		for (const name of ['ECONOMY_MASTER_SECRET_BASE58', 'THREE_TOKEN_MINT']) {
			expect(classify(name).reason).toBeTruthy();
		}
	});
});

describe('secret naming', () => {
	it('matches the shape the existing secrets on this project already use', () => {
		expect(defaultSecretName('X402_FEE_PAYER_SECRET_BASE58')).toBe('x402-fee-payer-secret-base58');
		expect(defaultSecretName('UPSTASH_REDIS_REST_TOKEN')).toBe('upstash-redis-rest-token');
		expect(defaultSecretName('ECONOMY_MASTER_SECRET_BASE58')).toBe('economy-master-secret-base58');
	});
});

// Every gcloud call is a Python process. An unbounded fan-out over the ~50 secrets
// on this project spawned 57 interpreters at once and the machine OOM-killed the
// run, so the bound is not a nicety.
describe('mapLimit', () => {
	it('never runs more than the limit at once', async () => {
		let running = 0;
		let peak = 0;
		await mapLimit([...Array(20).keys()], 4, async () => {
			running++;
			peak = Math.max(peak, running);
			await new Promise((r) => setTimeout(r, 1));
			running--;
		});
		expect(peak).toBeLessThanOrEqual(4);
	});

	it('returns results in input order, not completion order', async () => {
		const out = await mapLimit([30, 1, 20, 2], 4, async (ms) => {
			await new Promise((r) => setTimeout(r, ms));
			return ms;
		});
		expect(out).toEqual([30, 1, 20, 2]);
	});

	it('handles an empty list without spawning a worker', async () => {
		expect(await mapLimit([], 4, async () => 'never')).toEqual([]);
	});
});

describe('urlCarriesCredential', () => {
	it('finds a key in the query string under any spelling', () => {
		for (const v of [
			'https://x.example/?api-key=a',
			'https://x.example/?api_key=a',
			'https://x.example/?apikey=a',
			'https://x.example/?token=a',
			'https://x.example/path?foo=1&secret=a',
			'https://x.example/?ACCESS-KEY=a',
		]) {
			expect(urlCarriesCredential(v), v).toBe(true);
		}
	});

	it('finds a credential in the userinfo, which is how a database URL carries one', () => {
		expect(urlCarriesCredential('postgres://user:pw@host/db')).toBe(true);
	});

	// A path segment that merely looks key-shaped is not a query parameter, and an
	// empty parameter carries nothing.
	it('does not fire on a plain URL', () => {
		for (const v of ['https://x.example/v2/abcdef', 'http://10.128.15.228', 'https://x.example/?key=', '']) {
			expect(urlCarriesCredential(v), JSON.stringify(v)).toBe(false);
		}
	});
});
