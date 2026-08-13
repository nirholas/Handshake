// Tests for GET /api/frames/walk, the Farcaster frame that turns a Walk
// capture into a castable card. The interesting behaviour is avatar
// resolution: a cast lives forever, but the avatar it points at can be
// deleted or flipped to private, and a frame button that loads nothing is
// worse than a generic one. The DB is mocked so the suite runs offline.

import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.PUBLIC_APP_ORIGIN ||= 'https://three.ws';

const avatarState = { avatar: null, throws: null };
const getAvatar = vi.fn(async ({ id }) => {
	if (avatarState.throws) throw avatarState.throws;
	return avatarState.avatar && avatarState.avatar.id === id ? avatarState.avatar : null;
});
vi.mock('../../api/_lib/avatars.js', () => ({ getAvatar: (...a) => getAvatar(...a) }));

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async () => []),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const handler = (await import('../../api/frames/walk.js')).default;

const AVATAR_ID = '6f1e9c2a-1111-4bbb-8ccc-0123456789ab';

function makeRes() {
	return {
		statusCode: 200,
		_h: {},
		_body: null,
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		end(b) { this.writableEnded = true; this.headersSent = true; if (b != null) this._body = b; },
	};
}

async function invoke(query = '', { method = 'GET' } = {}) {
	const req = { method, url: `/api/frames/walk${query}`, headers: { host: 'three.ws' } };
	const res = makeRes();
	await handler(req, res);
	return { res, html: res._body == null ? '' : String(res._body) };
}

// Pull a meta tag's content back out, undoing the handler's entity escaping.
function meta(html, key) {
	const re = new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`);
	const m = html.match(re);
	if (!m) return null;
	return m[1]
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

beforeEach(() => {
	avatarState.avatar = null;
	avatarState.throws = null;
	getAvatar.mockClear();
});

describe('GET /api/frames/walk', () => {
	it('deep-links a resolvable avatar in both frame versions', async () => {
		avatarState.avatar = { id: AVATAR_ID, name: 'Nova' };
		const { res, html } = await invoke(`?avatar=${AVATAR_ID}&handle=nirholas`);

		expect(res.statusCode).toBe(200);
		expect(res.getHeader('content-type')).toMatch(/text\/html/);
		expect(meta(html, 'og:title')).toBe('Walk Nova on three.ws');

		const deep = `https://three.ws/walk?avatar=${AVATAR_ID}`;
		expect(meta(html, 'fc:frame:button:1:target')).toBe(deep);
		expect(meta(html, 'og:url')).toBe(deep);

		const v2 = JSON.parse(meta(html, 'fc:frame'));
		expect(v2.version).toBe('next');
		expect(v2.button.action.url).toBe(deep);
		expect(v2.imageUrl).toBe(
			`https://three.ws/api/walk-og?avatar=${AVATAR_ID}&handle=nirholas`,
		);
	});

	it('drops an avatar the lookup cannot resolve instead of shipping a dead button', async () => {
		avatarState.avatar = null; // deleted, private, or malformed id
		const { res, html } = await invoke(`?avatar=${AVATAR_ID}`);

		expect(res.statusCode).toBe(200);
		expect(html).not.toContain(AVATAR_ID);
		expect(meta(html, 'fc:frame:button:1:target')).toBe('https://three.ws/walk');
		expect(meta(html, 'fc:frame:button:1')).toBe('Walk your avatar →');
		expect(JSON.parse(meta(html, 'fc:frame')).imageUrl).toBe('https://three.ws/api/walk-og');
	});

	it('keeps the deep link when the lookup itself fails', async () => {
		avatarState.throws = new Error('Missing required env var: DATABASE_URL');
		const { res, html } = await invoke(`?avatar=${AVATAR_ID}`);

		expect(res.statusCode).toBe(200);
		expect(meta(html, 'fc:frame:button:1:target')).toBe(
			`https://three.ws/walk?avatar=${AVATAR_ID}`,
		);
		expect(meta(html, 'og:title')).toBe('Walk your avatar on three.ws');
	});

	it('gives the two frame buttons distinct destinations', async () => {
		const { html } = await invoke('');
		expect(meta(html, 'fc:frame:button:1:target')).toBe('https://three.ws/walk');
		expect(meta(html, 'fc:frame:button:2:target')).toBe('https://three.ws/create');
	});

	it('rejects a non-GET method with a JSON 405', async () => {
		const { res, html } = await invoke('', { method: 'POST' });
		expect(res.statusCode).toBe(405);
		expect(res.getHeader('allow')).toBe('GET, HEAD');
		expect(JSON.parse(html).error).toBe('method_not_allowed');
		expect(getAvatar).not.toHaveBeenCalled();
	});

	it('escapes a hostile handle instead of breaking out of the meta attribute', async () => {
		const { html } = await invoke('?handle=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E');
		expect(html).not.toContain('<script>alert(1)</script>');
		expect(meta(html, 'og:title')).toBe(
			'Walk @"><script>alert(1)</script>\'s avatar on three.ws',
		);
	});
});
