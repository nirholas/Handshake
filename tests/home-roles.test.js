// The household role matrix, asserted cell by cell against a real database.
//
// Order 12's role table is a product decision with a physical actuator on the
// other end of it, so it is not documented in a comment and hoped for: every
// cell in it is executed here, at the enforcement boundary the product calls,
// with real rows in real tables.
//
// What "enforcement boundary" means concretely: nothing in these tests asks a
// role question of a UI, a fixture or a stub. `requireMembership` is the call
// every surface makes (the store's reads, the runtime's acquire, the graph
// projection, the physical-action gate, the confirm endpoint, the grant, layout,
// invite and disconnect writers, and the chat and MCP tools acting for a bearer
// principal), so the matrix is asserted through it once and the surfaces above
// inherit it.
//
// The row that matters most, and the reason this file exists:
//
//   a guest is REFUSED a confirmation, with a reason naming their role,
//   rather than being shown a confirmation prompt they could say yes to.
//
// Requires DATABASE_URL. Every row it writes is prefixed and deleted afterwards,
// and the same prefix is swept before the run so a crashed previous run cannot
// leave anything behind.

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import '../tests/setup.env.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const d = HAS_DB ? describe : describe.skip;

// Every row this suite writes is namespaced to THIS run, not to the file.
//
// A constant prefix looked tidy and was a landmine: this workspace runs many
// agents, several of them with a vitest of their own in flight, and two
// overlapping runs of this file deleted each other's users and homes mid-test.
// The symptom is a wall of foreign-key violations on `sessions` and
// `home_invites` that reads like broken RBAC and is nothing of the kind.
const FAMILY = 'home-roles-test';
const PREFIX = `${FAMILY}-${randomUUID().slice(0, 8)}`;
const email = (who) => `${PREFIX}+${who}@example.invalid`;
/** Rows from a run that crashed before its own cleanup. Old enough that no live run owns them. */
const STALE_AFTER = '1 hour';

/** The order 12 table, transcribed. Rows are roles, columns are capabilities. */
const EXPECTED = {
	owner: { read: true, act: true, confirm: true, grant: true, layout: true, invite: true, manage: true, disconnect: true },
	admin: { read: true, act: true, confirm: true, grant: true, layout: true, invite: true, manage: true, disconnect: false },
	member: { read: true, act: true, confirm: true, grant: false, layout: true, invite: false, manage: false, disconnect: false },
	guest: { read: true, act: true, confirm: false, grant: false, layout: false, invite: false, manage: false, disconnect: false },
	viewer: { read: true, act: false, confirm: false, grant: false, layout: false, invite: false, manage: false, disconnect: false },
};

/** Roles whose reads and actions are narrowed by entity_scope. */
const SCOPED = new Set(['guest', 'viewer']);

let sql;
let members;
let store;
let users = {};
let homeId;
let otherHomeId;

async function makeUser(who) {
	const [row] = await sql`
		INSERT INTO users (email, display_name)
		VALUES (${email(who)}, ${`${PREFIX} ${who}`})
		RETURNING id
	`;
	return row.id;
}

async function sweep() {
	await sql`DELETE FROM home_connections WHERE label LIKE ${`${PREFIX}%`}`;
	// Sessions and audit rows are keyed on the user rather than the home, so they
	// do not follow the connection's cascade and have to be named here. Without
	// this the suite leaves a session behind on every run.
	await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${`${PREFIX}+%`})`;
	await sql`DELETE FROM audit_log WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${`${PREFIX}+%`})`;
	await sql`DELETE FROM users WHERE email LIKE ${`${PREFIX}+%`}`;
}

/**
 * Rows left by a run that died before its own cleanup, from any prefix in this
 * family. Bounded by age so it can never touch a run happening right now, which
 * is the whole reason the per-run prefix exists.
 */
async function sweepStale() {
	await sql`
		DELETE FROM home_connections
		WHERE label LIKE ${`${FAMILY}-%`} AND created_at < now() - ${STALE_AFTER}::interval
	`;
	await sql`
		DELETE FROM sessions
		WHERE user_id IN (
			SELECT id FROM users
			WHERE email LIKE ${`${FAMILY}-%`} AND created_at < now() - ${STALE_AFTER}::interval
		)
	`;
	await sql`
		DELETE FROM audit_log
		WHERE user_id IN (
			SELECT id FROM users
			WHERE email LIKE ${`${FAMILY}-%`} AND created_at < now() - ${STALE_AFTER}::interval
		)
	`;
	await sql`
		DELETE FROM users
		WHERE email LIKE ${`${FAMILY}-%`} AND created_at < now() - ${STALE_AFTER}::interval
	`;
}

beforeAll(async () => {
	if (!HAS_DB) return;
	({ sql } = await import('../api/_lib/db.js'));
	members = await import('../api/_lib/home/members.js');
	store = await import('../api/_lib/home/store.js');

	await sweepStale();
	await sweep();

	for (const who of ['owner', 'admin', 'member', 'guest', 'viewer', 'stranger', 'second']) {
		users[who] = await makeUser(who);
	}

	// Two homes: the one under test, and a second one owned by a stranger, so
	// "this member cannot see that home" is asserted against a real other house
	// rather than a made-up id.
	const [home] = await sql`
		INSERT INTO home_connections (user_id, label, base_url, access_token_enc, token_fingerprint, status)
		VALUES (${users.owner}, ${`${PREFIX} house`}, ${`https://${PREFIX}-1.invalid`}, '', ${`${PREFIX}-1`}, 'connected')
		RETURNING id
	`;
	homeId = home.id;

	const [other] = await sql`
		INSERT INTO home_connections (user_id, label, base_url, access_token_enc, token_fingerprint, status)
		VALUES (${users.stranger}, ${`${PREFIX} other house`}, ${`https://${PREFIX}-2.invalid`}, '', ${`${PREFIX}-2`}, 'connected')
		RETURNING id
	`;
	otherHomeId = other.id;

	// The owner row is not inserted here on purpose: the migration's trigger owns
	// it, and the first assertion below is that the trigger did its job.
	for (const role of ['admin', 'member']) {
		await sql`INSERT INTO home_members (home_id, user_id, role, invited_by) VALUES (${homeId}, ${users[role]}, ${role}, ${users.owner})`;
	}
	for (const role of ['guest', 'viewer']) {
		await sql`
			INSERT INTO home_members (home_id, user_id, role, entity_scope, invited_by)
			VALUES (${homeId}, ${users[role]}, ${role}, ${'{"mode":"allow","areas":["kitchen"],"entities":["light.hall_lamp"]}'}::jsonb, ${users.owner})
		`;
	}
}, 120_000);

afterAll(async () => {
	if (!HAS_DB) return;
	await sweep();
});

d('home_members: the backfill and the ownership invariant', () => {
	it('gives every connection exactly one owner row, created by the database', async () => {
		const [row] = await sql`SELECT user_id, role FROM home_members WHERE home_id = ${homeId} AND role = 'owner'`;
		expect(row).toBeTruthy();
		expect(row.user_id).toBe(users.owner);

		const [{ owners }] = await sql`SELECT count(*)::int AS owners FROM home_members WHERE home_id = ${homeId} AND role = 'owner'`;
		expect(owners).toBe(1);
	});

	it('holds the one-owner-per-home invariant against a second owner insert', async () => {
		await expect(
			sql`INSERT INTO home_members (home_id, user_id, role) VALUES (${homeId}, ${users.second}, 'owner')`,
		).rejects.toMatchObject({ code: '23505' });
	});

	it('leaves no connection in the database without an owner row', async () => {
		const [{ orphans }] = await sql`
			SELECT count(*)::int AS orphans
			FROM home_connections c
			WHERE NOT EXISTS (SELECT 1 FROM home_members m WHERE m.home_id = c.id AND m.role = 'owner')
		`;
		expect(orphans).toBe(0);
	});
});

d('the role matrix, every cell, at the enforcement boundary', () => {
	for (const [role, expected] of Object.entries(EXPECTED)) {
		for (const [capability, allowed] of Object.entries(expected)) {
			it(`${role} ${allowed ? 'may' : 'may NOT'} ${capability}`, async () => {
				const gate = await members.requireMembership(homeId, users[role], capability);
				expect(gate.ok).toBe(allowed);
				if (!allowed) {
					// A member who lacks a capability is told so, and told which role
					// they hold. 403 and not 404: they are in the household, and
					// pretending the house does not exist would be a worse answer.
					expect(gate.status).toBe(403);
					expect(gate.code).toBe('role_forbidden');
					expect(gate.reason).toContain(role);
					expect(gate.reason).toContain(capability);
				} else {
					expect(gate.role).toBe(role);
				}
			});
		}
	}

	it('marks exactly the scoped roles as scoped', async () => {
		for (const role of Object.keys(EXPECTED)) {
			const gate = await members.requireMembership(homeId, users[role], 'read');
			expect(gate.membership.scoped).toBe(SCOPED.has(role));
			if (!SCOPED.has(role)) expect(gate.membership.scope).toEqual({ mode: 'all' });
		}
	});

	it('refuses every capability to a non-member with 404, never 403', async () => {
		for (const capability of members.HOME_CAPABILITIES) {
			const gate = await members.requireMembership(homeId, users.stranger, capability);
			expect(gate.ok).toBe(false);
			expect(gate.status).toBe(404);
			expect(gate.code).toBe('home_not_found');
			expect(gate.reason).not.toContain('role');
		}
	});

	it('refuses a member of one home every capability on another home, with 404', async () => {
		for (const capability of members.HOME_CAPABILITIES) {
			const gate = await members.requireMembership(otherHomeId, users.member, capability);
			expect(gate.status).toBe(404);
		}
	});

	it('drops every member to 404 the moment the home is revoked', async () => {
		const [tmp] = await sql`
			INSERT INTO home_connections (user_id, label, base_url, access_token_enc, token_fingerprint, status)
			VALUES (${users.owner}, ${`${PREFIX} temp`}, ${`https://${PREFIX}-3.invalid`}, '', ${`${PREFIX}-3`}, 'connected')
			RETURNING id
		`;
		expect((await members.requireMembership(tmp.id, users.owner, 'read')).ok).toBe(true);
		await sql`UPDATE home_connections SET revoked_at = now() WHERE id = ${tmp.id}`;
		const after = await members.requireMembership(tmp.id, users.owner, 'read');
		expect(after.status).toBe(404);
		await sql`DELETE FROM home_connections WHERE id = ${tmp.id}`;
	});
});

d('the guest refusal: a house sitter can turn on a light and cannot open a door', () => {
	it('refuses a guest a confirmation with a role reason, not a prompt', async () => {
		const act = await members.requireMembership(homeId, users.guest, 'act');
		expect(act.ok).toBe(true);

		const confirm = await members.requireMembership(homeId, users.guest, 'confirm');
		expect(confirm.ok).toBe(false);
		expect(confirm.status).toBe(403);
		expect(confirm.code).toBe('role_forbidden');
		expect(confirm.role).toBe('guest');
		expect(confirm.capability).toBe('confirm');
		expect(confirm.reason).toBe('the guest role cannot confirm in this home');
		// The refusal carries no confirmation affordance of any kind: there is no
		// token, no prompt and no pending id a client could echo back.
		expect(Object.keys(confirm)).not.toContain('confirmation');
		expect(Object.keys(confirm)).not.toContain('confirm_token');
	});

	it('refuses a guest a standing allowance, so they cannot grant their way past the gate', async () => {
		const grant = await members.requireMembership(homeId, users.guest, 'grant');
		expect(grant.ok).toBe(false);
		expect(grant.status).toBe(403);
	});

	it('lets a member confirm: a member lives here, a guest is visiting', async () => {
		expect((await members.requireMembership(homeId, users.member, 'confirm')).ok).toBe(true);
	});
});

d('entity scope: enforced in the projection, never in the UI', () => {
	// A house with two rooms and an unassigned entity. The guest above was given
	// the kitchen as an area and one hall lamp as an individual entity.
	const graph = {
		floors: [
			{ id: 'ground', name: 'Ground', level: 0 },
			{ id: 'upstairs', name: 'Upstairs', level: 1 },
		],
		rooms: [
			{
				id: 'kitchen',
				name: 'Kitchen',
				floorId: 'ground',
				entities: [
					{ entityId: 'light.kitchen_ceiling', domain: 'light', areaId: 'kitchen', name: 'Ceiling', state: 'on', attributes: { brightness: 200 } },
					{ entityId: 'lock.back_door', domain: 'lock', areaId: 'kitchen', name: 'Back door', state: 'locked', attributes: {} },
				],
				lighting: { total: 1, on: 1 },
				climate: null,
				secured: true,
			},
			{
				id: 'hall',
				name: 'Hall',
				floorId: 'ground',
				entities: [
					{ entityId: 'light.hall_lamp', domain: 'light', areaId: 'hall', name: 'Hall lamp', state: 'off', attributes: {} },
					{ entityId: 'light.hall_spots', domain: 'light', areaId: 'hall', name: 'Hall spots', state: 'on', attributes: { brightness: 255 } },
					{ entityId: 'lock.front_door', domain: 'lock', areaId: 'hall', name: 'Front door', state: 'locked', attributes: {} },
				],
				lighting: { total: 2, on: 1 },
				climate: null,
				secured: true,
			},
			{
				id: 'bedroom',
				name: 'Bedroom',
				floorId: 'upstairs',
				entities: [{ entityId: 'light.bedside', domain: 'light', areaId: 'bedroom', name: 'Bedside', state: 'on', attributes: {} }],
				lighting: { total: 1, on: 1 },
				climate: null,
				secured: null,
			},
		],
		unassigned: [{ entityId: 'sensor.outside_temp', domain: 'sensor', areaId: null, name: 'Outside', state: '11', attributes: {} }],
	};

	it('gives an unscoped role the whole house, untouched', async () => {
		const gate = await members.requireMembership(homeId, users.member, 'read');
		const filtered = members.filterGraphForScope(graph, gate.scope);
		expect(filtered).toBe(graph);
	});

	it('removes an out-of-scope room from a guest entirely, name included', async () => {
		const gate = await members.requireMembership(homeId, users.guest, 'read');
		const filtered = members.filterGraphForScope(graph, gate.scope);

		const roomIds = filtered.rooms.map((r) => r.id);
		expect(roomIds).toContain('kitchen');
		expect(roomIds).toContain('hall');
		expect(roomIds).not.toContain('bedroom');

		// The whole serialized payload must not carry the room's name or any of
		// its entity ids. This is the assertion that would fail if the filtering
		// were a `visible: false` flag rather than a removal.
		const wire = JSON.stringify(filtered);
		expect(wire).not.toContain('Bedroom');
		expect(wire).not.toContain('light.bedside');
	});

	it('narrows a partially granted room to the granted entity and recomputes its rollups', async () => {
		const gate = await members.requireMembership(homeId, users.guest, 'read');
		const filtered = members.filterGraphForScope(graph, gate.scope);

		const hall = filtered.rooms.find((r) => r.id === 'hall');
		expect(hall.entities.map((e) => e.entityId)).toEqual(['light.hall_lamp']);
		// The unfiltered hall has two lights, one of them on, and a front door.
		// Reporting that rollup to somebody who can see one lamp would disclose
		// the state of the entities the filtering just removed.
		expect(hall.lighting.total).toBe(1);
		expect(hall.lighting.on).toBe(0);
		expect(JSON.stringify(hall)).not.toContain('lock.front_door');
	});

	it('keeps a wholly granted room intact, rollups and all', async () => {
		const gate = await members.requireMembership(homeId, users.guest, 'read');
		const kitchen = members.filterGraphForScope(graph, gate.scope).rooms.find((r) => r.id === 'kitchen');
		expect(kitchen.entities.map((e) => e.entityId)).toEqual(['light.kitchen_ceiling', 'lock.back_door']);
	});

	it('removes a floor that has no visible room, because the floor list is the shape of the building', async () => {
		const gate = await members.requireMembership(homeId, users.guest, 'read');
		const filtered = members.filterGraphForScope(graph, gate.scope);
		expect(filtered.floors.map((f) => f.id)).toEqual(['ground']);
	});

	it('drops unassigned entities that were never granted', async () => {
		const gate = await members.requireMembership(homeId, users.viewer, 'read');
		const filtered = members.filterGraphForScope(graph, gate.scope);
		expect(filtered.unassigned).toEqual([]);
	});

	it('names every out-of-scope target of a resolved action', async () => {
		const gate = await members.requireMembership(homeId, users.guest, 'act');
		const refused = members.outOfScopeEntities(gate.scope, [
			{ entityId: 'light.hall_lamp', areaId: 'hall' },
			{ entityId: 'light.kitchen_ceiling', areaId: 'kitchen' },
			{ entityId: 'light.bedside', areaId: 'bedroom' },
		]);
		expect(refused).toEqual(['light.bedside']);
	});

	it('normalizes a scoped role back to the whole house when it is promoted', () => {
		const stale = { mode: 'allow', areas: ['kitchen'], entities: [] };
		expect(members.normalizeScope(stale, 'guest')).toEqual({ mode: 'allow', areas: ['kitchen'], entities: [] });
		expect(members.normalizeScope(stale, 'member')).toEqual({ mode: 'all' });
	});
});

d('roster administration', () => {
	it('lets the owner manage everyone below, and never the owner row', () => {
		expect(members.canManageMember('owner', 'admin')).toBe(true);
		expect(members.canManageMember('owner', 'viewer')).toBe(true);
		expect(members.canManageMember('owner', 'owner')).toBe(false);
		expect(members.canManageMember('admin', 'owner')).toBe(false);
	});

	it('lets an admin add a peer admin and never remove one', () => {
		expect(members.canAssignRole('admin', 'admin')).toBe(true);
		expect(members.canManageMember('admin', 'admin')).toBe(false);
		expect(members.canManageMember('admin', 'member')).toBe(true);
	});

	it('never assigns ownership', () => {
		for (const role of members.HOME_ROLES) expect(members.canAssignRole(role, 'owner')).toBe(false);
		expect(members.ASSIGNABLE_ROLES).not.toContain('owner');
	});

	it('gives a member and a guest no roster authority at all', () => {
		for (const actor of ['member', 'guest', 'viewer']) {
			expect(members.canManageMember(actor, 'viewer')).toBe(false);
			expect(members.canAssignRole(actor, 'viewer')).toBe(false);
		}
	});

	it('widens a promoted guest to the whole house in the same statement', async () => {
		const before = await members.resolveMembership(homeId, users.guest);
		expect(before.scope.mode).toBe('allow');

		const promoted = await members.setMemberRole({ homeId, userId: users.guest, role: 'member', scope: before.scope });
		expect(promoted.role).toBe('member');
		expect(promoted.scope).toEqual({ mode: 'all' });

		const restored = await members.setMemberRole({ homeId, userId: users.guest, role: 'guest', scope: before.scope });
		expect(restored.scope).toEqual(before.scope);
	});

	it('refuses to change the owner row', async () => {
		expect(await members.setMemberRole({ homeId, userId: users.owner, role: 'member' })).toBeNull();
		const still = await members.resolveMembership(homeId, users.owner);
		expect(still.role).toBe('owner');
	});
});

d('removing a member revokes their standing allowances in the same transaction', () => {
	it('deletes the grants they authorised and leaves everyone else alone', async () => {
		await sql`INSERT INTO home_members (home_id, user_id, role, invited_by) VALUES (${homeId}, ${users.second}, 'admin', ${users.owner})`;
		await sql`
			INSERT INTO home_entity_grants (home_id, entity_id, granted_by)
			VALUES (${homeId}, 'lock.office_door', ${users.second}), (${homeId}, 'cover.garage', ${users.second}), (${homeId}, 'lock.front_door', ${users.owner})
		`;

		const before = await sql`SELECT entity_id, granted_by FROM home_entity_grants WHERE home_id = ${homeId} ORDER BY entity_id`;
		expect(before.map((r) => r.entity_id)).toEqual(['cover.garage', 'lock.front_door', 'lock.office_door']);

		const result = await members.removeMember({ homeId, userId: users.second });
		expect(result.removed).toBe(true);
		expect(result.grantsRevoked).toEqual(['cover.garage', 'lock.office_door']);

		const after = await sql`SELECT entity_id, granted_by FROM home_entity_grants WHERE home_id = ${homeId} ORDER BY entity_id`;
		expect(after.map((r) => r.entity_id)).toEqual(['lock.front_door']);
		expect(after[0].granted_by).toBe(users.owner);

		expect(await members.resolveMembership(homeId, users.second)).toBeNull();
		await sql`DELETE FROM home_entity_grants WHERE home_id = ${homeId}`;
	});

	it('refuses to remove the owner, so a home is never left ownerless', async () => {
		const result = await members.removeMember({ homeId, userId: users.owner });
		expect(result.removed).toBe(false);
		expect((await members.resolveMembership(homeId, users.owner)).role).toBe('owner');
	});

	it('reaches every household when an identity is deprovisioned', async () => {
		await sql`INSERT INTO home_members (home_id, user_id, role, invited_by) VALUES (${homeId}, ${users.second}, 'member', ${users.owner})`;
		await sql`INSERT INTO home_members (home_id, user_id, role, invited_by) VALUES (${otherHomeId}, ${users.second}, 'guest', ${users.stranger})`;
		await sql`INSERT INTO home_entity_grants (home_id, entity_id, granted_by) VALUES (${homeId}, 'lock.side_gate', ${users.second})`;

		const result = await members.revokeAllMemberships(users.second);
		expect(result.removedFrom.sort()).toEqual([homeId, otherHomeId].sort());
		expect(await members.resolveMembership(homeId, users.second)).toBeNull();
		expect(await members.resolveMembership(otherHomeId, users.second)).toBeNull();

		const [{ left }] = await sql`SELECT count(*)::int AS left FROM home_entity_grants WHERE granted_by = ${users.second}`;
		expect(left).toBe(0);
	});
});

d('invitations are single use and they expire', () => {
	it('admits exactly one holder and refuses the second attempt', async () => {
		const invite = await members.createInvite({
			homeId,
			email: email('invitee'),
			role: 'guest',
			scope: { mode: 'allow', areas: ['kitchen'], entities: [] },
			invitedBy: users.owner,
		});
		expect(invite.token).toBeTruthy();

		const first = await members.acceptInvite({ token: invite.token, userId: users.second });
		expect(first.ok).toBe(true);
		expect(first.membership.role).toBe('guest');
		expect(first.membership.scope).toEqual({ mode: 'allow', areas: ['kitchen'], entities: [] });

		const second = await members.acceptInvite({ token: invite.token, userId: users.stranger });
		expect(second.ok).toBe(false);
		expect(second.code).toBe('invite_spent');
		expect(await members.resolveMembership(homeId, users.stranger)).toBeNull();

		await members.removeMember({ homeId, userId: users.second });
	});

	it('refuses an expired invitation', async () => {
		const invite = await members.createInvite({
			homeId,
			email: email('expired'),
			role: 'viewer',
			invitedBy: users.owner,
			ttlMs: -1000,
		});
		const attempt = await members.acceptInvite({ token: invite.token, userId: users.second });
		expect(attempt.ok).toBe(false);
		expect(attempt.code).toBe('invite_expired');
		expect(await members.resolveMembership(homeId, users.second)).toBeNull();
	});

	it('refuses a withdrawn invitation', async () => {
		const invite = await members.createInvite({ homeId, email: email('withdrawn'), role: 'viewer', invitedBy: users.owner });
		expect(await members.revokeInvite({ homeId, inviteId: invite.id })).toBe(true);
		const attempt = await members.acceptInvite({ token: invite.token, userId: users.second });
		expect(attempt.code).toBe('invite_revoked');
	});

	it('stores the token as a hash and never in plaintext', async () => {
		const invite = await members.createInvite({ homeId, email: email('hashed'), role: 'viewer', invitedBy: users.owner });
		const [row] = await sql`SELECT token_hash FROM home_invites WHERE id = ${invite.id}`;
		expect(row.token_hash).not.toBe(invite.token);
		expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
		const [{ hits }] = await sql`SELECT count(*)::int AS hits FROM home_invites WHERE token_hash = ${invite.token}`;
		expect(hits).toBe(0);
		await members.revokeInvite({ homeId, inviteId: invite.id });
	});

	it('replaces an outstanding invitation to the same address rather than stacking a second key', async () => {
		const first = await members.createInvite({ homeId, email: email('replaced'), role: 'viewer', invitedBy: users.owner });
		const second = await members.createInvite({ homeId, email: email('replaced'), role: 'member', invitedBy: users.owner });

		expect((await members.acceptInvite({ token: first.token, userId: users.second })).code).toBe('invite_revoked');
		const accepted = await members.acceptInvite({ token: second.token, userId: users.second });
		expect(accepted.ok).toBe(true);
		expect(accepted.membership.role).toBe('member');

		await members.removeMember({ homeId, userId: users.second });
	});

	it('never lets an invitation hand out ownership', async () => {
		await expect(members.createInvite({ homeId, email: email('usurper'), role: 'owner', invitedBy: users.owner })).rejects.toThrow(/invalid invite role/);
	});

	it('keeps the role an existing member already holds', async () => {
		const invite = await members.createInvite({ homeId, email: email('admin'), role: 'viewer', invitedBy: users.owner });
		const result = await members.acceptInvite({ token: invite.token, userId: users.admin });
		expect(result.ok).toBe(true);
		expect(result.alreadyMember).toBe(true);
		expect((await members.resolveMembership(homeId, users.admin)).role).toBe('admin');
	});

	it('lists outstanding invitations without ever returning a token', async () => {
		const invite = await members.createInvite({ homeId, email: email('listed'), role: 'guest', invitedBy: users.owner });
		const list = await members.listInvites(homeId);
		const found = list.find((i) => i.id === invite.id);
		expect(found).toBeTruthy();
		expect(found.token).toBeUndefined();
		expect(JSON.stringify(list)).not.toContain(invite.token);
		await members.revokeInvite({ homeId, inviteId: invite.id });
	});
});

d('the invitation email says what the seat is, and never renders a name as markup', () => {
	it('names the role and the thing that role can never do', async () => {
		const { renderHouseholdInvite } = await import('../api/_lib/email.js');
		const mail = renderHouseholdInvite({
			homeLabel: 'The office',
			role: 'guest',
			inviterName: 'Sam',
			inviteUrl: 'https://three.ws/smart-home/join?invite=token',
			expiresAt: '2026-09-10T03:31:52.462Z',
		});
		expect(mail.subject).toContain('The office');
		// The guest line is the one that matters: somebody forwarding this should
		// be able to see they are handing over a guest seat and not the house.
		expect(mail.text).toContain('never be able to approve unlocking a door');
		expect(mail.html).toContain('never be able to approve unlocking a door');
		expect(mail.text).toContain('works once');
	});

	it('escapes a home label and an inviter name, both of which a person typed', async () => {
		const { renderHouseholdInvite } = await import('../api/_lib/email.js');
		const mail = renderHouseholdInvite({
			homeLabel: '<img src=x onerror=alert(1)>',
			role: 'viewer',
			inviterName: '<b>nobody</b>',
			inviteUrl: 'https://three.ws/smart-home/join?invite=token',
		});
		expect(mail.html).not.toContain('<img src=x');
		expect(mail.html).not.toContain('<b>nobody</b>');
		expect(mail.html).toContain('&lt;img');
	});

	it('carries a different sentence for every assignable role', async () => {
		const { renderHouseholdInvite } = await import('../api/_lib/email.js');
		const lines = new Set();
		for (const role of members.ASSIGNABLE_ROLES) {
			const mail = renderHouseholdInvite({ homeLabel: 'Home', role, inviteUrl: 'https://three.ws/x' });
			lines.add(mail.text);
		}
		expect(lines.size).toBe(members.ASSIGNABLE_ROLES.length);
	});
});

d('a scope survives a round trip through the store', () => {
	it('keeps the rooms an editor sent, and drops nothing on the way back', async () => {
		const sent = { mode: 'allow', areas: ['kitchen', 'hall'], entities: ['light.hall_lamp'] };
		const saved = await members.setMemberRole({ homeId, userId: users.viewer, role: 'viewer', scope: sent });
		expect(saved.scope).toEqual(sent);

		const read = await members.resolveMembership(homeId, users.viewer);
		expect(read.scope).toEqual(sent);

		// Widening back to the whole house is an explicit {mode:'all'}, not an
		// omission: the editor's Save means "this is the scope now".
		const widened = await members.setMemberRole({ homeId, userId: users.viewer, role: 'viewer', scope: { mode: 'all' } });
		expect(widened.scope).toEqual({ mode: 'all' });

		await members.setMemberRole({ homeId, userId: users.viewer, role: 'viewer', scope: { mode: 'allow', areas: ['kitchen'], entities: ['light.hall_lamp'] } });
	});

	it('refuses a scope the schema cannot describe', async () => {
		await expect(
			sql`UPDATE home_members SET entity_scope = ${'{"mode":"everything"}'}::jsonb WHERE home_id = ${homeId} AND user_id = ${users.viewer}`,
		).rejects.toMatchObject({ code: '23514' });
	});

	it('de-duplicates and trims what an editor sends, and caps how much it can send', () => {
		const messy = { mode: 'allow', areas: [' kitchen ', 'kitchen', '', null, 'hall'], entities: Array.from({ length: 900 }, (_, i) => `light.l${i}`) };
		const clean = members.normalizeScope(messy, 'guest');
		expect(clean.areas).toEqual(['kitchen', 'hall']);
		expect(clean.entities).toHaveLength(500);
	});
});

d('the action log attributes every action to the member who acted', () => {
	it('records two members acting on one home under their own ids', async () => {
		for (const who of ['admin', 'member']) {
			const gate = await members.requireMembership(homeId, users[who], 'act');
			expect(gate.ok).toBe(true);
			// The acting member id is the one the gate resolved, never the
			// connection's owner. This is the value every call site above (the
			// runtime, the gate, the chat and MCP tools) must pass through.
			const landed = await store.logHomeActionNow({
				homeId,
				userId: gate.membership.userId,
				actor: 'user',
				channel: 'websocket',
				action: 'light.turn_on',
				entityIds: ['light.kitchen_ceiling'],
				outcome: 'ok',
			});
			expect(landed).toBe(true);
		}

		const rows = await sql`
			SELECT user_id, action FROM home_action_log
			WHERE home_id = ${homeId} AND action = 'light.turn_on'
			ORDER BY created_at ASC
		`;
		expect(rows.map((r) => r.user_id).sort()).toEqual([users.admin, users.member].sort());
		expect(rows.map((r) => r.user_id)).not.toContain(users.owner);
	});

	it('records a guest refusal against the guest, with the gate verdict', async () => {
		const gate = await members.requireMembership(homeId, users.guest, 'confirm');
		expect(gate.ok).toBe(false);
		await store.logHomeActionNow({
			homeId,
			userId: gate.membership.userId,
			actor: 'user',
			channel: 'websocket',
			action: 'lock.unlock',
			entityIds: ['lock.front_door'],
			guarded: true,
			risk: 'security',
			outcome: 'refused',
			detail: { reason: gate.code, role: gate.role },
		});

		const [row] = await sql`
			SELECT user_id, guarded, risk, outcome, confirmed_by, detail
			FROM home_action_log WHERE home_id = ${homeId} AND action = 'lock.unlock'
		`;
		expect(row.user_id).toBe(users.guest);
		expect(row.guarded).toBe(true);
		expect(row.outcome).toBe('refused');
		// Nobody confirmed it, and the row says so. A refused guarded action with
		// a confirmed_by would be the audit trail lying about who opened a door.
		expect(row.confirmed_by).toBeNull();
		expect(row.detail.role).toBe('guest');
	});
});

d('the access door enforces the matrix for every /api/home route', () => {
	// resolveHomeAccess is the single door every REST route on this surface goes
	// through, so the matrix is asserted against it directly, with a real session
	// cookie, rather than against nine handlers that all delegate to it.
	let access;
	let sessions = {};

	beforeAll(async () => {
		access = await import('../api/_lib/home/access.js');
		const { createSession } = await import('../api/_lib/auth.js');
		for (const who of ['owner', 'admin', 'member', 'guest', 'viewer', 'stranger']) {
			sessions[who] = await createSession({ userId: users[who], userAgent: 'home-roles-test', ip: '127.0.0.1' });
		}
	}, 120_000);

	const reqFor = (who) => ({ headers: { cookie: `__Host-sid=${sessions[who]}` }, socket: {} });
	const res = { setHeader() {}, getHeader() {}, headersSent: false };

	for (const [role, expected] of Object.entries(EXPECTED)) {
		for (const [capability, allowed] of Object.entries(expected)) {
			it(`the door ${allowed ? 'admits' : 'refuses'} a ${role} asking to ${capability}`, async () => {
				const result = await access.resolveHomeAccess(reqFor(role), res, homeId, capability);
				expect(result.ok).toBe(allowed);
				if (allowed) {
					expect(result.role).toBe(role);
					expect(result.home.id).toBe(homeId);
					// The credential never reaches a route, whichever role asked.
					expect(Object.keys(result.home)).not.toContain('access_token_enc');
				} else {
					expect(result.status).toBe(403);
					expect(result.code).toBe('role_forbidden');
					expect(result.message).toContain(role);
				}
			});
		}
	}

	it('answers a non-member 404 without confirming the home is real', async () => {
		const result = await access.resolveHomeAccess(reqFor('stranger'), res, homeId, 'read');
		expect(result.ok).toBe(false);
		expect(result.status).toBe(404);
		expect(result.code).toBe('not_found');
		expect(result.home).toBeUndefined();
	});

	it('answers a signed-out caller 401', async () => {
		const result = await access.resolveHomeAccess({ headers: {}, socket: {} }, res, homeId, 'read');
		expect(result.status).toBe(401);
	});

	it('carries the scope a scoped role is held to', async () => {
		const result = await access.resolveHomeAccess(reqFor('guest'), res, homeId, 'read');
		expect(result.scoped).toBe(true);
		expect(result.scope.areas).toContain('kitchen');

		const whole = await access.resolveHomeAccess(reqFor('member'), res, homeId, 'read');
		expect(whole.scoped).toBe(false);
		expect(whole.scope).toEqual({ mode: 'all' });
	});

	it('defaults to `read` so a route that names no capability fails closed, not open', async () => {
		const viewer = await access.resolveHomeAccess(reqFor('viewer'), res, homeId);
		expect(viewer.ok).toBe(true);
		expect(viewer.role).toBe('viewer');
	});
});

d('every route on the surface names the capability it needs', () => {
	// A drift guard, not a behaviour test. `resolveHomeAccess` defaults to `read`,
	// which is the safe default and also a silent one: a new route that writes to
	// a house and forgets to say so would be admitted to a viewer. Reading the
	// call sites is the only way to catch that, because the omission is invisible
	// at runtime until somebody exploits it.
	it('passes a capability at every resolveHomeAccess call site under api/home', async () => {
		const { readdirSync, readFileSync, statSync } = await import('node:fs');
		const { join } = await import('node:path');

		const walk = (dir) =>
			readdirSync(dir).flatMap((name) => {
				const full = join(dir, name);
				return statSync(full).isDirectory() ? walk(full) : full.endsWith('.js') ? [full] : [];
			});

		const bare = [];
		for (const file of walk('api/home')) {
			const src = readFileSync(file, 'utf8');
			for (const call of src.match(/resolveHomeAccess\([^)]*\)/g) || []) {
				// Three arguments is (req, res, homeId) with the capability left off.
				if (call.split(',').length < 4) bare.push(`${file}: ${call}`);
			}
		}
		expect(bare).toEqual([]);
	});
});

d('listing homes resolves through membership, not through ownership', () => {
	it('shows a member the home they were invited to, with the role they hold', async () => {
		const listed = await members.listMembershipHomes(users.viewer);
		const found = listed.find((h) => h.home_id === homeId);
		expect(found).toBeTruthy();
		expect(found.role).toBe('viewer');
		expect(found.label).toBe(`${PREFIX} house`);
	});

	it('shows a stranger nothing of a home they are not in', async () => {
		const listed = await members.listMembershipHomes(users.stranger);
		expect(listed.map((h) => h.home_id)).not.toContain(homeId);
		expect(listed.map((h) => h.home_id)).toContain(otherHomeId);
	});

	it('never returns a credential column on a membership listing', async () => {
		const listed = await members.listMembershipHomes(users.owner);
		for (const row of listed) expect(Object.keys(row)).not.toContain('access_token_enc');
	});
});
