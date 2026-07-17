// Pure coordinate + room-key helpers for the shared AR Studio. DOM-free and
// Three-free so they unit-test directly.
//
// Two frames:
//   • LOCAL — the studio's own scene. A model sits at (x, z) metres on the floor
//     with yaw in radians (Three's Y rotation). Origin is where this device's
//     view started; +x is right, −z is "into the scene / forward".
//   • SHARED (logical) — what rides the wire so every device agrees. relEast /
//     relNorth metres from the room's common origin, yaw in degrees. We map
//     forward (−z) → north and right (+x) → east. When two phones are co-located
//     via a QR marker, the marker frame makes these logical coords land on the
//     same physical spot; otherwise each device just re-bases them to its own
//     floor origin, so everyone sees the same ARRANGEMENT in their own space.

const TAU = Math.PI * 2;

/** Normalize any radian angle into [0, 2π). */
export function normRad(a) {
	if (!Number.isFinite(a)) return 0;
	return ((a % TAU) + TAU) % TAU;
}

/** Normalize any degree angle into [0, 360). */
export function normDeg(d) {
	if (!Number.isFinite(d)) return 0;
	return ((d % 360) + 360) % 360;
}

/**
 * Local scene transform → shared logical transform (for sending over the wire).
 * @param {{ x:number, z:number, yaw:number, scale?:number, height?:number }} t
 *   yaw in RADIANS.
 * @returns {{ relEast:number, relNorth:number, yawDeg:number, scale:number, height:number }}
 */
export function localToShared(t) {
	return {
		relEast: Number(t.x) || 0,
		// `|| 0` also collapses the -0 that negating +0 produces — cleaner on the wire.
		relNorth: -(Number(t.z) || 0) || 0,
		yawDeg: normDeg((normRad(t.yaw) * 180) / Math.PI),
		scale: Number(t.scale) || 1,
		height: Number(t.height) || 0,
	};
}

/**
 * Shared logical transform (from the wire) → local scene transform.
 * @param {{ relEast:number, relNorth:number, yawDeg:number, scale?:number }} s
 * @returns {{ x:number, z:number, yaw:number, scale:number }} yaw in RADIANS.
 */
export function sharedToLocal(s) {
	return {
		x: Number(s.relEast) || 0,
		z: -(Number(s.relNorth) || 0),
		yaw: (normDeg(s.yawDeg) * Math.PI) / 180,
		scale: Number(s.scale) || 1,
	};
}

// ── Room codes ────────────────────────────────────────────────────────────────
// A human-shareable, URL-safe code. Unambiguous alphabet — no 0/O/1/I/L — so a
// code read aloud or typed from a screen doesn't collide. Six chars ≈ 32^6 ≈ 1e9
// combinations, ample for concurrent ephemeral rooms.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;

/**
 * Normalize user-typed room input into a canonical code, or '' if unusable.
 * Accepts a bare code or a pasted /ar/studio?room=CODE URL. Upper-cases, drops
 * the separators a human adds (spaces, hyphens), then validates STRICTLY against
 * the alphabet + length — the generator never emits an ambiguous glyph, so a code
 * carrying one is a mistype, not a near-miss to silently "fix".
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeRoomCode(raw) {
	let s = String(raw ?? '').trim();
	if (!s) return '';
	const m = s.match(/[?&]room=([^&#\s]+)/i);
	if (m) { try { s = decodeURIComponent(m[1]); } catch { s = m[1]; } }
	s = s.toUpperCase().replace(/[\s-]+/g, '');
	if (s.length !== CODE_LEN) return '';
	for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return '';
	return s;
}

/**
 * Generate a fresh room code. `rand` defaults to Math.random but is injectable
 * so tests are deterministic (and so this never trips the workflow-script clock
 * ban — app code only).
 * @param {() => number} [rand]
 * @returns {string}
 */
export function generateRoomCode(rand = Math.random) {
	let out = '';
	for (let i = 0; i < CODE_LEN; i++) {
		out += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
	}
	return out;
}

/**
 * The Colyseus filterBy key for a room code. A code IS its own key; kept as a
 * function so a future co-located (marker) key can funnel through one place.
 * @param {string} code
 * @returns {string}
 */
export function roomKeyForCode(code) {
	return `c-${normalizeRoomCode(code)}`;
}

/** Build the shareable join URL for a room code. */
export function roomShareUrl(origin, code) {
	const c = normalizeRoomCode(code);
	return c ? `${origin}/ar/studio?room=${c}` : `${origin}/ar/studio`;
}
