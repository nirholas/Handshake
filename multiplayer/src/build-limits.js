// build-limits: the ONE place the build system's numbers live (W-world-online P3.2).
//
// Both sides of the build feature need these: the authoritative room enforces
// them, and the client needs the same values to draw an honest HUD (and to run
// the identical caps while it is building solo against the durable world store,
// P3.1). Duplicating them drifted once already: the client defaulted the
// creator clear radius to a bare `12` in four separate places while the server
// held the only real value: so they are exported from here and imported by
// both. `src/game/*` already imports server modules this way (vehicles,
// world-features, cosmetics-catalog); this is the same pattern.
//
// ── The build radius progression (P3.2) ─────────────────────────────────────
// The creator clear-area sweep used to be a flat 12-cell disc for every world,
// which is a courtyard, not a place. It is now tiered by what the server can
// actually prove about the caller:
//
//   • base    : any world, no proven standing.
//   • holder  : the world is a coin's gated Holders tier, so every player in it
//               passed a signed holder pass (WalkRoom.onAuth). Holders get a
//               bigger canvas: this is the "so holders can build a real place"
//               item from the port checklist.
//   • creator : the caller's verified wallet matches the coin's on-chain
//               creator (WalkRoom._isCreator). World moderation reaches
//               furthest.
//
// The tiers are additive-by-max, never multiplied, so a creator inside their own
// Holders world gets the creator radius rather than a compounded number, and the
// value the client shows is always exactly the value the server clamps to.

// ── world-object budget ─────────────────────────────────────────────────────
// Caps keep the synced Colyseus state and the persisted per-world doc bounded.
// A doc at MAX_WORLD_OBJECTS serializes to a few tens of KB, comfortably inside
// world-store's inline-in-Postgres threshold.
export const MAX_WORLD_OBJECTS = 200;      // total objects one world may hold
export const MAX_OBJECTS_PER_PLAYER = 30;  // how many one owner may have at once
export const OBJ_SCALE_MIN = 0.1;
export const OBJ_SCALE_MAX = 10;

// ── build radius tiers (cells) ──────────────────────────────────────────────
// One grid cell is BLOCK_SIZE_M (1.5 m), so these are 18 m / 36 m / 72 m radii.
export const BUILD_CLEAR_RADIUS_BASE = 12;
export const BUILD_CLEAR_RADIUS_HOLDER = 24;
export const BUILD_CLEAR_RADIUS_CREATOR = 48;
// The widest any caller can ever reach: the absolute clamp on a malformed or
// hostile `r`, independent of the tier the caller actually earned.
export const BUILD_CLEAR_RADIUS_MAX = BUILD_CLEAR_RADIUS_CREATOR;

/**
 * The clear-area radius (in build-grid cells) a caller has earned.
 * Pure and side-effect free so both the room and the HUD can call it.
 *
 * @param {object} [standing]
 * @param {boolean} [standing.creator] verified coin creator (server-proven)
 * @param {boolean} [standing.holder]  inside a coin's gated Holders-tier world
 * @returns {number} radius in cells
 */
export function buildClearRadius({ creator = false, holder = false } = {}) {
	let r = BUILD_CLEAR_RADIUS_BASE;
	if (holder) r = Math.max(r, BUILD_CLEAR_RADIUS_HOLDER);
	if (creator) r = Math.max(r, BUILD_CLEAR_RADIUS_CREATOR);
	return r;
}

/** Human-readable label for the tier a radius came from: used in HUD copy. */
export function buildTierLabel({ creator = false, holder = false } = {}) {
	if (creator) return 'creator';
	if (holder) return 'holder';
	return 'visitor';
}

// ── player-uploaded prop assets (P3.3) ──────────────────────────────────────
// A world prop may point at a model the player uploaded, so the object carries a
// `url`. That url is rendered by every other client in the world, which makes it
// the one client-supplied string in the build system with real blast radius: it
// must resolve to OUR storage and nowhere else. Hosts are matched exactly or as
// a single-label wildcard, mirroring the allow-list style already used by
// packages/loom-mcp/src/lib/viewer.js.
export const PROP_ASSET_URL_MAX = 300;   // schema/type budget for the url string
export const PROP_ASSET_MAX_BYTES = 8 * 1024 * 1024; // 8 MB per placed prop
export const PROP_ASSET_EXTENSIONS = ['.glb', '.vrm'];

const DEFAULT_ASSET_HOSTS = ['three.ws', '*.three.ws', '*.r2.dev', '*.cloudflarestorage.com'];

function assetHosts() {
	const raw = (typeof process !== 'undefined' && process.env?.WORLD_ASSET_HOSTS) || '';
	const configured = raw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
	return configured.length ? configured : DEFAULT_ASSET_HOSTS;
}

function hostAllowed(hostname, patterns) {
	const host = String(hostname || '').toLowerCase();
	for (const pattern of patterns) {
		if (pattern === host) return true;
		if (pattern.startsWith('*.') && host.endsWith(pattern.slice(1))) return true;
	}
	return false;
}

/**
 * Is `url` a model this world may render? Returns the normalized url, or null.
 * Rejects anything that isn't https, on an allowed host, and pointing at a model
 * file: so a `javascript:` payload, an attacker's tracking pixel, or a 300 MB
 * file on someone else's CDN can never reach another player's loader.
 */
export function normalizePropAssetUrl(url) {
	if (typeof url !== 'string') return null;
	const raw = url.trim();
	if (!raw || raw.length > PROP_ASSET_URL_MAX) return null;
	let parsed;
	try {
		parsed = new URL(raw);
	} catch {
		return null;
	}
	if (parsed.protocol !== 'https:') return null;
	if (parsed.username || parsed.password) return null;
	if (!hostAllowed(parsed.hostname, assetHosts())) return null;
	const path = parsed.pathname.toLowerCase();
	if (!PROP_ASSET_EXTENSIONS.some((ext) => path.endsWith(ext))) return null;
	// Drop any query/hash: our storage serves these keys plainly, and stripping
	// them keeps the persisted doc from carrying signed-URL noise that expires.
	return `${parsed.origin}${parsed.pathname}`;
}
