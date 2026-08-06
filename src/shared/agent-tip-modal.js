/**
 * Tip-an-agent modal — the shared, surface-agnostic UI for sending a
 * non-custodial tip to any agent's public Solana wallet.
 *
 * Opened from the wallet chip (every avatar/agent surface) and the wallet hub's
 * Tip tab. It owns nothing the caller can't pass in: an agent record with a
 * public address. It never shows owner-only controls — tipping is a public,
 * viewer-signed action (see ./agent-tip.js). For an agent that advertises a
 * preferred payment asset (meta.payments.accepted_tokens) the modal defaults to
 * that token, which is how a visitor "pays" the agent rather than just tipping.
 *
 * Every state is designed: idle, the live send lifecycle (connect → build →
 * sign → send → confirm), success (with a real Solscan receipt), and an
 * actionable error. No fake progress — each stage label reflects a real step of
 * ./agent-tip.js.
 */

import { tipAgent, TipError, TIP_TOKENS } from './agent-tip.js';
import { getWalletStatus } from './agent-wallet-chip.js';

const STYLE_ID = 'tws-tip-modal-styles';

// Notify the server of a confirmed P2P tip so it can verify the signature
// on-chain and surface the tip in the Money Pulse + the agent's wallet story.
// Fire-and-forget: the tip is already final on-chain, so this never blocks the
// success UI and a failure (e.g. no agent id, tx still finalizing) is silent.
function recordTip(agentId, signature, token, network) {
	if (!agentId || !signature) return Promise.resolve();
	try {
		return fetch(`/api/agents/${encodeURIComponent(agentId)}/solana/tip`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ signature, asset: token || 'SOL', network: network || 'mainnet' }),
			keepalive: true,
		}).catch(() => {});
	} catch { /* never throws into the success path */ return Promise.resolve(); }
}

// Broadcast a confirmed, server-recorded gift so live surfaces (the patronage
// Support panel, money pulse) can refresh their derived state without a reload.
function announceSupport(detail) {
	try { window.dispatchEvent(new CustomEvent('three:patron-support', { detail })); } catch { /* best-effort */ }
}

function esc(s) {
	return String(s == null ? '' : s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

function ensureStyles() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `
.ttm-backdrop{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;
	padding:16px;background:rgba(8,8,12,.66);backdrop-filter:blur(4px);
	animation:ttm-fade .18s ease;}
.ttm{width:100%;max-width:380px;background:var(--bg-1,#16161c);color:var(--ink,#e8e8ea);
	border:1px solid var(--stroke-strong,rgba(255,255,255,.12));border-radius:16px;
	box-shadow:0 24px 64px rgba(0,0,0,.5);overflow:hidden;
	font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
	animation:ttm-rise .2s cubic-bezier(.2,.8,.2,1);}
.ttm-hd{display:flex;align-items:center;gap:11px;padding:16px 18px;border-bottom:1px solid var(--stroke,rgba(255,255,255,.07));}
.ttm-av{width:38px;height:38px;border-radius:10px;object-fit:cover;flex:none;
	background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);}
.ttm-hd-txt{min-width:0;flex:1;}
.ttm-hd-k{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-dim,#888);}
.ttm-hd-n{font-size:15px;font-weight:600;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ttm-x{appearance:none;background:none;border:none;color:var(--ink-dim,#888);font-size:22px;line-height:1;
	cursor:pointer;padding:2px 4px;border-radius:6px;flex:none;transition:color .15s,background .15s;}
.ttm-x:hover{color:#fff;background:rgba(255,255,255,.06);}
.ttm-bd{padding:16px 18px 18px;}
.ttm-toggle{display:flex;gap:6px;background:rgba(255,255,255,.04);border:1px solid var(--stroke,rgba(255,255,255,.08));
	border-radius:10px;padding:4px;margin-bottom:14px;}
.ttm-tok{flex:1;appearance:none;font:inherit;font-weight:600;font-size:13px;color:var(--ink-dim,#9a9aa2);
	background:none;border:none;border-radius:7px;padding:7px 0;cursor:pointer;transition:background .15s,color .15s;}
.ttm-tok[aria-pressed="true"]{background:rgba(139,92,246,.22);color:#c4b5fd;}
.ttm-presets{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-bottom:11px;}
.ttm-pre{appearance:none;font:inherit;font-size:13px;color:var(--ink,#e8e8ea);background:rgba(255,255,255,.04);
	border:1px solid var(--stroke,rgba(255,255,255,.08));border-radius:8px;padding:8px 0;cursor:pointer;
	transition:border-color .15s,background .15s,transform .1s;}
.ttm-pre:hover{background:rgba(255,255,255,.07);}
.ttm-pre[aria-pressed="true"]{border-color:rgba(139,92,246,.6);background:rgba(139,92,246,.16);color:#c4b5fd;}
.ttm-pre:active{transform:translateY(1px);}
.ttm-field{display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.04);
	border:1px solid var(--stroke,rgba(255,255,255,.08));border-radius:10px;padding:2px 12px;margin-bottom:13px;
	transition:border-color .15s;}
.ttm-field:focus-within{border-color:rgba(139,92,246,.55);}
.ttm-field input{flex:1;min-width:0;appearance:none;-moz-appearance:textfield;font:inherit;font-size:18px;font-weight:600;
	color:#fff;background:none;border:none;padding:10px 0;}
.ttm-field input::-webkit-outer-spin-button,.ttm-field input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0;}
.ttm-field input:focus{outline:none;}
.ttm-field .ttm-unit{font-size:13px;font-weight:600;color:var(--ink-dim,#888);flex:none;font-family:ui-monospace,monospace;}
.ttm-to{font-size:11px;color:var(--ink-dim,#7d7d86);margin-bottom:13px;word-break:break-all;font-family:ui-monospace,monospace;}
.ttm-to b{color:#a78bfa;font-weight:700;}
.ttm-go{width:100%;appearance:none;font:inherit;font-weight:700;font-size:14px;color:#0a0a0a;
	background:linear-gradient(180deg,#c4b5fd,#a78bfa);border:none;border-radius:11px;padding:13px 0;cursor:pointer;
	display:inline-flex;align-items:center;justify-content:center;gap:8px;transition:filter .15s,transform .1s,opacity .15s;}
.ttm-go:hover:not(:disabled){filter:brightness(1.08);}
.ttm-go:active:not(:disabled){transform:translateY(1px);}
.ttm-go:disabled{opacity:.55;cursor:not-allowed;}
.ttm-spin{width:14px;height:14px;border-radius:50%;border:2px solid rgba(10,10,10,.35);border-top-color:#0a0a0a;
	animation:ttm-spin .7s linear infinite;flex:none;}
.ttm-msg{font-size:12.5px;margin-top:11px;line-height:1.45;}
.ttm-msg.err{color:#fca5a5;}
.ttm-ok{text-align:center;padding:8px 4px 2px;}
.ttm-ok-ic{width:48px;height:48px;border-radius:50%;margin:0 auto 12px;display:flex;align-items:center;justify-content:center;
	background:rgba(74,222,128,.14);color:#4ade80;font-size:26px;}
.ttm-ok-t{font-size:16px;font-weight:700;color:#fff;margin-bottom:5px;}
.ttm-ok-s{font-size:13px;color:var(--ink-dim,#9a9aa2);margin-bottom:16px;}
.ttm-ok-row{display:flex;gap:8px;}
.ttm-ok-row a,.ttm-ok-row button{flex:1;appearance:none;font:inherit;font-size:13px;font-weight:600;text-align:center;
	text-decoration:none;padding:10px 0;border-radius:9px;cursor:pointer;transition:background .15s,border-color .15s;}
.ttm-ok-row a{color:#0a0a0a;background:#c4b5fd;border:1px solid #c4b5fd;}
.ttm-ok-row a:hover{filter:brightness(1.07);}
.ttm-ok-row button{color:var(--ink,#e8e8ea);background:rgba(255,255,255,.05);border:1px solid var(--stroke,rgba(255,255,255,.1));}
.ttm-ok-row button:hover{background:rgba(255,255,255,.09);}
.ttm-note{font-size:11px;color:var(--ink-dim,#6f6f78);margin-top:12px;text-align:center;line-height:1.4;}
@keyframes ttm-fade{from{opacity:0;}to{opacity:1;}}
@keyframes ttm-rise{from{opacity:0;transform:translateY(12px) scale(.98);}to{opacity:1;transform:none;}}
@keyframes ttm-spin{to{transform:rotate(360deg);}}
@media (prefers-reduced-motion:reduce){.ttm-backdrop,.ttm,.ttm-spin{animation:none;}}
`;
	(document.head || document.documentElement).appendChild(style);
}

const STAGE_LABEL = {
	connecting: 'Connecting wallet…',
	building: 'Preparing transfer…',
	signing: 'Approve in your wallet…',
	sending: 'Broadcasting…',
	confirming: 'Confirming on-chain…',
};

/**
 * Open the tip modal for an agent.
 *
 * @param {object} agent  Any agent record shape (must resolve a public solana_address).
 * @param {object} [opts]
 * @param {'mainnet'|'devnet'} [opts.network='mainnet']
 * @param {() => void} [opts.onSent]  Fired after a confirmed tip (e.g. to refresh a balance).
 * @returns {{ close: () => void } | null}  null when the agent has no tippable wallet.
 */
export function openTipModal(agent, opts = {}) {
	if (typeof document === 'undefined') return null;
	const status = getWalletStatus(agent);
	if (!status) return null;

	ensureStyles();
	const network = opts.network === 'devnet' ? 'devnet' : 'mainnet';
	const name = agent?.name || 'this agent';
	const avatar = agent?.avatar_thumbnail_url || agent?.avatar_url || agent?.profile_image_url || '';
	// Agents that advertise a preferred payment asset default the modal to it.
	const accepted = (agent?.meta?.payments?.accepted_tokens || agent?.payments?.accepted_tokens || [])
		.map((t) => String(t).toUpperCase());
	const initialToken = accepted.includes('USDC') && !accepted.includes('SOL') ? 'USDC' : 'SOL';

	const state = { token: initialToken, amount: '', sending: false, done: null, error: null };

	const backdrop = document.createElement('div');
	backdrop.className = 'ttm-backdrop';
	backdrop.setAttribute('role', 'dialog');
	backdrop.setAttribute('aria-modal', 'true');
	backdrop.setAttribute('aria-label', `Tip ${name}`);

	const prevActive = document.activeElement;
	function close() {
		document.removeEventListener('keydown', onKey, true);
		backdrop.remove();
		try { prevActive?.focus?.(); } catch { /* noop */ }
	}
	function onKey(e) {
		if (e.key === 'Escape' && !state.sending) { e.preventDefault(); close(); }
	}

	function tokenMeta() {
		return TIP_TOKENS.find((t) => t.id === state.token) || TIP_TOKENS[0];
	}

	function render() {
		if (state.done) { renderSuccess(); return; }
		const tk = tokenMeta();
		backdrop.innerHTML = `
			<div class="ttm">
				<div class="ttm-hd">
					${avatar ? `<img loading="lazy" decoding="async" class="ttm-av" src="${esc(avatar)}" alt="" data-fallback="remove"/>` : '<div class="ttm-av"></div>'}
					<div class="ttm-hd-txt">
						<div class="ttm-hd-k">${esc(accepted.length ? 'Pay' : 'Tip')}</div>
						<div class="ttm-hd-n" title="${esc(name)}">${esc(name)}</div>
					</div>
					<button class="ttm-x" type="button" data-x aria-label="Close" ${state.sending ? 'disabled' : ''}>×</button>
				</div>
				<div class="ttm-bd">
					<div class="ttm-toggle" role="group" aria-label="Tip asset">
						${TIP_TOKENS.map((t) => `<button class="ttm-tok" type="button" data-tok="${t.id}" aria-pressed="${state.token === t.id}">${esc(t.label)}</button>`).join('')}
					</div>
					<div class="ttm-presets">
						${tk.presets.map((p) => `<button class="ttm-pre" type="button" data-pre="${p}" aria-pressed="${String(p) === String(state.amount)}">${tk.symbol === '◎' ? '◎' : '$'}${p}</button>`).join('')}
					</div>
					<div class="ttm-field">
						<input type="number" inputmode="decimal" min="0" step="any" placeholder="0.00"
							value="${esc(state.amount)}" data-amt aria-label="Tip amount" ${state.sending ? 'disabled' : ''}/>
						<span class="ttm-unit">${esc(tk.label)}</span>
					</div>
					<div class="ttm-to">to <b>${esc(status.address.slice(0, 4))}</b>${esc(status.address.slice(4, -4))}<b>${esc(status.address.slice(-4))}</b></div>
					<button class="ttm-go" type="button" data-go ${state.sending || !(Number(state.amount) > 0) ? 'disabled' : ''}>
						${state.sending ? `<span class="ttm-spin" aria-hidden="true"></span>${esc(STAGE_LABEL[state.sending] || 'Sending…')}` : `Send ${state.amount ? `${esc(state.amount)} ${esc(tk.label)}` : tk.label} →`}
					</button>
					${state.error ? `<div class="ttm-msg err" role="alert">${esc(state.error)}</div>` : ''}
					<div class="ttm-note">Sent straight from your wallet to the agent — three.ws never holds the funds.${network === 'devnet' ? ' · Devnet' : ''}</div>
				</div>
			</div>`;
		wire();
	}

	function renderSuccess() {
		const tk = tokenMeta();
		backdrop.innerHTML = `
			<div class="ttm">
				<div class="ttm-hd">
					${avatar ? `<img loading="lazy" decoding="async" class="ttm-av" src="${esc(avatar)}" alt="" data-fallback="remove"/>` : '<div class="ttm-av"></div>'}
					<div class="ttm-hd-txt">
						<div class="ttm-hd-k">Sent</div>
						<div class="ttm-hd-n" title="${esc(name)}">${esc(name)}</div>
					</div>
					<button class="ttm-x" type="button" data-x aria-label="Close">×</button>
				</div>
				<div class="ttm-bd">
					<div class="ttm-ok">
						<div class="ttm-ok-ic" aria-hidden="true">✓</div>
						<div class="ttm-ok-t">${esc(state.done.amount)} ${esc(tk.label)} sent</div>
						<div class="ttm-ok-s">Your tip to ${esc(name)} is confirmed on-chain.</div>
						<div class="ttm-ok-row">
							<a href="${esc(state.done.explorerUrl)}" target="_blank" rel="noopener">View receipt ↗</a>
							<button type="button" data-again>Tip again</button>
						</div>
					</div>
				</div>
			</div>`;
		backdrop.querySelector('[data-x]')?.addEventListener('click', close);
		backdrop.querySelector('[data-again]')?.addEventListener('click', () => {
			state.done = null; state.error = null; state.amount = ''; render();
		});
	}

	function wire() {
		backdrop.querySelector('[data-x]')?.addEventListener('click', () => { if (!state.sending) close(); });
		for (const b of backdrop.querySelectorAll('[data-tok]')) {
			b.addEventListener('click', () => { if (state.sending) return; state.token = b.dataset.tok; state.amount = ''; state.error = null; render(); });
		}
		for (const b of backdrop.querySelectorAll('[data-pre]')) {
			b.addEventListener('click', () => { if (state.sending) return; state.amount = b.dataset.pre; state.error = null; render(); });
		}
		const amt = backdrop.querySelector('[data-amt]');
		amt?.addEventListener('input', () => {
			state.amount = amt.value.trim();
			const go = backdrop.querySelector('[data-go]');
			if (go) go.disabled = state.sending || !(Number(state.amount) > 0);
			for (const b of backdrop.querySelectorAll('[data-pre]')) b.setAttribute('aria-pressed', String(b.dataset.pre) === String(state.amount));
			const label = go?.querySelector(':scope');
			if (go && !state.sending) go.innerHTML = `Send ${state.amount ? `${esc(state.amount)} ${esc(tokenMeta().label)}` : tokenMeta().label} →`;
		});
		backdrop.querySelector('[data-go]')?.addEventListener('click', send);
	}

	async function send() {
		if (state.sending || !(Number(state.amount) > 0)) return;
		state.error = null;
		state.sending = 'connecting';
		render();
		try {
			const res = await tipAgent({
				toAddress: status.address,
				token: state.token,
				amount: Number(state.amount),
				network,
				onStage: (s) => { state.sending = s; render(); },
			});
			state.done = { amount: state.amount, explorerUrl: res.explorerUrl, signature: res.signature };
			state.sending = false;
			render();
			// Record the confirmed tip so it enters the public Money Pulse + the
			// agent's wallet story. The server INDEPENDENTLY re-verifies the signature
			// on-chain before writing a row, so this is only a hint — a failure here
			// never affects the (already-final) on-chain tip.
			const agentId = status.agentId || agent?.id;
			recordTip(agentId, res.signature, state.token, network).then(() => {
				announceSupport({ agentId, signature: res.signature, asset: state.token, from: res.from, network });
			});
			try { opts.onSent?.(res); } catch { /* listener best-effort */ }
		} catch (e) {
			state.sending = false;
			state.error = e instanceof TipError ? e.message : (e?.message || 'The tip could not be completed.');
			render();
		}
	}

	backdrop.addEventListener('click', (e) => { if (e.target === backdrop && !state.sending) close(); });
	document.addEventListener('keydown', onKey, true);
	render();
	document.body.appendChild(backdrop);
	backdrop.querySelector('[data-amt]')?.focus();

	return { close };
}
