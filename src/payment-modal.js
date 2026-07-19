/**
 * SkillPaymentModal — self-contained skill purchase flow for the agent-3d
 * embed element. Renders inside the shadow DOM so it works on any host page
 * without colliding with host CSS.
 *
 * Usage:
 *   const modal = new SkillPaymentModal(shadowRoot, agentId);
 *   const purchased = await modal.show({ skill, price });
 *   if (purchased) runtime.skillAccess = refreshedChecker;
 */

import { formatUsdcEq, formatSolEq } from './shared/usd-price.js';
import { buildReceiptHTML, buildReceiptText } from './shared/payment-receipt.js';
import { showAddFunds } from './shared/add-funds.js';
import { ensureRiskAck } from './shared/risk-ack.js';
import { log } from './shared/log.js';

const USDC_DECIMALS = 6;

function escHtml(s) {
	return String(s == null ? '' : s)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Lazy-load Solana modules via bundled npm deps. Dynamic import keeps the
// Solana SDKs out of the initial chunk; Vite splits them into their own
// asset that's only fetched when a payment actually happens.
let _web3 = null;
let _spl = null;
async function loadSolana() {
	if (!_web3) _web3 = await import('@solana/web3.js');
	if (!_spl) _spl = await import('@solana/spl-token');
	return { web3: _web3, spl: _spl };
}

const STYLE = `
.pay-chip {
	background: rgba(255,255,255,.04);
	border: 1px solid rgba(255,255,255,.11);
	border-radius: 12px; padding: 12px 14px; margin: 2px 0;
	animation: pay-chip-in .24s cubic-bezier(.16,1,.3,1) both;
}
@keyframes pay-chip-in {
	from { opacity: 0; transform: translateY(6px) scale(.985); }
	to   { opacity: 1; transform: none; }
}
.pay-chip-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.pay-chip-label { font-size: 12px; font-weight: 600; color: rgba(255,255,255,.55); text-transform: uppercase; letter-spacing: .06em; }
.pay-chip-skill { font-size: 13px; color: #ffffff; font-family: monospace; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pay-chip-price { font-size: 15px; color: #34d399; font-weight: 700; margin-bottom: 10px; }
.pay-chip-price .usd-eq { font-size: 12px; color: rgba(255,255,255,.45); font-weight: 400; margin-left: 5px; }
.pay-chip-actions { display: flex; gap: 8px; }
.pay-chip-btn {
	flex: 1; padding: 8px 12px; border-radius: 8px; border: none;
	font-size: 13px; font-weight: 600; cursor: pointer;
	background: rgba(255,255,255,0.12); color: #fff; border: 1px solid rgba(255,255,255,0.18);
	transition: opacity .15s; letter-spacing: .02em;
}
.pay-chip-btn:hover:not(:disabled) { opacity: .85; }
.pay-chip-btn:disabled { opacity: .4; cursor: default; }
.pay-chip-btn-pay { background: linear-gradient(135deg, #059669, #047857); border: none; }
.pay-chip-btn-cancel { flex: 0 0 auto; background: rgba(255,255,255,.08); color: rgba(255,255,255,.45); }
.pay-chip-status { font-size: 12px; color: rgba(255,255,255,.45); margin-top: 7px; min-height: 15px; }
.pay-chip-status.err { color: #f87171; }
.pay-chip-status.ok  { color: #34d399; }
.skill-pay-overlay {
	position: fixed; inset: 0; background: rgba(0,0,0,0.72);
	-webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
	display: flex; align-items: center; justify-content: center;
	z-index: 9999; font-family: system-ui, sans-serif;
	padding: 16px; box-sizing: border-box;
	opacity: 0; transition: opacity .18s ease;
}
.skill-pay-overlay[hidden] { display: none; }
.skill-pay-overlay.is-open { opacity: 1; }
.skill-pay-box {
	background: #1a1a2e; border: 1px solid rgba(255,255,255,.12);
	border-radius: 16px; padding: 28px 24px; max-width: 380px; width: 100%;
	max-height: calc(100vh - 32px); overflow-y: auto;
	color: #f0f0f0; box-shadow: 0 24px 64px rgba(0,0,0,.6);
	transform: translateY(10px) scale(.97); opacity: 0;
	transition: transform .22s cubic-bezier(.16,1,.3,1), opacity .22s ease;
}
.skill-pay-overlay.is-open .skill-pay-box { transform: none; opacity: 1; }
.skill-pay-head {
	display: flex; align-items: center; justify-content: space-between;
	margin-bottom: 20px;
}
.skill-pay-title { font-size: 17px; font-weight: 700; letter-spacing: .01em; }
.skill-pay-close {
	background: none; border: none; color: rgba(255,255,255,.5); font-size: 22px;
	cursor: pointer; line-height: 1; padding: 0; transition: color .15s;
}
.skill-pay-close:hover { color: #fff; }
.skill-pay-skill {
	font-size: 15px; font-weight: 600; color: #ffffff;
	background: rgba(255,255,255,.05); border-radius: 8px;
	padding: 8px 12px; margin: 0 0 8px; font-family: monospace;
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.skill-pay-desc { font-size: 13px; color: rgba(255,255,255,.55); margin: 0 0 16px; }
.skill-pay-price {
	display: flex; align-items: center; justify-content: space-between;
	font-size: 15px; margin-bottom: 20px; padding: 12px;
	background: rgba(255,255,255,.05); border-radius: 10px;
}
.skill-pay-price strong { font-size: 20px; color: #34d399; }
.skill-pay-price .usd-eq { font-size: 13px; color: rgba(255,255,255,.45); margin-left: 6px; }
.skill-pay-wallet-area { margin-bottom: 12px; }
/* Proof-phase promo: struck list price + live spots-left counter. */
.skill-pay-list {
	font-size: 14px; color: rgba(255,255,255,.35); text-decoration: line-through;
	font-weight: 400; margin-right: 8px;
}
.skill-pay-promo {
	display: flex; align-items: center; gap: 8px;
	margin: -10px 0 16px; padding: 8px 12px;
	background: rgba(52,211,153,.08); border: 1px solid rgba(52,211,153,.3);
	border-radius: 10px; font-size: 12px; color: rgba(255,255,255,.75);
}
.skill-pay-promo[hidden] { display: none; }
.skill-pay-promo-spots {
	margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 700;
	color: #34d399; white-space: nowrap;
}
.skill-pay-btn {
	width: 100%; padding: 12px; border-radius: 10px; border: none;
	font-size: 14px; font-weight: 600; cursor: pointer;
	background: rgba(255,255,255,0.12); color: #fff; border: 1px solid rgba(255,255,255,0.18);
	transition: opacity .15s; letter-spacing: .02em;
}
.skill-pay-btn:hover:not(:disabled) { opacity: .88; }
.skill-pay-btn:disabled { opacity: .4; cursor: default; }
.skill-pay-confirm {
	width: 100%; padding: 13px; border-radius: 10px; border: none;
	font-size: 15px; font-weight: 700; cursor: pointer; letter-spacing: .02em;
	background: linear-gradient(135deg, #059669, #047857); color: #fff;
	transition: opacity .15s; margin-top: 10px;
}
.skill-pay-confirm:hover:not(:disabled) { opacity: .88; }
.skill-pay-confirm:disabled { opacity: .35; cursor: default; }
.skill-pay-status {
	margin-top: 12px; font-size: 13px; min-height: 18px; text-align: center;
	color: rgba(255,255,255,.6);
}
.skill-pay-status.err { color: #f87171; }
.skill-pay-status.ok  { color: #34d399; }
/* Checkout step tracker: the flow is always visible, not narrated one line
   at a time: Connect → Approve → Confirm → Record. */
.skill-pay-steps {
	list-style: none; display: flex; align-items: center;
	margin: 0 0 16px; padding: 0;
}
.skill-pay-step { display: flex; align-items: center; gap: 6px; min-width: 0; }
.skill-pay-step + .skill-pay-step { flex: 1; }
.skill-pay-step + .skill-pay-step::before {
	content: ''; flex: 1 0 10px; height: 1px; margin: 0 6px;
	background: rgba(255,255,255,.14); transition: background .25s;
}
.skill-pay-step.is-done + .skill-pay-step::before { background: rgba(52,211,153,.5); }
.skill-pay-step-dot {
	width: 18px; height: 18px; border-radius: 50%; flex: 0 0 auto;
	display: inline-flex; align-items: center; justify-content: center;
	font-size: 10px; line-height: 1; color: rgba(255,255,255,.45);
	border: 1px solid rgba(255,255,255,.22); background: rgba(255,255,255,.04);
	transition: border-color .25s, background .25s, color .25s, box-shadow .25s;
}
.skill-pay-step-label {
	font-size: 10.5px; color: rgba(255,255,255,.4); letter-spacing: .05em;
	text-transform: uppercase; white-space: nowrap; transition: color .25s;
}
.skill-pay-step.is-active .skill-pay-step-dot {
	border-color: #a78bfa; color: #a78bfa;
	box-shadow: 0 0 0 3px rgba(167,139,250,.16);
	animation: skill-pay-step-pulse 1.6s ease-in-out infinite;
}
.skill-pay-step.is-active .skill-pay-step-label { color: rgba(255,255,255,.85); }
.skill-pay-step.is-done .skill-pay-step-dot {
	border-color: rgba(52,211,153,.7); background: rgba(52,211,153,.16); color: #34d399;
}
.skill-pay-step.is-done .skill-pay-step-label { color: rgba(52,211,153,.75); }
.skill-pay-step.is-err .skill-pay-step-dot {
	border-color: rgba(248,113,113,.8); background: rgba(248,113,113,.14); color: #f87171;
	animation: none;
}
.skill-pay-step.is-err .skill-pay-step-label { color: #f87171; }
@keyframes skill-pay-step-pulse {
	0%, 100% { box-shadow: 0 0 0 3px rgba(167,139,250,.16); }
	50% { box-shadow: 0 0 0 5px rgba(167,139,250,.08); }
}
@media (prefers-reduced-motion: reduce) {
	.skill-pay-step.is-active .skill-pay-step-dot { animation: none; }
}
.skill-pay-open-link {
	display: block; text-align: center; margin-top: 14px;
	font-size: 12px; color: rgba(255,255,255,.4); text-decoration: none;
}
.skill-pay-open-link:hover { color: rgba(255,255,255,.7); text-decoration: underline; }
.skill-pay-add-funds, .pay-chip-add-funds {
	margin-left: 6px; padding: 3px 9px; border-radius: 7px; cursor: pointer;
	font: inherit; font-size: 12px; font-weight: 600;
	background: rgba(52,211,153,.14); color: #34d399;
	border: 1px solid rgba(52,211,153,.4); transition: background .15s;
}
.skill-pay-add-funds:hover, .pay-chip-add-funds:hover { background: rgba(52,211,153,.24); }
.usd-eq.is-loading {
	display: inline-block; width: 46px; height: 11px; border-radius: 4px;
	vertical-align: middle; color: transparent;
	background: linear-gradient(90deg, rgba(255,255,255,.06) 25%, rgba(255,255,255,.14) 37%, rgba(255,255,255,.06) 63%);
	background-size: 320% 100%; animation: skill-pay-shimmer 1.2s ease-in-out infinite;
}
@keyframes skill-pay-shimmer { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
.skill-pay-btn:focus-visible, .skill-pay-confirm:focus-visible,
.skill-pay-close:focus-visible, .skill-pay-open-link:focus-visible,
.skill-pay-add-funds:focus-visible, .pay-chip-btn:focus-visible,
.pay-chip-add-funds:focus-visible {
	outline: 2px solid #34d399; outline-offset: 2px; border-radius: 8px;
}
@media (prefers-reduced-motion: reduce) {
	.skill-pay-overlay, .skill-pay-box, .pay-chip { transition: none; animation: none; }
	.skill-pay-box { transform: none; opacity: 1; }
	.usd-eq.is-loading { animation: none; }
}
`;

export class SkillPaymentModal {
	/**
	 * @param {ShadowRoot|Document} root  where to inject the modal element
	 * @param {string} agentId            the seller agent's UUID
	 */
	constructor(root, agentId) {
		this._root = root;
		this._agentId = agentId;
		this._resolve = null;
		this._wallet = null;
		this._connection = null;
		this._activePurchase = null;
		this._el = null;
		this._lastFocus = null;
		this._hideTimer = null;
		this._init();
	}

	_init() {
		// Inject <style> and overlay into the shadow/light DOM once.
		const style = document.createElement('style');
		style.textContent = STYLE;
		this._root.appendChild(style);

		const el = document.createElement('div');
		el.className = 'skill-pay-overlay';
		el.setAttribute('hidden', '');
		el.innerHTML = `
			<div class="skill-pay-box" role="dialog" aria-modal="true" aria-labelledby="skill-pay-title-text">
				<div class="skill-pay-head">
					<span class="skill-pay-title" id="skill-pay-title-text">Unlock Skill</span>
					<button class="skill-pay-close" aria-label="Close">×</button>
				</div>
				<p class="skill-pay-skill"></p>
				<p class="skill-pay-desc">This skill requires a one-time payment to unlock.</p>
				<ol class="skill-pay-steps">
					<li class="skill-pay-step" data-step="connect"><span class="skill-pay-step-dot">1</span><span class="skill-pay-step-label">Connect</span></li>
					<li class="skill-pay-step" data-step="approve"><span class="skill-pay-step-dot">2</span><span class="skill-pay-step-label">Approve</span></li>
					<li class="skill-pay-step" data-step="confirm"><span class="skill-pay-step-dot">3</span><span class="skill-pay-step-label">Confirm</span></li>
					<li class="skill-pay-step" data-step="record"><span class="skill-pay-step-dot">4</span><span class="skill-pay-step-label">Record</span></li>
				</ol>
				<div class="skill-pay-price">
					<span>Total</span>
					<strong><span class="skill-pay-list" hidden></span><span class="skill-pay-amount"></span><span class="usd-eq" hidden></span></strong>
				</div>
				<div class="skill-pay-promo" hidden></div>
				<div class="skill-pay-wallet-area">
					<button class="skill-pay-btn" id="skill-pay-connect">Connect Phantom</button>
				</div>
				<button class="skill-pay-confirm" disabled>Confirm Purchase</button>
				<div class="skill-pay-status" role="status" aria-live="polite"></div>
				<a class="skill-pay-open-link" target="_blank" rel="noopener">
					Open in marketplace →
				</a>
			</div>
		`;
		this._root.appendChild(el);
		this._el = el;

		el.querySelector('.skill-pay-close').addEventListener('click', () => this._cancel());
		el.addEventListener('click', (e) => { if (e.target === el) this._cancel(); });
		el.querySelector('#skill-pay-connect').addEventListener('click', () => this._connectWallet());
		el.querySelector('.skill-pay-confirm').addEventListener('click', () => this._purchase());
		// Keyboard: Escape dismisses, Tab is trapped inside the dialog so focus
		// can't wander to the host page behind the modal.
		el.addEventListener('keydown', (e) => this._onKeydown(e));
	}

	_onKeydown(e) {
		if (!this._el || this._el.hasAttribute('hidden')) return;
		if (e.key === 'Escape') { e.preventDefault(); this._cancel(); return; }
		if (e.key !== 'Tab') return;
		const focusable = this._focusables();
		if (!focusable.length) return;
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		const active = this._activeElement();
		if (e.shiftKey && (active === first || !focusable.includes(active))) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && active === last) {
			e.preventDefault();
			first.focus();
		}
	}

	// Visible, enabled, focusable controls inside the dialog box, in DOM order.
	_focusables() {
		const box = this._el?.querySelector('.skill-pay-box');
		if (!box) return [];
		const sel = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
		return Array.from(box.querySelectorAll(sel)).filter(
			(n) => n.offsetParent !== null || n.getClientRects().length > 0,
		);
	}

	// activeElement resolves through the shadow boundary the modal lives in.
	_activeElement() {
		return this._root.activeElement || document.activeElement || null;
	}

	_prefersReducedMotion() {
		try {
			return !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
		} catch {
			return false;
		}
	}

	_restoreFocus() {
		const target = this._lastFocus;
		this._lastFocus = null;
		if (target && typeof target.focus === 'function') {
			try { target.focus(); } catch { /* element may be gone */ }
		}
	}

	/**
	 * Show the modal for a payment-required event.
	 * @param {{ skill: string, price?: { amount: string|number, currency_mint: string, chain: string } }} payload
	 * @returns {Promise<boolean>} resolves true if purchased, false if dismissed
	 */
	show(payload) {
		return new Promise((resolve) => {
			this._resolve = resolve;
			this._activePurchase = null;

			const { skill = 'skill', price = {} } = payload;
			const amountUsdc = (Number(price.amount || 0) / 10 ** USDC_DECIMALS).toFixed(2);
			const currency = price.chain === 'solana' ? 'USDC' : price.currency_mint?.slice(0, 8) || 'USDC';

			this._el.querySelector('.skill-pay-skill').textContent = skill;
			const amountEl = this._el.querySelector('.skill-pay-amount');
			const usdEqEl  = this._el.querySelector('.skill-pay-price .usd-eq');
			amountEl.textContent = `${amountUsdc} ${currency}`;
			// Show a shimmer placeholder while the USD equivalent resolves so the
			// price row doesn't shift when it arrives.
			usdEqEl.textContent = '';
			usdEqEl.hidden = false;
			usdEqEl.classList.add('is-loading');
			const humanAmount = Number(price.amount || 0) / 10 ** USDC_DECIMALS;
			const eqPromise = currency === 'USDC' ? Promise.resolve(formatUsdcEq(humanAmount)) : formatSolEq(humanAmount);
			eqPromise.then((eq) => {
				usdEqEl.classList.remove('is-loading');
				if (eq) { usdEqEl.textContent = eq; usdEqEl.hidden = false; }
				else { usdEqEl.hidden = true; }
			});
			this._el.querySelector('.skill-pay-open-link').href =
				`/marketplace/agents/${this._agentId}?buy=${encodeURIComponent(skill)}`;

			// Proof-phase promo: ask the server what the quote will actually charge.
			// When a first-N rule is live, show the real price (list struck through)
			// and the live spots-left count; when the passed-in price is already
			// current, this renders nothing and costs one cached GET.
			const listEl = this._el.querySelector('.skill-pay-list');
			const promoEl = this._el.querySelector('.skill-pay-promo');
			listEl.hidden = true;
			promoEl.hidden = true;
			fetch(`/api/marketplace/skill-promo?agent_id=${encodeURIComponent(this._agentId)}&skill=${encodeURIComponent(skill)}`)
				.then((r) => (r.ok ? r.json() : null))
				.then((j) => {
					const state = j?.data;
					if (!state || this._el.hasAttribute('hidden')) return;
					const effective = Number(state.effective_amount);
					if (Number.isFinite(effective) && String(state.effective_amount) !== String(price.amount || '')) {
						amountEl.textContent = `${(effective / 10 ** USDC_DECIMALS).toFixed(2)} ${currency}`;
					}
					const promo = state.promo;
					if (!promo) return;
					const listUsdc = (Number(promo.list_amount) / 10 ** USDC_DECIMALS).toFixed(2);
					listEl.textContent = `${listUsdc} ${currency}`;
					listEl.hidden = false;
					promoEl.textContent = '';
					const label = document.createElement('span');
					label.textContent =
						Number(promo.promo_amount) === 0
							? `Proof phase: first ${promo.threshold} buyers get it free`
							: `Proof phase: first ${promo.threshold} buyers at this price`;
					const spots = document.createElement('span');
					spots.className = 'skill-pay-promo-spots';
					spots.textContent = `${promo.spots_left} left`;
					promoEl.append(label, spots);
					promoEl.hidden = false;
				})
				.catch(() => {});

			this._setStatus('');
			this._el.querySelector('.skill-pay-confirm').disabled = true;
			this._updateWalletArea();
			this._setStep(this._wallet?.isConnected || window.solana?.isConnected ? 'approve' : 'connect');

			// Remember what had focus so we can hand it back on close, then open
			// with a fade/scale entrance and move focus to the primary action.
			this._lastFocus = this._activeElement();
			if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
			this._el.removeAttribute('hidden');
			const reveal = () => {
				this._el.classList.add('is-open');
				const primary =
					this._el.querySelector('#skill-pay-connect') ||
					this._el.querySelector('.skill-pay-confirm:not([disabled])') ||
					this._el.querySelector('.skill-pay-close');
				primary?.focus();
			};
			if (this._prefersReducedMotion()) reveal();
			else requestAnimationFrame(reveal);
		});
	}

	hide() {
		const el = this._el;
		if (!el) return;
		el.classList.remove('is-open');
		this._restoreFocus();
		if (this._prefersReducedMotion()) {
			el.setAttribute('hidden', '');
			return;
		}
		// Defer the display:none until the fade-out transition finishes (with a
		// timeout fallback in case transitionend never fires).
		const finish = () => {
			if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
			el.removeEventListener('transitionend', onEnd);
			if (!el.classList.contains('is-open')) el.setAttribute('hidden', '');
		};
		const onEnd = (e) => { if (e.target === el) finish(); };
		el.addEventListener('transitionend', onEnd);
		this._hideTimer = setTimeout(finish, 280);
	}

	_cancel() {
		this.hide();
		this._resolve?.(false);
		this._resolve = null;
	}

	_setStatus(msg, kind = '') {
		const el = this._el.querySelector('.skill-pay-status');
		el.textContent = msg;
		el.className = 'skill-pay-status' + (kind ? ' ' + kind : '');
	}

	/**
	 * Advance the step tracker. Steps before `active` render done, `active`
	 * pulses, later ones stay idle. Pass 'done' to complete the whole row.
	 * The escalation mirrors the wire flow exactly: Connect (wallet) →
	 * Approve (signature) → Confirm (on-chain) → Record (server verdict).
	 */
	_setStep(active) {
		const order = ['connect', 'approve', 'confirm', 'record'];
		const activeIdx = active === 'done' ? order.length : order.indexOf(active);
		this._el.querySelectorAll('.skill-pay-step').forEach((li) => {
			const idx = order.indexOf(li.dataset.step);
			const done = idx < activeIdx;
			li.classList.toggle('is-done', done);
			li.classList.toggle('is-active', idx === activeIdx);
			li.classList.remove('is-err');
			const dot = li.querySelector('.skill-pay-step-dot');
			if (dot) dot.textContent = done ? '✓' : String(idx + 1);
		});
	}

	/** Mark the currently active step as failed (keeps earlier ✓s). */
	_stepError() {
		const li = this._el.querySelector('.skill-pay-step.is-active');
		if (li) {
			li.classList.remove('is-active');
			li.classList.add('is-err');
			const dot = li.querySelector('.skill-pay-step-dot');
			if (dot) dot.textContent = '!';
		}
	}

	_setStatusHTML(html, kind = '') {
		const el = this._el.querySelector('.skill-pay-status');
		el.innerHTML = html;
		el.className = 'skill-pay-status' + (kind ? ' ' + kind : '');
	}

	_showInsufficientFunds(walletAddress, requiredAtomic, currentAtomic, confirmBtn) {
		const requiredUsdc = requiredAtomic ? (requiredAtomic / 1e6).toFixed(2) : null;
		const currentUsdc = currentAtomic != null ? (currentAtomic / 1e6).toFixed(2) : null;
		const needed = requiredUsdc
			? (currentUsdc != null ? `Need ${requiredUsdc} USDC, have ${currentUsdc}.` : `Need ${requiredUsdc} USDC.`)
			: '';
		this._setStatus(`Not enough USDC. ${needed}`, 'err');

		const statusEl = this._el.querySelector('.skill-pay-status');
		const addBtn = document.createElement('button');
		addBtn.className = 'skill-pay-add-funds';
		addBtn.textContent = 'Add funds →';
		addBtn.addEventListener('click', async () => {
			const result = await showAddFunds({
				walletAddress: walletAddress || '',
				requiredUsdc: requiredAtomic ? requiredAtomic / 1e6 : undefined,
				container: this._root.host?.getRootNode?.()?.body || document.body,
			});
			if (result?.usdc) {
				this._setStatus(`Balance updated: ${result.usdc.toFixed(2)} USDC — try again.`, 'ok');
				if (confirmBtn) confirmBtn.disabled = false;
			}
		});
		statusEl.appendChild(document.createTextNode(' '));
		statusEl.appendChild(addBtn);
		if (confirmBtn) confirmBtn.disabled = false;
	}

	_updateWalletArea() {
		const area = this._el.querySelector('.skill-pay-wallet-area');
		const confirm = this._el.querySelector('.skill-pay-confirm');
		if (this._wallet?.isConnected || window.solana?.isConnected) {
			const pub = (this._wallet?.publicKey || window.solana?.publicKey)?.toBase58?.() || '';
			area.innerHTML = `<div style="font-size:12px;color:rgba(255,255,255,.5);padding:8px 0">
				Connected: <code>${pub.slice(0, 6)}…${pub.slice(-4)}</code>
				<button id="skill-pay-disconnect" style="margin-left:8px;font-size:11px;background:none;border:1px solid rgba(255,255,255,.2);border-radius:6px;color:rgba(255,255,255,.5);cursor:pointer;padding:2px 6px">Disconnect</button>
			</div>`;
			area.querySelector('#skill-pay-disconnect')?.addEventListener('click', () => this._disconnect());
			confirm.disabled = false;
		} else {
			area.innerHTML = `<button class="skill-pay-btn" id="skill-pay-connect">Connect Phantom</button>`;
			area.querySelector('#skill-pay-connect')?.addEventListener('click', () => this._connectWallet());
			confirm.disabled = true;
		}
	}

	async _connectWallet() {
		const btn = this._el.querySelector('#skill-pay-connect');
		if (btn) { btn.textContent = 'Connecting…'; btn.disabled = true; }
		this._setStep('connect');
		try {
			// Try injected Phantom wallet first, then wallet adapter
			if (window.solana?.isPhantom || window.solana?.connect) {
				await window.solana.connect();
				this._wallet = window.solana;
			} else {
				this._setStatus('Phantom isn\'t installed. Get it at phantom.app — takes about a minute, then come back.', 'err');
				if (btn) {
					btn.textContent = 'Get Phantom';
					btn.disabled = false;
					btn.onclick = () => window.open('https://phantom.app/', '_blank', 'noopener');
				}
				return;
			}
			this._setStatus('');
			this._updateWalletArea();
			this._setStep('approve');
		} catch (e) {
			log.warn('[three.ws] payment-modal connect error:', e);
			this._stepError();
			if (/reject|denied|cancel|user.*declin/i.test(e.message || '')) {
				this._setStatus('Connection cancelled — try again when you\'re ready.', 'err');
			} else {
				this._setStatus('Couldn\'t connect to your wallet — try again.', 'err');
			}
			if (btn) { btn.textContent = 'Connect Phantom'; btn.disabled = false; }
		}
	}

	_disconnect() {
		this._wallet?.disconnect?.();
		this._wallet = null;
		this._updateWalletArea();
	}

	async _purchase() {
		if (!(await ensureRiskAck({ context: 'skill-purchase' }))) return;
		const confirm = this._el.querySelector('.skill-pay-confirm');
		confirm.disabled = true;

		const skill = this._el.querySelector('.skill-pay-skill').textContent;

		// Step 1: Create pending purchase record
		this._setStep('approve');
		this._setStatus('Creating purchase…');
		let purchase;
		try {
			const r = await fetch('/api/marketplace/purchase', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ agent_id: this._agentId, skill }),
			});
			const j = await r.json();
			if (!r.ok) throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
			purchase = j.data;
			if (purchase.already_owned) {
				this._setStep('done');
				this._setStatus('✓ Already purchased — access granted.', 'ok');
				await delay(1000);
				this.hide();
				this._resolve?.(true);
				this._resolve = null;
				return;
			}
		} catch (e) {
			this._stepError();
			this._setStatus(e.message || 'Failed to start purchase', 'err');
			confirm.disabled = false;
			return;
		}

		// Step 2: Build + sign + send the SPL transfer
		this._setStatus('Building transaction…');
		const txStartMs = Date.now();
		// Once the transfer is broadcast the money is in flight — any later error
		// (confirm timeout, server mismatch) must NOT re-arm the pay button, or the
		// user pays a second time. Only pre-broadcast failures are retryable.
		let broadcast = false;
		try {
			const { web3, spl } = await loadSolana();
			const { Connection, PublicKey, Transaction } = web3;
			const { getAssociatedTokenAddressSync, createTransferInstruction, getAccount } = spl;

			if (!this._connection) {
				const rpc = window.__solanaRpc || `${window.location.origin}/api/solana-rpc`;
				this._connection = new Connection(rpc, 'confirmed');
			}

			const payer = this._wallet?.publicKey || window.solana?.publicKey;
			if (!payer) throw new Error('Wallet not connected');

			const payerKey = new PublicKey(payer.toBase58());
			const recipientKey = new PublicKey(purchase.recipient);
			const mintKey = new PublicKey(purchase.currency_mint);
			const referenceKey = new PublicKey(purchase.reference);

			const fromAta = getAssociatedTokenAddressSync(mintKey, payerKey);
			const toAta = getAssociatedTokenAddressSync(mintKey, recipientKey);

			// Pre-flight balance check: surface "Add funds" before wallet prompt
			try {
				const ataInfo = await getAccount(this._connection, fromAta, 'confirmed');
				const balance = BigInt(ataInfo.amount);
				const required = BigInt(purchase.amount);
				if (balance < required) {
					this._showInsufficientFunds(payerKey.toBase58(), Number(required), Number(balance), confirm);
					return;
				}
			} catch {
				// ATA may not exist yet — let sendTransaction surface the real error
			}

			const ix = createTransferInstruction(fromAta, toAta, payerKey, BigInt(purchase.amount));
			ix.keys.push({ pubkey: referenceKey, isSigner: false, isWritable: false });

			const { blockhash, lastValidBlockHeight } = await this._connection.getLatestBlockhash('confirmed');
			const tx = new Transaction({ feePayer: payerKey, recentBlockhash: blockhash }).add(ix);

			this._setStatus('Approve in wallet…');
			const wallet = this._wallet || window.solana;
			const txid = await wallet.sendTransaction(tx, this._connection);
			broadcast = true;

			this._setStep('confirm');
			this._setStatus('Waiting for confirmation…');
			// Bind confirmation to the blockhash's expiry so a dropped tx fails fast
			// instead of polling the signature for the full default timeout.
			await this._connection.confirmTransaction({ signature: txid, blockhash, lastValidBlockHeight }, 'confirmed');

			this._setStep('record');
			this._setStatus('Verifying with server…');
			const ok = await this._pollConfirm(purchase.reference);
			if (!ok) {
				log.warn('[three.ws] payment-modal: verification failed, tx:', txid);
				throw new Error('verification_failed');
			}

			const receiptHtml = buildReceiptHTML({
				usdcAtomic: purchase.amount,
				recipientLabel: 'creator',
				elapsedMs: Date.now() - txStartMs,
				explorerUrl: `https://solscan.io/tx/${txid}`,
				signature: txid,
			});
			this._setStep('done');
			this._setStatusHTML(receiptHtml, 'ok');
			await delay(1800);
			this.hide();
			this._resolve?.(true);
			this._resolve = null;
		} catch (e) {
			log.warn('[three.ws] payment-modal purchase error:', e);
			this._stepError();
			const msg = e.message || '';
			const payerAddr = (this._wallet?.publicKey || window.solana?.publicKey)?.toBase58?.() || null;
			// After broadcast the transfer is irreversible — present a terminal state
			// and leave the pay button disabled so the user can't double-pay.
			if (broadcast) {
				if (e?.code === 'mismatch') {
					this._setStatus('Payment was sent but didn\'t match the expected amount or recipient. Don\'t pay again — contact support with this transaction.', 'err');
				} else {
					this._setStatus('Payment was sent but couldn\'t be confirmed in time. Don\'t pay again — check your wallet, and contact support if funds were deducted.', 'err');
				}
				return;
			}
			if (/reject|denied|cancel|user.*declin/i.test(msg)) {
				this._setStatus('Transaction cancelled — try again whenever you\'re ready.', 'err');
			} else if (/insufficient|balance|funds/i.test(msg)) {
				this._showInsufficientFunds(payerAddr, purchase?.amount, null, confirm);
				return;
			} else if (/network|fetch|econnrefused/i.test(msg)) {
				this._setStatus('Connection problem — check your internet and try again.', 'err');
			} else {
				this._setStatus('Purchase didn\'t go through — try again.', 'err');
			}
			confirm.disabled = false;
		}
	}

	async _pollConfirm(reference, maxMs = 60_000) {
		const deadline = Date.now() + maxMs;
		while (Date.now() < deadline) {
			const r = await fetch(`/api/marketplace/purchase/${reference}/confirm`, {
				method: 'POST',
				credentials: 'include',
			});
			const j = await r.json().catch(() => ({}));
			if (r.ok && j.data?.status === 'confirmed') return true;
			if (r.status === 409) {
				// Definitive server verdict: the on-chain transfer didn't match.
				// Tag it so the caller renders a terminal "don't pay again" state.
				const err = new Error(j.error_description || 'Transfer mismatch');
				err.code = 'mismatch';
				throw err;
			}
			await delay(2500);
		}
		return false;
	}

	destroy() {
		if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
		this._el?.remove();
		this._el = null;
	}
}

/**
 * PaymentChip — compact inline payment card that renders inside the chat thread.
 * Replaces the blocking SkillPaymentModal overlay with a conversational flow.
 * The agent narrates before/after; the chip handles wallet connection + SPL transfer.
 */
export class PaymentChip {
	/** @param {string} agentId  seller agent UUID */
	constructor(agentId) {
		this._agentId = agentId;
		this._wallet = null;
		this._connection = null;
	}

	/**
	 * Inject a payment chip into chatEl and return a promise that resolves
	 * true (purchased) or false (dismissed / failed).
	 * @param {Element} chatEl
	 * @param {{ skill: string, price?: { amount: string|number, currency_mint: string, chain: string } }} payload
	 * @returns {Promise<boolean>}
	 */
	show(chatEl, payload) {
		return new Promise((resolve) => {
			const { skill = 'skill', price = {} } = payload;
			const amountUsdc = (Number(price.amount || 0) / 10 ** USDC_DECIMALS).toFixed(2);
			const currency = price.chain === 'solana' ? 'USDC' : (price.currency_mint?.slice(0, 8) || 'USDC');

			const wrapper = document.createElement('div');
			wrapper.className = 'msg';
			wrapper.innerHTML = `
				<div class="role">agent</div>
				<div class="body">
					<div class="pay-chip">
						<div class="pay-chip-head">
							<span class="pay-chip-label">Payment required</span>
						</div>
						<div class="pay-chip-skill">${escHtml(skill)}</div>
						<div class="pay-chip-price">${escHtml(amountUsdc)} ${escHtml(currency)}<span class="usd-eq" hidden></span></div>
						<div class="pay-chip-actions"></div>
						<div class="pay-chip-status"></div>
					</div>
				</div>
			`;
			const chipUsdEq = wrapper.querySelector('.pay-chip-price .usd-eq');
			const humanAmountChip = Number(price.amount || 0) / 10 ** USDC_DECIMALS;
			const chipEqPromise = currency === 'USDC' ? Promise.resolve(formatUsdcEq(humanAmountChip)) : formatSolEq(humanAmountChip);
			chipEqPromise.then((eq) => { if (eq) { chipUsdEq.textContent = eq; chipUsdEq.hidden = false; } });

			const setStatus = (msg, kind = '') => {
				const el = wrapper.querySelector('.pay-chip-status');
				el.textContent = msg;
				el.className = 'pay-chip-status' + (kind ? ' ' + kind : '');
			};

			const dismiss = (result) => {
				wrapper.remove();
				resolve(result);
			};

			const updateActions = () => {
				const actions = wrapper.querySelector('.pay-chip-actions');
				const connected = this._wallet?.isConnected || window.solana?.isConnected;
				if (connected) {
					actions.innerHTML = `
						<button class="pay-chip-btn pay-chip-btn-pay">Pay ${escHtml(amountUsdc)} ${escHtml(currency)}</button>
						<button class="pay-chip-btn pay-chip-btn-cancel">Cancel</button>
					`;
					actions.querySelector('.pay-chip-btn-pay').addEventListener('click', () => runPurchase());
				} else {
					actions.innerHTML = `
						<button class="pay-chip-btn pay-chip-btn-connect">Connect Phantom</button>
						<button class="pay-chip-btn pay-chip-btn-cancel">Dismiss</button>
					`;
					actions.querySelector('.pay-chip-btn-connect').addEventListener('click', () => connectWallet());
				}
				actions.querySelector('.pay-chip-btn-cancel').addEventListener('click', () => dismiss(false));
			};

			const connectWallet = async () => {
				setStatus('Connecting…');
				try {
					if (window.solana?.isPhantom || window.solana?.connect) {
						await window.solana.connect();
						this._wallet = window.solana;
						setStatus('');
						updateActions();
					} else {
						setStatus('Phantom isn\'t installed. Get it at phantom.app — takes about a minute.', 'err');
						const connectBtn = wrapper.querySelector('.pay-chip-btn-connect');
						if (connectBtn) {
							connectBtn.textContent = 'Get Phantom';
							connectBtn.onclick = () => window.open('https://phantom.app/', '_blank', 'noopener');
						}
					}
				} catch (e) {
					log.warn('[three.ws] payment-chip connect error:', e);
					if (/reject|denied|cancel|user.*declin/i.test(e.message || '')) {
						setStatus('Connection cancelled — try again when you\'re ready.', 'err');
					} else {
						setStatus('Couldn\'t connect to your wallet — try again.', 'err');
					}
				}
			};

			const runPurchase = async () => {
				const payBtn = wrapper.querySelector('.pay-chip-btn-pay');
				if (payBtn) payBtn.disabled = true;

				setStatus('Creating purchase…');
				let purch;
				try {
					const r = await fetch('/api/marketplace/purchase', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						credentials: 'include',
						body: JSON.stringify({ agent_id: this._agentId, skill }),
					});
					const j = await r.json();
					if (!r.ok) throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
					purch = j.data;
					if (purch.already_owned) {
						setStatus('Already purchased.', 'ok');
						await delay(800);
						dismiss(true);
						return;
					}
				} catch (e) {
					setStatus(e.message || 'Failed to start purchase', 'err');
					if (payBtn) payBtn.disabled = false;
					return;
				}

				setStatus('Building transaction…');
				const chipTxStart = Date.now();
				const chipPayerAddr = (this._wallet?.publicKey || window.solana?.publicKey)?.toBase58?.() || '';

				const showChipAddFunds = (requiredAtomic, currentAtomic) => {
					const requiredUsdc = requiredAtomic ? (requiredAtomic / 1e6).toFixed(2) : null;
					const currentUsdc = currentAtomic != null ? (currentAtomic / 1e6).toFixed(2) : null;
					const needed = requiredUsdc
						? (currentUsdc != null ? `Need ${requiredUsdc} USDC, have ${currentUsdc}.` : `Need ${requiredUsdc} USDC.`)
						: '';
					setStatus(`Not enough USDC. ${needed}`, 'err');

					// Inject "Add funds" button after the status text
					const statusEl = wrapper.querySelector('.pay-chip-status');
					const btn = document.createElement('button');
					btn.className = 'pay-chip-add-funds';
					btn.textContent = 'Add funds →';
					btn.addEventListener('click', async () => {
						const result = await showAddFunds({
							walletAddress: chipPayerAddr,
							requiredUsdc: requiredAtomic ? requiredAtomic / 1e6 : undefined,
						});
						if (result?.usdc) {
							setStatus(`Balance updated: ${result.usdc.toFixed(2)} USDC — try again.`, 'ok');
							if (payBtn) payBtn.disabled = false;
						}
					});
					statusEl.appendChild(document.createTextNode(' '));
					statusEl.appendChild(btn);
					if (payBtn) payBtn.disabled = false;
				};

				// Once broadcast, the transfer is irreversible — never re-arm the pay
				// button on a later error, or the user double-pays.
				let broadcast = false;
				try {
					const { web3, spl } = await loadSolana();
					const { Connection, PublicKey, Transaction } = web3;
					const { getAssociatedTokenAddressSync, createTransferInstruction, getAccount } = spl;

					if (!this._connection) {
						const rpc = window.__solanaRpc || `${window.location.origin}/api/solana-rpc`;
						this._connection = new Connection(rpc, 'confirmed');
					}

					const payer = this._wallet?.publicKey || window.solana?.publicKey;
					if (!payer) throw new Error('Wallet not connected');

					const payerKey = new PublicKey(payer.toBase58());
					const recipientKey = new PublicKey(purch.recipient);
					const mintKey = new PublicKey(purch.currency_mint);
					const referenceKey = new PublicKey(purch.reference);

					const fromAta = getAssociatedTokenAddressSync(mintKey, payerKey);
					const toAta = getAssociatedTokenAddressSync(mintKey, recipientKey);

					// Pre-flight balance check before showing the wallet prompt
					try {
						const ataInfo = await getAccount(this._connection, fromAta, 'confirmed');
						if (BigInt(ataInfo.amount) < BigInt(purch.amount)) {
							showChipAddFunds(purch.amount, Number(ataInfo.amount));
							return;
						}
					} catch {
						// ATA not yet created — proceed; sendTransaction will surface the error
					}

					const ix = createTransferInstruction(fromAta, toAta, payerKey, BigInt(purch.amount));
					ix.keys.push({ pubkey: referenceKey, isSigner: false, isWritable: false });

					const { blockhash, lastValidBlockHeight } = await this._connection.getLatestBlockhash('confirmed');
					const tx = new Transaction({ feePayer: payerKey, recentBlockhash: blockhash }).add(ix);

					setStatus('Approve in your wallet…');
					const wallet = this._wallet || window.solana;
					const txid = await wallet.sendTransaction(tx, this._connection);
					broadcast = true;

					setStatus('Confirming…');
					await this._connection.confirmTransaction({ signature: txid, blockhash, lastValidBlockHeight }, 'confirmed');

					setStatus('Verifying…');
					const ok = await this._pollConfirm(purch.reference);
					if (!ok) {
						log.warn('[three.ws] payment-chip: verification failed, tx:', txid);
						throw new Error('verification_failed');
					}

					const chipReceiptHtml = buildReceiptHTML({
						usdcAtomic: purch.amount,
						recipientLabel: 'creator',
						elapsedMs: Date.now() - chipTxStart,
						explorerUrl: `https://solscan.io/tx/${txid}`,
						signature: txid,
					});
					const statusEl = wrapper.querySelector('.pay-chip-status');
					if (statusEl) {
						statusEl.innerHTML = chipReceiptHtml;
						statusEl.className = 'pay-chip-status ok';
					}
					await delay(1400);
					dismiss(true);
				} catch (e) {
					log.warn('[three.ws] payment-chip purchase error:', e);
					const msg = e.message || '';
					// After broadcast the money is in flight — terminal state, pay
					// button stays disabled so the user can't pay a second time.
					if (broadcast) {
						if (e?.code === 'mismatch') {
							setStatus('Payment was sent but didn\'t match the expected amount or recipient. Don\'t pay again — contact support with this transaction.', 'err');
						} else {
							setStatus('Payment was sent but couldn\'t be confirmed in time. Don\'t pay again — check your wallet, and contact support if funds were deducted.', 'err');
						}
						return;
					}
					if (/reject|denied|cancel|user.*declin/i.test(msg)) {
						setStatus('Transaction cancelled — try again whenever you\'re ready.', 'err');
					} else if (/insufficient|balance|funds/i.test(msg)) {
						showChipAddFunds(purch?.amount, null);
						return;
					} else if (/network|fetch|econnrefused/i.test(msg)) {
						setStatus('Connection problem — check your internet and try again.', 'err');
					} else {
						setStatus("Purchase didn't go through — try again.", 'err');
					}
					if (payBtn) payBtn.disabled = false;
				}
			};

			updateActions();
			chatEl.appendChild(wrapper);
			chatEl.scrollTop = chatEl.scrollHeight;
		});
	}

	async _pollConfirm(reference, maxMs = 60_000) {
		const deadline = Date.now() + maxMs;
		while (Date.now() < deadline) {
			const r = await fetch(`/api/marketplace/purchase/${reference}/confirm`, {
				method: 'POST',
				credentials: 'include',
			});
			const j = await r.json().catch(() => ({}));
			if (r.ok && j.data?.status === 'confirmed') return true;
			if (r.status === 409) {
				const err = new Error(j.error_description || 'Transfer mismatch');
				err.code = 'mismatch';
				throw err;
			}
			await delay(2500);
		}
		return false;
	}
}

function delay(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
