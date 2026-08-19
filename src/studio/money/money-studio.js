/**
 * Money Studio — controller (P4)
 * ==============================
 * The economic surface of Agent Studio: fund the agent's wallet, price what it
 * sells, and watch what it earns — all against real custodial wallets and the
 * live skill-pricing + payments APIs (no mocks).
 *
 *   • Wallet    — the agent's real custodial Solana wallet: address, live SOL +
 *                 USDC balance, a copy-to-fund deposit path, and a one-click
 *                 provision for an agent that doesn't have a signing wallet yet.
 *   • Pricing   — per-skill prices (USDC) via /api/agents/:id/pricing/:skill.
 *                 Only metered, sellable skills the agent has enabled appear; a
 *                 skill with no price is free. Cross-links to the Skills tab.
 *   • Earnings  — the real payments ledger (/api/agents/:id/payments) of money
 *                 other agents and users have paid this one.
 *
 * Mount: import { mountMoneyStudio } from './money/money-studio.js';
 *        mountMoneyStudio(container, { studio });
 */

import { apiFetch } from '../../api.js';
import { isSellable, skillMeta } from '../skills/skills-catalog.js';
import { mountTradingBrain } from './trading-brain.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
	({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Mainnet USDC — the agent-to-agent x402 settlement asset (6 decimals). Skill
// pricing is denominated in USDC so a buyer agent can pay with a stable rail.
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;
const BALANCE_POLL_MS = 30000;

const fmtUsdc = (atomic) => (Number(atomic || 0) / 10 ** USDC_DECIMALS);
const toAtomic = (usdc) => Math.round(Number(usdc) * 10 ** USDC_DECIMALS);
const short = (addr) => (addr ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : '');

function relTime(ts) {
	if (!ts) return '';
	const d = Date.now() - new Date(ts).getTime();
	if (d < 60000) return 'just now';
	if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
	if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
	if (d < 2592000000) return Math.floor(d / 86400000) + 'd ago';
	return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function mountMoneyStudio(container, { studio }) {
	if (container.dataset.moneyMounted) return;
	container.dataset.moneyMounted = '1';
	container.querySelector('.studio-empty')?.remove();
	return new MoneyStudio(container, studio);
}

class MoneyStudio {
	constructor(el, studio) {
		this.el = el;
		this.studio = studio;
		this.agentId = studio.agent?.id;
		this.state = {
			loading: true,
			error: null,
			wallet: null, // { solana_address, solana_balance, usdc_balance, ... }
			prices: {}, // skill → { amount, currency_mint, chain }
			payments: null, // received payments array
			holdings: null, // { sol, tokens[] } real SPL holdings
			activity: null, // recent on-chain signatures
			provisioning: false,
			withdrawing: false,
			wdAsset: 'SOL', // withdraw form: which asset to send (SOL | USDC)
		};
		this._render();
		this._load();
		// Live balances + earnings while the tab is visible.
		this._poll = setInterval(() => {
			if (document.visibilityState === 'visible' && !this.el.closest('[hidden]')) {
				this._refreshWallet();
				this._refreshEarnings();
			}
		}, BALANCE_POLL_MS);
	}

	_q(sel) { return this.el.querySelector(sel); }

	// ── Data ────────────────────────────────────────────────────────────────

	async _load() {
		this.state.loading = true;
		this._renderBody();
		try {
			const [wallet, prices, payments] = await Promise.all([
				this._fetchWallet(),
				this._fetchPrices(),
				this._fetchPayments(),
			]);
			this.state.wallet = wallet;
			this.state.prices = prices;
			this.state.payments = payments;
			this._earnSig = `${payments.length}:${payments[0]?.tx_hash || payments[0]?.created_at || ''}`;
			this.state.error = null;
			// Holdings + activity are real on-chain reads — fetch after the wallet so
			// we know there's an address; a transient RPC miss never blocks the panel.
			if (wallet?.solana_address) {
				this._fetchHoldings().then((h) => { this.state.holdings = h; this._renderHoldings(); });
				this._fetchActivity().then((a) => { this.state.activity = a; this._renderActivity(); });
			}
		} catch (err) {
			this.state.error = err?.message || 'Could not load the money studio.';
		} finally {
			this.state.loading = false;
			this._renderBody();
		}
	}

	async _fetchWallet() {
		const res = await apiFetch(`/api/agents/${this.agentId}/wallet`);
		if (!res.ok) throw new Error('Could not read the agent wallet.');
		return res.json();
	}

	async _fetchPrices() {
		const res = await apiFetch(`/api/agents/${this.agentId}/pricing`, { allowAnonymous: true });
		if (!res.ok) return {};
		const { prices = [] } = await res.json();
		const map = {};
		for (const p of prices) map[p.skill] = p;
		return map;
	}

	async _fetchPayments() {
		const res = await apiFetch(`/api/agents/${this.agentId}/payments?direction=received&limit=20`);
		if (!res.ok) return [];
		const { payments = [] } = await res.json();
		return payments;
	}

	async _refreshWallet() {
		try {
			const wallet = await this._fetchWallet();
			this.state.wallet = wallet;
			this._renderWalletBalances();
			this._fetchHoldings().then((h) => { this.state.holdings = h; this._renderHoldings(); }).catch(() => {});
		} catch { /* transient RPC hiccup — keep the last balances */ }
	}

	async _fetchHoldings() {
		const res = await apiFetch(`/api/agents/${this.agentId}/solana/holdings`);
		if (!res.ok) return null;
		const { data } = await res.json();
		return data;
	}

	async _fetchActivity() {
		const res = await apiFetch(`/api/agents/${this.agentId}/solana/activity`);
		if (!res.ok) return null;
		const { data } = await res.json();
		return data?.signatures || [];
	}

	// ── Shell ─────────────────────────────────────────────────────────────────

	_render() {
		this.el.innerHTML = `<div class="mny" data-root></div><div class="mny-toast" data-toast hidden></div>`;
	}

	_renderBody() {
		const host = this._q('[data-root]');
		if (this.state.loading) { host.innerHTML = this._skeleton(); return; }
		if (this.state.error) { host.innerHTML = this._errorState(this.state.error); this._bindError(); return; }
		host.innerHTML = `${this._walletSection()}${this._tradingSection()}${this._pricingSection()}${this._earningsSection()}`;
		this._bind();
		this._mountTrading();
	}

	_tradingSection() {
		return `<section class="mny-section mny-section-trading"><div data-trading-brain></div></section>`;
	}

	_mountTrading() {
		const host = this._q('[data-trading-brain]');
		if (host && !host.dataset.tbMounted) {
			this._tradingBrain = mountTradingBrain(host, { studio: this.studio });
		}
	}

	_skeleton() {
		return `<div class="mny-skel"><div class="mny-skel-card"></div><div class="mny-skel-card"></div><div class="mny-skel-card"></div></div>`;
	}

	_errorState(msg) {
		return `
			<div class="mny-empty">
				<div class="mny-empty-glyph" aria-hidden="true">⚠</div>
				<h3>Couldn’t load money</h3>
				<p>${esc(msg)}</p>
				<button class="studio-btn studio-btn-ghost" data-action="retry">Try again</button>
			</div>`;
	}

	// ── Wallet ──────────────────────────────────────────────────────────────────

	_walletSection() {
		const w = this.state.wallet || {};
		const addr = w.solana_address;
		if (!addr) {
			return `
				<section class="mny-section" aria-labelledby="mny-wallet-h">
					<div class="mny-section-head"><h3 id="mny-wallet-h">Wallet</h3>
						<p>Your agent needs a custodial wallet before it can earn or pay other agents.</p></div>
					<div class="mny-wallet-card mny-wallet-empty">
						<div class="mny-wallet-glyph" aria-hidden="true">◎</div>
						<p>No signing wallet yet.</p>
						<button class="studio-btn studio-btn-primary" data-action="provision" ${this.state.provisioning ? 'disabled' : ''}>
							${this.state.provisioning ? 'Creating…' : 'Create wallet'}
						</button>
					</div>
				</section>`;
		}
		return `
			<section class="mny-section" aria-labelledby="mny-wallet-h">
				<div class="mny-section-head">
					<h3 id="mny-wallet-h">Wallet</h3>
					<p>Real custodial Solana wallet. Fund it with USDC so it can pay other agents and cover gas.</p>
				</div>
				<div class="mny-wallet-card">
					<div class="mny-wallet-bal" data-balances>${this._balancesHtml()}</div>
					<div class="mny-wallet-addr">
						<span class="mny-addr-label">Deposit address</span>
						<code class="mny-addr" title="${esc(addr)}">${esc(short(addr))}</code>
						<button class="mny-icon-btn" data-action="copy" data-copy="${esc(addr)}" title="Copy address" aria-label="Copy deposit address">⧉</button>
						<a class="mny-icon-btn" href="https://solscan.io/account/${esc(addr)}" target="_blank" rel="noopener" title="View on Solscan" aria-label="View on explorer">↗</a>
					</div>
					<div class="mny-wallet-tools">
						<a class="studio-btn studio-btn-primary studio-action" href="/agents/${encodeURIComponent(this.agentId)}/wallet#deposit">Add funds</a>
						<button class="studio-btn studio-btn-ghost studio-action" data-action="refresh">Refresh balance</button>
						<button class="studio-btn studio-btn-ghost studio-action" data-action="toggle-withdraw">Withdraw</button>
					</div>
					<div class="mny-withdraw" data-withdraw hidden>${this._withdrawForm()}</div>
					<div class="mny-holdings" data-holdings>${this._holdingsHtml()}</div>
					<div class="mny-activity" data-activity>${this._activityHtml()}</div>
				</div>
			</section>`;
	}

	_holdingsHtml() {
		const h = this.state.holdings;
		if (h == null) return `<div class="mny-sub-head">Holdings</div><div class="mny-skel-line"></div>`;
		const tokens = (h.tokens || []).filter((t) => !t.is_usdc);
		if (!tokens.length) return `<div class="mny-sub-head">Holdings</div><p class="mny-faint">No token holdings yet — buys made by the Trading Brain appear here.</p>`;
		return `<div class="mny-sub-head">Holdings <span class="mny-count">${tokens.length}</span></div>
			<ul class="mny-hold-list">${tokens.slice(0, 8).map((t) => `
				<li class="mny-hold-row">
					<a class="mny-hold-mint" href="https://solscan.io/token/${esc(t.mint)}" target="_blank" rel="noopener" title="${esc(t.mint)}">${esc(short(t.mint))} ↗</a>
					<span class="mny-hold-amt">${Number(t.ui_amount).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
				</li>`).join('')}</ul>`;
	}

	_activityHtml() {
		const a = this.state.activity;
		if (a == null) return '';
		if (!a.length) return '';
		return `<div class="mny-sub-head">Recent activity</div>
			<ul class="mny-act-list">${a.slice(0, 6).map((s) => `
				<li class="mny-act-row ${s.success ? '' : 'is-fail'}">
					<span class="mny-act-sum">${esc(s.summary || (s.success ? 'transaction' : 'failed tx'))}</span>
					<span class="mny-act-delta ${s.sol_delta == null ? '' : s.sol_delta >= 0 ? 'pos' : 'neg'}">${s.sol_delta == null ? '' : `${s.sol_delta >= 0 ? '+' : ''}${Number(s.sol_delta).toFixed(4)} SOL`}</span>
					<a class="mny-act-tx" href="https://solscan.io/tx/${esc(s.signature)}" target="_blank" rel="noopener" title="View transaction">↗</a>
				</li>`).join('')}</ul>`;
	}

	_withdrawForm() {
		const a = this.state.wdAsset === 'USDC' ? 'USDC' : 'SOL';
		const w = this.state.wallet || {};
		const avail = a === 'USDC'
			? (w.usdc_balance == null ? null : Number(w.usdc_balance))
			: (w.solana_balance == null ? null : Number(w.solana_balance));
		const availStr = avail == null ? '' : (a === 'USDC' ? `$${avail.toFixed(2)} available` : `${avail.toFixed(4)} SOL available`);
		return `
			<div class="mny-withdraw-head">
				<span>Withdraw</span>
				<span class="mny-asset-toggle" role="tablist" aria-label="Asset to withdraw">
					<button class="mny-asset-btn ${a === 'SOL' ? 'is-on' : ''}" role="tab" aria-selected="${a === 'SOL'}" data-action="wd-asset" data-asset="SOL">SOL</button>
					<button class="mny-asset-btn ${a === 'USDC' ? 'is-on' : ''}" role="tab" aria-selected="${a === 'USDC'}" data-action="wd-asset" data-asset="USDC">USDC</button>
				</span>
				${availStr ? `<span class="mny-withdraw-avail">${esc(availStr)}</span>` : ''}
			</div>
			<div class="mny-withdraw-row">
				<input type="text" data-wd="destination" placeholder="Destination address" aria-label="Destination Solana address" />
				<input type="number" min="0" step="any" data-wd="amount" placeholder="Amount" aria-label="Amount in ${esc(a)}" />
				<button class="studio-btn studio-btn-ghost" data-action="wd-max" title="Withdraw everything${a === 'SOL' ? ' (keeps a little for fees)' : ''}">Max</button>
				<button class="studio-btn studio-btn-primary" data-action="do-withdraw" ${this.state.withdrawing ? 'disabled' : ''}>${this.state.withdrawing ? 'Sending…' : 'Withdraw'}</button>
			</div>
			<p class="mny-faint">Real on-chain transfer from the agent's custodial wallet${a === 'USDC' ? ' (a little SOL is used for the network fee)' : ''}. Double-check the address — Solana transfers are irreversible.</p>
			<div class="mny-withdraw-result" data-wd-result hidden></div>`;
	}

	_renderHoldings() {
		const host = this._q('[data-holdings]');
		if (host) host.innerHTML = this._holdingsHtml();
	}

	_renderActivity() {
		const host = this._q('[data-activity]');
		if (host) host.innerHTML = this._activityHtml();
	}

	_setWdAsset(asset) {
		const next = asset === 'USDC' ? 'USDC' : 'SOL';
		if (next === this.state.wdAsset) return;
		this.state.wdAsset = next;
		const wrap = this._q('[data-withdraw]');
		if (wrap && !wrap.hidden) wrap.innerHTML = this._withdrawForm();
	}

	async _withdraw(useMax = false) {
		if (this.state.withdrawing) return;
		const wrap = this._q('[data-withdraw]');
		const dest = wrap?.querySelector('[data-wd="destination"]')?.value.trim();
		const amtRaw = wrap?.querySelector('[data-wd="amount"]')?.value.trim();
		if (!dest) return this._toast('Enter a destination address', true);
		const amount = useMax ? 'max' : Number(amtRaw);
		if (!useMax && (!Number.isFinite(amount) || amount <= 0)) return this._toast('Enter a valid amount', true);
		// SOL → the native asset; USDC → its SPL mint (the withdraw endpoint resolves
		// the mint, sweeps the token on "max", and prices USDC 1:1 for the ceiling).
		const isUsdc = this.state.wdAsset === 'USDC';
		const asset = isUsdc ? USDC_MINT : 'SOL';
		const sym = isUsdc ? 'USDC' : 'SOL';
		this.state.withdrawing = true;
		const btn = wrap?.querySelector('[data-action="do-withdraw"]');
		if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
		try {
			const res = await apiFetch(`/api/agents/${this.agentId}/wallet/withdraw`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ destination: dest, amount, asset, network: 'mainnet' }),
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(payload?.error?.message || 'Withdrawal failed.');
			const d = payload.data || {};
			const result = wrap?.querySelector('[data-wd-result]');
			if (result) {
				result.hidden = false;
				result.innerHTML = `✓ Sent. <a href="https://solscan.io/tx/${esc(d.signature)}" target="_blank" rel="noopener">View transaction ↗</a>`;
			}
			this._toast(`${sym} withdrawal sent`);
			this._refreshWallet();
		} catch (err) {
			this._toast(err.message || 'Withdrawal failed', true);
		} finally {
			this.state.withdrawing = false;
			if (btn) { btn.disabled = false; btn.textContent = 'Withdraw'; }
		}
	}

	_balancesHtml() {
		const w = this.state.wallet || {};
		const sol = w.solana_balance == null ? '—' : Number(w.solana_balance).toFixed(4);
		const usdc = w.usdc_balance == null ? '—' : Number(w.usdc_balance).toFixed(2);
		return `
			<div class="mny-bal"><b data-bal="usdc">$${esc(usdc)}</b><span>USDC</span></div>
			<div class="mny-bal"><b data-bal="sol">${esc(sol)}</b><span>SOL</span></div>`;
	}

	_renderWalletBalances() {
		const host = this._q('[data-balances]');
		if (!host) return;
		// First paint (or numbers unknown) → set directly. On a live refresh, count
		// each figure from its previous value to the new one and flash the direction,
		// so money moving in/out reads as motion instead of a hard swap.
		const w = this.state.wallet || {};
		const next = { usdc: w.usdc_balance == null ? null : Number(w.usdc_balance), sol: w.solana_balance == null ? null : Number(w.solana_balance) };
		const prev = this._prevBal;
		if (!host.querySelector('[data-bal]') || !prev) { host.innerHTML = this._balancesHtml(); this._prevBal = next; return; }
		this._animateBal(host.querySelector('[data-bal="usdc"]'), prev.usdc, next.usdc, (n) => `$${n.toFixed(2)}`);
		this._animateBal(host.querySelector('[data-bal="sol"]'), prev.sol, next.sol, (n) => n.toFixed(4));
		this._prevBal = next;
	}

	// Count `el` from → to over ~600ms and flash green/red by direction. Honors
	// prefers-reduced-motion (instant, exact) and never animates from/to unknown.
	_animateBal(el, from, to, fmt) {
		if (!el) return;
		if (to == null) { el.textContent = fmt === undefined ? '—' : '—'; return; }
		if (from == null || from === to || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)) {
			el.textContent = fmt(to);
			return;
		}
		el.classList.remove('mny-bal-up', 'mny-bal-down');
		void el.offsetWidth; // restart the flash animation
		el.classList.add(to >= from ? 'mny-bal-up' : 'mny-bal-down');
		const start = performance.now();
		const dur = 600;
		const tick = (now) => {
			const t = Math.min(1, (now - start) / dur);
			const eased = 1 - Math.pow(1 - t, 3);
			el.textContent = fmt(from + (to - from) * eased);
			if (t < 1) requestAnimationFrame(tick);
			else el.textContent = fmt(to);
		};
		requestAnimationFrame(tick);
	}

	// ── Pricing ───────────────────────────────────────────────────────────────

	_pricingSection() {
		const skills = (this.studio.agent?.skills || []).filter(isSellable);
		return `
			<section class="mny-section" aria-labelledby="mny-price-h">
				<div class="mny-section-head">
					<h3 id="mny-price-h">Pricing</h3>
					<p>Charge other agents and users per call, in USDC. Leave a skill at $0 to keep it free.</p>
				</div>
				${
					skills.length
						? `${this._pricingSummary(skills)}<ul class="mny-price-list">${skills.map((id) => this._priceRow(id)).join('')}</ul>`
						: `<div class="mny-inline-empty">
							<p>No sellable skills enabled yet.</p>
							<button class="studio-btn studio-btn-ghost studio-action" data-action="go-skills">Add skills →</button>
						</div>`
				}
			</section>`;
	}

	// At-a-glance state of what this agent sells: how many skills carry a price, the
	// average, and how many are still free — so the owner sees their storefront.
	_pricingSummary(skills) {
		const priced = skills.filter((id) => this.state.prices[id]);
		const amounts = priced.map((id) => fmtUsdc(this.state.prices[id].amount));
		const avg = amounts.length ? amounts.reduce((a, b) => a + b, 0) / amounts.length : 0;
		return `
			<div class="mny-price-summary">
				<div class="mny-price-stat"><b>${priced.length}<span class="mny-price-stat-of">/${skills.length}</span></b><span>priced</span></div>
				<div class="mny-price-stat"><b>${amounts.length ? '$' + avg.toFixed(2) : '—'}</b><span>avg / call</span></div>
				<div class="mny-price-stat"><b>${skills.length - priced.length}</b><span>free</span></div>
			</div>`;
	}

	_priceRow(id) {
		const meta = skillMeta(id);
		const p = this.state.prices[id];
		const value = p ? fmtUsdc(p.amount) : '';
		const active = !!p;
		// Common price points so setting a fair per-call price is one tap, not a
		// guess. The chip highlights when it matches the current saved price.
		const quick = [0.01, 0.1, 1];
		const chips = quick.map((amt) =>
			`<button class="mny-price-chip ${active && Math.abs(fmtUsdc(p.amount) - amt) < 1e-9 ? 'is-on' : ''}" data-action="quick-price" data-skill="${esc(id)}" data-amt="${amt}" title="Set $${amt.toFixed(2)} per call">$${amt < 1 ? amt.toFixed(2) : amt.toFixed(0)}</button>`
		).join('');
		return `
			<li class="mny-price-row ${active ? 'is-priced' : ''}" data-skill="${esc(id)}">
				<div class="mny-price-meta">
					<span class="mny-price-icon" aria-hidden="true">${meta.icon || '⚙️'}</span>
					<div>
						<span class="mny-price-name">${esc(meta.name)}</span>
						<span class="mny-price-desc">${esc(meta.desc)}</span>
					</div>
				</div>
				<div class="mny-price-controls">
					<div class="mny-price-quick" role="group" aria-label="Quick price for ${esc(meta.name)}">${chips}<button class="mny-price-chip mny-price-chip-free ${active ? '' : 'is-on'}" data-action="quick-price" data-skill="${esc(id)}" data-amt="0" title="Make this skill free">Free</button></div>
					<div class="mny-price-input">
						<span class="mny-price-cur">$</span>
						<input type="number" inputmode="decimal" min="0" step="0.01" value="${value}"
							placeholder="0.00" aria-label="Price for ${esc(meta.name)} in USDC" data-price-input />
						<span class="mny-price-unit">/call</span>
						<button class="studio-btn studio-btn-ghost studio-action mny-price-save" data-action="save-price" data-skill="${esc(id)}">Save</button>
					</div>
				</div>
			</li>`;
	}

	// One-tap price: fill the row's input and persist immediately.
	_quickPrice(skill, amt) {
		const row = this.el.querySelector(`.mny-price-row[data-skill="${CSS.escape(skill)}"]`);
		const input = row?.querySelector('[data-price-input]');
		if (input) input.value = Number(amt) > 0 ? Number(amt).toFixed(2) : '0';
		this._savePrice(skill);
	}

	// After a save, refresh only the summary counts and the saved row's quick-price
	// chip highlights — never sibling rows' inputs, so an unsaved edit elsewhere
	// survives.
	_refreshPricingChrome(skill, usd) {
		const skills = (this.studio.agent?.skills || []).filter(isSellable);
		const summary = this.el.querySelector('.mny-price-summary');
		if (summary) {
			const tmp = document.createElement('div');
			tmp.innerHTML = this._pricingSummary(skills).trim();
			const next = tmp.firstElementChild;
			if (next) summary.replaceWith(next);
		}
		const row = this.el.querySelector(`.mny-price-row[data-skill="${CSS.escape(skill)}"]`);
		row?.querySelectorAll('.mny-price-chip').forEach((chip) => {
			const amt = Number(chip.dataset.amt);
			const on = amt === 0 ? !(usd > 0) : usd > 0 && Math.abs(usd - amt) < 1e-9;
			chip.classList.toggle('is-on', on);
		});
	}

	// ── Earnings ──────────────────────────────────────────────────────────────

	_earningsSection() {
		return `
			<section class="mny-section" aria-labelledby="mny-earn-h">
				<div class="mny-section-head"><h3 id="mny-earn-h">Earnings</h3>
					<p>Every payment other agents and users have made to this one.</p></div>
				<div data-earnings>${this._earningsBody()}</div>
			</section>`;
	}

	_earningsBody() {
		const items = this.state.payments || [];
		if (!items.length) {
			return `<div class="mny-inline-empty">
				<div class="mny-empty-glyph small" aria-hidden="true">◎</div>
				<p>No earnings yet. Price a skill and share your agent — payments land here in real time.</p>
			</div>`;
		}
		return `${this._earningsSummary(items)}<ul class="mny-earn-list">${items.map((p) => this._earnRow(p)).join('')}</ul>`;
	}

	// Roll up the real payments ledger into headline figures — total received, count,
	// and the trailing-7-day take — so the agent's economic output reads at a glance.
	_earningsSummary(items) {
		const weekAgo = Date.now() - 7 * 86400000;
		let total = 0;
		let week = 0;
		for (const p of items) {
			const amt = fmtUsdc(p.amount_wei);
			total += amt;
			if (p.created_at && new Date(p.created_at).getTime() >= weekAgo) week += amt;
		}
		return `
			<div class="mny-earn-summary">
				<div class="mny-earn-stat"><b>$${total.toFixed(2)}</b><span>total received</span></div>
				<div class="mny-earn-stat"><b>${items.length}</b><span>payment${items.length === 1 ? '' : 's'}</span></div>
				<div class="mny-earn-stat"><b class="${week > 0 ? 'pos' : ''}">$${week.toFixed(2)}</b><span>last 7 days</span></div>
			</div>`;
	}

	_renderEarnings() {
		const host = this._q('[data-earnings]');
		if (host) host.innerHTML = this._earningsBody();
	}

	async _refreshEarnings() {
		try {
			const payments = await this._fetchPayments();
			// Only re-render when the ledger actually changed (newest tx hash + count) —
			// avoids churning the DOM every poll tick.
			const sig = `${payments.length}:${payments[0]?.tx_hash || payments[0]?.created_at || ''}`;
			if (sig === this._earnSig) return;
			this._earnSig = sig;
			this.state.payments = payments;
			this._renderEarnings();
		} catch { /* transient — keep last */ }
	}

	_earnRow(p) {
		const usdc = fmtUsdc(p.amount_wei);
		const who = p.payer_name || (p.payer_agent_id ? `agent ${short(p.payer_agent_id)}` : 'someone');
		const what = p.skill_name ? `for ${esc(p.skill_name)}` : (p.memo ? esc(p.memo) : '');
		const explorer = p.tx_hash
			? `<a class="mny-earn-tx" href="https://solscan.io/tx/${esc(p.tx_hash)}" target="_blank" rel="noopener" title="View transaction">↗</a>`
			: '';
		return `
			<li class="mny-earn-row" data-status="${esc(p.status || 'confirmed')}">
				<span class="mny-earn-amt">+$${esc(usdc.toFixed(2))}</span>
				<span class="mny-earn-detail"><b>${esc(who)}</b> ${what}</span>
				<span class="mny-earn-time">${esc(relTime(p.created_at))}</span>
				${explorer}
			</li>`;
	}

	// ── Bind / actions ────────────────────────────────────────────────────────

	_bindError() {
		this._q('[data-action="retry"]')?.addEventListener('click', () => this._load());
	}

	_bind() {
		this.el.addEventListener('click', (e) => {
			const btn = e.target.closest('[data-action]');
			if (!btn) return;
			const a = btn.dataset.action;
			if (a === 'retry') return this._load();
			if (a === 'provision') return this._provision();
			if (a === 'refresh') return this._refreshWallet();
			if (a === 'copy') return this._copy(btn.dataset.copy);
			if (a === 'save-price') return this._savePrice(btn.dataset.skill);
			if (a === 'quick-price') return this._quickPrice(btn.dataset.skill, btn.dataset.amt);
			if (a === 'toggle-withdraw') { const w = this._q('[data-withdraw]'); if (w) w.hidden = !w.hidden; return; }
			if (a === 'do-withdraw') return this._withdraw(false);
			if (a === 'wd-max') return this._withdraw(true);
			if (a === 'wd-asset') return this._setWdAsset(btn.dataset.asset);
			if (a === 'go-skills') return document.dispatchEvent(new CustomEvent('studio:navigate', { detail: { tab: 'skills' } }));
		});
		this.el.querySelectorAll('[data-price-input]').forEach((inp) =>
			inp.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					this._savePrice(e.target.closest('[data-skill]')?.dataset.skill);
				}
			}));
	}

	async _provision() {
		if (this.state.provisioning) return;
		this.state.provisioning = true;
		this._renderBody();
		try {
			const res = await apiFetch(`/api/agents/${this.agentId}/wallet/provision`, { method: 'POST' });
			if (!res.ok) throw new Error('Provisioning failed.');
			this._toast('Wallet created');
			await this._load();
		} catch (err) {
			this.state.provisioning = false;
			this._renderBody();
			this._toast(err.message || 'Could not create wallet', true);
		}
	}

	async _copy(text) {
		try {
			await navigator.clipboard.writeText(text);
			this._toast('Address copied');
		} catch {
			this._toast('Copy failed — select it manually', true);
		}
	}

	async _savePrice(skill) {
		if (!skill) return;
		const row = this.el.querySelector(`.mny-price-row[data-skill="${CSS.escape(skill)}"]`);
		const input = row?.querySelector('[data-price-input]');
		const btn = row?.querySelector('.mny-price-save');
		if (!input) return;
		const usd = parseFloat(input.value);
		if (Number.isNaN(usd) || usd < 0) return this._toast('Enter a valid amount', true);
		if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
		try {
			if (usd === 0) {
				// $0 = free → remove the price.
				await apiFetch(`/api/agents/${this.agentId}/pricing/${encodeURIComponent(skill)}`, { method: 'DELETE' });
				delete this.state.prices[skill];
			} else {
				const res = await apiFetch(`/api/agents/${this.agentId}/pricing/${encodeURIComponent(skill)}`, {
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ currency_mint: USDC_MINT, chain: 'solana', amount: toAtomic(usd), is_active: true }),
				});
				if (!res.ok) throw new Error('Could not save price.');
				const saved = await res.json();
				this.state.prices[skill] = saved;
			}
			// Record that this skill is sellable in the studio meta bag so the
			// Skills tab + profile reflect it without a refetch.
			this.studio.patch({ meta: { studio: { money: { priced: Object.keys(this.state.prices) } } } });
			this.studio.emit('money:change', { skill, amount: usd });
			row?.classList.toggle('is-priced', usd > 0);
			this._refreshPricingChrome(skill, usd);
			this._toast(usd === 0 ? 'Skill is now free' : `Priced at $${usd.toFixed(2)}/call`);
		} catch (err) {
			this._toast(err.message || 'Save failed', true);
		} finally {
			if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
		}
	}

	_toast(msg, isError = false) {
		const t = this._q('[data-toast]');
		if (!t) return;
		t.textContent = msg;
		t.hidden = false;
		t.className = `mny-toast ${isError ? 'mny-toast-err' : ''} show`;
		clearTimeout(this._toastTimer);
		this._toastTimer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => { t.hidden = true; }, 300); }, 2600);
	}

	destroy() {
		clearInterval(this._poll);
		clearTimeout(this._toastTimer);
		try { this._tradingBrain?.destroy(); } catch { /* noop */ }
	}
}
