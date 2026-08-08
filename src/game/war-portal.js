// War Portal: the Coin Wars door standing in every /play coin world (F18).
//
// Coin Wars is a finished game: ClashRoom runs real community-vs-community
// battles with a countdown, a round clock, sudden death and an Elo league behind
// it. Until this landed, none of that was reachable from inside a world, a
// player standing in their coin's plaza had no way to know wars existed. This is
// the door.
//
// Three jobs, one landmark:
//   1. THE BOARD. An in-world screen (canvas → CanvasTexture, same technique as
//      the chart jumbotron) painted with this community's real league standing,
//      the last battles it fought, and any war running right now. Data comes
//      from /api/wars, which folds the battle ledger through the SAME Elo math
//      the arena uses (multiplayer/src/war-standings.js): nothing is recomputed
//      here.
//   2. THE QUEUE. Press E and the portal runs this coin's holder gate (the exact
//      gate the Holders world runs), queues the community for a battle, and the
//      moment a second community is waiting hands the player through to the
//      arena at /play/war with a signed war ticket and a return link that
//      carries the full coin identity, so walking back in lands in this same
//      world, not the lobby.
//   3. SPECTATING. While a war involving this coin is live, the board becomes a
//      scoreboard: score, round clock, kill feed. Text and numbers off a cheap
//      poll, never a second 3D render.
//
// Idle cost is zero. Nothing is fetched until a player walks inside the board's
// legibility ring (WAR_PORTAL_BOARD_REACH), and every timer stops when they walk
// back out or the world is torn down.

import {
	Group, Mesh, MeshStandardMaterial, MeshBasicMaterial,
	BoxGeometry, CylinderGeometry, PlaneGeometry, RingGeometry, TorusGeometry,
	DoubleSide,
} from 'three';
import { makeScreenCanvas, makeScreenTexture, screenMaterial } from './screen-texture.js';
import {
	WAR_PORTAL, warPortalInRange, warPortalBoardInRange,
} from '../../multiplayer/src/world-features.js';
import { createLogger } from '../shared/log.js';
import './war-portal.css';

const log = createLogger('war-portal');

const CW = 640, CH = 400;   // logical board layout grid; backed at 2x by makeScreenCanvas
const SS = 2;

// Poll cadences. The slow one is what a player idling near the board pays; the
// fast one only applies while a war involving this coin is actually running or
// the panel is open, which is exactly when a stale number would be noticed.
const POLL_IDLE_MS = 20_000;
const POLL_LIVE_MS = 5_000;
// While queued, the pairing poll has to be brisk or the other community is left
// standing in their own plaza wondering whether anything happened.
const POLL_QUEUE_MS = 3_000;

// How long the win takeover holds the board after a battle this community won.
const HYPE_MS = 9_000;

// Restrained palette matching the world's monochrome UI, with one directional
// accent pair for the two sides of a war.
const COL = {
	bg0: '#0a0a0c', bg1: '#141419',
	text: '#f5f5f6', dim: '#8c8c92', faint: '#5a5a60',
	line: 'rgba(255,255,255,0.08)',
	us: '#7fd8ff', them: '#ff9d7a',
	win: '#5fd08a', loss: '#e06c75', draw: '#c9a227',
};

function el(tag, props = {}, kids = []) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v == null) continue;
		if (k === 'class') n.className = v;
		else if (k === 'text') n.textContent = v;
		else if (k === 'html') n.innerHTML = v;
		else if (k === 'hidden') n.hidden = !!v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
		else n.setAttribute(k, v);
	}
	for (const kid of [].concat(kids)) {
		if (kid == null) continue;
		n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
	}
	return n;
}

function relTime(ms) {
	if (!ms) return '';
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (s < 45) return 'just now';
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.round(h / 24)}d ago`;
}

function clock(ms) {
	const s = Math.max(0, Math.round(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function label(side) {
	return side?.symbol ? `$${side.symbol}` : (side?.name || 'Community');
}

export class WarPortal {
	/**
	 * @param {object} opts
	 * @param {import('three').Scene} opts.scene
	 * @param {() => ({x:number,y:number,z:number})} opts.getPlayer  local avatar pose
	 * @param {{mint:string,name:string,symbol:string,image:string,tier:string}} opts.coin  this world's coin
	 * @param {object} opts.ui   the world HUD (used for toasts only)
	 * @param {() => Promise<object|null>} opts.ensureHolderPass  runs THIS coin's holder
	 *   gate and resolves to the verified pass, or null if the player backed out. Injected
	 *   rather than imported so the portal reuses the world's existing gate overlay
	 *   instead of growing a second one.
	 * @param {string} [opts.network]
	 * @param {string} [opts.returningMatchKey]  the ?war= key a player carries back from
	 *   the arena, captured before enter() canonicalises the URL
	 */
	constructor({ scene, getPlayer, coin, ui, ensureHolderPass, network = 'mainnet', returningMatchKey = '' }) {
		this.scene = scene;
		this.getPlayer = getPlayer;
		this.coin = coin || {};
		this.ui = ui;
		this.ensureHolderPass = ensureHolderPass;
		this.network = network;

		this._t = 0;
		this._near = false;          // inside interaction reach
		this._awake = false;         // inside board-legibility reach (drives polling)
		this._board = null;          // last /api/wars payload
		this._boardError = '';       // last fetch failure, shown on the board + panel
		this._loading = true;
		this._queue = null;          // { status, waiting, matchKey, ticket, side, opponent }
		this._queueError = '';
		this._busy = false;          // a queue/gate round trip is in flight
		this._pollTimer = 0;
		this._nextPollAt = 0;
		this._panel = null;
		this._hype = null;           // { until, battle } win takeover on the board
		this._seenBattles = new Set();
		this._seenSeeded = false;    // first poll seeds history without echoing it
		this._returning = returningMatchKey || '';
		this._disposed = false;

		this._buildScene();
		this._buildPrompt();
		// A player walking back in from a battle gets their result echoed even if
		// they land far from the portal, so the war they just fought is never
		// silently swallowed by the world transition.
		if (this._returning) this._echoReturn();
	}

	// ── the landmark ─────────────────────────────────────────────────────────

	_buildScene() {
		const spot = WAR_PORTAL;
		const g = new Group();
		g.position.set(spot.x, 0, spot.z);
		// Face the plaza centre so the board reads from the middle of the world.
		g.rotation.y = Math.atan2(-spot.x, -spot.z);

		const stone = new MeshStandardMaterial({ color: 0x23252c, roughness: 0.85, metalness: 0.1 });
		const trim = new MeshStandardMaterial({ color: 0x3c4049, roughness: 0.6, metalness: 0.35 });

		// A stepped plinth the whole structure stands on.
		const base = new Mesh(new CylinderGeometry(spot.r, spot.r + 0.4, 0.4, 8), stone);
		base.position.y = 0.2;
		base.castShadow = true;
		base.receiveShadow = true;
		g.add(base);

		// Two pillars and a lintel: the gate you walk through to go to war.
		for (const side of [-1, 1]) {
			const pillar = new Mesh(new BoxGeometry(0.7, 4.2, 0.7), stone);
			pillar.position.set(side * 1.7, 2.5, 0);
			pillar.castShadow = true;
			g.add(pillar);
			const cap = new Mesh(new BoxGeometry(1.0, 0.25, 1.0), trim);
			cap.position.set(side * 1.7, 4.7, 0);
			g.add(cap);
		}
		const lintel = new Mesh(new BoxGeometry(4.6, 0.5, 0.9), trim);
		lintel.position.y = 5.05;
		lintel.castShadow = true;
		g.add(lintel);

		// The portal itself: a flat emissive pane between the pillars whose opacity
		// breathes, so the landmark is alive from across the plaza without costing
		// a particle system.
		this._veil = new Mesh(
			new PlaneGeometry(3.0, 4.0),
			new MeshBasicMaterial({ color: 0x6fb7ff, transparent: true, opacity: 0.18, side: DoubleSide, fog: false, toneMapped: false }),
		);
		this._veil.position.y = 2.5;
		g.add(this._veil);

		this._ring = new Mesh(
			new TorusGeometry(1.5, 0.05, 8, 32),
			new MeshBasicMaterial({ color: 0x8fd0ff, transparent: true, opacity: 0.35, fog: false, toneMapped: false }),
		);
		this._ring.position.y = 2.5;
		g.add(this._ring);

		// The board, mounted beside the arch on its own posts.
		const boardW = 6.4;
		const boardH = (boardW * CH) / CW;
		const screen = makeScreenCanvas(CW, CH, SS);
		this._canvas = screen.canvas;
		this._ctx = screen.ctx;
		this._tex = makeScreenTexture(this._canvas);
		const face = new Mesh(new PlaneGeometry(boardW, boardH), screenMaterial(this._tex));
		face.position.set(4.9, 2.9, 0);
		g.add(face);
		const frame = new Mesh(new BoxGeometry(boardW + 0.3, boardH + 0.3, 0.16), trim);
		frame.position.set(4.9, 2.9, -0.1);
		frame.castShadow = true;
		g.add(frame);
		for (const dx of [-2.4, 2.4]) {
			const post = new Mesh(new CylinderGeometry(0.14, 0.16, 2.0, 8), stone);
			post.position.set(4.9 + dx, 1.0, -0.1);
			post.castShadow = true;
			g.add(post);
		}

		// Ground marker, same language as the wheel's: a soft ring that brightens
		// as you come into range so "you can use this" is legible before the prompt.
		this._marker = new Mesh(
			new RingGeometry(spot.r + 0.4, spot.r + 0.65, 40),
			new MeshBasicMaterial({ color: 0x8fd0ff, transparent: true, opacity: 0.16, side: DoubleSide }),
		);
		this._marker.rotation.x = -Math.PI / 2;
		this._marker.position.y = 0.05;
		g.add(this._marker);

		this.scene.add(g);
		this._group = g;
		this._paint();
	}

	_buildPrompt() {
		this.btn = el('button', {
			class: 'ps-action wp-action',
			hidden: true,
			text: '⚔ Enter the war',
			'aria-label': 'Open the war portal',
			onclick: () => this.interact(),
		});
		document.body.appendChild(this.btn);
	}

	// ── frame loop ───────────────────────────────────────────────────────────

	tick(dt) {
		if (this._disposed) return;
		this._t += dt;

		const p = this.getPlayer?.();
		const near = !!(p && warPortalInRange(p.x, p.z));
		const awake = !!(p && warPortalBoardInRange(p.x, p.z));

		if (near !== this._near) {
			this._near = near;
			this.btn.hidden = !near || !!this._panel;
		}
		// Crossing the legibility ring is what starts (and stops) every network
		// call this module makes. A world with nobody near the portal is silent.
		if (awake !== this._awake) {
			this._awake = awake;
			if (awake) this._wake();
			else this._sleep();
		}

		// Idle animation: the veil breathes, the ring turns, the marker pulses.
		const breathe = 0.16 + Math.sin(this._t * 1.3) * 0.06;
		this._veil.material.opacity = this._liveHere() ? breathe + 0.24 : breathe;
		this._ring.rotation.z = this._t * 0.25;
		this._marker.material.opacity = near ? breathe + 0.2 : breathe * 0.7;

		// The board only repaints when something on it moves: a running clock, an
		// active takeover, or a fresh payload (which repaints on arrival).
		if (this._awake && (this._liveHere() || this._hype)) {
			if (!this._lastPaint || this._t - this._lastPaint > 0.25) this._paint();
		}
	}

	// Public: act if in range. SYNCHRONOUS for the same reason WheelStation's is:
	// coincommunities' E-key chain calls each system's interact() looking for the
	// one that consumed the press, and a Promise is always truthy.
	interact() {
		if (!this._near) return false;
		if (!this._panel) this._openPanel();
		return true;
	}

	// ── polling ──────────────────────────────────────────────────────────────

	_wake() {
		this._nextPollAt = 0;
		this._schedule(0);
	}

	_sleep() {
		clearTimeout(this._pollTimer);
		this._pollTimer = 0;
		// A player who walks away while queued is taken out of the line, so nobody
		// is ever paired against a community that left the plaza.
		if (this._queue && this._queue.status === 'waiting' && !this._panel) this._leaveQueue();
	}

	_schedule(ms) {
		clearTimeout(this._pollTimer);
		if (this._disposed || !this._awake) return;
		this._pollTimer = setTimeout(() => this._poll(), ms);
	}

	_pollInterval() {
		if (this._queue?.status === 'waiting') return POLL_QUEUE_MS;
		if (this._liveHere() || this._panel) return POLL_LIVE_MS;
		return POLL_IDLE_MS;
	}

	async _poll() {
		if (this._disposed || !this._awake) return;
		const mint = this.coin?.mint || '';
		if (!mint) return;
		try {
			const q = new URLSearchParams({ network: this.network, coin: mint, limit: '8' });
			const r = await fetch(`/api/wars?${q}`, { headers: { accept: 'application/json' } });
			if (!r.ok) throw new Error(`http ${r.status}`);
			const payload = await r.json();
			this._board = payload?.data || null;
			this._boardError = '';
			this._echoNewResults();
		} catch (err) {
			this._boardError = err?.message || 'could not reach the war league';
			log.warn('board fetch failed', err);
		}
		this._loading = false;
		this._paint();
		this._renderPanel();
		// While queued, keep asking the matchmaker whether the other side turned up.
		if (this._queue?.status === 'waiting') this._pollQueue();
		this._schedule(this._pollInterval());
	}

	// The live war this community is in, if any. A finished battle is deliberately
	// NOT live: the room publishes one last snapshot with the winner set, and the
	// board should hand that moment to the result echo (and then to the standings)
	// rather than keep flying a "war in progress" banner over a settled scoreline.
	_liveHere() {
		const mint = this.coin?.mint;
		return (this._board?.live || []).find((m) =>
			m.phase !== 'ended' && (m.a?.mint === mint || m.b?.mint === mint)) || null;
	}

	// ── results echo ─────────────────────────────────────────────────────────

	// Every poll after the first compares the ledger against what we have already
	// seen, so a battle that finishes while the player is standing in the world
	// lands as a toast and (on a win) a takeover on the board.
	_echoNewResults() {
		const recent = this._board?.recent || [];
		if (!this._seenSeeded) {
			for (const b of recent) this._seenBattles.add(b.matchKey);
			this._seenSeeded = true;
			return;
		}
		for (const b of recent) {
			if (this._seenBattles.has(b.matchKey)) continue;
			this._seenBattles.add(b.matchKey);
			this._announce(b);
		}
	}

	// A player returning from the arena carries ?war=<matchKey>. The ledger write
	// happens as the room ends, so the row may not be readable for a beat: retry a
	// few times before giving up quietly (the next poll would surface it anyway).
	async _echoReturn() {
		const mint = this.coin?.mint;
		const key = this._returning;
		if (!mint || !key) return;
		for (let attempt = 0; attempt < 5 && !this._disposed; attempt++) {
			try {
				const q = new URLSearchParams({ network: this.network, coin: mint, limit: '8' });
				const r = await fetch(`/api/wars?${q}`, { headers: { accept: 'application/json' } });
				if (r.ok) {
					const payload = await r.json();
					const battle = (payload?.data?.recent || []).find((b) => b.matchKey === key);
					if (battle) {
						this._board = payload.data;
						this._seenSeeded = true;
						for (const b of payload.data.recent || []) this._seenBattles.add(b.matchKey);
						this._announce(battle);
						this._paint();
						return;
					}
				}
			} catch { /* retry below */ }
			await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
		}
	}

	// One finished battle, brought into the world: a toast every time, plus a short
	// takeover of the board when this community won it.
	_announce(battle) {
		const mint = this.coin?.mint;
		const us = battle.a?.mint === mint ? battle.a : battle.b;
		const them = battle.a?.mint === mint ? battle.b : battle.a;
		const won = battle.winner === mint;
		const drew = battle.winner === 'draw';
		const line = drew
			? `⚔ War drawn with ${label(them)}: ${us.score}:${them.score}`
			: won
				? `⚔ ${label(us)} won the war against ${label(them)}: ${us.score}:${them.score}`
				: `⚔ ${label(them)} took the war: ${them.score}:${us.score}`;
		this.ui?.toast?.(line, won ? 'success' : drew ? 'info' : 'warn');
		if (won) {
			this._hype = { until: Date.now() + HYPE_MS, battle, us, them };
			this._paint();
		}
	}

	// ── the board ────────────────────────────────────────────────────────────

	_paint() {
		const ctx = this._ctx;
		if (!ctx) return;
		this._lastPaint = this._t;
		if (this._hype && Date.now() > this._hype.until) this._hype = null;

		const grad = ctx.createLinearGradient(0, 0, 0, CH);
		grad.addColorStop(0, COL.bg1);
		grad.addColorStop(1, COL.bg0);
		ctx.fillStyle = grad;
		ctx.fillRect(0, 0, CW, CH);

		if (this._hype) this._paintHype(ctx);
		else if (this._loading && !this._board) this._paintCentred(ctx, 'READING THE LEAGUE', 'Standings load as you walk up.');
		else if (this._boardError && !this._board) this._paintCentred(ctx, 'LEAGUE UNREACHABLE', this._boardError + ', press E to retry.');
		else {
			const live = this._liveHere();
			if (live) this._paintLive(ctx, live);
			else this._paintStandings(ctx);
		}

		this._tex.needsUpdate = true;
	}

	_paintHeader(ctx, title, right = '') {
		ctx.fillStyle = COL.text;
		ctx.font = '800 26px Inter, system-ui, sans-serif';
		ctx.textAlign = 'left';
		ctx.fillText(title, 26, 44);
		if (right) {
			ctx.fillStyle = COL.dim;
			ctx.font = '600 16px Inter, system-ui, sans-serif';
			ctx.textAlign = 'right';
			ctx.fillText(right, CW - 26, 42);
		}
		ctx.strokeStyle = COL.line;
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(26, 60);
		ctx.lineTo(CW - 26, 60);
		ctx.stroke();
		ctx.textAlign = 'left';
	}

	_paintCentred(ctx, title, sub) {
		ctx.textAlign = 'center';
		ctx.fillStyle = COL.text;
		ctx.font = '800 28px Inter, system-ui, sans-serif';
		ctx.fillText(title, CW / 2, CH / 2 - 6);
		ctx.fillStyle = COL.dim;
		ctx.font = '500 17px Inter, system-ui, sans-serif';
		this._wrap(ctx, sub, CW / 2, CH / 2 + 28, CW - 90, 24);
		ctx.textAlign = 'left';
	}

	// A war this community won, held on the board for a few seconds. This is the
	// jumbotron moment: whoever is standing in the plaza sees it without opening
	// anything.
	_paintHype(ctx) {
		const { us, them, battle } = this._hype;
		const pulse = 0.6 + 0.4 * Math.sin(this._t * 5);
		ctx.fillStyle = `rgba(95, 208, 138, ${0.10 + 0.06 * pulse})`;
		ctx.fillRect(0, 0, CW, CH);
		ctx.textAlign = 'center';
		ctx.fillStyle = COL.win;
		ctx.font = '900 60px Inter, system-ui, sans-serif';
		ctx.fillText('WAR WON', CW / 2, 130);
		ctx.fillStyle = COL.text;
		ctx.font = '800 30px Inter, system-ui, sans-serif';
		ctx.fillText(`${label(us)}  ${us.score} - ${them.score}  ${label(them)}`, CW / 2, 196);
		ctx.fillStyle = COL.dim;
		ctx.font = '600 18px Inter, system-ui, sans-serif';
		ctx.fillText(reasonLine(battle.reason), CW / 2, 236);
		if (battle.mvp) {
			ctx.fillStyle = COL.faint;
			ctx.font = '600 16px Inter, system-ui, sans-serif';
			ctx.fillText(`MVP · ${battle.mvp.kills} kills · ${battle.mvp.damage} damage`, CW / 2, 268);
		}
		ctx.fillStyle = COL.faint;
		ctx.font = '600 15px Inter, system-ui, sans-serif';
		ctx.fillText('Press E to see the league', CW / 2, CH - 30);
		ctx.textAlign = 'left';
	}

	// The spectator screen: score, clock, kill feed. No second 3D render, just the
	// numbers a crowd standing at the portal wants while their side is fighting.
	_paintLive(ctx, m) {
		const mint = this.coin?.mint;
		const usIsA = m.a?.mint === mint;
		const us = usIsA ? m.a : m.b;
		const them = usIsA ? m.b : m.a;
		const phase = m.phase === 'sudden_death' ? 'SUDDEN DEATH' : String(m.phase || '').toUpperCase();
		this._paintHeader(ctx, 'WAR IN PROGRESS', phase);

		// Scoreline.
		ctx.textAlign = 'center';
		ctx.fillStyle = COL.us;
		ctx.font = '900 54px Inter, system-ui, sans-serif';
		ctx.fillText(String(us.score ?? 0), CW * 0.28, 132);
		ctx.fillStyle = COL.them;
		ctx.fillText(String(them.score ?? 0), CW * 0.72, 132);
		ctx.fillStyle = COL.faint;
		ctx.font = '700 26px Inter, system-ui, sans-serif';
		ctx.fillText('vs', CW / 2, 126);

		ctx.font = '700 17px Inter, system-ui, sans-serif';
		ctx.fillStyle = COL.text;
		ctx.fillText(clip(ctx, label(us), 190), CW * 0.28, 160);
		ctx.fillText(clip(ctx, label(them), 190), CW * 0.72, 160);
		ctx.fillStyle = COL.faint;
		ctx.font = '500 14px Inter, system-ui, sans-serif';
		ctx.fillText(`${us.fighters || 0} fighting`, CW * 0.28, 182);
		ctx.fillText(`${them.fighters || 0} fighting`, CW * 0.72, 182);

		// Round clock. Rendered from `endsAt` so it ticks smoothly between polls
		// instead of jumping every time a snapshot lands.
		const remaining = m.phase === 'countdown'
			? (m.countdownEndsAt || 0) - Date.now()
			: (m.endsAt || 0) - Date.now();
		ctx.fillStyle = COL.text;
		ctx.font = '800 22px Inter, system-ui, sans-serif';
		ctx.fillText(
			m.phase === 'countdown' ? `starts in ${clock(remaining)}`
				: m.phase === 'sudden_death' ? 'next kill takes it'
					: `${clock(remaining)} left · first to ${m.scoreCap || 25}`,
			CW / 2, 214,
		);
		ctx.textAlign = 'left';

		// Kill feed.
		const kills = (m.kills || []).slice(-4).reverse();
		if (!kills.length) {
			ctx.fillStyle = COL.faint;
			ctx.font = '500 16px Inter, system-ui, sans-serif';
			ctx.fillText('No knockdowns yet.', 26, 258);
		} else {
			let y = 254;
			ctx.font = '600 15px Inter, system-ui, sans-serif';
			for (const k of kills) {
				ctx.fillStyle = k.killerFaction === mint ? COL.us : COL.them;
				ctx.fillText(`${clipText(k.killer, 16)} → ${clipText(k.victim, 16)}`, 26, y);
				ctx.fillStyle = COL.faint;
				ctx.textAlign = 'right';
				ctx.fillText(relTime(k.ts), CW - 26, y);
				ctx.textAlign = 'left';
				y += 26;
			}
		}

		ctx.fillStyle = COL.faint;
		ctx.font = '600 15px Inter, system-ui, sans-serif';
		ctx.textAlign = 'center';
		ctx.fillText('Press E to join the fight', CW / 2, CH - 24);
		ctx.textAlign = 'left';
	}

	// The resting board: where this community sits in the league, and the last
	// battles it fought. Both have designed empty states: an unranked community
	// is told exactly what to do about it.
	_paintStandings(ctx) {
		const standing = this._board?.standing || null;
		const recent = this._board?.recent || [];
		const waiting = this._board?.queue?.waiting || [];
		this._paintHeader(ctx, 'COIN WARS', label(this.coin));

		if (!standing) {
			ctx.fillStyle = COL.text;
			ctx.font = '800 24px Inter, system-ui, sans-serif';
			ctx.fillText('Unranked', 26, 104);
			ctx.fillStyle = COL.dim;
			ctx.font = '500 16px Inter, system-ui, sans-serif';
			this._wrapLeft(
				ctx,
				'This community has never gone to war. Press E to queue: the first battle places you on the ladder.',
				26, 134, CW - 52, 24,
			);
		} else {
			ctx.fillStyle = COL.text;
			ctx.font = '900 44px Inter, system-ui, sans-serif';
			ctx.fillText(String(standing.rating), 26, 116);
			ctx.fillStyle = COL.dim;
			ctx.font = '600 16px Inter, system-ui, sans-serif';
			ctx.fillText('ELO', 26, 138);

			const cells = [
				['RANK', `#${standing.rank}`],
				['RECORD', `${standing.wins}W ${standing.losses}L${standing.draws ? ` ${standing.draws}D` : ''}`],
				['K/D', standing.kd.toFixed(2)],
				['STREAK', streakLabel(standing.streak)],
			];
			let x = 170;
			for (const [k, v] of cells) {
				ctx.fillStyle = COL.faint;
				ctx.font = '700 12px Inter, system-ui, sans-serif';
				ctx.fillText(k, x, 92);
				ctx.fillStyle = COL.text;
				ctx.font = '800 22px Inter, system-ui, sans-serif';
				ctx.fillText(v, x, 120);
				x += 118;
			}
		}

		ctx.strokeStyle = COL.line;
		ctx.beginPath();
		ctx.moveTo(26, 162);
		ctx.lineTo(CW - 26, 162);
		ctx.stroke();

		ctx.fillStyle = COL.faint;
		ctx.font = '700 13px Inter, system-ui, sans-serif';
		ctx.fillText('RECENT WARS', 26, 186);

		if (!this._board?.recentAvailable) {
			ctx.fillStyle = COL.dim;
			ctx.font = '500 16px Inter, system-ui, sans-serif';
			this._wrapLeft(ctx, 'The battle ledger is unreachable right now. Standings will fill in as soon as it answers.', 26, 214, CW - 52, 24);
		} else if (!recent.length) {
			ctx.fillStyle = COL.dim;
			ctx.font = '500 16px Inter, system-ui, sans-serif';
			this._wrapLeft(
				ctx,
				waiting.length
					? `${waiting.length} ${waiting.length === 1 ? 'community is' : 'communities are'} queued right now. Press E to take the fight.`
					: 'No wars fought yet. Press E to queue this community, the arena opens as soon as a second one does.',
				26, 214, CW - 52, 24,
			);
		} else {
			let y = 214;
			for (const b of recent.slice(0, 4)) {
				const mint = this.coin?.mint;
				const us = b.a?.mint === mint ? b.a : b.b;
				const them = b.a?.mint === mint ? b.b : b.a;
				const won = b.winner === mint;
				const drew = b.winner === 'draw';
				ctx.fillStyle = drew ? COL.draw : won ? COL.win : COL.loss;
				ctx.font = '800 15px Inter, system-ui, sans-serif';
				ctx.fillText(drew ? 'DRAW' : won ? 'WIN' : 'LOSS', 26, y);
				ctx.fillStyle = COL.text;
				ctx.font = '600 15px Inter, system-ui, sans-serif';
				ctx.fillText(`${us.score}-${them.score}  vs ${clipText(label(them), 18)}`, 92, y);
				ctx.fillStyle = COL.faint;
				ctx.textAlign = 'right';
				ctx.fillText(relTime(b.endedAt), CW - 26, y);
				ctx.textAlign = 'left';
				y += 26;
			}
		}

		ctx.fillStyle = COL.faint;
		ctx.font = '600 15px Inter, system-ui, sans-serif';
		ctx.textAlign = 'center';
		ctx.fillText('Press E: enter the war', CW / 2, CH - 24);
		ctx.textAlign = 'left';
	}

	_wrap(ctx, text, cx, y, maxW, lh) {
		for (const line of wrapLines(ctx, text, maxW)) { ctx.fillText(line, cx, y); y += lh; }
	}

	_wrapLeft(ctx, text, x, y, maxW, lh) {
		for (const line of wrapLines(ctx, text, maxW)) { ctx.fillText(line, x, y); y += lh; }
	}

	// ── the panel ────────────────────────────────────────────────────────────

	_openPanel() {
		if (this._panel) return;
		this.btn.hidden = true;
		const close = () => this._closePanel();
		const body = el('div', { class: 'wp-body' });
		const panel = el('div', { class: 'wp-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Coin Wars' }, [
			el('header', { class: 'wp-head' }, [
				el('div', { class: 'wp-head-t' }, [
					el('h2', { text: 'Coin Wars' }),
					el('p', { class: 'wp-head-sub', text: `${label(this.coin)} · community vs community` }),
				]),
				el('button', { class: 'wp-x', text: '✕', 'aria-label': 'Close', onclick: close }),
			]),
			body,
			el('footer', { class: 'wp-foot' }, [
				el('button', { class: 'wp-cta', id: 'wp-cta', onclick: () => this._onCta() }),
				el('p', { class: 'wp-foot-note', id: 'wp-note' }),
			]),
		]);
		const scrim = el('div', { class: 'wp-scrim', onclick: close });
		const root = el('div', { class: 'wp-root' }, [scrim, panel]);
		document.body.appendChild(root);
		this._panel = { root, body, panel };
		this._onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
		document.addEventListener('keydown', this._onKey, true);
		requestAnimationFrame(() => root.classList.add('wp-in'));
		panel.querySelector('.wp-x')?.focus();

		this._renderPanel();
		// Opening the panel is an explicit ask for fresh numbers.
		this._schedule(0);
	}

	_closePanel() {
		if (!this._panel) return;
		const { root } = this._panel;
		root.classList.remove('wp-in');
		document.removeEventListener('keydown', this._onKey, true);
		this._onKey = null;
		setTimeout(() => root.remove(), 200);
		this._panel = null;
		this.btn.hidden = !this._near;
		this._schedule(this._pollInterval());
	}

	_renderPanel() {
		if (!this._panel) return;
		const { body } = this._panel;
		const d = this._board;
		const live = this._liveHere();
		const parts = [];

		if (this._boardError && !d) {
			parts.push(retryCard(
				'The war league did not answer',
				this._boardError,
				'Try again',
				() => this._poll(),
			));
		}

		if (live) parts.push(this._liveCard(live));

		// This community's league row.
		if (d) {
			parts.push(d.standing ? standingCard(d.standing) : emptyCard(
				'Unranked',
				'This community has not fought a war yet. The first battle puts it on the ladder, win or lose.',
			));
		}

		// Queue state, when there is one.
		if (this._queue?.status === 'waiting') {
			parts.push(waitingCard(this._queue.waiting, () => this._leaveQueue()));
		}
		if (this._queueError) {
			parts.push(retryCard('Matchmaking refused', this._queueError, 'Try again', () => this._onCta()));
		}

		// Recent wars.
		if (d?.recentAvailable) {
			parts.push(recentCard(d.recent || [], this.coin?.mint));
		} else if (d) {
			parts.push(emptyCard('Battle log unavailable', 'The ledger is not answering right now, so past wars cannot be listed. The league table above is the last good read.'));
		}

		// The ladder.
		if (d?.ledgerAvailable) {
			parts.push(ladderCard(d.standings || [], this.coin?.mint));
		}

		body.replaceChildren(...parts);
		this._renderCta();
	}

	_renderCta() {
		if (!this._panel) return;
		const cta = this._panel.panel.querySelector('#wp-cta');
		const note = this._panel.panel.querySelector('#wp-note');
		if (!cta) return;
		const live = this._liveHere();
		if (this._busy) {
			cta.textContent = 'Working…';
			cta.disabled = true;
			note.textContent = 'Verifying your holding and finding an opponent.';
			return;
		}
		if (this._queue?.status === 'waiting') {
			cta.textContent = 'Waiting for an opponent…';
			cta.disabled = true;
			note.textContent = 'Stay here, the arena opens the moment another community queues.';
			return;
		}
		cta.disabled = false;
		cta.textContent = live ? '⚔ Join the battle' : '⚔ Enter the war';
		note.textContent = live
			? 'A war is running right now. Joining drops you straight into the arena.'
			: 'You fight for this coin, so entering verifies you hold it first.';
	}

	// The spectator card: the same numbers the board paints, in text, so the panel
	// is useful to a screen reader and to anyone reading it on a phone.
	_liveCard(m) {
		const mint = this.coin?.mint;
		const us = m.a?.mint === mint ? m.a : m.b;
		const them = m.a?.mint === mint ? m.b : m.a;
		const remaining = m.phase === 'countdown' ? (m.countdownEndsAt || 0) - Date.now() : (m.endsAt || 0) - Date.now();
		const status = m.phase === 'countdown' ? `Starts in ${clock(remaining)}`
			: m.phase === 'sudden_death' ? 'Sudden death: the next kill takes it'
				: m.phase === 'lobby' ? 'Waiting for both communities to field a fighter'
					: `${clock(remaining)} left · first to ${m.scoreCap || 25}`;
		const kills = (m.kills || []).slice(-6).reverse();
		return el('section', { class: 'wp-card wp-live', 'aria-live': 'polite' }, [
			el('h3', { class: 'wp-card-t' }, [
				el('span', { class: 'wp-live-dot', 'aria-hidden': 'true' }),
				'War in progress',
			]),
			el('div', { class: 'wp-score' }, [
				el('div', { class: 'wp-score-side wp-side-us' }, [
					el('span', { class: 'wp-score-n', text: String(us.score ?? 0) }),
					el('span', { class: 'wp-score-l', text: label(us) }),
					el('span', { class: 'wp-score-f', text: `${us.fighters || 0} fighting` }),
				]),
				el('span', { class: 'wp-score-vs', text: 'vs' }),
				el('div', { class: 'wp-score-side wp-side-them' }, [
					el('span', { class: 'wp-score-n', text: String(them.score ?? 0) }),
					el('span', { class: 'wp-score-l', text: label(them) }),
					el('span', { class: 'wp-score-f', text: `${them.fighters || 0} fighting` }),
				]),
			]),
			el('p', { class: 'wp-live-clock', text: status }),
			kills.length
				? el('ul', { class: 'wp-list wp-feed' }, kills.map((k) => el('li', {
					class: `wp-row wp-row-${k.killerFaction === mint ? 'win' : 'loss'}`,
				}, [
					el('span', { class: 'wp-row-vs', text: `${clipText(k.killer, 18)} → ${clipText(k.victim, 18)}` }),
					el('span', { class: 'wp-row-when', text: relTime(k.ts) }),
				])))
				: el('p', { class: 'wp-empty-b', text: 'No knockdowns yet, the first one lands here.' }),
		]);
	}

	// ── queueing and handoff ─────────────────────────────────────────────────

	async _onCta() {
		if (this._busy) return;
		this._queueError = '';
		this._busy = true;
		this._renderCta();
		try {
			// The same gate the Holders world runs. A community whose world is open
			// still gates the war on holding the coin: you cannot wear a
			// community's colours without holding its coin, which is the rule
			// ClashRoom.onAuth enforces server-side too.
			const pass = await this.ensureHolderPass?.();
			if (!pass || !pass.holderPass) {
				// Two clean refusals, neither an error. A null means the player
				// backed out of the gate; the string 'general' means they chose the
				// open world from inside it, which for a war means declining, you
				// cannot wear a community's colours without holding its coin, and
				// ClashRoom.onAuth enforces exactly that server-side.
				this._busy = false;
				this._queueError = pass == null ? '' : 'You need to hold this coin to fight for it.';
				this._renderPanel();
				return;
			}
			this._holderPass = pass.holderPass;

			// Queueing covers both cases: with a war already running, the matchmaker
			// hands back that same pairing (the entry is still keyed), so joining a
			// battle in progress and starting a fresh one take one code path.
			const res = await this._queueRequest();
			if (res?.status === 'matched') return this._handoff(res);
			this._queue = res;
		} catch (err) {
			this._queueError = err?.message || 'could not queue for a war';
		}
		this._busy = false;
		this._renderPanel();
		this._schedule(0);
	}

	async _queueRequest() {
		const r = await fetch('/api/wars?action=queue', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				coin: this.coin.mint,
				name: this.coin.name || '',
				symbol: this.coin.symbol || '',
				image: this.coin.image || '',
				network: this.network,
			}),
		});
		const payload = await r.json().catch(() => null);
		if (!r.ok) {
			const msg = payload?.error?.message || payload?.message || `http ${r.status}`;
			throw new Error(msg);
		}
		return payload?.data || null;
	}

	// While queued, poll the matchmaker on its own cadence: the moment the other
	// side appears we have a key and a signed ticket and can hand off.
	async _pollQueue() {
		if (this._disposed || this._queue?.status !== 'waiting') return;
		try {
			const res = await this._queueRequest();
			if (res?.status === 'matched') return this._handoff(res);
			this._queue = res;
			this._renderPanel();
		} catch (err) {
			this._queueError = err?.message || 'matchmaking stopped answering';
			this._queue = null;
			this._renderPanel();
		}
	}

	async _leaveQueue() {
		const mint = this.coin?.mint;
		this._queue = null;
		this._renderPanel();
		if (!mint) return;
		try {
			await fetch('/api/wars?action=leave', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ coin: mint, network: this.network }),
				keepalive: true,
			});
		} catch { /* the queue entry expires on its own */ }
	}

	// Hand the player to the arena. The return link carries the FULL coin identity
	// plus the match key, so coming back lands in this exact world with the result
	// already in hand, no lobby detour, no re-picking a community.
	_handoff(match) {
		const q = new URLSearchParams({
			match: match.matchKey,
			ticket: match.ticket,
			side: match.side || '',
			coin: this.coin.mint,
			network: this.network,
			return: this._returnUrl(match.matchKey),
		});
		if (this.coin.name) q.set('name', this.coin.name);
		if (this.coin.symbol) q.set('symbol', this.coin.symbol);
		if (this.coin.image) q.set('image', this.coin.image);
		if (this._holderPass) q.set('holderPass', this._holderPass);
		this.ui?.toast?.(`⚔ Matched against ${label(match.opponent)}: entering the arena`, 'success');
		location.href = `/play/war?${q}`;
	}

	_returnUrl(matchKey) {
		const q = new URLSearchParams({ coin: this.coin.mint });
		if (this.coin.name) q.set('name', this.coin.name);
		if (this.coin.symbol) q.set('symbol', this.coin.symbol);
		if (this.coin.image) q.set('image', this.coin.image);
		if (this.coin.tier === 'holders') q.set('tier', 'holders');
		q.set('war', matchKey);
		return `/play?${q}`;
	}

	// ── teardown ─────────────────────────────────────────────────────────────

	dispose() {
		this._disposed = true;
		clearTimeout(this._pollTimer);
		if (this._queue?.status === 'waiting') this._leaveQueue();
		this._closePanel();
		if (this._group) {
			this.scene.remove(this._group);
			this._group.traverse((n) => {
				if (n.isMesh) {
					n.geometry?.dispose?.();
					const ms = Array.isArray(n.material) ? n.material : [n.material];
					ms.forEach((m) => m?.dispose?.());
				}
			});
			this._group = null;
		}
		this._tex?.dispose?.();
		this._tex = null;
		this.btn?.remove();
		this.btn = null;
	}
}

// ── panel pieces ─────────────────────────────────────────────────────────────

function card(title, kids, extraClass = '') {
	return el('section', { class: `wp-card ${extraClass}`.trim() }, [
		el('h3', { class: 'wp-card-t', text: title }),
		...[].concat(kids),
	]);
}

function emptyCard(title, body) {
	return el('section', { class: 'wp-card wp-empty' }, [
		el('h3', { class: 'wp-card-t', text: title }),
		el('p', { class: 'wp-empty-b', text: body }),
	]);
}

// The lobby's retry-card shape: what went wrong, in a sentence, and the one
// button that can fix it.
function retryCard(title, detail, action, onAction) {
	return el('section', { class: 'wp-card wp-retry' }, [
		el('h3', { class: 'wp-card-t', text: title }),
		el('p', { class: 'wp-empty-b', text: detail }),
		el('button', { class: 'wp-retry-btn', text: action, onclick: onAction }),
	]);
}

function standingCard(s) {
	const stats = [
		['Elo', String(s.rating)],
		['Rank', `#${s.rank}`],
		['Record', `${s.wins}W ${s.losses}L${s.draws ? ` ${s.draws}D` : ''}`],
		['Win rate', `${Math.round(s.winRate * 100)}%`],
		['K/D', s.kd.toFixed(2)],
		['Streak', streakLabel(s.streak)],
	];
	return card('League standing', el('dl', { class: 'wp-stats' },
		stats.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])));
}

function waitingCard(waiting, onCancel) {
	const others = Math.max(0, (waiting || 1) - 1);
	return el('section', { class: 'wp-card wp-waiting' }, [
		el('h3', { class: 'wp-card-t', text: 'In the queue' }),
		el('p', {
			class: 'wp-empty-b',
			text: others > 0
				? `${others} other ${others === 1 ? 'community is' : 'communities are'} queued. Pairing happens within seconds.`
				: 'No other community is queued yet. The arena opens the moment one is.',
		}),
		el('button', { class: 'wp-retry-btn', text: 'Leave the queue', onclick: onCancel }),
	]);
}

function recentCard(recent, mint) {
	if (!recent.length) {
		return emptyCard('No wars yet', 'This community has never fought. Be the first: queue below and the arena opens as soon as another community answers.');
	}
	const rows = recent.map((b) => {
		const us = b.a?.mint === mint ? b.a : b.b;
		const them = b.a?.mint === mint ? b.b : b.a;
		const drew = b.winner === 'draw';
		const won = b.winner === mint;
		return el('li', { class: `wp-row wp-row-${drew ? 'draw' : won ? 'win' : 'loss'}` }, [
			el('span', { class: 'wp-row-tag', text: drew ? 'DRAW' : won ? 'WIN' : 'LOSS' }),
			el('span', { class: 'wp-row-score', text: `${us.score}-${them.score}` }),
			el('span', { class: 'wp-row-vs', text: label(them) }),
			el('span', { class: 'wp-row-when', text: relTime(b.endedAt) }),
		]);
	});
	return card('Recent wars', el('ul', { class: 'wp-list' }, rows));
}

function ladderCard(standings, mint) {
	if (!standings.length) {
		return emptyCard('The ladder is empty', 'No community has fought a war yet. The first battle creates the league.');
	}
	const rows = standings.slice(0, 10).map((s) => el('li', {
		class: `wp-row${s.mint === mint ? ' wp-row-me' : ''}`,
	}, [
		el('span', { class: 'wp-row-tag', text: `#${s.rank}` }),
		el('span', { class: 'wp-row-vs', text: s.symbol ? `$${s.symbol}` : s.name }),
		el('span', { class: 'wp-row-score', text: String(s.rating) }),
		el('span', { class: 'wp-row-when', text: `${s.wins}W ${s.losses}L` }),
	]));
	return card('The ladder', el('ul', { class: 'wp-list' }, rows));
}

// ── formatting helpers ───────────────────────────────────────────────────────

function streakLabel(streak) {
	if (!streak) return '-';
	return streak > 0 ? `${streak}W` : `${-streak}L`;
}

function reasonLine(reason) {
	switch (reason) {
		case 'score_cap': return 'Kill cap reached';
		case 'timeout': return 'Round clock ran out';
		case 'sudden_death': return 'Taken in sudden death';
		case 'forfeit': return 'The other side withdrew';
		default: return 'Battle ended';
	}
}

function clipText(s, max) {
	const t = String(s ?? '');
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Shrink a label until it fits the canvas column rather than bleeding off it,
// a pump.fun name can be far longer than the space a scoreboard gives it.
function clip(ctx, text, maxW) {
	let t = String(text ?? '');
	while (t.length > 3 && ctx.measureText(t).width > maxW) t = `${t.slice(0, -2)}…`;
	return t;
}

function wrapLines(ctx, text, maxW) {
	const words = String(text ?? '').split(/\s+/);
	const lines = [];
	let line = '';
	for (const w of words) {
		const next = line ? `${line} ${w}` : w;
		if (ctx.measureText(next).width > maxW && line) { lines.push(line); line = w; }
		else line = next;
	}
	if (line) lines.push(line);
	return lines;
}
