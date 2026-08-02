/**
 * Agent Wallet hub — Withdraw tab (epic task 09: custody safety).
 *
 * Owner-only. Three sub-sections, all states designed:
 *
 *   Withdraw        Sweep SOL or any held SPL token out to an address or .sol
 *                   name. The agent key is server-side, so this calls the
 *                   server-signed, idempotent POST /api/agents/:id/solana/withdraw
 *                   — there is no client key for the agent's address. Rent + fees
 *                   are reserved on a SOL "Max" so a sweep can't brick the wallet.
 *   Limits & Safety Read/edit the per-agent spend policy (daily + per-tx USD
 *                   ceilings, withdraw allowlist) that governs trade/snipe/x402/
 *                   withdraw from one place.
 *   Activity        The custody audit trail: key recovery, withdrawals, automated
 *                   spends, and limit changes.
 *
 * Everything is real: live holdings from /solana/holdings, real on-chain
 * withdrawals, the real shared spend policy. No mocks, no client signing.
 */

import { registerWalletTab } from '../registry.js';
import { formatUsd, explorerTxUrl } from '../util.js';
import { consumeCsrfToken } from '../../api.js';
import { ensureRiskAck } from '../../shared/risk-ack.js';

const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const WD_STYLE_ID = 'awh-withdraw-style';
const WD_STYLE = `
.awh-wd-sub { display: flex; gap: 4px; margin-bottom: var(--space-4,16px); }
.awh-wd-sub button { appearance:none; font:inherit; font-size: var(--text-sm,.764rem); font-weight:500; color: var(--ink-dim,#888); background:transparent; border:1px solid transparent; border-radius: var(--radius-pill,999px); padding:5px 13px; cursor:pointer; transition: background var(--duration-fast,140ms), color var(--duration-fast,140ms), border-color var(--duration-fast,140ms); }
.awh-wd-sub button:hover { color: var(--ink,#e8e8e8); }
.awh-wd-sub button[aria-pressed="true"] { color: var(--ink-bright,#fff); background: var(--surface-2, rgba(255,255,255,.07)); border-color: var(--stroke,rgba(255,255,255,.1)); }
.awh-wd-sub button:focus-visible { outline: var(--focus-ring-width,2px) solid var(--focus-ring-color,#fff); outline-offset:2px; }

.awh-fld { margin-bottom: var(--space-4,16px); }
.awh-fld label { display:block; font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); margin-bottom:6px; }
.awh-in, .awh-sel { width:100%; box-sizing:border-box; font:inherit; font-size: var(--text-md,.8125rem); color: var(--ink,#e8e8e8); background: var(--surface-1, rgba(255,255,255,.03)); border:1px solid var(--stroke,rgba(255,255,255,.1)); border-radius: var(--radius-md,10px); padding:9px 12px; transition: border-color var(--duration-fast,140ms); }
.awh-in:focus, .awh-sel:focus { outline:none; border-color: var(--stroke-strong, rgba(255,255,255,.2)); }
.awh-row { display:flex; gap:8px; }
.awh-row .awh-in { flex:1; }
.awh-resolved { font-size: var(--text-sm,.764rem); margin-top:6px; font-family: var(--font-mono,ui-monospace,monospace); word-break:break-all; }
.awh-resolved.ok { color: var(--success,#4ade80); }
.awh-resolved.warn { color: var(--warn,#fbbf24); }
.awh-note { font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); margin-top:6px; }
.awh-err { background: color-mix(in srgb, var(--danger,#f87171) 12%, transparent); border:1px solid color-mix(in srgb, var(--danger,#f87171) 32%, transparent); color: var(--danger,#f87171); border-radius: var(--radius-md,10px); padding:10px 12px; font-size: var(--text-sm,.764rem); margin-bottom: var(--space-3,12px); }
.awh-err .why { color: var(--ink-dim,#aaa); font-size: var(--text-2xs,.6875rem); margin-top:4px; text-transform:capitalize; }
.awh-sum { background: var(--surface-2, rgba(255,255,255,.05)); border:1px solid var(--stroke,rgba(255,255,255,.1)); border-radius: var(--radius-md,10px); padding:12px 14px; margin-bottom: var(--space-3,12px); }
.awh-sum .r { display:flex; justify-content:space-between; gap:12px; padding:4px 0; font-size: var(--text-sm,.764rem); }
.awh-sum .r > span:first-child { color: var(--ink-dim,#888); flex:none; }
.awh-sum .r .v { font-family: var(--font-mono,ui-monospace,monospace); text-align:right; word-break:break-all; color: var(--ink,#e8e8e8); }
.awh-actions { display:flex; gap:8px; margin-top: var(--space-3,12px); }
.awh-ok { text-align:center; padding: var(--space-4,16px) var(--space-2,8px); }
.awh-ok .ic { font-size:32px; line-height:1; margin-bottom:8px; }
.awh-skel-line { height:14px; border-radius:6px; background: var(--surface-2, rgba(255,255,255,.05)); animation: awh-skel 1.4s ease-in-out infinite; margin:9px 0; }
.awh-spin { display:inline-block; width:13px; height:13px; border:2px solid rgba(255,255,255,.3); border-top-color: currentColor; border-radius:50%; animation: awh-rot .7s linear infinite; vertical-align:-2px; margin-right:6px; }
@keyframes awh-rot { to { transform: rotate(360deg); } }

.awh-chips { display:flex; gap:6px; flex-wrap:wrap; margin-bottom: var(--space-3,12px); }
.awh-chip { font-size: var(--text-2xs,.6875rem); color: var(--ink,#e8e8e8); background: var(--surface-2,rgba(255,255,255,.06)); border:1px solid var(--stroke,rgba(255,255,255,.1)); border-radius: var(--radius-pill,999px); padding:3px 10px; }
.awh-chip.alert { color: var(--warn,#fbbf24); border-color: color-mix(in srgb, var(--warn,#fbbf24) 30%, transparent); }
.awh-allow { list-style:none; margin:0 0 10px; padding:0; }
.awh-allow li { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:7px 0; border-bottom:1px solid var(--stroke,rgba(255,255,255,.06)); font-family: var(--font-mono,ui-monospace,monospace); font-size: var(--text-sm,.764rem); }
.awh-allow .rm { appearance:none; background:transparent; border:0; color: var(--danger,#f87171); cursor:pointer; font-size:14px; line-height:1; padding:2px 6px; border-radius:6px; }
.awh-allow .rm:hover { background: color-mix(in srgb, var(--danger,#f87171) 14%, transparent); }

.awh-evs { list-style:none; margin:0; padding:0; }
.awh-ev { display:flex; gap:11px; padding:10px 0; border-bottom:1px solid var(--stroke,rgba(255,255,255,.06)); font-size: var(--text-sm,.764rem); }
.awh-ev:last-child { border-bottom:none; }
.awh-ev .ic { font-size:15px; width:20px; text-align:center; flex:none; }
.awh-ev .m { flex:1; min-width:0; }
.awh-ev .ttl { color: var(--ink,#e8e8e8); }
.awh-ev .sb { color: var(--ink-dim,#888); font-size: var(--text-2xs,.6875rem); font-family: var(--font-mono,ui-monospace,monospace); margin-top:2px; word-break:break-all; }
.awh-ev .sb a { color: inherit; border-bottom:1px dotted currentColor; }
.awh-ev .amt { text-align:right; font-family: var(--font-mono,ui-monospace,monospace); flex:none; color: var(--ink,#e8e8e8); }

.awh-scan { position:fixed; inset:0; background:rgba(0,0,0,.85); z-index:99999; display:flex; align-items:center; justify-content:center; }
.awh-scan-box { display:flex; flex-direction:column; gap:12px; align-items:center; }
.awh-scan video { width:min(320px,80vw); height:min(320px,80vw); object-fit:cover; border-radius:14px; border:2px solid var(--accent,#fff); }
@media (prefers-reduced-motion: reduce) { .awh-skel-line, .awh-spin { animation:none; } }
`;

function injectStyle() {
	if (typeof document === 'undefined' || document.getElementById(WD_STYLE_ID)) return;
	const tag = document.createElement('style');
	tag.id = WD_STYLE_ID;
	tag.textContent = WD_STYLE;
	document.head.appendChild(tag);
}

// ── fetch helper: never throws, always a designed result ──────────────────────
async function call(url, { method = 'GET', body = null } = {}) {
	try {
		const opts = { method, credentials: 'include', headers: {} };
		if (body != null) {
			opts.headers['content-type'] = 'application/json';
			opts.body = JSON.stringify(body);
		}
		// State-changing requests (withdraw POST, limits PUT) carry a single-use
		// CSRF token; reads (GET) don't need one. The server burns the token on use.
		if (method !== 'GET') {
			const token = await consumeCsrfToken();
			if (token) opts.headers['x-csrf-token'] = token;
		}
		const r = await fetch(url, opts);
		let j = null;
		try { j = await r.json(); } catch { /* empty body */ }
		if (!r.ok) {
			return { ok: false, status: r.status, code: j?.error || 'error', message: j?.error_description || `request failed (${r.status})`, detail: j?.detail || null, extra: j || null };
		}
		return { ok: true, status: r.status, data: j?.data ?? j };
	} catch (err) {
		return { ok: false, status: 0, code: 'network_error', message: err?.message || 'network error' };
	}
}

function fmtAmount(n, max = 6) {
	if (n == null) return '0';
	const num = Number(n);
	if (!Number.isFinite(num)) return String(n);
	return num.toLocaleString(undefined, { maximumFractionDigits: max });
}

async function resolveRecipient(raw) {
	const v = (raw || '').trim();
	if (!v) return { error: 'Enter a recipient address.' };
	if (SOL_ADDR_RE.test(v)) return { address: v };
	if (/\.sol$/i.test(v)) {
		const res = await call(`/api/sns?name=${encodeURIComponent(v)}`);
		if (res.ok && res.data?.address) return { address: res.data.address, name: v };
		return { error: `Could not resolve “${v}”.` };
	}
	return { error: 'Not a valid Solana address or .sol name.' };
}

function qrSupported() {
	return typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
}

async function scanQr() {
	if (!qrSupported()) return null;
	let stream = null;
	const overlay = document.createElement('div');
	overlay.className = 'awh-scan';
	overlay.setAttribute('role', 'dialog');
	overlay.setAttribute('aria-modal', 'true');
	overlay.setAttribute('aria-label', 'Scan a QR code to fill the destination address');
	overlay.innerHTML = `<div class="awh-scan-box"><video autoplay muted playsinline aria-hidden="true"></video><button type="button" class="awh-btn" data-scan-cancel>Cancel</button></div>`;
	document.body.appendChild(overlay);
	const video = overlay.querySelector('video');
	const cancelBtn = overlay.querySelector('[data-scan-cancel]');
	let stopped = false;
	function cleanup() {
		stopped = true;
		document.removeEventListener('keydown', onKey);
		if (stream) stream.getTracks().forEach((t) => t.stop());
		overlay.remove();
	}
	function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); cleanup(); } }
	cancelBtn.addEventListener('click', cleanup);
	overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });
	document.addEventListener('keydown', onKey);
	cancelBtn.focus();
	try {
		const detector = new BarcodeDetector({ formats: ['qr_code'] });
		stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
		video.srcObject = stream;
		return await new Promise((resolve) => {
			const tick = async () => {
				if (stopped || !overlay.isConnected) return resolve(null);
				try {
					const codes = await detector.detect(video);
					if (codes && codes.length) {
						let raw = codes[0].rawValue || '';
						const m = raw.match(/^solana:([1-9A-HJ-NP-Za-km-z]{32,44})/);
						if (m) raw = m[1];
						cleanup();
						return resolve(raw);
					}
				} catch { /* keep scanning */ }
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		});
	} catch {
		cleanup();
		return null;
	}
}

registerWalletTab({
	id: 'withdraw',
	label: 'Withdraw',
	order: 60,
	ownerOnly: true,
	mount({ panel, ctx }) {
		injectStyle();
		const { escapeHtml, shortAddress, toast } = ctx;
		const esc = escapeHtml;
		const base = (sub) => `/api/agents/${encodeURIComponent(ctx.agentId)}/solana/${sub}`;

		let destroyed = false;
		let detachNet = null;
		const state = {
			view: 'withdraw',       // 'withdraw' | 'limits' | 'activity'
			holdings: null,         // { sol, tokens } | null
			holdingsErr: null,
			// Can the server still sign for this wallet? A custodial secret sealed
			// under a retired encryption key reads back a healthy on-chain balance,
			// so without this the form looks completely normal and only fails after
			// the owner has typed an amount and confirmed. null = not yet known.
			signable: null,
			signableReason: null,
			limits: null,           // { limits, spent_today_usd } | { error }
			// withdraw form
			selectedAsset: 0,
			dest: '',
			resolvedDest: null,
			amount: '',
			phase: 'form',          // 'form' | 'confirm' | 'sending' | 'success'
			intent: null,
			result: null,
			submitErr: null,
		};

		function subStrip() {
			const item = (id, label) => `<button type="button" data-sub="${id}" aria-pressed="${state.view === id}">${esc(label)}</button>`;
			return `<div class="awh-wd-sub" role="group" aria-label="Withdraw sections">${item('withdraw', 'Withdraw')}${item('limits', 'Limits & Safety')}${item('activity', 'Activity')}</div>`;
		}

		function render() {
			if (destroyed) return;
			let inner = '';
			if (state.view === 'withdraw') inner = renderWithdraw();
			else if (state.view === 'limits') inner = renderLimits();
			else inner = '<div class="awh-card" data-host="activity"></div>';
			panel.innerHTML = `${subStrip()}${inner}`;
			panel.querySelectorAll('[data-sub]').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.sub)));
			if (state.view === 'withdraw') wireWithdraw();
			else if (state.view === 'limits') wireLimits();
			else mountActivity(panel.querySelector('[data-host="activity"]'));
		}

		function switchView(v) {
			if (state.view === v) return;
			state.view = v;
			if (v === 'withdraw') { state.phase = 'form'; }
			render();
		}

		// ── Withdraw view ─────────────────────────────────────────────────────
		function assetList() {
			const out = [];
			const { sol = 0, tokens = [] } = state.holdings || {};
			if (Number(sol) > 0) out.push({ kind: 'SOL', name: 'SOL', label: `SOL — ${fmtAmount(sol, 6)}`, max: sol, decimals: 9 });
			for (const t of tokens) {
				out.push({
					kind: t.mint,
					name: t.is_usdc ? 'USDC' : shortAddress(t.mint, 4, 4),
					label: `${t.is_usdc ? 'USDC' : shortAddress(t.mint, 4, 4)} — ${fmtAmount(t.ui_amount, t.decimals)}`,
					max: t.ui_amount, decimals: t.decimals, isUsdc: t.is_usdc,
				});
			}
			return out;
		}

		function renderUnsignable() {
			const retired = state.signableReason === 'key_retired';
			return `
				<div class="awh-card">
					<div class="awh-err" role="alert" style="margin-bottom:0;">
						<strong>This wallet can no longer be signed for.</strong>
						<div class="why" style="text-transform:none; margin-top:6px; line-height:1.5;">
							${retired
								? 'It was created under an earlier encryption key that the platform no longer holds, so withdrawals and trades from this address cannot be authorised. The balance is real and still on chain, it simply cannot be moved from here. Retrying will not help.'
								: 'The stored key for this address could not be read. Withdrawals are blocked until that is resolved so nothing is attempted against a wallet we cannot authorise.'}
						</div>
					</div>
					<p class="awh-note" style="margin-top:12px;">
						Contact support with this agent id before provisioning a replacement wallet:
						a new wallet gets a new address, and the balance at the old one stays where it is.
					</p>
					<div class="awh-chips" style="margin-top:12px;">
						<span class="awh-chip">Agent ${esc(String(ctx.agentId).slice(0, 8))}</span>
						<span class="awh-chip">${retired ? 'key retired' : 'key unreadable'}</span>
					</div>
					<div class="awh-actions">
						<a class="awh-btn" href="/support?topic=wallet-key&agent=${encodeURIComponent(ctx.agentId)}">Contact support</a>
						<button class="awh-btn" type="button" data-act="recheck-signable">Re-check</button>
					</div>
				</div>`;
		}

		function renderWithdraw() {
			if (state.phase === 'success') return renderSuccess();
			// Checked before holdings: a balance the owner cannot move must never be
			// rendered as a spendable amount with a live form under it.
			if (state.signable === false) return renderUnsignable();
			if (state.holdings === null && !state.holdingsErr) {
				return `<div class="awh-card"><div class="awh-skel-line" style="width:40%"></div><div class="awh-skel-line"></div><div class="awh-skel-line"></div><div class="awh-skel-line" style="width:60%"></div></div>`;
			}
			if (state.holdingsErr) {
				return `<div class="awh-card"><div class="awh-err" role="alert">Couldn’t load balances.<div class="why">${esc(state.holdingsErr)}</div></div><button class="awh-btn" type="button" data-act="reload-holdings">Retry</button></div>`;
			}
			const assets = assetList();
			if (!assets.length) {
				return `<div class="awh-card"><div class="awh-empty" style="text-align:center;padding:24px 8px;">This wallet holds no withdrawable funds on ${esc(ctx.getNetwork())}.<br>Fund it from the Deposit tab, then sweep funds out here.</div></div>`;
			}
			if (state.phase === 'confirm' && state.intent) return renderConfirm();

			const a = assets[Math.min(state.selectedAsset, assets.length - 1)];
			return `
				<div class="awh-card">
					<div class="awh-fld">
						<label for="awh-asset">Asset</label>
						<select class="awh-sel" id="awh-asset">
							${assets.map((x, i) => `<option value="${i}" ${i === state.selectedAsset ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}
						</select>
					</div>
					<div class="awh-fld">
						<label for="awh-dest">Destination address or .sol name</label>
						<div class="awh-row">
							<input class="awh-in" id="awh-dest" autocomplete="off" spellcheck="false" placeholder="Recipient wallet or name.sol" value="${esc(state.dest)}">
							<button class="awh-btn" id="awh-scan" type="button" aria-label="Scan a QR code" title="Scan a QR code" ${qrSupported() ? '' : 'style="display:none"'}>⛶</button>
						</div>
						<div class="awh-resolved" id="awh-resolved" role="status" aria-live="polite" hidden></div>
					</div>
					<div class="awh-fld">
						<label for="awh-amount">Amount</label>
						<div class="awh-row">
							<input class="awh-in" id="awh-amount" type="text" inputmode="decimal" placeholder="0.0" value="${esc(state.amount)}" aria-describedby="awh-avail">
							<button class="awh-btn" id="awh-max" type="button">Max</button>
						</div>
						<div class="awh-note" id="awh-avail">Available: ${esc(fmtAmount(a.max, a.decimals))} ${esc(a.name)}</div>
					</div>
					<div class="awh-err" id="awh-wd-err" role="alert" hidden></div>
					<button class="awh-btn awh-btn--primary" id="awh-review" type="button" style="width:100%;">Review withdrawal</button>
				</div>`;
		}

		function renderConfirm() {
			const it = state.intent;
			// Allowlist awareness: if the owner has set an allowlist, show whether this
			// destination is on it. The server enforces the allowlist regardless — this
			// is the in-form signal the audit flagged as missing.
			const allow = Array.isArray(state.limits?.limits?.withdraw_allowlist)
				? state.limits.limits.withdraw_allowlist
				: null;
			let destBadge = '';
			if (allow && allow.length) {
				destBadge = allow.includes(it.destination)
					? '<span class="awh-dest-tag ok">✓ allowlisted</span>'
					: '<span class="awh-dest-tag warn">⚠ not on allowlist — this will be rejected</span>';
			}
			return `
				<div class="awh-card">
					<div class="awh-sum">
						<div class="r"><span>Asset</span><span class="v">${esc(it.assetName)}</span></div>
						<div class="r"><span>Amount</span><span class="v">${it.isMax ? 'Max — ' : ''}${esc(fmtAmount(it.amount, it.decimals))} ${esc(it.assetName)}</span></div>
						<div class="r"><span>To</span><span class="v awh-mono" style="word-break:break-all;">${esc(it.destination)}${destBadge}</span></div>
						<div class="r"><span>Network</span><span class="v">${esc(ctx.getNetwork())}</span></div>
					</div>
					${it.kind === 'SOL' && it.isMax ? '<div class="awh-note">A little SOL is kept back to cover rent + network fees.</div>' : ''}
					<div class="awh-warn-irrev" role="note">⚠ Crypto transfers are final. Once submitted, this cannot be undone or reversed — double-check the destination address.</div>
					<div class="awh-err" id="awh-cf-err" role="alert" hidden></div>
					<div class="awh-actions">
						<button class="awh-btn" id="awh-back" type="button" style="flex:1;" ${state.phase === 'sending' ? 'disabled' : ''}>Back</button>
						<button class="awh-btn awh-btn--primary" id="awh-confirm" type="button" style="flex:2;" ${state.phase === 'sending' ? 'disabled' : ''}>
							${state.phase === 'sending' ? '<span class="awh-spin"></span>Submitting…' : 'Confirm withdrawal'}
						</button>
					</div>
				</div>`;
		}

		function renderSuccess() {
			const r = state.result || {};
			const net = ctx.getNetwork();
			const sig = r.signature || null;
			const explorer = r.explorer || (sig ? explorerTxUrl(sig, net) : null);
			const it = state.intent || {};
			return `
				<div class="awh-card awh-ok">
					<div class="ic">${state.unconfirmed ? '⏳' : '✓'}</div>
					<div style="font-size:var(--text-md,.8125rem);font-weight:600;color:var(--ink-bright,#fff);margin-bottom:4px;">
						${state.unconfirmed ? 'Withdrawal submitted' : 'Withdrawal confirmed'}
					</div>
					<div class="awh-empty" style="padding:0 0 12px;">
						${state.unconfirmed
							? 'Submitted to the network — confirm it on the explorer before retrying.'
							: `${esc(fmtAmount(it.amount, it.decimals))} ${esc(it.assetName)} sent to ${esc(shortAddress(it.destination, 6, 6))}.`}
					</div>
					${explorer ? `<a class="awh-btn awh-btn--primary" href="${esc(explorer)}" target="_blank" rel="noopener" style="text-decoration:none;display:inline-block;">View on explorer ↗</a>` : ''}
					<div style="margin-top:14px;"><button class="awh-btn" id="awh-again" type="button">Withdraw more</button></div>
				</div>`;
		}

		function wireWithdraw() {
			panel.querySelector('[data-act="reload-holdings"]')?.addEventListener('click', () => { state.holdings = null; state.holdingsErr = null; render(); loadHoldings(); });
			panel.querySelector('[data-act="recheck-signable"]')?.addEventListener('click', () => { state.signable = null; state.signableReason = null; render(); loadSignable(); loadHoldings(); });

			if (state.phase === 'success') {
				panel.querySelector('#awh-again')?.addEventListener('click', () => { resetForm(); state.holdings = null; render(); loadHoldings(); });
				return;
			}
			if (state.phase === 'confirm') {
				panel.querySelector('#awh-back')?.addEventListener('click', () => { state.phase = 'form'; render(); });
				panel.querySelector('#awh-confirm')?.addEventListener('click', submitWithdraw);
				return;
			}

			const assets = assetList();
			const assetSel = panel.querySelector('#awh-asset');
			const destInput = panel.querySelector('#awh-dest');
			const resolvedEl = panel.querySelector('#awh-resolved');
			const amountInput = panel.querySelector('#awh-amount');
			const availEl = panel.querySelector('#awh-avail');
			const errEl = panel.querySelector('#awh-wd-err');
			if (!assetSel) return;

			const currentAsset = () => assets[Math.min(Number(assetSel.value), assets.length - 1)];

			assetSel.addEventListener('change', () => {
				state.selectedAsset = Number(assetSel.value);
				const a = currentAsset();
				availEl.textContent = `Available: ${fmtAmount(a.max, a.decimals)} ${a.name}`;
			});
			amountInput.addEventListener('input', () => { state.amount = amountInput.value; });
			panel.querySelector('#awh-max')?.addEventListener('click', () => { amountInput.value = 'max'; state.amount = 'max'; });

			let seq = 0;
			async function doResolve() {
				const myId = ++seq;
				const raw = destInput.value.trim();
				state.dest = raw;
				state.resolvedDest = null;
				if (!raw) { resolvedEl.hidden = true; return; }
				if (SOL_ADDR_RE.test(raw)) {
					state.resolvedDest = raw;
					resolvedEl.hidden = false; resolvedEl.className = 'awh-resolved ok'; resolvedEl.textContent = `✓ ${shortAddress(raw, 6, 6)}`;
					return;
				}
				const res = await resolveRecipient(raw);
				if (myId !== seq) return;
				if (res.address) {
					state.resolvedDest = res.address;
					resolvedEl.hidden = false; resolvedEl.className = 'awh-resolved ok'; resolvedEl.textContent = `→ ${res.address}`;
				} else {
					resolvedEl.hidden = false; resolvedEl.className = 'awh-resolved warn'; resolvedEl.textContent = res.error || 'unresolved';
				}
			}
			destInput.addEventListener('input', () => { clearTimeout(destInput._t); destInput._t = setTimeout(doResolve, 250); });
			if (state.dest) doResolve();

			panel.querySelector('#awh-scan')?.addEventListener('click', async () => {
				const got = await scanQr();
				if (got) { destInput.value = got; doResolve(); }
			});

			panel.querySelector('#awh-review')?.addEventListener('click', async () => {
				errEl.hidden = true;
				const a = currentAsset();
				if (!state.resolvedDest) {
					await doResolve();
					if (!state.resolvedDest) { errEl.hidden = false; errEl.textContent = 'Enter a valid destination address or .sol name.'; return; }
				}
				const amtRaw = (amountInput.value || '').trim().toLowerCase();
				const isMax = amtRaw === 'max';
				const amt = isMax ? Number(a.max) : Number(amtRaw);
				if (!isMax && (!Number.isFinite(amt) || amt <= 0)) { errEl.hidden = false; errEl.textContent = 'Enter an amount, or tap Max.'; return; }
				if (!isMax && amt > Number(a.max) + 1e-12) { errEl.hidden = false; errEl.textContent = 'Amount exceeds the available balance.'; return; }
				state.intent = {
					kind: a.kind, assetName: a.name, decimals: a.decimals,
					isMax, amount: isMax ? Number(a.max) : amt, destination: state.resolvedDest,
					idem: (crypto?.randomUUID?.() || `wd-${Date.now()}-${Math.round(Math.random() * 1e9)}`),
				};
				state.phase = 'confirm';
				render();
				// Best-effort: pull the spend limits so the confirm step can show the
				// allowlist-match badge. Non-blocking — the irreversibility warning and
				// server-side enforcement do not depend on it.
				if (state.limits === null) loadLimits();
			});
		}

		async function submitWithdraw() {
			const it = state.intent;
			if (!it || state.phase === 'sending') return;
			if (ctx.getNetwork() !== 'devnet' && !(await ensureRiskAck({ context: 'withdraw' }))) return;
			state.phase = 'sending';
			render();
			const res = await call(base('withdraw'), {
				method: 'POST',
				body: { asset: it.kind, amount: it.isMax ? 'max' : it.amount, destination: it.destination, network: ctx.getNetwork(), idempotency_key: it.idem },
			});
			if (res.ok || res.status === 202) {
				state.result = res.ok ? res.data : (res.extra || {});
				state.unconfirmed = res.status === 202;
				state.phase = 'success';
				toast(state.unconfirmed ? 'Withdrawal submitted' : 'Withdrawal confirmed');
				render();
				// Refresh limits/activity next time they're opened.
				state.limits = null;
				return;
			}
			state.phase = 'confirm';
			render();
			const errEl = panel.querySelector('#awh-cf-err');
			if (errEl) {
				errEl.hidden = false;
				errEl.innerHTML = `${esc(res.message)}${res.code ? `<div class="why">${esc(res.code.replace(/_/g, ' '))}</div>` : ''}`;
			}
		}

		function resetForm() {
			state.phase = 'form'; state.intent = null; state.result = null;
			state.dest = ''; state.resolvedDest = null; state.amount = ''; state.selectedAsset = 0; state.unconfirmed = false;
		}

		async function loadHoldings() {
			const res = await call(`${base('holdings')}?network=${ctx.getNetwork()}`);
			if (destroyed) return;
			if (!res.ok) { state.holdingsErr = res.message; state.holdings = null; }
			else { state.holdingsErr = null; state.holdings = res.data; }
			if (state.view === 'withdraw') render();
		}

		// The owner's own wallet read carries `signable`. An older deployment that
		// does not send the field leaves it undefined, which stays null here and
		// keeps the form exactly as it was: this gate blocks only on a definite no.
		async function loadSignable() {
			const res = await call(`/api/agents/${encodeURIComponent(ctx.agentId)}/wallet?network=${ctx.getNetwork()}`);
			if (destroyed || !res.ok) return;
			if (res.data?.signable === false) {
				state.signable = false;
				state.signableReason = res.data.signable_reason || null;
			} else if (res.data?.signable === true) {
				state.signable = true;
				state.signableReason = null;
			}
			if (state.view === 'withdraw') render();
		}

		// ── Limits & Safety view ───────────────────────────────────────────────
		function renderLimits() {
			if (state.limits === null) {
				return `<div class="awh-card"><div class="awh-skel-line" style="width:50%"></div><div class="awh-skel-line"></div><div class="awh-skel-line"></div></div>`;
			}
			if (state.limits.error) {
				return `<div class="awh-card"><div class="awh-err" role="alert">Couldn’t load limits.<div class="why">${esc(state.limits.error)}</div></div><button class="awh-btn" type="button" data-act="reload-limits">Retry</button></div>`;
			}
			const lim = state.limits.limits || {};
			const spent = state.limits.spent_today_usd ?? 0;
			const allow = Array.isArray(lim.withdraw_allowlist) ? lim.withdraw_allowlist : [];
			const overDaily = lim.daily_usd != null && spent >= lim.daily_usd;
			const frozen = lim.frozen === true;
			return `
				<div class="awh-card awh-freeze-card${frozen ? ' is-frozen' : ''}">
					<div class="awh-freeze-row">
						<div class="awh-freeze-copy">
							<strong>${frozen ? '🔒 Wallet frozen' : 'Wallet active'}</strong>
							<span>${frozen
								? 'Autonomous spending (trades, snipes, payments) is paused. You can still withdraw funds out.'
								: 'Freeze to instantly pause all autonomous spending. Withdrawals stay available.'}</span>
						</div>
						<button class="awh-btn ${frozen ? 'awh-btn--primary' : 'awh-btn--danger'}" id="awh-freeze-btn" type="button"
							aria-pressed="${frozen}">${frozen ? 'Unfreeze' : 'Freeze wallet'}</button>
					</div>
				</div>
				<div class="awh-card">
					<div class="awh-chips">
						<span class="awh-chip${overDaily ? ' alert' : ''}">Spent today: ${esc(formatUsd(spent) || '$0.00')}</span>
						<span class="awh-chip">Daily cap: ${lim.daily_usd != null ? esc(formatUsd(lim.daily_usd)) : 'none'}</span>
						<span class="awh-chip">Per-tx cap: ${lim.per_tx_usd != null ? esc(formatUsd(lim.per_tx_usd)) : 'none'}</span>
					</div>
					<p class="awh-empty" style="margin-top:0;">These ceilings apply to every outbound path — trades, snipes, x402 payments and withdrawals. Leave a field blank for no limit.</p>
					<div class="awh-fld">
						<label for="awh-daily">Daily spend cap (USD)</label>
						<input class="awh-in" id="awh-daily" type="text" inputmode="decimal" placeholder="No limit" value="${lim.daily_usd != null ? esc(lim.daily_usd) : ''}">
					</div>
					<div class="awh-fld">
						<label for="awh-pertx">Per-transaction cap (USD)</label>
						<input class="awh-in" id="awh-pertx" type="text" inputmode="decimal" placeholder="No limit" value="${lim.per_tx_usd != null ? esc(lim.per_tx_usd) : ''}">
					</div>
					<div class="awh-fld">
						<label>Withdraw allowlist <span style="opacity:.6">(optional — restrict where funds can be swept)</span></label>
						<ul class="awh-allow" id="awh-allow">
							${allow.length ? allow.map((x) => `<li><span>${esc(x)}</span><button class="rm" type="button" data-a="${esc(x)}" aria-label="Remove ${esc(x)}">✕</button></li>`).join('') : '<li style="opacity:.6;border:0;">Any valid address allowed.</li>'}
						</ul>
						<div class="awh-row">
							<input class="awh-in" id="awh-allow-add" autocomplete="off" spellcheck="false" placeholder="Add an address or name.sol">
							<button class="awh-btn" id="awh-allow-btn" type="button">Add</button>
						</div>
					</div>
					<div class="awh-err" id="awh-lim-err" role="alert" hidden></div>
					<button class="awh-btn awh-btn--primary" id="awh-lim-save" type="button" style="width:100%;">Save limits</button>
				</div>`;
		}

		function wireLimits() {
			panel.querySelector('[data-act="reload-limits"]')?.addEventListener('click', () => { state.limits = null; render(); loadLimits(); });
			if (state.limits === null) { loadLimits(); return; }
			if (state.limits.error) return;

			const lim = state.limits.limits || {};
			const allowState = (Array.isArray(lim.withdraw_allowlist) ? lim.withdraw_allowlist : []).slice();
			const errEl = panel.querySelector('#awh-lim-err');

			// Freeze toggle — one tap, applied immediately (no Save). Freezing is the
			// safe direction; unfreezing resumes autonomous spending so we confirm it.
			const freezeBtn = panel.querySelector('#awh-freeze-btn');
			freezeBtn?.addEventListener('click', async () => {
				const currentlyFrozen = lim.frozen === true;
				if (currentlyFrozen && !confirm('Resume autonomous spending? The agent will be able to trade, snipe and pay from this wallet again.')) return;
				freezeBtn.disabled = true;
				freezeBtn.innerHTML = '<span class="awh-spin"></span>' + (currentlyFrozen ? 'Unfreezing…' : 'Freezing…');
				const res = await call(`${base('limits')}?network=${ctx.getNetwork()}`, { method: 'PUT', body: { frozen: !currentlyFrozen } });
				if (destroyed) return;
				if (!res.ok) {
					freezeBtn.disabled = false;
					freezeBtn.textContent = currentlyFrozen ? 'Unfreeze' : 'Freeze wallet';
					errEl.hidden = false; errEl.textContent = res.message;
					return;
				}
				state.limits = res.data;
				toast(currentlyFrozen ? 'Wallet unfrozen' : 'Wallet frozen — spending paused');
				render();
			});

			function repaint() {
				const ul = panel.querySelector('#awh-allow');
				if (!ul) return;
				ul.innerHTML = allowState.length
					? allowState.map((x) => `<li><span>${esc(x)}</span><button class="rm" type="button" data-a="${esc(x)}" aria-label="Remove">✕</button></li>`).join('')
					: '<li style="opacity:.6;border:0;">Any valid address allowed.</li>';
				ul.querySelectorAll('.rm').forEach((b) => b.addEventListener('click', () => {
					const i = allowState.indexOf(b.dataset.a);
					if (i >= 0) allowState.splice(i, 1);
					repaint();
				}));
			}
			repaint();

			panel.querySelector('#awh-allow-btn')?.addEventListener('click', async () => {
				const inp = panel.querySelector('#awh-allow-add');
				errEl.hidden = true;
				const res = await resolveRecipient(inp.value.trim());
				if (!res.address) { errEl.hidden = false; errEl.textContent = res.error || 'Invalid address.'; return; }
				if (!allowState.includes(res.address)) allowState.push(res.address);
				inp.value = '';
				repaint();
			});

			panel.querySelector('#awh-lim-save')?.addEventListener('click', async () => {
				const saveBtn = panel.querySelector('#awh-lim-save');
				errEl.hidden = true;
				const parse = (v) => (v.trim() === '' ? null : Number(v));
				const daily = parse(panel.querySelector('#awh-daily').value);
				const perTx = parse(panel.querySelector('#awh-pertx').value);
				if (daily != null && (!Number.isFinite(daily) || daily < 0)) { errEl.hidden = false; errEl.textContent = 'Daily cap must be a non-negative number.'; return; }
				if (perTx != null && (!Number.isFinite(perTx) || perTx < 0)) { errEl.hidden = false; errEl.textContent = 'Per-tx cap must be a non-negative number.'; return; }
				saveBtn.disabled = true;
				saveBtn.innerHTML = '<span class="awh-spin"></span>Saving…';
				const res = await call(`${base('limits')}?network=${ctx.getNetwork()}`, { method: 'PUT', body: { daily_usd: daily, per_tx_usd: perTx, withdraw_allowlist: allowState } });
				if (destroyed) return;
				if (!res.ok) {
					saveBtn.disabled = false; saveBtn.textContent = 'Save limits';
					errEl.hidden = false; errEl.textContent = res.message;
					return;
				}
				state.limits = res.data;
				toast('Limits saved');
				render();
			});
		}

		async function loadLimits() {
			const res = await call(`${base('limits')}?network=${ctx.getNetwork()}`);
			if (destroyed) return;
			state.limits = res.ok ? res.data : { error: res.message };
			// Re-render on the limits view (full panel) or the withdraw confirm step,
			// where the freshly-loaded allowlist drives the destination badge.
			if (state.view === 'limits' || state.phase === 'confirm') render();
		}

		// ── Activity view (custody audit trail) ─────────────────────────────────
		function mountActivity(host) {
			if (!host) return;
			const items = [];
			let cursor = null;
			let exhausted = false;
			host.innerHTML = `<div class="awh-skel-line"></div><div class="awh-skel-line"></div><div class="awh-skel-line" style="width:70%"></div>`;

			const META = {
				key_recover: { ic: '🔑', label: 'Key recovered to sign' },
				limit_change: { ic: '⚙', label: 'Limits updated' },
			};
			const CAT = { trade: 'Trade', snipe: 'Snipe', x402: 'x402 payment', withdraw: 'Withdrawal' };
			// A spend row marked failed by a policy rule (reason policy_*) is a payment
			// the natural-language policy STOPPED — surfaced inline so the owner sees
			// exactly which rule fired. A limit_change with a policy reason is a
			// policy edit / auto-freeze.
			const isPolicyBlock = (e) => e.event_type === 'spend' && typeof e.reason === 'string' && e.reason.startsWith('policy_');
			const isPolicyChange = (e) => e.event_type === 'limit_change' && (e.reason === 'policy_updated' || e.reason === 'policy_freeze');
			const ruleText = (e) => (e.meta && typeof e.meta === 'object' ? (e.meta.rule || null) : null);
			const title = (e) => {
				if (isPolicyBlock(e)) return e.reason === 'policy_freeze' ? 'Frozen by your rule' : e.reason === 'policy_step_up' ? 'Needs your approval' : 'Blocked by your rule';
				if (isPolicyChange(e)) return e.reason === 'policy_freeze' ? 'Auto-frozen by policy' : 'Spend policy updated';
				return e.event_type === 'spend' ? (CAT[e.category] || 'Spend') : (META[e.event_type]?.label || e.event_type);
			};
			const icon = (e) => {
				if (isPolicyBlock(e) || isPolicyChange(e)) return '🛡';
				return e.event_type === 'spend' ? (e.category === 'withdraw' ? '↑' : '💸') : (META[e.event_type]?.ic || '•');
			};

			function renderEvent(e) {
				let amt = '';
				if (e.asset === 'SOL' && e.amount_lamports != null) amt = `${fmtAmount(Number(e.amount_lamports) / 1e9, 6)} SOL`;
				else if (e.usd != null) amt = formatUsd(e.usd) || '';
				else if (e.asset && e.asset !== 'SOL') amt = shortAddress(e.asset, 4, 4);
				const policyNote = (isPolicyBlock(e) || isPolicyChange(e)) ? ruleText(e) : null;
				const when = e.created_at ? new Date(e.created_at).toLocaleString() : '';
				const sub = [
					e.destination ? `→ ${shortAddress(e.destination, 4, 4)}` : '',
					policyNote ? `“${esc(policyNote)}”` : '',
					e.event_type === 'key_recover' && e.reason ? esc(e.reason) : '',
					e.status && e.status !== 'ok' && e.status !== 'confirmed' && !isPolicyBlock(e) ? `[${esc(e.status)}]` : '',
					esc(when),
				].filter(Boolean).join(' · ');
				return `<li class="awh-ev"><span class="ic">${icon(e)}</span><span class="m"><span class="ttl">${esc(title(e))}</span><span class="sb">${sub}${e.explorer ? ` · <a href="${esc(e.explorer)}" target="_blank" rel="noopener">tx ↗</a>` : ''}</span></span><span class="amt">${esc(amt)}</span></li>`;
			}

			function paint() {
				if (!items.length) {
					host.innerHTML = `<div class="awh-empty" style="text-align:center;padding:24px 8px;">No custody activity yet on ${esc(ctx.getNetwork())}.<br>Withdrawals, automated spends and limit changes appear here.</div>`;
					return;
				}
				host.innerHTML = `<ul class="awh-evs">${items.map(renderEvent).join('')}</ul>${exhausted ? '' : '<button class="awh-btn" id="awh-more" type="button" style="width:100%;margin-top:10px;">Load older</button>'}`;
				host.querySelector('#awh-more')?.addEventListener('click', (ev) => { ev.target.disabled = true; ev.target.innerHTML = '<span class="awh-spin"></span>Loading…'; loadPage(); });
			}

			async function loadPage() {
				const url = `${base('custody')}?network=${ctx.getNetwork()}&limit=25${cursor ? `&before=${cursor}` : ''}`;
				const res = await call(url);
				if (destroyed) return;
				if (!res.ok) { host.innerHTML = `<div class="awh-err" role="alert">Couldn’t load activity.<div class="why">${esc(res.message)}</div></div><button class="awh-btn" type="button" data-act="reload-activity" style="margin-top:10px;">Retry</button>`; host.querySelector('[data-act="reload-activity"]')?.addEventListener('click', () => { host.innerHTML = `<div class="awh-skel-line"></div><div class="awh-skel-line"></div><div class="awh-skel-line" style="width:70%"></div>`; loadPage(); }); return; }
				items.push(...(res.data?.items || []));
				cursor = res.data?.next_cursor || null;
				exhausted = !cursor;
				paint();
			}
			loadPage();
		}

		// React to a network switch from the hub header.
		detachNet = ctx.onNetworkChange(() => {
			state.holdings = null; state.holdingsErr = null; state.limits = null;
			resetForm();
			render();
			if (state.view === 'withdraw') loadHoldings();
			else if (state.view === 'limits') loadLimits();
		});

		render();

		return {
			onShow() {
				if (state.view === 'withdraw' && state.signable === null) loadSignable();
				if (state.view === 'withdraw' && state.holdings === null && state.phase !== 'success') loadHoldings();
				else if (state.view === 'limits' && state.limits === null) loadLimits();
			},
			destroy() { destroyed = true; detachNet?.(); },
		};
	},
});
