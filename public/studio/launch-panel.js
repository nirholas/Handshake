// Launch panel — self-contained token launch experience for /studio.
// Handles: existing-token check, wallet events + balance auto-refresh,
// metadata upload, on-chain signing, confirmation polling with timeout
// escape hatch, and success display.
//
// Exported pure functions (tested):
//   validateLaunchForm(fields)   → { ok, errors }
//   handleLaunchSubmit(f, cb)    → { ok, errors? }
//
// DOM entry:
//   mountLaunchPanel(el, { getAvatar, getUser }) → { avatarChanged, teardown }

// ── Pure validation ─────────────────────────────────────────────────────────

export function validateLaunchForm({ name, symbol, description, initialBuy } = {}) {
	const errors = {};
	if (!name?.trim())        errors.name        = 'Token name is required';
	if (!symbol?.trim())      errors.symbol      = 'Symbol is required';
	if (!description?.trim()) errors.description = 'Description is required';
	if (initialBuy !== '' && initialBuy != null) {
		const n = Number(initialBuy);
		if (isNaN(n) || n < 0) errors.initialBuy = 'Initial buy must be a non-negative number';
	}
	return { ok: Object.keys(errors).length === 0, errors };
}

export function handleLaunchSubmit(fields, onSubmit) {
	const result = validateLaunchForm(fields);
	if (!result.ok) return result;
	onSubmit(fields);
	return { ok: true };
}

// ── Utilities ────────────────────────────────────────────────────────────────

const esc = (s) =>
	String(s ?? '').replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);

const toSymbol = (name) =>
	(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'AGENT';

const shortenAddr = (a) => (!a || a.length < 10 ? a || '' : a.slice(0, 4) + '…' + a.slice(-4));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function detectWallet() {
	if (typeof window === 'undefined') return null;
	return window.phantom?.solana || window.solana || window.backpack || window.solflare || null;
}

function fileToDataUrl(file) {
	return new Promise((res, rej) => {
		const reader = new FileReader();
		reader.onload  = (e) => res(e.target.result);
		reader.onerror = rej;
		reader.readAsDataURL(file);
	});
}

function friendlyError(msg) {
	const m = String(msg || '');
	if (/user rejected|rejected the request/i.test(m)) return 'Wallet signing cancelled.';
	if (/0x1\b/.test(m) || /insufficient.*lamports|insufficient.*sol/i.test(m))
		return 'Not enough SOL — fund your wallet and try again.';
	if (/wallet.*not.*found|no.*wallet/i.test(m))
		return 'No Solana wallet detected. Install Phantom or Backpack.';
	if (/429|rate.limit/i.test(m)) return 'Too many requests — wait a moment and try again.';
	return m;
}

const PUMP_BASE_COST = 0.022; // pump.fun fee + mint rent (estimate)
// USDC mainnet mint — pump.fun v2 quote when the user picks the USDC coin type.
// Pump.fun v2 launched USDC as a quote mint on 2026-05-21.
const USDC_MAINNET_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
// Absolute URL — @solana/web3.js's Connection constructor calls
// `new URL(endpoint)` to derive a WebSocket URL, which throws on a
// relative path. We don't use subscriptions, but constructor must not throw.
const RPC_URL = (typeof window !== 'undefined' && window.location?.origin
	? window.location.origin
	: 'https://three.ws') + '/api/solana-rpc';
const SOLSCAN = (sig, net = 'mainnet') =>
	`https://solscan.io/tx/${sig}${net === 'devnet' ? '?cluster=devnet' : ''}`;
const PUMP_URL = (mint) => `https://pump.fun/coin/${mint}`;

// ── CSS ──────────────────────────────────────────────────────────────────────

const LP_CSS = `
.lp{display:flex;flex-direction:column;gap:.9rem}

/* Wallet-source toggle */
.lp-src{display:grid;grid-template-columns:1fr 1fr;gap:.35rem;padding:.25rem;
  background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px}
.lp-src button{padding:.45rem .6rem;border-radius:7px;cursor:pointer;background:transparent;
  border:1px solid transparent;color:rgba(255,255,255,.45);font-size:.78rem;font-weight:500;transition:all .15s;line-height:1.2}
.lp-src button:hover:not(.on):not([disabled]){color:rgba(255,255,255,.75)}
.lp-src button.on{background:rgba(164,240,188,.1);border-color:rgba(164,240,188,.28);color:#c8f0d8}
.lp-src button[disabled]{opacity:.4;cursor:not-allowed}
.lp-src-sub{display:block;font-size:.62rem;color:rgba(255,255,255,.32);font-weight:400;margin-top:.15rem;letter-spacing:.01em}
.lp-src button.on .lp-src-sub{color:rgba(164,240,188,.55)}

/* Coin-type selector */
.lp-coin{display:grid;grid-template-columns:repeat(4,1fr);gap:.3rem;padding:.25rem;
  background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px}
.lp-coin button{padding:.5rem .35rem;border-radius:7px;cursor:pointer;background:transparent;
  border:1px solid transparent;color:rgba(255,255,255,.5);font-size:.74rem;font-weight:600;
  transition:all .15s;line-height:1.2;text-align:center}
.lp-coin button:hover:not(.on):not([disabled]){color:rgba(255,255,255,.85);background:rgba(255,255,255,.03)}
.lp-coin button.on{background:rgba(164,240,188,.12);border-color:rgba(164,240,188,.32);color:#c8f0d8}
.lp-coin button.mayhem.on{background:rgba(246,140,80,.14);border-color:rgba(246,140,80,.38);color:#f6c498}
.lp-coin button.usdc.on{background:rgba(120,160,240,.12);border-color:rgba(120,160,240,.34);color:#a8c4f0}
.lp-coin button[disabled]{opacity:.42;cursor:not-allowed}
.lp-coin-sub{display:block;font-size:.6rem;color:rgba(255,255,255,.32);font-weight:400;margin-top:.18rem;letter-spacing:.01em}
.lp-coin button.on .lp-coin-sub{color:rgba(200,240,216,.62)}
.lp-coin button.mayhem.on .lp-coin-sub{color:rgba(246,196,152,.72)}
.lp-coin button.usdc.on .lp-coin-sub{color:rgba(168,196,240,.72)}
.lp-coin-emoji{display:block;font-size:.95rem;line-height:1;margin-bottom:.18rem}
.lp-coin-note{font-size:.7rem;color:rgba(255,255,255,.42);line-height:1.5;padding:.45rem .65rem;
  background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.06);border-radius:8px}
.lp-coin-note.mayhem{color:rgba(246,196,152,.85);background:rgba(246,140,80,.07);border-color:rgba(246,140,80,.2)}
.lp-coin-note.usdc{color:rgba(168,196,240,.85);background:rgba(120,160,240,.07);border-color:rgba(120,160,240,.22)}
.lp-empty{text-align:center;padding:2.5rem 1rem;color:rgba(255,255,255,.3);font-size:.85rem;line-height:1.7}
.lp-empty a{color:rgba(164,240,188,.7);text-decoration:none}
.lp-empty a:hover{color:#a4f0bc}

/* Guided onboarding (empty / pre-avatar state) */
.lp-guide{display:flex;flex-direction:column;gap:.95rem}
.lp-guide-h{font-size:1rem;font-weight:600;color:rgba(255,255,255,.92);margin:0;letter-spacing:-.01em}
.lp-guide-sub{font-size:.78rem;color:rgba(255,255,255,.5);line-height:1.55;margin:0}
.lp-guide-steps{display:flex;flex-direction:column;gap:.55rem;margin:.1rem 0}
.lp-guide-step{display:flex;gap:.65rem;align-items:flex-start;padding:.55rem .7rem;
  background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.06);border-radius:9px}
.lp-guide-num{flex-shrink:0;width:22px;height:22px;border-radius:50%;
  background:rgba(164,240,188,.12);border:1px solid rgba(164,240,188,.3);
  color:#a4f0bc;font-size:.72rem;font-weight:600;display:flex;align-items:center;justify-content:center;line-height:1}
.lp-guide-step-body{font-size:.78rem;color:rgba(255,255,255,.7);line-height:1.5}
.lp-guide-step-body b{color:rgba(255,255,255,.92);font-weight:600}
.lp-guide-types{display:grid;grid-template-columns:1fr 1fr;gap:.45rem;font-size:.72rem;line-height:1.45}
.lp-guide-type{padding:.45rem .55rem;background:rgba(255,255,255,.025);
  border:1px solid rgba(255,255,255,.06);border-radius:7px;color:rgba(255,255,255,.55)}
.lp-guide-type b{display:block;color:rgba(255,255,255,.85);font-size:.76rem;font-weight:600;margin-bottom:.15rem}
.lp-guide-tip{display:flex;gap:.5rem;font-size:.72rem;color:rgba(255,255,255,.5);
  line-height:1.55;padding:.55rem .65rem;background:rgba(164,240,188,.04);
  border:1px solid rgba(164,240,188,.14);border-radius:8px}
.lp-guide-tip-ic{flex-shrink:0;color:rgba(164,240,188,.7)}
.lp-guide-cta{margin-top:.2rem;padding:.65rem .8rem;border-radius:9px;text-align:center;
  font-size:.85rem;color:rgba(164,240,188,.85);background:rgba(164,240,188,.07);
  border:1px solid rgba(164,240,188,.22);text-decoration:none;font-weight:500}
.lp-guide-cta:hover{background:rgba(164,240,188,.12);color:#c8f0d8}
.lp-guide-links{display:flex;gap:.5rem;font-size:.72rem;flex-wrap:wrap}
.lp-guide-links a{color:rgba(255,255,255,.45);text-decoration:none;padding:.3rem .55rem;
  background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:6px}
.lp-guide-links a:hover{color:rgba(255,255,255,.85);background:rgba(255,255,255,.06)}

/* Existing-token card */
.lp-existing{display:flex;flex-direction:column;gap:.75rem}
.lp-ex-head{display:flex;align-items:center;gap:.55rem;font-size:.72rem;color:#a4f0bc;font-weight:500;letter-spacing:.03em}
.lp-ex-dot{width:7px;height:7px;border-radius:50%;background:#a4f0bc;box-shadow:0 0 6px rgba(164,240,188,.45)}
.lp-ex-card{display:flex;gap:.75rem;align-items:center;padding:.85rem;border-radius:12px;
  background:rgba(164,240,188,.04);border:1px solid rgba(164,240,188,.14)}
.lp-ex-thumb{width:52px;height:52px;border-radius:9px;object-fit:cover;flex-shrink:0;
  border:1px solid rgba(164,240,188,.2)}
.lp-ex-thumb-ph{width:52px;height:52px;border-radius:9px;background:rgba(164,240,188,.08);
  display:flex;align-items:center;justify-content:center;font-size:1.4rem;flex-shrink:0}
.lp-ex-info{flex:1;min-width:0}
.lp-ex-sym{font-size:1rem;font-weight:700;color:#fff;letter-spacing:-.01em}
.lp-ex-name{font-size:.75rem;color:rgba(255,255,255,.45);margin-top:.08rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lp-ex-since{font-size:.65rem;color:rgba(255,255,255,.3);margin-top:.3rem}
.lp-ex-stats{display:grid;grid-template-columns:1fr 1fr;gap:.4rem}
.lp-ex-stat{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:8px;
  padding:.45rem .6rem}
.lp-ex-stat-n{font-size:.92rem;font-weight:600;color:#fff}
.lp-ex-stat-l{font-size:.62rem;color:rgba(255,255,255,.4);margin-top:.05rem}
.lp-ex-mint{display:flex;align-items:center;gap:.5rem;padding:.45rem .65rem;border-radius:8px;
  background:rgba(255,255,255,.03);font-family:ui-monospace,monospace;font-size:.73rem;color:rgba(255,255,255,.55)}
.lp-ex-mint span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lp-ex-links{display:flex;gap:.45rem;flex-wrap:wrap}
.lp-ex-link{padding:.36rem .65rem;border-radius:7px;font-size:.77rem;text-decoration:none;
  background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.75);transition:all .15s}
.lp-ex-link:hover{background:rgba(255,255,255,.1);color:#fff}
.lp-ex-new{width:100%;padding:.42rem;border-radius:7px;cursor:pointer;background:transparent;
  border:1px solid rgba(255,255,255,.07);color:rgba(255,255,255,.32);font-size:.77rem}
.lp-ex-new:hover{color:rgba(255,255,255,.62);border-color:rgba(255,255,255,.16)}

/* Checking spinner */
.lp-checking{display:flex;align-items:center;gap:.55rem;padding:.65rem .75rem;border-radius:10px;
  background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);
  font-size:.78rem;color:rgba(255,255,255,.38)}
@keyframes lp-spin{to{transform:rotate(360deg)}}
.lp-spin{width:14px;height:14px;border:2px solid rgba(255,255,255,.12);border-top-color:rgba(255,255,255,.5);
  border-radius:50%;animation:lp-spin .8s linear infinite;flex-shrink:0}

/* Launch form token card */
.lp-card{display:flex;gap:.8rem;align-items:flex-start;padding:.85rem;border-radius:12px;
  background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);transition:border-color .2s}
.lp-card:focus-within{border-color:rgba(255,255,255,.14)}
.lp-img-zone{flex-shrink:0;width:78px;height:78px;border-radius:11px;border:2px dashed rgba(255,255,255,.14);
  cursor:pointer;overflow:hidden;display:flex;align-items:center;justify-content:center;
  background:rgba(255,255,255,.03);position:relative;transition:all .2s}
.lp-img-zone:hover,.lp-img-zone.dragover{border-color:rgba(164,240,188,.5);background:rgba(164,240,188,.05)}
.lp-img-zone img{width:100%;height:100%;object-fit:cover;border-radius:9px}
.lp-img-ph{font-size:.62rem;color:rgba(255,255,255,.28);text-align:center;line-height:1.5;padding:.25rem;pointer-events:none}
.lp-img-file{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}
.lp-card-fields{flex:1;min-width:0;display:flex;flex-direction:column;gap:.35rem;padding-top:.1rem}
.lp-iname{width:100%;font-size:.97rem;font-weight:600;background:transparent;border:none;
  border-bottom:1px solid rgba(255,255,255,.09);color:#fff;padding:0 0 .28rem;outline:none;transition:border-color .15s}
.lp-iname:focus{border-bottom-color:rgba(255,255,255,.28)}
.lp-iname::placeholder{color:rgba(255,255,255,.2);font-weight:400}
.lp-isymbol{width:100%;font-size:.8rem;background:transparent;border:none;color:#a4f0bc;
  padding:0;outline:none;font-family:ui-monospace,monospace;letter-spacing:.05em}
.lp-isymbol::placeholder{color:rgba(164,240,188,.28)}
.lp-img-hint{font-size:.6rem;color:rgba(255,255,255,.2);margin-top:.3rem}
.lp-cap-btn{margin-top:.4rem;align-self:flex-start;padding:.32rem .6rem;border-radius:6px;cursor:pointer;
  background:rgba(164,240,188,.08);border:1px solid rgba(164,240,188,.2);color:#c8f0d8;
  font-size:.72rem;transition:all .15s}
.lp-cap-btn:hover:not([disabled]){background:rgba(164,240,188,.15);border-color:rgba(164,240,188,.35)}
.lp-cap-btn[disabled]{opacity:.4;cursor:not-allowed}

.lp label{font-size:.72rem;color:rgba(255,255,255,.4);display:block;margin-bottom:.22rem}
.lp textarea,.lp-number{width:100%;padding:.5rem .7rem;border-radius:8px;outline:none;
  background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);
  color:#fff;font-size:.85rem;font-family:inherit;box-sizing:border-box;transition:border-color .15s}
.lp textarea{resize:vertical}
.lp textarea:focus,.lp-number:focus{border-color:rgba(255,255,255,.2)}
.lp-number::-webkit-inner-spin-button{opacity:.4}
.lp-2col{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}
.lp-slider-head{display:flex;justify-content:space-between;align-items:baseline}
.lp-bps-val{font-size:.78rem;color:#a4f0bc;font-weight:500}
.lp-slider{width:100%;accent-color:#a4f0bc;margin-top:.4rem;cursor:pointer}
.lp-slider-hint{font-size:.62rem;color:rgba(255,255,255,.22);margin-top:.18rem}

/* Wallet bar */
.lp-wallet{display:flex;align-items:center;gap:.55rem;padding:.58rem .8rem;
  background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px;font-size:.78rem}
.lp-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;transition:background .3s}
.lp-dot.on{background:#a4f0bc;box-shadow:0 0 6px rgba(164,240,188,.45)}
.lp-dot.off{background:rgba(255,255,255,.18)}
.lp-wallet-info{flex:1;min-width:0}
.lp-wallet-addr{color:rgba(255,255,255,.75);background:none;border:none;padding:0;cursor:pointer;
  font:inherit;font-family:ui-monospace,monospace;vertical-align:baseline;
  text-align:left;display:inline}
.lp-wallet-addr:hover{color:#fff;text-decoration:underline;text-decoration-color:rgba(255,255,255,.2);
  text-underline-offset:3px}
.lp-wallet-addr:focus-visible{outline:1px solid rgba(164,240,188,.5);outline-offset:2px;border-radius:3px}
.lp-wallet-bal{color:rgba(255,255,255,.42);margin-left:.4rem;font-size:.73rem}
.lp-wallet-cost{display:block;font-size:.69rem;margin-top:.1rem}
.lp-wallet-cost.ok{color:#a4f0bc}
.lp-wallet-cost.warn{color:#f6b3b3}
.lp-wallet-cost.dim{color:rgba(255,255,255,.3)}
.lp-wallet-none{flex:1;color:rgba(255,255,255,.32)}
.lp-link-row{display:flex;align-items:center;gap:.55rem;padding:.55rem .8rem;margin-top:.3rem;
  background:rgba(246,179,179,.06);border:1px solid rgba(246,179,179,.22);border-radius:8px;
  font-size:.73rem;color:rgba(255,221,221,.85);line-height:1.35}
.lp-link-row.checking{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.08);color:rgba(255,255,255,.5)}
.lp-link-row.conflict{background:rgba(255,196,114,.08);border-color:rgba(255,196,114,.32);color:rgba(255,230,194,.9)}
.lp-link-row .lp-link-info{flex:1;min-width:0}
.lp-link-row .lp-link-title{display:block;font-weight:500;color:#fff;margin-bottom:.1rem;font-size:.78rem}
.lp-link-row .lp-link-sub{display:block;color:rgba(255,255,255,.55);font-size:.7rem}
.lp-link-row .lp-link-err{display:block;color:#f6b3b3;margin-top:.2rem;font-size:.7rem}
.lp-link-btn{padding:.42rem .85rem;border-radius:7px;border:1px solid rgba(164,240,188,.4);
  background:rgba(164,240,188,.12);color:#c8f0d8;font-size:.74rem;font-weight:500;cursor:pointer;
  white-space:nowrap}
.lp-link-btn:hover:not([disabled]){background:rgba(164,240,188,.2)}
.lp-link-btn[disabled]{opacity:.55;cursor:wait}
.lp-wbtn{padding:.28rem .65rem;border-radius:6px;cursor:pointer;flex-shrink:0;
  background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);
  color:rgba(255,255,255,.78);font-size:.72rem;white-space:nowrap;transition:background .15s}
.lp-wbtn:hover{background:rgba(255,255,255,.13)}
.lp-wbtn.ghost{opacity:.4;font-size:.65rem}
.lp-wbtn.deposit{background:rgba(164,240,188,.1);border-color:rgba(164,240,188,.25);color:#c8f0d8}
.lp-wbtn.deposit:hover{background:rgba(164,240,188,.18);border-color:rgba(164,240,188,.4)}

/* Deposit modal */
.lp-dep-bd{position:fixed;inset:0;background:rgba(0,0,0,.72);backdrop-filter:blur(6px);
  display:flex;align-items:center;justify-content:center;z-index:9999;padding:1rem}
.lp-dep{width:100%;max-width:380px;background:#15171a;border:1px solid rgba(255,255,255,.1);
  border-radius:16px;padding:1.4rem;display:flex;flex-direction:column;gap:1rem;
  box-shadow:0 24px 60px rgba(0,0,0,.5)}
.lp-dep-head{display:flex;align-items:flex-start;justify-content:space-between;gap:.5rem}
.lp-dep-title{font-size:1rem;font-weight:600;color:#fff;margin:0}
.lp-dep-sub{font-size:.72rem;color:rgba(255,255,255,.42);margin:.2rem 0 0;line-height:1.45}
.lp-dep-x{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);
  color:rgba(255,255,255,.65);width:28px;height:28px;border-radius:7px;cursor:pointer;
  font-size:1rem;line-height:1;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.lp-dep-x:hover{background:rgba(255,255,255,.12);color:#fff}
.lp-dep-qr{align-self:center;background:#fff;padding:.75rem;border-radius:12px;line-height:0;
  width:244px;height:244px;display:flex;align-items:center;justify-content:center}
.lp-dep-qr canvas{display:block;border-radius:4px}
.lp-dep-qr-load{width:24px;height:24px;border:3px solid rgba(0,0,0,.12);border-top-color:rgba(0,0,0,.45);
  border-radius:50%;animation:lp-spin .8s linear infinite}
.lp-dep-qr-err{font-size:.72rem;color:#a33;text-align:center;padding:1rem}
.lp-dep-net{align-self:center;font-size:.68rem;color:rgba(164,240,188,.7);
  background:rgba(164,240,188,.08);border:1px solid rgba(164,240,188,.2);
  padding:.22rem .55rem;border-radius:999px;letter-spacing:.04em}
.lp-dep-addr{display:flex;align-items:center;gap:.5rem;padding:.6rem .75rem;
  background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:9px;
  cursor:pointer;transition:border-color .15s}
.lp-dep-addr:hover{border-color:rgba(255,255,255,.18)}
.lp-dep-addr code{flex:1;min-width:0;font-family:ui-monospace,monospace;font-size:.72rem;
  color:rgba(255,255,255,.75);word-break:break-all;line-height:1.4}
.lp-dep-addr-copy{flex-shrink:0;font-size:.7rem;color:rgba(164,240,188,.75);font-weight:500}
.lp-dep-note{font-size:.7rem;color:rgba(255,255,255,.35);line-height:1.5;text-align:center;
  padding:.4rem 0;border-top:1px solid rgba(255,255,255,.05)}
.lp-dep-warn{font-size:.68rem;color:rgba(246,200,100,.85);background:rgba(246,200,100,.06);
  border:1px solid rgba(246,200,100,.18);padding:.5rem .65rem;border-radius:8px;line-height:1.5}

/* Launch button */
.lp-launch{width:100%;padding:.8rem 1rem;border-radius:10px;cursor:pointer;
  background:linear-gradient(135deg,rgba(120,200,140,.22),rgba(60,140,100,.14));
  border:1px solid rgba(120,200,140,.42);color:#c6f0d6;
  font-size:.94rem;font-weight:600;letter-spacing:-.01em;transition:all .15s;line-height:1}
.lp-launch:hover:not([disabled]){background:linear-gradient(135deg,rgba(120,200,140,.33),rgba(60,140,100,.22));
  border-color:rgba(120,200,140,.65);color:#d8f5e2}
.lp-launch[disabled]{opacity:.38;cursor:not-allowed}
.lp-launch.busy{opacity:.72;cursor:wait}
.lp-phase{font-size:.7rem;color:rgba(255,255,255,.35);text-align:center;min-height:1.1em;margin-top:.15rem}
.lp-err{font-size:.78rem;color:#f6b3b3;padding:.55rem .75rem;line-height:1.5;
  border-radius:8px;background:rgba(246,179,179,.07);border:1px solid rgba(246,179,179,.18)}
.lp-err-sub{font-size:.7rem;color:rgba(255,255,255,.3);margin-top:.3rem}

/* Confirmation timeout escape hatch */
.lp-timeout{display:flex;flex-direction:column;gap:.7rem;padding:.85rem;border-radius:12px;
  background:rgba(246,200,100,.05);border:1px solid rgba(246,200,100,.18)}
.lp-timeout-title{font-size:.85rem;font-weight:600;color:rgba(246,220,130,.9)}
.lp-timeout-body{font-size:.78rem;color:rgba(255,255,255,.55);line-height:1.55}
.lp-timeout-sig{font-family:ui-monospace,monospace;font-size:.7rem;color:rgba(255,255,255,.4);
  word-break:break-all;padding:.4rem .55rem;background:rgba(255,255,255,.04);border-radius:6px}
.lp-timeout-btns{display:flex;gap:.5rem;flex-wrap:wrap}
.lp-tbtn{padding:.42rem .8rem;border-radius:8px;cursor:pointer;font-size:.8rem;transition:all .15s}
.lp-tbtn.primary{background:rgba(164,240,188,.14);border:1px solid rgba(164,240,188,.3);color:#c8f0d8}
.lp-tbtn.primary:hover{background:rgba(164,240,188,.22)}
.lp-tbtn.ghost{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.6)}
.lp-tbtn.ghost:hover{background:rgba(255,255,255,.1)}

/* Success */
.lp-ok{display:flex;flex-direction:column;align-items:center;gap:.85rem;text-align:center}
.lp-ok-thumb{width:82px;height:82px;border-radius:50%;object-fit:cover;border:2px solid rgba(164,240,188,.4)}
.lp-ok-thumb-ph{width:82px;height:82px;border-radius:50%;background:rgba(164,240,188,.08);
  border:2px solid rgba(164,240,188,.2);display:flex;align-items:center;justify-content:center;font-size:2.2rem}
.lp-ok-title{font-size:1.3rem;font-weight:700;color:#a4f0bc;letter-spacing:-.02em;margin:0}
.lp-ok-sub{font-size:.78rem;color:rgba(255,255,255,.38);margin:-.45rem 0 0}
.lp-ok-mint{display:flex;align-items:center;gap:.5rem;padding:.5rem .75rem;
  background:rgba(255,255,255,.04);border-radius:8px;width:100%;
  font-family:ui-monospace,monospace;font-size:.75rem;color:rgba(255,255,255,.6)}
.lp-ok-mint span{flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lp-copy{padding:.2rem .5rem;border-radius:5px;cursor:pointer;flex-shrink:0;
  background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);
  color:rgba(255,255,255,.65);font-size:.7rem;white-space:nowrap}
.lp-copy:hover{background:rgba(255,255,255,.15)}
.lp-ok-links{display:flex;gap:.45rem;justify-content:center;flex-wrap:wrap;width:100%}
.lp-ext{padding:.38rem .7rem;border-radius:7px;font-size:.78rem;text-decoration:none;
  background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);
  color:rgba(255,255,255,.78);transition:all .15s}
.lp-ext:hover{background:rgba(255,255,255,.11);color:#fff}
.lp-share{width:100%;padding:.55rem .9rem;border-radius:8px;cursor:pointer;
  background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);
  color:rgba(255,255,255,.65);font-size:.8rem}
.lp-share:hover{background:rgba(255,255,255,.09);color:rgba(255,255,255,.92)}
.lp-again{width:100%;padding:.42rem;border-radius:7px;cursor:pointer;background:transparent;
  border:1px solid rgba(255,255,255,.07);color:rgba(255,255,255,.32);font-size:.77rem}
.lp-again:hover{color:rgba(255,255,255,.62);border-color:rgba(255,255,255,.16)}
`;

let _cssInjected = false;
function injectCss() {
	if (_cssInjected || typeof document === 'undefined') return;
	_cssInjected = true;
	const el = document.createElement('style');
	el.textContent = LP_CSS;
	document.head.appendChild(el);
}

// ── Mount ─────────────────────────────────────────────────────────────────────

const DEMO_ID = '__demo__';

export function mountLaunchPanel(container, { getAvatar, getUser, getPreviewViewer } = {}) {
	injectCss();

	let av = null;

	// ── State ──────────────────────────────────────────────────────────────

	let s = {
		// form
		name: '', symbol: '', description: '',
		initialBuy: '0', buybackBps: 500,
		imageFile: null, imagePreviewUrl: null,
		_symbolEdited: false,

		// coin type: 'agent' (default — buyback-bound), 'regular' (plain pump.fun coin),
		// 'mayhem' (pump.fun mayhem mode), 'usdc' (USDC-denominated agent — coming soon)
		coinType: 'agent',

		// wallet source: 'connected' (Phantom/Backpack) or 'agent' (custodial agent wallet)
		walletSource: 'connected',

		// connected wallet
		walletAddr: null, solBalance: null,
		// link status: null=unknown/checking, true=linked, false=not linked
		walletLinked: null, walletLinkChecking: false, walletLinking: false, walletLinkError: '',
		// True after a 409 from /link-solana; flips the link row into a
		// "Transfer wallet to this account" confirmation that re-signs with
		// takeover=true.
		walletConflict: false,

		// agent wallet (resolved/provisioned when source switches to 'agent')
		agentWallet: null,         // { agent_id, address, sol, lamports } | null
		agentWalletLoading: false,
		agentWalletError: '',
		_agentBalanceTimer: null,

		// existing token (checked on avatar change)
		checkingMint: false,
		existingMint: null,   // { mint, name, symbol, network, metadata_uri, stats, burns }
		forceNew: false,      // user clicked "launch another token" despite existing

		// launch phases: idle | building | signing | confirming | confirm-timeout | success | error
		phase: 'idle', phaseLabel: '',
		errorMsg: '',

		// success
		mint: null, resolvedAgentId: null,

		// timeout escape hatch
		pendingConfirm: null, // { prepId, sig, network }

		// metadata cache
		_metaUrl: null, _metaKey: null,
	};

	// ── Cleanup registry ───────────────────────────────────────────────────

	let _balanceInterval = null;
	const _walletListeners = []; // [{ wallet, event, fn }]

	function cleanup() {
		if (_balanceInterval) { clearInterval(_balanceInterval); _balanceInterval = null; }
		if (s._agentBalanceTimer) { clearInterval(s._agentBalanceTimer); s._agentBalanceTimer = null; }
		for (const { wallet, event, fn } of _walletListeners) {
			try { wallet.off?.(event, fn); } catch { /* ignore */ }
		}
		_walletListeners.length = 0;
	}

	// ── Existing token check ───────────────────────────────────────────────

	async function checkExistingMint(avatar) {
		if (!avatar || avatar.id === DEMO_ID) { s.existingMint = null; s.checkingMint = false; return; }
		s.checkingMint = true;
		render();
		try {
			const param = avatar.agent_id
				? `agent_id=${encodeURIComponent(avatar.agent_id)}`
				: `avatar_id=${encodeURIComponent(avatar.id)}`;
			const res = await fetch(`/api/pump/by-agent?${param}`, { credentials: 'include' });
			if (res.ok) {
				const { data } = await res.json();
				s.existingMint = data || null;
			}
		} catch { /* best-effort */ }
		s.checkingMint = false;
		render();
	}

	// ── Wallet management ──────────────────────────────────────────────────

	function subscribeWalletEvents(wallet) {
		if (!wallet?.on) return;

		const onAccountsChanged = (accounts) => {
			const acc  = Array.isArray(accounts) ? accounts[0] : accounts;
			const addr = acc?.toBase58?.() || (typeof acc === 'string' ? acc : null);
			if (!addr) { disconnectWallet(); return; }
			if (addr === s.walletAddr) return;
			s.walletAddr = addr;
			s.solBalance = null;
			s.walletLinked = null; s.walletLinkError = ''; s.walletConflict = false;
			render();
			fetchBalance(addr);
			checkWalletLinked(addr);
		};

		const onDisconnect = () => disconnectWallet();

		wallet.on('accountsChanged', onAccountsChanged);
		wallet.on('disconnect',       onDisconnect);
		_walletListeners.push(
			{ wallet, event: 'accountsChanged', fn: onAccountsChanged },
			{ wallet, event: 'disconnect',      fn: onDisconnect },
		);
	}

	async function tryAutoConnect() {
		const w = detectWallet();
		if (!w?.isConnected || !w.publicKey) return;
		const addr = w.publicKey.toBase58?.() || w.publicKey.toString?.();
		if (!addr || addr === s.walletAddr) return;
		s.walletAddr = addr;
		s.walletLinked = null; s.walletLinkError = '';
		render();
		subscribeWalletEvents(w);
		startBalancePoll(addr);
		checkWalletLinked(addr);
	}

	async function connectWallet() {
		let w = detectWallet();
		if (!w) { window.open('https://phantom.app/', '_blank', 'noopener'); return; }
		try {
			if (!w.isConnected) await w.connect?.();
			const addr = w.publicKey?.toBase58?.() || w.publicKey?.toString?.();
			if (!addr) return;
			s.walletAddr = addr;
			s.walletLinked = null; s.walletLinkError = ''; s.walletConflict = false;
			render();
			subscribeWalletEvents(w);
			startBalancePoll(addr);
			checkWalletLinked(addr);
		} catch { /* user dismissed */ }
	}

	function disconnectWallet() {
		s.walletAddr = null; s.solBalance = null;
		s.walletLinked = null; s.walletLinkChecking = false;
		s.walletLinking = false; s.walletLinkError = '';
		s.walletConflict = false;
		if (_balanceInterval) { clearInterval(_balanceInterval); _balanceInterval = null; }
		render();
	}

	// Check whether the connected wallet is already linked to the signed-in
	// account. Returns silently on auth failure — the launch flow surfaces
	// "sign in to launch" separately.
	async function checkWalletLinked(addr) {
		if (!addr) return;
		s.walletLinkChecking = true;
		s.walletLinkError = '';
		render();
		try {
			const r = await fetch('/api/auth/wallets', { credentials: 'include' });
			if (r.status === 401) { s.walletLinked = null; return; }
			const data = await r.json();
			const linked = Array.isArray(data.wallets)
				&& data.wallets.some((w) => w.address === addr && w.chain_type === 'solana');
			s.walletLinked = linked;
		} catch {
			s.walletLinked = null;
		} finally {
			s.walletLinkChecking = false;
			render();
		}
	}

	// Run the SIWS link ceremony for the connected wallet. Triggered by the
	// explicit "Link wallet" button so the user understands the prompt.
	// When `takeover` is true the server is told to move the wallet from
	// whichever account currently holds it to the session user — only
	// reached from the conflict confirmation UI.
	async function linkConnectedWallet(takeover = false) {
		const provider = detectWallet();
		const addr = s.walletAddr;
		if (!provider || !addr || s.walletLinking) return;
		s.walletLinking = true; s.walletLinkError = '';
		render();
		try {
			await linkSolanaWallet(provider, addr, { takeover });
			s.walletLinked = true;
			s.walletConflict = false;
		} catch (e) {
			if (e.code === 'address_in_use' && !takeover) {
				s.walletConflict = true;
				s.walletLinkError = '';
			} else {
				s.walletLinkError = friendlyError(e.message || String(e));
			}
		} finally {
			s.walletLinking = false;
			render();
		}
	}

	async function fetchBalance(addr) {
		try {
			const { Connection, PublicKey } = await import('https://esm.sh/@solana/web3.js@1.98.4');
			const conn = new Connection(RPC_URL, 'confirmed');
			s.solBalance = (await conn.getBalance(new PublicKey(addr))) / 1e9;
		} catch { s.solBalance = null; }
		render();
	}

	function startBalancePoll(addr) {
		if (_balanceInterval) clearInterval(_balanceInterval);
		fetchBalance(addr);
		_balanceInterval = setInterval(() => { if (s.walletAddr) fetchBalance(s.walletAddr); }, 30_000);
	}

	async function copyAddressToClipboard(btn) {
		if (!s.walletAddr || !btn) return;
		const orig = btn.textContent;
		try {
			await navigator.clipboard.writeText(s.walletAddr);
			btn.textContent = '✓ Copied full address';
		} catch (err) {
			console.warn('[launch-panel] clipboard write failed', err);
			btn.textContent = 'Copy failed';
		}
		setTimeout(() => { if (btn.isConnected) btn.textContent = orig; }, 1800);
	}

	async function openDepositModal() {
		if (!s.walletAddr) return;
		const addr = s.walletAddr;
		// Solana Pay URI — mobile wallets (Phantom, Solflare, Backpack) recognize this
		// scheme and pre-fill a transfer screen. Plain addresses also work as a fallback.
		const payUri = `solana:${addr}?label=${encodeURIComponent('three.ws launch wallet')}`;

		const prevActive = document.activeElement;
		const prevOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';

		const bd = document.createElement('div');
		bd.className = 'lp-dep-bd';
		bd.innerHTML = `<div class="lp-dep" role="dialog" aria-modal="true" aria-labelledby="lp-dep-title">
			<div class="lp-dep-head">
				<div>
					<p class="lp-dep-title" id="lp-dep-title">Deposit SOL</p>
					<p class="lp-dep-sub">Send SOL to this wallet to fund your token launch.</p>
				</div>
				<button class="lp-dep-x" id="lp-dep-close" aria-label="Close">✕</button>
			</div>
			<span class="lp-dep-net">SOLANA · MAINNET</span>
			<div class="lp-dep-qr" id="lp-dep-qr">
				<div class="lp-dep-qr-load" role="status" aria-live="polite" aria-label="Loading QR code"></div>
			</div>
			<div class="lp-dep-addr" id="lp-dep-addr" role="button" tabindex="0" aria-label="Copy wallet address">
				<code>${esc(addr)}</code>
				<span class="lp-dep-addr-copy" id="lp-dep-addr-label">Copy</span>
			</div>
			<div class="lp-dep-warn">Only send SOL on Solana mainnet. Other networks or tokens will be lost.</div>
			<div class="lp-dep-note">Balance refreshes automatically once the deposit confirms on-chain.</div>
		</div>`;
		document.body.appendChild(bd);

		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			bd.remove();
			document.removeEventListener('keydown', onKey);
			document.body.style.overflow = prevOverflow;
			if (prevActive && prevActive.isConnected && typeof prevActive.focus === 'function') {
				prevActive.focus();
			}
		};

		// Focus trap: cycle Tab/Shift+Tab between the modal's interactive elements.
		const FOCUSABLE = '#lp-dep-close, #lp-dep-addr';
		const onKey = (e) => {
			if (e.key === 'Escape') { close(); return; }
			if (e.key !== 'Tab') return;
			const items = Array.from(bd.querySelectorAll(FOCUSABLE));
			if (items.length === 0) return;
			const first = items[0], last = items[items.length - 1];
			const active = document.activeElement;
			if (e.shiftKey && (active === first || !bd.contains(active))) {
				e.preventDefault(); last.focus();
			} else if (!e.shiftKey && (active === last || !bd.contains(active))) {
				e.preventDefault(); first.focus();
			}
		};
		document.addEventListener('keydown', onKey);
		bd.addEventListener('click', (e) => { if (e.target === bd) close(); });
		bd.querySelector('#lp-dep-close').addEventListener('click', close);

		const setLabel = (text, restore = true) => {
			const label = bd.querySelector('#lp-dep-addr-label');
			if (!label) return;
			label.textContent = text;
			if (restore) setTimeout(() => { if (!closed) label.textContent = 'Copy'; }, 1800);
		};
		const copyAddr = async () => {
			try {
				await navigator.clipboard.writeText(addr);
				setLabel('✓ Copied');
			} catch (err) {
				console.warn('[launch-panel] clipboard write failed', err);
				setLabel('Copy failed');
			}
		};
		const addrEl = bd.querySelector('#lp-dep-addr');
		addrEl.addEventListener('click', copyAddr);
		addrEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copyAddr(); } });

		bd.querySelector('#lp-dep-close').focus();

		try {
			const mod = await import('https://esm.sh/qrcode@1.5.3');
			if (closed) return;
			const QRCode = mod.default ?? mod;
			const canvas = document.createElement('canvas');
			await QRCode.toCanvas(canvas, payUri, {
				width: 220,
				margin: 1,
				errorCorrectionLevel: 'M',
				color: { dark: '#0a0c0e', light: '#ffffff' },
			});
			if (closed) return;
			const slot = bd.querySelector('#lp-dep-qr');
			if (slot) { slot.innerHTML = ''; slot.appendChild(canvas); }
		} catch (err) {
			console.warn('[launch-panel] QR render failed', err);
			if (closed) return;
			const slot = bd.querySelector('#lp-dep-qr');
			if (slot) slot.innerHTML = `<div class="lp-dep-qr-err">QR unavailable —<br>copy address below</div>`;
		}
	}

	// ── Agent wallet (custodial) ───────────────────────────────────────────

	async function loadAgentWallet() {
		if (!av || av.id === DEMO_ID) return;
		s.agentWalletLoading = true;
		s.agentWalletError = '';
		render();
		try {
			const body = av.agent_id ? { agent_id: av.agent_id } : { avatar_id: av.id };
			const r = await fetch('/api/pump/agent-wallet', {
				method: 'POST', credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ...body, network: 'mainnet' }),
			});
			const data = await r.json();
			if (!r.ok) throw new Error(data.error_description || data.error || `HTTP ${r.status}`);
			s.agentWallet = {
				agent_id: data.agent_id,
				address: data.address,
				lamports: data.lamports,
				sol: data.sol,
			};
		} catch (e) {
			s.agentWalletError = e.message || String(e);
			s.agentWallet = null;
		}
		s.agentWalletLoading = false;
		render();
		startAgentBalancePoll();
	}

	async function refreshAgentBalance() {
		if (!s.agentWallet?.address) return;
		try {
			const { Connection, PublicKey } = await import('https://esm.sh/@solana/web3.js@1.98.4');
			const conn = new Connection(RPC_URL, 'confirmed');
			const lamports = await conn.getBalance(new PublicKey(s.agentWallet.address));
			s.agentWallet = { ...s.agentWallet, lamports, sol: lamports / 1e9 };
			render();
		} catch { /* ignore */ }
	}

	function startAgentBalancePoll() {
		if (s._agentBalanceTimer) clearInterval(s._agentBalanceTimer);
		s._agentBalanceTimer = setInterval(refreshAgentBalance, 30_000);
	}

	function stopAgentBalancePoll() {
		if (s._agentBalanceTimer) { clearInterval(s._agentBalanceTimer); s._agentBalanceTimer = null; }
	}

	async function copyAgentAddress(btn) {
		if (!s.agentWallet?.address) return;
		try { await navigator.clipboard.writeText(s.agentWallet.address); } catch { return; }
		if (!btn) return;
		const orig = btn.textContent;
		btn.textContent = '✓ Copied';
		setTimeout(() => { btn.textContent = orig; }, 1600);
	}

	async function openAgentDepositModal() {
		const addr = s.agentWallet?.address;
		if (!addr) return;
		const bd = document.createElement('div');
		bd.className = 'lp-dep-bd';
		bd.innerHTML = `<div class="lp-dep" role="dialog" aria-label="Fund agent wallet">
			<div class="lp-dep-head">
				<div>
					<p class="lp-dep-title">Fund agent wallet</p>
					<p class="lp-dep-sub">Send SOL to your agent's custodial wallet. The agent signs and pays for its own launch.</p>
				</div>
				<button class="lp-dep-x" id="lp-dep-close" aria-label="Close">✕</button>
			</div>
			<span class="lp-dep-net">SOLANA · MAINNET</span>
			<div class="lp-dep-qr" id="lp-dep-qr"></div>
			<div class="lp-dep-addr" id="lp-dep-addr" role="button" tabindex="0" title="Click to copy">
				<code>${esc(addr)}</code>
				<span class="lp-dep-addr-copy" id="lp-dep-addr-label">Copy</span>
			</div>
			<div class="lp-dep-warn">This wallet is custodial — keys are encrypted on three.ws servers. Only send SOL on Solana mainnet.</div>
			<div class="lp-dep-note">Balance refreshes every 30 seconds after deposit confirms.</div>
		</div>`;
		document.body.appendChild(bd);

		const close = () => { bd.remove(); document.removeEventListener('keydown', onKey); };
		const onKey = (e) => { if (e.key === 'Escape') close(); };
		document.addEventListener('keydown', onKey);
		bd.addEventListener('click', (e) => { if (e.target === bd) close(); });
		bd.querySelector('#lp-dep-close').addEventListener('click', close);

		const copyAddr = async () => {
			try { await navigator.clipboard.writeText(addr); } catch { return; }
			const label = bd.querySelector('#lp-dep-addr-label');
			if (!label) return;
			const orig = label.textContent;
			label.textContent = '✓ Copied';
			setTimeout(() => { label.textContent = orig; }, 1600);
		};
		const addrEl = bd.querySelector('#lp-dep-addr');
		addrEl.addEventListener('click', copyAddr);
		addrEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copyAddr(); } });

		try {
			const mod = await import('https://esm.sh/qrcode@1.5.3');
			const QRCode = mod.default ?? mod;
			const canvas = document.createElement('canvas');
			await QRCode.toCanvas(canvas, addr, { width: 220, margin: 1, color: { dark: '#0a0c0e', light: '#ffffff' } });
			const slot = bd.querySelector('#lp-dep-qr');
			if (slot) { slot.innerHTML = ''; slot.appendChild(canvas); }
		} catch {
			const slot = bd.querySelector('#lp-dep-qr');
			if (slot) slot.innerHTML = `<div style="padding:1rem;font-size:.72rem;color:#666">QR unavailable — copy address below</div>`;
		}
	}

	function switchSource(next) {
		if (next === s.walletSource) return;
		s.walletSource = next;
		s.errorMsg = '';
		if (next === 'agent') {
			if (!s.agentWallet && !s.agentWalletLoading) loadAgentWallet();
			else render();
		} else {
			stopAgentBalancePoll();
			render();
		}
	}

	function switchCoinType(next) {
		if (!['regular', 'mayhem', 'agent', 'usdc'].includes(next)) return;
		if (next === s.coinType) return;
		s.coinType = next;
		s.errorMsg = '';
		render();
	}

	// ── Image handling ─────────────────────────────────────────────────────

	function handleImageFile(file) {
		if (!file?.type.startsWith('image/')) return;
		if (file.size > 4 * 1024 * 1024) { alert('Image must be under 4 MB'); return; }
		s.imageFile = file;
		const reader = new FileReader();
		reader.onload = (e) => {
			s.imagePreviewUrl = e.target.result;
			const zone = container.querySelector('.lp-img-zone');
			if (!zone) return;
			const old = zone.querySelector('img, .lp-img-ph');
			if (old) old.remove();
			const img = document.createElement('img');
			img.src = s.imagePreviewUrl; img.alt = '';
			zone.insertBefore(img, zone.firstChild);
		};
		reader.readAsDataURL(file);
	}

	// Capture the current 3D preview as a square PNG and use it as the token image.
	// Renders a fresh frame first so toBlob works without preserveDrawingBuffer.
	async function captureFromViewer() {
		const viewer = getPreviewViewer?.();
		const renderer = viewer?.renderer;
		const scene    = viewer?.scene;
		const camera   = viewer?.activeCamera || viewer?.camera;
		const srcCanvas = renderer?.domElement;
		if (!renderer || !scene || !camera || !srcCanvas) {
			alert('Preview not ready yet — wait for the avatar to load.');
			return;
		}
		try {
			renderer.render(scene, camera);
		} catch {
			alert('Could not capture preview.');
			return;
		}
		// Crop to a centered square so the token image is balanced.
		const w = srcCanvas.width, h = srcCanvas.height;
		const size = Math.min(w, h);
		const sx = (w - size) >> 1, sy = (h - size) >> 1;
		const out = document.createElement('canvas');
		out.width = out.height = Math.min(1024, size);
		const ctx = out.getContext('2d');
		ctx.drawImage(srcCanvas, sx, sy, size, size, 0, 0, out.width, out.height);
		const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
		if (!blob) { alert('Could not capture preview.'); return; }
		const file = new File([blob], `avatar-${Date.now()}.png`, { type: 'image/png' });
		handleImageFile(file);
	}

	// ── Confirmation polling with timeout ──────────────────────────────────

	async function pollConfirmation(conn, sig, timeoutMs = 75_000) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const { value } = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
			const status = value?.[0];
			if (status) {
				if (status.err) throw new Error(`On-chain error: ${JSON.stringify(status.err)}`);
				if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
					return status;
			}
			await sleep(2000);
		}
		const err = new Error('Confirmation timeout — your transaction may still confirm.');
		err.code = 'CONFIRM_TIMEOUT';
		throw err;
	}

	// ── Launch ─────────────────────────────────────────────────────────────

	async function launch() {
		if (!formValid() || s.phase !== 'idle') return;
		if (!av || av.id === DEMO_ID) return;
		if (s.walletSource === 'connected' && !s.walletAddr) return;
		if (s.walletSource === 'agent' && !s.agentWallet?.address) return;
		s.errorMsg = '';

		try {
			// 1 ── Build / reuse metadata (shared)
			s.phase = 'building'; s.phaseLabel = 'Uploading metadata…'; render();

			const nameTrim = s.name.trim().slice(0, 32);
			// Preserve the symbol exactly as entered (whitespace/emoji/special chars), cap at 10 codepoints.
			const symTrim  = [...s.symbol].slice(0, 10).join('');
			const descTrim = s.description.trim().slice(0, 500);
			const metaKey = `${nameTrim}|${symTrim}|${descTrim}|${!!s.imageFile}`;

			if (s._metaKey !== metaKey || !s._metaUrl) {
				let imageDataUrl = null;
				if (s.imageFile) imageDataUrl = await fileToDataUrl(s.imageFile);
				const mr = await fetch('/api/pump/build-metadata', {
					method: 'POST', credentials: 'include',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						name: nameTrim, symbol: symTrim, description: descTrim,
						...(av.id       ? { avatar_id: av.id }      : {}),
						...(av.agent_id ? { agent_id: av.agent_id } : {}),
						...(imageDataUrl ? { image_data_url: imageDataUrl } : {}),
					}),
				});
				if (!mr.ok) {
					const errJson = await mr.json().catch(() => null);
					const detail = errJson?.error_description
						|| errJson?.issues?.map((i) => `${i.path?.join('.') || 'body'}: ${i.message}`).join('; ')
						|| errJson?.error
						|| `HTTP ${mr.status}`;
					throw new Error(`Metadata build failed — ${detail}`);
				}
				const md = await mr.json();
				s._metaUrl = md.metadata_url; s._metaKey = metaKey;
			}

			if (s.walletSource === 'agent') {
				await launchViaAgentWallet(nameTrim, symTrim);
			} else {
				await launchViaConnectedWallet(nameTrim, symTrim);
			}
		} catch (e) {
			s.errorMsg = friendlyError(e.message || String(e));
			s.phase = 'error'; render();
		}
	}

	// Issue a SIWS "link wallet" prompt and POST it to /api/auth/wallets/link-solana.
	// Idempotent on the server — safe to call when already linked.
	// With `{ takeover: true }`, an existing link on another account is moved
	// to the session user atomically (signature already proves ownership).
	async function linkSolanaWallet(provider, address, { takeover = false } = {}) {
		const nonceRes = await fetch('/api/auth/wallets/nonce-solana', {
			method: 'POST', credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ address, chainId: 'mainnet' }),
		});
		const nonceData = await nonceRes.json();
		if (!nonceRes.ok) {
			const err = new Error(nonceData.error_description || nonceData.error || 'Could not start wallet link');
			err.code = nonceData.error;
			throw err;
		}

		const msgBytes = new TextEncoder().encode(nonceData.message);
		const { signature } = await provider.signMessage(msgBytes, 'utf8');
		const sigBase64 = btoa(String.fromCharCode(...signature));

		const linkRes = await fetch('/api/auth/wallets/link-solana', {
			method: 'POST', credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ message: nonceData.message, signature: sigBase64, takeover }),
		});
		const linkData = await linkRes.json();
		if (!linkRes.ok) {
			const err = new Error(linkData.error_description || linkData.error || 'Wallet link failed');
			err.code = linkData.error;
			err.takeoverAvailable = linkData.takeover_available === true;
			throw err;
		}
	}

	async function launchViaConnectedWallet(nameTrim, symTrim) {
		// Prep transaction
		s.phase = 'signing'; s.phaseLabel = 'Sign in your wallet…'; render();

		const w = detectWallet();
		if (!w) throw new Error('No Solana wallet detected. Install Phantom or Backpack.');
		if (!w.isConnected) await w.connect?.();
		const payer = w.publicKey?.toBase58?.() || w.publicKey?.toString?.();
		if (!payer) throw new Error('Could not read wallet public key.');

		const isUsdc = s.coinType === 'usdc';
		const buyIn  = Math.max(0, parseFloat(s.initialBuy) || 0);
		// Server schema treats 'usdc' as an unknown coin_type. Map it to 'agent'
		// (the buyback-bound variant) so the launch wires up an agent identity,
		// but flip the quote mint to USDC and route the initial buy through
		// usdc_buy_in so the backend builds createV2AndBuyV2Instructions.
		const pr = await fetch('/api/pump/launch-prep', {
			method: 'POST', credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				...(av.agent_id ? { agent_id: av.agent_id } : { avatar_id: av.id }),
				wallet_address: payer,
				name: nameTrim, symbol: symTrim, uri: s._metaUrl,
				coin_type: isUsdc ? 'agent' : s.coinType,
				buyback_bps: (isUsdc || s.coinType === 'agent') ? s.buybackBps : 0,
				...(isUsdc
					? { usdc_buy_in: buyIn, quote_mint: USDC_MAINNET_MINT }
					: { sol_buy_in: buyIn }),
				network: 'mainnet',
			}),
		});
		const prep = await pr.json();
		if (prep.error) throw new Error(prep.error_description || prep.error);
		s.resolvedAgentId = prep.agent_id;

		const { VersionedTransaction, Keypair, Connection } =
			await import('https://esm.sh/@solana/web3.js@1.98.4');
		const tx = VersionedTransaction.deserialize(
			Uint8Array.from(atob(prep.tx_base64), (c) => c.charCodeAt(0)),
		);
		// Phantom Lighthouse requires the wallet to sign FIRST when there are
		// multiple signers; additional signers must sign afterward.
		const signed = await w.signTransaction(tx);
		if (prep.mint_secret_key_b64) {
			signed.sign([Keypair.fromSecretKey(
				Uint8Array.from(atob(prep.mint_secret_key_b64), (c) => c.charCodeAt(0)),
			)]);
		}

		// Send + poll confirmation (75s timeout)
		s.phase = 'confirming'; s.phaseLabel = 'Confirming on-chain…'; render();

		const conn = new Connection(RPC_URL, 'confirmed');
		const sig  = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });

		try {
			await pollConfirmation(conn, sig);
		} catch (confErr) {
			if (confErr.code === 'CONFIRM_TIMEOUT') {
				s.phase = 'confirm-timeout';
				s.pendingConfirm = { prepId: prep.prep_id, sig, network: 'mainnet' };
				render(); return;
			}
			throw confErr;
		}

		await finalizeConfirm(prep.prep_id, sig);
	}

	async function launchViaAgentWallet(nameTrim, symTrim) {
		s.phase = 'signing'; s.phaseLabel = 'Agent wallet signing…'; render();

		const isUsdc = s.coinType === 'usdc';
		const buyIn  = Math.max(0, parseFloat(s.initialBuy) || 0);
		const body = {
			...(av.agent_id ? { agent_id: av.agent_id } : { avatar_id: av.id }),
			name: nameTrim, symbol: symTrim, uri: s._metaUrl,
			coin_type: isUsdc ? 'agent' : s.coinType,
			buyback_bps: (isUsdc || s.coinType === 'agent') ? s.buybackBps : 0,
			...(isUsdc
				? { usdc_buy_in: buyIn, quote_mint: USDC_MAINNET_MINT }
				: { sol_buy_in: buyIn }),
			network: 'mainnet',
		};
		s.phase = 'confirming'; s.phaseLabel = 'Launching on-chain (may take ~10s)…'; render();

		const r = await fetch('/api/pump/launch-agent', {
			method: 'POST', credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		const data = await r.json();
		if (!r.ok || data.error) {
			throw new Error(data.error_description || data.error || `Launch failed (${r.status})`);
		}

		s.resolvedAgentId = data.agent_id;
		s.mint = data.mint;
		s.phase = 'success';
		// Refresh agent balance so the UI reflects the launch spend.
		refreshAgentBalance();
		render();
	}

	// Called after confirmed on-chain (normal path or escape-hatch path)
	async function finalizeConfirm(prepId, sig) {
		const cr = await fetch('/api/pump/launch-confirm', {
			method: 'POST', credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ prep_id: prepId, tx_signature: sig }),
		});
		const confirmed = await cr.json();
		if (confirmed.error) throw new Error(confirmed.error_description || confirmed.error);

		// Extract mint from what we already know (stored in pendingConfirm or parent scope)
		// The server echoes pump_agent_mint which has the mint address
		const mintAddr = confirmed.pump_agent_mint?.mint || s.pendingConfirm?.mint || null;
		if (mintAddr) s.mint = mintAddr;
		s.phase = 'success'; s.pendingConfirm = null;
		render();
	}

	// ── Helpers ────────────────────────────────────────────────────────────

	// SOL out-of-pocket for the launch tx. For SOL-paired coins this is the
	// fixed mint/rent + the initial buy. For USDC-paired coins only the SOL
	// rent/fee applies — the buy itself is debited from the wallet's USDC ATA.
	const estimatedCost = () => {
		const buy = Math.max(0, parseFloat(s.initialBuy) || 0);
		return PUMP_BASE_COST + (s.coinType === 'usdc' ? 0 : buy);
	};
	// Symbol accepts any raw value (whitespace, emoji, special chars) — only name & description require real text.
	const formValid     = () => s.name.trim() && s.symbol.length > 0 && s.description.trim();

	// ── Render ─────────────────────────────────────────────────────────────

	function render() {
		if (!av || av.id === DEMO_ID)         { renderEmpty();    return; }
		if (s.checkingMint)                   { renderChecking(); return; }
		if (s.existingMint && !s.forceNew)    { renderExisting(); return; }
		if (s.phase === 'success')            { renderSuccess();  return; }
		if (s.phase === 'confirm-timeout')    { renderTimeout();  return; }
		renderForm();
	}

	function renderEmpty() {
		const baseCost = PUMP_BASE_COST.toFixed(3);
		container.innerHTML = `<div class="lp">
			<div class="lp-guide">
				<p class="lp-guide-h">Launch a token for your avatar</p>
				<p class="lp-guide-sub">This mints a <b style="color:rgba(255,255,255,.78);font-weight:500">memecoin on pump.fun</b> tied to the avatar you pick. Other people can buy your coin; if you pick an <em>Agent</em> coin, revenue from your agent's paid endpoints buys back and burns the token on-chain.</p>

				<div class="lp-guide-steps">
					<div class="lp-guide-step">
						<div class="lp-guide-num">1</div>
						<div class="lp-guide-step-body"><b>Pick an avatar</b> on the left — your own from the avatar dashboard, or any public one from the community gallery.</div>
					</div>
					<div class="lp-guide-step">
						<div class="lp-guide-num">2</div>
						<div class="lp-guide-step-body"><b>Set token details</b> — name, symbol (e.g. $CZ), description, and a thumbnail. We pre-fill these from the avatar.</div>
					</div>
					<div class="lp-guide-step">
						<div class="lp-guide-num">3</div>
						<div class="lp-guide-step-body"><b>Choose a coin type</b> and pay the launch cost from a connected wallet (Phantom / Backpack) or your custodial agent wallet.</div>
					</div>
					<div class="lp-guide-step">
						<div class="lp-guide-num">4</div>
						<div class="lp-guide-step-body"><b>Sign &amp; launch</b> — the token goes live on pump.fun and is permanently linked to your avatar.</div>
					</div>
				</div>

				<div class="lp-guide-types">
					<div class="lp-guide-type" title="Standard pump.fun memecoin. Initial buy seeds the bonding curve. No agent integration."><b>🪙 Regular</b>Plain pump.fun launch, no agent buyback.</div>
					<div class="lp-guide-type" title="Pump.fun high-volatility mode — no agent buyback or payments. Pure speculation."><b>🔥 Mayhem</b>High-volatility mode on pump.fun.</div>
					<div class="lp-guide-type" title="Agent revenue (SOL from paid endpoints) buys back and burns the token automatically."><b>🤖 Agent</b>SOL revenue auto-buyback &amp; burn.</div>
					<div class="lp-guide-type" title="USDC-denominated agent payments via agent-payments-sdk. Coming soon."><b>💵 USDC</b>Stablecoin-denominated. Coming soon.</div>
				</div>

				<div class="lp-guide-tip">
					<span class="lp-guide-tip-ic">ⓘ</span>
					<span><b style="color:rgba(255,255,255,.78);font-weight:500">Cost:</b> ~${baseCost} SOL covers the mint &amp; pump.fun fee. Anything you add as an <em>initial buy</em> seeds the bonding curve and credits coins to your wallet. No on-chain action happens until you click <b style="color:rgba(255,255,255,.78);font-weight:500">Launch</b> and sign.</span>
				</div>

				<a class="lp-guide-cta" href="/dashboard/avatars" target="_blank" rel="noopener">Pick or upload an avatar to begin →</a>

				<div class="lp-guide-links">
					<a href="/gallery" target="_blank" rel="noopener">Browse community gallery</a>
					<a href="https://pump.fun" target="_blank" rel="noopener" title="Pump.fun is the launchpad we use to mint and trade tokens">What is pump.fun?</a>
				</div>
			</div></div>`;
	}

	function renderChecking() {
		container.innerHTML = `<div class="lp">
			<div class="lp-checking"><div class="lp-spin"></div>Checking for existing token…</div>
		</div>`;
	}

	function renderExisting() {
		const m   = s.existingMint;
		const st  = m.stats  || {};
		const thumbSrc = av?.thumbnail_url;
		const since = m.created_at
			? new Date(m.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
			: '';
		const payments = st.confirmed_payments || 0;
		const payers   = st.unique_payers || 0;
		const mintShort = m.mint ? m.mint.slice(0, 6) + '…' + m.mint.slice(-6) : '';

		container.innerHTML = `<div class="lp"><div class="lp-existing">
			<div class="lp-ex-head"><div class="lp-ex-dot"></div>Token already launched</div>
			<div class="lp-ex-card">
				${thumbSrc
					? `<img class="lp-ex-thumb" src="${esc(thumbSrc)}" alt="" />`
					: `<div class="lp-ex-thumb-ph">🪙</div>`}
				<div class="lp-ex-info">
					<div class="lp-ex-sym">$${esc(m.symbol || '')}</div>
					<div class="lp-ex-name">${esc(m.name || '')}</div>
					${since ? `<div class="lp-ex-since">Launched ${since}</div>` : ''}
				</div>
			</div>
			${(payments > 0 || payers > 0) ? `
			<div class="lp-ex-stats">
				<div class="lp-ex-stat">
					<div class="lp-ex-stat-n">${payments}</div>
					<div class="lp-ex-stat-l">Payments received</div>
				</div>
				<div class="lp-ex-stat">
					<div class="lp-ex-stat-n">${payers}</div>
					<div class="lp-ex-stat-l">Unique payers</div>
				</div>
			</div>` : ''}
			<div class="lp-ex-mint">
				<span title="${esc(m.mint || '')}">${mintShort}</span>
				<button class="lp-copy" id="lp-ex-copy">Copy</button>
			</div>
			<div class="lp-ex-links">
				<a class="lp-ex-link" href="${esc(PUMP_URL(m.mint))}" target="_blank" rel="noopener">pump.fun ↗</a>
				<a class="lp-ex-link" href="https://solscan.io/token/${esc(m.mint)}" target="_blank" rel="noopener">Solscan ↗</a>
				${s.resolvedAgentId || av?.agent_id
					? `<a class="lp-ex-link" href="/agent/${esc(s.resolvedAgentId || av.agent_id)}">Agent page ↗</a>`
					: ''}
			</div>
			<button class="lp-ex-new" id="lp-force-new">Launch a new token for this avatar</button>
		</div></div>`;

		container.querySelector('#lp-ex-copy')?.addEventListener('click', (e) => {
			navigator.clipboard?.writeText(m.mint || '').catch(() => {});
			e.currentTarget.textContent = 'Copied!';
			setTimeout(() => { e.currentTarget.textContent = 'Copy'; }, 1500);
		});
		container.querySelector('#lp-force-new')?.addEventListener('click', () => {
			s.forceNew = true; render();
		});
	}

	function renderTimeout() {
		const pc = s.pendingConfirm || {};
		const solscanUrl = pc.sig ? SOLSCAN(pc.sig, pc.network) : null;
		container.innerHTML = `<div class="lp"><div class="lp-timeout">
			<div class="lp-timeout-title">⏱ Taking longer than expected</div>
			<div class="lp-timeout-body">
				Your transaction was sent and may confirm shortly — Solana sometimes takes a few minutes during peak load.
				Check Solscan to see the status, then click <strong>Finalize</strong> once it confirms.
			</div>
			${pc.sig ? `<div class="lp-timeout-sig">${esc(pc.sig)}</div>` : ''}
			<div class="lp-timeout-btns">
				${solscanUrl ? `<a class="lp-tbtn ghost" href="${esc(solscanUrl)}" target="_blank" rel="noopener">View on Solscan ↗</a>` : ''}
				<button class="lp-tbtn primary" id="lp-finalize">Finalize once confirmed</button>
				<button class="lp-tbtn ghost" id="lp-restart">Start over</button>
			</div>
		</div></div>`;

		container.querySelector('#lp-finalize')?.addEventListener('click', async () => {
			const btn = container.querySelector('#lp-finalize');
			if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
			try {
				if (!s.pendingConfirm) return;
				// One more on-chain check before finalizing
				const { Connection } = await import('https://esm.sh/@solana/web3.js@1.98.4');
				const conn = new Connection(RPC_URL, 'confirmed');
				const { value } = await conn.getSignatureStatuses([s.pendingConfirm.sig], { searchTransactionHistory: true });
				const st = value?.[0];
				if (!st) {
					if (btn) { btn.disabled = false; btn.textContent = 'Finalize once confirmed'; }
					const note = container.querySelector('.lp-timeout-body');
					if (note) note.textContent = 'Not confirmed yet — check Solscan and try again in a moment.';
					return;
				}
				if (st.err) throw new Error(`On-chain error: ${JSON.stringify(st.err)}`);
				await finalizeConfirm(s.pendingConfirm.prepId, s.pendingConfirm.sig);
			} catch (e) {
				s.errorMsg = friendlyError(e.message || String(e));
				s.phase = 'error'; s.pendingConfirm = null; render();
			}
		});

		container.querySelector('#lp-restart')?.addEventListener('click', () => {
			s.phase = 'idle'; s.pendingConfirm = null; s.errorMsg = ''; render();
		});
	}

	// One-time SIWS link prompt UI for the connected Solana wallet. Only renders
	// when the wallet is connected and we know it's not yet linked.
	function renderLinkRow() {
		if (!s.walletAddr || s.walletLinked === true) return '';

		if (s.walletLinkChecking) {
			return `<div class="lp-link-row checking">
				<div class="lp-link-info">
					<span class="lp-link-title">Checking wallet…</span>
					<span class="lp-link-sub">Verifying this wallet is linked to your account.</span>
				</div>
			</div>`;
		}

		if (s.walletLinked === false) {
			const busy = s.walletLinking ? 'disabled' : '';
			if (s.walletConflict) {
				const short = esc(shortenAddr(s.walletAddr));
				return `<div class="lp-link-row conflict">
					<div class="lp-link-info">
						<span class="lp-link-title">This wallet belongs to a different three.ws account</span>
						<span class="lp-link-sub">Sign once more with ${short} to transfer it to the account you&rsquo;re signed into now. The previous account loses this wallet.</span>
						${s.walletLinkError ? `<span class="lp-link-err">${esc(s.walletLinkError)}</span>` : ''}
					</div>
					<button class="lp-link-btn" id="lp-link-transfer" ${busy}>${s.walletLinking ? 'Sign in your wallet…' : 'Transfer wallet to this account'}</button>
				</div>`;
			}
			return `<div class="lp-link-row">
				<div class="lp-link-info">
					<span class="lp-link-title">Link this wallet to launch</span>
					<span class="lp-link-sub">One-time signature — proves you own ${esc(shortenAddr(s.walletAddr))}. No transaction, no fee.</span>
					${s.walletLinkError ? `<span class="lp-link-err">${esc(s.walletLinkError)}</span>` : ''}
				</div>
				<button class="lp-link-btn" id="lp-link-wallet" ${busy}>${s.walletLinking ? 'Sign in your wallet…' : 'Link wallet'}</button>
			</div>`;
		}
		return '';
	}

	function renderConnectedWalletBar(cost) {
		const w = detectWallet();
		if (!w) {
			return `<div class="lp-wallet">
				<div class="lp-dot off"></div>
				<span class="lp-wallet-none">No Solana wallet found</span>
				<button class="lp-wbtn" id="lp-install">Install Phantom ↗</button>
			</div>`;
		}
		if (!s.walletAddr) {
			return `<div class="lp-wallet">
				<div class="lp-dot off"></div>
				<span class="lp-wallet-none">Wallet not connected</span>
				<button class="lp-wbtn" id="lp-connect">Connect</button>
			</div>`;
		}
		const hasEnough = s.solBalance !== null && s.solBalance >= cost;
		const cls       = s.solBalance === null ? 'dim' : hasEnough ? 'ok' : 'warn';
		const costTxt   = s.solBalance === null
			? `Est. cost ~${cost.toFixed(3)} SOL`
			: hasEnough
				? `~${cost.toFixed(3)} SOL required · ${s.solBalance.toFixed(3)} available ✓`
				: `Need ~${cost.toFixed(3)} SOL · ${s.solBalance.toFixed(3)} in wallet`;
		return `<div class="lp-wallet">
			<div class="lp-dot on"></div>
			<div class="lp-wallet-info">
				<button class="lp-wallet-addr" id="lp-addr-copy" title="Click to copy full address">${shortenAddr(s.walletAddr)}</button>
				${s.solBalance !== null ? `<span class="lp-wallet-bal">${s.solBalance.toFixed(3)} SOL</span>` : ''}
				<span class="lp-wallet-cost ${cls}">${costTxt}</span>
			</div>
			<button class="lp-wbtn deposit" id="lp-deposit" title="Show deposit address &amp; QR">Deposit</button>
			<button class="lp-wbtn ghost" id="lp-disc" title="Disconnect">✕</button>
		</div>`;
	}

	function renderAgentWalletBar(cost) {
		if (s.agentWalletLoading) {
			return `<div class="lp-wallet">
				<div class="lp-spin"></div>
				<span class="lp-wallet-none">Preparing agent wallet…</span>
			</div>`;
		}
		if (s.agentWalletError) {
			return `<div class="lp-wallet">
				<div class="lp-dot off"></div>
				<span class="lp-wallet-none">Agent wallet error: ${esc(s.agentWalletError)}</span>
				<button class="lp-wbtn" id="lp-agent-retry">Retry</button>
			</div>`;
		}
		if (!s.agentWallet?.address) {
			return `<div class="lp-wallet">
				<div class="lp-dot off"></div>
				<span class="lp-wallet-none">Agent wallet not provisioned</span>
				<button class="lp-wbtn" id="lp-agent-retry">Provision</button>
			</div>`;
		}
		const bal = s.agentWallet.sol ?? null;
		const hasEnough = bal !== null && bal >= cost;
		const cls = bal === null ? 'dim' : hasEnough ? 'ok' : 'warn';
		const costTxt = bal === null
			? `Est. cost ~${cost.toFixed(3)} SOL`
			: hasEnough
				? `~${cost.toFixed(3)} SOL required · ${bal.toFixed(3)} available ✓`
				: `Need ~${cost.toFixed(3)} SOL · ${bal.toFixed(3)} in agent wallet`;
		return `<div class="lp-wallet">
			<div class="lp-dot on"></div>
			<div class="lp-wallet-info">
				<button class="lp-wallet-addr" id="lp-agent-addr-copy" title="Click to copy full agent wallet address">${shortenAddr(s.agentWallet.address)}</button>
				${bal !== null ? `<span class="lp-wallet-bal">${bal.toFixed(3)} SOL</span>` : ''}
				<span class="lp-wallet-cost ${cls}">${costTxt}</span>
			</div>
			<button class="lp-wbtn deposit" id="lp-agent-deposit" title="Show agent wallet deposit address &amp; QR">Fund</button>
		</div>`;
	}

	function renderForm() {
		const busy = s.phase !== 'idle' && s.phase !== 'error';
		const dis  = busy ? 'disabled' : '';
		const cost = estimatedCost();

		const sourceToggleHtml = `<div class="lp-src" role="tablist" aria-label="Launch wallet">
			<button type="button" role="tab" data-src="connected" class="${s.walletSource === 'connected' ? 'on' : ''}" ${busy ? 'disabled' : ''}>
				Connected wallet<span class="lp-src-sub">Phantom / Backpack</span>
			</button>
			<button type="button" role="tab" data-src="agent" class="${s.walletSource === 'agent' ? 'on' : ''}" ${busy ? 'disabled' : ''}>
				Agent wallet<span class="lp-src-sub">Custodial · server-signed</span>
			</button>
		</div>`;

		const ct = s.coinType;
		const coinTypeHtml = `<div class="lp-coin" role="tablist" aria-label="Coin type">
			<button type="button" role="tab" data-coin="regular" class="regular ${ct === 'regular' ? 'on' : ''}" ${busy ? 'disabled' : ''}>
				<span class="lp-coin-emoji">🪙</span>Regular<span class="lp-coin-sub">Plain pump.fun</span>
			</button>
			<button type="button" role="tab" data-coin="mayhem" class="mayhem ${ct === 'mayhem' ? 'on' : ''}" ${busy ? 'disabled' : ''}>
				<span class="lp-coin-emoji">🔥</span>Mayhem<span class="lp-coin-sub">High-volatility</span>
			</button>
			<button type="button" role="tab" data-coin="agent" class="agent ${ct === 'agent' ? 'on' : ''}" ${busy ? 'disabled' : ''}>
				<span class="lp-coin-emoji">🤖</span>Agent<span class="lp-coin-sub">SOL buyback</span>
			</button>
			<button type="button" role="tab" data-coin="usdc" class="usdc ${ct === 'usdc' ? 'on' : ''}" ${busy ? 'disabled' : ''} title="USDC-paired agent coin — trades and pays out in USDC instead of SOL.">
				<span class="lp-coin-emoji">💵</span>USDC<span class="lp-coin-sub">Stablecoin pair</span>
			</button>
		</div>`;

		const coinNoteHtml = ct === 'mayhem'
			? `<div class="lp-coin-note mayhem">Mayhem coins launch on pump.fun's high-volatility mode. No agent buyback or payments — pure speculation.</div>`
			: ct === 'usdc'
				? `<div class="lp-coin-note usdc">USDC-paired agent coin. Bonding curve quotes in USDC instead of SOL — your initial buy and all subsequent trades settle through the wallet's USDC ATA. Buyback share still applies, denominated in USDC.</div>`
				: ct === 'regular'
					? `<div class="lp-coin-note">Standard pump.fun launch — no on-chain buyback. Initial buy still funds bonding curve.</div>`
					: '';

		// USDC coins are agent-buyback-bound (same on-chain agent identity flow
		// as 'agent'), so surface the buyback slider for both variants.
		const showBuyback = ct === 'agent' || ct === 'usdc';

		let walletHtml;
		if (s.walletSource === 'agent') {
			walletHtml = renderAgentWalletBar(cost);
		} else {
			walletHtml = renderConnectedWalletBar(cost) + renderLinkRow();
		}

		const signedIn = !!(getUser?.());

		let btnText, btnDis, btnAction = 'launch', btnTitle = '';
		if (busy) {
			btnText = s.phaseLabel || 'Working…'; btnDis = true;
		} else if (!signedIn) {
			btnText = 'Sign in to launch'; btnDis = false; btnAction = 'sign-in';
			btnTitle = 'You need an account to launch — click to sign in, then come right back.';
		} else if (!formValid()) {
			btnText = 'Add name, symbol &amp; description to launch'; btnDis = false; btnAction = 'focus-form';
			btnTitle = 'Click to jump to the first missing field. You need a name, ticker symbol, and short description.';
		} else if (s.walletSource === 'agent') {
			if (s.agentWalletLoading)         { btnText = 'Preparing agent wallet…'; btnDis = true; }
			else if (!s.agentWallet)          { btnText = 'Retry agent wallet'; btnDis = false; btnAction = 'agent-retry';
				btnTitle = 'Click to retry provisioning your custodial agent wallet.'; }
			else if ((s.agentWallet.sol ?? 0) < cost) {
				btnText = `Fund agent wallet (~${cost.toFixed(3)} SOL needed)`; btnDis = false; btnAction = 'agent-fund';
				btnTitle = `Your agent wallet needs ~${cost.toFixed(3)} SOL to cover mint fees and your initial buy. Click to see the deposit address & QR code.`;
			}
			else                              { btnText = `Launch $${esc(s.symbol.trim() || 'TOKEN')} from agent wallet`; btnDis = false;
				btnTitle = 'Signs and submits the transaction from your custodial agent wallet.'; }
		} else {
			if (!s.walletAddr)                 { btnText = 'Connect wallet to launch'; btnDis = false; btnAction = 'connect';
				btnTitle = 'Opens Phantom or Backpack to connect your Solana wallet. No funds move until you sign the launch.'; }
			else if (s.walletLinkChecking)     { btnText = 'Checking wallet link…';     btnDis = true; }
			else if (s.walletLinked === false) { btnText = 'Link wallet to launch';     btnDis = false; btnAction = 'link';
				btnTitle = 'Signs a free message proving you own this wallet. Required so tokens get attributed to your account.'; }
			else                               { btnText = `Launch $${esc(s.symbol.trim() || 'TOKEN')}`; btnDis = false;
				btnTitle = 'Signs and submits the launch transaction from your connected wallet.'; }
		}

		const imgSrc = s.imagePreviewUrl || av?.thumbnail_url;

		container.innerHTML = `<div class="lp">
			<div class="lp-card">
				<div class="lp-img-zone" id="lp-zone" title="Drop a PNG/JPG/GIF here, or click to pick a file. This becomes the token's avatar on pump.fun.">
					${imgSrc ? `<img src="${esc(imgSrc)}" alt="" />` : `<div class="lp-img-ph">Drop image<br>or click</div>`}
					<input type="file" class="lp-img-file" id="lp-img" accept="image/*" ${dis} />
				</div>
				<div class="lp-card-fields">
					<input class="lp-iname" id="lp-name" type="text" maxlength="32"
						placeholder="Token name" value="${esc(s.name)}" ${dis}
						title="Shown on pump.fun. Up to 32 chars." />
					<input class="lp-isymbol" id="lp-sym" type="text" maxlength="80"
						placeholder="SYMBOL" value="${esc(s.symbol)}" ${dis}
						title="Ticker symbol (the $ in $CZ). Any characters — emoji and symbols allowed, up to 10." />
					<div class="lp-img-hint">Click image to replace · drag &amp; drop</div>
					${getPreviewViewer ? `<button type="button" class="lp-cap-btn" id="lp-capture" ${dis} title="Snapshot the current 3D preview and use it as the token image.">📸 Use 3D view</button>` : ''}
				</div>
			</div>
			<div>
				<label for="lp-desc">Description</label>
				<textarea id="lp-desc" rows="3" maxlength="500"
					placeholder="What does this agent do?" ${dis}
					title="Short pitch (up to 500 chars). Shown on pump.fun and on your agent page.">${esc(s.description)}</textarea>
			</div>
			${coinTypeHtml}
			${coinNoteHtml}
			${(() => {
				const isUsdcCoin = ct === 'usdc';
				const unit       = isUsdcCoin ? 'USDC' : 'SOL';
				// pump.fun launch caps: 50 SOL or 1,000,000 USDC (matches server schema).
				const maxBuy     = isUsdcCoin ? 1_000_000 : 50;
				const stepBuy    = isUsdcCoin ? 1 : 0.001;
				const buyTitle   = isUsdcCoin
					? 'Optional USDC spent on the bonding curve at launch. Requires a USDC ATA on the signing wallet.'
					: 'Optional SOL spent on the bonding curve at launch. You receive the resulting coins. Leave at 0 for a launch-only mint.';
				const buybackUnit = isUsdcCoin ? 'USDC' : 'SOL';
				const buyField = `
					<label for="lp-buy" title="${esc(buyTitle)}">Initial buy (${unit})</label>
					<input class="lp-number" id="lp-buy" type="number" min="0" max="${maxBuy}" step="${stepBuy}"
						value="${esc(s.initialBuy)}" ${dis}
						title="${esc(buyTitle)}" />`;
				if (showBuyback) {
					return `<div class="lp-2col">
						<div>${buyField}</div>
						<div>
							<div class="lp-slider-head">
								<label title="Share of your agent's paid-endpoint revenue (in ${buybackUnit}) that automatically buys back and burns this token on-chain.">Buyback share</label>
								<span class="lp-bps-val" id="lp-bps-val">${(s.buybackBps / 100).toFixed(1)}%</span>
							</div>
							<input type="range" class="lp-slider" id="lp-bps"
								min="0" max="5000" step="50" value="${s.buybackBps}" ${dis}
								title="Share of agent revenue (in ${buybackUnit}) that buys back and burns this token on-chain. 0% means no buyback, 50% is the max." />
							<div class="lp-slider-hint">Of agent revenue burned back</div>
						</div>
					</div>`;
				}
				return `<div>${buyField}</div>`;
			})()}
			${sourceToggleHtml}
			${walletHtml}
			${s.phase === 'error' ? `<div class="lp-err">${esc(s.errorMsg)}<div class="lp-err-sub">Adjust the details above and try again — nothing has been minted yet.</div></div>` : ''}
			<button class="lp-launch${busy ? ' busy' : ''}" id="lp-go" data-action="${btnAction}"${btnTitle ? ` title="${esc(btnTitle)}"` : ''} ${btnDis ? 'disabled' : ''}>${btnText}</button>
			${busy ? `<div class="lp-phase">${esc(s.phaseLabel)}</div>` : ''}
		</div>`;

		wireForm();
	}

	function renderSuccess() {
		const imgSrc   = s.imagePreviewUrl || av?.thumbnail_url;
		const mint     = s.mint || '';
		const mintShort = mint ? mint.slice(0, 6) + '…' + mint.slice(-6) : '';
		const sym      = s.symbol.trim() || 'TOKEN';
		const agentId  = s.resolvedAgentId || av?.agent_id;
		const shareText = `Just launched $${sym} on pump.fun 🎉 Built with three.ws\n${PUMP_URL(mint)}`;

		container.innerHTML = `<div class="lp"><div class="lp-ok">
			${imgSrc ? `<img class="lp-ok-thumb" src="${esc(imgSrc)}" alt="" />` : `<div class="lp-ok-thumb-ph">🪙</div>`}
			<p class="lp-ok-title">$${esc(sym)} is live!</p>
			<p class="lp-ok-sub">Your token is live on pump.fun</p>
			<div class="lp-ok-mint">
				<span title="${esc(mint)}">${mintShort}</span>
				<button class="lp-copy" id="lp-copy-mint">Copy</button>
			</div>
			<div class="lp-ok-links">
				<a class="lp-ext" href="${esc(PUMP_URL(mint))}" target="_blank" rel="noopener">pump.fun ↗</a>
				<a class="lp-ext" href="https://solscan.io/token/${esc(mint)}" target="_blank" rel="noopener">Solscan ↗</a>
				${agentId ? `<a class="lp-ext" href="/agent/${esc(agentId)}">Agent page ↗</a>` : ''}
			</div>
			<button class="lp-share" id="lp-share">📋 Copy launch announcement</button>
			<button class="lp-again" id="lp-again">Launch another token</button>
		</div></div>`;

		const copyBtn = (id, text) => {
			container.querySelector(id)?.addEventListener('click', (e) => {
				navigator.clipboard?.writeText(text).catch(() => {});
				const btn = e.currentTarget, orig = btn.textContent;
				btn.textContent = '✓ Copied';
				setTimeout(() => { btn.textContent = orig; }, 1800);
			});
		};
		copyBtn('#lp-copy-mint', mint);
		copyBtn('#lp-share', shareText);
		container.querySelector('#lp-again')?.addEventListener('click', () => {
			s.phase = 'idle'; s.mint = null; s.errorMsg = '';
			s.imageFile = null; s.imagePreviewUrl = null;
			s._metaUrl = null; s._metaKey = null;
			s.existingMint = null; s.forceNew = false;
			render();
		});
	}

	function wireForm() {
		const q = (sel) => container.querySelector(sel);

		q('#lp-zone')?.addEventListener('dragover',  (e) => { e.preventDefault(); q('#lp-zone')?.classList.add('dragover'); });
		q('#lp-zone')?.addEventListener('dragleave', ()  => q('#lp-zone')?.classList.remove('dragover'));
		q('#lp-zone')?.addEventListener('drop',      (e) => { e.preventDefault(); q('#lp-zone')?.classList.remove('dragover'); handleImageFile(e.dataTransfer?.files?.[0]); });
		q('#lp-img')?.addEventListener('change', (e) => handleImageFile(e.target.files?.[0]));

		q('#lp-name')?.addEventListener('input', (e) => {
			s.name = e.target.value;
			if (!s._symbolEdited) {
				s.symbol = toSymbol(s.name);
				const se = q('#lp-sym'); if (se) se.value = s.symbol;
			}
		});
		q('#lp-sym')?.addEventListener('input', (e) => {
			// Permissive: allow any characters (emoji, lowercase, symbols), cap at 10 codepoints.
			const raw = [...e.target.value].slice(0, 10).join('');
			e.target.value = raw; s.symbol = raw; s._symbolEdited = true;
		});
		q('#lp-desc')?.addEventListener('input', (e) => { s.description = e.target.value; });

		q('#lp-buy')?.addEventListener('input', (e) => {
			s.initialBuy = e.target.value;
			const ce = container.querySelector('.lp-wallet-cost');
			if (!ce || !s.walletAddr) return;
			const cost = estimatedCost(), ok = s.solBalance !== null && s.solBalance >= cost;
			ce.className = `lp-wallet-cost ${s.solBalance === null ? 'dim' : ok ? 'ok' : 'warn'}`;
			ce.textContent = s.solBalance === null
				? `Est. cost ~${cost.toFixed(3)} SOL`
				: ok
					? `~${cost.toFixed(3)} SOL required · ${s.solBalance.toFixed(3)} available ✓`
					: `Need ~${cost.toFixed(3)} SOL · ${s.solBalance.toFixed(3)} in wallet`;
		});
		q('#lp-bps')?.addEventListener('input', (e) => {
			s.buybackBps = parseInt(e.target.value, 10);
			const v = q('#lp-bps-val'); if (v) v.textContent = `${(s.buybackBps / 100).toFixed(1)}%`;
		});

		q('#lp-capture')?.addEventListener('click', captureFromViewer);
		q('#lp-install')?.addEventListener('click', () => window.open('https://phantom.app/', '_blank', 'noopener'));
		q('#lp-connect')?.addEventListener('click', connectWallet);
		q('#lp-disc')?.addEventListener('click', disconnectWallet);
		q('#lp-addr-copy')?.addEventListener('click', (e) => copyAddressToClipboard(e.currentTarget));
		q('#lp-deposit')?.addEventListener('click', openDepositModal);
		q('#lp-link-wallet')?.addEventListener('click', () => linkConnectedWallet(false));
		q('#lp-link-transfer')?.addEventListener('click', () => linkConnectedWallet(true));

		// Wallet-source toggle
		container.querySelectorAll('.lp-src button[data-src]').forEach((btn) => {
			btn.addEventListener('click', () => switchSource(btn.dataset.src));
		});

		// Coin-type selector
		container.querySelectorAll('.lp-coin button[data-coin]').forEach((btn) => {
			btn.addEventListener('click', () => switchCoinType(btn.dataset.coin));
		});

		// Agent-wallet bar
		q('#lp-agent-retry')?.addEventListener('click', () => loadAgentWallet());
		q('#lp-agent-deposit')?.addEventListener('click', openAgentDepositModal);
		q('#lp-agent-addr-copy')?.addEventListener('click', (e) => copyAgentAddress(e.currentTarget));

		q('#lp-go')?.addEventListener('click', (e) => {
			const action = e.currentTarget?.dataset?.action || 'launch';
			switch (action) {
				case 'sign-in':
					location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
					return;
				case 'focus-form': {
					const target = !s.name.trim()        ? '#lp-name'
					            :  !s.symbol.trim()      ? '#lp-sym'
					            :  !s.description.trim() ? '#lp-desc'
					            :  null;
					const el = target && container.querySelector(target);
					if (el) { el.focus(); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
					return;
				}
				case 'connect':     connectWallet(); return;
				case 'link':        linkConnectedWallet(false); return;
				case 'agent-fund':  openAgentDepositModal(); return;
				case 'agent-retry': loadAgentWallet(); return;
				case 'launch':
				default:
					launch();
			}
		});
	}

	// ── Public API ──────────────────────────────────────────────────────────

	function avatarChanged() {
		av = getAvatar?.() || null;
		s.forceNew = false;
		s._metaUrl = null; s._metaKey = null;

		// Reset agent-wallet binding — it's per-avatar (each avatar maps to a different agent_identity).
		stopAgentBalancePoll();
		s.agentWallet = null;
		s.agentWalletError = '';
		s.agentWalletLoading = false;

		if (av && av.id !== DEMO_ID) {
			if (!s.name)           s.name        = (av.name || '').slice(0, 32);
			if (!s._symbolEdited)  s.symbol      = toSymbol(s.name);
			if (!s.description)    s.description = (av.description || '').slice(0, 500);
			if (s.walletSource === 'agent') loadAgentWallet();
		}

		checkExistingMint(av); // async — updates state and re-renders when done
	}

	// ── Boot ────────────────────────────────────────────────────────────────

	av = getAvatar?.() || null;
	if (av && av.id !== DEMO_ID) {
		s.name        = (av.name || '').slice(0, 32);
		s.symbol      = toSymbol(s.name);
		s.description = (av.description || '').slice(0, 500);
	}

	render();
	setTimeout(tryAutoConnect, 250);
	if (av && av.id !== DEMO_ID) checkExistingMint(av);

	return {
		avatarChanged,
		teardown() { cleanup(); container.innerHTML = ''; },
	};
}
