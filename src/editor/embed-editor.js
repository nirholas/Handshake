// Embed editor — the "place, scale, preview, copy" UX.
// Lets users drop an <agent-3d> exactly where they want on their actual site.
//
// Usage: import and call mountEmbedEditor(rootEl, { src, defaults }).

import '../element.js'; // ensures <agent-3d> is registered

const POSITIONS = [
	{ id: 'top-left', label: '↖' },
	{ id: 'top-center', label: '↑' },
	{ id: 'top-right', label: '↗' },
	{ id: 'bottom-left', label: '↙' },
	{ id: 'bottom-center', label: '↓' },
	{ id: 'bottom-right', label: '↘' },
];

const MODES = [
	{ id: 'floating', label: 'Floating bubble', hint: 'Fixed corner, follows scroll' },
	{ id: 'inline', label: 'Inline', hint: 'Flows with the page content' },
	{ id: 'section', label: 'Section', hint: 'Fills a container' },
	{ id: 'fullscreen', label: 'Fullscreen', hint: 'Takes over the viewport' },
];

const DEVICES = [
	{ id: 'desktop', label: 'Desktop', w: 1440, h: 900 },
	{ id: 'tablet', label: 'Tablet', w: 768, h: 1024 },
	{ id: 'mobile', label: 'Mobile', w: 390, h: 844 },
];

const RESPONSIVE_PRESETS = [
	{ id: 'fixed', label: 'Fixed', hint: 'Exact px — no scaling' },
	{ id: 'mobile-first', label: 'Mobile-first', hint: 'Grows from mobile min' },
	{ id: 'desktop-first', label: 'Desktop-first', hint: 'Shrinks from preferred size' },
];

// Shown in the preview when the user hasn't entered a `src` yet — so the stage
// always renders an actual avatar instead of an empty box. Not emitted in the
// generated snippet.
const DEFAULT_PREVIEW_SRC = '/avatars/default.glb';

// Pinned <agent-3d> library version emitted in the snippet. Matches package.json
// and the production CDN path documented in /docs/web-component.md.
const AGENT_3D_VERSION = '1.5.1';
const AGENT_3D_HOST = 'https://three.ws';

const BACKGROUNDS = [
	{ id: '', label: 'Default' },
	{ id: 'transparent', label: 'Transparent' },
	{ id: 'dark', label: 'Dark' },
	{ id: 'light', label: 'Light' },
];

// Curated demo avatars surfaced at the top of the picker. URLs match
// api/_lib/demo-avatars.js fixtures (HEAD-checked CC-BY / MIT GLBs). The
// picker prepends these before /api/avatars/public results so the gallery
// always opens to something demo-worthy instead of unnamed user uploads.
const DEMO_AVATARS = [
	{ id: 'demo-cz', name: 'CZ', model_url: '/avatars/cz.glb' },
	{ id: 'demo-default', name: 'Default', model_url: '/avatars/default.glb' },
	{ id: 'demo-robot', name: 'Robot Expressive', model_url: '/animations/robotexpressive.glb' },
	{ id: 'demo-soldier', name: 'Soldier (rigged)', model_url: '/animations/soldier.glb' },
	{ id: 'demo-michelle', name: 'Michelle', model_url: 'https://cdn.jsdelivr.net/gh/mrdoob/three.js/examples/models/gltf/Michelle.glb' },
	{ id: 'demo-xbot', name: 'Xbot', model_url: 'https://cdn.jsdelivr.net/gh/mrdoob/three.js/examples/models/gltf/Xbot.glb' },
	{ id: 'demo-kira', name: 'Kira', model_url: 'https://cdn.jsdelivr.net/gh/mrdoob/three.js/examples/models/gltf/kira.glb' },
	{ id: 'demo-cesium', name: 'Cesium Man', model_url: 'https://cdn.jsdelivr.net/gh/KhronosGroup/glTF-Sample-Assets/Models/CesiumMan/glTF-Binary/CesiumMan.glb' },
];

const STYLE = `
	.editor-root {
		position: fixed;
		inset: 0;
		display: grid;
		grid-template-columns: 1fr 360px;
		grid-template-rows: minmax(0, 1fr);
		background: #0b0d10;
		color: #f4f4f5;
		font: 14px/1.4 system-ui, -apple-system, sans-serif;
		z-index: 1;
	}
	.stage-wrap {
		position: relative;
		overflow: hidden;
		background: #1a1d21;
	}
	.stage-wrap iframe {
		width: 100%;
		height: 100%;
		border: 0;
		background: white;
	}
	/* Dark hero-right mock landing — designed as the video-demo backdrop.
	   Pure black + white type, Linear/Vercel vibe, single radial glow behind
	   the avatar slot. The right half is reserved for the <agent-3d> wrap
	   (placed via the avatar-slot guides). */
	.stage-wrap .placeholder-site {
		position: absolute;
		inset: 0;
		background: #000;
		color: #f5f5f5;
		overflow: auto;
		font: 15px/1.55 -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', system-ui, sans-serif;
		isolation: isolate;
	}
	/* Soft purple→cyan glow + sparkle layer behind where the avatar will sit.
	   Opt-in via the Backdrop glow toggle in the panel — default is no
	   background behind the avatar. Scales with the placeholder so it works
	   in tablet/mobile device frames too. */
	.placeholder-site.has-glow::before {
		content: '';
		position: absolute;
		top: 24%;
		right: 8%;
		width: 620px;
		height: 620px;
		border-radius: 50%;
		background: radial-gradient(closest-side, rgba(139,92,246,0.35), rgba(34,211,238,0.08) 55%, transparent 75%);
		filter: blur(20px);
		pointer-events: none;
		z-index: 0;
	}
	.placeholder-site.has-glow::after {
		content: '';
		position: absolute;
		inset: 0;
		background:
			radial-gradient(1px 1px at 20% 30%, rgba(255,255,255,0.18), transparent 60%),
			radial-gradient(1px 1px at 70% 80%, rgba(255,255,255,0.10), transparent 60%),
			radial-gradient(1px 1px at 40% 70%, rgba(255,255,255,0.10), transparent 60%);
		pointer-events: none;
		z-index: 0;
	}
	.placeholder-site .nav {
		position: relative;
		z-index: 2;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 22px 48px;
		background: rgba(0,0,0,0.5);
		backdrop-filter: blur(10px);
		border-bottom: 1px solid rgba(255,255,255,0.06);
	}
	.placeholder-site .brand {
		display: flex;
		align-items: center;
		gap: 10px;
		font: 600 16px/1 'Inter', system-ui;
		color: #f5f5f5;
		letter-spacing: -0.01em;
	}
	.placeholder-site .brand .logo {
		width: 26px;
		height: 26px;
		border-radius: 7px;
		background: linear-gradient(135deg, #a78bfa 0%, #22d3ee 100%);
		box-shadow: 0 0 24px rgba(167,139,250,0.5);
	}
	.placeholder-site .nav-links {
		display: flex;
		gap: 32px;
		font: 500 13.5px 'Inter', system-ui;
		color: rgba(245,245,245,0.6);
	}
	.placeholder-site .nav-links span { cursor: default; transition: color 0.15s; }
	.placeholder-site .nav-links span:hover { color: #f5f5f5; }
	.placeholder-site .nav-cta {
		background: #f5f5f5;
		color: #000;
		padding: 8px 16px;
		border-radius: 8px;
		font: 600 13px 'Inter', system-ui;
	}

	/* Two-column hero: copy on the left, avatar slot on the right. The slot
	   itself is purely visual (just dictates where the agent-wrap should
	   land); the wrap is positioned absolutely by the editor's mode/position
	   logic, not by this grid. */
	.placeholder-site .hero-grid {
		position: relative;
		z-index: 1;
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		align-items: center;
		gap: 48px;
		max-width: 1240px;
		margin: 0 auto;
		padding: 96px 56px 80px;
		min-height: calc(100vh - 80px);
	}
	.placeholder-site .hero-copy { max-width: 540px; }
	.placeholder-site .pill {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		border-radius: 999px;
		background: rgba(255,255,255,0.06);
		border: 1px solid rgba(255,255,255,0.10);
		color: rgba(245,245,245,0.85);
		font: 500 12px 'Inter', system-ui;
		letter-spacing: 0.01em;
		margin-bottom: 28px;
	}
	.placeholder-site .pill .dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #22d3ee;
		box-shadow: 0 0 10px #22d3ee;
	}
	.placeholder-site h1 {
		font: 700 58px/1.05 'Inter', system-ui;
		letter-spacing: -0.035em;
		margin: 0 0 22px;
		color: #fafafa;
	}
	.placeholder-site h1 .muted {
		color: rgba(245,245,245,0.45);
	}
	.placeholder-site p.lede {
		font-size: 17px;
		color: rgba(245,245,245,0.62);
		max-width: 460px;
		margin: 0 0 36px;
		line-height: 1.6;
	}
	.placeholder-site .cta-row {
		display: flex;
		gap: 10px;
		align-items: center;
	}
	.placeholder-site .btn-primary {
		background: #f5f5f5;
		color: #000;
		padding: 13px 22px;
		border-radius: 10px;
		font: 600 14px 'Inter', system-ui;
		letter-spacing: -0.005em;
		transition: transform 0.1s;
	}
	.placeholder-site .btn-primary:hover { transform: translateY(-1px); }
	.placeholder-site .btn-ghost {
		color: rgba(245,245,245,0.85);
		padding: 13px 22px;
		border-radius: 10px;
		font: 600 14px 'Inter', system-ui;
		border: 1px solid rgba(255,255,255,0.14);
		background: transparent;
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.placeholder-site .btn-ghost:hover { background: rgba(255,255,255,0.04); }

	/* Empty right column — the avatar wrap floats over this area via the
	   editor's positioning logic. Faint corner guides hint where it'll land. */
	.placeholder-site .hero-slot {
		position: relative;
		height: 620px;
	}

	.placeholder-site .stats {
		position: relative;
		z-index: 1;
		max-width: 1240px;
		margin: 0 auto;
		padding: 0 56px 80px;
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 32px;
		border-top: 1px solid rgba(255,255,255,0.06);
		padding-top: 56px;
	}
	.placeholder-site .stat .num {
		font: 700 32px/1 'Inter', system-ui;
		letter-spacing: -0.02em;
		color: #fafafa;
		margin-bottom: 6px;
	}
	.placeholder-site .stat .label {
		font: 500 12.5px 'Inter', system-ui;
		color: rgba(245,245,245,0.55);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	.agent-wrap {
		position: absolute;
		cursor: grab;
		user-select: none;
		touch-action: none;
		overflow: hidden;
		border-radius: 12px;
		box-shadow: 0 8px 32px rgba(0,0,0,0.35);
		background: transparent;
	}
	.agent-wrap.dragging { cursor: grabbing; }
	.agent-wrap agent-3d {
		position: absolute;
		inset: 0;
		width: 100% !important;
		height: 100% !important;
		display: block;
	}
	.agent-wrap iframe.widget-frame {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		border: 0;
		display: block;
		background: transparent;
	}
	.widget-badge {
		position: absolute;
		top: -28px;
		right: 0;
		background: #1e293b;
		color: #a7f3d0;
		font: 11px/1 ui-monospace, Menlo, monospace;
		padding: 4px 8px;
		border-radius: 4px;
		border: 1px solid #334155;
	}
	.size-readout {
		position: absolute;
		top: -28px;
		left: 0;
		background: #111827;
		color: #f9fafb;
		font: 11px/1 monospace;
		padding: 4px 6px;
		border-radius: 4px;
	}

	.anim-dock {
		position: absolute;
		left: 50%;
		bottom: 20px;
		transform: translateX(-50%);
		display: flex;
		gap: 6px;
		padding: 7px;
		background: rgba(10, 12, 16, 0.78);
		border: 1px solid rgba(255,255,255,0.08);
		border-radius: 999px;
		backdrop-filter: blur(20px);
		-webkit-backdrop-filter: blur(20px);
		box-shadow: 0 20px 50px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.02) inset;
		z-index: 5;
		max-width: calc(100% - 32px);
	}
	.anim-dock[hidden] { display: none; }
	.anim-chip {
		flex: 0 0 auto;
		background: rgba(255,255,255,0.04);
		color: rgba(245,245,245,0.85);
		border: 1px solid transparent;
		border-radius: 999px;
		padding: 8px 14px;
		font: 500 13px 'Inter', system-ui;
		letter-spacing: -0.005em;
		cursor: pointer;
		white-space: nowrap;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		transition: background 0.15s, color 0.15s, transform 0.1s;
	}
	.anim-chip:hover {
		background: rgba(255,255,255,0.09);
		color: #fff;
		transform: translateY(-1px);
	}
	.anim-chip[aria-pressed="true"] {
		background: linear-gradient(135deg, #a78bfa 0%, #22d3ee 100%);
		color: #0a0c10;
		font-weight: 600;
		box-shadow: 0 0 24px rgba(139,92,246,0.45);
	}
	.anim-chip[aria-pressed="true"] .icon { transform: scale(1.15); }
	.anim-chip[aria-pressed="true"]::after {
		content: '';
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: #0a0c10;
		animation: anim-chip-pulse 1.4s ease-in-out infinite;
		margin-left: 2px;
	}
	@keyframes anim-chip-pulse {
		0%, 100% { opacity: 1; transform: scale(1); }
		50% { opacity: 0.35; transform: scale(0.7); }
	}
	.anim-chip .icon { font-size: 15px; line-height: 1; transition: transform 0.2s; }
	.anim-chip .kbd {
		font: 500 10px ui-monospace, Menlo, monospace;
		color: rgba(245,245,245,0.4);
		background: rgba(255,255,255,0.06);
		padding: 1px 5px;
		border-radius: 4px;
		margin-left: 2px;
	}
	.anim-chip[aria-pressed="true"] .kbd { display: none; }
	.anim-chip.more {
		background: transparent;
		color: rgba(245,245,245,0.55);
		border-color: rgba(255,255,255,0.10);
	}
	.anim-chip.more:hover { color: #fff; background: rgba(255,255,255,0.05); }

	/* Animation library modal — full categorized list. */
	.anim-modal { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; }
	.anim-modal[hidden] { display: none; }
	.anim-modal-backdrop { position: absolute; inset: 0; background: rgba(2,6,23,0.7); backdrop-filter: blur(4px); }
	.anim-modal-card {
		position: relative;
		width: min(720px, 92vw);
		max-height: 80vh;
		background: #0a0c10;
		border: 1px solid rgba(255,255,255,0.08);
		border-radius: 16px;
		box-shadow: 0 24px 60px rgba(0,0,0,0.6);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.anim-modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 18px 22px;
		border-bottom: 1px solid rgba(255,255,255,0.06);
	}
	.anim-modal-header h3 { font: 700 17px 'Inter', system-ui; margin: 0; color: #fafafa; }
	.anim-modal-close {
		background: transparent;
		border: 0;
		color: rgba(245,245,245,0.55);
		font-size: 22px;
		line-height: 1;
		cursor: pointer;
		padding: 4px 8px;
		border-radius: 6px;
	}
	.anim-modal-close:hover { background: rgba(255,255,255,0.06); color: #fff; }
	.anim-modal-body { padding: 20px 22px 24px; overflow-y: auto; }
	.anim-cat-title {
		font: 600 11px 'Inter', system-ui;
		color: rgba(245,245,245,0.5);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		margin: 12px 0 10px;
	}
	.anim-cat-title:first-child { margin-top: 0; }
	.anim-cat-grid { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
	.anim-cat-grid .anim-chip { padding: 6px 12px; font-size: 12.5px; }

	.snapline {
		position: absolute;
		background: #3b82f6;
		opacity: 0.6;
		pointer-events: none;
	}
	.snapline.v { width: 1px; top: 0; bottom: 0; }
	.snapline.h { height: 1px; left: 0; right: 0; }

	.panel {
		background: #0f1216;
		border-left: 1px solid #1f2937;
		display: flex;
		flex-direction: column;
		min-height: 0;
		overflow: hidden;
	}
	.panel-header {
		padding: 16px 20px;
		border-bottom: 1px solid #1f2937;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.panel-header h2 { font: 600 16px system-ui; }
	.panel-body { padding: 16px 20px; overflow-y: auto; flex: 1; }
	.section-title { font: 600 11px system-ui; letter-spacing: 0.08em; text-transform: uppercase; color: #9ca3af; margin: 16px 0 8px; }

	.mode-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
	.mode-card {
		padding: 10px 12px;
		border-radius: 10px;
		background: #111827;
		border: 1px solid #1f2937;
		cursor: pointer;
		transition: border-color 0.15s;
	}
	.mode-card:hover { border-color: #3b82f6; }
	.mode-card[aria-pressed="true"] { border-color: #3b82f6; background: #1e293b; }
	.mode-card .ml { font-weight: 600; margin-bottom: 2px; }
	.mode-card .mh { font-size: 12px; color: #9ca3af; }

	.pos-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 6px;
	}
	.pos-btn {
		aspect-ratio: 1.8;
		background: #111827;
		border: 1px solid #1f2937;
		color: #9ca3af;
		border-radius: 8px;
		font-size: 18px;
		cursor: pointer;
	}
	.pos-btn[aria-pressed="true"] { background: #3b82f6; color: white; border-color: #3b82f6; }

	/* Avatar trigger button in the panel — opens the modal. Replaces the
	   inline grid so the panel stays light and no GLBs load on page boot. */
	.avatar-trigger {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 8px 10px;
		margin: 4px 0 12px;
		background: #111827;
		border: 1px solid #1f2937;
		border-radius: 10px;
		color: #f4f4f5;
		cursor: pointer;
		text-align: left;
		font: 500 13px system-ui;
		transition: border-color 0.15s, background 0.15s;
	}
	.avatar-trigger:hover { border-color: #3b82f6; background: #1e293b; }
	.avatar-trigger-thumb {
		flex: 0 0 36px;
		width: 36px;
		height: 36px;
		border-radius: 8px;
		background: linear-gradient(135deg, #1e3a8a, #581c87);
		background-size: cover;
		background-position: center;
		border: 1px solid #334155;
	}
	.avatar-trigger-text { flex: 1; min-width: 0; line-height: 1.25; }
	.avatar-trigger-name { display: block; font-weight: 600; }
	.avatar-trigger-hint { display: block; font-size: 11px; color: #9ca3af; }
	.avatar-trigger-chev { color: #6b7280; font-size: 18px; line-height: 1; }

	/* Modal — backdrop + centered card. Lazy-fetches the list when opened
	   (not on init) and uses <model-viewer loading="lazy"> per card so only
	   visible thumbnails actually boot a WebGL context. */
	.avatar-modal {
		position: fixed;
		inset: 0;
		z-index: 1000;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.avatar-modal[hidden] { display: none; }
	.avatar-modal-backdrop {
		position: absolute;
		inset: 0;
		background: rgba(2, 6, 23, 0.7);
		backdrop-filter: blur(4px);
	}
	.avatar-modal-card {
		position: relative;
		width: min(960px, 92vw);
		max-height: 86vh;
		background: #0f1216;
		border: 1px solid #1f2937;
		border-radius: 14px;
		box-shadow: 0 24px 60px rgba(0,0,0,0.55);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.avatar-modal-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		padding: 18px 22px;
		border-bottom: 1px solid #1f2937;
	}
	.avatar-modal-header h3 { font: 700 17px/1.2 system-ui; margin: 0 0 4px; color: #f4f4f5; }
	.avatar-modal-sub { font: 13px system-ui; color: #9ca3af; margin: 0; }
	.avatar-modal-close {
		background: transparent;
		border: 0;
		color: #9ca3af;
		font-size: 22px;
		line-height: 1;
		cursor: pointer;
		padding: 4px 8px;
		border-radius: 6px;
	}
	.avatar-modal-close:hover { background: #1f2937; color: #f4f4f5; }
	.avatar-modal-body { padding: 18px 22px; overflow-y: auto; }

	.avatar-picker-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
		gap: 12px;
	}
	.avatar-card {
		position: relative;
		aspect-ratio: 1;
		background: linear-gradient(135deg, #1e293b, #0f172a);
		background-size: cover;
		background-position: center;
		border: 1px solid #1f2937;
		border-radius: 10px;
		cursor: pointer;
		overflow: hidden;
		transition: border-color 0.15s, transform 0.1s;
	}
	.avatar-card model-viewer {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		--poster-color: transparent;
		background: transparent;
	}
	.avatar-card:hover { border-color: #3b82f6; transform: translateY(-1px); }
	.avatar-card[aria-pressed="true"] { border-color: #22c55e; box-shadow: 0 0 0 2px rgba(34,197,94,0.3); }
	.avatar-card.pinned {
		background: linear-gradient(135deg, #1e3a8a 0%, #581c87 100%);
	}
	.avatar-card .tag {
		position: absolute;
		top: 4px;
		right: 4px;
		padding: 2px 6px;
		font: 600 9px system-ui;
		color: #c7d2fe;
		background: rgba(15,23,42,0.85);
		border: 1px solid rgba(199,210,254,0.3);
		border-radius: 4px;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}
	.avatar-card .name {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		padding: 4px 6px;
		font: 500 10px/1.2 system-ui;
		color: #f4f4f5;
		background: linear-gradient(transparent, rgba(0,0,0,0.85));
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.avatar-card.skeleton { background: #111827; animation: skeleton-pulse 1.2s ease-in-out infinite; }
	@keyframes skeleton-pulse { 50% { opacity: 0.4; } }
	.avatar-picker-more {
		width: 100%;
		margin-top: 6px;
		background: transparent;
		border: 1px solid #1f2937;
		color: #9ca3af;
		border-radius: 6px;
		padding: 6px 8px;
		font: 500 12px system-ui;
		cursor: pointer;
	}
	.avatar-picker-more:hover { color: #f4f4f5; border-color: #334155; }
	.avatar-picker-empty {
		text-align: center;
		color: #6b7280;
		font: 12px system-ui;
		padding: 12px;
	}

	.field-row { display: grid; grid-template-columns: 80px 1fr; gap: 8px; align-items: center; margin: 6px 0; }
	.field-row label { color: #9ca3af; font-size: 12px; }
	.field-row input, .field-row select {
		background: #111827;
		color: #f4f4f5;
		border: 1px solid #1f2937;
		border-radius: 6px;
		padding: 6px 8px;
		font: 13px system-ui;
		width: 100%;
		box-sizing: border-box;
	}

	.snippet-box {
		background: #0a0d12;
		border: 1px solid #1f2937;
		border-radius: 10px;
		padding: 12px;
		font: 12px/1.5 ui-monospace, Menlo, monospace;
		white-space: pre-wrap;
		word-break: break-all;
		color: #a7f3d0;
		margin-top: 12px;
		max-height: 200px;
		overflow-y: auto;
		transition: max-height 0.2s ease;
	}
	.snippet-box.collapsed {
		max-height: 56px;
		overflow: hidden;
		position: relative;
	}
	.snippet-box.collapsed::after {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: 24px;
		background: linear-gradient(transparent, #0a0d12);
		pointer-events: none;
	}
	.snippet-collapse {
		background: transparent;
		border: 0;
		color: #6b7280;
		font: 500 11px system-ui;
		cursor: pointer;
		padding: 6px 0 0;
		text-align: left;
	}
	.snippet-collapse:hover { color: #e5e7eb; }
	.actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
	.btn {
		flex: 1 1 auto;
		background: #3b82f6;
		color: white;
		border: 0;
		border-radius: 8px;
		padding: 10px 12px;
		font: 600 14px system-ui;
		cursor: pointer;
		min-width: 0;
	}
	.btn.secondary { background: transparent; border: 1px solid #1f2937; color: #e5e7eb; }
	.btn:hover { filter: brightness(1.1); }
	.btn[data-copied="true"] { background: #22c55e; }

	.toast {
		position: fixed;
		bottom: 24px;
		left: 50%;
		transform: translate(-50%, 24px);
		background: #0f172a;
		color: #f4f4f5;
		padding: 10px 18px;
		border-radius: 999px;
		font: 600 13px system-ui;
		box-shadow: 0 12px 32px rgba(0,0,0,0.45);
		border: 1px solid #1f2937;
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.2s, transform 0.2s;
		z-index: 100;
	}
	.toast.visible {
		opacity: 1;
		transform: translate(-50%, 0);
	}
	.toast[data-kind="warn"] {
		background: #78350f;
		border-color: #b45309;
		color: #fef3c7;
	}

	.preview-url-row {
		display: flex;
		gap: 6px;
		padding: 10px 16px;
		background: #0f1216;
		border-bottom: 1px solid #1f2937;
	}
	.preview-url-row input {
		flex: 1;
		background: #111827;
		border: 1px solid #1f2937;
		color: #e5e7eb;
		padding: 6px 10px;
		border-radius: 6px;
	}
	.preview-url-row button { background: #3b82f6; color: white; border: 0; border-radius: 6px; padding: 6px 12px; cursor: pointer; }

	.stage-col { display: flex; flex-direction: column; overflow: hidden; }
	.stage-wrap { flex: 1; position: relative; overflow: hidden; background: #1a1d21; }

	.device-bar {
		display: flex;
		gap: 4px;
		padding: 6px 16px;
		background: #0b0d10;
		border-bottom: 1px solid #1f2937;
		align-items: center;
	}
	.device-bar span { font: 11px system-ui; color: #6b7280; margin-right: 4px; }
	.device-btn {
		padding: 3px 10px;
		border-radius: 6px;
		border: 1px solid #1f2937;
		background: #111827;
		color: #9ca3af;
		cursor: pointer;
		font: 12px system-ui;
	}
	.device-btn[aria-pressed="true"] { background: #3b82f6; color: white; border-color: #3b82f6; }

	/* Preview mode — hide chrome, let the wrap render where it would on a real site */
	.editor-root[data-preview="true"] { grid-template-columns: 1fr 0; }
	.editor-root[data-preview="true"] .panel { display: none; }
	.editor-root[data-preview="true"] .preview-url-row,
	.editor-root[data-preview="true"] .device-bar { display: none; }
	.editor-root[data-preview="true"] .agent-wrap { cursor: default; }
	.editor-root[data-preview="true"] .agent-wrap .size-readout,
	.editor-root[data-preview="true"] .agent-wrap .widget-badge { display: none; }
	.exit-preview {
		position: fixed;
		top: 16px;
		left: 16px;
		z-index: 10;
		background: #111827;
		color: #f4f4f5;
		border: 1px solid #1f2937;
		border-radius: 999px;
		padding: 8px 14px;
		font: 600 13px system-ui;
		cursor: pointer;
		box-shadow: 0 4px 16px rgba(0,0,0,0.4);
		display: none;
	}
	.editor-root[data-preview="true"] .exit-preview { display: inline-flex; align-items: center; gap: 6px; }
	.exit-preview:hover { background: #1e293b; }
	.preview-toggle {
		background: #1e293b;
		color: #a7f3d0;
		border: 1px solid #334155;
		border-radius: 999px;
		padding: 4px 12px;
		font: 600 12px system-ui;
		cursor: pointer;
		margin-right: 8px;
	}
	.preview-toggle:hover { background: #334155; }
	.lock-toggle {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		background: #1e293b;
		color: #cbd5e1;
		border: 1px solid #334155;
		border-radius: 999px;
		padding: 4px 10px 4px 8px;
		font: 600 12px system-ui;
		cursor: pointer;
	}
	.lock-toggle:hover { background: #334155; }
	.lock-toggle[aria-pressed="true"] {
		background: #b45309;
		color: #fef3c7;
		border-color: #d97706;
	}
	.lock-toggle .lock-icon { font-size: 13px; line-height: 1; }

	/* Locked mode — disables drag/resize on the wrap and signals the state. */
	.editor-root[data-locked="true"] .agent-wrap { cursor: not-allowed; }
	.editor-root[data-locked="true"] .agent-wrap .size-readout {
		background: #b45309;
		color: #fef3c7;
	}
	.editor-root[data-locked="true"] .agent-wrap .size-readout::before {
		content: '🔒 ';
	}

	/* Device viewport — wraps placeholder/iframe/agent-wrap so they scale
	   together when simulating tablet/mobile. In desktop mode fills the stage. */
	.device-viewport {
		position: absolute;
		inset: 0;
		transform-origin: top left;
		transition: transform 0.2s, width 0.2s, height 0.2s;
	}
	.device-viewport[data-device="tablet"],
	.device-viewport[data-device="mobile"] {
		inset: auto;
		background: white;
		box-shadow: 0 0 0 2px #374151, 0 12px 40px rgba(0,0,0,0.5);
		border-radius: 12px;
		overflow: hidden;
	}
	.device-viewport .placeholder-site,
	.device-viewport > iframe { position: absolute; inset: 0; width: 100%; height: 100%; }
`;

export function mountEmbedEditor(root, options = {}) {
	const defaults = {
		widgetId: options.widgetId || '',
		src: options.src || '',
		mode: options.mode || 'floating',
		// Hero-right placement by default — sized for the video demo's
		// in-editor mock landing (~40% of a 1440px viewport). Users can drag
		// or resize from here; "Reset" returns to these dimensions.
		position: options.position || 'top-right',
		offset: options.offset || '120px 80px',
		width: options.width || '440px',
		height: options.height || '620px',
		device: 'desktop',
		responsivePreset: 'desktop-first',
		voice: true,
		cameraControls: false,
		ar: false,
		// "Just the 3D avatar" is the default: kiosk on (chat hidden), background
		// transparent. Users opt into the chat UI / coloured background via the
		// Options panel.
		showChat: false,
		background: 'transparent',
		// Opt-in purple→cyan glow on the preview backdrop. Off by default so
		// the avatar reads against the plain hero — toggle from the Backdrop
		// glow select in the Options panel. Preview-only, not exported.
		glow: false,
		// New customization options
		defaultClip: '',
		defaultClipLoop: true,
		accentColor: '#3b82f6',
		namePlate: 'on',
		agentId: '',
		borderRadius: '16px',
		...options,
	};

	const state = { ...defaults, widget: null };
	const host = document.createElement('div');
	const shadow = host.attachShadow({ mode: 'open' });
	root.appendChild(host);

	shadow.innerHTML = `
		<style>${STYLE}</style>
		<div class="editor-root">
			<div class="stage-col">
				<div class="preview-url-row">
					<input type="text" placeholder="Paste your site URL to preview in-place (optional)" id="url-input">
					<button id="url-load">Load site</button>
					<button id="url-clear">Reset</button>
				</div>
				<div class="device-bar" id="device-bar">
					<span>Preview:</span>
				</div>
				<div class="stage-wrap" id="stage">
					<div class="device-viewport" id="device-viewport">
					<div class="placeholder-site" id="placeholder">
						<nav class="nav">
							<div class="brand"><div class="logo"></div>three.ws</div>
							<div class="nav-links"><span>Product</span><span>Studio</span><span>Docs</span><span>Customers</span></div>
							<div class="nav-cta">Start</div>
						</nav>
						<div class="hero-grid">
							<div class="hero-copy">
								<div class="pill"><span class="dot"></span> Live · Now in beta</div>
								<h1>Your agent. <br><span class="muted">On any page.</span></h1>
								<p class="lede">Drop a 3D agent into any site in 30 seconds. Voice, text, payments, identity — yours, wherever your visitors are.</p>
								<div class="cta-row">
									<div class="btn-primary">Get started →</div>
									<div class="btn-ghost">Watch demo</div>
								</div>
							</div>
							<div class="hero-slot"></div>
						</div>
						<div class="stats">
							<div class="stat"><div class="num">30s</div><div class="label">Time to embed</div></div>
							<div class="stat"><div class="num">100%</div><div class="label">Yours, onchain</div></div>
							<div class="stat"><div class="num">12+</div><div class="label">Animations</div></div>
							<div class="stat"><div class="num">x402</div><div class="label">Native payments</div></div>
						</div>
					</div>
					<iframe id="preview-frame" hidden></iframe>
					<div class="agent-wrap" id="agent-wrap">
						<div class="size-readout" id="size-readout"></div>
						<div class="widget-badge" id="widget-badge" hidden></div>
						<iframe class="widget-frame" id="widget-frame" hidden
							allow="autoplay; clipboard-write; microphone; camera; xr-spatial-tracking"></iframe>
						<agent-3d eager kiosk name-plate="off" id="preview-agent"></agent-3d>
					</div>
					</div>
					<div class="anim-dock" id="anim-dock" hidden></div>
				</div>
			</div>
			<button class="exit-preview" id="exit-preview" type="button">← Back to editor</button>
			<aside class="panel">
				<div class="panel-header">
					<h2>Embed editor</h2>
					<div style="display:flex;align-items:center;gap:8px">
						<button class="lock-toggle" id="lock-toggle" type="button" title="Lock the box and freeze avatar motion (L)" aria-pressed="false">
							<span class="lock-icon" aria-hidden="true">🔓</span>
							<span class="lock-label">Lock</span>
						</button>
						<button class="preview-toggle" id="preview-toggle" type="button">Preview</button>
						<span style="font-size:11px;color:#6b7280">beta</span>
					</div>
				</div>
				<div class="panel-body">
					<div class="section-title">Source</div>
					<div class="field-row">
						<label>src</label>
						<input id="src-input" placeholder="agent://base/42 or ipfs://...">
					</div>
					<button class="avatar-trigger" id="avatar-trigger" type="button">
						<span class="avatar-trigger-thumb" id="avatar-trigger-thumb" aria-hidden="true"></span>
						<span class="avatar-trigger-text">
							<span class="avatar-trigger-name" id="avatar-trigger-name">Browse avatars</span>
							<span class="avatar-trigger-hint">Click to choose a different model</span>
						</span>
						<span class="avatar-trigger-chev" aria-hidden="true">›</span>
					</button>

					<div class="section-title">Mode</div>
					<div class="mode-grid" id="mode-grid"></div>

					<div class="section-title" id="pos-title">Position</div>
					<div class="pos-grid" id="pos-grid"></div>

					<div class="section-title">Size</div>
					<div class="field-row">
						<label>Width</label>
						<input id="w-input" value="${state.width}">
					</div>
					<div class="field-row">
						<label>Height</label>
						<input id="h-input" value="${state.height}">
					</div>

					<div class="section-title">Responsive</div>
					<div class="field-row">
						<label>Preset</label>
						<select id="responsive-select">
							<option value="fixed">Fixed (exact px)</option>
							<option value="mobile-first">Mobile-first (clamp, grows)</option>
							<option value="desktop-first">Desktop-first (clamp, shrinks)</option>
						</select>
					</div>

					<div class="section-title">Options</div>
					<div class="field-row">
						<label>Chat UI</label>
						<select id="chat-select">
							<option value="off">Hidden (just avatar)</option>
							<option value="on">Show chat panel</option>
						</select>
					</div>
					<div class="field-row">
						<label>Voice</label>
						<select id="voice-select">
							<option value="">on (default)</option>
							<option value="off">off</option>
						</select>
					</div>
					<div class="field-row">
						<label>Camera</label>
						<select id="camera-select">
							<option value="off">controls off</option>
							<option value="on">controls on</option>
						</select>
					</div>
					<div class="field-row">
						<label>AR</label>
						<select id="ar-select">
							<option value="off">off</option>
							<option value="on">on</option>
						</select>
					</div>
					<div class="field-row">
						<label>Background</label>
						<select id="bg-select">
							<option value="transparent">Transparent</option>
							<option value="dark">Dark</option>
							<option value="light">Light</option>
						</select>
					</div>
					<div class="field-row">
						<label>Backdrop glow</label>
						<select id="glow-select">
							<option value="off">Off (no background)</option>
							<option value="on">Purple → cyan glow</option>
						</select>
					</div>

					<div class="section-title">Identity &amp; Agent</div>
					<div class="field-row">
						<label>Agent ID</label>
						<input id="agent-id-input" placeholder="Optional — connects to AI brain">
					</div>
					<div class="field-row">
						<label>Name plate</label>
						<select id="nameplate-select">
							<option value="on">Visible</option>
							<option value="off">Hidden</option>
						</select>
					</div>

					<div class="section-title">Animation</div>
					<div class="field-row">
						<label>Default</label>
						<select id="default-clip-select">
							<option value="">None (idle)</option>
						</select>
					</div>
					<div class="field-row">
						<label>Loop</label>
						<select id="default-clip-loop">
							<option value="true">Loop indefinitely</option>
							<option value="false">Play once</option>
						</select>
					</div>

					<div class="section-title">Styling</div>
					<div class="field-row">
						<label>Accent color</label>
						<div style="display:flex;gap:6px;align-items:center;flex:1">
							<input type="color" id="accent-color-input" value="#3b82f6" style="flex:1;height:32px;cursor:pointer">
							<button id="accent-reset-btn" class="btn secondary" type="button" style="padding:4px 8px;font-size:11px;flex:0 0 auto">↺</button>
						</div>
					</div>
					<div class="field-row">
						<label>Border radius</label>
						<input id="radius-input" type="text" placeholder="16px">
					</div>

					<div class="section-title">Embed snippet</div>
					<div class="snippet-box collapsed" id="snippet"></div>
					<button class="snippet-collapse" id="snippet-collapse" type="button">Show full snippet ▾</button>
					<div class="actions">
						<button class="btn" id="copy-btn" type="button">Copy snippet</button>
						<button class="btn secondary" id="open-btn" type="button" title="Render the snippet against a demo page in a new tab">Open in new tab</button>
						<button class="btn secondary" id="reset-btn" type="button">Reset</button>
					</div>
					<div class="toast" id="toast" role="status" aria-live="polite"></div>
				</div>
			</aside>
		</div>
		<div class="avatar-modal" id="avatar-modal" hidden role="dialog" aria-modal="true" aria-labelledby="avatar-modal-title">
			<div class="avatar-modal-backdrop" id="avatar-modal-backdrop"></div>
			<div class="avatar-modal-card">
				<header class="avatar-modal-header">
					<div>
						<h3 id="avatar-modal-title">Choose an avatar</h3>
						<p class="avatar-modal-sub">Click any preview to load it in the embed.</p>
					</div>
					<button class="avatar-modal-close" id="avatar-modal-close" type="button" aria-label="Close (Esc)">✕</button>
				</header>
				<div class="avatar-modal-body" id="avatar-modal-body">
					<div class="avatar-picker-grid" id="avatar-grid"></div>
					<button class="avatar-picker-more" id="avatar-more" type="button" hidden>Load more</button>
					<div class="avatar-picker-empty" id="avatar-empty" hidden>No public avatars found.</div>
				</div>
			</div>
		</div>
		<div class="anim-modal" id="anim-modal" hidden role="dialog" aria-modal="true" aria-labelledby="anim-modal-title">
			<div class="anim-modal-backdrop" id="anim-modal-backdrop"></div>
			<div class="anim-modal-card">
				<header class="anim-modal-header">
					<h3 id="anim-modal-title">Animation library</h3>
					<button class="anim-modal-close" id="anim-modal-close" type="button" aria-label="Close (Esc)">✕</button>
				</header>
				<div class="anim-modal-body" id="anim-modal-body"></div>
			</div>
		</div>
	`;

	const $ = (sel) => shadow.querySelector(sel);
	const $$ = (sel) => shadow.querySelectorAll(sel);

	// Device preview buttons
	const deviceBar = $('#device-bar');
	for (const d of DEVICES) {
		const btn = document.createElement('button');
		btn.className = 'device-btn';
		btn.dataset.device = d.id;
		btn.setAttribute('aria-pressed', String(d.id === state.device));
		btn.textContent = d.label;
		btn.addEventListener('click', () => {
			state.device = d.id;
			syncDevice();
			writeSnippet();
		});
		deviceBar.appendChild(btn);
	}

	const stage = $('#stage');
	const agentWrap = $('#agent-wrap');
	const agentEl = $('#preview-agent');
	const widgetFrame = $('#widget-frame');
	const widgetBadge = $('#widget-badge');
	const readout = $('#size-readout');
	const snippetEl = $('#snippet');
	const srcInput = $('#src-input');
	const wInput = $('#w-input');
	const hInput = $('#h-input');
	const copyBtn = $('#copy-btn');

	srcInput.value = state.src;
	agentEl.setAttribute('src', state.src || DEFAULT_PREVIEW_SRC);

	const animDock = $('#anim-dock');
	const animModal = $('#anim-modal');
	const animModalBody = $('#anim-modal-body');
	const animModalBackdrop = $('#anim-modal-backdrop');
	const animModalClose = $('#anim-modal-close');

	// Curated chips visible in the always-on dock — ordered for video impact.
	// Only ones present in the loaded model's clip list are shown; the rest
	// of the library lives behind the "+ More" chip in the modal.
	const FEATURED_CLIPS = ['downdog', 'wave', 'dance', 'thriller', 'celebrate', 'kiss', 'jump'];

	// Pose the avatar holds when the editor first opens — looped so the rig
	// settles on a recognizable yoga frame instead of the procedural idle drift.
	const DEFAULT_POSE = 'downdog';

	// Buckets for the modal. Names not matched here fall into "Other".
	const CLIP_CATEGORIES = [
		{ title: 'Yoga & poses', match: /^(downdog)$/ },
		{ title: 'Greetings & social', match: /^(wave|kiss|pray|sitclap|sitlaugh|taunt|silly|reaction)$/ },
		{ title: 'Dances', match: /^(dance|rumba|thriller|capoeira|hiphop)$/ },
		{ title: 'Reactions', match: /^(celebrate|angry|defeated|reaction)$/ },
		{ title: 'Locomotion', match: /^(walk|jump|stepback|dodge|removing)$/ },
		{ title: 'Falls & combat', match: /^(falling|dying|shoved|falltolanding|jumpdown|jumpdown2|jumpdown3)$/ },
		{ title: 'Sports', match: /^(header|goalkeeper|coverstand)$/ },
		{ title: 'Idle & standing', match: /^(idle|standup)$/ },
	];

	// Live registry of every chip rendered (dock + modal) keyed by clip name,
	// so playing a clip can sync aria-pressed across both surfaces at once.
	let chipsByName = new Map();
	function setActiveClip(name) {
		state.activeClip = name;
		for (const [n, chips] of chipsByName) {
			const pressed = String(n === name);
			for (const c of chips) c.setAttribute('aria-pressed', pressed);
		}
	}
	function playClip(clip) {
		setActiveClip(clip.name);
		agentEl.play?.(clip.name, { loop: clip.loop !== false, fade_ms: 250 });
	}

	function makeChip(clip, { shortcut, withKbd = false, extraClass = '' } = {}) {
		const chip = document.createElement('button');
		chip.type = 'button';
		chip.className = 'anim-chip' + (extraClass ? ' ' + extraClass : '');
		chip.dataset.name = clip.name;
		chip.setAttribute('aria-pressed', String(state.activeClip === clip.name));
		const kbdHtml = withKbd && shortcut ? `<span class="kbd">${shortcut}</span>` : '';
		chip.innerHTML = `<span class="icon">${clip.icon || '✨'}</span><span>${clip.label || clip.name}</span>${kbdHtml}`;
		chip.addEventListener('click', () => playClip(clip));
		if (!chipsByName.has(clip.name)) chipsByName.set(clip.name, []);
		chipsByName.get(clip.name).push(chip);
		return chip;
	}

	function openAnimModal() {
		animModal.hidden = false;
	}
	function closeAnimModal() {
		animModal.hidden = true;
	}
	animModalClose.addEventListener('click', closeAnimModal);
	animModalBackdrop.addEventListener('click', closeAnimModal);

	function renderAnimDock() {
		if (state.widgetId) { animDock.hidden = true; return; }
		const clips = (typeof agentEl._listAvailableClips === 'function')
			? agentEl._listAvailableClips()
			: [];
		if (!clips.length) { animDock.hidden = true; return; }

		chipsByName = new Map();
		animDock.replaceChildren();
		animModalBody.replaceChildren();

		const byName = new Map(clips.map((c) => [c.name, c]));

		// 1. Featured chips in the dock — in declared order, skipping any that
		//    the current model doesn't expose.
		let shortcutIdx = 1;
		for (const name of FEATURED_CLIPS) {
			const clip = byName.get(name);
			if (!clip) continue;
			animDock.appendChild(makeChip(clip, { shortcut: String(shortcutIdx), withKbd: true }));
			shortcutIdx++;
			if (shortcutIdx > 6) break;
		}

		// 2. "+ More" chip if there are clips not shown in the featured row.
		const extraClips = clips.filter((c) => !FEATURED_CLIPS.includes(c.name));
		if (extraClips.length || clips.length > shortcutIdx - 1) {
			const more = document.createElement('button');
			more.type = 'button';
			more.className = 'anim-chip more';
			more.innerHTML = `<span class="icon">✨</span><span>More</span>`;
			more.title = 'Open animation library (A)';
			more.addEventListener('click', openAnimModal);
			animDock.appendChild(more);
		}

		// 3. Modal contents — every clip categorized.
		for (const cat of CLIP_CATEGORIES) {
			const inCat = clips.filter((c) => cat.match.test(c.name));
			if (!inCat.length) continue;
			const title = document.createElement('div');
			title.className = 'anim-cat-title';
			title.textContent = cat.title;
			const grid = document.createElement('div');
			grid.className = 'anim-cat-grid';
			for (const clip of inCat) grid.appendChild(makeChip(clip));
			animModalBody.appendChild(title);
			animModalBody.appendChild(grid);
		}
		// Any clip not matched by a category goes into "Other".
		const matched = new Set(
			CLIP_CATEGORIES.flatMap((cat) => clips.filter((c) => cat.match.test(c.name)).map((c) => c.name)),
		);
		const other = clips.filter((c) => !matched.has(c.name));
		if (other.length) {
			const title = document.createElement('div');
			title.className = 'anim-cat-title';
			title.textContent = 'Other';
			const grid = document.createElement('div');
			grid.className = 'anim-cat-grid';
			for (const clip of other) grid.appendChild(makeChip(clip));
			animModalBody.appendChild(title);
			animModalBody.appendChild(grid);
		}

		animDock.hidden = false;
	}
	agentEl.addEventListener('agent:ready', renderAnimDock);

	// Hold the avatar in the default pose as soon as the rig is ready, so the
	// editor opens on a recognizable frame instead of the procedural idle.
	// Skipped when a saved widget is being loaded — that flow hides the dock
	// and renders its own configured state.
	agentEl.addEventListener('agent:ready', () => {
		if (state.widgetId) return;
		const clips = (typeof agentEl._listAvailableClips === 'function')
			? agentEl._listAvailableClips()
			: [];
		const pose = clips.find((c) => c.name === DEFAULT_POSE);
		if (pose) playClip(pose);
	});

	// Number-key shortcuts (1–6) play the matching featured chip. Skipped
	// while typing in any text field; skipped when the modal is open so the
	// user can scroll without firing animations.
	const onAnimKey = (e) => {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		if (animModal && !animModal.hidden) {
			if (e.key === 'Escape') { e.preventDefault(); closeAnimModal(); }
			return;
		}
		if (e.key >= '1' && e.key <= '6') {
			const chips = animDock.querySelectorAll('.anim-chip:not(.more)');
			const idx = Number(e.key) - 1;
			if (chips[idx]) {
				const path = e.composedPath?.() || [];
				const inText = path.some((n) => n?.tagName === 'INPUT' || n?.tagName === 'TEXTAREA' || n?.isContentEditable);
				if (inText) return;
				e.preventDefault();
				chips[idx].click();
			}
		} else if (e.key === 'a' || e.key === 'A') {
			const path = e.composedPath?.() || [];
			const inText = path.some((n) => n?.tagName === 'INPUT' || n?.tagName === 'TEXTAREA' || n?.isContentEditable);
			if (inText) return;
			e.preventDefault();
			if (animModal.hidden) openAnimModal();
			else closeAnimModal();
		}
	};
	document.addEventListener('keydown', onAnimKey);

	// ── Avatar picker (modal) ──
	// Behind a modal so the panel stays light. The list is fetched only when
	// the modal first opens, and each card uses <model-viewer loading="lazy">
	// so only thumbnails scrolled into the viewport actually boot a WebGL
	// context. Demo set is rendered immediately; public-avatars network call
	// is deferred until modal open.
	const avatarTrigger = $('#avatar-trigger');
	const avatarTriggerName = $('#avatar-trigger-name');
	const avatarTriggerThumb = $('#avatar-trigger-thumb');
	const avatarModal = $('#avatar-modal');
	const avatarModalClose = $('#avatar-modal-close');
	const avatarModalBackdrop = $('#avatar-modal-backdrop');
	const avatarGrid = $('#avatar-grid');
	const avatarMore = $('#avatar-more');
	const avatarEmpty = $('#avatar-empty');
	let avatarCursor = null;
	let avatarLoading = false;
	let avatarPopulated = false;
	let modelViewerLoading = null;

	// Dynamically load Google's <model-viewer> on first modal open so the
	// editor's initial bundle stays small.
	function ensureModelViewer() {
		if (customElements.get('model-viewer')) return Promise.resolve();
		if (modelViewerLoading) return modelViewerLoading;
		modelViewerLoading = new Promise((resolve, reject) => {
			const s = document.createElement('script');
			s.type = 'module';
			s.src = 'https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js';
			s.onload = () => resolve();
			s.onerror = () => reject(new Error('model-viewer failed to load'));
			document.head.appendChild(s);
		});
		return modelViewerLoading;
	}

	function renderSkeletons(n) {
		for (let i = 0; i < n; i++) {
			const sk = document.createElement('div');
			sk.className = 'avatar-card skeleton';
			avatarGrid.appendChild(sk);
		}
	}
	function clearSkeletons() {
		for (const el of avatarGrid.querySelectorAll('.skeleton')) el.remove();
	}
	function updateAvatarTrigger(name, modelUrl) {
		avatarTriggerName.textContent = name || 'Browse avatars';
		// Thumbnail in the trigger: if we know a thumbnail_url we use it,
		// otherwise leave the gradient fallback.
		avatarTriggerThumb.style.backgroundImage = '';
	}
	function pickAvatar(card, modelUrl, name) {
		state.src = modelUrl;
		srcInput.value = modelUrl;
		agentEl.setAttribute('src', modelUrl);
		for (const c of avatarGrid.querySelectorAll('.avatar-card'))
			c.setAttribute('aria-pressed', String(c === card));
		updateAvatarTrigger(name, modelUrl);
		writeSnippet();
		closeAvatarModal();
	}
	function renderAvatarCards(items, { pinned = false } = {}) {
		for (const a of items) {
			if (!a.model_url) continue;
			const card = document.createElement('div');
			card.className = 'avatar-card' + (pinned ? ' pinned' : '');
			card.setAttribute('role', 'button');
			card.setAttribute('tabindex', '0');
			card.dataset.id = a.id;
			card.title = a.name || a.slug || a.id;

			// Live 3D thumbnail via <model-viewer> with loading="lazy" so the
			// underlying GLTFLoader / WebGL context only spins up when the card
			// scrolls into the modal's viewport.
			const mv = document.createElement('model-viewer');
			mv.setAttribute('src', a.model_url);
			mv.setAttribute('alt', a.name || 'Avatar preview');
			mv.setAttribute('camera-controls', '');
			mv.setAttribute('disable-zoom', '');
			mv.setAttribute('interaction-prompt', 'none');
			mv.setAttribute('auto-rotate', '');
			mv.setAttribute('rotation-per-second', '24deg');
			mv.setAttribute('exposure', '1.05');
			mv.setAttribute('shadow-intensity', '0.6');
			mv.setAttribute('loading', 'lazy');
			mv.setAttribute('reveal', 'auto');
			if (a.thumbnail_url) mv.setAttribute('poster', a.thumbnail_url);
			card.appendChild(mv);

			if (pinned) {
				const tag = document.createElement('div');
				tag.className = 'tag';
				tag.textContent = 'Demo';
				card.appendChild(tag);
			}
			const name = document.createElement('div');
			name.className = 'name';
			name.textContent = a.name || a.slug || 'Avatar';
			card.appendChild(name);
			card.setAttribute('aria-pressed', String(state.src && state.src === a.model_url));
			const activate = () => pickAvatar(card, a.model_url, a.name);
			card.addEventListener('click', activate);
			card.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
			});
			avatarGrid.appendChild(card);
		}
	}
	async function loadAvatarPage() {
		if (avatarLoading) return;
		avatarLoading = true;
		avatarMore.hidden = true;
		const initial = !avatarGrid.children.length;
		if (initial) {
			// Pin the curated demo set first so the gallery opens to something
			// recognisable even before the network call returns.
			renderAvatarCards(DEMO_AVATARS, { pinned: true });
			renderSkeletons(8);
		}
		try {
			const url = new URL(`${location.origin}/api/avatars/public`);
			url.searchParams.set('limit', '24');
			if (avatarCursor) url.searchParams.set('cursor', avatarCursor);
			const res = await fetch(url.toString(), { credentials: 'omit' });
			if (!res.ok) throw new Error(`avatars/public ${res.status}`);
			const data = await res.json();
			clearSkeletons();
			renderAvatarCards(data.avatars || []);
			avatarCursor = data.next_cursor || null;
			avatarMore.hidden = !avatarCursor;
		} catch (err) {
			clearSkeletons();
			if (initial && !DEMO_AVATARS.length) {
				avatarEmpty.textContent = `Couldn't load avatars: ${err.message}`;
				avatarEmpty.hidden = false;
			}
		} finally {
			avatarLoading = false;
		}
	}
	avatarMore.addEventListener('click', loadAvatarPage);

	async function openAvatarModal() {
		avatarModal.hidden = false;
		document.body.style.overflow = 'hidden';
		if (!avatarPopulated) {
			avatarPopulated = true;
			try { await ensureModelViewer(); } catch (err) { console.warn('[embed-editor]', err); }
			loadAvatarPage();
		}
	}
	function closeAvatarModal() {
		avatarModal.hidden = true;
		document.body.style.overflow = '';
	}
	avatarTrigger.addEventListener('click', openAvatarModal);
	avatarModalClose.addEventListener('click', closeAvatarModal);
	avatarModalBackdrop.addEventListener('click', closeAvatarModal);

	// If a widget id was passed, swap the bare <agent-3d> preview for an
	// iframe loading the live widget renderer (/widget#widget=<id>&kiosk=true).
	if (state.widgetId) loadWidget(state.widgetId);

	async function loadWidget(id) {
		const origin = location.origin;
		// Show the live widget immediately — don't wait on the metadata fetch.
		widgetFrame.src = `${origin}/widget#widget=${encodeURIComponent(id)}&kiosk=true`;
		widgetFrame.hidden = false;
		agentEl.style.display = 'none';
		widgetBadge.hidden = false;
		widgetBadge.textContent = id;

		try {
			const res = await fetch(`${origin}/api/widgets/${encodeURIComponent(id)}`, {
				credentials: 'include',
			});
			if (!res.ok) {
				widgetBadge.textContent = `${id} · not found`;
				widgetBadge.style.color = '#fca5a5';
				return;
			}
			const { widget } = await res.json();
			state.widget = widget;
			widgetBadge.textContent = `${widget.name || id} · ${widget.type}`;

			// Type-aware preferred sizes (mirrors public/embed.js defaults).
			const TYPE_SIZES = {
				turntable: [600, 600],
				'animation-gallery': [720, 720],
				'talking-agent': [420, 600],
				passport: [480, 560],
				'hotspot-tour': [800, 600],
			};
			const [w, h] = TYPE_SIZES[widget.type] || [600, 600];
			state.width = `${w}px`;
			state.height = `${h}px`;
			wInput.value = state.width;
			hInput.value = state.height;

			// Pre-fill src with the avatar model so a fallback agent-3d snippet
			// works if the user later toggles off the widget id.
			if (widget.avatar?.model_url) {
				state.src = widget.avatar.model_url;
				srcInput.value = state.src;
			}

			sync();
		} catch (err) {
			widgetBadge.textContent = `${id} · ${err.message}`;
			widgetBadge.style.color = '#fca5a5';
		}
	}

	// Mode cards
	const modeGrid = $('#mode-grid');
	for (const m of MODES) {
		const card = document.createElement('div');
		card.className = 'mode-card';
		card.dataset.mode = m.id;
		card.setAttribute('aria-pressed', String(m.id === state.mode));
		card.tabIndex = 0;
		card.innerHTML = `<div class="ml">${m.label}</div><div class="mh">${m.hint}</div>`;
		card.addEventListener('click', () => {
			state.mode = m.id;
			sync();
		});
		modeGrid.appendChild(card);
	}

	// Position buttons
	const posGrid = $('#pos-grid');
	for (const p of POSITIONS) {
		const btn = document.createElement('button');
		btn.className = 'pos-btn';
		btn.dataset.pos = p.id;
		btn.setAttribute('aria-pressed', String(p.id === state.position));
		btn.textContent = p.label;
		btn.addEventListener('click', () => {
			state.position = p.id;
			sync();
		});
		posGrid.appendChild(btn);
	}

	// Input bindings
	srcInput.addEventListener('change', () => {
		state.src = srcInput.value;
		sync();
	});
	wInput.addEventListener('change', () => {
		state.width = wInput.value;
		sync();
	});
	hInput.addEventListener('change', () => {
		state.height = hInput.value;
		sync();
	});
	$('#chat-select').addEventListener('change', (e) => {
		state.showChat = e.target.value === 'on';
		applyAgentAttrs();
		sync();
	});
	$('#voice-select').addEventListener('change', (e) => {
		state.voice = e.target.value === 'off' ? false : true;
		applyAgentAttrs();
		sync();
	});
	$('#camera-select').addEventListener('change', (e) => {
		state.cameraControls = e.target.value === 'on';
		applyAgentAttrs();
		sync();
	});
	$('#ar-select').addEventListener('change', (e) => {
		state.ar = e.target.value === 'on';
		applyAgentAttrs();
		sync();
	});
	$('#bg-select').addEventListener('change', (e) => {
		state.background = e.target.value;
		applyAgentAttrs();
		sync();
	});
	$('#glow-select').addEventListener('change', (e) => {
		state.glow = e.target.value === 'on';
		applyGlow();
	});
	$('#responsive-select').addEventListener('change', (e) => {
		state.responsivePreset = e.target.value;
		writeSnippet();
	});
	$('#agent-id-input').addEventListener('change', (e) => {
		state.agentId = e.target.value.trim();
		applyAgentAttrs();
		writeSnippet();
	});
	$('#nameplate-select').addEventListener('change', (e) => {
		state.namePlate = e.target.value;
		applyAgentAttrs();
		writeSnippet();
	});
	$('#default-clip-select').addEventListener('change', (e) => {
		state.defaultClip = e.target.value;
		writeSnippet();
	});
	$('#default-clip-loop').addEventListener('change', (e) => {
		state.defaultClipLoop = e.target.value === 'true';
		writeSnippet();
	});
	$('#accent-color-input').addEventListener('input', (e) => {
		state.accentColor = e.target.value;
		applyAgentAttrs();
		writeSnippet();
	});
	$('#accent-reset-btn').addEventListener('click', () => {
		state.accentColor = '#3b82f6';
		$('#accent-color-input').value = '#3b82f6';
		applyAgentAttrs();
		writeSnippet();
	});
	$('#radius-input').addEventListener('change', (e) => {
		state.borderRadius = e.target.value.trim();
		applyAgentAttrs();
		writeSnippet();
	});

	// URL preview
	const urlInput = $('#url-input');
	$('#url-load').addEventListener('click', () => {
		const u = urlInput.value.trim();
		if (!u) return;
		const iframe = $('#preview-frame');
		iframe.src = u;
		iframe.hidden = false;
		$('#placeholder').hidden = true;
	});
	$('#url-clear').addEventListener('click', () => {
		$('#preview-frame').src = 'about:blank';
		$('#preview-frame').hidden = true;
		$('#placeholder').hidden = false;
	});

	// Drag — also handles click-to-freeze: a pointerdown→pointerup with less
	// than TAP_THRESHOLD pixels of movement is treated as a tap on the avatar
	// and toggles state.avatarFrozen instead of dragging.
	const TAP_THRESHOLD = 5;
	let dragState = null;
	agentWrap.addEventListener('pointerdown', (e) => {
		// Don't intercept clicks on overlay chrome that sits over the wrap.
		if (e.target.closest('.size-readout, .widget-badge')) return;
		const dragAllowed = !state.previewMode && !state.locked;
		const agentRect = agentWrap.getBoundingClientRect();
		dragState = {
			kind: dragAllowed ? 'move' : 'tap-only',
			downX: e.clientX,
			downY: e.clientY,
			moved: false,
			offsetX: e.clientX - agentRect.left,
			offsetY: e.clientY - agentRect.top,
			stageRect: stage.getBoundingClientRect(),
		};
		agentWrap.setPointerCapture(e.pointerId);
	});

	stage.addEventListener('pointermove', (e) => {
		if (!dragState) return;
		const rect = dragState.stageRect;
		if (dragState.kind === 'move' || dragState.kind === 'tap-only') {
			// Don't start dragging (or treat as a movement) until the pointer has
			// travelled past TAP_THRESHOLD — anything shorter resolves as a tap on
			// pointerup, which toggles avatar freeze.
			if (!dragState.moved) {
				const dx = e.clientX - dragState.downX;
				const dy = e.clientY - dragState.downY;
				if (dx * dx + dy * dy < TAP_THRESHOLD * TAP_THRESHOLD) return;
				dragState.moved = true;
				if (dragState.kind === 'move') agentWrap.classList.add('dragging');
			}
			if (dragState.kind !== 'move') return;
			const x = e.clientX - rect.left - dragState.offsetX;
			const y = e.clientY - rect.top - dragState.offsetY;
			const snapped = snapToCorner(
				x,
				y,
				agentWrap.offsetWidth,
				agentWrap.offsetHeight,
				rect.width,
				rect.height,
			);
			agentWrap.style.left = snapped.x + 'px';
			agentWrap.style.top = snapped.y + 'px';
			if (snapped.corner) {
				state.position = snapped.corner;
				state.offset = `${snapped.offsetV} ${snapped.offsetH}`;
				syncPositionButtons();
				writeSnippet();
			}
		} else if (dragState.kind === 'resize') {
			const dx = e.clientX - dragState.startX;
			const dy = e.clientY - dragState.startY;
			let w = dragState.startW,
				h = dragState.startH;
			let left = dragState.startLeft,
				top = dragState.startTop;
			if (dragState.handle.includes('e')) w = dragState.startW + dx;
			if (dragState.handle.includes('s')) h = dragState.startH + dy;
			if (dragState.handle.includes('w')) {
				w = dragState.startW - dx;
				left = dragState.startLeft + dx;
			}
			if (dragState.handle.includes('n')) {
				h = dragState.startH - dy;
				top = dragState.startTop + dy;
			}
			w = Math.max(160, w);
			h = Math.max(200, h);
			agentWrap.style.width = w + 'px';
			agentWrap.style.height = h + 'px';
			agentWrap.style.left = left + 'px';
			agentWrap.style.top = top + 'px';
			state.width = Math.round(w) + 'px';
			state.height = Math.round(h) + 'px';
			wInput.value = state.width;
			hInput.value = state.height;
			readout.textContent = `${state.width} × ${state.height}`;
			writeSnippet();
		}
	});

	stage.addEventListener('pointerup', () => {
		if (!dragState) return;
		// Resize finalizes on pointerup regardless; only move/tap-only carry the
		// tap-to-freeze intent.
		if ((dragState.kind === 'move' || dragState.kind === 'tap-only') && !dragState.moved) {
			setAvatarFrozen(!state.avatarFrozen);
		}
		agentWrap.classList.remove('dragging');
		dragState = null;
	});

	const toastEl = $('#toast');
	let toastTimer = null;
	function showToast(message, { kind = 'success' } = {}) {
		toastEl.textContent = message;
		toastEl.dataset.kind = kind;
		toastEl.classList.add('visible');
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => toastEl.classList.remove('visible'), 2200);
	}

	copyBtn.addEventListener('click', async () => {
		const snippet = buildSnippet();
		try {
			await navigator.clipboard.writeText(snippet);
			showToast('Snippet copied to clipboard');
		} catch (err) {
			// Permissions may block clipboard in some embedded contexts. Fall back
			// to a manual selection so the user can still grab the snippet.
			const range = document.createRange();
			range.selectNodeContents(snippetEl);
			const sel = window.getSelection();
			sel.removeAllRanges();
			sel.addRange(range);
			showToast('Clipboard blocked — snippet selected, press ⌘C', { kind: 'warn' });
		}
		copyBtn.textContent = 'Copied ✓';
		copyBtn.dataset.copied = 'true';
		setTimeout(() => {
			copyBtn.textContent = 'Copy snippet';
			copyBtn.dataset.copied = 'false';
		}, 1500);
	});

	const snippetCollapse = $('#snippet-collapse');
	snippetCollapse.addEventListener('click', () => {
		const collapsed = snippetEl.classList.toggle('collapsed');
		snippetCollapse.textContent = collapsed ? 'Show full snippet ▾' : 'Collapse snippet ▴';
	});

	$('#open-btn').addEventListener('click', () => {
		const html = buildStandalonePage();
		const blob = new Blob([html], { type: 'text/html' });
		const url = URL.createObjectURL(blob);
		const win = window.open(url, '_blank', 'noopener');
		if (!win) {
			showToast('Popup blocked — allow popups to open the preview', { kind: 'warn' });
			URL.revokeObjectURL(url);
			return;
		}
		// Revoke the blob URL after the new tab has had time to load it. 60s is
		// generous — the document fully parses long before this. Without revoke,
		// the blob lingers for the lifetime of the editor tab.
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	});

	$('#reset-btn').addEventListener('click', () => {
		Object.assign(state, defaults);
		srcInput.value = state.src;
		wInput.value = state.width;
		hInput.value = state.height;
		$('#responsive-select').value = state.responsivePreset;
		$('#chat-select').value = state.showChat ? 'on' : 'off';
		$('#voice-select').value = state.voice === false ? 'off' : '';
		$('#camera-select').value = state.cameraControls ? 'on' : 'off';
		$('#ar-select').value = state.ar ? 'on' : 'off';
		$('#bg-select').value = state.background || 'transparent';
		$('#glow-select').value = state.glow ? 'on' : 'off';
		sync();
	});

	const editorRoot = shadow.querySelector('.editor-root');
	const previewToggle = $('#preview-toggle');
	const exitPreview = $('#exit-preview');
	function setPreviewMode(on) {
		state.previewMode = !!on;
		editorRoot.setAttribute('data-preview', state.previewMode ? 'true' : 'false');
		previewToggle.textContent = state.previewMode ? 'Editing' : 'Preview';
		applyToPreview();
	}
	previewToggle.addEventListener('click', () => setPreviewMode(!state.previewMode));
	exitPreview.addEventListener('click', () => setPreviewMode(false));
	previewToggle.title = 'Toggle preview (P)';
	exitPreview.title = 'Exit preview (Esc)';

	// ── Lock mode ──
	// Freezes the wrap (drag + resize disabled, handles hidden via CSS) and the
	// avatar itself: the Three.js animation mixer's timeScale is set to 0 so
	// the idle loop stops mid-frame, and OrbitControls is disabled so the
	// camera can't be rotated/panned/zoomed. Toggling off restores both.
	const lockToggle = $('#lock-toggle');
	// state.avatarFrozen — true when the avatar's mixer + camera controls are
	// paused (set by Lock button OR by click-on-avatar). state.locked is the
	// wider Lock-button state that also freezes the wrap.
	function applyAvatarLock() {
		const viewer = agentEl?._viewer;
		if (!viewer) return;
		if (viewer.mixer) viewer.mixer.timeScale = state.avatarFrozen ? 0 : 1;
		if (viewer.controls) viewer.controls.enabled = !state.avatarFrozen;
		editorRoot.setAttribute('data-avatar-frozen', state.avatarFrozen ? 'true' : 'false');
	}
	function setAvatarFrozen(on, { silent = false } = {}) {
		state.avatarFrozen = !!on;
		applyAvatarLock();
		if (!silent) {
			showToast(state.avatarFrozen ? 'Avatar frozen — click again to play' : 'Avatar playing', {
				kind: state.avatarFrozen ? 'warn' : 'success',
			});
		}
	}
	function setLocked(on) {
		state.locked = !!on;
		editorRoot.setAttribute('data-locked', state.locked ? 'true' : 'false');
		lockToggle.setAttribute('aria-pressed', state.locked ? 'true' : 'false');
		lockToggle.querySelector('.lock-icon').textContent = state.locked ? '🔒' : '🔓';
		lockToggle.querySelector('.lock-label').textContent = state.locked ? 'Locked' : 'Lock';
		// Lock button drives both the wrap and the avatar freeze.
		setAvatarFrozen(state.locked, { silent: true });
		showToast(state.locked ? 'Locked — drag, resize, and avatar motion frozen' : 'Unlocked', {
			kind: state.locked ? 'warn' : 'success',
		});
	}
	lockToggle.addEventListener('click', () => setLocked(!state.locked));
	// Re-apply on each agent boot so freezing persists across avatar swaps —
	// _viewer.mixer is rebuilt during setContent() so the timeScale would
	// otherwise reset to 1.
	agentEl.addEventListener('agent:ready', applyAvatarLock);

	// Keyboard shortcuts — Esc exits preview, P toggles. Bound on document so
	// they fire even when focus is on the stage. Suppressed while typing in any
	// text field (the editor's inputs live in the shadow root; check both light
	// DOM target and composedPath() for an editable element).
	function isTextTarget(e) {
		const path = e.composedPath?.() || [];
		for (const node of path) {
			if (!node || node.nodeType !== 1) continue;
			const tag = node.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
			if (node.isContentEditable) return true;
		}
		return false;
	}
	const onKey = (e) => {
		if (e.key === 'Escape' && !avatarModal.hidden) {
			e.preventDefault();
			closeAvatarModal();
			return;
		}
		if (e.key === 'Escape' && state.previewMode) {
			e.preventDefault();
			setPreviewMode(false);
			return;
		}
		if ((e.key === 'p' || e.key === 'P') && !e.metaKey && !e.ctrlKey && !e.altKey) {
			if (isTextTarget(e)) return;
			e.preventDefault();
			setPreviewMode(!state.previewMode);
			return;
		}
		if ((e.key === 'l' || e.key === 'L') && !e.metaKey && !e.ctrlKey && !e.altKey) {
			if (isTextTarget(e)) return;
			e.preventDefault();
			setLocked(!state.locked);
		}
	};
	document.addEventListener('keydown', onKey);

	// Show appropriate resize handles based on position
	function syncPositionButtons() {
		for (const btn of $$('.pos-btn'))
			btn.setAttribute('aria-pressed', String(btn.dataset.pos === state.position));
	}
	function syncModeCards() {
		for (const card of $$('.mode-card'))
			card.setAttribute('aria-pressed', String(card.dataset.mode === state.mode));
	}

	// Mirror toggleable agent attrs (voice/camera/AR/background) onto the live
	// preview element so flipping the panel selects has an immediate visual effect.
	// Snippet attrs are emitted separately in buildSnippet() — these only drive the
	// in-editor preview agent. Skipped in widget-iframe mode (the iframe owns its
	// own agent instance and reads its config from the widget record).
	// Toggles the purple→cyan blur layer on the preview backdrop. Preview-only
	// decoration — not exported in the snippet — so it lives outside
	// applyAgentAttrs / writeSnippet.
	function applyGlow() {
		const placeholder = $('#placeholder');
		if (!placeholder) return;
		placeholder.classList.toggle('has-glow', !!state.glow);
	}

	function applyAgentAttrs() {
		if (state.widgetId) return;
		// kiosk = no chat UI. Mirror state.showChat onto the live agent so the
		// editor preview matches what the snippet will emit.
		if (state.showChat) agentEl.removeAttribute('kiosk');
		else agentEl.setAttribute('kiosk', '');
		if (state.voice === false) agentEl.setAttribute('voice', 'off');
		else agentEl.removeAttribute('voice');
		if (state.cameraControls) agentEl.setAttribute('camera-controls', '');
		else agentEl.removeAttribute('camera-controls');
		if (state.ar) agentEl.setAttribute('ar', '');
		else agentEl.removeAttribute('ar');
		if (state.background) agentEl.setAttribute('background', state.background);
		else agentEl.removeAttribute('background');
	}

	function applyToPreview() {
		// Size
		agentWrap.style.width = state.width;
		agentWrap.style.height = state.height;
		readout.textContent = `${state.width} × ${state.height}`;

		// Position — place the wrap inside the stage per mode + position
		agentWrap.style.left =
			agentWrap.style.right =
			agentWrap.style.top =
			agentWrap.style.bottom =
				'';
		if (state.mode === 'floating') {
			const [vOff, hOff] = (state.offset || '24px 24px').split(/\s+/);
			if (state.position.includes('top')) agentWrap.style.top = vOff;
			else agentWrap.style.bottom = vOff;
			if (state.position.includes('left')) agentWrap.style.left = hOff;
			else if (state.position.includes('right')) agentWrap.style.right = hOff;
			else if (state.position.includes('center')) {
				agentWrap.style.left = '50%';
				agentWrap.style.transform = 'translateX(-50%)';
			}
			$('#pos-title').style.display = '';
			$('#pos-grid').style.display = '';
		} else if (state.mode === 'fullscreen') {
			agentWrap.style.inset = '0';
			agentWrap.style.width = '100%';
			agentWrap.style.height = '100%';
			$('#pos-title').style.display = 'none';
			$('#pos-grid').style.display = 'none';
		} else {
			// inline / section: center on stage
			agentWrap.style.left = `calc(50% - ${parseInt(state.width) / 2}px)`;
			agentWrap.style.top = `calc(50% - ${parseInt(state.height) / 2}px)`;
			$('#pos-title').style.display = 'none';
			$('#pos-grid').style.display = 'none';
		}

		// Agent attrs — skip when a widget is driving the preview iframe so the
		// hidden <agent-3d> doesn't fetch a GLB we'll never show. Fall back to a
		// default avatar when the user hasn't entered a src, so the preview is
		// never an empty box.
		if (!state.widgetId) {
			agentEl.setAttribute('src', state.src || DEFAULT_PREVIEW_SRC);
		}
	}

	function buildSnippet() {
		// Widget snippet — when a saved widget id is loaded, prefer the
		// canonical script-tag embed (matches Studio's "share" modal).
		if (state.widgetId) {
			const origin = location.origin;
			const wPx = parsePx(state.width);
			const hPx = parsePx(state.height);
			const dataAttrs = [
				`data-widget="${escapeAttr(state.widgetId)}"`,
				state.widget?.type ? `data-type="${escapeAttr(state.widget.type)}"` : '',
				wPx ? `data-width="${wPx}"` : '',
				hPx ? `data-height="${hPx}"` : '',
			]
				.filter(Boolean)
				.join(' ');
			return `<script async src="${origin}/embed.js" ${dataAttrs}></` + 'script>';
		}

		const attrs = [];
		// Always emit a src so the snippet renders the same avatar the editor
		// is previewing. Falls back to the default avatar when the user hasn't
		// picked anything yet.
		attrs.push(`src="${escapeAttr(state.src || DEFAULT_PREVIEW_SRC)}"`);
		if (state.mode && state.mode !== 'inline') attrs.push(`mode="${state.mode}"`);
		if (state.mode === 'floating') {
			if (state.position !== 'bottom-right') attrs.push(`position="${state.position}"`);
			if (state.offset && state.offset !== '24px 24px')
				attrs.push(`offset="${state.offset}"`);
		}

		const wPx = parsePx(state.width);
		const hPx = parsePx(state.height);
		const preset = state.responsivePreset;

		if (preset !== 'fixed' && wPx && hPx) {
			// Emit clamp() CSS custom properties on the style attribute
			const wMin = Math.round(Math.max(160, wPx * 0.65));
			const hMin = Math.round(Math.max(200, hPx * 0.65));
			const wVw = Math.round((wPx / 1440) * 100);
			const hVh = Math.round((hPx / 900) * 100);
			const wClamp = `clamp(${wMin}px, ${wVw}vw, ${wPx}px)`;
			const hClamp = `clamp(${hMin}px, ${hVh}vh, ${hPx}px)`;
			attrs.push(`style="--agent-width: ${wClamp}; --agent-height: ${hClamp};"`);
			attrs.push(`responsive`);
		} else {
			if (state.width) attrs.push(`width="${state.width}"`);
			if (state.height) attrs.push(`height="${state.height}"`);
			attrs.push(`responsive="false"`);
		}

		// Kiosk by default — emit it unless the user explicitly opts INTO the
		// chat UI. This gives a clean "just the 3D avatar" embed out of the
		// box; users who want a chat panel can flip the toggle.
		if (!state.showChat) attrs.push(`kiosk`);
		if (state.voice === false) attrs.push(`voice="off"`);
		if (state.cameraControls) attrs.push(`camera-controls`);
		if (state.ar) attrs.push(`ar`);
		// Background — default is transparent so the avatar floats over the host
		// page without a coloured box behind it. Users can pick Dark / Light if
		// they want a contained widget instead.
		attrs.push(`background="${escapeAttr(state.background || 'transparent')}"`);

		const script = `<script type="module" async src="${AGENT_3D_HOST}/agent-3d/${AGENT_3D_VERSION}/agent-3d.js"></` + 'script>';
		const element = `<agent-3d ${attrs.join(' ')}></agent-3d>`;
		let snippet = `${script}\n${element}`;

		if (preset !== 'fixed') {
			snippet = `<!-- generated responsive styles -->\n${snippet}`;
		}
		return snippet;
	}

	function writeSnippet() {
		snippetEl.textContent = buildSnippet();
	}

	// Build a standalone HTML page that renders the current snippet against a
	// minimal landing-page mock — opened in a new tab by "Open in new tab" so
	// demos can show the embed working in isolation. The script tag URL is
	// swapped to the local dev module when running on localhost so the new
	// tab actually loads (the production CDN path is not routed by Vite).
	function buildStandalonePage() {
		const snippet = buildSnippet();
		const isLocal = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?)/i.test(location.hostname);
		const localScript = `<script type="module" src="${location.origin}/src/element.js"></` + 'script>';
		// Rewrite ALL relative URLs (src="/...", any "/...glb", etc.) inside the
		// snippet to absolute so they resolve against the live origin instead
		// of the blob: document we're about to open the page from. Blob URLs
		// have no base, so a bare "/avatars/cz.glb" would otherwise hit the
		// Failed-to-parse-URL errors the user saw in the console.
		let wireSnippet = isLocal && !state.widgetId
			? snippet.replace(
					/<script[^>]*src="[^"]*agent-3d\/[^"]+\/agent-3d\.js"[^>]*><\/script>/,
					localScript,
				)
			: snippet;
		// Rewrite any remaining relative src="/foo" → src="${origin}/foo".
		wireSnippet = wireSnippet.replace(
			/(\s)(src|href)="\/([^"]*)"/g,
			`$1$2="${location.origin}/$3"`,
		);
		const title = `Embed preview — ${state.src || state.widgetId || 'agent'}`;
		return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<!-- Anchor relative URLs (fetches inside agent-3d, e.g. /three.svg, /avatars/*.glb)
     against the live origin. Required because this page is served from a blob:
     URL which has no base for resolving "/..." URLs. -->
<base href="${location.origin}/">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
	html, body { margin: 0; padding: 0; min-height: 100vh; font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; color: #0f172a; background: #f8fafc; }
	.nav { display: flex; align-items: center; justify-content: space-between; padding: 18px 48px; border-bottom: 1px solid #e5e7eb; background: rgba(255,255,255,0.92); backdrop-filter: blur(8px); position: sticky; top: 0; z-index: 1; }
	.brand { display: flex; align-items: center; gap: 10px; font: 700 17px/1 system-ui; }
	.logo { width: 28px; height: 28px; border-radius: 8px; background: linear-gradient(135deg, #6366f1, #8b5cf6); box-shadow: 0 2px 8px rgba(99,102,241,0.4); }
	.hero { max-width: 960px; margin: 0 auto; padding: 80px 48px 48px; text-align: center; }
	.pill { display: inline-block; padding: 6px 14px; border-radius: 999px; background: #ede9fe; color: #6d28d9; font: 600 12px system-ui; margin-bottom: 22px; }
	h1 { font: 800 52px/1.1 system-ui; letter-spacing: -0.02em; margin: 0 0 18px; }
	h1 .accent { background: linear-gradient(90deg, #6366f1, #ec4899); -webkit-background-clip: text; background-clip: text; color: transparent; }
	.lede { font-size: 18px; color: #475569; max-width: 640px; margin: 0 auto 28px; }
	.cta { display: flex; gap: 12px; justify-content: center; }
	.btn-primary { background: #0f172a; color: white; padding: 12px 22px; border-radius: 10px; font: 600 14px system-ui; }
	.btn-ghost { background: white; color: #0f172a; padding: 12px 22px; border-radius: 10px; font: 600 14px system-ui; border: 1px solid #e5e7eb; }
	footer { padding: 48px; text-align: center; color: #94a3b8; font-size: 13px; }
	footer code { background: #e2e8f0; padding: 2px 6px; border-radius: 4px; color: #334155; font: 12px ui-monospace, Menlo, monospace; }
</style>
</head>
<body>
	<nav class="nav">
		<div class="brand"><div class="logo"></div>Acme</div>
		<div class="btn-primary" style="padding: 8px 16px; font-size: 13px;">Sign in</div>
	</nav>
	<section class="hero">
		<div class="pill">Preview · live snippet</div>
		<h1>Your <span class="accent">agent embed</span><br>on a real page.</h1>
		<p class="lede">This page renders the exact snippet from the editor. Resize, scroll, and click around to see how it behaves in production.</p>
		<div class="cta">
			<div class="btn-primary">Start free</div>
			<div class="btn-ghost">See it live</div>
		</div>
	</section>
	<footer>
		Generated by the three.ws embed editor — close this tab to return.
	</footer>

	<!-- ── Embed snippet ── -->
	${wireSnippet}
</body>
</html>`;
	}

	function escapeHtml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	const deviceViewport = $('#device-viewport');
	function syncDevice() {
		const device = DEVICES.find((d) => d.id === state.device) || DEVICES[0];
		for (const btn of $$('.device-btn')) {
			btn.setAttribute('aria-pressed', String(btn.dataset.device === state.device));
		}

		// Reset placeholder/iframe inline styles — earlier versions of this code
		// scaled them individually; the viewport now owns the transform.
		const placeholder = $('#placeholder');
		if (placeholder) placeholder.style.cssText = '';
		const iframe = $('#preview-frame');
		if (iframe) iframe.style.cssText = '';

		if (state.device === 'desktop') {
			deviceViewport.style.cssText = '';
			deviceViewport.dataset.device = 'desktop';
			stage.removeAttribute('data-device');
			return;
		}

		// Scale the device viewport (which contains placeholder, iframe, AND the
		// agent wrap) so everything moves together. The wrap stays positioned
		// relative to the viewport, so a floating bubble at bottom-right of a
		// 768×1024 tablet appears at the tablet's bottom-right corner instead
		// of leaking out into the stage.
		const stageRect = stage.getBoundingClientRect();
		const stageW = stageRect.width || stage.offsetWidth;
		const stageH = stageRect.height || stage.offsetHeight;
		const scaleX = stageW / device.w;
		const scaleY = stageH / device.h;
		const scale = Math.min(scaleX, scaleY, 1) * 0.9;
		const frameW = device.w * scale;
		const frameH = device.h * scale;
		const offsetX = (stageW - frameW) / 2;
		const offsetY = (stageH - frameH) / 2;

		deviceViewport.style.cssText = `
			position: absolute;
			top: ${offsetY}px;
			left: ${offsetX}px;
			width: ${device.w}px;
			height: ${device.h}px;
			transform: scale(${scale});
			transform-origin: top left;
		`;
		deviceViewport.dataset.device = state.device;
		stage.setAttribute('data-device', state.device);
	}

	function parsePx(val) {
		if (!val) return 0;
		const m = String(val).match(/^([\d.]+)px$/);
		return m ? parseFloat(m[1]) : 0;
	}

	function sync() {
		syncPositionButtons();
		syncModeCards();
		applyToPreview();
		applyAgentAttrs();
		applyGlow();
		syncDevice();
		writeSnippet();
	}

	function snapToCorner(x, y, w, h, stageW, stageH) {
		const SNAP = 48;
		const corners = [
			{ corner: 'top-left', cx: 0, cy: 0 },
			{ corner: 'top-right', cx: stageW - w, cy: 0 },
			{ corner: 'bottom-left', cx: 0, cy: stageH - h },
			{ corner: 'bottom-right', cx: stageW - w, cy: stageH - h },
			{ corner: 'top-center', cx: (stageW - w) / 2, cy: 0 },
			{ corner: 'bottom-center', cx: (stageW - w) / 2, cy: stageH - h },
		];
		for (const c of corners) {
			if (Math.abs(x - c.cx) < SNAP && Math.abs(y - c.cy) < SNAP) {
				// Compute offsets from nearest edge
				const offV = c.corner.startsWith('top')
					? `${Math.round(c.cy)}px`
					: `${Math.round(stageH - h - c.cy)}px`;
				const offH = c.corner.endsWith('left')
					? `${Math.round(c.cx)}px`
					: c.corner.endsWith('right')
						? `${Math.round(stageW - w - c.cx)}px`
						: '0px';
				return { x: c.cx, y: c.cy, corner: c.corner, offsetV: offV, offsetH: offH };
			}
		}
		return { x, y };
	}

	function escapeAttr(s) {
		return String(s).replace(/"/g, '&quot;');
	}

	sync();
	return { state, host };
}
