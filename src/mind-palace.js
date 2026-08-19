// The Mind Palace — your agent's memory rendered as a place you can walk through.
//
// Every row in `agent_memories` becomes a tangible object in a 3D constellation
// with the live <agent-3d> avatar at its core. The mapping is honest and reads
// at a glance:
//   • salience (0..1)  → object size + emissive glow + proximity to the avatar
//                        (core beliefs orbit close, fleeting notes drift out).
//   • type             → a distinct geometric form AND a colour region
//                        (user=octahedron/blue, feedback=tetra/rose,
//                         project=cube/green, reference=icosa/amber).
//   • recency / expiry → freshness: newly-formed memories bloom in; memories
//                        with an expires_at visibly desaturate and dim.
//   • shared tags      → real association edges, a navigable knowledge graph.
//   • is_public        → a halo ring; private memories are unadorned.
//
// Direct manipulation, not forms — every gesture hits the real API through the
// shared memory-client (so the change ripples to the HUD and the chat too):
//   • drag a memory toward the avatar  → pin it + raise salience (PATCH).
//   • flick it into the Forget well    → schedule its expiry (PATCH), with undo.
//   • search / filter / sort           → debounced, client-side over the loaded set.
//   • click a memory                   → inspect content, context, provenance,
//                                        and walk its tag-graph ("why this?").
//
// It is live: it subscribes to the agent bus, so a memory formed in a chat
// blooms here in real time, and `memory:recalled` pulses the recalled nodes —
// open the Palace during a conversation and you watch recall happen.
//
// Scales: GPU-instanced geometry (one draw call per type) + level-of-detail
// labels keep thousands of nodes smooth. A 2D fallback, full keyboard
// navigation, and prefers-reduced-motion make it usable without a mouse or a
// GPU. Respects the shared WebGL context budget.
//
// Mounted lazily by the Mind tab in src/agent-edit.js, and full-screen by the
// /agents/:id/mind route (src/agent-mind.js). Both call mountMindPalace().

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
	listMemories,
	updateMemory,
	forgetMemory,
} from './agents/memory-client.js';
import { agentBus, EVENTS } from './agents/agent-bus.js';
import { reserveWebGLContext, releaseWebGLContext } from './webgl-budget.js';

const esc = (s) =>
	String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ── Type vocabulary: form + colour per memory type ─────────────────────────────
// Each type owns a geometric form (the "crystal whose shape encodes type") and a
// colour family, and is seeded into its own angular sector so types read as
// distinct constellations.
const TYPES = {
	user:      { label: 'You',        color: 0x7aa2ff, hex: '#7aa2ff', sector: 0,            geom: 'octahedron' },
	feedback:  { label: 'Guidance',   color: 0xf28db4, hex: '#f28db4', sector: Math.PI * 0.5, geom: 'tetrahedron' },
	project:   { label: 'Projects',   color: 0x86f0bc, hex: '#86f0bc', sector: Math.PI,       geom: 'box' },
	reference: { label: 'Knowledge',  color: 0xf0cf8a, hex: '#f0cf8a', sector: Math.PI * 1.5, geom: 'icosahedron' },
};
const TYPE_ORDER = ['user', 'feedback', 'project', 'reference'];
const ALL_TYPES = TYPE_ORDER;

// Layout shell — high-salience memories sit near INNER_R, low-salience drift to
// INNER_R + SPAN. Everything is centred on the avatar at the origin.
const INNER_R = 3.2;
const SPAN = 9.5;
const MAX_EDGES = 700; // association edges cap (highest combined-salience first)
const PULSE_MS = 1600; // recall pulse duration
const BLOOM_MS = 900; // new-memory bloom-in duration

const reduceMotion = () =>
	typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// Deterministic 0..1 hash from a string id — keeps layout stable across reloads.
function hash01(str, salt = 0) {
	let h = 2166136261 ^ salt;
	const s = String(str);
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return ((h >>> 0) % 100000) / 100000;
}

let STYLE_INJECTED = false;
function injectStyle() {
	if (STYLE_INJECTED || typeof document === 'undefined') return;
	STYLE_INJECTED = true;
	const css = `
.mind-palace{position:relative;width:100%;height:100%;min-height:480px;overflow:hidden;border-radius:14px;background:radial-gradient(120% 120% at 50% 30%,#0b1020 0%,#06080f 60%,#04050a 100%);color:#e8edf7;font:500 13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;contain:layout paint;touch-action:none}
.mp-canvas{position:absolute;inset:0;display:block}
.mp-avatar{position:absolute;left:50%;top:50%;width:168px;height:168px;transform:translate(-50%,-50%);pointer-events:none;z-index:2;filter:drop-shadow(0 6px 30px rgba(122,162,255,.35))}
.mp-avatar agent-3d{width:100%;height:100%;display:block}
.mp-avatar-fallback{width:100%;height:100%;border-radius:50%;background:radial-gradient(circle at 50% 35%,rgba(122,162,255,.5),rgba(122,162,255,.05));border:1px solid rgba(122,162,255,.35);display:flex;align-items:center;justify-content:center;font-size:2rem}
/* Toolbar */
.mp-bar{position:absolute;left:12px;right:12px;top:12px;z-index:6;display:flex;flex-wrap:wrap;gap:8px;align-items:center;pointer-events:none}
.mp-bar>*{pointer-events:auto}
.mp-search{flex:1 1 220px;min-width:160px;max-width:360px;display:flex;align-items:center;gap:8px;background:rgba(12,16,28,.82);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:7px 11px;backdrop-filter:blur(8px)}
.mp-search input{flex:1;background:none;border:0;color:#fff;font:inherit;outline:none;min-width:0}
.mp-search svg{flex:none;opacity:.55}
.mp-chips{display:flex;gap:6px;flex-wrap:wrap}
.mp-chip{display:inline-flex;align-items:center;gap:6px;background:rgba(12,16,28,.8);border:1px solid rgba(255,255,255,.14);color:#cdd9ff;border-radius:999px;padding:5px 11px;font-size:.74rem;font-weight:600;cursor:pointer;transition:background .15s,border-color .15s,transform .1s;backdrop-filter:blur(8px)}
.mp-chip:hover{background:rgba(255,255,255,.1)}
.mp-chip:focus-visible{outline:2px solid #7aa2ff;outline-offset:2px}
.mp-chip[aria-pressed="true"]{border-color:transparent;color:#06080f}
.mp-chip .dot{width:9px;height:9px;border-radius:50%;flex:none}
.mp-tools{display:flex;gap:6px;margin-left:auto}
.mp-btn{display:inline-flex;align-items:center;gap:6px;background:rgba(12,16,28,.8);border:1px solid rgba(255,255,255,.14);color:#cdd9ff;border-radius:9px;padding:6px 10px;font-size:.74rem;font-weight:600;cursor:pointer;transition:background .15s,transform .1s;backdrop-filter:blur(8px)}
.mp-btn:hover{background:rgba(255,255,255,.1)}
.mp-btn:focus-visible{outline:2px solid #7aa2ff;outline-offset:2px}
.mp-btn[aria-pressed="true"]{background:rgba(122,162,255,.22);border-color:rgba(122,162,255,.5);color:#fff}
/* Legend + stats */
.mp-legend{position:absolute;left:12px;bottom:12px;z-index:5;display:flex;flex-direction:column;gap:6px;background:rgba(8,11,20,.7);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:9px 12px;backdrop-filter:blur(8px);font-size:.7rem;max-width:200px}
.mp-legend b{font-size:.66rem;text-transform:uppercase;letter-spacing:.08em;color:rgba(255,255,255,.5);font-weight:700}
.mp-legend .row{display:flex;align-items:center;gap:7px;color:rgba(255,255,255,.8)}
.mp-legend .row .dot{width:9px;height:9px;border-radius:2px;flex:none}
.mp-stat{position:absolute;right:12px;bottom:12px;z-index:5;background:rgba(8,11,20,.7);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:8px 12px;backdrop-filter:blur(8px);font-size:.72rem;color:rgba(255,255,255,.78);text-align:right}
.mp-stat b{color:#fff}
/* Timeline scrubber */
.mp-time{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);z-index:6;display:flex;align-items:center;gap:10px;background:rgba(8,11,20,.78);border:1px solid rgba(255,255,255,.12);border-radius:999px;padding:7px 14px;backdrop-filter:blur(8px);width:min(440px,72%);opacity:0;pointer-events:none;transition:opacity .2s}
.mp-time.show{opacity:1;pointer-events:auto}
.mp-time input[type=range]{flex:1;accent-color:#7aa2ff;cursor:pointer}
.mp-time .play{background:none;border:0;color:#cdd9ff;cursor:pointer;font-size:1rem;padding:2px 4px;border-radius:6px}
.mp-time .play:focus-visible{outline:2px solid #7aa2ff}
.mp-time .lbl{font-size:.68rem;color:rgba(255,255,255,.7);white-space:nowrap;min-width:84px}
/* Forget well */
.mp-forget{position:absolute;right:18px;top:50%;transform:translateY(-50%);z-index:4;width:118px;height:118px;border-radius:50%;border:1.5px dashed rgba(240,141,180,.45);background:radial-gradient(circle,rgba(240,141,180,.1),transparent 70%);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;color:rgba(240,141,180,.85);font-size:.68rem;font-weight:600;text-align:center;opacity:0;transition:opacity .2s,transform .2s,box-shadow .2s;pointer-events:none}
.mp-forget.armed{opacity:1}
.mp-forget.hot{opacity:1;transform:translateY(-50%) scale(1.12);box-shadow:0 0 36px rgba(240,141,180,.6);border-style:solid;background:radial-gradient(circle,rgba(240,141,180,.28),transparent 70%)}
.mp-forget svg{width:26px;height:26px}
/* Tooltip */
.mp-tip{position:absolute;z-index:8;max-width:260px;background:rgba(10,13,23,.95);border:1px solid rgba(255,255,255,.16);border-radius:9px;padding:8px 11px;font-size:.74rem;color:#e8edf7;pointer-events:none;opacity:0;transition:opacity .12s;box-shadow:0 8px 28px rgba(0,0,0,.5);transform:translate(-50%,calc(-100% - 14px))}
.mp-tip.show{opacity:1}
.mp-tip .t{font-size:.62rem;text-transform:uppercase;letter-spacing:.06em;opacity:.6;margin-bottom:3px}
.mp-tip .s{font-size:.64rem;opacity:.55;margin-top:4px}
/* Inspector */
.mp-inspect{position:absolute;top:0;right:0;bottom:0;width:min(380px,86%);z-index:9;background:rgba(8,11,20,.97);border-left:1px solid rgba(255,255,255,.12);backdrop-filter:blur(14px);transform:translateX(100%);transition:transform .28s cubic-bezier(.4,0,.2,1);display:flex;flex-direction:column;box-shadow:-12px 0 40px rgba(0,0,0,.5)}
.mp-inspect.open{transform:translateX(0)}
.mp-inspect-hd{display:flex;align-items:center;gap:10px;padding:16px 18px 10px}
.mp-inspect-hd .badge{font-size:.62rem;text-transform:uppercase;letter-spacing:.06em;font-weight:700;padding:3px 9px;border-radius:999px}
.mp-inspect-hd .x{margin-left:auto;background:none;border:0;color:rgba(255,255,255,.6);font-size:1.3rem;cursor:pointer;line-height:1;padding:2px 6px;border-radius:6px}
.mp-inspect-hd .x:hover{color:#fff;background:rgba(255,255,255,.08)}
.mp-inspect-bd{flex:1;overflow:auto;padding:6px 18px 18px}
.mp-inspect-bd h4{font-size:.64rem;text-transform:uppercase;letter-spacing:.07em;color:rgba(255,255,255,.45);margin:18px 0 7px;font-weight:700}
.mp-inspect-content{font-size:.86rem;line-height:1.55;color:#eef2fa;white-space:pre-wrap;word-break:break-word}
.mp-meta-grid{display:grid;grid-template-columns:auto 1fr;gap:5px 14px;font-size:.74rem}
.mp-meta-grid dt{color:rgba(255,255,255,.5)}
.mp-meta-grid dd{margin:0;color:#dde6f5;text-align:right;word-break:break-word}
.mp-tag{display:inline-block;background:rgba(122,162,255,.16);border:1px solid rgba(122,162,255,.3);color:#cdd9ff;border-radius:999px;padding:2px 9px;font-size:.68rem;margin:0 5px 5px 0;cursor:pointer}
.mp-tag:hover{background:rgba(122,162,255,.3)}
.mp-tag:focus-visible{outline:2px solid #7aa2ff;outline-offset:1px}
.mp-related button{display:flex;width:100%;text-align:left;gap:8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:8px 10px;margin-bottom:6px;color:#dde6f5;cursor:pointer;font:inherit;font-size:.74rem;align-items:center;transition:background .12s}
.mp-related button:hover{background:rgba(255,255,255,.09)}
.mp-related button:focus-visible{outline:2px solid #7aa2ff;outline-offset:1px}
.mp-related .rdot{width:8px;height:8px;border-radius:50%;flex:none}
.mp-related .rwhy{margin-left:auto;font-size:.62rem;opacity:.55;white-space:nowrap}
.mp-context{font-size:.72rem;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:9px 11px;color:#c7d2e6;white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto}
.mp-inspect-actions{display:flex;gap:8px;flex-wrap:wrap;padding:12px 18px;border-top:1px solid rgba(255,255,255,.1)}
.mp-action{flex:1;min-width:96px;display:inline-flex;align-items:center;justify-content:center;gap:6px;border-radius:9px;padding:9px 10px;font-size:.76rem;font-weight:650;cursor:pointer;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#e8edf7;transition:background .14s,transform .1s}
.mp-action:hover{background:rgba(255,255,255,.12)}
.mp-action:active{transform:scale(.97)}
.mp-action:focus-visible{outline:2px solid #7aa2ff;outline-offset:2px}
.mp-action.pin[aria-pressed="true"]{background:linear-gradient(135deg,#7aa2ff,#9d7aff);color:#06080f;border-color:transparent}
.mp-action.forget{color:#f7a8c4;border-color:rgba(240,141,180,.4)}
.mp-action.forget:hover{background:rgba(240,141,180,.16)}
.mp-prov{font-size:.72rem;color:#9ad0ff}
.mp-prov a{color:#9ad0ff}
/* Overlays: loading / empty / error */
.mp-overlay{position:absolute;inset:0;z-index:7;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;padding:32px;background:radial-gradient(120% 120% at 50% 40%,rgba(11,16,32,.6),rgba(4,5,10,.92))}
.mp-overlay h3{margin:0;font-size:1.15rem;font-weight:650}
.mp-overlay p{margin:0;max-width:380px;color:rgba(255,255,255,.62);font-size:.84rem;line-height:1.5}
.mp-overlay .cta{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:6px}
.mp-overlay .cta a,.mp-overlay .cta button{display:inline-flex;align-items:center;gap:7px;border-radius:10px;padding:10px 16px;font-size:.82rem;font-weight:650;cursor:pointer;text-decoration:none;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.07);color:#e8edf7;transition:background .15s,transform .1s;font-family:inherit}
.mp-overlay .cta a.primary,.mp-overlay .cta button.primary{background:linear-gradient(135deg,#7aa2ff,#9d7aff);color:#06080f;border-color:transparent}
.mp-overlay .cta a:hover,.mp-overlay .cta button:hover{transform:translateY(-1px)}
.mp-orb{width:84px;height:84px;border-radius:50%;background:conic-gradient(from 0deg,#7aa2ff,#9d7aff,#86f0bc,#f0cf8a,#7aa2ff);filter:blur(2px);animation:mp-spin 2.4s linear infinite;opacity:.85}
.mp-orb::after{content:"";position:absolute;inset:10px;border-radius:50%;background:#06080f}
.mp-orb{position:relative}
@keyframes mp-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.mp-orb{animation:none}.mp-inspect{transition:none}.mp-tip{transition:none}}
.mp-err-detail{font-size:.74rem;color:rgba(255,255,255,.5);max-width:420px;word-break:break-word}
/* Undo toast */
.mp-toast{position:absolute;left:50%;bottom:64px;transform:translateX(-50%) translateY(20px);z-index:10;display:flex;align-items:center;gap:14px;background:rgba(14,18,30,.97);border:1px solid rgba(255,255,255,.16);border-radius:11px;padding:11px 16px;box-shadow:0 12px 40px rgba(0,0,0,.55);font-size:.8rem;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s}
.mp-toast.show{opacity:1;transform:translateX(-50%) translateY(0);pointer-events:auto}
.mp-toast button{background:none;border:0;color:#9ad0ff;font-weight:700;cursor:pointer;font:inherit;font-size:.8rem;padding:2px 4px;border-radius:6px}
.mp-toast button:hover{color:#bfe3ff}
.mp-toast button:focus-visible{outline:2px solid #7aa2ff}
/* 2D fallback */
.mp-2d{position:absolute;inset:0;z-index:3;overflow:auto;padding:64px 16px 80px;display:none}
.mp-palace.mode-2d .mp-2d{display:block}
.mp-palace.mode-2d .mp-canvas,.mp-palace.mode-2d .mp-avatar,.mp-palace.mode-2d .mp-forget,.mp-palace.mode-2d .mp-time{display:none}
.mp-2d-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;max-width:1100px;margin:0 auto}
.mp-2d-sec{grid-column:1/-1;font-size:.66rem;text-transform:uppercase;letter-spacing:.08em;color:rgba(255,255,255,.5);font-weight:700;margin-top:10px}
.mp-card{position:relative;text-align:left;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-left-width:3px;border-radius:11px;padding:12px 13px;cursor:pointer;color:#e8edf7;font:inherit;transition:background .14s,transform .1s,border-color .14s;display:flex;flex-direction:column;gap:7px}
.mp-card:hover{background:rgba(255,255,255,.08);transform:translateY(-2px)}
.mp-card:focus-visible{outline:2px solid #7aa2ff;outline-offset:2px}
.mp-card.dim{opacity:.45}
.mp-card .ctop{display:flex;align-items:center;gap:7px;font-size:.66rem}
.mp-card .ctop .pct{margin-left:auto;font-variant-numeric:tabular-nums;opacity:.7}
.mp-card .ctxt{font-size:.8rem;line-height:1.45;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.mp-card .cbar{height:4px;border-radius:999px;background:rgba(255,255,255,.1);overflow:hidden}
.mp-card .cbar i{display:block;height:100%;border-radius:999px}
.mp-card .pin{position:absolute;top:8px;right:9px;font-size:.7rem;opacity:.85}
.mp-card .ctags{display:flex;gap:4px;flex-wrap:wrap}
.mp-card .ctags span{font-size:.6rem;background:rgba(255,255,255,.08);border-radius:999px;padding:1px 7px;color:rgba(255,255,255,.7)}
/* Screen-reader / keyboard roster mirror of the scene */
.mp-roster{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.mp-palace:focus-within .mp-roster:focus-within{position:absolute;left:12px;top:56px;width:min(320px,70%);height:auto;clip:auto;white-space:normal;z-index:11;background:rgba(8,11,20,.97);border:1px solid rgba(122,162,255,.4);border-radius:11px;padding:10px;max-height:60%;overflow:auto;box-shadow:0 12px 40px rgba(0,0,0,.55)}
.mp-roster ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.mp-roster button{display:flex;width:100%;text-align:left;gap:8px;align-items:center;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:7px;padding:7px 9px;color:#e8edf7;font:inherit;font-size:.74rem;cursor:pointer}
.mp-roster button:focus-visible,.mp-roster button.focus{outline:2px solid #7aa2ff;outline-offset:1px;background:rgba(122,162,255,.18)}
.mp-roster .rdot{width:8px;height:8px;border-radius:50%;flex:none}
.mp-hint{position:absolute;left:12px;top:54px;z-index:5;font-size:.66rem;color:rgba(255,255,255,.4);background:rgba(8,11,20,.6);border-radius:8px;padding:5px 9px;backdrop-filter:blur(6px);max-width:260px;pointer-events:none;transition:opacity .4s}
@media (max-width:640px){.mp-avatar{width:120px;height:120px}.mp-forget{width:90px;height:90px;right:10px}.mp-legend{display:none}}
`;
	const tag = document.createElement('style');
	tag.id = 'mind-palace-style';
	tag.textContent = css;
	document.head.appendChild(tag);
}

// Load the <agent-3d> custom element (CDN → local fallbacks), matching the
// loader pattern used elsewhere in the app.
async function ensureAgent3D() {
	if (typeof customElements !== 'undefined' && customElements.get('agent-3d')) return true;
	const candidates = [
		'https://three.ws/agent-3d/latest/agent-3d.js',
		'/agent-3d/latest/agent-3d.js',
		'/dist-lib/agent-3d.js',
	];
	for (const url of candidates) {
		try {
			await import(/* @vite-ignore */ url);
			if (customElements.get('agent-3d')) return true;
		} catch {
			/* try next */
		}
	}
	return false;
}

/**
 * Mount the Mind Palace into `host`.
 * @param {HTMLElement} host
 * @param {{agentId:string, agent?:object, embedded?:boolean}} opts
 *   embedded: true when mounted inside the editor tab (affects empty-state CTAs).
 * @returns {{destroy:()=>void, refresh:()=>Promise<void>}}
 */
export function mountMindPalace(host, { agentId, agent = null, embedded = false } = {}) {
	injectStyle();
	const palace = new MindPalace(host, { agentId, agent, embedded });
	palace.boot();
	return {
		destroy: () => palace.destroy(),
		refresh: () => palace.load(),
	};
}

class MindPalace {
	constructor(host, { agentId, agent, embedded }) {
		this.host = host;
		this.agentId = agentId;
		this.agent = agent;
		this.embedded = embedded;
		this.nodes = []; // [{ mem, type, x,y,z, baseR, bornAt, pulseAt, instId }]
		this.byId = new Map();
		this.edges = [];
		this.filter = { q: '', types: new Set(ALL_TYPES), sort: 'salience' };
		this.mode = this.pickInitialMode();
		this.selectedId = null;
		this.focusIdx = -1; // keyboard roster cursor
		this.timeCursor = 1; // 0..1 of the created_at span (1 = now)
		this._raf = null;
		this._disposed = false;
		this._busOff = [];
		this._undo = null;
		this._undoTimer = null;
		this._reduce = reduceMotion();
		this._reservedCtx = false;
	}

	pickInitialMode() {
		// Honour reduced-motion and obviously low-power / WebGL-less contexts with
		// the 2D fallback; everyone else gets the spatial scene.
		if (reduceMotion()) return '2d';
		try {
			const c = document.createElement('canvas');
			const gl = c.getContext('webgl2') || c.getContext('webgl');
			if (!gl) return '2d';
		} catch {
			return '2d';
		}
		if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2) {
			return '2d';
		}
		return '3d';
	}

	boot() {
		this.host.innerHTML = '';
		this.root = document.createElement('div');
		this.root.className = `mind-palace mp-palace mode-${this.mode}`;
		this.root.innerHTML = this.scaffoldHTML();
		this.host.appendChild(this.root);
		this.cacheEls();
		this.wireChrome();
		this.subscribeBus();
		this.load();
	}

	scaffoldHTML() {
		const chipFor = (t) =>
			`<button class="mp-chip" data-type="${t}" role="switch" aria-pressed="true" aria-label="Toggle ${esc(TYPES[t].label)} memories"><span class="dot" style="background:${TYPES[t].hex}"></span>${esc(TYPES[t].label)}</button>`;
		return `
<canvas class="mp-canvas" aria-hidden="true"></canvas>
<div class="mp-avatar" id="mp-avatar" aria-hidden="true"></div>
<div class="mp-forget" id="mp-forget" aria-hidden="true">
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
	Forget
</div>
<div class="mp-bar" role="toolbar" aria-label="Mind Palace controls">
	<label class="mp-search">
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>
		<input type="search" id="mp-q" placeholder="Search memories…  ( / )" aria-label="Search memories" autocomplete="off" />
	</label>
	<div class="mp-chips" role="group" aria-label="Filter by type">${ALL_TYPES.map(chipFor).join('')}</div>
	<div class="mp-tools">
		<button class="mp-btn" id="mp-sort" aria-label="Sort order">↕ Salience</button>
		<button class="mp-btn" id="mp-timeline" aria-pressed="false" aria-label="Toggle memory timeline">◷ Timeline</button>
		<button class="mp-btn" id="mp-mode" aria-pressed="${this.mode === '2d'}" aria-label="Toggle 2D / 3D view">${this.mode === '2d' ? '◉ 3D' : '▦ 2D'}</button>
	</div>
</div>
<div class="mp-hint" id="mp-hint">Drag a memory to the centre to pin it · flick it right to forget · click to inspect</div>
<div class="mp-legend" aria-hidden="true">
	<b>Salience → distance</b>
	<div class="row"><span class="dot" style="background:#7aa2ff;width:13px;height:13px"></span>core belief (close)</div>
	<div class="row"><span class="dot" style="background:#7aa2ff;width:7px;height:7px;opacity:.6"></span>fleeting note (far)</div>
</div>
<div class="mp-stat" id="mp-stat" aria-live="polite"></div>
<div class="mp-time" id="mp-time" role="group" aria-label="Memory timeline">
	<button class="play" id="mp-time-play" aria-label="Replay how the mind grew">▶</button>
	<input type="range" id="mp-time-range" min="0" max="1000" value="1000" aria-label="Timeline position" />
	<span class="lbl" id="mp-time-lbl">now</span>
</div>
<div class="mp-2d" id="mp-2d"><div class="mp-2d-grid" id="mp-2d-grid"></div></div>
<div class="mp-roster" id="mp-roster" tabindex="-1" aria-label="Memory list — arrow keys to traverse, Enter to inspect, P to pin, Delete to forget">
	<ul id="mp-roster-list"></ul>
</div>
<div class="mp-tip" id="mp-tip" role="status" aria-live="off"></div>
<aside class="mp-inspect" id="mp-inspect" aria-label="Memory details" role="dialog" aria-modal="false" hidden></aside>
<div class="mp-toast" id="mp-toast" role="status" aria-live="polite"></div>
<div class="mp-overlay" id="mp-overlay" hidden></div>`;
	}

	cacheEls() {
		const q = (s) => this.root.querySelector(s);
		this.el = {
			canvas: q('.mp-canvas'),
			avatar: q('#mp-avatar'),
			forget: q('#mp-forget'),
			q: q('#mp-q'),
			sort: q('#mp-sort'),
			timelineBtn: q('#mp-timeline'),
			modeBtn: q('#mp-mode'),
			hint: q('#mp-hint'),
			stat: q('#mp-stat'),
			time: q('#mp-time'),
			timePlay: q('#mp-time-play'),
			timeRange: q('#mp-time-range'),
			timeLbl: q('#mp-time-lbl'),
			grid2d: q('#mp-2d-grid'),
			roster: q('#mp-roster'),
			rosterList: q('#mp-roster-list'),
			tip: q('#mp-tip'),
			inspect: q('#mp-inspect'),
			toast: q('#mp-toast'),
			overlay: q('#mp-overlay'),
		};
	}

	// ── Chrome wiring (toolbar, keyboard, resize) ───────────────────────────────

	wireChrome() {
		const e = this.el;
		let debounce = null;
		e.q.addEventListener('input', () => {
			clearTimeout(debounce);
			debounce = setTimeout(() => {
				this.filter.q = e.q.value.trim().toLowerCase();
				this.applyFilter();
			}, 140);
		});
		this.root.querySelectorAll('.mp-chip').forEach((chip) => {
			chip.addEventListener('click', () => {
				const t = chip.dataset.type;
				if (this.filter.types.has(t)) this.filter.types.delete(t);
				else this.filter.types.add(t);
				chip.setAttribute('aria-pressed', this.filter.types.has(t) ? 'true' : 'false');
				chip.style.background = this.filter.types.has(t) ? TYPES[t].hex : '';
				this.applyFilter();
			});
			// Initialise the pressed colour.
			chip.style.background = TYPES[chip.dataset.type].hex;
		});
		const SORTS = [
			['salience', '↕ Salience'],
			['recent', '◷ Newest'],
			['oldest', '◷ Oldest'],
			['accessed', '↻ Most recalled'],
		];
		let sortIdx = 0;
		e.sort.addEventListener('click', () => {
			sortIdx = (sortIdx + 1) % SORTS.length;
			this.filter.sort = SORTS[sortIdx][0];
			e.sort.textContent = SORTS[sortIdx][1];
			this.applyFilter();
		});
		e.modeBtn.addEventListener('click', () => this.setMode(this.mode === '3d' ? '2d' : '3d'));
		e.timelineBtn.addEventListener('click', () => this.toggleTimeline());
		e.timeRange.addEventListener('input', () => {
			this.timeCursor = Number(e.timeRange.value) / 1000;
			this.applyTimeCursor();
		});
		e.timePlay.addEventListener('click', () => this.playTimeline());

		// Keyboard: '/' focuses search; the roster handles graph traversal.
		this._keyHandler = (ev) => this.onKey(ev);
		this.root.addEventListener('keydown', this._keyHandler);
		this.el.rosterList.addEventListener('keydown', (ev) => this.onRosterKey(ev));

		// Pause rendering when offscreen — the avatar is on every page; don't burn
		// frames on a Palace nobody is looking at.
		if ('IntersectionObserver' in window) {
			this._io = new IntersectionObserver((ents) => {
				this._visible = ents[0]?.isIntersecting ?? true;
				if (this._visible && this.mode === '3d') this.startLoop();
				else this.stopLoop();
			}, { threshold: 0.05 });
			this._io.observe(this.root);
		} else {
			this._visible = true;
		}

		this._onResize = () => this.resize();
		window.addEventListener('resize', this._onResize);
	}

	onKey(ev) {
		if (ev.key === '/' && document.activeElement !== this.el.q) {
			ev.preventDefault();
			this.el.q.focus();
			this.el.q.select();
		} else if (ev.key === 'Escape') {
			if (this.el.inspect.classList.contains('open')) this.closeInspector();
		} else if ((ev.key === 'f' || ev.key === 'F') && document.activeElement === this.root) {
			this.el.roster.focus();
			this.moveFocus(0);
		}
	}

	// ── Data loading ────────────────────────────────────────────────────────────

	async load() {
		this.showOverlay('loading');
		try {
			// Fetch per-type in parallel (the list endpoint caps at 500/request);
			// the four types are disjoint, so this lifts capacity to ~2000 of the
			// most-salient memories without any dedup.
			const batches = await Promise.all(
				ALL_TYPES.map((t) => listMemories(this.agentId, { type: t, limit: 500 }).catch(() => []))
			);
			const all = [];
			for (const b of batches) for (const m of b) if (m && m.id) all.push(m);
			this.ingest(all);
			if (!all.length) {
				this.showOverlay('empty');
				return;
			}
			this.hideOverlay();
			await this.ensureScene();
			this.rebuild();
			this.updateStat();
		} catch (err) {
			this.showOverlay('error', err?.message || String(err));
		}
	}

	ingest(memories) {
		this.nodes = [];
		this.byId.clear();
		// Time span for recency mapping + timeline scrub.
		this.tMin = Infinity;
		this.tMax = -Infinity;
		for (const m of memories) {
			const t = m.createdAt || 0;
			if (t < this.tMin) this.tMin = t;
			if (t > this.tMax) this.tMax = t;
		}
		if (!Number.isFinite(this.tMin)) { this.tMin = 0; this.tMax = 1; }
		if (this.tMax <= this.tMin) this.tMax = this.tMin + 1;
		for (const m of memories) this.addNode(m, { bloom: false });
		this.computeEdges();
	}

	addNode(mem, { bloom = true } = {}) {
		const type = TYPES[mem.type] ? mem.type : 'reference';
		const pos = this.layoutPosition(mem, type);
		const node = {
			mem,
			type,
			x: pos.x, y: pos.y, z: pos.z,
			baseR: pos.r,
			bornAt: bloom ? now() : 0,
			pulseAt: 0,
			visible: true,
			instId: -1,
		};
		this.nodes.push(node);
		this.byId.set(mem.id, node);
		return node;
	}

	// Deterministic layout: each type owns an angular sector; salience pulls a
	// memory in toward the avatar; the id-hash spreads nodes on a shell so they
	// don't overlap. Stable across reloads (no RAF, no randomness).
	layoutPosition(mem, type) {
		const sal = clamp01(mem.salience ?? 0.5);
		const r = INNER_R + (1 - sal) * SPAN;
		const sectorBase = TYPES[type].sector;
		// Spread within a ~110° sector around the type's base angle.
		const a = sectorBase + (hash01(mem.id, 1) - 0.5) * 1.92;
		// Vertical band: high-salience memories ride near the equator (eye-level
		// with the avatar); low-salience scatter up/down.
		const phi = (hash01(mem.id, 2) - 0.5) * Math.PI * (0.35 + (1 - sal) * 0.65);
		const x = Math.cos(phi) * Math.cos(a) * r;
		const z = Math.cos(phi) * Math.sin(a) * r;
		const y = Math.sin(phi) * r;
		return { x, y, z, r };
	}

	computeEdges() {
		// Association graph: connect memories that share at least one tag. Build a
		// tag→nodes index, score each candidate pair by shared-tag count × combined
		// salience, keep the strongest MAX_EDGES.
		const byTag = new Map();
		for (const n of this.nodes) {
			for (const tag of n.mem.tags || []) {
				const k = String(tag).toLowerCase();
				if (!byTag.has(k)) byTag.set(k, []);
				byTag.get(k).push(n);
			}
		}
		const pairScore = new Map();
		const pairKey = (a, b) => (a.mem.id < b.mem.id ? a.mem.id + '|' + b.mem.id : b.mem.id + '|' + a.mem.id);
		for (const list of byTag.values()) {
			if (list.length < 2 || list.length > 60) continue; // skip mega-tags (noise)
			for (let i = 0; i < list.length; i++) {
				for (let j = i + 1; j < list.length; j++) {
					const k = pairKey(list[i], list[j]);
					const prev = pairScore.get(k);
					const score = (list[i].mem.salience || 0.3) + (list[j].mem.salience || 0.3);
					if (prev) prev.w += 1; else pairScore.set(k, { a: list[i], b: list[j], w: 1, s: score });
				}
			}
		}
		this.edges = [...pairScore.values()]
			.sort((x, y) => y.w * y.s - x.w * x.s)
			.slice(0, MAX_EDGES);
		// Adjacency for keyboard graph-walk + "why does it believe this".
		this.adj = new Map();
		for (const e of this.edges) {
			if (!this.adj.has(e.a.mem.id)) this.adj.set(e.a.mem.id, []);
			if (!this.adj.has(e.b.mem.id)) this.adj.set(e.b.mem.id, []);
			this.adj.get(e.a.mem.id).push({ node: e.b, w: e.w });
			this.adj.get(e.b.mem.id).push({ node: e.a, w: e.w });
		}
	}

	// ── Three.js scene ──────────────────────────────────────────────────────────

	async ensureScene() {
		if (this.scene || this.mode !== '3d') {
			if (this.mode === '3d') this.mountAvatar();
			return;
		}
		reserveWebGLContext();
		this._reservedCtx = true;
		const canvas = this.el.canvas;
		const w = this.root.clientWidth || 800;
		const h = this.root.clientHeight || 520;
		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		this.renderer.setSize(w, h, false);
		this.scene = new THREE.Scene();
		this.camera = new THREE.PerspectiveCamera(52, w / h, 0.1, 200);
		this.camera.position.set(0, 2.2, 18);
		this.controls = new OrbitControls(this.camera, canvas);
		this.controls.target.set(0, 0, 0);
		this.controls.enablePan = false; // keep the avatar locked to screen-centre
		this.controls.enableDamping = !this._reduce;
		this.controls.dampingFactor = 0.08;
		this.controls.minDistance = 7;
		this.controls.maxDistance = 40;
		this.controls.autoRotate = false;
		this.controls.rotateSpeed = 0.7;

		this.scene.add(new THREE.AmbientLight(0xb9c7ff, 0.55));
		const core = new THREE.PointLight(0x9db4ff, 2.2, 60, 1.4);
		core.position.set(0, 0, 0);
		this.scene.add(core);
		// A faint inner "pin core" ring the avatar sits inside — the drop target.
		const ringGeo = new THREE.RingGeometry(INNER_R - 0.5, INNER_R - 0.35, 64);
		const ringMat = new THREE.MeshBasicMaterial({ color: 0x7aa2ff, transparent: true, opacity: 0.14, side: THREE.DoubleSide });
		this.coreRing = new THREE.Mesh(ringGeo, ringMat);
		this.coreRing.rotation.x = Math.PI / 2;
		this.scene.add(this.coreRing);

		this.nodeGroup = new THREE.Group();
		this.scene.add(this.nodeGroup);
		this.edgeObj = null;
		this.instanced = {}; // type → { mesh, nodes:[] }

		this.raycaster = new THREE.Raycaster();
		this.pointer = new THREE.Vector2();
		this.dragPlane = new THREE.Plane();
		this._tmp = new THREE.Vector3();
		this._mat4 = new THREE.Matrix4();
		this._col = new THREE.Color();

		this.bindPointer();
		this.mountAvatar();
		this.resize();
		this.startLoop();
	}

	async mountAvatar() {
		if (this._avatarMounted) return;
		this._avatarMounted = true;
		const ok = await ensureAgent3D();
		if (this._disposed) return;
		if (ok) {
			const a = document.createElement('agent-3d');
			if (this.agentId) a.setAttribute('agent-id', this.agentId);
			if (this.agent?.avatar_id) a.setAttribute('avatar-id', this.agent.avatar_id);
			a.setAttribute('mode', 'inline');
			a.setAttribute('eager', '');
			this.el.avatar.appendChild(a);
			this.avatarEl = a;
		} else {
			this.el.avatar.innerHTML = `<div class="mp-avatar-fallback">🧠</div>`;
		}
	}

	rebuild() {
		if (this.mode === '3d' && this.scene) this.rebuildInstances();
		this.rebuild2D();
		this.rebuildRoster();
		this.applyFilter();
	}

	geomFor(type) {
		switch (TYPES[type].geom) {
			case 'octahedron': return new THREE.OctahedronGeometry(0.5, 0);
			case 'tetrahedron': return new THREE.TetrahedronGeometry(0.6, 0);
			case 'box': return new THREE.BoxGeometry(0.72, 0.72, 0.72);
			default: return new THREE.IcosahedronGeometry(0.52, 0);
		}
	}

	rebuildInstances() {
		// One InstancedMesh per type → 4 draw calls regardless of memory count.
		for (const t of ALL_TYPES) {
			const prev = this.instanced[t];
			if (prev) { this.nodeGroup.remove(prev.mesh); prev.mesh.geometry.dispose(); prev.mesh.material.dispose(); }
			const tNodes = this.nodes.filter((n) => n.type === t);
			const count = Math.max(tNodes.length, 1);
			const geo = this.geomFor(t);
			const mat = new THREE.MeshStandardMaterial({
				color: 0xffffff, metalness: 0.25, roughness: 0.35,
				emissive: TYPES[t].color, emissiveIntensity: 0.4,
				transparent: true, opacity: 1,
			});
			const mesh = new THREE.InstancedMesh(geo, mat, count);
			mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
			mesh.frustumCulled = false;
			mesh.userData.type = t;
			tNodes.forEach((n, i) => { n.instId = i; });
			this.instanced[t] = { mesh, nodes: tNodes };
			this.nodeGroup.add(mesh);
		}
		this.rebuildEdges();
		this.syncInstances(true);
	}

	rebuildEdges() {
		if (this.edgeObj) { this.nodeGroup.remove(this.edgeObj); this.edgeObj.geometry.dispose(); this.edgeObj.material.dispose(); this.edgeObj = null; }
		if (!this.edges.length) return;
		const positions = new Float32Array(this.edges.length * 6);
		this.edgeObj = new THREE.LineSegments(
			new THREE.BufferGeometry(),
			new THREE.LineBasicMaterial({ color: 0x6f86c9, transparent: true, opacity: 0.12 })
		);
		this.edgeObj.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
		this.edgeObj.frustumCulled = false;
		this.nodeGroup.add(this.edgeObj);
	}

	// Push positions/scales/colours for every instance. `full` recomputes colours;
	// otherwise only matrices (positions) update — cheap for drag/pulse frames.
	syncInstances(full = false) {
		if (!this.scene) return;
		const tNow = now();
		for (const t of ALL_TYPES) {
			const inst = this.instanced[t];
			if (!inst) continue;
			const { mesh, nodes } = inst;
			for (let i = 0; i < nodes.length; i++) {
				const n = nodes[i];
				const sal = clamp01(n.mem.salience ?? 0.5);
				let scale = 0.5 + sal * 1.5;
				// Bloom-in animation for freshly-formed memories.
				if (n.bornAt && !this._reduce) {
					const p = Math.min(1, (tNow - n.bornAt) / BLOOM_MS);
					scale *= easeOut(p);
					if (p >= 1) n.bornAt = 0;
				}
				// Recall pulse — a transient size + glow bump.
				let pulse = 0;
				if (n.pulseAt) {
					const p = (tNow - n.pulseAt) / PULSE_MS;
					if (p >= 1) n.pulseAt = 0;
					else pulse = Math.sin(p * Math.PI);
				}
				scale *= 1 + pulse * 0.6;
				if (!n.visible) scale = 0.0001;
				this._tmp.set(n.x, n.y, n.z);
				this._mat4.makeScale(scale, scale, scale);
				this._mat4.setPosition(this._tmp);
				mesh.setMatrixAt(i, this._mat4);
				if (full || n.pulseAt || n.bornAt || n._colorDirty) {
					// Brightness encodes salience + recency; expiring memories fade.
					const recency = (n.mem.createdAt - this.tMin) / (this.tMax - this.tMin || 1);
					let bright = 0.45 + sal * 0.55 + recency * 0.12;
					if (n.mem.expiresAt && n.mem.expiresAt < Date.now() + 1000 * 60 * 60 * 24 * 7) {
						bright *= 0.45; // dimming toward forgotten
					}
					if (this.selectedId === n.mem.id) bright = 1.25;
					bright = Math.min(1.4, bright + pulse * 0.8);
					this._col.setHex(TYPES[t].color).multiplyScalar(bright);
					mesh.setColorAt(i, this._col);
					n._colorDirty = false;
				}
			}
			mesh.count = nodes.length;
			mesh.instanceMatrix.needsUpdate = true;
			if (full && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
			else if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
		}
		this.syncEdgePositions();
	}

	syncEdgePositions() {
		if (!this.edgeObj) return;
		const pos = this.edgeObj.geometry.attributes.position.array;
		let k = 0;
		for (const e of this.edges) {
			const a = e.a, b = e.b;
			const show = a.visible && b.visible ? 1 : 0;
			pos[k++] = a.x * show; pos[k++] = a.y * show; pos[k++] = a.z * show;
			pos[k++] = b.x * show; pos[k++] = b.y * show; pos[k++] = b.z * show;
		}
		this.edgeObj.geometry.attributes.position.needsUpdate = true;
	}

	startLoop() {
		if (this._raf || this.mode !== '3d' || !this.scene) return;
		const tick = () => {
			this._raf = requestAnimationFrame(tick);
			if (this.controls) this.controls.update();
			// Only resync matrices when something is animating (bloom/pulse/drag).
			const animating = this.dragging || this.nodes.some((n) => n.bornAt || n.pulseAt);
			if (animating) this.syncInstances(false);
			if (this.coreRing && !this._reduce) this.coreRing.rotation.z += 0.0015;
			this.positionAvatarDepth();
			this.renderer.render(this.scene, this.camera);
		};
		this._raf = requestAnimationFrame(tick);
	}

	stopLoop() {
		if (this._raf) cancelAnimationFrame(this._raf);
		this._raf = null;
	}

	positionAvatarDepth() {
		// The avatar overlay sits at the projected origin. With pan disabled and
		// target=origin it stays at screen-centre, but project precisely so it
		// tracks during damping.
		if (!this.el.avatar || !this.camera) return;
		this._tmp.set(0, 0, 0).project(this.camera);
		const x = (this._tmp.x * 0.5 + 0.5) * 100;
		const y = (-this._tmp.y * 0.5 + 0.5) * 100;
		this.el.avatar.style.left = x + '%';
		this.el.avatar.style.top = y + '%';
	}

	resize() {
		if (this.mode !== '3d' || !this.renderer) return;
		const w = this.root.clientWidth || 800;
		const h = this.root.clientHeight || 520;
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	}

	// ── Pointer: hover, click, drag-to-pin, flick-to-forget ────────────────────

	bindPointer() {
		const c = this.el.canvas;
		c.style.pointerEvents = 'auto';
		this._onMove = (ev) => this.onPointerMove(ev);
		this._onDown = (ev) => this.onPointerDown(ev);
		this._onUp = (ev) => this.onPointerUp(ev);
		c.addEventListener('pointermove', this._onMove);
		c.addEventListener('pointerdown', this._onDown);
		window.addEventListener('pointerup', this._onUp);
	}

	pickNode(ev) {
		const rect = this.el.canvas.getBoundingClientRect();
		this.pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
		this.pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
		this.raycaster.setFromCamera(this.pointer, this.camera);
		for (const t of ALL_TYPES) {
			const inst = this.instanced[t];
			if (!inst || !inst.nodes.length) continue;
			const hits = this.raycaster.intersectObject(inst.mesh);
			for (const hit of hits) {
				const n = inst.nodes[hit.instanceId];
				if (n && n.visible) return { node: n, point: hit.point };
			}
		}
		return null;
	}

	onPointerMove(ev) {
		if (this._press && !this.dragging) this.maybeStartDrag(ev);
		if (this.dragging) { this.dragMove(ev); return; }
		const hit = this.pickNode(ev);
		if (hit) {
			this.el.canvas.style.cursor = 'grab';
			this.showTip(hit.node, ev);
		} else {
			this.el.canvas.style.cursor = '';
			this.hideTip();
		}
	}

	onPointerDown(ev) {
		const hit = this.pickNode(ev);
		if (!hit) return;
		ev.preventDefault();
		this._press = { node: hit.node, x: ev.clientX, y: ev.clientY, moved: false, t: now() };
		// Set a drag plane through the node, facing the camera.
		this.camera.getWorldDirection(this._tmp);
		this.dragPlane.setFromNormalAndCoplanarPoint(this._tmp.clone().negate(), new THREE.Vector3(hit.node.x, hit.node.y, hit.node.z));
	}

	dragMove(ev) {
		const rect = this.el.canvas.getBoundingClientRect();
		this.pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
		this.pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
		this.raycaster.setFromCamera(this.pointer, this.camera);
		const hitP = new THREE.Vector3();
		if (this.raycaster.ray.intersectPlane(this.dragPlane, hitP)) {
			const n = this.dragging;
			n.x = hitP.x; n.y = hitP.y; n.z = hitP.z;
		}
		// Arm + highlight the forget well when the pointer is over it.
		const fr = this.el.forget.getBoundingClientRect();
		const over = ev.clientX >= fr.left && ev.clientX <= fr.right && ev.clientY >= fr.top && ev.clientY <= fr.bottom;
		this.el.forget.classList.toggle('hot', over);
		// Glow the core ring when near centre (pin zone).
		const dist = Math.hypot(this.dragging.x, this.dragging.y, this.dragging.z);
		if (this.coreRing) this.coreRing.material.opacity = dist < INNER_R + 1.2 ? 0.4 : 0.14;
	}

	onPointerUp(ev) {
		if (this.dragging) {
			const n = this.dragging;
			this.dragging = null;
			this.el.canvas.style.cursor = '';
			this.el.forget.classList.remove('armed', 'hot');
			if (this.coreRing) this.coreRing.material.opacity = 0.14;
			const fr = this.el.forget.getBoundingClientRect();
			const overForget = ev.clientX >= fr.left && ev.clientX <= fr.right && ev.clientY >= fr.top && ev.clientY <= fr.bottom;
			const dist = Math.hypot(n.x, n.y, n.z);
			if (overForget) {
				this.forget(n);
			} else if (dist < INNER_R + 1.0) {
				this.pin(n, true);
				this.resetNodePos(n);
			} else {
				this.resetNodePos(n);
			}
			return;
		}
		if (this._press) {
			const p = this._press;
			this._press = null;
			const moved = Math.hypot(ev.clientX - p.x, ev.clientY - p.y);
			if (moved < 5 && now() - p.t < 500) this.openInspector(p.node.mem.id);
		}
	}

	resetNodePos(n) {
		const pos = this.layoutPosition(n.mem, n.type);
		n.x = pos.x; n.y = pos.y; n.z = pos.z; n.baseR = pos.r;
		n._colorDirty = true;
		this.syncInstances(false);
	}

	// Promote a drag into a real drag once it crosses threshold (called from move
	// while a press is active but not yet dragging).
	maybeStartDrag(ev) {
		if (!this._press || this.dragging) return;
		const moved = Math.hypot(ev.clientX - this._press.x, ev.clientY - this._press.y);
		if (moved > 6) {
			this.dragging = this._press.node;
			this.el.canvas.style.cursor = 'grabbing';
			this.el.forget.classList.add('armed');
			this.hideTip();
		}
	}

	showTip(node, ev) {
		const m = node.mem;
		const rect = this.root.getBoundingClientRect();
		this.el.tip.innerHTML = `<div class="t" style="color:${TYPES[node.type].hex}">${esc(TYPES[node.type].label)} · ${Math.round((m.salience || 0) * 100)}%</div>${esc(truncate(m.content, 120))}${(m.tags || []).length ? `<div class="s">#${(m.tags || []).slice(0, 4).map(esc).join(' #')}</div>` : ''}`;
		this.el.tip.style.left = ev.clientX - rect.left + 'px';
		this.el.tip.style.top = ev.clientY - rect.top + 'px';
		this.el.tip.classList.add('show');
	}

	hideTip() { this.el.tip.classList.remove('show'); }

	// ── Curation actions (real API via memory-client) ──────────────────────────

	// Build a complete upsert entry from a decorated record so a PATCH never drops
	// fields (the server upsert overwrites with whatever it receives).
	entryFrom(mem, overrides = {}) {
		return {
			id: mem.id,
			type: mem.type,
			content: mem.content,
			tags: mem.tags || [],
			context: mem.context || {},
			salience: mem.salience,
			pinned: !!mem.pinned,
			createdAt: mem.createdAt,
			expiresAt: mem.expiresAt ?? null,
			...overrides,
		};
	}

	async pin(node, on) {
		const m = node.mem;
		const prev = { salience: m.salience, pinned: m.pinned };
		// Optimistic: pinning lifts salience toward the core.
		const nextSal = on ? Math.max(m.salience || 0, 0.85) : Math.min(m.salience ?? 0.5, 0.5);
		m.pinned = on; m.salience = nextSal;
		node._colorDirty = true;
		this.resetNodePos(node);
		this.refreshInspectorIf(m.id);
		this.updateCardFor(node);
		try {
			const updated = await updateMemory(this.agentId, this.entryFrom(m, { pinned: on, salience: nextSal }));
			if (updated) Object.assign(m, updated);
			this.flashHint(on ? 'Pinned to the core — your agent will keep this close.' : 'Unpinned.');
		} catch (err) {
			m.pinned = prev.pinned; m.salience = prev.salience; // rollback
			node._colorDirty = true; this.resetNodePos(node); this.refreshInspectorIf(m.id); this.updateCardFor(node);
			this.flashHint(`Could not pin: ${err.message}`, true);
		}
	}

	async setSalience(node, value) {
		const m = node.mem;
		const prev = m.salience;
		m.salience = clamp01(value);
		node._colorDirty = true;
		this.resetNodePos(node);
		this.updateCardFor(node);
		try {
			const updated = await updateMemory(this.agentId, this.entryFrom(m, { salience: m.salience }));
			if (updated) Object.assign(m, updated);
		} catch (err) {
			m.salience = prev; node._colorDirty = true; this.resetNodePos(node); this.updateCardFor(node);
			this.flashHint(`Could not change salience: ${err.message}`, true);
		}
	}

	// Flick-to-forget = schedule expiry (reversible). We set expires_at to now so
	// the memory is excluded from future recall and visibly leaves the scene, but
	// the row survives until the server's sweep — undo simply clears expires_at.
	async forget(node) {
		const m = node.mem;
		const prevExpiry = m.expiresAt ?? null;
		const expireAt = Date.now();
		// Optimistic remove from the scene.
		node.visible = false;
		this.removeNodeFromScene(node);
		if (this.selectedId === m.id) this.closeInspector();
		try {
			const updated = await updateMemory(this.agentId, this.entryFrom(m, { expiresAt: expireAt }));
			if (updated) Object.assign(m, updated);
			this.showUndo(`Forgot “${truncate(m.content, 40)}”`, async () => {
				try {
					const restored = await updateMemory(this.agentId, this.entryFrom(m, { expiresAt: prevExpiry }));
					if (restored) Object.assign(m, restored);
					node.visible = true;
					this.restoreNodeToScene(node);
					this.flashHint('Restored.');
				} catch (err) {
					this.flashHint(`Could not restore: ${err.message}`, true);
				}
			});
		} catch (err) {
			node.visible = true;
			this.restoreNodeToScene(node);
			this.flashHint(`Could not forget: ${err.message}`, true);
		}
	}

	// Hard delete — used from the inspector "Delete forever" action.
	async deleteForever(node) {
		const m = node.mem;
		const snapshot = { ...m };
		node.visible = false;
		this.removeNodeFromScene(node);
		if (this.selectedId === m.id) this.closeInspector();
		try {
			await forgetMemory(this.agentId, m.id);
			this.showUndo(`Deleted “${truncate(m.content, 40)}”`, async () => {
				try {
					// Re-create from the snapshot (new id assigned by the server).
					const recreated = await import('./agents/memory-client.js').then((mod) =>
						mod.addMemory(this.agentId, {
							type: snapshot.type, content: snapshot.content, tags: snapshot.tags,
							context: snapshot.context, salience: snapshot.salience, pinned: snapshot.pinned,
						})
					);
					if (recreated) { this.byId.delete(m.id); this.addNode(recreated, { bloom: true }); this.computeEdges(); this.rebuild(); }
					this.flashHint('Restored as a new memory.');
				} catch (err) {
					this.flashHint(`Could not restore: ${err.message}`, true);
				}
			});
		} catch (err) {
			node.visible = true; this.restoreNodeToScene(node);
			this.flashHint(`Could not delete: ${err.message}`, true);
		}
	}

	removeNodeFromScene(node) {
		node._colorDirty = true;
		if (this.mode === '3d' && this.scene) this.syncInstances(false);
		this.updateStat();
		this.removeCardFor(node);
		this.rebuildRoster();
	}

	// Permanently drop a node (hard delete / bus forget): remove it from the model
	// and rebuild so its instance slot + edges are reclaimed. Soft-forget does NOT
	// call this — that path keeps the node so undo can restore it.
	dropNode(node) {
		const i = this.nodes.indexOf(node);
		if (i >= 0) this.nodes.splice(i, 1);
		this.byId.delete(node.mem.id);
		this.computeEdges();
		if (this.mode === '3d' && this.scene) this.rebuildInstances();
		this.rebuild2D();
		this.rebuildRoster();
		this.updateStat();
	}
	restoreNodeToScene(node) {
		node.bornAt = this._reduce ? 0 : now();
		node._colorDirty = true;
		if (this.mode === '3d' && this.scene) { this.syncInstances(false); this.startLoop(); }
		this.rebuild2D(); this.rebuildRoster(); this.updateStat();
	}

	// ── Filtering / sorting (client-side, debounced) ────────────────────────────

	applyFilter() {
		const q = this.filter.q;
		for (const n of this.nodes) {
			if (!this.byId.has(n.mem.id)) continue;
			const m = n.mem;
			let vis = this.filter.types.has(n.type);
			if (vis && m.expiresAt && m.expiresAt < Date.now()) vis = false; // forgotten
			if (vis && q) {
				const hay = (m.content + ' ' + (m.tags || []).join(' ') + ' ' + n.type).toLowerCase();
				vis = hay.includes(q);
			}
			if (vis && this.timeCursor < 1) {
				const cut = this.tMin + (this.tMax - this.tMin) * this.timeCursor;
				if (m.createdAt > cut) vis = false;
			}
			n.visible = vis;
			n._colorDirty = true;
		}
		if (this.mode === '3d' && this.scene) this.syncInstances(false);
		this.rebuild2D();
		this.rebuildRoster();
		this.updateStat();
	}

	sortedVisible() {
		const arr = this.nodes.filter((n) => n.visible);
		const s = this.filter.sort;
		arr.sort((a, b) => {
			if (s === 'recent') return b.mem.createdAt - a.mem.createdAt;
			if (s === 'oldest') return a.mem.createdAt - b.mem.createdAt;
			if (s === 'accessed') return (b.mem.accessCount || 0) - (a.mem.accessCount || 0);
			return (b.mem.salience || 0) - (a.mem.salience || 0);
		});
		return arr;
	}

	updateStat() {
		const vis = this.nodes.filter((n) => n.visible).length;
		const total = this.byId.size;
		const pinned = this.nodes.filter((n) => n.mem.pinned).length;
		this.el.stat.innerHTML = `<b>${vis}</b> shown · ${total} total · <b>${pinned}</b> pinned`;
	}

	// ── Timeline scrub ──────────────────────────────────────────────────────────

	toggleTimeline() {
		const on = !this.el.time.classList.contains('show');
		this.el.time.classList.toggle('show', on);
		this.el.timelineBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
		if (!on) { this.timeCursor = 1; this.el.timeRange.value = 1000; this.applyFilter(); this.el.timeLbl.textContent = 'now'; }
	}

	applyTimeCursor() {
		const cut = this.tMin + (this.tMax - this.tMin) * this.timeCursor;
		this.el.timeLbl.textContent = this.timeCursor >= 1 ? 'now' : new Date(cut).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
		this.applyFilter();
	}

	playTimeline() {
		if (this._playing) { this._playing = false; this.el.timePlay.textContent = '▶'; return; }
		this._playing = true;
		this.el.timePlay.textContent = '⏸';
		const dur = this._reduce ? 0 : 4200;
		const start = now();
		const from = this.timeCursor < 1 ? this.timeCursor : 0;
		const step = () => {
			if (!this._playing || this._disposed) return;
			const p = dur ? Math.min(1, (now() - start) / dur) : 1;
			this.timeCursor = from + (1 - from) * p;
			this.el.timeRange.value = Math.round(this.timeCursor * 1000);
			this.applyTimeCursor();
			if (p < 1) requestAnimationFrame(step);
			else { this._playing = false; this.el.timePlay.textContent = '▶'; }
		};
		requestAnimationFrame(step);
	}

	// ── 2D fallback ─────────────────────────────────────────────────────────────

	setMode(mode) {
		if (mode === this.mode) return;
		this.mode = mode;
		this.root.classList.toggle('mode-2d', mode === '2d');
		this.root.classList.toggle('mode-3d', mode === '3d');
		this.el.modeBtn.setAttribute('aria-pressed', mode === '2d' ? 'true' : 'false');
		this.el.modeBtn.textContent = mode === '2d' ? '◉ 3D' : '▦ 2D';
		if (mode === '3d') {
			this.ensureScene().then(() => { this.rebuildInstances(); this.applyFilter(); this.startLoop(); });
		} else {
			this.stopLoop();
			this.rebuild2D();
		}
	}

	rebuild2D() {
		if (!this.el.grid2d) return;
		const grid = this.el.grid2d;
		const visible = this.sortedVisible();
		if (!this.byId.size) { grid.innerHTML = ''; return; }
		// Group by type for legibility (constellations as sections).
		const frag = document.createDocumentFragment();
		const byType = {};
		for (const n of visible) (byType[n.type] ||= []).push(n);
		for (const t of ALL_TYPES) {
			const list = byType[t];
			if (!list || !list.length) continue;
			const sec = document.createElement('div');
			sec.className = 'mp-2d-sec';
			sec.textContent = `${TYPES[t].label} · ${list.length}`;
			frag.appendChild(sec);
			for (const n of list) frag.appendChild(this.cardEl(n));
		}
		grid.innerHTML = '';
		grid.appendChild(frag);
	}

	cardEl(n) {
		const m = n.mem;
		const card = document.createElement('button');
		card.className = 'mp-card';
		card.dataset.id = m.id;
		card.style.borderLeftColor = TYPES[n.type].hex;
		const pct = Math.round((m.salience || 0) * 100);
		const expiring = m.expiresAt && m.expiresAt < Date.now() + 1000 * 60 * 60 * 24 * 7;
		if (expiring) card.classList.add('dim');
		card.innerHTML = `
			${m.pinned ? '<span class="pin" title="Pinned">📌</span>' : ''}
			<div class="ctop"><span class="dot" style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${TYPES[n.type].hex}"></span><span style="color:${TYPES[n.type].hex}">${esc(TYPES[n.type].label)}</span><span class="pct">${pct}%</span></div>
			<div class="ctxt">${esc(m.content || '')}</div>
			<div class="cbar"><i style="width:${pct}%;background:${TYPES[n.type].hex}"></i></div>
			${(m.tags || []).length ? `<div class="ctags">${(m.tags || []).slice(0, 5).map((x) => `<span>#${esc(x)}</span>`).join('')}</div>` : ''}`;
		card.addEventListener('click', () => this.openInspector(m.id));
		return card;
	}

	updateCardFor(node) {
		if (this.mode !== '2d') return;
		const old = this.el.grid2d.querySelector(`.mp-card[data-id="${cssEsc(node.mem.id)}"]`);
		if (old) old.replaceWith(this.cardEl(node));
	}
	removeCardFor(node) {
		const old = this.el.grid2d?.querySelector(`.mp-card[data-id="${cssEsc(node.mem.id)}"]`);
		if (old) old.remove();
	}

	// ── Keyboard roster (a11y) — a real, operable mirror of the scene ──────────

	rebuildRoster() {
		const list = this.el.rosterList;
		const visible = this.sortedVisible();
		list.innerHTML = '';
		visible.forEach((n, i) => {
			const li = document.createElement('li');
			const b = document.createElement('button');
			b.type = 'button';
			b.dataset.id = n.mem.id;
			b.tabIndex = i === 0 ? 0 : -1;
			b.setAttribute('aria-label', `${TYPES[n.type].label} memory, salience ${Math.round((n.mem.salience || 0) * 100)} percent${n.mem.pinned ? ', pinned' : ''}: ${truncate(n.mem.content, 90)}`);
			b.innerHTML = `<span class="rdot" style="background:${TYPES[n.type].hex}"></span><span>${esc(truncate(n.mem.content, 60))}</span>`;
			b.addEventListener('click', () => this.openInspector(n.mem.id));
			li.appendChild(b);
			list.appendChild(li);
		});
		this.focusIdx = visible.length ? 0 : -1;
	}

	rosterButtons() { return [...this.el.rosterList.querySelectorAll('button')]; }

	moveFocus(idx) {
		const btns = this.rosterButtons();
		if (!btns.length) return;
		this.focusIdx = (idx + btns.length) % btns.length;
		btns.forEach((b, i) => { b.tabIndex = i === this.focusIdx ? 0 : -1; b.classList.toggle('focus', i === this.focusIdx); });
		const b = btns[this.focusIdx];
		b.focus();
		// Frame the focused node in the scene.
		const n = this.byId.get(b.dataset.id);
		if (n && this.selectedId !== n.mem.id) { this.selectedId = n.mem.id; n._colorDirty = true; if (this.scene) this.syncInstances(false); }
	}

	onRosterKey(ev) {
		const btns = this.rosterButtons();
		if (!btns.length) return;
		const cur = this.byId.get(document.activeElement?.dataset?.id);
		if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') { ev.preventDefault(); this.moveFocus(this.focusIdx + 1); }
		else if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') { ev.preventDefault(); this.moveFocus(this.focusIdx - 1); }
		else if (ev.key === 'Home') { ev.preventDefault(); this.moveFocus(0); }
		else if (ev.key === 'End') { ev.preventDefault(); this.moveFocus(btns.length - 1); }
		else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); if (cur) this.openInspector(cur.mem.id); }
		else if ((ev.key === 'p' || ev.key === 'P') && cur) { ev.preventDefault(); this.pin(cur, !cur.mem.pinned); }
		else if ((ev.key === 'Delete' || ev.key === 'Backspace') && cur) { ev.preventDefault(); this.forget(cur); }
		else if (ev.key === 'g' && cur) {
			// Graph-walk: jump to the strongest tag-neighbour.
			ev.preventDefault();
			const neigh = (this.adj.get(cur.mem.id) || []).filter((x) => x.node.visible).sort((a, b) => b.w - a.w)[0];
			if (neigh) { const idx = btns.findIndex((b) => b.dataset.id === neigh.node.mem.id); if (idx >= 0) this.moveFocus(idx); }
		}
	}

	// ── Inspector ───────────────────────────────────────────────────────────────

	openInspector(id) {
		const node = this.byId.get(id);
		if (!node) return;
		this.selectedId = id;
		node._colorDirty = true;
		if (this.scene) this.syncInstances(false);
		const m = node.mem;
		const ty = TYPES[node.type];
		const created = m.createdAt ? new Date(m.createdAt) : null;
		const related = (this.adj.get(id) || [])
			.filter((x) => x.node.visible)
			.sort((a, b) => b.w - a.w)
			.slice(0, 6);
		const prov = this.provenanceHTML(m);
		const ctx = m.context && Object.keys(m.context).length
			? `<h4>Context</h4><div class="mp-context">${esc(JSON.stringify(m.context, null, 2))}</div>` : '';
		this.el.inspect.hidden = false;
		this.el.inspect.innerHTML = `
<div class="mp-inspect-hd">
	<span class="badge" style="background:${ty.hex}22;color:${ty.hex};border:1px solid ${ty.hex}55">${esc(ty.label)}</span>
	<span style="font-size:.74rem;color:rgba(255,255,255,.55)">${Math.round((m.salience || 0) * 100)}% salient${m.pinned ? ' · 📌 pinned' : ''}</span>
	<button class="x" aria-label="Close" id="mp-x">×</button>
</div>
<div class="mp-inspect-bd">
	<div class="mp-inspect-content">${esc(m.content || '')}</div>
	${(m.tags || []).length ? `<h4>Tags</h4><div>${(m.tags || []).map((t) => `<button class="mp-tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</div>` : ''}
	<h4>Salience</h4>
	<input type="range" id="mp-sal" min="0" max="100" value="${Math.round((m.salience || 0) * 100)}" style="width:100%;accent-color:${ty.hex}" aria-label="Adjust salience" />
	<h4>Details</h4>
	<dl class="mp-meta-grid">
		<dt>Created</dt><dd>${created ? esc(created.toLocaleString()) : '—'}</dd>
		<dt>Recalled</dt><dd>${m.accessCount || 0}×</dd>
		<dt>Tier</dt><dd>${esc(m.tier || 'recall')}</dd>
		<dt>Visibility</dt><dd>${m.isPublic ? 'Public' : 'Private'}</dd>
		${m.expiresAt ? `<dt>Expires</dt><dd>${esc(new Date(m.expiresAt).toLocaleString())}</dd>` : ''}
		<dt>Indexed</dt><dd>${m.hasEmbedding ? 'embedded' : 'pending'}</dd>
	</dl>
	${ctx}
	${prov}
	${related.length ? `<h4>Why your agent connects this</h4><div class="mp-related">${related.map((r) => `
		<button data-goto="${esc(r.node.mem.id)}"><span class="rdot" style="background:${TYPES[r.node.type].hex}"></span><span>${esc(truncate(r.node.mem.content, 54))}</span><span class="rwhy">${sharedTags(m, r.node.mem)}</span></button>`).join('')}</div>` : ''}
</div>
<div class="mp-inspect-actions">
	<button class="mp-action pin" id="mp-pin" aria-pressed="${m.pinned ? 'true' : 'false'}">${m.pinned ? '📌 Pinned' : '📌 Pin to core'}</button>
	<button class="mp-action forget" id="mp-forget-btn">🗑 Forget</button>
	<button class="mp-action forget" id="mp-del-btn" title="Permanently delete (with undo)">Delete forever</button>
</div>`;
		requestAnimationFrame(() => this.el.inspect.classList.add('open'));
		const q = (s) => this.el.inspect.querySelector(s);
		q('#mp-x').addEventListener('click', () => this.closeInspector());
		q('#mp-pin').addEventListener('click', () => this.pin(node, !node.mem.pinned).then(() => this.refreshInspectorIf(id)));
		q('#mp-forget-btn').addEventListener('click', () => this.forget(node));
		q('#mp-del-btn').addEventListener('click', () => this.deleteForever(node));
		const sal = q('#mp-sal');
		let salDebounce;
		sal.addEventListener('input', () => { clearTimeout(salDebounce); salDebounce = setTimeout(() => this.setSalience(node, Number(sal.value) / 100), 200); });
		this.el.inspect.querySelectorAll('.mp-tag').forEach((b) => b.addEventListener('click', () => {
			this.el.q.value = b.dataset.tag; this.filter.q = b.dataset.tag.toLowerCase(); this.applyFilter(); this.closeInspector();
		}));
		this.el.inspect.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => this.openInspector(b.dataset.goto)));
	}

	refreshInspectorIf(id) { if (this.selectedId === id && this.el.inspect.classList.contains('open')) this.openInspector(id); }

	provenanceHTML(m) {
		const c = m.context || {};
		const src = c.source || c.origin || c.via;
		const conv = c.conversationId || c.conversation_id || c.threadId;
		const url = c.url || c.href;
		const links = [];
		if (conv) links.push(`<a href="/agents/${esc(this.agentId)}?conversation=${esc(conv)}">the conversation that formed it →</a>`);
		if (url && /^https?:\/\//.test(url)) links.push(`<a href="${esc(url)}" target="_blank" rel="noopener">source page →</a>`);
		if (!src && !links.length) return '';
		return `<h4>Provenance</h4><div class="mp-prov">${src ? `Formed via <b>${esc(src)}</b>. ` : ''}${links.join(' · ')}</div>`;
	}

	closeInspector() {
		this.el.inspect.classList.remove('open');
		const prev = this.selectedId;
		this.selectedId = null;
		const n = this.byId.get(prev);
		if (n) { n._colorDirty = true; if (this.scene) this.syncInstances(false); }
		setTimeout(() => { if (!this.el.inspect.classList.contains('open')) this.el.inspect.hidden = true; }, 300);
	}

	// ── Undo toast ────────────────────────────────────────────────────────────

	showUndo(label, onUndo) {
		clearTimeout(this._undoTimer);
		this.el.toast.innerHTML = `<span>${esc(label)}</span><button id="mp-undo">Undo</button>`;
		this.el.toast.classList.add('show');
		this.el.toast.querySelector('#mp-undo').addEventListener('click', () => {
			this.el.toast.classList.remove('show');
			clearTimeout(this._undoTimer);
			onUndo();
		});
		this._undoTimer = setTimeout(() => this.el.toast.classList.remove('show'), 7000);
	}

	flashHint(msg, isError = false) {
		this.el.hint.textContent = msg;
		this.el.hint.style.color = isError ? '#f7a8c4' : 'rgba(255,255,255,.62)';
		this.el.hint.style.opacity = '1';
		clearTimeout(this._hintTimer);
		this._hintTimer = setTimeout(() => { this.el.hint.style.opacity = '0'; }, 3200);
	}

	// ── Live bus ────────────────────────────────────────────────────────────────

	subscribeBus() {
		const mine = (p) => !p.agentId || p.agentId === this.agentId;
		this._busOff.push(agentBus.on(EVENTS.MEMORY_ADDED, (p) => {
			if (!mine(p) || !p.memory) return;
			if (this.byId.has(p.memory.id)) return;
			if (this.el.overlay && !this.el.overlay.hidden) this.hideOverlay();
			this.addNode(p.memory, { bloom: true });
			this.computeEdges();
			if (this.mode === '3d' && this.scene) { this.rebuildInstances(); this.startLoop(); }
			this.rebuild2D(); this.rebuildRoster(); this.updateStat();
			this.flashHint('A new memory just formed.');
		}));
		this._busOff.push(agentBus.on(EVENTS.MEMORY_RECALLED, (p) => {
			if (!mine(p)) return;
			const mems = p.memories || [];
			let any = false;
			for (const rm of mems) {
				const n = this.byId.get(rm.id);
				if (n) { n.pulseAt = now(); n._colorDirty = true; any = true; }
			}
			if (any && this.mode === '3d' && this.scene) this.startLoop();
			if (any) this.flashHint(`Recalled ${mems.length} ${mems.length === 1 ? 'memory' : 'memories'}${p.query ? ` for “${truncate(p.query, 30)}”` : ''}.`);
		}));
		this._busOff.push(agentBus.on(EVENTS.MEMORY_UPDATED, (p) => {
			if (!mine(p) || !p.memory) return;
			const n = this.byId.get(p.memory.id);
			if (!n) return;
			Object.assign(n.mem, p.memory);
			n._colorDirty = true;
			this.resetNodePos(n);
			this.updateCardFor(n);
			this.refreshInspectorIf(p.memory.id);
		}));
		this._busOff.push(agentBus.on(EVENTS.MEMORY_FORGOTTEN, (p) => {
			if (!mine(p)) return;
			const n = this.byId.get(p.memoryId);
			if (!n) return;
			n.visible = false;
			this.byId.delete(p.memoryId);
			this.removeNodeFromScene(n);
		}));
	}

	// ── Overlays ─────────────────────────────────────────────────────────────────

	showOverlay(kind, detail = '') {
		const o = this.el.overlay;
		o.hidden = false;
		if (kind === 'loading') {
			o.innerHTML = `<div class="mp-orb"></div><h3>Entering the mind…</h3><p>Reading every memory your agent holds.</p>`;
		} else if (kind === 'empty') {
			const chatHref = `/agents/${esc(this.agentId)}`;
			const addCta = this.embedded
				? `<button class="primary" id="mp-empty-add">Add the first memory</button>`
				: `<a class="primary" href="/agents/${esc(this.agentId)}/edit?tab=knowledge">Add the first memory</a>`;
			o.innerHTML = `<div class="mp-orb" style="opacity:.5"></div>
				<h3>This mind is a blank canvas</h3>
				<p>Your agent hasn't formed any memories yet. Talk to it and watch its mind grow — every fact, preference, and lesson becomes an object you can see and shape here.</p>
				<div class="cta"><a class="primary" href="${chatHref}">Start a conversation</a>${addCta}</div>`;
			const add = o.querySelector('#mp-empty-add');
			if (add) add.addEventListener('click', () => {
				this.host.dispatchEvent(new CustomEvent('mind:add-memory', { bubbles: true }));
			});
		} else if (kind === 'error') {
			o.innerHTML = `<h3>The mind is out of reach</h3>
				<p>We couldn't load this agent's memories. This is usually a network hiccup or an expired session.</p>
				<div class="mp-err-detail">${esc(detail)}</div>
				<div class="cta"><button class="primary" id="mp-retry">Try again</button></div>`;
			o.querySelector('#mp-retry').addEventListener('click', () => this.load());
		}
	}
	hideOverlay() { this.el.overlay.hidden = true; this.el.overlay.innerHTML = ''; }

	// ── Teardown ─────────────────────────────────────────────────────────────────

	destroy() {
		this._disposed = true;
		this.stopLoop();
		for (const off of this._busOff) { try { off(); } catch {} }
		this._busOff = [];
		if (this._io) this._io.disconnect();
		window.removeEventListener('resize', this._onResize);
		window.removeEventListener('pointerup', this._onUp);
		if (this.controls) this.controls.dispose();
		if (this.scene) {
			this.scene.traverse((o) => {
				if (o.geometry) o.geometry.dispose();
				if (o.material) { const m = o.material; (Array.isArray(m) ? m : [m]).forEach((x) => x.dispose()); }
			});
		}
		if (this.renderer) { this.renderer.dispose(); this.renderer.forceContextLoss?.(); }
		if (this._reservedCtx) { releaseWebGLContext(); this._reservedCtx = false; }
		if (this.avatarEl?.remove) this.avatarEl.remove();
		this.host.innerHTML = '';
	}
}

// ── small utils ────────────────────────────────────────────────────────────────
function now() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }
function clamp01(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }
function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }
function sharedTags(a, b) {
	const sb = new Set((b.tags || []).map((x) => String(x).toLowerCase()));
	const shared = (a.tags || []).filter((x) => sb.has(String(x).toLowerCase()));
	return shared.length ? '#' + shared.slice(0, 2).map(esc).join(' #') : 'related';
}

export default mountMindPalace;
