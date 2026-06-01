// Multiplayer client for /play (Coin Communities) — wraps colyseus.js with a small
// event API the game scene subscribes to without knowing anything about
// Colyseus. Mirrors the design of walk-net.js: graceful offline fallback,
// bounded reconnect, and a flat event surface.
//
// Unlike walk (free 3D position at 15Hz), the game is tile-stepped: the client
// sends one 'step' per tile as the avatar paths, plus discrete intents
// (gather, attack, inventory ops, banking). The server is authoritative for
// all of it.

import { Client, getStateCallbacks } from 'colyseus.js';

const REALMS = ['mainland', 'wilderness', 'whisperwood', 'pond', 'mine', 'wilderness_north', 'wilderness_cave', 'wilderness_east', 'arena'];
const DEFAULT_REALM = 'mainland';
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 6;

function defaultServerUrl() {
	// Resolution priority mirrors community-net / walk-net:
	//   1. window.GAME_SERVER_URL  (test override)
	//   2. local dev → ws://<host>:2567, ignoring the production <meta> baked
	//      into the static page (so `npm run dev:walk-all` works out of the box)
	//   3. <meta name="game-server"> then <meta name="walk-server"> (prod host)
	//   4. Same host on :2567
	if (typeof window !== 'undefined' && window.GAME_SERVER_URL) return window.GAME_SERVER_URL;
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
	if (typeof location !== 'undefined') {
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		return `${proto}//${location.hostname}:2567`;
	}
	return 'ws://localhost:2567';
}

// Derive the HTTP(S) origin of the multiplayer host from its ws(s):// URL, so the
// login picker can hit the server's plain-HTTP discovery endpoint (/servers) on
// the same host without a second config value.
export function gameHttpBase(url) {
	const u = (url || defaultServerUrl()).replace(/^ws(s?):\/\//i, 'http$1://');
	return u.replace(/\/+$/, '');
}

// Fetch the live world-instance roster + real population counts (Task 23) for the
// login picker. Returns the array of { id, name, blurb, players, recommended }.
// Throws on a network/HTTP error so the caller can fall back to a no-counts list
// rather than render stale or faked numbers.
export async function fetchServers(url) {
	const res = await fetch(`${gameHttpBase(url)}/servers`, {
		headers: { accept: 'application/json' },
		cache: 'no-store',
	});
	if (!res.ok) throw new Error(`/servers ${res.status}`);
	const data = await res.json();
	return Array.isArray(data?.servers) ? data.servers : [];
}

export class GameNet {
	constructor(opts = {}) {
		this.name = opts.name || 'guest';
		this.avatar = opts.avatar || ''; // loadable GLB/VRM URL or path; '' = default
		this.pid = opts.pid || ''; // stable account id (wallet / persistent guest) — keys persistence
		// One Colyseus room definition per realm (game_mainland, game_wilderness,
		// …). Each realm is its own instance, so players in different realms never
		// see or affect one another. Defaults to Mainland.
		this.realm = REALMS.includes(opts.realm) ? opts.realm : DEFAULT_REALM;
		this.roomName = `game_${this.realm}`;
		// Chosen world instance (Task 23). filterBy(['server']) on the server pins
		// every realm room of this session to the same instance, so the player only
		// ever matches others who picked the same server. '' lets the server resolve
		// its default; the server validates it regardless.
		this.server = typeof opts.server === 'string' ? opts.server : '';
		// Set true when the server disconnects us because the same account signed in
		// elsewhere — suppresses the auto-reconnect that would otherwise fight the
		// new session for the single allowed seat.
		this._takenOver = false;
		this.url = opts.url || defaultServerUrl();
		this.client = null;
		this.room = null;
		this.status = 'idle'; // 'idle'|'connecting'|'online'|'offline'|'failed'
		this.error = null;
		this.sessionId = null;
		this._handlers = {
			status: new Set(),
			realm: new Set(), // (layout)
			items: new Set(), // (registry) — server item catalogue: icons, labels, mount tuning
			commands: new Set(), // ([{name, args, aliases, desc}]) — slash-command manifest for chat autocomplete
			notice: new Set(), // ({kind, text})
			chat: new Set(), // ({id, name, text, ts}) player msg | ({system, kind, text, ts}) system/command reply
			bank: new Set(), // ({slots})
			skills: new Set(), // ({cap, skills, total, average}) — requester's own XP detail
			xpgain: new Set(), // ({skill, amount, xp, level, levelXp, nextXp}) — every XP earn, earner only
			levelup: new Set(), // ({skill, level}) — a skill the local player just raised
			died: new Set(), // ({realm, danger, respawnAt, dropped, byName}) — local death
			cooked: new Set(), // ({cooked, burned, level}) — result of a cook action at the Roast Pit
			playerAdd: new Set(), // (player, id)
			playerChange: new Set(), // (player, id)
			playerRemove: new Set(), // (id)
			nodeAdd: new Set(),
			nodeChange: new Set(),
			nodeRemove: new Set(),
			mobAdd: new Set(),
			mobChange: new Set(),
			mobRemove: new Set(),
			tombAdd: new Set(), // (tombstone, id)
			tombChange: new Set(), // (tombstone, id)
			tombRemove: new Set(), // (id)
			structAdd: new Set(), // (structure, id) — player-built firepit/shack (Task 07)
			structChange: new Set(), // (structure, id)
			structRemove: new Set(), // (id)
			quests: new Set(), // ({tutorial, daily, badges, guide, npc}) — requester's own quest snapshot
			takeover: new Set(), // ({reason}) — this account signed in elsewhere; this session is being closed
			cosmetics: new Set(), // ({rarities, cosmetics}) — static cosmetics catalogue (Task 21)
			shop: new Set(), // ({offers, owned, equipped, gold}) — live cosmetics shop board
			market: new Set(), // ({listings, mine, token, canToken}) — marketplace board (Task 20)
			marketDirty: new Set(), // () — a listing changed; open panels should refetch
			marketQuote: new Set(), // ({id, tx, quote, ...}) — unsigned split tx + signed quote for a token buy
			marketSettled: new Set(), // ({id, goldAmount, txSig}) — token purchase verified + gold delivered
			marketBuyFail: new Set(), // ({id}) — a token quote/settle was rejected; release the spinner
			marketPayout: new Set(), // ({gold, items}) — proceeds delivered for a sale completed while away
			// Wheel of Fortune (Task 19): board/eligibility, a paid-spin tx + quote to
			// sign, the server-rolled outcome to animate toward, and refusals with the
			// fields each designed state needs (level gate, free-spin countdown).
			spinInfo: new Set(), // ({segments, avgLevel, minLevel, eligible, atWheel, nextFreeSpinAt, now, costUsd, symbol, paidAvailable})
			spinPrep: new Set(), // ({tx, quote, tokenAmount, burnAmount, treasuryAmount, priceUsd, ttlMs, ...})
			spinResult: new Set(), // ({mode, index, kind, item, qty, gold, label, awardedGold, awardedQty, overflow, nextFreeSpinAt, txSig?})
			spinDenied: new Set(), // ({mode, reason, avgLevel, minLevel, nextFreeSpinAt, now})
			handoff: new Set(), // ({realm, sessionId}) — switched rooms via a portal; scene resets dynamic views
			social: new Set(), // ({type, ...}) — friends events: live DM, friend request/accept (Task 15)
		};
		// Optional async supplier of a presence ticket (Task 15). When provided,
		// its resolved token is sent on join so the realm room can publish this
		// account's presence to friends. Resolved fresh on every (re)connect so an
		// expired ticket self-heals.
		this.getPresence = typeof opts.getPresence === 'function' ? opts.getPresence : null;
		this._reconnectTimer = null;
		this._reconnectAttempts = 0;
		this._destroyed = false;
		this._transferring = false; // a portal room-handoff is in flight
	}

	on(event, fn) {
		const bucket = this._handlers[event];
		if (!bucket) throw new Error(`GameNet: unknown event "${event}"`);
		bucket.add(fn);
		return () => bucket.delete(fn);
	}

	_emit(event, ...args) {
		for (const fn of this._handlers[event]) {
			try { fn(...args); } catch (e) { console.error(`[game-net] ${event} handler threw:`, e); }
		}
	}

	_setStatus(status, error = null) {
		this.status = status;
		this.error = error;
		this._emit('status', { status, error });
	}

	// (Re)assert this account's presence ticket to the live room. Sent after every
	// bind so a portal handoff — whose seat reservation carries no join options —
	// still publishes presence + keeps live DM delivery flowing in the new realm.
	async _announcePresence() {
		if (!this.getPresence || !this.room) return;
		try {
			const token = await this.getPresence();
			if (token && this.room) this.room.send('presence', token);
		} catch {
			/* presence is best-effort; the friends list falls back to polling */
		}
	}

	async connect() {
		if (this._destroyed) return;
		this._setStatus('connecting');
		try {
			this.client = new Client(this.url);
			const presence = this.getPresence ? await this.getPresence().catch(() => null) : null;
			this.room = await this.client.joinOrCreate(this.roomName, { name: this.name, avatar: this.avatar, pid: this.pid, server: this.server, ...(presence ? { presence } : {}) });
			this.sessionId = this.room.sessionId;
			this._bindRoom();
			this._announcePresence();
			this._reconnectAttempts = 0;
			this._setStatus('online');
		} catch (err) {
			console.warn('[game-net] connect failed:', err?.message ?? err);
			this._setStatus('failed', err?.message ?? String(err));
			this._scheduleReconnect();
		}
	}

	// Attach every message + state-sync handler to the current room. Used by the
	// initial connect AND by a portal handoff, which swaps in a brand-new room
	// object. onLeave is keyed to the specific room instance it was bound to, so a
	// superseded room (the one we just portalled out of) can't flip us offline or
	// trigger a phantom reconnect.
	_bindRoom() {
		const room = this.room;
		room.onMessage('realm', (layout) => this._emit('realm', layout));
		room.onMessage('items', (r) => this._emit('items', r));
		room.onMessage('commands', (c) => this._emit('commands', c));
		room.onMessage('notice', (n) => this._emit('notice', n));
		room.onMessage('chat', (m) => this._emit('chat', m));
		room.onMessage('bank', (b) => this._emit('bank', b));
		room.onMessage('skills', (s) => this._emit('skills', s));
		room.onMessage('xpgain', (g) => this._emit('xpgain', g));
		room.onMessage('levelup', (l) => this._emit('levelup', l));
		room.onMessage('died', (d) => this._emit('died', d));
		room.onMessage('cooked', (c) => this._emit('cooked', c));
		room.onMessage('quests', (q) => this._emit('quests', q));
		room.onMessage('cosmetics', (c) => this._emit('cosmetics', c));
		room.onMessage('shop', (s) => this._emit('shop', s));
		room.onMessage('market', (m) => this._emit('market', m));
		room.onMessage('marketDirty', () => this._emit('marketDirty'));
		room.onMessage('marketQuote', (q) => this._emit('marketQuote', q));
		room.onMessage('marketSettled', (s) => this._emit('marketSettled', s));
		room.onMessage('marketBuyFail', (f) => this._emit('marketBuyFail', f));
		room.onMessage('marketPayout', (p) => this._emit('marketPayout', p));
		room.onMessage('spinInfo', (m) => this._emit('spinInfo', m));
		room.onMessage('spinPrep', (m) => this._emit('spinPrep', m));
		room.onMessage('spinResult', (m) => this._emit('spinResult', m));
		room.onMessage('spinDenied', (m) => this._emit('spinDenied', m));
		// Friends (Task 15): live DM + friend request/accept events pushed by the
		// server's social hub to whichever realm room this account is connected to.
		room.onMessage('social', (m) => this._emit('social', m));
		// Portal traversal: the server reserved us a seat in the destination realm.
		room.onMessage('portal', ({ to, reservation }) => this._handlePortal(to, reservation));
		// Single-active-session (Task 23): the same account just signed in on another
		// tab/server, so the server is closing this seat. Mark it so the imminent
		// onLeave doesn't auto-reconnect into a tug-of-war, and surface it to the UI.
		room.onMessage('takeover', (m) => {
			if (room !== this.room) return;
			this._takenOver = true;
			this._emit('takeover', m || {});
		});

		const $ = getStateCallbacks(room);
		const wire = (mapName, addEv, changeEv, removeEv) => {
			$(room.state)[mapName].onAdd((item, id) => {
				this._emit(addEv, item, id);
				$(item).onChange(() => this._emit(changeEv, item, id));
			});
			$(room.state)[mapName].onRemove((_item, id) => this._emit(removeEv, id));
		};
		wire('players', 'playerAdd', 'playerChange', 'playerRemove');
		wire('nodes', 'nodeAdd', 'nodeChange', 'nodeRemove');
		wire('mobs', 'mobAdd', 'mobChange', 'mobRemove');
		wire('tombstones', 'tombAdd', 'tombChange', 'tombRemove');
		wire('structures', 'structAdd', 'structChange', 'structRemove');

		room.onLeave((code) => {
			if (room !== this.room) return; // superseded by a portal handoff — ignore
			// Taken over by another login (server close code 4001, or the takeover
			// message already flagged it): stay offline with a clear reason and do NOT
			// reconnect — the account's one allowed seat now belongs to the new session.
			if (this._takenOver || code === 4001) {
				this._setStatus('offline', 'Your account signed in on another server or tab.');
				return;
			}
			this._setStatus('offline');
			if (!this._destroyed && code !== 1000) this._scheduleReconnect();
		});
		room.onError((code, message) => console.warn('[game-net] room.onError', code, message));
	}

	// Consume the destination-realm seat reservation the server handed us, swap it
	// in as the live room, then leave the old one. Joining the new room before
	// leaving the old means the old room's onLeave sees `room !== this.room` and
	// stays quiet, so the UI never flickers offline mid-portal. On failure we keep
	// the old room rather than stranding the player.
	//
	// onBeforeHandoff / onAfterHandoff are optional callbacks the scene injects for
	// the portal fade overlay — they are awaited so the blackout is solid before
	// the geometry swap and the fade-in starts only after the scene is rebuilt.
	async _handlePortal(to, reservation) {
		if (this._destroyed || this._transferring || !this.client) return;
		this._transferring = true;
		const old = this.room;
		try {
			// Fade out first, then do the room swap — so the player never sees a
			// half-rebuilt world flash.
			if (this.onBeforeHandoff) await this.onBeforeHandoff();
			const next = await this.client.consumeSeatReservation(reservation);
			this.room = next;
			this.sessionId = next.sessionId;
			this.realm = REALMS.includes(to) ? to : this.realm;
			this.roomName = `game_${this.realm}`;
			try { old?.leave(true); } catch {}
			// Reset dynamic views + adopt the new session id BEFORE binding state
			// callbacks, which immediately replay the destination realm's entities.
			this._emit('handoff', { realm: this.realm, sessionId: this.sessionId });
			this._bindRoom();
			this._announcePresence();
			this._reconnectAttempts = 0;
			this._setStatus('online');
		} catch (err) {
			console.warn('[game-net] portal handoff failed:', err?.message ?? err);
			this.room = old; // never left it — stay put
			if (this.onAfterHandoff) this.onAfterHandoff(); // always lift the fade
		} finally {
			this._transferring = false;
		}
	}

	// Exponential backoff with a hard ceiling. When the server is unreachable
	// (e.g. not deployed), each attempt costs a connection timeout — retrying
	// forever at a fixed interval floods the console. After MAX_RECONNECT_ATTEMPTS
	// we stop and stay 'offline'; the UI offers a manual reconnect via retry().
	_scheduleReconnect() {
		if (this._reconnectTimer || this._destroyed) return;
		if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			this._setStatus('offline', 'game server unreachable');
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

	// ----- intents ---------------------------------------------------------

	step(tx, ty, yaw) { this.room?.send('step', { tx, ty, yaw }); }
	setAvatar(url) { this.avatar = url; this.room?.send('setAvatar', { avatar: url }); }
	chat(text) { this.room?.send('chat', { text }); }
	gather(id) { this.room?.send('gather', { id }); }
	attack(id) { this.room?.send('attack', { id }); }
	fish() { this.room?.send('fish'); }
	tombLoot(id) { this.room?.send('tombLoot', { id }); }
	cook(qty = 1) { this.room?.send('cook', { qty }); }
	consume(ref) { this.room?.send('consume', { slot: ref }); }
	invMove(from, to) { this.room?.send('invMove', { from, to }); }
	equip(slot) { this.room?.send('equip', { slot }); }
	bankOpen() { this.room?.send('bankOpen'); }
	skills() { this.room?.send('skills'); }
	bankDeposit(i, qty) { this.room?.send('bankDeposit', { i, qty }); }
	bankWithdraw(i, qty) { this.room?.send('bankWithdraw', { i, qty }); }
	// Quests: request a fresh snapshot, talk to an NPC, claim a finished daily.
	questOpen() { this.room?.send('questOpen'); }
	npcTalk(id) { this.room?.send('npcTalk', { id }); }
	questTurnIn(id) { this.room?.send('questTurnIn', { id }); }
	// Cosmetics shop (Task 21): fetch the live board, buy a rotating cosmetic,
	// equip an owned one, or revert to the default look.
	shopOpen() { this.room?.send('shopOpen'); }
	buyCosmetic(id) { this.room?.send('buyCosmetic', { id }); }
	equipCosmetic(id) { this.room?.send('equipCosmetic', { id }); }
	unequipCosmetic() { this.room?.send('unequipCosmetic'); }
	// Marketplace (Task 20): fetch the board, list/cancel your own goods, buy a gold
	// listing, and the two-step on-chain flow for token listings (quote → settle).
	marketOpen() { this.room?.send('mktOpen'); }
	marketListGold(item, qty, priceGold) { this.room?.send('mktList', { type: 'gold', item, qty, priceGold }); }
	marketListToken(goldAmount, priceUsd) { this.room?.send('mktList', { type: 'goldForToken', goldAmount, priceUsd }); }
	marketCancel(id) { this.room?.send('mktCancel', { id }); }
	marketBuyGold(id) { this.room?.send('mktBuyGold', { id }); }
	marketTokenQuote(id) { this.room?.send('mktTokenQuote', { id }); }
	marketTokenSettle(quote, txSig) { this.room?.send('mktTokenSettle', { quote, txSig }); }
	// Wheel of Fortune (Task 19): fetch the board/eligibility, take the free spin,
	// and the two-step paid spin (prep builds the tx + quote; settle hands back the
	// broadcast signature for on-chain verification before the prize is rolled).
	spinInfo() { this.room?.send('spinInfo'); }
	spinFree() { this.room?.send('spinFree'); }
	spinPaidPrep() { this.room?.send('spinPaidPrep'); }
	spinPaidSettle(quote, txSig) { this.room?.send('spinPaidSettle', { quote, txSig }); }
	// Mounts (Task 09): ride the active hotbar item if it's a mount, leave the
	// saddle, and a generic slash-command channel (Task 13 chat forwards here).
	use(slot) { this.room?.send('use', slot == null ? {} : { slot }); }
	dismount() { this.room?.send('dismount'); }
	command(text) { this.room?.send('command', { text }); }
	// Building (Task 07): place a structure on an adjacent tile. Pickup/lock/unlock
	// go through the command channel above (/pickup, /lock, /unlock).
	build(kind, tx, ty) { this.room?.send('build', { kind, tx, ty }); }

	get state() { return this.room?.state ?? null; }

	retry() {
		if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
		this._reconnectAttempts = 0;
		// A manual reconnect after a takeover is the player reclaiming the seat on
		// purpose — clear the flag so the connect path runs normally (and itself
		// evicts whatever session currently holds the account).
		this._takenOver = false;
		this.connect();
	}

	destroy() {
		this._destroyed = true;
		if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
		try { this.room?.leave(); } catch {}
		this.room = null;
		this.client = null;
	}
}
