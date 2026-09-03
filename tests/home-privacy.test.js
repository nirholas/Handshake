// The Home lane's privacy guarantees, asserted rather than documented.
//
// Three of these tests are structural, and they are the ones that will still be
// doing their job in six months:
//
//   * INVENTORY COMPLETENESS re-derives the set of home_* tables from the
//     migration files themselves. A future order that adds a table to this
//     campaign and forgets to write down what it holds fails here, which is the
//     only reliable defence against an undocumented data class.
//   * NO PERSISTED STATE HISTORY reads the same migrations and fails if any of
//     them creates a column that would store an entity's state over time. That
//     promise is the most important line in docs/home-privacy.md and it is one
//     careless migration away from being false.
//   * LOG HYGIENE reads the lane's source and fails if a log call passes a base
//     URL, a home label, or a friendly name. Logs go to a different system with
//     a different retention and a different set of readers, so a leak there has
//     the longest tail of any leak in the lane.
//
// The rest exercise real behaviour against the real database and are skipped,
// with a stated reason, when DATABASE_URL is absent (a fresh clone, CI without
// secrets). They are never replaced by a mock: a cascade that a mock "verifies"
// is a cascade nobody verified.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
	DEFAULT_ACTION_LOG_RETENTION_DAYS,
	INVENTORY,
	INVENTORY_TABLES,
	MAX_ACTION_LOG_RETENTION_DAYS,
	MIN_ACTION_LOG_RETENTION_DAYS,
} from '../api/_lib/home/privacy.js';
import { CONNECT_DISCLOSURE, DISCLOSURES, VOICE_DISCLOSURE, disclosureById } from '../api/_lib/home/disclosure.js';

const MIGRATIONS_DIR = join(process.cwd(), 'api/_lib/migrations');

function homeMigrations() {
	return readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith('.sql'))
		.map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS_DIR, f), 'utf8') }))
		.filter((m) => /create table (if not exists )?home_/i.test(m.sql) || /alter table home_/i.test(m.sql));
}

/** Every `home_*` table any migration in the repo creates. */
function declaredHomeTables() {
	const found = new Set();
	for (const { sql } of homeMigrations()) {
		for (const m of sql.matchAll(/create table\s+(?:if not exists\s+)?(home_[a-z0-9_]+)/gi)) {
			found.add(m[1].toLowerCase());
		}
	}
	return [...found].sort();
}

describe('home privacy: the inventory is complete', () => {
	it('every home table a migration creates is written down in INVENTORY', () => {
		const declared = declaredHomeTables();
		expect(declared.length).toBeGreaterThan(0);
		const missing = declared.filter((t) => !INVENTORY_TABLES.includes(t));
		expect(
			missing,
			`These tables exist in the schema but no row of INVENTORY (api/_lib/home/privacy.js) says what they hold, why, or how long for. Add a row, and add it to docs/home-privacy.md, in the same change that created the table.`,
		).toEqual([]);
	});

	it('the inventory never names a table that does not exist', () => {
		const declared = declaredHomeTables();
		// audit_log is the one non-home table the lane writes to, handled by its
		// own residue sweep rather than the inventory's table column.
		const phantom = INVENTORY_TABLES.filter((t) => !declared.includes(t));
		expect(phantom, 'INVENTORY names a table no migration creates').toEqual([]);
	});

	it('every inventory row answers all five questions a person would ask', () => {
		for (const row of INVENTORY) {
			expect(row.key, 'every row needs a stable key').toMatch(/^[a-z_]+$/);
			expect(row.data.length, `${row.key}: "what" must be a sentence`).toBeGreaterThan(10);
			expect(row.why.length, `${row.key}: "why" must be a sentence`).toBeGreaterThan(10);
			expect(row.retention.length, `${row.key}: "how long" must be a sentence`).toBeGreaterThan(10);
			expect(row.deletedBy.length, `${row.key}: "who removes it" must be a sentence`).toBeGreaterThan(4);
		}
	});

	it('states plainly that entity names, states and voice audio are not stored', () => {
		const promises = INVENTORY.filter((r) => r.table === null).map((r) => r.key);
		for (const key of ['entity_names', 'entity_states', 'voice_audio', 'voice_transcript']) {
			expect(promises, `${key} must be an explicit "we do not store this" row`).toContain(key);
		}
	});
});

describe('home privacy: no persisted entity-state history', () => {
	// The shapes a state history would take if somebody added one. Naming them
	// is the point: this test is a tripwire on a specific mistake, not a vague
	// gesture at good intentions.
	const BANNED = [
		/create table\s+(?:if not exists\s+)?home_(entity_)?stat(e|es|e_history)\b/i,
		/create table\s+(?:if not exists\s+)?home_[a-z_]*state_history/i,
		/create table\s+(?:if not exists\s+)?home_entity_snapshots?/i,
		/create table\s+(?:if not exists\s+)?home_occupancy/i,
		/create table\s+(?:if not exists\s+)?home_presence/i,
	];

	it('no migration creates a table that would store entity state over time', () => {
		for (const { file, sql } of homeMigrations()) {
			for (const pattern of BANNED) {
				expect(
					pattern.test(sql),
					`${file} creates a persisted entity-state history. A record of when a household's lights go on and off is a record of when they are home. If there is a genuine product need it requires its own explicit opt-in, its own retention window and its own disclosure, and it is not part of this campaign.`,
				).toBe(false);
			}
		}
	});

	it('the room graph is not persisted anywhere in the schema', () => {
		for (const { file, sql } of homeMigrations()) {
			expect(
				/create table\s+(?:if not exists\s+)?home_(rooms|areas|entities|devices)\b/i.test(sql),
				`${file} persists the room graph. It is a live projection of a live WebSocket and belongs in the bridge runtime's memory, where it dies with the instance.`,
			).toBe(false);
		}
	});
});

describe('home privacy: log hygiene', () => {
	const SOURCES = [
		'api/_lib/home/store.js',
		'api/_lib/home/privacy.js',
		'api/_lib/home/disclosure.js',
		'api/home/privacy.js',
	];

	function readIfPresent(path) {
		try {
			return readFileSync(join(process.cwd(), path), 'utf8');
		} catch {
			return null;
		}
	}

	it('no log call in the lane passes a base URL, a home label, or a friendly name', () => {
		// Match the ARGUMENTS of a log call, not the whole file: the modules talk
		// about base_url in comments and in SQL projections, which is correct, and
		// only what reaches a log sink is the leak.
		const LOG_CALL = /(?:console\.(?:log|warn|error|info|debug)|logAudit|logAuditNow|sendOpsAlert)\s*\(([\s\S]{0,600}?)\)\s*;/g;
		const LEAKY = /\b(base_?Url|baseUrl|friendly_?name|\blabel\b)\b/i;

		for (const path of SOURCES) {
			const src = readIfPresent(path);
			if (src === null) continue;
			for (const match of src.matchAll(LOG_CALL)) {
				expect(
					LEAKY.test(match[1]),
					`${path}: a log call carries a home address or a human-chosen name:\n${match[0].slice(0, 300)}\nLogs have their own retention and their own readers. Log the home id instead; it correlates and it says nothing.`,
				).toBe(false);
			}
		}
	});

	it('the action log scrubs its detail blob before writing it', () => {
		const src = readIfPresent('api/_lib/home/store.js');
		expect(src, 'api/_lib/home/store.js must exist').not.toBeNull();
		expect(
			/JSON\.stringify\(scrubSecrets\(detail\)\)/.test(src),
			'home_action_log.detail is written by a caller-supplied object and must go through scrubSecrets() first.',
		).toBe(true);
	});
});

describe('home privacy: the disclosure copy', () => {
	it('both surfaces have copy, and it is the same copy everywhere', () => {
		expect(DISCLOSURES.map((d) => d.id).sort()).toEqual(['home.connect', 'home.voice']);
		expect(disclosureById('home.connect')).toBe(CONNECT_DISCLOSURE);
		expect(disclosureById('home.voice')).toBe(VOICE_DISCLOSURE);
	});

	it('the connect copy says what the token can actually do', () => {
		const text = CONNECT_DISCLOSURE.lines.join(' ').toLowerCase();
		// "full control" is the sentence that does not change anybody's mind.
		// "unlock your doors" is the one that does.
		expect(text).toContain('unlock');
		expect(text).toContain('encrypt');
		expect(text, 'must say we never store device states').toMatch(/never store their states|no record of which lights/);
	});

	it('the voice copy separates what stays on the device from what leaves it', () => {
		const text = VOICE_DISCLOSURE.lines.join(' ').toLowerCase();
		expect(text).toContain('wake word');
		expect(text).toContain('this device');
		expect(text, 'must say the audio is never stored').toMatch(/never store the audio/);
	});

	it('no disclosure hedges', () => {
		for (const d of DISCLOSURES) {
			for (const line of d.lines) {
				expect(
					/\bmay\b|\bmight\b|\bwe aim to\b|\bwe strive\b/i.test(line),
					`${d.id}: "${line}" hedges. Every sentence here is true of the code as it stands, or it does not ship.`,
				).toBe(false);
			}
		}
	});

	it('every disclosure points somewhere a reader can actually go', () => {
		for (const d of DISCLOSURES) {
			expect(d.learnMoreHref).toBe('/docs/home-privacy');
		}
	});
});

describe('home privacy: retention bounds', () => {
	it('defaults to 90 days, inside its own bounds', () => {
		expect(DEFAULT_ACTION_LOG_RETENTION_DAYS).toBe(90);
		expect(MIN_ACTION_LOG_RETENTION_DAYS).toBeLessThan(DEFAULT_ACTION_LOG_RETENTION_DAYS);
		expect(MAX_ACTION_LOG_RETENTION_DAYS).toBeGreaterThan(DEFAULT_ACTION_LOG_RETENTION_DAYS);
	});

	it('the schema enforces the same bounds the module does', () => {
		const migration = readFileSync(
			join(MIGRATIONS_DIR, '20260903180000_home_privacy_retention.sql'),
			'utf8',
		);
		expect(migration).toContain(
			`check (action_log_retention_days between ${MIN_ACTION_LOG_RETENTION_DAYS} and ${MAX_ACTION_LOG_RETENTION_DAYS})`,
		);
		expect(migration).toContain(`default ${DEFAULT_ACTION_LOG_RETENTION_DAYS}`);
	});

	it('a grant cannot pin a departed user in place', () => {
		const migration = readFileSync(
			join(MIGRATIONS_DIR, '20260903180000_home_privacy_retention.sql'),
			'utf8',
		);
		expect(
			/foreign key \(granted_by\) references users\(id\) on delete cascade/i.test(migration),
			'home_entity_grants.granted_by must cascade, or a member who granted an allowance on somebody else\'s home can never delete their account.',
		).toBe(true);
	});
});

// ── Live database behaviour ──────────────────────────────────────────────────
// Real rows, real cascades, real counts. Skipped, loudly, without DATABASE_URL.

const LIVE = Boolean(process.env.DATABASE_URL);

describe.skipIf(!LIVE)('home privacy: deletion and purge against the real database', () => {
	/** @type {any} */ let sql;
	/** @type {any} */ let privacy;
	const created = { users: [], homes: [] };

	async function setup() {
		if (sql) return;
		({ sql } = await import('../api/_lib/db.js'));
		privacy = await import('../api/_lib/home/privacy.js');
	}

	async function makeUser(tag) {
		const email = `home-privacy-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.invalid`;
		const [row] = await sql`
			insert into users (email, display_name) values (${email}, ${'home privacy test'})
			returning id, email
		`;
		created.users.push(row.id);
		return row;
	}

	async function makeHome(userId, label) {
		const [row] = await sql`
			insert into home_connections (user_id, label, base_url, access_token_enc, token_fingerprint)
			values (${userId}, ${label}, ${'https://ha-' + Math.random().toString(36).slice(2, 10) + '.test.invalid'},
			        ${'enc'}, ${Math.random().toString(36).slice(2)})
			returning id
		`;
		created.homes.push(row.id);
		return row.id;
	}

	afterAll(async () => {
		if (!sql) return;
		for (const id of created.homes) await sql`delete from home_connections where id = ${id}`;
		for (const id of created.users) await sql`delete from users where id = ${id}`;
	});

	it('deleting one home removes every row of that home and touches no other', async () => {
		await setup();
		const owner = await makeUser('one');
		const doomed = await makeHome(owner.id, 'The one being deleted');
		const keeper = await makeHome(owner.id, 'The one that stays');

		for (const homeId of [doomed, keeper]) {
			await sql`insert into home_entity_grants (home_id, entity_id, granted_by) values (${homeId}, ${'lock.front_door'}, ${owner.id})`;
			await sql`insert into home_action_log (home_id, user_id, actor, channel, action, entity_ids, outcome)
			          values (${homeId}, ${owner.id}, 'user', 'websocket', 'light.turn_on', ${['light.kitchen']}, 'ok')`;
		}

		const beforeDoomed = await privacy.countHomeRows(doomed);
		const beforeKeeper = await privacy.countHomeRows(keeper);
		expect(beforeDoomed.home_connections).toBe(1);
		expect(beforeDoomed.home_entity_grants).toBe(1);
		expect(beforeDoomed.home_action_log).toBe(1);
		// The order-12 trigger seeds an owner membership on insert.
		expect(beforeDoomed.home_members).toBeGreaterThanOrEqual(1);

		const result = await privacy.deleteHome(doomed, owner.id);
		expect(result.deleted).toBe(true);

		const afterDoomed = await privacy.countHomeRows(doomed);
		for (const [table, n] of Object.entries(afterDoomed)) {
			expect(n, `${table} still has rows for a deleted home`).toBe(0);
		}
		const afterKeeper = await privacy.countHomeRows(keeper);
		expect(afterKeeper).toEqual(beforeKeeper);
	});

	it('a home that is not yours cannot be deleted, and says nothing about existing', async () => {
		await setup();
		const owner = await makeUser('owner');
		const stranger = await makeUser('stranger');
		const homeId = await makeHome(owner.id, 'Not yours');

		const result = await privacy.deleteHome(homeId, stranger.id);
		expect(result.deleted).toBe(false);
		const still = await privacy.countHomeRows(homeId);
		expect(still.home_connections).toBe(1);
	});

	it('deleting an account leaves zero rows in every table, and is idempotent', async () => {
		await setup();
		const owner = await makeUser('acct');
		const other = await makeUser('other');
		const mine = await makeHome(owner.id, 'Mine');
		const theirs = await makeHome(other.id, 'Theirs');

		// Rows in every table, including the ones a naive cascade misses: a grant
		// and a membership on somebody else's home, and an action this user took
		// and confirmed there.
		await sql`insert into home_entity_grants (home_id, entity_id, granted_by) values (${mine}, ${'lock.front_door'}, ${owner.id})`;
		await sql`insert into home_members (home_id, user_id, role) values (${theirs}, ${owner.id}, 'member')`;
		await sql`insert into home_entity_grants (home_id, entity_id, granted_by) values (${theirs}, ${'lock.office_door'}, ${owner.id})`;
		await sql`insert into home_invites (home_id, email, role, token_hash, invited_by, expires_at)
		          values (${theirs}, ${owner.email}, 'member', ${'h' + Math.random().toString(36).slice(2)}, ${other.id}, now() + interval '7 days')`;
		await sql`insert into home_action_log (home_id, user_id, actor, channel, action, entity_ids, guarded, confirmed_by, outcome)
		          values (${theirs}, ${owner.id}, 'user', 'websocket', 'lock.unlock', ${['lock.office_door']}, true, ${owner.id}, 'ok')`;

		const before = await privacy.countUserRows(owner.id, owner.email);
		expect(before.home_connections).toBe(1);
		expect(before.home_members).toBe(2); // the owner seed on `mine`, plus `theirs`
		expect(before.home_entity_grants).toBe(2);
		expect(before.home_invites_to_email).toBe(1);
		expect(before.home_action_log_actor).toBe(1);
		expect(before.home_action_log_confirmed_by).toBe(1);

		const first = await privacy.deleteAllHomeDataForUser(owner.id, { email: owner.email });
		for (const [table, n] of Object.entries(first.after)) {
			expect(n, `${table} still holds rows for a deleted account`).toBe(0);
		}

		// Idempotent: a second run finds nothing and changes nothing.
		const second = await privacy.deleteAllHomeDataForUser(owner.id, { email: owner.email });
		expect(second.before).toEqual(second.after);
		expect(second.homes).toBe(0);

		// The other household keeps its own history, minus the pointer to a person
		// who is gone.
		const [{ n }] = await sql`select count(*)::int as n from home_action_log where home_id = ${theirs}`;
		expect(n).toBe(1);
		const [row] = await sql`select user_id, confirmed_by from home_action_log where home_id = ${theirs}`;
		expect(row.user_id).toBeNull();
		expect(row.confirmed_by).toBeNull();

		// And the account row itself can now actually be deleted, which the
		// pre-migration granted_by foreign key made impossible.
		await expect(sql`delete from users where id = ${owner.id}`).resolves.toBeDefined();
		created.users = created.users.filter((id) => id !== owner.id);
	});

	it('the purge deletes rows past a home\'s window and nothing else', async () => {
		await setup();
		const owner = await makeUser('purge');
		const short = await makeHome(owner.id, 'Seven day window');
		const long = await makeHome(owner.id, 'Default window');

		await sql`update home_connections set action_log_retention_days = 7 where id = ${short}`;

		// Two old rows and one new one in the short-window home; one old row in the
		// default-window home, which is inside its 90 days and must survive.
		await sql`insert into home_action_log (home_id, actor, channel, action, outcome, created_at)
		          values (${short}, 'agent', 'websocket', 'light.turn_off', 'ok', now() - interval '30 days'),
		                 (${short}, 'agent', 'websocket', 'light.turn_on',  'ok', now() - interval '8 days'),
		                 (${short}, 'agent', 'websocket', 'light.turn_on',  'ok', now() - interval '1 day'),
		                 (${long},  'agent', 'websocket', 'light.turn_on',  'ok', now() - interval '30 days')`;

		const beforeShort = await privacy.countHomeRows(short);
		const beforeLong = await privacy.countHomeRows(long);
		expect(beforeShort.home_action_log).toBe(3);
		expect(beforeLong.home_action_log).toBe(1);

		const swept = await privacy.purgeExpiredActionLog();
		expect(swept.deleted).toBeGreaterThanOrEqual(2);

		const afterShort = await privacy.countHomeRows(short);
		const afterLong = await privacy.countHomeRows(long);
		expect(afterShort.home_action_log, 'only the row inside the 7 day window survives').toBe(1);
		expect(afterLong.home_action_log, 'a 30 day old row is inside the 90 day default').toBe(1);

		// Idempotent: nothing left to take.
		const again = await privacy.purgeExpiredActionLog();
		const afterAgain = await privacy.countHomeRows(short);
		expect(afterAgain.home_action_log).toBe(1);
		expect(again.homes).toBe(0);
	});

	it('shortening retention applies immediately, and lengthening needs a reason', async () => {
		await setup();
		const owner = await makeUser('control');
		const homeId = await makeHome(owner.id, 'Retention control');
		await sql`insert into home_action_log (home_id, actor, channel, action, outcome, created_at)
		          values (${homeId}, 'agent', 'websocket', 'light.turn_on', 'ok', now() - interval '10 days')`;

		const tooLong = await privacy.setActionLogRetention({ homeId, userId: owner.id, days: 365 });
		expect(tooLong.ok).toBe(false);
		expect(tooLong.code).toBe('reason_required');

		const withReason = await privacy.setActionLogRetention({
			homeId,
			userId: owner.id,
			days: 365,
			reason: 'Building operator: incident records are kept for one year.',
		});
		expect(withReason.ok).toBe(true);

		const shortened = await privacy.setActionLogRetention({ homeId, userId: owner.id, days: 1 });
		expect(shortened.ok).toBe(true);
		expect(shortened.purged, 'a 10 day old row must be gone the moment the window becomes 1 day').toBe(1);
		const counts = await privacy.countHomeRows(homeId);
		expect(counts.home_action_log).toBe(0);

		// Out of bounds is refused by the module before it reaches the constraint.
		const absurd = await privacy.setActionLogRetention({ homeId, userId: owner.id, days: 99_999, reason: 'forever please' });
		expect(absurd.ok).toBe(false);
		expect(absurd.code).toBe('bad_retention_days');

		// Somebody else's home is not yours to configure.
		const stranger = await makeUser('stranger2');
		const denied = await privacy.setActionLogRetention({ homeId, userId: stranger.id, days: 30 });
		expect(denied.ok).toBe(false);
		expect(denied.code).toBe('not_found');
	});

	it('the export carries every inventory row and never the credential', async () => {
		await setup();
		const owner = await makeUser('export');
		const homeId = await makeHome(owner.id, 'Exported');
		await sql`insert into home_entity_grants (home_id, entity_id, granted_by) values (${homeId}, ${'lock.front_door'}, ${owner.id})`;
		await sql`insert into home_action_log (home_id, user_id, actor, channel, action, entity_ids, outcome)
		          values (${homeId}, ${owner.id}, 'user', 'websocket', 'light.turn_on', ${['light.kitchen']}, 'ok')`;

		const data = await privacy.exportHomeData(owner.id);
		expect(Object.keys(data).sort()).toEqual([
			'action_log', 'confirmations', 'generated_at', 'grants', 'homes_you_own',
			'inventory', 'invites', 'members', 'memberships', 'notice',
		]);
		expect(data.homes_you_own).toHaveLength(1);
		expect(data.grants).toHaveLength(1);
		expect(data.action_log).toHaveLength(1);
		expect(data.inventory).toEqual(INVENTORY);

		const serialized = JSON.stringify(data);
		expect(serialized, 'the export must never carry a credential column').not.toContain('access_token_enc');
		expect(data.homes_you_own[0].token_fingerprint, 'the fingerprint proves which token without being usable').toBeTruthy();
	});
});
