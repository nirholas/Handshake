// friends-store: two places where a well-formed caller input reached Postgres
// unchecked and the failure surfaced as the wrong thing entirely.
//
//   muteUser(): user_mutes.muted_id is a foreign key to users(id). Muting an
//                 id that no longer exists raised a bare 23503 with no `status`
//                 on it, so api/_lib/http.js wrap() could only report a 500,
//                 complete with a Sentry capture and an ops alert, for what is
//                 a caller mistake. sendRequest() already answered 404 for the
//                 same input; muteUser now matches it.
//
//   getThread(): the `before` cursor was resolved with
//                 `created_at < (select created_at from direct_messages where
//                 id = $cursor)`, unscoped. Two consequences: a caller could
//                 page against the timestamp of a message in someone else's
//                 thread, and an unknown or stale cursor made the comparison
//                 `created_at < null`, which matches nothing, so the endpoint
//                 answered "no older messages" instead of admitting the cursor
//                 was bad, and the client stopped paginating on a lie.
//
// The `sql` tag is faked so the queries and their parameters can be inspected
// directly; the real store code runs.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Each queued entry answers the next query in order; anything past the queue
// resolves empty, which is the "no row" case both fixes hinge on.
const queries = [];
const answers = [];
vi.mock('../api/_lib/db.js', () => ({
	sql: Object.assign(
		vi.fn((strings, ...values) => {
			queries.push({ text: strings.join(' ? '), values });
			return Promise.resolve(answers.length ? answers.shift() : []);
		}),
		{ transaction: vi.fn(async (fns) => { for (const f of fns) await f; }) },
	),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const { muteUser, getThread } = await import('../api/_lib/friends-store.js');

const ME = '00000000-0000-0000-0000-0000000000aa';
const OTHER = '00000000-0000-0000-0000-0000000000bb';
const CURSOR = '00000000-0000-0000-0000-0000000000cc';

beforeEach(() => {
	queries.length = 0;
	answers.length = 0;
});

describe('muteUser target validation', () => {
	it('answers 404 for an unknown target instead of letting a foreign key raise a 500', async () => {
		// The existence lookup returns no row.
		await expect(muteUser(ME, OTHER)).rejects.toMatchObject({ status: 404, code: 'not_found' });
		// Nothing was inserted: the lookup is the only query that ran.
		expect(queries).toHaveLength(1);
		expect(queries[0].text).toMatch(/from users/);
		expect(queries.some((q) => /insert into user_mutes/.test(q.text))).toBe(false);
	});

	it('inserts the mute once the target resolves', async () => {
		answers.push([{ id: OTHER }]);
		await expect(muteUser(ME, OTHER)).resolves.toEqual({ ok: true });
		const insert = queries.find((q) => /insert into user_mutes/.test(q.text));
		expect(insert).toBeTruthy();
		expect(insert.values).toEqual([ME, OTHER]);
		// The conflict clause keeps a repeat mute idempotent rather than a 23505.
		expect(insert.text).toMatch(/on conflict/);
	});

	it('still refuses a self-mute before spending a query on it', async () => {
		await expect(muteUser(ME, ME)).rejects.toMatchObject({ status: 400, code: 'self_mute' });
		expect(queries).toHaveLength(0);
	});

	it('does not treat a soft-deleted account as a mutable target', async () => {
		answers.push([]);
		await expect(muteUser(ME, OTHER)).rejects.toMatchObject({ status: 404 });
		expect(queries[0].text).toMatch(/deleted_at is null/);
	});
});

describe('getThread cursor handling', () => {
	it('rejects a cursor that is not part of this thread', async () => {
		// The scoped cursor lookup finds nothing.
		await expect(getThread(ME, OTHER, { beforeId: CURSOR })).rejects.toMatchObject({
			status: 400,
			code: 'bad_cursor',
		});
		// It never went on to fetch a (silently empty) page.
		expect(queries).toHaveLength(1);
	});

	it('scopes the cursor lookup to the pair, so a foreign message id cannot be paged against', async () => {
		answers.push([]);
		await getThread(ME, OTHER, { beforeId: CURSOR }).catch(() => {});
		const lookup = queries[0];
		expect(lookup.text).toMatch(/select created_at from direct_messages/);
		expect(lookup.text).toMatch(/sender_id/);
		expect(lookup.text).toMatch(/recipient_id/);
		// The cursor id AND both sides of the thread are bound into the lookup.
		expect(lookup.values).toEqual([CURSOR, ME, OTHER, OTHER, ME]);
	});

	it('pages on the resolved timestamp when the cursor is valid', async () => {
		const ts = new Date('2026-08-01T00:00:00.000Z');
		answers.push([{ created_at: ts }]);
		answers.push([
			{ id: 'm-2', sender_id: OTHER, recipient_id: ME, body: 'older two', created_at: ts, read_at: null },
			{ id: 'm-1', sender_id: ME, recipient_id: OTHER, body: 'older one', created_at: ts, read_at: ts },
		]);
		const out = await getThread(ME, OTHER, { beforeId: CURSOR });
		const page = queries[1];
		// The timestamp is bound as a value; the raw cursor id never reaches the page query.
		expect(page.values).toContain(ts);
		expect(page.values).not.toContain(CURSOR);
		// Rows come back newest-first and are reversed into oldest-to-newest for the UI.
		expect(out.map((m) => m.id)).toEqual(['m-1', 'm-2']);
		expect(out[0]).toMatchObject({ from: ME, to: OTHER, body: 'older one', mine: true, read: true });
		expect(out[1]).toMatchObject({ mine: false, read: false });
	});

	it('runs a single unfiltered query when there is no cursor', async () => {
		answers.push([]);
		await expect(getThread(ME, OTHER)).resolves.toEqual([]);
		expect(queries).toHaveLength(1);
		expect(queries[0].text).not.toMatch(/created_at </);
	});

	it('clamps the page size to the store cap', async () => {
		answers.push([]);
		await getThread(ME, OTHER, { limit: 5000 });
		expect(queries[0].values).toContain(100);
		queries.length = 0;
		answers.push([]);
		await getThread(ME, OTHER, { limit: 0 });
		expect(queries[0].values).toContain(1);
	});
});
