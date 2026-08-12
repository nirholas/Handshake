/**
 * Conversational Trading Copilot — client mount.
 *
 * Talk (text or voice) to the agent; it answers with REAL live data and proposes
 * trades you confirm. The model never executes: the backend
 * (POST /api/agents/:id/copilot, SSE) streams narration, read-only tool activity,
 * and structured trade/limits PROPOSALS. This UI renders each proposal as a
 * confirm card (quote + firewall verdict). On confirm it calls the existing
 * guarded paths — executeAgentTrade() → /api/agents/:id/solana/trade (spend
 * guards + firewall + custody audit) and PUT /api/agents/:id/trade/limits — so a
 * conversation can never bypass a guard, the kill switch, or a spend cap.
 *
 * Voice in: browser SpeechRecognition (graceful no-op where unsupported). Voice
 * out: the agent's configured voice via /api/tts/eleven or /api/tts/speak, with a
 * browser speechSynthesis fallback. Text-only works fully without either.
 *
 * Coin-agnostic: trades whatever mint the owner names at runtime. $THREE is the
 * only coin three.ws promotes — nothing here names or recommends another token.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.panel
 * @param {string} opts.agentId
 * @param {string} [opts.agentName]
 * @param {boolean} opts.isOwner
 * @param {() => string} opts.getNetwork
 * @param {(fn: (n: string) => void) => (()=>void)} [opts.onNetworkChange]
 * @param {(msg: string) => void} [opts.toast]
 * @returns {{ destroy(): void, onShow?(): void, onHide?(): void }}
 */

import { executeAgentTrade, TradeError } from './agent-solana-wallet.js';
import { createSafetyPanel } from './shared/safety-panel.js';
import { consumeCsrfToken } from './api.js';
import { mdToHtml } from './md.js';

const STYLE_ID = 'awh-copilot-style';
const STYLE = `
.awh-cop { display: flex; flex-direction: column; gap: var(--awh-gap, 16px); min-height: 0; }
.awh-cop-intro { padding: 12px 14px; border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-md,10px); background: var(--surface-1, rgba(255,255,255,.03)); color: var(--ink-dim,#888); font-size: var(--text-sm,.764rem); line-height: 1.5; }
.awh-cop-intro strong { color: var(--ink-bright,#fff); }
.awh-cop-suggest { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.awh-cop-suggest button { appearance: none; font: inherit; font-size: var(--text-2xs,.6875rem); color: var(--ink,#e8e8e8); background: var(--surface-2, rgba(255,255,255,.05)); border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-pill,999px); padding: 5px 11px; cursor: pointer; transition: background var(--duration-fast,140ms), border-color var(--duration-fast,140ms); }
.awh-cop-suggest button:hover { background: var(--surface-3, rgba(255,255,255,.08)); border-color: var(--stroke-strong, rgba(255,255,255,.14)); }
.awh-cop-suggest button:focus-visible { outline: var(--focus-ring-width,2px) solid var(--focus-ring-color,#fff); outline-offset: 2px; }

.awh-cop-thread { display: flex; flex-direction: column; gap: 12px; max-height: 56vh; overflow-y: auto; padding: 2px; scroll-behavior: smooth; }
.awh-cop-msg { display: flex; flex-direction: column; gap: 6px; max-width: 92%; }
.awh-cop-msg.is-user { align-self: flex-end; align-items: flex-end; }
.awh-cop-msg.is-agent { align-self: flex-start; }
.awh-cop-bubble { padding: 9px 13px; border-radius: var(--radius-md,12px); font-size: var(--text-md,.8125rem); line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.awh-cop-msg.is-user .awh-cop-bubble { background: var(--accent,#fff); color: #0a0a0a; border-bottom-right-radius: 4px; }
.awh-cop-msg.is-agent .awh-cop-bubble { background: var(--surface-2, rgba(255,255,255,.05)); color: var(--ink,#e8e8e8); border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-bottom-left-radius: 4px; }
.awh-cop-bubble.is-empty { color: var(--ink-dim,#888); }
.awh-cop-name { font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); padding: 0 4px; }

.awh-cop-tools { display: flex; flex-direction: column; gap: 4px; }
.awh-cop-tool { display: inline-flex; align-items: center; gap: 7px; font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); }
.awh-cop-tool::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--success,#4ade80); flex: none; }
.awh-cop-typing { display: inline-flex; gap: 3px; padding: 4px 0; }
.awh-cop-typing span { width: 5px; height: 5px; border-radius: 50%; background: var(--ink-dim,#888); animation: awh-cop-blink 1.2s infinite both; }
.awh-cop-typing span:nth-child(2) { animation-delay: .2s; } .awh-cop-typing span:nth-child(3) { animation-delay: .4s; }
@keyframes awh-cop-blink { 0%,80%,100% { opacity: .25; } 40% { opacity: 1; } }

.awh-cop-prop { border: 1px solid var(--stroke-strong, rgba(255,255,255,.14)); border-radius: var(--radius-md,10px); background: var(--surface-1, rgba(255,255,255,.03)); padding: 12px 13px; display: flex; flex-direction: column; gap: 9px; margin-top: 4px; animation: awh-cop-fade var(--duration-base,220ms) var(--ease-out,ease); }
.awh-cop-prop-h { display: flex; align-items: center; gap: 8px; font-size: var(--text-md,.8125rem); font-weight: 600; color: var(--ink-bright,#fff); }
.awh-cop-prop-tag { font-size: var(--text-2xs,.6875rem); font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: 2px 8px; border-radius: var(--radius-pill,999px); }
.awh-cop-prop-tag.is-buy { color: #0a0a0a; background: var(--success,#4ade80); }
.awh-cop-prop-tag.is-sell { color: #0a0a0a; background: var(--danger,#f87171); }
.awh-cop-prop-tag.is-limits { color: #0a0a0a; background: var(--warn,#fbbf24); }
.awh-cop-prop dl { margin: 0; display: flex; flex-direction: column; gap: 5px; }
.awh-cop-qrow { display: flex; justify-content: space-between; gap: 12px; font-size: var(--text-sm,.764rem); }
.awh-cop-qrow dt { color: var(--ink-dim,#888); margin: 0; } .awh-cop-qrow dd { margin: 0; color: var(--ink,#e8e8e8); text-align: right; font-variant-numeric: tabular-nums; }
.awh-cop-qrow dd.is-strong { color: var(--ink-bright,#fff); font-weight: 600; }
.awh-cop-qrow dd.impact-warn { color: var(--warn,#fbbf24); } .awh-cop-qrow dd.impact-danger { color: var(--danger,#f87171); }
.awh-cop-prop-why { font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); font-style: italic; }
.awh-cop-prop-actions { display: flex; gap: 8px; }
.awh-cop-prop-actions button { flex: 1; justify-content: center; }
.awh-cop-prop-confirm { padding: 9px 14px; font-weight: 600; border-radius: var(--radius-md,10px); border: 1px solid; cursor: pointer; font: inherit; font-size: var(--text-md,.8125rem); transition: background var(--duration-fast,140ms); }
.awh-cop-prop-confirm.is-buy { background: var(--success,#4ade80); color: #0a0a0a; border-color: var(--success,#4ade80); }
.awh-cop-prop-confirm.is-sell { background: var(--danger,#f87171); color: #0a0a0a; border-color: var(--danger,#f87171); }
.awh-cop-prop-confirm.is-limits { background: var(--warn,#fbbf24); color: #0a0a0a; border-color: var(--warn,#fbbf24); }
.awh-cop-prop-confirm:disabled { opacity: .55; cursor: not-allowed; }
.awh-cop-prop-confirm:hover:not(:disabled) { filter: brightness(.93); }
.awh-cop-prop-cancel { padding: 9px 14px; border-radius: var(--radius-md,10px); border: 1px solid var(--stroke, rgba(255,255,255,.1)); background: transparent; color: var(--ink,#e8e8e8); cursor: pointer; font: inherit; font-size: var(--text-md,.8125rem); }
.awh-cop-prop-cancel:hover { background: var(--surface-2, rgba(255,255,255,.05)); }
.awh-cop-prop-confirm:focus-visible, .awh-cop-prop-cancel:focus-visible, .awh-cop-suggest button:focus-visible { outline: var(--focus-ring-width,2px) solid var(--focus-ring-color,#fff); outline-offset: 2px; }
.awh-cop-prop-result { font-size: var(--text-sm,.764rem); display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px; border-radius: var(--radius-sm,8px); }
.awh-cop-prop-result.is-ok { color: var(--success,#4ade80); background: color-mix(in srgb, var(--success,#4ade80) 12%, transparent); }
.awh-cop-prop-result.is-err { color: var(--danger,#f87171); background: color-mix(in srgb, var(--danger,#f87171) 12%, transparent); }
.awh-cop-prop-result a { color: inherit; font-weight: 600; }
.awh-cop-prop-blocked { font-size: var(--text-sm,.764rem); color: var(--danger,#f87171); display: flex; gap: 7px; align-items: flex-start; }

.awh-cop-composer { display: flex; gap: 8px; align-items: flex-end; border-top: 1px solid var(--stroke, rgba(255,255,255,.06)); padding-top: 12px; }
.awh-cop-input { flex: 1 1 auto; min-width: 0; resize: none; font: inherit; font-size: var(--text-md,.8125rem); line-height: 1.45; color: var(--ink,#e8e8e8); background: var(--surface-2, rgba(255,255,255,.05)); border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-md,10px); padding: 10px 12px; max-height: 120px; }
.awh-cop-input::placeholder { color: var(--ink-faint,#666); }
.awh-cop-input:focus-visible { outline: none; border-color: var(--accent,#fff); }
.awh-cop-iconbtn { flex: none; width: 40px; height: 40px; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius-md,10px); border: 1px solid var(--stroke, rgba(255,255,255,.1)); background: var(--surface-2, rgba(255,255,255,.05)); color: var(--ink,#e8e8e8); cursor: pointer; transition: background var(--duration-fast,140ms), border-color var(--duration-fast,140ms); }
.awh-cop-iconbtn:hover:not(:disabled) { background: var(--surface-3, rgba(255,255,255,.08)); }
.awh-cop-iconbtn:disabled { opacity: .5; cursor: not-allowed; }
.awh-cop-iconbtn:focus-visible { outline: var(--focus-ring-width,2px) solid var(--focus-ring-color,#fff); outline-offset: 2px; }
.awh-cop-iconbtn[aria-pressed="true"] { background: var(--accent,#fff); color: #0a0a0a; border-color: var(--accent,#fff); }
.awh-cop-iconbtn.is-listening { background: var(--danger,#f87171); color: #0a0a0a; border-color: var(--danger,#f87171); animation: awh-cop-pulse 1.3s infinite; }
.awh-cop-send { background: var(--accent,#fff); color: #0a0a0a; border-color: var(--accent,#fff); }
@keyframes awh-cop-pulse { 0%,100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--danger,#f87171) 55%, transparent); } 50% { box-shadow: 0 0 0 6px transparent; } }
@keyframes awh-cop-fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

.awh-cop-toolbar { display: flex; align-items: center; gap: 8px; }
.awh-cop-toolbar .awh-cop-spacer { flex: 1; }
.awh-cop-status { font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); }

.awh-cop-log { border: 1px solid var(--stroke, rgba(255,255,255,.06)); border-radius: var(--radius-md,10px); }
.awh-cop-log summary { cursor: pointer; padding: 9px 12px; font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); list-style: none; }
.awh-cop-log summary::-webkit-details-marker { display: none; }
.awh-cop-log summary::before { content: '▸'; margin-right: 7px; font-size: .7em; }
.awh-cop-log[open] summary::before { content: '▾'; }
.awh-cop-log-list { list-style: none; margin: 0; padding: 0 12px 8px; }
.awh-cop-log-row { display: flex; align-items: center; gap: 9px; padding: 7px 0; border-top: 1px solid var(--stroke, rgba(255,255,255,.05)); font-size: var(--text-sm,.764rem); }
.awh-cop-log-side { font-size: var(--text-2xs,.6875rem); font-weight: 700; text-transform: uppercase; padding: 2px 7px; border-radius: var(--radius-pill,999px); flex: none; }
.awh-cop-log-side.is-buy { color: var(--success,#4ade80); background: color-mix(in srgb, var(--success,#4ade80) 14%, transparent); }
.awh-cop-log-side.is-sell { color: var(--danger,#f87171); background: color-mix(in srgb, var(--danger,#f87171) 14%, transparent); }
.awh-cop-log-side.is-limits { color: var(--warn,#fbbf24); background: color-mix(in srgb, var(--warn,#fbbf24) 14%, transparent); }
.awh-cop-log-main { flex: 1; min-width: 0; color: var(--ink,#e8e8e8); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.awh-cop-log-main a { color: var(--accent,#fff); text-decoration: none; } .awh-cop-log-main a:hover { text-decoration: underline; }

.awh-cop-error { color: var(--danger,#f87171); font-size: var(--text-sm,.764rem); display: flex; gap: 8px; align-items: center; }
.awh-cop-error button { font: inherit; font-size: var(--text-sm,.764rem); color: var(--accent,#fff); background: none; border: none; cursor: pointer; text-decoration: underline; padding: 0; }

/* Rendered markdown inside an agent bubble. */
.awh-cop-md { white-space: normal; }
.awh-cop-md > :first-child { margin-top: 0; } .awh-cop-md > :last-child { margin-bottom: 0; }
.awh-cop-md p { margin: 0 0 8px; } .awh-cop-md p:last-child { margin-bottom: 0; }
.awh-cop-md ul, .awh-cop-md ol { margin: 6px 0; padding-left: 18px; } .awh-cop-md li { margin: 2px 0; }
.awh-cop-md h3, .awh-cop-md h4, .awh-cop-md h5, .awh-cop-md h6 { margin: 10px 0 6px; font-size: var(--text-md,.8125rem); color: var(--ink-bright,#fff); }
.awh-cop-md strong { color: var(--ink-bright,#fff); font-weight: 600; }
.awh-cop-md a { color: var(--accent,#fff); text-decoration: underline; text-underline-offset: 2px; }
.awh-cop-md code { font-family: var(--font-mono,ui-monospace,monospace); font-size: .92em; background: var(--surface-3, rgba(255,255,255,.08)); padding: 1px 5px; border-radius: 5px; }
.awh-cop-md blockquote { margin: 6px 0; padding-left: 10px; border-left: 2px solid var(--stroke-strong, rgba(255,255,255,.14)); color: var(--ink-dim,#888); }

/* Structured tool-result cards (data-grounded, non-interactive). */
.awh-cop-cards { display: flex; flex-direction: column; gap: 8px; }
.awh-cop-card { border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-md,10px); background: var(--surface-1, rgba(255,255,255,.03)); padding: 10px 12px; animation: awh-cop-fade var(--duration-base,220ms) var(--ease-out,ease); }
.awh-cop-card-h { display: flex; align-items: center; gap: 7px; font-size: var(--text-2xs,.6875rem); text-transform: uppercase; letter-spacing: .05em; color: var(--ink-dim,#888); margin-bottom: 8px; }
.awh-cop-card-h .awh-cop-card-ic { font-size: .95rem; }
.awh-cop-card-h .awh-cop-card-mint { margin-left: auto; text-transform: none; letter-spacing: 0; font-family: var(--font-mono,ui-monospace,monospace); }
.awh-cop-stat { display: flex; align-items: baseline; gap: 8px; }
.awh-cop-stat-big { font-size: 1.2rem; font-weight: 600; color: var(--ink-bright,#fff); font-variant-numeric: tabular-nums; }
.awh-cop-stat-sub { font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); }
.awh-cop-hold { display: flex; justify-content: space-between; gap: 10px; font-size: var(--text-sm,.764rem); padding: 4px 0; border-top: 1px solid var(--stroke, rgba(255,255,255,.05)); }
.awh-cop-hold:first-of-type { border-top: none; }
.awh-cop-hold-mint { font-family: var(--font-mono,ui-monospace,monospace); color: var(--ink,#e8e8e8); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.awh-cop-hold-amt { color: var(--ink-bright,#fff); font-variant-numeric: tabular-nums; flex: none; }
.awh-cop-hold-pnl.is-up { color: var(--success,#4ade80); } .awh-cop-hold-pnl.is-down { color: var(--danger,#f87171); }
.awh-cop-card-empty { font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); }
.awh-cop-verdict { display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-2xs,.6875rem); font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: 3px 9px; border-radius: var(--radius-pill,999px); }
.awh-cop-verdict.is-allow { color: var(--success,#4ade80); background: color-mix(in srgb, var(--success,#4ade80) 14%, transparent); }
.awh-cop-verdict.is-warn { color: var(--warn,#fbbf24); background: color-mix(in srgb, var(--warn,#fbbf24) 14%, transparent); }
.awh-cop-verdict.is-block { color: var(--danger,#f87171); background: color-mix(in srgb, var(--danger,#f87171) 14%, transparent); }
.awh-cop-reasons { margin: 8px 0 0; padding-left: 16px; font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); } .awh-cop-reasons li { margin: 2px 0; }
.awh-cop-meter { height: 5px; border-radius: 3px; background: var(--surface-3, rgba(255,255,255,.08)); overflow: hidden; margin-top: 8px; }
.awh-cop-meter > i { display: block; height: 100%; border-radius: 3px; }
.awh-cop-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.awh-cop-chip { font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); background: var(--surface-2, rgba(255,255,255,.05)); border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-pill,999px); padding: 2px 8px; }
.awh-cop-chip.is-flag { color: var(--warn,#fbbf24); border-color: color-mix(in srgb, var(--warn,#fbbf24) 30%, transparent); }

/* Collapsible "activity" disclosure that groups a turn's tool reads. */
.awh-cop-activity { border: 1px solid var(--stroke, rgba(255,255,255,.06)); border-radius: var(--radius-md,10px); background: var(--surface-1, rgba(255,255,255,.02)); }
.awh-cop-activity > summary { cursor: pointer; padding: 7px 11px; font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); list-style: none; display: flex; align-items: center; gap: 7px; }
.awh-cop-activity > summary::-webkit-details-marker { display: none; }
.awh-cop-activity > summary::before { content: '▸'; font-size: .7em; transition: transform var(--duration-fast,140ms); }
.awh-cop-activity[open] > summary::before { transform: rotate(90deg); }
.awh-cop-activity-body { padding: 0 11px 10px; display: flex; flex-direction: column; gap: 8px; }

/* Per-message hover actions (copy / regenerate). */
.awh-cop-msg-actions { display: flex; gap: 2px; opacity: 0; transition: opacity var(--duration-fast,140ms); padding: 0 2px; }
.awh-cop-msg.is-agent:hover .awh-cop-msg-actions, .awh-cop-msg-actions:focus-within { opacity: 1; }
.awh-cop-msg-act { appearance: none; border: none; background: none; cursor: pointer; color: var(--ink-dim,#888); font-size: var(--text-2xs,.6875rem); display: inline-flex; align-items: center; gap: 4px; padding: 3px 7px; border-radius: var(--radius-sm,7px); font: inherit; font-size: var(--text-2xs,.6875rem); }
.awh-cop-msg-act:hover { color: var(--ink-bright,#fff); background: var(--surface-2, rgba(255,255,255,.05)); }
.awh-cop-msg-act:focus-visible { outline: var(--focus-ring-width,2px) solid var(--focus-ring-color,#fff); outline-offset: 1px; }
.awh-cop-msg-act.is-done { color: var(--success,#4ade80); }

/* Slash-command menu above the composer. */
.awh-cop-slash { position: absolute; left: 0; right: 52px; bottom: calc(100% + 6px); background: var(--surface-1, #141414); border: 1px solid var(--stroke-strong, rgba(255,255,255,.14)); border-radius: var(--radius-md,10px); box-shadow: 0 10px 30px rgba(0,0,0,.4); overflow: hidden; z-index: 5; }
.awh-cop-slash-item { display: flex; align-items: baseline; gap: 9px; padding: 8px 12px; cursor: pointer; font-size: var(--text-sm,.764rem); }
.awh-cop-slash-item[aria-selected="true"], .awh-cop-slash-item:hover { background: var(--surface-2, rgba(255,255,255,.06)); }
.awh-cop-slash-cmd { color: var(--ink-bright,#fff); font-weight: 600; font-family: var(--font-mono,ui-monospace,monospace); }
.awh-cop-slash-desc { color: var(--ink-dim,#888); }
.awh-cop-composer { position: relative; }
.awh-cop-iconbtn.is-stop { background: var(--danger,#f87171); color: #0a0a0a; border-color: var(--danger,#f87171); }

@media (prefers-reduced-motion: reduce) { .awh-cop-typing span, .awh-cop-iconbtn.is-listening, .awh-cop-prop, .awh-cop-card { animation: none; } .awh-cop-thread { scroll-behavior: auto; } }
@media (max-width: 520px) { .awh-cop-msg { max-width: 100%; } .awh-cop-slash { right: 0; } }
`;

function injectStyle() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const tag = document.createElement('style');
	tag.id = STYLE_ID;
	tag.textContent = STYLE;
	document.head.appendChild(tag);
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function fmtSol(n) { return n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 }); }
function fmtTok(n) {
	if (n == null || !Number.isFinite(Number(n))) return '—';
	n = Number(n);
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
	return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
function short(s, h = 4, t = 4) { return !s || s.length <= h + t + 1 ? s || '' : `${s.slice(0, h)}…${s.slice(-t)}`; }
function explorerTxUrl(sig, network) { return network === 'devnet' ? `https://explorer.solana.com/tx/${sig}?cluster=devnet` : `https://solscan.io/tx/${sig}`; }
function uiToRaw(ui, decimals) {
	if (!(Number(ui) > 0)) return '0';
	const [whole, frac = ''] = String(ui).split('.');
	const fracPad = (frac + '0'.repeat(decimals)).slice(0, decimals);
	try { return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fracPad || '0')).toString(); } catch { return '0'; }
}
const newKey = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `cop-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);

const SUGGESTIONS = [
	"How's my portfolio?",
	'What are my risk limits?',
	'Is this coin safe to buy?',
];

// Slash commands — a `/chat`-style quick palette. Each maps to a message the
// copilot already understands, so typing `/portfolio` is just a fast path to the
// same tool-grounded answer. `local` commands act on the client without a turn.
const SLASH_COMMANDS = [
	{ cmd: '/portfolio', desc: 'Show my live balance, holdings & positions', send: "How's my portfolio?" },
	{ cmd: '/limits', desc: 'Read my current risk guardrails', send: 'What are my current risk limits?' },
	{ cmd: '/safety', desc: 'Run the firewall on a mint — /safety <mint>', template: 'Is this coin safe to buy: ' },
	{ cmd: '/buy', desc: 'Propose a buy — /buy 0.2 <mint>', template: 'Buy ' },
	{ cmd: '/sell', desc: 'Propose a sell — /sell 50% <mint>', template: 'Sell ' },
	{ cmd: '/clear', desc: 'Clear this conversation', local: 'clear' },
	{ cmd: '/help', desc: 'What can the copilot do?', local: 'help' },
];

const STORAGE_VERSION = 2;
function storageKey(agentId, network) { return `awh.copilot.${agentId}.${network}`; }
// Persist only what re-renders cleanly: message text, tool cards, and executed
// action log. Live proposals (quotes go stale, safety panels hold DOM refs) and
// in-flight streaming state are deliberately dropped so a reload never resurrects
// a confirmable trade card grounded on a stale quote.
function loadHistory(agentId, network) {
	try {
		const raw = localStorage.getItem(storageKey(agentId, network));
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (parsed?.v !== STORAGE_VERSION || !Array.isArray(parsed.messages)) return null;
		return parsed;
	} catch { return null; }
}
function saveHistory(agentId, network, messages, actionLog) {
	try {
		const clean = messages
			.filter((m) => (m.role === 'user' && m.content) || (m.role === 'agent' && (m.content || (m.tools || []).length)))
			.slice(-40)
			.map((m) => m.role === 'user'
				? { role: 'user', content: m.content }
				: { role: 'agent', content: m.content, tools: (m.tools || []).map((t) => ({ name: t.name, summary: t.summary, data: t.data })) });
		localStorage.setItem(storageKey(agentId, network), JSON.stringify({ v: STORAGE_VERSION, messages: clean, actionLog: actionLog.slice(0, 30) }));
	} catch { /* storage full / disabled — persistence is best-effort */ }
}

export function mountTradingCopilot({ panel, agentId, agentName = 'Copilot', isOwner, getNetwork, onNetworkChange, toast = () => {} }) {
	injectStyle();
	let destroyed = false;
	let detachNet = null;
	let streaming = false;
	let stopped = false; // set when the owner presses Stop, so the abort reads as intentional
	let currentTurn = null; // AbortController for the in-flight SSE turn, if any
	const STREAM_STALL_MS = 45_000; // no SSE bytes for this long ⇒ dead stream (server heartbeats every 15s)
	let recognition = null;
	let listening = false;
	let voiceOut = false;
	let voiceConfig = null; // { provider, voiceId } once loaded
	let currentAudio = null;
	let slashIdx = -1; // highlighted row in the slash menu, -1 when closed

	// Conversation: {role:'user'|'agent', content, tools:[], proposals:[], streaming, error}
	const messages = [];
	const actionLog = []; // executed trades/limit changes

	// Restore the prior conversation for this wallet+network (text + tool cards +
	// executed-action log). Live proposals are intentionally not persisted.
	const restored = loadHistory(agentId, getNetwork());
	if (restored) {
		restored.messages.forEach((m) => messages.push(m.role === 'user'
			? { role: 'user', content: m.content }
			: { role: 'agent', content: m.content || '', tools: m.tools || [], proposals: [], streaming: false }));
		(restored.actionLog || []).forEach((a) => actionLog.push(a));
	}

	if (!isOwner) {
		panel.innerHTML = `<div class="awh-card"><div class="awh-cop-intro" role="note"><span aria-hidden="true">🔒</span> The trading copilot is private to <strong>${esc(agentName)}</strong>'s owner — it can read this wallet's positions and place guarded trades from it, so only the owner can talk to it.</div></div>`;
		return { destroy() {} };
	}

	panel.innerHTML = `
		<div class="awh-card awh-cop">
			<div class="awh-cop-toolbar">
				<div class="awh-cop-status" data-host="status" role="status" aria-live="polite"></div>
				<div class="awh-cop-spacer"></div>
				<button class="awh-cop-iconbtn" type="button" data-act="voiceout" aria-pressed="false" aria-label="Speak replies aloud" title="Speak replies aloud">🔊</button>
			</div>
			<div data-host="intro">${introHtml()}</div>
			<div class="awh-cop-thread" data-host="thread" role="log" aria-live="polite" aria-label="Copilot conversation" tabindex="0"></div>
			<div data-host="error"></div>
			<div class="awh-cop-composer">
				<div class="awh-cop-slash" data-host="slash" role="listbox" aria-label="Slash commands" hidden></div>
				<textarea class="awh-cop-input" data-host="input" rows="1" placeholder="Ask, say “buy 0.2 SOL of …”, or type / for commands" aria-label="Message the trading copilot"></textarea>
				<button class="awh-cop-iconbtn" type="button" data-act="mic" aria-label="Talk to the copilot" title="Voice input">🎙</button>
				<button class="awh-cop-iconbtn awh-cop-send" type="button" data-act="send" aria-label="Send message" title="Send">➤</button>
			</div>
			<details class="awh-cop-log" data-host="logwrap" hidden>
				<summary>Executed actions</summary>
				<ul class="awh-cop-log-list" data-host="loglist"></ul>
			</details>
		</div>`;

	const elThread = panel.querySelector('[data-host="thread"]');
	const elInput = panel.querySelector('[data-host="input"]');
	const elStatus = panel.querySelector('[data-host="status"]');
	const elError = panel.querySelector('[data-host="error"]');
	const elIntro = panel.querySelector('[data-host="intro"]');
	const elLogWrap = panel.querySelector('[data-host="logwrap"]');
	const elLogList = panel.querySelector('[data-host="loglist"]');
	const elSlash = panel.querySelector('[data-host="slash"]');
	const elSend = panel.querySelector('[data-act="send"]');

	function introHtml() {
		return `<div class="awh-cop-intro">
			<strong>Talk to ${esc(agentName)} to trade.</strong> Ask about safety, smart money, or your positions — or say “buy 0.25 SOL of &lt;mint&gt;”. Answers come back as live data cards; every trade is a card you confirm, running through the same spend guards, firewall, and audit as the Trade tab. The copilot never trades on its own. Type <strong>/</strong> for commands.
			<div class="awh-cop-suggest" data-host="suggest">${SUGGESTIONS.map((s, i) => `<button type="button" data-suggest="${i}">${esc(s)}</button>`).join('')}</div>
		</div>`;
	}

	function setStatus(text) { elStatus.textContent = text || ''; }

	function scrollThread() { if (elThread) elThread.scrollTop = elThread.scrollHeight; }

	// ── render ────────────────────────────────────────────────────────────────
	function render() {
		if (destroyed) return;
		elIntro.style.display = messages.length ? 'none' : '';
		elThread.innerHTML = messages.map(msgHtml).join('');
		// Mount interactive proposal cards (safety panel + buttons) after innerHTML.
		messages.forEach((m, mi) => {
			(m.proposals || []).forEach((p, pi) => {
				const host = elThread.querySelector(`[data-prop="${mi}-${pi}"]`);
				if (host) mountProposal(host, p);
			});
		});
		scrollThread();
		renderLog();
	}

	function msgHtml(m, i) {
		if (m.role === 'user') {
			return `<div class="awh-cop-msg is-user"><div class="awh-cop-bubble">${esc(m.content)}</div></div>`;
		}
		const tools = m.tools || [];
		// Cards carry the grounded numbers; the reply narrates them. A tool with no
		// card (e.g. a failed read) shows as a compact activity line instead.
		const cards = tools.filter((t) => t && t.data).map((t) => toolCardHtml(t.data));
		const bare = tools.filter((t) => t && !t.data);
		const activity = tools.length
			? `<details class="awh-cop-activity"${m.streaming ? ' open' : ''}>
					<summary>${m.streaming ? 'Reading live data' : `Looked at ${tools.length} source${tools.length > 1 ? 's' : ''}`}</summary>
					<div class="awh-cop-activity-body">
						${cards.join('')}
						${bare.map((t) => `<div class="awh-cop-tool">${esc(t.summary)}</div>`).join('')}
					</div>
				</details>` : '';
		const body = m.content
			? `<div class="awh-cop-bubble"><div class="awh-cop-md">${mdToHtml(m.content)}</div></div>`
			: m.streaming
				? `<div class="awh-cop-bubble is-empty"><span class="awh-cop-typing"><span></span><span></span><span></span></span></div>`
				: tools.length ? '' /* cards already answer; no empty bubble */
					: `<div class="awh-cop-bubble is-empty">…</div>`;
		const props = (m.proposals || []).map((p, pi) => `<div data-prop="${i}-${pi}"></div>`).join('');
		// Copy / regenerate appear on a settled agent reply that has text.
		const actions = (!m.streaming && m.content)
			? `<div class="awh-cop-msg-actions">
					<button class="awh-cop-msg-act" type="button" data-msgact="copy" data-mi="${i}" title="Copy reply">⧉ Copy</button>
					${i === lastAgentIndex() ? `<button class="awh-cop-msg-act" type="button" data-msgact="regen" title="Regenerate">↻ Retry</button>` : ''}
				</div>` : '';
		return `<div class="awh-cop-msg is-agent">
			<div class="awh-cop-name">${esc(agentName)}</div>
			${activity}${body}${props}${actions}
		</div>`;
	}

	function lastAgentIndex() {
		for (let k = messages.length - 1; k >= 0; k--) if (messages[k].role === 'agent') return k;
		return -1;
	}

	// ── grounded tool-result cards ──────────────────────────────────────────────
	function meter(pct, color) {
		const w = Math.max(0, Math.min(100, Number(pct) || 0));
		return `<div class="awh-cop-meter"><i style="width:${w}%;background:${color}"></i></div>`;
	}
	function scoreColor(s) { return s == null ? 'var(--ink-dim,#888)' : s >= 70 ? 'var(--success,#4ade80)' : s >= 40 ? 'var(--warn,#fbbf24)' : 'var(--danger,#f87171)'; }

	function toolCardHtml(d) {
		if (!d || !d.kind) return '';
		const mintTag = d.mint ? `<span class="awh-cop-card-mint">${esc(short(d.mint, 4, 4))}</span>` : '';
		if (d.kind === 'portfolio') {
			const holds = (d.holdings || []).slice(0, 8);
			const pos = d.open_positions || [];
			const holdRows = holds.length
				? holds.map((h) => `<div class="awh-cop-hold"><span class="awh-cop-hold-mint">${esc(short(h.mint, 5, 5))}</span><span class="awh-cop-hold-amt">${fmtTok(h.ui_amount)}</span></div>`).join('')
				: `<div class="awh-cop-card-empty">No SPL token holdings.</div>`;
			const posRows = pos.length
				? `<div class="awh-cop-card-h" style="margin-top:10px">Open positions</div>${pos.slice(0, 6).map((p) => {
						const up = p.unrealized_pnl_pct != null && p.unrealized_pnl_pct >= 0;
						return `<div class="awh-cop-hold"><span class="awh-cop-hold-mint">${esc(p.symbol || short(p.mint, 4, 4))}</span><span class="awh-cop-hold-pnl ${p.unrealized_pnl_pct == null ? '' : up ? 'is-up' : 'is-down'}">${p.unrealized_pnl_pct == null ? '—' : `${up ? '+' : ''}${p.unrealized_pnl_pct.toFixed(1)}%`}</span></div>`;
					}).join('')}` : '';
			return `<div class="awh-cop-card">
				<div class="awh-cop-card-h"><span class="awh-cop-card-ic" aria-hidden="true">👛</span> Portfolio ${mintTag}</div>
				<div class="awh-cop-stat"><span class="awh-cop-stat-big">◎${fmtSol(d.sol_balance)}</span><span class="awh-cop-stat-sub">SOL${d.holdings ? ` · ${d.holdings.length} token${d.holdings.length === 1 ? '' : 's'}` : ''}</span></div>
				<div style="margin-top:8px">${holdRows}</div>${posRows}
			</div>`;
		}
		if (d.kind === 'safety') {
			const v = (d.verdict || 'warn').toLowerCase();
			const reasons = (d.reasons || []).slice(0, 4);
			return `<div class="awh-cop-card">
				<div class="awh-cop-card-h"><span class="awh-cop-card-ic" aria-hidden="true">🛡️</span> Firewall ${mintTag}</div>
				<div class="awh-cop-stat"><span class="awh-cop-verdict is-${v}">${esc(v)}</span><span class="awh-cop-stat-sub">${d.score != null ? `${d.score}/100 safety${d.simulated ? ' · simulated' : ''}` : ''}</span></div>
				${d.score != null ? meter(d.score, scoreColor(d.score)) : ''}
				${reasons.length ? `<ul class="awh-cop-reasons">${reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
			</div>`;
		}
		if (d.kind === 'quote') {
			const isBuy = d.side === 'buy';
			const impact = d.price_impact_pct;
			const impCol = impact == null ? 'var(--ink-dim,#888)' : impact >= 15 ? 'var(--danger,#f87171)' : impact >= 5 ? 'var(--warn,#fbbf24)' : 'var(--success,#4ade80)';
			return `<div class="awh-cop-card">
				<div class="awh-cop-card-h"><span class="awh-cop-card-ic" aria-hidden="true">📊</span> ${isBuy ? 'Buy' : 'Sell'} quote ${mintTag}</div>
				<div class="awh-cop-hold"><span class="awh-cop-hold-mint">You ${isBuy ? 'pay' : 'sell'}</span><span class="awh-cop-hold-amt">${d.in_amount != null ? `${fmtTok(d.in_amount)} ${esc(d.in_asset || '')}` : '—'}</span></div>
				<div class="awh-cop-hold"><span class="awh-cop-hold-mint">Expected out</span><span class="awh-cop-hold-amt">${d.expected_out != null ? `${fmtTok(d.expected_out)} ${esc(d.out_asset || '')}` : '—'}</span></div>
				<div class="awh-cop-hold"><span class="awh-cop-hold-mint">Price impact</span><span class="awh-cop-hold-amt" style="color:${impCol}">${impact != null ? `${impact.toFixed(2)}%` : 'n/a'}</span></div>
			</div>`;
		}
		if (d.kind === 'smart_money') {
			return `<div class="awh-cop-card">
				<div class="awh-cop-card-h"><span class="awh-cop-card-ic" aria-hidden="true">🧠</span> Smart money ${mintTag}</div>
				<div class="awh-cop-stat"><span class="awh-cop-stat-big">${d.score ?? '—'}</span><span class="awh-cop-stat-sub">/100 · ${d.count ?? 0} reputable wallet${d.count === 1 ? '' : 's'}${d.sybil ? ' · sybil-flagged' : ''}</span></div>
				${d.score != null ? meter(d.score, scoreColor(d.score)) : ''}
			</div>`;
		}
		if (d.kind === 'intel') {
			if (d.found === false) return `<div class="awh-cop-card"><div class="awh-cop-card-h"><span class="awh-cop-card-ic" aria-hidden="true">🔎</span> Coin intel ${mintTag}</div><div class="awh-cop-card-empty">No intelligence on this mint yet.</div></div>`;
			const flags = (d.risk_flags || []).slice(0, 6);
			return `<div class="awh-cop-card">
				<div class="awh-cop-card-h"><span class="awh-cop-card-ic" aria-hidden="true">🔎</span> ${esc(d.symbol || d.name || 'Coin intel')} ${mintTag}</div>
				<div class="awh-cop-stat"><span class="awh-cop-stat-big">${d.quality_score ?? '—'}</span><span class="awh-cop-stat-sub">/100 quality${d.outcome ? ` · ${esc(d.outcome)}` : ''}${d.ath_multiple ? ` · ${d.ath_multiple}× ATH` : ''}</span></div>
				${d.quality_score != null ? meter(d.quality_score, scoreColor(d.quality_score)) : ''}
				${flags.length ? `<div class="awh-cop-chips">${flags.map((f) => `<span class="awh-cop-chip is-flag">${esc(String(f).replace(/_/g, ' '))}</span>`).join('')}</div>` : ''}
			</div>`;
		}
		if (d.kind === 'limits') {
			const row = (label, val) => `<div class="awh-cop-hold"><span class="awh-cop-hold-mint">${label}</span><span class="awh-cop-hold-amt">${val}</span></div>`;
			return `<div class="awh-cop-card">
				<div class="awh-cop-card-h"><span class="awh-cop-card-ic" aria-hidden="true">🛟</span> Risk limits</div>
				${row('Per-trade cap', d.per_trade_sol != null ? `${d.per_trade_sol} SOL` : '∞')}
				${row('Daily budget', d.daily_budget_sol != null ? `${d.daily_budget_sol} SOL` : '∞')}
				${row('Max price impact', d.max_price_impact_pct != null ? `${d.max_price_impact_pct}%` : '—')}
				${row('Kill switch', d.kill_switch ? '🔴 ON (halted)' : 'off')}
			</div>`;
		}
		return '';
	}

	function mountProposal(host, p) {
		if (p.kind === 'limits') return mountLimitsProposal(host, p);
		const isBuy = p.kind === 'buy';
		const q = p.quote && !p.quote.error ? p.quote : null;
		const impact = q?.price_impact_pct;
		const impactCls = impact == null ? '' : impact >= 15 ? 'impact-danger' : impact >= 5 ? 'impact-warn' : '';
		const coinName = p.coin?.symbol || p.coin?.name || short(p.mint, 4, 4);
		const blocked = p.safety?.verdict === 'block';
		const wrap = document.createElement('div');
		wrap.className = 'awh-cop-prop';
		wrap.innerHTML = `
			<div class="awh-cop-prop-h"><span class="awh-cop-prop-tag is-${p.kind}">${isBuy ? 'Buy' : 'Sell'}</span> ${esc(coinName)} <span style="color:var(--ink-dim,#888);font-weight:400;font-size:var(--text-sm,.764rem)">${esc(short(p.mint, 4, 4))}</span></div>
			<dl>
				<div class="awh-cop-qrow"><dt>${isBuy ? 'You pay' : 'You sell'}</dt><dd class="is-strong">${isBuy ? `◎${fmtSol(p.sol_amount)} SOL` : `${fmtTok(p.token_amount)} ${esc(p.coin?.symbol || 'tokens')}${p.token_pct ? ` (${Math.round(p.token_pct)}%)` : ''}`}</dd></div>
				<div class="awh-cop-qrow"><dt>Expected ${isBuy ? 'tokens' : 'proceeds'}</dt><dd class="is-strong">${q ? (isBuy ? `${fmtTok(q.expected_out)} ${esc(p.coin?.symbol || '')}` : `◎${fmtSol(q.expected_out)} SOL`) : '—'}</dd></div>
				<div class="awh-cop-qrow"><dt>Price impact</dt><dd class="${impactCls}">${impact != null ? `${impact.toFixed(2)}%` : (p.quote?.error ? 'unavailable' : '—')}</dd></div>
				<div class="awh-cop-qrow"><dt>Max slippage</dt><dd>${(p.slippage_bps / 100).toFixed(p.slippage_bps % 100 ? 1 : 0)}%</dd></div>
			</dl>
			${p.rationale ? `<div class="awh-cop-prop-why">“${esc(p.rationale)}”</div>` : ''}
			<div data-host="safety"></div>
			${blocked ? `<div class="awh-cop-prop-blocked"><span aria-hidden="true">⛔</span><span>The firewall blocked this buy${p.safety?.reasons?.[0] ? ` — ${esc(p.safety.reasons[0])}` : ''}. It can't be confirmed.</span></div>` : ''}
			<div class="awh-cop-prop-actions" data-host="actions"></div>
			<div data-host="result"></div>`;
		host.innerHTML = '';
		host.appendChild(wrap);

		// Firewall verdict (buy only) via the shared safety panel.
		if (isBuy && p.safety) {
			const sp = createSafetyPanel({ startExpanded: false });
			sp.applyVerdict(p.safety);
			wrap.querySelector('[data-host="safety"]').appendChild(sp.el);
			p._safetyPanel = sp;
		}

		const actions = wrap.querySelector('[data-host="actions"]');
		const result = wrap.querySelector('[data-host="result"]');
		if (p.executed) {
			actions.style.display = 'none';
			renderProposalResult(result, p);
			return;
		}
		if (blocked) { actions.style.display = 'none'; return; }
		actions.innerHTML = `
			<button class="awh-cop-prop-cancel" type="button" data-pa="cancel">Cancel</button>
			<button class="awh-cop-prop-confirm is-${p.kind}" type="button" data-pa="confirm">Confirm ${isBuy ? 'buy' : 'sell'}</button>`;
		actions.querySelector('[data-pa="cancel"]').addEventListener('click', () => {
			p.cancelled = true; actions.style.display = 'none';
			result.innerHTML = `<div class="awh-cop-prop-result">Cancelled — nothing was sent.</div>`;
		});
		actions.querySelector('[data-pa="confirm"]').addEventListener('click', () => confirmTrade(p, actions, result));
	}

	function mountLimitsProposal(host, p) {
		const labels = { per_trade_sol: 'Per-trade cap', daily_budget_sol: 'Daily budget', max_price_impact_pct: 'Max price impact', kill_switch: 'Kill switch (halt trading)' };
		const fmt = (k, v) => k === 'kill_switch' ? (v ? 'ON' : 'off') : k === 'max_price_impact_pct' ? `${v}%` : `${v} SOL`;
		const rows = Object.entries(p.changes).map(([k, v]) => `<div class="awh-cop-qrow"><dt>${esc(labels[k] || k)}</dt><dd class="is-strong">${esc(fmt(k, v))}</dd></div>`).join('');
		const wrap = document.createElement('div');
		wrap.className = 'awh-cop-prop';
		wrap.innerHTML = `
			<div class="awh-cop-prop-h"><span class="awh-cop-prop-tag is-limits">Risk limits</span> Update guardrails</div>
			<dl>${rows}</dl>
			${p.rationale ? `<div class="awh-cop-prop-why">“${esc(p.rationale)}”</div>` : ''}
			<div class="awh-cop-prop-actions" data-host="actions"></div>
			<div data-host="result"></div>`;
		host.innerHTML = '';
		host.appendChild(wrap);
		const actions = wrap.querySelector('[data-host="actions"]');
		const result = wrap.querySelector('[data-host="result"]');
		if (p.executed) { actions.style.display = 'none'; renderProposalResult(result, p); return; }
		actions.innerHTML = `
			<button class="awh-cop-prop-cancel" type="button" data-pa="cancel">Cancel</button>
			<button class="awh-cop-prop-confirm is-limits" type="button" data-pa="confirm">Apply limits</button>`;
		actions.querySelector('[data-pa="cancel"]').addEventListener('click', () => {
			p.cancelled = true; actions.style.display = 'none';
			result.innerHTML = `<div class="awh-cop-prop-result">Cancelled — limits unchanged.</div>`;
		});
		actions.querySelector('[data-pa="confirm"]').addEventListener('click', () => confirmLimits(p, actions, result));
	}

	function renderProposalResult(result, p) {
		if (p.error) { result.innerHTML = `<div class="awh-cop-prop-result is-err"><span aria-hidden="true">⚠</span><span>${esc(p.error)}</span></div>`; return; }
		const link = p.signature ? ` <a href="${esc(explorerTxUrl(p.signature, p.network))}" target="_blank" rel="noopener">View on Solscan ↗</a>` : '';
		result.innerHTML = `<div class="awh-cop-prop-result is-ok"><span aria-hidden="true">✓</span><span>${esc(p.successText || 'Done.')}${link}</span></div>`;
	}

	// ── confirm → guarded execution ─────────────────────────────────────────────
	async function confirmTrade(p, actions, result) {
		const btn = actions.querySelector('[data-pa="confirm"]');
		btn.disabled = true; btn.textContent = 'Submitting…';
		actions.querySelector('[data-pa="cancel"]').disabled = true;
		try {
			const network = p.network || getNetwork();
			const args = p.kind === 'buy'
				? { agentId, side: 'buy', mint: p.mint, solAmount: p.sol_amount, slippageBps: p.slippage_bps, network, idempotencyKey: newKey() }
				: { agentId, side: 'sell', mint: p.mint, tokenAmountRaw: uiToRaw(p.token_amount, p.decimals ?? 6), slippageBps: p.slippage_bps, network, idempotencyKey: newKey() };
			const data = await executeAgentTrade(args);
			p.executed = true;
			p.signature = data?.signature || null;
			p.network = network;
			if (p.kind === 'buy') p.successText = `Bought ${fmtTok(data?.out?.amount)} ${p.coin?.symbol || 'tokens'} for ◎${fmtSol(data?.in?.amount ?? p.sol_amount)} SOL.`;
			else p.successText = `Sold ${p.coin?.symbol || 'tokens'} for ◎${fmtSol(data?.out?.amount)} SOL.`;
			actions.style.display = 'none';
			renderProposalResult(result, p);
			logAction({ kind: p.kind, coin: p.coin?.symbol || short(p.mint, 4, 4), mint: p.mint, text: p.successText, signature: p.signature, network });
			toast(p.kind === 'buy' ? 'Buy confirmed' : 'Sell confirmed');
		} catch (e) {
			const msg = e instanceof TradeError ? e.message : (e?.message || 'The trade could not be completed.');
			p.error = msg;
			renderProposalResult(result, p);
			btn.disabled = false; btn.textContent = `Confirm ${p.kind === 'buy' ? 'buy' : 'sell'}`;
			actions.querySelector('[data-pa="cancel"]').disabled = false;
		}
	}

	async function confirmLimits(p, actions, result) {
		const btn = actions.querySelector('[data-pa="confirm"]');
		btn.disabled = true; btn.textContent = 'Applying…';
		actions.querySelector('[data-pa="cancel"]').disabled = true;
		try {
			// Send only the changed keys — setTradeLimits patches by key and
			// preserves the rest, so we never echo server-managed fields back.
			const headers = { 'Content-Type': 'application/json' };
			const token = await consumeCsrfToken();
			if (token) headers['x-csrf-token'] = token;
			const resp = await fetch(`/api/agents/${encodeURIComponent(agentId)}/trade/limits`, {
				method: 'PUT', credentials: 'include', headers, body: JSON.stringify(p.changes),
			});
			const j = await resp.json().catch(() => ({}));
			if (!resp.ok) throw new Error(j?.error_description || j?.error?.message || `Couldn't update limits (${resp.status})`);
			p.executed = true;
			p.successText = 'Risk limits updated.';
			actions.style.display = 'none';
			renderProposalResult(result, p);
			logAction({ kind: 'limits', text: describeLimits(p.changes) });
			toast('Limits updated');
		} catch (e) {
			p.error = e?.message || 'Could not update limits.';
			renderProposalResult(result, p);
			btn.disabled = false; btn.textContent = 'Apply limits';
			actions.querySelector('[data-pa="cancel"]').disabled = false;
		}
	}

	function describeLimits(changes) {
		const parts = [];
		if (changes.kill_switch != null) parts.push(`kill switch ${changes.kill_switch ? 'ON' : 'off'}`);
		if (changes.per_trade_sol != null) parts.push(`per-trade ${changes.per_trade_sol} SOL`);
		if (changes.daily_budget_sol != null) parts.push(`daily ${changes.daily_budget_sol} SOL`);
		if (changes.max_price_impact_pct != null) parts.push(`max impact ${changes.max_price_impact_pct}%`);
		return `Limits: ${parts.join(', ')}`;
	}

	function logAction(entry) {
		actionLog.unshift({ ...entry, at: Date.now() });
		renderLog();
		persist();
	}
	function renderLog() {
		if (!actionLog.length) { elLogWrap.hidden = true; return; }
		elLogWrap.hidden = false;
		elLogList.innerHTML = actionLog.map((a) => {
			const sideCls = a.kind === 'buy' ? 'is-buy' : a.kind === 'sell' ? 'is-sell' : 'is-limits';
			const label = a.kind === 'buy' ? 'Buy' : a.kind === 'sell' ? 'Sell' : 'Limits';
			const main = a.signature
				? `${esc(a.text)} <a href="${esc(explorerTxUrl(a.signature, a.network))}" target="_blank" rel="noopener">↗</a>`
				: esc(a.text);
			return `<li class="awh-cop-log-row"><span class="awh-cop-log-side ${sideCls}">${label}</span><span class="awh-cop-log-main">${main}</span></li>`;
		}).join('');
	}

	// ── conversation turn (SSE) ─────────────────────────────────────────────────
	function persist() { saveHistory(agentId, getNetwork(), messages, actionLog); }

	// Resolve a slash command. Returns { local } for a client-side action,
	// { send } for the text to actually send, or null when it's plain text.
	function resolveSlash(raw) {
		if (raw[0] !== '/') return null;
		const [word, ...rest] = raw.split(/\s+/);
		const def = SLASH_COMMANDS.find((c) => c.cmd === word.toLowerCase());
		if (!def) return null;
		if (def.local) return { local: def.local };
		const tail = rest.join(' ').trim();
		if (def.template) return { send: (def.template + tail).trim() };
		return { send: def.send };
	}

	function clearConversation() {
		if (streaming) currentTurn?.abort();
		messages.forEach((m) => (m.proposals || []).forEach((p) => p._safetyPanel?.destroy?.()));
		messages.length = 0;
		actionLog.length = 0;
		try { localStorage.removeItem(storageKey(agentId, getNetwork())); } catch { /* noop */ }
		elError.innerHTML = '';
		render();
		toast('Conversation cleared');
	}

	function showHelp() {
		messages.push({ role: 'user', content: '/help' });
		messages.push({ role: 'agent', streaming: false, tools: [], proposals: [], content:
			`**I'm ${agentName}, your trading copilot.** I read live data and prepare guarded trades you confirm — I never sign on my own.\n\n`
			+ `Ask me things like *"how's my portfolio?"*, *"is <mint> safe?"*, or *"buy 0.25 SOL of <mint>"*. Or use a slash command:\n\n`
			+ SLASH_COMMANDS.map((c) => `- \`${c.cmd}\` — ${c.desc}`).join('\n') });
		render();
		persist();
	}

	// Public entry: called from the composer, suggestion chips, and slash menu.
	async function sendMessage(text) {
		const raw = (text ?? elInput.value).trim();
		if (!raw || streaming) return;
		const slash = resolveSlash(raw);
		if (slash?.local === 'clear') { elInput.value = ''; autoSize(); hideSlash(); clearConversation(); return; }
		if (slash?.local === 'help') { elInput.value = ''; autoSize(); hideSlash(); showHelp(); return; }
		const content = slash?.send ?? raw;
		stopSpeaking();
		elInput.value = '';
		autoSize();
		hideSlash();
		elError.innerHTML = '';
		messages.push({ role: 'user', content });
		await runTurn(content);
	}

	// Run one copilot turn against the current message history (whose last entry
	// must be the user turn). Split out so Regenerate can re-run without appending
	// a duplicate user message.
	async function runTurn(retryText) {
		const agentMsg = { role: 'agent', content: '', tools: [], proposals: [], streaming: true };
		messages.push(agentMsg);
		streaming = true;
		setStatus('Thinking…');
		updateComposerMode();
		render();

		const payload = {
			network: getNetwork(),
			messages: messages
				.filter((m) => !(m.role === 'agent' && m.streaming && !m.content))
				.map((m) => ({ role: m.role === 'agent' ? 'assistant' : 'user', content: m.content }))
				.filter((m) => m.content),
		};

		const ctrl = new AbortController();
		currentTurn = ctrl;
		try {
			const resp = await fetch(`/api/agents/${encodeURIComponent(agentId)}/copilot`, {
				method: 'POST', credentials: 'include',
				headers: { 'Content-Type': 'application/json', accept: 'text/event-stream' },
				body: JSON.stringify(payload),
				signal: ctrl.signal,
			});
			if (!resp.ok || !resp.body) {
				const j = await resp.json().catch(() => ({}));
				throw new Error(j?.error_description || j?.error?.message || j?.message || `Copilot unavailable (${resp.status})`);
			}
			await consumeSse(resp.body, agentMsg, ctrl);
		} catch (e) {
			agentMsg.streaming = false;
			if (!agentMsg.content) agentMsg.error = true;
			if (!destroyed) {
				// A watchdog/destroy abort surfaces as an AbortError with no useful
				// message. A user-initiated Stop is a deliberate abort — say so quietly
				// instead of nagging with a Retry the owner didn't ask for.
				const stalled = ctrl.signal.aborted;
				if (stopped) { /* user pressed Stop — leave whatever streamed, no error */ }
				else showError(stalled ? 'The copilot stopped responding. Try again.' : (e?.message || 'The copilot hit an error.'), retryText || null);
			}
		} finally {
			stopped = false;
			if (currentTurn === ctrl) currentTurn = null;
			streaming = false;
			agentMsg.streaming = false;
			setStatus('');
			updateComposerMode();
			render();
			persist();
			if (voiceOut && agentMsg.content && !agentMsg.error) speak(agentMsg.content);
		}
	}

	// Regenerate: drop the last agent reply and re-run the preceding user turn.
	function regenerate() {
		if (streaming) return;
		const li = lastAgentIndex();
		if (li < 0) return;
		const prevUser = messages.slice(0, li).reverse().find((m) => m.role === 'user');
		if (!prevUser) return;
		messages.splice(li, 1);
		render();
		runTurn(prevUser.content);
	}

	// Stop the in-flight turn on the owner's request (keeps whatever streamed).
	function stopTurn() {
		if (!streaming) return;
		stopped = true;
		currentTurn?.abort();
	}

	async function consumeSse(stream, agentMsg, ctrl) {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buf = '';
		// Stall watchdog: if the stream goes silent past the heartbeat interval, the
		// connection is dead — abort so the turn fails cleanly into a Retry instead
		// of hanging on the typing indicator forever.
		let stall = null;
		const arm = () => { if (stall) clearTimeout(stall); stall = setTimeout(() => ctrl.abort(), STREAM_STALL_MS); };
		try {
			arm();
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				if (destroyed) { reader.cancel().catch(() => {}); break; }
				arm(); // fresh bytes (data or heartbeat) ⇒ stream is alive
				buf += decoder.decode(value, { stream: true });
				let sep;
				while ((sep = buf.indexOf('\n\n')) >= 0) {
					const block = buf.slice(0, sep);
					buf = buf.slice(sep + 2);
					let event = 'message', data = '';
					for (const line of block.split('\n')) {
						if (line.startsWith('event:')) event = line.slice(6).trim();
						else if (line.startsWith('data:')) data += line.slice(5).trim();
					}
					if (!data) continue;
					let payload;
					try { payload = JSON.parse(data); } catch { continue; }
					handleSseEvent(event, payload, agentMsg);
				}
			}
		} finally {
			if (stall) clearTimeout(stall);
		}
	}

	function handleSseEvent(event, payload, agentMsg) {
		if (event === 'status') {
			setStatus(payload.phase === 'finalizing' ? 'Summarizing…' : payload.phase === 'continuing' ? 'Analyzing…' : 'Thinking…');
		} else if (event === 'tool') {
			agentMsg.tools.push({ name: payload.name, summary: payload.summary || payload.name, data: payload.data || null });
			setStatus(payload.summary || 'Reading live data…');
			render();
		} else if (event === 'proposal') {
			agentMsg.proposals.push(normalizeProposal(payload));
			render();
		} else if (event === 'chunk') {
			agentMsg.content += payload.text || '';
			render();
		} else if (event === 'done') {
			agentMsg.streaming = false;
			if (payload.reply && !agentMsg.content) agentMsg.content = payload.reply;
			render();
		} else if (event === 'error') {
			agentMsg.streaming = false;
			if (!agentMsg.content) { agentMsg.error = true; showError(payload.message || 'Copilot error', null); }
		}
	}

	function normalizeProposal(p) {
		return { ...p }; // already structured by the server; cards read fields directly
	}

	function showError(msg, retryText) {
		elError.innerHTML = `<div class="awh-cop-error" role="alert"><span aria-hidden="true">⚠</span><span>${esc(msg)}</span>${retryText ? ' <button type="button" data-act="retry">Retry</button>' : ''}</div>`;
		const r = elError.querySelector('[data-act="retry"]');
		// Retry re-runs the last user turn in place (regenerate drops the errored
		// reply) rather than appending a duplicate user message.
		if (r) r.addEventListener('click', () => { elError.innerHTML = ''; regenerate(); });
	}

	// ── voice in (SpeechRecognition) ────────────────────────────────────────────
	function micSupported() { return typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition); }
	function toggleMic() {
		if (!micSupported()) { toast('Voice input is not supported in this browser.'); return; }
		if (listening) { stopListening(); return; }
		const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
		recognition = new Rec();
		recognition.lang = navigator.language || 'en-US';
		recognition.interimResults = true;
		recognition.continuous = false;
		let finalText = '';
		recognition.onresult = (e) => {
			let interim = '';
			for (let i = e.resultIndex; i < e.results.length; i++) {
				const tr = e.results[i][0].transcript;
				if (e.results[i].isFinal) finalText += tr; else interim += tr;
			}
			elInput.value = (finalText + interim).trim();
			autoSize();
		};
		recognition.onerror = () => { stopListening(); };
		recognition.onend = () => {
			const had = listening;
			stopListening();
			if (had && elInput.value.trim()) sendMessage();
		};
		try { recognition.start(); listening = true; updateMic(); setStatus('Listening…'); }
		catch { stopListening(); }
	}
	function stopListening() {
		listening = false;
		try { recognition?.stop(); } catch { /* already stopped */ }
		recognition = null;
		updateMic();
		if (!streaming) setStatus('');
	}
	function updateMic() {
		const mic = panel.querySelector('[data-act="mic"]');
		if (!mic) return;
		mic.classList.toggle('is-listening', listening);
		mic.setAttribute('aria-label', listening ? 'Stop listening' : 'Talk to the copilot');
	}

	// ── voice out (agent voice → TTS, browser fallback) ─────────────────────────
	async function ensureVoiceConfig() {
		if (voiceConfig !== null) return voiceConfig;
		try {
			const r = await fetch(`/api/agents/${encodeURIComponent(agentId)}/voice`, { credentials: 'include' });
			if (r.ok) {
				const j = await r.json();
				const d = j?.data || j;
				voiceConfig = { provider: d?.voice_provider || 'browser', voiceId: d?.voice_id || null };
			} else voiceConfig = { provider: 'browser', voiceId: null };
		} catch { voiceConfig = { provider: 'browser', voiceId: null }; }
		return voiceConfig;
	}
	function stopSpeaking() {
		if (currentAudio) { try { currentAudio.pause(); } catch { /* noop */ } currentAudio = null; }
		if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel();
	}
	async function speak(text) {
		stopSpeaking();
		const clean = text.replace(/\s+/g, ' ').trim().slice(0, 1200);
		if (!clean) return;
		const cfg = await ensureVoiceConfig();
		// Real server TTS first (agent's cloned voice if any), browser fallback.
		try {
			let resp;
			if (cfg.provider === 'elevenlabs' && cfg.voiceId) {
				// agentId names the agent whose voice this is, so the proxy can
				// serve the clip on its owner's saved ElevenLabs key (BYOK). Without
				// it an owner-cloned voice is unreachable here and silently degrades
				// to browser speech.
				resp = await fetch('/api/tts/eleven', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voiceId: cfg.voiceId, text: clean, agentId }) });
			} else {
				resp = await fetch('/api/tts/speak', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: clean, format: 'mp3' }) });
			}
			if (resp.ok) {
				const blob = await resp.blob();
				const url = URL.createObjectURL(blob);
				const audio = new Audio(url);
				currentAudio = audio;
				audio.onended = () => { URL.revokeObjectURL(url); if (currentAudio === audio) currentAudio = null; };
				await audio.play();
				return;
			}
		} catch { /* fall through to browser speech */ }
		if (typeof window !== 'undefined' && window.speechSynthesis) {
			const u = new SpeechSynthesisUtterance(clean);
			window.speechSynthesis.speak(u);
		}
	}
	function toggleVoiceOut() {
		voiceOut = !voiceOut;
		const b = panel.querySelector('[data-act="voiceout"]');
		if (b) b.setAttribute('aria-pressed', String(voiceOut));
		if (voiceOut) ensureVoiceConfig(); else stopSpeaking();
		toast(voiceOut ? 'Replies will be spoken' : 'Voice replies off');
	}

	// ── composer + events ───────────────────────────────────────────────────────
	function autoSize() {
		elInput.style.height = 'auto';
		elInput.style.height = `${Math.min(120, elInput.scrollHeight)}px`;
	}
	// The intro (with its suggestion chips) is rendered once and only toggled
	// hidden, so its buttons are bound a single time at mount — never per render.
	function wireIntroEvents() {
		panel.querySelectorAll('[data-suggest]').forEach((b) => b.addEventListener('click', () => sendMessage(SUGGESTIONS[Number(b.dataset.suggest)])));
	}

	// The send button doubles as Stop while a turn streams.
	function updateComposerMode() {
		if (!elSend) return;
		elSend.classList.toggle('is-stop', streaming);
		elSend.textContent = streaming ? '■' : '➤';
		elSend.setAttribute('aria-label', streaming ? 'Stop generating' : 'Send message');
		elSend.title = streaming ? 'Stop' : 'Send';
	}

	// ── slash-command menu ──────────────────────────────────────────────────────
	function slashMatches() {
		const v = elInput.value;
		if (v[0] !== '/' || /\s/.test(v)) return []; // only while typing the command word
		const q = v.toLowerCase();
		return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(q));
	}
	function renderSlash() {
		const matches = slashMatches();
		if (!matches.length) { hideSlash(); return; }
		if (slashIdx < 0 || slashIdx >= matches.length) slashIdx = 0;
		elSlash.hidden = false;
		elSlash.innerHTML = matches.map((c, i) => `<div class="awh-cop-slash-item" role="option" data-slash="${esc(c.cmd)}" aria-selected="${i === slashIdx}"><span class="awh-cop-slash-cmd">${esc(c.cmd)}</span><span class="awh-cop-slash-desc">${esc(c.desc)}</span></div>`).join('');
		elSlash.querySelectorAll('[data-slash]').forEach((el) => el.addEventListener('mousedown', (e) => { e.preventDefault(); pickSlash(el.dataset.slash); }));
	}
	function hideSlash() { elSlash.hidden = true; slashIdx = -1; }
	function pickSlash(cmd) {
		const def = SLASH_COMMANDS.find((c) => c.cmd === cmd);
		if (!def) return;
		if (def.template) { elInput.value = def.cmd + ' '; hideSlash(); autoSize(); elInput.focus(); return; }
		sendMessage(def.cmd);
	}
	function slashKeydown(e) {
		if (elSlash.hidden) return false;
		const matches = slashMatches();
		if (!matches.length) return false;
		if (e.key === 'ArrowDown') { e.preventDefault(); slashIdx = (slashIdx + 1) % matches.length; renderSlash(); return true; }
		if (e.key === 'ArrowUp') { e.preventDefault(); slashIdx = (slashIdx - 1 + matches.length) % matches.length; renderSlash(); return true; }
		if (e.key === 'Escape') { e.preventDefault(); hideSlash(); return true; }
		if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSlash(matches[Math.max(0, slashIdx)].cmd); return true; }
		return false;
	}

	elSend.addEventListener('click', () => { if (streaming) stopTurn(); else sendMessage(); });
	panel.querySelector('[data-act="mic"]').addEventListener('click', toggleMic);
	panel.querySelector('[data-act="voiceout"]').addEventListener('click', toggleVoiceOut);
	if (!micSupported()) {
		const mic = panel.querySelector('[data-act="mic"]');
		mic.disabled = true; mic.title = 'Voice input not supported in this browser';
	}
	elInput.addEventListener('input', () => { autoSize(); renderSlash(); });
	elInput.addEventListener('blur', () => setTimeout(hideSlash, 120));
	elInput.addEventListener('keydown', (e) => {
		if (slashKeydown(e)) return;
		if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
	});

	// Per-message actions (copy / regenerate) via delegation — survives re-render.
	elThread.addEventListener('click', (e) => {
		const act = e.target.closest('[data-msgact]');
		if (!act) return;
		if (act.dataset.msgact === 'regen') { regenerate(); return; }
		if (act.dataset.msgact === 'copy') {
			const m = messages[Number(act.dataset.mi)];
			if (!m?.content) return;
			navigator.clipboard?.writeText(m.content).then(() => {
				act.classList.add('is-done'); const t = act.textContent; act.textContent = '✓ Copied';
				setTimeout(() => { act.classList.remove('is-done'); act.textContent = t; }, 1400);
			}).catch(() => toast('Copy failed'));
		}
	});

	wireIntroEvents();
	updateComposerMode();
	if (messages.length) render(); // paint restored history

	if (onNetworkChange) {
		detachNet = onNetworkChange(() => { /* network is read live per turn; nothing to reset */ });
	}

	return {
		onShow() { elInput?.focus(); },
		onHide() { stopListening(); stopSpeaking(); },
		destroy() {
			destroyed = true;
			currentTurn?.abort();
			stopListening();
			stopSpeaking();
			messages.forEach((m) => (m.proposals || []).forEach((p) => p._safetyPanel?.destroy?.()));
			detachNet?.();
		},
	};
}
