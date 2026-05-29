// Coin-world boot — the entry glue for /walk's social layer.
//
// Decides, from the URL, whether the visitor is choosing a world or already in
// one, and mounts the right surface:
//   • no ?coin=  → the coin-world lobby (picker). walk.js still renders the
//                  scene behind it; picking a world navigates to ?coin=<mint>.
//   • ?coin=mint → Town, the live community layer bound to that coin.
//
// This deliberately owns ONLY the CoinCommunities social layer. The 3D scene
// and multiplayer join are walk.js / walk-net.js's job (walk-net reads the same
// ?coin= to scope the room). Idempotent — safe even if the scene also imports
// it — so there's never a double mount.

import { mountLobby } from './coin-lobby.js';
import { mountTown } from './town.js';
import { fetchWorlds } from './town-client.js';

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isCoin = (v) => typeof v === 'string' && MINT_RE.test(v);

function readMeta(coin) {
	try {
		return JSON.parse(sessionStorage.getItem(`town:meta:${coin}`) || '{}');
	} catch {
		return {};
	}
}

async function enrich(town, coin) {
	// Direct link (no lobby handoff) → best-effort identity from the live list.
	try {
		const worlds = await fetchWorlds();
		const w = worlds.find((x) => x.token === coin);
		if (w)
			town.updateMeta({
				symbol: w.symbol,
				image: w.image,
				members: w.members,
				posts: w.posts,
			});
	} catch {
		/* feed still works without the badge; leave the neutral placeholder */
	}
}

export function boot() {
	if (window.__townBoot) return window.__townBoot;
	const coin = new URLSearchParams(location.search).get('coin');

	if (!isCoin(coin)) {
		window.__townBoot = { mode: 'lobby', lobby: mountLobby() };
		return window.__townBoot;
	}

	const meta = readMeta(coin);
	const town = mountTown({ token: coin, meta });
	if (!meta.symbol) enrich(town, coin);
	window.__town = town;
	window.__townBoot = { mode: 'world', town };
	return window.__townBoot;
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
	boot();
}
