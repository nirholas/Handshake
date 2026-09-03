// Pairing a house that only exists on a LAN.
//
// The secret here is deliberately weak: eight characters a person reads off one
// screen and types into another, so about forty bits. Everything below is the
// set of properties that has to hold for that to be safe, and each one is
// tested rather than asserted in a comment:
//
//   * a code redeems into exactly the one home it was minted for
//   * it works once, decided by the database rather than by a process
//   * it expires
//   * wrong guesses are counted and kill it
//   * a stored row yields no live pairing
//
// Two tiers, so `npm test` needs neither a database nor a relay: the pure
// helpers first, then a live round trip that skips itself without DATABASE_URL.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import {
	generatePairingCode,
	hashPairingCode,
	isRelayBaseUrl,
	isRelayConfigured,
	MAX_PAIRING_ATTEMPTS,
	normalizePairingCode,
	PAIRING_TTL_MS,
	relayBaseUrl,
} from '../api/_lib/home/relay.js';

describe('the code itself', () => {
	it('avoids the characters people mistype into each other', () => {
		const alphabet = new Set();
		for (let i = 0; i < 2000; i += 1) for (const ch of generatePairingCode().replace('-', '')) alphabet.add(ch);
		// I, L, O and U are the four that get read wrong off a screen.
		for (const banned of ['I', 'L', 'O', 'U']) expect([...alphabet]).not.toContain(banned);
		expect(alphabet.size).toBeGreaterThan(24);
	});

	it('is grouped for reading aloud and normalizes back to one form', () => {
		const code = generatePairingCode();
		expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
		const raw = code.replace('-', '');
		for (const variant of [code, raw, code.toLowerCase(), ` ${code} `, raw.split('').join(' ')]) {
			expect(normalizePairingCode(variant)).toBe(raw);
		}
	});

	it('is stored as a digest, so reading the table yields no live pairing', () => {
		const code = generatePairingCode();
		const digest = hashPairingCode(code);
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
		expect(digest).not.toContain(normalizePairingCode(code));
		expect(hashPairingCode(code.toLowerCase())).toBe(digest);
		expect(hashPairingCode(generatePairingCode())).not.toBe(digest);
	});

	it('does not collide in any run a person could ever produce', () => {
		const codes = new Set(Array.from({ length: 20_000 }, () => generatePairingCode()));
		expect(codes.size).toBeGreaterThan(19_990);
	});

	it('expires inside the span of one sitting', () => {
		expect(PAIRING_TTL_MS).toBeLessThanOrEqual(15 * 60 * 1000);
		expect(MAX_PAIRING_ATTEMPTS).toBeLessThanOrEqual(10);
	});
});

describe('a relayed home has no address of ours to dial', () => {
	it('records the relay id as its base url, honestly and uniquely', () => {
		expect(relayBaseUrl('hr_abc')).toBe('relay://hr_abc');
		expect(isRelayBaseUrl(relayBaseUrl('hr_abc'))).toBe(true);
		expect(isRelayBaseUrl('https://home.example.com')).toBe(false);
		expect(isRelayBaseUrl(null)).toBe(false);
	});
});

describe('a deployment with no relay', () => {
	it('says so rather than minting a code nobody could redeem', () => {
		const saved = { ...process.env };
		delete process.env.HOME_RELAY_URL;
		delete process.env.HOME_RELAY_SERVICE_TOKEN;
		delete process.env.HOME_RELAY_SIGNING_KEY;
		expect(isRelayConfigured()).toBe(false);
		process.env.HOME_RELAY_URL = 'wss://relay.example';
		process.env.HOME_RELAY_SERVICE_TOKEN = 'short';
		process.env.HOME_RELAY_SIGNING_KEY = 'k'.repeat(48);
		// A short token is not a configured relay: it would fail at the first
		// connect, which is the worst possible place to discover it.
		expect(isRelayConfigured()).toBe(false);
		process.env.HOME_RELAY_SERVICE_TOKEN = 't'.repeat(48);
		expect(isRelayConfigured()).toBe(true);
		Object.assign(process.env, saved);
	});
});

// ── the live round trip ──────────────────────────────────────────────────────

const hasDb = Boolean(process.env.DATABASE_URL);
const liveDb = describe.skipIf(!hasDb);

liveDb('the pairing lifecycle, against a real database', () => {
	let sql;
	let owner;
	let stranger;
	let relay;
	const saved = {};

	beforeAll(async () => {
		for (const key of ['HOME_RELAY_URL', 'HOME_RELAY_SERVICE_TOKEN', 'HOME_RELAY_SIGNING_KEY']) saved[key] = process.env[key];
		process.env.HOME_RELAY_URL = process.env.HOME_RELAY_URL || 'ws://127.0.0.1:9';
		process.env.HOME_RELAY_SERVICE_TOKEN = process.env.HOME_RELAY_SERVICE_TOKEN || 't'.repeat(48);
		process.env.HOME_RELAY_SIGNING_KEY = process.env.HOME_RELAY_SIGNING_KEY || 'k'.repeat(48);
		({ sql } = await import('../api/_lib/db.js'));
		relay = await import('../api/_lib/home/relay.js');
		const stamp = Date.now();
		[owner] = await sql`insert into users (email) values (${`home-relay-owner-${stamp}@qa.three.ws`}) returning id`;
		[stranger] = await sql`insert into users (email) values (${`home-relay-stranger-${stamp}@qa.three.ws`}) returning id`;
	}, 60_000);

	afterAll(async () => {
		if (sql && owner) await sql`delete from users where id in (${owner.id}, ${stranger.id})`;
		Object.assign(process.env, saved);
	});

	it('creates a home with a relay id and no credential at all', async () => {
		const { home, code, expiresAt } = await relay.startPairing({ userId: owner.id, label: 'LAN house' });
		expect(home.transport).toBe('relay');
		expect(home.relay_id).toMatch(/^hr_/);
		expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

		const [row] = await sql`select access_token_enc, token_fingerprint from home_connections where id = ${home.id}`;
		expect(row.access_token_enc).toBe('');
		expect(row.token_fingerprint).toBe('');
		expect(normalizePairingCode(code)).toHaveLength(8);
	});

	it('redeems once and refuses the second attempt', async () => {
		const { home, code } = await relay.startPairing({ userId: owner.id, label: 'Reuse' });
		const first = await relay.redeemPairing({ code, protocol: 1, agent: { name: 'test', version: '1' } });
		expect(first.relayId).toBe(home.relay_id);
		expect(first.installToken).toMatch(/^hr1\./);
		await expect(relay.redeemPairing({ code, protocol: 1 })).rejects.toMatchObject({ code: 'already_redeemed', status: 409 });
	});

	it('refuses a code that expired', async () => {
		const { home, code } = await relay.startPairing({ userId: owner.id, label: 'Expiry' });
		await sql`update home_relay_pairings set expires_at = now() - interval '1 minute' where home_id = ${home.id}`;
		await expect(relay.redeemPairing({ code, protocol: 1 })).rejects.toMatchObject({ code: 'expired', status: 410 });
	});

	it('refuses a code that was never issued, without saying whether one exists', async () => {
		await expect(relay.redeemPairing({ code: 'ZZZZ-ZZZZ', protocol: 1 })).rejects.toMatchObject({ code: 'unknown_code', status: 404 });
		await expect(relay.redeemPairing({ code: 'nope', protocol: 1 })).rejects.toMatchObject({ code: 'unknown_code', status: 404 });
	});

	it('kills a code after enough wrong guesses', async () => {
		const { home, code } = await relay.startPairing({ userId: owner.id, label: 'Guessing' });
		for (let i = 0; i < MAX_PAIRING_ATTEMPTS; i += 1) {
			await sql`update home_relay_pairings set attempts = attempts + 1 where home_id = ${home.id}`;
		}
		await expect(relay.redeemPairing({ code, protocol: 1 })).rejects.toMatchObject({ code: 'too_many_attempts', status: 429 });
	});

	it('refuses an integration older than the protocol, and names the upgrade', async () => {
		const { code } = await relay.startPairing({ userId: owner.id, label: 'Old' });
		await expect(relay.redeemPairing({ code, protocol: 0 })).rejects.toMatchObject({ code: 'protocol_too_old', status: 426 });
	});

	it('gives one home exactly one live code: refreshing retires the old one', async () => {
		const { home, code: first } = await relay.startPairing({ userId: owner.id, label: 'Refresh' });
		const { code: second } = await relay.refreshPairing({ homeId: home.id, userId: owner.id });
		expect(second).not.toBe(first);
		// The old code must be dead, or refreshing would leave a second, invisible
		// way into the same house.
		await expect(relay.redeemPairing({ code: first, protocol: 1 })).rejects.toMatchObject({ code: 'unknown_code' });
		const redeemed = await relay.redeemPairing({ code: second, protocol: 1 });
		expect(redeemed.relayId).toBe(home.relay_id);
	});

	it('will not let a stranger refresh someone else\'s pairing', async () => {
		const { home } = await relay.startPairing({ userId: owner.id, label: 'Not yours' });
		await expect(relay.refreshPairing({ homeId: home.id, userId: stranger.id })).rejects.toMatchObject({ status: 404 });
	});

	it('mints a token that only ever names the home it was minted for', async () => {
		const a = await relay.startPairing({ userId: owner.id, label: 'A' });
		const b = await relay.startPairing({ userId: stranger.id, label: 'B' });
		const redeemedA = await relay.redeemPairing({ code: a.code, protocol: 1 });
		const { verifyInstallToken } = await import('../services/home-relay/src/token.js');
		const claims = verifyInstallToken(redeemedA.installToken, process.env.HOME_RELAY_SIGNING_KEY).claims;
		expect(claims.relayId).toBe(a.home.relay_id);
		expect(claims.homeId).toBe(a.home.id);
		expect(claims.userId).toBe(owner.id);
		expect(claims.relayId).not.toBe(b.home.relay_id);
	});

	it('prunes pairings that can never be redeemed again', async () => {
		const { home } = await relay.startPairing({ userId: owner.id, label: 'Prunable' });
		await sql`update home_relay_pairings set expires_at = now() - interval '48 hours' where home_id = ${home.id}`;
		const { pruned } = await relay.prunePairings({ olderThanHours: 24 });
		expect(pruned).toBeGreaterThan(0);
		const left = await sql`select id from home_relay_pairings where home_id = ${home.id}`;
		expect(left).toHaveLength(0);
	});
});
