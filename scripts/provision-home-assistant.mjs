#!/usr/bin/env node
// Drives a fresh Home Assistant container through onboarding and prints a
// long-lived access token, so every order in the home campaign can verify
// against a REAL instance instead of a mock.
//
// A throwaway instance plus a usable token, in two commands:
//
//   docker run -d --name threews-ha -p 8123:8123 -v "$PWD/.ha-config:/config" \
//     ghcr.io/home-assistant/home-assistant:stable
//   node scripts/provision-home-assistant.mjs --url http://localhost:8123 --demo
//
// It prints shell-ready exports:
//
//   export HOME_ASSISTANT_URL=http://localhost:8123
//   export HOME_ASSISTANT_TOKEN=eyJhbGciOi...
//
// --demo appends the `demo:` integration to the instance's configuration.yaml
// through Home Assistant's own file API is not a thing, so it is written by the
// caller; this script instead creates areas, a floor and a scene over the
// WebSocket API, which is what the room graph actually reads.
//
// The credentials it creates are throwaway QA credentials for a local container.
// Never point this at an instance that controls a real building.

const args = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};

const HA = String(arg('url', process.env.HOME_ASSISTANT_URL || 'http://localhost:8123')).replace(/\/+$/, '');
const USERNAME = arg('username', 'threews');
const PASSWORD = arg('password', 'threews-home-qa');
const CLIENT_ID = `${HA}/`;
const wantRooms = args.includes('--rooms');

const log = (...a) => console.error('[provision]', ...a);

async function post(path, body, { form = false, token = null } = {}) {
	const headers = { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' };
	if (token) headers.authorization = `Bearer ${token}`;
	const res = await fetch(`${HA}${path}`, {
		method: 'POST',
		headers,
		body: body === undefined ? undefined : form ? new URLSearchParams(body) : JSON.stringify(body),
	});
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		// Home Assistant answers a few onboarding errors with an HTML page.
	}
	if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${text.slice(0, 300)}`);
	return json;
}

async function onboardingSteps() {
	const res = await fetch(`${HA}/api/onboarding`);
	if (!res.ok) throw new Error(`GET /api/onboarding -> ${res.status}`);
	return res.json();
}

/** One authenticated WebSocket session, with a promise per command id. */
async function openSocket(token) {
	const ws = new WebSocket(`${HA.replace(/^http/, 'ws')}/api/websocket`);
	const pending = new Map();
	let nextId = 1;

	await new Promise((resolve, reject) => {
		ws.addEventListener('error', () => reject(new Error(`Could not open a WebSocket to ${HA}.`)), { once: true });
		ws.addEventListener('message', (event) => {
			const msg = JSON.parse(event.data);
			if (msg.type === 'auth_required') {
				ws.send(JSON.stringify({ type: 'auth', access_token: token }));
				return;
			}
			if (msg.type === 'auth_ok') return resolve();
			if (msg.type === 'auth_invalid') return reject(new Error('Home Assistant rejected the access token.'));
			const entry = pending.get(msg.id);
			if (!entry) return;
			pending.delete(msg.id);
			msg.success ? entry.resolve(msg.result) : entry.reject(new Error(JSON.stringify(msg.error)));
		});
	});

	return {
		send(payload) {
			const id = nextId++;
			return new Promise((resolve, reject) => {
				pending.set(id, { resolve, reject });
				ws.send(JSON.stringify({ id, ...payload }));
			});
		},
		close() {
			ws.close();
		},
	};
}

const steps = await onboardingSteps();
const userDone = steps.find((s) => s.step === 'user')?.done;

let bearer;
if (userDone) {
	log('already onboarded, signing in as', USERNAME);
	bearer = await signIn();
} else {
	const created = await post('/api/onboarding/users', {
		client_id: CLIENT_ID,
		name: 'three.ws QA',
		username: USERNAME,
		password: PASSWORD,
		language: 'en',
	});
	const token = await post('/auth/token', { grant_type: 'authorization_code', code: created.auth_code, client_id: CLIENT_ID }, { form: true });
	bearer = token.access_token;
	log('created the owner account');

	for (const step of ['core_config', 'analytics']) {
		try {
			await post(`/api/onboarding/${step}`, undefined, { token: bearer });
		} catch (err) {
			// analytics is optional on some builds and answers 403 once done.
			log(`onboarding ${step}:`, String(err.message).slice(0, 120));
		}
	}
	await post('/api/onboarding/integration', { client_id: CLIENT_ID, redirect_uri: `${HA}/?auth_callback=1` }, { token: bearer });
	log('onboarding complete');
}

/** The login flow, for an instance that is already onboarded. */
async function signIn() {
	const flow = await post('/auth/login_flow', {
		client_id: CLIENT_ID,
		handler: ['homeassistant', null],
		redirect_uri: `${HA}/?auth_callback=1`,
	});
	const step = await post(`/auth/login_flow/${flow.flow_id}`, { client_id: CLIENT_ID, username: USERNAME, password: PASSWORD });
	if (!step.result) throw new Error(`login failed: ${JSON.stringify(step).slice(0, 200)}`);
	const token = await post('/auth/token', { grant_type: 'authorization_code', code: step.result, client_id: CLIENT_ID }, { form: true });
	return token.access_token;
}

const socket = await openSocket(bearer);
const longLived = await socket.send({ type: 'auth/long_lived_access_token', client_name: `three.ws ${Date.now()}`, lifespan: 3650 });

if (wantRooms) {
	const floors = await socket.send({ type: 'config/floor_registry/list' });
	let floorId = floors[0]?.floor_id;
	if (!floorId) {
		const floor = await socket.send({ type: 'config/floor_registry/create', name: 'Ground floor', level: 0 });
		floorId = floor.floor_id;
		log('created floor', floor.name);
	}
	const areas = await socket.send({ type: 'config/area_registry/list' });
	// Home Assistant slugs an area name into its id, so "Living room" and
	// "living_room" collide. Compare on the slug, not on the display name.
	const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '');
	const have = new Set(areas.flatMap((a) => [slug(a.name), slug(a.area_id)]));
	for (const name of ['Kitchen', 'Living room', 'Bedroom']) {
		if (have.has(slug(name))) continue;
		await socket.send({ type: 'config/area_registry/create', name, floor_id: floorId });
		log('created area', name);
	}
}

socket.close();

process.stdout.write(`export HOME_ASSISTANT_URL=${HA}\nexport HOME_ASSISTANT_TOKEN=${longLived}\n`);
