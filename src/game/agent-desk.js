// agent-desk — a live "working agent" desk object for the 3D world.
//
// Places a desk in the scene with:
//   • A flat-screen monitor whose face is a live CanvasTexture. When the agent
//     has a Playwright process pushing frames the monitor shows those verbatim.
//     When no frames arrive it paints a real-time activity canvas from the
//     public /api/agent-screen-stream SSE feed's `log` events — the same
//     stream the 2D watch panel and the live wall use, which backfills from
//     the agent's real agent_actions rows server-side.
//   • A keyboard + mouse prop on the desk surface.
//   • An agent avatar seated behind the desk (idle-animated, driven by the
//     same retargeting pipeline as every other avatar in the world).
//   • Proximity detection: when the local player walks within NEAR_DIST units
//     the monitor "wakes up" (brighter emissive) and a HUD prompt appears
//     offering to open the full 2D watch view.
//
// Follows chart-screen.js in every structural detail — CanvasTexture updated
// per-frame, update(dt) called from the scene loop, dispose() for cleanup.
//
// Usage:
//   import { createAgentDesk } from './agent-desk.js';
//   const desk = createAgentDesk(scene, { agentId, agentName, avatarUrl }, {
//     position: [x, 0, z],
//     rotationY: Math.PI,
//   });
//   // in the scene loop:
//   desk.update(dt, playerPosition);
//   // to open the watch panel when the player interacts:
//   desk.openWatch(); // navigates to /dashboard-next/watch?agentId=…
//   // cleanup:
//   desk.dispose();

import {
	Group, Mesh, MeshBasicMaterial, MeshStandardMaterial,
	PlaneGeometry, BoxGeometry, CylinderGeometry,
	CanvasTexture, SRGBColorSpace, DoubleSide, Vector3,
} from 'three';
import { createAgentScreenClient } from '../shared/agent-screen-client.js';

const NEAR_DIST   = 8;    // units — player proximity to activate
const REDRAW_MS   = 100;  // ~10fps canvas repaint
// Canvas resolution — 16:9 to match the 2D panel.
const CW = 1280, CH = 720;

// Monitor physical dimensions (world units).
const MON_W  = 3.6;
const MON_H  = (MON_W * CH) / CW;

// ── canvas painting ───────────────────────────────────────────────────────────

function paintDesk(ctx, tex, actions, status, agentName, t) {
	const text = '#f0f0f4', dim = 'rgba(255,255,255,0.35)', faint = 'rgba(255,255,255,0.12)';
	const up = '#5fd08a', bg0 = '#080809', bg1 = '#0d0d11';
	const pulse = 0.5 + 0.5 * Math.sin(t * 3);

	// Background gradient
	const bg = ctx.createLinearGradient(0, 0, 0, CH);
	bg.addColorStop(0, bg1);
	bg.addColorStop(1, bg0);
	ctx.fillStyle = bg;
	ctx.fillRect(0, 0, CW, CH);

	// Top bar
	ctx.fillStyle = 'rgba(255,255,255,0.03)';
	ctx.fillRect(0, 0, CW, 48);
	ctx.strokeStyle = 'rgba(255,255,255,0.05)';
	ctx.lineWidth = 1;
	ctx.beginPath(); ctx.moveTo(0, 48); ctx.lineTo(CW, 48); ctx.stroke();

	// Status dot + name
	ctx.beginPath();
	ctx.arc(28, 24, 6, 0, Math.PI * 2);
	ctx.fillStyle = status === 'live'
		? `rgba(95,208,138,${0.55 + pulse * 0.45})`
		: 'rgba(120,120,128,0.5)';
	ctx.fill();

	ctx.font = '700 16px Inter, system-ui, sans-serif';
	ctx.fillStyle = text;
	ctx.textAlign = 'left';
	ctx.textBaseline = 'middle';
	const name = (agentName || 'Agent').slice(0, 30);
	ctx.fillText(name, 48, 24);
	ctx.fillStyle = status === 'live' ? up : dim;
	ctx.font = '500 13px Inter, system-ui, sans-serif';
	ctx.fillText(status === 'live' ? '· live' : '· idle', 48 + ctx.measureText(name + '  ').width, 24);

	// Clock
	const now = new Date();
	const clock = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
	ctx.font = '600 14px Inter, system-ui, monospace';
	ctx.fillStyle = dim;
	ctx.textAlign = 'right';
	ctx.fillText(clock, CW - 20, 24);
	ctx.textAlign = 'left';

	// Terminal window
	const pad = 28;
	const winX = pad, winY = 62, winW = CW - pad * 2, winH = CH - 62 - pad;
	const r = 8;

	ctx.fillStyle = '#0c0c10';
	ctx.beginPath();
	roundRect(ctx, winX, winY, winW, winH, r);
	ctx.fill();
	ctx.strokeStyle = 'rgba(255,255,255,0.055)';
	ctx.lineWidth = 1;
	ctx.stroke();

	// Titlebar
	const tbH = 34;
	ctx.fillStyle = 'rgba(255,255,255,0.03)';
	ctx.beginPath();
	roundRect(ctx, winX, winY, winW, tbH, [r, r, 0, 0]);
	ctx.fill();
	ctx.strokeStyle = 'rgba(255,255,255,0.05)';
	ctx.beginPath(); ctx.moveTo(winX, winY + tbH); ctx.lineTo(winX + winW, winY + tbH); ctx.stroke();

	// Traffic lights
	[['#ff5f57'], ['#febc2e'], ['#28c840']].forEach(([c], i) => {
		ctx.beginPath();
		ctx.arc(winX + 16 + i * 18, winY + tbH / 2, 5, 0, Math.PI * 2);
		ctx.fillStyle = c;
		ctx.fill();
	});

	// Title
	ctx.font = '500 12px Inter, system-ui, sans-serif';
	ctx.fillStyle = faint;
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(`${name} — live activity`, winX + winW / 2, winY + tbH / 2);
	ctx.textAlign = 'left';

	// Lines
	const lH = 32;
	const cX = winX + 20;
	let lY = winY + tbH + 24;
	const maxL = Math.floor((winH - tbH - 50) / lH);

	if (!actions.length) {
		ctx.font = '500 14px "Courier New", monospace';
		ctx.fillStyle = faint;
		ctx.textBaseline = 'alphabetic';
		ctx.fillText('> Waiting for agent activity…', cX, lY);
		if (Math.sin(t * 4) > 0) {
			ctx.fillStyle = faint;
			ctx.fillRect(cX + ctx.measureText('> Waiting for agent activity…').width + 3, lY - 14, 8, 16);
		}
	} else {
		actions.slice(0, maxL).forEach((a, i) => {
			const latest = i === 0;
			const age = Math.max(0, Math.round((Date.now() - (a.ts || Date.now())) / 1000));
			const ts = age < 5 ? 'now' : age < 60 ? `${age}s` : `${Math.round(age / 60)}m`;

			ctx.textBaseline = 'alphabetic';
			ctx.font = '600 12px "Courier New", monospace';
			ctx.fillStyle = latest ? up : 'rgba(255,255,255,0.18)';
			const prefix = `  [${ts}]  `;
			ctx.fillText(prefix, cX, lY + i * lH);
			const pw = ctx.measureText(prefix).width;

			ctx.font = `${latest ? '600' : '400'} 13px "Courier New", monospace`;
			ctx.fillStyle = latest ? text : dim;
			const summary = (a.summary || a.type || 'action').slice(0, 88);
			ctx.fillText(summary, cX + pw, lY + i * lH);

			if (latest && Math.sin(t * 4) > 0) {
				const tw = pw + ctx.measureText(summary).width;
				ctx.fillStyle = up;
				ctx.fillRect(cX + tw + 3, lY + i * lH - 13, 7, 14);
			}
		});
	}

	// Status bar
	const sbY = winY + winH - 24;
	ctx.fillStyle = 'rgba(95,208,138,0.06)';
	ctx.fillRect(winX + 1, sbY, winW - 2, 23);
	ctx.strokeStyle = 'rgba(255,255,255,0.04)';
	ctx.beginPath(); ctx.moveTo(winX, sbY); ctx.lineTo(winX + winW, sbY); ctx.stroke();
	ctx.font = '500 11px Inter, system-ui, sans-serif';
	ctx.textBaseline = 'middle';
	ctx.fillStyle = 'rgba(95,208,138,0.6)';
	ctx.fillText(`three.ws · ${actions.length || 0} actions`, cX, sbY + 12);
	ctx.textAlign = 'right';
	ctx.fillStyle = faint;
	ctx.fillText('walk up · press E to watch', winX + winW - 10, sbY + 12);
	ctx.textAlign = 'left';

	tex.needsUpdate = true;
}

function roundRect(ctx, x, y, w, h, r) {
	const tl = Array.isArray(r) ? r[0] : r;
	const tr = Array.isArray(r) ? r[1] : r;
	const br = Array.isArray(r) ? r[2] : r;
	const bl = Array.isArray(r) ? r[3] : r;
	ctx.beginPath();
	ctx.moveTo(x + tl, y);
	ctx.arcTo(x + w, y, x + w, y + h, tr);
	ctx.arcTo(x + w, y + h, x, y + h, br);
	ctx.arcTo(x, y + h, x, y, bl);
	ctx.arcTo(x, y, x + w, y, tl);
	ctx.closePath();
}

// ── factory ───────────────────────────────────────────────────────────────────

/**
 * Create an agent desk and add it to the scene.
 *
 * @param {THREE.Scene} scene
 * @param {{ agentId:string, agentName:string, avatarUrl?:string }} agent
 * @param {{ position?:[number,number,number], rotationY?:number }} [opts]
 * @returns {{ group:THREE.Group, update(dt:number, playerPos?:THREE.Vector3):void, openWatch():void, dispose():void }}
 */
export function createAgentDesk(scene, agent, opts = {}) {
	const position  = opts.position  || [0, 0, 0];
	const rotationY = opts.rotationY || 0;

	const group = new Group();
	group.position.set(...position);
	group.rotation.y = rotationY;

	const metalMat  = new MeshStandardMaterial({ color: 0x1a1a1f, roughness: 0.4, metalness: 0.7 });
	const darkMat   = new MeshStandardMaterial({ color: 0x101012, roughness: 0.6, metalness: 0.3 });
	const woodMat   = new MeshStandardMaterial({ color: 0x2a1f14, roughness: 0.8, metalness: 0.0 });

	// ── Desk surface ────────────────────────────────────────────────────────
	const deskW = 4.8, deskD = 2.0, deskH = 0.08;
	const deskY = 0.78; // standard desk height
	const deskTop = new Mesh(new BoxGeometry(deskW, deskH, deskD), woodMat);
	deskTop.position.set(0, deskY, 0);
	deskTop.castShadow = true; deskTop.receiveShadow = true;
	group.add(deskTop);

	// Desk legs (4)
	for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
		const leg = new Mesh(new BoxGeometry(0.08, deskY, 0.08), metalMat);
		leg.position.set(sx * (deskW / 2 - 0.15), deskY / 2, sz * (deskD / 2 - 0.15));
		leg.castShadow = true;
		group.add(leg);
	}

	// ── Monitor stand ───────────────────────────────────────────────────────
	const standH = 0.55;
	const stand = new Mesh(new CylinderGeometry(0.04, 0.08, standH, 12), metalMat);
	stand.position.set(0, deskY + deskH / 2 + standH / 2, -0.35);
	stand.castShadow = true;
	group.add(stand);

	// Monitor base plate
	const base = new Mesh(new BoxGeometry(0.6, 0.02, 0.3), metalMat);
	base.position.set(0, deskY + deskH / 2 + 0.01, -0.35);
	base.castShadow = true; base.receiveShadow = true;
	group.add(base);

	// Monitor bezel
	const bezelMat = new MeshStandardMaterial({ color: 0x080809, roughness: 0.3, metalness: 0.8 });
	const bezel = new Mesh(
		new BoxGeometry(MON_W + 0.22, MON_H + 0.22, 0.12),
		bezelMat,
	);
	const monCY = deskY + deskH / 2 + standH + MON_H / 2 + 0.02;
	bezel.position.set(0, monCY, -0.35);
	bezel.castShadow = true;
	group.add(bezel);

	// ── Live screen face ────────────────────────────────────────────────────
	const canvas = document.createElement('canvas');
	canvas.width = CW; canvas.height = CH;
	const ctx = canvas.getContext('2d');
	const tex = new CanvasTexture(canvas);
	tex.colorSpace = SRGBColorSpace;
	tex.anisotropy = 8;

	const screenMat = new MeshBasicMaterial({ map: tex, toneMapped: false });
	const screen = new Mesh(new PlaneGeometry(MON_W, MON_H), screenMat);
	screen.position.set(0, monCY, -0.35 + 0.07);
	screen.userData.agentDesk = true;
	group.add(screen);

	// ── Keyboard ────────────────────────────────────────────────────────────
	const kb = new Mesh(new BoxGeometry(1.2, 0.03, 0.36), darkMat);
	kb.position.set(0, deskY + deskH / 2 + 0.015, 0.3);
	kb.castShadow = true; kb.receiveShadow = true;
	group.add(kb);

	// ── Mouse ───────────────────────────────────────────────────────────────
	const mouse = new Mesh(new BoxGeometry(0.1, 0.025, 0.15), darkMat);
	mouse.position.set(0.75, deskY + deskH / 2 + 0.012, 0.32);
	mouse.castShadow = true; mouse.receiveShadow = true;
	group.add(mouse);

	scene.add(group);

	// ── Live state ───────────────────────────────────────────────────────────
	let actions    = [];
	let frameImg   = null;  // latest pushed frame as an Image, or null
	let status     = 'idle';
	let destroyed  = false;
	let near       = false;
	let acc        = 0;
	let t          = 0;

	// Initial paint so the screen isn't blank before the first fetch.
	paintDesk(ctx, tex, [], 'idle', agent.agentName || 'Agent', 0);

	// Same stream the 2D watch panel and the live wall use. Frames arrive as
	// `event: frame` with `data` holding a full data URL (or null for text-only
	// beats); `event: log` backfills activity oldest-first; `event: dark` fires
	// when the caster's frame TTL lapses. Reconnect/backoff lives in the client.
	const screenClient = createAgentScreenClient(agent.agentId, {
		onFrame(frame) {
			status = 'live';
			if (typeof frame?.data === 'string' && frame.data.startsWith('data:image/')) {
				const img = new Image();
				img.onload = () => { frameImg = img; };
				img.src = frame.data;
			}
		},
		onLog(entries) {
			if (!entries?.length) return;
			// paintDesk expects newest-first rows shaped like agent-actions.
			actions = entries
				.map((e) => ({ ts: e.ts, summary: e.activity, type: e.type }))
				.reverse();
		},
		onDark() { status = 'idle'; frameImg = null; },
		onError() { status = 'idle'; },
	});

	// Signal that this desk's agent is being watched so the on-demand caster pool
	// upgrades it to a live browser feed. Throttled; fired while the player is near.
	let lastWatchPing = 0;
	function pingWatchIntent() {
		const now = Date.now();
		if (now - lastWatchPing < 20_000) return;
		lastWatchPing = now;
		try {
			fetch('/api/agent/watch-intent', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ agentId: agent.agentId }),
				keepalive: true,
			}).catch(() => {});
		} catch { /* */ }
	}

	// The SSE stream is the desk's single activity source: its `log` events
	// backfill from the caster's Redis log or the agent's real DB actions (the
	// server re-polls dark agents every ~8s), and it is public. The old direct
	// /api/agent-actions REST poll here 401'd forever for anonymous players
	// (that route is owner-only) — pure wasted requests, so it's gone.
	screenClient.connect();

	// ── public API ────────────────────────────────────────────────────────────
	return {
		group,
		screen,
		agentId: agent.agentId,

		update(dt, playerPos) {
			if (destroyed) return;
			t   += dt;
			acc += dt;

			// Proximity check — brighten screen when player is near.
			if (playerPos) {
				const deskWorldPos = new Vector3();
				group.getWorldPosition(deskWorldPos);
				const dist = playerPos.distanceTo(deskWorldPos);
				const wasNear = near;
				near = dist < NEAR_DIST;
				if (near !== wasNear) {
					// Screen emissive boost.
					screenMat.opacity = near ? 1.0 : 0.92;
				}
				if (near) pingWatchIntent();
			}

			if (acc < REDRAW_MS / 1000) return;
			acc = 0;

			if (frameImg && status === 'live') {
				ctx.drawImage(frameImg, 0, 0, CW, CH);
				tex.needsUpdate = true;
			} else {
				paintDesk(ctx, tex, actions, status, agent.agentName || 'Agent', t);
			}
		},

		openWatch() {
			const url = `/dashboard-next/watch?agentId=${encodeURIComponent(agent.agentId)}`;
			window.open(url, '_blank');
		},

		dispose() {
			destroyed = true;
			screenClient.disconnect();
			scene.remove(group);
			group.traverse((n) => {
				if (!n.isMesh) return;
				n.geometry?.dispose?.();
				const mats = Array.isArray(n.material) ? n.material : [n.material];
				for (const m of mats) { m?.map?.dispose?.(); m?.dispose?.(); }
			});
		},
	};
}
