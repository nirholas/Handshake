// Where the Colyseus game server lives, as seen from a browser.
//
// Every realtime surface on the site has to answer this identically: /play
// (community-net.js), the Coin Wars arena (src/play/war.js), and anything that
// joins a room next, because the resolution order is full of environment
// specifics that are easy to get subtly wrong: a Codespace forwards each port as
// its own subdomain, a local dev server must ignore the production <meta> baked
// into the static page, and production with nothing configured must return ''
// (stay offline) rather than loop forever on a dead socket at :2567.
//
// One implementation, imported by all of them.

/**
 * Resolve the websocket origin for the game server, in priority order:
 *   1. `window.GAME_SERVER_URL`   : a runtime override (ops, embeds)
 *   2. localhost                  : always the local server, never the baked meta
 *   3. `<meta name="game-server">` / `<meta name="walk-server">`
 *   4. `VITE_GAME_SERVER_URL` / `VITE_WALK_SERVER_URL`
 *   5. the Codespaces/Gitpod port-forward subdomain, then same-host:2567 in dev
 * @returns {string} a ws://|wss:// origin, or '' when there is no server to reach
 */
export function defaultGameServerUrl() {
	if (typeof window !== 'undefined' && window.GAME_SERVER_URL) return window.GAME_SERVER_URL;
	// Local dev always talks to the local Colyseus server (`npm run dev:walk-all`),
	// ignoring the production <meta game-server> baked into the static page.
	const host = typeof location !== 'undefined' ? location.hostname : '';
	if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') {
		return `ws://${host}:2567`;
	}
	if (typeof document !== 'undefined') {
		for (const sel of ['meta[name="game-server"]', 'meta[name="walk-server"]']) {
			const v = document.querySelector(sel)?.getAttribute('content')?.trim();
			if (v) return v;
		}
	}
	try {
		const envUrl = import.meta?.env?.VITE_GAME_SERVER_URL || import.meta?.env?.VITE_WALK_SERVER_URL;
		if (envUrl) return String(envUrl).trim().replace(/\/$/, '');
	} catch (_) { /* import.meta.env is absent outside the bundler */ }
	if (typeof location !== 'undefined') {
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		// Codespaces / Gitpod forward each port as its own subdomain (-3000 → -2567).
		const fwd = host.match(/^(.*)-(\d+)\.(app\.github\.dev|githubpreview\.dev|gitpod\.io)$/);
		if (fwd) return `${proto}//${fwd[1]}-2567.${fwd[3]}`;
		// Same-host:2567 is a dev convenience; the public domain doesn't expose
		// :2567. In production with no meta/env configured, return '' so the
		// caller stays single-player instead of looping on a dead socket.
		let isProd = false;
		try { isProd = import.meta?.env?.PROD === true; } catch (_) { /* not bundled */ }
		if (!isProd) return `${proto}//${host}:2567`;
		return '';
	}
	return '';
}
