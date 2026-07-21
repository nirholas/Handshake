// Intel Kiosk — a paid x402 oracle kiosk inside every coin town (/play).
//
// This ports the /play/agent-wallet demo into the walkaround world: instead of
// a flat page where your avatar walks to a kiosk, YOU are the avatar. Walk up
// to the kiosk by the plaza and press E (or tap it) — window.X402.pay opens
// the wallet modal, you pay $0.01 USDC (Phantom on Solana, or an EVM wallet on
// Base) and the kiosk's 3D screen lights up with the purchased intel: live
// price, 24 h change, market cap, and a bullish/bearish/neutral signal for the
// town's own coin. Every settlement is real USDC on-chain; the payment modal
// shows the transaction with an explorer link.
//
// Built for every world by coincommunities.js and torn down in leave(). The
// flagship $THREE town buys from its dedicated oracle (/api/x402/three-intel);
// every other town buys from the generic token oracle
// (/api/x402/token-intel?mint=…) with the world's mint supplied at runtime —
// the same coin-agnostic plumbing the /ca2x402 resolver hands out. Payment
// only fires on an explicit player interaction, and the player signs with
// their OWN wallet — no platform key is ever exposed to the page.

import {
	Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, RingGeometry,
	PlaneGeometry, BoxGeometry, CylinderGeometry,
	DoubleSide, Vector3,
} from 'three';
import { makeScreenCanvas, makeScreenTexture, screenMaterial } from './screen-texture.js';
import { isHomeTown } from './home-town.js';
import { log } from '../shared/log.js';
import { ensureX402 } from '../shared/x402-loader.js';

const KIOSK_POS = new Vector3(-8, 0, -7);
const INTERACT_RANGE = 5.5;
const SCREEN_W = 512, SCREEN_H = 320; // logical layout grid; backed at 2x
const ACCENT = '#9945ff';
const ACCENT_LT = '#b88aff';

// x402 SDK loaded on demand the first time a player pays (src/shared/x402-loader.js).

function fmtUsd(n) {
	if (n == null || !isFinite(n)) return '—';
	if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
	if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
	if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
	return `$${n >= 1 ? n.toFixed(2) : n.toFixed(6)}`;
}

// Shrink a font until the text fits — long pump.fun tickers must not bleed off
// the 512px sign/screen canvases.
function fitFont(ctx, text, maxWidth, basePx, weight = 800) {
	let px = basePx;
	do {
		ctx.font = `${weight} ${px}px Inter, system-ui, sans-serif`;
		if (ctx.measureText(text).width <= maxWidth) break;
		px -= 2;
	} while (px > 18);
	return px;
}

export class IntelKiosk {
	constructor({ scene, camera, renderer, getPlayer, ui, coin }) {
		this.scene = scene;
		this.camera = camera;
		this.renderer = renderer;
		this.getPlayer = getPlayer;
		this.ui = ui;

		// The town's coin decides what the kiosk sells and where it buys from.
		const home = isHomeTown(coin?.mint);
		this.symLabel = home
			? '$THREE'
			: (coin?.symbol ? '$' + String(coin.symbol).toUpperCase() : (coin?.name || 'TOKEN'));
		this.endpoint = home
			? '/api/x402/three-intel'
			: `/api/x402/token-intel?mint=${encodeURIComponent(coin?.mint || '')}`;

		this.busy = false;
		this.intel = null;      // last purchased intel payload
		this.paidTx = null;     // settlement tx of the last purchase
		this._inRange = false;
		this._t = 0;
		this._disposed = false;

		this._buildKiosk();
		this._buildPrompt();
		this._drawScreen();
	}

	_buildKiosk() {
		this.group = new Group();
		this.group.position.copy(KIOSK_POS);
		// Face the plaza center so players see the screen as they approach.
		this.group.rotation.y = Math.atan2(-KIOSK_POS.x, -KIOSK_POS.z);

		const shell = new MeshStandardMaterial({ color: 0x17171b, roughness: 0.35, metalness: 0.7 });
		const pedestal = new Mesh(new BoxGeometry(1.1, 1.3, 0.5), shell);
		pedestal.position.y = 0.65;
		pedestal.castShadow = true;
		this.group.add(pedestal);

		const { canvas, ctx } = makeScreenCanvas(SCREEN_W, SCREEN_H, 2);
		this.canvas = canvas;
		this.ctx = ctx;
		this.tex = makeScreenTexture(this.canvas);
		const screen = new Mesh(
			new PlaneGeometry(1.5, 0.94),
			screenMaterial(this.tex),
		);
		screen.position.set(0, 1.85, 0.08);
		screen.rotation.x = -0.14;
		this.group.add(screen);
		const bezel = new Mesh(new BoxGeometry(1.62, 1.06, 0.06), shell);
		bezel.position.set(0, 1.85, 0.03);
		bezel.rotation.x = -0.14;
		bezel.castShadow = true;
		this.group.add(bezel);

		// Antenna beacon — kiosks broadcast that they're paid x402 services.
		const mast = new Mesh(new CylinderGeometry(0.025, 0.025, 0.6, 8), shell);
		mast.position.set(0.45, 2.6, 0);
		this.group.add(mast);
		this.beacon = new Mesh(
			new CylinderGeometry(0.06, 0.06, 0.08, 10),
			new MeshBasicMaterial({ color: ACCENT }),
		);
		this.beacon.position.set(0.45, 2.93, 0);
		this.group.add(this.beacon);

		// Pay ring on the floor — pulses while a payment runs.
		this.ring = new Mesh(
			new RingGeometry(1.0, 1.3, 56),
			new MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.2, side: DoubleSide }),
		);
		this.ring.rotation.x = -Math.PI / 2;
		this.ring.position.y = 0.02;
		this.group.add(this.ring);

		// Floating sign, billboarded in tick().
		this.sign = this._signMesh(`${this.symLabel} INTEL`, 'paid oracle · $0.01 USDC · x402');
		this.sign.position.set(0, 3.5, 0);
		this.group.add(this.sign);

		this.scene.add(this.group);
	}

	_signMesh(title, sub) {
		const { canvas, ctx: x } = makeScreenCanvas(512, 160, 2);
		x.textAlign = 'center';
		x.fillStyle = ACCENT_LT;
		fitFont(x, title, 480, 54);
		x.fillText(title, 256, 62);
		x.fillStyle = 'rgba(255,255,255,0.62)';
		x.font = '600 26px Inter, system-ui, sans-serif';
		x.fillText(sub, 256, 104);
		const tex = makeScreenTexture(canvas);
		return new Mesh(
			new PlaneGeometry(4.2, 1.32),
			screenMaterial(tex, { transparent: true, side: DoubleSide }),
		);
	}

	_buildPrompt() {
		if (!document.getElementById('tik-styles')) {
			const s = document.createElement('style');
			s.id = 'tik-styles';
			s.textContent = `
			.tik-prompt {
				position: fixed; left: 0; top: 0; z-index: 16; pointer-events: none;
				transform: translate(-50%, -100%); white-space: nowrap;
				background: var(--cc-panel-solid, #0c0c0e); border: 1px solid rgba(153,69,255,0.45);
				color: var(--cc-text, #f5f5f6); font-size: 12px; font-weight: 700; letter-spacing: 0.04em;
				padding: 6px 11px; border-radius: var(--cc-radius, 4px); box-shadow: 0 0 14px rgba(153,69,255,0.35);
				text-transform: uppercase; transition: opacity 0.18s ease; opacity: 0;
			}
			.tik-prompt.tik-show { opacity: 1; }
			.tik-prompt .tik-key {
				display: inline-block; min-width: 16px; text-align: center; margin-right: 5px;
				background: ${ACCENT_LT}; color: var(--cc-ink, #060607); border-radius: 3px; padding: 0 4px;
			}`;
			document.head.appendChild(s);
		}
		this.prompt = document.createElement('div');
		this.prompt.className = 'tik-prompt';
		const key = document.createElement('span');
		key.className = 'tik-key';
		key.textContent = 'E';
		this.prompt.append(key, ` Buy ${this.symLabel} intel — $0.01 USDC`);
		document.body.appendChild(this.prompt);
	}

	// ── kiosk screen states: offer → paying → intel ────────────────────────────

	_drawScreen() {
		const c = this.ctx, W = SCREEN_W, H = SCREEN_H;
		const g = c.createLinearGradient(0, 0, 0, H);
		g.addColorStop(0, '#15151a'); g.addColorStop(1, '#0a0a0c');
		c.fillStyle = g; c.fillRect(0, 0, W, H);
		c.strokeStyle = 'rgba(255,255,255,0.07)'; c.strokeRect(1, 1, W - 2, H - 2);
		c.textAlign = 'left';
		c.fillStyle = '#5a5a60';
		c.font = '700 22px Inter, system-ui, sans-serif';
		c.fillText('x402 PAID ORACLE', 28, 46);
		c.fillStyle = ACCENT_LT;
		fitFont(c, `${this.symLabel} INTEL`, W - 56, 44);
		c.fillText(`${this.symLabel} INTEL`, 28, 100);

		const i = this.intel;
		if (this.busy) {
			c.fillStyle = ACCENT_LT; c.font = '600 24px Inter, system-ui, sans-serif';
			c.fillText('● PAYMENT IN PROGRESS…', 28, 168);
			c.fillStyle = '#8c8c92'; c.font = '600 20px Inter, system-ui, sans-serif';
			c.fillText('Sign in your wallet to settle on-chain.', 28, 204);
		} else if (i) {
			const sigCol = i.signal === 'bullish' ? '#5fd08a' : i.signal === 'bearish' ? '#e06c75' : '#f5a623';
			c.fillStyle = sigCol; c.font = '800 26px Inter, system-ui, sans-serif';
			c.fillText((i.signal || '').toUpperCase(), 28, 150);
			c.fillStyle = '#f5f5f6'; c.font = '700 25px Inter, system-ui, sans-serif';
			c.fillText(String(i.headline || '').slice(0, 38), 28, 188);
			c.fillStyle = '#8c8c92'; c.font = '600 21px Inter, system-ui, sans-serif';
			const px = i.price_usd != null ? `$${i.price_usd >= 1 ? i.price_usd.toFixed(3) : i.price_usd.toFixed(6)}` : '—';
			const chg = i.change_24h != null ? `${i.change_24h >= 0 ? '+' : ''}${i.change_24h.toFixed(2)}%` : '—';
			c.fillText(`price ${px} · 24h ${chg} · mcap ${fmtUsd(i.market_cap_usd)}`, 28, 226);
			c.fillStyle = '#5fd08a'; c.font = '600 20px Inter, system-ui, sans-serif';
			c.fillText(this.paidTx ? `✓ settled · tx ${this.paidTx.slice(0, 8)}…` : '✓ settled on-chain', 28, 272);
		} else {
			c.fillStyle = '#22d77a'; c.font = '800 40px Inter, system-ui, sans-serif';
			c.fillText('$0.01 USDC', 28, 168);
			c.fillStyle = '#8c8c92'; c.font = '600 21px Inter, system-ui, sans-serif';
			c.fillText('Live price · signal · market cap · flow', 28, 208);
			c.fillStyle = '#5a5a60'; c.font = '600 20px Inter, system-ui, sans-serif';
			c.fillText('Walk up and press E to buy', 28, 268);
		}
		this.tex.needsUpdate = true;
	}

	_playerNear() {
		const p = this.getPlayer?.();
		if (!p) return false;
		return Math.hypot(p.x - KIOSK_POS.x, p.z - KIOSK_POS.z) <= INTERACT_RANGE;
	}

	// Project a world point to a screen-space DOM transform (same math as
	// coincommunities._updateLabels / agent-commerce._place).
	_place(node, x, y, z) {
		const w = this.renderer.domElement.clientWidth, h = this.renderer.domElement.clientHeight;
		const v = new Vector3(x, y, z).project(this.camera);
		if (v.z > 1 || v.z < -1) { node.style.display = 'none'; return; }
		node.style.display = '';
		node.style.transform = `translate(-50%, -100%) translate(${(v.x * 0.5 + 0.5) * w}px, ${(-v.y * 0.5 + 0.5) * h}px)`;
	}

	tick(dt) {
		this._t += dt;
		// Billboard the sign; pulse the ring and beacon while paying.
		if (this.sign) {
			const c = this.camera.position;
			this.sign.rotation.y =
				Math.atan2(c.x - KIOSK_POS.x, c.z - KIOSK_POS.z) - this.group.rotation.y;
		}
		this.ring.material.opacity = this.busy
			? 0.3 + 0.25 * Math.sin(this._t * 5)
			: 0.14 + 0.1 * (0.5 + 0.5 * Math.sin(this._t * 2));

		const near = this._playerNear();
		if (near && !this.busy) {
			this.prompt.classList.add('tik-show');
			this._place(this.prompt, KIOSK_POS.x, 4.3, KIOSK_POS.z);
		} else {
			this.prompt.classList.remove('tik-show');
		}
		this._inRange = near;
	}

	// Tap/click support: returns true (and starts a purchase) if the player
	// tapped the kiosk while in range.
	tryActivateAt(raycaster) {
		if (!this._playerNear()) return false;
		const hit = raycaster.intersectObject(this.group, true).length > 0;
		if (hit) { this.interact(); return true; }
		return false;
	}

	// Player pressed E (or tapped the kiosk): open the real x402 payment modal.
	interact() {
		if (this.busy || !this._playerNear()) return false;
		this._purchase().catch((err) => log.warn('[intel-kiosk] purchase failed:', err?.message));
		return true;
	}

	async _purchase() {
		this.busy = true;
		this.prompt.classList.remove('tik-show');
		this._drawScreen();
		try {
			const X402 = await ensureX402();
			const out = await X402.pay({
				endpoint: this.endpoint,
				method: 'GET',
				merchant: `${this.symLabel} Town Oracle`,
				action: `Live ${this.symLabel} market intel — $0.01 USDC`,
			});
			const intel = out?.result;
			if (!intel?.signal) throw new Error(intel?.error || 'purchase did not settle');
			this.intel = intel;
			this.paidTx = out?.payment?.transaction || null;
			this.ui?.toast?.(`${this.symLabel} intel purchased — ${intel.signal.toUpperCase()}: ${intel.headline}`, 'success');
		} catch (err) {
			// A dismissed wallet modal is a normal exit, not an error state.
			const cancelled = /cancel|dismiss|closed|denied/i.test(String(err?.message || ''));
			if (!cancelled) {
				this.ui?.toast?.(`Intel purchase failed — ${err?.message || 'no funds moved'}`, 'error');
			}
		} finally {
			this.busy = false;
			this._drawScreen();
		}
	}

	dispose() {
		this._disposed = true;
		this.prompt?.remove();
		if (this.group) {
			this.scene.remove(this.group);
			this.group.traverse((o) => {
				o.geometry?.dispose?.();
				if (o.material) {
					o.material.map?.dispose?.();
					o.material.dispose?.();
				}
			});
			this.group = null;
		}
	}
}
