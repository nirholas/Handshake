// WalkRoom — authoritative state for the three.ws /walk experience.
//
// Players send 'move' messages 15× per second. The server validates each
// update (max-step clamp, world bounds, name length, message rate) and
// merges the result into the shared MapSchema. Colyseus's binary delta
// protocol broadcasts only fields that actually changed to every other
// client in the same room, at the configured patch rate.
//
// Generic world objects (R01) — balls, placed props, pickups — ride the same
// pattern on their own `objects` map (see schemas.js WorldObject). The full
// obj:spawn / obj:update / obj:remove wire contract (payload shape, who's
// authorized, rate limits and caps) is documented at the
// "── Generic world objects (R01 protocol) ──" comment block below, right
// above _handleObjSpawn — read that before adding a new object-driven
// feature (R02 client manager, R05 ball physics, R17 persistence and later
// briefs all build on that single channel).

import { Room } from '@colyseus/core';

import { Player, Block, Vehicle, Mob, Tombstone, WorldObject, WalkState } from '../schemas.js';
import {
	VEHICLE_SPAWNS, vehicleSpec, isVehicleType, vehicleRestHeight,
	VEHICLE_WORLD_BOUND_M, VEHICLE_ENTER_RANGE_M,
	vehicleMaxStepM, vehicleMaxSpeedMps,
} from '../vehicles.js';
import { cleanAvatarUrl } from '../avatar-url.js';
import { blockStore } from '../block-store.js';
import { worldPersistence } from '../persistence.js';
import { verifyHolderPass } from '../holder-pass.js';
import { socialHub } from '../social-hub.js';
import { verifyPresenceTicket } from '../presence-token.js';
import { verifyPlayPass } from '../play-pass.js';
import {
	restoreProfile, serializeProfile, profileSnapshot,
	addItem, hasRoomFor, resolveSlot, grantXp, consumeSlot,
	countItem, removeItem,
	dropCarried, reviveProfile, bankTransfer, grantCosmetic,
	equipCosmetic, ownedCosmeticSet, mergeOwnedFromLedger,
	HOTBAR_SIZE,
} from '../economy.js';
import {
	serializeLoadout, getCosmetic, canWear, DEFAULT_LOADOUT,
} from '../cosmetics-catalog.js';
import {
	clientStoreCatalog, sellPrice, isSellable, buyEntry,
	boutiqueListings, boutiquePrice,
} from '../shop.js';
import {
	buildTokenPurchase, verifyTokenPurchase, isWalletAddress, tokenConfigured, TOKEN_DECIMALS,
} from '../game-token.js';
import { readOwnedCosmetics } from '../cosmetics-ownership.js';
import {
	itemLabel, fishCatchChance, fishDoubleChance,
	gatherChance, gatherDoubleChance, coalBonusChance, cookBurnChance,
	weaponDef, mobStats, rollLoot,
} from '../items.js';
import {
	fishingSpotInRange, treeInRange, rockInRange, firepitInRange,
	DANGER_ZONES, SPAWN_POINT, dangerZoneAt, isSafeZone, isDangerZone, randomPointInZone,
} from '../world-features.js';
import { registerActivityHandlers } from '../activities.js';
import { registerSpinHandlers } from '../spin-wheel.js';
import {
	selectTarget, rollDamage, applyDamage, addHeat, decayHeat, heatStars,
} from '../combat.js';
import {
	registerCombatHandlers, seedMobs, tickMobs, tickHeat, MOB_TICK_MS, HEAT_TICK_MS,
} from '../combat-handlers.js';
import { interactZoneInRange, zoneAt } from '../quest-zones.js';
import {
	missionDef, isHeist, utcDayKey,
	restoreQuestState, serializeQuestState,
	acceptMission, abandonMission, applyEvent, recordCompletion,
	missionReward, splitPot, questSnapshot, runView, objectiveMatches,
} from '../quests.js';
import { hydratePlayer, loadPlayer, savePlayer, flushPlayer } from '../playerStore.js';
import { publishFeedEvent } from '../feed.js';

// Platform entry gate (wallet-first sign-in + game-token balance). When a game
// token is pinned (PLAY_GATE_MINT, falling back to THREE_MINT) every join must
// carry a valid play pass — minted by api/play/verify after proving wallet
// ownership and a balance ≥ PLAY_GATE_MIN of that token. An unset mint leaves
// walk_world open exactly as before, so /walk and un-pinned deploys are
// unaffected. Read at boot: gate config doesn't change without a redeploy.
const PLAY_GATE_MINT = (process.env.PLAY_GATE_MINT || process.env.THREE_MINT || '').trim();
const PLAY_GATE_MIN = (() => {
	const n = Number(process.env.PLAY_GATE_MIN);
	return Number.isFinite(n) && n > 0 ? n : 1;
})();

const MAX_CLIENTS_PER_ROOM = 50;
const PATCH_RATE_HZ = 15;
const PATCH_RATE_MS = 1000 / PATCH_RATE_HZ;

// --- Collaborative voxel building -----------------------------------------
// Builds live on an integer grid centred on the world origin. The server works
// purely in grid cells (unit-agnostic); the client maps a cell to metres via
// its BLOCK size. These caps must mirror the client's (build-voxels.js):
//   - a circular build area of MAX_GRID_XZ cells radius (keeps builds on the
//     plaza, away from the far hills),
//   - a height ceiling of MAX_GRID_Y cells,
//   - BLOCK_TYPE_COUNT palette entries,
//   - and a hard per-world block budget so one room can't balloon memory or the
//     join-time state sync.
const MAX_GRID_XZ = 30;
const MAX_GRID_Y = 24;
const BLOCK_TYPE_COUNT = 10;
const MAX_BLOCKS = 6000;
// Building is bursty (drag-to-place), so allow a higher rate than movement but
// still cap it so a scripted client can't flood the room.
const EDITS_PER_SEC_LIMIT = 20;
// Generic world objects (R01): the shared channel for balls, props and pickups.
// Caps keep the synced state and the persisted per-coin doc (R17) bounded, and
// the rate limit mirrors the edit limiter so a scripted client can't flood spawns.
const MAX_WORLD_OBJECTS = 200;        // total objects one room may hold
const MAX_OBJECTS_PER_PLAYER = 30;    // how many one owner may have at once
const OBJ_OPS_PER_SEC_LIMIT = 30;     // per-client spawn/update/remove rate
const OBJ_SCALE_MIN = 0.1;
const OBJ_SCALE_MAX = 10;
const OBJ_STR_MAX = 48;               // clamp length of id/type/kind strings
const OBJ_Y_MIN = -5;
const OBJ_Y_MAX = 240;
const SERVER_OBJECT_OWNER = 'server'; // ownerId sentinel: room-owned, no client writes
// Transient object kinds are ephemeral (physics balls, fx) and are NEVER persisted
// (R17). Everything else is a durable build piece saved per coin world.
const TRANSIENT_OBJECT_KINDS = new Set(['ball', 'projectile', 'confetti', 'fx', 'spark', 'pickup']);
const OBJ_ID_RE = /^[A-Za-z0-9_-]{1,48}$/;

// Composite pieces (walls, stairs, doors) place several cells at once through the
// place-batch channel. A single stamp is capped at this many cells, and stamps
// are rate-limited separately from single edits, so a crafted client can't smuggle
// an oversized or rapid-fire write through it. Mirrors MAX_COMPOSITE_CELLS on the
// client, with headroom so appending a larger piece there doesn't desync.
const MAX_BATCH_CELLS = 32;
const BATCHES_PER_SEC_LIMIT = 4;

// ── R05: server-authoritative beach ball physics ──────────────────────────────
// One ball per room, kind:'ball', ownerId:'server'. Clients send 'ball:kick' with
// an impulse vector; the server validates + caps it, then integrates position each
// physics tick and streams updates through the objects map via the schema delta.
//
//   ball:kick  { vx, vy, vz }
//       Any joined player, BALL_KICKS_PER_SEC rate limit. The server caps impulse
//       magnitude and ensures a minimum upward component, then adds it to the
//       authoritative velocity. Ball id is fixed (BALL_ID) — one per room.
//
// Velocity kept in _ballVx/y/z server vars, written to the WorldObject schema
// each tick. A settled ball (speed < BALL_IDLE_SPEED_SQ on ground) skips
// integration to avoid micro-drift and unnecessary Colyseus patches.
const BALL_ID = 'ball_0';
const BALL_RADIUS = 0.5;
const BALL_TICK_MS = 1000 / 20;      // 20 Hz physics
const BALL_GRAVITY = 9.8;
const BALL_BOUNCE = 0.55;            // vertical energy retained on ground bounce
const BALL_WALL_BOUNCE = 0.80;       // energy retained on world-edge bounce
const BALL_ROLLING_FRICTION = 2.0;   // per-second horizontal speed decay on ground
const BALL_AIR_DRAG = 0.12;          // per-second speed decay while airborne
const BALL_MAX_IMPULSE = 12;         // m/s — cap on a single client kick
const BALL_POST_KICK_CAP = 18;       // m/s — absolute total velocity cap post-kick
const BALL_MIN_UPY = 0.8;            // minimum upward component on any kick
const BALL_WORLD_RADIUS = 54;        // keep inside the visible arena
const BALL_SPAWN_X = 0;
const BALL_SPAWN_Y = BALL_RADIUS;
const BALL_SPAWN_Z = 5;
const BALL_OOB_Y = -10;              // respawn below this y
const BALL_IDLE_SPEED_SQ = 0.04;     // (m/s)^2 — skip integration when settled
const BALL_KICKS_PER_SEC = 3;

// --- Build permissions & anti-grief (R19) ---------------------------------
// The per-world MAX_BLOCKS budget above protects the room; these caps protect it
// from a SINGLE builder. A per-player ceiling stops one user consuming the whole
// world; a per-column ceiling stops them stacking a 24-high wall to fence the
// plaza off; protected discs keep the spawn and the coin totem from being buried
// or caged. Every rejection is surfaced to the client (edit-reject), never silent.
const PER_PLAYER_BLOCK_CAP = 1200;   // how many cells one player may own at once
const COLUMN_CAP = 14;               // blocks allowed in a single (x,z) column (< MAX_GRID_Y)
const PROTECTED_RADIUS_CELLS = 3;    // keep this many cells clear around each protected point
// The build grid is centred on the world origin and maps a cell to metres via the
// client's BLOCK size (1.5 m). The spawn point is the origin; the coin totem
// renders at world z = -12 → grid z = round(-12 / 1.5) = -8. Protect both columns
// at every height so neither can be buried or walled in.
const BLOCK_SIZE_M = 1.5;             // client BLOCK: one grid cell ↔ metres
const PROTECTED_POINTS = [{ x: 0, z: 0 }, { x: 0, z: -8 }];
// The prop/object build channel (obj:spawn kind:'block') works in world METRES, not
// grid cells, so its grief guard has its own protected discs and density tile. The
// protected world points are the spawn (origin) and the rendered totem (world z=-12);
// the radius matches the voxel discs (PROTECTED_RADIUS_CELLS cells). PER_TILE_PROP_CAP
// stops a builder piling props onto one spot to bury a landmark or wall an area off —
// the per-player count (MAX_OBJECTS_PER_PLAYER) and world cap bound the rest.
const PROTECTED_POINTS_M = [{ x: 0, z: 0 }, { x: 0, z: -12 }];
const PROTECTED_RADIUS_M = PROTECTED_RADIUS_CELLS * BLOCK_SIZE_M;
const PROP_TILE_M = BLOCK_SIZE_M;     // density tile size for props, in metres
const PER_TILE_PROP_CAP = 4;          // durable props allowed on one tile
// Creator moderation: a clear-area sweep is bounded to this radius (cells) so even
// the creator's broad-brush tool can't nuke a whole world in one malformed call;
// 'all' is the explicit full-clear path.
const CLEAR_AREA_MAX_RADIUS = 12;
// The three.ws API the multiplayer server reads the coin's on-chain creator from,
// so "is this player the coin's creator" is proven server-side, not claimed by a
// client. Mirrors persistence.js's WORLD_API_BASE.
const WORLD_API_BASE = (process.env.WORLD_API_BASE || 'https://three.ws').replace(/\/$/, '');

// Anti-cheat: reject any movement update that would move the player farther
// than this in a single message. The client sends moves at ~15Hz, so even at
// the run speed (4 m/s) a legitimate delta is ~0.27 m. We allow generous
// headroom for packet timing jitter.
const MAX_STEP_M = 1.2;

// Tag mini-game (R08). Server-authoritative proximity: a tag is only valid when
// the "it" player's authoritative server position is within TAG_RANGE_M of a
// target. TAG_IMMUNITY_MS prevents the just-untagged player from being immediately
// re-tagged. TAG_MIN_PLAYERS is the threshold to start/continue the game.
// TAG_LB_INTERVAL_MS refreshes leaderboard time values for all clients periodically.
const TAG_RANGE_M = 2.0;
const TAG_IMMUNITY_MS = 2000;
const TAG_MIN_PLAYERS = 2;
const TAG_LB_INTERVAL_MS = 8000;

// King of the Totem mini-game (R07). Server-authoritative area control: the SOLE
// occupant of the king-zone at the totem base earns points each tick; two or more
// inside is "contested" and nobody scores. Rounds run on a fixed timer with a
// short intermission between them. The zone is centred on the totem (rendered at
// world (0, -12) — see PROTECTED_POINTS) so its radius matches the client ring.
// Occupancy is judged from the server's authoritative player positions, so a
// client can never score from outside the zone. KING_TICK_MS is the scoring +
// timer cadence; KING_POINTS_PER_SEC is awarded scaled by real elapsed time so a
// dropped tick never over- or under-pays. A round needs ≥ KING_MIN_PLAYERS present
// to start, but once running it tolerates players leaving down to zero (it simply
// ends with no winner). Dead/downed players (W07) can't hold the zone.
const KING_ZONE = { x: 0, z: -12, r: 3.5 };
const KING_ROUND_MS = 90_000;
const KING_INTERMISSION_MS = 12_000;
const KING_TICK_MS = 1000;
const KING_POINTS_PER_SEC = 10;
const KING_MIN_PLAYERS = 1;

// Open-world district bounds (W01). The /play world is no longer the 60 m disc:
// it's a square district the client renders streets/buildings across. These
// mirror DISTRICT.half in src/game/world-zones.js — keep the two in sync so the
// authoritative bounds and the rendered ground agree. The anti-teleport MAX_STEP
// clamp above is independent and still applies on every move.
const WORLD_HALF_M = 200;
const WORLD_BOUND_M = WORLD_HALF_M - 2; // small margin so an edge-pressed avatar never clips the rim

// Authoritative day/night clock. One full day every DAY_LENGTH_MS, derived from
// the wall clock so every room (and every client in it) agrees on the time of
// day without us syncing a phase. Broadcast once a second as state.worldTime (a
// [0,1) day fraction); clients advance it smoothly between updates.
const DAY_LENGTH_MS = 600_000; // 10-minute day → a visible cycle, not a frantic one

// Rate limit incoming 'move' messages per client to twice the expected rate
// so legitimate jitter passes but a flooding client gets dropped.
const MOVES_PER_SEC_LIMIT = PATCH_RATE_HZ * 2;
const MOVE_WINDOW_MS = 1000;

const MOTION_VALUES = new Set(['idle', 'walk', 'run']);

// --- Economy & activities (off-schema) ------------------------------------
// A player's pack, purse and skills are PRIVATE to them — peers never render
// them in this free-roam world — so they live off the synced WalkState schema
// (kept in this.econ) and stream to the owning client via targeted messages.
// This keeps the shared /walk schema untouched and peers' wire cost at zero.
const FISH_COOLDOWN_MS = 1500;   // per-cast reel time (cadence on the real clock)
const CONSUME_COOLDOWN_MS = 1100; // pace between bites — no instant heal-spam
const CHOP_COOLDOWN_MS = 1300;   // per-swing axe cadence
const MINE_COOLDOWN_MS = 1500;   // per-strike pickaxe cadence (ore is slower)
const COOK_COOLDOWN_MS = 900;    // pace between fish on the fire
// Per-action rate ceilings (messages/sec/client) — a flooding client is dropped.
// vsync rides at the same 15Hz the move netcode uses; allow 2× for jitter, like
// MOVES_PER_SEC_LIMIT. enter/exit are deliberate, rare actions.
const ACTION_RATES = {
	fish: 6, consume: 6, equip: 30, chop: 6, mine: 6, cook: 8, pickupRod: 4, vsync: PATCH_RATE_HZ * 2,
	venter: 4, vexit: 4, quest: 8, questInteract: 6, clear: 2,
	// General store, bank/ATM, and the $THREE boutique (W04) — low-frequency,
	// currency-mutating actions, throttled tighter than the gather loop.
	store: 6, storeBuy: 6, storeSell: 6, bank: 6, boutique: 4, boutiqueQuote: 3, boutiqueSettle: 3,
	// Combat (W07): attack rides at a swing/shot cadence a touch above the fastest
	// weapon's cooldown (pistol ~430ms); loot is a deliberate, rare action.
	attack: 5, loot: 4,
};

// Spatial voice signaling. The room only relays SDP/ICE between two peers (the
// audio itself flows peer-to-peer over WebRTC), so the cap just has to clear a
// connection handshake's burst of candidates without letting a client flood the
// relay. SDP/ICE are small; anything larger than the cap is rejected outright.
const VOICE_SIGNALS_PER_SEC_LIMIT = 60;
const MAX_VOICE_SIGNAL_BYTES = 16_000;

// Solana mint addresses are base58, 32–44 chars. Anything else (including '')
// collapses to the default mainland world.
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function cleanCoin(v) {
	const s = typeof v === 'string' ? v.trim() : '';
	return MINT_RE.test(s) ? s : '';
}

// Access tier. Only 'holders' is gated; anything else (including '') is the open
// General world. A coin's General and Holders worlds are kept in separate room
// instances by filterBy(['coin','tier']) — see multiplayer/src/index.js.
function cleanTier(v) {
	return v === 'holders' ? 'holders' : '';
}

function clean(str, maxLen) {
	if (typeof str !== 'string') return '';
	// Strip control chars, collapse whitespace, trim, cap length.
	return str
		.replace(/[\x00-\x1f\x7f]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, maxLen);
}

// Numeric guards for world-object payloads: a finite value or the fallback, and a
// clamp into [lo, hi]. Kept tiny and local so the object handlers read cleanly.
function objNum(v, fallback) {
	return Number.isFinite(v) ? v : fallback;
}
function objClamp(v, lo, hi) {
	return v < lo ? lo : v > hi ? hi : v;
}
function round3(n) {
	return Math.round(n * 1000) / 1000;
}

function pickPlayerColor(sessionId) {
	// Deterministic pleasant hue from sessionId — every client renders the
	// same player in the same color without us needing to sync it explicitly.
	let h = 0;
	for (let i = 0; i < sessionId.length; i++) {
		h = (h * 31 + sessionId.charCodeAt(i)) >>> 0;
	}
	const hue = h % 360;
	// HSL → 0xRRGGBB. Sat 65%, lightness 60% gives high-contrast jersey colors.
	return hslToHex(hue / 360, 0.65, 0.6);
}

function hslToHex(h, s, l) {
	const k = (n) => (n + h * 12) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n) => {
		const v = l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
		return Math.round(v * 255);
	};
	return (f(0) << 16) | (f(8) << 8) | f(4);
}

export class WalkRoom extends Room {
	// Players are matched into the same room instance only when their `coin`
	// join option matches — so each coin community is an isolated world while a
	// single room definition serves them all. Coin-less players share the
	// default mainland instance.
	//
	// Tier gate: the General world ('') is open to everyone. The Holders world
	// ('holders') admits a client only with a valid holder pass — an HMAC-signed
	// token the API mints after pricing the user's authenticated wallet against
	// HOLDER_MIN_USD of this exact coin. We verify the pass here, before onJoin,
	// and reject otherwise. Returning false makes Colyseus answer the
	// matchmake/seat request with a 401 the client surfaces as the locked gate.
	static onAuth(client, options) {
		// Platform token gate (orthogonal to the per-coin holder tier below). When a
		// game token is pinned, no client reaches any world — General or Holders —
		// without a play pass proving a signed-in wallet holds ≥ the floor. Throw
		// (not return false) so a refusal arrives as a `play_pass`-prefixed error the
		// client routes back to its sign-in gate. The verified wallet is bound to the
		// session as the account id, never taken from an unsigned join option.
		//
		// KNOWN LANDMINE (2026-07-10): this gate is enforced against every client of
		// this shared room, but only `/play` (src/game/community-net.js) actually
		// carries a `playPass` in its join options — it has the whole wallet
		// sign-in + pass-minting flow. `/walk` (src/walk-net.js) has never had that
		// UI and sends no `playPass` field at all. As long as PLAY_GATE_MINT is unset
		// (the default today) this is inert — every join sails past the `if` below.
		// The moment an operator sets PLAY_GATE_MINT/THREE_MINT, every `/walk` join
		// and reconnect will throw `play_pass_required` and the page will look
		// completely offline, while `/play` keeps working. Fixing this properly means
		// porting real sign-in UI into `/walk` (or extracting the pass-minting flow
		// out of coincommunities.js into a shared module both pages call) — a
		// deliberate product decision about whether `/walk` stays a simpler,
		// no-sign-in surface, not a one-line wiring fix. Do this BEFORE flipping the
		// platform gate on in production, not after someone reports `/walk` is dead.
		if (PLAY_GATE_MINT) {
			const pass = verifyPlayPass(options?.playPass);
			if (!pass) throw new Error('play_pass_required');
			if (pass.mint !== PLAY_GATE_MINT) throw new Error('play_pass_mismatch');
			if (!(typeof pass.balance === 'number' && pass.balance >= PLAY_GATE_MIN)) {
				throw new Error('play_pass_required');
			}
			client.userData = { ...(client.userData || {}), account: pass.wallet, playBalance: pass.balance, playExp: pass.exp };
		}

		const tier = cleanTier(options?.tier);
		if (tier !== 'holders') return true; // open General world

		// A holder world must name a real coin. Throw (rather than return false) so
		// every holder-gate refusal reaches the client as a `holder_pass`-prefixed
		// error its gate UI routes on — a uniform denial contract.
		const coin = cleanCoin(options?.coin);
		if (!coin) throw new Error('holder_pass_required');

		const pass = verifyHolderPass(options?.holderPass);
		if (!pass) {
			throw new Error('holder_pass_required');
		}
		// The pass is for this exact coin's holder tier — a pass minted for coin A
		// can't unlock coin B's holder world.
		if (pass.mint !== coin || pass.tier !== 'holders') {
			throw new Error('holder_pass_mismatch');
		}
		// Carry the verified holding + signed floor through to onJoin/onCreate so
		// in-world affordances and the displayed requirement come from the pass,
		// never from unsigned client options.
		client.userData = {
			...(client.userData || {}),
			holderUsd: pass.usd,
			holderWallet: pass.wallet,
			holderMinUsd: pass.minUsd,
			holderMinTokens: pass.minTokens,
			holderAmount: pass.amount,
		};
		return true;
	}

	constructor() {
		super();
		this.maxClients = MAX_CLIENTS_PER_ROOM;
		this._moveCounters = new Map(); // sessionId → { windowStart, count }
		this._chatCooldowns = new Map();
		this._kickCounters = new Map(); // R05: sessionId → { windowStart, count } for ball:kick rate limit
		// R05 ball physics (server-authoritative). Velocity lives here (off-schema);
		// position is written directly onto the WorldObject each tick and auto-broadcast.
		this._ballVx = 0; this._ballVy = 0; this._ballVz = 0;
		// Off-schema economy: sessionId → runtime profile (pack/purse/skills + the
		// stable persistence id + per-action cooldowns). Never synced to peers.
		this.econ = new Map();
		this._actionCounters = new Map(); // sessionId → { [action]: { windowStart, count } }
		// $THREE boutique (W04) replay guard: settled quote nonces, pruned past the
		// quote TTL so a verified purchase can never re-grant a cosmetic twice, while
		// memory stays bounded (a nonce only needs to outlive its ~90s quote window).
		this._boutiqueNonces = new Map(); // nonce → settledAt (ms)
		// Build permissions & anti-grief (R19). Ownership and density are tracked
		// off-schema (peers don't render them) but persisted with the build so they
		// survive a restart. blockOwners: key → owner id. blockCounts: owner id → how
		// many cells they hold (drives the per-player cap, keyed by stable owner so it
		// outlives a disconnect while their build stands). columnCounts: "x,z" → height.
		this.blockOwners = new Map();
		this.blockCounts = new Map();
		this.columnCounts = new Map();
		// The coin's on-chain creator wallet, resolved once on create. '' until known
		// (or for the ownerless mainland world); gates the clear-area moderation tool.
		this.coinCreator = '';
		// Co-op heist instances live on the room, not on a profile: a SHARED run a
		// crew advances together. Keyed by mission id (one live instance per heist per
		// world). Each value: { missionId, members:Set<sessionId>, run } — the run
		// carries its own per-stage seen-zone dedupe (quests.js applyEvent).
		this.heists = new Map();
		// Tag mini-game (R08): off-schema state. _tagImmunity tracks who is immune
		// (sessionId → epoch ms immunity expires). _tagTime tracks cumulative time-as-it
		// per session ({ timeMs: number, becameIt: epoch|null }).
		this._tagImmunity = new Map();
		this._tagTime = new Map();
		// King of the Totem (R07): off-schema round + score state. `phase` is the
		// round machine ('idle' waiting for players | 'active' round running |
		// 'intermission' showing the winner). `scores` is sessionId → accumulated
		// points for the CURRENT round (floats; rounded only for display). `kingId`
		// is the current sole occupant (null when empty or contested). `winner` is
		// the last completed round's result, surfaced during the intermission.
		this._king = {
			phase: 'idle',
			roundId: 0,
			startedAt: 0,
			endsAt: 0,
			nextAt: 0,
			lastTickAt: 0,
			scores: new Map(),
			kingId: null,
			winner: null,
		};
	}

	async onCreate(options) {
		this.setState(new WalkState());
		this.setPatchRate(PATCH_RATE_MS);
		this.autoDispose = true;

		// The first client to land in this coin's instance seeds its identity.
		this.state.coin = cleanCoin(options?.coin);
		this.state.coinName = clean(options?.coinName, 48);
		this.state.coinSymbol = clean(options?.coinSymbol, 16);
		this.state.coinImage = cleanAvatarUrl(options?.coinImage) || (
			typeof options?.coinImage === 'string' && options.coinImage.startsWith('http')
				? options.coinImage.slice(0, 1024) : '');
		// Tier identity. The Holders world records the USD floor it gated on (from
		// the joining pass) so the client HUD can state the requirement; the General
		// world leaves both blank/zero.
		this.state.tier = cleanTier(options?.tier);
		if (this.state.tier === 'holders') {
			// The displayed floor comes from the signed pass (the issuer's real
			// HOLDER_MIN_USD), not the client's unsigned `holderMinUsd` option which a
			// malicious first-joiner could otherwise use to misstate the requirement
			// for everyone in the room. Fall back to the server's own env, then 8.
			const signedPass = verifyHolderPass(options?.holderPass);
			const signed = signedPass?.minUsd;
			const envMin = Number(process.env.HOLDER_MIN_USD);
			this.state.holderMinUsd = Number.isFinite(signed) && signed > 0
				? signed
				: (Number.isFinite(envMin) && envMin > 0 ? envMin : 8);
			// R24: when the creator pinned a token threshold, record it from the signed
			// pass (never the unsigned option) so the HUD states "hold N $SYM to enter".
			const signedTokens = signedPass?.minTokens;
			this.state.holderMinTokens = Number.isFinite(signedTokens) && signedTokens > 0 ? signedTokens : 0;
		}
		// Persisted-build key. General and Holders are separate worlds for the same
		// coin, so their voxel builds must persist independently — otherwise the two
		// rooms would load and flush over each other's creation.
		this.worldKey = this.state.tier === 'holders' ? `${this.state.coin}#holders` : this.state.coin;

		this.onMessage('move', (client, payload) => this._handleMove(client, payload));
		this.onMessage('rename', (client, payload) => this._handleRename(client, payload));
		this.onMessage('emote', (client, payload) => this._handleEmote(client, payload));
		this.onMessage('chat', (client, payload) => this._handleChat(client, payload));
		this.onMessage('avatar', (client, payload) => this._handleAvatar(client, payload));
		this.onMessage('play-pass', (client, payload) => this._handlePlayPassRefresh(client, payload));
		this.onMessage('place', (client, payload) => this._handlePlace(client, payload));
		this.onMessage('place-batch', (client, payload) => this._handlePlaceBatch(client, payload));
		this.onMessage('remove', (client, payload) => this._handleRemove(client, payload));
		this.onMessage('build-clear', (client, payload) => this._handleBuildClear(client, payload));
		this.onMessage('voice-state', (client, payload) => this._handleVoiceState(client, payload));
		this.onMessage('voice-signal', (client, payload) => this._handleVoiceSignal(client, payload));
		// Economy & activities (off-schema). The owning client drives these and
		// receives the authoritative result via profile/inv/xpgain/levelup/notice.
		this.onMessage('fish', (client) => this._handleFish(client));
		registerActivityHandlers(this); // W06 gather/craft: chop, mine, cook
		registerCombatHandlers(this); // W07 combat: attack, loot
		this.onMessage('equip', (client, payload) => this._handleEquip(client, payload));
		this.onMessage('consume', (client, payload) => this._handleConsume(client, payload));
		// General store, bank/ATM, and the $THREE boutique (W04). Cash trades and
		// banking settle purely off-schema; the boutique settles a real on-chain
		// $THREE payment (game-token.js) before granting a premium cosmetic.
		this.onMessage('storeReq', (client) => this._sendStore(client));
		this.onMessage('storeBuy', (client, payload) => this._handleStoreBuy(client, payload));
		this.onMessage('storeSell', (client, payload) => this._handleStoreSell(client, payload));
		this.onMessage('bank', (client, payload) => this._handleBank(client, payload));
		this.onMessage('boutiqueReq', (client) => this._sendBoutique(client));
		this.onMessage('boutiqueQuote', (client, payload) => this._handleBoutiqueQuote(client, payload));
		this.onMessage('boutiqueSettle', (client, payload) => this._handleBoutiqueSettle(client, payload));
		// Equip/unequip a cosmetic from the owned-inventory (R23). Server-authoritative:
		// validates ownership, persists the loadout to the account, re-publishes it on
		// the schema so peers re-render, and echoes the owner a fresh profile.
		this.onMessage('equip-cosmetic', (client, payload) => this._handleEquipCosmetic(client, payload));
		// Full-loadout broadcast (R03): replaces the player's entire equipped state in
		// one shot, re-validated against ownership — mirrors how `avatar` is sent.
		this.onMessage('set-cosmetics', (client, payload) => this._handleSetCosmetics(client, payload));
		this.onMessage('profileReq', (client) => this._sendProfile(client));
		// Quests, jobs & heists (W05, off-schema). The board, accepting/abandoning a
		// mission, and acting at a quest object all flow through here; the server is the
		// sole authority for objective progress and reward grants.
		this.onMessage('questReq', (client) => this._sendQuests(client));
		this.onMessage('questAccept', (client, payload) => this._handleQuestAccept(client, payload));
		this.onMessage('questAbandon', (client, payload) => this._handleQuestAbandon(client, payload));
		this.onMessage('questInteract', (client) => this._handleQuestInteract(client));
		// Vehicles. The driver streams 'vsync' (the Rapier-simulated transform); the
		// server validates per-type speed/bounds and relays. 'venter'/'vexit' take and
		// release the wheel, gated by proximity and single-occupancy.
		this.onMessage('venter', (client, payload) => this._handleVehicleEnter(client, payload));
		this.onMessage('vexit', (client, payload) => this._handleVehicleExit(client, payload));
		this.onMessage('vsync', (client, payload) => this._handleVehicleSync(client, payload));
		// Generic world objects (R01): spawn/move/remove balls, props and pickups on
		// the shared `objects` map. Durable build props placed here persist per coin
		// world (R17); transient kinds (the R05 ball) live only for the session.
		this.onMessage('obj:spawn', (client, payload) => this._handleObjSpawn(client, payload));
		this.onMessage('obj:update', (client, payload) => this._handleObjUpdate(client, payload));
		this.onMessage('obj:remove', (client, payload) => this._handleObjRemove(client, payload));
		// R05 physics ball: client sends kick intent with impulse; server validates,
		// applies velocity, and integrates physics on its own tick. Clients never move
		// the ball directly — ownerId is 'server', blocking obj:update from them.
		this.onMessage('ball:kick', (client, payload) => this._handleBallKick(client, payload));
		// Broadcast reactions (R04): a client sends an emoji; the server rate-limits
		// and rebroadcasts to all clients in the room (including the sender).
		this.onMessage('reaction', (client, payload) => this._handleReaction(client, payload));
		this._emoteCooldowns = new Map();
		this._reactionCooldowns = new Map();
		this._editCounters = new Map(); // sessionId → { windowStart, count }
		this._batchCounters = new Map(); // sessionId → { windowStart, count } for composite stamps
		this._voiceCounters = new Map(); // sessionId → { windowStart, count }
		this._objCounters = new Map();   // sessionId → { windowStart, count } for obj:* ops
		this._objSeq = 0;                // monotonic counter for server-minted object ids

		// Rehydrate this coin's persisted build before the first client renders the
		// world, so newcomers always drop into the community's existing creation.
		try {
			const saved = await blockStore.load(this.worldKey);
			for (const [key, rec] of saved) {
				const b = new Block();
				b.t = rec.t;
				this.state.blocks.set(key, b);
				// Rehydrate ownership + density so the per-player cap, column cap, and
				// the "only the placer (or creator) may delete" rule hold for a build
				// that was placed before this process started.
				this._trackPlacement(key, rec.o || '');
			}
			if (saved.size) {
				console.log(`[walk_world ${this.roomId} coin=${this.state.coin || 'mainland'}] restored ${saved.size} blocks`);
			}
		} catch (err) {
			console.warn(`[walk_world ${this.roomId}] block restore failed:`, err?.message);
		}

		// Rehydrate this coin's durable placed objects (R17) — the build props the
		// community left behind — from the per-world persistence store before the
		// first client renders, mirroring how blocks are restored above. The store is
		// keyed by world id; mainland (empty coin) gets a stable fallback key. Blocks
		// and objects share the world key but live in separate backends, so they
		// don't collide. load() never throws (it falls back to its memory mirror).
		this._objKey = this.worldKey || 'mainland';
		try {
			const { doc } = await worldPersistence.load(this._objKey);
			this._restoreObjects(doc);
		} catch (err) {
			console.warn(`[walk_world ${this.roomId}] object restore failed:`, err?.message);
		}

		// Tell builders, honestly, whether this world survives a server restart.
		// load() above already awaited the store's readiness probe, so durability
		// is settled by now.
		await blockStore.ready();
		this.state.persistent = blockStore.durable;

		// Seed this world's drivable fleet. Vehicles are world entities (everyone sees
		// them) so they ride on the synced state, parked until someone takes the wheel.
		// Spawned for every coin world — driving is a core verb, not a flagship-only
		// affordance. v1 fleet is ephemeral per room (re-spawned fresh each time the
		// room is created); persistence of parked vehicles is a later concern.
		this._seedVehicles();

		// W07: seed the PvE mob roster into the danger zones, then start the AI +
		// heat-decay ticks. Two independent intervals (mob AI is coarser than the
		// per-second heat decay) so tuning one never nudges the other's cadence.
		seedMobs(this);
		this.clock.setInterval(() => tickMobs(this, MOB_TICK_MS), MOB_TICK_MS);
		this.clock.setInterval(() => tickHeat(this, HEAT_TICK_MS), HEAT_TICK_MS);

		// R05: spawn the shared beach ball at world centre and start its physics tick.
		// Server-owned (ownerId = SERVER_OBJECT_OWNER) so no client can move or remove
		// it via the generic obj:update / obj:remove channels.
		this._spawnBall();
		this.clock.setInterval(() => this._tickBall(), BALL_TICK_MS);

		// Resolve this coin's on-chain creator so the build-permission layer can grant
		// the creator world-wide moderation (delete any piece, clear an area). Fetched
		// once, off the hot path; a failure just leaves the world without a creator
		// (no moderation tool), never blocks the room. The mainland world has no coin
		// and therefore no creator.
		this._resolveCoinCreator();

		// Re-check policy for the token gate. The game server has no RPC of its own,
		// so "still holding the token" is re-proven by the client minting a fresh
		// play pass (which re-reads the chain) before the current one's 10-min TTL
		// runs out and reconnecting — onAuth then re-validates. To actively evict a
		// wallet that offloaded below the floor mid-session, we sweep once a minute
		// and disconnect any client whose bound pass has expired without a refresh.
		// The client refreshes ahead of expiry, so a holder never sees this; only a
		// wallet that stopped qualifying (or a forged-then-expired pass) gets dropped.
		if (PLAY_GATE_MINT) {
			this.clock.setInterval(() => {
				const nowS = Date.now() / 1000;
				for (const client of this.clients) {
					const exp = client.userData?.playExp;
					if (typeof exp === 'number' && exp < nowS) {
						try { client.leave(4002, 'play_pass_required'); } catch {}
					}
				}
			}, 60_000);
		}

		// Tag mini-game (R08): refresh the leaderboard time values for all clients
		// periodically so the displayed "time as it" increments visibly even without
		// a tag event. Only fires when the game is active (an "it" player exists).
		this.clock.setInterval(() => {
			if (this._itPlayer()) this._broadcastTagState();
		}, TAG_LB_INTERVAL_MS);

		// Dance floor beat — every 4 s, aligned across all clients in the room so
		// avatars standing on the disco pad start the same crossfade at the same
		// wall-clock moment. Clip rotates through the four dance animations.
		const DANCE_FLOOR_CLIPS = ['av-dance-shuffle', 'av-rap-dance', 'av-headbang', 'dance'];
		let _beatIdx = 0;
		this.clock.setInterval(() => {
			this.broadcast('floor:beat', { clip: DANCE_FLOOR_CLIPS[_beatIdx++ % DANCE_FLOOR_CLIPS.length] });
		}, 4000);

		// King of the Totem (R07): the single authoritative clock that runs the round
		// machine — awards points to a sole zone occupant, ends a round on time, and
		// schedules the next one. One interval drives scoring, the countdown, and the
		// idle→active→intermission transitions so the timing can never drift apart.
		this.clock.setInterval(() => this._kingTick(), KING_TICK_MS);
	}

	async onJoin(client, options) {
		const name = clean(options?.name, 24) || `guest-${client.sessionId.slice(0, 4)}`;
		const player = new Player();
		player.id = client.sessionId;
		player.name = name;
		player.color = pickPlayerColor(client.sessionId);
		player.x = 0;
		player.y = 0;
		player.z = 0;
		player.yaw = 0;
		player.motion = 'idle';
		player.avatar = cleanAvatarUrl(options?.avatar);
		player.agent = clean(options?.agent, 64);
		// The account id is the wallet verified in onAuth — bound server-side, never
		// from a client option, so it's a trustworthy persistence + social-graph key.
		player.account = clean(client.userData?.account, 64);
		player.tsServer = Date.now();
		this.state.players.set(client.sessionId, player);

		// Friends presence (Task 15): a presence ticket signed by the three.ws API
		// proves which account this socket belongs to, independent of the wallet
		// holder gate. Register it so friends see this player as online in this
		// coin world and can DM them live. Spoof-proof — the account id comes from
		// the verified ticket, never a raw client option.
		const accountUid = verifyPresenceTicket(options?.presence);
		if (accountUid) {
			client.userData = { ...(client.userData || {}), accountUid };
			socialHub.register(accountUid, client, this.state.coinName || 'Mainland');
		}

		// Economy profile (off-schema). Keyed to a stable account: the wallet verified
		// in onAuth when the platform gate is on, else a client-persisted guest id, so
		// a player's pack/purse/skills survive a disconnect and follow them between
		// coin worlds. Hydrate the durable record before the synchronous load so a
		// returning player on a fresh process isn't reset to the starter kit.
		const playerId = clean(client.userData?.account, 80) || clean(options?.pid, 80) || client.sessionId;
		try { await hydratePlayer(playerId); } catch { /* memory-only fallback */ }
		// A slower-arriving leave could fire while we awaited; bail if so.
		if (!this.state.players.has(client.sessionId)) return;
		const saved = loadPlayer(playerId);
		const profile = restoreProfile(saved?.profile, playerId);
		profile.cd = { fish: 0, consume: 0, chop: 0, mine: 0, cook: 0, attack: 0, pickupRod: 0 }; // per-action cooldown clocks (runtime only)
		// Quest log (W05): the player's accepted/completed missions + daily state,
		// persisted alongside the pack/purse. Stale dailies roll over to today on load.
		profile.quests = restoreQuestState(saved?.profile?.quests, utcDayKey());
		profile._zone = null; // last quest zone the player was inside (enter-zone edge detect)
		this.econ.set(client.sessionId, profile);
		// Cosmetics ownership (R22 → R23): fold the premium cosmetics this account
		// bought over the x402 rail into its unlocked set, so a purchase persists and
		// equips in EVERY world the account joins — not just the one it was bought in.
		// The ledger is keyed by the same account id as the profile (playerId), reads
		// fail-open (own nothing extra) and never block the join. Persist only when a
		// new unlock actually landed so a returning player keeps it across restarts.
		try {
			const newlyOwned = mergeOwnedFromLedger(profile, await readOwnedCosmetics(playerId));
			if (newlyOwned > 0) this._persistEcon(client.sessionId);
		} catch (err) {
			console.warn(`[walk_world] cosmetics ledger seed failed for ${playerId}:`, err?.message);
		}
		// A slower-arriving leave could have fired while we awaited the ledger.
		if (!this.state.players.has(client.sessionId)) return;
		// Cosmetics (W03): apply any loadout the player chose pre-join (in the
		// character creator) on top of their persisted one, validating each id
		// against what they own — free cosmetics always pass, premium only when
		// unlocked, so a join option can never put an unowned cosmetic on a player.
		// Then publish the equipped loadout on the schema so peers render the look.
		this._applyJoinCosmetics(profile, options?.cosmetics);
		player.cosmetics = serializeLoadout(profile.cosmetics.equipped);
		// W07: publish the wanted-star count peers can see (dead defaults false).
		// A restored profile can carry saved heat from a prior session's crimes.
		player.heat = heatStars(profile.heat);
		this._sendProfile(client);
		this._sendQuests(client);
		// Build permissions: the per-player cap, current usage, and whether this player
		// is the coin creator (so the HUD can reveal the clear-area moderation tool).
		// Re-sent later if the creator lookup resolves after this join.
		this._sendBuildPerms(client);

		const tierTag = this.state.tier === 'holders' ? ' tier=holders' : '';
		console.log(
			`[walk_world ${this.roomId} coin=${this.state.coin || 'mainland'}${tierTag}] +join ${client.sessionId} ${name} (n=${this.state.players.size})`,
		);

		// "Someone is hanging out in <world>" — social proof + FOMO on the site-wide
		// ticker. Throttled per world so a popular coin emits at most once a minute,
		// not once per arrival. Mainland falls back to a friendly label.
		publishFeedEvent(
			{
				type: 'world-join',
				ts: Date.now(),
				actor: name,
				coin: this.state.coin || '',
				coinName: this.state.coinName || (this.state.coin ? '' : 'Mainland'),
			},
			this.state.coin || 'mainland',
		);

		// Tag mini-game (R08): register this session and start the game if we now
		// have enough players. This runs AFTER the hydratePlayer await so the player
		// is confirmed still present. Uses a random initial assignment so the first
		// player to join isn't always "it" on arrival.
		this._tagTime.set(client.sessionId, { timeMs: 0, becameIt: null });
		if (this.state.players.size >= TAG_MIN_PLAYERS && !this._itPlayer()) {
			this._assignIt(this._randomTagPlayer(null));
		}

		// King of the Totem (R07): give the new arrival a zero score row for the
		// current round and immediately sync them the live game state (zone bounds,
		// phase, countdown, scoreboard) so their HUD is correct mid-round instead of
		// blank until the next broadcast. If the room was idle and now has enough
		// players, the next tick starts a round; sync reflects that on the following
		// beat. Sending zone + phase here is what lets a late joiner render the ring
		// and timer without waiting up to a full second.
		if (this._king.phase === 'active') this._king.scores.set(client.sessionId, 0);
		this._sendKingSync(client);
	}

	onLeave(client) {
		if (client.userData?.accountUid) socialHub.unregister(client.userData.accountUid, client);
		// Tag mini-game (R08): capture wasIt BEFORE state.players.delete below, so
		// we know if someone needs reassigning. Cleanup runs after the delete.
		const _tagWasIt = this.state.players.get(client.sessionId)?.it ?? false;
		// Resolve this owner's object key up front — _ownerKey reads the econ profile,
		// which the block below deletes, so capture it before reaping their objects.
		const ownerKey = this._ownerKey(client.sessionId);
		// Free any vehicle this player was driving so it parks where it was left and
		// becomes available again — otherwise a disconnect would lock a car forever.
		this._releaseVehicleOf(client.sessionId);
		// Drop the player from any co-op heist instance they were in, so the shared run
		// doesn't hold a phantom crew member (and disposes when the last one leaves).
		this._leaveHeists(client.sessionId);
		// Persist the final economy state and arm a durable flush so progress survives
		// the disconnect and the room being torn down when the last player leaves.
		const profile = this.econ.get(client.sessionId);
		if (profile) {
			this._persistEcon(client.sessionId);
			if (profile.playerId) { try { flushPlayer(profile.playerId); } catch { /* best-effort */ } }
			this.econ.delete(client.sessionId);
		}
		// Reap this owner's transient objects (R01): balls and fx they spawned die
		// with their session. Their durable build props stay as part of the world
		// (R17) — that's the whole point of persistence.
		this._reapOwnerTransients(ownerKey);
		this.state.players.delete(client.sessionId);
		// Tag mini-game (R08): finalize this player's tracked time, purge immunity,
		// and reassign "it" if they were the tagged player and enough peers remain.
		this._tagImmunity.delete(client.sessionId);
		this._finalizeTagTime(client.sessionId);
		if (_tagWasIt) {
			if (this.state.players.size >= TAG_MIN_PLAYERS) {
				this._assignIt(this._randomTagPlayer(null));
			} else {
				for (const [, p] of this.state.players) { p.it = false; p.itSince = 0; }
				this._broadcastTagState();
			}
		}
		this._tagTime.delete(client.sessionId);
		// King of the Totem (R07): drop their current-round score and demote them if
		// they were holding the zone. Their accumulated points are forfeited (a player
		// who leaves can't win), and the next tick re-evaluates occupancy from scratch,
		// so a departing king never freezes the crown. The round itself keeps running.
		this._king.scores.delete(client.sessionId);
		if (this._king.kingId === client.sessionId) {
			this._king.kingId = null;
			if (this._king.phase === 'active') this._broadcastKing('tick');
		}
		this._moveCounters.delete(client.sessionId);
		this._chatCooldowns.delete(client.sessionId);
		this._editCounters?.delete(client.sessionId);
		this._batchCounters?.delete(client.sessionId);
		this._emoteCooldowns?.delete(client.sessionId);
		this._reactionCooldowns?.delete(client.sessionId);
		this._voiceCounters?.delete(client.sessionId);
		this._objCounters?.delete(client.sessionId);
		this._actionCounters.delete(client.sessionId);
		this._kickCounters?.delete(client.sessionId);
		console.log(
			`[walk_world ${this.roomId}] -leave ${client.sessionId} (n=${this.state.players.size})`,
		);
	}

	async onDispose() {
		// Persist the final build so the community's creation survives the room
		// being torn down when the last player leaves. Awaited (Colyseus waits on
		// the returned promise) so the Redis write lands before the room is gone —
		// fire-and-forget here would race the process exiting on a redeploy.
		try {
			await blockStore.flush(this.worldKey);
		} catch (err) {
			console.warn(`[walk_world ${this.roomId}] final flush failed:`, err?.message);
		}
		// Flush the durable placed objects (R17) the same way — any spawn/move/remove
		// whose debounce hadn't fired lands before the room is gone, so leaving and
		// re-entering (or a redeploy) shows the same build.
		try {
			await worldPersistence.flush(this._objKey);
		} catch (err) {
			console.warn(`[walk_world ${this.roomId}] final object flush failed:`, err?.message);
		}
		// Flush any economy profiles still resident (a redeploy can dispose a room
		// with players mid-session) so no progression is lost between the last
		// change and the room going away.
		try {
			await Promise.allSettled([...this.econ.values()]
				.map((p) => p.playerId && flushPlayer(p.playerId)).filter(Boolean));
		} catch { /* best-effort */ }
		console.log(`[walk_world ${this.roomId}] disposed`);
	}

	_handleMove(client, payload) {
		const player = this.state.players.get(client.sessionId);
		if (!player) return;
		// W07: a downed player is off their feet until the respawn timer clears
		// them (killPlayer teleports to SPAWN_POINT itself) — reject stray moves so
		// a "ragdolled" peer can't be walked around mid-death.
		if (player.dead) return;

		if (!this._rateOk(client.sessionId)) return;

		if (!payload || typeof payload !== 'object') return;
		const { x, y, z, yaw, motion } = payload;
		if (
			typeof x !== 'number' ||
			typeof y !== 'number' ||
			typeof z !== 'number' ||
			typeof yaw !== 'number' ||
			!Number.isFinite(x) ||
			!Number.isFinite(y) ||
			!Number.isFinite(z) ||
			!Number.isFinite(yaw)
		) {
			return;
		}

		// Max-step clamp — reject teleports.
		const dx = x - player.x;
		const dz = z - player.z;
		if (Math.hypot(dx, dz) > MAX_STEP_M) {
			// Don't update position, but allow yaw/motion changes (legitimate
			// when the client respawns or recovers from a temporary disconnect).
			player.yaw = yaw;
			if (MOTION_VALUES.has(motion)) player.motion = motion;
			player.tsServer = Date.now();
			return;
		}

		// World bounds clamp — the square open-world district (W01).
		player.x = Math.max(-WORLD_BOUND_M, Math.min(WORLD_BOUND_M, x));
		player.z = Math.max(-WORLD_BOUND_M, Math.min(WORLD_BOUND_M, z));
		player.y = Math.max(-10, Math.min(10, y)); // keep avatars near the ground plane
		player.yaw = yaw;
		if (MOTION_VALUES.has(motion)) player.motion = motion;
		player.tsServer = Date.now();

		// Quest progress: detect entering a NEW quest zone (edge-triggered off the
		// authoritative position, so a "goto" objective can't be faked from the client).
		this._checkZoneEntry(client);

		// Tag mini-game (R08): if this mover is "it", check whether they've caught
		// an adjacent player. All proximity math uses the server's authoritative
		// positions — the client can never claim a tag.
		if (player.it) this._checkTag(client.sessionId, player);
	}

	// Edge-detect quest-zone entry on the server's authoritative position. Emits a
	// single 'enter-zone' event when the player crosses into a zone they weren't in
	// last tick — never per-frame while standing in it — so survey/patrol objectives
	// advance exactly once per visit. Cheap (a handful of zones); only does work when
	// the current zone actually changed.

	// ─── Tag mini-game helpers (R08) ────────────────────────────────────────────

	/** Return the sessionId of the current "it" player, or null if nobody is. */
	_itPlayer() {
		for (const [id, p] of this.state.players) {
			if (p.it) return id;
		}
		return null;
	}

	/** Return a random sessionId from state.players, excluding `excludeId`. */
	_randomTagPlayer(excludeId) {
		const eligible = [];
		for (const [id] of this.state.players) {
			if (id !== excludeId) eligible.push(id);
		}
		if (!eligible.length) return null;
		return eligible[Math.floor(Math.random() * eligible.length)];
	}

	/** Assign "it" to `newItId`. Clears the old "it", sets immunity on them,
	 *  starts tracking time for the new one, then broadcasts the new state. */
	_assignIt(newItId) {
		if (!newItId) return;
		const now = Date.now();
		// Clear current "it" and give them temporary immunity.
		for (const [id, p] of this.state.players) {
			if (p.it && id !== newItId) {
				p.it = false;
				p.itSince = 0;
				this._finalizeTagTime(id);
				this._tagImmunity.set(id, now + TAG_IMMUNITY_MS);
			}
		}
		// Promote the new "it".
		const newIt = this.state.players.get(newItId);
		if (!newIt) return;
		newIt.it = true;
		newIt.itSince = now;
		const ts = this._tagTime.get(newItId) || { timeMs: 0, becameIt: null };
		ts.becameIt = now;
		this._tagTime.set(newItId, ts);
		// Notify the newly-tagged client so they get the "YOU'RE IT!" alert.
		try {
			const clients = this.clients.filter(c => c.sessionId === newItId);
			if (clients.length) this.send(clients[0], 'tag', { event: 'became-it', itId: newItId });
		} catch { /* best-effort */ }
		this._broadcastTagState();
	}

	/** Check whether the "it" player (itId, itPlayer) is close enough to any other
	 *  non-immune player to transfer the tag. Proximity uses the server's positions. */
	_checkTag(itId, itPlayer) {
		const now = Date.now();
		for (const [id, p] of this.state.players) {
			if (id === itId) continue;
			const immunity = this._tagImmunity.get(id) || 0;
			if (now < immunity) continue;
			const dx = p.x - itPlayer.x;
			const dz = p.z - itPlayer.z;
			if (Math.hypot(dx, dz) <= TAG_RANGE_M) {
				this._assignIt(id);
				break;
			}
		}
	}

	/** Accumulate elapsed "it" time for a player into their running total.
	 *  Safe to call even when the player was never "it" (becameIt stays null). */
	_finalizeTagTime(sessionId) {
		const ts = this._tagTime.get(sessionId);
		if (!ts || ts.becameIt === null) return;
		ts.timeMs += Date.now() - ts.becameIt;
		ts.becameIt = null;
	}

	/** Broadcast the full tag state (who's "it" + live leaderboard) to all clients. */
	_broadcastTagState() {
		const itId = this._itPlayer();
		const now = Date.now();
		const rows = [];
		for (const [id] of this.state.players) {
			const ts = this._tagTime.get(id);
			if (!ts) continue;
			let totalMs = ts.timeMs;
			if (ts.becameIt !== null) totalMs += now - ts.becameIt;
			if (totalMs > 0) {
				const p = this.state.players.get(id);
				rows.push({ id, name: p?.name || id, timeMs: totalMs });
			}
		}
		rows.sort((a, b) => b.timeMs - a.timeMs);
		this.broadcast('tag', { event: 'state', itId, leaderboard: rows.slice(0, 8) });
	}

	// ─── King of the Totem helpers (R07) ────────────────────────────────────────

	/** Sessions whose authoritative position is inside the king-zone right now.
	 *  Read from the server's clamped positions (never client claims) and skip
	 *  downed players, so the zone can't be held by a corpse or faked from afar. */
	_kingOccupants() {
		const inside = [];
		for (const [id, p] of this.state.players) {
			if (p.dead) continue;
			const dx = p.x - KING_ZONE.x;
			const dz = p.z - KING_ZONE.z;
			if (Math.hypot(dx, dz) <= KING_ZONE.r) inside.push(id);
		}
		return inside;
	}

	/** The current-round scoreboard: present players sorted high→low, rounded for
	 *  display, capped to the top 8 the HUD shows. A player with no points yet
	 *  still appears (score 0) so the board reads as "everyone's in the running". */
	_kingScoreRows() {
		const rows = [];
		for (const [id, p] of this.state.players) {
			const score = this._king.scores.get(id) || 0;
			rows.push({ id, name: p.name || id.slice(0, 6), score: Math.round(score) });
		}
		rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
		return rows.slice(0, 8);
	}

	/** One authoritative beat: drives scoring, the countdown, and every phase
	 *  transition. Idempotent per second — safe even if a tick is delayed. */
	_kingTick() {
		const now = Date.now();
		const k = this._king;

		if (k.phase === 'active') {
			// Award the sole occupant points for the real time since the last tick
			// (clamped so a stalled interval can't dump a huge lump sum). Contested
			// (2+) or empty (0) means nobody scores and there's no king this beat.
			const occ = this._kingOccupants();
			if (occ.length === 1) {
				const dt = Math.min(2, Math.max(0, (now - k.lastTickAt) / 1000));
				const id = occ[0];
				k.scores.set(id, (k.scores.get(id) || 0) + KING_POINTS_PER_SEC * dt);
				k.kingId = id;
			} else {
				k.kingId = null;
			}
			k.lastTickAt = now;

			if (now >= k.endsAt) this._endKingRound();
			else this._broadcastKing('tick');
			return;
		}

		if (k.phase === 'intermission') {
			// Hold on the winner, then start the next round once enough players remain
			// (otherwise drop back to idle and wait for arrivals).
			if (now >= k.nextAt) {
				if (this.state.players.size >= KING_MIN_PLAYERS) this._startKingRound();
				else { k.phase = 'idle'; this._broadcastKing('idle'); }
			}
			return;
		}

		// idle: kick off a round as soon as the world has someone to play.
		if (this.state.players.size >= KING_MIN_PLAYERS) this._startKingRound();
	}

	/** Begin a fresh round: reset scores, stamp the timer, announce the start. */
	_startKingRound() {
		const now = Date.now();
		const k = this._king;
		k.phase = 'active';
		k.roundId += 1;
		k.startedAt = now;
		k.endsAt = now + KING_ROUND_MS;
		k.lastTickAt = now;
		k.kingId = null;
		k.winner = null;
		k.scores = new Map();
		for (const [id] of this.state.players) k.scores.set(id, 0);
		this._broadcastKing('start');
	}

	/** End the active round: pick the highest-scoring PRESENT player as winner
	 *  (a score of 0 across the board ⇒ no winner — an honest "nobody held it"),
	 *  enter the intermission, and announce the result so clients celebrate. */
	_endKingRound() {
		const now = Date.now();
		const k = this._king;
		const rows = this._kingScoreRows();
		const top = rows.length && rows[0].score > 0 ? rows[0] : null;
		k.winner = top ? { id: top.id, name: top.name, score: top.score } : null;
		k.phase = 'intermission';
		k.kingId = null;
		k.nextAt = now + KING_INTERMISSION_MS;
		this._broadcastKing('end');
	}

	/** Shared snapshot of the live game state for both broadcasts and per-client
	 *  sync. Always carries the zone bounds so a client can render the ring without
	 *  hardcoding them, plus the phase, countdown anchors, scoreboard and king. */
	_kingSnapshot(event) {
		const k = this._king;
		return {
			event,
			phase: k.phase,
			roundId: k.roundId,
			now: Date.now(),
			endsAt: k.endsAt,
			nextAt: k.nextAt,
			durationMs: KING_ROUND_MS,
			zone: KING_ZONE,
			kingId: k.kingId,
			winner: k.winner,
			scores: this._kingScoreRows(),
		};
	}

	/** Broadcast the current game state to everyone in the room. */
	_broadcastKing(event) {
		this.broadcast('game:king', this._kingSnapshot(event));
	}

	/** Send the current game state to one client (on join), so a mid-round arrival
	 *  sees the correct zone, timer and scoreboard immediately. */
	_sendKingSync(client) {
		try { this.send(client, 'game:king', this._kingSnapshot('sync')); } catch { /* best-effort */ }
	}

	// ─────────────────────────────────────────────────────────────────────────────

	_checkZoneEntry(client) {
		const profile = this.econ.get(client.sessionId);
		if (!profile) return;
		const player = this.state.players.get(client.sessionId);
		if (!player) return;
		const zone = zoneAt(player.x, player.z);
		const id = zone ? zone.id : null;
		if (id === profile._zone) return; // no transition
		profile._zone = id;
		if (id) this._questEvent(client, profile, { type: 'enter-zone', zone: id });
	}

	// --- Quests, jobs & heists (W05) -------------------------------------------
	// The quest engine (quests.js) is pure data + state transitions; this section is
	// the room's authority glue: it feeds REAL gameplay events into the engine, pays
	// rewards through the same purse/XP idioms the activities use, and manages the
	// co-op heist instances that live on the room (this.heists), not on a profile.

	// Send the owning client its jobs board + active runs ({offers, active, day} —
	// the shape community-net.js documents). Solo runs come straight from the
	// engine's snapshot (which also rolls stale daily state over to today); a heist
	// run is overlaid with the crew's SHARED instance so every member's tracker
	// shows the same live progress, plus the current crew size.
	_sendQuests(client) {
		const profile = this.econ.get(client.sessionId);
		if (!profile) return;
		const snap = questSnapshot(profile.quests, utcDayKey());
		for (let i = 0; i < snap.active.length; i++) {
			const inst = this.heists.get(snap.active[i].id);
			if (inst) {
				snap.active[i] = { ...runView(inst.run, missionDef(inst.missionId)), crew: inst.members.size };
			}
		}
		client.send('quests', snap);
	}

	// Accept a mission off the board. The engine owns the eligibility rules (already
	// active, prereqs, daily/once repeats); a refusal is surfaced as a notice, never
	// a silent no-op. Accepting a heist joins (or founds) this world's one shared
	// instance — the crew advances a single run together and splits the pot at payout.
	_handleQuestAccept(client, payload) {
		const profile = this.econ.get(client.sessionId);
		if (!profile) return;
		if (!this._actionOk(client.sessionId, 'quest')) return;
		const id = typeof payload?.id === 'string' ? payload.id.slice(0, 64) : '';
		const mission = missionDef(id);
		if (!mission) return;
		const res = acceptMission(profile.quests, id, utcDayKey());
		if (!res.ok) {
			const text = res.reason === 'active' ? 'You already took that job.'
				: res.reason === 'daily-done' ? 'That job is done for today — check back tomorrow.'
				: res.reason === 'done' ? 'You’ve already completed that job.'
				: 'That job isn’t available to you yet.';
			client.send('notice', { kind: 'quest', text });
			return;
		}
		if (isHeist(id)) {
			let inst = this.heists.get(id);
			if (!inst) {
				// First accept founds the instance; the founder's fresh run IS the shared
				// run every later member advances (it's never persisted — see quests.js).
				inst = { missionId: id, members: new Set(), run: res.run };
				this.heists.set(id, inst);
			}
			inst.members.add(client.sessionId);
			// The crew grew — every member's tracker shows the new headcount.
			this._sendQuestsToCrew(inst, client.sessionId);
		}
		this._persistEcon(client.sessionId);
		client.send('notice', { kind: 'quest', text: `Accepted: ${mission.title}` });
		this._sendQuests(client);
	}

	// Abandon an active mission. Solo progress is simply dropped (a daily can be
	// re-accepted the same day); leaving a heist removes this member from the shared
	// crew — the rest keep the run, and the instance dissolves with its last member.
	_handleQuestAbandon(client, payload) {
		const profile = this.econ.get(client.sessionId);
		if (!profile) return;
		if (!this._actionOk(client.sessionId, 'quest')) return;
		const id = typeof payload?.id === 'string' ? payload.id.slice(0, 64) : '';
		if (!abandonMission(profile.quests, id).ok) return;
		if (isHeist(id)) this._leaveHeistCrew(id, client.sessionId);
		this._persistEcon(client.sessionId);
		this._sendQuests(client);
	}

	// Act at the quest object the player is standing at (courier pickup/dropoff, a
	// heist terminal, the vault door). The zone comes from the SERVER's authoritative
	// position — the client's prompt is a hint, never the authority — and the event
	// carries the zone's action so objectiveMatches can tell a pickup from a dropoff.
	_handleQuestInteract(client) {
		const player = this.state.players.get(client.sessionId);
		const profile = this.econ.get(client.sessionId);
		if (!player || !profile) return;
		if (!this._actionOk(client.sessionId, 'questInteract')) return;
		const zone = interactZoneInRange(player.x, player.z);
		if (!zone) {
			client.send('notice', { kind: 'quest', text: 'There’s nothing to use here.' });
			return;
		}
		this._questEvent(client, profile, { type: 'interact', zone: zone.id, action: zone.action });
	}

	// Feed one real gameplay event (a catch, a zone entry, an interact) into every
	// run it could advance. Called from the move path, so it stays cheap: a player
	// has a handful of active runs at most, and live heist instances are bounded by
	// the mission registry. Solo runs live on the profile; heists advance the crew's
	// shared run — any member's action moves everyone, and the finale gates on
	// assembly (the whole crew at the door, judged from server positions).
	_questEvent(client, profile, event) {
		const dayKey = utcDayKey();
		let changed = false;
		for (const [id, run] of Object.entries(profile.quests.active)) {
			const mission = missionDef(id);
			if (!mission || mission.kind === 'heist') continue; // heists advance via the shared instance below
			const res = applyEvent(run, mission, event);
			if (!res.matched) continue;
			changed = true;
			if (res.missionComplete) this._completeMission(client, profile, mission, dayKey);
		}
		for (const inst of this.heists.values()) {
			if (!inst.members.has(client.sessionId)) continue;
			const mission = missionDef(inst.missionId);
			if (!mission) continue;
			// The finale only lands with the whole crew assembled at its zone — checked
			// BEFORE applying, so a lone cracker gets a hint instead of a silent miss.
			const obj = mission.objectives[inst.run.stage];
			if (obj?.finale && objectiveMatches(obj, event) && !this._heistFinaleReady(client, inst, mission, obj)) continue;
			const res = applyEvent(inst.run, mission, event);
			if (!res.matched) continue;
			if (res.missionComplete) {
				this._completeHeist(client, inst, mission, dayKey);
			} else {
				// Shared progress: the whole crew's trackers move together. The actor's
				// own re-send rides on the tail below.
				this._sendQuestsToCrew(inst, client.sessionId);
				changed = true;
			}
		}
		if (changed) {
			this._persistEcon(client.sessionId);
			this._sendQuests(client);
		}
	}

	// Pay out a finished solo mission: record it in the lifetime + daily log, grant
	// the purse + XP through the standard idioms, toast the client, and echo the
	// milestone to the site ticker. The quests re-send rides on the caller's tail.
	_completeMission(client, profile, mission, dayKey) {
		recordCompletion(profile.quests, mission, dayKey);
		const reward = missionReward(mission);
		if (reward.gold > 0) profile.gold += reward.gold;
		if (reward.xp) this._grantXp(client, profile, reward.xp.skill, reward.xp.amount);
		this._sendInv(client, profile);
		client.send('questComplete', { id: mission.id, title: mission.title, reward, kind: mission.kind, coop: false });
		this._publishMissionComplete(client, mission, reward.gold, false);
	}

	// Pay out a finished heist to the LIVE crew: the pot splits evenly (remainder to
	// the first member — splitPot loses no gold to rounding), each member's own
	// completion log records it, and each gets their share + XP through their own
	// client. The instance is consumed — a crew founds a fresh one to run it again.
	_completeHeist(client, inst, mission, dayKey) {
		const members = [...inst.members];
		const reward = missionReward(mission);
		const shares = splitPot(reward.gold, members.length);
		members.forEach((sid, i) => {
			const memberProfile = this.econ.get(sid);
			if (!memberProfile) return;
			recordCompletion(memberProfile.quests, mission, dayKey);
			if (shares[i] > 0) memberProfile.gold += shares[i];
			const memberClient = this.clients.find((c) => c.sessionId === sid);
			if (memberClient) {
				try {
					if (reward.xp) this._grantXp(memberClient, memberProfile, reward.xp.skill, reward.xp.amount);
					this._sendInv(memberClient, memberProfile);
					memberClient.send('questComplete', {
						id: mission.id, title: mission.title,
						reward: { ...reward, gold: shares[i] },
						kind: mission.kind, coop: true, crew: members.length,
					});
					this._sendQuests(memberClient);
				} catch { /* best-effort */ }
			}
			this._persistEcon(sid);
		});
		// One ticker line for the whole crew (the total pot), not one per member.
		this._publishMissionComplete(client, mission, reward.gold, true);
		this.heists.delete(inst.missionId);
	}

	// The finale gate: a heist only finishes with a big-enough crew ALL standing at
	// the finale zone — server positions, never client claims. A failed gate tells
	// the actor why, so "nothing happened" is never the answer at the vault door.
	_heistFinaleReady(client, inst, mission, obj) {
		const need = Math.max(1, mission.party | 0 || 1);
		if (inst.members.size < need) {
			client.send('notice', { kind: 'quest', text: `This job needs a crew of ${need} — recruit before the finale.` });
			return false;
		}
		for (const sid of inst.members) {
			const p = this.state.players.get(sid);
			const zone = p ? zoneAt(p.x, p.z) : null;
			if (!zone || zone.id !== obj.zone) {
				client.send('notice', { kind: 'quest', text: 'Your whole crew must be at the door for this.' });
				return false;
			}
		}
		return true;
	}

	// Re-send the quest snapshot to every member of a heist crew (optionally skipping
	// one — the actor, whose re-send rides on the caller). Best-effort per client so
	// a mid-send disconnect can't break the loop for the rest of the crew.
	_sendQuestsToCrew(inst, exceptSessionId = null) {
		for (const sid of inst.members) {
			if (sid === exceptSessionId) continue;
			const c = this.clients.find((cc) => cc.sessionId === sid);
			if (!c) continue;
			try { this._sendQuests(c); } catch { /* best-effort */ }
		}
	}

	// Drop one member from one heist crew; dissolves the instance with its last
	// member, otherwise tells the remainder their headcount changed.
	_leaveHeistCrew(missionId, sessionId) {
		const inst = this.heists.get(missionId);
		if (!inst || !inst.members.delete(sessionId)) return;
		if (inst.members.size === 0) {
			this.heists.delete(missionId);
			return;
		}
		this._sendQuestsToCrew(inst);
	}

	// Drop a departing session from EVERY heist crew (onLeave) so no shared run holds
	// a phantom member. Never throws — it runs inside the leave teardown.
	_leaveHeists(sessionId) {
		for (const id of [...this.heists.keys()]) {
			try { this._leaveHeistCrew(id, sessionId); } catch { /* best-effort */ }
		}
	}

	// "Someone pulled off <mission>" on the site-wide ticker (the reader documents
	// mission-complete as { mission, gold, coop, coin }). Throttled per
	// player+mission so a repeatable grind can't spam the global feed.
	_publishMissionComplete(client, mission, gold, coop) {
		const player = this.state.players.get(client.sessionId);
		publishFeedEvent(
			{
				type: 'mission-complete',
				ts: Date.now(),
				actor: player?.name || 'A player',
				mission: mission.title,
				gold,
				coop,
				coin: this.state.coin || '',
			},
			`${player?.account || client.sessionId}:${mission.id}`,
		);
	}

	_handleRename(client, payload) {
		const player = this.state.players.get(client.sessionId);
		if (!player) return;
		const name = clean(payload?.name, 24);
		if (!name) return;
		player.name = name;
	}

	_handleEmote(client, payload) {
		const player = this.state.players.get(client.sessionId);
		if (!player) return;
		const name = clean(payload?.name, 32);
		if (!name) return;
		const now = Date.now();
		const lastEmote = this._emoteCooldowns.get(client.sessionId) || 0;
		if (now - lastEmote < 2000) return;
		this._emoteCooldowns.set(client.sessionId, now);
		player.emote = name;
		player.emoteTs = now;
	}

	_handleReaction(client, payload) {
		const player = this.state.players.get(client.sessionId);
		if (!player) return;
		const ALLOWED = ['🎉', '😂', '🔥', '❤️', '👏', '🤔'];
		const emoji = typeof payload?.emoji === 'string' ? payload.emoji.trim() : '';
		if (!ALLOWED.includes(emoji)) return;
		const now = Date.now();
		const last = this._reactionCooldowns.get(client.sessionId) || 0;
		if (now - last < 500) return;
		this._reactionCooldowns.set(client.sessionId, now);
		this.broadcast('reaction', { id: client.sessionId, emoji });
	}

	_handleChat(client, payload) {
		const player = this.state.players.get(client.sessionId);
		if (!player) return;
		const text = clean(payload?.text, 200);
		if (!text) return;
		// One message per 700ms per client — enough for conversation, not spam.
		const now = Date.now();
		const last = this._chatCooldowns.get(client.sessionId) || 0;
		if (now - last < 700) return;
		this._chatCooldowns.set(client.sessionId, now);
		// Relay to everyone (including the sender, so their own bubble is driven
		// by the same authoritative event the others see).
		this.broadcast('chat', { id: client.sessionId, name: player.name, text, ts: now });
	}

	_handleAvatar(client, payload) {
		// Lets a client swap avatar mid-session (e.g. after picking a new one)
		// without rejoining the room.
		const player = this.state.players.get(client.sessionId);
		if (!player) return;
		const url = cleanAvatarUrl(payload?.avatar);
		if (url) player.avatar = url;
		if (typeof payload?.agent === 'string') player.agent = clean(payload.agent, 64);
	}

	// --- Spatial voice (WebRTC) ---------------------------------------------
	// The room never touches audio: it only flips a per-player "in voice" flag so
	// peers know who to connect to, and relays SDP/ICE between two specific peers.

	_handleVoiceState(client, payload) {
		const player = this.state.players.get(client.sessionId);
		if (!player) return;
		player.voice = !!(payload && payload.on);
	}

	_handleVoiceSignal(client, payload) {
		if (!this.state.players.has(client.sessionId)) return;
		if (!payload || typeof payload !== 'object') return;
		const to = typeof payload.to === 'string' ? payload.to : '';
		if (!to || to === client.sessionId) return;
		const data = payload.data;
		if (!data || typeof data !== 'object') return;
		if (!this._voiceOk(client.sessionId)) return;
		// SDP/ICE are small; reject anything oversized rather than relay it.
		let size = 0;
		try { size = JSON.stringify(data).length; } catch { return; }
		if (size > MAX_VOICE_SIGNAL_BYTES) return;
		const target = this.clients.find((c) => c.sessionId === to);
		if (!target) return;
		target.send('voice-signal', { from: client.sessionId, data });
	}

	_voiceOk(sessionId) {
		const now = Date.now();
		let bucket = this._voiceCounters.get(sessionId);
		if (!bucket || now - bucket.windowStart > 1000) {
			bucket = { windowStart: now, count: 0 };
			this._voiceCounters.set(sessionId, bucket);
		}
		bucket.count++;
		return bucket.count <= VOICE_SIGNALS_PER_SEC_LIMIT;
	}

	// --- Economy & activities ------------------------------------------------

	// Send the owning client its full economy snapshot (purse, vitals, pack,
	// hotbar, per-skill level + bar boundaries). Sent on join and on demand.
	_sendProfile(client) {
		const profile = this.econ.get(client.sessionId);
		if (!profile) return;
		client.send('profile', profileSnapshot(profile));
	}

	// Send just the mutable economy slice after a change the client can't infer
	// (a catch, an eat, a purse change) — lighter than a full profile resend.
	_sendInv(client, profile) {
		client.send('inv', {
			inv: profile.inv.map((s) => ({ item: s.item, qty: s.qty })),
			hotbar: profile.hotbar.map((s) => ({ item: s.item, qty: s.qty })),
			activeSlot: profile.activeSlot,
			gold: profile.gold,
			hp: profile.hp,
			maxHp: profile.maxHp,
			// W07: armor + wanted heat ride along on every inv delta so the combat
			// HUD never has to guess at a value a hit/consume/loot just changed.
			armor: profile.armor,
			maxArmor: profile.maxArmor,
			heat: profile.heat,
		});
	}

	// Grant XP and tell the earner: the gain (for the float), their new cumulative
	// XP + level boundaries (for an exact bar), and a level-up when one is crossed.
	_grantXp(client, profile, skill, amount) {
		const res = grantXp(profile, skill, amount);
		if (!res) return;
		client.send('xpgain', {
			skill: res.skill, amount: res.amount, xp: res.xp,
			level: res.level, levelXp: res.levelXp, nextXp: res.nextXp,
		});
		if (res.leveledUp) {
			client.send('levelup', { skill: res.skill, level: res.level });
			// Broadcast milestone level-ups (every 10th + the level-99 cap) to the
			// site-wide ticker. Early levels come fast and would be noise; milestones
			// are real achievements worth celebrating publicly. Throttled per
			// player+skill so a burst can't spam the global feed.
			if (res.level === 99 || res.level % 10 === 0) {
				const player = this.state.players.get(client.sessionId);
				publishFeedEvent(
					{
						type: 'level-up',
						ts: Date.now(),
						actor: player?.name || 'A player',
						skill: res.skill,
						level: res.level,
						coin: this.state.coin || '',
					},
					`${player?.account || client.sessionId}:${res.skill}`,
				);
			}
		}
	}

	// Cast a line. Validates (rod on the active slot, beside a pond, off cooldown,
	// room in the pack) then rolls a catch against fishing skill + pond quality.
	// Every cast arms the per-cast cooldown so casting has cadence on the real
	// clock; the client renders the line/bobber while the result rides back here.
	_handleFish(client) {
		const player = this.state.players.get(client.sessionId);
		const profile = this.econ.get(client.sessionId);
		if (!player || !profile) return;
		if (!this._actionOk(client.sessionId, 'fish')) return;

		const now = Date.now();
		if (now < profile.cd.fish) return; // still reeling in the previous cast

		const active = profile.hotbar[profile.activeSlot];
		if (!active || active.item !== 'rod') {
			client.send('notice', { kind: 'tool', text: 'Equip a fishing rod to cast.' });
			return;
		}
		const spot = fishingSpotInRange(player.x, player.z);
		if (!spot) {
			client.send('notice', { kind: 'fish', text: 'Move next to the water to cast.' });
			return;
		}
		if (!hasRoomFor(profile, 'fish')) {
			client.send('notice', { kind: 'full', text: 'Your inventory is full.' });
			return;
		}

		profile.cd.fish = now + FISH_COOLDOWN_MS;
		const lvl = profile.levels.fishing || 1;
		const quality = spot.quality || 1;

		if (Math.random() < fishCatchChance(lvl, quality)) {
			const want = 1 + (Math.random() < fishDoubleChance(lvl, quality) ? 1 : 0);
			const leftover = addItem(profile, 'fish', want);
			const caught = want - leftover;
			if (caught <= 0) {
				client.send('notice', { kind: 'full', text: 'Your inventory is full.' });
				return;
			}
			const xp = Math.round((10 + Math.floor(Math.random() * 6) + lvl * 0.3) * quality) * caught;
			this._grantXp(client, profile, 'fishing', xp);
			this._sendInv(client, profile);
			client.send('notice', { kind: 'fish', caught, text: caught > 1 ? `Caught ${caught} ${itemLabel('fish').toLowerCase()}!` : `Caught a ${itemLabel('fish').toLowerCase()}.` });
			// Quest progress: a real catch advances any active "collect fish" objective.
			this._questEvent(client, profile, { type: 'collect', item: 'fish', qty: caught });
		} else {
			this._grantXp(client, profile, 'fishing', 2);
			client.send('notice', { kind: 'fish', caught: 0, text: 'The fish got away.' });
		}
		this._persistEcon(client.sessionId);
	}

	// Dress the player from a pre-join loadout wire (the character-creator / a
	// world hand-off in `cosmetics` join option), merged on top of their persisted
	// loadout and validated per id against what they own — free cosmetics always
	// pass, premium only when unlocked — so a join option can never put an unowned
	// cosmetic on a player. Mutates profile.cosmetics.equipped in place.
	_applyJoinCosmetics(profile, wire) {
		if (!profile.cosmetics) profile.cosmetics = { owned: [], equipped: {} };
		if (typeof wire !== 'string' || !wire) return;
		const owned = ownedCosmeticSet(profile);
		for (const raw of wire.split(',')) {
			const id = raw.trim();
			const c = getCosmetic(id);
			if (c && canWear(id, owned)) profile.cosmetics.equipped[c.slot] = id;
		}
	}

	// Equip/unequip one cosmetic into its slot (R23). The economy validates the id
	// is owned (or free) before it moves — an unowned id is rejected, never worn —
	// then we re-publish the loadout on the schema (peers re-render the fit), echo
	// the owner a fresh profile (inventory reflects the new equipped state), and
	// persist to the account so it survives logout and applies in every world.
	// Unequip is just equipping the slot's `none` default (always free).
	async _handleEquipCosmetic(client, payload) {
		const profile = this.econ.get(client.sessionId);
		if (!profile) return;
		if (!this._actionOk(client.sessionId, 'equip')) return;
		const id = typeof payload?.id === 'string' ? payload.id.slice(0, 64) : '';
		if (!getCosmetic(id)) {
			client.send('notice', { kind: 'cosmetic', text: 'That cosmetic doesn’t exist.' });
			return;
		}
		let equipped = equipCosmetic(profile, id);
		// Owned-miss on a premium item: the player may have JUST bought it over the
		// x402 rail this session, before the profile's unlocked set was refreshed.
		// Re-read the R22 ledger once and retry, so a fresh purchase equips without a
		// rejoin. (Free items never miss; a genuinely-unowned premium id still falls
		// through to the honest rejection below.)
		if (!equipped && getCosmetic(id)?.tier === 'premium') {
			try {
				if (mergeOwnedFromLedger(profile, await readOwnedCosmetics(profile.playerId)) > 0) {
					// The await could have outlived the session — bail if they left.
					if (!this.econ.has(client.sessionId)) return;
					equipped = equipCosmetic(profile, id);
				}
			} catch (err) {
				console.warn('[walk_world] cosmetics ledger recheck failed:', err?.message);
			}
		}
		if (!equipped) {
			client.send('notice', { kind: 'cosmetic', text: 'You don’t own that cosmetic yet.' });
			return;
		}
		const player = this.state.players.get(client.sessionId);
		if (player) player.cosmetics = serializeLoadout(profile.cosmetics.equipped);
		this._sendProfile(client);
		this._persistEcon(client.sessionId);
	}

	// Replace the player's entire equipped loadout in one shot (R03). The wire
	// is re-validated against the catalog and account ownership before applying —
	// any unknown id, any id in the wrong slot, and any unowned premium id are
	// silently dropped to the slot default. This is the full-loadout counterpart to
	// equip-cosmetic (which changes one slot); the schema update and persist follow
	// the same path so peers always re-render the authoritative look.
	_handleSetCosmetics(client, payload) {
		const profile = this.econ.get(client.sessionId);
		if (!profile) return;
		if (!this._actionOk(client.sessionId, 'equip')) return;
		const wire = typeof payload?.cosmetics === 'string' ? payload.cosmetics.slice(0, 256) : '';
		if (!profile.cosmetics) profile.cosmetics = { owned: [], equipped: {} };
		// Reset every slot to its bare default, then merge the requested ids.
		// Ownership is re-checked per id so a tampered wire can never put an
		// unowned cosmetic on a player.
		profile.cosmetics.equipped = { ...DEFAULT_LOADOUT };
		this._applyJoinCosmetics(profile, wire);
		const player = this.state.players.get(client.sessionId);
		if (player) player.cosmetics = serializeLoadout(profile.cosmetics.equipped);
		this._persistEcon(client.sessionId);
	}

	// Select a hotbar slot (what the player is "holding"). -1 clears the hand.
	_handleEquip(client, payload) {
		const profile = this.econ.get(client.sessionId);
		if (!profile) return;
		if (!this._actionOk(client.sessionId, 'equip')) return;
		const i = payload?.slot | 0;
		if (i < -1 || i >= HOTBAR_SIZE) return;
		profile.activeSlot = i;
		this._sendInv(client, profile);
	}

	// Eat an edible from a referenced slot, healing scaled by cooking level.
	_handleConsume(client, payload) {
		const profile = this.econ.get(client.sessionId);
		if (!profile) return;
		if (!this._actionOk(client.sessionId, 'consume')) return;
		const now = Date.now();
		if (now < profile.cd.consume) return;
		const slot = resolveSlot(profile, payload?.slot);
		if (!slot) return;
		const res = consumeSlot(profile, slot);
		if (!res.ok) {
			const text = res.reason === 'full' ? 'You’re already at full health.' : 'That can’t be eaten.';
			client.send('notice', { kind: 'eat', text });
			return;
		}
		profile.cd.consume = now + CONSUME_COOLDOWN_MS;
		this._sendInv(client, profile);
		client.send('notice', { kind: 'eat', text: `+${res.gained} HP.` });
		this._persistEcon(client.sessionId);
	}

	// --- General store & bank/ATM (W04) --------------------------------------
	//
	// Cash economy, entirely off-schema like the rest of the purse/pack: the
	// server prices every trade from shop.js (never a client-supplied number),
	// mutates the profile, and echoes the owner a fresh inv/profile snapshot.

	// The general store's catalog — sell prices + the buy list — so the client
	// renders exactly what the server will charge/pay, no drift possible.
	_sendStore(client) {
		client.send('store', clientStoreCatalog());
	}

	// Buy `item` from the general store for cash. Validates the catalog entry,
	// the purse, and pack room before moving anything — a rejected buy costs
	// nothing and leaves the pack untouched.
	_handleStoreBuy(client, payload) {
		const profile = this.econ.get(client.sessionId);
		if (!profile) return;
		if (!this._actionOk(client.sessionId, 'storeBuy')) return;
		const item = typeof payload?.item === 'string' ? payload.item.slice(0, 32) : '';
		const entry = buyEntry(item);
		if (!entry) {
			client.send('notice', { kind: 'store', text: 'That item isn’t for sale.' });
			return;
		}
		if (profile.gold < entry.price) {
			client.send('notice', { kind: 'store', text: `Not enough cash — ${entry.price} needed.` });
			return;
		}
		if (!hasRoomFor(profile, entry.item)) {
			client.send('notice', { kind: 'full', text: 'Your inventory is full.' });
			return;
		}
		const leftover = addItem(profile, entry.item, entry.qty);
		const bought = entry.qty - leftover;
		if (bought <= 0) {
			client.send('notice', { kind: 'full', text: 'Your inventory is full.' });
			return;
		}
		profile.gold -= entry.price;
		this._sendInv(client, profile);
		client.send('notice', { kind: 'store', text: `Bought ${bought > 1 ? bought + ' ' : ''}${itemLabel(entry.item)} for ${entry.price} cash.` });
		this._persistEcon(client.sessionId);
	}

	// Sell a stack from a referenced pack slot for cash. `qty` sells up to that
	// many (defaults to the whole stack); the price always comes from
	// SELL_PRICES server-side, never a client-supplied amount.
	_handleStoreSell(client, payload) {
		const profile = this.econ.get(client.sessionId);
		if (!profile) return;
		if (!this._actionOk(client.sessionId, 'storeSell')) return;
		const slot = resolveSlot(profile, payload?.slot);
		if (!slot || !slot.item) {
			client.send('notice', { kind: 'store', text: 'Nothing there to sell.' });
			return;
		}
		if (!isSellable(slot.item)) {
			client.send('notice', { kind: 'store', text: `The store won’t buy ${itemLabel(slot.item).toLowerCase()}.` });
			return;
		}
		const want = Number.isFinite(payload?.qty) && payload.qty > 0 ? Math.min(payload.qty | 0, slot.qty) : slot.qty;
		const item = slot.item;
		const removed = removeItem(profile, item, want);
		if (removed <= 0) return;
		const total = sellPrice(item) * removed;
		profile.gold += total;
		this._sendInv(client, profile);
		client.send('notice', { kind: 'store', text: `Sold ${removed} ${itemLabel(item).toLowerCase()} for ${total} cash.` });
		this._persistEcon(client.sessionId);
	}

	// Move cash between the carried purse and the protected bank (the ATM).
	// Positive amounts deposit, negative withdraw; bankTransfer clamps to
	// what's actually available so it can never mint or strand cash. Banked
	// cash is untouched by a death drop (economy.js dropCarried) — the whole
	// risk/reward point of using the bank.
	_handleBank(client, payload) {
		const profile = this.econ.get(client.sessionId);
		if (!profile) return;
		if (!this._actionOk(client.sessionId, 'bank')) return;
		const amount = Number.isFinite(payload?.amount) ? payload.amount | 0 : 0;
		if (!amount) return;
		const moved = bankTransfer(profile, amount);
		if (moved === 0) {
			client.send('notice', { kind: 'bank', text: amount > 0 ? 'No cash on hand to deposit.' : 'Nothing banked to withdraw.' });
			return;
		}
		this._sendProfile(client);
		client.send('notice', {
			kind: 'bank',
			text: moved > 0 ? `Deposited ${moved} cash — protected from drops.` : `Withdrew ${-moved} cash.`,
		});
		this._persistEcon(client.sessionId);
	}

	// --- $THREE boutique (W04) -------------------------------------------------
	//
	// Premium in-game cosmetics (multiplayer/src/cosmetics-catalog.js), priced
	// and unlocked entirely separately from the R21–25 avatar-shop/x402 rail
	// (which sells a different catalog, settled in USDC, for the standalone
	// character creator). This is the purpose-built W04 rail: the buyer's own
	// Solana wallet sends ONE real $THREE transaction (game-token.js), split
	// between the holder-rewards pool and the treasury, and the server re-reads
	// that transaction from RPC before granting anything — never trusting a
	// client "it worked" claim.

	// The boutique catalog (priced in $THREE) + this account's owned ids.
	_sendBoutique(client) {
		const profile = this.econ.get(client.sessionId);
		client.send('boutique', {
			listings: boutiqueListings(),
			owned: [...(profile?.cosmetics?.owned || [])],
			configured: tokenConfigured(),
		});
	}

	// Price + build the unsigned $THREE purchase transaction for one boutique
	// item. `wallet` is whichever Solana wallet the player has connected in the
	// browser — it pays; the unlock always lands on THIS session's profile
	// regardless of who fronts the tokens (the same "anyone can settle a quote"
	// model buildSpinPayment already uses). The price is read from the server
	// catalog only — a client can never move it.
	async _handleBoutiqueQuote(client, payload) {
		const profile = this.econ.get(client.sessionId);
		if (!profile) return;
		if (!this._actionOk(client.sessionId, 'boutiqueQuote')) return;
		const id = typeof payload?.id === 'string' ? payload.id.slice(0, 64) : '';
		const price = boutiquePrice(id);
		if (!price) {
			client.send('notice', { kind: 'boutique', text: 'That item isn’t in the boutique.' });
			return;
		}
		if (ownedCosmeticSet(profile).has(id)) {
			client.send('notice', { kind: 'boutique', text: 'You already own that.' });
			return;
		}
		const wallet = typeof payload?.wallet === 'string' ? payload.wallet.trim() : '';
		if (!isWalletAddress(wallet)) {
			client.send('notice', { kind: 'boutique', text: 'Connect a Solana wallet to buy with $THREE.' });
			return;
		}
		if (!tokenConfigured()) {
			client.send('notice', { kind: 'boutique', text: 'The $THREE boutique is offline right now.' });
			return;
		}
		let built;
		try {
			const amountRaw = BigInt(Math.round(price * 10 ** TOKEN_DECIMALS));
			built = await buildTokenPurchase({
				buyerWallet: wallet,
				amountRaw,
				purpose: 'boutique',
				extra: { cosmeticId: id },
			});
		} catch (err) {
			console.warn('[walk_world] boutique quote failed:', err?.message);
		}
		if (!built) {
			client.send('notice', { kind: 'boutique', text: 'Could not price that purchase — try again in a moment.' });
			return;
		}
		client.send('boutiqueQuote', { id, price, quoteToken: built.quoteToken, txBase64: built.txBase64 });
	}

	// Settle a signed $THREE purchase: re-verify the on-chain transaction against
	// the sealed quote against live RPC (never the client's "it worked"), then
	// grant the cosmetic exactly once per settled nonce.
	async _handleBoutiqueSettle(client, payload) {
		const profile = this.econ.get(client.sessionId);
		if (!profile) return;
		if (!this._actionOk(client.sessionId, 'boutiqueSettle')) return;
		const quoteToken = typeof payload?.quoteToken === 'string' ? payload.quoteToken : '';
		const txSig = typeof payload?.txSig === 'string' ? payload.txSig : '';
		if (!quoteToken || !txSig) return;

		let result;
		try {
			result = await verifyTokenPurchase({ quoteToken, txSig, purpose: 'boutique' });
		} catch (err) {
			console.warn('[walk_world] boutique settle failed:', err?.message);
			client.send('notice', { kind: 'boutique', text: 'Could not verify that payment — try again.' });
			return;
		}
		if (!result?.ok) {
			client.send('notice', { kind: 'boutique', text: `Payment didn’t verify (${result?.reason || 'unknown'}).` });
			return;
		}
		this._pruneBoutiqueNonces();
		if (this._boutiqueNonces.has(result.nonce)) {
			client.send('notice', { kind: 'boutique', text: 'That purchase already settled.' });
			return;
		}
		this._boutiqueNonces.set(result.nonce, Date.now());
		const cosmeticId = result.quote?.cosmeticId;
		if (ownedCosmeticSet(profile).has(cosmeticId)) {
			client.send('notice', { kind: 'boutique', text: 'Payment verified — you already owned this.' });
			return;
		}
		const granted = cosmeticId ? grantCosmetic(profile, cosmeticId) : false;
		if (!granted) {
			client.send('notice', { kind: 'boutique', text: 'Payment verified, but that item couldn’t be unlocked. Contact support.' });
			return;
		}
		this._sendProfile(client);
		client.send('notice', { kind: 'boutique', text: `Unlocked ${getCosmetic(cosmeticId)?.name || 'the item'} — check your wardrobe.` });
		this._persistEcon(client.sessionId);
	}

	// Replay-guard nonces only need to outlive the quote's own TTL (~90s); prune
	// with a generous margin so memory never grows unbounded across a long-lived
	// room while staying well clear of any in-flight settle.
	_pruneBoutiqueNonces() {
		const cutoff = Date.now() - 5 * 60_000;
		for (const [nonce, ts] of this._boutiqueNonces) if (ts < cutoff) this._boutiqueNonces.delete(nonce);
	}

	// Write this session's economy profile through to the account-keyed store,
	// merging onto any existing record so unrelated fields for the same account
	// are preserved. Synchronous + debounced.
	_persistEcon(sessionId) {
		const profile = this.econ.get(sessionId);
		if (!profile || !profile.playerId) return;
		const player = this.state.players.get(sessionId);
		const prev = loadPlayer(profile.playerId) || {};
		savePlayer(profile.playerId, {
			...prev,
			name: player?.name || prev.name,
			gold: profile.gold,
			// Fold the quest log into the persisted profile blob so accepted jobs +
			// daily state survive a disconnect (economy.js round-trips it opaquely).
			profile: { ...serializeProfile(profile), quests: serializeQuestState(profile.quests) },
		});
	}

	// --- Vehicles ------------------------------------------------------------

	// Seed the parked fleet from the shared spawn registry. Colors come from each
	// type's signature color so the world reads consistently across clients.
	_seedVehicles() {
		for (const spawn of VEHICLE_SPAWNS) {
			if (!isVehicleType(spawn.type)) continue;
			const spec = vehicleSpec(spawn.type);
			const v = new Vehicle();
			v.id = spawn.id;
			v.type = spawn.type;
			v.color = Number.isInteger(spawn.color) ? spawn.color : spec.color;
			v.x = spawn.x;
			// Rest the chassis on its suspension, not embedded in the asphalt — see
			// vehicleRestHeight's doc for the geometry this mirrors.
			v.y = vehicleRestHeight(spawn.type);
			v.z = spawn.z;
			// Resting heading → quaternion about the up axis.
			const half = (spawn.yaw || 0) / 2;
			v.qx = 0; v.qy = Math.sin(half); v.qz = 0; v.qw = Math.cos(half);
			v.speed = 0;
			v.driver = '';
			v.health = 100;
			v.tsServer = Date.now();
			this.state.vehicles.set(v.id, v);
		}
	}

	// Take the wheel of a parked vehicle. Gated by: the vehicle exists, it isn't
	// already occupied, and the player is standing within range of it. A player can
	// only drive one vehicle, so any prior one is released first. The grant is the
	// authoritative `driver` field flipping to this session — the client waits for
	// that echo (plus a targeted ack) before it starts simulating.
	_handleVehicleEnter(client, payload) {
		const player = this.state.players.get(client.sessionId);
		if (!player) return;
		if (!this._actionOk(client.sessionId, 'venter')) return;
		const id = typeof payload?.id === 'string' ? payload.id : '';
		const v = this.state.vehicles.get(id);
		if (!v) { client.send('vehicle', { event: 'deny', id, reason: 'gone' }); return; }
		if (v.driver && v.driver !== client.sessionId) {
			client.send('vehicle', { event: 'deny', id, reason: 'occupied' });
			return;
		}
		// Proximity gate — can't claim a car from across the map.
		const dist = Math.hypot(player.x - v.x, player.z - v.z);
		if (dist > VEHICLE_ENTER_RANGE_M) {
			client.send('vehicle', { event: 'deny', id, reason: 'range' });
			return;
		}
		this._releaseVehicleOf(client.sessionId, id); // give up any other car first
		v.driver = client.sessionId;
		v.tsServer = Date.now();
		client.send('vehicle', { event: 'enter', id });
	}

	// Leave the wheel. The client sends its final resting transform; the server
	// parks the car there, clears the driver, and authors the player's drop point
	// beside the door so the next ordinary 'move' is continuous (no teleport
	// rejection). The drop is server-computed and bounds-clamped — a client can't
	// use exit to warp.
	_handleVehicleExit(client, payload) {
		const player = this.state.players.get(client.sessionId);
		if (!player) return;
		if (!this._actionOk(client.sessionId, 'vexit')) return;
		const v = this._vehicleDrivenBy(client.sessionId);
		if (!v) return;
		// Accept the final transform through the same validation as a sync so the car
		// can't be parked somewhere impossible on the way out.
		this._applyVehicleTransform(v, payload, /* park */ true);
		v.driver = '';
		v.speed = 0;
		v.tsServer = Date.now();

		// Drop the avatar just left of the car (chassis-left), clamped to the same
		// square world bound as ordinary movement.
		const yaw = this._vehicleYaw(v);
		const off = (vehicleSpec(v.type).dims.w / 2) + 0.6;
		const dx = Math.max(-WORLD_BOUND_M, Math.min(WORLD_BOUND_M, v.x + Math.cos(yaw) * off));
		const dz = Math.max(-WORLD_BOUND_M, Math.min(WORLD_BOUND_M, v.z - Math.sin(yaw) * off));
		player.x = dx;
		player.z = dz;
		player.y = 0;
		player.motion = 'idle';
		player.tsServer = Date.now();
		client.send('vehicle', { event: 'exit', id: v.id, x: dx, z: dz });
	}

	// Adopt the driver's streamed transform. Server-authoritative validation: only
	// the seated driver may write; reject NaNs; reject a jump larger than the type's
	// top speed allows over the send window (teleport) and an implausible reported
	// speed (speed hack). A rejected position is simply not applied — the car holds
	// its last authoritative transform, which the cheating client then sees snap back.
	_handleVehicleSync(client, payload) {
		if (!this._actionOk(client.sessionId, 'vsync')) return;
		const v = this._vehicleDrivenBy(client.sessionId);
		if (!v) return;
		if (!this._applyVehicleTransform(v, payload, /* park */ false)) return;

		// Carry the driver's avatar with the car so peers render them in the seat and
		// stepping out is continuous. The avatar sits at the seat height above the
		// chassis; ordinary move validation is bypassed here because the vehicle's own
		// speed clamp already policed this displacement.
		const player = this.state.players.get(client.sessionId);
		if (player) {
			player.x = v.x;
			player.z = v.z;
			player.y = Math.max(0, Math.min(3, v.y + vehicleSpec(v.type).seat.y));
			player.motion = 'idle';
			player.tsServer = v.tsServer;
		}
	}

	// Validate + write a transform onto a vehicle. Returns false (and leaves the
	// vehicle untouched) when the update is malformed or fails an anti-cheat clamp.
	_applyVehicleTransform(v, payload, park) {
		if (!payload || typeof payload !== 'object') return false;
		const { x, y, z, qx, qy, qz, qw, speed } = payload;
		const nums = [x, y, z, qx, qy, qz, qw];
		if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return false;

		// Teleport clamp: reject a step larger than top speed could cover this window.
		const dx = x - v.x, dz = z - v.z;
		if (Math.hypot(dx, dz) > vehicleMaxStepM(v.type)) return false;
		// Speed-hack clamp on the reported forward speed.
		const sp = typeof speed === 'number' && Number.isFinite(speed) ? speed : 0;
		if (Math.abs(sp) > vehicleMaxSpeedMps(v.type)) return false;

		// World bounds — the same square district clamp ordinary movement uses, so a
		// car can reach the avenue spawns at x/z=±90 without being pulled toward the
		// centre by a stale circular radius.
		v.x = Math.max(-VEHICLE_WORLD_BOUND_M, Math.min(VEHICLE_WORLD_BOUND_M, x));
		v.z = Math.max(-VEHICLE_WORLD_BOUND_M, Math.min(VEHICLE_WORLD_BOUND_M, z));
		v.y = Math.max(-2, Math.min(8, y));
		// Normalize the quaternion defensively so a denormalized client value can't
		// poison every peer's renderer.
		const ql = Math.hypot(qx, qy, qz, qw) || 1;
		v.qx = qx / ql; v.qy = qy / ql; v.qz = qz / ql; v.qw = qw / ql;
		v.speed = park ? 0 : sp;
		v.tsServer = Date.now();
		return true;
	}

	_vehicleDrivenBy(sessionId) {
		for (const [, v] of this.state.vehicles) {
			if (v.driver === sessionId) return v;
		}
		return null;
	}

	// Release any vehicle driven by this session (except `keepId`, when re-claiming).
	_releaseVehicleOf(sessionId, keepId = null) {
		for (const [, v] of this.state.vehicles) {
			if (v.driver === sessionId && v.id !== keepId) {
				v.driver = '';
				v.speed = 0;
				v.tsServer = Date.now();
			}
		}
	}

	// Heading (radians about the up axis) extracted from a vehicle's quaternion.
	_vehicleYaw(v) {
		return Math.atan2(2 * (v.qw * v.qy + v.qx * v.qz), 1 - 2 * (v.qy * v.qy + v.qx * v.qx));
	}

	// Per-action sliding-window rate limit (messages/sec/client). A flooding client
	// is silently dropped for the offending action; legitimate cadence passes.
	_actionOk(sessionId, action) {
		const limit = ACTION_RATES[action] || 10;
		const now = Date.now();
		let buckets = this._actionCounters.get(sessionId);
		if (!buckets) { buckets = {}; this._actionCounters.set(sessionId, buckets); }
		let b = buckets[action];
		if (!b || now - b.windowStart > 1000) { b = { windowStart: now, count: 0 }; buckets[action] = b; }
		b.count++;
		return b.count <= limit;
	}

	// Validate a {x,y,z} grid cell from a place/remove message. Returns the packed
	// key string when the cell is a legal, in-bounds integer coordinate, else null.
	_cellKey(payload) {
		if (!payload || typeof payload !== 'object') return null;
		const { x, y, z } = payload;
		if (![x, y, z].every((v) => Number.isInteger(v))) return null;
		if (y < 0 || y >= MAX_GRID_Y) return null;
		if (Math.abs(x) > MAX_GRID_XZ || Math.abs(z) > MAX_GRID_XZ) return null;
		// Circular build area, matching the round plaza the client clamps movement to.
		if (Math.hypot(x, z) > MAX_GRID_XZ) return null;
		return `${x},${y},${z}`;
	}

	// Tell one client an edit didn't land, and why, so the build HUD can explain a
	// block that never appeared instead of leaving the player guessing. The client
	// throttles these into a single toast, so a flood reply is harmless.
	_rejectEdit(client, reason) {
		client.send('edit-reject', { reason });
	}

	// Adopt a mid-session play-pass refresh. The client re-mints a pass (re-reading
	// the chain) ahead of the 10-min TTL and pushes it here so this live session's
	// bound expiry tracks the fresh credential — without this, the once-a-minute
	// expiry sweep evicts a still-qualifying player at the original TTL, which is
	// what kicked anyone in a long building session. We re-verify exactly as onAuth
	// does: a valid pass for this gate's mint, at or above the floor, bound to the
	// same wallet. Anything else is silently ignored — the stale expiry stands and
	// the sweep handles it, so a forged refresh can't extend or hijack a session.
	_handlePlayPassRefresh(client, payload) {
		if (!PLAY_GATE_MINT) return;
		const pass = verifyPlayPass(payload?.playPass);
		if (!pass) return;
		if (pass.mint !== PLAY_GATE_MINT) return;
		if (!(typeof pass.balance === 'number' && pass.balance >= PLAY_GATE_MIN)) return;
		// The refreshed pass must belong to the wallet this session authenticated as,
		// so a leaked pass from another holder can't graft onto this connection.
		if (client.userData?.account && pass.wallet !== client.userData.account) return;
		client.userData = { ...(client.userData || {}), playBalance: pass.balance, playExp: pass.exp };
	}

	_handlePlace(client, payload) {
		if (!this.state.players.has(client.sessionId)) return;
		if (!this._editOk(client.sessionId)) { this._rejectEdit(client, 'rate'); return; }
		const key = this._cellKey(payload);
		if (key === null) { this._rejectEdit(client, 'bounds'); return; }
		const t = payload.t;
		if (!Number.isInteger(t) || t < 0 || t >= BLOCK_TYPE_COUNT) { this._rejectEdit(client, 'type'); return; }
		const owner = this._ownerKey(client.sessionId);
		const existing = this.state.blocks.get(key);
		if (existing) {
			// Re-painting an existing cell. It doesn't grow the world, but it DOES
			// rewrite someone's build — only the piece's owner (or the coin creator)
			// may change it, so a passer-by can't recolour another player's work.
			if (existing.t === t) return; // no-op
			if (!this._mayModify(client, key)) { this._rejectEdit(client, 'owned'); return; }
			existing.t = t;
			blockStore.set(this.worldKey, key, t, this.blockOwners.get(key) || owner);
			return;
		}
		// New cell. Enforce, in order: the per-world budget, the protected spawn/totem
		// discs, the per-player ownership cap, and the per-column density cap. Each is
		// surfaced to the builder with its own reason — never a silent drop.
		if (this.state.blocks.size >= MAX_BLOCKS) { this._rejectEdit(client, 'budget'); return; }
		const reason = this._placementBlock(owner, payload.x, payload.z);
		if (reason) { this._rejectEdit(client, reason); return; }
		const b = new Block();
		b.t = t;
		this.state.blocks.set(key, b);
		this._trackPlacement(key, owner);
		blockStore.set(this.worldKey, key, t, owner);
		this._sendBuildPerms(client);
	}

	// Place a composite piece — a handful of cells in one atomic, all-or-nothing
	// stamp. Validated exactly like a single place (in-bounds integer cell, real
	// type) for EVERY cell before anything lands, plus a whole-batch budget check,
	// so a wall never half-appears and the per-world cap can't be straddled. Rate
	// limited on its own bucket; the schema patch broadcasts each new block to all
	// clients just like single edits, so there's no separate sync path.
	_handlePlaceBatch(client, payload) {
		if (!this.state.players.has(client.sessionId)) return;
		if (!this._batchOk(client.sessionId)) { this._rejectEdit(client, 'rate'); return; }
		const cells = payload?.cells;
		if (!Array.isArray(cells) || cells.length === 0 || cells.length > MAX_BATCH_CELLS) {
			this._rejectEdit(client, 'bounds');
			return;
		}
		// First pass: validate every cell and count how many are new, so the budget,
		// per-player cap, per-column density, protected-zone, and ownership checks all
		// cover the WHOLE stamp before anything lands — a single bad cell rejects the
		// lot. Cumulative tallies (ownerAdds, per-column) are tracked across the batch
		// so a single stamp can't straddle a cap the same way a sequence of singles can't.
		const owner = this._ownerKey(client.sessionId);
		const validated = [];
		let fresh = 0;
		let ownerAdds = 0;
		const colAdds = new Map();
		for (const cell of cells) {
			const key = this._cellKey(cell);
			if (key === null) { this._rejectEdit(client, 'bounds'); return; }
			const t = cell.t;
			if (!Number.isInteger(t) || t < 0 || t >= BLOCK_TYPE_COUNT) { this._rejectEdit(client, 'type'); return; }
			const existing = this.state.blocks.get(key);
			if (existing) {
				// Repaint of an occupied cell needs the same ownership gate as a single edit.
				if (existing.t !== t && !this._mayModify(client, key)) { this._rejectEdit(client, 'owned'); return; }
			} else {
				const col = `${cell.x},${cell.z}`;
				const extraCol = colAdds.get(col) || 0;
				const reason = this._placementBlock(owner, cell.x, cell.z, ownerAdds, extraCol);
				if (reason) { this._rejectEdit(client, reason); return; }
				fresh++;
				ownerAdds++;
				colAdds.set(col, extraCol + 1);
			}
			validated.push({ key, t, cell });
		}
		if (this.state.blocks.size + fresh > MAX_BLOCKS) { this._rejectEdit(client, 'budget'); return; }
		// Second pass: apply. All cells are known-valid now, so this can't partially fail.
		for (const { key, t, cell } of validated) {
			const existing = this.state.blocks.get(key);
			if (existing) {
				if (existing.t === t) continue;
				existing.t = t;
				blockStore.set(this.worldKey, key, t, this.blockOwners.get(key) || owner);
			} else {
				const b = new Block();
				b.t = t;
				this.state.blocks.set(key, b);
				this._trackPlacement(key, owner);
				blockStore.set(this.worldKey, key, t, owner);
			}
		}
		this._sendBuildPerms(client);
	}

	_handleRemove(client, payload) {
		if (!this.state.players.has(client.sessionId)) return;
		if (!this._editOk(client.sessionId)) { this._rejectEdit(client, 'rate'); return; }
		const key = this._cellKey(payload);
		if (key === null) { this._rejectEdit(client, 'bounds'); return; }
		if (!this.state.blocks.has(key)) return;
		// Ownership: only the placer may break their piece, except the coin creator,
		// who moderates the whole world. Enforced server-side off the persisted owner,
		// never the client's word.
		if (!this._mayModify(client, key)) { this._rejectEdit(client, 'owned'); return; }
		const owner = this.blockOwners.get(key) || '';
		this.state.blocks.delete(key);
		this._untrackPlacement(key, owner, payload.x, payload.z);
		blockStore.delete(this.worldKey, key);
		this._sendBuildPerms(client);
	}

	// ── Generic world objects (R01 protocol) ────────────────────────────────────
	//
	// The shared `objects` MapSchema carries every non-player, non-voxel world
	// entity: thrown balls, placed build props, pickups, fx. Three client messages
	// drive it; the server is authoritative on ids, ownership, bounds and lifetime.
	//
	//   obj:spawn  { id?, type?, kind?, x, y, z, yaw?, scale?, vx?, vy?, vz? }
	//       Any joined player. x/y/z required + finite. The server assigns ownerId
	//       (the sender's account, else sessionId), accepts a sane unused `id` or
	//       mints one, clamps position to the world bound and scale to [0.1, 10],
	//       and stamps ts. Rejected (obj:reject {reason}) when the room is at
	//       MAX_WORLD_OBJECTS or the player at MAX_OBJECTS_PER_PLAYER. Clients can
	//       never spawn a 'server'-owned object.
	//   obj:update { id, x?, y?, z?, yaw?, scale?, vx?, vy?, vz? }
	//       Owner only. Server-owned objects (ownerId === 'server', e.g. the R05
	//       physics ball) are moved by the server's own simulation, never a client.
	//       Position re-clamped to bounds, scale to range.
	//   obj:remove { id }
	//       Owner, or the coin creator (world moderation). No one else can.
	//
	// Limits: each handler is rate-limited per client (OBJ_OPS_PER_SEC_LIMIT),
	// positions are bounds-clamped, NaN/Infinity payloads are dropped, and totals
	// are capped per room and per player. Lifetime: on owner disconnect their
	// transient objects are reaped (_reapOwnerTransients); durable build props stay
	// and are persisted per coin world (R17). A `kind` in TRANSIENT_OBJECT_KINDS
	// (or a 'server'-owned object) is transient and never written to storage.

	_handleObjSpawn(client, payload) {
		if (!this.state.players.has(client.sessionId)) return;
		if (!this._objOk(client.sessionId)) return;
		if (!payload || typeof payload !== 'object') return;
		// Position is mandatory and must be finite — a NaN slips past clamps.
		if (!Number.isFinite(payload.x) || !Number.isFinite(payload.y) || !Number.isFinite(payload.z)) return;
		if (this.state.objects.size >= MAX_WORLD_OBJECTS) { client.send('obj:reject', { reason: 'world_full' }); return; }

		const owner = this._ownerKey(client.sessionId);
		let owned = 0;
		for (const [, o] of this.state.objects) if (o.ownerId === owner) owned++;
		if (owned >= MAX_OBJECTS_PER_PLAYER) { client.send('obj:reject', { reason: 'player_full' }); return; }

		const obj = new WorldObject();
		// Accept a client-supplied id only if it's a sane, unused token; otherwise the
		// server mints a collision-free one. Either way ids stay server-controlled.
		let id = (typeof payload.id === 'string' && OBJ_ID_RE.test(payload.id)) ? payload.id : '';
		if (!id || this.state.objects.has(id)) id = `o_${client.sessionId.slice(0, 6)}_${++this._objSeq}`;
		obj.id = id;
		obj.type = typeof payload.type === 'string' ? payload.type.slice(0, OBJ_STR_MAX) : '';
		// Ownership is assigned here; a client can never claim the 'server' sentinel.
		obj.ownerId = owner;
		obj.kind = typeof payload.kind === 'string' ? payload.kind.slice(0, OBJ_STR_MAX) : '';
		obj.scale = objClamp(objNum(payload.scale, 1), OBJ_SCALE_MIN, OBJ_SCALE_MAX);
		obj.yaw = objNum(payload.yaw, 0);
		this._clampObjPos(obj, payload);
		// Grief guard (R19): a durable build prop may not bury the spawn or totem, nor
		// pile onto a tile past the density cap so it can't wall an area off. Checked on
		// the clamped position so a client can't dodge it with an out-of-bounds value.
		// Transient kinds (ball, fx) and server objects are exempt — only build props.
		if (this._objectIsPersistent(obj)) {
			const reason = this._propPlacementBlock(obj.x, obj.z);
			if (reason) { client.send('obj:reject', { reason }); return; }
		}
		obj.vx = objNum(payload.vx, 0);
		obj.vy = objNum(payload.vy, 0);
		obj.vz = objNum(payload.vz, 0);
		obj.ts = Date.now();
		this.state.objects.set(obj.id, obj);
		if (this._objectIsPersistent(obj)) this._persistObjects();
	}

	_handleObjUpdate(client, payload) {
		if (!this._objOk(client.sessionId)) return;
		if (!payload || typeof payload.id !== 'string') return;
		const obj = this.state.objects.get(payload.id);
		if (!obj) return;
		// Server-owned objects (the R05 ball) are driven by the server, never a
		// client; and only the owner may move their own object.
		if (obj.ownerId === SERVER_OBJECT_OWNER) return;
		if (obj.ownerId !== this._ownerKey(client.sessionId)) return;
		this._clampObjPos(obj, payload);
		if (Number.isFinite(payload.yaw)) obj.yaw = payload.yaw;
		if (Number.isFinite(payload.scale)) obj.scale = objClamp(payload.scale, OBJ_SCALE_MIN, OBJ_SCALE_MAX);
		obj.vx = objNum(payload.vx, obj.vx);
		obj.vy = objNum(payload.vy, obj.vy);
		obj.vz = objNum(payload.vz, obj.vz);
		obj.ts = Date.now();
		if (this._objectIsPersistent(obj)) this._persistObjects();
	}

	_handleObjRemove(client, payload) {
		if (!this._objOk(client.sessionId)) return;
		if (!payload || typeof payload.id !== 'string') return;
		const obj = this.state.objects.get(payload.id);
		if (!obj) return;
		// The owner may remove their own object; the coin creator may remove any as
		// world moderation. No one else can.
		if (obj.ownerId !== this._ownerKey(client.sessionId) && !this._isCreator(client)) return;
		const wasPersistent = this._objectIsPersistent(obj);
		this.state.objects.delete(payload.id);
		// Persist the removal too, so a deleted prop doesn't resurrect on re-entry.
		if (wasPersistent) this._persistObjects();
	}


	// Per-client token bucket for obj:* ops, mirroring the edit limiter.
	_objOk(sessionId) {
		const now = Date.now();
		let bucket = this._objCounters.get(sessionId);
		if (!bucket || now - bucket.windowStart > 1000) {
			bucket = { windowStart: now, count: 0 };
			this._objCounters.set(sessionId, bucket);
		}
		bucket.count++;
		return bucket.count <= OBJ_OPS_PER_SEC_LIMIT;
	}

	_clampObjPos(obj, payload) {
		obj.x = objClamp(objNum(payload.x, obj.x), -WORLD_BOUND_M, WORLD_BOUND_M);
		obj.y = objClamp(objNum(payload.y, obj.y), OBJ_Y_MIN, OBJ_Y_MAX);
		obj.z = objClamp(objNum(payload.z, obj.z), -WORLD_BOUND_M, WORLD_BOUND_M);
	}

	// A durable build piece (worth persisting, R17) is any object that isn't a
	// server-owned entity and isn't a transient kind (ball, fx, projectile…).
	_objectIsPersistent(obj) {
		return obj.ownerId !== SERVER_OBJECT_OWNER && !TRANSIENT_OBJECT_KINDS.has(obj.kind);
	}

	// Delete a disconnecting owner's transient objects; their persistent build props
	// remain as part of the world (R17).
	_reapOwnerTransients(owner) {
		const doomed = [];
		for (const [id, o] of this.state.objects) {
			if (o.ownerId === owner && !this._objectIsPersistent(o)) doomed.push(id);
		}
		for (const id of doomed) this.state.objects.delete(id);
	}

	// Snapshot the durable build props for storage — transient and server-owned
	// objects are excluded. Coordinates are rounded to keep the doc compact.
	_snapshotObjects() {
		const out = [];
		for (const [id, o] of this.state.objects) {
			if (!this._objectIsPersistent(o)) continue;
			out.push({
				id,
				type: o.type,
				kind: o.kind,
				ownerId: o.ownerId,
				x: round3(o.x), y: round3(o.y), z: round3(o.z),
				yaw: round3(o.yaw),
				scale: round3(o.scale),
			});
			if (out.length >= MAX_WORLD_OBJECTS) break;
		}
		return out;
	}

	// Arm a debounced durable write of this world's build props (R17). The producer
	// runs at flush time so the latest state lands; worldPersistence coalesces a
	// burst of edits into one backend write.
	_persistObjects() {
		worldPersistence.save(this._objKey, () => ({ objects: this._snapshotObjects() }));
	}

	// Rebuild the `objects` map from a persisted doc on room create. Persisted
	// objects are at rest, so velocity restores to zero and ts is re-stamped.
	_restoreObjects(doc) {
		const list = Array.isArray(doc?.objects) ? doc.objects : null;
		if (!list || !list.length) return;
		let n = 0;
		for (const o of list) {
			if (n >= MAX_WORLD_OBJECTS) break;
			if (!o || typeof o.id !== 'string' || !o.id) continue;
			const obj = new WorldObject();
			obj.id = o.id.slice(0, OBJ_STR_MAX);
			obj.type = typeof o.type === 'string' ? o.type.slice(0, OBJ_STR_MAX) : '';
			obj.kind = typeof o.kind === 'string' ? o.kind.slice(0, OBJ_STR_MAX) : '';
			obj.ownerId = typeof o.ownerId === 'string' ? o.ownerId.slice(0, OBJ_STR_MAX) : '';
			obj.x = objNum(o.x, 0);
			obj.y = objClamp(objNum(o.y, 0), OBJ_Y_MIN, OBJ_Y_MAX);
			obj.z = objNum(o.z, 0);
			obj.yaw = objNum(o.yaw, 0);
			obj.scale = objClamp(objNum(o.scale, 1), OBJ_SCALE_MIN, OBJ_SCALE_MAX);
			obj.ts = Date.now();
			this.state.objects.set(obj.id, obj);
			n++;
		}
		if (n) console.log(`[walk_world ${this.roomId} coin=${this.state.coin || 'mainland'}] restored ${n} objects`);
	}

	// Creator-only moderation: clear a disc of blocks around a grid point, or the
	// whole world. Validated server-side — the creator identity comes from the coin's
	// on-chain creator matching this client's verified wallet, never a client claim.
	// Bounded radius keeps even a malformed call from over-reaching; 'all' is the
	// explicit full wipe. Every removed cell streams out via the blocks state, so all
	// clients see the area clear without a bespoke broadcast.
	_handleBuildClear(client, payload) {
		if (!this.state.players.has(client.sessionId)) return;
		if (!this._isCreator(client)) { this._rejectEdit(client, 'notcreator'); return; }
		if (!this._actionOk(client.sessionId, 'clear')) { this._rejectEdit(client, 'rate'); return; }
		if (!payload || typeof payload !== 'object') return;

		const all = payload.all === true;
		let cx = 0, cz = 0, r = 0;
		if (!all) {
			cx = Number(payload.x); cz = Number(payload.z); r = Number(payload.r);
			if (!Number.isFinite(cx) || !Number.isFinite(cz) || !Number.isFinite(r)) return;
			r = Math.max(1, Math.min(CLEAR_AREA_MAX_RADIUS, Math.round(r)));
		}

		let cleared = 0;
		for (const key of [...this.state.blocks.keys()]) {
			const [bx, , bz] = key.split(',').map(Number);
			if (!all && Math.hypot(bx - cx, bz - cz) > r) continue;
			const owner = this.blockOwners.get(key) || '';
			this.state.blocks.delete(key);
			this._untrackPlacement(key, owner, bx, bz);
			blockStore.delete(this.worldKey, key);
			cleared++;
		}
		// Durable props (obj:spawn build pieces) live in the objects map, not the voxel
		// grid, so a sweep that only touched blocks would leave a prop-griefed area
		// untouched. Clear them on the same disc — mapped from grid cells to world metres
		// (the centre/radius arrive in cells) — and never the ball or transient fx.
		let clearedObjs = 0;
		const wx = cx * BLOCK_SIZE_M, wz = cz * BLOCK_SIZE_M, wr = r * BLOCK_SIZE_M;
		for (const [id, o] of [...this.state.objects]) {
			if (!this._objectIsPersistent(o)) continue;
			if (!all && Math.hypot(o.x - wx, o.z - wz) > wr) continue;
			this.state.objects.delete(id);
			clearedObjs++;
		}
		if (clearedObjs) this._persistObjects();
		client.send('build-cleared', { count: cleared, objects: clearedObjs, all });
		this._sendBuildPerms(client); // the creator's own tally may have changed
		if (cleared || clearedObjs) {
			const where = all ? ' (all)' : ` near ${cx},${cz} r=${r}`;
			console.log(`[walk_world ${this.roomId}] creator cleared ${cleared} block(s) + ${clearedObjs} prop(s)${where}`);
		}
	}

	// --- Build-permission bookkeeping ---------------------------------------

	// The stable id a placed block is owned by: the player's persistence id (wallet
	// account when the gate is on, else their guest id), falling back to the session
	// id before the economy profile lands. Stable across reconnects so a returning
	// builder still owns their pieces.
	_ownerKey(sessionId) {
		return this.econ.get(sessionId)?.playerId || sessionId;
	}

	// Whether this client may modify the block at `key` — its owner, or the creator.
	// An ownerless cell (a legacy/pre-ownership restore) is creator-only, so restored
	// builds stay protected from griefing while the creator can still moderate them.
	_mayModify(client, key) {
		if (this._isCreator(client)) return true;
		const owner = this.blockOwners.get(key) || '';
		return owner !== '' && owner === this._ownerKey(client.sessionId);
	}

	// Is this client the coin's on-chain creator? Requires a verified wallet (the
	// account bound in onAuth) matching the creator we resolved on room create.
	_isCreator(client) {
		if (!this.coinCreator) return false;
		const player = this.state.players.get(client.sessionId);
		return !!player && !!player.account && player.account === this.coinCreator;
	}

	// True if (x,z) is inside a protected disc (spawn or totem) — placement there is
	// refused at every height so neither landmark can be buried or fenced in.
	_isProtectedColumn(x, z) {
		for (const p of PROTECTED_POINTS) {
			if (Math.hypot(x - p.x, z - p.z) <= PROTECTED_RADIUS_CELLS) return true;
		}
		return false;
	}

	// Shared anti-grief gate for a NEW cell (the per-world budget is checked by the
	// caller, since it spans a whole batch). `extraOwner` / `extraColumn` are cells
	// already committed earlier in the same batch, so a composite stamp can't straddle
	// a cap. Returns an edit-reject reason, or null when the placement is allowed.
	_placementBlock(owner, x, z, extraOwner = 0, extraColumn = 0) {
		if (this._isProtectedColumn(x, z)) return 'protected';
		if ((this.blockCounts.get(owner) || 0) + extraOwner >= PER_PLAYER_BLOCK_CAP) return 'playercap';
		if ((this.columnCounts.get(`${x},${z}`) || 0) + extraColumn >= COLUMN_CAP) return 'dense';
		return null;
	}

	// Grief guard for the prop/object build channel (obj:spawn), mirroring the voxel
	// guard but in world metres: keep durable props off the spawn/totem discs and cap
	// how many may pile onto one tile so a builder can't bury a landmark or wall a spot
	// off. Returns an obj:reject reason, or null when the placement is allowed.
	_propPlacementBlock(x, z) {
		for (const p of PROTECTED_POINTS_M) {
			if (Math.hypot(x - p.x, z - p.z) <= PROTECTED_RADIUS_M) return 'protected';
		}
		const tx = Math.round(x / PROP_TILE_M);
		const tz = Math.round(z / PROP_TILE_M);
		let here = 0;
		for (const [, o] of this.state.objects) {
			if (!this._objectIsPersistent(o)) continue;
			if (Math.round(o.x / PROP_TILE_M) === tx && Math.round(o.z / PROP_TILE_M) === tz) here++;
		}
		if (here >= PER_TILE_PROP_CAP) return 'dense';
		return null;
	}

	// Record a placement against its owner + column tallies (used by the caps).
	_trackPlacement(key, owner) {
		this.blockOwners.set(key, owner);
		if (owner) this.blockCounts.set(owner, (this.blockCounts.get(owner) || 0) + 1);
		const ck = key.split(',', 3); // "x,y,z" -> column "x,z"
		const col = `${ck[0]},${ck[2]}`;
		this.columnCounts.set(col, (this.columnCounts.get(col) || 0) + 1);
	}

	// Reverse a placement's bookkeeping when a cell is removed.
	_untrackPlacement(key, owner, x, z) {
		this.blockOwners.delete(key);
		if (owner) {
			const n = (this.blockCounts.get(owner) || 0) - 1;
			if (n > 0) this.blockCounts.set(owner, n); else this.blockCounts.delete(owner);
		}
		const col = `${x},${z}`;
		const c = (this.columnCounts.get(col) || 0) - 1;
		if (c > 0) this.columnCounts.set(col, c); else this.columnCounts.delete(col);
	}

	// Tell one client what they're allowed to do and how much of their build budget
	// they've used, so the HUD can surface the per-player cap and reveal the creator
	// moderation control — no silent limits. Sent on join and after their tally moves.
	_sendBuildPerms(client) {
		const owner = this._ownerKey(client.sessionId);
		client.send('build-perms', {
			creator: this._isCreator(client),
			cap: PER_PLAYER_BLOCK_CAP,
			used: this.blockCounts.get(owner) || 0,
			clearMaxRadius: CLEAR_AREA_MAX_RADIUS,
		});
	}

	// Resolve the coin's on-chain creator from the three.ws API (the same pump.fun
	// coin record the lobby reads). Best-effort: a miss leaves the world without a
	// creator and therefore without the clear-area tool. Re-broadcasts permissions to
	// everyone already seated once known, so a creator who joined first still gets
	// their moderation control the moment it resolves.
	async _resolveCoinCreator() {
		const mint = this.state.coin;
		if (!mint) return; // mainland — no coin, no creator
		try {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), 6000);
			let body;
			try {
				const res = await fetch(`${WORLD_API_BASE}/api/pump/coin?mint=${encodeURIComponent(mint)}`, {
					headers: { accept: 'application/json' }, signal: ctrl.signal,
				});
				if (!res.ok) return;
				body = await res.json();
			} finally { clearTimeout(timer); }
			const creator = typeof body?.creator === 'string' ? body.creator.trim() : '';
			if (!MINT_RE.test(creator)) return; // a creator is a base58 wallet, same shape as a mint
			this.coinCreator = creator;
			for (const client of this.clients) this._sendBuildPerms(client);
		} catch (err) {
			console.warn(`[walk_world ${this.roomId}] creator lookup failed:`, err?.message);
		}
	}

	_editOk(sessionId) {
		const now = Date.now();
		let bucket = this._editCounters.get(sessionId);
		if (!bucket || now - bucket.windowStart > 1000) {
			bucket = { windowStart: now, count: 0 };
			this._editCounters.set(sessionId, bucket);
		}
		bucket.count++;
		return bucket.count <= EDITS_PER_SEC_LIMIT;
	}

	// Separate token bucket for composite stamps, so a legitimate wall (a dozen
	// cells at once) isn't starved by the per-cell single-edit limit, while still
	// capping how fast a client can fire whole pieces.
	_batchOk(sessionId) {
		const now = Date.now();
		let bucket = (this._batchCounters ||= new Map()).get(sessionId);
		if (!bucket || now - bucket.windowStart > 1000) {
			bucket = { windowStart: now, count: 0 };
			this._batchCounters.set(sessionId, bucket);
		}
		bucket.count++;
		return bucket.count <= BATCHES_PER_SEC_LIMIT;
	}

	_rateOk(sessionId) {
		const now = Date.now();
		let bucket = this._moveCounters.get(sessionId);
		if (!bucket || now - bucket.windowStart > MOVE_WINDOW_MS) {
			bucket = { windowStart: now, count: 0 };
			this._moveCounters.set(sessionId, bucket);
		}
		bucket.count++;
		return bucket.count <= MOVES_PER_SEC_LIMIT;
	}

	// ── R05: beach ball physics ──────────────────────────────────────────────────

	// Spawn (or reset) the room's single server-owned ball at world centre.
	// Called on room create and on respawn (out-of-bounds or fallen through floor).
	_spawnBall() {
		const existing = this.state.objects.get(BALL_ID);
		if (existing) {
			existing.x = BALL_SPAWN_X; existing.y = BALL_SPAWN_Y; existing.z = BALL_SPAWN_Z;
			existing.vx = 0; existing.vy = 0; existing.vz = 0;
			existing.ts = Date.now();
		} else {
			const ball = new WorldObject();
			ball.id = BALL_ID;
			ball.kind = 'ball';
			ball.type = 'beach';
			ball.ownerId = SERVER_OBJECT_OWNER;
			ball.x = BALL_SPAWN_X; ball.y = BALL_SPAWN_Y; ball.z = BALL_SPAWN_Z;
			ball.vx = 0; ball.vy = 0; ball.vz = 0;
			ball.yaw = 0; ball.scale = 1;
			ball.ts = Date.now();
			this.state.objects.set(BALL_ID, ball);
		}
		this._ballVx = 0; this._ballVy = 0; this._ballVz = 0;
	}

	// Physics tick at 20 Hz. Integrates gravity, rolling friction, ground bounce,
	// and world-edge reflection. Writes position+velocity into the schema so
	// Colyseus broadcasts only the delta. Settled balls skip integration.
	_tickBall() {
		const ball = this.state.objects.get(BALL_ID);
		if (!ball) { this._spawnBall(); return; }

		// Respawn if out of bounds
		const rSq = ball.x * ball.x + ball.z * ball.z;
		if (ball.y < BALL_OOB_Y || rSq > (BALL_WORLD_RADIUS + 6) * (BALL_WORLD_RADIUS + 6)) {
			console.log(`[walk_world ${this.roomId}] ball out of bounds — respawning`);
			this._spawnBall();
			return;
		}

		// Skip integration when settled on the ground
		const speedSq = this._ballVx * this._ballVx + this._ballVy * this._ballVy + this._ballVz * this._ballVz;
		const onGround = ball.y <= BALL_RADIUS + 0.02;
		if (speedSq < BALL_IDLE_SPEED_SQ && onGround) return;

		const dt = BALL_TICK_MS / 1000;

		// Gravity
		this._ballVy -= BALL_GRAVITY * dt;

		// Drag / rolling friction
		if (onGround) {
			const fric = 1 - BALL_ROLLING_FRICTION * dt;
			this._ballVx *= fric;
			this._ballVz *= fric;
		} else {
			const drag = 1 - BALL_AIR_DRAG * dt;
			this._ballVx *= drag;
			this._ballVz *= drag;
		}

		// Integrate position
		ball.x += this._ballVx * dt;
		ball.y += this._ballVy * dt;
		ball.z += this._ballVz * dt;

		// Ground bounce
		if (ball.y < BALL_RADIUS) {
			ball.y = BALL_RADIUS;
			if (this._ballVy < 0) {
				this._ballVy = -this._ballVy * BALL_BOUNCE;
				// Kill micro-bounces so the ball settles cleanly
				if (Math.abs(this._ballVy) < 0.3) this._ballVy = 0;
			}
		}

		// World-edge reflection (radial normal bounce)
		const r = Math.sqrt(rSq);
		if (r > BALL_WORLD_RADIUS) {
			const k = BALL_WORLD_RADIUS / r;
			ball.x *= k; ball.z *= k;
			const nx = ball.x / BALL_WORLD_RADIUS;
			const nz = ball.z / BALL_WORLD_RADIUS;
			const dot = this._ballVx * nx + this._ballVz * nz;
			if (dot > 0) {
				this._ballVx = (this._ballVx - 2 * dot * nx) * BALL_WALL_BOUNCE;
				this._ballVz = (this._ballVz - 2 * dot * nz) * BALL_WALL_BOUNCE;
			}
		}

		// Write velocity into schema so clients can extrapolate between updates
		ball.vx = this._ballVx;
		ball.vy = this._ballVy;
		ball.vz = this._ballVz;
		ball.ts = Date.now();
	}

	// Handle a kick intent from a client. Server validates and caps the impulse,
	// then applies it to the authoritative ball velocity. Never trusts the client's
	// raw values — only direction + a capped magnitude survive.
	_handleBallKick(client, payload) {
		if (!this.state.players.has(client.sessionId)) return;
		if (!this._kickOk(client.sessionId)) return;
		if (!payload || typeof payload !== 'object') return;
		const ball = this.state.objects.get(BALL_ID);
		if (!ball) return;

		let { vx, vy, vz } = payload;
		if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)) return;

		// Cap impulse magnitude
		const mag = Math.hypot(vx, vy, vz);
		if (mag > BALL_MAX_IMPULSE) {
			const k = BALL_MAX_IMPULSE / mag;
			vx *= k; vy *= k; vz *= k;
		} else if (mag < 0.1) {
			return; // reject zero-length impulse
		}

		// Ensure a meaningful upward component so the ball always lifts off the ground
		if (vy < BALL_MIN_UPY) vy = BALL_MIN_UPY;

		this._ballVx += vx;
		this._ballVy += vy;
		this._ballVz += vz;

		// Absolute cap on total velocity post-kick to prevent launch exploits
		const totalMag = Math.hypot(this._ballVx, this._ballVy, this._ballVz);
		if (totalMag > BALL_POST_KICK_CAP) {
			const k = BALL_POST_KICK_CAP / totalMag;
			this._ballVx *= k; this._ballVy *= k; this._ballVz *= k;
		}
	}

	// Per-client sliding-window rate limit for ball:kick messages.
	_kickOk(sessionId) {
		const now = Date.now();
		let bucket = this._kickCounters.get(sessionId);
		if (!bucket || now - bucket.windowStart > 1000) {
			bucket = { windowStart: now, count: 0 };
			this._kickCounters.set(sessionId, bucket);
		}
		bucket.count++;
		return bucket.count <= BALL_KICKS_PER_SEC;
	}
}
