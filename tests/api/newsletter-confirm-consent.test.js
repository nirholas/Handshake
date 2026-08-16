// GET /api/newsletter-confirm decides whether a click puts an address back on
// the list, so the interesting cases are the ones where it must NOT.
//
// The confirm link and the unsubscribe link in a three.ws email carry the SAME
// token, and only a fresh POST /api/newsletter-subscribe rotates it. So an
// unsubscribed reader who later opened an older email and clicked "confirm"
// was silently re-subscribed: a consent failure with no way for them to see it
// happened. Opting back in has to start from the site.
//
// The DB is the only thing stubbed here (these are pure SQL branches), plus the
// Resend audience client, which is not configured in tests anyway.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rows = { current: [] };
const executed = [];

vi.mock('../../api/_lib/db.js', () => ({
	sql: (strings, ...values) => {
		const text = strings.join('?').replace(/\s+/g, ' ').trim();
		executed.push({ text, values });
		if (/^update/i.test(text)) {
			rows.current = rows.current.map((r) => ({ ...r, status: 'confirmed' }));
			return Promise.resolve([]);
		}
		return Promise.resolve(rows.current);
	},
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
	limits: { newsletterConfirmIp: vi.fn(async () => ({ success: true, reset: Date.now() + 1000 })) },
	clientIp: vi.fn(() => '203.0.113.9'),
}));

const addToAudience = vi.fn(async () => {});
vi.mock('../../api/_lib/newsletter.js', async (importOriginal) => ({
	...(await importOriginal()),
	addToAudience,
}));

const { default: handler } = await import('../../api/newsletter-confirm.js');

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		setHeader(k, v) {
			this.headers[String(k).toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[String(k).toLowerCase()];
		},
		end(body) {
			this.body = body ?? '';
		},
	};
}

async function confirm(token) {
	const res = makeRes();
	await handler(
		{ method: 'GET', url: `/api/newsletter-confirm?token=${token}`, headers: {} },
		res,
	);
	return res;
}

const heading = (res) => (res.body.match(/<h1>([^<]*)<\/h1>/) || [])[1] || '';
const didUpdate = () => executed.some((q) => /^update/i.test(q.text));

beforeEach(() => {
	rows.current = [];
	executed.length = 0;
	addToAudience.mockClear();
});

describe('GET /api/newsletter-confirm', () => {
	it('confirms a pending subscriber and adds them to the audience', async () => {
		rows.current = [{ email: 'reader@example.com', status: 'pending', locale: 'en' }];
		const res = await confirm('a-valid-token');
		expect(res.statusCode).toBe(200);
		expect(heading(res)).toBe("You're in");
		expect(didUpdate()).toBe(true);
		expect(addToAudience).toHaveBeenCalledWith('reader@example.com', 'en');
	});

	it('will not re-subscribe someone who unsubscribed, whatever the token says', async () => {
		rows.current = [{ email: 'reader@example.com', status: 'unsubscribed', locale: 'en' }];
		const res = await confirm('the-same-old-token');
		expect(res.statusCode).toBe(200);
		expect(heading(res)).toBe("You're unsubscribed");
		expect(didUpdate()).toBe(false);
		expect(addToAudience).not.toHaveBeenCalled();
	});

	it('is a no-op for an already-confirmed subscriber', async () => {
		rows.current = [{ email: 'reader@example.com', status: 'confirmed', locale: 'en' }];
		const res = await confirm('a-valid-token');
		expect(res.statusCode).toBe(200);
		expect(heading(res)).toBe("You're already subscribed");
		expect(didUpdate()).toBe(false);
		expect(addToAudience).not.toHaveBeenCalled();
	});

	it('shows a neutral page for an unknown token and touches nothing', async () => {
		rows.current = [];
		const res = await confirm('no-such-token');
		expect(res.statusCode).toBe(404);
		expect(heading(res)).toBe('Link expired');
		expect(didUpdate()).toBe(false);
	});

	it('rejects a missing or oversized token before it reaches the database', async () => {
		for (const token of ['', 'x'.repeat(129)]) {
			executed.length = 0;
			const res = await confirm(token);
			expect(res.statusCode).toBe(400);
			expect(heading(res)).toBe('Invalid link');
			expect(executed).toHaveLength(0);
		}
	});

	it('renders HTML, so the click lands on a page and not a JSON blob', async () => {
		rows.current = [{ email: 'reader@example.com', status: 'confirmed', locale: null }];
		const res = await confirm('a-valid-token');
		expect(res.headers['content-type']).toContain('text/html');
	});
});
