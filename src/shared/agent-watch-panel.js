// agent-watch-panel — live "remote desktop + webcam" view for any agent.
//
// Two surfaces in one component:
//   Screen   — left/main pane. When the agent has a Playwright process pushing
//              frames via POST /api/agent-screen-push, renders them at the raw
//              resolution. When no frames are coming, paints a "desktop" canvas
//              from real agent-actions rows: task log, recent actions, live
//              status indicator — so the screen is never blank.
//   Webcam   — right/inset pane. The agent's 3D GLB avatar rendered into an
//              offscreen Three.js canvas, zoomed on the face, piped into a
//              <video> element via captureStream(). Webcam bezel overlay.
//
// Usage (same pattern as mountStagePanel / mountLaborPanel):
//   const handle = await mountWatchPanel({ agentId, agentName, avatarUrl, isOwner, container });
//   // later:
//   handle?.destroy();

import {
	PerspectiveCamera, WebGLRenderer, Scene, AnimationMixer,
	AmbientLight, DirectionalLight, Box3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { getMeshoptDecoder } from '../viewer/internal.js';
import { clone as cloneSkinnedScene } from 'three/addons/utils/SkeletonUtils.js';

// Top-level endpoint — this is the real-time frame+log SSE stream.
const STREAM_URL   = (id) => `/api/agent-screen-stream?agentId=${encodeURIComponent(id)}`;
const ACTIONS_URL  = (id) => `/api/agent-actions?agent_id=${encodeURIComponent(id)}&limit=20`;
const SESSION_URL  = () => `/api/agent/session`;

// Canvas dimensions for the activity screen (no-frame fallback).
const CW = 1280, CH = 720;

// How long without a frame before dropping back to the activity canvas.
const FRAME_TIMEOUT_MS = 4000;
// Canvas repaint budget when idle (~10fps).
const IDLE_CANVAS_INTERVAL_MS = 100;
// Activity log poll interval.
const ACTIVITY_POLL_MS = 5000;

const STYLE_ID = 'tws-watch-panel-styles';

function injectStyles() {
	if (document.getElementById(STYLE_ID)) return;
	const s = document.createElement('style');
	s.id = STYLE_ID;
	s.textContent = `
.wp-root {
	display: flex;
	flex-direction: column;
	gap: 12px;
	width: 100%;
	font-family: var(--font-sans, 'Inter', system-ui, sans-serif);
}
.wp-stage {
	display: grid;
	grid-template-columns: 1fr 200px;
	gap: 12px;
	align-items: start;
}
@media (max-width: 640px) {
	.wp-stage { grid-template-columns: 1fr; }
	.wp-cam-wrap { aspect-ratio: 16/9 !important; }
}

/* ── Screen pane ──────────────────────────────────────────────── */
.wp-screen-wrap {
	position: relative;
	width: 100%;
	aspect-ratio: 16/9;
	background: #070709;
	border-radius: 10px;
	overflow: hidden;
	border: 1px solid rgba(255,255,255,0.07);
	box-shadow: 0 0 0 1px rgba(0,0,0,0.5), 0 8px 32px rgba(0,0,0,0.6);
}
.wp-screen-bezel {
	position: absolute;
	inset: 0;
	pointer-events: none;
	z-index: 3;
	border-radius: 10px;
	box-shadow: inset 0 0 0 1.5px rgba(255,255,255,0.06),
	            inset 0 1px 0 rgba(255,255,255,0.04);
}
.wp-screen-canvas {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	display: block;
	object-fit: contain;
	border-radius: 9px;
	image-rendering: -webkit-optimize-contrast;
}
.wp-screen-badge {
	position: absolute;
	top: 10px;
	left: 12px;
	z-index: 4;
	display: flex;
	align-items: center;
	gap: 6px;
	background: rgba(0,0,0,0.6);
	backdrop-filter: blur(10px);
	-webkit-backdrop-filter: blur(10px);
	border: 1px solid rgba(255,255,255,0.08);
	border-radius: 20px;
	padding: 4px 10px 4px 8px;
	font-size: 11px;
	font-weight: 700;
	color: rgba(255,255,255,0.75);
	letter-spacing: 0.05em;
	text-transform: uppercase;
	transition: opacity 0.3s;
}
.wp-screen-badge-dot {
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background: #5fd08a;
	animation: wp-pulse 1.8s ease-in-out infinite;
	flex-shrink: 0;
}
.wp-screen-badge-dot.offline {
	background: rgba(255,255,255,0.2);
	animation: none;
}
@keyframes wp-pulse {
	0%,100% { opacity: 1; transform: scale(1); }
	50%      { opacity: 0.35; transform: scale(0.65); }
}
.wp-screen-expand {
	position: absolute;
	bottom: 10px;
	right: 12px;
	z-index: 4;
	background: rgba(0,0,0,0.52);
	backdrop-filter: blur(10px);
	-webkit-backdrop-filter: blur(10px);
	border: 1px solid rgba(255,255,255,0.1);
	border-radius: 6px;
	color: rgba(255,255,255,0.55);
	font-size: 13px;
	line-height: 1;
	padding: 5px 8px;
	cursor: pointer;
	transition: background 0.12s, color 0.12s;
	opacity: 0;
	transition: opacity 0.2s;
}
.wp-screen-wrap:hover .wp-screen-expand { opacity: 1; }
.wp-screen-expand:hover { background: rgba(255,255,255,0.14); color: #fff; }
.wp-screen-fullview {
	position: absolute;
	bottom: 10px;
	right: 50px;
	z-index: 4;
	display: inline-flex;
	align-items: center;
	gap: 4px;
	background: rgba(0,0,0,0.52);
	backdrop-filter: blur(10px);
	-webkit-backdrop-filter: blur(10px);
	border: 1px solid rgba(255,255,255,0.1);
	border-radius: 6px;
	color: rgba(255,255,255,0.6);
	font-size: 11px;
	font-weight: 600;
	line-height: 1;
	padding: 6px 9px;
	text-decoration: none;
	cursor: pointer;
	opacity: 0;
	transition: opacity 0.2s, background 0.12s, color 0.12s;
}
.wp-screen-wrap:hover .wp-screen-fullview { opacity: 1; }
.wp-screen-fullview:hover { background: rgba(255,255,255,0.14); color: #fff; }

/* ── Webcam pane ──────────────────────────────────────────────── */
.wp-cam-wrap {
	position: relative;
	width: 100%;
	aspect-ratio: 3/4;
	background: #0a0a0d;
	border-radius: 10px;
	overflow: hidden;
	border: 1px solid rgba(255,255,255,0.07);
	box-shadow: 0 0 0 1px rgba(0,0,0,0.5), 0 4px 20px rgba(0,0,0,0.55);
}
.wp-cam-video {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	display: block;
	object-fit: cover;
}
.wp-cam-bezel {
	position: absolute;
	inset: 0;
	pointer-events: none;
	z-index: 2;
	border-radius: 10px;
	background: radial-gradient(ellipse at 50% 40%, transparent 42%, rgba(0,0,0,0.6) 100%);
	box-shadow: inset 0 0 0 1.5px rgba(255,255,255,0.05);
}
.wp-cam-scanlines {
	position: absolute;
	inset: 0;
	pointer-events: none;
	z-index: 3;
	border-radius: 10px;
	background: repeating-linear-gradient(
		0deg,
		transparent,
		transparent 3px,
		rgba(0,0,0,0.03) 3px,
		rgba(0,0,0,0.03) 4px
	);
	opacity: 0.7;
}
.wp-cam-label {
	position: absolute;
	bottom: 10px;
	left: 12px;
	z-index: 4;
	font-size: 9px;
	font-weight: 800;
	letter-spacing: 0.08em;
	text-transform: uppercase;
	color: rgba(255,255,255,0.45);
}
.wp-cam-live {
	position: absolute;
	top: 9px;
	right: 9px;
	z-index: 4;
	width: 7px;
	height: 7px;
	border-radius: 50%;
	background: rgba(95,208,138,0.85);
	box-shadow: 0 0 7px rgba(95,208,138,0.55);
	animation: wp-cam-blink 2.4s ease-in-out infinite;
}
.wp-cam-live.offline {
	background: rgba(255,255,255,0.15);
	box-shadow: none;
	animation: none;
}
@keyframes wp-cam-blink {
	0%,100% { opacity: 1; }
	50%      { opacity: 0.3; }
}

/* ── Activity log ─────────────────────────────────────────────── */
.wp-log {
	width: 100%;
	background: rgba(255,255,255,0.018);
	border: 1px solid rgba(255,255,255,0.06);
	border-radius: 8px;
	overflow: hidden;
}
.wp-log-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 8px 14px;
	border-bottom: 1px solid rgba(255,255,255,0.05);
	font-size: 10px;
	font-weight: 800;
	letter-spacing: 0.06em;
	text-transform: uppercase;
	color: rgba(255,255,255,0.35);
}
.wp-log-badge {
	font-size: 10px;
	font-weight: 600;
	color: rgba(255,255,255,0.25);
	letter-spacing: 0;
	text-transform: none;
}
.wp-log-list {
	max-height: 200px;
	overflow-y: auto;
	scrollbar-width: thin;
	scrollbar-color: rgba(255,255,255,0.08) transparent;
}
.wp-log-row {
	display: grid;
	grid-template-columns: 64px 1fr 42px;
	gap: 8px;
	align-items: start;
	padding: 6px 14px;
	border-bottom: 1px solid rgba(255,255,255,0.03);
	transition: background 0.1s;
}
.wp-log-row.wp-log-row--new {
	animation: wp-log-in 0.35s ease;
}
@keyframes wp-log-in {
	from { opacity: 0; transform: translateY(-4px); }
	to   { opacity: 1; transform: translateY(0); }
}
.wp-log-row:last-child { border-bottom: none; }
.wp-log-row:hover { background: rgba(255,255,255,0.025); }
.wp-log-type {
	font-size: 9px;
	font-weight: 800;
	letter-spacing: 0.05em;
	text-transform: uppercase;
	color: rgba(255,255,255,0.22);
	padding-top: 2px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.wp-log-summary {
	font-size: 12px;
	color: rgba(255,255,255,0.65);
	line-height: 1.45;
	overflow: hidden;
	display: -webkit-box;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
}
.wp-log-time {
	font-size: 10px;
	color: rgba(255,255,255,0.2);
	padding-top: 2px;
	text-align: right;
	white-space: nowrap;
}
.wp-log-empty {
	padding: 20px 14px;
	font-size: 12px;
	color: rgba(255,255,255,0.25);
	text-align: center;
	font-style: italic;
}

/* ── Session launcher (owner-only) ───────────────────────────────── */
.wp-launch {
	width: 100%;
	border: 1px dashed rgba(95,208,138,0.22);
	border-radius: 8px;
	background: rgba(95,208,138,0.03);
	overflow: hidden;
	transition: border-color 0.2s;
}
.wp-launch:hover { border-color: rgba(95,208,138,0.38); }
.wp-launch-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 10px 14px;
	cursor: pointer;
	user-select: none;
}
.wp-launch-title {
	display: flex;
	align-items: center;
	gap: 8px;
	font-size: 11px;
	font-weight: 700;
	letter-spacing: 0.05em;
	text-transform: uppercase;
	color: rgba(95,208,138,0.75);
}
.wp-launch-icon {
	width: 18px;
	height: 18px;
	border-radius: 50%;
	background: rgba(95,208,138,0.15);
	display: flex;
	align-items: center;
	justify-content: center;
	font-size: 10px;
	line-height: 1;
	color: #5fd08a;
	flex-shrink: 0;
}
.wp-launch-chevron {
	font-size: 10px;
	color: rgba(255,255,255,0.25);
	transition: transform 0.2s;
}
.wp-launch.open .wp-launch-chevron { transform: rotate(180deg); }
.wp-launch-body {
	display: none;
	padding: 0 14px 14px;
	flex-direction: column;
	gap: 10px;
}
.wp-launch.open .wp-launch-body { display: flex; }
.wp-launch-desc {
	font-size: 12px;
	color: rgba(255,255,255,0.45);
	line-height: 1.5;
	margin: 0;
}
.wp-launch-btn {
	display: inline-flex;
	align-items: center;
	gap: 7px;
	padding: 8px 16px;
	border-radius: 6px;
	background: rgba(95,208,138,0.12);
	border: 1px solid rgba(95,208,138,0.28);
	color: #5fd08a;
	font-size: 12px;
	font-weight: 700;
	cursor: pointer;
	transition: background 0.12s, border-color 0.12s;
	align-self: flex-start;
}
.wp-launch-btn:hover { background: rgba(95,208,138,0.22); border-color: rgba(95,208,138,0.5); }
.wp-launch-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.wp-launch-btn .spinner {
	width: 12px; height: 12px;
	border: 2px solid rgba(95,208,138,0.3);
	border-top-color: #5fd08a;
	border-radius: 50%;
	animation: wp-spin 0.7s linear infinite;
	display: none;
}
.wp-launch-btn.loading .spinner { display: block; }
.wp-launch-btn.loading .btn-label { opacity: 0.5; }
@keyframes wp-spin {
	to { transform: rotate(360deg); }
}

/* ── Session modal ───────────────────────────────────────────────── */
.wp-modal-backdrop {
	position: fixed;
	inset: 0;
	z-index: 9999;
	background: rgba(0,0,0,0.72);
	backdrop-filter: blur(12px);
	-webkit-backdrop-filter: blur(12px);
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 20px;
	animation: wp-fade-in 0.18s ease;
}
@keyframes wp-fade-in {
	from { opacity: 0; }
	to   { opacity: 1; }
}
.wp-modal {
	width: 100%;
	max-width: 620px;
	background: #0d0f18;
	border: 1px solid rgba(255,255,255,0.1);
	border-radius: 14px;
	overflow: hidden;
	box-shadow: 0 24px 80px rgba(0,0,0,0.8);
	animation: wp-slide-up 0.2s ease;
}
@keyframes wp-slide-up {
	from { transform: translateY(12px); opacity: 0; }
	to   { transform: translateY(0);    opacity: 1; }
}
.wp-modal-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 18px 20px;
	border-bottom: 1px solid rgba(255,255,255,0.07);
}
.wp-modal-title {
	font-size: 15px;
	font-weight: 700;
	color: rgba(255,255,255,0.9);
}
.wp-modal-close {
	width: 28px; height: 28px;
	border-radius: 50%;
	background: rgba(255,255,255,0.07);
	border: none;
	color: rgba(255,255,255,0.5);
	font-size: 14px;
	cursor: pointer;
	display: flex;
	align-items: center;
	justify-content: center;
	transition: background 0.12s, color 0.12s;
}
.wp-modal-close:hover { background: rgba(255,255,255,0.14); color: #fff; }
.wp-modal-body { padding: 18px 20px; display: flex; flex-direction: column; gap: 16px; }
.wp-modal-section-label {
	font-size: 10px;
	font-weight: 800;
	letter-spacing: 0.06em;
	text-transform: uppercase;
	color: rgba(255,255,255,0.3);
	margin-bottom: 6px;
}
.wp-modal-token-row {
	display: flex;
	align-items: center;
	gap: 8px;
}
.wp-modal-token {
	flex: 1;
	background: rgba(255,255,255,0.04);
	border: 1px solid rgba(255,255,255,0.08);
	border-radius: 6px;
	padding: 8px 12px;
	font-family: 'SF Mono', 'Fira Code', monospace;
	font-size: 11px;
	color: rgba(255,255,255,0.55);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	cursor: text;
	user-select: all;
}
.wp-copy-btn {
	flex-shrink: 0;
	padding: 7px 12px;
	border-radius: 6px;
	background: rgba(255,255,255,0.07);
	border: 1px solid rgba(255,255,255,0.1);
	color: rgba(255,255,255,0.6);
	font-size: 11px;
	font-weight: 600;
	cursor: pointer;
	transition: background 0.12s, color 0.12s;
	white-space: nowrap;
}
.wp-copy-btn:hover { background: rgba(255,255,255,0.14); color: #fff; }
.wp-copy-btn.copied { background: rgba(95,208,138,0.15); border-color: rgba(95,208,138,0.3); color: #5fd08a; }
.wp-modal-code-block {
	position: relative;
	background: #050508;
	border: 1px solid rgba(255,255,255,0.07);
	border-radius: 8px;
	padding: 14px 14px 10px;
	font-family: 'SF Mono', 'Fira Code', monospace;
	font-size: 11px;
	line-height: 1.65;
	color: rgba(255,255,255,0.7);
	white-space: pre;
	overflow-x: auto;
}
.wp-modal-code-copy {
	position: absolute;
	top: 8px;
	right: 8px;
}
.wp-modal-tabs {
	display: flex;
	gap: 2px;
	background: rgba(255,255,255,0.04);
	border-radius: 6px;
	padding: 3px;
}
.wp-modal-tab {
	flex: 1;
	padding: 5px 0;
	border-radius: 4px;
	font-size: 11px;
	font-weight: 700;
	text-align: center;
	cursor: pointer;
	color: rgba(255,255,255,0.4);
	transition: background 0.12s, color 0.12s;
}
.wp-modal-tab.active {
	background: rgba(255,255,255,0.1);
	color: rgba(255,255,255,0.85);
}
.wp-modal-footer {
	padding: 12px 20px 16px;
	border-top: 1px solid rgba(255,255,255,0.05);
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 10px;
}
.wp-modal-footer-note {
	font-size: 11px;
	color: rgba(255,255,255,0.28);
	line-height: 1.45;
}
.wp-modal-watch-link {
	font-size: 12px;
	font-weight: 600;
	color: #5fd08a;
	text-decoration: none;
	white-space: nowrap;
}
.wp-modal-watch-link:hover { text-decoration: underline; }
`;
	document.head.appendChild(s);
}

// ── helpers ───────────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
	'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function relTime(ts) {
	const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
	if (s < 5)  return 'now';
	if (s < 60) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	return `${Math.round(m / 60)}h`;
}

// ── activity desktop canvas (no-frame fallback) ───────────────────────────────

function paintActivityCanvas(ctx, actions, status, agentName, t) {
	const W = CW, H = CH;
	const up = '#5fd08a', dim = 'rgba(255,255,255,0.32)', faint = 'rgba(255,255,255,0.13)';
	const text = '#f0f0f4', bg0 = '#09090d', bg1 = '#0f0f14';
	const pulse = 0.5 + 0.5 * Math.sin(t * 2.8);

	// Background gradient
	const bg = ctx.createLinearGradient(0, 0, 0, H);
	bg.addColorStop(0, bg1);
	bg.addColorStop(1, bg0);
	ctx.fillStyle = bg;
	ctx.fillRect(0, 0, W, H);

	// Subtle grid overlay
	ctx.strokeStyle = 'rgba(255,255,255,0.016)';
	ctx.lineWidth = 1;
	for (let x = 0; x < W; x += 80) {
		ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
	}
	for (let y = 0; y < H; y += 80) {
		ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
	}

	// Taskbar
	ctx.fillStyle = 'rgba(255,255,255,0.035)';
	ctx.fillRect(0, 0, W, 50);
	ctx.strokeStyle = 'rgba(255,255,255,0.055)';
	ctx.lineWidth = 1;
	ctx.beginPath(); ctx.moveTo(0, 50); ctx.lineTo(W, 50); ctx.stroke();

	// Status dot
	ctx.beginPath();
	ctx.arc(28, 25, 6, 0, Math.PI * 2);
	ctx.fillStyle = status === 'live'
		? `rgba(95,208,138,${0.55 + pulse * 0.45})`
		: 'rgba(120,120,128,0.45)';
	ctx.fill();

	// Agent name
	const displayName = (agentName || 'Agent').slice(0, 30);
	ctx.font = '700 17px Inter, system-ui, sans-serif';
	ctx.fillStyle = text;
	ctx.textAlign = 'left';
	ctx.textBaseline = 'middle';
	ctx.fillText(displayName, 48, 25);
	const nameW = ctx.measureText(displayName).width;

	// Status label
	ctx.font = '500 13px Inter, system-ui, sans-serif';
	ctx.fillStyle = status === 'live' ? up : dim;
	ctx.fillText(status === 'live' ? '· live' : '· idle', 48 + nameW + 10, 25);

	// Clock
	const now = new Date();
	const clock = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
	ctx.font = '500 14px "SF Mono", "Fira Code", monospace';
	ctx.fillStyle = dim;
	ctx.textAlign = 'right';
	ctx.fillText(clock, W - 20, 25);
	ctx.textAlign = 'left';

	// Terminal window
	const pad = 28;
	const winX = pad, winY = 66, winW = W - pad * 2, winH = H - 66 - pad;
	const r = 9;

	ctx.fillStyle = '#0b0b10';
	ctx.beginPath();
	roundRect(ctx, winX, winY, winW, winH, r);
	ctx.fill();
	ctx.strokeStyle = 'rgba(255,255,255,0.055)';
	ctx.lineWidth = 1;
	ctx.stroke();

	// Titlebar
	const tbH = 36;
	ctx.fillStyle = 'rgba(255,255,255,0.028)';
	ctx.beginPath();
	roundRect(ctx, winX, winY, winW, tbH, [r, r, 0, 0]);
	ctx.fill();
	ctx.strokeStyle = 'rgba(255,255,255,0.048)';
	ctx.beginPath(); ctx.moveTo(winX, winY + tbH); ctx.lineTo(winX + winW, winY + tbH); ctx.stroke();

	// Traffic lights
	[['#ff5f57', 16], ['#febc2e', 34], ['#28c840', 52]].forEach(([c, x]) => {
		ctx.beginPath();
		ctx.arc(winX + x, winY + tbH / 2, 5, 0, Math.PI * 2);
		ctx.fillStyle = c;
		ctx.fill();
	});

	// Window title
	ctx.font = '500 12px Inter, system-ui, sans-serif';
	ctx.fillStyle = faint;
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(`${displayName} — activity log`, winX + winW / 2, winY + tbH / 2);
	ctx.textAlign = 'left';

	// Terminal lines
	const lineH = 34;
	const cX = winX + 22;
	let lY = winY + tbH + 26;
	const maxLines = Math.floor((winH - tbH - 54) / lineH);

	ctx.textBaseline = 'alphabetic';

	if (!actions.length) {
		ctx.font = '500 15px "SF Mono", "Fira Code", "Courier New", monospace';
		ctx.fillStyle = faint;
		ctx.fillText('> awaiting agent activity…', cX, lY);
		if (Math.sin(t * 4.5) > 0) {
			const cw = ctx.measureText('> awaiting agent activity…').width;
			ctx.fillStyle = 'rgba(255,255,255,0.25)';
			ctx.fillRect(cX + cw + 3, lY - 14, 9, 17);
		}
	} else {
		actions.slice(0, maxLines).forEach((a, i) => {
			const latest = i === 0;
			const age = Math.max(0, Math.round((Date.now() - (a.ts || Date.now())) / 1000));
			const ts = age < 5 ? 'now' : age < 60 ? `${age}s` : `${Math.round(age / 60)}m`;

			// Timestamp prefix
			ctx.font = '600 12px "SF Mono", "Fira Code", "Courier New", monospace';
			ctx.fillStyle = latest ? up : 'rgba(255,255,255,0.16)';
			const prefix = `[${ts}] `;
			ctx.fillText(prefix, cX, lY + i * lineH);
			const pw = ctx.measureText(prefix).width;

			// Summary
			ctx.font = `${latest ? '600' : '400'} 14px "SF Mono", "Fira Code", "Courier New", monospace`;
			ctx.fillStyle = latest ? text : dim;
			const raw = (a.summary || a.type || 'action');
			const avail = winW - pw - 40;
			// Truncate to fit
			let summary = raw;
			while (summary.length > 4 && ctx.measureText(summary).width > avail) {
				summary = summary.slice(0, -4) + '…';
			}
			ctx.fillText(summary, cX + pw, lY + i * lineH);

			// Blinking cursor on latest line
			if (latest && Math.sin(t * 4.5) > 0) {
				const tw = pw + ctx.measureText(summary).width;
				ctx.fillStyle = up;
				ctx.fillRect(cX + tw + 3, lY + i * lineH - 13, 7, 15);
			}
		});
	}

	// Status bar
	const sbY = winY + winH - 26;
	ctx.fillStyle = 'rgba(95,208,138,0.055)';
	ctx.fillRect(winX + 1, sbY, winW - 2, 25);
	ctx.strokeStyle = 'rgba(255,255,255,0.04)';
	ctx.beginPath(); ctx.moveTo(winX, sbY); ctx.lineTo(winX + winW, sbY); ctx.stroke();
	ctx.font = '500 11px Inter, system-ui, sans-serif';
	ctx.textBaseline = 'middle';
	ctx.fillStyle = 'rgba(95,208,138,0.55)';
	ctx.fillText(`three.ws · ${actions.length || 0} actions`, cX, sbY + 13);
	ctx.textAlign = 'right';
	ctx.fillStyle = faint;
	ctx.fillText('powered by three.ws', winX + winW - 10, sbY + 13);
	ctx.textAlign = 'left';
}

function roundRect(ctx, x, y, w, h, r) {
	const tl = Array.isArray(r) ? r[0] : r;
	const tr = Array.isArray(r) ? (r[1] ?? r[0]) : r;
	const br = Array.isArray(r) ? (r[2] ?? r[0]) : r;
	const bl = Array.isArray(r) ? (r[3] ?? r[0]) : r;
	ctx.beginPath();
	ctx.moveTo(x + tl, y);
	ctx.arcTo(x + w, y,     x + w, y + h, tr);
	ctx.arcTo(x + w, y + h, x,     y + h, br);
	ctx.arcTo(x,     y + h, x,     y,     bl);
	ctx.arcTo(x,     y,     x + w, y,     tl);
	ctx.closePath();
}

// ── WatchPanel class ──────────────────────────────────────────────────────────

class WatchPanel {
	constructor(el, { agentId, agentName, avatarUrl, isOwner }) {
		this.el        = el;
		this.agentId   = agentId;
		this.agentName = agentName;
		this.avatarUrl = avatarUrl || '/avatars/mannequin.glb';
		this.isOwner   = isOwner;

		this._es              = null;
		this._destroyed       = false;
		this._actions         = [];
		this._streamStatus    = 'connecting';
		this._lastFrameAt     = 0;
		this._frameTimeoutId  = null;
		this._activityPollId  = null;
		this._fetchingActivity = false;

		// Canvas loop
		this._rafId          = null;
		this._t              = 0;
		this._lastCanvasPaint = 0;

		// Webcam
		this._webcamRafId    = null;
		this._webcamRenderer = null;
		this._webcamScene    = null;
		this._webcamCamera   = null;
		this._webcamMixer    = null;

		this._buildDOM();
	}

	_buildDOM() {
		this.el.innerHTML = `
<div class="wp-root">
  <div class="wp-stage">
    <div class="wp-screen-wrap">
      <canvas class="wp-screen-canvas" id="wp-canvas" width="${CW}" height="${CH}"></canvas>
      <div class="wp-screen-bezel"></div>
      <div class="wp-screen-badge">
        <div class="wp-screen-badge-dot offline" id="wp-dot"></div>
        <span id="wp-badge-label">Connecting</span>
      </div>
      <a class="wp-screen-fullview" href="/agent-screen?agentId=${encodeURIComponent(this.agentId)}" aria-label="Open the full live viewer" title="Open full view">⤢ Full view</a>
      <button class="wp-screen-expand" aria-label="Fullscreen">⛶</button>
    </div>
    <div class="wp-cam-wrap" id="wp-cw">
      <video class="wp-cam-video" id="wp-video" autoplay muted playsinline></video>
      <div class="wp-cam-bezel"></div>
      <div class="wp-cam-scanlines"></div>
      <div class="wp-cam-label">${esc(this.agentName || 'Agent')}</div>
      <div class="wp-cam-live offline" id="wp-cam-live"></div>
    </div>
  </div>
  <div class="wp-log">
    <div class="wp-log-head">
      <span>Activity log</span>
      <span class="wp-log-badge" id="wp-log-count">—</span>
    </div>
    <div class="wp-log-list" id="wp-log-list">
      <div class="wp-log-empty">Loading…</div>
    </div>
  </div>
  ${this.isOwner ? `
  <div class="wp-launch" id="wp-launch">
    <div class="wp-launch-head" id="wp-launch-head">
      <div class="wp-launch-title">
        <div class="wp-launch-icon">▶</div>
        Start Live Session
      </div>
      <div class="wp-launch-chevron">▾</div>
    </div>
    <div class="wp-launch-body">
      <p class="wp-launch-desc">
        Connect a Playwright browser to this agent's screen stream.
        Generate credentials then run the caster anywhere — locally, on Docker, or Cloud Run.
      </p>
      <button class="wp-launch-btn" id="wp-launch-btn">
        <div class="spinner"></div>
        <span class="btn-label">Generate credentials</span>
      </button>
    </div>
  </div>` : ''}
</div>`;

		this._canvas   = this.el.querySelector('#wp-canvas');
		this._ctx      = this._canvas.getContext('2d');
		this._dot      = this.el.querySelector('#wp-dot');
		this._badge    = this.el.querySelector('#wp-badge-label');
		this._video    = this.el.querySelector('#wp-video');
		this._logList  = this.el.querySelector('#wp-log-list');
		this._logCount = this.el.querySelector('#wp-log-count');
		this._camLive  = this.el.querySelector('#wp-cam-live');

		this.el.querySelector('.wp-screen-expand').addEventListener('click', () => {
			const wrap = this.el.querySelector('.wp-screen-wrap');
			(wrap.requestFullscreen || wrap.webkitRequestFullscreen || (() => {})).call(wrap);
		});

		if (this.isOwner) {
			this.el.querySelector('#wp-launch-head').addEventListener('click', () => {
				this.el.querySelector('#wp-launch').classList.toggle('open');
			});
			this.el.querySelector('#wp-launch-btn').addEventListener('click', () => this._generateSession());
		}
	}

	// ── Session launcher ──────────────────────────────────────────────────────

	async _generateSession() {
		const btn = this.el.querySelector('#wp-launch-btn');
		if (!btn || btn.disabled) return;
		btn.disabled = true;
		btn.classList.add('loading');
		try {
			const res = await fetch(SESSION_URL(), {
				method: 'POST',
				credentials: 'include',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ agentId: this.agentId }),
			});
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.message || `HTTP ${res.status}`);
			}
			const data = await res.json();
			this._showSessionModal(data);
		} catch (err) {
			alert('Could not generate session: ' + err.message);
		} finally {
			btn.disabled = false;
			btn.classList.remove('loading');
		}
	}

	_showSessionModal({ token, agentName, expiresAt, streamUrl, commands }) {
		const expires = new Date(expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

		const backdrop = document.createElement('div');
		backdrop.className = 'wp-modal-backdrop';
		backdrop.innerHTML = `
<div class="wp-modal" role="dialog" aria-modal="true" aria-label="Launch session">
  <div class="wp-modal-head">
    <div class="wp-modal-title">Launch screen session — ${esc(agentName || 'Agent')}</div>
    <button class="wp-modal-close" aria-label="Close">✕</button>
  </div>
  <div class="wp-modal-body">
    <div>
      <div class="wp-modal-section-label">Bearer token (valid until ${expires})</div>
      <div class="wp-modal-token-row">
        <div class="wp-modal-token" title="${esc(token)}">${esc(token.slice(0, 48))}…</div>
        <button class="wp-copy-btn" data-copy="${esc(token)}">Copy</button>
      </div>
    </div>
    <div>
      <div class="wp-modal-section-label">Launch command</div>
      <div class="wp-modal-tabs">
        <div class="wp-modal-tab active" data-tab="node">Node</div>
        <div class="wp-modal-tab" data-tab="docker">Docker</div>
      </div>
      <div id="wp-modal-code-wrap">
        <div class="wp-modal-code-block" id="wp-modal-code">${esc(commands.node)}<button class="wp-copy-btn wp-modal-code-copy" data-copy="${esc(commands.node)}">Copy</button></div>
      </div>
    </div>
  </div>
  <div class="wp-modal-footer">
    <div class="wp-modal-footer-note">
      Runs a Playwright browser that streams frames here in real-time.<br>
      Swap <code>TASK_ARG</code> for any token address or task target.
    </div>
    <a class="wp-modal-watch-link" href="${esc(streamUrl)}" target="_blank" rel="noopener">Open full screen →</a>
  </div>
</div>`;

		document.body.appendChild(backdrop);

		const close = () => backdrop.remove();
		backdrop.querySelector('.wp-modal-close').addEventListener('click', close);
		backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
		document.addEventListener('keydown', function esc(e) {
			if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
		});

		// Tab switching
		const tabs   = backdrop.querySelectorAll('.wp-modal-tab');
		const codeEl = backdrop.querySelector('#wp-modal-code');
		tabs.forEach((tab) => {
			tab.addEventListener('click', () => {
				tabs.forEach((t) => t.classList.remove('active'));
				tab.classList.add('active');
				const cmd = tab.dataset.tab === 'docker' ? commands.docker : commands.node;
				codeEl.innerHTML = `${esc(cmd)}<button class="wp-copy-btn wp-modal-code-copy" data-copy="${esc(cmd)}">Copy</button>`;
				codeEl.querySelector('.wp-copy-btn').addEventListener('click', (e) => copyHandler(e.currentTarget));
			});
		});

		// Copy buttons
		const copyHandler = (btn) => {
			const text = btn.dataset.copy;
			navigator.clipboard.writeText(text).then(() => {
				const orig = btn.textContent;
				btn.textContent = 'Copied!';
				btn.classList.add('copied');
				setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1800);
			});
		};
		backdrop.querySelectorAll('.wp-copy-btn').forEach((b) => {
			b.addEventListener('click', () => copyHandler(b));
		});
	}

	async start() {
		this._connectStream();
		this._startCanvasLoop();
		this._startActivityPoll();
		this._startWatchIntent();
		await this._bootWebcam();
	}

	// Signal that this agent is being actively watched so the on-demand caster
	// pool (workers/agent-screen-pool) spins up a real browser feed for it. The
	// panel works fully without the pool — this just upgrades to live pixels.
	_startWatchIntent() {
		const ping = () => {
			if (this._destroyed || document.hidden) return;
			try {
				fetch('/api/agent/watch-intent', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ agentId: this.agentId }),
					keepalive: true,
				}).catch(() => {});
			} catch { /* */ }
		};
		ping();
		this._watchIntentId = setInterval(ping, 20_000);
	}

	// ── SSE connection ────────────────────────────────────────────────────────

	_connectStream() {
		try { this._es?.close(); } catch { /* */ }
		const es = new EventSource(STREAM_URL(this.agentId));
		this._es = es;

		es.addEventListener('frame', (e) => {
			try {
				const msg = JSON.parse(e.data);
				if (msg.data) this._renderFrame(msg.data);
				if (msg.activity) {
					this._injectAction({ ts: msg.ts || Date.now(), type: msg.type || 'activity', summary: msg.activity });
				}
				this._bumpFrameTimeout();
				this._setStatus('live');
			} catch { /* malformed */ }
		});

		es.addEventListener('log', (e) => {
			try {
				const { entries } = JSON.parse(e.data);
				if (Array.isArray(entries) && entries.length) {
					this._actions = entries.map((en) => ({
						ts:      en.ts || Date.now(),
						type:    en.type || 'activity',
						summary: en.activity || '',
					}));
					this._renderLog();
				}
			} catch { /* malformed */ }
		});

		es.addEventListener('dark', () => {
			if (this._streamStatus !== 'connecting') this._setStatus('idle');
		});

		es.addEventListener('ping', () => {
			if (this._streamStatus !== 'live') this._setStatus('idle');
		});

		es.onerror = () => { this._setStatus('idle'); };
	}

	_bumpFrameTimeout() {
		this._lastFrameAt = Date.now();
		clearTimeout(this._frameTimeoutId);
		this._frameTimeoutId = setTimeout(() => {
			if (!this._destroyed) this._setStatus('idle');
		}, FRAME_TIMEOUT_MS);
	}

	// ── Status ────────────────────────────────────────────────────────────────

	_setStatus(s) {
		this._streamStatus = s;
		const live = s === 'live';
		this._dot.classList.toggle('offline', !live);
		this._badge.textContent = live ? 'Live' : s === 'idle' ? 'Idle' : 'Connecting';
		this._camLive.classList.toggle('offline', !live);
	}

	// ── Frame rendering ───────────────────────────────────────────────────────

	_renderFrame(dataOrB64) {
		if (this._destroyed) return;
		const img = new Image();
		img.onload = () => {
			if (this._destroyed) return;
			this._ctx.drawImage(img, 0, 0, CW, CH);
		};
		img.src = dataOrB64.startsWith('data:') ? dataOrB64 : 'data:image/png;base64,' + dataOrB64;
	}

	// ── Canvas loop (idle activity view) ──────────────────────────────────────

	_startCanvasLoop() {
		const loop = (ts) => {
			if (this._destroyed) return;
			this._rafId = requestAnimationFrame(loop);
			this._t = ts / 1000;

			// Skip canvas repaint when live frames are flowing — they draw directly.
			if (this._streamStatus === 'live') return;

			// Cap idle repaints at ~10fps.
			if (ts - this._lastCanvasPaint < IDLE_CANVAS_INTERVAL_MS) return;
			this._lastCanvasPaint = ts;

			paintActivityCanvas(this._ctx, this._actions, this._streamStatus, this.agentName, this._t);
		};
		this._rafId = requestAnimationFrame(loop);
	}

	// ── Activity polling ──────────────────────────────────────────────────────

	_startActivityPoll() {
		const poll = async () => {
			if (this._destroyed || this._fetchingActivity || this._activityDenied) return;
			this._fetchingActivity = true;
			try {
				const r = await fetch(ACTIONS_URL(this.agentId), { credentials: 'include' });
				if (r.status === 401 || r.status === 403) {
					// The actions feed needs auth. Stop polling — every retry would
					// 401 identically — and replace the initial "Loading…" row with
					// an honest state instead of leaving it spinning forever.
					this._activityDenied = true;
					if (this._activityPollId) { clearInterval(this._activityPollId); this._activityPollId = null; }
					if (this._logCount) this._logCount.textContent = '—';
					if (this._logList) {
						this._logList.innerHTML =
							'<div class="wp-log-empty">Sign in to see this agent’s action log</div>';
					}
				} else if (r.ok) {
					const d = await r.json();
					const rows = d?.data?.actions || d?.actions || [];
					// Only replace if server has newer entries than what the SSE pushed,
					// but always render — an empty success is "No activity yet", not an
					// eternal "Loading…".
					if (rows.length >= this._actions.length) this._actions = rows;
					this._renderLog();
				}
			} catch { /* non-critical */ }
			this._fetchingActivity = false;
		};

		// First load immediately, then on interval.
		poll();
		this._activityPollId = setInterval(poll, ACTIVITY_POLL_MS);
	}

	_injectAction(action) {
		// Prepend a new action from the live SSE, avoiding duplicates.
		const exists = this._actions.some((a) => a.ts === action.ts && a.summary === action.summary);
		if (!exists) {
			this._actions = [action, ...this._actions].slice(0, 50);
			this._renderLog(true);
		}
	}

	// ── Log rendering ─────────────────────────────────────────────────────────

	_renderLog(animate = false) {
		const actions = this._actions;
		this._logCount.textContent = actions.length ? `${actions.length} action${actions.length !== 1 ? 's' : ''}` : '—';
		if (!actions.length) {
			this._logList.innerHTML = '<div class="wp-log-empty">No activity yet</div>';
			return;
		}
		this._logList.innerHTML = actions.map((a, i) => `
<div class="wp-log-row${animate && i === 0 ? ' wp-log-row--new' : ''}">
  <div class="wp-log-type">${esc((a.type || 'action').slice(0, 12))}</div>
  <div class="wp-log-summary">${esc(a.summary || a.type || '')}</div>
  <div class="wp-log-time">${relTime(a.ts || Date.now())}</div>
</div>`).join('');
	}

	// ── Webcam ────────────────────────────────────────────────────────────────

	async _bootWebcam() {
		const wrap = this.el.querySelector('#wp-cw');
		if (!wrap) return;

		try {
			const loader = new GLTFLoader();
			loader.setMeshoptDecoder(await getMeshoptDecoder());
			const gltf = await loader.loadAsync(this.avatarUrl);
			if (this._destroyed) return;

			const model = cloneSkinnedScene(gltf.scene);

			const webcamScene = new Scene();
			// Three-point lighting for a webcam-style portrait.
			const key = new DirectionalLight(0xfff4e8, 1.4);
			key.position.set(1.2, 2.2, 1.8);
			webcamScene.add(key);
			const fill = new DirectionalLight(0xc8d8ff, 0.5);
			fill.position.set(-2, 1.0, 0.5);
			webcamScene.add(fill);
			const rim = new DirectionalLight(0xffffff, 0.35);
			rim.position.set(0, 0.5, -2);
			webcamScene.add(rim);
			webcamScene.add(new AmbientLight(0x111118, 0.9));
			webcamScene.add(model);

			// Compute model bounding box to position the camera at face height.
			const box = new Box3().setFromObject(model);
			const headY = box.max.y * 0.88; // approximate eye line

			const cam = new PerspectiveCamera(34, 3 / 4, 0.01, 20);
			cam.position.set(0, headY, 0.6);
			cam.lookAt(0, headY * 0.97, 0);

			const renderer = new WebGLRenderer({ antialias: true, alpha: false });
			renderer.setClearColor(0x0a0a0d, 1);
			renderer.setSize(360, 480);
			renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

			this._webcamRenderer = renderer;
			this._webcamScene    = webcamScene;
			this._webcamCamera   = cam;
			this._webcamBasePos  = { x: 0, y: headY, z: 0.6 };

			// Drive animation — prefer GLB's own clips; fall back to procedural camera bob.
			if (gltf.animations?.length) {
				const mixer = new AnimationMixer(model);
				this._webcamMixer = mixer;
				// Pick idle-ish clip: prefer 'idle', then 'Idle', then first clip.
				const idleClip = gltf.animations.find((c) =>
					/idle/i.test(c.name)) ?? gltf.animations[0];
				const action = mixer.clipAction(idleClip);
				action.play();
			}

			// Tick loop
			let last = 0;
			const tick = (ts) => {
				if (this._destroyed) return;
				this._webcamRafId = requestAnimationFrame(tick);
				const dt = Math.min((ts - last) / 1000, 0.1);
				last = ts;

				// Subtle procedural camera bob — 3-axis micro-sway for life.
				const sec = ts / 1000;
				const { x: bx, y: by, z: bz } = this._webcamBasePos;
				cam.position.set(
					bx + Math.sin(sec * 0.37) * 0.004,
					by + Math.sin(sec * 0.22) * 0.006,
					bz + Math.sin(sec * 0.51) * 0.003,
				);
				cam.lookAt(
					Math.sin(sec * 0.28) * 0.003,
					(by * 0.97) + Math.sin(sec * 0.18) * 0.004,
					0,
				);

				if (this._webcamMixer) this._webcamMixer.update(dt);
				renderer.render(webcamScene, cam);
			};
			this._webcamRafId = requestAnimationFrame(tick);

			// Stream canvas → video element.
			const stream = renderer.domElement.captureStream?.(15);
			if (stream && this._video) {
				this._video.srcObject = stream;
				await this._video.play().catch(() => {});
			}
		} catch {
			// Webcam unavailable — collapse the cam pane and stretch the screen.
			const cw = this.el.querySelector('#wp-cw');
			if (cw) cw.style.display = 'none';
			const stage = this.el.querySelector('.wp-stage');
			if (stage) stage.style.gridTemplateColumns = '1fr';
		}
	}

	// ── Teardown ──────────────────────────────────────────────────────────────

	destroy() {
		this._destroyed = true;
		cancelAnimationFrame(this._rafId);
		cancelAnimationFrame(this._webcamRafId);
		clearTimeout(this._frameTimeoutId);
		clearInterval(this._activityPollId);
		clearInterval(this._watchIntentId);
		try { this._es?.close(); } catch { /* */ }
		this._webcamMixer?.stopAllAction?.();
		this._webcamRenderer?.dispose?.();
	}
}

// ── public factory ────────────────────────────────────────────────────────────

/**
 * Mount the watch panel into `container`.
 *
 * @param {{ agentId:string, agentName?:string, avatarUrl?:string, isOwner?:boolean,
 *           container:HTMLElement, position?:'append'|'prepend' }} opts
 * @returns {Promise<{destroy():void}|null>}
 */
export async function mountWatchPanel({
	agentId, agentName, avatarUrl, isOwner = false,
	container, position = 'append',
} = {}) {
	if (!agentId || !container) return null;

	injectStyles();

	const root = document.createElement('div');
	root.className = 'watch-panel-root';
	if (position === 'prepend') container.prepend(root);
	else container.append(root);

	const panel = new WatchPanel(root, { agentId, agentName, avatarUrl, isOwner });
	await panel.start();

	return { destroy: () => { panel.destroy(); root.remove(); } };
}
