// Agent Exchange, two NPC AI agents who pay each other on-chain, living inside
// every coin town in /play.
//
// This ports the /agent-exchange demo into the walkaround world: instead of two
// iframed avatars on a flat page, two GLB-bodied agents stand in the plaza. Walk
// up to them and trigger a round, they negotiate in speech bubbles while the
// buyer (NOVA) pays the seller (ORACLE) in USDC to inspect a real 3D model
// through the server-side x402 payer (/api/x402-pay: challenge → sign → verify →
// dispatch → settle, streamed as SSE). The paid call is the platform's own
// `inspect_model` MCP tool, so the "intel" NOVA buys is a real glTF report
// (vertices, triangles, materials). Every settlement is real USDC on Solana
// mainnet, with a Solscan link in the receipt.
//
// Built per-world by coincommunities.js, every coin town hosts the exchange;
// the paid call and the settlement rail are coin-agnostic, so the same two
// agents work every plaza. The payment round only fires on an explicit player
// interaction (E / tap), so the agent wallet is never drained on a timer.

import {
	Group, Mesh, MeshBasicMaterial, RingGeometry, PlaneGeometry,
	CanvasTexture, SRGBColorSpace, DoubleSide, Vector3,
} from 'three';
import { AnimationManager } from '../animation-manager.js';
import { resolveAvatarUrl, buildAvatar, loadManifest, MANIFEST_URL, CLIP_IDLE } from './avatar-rig.js';
import { createX402Jumbotron } from './x402-jumbotron.js';
import { log } from '../shared/log.js';

// Where the two agents stand, off to the right of the totem so a player
// entering the town sees them but doesn't spawn on top of them.
const EXCHANGE_CENTER = new Vector3(8, 0, -6);
const AGENT_GAP = 3.2;          // metres between the two agents
const INTERACT_RANGE = 6.5;     // how close the player must be to trigger a round
const ROUND_COOLDOWN_MS = 9000; // min time between paid rounds (one real payment each)
const BUBBLE_MS = 5200;

// What NOVA buys from ORACLE: the platform's own `tools/list` MCP call, the
// simplest, fastest paid tool (no args, no file fetch), so a round settles in a
// beat. The "intel" is ORACLE's live service catalog (its priced skills).
const PAID_TOOL = 'tools/list';
const PAID_LABEL = 'service catalog';

// Stage labels for the HUD stepper, keyed to the SSE events /api/x402-pay emits.
const STAGES = [
	{ id: 'challenge', label: '402' },
	{ id: 'built',     label: 'Sign' },
	{ id: 'verified',  label: 'Verify' },
	{ id: 'settled',   label: 'Settle' },
	{ id: 'done',      label: 'Confirmed' },
];

// Scripted dialogue, matched to each stage. SELLER hosts the catalog; BUYER pays.
const LINES = {
	seller: {
		idle:      'My service catalog, priced skills, paid per call in USDC, on-chain.',
		challenge: 'Payment challenge issued. Awaiting your signed transfer…',
		built:     'Transfer received. Forwarding to the facilitator…',
		verified:  'Payment verified. Pulling the catalog…',
		settled:   'Funds confirmed on-chain. Sending the list.',
		done:      (summary) => `Catalog: ${summary}`,
		error:     'Payment failed, no charge made.',
	},
	buyer: {
		idle:      'I need alpha. Paying now.',
		challenge: 'Building and signing the Solana transfer…',
		built:     'Signed. Sending to the facilitator for verification.',
		verified:  'Verified on-chain. Waiting on settlement…',
		settled:   'Settled. Collecting the catalog.',
		done:      (count) => `Got it, ${count}. Indexing your services.`,
		error:     'Transaction rolled back. Wallet unchanged.',
	},
};

// Summarize ORACLE's catalog from a tools/list result: how many priced skills it
// offers and the cheapest price, so the agents can speak it and the receipt can
// headline it.
function summarizeCatalog(intel) {
	const tools = intel?.result?.tools || [];
	const n = tools.length;
	const prices = tools
		.map((t) => Number(t?.pricing?.amount_usdc))
		.filter((v) => Number.isFinite(v) && v > 0);
	const min = prices.length ? Math.min(...prices) : null;
	const fromStr = min != null ? `from $${min < 0.01 ? min.toFixed(4) : min.toFixed(2)}` : '';
	const count = n ? `${n} service${n === 1 ? '' : 's'}` : 'catalog ready';
	return {
		headline: n ? `${count} on offer${fromStr ? ` · ${fromStr}` : ''}` : 'catalog delivered',
		count,
		stat: fromStr,
		isError: !!intel?.result?.isError,
	};
}

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Format a USDC dollar amount, keeping sub-cent micropayments legible (so a
// $0.001 settlement reads as "$0.0010", never "$0.00").
const fmtUsd = (n) => {
	const v = Number(n) || 0;
	return '$' + (v >= 0.01 || v === 0 ? v.toFixed(2) : v.toFixed(4));
};
const fmtUsdcAmount = (micro) => `${((Number(micro) || 0) / 1e6).toFixed(4)} USDC`;

// One agent: its avatar rig + animation, a nameplate, and a transient speech
// bubble. Mirrors RemotePlayer's DOM/anim shape so the agents read as first-class
// inhabitants of the world, not a bolted-on widget.
class Agent {
	constructor(scene, { name, role, avatar, pos, yaw }) {
		this.scene = scene;
		this.role = role;
		this.height = 1.7;
		this.rig = new Group();
		this.rig.position.copy(pos);
		this.rig.rotation.y = yaw;
		this.baseYaw = yaw;
		scene.add(this.rig);
		this.anim = new AnimationManager();

		this.label = document.createElement('div');
		this.label.className = 'cc-label ac-name';
		this.label.textContent = name;
		document.body.appendChild(this.label);

		this.bubble = null;
		this._bubbleTimer = null;

		// Locomotion clips only: _gesture() loads any named clip on demand from the
		// manifest, so the agents don't need the full library up front.
		resolveAvatarUrl(avatar)
			.then((u) => buildAvatar(this.rig, u, this.anim, { clips: 'locomotion' }))
			.then(({ height }) => { if (!this._disposed) this.height = height; })
			.catch(() => {});
	}
	say(text) {
		if (this.bubble) this.bubble.remove();
		this.bubble = document.createElement('div');
		this.bubble.className = 'cc-bubble ac-bubble';
		this.bubble.textContent = text;
		document.body.appendChild(this.bubble);
		clearTimeout(this._bubbleTimer);
		this._bubbleTimer = setTimeout(() => { this.bubble?.remove(); this.bubble = null; }, BUBBLE_MS);
	}
	tick(dt) { this.anim.update(dt); }
	dispose() {
		this._disposed = true;
		this.scene.remove(this.rig);
		this.label.remove();
		this.bubble?.remove();
		clearTimeout(this._bubbleTimer);
		clearTimeout(this._gestureTimer);
	}
}

export class AgentCommerce {
	constructor({ scene, camera, renderer, getPlayer, ui }) {
		this.scene = scene;
		this.camera = camera;
		this.renderer = renderer;
		this.getPlayer = getPlayer;
		this.ui = ui;

		this.busy = false;
		this.lastRoundAt = 0;
		this.topicIdx = 0;
		this.sessionTotal = 0;
		this._inRange = false;
		this._manifest = null;
		this._disposed = false;
		// One controller covers every fetch this module starts (manifest + the
		// x402-pay SSE stream) so dispose() can cut them all off at once.
		this._abort = new AbortController();
		this._sseReader = null;

		this._injectStyles();

		// Seller on the left, buyer on the right, turned to face each other.
		const left = EXCHANGE_CENTER.clone().setX(EXCHANGE_CENTER.x - AGENT_GAP / 2);
		const right = EXCHANGE_CENTER.clone().setX(EXCHANGE_CENTER.x + AGENT_GAP / 2);
		this.seller = new Agent(scene, { name: 'ORACLE', role: 'seller', avatar: '/avatars/default.glb', pos: left, yaw: Math.PI / 2 });
		this.buyer  = new Agent(scene, { name: 'NOVA',   role: 'buyer',  avatar: '/avatars/cz.glb',      pos: right, yaw: -Math.PI / 2 });

		this._buildMarker();
		this._buildPromptAndPanel();

		// A big jumbotron behind the agents, facing the plaza, so anyone in the
		// town can watch the payments land on a screen, not just the player who
		// walked up and triggered the round. It pulls the real platform-wide x402
		// feed on its own, then the live local round is pushed into it stage by
		// stage from _runRound below.
		this.jumbotron = createX402Jumbotron(scene, {
			position: [EXCHANGE_CENTER.x, 0, EXCHANGE_CENTER.z - 7],
			rotationY: 0,
			width: 12,
		});

		// Pull the full clip manifest so gestures can reach any animation (the
		// shared emote set is only the first six). Idempotent + cached.
		loadManifest();
		fetch(MANIFEST_URL, { cache: 'force-cache', signal: this._abort.signal })
			.then((r) => (r.ok ? r.json() : []))
			.then((m) => { this._manifest = Array.isArray(m) ? m : []; })
			.catch(() => { this._manifest = []; });

		// Gentle nudge so players discover the agents exist.
		clearTimeout(this._introTimer);
		this._introTimer = setTimeout(() => {
			this.ui?.toast?.('Two AI agents are trading on-chain by the plaza, walk over and press E to watch.', 'info');
		}, 5200);
	}

	// A glowing ground ring + a floating sign marking the exchange, so the spot
	// reads as a place, not two avatars standing in a field.
	_buildMarker() {
		this.marker = new Group();
		this.marker.position.copy(EXCHANGE_CENTER);

		const ring = new Mesh(
			new RingGeometry(1.7, 2.15, 56),
			new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, side: DoubleSide }),
		);
		ring.rotation.x = -Math.PI / 2;
		ring.position.y = 0.02;
		this.marker.add(ring);
		this._ring = ring;

		this.sign = this._signMesh('AGENT EXCHANGE', 'live x402 payments · on-chain');
		this.sign.position.set(0, 3.4, 0);
		this.marker.add(this.sign);

		this.scene.add(this.marker);
	}

	_signMesh(title, sub) {
		const c = document.createElement('canvas'); c.width = 512; c.height = 160;
		const x = c.getContext('2d');
		x.clearRect(0, 0, 512, 160);
		x.textAlign = 'center';
		x.fillStyle = '#ffffff';
		x.font = '800 54px Inter, system-ui, sans-serif';
		x.fillText(title, 256, 62);
		x.fillStyle = 'rgba(255,255,255,0.62)';
		x.font = '600 26px Inter, system-ui, sans-serif';
		x.fillText(sub, 256, 104);
		const tex = new CanvasTexture(c); tex.colorSpace = SRGBColorSpace;
		const m = new Mesh(new PlaneGeometry(4.6, 1.44), new MeshBasicMaterial({ map: tex, transparent: true, side: DoubleSide }));
		return m;
	}

	_injectStyles() {
		if (document.getElementById('ac-styles')) return;
		const s = document.createElement('style');
		s.id = 'ac-styles';
		s.textContent = `
		.ac-name { color: #fff; }
		.ac-prompt {
			position: fixed; left: 0; top: 0; z-index: 16; pointer-events: none;
			transform: translate(-50%, -100%); white-space: nowrap;
			background: var(--cc-panel-solid, #0c0c0e); border: 1px solid var(--cc-edge, rgba(255,255,255,0.12));
			color: var(--cc-text, #f5f5f6); font-size: 12px; font-weight: 700; letter-spacing: 0.04em;
			padding: 6px 11px; border-radius: var(--cc-radius, 4px); box-shadow: var(--cc-glow, 0 0 14px rgba(255,255,255,0.3));
			text-transform: uppercase; transition: opacity 0.18s ease; opacity: 0;
		}
		.ac-prompt.ac-show { opacity: 1; }
		.ac-prompt .ac-key {
			display: inline-block; min-width: 16px; text-align: center; margin-right: 5px;
			background: #fff; color: var(--cc-ink, #060607); border-radius: 3px; padding: 0 4px;
		}
		.ac-panel {
			position: fixed; left: 50%; top: 88px; transform: translateX(-50%) translateY(-8px);
			z-index: 24; width: min(440px, calc(100vw - 28px));
			background: var(--cc-panel, rgba(12,12,14,0.92)); -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
			border: 1px solid var(--cc-edge, rgba(255,255,255,0.12)); border-radius: var(--cc-radius, 4px);
			box-shadow: var(--cc-shadow, 0 16px 50px rgba(0,0,0,0.7));
			color: var(--cc-text, #f5f5f6); padding: 12px 14px; pointer-events: none;
			opacity: 0; transition: opacity 0.22s ease, transform 0.22s ease;
		}
		.ac-panel.ac-show { opacity: 1; transform: translateX(-50%) translateY(0); }
		.ac-panel a { pointer-events: auto; }
		.ac-ph { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
		.ac-pt { font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--cc-dim, #8c8c92); }
		.ac-pt b { color: var(--cc-text, #f5f5f6); }
		.ac-total { font-size: 12px; font-weight: 700; color: var(--cc-text, #f5f5f6); }
		.ac-total.ac-flash { animation: ac-flash 0.6s ease; }
		@keyframes ac-flash { 0%,100% { color: var(--cc-text,#f5f5f6); } 40% { color: #fff; text-shadow: 0 0 12px rgba(255,255,255,0.8); } }
		.ac-steps { display: flex; gap: 6px; }
		.ac-step {
			flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px;
			font-size: 10px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
			color: var(--cc-faint, #5a5a60);
		}
		.ac-step .ac-dot { width: 100%; height: 3px; border-radius: 2px; background: var(--cc-edge-soft, rgba(255,255,255,0.08)); transition: background 0.2s ease; }
		.ac-step.ac-active { color: var(--cc-dim, #8c8c92); }
		.ac-step.ac-active .ac-dot { background: rgba(255,255,255,0.45); animation: ac-pulse 1s ease-in-out infinite; }
		.ac-step.ac-done { color: var(--cc-text, #f5f5f6); }
		.ac-step.ac-done .ac-dot { background: #fff; box-shadow: 0 0 8px rgba(255,255,255,0.6); }
		.ac-step.ac-err { color: var(--cc-text, #f5f5f6); }
		.ac-step.ac-err .ac-dot { background: rgba(255,255,255,0.3); }
		@keyframes ac-pulse { 0%,100% { opacity: 0.5; } 50% { opacity: 1; } }
		.ac-receipt { margin-top: 11px; padding-top: 11px; border-top: 1px solid var(--cc-edge-soft, rgba(255,255,255,0.08)); font-size: 12px; }
		.ac-rrow { display: flex; justify-content: space-between; gap: 12px; padding: 2px 0; color: var(--cc-dim, #8c8c92); }
		.ac-rrow .ac-v { color: var(--cc-text, #f5f5f6); font-variant-numeric: tabular-nums; }
		.ac-rrow a { color: #fff; text-decoration: none; border-bottom: 1px solid rgba(255,255,255,0.4); }
		.ac-rrow a:hover { border-bottom-color: #fff; }
		.ac-headline { margin-top: 9px; font-size: 12.5px; line-height: 1.45; color: var(--cc-text, #f5f5f6); }
		.ac-sig { font-weight: 800; letter-spacing: 0.04em; margin-right: 6px; }
		.ac-err-msg { margin-top: 10px; font-size: 12.5px; color: var(--cc-text, #f5f5f6); }
		.ac-err-msg a { color: #fff; border-bottom: 1px solid rgba(255,255,255,0.4); text-decoration: none; }
		`;
		document.head.appendChild(s);
	}

	_buildPromptAndPanel() {
		this.prompt = document.createElement('div');
		this.prompt.className = 'ac-prompt';
		this.prompt.innerHTML = '<span class="ac-key">E</span> Watch a live on-chain payment';
		document.body.appendChild(this.prompt);

		this.panel = document.createElement('div');
		this.panel.className = 'ac-panel';
		document.body.appendChild(this.panel);
	}

	// True when the player is standing close enough to trigger a round.
	_playerNear() {
		const p = this.getPlayer?.();
		if (!p) return false;
		const dx = p.x - EXCHANGE_CENTER.x, dz = p.z - EXCHANGE_CENTER.z;
		return Math.hypot(dx, dz) <= INTERACT_RANGE;
	}

	// Project a world point to a screen-space DOM transform, hiding the node when
	// it falls behind the camera (same math as coincommunities._updateLabels).
	_place(node, x, y, z) {
		const w = this.renderer.domElement.clientWidth, h = this.renderer.domElement.clientHeight;
		const v = new Vector3(x, y, z).project(this.camera);
		if (v.z > 1 || v.z < -1) { node.style.display = 'none'; return; }
		node.style.display = '';
		node.style.transform = `translate(-50%, -100%) translate(${(v.x * 0.5 + 0.5) * w}px, ${(-v.y * 0.5 + 0.5) * h}px)`;
	}

	tick(dt) {
		this.seller.tick(dt);
		this.buyer.tick(dt);
		this.jumbotron?.update(dt);

		// Billboard the sign to face the camera; breathe the ground ring.
		if (this.sign) {
			const c = this.camera.position;
			this.sign.rotation.y = Math.atan2(c.x - EXCHANGE_CENTER.x, c.z - EXCHANGE_CENTER.z);
		}
		if (this._ring) {
			this._ringT = (this._ringT || 0) + dt;
			this._ring.material.opacity = 0.16 + 0.12 * (0.5 + 0.5 * Math.sin(this._ringT * 2));
		}

		// Nameplates + bubbles ride above each agent's head.
		for (const a of [this.seller, this.buyer]) {
			this._place(a.label, a.rig.position.x, a.rig.position.y + a.height + 0.2, a.rig.position.z);
			if (a.bubble) this._place(a.bubble, a.rig.position.x, a.rig.position.y + a.height + 0.7, a.rig.position.z);
		}

		// Proximity prompt, shown only when idle and in range.
		const near = this._playerNear();
		if (near !== this._inRange) {
			this._inRange = near;
			this.prompt.classList.toggle('ac-show', near && !this.busy);
		}
		if (near && !this.busy) {
			this.prompt.classList.add('ac-show');
			this._place(this.prompt, EXCHANGE_CENTER.x, 4.4, EXCHANGE_CENTER.z);
		} else {
			this.prompt.classList.remove('ac-show');
		}
	}

	// Cast a tap/click against the agents + their ring; returns true (and starts a
	// round) if the player tapped the exchange while in range. Lets touch players
	// trigger it without a keyboard.
	tryActivateAt(raycaster) {
		if (!this._playerNear()) return false;
		const targets = [this.seller.rig, this.buyer.rig, this.marker];
		const hit = raycaster.intersectObjects(targets, true).length > 0;
		if (hit) { this.interact(); return true; }
		return false;
	}

	// Player pressed E (or tapped the agents): run one real paid round, unless one
	// is already in flight or we're inside the cooldown.
	interact() {
		if (this.busy) return;
		if (!this._playerNear()) return;
		const now = (typeof performance !== 'undefined' ? performance.now() : 0);
		if (now - this.lastRoundAt < ROUND_COOLDOWN_MS) {
			this.ui?.toast?.('Give the agents a moment, settling the last payment.', 'info');
			return;
		}
		this._runRound().catch((err) => log.warn('[agent-commerce] round failed:', err?.message));
	}

	// Load a one-shot gesture clip from the full manifest and play it, returning to
	// idle after. No-op if the clip isn't in the manifest.
	async _gesture(agent, name) {
		const def = this._manifest?.find((d) => d.name === name);
		if (!def?.url) return;
		try {
			if (!agent.anim.isLoaded(name)) await agent.anim.loadAnimation(name, def.url, { loop: false });
			if (agent._disposed) return;
			await agent.anim.crossfadeTo(name, 0.16);
			clearTimeout(agent._gestureTimer);
			agent._gestureTimer = setTimeout(() => { if (!agent._disposed) agent.anim.crossfadeTo(CLIP_IDLE, 0.25); }, 2600);
		} catch { /* clip missing, ignore */ }
	}

	async _runRound() {
		this.busy = true;
		this.lastRoundAt = (typeof performance !== 'undefined' ? performance.now() : 0);
		this.prompt.classList.remove('ac-show');

		const topic = PAID_LABEL;
		this.topicIdx++;

		this._renderPanel({ topic, stage: 'challenge', stageState: 'active' });
		this.panel.classList.add('ac-show');

		// Opening beats.
		this.buyer.say(LINES.buyer.idle);
		this._gesture(this.buyer, 'av-call-me');
		await delay(650);
		this.seller.say(LINES.seller.idle);
		this._gesture(this.seller, 'wave');

		let settled = null, intel = null, active = 'challenge';

		try {
			const res = await fetch('/api/x402-pay', {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
				// Pay for the platform's own tools/list MCP call, the simplest paid
				// tool. /api/x402-pay handles the Solana USDC payment, then dispatches
				// the call and returns ORACLE's catalog alongside the settlement.
				body: JSON.stringify({ tool: PAID_TOOL, args: {} }),
				signal: this._abort.signal,
			});
			if (!res.ok || !res.body) {
				const text = await res.text().catch(() => '');
				let msg = 'Payment service unavailable.';
				try { msg = JSON.parse(text).error_description || JSON.parse(text).error || msg; } catch { /* ignore */ }
				throw new Error(msg);
			}

			for await (const { event, data } of this._sse(res)) {
				if (event === 'challenge') {
					active = 'built';
					this._renderPanel({ topic, stage: 'built', stageState: 'active', amount: data.amount });
					this.buyer.say(LINES.buyer.challenge); this.seller.say(LINES.seller.challenge);
				} else if (event === 'built') {
					active = 'verified';
					this._renderPanel({ topic, stage: 'verified', stageState: 'active', amount: this._amount });
					this.buyer.say(LINES.buyer.built); this.seller.say(LINES.seller.built);
				} else if (event === 'verified') {
					active = 'settled';
					this._renderPanel({ topic, stage: 'settled', stageState: 'active', amount: this._amount });
					this.buyer.say(LINES.buyer.verified); this.seller.say(LINES.seller.verified);
				} else if (event === 'settled') {
					active = 'done';
					settled = data;
					this._renderPanel({ topic, stage: 'done', stageState: 'active', amount: this._amount });
					this.buyer.say(LINES.buyer.settled); this.seller.say(LINES.seller.settled);
				} else if (event === 'result') {
					intel = data;
				} else if (event === 'error') {
					throw new Error(data.error || 'payment failed');
				}
				// 'dispatched' carries only timing, no UI beat needed.
			}

			if (this._disposed) return;
			if (!intel || !settled) throw new Error('incomplete response from payment service');

			// The settlement is on-chain truth; payer/payee/amount live on the result's
			// payment block. Surface ORACLE's catalog as the bought "intel".
			const payment = { ...(intel.payment || {}), ...settled };
			const report = summarizeCatalog(intel);

			// Success choreography.
			this._gesture(this.buyer, 'celebrate');
			await delay(300);
			this.buyer.say(LINES.buyer.done(report.count));
			await delay(700);
			this.seller.say(LINES.seller.done(report.headline));
			this._gesture(this.seller, 'av-cheering');

			this.sessionTotal += (Number(payment.amount) / 1e6) || 0;
			this.jumbotron?.pushSettlement(payment, { topic, ...report });
			this._renderReceipt(payment, { topic, ...report });
			// Auto-dismiss the panel after the receipt has been read.
			this._scheduleHide(9000);
		} catch (err) {
			if (this._disposed) return; // torn down mid-round, nothing left to render
			// `active` already points at the stage that failed.
			this.seller.say(LINES.seller.error);
			this.buyer.say(LINES.buyer.error);
			this._gesture(this.seller, 'facepalm');
			this.jumbotron?.setError(active, err?.message);
			this._renderError(active, err?.message);
			this._scheduleHide(7000);
		} finally {
			this.busy = false;
		}
	}

	_scheduleHide(ms) {
		clearTimeout(this._hideTimer);
		this._hideTimer = setTimeout(() => {
			this.panel.classList.remove('ac-show');
			// Revert the jumbotron's hero back to idle; its payment feed persists.
			this.jumbotron?.setIdle();
		}, ms);
	}

	// Render the panel header + stage stepper. `stage` is the currently-active
	// step; everything before it is marked done.
	_renderPanel({ topic, stage, amount }) {
		if (amount != null) this._amount = amount;
		// Mirror the live stage onto the in-world jumbotron so the big screen's
		// stepper animates in lockstep with this HUD panel.
		this.jumbotron?.setStage({ topic, stage, amount: this._amount });
		const activeIdx = STAGES.findIndex((s) => s.id === stage);
		const amt = this._amount ? fmtUsdcAmount(this._amount) : ', USDC';
		const steps = STAGES.map((s, i) => {
			const cls = i < activeIdx ? 'ac-done' : i === activeIdx ? 'ac-active' : '';
			return `<div class="ac-step ${cls}"><span class="ac-dot"></span>${s.label}</div>`;
		}).join('');
		this.panel.innerHTML =
			`<div class="ac-ph">` +
			`<span class="ac-pt">NOVA pays ORACLE for its <b>${escHtml(topic)}</b> · ${escHtml(amt)}</span>` +
			`<span class="ac-total">${fmtUsd(this.sessionTotal)}</span>` +
			`</div><div class="ac-steps">${steps}</div>`;
	}

	_renderReceipt(payment, intel) {
		// Re-render the stepper fully done, then append the on-chain receipt.
		this._renderPanel({ topic: intel.topic, stage: 'done', amount: payment.amount });
		this.panel.querySelectorAll('.ac-step').forEach((el) => { el.classList.remove('ac-active'); el.classList.add('ac-done'); });
		this.panel.querySelector('.ac-total')?.classList.add('ac-flash');

		const amount = payment.amount ? fmtUsdcAmount(payment.amount) : ', USDC';
		const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : ', ');
		const tx = payment.tx;
		const stat = intel.stat ? `<span class="ac-sig">${escHtml(intel.stat)}</span>` : '';

		const receipt = document.createElement('div');
		receipt.className = 'ac-receipt';
		receipt.innerHTML =
			`<div class="ac-rrow"><span>Buyer → Seller</span><span class="ac-v">${short(payment.payer)} → ${short(payment.payTo)}</span></div>` +
			`<div class="ac-rrow"><span>Amount · network</span><span class="ac-v">${escHtml(amount)} · Solana</span></div>` +
			(tx
				? `<div class="ac-rrow"><span>Transaction</span><span class="ac-v"><a href="https://solscan.io/tx/${escHtml(tx)}" target="_blank" rel="noopener">${tx.slice(0, 8)}…${tx.slice(-6)} ↗</a></span></div>`
				: '') +
			`<div class="ac-headline">${stat}<b>${escHtml(intel.topic)}</b>, ${escHtml(intel.headline)}</div>`;
		this.panel.appendChild(receipt);

		setTimeout(() => this.panel.querySelector('.ac-total')?.classList.remove('ac-flash'), 600);
	}

	_renderError(stage, message) {
		const activeIdx = STAGES.findIndex((s) => s.id === stage);
		this.panel.querySelectorAll('.ac-step').forEach((el, i) => {
			el.classList.remove('ac-active');
			if (i === activeIdx) el.classList.add('ac-err');
		});
		const msg = document.createElement('div');
		msg.className = 'ac-err-msg';
		msg.innerHTML = `⚠ ${escHtml(message || 'Payment failed. No funds moved.')}`;
		this.panel.appendChild(msg);
	}

	// SSE event reader, same framing /api/x402-pay speaks. The reader handle is
	// kept on the instance so dispose() can cancel a stream still in flight.
	async *_sse(res) {
		const reader = res.body.getReader();
		this._sseReader = reader;
		const dec = new TextDecoder();
		let buf = '';
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				const chunks = buf.split('\n\n');
				buf = chunks.pop();
				for (const chunk of chunks) {
					if (!chunk.trim()) continue;
					let event = 'message', data = {};
					for (const line of chunk.split('\n')) {
						if (line.startsWith('event:')) event = line.slice(6).trim();
						if (line.startsWith('data:')) { try { data = JSON.parse(line.slice(5).trim()); } catch { /* ignore */ } }
					}
					yield { event, data };
				}
			}
		} finally {
			this._sseReader = null;
		}
	}

	dispose() {
		this._disposed = true;
		clearTimeout(this._introTimer);
		clearTimeout(this._hideTimer);
		// Kill anything still on the wire: the manifest fetch and a mid-round
		// x402-pay SSE stream both hang off the shared controller.
		this._abort.abort();
		this._sseReader?.cancel().catch(() => {});
		this._sseReader = null;
		this.seller.dispose();
		this.buyer.dispose();
		this.jumbotron?.dispose(); this.jumbotron = null;
		if (this.marker) {
			this.scene.remove(this.marker);
			// Ground ring: its own RingGeometry + material.
			this._ring.geometry.dispose();
			this._ring.material.dispose();
			this._ring = null;
			// Sign: PlaneGeometry, a MeshBasicMaterial, and its CanvasTexture map.
			this.sign.geometry.dispose();
			this.sign.material.map?.dispose();
			this.sign.material.dispose();
			this.sign = null;
			this.marker = null;
		}
		this.prompt?.remove();
		this.panel?.remove();
		document.getElementById('ac-styles')?.remove();
	}
}
