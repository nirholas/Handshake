/**
 * Agent Wallet hub — Policy tab (natural-language spend policies).
 *
 * Owner-only. The owner writes how their agent's custodial wallet may spend in
 * plain English; a real Claude call (server-side, through the platform LLM proxy)
 * COMPILES it into a deterministic rule document that the shared spend guards
 * enforce on every trade / snipe / x402 payment / withdraw. The model only authors
 * and explains — it never decides a spend. Before saving, the owner sees:
 *
 *   1. The numbered, plain-English READBACK of the compiled rules (generated from
 *      the DSL, so it can never drift from what code enforces).
 *   2. A BACKTEST against the wallet's real custody history: "against your last N
 *      days, this would have blocked 3 spends ($X) and allowed 47" — computed by the
 *      exact evaluator that runs in production. With no history yet, a set of
 *      hypothetical cases shows how it behaves.
 *
 * All states designed: composing, compiling (real async), refused/invalid
 * (actionable), backtest-empty (explained), saved. Keyboard-driven + accessible.
 * Everything is real: real LLM compile, real history, the real shared policy.
 */

import { registerWalletTab } from '../registry.js';
import { formatUsd } from '../util.js';
import { consumeCsrfToken } from '../../api.js';

const STARTERS = [
	{
		key: 'conservative',
		label: 'Conservative',
		text: 'Block any payment over $25. Never let the wallet drop below 1 SOL. Only ever pay services I’ve used before. Stop everything if a trade drops more than 30%.',
	},
	{
		key: 'active',
		label: 'Active trader',
		text: 'Let it trade up to $100 a day. Only trade tokens at least 6 hours old. Never spend my last 0.5 SOL. Freeze the wallet if any trade drops more than 40%.',
	},
	{
		key: 'pay-only',
		label: 'Pay-only',
		text: 'Only ever pay services I’ve used before. Block any single payment over $50. Cap total spend at $200 a day.',
	},
];

const POLICY_STYLE_ID = 'awh-policy-style';
const POLICY_STYLE = `
.awp-intro { font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); line-height:1.5; margin:0 0 var(--space-3,12px); }
.awp-chips { display:flex; gap:6px; flex-wrap:wrap; margin-bottom: var(--space-3,12px); }
.awp-chip { appearance:none; font:inherit; font-size: var(--text-2xs,.6875rem); font-weight:600; color: var(--ink,#e8e8e8); background: var(--surface-2,rgba(255,255,255,.06)); border:1px solid var(--stroke,rgba(255,255,255,.1)); border-radius: var(--radius-pill,999px); padding:5px 12px; cursor:pointer; transition: background var(--duration-fast,140ms), border-color var(--duration-fast,140ms), transform var(--duration-instant,80ms); }
.awp-chip:hover { background: var(--surface-3,rgba(255,255,255,.1)); border-color: var(--stroke-strong,rgba(255,255,255,.16)); }
.awp-chip:active { transform: translateY(1px); }
.awp-chip:focus-visible { outline: var(--focus-ring-width,2px) solid var(--focus-ring-color,#fff); outline-offset:2px; }
.awp-ta { width:100%; box-sizing:border-box; min-height:88px; resize:vertical; font:inherit; font-size: var(--text-md,.8125rem); line-height:1.5; color: var(--ink,#e8e8e8); background: var(--surface-1,rgba(255,255,255,.03)); border:1px solid var(--stroke,rgba(255,255,255,.1)); border-radius: var(--radius-md,10px); padding:11px 13px; transition: border-color var(--duration-fast,140ms); }
.awp-ta:focus { outline:none; border-color: var(--stroke-strong,rgba(255,255,255,.2)); }
.awp-actions { display:flex; gap:8px; margin-top: var(--space-3,12px); align-items:center; flex-wrap:wrap; }
.awp-actions .grow { flex:1; }
.awp-hint { font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); }

.awp-rules { list-style:none; margin:0; padding:0; counter-reset: awp; }
.awp-rule { display:flex; gap:11px; padding:9px 0; border-bottom:1px solid var(--stroke,rgba(255,255,255,.06)); font-size: var(--text-sm,.8125rem); line-height:1.45; }
.awp-rule:last-child { border-bottom:none; }
.awp-rule .n { flex:none; width:22px; height:22px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size: var(--text-2xs,.6875rem); font-weight:700; background: var(--surface-2,rgba(255,255,255,.07)); color: var(--ink,#e8e8e8); }
.awp-rule .tx { flex:1; min-width:0; color: var(--ink,#e8e8e8); }
.awp-rule .tag { flex:none; font-size: var(--text-2xs,.6875rem); font-weight:600; padding:2px 8px; border-radius: var(--radius-pill,999px); white-space:nowrap; align-self:flex-start; }
.awp-rule .tag.block { color: var(--danger,#f87171); background: color-mix(in srgb, var(--danger,#f87171) 12%, transparent); border:1px solid color-mix(in srgb, var(--danger,#f87171) 30%, transparent); }
.awp-rule .tag.freeze { color: var(--warn,#fbbf24); background: color-mix(in srgb, var(--warn,#fbbf24) 12%, transparent); border:1px solid color-mix(in srgb, var(--warn,#fbbf24) 30%, transparent); }
.awp-rule .tag.allow { color: var(--success,#4ade80); background: color-mix(in srgb, var(--success,#4ade80) 12%, transparent); border:1px solid color-mix(in srgb, var(--success,#4ade80) 30%, transparent); }
.awp-rule .tag.require_step_up { color: var(--accent,#8ab4ff); background: color-mix(in srgb, var(--accent,#8ab4ff) 14%, transparent); border:1px solid color-mix(in srgb, var(--accent,#8ab4ff) 30%, transparent); }

.awp-assume { margin: var(--space-3,12px) 0 0; padding:10px 12px; border-radius: var(--radius-md,10px); background: color-mix(in srgb, var(--warn,#fbbf24) 8%, transparent); border:1px solid color-mix(in srgb, var(--warn,#fbbf24) 24%, transparent); font-size: var(--text-sm,.764rem); color: var(--ink,#e8e8e8); line-height:1.45; }
.awp-assume ul { margin:6px 0 0; padding-left:18px; } .awp-assume li { margin:2px 0; }

.awp-bt-head { display:flex; gap:8px; flex-wrap:wrap; align-items:baseline; margin-bottom:10px; }
.awp-bt-stat { font-size: var(--text-2xs,.6875rem); font-weight:600; padding:3px 10px; border-radius: var(--radius-pill,999px); }
.awp-bt-stat.allow { color: var(--success,#4ade80); background: color-mix(in srgb, var(--success,#4ade80) 12%, transparent); }
.awp-bt-stat.block { color: var(--danger,#f87171); background: color-mix(in srgb, var(--danger,#f87171) 12%, transparent); }
.awp-bt-stat.muted { color: var(--ink-dim,#888); background: var(--surface-2,rgba(255,255,255,.05)); }
.awp-bar { display:flex; height:8px; border-radius:6px; overflow:hidden; background: var(--surface-2,rgba(255,255,255,.06)); margin-bottom:10px; }
.awp-bar .a { background: color-mix(in srgb, var(--success,#4ade80) 70%, transparent); }
.awp-bar .b { background: color-mix(in srgb, var(--danger,#f87171) 75%, transparent); }
.awp-tl { display:flex; gap:2px; flex-wrap:wrap; margin:8px 0 4px; }
.awp-tl .c { width:11px; height:18px; border-radius:3px; background: color-mix(in srgb, var(--success,#4ade80) 55%, transparent); cursor:default; transition: transform var(--duration-instant,80ms); }
.awp-tl .c.blocked { background: color-mix(in srgb, var(--danger,#f87171) 70%, transparent); }
.awp-tl .c:hover { transform: scaleY(1.25); }
.awp-byrule { list-style:none; margin:10px 0 0; padding:0; }
.awp-byrule li { display:flex; justify-content:space-between; gap:10px; padding:6px 0; border-top:1px solid var(--stroke,rgba(255,255,255,.06)); font-size: var(--text-sm,.764rem); }
.awp-byrule .lbl { color: var(--ink,#e8e8e8); min-width:0; }
.awp-byrule .ct { color: var(--danger,#f87171); flex:none; font-family: var(--font-mono,ui-monospace,monospace); }

.awp-syn { list-style:none; margin:0; padding:0; }
.awp-syn li { display:flex; justify-content:space-between; gap:10px; align-items:center; padding:7px 0; border-bottom:1px solid var(--stroke,rgba(255,255,255,.06)); font-size: var(--text-sm,.764rem); }
.awp-syn li:last-child { border-bottom:none; }
.awp-syn .v { flex:none; font-size: var(--text-2xs,.6875rem); font-weight:700; padding:2px 9px; border-radius: var(--radius-pill,999px); }
.awp-syn .v.ok { color: var(--success,#4ade80); background: color-mix(in srgb, var(--success,#4ade80) 12%, transparent); }
.awp-syn .v.no { color: var(--danger,#f87171); background: color-mix(in srgb, var(--danger,#f87171) 12%, transparent); }

.awp-err { background: color-mix(in srgb, var(--danger,#f87171) 12%, transparent); border:1px solid color-mix(in srgb, var(--danger,#f87171) 32%, transparent); color: var(--danger,#f87171); border-radius: var(--radius-md,10px); padding:10px 12px; font-size: var(--text-sm,.764rem); margin-bottom: var(--space-3,12px); line-height:1.45; }
.awp-warn { background: color-mix(in srgb, var(--warn,#fbbf24) 9%, transparent); border:1px solid color-mix(in srgb, var(--warn,#fbbf24) 28%, transparent); color: var(--warn,#fbbf24); border-radius: var(--radius-md,10px); padding:10px 12px; font-size: var(--text-sm,.764rem); margin-bottom: var(--space-3,12px); line-height:1.45; }
.awp-skel { height:14px; border-radius:6px; background: var(--surface-2,rgba(255,255,255,.05)); animation: awp-pulse 1.4s ease-in-out infinite; margin:9px 0; }
.awp-spin { display:inline-block; width:13px; height:13px; border:2px solid rgba(255,255,255,.3); border-top-color: currentColor; border-radius:50%; animation: awp-rot .7s linear infinite; vertical-align:-2px; margin-right:6px; }
.awp-caps { display:flex; gap:6px; flex-wrap:wrap; }
.awp-cap { font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); background: var(--surface-2,rgba(255,255,255,.05)); border:1px solid var(--stroke,rgba(255,255,255,.08)); border-radius: var(--radius-pill,999px); padding:3px 10px; }
@keyframes awp-rot { to { transform: rotate(360deg); } }
@keyframes awp-pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
@media (prefers-reduced-motion: reduce) { .awp-skel, .awp-spin, .awp-tl .c { animation:none; transition:none; } }
`;

function injectStyle() {
	if (typeof document === 'undefined' || document.getElementById(POLICY_STYLE_ID)) return;
	const tag = document.createElement('style');
	tag.id = POLICY_STYLE_ID;
	tag.textContent = POLICY_STYLE;
	document.head.appendChild(tag);
}

// Fetch helper — never throws, always a designed result. Mirrors the withdraw tab.
async function call(url, { method = 'GET', body = null } = {}) {
	try {
		const opts = { method, credentials: 'include', headers: {} };
		if (body != null) {
			opts.headers['content-type'] = 'application/json';
			opts.body = JSON.stringify(body);
		}
		if (method !== 'GET') {
			const token = await consumeCsrfToken();
			if (token) opts.headers['x-csrf-token'] = token;
		}
		const r = await fetch(url, opts);
		let j = null;
		try { j = await r.json(); } catch { /* empty body */ }
		if (!r.ok) {
			return { ok: false, status: r.status, code: j?.error || 'error', message: j?.error_description || `request failed (${r.status})`, extra: j || null };
		}
		return { ok: true, status: r.status, data: j?.data ?? j };
	} catch (err) {
		return { ok: false, status: 0, code: 'network_error', message: err?.message || 'network error' };
	}
}

const ACTION_TAG = { block: 'Block', freeze: 'Freeze', allow: 'Allow', require_step_up: 'Ask me' };

function protectiveCount(rules) {
	return (rules || []).filter((r) => r.action === 'block' || r.action === 'freeze' || r.action === 'require_step_up').length;
}

registerWalletTab({
	id: 'policy',
	label: 'Policy',
	order: 58,
	ownerOnly: true,
	mount({ panel, ctx }) {
		injectStyle();
		const esc = ctx.escapeHtml;
		const toast = ctx.toast;
		const base = (sub) => `/api/agents/${encodeURIComponent(ctx.agentId)}/solana/${sub}`;

		let destroyed = false;
		let detachNet = null;
		const state = {
			loaded: false,
			signedOut: false,     // 401 from the owner-gated policy endpoint
			current: null,        // { policy, readback, source_text, numeric_limits } | { error }
			draft: '',            // textarea content
			compiling: false,
			compiled: null,       // compile result | null
			compileErr: null,     // { message, refusal } | null
			saving: false,
		};

		function render() {
			if (destroyed) return;
			if (state.signedOut) { panel.innerHTML = renderSignedOut(); return; }
			panel.innerHTML = `${renderCurrent()}${renderComposer()}${renderResult()}`;
			wire();
		}

		// Owner-only surface — if the session lapsed, invite a sign-in rather than
		// showing a bare "couldn't load" error.
		function renderSignedOut() {
			const next = encodeURIComponent(location.pathname + location.search + location.hash);
			return `<div class="awh-card">
				<div class="awh-card-h">Spend policy</div>
				<p class="awp-intro">Spend policies are private to the wallet owner. Sign in to review and edit how your agent is allowed to spend.</p>
				<div class="awp-actions"><a class="awh-btn awh-btn--primary" href="/login?next=${next}">Sign in</a></div>
			</div>`;
		}

		// ── Active policy card ──────────────────────────────────────────────────
		function renderCurrent() {
			if (!state.loaded) {
				return `<div class="awh-card"><div class="awh-card-h">Active policy</div><div class="awp-skel" style="width:50%"></div><div class="awp-skel"></div><div class="awp-skel" style="width:70%"></div></div>`;
			}
			if (state.current?.error) {
				return `<div class="awh-card"><div class="awh-card-h">Active policy</div><div class="awp-err" role="alert">Couldn’t load your policy.<br>${esc(state.current.error)}</div><div class="awp-actions"><button class="awh-btn" type="button" data-act="reload">Retry</button></div></div>`;
			}
			const cur = state.current || {};
			const readback = Array.isArray(cur.readback) ? cur.readback : [];
			const caps = cur.numeric_limits || {};
			const capChips = `
				<div class="awp-caps" style="margin-top:10px;">
					<span class="awp-cap">Daily cap: ${caps.daily_usd != null ? esc(formatUsd(caps.daily_usd)) : 'none'}</span>
					<span class="awp-cap">Per-tx cap: ${caps.per_tx_usd != null ? esc(formatUsd(caps.per_tx_usd)) : 'none'}</span>
					<span class="awp-cap">Per-counterparty cap: ${caps.per_counterparty_daily_usd != null ? esc(formatUsd(caps.per_counterparty_daily_usd)) : 'none'}</span>
					<span class="awp-cap">${caps.frozen ? '🔒 frozen' : 'active'}</span>
				</div>
				<p class="awp-hint" style="margin:8px 0 0;">Numeric caps and the freeze switch are always enforced — edit them under Withdraw → Limits & Safety.</p>`;
			if (!readback.length) {
				return `<div class="awh-card">
					<div class="awh-card-h">Active policy</div>
					<p class="awp-intro" style="margin-bottom:0;">No plain-English rules yet. Your wallet is governed by its numeric caps below. Describe richer rules — like “only trade tokens at least a day old” — and they’ll be enforced on every spend.</p>
					${capChips}
				</div>`;
			}
			return `<div class="awh-card">
				<div class="awh-card-h">Active policy · ${readback.length} rule${readback.length === 1 ? '' : 's'}</div>
				<ol class="awp-rules">${readback.map(ruleLi).join('')}</ol>
				${capChips}
				<div class="awp-actions"><button class="awh-btn awh-btn--danger" type="button" data-act="clear">Remove all rules</button></div>
			</div>`;
		}

		function ruleLi(r) {
			const action = r.action || 'block';
			return `<li class="awp-rule"><span class="n">${r.n}</span><span class="tx">${esc(r.text || '')}</span><span class="tag ${esc(action)}">${esc(ACTION_TAG[action] || action)}</span></li>`;
		}

		// ── Composer card ───────────────────────────────────────────────────────
		function renderComposer() {
			return `<div class="awh-card">
				<div class="awh-card-h">Describe how your agent should spend</div>
				<p class="awp-intro">Write your safety rules in plain English. They’re compiled into deterministic rules and <strong>enforced by code on every spend</strong> — the AI only translates and explains, it never approves a payment.</p>
				<div class="awp-chips" role="group" aria-label="Starter policies">
					${STARTERS.map((s) => `<button class="awp-chip" type="button" data-starter="${esc(s.key)}">${esc(s.label)}</button>`).join('')}
				</div>
				<label for="awp-ta" class="awp-hint" style="display:block;margin-bottom:6px;">Your rules</label>
				<textarea id="awp-ta" class="awp-ta" spellcheck="true" placeholder="e.g. Let it trade up to $50/day on tokens at least a day old, never spend my last 1 SOL, stop everything if a trade drops more than 30%, and only ever pay services I’ve used before.">${esc(state.draft)}</textarea>
				<div class="awp-actions">
					<button class="awh-btn awh-btn--primary" type="button" id="awp-compile" aria-busy="${state.compiling ? 'true' : 'false'}" ${state.compiling ? 'disabled' : ''}>
						${state.compiling ? '<span class="awp-spin" aria-hidden="true"></span>Compiling…' : 'Compile &amp; preview'}
					</button>
					<span class="awp-hint grow">Nothing is enforced until you review and save.</span>
				</div>
			</div>`;
		}

		// ── Compile result (readback + backtest) ────────────────────────────────
		function renderResult() {
			if (state.compileErr) {
				return `<div class="awh-card">
					<div class="awp-${state.compileErr.refusal ? 'warn' : 'err'}" role="alert">${esc(state.compileErr.message || 'Could not compile that into a policy.')}</div>
					<p class="awp-hint">Try a concrete rule, e.g. “block any payment over $50”, “only trade tokens at least a day old”, or “never let SOL drop below 1”.</p>
				</div>`;
			}
			if (!state.compiled) return '';
			const c = state.compiled;
			const readback = Array.isArray(c.readback) ? c.readback : [];
			if (!readback.length) {
				return `<div class="awh-card"><div class="awp-warn" role="alert">That didn’t produce any enforceable rules. Rephrase with a concrete limit.</div></div>`;
			}
			const assumptions = Array.isArray(c.assumptions) ? c.assumptions : [];
			return `
			<div class="awh-card">
				<div class="awh-card-h">Preview · ${readback.length} rule${readback.length === 1 ? '' : 's'} ${c.via === 'model' ? '' : '<span class="awp-hint">(parsed locally)</span>'}</div>
				<ol class="awp-rules">${readback.map(ruleLi).join('')}</ol>
				${assumptions.length ? `<div class="awp-assume"><strong>Assumptions</strong><ul>${assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>` : ''}
			</div>
			${renderBacktest(c.backtest, c.synthetic)}
			<div class="awh-card">
				<div class="awp-actions">
					<button class="awh-btn awh-btn--primary" type="button" id="awp-save" ${state.saving ? 'disabled' : ''}>${state.saving ? '<span class="awp-spin"></span>Saving…' : 'Save policy'}</button>
					<button class="awh-btn" type="button" id="awp-discard" ${state.saving ? 'disabled' : ''}>Discard</button>
					<span class="awp-hint grow">Saving replaces your current natural-language rules. Numeric caps are unchanged.</span>
				</div>
			</div>`;
		}

		function renderBacktest(bt, synthetic) {
			// Real history present → show allowed/blocked summary, timeline, by-rule.
			if (bt && bt.total > 0) {
				const aPct = Math.round((bt.allowed / bt.total) * 100);
				const tl = (bt.items || []).slice(0, 120)
					.map((it) => `<span class="c ${it.denied ? 'blocked' : ''}" title="${esc(itemTitle(it))}"></span>`).join('');
				const byRule = (bt.by_rule || []).filter((r) => r.count > 0);
				return `<div class="awh-card">
					<div class="awh-card-h">Backtest · your last ${bt.total} spend${bt.total === 1 ? '' : 's'}</div>
					<div class="awp-bt-head">
						<span class="awp-bt-stat allow">${bt.allowed} allowed${bt.allowed_usd ? ` · ${esc(formatUsd(bt.allowed_usd))}` : ''}</span>
						<span class="awp-bt-stat ${bt.blocked ? 'block' : 'muted'}">${bt.blocked} blocked${bt.blocked_usd ? ` · ${esc(formatUsd(bt.blocked_usd))}` : ''}</span>
					</div>
					<div class="awp-bar" role="img" aria-label="${bt.allowed} of ${bt.total} allowed">
						<div class="a" style="width:${aPct}%"></div><div class="b" style="width:${100 - aPct}%"></div>
					</div>
					<div class="awp-tl" aria-hidden="true">${tl}</div>
					<p class="awp-hint">Each square is one past spend, newest first — green allowed, red blocked. Computed by the exact rules that will run live.</p>
					${byRule.length ? `<ul class="awp-byrule">${byRule.map((r) => `<li><span class="lbl">${esc(r.label || ('Rule ' + ((r.ruleIndex ?? 0) + 1)))}</span><span class="ct">${r.count} blocked${r.usd ? ` · ${esc(formatUsd(r.usd))}` : ''}</span></li>`).join('')}</ul>` : ''}
				</div>`;
			}
			// No history → synthetic "how it handles common cases".
			const probes = Array.isArray(synthetic) ? synthetic : [];
			return `<div class="awh-card">
				<div class="awh-card-h">How it behaves</div>
				<p class="awp-hint" style="margin-top:0;">No spend history on ${esc(ctx.getNetwork())} yet, so here’s how this policy would handle some common cases:</p>
				${probes.length ? `<ul class="awp-syn">${probes.map((p) => `<li><span>${esc(p.label)}</span><span class="v ${p.denied ? 'no' : 'ok'}">${p.denied ? (p.decision === 'freeze' ? 'Freeze' : p.decision === 'step_up' ? 'Ask me' : 'Blocked') : 'Allowed'}</span></li>`).join('')}</ul>` : '<p class="awh-empty">Once your agent starts spending, you’ll see a real backtest here.</p>'}
			</div>`;
		}

		function itemTitle(it) {
			const when = it.created_at ? new Date(it.created_at).toLocaleDateString() : '';
			const amt = it.usd != null ? formatUsd(it.usd) : (it.asset || '');
			const verb = it.denied ? `blocked — ${it.rule_text || 'policy'}` : 'allowed';
			return `${it.category || 'spend'} ${amt} · ${when} · ${verb}`;
		}

		// ── wiring ──────────────────────────────────────────────────────────────
		function wire() {
			panel.querySelector('[data-act="reload"]')?.addEventListener('click', () => { state.loaded = false; render(); load(); });
			panel.querySelector('[data-act="clear"]')?.addEventListener('click', clearPolicy);

			panel.querySelectorAll('[data-starter]').forEach((b) => b.addEventListener('click', () => {
				const s = STARTERS.find((x) => x.key === b.dataset.starter);
				if (!s) return;
				state.draft = s.text;
				const ta = panel.querySelector('#awp-ta');
				if (ta) { ta.value = s.text; ta.focus(); }
			}));

			const ta = panel.querySelector('#awp-ta');
			ta?.addEventListener('input', () => { state.draft = ta.value; });
			// Cmd/Ctrl+Enter compiles.
			ta?.addEventListener('keydown', (e) => {
				if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); compile(); }
			});
			panel.querySelector('#awp-compile')?.addEventListener('click', compile);
			panel.querySelector('#awp-save')?.addEventListener('click', save);
			panel.querySelector('#awp-discard')?.addEventListener('click', () => { state.compiled = null; state.compileErr = null; render(); });
		}

		async function load() {
			const res = await call(`${base('policy')}?network=${ctx.getNetwork()}`);
			if (destroyed) return;
			state.loaded = true;
			if (res.status === 401) { state.signedOut = true; render(); return; }
			state.signedOut = false;
			state.current = res.ok ? res.data : { error: res.message };
			if (res.ok && !state.draft && typeof res.data?.source_text === 'string') state.draft = res.data.source_text;
			render();
		}

		async function compile() {
			const text = (state.draft || '').trim();
			if (text.length < 3) { toast('Describe your rules first'); panel.querySelector('#awp-ta')?.focus(); return; }
			state.compiling = true; state.compiled = null; state.compileErr = null; render();
			const res = await call(`${base('policy')}?network=${ctx.getNetwork()}`, { method: 'POST', body: { op: 'compile', text } });
			if (destroyed) return;
			state.compiling = false;
			if (!res.ok) { state.compileErr = { message: res.message }; render(); return; }
			const d = res.data || {};
			if (!d.ok) { state.compileErr = { message: d.message || 'Could not interpret that safely.', refusal: !!d.refusal }; render(); return; }
			state.compiled = d;
			render();
			panel.querySelector('#awp-save')?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
		}

		async function save() {
			if (!state.compiled || state.saving) return;
			const newRules = state.compiled.policy?.rules || [];
			// Honest loosening guard: warn before removing protection the wallet has now.
			const curRules = state.current?.policy?.rules || [];
			if (protectiveCount(newRules) < protectiveCount(curRules)) {
				if (!confirm('This policy removes some of the protections you have now. Save anyway?')) return;
			}
			state.saving = true; render();
			const res = await call(`${base('policy')}?network=${ctx.getNetwork()}`, {
				method: 'PUT',
				body: { rules: newRules, english: state.compiled.source_text },
			});
			if (destroyed) return;
			state.saving = false;
			if (!res.ok) { state.compileErr = { message: res.message }; state.compiled = null; render(); toast('Could not save policy'); return; }
			state.current = { ...(state.current || {}), policy: res.data.policy, readback: res.data.readback, source_text: res.data.policy?.source_text, numeric_limits: state.current?.numeric_limits };
			state.compiled = null;
			toast('Policy saved — now enforced on every spend');
			render();
		}

		async function clearPolicy() {
			if (!confirm('Remove all natural-language rules? Your numeric caps and freeze switch stay in place.')) return;
			const res = await call(`${base('policy')}?network=${ctx.getNetwork()}`, { method: 'PUT', body: { rules: [], english: '' } });
			if (destroyed) return;
			if (!res.ok) { toast('Could not update policy'); return; }
			state.current = { ...(state.current || {}), policy: res.data.policy, readback: res.data.readback, source_text: '' };
			toast('Natural-language rules removed');
			render();
		}

		detachNet = ctx.onNetworkChange(() => { state.loaded = false; state.compiled = null; state.compileErr = null; render(); load(); });
		render();
		load();

		return {
			onShow() { if (!state.loaded) load(); },
			destroy() { destroyed = true; detachNet?.(); },
		};
	},
});
