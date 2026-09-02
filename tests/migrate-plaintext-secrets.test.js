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
import { classify, defaultSecretName } from '../scripts/migrate-plaintext-secrets.mjs';

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

	it('flags a provider URL for a human call instead of filing it as public config', () => {
		for (const name of ['SOLANA_RPC_URL', 'UPSTASH_REDIS_REST_URL', 'HELIUS_RPC_ENDPOINT']) {
			const verdict = classify(name);
			expect(verdict.secret, name).toBe(false);
			expect(verdict.review, name).toBe(true);
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
