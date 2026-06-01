// World instances ("servers") — Task 23.
//
// The platform runs N independent world instances on one host. A player picks
// one at login; each (realm, server) pair is its own Colyseus room (see the
// filterBy(['server']) in index.js), so two players on different servers never
// share a realm room, chat, or /who roster. Progression is account-scoped
// (playerStore), so the SAME account sees identical items/gold/skills on either
// server — only presence/visibility is isolated, never the profile.
//
// The roster is configurable without a code change via the GAME_SERVERS env:
//   GAME_SERVERS="s1:Server 1:The original world.,s2:Server 2:A fresh start."
// Each entry is `id:name:blurb` (blurb optional). Ids are matched verbatim as a
// join option, so keep them short, stable, and url-safe — they never change once
// players have progressed, because the profile is shared anyway but the choice
// is remembered per browser.

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,15}$/;

function parseEnv(raw) {
	if (typeof raw !== 'string' || !raw.trim()) return null;
	const out = [];
	const seen = new Set();
	for (const part of raw.split(',')) {
		const [id, name, ...rest] = part.split(':').map((s) => s.trim());
		if (!ID_RE.test(id) || seen.has(id)) continue;
		seen.add(id);
		out.push({ id, name: name || id, blurb: rest.join(':') || '' });
	}
	return out.length ? out : null;
}

// Default roster: two independent worlds on the same host, exactly as the world
// guide describes ("Server 1" / "Server 2").
const DEFAULT_SERVERS = [
	{ id: 's1', name: 'Server 1', blurb: 'The original world. Most players are here.' },
	{ id: 's2', name: 'Server 2', blurb: 'A second, fully independent world.' },
];

export const SERVERS = parseEnv(process.env.GAME_SERVERS) || DEFAULT_SERVERS;
export const SERVER_IDS = new Set(SERVERS.map((s) => s.id));
export const DEFAULT_SERVER = SERVERS[0].id;

// Resolve a client-supplied server id to a real instance, falling back to the
// default so a missing/forged value can never land a player in a non-existent
// world. Mirrors WalkRoom.cleanCoin / cleanTier's "unknown collapses to default"
// contract.
export function cleanServer(v) {
	return typeof v === 'string' && SERVER_IDS.has(v) ? v : DEFAULT_SERVER;
}

export function serverName(id) {
	return SERVERS.find((s) => s.id === id)?.name || id;
}
