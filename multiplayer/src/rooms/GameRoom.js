// GameRoom — authoritative state for a Kintara isometric realm (Mainland).
//
// Same philosophy as WalkRoom: the server owns the truth. Clients send intent
// ('step', 'gather', 'attack', 'invMove', 'equip', 'bankDeposit', ...) and the
// server validates every one (walkability, adjacency, tool/skill gates, rate
// limits) before mutating the shared state. A malicious client can desync its
// own view but can't move through walls, gather depleted nodes, or mint gold.
//
// Movement is tile-stepped: the client paths locally and asks to step one tile
// at a time. The server accepts a step only if the target is in-bounds, within
// one tile (8-way) of the player's current tile, and walkable. That makes
// teleport-cheating impossible without a separate max-step heuristic.

import { Room, matchMaker } from '@colyseus/core';

import { GameState, GamePlayer, ResourceNode, Mob, Slot, Tombstone, Structure } from '../schemas/game.js';
import { REALMS, DEFAULT_REALM, isBlocked, inBounds, realmLayout, fishingSpotNear, portalAt, rollerAt, rollerDelta, inNoPvpZone, wheelLandmark } from './realms.js';
import { signTransfer, verifyTransfer } from './realm-transfer.js';
import { runCommand, commandManifest } from './commands.js';
import { STACKABLE_ITEMS, isEdible, healValue, scaledHeal, isMount, mountStepMs, rollLoot, itemLabel, clientItemRegistry, cookBurnChance, fishCatchChance, fishDoubleChance } from '../items.js';
import { cleanAvatarUrl } from '../avatar-url.js';
import { loadPlayer, savePlayer, hydratePlayer, flushPlayer } from '../playerStore.js';
import { cleanServer } from '../servers.js';
import { PRESENCE_HASH, evictChannel, payoutChannel, TAKEOVER_CLOSE_CODE } from '../presence-keys.js';
import { socialHub } from '../social-hub.js';
import { verifyPresenceTicket } from '../presence-token.js';
import { cosmeticById, isOffered, currentOffers, clientCatalog } from '../cosmetics.js';
import { marketplaceStore } from '../marketplaceStore.js';
import {
	TOKEN_SYMBOL, TOKEN_DECIMALS, tokenConfigured, isWalletAddress,
	quoteTokenForUsd, signQuote, verifyQuote, splitAmount, buildSplitTransaction, verifySplitPayment,
	buildSpinPayment, verifySpinPayment,
} from '../game-token.js';
import {
	rollSpin, spinSegments, reserveSpin, commitSpin, releaseSpin,
	FREE_SPIN_COOLDOWN_MS, SPIN_MIN_AVG_LEVEL, PAID_SPIN_USD,
} from '../spin-wheel.js';
import {
	TUTORIAL_STEPS, TUTORIAL_REWARD, GUIDE_DONE, BADGES, DAILY_POOL,
	dailyDef, nextResetAt, freshQuestState, normalizeQuestState, currentStep,
} from '../quests.js';

// One GameRoom instance == one realm. The realm is selected by the room
// definition (`options.realm`, see index.js); every geometry / spawn / flag
// lookup reads `this.realm`, so the same class serves Mainland, Wilderness,
// Whisperwood, and Pond. A realm's `danger` flag is what gates death-bag drops
// (Task 02): dying in a danger realm spills part of your pack into a tombstone.

const MAX_CLIENTS_PER_ROOM = 50;
const PATCH_RATE_MS = 1000 / 15;
const SIM_TICK_MS = 250; // respawns, healing, death timers

const INV_SIZE = 24;
const HOTBAR_SIZE = 6;
const MAX_STACK = 999;
const BANK_SIZE = 48;

// Marketplace (Task 20). Bounds keep a single listing's numbers sane and stop a
// player from flooding the board. The treasury cut applies ONLY to token sales
// (gold sales are fee-free) — 500 bps = 5%, leaving 95% to the seller's wallet.
const MAX_LISTINGS_PER_SELLER = 20;
const MARKET_GOLD_MAX = 0xffffffff;
const MARKET_USD_MIN = 0.01;
const MARKET_USD_MAX = 100_000;
const MARKET_TREASURY_BPS = 500;

// Which items stack is owned by the item registry (items.js) so cooking, loot,
// banking, and the shop all agree. cookedFish + potions land here automatically.
const STACKABLE = STACKABLE_ITEMS;
const TOOLS = new Set(['axe', 'pickaxe', 'rod', 'hammer', 'sword']);

// The five trainable skills, broadcast as integer levels on GamePlayer. The
// order here is the canonical display order the client renders. LEVEL_CAP is the
// shared ceiling — surfaced to the client so the UI never hard-codes it.
const SKILLS = ['combat', 'woodcutting', 'mining', 'fishing', 'cooking'];
const LEVEL_CAP = 99;

// Per-action rate limits (messages/sec) — generous vs. legit play, tight vs.
// floods. Movement is the hot path so it gets the most headroom. Chat sits low:
// a few lines a second is plenty for conversation and turns a scripted flood into
// dropped messages (with feedback — see _handleChat).
const RATE_LIMITS = { step: 20, gather: 6, attack: 6, fish: 6, cook: 6, consume: 6, ui: 30, chat: 4, mkt: 4, spin: 2 };

// World chat: hard cap on a single message. Longer messages are rejected (not
// silently truncated) so the sender knows their line didn't go through whole.
const MAX_CHAT_LEN = 200;

// Gathering: which tool + skill each node kind needs, and what it yields.
const NODE_RULES = {
	tree: { tool: 'axe', skill: 'woodcutting', item: 'wood', respawnMs: 15000 },
	rock: { tool: 'pickaxe', skill: 'mining', item: 'stone', respawnMs: 18000 },
	coal: { tool: 'pickaxe', skill: 'mining', item: 'coal', respawnMs: 22000 },
};

const GATHER_COOLDOWN_MS = 900; // time between successful harvests
const ATTACK_COOLDOWN_MS = 700;
const COOK_COOLDOWN_MS = 1200; // pace between cook actions
const COOK_BATCH_MAX = 5; // raw fish processed per cook action (one cooldown)
const COOK_XP = 12; // cooking XP per fish successfully cooked (burns yield none)
const CONSUME_COOLDOWN_MS = 1100; // pace between bites — no instant heal-spam
const FISH_COOLDOWN_MS = 1500; // per-cast reel time — sets casting cadence on the real clock
// The catch + double-haul curves live in items.js (fishCatchChance/fishDoubleChance)
// as pure functions, so the odds are unit-tested and shared, not inlined here.
const RESPAWN_PLAYER_MS = 4000;
const RESPAWN_MOB_MS = 8000;

// Movement speed is server-authoritative (Task 09). On foot, a player may take a
// step no more often than every ON_FOOT_STEP_MS; mounts lower this floor via the
// item registry (items.js `mount.stepMs`), so riding is visibly faster without
// ever trusting a client-claimed speed.
const ON_FOOT_STEP_MS = 140;

// Death-bags (danger realms only). A tombstone lives for TOMBSTONE_TTL_MS, then
// crumbles server-side (and the client view follows). For the first
// TTL - GRACE window only the owner may loot it; once inside the final
// TOMBSTONE_GRACE_MS before expiry, anyone standing adjacent may take what's
// left — a fair "claim it fast or share it" rule.
const TOMBSTONE_TTL_MS = 120000; // 2 minutes
const TOMBSTONE_GRACE_MS = 45000; // last 45s: open to anyone adjacent
const FOUNTAIN_HEAL_PER_TICK = 6; // hp restored per sim tick near the fountain
const REGEN_PER_TICK = 1; // passive hp regen out of combat

// Arena rollers (Task 22): how often a moving-floor strip shoves a standing
// player one tile. Slower than the sim tick so the push reads as a deliberate
// nudge to learn, not a blur — ~two pushes a second.
const ROLLER_PUSH_MS = 500;

// Player-built structures (Task 07). `cost` is the EXACT material bill, deducted
// atomically on placement (no partial spend, no negative balance). `lifetimeMs`
// 0 == permanent (the shack, a landmark) — a firepit burns out after its window,
// healing adjacent players like the fountain until it decays. `cap` is how many
// of that kind one player may own at once; the shack's cap of 1 is enforced
// within the realm — and since the shack is Whisperwood-only (realms.js), the
// single Whisperwood room IS the cross-realm scope, so "one per player across
// realms" holds. `heal` is the per-tick HP a firepit restores to anyone beside it.
const STRUCTURE_DEFS = {
	firepit: { cost: { stone: 20, coal: 20, wood: 50 }, lifetimeMs: 30000, cap: Infinity, heal: FOUNTAIN_HEAL_PER_TICK },
	shack: { cost: { wood: 500, stone: 200 }, lifetimeMs: 0, cap: 1, heal: 0 },
};

// XP curve: cumulative XP required for a level. Early levels fly by, later
// ones grind — matches the guide ("early levels come quickly").
function levelForXp(xp) {
	// level n requires 50 * n^1.8 cumulative XP. Cap at 99.
	let lvl = 1;
	while (lvl < LEVEL_CAP && xp >= Math.floor(50 * Math.pow(lvl, 1.8))) lvl++;
	return lvl;
}

// Inverse of levelForXp: the cumulative XP required to *be* at a given level.
// Level 1 starts at 0; reaching level L needs 50 * (L-1)^1.8 cumulative XP — the
// same threshold levelForXp compares against. Used to send the client the
// boundaries of its current level so it can draw an exact progress bar without
// re-deriving the curve (one source of truth for the formula).
function xpForLevel(level) {
	const lvl = Math.max(1, Math.min(LEVEL_CAP, level | 0));
	return lvl <= 1 ? 0 : Math.floor(50 * Math.pow(lvl - 1, 1.8));
}

function clean(str, maxLen) {
	if (typeof str !== 'string') return '';
	// Strip control chars (incl. NUL/escape), collapse whitespace, trim, cap.
	return str.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function pickPlayerColor(sessionId) {
	let h = 0;
	for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) >>> 0;
	return hslToHex((h % 360) / 360, 0.65, 0.6);
}
function hslToHex(h, s, l) {
	const k = (n) => (n + h * 12) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n) => Math.round((l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))) * 255);
	return (f(0) << 16) | (f(8) << 8) | f(4);
}

export class GameRoom extends Room {
	constructor() {
		super();
		this.maxClients = MAX_CLIENTS_PER_ROOM;
		// Off-schema, server-only per-player data: XP totals, private bank, and
		// per-action cooldown/rate windows. None of this needs to sync to peers.
		this.priv = new Map(); // sessionId -> { xp, bank: Slot[], cooldowns, rate }
		// Per-session subscription to the account's eviction channel (Task 23
		// single-active-session). sessionId -> { channel, handler }.
		this._evictSubs = new Map();
		// Per-session subscription to the account's marketplace payout channel (Task
		// 20), so a sale settled elsewhere can deliver gold proceeds to this seat.
		// sessionId -> { channel, handler }.
		this._payoutSubs = new Map();
		// Sim-tick counter that paces periodic profile autosaves.
		this._saveTick = 0;
	}

	async onCreate(options) {
		// The room definition pins which realm this instance hosts. An unknown or
		// missing name falls back to the default realm so the room never boots into
		// an undefined map.
		const name = REALMS[options?.realm] ? options.realm : DEFAULT_REALM;
		this.realm = REALMS[name];
		// Which world instance this room belongs to (Task 23). filterBy(['server'])
		// in index.js guarantees every client matched here passed the same server
		// option, but we still resolve it defensively so a forged/missing value can
		// never create a room for a non-existent instance.
		this.server = cleanServer(options?.server);
		// Monotonic id sources for tombstones and player-built structures (Task 07)
		// spawned by this room.
		this._tombSeq = 0;
		this._structSeq = 0;

		this.setState(new GameState());
		this.state.realm = this.realm.name;
		this.state.server = this.server;
		// Publish (realm, server) onto the room listing so the /servers endpoint can
		// sum live population per instance through the matchmaker — across every
		// horizontally-scaled process, not just this one.
		await this.setMetadata({ realm: this.realm.name, server: this.server });
		this.setPatchRate(PATCH_RATE_MS);
		this.autoDispose = true;

		this._seedWorld();

		this.onMessage('step', (c, p) => this._handleStep(c, p));
		this.onMessage('gather', (c, p) => this._handleGather(c, p));
		this.onMessage('attack', (c, p) => this._handleAttack(c, p));
		this.onMessage('fish', (c, p) => this._handleFish(c, p));
		this.onMessage('cook', (c, p) => this._handleCook(c, p));
		this.onMessage('consume', (c, p) => this._handleConsume(c, p));
		this.onMessage('invMove', (c, p) => this._handleInvMove(c, p));
		this.onMessage('equip', (c, p) => this._handleEquip(c, p));
		this.onMessage('bankDeposit', (c, p) => this._handleBank(c, p, 'deposit'));
		this.onMessage('bankWithdraw', (c, p) => this._handleBank(c, p, 'withdraw'));
		this.onMessage('bankOpen', (c) => this._sendBank(c));
		this.onMessage('skills', (c) => this._sendSkills(c));
		this.onMessage('tombLoot', (c, p) => this._handleTombLoot(c, p));
		this.onMessage('setAvatar', (c, p) => this._handleAvatar(c, p));
		// Friends presence (Task 15): the client (re)asserts its presence ticket on
		// this channel — used after a portal handoff, where the new room's seat
		// reservation carries no join options, so the ticket can't ride onJoin.
		// Idempotent with the onJoin registration; the verified account id is the
		// trust anchor, never a raw client field.
		this.onMessage('presence', (c, ticket) => {
			const uid = verifyPresenceTicket(ticket);
			if (!uid) return;
			c.userData = { ...(c.userData || {}), accountUid: uid };
			socialHub.register(uid, c, this.realm.name);
		});
		// Cosmetics shop (Task 21): request the live shop board, buy a cosmetic from
		// the current rotation, and equip/unequip an owned (purchased) cosmetic. All
		// gold + ownership + rotation checks are server-authoritative below.
		this.onMessage('shopOpen', (c) => this._sendShop(c));
		this.onMessage('buyCosmetic', (c, p) => this._handleBuyCosmetic(c, p));
		this.onMessage('equipCosmetic', (c, p) => this._handleEquipCosmetic(c, p));
		this.onMessage('unequipCosmetic', (c) => this._handleUnequipCosmetic(c));
		// Mounts (Task 09): use the active hotbar item (ride a mount), leave the saddle,
		// and a generic slash-command channel (Task 13's chat forwards /dismount here).
		this.onMessage('use', (c, p) => this._handleUse(c, p));
		this.onMessage('dismount', (c) => this._handleDismount(c));
		// Building (Task 07): place a firepit/shack on an adjacent tile, paying its
		// exact material cost. Pickup/lock/unlock are slash-commands routed through
		// the command channel below (their actions live on this room).
		this.onMessage('build', (c, p) => this._handleBuild(c, p));
		// Player-to-player marketplace (Task 20): browse active listings, list your
		// own goods (item-for-gold or gold-for-token), cancel a listing (returns the
		// escrow), buy a gold listing with in-game gold, and the two-step on-chain
		// flow for token listings (quote → settle). Escrow, gold transfers, and the
		// 95/5 token split are all server-authoritative below. Distinct from the
		// platform AGENT marketplace under api/marketplace*.
		this.onMessage('mktOpen', (c) => this._sendMarket(c));
		this.onMessage('mktList', (c, p) => this._handleMarketList(c, p));
		this.onMessage('mktCancel', (c, p) => this._handleMarketCancel(c, p));
		this.onMessage('mktBuyGold', (c, p) => this._handleMarketBuyGold(c, p));
		this.onMessage('mktTokenQuote', (c, p) => this._handleMarketTokenQuote(c, p));
		this.onMessage('mktTokenSettle', (c, p) => this._handleMarketTokenSettle(c, p));

		// Wheel of Fortune (Task 19): info/eligibility + free spin (12h cooldown),
		// and the two-step paid spin ($3 in $THREE, 50% burned / 50% to treasury)
		// that settles on-chain before the prize is rolled. The roll is always
		// server-authoritative — the client only animates to the chosen segment.
		this.onMessage('spinInfo', (c) => this._sendSpinInfo(c));
		this.onMessage('spinFree', (c) => this._handleSpinFree(c));
		this.onMessage('spinPaidPrep', (c, p) => this._handleSpinPaidPrep(c, p));
		this.onMessage('spinPaidSettle', (c, p) => this._handleSpinPaidSettle(c, p));
		this.onMessage('command', (c, p) => this._handleCommand(c, p));
		// Quests (tutorial + dailies). The client only ever requests a snapshot,
		// talks to the guide, or asks to turn a finished quest in — all progress is
		// driven from the real action hooks below, never from a client claim.
		this.onMessage('questOpen', (c) => this._sendQuests(c));
		this.onMessage('npcTalk', (c, p) => this._handleNpcTalk(c, p));
		this.onMessage('questTurnIn', (c, p) => this._handleTurnIn(c, p));
		this.onMessage('chat', (c, p) => this._handleChat(c, p));

		this.setSimulationInterval(() => this._tick(), SIM_TICK_MS);
	}

	_seedWorld() {
		for (const n of this.realm.nodes) {
			const node = new ResourceNode();
			node.id = n.id;
			node.kind = n.kind;
			node.tx = n.tx;
			node.ty = n.ty;
			this.state.nodes.set(n.id, node);
		}
		for (const m of this.realm.mobs) {
			const mob = new Mob();
			mob.id = m.id;
			mob.kind = m.kind;
			mob.tx = m.tx;
			mob.ty = m.ty;
			mob.hp = mob.maxHp = m.hp;
			this.state.mobs.set(m.id, mob);
		}
	}

	async onJoin(client, options) {
		const name = clean(options?.name, 24) || `guest-${client.sessionId.slice(0, 4)}`;
		// Stable account key: the wallet address / persistent guest id the client
		// sends (Task 16), falling back to the ephemeral session id when absent.
		// Tutorial completion, daily assignment, progress, and badges are keyed to
		// it so they survive a disconnect/reconnect.
		const playerId = clean(options?.pid, 80) || client.sessionId;
		const now = Date.now();
		// Single active session per account (Task 16 integrity rule, enforced across
		// world instances for Task 23): announce this login on the account's eviction
		// channel BEFORE loading the profile. Any live session of the same account —
		// in any realm, on any server, in any process — persists itself and
		// disconnects in response, so two windows can never both mutate and clobber
		// the one shared profile. In single-instance mode the stale session persists
		// synchronously here, so the load below already sees its latest state.
		this.presence.publish(evictChannel(playerId), { exceptSession: client.sessionId, ts: now });
		// Pull the durable profile into the in-process cache before the synchronous
		// load below (Task 16). A cache hit (a session already live in this process,
		// or a record left warm from a recent visit) returns instantly; a miss — the
		// first join after a restart/redeploy, or a player whose last session was on
		// another instance (Task 23) — fetches it from Redis. Without this, a returning
		// player on a fresh process would look brand-new and be reset to the starter kit.
		await hydratePlayer(playerId);
		const saved = loadPlayer(playerId);
		const quests = normalizeQuestState(saved?.quests, playerId, now) || freshQuestState(playerId, now);

		const p = new GamePlayer();
		p.id = client.sessionId;
		p.name = name;
		p.color = pickPlayerColor(client.sessionId);
		p.tx = this.realm.spawn.tx;
		p.ty = this.realm.spawn.ty;

		// Fixed-length inventory + hotbar so slot indices are stable drag targets.
		for (let i = 0; i < INV_SIZE; i++) p.inv.push(new Slot());
		for (let i = 0; i < HOTBAR_SIZE; i++) p.hotbar.push(new Slot());

		// Starter kit — the four gathering tools + a basic sword, mirroring the
		// guide's tutorial hand-out so a fresh player can exercise the full loop
		// immediately. Tools go straight onto the hotbar.
		const kit = ['axe', 'pickaxe', 'rod', 'sword'];
		for (let i = 0; i < kit.length; i++) {
			p.hotbar[i].item = kit[i];
			p.hotbar[i].qty = 1;
		}
		p.activeSlot = 0;
		// The avatar the player picked on /play (or a create→play handoff) rides in
		// as a join option. Fall back to the persisted avatar URL so a returning
		// player on a new device (or any session that didn't pass options.avatar)
		// is still rendered as their chosen look, not the default capsule.
		p.cosmetic = cleanAvatarUrl(options?.avatar) || cleanAvatarUrl(saved?.profile?.cosmetic) || '';
		p.badges = (quests.badges || []).join(',');
		// Restore the persisted purse + owned/equipped cosmetics (Task 16/21), keyed
		// to the stable account id so a purchase and the look the player chose survive
		// a disconnect/realm transfer. Owned ids are filtered to ones still in the
		// catalogue so a removed cosmetic never lingers; the equipped id must be owned.
		const cos = this._loadCosmetics(saved);
		p.gold = Number.isFinite(saved?.gold) ? Math.min(0xffffffff, Math.max(0, saved.gold | 0)) : 0;
		p.cosmeticId = cos.equipped;
		p.tsServer = now;
		this.state.players.set(client.sessionId, p);

		this.priv.set(client.sessionId, {
			playerId,
			// One XP bucket per trainable skill. Levels are broadcast on the schema;
			// raw XP stays server-side and is only ever sent to its owner.
			xp: Object.fromEntries(SKILLS.map((s) => [s, 0])),
			bank: Array.from({ length: BANK_SIZE }, () => ({ item: '', qty: 0 })),
			cooldowns: { gather: 0, attack: 0, fish: 0, cook: 0, consume: 0, step: 0 },
			rate: new Map(),
			quests,
			// Owned shop cosmetics (a Set of catalogue ids) + the equipped id. The
			// equipped id is mirrored onto the synced schema (p.cosmeticId); ownership
			// stays server-side and is only ever sent to its owner via the shop board.
			cosmetics: { owned: cos.owned, equipped: cos.equipped },
			// Wheel of Fortune (Task 19): when this account may next take its free spin.
			// Persisted per account so the 12h cooldown survives a disconnect/realm hop
			// and can't be reset by reconnecting. Paid spins never touch this timer.
			spin: { nextFreeSpinAt: Number.isFinite(saved?.spin?.nextFreeSpinAt) ? saved.spin.nextFreeSpinAt : 0 },
		});

		// Arriving through a portal: a signed transfer restores the haul the player
		// carried out of the previous realm and lands them at the portal's exit tile
		// instead of the realm's default spawn. An unsigned/expired/tampered token is
		// ignored — the player simply spawns fresh, never gaining forged items.
		const transfer = options?.transfer ? verifyTransfer(options.transfer) : null;
		if (transfer && transfer.to === this.realm.name) {
			if (transfer.carry) this._applyCarry(p, this.priv.get(client.sessionId), transfer.carry);
			const dtx = transfer.tx | 0, dty = transfer.ty | 0;
			if (inBounds(this.realm, dtx, dty) && !isBlocked(this.realm, dtx, dty)) {
				p.tx = dtx;
				p.ty = dty;
			}
		} else if (saved?.profile) {
			// No in-session carry token — this is a fresh login (first connect, a
			// reconnect, or a switch to another world instance). Restore the
			// account-scoped profile so items, hotbar, bank, skills, and mount are
			// identical regardless of which server the player chose (Task 23). The
			// profile is realm-agnostic; position stays this realm's spawn. Uses the
			// same defensively-bounded applier as portal carries, so a corrupt saved
			// blob can't inject out-of-range items or skill levels.
			this._applyCarry(p, this.priv.get(client.sessionId), saved.profile);

			// Resume at the tile the player was standing on when they left — so a
			// player picking up where they left off doesn't wake at the spawn fountain
			// every time. Position is only restored when it's the SAME realm (the
			// client may connect to any realm on re-login); danger realms always spawn
			// at the safe spawn so a disconnecting player isn't born inside a mob.
			if (!this.realm.danger &&
				saved.lastRealm === this.realm.name &&
				Number.isFinite(saved.lastTx) && Number.isFinite(saved.lastTy)) {
				const ltx = saved.lastTx | 0, lty = saved.lastTy | 0;
				if (inBounds(this.realm, ltx, lty) && !isBlocked(this.realm, ltx, lty)) {
					p.tx = ltx;
					p.ty = lty;
				}
			}

			// Restore placed structures (Task 07) the player left in this realm.
			// If the room is already live (reconnect), the structures may still be
			// present under the old session id — we hand them off. If the room was
			// freshly created (after room dispose or restart), we re-seed them.
			const savedStructures = saved.structures?.[this.realm.name] || [];
			if (savedStructures.length) this._restoreStructures(client, p, playerId, name, savedStructures);
		}

		// Register this session as the account's live presence + subscribe to its
		// eviction channel so a later login elsewhere can take this seat over. The
		// presence row records which server+realm the account is on, which a friends
		// panel (Task 15) reads via GET /presence to show "online on Server 2 ·
		// Mainland". Cleared/transferred on leave (see onLeave).
		const channel = evictChannel(playerId);
		const handler = (msg) => this._onEvict(playerId, msg);
		await this.presence.subscribe(channel, handler);
		this._evictSubs.set(client.sessionId, { channel, handler });
		// Marketplace payout channel (Task 20): a sale settled in another realm/room
		// nudges this seat to drain its durable payout queue, so gold proceeds land
		// live instead of waiting for the next login. Subscribed per-session and torn
		// down on leave alongside the eviction subscription.
		const payChan = payoutChannel(playerId);
		const payHandler = (msg) => {
			this._drainMarketPayouts(client.sessionId);
			// A cross-room sale notice piggybacks on the payout nudge (token sales pay
			// the seller on-chain so there's no payout to drain, but they still deserve
			// a toast). Send it directly if the message carries one.
			if (msg?.notice) {
				const c = this._clientFor(client.sessionId);
				if (c) try { c.send('notice', { kind: 'market', text: msg.notice }); } catch {}
			}
		};
		await this.presence.subscribe(payChan, payHandler);
		this._payoutSubs.set(client.sessionId, { channel: payChan, handler: payHandler });
		// Account-level friends presence (Task 15 + 23). The friends graph keys off
		// the three.ws account id (users.id), carried in verified, spoof-proof form by
		// a presence ticket — never a raw client field. The social hub publishes the
		// account's online status plus which world instance + realm it's on (TTL'd in
		// Redis, refreshed on a heartbeat) so the friends API can show "online ·
		// Server 2 · Mainland" and DM this player live. This is the single presence
		// path — there is no parallel by-playerId registry to scrape or leave stale.
		const accountUid = verifyPresenceTicket(options?.presence);
		if (accountUid) {
			client.userData = { ...(client.userData || {}), accountUid };
			socialHub.register(accountUid, client, this.realm.name, this.server);
		}

		// Claim any proceeds owed while this account was offline (gold from sales of
		// its listings). Drains the durable queue and credits the live player.
		this._drainMarketPayouts(client.sessionId);

		// Hand the client the full static realm layout (geometry, fountain, bank
		// counter, fishing/cooking tiles, safe camp, portals, and the
		// safe/pvp/danger flags) so it renders exactly the tiles the server treats
		// as solid/interactive — and knows whether this realm drops death-bags.
		// Dynamic objects (nodes, mobs, players, tombstones) arrive via synced
		// schema state instead. The build catalogue (which structures this realm
		// permits, with their authoritative costs) rides along so the client's build
		// menu + affordability never drift from the server (Task 07).
		const layout = realmLayout(this.realm);
		layout.buildCatalog = this._buildCatalog();
		client.send('realm', layout);
		// Item catalogue (icons, labels, mount tuning) so the hotbar can label items and
		// the scene can render the right steed. Static — sent once per join.
		client.send('items', clientItemRegistry());
		// Cosmetics catalogue (Task 21): id → name, rarity, price, rotation, and the
		// visual spec. Static, sent once per join so the client can render any peer's
		// equipped cosmetic immediately; the live shop board (offers + countdowns +
		// owned + gold) is fetched on demand via 'shopOpen'.
		client.send('cosmetics', clientCatalog());
		// Slash-command manifest (Task 13) so the chat input can autocomplete and
		// describe commands as the player types '/'. Generated from the same
		// registry that powers /help and the router, so the hint never drifts.
		client.send('commands', commandManifest());
		// Hand over the player's quest state (tutorial step, today's dailies +
		// progress, reset countdown, earned badges) so the quest panel and the
		// guide's "!"/"?" marker render immediately on entry.
		this._sendQuests(client);

		console.log(`[${this.realm.name} ${this.roomId}] +join ${name} (n=${this.state.players.size})`);
	}

	async onLeave(client) {
		const sid = client.sessionId;
		const priv = this.priv.get(sid);
		// An evicted session already persisted itself synchronously inside _onEvict;
		// persisting again here would write a now-stale snapshot over whatever the
		// new session has since done, so skip it. A normal leave persists as usual.
		if (!priv?._evicted) {
			this._persistPlayer(sid);
			// Force the final state to durable storage now rather than waiting on the
			// debounce timer (Task 16): a clean disconnect must not lose the last few
			// seconds if the process is torn down before the timer fires. No-op when
			// Redis isn't configured. The evicted path is skipped — its successor
			// session owns the record now and flushes on its own.
			if (priv?.playerId) await flushPlayer(priv.playerId);
		}

		// Drop the account's eviction subscription and clear its presence row — but
		// only if the row is still OURS. A takeover overwrites the row with the new
		// session's id on its own join, and that newer session must not be erased by
		// the old one's delayed disconnect.
		const sub = this._evictSubs.get(sid);
		if (sub) {
			try { this.presence.unsubscribe(sub.channel, sub.handler); } catch {}
			this._evictSubs.delete(sid);
		}
		const paySub = this._payoutSubs.get(sid);
		if (paySub) {
			try { this.presence.unsubscribe(paySub.channel, paySub.handler); } catch {}
			this._payoutSubs.delete(sid);
		}
		if (priv?.playerId) {
			try {
				const raw = await this.presence.hget(PRESENCE_HASH, priv.playerId);
				if (raw && JSON.parse(raw).sid === sid) await this.presence.hdel(PRESENCE_HASH, priv.playerId);
			} catch {}
		}

		if (client.userData?.accountUid) socialHub.unregister(client.userData.accountUid, client);

		this.state.players.delete(sid);
		this.priv.delete(sid);
	}

	// React to another login of the same account (published on its eviction channel
	// from onJoin). Enforces one active session per account across all realms and
	// world instances: persist the stale local session NOW (so the new session loads
	// the latest profile) and disconnect it with the takeover code, after telling it
	// why so the client shows a "signed in elsewhere" screen instead of reconnecting.
	_onEvict(playerId, msg) {
		const except = msg?.exceptSession || '';
		for (const [sid, priv] of this.priv) {
			if (priv.playerId !== playerId || sid === except || priv._evicted) continue;
			this._persistPlayer(sid);
			priv._evicted = true; // suppress the duplicate persist in onLeave
			const c = this._clientFor(sid);
			if (c) {
				try { c.send('takeover', { reason: 'signed-in-elsewhere' }); } catch {}
				try { c.leave(TAKEOVER_CLOSE_CODE); } catch {}
			}
		}
	}

	async onDispose() {
		// Belt-and-suspenders (Task 16): a normal dispose follows every client's
		// onLeave (which already persisted + flushed), but a forced teardown can skip
		// those — so persist and flush any session still resident before the room is
		// gone. Mirrors WalkRoom awaiting blockStore.flush on dispose.
		const ids = new Set();
		for (const [sid, priv] of this.priv) {
			if (priv?._evicted || !priv?.playerId) continue;
			this._persistPlayer(sid);
			ids.add(priv.playerId);
		}
		await Promise.allSettled([...ids].map((pid) => flushPlayer(pid)));
		console.log(`[${this.realm.name} ${this.roomId}] disposed`);
	}

	// ----- movement --------------------------------------------------------

	_handleStep(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p || p.dead) return;
		// A portal handshake is in flight — the client is about to leave for the
		// destination realm. Freeze further movement so a queued step can't trigger
		// a second transfer (or move the soon-to-be-snapshotted player off the tile).
		if (this.priv.get(client.sessionId)?.transferring) return;
		if (!this._rateOk(client.sessionId, 'step')) return;
		if (!payload || typeof payload !== 'object') return;

		const tx = payload.tx | 0;
		const ty = payload.ty | 0;
		if (!Number.isFinite(payload.tx) || !Number.isFinite(payload.ty)) return;

		// One tile, 8-way, no teleporting through anything.
		const dx = Math.abs(tx - p.tx);
		const dy = Math.abs(ty - p.ty);
		if (dx > 1 || dy > 1 || (dx === 0 && dy === 0)) return;
		if (!this._isWalkable(tx, ty)) return;
		// Don't allow cutting a diagonal between two blocked corners.
		if (dx === 1 && dy === 1 && (!this._isWalkable(tx, p.ty) && !this._isWalkable(p.tx, ty))) return;

		// Server-enforced step floor (Task 09): on foot you step no faster than
		// ON_FOOT_STEP_MS; a mount lowers the floor (items.js) for visibly faster but
		// still authoritative travel. Early steps are dropped and the client self-paces
		// to match, so a client claiming mount speed without a mount gains nothing.
		const sPriv = this.priv.get(client.sessionId);
		const sNow = Date.now();
		const stepFloor = p.mounted ? (mountStepMs(p.mount) || ON_FOOT_STEP_MS) : ON_FOOT_STEP_MS;
		if (sPriv && sNow < (sPriv.cooldowns.step || 0)) return;
		if (sPriv) sPriv.cooldowns.step = sNow + stepFloor;

		p.tx = tx;
		p.ty = ty;
		if (typeof payload.yaw === 'number' && Number.isFinite(payload.yaw)) p.yaw = payload.yaw;
		p.motion = 'walk';
		p.tsServer = Date.now();
		// Tutorial: the very first step is simply learning to walk.
		this._questProgress(client, { kind: 'move', n: 1 });

		// Stepping onto a portal tile carries the player to its destination realm.
		// Each realm is its own room instance, so the move is a seat reservation in
		// the destination room plus a signed snapshot of everything the player is
		// carrying — the client tears down this seat and joins the other room.
		const portal = portalAt(this.realm, tx, ty);
		if (portal) {
			// Combat-LEVEL gate (Task 11): a gated portal (e.g. the northern cave)
			// refuses entry until the player's combat level meets the threshold. The
			// player keeps standing on the tile — no transfer, no bounce — and is told
			// what they need. Server-authoritative: a client can't forge its way past.
			if (portal.gate && !this._meetsGate(p, portal.gate)) {
				client.send('notice', { kind: 'portal', text: `You need Combat ${portal.gate.combat} to enter here (you're ${this._combatLevel(p)}).` });
				return;
			}
			this._beginTransfer(client, p, portal);
		}
	}

	// ----- realm traversal -------------------------------------------------

	// Reserve a seat in the destination realm and hand the client a transfer it
	// can consume. The player's full carry (inventory, hotbar, bank, gold, skills,
	// hp, mount) rides in an HMAC-signed token so the destination room can restore
	// it without trusting the client — a forged or replayed carry is rejected there.
	async _beginTransfer(client, p, portal) {
		const priv = this.priv.get(client.sessionId);
		if (!priv || priv.transferring) return;
		const dest = REALMS[portal.to] ? portal.to : DEFAULT_REALM;
		const destRealm = REALMS[dest];
		const tx = Number.isFinite(portal.toTx) ? portal.toTx : destRealm.spawn.tx;
		const ty = Number.isFinite(portal.toTy) ? portal.toTy : destRealm.spawn.ty;
		priv.transferring = true;
		const token = signTransfer({ to: dest, tx, ty, carry: this._snapshotCarry(client, p) });
		try {
			const reservation = await matchMaker.joinOrCreate(`game_${dest}`, {
				name: p.name,
				avatar: p.cosmetic,
				pid: priv.playerId,
				transfer: token,
			});
			// Persist quests now so the destination room (which reloads them by pid)
			// sees the same progress this room had at the moment of the step.
			this._persistPlayer(client.sessionId);
			client.send('portal', { to: dest, reservation });
		} catch (err) {
			priv.transferring = false;
			console.error(`[${this.realm.name} ${this.roomId}] portal → ${dest} failed:`, err?.message ?? err);
			client.send('notice', { kind: 'portal', text: 'The way is blocked right now. Try again.' });
		}
	}

	// Snapshot everything a player carries between realms. Quests persist by pid
	// (reloaded in the destination's onJoin), so only the in-memory haul rides here.
	_snapshotCarry(client, p) {
		return this._serializeProfile(p, this.priv.get(client.sessionId));
	}

	// The account-scoped, realm-agnostic profile: inventory, hotbar, bank, gold,
	// skills (raw XP), vitals, and mount. Used both as the portal carry payload and
	// as the persisted profile blob (Task 16/23) — one serializer so the two never
	// drift, and so switching world instances restores exactly what a portal would.
	_serializeProfile(p, priv) {
		const slots = (arr) => arr.map((s) => ({ item: s.item, qty: s.qty }));
		return {
			inv: slots(p.inv),
			hotbar: slots(p.hotbar),
			activeSlot: p.activeSlot,
			bank: (priv?.bank || []).map((s) => ({ item: s.item, qty: s.qty })),
			gold: p.gold,
			hp: p.hp,
			maxHp: p.maxHp,
			xp: { ...(priv?.xp || {}) },
			mounted: !!p.mounted,
			mount: p.mount || '',
			// Avatar GLB URL — persisted so the player's look survives on a device that
			// never stored it locally. Validated on restore (same rules as join time).
			cosmetic: p.cosmetic || '',
		};
	}

	// Restore a verified carry onto a freshly-joined player in the destination room.
	// Slot arrays are rebuilt defensively (the token is signed, but we still bound
	// indices and quantities so a malformed-but-signed payload can't corrupt state).
	_applyCarry(p, priv, carry) {
		const fill = (target, src, size) => {
			for (let i = 0; i < size; i++) {
				const s = src && src[i];
				const item = s && typeof s.item === 'string' ? s.item : '';
				target[i].item = item;
				target[i].qty = item && Number.isFinite(s.qty) ? Math.max(0, Math.min(999, s.qty | 0)) : 0;
			}
		};
		fill(p.inv, carry.inv, INV_SIZE);
		fill(p.hotbar, carry.hotbar, HOTBAR_SIZE);
		if (Number.isFinite(carry.activeSlot)) {
			p.activeSlot = Math.max(-1, Math.min(HOTBAR_SIZE - 1, carry.activeSlot | 0));
		}
		if (priv) {
			for (let i = 0; i < BANK_SIZE; i++) {
				const s = carry.bank && carry.bank[i];
				const item = s && typeof s.item === 'string' ? s.item : '';
				priv.bank[i] = { item, qty: item && Number.isFinite(s.qty) ? Math.max(0, Math.min(999, s.qty | 0)) : 0 };
			}
			if (carry.xp && typeof carry.xp === 'object') {
				for (const skill of SKILLS) {
					const v = Number.isFinite(carry.xp[skill]) ? Math.max(0, carry.xp[skill]) : 0;
					priv.xp[skill] = v;
					p[skill] = levelForXp(v);
				}
			}
		}
		if (Number.isFinite(carry.gold)) p.gold = Math.max(0, Math.min(0xffffffff, carry.gold | 0));
		if (Number.isFinite(carry.maxHp) && carry.maxHp > 0) p.maxHp = carry.maxHp | 0;
		if (Number.isFinite(carry.hp)) p.hp = Math.max(0, Math.min(p.maxHp, carry.hp | 0));
		if (carry.mounted && typeof carry.mount === 'string' && carry.mount) {
			p.mounted = true;
			p.mount = carry.mount;
		}
		// Avatar GLB URL — restored from persisted profile on fresh login (not from a
		// portal carry, where the client already re-sends it as an option). Validated
		// through the same allow-list as join-time so a saved URL that has since been
		// removed from the allow-list doesn't persist to peers.
		if (typeof carry.cosmetic === 'string' && carry.cosmetic) {
			const validated = cleanAvatarUrl(carry.cosmetic);
			if (validated) p.cosmetic = validated;
		}
	}

	_isWalkable(tx, ty) {
		if (!inBounds(this.realm, tx, ty)) return false;
		if (isBlocked(this.realm, tx, ty)) return false;
		// Fixed NPCs occupy their tile; players stand adjacent to talk.
		for (const n of this.realm.npcs || []) {
			if (n.tx === tx && n.ty === ty) return false;
		}
		// Non-depleted resource nodes occupy their tile.
		for (const [, n] of this.state.nodes) {
			if (!n.depleted && n.tx === tx && n.ty === ty) return false;
		}
		// Living mobs occupy their tile.
		for (const [, m] of this.state.mobs) {
			if (!m.dead && m.tx === tx && m.ty === ty) return false;
		}
		// Player-built structures are solid — you stand beside a firepit/shack,
		// never on it (Task 07), exactly like the fountain.
		for (const [, s] of this.state.structures) {
			if (s.tx === tx && s.ty === ty) return false;
		}
		return true;
	}

	// ----- gathering -------------------------------------------------------

	_handleGather(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p || p.dead) return;
		// Mounted players ride; they can't swing a tool. Dismount to harvest. (Combat
		// stays allowed while mounted — cavalry can fight.)
		if (p.mounted) { client.send('notice', { kind: 'mount', text: 'Dismount before you gather.' }); return; }
		if (!this._rateOk(client.sessionId, 'gather')) return;
		const node = this.state.nodes.get(String(payload?.id ?? ''));
		if (!node || node.depleted) return;

		const priv = this.priv.get(client.sessionId);
		const now = Date.now();
		if (now < priv.cooldowns.gather) return;

		if (!this._adjacent(p, node)) return;

		const rule = NODE_RULES[node.kind];
		if (!rule) return;

		// Must have the right tool equipped on the active hotbar slot.
		const active = p.hotbar[p.activeSlot];
		if (!active || active.item !== rule.tool) {
			client.send('notice', { kind: 'tool', text: `Equip a ${rule.tool} to gather this.` });
			return;
		}

		// Award the resource. _addItem returns the quantity that DIDN'T fit, so a
		// nonzero leftover on a single item means the backpack is full.
		const leftover = this._addItem(p, rule.item, 1);
		if (leftover >= 1) {
			client.send('notice', { kind: 'full', text: 'Your inventory is full.' });
			return;
		}
		let bonusCoal = false;
		if (node.kind === 'rock' && Math.random() < 0.15) { this._addItem(p, 'coal', 1); bonusCoal = true; }

		this._grantXp(client, p, rule.skill, 8 + Math.floor(Math.random() * 5));
		node.depleted = true;
		node.respawnAt = now + rule.respawnMs;
		priv.cooldowns.gather = now + GATHER_COOLDOWN_MS;
		p.tsServer = now;
		// Quest progress: the resource just harvested (plus any bonus coal from a
		// rock) counts toward gathering tutorial steps and dailies.
		this._questProgress(client, { kind: 'gather', item: rule.item, n: 1 });
		if (bonusCoal) this._questProgress(client, { kind: 'gather', item: 'coal', n: 1 });
	}

	// ----- fishing ---------------------------------------------------------

	// Cast a line. Validates (alive, rod equipped, beside fishable water, off
	// cooldown, room in the pack) then rolls a catch against fishing skill + spot
	// quality. Every cast — hit or miss — arms the per-cast cooldown so casting
	// has cadence on the real clock; the client renders the line/bobber while the
	// authoritative result rides back as a notice.
	_handleFish(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p || p.dead) return;
		if (!this._rateOk(client.sessionId, 'fish')) return;
		if (p.mounted) { client.send('notice', { kind: 'mount', text: 'Dismount before you fish.' }); return; }

		const priv = this.priv.get(client.sessionId);
		const now = Date.now();
		if (now < priv.cooldowns.fish) return; // still reeling in the previous cast

		// Need the rod on the active hotbar slot.
		const active = p.hotbar[p.activeSlot];
		if (!active || active.item !== 'rod') {
			client.send('notice', { kind: 'tool', text: 'Equip a fishing rod to cast.' });
			return;
		}

		// Need fishable water within one tile (8-way, including the player's tile).
		const spot = fishingSpotNear(this.realm, p.tx, p.ty);
		if (!spot) {
			client.send('notice', { kind: 'fish', text: 'Move next to the water to cast.' });
			return;
		}

		// Don't let a catch evaporate: reject the cast up front when there's no room
		// for even one fish — same notice the gather path uses.
		if (!this._hasRoomFor(p, 'fish')) {
			client.send('notice', { kind: 'full', text: 'Your inventory is full.' });
			return;
		}

		// Arm the cadence on the real cooldown clock (no fake timers).
		priv.cooldowns.fish = now + FISH_COOLDOWN_MS;

		const lvl = p.fishing;
		const quality = spot.quality || 1;
		const chance = fishCatchChance(lvl, quality);

		if (Math.random() < chance) {
			// Yield: usually one fish, with a skill/quality-scaled shot at a double haul.
			const want = 1 + (Math.random() < fishDoubleChance(lvl, quality) ? 1 : 0);
			const leftover = this._addItem(p, 'fish', want);
			const caught = want - leftover;
			if (caught <= 0) {
				// Pack filled between the room check and now — be honest, no phantom catch.
				client.send('notice', { kind: 'full', text: 'Your inventory is full.' });
				p.tsServer = now;
				return;
			}
			// XP scales gently with level + quality so richer water trains faster.
			const xp = Math.round((10 + Math.floor(Math.random() * 6) + lvl * 0.3) * quality) * caught;
			this._grantXp(client, p, 'fishing', xp);
			this._questProgress(client, { kind: 'fish', item: 'fish', n: caught });
			client.send('notice', { kind: 'fish', text: caught > 1 ? `Caught ${caught} fish!` : 'Caught a fish.' });
		} else {
			// A miss still teaches the cast — a small XP trickle keeps progression smooth.
			this._grantXp(client, p, 'fishing', 2);
			client.send('notice', { kind: 'fish', text: 'The fish got away.' });
		}
		p.tsServer = now;
	}

	// Is there room in the backpack for at least one of `item`? For stackables, an
	// empty slot OR a non-full existing stack counts; otherwise an empty slot.
	_hasRoomFor(p, item) {
		if (STACKABLE.has(item)) {
			for (const s of p.inv) {
				if (!s.item) return true;
				if (s.item === item && s.qty < MAX_STACK) return true;
			}
			return false;
		}
		return p.inv.some((s) => !s.item);
	}

	// ----- cooking & consumables -------------------------------------------

	// Cook raw fish into cooked fish at a Roast Pit. Validates the player is
	// alive, standing on/next to a cooking tile of THIS realm, and actually holds
	// raw fish; then converts up to a small batch in one action (one cooldown).
	// Low cooking levels burn some fish — the raw fish is consumed with no result
	// and the player is told honestly; burns grant no XP. Never loses or dupes an
	// item: the cooked result is reserved (pack space checked) before the raw fish
	// is spent.
	_handleCook(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p || p.dead) return;
		if (!this._rateOk(client.sessionId, 'cook')) return;
		if (p.mounted) { client.send('notice', { kind: 'mount', text: 'Dismount before you cook.' }); return; }

		const priv = this.priv.get(client.sessionId);
		const now = Date.now();
		if (now < priv.cooldowns.cook) return;

		if (!this._atCookingSpot(p)) {
			client.send('notice', { kind: 'cook', text: 'Stand by the Roast Pit to cook.' });
			return;
		}

		const fish = this._findItemSlot(p, 'fish');
		if (!fish) {
			client.send('notice', { kind: 'cook', text: 'You have no raw fish to cook.' });
			return;
		}

		const want = Math.max(1, Math.min(COOK_BATCH_MAX, payload?.qty | 0 || 1));
		const level = p.cooking;
		let cooked = 0;
		let burned = 0;
		for (let i = 0; i < want; i++) {
			const slot = fish.slot;
			if (slot.item !== 'fish' || slot.qty <= 0) break; // stack exhausted
			if (Math.random() < cookBurnChance(level)) {
				// Burned: the raw fish is gone, nothing to store, no XP.
				slot.qty -= 1;
				if (slot.qty === 0) slot.item = '';
				burned++;
				continue;
			}
			// Success: reserve pack space for the cooked fish BEFORE spending the raw
			// one. If the pack is full, stop the batch with no item lost.
			const leftover = this._addItem(p, 'cookedFish', 1);
			if (leftover >= 1) {
				if (cooked === 0 && burned === 0) {
					client.send('notice', { kind: 'full', text: 'Your inventory is full.' });
					return;
				}
				break;
			}
			slot.qty -= 1;
			if (slot.qty === 0) slot.item = '';
			this._grantXp(client, p, 'cooking', COOK_XP);
			cooked++;
		}

		if (cooked === 0 && burned === 0) return;
		priv.cooldowns.cook = now + COOK_COOLDOWN_MS;
		p.tsServer = now;

		if (cooked > 0) this._questProgress(client, { kind: 'cook', item: 'cookedFish', n: cooked });

		// Honest result: report exactly what the fire produced.
		const parts = [];
		if (cooked) parts.push(`Cooked ${cooked} fish`);
		if (burned) parts.push(`burned ${burned}`);
		client.send('cooked', { cooked, burned, level: p.cooking });
		client.send('notice', { kind: cooked ? 'cook' : 'burn', text: `${parts.join(', ')}.` });
	}

	// Eat an edible item (cooked fish, potions) from a referenced inv/hotbar slot
	// to restore HP. Server-authoritative: validates the slot really holds an
	// edible item, refuses at full health (so food is never silently wasted),
	// heals up to maxHp (never over), consumes one from the stack, and applies a
	// short cooldown. Works from both the backpack and the hotbar.
	_handleConsume(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p || p.dead) return;
		if (!this._rateOk(client.sessionId, 'consume')) return;

		const priv = this.priv.get(client.sessionId);
		const now = Date.now();
		if (now < priv.cooldowns.consume) return;

		const ref = this._resolveSlot(p, payload?.slot);
		if (!ref) return;
		const slot = ref.slot;
		if (!slot.item || !isEdible(slot.item)) {
			client.send('notice', { kind: 'eat', text: 'That can’t be eaten.' });
			return;
		}
		if (p.hp >= p.maxHp) {
			client.send('notice', { kind: 'eat', text: 'You’re already at full health.' });
			return;
		}

		const before = p.hp;
		p.hp = Math.min(p.maxHp, p.hp + scaledHeal(slot.item, p.cooking));
		const gained = p.hp - before;
		slot.qty -= 1;
		if (slot.qty === 0) slot.item = '';
		priv.cooldowns.consume = now + CONSUME_COOLDOWN_MS;
		p.tsServer = now;
		client.send('notice', { kind: 'eat', text: `+${gained} HP.` });
	}

	// True if the player is on or directly adjacent to any cooking tile (the Roast
	// Pit) of the current realm — you stand by the fire, not necessarily on it.
	_atCookingSpot(p) {
		const tiles = this.realm.cooking || [];
		for (const t of tiles) {
			if (Math.abs(p.tx - t.tx) <= 1 && Math.abs(p.ty - t.ty) <= 1) return true;
		}
		return false;
	}

	// Find a live slot holding `item`: the active hotbar slot first (what you're
	// "holding"), then the rest of the hotbar, then the backpack. Null if none.
	_findItemSlot(p, item) {
		const active = p.hotbar[p.activeSlot];
		if (active && active.item === item && active.qty > 0) return { slot: active };
		for (const s of p.hotbar) if (s.item === item && s.qty > 0) return { slot: s };
		for (const s of p.inv) if (s.item === item && s.qty > 0) return { slot: s };
		return null;
	}

	// ----- combat ----------------------------------------------------------

	_handleAttack(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p || p.dead) return;
		if (!this._rateOk(client.sessionId, 'attack')) return;
		const targetId = String(payload?.id ?? '');
		const mob = this.state.mobs.get(targetId);
		// No mob with that id → maybe it's another player. PvP rides the same 'attack'
		// intent + cooldown; the dedicated handler enforces this realm's PvP rules.
		if (!mob) {
			const victim = this.state.players.get(targetId);
			if (victim && victim !== p) this._attackPlayer(client, p, victim);
			return;
		}
		if (mob.dead) return;

		const priv = this.priv.get(client.sessionId);
		const now = Date.now();
		if (now < priv.cooldowns.attack) return;
		if (!this._adjacent(p, mob)) return;

		// Damage scales with combat level; a sword on the active slot adds a flat
		// bonus. Small variance keeps fights from feeling mechanical.
		const hasSword = p.hotbar[p.activeSlot]?.item === 'sword';
		const base = 4 + Math.floor(p.combat * 0.8) + (hasSword ? 6 : 0);
		const dmg = base + Math.floor(Math.random() * 4);
		mob.hp = Math.max(0, mob.hp - dmg);
		mob.hitTs = now;
		priv.cooldowns.attack = now + ATTACK_COOLDOWN_MS;

		if (mob.hp === 0) {
			mob.dead = true;
			mob.respawnAt = now + RESPAWN_MOB_MS;
			const reward = 5 + Math.floor(Math.random() * 6);
			p.gold = Math.min(0xffffffff, p.gold + reward);
			this._grantXp(client, p, 'combat', 14 + Math.floor(Math.random() * 8));
			client.send('notice', { kind: 'kill', text: `Defeated ${mob.kind} (+${reward}g).` });
			// Task 09: roll the mob's loot table — materials and, rarely, a ridable mount.
			this._awardLoot(client, p, mob);
			// Quest progress: a defeated foe counts toward combat tutorial + dailies.
			this._questProgress(client, { kind: 'combat', n: 1 });
		}
		p.tsServer = now;
	}

	// ----- player vs player (Task 04 rules, enforced for the wild realms + Arena) ----

	// Strike another player. Server-authoritative and gated by the realm's rules:
	// PvP must be ON, neither fighter may stand in a PvP-immune tile (a wilderness
	// safe camp or an Arena spectator stand), and the attacker must be adjacent and
	// off cooldown. Damage flows through the shared _damagePlayer funnel, so a fatal
	// blow drops a death-bag in danger realms (the wilds) and is a clean, item-safe
	// knockout in the Arena (danger:false). On a kill the victor takes combat XP and
	// a small bounty.
	_attackPlayer(client, attacker, victim) {
		if (!this.realm.pvp) {
			client.send('notice', { kind: 'pvp', text: 'This is a peaceful realm — you can’t attack other players here.' });
			return;
		}
		if (victim.dead) return;
		// A spectator stand / safe camp shields BOTH sides: you can't be hit while in
		// one, and you can't reach out of the floor to hit someone standing in it.
		if (inNoPvpZone(this.realm, attacker.tx, attacker.ty)) {
			client.send('notice', { kind: 'pvp', text: 'Step out of the safe zone to fight.' });
			return;
		}
		if (inNoPvpZone(this.realm, victim.tx, victim.ty)) {
			client.send('notice', { kind: 'pvp', text: `${victim.name} is in a safe zone.` });
			return;
		}

		const priv = this.priv.get(client.sessionId);
		const now = Date.now();
		if (now < priv.cooldowns.attack) return;
		if (!this._adjacent(attacker, victim)) return;

		const hasSword = attacker.hotbar[attacker.activeSlot]?.item === 'sword';
		const base = 4 + Math.floor(attacker.combat * 0.8) + (hasSword ? 6 : 0);
		const dmg = base + Math.floor(Math.random() * 4);
		priv.cooldowns.attack = now + ATTACK_COOLDOWN_MS;

		const fatal = this._damagePlayer(victim, dmg, { by: attacker.id, byName: attacker.name });
		attacker.tsServer = now;
		if (fatal) {
			const bounty = 8 + Math.floor(Math.random() * 8);
			attacker.gold = Math.min(0xffffffff, attacker.gold + bounty);
			this._grantXp(client, attacker, 'combat', 18 + Math.floor(Math.random() * 10));
			client.send('notice', { kind: 'kill', text: `You defeated ${victim.name} (+${bounty}g).` });
			this._questProgress(client, { kind: 'combat', n: 1 });
		}
	}

	// ----- mounts & loot ---------------------------------------------------

	// Roll a slain mob's loot table and hand the killer their winnings. Mounts are
	// rare; everything else is gathered material. Items go to the pack (mounts prefer
	// a free HOTBAR slot so they're immediately rideable); anything that doesn't fit
	// spills into a ground bag on the mob's tile instead of vanishing — loot is never
	// silently lost on a full pack.
	_awardLoot(client, p, mob) {
		const drops = rollLoot(mob.kind);
		if (!drops.length) return;
		const spoils = []; // non-mount lines for the loot toast
		const overflow = []; // Slots that didn't fit anywhere → ground bag
		let mount = null; // { label, bagged } when a mount drops
		for (const d of drops) {
			const left = this._giveLoot(p, d.item, d.qty);
			const got = d.qty - left;
			if (isMount(d.item)) {
				if (got > 0 || left > 0) mount = { label: itemLabel(d.item), bagged: left > 0 };
			} else if (got > 0) {
				spoils.push(got > 1 ? `${got}× ${itemLabel(d.item)}` : itemLabel(d.item));
			}
			if (left > 0) overflow.push(new Slot(d.item, left));
		}
		if (overflow.length) this._spawnLootBag(p, mob.tx, mob.ty, overflow);

		if (mount) {
			const where = mount.bagged ? 'It dropped into the bag at your feet.' : 'It’s on your hotbar — ride out!';
			client.send('notice', { kind: 'mount', text: `The ${mob.kind} dropped a ${mount.label}! ${where}` });
		}
		if (spoils.length) client.send('notice', { kind: 'loot', text: `Looted ${spoils.join(', ')}.` });
		if (overflow.length && !(mount && mount.bagged)) {
			client.send('notice', { kind: 'full', text: 'Pack full — extra loot waits in a bag at your feet.' });
		}
	}

	// Give looted items to a player. Mounts are seated on a free HOTBAR slot first
	// (there is no inv→hotbar mover yet, and a mount you can't reach is useless),
	// then the backpack; everything else goes straight to the backpack. Returns the
	// quantity that didn't fit anywhere.
	_giveLoot(p, item, qty) {
		if (isMount(item)) {
			let placed = 0;
			for (const s of p.hotbar) {
				if (placed >= qty) break;
				if (!s.item) { s.item = item; s.qty = 1; placed++; }
			}
			if (placed >= qty) return 0;
			return this._addItem(p, item, qty - placed);
		}
		return this._addItem(p, item, qty);
	}

	// Spill overflow loot into a ground bag on (tx,ty) owned by the killer — the same
	// Tombstone vessel + tombLoot recovery path used by death-bags, so loot never
	// vanishes on a full pack and the client renders/recovers it identically.
	_spawnLootBag(p, tx, ty, slots) {
		const now = Date.now();
		const bag = new Tombstone();
		bag.id = `loot_${this.realm.name}_${p.id}_${++this._tombSeq}`;
		bag.owner = p.id;
		bag.ownerName = p.name;
		bag.tx = tx;
		bag.ty = ty;
		bag.expiresAt = now + TOMBSTONE_TTL_MS;
		for (const s of slots) bag.items.push(s);
		this.state.tombstones.set(bag.id, bag);
		return bag.items.length;
	}

	// Use the active hotbar item (or an explicit slot). Today that rides a mount; the
	// registry decides what "use" means per item, so future usable items slot in here
	// without a new intent. A stray click on a non-usable item is a harmless no-op.
	_handleUse(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p || p.dead) return;
		if (!this._rateOk(client.sessionId, 'ui')) return;
		let i = p.activeSlot;
		if (payload && Number.isInteger(payload.slot)) i = payload.slot | 0;
		if (i < 0 || i >= HOTBAR_SIZE) return;
		const slot = p.hotbar[i];
		if (!slot || !slot.item) return;
		if (isMount(slot.item)) {
			p.activeSlot = i; // hold the reins
			this._mount(client, p, slot.item);
		}
	}

	// Mount up: flip to the faster server-enforced cadence and record the steed so
	// peers render it. Re-mounting the same steed is a no-op; swapping steeds just
	// changes which creature you ride.
	_mount(client, p, item) {
		if (p.mounted && p.mount === item) return;
		p.mounted = true;
		p.mount = item;
		p.tsServer = Date.now();
		client.send('notice', { kind: 'mount', text: `Mounted your ${itemLabel(item)}.` });
	}

	// Leave the saddle, back to on-foot speed. Idempotent and friendly when already
	// on foot. Routed to by the 'dismount' intent and the /dismount command.
	_handleDismount(client) {
		const p = this.state.players.get(client.sessionId);
		if (!p) return;
		if (!this._rateOk(client.sessionId, 'ui')) return;
		if (!p.mounted) { client.send('notice', { kind: 'mount', text: 'You’re not mounted.' }); return; }
		const was = p.mount;
		p.mounted = false;
		p.mount = '';
		p.tsServer = Date.now();
		client.send('notice', { kind: 'mount', text: `Dismounted your ${itemLabel(was)}.` });
	}

	// ----- world chat ------------------------------------------------------

	// Realm-wide chat. This room IS one realm, so a broadcast reaches exactly the
	// players who can see each other — chat never leaks across realms/instances.
	// Leading-'/' messages are handed to the command router instead of broadcast
	// (Task 13); everything else is sanitized, length-capped, rate-limited, and
	// echoed to everyone (the sender included, so their own line is driven by the
	// same authoritative event their peers receive).
	_handleChat(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p) return;
		const now = Date.now();
		// Sanitize up front (strip control chars, collapse whitespace, trim). Cap
		// generously here so we can still measure "too long" against MAX_CHAT_LEN
		// rather than silently truncating to it.
		const text = clean(payload?.text, 2000);
		if (!text) return;

		// Slash-commands bypass chat entirely — the command router has its own
		// validation and rate limit, so route before charging a chat token.
		if (text[0] === '/') { this._handleCommand(client, { text }); return; }

		// Flood control. Tell the sender (throttled, so a flood can't be amplified
		// into a flood of error replies) instead of dropping silently.
		if (!this._rateOk(client.sessionId, 'chat')) {
			const priv = this.priv.get(client.sessionId);
			if (priv && now - (priv.chatNoticeAt || 0) > 1500) {
				priv.chatNoticeAt = now;
				client.send('chat', { system: true, kind: 'error', text: 'You’re sending messages too fast.', ts: now });
			}
			return;
		}

		// Length cap — reject rather than truncate so nothing is sent half-said.
		if (text.length > MAX_CHAT_LEN) {
			client.send('chat', { system: true, kind: 'error', text: `Message too long. Keep it under ${MAX_CHAT_LEN} characters.`, ts: now });
			return;
		}

		this.broadcast('chat', { id: client.sessionId, name: p.name, text, ts: now });
	}

	// Slash-command channel. Task 13's chat forwards any leading-'/' message here; the
	// game HUD also calls it directly. Handles /dismount and /mount today; unknown
	// commands get an honest reply rather than silence.
	_handleCommand(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p) return;
		if (!this._rateOk(client.sessionId, 'ui')) return;
		const text = clean(payload?.text, 64);
		const cmd = text.replace(/^\//, '').split(/\s+/)[0].toLowerCase();

		// /mount needs the hotbar + item registry, so it stays inline; every other
		// command is dispatched through the Task 13 registry — the single source of
		// truth for /help, /who, /pickup, /lock, /unlock, /dismount.
		if (cmd === 'mount') {
			const slot = p.hotbar[p.activeSlot];
			if (slot && isMount(slot.item)) this._mount(client, p, slot.item);
			else client.send('notice', { kind: 'mount', text: 'Select a mount on your hotbar first.' });
			return;
		}

		const reply = runCommand({ room: this, client, player: p }, text);
		// Command replies render as system chat lines — distinct from player chat —
		// so multi-line output (/help, /who) stays readable instead of flashing past
		// as a toast. A null reply means the handler already answered (e.g. /dismount).
		if (reply && reply.text) {
			client.send('chat', { system: true, kind: reply.kind || 'system', text: reply.text, ts: Date.now() });
		}
	}

	// ----- building (Task 07: firepit / shack) -----------------------------

	// The structures this realm permits, each with its authoritative cost + lifetime,
	// sent to the client on join so the build menu and ghost validity mirror the
	// server exactly. `cap` 0 means unlimited (the client renders no cap note).
	_buildCatalog() {
		const out = {};
		for (const kind of this.realm.structures || []) {
			const def = STRUCTURE_DEFS[kind];
			if (def) out[kind] = { cost: { ...def.cost }, lifetimeMs: def.lifetimeMs, cap: Number.isFinite(def.cap) ? def.cap : 0 };
		}
		return out;
	}

	// Place a structure on an adjacent tile, paying its EXACT material cost. The
	// server is the sole authority: it re-validates the realm rules, the target
	// tile, the per-player cap, and the full material bill, and deducts atomically
	// (the cost is checked payable before a single item is spent) so there is no
	// free build and no negative balance. A firepit gets an `expiresAt`; a shack is
	// permanent. The client's build-mode ghost mirrors these gates for instant
	// feedback, but a forged 'build' that skips them gets nothing here.
	_handleBuild(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p || p.dead) return;
		if (!this._rateOk(client.sessionId, 'ui')) return;
		// You build with your hands, not from the saddle — mirrors the gather gate.
		if (p.mounted) { client.send('notice', { kind: 'build', text: 'Dismount before you build.' }); return; }
		if (!payload || typeof payload !== 'object') return;

		const kind = String(payload.kind ?? '');
		const def = STRUCTURE_DEFS[kind];
		if (!def) return;

		// Realm rules (Task 01): the realm must permit this structure kind. Shacks
		// are Whisperwood-only; firepits are allowed wherever building makes sense.
		if (!(this.realm.structures || []).includes(kind)) {
			client.send('notice', { kind: 'build', text: `You can’t build a ${kind} here.` });
			return;
		}

		if (!Number.isFinite(payload.tx) || !Number.isFinite(payload.ty)) return;
		const tx = payload.tx | 0;
		const ty = payload.ty | 0;

		// Must sit on a tile right next to the builder (8-way) — never under them.
		const dx = Math.abs(tx - p.tx);
		const dy = Math.abs(ty - p.ty);
		if (dx === 0 && dy === 0) { client.send('notice', { kind: 'build', text: 'Step back a tile to place it.' }); return; }
		if (dx > 1 || dy > 1) { client.send('notice', { kind: 'build', text: 'Build on a tile right beside you.' }); return; }

		// The tile must be free and buildable: walkable (so not blocked, not on a
		// node/mob/another structure) and clear of portals, the bank counter, the
		// fountain, fishing/cooking spots, and any standing player.
		if (!this._isBuildable(tx, ty)) { client.send('notice', { kind: 'build', text: 'You can’t build there.' }); return; }

		// Per-player cap (shack: one). Counted on the live structure map.
		if (Number.isFinite(def.cap)) {
			let owned = 0;
			for (const [, s] of this.state.structures) {
				if (s.kind === kind && this._ownedBy(s, priv.playerId)) owned++;
			}
			if (owned >= def.cap) {
				client.send('notice', { kind: 'build', text: `You can only have ${def.cap} ${kind}${def.cap === 1 ? '' : 's'} — pick it up first.` });
				return;
			}
		}

		// Exact material cost — verify the whole bill is payable before spending any
		// of it, then deduct atomically.
		if (!this._canAfford(p, def.cost)) {
			client.send('notice', { kind: 'build', text: `Need ${this._missingCost(p, def.cost)} to build a ${kind}.` });
			return;
		}
		this._spendCost(p, def.cost);

		const now = Date.now();
		const s = new Structure();
		s.id = `st_${this.realm.name}_${p.id}_${++this._structSeq}`;
		s.kind = kind;
		// Store the stable account id on a server-only property so ownership
		// survives reconnects (a new session gets a new p.id). s.owner stays the
		// session id that the schema broadcasts to peers for client-side UI rendering.
		s._ownerPlayerId = priv.playerId;
		s.owner = p.id;
		s.ownerName = p.name;
		s.tx = tx;
		s.ty = ty;
		s.expiresAt = def.lifetimeMs ? now + def.lifetimeMs : 0;
		s.locked = false;
		this.state.structures.set(s.id, s);
		p.tsServer = now;
		client.send('notice', { kind: 'build', text: `Built a ${kind}.` });
		// Quest progress: placing any structure counts toward the build daily.
		this._questProgress(client, { kind: 'build', item: kind, n: 1 });
	}

	// A tile is buildable when it's walkable (bounds + not blocked + no node/mob/
	// structure on it) AND clear of the interactive/landmark tiles a structure
	// must never cover or block: portals, the bank counter, the fountain, and the
	// fishing/cooking spots — plus any tile a player is currently standing on.
	_isBuildable(tx, ty) {
		if (!this._isWalkable(tx, ty)) return false;
		for (const [, pl] of this.state.players) {
			if (!pl.dead && pl.tx === tx && pl.ty === ty) return false;
		}
		if (portalAt(this.realm, tx, ty)) return false;
		if ((this.realm.bankZone || []).some((t) => t.tx === tx && t.ty === ty)) return false;
		const f = this.realm.fountain;
		if (f && f.tx === tx && f.ty === ty) return false;
		for (const sp of this.realm.fishing || []) if (sp.tx === tx && sp.ty === ty) return false;
		for (const ck of this.realm.cooking || []) if (ck.tx === tx && ck.ty === ty) return false;
		return true;
	}

	// Total quantity of `item` the player holds across backpack + hotbar — materials
	// usually live in the backpack, but count both so a stack dragged to the hotbar
	// still pays.
	_countMaterial(p, item) {
		let n = 0;
		for (const s of p.inv) if (s.item === item) n += s.qty;
		for (const s of p.hotbar) if (s.item === item) n += s.qty;
		return n;
	}

	_canAfford(p, cost) {
		for (const [item, qty] of Object.entries(cost)) {
			if (this._countMaterial(p, item) < qty) return false;
		}
		return true;
	}

	// A human-readable summary of what the player is short for `cost` — drives the
	// honest "Need 200 more wood" notice.
	_missingCost(p, cost) {
		const parts = [];
		for (const [item, qty] of Object.entries(cost)) {
			const short = qty - this._countMaterial(p, item);
			if (short > 0) parts.push(`${short} more ${itemLabel(item)}`);
		}
		return parts.join(', ');
	}

	// Atomically remove a paid cost from the pack (backpack first, then hotbar),
	// emptying slots as they zero out. Only ever called after _canAfford passes, so
	// it never under-pays or drives a slot negative.
	_spendCost(p, cost) {
		for (const [item, qty] of Object.entries(cost)) {
			let left = qty;
			for (const arr of [p.inv, p.hotbar]) {
				for (const s of arr) {
					if (left <= 0) break;
					if (s.item !== item) continue;
					const take = Math.min(s.qty, left);
					s.qty -= take;
					left -= take;
					if (s.qty === 0) s.item = '';
				}
			}
		}
	}

	// Restore a player's placed structures from their persisted profile into the
	// live room state. Handles two cases:
	//   a) Room still live (reconnect): the structure is already in state.structures
	//      under the OLD session id — update owner to the new session so pickup/lock
	//      work again. Skipped if another player's structure now occupies that tile.
	//   b) Room freshly created (after dispose or restart): re-seed the structure;
	//      skip any tile that's now blocked (another player's structure placed first).
	// Expired firepits are silently dropped rather than resurrected.
	_restoreStructures(client, p, playerId, playerName, savedStructures) {
		const now = Date.now();
		for (const sv of savedStructures) {
			if (sv.expiresAt && sv.expiresAt <= now) continue; // firepit expired — gone
			const tx = sv.tx | 0, ty = sv.ty | 0;

			// Case (a): structure still in this live room under the old session id.
			let found = false;
			for (const [, s] of this.state.structures) {
				if (s.tx === tx && s.ty === ty && s.kind === sv.kind &&
					(s._ownerPlayerId === playerId || s.owner === client.sessionId)) {
					s.owner = client.sessionId; // hand off to new session
					s._ownerPlayerId = playerId;
					found = true;
					break;
				}
			}
			if (found) continue;

			// Case (b): re-seed. Check tile is clear (bounds, walkable, no other structure).
			if (!inBounds(this.realm, tx, ty) || isBlocked(this.realm, tx, ty)) continue;
			let blocked = false;
			for (const [, s] of this.state.structures) {
				if (s.tx === tx && s.ty === ty) { blocked = true; break; }
			}
			if (blocked) continue;

			const s = new Structure();
			s.id = `st_restore_${this.realm.name}_${client.sessionId}_${++this._structSeq}`;
			s.kind = sv.kind;
			s._ownerPlayerId = playerId;
			s.owner = client.sessionId;
			s.ownerName = playerName;
			s.tx = tx;
			s.ty = ty;
			s.expiresAt = sv.expiresAt || 0;
			s.locked = !!sv.locked;
			this.state.structures.set(s.id, s);
		}
	}

	// ----- structure actions (firepit/shack; invoked by /pickup /lock /unlock) ----
	// These operate on real synced state.structures and never throw on the empty
	// case: with no structure placed they honestly report "nothing placed". Only the
	// owner can act, and only on a structure beside them.

	pickupStructure(p) {
		const priv = this.priv.get(p.id);
		const owned = [];
		for (const [, s] of this.state.structures) if (this._ownedBy(s, priv?.playerId || p.id)) owned.push(s);
		if (!owned.length) return { text: 'You have not placed a firepit or shack to pick up.', kind: 'error' };
		const near = owned.filter((s) => this._adjacent(p, s)).sort((a, b) => this._d2(p, a) - this._d2(p, b));
		if (!near.length) {
			const where = owned.map((s) => `  • ${s.kind} at (${s.tx}, ${s.ty})`).join('\n');
			return { text: `Stand next to one of your structures to pick it up:\n${where}`, kind: 'info' };
		}
		const s = near[0];
		if (s.locked) return { text: `Your ${s.kind} is locked — /unlock it first.`, kind: 'error' };
		this.state.structures.delete(s.id);
		return { text: `Picked up your ${s.kind}.`, kind: 'info' };
	}

	setStructureLock(p, locked) {
		const priv = this.priv.get(p.id);
		let target = null;
		for (const [, s] of this.state.structures) {
			if (this._ownedBy(s, priv?.playerId || p.id) && this._adjacent(p, s) &&
				(!target || this._d2(p, s) < this._d2(p, target))) target = s;
		}
		if (!target) return { text: `Stand next to your own firepit or shack to ${locked ? 'lock' : 'unlock'} it.`, kind: 'error' };
		if (target.locked === locked) return { text: `Your ${target.kind} is already ${locked ? 'locked' : 'unlocked'}.`, kind: 'info' };
		target.locked = locked;
		const k = target.kind.charAt(0).toUpperCase() + target.kind.slice(1);
		return { text: `${k} ${locked ? 'locked' : 'unlocked'}.`, kind: 'info' };
	}

	// A structure is "owned by" an account when _ownerPlayerId (stable account id
	// stored at build time) or the legacy session-id owner field matches. The stable
	// id is preferred; the fallback keeps pre-fix structures accessible.
	_ownedBy(s, playerId) {
		return (s._ownerPlayerId || s.owner) === playerId;
	}

	// Squared tile distance — cheap "nearest" ordering, no sqrt.
	_d2(a, b) { const dx = a.tx - b.tx, dy = a.ty - b.ty; return dx * dx + dy * dy; }

	// ----- death & tombstones ----------------------------------------------

	// Single funnel for all damage to a player (mob contact in Task 03, PvP in
	// Task 04, environment, …). Clamps HP at 0 and, when it lands the killing
	// blow, routes through _killPlayer so death/tombstone/respawn happen in
	// exactly one place. Returns true if the hit was fatal. `opts.byName` (and
	// `opts.by`) label the cause for the death notice.
	_damagePlayer(p, amount, opts = {}) {
		if (!p || p.dead) return false;
		const dmg = Math.max(0, Math.floor(amount));
		if (dmg <= 0) return false;
		p.hp = Math.max(0, p.hp - dmg);
		p.tsServer = Date.now();
		if (p.hp === 0) {
			this._killPlayer(p, opts);
			return true;
		}
		return false;
	}

	// Kill a player: freeze them, schedule a respawn, and — only in a danger
	// realm — spill the droppable part of their pack into a tombstone on the tile
	// they fell. Idempotent: a second call on an already-dead player is a no-op.
	_killPlayer(p, opts = {}) {
		if (!p || p.dead) return;
		const now = Date.now();
		p.dead = true;
		// Task 09: auto-dismount on death — no keeping the saddle through a respawn.
		if (p.mounted) { p.mounted = false; p.mount = ''; }
		p.motion = 'idle';
		p.hp = 0;
		p.respawnAt = now + RESPAWN_PLAYER_MS;

		let droppedCount = 0;
		if (this.realm.danger) droppedCount = this._dropTombstone(p, now);

		const client = this._clientFor(p.id);
		client?.send('died', {
			realm: this.realm.name,
			danger: !!this.realm.danger,
			respawnAt: p.respawnAt,
			dropped: droppedCount,
			byName: opts.byName || '',
		});
		p.tsServer = now;
	}

	// Drop rule (deterministic & fair): you KEEP your tools (axe/pickaxe/rod/
	// hammer/sword) wherever they sit — losing the means to recover would be
	// punishing and grief-prone — and you DROP everything else (gathered
	// resources, food, and any other non-tool item) from BOTH the backpack and
	// the hotbar into the bag. Gold is a currency, not an inventory item, so it
	// is never dropped. Returns the number of slots that landed in the tombstone.
	_dropTombstone(p, now) {
		const tomb = new Tombstone();
		tomb.id = `tomb_${this.realm.name}_${p.id}_${++this._tombSeq}`;
		tomb.owner = p.id;
		tomb.ownerName = p.name;
		tomb.tx = p.tx;
		tomb.ty = p.ty;
		tomb.expiresAt = now + TOMBSTONE_TTL_MS;

		for (const slot of [...p.inv, ...p.hotbar]) {
			if (!slot.item || TOOLS.has(slot.item)) continue;
			tomb.items.push(new Slot(slot.item, slot.qty));
			slot.item = '';
			slot.qty = 0;
		}

		if (tomb.items.length === 0) return 0; // nothing droppable — no empty bag
		this.state.tombstones.set(tomb.id, tomb);
		return tomb.items.length;
	}

	// Recover a tombstone's contents. Must be adjacent. Ownership holds for the
	// first part of the bag's life; once inside the final grace window before
	// expiry, anyone adjacent may loot. Items flow back through _addItem so a full
	// pack leaves the remainder in the bag (no duplication, no loss). An emptied
	// bag is removed immediately.
	_handleTombLoot(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p || p.dead) return;
		if (!this._rateOk(client.sessionId, 'ui')) return;
		const tomb = this.state.tombstones.get(String(payload?.id ?? ''));
		if (!tomb) return;

		if (!this._adjacent(p, tomb)) {
			client.send('notice', { kind: 'tomb', text: 'Walk up to the bag to loot it.' });
			return;
		}

		const now = Date.now();
		const isOwner = tomb.owner === p.id;
		const isPublic = now > tomb.expiresAt - TOMBSTONE_GRACE_MS;
		if (!isOwner && !isPublic) {
			client.send('notice', { kind: 'tomb', text: `This bag belongs to ${tomb.ownerName || 'someone'}.` });
			return;
		}

		// Pull each slot back into the pack; whatever doesn't fit stays in the bag.
		let taken = 0;
		for (const s of tomb.items) {
			if (!s.item || s.qty <= 0) continue;
			const before = s.qty;
			const leftover = this._addItem(p, s.item, s.qty);
			taken += before - leftover;
			s.qty = leftover;
			if (leftover === 0) s.item = '';
		}

		// Compact emptied slots; remove the bag entirely once nothing remains.
		for (let i = tomb.items.length - 1; i >= 0; i--) {
			if (!tomb.items[i].item) tomb.items.splice(i, 1);
		}
		if (tomb.items.length === 0) {
			this.state.tombstones.delete(tomb.id);
			client.send('notice', { kind: 'tomb', text: isOwner ? 'Recovered your belongings.' : 'Looted the bag.' });
		} else if (taken > 0) {
			client.send('notice', { kind: 'full', text: 'Pack full — some items remain in the bag.' });
		} else {
			client.send('notice', { kind: 'full', text: 'Your pack is full.' });
		}
		p.tsServer = now;
	}

	_clientFor(sessionId) {
		return this.clients?.find?.((c) => c.sessionId === sessionId) || null;
	}

	// ----- quests: tutorial + dailies --------------------------------------

	// Talk to a fixed NPC. Validates the player stands adjacent to it, advances a
	// tutorial 'talk' step if that's what's next, and replies with a fresh quest
	// snapshot (the guide's current line travels in it) flagged so the client
	// opens the dialog.
	_handleNpcTalk(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p || p.dead) return;
		if (!this._rateOk(client.sessionId, 'ui')) return;
		const npc = (this.realm.npcs || []).find((n) => n.id === String(payload?.id ?? ''));
		if (!npc) return;
		if (!this._adjacent(p, npc)) {
			client.send('notice', { kind: 'npc', text: `Walk up to ${npc.name} to talk.` });
			return;
		}
		// A talk only advances the tutorial when the next step IS a talk step;
		// otherwise it just opens the dialog (the snapshot already carries the line).
		this._questProgress(client, { kind: 'talk', n: 1 });
		this._sendQuests(client, { npc: npc.id });
	}

	// Drive all quest progress from a real, server-validated action. `ev` is
	// { kind, item?, n }. Advances the current tutorial step when it matches, and
	// every matching un-claimed daily. Persists + re-sends the snapshot on change.
	// Progress NEVER originates from a client claim — only from these hooks.
	_questProgress(client, ev) {
		const priv = this.priv.get(client.sessionId);
		const p = this.state.players.get(client.sessionId);
		if (!priv || !p || !priv.quests) return;
		const now = Date.now();
		const qs = normalizeQuestState(priv.quests, priv.playerId, now);
		const n = Math.max(1, ev.n | 0 || 1);
		let changed = false;

		// --- tutorial: only the current step, only if its kind (and item) match ---
		const step = currentStep(qs);
		if (step && step.kind === ev.kind && (step.item ? step.item === ev.item : true)) {
			qs.tutorial.progress = Math.min(step.count, qs.tutorial.progress + n);
			changed = true;
			if (qs.tutorial.progress >= step.count) {
				qs.tutorial.step += 1;
				qs.tutorial.progress = 0;
				if (qs.tutorial.step >= TUTORIAL_STEPS.length) {
					qs.tutorial.done = true;
					this._grantQuestReward(client, p, qs, TUTORIAL_REWARD, 'Training complete');
				} else {
					const next = TUTORIAL_STEPS[qs.tutorial.step];
					client.send('notice', { kind: 'quest', text: `Next: ${next.title}.` });
				}
			}
		}

		// --- dailies: every matching un-claimed quest advances together ---
		if (ev.kind === 'gather' || ev.kind === 'combat' || ev.kind === 'fish' || ev.kind === 'cook' || ev.kind === 'build') {
			for (const q of qs.daily.quests) {
				if (q.claimed) continue;
				const def = dailyDef(q.id);
				if (!def || def.type !== ev.kind) continue;
				if (def.item && def.item !== ev.item) continue;
				const before = q.progress;
				q.progress = Math.min(def.count, q.progress + n);
				if (q.progress !== before) {
					changed = true;
					if (before < def.count && q.progress >= def.count) {
						client.send('notice', { kind: 'quest', text: `Daily ready: ${def.title} — turn it in for your reward.` });
					}
				}
			}
		}

		if (changed) {
			p.badges = (qs.badges || []).join(',');
			this._persistPlayer(client.sessionId);
			this._sendQuests(client);
		}
	}

	// Claim a finished daily. Server-authoritative: refuses unless the TRACKED
	// progress meets the target and it isn't already claimed — a forged turn-in
	// for an unfinished quest does nothing. Awards 'devoted' once the whole board
	// is cleared for the day.
	_handleTurnIn(client, payload) {
		const p = this.state.players.get(client.sessionId);
		const priv = this.priv.get(client.sessionId);
		if (!p || !priv || !priv.quests) return;
		if (!this._rateOk(client.sessionId, 'ui')) return;
		const qs = normalizeQuestState(priv.quests, priv.playerId, Date.now());
		const q = qs.daily.quests.find((x) => x.id === String(payload?.id ?? ''));
		const def = q && dailyDef(q.id);
		if (!q || !def) return;
		if (q.claimed) { this._sendQuests(client); return; }
		if (q.progress < def.count) {
			client.send('notice', { kind: 'quest', text: `${def.title} isn't finished yet.` });
			return;
		}
		q.claimed = true;
		this._grantQuestReward(client, p, qs, def.reward, def.title);
		if (qs.daily.quests.every((x) => x.claimed)) this._awardBadge(client, p, qs, 'devoted');
		p.badges = (qs.badges || []).join(',');
		this._persistPlayer(client.sessionId);
		this._sendQuests(client);
	}

	// Apply a reward bundle (gold / XP / item / badge) and announce it. An item
	// reward that doesn't fit the pack spills into the bank so a reward is never
	// silently lost.
	_grantQuestReward(client, p, qs, reward, label) {
		if (!reward) return;
		const bits = [];
		if (reward.gold) { p.gold = Math.min(0xffffffff, p.gold + reward.gold); bits.push(`+${reward.gold}g`); }
		if (reward.xp) {
			for (const [skill, amt] of Object.entries(reward.xp)) {
				this._grantXp(client, p, skill, amt);
				bits.push(`+${amt} ${skill} xp`);
			}
		}
		if (reward.item) {
			const left = this._addItem(p, reward.item.id, reward.item.qty);
			if (left > 0) this._bankAdd(this.priv.get(client.sessionId).bank, reward.item.id, left);
			bits.push(`+${reward.item.qty} ${reward.item.id}`);
		}
		if (reward.badge) this._awardBadge(client, p, qs, reward.badge);
		if (bits.length) client.send('notice', { kind: 'reward', text: `${label}: ${bits.join(', ')}.` });
	}

	_awardBadge(client, p, qs, id) {
		if (!BADGES[id] || qs.badges.includes(id)) return;
		qs.badges.push(id);
		p.badges = qs.badges.join(',');
		client.send('notice', { kind: 'badge', text: `Badge earned: ${BADGES[id].icon} ${BADGES[id].label}.` });
	}

	// Send the requesting player their full quest snapshot: tutorial step (or
	// done), today's dailies with live progress + reward previews, the next-reset
	// timestamp for a real countdown, earned badges, and the guide's current line.
	// `opts.npc` set => the client opens the NPC dialog on this snapshot.
	_sendQuests(client, opts = {}) {
		const p = this.state.players.get(client.sessionId);
		const priv = this.priv.get(client.sessionId);
		if (!p || !priv || !priv.quests) return;
		const now = Date.now();
		const qs = normalizeQuestState(priv.quests, priv.playerId, now);
		const badgeStr = (qs.badges || []).join(',');
		if (p.badges !== badgeStr) p.badges = badgeStr; // keep the synced field honest

		const step = currentStep(qs);
		const tutorial = qs.tutorial.done
			? { done: true, total: TUTORIAL_STEPS.length }
			: {
				done: false,
				stepIndex: qs.tutorial.step,
				total: TUTORIAL_STEPS.length,
				progress: qs.tutorial.progress,
				step: step && {
					id: step.id, kind: step.kind, count: step.count, item: step.item || '',
					slot: typeof step.slot === 'number' ? step.slot : -1, title: step.title, desc: step.desc,
				},
			};

		const daily = {
			date: qs.daily.date,
			resetAt: nextResetAt(now),
			quests: qs.daily.quests.map((q) => {
				const def = dailyDef(q.id) || {};
				return {
					id: q.id, type: def.type, item: def.item || '', count: def.count || 0,
					title: def.title || q.id, desc: def.desc || '',
					progress: Math.min(q.progress, def.count || q.progress), claimed: !!q.claimed,
					reward: this._rewardPreview(def.reward),
				};
			}),
		};

		const badges = (qs.badges || []).map((id) => BADGES[id]).filter(Boolean);
		const guide = qs.tutorial.done ? GUIDE_DONE : (step?.guide || '');

		client.send('quests', { tutorial, daily, badges, guide, npc: opts.npc || '' });
	}

	// Compact, client-renderable reward summary (no server-only detail).
	_rewardPreview(reward) {
		if (!reward) return {};
		const out = {};
		if (reward.gold) out.gold = reward.gold;
		if (reward.xp) out.xp = reward.xp;
		if (reward.item) out.item = { id: reward.item.id, qty: reward.item.qty };
		if (reward.badge && BADGES[reward.badge]) {
			out.badge = { id: reward.badge, icon: BADGES[reward.badge].icon, label: BADGES[reward.badge].label };
		}
		return out;
	}

	// Persist the player's cross-session state through the Task 16 save interface,
	// keyed by the stable account id. Read-merge-write so we only ever own the
	// slices we manage (quests, gold, cosmetics) and never clobber other fields a
	// future system persists. Gold + owned/equipped cosmetics ride here so a
	// purchase and the look the player chose survive a disconnect/realm transfer.
	_persistPlayer(sessionId) {
		const priv = this.priv.get(sessionId);
		if (!priv || !priv.playerId) return;
		const p = this.state.players.get(sessionId);
		const prev = loadPlayer(priv.playerId) || {};
		const next = { ...prev };
		if (priv.quests) next.quests = priv.quests;
		if (p) {
			next.gold = p.gold;
			next.name = p.name;
			// Full account-scoped profile (Task 16/23): inventory, hotbar, bank,
			// skills, mount, and avatar URL so the same account loads identical
			// progression on any world instance.
			next.profile = this._serializeProfile(p, priv);
			// Last realm + tile — so a reconnecting player resumes in place rather
			// than waking at the fountain. Danger-realm positions are still saved;
			// onJoin skips restoring them so the player spawns safely instead.
			next.lastRealm = this.realm.name;
			next.lastTx = p.tx;
			next.lastTy = p.ty;
			// Placed structures (Task 07) keyed by realm so a shack in Whisperwood
			// and a firepit in Mainland both survive. Each realm's list overwrites the
			// previous save for that realm only; structures in other realms are unchanged.
			const myStructures = [];
			for (const [, s] of this.state.structures) {
				if (this._ownedBy(s, priv.playerId)) {
					myStructures.push({ kind: s.kind, tx: s.tx, ty: s.ty, expiresAt: s.expiresAt, locked: s.locked });
				}
			}
			next.structures = { ...(prev.structures || {}), [this.realm.name]: myStructures };
		}
		if (priv.cosmetics) {
			next.cosmetics = { owned: [...priv.cosmetics.owned], equipped: priv.cosmetics.equipped };
		}
		if (priv.spin) next.spin = { nextFreeSpinAt: priv.spin.nextFreeSpinAt || 0 };
		savePlayer(priv.playerId, next);
	}

	// ----- cosmetics shop (Task 21) ----------------------------------------

	// Rebuild a player's owned/equipped cosmetics from a persisted save, dropping
	// any id no longer in the catalogue (so a removed cosmetic never lingers) and
	// guaranteeing the equipped id is one the player actually owns.
	_loadCosmetics(saved) {
		const ownedIds = Array.isArray(saved?.cosmetics?.owned) ? saved.cosmetics.owned : [];
		const owned = new Set(ownedIds.filter((id) => cosmeticById(id)));
		const wanted = saved?.cosmetics?.equipped || '';
		const equipped = owned.has(wanted) ? wanted : '';
		return { owned, equipped };
	}

	// Send the requesting player the live shop board: the full catalogue, which
	// ids are on sale right now (split daily/weekly/always), the next-rotation
	// timestamps for real countdowns, the ids they already own, their equipped id,
	// and their current gold. Everything the shop + wardrobe render from.
	// Client 'shopOpen' request — rate-limited like any UI fetch, then emits the
	// board. The post-mutation refreshes (after buy/equip/unequip) go through
	// _emitShop directly: they are server-initiated, not client requests, so they
	// must never be dropped by the rate limiter or the UI would show stale state.
	_sendShop(client) {
		if (!this._rateOk(client.sessionId, 'ui')) return;
		this._emitShop(client);
	}

	_emitShop(client) {
		const p = this.state.players.get(client.sessionId);
		const priv = this.priv.get(client.sessionId);
		if (!p || !priv || !priv.cosmetics) return;
		client.send('shop', {
			offers: currentOffers(Date.now()),
			owned: [...priv.cosmetics.owned],
			equipped: priv.cosmetics.equipped,
			gold: p.gold,
		});
	}

	// Buy a cosmetic: it must exist, be on sale in the current rotation, not be
	// already owned, and the player must have the gold. On success we debit gold,
	// grant permanent ownership, persist, and refresh the board. Every failure
	// path returns a clear notice instead of silently no-op'ing.
	_handleBuyCosmetic(client, payload) {
		const p = this.state.players.get(client.sessionId);
		const priv = this.priv.get(client.sessionId);
		if (!p || !priv || !priv.cosmetics) return;
		if (!this._rateOk(client.sessionId, 'ui')) return;
		const id = String(payload?.id ?? '');
		const cosmetic = cosmeticById(id);
		if (!cosmetic) { client.send('notice', { kind: 'shop', text: 'That cosmetic doesn’t exist.' }); return; }
		if (priv.cosmetics.owned.has(id)) {
			client.send('notice', { kind: 'shop', text: `You already own the ${cosmetic.name}.` });
			return;
		}
		if (!isOffered(id, Date.now())) {
			client.send('notice', { kind: 'shop', text: `The ${cosmetic.name} isn’t on sale right now.` });
			return;
		}
		if (p.gold < cosmetic.price) {
			client.send('notice', { kind: 'shop', text: `Need ${cosmetic.price - p.gold} more gold for the ${cosmetic.name}.` });
			return;
		}
		p.gold -= cosmetic.price;
		priv.cosmetics.owned.add(id);
		p.tsServer = Date.now();
		this._persistPlayer(client.sessionId);
		client.send('notice', { kind: 'shop', text: `Bought the ${cosmetic.name}!` });
		this._emitShop(client);
	}

	// Equip an owned cosmetic — sets the synced cosmeticId so every peer renders
	// the new look, persists the choice, and refreshes the board. Equipping is
	// purely visual: it never touches gold, stats, inventory, or any gameplay
	// value. You can only equip a cosmetic you actually own.
	_handleEquipCosmetic(client, payload) {
		const p = this.state.players.get(client.sessionId);
		const priv = this.priv.get(client.sessionId);
		if (!p || !priv || !priv.cosmetics) return;
		if (!this._rateOk(client.sessionId, 'ui')) return;
		const id = String(payload?.id ?? '');
		if (!priv.cosmetics.owned.has(id)) {
			client.send('notice', { kind: 'shop', text: 'You don’t own that cosmetic.' });
			return;
		}
		if (priv.cosmetics.equipped === id) return;
		priv.cosmetics.equipped = id;
		p.cosmeticId = id;
		p.tsServer = Date.now();
		this._persistPlayer(client.sessionId);
		client.send('notice', { kind: 'shop', text: `Equipped the ${cosmeticById(id)?.name || 'cosmetic'}.` });
		this._emitShop(client);
	}

	// Revert to the default look — clears the equipped cosmetic. Always allowed
	// (no-op if nothing is equipped) and, like equipping, strictly visual.
	_handleUnequipCosmetic(client) {
		const p = this.state.players.get(client.sessionId);
		const priv = this.priv.get(client.sessionId);
		if (!p || !priv || !priv.cosmetics) return;
		if (!this._rateOk(client.sessionId, 'ui')) return;
		if (!priv.cosmetics.equipped) return;
		priv.cosmetics.equipped = '';
		p.cosmeticId = '';
		p.tsServer = Date.now();
		this._persistPlayer(client.sessionId);
		client.send('notice', { kind: 'shop', text: 'Reverted to your default look.' });
		this._emitShop(client);
	}

	// ----- marketplace (Task 20) -------------------------------------------
	//
	// A global, account-scoped player-to-player market backed by marketplaceStore
	// (durable, process-wide) so a buyer in any realm can purchase goods a seller
	// listed from anywhere. Two listing types:
	//   • gold          — an item stack for in-game gold; seller gets the full
	//                      amount, no fee. Buyer pays gold, receives the item.
	//   • goldForToken  — in-game gold priced in USD, paid on-chain with $THREE.
	//                      95% of the token goes to the seller's wallet, 5% to the
	//                      treasury; the buyer receives the escrowed gold once the
	//                      payment is verified on-chain.
	// The offered goods are escrowed on the listing the moment it's created — they
	// leave the seller's inventory/purse immediately — so nothing can be listed and
	// spent twice. Cancel returns the escrow; a sale delivers it to the buyer.

	// Send the requesting player the live market board: every active listing, their
	// own listings (any status), and the token-payment capability flags the Sell
	// tab needs to decide whether goldForToken listings are offerable.
	_sendMarket(client) {
		const priv = this.priv.get(client.sessionId);
		if (!priv) return;
		if (!this._rateOk(client.sessionId, 'ui')) return;
		const me = priv.playerId;
		client.send('market', {
			listings: marketplaceStore.activeListings().map((l) => this._marketView(l, me)),
			mine: marketplaceStore.listingsBySeller(me).map((l) => this._marketView(l, me)),
			token: { enabled: tokenConfigured(), symbol: TOKEN_SYMBOL, decimals: TOKEN_DECIMALS, treasuryBps: MARKET_TREASURY_BPS },
			canToken: isWalletAddress(me),
		});
	}

	// A client-safe projection of a listing. The seller's account id is never sent —
	// only their display name — and `mine` lets the UI badge/disable a viewer's own
	// listings on the Buy tab.
	_marketView(l, viewerId) {
		const v = {
			id: l.id,
			type: l.type,
			seller: l.sellerName || 'Trader',
			mine: l.seller === viewerId,
			status: l.status,
			createdAt: l.createdAt,
		};
		if (l.type === 'gold') { v.item = l.item; v.qty = l.qty; v.priceGold = l.priceGold; }
		else { v.goldAmount = l.goldAmount; v.priceUsd = l.priceUsd; }
		if (l.status !== 'active') { v.buyer = l.buyerName || null; v.closedAt = l.closedAt || null; }
		return v;
	}

	// Create a listing, escrowing the offered goods out of the seller immediately.
	_handleMarketList(client, payload) {
		const p = this.state.players.get(client.sessionId);
		const priv = this.priv.get(client.sessionId);
		if (!p || !priv) return;
		if (!this._rateOk(client.sessionId, 'mkt')) return;
		const type = payload?.type === 'goldForToken' ? 'goldForToken' : 'gold';

		const activeCount = marketplaceStore.listingsBySeller(priv.playerId).filter((l) => l.status === 'active').length;
		if (activeCount >= MAX_LISTINGS_PER_SELLER) {
			client.send('notice', { kind: 'market', text: `You can have at most ${MAX_LISTINGS_PER_SELLER} active listings.` });
			return;
		}

		if (type === 'gold') {
			const item = typeof payload?.item === 'string' ? payload.item : '';
			const qty = Math.max(1, Math.min(MAX_STACK, payload?.qty | 0));
			const priceGold = Math.max(1, Math.min(MARKET_GOLD_MAX, payload?.priceGold | 0));
			if (!item || !Number.isFinite(payload?.qty) || !Number.isFinite(payload?.priceGold)) {
				client.send('notice', { kind: 'market', text: 'Pick an item, amount, and price.' });
				return;
			}
			// Escrow: pull the exact quantity out of the backpack. If the player doesn't
			// actually hold it, _removeInvItem returns what it could remove — we restore
			// it and refuse, so a listing can never escrow goods that weren't there.
			const removed = this._removeInvItem(p, item, qty);
			if (removed < qty) {
				if (removed > 0) this._addItem(p, item, removed); // put back the partial pull
				client.send('notice', { kind: 'market', text: `You don't have ${qty} ${itemLabel(item)} to list.` });
				return;
			}
			const rec = marketplaceStore.create({
				seller: priv.playerId, sellerName: p.name, type: 'gold',
				item, qty, priceGold,
			});
			p.tsServer = Date.now();
			this._persistPlayer(client.sessionId);
			client.send('notice', { kind: 'market', text: `Listed ${qty}× ${itemLabel(item)} for ${priceGold} gold.` });
			this._broadcastMarketDirty();
			this._sendMarket(client);
			return;
		}

		// goldForToken — list in-game gold priced in USD, settled on-chain in $THREE.
		if (!tokenConfigured()) {
			client.send('notice', { kind: 'market', text: 'Token sales are unavailable right now.' });
			return;
		}
		if (!isWalletAddress(priv.playerId)) {
			client.send('notice', { kind: 'market', text: 'Connect a wallet to sell gold for tokens.' });
			return;
		}
		const goldAmount = Math.max(1, Math.min(MARKET_GOLD_MAX, payload?.goldAmount | 0));
		const priceUsd = Number(payload?.priceUsd);
		if (!Number.isFinite(payload?.goldAmount) || !Number.isFinite(priceUsd) || priceUsd < MARKET_USD_MIN || priceUsd > MARKET_USD_MAX) {
			client.send('notice', { kind: 'market', text: `Set a gold amount and a USD price ($${MARKET_USD_MIN}–$${MARKET_USD_MAX}).` });
			return;
		}
		if (p.gold < goldAmount) {
			client.send('notice', { kind: 'market', text: `You only have ${p.gold} gold to list.` });
			return;
		}
		// Escrow the gold out of the purse now.
		p.gold -= goldAmount;
		const rec = marketplaceStore.create({
			seller: priv.playerId, sellerName: p.name, type: 'goldForToken',
			goldAmount, priceUsd: Math.round(priceUsd * 100) / 100, sellerWallet: priv.playerId,
		});
		p.tsServer = Date.now();
		this._persistPlayer(client.sessionId);
		client.send('notice', { kind: 'market', text: `Listed ${goldAmount} gold for $${rec.priceUsd} in ${TOKEN_SYMBOL}.` });
		this._broadcastMarketDirty();
		this._sendMarket(client);
	}

	// Cancel a listing you own and reclaim the escrow. Active listings only.
	_handleMarketCancel(client, payload) {
		const p = this.state.players.get(client.sessionId);
		const priv = this.priv.get(client.sessionId);
		if (!p || !priv) return;
		if (!this._rateOk(client.sessionId, 'mkt')) return;
		const l = marketplaceStore.get(String(payload?.id ?? ''));
		if (!l || l.seller !== priv.playerId) { client.send('notice', { kind: 'market', text: 'Listing not found.' }); return; }
		if (l.status !== 'active') { client.send('notice', { kind: 'market', text: 'That listing is no longer active.' }); return; }

		marketplaceStore.update(l.id, { status: 'cancelled', closedAt: Date.now() });
		if (l.type === 'gold') {
			this._deliverItemsTo(p, priv, l.item, l.qty);
			client.send('notice', { kind: 'market', text: `Cancelled — ${l.qty}× ${itemLabel(l.item)} returned.` });
		} else {
			p.gold = Math.min(MARKET_GOLD_MAX, p.gold + l.goldAmount);
			client.send('notice', { kind: 'market', text: `Cancelled — ${l.goldAmount} gold returned.` });
		}
		p.tsServer = Date.now();
		this._persistPlayer(client.sessionId);
		this._broadcastMarketDirty();
		this._sendMarket(client);
	}

	// Buy a gold listing with in-game gold: debit the buyer, deliver the escrowed
	// item, and credit the seller the full price (no fee). Synchronous, so the
	// check-and-claim is atomic — two buyers can't both win the same listing.
	_handleMarketBuyGold(client, payload) {
		const p = this.state.players.get(client.sessionId);
		const priv = this.priv.get(client.sessionId);
		if (!p || !priv) return;
		if (!this._rateOk(client.sessionId, 'mkt')) return;
		const l = marketplaceStore.get(String(payload?.id ?? ''));
		if (!l || l.type !== 'gold') { client.send('notice', { kind: 'market', text: 'Listing not found.' }); return; }
		if (l.status !== 'active') { client.send('notice', { kind: 'market', text: 'That listing was just taken.' }); return; }
		if (l.seller === priv.playerId) { client.send('notice', { kind: 'market', text: "You can't buy your own listing." }); return; }
		if (p.gold < l.priceGold) {
			client.send('notice', { kind: 'market', text: `Need ${l.priceGold - p.gold} more gold.` });
			return;
		}
		// Claim the listing before mutating balances so a duplicate buy that slips in
		// finds it already sold.
		marketplaceStore.update(l.id, { status: 'sold', buyer: priv.playerId, buyerName: p.name, closedAt: Date.now() });
		p.gold -= l.priceGold;
		this._deliverItemsTo(p, priv, l.item, l.qty);
		// Pay the seller their gold wherever they are (or queue it durably if offline).
		this._payGoldTo(l.seller, l.priceGold, `Sold ${l.qty}× ${itemLabel(l.item)}`);
		p.tsServer = Date.now();
		this._persistPlayer(client.sessionId);
		client.send('notice', { kind: 'market', text: `Bought ${l.qty}× ${itemLabel(l.item)} for ${l.priceGold} gold.` });
		// Notify the seller immediately if they're online in ANY realm.
		this._notifySellerSold(l.seller, `${p.name} bought your ${l.qty}× ${itemLabel(l.item)} for ${l.priceGold} gold.`);
		this._broadcastMarketDirty();
		this._sendMarket(client);
	}

	// Step 1 of an on-chain token purchase: quote the live $THREE amount for the
	// listing's USD price, build the unsigned split transaction (95% seller wallet
	// / 5% treasury) the buyer signs, and hand back a signed quote that binds the
	// amounts + recipients so the client can't tamper before settling.
	async _handleMarketTokenQuote(client, payload) {
		const p = this.state.players.get(client.sessionId);
		const priv = this.priv.get(client.sessionId);
		if (!p || !priv) return;
		if (!this._rateOk(client.sessionId, 'mkt')) return;
		const id = String(payload?.id ?? '');
		// Every rejection clears the client's per-listing "Preparing…" spinner.
		const fail = (text) => { client.send('notice', { kind: 'market', text }); client.send('marketBuyFail', { id }); };
		if (!tokenConfigured()) { fail('Token payments are unavailable.'); return; }
		const buyerWallet = priv.playerId;
		if (!isWalletAddress(buyerWallet)) { fail('Connect a Solana wallet to pay with tokens.'); return; }
		const l = marketplaceStore.get(id);
		if (!l || l.type !== 'goldForToken' || l.status !== 'active') { fail('That listing is no longer available.'); return; }
		if (l.seller === buyerWallet) { fail("You can't buy your own listing."); return; }

		const quote = await quoteTokenForUsd(l.priceUsd);
		if (!quote) { fail('Live price unavailable — try again in a moment.'); return; }
		// Re-check the listing survived the awaited quote (it could have been bought
		// or cancelled while we fetched the price).
		const still = marketplaceStore.get(l.id);
		if (!still || still.status !== 'active') { fail('That listing is no longer available.'); return; }

		const { seller: sellerRaw, treasury: treasuryRaw } = splitAmount(quote.raw, MARKET_TREASURY_BPS);
		let txB64;
		try {
			txB64 = await buildSplitTransaction({
				buyerWallet, sellerWallet: l.sellerWallet,
				sellerRaw: sellerRaw.toString(), treasuryRaw: treasuryRaw.toString(),
			});
		} catch (err) {
			console.warn('[market] build split tx failed:', err?.message);
			fail('Could not prepare the payment. Try again.');
			return;
		}
		const signed = signQuote({
			listingId: l.id, buyer: buyerWallet, sellerWallet: l.sellerWallet,
			usd: l.priceUsd, total: quote.raw.toString(), sellerRaw: sellerRaw.toString(), treasuryRaw: treasuryRaw.toString(),
		});
		client.send('marketQuote', {
			id: l.id,
			tx: txB64,
			quote: signed,
			symbol: TOKEN_SYMBOL,
			decimals: TOKEN_DECIMALS,
			tokenAmount: quote.raw.toString(),
			sellerAmount: sellerRaw.toString(),
			treasuryAmount: treasuryRaw.toString(),
			priceUsd: l.priceUsd,
			goldAmount: l.goldAmount,
			ttlMs: 90_000,
		});
	}

	// Step 2: the buyer has broadcast the signed transaction. Verify it on-chain
	// (both legs landed at the right destinations for the quoted amounts), then
	// release the escrowed gold to the buyer. The seller was paid directly in the
	// transaction. Goods are NEVER released before the payment verifies.
	async _handleMarketTokenSettle(client, payload) {
		const p = this.state.players.get(client.sessionId);
		const priv = this.priv.get(client.sessionId);
		if (!p || !priv) return;
		if (!this._rateOk(client.sessionId, 'mkt')) return;
		const q = verifyQuote(payload?.quote);
		const failId = q?.listingId || String(payload?.id ?? '');
		const fail = (text) => { client.send('notice', { kind: 'market', text }); client.send('marketBuyFail', { id: failId }); };
		if (!q) { fail('Your quote expired — get a fresh one.'); return; }
		if (q.buyer !== priv.playerId) { fail('That quote was issued to a different wallet.'); return; }
		const txSig = typeof payload?.txSig === 'string' ? payload.txSig.trim() : '';
		if (!txSig) { fail('Missing transaction signature.'); return; }
		if (marketplaceStore.isSettled(txSig)) { fail('That payment was already settled.'); return; }

		const l = marketplaceStore.get(q.listingId);
		if (!l || l.type !== 'goldForToken' || l.sellerWallet !== q.sellerWallet) { fail('That listing is no longer available.'); return; }
		if (l.status !== 'active') { fail('That listing is no longer available.'); return; }
		// Claim it synchronously before the async verify so a second settle can't
		// double-release the same gold. Reverted to active if verification fails.
		marketplaceStore.update(l.id, { status: 'settling' });

		const verify = await verifySplitPayment({
			txSig, sellerWallet: q.sellerWallet, sellerRaw: q.sellerRaw, treasuryRaw: q.treasuryRaw,
		});
		const current = marketplaceStore.get(l.id);
		if (!current || current.status !== 'settling') {
			// Cancelled/evicted out from under us mid-verify — don't release.
			fail('That listing is no longer available.');
			return;
		}
		if (!verify.ok) {
			marketplaceStore.update(l.id, { status: 'active' });
			const why = verify.reason === 'not_found' ? 'Payment not found on-chain yet — wait for confirmation and retry.'
				: verify.reason?.includes('underpaid') ? 'The payment amount did not match the quote.'
				: 'Could not verify the payment. No gold was released.';
			fail(why);
			return;
		}
		// Verified. Consume the signature, close the listing, deliver the gold.
		marketplaceStore.markSettled(txSig);
		marketplaceStore.update(l.id, { status: 'sold', buyer: priv.playerId, buyerName: p.name, txSig, closedAt: Date.now() });
		p.gold = Math.min(MARKET_GOLD_MAX, p.gold + l.goldAmount);
		p.tsServer = Date.now();
		this._persistPlayer(client.sessionId);
		client.send('marketSettled', { id: l.id, goldAmount: l.goldAmount, txSig });
		client.send('notice', { kind: 'market', text: `Paid — received ${l.goldAmount} gold.` });
		// Notify the seller that their listing sold and they were paid on-chain.
		this._notifySellerSold(l.seller, `Your ${l.goldAmount} gold listing sold to ${p.name} — ${TOKEN_SYMBOL} paid to your wallet.`);
		this._broadcastMarketDirty();
		this._sendMarket(client);
	}

	// ----- Wheel of Fortune (Task 19) --------------------------------------
	//
	// A 20-segment prize wheel by the Mainland casino. One free spin per account
	// every 12h, plus unlimited paid spins ($3 in $THREE, 50% burned / 50% to
	// treasury, settled on-chain). The SERVER rolls every outcome (spin-wheel.js);
	// the client only animates to the chosen segment. Spinning needs an average
	// skill level of SPIN_MIN_AVG_LEVEL and standing at the wheel.

	// True when the player stands on a tile adjacent (8-way) to the realm's wheel
	// landmark — the same "be at the counter" rule banking uses, so a client can't
	// spin from across the map.
	_atWheel(p) {
		const w = wheelLandmark(this.realm);
		return !!w && Math.abs(p.tx - w.tx) <= 1 && Math.abs(p.ty - w.ty) <= 1;
	}

	// Full spin gate (free + paid prep): the realm has a wheel, the player is at
	// it, and their average level qualifies. Returns a reason code, or null when
	// allowed. The level gate can never regress (levels only climb), so settle
	// re-checks level only — a player who paid then got nudged off the tile still
	// gets their spin.
	_spinBlockReason(p) {
		if (!wheelLandmark(this.realm)) return 'no_wheel';
		if (!this._atWheel(p)) return 'not_at_wheel';
		if (this._averageLevel(p) < SPIN_MIN_AVG_LEVEL) return 'level';
		return null;
	}

	// Tell the client exactly why a spin was refused, always with the fields its
	// designed states need (current/required level, free-spin countdown).
	_sendSpinDenied(client, p, priv, mode, reason) {
		client.send('spinDenied', {
			mode,
			reason,
			avgLevel: Math.round(this._averageLevel(p) * 10) / 10,
			minLevel: SPIN_MIN_AVG_LEVEL,
			nextFreeSpinAt: priv.spin.nextFreeSpinAt || 0,
			now: Date.now(),
		});
	}

	// Snapshot for the spinner UI: the authoritative segment table (with honest
	// odds), the player's standing against the level gate, the free-spin countdown,
	// and whether a paid spin is available (token configured + wallet connected).
	_sendSpinInfo(client) {
		const p = this.state.players.get(client.sessionId);
		const priv = this.priv.get(client.sessionId);
		if (!p || !priv) return;
		if (!this._rateOk(client.sessionId, 'spin')) return;
		const avg = this._averageLevel(p);
		client.send('spinInfo', {
			segments: spinSegments(),
			avgLevel: Math.round(avg * 10) / 10,
			minLevel: SPIN_MIN_AVG_LEVEL,
			eligible: avg >= SPIN_MIN_AVG_LEVEL,
			atWheel: this._atWheel(p),
			nextFreeSpinAt: priv.spin.nextFreeSpinAt || 0,
			now: Date.now(),
			costUsd: PAID_SPIN_USD,
			symbol: TOKEN_SYMBOL,
			paidAvailable: tokenConfigured() && isWalletAddress(priv.playerId),
		});
	}

	// Roll one prize and grant it. Gold lands in the purse; items go to the
	// backpack and any overflow spills into a ground bag at the player's feet (the
	// same vessel mob loot uses), so a prize is never silently lost on a full pack.
	// Returns the server-decided segment + what actually landed for the client.
	_rollAndAward(client, p) {
		const roll = rollSpin();
		let awardedGold = 0, awardedQty = 0, overflow = 0;
		if (roll.kind === 'gold') {
			const before = p.gold;
			p.gold = Math.min(0xffffffff, p.gold + roll.gold);
			awardedGold = p.gold - before;
		} else {
			const left = this._addItem(p, roll.item, roll.qty);
			awardedQty = roll.qty - left;
			if (left > 0) { this._spawnLootBag(p, p.tx, p.ty, [new Slot(roll.item, left)]); overflow = left; }
		}
		p.tsServer = Date.now();
		const tail = overflow > 0 ? ` — ${overflow} waited in a bag at your feet (pack full)` : '';
		client.send('notice', { kind: 'spin', text: `The wheel landed on ${roll.label}!${tail}` });
		return {
			index: roll.index, kind: roll.kind, item: roll.item, qty: roll.qty, gold: roll.gold,
			label: roll.label, awardedGold, awardedQty, overflow,
		};
	}

	// Free spin: gated by level + wheel proximity + the persisted 12h cooldown.
	// The timer is consumed before the roll so the spin can't be repeated, and the
	// new nextFreeSpinAt is persisted + returned for the client's live countdown.
	_handleSpinFree(client) {
		const p = this.state.players.get(client.sessionId);
		const priv = this.priv.get(client.sessionId);
		if (!p || !priv) return;
		if (!this._rateOk(client.sessionId, 'spin')) return;
		const reason = this._spinBlockReason(p);
		if (reason) { this._sendSpinDenied(client, p, priv, 'free', reason); return; }
		const now = Date.now();
		if (now < (priv.spin.nextFreeSpinAt || 0)) {
			this._sendSpinDenied(client, p, priv, 'free', 'cooldown');
			return;
		}
		priv.spin.nextFreeSpinAt = now + FREE_SPIN_COOLDOWN_MS;
		const result = this._rollAndAward(client, p);
		this._persistPlayer(client.sessionId);
		client.send('spinResult', { mode: 'free', ...result, nextFreeSpinAt: priv.spin.nextFreeSpinAt, now: Date.now() });
	}

	// Paid spin, step 1: price $3 in $THREE, build the 50/50 burn/treasury split
	// transaction the wallet signs, and hand back a signed quote binding the
	// amounts + destinations. No prize is rolled here — only after the payment
	// verifies at settle. Gated identically to a free spin so an ineligible player
	// can't even start paying.
	async _handleSpinPaidPrep(client) {
		const p = this.state.players.get(client.sessionId);
		const priv = this.priv.get(client.sessionId);
		if (!p || !priv) return;
		if (!this._rateOk(client.sessionId, 'spin')) return;
		const reason = this._spinBlockReason(p);
		if (reason) { this._sendSpinDenied(client, p, priv, 'paid', reason); return; }
		if (!tokenConfigured()) { client.send('spinDenied', { mode: 'paid', reason: 'token_unavailable' }); return; }
		const buyerWallet = priv.playerId;
		if (!isWalletAddress(buyerWallet)) { client.send('spinDenied', { mode: 'paid', reason: 'no_wallet' }); return; }
		let prep;
		try {
			prep = await buildSpinPayment({ buyerWallet, usd: PAID_SPIN_USD });
		} catch (err) {
			console.warn('[spin] build payment failed:', err?.message);
			client.send('spinDenied', { mode: 'paid', reason: 'build_failed' });
			return;
		}
		if (!prep) { client.send('spinDenied', { mode: 'paid', reason: 'price_unavailable' }); return; }
		client.send('spinPrep', {
			tx: prep.txBase64,
			quote: prep.quoteToken,
			symbol: TOKEN_SYMBOL,
			decimals: TOKEN_DECIMALS,
			costUsd: PAID_SPIN_USD,
			tokenAmount: prep.quote.total,
			tokens: prep.quote.tokens,
			priceUsd: prep.quote.priceUsd,
			burnAmount: prep.quote.burnRaw,
			treasuryAmount: prep.quote.treasuryRaw,
			ttlMs: (prep.quote.ttlSeconds || 90) * 1000,
		});
	}

	// Paid spin, step 2: the wallet broadcast the signed transaction. Verify it
	// on-chain (both the burn and treasury legs landed, memo matches the quote),
	// reject replays, THEN roll + award. The free-spin timer is never touched.
	async _handleSpinPaidSettle(client, payload) {
		const p = this.state.players.get(client.sessionId);
		const priv = this.priv.get(client.sessionId);
		if (!p || !priv) return;
		if (!this._rateOk(client.sessionId, 'spin')) return;
		// Level can't regress mid-flow, so re-checking it (not wheel proximity) at
		// settle keeps a paid spin valid even if the player drifted off the tile
		// while approving in their wallet — they already committed real funds.
		if (this._averageLevel(p) < SPIN_MIN_AVG_LEVEL) { this._sendSpinDenied(client, p, priv, 'paid', 'level'); return; }
		const buyerWallet = priv.playerId;
		const txSig = typeof payload?.txSig === 'string' ? payload.txSig.trim() : '';
		if (!txSig) { client.send('spinDenied', { mode: 'paid', reason: 'no_signature' }); return; }
		// Atomically claim this signature before the async RPC round-trip. If two
		// concurrent settles of the same sig both reached here, only one gets true —
		// the other sees a reservation in flight and is rejected immediately, closing
		// the TOCTOU window that existed with a plain is-settled check + later mark.
		if (!reserveSpin(txSig)) {
			client.send('spinDenied', { mode: 'paid', reason: 'already_settled' });
			return;
		}

		const verify = await verifySpinPayment({ quoteToken: payload?.quote, txSig, buyerWallet });
		if (!verify.ok) {
			// Release the reservation so an honest retry (e.g. tx not yet confirmed)
			// can claim it later — the payment hasn't been spent and no prize was rolled.
			releaseSpin(txSig);
			const why = verify.reason === 'not_found' ? 'not_found'
				: verify.reason?.includes('underpaid') ? 'underpaid'
				: verify.reason === 'bad_quote' ? 'quote_expired'
				: 'verify_failed';
			client.send('spinDenied', { mode: 'paid', reason: why });
			return;
		}
		// Verification passed — permanently commit so this sig can never roll again,
		// then award. Order matters: commit first, award second, persist third.
		commitSpin(txSig);
		const result = this._rollAndAward(client, p);
		this._persistPlayer(client.sessionId);
		client.send('spinResult', { mode: 'paid', ...result, txSig, nextFreeSpinAt: priv.spin.nextFreeSpinAt || 0, now: Date.now() });
	}

	// Credit a seller their gold proceeds. If they're online (in this room or any
	// other), the durable payout we enqueue is drained immediately via a presence
	// nudge; if they're offline it waits in the queue until their next login. Either
	// way the queue is the single source of truth, so delivery is exactly-once.
	_payGoldTo(sellerId, gold, reason) {
		marketplaceStore.enqueuePayout(sellerId, { gold, reason });
		try { this.presence.publish(payoutChannel(sellerId), { ts: Date.now() }); } catch {}
		// Fast path: if the seller is in THIS room, draining now avoids a round-trip
		// through pub/sub (and covers presence backends that don't echo to the
		// publishing process).
		for (const [sid, pr] of this.priv) {
			if (pr.playerId === sellerId) { this._drainMarketPayouts(sid); break; }
		}
	}

	// Deliver all queued marketplace proceeds for a session's account: gold into the
	// purse, items into the backpack (overflow to the bank, then re-queued if even
	// the bank is full so nothing is ever lost). Atomic drain — whether triggered by
	// a login or a live nudge, each payout is applied exactly once.
	_drainMarketPayouts(sessionId) {
		const p = this.state.players.get(sessionId);
		const priv = this.priv.get(sessionId);
		if (!p || !priv) return;
		const payouts = marketplaceStore.drainPayouts(priv.playerId);
		if (!payouts.length) return;
		let goldGained = 0;
		const itemsGained = [];
		for (const po of payouts) {
			if (po.gold) {
				const before = p.gold;
				p.gold = Math.min(MARKET_GOLD_MAX, p.gold + (po.gold | 0));
				goldGained += p.gold - before;
			}
			if (Array.isArray(po.items)) {
				for (const it of po.items) {
					if (it && it.item && it.qty > 0) {
						// Use the no-nudge delivery so a bank-full re-queue doesn't loop.
						const left = this._stowItem(p, priv, it.item, it.qty);
						const placed = it.qty - left;
						if (placed > 0) itemsGained.push({ item: it.item, qty: placed });
						if (left > 0) marketplaceStore.enqueuePayout(priv.playerId, { items: [{ item: it.item, qty: left }], reason: 'overflow' });
					}
				}
			}
		}
		p.tsServer = Date.now();
		this._persistPlayer(sessionId);
		const c = this._clientFor(sessionId);
		if (c && (goldGained > 0 || itemsGained.length)) {
			c.send('marketPayout', { gold: goldGained, items: itemsGained });
		}
	}

	// Tell every client in this room their open market panel is stale so it
	// refetches. Cross-room/realm panels refresh on their own open + poll; this just
	// keeps same-room browsers live as listings appear and sell.
	_broadcastMarketDirty() {
		this.broadcast('marketDirty', {});
	}

	// Notify a seller that one of their listings sold. If they're in THIS room, send
	// the notice directly and push a fresh market board so "My Listings" updates live.
	// If they're in a different room, the pub/sub payout nudge already woke them up;
	// we additionally send a presence-channel notice so any realm can reach them.
	_notifySellerSold(sellerId, text) {
		if (!sellerId) return;
		// Try the fast path: seller is in this very room.
		for (const [sid, pr] of this.priv) {
			if (pr.playerId !== sellerId) continue;
			const c = this._clientFor(sid);
			if (c) {
				c.send('notice', { kind: 'market', text });
				this._sendMarket(c);
			}
			return;
		}
		// Seller is online in another realm — publish a cross-room notification.
		// The channel name mirrors evictChannel; the other room's payout subscriber
		// already wakes them for gold delivery. For token sales (no payout queue)
		// we publish on the payout channel anyway so they receive a notice toast.
		try { this.presence.publish(payoutChannel(sellerId), { ts: Date.now(), notice: text }); } catch {}
	}

	// ----- marketplace item helpers ----------------------------------------

	// Remove up to `qty` of `item` from the backpack, emptying slots as they drain.
	// Returns the quantity actually removed (< qty if the player didn't have enough).
	_removeInvItem(p, item, qty) {
		let need = qty;
		for (const s of p.inv) {
			if (need <= 0) break;
			if (s.item !== item) continue;
			const take = Math.min(s.qty, need);
			s.qty -= take;
			need -= take;
			if (s.qty <= 0) { s.item = ''; s.qty = 0; }
		}
		return qty - need;
	}

	// Place items into the backpack, overflowing to the bank, returning whatever
	// still didn't fit. No side effects beyond inventory/bank — used by the payout
	// drainer where re-queueing (not a nudge) handles a true overflow.
	_stowItem(p, priv, item, qty) {
		let left = this._addItem(p, item, qty);
		if (left > 0 && priv?.bank) left = this._bankAdd(priv.bank, item, left);
		return left;
	}

	// Deliver listing escrow back to a player on cancel / to a buyer on a gold sale:
	// backpack first, then bank, then a durable payout so a full inventory never
	// destroys the goods.
	_deliverItemsTo(p, priv, item, qty) {
		const left = this._stowItem(p, priv, item, qty);
		if (left > 0) {
			marketplaceStore.enqueuePayout(priv.playerId, { items: [{ item, qty: left }], reason: 'overflow' });
			const c = this._clientFor(p.id);
			if (c) c.send('notice', { kind: 'market', text: `${left}× ${itemLabel(item)} saved — your bags are full; claim it when you have room.` });
		}
	}

	// ----- inventory / hotbar ----------------------------------------------

	_handleInvMove(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p) return;
		if (!this._rateOk(client.sessionId, 'ui')) return;
		const from = this._resolveSlot(p, payload?.from);
		const to = this._resolveSlot(p, payload?.to);
		if (!from || !to) return;
		// Swap (or merge stacks of the same stackable item).
		const a = from.slot;
		const b = to.slot;
		if (a === b) return;
		if (a.item && a.item === b.item && STACKABLE.has(a.item)) {
			const room = MAX_STACK - b.qty;
			const moved = Math.min(room, a.qty);
			b.qty += moved;
			a.qty -= moved;
			if (a.qty === 0) a.item = '';
		} else {
			const ti = b.item, tq = b.qty;
			b.item = a.item; b.qty = a.qty;
			a.item = ti; a.qty = tq;
		}
		p.tsServer = Date.now();
	}

	_handleEquip(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p) return;
		if (!this._rateOk(client.sessionId, 'ui')) return;
		const i = payload?.slot | 0;
		if (i < -1 || i >= HOTBAR_SIZE) return;
		p.activeSlot = i;
		p.tsServer = Date.now();
	}

	// `ref` is { zone: 'inv'|'hotbar', i } — resolves to the live Slot object.
	_resolveSlot(p, ref) {
		if (!ref || typeof ref !== 'object') return null;
		const i = ref.i | 0;
		if (ref.zone === 'inv' && i >= 0 && i < INV_SIZE) return { slot: p.inv[i] };
		if (ref.zone === 'hotbar' && i >= 0 && i < HOTBAR_SIZE) return { slot: p.hotbar[i] };
		return null;
	}

	// ----- banking ---------------------------------------------------------

	_handleBank(client, payload, dir) {
		const p = this.state.players.get(client.sessionId);
		if (!p) return;
		if (!this._rateOk(client.sessionId, 'ui')) return;
		// Must be standing on a bank-counter tile.
		if (!this.realm.bankZone.some((t) => t.tx === p.tx && t.ty === p.ty)) {
			client.send('notice', { kind: 'bank', text: 'Stand at the bank counter to use storage.' });
			return;
		}
		const priv = this.priv.get(client.sessionId);
		const i = payload?.i | 0;
		const qty = Math.max(1, payload?.qty | 0 || 1);

		if (dir === 'deposit') {
			if (i < 0 || i >= INV_SIZE) return;
			const slot = p.inv[i];
			if (!slot.item) return;
			const move = Math.min(qty, slot.qty);
			const left = this._bankAdd(priv.bank, slot.item, move);
			const deposited = move - left;
			slot.qty -= deposited;
			if (slot.qty === 0) slot.item = '';
			// Tutorial: stashing an item teaches the bank. Only count a real deposit.
			if (deposited > 0) this._questProgress(client, { kind: 'bank', n: 1 });
		} else {
			if (i < 0 || i >= BANK_SIZE) return;
			const bslot = priv.bank[i];
			if (!bslot.item) return;
			const move = Math.min(qty, bslot.qty);
			const left = this._addItem(p, bslot.item, move);
			const withdrawn = move - left;
			bslot.qty -= withdrawn;
			if (bslot.qty === 0) bslot.item = '';
		}
		p.tsServer = Date.now();
		this._sendBank(client);
	}

	_sendBank(client) {
		const priv = this.priv.get(client.sessionId);
		if (!priv) return;
		client.send('bank', { slots: priv.bank });
	}

	// Swap avatar mid-session (e.g. a guest avatar finishing its background upload
	// on /play, or a player changing look without rejoining). Rate-limited as a UI
	// action and host-validated like the join-time avatar.
	_handleAvatar(client, payload) {
		const p = this.state.players.get(client.sessionId);
		if (!p) return;
		if (!this._rateOk(client.sessionId, 'ui')) return;
		const url = cleanAvatarUrl(payload?.avatar);
		if (url) p.cosmetic = url;
	}

	_bankAdd(bank, item, qty) {
		let left = qty;
		if (STACKABLE.has(item)) {
			for (const s of bank) {
				if (left <= 0) break;
				if (s.item === item && s.qty < MAX_STACK) {
					const room = MAX_STACK - s.qty;
					const m = Math.min(room, left);
					s.qty += m; left -= m;
				}
			}
		}
		while (left > 0) {
			const empty = bank.find((s) => !s.item);
			if (!empty) break;
			const m = STACKABLE.has(item) ? Math.min(MAX_STACK, left) : 1;
			empty.item = item; empty.qty = m; left -= m;
		}
		return left;
	}

	// ----- shared helpers --------------------------------------------------

	// Add an item to the player's backpack. Returns the leftover quantity that
	// didn't fit (0 means everything was stored).
	_addItem(p, item, qty) {
		let left = qty;
		if (STACKABLE.has(item)) {
			for (const s of p.inv) {
				if (left <= 0) break;
				if (s.item === item && s.qty < MAX_STACK) {
					const room = MAX_STACK - s.qty;
					const m = Math.min(room, left);
					s.qty += m; left -= m;
				}
			}
			while (left > 0) {
				const empty = p.inv.find((s) => !s.item);
				if (!empty) break;
				const m = Math.min(MAX_STACK, left);
				empty.item = item; empty.qty = m; left -= m;
			}
		} else {
			while (left > 0) {
				const empty = p.inv.find((s) => !s.item);
				if (!empty) break;
				empty.item = item; empty.qty = 1; left -= 1;
			}
		}
		return left;
	}

	_grantXp(client, p, skill, amount) {
		const priv = this.priv.get(client.sessionId);
		if (!priv) return;
		priv.xp[skill] = (priv.xp[skill] || 0) + amount;
		const xp = priv.xp[skill];
		const lvl = levelForXp(xp);
		// Tell the earner immediately: how much they got, their new cumulative XP,
		// and the current level boundaries so the client can delta-patch its bar
		// without a round-trip 'skills' request. Raw XP stays private (never in schema).
		const maxed = lvl >= LEVEL_CAP;
		client.send('xpgain', {
			skill,
			amount,
			xp,
			level: lvl,
			levelXp: xpForLevel(lvl),
			nextXp: maxed ? null : xpForLevel(lvl + 1),
		});
		// XP only accumulates, so a changed level is always a level-up.
		if (lvl > p[skill]) {
			p[skill] = lvl;
			client.send('levelup', { skill, level: lvl });
		}
	}

	// Reply to a 'skills' request with the requesting player's own XP detail: per
	// skill, the level plus the cumulative XP boundaries of the current level so
	// the client can draw an exact progress bar. Raw XP is never broadcast to
	// peers — it only ever travels back to its owner here.
	_sendSkills(client) {
		const p = this.state.players.get(client.sessionId);
		const priv = this.priv.get(client.sessionId);
		if (!p || !priv) return;
		const skills = {};
		for (const skill of SKILLS) {
			const level = p[skill];
			const xp = priv.xp[skill] || 0;
			const floorXp = xpForLevel(level);
			const maxed = level >= LEVEL_CAP;
			skills[skill] = {
				level,
				xp,
				levelXp: floorXp, // cumulative XP at the start of the current level
				nextXp: maxed ? null : xpForLevel(level + 1), // cumulative XP for next level
			};
		}
		client.send('skills', {
			cap: LEVEL_CAP,
			skills,
			total: this._totalLevel(p),
			average: this._averageLevel(p),
		});
	}

	// Authoritative average skill level — the mean of all five skill levels.
	// Returned precisely (a float) so callers choose their own rounding: a gate
	// can floor it (e.g. `Math.floor(avg) >= 20`) while the UI shows one decimal.
	// Reused by Task 19's spin gate and any future average-level content gate.
	_averageLevel(p) {
		return this._totalLevel(p) / SKILLS.length;
	}

	_totalLevel(p) {
		let sum = 0;
		for (const s of SKILLS) sum += p[s];
		return sum;
	}

	// Authoritative combat level — the input every combat-level gate reads (Task 11).
	// Combat is its own trainable skill here, so the combat level IS that level; the
	// helper keeps the gate logic from reaching into the schema field directly, so a
	// future composite combat formula can change in exactly one place.
	_combatLevel(p) {
		return p.combat;
	}

	// Does the player clear a portal's gate? Today the only gate kind is a combat
	// floor; an unknown/empty gate never blocks (fail-open on shape, never on level).
	_meetsGate(p, gate) {
		if (!gate) return true;
		if (Number.isFinite(gate.combat) && this._combatLevel(p) < gate.combat) return false;
		return true;
	}

	_adjacent(p, obj) {
		return Math.abs(p.tx - obj.tx) <= 1 && Math.abs(p.ty - obj.ty) <= 1;
	}

	_rateOk(sessionId, action) {
		const priv = this.priv.get(sessionId);
		if (!priv) return false;
		const limit = RATE_LIMITS[action] || 10;
		const now = Date.now();
		let bucket = priv.rate.get(action);
		if (!bucket || now - bucket.windowStart > 1000) {
			bucket = { windowStart: now, count: 0 };
			priv.rate.set(action, bucket);
		}
		bucket.count++;
		return bucket.count <= limit;
	}

	// ----- simulation tick -------------------------------------------------

	_tick() {
		const now = Date.now();

		// Periodic profile autosave (Task 16/23). Most saves ride real events
		// (quest progress, gold/cosmetic changes, portal/leave), but a player who
		// only fishes or cooks could go a while without one — so flush every live
		// session about every 20s. Cheap (a few small objects into the store) and it
		// bounds how much progress a hard crash could cost. The leave/eviction paths
		// still save synchronously for the common case.
		if (++this._saveTick >= 80) {
			this._saveTick = 0;
			for (const sid of this.priv.keys()) this._persistPlayer(sid);
		}

		// Resource + mob respawns.
		for (const [, n] of this.state.nodes) {
			if (n.depleted && now >= n.respawnAt) {
				n.depleted = false;
				n.respawnAt = 0;
			}
		}
		for (const [, m] of this.state.mobs) {
			if (m.dead && now >= m.respawnAt) {
				m.dead = false;
				m.hp = m.maxHp;
				m.respawnAt = 0;
			}
		}

		// Expire crumbled death-bags.
		for (const [id, t] of this.state.tombstones) {
			if (now >= t.expiresAt) this.state.tombstones.delete(id);
		}

		// Player-built structures (Task 07): decay first, so a firepit never heals on
		// the same tick it burns out, then collect the live firepits for the heal pass.
		const firepits = [];
		for (const [id, s] of this.state.structures) {
			if (s.expiresAt && now >= s.expiresAt) { this.state.structures.delete(id); continue; }
			if (s.kind === 'firepit') firepits.push(s);
		}

		// Player healing + respawn — keyed to THIS realm's spawn/fountain, plus any
		// player-built firepit a player is standing beside.
		const fountain = this.realm.fountain;
		for (const [, p] of this.state.players) {
			if (p.dead) {
				if (now >= p.respawnAt) {
					p.dead = false;
					p.hp = p.maxHp;
					p.motion = 'idle';
					p.tx = this.realm.spawn.tx;
					p.ty = this.realm.spawn.ty;
					p.tsServer = now;
				}
				continue;
			}
			if (p.hp < p.maxHp) {
				const nearFountain =
					!!fountain && Math.abs(p.tx - fountain.tx) <= 3 && Math.abs(p.ty - fountain.ty) <= 3;
				// A firepit heals players directly adjacent to it (8-way), at the
				// fountain's rate — a portable campfire heal.
				const nearFire = firepits.some((s) => Math.abs(p.tx - s.tx) <= 1 && Math.abs(p.ty - s.ty) <= 1);
				p.hp = Math.min(p.maxHp, p.hp + (nearFountain || nearFire ? FOUNTAIN_HEAL_PER_TICK : REGEN_PER_TICK));
			}
		}

		// Moving floor (Arena rollers): on its own slower cadence, shove every living
		// player who is standing on a roller one tile in the strip's direction. The
		// push is server-authoritative and respects walkability — it never moves a
		// player through a wall, onto a node/mob, off the map, or onto a portal tile
		// (rollers carry you around the floor; they never trigger a realm transfer).
		if (this.realm.rollers && now - (this._rollerAt || 0) >= ROLLER_PUSH_MS) {
			this._rollerAt = now;
			this._rollPlayers(now);
		}
	}

	// One roller push pass. Each player's destination is resolved against THIS
	// tick's occupancy, so two players can't be shoved onto the same tile in a way
	// that desyncs from walkability — the second simply isn't moved this push.
	_rollPlayers(now) {
		for (const [sid, p] of this.state.players) {
			if (p.dead) continue;
			if (this.priv.get(sid)?.transferring) continue;
			const roller = rollerAt(this.realm, p.tx, p.ty);
			if (!roller) continue;
			const [dx, dy] = rollerDelta(roller.dir);
			if (!dx && !dy) continue;
			const nx = p.tx + dx, ny = p.ty + dy;
			if (!this._isWalkable(nx, ny)) continue; // pushed against a wall/occupant — hold position
			if (portalAt(this.realm, nx, ny)) continue; // never roll a player through a portal
			p.tx = nx;
			p.ty = ny;
			p.motion = 'walk';
			p.tsServer = now;
		}
	}
}
