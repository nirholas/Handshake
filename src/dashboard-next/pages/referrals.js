// dashboard-next — Referrals.
//
// A 3D, flippable membership card (the centrepiece) plus the referral link,
// share actions, and live referral stats. Front shows the member's standing;
// back shows a scannable QR for the referral link. Every number is real,
// pulled from /api/users/referrals — no placeholders.

import { mountShell } from '../shell.js';
import { requireUser, get, put, esc } from '../api.js';
import { renderQRToSVG, renderQRToCanvas } from '../../erc8004/qr.js';
import { toast } from '../../shared/toast.js';

const MONO = `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`;

// Canonical referral-code shape — mirrors REFERRAL_CODE_RE in
// api/_lib/referrals.js. The server is authoritative; this gates the editor's
// Save button and pre-filters obviously-invalid input before the availability
// check fires.
const CODE_MIN = 3;
const CODE_MAX = 20;
const CODE_RE = new RegExp(`^[A-Z0-9]{${CODE_MIN},${CODE_MAX}}$`);

// Referral commission paid to the referrer on each purchase. Mirrors the
// server default (REFERRAL_COMMISSION_BPS in api/_lib/purchase-confirm.js).
const REFERRAL_PCT = 5;

// ── small utilities ─────────────────────────────────────────────────────────


async function copyToClipboard(text) {
	try {
		await navigator.clipboard.writeText(text);
		toast('Copied');
		return true;
	} catch {
		const t = document.createElement('textarea');
		t.value = text;
		t.style.position = 'fixed';
		t.style.opacity = '0';
		document.body.appendChild(t);
		t.select();
		let ok = false;
		try { ok = document.execCommand('copy'); } catch { ok = false; }
		document.body.removeChild(t);
		toast(ok ? 'Copied' : 'Copy failed');
		return ok;
	}
}

function fmtInt(n) {
	return Number(n || 0).toLocaleString('en-US');
}

function fmtUsd(n) {
	return Number(n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/** "06/27" — two years out, the card's notional validity. */
function expLabel(memberSince) {
	const base = memberSince ? new Date(memberSince) : new Date();
	const exp = new Date(base.getTime());
	exp.setFullYear(exp.getFullYear() + 2);
	const mm = String(exp.getMonth() + 1).padStart(2, '0');
	const yy = String(exp.getFullYear()).slice(-2);
	return `${mm}/${yy}`;
}

function memberSinceLabel(memberSince) {
	if (!memberSince) return '—';
	const d = new Date(memberSince);
	if (Number.isNaN(d.getTime())) return '—';
	return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/** "Jun 21, 2026" — full signup date for the referrals table. */
function fmtDate(value) {
	if (!value) return '—';
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return '—';
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Privacy-preserving display for a referred user with no public username. */
function maskedHandle(item) {
	if (item.display_name) return item.display_name;
	if (item.username) return `@${item.username}`;
	return 'Anonymous member';
}

// Referred-user list pagination size. Matches the server default so the first
// page is a single request with no over-fetch.
const REF_PAGE_SIZE = 20;

// ── styles (scoped, injected once) ──────────────────────────────────────────

function injectStyles() {
	if (document.getElementById('ref-card-styles')) return;
	const s = document.createElement('style');
	s.id = 'ref-card-styles';
	s.textContent = `
	.ref-wrap{max-width:980px}
	.ref-stage{display:flex;gap:18px;align-items:center;justify-content:center;flex-wrap:wrap}
	.ref-perspective{perspective:1400px;width:100%;max-width:460px;flex:1 1 360px;min-width:300px}
	.ref-card{
		position:relative;width:100%;aspect-ratio:1.74/1;
		transform-style:preserve-3d;transition:transform .7s cubic-bezier(.22,.61,.36,1);
		will-change:transform;cursor:grab;
	}
	.ref-card:active{cursor:grabbing}
	.ref-face{
		position:absolute;inset:0;border-radius:20px;overflow:hidden;
		-webkit-backface-visibility:hidden;backface-visibility:hidden;
		box-shadow:0 26px 60px -22px rgba(60,30,140,0.7), 0 2px 0 rgba(255,255,255,0.06) inset;
		border:1px solid rgba(167,139,250,0.28);
		padding:clamp(16px,4.4%,22px);display:flex;flex-direction:column;color:#fff;
	}
	.ref-face.front{
		background:
			radial-gradient(120% 140% at 88% 6%, rgba(167,139,250,0.42), transparent 52%),
			radial-gradient(90% 120% at 0% 100%, rgba(86,52,170,0.5), transparent 60%),
			linear-gradient(135deg,#181230 0%,#241a4d 52%,#3a2680 100%);
	}
	.ref-face.back{
		transform:rotateY(180deg);
		background:
			radial-gradient(120% 130% at 12% 8%, rgba(167,139,250,0.34), transparent 55%),
			linear-gradient(150deg,#15102a 0%,#221a44 60%,#2f2160 100%);
	}
	.ref-sheen{position:absolute;inset:0;pointer-events:none;
		background:linear-gradient(105deg,transparent 38%,rgba(255,255,255,0.10) 48%,transparent 58%);
		mix-blend-mode:screen;opacity:.7}
	.ref-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
	.ref-brand{display:flex;align-items:center;gap:8px;font-weight:700;letter-spacing:-0.01em;font-size:15px}
	.ref-brand img{width:20px;height:20px;border-radius:5px;display:block}
	.ref-chip{width:30px;height:22px;border-radius:5px;
		background:linear-gradient(135deg,#e8d9a0,#b8932f);position:relative;opacity:.9;flex-shrink:0}
	.ref-chip::before,.ref-chip::after{content:"";position:absolute;left:18%;right:18%;height:1px;background:rgba(0,0,0,.32)}
	.ref-chip::before{top:38%}.ref-chip::after{top:62%}
	.ref-qr{background:#fff;border-radius:9px;padding:6px;line-height:0;box-shadow:0 4px 14px rgba(0,0,0,.3)}
	.ref-qr svg{display:block;width:100%;height:100%}
	.ref-scan{font-size:11px;color:rgba(255,255,255,.62);letter-spacing:.02em}
	.ref-scan b{display:block;color:rgba(255,255,255,.92);font-size:12px;font-weight:600;letter-spacing:0}
	.ref-divider{height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.18),transparent);margin:auto 0 0}
	.ref-stats{display:flex;gap:12px;justify-content:space-between}
	.ref-stat-k{font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.5);margin-bottom:3px}
	.ref-stat-v{font-size:19px;font-weight:700;font-family:${MONO};line-height:1}
	.ref-stat-v.accent{color:#c4b5fd}
	.ref-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;
		font-family:${MONO};font-size:10.5px;color:rgba(255,255,255,.5)}
	.ref-meta b{color:rgba(255,255,255,.82);font-weight:600}
	.ref-name{font-size:clamp(20px,5.5%,26px);font-weight:700;letter-spacing:-0.01em;line-height:1}
	.ref-strip{display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.06);
		border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:9px 12px;font-size:12px;color:rgba(255,255,255,.86)}
	.ref-strip svg{flex-shrink:0}
	.ref-rail{display:flex;flex-direction:column;gap:10px;flex:0 0 auto}
	.ref-rail-btn{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;
		background:rgba(255,255,255,.05);border:1px solid var(--nxt-stroke-strong);color:var(--nxt-ink);
		cursor:pointer;transition:transform .14s ease,background .14s ease,border-color .14s ease,box-shadow .14s ease;position:relative}
	.ref-rail-btn:hover{background:rgba(167,139,250,.16);border-color:rgba(167,139,250,.5);transform:translateY(-1px)}
	.ref-rail-btn:active{transform:translateY(0) scale(.95)}
	.ref-rail-btn:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(167,139,250,.4)}
	.ref-rail-btn svg{width:18px;height:18px}
	.ref-rail-btn[data-active="true"]{background:rgba(167,139,250,.22);border-color:rgba(167,139,250,.6)}
	.ref-tip{position:absolute;right:54px;top:50%;transform:translateY(-50%) translateX(4px);
		background:rgba(20,21,28,.96);border:1px solid var(--nxt-stroke-strong);color:var(--nxt-ink);
		font-size:12px;padding:5px 9px;border-radius:7px;white-space:nowrap;opacity:0;pointer-events:none;
		transition:opacity .14s ease,transform .14s ease;box-shadow:0 6px 18px rgba(0,0,0,.4)}
	.ref-rail-btn:hover .ref-tip,.ref-rail-btn:focus-visible .ref-tip{opacity:1;transform:translateY(-50%) translateX(0)}
	.ref-linkbar{display:flex;gap:8px;align-items:stretch;flex-wrap:wrap}
	.ref-linkbar input{flex:1;min-width:200px;background:rgba(255,255,255,.04);border:1px solid var(--nxt-stroke-strong);
		border-radius:9px;padding:11px 13px;color:var(--nxt-ink);font-family:${MONO};font-size:13px}
	/* ── referral code editor ─────────────────────────────────────────────── */
	.ref-codebox{margin-top:12px;border:1px solid var(--nxt-stroke);border-radius:var(--nxt-radius-sm,12px);
		background:rgba(255,255,255,.015);padding:14px 16px}
	.ref-code-display{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
	.ref-code-meta{min-width:0}
	.ref-code-label{font-size:11px;color:var(--nxt-ink-fade);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px}
	.ref-code-value{font-family:${MONO};font-size:19px;font-weight:700;color:var(--nxt-ink);letter-spacing:.02em;
		word-break:break-all}
	.ref-code-cta{display:flex;gap:8px;flex:0 0 auto}
	.ref-code-inputwrap{display:flex;align-items:center;gap:0;border:1px solid var(--nxt-stroke-strong);
		border-radius:10px;background:rgba(255,255,255,.04);overflow:hidden;
		transition:border-color .14s ease,box-shadow .14s ease}
	.ref-code-inputwrap:focus-within{border-color:rgba(167,139,250,.6);box-shadow:0 0 0 3px rgba(167,139,250,.18)}
	.ref-code-prefix{padding:0 4px 0 12px;color:var(--nxt-ink-fade);font-family:${MONO};font-size:13px;white-space:nowrap;user-select:none}
	.ref-code-input{flex:1;min-width:80px;background:transparent;border:0;outline:none;color:var(--nxt-ink);
		font-family:${MONO};font-size:15px;font-weight:600;letter-spacing:.04em;padding:11px 8px 11px 0;text-transform:uppercase}
	.ref-code-status{flex:0 0 auto;display:grid;place-items:center;width:34px;height:100%;align-self:stretch}
	.ref-code-status.good{color:#86efac}
	.ref-code-status.bad{color:#fca5a5}
	.ref-code-status.checking{color:var(--nxt-ink-fade)}
	.ref-code-hint{margin-top:8px;font-size:12.5px;color:var(--nxt-ink-dim);line-height:1.45;min-height:1.2em}
	.ref-code-hint.good{color:#86efac}
	.ref-code-hint.bad{color:#fca5a5}
	.ref-code-actions{display:flex;gap:8px;margin-top:12px}
	.ref-spin{animation:ref-spin .7s linear infinite;transform-origin:center}
	@keyframes ref-spin{to{transform:rotate(360deg)}}
	@media (prefers-reduced-motion: reduce){.ref-spin{animation:none}}
	.ref-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
	.ref-tile{border:1px solid var(--nxt-stroke);border-radius:var(--nxt-radius-sm,12px);padding:14px 16px;background:rgba(255,255,255,.015)}
	.ref-tile-k{font-size:11.5px;color:var(--nxt-ink-fade);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
	.ref-tile-v{font-size:24px;font-weight:700;letter-spacing:-0.01em;font-family:${MONO}}
	.ref-tile-v small{font-size:13px;color:var(--nxt-ink-fade);font-weight:500;font-family:inherit}
	.ref-steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
	.ref-step{display:flex;gap:12px;align-items:flex-start}
	.ref-step-n{flex:0 0 auto;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;
		background:rgba(167,139,250,.16);border:1px solid rgba(167,139,250,.4);color:#c4b5fd;font-size:12.5px;font-weight:700;font-family:${MONO}}
	.ref-step h4{margin:0 0 3px;font-size:13.5px;color:var(--nxt-ink)}
	.ref-step p{margin:0;font-size:12.5px;color:var(--nxt-ink-dim);line-height:1.45}
	.ref-card-skel{width:100%;aspect-ratio:1.74/1;border-radius:20px;
		background:linear-gradient(135deg,#1a1336,#2a1f52);border:1px solid var(--nxt-stroke);
		position:relative;overflow:hidden}
	.ref-card-skel::after{content:"";position:absolute;inset:0;
		background:linear-gradient(90deg,transparent,rgba(255,255,255,.07),transparent);
		transform:translateX(-100%);animation:ref-shim 1.4s infinite}
	@keyframes ref-shim{100%{transform:translateX(100%)}}
	@media (prefers-reduced-motion: reduce){
		.ref-card{transition:none}
		.ref-card-skel::after{animation:none}
	}
	@media (max-width:560px){
		.ref-stage{flex-direction:column-reverse}
		.ref-rail{flex-direction:row;flex-wrap:wrap;justify-content:center}
		.ref-tip{display:none}
	}

	/* ── referred-users table ───────────────────────────────────────────── */
	.ref-list-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}
	.ref-list-count{font-size:12.5px;color:var(--nxt-ink-fade);font-family:${MONO}}
	.ref-tablewrap{overflow-x:auto;border:1px solid var(--nxt-stroke);border-radius:var(--nxt-radius-sm,12px);background:rgba(255,255,255,.012)}
	.ref-table{width:100%;border-collapse:collapse;font-size:13.5px;min-width:520px}
	.ref-table thead th{
		text-align:left;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;
		color:var(--nxt-ink-fade);font-weight:600;padding:11px 16px;
		border-bottom:1px solid var(--nxt-stroke);white-space:nowrap;background:rgba(255,255,255,.02)}
	.ref-table thead th.num,.ref-table tbody td.num{text-align:right;font-family:${MONO}}
	.ref-table tbody td{padding:13px 16px;border-bottom:1px solid var(--nxt-stroke);color:var(--nxt-ink);vertical-align:middle}
	.ref-table tbody tr:last-child td{border-bottom:none}
	.ref-table tbody tr{transition:background .12s ease}
	.ref-table tbody tr:hover{background:rgba(167,139,250,.06)}
	.ref-table tbody tr:focus-within{background:rgba(167,139,250,.08)}
	.ref-user{display:flex;align-items:center;gap:10px;min-width:0}
	.ref-avatar{flex:0 0 auto;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;
		background:linear-gradient(135deg,#3a2680,#241a4d);color:#c4b5fd;font-size:12px;font-weight:700;font-family:${MONO};
		border:1px solid rgba(167,139,250,.3)}
	.ref-user-name{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px}
	.ref-table .ref-commission{color:#86efac;font-weight:600}
	.ref-table .ref-zero{color:var(--nxt-ink-fade)}
	.ref-pager{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:14px}
	.ref-pager-info{font-size:12.5px;color:var(--nxt-ink-fade);font-family:${MONO};margin-right:auto}
	.ref-pgbtn{display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,.04);
		border:1px solid var(--nxt-stroke-strong);border-radius:9px;padding:7px 13px;color:var(--nxt-ink);
		font-size:13px;cursor:pointer;transition:background .12s ease,border-color .12s ease,transform .1s ease}
	.ref-pgbtn:hover:not(:disabled){background:rgba(167,139,250,.16);border-color:rgba(167,139,250,.5)}
	.ref-pgbtn:active:not(:disabled){transform:translateY(1px)}
	.ref-pgbtn:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(167,139,250,.4)}
	.ref-pgbtn:disabled{opacity:.4;cursor:not-allowed}
	.ref-empty{padding:36px 24px;text-align:center}
	.ref-empty svg{opacity:.5;margin-bottom:12px}
	.ref-empty h4{margin:0 0 6px;font-size:15px;color:var(--nxt-ink)}
	.ref-empty p{margin:0 0 16px;font-size:13px;color:var(--nxt-ink-dim);line-height:1.5;max-width:340px;margin-left:auto;margin-right:auto}
	.ref-skel-row td{padding:13px 16px;border-bottom:1px solid var(--nxt-stroke)}
	.ref-skel-bar{height:12px;border-radius:6px;background:linear-gradient(90deg,rgba(255,255,255,.05),rgba(255,255,255,.1),rgba(255,255,255,.05));
		background-size:200% 100%;animation:ref-shim2 1.4s infinite}
	@keyframes ref-shim2{0%{background-position:200% 0}100%{background-position:-200% 0}}
	@media (prefers-reduced-motion: reduce){.ref-skel-bar{animation:none}}
	@media (max-width:560px){
		.ref-pager{flex-wrap:wrap}
		.ref-pager-info{width:100%;margin-bottom:6px}
	}

	/* ── membership tier ─────────────────────────────────────────────────── */
	.ref-tier-pill{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;
		letter-spacing:.01em;padding:4px 9px 4px 8px;border-radius:999px;line-height:1;white-space:nowrap;
		background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.22);color:#fff;
		backdrop-filter:blur(4px)}
	.ref-tier-pill .ref-tier-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;
		box-shadow:0 0 6px 1px currentColor}
	.ref-tier-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:6px}
	.ref-tier-badge{display:inline-flex;align-items:center;gap:8px;padding:7px 14px;border-radius:999px;
		font-size:14px;font-weight:700;letter-spacing:-0.01em;border:1px solid}
	.ref-tier-badge .ref-tier-dot{width:9px;height:9px;border-radius:50%;box-shadow:0 0 8px 1px currentColor}
	.ref-tier-desc{font-size:13px;color:var(--nxt-ink-dim);line-height:1.55;margin:0 0 16px;max-width:62ch}
	.ref-tier-badges{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}
	.ref-tier-chip{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:600;
		padding:5px 11px;border-radius:999px;background:rgba(255,255,255,.04);border:1px solid var(--nxt-stroke-strong);color:var(--nxt-ink)}
	.ref-tier-chip .ref-tier-dot{width:7px;height:7px;border-radius:50%;box-shadow:0 0 6px 1px currentColor}
	.ref-tier-ladder{display:flex;flex-direction:column;gap:2px}
	.ref-tier-rung{display:flex;align-items:center;gap:13px;padding:12px 14px;border-radius:12px;
		border:1px solid transparent;transition:background .14s ease,border-color .14s ease}
	.ref-tier-rung[data-active="true"]{background:rgba(167,139,250,.07);border-color:rgba(167,139,250,.22)}
	.ref-tier-rung[data-active="false"]{opacity:.72}
	.ref-tier-rung:hover{background:rgba(255,255,255,.03)}
	.ref-tier-marker{flex:0 0 auto;width:34px;height:34px;border-radius:9px;display:grid;place-items:center;
		border:1px solid;font-size:13px;font-weight:700;font-family:${MONO}}
	.ref-tier-rung-body{flex:1;min-width:0}
	.ref-tier-rung-title{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;color:var(--nxt-ink)}
	.ref-tier-rung-tag{font-size:11px;color:var(--nxt-ink-fade);font-weight:500;text-transform:uppercase;letter-spacing:.05em}
	.ref-tier-rung-desc{font-size:12.5px;color:var(--nxt-ink-dim);line-height:1.45;margin-top:3px}
	.ref-tier-status{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;
		padding:4px 10px;border-radius:999px;white-space:nowrap}
	.ref-tier-status.active{background:rgba(134,239,172,.12);color:#86efac;border:1px solid rgba(134,239,172,.3)}
	.ref-tier-status.locked{background:rgba(255,255,255,.04);color:var(--nxt-ink-fade);border:1px solid var(--nxt-stroke-strong)}
	a.ref-tier-status.locked:hover{background:rgba(167,139,250,.16);color:#c4b5fd;border-color:rgba(167,139,250,.5)}
	.ref-tier-next{margin-top:16px;display:flex;align-items:center;gap:12px;padding:13px 16px;border-radius:12px;
		background:rgba(167,139,250,.08);border:1px solid rgba(167,139,250,.25)}
	.ref-tier-next svg{flex:0 0 auto;color:#c4b5fd}
	.ref-tier-next-body{flex:1;min-width:0;font-size:13px;color:var(--nxt-ink);line-height:1.45}
	.ref-tier-next-body b{color:#c4b5fd}
	@media (max-width:560px){
		.ref-tier-rung{flex-wrap:wrap}
		.ref-tier-status{margin-left:47px}
	}
	`;
	document.head.appendChild(s);
}

// ── card faces ───────────────────────────────────────────────────────────────

function frontFace(card, refUrl) {
	const qr = renderQRToSVG(refUrl, { scale: 3, margin: 1, dark: '#1a1336', light: '#ffffff' });
	return `
		<div class="ref-face front" data-face="front">
			<div class="ref-sheen"></div>
			<div class="ref-row">
				<div class="ref-brand"><img loading="lazy" decoding="async" src="/favicon.ico" alt="" />three.ws</div>
				<div class="ref-chip" aria-hidden="true"></div>
			</div>
			<div class="ref-row" style="margin-top:14px;align-items:flex-start;gap:14px">
				<div class="ref-qr" style="width:64px;height:64px">${qr}</div>
				<div class="ref-scan" style="margin-top:6px"><b>Scan to join</b>three.ws referral</div>
			</div>
			<div class="ref-divider" style="margin-top:14px"></div>
			<div class="ref-stats" style="margin-top:12px">
				<div><div class="ref-stat-k">Position</div><div class="ref-stat-v accent">#${fmtInt(card.position)}</div></div>
				<div><div class="ref-stat-k">Referrals</div><div class="ref-stat-v">${fmtInt(card.referred_users_count)}</div></div>
				<div><div class="ref-stat-k">Score</div><div class="ref-stat-v">${fmtInt(card.score)}</div></div>
			</div>
			<div class="ref-meta" style="margin-top:10px">
				<span>EXP <b>${esc(expLabel(card.member_since))}</b> &nbsp; Member since ${esc(memberSinceLabel(card.member_since))}</span>
				<span>#${String(card.position).padStart(6, '0')}</span>
			</div>
			<div class="ref-name" style="margin-top:10px;display:flex;align-items:center;justify-content:space-between;gap:10px">
				<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(card.display_name || 'Member')}</span>
				<span class="ref-tier-pill" data-tier-pill hidden></span>
			</div>
		</div>`;
}

function backFace(card, refUrl) {
	const qr = renderQRToSVG(refUrl, { scale: 4, margin: 1, dark: '#1a1336', light: '#ffffff' });
	const shortUrl = refUrl.replace(/^https?:\/\//, '');
	return `
		<div class="ref-face back" data-face="back">
			<div class="ref-sheen"></div>
			<div style="display:flex;gap:16px;align-items:center;flex:1">
				<div class="ref-qr" style="width:108px;height:108px;flex:0 0 auto">${qr}</div>
				<div>
					<div class="ref-scan"><b style="font-size:14px">Scan to join</b></div>
					<div style="font-family:${MONO};font-size:11px;color:rgba(255,255,255,.6);margin-top:4px;word-break:break-all">${esc(shortUrl)}</div>
				</div>
			</div>
			<div class="ref-strip" style="margin-top:12px">
				<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="#c4b5fd" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7"/><path d="M10 6.5v7M7.8 8.2h3a1.4 1.4 0 010 2.8H8.2a1.4 1.4 0 000 2.8h3"/></svg>
				Earn <b style="color:#fff">${REFERRAL_PCT}%</b> on every referral purchase — paid in USDC
			</div>
			<div class="ref-stats" style="margin-top:12px">
				<div><div class="ref-stat-k">Position</div><div class="ref-stat-v accent">#${fmtInt(card.position)}</div></div>
				<div><div class="ref-stat-k">Score</div><div class="ref-stat-v">${fmtInt(card.score)}</div></div>
				<div><div class="ref-stat-k">Referrals</div><div class="ref-stat-v">${fmtInt(card.referred_users_count)}</div></div>
			</div>
			<div class="ref-divider" style="margin-top:12px"></div>
			<div class="ref-row" style="margin-top:10px;color:rgba(255,255,255,.5);font-size:11px">
				<div class="ref-brand" style="font-size:13px;opacity:.85"><img loading="lazy" decoding="async" src="/favicon.ico" alt="" />three.ws</div>
				<span>© ${new Date().getFullYear()} three.ws</span>
			</div>
		</div>`;
}

// ── icons for the action rail ─────────────────────────────────────────────────

const ICONS = {
	flip:  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8a6 6 0 019.7-3.2L16 7M16 3v4h-4"/><path d="M16 12a6 6 0 01-9.7 3.2L4 13M4 17v-4h4"/></svg>',
	x:     '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M14.9 3H17l-4.6 5.3L18 17h-4.3l-3.4-4.4L6.4 17H4.3l5-5.7L3.5 3h4.4l3 4 3.9-4z"/></svg>',
	tg:    '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M17.6 3.3 2.9 9c-1 .4-1 1 0 1.3l3.7 1.1 1.4 4.5c.2.5.1.7.6.7.4 0 .6-.2.8-.4l1.8-1.8 3.8 2.8c.7.4 1.2.2 1.4-.6l2.5-11.8c.3-1-.4-1.5-1.3-1.1zM7.8 11.8l8-5c.4-.2.7 0 .4.3l-6.7 6-.3 2.6-1.4-3.9z"/></svg>',
	copy:  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="9" height="9" rx="2"/><path d="M13 7V5a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2"/></svg>',
	dl:    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3v9M6.5 8.5 10 12l3.5-3.5"/><path d="M4 14v1.5A1.5 1.5 0 005.5 17h9a1.5 1.5 0 001.5-1.5V14"/></svg>',
	share: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="15" cy="5" r="2.2"/><circle cx="5" cy="10" r="2.2"/><circle cx="15" cy="15" r="2.2"/><path d="M6.9 8.9l6.2-3M6.9 11.1l6.2 3"/></svg>',
};

// ── PNG export — draw the front face to a canvas for a shareable image ────────

function exportCardPNG(card, refUrl) {
	const W = 1100, H = Math.round(W / 1.74), P = 56;
	const canvas = document.createElement('canvas');
	canvas.width = W; canvas.height = H;
	const ctx = canvas.getContext('2d');

	// Background gradient + radial sheen.
	const g = ctx.createLinearGradient(0, 0, W, H);
	g.addColorStop(0, '#181230'); g.addColorStop(0.52, '#241a4d'); g.addColorStop(1, '#3a2680');
	roundRect(ctx, 0, 0, W, H, 40); ctx.fillStyle = g; ctx.fill();
	const rg = ctx.createRadialGradient(W * 0.88, H * 0.06, 0, W * 0.88, H * 0.06, W * 0.6);
	rg.addColorStop(0, 'rgba(167,139,250,0.4)'); rg.addColorStop(1, 'rgba(167,139,250,0)');
	ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);

	ctx.fillStyle = '#ffffff';
	ctx.textBaseline = 'alphabetic';

	// Brand wordmark.
	ctx.font = '700 34px Inter, system-ui, sans-serif';
	ctx.fillText('three.ws', P, P + 30);

	// QR (small) top area.
	const qrCanvas = renderQRToCanvas(refUrl, { scale: 4, margin: 1 });
	const qrSize = 150;
	ctx.save();
	roundRect(ctx, P, P + 60, qrSize, qrSize, 14); ctx.fillStyle = '#fff'; ctx.fill();
	ctx.drawImage(qrCanvas, P + 8, P + 68, qrSize - 16, qrSize - 16);
	ctx.restore();
	ctx.fillStyle = 'rgba(255,255,255,0.92)';
	ctx.font = '600 24px Inter, system-ui, sans-serif';
	ctx.fillText('Scan to join', P + qrSize + 28, P + 110);
	ctx.fillStyle = 'rgba(255,255,255,0.55)';
	ctx.font = '400 18px Inter, system-ui, sans-serif';
	ctx.fillText('three.ws referral', P + qrSize + 28, P + 138);

	// Divider.
	const dy = P + 250;
	ctx.fillStyle = 'rgba(255,255,255,0.16)';
	ctx.fillRect(P, dy, W - P * 2, 1.5);

	// Stats row.
	const stats = [
		['POSITION', `#${fmtInt(card.position)}`, '#c4b5fd'],
		['REFERRALS', fmtInt(card.referred_users_count), '#ffffff'],
		['SCORE', fmtInt(card.score), '#ffffff'],
	];
	stats.forEach((st, i) => {
		const x = P + i * ((W - P * 2) / 3);
		ctx.fillStyle = 'rgba(255,255,255,0.5)';
		ctx.font = '600 16px Inter, system-ui, sans-serif';
		ctx.fillText(st[0], x, dy + 40);
		ctx.fillStyle = st[2];
		ctx.font = `700 40px ${'ui-monospace, Menlo, monospace'}`;
		ctx.fillText(st[1], x, dy + 86);
	});

	// Member meta + name.
	ctx.fillStyle = 'rgba(255,255,255,0.55)';
	ctx.font = '400 18px ui-monospace, Menlo, monospace';
	ctx.fillText(`EXP ${expLabel(card.member_since)}   Member since ${memberSinceLabel(card.member_since)}`, P, H - P - 44);
	ctx.textAlign = 'right';
	ctx.fillText(`#${String(card.position).padStart(6, '0')}`, W - P, H - P - 44);
	ctx.textAlign = 'left';
	ctx.fillStyle = '#ffffff';
	ctx.font = '700 40px Inter, system-ui, sans-serif';
	ctx.fillText(card.display_name || 'Member', P, H - P);

	canvas.toBlob((blob) => {
		if (!blob) { toast('Export failed'); return; }
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `three-ws-membership-${card.referral_code}.png`;
		document.body.appendChild(a); a.click(); a.remove();
		URL.revokeObjectURL(url);
		toast('Card downloaded');
	}, 'image/png');
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

// ── render ────────────────────────────────────────────────────────────────────

function renderCard(host, card) {
	const refUrl = `${location.origin}/register?ref=${encodeURIComponent(card.referral_code)}`;
	const shareText = `Join me on three.ws — build, deploy, and monetize 3D AI agents.`;
	const xUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(refUrl)}`;
	const tgUrl = `https://t.me/share/url?url=${encodeURIComponent(refUrl)}&text=${encodeURIComponent(shareText)}`;

	host.innerHTML = `
		<div class="ref-stage">
			<div class="ref-perspective">
				<div class="ref-card" data-card role="img"
					aria-label="three.ws membership card — position ${fmtInt(card.position)}, ${fmtInt(card.referred_users_count)} referrals, score ${fmtInt(card.score)}">
					${frontFace(card, refUrl)}
					${backFace(card, refUrl)}
				</div>
			</div>
			<div class="ref-rail" role="toolbar" aria-label="Card actions">
				<button class="ref-rail-btn" data-action="flip" aria-label="Flip card">${ICONS.flip}<span class="ref-tip">Flip card</span></button>
				<a class="ref-rail-btn" data-action="x" href="${esc(xUrl)}" target="_blank" rel="noopener" aria-label="Share on X">${ICONS.x}<span class="ref-tip">Share on X</span></a>
				<a class="ref-rail-btn" data-action="tg" href="${esc(tgUrl)}" target="_blank" rel="noopener" aria-label="Share on Telegram">${ICONS.tg}<span class="ref-tip">Telegram</span></a>
				<button class="ref-rail-btn" data-action="copy" aria-label="Copy referral link">${ICONS.copy}<span class="ref-tip">Copy link</span></button>
				<button class="ref-rail-btn" data-action="download" aria-label="Download card image">${ICONS.dl}<span class="ref-tip">Download</span></button>
				<button class="ref-rail-btn" data-action="share" aria-label="Share">${ICONS.share}<span class="ref-tip">Share</span></button>
			</div>
		</div>

		<div style="margin-top:22px">
			<div class="dn-panel-title" style="margin-bottom:8px">Your referral link</div>
			<div class="ref-linkbar">
				<input type="text" readonly value="${esc(refUrl)}" data-link aria-label="Referral link" />
				<button class="dn-btn primary" data-action="copy-link" style="padding:0 18px">Copy link</button>
			</div>
			<div class="ref-codebox" data-codebox>${codeBoxCollapsed(card)}</div>
		</div>

		<div class="ref-tiles" style="margin-top:18px">
			<div class="ref-tile"><div class="ref-tile-k">Member position</div><div class="ref-tile-v">#${fmtInt(card.position)} <small>of ${fmtInt(card.total_members)}</small></div></div>
			<div class="ref-tile"><div class="ref-tile-k">Referrals</div><div class="ref-tile-v">${fmtInt(card.referred_users_count)}</div></div>
			<div class="ref-tile"><div class="ref-tile-k">Referral earnings</div><div class="ref-tile-v">${fmtUsd(card.referral_earnings_usd)}</div></div>
			<div class="ref-tile"><div class="ref-tile-k">Reward credits</div><div class="ref-tile-v">${fmtUsd(card.reward_credits_usd || 0)}</div></div>
			<div class="ref-tile"><div class="ref-tile-k">Score</div><div class="ref-tile-v">${fmtInt(card.score)}</div></div>
		</div>

		<section class="dn-panel" style="margin-top:20px" data-slot="tier-panel" aria-label="Your membership tier"></section>

		<section class="dn-panel" style="margin-top:20px" data-slot="referrals-list" aria-label="Your referrals"></section>

		<section class="dn-panel" style="margin-top:20px">
			<div class="dn-panel-title" style="margin-bottom:14px">How referrals work</div>
			<div class="ref-steps">
				<div class="ref-step"><div class="ref-step-n">1</div><div><h4>Share your link</h4><p>Send your referral link or QR. Anyone who signs up through it is linked to you for life.</p></div></div>
				<div class="ref-step"><div class="ref-step-n">2</div><div><h4>They make their first creation</h4><p>The moment a referral lands their first 3D creation, you <b>both</b> get bonus credits toward the paid lanes — instantly, no purchase required.</p></div></div>
				<div class="ref-step"><div class="ref-step-n">3</div><div><h4>They build &amp; spend</h4><p>When your referrals buy assets, skills, or services on three.ws, you earn automatically.</p></div></div>
				<div class="ref-step"><div class="ref-step-n">4</div><div><h4>You earn ${REFERRAL_PCT}%</h4><p>You collect ${REFERRAL_PCT}% of every referred purchase in USDC, paid straight to your account.</p></div></div>
			</div>
		</section>
	`;

	wireCard(host, card, refUrl);
	loadTier(host, card);
	mountReferralsList(host.querySelector('[data-slot="referrals-list"]'), refUrl, card.referred_users);
}

function wireCard(host, card, refUrl) {
	const cardEl = host.querySelector('[data-card]');
	const flipBtn = host.querySelector('[data-action="flip"]');

	const state = { flipped: false, rx: 0, ry: 0 };
	const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

	const apply = () => {
		const baseY = state.flipped ? 180 : 0;
		cardEl.style.transform = `rotateX(${state.rx}deg) rotateY(${baseY + state.ry}deg)`;
	};
	apply();

	const flip = () => {
		state.flipped = !state.flipped;
		flipBtn.setAttribute('data-active', String(state.flipped));
		const tip = flipBtn.querySelector('.ref-tip');
		if (tip) tip.textContent = state.flipped ? 'Show front' : 'Flip card';
		apply();
	};
	flipBtn.addEventListener('click', flip);
	// Tapping the card flips it too — but not when the user is dragging to tilt.
	cardEl.addEventListener('click', (e) => {
		if (cardEl._dragged) { cardEl._dragged = false; return; }
		if (e.target.closest('a')) return;
		flip();
	});

	if (!reduce) {
		const onMove = (e) => {
			const r = cardEl.getBoundingClientRect();
			const px = (e.clientX - r.left) / r.width - 0.5;
			const py = (e.clientY - r.top) / r.height - 0.5;
			state.ry = px * 10;
			state.rx = -py * 10;
			cardEl._dragged = true;
			apply();
		};
		cardEl.addEventListener('pointermove', onMove);
		cardEl.addEventListener('pointerleave', () => {
			state.rx = 0; state.ry = 0; apply();
			setTimeout(() => { cardEl._dragged = false; }, 0);
		});
	}

	const copyLink = () => copyToClipboard(refUrl);
	host.querySelector('[data-action="copy"]').addEventListener('click', copyLink);
	// Primary "Copy link" button also flashes an inline confirmation so success is
	// obvious right where the user clicked, not only in the toast.
	const linkBtn = host.querySelector('[data-action="copy-link"]');
	linkBtn.addEventListener('click', async () => {
		const ok = await copyToClipboard(refUrl);
		if (ok === false) return;
		if (!linkBtn._label) linkBtn._label = linkBtn.textContent;
		linkBtn.textContent = 'Copied ✓';
		clearTimeout(linkBtn._t);
		linkBtn._t = setTimeout(() => { linkBtn.textContent = linkBtn._label; }, 1400);
	});
	host.querySelector('[data-link]').addEventListener('click', (e) => { e.currentTarget.select(); });
	wireCodeEditor(host, card);
	host.querySelector('[data-action="download"]').addEventListener('click', () => exportCardPNG(card, refUrl));

	host.querySelector('[data-action="share"]').addEventListener('click', async () => {
		const data = {
			title: 'three.ws',
			text: 'Join me on three.ws — build, deploy, and monetize 3D AI agents.',
			url: refUrl,
		};
		if (navigator.share) {
			try { await navigator.share(data); } catch { /* user cancelled */ }
		} else {
			await copyToClipboard(refUrl);
		}
	});
}

// ── referral code editor ──────────────────────────────────────────────────────
//
// The code defaults to the member's name at signup; here they make it their own.
// Collapsed: shows the current code with Copy + Customize. Expanded: an inline
// editor with a live, debounced availability check against /api/users/referral-code.

const CHECK_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 4.5 6.5 11 3 7.5"/></svg>';
const SPINNER = '<svg viewBox="0 0 16 16" width="14" height="14" class="ref-spin" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 1.5a6.5 6.5 0 1 0 6.5 6.5" opacity="0.9"/></svg>';
const WARN_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5v3.5M8 11h.01"/><circle cx="8" cy="8" r="6.5"/></svg>';

function codeBoxCollapsed(card) {
	return `
		<div class="ref-code-display">
			<div class="ref-code-meta">
				<div class="ref-code-label">Your referral code</div>
				<div class="ref-code-value" data-code-value>${esc(card.referral_code)}</div>
			</div>
			<div class="ref-code-cta">
				<button class="dn-btn" data-action="copy-code" type="button">Copy</button>
				<button class="dn-btn primary" data-action="edit-code" type="button">Customize</button>
			</div>
		</div>`;
}

function codeBoxEditing(card) {
	return `
		<label class="ref-code-label" for="ref-code-input">Customize your referral code</label>
		<div class="ref-code-inputwrap">
			<span class="ref-code-prefix">?ref=</span>
			<input id="ref-code-input" class="ref-code-input" data-code-input type="text"
				value="${esc(card.referral_code)}" maxlength="${CODE_MAX}"
				autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false"
				aria-label="Referral code" aria-describedby="ref-code-hint" />
			<span class="ref-code-status" data-code-status aria-hidden="true"></span>
		</div>
		<div class="ref-code-hint" id="ref-code-hint" data-code-hint>${CODE_MIN}–${CODE_MAX} letters or numbers. This becomes your shareable link.</div>
		<div class="ref-code-actions">
			<button class="dn-btn primary" data-action="save-code" type="button" disabled>Save code</button>
			<button class="dn-btn" data-action="cancel-code" type="button">Cancel</button>
		</div>`;
}

function wireCodeEditor(host, card) {
	const box = host.querySelector('[data-codebox]');
	if (!box) return;

	function showCollapsed() {
		box.innerHTML = codeBoxCollapsed(card);
		box.querySelector('[data-action="copy-code"]').addEventListener('click', () => copyToClipboard(card.referral_code));
		box.querySelector('[data-action="edit-code"]').addEventListener('click', showEditing);
	}

	function showEditing() {
		box.innerHTML = codeBoxEditing(card);
		const input = box.querySelector('[data-code-input]');
		const statusEl = box.querySelector('[data-code-status]');
		const hintEl = box.querySelector('[data-code-hint]');
		const saveBtn = box.querySelector('[data-action="save-code"]');
		const current = card.referral_code.toUpperCase();
		let token = 0; // guards against out-of-order availability responses
		let ok = false;

		const setState = (cls, statusHtml, hintText, canSave) => {
			statusEl.className = `ref-code-status ${cls}`;
			statusEl.innerHTML = statusHtml;
			hintEl.className = `ref-code-hint ${cls === 'good' ? 'good' : cls === 'bad' ? 'bad' : ''}`;
			hintEl.textContent = hintText;
			ok = !!canSave;
			saveBtn.disabled = !canSave;
		};

		const evaluate = () => {
			const value = input.value;
			const myToken = ++token;
			if (value === current) {
				setState('', '', 'This is your current code.', false);
				return;
			}
			if (!CODE_RE.test(value)) {
				setState('', '', `${CODE_MIN}–${CODE_MAX} letters or numbers — no spaces or symbols.`, false);
				return;
			}
			setState('checking', SPINNER, 'Checking availability…', false);
			get(`/api/users/referral-code?code=${encodeURIComponent(value)}`)
				.then((r) => {
					if (myToken !== token) return; // a newer keystroke superseded this
					if (r.available) {
						setState('good', CHECK_ICON, r.reason === 'current' ? 'This is your current code.' : 'Available — yours to claim.', r.reason !== 'current');
					} else if (r.reason === 'reserved') {
						setState('bad', WARN_ICON, 'That code is reserved. Pick another.', false);
					} else if (r.reason === 'taken') {
						setState('bad', WARN_ICON, 'Already taken. Try a variation.', false);
					} else {
						setState('bad', WARN_ICON, `${CODE_MIN}–${CODE_MAX} letters or numbers.`, false);
					}
				})
				.catch(() => {
					if (myToken !== token) return;
					setState('', '', 'Couldn’t check availability — try again.', false);
				});
		};

		let debounce;
		input.addEventListener('input', () => {
			// Live-sanitize to the canonical alphabet so the field only ever holds
			// what can actually be saved.
			const cleaned = input.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, CODE_MAX);
			if (cleaned !== input.value) {
				input.value = cleaned;
				// Place cursor at end of cleaned value — multi-char strips (e.g.
				// paste of "my-code!") may remove more than one character, making
				// caret - 1 wrong. End-of-field is always safe and expected.
				input.setSelectionRange(cleaned.length, cleaned.length);
			}
			clearTimeout(debounce);
			debounce = setTimeout(evaluate, 280);
		});
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { e.preventDefault(); if (ok) save(); }
			else if (e.key === 'Escape') { e.preventDefault(); showCollapsed(); }
		});

		async function save() {
			if (!ok) return;
			const desired = input.value;
			saveBtn.disabled = true;
			setState('checking', SPINNER, 'Saving…', false);
			try {
				const r = await put('/api/users/referral-code', { code: desired });
				card.referral_code = r.referral_code;
				toast('Referral code updated');
				// Re-render the whole card so the link, QR, and PNG export all pick up
				// the new code.
				renderCard(host, card);
			} catch (err) {
				const reason = err?.code;
				const msg = reason === 'taken' ? 'Already taken. Try a variation.'
					: reason === 'reserved' ? 'That code is reserved. Pick another.'
					: err?.message || 'Couldn’t save — try again.';
				setState('bad', WARN_ICON, msg, false);
				saveBtn.disabled = false;
			}
		}

		box.querySelector('[data-action="save-code"]').addEventListener('click', save);
		box.querySelector('[data-action="cancel-code"]').addEventListener('click', showCollapsed);

		input.focus();
		input.setSelectionRange(input.value.length, input.value.length);
		evaluate();
	}

	showCollapsed();
}

// ── membership tier ───────────────────────────────────────────────────────────
//
// Every member wears a "mode": user, beta, pro, holder, or three-dimensional.
// The card shows the highest one as a pill; this panel shows the full ladder,
// which badges you already hold, and what unlocks the rest. Data is real, from
// /api/users/me/tier — holder status is read live from your on-chain $THREE.

// Where a locked mode is earned, and where to go to get there. Derived modes
// link to the surface that unlocks them; granted modes are invite-only.
const TIER_UNLOCK = {
	beta: { label: 'By invitation', href: null },
	pro: { label: 'Upgrade plan', href: '/dashboard/monetize' },
	holder: { label: 'Hold $THREE', href: '/dashboard/three-token' },
	'three-dimensional': { label: 'By invitation', href: null },
};

const ARROW_UP_ICON = '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 16V5M5.5 9.5 10 5l4.5 4.5"/></svg>';

function tierDot(color) {
	return `<span class="ref-tier-dot" style="background:${color};color:${color}"></span>`;
}

/** Fill the small tier pill on the card front. */
function fillTierPill(pill, tier) {
	if (!pill || !tier) return;
	pill.style.color = tier.color;
	pill.style.borderColor = `${tier.color}66`;
	pill.style.background = `${tier.color}24`;
	pill.innerHTML = `${tierDot(tier.color)}${esc(tier.label)}`;
	pill.hidden = false;
}

function renderTierSkeleton(host) {
	host.innerHTML = `
		<div class="ref-tier-head">
			<h3 class="dn-panel-title" style="margin:0">Your membership tier</h3>
			<span class="ref-skel-bar" style="width:96px;height:26px;border-radius:999px"></span>
		</div>
		<div class="ref-tier-ladder" style="margin-top:10px">
			${[0, 1, 2].map(() => `
				<div class="ref-tier-rung" data-active="false">
					<span class="ref-skel-bar" style="width:34px;height:34px;border-radius:9px"></span>
					<div class="ref-tier-rung-body"><span class="ref-skel-bar" style="width:120px"></span>
						<div style="margin-top:8px"><span class="ref-skel-bar" style="width:220px"></span></div></div>
				</div>`).join('')}
		</div>`;
}

function renderTierError(host, onRetry) {
	host.innerHTML = `
		<div class="ref-tier-head"><h3 class="dn-panel-title" style="margin:0">Your membership tier</h3></div>
		<p class="ref-tier-desc" style="margin-top:8px">Couldn't load your tier just now.</p>
		<button class="dn-btn" data-action="retry-tier" style="padding:0 16px;height:36px">Retry</button>`;
	host.querySelector('[data-action="retry-tier"]').addEventListener('click', onRetry);
}

function tierRung(tier, active, holder) {
	const unlock = TIER_UNLOCK[tier.id];
	let status;
	if (active) {
		status = `<span class="ref-tier-status active">${CHECK_ICON} Active</span>`;
	} else if (unlock?.href) {
		status = `<a class="ref-tier-status locked" href="${esc(unlock.href)}">${esc(unlock.label)} →</a>`;
	} else if (unlock) {
		status = `<span class="ref-tier-status locked">${esc(unlock.label)}</span>`;
	} else {
		status = '';
	}

	// Holders see how much they hold, right where the badge lives.
	const heldNote = tier.id === 'holder' && active && holder?.usd > 0
		? ` · holding ${fmtUsd(holder.usd)}`
		: '';

	return `
		<div class="ref-tier-rung" data-active="${active}">
			<span class="ref-tier-marker" style="color:${tier.color};border-color:${tier.color}59;background:${tier.color}1f">${tierDot(tier.color)}</span>
			<div class="ref-tier-rung-body">
				<div class="ref-tier-rung-title">${esc(tier.label)} <span class="ref-tier-rung-tag">${esc(tier.tagline)}${heldNote}</span></div>
				<div class="ref-tier-rung-desc">${esc(tier.description)}</div>
			</div>
			${status}
		</div>`;
}

function renderTierPanel(host, data) {
	const primary = data.tier;
	const activeIds = new Set((data.badges || []).map((b) => b.id));
	const badgeChips = (data.badges || [])
		.map((b) => `<span class="ref-tier-chip">${tierDot(b.color)}${esc(b.label)}</span>`)
		.join('');

	const nextHtml = data.next
		? `<div class="ref-tier-next">
				${ARROW_UP_ICON}
				<div class="ref-tier-next-body">Next up: <b>${esc(data.next.label)}</b> — ${esc(data.next.description)}</div>
				${TIER_UNLOCK[data.next.id]?.href
					? `<a class="ref-tier-status locked" href="${esc(TIER_UNLOCK[data.next.id].href)}">${esc(TIER_UNLOCK[data.next.id].label)} →</a>`
					: `<span class="ref-tier-status locked">${esc(TIER_UNLOCK[data.next.id]?.label || 'By invitation')}</span>`}
			</div>`
		: '';

	host.innerHTML = `
		<div class="ref-tier-head">
			<h3 class="dn-panel-title" style="margin:0">Your membership tier</h3>
			<span class="ref-tier-badge" style="color:${primary.color};border-color:${primary.color}59;background:${primary.color}1f">
				${tierDot(primary.color)}${esc(primary.label)}
			</span>
		</div>
		<p class="ref-tier-desc">${esc(primary.description)}</p>
		${badgeChips ? `<div class="ref-tier-badges">${badgeChips}</div>` : ''}
		<div class="ref-tier-ladder">
			${(data.tiers || []).map((t) => tierRung(t, activeIds.has(t.id), data.holder)).join('')}
		</div>
		${nextHtml}`;
}

// Load the member's tier once, cache it on the card (so a code-save re-render
// doesn't refetch), then fill both the card pill and the ladder panel.
function loadTier(host, card) {
	const panel = host.querySelector('[data-slot="tier-panel"]');
	const pill = host.querySelector('[data-tier-pill]');
	if (!panel) return;

	const apply = (data) => {
		fillTierPill(pill, data.tier);
		renderTierPanel(panel, data);
	};

	if (card.tierData) { apply(card.tierData); return; }

	renderTierSkeleton(panel);
	get('/api/users/me/tier')
		.then((data) => {
			if (!data || !data.tier) throw new Error('no tier');
			card.tierData = data;
			apply(data);
		})
		.catch(() => renderTierError(panel, () => loadTier(host, card)));
}

// ── referred-users table ──────────────────────────────────────────────────────

const PEOPLE_ICON = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M16 19v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 19v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';

function initials(item) {
	const src = item.display_name || item.username || '';
	const letters = src.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase();
	return letters || '?';
}

function referralRow(item) {
	const name = maskedHandle(item);
	const rev = Number(item.revenue_generated_usd || 0);
	const comm = Number(item.commission_earned_usd || 0);
	return `
		<tr tabindex="0">
			<td>
				<div class="ref-user">
					<span class="ref-avatar" aria-hidden="true">${esc(initials(item))}</span>
					<span class="ref-user-name" title="${esc(name)}">${esc(name)}</span>
				</div>
			</td>
			<td>${esc(fmtDate(item.signup_date))}</td>
			<td class="num ${rev > 0 ? '' : 'ref-zero'}">${esc(fmtUsd(rev))}</td>
			<td class="num ${comm > 0 ? 'ref-commission' : 'ref-zero'}">${esc(fmtUsd(comm))}</td>
		</tr>`;
}

function referralsTableShell(rowsHtml) {
	return `
		<div class="ref-tablewrap">
			<table class="ref-table">
				<thead>
					<tr>
						<th scope="col">Referred user</th>
						<th scope="col">Signup date</th>
						<th scope="col" class="num">Revenue generated</th>
						<th scope="col" class="num">Your commission</th>
					</tr>
				</thead>
				<tbody data-ref-tbody>${rowsHtml}</tbody>
			</table>
		</div>`;
}

function skeletonRows(n = 5) {
	let html = '';
	for (let i = 0; i < n; i++) {
		html += `<tr class="ref-skel-row">
			<td><div class="ref-user"><span class="ref-skel-bar" style="width:28px;height:28px;border-radius:50%"></span><span class="ref-skel-bar" style="width:120px"></span></div></td>
			<td><span class="ref-skel-bar" style="width:88px;display:inline-block"></span></td>
			<td class="num"><span class="ref-skel-bar" style="width:64px;display:inline-block"></span></td>
			<td class="num"><span class="ref-skel-bar" style="width:52px;display:inline-block"></span></td>
		</tr>`;
	}
	return html;
}

function renderReferralsEmpty(host) {
	host.innerHTML = `
		<div class="ref-empty">
			${PEOPLE_ICON}
			<h4>No referrals yet</h4>
			<p>Share your link above — when someone signs up through it and starts spending, they'll show up here with the revenue they generate and your commission.</p>
			<button class="dn-btn primary" data-action="copy-from-empty" style="padding:0 18px;height:38px">Copy referral link</button>
		</div>`;
}

function renderReferralsError(host, message, onRetry) {
	host.innerHTML = `
		<div class="ref-empty">
			<h4>Couldn't load your referrals</h4>
			<p>${esc(message || 'Try again in a moment.')}</p>
			<button class="dn-btn" data-action="retry-list" style="padding:0 18px;height:38px">Retry</button>
		</div>`;
	host.querySelector('[data-action="retry-list"]').addEventListener('click', onRetry);
}

// Stateful, paginated referrals list. Renders into `host` and refetches per page
// without touching the membership card. First page may be hydrated from the
// initial card payload to avoid a duplicate request.
function mountReferralsList(host, refUrl, seed) {
	const state = {
		offset: 0,
		limit: seed?.limit || REF_PAGE_SIZE,
		total: typeof seed?.total === 'number' ? seed.total : null,
		loading: false,
	};

	function renderPage(payload) {
		state.total = payload.total;
		state.limit = payload.limit || state.limit;
		state.offset = payload.offset || 0;

		const totalLabel = `${fmtInt(state.total)} ${state.total === 1 ? 'referral' : 'referrals'}`;
		if (!payload.items || payload.items.length === 0) {
			if (state.total === 0) {
				host.innerHTML = `<div class="ref-list-head"><h3 class="dn-panel-title" style="margin:0">Your referrals</h3></div>`;
				const slot = document.createElement('div');
				host.appendChild(slot);
				renderReferralsEmpty(slot);
				const copyBtn = slot.querySelector('[data-action="copy-from-empty"]');
				if (copyBtn) copyBtn.addEventListener('click', () => copyToClipboard(refUrl));
				return;
			}
			// Past the last page (e.g. data shrank) — step back.
			if (state.offset > 0) { go(Math.max(0, state.offset - state.limit)); return; }
		}

		const start = state.offset + 1;
		const end = state.offset + payload.items.length;
		const pages = Math.max(1, Math.ceil(state.total / state.limit));
		const currentPage = Math.floor(state.offset / state.limit) + 1;
		const hasPrev = state.offset > 0;
		const hasNext = state.offset + state.limit < state.total;

		host.innerHTML = `
			<div class="ref-list-head">
				<h3 class="dn-panel-title" style="margin:0">Your referrals</h3>
				<span class="ref-list-count">${esc(totalLabel)}</span>
			</div>
			${referralsTableShell(payload.items.map(referralRow).join(''))}
			${state.total > state.limit ? `
				<div class="ref-pager">
					<span class="ref-pager-info">Showing ${fmtInt(start)}–${fmtInt(end)} of ${fmtInt(state.total)} · page ${fmtInt(currentPage)}/${fmtInt(pages)}</span>
					<button class="ref-pgbtn" data-action="prev" ${hasPrev ? '' : 'disabled'} aria-label="Previous page">‹ Prev</button>
					<button class="ref-pgbtn" data-action="next" ${hasNext ? '' : 'disabled'} aria-label="Next page">Next ›</button>
				</div>` : ''}
		`;
		const prev = host.querySelector('[data-action="prev"]');
		const next = host.querySelector('[data-action="next"]');
		if (prev) prev.addEventListener('click', () => go(Math.max(0, state.offset - state.limit)));
		if (next) next.addEventListener('click', () => go(state.offset + state.limit));
	}

	function renderLoading() {
		host.innerHTML = `
			<div class="ref-list-head">
				<h3 class="dn-panel-title" style="margin:0">Your referrals</h3>
				<span class="ref-list-count">Loading…</span>
			</div>
			${referralsTableShell(skeletonRows(Math.min(5, state.limit)))}`;
	}

	async function go(offset) {
		if (state.loading) return;
		state.loading = true;
		state.offset = offset;
		renderLoading();
		try {
			const data = await get(`/api/users/referrals?limit=${state.limit}&offset=${offset}`);
			renderPage(data?.referred_users || { items: [], total: 0, limit: state.limit, offset });
		} catch (err) {
			renderReferralsError(host, err?.message, () => go(offset));
		} finally {
			state.loading = false;
		}
	}

	// Hydrate from the seed (the membership-card request already fetched page 0).
	if (seed && seed.items) {
		renderPage(seed);
	} else {
		go(0);
	}
}

function renderError(host, message) {
	host.innerHTML = `
		<div class="dn-empty" style="padding:40px 24px">
			<h3>Couldn't load your card</h3>
			<p>${esc(message || 'Try again in a moment.')}</p>
			<button class="dn-btn primary" data-action="retry">Retry</button>
		</div>`;
	host.querySelector('[data-action="retry"]').addEventListener('click', () => boot(host));
}

async function boot(host) {
	host.innerHTML = `<div class="ref-stage"><div class="ref-perspective"><div class="ref-card-skel"></div></div></div>`;
	try {
		const card = await get('/api/users/referrals');
		if (!card || !card.referral_code) {
			renderError(host, 'No referral code yet — refresh to mint one.');
			return;
		}
		renderCard(host, card);
	} catch (err) {
		renderError(host, err?.message);
	}
}

(async function main() {
	injectStyles();
	const root = await mountShell();
	await requireUser();

	root.innerHTML = `
		<h1 class="dn-h1">Referrals</h1>
		<p class="dn-h1-sub">Your three.ws membership card. Share it, earn ${REFERRAL_PCT}% on every referral.</p>
		<div class="ref-wrap" data-slot="card"></div>
	`;

	boot(root.querySelector('[data-slot="card"]'));
})();
