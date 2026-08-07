// The Plaza Stage — a Living Stage standing in every /play coin world (F17).
//
// The platform already runs real hosted shows: an embodied AI host performs live
// beats with spatial voice, lip-sync, synced captions, an audience question
// queue, and a verified on-chain $THREE tip leaderboard where a tip pre-empts the
// host's next line in about a second (multiplayer/src/rooms/StageRoom.js, served
// to the browser at /stage). Until now none of it was reachable from the world.
// This module puts the venue in the plaza: a real structure with a marquee that
// reads the show's actual state, and a proximity gate that walks the player into
// the show and back out of it.
//
// Two halves, split for cost:
//   • THIS file is always mounted with the world. It is geometry, a canvas
//     marquee, and one distance check per frame — no sockets, no fetches, no
//     audio. A player who never walks over there costs exactly that.
//   • src/game/plaza-stage-show.js is the show client (the stage_world room, the
//     host avatar, TTS + lip-sync, tips, questions). It is dynamically imported
//     the first time the player reaches the venue and fully torn down when they
//     walk away, so its weight and its network traffic exist only for attendees.
//
// The stage the world joins is DERIVED from the coin, not looked up: the plaza
// stage id is uuidv5 of the mint (multiplayer/src/plaza-stage.js), which is both
// the stage_world filterBy key and the `stages.id` a claim writes. The footprint
// lives in multiplayer/src/world-features.js, so the marker the player sees and
// the disc the server protects from being built over are the same coordinates.

import {
	Group, Mesh, BoxGeometry, CylinderGeometry, RingGeometry, TorusGeometry, PlaneGeometry,
	MeshStandardMaterial, MeshBasicMaterial, DoubleSide, Color,
} from 'three';
import { PLAZA_STAGE, stageInRange, stageMarqueeInRange } from '../../multiplayer/src/world-features.js';
import { plazaStageId } from '../../multiplayer/src/plaza-stage.js';
import { makeScreenCanvas, makeScreenTexture, screenMaterial } from './screen-texture.js';
import { log } from '../shared/log.js';

const CW = 1024;              // marquee logical width
const CH = 512;               // marquee logical height
const SS = 1.5;               // supersample for crisp text up close
const REFRESH_MS = 45_000;    // show-state poll while near but not attending
const REDRAW_MS = 1000;       // marquee repaint cadence (a countdown ticks)
const LEAVE_HYSTERESIS_M = 3; // walk this far past the edge before the show tears down

const COL = {
	bg0: '#0a0a0c', bg1: '#16121f',
	text: '#f5f5f6', dim: '#9d97ad', faint: '#5f5a70',
	accent: '#9b6bff', hot: '#ff5db1', gold: '#ffd24a', ok: '#5fd08a',
};

const fmtThree = (atomic) => Math.round(Number(atomic || 0) / 1e6).toLocaleString('en-US');

export class PlazaStage {
	/**
	 * @param {object} opts
	 * @param {import('three').Scene} opts.scene
	 * @param {import('three').Camera} opts.camera  the follow camera (spatial audio listener)
	 * @param {() => ({x:number,y:number,z:number})} opts.getPlayer  local avatar pose
	 * @param {object} opts.coin   the world's coin ({ mint, name, symbol })
	 * @param {object} opts.ui     CommunityUI — toasts + the chat bar
	 */
	constructor({ scene, camera, getPlayer, coin, ui }) {
		this.scene = scene;
		this.camera = camera;
		this.getPlayer = getPlayer;
		this.coin = coin || {};
		this.ui = ui;
		this.stageId = plazaStageId(this.coin.mint);

		this._t = 0;
		this._sinceFetch = Infinity;
		this._sinceDraw = Infinity;
		this._near = false;      // inside the marquee ring
		this._attending = false; // inside the attend ring
		this._fetching = false;
		this._show = null;       // the lazily-mounted show client
		this._mounting = false;
		this._destroyed = false;

		// What the marquee paints. `phase` is the designed state machine:
		// asleep → loading → (unclaimed | scheduled | dark | live).
		this.state = {
			phase: 'asleep',
			title: '', host: '', format: '',
			nextShowAt: 0,
			audience: 0,
			totalTipsAtomic: 0, tipCount: 0,
			leaderboard: [],
			lastLine: '',
			error: '',
		};

		this._build();
		this._buildPrompt();
		this._draw();
	}

	// ── the structure ─────────────────────────────────────────────────────────
	_build() {
		const g = new Group();
		g.position.set(PLAZA_STAGE.x, 0, PLAZA_STAGE.z);
		this._group = g;

		// The performance platform: a low raised disc, in the round, so the ring of
		// seats StageRoom deals out all face something.
		const deck = new Mesh(
			new CylinderGeometry(3.4, 3.7, 0.55, 32),
			new MeshStandardMaterial({ color: 0x1b1830, roughness: 0.6, metalness: 0.2 }),
		);
		deck.position.y = 0.275;
		deck.castShadow = true;
		deck.receiveShadow = true;
		g.add(deck);

		// A lit lip around the deck — the edge that reads as "a stage" from across
		// the plaza, and the thing that pulses while the host is speaking.
		const lip = new Mesh(
			new TorusGeometry(3.45, 0.075, 8, 48),
			new MeshBasicMaterial({ color: COL.accent }),
		);
		lip.rotation.x = Math.PI / 2;
		lip.position.y = 0.56;
		g.add(lip);
		this._lip = lip;

		// The ground ring that tells you where the venue's floor is.
		this._marker = new Mesh(
			new RingGeometry(PLAZA_STAGE.r + 0.3, PLAZA_STAGE.r + 0.55, 48),
			new MeshBasicMaterial({ color: COL.accent, transparent: true, opacity: 0.16, side: DoubleSide }),
		);
		this._marker.rotation.x = -Math.PI / 2;
		this._marker.position.y = 0.04;
		g.add(this._marker);

		// Everything with a "front" faces the middle of the plaza, so a player
		// walking up from the totem/wheel meets the backdrop head-on.
		const facing = new Group();
		facing.rotation.y = Math.atan2(-PLAZA_STAGE.x, -PLAZA_STAGE.z);
		g.add(facing);
		this._facing = facing;

		// Backdrop shell behind the performer.
		const backdrop = new Mesh(
			new CylinderGeometry(3.9, 3.9, 3.6, 24, 1, true, Math.PI * 0.62, Math.PI * 0.76),
			new MeshStandardMaterial({ color: 0x120f1d, roughness: 0.9, side: DoubleSide }),
		);
		backdrop.position.y = 1.8;
		facing.add(backdrop);

		// Two truss masts carrying the marquee above the deck, high enough to read
		// from anywhere on the seat ring (double-sided, so the back rows see it too).
		for (const side of [-1, 1]) {
			const mast = new Mesh(
				new BoxGeometry(0.22, 6.2, 0.22),
				new MeshStandardMaterial({ color: 0x2a2740, roughness: 0.6, metalness: 0.5 }),
			);
			mast.position.set(side * 2.9, 3.1, -1.9);
			facing.add(mast);
		}
		const beam = new Mesh(
			new BoxGeometry(6.2, 0.22, 0.22),
			new MeshStandardMaterial({ color: 0x2a2740, roughness: 0.6, metalness: 0.5 }),
		);
		beam.position.set(0, 6.1, -1.9);
		facing.add(beam);

		// The marquee itself: a canvas texture repainted as the show's state changes.
		const screen = makeScreenCanvas(CW, CH, SS);
		this._canvas = screen.canvas;
		this._ctx = screen.ctx;
		this._tex = makeScreenTexture(this._canvas);
		const panel = new Mesh(
			new PlaneGeometry(5.6, 2.8),
			screenMaterial(this._tex, { side: DoubleSide }),
		);
		panel.position.set(0, 4.5, -1.85);
		facing.add(panel);
		this._panel = panel;

		// A dark frame so the panel reads as a mounted screen, not a floating decal.
		const frame = new Mesh(
			new BoxGeometry(5.9, 3.1, 0.12),
			new MeshStandardMaterial({ color: 0x0c0a14, roughness: 0.8 }),
		);
		frame.position.set(0, 4.5, -1.95);
		facing.add(frame);

		this.scene.add(g);

		// Where the show client hangs the host avatar (deck top) and the crowd
		// (ground level, unrotated so the server's seat coordinates map straight
		// through without a frame change).
		this.hostAnchor = new Group();
		this.hostAnchor.position.set(0, 0.55, 0);
		this._facing.add(this.hostAnchor);
		this.audienceAnchor = new Group();
		g.add(this.audienceAnchor);
	}

	_buildPrompt() {
		this.btn = document.createElement('button');
		this.btn.className = 'ps-action pz-action';
		this.btn.hidden = true;
		this.btn.textContent = '🎤 Enter the show';
		this.btn.addEventListener('click', () => this.interact());
		document.body.appendChild(this.btn);
	}

	// ── proximity lifecycle ───────────────────────────────────────────────────
	tick(dt) {
		if (this._destroyed) return;
		this._t += dt;
		this._sinceFetch += dt * 1000;
		this._sinceDraw += dt * 1000;

		const p = this.getPlayer?.();
		if (!p) return;
		const dist = Math.hypot(p.x - PLAZA_STAGE.x, p.z - PLAZA_STAGE.z);
		const near = !!stageMarqueeInRange(p.x, p.z);
		const inside = !!stageInRange(p.x, p.z);
		// Hysteresis on the way out only: crossing the line once shouldn't flap a
		// socket open and shut while the player mills around the edge of the crowd.
		const attending = this._attending
			? dist <= PLAZA_STAGE.r + 8 + LEAVE_HYSTERESIS_M
			: inside;

		if (near !== this._near) {
			this._near = near;
			if (near) this._wake();
			else this._sleep();
		}
		if (attending !== this._attending) {
			this._attending = attending;
			if (attending) this._mountShow();
			else this._unmountShow();
		}

		// One state read while loitering near the marquee; the room feeds it while
		// attending, so polling stops the moment the socket is up.
		if (this._near && !this._show && this._sinceFetch >= REFRESH_MS) this._refresh();

		this.btn.hidden = !inside || !!this._show?.panelOpen?.();

		// Idle life: the ground ring breathes, and the deck lip glows brighter while
		// the host is speaking.
		const pulse = 0.13 + Math.sin(this._t * 1.5) * 0.05;
		this._marker.material.opacity = near ? pulse + 0.2 : pulse;
		const speaking = !!this._show?.isSpeaking?.();
		const beat = speaking ? 0.5 + Math.abs(Math.sin(this._t * 6)) * 0.5 : 0;
		this._lip.material.color.copy(new Color(this.state.phase === 'live' ? COL.hot : COL.accent)).multiplyScalar(0.55 + beat * 0.45);

		if (this._sinceDraw >= REDRAW_MS) this._draw();
		this._show?.tick?.(dt);
	}

	_wake() {
		if (this.state.phase === 'asleep') {
			this.state.phase = 'loading';
			this._draw();
		}
		this._refresh();
	}

	_sleep() {
		// Walking out of sight stops the polling. The last known state stays painted
		// so the marquee is never blank when the player glances back.
		this._sinceFetch = 0;
	}

	// The one HTTP read this landmark makes, and only while the player is near it.
	// `?coin=` derives the same plaza id the client does and answers 200 with
	// stage:null when nobody has claimed it, so "quiet landmark" is a designed
	// state rather than a 404 in the console.
	async _refresh() {
		if (this._fetching || this._destroyed) return;
		this._fetching = true;
		this._sinceFetch = 0;
		try {
			const res = await fetch(`/api/stage?coin=${encodeURIComponent(this.coin.mint || '')}`, {
				headers: { accept: 'application/json' },
			});
			if (!res.ok) throw new Error(`http ${res.status}`);
			const data = await res.json();
			if (this._destroyed) return;
			this._applyDetail(data);
		} catch (err) {
			if (this._destroyed) return;
			log.warn('[plaza-stage] show state read failed:', err?.message || err);
			// Only surface an error when we have nothing better to show; a stale but
			// real marquee beats an error card.
			if (this.state.phase === 'loading') {
				this.state.phase = 'error';
				this.state.error = 'Marquee offline';
			}
		} finally {
			this._fetching = false;
			this._draw();
		}
	}

	_applyDetail(data) {
		this._detail = data || null;
		const stage = data?.stage;
		if (!stage) {
			this.state.phase = 'unclaimed';
			this._unmountShow();
			return;
		}
		this.state.title = stage.title || `${stage.host_name || 'The host'} Live`;
		this.state.host = stage.host_name || 'AI host';
		this.state.format = stage.format || '';
		this.state.nextShowAt = Number(stage.next_show_at) || 0;
		this.state.hostAvatar = stage.host_avatar || '';
		this.state.hostWallet = data.hostWallet || null;
		this.state.hostVoice = stage.voice || 'nova';
		this.state.leaderboard = data.leaderboard || [];
		const show = data.currentShow || data.lastShow;
		this.state.totalTipsAtomic = show?.total_tips_atomic || 0;
		this.state.tipCount = show?.tip_count || 0;
		this.state.phase = data.live
			? 'live'
			: (this.state.nextShowAt > Date.now() ? 'scheduled' : 'dark');
		if (this._show) this._show.setStageDetail(data);
		// The player may have reached the venue before this read landed (or before a
		// stage existed at all) — now that there is a real show to join, join it.
		else if (this._attending) this._mountShow();
	}

	// ── the show client (lazy) ────────────────────────────────────────────────
	async _mountShow() {
		if (this._show || this._mounting || this._destroyed) return;
		this._mounting = true;
		try {
			const { PlazaStageShow } = await import('./plaza-stage-show.js');
			// The player may have walked back out while the chunk was in flight.
			if (this._destroyed || !this._attending) return;
			this._show = new PlazaStageShow({
				stageId: this.stageId,
				coin: this.coin,
				camera: this.camera,
				hostAnchor: this.hostAnchor,
				audienceAnchor: this.audienceAnchor,
				ui: this.ui,
				detail: this.state.phase === 'unclaimed' ? null : this.state,
				onShowState: (patch) => this._onShowState(patch),
			});
			await this._show.start();
			if (this._destroyed || !this._attending) { this._unmountShow(); return; }
		} catch (err) {
			log.warn('[plaza-stage] could not open the show:', err?.message || err);
			this.ui?.toast?.('The stage feed could not open. Try walking up again.', 'error');
		} finally {
			this._mounting = false;
		}
	}

	_unmountShow() {
		if (!this._show) return;
		try { this._show.dispose(); } catch (err) { log.warn('[plaza-stage] show dispose:', err?.message || err); }
		this._show = null;
		this.btn.hidden = true;
		// The socket is gone; go back to reading the marquee over HTTP.
		this._sinceFetch = REFRESH_MS;
	}

	// Live room state flows back into the marquee so the board a passer-by reads is
	// the same board the audience is watching.
	_onShowState(patch) {
		Object.assign(this.state, patch);
		this._draw();
	}

	// ── interaction ───────────────────────────────────────────────────────────
	// SYNCHRONOUS, like WheelStation.interact(): coincommunities' E-key chain tests
	// each system's return value to find the one that consumed the press, and a
	// Promise is always truthy.
	interact() {
		const p = this.getPlayer?.();
		if (!p || !stageInRange(p.x, p.z)) return false;
		if (this._show) { this._show.togglePanel(); return true; }
		if (this.state.phase === 'unclaimed') {
			this.ui?.toast?.('No host has claimed this stage yet. Put an agent on it from /stage.', 'info');
			return true;
		}
		// Attendance is mounting (or about to); tell the player something is happening.
		this.ui?.toast?.('Taking a seat…', 'info');
		return true;
	}

	/** Route a question from the in-world chat bar to the host's queue. */
	ask(text) {
		if (!this._show) return 'away';
		return this._show.ask(text);
	}

	isAttending() { return !!this._show; }

	// ── the marquee ───────────────────────────────────────────────────────────
	_draw() {
		this._sinceDraw = 0;
		const ctx = this._ctx;
		const s = this.state;

		// Backdrop: a soft vertical wash so text reads at any angle.
		const grad = ctx.createLinearGradient(0, 0, 0, CH);
		grad.addColorStop(0, COL.bg1);
		grad.addColorStop(1, COL.bg0);
		ctx.fillStyle = grad;
		ctx.fillRect(0, 0, CW, CH);
		ctx.strokeStyle = 'rgba(255,255,255,0.07)';
		ctx.lineWidth = 2;
		ctx.strokeRect(8, 8, CW - 16, CH - 16);

		if (s.phase === 'asleep' || s.phase === 'loading') return this._drawSimple('THE PLAZA STAGE', 'Reading the marquee…', COL.dim);
		if (s.phase === 'error') return this._drawSimple('THE PLAZA STAGE', s.error || 'Marquee offline', COL.dim, 'Walk up again to retry');
		if (s.phase === 'unclaimed') {
			return this._drawSimple(
				'THE PLAZA STAGE',
				'No host has claimed this stage',
				COL.accent,
				'Put your agent on it at three.ws/stage',
			);
		}

		const live = s.phase === 'live';

		// Status chip.
		ctx.font = '700 30px system-ui, -apple-system, Segoe UI, sans-serif';
		if (live) {
			ctx.fillStyle = COL.hot;
			ctx.fillText('● LIVE NOW', 40, 66);
		} else if (s.phase === 'scheduled') {
			ctx.fillStyle = COL.accent;
			ctx.fillText(`NEXT SHOW IN ${countdown(s.nextShowAt)}`, 40, 66);
		} else {
			ctx.fillStyle = COL.dim;
			ctx.fillText('DARK — BETWEEN SHOWS', 40, 66);
		}

		// Title + host.
		ctx.fillStyle = COL.text;
		ctx.font = '800 52px system-ui, -apple-system, Segoe UI, sans-serif';
		fitText(ctx, s.title || 'Untitled show', 40, 132, CW - 380);
		ctx.fillStyle = COL.dim;
		ctx.font = '400 28px system-ui, -apple-system, Segoe UI, sans-serif';
		fitText(ctx, `${s.host}${s.format ? ` · ${s.format}` : ''}`, 40, 174, CW - 380);

		// The last line the host said — the marquee doubles as a caption board for
		// anyone standing too far back to hear the spatial audio.
		if (s.lastLine) {
			ctx.fillStyle = 'rgba(255,255,255,0.05)';
			roundRect(ctx, 32, 208, CW - 64, 92, 14);
			ctx.fill();
			ctx.fillStyle = COL.text;
			ctx.font = '400 26px system-ui, -apple-system, Segoe UI, sans-serif';
			wrapText(ctx, `“${s.lastLine}”`, 50, 244, CW - 100, 34, 2);
		}

		// Tip leaderboard — the same verified, on-chain board /stage shows.
		const boardY = s.lastLine ? 330 : 240;
		ctx.fillStyle = COL.faint;
		ctx.font = '700 22px system-ui, -apple-system, Segoe UI, sans-serif';
		ctx.fillText('TOP TIPPERS', 40, boardY);
		const rows = (s.leaderboard || []).slice(0, 3);
		if (!rows.length) {
			ctx.fillStyle = COL.dim;
			ctx.font = '400 26px system-ui, -apple-system, Segoe UI, sans-serif';
			ctx.fillText(live ? 'No tips yet — take the top spot' : 'No tips on the last show', 40, boardY + 40);
		} else {
			rows.forEach((r, i) => {
				const y = boardY + 40 + i * 36;
				ctx.fillStyle = i === 0 ? COL.gold : COL.text;
				ctx.font = `${i === 0 ? 700 : 400} 26px system-ui, -apple-system, Segoe UI, sans-serif`;
				fitText(ctx, `${i + 1}. ${r.label}`, 40, y, 380);
				ctx.textAlign = 'right';
				ctx.fillText(`${fmtThree(r.total)} $THREE`, 620, y);
				ctx.textAlign = 'left';
			});
		}

		// Right rail: audience + running total.
		ctx.textAlign = 'right';
		ctx.fillStyle = COL.faint;
		ctx.font = '700 22px system-ui, -apple-system, Segoe UI, sans-serif';
		ctx.fillText('IN THE CROWD', CW - 40, 108);
		ctx.fillStyle = COL.text;
		ctx.font = '800 64px system-ui, -apple-system, Segoe UI, sans-serif';
		ctx.fillText(String(s.audience || 0), CW - 40, 172);
		ctx.fillStyle = COL.faint;
		ctx.font = '700 22px system-ui, -apple-system, Segoe UI, sans-serif';
		ctx.fillText('TIPPED THIS SHOW', CW - 40, 232);
		ctx.fillStyle = COL.ok;
		ctx.font = '800 44px system-ui, -apple-system, Segoe UI, sans-serif';
		ctx.fillText(`${fmtThree(s.totalTipsAtomic)}`, CW - 40, 280);
		ctx.fillStyle = COL.dim;
		ctx.font = '400 24px system-ui, -apple-system, Segoe UI, sans-serif';
		ctx.fillText(`$THREE · ${s.tipCount || 0} tips`, CW - 40, 314);
		ctx.textAlign = 'left';

		// Footer hint — what the player can actually do from here.
		ctx.fillStyle = COL.faint;
		ctx.font = '400 24px system-ui, -apple-system, Segoe UI, sans-serif';
		ctx.fillText(live ? 'Walk up to take a seat · E opens the show panel' : 'Walk up to check the schedule', 40, CH - 34);

		this._tex.needsUpdate = true;
	}

	_drawSimple(kicker, headline, color, foot) {
		const ctx = this._ctx;
		ctx.textAlign = 'center';
		ctx.fillStyle = COL.faint;
		ctx.font = '700 26px system-ui, -apple-system, Segoe UI, sans-serif';
		ctx.fillText(kicker, CW / 2, CH / 2 - 70);
		ctx.fillStyle = color;
		ctx.font = '800 46px system-ui, -apple-system, Segoe UI, sans-serif';
		fitText(ctx, headline, CW / 2, CH / 2 + 6, CW - 120);
		if (foot) {
			ctx.fillStyle = COL.dim;
			ctx.font = '400 26px system-ui, -apple-system, Segoe UI, sans-serif';
			ctx.fillText(foot, CW / 2, CH / 2 + 66);
		}
		ctx.textAlign = 'left';
		this._tex.needsUpdate = true;
	}

	dispose() {
		this._destroyed = true;
		this._unmountShow();
		this.btn?.remove();
		if (this._group) {
			this.scene.remove(this._group);
			this._group.traverse((n) => {
				if (!n.isMesh) return;
				n.geometry?.dispose?.();
				const mats = Array.isArray(n.material) ? n.material : [n.material];
				for (const m of mats) m?.dispose?.();
			});
			this._group = null;
		}
		this._tex?.dispose?.();
	}
}

// ── canvas helpers ───────────────────────────────────────────────────────────

// Draw text, shrinking the font until it fits `maxWidth` — a long agent name must
// never run off the marquee.
function fitText(ctx, text, x, y, maxWidth) {
	const original = ctx.font;
	let size = Number(original.match(/(\d+)px/)?.[1] || 28);
	while (size > 12 && ctx.measureText(text).width > maxWidth) {
		size -= 2;
		ctx.font = original.replace(/\d+px/, `${size}px`);
	}
	ctx.fillText(text, x, y);
	ctx.font = original;
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
	const words = String(text).split(/\s+/);
	let line = '';
	let lines = 0;
	for (const w of words) {
		const test = line ? `${line} ${w}` : w;
		if (ctx.measureText(test).width > maxWidth && line) {
			ctx.fillText(line, x, y + lines * lineHeight);
			lines++;
			if (lines >= maxLines) { ctx.fillText('…', x, y + lines * lineHeight); return; }
			line = w;
		} else {
			line = test;
		}
	}
	if (line) ctx.fillText(line, x, y + lines * lineHeight);
}

function roundRect(ctx, x, y, w, h, r) {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r);
	ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r);
	ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
}

function countdown(ms) {
	const left = Math.max(0, Number(ms || 0) - Date.now());
	const s = Math.floor(left / 1000);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
