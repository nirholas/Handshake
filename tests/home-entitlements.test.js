// Plans, entitlements and quotas for the Home lane.
//
// The first describe block is the one that matters most and it is deliberately
// first in the file: NO COMMERCIAL LIMIT MAY EVER REFUSE A SAFETY ACTION. If a
// future change makes locking a door depend on a plan, that is the block that
// fails, and it fails before anything about pricing is even loaded.
//
// The rest hold the other four commitments: a downgrade pauses and never
// deletes, a counter matches the table an invoice would read, an override raises
// a limit without a deploy, and the gate itself is free on every tier.
//
// The live blocks run against the real database and are skipped, loudly, when
// DATABASE_URL is absent. They are never replaced by a mock: a quota a mock
// "verifies" is a quota nobody verified.

import { afterAll, describe, expect, it } from 'vitest';

import { isSafetyAction, isSafetyMcpCall } from '../packages/home-bridge/src/safety.js';
import {
	assertHomeActionAllowed,
	assertWithinLimit,
	computeEntitlements,
	describeEntitlements,
	HOME_DIMENSION_IDS,
	HOME_DIMENSIONS,
	HomePausedError,
	HomeQuotaError,
	isQuotaExempt,
	limitsForTier,
	planDowngrade,
	quotaPeriod,
	UNLIMITED,
} from '../api/_lib/home/entitlements.js';

/** An account with the tightest limits the platform issues. */
const FREE = { id: 'u-free', account_tier: null, plan: 'free' };

/** Entitlements for a free account with every dimension already exhausted. */
function exhausted() {
	const e = computeEntitlements(FREE);
	const limits = {};
	for (const id of HOME_DIMENSION_IDS) limits[id] = 0;
	return { ...e, limits };
}

// ── Commitment 1: safety is never refused ────────────────────────────────────

describe('a limit never blocks a safety action', () => {
	const SAFE = [
		{ domain: 'lock', service: 'lock' },
		{ domain: 'cover', service: 'close_cover' },
		{ domain: 'alarm_control_panel', service: 'alarm_arm_away' },
		{ domain: 'alarm_control_panel', service: 'alarm_arm_home' },
		{ domain: 'alarm_control_panel', service: 'alarm_arm_night' },
		{ domain: 'valve', service: 'close_valve' },
	];

	it.each(SAFE)('$domain.$service is exempt from every quota', (call) => {
		expect(isSafetyAction(call)).toBe(true);
		expect(isQuotaExempt(call)).toBe(true);
	});

	it.each(SAFE)('$domain.$service passes assertWithinLimit at a limit of zero', (call) => {
		const result = assertWithinLimit({
			entitlements: exhausted(),
			dimension: 'agentTurns',
			used: 9_999,
			call,
		});
		expect(result).toEqual({ allowed: true, exempt: true, remaining: Number.POSITIVE_INFINITY });
	});

	it.each(SAFE)('$domain.$service executes on a home the plan has paused', (call) => {
		const paused = { label: 'Home', deactivated_at: '2026-09-01T00:00:00.000Z', deactivated_reason: 'Plan change.' };
		expect(assertHomeActionAllowed({ home: paused, call })).toEqual({ allowed: true, exempt: true });
	});

	it('the unsafe direction is NOT exempt, or the exemption would be a hole in the gate', () => {
		for (const call of [
			{ domain: 'lock', service: 'unlock' },
			{ domain: 'cover', service: 'open_cover' },
			{ domain: 'alarm_control_panel', service: 'alarm_disarm' },
			{ domain: 'valve', service: 'open_valve' },
		]) {
			expect(isQuotaExempt(call)).toBe(false);
		}
	});

	it('an ordinary action is not a safety action either', () => {
		expect(isQuotaExempt({ domain: 'light', service: 'turn_on' })).toBe(false);
		expect(isQuotaExempt({ domain: 'light', service: 'turn_off' })).toBe(false);
	});

	it('the exemption needs no live socket, so it survives a degraded connection', () => {
		// No `attributes` anywhere: the classification is from the domain and the
		// service alone. The states where somebody most needs to lock up are the
		// states where the entity attributes are not in hand.
		expect(isQuotaExempt({ domain: 'cover', service: 'close_cover' })).toBe(true);
	});

	it('an ordinary action on a paused home IS refused, with an explanation', () => {
		const paused = { label: 'The office', deactivated_at: '2026-09-01T00:00:00.000Z', deactivated_reason: 'Plan change.' };
		let thrown;
		try {
			assertHomeActionAllowed({ home: paused, call: { domain: 'light', service: 'turn_on' } });
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(HomePausedError);
		expect(thrown.message).toContain('The office');
		expect(thrown.message).toContain('Nothing was deleted');
		expect(thrown.message).toContain('Locking up');
		expect(thrown.status).toBe(402);
	});

	it('the MCP channel gets the same exemption, through the same predicate', () => {
		const entities = [
			{ entityId: 'lock.front_door', name: 'Front Door', domain: 'lock', deviceClass: null, areaId: null, attributes: {} },
		];
		expect(isSafetyMcpCall('intent__HassTurnOn', { name: 'Front Door' }, entities)).toBe(true);
		expect(isQuotaExempt({ tool: 'intent__HassTurnOn', arguments: { name: 'Front Door' }, entities })).toBe(true);
		// The polymorphic direction that unlocks is not exempt.
		expect(isQuotaExempt({ tool: 'intent__HassTurnOff', arguments: { name: 'Front Door' }, entities })).toBe(false);
	});

	it('a mixed MCP call is not exempt: it would carry something else through', () => {
		const entities = [
			{ entityId: 'lock.front_door', name: 'Front Door', domain: 'lock', deviceClass: null, areaId: null, attributes: {} },
			{ entityId: 'cover.garage', name: 'Garage', domain: 'cover', deviceClass: 'garage', areaId: null, attributes: { device_class: 'garage' } },
		];
		// HassTurnOn locks the lock (safe) and opens the garage (not safe).
		expect(isQuotaExempt({ tool: 'intent__HassTurnOn', arguments: {}, entities })).toBe(false);
	});
});

// ── Commitment 5: the gate is not a paid feature ─────────────────────────────

describe('nothing about the gate is sold', () => {
	it('no dimension meters confirmations, the audit log, or a role', () => {
		const forbidden = /confirm|audit|gate|role|guard|safety/i;
		for (const id of HOME_DIMENSION_IDS) {
			expect(id, `"${id}" looks like it meters a safety property`).not.toMatch(forbidden);
			expect(HOME_DIMENSIONS[id].label).not.toMatch(/confirmation|audit|role/i);
		}
	});

	it('the free tier gets every dimension the top tier gets, only smaller', () => {
		const free = limitsForTier('user');
		const top = limitsForTier('three-dimensional');
		expect(Object.keys(free).sort()).toEqual(Object.keys(top).sort());
		for (const id of HOME_DIMENSION_IDS) {
			expect(free[id], `free tier has no ${id} at all`).toBeGreaterThan(0);
		}
	});

	it('every dimension carries the measured cost that justifies metering it', () => {
		for (const id of HOME_DIMENSION_IDS) {
			const d = HOME_DIMENSIONS[id];
			expect(typeof d.costPerUnitUsd).toBe('number');
			expect(d.costBasis, `${id} has no stated cost basis`).toBeTruthy();
			expect(d.why, `${id} has no stated reason`).toBeTruthy();
		}
	});
});

// ── Resolution: one entitlement system, not a fourth ─────────────────────────

describe('entitlements resolve from the tier systems that already exist', () => {
	it('a free account gets the floor', () => {
		const e = computeEntitlements(FREE);
		expect(e.tier.id).toBe('user');
		expect(e.limits.homes).toBe(limitsForTier('user').homes);
	});

	it('a Pro subscriber gets Pro limits', () => {
		const e = computeEntitlements({ plan: 'pro' });
		expect(e.limits.homes).toBe(limitsForTier('pro').homes);
		expect(e.limits.agentTurns).toBe(limitsForTier('pro').agentTurns);
	});

	it('badges are merged by MAX, so holding $THREE never costs a Pro their Pro limits', () => {
		// `holder` outranks `pro` on the display ladder. If the resolver took the
		// primary badge's limits, buying some of the coin would DOWNGRADE a paying
		// customer, which is the bug this test exists to prevent.
		const proOnly = computeEntitlements({ plan: 'pro' });
		const proAndHolder = computeEntitlements({ plan: 'pro' }, { holder: { isHolder: true, amount: 1, usd: 1 } });
		expect(proAndHolder.tier.id).toBe('holder');
		expect(proAndHolder.limits.homes).toBeGreaterThanOrEqual(proOnly.limits.homes);
		expect(proAndHolder.limits.agentTurns).toBeGreaterThanOrEqual(proOnly.limits.agentTurns);
	});

	it('the $THREE ladder is read, never re-modelled: its multiplier scales the free quotas', () => {
		const member = computeEntitlements(FREE, { holder: { isHolder: true, amount: 1, usd: 1 } });
		const gold = computeEntitlements(FREE, { holder: { isHolder: true, amount: 1, usd: 600 } });
		expect(member.multiplier).toBe(1);
		expect(gold.multiplier).toBe(5); // three-tier.js Gold, minUsd 500
		expect(gold.limits.agentTurns).toBe(member.limits.agentTurns * 5);
		expect(gold.sources.agentTurns).toBe('holder-multiplier');
	});

	it('the seat count does NOT scale with holding: seats are sold, not held', () => {
		const gold = computeEntitlements(FREE, { holder: { isHolder: true, amount: 1, usd: 600 } });
		expect(gold.limits.members).toBe(limitsForTier('holder').members);
		expect(gold.sources.members).toBe('plan');
	});

	it('the retention ceiling never promises more than the schema will store', () => {
		// home_connections_retention_days_chk caps the stored value at ten years.
		for (const tier of ['user', 'beta', 'pro', 'holder', 'three-dimensional']) {
			expect(limitsForTier(tier).logRetentionDays).toBeLessThanOrEqual(3650);
		}
	});

	it('the free retention ceiling is at least the default, so no existing home is retroactively over it', () => {
		expect(limitsForTier('user').logRetentionDays).toBeGreaterThanOrEqual(90);
	});
});

// ── Enforcement ──────────────────────────────────────────────────────────────

describe('enforcement', () => {
	it('refuses past the limit with a message naming the limit and the way out', () => {
		const e = computeEntitlements(FREE);
		let thrown;
		try {
			assertWithinLimit({ entitlements: e, dimension: 'homes', used: e.limits.homes });
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(HomeQuotaError);
		expect(thrown.status).toBe(402);
		expect(thrown.dimension).toBe('homes');
		expect(thrown.message).toContain('three.ws/pricing');
		expect(thrown.message).toContain('never affected by a limit');
	});

	it('allows right up to the limit', () => {
		const e = computeEntitlements(FREE);
		const r = assertWithinLimit({ entitlements: e, dimension: 'homes', used: e.limits.homes - 1 });
		expect(r.allowed).toBe(true);
		expect(r.remaining).toBe(0);
	});

	it('an unlimited dimension never refuses', () => {
		const e = computeEntitlements({ account_tier: 'three-dimensional' });
		expect(e.limits.homes).toBe(UNLIMITED);
		expect(assertWithinLimit({ entitlements: e, dimension: 'homes', used: 10_000 }).allowed).toBe(true);
	});

	it('an unknown dimension is a programming error, not a silent pass', () => {
		expect(() =>
			assertWithinLimit({ entitlements: computeEntitlements(FREE), dimension: 'nonsense', used: 0 }),
		).toThrow(/unknown dimension/);
	});
});

// ── Commitment 2: the downgrade path ─────────────────────────────────────────

describe('a downgrade pauses and explains, it never disconnects', () => {
	const homes = [
		{ id: 'a', label: 'Home', created_at: '2026-01-01T00:00:00.000Z' },
		{ id: 'b', label: 'The office', created_at: '2026-02-01T00:00:00.000Z' },
		{ id: 'c', label: "Mum's house", created_at: '2026-03-01T00:00:00.000Z' },
	];

	it('names exactly the excess and keeps the oldest', () => {
		const plan = planDowngrade(homes, 1);
		expect(plan.overBy).toBe(2);
		expect(plan.keep.map((h) => h.id)).toEqual(['a']);
		expect(plan.deactivate.map((h) => h.id)).toEqual(['b', 'c']);
	});

	it('explains in words a person can act on, and promises nothing was deleted', () => {
		const plan = planDowngrade(homes, 1);
		expect(plan.explanation).toContain('The office');
		expect(plan.explanation).toContain('nothing was deleted');
		expect(plan.explanation).toContain('swap which homes are active');
		expect(plan.explanation).toContain('safety actions');
	});

	it('does nothing when the account is inside its limit', () => {
		expect(planDowngrade(homes, 5).overBy).toBe(0);
		expect(planDowngrade(homes, 5).deactivate).toEqual([]);
	});

	it('does nothing on an unlimited plan', () => {
		expect(planDowngrade(homes, UNLIMITED).overBy).toBe(0);
	});

	it('never counts an already-paused home against the new limit', () => {
		const withPaused = [...homes, { id: 'd', label: 'Cabin', created_at: '2026-04-01T00:00:00.000Z', deactivated_at: '2026-05-01T00:00:00.000Z' }];
		const plan = planDowngrade(withPaused, 3);
		expect(plan.overBy).toBe(0);
	});
});

// ── Commitment 3: the quota is shown before it is hit ────────────────────────

describe('the manage surface view', () => {
	const usage = { homes: 1, members: 2, streams: 0, voiceMinutes: 42.5, agentTurns: 900, logRetentionDays: 90, relayConnections: 0 };

	it('returns every dimension, not only the ones near their ceiling', () => {
		const view = describeEntitlements(computeEntitlements(FREE), usage);
		expect(view.dimensions.map((d) => d.id).sort()).toEqual([...HOME_DIMENSION_IDS].sort());
	});

	it('carries a real reset date for the monthly dimensions and none for the gauges', () => {
		const now = new Date('2026-09-03T12:00:00.000Z');
		const view = describeEntitlements(computeEntitlements(FREE), usage, { now });
		const turns = view.dimensions.find((d) => d.id === 'agentTurns');
		const homes = view.dimensions.find((d) => d.id === 'homes');
		expect(turns.resetsAt).toBe('2026-10-01T00:00:00.000Z');
		expect(homes.resetsAt).toBeNull();
		expect(view.period.resetsAt).toBe('2026-10-01T00:00:00.000Z');
	});

	it('shows the percentage used before the ceiling is reached', () => {
		const view = describeEntitlements(computeEntitlements(FREE), usage);
		const turns = view.dimensions.find((d) => d.id === 'agentTurns');
		expect(turns.used).toBe(900);
		expect(turns.limit).toBe(1000);
		expect(turns.percent).toBe(90);
		expect(turns.exceeded).toBe(false);
	});

	it('states on the surface itself which actions a limit can never touch', () => {
		const view = describeEntitlements(computeEntitlements(FREE), usage);
		expect(view.alwaysFree.join(' ')).toMatch(/Locking a door/);
		expect(view.alwaysFree.join(' ')).toMatch(/Safety is not an upgrade/);
	});

	it('an unlimited dimension reports null rather than Infinity, which does not survive JSON', () => {
		const view = describeEntitlements(computeEntitlements({ account_tier: 'three-dimensional' }), usage);
		const homes = view.dimensions.find((d) => d.id === 'homes');
		expect(homes.unlimited).toBe(true);
		expect(homes.limit).toBeNull();
		expect(JSON.parse(JSON.stringify(view)).dimensions[0].limit).toBeNull();
	});
});

describe('the quota period', () => {
	it('is the UTC calendar month', () => {
		const p = quotaPeriod(new Date('2026-09-17T23:59:59.000Z'));
		expect(p.startIso).toBe('2026-09-01T00:00:00.000Z');
		expect(p.endIso).toBe('2026-10-01T00:00:00.000Z');
		expect(p.key).toBe('2026-09');
	});

	it('rolls over December correctly', () => {
		const p = quotaPeriod(new Date('2026-12-31T23:00:00.000Z'));
		expect(p.endIso).toBe('2027-01-01T00:00:00.000Z');
	});
});

// ── Commitments 2 and 4, against the real database ───────────────────────────

const LIVE = Boolean(process.env.DATABASE_URL);

describe.skipIf(!LIVE)('entitlements against the real database', () => {
	/** @type {any} */ let sql;
	/** @type {any} */ let ent;
	/** @type {any} */ let usageMod;
	const created = { users: [], homes: [] };

	async function setup() {
		if (sql) return;
		({ sql } = await import('../api/_lib/db.js'));
		ent = await import('../api/_lib/home/entitlements.js');
		usageMod = await import('../api/_lib/home/usage.js');
	}

	async function makeUser(tag, patch = {}) {
		const email = `home-ent-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.invalid`;
		const [row] = await sql`
			insert into users (email, display_name, plan)
			values (${email}, ${'home entitlements test'}, ${patch.plan || 'free'})
			returning id, email, plan, account_tier, wallet_address
		`;
		created.users.push(row.id);
		return row;
	}

	async function makeHome(userId, label) {
		const [row] = await sql`
			insert into home_connections (user_id, label, base_url, access_token_enc, token_fingerprint)
			values (${userId}, ${label}, ${'https://ha-' + Math.random().toString(36).slice(2, 10) + '.test.invalid'},
			        ${'enc'}, ${Math.random().toString(36).slice(2)})
			returning id, label, created_at, deactivated_at
		`;
		created.homes.push(row.id);
		return row;
	}

	afterAll(async () => {
		if (!sql) return;
		for (const id of created.homes) await sql`delete from home_connections where id = ${id}`;
		for (const id of created.users) {
			await sql`delete from usage_events where user_id = ${id}`;
			await sql`delete from home_plan_overrides where user_id = ${id}`;
			await sql`delete from users where id = ${id}`;
		}
	});

	it('an override raises a limit with no code change and no deploy', async () => {
		await setup();
		const user = await makeUser('override');

		const before = await ent.resolveHomeEntitlementsForUser(user.id);
		expect(before.limits.homes).toBe(limitsForTier('user').homes);
		expect(before.sources.homes).toBe('plan');

		await ent.setAccountOverride({
			userId: user.id,
			limits: { homes: 400, logRetentionDays: 730 },
			note: 'Hotel group, 400 rooms, one year of attribution. Agreed on the call.',
		});

		const after = await ent.resolveHomeEntitlementsForUser(user.id);
		expect(after.limits.homes).toBe(400);
		expect(after.limits.logRetentionDays).toBe(730);
		expect(after.sources.homes).toBe('account-override');
		expect(after.override.note).toContain('Hotel group');
		// A dimension the deal did not mention keeps its plan value.
		expect(after.limits.streams).toBe(limitsForTier('user').streams);

		expect(await ent.clearAccountOverride(user.id)).toBe(true);
		const cleared = await ent.resolveHomeEntitlementsForUser(user.id);
		expect(cleared.limits.homes).toBe(limitsForTier('user').homes);
	});

	it('an unknown dimension in an override is dropped, not stored', async () => {
		await setup();
		const user = await makeUser('badkey');
		await ent.setAccountOverride({ userId: user.id, limits: { homes: 9, nonsense: 5 }, note: null });
		const row = await ent.getAccountOverride(user.id);
		expect(row.limits.homes).toBe(9);
		expect(row.limits.nonsense).toBeUndefined();
	});

	it('a downgrade pauses the excess, deletes nothing, and keeps the credential', async () => {
		await setup();
		const user = await makeUser('downgrade');
		const a = await makeHome(user.id, 'Home');
		const b = await makeHome(user.id, 'The office');
		const c = await makeHome(user.id, "Mum's house");

		expect(await ent.countActiveConnections(user.id)).toBe(3);

		const rows = await sql`
			select id, label, created_at, deactivated_at from home_connections where user_id = ${user.id}
		`;
		const plan = ent.planDowngrade(rows, 1);
		expect(plan.deactivate).toHaveLength(2);

		const paused = await ent.applyDowngrade({
			userId: user.id,
			deactivateIds: plan.deactivate.map((h) => h.id),
			reason: 'Plan changed to Free.',
		});
		expect(paused).toHaveLength(2);

		// Nothing deleted, nothing revoked, the credential still there.
		const after = await sql`
			select id, revoked_at, deactivated_at, deactivated_reason, access_token_enc
			from home_connections where user_id = ${user.id} order by created_at
		`;
		expect(after).toHaveLength(3);
		expect(after.every((r) => r.revoked_at === null)).toBe(true);
		expect(after.every((r) => r.access_token_enc === 'enc')).toBe(true);
		expect(after.filter((r) => r.deactivated_at !== null)).toHaveLength(2);
		expect(after.find((r) => r.id === a.id).deactivated_at).toBeNull();
		expect(after.find((r) => r.id === b.id).deactivated_reason).toBe('Plan changed to Free.');

		expect(await ent.countActiveConnections(user.id)).toBe(1);

		// The user picks: swap which one is live. Bringing one back while at the
		// limit is refused, and it succeeds once room is made.
		const free = ent.computeEntitlements({ plan: 'free' });
		const oneHome = { ...free, limits: { ...free.limits, homes: 1 } };
		await expect(
			ent.reactivateConnection({ userId: user.id, homeId: b.id, entitlements: oneHome }),
		).rejects.toBeInstanceOf(HomeQuotaError);

		await ent.applyDowngrade({ userId: user.id, deactivateIds: [a.id], reason: 'Swapped by the user.' });
		const back = await ent.reactivateConnection({ userId: user.id, homeId: b.id, entitlements: oneHome });
		expect(back.deactivated_at).toBeNull();
		expect(await ent.countActiveConnections(user.id)).toBe(1);
		void c;
	});

	it('the agent-turn counter reads the same rows an invoice would', async () => {
		await setup();
		const user = await makeUser('counter');
		const home = await makeHome(user.id, 'Counted');

		// Exactly the row api/chat.js writes for a turn that touched a house.
		for (let i = 0; i < 20; i += 1) {
			await sql`
				insert into usage_events (user_id, kind, tool, provider, model, input_tokens, output_tokens, cost_micro_usd, meta)
				values (${user.id}, ${'chat'}, ${'claude-haiku-4-5'}, ${'anthropic'}, ${'claude-haiku-4-5'},
				        ${6359}, ${250}, ${7609}, ${JSON.stringify({ home_id: home.id, provider: 'anthropic' })}::jsonb)
			`;
		}
		// A conversation about nothing in particular: same kind, no home. Must NOT count.
		for (let i = 0; i < 5; i += 1) {
			await sql`
				insert into usage_events (user_id, kind, tool, meta)
				values (${user.id}, ${'chat'}, ${'claude-haiku-4-5'}, ${JSON.stringify({ provider: 'anthropic' })}::jsonb)
			`;
		}
		// Three voice turns, counted in fractional minutes.
		for (const minutes of [0.5, 0.25, 1.5]) {
			await sql`
				insert into usage_events (user_id, kind, tool, meta)
				values (${user.id}, ${'home.voice'}, ${'home:' + home.id}, ${JSON.stringify({ amount: minutes, dimension: 'voiceMinutes' })}::jsonb)
			`;
		}

		const period = ent.quotaPeriod();
		expect(await usageMod.readUsageFromEvents(user.id, 'agentTurns', period)).toBe(20);
		expect(await usageMod.readUsageFromEvents(user.id, 'voiceMinutes', period)).toBe(2.25);

		// And the same numbers the manage surface shows.
		await usageMod.invalidateUsageCache(user.id, 'agentTurns');
		await usageMod.invalidateUsageCache(user.id, 'voiceMinutes');
		const usage = await usageMod.readHomeUsage(user.id);
		expect(usage.agentTurns).toBe(20);
		expect(usage.voiceMinutes).toBe(2.25);
		expect(usage.homes).toBe(1);
	});

	it('refuses to mint a second counter for agent turns', async () => {
		await setup();
		await expect(
			usageMod.recordHomeUsage({ userId: created.users[0], dimension: 'agentTurns' }),
		).rejects.toThrow(/do not mint a second one/);
	});
});
