/**
 * Widget stylesheet, injected once per document. Dark-first with a single
 * accent gradient; every interactive element has hover/active/focus states;
 * responsive from 320px up. Scoped under `.hoodpay` to never leak into the
 * host page.
 */
export const WIDGET_CSS = `
.hoodpay{--hp-bg:#0b0e12;--hp-panel:#12161d;--hp-line:#232a35;--hp-text:#e8edf4;--hp-dim:#8b96a5;
--hp-accent:#00c805;--hp-accent2:#00e5a0;--hp-danger:#ff5c5c;--hp-warn:#ffb454;--hp-radius:14px;
font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
color:var(--hp-text);background:var(--hp-bg);border:1px solid var(--hp-line);border-radius:var(--hp-radius);
max-width:420px;width:100%;box-sizing:border-box;padding:20px;line-height:1.45;font-size:15px}
.hoodpay *{box-sizing:border-box;margin:0}
.hoodpay-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:14px}
.hoodpay-brand{font-weight:700;letter-spacing:-.02em;font-size:14px;color:var(--hp-dim)}
.hoodpay-brand b{background:linear-gradient(90deg,var(--hp-accent),var(--hp-accent2));
-webkit-background-clip:text;background-clip:text;color:transparent}
.hoodpay-net{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--hp-dim);
border:1px solid var(--hp-line);border-radius:999px;padding:3px 9px}
.hoodpay-net[data-net="testnet"]{color:var(--hp-warn);border-color:rgba(255,180,84,.4)}
.hoodpay-amount{font-size:34px;font-weight:700;letter-spacing:-.03em;margin:2px 0 4px}
.hoodpay-amount small{font-size:16px;font-weight:600;color:var(--hp-dim);margin-left:6px}
.hoodpay-memo{color:var(--hp-dim);font-size:14px;margin-bottom:14px;overflow-wrap:anywhere}
.hoodpay-row{display:flex;justify-content:space-between;gap:12px;padding:9px 0;
border-top:1px solid var(--hp-line);font-size:13px}
.hoodpay-row dt{color:var(--hp-dim)}.hoodpay-row dd{font-variant-numeric:tabular-nums;text-align:right;overflow-wrap:anywhere}
.hoodpay-btn{appearance:none;width:100%;border:0;border-radius:10px;padding:13px 16px;margin-top:14px;
font:inherit;font-weight:600;cursor:pointer;color:#04110a;
background:linear-gradient(90deg,var(--hp-accent),var(--hp-accent2));
transition:transform .12s ease,filter .12s ease,opacity .12s ease}
.hoodpay-btn:hover{filter:brightness(1.08)}
.hoodpay-btn:active{transform:translateY(1px) scale(.995)}
.hoodpay-btn:focus-visible,.hoodpay a:focus-visible,.hoodpay-wallet:focus-visible,.hoodpay-input:focus-visible{
outline:2px solid var(--hp-accent2);outline-offset:2px}
.hoodpay-btn[disabled]{opacity:.55;cursor:not-allowed}
.hoodpay-btn.secondary{background:transparent;color:var(--hp-text);border:1px solid var(--hp-line)}
.hoodpay-btn.secondary:hover{border-color:var(--hp-dim)}
.hoodpay-input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid var(--hp-line);
background:var(--hp-panel);color:var(--hp-text);font:inherit;font-size:22px;font-weight:600;margin:6px 0 2px}
.hoodpay-input:hover{border-color:var(--hp-dim)}
.hoodpay-label{font-size:12px;color:var(--hp-dim);text-transform:uppercase;letter-spacing:.07em}
.hoodpay-wallets{display:flex;flex-direction:column;gap:8px;margin-top:12px}
.hoodpay-wallet{display:flex;align-items:center;gap:12px;width:100%;padding:11px 13px;border-radius:10px;
border:1px solid var(--hp-line);background:var(--hp-panel);color:var(--hp-text);font:inherit;font-weight:600;
cursor:pointer;transition:border-color .12s ease,background .12s ease}
.hoodpay-wallet:hover{border-color:var(--hp-accent2)}
.hoodpay-wallet:active{background:#161c25}
.hoodpay-wallet img{width:26px;height:26px;border-radius:6px}
.hoodpay-status{display:flex;align-items:center;gap:12px;padding:14px;border-radius:10px;
background:var(--hp-panel);border:1px solid var(--hp-line);margin-top:14px;font-size:14px}
.hoodpay-spin{width:18px;height:18px;flex:none;border-radius:50%;border:2px solid var(--hp-line);
border-top-color:var(--hp-accent2);animation:hoodpay-spin .8s linear infinite}
@keyframes hoodpay-spin{to{transform:rotate(360deg)}}
.hoodpay-ok{color:var(--hp-accent2)}.hoodpay-err{color:var(--hp-danger)}.hoodpay-warnc{color:var(--hp-warn)}
.hoodpay-check{width:44px;height:44px;border-radius:50%;flex:none;display:grid;place-items:center;
background:rgba(0,229,160,.12);color:var(--hp-accent2);font-size:22px;animation:hoodpay-pop .25s ease}
@keyframes hoodpay-pop{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}
.hoodpay a{color:var(--hp-accent2);text-decoration:none;border-bottom:1px solid rgba(0,229,160,.35)}
.hoodpay a:hover{border-bottom-color:var(--hp-accent2)}
.hoodpay-fine{font-size:12px;color:var(--hp-dim);margin-top:12px;text-align:center}
.hoodpay-err-box{border-color:rgba(255,92,92,.45)}
@media (max-width:360px){.hoodpay{padding:14px}.hoodpay-amount{font-size:28px}}
@media (prefers-reduced-motion:reduce){.hoodpay-spin,.hoodpay-check{animation:none}}
`

let injected = false

/** Inject the stylesheet once. Safe to call repeatedly. */
export function ensureStyles(doc: Document = document): void {
  if (injected && doc.querySelector('style[data-hood-pay]')) return
  const style = doc.createElement('style')
  style.setAttribute('data-hood-pay', '')
  style.textContent = WIDGET_CSS
  doc.head.appendChild(style)
  injected = true
}
