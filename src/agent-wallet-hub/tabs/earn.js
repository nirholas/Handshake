/**
 * Agent Wallet hub — Earn tab (fully built). Owner-only.
 *
 * "Your avatar has a job." This is the economy home: what the agent has earned
 * (skill sales + hires from other agents + tips), who its top customers are, the
 * prices that make it money, the bounded allowance +
 * kill switch that lets it pay other agents safely, and a clean receipts
 * statement of every dollar in and out. Every number is real — it traces to
 * agent_custody_events / skill_payment_earnings via GET /api/agents/:id/economy.
 * Pricing writes through the same MonetizationService the rest of the platform
 * uses; the kill switch writes the real spend policy. No mocks, no fake numbers.
 *
 * Sections:
 *   1. Earnings hero  — lifetime / 7d / today, count-up, "earned while away".
 *   2. Earning engine — price the agent's skills in USDC (the buy side settles
 *      for real over Solana Pay → real funds into the agent wallet).
 *   3. Autonomous spend — allowance snapshot + prominent kill switch; the agent
 *      pays services over the real x402 bridge bounded by enforceSpendLimit.
 *   4. Receipts — unified in/out statement with real signatures.
 *   5. Discover — the live services directory + hire a service.
 */

import { registerWalletTab } from '../registry.js';
import {
	fetchEconomy,
	fetchPricing,
	savePricing,
	setFrozen,
} from '../../agent-economy-hub.js';
import { timeAgo, shortAddress, explorerTxUrl, explorerAddressUrl } from '../util.js';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SEEN_KEY = (id) => `tws-earn-seen:${id}`;

const STYLE_ID = 'awh-earn-style';
const STYLE = `
.awh-earn-hero { text-align: center; padding: var(--space-5,20px) var(--space-4,16px) var(--space-4,16px); }
.awh-earn-eyebrow { font-size: var(--text-2xs,.6875rem); text-transform: uppercase; letter-spacing: .08em; color: var(--wallet-accent,#c4b5fd); margin: 0 0 6px; }
.awh-earn-big { font-family: var(--font-display, system-ui); font-size: clamp(2.2rem, 9vw, 3.2rem); font-weight: 700; line-height: 1; color: var(--ink-bright,#fff); letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.awh-earn-tag { font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); margin-top: 8px; }
.awh-earn-chips { display: flex; gap: var(--space-2,8px); justify-content: center; flex-wrap: wrap; margin-top: var(--space-4,16px); }
.awh-earn-chip { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 8px 14px; border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-md,10px); background: var(--surface-1, rgba(255,255,255,.03)); min-width: 84px; }
.awh-earn-chip b { font-family: var(--font-mono, ui-monospace, monospace); font-size: var(--text-md,.8125rem); color: var(--ink-bright,#fff); font-variant-numeric: tabular-nums; }
.awh-earn-chip span { font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); text-transform: uppercase; letter-spacing: .04em; }
.awh-earn-split { font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); margin-top: var(--space-3,12px); }
.awh-earn-split b { color: var(--ink,#e8e8e8); font-family: var(--font-mono, ui-monospace, monospace); }

.awh-earn-away { display: flex; align-items: center; gap: 10px; margin: 0 0 var(--awh-gap,16px); padding: 11px 14px; border-radius: var(--radius-lg,14px); border: 1px solid color-mix(in srgb, var(--success,#4ade80) 38%, transparent); background: color-mix(in srgb, var(--success,#4ade80) 10%, transparent); color: var(--ink-bright,#fff); font-size: var(--text-md,.8125rem); animation: awh-earn-pop var(--duration-base,220ms) var(--ease-standard, ease); }
.awh-earn-away .x { margin-left: auto; appearance: none; background: none; border: 0; color: var(--ink-dim,#888); cursor: pointer; font-size: 16px; line-height: 1; padding: 2px 4px; }
.awh-earn-away .x:hover { color: var(--ink,#e8e8e8); }
.awh-earn-away b { color: var(--success,#4ade80); font-family: var(--font-mono, ui-monospace, monospace); }
.awh-earn-spark { font-size: 18px; flex: none; }

.awh-earn-empty { text-align: center; color: var(--ink-dim,#888); font-size: var(--text-sm,.764rem); line-height: 1.5; padding: var(--space-3,12px) 0; }
.awh-earn-empty strong { color: var(--ink,#e8e8e8); display: block; font-size: var(--text-md,.8125rem); margin-bottom: 4px; }

.awh-sk-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2,8px); }
.awh-sk { display: flex; align-items: center; gap: var(--space-3,12px); padding: 10px 12px; border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-md,10px); background: var(--surface-1, rgba(255,255,255,.03)); }
.awh-sk-toggle { flex: none; }
.awh-sk-name { flex: 1 1 auto; min-width: 0; font-size: var(--text-md,.8125rem); color: var(--ink,#e8e8e8); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.awh-sk-adv { font-size: var(--text-2xs,.6875rem); color: var(--wallet-accent,#c4b5fd); border: 1px solid color-mix(in srgb, var(--wallet-accent,#c4b5fd) 35%, transparent); border-radius: var(--radius-pill,999px); padding: 1px 7px; margin-left: 6px; white-space: nowrap; }
.awh-sk-price { flex: none; display: inline-flex; align-items: center; gap: 5px; }
.awh-sk-price .pre { color: var(--ink-dim,#888); font-family: var(--font-mono, ui-monospace, monospace); font-size: var(--text-sm,.764rem); }
.awh-sk-input { width: 84px; font: inherit; font-family: var(--font-mono, ui-monospace, monospace); font-size: var(--text-sm,.764rem); text-align: right; color: var(--ink,#e8e8e8); background: var(--surface-2, rgba(255,255,255,.05)); border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-sm,6px); padding: 6px 8px; }
.awh-sk-input:disabled { opacity: .5; }
.awh-sk-input:focus-visible { outline: var(--focus-ring-width,2px) solid var(--focus-ring-color,#fff); outline-offset: 1px; }
.awh-sk-unit { color: var(--ink-dim,#888); font-size: var(--text-2xs,.6875rem); }
.awh-earn-save-row { display: flex; align-items: center; gap: var(--space-3,12px); margin-top: var(--space-4,16px); flex-wrap: wrap; }
.awh-earn-save-row .msg { font-size: var(--text-sm,.764rem); }
.awh-earn-save-row .msg.ok { color: var(--success,#4ade80); }
.awh-earn-save-row .msg.err { color: var(--danger,#f87171); }
.awh-earn-link { color: var(--wallet-accent,#c4b5fd); text-decoration: none; font-size: var(--text-sm,.764rem); border-bottom: 1px dotted currentColor; }
.awh-earn-link:hover { color: var(--ink-bright,#fff); }

.awh-earn-policy { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-2,8px); margin-bottom: var(--space-3,12px); }
.awh-earn-pcell { text-align: center; padding: 9px 6px; border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-md,10px); background: var(--surface-1, rgba(255,255,255,.03)); }
.awh-earn-pcell b { display: block; font-family: var(--font-mono, ui-monospace, monospace); font-size: var(--text-md,.8125rem); color: var(--ink-bright,#fff); }
.awh-earn-pcell span { font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); text-transform: uppercase; letter-spacing: .04em; }
.awh-earn-pbar { height: 5px; border-radius: 3px; background: var(--surface-3, rgba(255,255,255,.08)); overflow: hidden; margin: 4px 0 0; }
.awh-earn-pbar i { display: block; height: 100%; background: var(--wallet-accent,#c4b5fd); border-radius: 3px; transition: width var(--duration-base,220ms) var(--ease-standard,ease); }
.awh-earn-pbar i.warn { background: var(--warn,#fbbf24); }
.awh-earn-pbar i.danger { background: var(--danger,#f87171); }

.awh-rcpt-list { list-style: none; margin: 0; padding: 0; }
.awh-rcpt { display: flex; align-items: center; gap: var(--space-3,12px); padding: 10px 0; border-bottom: 1px solid var(--stroke, rgba(255,255,255,.06)); }
.awh-rcpt:last-child { border-bottom: none; }
.awh-rcpt-ic { flex: none; width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; font-size: 13px; }
.awh-rcpt-ic.in { background: color-mix(in srgb, var(--success,#4ade80) 16%, transparent); color: var(--success,#4ade80); }
.awh-rcpt-ic.out { background: color-mix(in srgb, var(--wallet-accent,#c4b5fd) 16%, transparent); color: var(--wallet-accent,#c4b5fd); }
.awh-rcpt-main { flex: 1 1 auto; min-width: 0; }
.awh-rcpt-label { font-size: var(--text-sm,.764rem); color: var(--ink,#e8e8e8); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.awh-rcpt-meta { font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); margin-top: 2px; }
.awh-rcpt-meta a { color: inherit; text-decoration: none; border-bottom: 1px dotted currentColor; }
.awh-rcpt-meta a:hover { color: var(--ink,#e8e8e8); }
.awh-rcpt-amt { flex: none; font-family: var(--font-mono, ui-monospace, monospace); font-size: var(--text-md,.8125rem); font-variant-numeric: tabular-nums; }
.awh-rcpt-amt.in { color: var(--success,#4ade80); }
.awh-rcpt-amt.out { color: var(--ink-dim,#888); }
.awh-rcpt-amt.pending { color: var(--warn,#fbbf24); }

.awh-cust { margin: 0 0 var(--space-3,12px); }
.awh-cust-h { font-size: var(--text-2xs,.6875rem); text-transform: uppercase; letter-spacing: .04em; color: var(--ink-dim,#888); margin: 0 0 6px; }
.awh-cust-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.awh-cust-row { display: flex; align-items: baseline; gap: var(--space-2,8px); padding: 5px 0; border-bottom: 1px solid var(--stroke, rgba(255,255,255,.05)); }
.awh-cust-row:last-child { border-bottom: none; }
.awh-cust-name { flex: 1 1 auto; min-width: 0; color: var(--ink,#e8e8e8); text-decoration: none; font-size: var(--text-sm,.764rem); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-bottom: 1px dotted transparent; }
.awh-cust-name:hover { color: var(--ink-bright,#fff); border-bottom-color: currentColor; }
.awh-cust-meta { flex: none; color: var(--ink-dim,#888); font-size: var(--text-2xs,.6875rem); }
.awh-cust-usd { flex: none; font-family: var(--font-mono, ui-monospace, monospace); font-size: var(--text-sm,.764rem); color: var(--success,#4ade80); font-variant-numeric: tabular-nums; }
.awh-earn-disc { display: flex; gap: var(--space-2,8px); flex-wrap: wrap; }
.awh-earn-skel span { display: block; height: 16px; border-radius: var(--radius-sm,6px); background: var(--surface-2, rgba(255,255,255,.05)); animation: awh-skel 1.4s ease-in-out infinite; margin-bottom: 10px; }
.awh-earn-skel span:nth-child(2){ width: 60%; } .awh-earn-skel span:nth-child(3){ width: 80%; }
@keyframes awh-earn-pop { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
@keyframes awh-skel { 0%,100% { opacity: .5; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce){ .awh-earn-away, .awh-earn-skel span, .awh-earn-pbar i { animation: none; transition: none; } }
@media (max-width: 520px){ .awh-earn-policy { grid-template-columns: repeat(3, 1fr); } .awh-sk-input { width: 72px; } }
`;

function injectStyle() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const tag = document.createElement('style');
	tag.id = STYLE_ID;
	tag.textContent = STYLE;
	document.head.appendChild(tag);
}

// Money formatter that never lies: real $0.00, fine-grained under a dollar.
function money(n) {
	if (n == null || !Number.isFinite(Number(n))) return '$0.00';
	const v = Number(n);
	if (v > 0 && v < 0.01) return '$' + v.toFixed(4);
	return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: v < 1 ? 4 : 2 }).format(v);
}

function unixSec(iso) {
	const t = Date.parse(iso);
	return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

// Lifetime earnings breakdown across the three real income streams. Only streams
// that actually earned are named, so the sentence reads true for every agent:
// just sales, just hires, or all three. money() output is numeric — safe HTML.
function earnSplit(e) {
	const parts = [];
	if ((e.skill_sales?.lifetime || 0) > 0) parts.push(`<b>${money(e.skill_sales.lifetime)}</b> in skill sales`);
	if ((e.hires?.lifetime || 0) > 0) parts.push(`<b>${money(e.hires.lifetime)}</b> from agents hiring it`);
	if ((e.tips?.lifetime || 0) > 0) parts.push(`<b>${money(e.tips.lifetime)}</b> in tips`);
	if (!parts.length) return `Every dollar in and out shows up below as a real, signed receipt.`;
	if (parts.length === 1) return `From ${parts[0]}.`;
	const last = parts.pop();
	return `From ${parts.join(', ')} and ${last}.`;
}

registerWalletTab({
	id: 'earn',
	label: 'Earn',
	order: 45,
	ownerOnly: true,
	mount({ panel, ctx }) {
		injectStyle();
		const { escapeHtml, toast } = ctx;

		let destroyed = false;
		let countRaf = 0;

		const state = {
			loading: true,
			error: null,
			econ: null, // economy summary
			// pricing
			pricingLoaded: false,
			pricingRows: [], // full rows from GET (preserve advanced fields)
			editor: [], // [{ skill, active, usd, advanced, advancedKind }]
			saving: false,
			saveMsg: null,
			saveOk: false,
			// kill switch
			freezing: false,
			// "earned while away"
			awayUsd: 0,
			awayCount: 0,
			awayDismissed: false,
		};

		function shell() {
			panel.innerHTML = `
				<div class="awh-card" data-host="hero"></div>
				<div class="awh-card" data-host="engine"></div>
				<div class="awh-card" data-host="spend"></div>
				<div class="awh-card" data-host="receipts"></div>
				<div class="awh-card" data-host="discover"></div>
			`;
			renderAll();
		}
		const host = (k) => panel.querySelector(`[data-host="${k}"]`);

		function renderAll() {
			renderHero();
			renderEngine();
			renderSpend();
			renderReceipts();
			renderDiscover();
		}

		// ── 1. Hero ─────────────────────────────────────────────────────────────
		function renderHero() {
			const h = host('hero');
			if (!h) return;
			if (state.loading) {
				h.innerHTML = `<div class="awh-earn-skel" aria-busy="true"><span></span><span></span><span></span></div>`;
				return;
			}
			if (state.error) {
				h.innerHTML = `<div class="awh-empty">Couldn’t load earnings. <button class="awh-btn awh-bal-mini" type="button" data-act="reload">Retry</button><div class="awh-rcpt-meta" style="margin-top:6px">${escapeHtml(state.error)}</div></div>`;
				return;
			}
			const e = state.econ.earnings;
			const lifetime = e.total.lifetime;
			const hasEarned = e.total.count > 0;
			const away = state.awayUsd > 0 && !state.awayDismissed
				? `<div class="awh-earn-away" role="status"><span class="awh-earn-spark">✨</span><div>Your avatar earned <b>${escapeHtml(money(state.awayUsd))}</b> while you were away${state.awayCount > 1 ? ` · ${state.awayCount} payments` : ''}.</div><button class="x" type="button" data-act="dismiss-away" aria-label="Dismiss">×</button></div>`
				: '';

			if (!hasEarned) {
				h.innerHTML = `${away}
					<div class="awh-earn-hero">
						<p class="awh-earn-eyebrow">The agent economy</p>
						<div class="awh-earn-big">${escapeHtml(money(0))}</div>
						<p class="awh-earn-tag">Your avatar doesn’t have a job yet.</p>
					</div>
					<div class="awh-earn-empty"><strong>Give it one.</strong>Price a skill below and it starts earning the moment someone buys — real USDC, straight into this wallet.</div>`;
				return;
			}
			h.innerHTML = `${away}
				<div class="awh-earn-hero">
					<p class="awh-earn-eyebrow">${escapeHtml(ctx.agent?.name || 'Your avatar')} has earned</p>
					<div class="awh-earn-big" data-count="${lifetime}">${escapeHtml(money(lifetime))}</div>
					<p class="awh-earn-tag">lifetime · across ${e.total.count} payment${e.total.count === 1 ? '' : 's'}</p>
					<div class="awh-earn-chips">
						<div class="awh-earn-chip"><b>${escapeHtml(money(e.total.today))}</b><span>Today</span></div>
						<div class="awh-earn-chip"><b>${escapeHtml(money(e.total.week))}</b><span>7 days</span></div>
						<div class="awh-earn-chip"><b>${escapeHtml(money(e.total.lifetime))}</b><span>All time</span></div>
					</div>
					<p class="awh-earn-split">${earnSplit(e)}</p>
				</div>`;
			animateCount();
		}

		function animateCount() {
			if (typeof window === 'undefined') return;
			if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
			const el = host('hero')?.querySelector('[data-count]');
			if (!el) return;
			const target = Number(el.getAttribute('data-count')) || 0;
			if (target <= 0) return;
			const dur = 800;
			let start = null;
			cancelAnimationFrame(countRaf);
			const step = (ts) => {
				if (destroyed || !el.isConnected) return;
				if (start == null) start = ts;
				const p = Math.min(1, (ts - start) / dur);
				const eased = 1 - Math.pow(1 - p, 3);
				el.textContent = money(target * eased);
				if (p < 1) countRaf = requestAnimationFrame(step);
				else el.textContent = money(target);
			};
			el.textContent = money(0);
			countRaf = requestAnimationFrame(step);
		}

		// ── 2. Earning engine (skill pricing) ───────────────────────────────────
		function renderEngine() {
			const h = host('engine');
			if (!h) return;
			const skills = state.econ?.all_skills || [];
			if (state.loading) {
				h.innerHTML = `<h2 class="awh-card-h">Earning engine</h2><div class="awh-earn-skel" aria-busy="true"><span></span><span></span></div>`;
				return;
			}
			if (state.error) {
				h.innerHTML = `<h2 class="awh-card-h">Earning engine</h2><div class="awh-empty" role="alert">Couldn’t load your skills. <button class="awh-btn awh-bal-mini" type="button" data-act="reload">Retry</button></div>`;
				return;
			}
			if (!skills.length) {
				h.innerHTML = `<h2 class="awh-card-h">Earning engine</h2>
					<div class="awh-earn-empty"><strong>No skills to price yet.</strong>Add skills to this agent, then set a price so other people — and other agents — can pay to use them.</div>
					<div class="awh-earn-save-row"><a class="awh-earn-link" href="/agents/${escapeHtml(ctx.agentId)}/edit#skills">Add skills →</a></div>`;
				return;
			}
			if (!state.pricingLoaded) {
				h.innerHTML = `<h2 class="awh-card-h">Earning engine</h2><div class="awh-earn-skel" aria-busy="true"><span></span><span></span></div>`;
				return;
			}
			const rows = state.editor.map((row, i) => {
				const advBadge = row.advanced ? `<span class="awh-sk-adv" title="Advanced pricing — edit in the full pricing editor">${escapeHtml(row.advancedKind)}</span>` : '';
				return `<li class="awh-sk">
					<input class="awh-sk-toggle" type="checkbox" data-edit="active" data-i="${i}" ${row.active ? 'checked' : ''} aria-label="Charge for ${escapeHtml(row.skill)}" />
					<span class="awh-sk-name" title="${escapeHtml(row.skill)}">${escapeHtml(row.skill)}${advBadge}</span>
					<span class="awh-sk-price">
						<span class="pre">$</span>
						<input class="awh-sk-input" type="number" min="0" step="0.01" inputmode="decimal" data-edit="usd" data-i="${i}"
							value="${row.usd != null ? escapeHtml(String(row.usd)) : ''}" placeholder="0.50"
							${row.active && !row.advanced ? '' : 'disabled'} aria-label="Price for ${escapeHtml(row.skill)} in USDC" />
						<span class="awh-sk-unit">USDC</span>
					</span>
				</li>`;
			}).join('');
			h.innerHTML = `<h2 class="awh-card-h">Earning engine · price your skills</h2>
				<ul class="awh-sk-list">${rows}</ul>
				<div class="awh-earn-save-row">
					<button class="awh-btn awh-btn--primary" type="button" data-act="save-prices" ${state.saving ? 'disabled' : ''}>${state.saving ? 'Saving…' : 'Save prices'}</button>
					<a class="awh-earn-link" href="/agents/${escapeHtml(ctx.agentId)}/edit#monetize">Trials, time-passes & pay-what-you-want →</a>
					${state.saveMsg ? `<span class="msg ${state.saveOk ? 'ok' : 'err'}">${escapeHtml(state.saveMsg)}</span>` : ''}
				</div>`;
		}

		function buildEditorFromPricing() {
			const bySkill = new Map();
			for (const r of state.pricingRows) bySkill.set(r.skill, r);
			const skills = state.econ?.all_skills || [];
			state.editor = skills.map((skill) => {
				const r = bySkill.get(skill);
				const advancedKind = r
					? (r.pricing_type === 'pwyw' ? 'Pay what you want'
						: (Number(r.time_pass_hours) > 0 ? 'Time pass'
							: (Number(r.trial_uses) > 0 ? 'Free trial' : null)))
					: null;
				return {
					skill,
					active: !!r,
					usd: r ? round2(Number(r.amount) / 1e6) : '',
					advanced: !!advancedKind,
					advancedKind,
				};
			});
		}

		function round2(n) {
			return Math.round(n * 100) / 100;
		}

		async function loadPricing() {
			const res = await fetchPricing(ctx.agentId);
			if (destroyed) return;
			if (res.ok) {
				state.pricingRows = Array.isArray(res.data?.prices) ? res.data.prices : [];
				buildEditorFromPricing();
				state.pricingLoaded = true;
			} else {
				// Pricing read failed — still let them price from scratch.
				state.pricingRows = [];
				buildEditorFromPricing();
				state.pricingLoaded = true;
			}
			renderEngine();
		}

		async function savePrices() {
			state.saveMsg = null;
			const bySkill = new Map();
			for (const r of state.pricingRows) bySkill.set(r.skill, r);
			const prices = [];
			for (const row of state.editor) {
				if (!row.active) continue;
				const existing = bySkill.get(row.skill);
				if (existing && row.advanced) {
					// Preserve advanced config verbatim (pwyw/trial/time-pass) — the
					// inline editor never touches these; the full editor owns them.
					prices.push(stripRow(existing));
					continue;
				}
				const usd = Number(row.usd);
				if (!Number.isFinite(usd) || usd <= 0) {
					state.saveOk = false;
					state.saveMsg = `Set a price above $0 for “${row.skill}”.`;
					renderEngine();
					return;
				}
				const amount = Math.round(usd * 1e6);
				if (existing) {
					prices.push({ ...stripRow(existing), amount });
				} else {
					prices.push({ skill: row.skill, amount, currency_mint: USDC_MINT, chain: 'solana', trial_uses: 0, pricing_type: 'fixed' });
				}
			}
			state.saving = true;
			renderEngine();
			const res = await savePricing(ctx.agentId, prices);
			if (destroyed) return;
			state.saving = false;
			if (res.ok) {
				state.saveOk = true;
				state.saveMsg = prices.length ? `Saved · ${prices.length} skill${prices.length === 1 ? '' : 's'} earning` : 'Saved · pricing cleared';
				toast('Prices saved');
				// Reflect listed-skill changes in the hero/engine + refetch summary.
				await reload({ keepEditor: true });
			} else {
				state.saveOk = false;
				state.saveMsg = res.message || 'Could not save prices';
				renderEngine();
			}
		}

		// Only the fields the pricing schema accepts — drop read-only/derived ones.
		function stripRow(r) {
			const out = {
				skill: r.skill,
				amount: Number(r.amount),
				currency_mint: r.currency_mint || USDC_MINT,
				chain: r.chain || 'solana',
				trial_uses: Number(r.trial_uses) || 0,
				pricing_type: r.pricing_type === 'pwyw' ? 'pwyw' : 'fixed',
			};
			if (r.time_pass_hours != null) out.time_pass_hours = Number(r.time_pass_hours);
			if (r.time_pass_amount != null) out.time_pass_amount = Number(r.time_pass_amount);
			if (out.pricing_type === 'pwyw' && r.minimum_amount != null) out.minimum_amount = Number(r.minimum_amount);
			return out;
		}

		// ── 3. Autonomous spend (allowance + kill switch) ───────────────────────
		function renderSpend() {
			const h = host('spend');
			if (!h) return;
			if (state.loading) {
				h.innerHTML = `<h2 class="awh-card-h">Autonomous spending</h2><div class="awh-earn-skel" aria-busy="true"><span></span><span></span></div>`;
				return;
			}
			if (state.error) {
				h.innerHTML = `<h2 class="awh-card-h">Autonomous spending</h2><div class="awh-empty" role="alert">Couldn’t load spending limits. <button class="awh-btn awh-bal-mini" type="button" data-act="reload">Retry</button></div>`;
				return;
			}
			const p = state.econ.policy;
			const spend = state.econ.spending.x402;
			const frozen = p.frozen;
			const dailyCap = p.daily_usd;
			const spentToday = p.spent_today_usd ?? spend.today ?? 0;
			const pct = dailyCap && dailyCap > 0 ? Math.min(100, (spentToday / dailyCap) * 100) : 0;
			const barCls = pct >= 100 ? 'danger' : pct >= 75 ? 'warn' : '';

			const freezeCard = `
				<div class="awh-freeze-card${frozen ? ' is-frozen' : ''}" style="margin-bottom:var(--space-3,12px)">
					<div class="awh-freeze-row">
						<div class="awh-freeze-copy">
							<strong>${frozen ? '🔒 Autonomous spending frozen' : '🟢 Autonomous spending armed'}</strong>
							<span>${frozen
								? 'Every autonomous payment (services, trades, snipes) is blocked. You can still withdraw.'
								: 'The agent may pay other services from its wallet, bounded by the caps below.'}</span>
						</div>
						<button class="awh-btn ${frozen ? 'awh-btn--primary' : 'awh-btn--danger'}" type="button" data-act="toggle-freeze" ${state.freezing ? 'disabled' : ''}>
							${state.freezing ? '…' : (frozen ? 'Unfreeze' : 'Freeze all')}
						</button>
					</div>
				</div>`;

			const cap = (v) => (v == null ? 'No cap' : money(v));
			h.innerHTML = `<h2 class="awh-card-h">Autonomous spending · set & forget, safely</h2>
				${freezeCard}
				<div class="awh-earn-policy">
					<div class="awh-earn-pcell"><b>${escapeHtml(cap(dailyCap))}</b><span>Daily cap</span>${dailyCap ? `<div class="awh-earn-pbar"><i class="${barCls}" style="width:${pct}%"></i></div>` : ''}</div>
					<div class="awh-earn-pcell"><b>${escapeHtml(cap(p.per_tx_usd))}</b><span>Per payment</span></div>
					<div class="awh-earn-pcell"><b>${p.allowlist_count > 0 ? p.allowlist_count : 'Open'}</b><span>Allowlist</span></div>
				</div>
				<p class="awh-earn-split" style="margin-top:0">Spent <b>${escapeHtml(money(spentToday))}</b> today${dailyCap ? ` of ${escapeHtml(money(dailyCap))}` : ''} · <b>${escapeHtml(money(spend.lifetime))}</b> lifetime across ${spend.count} payment${spend.count === 1 ? '' : 's'}.</p>
				<div class="awh-earn-save-row">
					<button class="awh-btn awh-btn--primary" type="button" data-act="hire">Hire a service →</button>
					<button class="awh-btn" type="button" data-act="adjust-caps">Adjust caps & allowlist</button>
				</div>`;
		}

		async function toggleFreeze() {
			const next = !state.econ.policy.frozen;
			if (next && !confirmFreeze()) return;
			state.freezing = true;
			renderSpend();
			const res = await setFrozen(ctx.agentId, next);
			if (destroyed) return;
			state.freezing = false;
			if (res.ok) {
				state.econ.policy.frozen = res.data?.limits?.frozen ?? next;
				toast(next ? 'Autonomous spending frozen' : 'Autonomous spending re-armed');
			} else {
				toast(res.message || 'Could not update the kill switch');
			}
			renderSpend();
		}

		function confirmFreeze() {
			// A freeze is the safe direction (it only blocks spending) — no modal, but
			// give the owner a beat to confirm via the native dialog.
			if (typeof window === 'undefined' || !window.confirm) return true;
			return window.confirm('Freeze all autonomous spending? The agent will stop paying for any service until you unfreeze. Withdrawals stay available.');
		}

		// ── 4. Receipts ─────────────────────────────────────────────────────────
		function renderReceipts() {
			const h = host('receipts');
			if (!h) return;
			if (state.loading) {
				h.innerHTML = `<h2 class="awh-card-h">Receipts</h2><div class="awh-earn-skel" aria-busy="true"><span></span><span></span></div>`;
				return;
			}
			if (state.error) {
				h.innerHTML = `<h2 class="awh-card-h">Receipts</h2><div class="awh-empty" role="alert">Couldn’t load receipts. <button class="awh-btn awh-bal-mini" type="button" data-act="reload">Retry</button></div>`;
				return;
			}
			const rows = state.econ.receipts || [];
			if (!rows.length) {
				h.innerHTML = `<h2 class="awh-card-h">Receipts</h2>
					<div class="awh-earn-empty">No money has moved yet. Every payment in and out — skill sales, hires from other agents, tips, and services your agent pays for — shows up here as a receipt with its on-chain signature.</div>`;
				return;
			}
			const net = ctx.getNetwork?.() || 'mainnet';
			const items = rows.map((r) => {
				const inbound = r.direction === 'in';
				const amt = r.usd != null ? money(r.usd) : (r.sol != null ? `${r.sol.toFixed(4)} SOL` : '—');
				const pending = r.status && r.status !== 'confirmed' && r.status !== 'ok';
				// An agent counterparty (e.g. another agent that hired this one) links to
				// its real profile by name; an on-chain address links to the explorer; a
				// bare id falls back to a short label.
				let cp = '';
				if (r.counterparty_agent_id) {
					cp = `<a href="/agents/${escapeHtml(r.counterparty_agent_id)}">${escapeHtml(clampName(r.counterparty || 'Agent'))}</a>`;
				} else if (r.counterparty && looksLikeAddress(r.counterparty)) {
					cp = `<a href="${escapeHtml(explorerAddressUrl(r.counterparty, net))}" target="_blank" rel="noopener">${escapeHtml(shortAddress(r.counterparty, 4, 4))} ↗</a>`;
				} else if (r.counterparty) {
					cp = escapeHtml(shortAddress(r.counterparty, 4, 4));
				}
				const when = r.created_at ? timeAgo(unixSec(r.created_at)) : '';
				const sig = r.signature
					? ` · <a href="${escapeHtml(explorerTxUrl(r.signature, net))}" target="_blank" rel="noopener">tx ↗</a>`
					: '';
				return `<li class="awh-rcpt">
					<div class="awh-rcpt-ic ${inbound ? 'in' : 'out'}" aria-hidden="true">${inbound ? '↓' : '↑'}</div>
					<div class="awh-rcpt-main">
						<div class="awh-rcpt-label">${escapeHtml(r.label || (inbound ? 'Received' : 'Paid'))}</div>
						<div class="awh-rcpt-meta">${inbound ? 'from' : 'to'} ${cp || '—'} · ${escapeHtml(when)}${pending ? ` · ${escapeHtml(r.status)}` : ''}${sig}</div>
					</div>
					<div class="awh-rcpt-amt ${inbound ? 'in' : 'out'}${pending ? ' pending' : ''}">${inbound ? '+' : '−'}${escapeHtml(amt)}</div>
				</li>`;
			}).join('');
			h.innerHTML = `<h2 class="awh-card-h">Receipts · ${rows.length} recent</h2><ul class="awh-rcpt-list">${items}</ul>`;
		}

		// ── 5. Discover ─────────────────────────────────────────────────────────
		function renderDiscover() {
			const h = host('discover');
			if (!h) return;
			const customers = state.econ?.customers || [];
			const peers = state.econ?.peers || [];
			const net = ctx.getNetwork?.() || 'mainnet';

			// The income edge: agents that have hired this one, ranked by spend. Each
			// links to a real agent profile. This is the owner's "who's my best
			// customer?" — the signal for which skills to price up or promote.
			const customerBlock = customers.length
				? `<div class="awh-cust">
						<p class="awh-cust-h">Top customers</p>
						<ul class="awh-cust-list">${customers.slice(0, 5).map((c) => `
							<li class="awh-cust-row">
								<a class="awh-cust-name" href="/agents/${escapeHtml(c.agent_id)}" title="${escapeHtml(c.name)}">${escapeHtml(clampName(c.name))}</a>
								<span class="awh-cust-meta">${c.count} hire${c.count === 1 ? '' : 's'}</span>
								<span class="awh-cust-usd">${escapeHtml(money(c.usd))}</span>
							</li>`).join('')}</ul>
					</div>`
				: '';

			const peerLine = peers.length
				? `<p class="awh-earn-split" style="margin-top:0">Your agent has paid ${peers.length} counterpart${peers.length === 1 ? 'y' : 'ies'}: ${peers.slice(0, 4).map((p) => `<a class="awh-earn-link" href="${escapeHtml(explorerAddressUrl(p.address, net))}" target="_blank" rel="noopener">${escapeHtml(shortAddress(p.address, 4, 4))}</a>`).join(', ')}.</p>`
				: `<p class="awh-earn-split" style="margin-top:0">Discover agents and x402 services your avatar can hire — the network where agents pay agents.</p>`;
			h.innerHTML = `<h2 class="awh-card-h">The agent economy</h2>
				${customerBlock}
				${peerLine}
				<div class="awh-earn-disc">
					<a class="awh-btn awh-btn--primary" href="/economy">Services directory →</a>
					<a class="awh-btn" href="/agent-economy">Watch agents transact</a>
				</div>`;
		}

		// ── data ────────────────────────────────────────────────────────────────
		async function reload({ keepEditor = false } = {}) {
			const res = await fetchEconomy(ctx.agentId, ctx.getNetwork?.() || 'mainnet');
			if (destroyed) return;
			if (res.ok) {
				state.econ = res.data;
				state.error = null;
				computeAway();
			} else {
				state.error = res.message || 'load failed';
			}
			state.loading = false;
			if (!keepEditor && state.pricingLoaded) buildEditorFromPricing();
			renderAll();
		}

		// "Earned while you were away": real inbound receipts since the last time the
		// owner opened this tab. Honest — it sums actual settled receipts, nothing
		// invented. The marker is per-agent in localStorage.
		function computeAway() {
			let last = 0;
			try {
				last = Number(localStorage.getItem(SEEN_KEY(ctx.agentId))) || 0;
			} catch {
				last = 0;
			}
			if (last > 0) {
				let usd = 0;
				let count = 0;
				for (const r of state.econ.receipts || []) {
					if (r.direction !== 'in' || r.usd == null) continue;
					if (unixSec(r.created_at) * 1000 > last) {
						usd += Number(r.usd);
						count += 1;
					}
				}
				state.awayUsd = usd;
				state.awayCount = count;
			}
			try {
				localStorage.setItem(SEEN_KEY(ctx.agentId), String(Date.now()));
			} catch {
				/* storage unavailable — skip the marker */
			}
		}

		// ── interactions ────────────────────────────────────────────────────────
		panel.addEventListener('click', (ev) => {
			const act = ev.target?.closest?.('[data-act]')?.dataset?.act;
			if (!act) return;
			if (act === 'reload') {
				state.loading = true;
				renderAll();
				reload();
			} else if (act === 'save-prices') {
				savePrices();
			} else if (act === 'toggle-freeze') {
				toggleFreeze();
			} else if (act === 'hire') {
				ctx.openTab?.('pay');
			} else if (act === 'adjust-caps') {
				ctx.openTab?.('withdraw');
				toast('Open “Limits & Safety” to set caps and the allowlist');
			} else if (act === 'dismiss-away') {
				state.awayDismissed = true;
				renderHero();
			}
		});

		panel.addEventListener('change', (ev) => {
			const t = ev.target;
			const edit = t?.dataset?.edit;
			if (!edit) return;
			const i = Number(t.dataset.i);
			const row = state.editor[i];
			if (!row) return;
			if (edit === 'active') {
				row.active = t.checked;
				state.saveMsg = null;
				renderEngine();
			}
		});

		panel.addEventListener('input', (ev) => {
			const t = ev.target;
			if (t?.dataset?.edit === 'usd') {
				const row = state.editor[Number(t.dataset.i)];
				if (row) row.usd = t.value;
			}
		});

		shell();

		return {
			onShow() {
				if (state.loading) {
					reload();
					loadPricing();
				}
			},
			destroy() {
				destroyed = true;
				cancelAnimationFrame(countRaf);
			},
		};
	},
});

function looksLikeAddress(s) {
	return typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

// Keep a display name to a sane length so a long agent name can't break the row.
function clampName(s, max = 28) {
	const v = String(s ?? '').trim();
	return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}
