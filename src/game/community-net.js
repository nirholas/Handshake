// CommunityNet — multiplayer client for Coin Communities.
//
// Each coin is its own world: we join the shared `walk_world` room definition
// but pass `token = <mint>` so Colyseus's filterBy matches us only with players
// who entered the same coin's community. The server (WalkRoom) is authoritative
// for position, emotes, avatars, and chat relay.
//
// This is a focused sibling of walk-net.js — it adds coin identity, avatar URL,
// and chat on top of the same room, and leaves the /walk page's client
// untouched.

import { Client, getStateCallbacks } from 'colyseus.js';
import { log } from '../shared/log.js';
import { joinRoomWithTimeout } from '../shared/colyseus-connect.js';

const ROOM_NAME = 'walk_world';
const RECONNECT_BASE_MS = 3000;

// Stable persistence id for the off-schema economy (pack/purse/skills). When the
// player is signed in we key on their wallet; otherwise we mint and persist a guest
// id so progress survives a refresh on the same device. The server prefers the
// wallet it verified itself, so this only takes effect on un-gated/dev deploys.
function persistedPid(account) {
	if (account) return account;
	try {
		let id = localStorage.getItem('cc-pid');
		if (!id) { id = 'guest-' + Math.random().toString(36).slice(2, 12); localStorage.setItem('cc-pid', id); }
		return id;
	} catch { return ''; }
}
const RECONNECT_MAX_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 6;
const SEND_HZ = 15;
const SEND_INTERVAL_MS = 1000 / SEND_HZ;
const POSITION_EPSILON = 0.01;
const YAW_EPSILON = 0.01;

function defaultServerUrl() {
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
	} catch (_) {}
	if (typeof location !== 'undefined') {
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		// Codespaces / Gitpod forward each port as its own subdomain (-3000 → -2567).
		const fwd = host.match(/^(.*)-(\d+)\.(app\.github\.dev|githubpreview\.dev|gitpod\.io)$/);
		if (fwd) return `${proto}//${fwd[1]}-2567.${fwd[3]}`;
		// Same-host:2567 is a dev convenience; the public domain doesn't expose
		// :2567. In production with no meta/env configured, return '' so the
		// caller stays single-player instead of looping on a dead socket.
		let isProd = false;
		try { isProd = import.meta?.env?.PROD === true; } catch (_) {}
		if (!isProd) return `${proto}//${host}:2567`;
		return '';
	}
	return '';
}

export class CommunityNet {
	/**
	 * @param {object} opts
	 * @param {string} [opts.name]   display name
	 * @param {string} [opts.avatar] GLB/VRM URL for this player's avatar
	 * @param {string} [opts.agent]  optional three.ws agent id
	 * @param {object} [opts.coin]   { mint, name, symbol, image } — '' mint = lobby
	 * @param {string} [opts.tier]   '' (open General world) | 'holders' (gated)
	 * @param {string} [opts.holderPass] signed pass required to join a holder world
	 * @param {number} [opts.holderMinUsd] USD floor the holder world gated on (HUD)
	 * @param {string} [opts.playPass] signed wallet+token pass for the platform gate
	 * @param {string} [opts.account]  verified wallet address bound as the account id
	 * @param {string} [opts.url]    server override
	 */
	constructor(opts = {}) {
		this.name = opts.name || 'guest';
		this.avatar = opts.avatar || '';
		this.agent = opts.agent || '';
		this.coin = opts.coin || { mint: '', name: '', symbol: '', image: '' };
		this.tier = opts.tier === 'holders' ? 'holders' : '';
		this.holderPass = opts.holderPass || '';
		this.holderMinUsd = Number(opts.holderMinUsd) || 0;
		// Platform token gate: when the server is gated, every join must carry this
		// signed pass (proving wallet ownership + ≥ the token floor) or onAuth
		// refuses with a play_pass_* error. Sent for all tiers, not just holders.
		this.playPass = opts.playPass || '';
		this.account = opts.account || '';
		// Pre-join cosmetic loadout (W03): the compact wire string the creator built.
		// The server re-validates ownership before applying it, so an unowned premium
		// id here is simply dropped — never trusted.
		this.cosmetics = opts.cosmetics || '';
		// Stable economy persistence key (wallet when signed in, else a guest id).
		this.pid = persistedPid(this.account);
		this.url = opts.url || defaultServerUrl();

		this.client = null;
		this.room = null;
		this.status = 'idle';
		this.error = null;
		this.sessionId = null;
		this.persistent = false; // set true once the server says this world is Redis-backed
		this.worldTime = 0;      // authoritative day fraction [0,1) for the day/night cycle

		this._handlers = {
			status: new Set(),
			ready: new Set(),  // (coinMeta)
			add: new Set(),    // (player, id)
			change: new Set(), // (player, id)
			remove: new Set(), // (id)
			chat: new Set(),   // ({id, name, text, ts})
			interact: new Set(), // ({from, fromName, action, ts}) — a peer interacted with us
			denied: new Set(),  // (reason) — server refused the join (e.g. holder gate); no retry
			voiceSignal: new Set(), // ({from, data}) — relayed WebRTC SDP/ICE from a peer
			ping: new Set(),   // (ms) — smoothed round-trip latency to the server
			blockAdd: new Set(),    // (key, type) — a voxel appeared (placed or restored)
			blockChange: new Set(), // (key, type) — a voxel was repainted
			blockRemove: new Set(), // (key) — a voxel was broken
			editReject: new Set(),  // ({reason}) — the server refused one of our edits
			buildPerms: new Set(),  // ({creator, cap, used, clearMaxRadius}) — build-permission snapshot (R19)
			buildCleared: new Set(), // ({count, all}) — creator clear-area result (R19)
			persistent: new Set(),  // (bool) — whether this world's build is durably saved
			worldtime: new Set(),   // (frac) — authoritative day fraction [0,1) for day/night
			// Off-schema economy (private to this player; delivered as targeted messages).
			profile: new Set(),     // (snapshot) — full purse/pack/skills on join + on demand
			inv: new Set(),         // ({inv, hotbar, activeSlot, gold, hp, maxHp}) — economy delta
			xpgain: new Set(),      // ({skill, amount, xp, level, levelXp, nextXp})
			levelup: new Set(),     // ({skill, level})
			notice: new Set(),      // ({kind, text, ...}) — activity result toast (fish/eat/tool/full/quest)
			// General store, bank/ATM & the $THREE boutique (W04).
			store: new Set(),          // ({sell:[{item,label,price}], buy:[{item,qty,price,label}]})
			boutique: new Set(),       // ({listings, owned, configured}) — premium cosmetics priced in $THREE
			boutiqueQuote: new Set(),  // ({id, price, quoteToken, txBase64}) — unsigned $THREE purchase to sign
			// Wheel of Fortune (W09) — Fortune's Folly, the Mainland casino wheel.
			spinInfo: new Set(),    // ({segments, now, nextFreeSpinAt, avgLevel, minLevel, eligible, atWheel, paidAvailable, symbol, costUsd})
			spinPrep: new Set(),    // ({tx, tokenAmount, symbol, costUsd, quote}) — unsigned paid-spin tx to sign
			spinResult: new Set(),  // ({mode, index, label, got, overflow, nextFreeSpinAt?}) — the server's roll
			spinDenied: new Set(),  // ({reason, ...}) — a spin request refused
			quests: new Set(),      // ({offers, active, day}) — jobs board + active runs (W05)
			questComplete: new Set(), // ({id, title, reward, kind, coop}) — a mission/heist finished
			combat: new Set(),      // ({role:'attacker'|'victim', target:'mob'|'player', kind?, mobHp?, mobMaxHp?, playerHp, playerMaxHp, dealt, dead, attacker?}) — a swing/shot's result
			// W07 combat world entities: roaming PvE mobs + lootable death tombstones.
			// add/change/remove mirror the vehicle callbacks below.
			mobAdd: new Set(),        // (mob, id) — a mob entered our view (spawn/restore)
			mobChange: new Set(),     // (mob, id) — its position/hp/state changed
			mobRemove: new Set(),     // (id) — a mob left the world (respawn cycle)
			tombstoneAdd: new Set(),    // (tombstone, id) — a death dropped a lootable marker
			tombstoneRemove: new Set(), // (id) — looted or expired
			// Vehicles (synced world entities). add/change/remove mirror the player
			// callbacks; `vehicle` carries the server's targeted enter/exit/deny ack.
			vehicleAdd: new Set(),    // (vehicle, id) — a vehicle entered our view (spawn/restore)
			vehicleChange: new Set(), // (vehicle, id) — its transform/driver changed
			vehicleRemove: new Set(), // (id) — a vehicle left the world
			vehicle: new Set(),       // ({event, id, ...}) — enter/exit/deny ack for our request
			// Generic world objects (R01/R02): the shared `objects` channel — balls,
			// build props, pickups. add/change/remove mirror the player callbacks; the
			// live schema object is passed through so the manager reads current fields.
			objectAdd: new Set(),    // (obj, id) — an object appeared (spawned or restored)
			objectChange: new Set(), // (obj, id) — its transform/owner changed
			objectRemove: new Set(), // (id) — an object left the world
			objectReject: new Set(), // ({reason}) — server refused a spawn (world/player full)
			reaction: new Set(),    // ({id, emoji}) — a player sent a floating reaction
			tag: new Set(),         // ({event, itId, leaderboard}) — tag mini-game state (R08)
			floorBeat: new Set(),   // ({clip}) — disco-pad beat tick (R06): pulses the floor + aligns standing dancers
			king: new Set(),        // ({event, phase, endsAt, scores, kingId, winner, zone}) — King of the Totem state (R07)
			social: new Set(),      // ({type, ...}) — friends events: live DM, request/accept (W09)
		};
		// Optional async presence-ticket supplier (W09). When provided, its resolved
		// token rides the join so this coin world publishes the player's account
		// presence to their friends and can deliver DMs here live. Without it the
		// player is connected but invisible to the social graph — the /walk surface
		// has always passed one; /play now does too.
		this.getPresence = typeof opts.getPresence === 'function' ? opts.getPresence : null;
		this.ping = null;        // smoothed RTT in ms, null until the first echo
		this._pingSentAt = 0;    // perf-clock stamp of the last move awaiting an echo
		this._lastSent = null;
		this._lastSentAt = 0;
		this._reconnectTimer = null;
		this._reconnectAttempts = 0;
		this._destroyed = false;
		this._connectGen = 0;
	}

	on(event, fn) {
		const bucket = this._handlers[event];
		if (!bucket) throw new Error(`CommunityNet: unknown event "${event}"`);
		bucket.add(fn);
		return () => bucket.delete(fn);
	}
	_emit(event, ...args) {
		for (const fn of this._handlers[event]) {
			try { fn(...args); } catch (e) { log.error(`[community-net] ${event} handler threw:`, e); }
		}
	}
	_setStatus(status, error = null) {
		this.status = status; this.error = error;
		this._emit('status', { status, error });
	}

	// Detach and close the current room without triggering a reconnect. Every
	// (re)connect replaces this.room; if the previous room were left live its
	// socket would keep firing onMessage('chat') alongside the new one, so a
	// single broadcast got appended once per leftover connection — the duplicate
	// chat bug. State-based events (move/avatar/blocks) hid it by being
	// idempotent; chat appends a row on every delivery, so it showed.
	_closeRoom() {
		const room = this.room;
		if (!room) return;
		this.room = null;
		// Drop onLeave/onError/onMessage first so leaving doesn't schedule a
		// reconnect or surface a spurious error.
		try { room.removeAllListeners(); } catch {}
		try { room.leave(); } catch {}
	}

	async connect() {
		if (this._destroyed) return;
		this._closeRoom();
		// No multiplayer server resolved for this environment (production with no
		// game-server meta/env). Surface a distinct, honest 'unavailable' state —
		// solo play still works — rather than throwing in `new Client('')`,
		// looping on reconnects, or showing a "reconnecting…" pill that can never
		// reconnect. (The exhausted-reconnect path below stays 'offline' because
		// there a real server exists and a manual retry can still succeed.)
		if (!this.url) {
			this._setStatus('unavailable', 'multiplayer unavailable — single-player only');
			return;
		}
		// Bump a generation token so a slower in-flight connect (e.g. a manual
		// retry racing the auto-reconnect timer) can detect it's been superseded
		// after its await resolves and discard the room it joined, rather than
		// orphaning a second live socket — the same duplicate-chat leak.
		const gen = ++this._connectGen;
		this._setStatus('connecting');
		try {
			this.client = new Client(this.url);
			const mint = this.coin.mint || '';
			// Resolve the presence ticket before the join so it can ride the options.
			// Anonymous players resolve to null (nothing to publish) and a failed mint
			// must never block play — hence the catch: the world still joins, the
			// player is simply offline to their friends until the next reconnect.
			const presence = this.getPresence ? await this.getPresence().catch(() => null) : null;
			const options = {
				// filterBy('coin','tier') isolates each coin into its own instance and
				// splits the open General world from the gated Holders world; the
				// coin-less lobby ('') groups all lobby players into one world.
				coin: mint,
				tier: this.tier,
				coinName: this.coin.name || '',
				coinSymbol: this.coin.symbol || '',
				coinImage: this.coin.image || '',
				name: this.name,
				avatar: this.avatar,
				agent: this.agent,
				// Platform gate: harmless when the server isn't gated (ignored), required
				// when it is. The verified wallet rides inside the signed pass; the server
				// binds it as the account id, so we never trust a raw `account` option.
				playPass: this.playPass,
				// Pre-join cosmetic loadout (W03). Server-validated against ownership
				// before it dresses the player, so peers can trust the broadcast look.
				cosmetics: this.cosmetics,
				// Stable persistence key for the off-schema economy (used only when the
				// server hasn't verified a wallet account of its own — i.e. un-gated/dev).
				pid: this.pid,
				// Signed presence ticket (W09). WalkRoom verifies it and registers the
				// account with the social hub under this world's name, so friends see
				// "Online · <coin> Town" and DMs route to this socket. Omitted entirely
				// when anonymous — the server treats its absence as "don't publish".
				...(presence ? { presence } : {}),
			};
			// Holder worlds require a signed pass the server verifies in onAuth; carry
			// it (and the floor it gated on, for the seed room's HUD) only for holders.
			if (this.tier === 'holders') {
				options.holderPass = this.holderPass;
				options.holderMinUsd = this.holderMinUsd;
			}
			// Hard timeout on the join: a hung handshake (Cloud Run cold start, wedged
			// room, proxy holding the upgrade) would otherwise strand us in 'connecting'
			// forever — joinOrCreate has no timeout of its own. On timeout this throws
			// 'connect_timeout', falling through to the catch → reconnect with backoff.
			// No root-schema class passed on purpose: decode from the server's reflected
			// schema (handshake) so the client never desyncs when a deployed server adds an
			// append-only field this bundle predates. See joinRoomWithTimeout for the why.
			const room = await joinRoomWithTimeout(this.client, ROOM_NAME, options);
			if (this._destroyed || gen !== this._connectGen) {
				try { room.leave(); } catch {}
				return;
			}
			this.room = room;
			this.sessionId = this.room.sessionId;

			this.room.onMessage('chat', (msg) => this._emit('chat', msg));
			this.room.onMessage('interact', (msg) => this._emit('interact', msg));
			// Friends (W09): live DM + request/accept events pushed by the social hub
			// to whichever realm room the account is currently registered in.
			this.room.onMessage('social', (msg) => this._emit('social', msg));
			this.room.onMessage('voice-signal', (msg) => this._emit('voiceSignal', msg));
			// The server replies here when it refuses one of our place/break edits
			// (budget full, rate limited, …) so the HUD can explain the no-op.
			this.room.onMessage('edit-reject', (msg) => this._emit('editReject', msg || {}));
			// Build permissions (R19): the per-player cap + usage, and whether we're the
			// coin creator (which unlocks the clear-area moderation tool). Sent on join and
			// whenever our tally moves. build-cleared confirms a creator clear-area sweep.
			this.room.onMessage('build-perms', (msg) => this._emit('buildPerms', msg || {}));
			this.room.onMessage('build-cleared', (msg) => this._emit('buildCleared', msg || {}));
			// Off-schema economy: the server streams this player's own pack/purse/skills
			// here (peers never see it). Drives the HUD, inventory, hotbar and toasts.
			this.room.onMessage('profile', (msg) => this._emit('profile', msg || {}));
			this.room.onMessage('inv', (msg) => this._emit('inv', msg || {}));
			this.room.onMessage('xpgain', (msg) => this._emit('xpgain', msg || {}));
			this.room.onMessage('levelup', (msg) => this._emit('levelup', msg || {}));
			this.room.onMessage('notice', (msg) => this._emit('notice', msg || {}));
			// General store, bank/ATM & the $THREE boutique (W04).
			this.room.onMessage('store', (msg) => this._emit('store', msg || {}));
			this.room.onMessage('boutique', (msg) => this._emit('boutique', msg || {}));
			this.room.onMessage('boutiqueQuote', (msg) => this._emit('boutiqueQuote', msg || {}));
			// Wheel of Fortune (W09).
			this.room.onMessage('spinInfo', (msg) => this._emit('spinInfo', msg || {}));
			this.room.onMessage('spinPrep', (msg) => this._emit('spinPrep', msg || {}));
			this.room.onMessage('spinResult', (msg) => this._emit('spinResult', msg || {}));
			this.room.onMessage('spinDenied', (msg) => this._emit('spinDenied', msg || {}));
			// Quests, jobs & heists (W05): the board + active runs and completion events.
			this.room.onMessage('quests', (msg) => this._emit('quests', msg || {}));
			this.room.onMessage('questComplete', (msg) => this._emit('questComplete', msg || {}));
			this.room.onMessage('combat', (msg) => this._emit('combat', msg || {}));
			// Vehicles: the server's targeted reply to our enter/exit request (grant,
			// drop point, or denial). World transforms arrive via the state callbacks.
			this.room.onMessage('vehicle', (msg) => this._emit('vehicle', msg || {}));
			// Generic world objects (R01): the server replies here when it refuses a
			// spawn (the room is full, or we've hit our per-player object cap) so the
			// build HUD can explain why a placed prop never appeared.
			this.room.onMessage('obj:reject', (msg) => this._emit('objectReject', msg || {}));
			// Broadcast reactions (R04): floating emoji that rise above the sender's avatar.
			this.room.onMessage('reaction', (msg) => this._emit('reaction', msg || {}));
			this.room.onMessage('tag', (msg) => this._emit('tag', msg || {})); // R08 tag mini-game
			// Dance floor (R06): the room broadcasts a beat every 4s so every client
			// pulses the disco pad and crossfades standing dancers to the same clip in
			// lockstep. The server message keeps its colon namespace; we normalize it to
			// a camelCase event like the other namespaced messages above.
			this.room.onMessage('floor:beat', (msg) => this._emit('floorBeat', msg || {}));
			// King of the Totem (R07): the room broadcasts round start/tick/end (and a
			// targeted sync on join) for the hold-the-totem mini-game. Server-authoritative
			// — the client only renders the HUD + zone. Colon-namespaced like floor:beat;
			// normalized to a camelCase `king` event.
			this.room.onMessage('game:king', (msg) => this._emit('king', msg || {}));

			const $ = getStateCallbacks(this.room);
			const $state = $(this.room.state);

			// Guard each collection: if the server is running an older schema that
			// doesn't include a field yet, the proxy returns undefined for that key
			// and calling .onAdd() on undefined throws — breaking the connect loop.
			const $players = $state?.players;
			if ($players) {
				$players.onAdd((player, id) => {
					this._emit('add', player, id);
					$(player).onChange(() => {
						// The server echoes our own authoritative state back after each
						// move; the gap from send → echo is a real network+server RTT.
						if (id === this.sessionId && this._pingSentAt) {
							const rtt = performance.now() - this._pingSentAt;
							this._pingSentAt = 0;
							if (rtt > 0 && rtt < 5000) {
								this.ping = this.ping == null ? rtt : this.ping * 0.7 + rtt * 0.3;
								this._emit('ping', Math.round(this.ping));
							}
						}
						this._emit('change', player, id);
					});
				});
				$players.onRemove((_p, id) => this._emit('remove', id));
			}

			// Voxel builds: the server is authoritative for every block, so the
			// world's geometry is driven entirely by these state callbacks — local
			// place/break clicks only *send*; the block appears when the server
			// echoes it back, keeping every client's build identical. onAdd fires
			// for the full persisted build at join time and for each new placement.
			// blocks field is optional (servers pre-dating voxel builds omit it).
			const $blocks = $state?.blocks;
			if ($blocks) {
				$blocks.onAdd((block, key) => {
					this._emit('blockAdd', key, block.t);
					$(block).onChange(() => this._emit('blockChange', key, block.t));
				});
				$blocks.onRemove((_b, key) => this._emit('blockRemove', key));
			}

			// Vehicles: synced world entities. The full parked fleet arrives via onAdd
			// at join; onChange streams each driver's transform; onRemove drops one.
			// Optional field (servers pre-dating vehicles omit it) — guarded like blocks.
			const $vehicles = $state?.vehicles;
			if ($vehicles) {
				$vehicles.onAdd((vehicle, id) => {
					this._emit('vehicleAdd', vehicle, id);
					$(vehicle).onChange(() => this._emit('vehicleChange', vehicle, id));
				});
				$vehicles.onRemove((_v, id) => this._emit('vehicleRemove', id));
			}

			// Combat world entities (W07): roaming PvE mobs + lootable death tombstones.
			// Both are server-owned synced state (everyone must see them, like
			// vehicles) — mirrors the vehicles wiring above exactly. Optional fields
			// (servers pre-dating combat omit them) — guarded like blocks/vehicles.
			const $mobs = $state?.mobs;
			if ($mobs) {
				$mobs.onAdd((mob, id) => {
					this._emit('mobAdd', mob, id);
					$(mob).onChange(() => this._emit('mobChange', mob, id));
				});
				$mobs.onRemove((_m, id) => this._emit('mobRemove', id));
			}
			const $tombstones = $state?.tombstones;
			if ($tombstones) {
				$tombstones.onAdd((ts, id) => this._emit('tombstoneAdd', ts, id));
				$tombstones.onRemove((_t, id) => this._emit('tombstoneRemove', id));
			}

			// Generic world objects (R01): the server is authoritative for every object,
			// so the scene is driven entirely by these state callbacks — local spawn/
			// move/remove only *send*; the object appears when the server echoes it back.
			// onAdd fires for the full persisted set (durable props, R17) at join and for
			// each new spawn. Optional field (older servers omit it) — guarded like blocks.
			const $objects = $state?.objects;
			if ($objects) {
				$objects.onAdd((obj, id) => {
					this._emit('objectAdd', obj, id);
					$(obj).onChange(() => this._emit('objectChange', obj, id));
				});
				$objects.onRemove((_o, id) => this._emit('objectRemove', id));
			}

			// Durability flag for this world's build (Redis-backed vs memory-only).
			// Set once at room creation; listen so the HUD reflects it as soon as the
			// first state patch lands and if it ever degrades mid-session.
			this.persistent = !!this.room.state.persistent;
			$state?.listen?.('persistent', (v) => { this.persistent = !!v; this._emit('persistent', !!v); });

			// Authoritative time of day for the day/night cycle. The server advances it
			// ~1Hz; the scene reads net.worldTime and interpolates between updates, so a
			// coarse broadcast still renders a smooth sky every client agrees on.
			this.worldTime = Number(this.room.state.worldTime) || 0;
			$state?.listen?.('worldTime', (v) => { this.worldTime = Number(v) || 0; this._emit('worldtime', this.worldTime); });

			this.room.onLeave((code) => {
				this._setStatus('offline');
				// 4002: the server evicted us because our play pass expired without a
				// refresh (the wallet may have dropped below the token floor). Reconnecting
				// would just fail onAuth again — surface it as a terminal denial so the
				// scene routes the player back to the sign-in gate.
				if (code === 4002) { this._setStatus('denied', 'play_pass_required'); this._emit('denied', 'play_pass_required'); return; }
				if (!this._destroyed && code !== 1000) this._scheduleReconnect();
			});
			this.room.onError((code, message) => log.warn('[community-net] room.onError', code, message));

			this._reconnectAttempts = 0;
			this._setStatus('online');
			this._emit('ready', {
				mint: this.room.state.coin,
				name: this.room.state.coinName,
				symbol: this.room.state.coinSymbol,
				image: this.room.state.coinImage,
			});
		} catch (err) {
			const msg = err?.message ?? String(err);
			// A holder-gate refusal (onAuth threw) is terminal, not a flaky link —
			// retrying with the same expired/invalid pass just loops. Surface it so
			// the scene can route the player back to the gate, and stop here.
			if (/holder_pass|play_pass/i.test(msg)) {
				log.warn('[community-net] gate denied join:', msg);
				this._setStatus('denied', msg);
				this._emit('denied', msg);
				return;
			}
			log.warn('[community-net] connect failed:', msg);
			this._setStatus('failed', msg);
			this._scheduleReconnect();
		}
	}

	// Exponential backoff with a hard ceiling. When the game server isn't
	// reachable at all (e.g. not deployed), every attempt costs an 8s+ XHR
	// timeout — retrying forever at a fixed 3s floods the console and the
	// network tab. After MAX_RECONNECT_ATTEMPTS we stop and stay 'offline';
	// the UI can offer manual reconnect via retry().
	_scheduleReconnect() {
		if (this._reconnectTimer || this._destroyed) return;
		if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			this._setStatus('offline', 'multiplayer unreachable — single-player only');
			return;
		}
		const attempt = this._reconnectAttempts++;
		const backoff = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
		const delay = backoff + Math.random() * 1000;
		this._reconnectTimer = setTimeout(() => {
			this._reconnectTimer = null;
			if (!this._destroyed) this.connect();
		}, delay);
	}

	// Send a message only when the wire is actually open. `this.room` alone isn't
	// enough: between the socket entering CLOSING and onLeave firing, the room
	// reference is still live, and ws.send() on that socket logs a console
	// warning per message ("WebSocket is already in CLOSING or CLOSED state").
	// Returns true when the message reached an open socket; dropped messages are
	// fine — every send here is a live-state signal the reconnect resyncs anyway.
	_send(type, payload) {
		const room = this.room;
		if (!room || room.connection?.isOpen !== true) return false;
		try { room.send(type, payload); } catch { return false; }
		return true;
	}

	sendMove(state) {
		if (!this.room) return;
		const now = performance.now();
		if (now - this._lastSentAt < SEND_INTERVAL_MS) return;
		if (this._lastSent) {
			const moved = Math.hypot(state.x - this._lastSent.x, state.y - this._lastSent.y, state.z - this._lastSent.z);
			const turned = Math.abs(state.yaw - this._lastSent.yaw);
			if (moved < POSITION_EPSILON && turned < YAW_EPSILON && state.motion === this._lastSent.motion) return;
		}
		if (!this._send('move', { x: state.x, y: state.y, z: state.z, yaw: state.yaw, motion: state.motion })) return;
		this._lastSent = { ...state };
		this._lastSentAt = now;
		// Stamp this move for RTT measurement unless one is already awaiting its
		// echo, so each sample pairs a single send with its first state echo.
		if (!this._pingSentAt) this._pingSentAt = now;
	}

	sendEmote(name) { this._send('emote', { name }); }
	sendReaction(emoji) { this._send('reaction', { emoji }); }
	sendChat(text) { this._send('chat', { text }); }
	// Place/break a voxel at an integer grid cell. Server-authoritative: these only
	// request the edit; the block is added/removed locally when the server patches
	// state.blocks (see the onAdd/onRemove wiring above).
	sendPlace(x, y, z, t) { this._send('place', { x, y, z, t }); }
	// Place a composite piece in one atomic message: an array of {x,y,z,t} cells the
	// server validates and applies all-or-nothing (see WalkRoom._handlePlaceBatch).
	// Each placed block streams back through the same blockAdd path as single edits.
	sendPlaceBatch(cells) { this._send('place-batch', { cells }); }
	sendRemove(x, y, z) { this._send('remove', { x, y, z }); }
	// Creator-only moderation (R19): clear a disc of blocks around a grid cell, or the
	// whole world. The server validates the creator identity + bounds and streams each
	// removal back through the usual blockRemove path.
	sendClearArea(x, z, r) { this._send('build-clear', { x, z, r }); }
	sendClearAll() { this._send('build-clear', { all: true }); }
	sendInteract(to, action) { this._send('interact', { to, action }); }
	// Spatial voice: relay a WebRTC offer/answer/ICE candidate to one peer, and
	// flag ourselves in/out of voice so peers know whether to connect to us.
	sendVoiceSignal(to, data) { this._send('voice-signal', { to, data }); }
	setVoiceActive(on) { this._send('voice-state', { on: !!on }); }
	rename(name) { this.name = name; this._send('rename', { name }); }
	setAvatar(avatar, agent) { this.avatar = avatar; this._send('avatar', { avatar, agent }); }
	// Equip a cosmetic into its slot (W03). Server-authoritative: it validates
	// ownership, updates the player's schema `cosmetics` field (so peers re-render)
	// and replies with a fresh profile. An unowned id is rejected with a 'notice'.
	equipCosmetic(id) { this._send('equip-cosmetic', { id }); }
	// Broadcast a full loadout wire in one shot — mirrors how the avatar is sent.
	// Server validates every id against the catalog and the account's owned set,
	// drops anything invalid or unowned, and publishes the sanitized wire on the
	// schema so all peers re-render the correct look.
	setCosmetics(wire) { this.cosmetics = typeof wire === 'string' ? wire : ''; this._send('set-cosmetics', { cosmetics: this.cosmetics }); }
	// Activities & economy. Server-authoritative: these only request the action; the
	// result arrives via the profile/inv/xpgain/levelup/notice events above.
	// R05 physics ball: send a kick intent with the impulse the server should apply.
	// The server validates magnitude, direction, and rate before touching the ball.
	sendBallKick(vx, vy, vz) { this._send('ball:kick', { vx, vy, vz }); }
	fish() { this._send('fish'); }
	chop() { this._send('chop'); }
	mine() { this._send('mine'); }
	cook() { this._send('cook'); }
	pickupRod() { this._send('pickupRod'); }
	attack() { this._send('attack'); }
	// Claim a tombstone's cash + items (W07). Server-gated by proximity; the
	// result rides back over the usual profile/inv/notice channels.
	lootTombstone(id) { this._send('loot', { id }); }
	equip(slot) { this._send('equip', { slot }); }
	consume(ref) { this._send('consume', { slot: ref }); }
	requestProfile() { this._send('profileReq'); }
	// General store & bank/ATM (W04). Cash trades and banking settle purely
	// off-schema; the result streams back via the 'store'/'profile'/'inv'/
	// 'notice' events above.
	requestStore() { this._send('storeReq'); }
	storeBuy(item) { this._send('storeBuy', { item }); }
	storeSell(slot, qty) { this._send('storeSell', { slot, qty }); }
	bank(amount) { this._send('bank', { amount }); }
	// The $THREE boutique (W04). requestBoutique() fetches the catalog + owned
	// set; boutiqueQuote() prices one item and returns the unsigned tx to sign
	// (the reply arrives via the 'boutiqueQuote' event); boutiqueSettle() hands
	// back the broadcast signature for the server to verify on-chain before it
	// grants anything.
	requestBoutique() { this._send('boutiqueReq'); }
	boutiqueQuote(id, wallet) { this._send('boutiqueQuote', { id, wallet }); }
	boutiqueSettle(quoteToken, txSig) { this._send('boutiqueSettle', { quoteToken, txSig }); }
	// Wheel of Fortune (W09). spinInfo() asks for the current segments/eligibility/
	// cooldown snapshot; spinFree() attempts the 12h free spin; spinPaidPrep(wallet)
	// prices a $3-in-$THREE paid spin and returns the unsigned tx to sign (the
	// reply arrives via the 'spinPrep' event); spinPaidSettle() hands back the
	// broadcast signature for the server to verify on-chain before it rolls.
	spinInfo() { this._send('spinInfo'); }
	spinFree() { this._send('spinFree'); }
	spinPaidPrep(wallet) { this._send('spinPaidPrep', { wallet }); }
	spinPaidSettle(quote, txSig) { this._send('spinPaidSettle', { quote, txSig }); }
	// Quests, jobs & heists (W05). Server-authoritative: accept/abandon a mission and
	// interact at a quest object; the board + progress arrive via the 'quests' event
	// and completions via 'questComplete'. questInteract acts on the zone the server
	// finds the player standing in (pickup/dropoff/terminal/crack).
	requestQuests() { this._send('questReq'); }
	questAccept(id) { this._send('questAccept', { id }); }
	questAbandon(id) { this._send('questAbandon', { id }); }
	questInteract() { this._send('questInteract'); }
	// Vehicles. enter/exit take + release the wheel (server-gated by proximity +
	// occupancy, answered on the 'vehicle' event); vsync streams the driver's
	// authoritative Rapier transform, which the server validates and relays. vsync
	// is throttled to the move send rate; the driving loop calls it every frame.
	sendVEnter(id) { this._send('venter', { id }); }
	sendVExit(state) { this._send('vexit', state || {}); }
	sendVSync(state) {
		if (!this.room) return;
		const now = performance.now();
		if (now - (this._lastVSyncAt || 0) < SEND_INTERVAL_MS) return;
		this._lastVSyncAt = now;
		this._send('vsync', state);
	}
	// Generic world objects (R01/R02). These only *request* the change; the object
	// appears/moves/disappears when the server echoes its authoritative `objects`
	// state back (see the objectAdd/Change/Remove wiring above). The server assigns
	// ownership, mints/clamps ids, and bounds-clamps the transform — the client
	// never trusts its own optimistic copy. x/y/z must be finite or the server drops
	// the spawn, so we guard here too and skip a malformed send.
	spawnObject(kind, opts = {}) {
		if (!this.room) return;
		const { x, y, z } = opts;
		if (![x, y, z].every(Number.isFinite)) return;
		const msg = { kind: String(kind || ''), x, y, z };
		if (typeof opts.type === 'string') msg.type = opts.type;
		if (typeof opts.id === 'string') msg.id = opts.id;
		if (Number.isFinite(opts.yaw)) msg.yaw = opts.yaw;
		if (Number.isFinite(opts.scale)) msg.scale = opts.scale;
		if (Number.isFinite(opts.vx)) msg.vx = opts.vx;
		if (Number.isFinite(opts.vy)) msg.vy = opts.vy;
		if (Number.isFinite(opts.vz)) msg.vz = opts.vz;
		this._send('obj:spawn', msg);
	}
	updateObject(id, transform = {}) {
		if (!this.room || typeof id !== 'string') return;
		const msg = { id };
		for (const k of ['x', 'y', 'z', 'yaw', 'scale', 'vx', 'vy', 'vz']) {
			if (Number.isFinite(transform[k])) msg[k] = transform[k];
		}
		this._send('obj:update', msg);
	}
	removeObject(id) {
		if (!this.room || typeof id !== 'string') return;
		this._send('obj:remove', { id });
	}
	// Does an object's server-assigned ownerId belong to THIS client? The server keys
	// ownership on the verified account when signed in, else the persisted economy id,
	// else the session id (WalkRoom._ownerKey) — match all three so delete-own works
	// in gated, un-gated, and guest sessions alike.
	ownsObject(obj) {
		const owner = obj?.ownerId;
		if (!owner) return false;
		return owner === this.account || owner === this.pid || owner === this.sessionId;
	}

	// Adopt a refreshed play pass. Store it so the next reconnect (after a drop)
	// uses the fresh credential, AND push it to the live session so the server can
	// extend this connection's bound expiry — otherwise the server's per-minute
	// sweep evicts a still-qualifying player at the original 10-min TTL (which
	// stranded anyone in a long building session). The server re-verifies the pass
	// against the gate before extending; a forged or below-floor pass is ignored.
	updatePlayPass(pass) { this.playPass = pass || ''; if (pass) this._send('play-pass', { playPass: pass }); }

	get state() { return this.room?.state ?? null; }

	retry() {
		if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
		this._reconnectAttempts = 0;
		this.connect();
	}
	destroy() {
		this._destroyed = true;
		if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
		this._closeRoom();
		this.client = null;
	}
}
