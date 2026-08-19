/**
 * Portable wallet — the agent's wallet, self-contained enough to live ANYWHERE
 * its avatar shows up off the main app shell: the `<agent-3d wallet>` web
 * component on a stranger's blog (shadow DOM), the avatar SDK viewer, an IRL/AR
 * card, the walk world, the chat app. One module, mounted into any root.
 *
 * Why this exists separately from `agent-wallet-chip.js`: the in-app chip injects
 * its stylesheet into `document.head`, reads from a record the page already
 * holds, and links to in-app routes — none of which survive a closed shadow root
 * on a third-party origin. This module is the portable cousin:
 *
 *   • Renders entirely inside a caller-supplied root (Element OR ShadowRoot) and
 *     ships its own scoped `<style>` so it needs no `tokens.css` and leaks no CSS.
 *   • Reads real, public-only data from the CORS:* embed endpoint
 *     (GET /api/agents/wallet-embed) — address, live USD value, $THREE/USDC,
 *     lifetime tips. No secrets, no owner fields, no app globals.
 *   • Is the VISITOR view by construction: Tip + "open on three.ws". It never
 *     renders or reaches an owner control; an embedding host cannot assert that
 *     the viewer owns the wallet (that is decided only by a real session on
 *     three.ws itself).
 *   • Tips for real three ways, in order of what the visitor actually has:
 *       1. a connected browser Solana wallet → an inline, real, viewer-signed
 *          transfer (lazy-loads agent-tip.js so web3 never bloats first paint),
 *       2. a phone → a Solana Pay QR they scan to pay from Phantom/Solflare,
 *       3. neither → a deep link that opens the tip flow on three.ws.
 *
 * Degrades, never breaks: if the embed endpoint is unreachable (offline, CORS),
 * it falls back to a clean static identity (seed name/avatar) + "open on
 * three.ws" rather than a broken widget.
 */

import { buildSolanaPayUri } from './solana-pay.js';
import { renderQRToSVG } from '../erc8004/qr.js';

const ORIGIN_DEFAULT = 'https://three.ws';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const STYLE_FLAG = '__pwStyled';

function esc(s) {
	return String(s == null ? '' : s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
	);
}

/** Compact USD: $0, <$0.01, $9.40, $950, $1.2K, $3.4M. */
function fmtUsd(n) {
	if (n == null || !Number.isFinite(n)) return null;
	if (n <= 0) return '$0';
	if (n < 0.01) return '<$0.01';
	if (n < 10) return `$${n.toFixed(2)}`;
	if (n < 1000) return `$${Math.round(n)}`;
	if (n < 1e6) return `$${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}K`;
	if (n < 1e9) return `$${(n / 1e6).toFixed(1)}M`;
	return `$${(n / 1e9).toFixed(1)}B`;
}

/** Vanity-aware short address: keep a real matched prefix/suffix, else 4+4. */
function shortAddr(address, vanity) {
	const a = String(address || '');
	if (!a) return '';
	const pre = vanity?.prefix && a.startsWith(vanity.prefix) ? vanity.prefix : a.slice(0, 4);
	const suf = vanity?.suffix && a.endsWith(vanity.suffix) ? vanity.suffix : a.slice(-4);
	const preHi = !!(vanity?.prefix && a.startsWith(vanity.prefix));
	const sufHi = !!(vanity?.suffix && a.endsWith(vanity.suffix));
	return (
		`<span class="${preHi ? 'pw-hi' : ''}">${esc(pre)}</span>` +
		`<span class="pw-dots">…</span>` +
		`<span class="${sufHi ? 'pw-hi' : ''}">${esc(suf)}</span>`
	);
}

const WALLET_SVG =
	'<svg class="pw-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>';
const COPY_SVG =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

const STYLE = `
.pw-root{--pw-accent:#c4b5fd;--pw-accent-strong:#a78bfa;--pw-soft:rgba(139,92,246,.12);--pw-fill:rgba(139,92,246,.2);
	--pw-stroke:rgba(139,92,246,.32);--pw-stroke-2:rgba(139,92,246,.55);--pw-glow:rgba(139,92,246,.45);
	--pw-bg:rgba(16,16,20,.96);--pw-ink:#e8e8ea;--pw-ink-dim:#9a9aa2;--pw-ink-bright:#fff;--pw-ok:#4ade80;--pw-danger:#f87171;
	font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--pw-ink);box-sizing:border-box;}
.pw-root *,.pw-root *::before,.pw-root *::after{box-sizing:border-box;}
/* Light surfaces (e.g. the chat app) — darken the chip ink for contrast while the
   floating popover stays a dark glass card (its vars are re-set below). */
.pw-root[data-theme="light"]{--pw-accent:#7c3aed;--pw-accent-strong:#6d28d9;--pw-soft:rgba(124,58,237,.08);
	--pw-fill:rgba(124,58,237,.14);--pw-stroke:rgba(124,58,237,.28);--pw-stroke-2:rgba(124,58,237,.5);
	--pw-glow:rgba(124,58,237,.4);--pw-ink:#1e1b2e;--pw-ink-dim:#6b6780;--pw-ink-bright:#0a0a0a;}
.pw-root[data-theme="light"] .pw-pop{--pw-accent:#c4b5fd;--pw-accent-strong:#a78bfa;
	--pw-soft:rgba(139,92,246,.12);--pw-fill:rgba(139,92,246,.2);--pw-stroke:rgba(139,92,246,.32);
	--pw-stroke-2:rgba(139,92,246,.55);--pw-glow:rgba(139,92,246,.45);
	--pw-ink:#e8e8ea;--pw-ink-dim:#9a9aa2;--pw-ink-bright:#fff;}
.pw-chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:4px 9px;border-radius:999px;cursor:pointer;
	font:600 11px/1 inherit;color:var(--pw-accent);background:var(--pw-soft);border:1px solid var(--pw-stroke);
	white-space:nowrap;transition:border-color .18s,background .18s,box-shadow .25s;appearance:none;}
.pw-chip:hover,.pw-chip:focus-visible{border-color:var(--pw-stroke-2);background:var(--pw-fill);outline:none;}
.pw-chip:focus-visible{box-shadow:0 0 0 2px var(--pw-glow);}
.pw-chip[data-vanity="1"]{color:var(--pw-accent-strong);border-color:var(--pw-stroke-2);}
.pw-ico{width:12px;height:12px;flex:none;opacity:.85;}
.pw-addr{font-family:ui-monospace,"JetBrains Mono",SFMono-Regular,Menlo,monospace;letter-spacing:.01em;display:inline-flex;gap:1px;}
.pw-hi{color:var(--pw-ink-bright);font-weight:700;}
.pw-dots{opacity:.5;}
.pw-val{font-family:ui-monospace,Menlo,monospace;font-weight:700;font-size:11px;color:var(--pw-ink-bright);
	border-left:1px solid var(--pw-stroke);padding-left:6px;}
.pw-sk{display:inline-block;width:30px;height:9px;border-radius:3px;
	background:linear-gradient(90deg,rgba(255,255,255,.06),rgba(255,255,255,.18),rgba(255,255,255,.06));
	background-size:200% 100%;animation:pw-sk 1.1s ease-in-out infinite;}
@keyframes pw-sk{0%{background-position:200% 0}100%{background-position:-200% 0}}
.pw-pop{margin-top:7px;width:264px;max-width:100%;background:var(--pw-bg);border:1px solid var(--pw-stroke-2);
	border-radius:14px;padding:13px;box-shadow:0 20px 50px rgba(0,0,0,.55);backdrop-filter:blur(12px);
	font-size:12px;line-height:1.45;}
.pw-pop[hidden]{display:none;}
.pw-pop-head{display:flex;align-items:center;gap:9px;margin-bottom:11px;}
.pw-av{width:30px;height:30px;border-radius:8px;object-fit:cover;background:rgba(255,255,255,.08);flex:none;}
.pw-id{min-width:0;flex:1;}
.pw-name{font-weight:700;color:var(--pw-ink-bright);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pw-sub{font-size:10px;color:var(--pw-ink-dim);margin-top:1px;}
.pw-total{display:flex;align-items:flex-end;justify-content:space-between;gap:8px;margin-bottom:10px;}
.pw-usd{font:800 22px/1 "Space Grotesk",ui-sans-serif,system-ui;color:var(--pw-ink-bright);font-feature-settings:"tnum";}
.pw-usd-lbl{font-size:9px;color:var(--pw-ink-dim);text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px;}
.pw-tips{text-align:right;font-size:10px;color:var(--pw-ink-dim);}
.pw-tips b{display:block;color:var(--pw-accent);font:700 13px/1 ui-monospace,Menlo,monospace;}
.pw-addrline{display:flex;align-items:center;gap:6px;font-family:ui-monospace,Menlo,monospace;font-size:10.5px;
	background:rgba(255,255,255,.04);border-radius:8px;padding:6px 8px;margin-bottom:10px;}
.pw-addrline .pw-mono{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--pw-ink-dim);}
.pw-icobtn{appearance:none;background:none;border:none;padding:2px;margin:0;cursor:pointer;color:var(--pw-accent);
	opacity:.7;display:inline-flex;transition:opacity .15s,transform .12s;}
.pw-icobtn:hover{opacity:1;}
.pw-icobtn:active{transform:scale(.88);}
.pw-icobtn svg{width:13px;height:13px;}
.pw-icobtn.pw-copied{color:var(--pw-ok);opacity:1;}
.pw-acts{display:flex;flex-wrap:wrap;gap:6px;}
.pw-btn{appearance:none;cursor:pointer;font:700 11px/1 inherit;border-radius:999px;padding:8px 12px;flex:1 1 auto;
	border:1px solid var(--pw-stroke-2);background:var(--pw-soft);color:var(--pw-accent);
	display:inline-flex;align-items:center;justify-content:center;gap:5px;text-decoration:none;
	transition:background .15s,transform .12s,color .15s;white-space:nowrap;}
.pw-btn:hover{background:var(--pw-fill);color:var(--pw-ink-bright);}
.pw-btn:active{transform:scale(.97);}
.pw-btn:focus-visible{outline:2px solid var(--pw-glow);outline-offset:2px;}
.pw-btn-primary{background:linear-gradient(135deg,var(--pw-accent),var(--pw-accent-strong));color:#0a0a0a;border-color:transparent;}
.pw-btn-primary:hover{filter:brightness(1.07);color:#0a0a0a;}
.pw-tip{margin-top:10px;}
.pw-tip[hidden]{display:none;}
.pw-seg{display:flex;gap:5px;margin-bottom:8px;}
.pw-presets{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px;}
.pw-pre{appearance:none;cursor:pointer;font:600 11px/1 ui-monospace,Menlo,monospace;border-radius:8px;padding:7px 9px;flex:1 1 auto;
	border:1px solid var(--pw-stroke);background:rgba(255,255,255,.03);color:var(--pw-ink);transition:border-color .15s,background .15s;}
.pw-pre:hover{border-color:var(--pw-stroke-2);}
.pw-pre[data-on="1"]{background:var(--pw-fill);border-color:var(--pw-stroke-2);color:var(--pw-ink-bright);}
.pw-qr{display:flex;flex-direction:column;align-items:center;gap:7px;margin-top:10px;}
.pw-qr[hidden]{display:none;}
.pw-qr-frame{background:#fff;border-radius:10px;padding:8px;line-height:0;}
.pw-qr-frame svg{display:block;width:140px;height:140px;}
.pw-qr-cap{font-size:10px;color:var(--pw-ink-dim);text-align:center;}
.pw-status{font-size:10.5px;margin-top:8px;min-height:13px;color:var(--pw-ink-dim);}
.pw-status[data-kind="ok"]{color:var(--pw-ok);}
.pw-status[data-kind="err"]{color:var(--pw-danger);}
.pw-status a{color:inherit;text-decoration:underline;}
.pw-pending{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;font:600 11px/1 inherit;
	color:var(--pw-ink-dim);background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);}
.pw-link{font-size:10px;color:var(--pw-ink-dim);text-decoration:none;display:inline-block;margin-top:9px;transition:color .15s;}
.pw-link:hover{color:var(--pw-accent);}
@media (prefers-reduced-motion: reduce){.pw-sk{animation:none;}.pw-chip,.pw-btn,.pw-icobtn{transition:none;}}
`;

function ensureStyles(host) {
	// `host` is the ShadowRoot or Element we render into. Inject the scoped <style>
	// as a direct child of THAT node (once) so the styles reach our markup whether
	// it lives in a shadow tree or a light-DOM container.
	if (host[STYLE_FLAG]) return;
	host[STYLE_FLAG] = true;
	const style = document.createElement('style');
	style.setAttribute('data-pw', '');
	style.textContent = STYLE;
	host.appendChild(style);
}

async function copyText(text) {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		/* fall through */
	}
	try {
		const ta = document.createElement('textarea');
		ta.value = text;
		ta.style.position = 'fixed';
		ta.style.opacity = '0';
		document.body.appendChild(ta);
		ta.select();
		const ok = document.execCommand('copy');
		ta.remove();
		return ok;
	} catch {
		return false;
	}
}

function detectSolana() {
	if (typeof window === 'undefined') return null;
	return window.phantom?.solana || window.solana || window.backpack?.solana || window.solflare || null;
}

const TIP_PRESETS = {
	SOL: [0.05, 0.1, 0.25, 1],
	USDC: [1, 5, 10, 25],
};

/**
 * Mount a portable wallet into `host` (Element or ShadowRoot).
 *
 * @param {Element|ShadowRoot} host
 * @param {object} opts
 * @param {string}  opts.agentId                 Agent UUID (required for live data).
 * @param {string}  [opts.origin='https://three.ws']  three.ws origin to read/deep-link.
 * @param {'mainnet'|'devnet'} [opts.network='mainnet']
 * @param {'chip'|'card'} [opts.variant='chip']  Chip toggles a popover; card is always open.
 * @param {boolean} [opts.tip=true]              Show the inline tip flow.
 * @param {boolean} [opts.qr=true]               Offer a Solana Pay QR.
 * @param {string}  [opts.name]                  Seed name (used while loading / on offline fallback).
 * @param {string}  [opts.avatar]                Seed avatar URL.
 * @param {object}  [opts.seedCard]              A pre-fetched embed card (skip the network call).
 * @param {'dark'|'light'} [opts.theme='dark']   'light' darkens the chip ink for light surfaces.
 * @returns {{ el: HTMLElement, refresh: () => void, destroy: () => void }}
 */
export function mountPortableWallet(host, opts = {}) {
	const {
		agentId,
		origin = ORIGIN_DEFAULT,
		network = 'mainnet',
		variant = 'chip',
		tip = true,
		qr = true,
		share = true,
		name: seedName = null,
		avatar: seedAvatar = null,
		seedCard = null,
		theme = 'dark',
	} = opts;

	ensureStyles(host);
	const root = document.createElement('div');
	root.className = 'pw-root';
	if (theme === 'light') root.setAttribute('data-theme', 'light');
	host.appendChild(root);

	let card = seedCard || null;
	let destroyed = false;
	let outsideBound = false;

	const state = {
		open: variant === 'card',
		tipOpen: false,
		qrOpen: false,
		tipToken: 'SOL',
		tipAmount: TIP_PRESETS.SOL[1],
		busy: false,
	};

	function setStatus(el, text, kind) {
		if (!el) return;
		el.textContent = text || '';
		if (kind) el.dataset.kind = kind;
		else el.removeAttribute('data-kind');
	}

	function render() {
		if (destroyed) return;
		// ── No agent id, or a wallet-less / unreachable agent → static identity ──
		if (!card) {
			root.innerHTML = renderLoadingOrSeed();
			return;
		}
		if (!card.address || !BASE58_RE.test(String(card.address))) {
			root.innerHTML =
				`<span class="pw-pending" title="Wallet provisioning">${WALLET_SVG}<span>Wallet pending</span></span>` +
				`<a class="pw-link" href="${esc(card.openUrl || origin)}" target="_blank" rel="noopener">Open on three.ws ↗</a>`;
			return;
		}

		const vanity = card.vanity || null;
		const usd = fmtUsd(card.balanceUsd);
		const chip =
			`<button type="button" class="pw-chip" data-vanity="${vanity ? '1' : '0'}" aria-haspopup="dialog" aria-expanded="${state.open ? 'true' : 'false'}" data-pw-toggle>` +
			WALLET_SVG +
			`<span class="pw-addr">${shortAddr(card.address, vanity)}</span>` +
			(usd != null ? `<span class="pw-val">${esc(usd)}</span>` : '') +
			`</button>`;

		root.innerHTML = variant === 'chip' ? chip + popoverHTML() : popoverHTML(true);
		wire();
	}

	function renderLoadingOrSeed() {
		// Pre-data chip: show seed name + a skeleton value, never a void.
		const label = seedName ? esc(seedName) : 'Wallet';
		return (
			`<button type="button" class="pw-chip" data-pw-toggle disabled>` +
			WALLET_SVG +
			`<span class="pw-addr">${label}</span>` +
			`<span class="pw-val"><span class="pw-sk"></span></span>` +
			`</button>`
		);
	}

	function popoverHTML(forceOpen) {
		const open = forceOpen || state.open;
		const vanity = card.vanity || null;
		const usd = fmtUsd(card.balanceUsd);
		const av = card.avatar || seedAvatar;
		const tipsCount = card.tips?.count || 0;
		const tipsUsd = fmtUsd(card.tips?.usd);
		const headline =
			tipsCount > 0
				? `<div class="pw-tips"><b>${tipsCount}</b>tip${tipsCount === 1 ? '' : 's'}${tipsUsd ? ` · ${esc(tipsUsd)}` : ''}</div>`
				: '';

		const presets = TIP_PRESETS[state.tipToken] || TIP_PRESETS.SOL;
		const tipPanel = tip
			? `<div class="pw-tip" ${state.tipOpen ? '' : 'hidden'} data-pw-tip>
					<div class="pw-seg">
						<button type="button" class="pw-pre" data-pw-token="SOL" data-on="${state.tipToken === 'SOL' ? '1' : '0'}">SOL</button>
						<button type="button" class="pw-pre" data-pw-token="USDC" data-on="${state.tipToken === 'USDC' ? '1' : '0'}">USDC</button>
					</div>
					<div class="pw-presets">${presets
						.map(
							(p) =>
								`<button type="button" class="pw-pre" data-pw-amt="${p}" data-on="${p === state.tipAmount ? '1' : '0'}">${p}</button>`,
						)
						.join('')}</div>
					<button type="button" class="pw-btn pw-btn-primary" data-pw-send style="flex:1 1 100%">Send tip</button>
					<div class="pw-status" data-pw-status aria-live="polite"></div>
				</div>`
			: '';

		const qrPanel = qr
			? `<div class="pw-qr" ${state.qrOpen ? '' : 'hidden'} data-pw-qr>
					<div class="pw-qr-frame" data-pw-qr-svg></div>
					<div class="pw-qr-cap">Scan with Phantom / Solflare to tip</div>
				</div>`
			: '';

		return (
			`<div class="pw-pop" role="dialog" aria-label="${esc(card.name || 'Agent')} wallet" data-pw-pop ${open ? '' : 'hidden'}>` +
			`<div class="pw-pop-head">` +
			(av ? `<img class="pw-av" src="${esc(av)}" alt="" loading="lazy">` : `<span class="pw-av"></span>`) +
			`<div class="pw-id"><div class="pw-name">${esc(card.name || 'Agent')}</div><div class="pw-sub">Agent wallet · Solana</div></div>` +
			`</div>` +
			`<div class="pw-total"><div><div class="pw-usd-lbl">Wallet value</div><div class="pw-usd">${esc(usd || '$0')}</div></div>${headline}</div>` +
			`<div class="pw-addrline"><span class="pw-mono">${esc(card.address)}</span>` +
			`<button type="button" class="pw-icobtn" data-pw-copy title="Copy address" aria-label="Copy wallet address">${COPY_SVG}</button></div>` +
			`<div class="pw-acts">` +
			(tip ? `<button type="button" class="pw-btn pw-btn-primary" data-pw-tipbtn>◎ Tip</button>` : '') +
			(qr ? `<button type="button" class="pw-btn" data-pw-qrbtn>QR</button>` : '') +
			(share ? `<button type="button" class="pw-btn" data-pw-share title="Share this wallet">Share</button>` : '') +
			`<a class="pw-btn" href="${esc(card.openUrl)}" target="_blank" rel="noopener">Open ↗</a>` +
			`</div>` +
			tipPanel +
			qrPanel +
			`</div>`
		);
	}

	function wire() {
		const toggle = root.querySelector('[data-pw-toggle]');
		const pop = root.querySelector('[data-pw-pop]');
		if (toggle && variant === 'chip') {
			toggle.addEventListener('click', () => {
				state.open = !state.open;
				toggle.setAttribute('aria-expanded', state.open ? 'true' : 'false');
				if (pop) pop.hidden = !state.open;
				if (state.open) bindOutside();
				else unbindOutside();
			});
		}
		if (!pop) return;

		const copyBtn = pop.querySelector('[data-pw-copy]');
		copyBtn?.addEventListener('click', async () => {
			const ok = await copyText(card.address);
			if (ok) {
				copyBtn.classList.add('pw-copied');
				setTimeout(() => copyBtn.classList.remove('pw-copied'), 1200);
			}
		});

		const status = pop.querySelector('[data-pw-status]');

		pop.querySelector('[data-pw-tipbtn]')?.addEventListener('click', () => {
			state.tipOpen = !state.tipOpen;
			if (state.tipOpen) state.qrOpen = false;
			render();
		});

		pop.querySelector('[data-pw-qrbtn]')?.addEventListener('click', () => {
			state.qrOpen = !state.qrOpen;
			if (state.qrOpen) state.tipOpen = false;
			render();
		});

		for (const b of pop.querySelectorAll('[data-pw-token]')) {
			b.addEventListener('click', () => {
				state.tipToken = b.dataset.pwToken;
				state.tipAmount = (TIP_PRESETS[state.tipToken] || TIP_PRESETS.SOL)[1];
				state.tipOpen = true;
				render();
			});
		}
		for (const b of pop.querySelectorAll('[data-pw-amt]')) {
			b.addEventListener('click', () => {
				state.tipAmount = Number(b.dataset.pwAmt);
				for (const o of pop.querySelectorAll('[data-pw-amt]')) o.dataset.on = o === b ? '1' : '0';
			});
		}

		pop.querySelector('[data-pw-send]')?.addEventListener('click', () => sendTip(status));

		pop.querySelector('[data-pw-share]')?.addEventListener('click', async (e) => {
			// The growth loop: a wallet worth screenshotting that links back to tip
			// or fork. The /share?wallet=1 link previews with the vanity address +
			// lifetime tips OG card.
			const shareUrl = `${origin}/agents/${encodeURIComponent(agentId)}/share?wallet=1`;
			const btn = e.currentTarget;
			try {
				if (navigator.share) {
					await navigator.share({ title: `${card.name || 'Agent'} wallet`, url: shareUrl });
					return;
				}
			} catch {
				/* user dismissed the native sheet — fall through to copy */
			}
			const ok = await copyText(shareUrl);
			if (ok && btn) {
				const prev = btn.textContent;
				btn.textContent = 'Copied!';
				setTimeout(() => { btn.textContent = prev; }, 1300);
			}
		});

		// A freshly-opened QR panel needs its SVG painted (render() leaves it empty).
		if (state.qrOpen) {
			const qrPanel = pop.querySelector('[data-pw-qr]');
			if (qrPanel) renderQr(qrPanel);
		}
	}

	function renderQr(qrPanel) {
		const slot = qrPanel.querySelector('[data-pw-qr-svg]');
		if (!slot || slot.dataset.done === '1') return;
		const uri = buildSolanaPayUri(card.address, {
			amount: state.tipAmount,
			label: card.name || 'three.ws agent',
		});
		try {
			slot.innerHTML = renderQRToSVG(uri, { scale: 4, margin: 1 });
			slot.dataset.done = '1';
		} catch {
			slot.innerHTML = '';
			const a = document.createElement('a');
			a.className = 'pw-link';
			a.href = card.tipUrl || card.openUrl;
			a.target = '_blank';
			a.rel = 'noopener';
			a.textContent = 'Open tip on three.ws ↗';
			slot.appendChild(a);
		}
	}

	async function sendTip(status) {
		if (state.busy) return;
		const provider = detectSolana();
		if (!provider) {
			// No connected wallet — surface the QR (the fastest real path on a phone)
			// and a three.ws deep link. render() rebuilds the panel, so write the
			// status into the freshly-rendered element afterwards.
			state.qrOpen = true;
			state.tipOpen = true;
			render();
			const newStatus = root.querySelector('[data-pw-status]');
			setStatus(newStatus, 'No Solana wallet here — scan the QR, or ');
			if (newStatus) {
				const a = document.createElement('a');
				a.href = card.tipUrl || card.openUrl;
				a.target = '_blank';
				a.rel = 'noopener';
				a.textContent = 'tip on three.ws ↗';
				newStatus.appendChild(a);
			}
			return;
		}
		state.busy = true;
		setStatus(status, 'Connecting…');
		try {
			const { tipAgent } = await import('./agent-tip.js');
			const { signature, explorerUrl } = await tipAgent({
				toAddress: card.address,
				token: state.tipToken,
				amount: state.tipAmount,
				network,
				onStage: (s) => setStatus(status, `${s[0].toUpperCase()}${s.slice(1)}…`),
			});
			setStatus(status, `Tipped ${state.tipAmount} ${state.tipToken} · `, 'ok');
			const a = document.createElement('a');
			a.href = explorerUrl;
			a.target = '_blank';
			a.rel = 'noopener';
			a.textContent = `${signature.slice(0, 8)}…`;
			status.appendChild(a);
			softRefresh(); // pull the new balance/tip count without nuking this receipt
		} catch (e) {
			setStatus(status, e?.message || 'Tip failed — try again.', 'err');
		} finally {
			state.busy = false;
		}
	}

	// Patch the live numbers in place (chip value, popover USD, tips) after a tip,
	// so the on-screen receipt + explorer link survive the balance update.
	async function softRefresh() {
		const next = await fetchCard();
		if (destroyed || !next) return;
		card = { ...card, ...next };
		const usd = fmtUsd(card.balanceUsd) || '$0';
		const valEl = root.querySelector('.pw-chip .pw-val');
		if (valEl) valEl.textContent = usd;
		const usdEl = root.querySelector('.pw-usd');
		if (usdEl) usdEl.textContent = usd;
		const tipsEl = root.querySelector('.pw-tips b');
		if (tipsEl && card.tips) tipsEl.textContent = String(card.tips.count || 0);
	}

	// composedPath-aware so a click inside our (possibly shadow-DOM) markup never
	// counts as "outside" — only a genuine outside click collapses the popover.
	function onDocClick(e) {
		const path = e.composedPath ? e.composedPath() : [];
		if (path.includes(root)) return;
		const pop = root.querySelector('[data-pw-pop]');
		const toggle = root.querySelector('[data-pw-toggle]');
		if (pop) pop.hidden = true;
		state.open = false;
		toggle?.setAttribute('aria-expanded', 'false');
		unbindOutside();
	}
	function bindOutside() {
		if (outsideBound) return;
		outsideBound = true;
		document.addEventListener('click', onDocClick, true);
	}
	function unbindOutside() {
		outsideBound = false;
		document.removeEventListener('click', onDocClick, true);
	}

	async function fetchCard() {
		if (!agentId) return null;
		try {
			const res = await fetch(
				`${origin}/api/agents/wallet-embed?id=${encodeURIComponent(agentId)}&network=${encodeURIComponent(network)}`,
				{ headers: { accept: 'application/json' } },
			);
			if (!res.ok) return null;
			const { data } = await res.json();
			return data || null;
		} catch {
			return null;
		}
	}

	async function refresh() {
		const next = await fetchCard();
		if (destroyed) return;
		if (next) {
			card = next;
		} else if (!card) {
			// Offline / CORS-blocked and nothing pre-seeded — a clean static identity.
			card = {
				agentId,
				name: seedName,
				avatar: seedAvatar,
				address: null,
				openUrl: `${origin}/agents/${agentId || ''}`,
			};
		}
		render();
	}

	// First paint immediately (skeleton/seed), then hydrate from the real endpoint.
	render();
	if (!seedCard) refresh();
	else render();

	return {
		el: root,
		refresh,
		destroy() {
			destroyed = true;
			unbindOutside();
			root.remove();
		},
	};
}
