/**
 * Agent Wallet hub — Vanity tab.
 *
 * Owner-only. Grind a custom vanity address for the agent's custodial Solana
 * wallet, with a per-agent prefix/suffix the owner chooses.
 *
 * The grind runs IN THE BROWSER using the same worker-pool WASM grinder as
 * /vanity-wallet (src/solana/vanity/grinder.js) — the owner picks how many CPU
 * cores to spend, can match case-insensitively, pause/resume at will, and there
 * is no serverless time budget to time out against. Once a match is found the
 * 64-byte keypair is POSTed to /api/agents/:id/solana/vanity, which re-derives
 * the address, proves it matches the requested pattern, sweeps every asset from
 * the old wallet to the new one, and only then swaps the stored key — so funds
 * can never be stranded (the swap aborts if the sweep fails).
 *
 * This replaces the old server-side grind, which was bounded to ≤3 chars and
 * timed out on anything harder.
 */

import { registerWalletTab } from '../registry.js';
import { consumeCsrfToken } from '../../api.js';
import { grindVanity } from '../../solana/vanity/grinder.js';
import { validatePattern, expectedAttempts, formatTimeEstimate, MAX_PATTERN_LENGTH } from '../../solana/vanity/validation.js';

// Per-core grind throughput, used only for the pre-grind time estimate. The
// live ETA during grinding comes from the workers' real measured rate.
const EST_KEYS_PER_CORE_PER_SEC = 15000;

const VN_STYLE_ID = 'awh-vanity-style';
const VN_STYLE = `
.awh-vn-head{display:flex;align-items:center;gap:10px;margin-bottom:var(--space-4,16px);}
.awh-vn-addr{font-family:var(--font-mono,ui-monospace,monospace);font-size:var(--text-md,.8125rem);color:var(--ink,#e8e8e8);word-break:break-all;}
.awh-vn-addr b{color:#a78bfa;}
.awh-vn-tag{font-size:var(--text-2xs,.6875rem);font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#a78bfa;background:rgba(139,92,246,.15);border:1px solid rgba(139,92,246,.4);border-radius:999px;padding:2px 8px;}
.awh-vn-grid{display:flex;gap:10px;}
.awh-vn-grid .awh-fld{flex:1;}
.awh-vn-est{font-size:var(--text-sm,.764rem);color:var(--ink-dim,#888);margin:2px 0 var(--space-3,12px);}
.awh-vn-est b{color:var(--ink,#e8e8e8);}
.awh-vn-est.warn{color:var(--warn,#fbbf24);}
.awh-vn-toggle{display:flex;align-items:center;gap:8px;font-size:var(--text-sm,.764rem);color:var(--ink-dim,#888);margin-bottom:var(--space-3,12px);cursor:pointer;}
.awh-vn-warn{background:color-mix(in srgb, var(--warn,#fbbf24) 10%, transparent);border:1px solid color-mix(in srgb, var(--warn,#fbbf24) 28%, transparent);color:var(--warn,#fbbf24);border-radius:var(--radius-md,10px);padding:10px 12px;font-size:var(--text-sm,.764rem);margin-bottom:var(--space-3,12px);line-height:1.45;}
.awh-vn-out{font-family:var(--font-mono,ui-monospace,monospace);font-size:var(--text-2xs,.6875rem);color:var(--ink-dim,#888);}

/* Compute / core selector */
.awh-vn-cores{margin:var(--space-3,12px) 0;padding-top:var(--space-3,12px);border-top:1px solid var(--line,rgba(255,255,255,.08));}
.awh-vn-cores-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;}
.awh-vn-cores-head label{margin:0;font-size:var(--text-sm,.764rem);color:var(--ink-dim,#888);}
.awh-vn-cores-val{font-family:var(--font-mono,ui-monospace,monospace);font-size:var(--text-sm,.8rem);color:var(--ink-dim,#888);}
.awh-vn-cores-val b{color:var(--ink-bright,#fff);font-size:.95rem;}
.awh-vn-cores input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:999px;background:var(--line,rgba(255,255,255,.14));outline:none;cursor:pointer;}
.awh-vn-cores input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;border-radius:50%;background:#a78bfa;cursor:pointer;transition:transform .12s ease;}
.awh-vn-cores input[type=range]::-webkit-slider-thumb:hover{transform:scale(1.15);}
.awh-vn-cores input[type=range]::-moz-range-thumb{width:16px;height:16px;border:none;border-radius:50%;background:#a78bfa;cursor:pointer;}
.awh-vn-cores input[type=range]:disabled{opacity:.4;cursor:not-allowed;}
.awh-vn-cores input[type=range]:focus-visible{box-shadow:0 0 0 2px rgba(167,139,250,.5);}
.awh-vn-ticks{display:flex;gap:6px;margin-top:8px;}
.awh-vn-ticks button{flex:0 0 auto;font-size:var(--text-2xs,.6875rem);padding:3px 9px;border-radius:999px;border:1px solid var(--line,rgba(255,255,255,.14));background:transparent;color:var(--ink-dim,#888);cursor:pointer;transition:background .12s,border-color .12s,color .12s;}
.awh-vn-ticks button:hover{border-color:rgba(167,139,250,.5);color:var(--ink,#e8e8e8);}
.awh-vn-ticks button[aria-pressed=true]{background:#a78bfa;border-color:#a78bfa;color:#1a1130;font-weight:600;}

/* Live grind progress */
.awh-vn-prog{text-align:center;padding:var(--space-3,12px) 0;}
.awh-vn-prog-rate{font-family:var(--font-mono,ui-monospace,monospace);font-size:1.6rem;font-weight:700;color:var(--ink-bright,#fff);line-height:1.1;}
.awh-vn-prog-sub{font-size:var(--text-2xs,.6875rem);color:var(--ink-dim,#888);margin-top:4px;}
.awh-vn-prog-grid{display:flex;justify-content:center;gap:18px;margin-top:10px;}
.awh-vn-prog-grid div{font-size:var(--text-2xs,.6875rem);color:var(--ink-dim,#888);}
.awh-vn-prog-grid b{display:block;font-family:var(--font-mono,ui-monospace,monospace);font-size:var(--text-sm,.8rem);color:var(--ink,#e8e8e8);font-weight:600;margin-top:2px;}
.awh-vn-paused{display:inline-block;margin-left:8px;font-size:var(--text-2xs,.625rem);font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--warn,#fbbf24);background:color-mix(in srgb,var(--warn,#fbbf24) 14%,transparent);border-radius:999px;padding:1px 7px;}
.awh-vn-actions{display:flex;gap:8px;margin-top:var(--space-3,12px);}
.awh-vn-actions .awh-btn{flex:1;}

@media (prefers-reduced-motion: reduce){
	.awh-vn-cores input[type=range]::-webkit-slider-thumb{transition:none;}
	.awh-vn-cores input[type=range]::-webkit-slider-thumb:hover{transform:none;}
	.awh-vn-ticks button{transition:none;}
}
@media (max-width: 400px){
	.awh-vn-prog-grid{gap:12px;}
	.awh-vn-actions{flex-wrap:wrap;}
}
`;

function injectStyle() {
	if (typeof document === 'undefined' || document.getElementById(VN_STYLE_ID)) return;
	const tag = document.createElement('style');
	tag.id = VN_STYLE_ID;
	tag.textContent = VN_STYLE;
	document.head.appendChild(tag);
}

async function call(url, { method = 'GET', body = null } = {}) {
	try {
		const opts = { method, credentials: 'include', headers: {} };
		if (body != null) {
			opts.headers['content-type'] = 'application/json';
			opts.body = JSON.stringify(body);
		}
		// Assigning a vanity address swaps the keypair and sweeps funds — the POST is
		// state-changing, so carry a single-use CSRF token (server burns it on use).
		if (method !== 'GET') {
			const token = await consumeCsrfToken();
			if (token) opts.headers['x-csrf-token'] = token;
		}
		const r = await fetch(url, opts);
		let j = null;
		try { j = await r.json(); } catch { /* empty body */ }
		if (!r.ok) return { ok: false, status: r.status, code: j?.error || 'error', message: j?.error_description || `request failed (${r.status})` };
		return { ok: true, status: r.status, data: j?.data ?? j };
	} catch (err) {
		return { ok: false, status: 0, code: 'network_error', message: err?.message || 'network error' };
	}
}

const HW_CORES = Math.max(1, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4);
const DEFAULT_CORES = Math.max(1, Math.min(HW_CORES, Math.round(HW_CORES / 2)));
// Quick presets: 1, balanced default, max — deduped for low-core machines.
const PRESETS = [...new Set([1, DEFAULT_CORES, HW_CORES])].sort((a, b) => a - b);

function fmtRate(r) {
	if (!r || r < 1) return '0';
	if (r >= 1e6) return `${(r / 1e6).toFixed(1)}M`;
	if (r >= 1e3) return `${(r / 1e3).toFixed(1)}k`;
	return String(Math.round(r));
}

registerWalletTab({
	id: 'vanity',
	label: 'Vanity',
	order: 50,
	ownerOnly: true,
	mount({ panel, ctx }) {
		injectStyle();
		const esc = ctx.escapeHtml;
		const { toast } = ctx;
		const base = `/api/agents/${encodeURIComponent(ctx.agentId)}/solana/vanity`;

		let destroyed = false;
		let controller = null; // grindVanity pause/resume/stop handle while grinding

		const state = {
			status: null,       // { address, vanity_prefix, vanity_suffix, is_vanity } | { error }
			prefix: '',
			suffix: '',
			ignoreCase: false,
			cores: DEFAULT_CORES,
			phase: 'form',      // 'form' | 'grinding' | 'applying' | 'apply_failed' | 'success'
			progress: null,     // { attempts, rate, eta, paused }
			ground: null,       // { secretKey, address, attempts, durationMs } once a match is found
			applyError: null,
			result: null,       // server response after a successful assign
		};

		function patternError() {
			for (const [val, label] of [[state.prefix, 'prefix'], [state.suffix, 'suffix']]) {
				if (!val) continue;
				const v = validatePattern(val);
				if (!v.valid) return `Invalid ${label}: ${v.errors.join('; ')}`;
			}
			return null;
		}

		function highlight(addr, p, sf) {
			const a = addr || '';
			let html = esc(a);
			const hasP = p && a.startsWith(p);
			const hasS = sf && a.endsWith(sf);
			if (hasP && hasS) {
				const mid = a.slice(p.length, a.length - sf.length);
				html = `<b>${esc(p)}</b>${esc(mid)}<b>${esc(sf)}</b>`;
			} else if (hasP) {
				html = `<b>${esc(p)}</b>${esc(a.slice(p.length))}`;
			} else if (hasS) {
				html = `${esc(a.slice(0, a.length - sf.length))}<b>${esc(sf)}</b>`;
			}
			return html;
		}

		function currentAddrHTML() {
			const s = state.status;
			if (!s || s.error || !s.address) return '';
			return highlight(s.address, s.vanity_prefix, s.vanity_suffix);
		}

		function estLine() {
			const combined = state.prefix.length + state.suffix.length;
			if (combined === 0) return { html: 'Enter a prefix and/or suffix (base58 — no 0, O, I or l).', warn: false };
			const perr = patternError();
			if (perr) return { html: esc(perr), warn: true };
			const expected = expectedAttempts(state.prefix, state.suffix, state.ignoreCase);
			const eta = formatTimeEstimate(expected, state.cores * EST_KEYS_PER_CORE_PER_SEC);
			const hard = expected > 5e8;
			return {
				html: `≈ <b>${Math.round(expected).toLocaleString()}</b> attempts · about <b>${esc(eta)}</b> on ${state.cores} core${state.cores > 1 ? 's' : ''}${hard ? ' — this one is hard, grinding may take a while' : ''}.`,
				warn: hard,
			};
		}

		function render() {
			if (destroyed) return;
			if (state.status === null) {
				panel.innerHTML = `<div class="awh-card"><div class="awh-skel-line" style="width:45%"></div><div class="awh-skel-line"></div><div class="awh-skel-line" style="width:70%"></div></div>`;
				return;
			}
			if (state.phase === 'success') { panel.innerHTML = renderSuccess(); wireSuccess(); return; }
			if (state.phase === 'grinding' || state.phase === 'applying') { panel.innerHTML = renderGrinding(); wireGrinding(); return; }
			panel.innerHTML = renderForm(); wireForm();
		}

		function renderForm() {
			const s = state.status;
			const isVanity = !!(s && !s.error && s.is_vanity);
			const hasWallet = !!(s && !s.error && s.address);
			const est = estLine();
			const ph = ((ctx.agent?.name || 'ag').toLowerCase().replace(/[^1-9a-hj-np-za-km-z]/gi, '').slice(0, 4)) || 'ag';

			return `
				<div class="awh-card">
					${s?.error ? `<div class="awh-err" role="alert">Couldn’t load wallet. <div class="why">${esc(s.error)}</div></div>` : `
					<div class="awh-vn-head">
						<div>
							<div class="awh-card-h" style="margin-bottom:4px;">Current address ${isVanity ? '<span class="awh-vn-tag">vanity</span>' : ''}</div>
							<div class="awh-vn-addr">${currentAddrHTML() || '<span class="awh-empty">No wallet yet — grinding one will provision it.</span>'}</div>
						</div>
					</div>`}

					<p class="awh-empty" style="margin-top:0;">
						Grind a custom address for this agent's wallet with your CPU. The match is found in your browser; the key is then stored server-side — it never leaves three.ws.
					</p>

					<div class="awh-vn-grid">
						<div class="awh-fld">
							<label for="awh-vn-prefix">Starts with</label>
							<input class="awh-in awh-mono" id="awh-vn-prefix" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="${MAX_PATTERN_LENGTH}" aria-describedby="awh-vn-est" placeholder="e.g. ${esc(ph)}" value="${esc(state.prefix)}">
						</div>
						<div class="awh-fld">
							<label for="awh-vn-suffix">Ends with</label>
							<input class="awh-in awh-mono" id="awh-vn-suffix" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="${MAX_PATTERN_LENGTH}" aria-describedby="awh-vn-est" placeholder="optional" value="${esc(state.suffix)}">
						</div>
					</div>

					<label class="awh-vn-toggle">
						<input type="checkbox" id="awh-vn-ic" ${state.ignoreCase ? 'checked' : ''}>
						Case-insensitive (faster, matches any capitalization)
					</label>

					<div class="awh-vn-cores">
						<div class="awh-vn-cores-head">
							<label for="awh-vn-cores">Compute — CPU cores</label>
							<span class="awh-vn-cores-val"><b id="awh-vn-cores-val">${state.cores}</b> / ${HW_CORES}</span>
						</div>
						<input id="awh-vn-cores" type="range" min="1" max="${HW_CORES}" step="1" value="${state.cores}" aria-label="Number of CPU cores to grind with">
						<div class="awh-vn-ticks" id="awh-vn-ticks" aria-label="Quick core presets">
							${PRESETS.map((n) => `<button type="button" data-cores="${n}" aria-pressed="${n === state.cores}">${n === 1 ? '1 core' : n === HW_CORES ? `Max (${n})` : String(n)}</button>`).join('')}
						</div>
					</div>

					<div class="awh-vn-est ${est.warn ? 'warn' : ''}" id="awh-vn-est" role="status" aria-live="polite">${est.html}</div>

					${isVanity || hasWallet
						? `<div class="awh-vn-warn">⚠ This replaces the agent's current address. Any SOL or tokens it holds are <b>automatically swept to the new address</b> first — the swap only completes once funds have moved. Apps pointed at the old address must be updated.</div>`
						: ''}

					<div class="awh-err" id="awh-vn-err" role="alert" hidden></div>
					<button class="awh-btn awh-btn--primary" id="awh-vn-go" type="button" style="width:100%;">Grind &amp; apply vanity address</button>
				</div>`;
		}

		function renderGrinding() {
			const applying = state.phase === 'applying';
			const p = state.progress || { attempts: 0, rate: 0, eta: '—', paused: false };
			const paused = !!p.paused;
			return `
				<div class="awh-card">
					<div class="awh-card-h" style="margin-bottom:2px;">Grinding <span class="awh-mono" style="color:#a78bfa;">${esc(state.prefix)}${state.prefix && state.suffix ? '…' : ''}${esc(state.suffix)}</span></div>
					<div class="awh-vn-prog" role="status" aria-live="polite" aria-label="Grind progress">
						<div class="awh-vn-prog-rate" id="awh-vn-rate">${applying ? '✦' : fmtRate(p.rate)}<span style="font-size:.9rem;font-weight:500;color:var(--ink-dim,#888);">${applying ? '' : ' /s'}</span><span class="awh-vn-paused" id="awh-vn-paused" ${paused ? '' : 'hidden'}>paused</span></div>
						<div class="awh-vn-prog-sub">${applying ? 'Match found — migrating funds &amp; applying…' : `across ${state.cores} core${state.cores > 1 ? 's' : ''}`}</div>
						<div class="awh-vn-prog-grid">
							<div>attempts<b id="awh-vn-attempts">${Math.round(p.attempts).toLocaleString()}</b></div>
							<div>eta<b id="awh-vn-eta">${applying ? '—' : esc(p.eta || '—')}</b></div>
						</div>
					</div>
					${applying
						? `<div class="awh-empty" style="text-align:center;">Sweeping any existing balance to the new address, then swapping the key. Don't close this tab.</div>`
						: `<div class="awh-vn-actions">
								<button class="awh-btn" id="awh-vn-pause" type="button">${paused ? 'Resume' : 'Pause'}</button>
								<button class="awh-btn" id="awh-vn-cancel" type="button">Cancel</button>
							</div>`}
				</div>`;
		}

		function renderSuccess() {
			const r = state.result || {};
			const net = ctx.getNetwork();
			const explorer = net === 'devnet'
				? `https://explorer.solana.com/address/${r.address}?cluster=devnet`
				: `https://solscan.io/account/${r.address}`;
			const sweptLine = r.swept
				? `<div class="awh-empty" style="padding:0 0 8px;">Migrated ${r.swept.sol ? `${r.swept.sol} SOL` : 'funds'}${r.swept.tokens?.length ? ` + ${r.swept.tokens.length} token${r.swept.tokens.length > 1 ? 's' : ''}` : ''} from the old address.</div>`
				: '';
			return `
				<div class="awh-card awh-ok" role="status">
					<div class="ic" aria-hidden="true">✦</div>
					<div style="font-size:var(--text-md,.8125rem);font-weight:600;color:var(--ink-bright,#fff);margin-bottom:6px;">Vanity address applied</div>
					<div class="awh-vn-addr" style="margin-bottom:8px;">${highlight(r.address, r.vanity_prefix, r.vanity_suffix)}</div>
					${sweptLine}
					${r.iterations != null ? `<div class="awh-vn-out">Found in ${Number(r.iterations).toLocaleString()} attempts${r.duration_ms != null ? ` · ${(r.duration_ms / 1000).toFixed(1)}s` : ''}</div>` : ''}
					<div style="margin-top:14px;display:flex;gap:8px;justify-content:center;">
						<a class="awh-btn awh-btn--primary" href="${esc(explorer)}" target="_blank" rel="noopener" style="text-decoration:none;">View on explorer ↗</a>
						<button class="awh-btn" id="awh-vn-again" type="button">Change again</button>
					</div>
				</div>`;
		}

		// Patch the live numbers without a full re-render so the readout stays smooth.
		function updateProgressUI() {
			if (destroyed || state.phase !== 'grinding') return;
			const p = state.progress || {};
			const rate = panel.querySelector('#awh-vn-rate');
			const attempts = panel.querySelector('#awh-vn-attempts');
			const eta = panel.querySelector('#awh-vn-eta');
			const paused = panel.querySelector('#awh-vn-paused');
			if (rate) rate.firstChild && (rate.firstChild.textContent = p.paused ? '0' : fmtRate(p.rate));
			if (attempts) attempts.textContent = Math.round(p.attempts || 0).toLocaleString();
			if (eta) eta.textContent = p.paused ? 'paused' : (p.eta || '—');
			if (paused) paused.hidden = !p.paused;
		}

		function showErr(msg) {
			const e = panel.querySelector('#awh-vn-err');
			if (e) { e.hidden = false; e.textContent = msg; }
		}

		async function applyGround() {
			state.phase = 'applying';
			state.applyError = null;
			render();
			const g = state.ground;
			const res = await call(base, {
				method: 'POST',
				body: {
					secret_key: Array.from(g.secretKey),
					prefix: state.prefix || undefined,
					suffix: state.suffix || undefined,
					ignoreCase: state.ignoreCase,
					iterations: g.attempts,
					duration_ms: Math.round(g.durationMs),
					network: ctx.getNetwork(),
				},
			});
			if (destroyed) return;
			if (!res.ok) {
				// Keep the ground key in memory so the owner can retry the assign
				// without re-grinding (e.g. a transient RPC/sweep failure).
				state.phase = 'apply_failed';
				state.applyError = res.message;
				renderApplyFailed();
				return;
			}
			state.result = res.data;
			state.ground = null;
			state.phase = 'success';
			toast('Vanity address applied');
			render();
		}

		function renderApplyFailed() {
			const g = state.ground || {};
			panel.innerHTML = `
				<div class="awh-card">
					<div class="awh-err" role="alert" style="margin-bottom:12px;">Couldn’t apply the address. <div class="why">${esc(state.applyError || 'unknown error')}</div></div>
					<p class="awh-empty" style="margin-top:0;">Your wallet is unchanged and still holds any funds. The ground address is ready — retry the assign without grinding again.</p>
					<div class="awh-vn-addr" style="margin:8px 0 12px;">${highlight(g.address, state.prefix, state.suffix)}</div>
					<div class="awh-vn-actions">
						<button class="awh-btn awh-btn--primary" id="awh-vn-retry" type="button">Retry assign</button>
						<button class="awh-btn" id="awh-vn-discard" type="button">Discard</button>
					</div>
				</div>`;
			panel.querySelector('#awh-vn-retry')?.addEventListener('click', applyGround);
			panel.querySelector('#awh-vn-discard')?.addEventListener('click', () => {
				state.ground = null; state.applyError = null; state.phase = 'form'; render();
			});
		}

		async function startGrind() {
			const combined = state.prefix.length + state.suffix.length;
			if (combined === 0) { showErr('Enter a prefix and/or suffix first.'); return; }
			const perr = patternError();
			if (perr) { showErr(perr); return; }

			state.phase = 'grinding';
			state.progress = { attempts: 0, rate: 0, eta: '—', paused: false };
			render();

			controller = {};
			let result;
			try {
				result = await grindVanity({
					prefix: state.prefix || '',
					suffix: state.suffix || '',
					ignoreCase: state.ignoreCase,
					maxWorkers: state.cores,
					controller,
					onProgress: (p) => {
						if (destroyed || state.phase !== 'grinding') return;
						state.progress = p;
						updateProgressUI();
					},
				});
			} catch (e) {
				controller = null;
				if (destroyed) return;
				if (e?.name === 'AbortError') { state.phase = 'form'; render(); return; }
				state.phase = 'form';
				render();
				showErr(e?.message || 'grind failed — try again');
				return;
			}
			controller = null;
			if (destroyed) return;
			state.ground = {
				secretKey: result.secretKey,
				address: result.publicKey,
				attempts: result.attempts,
				durationMs: result.durationMs,
			};
			await applyGround();
		}

		function wireGrinding() {
			updateProgressUI();
			panel.querySelector('#awh-vn-pause')?.addEventListener('click', () => {
				if (!controller) return;
				if (controller.paused) controller.resume(); else controller.pause();
				// Reflect the toggle immediately; live numbers keep flowing via onProgress.
				state.progress = { ...(state.progress || {}), paused: !!controller.paused };
				const btn = panel.querySelector('#awh-vn-pause');
				if (btn) btn.textContent = controller.paused ? 'Resume' : 'Pause';
				updateProgressUI();
			});
			panel.querySelector('#awh-vn-cancel')?.addEventListener('click', () => {
				if (controller?.stop) controller.stop();
			});
		}

		function wireSuccess() {
			panel.querySelector('#awh-vn-again')?.addEventListener('click', () => {
				state.phase = 'form'; state.result = null; state.prefix = ''; state.suffix = '';
				loadStatus();
			});
		}

		function wireForm() {
			const pIn = panel.querySelector('#awh-vn-prefix');
			const sIn = panel.querySelector('#awh-vn-suffix');
			const ic = panel.querySelector('#awh-vn-ic');
			const estEl = panel.querySelector('#awh-vn-est');
			const slider = panel.querySelector('#awh-vn-cores');
			const coresVal = panel.querySelector('#awh-vn-cores-val');
			const ticks = panel.querySelector('#awh-vn-ticks');

			const clean = (v) => (v || '').replace(/[^1-9A-HJ-NP-Za-km-z]/g, '').slice(0, MAX_PATTERN_LENGTH);
			function refreshEst() {
				const est = estLine();
				estEl.className = `awh-vn-est ${est.warn ? 'warn' : ''}`;
				estEl.innerHTML = est.html;
			}
			function setCores(n) {
				state.cores = Math.max(1, Math.min(HW_CORES, n | 0));
				if (slider) slider.value = String(state.cores);
				if (coresVal) coresVal.textContent = String(state.cores);
				ticks?.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.cores) === state.cores)));
				refreshEst();
			}

			pIn?.addEventListener('input', () => { const c = clean(pIn.value); if (c !== pIn.value) pIn.value = c; state.prefix = c; refreshEst(); });
			sIn?.addEventListener('input', () => { const c = clean(sIn.value); if (c !== sIn.value) sIn.value = c; state.suffix = c; refreshEst(); });
			ic?.addEventListener('change', () => { state.ignoreCase = ic.checked; refreshEst(); });
			slider?.addEventListener('input', () => setCores(Number(slider.value)));
			ticks?.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setCores(Number(b.dataset.cores))));

			panel.querySelector('#awh-vn-go')?.addEventListener('click', () => {
				const err = panel.querySelector('#awh-vn-err');
				if (err) err.hidden = true;
				startGrind();
			});
		}

		// The hub mounts a tab and then calls onShow() on the same activation, so an
		// unguarded loadStatus() fired the wallet read twice on every first open.
		// Reuse the in-flight promise instead of issuing a second request.
		let statusInFlight = null;
		function loadStatus() {
			if (statusInFlight) return statusInFlight;
			state.status = null;
			render();
			statusInFlight = call(base)
				.then((res) => {
					if (destroyed) return;
					state.status = res.ok ? res.data : { error: res.message };
					render();
				})
				.finally(() => {
					statusInFlight = null;
				});
			return statusInFlight;
		}

		loadStatus();

		return {
			onShow() { if (state.status === null) loadStatus(); },
			destroy() {
				destroyed = true;
				// Free the worker pool if the owner navigates away mid-grind.
				if (controller?.stop) { try { controller.stop(); } catch { /* already settled */ } }
			},
		};
	},
});
