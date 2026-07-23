/**
 * Styles: @three-ws/concierge
 * ============================
 *
 * One injected stylesheet, scoped under .tc- prefixes and namespaced CSS
 * variables so host pages are never polluted. Themes: dark and light, chosen
 * by `data-tc-theme` on the root (the widget resolves 'auto' from
 * prefers-color-scheme and live-updates). Accent is one variable hosts set
 * from config, every tint derives via color-mix so a single hex restyles the
 * whole widget.
 */

export const CSS = `
.tc-root{
	--tc-accent:#6366f1;
	--tc-bg:#0b0c12;
	--tc-surface:#12141d;
	--tc-surface-2:#191c28;
	--tc-border:rgba(255,255,255,.09);
	--tc-text:#eceef6;
	--tc-text-dim:#8b93ab;
	--tc-user-text:#fff;
	--tc-shadow:0 24px 64px rgba(0,0,0,.5),0 4px 16px rgba(0,0,0,.35);
	--tc-radius:16px;
	position:fixed;z-index:2147482800;display:flex;flex-direction:column;align-items:flex-end;gap:12px;
	font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
	-webkit-font-smoothing:antialiased;line-height:1.45;
	-webkit-user-select:none;user-select:none;
}
.tc-root[data-tc-theme=light]{
	--tc-bg:#ffffff;
	--tc-surface:#f4f5f9;
	--tc-surface-2:#eceef5;
	--tc-border:rgba(15,18,32,.10);
	--tc-text:#171923;
	--tc-text-dim:#5f677e;
	--tc-shadow:0 24px 64px rgba(20,24,40,.18),0 4px 16px rgba(20,24,40,.10);
}
.tc-root[data-tc-pos=bottom-right]{right:20px;bottom:20px}
.tc-root[data-tc-pos=bottom-left]{left:20px;bottom:20px;align-items:flex-start}
.tc-root *,.tc-root *::before,.tc-root *::after{box-sizing:border-box}
.tc-root button{font:inherit;border:none;background:none;color:inherit;cursor:pointer;padding:0}
.tc-root button:focus-visible,.tc-root textarea:focus-visible,.tc-root a:focus-visible{outline:2px solid var(--tc-accent);outline-offset:2px;border-radius:6px}

/* ── Launcher ─────────────────────────────────────────────────────────── */
.tc-launcher{position:relative;width:56px;height:56px;border-radius:50%;display:grid;place-items:center;color:#fff;
	background:linear-gradient(135deg,color-mix(in srgb,var(--tc-accent) 88%,#fff 12%),color-mix(in srgb,var(--tc-accent) 82%,#000 18%));
	box-shadow:0 10px 30px color-mix(in srgb,var(--tc-accent) 45%,transparent),0 2px 8px rgba(0,0,0,.25);
	transition:transform .18s ease,box-shadow .18s ease,filter .18s ease}
.tc-launcher::before{content:'';position:absolute;inset:0;border-radius:50%;background:linear-gradient(180deg,rgba(255,255,255,.32),transparent 55%);pointer-events:none}
.tc-launcher:hover{transform:translateY(-2px) scale(1.04);filter:brightness(1.07)}
.tc-launcher:active{transform:scale(.96)}
.tc-launcher svg{width:24px;height:24px;transition:transform .25s ease}
.tc-root.is-open .tc-launcher svg{transform:rotate(90deg)}
.tc-pulse{position:absolute;inset:-4px;border-radius:50%;background:color-mix(in srgb,var(--tc-accent) 55%,transparent);animation:tc-pulse 2.6s ease-out infinite;pointer-events:none}
.tc-root.is-open .tc-pulse{display:none}
@keyframes tc-pulse{0%{transform:scale(.9);opacity:.55}70%{transform:scale(1.45);opacity:0}100%{transform:scale(1.45);opacity:0}}

/* ── Teaser bubble ────────────────────────────────────────────────────── */
.tc-teaser{max-width:240px;background:var(--tc-bg);color:var(--tc-text);border:1px solid var(--tc-border);border-radius:14px;
	padding:10px 34px 10px 14px;font-size:13.5px;box-shadow:var(--tc-shadow);position:relative;
	opacity:0;transform:translateY(8px);transition:opacity .3s ease,transform .3s ease;cursor:pointer}
.tc-teaser.is-in{opacity:1;transform:translateY(0)}
.tc-teaser-close{position:absolute;top:6px;right:6px;width:20px;height:20px;display:grid;place-items:center;color:var(--tc-text-dim);border-radius:50%}
.tc-teaser-close:hover{color:var(--tc-text);background:var(--tc-surface-2)}

/* ── Panel ────────────────────────────────────────────────────────────── */
.tc-panel{width:380px;max-width:calc(100vw - 2.5rem);max-height:min(72vh,680px);display:flex;flex-direction:column;overflow:hidden;
	background:var(--tc-bg);color:var(--tc-text);border:1px solid var(--tc-border);border-radius:var(--tc-radius);box-shadow:var(--tc-shadow);
	opacity:0;transform:translateY(14px) scale(.97);transform-origin:100% 100%;
	transition:opacity .24s ease,transform .24s cubic-bezier(.2,.9,.3,1.1)}
.tc-root[data-tc-pos=bottom-left] .tc-panel{transform-origin:0 100%}
.tc-root.is-open .tc-panel{opacity:1;transform:translateY(0) scale(1)}
.tc-panel[hidden]{display:none}

/* Header */
.tc-head{flex-shrink:0;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;border-bottom:1px solid var(--tc-border);background:var(--tc-surface)}
.tc-head-id{display:flex;align-items:center;gap:9px;min-width:0}
.tc-head-dot{width:8px;height:8px;border-radius:50%;background:#34d399;box-shadow:0 0 0 3px color-mix(in srgb,#34d399 22%,transparent);flex-shrink:0}
.tc-head-name{font-weight:650;font-size:14px;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tc-head-sub{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--tc-text-dim);text-transform:lowercase}
.tc-head-actions{display:flex;align-items:center;gap:2px;flex-shrink:0}
.tc-icon-btn{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;color:var(--tc-text-dim);transition:color .15s ease,background .15s ease}
.tc-icon-btn:hover{color:var(--tc-text);background:var(--tc-surface-2)}
.tc-icon-btn[aria-pressed=true]{color:var(--tc-accent)}
.tc-icon-btn svg{width:16px;height:16px}

/* Stage (3D avatar) */
.tc-stage{flex-shrink:0;position:relative;height:150px;border-bottom:1px solid var(--tc-border);
	background:
		radial-gradient(120px 90px at 50% 100%,color-mix(in srgb,var(--tc-accent) 26%,transparent),transparent 72%),
		linear-gradient(180deg,color-mix(in srgb,var(--tc-surface) 55%,transparent),var(--tc-bg));
	transition:height .25s ease}
.tc-root.is-compact .tc-stage{height:0;border-bottom:none;overflow:hidden}
.tc-stage-canvas{position:absolute;inset:0}
.tc-stage-glow{position:absolute;left:50%;bottom:8px;width:120px;height:22px;transform:translateX(-50%);border-radius:50%;
	background:color-mix(in srgb,var(--tc-accent) 30%,transparent);filter:blur(12px);opacity:.5;pointer-events:none}
.tc-stage-skel{position:absolute;left:50%;bottom:10px;width:84px;height:112px;transform:translateX(-50%);
	border-radius:44% 44% 38% 38%/56% 56% 44% 44%;overflow:hidden;opacity:0;transition:opacity .25s ease;pointer-events:none;
	background:linear-gradient(180deg,color-mix(in srgb,var(--tc-accent) 16%,transparent),transparent)}
.tc-stage.is-loading .tc-stage-skel{opacity:1}
.tc-stage-skel::after{content:'';position:absolute;inset:0;background:linear-gradient(110deg,transparent 18%,rgba(255,255,255,.2) 46%,transparent 72%);transform:translateX(-120%);animation:tc-shimmer 1.2s ease-in-out infinite}
@keyframes tc-shimmer{to{transform:translateX(120%)}}
.tc-stage-caption{position:absolute;left:10px;right:10px;bottom:8px;text-align:center;font-size:11.5px;color:var(--tc-text-dim);
	overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .2s ease}
.tc-stage-caption.is-in{opacity:1}

/* Messages */
.tc-thread{flex:1;min-height:120px;overflow-y:auto;overscroll-behavior:contain;padding:14px;display:flex;flex-direction:column;gap:10px;scrollbar-width:thin;scrollbar-color:var(--tc-surface-2) transparent}
.tc-msg{max-width:86%;padding:9px 12px;border-radius:14px;font-size:13.5px;-webkit-user-select:text;user-select:text;
	overflow-wrap:anywhere;animation:tc-msg-in .22s ease both}
@keyframes tc-msg-in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
.tc-msg.is-user{align-self:flex-end;color:var(--tc-user-text);border-bottom-right-radius:5px;
	background:linear-gradient(135deg,color-mix(in srgb,var(--tc-accent) 90%,#fff 10%),color-mix(in srgb,var(--tc-accent) 80%,#000 20%))}
.tc-msg.is-bot{align-self:flex-start;background:var(--tc-surface);border:1px solid var(--tc-border);border-bottom-left-radius:5px}
.tc-msg.is-error{border-color:color-mix(in srgb,#f87171 45%,transparent);background:color-mix(in srgb,#f87171 9%,var(--tc-surface))}
.tc-msg p{margin:0 0 8px}.tc-msg p:last-child{margin:0}
.tc-msg ul,.tc-msg ol{margin:0 0 8px;padding-left:18px}.tc-msg ul:last-child,.tc-msg ol:last-child{margin-bottom:0}
.tc-msg li{margin:2px 0}
.tc-msg a{color:var(--tc-accent);text-decoration:underline;text-underline-offset:2px}
.tc-msg code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:color-mix(in srgb,var(--tc-accent) 12%,transparent);padding:1px 5px;border-radius:5px}
.tc-msg pre{margin:0 0 8px;padding:10px;border-radius:9px;background:var(--tc-surface-2);overflow-x:auto}
.tc-msg pre:last-child{margin-bottom:0}
.tc-msg pre code{background:none;padding:0}
.tc-caret{display:inline-block;width:7px;height:14px;margin-left:2px;vertical-align:-2px;background:var(--tc-accent);border-radius:2px;animation:tc-caret 1s steps(2) infinite}
@keyframes tc-caret{50%{opacity:0}}
.tc-typing{align-self:flex-start;display:inline-flex;gap:4px;padding:11px 13px;border-radius:14px;border-bottom-left-radius:5px;background:var(--tc-surface);border:1px solid var(--tc-border)}
.tc-typing i{width:6px;height:6px;border-radius:50%;background:var(--tc-text-dim);animation:tc-blink 1.2s ease-in-out infinite}
.tc-typing i:nth-child(2){animation-delay:.18s}.tc-typing i:nth-child(3){animation-delay:.36s}
@keyframes tc-blink{0%,66%,100%{opacity:.35;transform:translateY(0)}33%{opacity:1;transform:translateY(-3px)}}
.tc-retry{align-self:flex-start;margin-top:-4px;font-size:12px;color:var(--tc-accent);padding:3px 8px;border-radius:7px}
.tc-retry:hover{background:var(--tc-surface-2)}

/* Empty state + chips */
.tc-empty{margin:auto 0;text-align:center;padding:12px 6px;display:flex;flex-direction:column;gap:6px;align-items:center}
.tc-empty-title{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;color:var(--tc-text-dim)}
.tc-chips{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;padding:4px 0}
.tc-chip{font-size:12px;color:var(--tc-text);background:var(--tc-surface);border:1px solid var(--tc-border);border-radius:999px;padding:6px 11px;
	transition:border-color .15s ease,background .15s ease,transform .15s ease}
.tc-chip:hover{border-color:color-mix(in srgb,var(--tc-accent) 55%,transparent);background:var(--tc-surface-2);transform:translateY(-1px)}

/* Input row */
.tc-input{flex-shrink:0;display:flex;align-items:flex-end;gap:8px;padding:10px 12px;border-top:1px solid var(--tc-border);background:var(--tc-surface)}
.tc-input textarea{flex:1;resize:none;background:transparent;border:none;color:var(--tc-text);font:inherit;font-size:13.5px;line-height:1.5;
	padding:6px 2px;max-height:110px;min-height:30px;overflow-y:auto;-webkit-user-select:text;user-select:text}
.tc-input textarea::placeholder{color:var(--tc-text-dim)}
.tc-input textarea:focus{outline:none}
.tc-input textarea:disabled{opacity:.5}
.tc-mic,.tc-send{flex-shrink:0;width:34px;height:34px;border-radius:10px;display:grid;place-items:center;transition:background .15s ease,color .15s ease,transform .12s ease}
.tc-mic{color:var(--tc-text-dim);background:var(--tc-surface-2)}
.tc-mic:hover{color:var(--tc-text)}
.tc-mic.is-live{color:#fff;background:#ef4444;animation:tc-mic 1.4s ease-in-out infinite}
@keyframes tc-mic{50%{box-shadow:0 0 0 6px color-mix(in srgb,#ef4444 25%,transparent)}}
.tc-send{color:#fff;background:linear-gradient(135deg,color-mix(in srgb,var(--tc-accent) 88%,#fff 12%),color-mix(in srgb,var(--tc-accent) 80%,#000 20%))}
.tc-send:hover{filter:brightness(1.08)}
.tc-send:active{transform:scale(.94)}
.tc-send:disabled{opacity:.4;cursor:not-allowed;filter:none}
.tc-mic svg,.tc-send svg{width:15px;height:15px}

/* Footer */
.tc-foot{flex-shrink:0;text-align:center;padding:5px 0 7px;background:var(--tc-surface)}
.tc-foot a{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;color:var(--tc-text-dim);text-decoration:none;transition:color .15s ease}
.tc-foot a:hover{color:var(--tc-accent)}

/* Product recommendation cards (shopping mode) */
.tc-products{display:flex;flex-direction:column;gap:8px;margin-top:10px}
.tc-product{display:flex;gap:10px;padding:8px;border-radius:12px;background:var(--tc-surface);border:1px solid var(--tc-border);transition:border-color .15s ease,transform .15s ease,box-shadow .15s ease}
.tc-product:hover{transform:translateY(-1px);border-color:color-mix(in srgb,var(--tc-accent) 45%,transparent);box-shadow:0 6px 18px rgba(0,0,0,.14)}
.tc-product-media{position:relative;flex-shrink:0;width:66px;height:66px;border-radius:9px;overflow:hidden;background:var(--tc-surface-2);display:block}
.tc-product-media img{width:100%;height:100%;object-fit:cover;display:block}
.tc-product-noimg{position:absolute;inset:0;background:linear-gradient(135deg,var(--tc-surface-2),color-mix(in srgb,var(--tc-accent) 14%,var(--tc-surface-2)))}
.tc-product-badge{position:absolute;top:4px;left:4px;font-size:9.5px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;color:#fff;background:#ef4444;padding:1px 5px;border-radius:5px}
.tc-product-body{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.tc-product-title{font-size:13px;font-weight:600;line-height:1.25;color:var(--tc-text);text-decoration:none;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tc-product-title:hover{color:var(--tc-accent)}
.tc-product-meta{display:flex;align-items:center;gap:8px;margin-top:auto}
.tc-product-price{font-size:13px;font-weight:650;color:var(--tc-text)}
.tc-product-oos{font-size:10.5px;color:var(--tc-text-dim);text-transform:uppercase;letter-spacing:.03em}
.tc-product-actions{display:flex;gap:6px;margin-top:4px}
.tc-product-view,.tc-product-add{font-size:12px;font-weight:600;padding:5px 12px;border-radius:8px;text-decoration:none;transition:filter .15s ease,background .15s ease,transform .1s ease;white-space:nowrap}
.tc-product-view{color:var(--tc-text);background:var(--tc-surface-2);border:1px solid var(--tc-border)}
.tc-product-view:hover{border-color:color-mix(in srgb,var(--tc-accent) 55%,transparent);color:var(--tc-accent)}
.tc-product-add{color:#fff;border:none;background:linear-gradient(135deg,color-mix(in srgb,var(--tc-accent) 88%,#fff 12%),color-mix(in srgb,var(--tc-accent) 80%,#000 20%))}
.tc-product-add:hover{filter:brightness(1.08)}
.tc-product-add:active{transform:scale(.95)}
.tc-product-add:disabled{opacity:.7;cursor:default}
.tc-product-add.is-added{background:#22c55e;filter:none}

/* Picker */
.tc-picker{position:absolute;inset:auto 0 0 0;top:0;z-index:5;background:color-mix(in srgb,var(--tc-bg) 88%,transparent);backdrop-filter:blur(8px);
	display:flex;flex-direction:column;padding:14px;overflow-y:auto;opacity:0;pointer-events:none;transition:opacity .2s ease}
.tc-picker.is-in{opacity:1;pointer-events:auto}
.tc-picker-title{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--tc-text-dim);margin:0 0 10px;text-transform:lowercase}
.tc-picker-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.tc-picker-card{display:flex;flex-direction:column;gap:2px;text-align:left;padding:10px 12px;border-radius:11px;background:var(--tc-surface);border:1px solid var(--tc-border);transition:border-color .15s ease,transform .15s ease}
.tc-picker-card:hover{transform:translateY(-1px);border-color:color-mix(in srgb,var(--tc-accent) 55%,transparent)}
.tc-picker-card.is-current{border-color:var(--tc-accent);box-shadow:0 0 0 1px var(--tc-accent)}
.tc-picker-name{font-size:13px;font-weight:600}
.tc-picker-tag{font-size:11px;color:var(--tc-text-dim)}

/* Small screens: full-width sheet */
@media (max-width:480px){
	.tc-root[data-tc-pos=bottom-right],.tc-root[data-tc-pos=bottom-left]{right:12px;left:12px;bottom:12px;align-items:stretch}
	.tc-panel{width:100%;max-width:none;max-height:min(78vh,640px)}
	.tc-launcher{align-self:flex-end}
	.tc-root[data-tc-pos=bottom-left] .tc-launcher{align-self:flex-start}
}
@media (prefers-reduced-motion:reduce){
	.tc-panel,.tc-msg,.tc-teaser,.tc-launcher,.tc-stage{transition:none;animation:none}
	.tc-pulse,.tc-typing i,.tc-caret{animation:none}
}
`;

let injected = false;
export function ensureStyles(doc = typeof document !== 'undefined' ? document : null) {
	if (injected || !doc) return;
	injected = true;
	const style = doc.createElement('style');
	style.id = 'three-concierge-style';
	style.textContent = CSS;
	doc.head.appendChild(style);
}
