// walk-agent-desk.js — a 3D agent desk with a live screen monitor.
//
// Places a physical desk in the walk/play scene. On the desk sits a monitor
// (the same CanvasTexture pattern as chart-screen.js) whose face shows whatever
// the agent is currently broadcasting via /api/agent-screen-stream. When a
// player walks close, a HUD overlay appears labelling the agent.
//
// The module is designed to mirror NPC + chart-screen patterns so integration
// into walk.js is a single import + call. Multiple desks can coexist (one per
// agent) — each is a self-contained group with its own SSE connection.
//
// Usage:
//   import { createAgentDeskManager } from './walk-agent-desk.js';
//   const deskMgr = createAgentDeskManager({ scene, camera, renderer });
//   deskMgr.spawn([{ agentId, agentName, avatarUrl, position, rotationY }]);
//   // in render loop:
//   deskMgr.update(dt, playerPos);
//   // on teardown:
//   deskMgr.dispose();

import {
	Group, Mesh, MeshStandardMaterial, MeshBasicMaterial,
	BoxGeometry, PlaneGeometry, CylinderGeometry,
	CanvasTexture, SRGBColorSpace, DoubleSide,
	Vector3, Box3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { getMeshoptDecoder } from './viewer/internal.js';
import { clone as cloneSkinnedScene } from 'three/addons/utils/SkeletonUtils.js';
import { AnimationManager } from './animation-manager.js';
import { createAgentScreenClient } from './shared/agent-screen-client.js';
import { log } from './shared/log.js';

// ── canvas spec — 16:9 matching the agent's screenshot format ───────────────
const CW = 1280, CH = 720;

// ── desk tuning ─────────────────────────────────────────────────────────────
const DESK_W = 1.4;       // metres wide
const DESK_D = 0.65;      // metres deep
const DESK_H = 0.75;      // metres tall (surface height)
const LEG_R = 0.035;
const MONITOR_W = 0.82;   // monitor screen width (metres)
const PROXIMITY_SHOW = 5.0;   // player within this distance shows the HUD label
const PROXIMITY_HIDE = 6.5;   // hysteresis

const DESK_COL = 0x1a1c24;
const LEG_COL = 0x12141b;
const BEZEL_COL = 0x0a0b10;

// ── palette for the idle "waiting" screen ─────────────────────────────────
const PAL = {
	bg: '#06080f',
	dim: 'rgba(255,255,255,0.28)',
	accent: '#5b8fff',
	live: '#3ddc84',
};

// ── shared GLTF loader ───────────────────────────────────────────────────────
const gltfLoader = new GLTFLoader();
// three.ws GLBs may carry EXT_meshopt_compression — decoder required before load
const meshoptReady = getMeshoptDecoder().then((d) => gltfLoader.setMeshoptDecoder(d));

/**
 * Build a desk + monitor group and attach it to the scene. Returns a desk
 * handle with { group, dispose, update(dt, playerPos) }.
 */
function createDesk(scene, opts = {}) {
	const {
		agentId,
		agentName = 'Agent',
		avatarUrl = null,
		position = [0, 0, 0],
		rotationY = 0,
		onProximity = null,     // (near:bool, agentId, agentName) → void
	} = opts;

	const group = new Group();
	group.position.set(position[0], 0, position[2]);
	group.rotation.y = rotationY;
	scene.add(group);

	// ── desk surface ─────────────────────────────────────────────────────
	const surfaceMat = new MeshStandardMaterial({ color: DESK_COL, roughness: 0.6, metalness: 0.2 });
	const surface = new Mesh(new BoxGeometry(DESK_W, 0.04, DESK_D), surfaceMat);
	surface.position.y = DESK_H;
	surface.castShadow = true;
	surface.receiveShadow = true;
	group.add(surface);

	// ── legs ─────────────────────────────────────────────────────────────
	const legMat = new MeshStandardMaterial({ color: LEG_COL, roughness: 0.4, metalness: 0.5 });
	const legH = DESK_H - 0.02;
	for (const [lx, lz] of [
		[-DESK_W / 2 + 0.08, -DESK_D / 2 + 0.08],
		[ DESK_W / 2 - 0.08, -DESK_D / 2 + 0.08],
		[-DESK_W / 2 + 0.08,  DESK_D / 2 - 0.08],
		[ DESK_W / 2 - 0.08,  DESK_D / 2 - 0.08],
	]) {
		const leg = new Mesh(new CylinderGeometry(LEG_R, LEG_R, legH, 8), legMat);
		leg.position.set(lx, legH / 2, lz);
		leg.castShadow = true;
		group.add(leg);
	}

	// ── monitor bezel ────────────────────────────────────────────────────
	const monH = (MONITOR_W * CH) / CW;
	const monY = DESK_H + 0.04 + monH / 2 + 0.16; // above surface, standing up
	const bezelMat = new MeshStandardMaterial({ color: BEZEL_COL, roughness: 0.3, metalness: 0.7 });
	const bezel = new Mesh(
		new BoxGeometry(MONITOR_W + 0.04, monH + 0.04, 0.04),
		bezelMat,
	);
	bezel.position.set(0, monY, -DESK_D / 2 + 0.15);
	bezel.castShadow = true;
	group.add(bezel);

	// Monitor neck
	const neck = new Mesh(new CylinderGeometry(0.022, 0.03, 0.18, 8), bezelMat);
	neck.position.set(0, DESK_H + 0.04 + 0.09, -DESK_D / 2 + 0.15);
	group.add(neck);

	// Monitor base
	const base = new Mesh(new BoxGeometry(0.22, 0.02, 0.14), bezelMat);
	base.position.set(0, DESK_H + 0.04, -DESK_D / 2 + 0.15);
	group.add(base);

	// ── screen canvas + texture ──────────────────────────────────────────
	const canvas = document.createElement('canvas');
	canvas.width = CW;
	canvas.height = CH;
	const ctx = canvas.getContext('2d');
	drawWaiting(ctx, agentName);

	const tex = new CanvasTexture(canvas);
	tex.colorSpace = SRGBColorSpace;
	tex.anisotropy = 4;

	const screen = new Mesh(
		new PlaneGeometry(MONITOR_W, monH),
		new MeshBasicMaterial({ map: tex, side: DoubleSide, toneMapped: false }),
	);
	screen.position.set(0, monY, -DESK_D / 2 + 0.15 + 0.023);
	// Raycast tags — carry the agentId so a crosshair/raycast hit can deep-link
	// straight to /agent-screen?agentId=… (the proximity HUD already does this).
	screen.userData.agentScreen = true;
	screen.userData.agentId = agentId;
	group.add(screen);

	// ── avatar seated behind desk ────────────────────────────────────────
	let avatar = null;
	let avatarManager = null;

	if (avatarUrl) {
		meshoptReady.then(() => gltfLoader.loadAsync(avatarUrl)).then((gltf) => {
			const model = cloneSkinnedScene(gltf.scene);

			// Scale and position: seated at the desk
			const box = new Box3().setFromObject(model);
			const standing = box.max.y - box.min.y;
			const targetH = 1.4; // seated figure should fit in ~1.4m
			const scale = standing > 0 ? targetH / standing : 1;
			model.scale.setScalar(scale);

			// Position: behind the desk, facing the monitor
			model.position.set(0, 0, DESK_D / 2 - 0.1);
			model.rotation.y = Math.PI; // face the monitor

			group.add(model);
			avatar = model;

			// Drive idle via the universal canonical clip library, which retargets the
			// pre-baked idle onto ANY humanoid rig (Mixamo, Avaturn, VRM, …). The GLB's
			// own gltf.animations are intentionally ignored — most avatars ship without
			// animation, so the shared clip is what gives the desk figure presence. A rig
			// that can't be skeleton-driven keeps its authored bind pose.
			avatarManager = new AnimationManager();
			avatarManager.attach(model, { avatarUrl });
			if (avatarManager.supportsCanonicalClips()) {
				fetch('/animations/manifest.json', { cache: 'force-cache' })
					.then((r) => {
						if (!r.ok) throw new Error(`HTTP ${r.status} fetching animation manifest`);
						return r.json();
					})
					.then((manifest) => {
						const needed = manifest.filter((d) => d.name === 'idle');
						if (!needed.length) return;
						avatarManager.setAnimationDefs(needed);
						return avatarManager.loadAll().then(() => avatarManager.play('idle'));
					})
					.catch((err) => log.warn('[agent-desk] idle clip load failed:', err));
			}
		}).catch((err) => log.warn('[agent-desk] avatar load failed:', err));
	}

	// ── live screen feed ──────────────────────────────────────────────────
	let lastFrameTs = 0;
	let isDark = true;
	let destroyed = false;

	const client = createAgentScreenClient(agentId, {
		onFrame(frame) {
			if (!frame?.data || frame.ts === lastFrameTs) return;
			lastFrameTs = frame.ts;
			isDark = false;
			const img = new Image();
			img.onload = () => {
				ctx.drawImage(img, 0, 0, CW, CH);
				tex.needsUpdate = true;
			};
			img.src = frame.data;

			// Also overlay activity text at the bottom
			if (frame.activity) {
				drawActivityOverlay(ctx, frame.activity);
				tex.needsUpdate = true;
			}
		},
		onDark() {
			isDark = true;
			drawWaiting(ctx, agentName);
			tex.needsUpdate = true;
		},
		onError() {
			// quiet — will reconnect
		},
	});
	client.connect();

	// ── proximity label HUD ──────────────────────────────────────────────
	let labelEl = null;
	let isNear = false;
	const deskWorldPos = new Vector3();

	function updateProximity(playerPos) {
		group.getWorldPosition(deskWorldPos);
		const dist = playerPos.distanceTo(deskWorldPos);
		const shouldBeNear = isNear ? dist < PROXIMITY_HIDE : dist < PROXIMITY_SHOW;
		if (shouldBeNear !== isNear) {
			isNear = shouldBeNear;
			onProximity?.(isNear, agentId, agentName);
			if (isNear) showLabel(); else hideLabel();
		}
	}

	function showLabel() {
		if (labelEl) return;
		labelEl = document.createElement('div');
		labelEl.style.cssText = `
			position:fixed;bottom:1.8rem;left:50%;transform:translateX(-50%);
			background:rgba(6,8,15,0.88);backdrop-filter:blur(10px);
			border:1px solid rgba(91,143,255,0.3);border-radius:12px;
			padding:0.55rem 1.1rem;font:600 0.85rem system-ui,sans-serif;
			color:#eef2fa;pointer-events:none;z-index:120;
			display:flex;align-items:center;gap:0.6rem;
			animation:asd-fadein 0.2s ease;
		`;
		const styleEl = document.createElement('style');
		styleEl.textContent = `@keyframes asd-fadein{from{opacity:0;transform:translateX(-50%) translateY(8px)}to{opacity:1;transform:translateX(-50%)}}`;
		document.head.appendChild(styleEl);
		labelEl.innerHTML = `
			<span style="width:8px;height:8px;border-radius:50%;background:${isDark ? '#888' : '#3ddc84'};flex:none"></span>
			<span>Watching <strong>${esc(agentName)}</strong>${isDark ? ' — offline' : ' — LIVE'}</span>
			<a href="/agent-screen?agentId=${encodeURIComponent(agentId)}" target="_blank"
				style="color:#7aaeff;text-decoration:none;font-size:0.78rem;pointer-events:auto">
				Full view ↗
			</a>
		`;
		document.body.appendChild(labelEl);
	}

	function hideLabel() {
		labelEl?.remove();
		labelEl = null;
	}

	// ── idle canvas animation ─────────────────────────────────────────────
	let canvasAnimFrame = null;
	let canvasTick = 0;
	function animateWaiting() {
		if (destroyed || !isDark) { canvasAnimFrame = null; return; }
		canvasTick += 0.016;
		drawWaiting(ctx, agentName, canvasTick);
		tex.needsUpdate = true;
		canvasAnimFrame = requestAnimationFrame(animateWaiting);
	}
	canvasAnimFrame = requestAnimationFrame(animateWaiting);

	// ── public interface ──────────────────────────────────────────────────
	function update(dt, playerPos) {
		if (destroyed) return;
		if (avatarManager) avatarManager.update(dt);
		if (!isDark && canvasAnimFrame) {
			cancelAnimationFrame(canvasAnimFrame);
			canvasAnimFrame = null;
		} else if (isDark && !canvasAnimFrame) {
			canvasAnimFrame = requestAnimationFrame(animateWaiting);
		}
		if (playerPos) updateProximity(playerPos);
	}

	function dispose() {
		destroyed = true;
		client.disconnect();
		hideLabel();
		if (canvasAnimFrame) cancelAnimationFrame(canvasAnimFrame);
		avatarManager?.detach();
		scene.remove(group);
		// Dispose geometries, materials, textures
		group.traverse((o) => {
			if (o.geometry) o.geometry.dispose();
			if (o.material) {
				if (Array.isArray(o.material)) o.material.forEach((m) => { m.map?.dispose(); m.dispose(); });
				else { o.material.map?.dispose(); o.material.dispose(); }
			}
		});
		tex.dispose();
	}

	return { group, update, dispose, getAgentId: () => agentId };
}

// ── canvas helpers ────────────────────────────────────────────────────────────

function drawWaiting(ctx, agentName, tick = 0) {
	ctx.fillStyle = PAL.bg;
	ctx.fillRect(0, 0, CW, CH);

	// Subtle grid
	ctx.strokeStyle = 'rgba(255,255,255,0.04)';
	ctx.lineWidth = 1;
	for (let x = 0; x < CW; x += 80) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CH); ctx.stroke(); }
	for (let y = 0; y < CH; y += 80) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CW, y); ctx.stroke(); }

	// Pulsing circle
	const pulse = 0.5 + 0.5 * Math.sin(tick * 2.2);
	const r0 = 32 + pulse * 8;
	ctx.beginPath();
	ctx.arc(CW / 2, CH / 2, r0, 0, Math.PI * 2);
	ctx.strokeStyle = `rgba(91,143,255,${0.15 + pulse * 0.15})`;
	ctx.lineWidth = 2;
	ctx.stroke();

	// Inner dot
	ctx.beginPath();
	ctx.arc(CW / 2, CH / 2, 10, 0, Math.PI * 2);
	ctx.fillStyle = `rgba(91,143,255,${0.35 + pulse * 0.35})`;
	ctx.fill();

	// Agent name
	ctx.font = `bold 40px system-ui,sans-serif`;
	ctx.fillStyle = 'rgba(255,255,255,0.7)';
	ctx.textAlign = 'center';
	ctx.fillText(agentName, CW / 2, CH / 2 + 90);

	// Status
	ctx.font = '28px system-ui,sans-serif';
	ctx.fillStyle = PAL.dim;
	ctx.fillText('Waiting for activity…', CW / 2, CH / 2 + 140);

	// three.ws watermark
	ctx.font = '22px system-ui,sans-serif';
	ctx.fillStyle = 'rgba(255,255,255,0.12)';
	ctx.textAlign = 'right';
	ctx.fillText('three.ws', CW - 24, CH - 20);
}

function drawActivityOverlay(ctx, activity) {
	const BAR_H = 56;
	const y = CH - BAR_H;
	// Translucent bar
	ctx.fillStyle = 'rgba(6,8,15,0.78)';
	ctx.fillRect(0, y, CW, BAR_H);
	// Activity text
	ctx.font = '26px system-ui,sans-serif';
	ctx.fillStyle = 'rgba(255,255,255,0.85)';
	ctx.textAlign = 'left';
	// Clamp text width
	const maxW = CW - 48;
	const text = truncateText(ctx, String(activity), maxW);
	ctx.fillText(text, 24, y + 36);
}

function truncateText(ctx, text, maxW) {
	if (ctx.measureText(text).width <= maxW) return text;
	let lo = 0, hi = text.length;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid;
		else hi = mid - 1;
	}
	return text.slice(0, lo) + '…';
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── manager ───────────────────────────────────────────────────────────────────

/**
 * Manages a set of agent desks in the scene.
 */
export function createAgentDeskManager({ scene, camera }) {
	const desks = new Map(); // agentId → desk handle

	function spawn(deskConfigs) {
		// Dispose any existing desks not in the new config
		const incomingIds = new Set(deskConfigs.map((c) => c.agentId));
		for (const [id, desk] of desks) {
			if (!incomingIds.has(id)) { desk.dispose(); desks.delete(id); }
		}
		// Spawn new desks
		for (const cfg of deskConfigs) {
			if (desks.has(cfg.agentId)) continue; // already live
			const desk = createDesk(scene, cfg);
			desks.set(cfg.agentId, desk);
		}
	}

	function update(dt, playerPos) {
		for (const desk of desks.values()) desk.update(dt, playerPos);
	}

	function dispose() {
		for (const desk of desks.values()) desk.dispose();
		desks.clear();
	}

	// Live desk positions for the host's radar (one POI blip per live agent).
	function positions() {
		const out = [];
		for (const desk of desks.values()) {
			out.push({ x: desk.group.position.x, z: desk.group.position.z });
		}
		return out;
	}

	return { spawn, update, dispose, positions };
}

/**
 * Fetch agents that currently have a live screen stream and return desk configs.
 * Falls back gracefully if Redis is cold or the endpoint is unavailable.
 */
export async function fetchLiveAgentDesks() {
	try {
		const res = await fetch('/api/agent-screen-active', { headers: { accept: 'application/json' } });
		if (!res.ok) return [];
		const j = await res.json();
		return Array.isArray(j.desks) ? j.desks : [];
	} catch {
		return [];
	}
}
