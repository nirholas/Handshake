// The connection store, at the layer where a mistake costs somebody their front
// door.
//
// Three tiers, so the default `npm test` needs no database and no house:
//
//   1. Pure guards. The store's refusals happen before any query runs, so they
//      are testable with nothing plugged in.
//   2. Grant scoping over the recorded instance
//      (packages/home-bridge/tests/fixtures/home.json). A grant is per entity,
//      and the proof that it stays per entity belongs next to the real entity
//      ids it has to discriminate between.
//   3. The live round trip. Skips itself unless pointed at a real database, and
//      the last block also wants a real Home Assistant:
//
//        DATABASE_URL=...            npx vitest run tests/home-store.test.js
//        HOME_ASSISTANT_URL=http://localhost:8123 HOME_ASSISTANT_TOKEN=... \
//        DATABASE_URL=... WALLET_ENCRYPTION_KEY=... npx vitest run tests/home-store.test.js
//
//      The live tier writes throwaway users into whatever database it is given
//      and deletes them again, the same posture as the package's live-home suite
//      changing real state in a real house.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { classifyCall, createAllowList, HomeBridge } from '@three-ws/home-bridge';

import {
	createConnection,
	fingerprintToken,
	getConnection,
	getDecryptedToken,
	grantEntity,
	HOME_STATUS,
	listAllowedEntities,
	listConnections,
	listGrants,
	listHomeActions,
	logHomeActionNow,
	recordHandshake,
	revokeConnection,
	revokeGrant,
} from '../api/_lib/home/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
	readFileSync(path.join(HERE, '..', 'packages/home-bridge/tests/fixtures/home.json'), 'utf8'),
);

const A_UUID = '00000000-0000-4000-8000-0000000000aa';
const NOT_A_UUID = 'lock.front_door';

describe('the guards that run before any query does', () => {
	it('refuses a domain-wide grant outright', async () => {
		// The whole reason home_entity_grants has no granted_domain column: letting
		// the agent open the office door is not letting it open the front door.
		await expect(grantEntity({ homeId: A_UUID, entityId: 'lock', grantedBy: A_UUID })).rejects.toThrow(/never per domain/);
		await expect(grantEntity({ homeId: A_UUID, entityId: 'lock.*', grantedBy: A_UUID })).rejects.toThrow(/never per domain/);
		await expect(grantEntity({ homeId: A_UUID, entityId: '', grantedBy: A_UUID })).rejects.toThrow();
	});

	it('treats a malformed id as a miss rather than a query', async () => {
		expect(await getConnection(NOT_A_UUID, A_UUID)).toBeNull();
		expect(await getDecryptedToken(NOT_A_UUID, A_UUID)).toBeNull();
		expect(await listGrants(NOT_A_UUID)).toEqual([]);
		expect(await listHomeActions(NOT_A_UUID)).toEqual([]);
		expect(await listConnections('')).toEqual([]);
	});

	it('never answers a read without an owner', async () => {
		expect(await getConnection(A_UUID, '')).toBeNull();
		expect(await getDecryptedToken(A_UUID, null)).toBeNull();
		expect(await revokeConnection(A_UUID, undefined)).toEqual({ revoked: false, alreadyRevoked: false, home: null });
	});

	it('fingerprints a token without being able to give it back', () => {
		const fp = fingerprintToken('a-home-assistant-long-lived-token');
		expect(fp).toMatch(/^[0-9a-f]{64}$/);
		expect(fp).toBe(fingerprintToken('a-home-assistant-long-lived-token'));
		expect(fp).not.toBe(fingerprintToken('a-home-assistant-long-lived-tokem'));
	});
});

describe('grant scoping, over the recorded instance', () => {
	// The fixture is a recording of a real house, so these are the real ids the
	// gate has to tell apart, not names invented to make a test pass.
	const locks = Object.keys(fixture.states).filter((id) => id.startsWith('lock.'));

	it('the recording really does have more than one lock to confuse', () => {
		expect(locks).toContain('lock.front_door');
		expect(locks).toContain('lock.kitchen_door');
	});

	it('a grant for one lock leaves every other lock guarded', () => {
		const allow = createAllowList(['lock.kitchen_door']);
		expect(allow.has('lock.kitchen_door')).toBe(true);
		for (const other of locks.filter((id) => id !== 'lock.kitchen_door')) {
			expect(allow.has(other)).toBe(false);
		}
		expect(classifyCall({ domain: 'lock', service: 'unlock', entityId: 'lock.front_door' }).guarded).toBe(true);
	});

	it('locking up is never guarded, so it never needs a grant', () => {
		expect(classifyCall({ domain: 'lock', service: 'lock', entityId: 'lock.front_door' }).guarded).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// The live tier.
// ---------------------------------------------------------------------------

const hasDb = Boolean(process.env.DATABASE_URL);
const hasKey = Boolean(process.env.WALLET_ENCRYPTION_KEY || process.env.JWT_SECRET);
const haUrl = process.env.HOME_ASSISTANT_URL;
const haToken = process.env.HOME_ASSISTANT_TOKEN;

const liveDb = describe.skipIf(!hasDb || !hasKey);
const liveHome = describe.skipIf(!hasDb || !hasKey || !haUrl || !haToken);

// A token shaped like the real thing but belonging to nothing: the DB-only tier
// proves the credential path without needing a house to point it at.
const SYNTHETIC_TOKEN = `synthetic.home.assistant.token.${'a'.repeat(64)}`;
const BASE_URL = haUrl || 'https://home.invalid.three.ws';

liveDb('against a real database', () => {
	/** @type {import('@neondatabase/serverless').NeonQueryFunction} */
	let sql;
	let owner;
	let stranger;
	let home;

	beforeAll(async () => {
		({ sql } = await import('../api/_lib/db.js'));
		const stamp = Date.now();
		[owner] = await sql`insert into users (email) values (${`home-store-owner-${stamp}@qa.three.ws`}) returning id`;
		[stranger] = await sql`insert into users (email) values (${`home-store-stranger-${stamp}@qa.three.ws`}) returning id`;
		home = await createConnection({
			userId: owner.id,
			label: '  The office  ',
			baseUrl: `${BASE_URL}/`,
			token: haToken || SYNTHETIC_TOKEN,
		});
	}, 60_000);

	afterAll(async () => {
		if (sql && owner) await sql`delete from users where id in (${owner.id}, ${stranger.id})`;
	});

	it('stores the normalized URL and a trimmed label, never the raw input', () => {
		// The trailing slash the user typed is gone, so the unique index below is
		// over one spelling of the house rather than three.
		expect(home.base_url).toBe(BASE_URL);
		expect(home.label).toBe('The office');
	});

	it('returns a row with no credential on it', () => {
		expect(home).not.toHaveProperty('access_token_enc');
		expect(JSON.stringify(home)).not.toContain(haToken || SYNTHETIC_TOKEN);
	});

	it('encrypts the credential at rest', async () => {
		const [row] = await sql`select access_token_enc from home_connections where id = ${home.id}`;
		expect(row.access_token_enc.startsWith('v2:')).toBe(true);
		expect(row.access_token_enc).not.toContain(haToken || SYNTHETIC_TOKEN);
	});

	it('re-connecting the same house updates the row instead of stacking a second one', async () => {
		const again = await createConnection({
			userId: owner.id, label: 'The office', baseUrl: BASE_URL, token: haToken || SYNTHETIC_TOKEN,
		});
		expect(again.id).toBe(home.id);
		expect(again.token_fingerprint).toBe(home.token_fingerprint);
		expect(await listConnections(owner.id)).toHaveLength(1);
	});

	it('a rotated token lands on the same row with a new fingerprint', async () => {
		const rotated = await createConnection({
			userId: owner.id, label: 'The office', baseUrl: BASE_URL, token: `${SYNTHETIC_TOKEN}-rotated`,
		});
		expect(rotated.id).toBe(home.id);
		expect(rotated.token_fingerprint).not.toBe(home.token_fingerprint);
		// Put the working credential back for the tests that follow.
		await createConnection({ userId: owner.id, label: 'The office', baseUrl: BASE_URL, token: haToken || SYNTHETIC_TOKEN });
	});

	it('never shows one user another user\'s home', async () => {
		expect(await listConnections(stranger.id)).toEqual([]);
		expect(await getConnection(home.id, stranger.id)).toBeNull();
		expect(await getDecryptedToken(home.id, stranger.id)).toBeNull();
		expect((await getConnection(home.id, owner.id))?.id).toBe(home.id);
	});

	it('gives the owner back exactly the token they connected with', async () => {
		const cred = await getDecryptedToken(home.id, owner.id);
		expect(cred.token).toBe(haToken || SYNTHETIC_TOKEN);
		expect(cred.baseUrl).toBe(BASE_URL);
	});

	it('merges measured capabilities rather than replacing them', async () => {
		const first = await recordHandshake(home.id, {
			status: HOME_STATUS.CONNECTED,
			capabilities: { websocket: true, entityCount: 120, haVersion: '2026.9.0' },
		});
		expect(first.last_ok_at).toBeTruthy();
		const second = await recordHandshake(home.id, { status: HOME_STATUS.CONNECTED, capabilities: { mcp: false } });
		expect(second.capabilities.entityCount).toBe(120);
		expect(second.capabilities.mcp).toBe(false);
	});

	it('stamps last_error_at, not last_ok_at, on a failed handshake', async () => {
		const failed = await recordHandshake(home.id, {
			status: HOME_STATUS.AUTH_FAILED, statusDetail: 'Home Assistant rejected that token.',
		});
		expect(failed.last_error_at).toBeTruthy();
		expect(failed.status_detail).toMatch(/rejected/);
		await recordHandshake(home.id, { status: HOME_STATUS.CONNECTED });
	});

	it('grants one entity without clearing any other', async () => {
		await grantEntity({ homeId: home.id, entityId: 'lock.office_door', grantedBy: owner.id });
		const allow = createAllowList(await listAllowedEntities(home.id));
		expect(allow.has('lock.office_door')).toBe(true);
		expect(allow.has('lock.front_door')).toBe(false);
	});

	it('filters an expired grant in SQL, not in the caller', async () => {
		await sql`
			insert into home_entity_grants (home_id, entity_id, granted_by, expires_at)
			values (${home.id}, 'lock.expired_door', ${owner.id}, now() - interval '1 hour')
		`;
		const [{ n }] = await sql`select count(*)::int as n from home_entity_grants where home_id = ${home.id}`;
		const live = await listGrants(home.id);
		expect(n).toBeGreaterThan(live.length);
		expect(live.map((g) => g.entity_id)).not.toContain('lock.expired_door');
	});

	it('revokes a grant idempotently', async () => {
		expect(await revokeGrant({ homeId: home.id, entityId: 'lock.office_door' })).toBe(true);
		expect(await revokeGrant({ homeId: home.id, entityId: 'lock.office_door' })).toBe(false);
	});

	it('records what the platform did in the house, with resolved targets', async () => {
		expect(await logHomeActionNow({
			homeId: home.id, userId: owner.id, actor: 'user', channel: 'websocket',
			action: 'lock.unlock', entityIds: ['lock.kitchen_door'], guarded: true,
			confirmedBy: owner.id, risk: 'security', outcome: 'ok', detail: { via: 'store test' },
		})).toBe(true);
		const [entry] = await listHomeActions(home.id);
		expect(entry.entity_ids).toEqual(['lock.kitchen_door']);
		expect(entry.guarded).toBe(true);
		expect(entry.risk).toBe('security');
	});

	it('refuses an actor the schema does not recognize', async () => {
		await expect(sql`
			insert into home_action_log (home_id, actor, channel, action, outcome)
			values (${home.id}, 'burglar', 'websocket', 'lock.unlock', 'ok')
		`).rejects.toThrow();
	});

	it('refuses a relay row with nothing to route through', async () => {
		await expect(sql`
			insert into home_connections (user_id, label, base_url, access_token_enc, token_fingerprint, transport)
			values (${stranger.id}, 'unroutable', 'https://relay.invalid', 'x', 'y', 'relay')
		`).rejects.toThrow();
	});

	it('revokes twice, destroying the credential and keeping the lineage', async () => {
		const first = await revokeConnection(home.id, owner.id);
		expect(first.revoked).toBe(true);
		const second = await revokeConnection(home.id, owner.id);
		expect(second).toMatchObject({ revoked: false, alreadyRevoked: true });

		const [row] = await sql`select access_token_enc, revoked_at, status from home_connections where id = ${home.id}`;
		expect(row.access_token_enc).toBe('');
		expect(row.revoked_at).toBeTruthy();
		expect(row.status).toBe(HOME_STATUS.REVOKED);

		expect(await getDecryptedToken(home.id, owner.id)).toBeNull();
		expect(await listConnections(owner.id)).toEqual([]);
		expect(await listHomeActions(home.id)).toHaveLength(1);
	});

	it('does not let a stranger revoke a home they cannot see', async () => {
		expect(await revokeConnection(home.id, stranger.id)).toMatchObject({ revoked: false, alreadyRevoked: false });
	});

	it('lets the same house be connected again after a revoke', async () => {
		const fresh = await createConnection({
			userId: owner.id, label: 'Home again', baseUrl: BASE_URL, token: haToken || SYNTHETIC_TOKEN,
		});
		expect(fresh.id).not.toBe(home.id);
		expect(await listConnections(owner.id)).toHaveLength(1);
	});
});

liveHome('the stored credential against a real Home Assistant', () => {
	let sql;
	let owner;
	let home;
	/** @type {HomeBridge} */
	let bridge;

	beforeAll(async () => {
		({ sql } = await import('../api/_lib/db.js'));
		[owner] = await sql`insert into users (email) values (${`home-store-live-${Date.now()}@qa.three.ws`}) returning id`;
		home = await createConnection({ userId: owner.id, label: 'Live', baseUrl: haUrl, token: haToken });
	}, 60_000);

	afterAll(async () => {
		bridge?.close();
		if (sql && owner) await sql`delete from users where id = ${owner.id}`;
	});

	it('opens a real socket with the credential it read back out of the database', async () => {
		const cred = await getDecryptedToken(home.id, owner.id);
		bridge = new HomeBridge({ baseUrl: cred.baseUrl, token: cred.token });
		const graph = await bridge.connect();
		expect(bridge.connected).toBe(true);
		expect(Object.keys(bridge.states).length).toBeGreaterThan(0);
		expect(graph.rooms.length + graph.unassigned.length).toBeGreaterThan(0);
	}, 60_000);

	it('measures the house rather than assuming it, and stores what it measured', async () => {
		const { verifyConnection } = await import('../api/_lib/home/verify.js');
		const { capabilities } = await verifyConnection({ baseUrl: haUrl, token: haToken });
		const config = await (await fetch(`${haUrl}/api/config`, { headers: { authorization: `Bearer ${haToken}` } })).json();
		expect(capabilities.websocket).toBe(true);
		expect(capabilities.haVersion).toBe(config.version);
		expect(capabilities.entityCount).toBe(Object.keys(bridge.states).length);

		const stored = await recordHandshake(home.id, { status: HOME_STATUS.CONNECTED, capabilities });
		expect(stored.capabilities.haVersion).toBe(config.version);
		expect(stored.status).toBe(HOME_STATUS.CONNECTED);
	}, 60_000);

	it('a granted lock passes the gate and an ungranted one still does not', async () => {
		await grantEntity({ homeId: home.id, entityId: 'lock.kitchen_door', grantedBy: owner.id });
		const gated = new HomeBridge({
			baseUrl: haUrl, token: haToken, allowedEntities: await listAllowedEntities(home.id),
		});
		try {
			await gated.connect();
			await gated.call('lock', 'unlock', { entity_id: 'lock.kitchen_door' });
			await expect(gated.call('lock', 'unlock', { entity_id: 'lock.front_door' })).rejects.toMatchObject({
				code: 'needs_confirmation',
			});
			expect(bridge.states['lock.front_door'].state).toBe('locked');
		} finally {
			gated.close();
		}
	}, 60_000);
});
