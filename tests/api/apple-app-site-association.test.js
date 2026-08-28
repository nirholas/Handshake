/**
 * /.well-known/apple-app-site-association
 *
 * The file iOS fetches to decide whether a three.ws link opens the app instead
 * of Safari. Its failure mode is the reason it is tested: a wrong or absent
 * association produces no error anywhere. Links simply keep opening in Safari,
 * on every device, until someone thinks to check. So the two things worth
 * pinning are that it never publishes an association for a team that cannot
 * sign (which is what an empty APPLE_TEAM_ID would do), and that the app
 * identifier is exactly "<Team ID>.<bundle id>" with no stray whitespace from
 * a value pasted out of the developer portal.
 */

import { describe, it, expect, afterEach } from 'vitest';
import handler from '../../api/wk.js';

const NAME = 'apple-app-site-association';
const BUNDLE_ID = 'ws.three.app';

function fakeRes() {
	const headers = {};
	return {
		statusCode: 0,
		body: undefined,
		setHeader(k, v) {
			headers[String(k).toLowerCase()] = v;
		},
		getHeader(k) {
			return headers[String(k).toLowerCase()];
		},
		end(b) {
			this.body = b;
		},
		_headers: headers,
	};
}

async function call() {
	const res = fakeRes();
	await handler(
		{ method: 'GET', headers: {}, url: `/api/wk?name=${NAME}`, query: { name: NAME } },
		res,
	);
	return { res, json: res.body ? JSON.parse(res.body) : undefined };
}

const original = process.env.APPLE_TEAM_ID;

afterEach(() => {
	if (original === undefined) delete process.env.APPLE_TEAM_ID;
	else process.env.APPLE_TEAM_ID = original;
});

describe('/.well-known/apple-app-site-association', () => {
	it('refuses to publish an association when no Team ID is configured', async () => {
		delete process.env.APPLE_TEAM_ID;
		const { res, json } = await call();
		expect(res.statusCode).toBe(503);
		expect(json.error).toBe('not_configured');
		expect(JSON.stringify(json)).not.toContain('applinks');
	});

	it('treats a whitespace-only Team ID as unconfigured', async () => {
		process.env.APPLE_TEAM_ID = '   ';
		const { res } = await call();
		expect(res.statusCode).toBe(503);
	});

	it('publishes applinks and webcredentials for <team>.<bundle>', async () => {
		process.env.APPLE_TEAM_ID = 'A1B2C3D4E5';
		const { res, json } = await call();
		expect(res.statusCode).toBe(200);
		const appId = `A1B2C3D4E5.${BUNDLE_ID}`;
		expect(json.applinks.details).toHaveLength(1);
		expect(json.applinks.details[0].appIDs).toEqual([appId]);
		expect(json.webcredentials.apps).toEqual([appId]);
	});

	it('trims a Team ID pasted with surrounding whitespace', async () => {
		process.env.APPLE_TEAM_ID = '\n A1B2C3D4E5 \t';
		const { json } = await call();
		expect(json.applinks.details[0].appIDs).toEqual([`A1B2C3D4E5.${BUNDLE_ID}`]);
	});

	it('keeps the API and the third-party embed entries out of the app', async () => {
		process.env.APPLE_TEAM_ID = 'A1B2C3D4E5';
		const { json } = await call();
		const components = json.applinks.details[0].components;
		const excluded = components.filter((c) => c.exclude).map((c) => c['/']);
		expect(excluded).toEqual(expect.arrayContaining(['/api/*', '/embed*', '/widget*']));
		// Order matters to iOS: it takes the first matching component, so the
		// catch-all has to come last or the exclusions never apply.
		expect(components.at(-1)).toEqual({ '/': '/*' });
	});

	it('is served as JSON, which is what Apple requires of this path', async () => {
		process.env.APPLE_TEAM_ID = 'A1B2C3D4E5';
		const { res } = await call();
		expect(String(res.getHeader('content-type'))).toContain('application/json');
	});
});
