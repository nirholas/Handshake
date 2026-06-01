// Wheel of Fortune — the in-world spinner UI for /play (Task 19).
//
// Opened when the player reaches the Mainland casino wheel. The SERVER owns
// every outcome: this module renders the 20-segment wheel, requests a spin, and
// animates the wheel to land on exactly the segment the server rolled — it never
// decides a prize. Two ways to spin:
//   • Free — one per account every 12h, with a live countdown.
//   • Paid — $3 in $THREE (50% burned / 50% to treasury). The server builds the
//     split transaction, the player's wallet signs + broadcasts it, and the
//     server verifies it on-chain before rolling. The paid spin never touches the
//     free-spin timer.
//
// Loaded as its own lazy chunk (dynamic import on first wheel interaction) so the
// Solana signing path never weighs down the main /play bundle.

import { detectSolanaWallet, SOLANA_RPC, solanaTxExplorerUrl } from '../erc8004/solana-deploy.js';

const NETWORK = 'mainnet';
const SEG_COLORS = {
	gold: { fill: '#f5c542', edge: '#caa033', text: '#3a2c00' },
	wood: { fill: '#8a5a32', edge: '#6e4626', text: '#fbe9d4' },
	stone: { fill: '#8b94a4', edge: '#6c7585', text: '#0d1420' },
	coal: { fill: '#39404e', edge: '#262b35', text: '#dfe6f2' },
};
// Alternating tint so adjacent same-kind wedges stay distinct on the wheel.
const ALT = 'rgba(0,0,0,0.10)';

function el(tag, props = {}, kids = []) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === 'class') n.className = v;
		else if (k === 'text') n.textContent = v;
		else if (k === 'html') n.innerHTML = v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
		else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
	}
	for (const kid of [].concat(kids)) if (kid != null && kid !== false) n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
	return n;
}

const kindOf = (seg) => (seg.kind === 'gold' ? 'gold' : seg.item || 'stone');

/**
 * Open the Wheel of Fortune. Idempotent — a second call focuses the existing
 * modal. Returns a controller with `.close()`.
 * @param {{ net: object, onClose?: () => void }} opts
 */
export function openSpinWheel(opts) {
	if (_open) { _open.focus(); return _open; }
	_open = new SpinWheel(opts);
	return _open;
}
let _open = null;

class SpinWheel {
	constructor({ net, onClose }) {
		this.net = net;
		this.onClose = onClose;
		this.segments = null;
		this.info = null;
		this.phase = 'loading'; // loading | ready | spinning | paying | result | error
		this.busy = false;
		this.rotation = 0; // current wheel rotation (radians)
		this._raf = null;
		this._countdownTimer = null;
		this._prep = null; // the live paid-spin prep ({tx, quote, ...})
		this._settleAttempts = 0;

		this._build();
		// The UI owns its own server subscriptions so the scene just opens/closes it.
		this._offs = [
			net.on('spinInfo', (m) => this._onInfo(m)),
			net.on('spinPrep', (m) => this._onPrep(m)),
			net.on('spinResult', (m) => this._onResult(m)),
			net.on('spinDenied', (m) => this._onDenied(m)),
		];
		net.spinInfo();
		this._drawWheel();
	}

	// ----------------------------------------------------------------- view
	_build() {
		this.overlay = el('div', { class: 'kg-spin-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Wheel of Fortune' });
		this.overlay.addEventListener('click', (e) => { if (e.target === this.overlay) this.close(); });

		this.canvas = el('canvas', { class: 'kg-spin-canvas', width: '640', height: '640' });
		this.pointer = el('div', { class: 'kg-spin-pointer', 'aria-hidden': 'true' });
		this.hub = el('div', { class: 'kg-spin-hub', 'aria-hidden': 'true', text: '★' });
		const wheelWrap = el('div', { class: 'kg-spin-wheelwrap' }, [this.canvas, this.pointer, this.hub]);

		this.resultLine = el('div', { class: 'kg-spin-result', 'aria-live': 'polite' });

		this.freeBtn = el('button', { class: 'kg-spin-btn kg-spin-free', type: 'button', onclick: () => this._free() }, 'Free spin');
		this.freeSub = el('div', { class: 'kg-spin-sub' });
		const freeBlock = el('div', { class: 'kg-spin-action' }, [this.freeBtn, this.freeSub]);

		this.paidBtn = el('button', { class: 'kg-spin-btn kg-spin-paid', type: 'button', onclick: () => this._paid() }, 'Paid spin');
		this.paidSub = el('div', { class: 'kg-spin-sub' });
		const paidBlock = el('div', { class: 'kg-spin-action' }, [this.paidBtn, this.paidSub]);

		this.actions = el('div', { class: 'kg-spin-actions' }, [freeBlock, paidBlock]);

		this.status = el('div', { class: 'kg-spin-status' });
		this.gate = el('div', { class: 'kg-spin-gate', hidden: true });
		this.legend = el('div', { class: 'kg-spin-legend' });

		const close = el('button', { class: 'kg-spin-close', type: 'button', 'aria-label': 'Close', onclick: () => this.close() }, '✕');
		const head = el('div', { class: 'kg-spin-head' }, [
			el('div', { class: 'kg-spin-title' }, ["Wheel of Fortune", el('span', { class: 'kg-spin-sub2', text: "Fortune's Folly · Mainland" })]),
			close,
		]);

		this.card = el('div', { class: 'kg-spin-card' }, [head, wheelWrap, this.resultLine, this.gate, this.actions, this.status, this.legend]);
		this.overlay.appendChild(this.card);
		document.body.appendChild(this.overlay);
		this._setBusy(true, 'Loading the wheel…');
		this._onKey = (e) => { if (e.key === 'Escape') this.close(); };
		window.addEventListener('keydown', this._onKey);
	}

	focus() { this.card?.classList.remove('kg-spin-flash'); requestAnimationFrame(() => this.card?.classList.add('kg-spin-flash')); }

	// ----------------------------------------------------------- server in
	_onInfo(m) {
		this.info = m;
		this._infoAt = Date.now(); // anchor the local clock to the server's `now`
		this.segments = Array.isArray(m.segments) ? m.segments : [];
		this._renderLegend();
		this._drawWheel();
		if (this.phase === 'loading') this.phase = 'ready';
		this._sync();
		this._startCountdown();
	}

	_onPrep(m) {
		if (this.phase !== 'paying') return; // a stale prep from a cancelled flow
		this._prep = m;
		this._runWalletPayment(m).catch((err) => this._payError(err));
	}

	_onResult(m) {
		// Land the wheel on the server's chosen segment, then reveal the prize.
		if (m.mode === 'free' && Number.isFinite(m.nextFreeSpinAt) && this.info) this.info.nextFreeSpinAt = m.nextFreeSpinAt;
		this._pendingResult = m;
		this._animateTo(m.index, () => this._reveal(m));
	}

	_onDenied(m) {
		if (m && Number.isFinite(m.nextFreeSpinAt) && this.info) this.info.nextFreeSpinAt = m.nextFreeSpinAt;
		if (m && Number.isFinite(m.avgLevel) && this.info) { this.info.avgLevel = m.avgLevel; this.info.eligible = m.avgLevel >= m.minLevel; }
		// A paid spin whose payment isn't visible to the server yet: it landed
		// on-chain (we waited for confirmation) but the RPC's parsed view can lag a
		// beat. Retry the settle a few times before giving up so a confirmed payment
		// is never lost to a timing race. The signature is consumed only on success.
		if (m?.mode === 'paid' && m.reason === 'not_found' && this._prep && this._sig && (this._settleAttempts || 0) < 5) {
			this._status('Waiting for the payment to confirm…', '');
			setTimeout(() => { if (!this._closed && this.phase === 'spinning') this._settle(); }, 2500);
			return;
		}
		this.busy = false;
		this._stopSpin();
		this.phase = 'ready';
		this._prep = null;
		this._sig = null;
		this._status(this._denyText(m), 'err');
		this._sync();
	}

	_denyText(m) {
		const min = m?.minLevel ?? this.info?.minLevel ?? 5;
		switch (m?.reason) {
			case 'level': return `You need an average skill level of ${min} to spin. You're at ${m?.avgLevel ?? this.info?.avgLevel ?? 0}. Train your skills and come back.`;
			case 'not_at_wheel': return 'Step up to the wheel to spin.';
			case 'no_wheel': return 'There is no wheel in this realm.';
			case 'cooldown': return 'Your free spin isn’t ready yet.';
			case 'token_unavailable': return 'Paid spins are unavailable right now.';
			case 'no_wallet': return 'Connect a Solana wallet to buy a spin.';
			case 'price_unavailable': return 'Live token price unavailable — try again in a moment.';
			case 'build_failed': return 'Could not prepare the payment. Try again.';
			case 'no_signature': return 'No transaction signature received.';
			case 'already_settled': return 'That payment was already used for a spin.';
			case 'not_found': return 'Payment not confirmed on-chain yet — give it a moment and try again.';
			case 'underpaid': return 'The payment amount didn’t match the quote. No spin was taken.';
			case 'quote_expired': return 'Your quote expired before the payment confirmed. Try again.';
			default: return 'The spin couldn’t be completed.';
		}
	}

	// --------------------------------------------------------------- spins
	_free() {
		if (this.busy || !this._levelOk()) return;
		const now = this.info?.now ?? Date.now();
		const next = this.info?.nextFreeSpinAt ?? 0;
		if (now < next) return; // not ready — button is disabled, but guard anyway
		this.busy = true;
		this.phase = 'spinning';
		this.resultLine.textContent = '';
		this._status('Rolling…', '');
		this._sync();
		this._startSpin();
		this.net.spinFree();
	}

	async _paid() {
		if (this.busy || !this._levelOk() || !this.info?.paidAvailable) return;
		const wallet = detectSolanaWallet();
		if (!wallet) { this._status('No Solana wallet found. Install Phantom (or Backpack/Solflare) to buy a spin.', 'err'); return; }
		this.busy = true;
		this.phase = 'paying';
		this._prep = null;
		this._settleAttempts = 0;
		this.resultLine.textContent = '';
		this._status('Preparing your payment…', '');
		this._sync();
		this.net.spinPaidPrep();
	}

	async _runWalletPayment(prep) {
		const wallet = detectSolanaWallet();
		if (!wallet) throw Object.assign(new Error('No Solana wallet found.'), { friendly: true });
		this._status('Approve the $3 spin in your wallet…', '');
		const { Transaction, Connection } = await import('@solana/web3.js');
		const bytes = Uint8Array.from(atob(prep.tx), (c) => c.charCodeAt(0));
		const tx = Transaction.from(bytes);
		const signed = await wallet.signTransaction(tx);

		this._status('Submitting payment on-chain…', '');
		const conn = new Connection(SOLANA_RPC[NETWORK], 'confirmed');
		const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
		this._sig = sig;

		const url = solanaTxExplorerUrl(NETWORK, sig);
		this._statusNode(el('span', {}, ['Confirming payment — ', el('a', { href: url, target: '_blank', rel: 'noopener', text: 'view ↗' }), '…']), 'ok');
		await this._confirm(conn, sig);

		// Hand the signature to the server: it verifies the burn + treasury legs
		// on-chain before rolling. Start the wheel spinning for feedback.
		this.phase = 'spinning';
		this._startSpin();
		this._status('Verifying payment & rolling…', '');
		this._settle();
	}

	// Ask the server to verify the broadcast payment and roll. Kept as its own step
	// so a transient "not confirmed yet" can retry without re-signing.
	_settle() {
		this._settleAttempts = (this._settleAttempts || 0) + 1;
		this.net.spinPaidSettle(this._prep.quote, this._sig);
	}

	// Poll signature status over HTTP (no WS — the public RPC refuses subscriptions).
	async _confirm(conn, sig, timeoutMs = 35_000) {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			try {
				const { value } = await conn.getSignatureStatuses([sig]);
				const st = value?.[0];
				if (st?.err) throw Object.assign(new Error('Payment failed on-chain.'), { friendly: true });
				if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return;
			} catch (e) {
				if (e.friendly) throw e;
			}
			await new Promise((r) => setTimeout(r, 1500));
		}
		// Timed out waiting — let the server try anyway; it may already see it.
	}

	_payError(err) {
		this.busy = false;
		this._stopSpin();
		this.phase = 'ready';
		this._prep = null;
		const msg = err?.message || 'Payment failed.';
		const friendly = /reject|denied|cancel|user/i.test(msg) ? 'Cancelled in wallet.' : msg;
		this._status(friendly, 'err');
		this._sync();
	}

	// --------------------------------------------------------------- result
	_reveal(m) {
		this.busy = false;
		this.phase = 'result';
		this._prep = null;
		this._sig = null;
		const seg = this.segments?.[m.index];
		const label = m.label || seg?.label || 'a prize';
		let line = `You won ${label}!`;
		if (m.overflow > 0) line += ` (${m.overflow} waiting in a bag at your feet — your pack was full)`;
		this.resultLine.textContent = line;
		this.resultLine.dataset.kind = seg ? kindOf(seg) : 'stone';
		this._status(m.mode === 'paid' ? 'Paid spin settled on-chain.' : 'Free spin used.', 'ok');
		if (m.mode === 'free') this._startCountdown();
		this._sync();
	}

	// --------------------------------------------------------------- canvas
	_drawWheel() {
		const c = this.canvas;
		const ctx = c.getContext('2d');
		const W = c.width, R = W / 2, cx = R, cy = R, rad = R - 14;
		ctx.clearRect(0, 0, W, W);
		const segs = this.segments && this.segments.length ? this.segments : new Array(20).fill({ kind: 'item', item: 'stone', label: '' });
		const n = segs.length;
		const seg = (Math.PI * 2) / n;
		ctx.save();
		ctx.translate(cx, cy);
		ctx.rotate(this.rotation);
		for (let i = 0; i < n; i++) {
			const a0 = -Math.PI / 2 + (i - 0.5) * seg;
			const a1 = -Math.PI / 2 + (i + 0.5) * seg;
			const k = kindOf(segs[i]);
			const col = SEG_COLORS[k] || SEG_COLORS.stone;
			ctx.beginPath();
			ctx.moveTo(0, 0);
			ctx.arc(0, 0, rad, a0, a1);
			ctx.closePath();
			ctx.fillStyle = col.fill;
			ctx.fill();
			if (i % 2) { ctx.fillStyle = ALT; ctx.fill(); }
			ctx.lineWidth = 2; ctx.strokeStyle = col.edge; ctx.stroke();
			// Label: the amount, drawn along the wedge centre.
			const mid = -Math.PI / 2 + i * seg;
			ctx.save();
			ctx.rotate(mid);
			ctx.translate(rad * 0.66, 0);
			ctx.rotate(Math.PI / 2);
			ctx.fillStyle = col.text;
			ctx.font = '600 22px ui-sans-serif, system-ui, sans-serif';
			ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
			const amt = segs[i].kind === 'gold' ? String(segs[i].gold ?? '') : String(segs[i].qty ?? '');
			ctx.fillText(amt, 0, -8);
			ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
			ctx.fillText((k === 'gold' ? 'GOLD' : k.toUpperCase()), 0, 12);
			ctx.restore();
		}
		ctx.restore();
		// Outer rim.
		ctx.beginPath(); ctx.arc(cx, cy, rad + 2, 0, Math.PI * 2);
		ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.stroke();
	}

	_startSpin() {
		this._stopSpin();
		this._spinVel = 0.45; // rad/frame while waiting for the server outcome
		const tick = () => {
			this.rotation = (this.rotation + this._spinVel) % (Math.PI * 2);
			this._drawWheel();
			this._raf = requestAnimationFrame(tick);
		};
		this._raf = requestAnimationFrame(tick);
	}

	_stopSpin() {
		if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
	}

	// Ease the wheel to a stop with segment `index` under the top pointer.
	_animateTo(index, done) {
		this._stopSpin();
		const n = this.segments?.length || 20;
		const seg = (Math.PI * 2) / n;
		const TAU = Math.PI * 2;
		const cur = ((this.rotation % TAU) + TAU) % TAU;
		// Target rotation (mod TAU) that puts segment `index` centre at the top.
		const targetMod = ((-index * seg) % TAU + TAU) % TAU;
		const spins = 5; // full turns of flourish before landing
		const delta = spins * TAU + ((targetMod - cur + TAU) % TAU);
		const from = this.rotation;
		const dur = 4200;
		const t0 = performance.now();
		const ease = (t) => 1 - Math.pow(1 - t, 3); // cubic ease-out
		const step = (now) => {
			const t = Math.min(1, (now - t0) / dur);
			this.rotation = from + delta * ease(t);
			this._drawWheel();
			if (t < 1) { this._raf = requestAnimationFrame(step); }
			else { this._raf = null; this.rotation %= TAU; done && done(); }
		};
		this._raf = requestAnimationFrame(step);
	}

	// -------------------------------------------------------------- chrome
	_renderLegend() {
		if (!this.segments) return;
		const order = ['gold', 'wood', 'stone', 'coal'];
		const odds = {};
		for (const s of this.segments) {
			const k = kindOf(s);
			odds[k] = (odds[k] || 0) + (s.oddsPct || 0);
		}
		const labels = { gold: 'Gold', wood: 'Wood', stone: 'Stone', coal: 'Coal' };
		this.legend.replaceChildren(
			el('span', { class: 'kg-spin-legend-h', text: 'Odds' }),
			...order.filter((k) => odds[k] != null).map((k) =>
				el('span', { class: 'kg-spin-chip', 'data-kind': k }, [
					el('i', { class: 'kg-spin-dot', style: `background:${(SEG_COLORS[k] || SEG_COLORS.stone).fill}` }),
					`${labels[k]} ${Math.round(odds[k])}%`,
				])),
		);
	}

	_startCountdown() {
		if (this._countdownTimer) clearInterval(this._countdownTimer);
		const update = () => this._syncFree();
		update();
		this._countdownTimer = setInterval(update, 1000);
	}

	_levelOk() { return !!this.info?.eligible; }

	_fmtCountdown(ms) {
		const s = Math.max(0, Math.ceil(ms / 1000));
		const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
		if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
		if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
		return `${sec}s`;
	}

	// Free-spin button + countdown, recomputed every second against a local clock
	// anchored to the server's `now` so the countdown is accurate without polling.
	_syncFree() {
		if (!this.info) return;
		const drift = Date.now() - (this._infoAt || Date.now());
		const now = (this.info.now ?? Date.now()) + drift;
		const next = this.info.nextFreeSpinAt ?? 0;
		const ready = now >= next;
		if (this.busy || this.phase === 'spinning' || this.phase === 'paying') {
			this.freeBtn.disabled = true;
			return;
		}
		if (!this._levelOk()) {
			this.freeBtn.disabled = true; this.freeBtn.textContent = 'Free spin';
			this.freeSub.textContent = '';
			return;
		}
		this.freeBtn.disabled = !ready || this.busy;
		this.freeBtn.textContent = ready ? 'Free spin' : 'Free spin';
		this.freeSub.textContent = ready ? 'Ready now · 1 per 12h' : `Next free spin in ${this._fmtCountdown(next - now)}`;
		this.freeSub.dataset.ready = ready ? '1' : '0';
	}

	// Reconcile the whole UI with the current phase + eligibility.
	_sync() {
		const lvlOk = this._levelOk();
		const min = this.info?.minLevel ?? 5;
		// Level gate banner — the designed "not eligible" state with a how-to.
		if (this.info && !lvlOk) {
			this.gate.hidden = false;
			this.gate.replaceChildren(
				el('div', { class: 'kg-spin-gate-h', text: 'Locked' }),
				el('div', { class: 'kg-spin-gate-b' }, [
					`Spinning needs an average skill level of ${min}. You're at ${this.info.avgLevel ?? 0}. `,
					'Chop, mine, fish, cook and fight to raise your skills — the wheel unlocks at level ' + min + '.',
				]),
			);
		} else {
			this.gate.hidden = true;
		}
		// Paid button availability + label.
		const paidOk = lvlOk && !!this.info?.paidAvailable;
		this.paidBtn.disabled = this.busy || !paidOk;
		const cost = this.info?.costUsd ?? 3;
		const sym = this.info?.symbol || '$THREE';
		this.paidBtn.textContent = `Paid spin · $${cost}`;
		if (!this.info) this.paidSub.textContent = '';
		else if (!lvlOk) this.paidSub.textContent = `Reach level ${min} to play`;
		else if (!this.info.paidAvailable) this.paidSub.textContent = 'Connect a Solana wallet to buy spins';
		else this.paidSub.textContent = `$${cost} in ${sym} · 50% burned, 50% treasury`;
		this._syncFree();
	}

	_setBusy(on, text) { if (text != null) this._status(text, ''); }
	_status(text, kind) { this.status.textContent = text || ''; this.status.dataset.kind = kind || ''; }
	_statusNode(node, kind) { this.status.replaceChildren(node); this.status.dataset.kind = kind || ''; }

	// ---------------------------------------------------------------- close
	close() {
		if (this._closed) return;
		this._closed = true;
		this._stopSpin();
		if (this._countdownTimer) clearInterval(this._countdownTimer);
		for (const off of this._offs || []) { try { off(); } catch {} }
		window.removeEventListener('keydown', this._onKey);
		this.overlay?.remove();
		if (_open === this) _open = null;
		try { this.onClose?.(); } catch {}
	}
}
