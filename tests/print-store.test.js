/**
 * The Materialize order state machine: what it lets through, what it refuses,
 * and the two things a transition is besides a column write (a timeline row,
 * and, at `shipped`, the certificate).
 *
 * The rules that matter here are the ones that cost money or trust when they
 * are wrong: a sold-out edition must be refused where the price is set rather
 * than after payment, an illegal move must throw instead of silently no-opping,
 * two writers must not both move the same order, and a certificate that cannot
 * be minted must never roll back a shipment that physically happened.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = { sql: null };
const certificate = { issue: null };
const editions = { assert: null };
const feed = { published: [] };

vi.mock('../api/_lib/db.js', () => ({
	get sql() {
		return db.sql;
	},
}));
vi.mock('../api/_lib/print/certificate.js', () => ({
	issueCertificateForOrder: (...args) => certificate.issue(...args),
}));
vi.mock('../api/_lib/print/editions.js', () => ({
	assertEditionAvailable: (...args) => editions.assert(...args),
}));
vi.mock('../api/_lib/feed.js', () => ({
	publishUserEvent: (userId, event) => feed.published.push({ userId, event }),
}));

const {
	transition,
	canTransition,
	appendEvent,
	getOrderWithEvents,
	PRINT_STATUSES,
	TERMINAL_STATUSES,
	LEGAL_TRANSITIONS,
	PrintStoreError,
} = await import('../api/_lib/print-store.js');

/**
 * A double for the two tables a transition touches. `moved` lets a test make
 * the guarded UPDATE match nothing, which is how a lost race looks.
 */
function makeSql(order, { moved = false } = {}) {
	const events = [];
	const state = { order: { ...order }, events };
	state.sql = async (strings, ...values) => {
		const text = strings.join(' ? ').replace(/\s+/g, ' ').trim();
		if (text.startsWith('select * from print_orders')) return [{ ...state.order }];
		if (text.startsWith('update print_orders set')) {
			if (moved) return [];
			state.order = { ...state.order, status: values[0] };
			return [{ ...state.order }];
		}
		if (text.startsWith('insert into print_order_events')) {
			const row = { order_id: values[0], status: values[1], note: values[2], actor: values[3], actor_id: values[4] };
			events.push(row);
			return [row];
		}
		if (text.includes('from print_order_events')) return events.map((e) => ({ ...e }));
		throw new Error(`unhandled query: ${text}`);
	};
	return state;
}

const ORDER = {
	id: '33333333-3333-4333-8333-333333333333',
	status: 'quality_check',
	user_id: '44444444-4444-4444-8444-444444444444',
	creation_id: '11111111-1111-4111-8111-111111111111',
	quantity: 1,
};

beforeEach(() => {
	feed.published = [];
	editions.assert = async () => ({ limit: null, issued: 0, remaining: null, soldOut: false });
	certificate.issue = async () => ({ certificate: { id: 'abcdef0123456789abcdef01' }, created: true, attestation: null });
});

describe('the transition table', () => {
	it('covers every status the database accepts', () => {
		expect(Object.keys(LEGAL_TRANSITIONS).sort()).toEqual([...PRINT_STATUSES].sort());
	});

	it('leaves every terminal status with nowhere to go', () => {
		for (const status of TERMINAL_STATUSES) {
			if (status === 'rejected' || status === 'canceled') continue;
			expect(LEGAL_TRANSITIONS[status]).toEqual([]);
		}
	});

	it('never lets a status transition to itself', () => {
		for (const [from, targets] of Object.entries(LEGAL_TRANSITIONS)) {
			expect(targets).not.toContain(from);
		}
	});

	it('only ever names statuses the database accepts', () => {
		for (const targets of Object.values(LEGAL_TRANSITIONS)) {
			for (const target of targets) expect(PRINT_STATUSES).toContain(target);
		}
	});

	it('walks the happy path end to end', () => {
		const path = ['created', 'quoted', 'paid', 'screening', 'submitted', 'printing', 'quality_check', 'shipped', 'delivered'];
		for (let i = 0; i < path.length - 1; i++) {
			expect(canTransition(path[i], path[i + 1])).toBe(true);
		}
	});

	it('refuses the moves that would skip money or screening', () => {
		expect(canTransition('created', 'paid')).toBe(false);
		expect(canTransition('paid', 'submitted')).toBe(false);
		expect(canTransition('quoted', 'shipped')).toBe(false);
		expect(canTransition('delivered', 'printing')).toBe(false);
	});
});

describe('transition()', () => {
	it('writes the status, appends a timeline row, and notifies the buyer', async () => {
		const state = makeSql(ORDER);
		db.sql = state.sql;
		const out = await transition({ orderId: ORDER.id, to: 'shipped', note: 'boxed', actor: 'operator', actorId: 'op-1' });
		expect(out.order.status).toBe('shipped');
		expect(state.events).toHaveLength(1);
		expect(state.events[0]).toMatchObject({ status: 'shipped', note: 'boxed', actor: 'operator', actor_id: 'op-1' });
		expect(feed.published).toHaveLength(1);
		expect(feed.published[0].event.type).toBe('print_update');
		expect(feed.published[0].event.link).toBe('/cert/abcdef0123456789abcdef01');
	});

	it('issues the certificate exactly when the order ships', async () => {
		const issued = vi.fn(async () => ({ certificate: { id: 'a'.repeat(24) }, created: true, attestation: null }));
		certificate.issue = issued;
		db.sql = makeSql({ ...ORDER, status: 'printing' }).sql;
		await transition({ orderId: ORDER.id, to: 'quality_check' });
		expect(issued).not.toHaveBeenCalled();

		db.sql = makeSql(ORDER).sql;
		await transition({ orderId: ORDER.id, to: 'shipped' });
		expect(issued).toHaveBeenCalledWith({ orderId: ORDER.id });
	});

	it('ships the order even when the certificate cannot be minted, and says so on the timeline', async () => {
		certificate.issue = async () => {
			throw new Error('solana rpc timeout after 20000ms');
		};
		const state = makeSql(ORDER);
		db.sql = state.sql;
		const out = await transition({ orderId: ORDER.id, to: 'shipped' });
		expect(out.order.status).toBe('shipped');
		expect(out.certificate).toBeNull();
		expect(state.events).toHaveLength(2);
		expect(state.events[1].note).toContain('certificate issuance deferred');
	});

	it('refuses an illegal move instead of silently doing nothing', async () => {
		db.sql = makeSql({ ...ORDER, status: 'created' }).sql;
		await expect(transition({ orderId: ORDER.id, to: 'shipped' })).rejects.toMatchObject({
			code: 'illegal_transition',
			from: 'created',
			to: 'shipped',
		});
	});

	it('refuses a status the database has never heard of', async () => {
		db.sql = makeSql(ORDER).sql;
		await expect(transition({ orderId: ORDER.id, to: 'posted' })).rejects.toMatchObject({ code: 'unknown_status' });
	});

	it('reports a lost race with what actually happened', async () => {
		db.sql = makeSql(ORDER, { moved: true }).sql;
		await expect(transition({ orderId: ORDER.id, to: 'shipped' })).rejects.toMatchObject({ code: 'transition_raced' });
	});

	it('does not notify an agent order that has no signed-in buyer', async () => {
		db.sql = makeSql({ ...ORDER, user_id: null }).sql;
		await transition({ orderId: ORDER.id, to: 'shipped' });
		expect(feed.published).toHaveLength(0);
	});
});

describe('quote-time edition enforcement', () => {
	it('checks the edition before an order is priced', async () => {
		const assertion = vi.fn(async () => ({ limit: 25, issued: 3, remaining: 22, soldOut: false }));
		editions.assert = assertion;
		db.sql = makeSql({ ...ORDER, status: 'created', quantity: 2 }).sql;
		await transition({ orderId: ORDER.id, to: 'quoted' });
		expect(assertion).toHaveBeenCalledWith({ creationId: ORDER.creation_id, quantity: 2 });
	});

	it('refuses to quote a sold-out edition, and never writes the status', async () => {
		editions.assert = async () => {
			throw Object.assign(new Error('This edition is sold out. All 5 copies have shipped.'), {
				name: 'PrintEditionError',
				code: 'edition_sold_out',
			});
		};
		const state = makeSql({ ...ORDER, status: 'created' });
		db.sql = state.sql;
		await expect(transition({ orderId: ORDER.id, to: 'quoted' })).rejects.toMatchObject({ code: 'edition_sold_out' });
		expect(state.order.status).toBe('created');
		expect(state.events).toHaveLength(0);
	});

	it('does not re-check the edition on any later transition', async () => {
		const assertion = vi.fn(async () => ({ limit: null, issued: 0, remaining: null, soldOut: false }));
		editions.assert = assertion;
		db.sql = makeSql({ ...ORDER, status: 'quoted' }).sql;
		await transition({ orderId: ORDER.id, to: 'paid' });
		expect(assertion).not.toHaveBeenCalled();
	});
});

describe('appendEvent()', () => {
	it('records an operator note without moving the order', async () => {
		const state = makeSql(ORDER);
		db.sql = state.sql;
		await appendEvent({ orderId: ORDER.id, status: 'quality_check', note: 'reprinting the base', actor: 'operator' });
		expect(state.order.status).toBe('quality_check');
		expect(state.events).toHaveLength(1);
	});

	it('falls back to the system actor rather than writing one the constraint rejects', async () => {
		const state = makeSql(ORDER);
		db.sql = state.sql;
		await appendEvent({ orderId: ORDER.id, status: 'shipped', actor: 'robot' });
		expect(state.events[0].actor).toBe('system');
	});
});

describe('getOrderWithEvents()', () => {
	it('returns the order with its timeline', async () => {
		const state = makeSql(ORDER);
		db.sql = state.sql;
		await appendEvent({ orderId: ORDER.id, status: 'shipped', note: 'first' });
		const out = await getOrderWithEvents(ORDER.id);
		expect(out.id).toBe(ORDER.id);
		expect(out.events).toHaveLength(1);
	});
});

describe('PrintStoreError', () => {
	it('carries a machine-readable code beside its message', () => {
		const err = new PrintStoreError('illegal_transition', 'nope', { from: 'a', to: 'b' });
		expect(err).toBeInstanceOf(Error);
		expect(err.code).toBe('illegal_transition');
		expect(err.from).toBe('a');
	});
});
