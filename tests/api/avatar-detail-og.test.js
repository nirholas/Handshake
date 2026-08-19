// /avatars/:id serves a static shell, so social crawlers used to unfurl every
// shared avatar link with the generic site card. The bot-UA rewrite now lands
// them on api/avatar-detail-og.js, which must render the avatar's real name,
// description, and rendered-image URL - and must never leak anything for a
// private or missing avatar (302 passthrough instead).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeReq, makeRes } from '../_helpers/monetization.js';

const sqlState = { rows: [], calls: 0 };

vi.mock('../../api/_lib/db.js', () => {
	const sql = vi.fn(async () => {
		sqlState.calls += 1;
		return sqlState.rows;
	});
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

const { default: handler } = await import('../../api/avatar-detail-og.js');

const AVATAR_ID = '00000000-0000-4000-8000-000000000042';

async function invokeHtml(reqOpts) {
	const req = makeReq(reqOpts);
	const res = makeRes();
	await handler(req, res);
	return { status: res.statusCode, headers: res.headers, html: res.body };
}

beforeEach(() => {
	sqlState.rows = [];
	sqlState.calls = 0;
});

describe('avatar-detail-og', () => {
	it('rejects a non-GET method with 405 before touching the db', async () => {
		const { status } = await invokeHtml({
			method: 'POST',
			url: `/api/avatar-detail-og?id=${AVATAR_ID}`,
		});
		expect(status).toBe(405);
		expect(sqlState.calls).toBe(0);
	});

	it('302-passthroughs a malformed id without querying', async () => {
		const { status, headers } = await invokeHtml({
			url: '/api/avatar-detail-og?id=not-a-uuid',
		});
		expect(status).toBe(302);
		expect(headers.location).toMatch(/\/gallery$/);
		expect(sqlState.calls).toBe(0);
	});

	it('302-passthroughs an unknown avatar', async () => {
		const { status, headers } = await invokeHtml({
			url: `/api/avatar-detail-og?id=${AVATAR_ID}`,
		});
		expect(status).toBe(302);
		expect(headers.location).toMatch(/\/gallery$/);
		expect(sqlState.calls).toBe(1);
	});

	it('renders OG meta from the avatar record for a public avatar', async () => {
		sqlState.rows = [
			{
				id: AVATAR_ID,
				name: 'Nova <Scout>',
				description: 'A chrome scout.',
				tags: ['scout', 'chrome'],
				model_category: 'avatar',
				owner_username: 'nirholas',
			},
		];
		const { status, headers, html } = await invokeHtml({
			url: `/api/avatar-detail-og?id=${AVATAR_ID}`,
		});
		expect(status).toBe(200);
		expect(headers['content-type']).toContain('text/html');
		// Name is escaped, description + byline + tags flow into og:description.
		expect(html).toContain('Nova &lt;Scout&gt;');
		expect(html).toContain('A chrome scout.');
		expect(html).toContain('@nirholas');
		expect(html).toContain(`/api/avatars/${AVATAR_ID}/og`);
		expect(html).toContain(`/avatars/${AVATAR_ID}`);
		expect(html).toContain('og:image');
		expect(html).toContain('twitter:card');
		expect(html).toMatch(/rel="canonical"/);
	});
});
