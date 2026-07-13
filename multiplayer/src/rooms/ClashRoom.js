// ClashRoom — the live arena for Coin Wars (community-vs-community battles).
//
// Two coin communities meet here. A fighter joins FOR the coin they hold (proven by
// the same holder pass that gates that coin's Holders world), is seated on that
// faction, and fights the other community in a shared 3D arena. The room is a thin
// validator-and-replicator over two pure cores:
//   • combat.js   — picks which enemy a swing lands on, from authoritative positions.
//   • clash.js    — the match: friendly-fire rules, kill scoring, respawns, the round
//                   clock, sudden death, and the final result.
// Neither core touches the network or the schema, so the rules are unit-tested in
// isolation (tests/clash-match.test.js); this file just feeds them validated input
// and mirrors their state onto the wire.
//
// Matchmaking: rooms are defined with filterBy(['matchKey']) so every fighter who
// passes the same matchKey lands in the same arena instance — the /wars lobby mints a
// matchKey for a challenge and hands it to both communities.

import { Room } from '@colyseus/core';
import { ClashState, ClashFighter } from '../clash-schemas.js';
import { ClashMatch, ClashPhase, CLASH_DEFAULTS } from '../clash.js';
import { selectTarget } from '../combat.js';
import { verifyHolderPass } from '../holder-pass.js';
import { verifyPlayPass } from '../play-pass.js';
import { installUnknownMessageGuard } from '../room-compat.js';
import { cleanAvatarUrl } from '../avatar-url.js';
import { reportBattle } from '../war-report.js';

const PLAY_GATE_MINT = (process.env.PLAY_GATE_MINT || process.env.THREE_MINT || '').trim();
const PLAY_GATE_MIN = Number(process.env.PLAY_GATE_MIN) > 0 ? Number(process.env.PLAY_GATE_MIN) : 1;

const MAX_CLIENTS = CLASH_DEFAULTS.maxPerTeam * 2;
const PATCH_RATE_MS = 1000 / 15;       // 15 Hz state deltas, like WalkRoom
const LOGIC_TICK_MS = 200;             // 5 Hz match logic (respawns, clock, phase)
const MOVE_RATE_HZ = 20;               // accepted moves/sec/client
const ATTACK_COOLDOWN_MS = 450;        // min time between a fighter's swings
const MAX_STEP_M = 3;                  // teleport reject (per accepted move)
const ARENA_BOUND_M = 60;              // square arena half-extent
const SPAWN_OFFSET = 22;               // each faction spawns this far up/down the z axis
const MOTION_VALUES = new Set(['idle', 'walk', 'run']);

// The arena weapon. Everyone fights with the same kit in v1 — a mid-range blaster —
// so a clash is decided by positioning and teamwork, not gear. Real game constant
// (not a placeholder): the same {kind,dmg,range,aimTol} shape combat.js expects.
const CLASH_WEAPON = Object.freeze({ kind: 'ranged', dmg: 34, range: 26, aimTol: 0.32 });

function clean(s, max = 64) {
	return typeof s === 'string' ? s.replace(/[\u0000-]/g, '').trim().slice(0, max) : '';
}
function pickColor(seed) {
	let h = 0;
	for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
	return h & 0xffffff;
}

export class ClashRoom extends Room {
	// Admission. The platform play gate (if a game token is pinned) applies exactly as
	// in WalkRoom. Then the fighter must prove they hold the coin they want to fight
	// for: a holder pass whose mint equals their declared `coin`. That single check is
	// what makes a clash a battle BETWEEN communities — you can only wear a community's
	// colours if you actually hold its coin. The faction must also be one of the two in
	// this match. Throw on refusal so the client routes back to its gate.
	static onAuth(client, options) {
		if (PLAY_GATE_MINT) {
			const pass = verifyPlayPass(options?.playPass);
			if (!pass) throw new Error('play_pass_required');
			if (pass.mint !== PLAY_GATE_MINT) throw new Error('play_pass_mismatch');
			if (!(typeof pass.balance === 'number' && pass.balance >= PLAY_GATE_MIN)) throw new Error('play_pass_required');
			client.userData = { ...(client.userData || {}), account: pass.wallet };
		}

		const coin = clean(options?.coin, 64);
		if (!coin) throw new Error('clash_faction_required');
		const holder = verifyHolderPass(options?.holderPass);
		if (!holder) throw new Error('holder_pass_required');
		if (holder.mint !== coin) throw new Error('holder_pass_mismatch');
		client.userData = { ...(client.userData || {}), account: holder.wallet, faction: coin };
		return true;
	}

	onCreate(options) {
		this.setState(new ClashState());
		this.setPatchRate(PATCH_RATE_MS);
		this.maxClients = MAX_CLIENTS;
		this.autoDispose = true;
		// Unknown message types are ignored, never a session kill (room-compat.js).
		installUnknownMessageGuard(this, 'clash');

		// The two communities are fixed at creation from the matchKey's options. The
		// engine owns the authoritative match; the schema mirrors it for clients.
		const a = { mint: clean(options?.aMint, 64), name: clean(options?.aName, 48), symbol: clean(options?.aSymbol, 16), image: cleanAvatarUrl(options?.aImage) };
		const b = { mint: clean(options?.bMint, 64), name: clean(options?.bName, 48), symbol: clean(options?.bSymbol, 16), image: cleanAvatarUrl(options?.bImage) };
		this.network = clean(options?.network, 12) || 'mainnet';
		this.matchKey = clean(options?.matchKey, 160);
		this._reported = false;

		this.match = new ClashMatch({ factions: [a, b], config: {} });
		const s = this.state;
		s.scoreCap = this.match.cfg.scoreCap;
		s.aMint = a.mint; s.aName = a.name || a.symbol || 'Community'; s.aSymbol = a.symbol; s.aImage = a.image;
		s.bMint = b.mint; s.bName = b.name || b.symbol || 'Community'; s.bSymbol = b.symbol; s.bImage = b.image;
		s.phase = this.match.phase;

		this._moveCounters = new Map(); // sessionId → { windowStart, count }
		this._lastAttackAt = new Map(); // sessionId → epoch ms of last swing

		this.onMessage('move', (client, payload) => this._handleMove(client, payload));
		this.onMessage('attack', (client) => this._handleAttack(client));
		this.onMessage('emote', (client, payload) => this._handleEmote(client, payload));

		this.clock.setInterval(() => this._tick(), LOGIC_TICK_MS);
	}

	onJoin(client, options) {
		const faction = client.userData?.faction;
		// onAuth guaranteed the faction is the wallet's held coin; confirm it's one of
		// the two competitors in THIS match (a holder of an unrelated coin can't crash
		// a battle they're not part of).
		if (faction !== this.state.aMint && faction !== this.state.bMint) {
			throw new Error('clash_faction_mismatch');
		}
		const seat = this.match.addFighter(client.sessionId, faction, { combatLevel: 1, now: Date.now() });
		if (!seat) throw new Error('clash_faction_full');

		const f = new ClashFighter();
		f.id = client.sessionId;
		f.name = clean(options?.name, 24) || `guest-${client.sessionId.slice(0, 4)}`;
		f.color = pickColor(client.sessionId);
		f.avatar = cleanAvatarUrl(options?.avatar);
		f.agent = clean(options?.agent, 64);
		f.account = clean(client.userData?.account, 64);
		f.faction = faction;
		f.cosmetics = clean(options?.cosmetics, 256);
		this._spawn(f, faction);
		f.tsServer = Date.now();
		this.state.fighters.set(client.sessionId, f);

		console.log(`[clash ${this.roomId} ${this.matchKey}] +join ${client.sessionId} ${f.name} faction=${faction} (n=${this.state.fighters.size})`);

		// Arm the countdown the moment both communities have fielded a fighter.
		if (this.match.beginCountdown(Date.now())) this._mirror();
	}

	onLeave(client) {
		const f = this.state.fighters.get(client.sessionId);
		const faction = f?.faction;
		this.match.removeFighter(client.sessionId);
		this.state.fighters.delete(client.sessionId);
		this._moveCounters.delete(client.sessionId);
		this._lastAttackAt.delete(client.sessionId);

		// A community that empties out mid-battle forfeits to the other side, so a
		// disconnect-to-dodge never robs the opponent of a clean league win.
		if (faction && (this.match.phase === ClashPhase.LIVE || this.match.phase === ClashPhase.SUDDEN_DEATH)) {
			if (this.match.countFaction(faction) === 0) {
				this.match.forfeit(faction, Date.now());
				this._mirror();
				this._finishIfEnded();
			}
		}
	}

	// --- handlers -----------------------------------------------------------

	_handleMove(client, payload) {
		const f = this.state.fighters.get(client.sessionId);
		if (!f || f.dead) return;
		if (!this._moveOk(client.sessionId)) return;
		if (!payload || typeof payload !== 'object') return;
		const { x, y, z, yaw, motion } = payload;
		if (![x, y, z, yaw].every((n) => typeof n === 'number' && Number.isFinite(n))) return;

		// Teleport reject: keep yaw/motion (legit on respawn) but pin position.
		if (Math.hypot(x - f.x, z - f.z) > MAX_STEP_M) {
			f.yaw = yaw;
			if (MOTION_VALUES.has(motion)) f.motion = motion;
			f.tsServer = Date.now();
			return;
		}
		f.x = Math.max(-ARENA_BOUND_M, Math.min(ARENA_BOUND_M, x));
		f.z = Math.max(-ARENA_BOUND_M, Math.min(ARENA_BOUND_M, z));
		f.y = Math.max(-4, Math.min(8, y));
		f.yaw = yaw;
		if (MOTION_VALUES.has(motion)) f.motion = motion;
		f.tsServer = Date.now();
	}

	// A swing. The client only declares intent; the SERVER picks the target from
	// authoritative positions (combat.selectTarget over living enemies in range +
	// arc), resolves it through the match engine (which owns friendly fire, vitals
	// and scoring), then broadcasts the hit feedback. The client never claims a hit.
	_handleAttack(client) {
		const attacker = this.state.fighters.get(client.sessionId);
		if (!attacker || attacker.dead) return;
		if (this.match.phase !== ClashPhase.LIVE && this.match.phase !== ClashPhase.SUDDEN_DEATH) return;
		const now = Date.now();
		if (now - (this._lastAttackAt.get(client.sessionId) || 0) < ATTACK_COOLDOWN_MS) return;
		this._lastAttackAt.set(client.sessionId, now);

		// Candidates: living fighters on the OTHER faction. Friendly fire is rejected
		// by the engine too, but excluding teammates here keeps the aim-assist honest.
		const candidates = [];
		for (const [id, other] of this.state.fighters) {
			if (id === client.sessionId || other.dead || other.faction === attacker.faction) continue;
			candidates.push({ id, x: other.x, z: other.z });
		}
		const hit = selectTarget({ x: attacker.x, z: attacker.z, yaw: attacker.yaw }, CLASH_WEAPON, candidates);
		// A whiff still broadcasts so peers see the muzzle/swing effect.
		if (!hit) { this.broadcast('clash:swing', { id: client.sessionId, hit: false }); return; }

		const res = this.match.resolveAttack(client.sessionId, hit.id, CLASH_WEAPON, { rng: Math.random, now });
		if (!res) { this.broadcast('clash:swing', { id: client.sessionId, hit: false }); return; }

		// Mirror the kill onto the schema so peers render the downed state + scoreboard.
		const target = this.state.fighters.get(hit.id);
		if (target && res.killed) {
			target.dead = true;
			target.deaths = this.match.fighters.get(hit.id)?.deaths ?? target.deaths;
			attacker.kills = this.match.fighters.get(client.sessionId)?.kills ?? attacker.kills;
		}
		this.broadcast('clash:swing', {
			id: client.sessionId, hit: true, target: hit.id,
			dealt: res.dealt, killed: res.killed,
		});
		this._mirror();
		this._finishIfEnded();
	}

	_handleEmote(client, payload) {
		const f = this.state.fighters.get(client.sessionId);
		if (!f) return;
		const name = clean(payload?.name, 24);
		if (!name) return;
		f.emote = name;
		f.emoteTs = Date.now();
	}

	// --- match loop ---------------------------------------------------------

	_tick() {
		const now = Date.now();
		const ev = this.match.tick(now);
		// Bring respawned fighters back to a spawn point on the schema.
		for (const id of ev.respawns) {
			const f = this.state.fighters.get(id);
			if (f) { f.dead = false; this._spawn(f, f.faction); f.tsServer = now; }
		}
		if (ev.started || ev.ended || ev.respawns.length) this._mirror();
		else this._mirror(true); // cheap clock-only mirror
		this._finishIfEnded();
	}

	// Mirror the authoritative engine state onto the wire schema. `clockOnly` skips
	// the per-fighter sync (positions ride their own move patches) for the common
	// idle tick, writing just the scores, phase and clock.
	_mirror(clockOnly = false) {
		const s = this.state;
		const [fa, fb] = this.match._orderedFactions();
		s.phase = this.match.phase;
		s.aScore = fa.score;
		s.bScore = fb.score;
		s.startedAt = this.match.startedAt;
		s.endsAt = this.match.endsAt;
		s.countdownEndsAt = this.match.countdownEndsAt;
		if (this.match.phase === ClashPhase.ENDED) {
			s.winner = this.match.winner || '';
			s.mvpId = this.match.result(Date.now())?.mvp?.id || '';
		}
		if (clockOnly) return;
	}

	// Persist the result to the league ledger exactly once, then lock the room so it
	// disposes after players file out. The live winner is already on the schema; this
	// is the durable write the /wars standings recompute from.
	_finishIfEnded() {
		if (this.match.phase !== ClashPhase.ENDED || this._reported) return;
		this._reported = true;
		const result = this.match.result(Date.now());
		if (!result) return;
		this.broadcast('clash:end', {
			winner: result.winner, reason: result.reason,
			scoreA: this.state.aScore, scoreB: this.state.bScore, mvp: result.mvp,
		});
		// Fire-and-forget; reportBattle never throws.
		reportBattle({ ...result, matchKey: this.matchKey, network: this.network });
		// Lock further joins; the room auto-disposes once empty.
		try { this.lock(); } catch { /* already locked */ }
	}

	// --- helpers ------------------------------------------------------------

	// Spawn a fighter on their faction's side of the arena, slightly scattered so two
	// fighters don't stack. Faction A spawns at -z, faction B at +z, facing the centre.
	_spawn(f, faction) {
		const side = faction === this.state.bMint ? 1 : -1;
		f.x = (Math.random() - 0.5) * 24;
		f.z = side * SPAWN_OFFSET + (Math.random() - 0.5) * 6;
		f.y = 0;
		f.yaw = side > 0 ? Math.PI : 0; // face the centre line
		f.motion = 'idle';
	}

	_moveOk(sessionId) {
		const now = Date.now();
		let c = this._moveCounters.get(sessionId);
		if (!c || now - c.windowStart >= 1000) { c = { windowStart: now, count: 0 }; this._moveCounters.set(sessionId, c); }
		if (c.count >= MOVE_RATE_HZ) return false;
		c.count++;
		return true;
	}
}
