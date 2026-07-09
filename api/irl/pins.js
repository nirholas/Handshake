/**
 * IRL GPS Pins — place 3D agents at real-world GPS coordinates.
 *
 * GET    /api/irl/pins?lat=&lng=&radius=40         nearby pins (public, tight proximity)
 * GET    /api/irl/pins/mine?deviceToken=           my pins (device token or auth)
 * GET    /api/irl/pins?mine=1                      my pins (auth required)
 * POST   /api/irl/pins  { lat, lng, heading, avatarUrl, avatarName, caption, agentId }
 * PATCH  /api/irl/pins  { id, caption, avatarUrl, avatarName, lat, lng }  edit pin (auth required)
 * PATCH  /api/irl/pins  { id, deviceToken, calibrate:{ lat, lng, anchorYawDeg, anchorHeightM } }
 *                                                  owner-gated, bounds-checked pose nudge (A3)
 * PATCH  /api/irl/pins  { deviceToken, calibrateRoom:{ roomId, dEastM, dNorthM, dYawDeg } }
 *                                                  owner-gated, bounds-checked whole-room align (R2)
 * DELETE /api/irl/pins?id=                         remove own pin (device_token or auth)
 * DELETE /api/irl/pins?all=1&deviceToken=          purge every pin from this device → { deleted }
 * POST   /api/irl/pins/interact { pinId, event, deviceToken }  log a tap/view
 */

import { cors, json, wrap, rateLimited } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { WORD_BLACKLIST } from '../../src/profanity.js';
import { guardianConfig, assess, decide } from '../_lib/granite-guardian.js';
import { encodeGeohash } from '../_lib/geohash.js';
import { validateAppearance } from '../_lib/accessories.js';
import { cacheGet, cacheSet } from '../_lib/cache.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { sha256 } from '../_lib/crypto.js';
import { readDeviceToken } from '../_lib/irl-auth.js';
import { verifyFixToken, fixEnforced } from '../_lib/irl-presence.js';
import { calibrateRoomOrigin, pinAbsoluteFromOrigin } from '../../src/irl/room-anchor.js';

// ── Moderation, safety & density caps (D4) ──────────────────────────────────
// Everything below makes the public, shared IRL world safe to launch: content
// gating on caption/name, a $THREE-only coin guard, an x402 endpoint allow-list,
// per-area density caps, and per-owner active-pin caps. Each rejection returns a
// designed error code the client surfaces as an actionable message.

const CAPTION_MAX = 140;          // public caption hard length cap
const NAME_MAX    = 40;           // avatar name hard length cap
const GEOCELL_PRECISION = 7;      // ~153m × 153m density cell
const MAX_PINS_PER_CELL = 40;     // density ceiling per geocell7
const MAX_PINS_PER_OWNER_ANON   = 20;  // active pins for an anonymous device
const MAX_PINS_PER_OWNER_SIGNED = 60;  // higher ceiling once accountable (signed in)

// $THREE is the only coin three.ws references (contract below). The off-brand
// guard is written generically — it never names a competing ticker — so this
// codebase stays clean of other coins while still rejecting shills.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

// Always-on hard gate: lower-case substring match against the shared slur/severe
// list. No external dependency, fails closed and fast — the floor under the
// smarter Guardian tier. Reused verbatim from the pump.fun feed filter.
export function hardBlocked(text) {
	const t = String(text || '').toLowerCase();
	return WORD_BLACKLIST.some((w) => t.includes(w));
}

// Off-brand-coin guard: reject text that shills a token other than $THREE — a
// `$TICKER` cashtag that isn't $THREE, or a pump.fun-style mint address (…pump)
// that isn't the $THREE contract. Generic by construction so no competitor is
// ever written into source; $THREE (cashtag or contract) is explicitly allowed.
export function namesOffBrandCoin(text) {
	const t = String(text || '');
	const cashtags = t.match(/\$[A-Za-z][A-Za-z0-9]{1,9}\b/g) || [];
	if (cashtags.some((c) => c.slice(1).toUpperCase() !== 'THREE')) return true;
	const tokens = t.match(/\b[1-9A-HJ-NP-Za-km-z]{32,48}\b/g) || [];
	if (tokens.some((m) => /pump$/.test(m) && m !== THREE_MINT)) return true;
	return false;
}

// Tier-1 content decision over caption + name. Returns the offending field +
// reason, or null when clean. Pure string work — the cheapest, most decisive gate.
function contentReject(caption, name) {
	if (hardBlocked(caption)) return { field: 'caption', reason: 'blocked' };
	if (hardBlocked(name))    return { field: 'avatarName', reason: 'blocked' };
	if (namesOffBrandCoin(caption)) return { field: 'caption', reason: 'coin' };
	if (namesOffBrandCoin(name))    return { field: 'avatarName', reason: 'coin' };
	return null;
}

// Tier-2 AI content risk over the free-text caption — Granite Guardian. Best-
// effort by design (Rule 9): when watsonx isn't configured, or the classifier
// errors/times out, we DON'T block — the always-on wordlist already caught the
// hard cases, and a missing key must never 500 a placement.
//
// Resilience (task 12): a dead moderation upstream would otherwise cost EVERY
// placement its full timeout. Once a check fails, we cache the "degraded" state
// for ~60s and skip the upstream entirely during that window — so one failure
// doesn't make the next minute of placements each wait the timeout. The per-
// request timeout is tight (2s) so even the first failure after recovery can't
// stall the POST. Both failure modes fail OPEN (allow the placement) with a log.
const GUARDIAN_TIMEOUT_MS    = 2000;   // tight per-request bound on the upstream
const GUARDIAN_DEGRADE_MS    = 60_000; // skip-upstream window after a failure
let _guardianDegradedUntil   = 0;      // epoch-ms; >now ⇒ short-circuit to allow

// Exposed for tests + the cron-style recovery path: report whether the Guardian
// short-circuit is currently engaged, and clear it (e.g. after a probe succeeds).
export function guardianDegraded(now = Date.now()) {
	return _guardianDegradedUntil > now;
}
export function resetGuardianDegraded() {
	_guardianDegradedUntil = 0;
}

async function guardianFlags(caption) {
	const text = String(caption || '').trim();
	if (!text) return false;
	const cfg = guardianConfig();
	if (!cfg.configured) return false;
	// Short-circuit while the upstream is known-degraded: no network call, so the
	// caption is allowed immediately rather than paying the timeout again.
	if (guardianDegraded()) return false;
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), GUARDIAN_TIMEOUT_MS);
		try {
			const verdicts = await assess(cfg, {
				input: text,
				risks: ['harm', 'social_bias', 'violence', 'sexual_content'],
				signal: ctrl.signal,
			});
			// A clean pass clears any lingering degraded window — the upstream is back.
			_guardianDegradedUntil = 0;
			return decide(verdicts).decision === 'block';
		} finally {
			clearTimeout(timer);
		}
	} catch (err) {
		// Open the degraded window so the next ~60s of placements skip the upstream
		// instead of each eating the timeout. Fail open (allow) — the hard wordlist
		// already ran, and a moderation outage must never 500 or stall a placement.
		_guardianDegradedUntil = Date.now() + GUARDIAN_DEGRADE_MS;
		console.warn('[irl/pins] guardian content check degraded:', err?.message || err);
		return false;
	}
}

// x402 pay-endpoint allow-list (D4). A pin's advertised "pay" target is handed to
// every nearby viewer's Pay button, so an arbitrary external URL is a drain/scam
// vector. On top of safeRemoteUrl's https + no-private-host checks, the host must
// be first-party three.ws infrastructure (or an operator-extended allow-list via
// IRL_X402_ALLOWED_HOSTS). Relative same-origin paths are always first-party.
// Registered-agent endpoints still flow to the Pay button via the trusted
// server-resolved agent-card path (card.x402_endpoint), which this never gates.
// Built-in first-party hosts — the floor under any operator override. The
// allow-list is NEVER empty: an unset/blank/malformed IRL_X402_ALLOWED_HOSTS
// falls back to these defaults rather than producing an empty list (which would
// reject every absolute endpoint — fail-safe, but it would also silently break
// every legit first-party pay target). A valid host token is a bare hostname
// (letters/digits/dots/hyphens, no scheme/path/port), so a fat-fingered
// "https://x" entry is dropped instead of poisoning the match.
const X402_DEFAULT_HOSTS = ['three.ws', 'www.three.ws', '3d-agent.vercel.app', 'three.ws'];
const X402_HOST_RE = /^[a-z0-9.-]+$/;

// Parse + validate the configured allow-list. Returns ONLY well-formed bare
// hostnames; when an operator override is set but yields no valid host, we log
// once and fall back to the built-in first-party hosts so a misconfig can never
// silently disable first-party pay targets nor accept an external one.
function parseAllowedHosts(raw) {
	const configured = String(raw ?? '').trim();
	const parsed = configured
		.split(',')
		.map((h) => h.trim().toLowerCase())
		.filter((h) => h && X402_HOST_RE.test(h));
	if (configured && !parsed.length) {
		console.warn(
			'[irl/pins] IRL_X402_ALLOWED_HOSTS is set but parsed to no valid host; ' +
				'falling back to built-in first-party hosts. External x402 endpoints ' +
				'are only accepted for first-party / allow-listed hosts.',
		);
	}
	// Always return a non-empty set: configured-valid hosts, else the defaults.
	return parsed.length ? parsed : X402_DEFAULT_HOSTS.slice();
}

const X402_ALLOWED_HOSTS = parseAllowedHosts(process.env.IRL_X402_ALLOWED_HOSTS);

export function safePaymentEndpoint(raw) {
	// allowRelative so a same-origin path (unambiguously first-party three.ws)
	// passes; safeRemoteUrl still enforces https + no-private-host on absolute URLs.
	const base = safeRemoteUrl(raw, { allowRelative: true });
	if (!base.ok) return { ok: false };
	if (base.value == null) return { ok: true, value: null };
	if (base.value.startsWith('/')) return { ok: true, value: base.value };
	let host;
	try { host = new URL(base.value).hostname.toLowerCase(); } catch { return { ok: false }; }
	// Empty allow-list (defensive — parseAllowedHosts never returns one) must
	// reject every absolute host: fail safe, never silently accept an external one.
	if (!X402_ALLOWED_HOSTS.length) return { ok: false };
	const allowed = X402_ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
	return allowed ? { ok: true, value: base.value } : { ok: false };
}

// Validate a URL that will be handed to every nearby viewer's browser — the
// avatar GLB (→ GLTFLoader) and the x402 pay endpoint (→ Pay button). Same-origin
// relative paths (avatars live under /api/avatars/…) are always allowed; absolute
// URLs must be https and must not point at localhost / private / loopback hosts,
// so a placement can't aim other users' devices at an internal or attacker host.
// Returns { ok: true, value } or { ok: false }. `value` is the normalized string.
function safeRemoteUrl(raw, { allowRelative = true } = {}) {
	if (raw == null || raw === '') return { ok: true, value: null };
	const v = String(raw).trim();
	if (!v) return { ok: true, value: null };
	if (allowRelative && v.startsWith('/') && !v.startsWith('//')) return { ok: true, value: v };
	let u;
	try { u = new URL(v); } catch { return { ok: false }; }
	if (u.protocol !== 'https:') return { ok: false };
	if (u.username || u.password) return { ok: false };
	const host = u.hostname.toLowerCase();
	if (
		host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') ||
		host === '0.0.0.0' || host === '::1' ||
		/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
		/^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
	) return { ok: false };
	return { ok: true, value: u.toString() };
}

// Coarsen a coordinate before it leaves the server in the PUBLIC nearby feed.
// A phone GPS fix is accurate to ~5 m, so the sub-millimetre tail of a float64
// degree is both useless for AR placement and a privacy hazard: an exact
// 9-decimal reading is precise enough to fingerprint one device/fix and exposes
// more than "an agent stands roughly here." 5 decimals ≈ 1.1 m — finer than GPS
// error, ample to render the agent as you walk up — and the room frame
// (rel_east_m / rel_north_m) still carries the exact intra-room layout untouched.
// Distance is computed from the RAW coordinates before rounding, so proximity
// filtering and the surfaced distance_m stay accurate.
const PUBLIC_COORD_DP = 5;
function roundCoord(v) {
	if (typeof v !== 'number' || !Number.isFinite(v)) return v;
	const f = 10 ** PUBLIC_COORD_DP;
	return Math.round(v * f) / f;
}

// Haversine distance in meters between two GPS points
function haversineDist(lat1, lng1, lat2, lng2) {
	const R = 6371000;
	const dLat = (lat2 - lat1) * Math.PI / 180;
	const dLng = (lng2 - lng1) * Math.PI / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
		Math.sin(dLng / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Rate-limit calls fail OPEN here (task 12). The shared limiter already degrades
// internally for these non-critical buckets, but a Redis client can still reject
// (or the limiter object can throw synchronously) — and an unhandled rejection
// inside the handler would 500 the whole request. These write paths are bounded
// by the DB caps (density / per-owner / report dedupe) downstream, so a limiter
// outage should never block a legitimate placement: we log once and allow.
// `name` ties the warning to the bucket; the cooldown keeps an outage that hits
// every request from itself flooding the logs.
const _rlWarnedAt = new Map();
const RL_WARN_COOLDOWN_MS = 60_000;
async function limitOrFailOpen(name, fn, ...args) {
	try {
		return await fn(...args);
	} catch (err) {
		const last = _rlWarnedAt.get(name) || 0;
		const now = Date.now();
		if (now - last >= RL_WARN_COOLDOWN_MS) {
			_rlWarnedAt.set(name, now);
			console.warn(`[irl/pins] rate limiter "${name}" failed, allowing request (fail-open):`, err?.message || err);
		}
		// Allow: a synthetic success verdict so the caller proceeds unthrottled.
		return { success: true, reason: 'rate_limiter_degraded' };
	}
}

// The PUBLIC nearby read fails CLOSED (H7). This read is the only surface that ever
// reveals another agent's location, so its degradation path is a privacy boundary,
// not a convenience one: if the limiter that bounds it can't make a decision, we
// must NOT open an unmetered scrape window. Unlike the write paths above (which the
// DB density/owner caps still bound when the limiter is blind), an unmetered read is
// exactly the bulk-harvest hole the rate limit exists to close. So on a limiter
// throw we return a retryable `rate_limiter_unavailable` verdict — surfaced to the
// client as a 429 "temporarily unavailable, retrying" — rather than allowing the
// read. The backing bucket (limits.publicIp) is an in-memory `local` limiter that
// never touches Redis, so in practice it never throws; this guard makes the
// fail-closed guarantee explicit and asserted rather than incidental.
async function limitFailClosedRead(name, fn, ...args) {
	try {
		return await fn(...args);
	} catch (err) {
		const last = _rlWarnedAt.get(name) || 0;
		const now = Date.now();
		if (now - last >= RL_WARN_COOLDOWN_MS) {
			_rlWarnedAt.set(name, now);
			console.warn(`[irl/pins] read limiter "${name}" failed — failing CLOSED (deny):`, err?.message || err);
		}
		return { success: false, reason: 'rate_limiter_unavailable', reset: Date.now() + 60_000 };
	}
}

// ── Sweep anomaly detection (H7) ─────────────────────────────────────────────
// A real /irl user stays in ~1 geocell: they poll the same spot every ~10 s. A
// scraper reading many DISTINCT cells in a short window is sweep-shaped, even if
// each individual cell stays under the per-minute rate limit (a slow, methodical
// grid never trips a burst counter). We track the set of distinct geocells a caller
// reads within SWEEP_WINDOW_S in the shared cache (short TTL, capped) and fire ONE
// deduped, COORDINATE-FREE ops alert when the count crosses SWEEP_CELL_THRESHOLD.
//
// Privacy discipline (mirrors redactUrl): the cache key and the alert carry only a
// SHA-256 hash of the caller IP and the distinct-cell COUNT — never a coordinate,
// never a raw IP, never a geocell value. The whole path is best-effort and wrapped
// so it can never delay or fail the read it observes.
const SWEEP_WINDOW_S = 120;       // rolling observation window
const SWEEP_CELL_THRESHOLD = 12;  // distinct cells in the window that looks like a grid sweep
const SWEEP_CELLS_TRACKED_MAX = 64; // cap the stored set so one caller can't bloat a cache entry

export async function recordCellRead(ip, cell) {
	if (!ip || !cell) return;
	try {
		const ipHash = (await sha256(ip)).slice(0, 16);
		const key = `irl:sweep:${ipHash}`;
		const prev = (await cacheGet(key)) || { cells: [], alerted: false };
		const cells = Array.isArray(prev.cells) ? prev.cells : [];
		if (!cells.includes(cell)) {
			if (cells.length < SWEEP_CELLS_TRACKED_MAX) cells.push(cell);
		}
		const distinct = cells.length;
		let alerted = prev.alerted === true;
		if (distinct >= SWEEP_CELL_THRESHOLD && !alerted) {
			alerted = true; // latch so we alert once per window, not every cell after the threshold
			// Coordinate-free, IP-hash only. Deduped by the hash so a sustained sweep
			// from one caller is one alert per dedup window, not a flood.
			sendOpsAlert(
				'IRL sweep suspected',
				`A single caller read ${distinct}+ distinct geocells from the /irl nearby feed within ${SWEEP_WINDOW_S}s (ip_hash ${ipHash}). Possible bulk location-harvest attempt; no coordinates logged.`,
				{ signature: `irl-sweep:${ipHash}` },
			).catch(() => {});
		}
		// Refresh the rolling window on every read so an active sweep keeps the entry warm.
		await cacheSet(key, { cells, alerted }, SWEEP_WINDOW_S);
	} catch {
		/* best-effort telemetry — never block or fail the read */
	}
}

let _tableReady = false;
async function ensureTable() {
	if (_tableReady) return;
	// Critical bootstrap — the base table + proximity/expiry indexes. These are
	// idempotent (`IF NOT EXISTS`) and, on an already-provisioned database, a cheap
	// catalog check that takes no exclusive lock. A failure here is a genuine DB
	// fault (no connection, no CREATE grant) and is allowed to surface.
	await sql`
		CREATE TABLE IF NOT EXISTS irl_pins (
			id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
			user_id       UUID,
			agent_id      UUID,
			device_token  TEXT,
			lat           DOUBLE PRECISION NOT NULL,
			lng           DOUBLE PRECISION NOT NULL,
			heading       FLOAT DEFAULT 0,
			avatar_url    TEXT,
			avatar_name   TEXT,
			caption       TEXT,
			x402_endpoint TEXT,
			placed_at     TIMESTAMPTZ DEFAULT NOW(),
			expires_at    TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days')
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS irl_pins_lat_lng ON irl_pins (lat, lng)`;
	await sql`CREATE INDEX IF NOT EXISTS irl_pins_expires ON irl_pins (expires_at)`;
	// Incremental migrations — every column/index below ships idempotently so a
	// fresh database self-provisions. On a LIVE database they are already applied,
	// so re-running them is pure redundancy: each `ALTER TABLE` / `CREATE INDEX`
	// takes an ACCESS EXCLUSIVE lock that can time out when many cold starts race,
	// and a least-privilege runtime role may lack DDL grants outright. Neither must
	// ever gate a read or write — the schema is already in place. Run them
	// best-effort, mark the table ready regardless, and let any genuine schema gap
	// surface as a precise error on the actual query rather than a blanket 500 here.
	try {
		await runMigrations();
	} catch (err) {
		console.error('[irl/pins] schema migrations skipped (already applied or no DDL grant)', {
			reason: err?.message || String(err),
		});
	}
	_tableReady = true;
}

async function runMigrations() {
	// view_count — deduplicated visitor count; incremented by /api/irl/interactions
	await sql`ALTER TABLE irl_pins ADD COLUMN IF NOT EXISTS view_count BIGINT NOT NULL DEFAULT 0`;
	// Anchor pose — added 2026-06 for IRL-Live world anchoring (A2). Persisting the
	// full pose (floor height, orientation, GPS-fix trust) is the prerequisite for
	// WebXR anchors (A1), shared-spot reconciliation (A3), and gyro-lock replay (A4).
	await sql`ALTER TABLE irl_pins ADD COLUMN IF NOT EXISTS anchor_height_m DOUBLE PRECISION`;
	await sql`ALTER TABLE irl_pins ADD COLUMN IF NOT EXISTS anchor_yaw_deg  DOUBLE PRECISION`;
	await sql`ALTER TABLE irl_pins ADD COLUMN IF NOT EXISTS anchor_quat     JSONB`;            // [x,y,z,w], optional richer orientation
	await sql`ALTER TABLE irl_pins ADD COLUMN IF NOT EXISTS gps_accuracy_m  DOUBLE PRECISION`;
	await sql`ALTER TABLE irl_pins ADD COLUMN IF NOT EXISTS altitude_m      DOUBLE PRECISION`;
	await sql`ALTER TABLE irl_pins ADD COLUMN IF NOT EXISTS anchor_source   TEXT`;             // 'webxr' | 'gyro-gps'
	await sql`ALTER TABLE irl_pins ADD COLUMN IF NOT EXISTS vps_provider    TEXT`;             // reserved for visual positioning
	await sql`ALTER TABLE irl_pins ADD COLUMN IF NOT EXISTS vps_id          TEXT`;             // reserved
	// Moderation + density (D4). geocell7 is the ~150m density key (precision-7
	// geohash); hidden_at marks a pin queued out of public view after enough
	// distinct reporters — set, never deleted, so the owner can appeal and the
	// review console can restore it.
	await sql`ALTER TABLE irl_pins ADD COLUMN IF NOT EXISTS geocell7  TEXT`;
	await sql`ALTER TABLE irl_pins ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ`;
	await sql`CREATE INDEX IF NOT EXISTS irl_pins_geocell7 ON irl_pins (geocell7) WHERE hidden_at IS NULL`;
	// Remote outfit change (C6) — a placed agent owns its look independent of the
	// source avatar so an owner can re-skin it for EVERY nearby viewer.
	//   avatar_manifest : the editable appearance — { colors, hidden, accessories }
	//                     (the same shape the avatar studio produces).
	//   avatar_base_url : the un-dressed GLB the manifest bakes ONTO, captured once
	//                     on the first outfit edit. Re-baking always starts from this
	//                     clean base so garment hides / accessories never stack across
	//                     edits (avatar_url stays the derived, baked GLB served today).
	//   avatar_version  : bumped on every outfit change — the cheap signal the nearby
	//                     feed/viewer diffs to swap a re-skinned pin's GLB, and a
	//                     cache-bust companion to the hash-keyed baked URL.
	await sql`ALTER TABLE irl_pins ADD COLUMN IF NOT EXISTS avatar_manifest JSONB`;
	await sql`ALTER TABLE irl_pins ADD COLUMN IF NOT EXISTS avatar_base_url TEXT`;
	await sql`ALTER TABLE irl_pins ADD COLUMN IF NOT EXISTS avatar_version  INTEGER NOT NULL DEFAULT 0`;
	// Room frame — shared room-relative anchoring. A pin in a ROOM stores its
	// EXACT offset (rel_east_m / rel_north_m, metres) from a shared origin
	// (origin_lat/lng/yaw) instead of relying on its own ~10 m-noisy GPS, so a
	// cluster keeps its room-scale layout identical for every viewer and the whole
	// room calibrates with one nudge. lat/lng stay populated (the GPS index +
	// legacy clients); room_id NULL = a standalone pre-room pin. See
	// src/irl/room-anchor.js for the geometry these columns feed.
	await sql`ALTER TABLE irl_pins ADD COLUMN IF NOT EXISTS room_id        TEXT`;
	await sql`ALTER TABLE irl_pins ADD COLUMN IF NOT EXISTS rel_east_m     DOUBLE PRECISION`;
	await sql`ALTER TABLE irl_pins ADD COLUMN IF NOT EXISTS rel_north_m    DOUBLE PRECISION`;
	await sql`ALTER TABLE irl_pins ADD COLUMN IF NOT EXISTS origin_lat     DOUBLE PRECISION`;
	await sql`ALTER TABLE irl_pins ADD COLUMN IF NOT EXISTS origin_lng     DOUBLE PRECISION`;
	await sql`ALTER TABLE irl_pins ADD COLUMN IF NOT EXISTS origin_yaw_deg DOUBLE PRECISION`;
	await sql`CREATE INDEX IF NOT EXISTS irl_pins_room ON irl_pins (room_id) WHERE room_id IS NOT NULL AND hidden_at IS NULL`;
	// Placement consent + approximate placement (H4). A placer chooses whether the
	// agent sits at their EXACT spot ('precise') or is deliberately blurred to a
	// random point within fuzz_radius_m of it ('approximate') — so a user can share
	// "an agent near here" without pinning their precise real-world location. The
	// CLIENT computes the fuzzed lat/lng it sends; the server stores the consent +
	// the radius it was blurred by, so the choice is auditable (the privacy center
	// surfaces it) and the dashboard can show "placed approximately (±Nm)". A legacy
	// pin with neither column set reads as a 'precise' placement (the prior default).
	await sql`ALTER TABLE irl_pins ADD COLUMN IF NOT EXISTS placement_kind TEXT`;
	await sql`ALTER TABLE irl_pins ADD COLUMN IF NOT EXISTS fuzz_radius_m  DOUBLE PRECISION`;
	// Privacy center (H5). `published` is the owner-controlled visibility flag: an
	// unpublished pin is suppressed from EVERY public nearby read (and stops
	// accepting new interactions) while the owner keeps the row to republish later
	// — distinct from hidden_at (moderation) and expiry (lifetime). DEFAULT TRUE so
	// every existing + future placement is public unless the owner unpublishes it.
	await sql`ALTER TABLE irl_pins ADD COLUMN IF NOT EXISTS published BOOLEAN NOT NULL DEFAULT TRUE`;
}

// ── Calibration bounds (A3) ─────────────────────────────────────────────────
// A nudge is a fine-tune, never a teleport. The client clamps to ±3 m / ±45°;
// the server re-validates with a small margin so a corrected pose can never be
// abused to move someone's agent across the map. Diagonal of a 3 m N + 3 m E
// drag is ~4.24 m, so 5 m is the tightest ceiling that never rejects a legit nudge.
const CAL_MAX_MOVE_M  = 5;    // ground-move ceiling, metres
const CAL_MAX_YAW_DEG = 46;   // yaw-nudge ceiling, degrees
const CAL_MAX_RISE_M  = 3;    // floor-height nudge ceiling, metres

// ── Room frame bounds ───────────────────────────────────────────────────────
// A room id is a short slug (the client derives one per shared-anchor cluster).
// A relative offset is clamped to a building-scale ceiling so the render frame
// can't be bent into a cross-map jump, while still covering any real venue.
const ROOM_ID_RE = /^[a-z0-9-]{1,64}$/;
const REL_MAX_M  = 500;

// ── Placement consent (H4) ──────────────────────────────────────────────────
// 'precise' pins the agent at the placer's exact spot; 'approximate' blurs it to
// a random point within fuzz_radius_m of the real spot (the CLIENT computes the
// fuzzed coordinate it sends — the server only stores the consent + the radius it
// was blurred by). The radius is clamped to a sane band: below FUZZ_MIN_M the blur
// is pointless (under GPS error), above FUZZ_MAX_M it stops being "near here". A
// missing/invalid placement reads as 'precise' so old clients are unaffected.
const PLACEMENT_KINDS = new Set(['precise', 'approximate']);
const FUZZ_MIN_M = 10;    // below this the blur is within GPS error — meaningless
const FUZZ_MAX_M = 500;   // above this it stops meaning "an agent near here"

// ── Placement visibility ────────────────────────────────────────────────────
// `published = false` means PRIVATE: the pin still renders for its OWNER (so you
// can place an agent at home and walk around it in AR) but is withheld from every
// other reader's nearby / room / world-line feed. It is deliberately distinct from
// `hidden_at`, the moderation + expiry hide that withholds a pin from EVERYONE,
// owner included — an owner testing a placement needs to see their own agent.
//
// Why this matters: proof-of-presence (IRL_FIX_SECRET) binds a read to a claimed
// fix, but the mint trusts caller-supplied coordinates, so it raises the cost of a
// geographic sweep without making one impossible. A private pin is not a cost —
// it is an absence: no sweep, at any budget, returns a coordinate that the query
// never selects. That is the only control that holds against a patient attacker.
//
// IRL_DEFAULT_PRIVATE flips the default for new placements. While /irl is
// pre-launch and its operators are testing from their own homes, a placement is
// private unless it explicitly asks to be public — the safe default is the one
// that cannot leak a home address by omission.
const VISIBILITIES = new Set(['public', 'private']);

function defaultsToPrivate() {
	const v = String(process.env.IRL_DEFAULT_PRIVATE ?? '').trim().toLowerCase();
	return v === '1' || v === 'true' || v === 'yes';
}

// Resolve a placement's visibility from the request body, falling back to the
// deployment default. An unrecognised value is never silently treated as public.
export function readVisibility(body) {
	const raw = String(body?.visibility ?? '').trim().toLowerCase();
	if (VISIBILITIES.has(raw)) return raw;
	return defaultsToPrivate() ? 'private' : 'public';
}

// Pin ids are server-minted UUIDs (gen_random_uuid()). Validate the format at the
// top of every mutation path so an oversized / garbage id is a clean 400 and never
// reaches the DB query or a log line. The SQL is already parameterized (this is
// not the injection guard) — it's input hygiene + defense in depth, and it lets a
// "not a pin id" request fail fast with a clear message instead of a confusing 404.
//
// A real id is a 36-char UUID; we accept that exactly, plus a conservative
// opaque-id fallback (1–64 chars, URL/path-safe alphabet only) so the guard is
// about REJECTING the dangerous shapes — control chars, whitespace, quotes,
// SQL-injection text, multi-KB blobs — rather than over-fitting to one format.
const PIN_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PIN_ID_SAFE_RE = /^[A-Za-z0-9_-]{1,64}$/;
export function isValidPinId(id) {
	if (typeof id !== 'string' || !id) return false;
	return PIN_UUID_RE.test(id) || PIN_ID_SAFE_RE.test(id);
}

// Smallest signed distance between two compass bearings, 0–180°.
function circularYawDelta(a, b) {
	let d = ((a - b) % 360 + 360) % 360;
	if (d > 180) d -= 360;
	return Math.abs(d);
}

// A pin is gone from the public world once it has expired (anonymous pins lapse
// after 7 days) or been moderation-hidden. Owner-gated mutations (calibrate /
// outfit / delete) must refuse to touch such a row — re-saving a pose or re-skin
// onto a pin no nearby viewer can see is a silent no-op the owner would mistake
// for success (task 13). `expires_at` NULL = a permanent (signed-in) pin.
export function isExpiredOrHidden(pin, now = Date.now()) {
	if (!pin) return false;
	if (pin.hidden_at != null) return true;
	if (pin.expires_at == null) return false;
	const t = new Date(pin.expires_at).getTime();
	return Number.isFinite(t) && t <= now;
}

// Owner-gated, bounds-checked pose correction. Mutates the A2 pose columns so the
// re-fetch every nearby viewer already runs picks up the corrected spot. (Pushing
// the correction to already-loaded viewers in realtime rides on D1; a re-fetch
// suffices here.) Calibration touches no coin and no third-party token.
async function handleCalibrate(res, { id, session, body, deviceToken = null }) {
	const cal = (body.calibrate && typeof body.calibrate === 'object') ? body.calibrate : {};

	const [pin] = await sql`
		SELECT id, user_id, device_token, lat, lng, heading, anchor_yaw_deg, anchor_height_m,
		       room_id, rel_east_m, rel_north_m, expires_at, hidden_at
		FROM irl_pins
		WHERE id = ${id}
	`;
	if (!pin) return json(res, 404, { error: 'not found' });

	// Ownership: the authenticated owner (user_id) or the anonymous device that
	// placed it (device_token). Anything else is denied — never silently allowed.
	const owns =
		(!!session?.id && !!pin.user_id && pin.user_id === session.id) ||
		(!!pin.device_token && !!deviceToken && pin.device_token === deviceToken);
	if (!owns) return json(res, 403, { error: 'only the owner can calibrate this agent' });

	// An expired / moderation-hidden pin is gone from the public world — refuse to
	// mutate it rather than re-saving a pose nobody will ever see (task 13).
	if (isExpiredOrHidden(pin)) return json(res, 404, { error: 'not found' });

	// New ground position — required, validated, range-checked.
	const newLat = parseFloat(cal.lat);
	const newLng = parseFloat(cal.lng);
	if (!isFinite(newLat) || newLat < -90 || newLat > 90 ||
		!isFinite(newLng) || newLng < -180 || newLng > 180) {
		return json(res, 400, { error: 'invalid calibrate coordinates' });
	}
	const moved = haversineDist(pin.lat, pin.lng, newLat, newLng);
	if (moved > CAL_MAX_MOVE_M) {
		return json(res, 422, { error: 'calibration move too large', max_m: CAL_MAX_MOVE_M });
	}

	// New yaw — optional; bounded against the stored bearing.
	let newYaw = null;
	if (Number.isFinite(cal.anchorYawDeg)) {
		newYaw = ((cal.anchorYawDeg % 360) + 360) % 360;
		const storedYaw = Number.isFinite(pin.anchor_yaw_deg) ? pin.anchor_yaw_deg : (pin.heading ?? 0);
		if (circularYawDelta(newYaw, storedYaw) > CAL_MAX_YAW_DEG) {
			return json(res, 422, { error: 'calibration rotation too large', max_deg: CAL_MAX_YAW_DEG });
		}
	}

	// New floor height — optional; bounded against the stored height.
	let newHeight = null;
	if (Number.isFinite(cal.anchorHeightM)) {
		newHeight = cal.anchorHeightM;
		const baseH = Number.isFinite(pin.anchor_height_m) ? pin.anchor_height_m : 0;
		if (Math.abs(newHeight - baseH) > CAL_MAX_RISE_M || Math.abs(newHeight) > 50) {
			return json(res, 422, { error: 'calibration height too large', max_m: CAL_MAX_RISE_M });
		}
	}

	// New room-frame offset — optional; only meaningful for a room pin, where the
	// render path (pinWorldPos) resolves position from rel_east_m/rel_north_m, NOT the
	// absolute lat/lng. A WebXR "refine on floor" re-places one agent by sending its
	// fresh offset; without persisting it the sharpened spot would snap back on the
	// next viewer re-fetch. Bounded by the SAME ground-move ceiling against the stored
	// offset, so refine sharpens a placement and never slides it across the room. A
	// non-room pin (no room_id) ignores rel — its absolute lat/lng above is authoritative.
	let newRelEast = null, newRelNorth = null;
	if (pin.room_id && Number.isFinite(cal.relEast) && Number.isFinite(cal.relNorth)) {
		const baseE = Number.isFinite(pin.rel_east_m) ? pin.rel_east_m : 0;
		const baseN = Number.isFinite(pin.rel_north_m) ? pin.rel_north_m : 0;
		if (Math.hypot(cal.relEast - baseE, cal.relNorth - baseN) > CAL_MAX_MOVE_M) {
			return json(res, 422, { error: 'calibration move too large', max_m: CAL_MAX_MOVE_M });
		}
		newRelEast = Math.max(-REL_MAX_M, Math.min(REL_MAX_M, cal.relEast));
		newRelNorth = Math.max(-REL_MAX_M, Math.min(REL_MAX_M, cal.relNorth));
	}

	// Persist. heading stays in sync with anchor_yaw_deg so legacy clients (which
	// only read `heading`) still render the corrected bearing.
	const headingToStore = newYaw != null ? Math.round(newYaw) : null;
	// A manual yaw recalibration SUPERSEDES the captured surface orientation. The
	// render-back path (pinYawRad, irl-floor-anchor task 02) prefers anchor_quat over
	// anchor_yaw_deg for exact facing, so a stale quat would silently override the
	// owner's nudge — the correction would never show. Clear anchor_quat whenever the
	// owner sets a new yaw, retiring the now-wrong capture so anchor_yaw_deg is the
	// authoritative source again. A height-only / move-only calibrate keeps the quat.
	const clearQuat = newYaw != null;
	const [row] = await sql`
		UPDATE irl_pins SET
			lat             = ${newLat},
			lng             = ${newLng},
			anchor_yaw_deg  = COALESCE(${newYaw}, anchor_yaw_deg),
			heading         = COALESCE(${headingToStore}, heading),
			anchor_height_m = COALESCE(${newHeight}, anchor_height_m),
			rel_east_m      = COALESCE(${newRelEast}, rel_east_m),
			rel_north_m     = COALESCE(${newRelNorth}, rel_north_m),
			anchor_quat     = CASE WHEN ${clearQuat} THEN NULL ELSE anchor_quat END
		WHERE id = ${id}
		  AND hidden_at IS NULL
		  AND (expires_at IS NULL OR expires_at > NOW())
		RETURNING id, lat, lng, heading, anchor_yaw_deg, anchor_height_m,
		          rel_east_m, rel_north_m, anchor_quat, gps_accuracy_m
	`;
	// A lapse between the SELECT above and this write (e.g. expiry / a reaping cron)
	// leaves no row — surface that as not-found instead of returning { pin: null }.
	if (!row) return json(res, 404, { error: 'not found' });
	// The corrected spot reaches nearby viewers on their next proximity poll — pin
	// positions are never broadcast as a roster, only read by someone standing near it.
	return json(res, 200, { pin: row, calibrated: true });
}

// One-gesture ROOM calibrate (R2). The headline alignment tool: instead of
// nudging each agent (A3), the owner grabs the WHOLE cluster and slides / twists
// it onto its true real-world spot once. Every agent is rigidly tied to the
// shared origin via its rel_east_m/rel_north_m, so moving the origin moves them
// all together with the internal layout intact — never a per-agent shear. We
// translate the origin by a true-north metre offset and rotate the frame about
// it (reusing the A3 calibration ceilings), then re-derive each agent's absolute
// lat/lng (the GPS index nearby reads use) from its UNCHANGED room offset. A
// cluster rotation also turns each agent's facing by the same angle so the rig
// stays internally consistent. Owner-gated across EVERY pin in the room: one
// stranger's agent in the cluster denies the whole move — we never slide someone
// else's agent across the map. No coin or third-party token is involved.
async function handleCalibrateRoom(res, { session, body, deviceToken = null }) {
	const cal = (body.calibrateRoom && typeof body.calibrateRoom === 'object') ? body.calibrateRoom : {};
	const roomId = String(cal.roomId || '');
	if (!ROOM_ID_RE.test(roomId)) return json(res, 400, { error: 'invalid room id' });

	const dEastM  = Number(cal.dEastM);
	const dNorthM = Number(cal.dNorthM);
	const dYawDeg = Number(cal.dYawDeg);
	if (![dEastM, dNorthM, dYawDeg].every(Number.isFinite)) {
		return json(res, 400, { error: 'invalid room calibrate offsets' });
	}
	// Bounds reuse the A3 ceilings: a move is the ground translation magnitude, a
	// rotation the absolute yaw delta. Reject larger with the existing 422 codes.
	if (Math.hypot(dEastM, dNorthM) > CAL_MAX_MOVE_M) {
		return json(res, 422, { error: 'calibration move too large', max_m: CAL_MAX_MOVE_M });
	}
	if (Math.abs(dYawDeg) > CAL_MAX_YAW_DEG) {
		return json(res, 422, { error: 'calibration rotation too large', max_deg: CAL_MAX_YAW_DEG });
	}

	// Every live pin in the room. A calibrate only ever touches the public, visible
	// cluster — an expired / moderation-hidden pin is gone from the world (task 13),
	// same stance as the per-pin path.
	const pins = await sql`
		SELECT id, user_id, device_token, rel_east_m, rel_north_m,
		       origin_lat, origin_lng, origin_yaw_deg, heading, anchor_yaw_deg
		FROM irl_pins
		WHERE room_id = ${roomId}
		  AND hidden_at IS NULL
		  AND (expires_at IS NULL OR expires_at > NOW())
	`;
	if (!pins.length) return json(res, 404, { error: 'room not found' });

	// Ownership: EVERY pin must belong to the caller — the authenticated owner
	// (user_id) or the anonymous device that placed it (device_token). Null-guarded
	// so a NULL user_id / empty device token can never match. Deny the whole move
	// if any agent is a stranger's; never move an agent we don't own.
	const owns = (p) =>
		(!!session?.id && !!p.user_id && p.user_id === session.id) ||
		(!!p.device_token && !!deviceToken && p.device_token === deviceToken);
	if (!pins.every(owns)) {
		return json(res, 403, { error: 'only the room owner can align this room' });
	}

	// Resolve the new origin once (it is denormalized identically across the cluster)
	// via the shared geodesy, then re-derive each agent's absolute lat/lng + facing
	// from its unchanged room-frame offset so nearby reads stay correct.
	const baseRow = pins[0];
	const next = calibrateRoomOrigin({
		originLat: Number(baseRow.origin_lat), originLng: Number(baseRow.origin_lng),
		originYawDeg: Number(baseRow.origin_yaw_deg) || 0,
		dEastM, dNorthM, dYawDeg,
	});
	const rotated = dYawDeg !== 0;
	const ids = [], lats = [], lngs = [], yaws = [];
	for (const p of pins) {
		const abs = pinAbsoluteFromOrigin({
			originLat: next.originLat, originLng: next.originLng, originYawDeg: next.originYawDeg,
			relEast: Number(p.rel_east_m) || 0, relNorth: Number(p.rel_north_m) || 0,
		});
		const baseYaw = Number.isFinite(p.anchor_yaw_deg) ? p.anchor_yaw_deg
			: (Number.isFinite(p.heading) ? p.heading : 0);
		ids.push(p.id);
		lats.push(abs.lat);
		lngs.push(abs.lng);
		yaws.push((((baseYaw + dYawDeg) % 360) + 360) % 360);
	}

	// One atomic write: set the shared origin for the whole cluster and join each
	// agent's re-derived lat/lng + facing by id via unnest, scoped to the verified
	// room. A rotation clears anchor_quat (the captured surface orientation is now
	// wrong — same as the per-pin path) so anchor_yaw_deg is authoritative again.
	const rows = await sql`
		UPDATE irl_pins AS t SET
			origin_lat     = ${next.originLat},
			origin_lng     = ${next.originLng},
			origin_yaw_deg = ${next.originYawDeg},
			lat            = v.lat,
			lng            = v.lng,
			heading        = ROUND(v.yaw)::int,
			anchor_yaw_deg = v.yaw,
			anchor_quat    = CASE WHEN ${rotated} THEN NULL ELSE anchor_quat END
		FROM (
			SELECT * FROM unnest(${ids}::uuid[], ${lats}::float8[], ${lngs}::float8[], ${yaws}::float8[])
				AS u(id, lat, lng, yaw)
		) AS v
		WHERE t.id = v.id AND t.room_id = ${roomId}
		RETURNING t.id
	`;
	// The aligned cluster reaches nearby viewers on their next proximity poll — pin
	// positions are never broadcast as a roster.
	return json(res, 200, {
		ok: true,
		roomId,
		moved: rows.length,
		origin: { lat: next.originLat, lng: next.originLng, yawDeg: next.originYawDeg },
	});
}

// ── Remote outfit change (C6) ───────────────────────────────────────────────
// Re-skin a placed agent for EVERY nearby viewer. The owner sends the appearance
// manifest ({ colors, hidden, accessories }); we validate it against the same
// slot/preset allow-list the studio uses, bake a new GLB onto the pin's clean
// BASE avatar (never the prior bake — so layers/accessories can't stack), store
// it on the first-party CDN, bump avatar_version, and persist. Every nearby
// viewer's loadNearbyPins poll then diffs the version and swaps the GLB. A
// null/empty manifest reverts the pin to its bare base avatar.
async function handleOutfitChange(res, { id, session, body }) {
	const manifest = body.avatar_manifest ?? body.avatarManifest ?? null;
	if (manifest !== null && (typeof manifest !== 'object' || Array.isArray(manifest))) {
		return json(res, 400, { error: 'avatar_manifest must be an object or null' });
	}
	// Validate shape + preset/slot allow-list BEFORE baking, so an invented slot
	// or preset is a clean 400 and never burns a bake.
	if (manifest) {
		const err = validateAppearance(manifest);
		if (err) return json(res, 400, { error: err });
	}

	// Owner-gated: only the authenticated owner re-skins their agent. (Appearance
	// is never editable from an anonymous device token — same stance as the
	// avatar/location edits below.)
	const [pin] = await sql`
		SELECT id, user_id, avatar_url, avatar_base_url, avatar_version, expires_at, hidden_at
		FROM irl_pins
		WHERE id = ${id}
	`;
	if (!pin) return json(res, 404, { error: 'not found' });
	if (!pin.user_id || pin.user_id !== session.id) {
		return json(res, 403, { error: "only the owner can change this agent's outfit" });
	}
	// An expired / moderation-hidden pin is gone from the public world — refuse to
	// burn a bake re-skinning a row no nearby viewer can see (task 13).
	if (isExpiredOrHidden(pin)) return json(res, 404, { error: 'not found' });

	// The base GLB the manifest dresses. Captured once (the agent as it looked
	// before any outfit edit) so re-bakes always start from a clean model.
	const baseUrl = pin.avatar_base_url || pin.avatar_url;
	if (!baseUrl) return json(res, 422, { error: 'this agent has no avatar to dress' });

	let newAvatarUrl = baseUrl;
	try {
		// Lazy import: irl-bake → bake.js pulls in sharp (native libvips). Loading
		// it only on this path keeps every other pins route alive even where the
		// native module can't load.
		const { bakePinOutfit, isBakeable } = await import('../_lib/irl-bake.js');
		if (manifest && isBakeable(manifest)) {
			const baked = await bakePinOutfit({ pinId: id, baseUrl, manifest });
			newAvatarUrl = baked.url;
		}
		// else: cleared / empty manifest → serve the bare base GLB again.
	} catch (err) {
		// Log the full detail server-side; NEVER echo err.message to the client — a
		// bake/upstream error can carry filesystem paths, R2/CDN URLs, or libvips
		// internals. The client gets a generic, actionable message only (task 13).
		console.error('[irl/pins] outfit bake failed', { pinId: id, message: err?.message });
		return json(res, 502, { error: 'could not bake the new outfit' });
	}

	const [row] = await sql`
		UPDATE irl_pins SET
			avatar_manifest = ${manifest ? JSON.stringify(manifest) : null}::jsonb,
			avatar_base_url = COALESCE(avatar_base_url, ${baseUrl}),
			avatar_url      = ${newAvatarUrl},
			avatar_version  = avatar_version + 1
		WHERE id = ${id} AND user_id = ${session.id}
		  AND hidden_at IS NULL
		  AND (expires_at IS NULL OR expires_at > NOW())
		RETURNING id, lat, lng, avatar_url, avatar_manifest, avatar_version
	`;
	if (!row) return json(res, 404, { error: 'not found' });

	// The re-skin reaches co-located viewers on their next proximity poll, which
	// diffs avatar_version and swaps the GLB. There is no realtime fan-out: a pin's
	// data only travels to a viewer who is physically near it.
	return json(res, 200, { pin: row });
}

export default wrap(async (req, res) => {
	cors(req, res, { methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] });
	if (req.method === 'OPTIONS') return res.end();

	await ensureTable();

	// Every public GET read (the nearby feed + my-pins) is IP rate-limited so the
	// tight proximity feed can't be systematically gridded into a bulk location
	// scrape. A legit viewer polls nearby every ~10 s (≈6/min) — well under the
	// 60/min public ceiling — while a scripted sweep trips it fast. This read FAILS
	// CLOSED (H7): if the limiter can't decide, we deny with a retryable
	// `rate_limiter_unavailable` rather than open an unmetered scrape window — an
	// unbounded location read is the exact hole the limit exists to close.
	if (req.method === 'GET') {
		const rl = await limitFailClosedRead('publicIp', limits.publicIp, clientIp(req));
		if (!rl.success) return rateLimited(res, rl);
	}

	// ── GET — my pins by device token (anonymous) or session (auth) ──────────
	// Path: /api/irl/pins/mine?deviceToken=…  — lets a visitor browse and manage
	// the pins they placed from this device even after a reload, without login.
	if (req.method === 'GET' && req.url?.includes('/mine')) {
		const session  = await getSessionUser(req).catch(() => null);
		// Null-guard both identifiers BEFORE the query: an empty/missing device token
		// or a NULL session id must never become a clause that matches another
		// owner's pins. (A bare `device_token = ''` would otherwise leak every
		// legacy NULL/empty-token anonymous pin — and its lat/lng — to any caller.)
		const ownerId  = session?.id ?? null;
		// Header-first (H2): the device token never rides in the URL where it would
		// land in access logs / history. readDeviceToken null-guards empty values.
		const ownerDev = readDeviceToken(req);
		if (!ownerDev && !ownerId) {
			return json(res, 400, { error: 'deviceToken required' });
		}
		// INVARIANT: coordinates leave here ONLY for the caller's OWN pins —
		// strictly scoped to their session id or the device token they hold. Each
		// arm is null-guarded so a missing identifier can never widen the match.
		const rows = await sql`
			SELECT id, lat, lng, avatar_name, caption, placed_at, expires_at, view_count,
			       placement_kind, fuzz_radius_m
			FROM irl_pins
			WHERE ((${ownerId}::uuid IS NOT NULL AND user_id = ${ownerId}::uuid)
			    OR (${ownerDev}::text IS NOT NULL AND device_token = ${ownerDev}))
			  AND hidden_at IS NULL
			  AND (expires_at IS NULL OR expires_at > NOW())
			ORDER BY placed_at DESC
			LIMIT 20
		`;
		return json(res, 200, { pins: rows });
	}

	// ── GET — my pins (auth, query-param form) ────────────────────────────────
	if (req.method === 'GET' && req.query.mine === '1') {
		const session = await getSessionUser(req).catch(() => null);
		if (!session) return json(res, 401, { error: 'not authenticated' });
		const rows = await sql`
			SELECT id, lat, lng, heading, avatar_url, avatar_name, caption, agent_id,
			       placed_at, expires_at, view_count,
			       anchor_height_m, anchor_yaw_deg, anchor_quat,
			       gps_accuracy_m, altitude_m, anchor_source,
			       avatar_manifest, avatar_base_url, avatar_version,
			       placement_kind, fuzz_radius_m
			FROM irl_pins
			WHERE user_id = ${session.id}
			  AND hidden_at IS NULL
			ORDER BY placed_at DESC
			LIMIT 100
		`;
		return json(res, 200, { pins: rows });
	}

	// ── GET — nearby pins (the ONLY way another agent's location is revealed) ──
	// A placed agent is private by location: its coordinates reach a viewer only
	// through this read, and only when that viewer is physically within a tight
	// radius of it — so an agent is "stumbled upon" in AR by someone standing near
	// it, never handed out as a browseable roster/map. There is no bbox/window
	// feed and no realtime broadcast of pins: the radius is hard-capped small, the
	// caller's own lat/lng is required, and the read is IP rate-limited above so a
	// scripted grid-sweep can't reconstruct the map.
	//
	// PRIVACY CONTRACT (L4): the caller's own lat/lng are used ONLY to run the
	// proximity query and are NEVER logged. A proximity READ is not persisted —
	// the only stored coordinates are the deliberate placements in irl_pins; the
	// rate-limit counter keys on IP, not position. Do not add any console log of
	// req.query / lat / lng on this path. Privacy-minded clients additionally
	// coarsen the origin they send (see discoveryOrigin() in src/irl.js), so the
	// exact device position need never reach the server at all.

	// ── GET — marker room read (Epic M) ──────────────────────────────────────
	// Indoor colocalization can't use the GPS proximity feed: GPS is ±20–50 m
	// inside a building and never agrees phone-to-phone. Instead a MARKER room is
	// keyed by a QR both phones can see — its id (`m-<hash>`) is derived from the
	// QR payload (src/irl/marker-anchor.js markerRoomId), so a viewer who scanned
	// the marker can read its pins by room_id with NO location at all. This is
	// capability-gated by knowing the QR: the id is unguessable without having
	// physically seen the marker, which is the same "be present to discover"
	// contract the proximity feed enforces with GPS. Restricted to marker rooms
	// (`m-` prefix) so a GPS room (`r-…`) can never be read here, bypassing its
	// fix-token gate. Still IP rate-limited by the publicIp ceiling applied above.
	if (req.method === 'GET' && req.query.room != null) {
		const roomId = String(req.query.room);
		if (!ROOM_ID_RE.test(roomId)) {
			return json(res, 400, { error: 'invalid room id' });
		}
		if (!roomId.startsWith('m-')) {
			// GPS rooms are readable only through the fix-gated proximity feed.
			return json(res, 404, { error: 'not a marker room' });
		}

		const session = await getSessionUser(req).catch(() => null);
		const myId    = session?.id ?? null;
		const myTok   = readDeviceToken(req);

		const rows = await sql`
			SELECT id, user_id, device_token, agent_id, lat, lng, heading,
			       avatar_url, avatar_name, caption, x402_endpoint, placed_at, view_count,
			       anchor_height_m, anchor_yaw_deg, anchor_quat,
			       gps_accuracy_m, altitude_m, anchor_source, avatar_version,
			       placement_kind, fuzz_radius_m, published,
			       vps_provider, vps_id,
			       room_id, rel_east_m, rel_north_m, origin_lat, origin_lng, origin_yaw_deg
			FROM irl_pins
			WHERE room_id = ${roomId}
			  AND hidden_at IS NULL
			  AND (published IS NOT FALSE
			    OR (${myId}::uuid IS NOT NULL AND user_id = ${myId}::uuid)
			    OR (${myTok}::text IS NOT NULL AND device_token = ${myTok}::text))
			  AND (expires_at IS NULL OR expires_at > NOW())
			ORDER BY placed_at DESC
			LIMIT 50
		`;

		// Same allow-list projection as the nearby feed: NEVER expose user_id or
		// device_token. The marker frame (rel_east_m / rel_north_m) is the render-
		// authoritative pose; lat/lng is only a coarse index here, so coarsen it.
		const pins = rows.map(r => ({
			id:              r.id,
			agent_id:        r.agent_id,
			lat:             roundCoord(r.lat),
			lng:             roundCoord(r.lng),
			heading:         r.heading,
			avatar_url:      r.avatar_url,
			avatar_name:     r.avatar_name,
			caption:         r.caption,
			x402_endpoint:   r.x402_endpoint,
			placed_at:       r.placed_at,
			view_count:      r.view_count,
			anchor_height_m: r.anchor_height_m,
			anchor_yaw_deg:  r.anchor_yaw_deg,
			anchor_quat:     r.anchor_quat,
			gps_accuracy_m:  r.gps_accuracy_m,
			altitude_m:      r.altitude_m,
			anchor_source:   r.anchor_source,
			vps_provider:    r.vps_provider ?? null,
			vps_id:          r.vps_id ?? null,
			room_id:         r.room_id ?? null,
			rel_east_m:      r.rel_east_m,
			rel_north_m:     r.rel_north_m,
			origin_lat:      roundCoord(r.origin_lat),
			origin_lng:      roundCoord(r.origin_lng),
			origin_yaw_deg:  r.origin_yaw_deg,
			avatar_version:  Number(r.avatar_version) || 0,
			placement_kind:  r.placement_kind === 'approximate' ? 'approximate' : 'precise',
			fuzz_radius_m:   Number.isFinite(r.fuzz_radius_m) ? r.fuzz_radius_m : null,
			// A private pin only ever reaches its owner, so this is always 'public'
			// for a stranger — it exists so the owner's UI can badge their own pins.
			visibility:      r.published === false ? 'private' : 'public',
			is_mine: (!!myId && r.user_id === myId) || (!!myTok && r.device_token === myTok),
		}));

		return json(res, 200, { pins, room_id: roomId });
	}

	if (req.method === 'GET') {
		const lat    = parseFloat(req.query.lat);
		const lng    = parseFloat(req.query.lng);
		// Tight proximity gate: default 40 m, hard-capped at 60 m. Large enough to
		// render an agent as you walk up and point your camera at its spot, small
		// enough that one read only ever exposes the handful right where you stand.
		// A missing radius defaults to 40; a PRESENT but non-finite radius (e.g.
		// ?radius=abc) is rejected — clamping NaN would silently yield NaN deltas and
		// an always-empty feed, masking a malformed request behind a 200.
		const rawRadius = req.query.radius;
		const parsedRadius = rawRadius == null || rawRadius === '' ? 40 : parseFloat(rawRadius);
		if (!Number.isFinite(parsedRadius)) {
			return json(res, 400, { error: 'invalid radius' });
		}
		const radius = Math.min(60, Math.max(10, parsedRadius));

		if (!isFinite(lat) || !isFinite(lng)) {
			return json(res, 400, { error: 'lat and lng are required' });
		}

		// Proof-of-presence (H3): bind the read to a genuine fix. The caller mints a
		// short-lived, HMAC-signed token from their real GPS via POST /fix-token; this
		// read only answers for the coarse area that token was minted in, so a viewer
		// can't browse pins at a location they aren't standing near (the actual product
		// contract). Enforced only when IRL_FIX_SECRET is set — dev/preview without it
		// works unchanged so local testing isn't gated (the mode is logged once at the
		// mint endpoint's cold start). Failure → 401 fix_required, which the client
		// turns into the "Getting your location…" designed state, never a blank screen.
		if (fixEnforced()) {
			const fixHeader = req.headers['x-irl-fix'];
			const fixToken = Array.isArray(fixHeader) ? fixHeader[0] : fixHeader;
			const v = await verifyFixToken(fixToken, lat, lng);
			if (!v.ok) {
				return json(res, 401, {
					error: 'fix_required',
					reason: v.reason,
					error_description: 'a fresh location fix is required to read nearby agents',
				});
			}
		}

		// Bounding-box pre-filter (fast index scan), then haversine in app
		const latDelta = radius / 110540;
		const lngDelta = radius / (111320 * Math.cos(lat * Math.PI / 180));

		// Resolve the caller so we can tell them which nearby pins are THEIRS without
		// ever exposing other people's owner identifiers.
		const session = await getSessionUser(req).catch(() => null);
		const myId    = session?.id ?? null;
		const myTok   = readDeviceToken(req);

		const rows = await sql`
			SELECT id, user_id, device_token, agent_id, lat, lng, heading,
			       avatar_url, avatar_name, caption, x402_endpoint, placed_at, view_count,
			       anchor_height_m, anchor_yaw_deg, anchor_quat,
			       gps_accuracy_m, altitude_m, anchor_source, avatar_version,
			       placement_kind, fuzz_radius_m, published,
			       room_id, rel_east_m, rel_north_m, origin_lat, origin_lng, origin_yaw_deg
			FROM irl_pins
			WHERE lat BETWEEN ${lat - latDelta} AND ${lat + latDelta}
			  AND lng BETWEEN ${lng - lngDelta} AND ${lng + lngDelta}
			  AND hidden_at IS NULL
			  AND (published IS NOT FALSE
			    OR (${myId}::uuid IS NOT NULL AND user_id = ${myId}::uuid)
			    OR (${myTok}::text IS NOT NULL AND device_token = ${myTok}::text))
			  AND (expires_at IS NULL OR expires_at > NOW())
			ORDER BY placed_at DESC
			LIMIT 50
		`;

		// Explicit allow-list projection: NEVER return user_id or device_token in the
		// public feed (a stable owner UUID + precise coords is a deanonymization /
		// location-tracking vector). Surface only an is_mine boolean computed here.
		const pins = rows
			.map(r => ({
				id:             r.id,
				agent_id:       r.agent_id,
				// Coarsened to ~1.1 m (PUBLIC_COORD_DP) — strips false precision a
				// co-located reader could harvest while staying finer than GPS error.
				lat:            roundCoord(r.lat),
				lng:            roundCoord(r.lng),
				heading:        r.heading,
				avatar_url:     r.avatar_url,
				avatar_name:    r.avatar_name,
				caption:        r.caption,
				x402_endpoint:  r.x402_endpoint,
				placed_at:      r.placed_at,
				view_count:     r.view_count,
				anchor_height_m: r.anchor_height_m,
				anchor_yaw_deg:  r.anchor_yaw_deg,
				anchor_quat:     r.anchor_quat,
				gps_accuracy_m:  r.gps_accuracy_m,
				altitude_m:      r.altitude_m,
				anchor_source:   r.anchor_source,
				// Room frame — when present (room_id non-null), the viewer renders this
				// agent from its exact offset relative to the shared origin instead of
				// its own GPS, so the room-scale layout holds for everyone. Null on
				// legacy standalone pins → the client falls back to lat/lng.
				room_id:         r.room_id ?? null,
				rel_east_m:      r.rel_east_m,
				rel_north_m:     r.rel_north_m,
				// The room origin is a GPS index too — coarsen it like lat/lng; the
				// exact intra-room layout rides the relative offsets above, not the origin.
				origin_lat:      roundCoord(r.origin_lat),
				origin_lng:      roundCoord(r.origin_lng),
				origin_yaw_deg:  r.origin_yaw_deg,
				// C6 — cheap re-skin signal: the viewer diffs this against its loaded
				// pin and swaps the GLB when it bumps. (The editable manifest/base URL
				// stay owner-private — viewers only ever need the rendered avatar_url.)
				avatar_version:  Number(r.avatar_version) || 0,
				// Placement consent (H4): the kind + blur radius drive the owner's
				// Exact/Approximate badge. A legacy pin (NULL column) reads as 'precise'.
				// This is a flag, not a coordinate — for an approximate pin the true spot
				// was never stored, so surfacing "≈ approximate (~Nm)" leaks nothing.
				placement_kind:  r.placement_kind === 'approximate' ? 'approximate' : 'precise',
				fuzz_radius_m:   Number.isFinite(r.fuzz_radius_m) ? r.fuzz_radius_m : null,
				// A private pin only ever reaches its owner, so this is always 'public'
				// for a stranger — it exists so the owner's UI can badge their own pins.
				visibility:      r.published === false ? 'private' : 'public',
				is_mine: (!!myId && r.user_id === myId) || (!!myTok && r.device_token === myTok),
				distance_m: Math.round(haversineDist(lat, lng, r.lat, r.lng)),
			}))
			.filter(r => r.distance_m <= radius)
			.sort((a, b) => a.distance_m - b.distance_m);

		// Sweep anomaly detection (H7): record which geocell this caller just read.
		// Reading many DISTINCT cells in a short window is sweep-shaped even when each
		// cell stays under the rate limit; this fires a deduped, coordinate-free ops
		// alert past the threshold. Best-effort and fire-and-forget — never awaited
		// into the response path, never carries a coordinate.
		recordCellRead(clientIp(req), encodeGeohash(lat, lng, GEOCELL_PRECISION));

		return json(res, 200, { pins });
	}

	// ── POST — create pin ─────────────────────────────────────────────────────
	// D4 gate order, cheapest/most-decisive first: coords → content (pure string,
	// fails closed) → URL/coin safety → rate limit (1 Redis cmd, protects the DB
	// from a flood) → density + per-owner caps (DB counts) → insert. Each rejection
	// carries a designed error code the client renders as an actionable message.
	if (req.method === 'POST') {
		const ip = clientIp(req);
		const rl = await limitOrFailOpen('irlPinIp', limits.irlPinIp, ip);
		if (!rl.success) return rateLimited(res, rl);

		const body = req.body ?? {};
		const lat  = parseFloat(body.lat);
		const lng  = parseFloat(body.lng);

		if (!isFinite(lat) || !isFinite(lng)) {
			return json(res, 400, { error: 'lat and lng are required' });
		}
		if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
			return json(res, 400, { error: 'invalid coordinates' });
		}

		// Clamp text to its public length cap, then run the tier-1 content gate.
		const caption    = body.caption    != null ? String(body.caption).slice(0, CAPTION_MAX)    : null;
		const avatarName = body.avatarName != null ? String(body.avatarName).slice(0, NAME_MAX)    : null;
		const bad = contentReject(caption, avatarName);
		if (bad) {
			return json(res, 422, {
				error: 'content',
				field: bad.field,
				message: bad.reason === 'coin'
					? 'A pin can only reference $THREE — the only coin on three.ws.'
					: 'That text isn’t allowed on a public pin.',
			});
		}
		// Tier-2 AI risk on the borderline caption (no-op when Guardian unconfigured).
		if (caption && (await guardianFlags(caption))) {
			return json(res, 422, {
				error: 'content',
				field: 'caption',
				message: 'That caption was flagged by our content filter. Try rewording it.',
			});
		}

		// Validate the URLs handed to every nearby viewer (avatar GLB + x402 pay).
		const avatarUrlChk = safeRemoteUrl(body.avatarUrl);
		if (!avatarUrlChk.ok) return json(res, 400, { error: 'invalid avatarUrl' });
		// x402 pay target must be a first-party / allow-listed payment host — never an
		// arbitrary external drain (D4). Same-origin relative paths are first-party.
		const x402Chk = safePaymentEndpoint(body.x402Endpoint);
		if (!x402Chk.ok) {
			return json(res, 422, {
				error: 'endpoint',
				field: 'x402Endpoint',
				message: 'Pay endpoints must be hosted on three.ws.',
			});
		}
		// Empty-string device token would otherwise become a shared anonymous owner.
		// readDeviceToken accepts the header (H2) or body, null-guarding empties.
		const deviceToken = readDeviceToken(req);

		const session   = await getSessionUser(req).catch(() => null);
		const userId    = session?.id ?? null;

		// Placement token bucket (D4) — per (device + IP), tighter than the coarse
		// per-IP gate above. Burst (5/min) + sustained (30/h). Fails open + logs on a
		// Redis outage (non-critical) so an infra hiccup never blocks a real placement.
		const rateKey = `${deviceToken ?? userId ?? 'anon'}:${ip}`;
		const [burst, hourly] = await Promise.all([
			limitOrFailOpen('irlPinBurst', limits.irlPinBurst, rateKey),
			limitOrFailOpen('irlPinHourly', limits.irlPinHourly, rateKey),
		]);
		const throttled = !burst.success ? burst : !hourly.success ? hourly : null;
		if (throttled) {
			const retryAfter = Math.max(1, Math.ceil((throttled.reset - Date.now()) / 1000));
			res.setHeader?.('Retry-After', String(retryAfter));
			return json(res, 429, {
				error: 'rate',
				retryAfter,
				message: 'You’re placing agents too fast. Wait a moment and try again.',
			});
		}

		// Density cap — one fine geocell (~150m) can hold only so many agents, so a
		// single actor can't carpet-bomb a venue. Counts only live, non-hidden pins.
		const cell7 = encodeGeohash(lat, lng, GEOCELL_PRECISION);
		if (cell7) {
			const [{ n }] = await sql`
				SELECT count(*)::int AS n FROM irl_pins
				WHERE geocell7 = ${cell7}
				  AND hidden_at IS NULL
				  AND (expires_at IS NULL OR expires_at > NOW())
			`;
			if (n >= MAX_PINS_PER_CELL) {
				return json(res, 429, {
					error: 'area_full',
					message: 'This area already has the maximum number of agents. Try another spot.',
				});
			}
		}

		// Per-owner active-pin cap — a signed-in owner is accountable, so gets a
		// higher ceiling than an anonymous device. Null-guarded so a NULL user_id or
		// empty device token can't collide owners.
		const ownerCap = userId ? MAX_PINS_PER_OWNER_SIGNED : MAX_PINS_PER_OWNER_ANON;
		const [{ n: owned }] = await sql`
			SELECT count(*)::int AS n FROM irl_pins
			WHERE ((${userId}::uuid IS NOT NULL AND user_id = ${userId}::uuid)
			    OR (${deviceToken}::text IS NOT NULL AND device_token = ${deviceToken}))
			  AND hidden_at IS NULL
			  AND (expires_at IS NULL OR expires_at > NOW())
		`;
		if (owned >= ownerCap) {
			return json(res, 429, {
				error: 'pin_limit',
				limit: ownerCap,
				message: 'You’ve reached your active pin limit. Remove an old pin to place a new one.',
			});
		}

		// Authenticated users get permanent pins; anonymous expire in 7 days.
		const expiresAt = userId ? null : new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

		// Anchor pose (A2) — optional, back-compat: old clients send no `anchor`,
		// every pose column inserts NULL. New clients send a reproducible pose so
		// later sessions / other users can reconstruct where the agent stands.
		const pose          = (body.anchor && typeof body.anchor === 'object') ? body.anchor : {};
		// Reject absurd floor height (> ±50 m above/below eye) to NULL, not noise.
		const anchorHeightM = Number.isFinite(pose.heightM) && Math.abs(pose.heightM) <= 50
			? pose.heightM : null;
		const anchorYawDeg  = Number.isFinite(pose.yawDeg)
			? ((pose.yawDeg % 360) + 360) % 360 : null;
		const anchorQuat    = Array.isArray(pose.quat) && pose.quat.length === 4 &&
			pose.quat.every(Number.isFinite)
			? JSON.stringify(pose.quat) : null;
		// Clamp GPS accuracy to a sane 0–500 m range (a worse fix is meaningless here).
		const gpsAccuracyM  = Number.isFinite(pose.gpsAccuracyM)
			? Math.min(500, Math.max(0, pose.gpsAccuracyM)) : null;
		const altitudeM     = Number.isFinite(pose.altitudeM) ? pose.altitudeM : null;
		// 'webxr' (A1) · 'gyro-gps' (absolute compass heading) · 'gyro-gps:rel'
		// (page-relative heading only — A3 down-weights its cross-user bearing) ·
		// 'map' (L2: a point chosen on the map, not a live fix — its bearing isn't
		// compass-trustworthy, same down-weighting as ':rel') · 'marker' (Epic M: a
		// visual QR marker is the shared origin; GPS is only a coarse index and the
		// frame is reconstructed live per viewer from the marker, not from compass).
		const anchorSource  = pose.source === 'webxr' ? 'webxr'
			: pose.source === 'map' ? 'map'
			: pose.source === 'marker' ? 'marker'
			: pose.source === 'gyro-gps:rel' ? 'gyro-gps:rel' : 'gyro-gps';

		// Visual-positioning identity (Epic M) — the long-reserved vps_* columns,
		// now first written by the marker path: provider is the positioning system
		// ('qr' for a QR marker) and id is its opaque token (the marker payload).
		// Both phones derive the room_id from this same token, so it is the key that
		// lets a second viewer read the room with no GPS. Length-clamped; absent on
		// every non-marker placement (every existing caller), leaving the columns NULL.
		const vps          = (body.vps && typeof body.vps === 'object') ? body.vps : {};
		const vpsProvider  = anchorSource === 'marker' && typeof vps.provider === 'string'
			? vps.provider.slice(0, 32) : null;
		const vpsId        = anchorSource === 'marker' && typeof vps.id === 'string'
			? vps.id.slice(0, 256) : null;

		// Room frame (optional) — when the client places into a shared room it sends
		// the exact offset from the room origin. We persist origin + offset as the
		// render-authoritative pose; lat/lng above stays the GPS index. An invalid or
		// absent block leaves every room column NULL → a standalone pin, so old
		// clients and single-drop placements are unaffected. (See src/irl/room-anchor.js.)
		const room       = (body.room && typeof body.room === 'object') ? body.room : {};
		const roomOk     = ROOM_ID_RE.test(String(room.id || '')) &&
			Number.isFinite(room.originLat) && room.originLat >= -90  && room.originLat <= 90 &&
			Number.isFinite(room.originLng) && room.originLng >= -180 && room.originLng <= 180 &&
			!(room.originLat === 0 && room.originLng === 0) &&
			Number.isFinite(room.relEast) && Number.isFinite(room.relNorth);
		const clampRel   = (v) => Math.max(-REL_MAX_M, Math.min(REL_MAX_M, v));
		const roomIdVal  = roomOk ? String(room.id) : null;
		const relEastM   = roomOk ? clampRel(room.relEast)  : null;
		const relNorthM  = roomOk ? clampRel(room.relNorth) : null;
		const originLatV = roomOk ? room.originLat : null;
		const originLngV = roomOk ? room.originLng : null;
		const originYawV = roomOk && Number.isFinite(room.originYawDeg)
			? ((room.originYawDeg % 360) + 360) % 360 : null;

		// Placement consent (H4) — record whether the placer pinned their exact spot
		// or deliberately blurred it. The client computes the fuzzed lat/lng it sends;
		// we store the consent kind + the radius the blur used. An 'approximate' pin
		// must carry a fuzz radius (clamped to the sane band); a missing/invalid
		// placement (or an old client that sends neither) defaults to 'precise' with
		// no radius, so behaviour is unchanged for every existing caller.
		const rawKind        = String(body.placement ?? body.placementKind ?? body.placement_kind ?? '').toLowerCase();
		const placementKind  = PLACEMENT_KINDS.has(rawKind) ? rawKind : 'precise';
		const rawFuzz        = Number(body.fuzzRadiusM ?? body.fuzz_radius_m);
		const fuzzRadiusM    = placementKind === 'approximate' && Number.isFinite(rawFuzz)
			? Math.min(FUZZ_MAX_M, Math.max(FUZZ_MIN_M, rawFuzz))
			: null;

		const visibility = readVisibility(body);

		const [pin] = await sql`
			INSERT INTO irl_pins
				(user_id, agent_id, device_token, lat, lng, heading,
				 avatar_url, avatar_name, caption, x402_endpoint, expires_at,
				 anchor_height_m, anchor_yaw_deg, anchor_quat,
				 gps_accuracy_m, altitude_m, anchor_source, geocell7,
				 room_id, rel_east_m, rel_north_m, origin_lat, origin_lng, origin_yaw_deg,
				 placement_kind, fuzz_radius_m, vps_provider, vps_id, published)
			VALUES (
				${userId},
				${body.agentId    ?? null},
				${deviceToken},
				${lat}, ${lng},
				${parseFloat(body.heading) || 0},
				${avatarUrlChk.value},
				${avatarName},
				${caption},
				${x402Chk.value},
				${expiresAt},
				${anchorHeightM},
				${anchorYawDeg},
				${anchorQuat},
				${gpsAccuracyM},
				${altitudeM},
				${anchorSource},
				${cell7 || null},
				${roomIdVal},
				${relEastM},
				${relNorthM},
				${originLatV},
				${originLngV},
				${originYawV},
				${placementKind},
				${fuzzRadiusM},
				${vpsProvider},
				${vpsId},
				${visibility === 'public'}
			)
			RETURNING *
		`;

		// No realtime fan-out: a new placement is never broadcast as a roster. It
		// surfaces to a viewer only on their next proximity poll, and only once they
		// are physically within the nearby radius of where it was dropped.
		return json(res, 201, { pin: { ...pin, permanent: expiresAt === null } });
	}

	// ── PATCH — edit pin fields ───────────────────────────────────────────────
	// Authenticated owners can update: caption, avatar_url, avatar_name, lat, lng.
	// Anonymous device-token owners can only update caption (no location/avatar changes
	// from anonymous sessions for safety).
	if (req.method === 'PATCH') {
		const rl = await limitOrFailOpen('irlPinIp', limits.irlPinIp, clientIp(req));
		if (!rl.success) return rateLimited(res, rl);

		const session = await getSessionUser(req).catch(() => null);
		const body = req.body ?? {};

		// ── Room calibrate — one-gesture align of an entire owned cluster (R2) ──
		// Routed BEFORE the per-pin `id` gate: a room calibrate is scoped by roomId,
		// not a single pin id. Owner-gated for both authenticated owners and the
		// anonymous device that placed the room; ownership + bounds are enforced
		// inside handleCalibrateRoom.
		if (body.calibrateRoom && typeof body.calibrateRoom === 'object') {
			return handleCalibrateRoom(res, { session, body, deviceToken: readDeviceToken(req) });
		}

		const { id } = body;
		if (!id) return json(res, 400, { error: 'id required' });
		// Reject a malformed pin id up front (covers calibrate / outfit / field-edit):
		// the id is a server-minted UUID, so anything else is a bad request, not a
		// row that happens not to exist.
		if (!isValidPinId(id)) return json(res, 400, { error: 'invalid pin id' });

		// ── Calibrate — a small, owner-gated pose correction (A3) ─────────────
		// Owner-gated for both authenticated owners and the anonymous device that
		// placed the pin, so it routes BEFORE the auth gate below; ownership and
		// nudge bounds are enforced inside handleCalibrate.
		if (body.calibrate && typeof body.calibrate === 'object') {
			return handleCalibrate(res, { id, session, body, deviceToken: readDeviceToken(req) });
		}

		// Field edits (caption / avatar / location / heading / x402) require auth.
		if (!session) return json(res, 401, { error: 'not authenticated' });

		// ── Outfit change (C6) — re-skin a placed agent for all nearby viewers ──
		// A manifest PATCH bakes a new GLB + bumps avatar_version; routed before
		// the simple field-edit SET below because it has its own bake/persist path.
		if ('avatar_manifest' in body || 'avatarManifest' in body) {
			return handleOutfitChange(res, { id, session, body });
		}

		// Build update SET clause only for fields the caller provided
		const updates = {};
		if ('caption' in body)    updates.caption    = body.caption ?? null;
		if ('avatarUrl' in body)  updates.avatarUrl  = body.avatarUrl ?? null;
		if ('avatarName' in body) updates.avatarName = body.avatarName ?? null;
		if ('lat' in body)        updates.lat        = parseFloat(body.lat);
		if ('lng' in body)        updates.lng        = parseFloat(body.lng);
		// heading: re-aim the avatar remotely (normalize to 0–359°)
		if ('heading' in body && isFinite(parseFloat(body.heading))) {
			updates.heading = ((Math.round(parseFloat(body.heading)) % 360) + 360) % 360;
		}
		// x402Endpoint: attach or update a paid endpoint so visitors can pay the agent IRL
		if ('x402Endpoint' in body) updates.x402Endpoint = body.x402Endpoint ?? null;

		if (!Object.keys(updates).length) {
			return json(res, 400, { error: 'no updatable fields provided' });
		}

		// Validate new lat/lng if provided
		if ('lat' in updates && (!isFinite(updates.lat) || updates.lat < -90 || updates.lat > 90)) {
			return json(res, 400, { error: 'invalid lat' });
		}
		if ('lng' in updates && (!isFinite(updates.lng) || updates.lng < -180 || updates.lng > 180)) {
			return json(res, 400, { error: 'invalid lng' });
		}

		// Validate URL fields if the caller is changing them (relative avatar URLs ok).
		if ('avatarUrl' in updates) {
			const c = safeRemoteUrl(updates.avatarUrl);
			if (!c.ok) return json(res, 400, { error: 'invalid avatarUrl' });
			updates.avatarUrl = c.value;
		}
		if ('x402Endpoint' in updates) {
			// Enforce the SAME first-party / allow-listed payment-host gate as POST —
			// safePaymentEndpoint, not bare safeRemoteUrl. Editing a pin must not be a
			// back door to point its Pay button at an arbitrary external drain host
			// (the exact vector the POST allow-list closes). Relative same-origin paths
			// stay first-party; a null/'' clears the endpoint.
			const c = safePaymentEndpoint(updates.x402Endpoint);
			if (!c.ok) {
				return json(res, 422, {
					error: 'endpoint',
					field: 'x402Endpoint',
					message: 'Pay endpoints must be hosted on three.ws.',
				});
			}
			updates.x402Endpoint = c.value;
		}

		// Present-flag each text field so an explicit clear (null) actually writes
		// NULL. COALESCE treats null as "no change", silently dropping a clear and
		// desyncing the dashboard (which optimistically cleared the field) from the
		// row every nearby viewer fetches. lat/lng/heading keep COALESCE since 0 is a
		// valid value there and they are never "cleared".
		const has = (k) => k in updates;
		const [row] = await sql`
			UPDATE irl_pins SET
				caption       = CASE WHEN ${has('caption')}      THEN ${updates.caption      ?? null}::text ELSE caption       END,
				avatar_url    = CASE WHEN ${has('avatarUrl')}    THEN ${updates.avatarUrl    ?? null}::text ELSE avatar_url    END,
				avatar_name   = CASE WHEN ${has('avatarName')}   THEN ${updates.avatarName   ?? null}::text ELSE avatar_name   END,
				x402_endpoint = CASE WHEN ${has('x402Endpoint')} THEN ${updates.x402Endpoint ?? null}::text ELSE x402_endpoint END,
				lat           = COALESCE(${updates.lat     ?? null}, lat),
				lng           = COALESCE(${updates.lng     ?? null}, lng),
				heading       = COALESCE(${updates.heading ?? null}, heading)
			WHERE id = ${id} AND user_id = ${session.id}
			RETURNING id, caption, avatar_url, avatar_name, lat, lng, heading, x402_endpoint
		`;
		if (!row) return json(res, 404, { error: 'not found' });

		// The edit reaches nearby viewers on their next proximity poll — never as a
		// broadcast. A pin's fields only travel to someone physically near it.
		return json(res, 200, { pin: row });
	}

	// ── DELETE — remove own pin ───────────────────────────────────────────────
	if (req.method === 'DELETE') {
		const rl = await limitOrFailOpen('irlPinIp', limits.irlPinIp, clientIp(req));
		if (!rl.success) return rateLimited(res, rl);

		const id          = req.query.id;
		// Header/body-first (H2): the device credential leaves the URL.
		const deviceToken = readDeviceToken(req);
		const purgeAll    = req.query.all === '1' || req.query.all === 'true';

		// ── Bulk purge — every pin from this device token, in one round-trip ──────
		// Strictly scoped to a non-empty device token: the `IS NOT NULL` guard means
		// a NULL/empty token matches nothing, so this can only ever delete the
		// caller's own anonymous pins — never another device's, never a NULL-token
		// row. Auth-only callers manage their permanent pins from the dashboard, so
		// this branch requires a device token.
		if (purgeAll) {
			if (!deviceToken) return json(res, 400, { error: 'deviceToken required for bulk delete' });
			const rows = await sql`
				DELETE FROM irl_pins
				WHERE device_token IS NOT NULL AND device_token = ${deviceToken}
				RETURNING id
			`;
			return json(res, 200, { ok: true, deleted: rows.length });
		}

		if (!id) return json(res, 400, { error: 'id required' });
		// A delete id is a server-minted UUID — reject a malformed one before it
		// reaches the query or a log line.
		if (!isValidPinId(id)) return json(res, 400, { error: 'invalid pin id' });

		const session = await getSessionUser(req).catch(() => null);
		const userId  = session?.id ?? null;

		// Must prove ownership: an authenticated user_id OR the placing device_token.
		// (A bare anonymous caller with neither must not be able to delete anything.)
		if (!userId && !deviceToken) {
			return json(res, 401, { error: 'authentication or device token required' });
		}

		// Match strictly by owner. Each branch is null-guarded so a NULL user_id or a
		// NULL/empty device_token can NEVER match a row — closing the prior
		// `device_token IS NULL AND $userId IS NULL` clause that let an anonymous
		// caller delete every pin whose device_token happened to be NULL.
		const result = await sql`
			DELETE FROM irl_pins
			WHERE id = ${id}
			  AND (expires_at IS NULL OR expires_at > NOW())
			  AND (
			    (${userId}::uuid IS NOT NULL AND user_id = ${userId}::uuid)
			    OR (${deviceToken}::text IS NOT NULL AND device_token = ${deviceToken}::text)
			  )
			RETURNING id, lat, lng
		`;

		if (!result.length) {
			return json(res, 404, { error: 'pin not found or not yours' });
		}
		// A removed pin simply stops appearing in nearby viewers' next proximity
		// poll; there is no realtime remove broadcast to fan out.
		return json(res, 200, { ok: true });
	}

	json(res, 405, { error: 'method not allowed' });
});
