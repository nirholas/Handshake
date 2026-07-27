import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIrl, ThreeWsError } from '../src/index.js';

// A scripted fetch double: each call shifts the next queued response and records
// the request. No network, no real endpoints — we assert on request shaping and
// response parsing, which is all the SDK is responsible for.
function stubFetch(responses) {
	const calls = [];
	const queue = [...responses];
	const fetch = async (url, init) => {
		calls.push({ url: new URL(url), init });
		const next = queue.shift();
		if (!next) throw new Error('stubFetch: no more queued responses');
		const { status = 200, body = {}, headers = {} } = next;
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: { get: (k) => headers[k.toLowerCase()] ?? null },
			text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
		};
	};
	return { fetch, calls };
}

test('checkIn() mints a fix token from an explicit fix and returns the cell', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { token: 'tok.sig', expires_in: 180, cell: 'dr5regw' } },
	]);
	const client = createIrl({ fetch, baseUrl: 'https://three.ws' });
	const presence = await client.checkIn({ lat: 40.7411, lng: -73.9897 });

	assert.equal(calls[0].url.pathname, '/api/irl/fix-token');
	assert.equal(calls[0].init.method, 'POST');
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.lat, 40.7411);
	assert.equal(sent.lng, -73.9897);
	assert.equal(presence.token, 'tok.sig');
	assert.equal(presence.expiresIn, 180);
	assert.equal(presence.cell, 'dr5regw');
	assert.equal(presence.lat, 40.7411);
});

test('checkIn() falls back to a locally computed cell when the response omits it', async () => {
	const { fetch } = stubFetch([{ body: { token: 't.s', expires_in: 180 } }]);
	const client = createIrl({ fetch });
	const presence = await client.checkIn({ lat: 40.7411, lng: -73.9897 });
	assert.equal(typeof presence.cell, 'string');
	assert.equal(presence.cell.length, 7);
});

test('nearby() sends the fix token in the x-irl-fix header and shapes pins to camelCase', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { pins: [
			{ id: 'p1', agent_id: 'a1', lat: 40.74110, lng: -73.98970, heading: 90, distance_m: 12,
			  avatar_url: 'https://three.ws/cdn/scout.glb', avatar_name: 'Scout', caption: 'gm',
			  x402_endpoint: null, view_count: 3, avatar_version: 2, is_mine: false, room_id: null },
		] } },
	]);
	const client = createIrl({ fetch });
	const presence = { lat: 40.7411, lng: -73.9897, token: 'tok.sig', cell: 'dr5regw' };
	const pins = await client.nearby(presence, { radius: 60 });

	assert.equal(calls[0].url.pathname, '/api/irl/pins');
	assert.equal(calls[0].url.searchParams.get('lat'), '40.7411');
	assert.equal(calls[0].url.searchParams.get('radius'), '60');
	assert.equal(calls[0].init.headers['x-irl-fix'], 'tok.sig');
	assert.equal(pins.length, 1);
	assert.equal(pins[0].agentId, 'a1');
	assert.equal(pins[0].distanceM, 12);
	assert.equal(pins[0].avatarUrl, 'https://three.ws/cdn/scout.glb');
	assert.equal(pins[0].viewCount, 3);
	assert.equal(pins[0].isMine, false);
	assert.equal(pins[0].raw.avatar_name, 'Scout');
});

test('nearby() rejects a non-finite radius before any network call', async () => {
	const { fetch, calls } = stubFetch([]);
	const client = createIrl({ fetch });
	await assert.rejects(
		() => client.nearby({ lat: 1, lng: 2, token: 't.s' }, { radius: Number('abc') }),
		(e) => { assert.ok(e instanceof ThreeWsError); assert.equal(e.code, 'invalid_input'); return true; },
	);
	assert.equal(calls.length, 0);
});

test('placePin() posts the body and exposes the permanent flag', async () => {
	const { fetch, calls } = stubFetch([
		{ status: 201, body: { pin: { id: 'p9', lat: 40.7411, lng: -73.9897, avatar_name: 'Scout',
			caption: 'Say hi — I drop $THREE alpha here', avatar_url: 'https://three.ws/cdn/scout.glb',
			expires_at: null, permanent: true } } },
	]);
	const client = createIrl({ fetch });
	const { pin } = await client.placePin({
		lat: 40.7411, lng: -73.9897, avatarName: 'Scout',
		avatarUrl: 'https://three.ws/cdn/scout.glb', caption: 'Say hi — I drop $THREE alpha here',
	});

	assert.equal(calls[0].url.pathname, '/api/irl/pins');
	assert.equal(calls[0].init.method, 'POST');
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.lat, 40.7411);
	assert.equal(sent.avatarName, 'Scout');
	assert.equal(pin.id, 'p9');
	assert.equal(pin.permanent, true);
	assert.equal(pin.avatarName, 'Scout');
});

test('placePin() validates coordinates and placementKind before the network', async () => {
	const { fetch, calls } = stubFetch([]);
	const client = createIrl({ fetch });
	await assert.rejects(() => client.placePin({ lat: 'x', lng: 2 }), /finite/);
	await assert.rejects(() => client.placePin({ lat: 200, lng: 2 }), /out of range/);
	await assert.rejects(() => client.placePin({ lat: 1, lng: 2, placementKind: 'fuzzy' }), /Invalid placementKind/);
	assert.equal(calls.length, 0);
});

test('myPins() with a device token reads /pins/mine and sends x-irl-device (never the URL)', async () => {
	const { fetch, calls } = stubFetch([
		{ body: { pins: [{ id: 'm1', lat: 51.5079, lng: -0.0877, avatar_name: 'Guide', view_count: 0, expires_at: '2099-01-01' }] } },
	]);
	const client = createIrl({ fetch, deviceToken: 'dev-123' });
	const mine = await client.myPins();

	assert.equal(calls[0].url.pathname, '/api/irl/pins/mine');
	assert.equal(calls[0].init.headers['x-irl-device'], 'dev-123');
	assert.equal(calls[0].url.searchParams.get('deviceToken'), null, 'token must never ride the URL');
	assert.equal(mine[0].avatarName, 'Guide');
	assert.equal(mine[0].permanent, false);
});

test('myPins() without a device token uses the signed-in ?mine=1 form', async () => {
	const { fetch, calls } = stubFetch([{ body: { pins: [] } }]);
	const client = createIrl({ fetch });
	await client.myPins();
	assert.equal(calls[0].url.pathname, '/api/irl/pins');
	assert.equal(calls[0].url.searchParams.get('mine'), '1');
});

test('interact() posts pinId/type and shapes the interaction response', async () => {
	const { fetch, calls } = stubFetch([
		{ status: 201, body: { ok: true, interaction: { id: 'i1', type: 'tap', created_at: '2026-06-23T00:00:00Z' }, notified: false } },
	]);
	const client = createIrl({ fetch, deviceToken: 'dev-9' });
	const out = await client.interact({ pinId: 'p1', type: 'tap', message: 'Found you in Madison Square Park' });

	assert.equal(calls[0].url.pathname, '/api/irl/interactions');
	const sent = JSON.parse(calls[0].init.body);
	assert.equal(sent.pinId, 'p1');
	assert.equal(sent.type, 'tap');
	assert.equal(calls[0].init.headers['x-irl-device'], 'dev-9');
	assert.equal(out.ok, true);
	assert.equal(out.id, 'i1');
	assert.equal(out.type, 'tap');
});

test('interact() rejects an unknown type and a missing pinId before the network', async () => {
	const { fetch, calls } = stubFetch([]);
	const client = createIrl({ fetch });
	await assert.rejects(() => client.interact({ pinId: 'p1', type: 'wave' }), /Invalid type/);
	await assert.rejects(() => client.interact({ type: 'tap' }), /needs a `pinId`/);
	assert.equal(calls.length, 0);
});

test('a lapsed presence surfaces as fix_required ThreeWsError', async () => {
	const { fetch } = stubFetch([
		{ status: 401, body: { error: 'fix_required', reason: 'expired', error_description: 'a fresh location fix is required to read nearby agents' } },
	]);
	const client = createIrl({ fetch });
	await assert.rejects(
		() => client.nearby({ lat: 1, lng: 2, token: 'stale.tok' }),
		(e) => {
			assert.ok(e instanceof ThreeWsError);
			assert.equal(e.code, 'fix_required');
			assert.equal(e.status, 401);
			return true;
		},
	);
});

test('area_full (429) surfaces as a typed ThreeWsError on placePin', async () => {
	const { fetch } = stubFetch([
		{ status: 429, body: { error: 'area_full', message: 'This area already has the maximum number of agents. Try another spot.' } },
	]);
	const client = createIrl({ fetch });
	await assert.rejects(
		() => client.placePin({ lat: 40.7411, lng: -73.9897, avatarName: 'Scout' }),
		(e) => { assert.ok(e instanceof ThreeWsError); assert.equal(e.code, 'area_full'); assert.equal(e.status, 429); return true; },
	);
});

test('purgePins() requires a device token and targets all=1', async () => {
	const { fetch, calls } = stubFetch([{ body: { ok: true, deleted: 4 } }]);
	const noTok = createIrl({ fetch });
	await assert.rejects(() => noTok.purgePins(), /needs a device token/);
	assert.equal(calls.length, 0);

	const client = createIrl({ fetch, deviceToken: 'dev-7' });
	const out = await client.purgePins();
	assert.equal(calls[0].init.method, 'DELETE');
	assert.equal(calls[0].url.searchParams.get('all'), '1');
	assert.equal(calls[0].init.headers['x-irl-device'], 'dev-7');
	assert.equal(out.deleted, 4);
});

test('removePin() deletes by id and validates input', async () => {
	const { fetch, calls } = stubFetch([{ body: { ok: true } }]);
	const client = createIrl({ fetch, deviceToken: 'dev-2' });
	const out = await client.removePin('11111111-1111-1111-1111-111111111111');
	assert.equal(calls[0].init.method, 'DELETE');
	assert.equal(calls[0].url.searchParams.get('id'), '11111111-1111-1111-1111-111111111111');
	assert.equal(out.ok, true);
	await assert.rejects(() => client.removePin(''), /needs a pin id/);
});
