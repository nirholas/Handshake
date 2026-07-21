// x402 Jumbotron — a second big in-world screen for every coin town, standing
// behind the Agent Exchange and dedicated to watching x402 micropayments land.
//
// Where the trading jumbotron (chart-screen.js) shows the coin's price tape, this
// one shows MONEY MOVING: every $0.01 USDC settlement an agent makes on Solana.
// Two sources feed it, both real:
//   1. The platform-wide payment feed (/api/x402-pay?feed=1) — recent paid x402
//      calls from anyone, polled on a timer, so the board is alive the moment a
//      player walks up even if they haven't triggered a round themselves.
//   2. The local ORACLE↔NOVA round driven by agent-commerce.js — pushed in here
//      stage-by-stage so the stepper animates challenge → sign → verify → settle
//      → confirmed in lockstep with the agents' speech bubbles, then drops the
//      finished receipt onto the top of the feed.
//
// The face is an HTML canvas wrapped in a CanvasTexture — the same physical-screen
// pattern as chart-screen.js — so it updates in place with no DOM overlay. Loading,
// empty, and error states are painted on the screen itself.

import {
	Group, Mesh, MeshStandardMaterial,
	PlaneGeometry, CylinderGeometry, BoxGeometry,
	DoubleSide,
} from 'three';
import { makeScreenCanvas, makeScreenTexture, screenMaterial } from './screen-texture.js';

const FEED_URL = (limit = 12) => `/api/x402-pay?feed=1&limit=${limit}`;
const POLL_MS = 8000;
const REDRAW_MS = 100;          // ~10fps — smooth pulse/scroll, cheap on the GPU
const CW = 1280, CH = 720;      // 16:9 logical layout grid for the draw code
const SS = 1.5;                 // supersample: 1920x1080 backing store, crisp text
const MAX_ROWS = 6;             // recent payments shown on the board

// Stage stepper, keyed to the SSE events /api/x402-pay emits — matches the order
// agent-commerce.js drives the round through.
const STAGES = [
	{ id: 'challenge', label: '402' },
	{ id: 'built',     label: 'Sign' },
	{ id: 'verified',  label: 'Verify' },
	{ id: 'settled',   label: 'Settle' },
	{ id: 'done',      label: 'Confirmed' },
];

// Monochrome to match the /play client, with a single green accent for money
// that has actually settled on-chain (mirrors chart-screen.js's palette).
const COL = {
	bg0: '#0a0a0c', bg1: '#121216',
	line: 'rgba(255,255,255,0.06)',
	text: '#f5f5f6', dim: '#8c8c92', faint: '#5a5a60',
	good: '#5fd08a', bad: '#e06c75',
};


function fmtUsdc(micro) {
	const n = Number(micro);
	if (!isFinite(n) || n <= 0) return '$0.01';
	const usd = n / 1e6;
	// Sub-cent micropayments (a 1000-micro dance tip is $0.001) must not floor
	// to "$0.00" on a board whose whole point is showing money move.
	if (usd >= 0.01) return '$' + usd.toFixed(2);
	return '$' + usd.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.00');
}

function shortAddr(a) {
	const s = String(a || '');
	return s.length > 11 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s || '—';
}

function shortTx(tx) {
	const s = String(tx || '');
	return s.length > 14 ? `${s.slice(0, 7)}…${s.slice(-6)}` : s;
}

function relTime(ms) {
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (s < 5) return 'now';
	if (s < 60) return s + 's';
	const m = Math.round(s / 60);
	if (m < 60) return m + 'm';
	const h = Math.round(m / 60);
	if (h < 24) return h + 'h';
	return Math.round(h / 24) + 'd';
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

/**
 * Build the x402 jumbotron and add it to the scene.
 * @param {THREE.Scene} scene
 * @param {{position?:[number,number,number], rotationY?:number, width?:number}} [opts]
 * @returns {{group, mesh, update, dispose, setStage, pushSettlement, setError, setIdle}}
 */
export function createX402Jumbotron(scene, opts = {}) {
	const position = opts.position || [8, 0, -12];
	const rotationY = opts.rotationY || 0;
	const width = opts.width || 12;
	const height = (width * CH) / CW;

	const group = new Group();
	group.position.set(position[0], position[1], position[2]);
	group.rotation.y = rotationY;

	const postH = 3.0;
	const cy = postH + height / 2;

	// Two posts + a base read as a real jumbotron rig (same construction as the
	// trading screen so the two boards feel like a matched pair on the plaza).
	const postMat = new MeshStandardMaterial({ color: 0x141417, roughness: 0.5, metalness: 0.6 });
	const postX = width / 2 - 0.6;
	for (const sx of [-postX, postX]) {
		const post = new Mesh(new CylinderGeometry(0.24, 0.3, postH + height, 16), postMat);
		post.position.set(sx, (postH + height) / 2, -0.15);
		post.castShadow = true;
		group.add(post);
	}
	const base = new Mesh(new BoxGeometry(width - 0.4, 0.36, 1.4), postMat);
	base.position.set(0, 0.18, -0.15); base.castShadow = true; base.receiveShadow = true;
	group.add(base);

	const bezel = new Mesh(
		new BoxGeometry(width + 0.5, height + 0.5, 0.36),
		new MeshStandardMaterial({ color: 0x050506, roughness: 0.4, metalness: 0.7 }),
	);
	bezel.position.set(0, cy, -0.2);
	bezel.castShadow = true;
	group.add(bezel);

	// The live face: canvas → CanvasTexture → unlit plane (glows like a screen).
	// Supersampled backing store + max anisotropy + fog/tone-mapping exemption
	// via screen-texture.js so the board stays crisp and punchy at any angle.
	const { canvas, ctx } = makeScreenCanvas(CW, CH, SS);
	const tex = makeScreenTexture(canvas);
	const panel = new Mesh(
		new PlaneGeometry(width, height),
		screenMaterial(tex, { side: DoubleSide }),
	);
	panel.position.set(0, cy, 0.01);
	panel.userData.x402Jumbotron = true;
	group.add(panel);

	scene.add(group);

	// ── live state ──────────────────────────────────────────────────────────
	let globalFeed = [];      // normalized rows from the platform-wide feed
	const localFeed = [];     // settlements from the in-world ORACLE↔NOVA round
	const seenTx = new Set(); // dedup across both sources
	const firstSeen = new Map(); // row key → t when it first appeared (slide-in)
	let current = null;       // { stage, amount, buyer, seller, topic } while a round runs
	let errorState = null;    // { stage, message }
	let status = 'loading';   // loading | live | empty | error
	let sessionTotal = 0;     // USD paid by the in-world agents this session
	let pollTimer = null;
	let destroyed = false;
	let acc = 0, t = 0;

	function rowKey(r) { return r.tx || `${r.ts}:${r.label}`; }

	async function fetchFeed() {
		try {
			const r = await fetch(FEED_URL(12), { headers: { accept: 'application/json' } });
			if (!r.ok) throw new Error('HTTP ' + r.status);
			const data = await r.json();
			const items = Array.isArray(data?.items) ? data.items : [];
			globalFeed = items
				.filter((it) => !seenTx.has(it.tx))           // local rows win the dedup
				.map((it) => ({
					ts: Number(it.ts) || Date.now(),
					label: it.tool ? String(it.tool).replace(/_/g, ' ') : 'x402 call',
					sub: it.argsSummary ? String(it.argsSummary) : 'on-chain settlement',
					amount: it.amount,
					tx: it.tx || null,
					kind: 'global',
				}));
			if (status === 'loading' || status === 'error') {
				status = (globalFeed.length || localFeed.length) ? 'live' : 'empty';
			}
		} catch {
			if (!globalFeed.length && !localFeed.length) status = 'error';
		}
	}

	function poll() {
		if (destroyed) return;
		clearTimeout(pollTimer);
		fetchFeed().finally(() => {
			if (destroyed) return;
			pollTimer = setTimeout(poll, POLL_MS);
		});
	}

	// Merge both sources, newest first, deduped, capped to the board height.
	function rows() {
		const merged = [...localFeed, ...globalFeed]
			.sort((a, b) => b.ts - a.ts)
			.slice(0, MAX_ROWS);
		return merged;
	}

	// ── canvas rendering ──────────────────────────────────────────────────────
	function draw() {
		const pulse = 0.55 + 0.45 * Math.sin(t * 4);
		const padX = 44;

		// Background
		const bg = ctx.createLinearGradient(0, 0, 0, CH);
		bg.addColorStop(0, COL.bg1); bg.addColorStop(1, COL.bg0);
		ctx.fillStyle = bg; ctx.fillRect(0, 0, CW, CH);

		// Header --------------------------------------------------------------
		ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
		ctx.fillStyle = COL.text;
		ctx.font = '800 34px Inter, system-ui, sans-serif';
		ctx.fillText('AGENT EXCHANGE', padX, 56);
		ctx.fillStyle = COL.dim;
		ctx.font = '600 18px Inter, system-ui, sans-serif';
		ctx.fillText('LIVE x402 MICROPAYMENTS · SOLANA MAINNET', padX, 82);

		// live/idle badge + session total (top-right)
		const live = !!current && !errorState;
		const badgeW = 108, badgeH = 38, bx = CW - padX - badgeW, by = 30;
		roundRect(ctx, bx, by, badgeW, badgeH, 19);
		ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fill();
		ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1; ctx.stroke();
		ctx.beginPath();
		ctx.arc(bx + 24, by + badgeH / 2, 6, 0, Math.PI * 2);
		ctx.fillStyle = live ? `rgba(95,208,138,${pulse})`
			: status === 'error' ? COL.bad : COL.faint;
		ctx.fill();
		ctx.fillStyle = COL.text; ctx.font = '700 17px Inter, system-ui, sans-serif';
		ctx.fillText(live ? 'PAYING' : status === 'error' ? 'OFFLINE' : 'LIVE', bx + 42, by + 25);
		if (sessionTotal > 0) {
			ctx.fillStyle = COL.dim; ctx.font = '600 15px Inter, system-ui, sans-serif';
			ctx.textAlign = 'right';
			ctx.fillText(`$${sessionTotal.toFixed(2)} paid here this session`, CW - padX, by - 8);
			ctx.textAlign = 'left';
		}

		// Stage area ----------------------------------------------------------
		const stageTop = 116, stageBot = 312;
		ctx.strokeStyle = COL.line; ctx.lineWidth = 1;
		ctx.beginPath(); ctx.moveTo(padX, stageBot + 10); ctx.lineTo(CW - padX, stageBot + 10); ctx.stroke();

		if (errorState) {
			ctx.fillStyle = COL.bad; ctx.font = '800 30px Inter, system-ui, sans-serif';
			ctx.fillText('✕ Payment failed', padX, stageTop + 44);
			ctx.fillStyle = COL.dim; ctx.font = '600 20px Inter, system-ui, sans-serif';
			ctx.fillText(errorState.message || 'No funds were moved.', padX, stageTop + 80);
			drawStepper(stageTop + 120, errorState.stage, true);
		} else if (current) {
			// who → who + amount
			ctx.fillStyle = COL.text; ctx.font = '800 38px Inter, system-ui, sans-serif';
			const flow = `${current.buyer}  →  ${current.seller}`;
			ctx.fillText(flow, padX, stageTop + 42);
			ctx.fillStyle = COL.good; ctx.font = '800 32px Inter, system-ui, sans-serif';
			ctx.textAlign = 'right';
			ctx.fillText(`${fmtUsdc(current.amount)} USDC`, CW - padX, stageTop + 40);
			ctx.textAlign = 'left';
			// active stage label
			const sIdx = STAGES.findIndex((s) => s.id === current.stage);
			const labels = {
				challenge: 'Issuing 402 payment challenge…',
				built: 'Signing the Solana transfer…',
				verified: 'Verifying payment with the facilitator…',
				settled: 'Settling on-chain…',
				done: 'Confirmed on Solana ✓',
			};
			ctx.fillStyle = COL.dim; ctx.font = '600 22px Inter, system-ui, sans-serif';
			ctx.fillText(labels[current.stage] || 'Processing…', padX, stageTop + 84);
			drawStepper(stageTop + 124, current.stage, false);
		} else {
			// idle hero
			ctx.fillStyle = COL.text; ctx.font = '800 34px Inter, system-ui, sans-serif';
			ctx.fillText('Two AI agents paying each other, live on Solana', padX, stageTop + 44);
			ctx.fillStyle = COL.dim; ctx.font = '600 21px Inter, system-ui, sans-serif';
			ctx.fillText('Walk up to ORACLE & NOVA and press E to trigger a real USDC payment.', padX, stageTop + 82);
			drawStepper(stageTop + 124, null, false);
		}

		// Feed ----------------------------------------------------------------
		ctx.fillStyle = COL.faint; ctx.font = '700 16px Inter, system-ui, sans-serif';
		ctx.fillText('RECENT PAYMENTS', padX, stageBot + 44);
		ctx.textAlign = 'right';
		ctx.fillText('solscan.io ↗', CW - padX, stageBot + 44);
		ctx.textAlign = 'left';

		const list = rows();
		const feedTop = stageBot + 64, rowH = 56;
		if (!list.length) {
			ctx.fillStyle = COL.dim; ctx.font = '600 20px Inter, system-ui, sans-serif';
			const msg = status === 'error' ? 'Payment feed unavailable — retrying…'
				: status === 'loading' ? 'Loading recent on-chain payments…'
				: 'No payments yet — be the first to trigger one.';
			ctx.fillText(msg, padX, feedTop + 36);
		} else {
			list.forEach((r, i) => {
				const key = rowKey(r);
				if (!firstSeen.has(key)) firstSeen.set(key, t);
				const age = t - firstSeen.get(key);
				const slide = Math.min(1, age / 0.4);            // 0→1 slide-in
				const y = feedTop + i * rowH + (1 - slide) * 14;
				const alpha = 0.35 + 0.65 * slide;
				ctx.globalAlpha = alpha;

				// status dot
				ctx.beginPath(); ctx.arc(padX + 7, y + 18, 6, 0, Math.PI * 2);
				ctx.fillStyle = r.kind === 'local' ? COL.good : 'rgba(255,255,255,0.45)';
				ctx.fill();

				// primary label
				ctx.fillStyle = COL.text; ctx.font = '700 21px Inter, system-ui, sans-serif';
				ctx.fillText(r.label, padX + 26, y + 16);
				// sub
				ctx.fillStyle = COL.dim; ctx.font = '600 16px Inter, system-ui, sans-serif';
				ctx.fillText(r.sub, padX + 26, y + 38);

				// amount (right)
				ctx.textAlign = 'right';
				ctx.fillStyle = COL.good; ctx.font = '800 22px Inter, system-ui, sans-serif';
				ctx.fillText(`${fmtUsdc(r.amount)} USDC`, CW - padX, y + 16);
				// tx + time (right, dim)
				ctx.fillStyle = COL.faint; ctx.font = '600 15px Inter, system-ui, sans-serif';
				const meta = (r.tx ? shortTx(r.tx) + '  ·  ' : '') + relTime(r.ts);
				ctx.fillText(meta, CW - padX, y + 38);
				ctx.textAlign = 'left';

				ctx.globalAlpha = 1;
				if (i < list.length - 1) {
					ctx.strokeStyle = COL.line; ctx.beginPath();
					ctx.moveTo(padX, y + rowH - 8); ctx.lineTo(CW - padX, y + rowH - 8); ctx.stroke();
				}
			});
		}

		tex.needsUpdate = true;
	}

	function drawStepper(y, activeStage, isError) {
		const padX = 44;
		const activeIdx = activeStage ? STAGES.findIndex((s) => s.id === activeStage) : -1;
		const colW = (CW - padX * 2) / STAGES.length;
		const pulse = 0.5 + 0.5 * Math.sin(t * 4);
		STAGES.forEach((s, i) => {
			const cx = padX + colW * i;
			const done = activeIdx >= 0 && i < activeIdx;
			const isActive = i === activeIdx;
			const errHere = isError && isActive;
			// connector dot bar
			const barW = colW - 24;
			roundRect(ctx, cx, y, barW, 4, 2);
			if (errHere) ctx.fillStyle = COL.bad;
			else if (done) ctx.fillStyle = '#ffffff';
			else if (isActive) ctx.fillStyle = `rgba(255,255,255,${0.35 + pulse * 0.5})`;
			else ctx.fillStyle = 'rgba(255,255,255,0.1)';
			ctx.fill();
			// label
			ctx.fillStyle = errHere ? COL.bad
				: done ? COL.text : isActive ? COL.dim : COL.faint;
			ctx.font = '700 15px Inter, system-ui, sans-serif';
			ctx.fillText(s.label.toUpperCase(), cx, y + 26);
		});
	}

	// first paint + go live
	draw();
	poll();

	return {
		group,
		mesh: panel,
		// Drive the live in-world round (called by agent-commerce.js).
		setStage({ topic, stage, amount, buyer = 'NOVA', seller = 'ORACLE' } = {}) {
			errorState = null;
			current = { topic, stage: stage || 'challenge', amount, buyer, seller };
			status = 'live';
		},
		// A real settlement landed — drop it on the top of the feed.
		pushSettlement(payment = {}, intel = {}) {
			const topic = intel.topic || 'model';
			const detail = intel.stat || intel.headline || 'inspected';
			const entry = {
				ts: Date.now(),
				label: 'NOVA → ORACLE',
				sub: `inspect ${topic} · ${detail}`.trim(),
				amount: payment.amount,
				tx: payment.tx || null,
				kind: 'local',
			};
			if (entry.tx) seenTx.add(entry.tx);
			localFeed.unshift(entry);
			if (localFeed.length > MAX_ROWS) localFeed.length = MAX_ROWS;
			sessionTotal += (Number(payment.amount) / 1e6) || 0;
			status = 'live';
		},
		setError(stage, message) {
			current = null;
			errorState = { stage: stage || 'settled', message: message || 'No funds were moved.' };
		},
		// Revert the hero to idle (feed persists).
		setIdle() {
			current = null;
			errorState = null;
		},
		update(dt) {
			if (destroyed) return;
			t += dt;
			acc += dt;
			if (acc >= REDRAW_MS / 1000) { acc = 0; draw(); }
		},
		dispose() {
			destroyed = true;
			clearTimeout(pollTimer);
			scene.remove(group);
			group.traverse((n) => {
				if (n.isMesh) {
					n.geometry?.dispose?.();
					const mats = Array.isArray(n.material) ? n.material : [n.material];
					for (const mm of mats) { mm?.map?.dispose?.(); mm?.dispose?.(); }
				}
			});
		},
	};
}
