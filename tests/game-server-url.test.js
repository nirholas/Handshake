// One resolver answers "where is the Colyseus host" for every realtime surface
// (/play via community-net.js, /walk via walk-net.js, the Coin Wars arena via
// src/play/war.js). The order matters more than it looks: pages/play.html and
// pages/temporary.html both bake a PRODUCTION <meta> server URL into the static
// page, so a resolver that reads the meta before checking for localhost sends a
// local dev session straight to the live world. `npm run dev:walk-all` then
// starts a server nobody connects to, and a developer testing a server change
// is silently testing production instead.
//
// /walk shipped its own copy of this logic with exactly that ordering bug until
// it was migrated onto the shared module. These tests pin the order so the copy
// cannot come back.
import { describe, it, expect, afterEach } from 'vitest';
import { defaultGameServerUrl } from '../src/shared/game-server-url.js';

const PROD_META = 'wss://three-ws-multiplayer-93741856042.us-central1.run.app';

/** Install a minimal browser surface: a hostname and whatever metas are asked for. */
function browser({ hostname = 'localhost', protocol = 'http:', metas = {} } = {}) {
	globalThis.location = { hostname, protocol };
	globalThis.window = {};
	globalThis.document = {
		querySelector(sel) {
			const name = /meta\[name="([^"]+)"\]/.exec(sel)?.[1];
			const content = name ? metas[name] : undefined;
			return content === undefined ? null : { getAttribute: () => content };
		},
	};
	return globalThis.window;
}

afterEach(() => {
	delete globalThis.location;
	delete globalThis.window;
	delete globalThis.document;
});

describe('defaultGameServerUrl', () => {
	it('prefers the local server over the production meta baked into the page', () => {
		browser({ hostname: 'localhost', metas: { 'game-server': PROD_META, 'walk-server': PROD_META } });
		expect(defaultGameServerUrl()).toBe('ws://localhost:2567');
	});

	it('treats 127.0.0.1 and 0.0.0.0 as local too', () => {
		for (const host of ['127.0.0.1', '0.0.0.0']) {
			browser({ hostname: host, metas: { 'walk-server': PROD_META } });
			expect(defaultGameServerUrl(), host).toBe(`ws://${host}:2567`);
		}
	});

	it('uses the page meta on a real deployed origin', () => {
		browser({ hostname: 'three.ws', protocol: 'https:', metas: { 'game-server': PROD_META } });
		expect(defaultGameServerUrl()).toBe(PROD_META);
		// /walk's older meta name resolves identically, so both pages agree.
		browser({ hostname: 'three.ws', protocol: 'https:', metas: { 'walk-server': PROD_META } });
		expect(defaultGameServerUrl()).toBe(PROD_META);
	});

	it('honours both runtime override globals ahead of everything else', () => {
		const w1 = browser({ hostname: 'three.ws', protocol: 'https:', metas: { 'game-server': PROD_META } });
		w1.GAME_SERVER_URL = 'wss://ops-override.example/';
		expect(defaultGameServerUrl()).toBe('wss://ops-override.example');

		// WALK_SERVER_URL is the name /walk embeds shipped with first; dropping it
		// would break any embed still setting it.
		const w2 = browser({ hostname: 'three.ws', protocol: 'https:', metas: { 'walk-server': PROD_META } });
		w2.WALK_SERVER_URL = 'wss://legacy-embed.example';
		expect(defaultGameServerUrl()).toBe('wss://legacy-embed.example');
	});

	it('maps a Codespaces port-forward subdomain to the server port', () => {
		browser({ hostname: 'sturdy-happiness-3000.app.github.dev', protocol: 'https:' });
		expect(defaultGameServerUrl()).toBe('wss://sturdy-happiness-2567.app.github.dev');
	});

	it('falls back to same-host:2567 on an unbundled dev origin with nothing configured', () => {
		browser({ hostname: 'dev.box.lan' });
		expect(defaultGameServerUrl()).toBe('ws://dev.box.lan:2567');
	});
});
