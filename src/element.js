// <agent-3d> — the web component that ships the whole framework in one tag.
// See specs/EMBED_SPEC.md

import { Box3 } from 'three';
import { Viewer } from './viewer.js';
import { Runtime, skillAccessFromAgentDetail } from './runtime/index.js';
import { SkillPaymentModal, PaymentChip } from './payment-modal.js';
import { SceneController } from './runtime/scene.js';
import { SkillRegistry } from './skills/index.js';
import { Memory } from './memory/index.js';
import { loadManifest, fetchRelative } from './manifest.js';
import { resolveURI } from './ipfs.js';
import {
	resolveAgentById,
	resolveByAgentId,
	resolveByAvatarId,
	AgentResolveError,
} from './agent-resolver.js';
import { parseAgentRef, resolveOnchainAgent, toManifest } from './erc8004/resolver.js';
import { attachTradeReactions } from './pump/trade-reactions.js';
// BEGIN:EMBED_BRIDGES_IMPORT
import { EmbedActionBridge } from './embed-action-bridge.js';
import { protocol, ACTION_TYPES } from './agent-protocol.js';
import { AgentAvatar } from './agent-avatar.js';
// END:EMBED_BRIDGES_IMPORT
import { AgentNotifier } from './agent-notifier.js';

const MODES = ['inline', 'floating', 'section', 'fullscreen'];

// ── WebGL context budget ────────────────────────────────────────────────
// Browsers cap the number of simultaneous WebGL contexts (~16 in Chrome).
// Each booted <agent-3d> holds one (two when axes are shown) for its whole
// lifetime, so a page with many avatars — a showcase grid, a marketplace, a
// long landing page — silently exhausts the budget. The browser then evicts
// the *oldest* context ("Too many active WebGL contexts. Oldest context will
// be lost.") and that avatar freezes or turns blank, with no way to recover
// while every other context stays alive.
//
// We cap the number of *live* viewers instead. When a new one boots over
// budget, the least-recently-visible offscreen viewer releases its context
// (full teardown → forceContextLoss) and re-arms its viewport observer, so it
// re-boots automatically the moment it scrolls back into view. Whatever the
// user is actually looking at is never evicted.
const MAX_LIVE_VIEWERS = (() => {
	try {
		const n = Number(
			typeof window !== 'undefined' ? window.AGENT3D_MAX_LIVE_VIEWERS : 0,
		);
		if (Number.isFinite(n) && n > 0) return Math.floor(n);
	} catch {}
	return 8;
})();
const _liveViewers = new Set();
const _nowMs = () =>
	typeof performance !== 'undefined' && performance.now
		? performance.now()
		: Date.now();

function _trackLiveViewer(el) {
	_liveViewers.add(el);
	_enforceViewerBudget(el);
}

function _untrackLiveViewer(el) {
	_liveViewers.delete(el);
}

// Standalone renderers elsewhere on the page (homepage avatar-drop, walk
// preview, footer bot, …) reserve slots via window.__agent3dReservedContexts
// (see webgl-budget.js). Subtract them so the page-wide total stays under the
// browser's ~16-context cap, never below one live viewer.
function _effectiveViewerBudget() {
	let reserved = 0;
	try {
		const n = Number(
			typeof window !== 'undefined' ? window.__agent3dReservedContexts : 0,
		);
		if (Number.isFinite(n) && n > 0) reserved = Math.floor(n);
	} catch {}
	return Math.max(1, MAX_LIVE_VIEWERS - reserved);
}

function _enforceViewerBudget(justBooted) {
	const budget = _effectiveViewerBudget();
	if (_liveViewers.size <= budget) return;
	const evictable = [];
	for (const v of _liveViewers) {
		if (v !== justBooted && v._isEvictable && v._isEvictable()) evictable.push(v);
	}
	// Least-recently-visible first.
	evictable.sort((a, b) => (a._lastVisibleAt || 0) - (b._lastVisibleAt || 0));
	let over = _liveViewers.size - budget;
	for (const v of evictable) {
		if (over <= 0) break;
		v._releaseForBudget();
		over--;
	}
}

// Let standalone renderers trigger an eviction the moment they reserve a slot,
// instead of waiting for the next viewer to boot.
if (typeof window !== 'undefined') {
	window.__agent3dEnforceBudget = () => {
		try {
			_enforceViewerBudget(null);
		} catch {}
	};
}

function _parsePx(val) {
	const n = parseFloat(val);
	return n > 0 && typeof val === 'string' && val.trim().endsWith('px') ? n : 0;
}

// Derive the origin of the script itself so cross-origin embeds hit the right API.
const _scriptOrigin = (() => {
	try {
		return new URL(import.meta.url).origin;
	} catch {
		return '';
	}
})();

function originAllowed(originUrl, policy, firstParty = []) {
	if (!originUrl) return false;
	let host;
	try {
		host = new URL(originUrl).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (firstParty.some((fp) => host === fp || host.endsWith('.' + fp))) return true;
	const hosts = policy?.origins?.hosts ?? [];
	const mode = policy?.origins?.mode ?? 'allowlist';
	const matches = hosts.some((h) => {
		const lower = h.toLowerCase();
		if (lower.startsWith('*.')) return host.endsWith(lower.slice(1)) && host !== lower.slice(2);
		return host === lower;
	});
	return mode === 'allowlist' ? matches : !matches;
}

const BASE_STYLE = `
	:host {
		display: block;
		position: relative;
		width: 100%;
		height: 480px;
		--agent-bubble-radius: 16px;
		--agent-accent: #3b82f6;
		--agent-surface: rgba(17, 24, 39, 0.92);
		--agent-on-surface: #f9fafb;
		--agent-chat-font: system-ui, -apple-system, sans-serif;
		--agent-mic-glow: #22c55e;
		--agent-shadow: 0 20px 60px rgba(0,0,0,0.3);
		--agent-bubble-bg: rgba(255, 255, 255, 0.95);
		--agent-bubble-color: #1a1a2e;
		--agent-bubble-shadow: 0 4px 24px rgba(0, 0, 0, 0.25);
		--agent-bubble-font-size: 13px;
		contain: layout style;
	}
	:host([mode="floating"]) {
		position: fixed;
		z-index: 2147483000;
		width: var(--agent-width, 320px);
		height: var(--agent-height, 420px);
		border-radius: var(--agent-bubble-radius);
		overflow: hidden;
		box-shadow: var(--agent-shadow);
		transition:
			width 0.3s cubic-bezier(0.4, 0, 0.2, 1),
			height 0.3s cubic-bezier(0.4, 0, 0.2, 1),
			border-radius 0.3s cubic-bezier(0.4, 0, 0.2, 1);
	}
	@media (prefers-reduced-motion: reduce) {
		:host([mode="floating"]) { transition: none; }
	}
	/* Inline responsive: height follows width at a 3:4 portrait ratio */
	:host([mode="inline"][data-responsive]) {
		height: auto;
		aspect-ratio: var(--agent-aspect, 3/4);
	}
	:host([mode="fullscreen"]) {
		position: fixed;
		inset: 0;
		width: 100vw;
		height: 100vh;
		height: 100dvh;
		z-index: 2147483000;
	}
	:host([hidden]) { display: none; }
	.stage {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	}
	.stage canvas { display: block; }
	/* Pill tap target — shown when collapsed to pill on narrow viewports */
	.pill-btn {
		display: none;
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		background: none;
		border: 0;
		cursor: pointer;
		border-radius: inherit;
		z-index: 10;
	}
	/* Swipe-down handle visible when bottom-sheet is expanded */
	.pill-drag {
		display: none;
		position: absolute;
		top: 8px;
		left: 50%;
		transform: translateX(-50%);
		width: 36px;
		height: 4px;
		border-radius: 2px;
		background: rgba(255,255,255,0.25);
		pointer-events: none;
		z-index: 20;
	}
	.chrome {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		padding: 12px;
		box-sizing: border-box;
		gap: 0;
		pointer-events: none;
	}
	.chrome > * { pointer-events: auto; }
	.chat {
		flex: 1;
		display: flex;
		flex-direction: column;
		overflow-y: auto;
		color: var(--agent-on-surface);
		font: 14px/1.4 var(--agent-chat-font);
		padding: 10px 12px;
		scrollbar-width: thin;
		scrollbar-color: rgba(255,255,255,0.1) transparent;
		pointer-events: none;
	}
	.chat > * { pointer-events: auto; }
	/* Transparent window in the chat — avatar canvas shows through here */
	.avatar-anchor {
		flex: 0 0 auto;
		position: sticky;
		bottom: 0;
		pointer-events: none !important;
		min-height: 260px;
		margin-top: auto;
		z-index: 1;
	}
	/* Thought bubble — appears above avatar's head while thinking */
	.thought-bubble {
		position: absolute;
		top: 0;
		left: 50%;
		background: var(--agent-bubble-bg);
		color: var(--agent-bubble-color);
		border-radius: 20px;
		padding: 8px 14px;
		font: 600 var(--agent-bubble-font-size)/1 var(--agent-chat-font);
		max-width: min(280px, 60%);
		white-space: normal;
		min-width: 80px;
		min-height: 28px;
		pointer-events: none;
		opacity: 0;
		transform: translateX(-50%) scale(0.85);
		transform-origin: center bottom;
		transition:
			opacity 0.22s cubic-bezier(0.34, 1.56, 0.64, 1),
			transform 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
		box-shadow: var(--agent-bubble-shadow);
		display: flex;
		align-items: center;
		gap: 5px;
		z-index: 16;
	}
	.thought-bubble::after {
		content: '';
		position: absolute;
		bottom: -8px;
		top: auto;
		left: 50%;
		transform: translateX(-50%);
		border-left: 8px solid transparent;
		border-right: 8px solid transparent;
		border-top: 8px solid var(--agent-bubble-bg);
		border-bottom: none;
	}
	.thought-bubble[data-tail-dir="up"]::after {
		bottom: auto;
		top: -8px;
		border-top: none;
		border-bottom: 8px solid var(--agent-bubble-bg);
	}
	.thought-bubble[data-active="true"] { opacity: 1; transform: translateX(-50%) scale(1); }
	.thought-bubble .text {
		font: var(--agent-bubble-font-size)/1.4 var(--agent-chat-font);
		color: var(--agent-bubble-color);
		display: none;
	}
	.thought-bubble[data-streaming="true"] .text { display: block; }
	.thought-bubble[data-streaming="true"] .dot { display: none; }
	.thought-bubble .dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--agent-accent);
		animation: thought-dot 1.4s ease-in-out infinite;
		flex-shrink: 0;
	}
	.thought-bubble .dot:nth-child(2) { animation-delay: 0.2s; }
	.thought-bubble .dot:nth-child(3) { animation-delay: 0.4s; }
	@keyframes thought-dot {
		0%, 60%, 100% { transform: translateY(0); opacity: 0.35; }
		30% { transform: translateY(-4px); opacity: 1; }
	}
	@media (prefers-reduced-motion: reduce) {
		.thought-bubble .dot { animation: none; opacity: 0.6; }
		@keyframes thought-dot { to {} }
	}
	.thought-bubble[data-error="true"] {
		background: rgba(239, 68, 68, 0.92);
		color: #fff;
	}
	.thought-bubble[data-error="true"]::after {
		border-top-color: rgba(239, 68, 68, 0.92);
	}
	.thought-bubble[data-error="true"][data-tail-dir="up"]::after {
		border-bottom-color: rgba(239, 68, 68, 0.92);
		border-top-color: transparent;
	}
	.msg {
		margin: 6px 0;
		padding: 8px 12px;
		border-radius: 12px;
		border-left: 3px solid transparent;
		transition: border-color .2s;
		background: var(--agent-surface);
		backdrop-filter: blur(8px);
		max-width: 85%;
	}
	.msg.user {
		align-self: flex-end;
		background: rgba(255, 255, 255, 0.1);
		border-left: 0;
		border-right: 3px solid var(--agent-accent);
	}
	.msg.assistant {
		align-self: flex-start;
	}
	.msg.celebration { border-left-color: rgba(34,197,94,0.85); background: rgba(34,197,94,0.12); }
	.msg.concern { border-left-color: rgba(239,68,68,0.85); background: rgba(239,68,68,0.06); }
	.msg.curiosity { border-left-color: rgba(59,130,246,0.7); background: rgba(59,130,246,0.05); }
	.msg .role { opacity: 0.55; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
	.msg .body { white-space: pre-wrap; }
	.msg .body code { font-family: monospace; background: rgba(255,255,255,0.08); padding: 1px 4px; border-radius: 4px; font-size: 12px; }
	.msg .body strong { font-weight: 700; }
	.msg .body em { font-style: italic; opacity: 0.9; }
	.msg.streaming .body::after { content: '▋'; opacity: 1; animation: blink-cursor 0.7s step-end infinite; margin-left: 2px; }
	@keyframes blink-cursor { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
	/* Suggestion chips when the conversation is empty */
	.suggest-row { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 0 0; }
	.suggest-chip { font: 600 11px/1 var(--agent-chat-font); color: var(--agent-on-surface); background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1); padding: 6px 10px; border-radius: 999px; cursor: pointer; transition: all .12s; }
	.suggest-chip:hover { background: rgba(255,255,255,.12); border-color: rgba(255,255,255,.18); }
	/* Tool-call indicator near the bottom of the canvas */
	.tool-indicator { position: absolute; left: 50%; bottom: 96px; transform: translateX(-50%); display: none; align-items: center; gap: 8px; padding: 6px 12px; background: var(--agent-surface); color: var(--agent-on-surface); border-radius: 999px; font: 12px var(--agent-chat-font); backdrop-filter: blur(12px); pointer-events: none; opacity: 0; transition: opacity .15s; z-index: 3; }
	.tool-indicator[data-active="true"] { display: inline-flex; opacity: 1; }
	.tool-indicator .spin { width: 10px; height: 10px; border-radius: 50%; border: 2px solid rgba(255,255,255,.25); border-top-color: var(--agent-accent); animation: spin .9s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
	/* Sticky alert banner (e.g. rug flag) */
	.alert-banner { position: absolute; top: 12px; left: 12px; right: 12px; padding: 8px 12px; border-radius: 10px; font: 600 12px/1.4 var(--agent-chat-font); display: none; align-items: center; gap: 8px; backdrop-filter: blur(12px); z-index: 3; }
	.alert-banner[data-active="true"] { display: flex; }
	.alert-banner.warn { background: rgba(234,179,8,.15); color: #fde68a; border: 1px solid rgba(234,179,8,.4); }
	.alert-banner.danger { background: rgba(239,68,68,.18); color: #fecaca; border: 1px solid rgba(239,68,68,.4); }
	.alert-banner button { background: none; border: 0; color: inherit; font: 600 14px var(--agent-chat-font); cursor: pointer; padding: 0 4px; opacity: .7; }
	.alert-banner button:hover { opacity: 1; }
	/* Rich token card unfurl rendered inline in chat */
	.token-card { margin: 6px 0; padding: 10px 12px; background: rgba(0,0,0,.25); border: 1px solid rgba(255,255,255,.08); border-radius: 10px; font: 12px var(--agent-chat-font); color: var(--agent-on-surface); }
	.token-card.solana { border-left: 3px solid #c084fc; }
	.token-card-header { display: flex; align-items: center; gap: 8px; }
	.token-card-symbol { font: 700 14px var(--agent-chat-font); }
	.token-card-name { opacity: .7; }
	.token-card-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; margin-top: 8px; }
	.token-card-stat { display: flex; flex-direction: column; gap: 2px; }
	.token-card-stat .label { font: 600 9px/1 var(--agent-chat-font); letter-spacing: .06em; text-transform: uppercase; opacity: .5; }
	.token-card-stat .value { font: 600 13px var(--agent-chat-font); font-variant-numeric: tabular-nums; }
	.token-card-bar { margin-top: 8px; height: 6px; background: rgba(255,255,255,.08); border-radius: 999px; overflow: hidden; }
	.token-card-bar .fill { height: 100%; background: linear-gradient(90deg, #3b82f6, #c084fc); transition: width .4s; }
	.token-card-bar .fill.danger { background: linear-gradient(90deg, #f59e0b, #ef4444); }
	.token-card .flags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
	.token-card .flag { font: 600 9px/1 var(--agent-chat-font); letter-spacing: .04em; text-transform: uppercase; padding: 3px 6px; border-radius: 4px; background: rgba(239,68,68,.18); color: #fecaca; border: 1px solid rgba(239,68,68,.32); }
	.input-row {
		display: flex;
		gap: 6px;
		background: var(--agent-surface);
		border-radius: 999px;
		padding: 4px 4px 4px 14px;
		backdrop-filter: blur(12px);
		flex: 0 0 auto;
	}
	.input-row input {
		flex: 1;
		background: transparent;
		border: 0;
		color: var(--agent-on-surface);
		font: 14px var(--agent-chat-font);
		outline: none;
	}
	.input-row input:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.input-row input[data-state="thinking"] {
		opacity: 0.6;
	}
	.input-row[data-busy="true"] {
		opacity: 0.75;
	}
	button.icon {
		width: 36px;
		height: 36px;
		border-radius: 50%;
		border: 0;
		background: var(--agent-accent);
		color: white;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	button.icon.mic[data-listening="true"] { box-shadow: 0 0 0 4px var(--agent-mic-glow); }
	button.icon.mic[data-voice-state="listening"] { box-shadow: 0 0 0 4px #22c55e; }
	button.icon.mic[data-voice-state="thinking"]  { box-shadow: 0 0 0 4px #eab308; }
	button.icon.mic[data-voice-state="speaking"]  { box-shadow: 0 0 0 4px #3b82f6; }
	.poster {
		position: absolute;
		inset: 0;
		background-size: contain;
		background-position: center;
		background-repeat: no-repeat;
		transition: opacity 0.4s;
		pointer-events: none;
	}
	.loading {
		position: absolute;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		color: var(--agent-on-surface);
		font: 14px var(--agent-chat-font);
		background: var(--agent-surface);
		padding: 8px 14px;
		border-radius: 999px;
	}
	.error, .agent-3d-error {
		position: absolute;
		inset: 16px;
		display: grid;
		place-items: center;
		color: var(--agent-on-surface);
		background: var(--agent-surface);
		border-radius: 12px;
		padding: 16px;
		font: 14px var(--agent-chat-font);
	}
	/* Optional name plate overlay — toggled by the name-plate attribute. */
	.name-plate {
		position: absolute;
		left: 12px;
		bottom: 10px;
		z-index: 2;
		pointer-events: none;
		font: 11px/1 var(--agent-chat-font);
		letter-spacing: 0.04em;
		color: rgba(255, 255, 255, 0.6);
		text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
	}
	.name-plate:empty,
	:host([name-plate="off"]) .name-plate { display: none; }
	/* Background variants — set on :host so the canvas composites over them. */
	:host([background="transparent"]) { background: transparent; }
	:host([background="transparent"]) .thought-bubble {
		border: 1px solid rgba(0, 0, 0, 0.08);
		box-shadow: 0 4px 24px rgba(0, 0, 0, 0.18), 0 1px 3px rgba(0, 0, 0, 0.12);
	}
	:host([background="dark"]) { background: #0b0d10; }
	:host([background="light"]) { background: #f5f5f5; }
	:host([background="light"]) .name-plate {
		color: rgba(0, 0, 0, 0.55);
		text-shadow: none;
	}
	:host([background="light"]) .thought-bubble {
		background: rgba(30, 30, 50, 0.92);
		color: #f9fafb;
	}
	:host([background="light"]) .thought-bubble::after {
		border-top-color: rgba(30, 30, 50, 0.92);
	}
	:host([background="light"]) .thought-bubble[data-tail-dir="up"]::after {
		border-bottom-color: rgba(30, 30, 50, 0.92);
	}
	:host([background="light"]) .thought-bubble .text {
		color: #f9fafb;
	}
	:host([background="light"]) .thought-bubble .dot {
		background: #f9fafb;
	}
	/* Transparent floating: remove box chrome so avatar composites over the page */
	:host([mode="floating"][background="transparent"]) {
		box-shadow: none;
		border-radius: 0;
		overflow: visible;
	}
	/* Pill expanded (bottom-sheet): offset chrome below swipe handle */
	:host([aria-expanded="true"]) .chrome {
		padding-top: 20px;
	}
	/* Drag handle — visible in floating mode, used to reposition the widget */
	.drag-handle {
		display: none;
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		height: 24px;
		cursor: grab;
		z-index: 15;
		touch-action: none;
	}
	.drag-handle:active { cursor: grabbing; }
	.drag-handle::after {
		content: '';
		position: absolute;
		top: 7px;
		left: 50%;
		transform: translateX(-50%);
		width: 32px;
		height: 3px;
		border-radius: 2px;
		background: rgba(255,255,255,0.3);
	}
	:host([mode="floating"]) .drag-handle { display: block; }
	/* Kiosk mode: hide dat.GUI debug controls entirely */
	:host([kiosk]) .gui-wrap,
	:host([kiosk]) .gui-toggle { display: none !important; }
	/* viewer mode: pure 3D canvas, no chat / input / avatar anchor / debug.
	   Use when embedding the avatar as decoration (landing pages, launchpads). */
	:host([viewer]) .chrome,
	:host([viewer]) .gui-wrap,
	:host([viewer]) .gui-toggle { display: none !important; }
	/* avatar-chat="off" — restore original bottom-row layout, hide avatar anchor */
	:host([avatar-chat="off"]) .chrome {
		inset: unset;
		left: 12px;
		right: 12px;
		bottom: 12px;
		flex-direction: row;
		align-items: flex-end;
		padding: 0;
		gap: 8px;
	}
	:host([avatar-chat="off"]) .chat { flex: 1; max-height: 40%; }
	:host([avatar-chat="off"]) .input-row { flex: 1; }
	:host([avatar-chat="off"]) .avatar-anchor { display: none; }
	/* Floating mode layout fixes */
	:host([mode="floating"]) .chrome {
		padding: 14px;
		padding-top: 28px; /* clear the 24px drag handle */
	}
	:host([mode="floating"]) .avatar-anchor {
		min-height: 60px;
	}
	/* Section mode — constrain chat width on wide containers */
	:host([mode="section"]) .chat {
		max-width: 600px;
	}
	:host([mode="section"]) .input-row {
		max-width: 600px;
	}
	/* Fullscreen mode — centre the chrome column on large monitors */
	:host([mode="fullscreen"]) .chrome {
		max-width: 800px;
		width: 800px;
		left: 0;
		right: 0;
		margin: 0 auto;
	}
`;

class Agent3DElement extends HTMLElement {
	static get observedAttributes() {
		return [
			'src',
			'manifest',
			'body',
			'agent-id',
			'avatar-id',
			'api-base',
			'mode',
			'position',
			'width',
			'height',
			'voice',
			'api-key',
			'key-proxy',
			'responsive',
			'background',
			'name-plate',
			'tracked-mint',
			'avatar-chat',
			'avatar-walk',
		];
	}

	constructor() {
		super();
		this.attachShadow({ mode: 'open' });
		this._viewer = null;
		this._scene = null;
		this._runtime = null;
		this._memory = null;
		this._skills = null;
		this._avatar = null; // empathy + lipsync layer; attached after runtime mounts
		this._manifest = null;
		this._mounted = false;
		this._booting = false;
		this._listening = false;
		this._pillActive = false;
		this._mqNarrow = null;
		this._mqNarrowHandler = null;
		this._ro = null;
		this._outsideTapHandler = null;
		this._autoResolvedManifest = false;
		this._suppressAttrChange = false;
		this._detachTradeReactions = null;
		this._livekitVoice = null;
		this._voiceClient = null;
		this._notifier = null;
		this._notifyWalkCleanup = null;
		this._speakWalkCleanup = null;
		this._thoughtBubbleEl = null;
		this._bubbleBuffer = '';
		this._bubbleRafPending = false;
		this._bubbleClearTimer = null;
		this._isWalking = false;
		this._walkStopDebounce = null;
		this._walkMovedX = false;
		this._walkHomeX = 0;
		this._streamingMsgEl = null;
		this._streamingChatBuffer = '';
		this._streamingChatRafPending = false;
		this._chatAutoScroll = true;
		this._pendingSay = null;
		// WebGL context budget bookkeeping.
		this._inViewport = false;
		this._lastVisibleAt = 0;
	}

	connectedCallback() {
		this._renderShell();
		this._applyLayout();
		this._setupResponsive();
		this._observeViewport();
		// Defer boot until visible unless `eager` attr is present.
		// Skip boot entirely if no source — wait for src/manifest/body/agent-id
		// to be set, which triggers reboot via attributeChangedCallback.
		if (this.hasAttribute('eager') && this._hasSource()) this._boot();
	}

	_hasSource() {
		return (
			this.hasAttribute('src') ||
			this.hasAttribute('manifest') ||
			this.hasAttribute('body') ||
			this.hasAttribute('agent-id') ||
			this.hasAttribute('avatar-id')
		);
	}

	disconnectedCallback() {
		this._teardown();
	}

	attributeChangedCallback(name, oldVal, newVal) {
		if (this._suppressAttrChange) return;
		// Source attribute set on a not-yet-booted (eager but no source) element
		// — boot now instead of rebooting.
		if (
			!this._mounted &&
			!this._booting &&
			this.isConnected &&
			['src', 'manifest', 'body', 'agent-id', 'avatar-id'].includes(name) &&
			newVal
		) {
			this._boot();
			return;
		}
		if (!this._mounted) return;
		if (['mode', 'position', 'width', 'height', 'responsive'].includes(name))
			this._applyLayout();
		if (name === 'background') this._applyBackground();
		if (name === 'name-plate') this._applyNamePlate();
		if (name === 'tracked-mint') {
			this._detachTradeReactions?.();
			this._detachTradeReactions = newVal
				? attachTradeReactions(this, { mint: newVal })
				: null;
		}
		if (name === 'avatar-walk' && newVal === 'off') {
			this._stopWalkAnimation();
		}
		if (['src', 'manifest', 'body', 'agent-id', 'avatar-id'].includes(name)) {
			// Source change — reboot
			this._teardown();
			this._boot();
		}
	}

	_renderShell() {
		if (this._loadingEl) return;
		const style = document.createElement('style');
		style.textContent = BASE_STYLE;
		this.shadowRoot.appendChild(style);

		const stage = document.createElement('div');
		stage.className = 'stage';
		stage.part = 'stage';
		this.shadowRoot.appendChild(stage);
		this._stageEl = stage;

		const poster = document.createElement('div');
		poster.className = 'poster';
		if (this.getAttribute('poster')) {
			poster.style.backgroundImage = `url(${this.getAttribute('poster')})`;
		}
		this.shadowRoot.appendChild(poster);
		this._posterEl = poster;

		const loading = document.createElement('div');
		loading.className = 'loading';
		loading.textContent = 'Loading...';
		loading.hidden = true;
		this.shadowRoot.appendChild(loading);
		this._loadingEl = loading;

		// Drag handle — floating mode only (CSS hides it otherwise)
		const dragHandle = document.createElement('div');
		dragHandle.className = 'drag-handle';
		dragHandle.setAttribute('aria-hidden', 'true');
		this.shadowRoot.appendChild(dragHandle);
		this._dragHandleEl = dragHandle;

		// Optional name-plate overlay. Hidden until a name is set on boot, and
		// toggled off entirely when the host carries `name-plate="off"`. The CSS
		// hides `.name-plate:empty`, so we don't have to manage `hidden` here.
		const namePlate = document.createElement('div');
		namePlate.className = 'name-plate';
		namePlate.part = 'name-plate';
		this.shadowRoot.appendChild(namePlate);
		this._nameplateEl = namePlate;

		// Pill button — tap/keyboard target when floating collapses to pill on narrow viewports
		const pillBtn = document.createElement('button');
		pillBtn.className = 'pill-btn';
		pillBtn.setAttribute('aria-label', 'Open agent');
		pillBtn.addEventListener('click', () => this._expandPill());
		pillBtn.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this._expandPill();
			}
		});
		this.shadowRoot.appendChild(pillBtn);
		this._pillBtn = pillBtn;

		// Drag handle shown when bottom-sheet is expanded
		const pillDrag = document.createElement('div');
		pillDrag.className = 'pill-drag';
		this.shadowRoot.appendChild(pillDrag);
		this._pillDrag = pillDrag;

		// Chat + input chrome (omitted in kiosk mode)
		if (!this.hasAttribute('kiosk')) {
			const chrome = document.createElement('div');
			chrome.className = 'chrome';
			chrome.part = 'chrome';

			const chat = document.createElement('div');
			chat.className = 'chat';
			chat.part = 'chat';
			chat.setAttribute('tabindex', '0');
			chat.setAttribute('role', 'log');
			chat.setAttribute('aria-live', 'polite');
			chat.setAttribute('aria-label', 'Conversation');

			const row = document.createElement('div');
			row.className = 'input-row';
			const input = document.createElement('input');
			input.type = 'text';
			input.placeholder = 'Say something...';
			input.setAttribute('aria-label', 'Message to agent');
			input.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' && input.value.trim()) {
					const v = input.value.trim();
					input.value = '';
					this._onStreamChunk(); // immediate visual feedback before LLM responds
					this.say(v);
					input.focus();
				}
			});
			const micBtn = document.createElement('button');
			micBtn.className = 'icon mic';
			micBtn.title = 'Push to talk';
			micBtn.setAttribute('aria-label', 'Push to talk');
			micBtn.innerHTML = '🎙';
			micBtn.addEventListener('click', () => this._toggleMic());
			row.appendChild(input);
			row.appendChild(micBtn);

			// Avatar anchor — transparent window between chat and input;
			// the Three.js canvas shows through here. Thought bubble lives inside.
			const avatarAnchor = document.createElement('div');
			avatarAnchor.className = 'avatar-anchor';
			const thoughtBubble = document.createElement('div');
			thoughtBubble.className = 'thought-bubble';
			thoughtBubble.setAttribute('role', 'status');
			thoughtBubble.setAttribute('aria-live', 'polite');
			thoughtBubble.setAttribute('aria-label', 'Agent is thinking');
			thoughtBubble.innerHTML =
				'<span class="text"></span>' +
				'<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
			avatarAnchor.appendChild(thoughtBubble);

			chat.appendChild(avatarAnchor);
			chrome.appendChild(chat);
			chrome.appendChild(row);
			this.shadowRoot.appendChild(chrome);
			this._chatEl = chat;
			this._inputEl = input;
			this._micEl = micBtn;
			this._avatarAnchorEl = avatarAnchor;
			this._thoughtBubbleEl = thoughtBubble;
			this._thoughtTextEl = thoughtBubble.querySelector('.text');

			// Walk when the chat is scrolling — user-initiated or auto
			chat.addEventListener('scroll', () => {
				if (
					this.getAttribute('avatar-chat') !== 'off' &&
					this.getAttribute('avatar-walk') !== 'off'
				) {
					this._onStreamChunk();
				}
			}, { passive: true });

			// Voice state ring — wired by VoiceClient when voice-server attr is set
			this.addEventListener('voiceStateChange', (e) => {
				if (!this._micEl) return;
				const { state } = e.detail;
				this._micEl.dataset.voiceState = state;
				this._micEl.title =
					state === 'idle' || !state ? 'Push to talk' : 'Voice active — click to stop';

				if (this.getAttribute('avatar-chat') !== 'off') {
					if (state === 'speaking' || state === 'thinking') {
						this._onStreamChunk();
					} else if (state === 'idle') {
						this._stopWalkAnimation();
					}
				}

				if (this._thoughtBubbleEl && this.getAttribute('avatar-chat') !== 'off') {
					if (state === 'speaking') {
						this._thoughtBubbleEl.dataset.active = 'true';
						this._thoughtBubbleEl.dataset.streaming = 'false';
					} else if (state === 'idle') {
						this._clearThoughtBubble();
					}
				}
			});

			// Tool-call indicator ("Checking the chain…").
			const toolInd = document.createElement('div');
			toolInd.className = 'tool-indicator';
			toolInd.part = 'tool-indicator';
			toolInd.innerHTML = '<span class="spin"></span><span class="label">Working…</span>';
			this.shadowRoot.appendChild(toolInd);
			this._toolIndicatorEl = toolInd;

			// Sticky alert banner (rug flags etc.).
			const banner = document.createElement('div');
			banner.className = 'alert-banner';
			banner.part = 'alert-banner';
			banner.innerHTML =
				'<span class="msg-text"></span><button aria-label="Dismiss">×</button>';
			banner.querySelector('button').addEventListener('click', () => {
				banner.dataset.active = 'false';
			});
			this.shadowRoot.appendChild(banner);
			this._alertBannerEl = banner;

			// Suggestion chips visible while the chat is empty.
			this._renderSuggestions();
		}
	}

	_renderSuggestions() {
		if (!this._chatEl) return;
		const existing = this._chatEl.querySelector('.suggest-row');
		if (existing) existing.remove();
		const row = document.createElement('div');
		row.className = 'suggest-row';
		const chips = this._suggestionChips();
		for (const c of chips) {
			const btn = document.createElement('button');
			btn.className = 'suggest-chip';
			btn.textContent = c.label;
			btn.addEventListener('click', () => {
				row.remove();
				this.say(c.prompt);
			});
			row.appendChild(btn);
		}
		this._chatEl.appendChild(row);
	}

	_suggestionChips() {
		// Tailor the chip set to which skills are installed; fall back to a
		// generic greeting set otherwise. Skill names come from the manifest,
		// not the registry, so this works even before runtime boot.
		const installed = new Set(
			(this._manifest?.skills || []).map((s) => {
				if (typeof s === 'string') return s.replace(/\/$/, '').split('/').pop();
				if (s?.id) return s.id;
				if (s?.uri) return String(s.uri).replace(/\/$/, '').split('/').pop();
				return '';
			}),
		);
		const chips = [];
		if (installed.has('pump-fun')) {
			chips.push(
				{
					label: '🔥 Trending now',
					prompt: 'What are the trending tokens on pump.fun right now?',
				},
				{ label: '👑 King of the hill', prompt: "Who's the king of the hill on pump.fun?" },
				{ label: '🆕 New launches', prompt: 'Show me the newest pump.fun launches.' },
			);
		}
		if (installed.has('dca')) {
			chips.push({
				label: '💸 Set up DCA',
				prompt: 'Help me set up a weekly USDC → WETH DCA.',
			});
		}
		if (chips.length === 0) {
			chips.push(
				{ label: '👋 Say hi', prompt: 'Hi! Who are you?' },
				{ label: '🎬 Show your animations', prompt: 'What animations can you do?' },
			);
		}
		return chips.slice(0, 4);
	}

	_isResponsive() {
		// Default on; opt out with responsive="false"
		return this.getAttribute('responsive') !== 'false';
	}

	_clampWidth(val) {
		const px = _parsePx(val);
		if (!px) return val;
		const min = Math.round(Math.max(160, px * 0.65));
		const vwPct = Math.round((px / 1440) * 100);
		return `clamp(${min}px, ${vwPct}vw, ${px}px)`;
	}

	/**
	 * Apply the `background` attribute. Mirrors the iframe embed semantics so
	 * the snippet builder's options translate cleanly: 'transparent' → renderer
	 * clears with alpha=0 and the scene background is unset; 'dark' / 'light'
	 * are keyword shortcuts for canonical colors; any other value is treated as
	 * a literal CSS color (e.g. a hex from a custom color picker) so the scene
	 * composites over it. Painting goes through the viewer's public
	 * setBackgroundColor()/updateBackground() so clear-color, environment, and
	 * the cached THREE.Color stay in sync — the host element's CSS background is
	 * also set inline for the keyword-less case (the `:host([background="..."])`
	 * rules in BASE_STYLE only cover the keywords).
	 *
	 * Safe to call before the viewer exists — it no-ops in that case and is
	 * re-run automatically once `_boot()` constructs the viewer.
	 */
	_applyBackground() {
		const v = this._viewer;
		if (!v) return;
		const mode = this.getAttribute('background') || 'transparent';
		if (mode === 'transparent') {
			if (v.state) v.state.transparentBg = true;
			v.updateBackground?.();
			this.style.removeProperty('background-color');
		} else {
			const color = mode === 'dark' ? '#0b0d10' : mode === 'light' ? '#f5f5f5' : mode;
			v.setBackgroundColor?.(color);
			this.style.backgroundColor = color;
		}
	}

	/**
	 * Apply the `name-plate` attribute. Visibility is purely CSS-driven via
	 * `:host([name-plate="off"])`, so this method only needs to ensure the
	 * element exists in the shadow DOM (it does, see `_renderShell`).
	 *
	 * Kept as a separate method so attributeChangedCallback has a clear hook,
	 * and so future changes to plate position/style stay localised here.
	 */
	_applyNamePlate() {
		// CSS handles visibility via the `name-plate="off"` host selector.
		// Method exists so the attribute observer has a hook + future-proofing.
	}

	/** Update the plate text. Empty string hides the plate (`.name-plate:empty`). */
	_setNamePlateText(name) {
		if (!this._nameplateEl) return;
		this._nameplateEl.textContent = name || '';
	}

	_clampHeight(val) {
		const px = _parsePx(val);
		if (!px) return val;
		const min = Math.round(Math.max(200, px * 0.65));
		const vhPct = Math.round((px / 900) * 100);
		return `clamp(${min}px, ${vhPct}vh, ${px}px)`;
	}

	_applyLayout() {
		const mode = this.getAttribute('mode') || 'inline';
		if (!MODES.includes(mode)) return;
		const responsive = this._isResponsive();

		if (mode === 'floating') {
			if (!this._pillActive) {
				const pos = this.getAttribute('position') || 'bottom-right';
				const offset = (this.getAttribute('offset') || '24px 24px').split(/\s+/);
				const [vOff, hOff] = [offset[0], offset[1] || offset[0]];
				this.style.top = this.style.bottom = this.style.left = this.style.right = '';
				if (pos.includes('top')) this.style.top = vOff;
				else this.style.bottom = vOff;
				if (pos.includes('left')) this.style.left = hOff;
				else if (pos.includes('right')) this.style.right = hOff;
				else if (pos.includes('center')) {
					this.style.left = '50%';
					this.style.transform = 'translateX(-50%)';
				}
			}

			const width = this.getAttribute('width') || '320px';
			const height = this.getAttribute('height') || '420px';
			this.style.setProperty('--agent-width', responsive ? this._clampWidth(width) : width);
			this.style.setProperty(
				'--agent-height',
				responsive ? this._clampHeight(height) : height,
			);
		} else {
			this.style.top =
				this.style.bottom =
				this.style.left =
				this.style.right =
				this.style.transform =
					'';

			const width = this.getAttribute('width');
			const height = this.getAttribute('height');

			if (mode === 'inline') {
				if (width) this.style.width = responsive ? this._clampWidth(width) : width;
				if (height) {
					this.style.height = height;
					this.removeAttribute('data-responsive');
				} else if (responsive && width) {
					// No explicit height: aspect-ratio preserves 3:4 portrait via CSS
					this.style.height = '';
					this.setAttribute('data-responsive', '');
				}
			}

			if (width)
				this.style.setProperty(
					'--agent-width',
					responsive ? this._clampWidth(width) : width,
				);
			if (height)
				this.style.setProperty(
					'--agent-height',
					responsive ? this._clampHeight(height) : height,
				);
		}
	}

	_setupResponsive() {
		const mode = this.getAttribute('mode') || 'inline';

		// ResizeObserver on this — reacts to container changes without a viewport listener
		if (mode === 'inline' && typeof ResizeObserver !== 'undefined') {
			this._ro = new ResizeObserver(() => this._applyLayout());
			this._ro.observe(this);
		}

		// matchMedia for floating pill collapse at narrow viewports
		if (mode === 'floating' && this._isResponsive() && typeof window !== 'undefined') {
			this._mqNarrow = window.matchMedia('(max-width: 479px)');
			this._mqNarrowHandler = (e) => this._updatePillState(e.matches);
			this._mqNarrow.addEventListener('change', this._mqNarrowHandler);
			this._updatePillState(this._mqNarrow.matches);
		}

		// Free drag for floating mode
		if (mode === 'floating') this._setupDrag();

		// Swipe-down to close the bottom-sheet (CSS transitions handle the animation)
		let touchStartY = 0;
		this.shadowRoot.addEventListener(
			'touchstart',
			(e) => {
				touchStartY = e.touches[0].clientY;
			},
			{ passive: true },
		);
		this.shadowRoot.addEventListener(
			'touchend',
			(e) => {
				const dy = e.changedTouches[0].clientY - touchStartY;
				if (dy > 60 && this._pillActive && this.getAttribute('aria-expanded') === 'true') {
					this._collapsePill();
				}
			},
			{ passive: true },
		);
	}

	_setupDrag() {
		if (!this._dragHandleEl) return;
		let dragging = false;
		let startX, startY, startLeft, startTop;

		const onPointerMove = (e) => {
			if (!dragging) return;
			const dx = e.clientX - startX;
			const dy = e.clientY - startY;
			const w = this.offsetWidth;
			const h = this.offsetHeight;
			const newLeft = Math.max(0, Math.min(window.innerWidth - w, startLeft + dx));
			const newTop = Math.max(0, Math.min(window.innerHeight - h, startTop + dy));
			this.style.left = newLeft + 'px';
			this.style.top = newTop + 'px';
		};

		const onPointerUp = () => {
			if (!dragging) return;
			dragging = false;
			document.removeEventListener('pointermove', onPointerMove);
			document.removeEventListener('pointerup', onPointerUp);
		};

		this._dragHandleEl.addEventListener('pointerdown', (e) => {
			e.preventDefault();
			dragging = true;
			const rect = this.getBoundingClientRect();
			startX = e.clientX;
			startY = e.clientY;
			startLeft = rect.left;
			startTop = rect.top;
			// Switch to top/left so drag math works correctly
			this.style.right = '';
			this.style.bottom = '';
			this.style.left = startLeft + 'px';
			this.style.top = startTop + 'px';
			this.style.transform = '';
			document.addEventListener('pointermove', onPointerMove);
			document.addEventListener('pointerup', onPointerUp);
		});
	}

	_updatePillState(narrow) {
		if (narrow && !this._pillActive) {
			this._pillActive = true;
			this._collapsePill();
		} else if (!narrow && this._pillActive) {
			this._pillActive = false;
			this._restoreFromPill();
		}
	}

	_collapsePill() {
		this.style.width = '56px';
		this.style.height = '56px';
		this.style.borderRadius = '50%';
		this.setAttribute('aria-expanded', 'false');
		this._pillBtn.style.display = 'block';
		this._pillDrag.style.display = 'none';
		const chrome = this.shadowRoot.querySelector('.chrome');
		if (chrome) chrome.style.display = 'none';
		this._stageEl.style.display = 'none';
		if (this._outsideTapHandler) {
			document.removeEventListener('pointerdown', this._outsideTapHandler);
			this._outsideTapHandler = null;
		}
	}

	_expandPill() {
		if (!this._pillActive) return;
		this.style.width = '100vw';
		this.style.height = '70vh';
		this.style.borderRadius = '16px 16px 0 0';
		this.style.bottom = '0';
		this.style.top = 'auto';
		this.style.left = '0';
		this.style.right = '0';
		this.style.transform = 'none';
		this.setAttribute('aria-expanded', 'true');
		this._pillBtn.style.display = 'none';
		this._pillDrag.style.display = 'block';
		const chrome = this.shadowRoot.querySelector('.chrome');
		if (chrome) chrome.style.display = '';
		this._stageEl.style.display = '';

		// Close on outside tap
		this._outsideTapHandler = (e) => {
			if (!e.composedPath().includes(this)) this._collapsePill();
		};
		setTimeout(() => document.addEventListener('pointerdown', this._outsideTapHandler), 0);
	}

	_restoreFromPill() {
		this.removeAttribute('aria-expanded');
		this._pillBtn.style.display = 'none';
		this._pillDrag.style.display = 'none';
		const chrome = this.shadowRoot.querySelector('.chrome');
		if (chrome) chrome.style.display = '';
		this._stageEl.style.display = '';
		// Clear pill inline overrides, re-apply proper floating layout
		this.style.width = this.style.height = this.style.borderRadius = '';
		this.style.bottom =
			this.style.top =
			this.style.left =
			this.style.right =
			this.style.transform =
				'';
		this._applyLayout();
		if (this._outsideTapHandler) {
			document.removeEventListener('pointerdown', this._outsideTapHandler);
			this._outsideTapHandler = null;
		}
	}

	_observeViewport() {
		if (this.hasAttribute('eager')) {
			// Eager viewers boot immediately and are never released by the budget;
			// treat them as permanently in-viewport so they sort to the top.
			this._inViewport = true;
			this._lastVisibleAt = _nowMs();
			return;
		}
		if (typeof IntersectionObserver === 'undefined') {
			this._inViewport = true;
			this._boot();
			return;
		}
		if (this._io) return;
		// Persistent observer (not disconnected after first boot): it both lazily
		// boots the viewer and tracks visibility so the context budget can evict
		// the least-recently-visible offscreen viewer and re-boot it on return.
		// The 300px margin gives lead time to boot before the avatar is on screen
		// and damps thrash at the viewport edge.
		this._io = new IntersectionObserver(
			(entries) => {
				const isVis = entries.some((e) => e.isIntersecting);
				this._inViewport = isVis;
				if (isVis) {
					this._lastVisibleAt = _nowMs();
					if (!this._mounted && !this._booting) this._boot();
				}
			},
			{ rootMargin: '300px 0px' },
		);
		this._io.observe(this);
	}

	// Eligible for budget eviction only when offscreen and not holding live
	// state a user would lose (voice, an open chat pill, an eager/keep-alive
	// pin). Whatever is on screen or mid-conversation is always spared.
	_isEvictable() {
		return (
			this._mounted &&
			!this._inViewport &&
			!this.hasAttribute('eager') &&
			!this.hasAttribute('keep-alive') &&
			!this._hasActiveSession()
		);
	}

	_hasActiveSession() {
		return !!(
			this._livekitVoice ||
			this._voiceClient ||
			this._listening ||
			this._pillActive
		);
	}

	_releaseForBudget() {
		if (!this._mounted) return;
		this._teardown(); // disposes the viewer → frees the WebGL context(s)
		this._io = null; // _teardown disconnected it; re-arm a fresh observer
		this._observeViewport(); // re-boots automatically when scrolled back in
	}

	async _boot() {
		if (this._booting || this._mounted) return;
		this._renderShell();
		this._booting = true;
		try {
			this._loadingEl.hidden = false;
			this.dispatchEvent(
				new CustomEvent('agent:load-progress', { detail: { phase: 'manifest', pct: 0.1 } }),
			);

			const manifest = await this._resolveManifest();
			this._manifest = manifest;
			this.dispatchEvent(
				new CustomEvent('agent:load-progress', { detail: { phase: 'manifest', pct: 0.3 } }),
			);

			// Hydrate instructions.md if referenced
			if (
				typeof manifest.brain?.instructions === 'string' &&
				manifest.brain.instructions.endsWith('.md')
			) {
				const text = await fetchRelative(manifest, manifest.brain.instructions);
				if (text) manifest.instructions = stripFrontmatter(text);
			} else if (manifest.brain?.instructions) {
				manifest.instructions = manifest.brain.instructions;
			}

			// Embed-policy surface + origin gate (fail-open on infra errors)
			const _backendId = (() => {
				const a = this.getAttribute('agent-id') || manifest.id?.agentId || '';
				return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(a)
					? a
					: null;
			})();
			if (_backendId) {
				try {
					const _policyBase = _scriptOrigin || window.location.origin;
					const _pr = await fetch(
						`${_policyBase}/api/agents/${_backendId}/embed-policy`,
						{ credentials: 'omit' },
					);
					if (_pr.ok) {
						const { policy } = await _pr.json();
						if (policy) {
							if (policy.surfaces?.script === false) {
								this._fail(
									'embed_denied_surface',
									'This agent disallows the script-tag embed.',
								);
								return;
							}
							const _fp = ['three.ws', 'localhost'];
							const _host = window.location.origin;
							if (
								!_host.startsWith('http://localhost') &&
								!originAllowed(_host, policy, _fp)
							) {
								this._fail(
									'embed_denied_origin',
									`This agent isn't permitted on ${_host}.`,
								);
								return;
							}
						}
					}
				} catch (_e) {
					console.warn('[agent-3d] embed-policy fetch failed; continuing', _e);
				}
			}

			// Build Viewer
			this.dispatchEvent(
				new CustomEvent('agent:load-progress', { detail: { phase: 'body', pct: 0.45 } }),
			);
			const viewer = new Viewer(this._stageEl, {
				kiosk: this.hasAttribute('kiosk'),
			});
			this._viewer = viewer;
			viewer._afterAnimateHooks = viewer._afterAnimateHooks || [];
			viewer._afterAnimateHooks.push(() => this._updateBubblePosition());
			// Apply the embed surface attributes (`background`, `name-plate`) now
			// that the viewer exists. They are also re-applied on attribute change.
			this._applyBackground();
			this._setNamePlateText(manifest.name || '');
			this._applyNamePlate();
			// Fetch animation defs before viewer.load so _setupAnimationPanel
			// can preload idle+walk during the model load.
			const _animBase = _scriptOrigin || window.location.origin;
			try {
				const _animRes = await fetch(`${_animBase}/animations/manifest.json`);
				if (_animRes.ok) viewer.setAnimationDefs(await _animRes.json());
			} catch {}

			const bodyURI = resolveURI(manifest.body?.uri);
			if (bodyURI) {
				await viewer.load(bodyURI, '', new Map());
				// Ensure walk + idle are hot before the first brain:stream fires.
				// setAnimationDefs above registered the defs; ensureLoaded now
				// actually fetches the clips (or returns immediately if cached).
				const _am = viewer.animationManager;
				if (_am) {
					await Promise.allSettled([_am.ensureLoaded('idle'), _am.ensureLoaded('walk')]);
				}
				// After the reveal tween completes, shift the orbital target upward
				// so the avatar's upper body fills the avatar-anchor window rather
				// than the full canvas height.
				const _v = viewer;
				const _nudge = () => {
					if (_v._cameraTweenRaf) {
						requestAnimationFrame(_nudge);
						return;
					}
					if (!_v.controls || !_v.content || _v._disposed) return;
					const box = new Box3().setFromObject(_v.content);
					const h = box.max.y - box.min.y;
					const mid = (box.max.y + box.min.y) / 2;
					_v.controls.target.set(0, mid + h * 0.12, 0);
					_v.controls.update();
					_v.invalidate();
				};
				requestAnimationFrame(_nudge);
			}
			this._scene = new SceneController(viewer);
			if (bodyURI) this._scene.playClipByName('idle', { loop: true });

			// Memory
			this.dispatchEvent(
				new CustomEvent('agent:load-progress', { detail: { phase: 'memory', pct: 0.6 } }),
			);
			const memoryNamespace =
				manifest.id?.agentId || this.getAttribute('memory-key') || manifest.name || 'anon';
			this._memory = await Memory.load({
				mode: this.getAttribute('memory') || manifest.memory?.mode || 'local',
				namespace: memoryNamespace,
				manifestURI: manifest._baseURI + 'manifest.json',
				fetchFn: fetch.bind(globalThis),
			});

			// Pull backend memories into the shared AgentMemory localStorage store
			// before the first LLM turn so cross-device memory is present on init.
			if (_backendId) {
				const { AgentMemory } = await import('./agent-memory.js');
				const syncMem = new AgentMemory(_backendId, { backendSync: true });
				await syncMem.pull(_backendId).catch(() => {});
			}

			// Skills
			this.dispatchEvent(
				new CustomEvent('agent:load-progress', { detail: { phase: 'skills', pct: 0.75 } }),
			);
			this._skills = new SkillRegistry({
				trust: this.getAttribute('skill-trust') || 'owned-only',
				ownerAddress: manifest.id?.owner,
			});
			const skillList = manifest.skills || [];
			for (const spec of skillList) {
				// Built-in skills (referenced by name only, no bundle URI) are
				// registered through AgentSkills, not the remote SkillRegistry.
				if (!spec || !spec.uri) continue;
				try {
					const skill = await this._skills.install(spec, {
						bundleBase: manifest._baseURI,
					});
					this.dispatchEvent(
						new CustomEvent('skill:loaded', {
							detail: { name: skill.name, uri: skill.uri },
						}),
					);
				} catch (e) {
					console.warn('[agent-3d] skill load failed', spec, e);
				}
			}

			// Runtime
			this.dispatchEvent(
				new CustomEvent('agent:load-progress', { detail: { phase: 'brain', pct: 0.9 } }),
			);
			const providerConfig = {
				apiKey: this.getAttribute('api-key') || undefined,
				proxyURL: this.getAttribute('key-proxy') || undefined,
				agentId: _backendId || undefined,
				apiOrigin: _scriptOrigin || window.location.origin,
			};

			// Fetch skill prices + purchased state so the runtime can gate paid skills.
			// Failures here fall back to "all-allowed" — monetization is opt-in.
			let _skillAccess;
			if (_backendId) {
				try {
					const detailBase = _scriptOrigin || window.location.origin;
					const r = await fetch(
						`${detailBase}/api/marketplace/agents/${_backendId}`,
						{ credentials: 'include' },
					);
					if (r.ok) {
						const j = await r.json();
						const a = j?.data?.agent;
						if (a && (a.skill_prices || a.purchased_skills)) {
							_skillAccess = skillAccessFromAgentDetail(a);
						}
					}
				} catch (e) {
					console.warn('[agent-3d] skill-access fetch failed; defaulting to allow-all', e);
				}
			}

			this._runtime = new Runtime({
				manifest,
				viewer: this._scene,
				memory: this._memory,
				skills: this._skills,
				providerConfig,
				agentId: _backendId || undefined,
				skillAccess: _skillAccess,
			});

			// ── Empathy + lipsync layer ───────────────────────────────────────
			// AgentAvatar subscribes to the agent-protocol bus, runs the emotion
			// blend on the viewer's per-frame hook, and drives viseme morphs from
			// the live TTS AnalyserNode when audio plays. Without this the embed
			// would render the mesh but show a dead face while speaking.
			try {
				const _identity = { id: manifest.id?.agentId || manifest.name || 'embed' };
				this._avatar = new AgentAvatar(this._viewer, protocol, _identity);
				this._avatar.attach();

				if (this._runtime.tts) {
					const tts    = this._runtime.tts;
					const avatar = this._avatar;
					tts.onStart = () => {
						if (tts.analyserNode) avatar.connectLipSync(tts.analyserNode);
					};
					tts.onEnd = () => {
						avatar.disconnectLipSync();
					};
				}
			} catch (e) {
				// Empathy is non-essential — embed still works without it. Log so
				// integrators can see the failure during development.
				console.warn('[agent-3d] AgentAvatar attach failed; continuing without empathy/lipsync', e);
				this._avatar = null;
			}

			// Re-dispatch runtime events on the host
			for (const ev of [
				'brain:thinking',
				'brain:stream',
				'brain:message',
				'skill:tool-start',
				'skill:tool-called',
				'skill:payment-required',
				'voice:speech-start',
				'voice:speech-end',
				'voice:transcript',
				'voice:listen-start',
				'memory:write',
			]) {
				this._runtime.addEventListener(ev, (e) => {
					this.dispatchEvent(
						new CustomEvent(ev, { detail: e.detail, bubbles: true, composed: true }),
					);
					if (ev === 'brain:message') {
						// Transfer sentiment from the most recent tool call to
						// this assistant message so the bubble tints correctly.
						const detail = { ...e.detail };
						if (
							detail.role === 'assistant' &&
							detail.sentiment === undefined &&
							this._lastToolSentiment !== undefined
						) {
							detail.sentiment = this._lastToolSentiment;
							this._lastToolSentiment = undefined;
						}
						if (detail.role === 'assistant' && detail.content) {
							protocol.emit({
								type: ACTION_TYPES.SPEAK,
								payload: { text: detail.content, sentiment: detail.sentiment ?? 0 },
							});
						}
						if (detail.role === 'assistant') {
							this._streamingMsgEl?.closest('.msg')?.remove();
							this._streamingMsgEl = null;
							this._streamingChatBuffer = '';
							this._streamingChatRafPending = false;
							this._clearThoughtBubble();
						}
						if (this._chatEl) this._renderMessage(detail);
					}
					if (ev === 'brain:stream') {
						if (this._thoughtBubbleEl && this.getAttribute('avatar-chat') !== 'off') {
							this._streamToBubble(e.detail?.chunk ?? '');
						}
						this._appendStreamChunkToChat(e.detail?.chunk ?? '');
						this._onStreamChunk();
					}
					if (ev === 'brain:thinking') {
						const isThinking = !!e.detail?.thinking;
						this._setBusy(isThinking);
						if (this._toolIndicatorEl) {
							if (e.detail?.thinking) this._setToolIndicator('thinking');
							else this._clearToolIndicator();
						}
						protocol.emit({
							type: ACTION_TYPES.THINK,
							payload: { thought: 'processing your message...' },
						});
						protocol.emit({
							type: ACTION_TYPES.EMOTE,
							payload: { trigger: 'patience', weight: 0.5 },
						});
						if (this._thoughtBubbleEl && this.getAttribute('avatar-chat') !== 'off') {
							if (e.detail?.thinking) {
								this._thoughtBubbleEl.dataset.active = 'true';
								// Show "Thinking..." text immediately
								this._thoughtBubbleEl.dataset.streaming = 'true';
								if (this._thoughtTextEl) this._thoughtTextEl.textContent = 'Thinking...';
							} else {
								this._clearThoughtBubble();
							}
						}
					}
					if (ev === 'skill:tool-start') {
						this._onStreamChunk();
						if (this._thoughtBubbleEl && this.getAttribute('avatar-chat') !== 'off') {
							const label = this._toolIndicatorLabel(e.detail?.tool ?? '');
							this._thoughtBubbleEl.dataset.active = 'true';
							this._thoughtBubbleEl.dataset.streaming = 'true';
							if (this._thoughtTextEl) this._thoughtTextEl.textContent = label;
						}
					}
					if (ev === 'voice:speech-start') {
						this._onStreamChunk();
						if (this._thoughtBubbleEl && this.getAttribute('avatar-chat') !== 'off') {
							const text = e.detail?.text || '';
							this._streamToBubble('');
							this._thoughtBubbleEl.dataset.streaming = 'true';
							this._thoughtBubbleEl.dataset.active = 'true';
							if (this._thoughtTextEl)
								this._thoughtTextEl.textContent = text.slice(0, 80);
						}
					}
					if (ev === 'voice:speech-end') {
						this._stopWalkAnimation();
						this._clearThoughtBubble();
					}
					if (ev === 'skill:tool-called') {
						const { tool, result } = e.detail || {};
						this._setToolIndicator(tool);
						this._clearToolIndicator();
						if (this._thoughtTextEl) this._thoughtTextEl.textContent = '';
						if (this._thoughtBubbleEl)
							this._thoughtBubbleEl.dataset.streaming = 'false';
						if (typeof result?.sentiment === 'number') {
							this._lastToolSentiment = result.sentiment;
						}
						this._renderToolCallCard({ tool, result });
					}
				});
			}

			this._mounted = true;
			// Join the live-viewer set and evict an offscreen viewer if this boot
			// pushed us over the WebGL context budget.
			this._lastVisibleAt = _nowMs();
			_trackLiveViewer(this);

			// ── Skill payment ─────────────────────────────────────────────────
			// When a paid skill is invoked, render an inline payment chip inside
			// the chat thread (no blocking overlay) and narrate before/after via
			// the agent protocol. Falls back to the full modal when there is no
			// chat thread (e.g. avatar-only embed with avatar-chat="off").
			if (_backendId && this.shadowRoot) {
				this._paymentModal = new SkillPaymentModal(this.shadowRoot, _backendId);
				this._paymentChip = new PaymentChip(_backendId);
				let _paymentInFlight = false;

				this._runtime.addEventListener('skill:payment-required', async (e) => {
					if (_paymentInFlight) return;
					_paymentInFlight = true;

					const { skill = 'skill', price = {} } = e.detail || {};
					const amountUsdc = (Number(price?.amount || 0) / 1e6).toFixed(2);

					// Narrate in chat + avatar walk so the user understands what's happening
					const preText = `To use the ${skill} skill I need a quick payment of $${amountUsdc} USDC. Approval card below.`;
					this._renderMessage({ role: 'assistant', content: preText });
					protocol.emit({
						type: ACTION_TYPES.SPEAK,
						payload: { text: preText, sentiment: 0 },
					});

					let purchased = false;
					try {
						if (this._chatEl) {
							purchased = await this._paymentChip.show(this._chatEl, e.detail);
						} else {
							purchased = await this._paymentModal.show(e.detail);
						}
					} finally {
						_paymentInFlight = false;
					}

					if (purchased) {
						const doneText = 'Payment confirmed. Continuing...';
						this._renderMessage({ role: 'assistant', content: doneText });
						protocol.emit({
							type: ACTION_TYPES.SPEAK,
							payload: { text: doneText, sentiment: 0.4 },
						});
						// Refresh skillAccess so next call goes through without re-prompting.
						try {
							const base = _scriptOrigin || window.location.origin;
							const r = await fetch(
								`${base}/api/marketplace/agents/${_backendId}`,
								{ credentials: 'include' },
							);
							if (r.ok) {
								const j = await r.json();
								if (j?.data?.agent) {
									this._runtime.skillAccess = skillAccessFromAgentDetail(j.data.agent);
								}
							}
						} catch {}
						this.dispatchEvent(new CustomEvent('skill:purchased', {
							detail: e.detail, bubbles: true, composed: true,
						}));
					}
				});
			}

			this._notifier = new AgentNotifier(this, protocol);
			this._notifier.attach();

			// Walk during notification: enter frame (450ms) + message duration + exit frame (380ms)
			const _notifyWalkHandler = ({ payload }) => {
				if (this.getAttribute('avatar-chat') === 'off') return;
				const duration = payload?.duration ?? 6000;
				this._onStreamChunk();
				clearTimeout(this._walkStopDebounce);
				this._walkStopDebounce = setTimeout(
					() => this._stopWalkAnimation(),
					450 + duration + 380,
				);
			};
			protocol.on(ACTION_TYPES.NOTIFY, _notifyWalkHandler);
			this._notifyWalkCleanup = () => protocol.off(ACTION_TYPES.NOTIFY, _notifyWalkHandler);

			const _speakWalkHandler = () => {
				if (this.getAttribute('avatar-chat') === 'off') return;
				this._onStreamChunk();
			};
			protocol.on(ACTION_TYPES.SPEAK, _speakWalkHandler);
			this._speakWalkCleanup = () => protocol.off(ACTION_TYPES.SPEAK, _speakWalkHandler);

			// LiveKit realtime voice — connect when voice="livekit" and agent-id is set
			if (this.getAttribute('voice') === 'livekit' && _backendId) {
				this._connectLiveKit(_backendId).catch((err) => {
					console.warn('[agent-3d] LiveKit connect failed', err);
				});
			}

			const _trackedMint = this.getAttribute('tracked-mint');
			if (_trackedMint) {
				this._detachTradeReactions = attachTradeReactions(this, { mint: _trackedMint });
			}
			// BEGIN:EMBED_BRIDGES
			if (window !== window.parent) {
				this._embedBridge = new EmbedActionBridge({
					protocol,
					manifest: this._manifest,
					window,
					getClips: () => this._listAvailableClips(),
				});
				this._embedBridge.start();
				// Push the initial clip list once the model + manifest are settled.
				// The bridge queues this until the host subscribes; the chip strip on
				// the parent page reads it from `op:'clips'` events without polling.
				queueMicrotask(() => this._embedBridge?.emitClipsChanged());
			}
			// END:EMBED_BRIDGES
			this._loadingEl.hidden = true;
			if (!this._pillActive) this._posterEl.style.opacity = '0';
			this.dispatchEvent(
				new CustomEvent('agent:ready', {
					detail: { agent: this, manifest },
					bubbles: true,
					composed: true,
				}),
			);
		} catch (err) {
			console.error('[agent-3d] boot failed', err);
			this._loadingEl.hidden = true;
			// Resolve errors should already have been caught and replaced with the
			// default-avatar manifest in _resolveManifest. Anything reaching here is
			// a deeper boot failure — surface it (unless we're a tiny kiosk tile).
			if (!this.hasAttribute('kiosk')) this._showError(err);
			this.dispatchEvent(
				new CustomEvent('agent:error', {
					detail: { phase: 'boot', error: err },
					bubbles: true,
					composed: true,
				}),
			);
		} finally {
			this._booting = false;
		}
	}

	_defaultFallbackManifest() {
		return {
			spec: 'agent-manifest/0.1',
			_baseURI: '',
			name: this.getAttribute('name') || 'Agent',
			body: { uri: 'https://assets.three.ws/models/avatars/Default.glb', format: 'gltf-binary' },
			brain: { provider: 'none' },
			voice: { tts: { provider: 'browser' }, stt: { provider: 'browser' } },
			skills: [],
		};
	}

	async _resolveManifest() {
		const src = this.getAttribute('src');
		const manifestAttr = this.getAttribute('manifest');
		const body = this.getAttribute('body');
		const agentIdAttr = this.getAttribute('agent-id');
		const avatarIdAttr = this.getAttribute('avatar-id');
		const chainIdAttr = this.getAttribute('chain-id');
		const apiBase = this.getAttribute('api-base') || _scriptOrigin || window.location.origin;
		if (avatarIdAttr && !src && !manifestAttr && !body && !agentIdAttr) {
			try {
				return await resolveByAvatarId(avatarIdAttr, { origin: apiBase });
			} catch (err) {
				console.warn(
					'[agent-3d] avatar-id resolve failed, using default avatar:',
					err,
				);
				return this._defaultFallbackManifest();
			}
		}
		if (src) {
			if (agentIdAttr) console.warn('[agent-3d] both src and agent-id provided; using src');
			// Plain .glb / .gltf URLs are bare bodies, not manifests — treat
			// them as if `body=` had been set so users don't need to know the
			// distinction.
			if (/\.(glb|gltf)(\?|$)/i.test(src)) {
				return {
					spec: 'agent-manifest/0.1',
					_baseURI: '',
					name: this.getAttribute('name') || 'Agent',
					body: { uri: src, format: 'gltf-binary' },
					brain: { provider: 'none' },
					voice: { tts: { provider: 'browser' }, stt: { provider: 'browser' } },
					skills: [],
				};
			}
			return loadManifest(src, {
				rpcURL: this.getAttribute('rpc-url'),
				registry: this.getAttribute('registry'),
			});
		}
		if (agentIdAttr) {
			try {
				// On-chain reference? Supported forms:
				//   agent-id="eip155:8453:0xabc...:42"   full CAIP-10 + token
				//   agent-id="onchain:8453:42"           shorthand, canonical registry
				//   agent-id="42" chain-id="8453"        numeric id + explicit chain
				//   agent-id="agent://8453/42"           agent URI
				const caipInput = chainIdAttr
					? {
							chainId: Number(chainIdAttr),
							agentId: agentIdAttr,
							registry: this.getAttribute('registry') || undefined,
						}
					: agentIdAttr;
				const ref = parseAgentRef(caipInput);
				if (ref) {
					const resolved = await resolveOnchainAgent(ref);
					if (resolved.error && !resolved.glbUrl)
						throw new Error(`On-chain resolve failed: ${resolved.error}`);
					return toManifest(resolved);
				}
				// Explicit manifest= wins over backend UUID resolution.
				if (manifestAttr) return loadManifest(manifestAttr);
				// Resolve agent-id → manifestUrl via backend, then load that manifest.
				const manifestUrl = await resolveByAgentId(agentIdAttr);
				if (manifestUrl) {
					this._autoResolvedManifest = true;
					this.setAttribute('manifest', manifestUrl);
					return loadManifest(manifestUrl);
				}
				// No manifestUrl on agent record — build inline manifest from avatar data.
				return await resolveAgentById(agentIdAttr);
			} catch (err) {
				// Never let avatar rendering error out — fall back to default avatar.
				console.warn('[agent-3d] agent resolve failed, using default avatar:', err);
				return this._defaultFallbackManifest();
			}
		}
		if (manifestAttr) return loadManifest(manifestAttr);
		if (body) {
			// Ad-hoc agent from a bare GLB
			const instructionsAttr = this.getAttribute('instructions');
			return {
				spec: 'agent-manifest/0.1',
				_baseURI: '',
				name: this.getAttribute('name') || 'Agent',
				body: { uri: body, format: 'gltf-binary' },
				brain: {
					provider: this.getAttribute('brain') ? 'anthropic' : 'none',
					model: this.getAttribute('brain') || undefined,
					instructions: instructionsAttr || 'You are an embodied three.ws.',
				},
				instructions: instructionsAttr || 'You are an embodied three.ws.',
				voice: { tts: { provider: 'browser' }, stt: { provider: 'browser' } },
				skills: (this.getAttribute('skills') || '')
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean)
					.map((uri) => ({ uri })),
				memory: { mode: this.getAttribute('memory') || 'local' },
				tools: ['wave', 'lookAt', 'play_clip', 'setExpression', 'speak', 'remember'],
				version: '0.1.0',
			};
		}
		// No source provided — render the default avatar so the element never errors out.
		return this._defaultFallbackManifest();
	}

	_renderMessage({ role, content, sentiment }) {
		if (!this._chatEl) return;
		if (!content) return;
		// Hide the suggestion chips once a real conversation starts.
		this._chatEl.querySelector('.suggest-row')?.remove();
		const msg = document.createElement('div');
		msg.className = 'msg';
		const tone = this._sentimentTone(sentiment);
		if (tone) msg.classList.add(tone);
		msg.innerHTML = `<div class="role"></div><div class="body"></div>`;
		msg.querySelector('.role').textContent = role;
		msg.querySelector('.body').textContent = content;
		if (this._avatarAnchorEl) {
			this._chatEl.insertBefore(msg, this._avatarAnchorEl);
		} else {
			this._chatEl.appendChild(msg);
		}
		this._chatEl.scrollTop = this._chatEl.scrollHeight;
		if (!this._isWalking && this.getAttribute('avatar-chat') !== 'off') {
			this._onStreamChunk();
		}
	}

	_sentimentTone(s) {
		if (typeof s !== 'number') return null;
		if (s > 0.3) return 'celebration';
		if (s < -0.2) return 'concern';
		if (s > 0.05) return 'curiosity';
		return null;
	}

	_setToolIndicator(toolName) {
		if (!this._toolIndicatorEl) return;
		clearTimeout(this._toolIndicatorHideTimer);
		const label = this._toolIndicatorLabel(toolName);
		this._toolIndicatorEl.querySelector('.label').textContent = label;
		this._toolIndicatorEl.dataset.active = 'true';
	}

	_clearToolIndicator() {
		if (!this._toolIndicatorEl) return;
		clearTimeout(this._toolIndicatorHideTimer);
		this._toolIndicatorHideTimer = setTimeout(() => {
			if (this._toolIndicatorEl) this._toolIndicatorEl.dataset.active = 'false';
		}, 350);
	}

	_updateBubblePosition() {
		if (!this._thoughtBubbleEl || !this._viewer) return;
		const pos = this._viewer.getHeadScreenPosition?.();
		if (!pos) return;
		const anchorRect = this._avatarAnchorEl?.getBoundingClientRect();
		const stageRect = this._stageEl?.getBoundingClientRect();
		if (!anchorRect || !stageRect) return;
		const relY = pos.y - (anchorRect.top - stageRect.top) - 60;
		const clampedY = Math.max(8, relY);
		this._thoughtBubbleEl.style.top = `${clampedY}px`;
		this._thoughtBubbleEl.style.left = `${pos.x}px`;
		this._thoughtBubbleEl.style.transform = 'translateX(-50%) scale(var(--bubble-scale, 1))';
		const headRelY = pos.y - (anchorRect.top - stageRect.top);
		const bubbleBottom = clampedY + this._thoughtBubbleEl.offsetHeight;
		this._thoughtBubbleEl.dataset.tailDir = bubbleBottom < headRelY ? 'up' : 'down';
	}

	_appendStreamChunkToChat(chunk) {
		if (!this._chatEl || !chunk) return;
		if (!this._streamingMsgEl) {
			this._chatEl.querySelector('.suggest-row')?.remove();
			const msg = document.createElement('div');
			msg.className = 'msg streaming';
			msg.innerHTML = '<div class="role"></div><div class="body"></div>';
			msg.querySelector('.role').textContent = 'assistant';
			if (this._avatarAnchorEl) {
				this._chatEl.insertBefore(msg, this._avatarAnchorEl);
			} else {
				this._chatEl.appendChild(msg);
			}
			this._streamingMsgEl = msg.querySelector('.body');
			this._chatAutoScroll = true;
			if (!this._walkMovedX && this._scene?.viewer?.content &&
					!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
				this._walkHomeX = this._scene.viewer.content.position.x;
				this._walkMovedX = true;
				this._scene.moveTo({ x: this._walkHomeX + 0.35 }, { duration: 900 });
			}
		}
		const el = this._chatEl;
		this._chatAutoScroll = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
		this._streamingChatBuffer = (this._streamingChatBuffer || '') + chunk;
		if (!this._streamingChatRafPending) {
			this._streamingChatRafPending = true;
			requestAnimationFrame(() => {
				this._streamingChatRafPending = false;
				if (this._streamingMsgEl) {
					this._streamingMsgEl.textContent = this._streamingChatBuffer;
					if (this._chatAutoScroll) {
						this._chatEl.scrollTop = this._chatEl.scrollHeight;
					}
					this._onStreamChunk();
				}
			});
		}
	}

	_flushBubble() {
		this._bubbleRafPending = false;
		if (!this._thoughtTextEl) return;

		let t = this._bubbleBuffer;

		// Roll forward past completed sentences so the bubble feels live
		const sentenceEnd = t.search(/[.!?]\s/);
		if (sentenceEnd !== -1 && t.length > sentenceEnd + 2) {
			this._bubbleBuffer = t.slice(sentenceEnd + 2);
			t = this._bubbleBuffer;
		}

		// Show the tail of the current text — reads as live speech being typed
		if (t.length > 80) {
			const tail = t.slice(-70);
			const wordBreak = tail.indexOf(' ');
			t = '…' + (wordBreak !== -1 ? tail.slice(wordBreak + 1) : tail);
		}

		this._thoughtTextEl.textContent = t;
	}

	// Buffers chunk and flushes to DOM on the next animation frame (RAF-batched).
	_streamToBubble(chunk) {
		if (!this._thoughtBubbleEl || !this._thoughtTextEl) return;
		// Trigger debounced walk animation on every chunk (safe — _onStreamChunk is debounced).
		this._onStreamChunk();
		this._thoughtBubbleEl.style.willChange = 'opacity, transform';
		this._thoughtBubbleEl.dataset.active = 'true';
		this._thoughtBubbleEl.dataset.streaming = 'true';
		this._thoughtBubbleEl.setAttribute('aria-label', 'Agent is responding');
		this._bubbleBuffer += chunk;
		if (!this._bubbleRafPending) {
			this._bubbleRafPending = true;
			requestAnimationFrame(() => this._flushBubble());
		}
	}

	// Hides bubble, clears buffer, and cancels any pending RAF/timer.
	_clearThoughtBubble() {
		this._bubbleBuffer = '';
		this._bubbleRafPending = false;
		clearTimeout(this._bubbleClearTimer);
		this._bubbleClearTimer = setTimeout(() => {
			if (!this._thoughtBubbleEl) return;
			this._thoughtBubbleEl.setAttribute('aria-label', '');
			this._thoughtBubbleEl.dataset.active = 'false';
			this._thoughtBubbleEl.dataset.streaming = 'false';
			this._thoughtBubbleEl.dataset.error = 'false';
			if (this._thoughtTextEl) this._thoughtTextEl.textContent = '';
			setTimeout(() => {
				if (this._thoughtBubbleEl) this._thoughtBubbleEl.style.willChange = 'auto';
			}, 300);
		}, 80);
	}

	_showBubbleError(message = 'Something went wrong') {
		if (!this._thoughtBubbleEl || this.getAttribute('avatar-chat') === 'off') return;
		clearTimeout(this._bubbleClearTimer);
		this._thoughtBubbleEl.dataset.active = 'true';
		this._thoughtBubbleEl.dataset.streaming = 'true';
		this._thoughtBubbleEl.dataset.error = 'true';
		if (this._thoughtTextEl) this._thoughtTextEl.textContent = message;
		this._bubbleClearTimer = setTimeout(() => {
			this._thoughtBubbleEl.dataset.error = 'false';
			this._clearThoughtBubble();
		}, 3000);
	}

	// Disables/re-enables the input and updates placeholder during LLM turns.
	_setBusy(busy) {
		if (!this._inputEl) return;
		this._inputEl.disabled = busy;
		this._inputEl.dataset.state = busy ? 'thinking' : '';
		const row = this._inputEl.closest('.input-row');
		if (row) row.dataset.busy = busy ? 'true' : 'false';
		this._inputEl.placeholder = busy ? 'Thinking…' : 'Say something...';
		if (!busy && this.shadowRoot?.activeElement == null) {
			this._inputEl.focus();
		}
	}

	// Walk animation: debounced — keeps walking as long as chunks arrive within 600ms of each other.
	_onStreamChunk() {
		if (!this._scene || this.getAttribute('avatar-walk') === 'off') return;
		const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (!this._isWalking && !prefersReduced) {
			this._isWalking = true;
			clearTimeout(this._gestureDoneIdle);
			// fade_ms: 300ms idle→walk, 500ms walk→idle, 600ms debounce after last chunk
			this._scene.playClipByName('walk', { loop: true, fade_ms: 300 });
			// Keep the state-machine bookkeeping in sync — react/emote fired
			// while walking will then correctly return to walk afterwards.
			this._avatar?.fireAnimationEvent('walk');
		}
		clearTimeout(this._walkStopDebounce);
		this._walkStopDebounce = setTimeout(() => this._stopWalkAnimation(), 600);
	}

	// Crossfade walk→idle; safe to call even if not currently walking.
	_stopWalkAnimation() {
		if (!this._isWalking) return;
		this._isWalking = false;
		clearTimeout(this._walkStopDebounce);
		if (this._walkMovedX) {
			this._walkMovedX = false;
			this._scene?.moveTo({ x: this._walkHomeX }, { duration: 700 });
		}
		const am = this._viewer?.animationManager;
		const currentClip = am?.currentName;
		const isGesture = currentClip && currentClip !== 'walk' && currentClip !== 'idle';
		if (!isGesture) {
			this._scene?.playClipByName('idle', { loop: true, fade_ms: 500 });
			this._avatar?.fireAnimationEvent('walk-end');
		} else {
			// Let the one-shot gesture finish; idle transition fires after gesture + fade-back (~2.5s)
			clearTimeout(this._gestureDoneIdle);
			this._gestureDoneIdle = setTimeout(() => {
				if (!this._isWalking) {
					this._scene?.playClipByName('idle', { loop: true, fade_ms: 500 });
					this._avatar?.fireAnimationEvent('walk-end');
				}
			}, 2500);
		}
	}

	_toolIndicatorLabel(toolName) {
		const map = {
			searchTokens: 'Searching pump.fun…',
			getTokenDetails: 'Fetching token details…',
			getBondingCurve: 'Reading bonding curve…',
			getTokenTrades: 'Pulling recent trades…',
			getTrendingTokens: 'Loading trending tokens…',
			getNewTokens: 'Loading new launches…',
			getGraduatedTokens: 'Loading graduated tokens…',
			getKingOfTheHill: 'Crowning the king…',
			getCreatorProfile: 'Auditing the creator…',
			getTokenHolders: 'Inspecting holders…',
			wave: 'Waving…',
			remember: 'Saving to memory…',
			play_clip: 'Playing animation…',
		};
		return map[toolName] || `Running ${toolName}…`;
	}

	_showAlertBanner({ level = 'warn', text } = {}) {
		if (!this._alertBannerEl || !text) return;
		this._alertBannerEl.classList.remove('warn', 'danger');
		this._alertBannerEl.classList.add(level === 'danger' ? 'danger' : 'warn');
		this._alertBannerEl.querySelector('.msg-text').textContent = text;
		this._alertBannerEl.dataset.active = 'true';
	}

	_renderToolCallCard({ tool, result }) {
		if (!this._chatEl || !result || result.ok === false) return;
		const data = result.data ?? result;
		const card = this._buildTokenCard(tool, data);
		if (!card) return;
		this._chatEl.querySelector('.suggest-row')?.remove();
		this._chatEl.appendChild(card);
		this._chatEl.scrollTop = this._chatEl.scrollHeight;

		// Surface a sticky banner for clearly dangerous signals.
		if (tool === 'getCreatorProfile') {
			const flags = data?.rugFlags ?? data?.risk_flags ?? data?.flags ?? [];
			const rugged = data?.rugCount ?? data?.rug_count ?? 0;
			if (rugged > 0 || (Array.isArray(flags) && flags.length >= 2)) {
				this._showAlertBanner({
					level: 'danger',
					text: `⚠️ Creator has ${flags.length || rugged} rug indicator${(flags.length || rugged) > 1 ? 's' : ''} — be cautious.`,
				});
			} else if (Array.isArray(flags) && flags.length === 1) {
				this._showAlertBanner({
					level: 'warn',
					text: `One risk flag on this creator: ${flags[0]}`,
				});
			}
		}
	}

	_buildTokenCard(tool, data) {
		if (!data || typeof data !== 'object') return null;
		const fmt = (n, opts = {}) => {
			const v = Number(n);
			if (!Number.isFinite(v)) return '—';
			if (opts.usd) {
				if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
				if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
				return `$${v.toFixed(2)}`;
			}
			if (opts.pct) return `${v.toFixed(1)}%`;
			return v.toLocaleString();
		};

		const card = document.createElement('div');
		card.className = 'token-card solana';

		if (tool === 'getTokenDetails' || tool === 'getKingOfTheHill') {
			const t = data.token || data;
			const symbol = t.symbol || t.ticker || 'TOKEN';
			const name = t.name || '';
			const mcap = t.marketCapUsd ?? t.market_cap_usd ?? t.usd_market_cap;
			const price = t.priceUsd ?? t.price_usd ?? t.usd_price;
			const grad = t.graduationPercent ?? t.graduation_percent ?? t.progress;
			card.innerHTML = `
				<div class="token-card-header">
					<span class="token-card-symbol">$${this._esc(symbol)}</span>
					<span class="token-card-name">${this._esc(name)}</span>
				</div>
				<div class="token-card-grid">
					<div class="token-card-stat"><div class="label">Market cap</div><div class="value">${fmt(mcap, { usd: true })}</div></div>
					<div class="token-card-stat"><div class="label">Price</div><div class="value">${fmt(price, { usd: true })}</div></div>
				</div>
				${
					Number.isFinite(Number(grad))
						? `<div class="token-card-bar"><div class="fill" style="width:${Math.min(100, Math.max(0, Number(grad)))}%"></div></div>
						   <div class="token-card-stat" style="margin-top:4px"><div class="label">Graduation</div><div class="value">${fmt(grad, { pct: true })}</div></div>`
						: ''
				}
			`;
			return card;
		}

		if (tool === 'getBondingCurve') {
			const grad = data.graduationPercent ?? data.graduation_percent ?? data.progress;
			const reserves = data.solReserves ?? data.sol_reserves;
			const tokenReserves = data.tokenReserves ?? data.token_reserves;
			const danger = Number(grad) < 5;
			card.innerHTML = `
				<div class="token-card-header">
					<span class="token-card-symbol">Bonding curve</span>
				</div>
				<div class="token-card-grid">
					${reserves !== undefined ? `<div class="token-card-stat"><div class="label">SOL reserves</div><div class="value">${fmt(reserves)}</div></div>` : ''}
					${tokenReserves !== undefined ? `<div class="token-card-stat"><div class="label">Token reserves</div><div class="value">${fmt(tokenReserves)}</div></div>` : ''}
				</div>
				${
					Number.isFinite(Number(grad))
						? `<div class="token-card-bar"><div class="fill ${danger ? 'danger' : ''}" style="width:${Math.min(100, Math.max(0, Number(grad)))}%"></div></div>
						   <div class="token-card-stat" style="margin-top:4px"><div class="label">Graduation</div><div class="value">${fmt(grad, { pct: true })}</div></div>`
						: ''
				}
			`;
			return card;
		}

		if (tool === 'getCreatorProfile') {
			const flags = data.rugFlags ?? data.risk_flags ?? data.flags ?? [];
			const tokenCount = data.tokenCount ?? data.token_count ?? data.tokens?.length;
			const rugged = data.rugCount ?? data.rug_count ?? 0;
			card.innerHTML = `
				<div class="token-card-header">
					<span class="token-card-symbol">Creator audit</span>
				</div>
				<div class="token-card-grid">
					<div class="token-card-stat"><div class="label">Tokens launched</div><div class="value">${fmt(tokenCount)}</div></div>
					<div class="token-card-stat"><div class="label">Rugs</div><div class="value">${fmt(rugged)}</div></div>
				</div>
				${
					Array.isArray(flags) && flags.length
						? `<div class="flags">${flags.map((f) => `<span class="flag">${this._esc(String(f))}</span>`).join('')}</div>`
						: ''
				}
			`;
			return card;
		}

		if (
			tool === 'getTrendingTokens' ||
			tool === 'getNewTokens' ||
			tool === 'getGraduatedTokens'
		) {
			const list =
				data.tokens || data.results || data.items || (Array.isArray(data) ? data : []);
			if (!list.length) return null;
			const top = list.slice(0, 5);
			card.innerHTML = `
				<div class="token-card-header">
					<span class="token-card-symbol">${tool === 'getTrendingTokens' ? '🔥 Trending' : tool === 'getNewTokens' ? '🆕 New' : '🎓 Graduated'}</span>
				</div>
				<div style="margin-top:8px;display:flex;flex-direction:column;gap:4px">
					${top
						.map((t) => {
							const sym = t.symbol || t.ticker || '?';
							const mc = t.marketCapUsd ?? t.market_cap_usd ?? t.usd_market_cap;
							return `<div style="display:flex;justify-content:space-between"><span>$${this._esc(sym)}</span><span style="font-variant-numeric:tabular-nums;opacity:.8">${fmt(mc, { usd: true })}</span></div>`;
						})
						.join('')}
				</div>
			`;
			return card;
		}

		return null;
	}

	_esc(s) {
		return String(s ?? '').replace(
			/[&<>"]/g,
			(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
		);
	}

	_showError(err) {
		if (this.hasAttribute('kiosk')) return;
		const el = document.createElement('div');
		el.className = 'error';
		el.textContent = `Couldn't load agent: ${err.message || err}`;
		this.shadowRoot.appendChild(el);
	}

	_fail(code, message) {
		this._loadingEl.hidden = true;
		if (this.hasAttribute('kiosk')) {
			this.dispatchEvent(
				new CustomEvent('agent:error', {
					detail: { phase: 'policy', error: { code, message } },
					bubbles: true,
					composed: true,
				}),
			);
			return;
		}
		const el = document.createElement('div');
		el.className = 'error';
		el.textContent = message;
		this.shadowRoot.appendChild(el);
		this.dispatchEvent(
			new CustomEvent('agent:error', {
				detail: { phase: 'policy', error: { code, message } },
				bubbles: true,
				composed: true,
			}),
		);
	}

	async _toggleMic() {
		const voiceServer = this.getAttribute('voice-server');
		if (voiceServer) {
			await this._toggleVoiceClient(voiceServer);
			return;
		}
		// Fallback: Web Speech API (no voice-server attribute)
		if (!this._runtime) return;
		if (this._listening) {
			this._runtime.stt?.stop();
			this._listening = false;
			this._micEl.dataset.listening = 'false';
			return;
		}
		this._listening = true;
		this._micEl.dataset.listening = 'true';
		try {
			const text = await this._runtime.listen();
			if (text) this.say(text, { voice: true });
		} catch (e) {
			console.warn('[agent-3d] listen failed', e);
		} finally {
			this._listening = false;
			this._micEl.dataset.listening = 'false';
		}
	}

	async _toggleVoiceClient(serverUrl) {
		if (this._voiceClient) {
			this._voiceClient.stop();
			this._voiceClient = null;
			return;
		}
		const { VoiceClient } = await import('./runtime/voice-client.js');
		const agentId = this._manifest?.id?.agentId || this.getAttribute('agent-id') || null;
		this._voiceClient = new VoiceClient({ serverUrl, element: this });
		await this._voiceClient.start(agentId);
	}

	async _connectLiveKit(agentId) {
		const base = _scriptOrigin || window.location.origin;
		const resp = await fetch(`${base}/api/agents/${agentId}/livekit-token`, {
			credentials: 'include',
		});
		if (!resp.ok) {
			const body = await resp.json().catch(() => ({}));
			console.warn('[agent-3d] livekit-token fetch failed', resp.status, body);
			return;
		}
		const { token, serverUrl } = await resp.json();
		const { LiveKitVoice } = await import('./runtime/livekit-voice.js');
		const voice = new LiveKitVoice({ serverUrl, token, protocol });
		this._livekitVoice = voice;
		await voice.connect();
	}

	_teardown() {
		// Clear manifest that was auto-resolved from agent-id so the next boot resolves fresh.
		// Suppress attributeChangedCallback to avoid a reboot loop.
		if (this._autoResolvedManifest) {
			this._suppressAttrChange = true;
			try {
				this.removeAttribute('manifest');
			} finally {
				this._suppressAttrChange = false;
			}
			this._autoResolvedManifest = false;
		}
		_untrackLiveViewer(this);
		try {
			this._io?.disconnect();
		} catch {}
		this._io = null;
		try {
			this._ro?.disconnect();
		} catch {}
		try {
			if (this._mqNarrow && this._mqNarrowHandler) {
				this._mqNarrow.removeEventListener('change', this._mqNarrowHandler);
			}
		} catch {}
		if (this._outsideTapHandler) {
			document.removeEventListener('pointerdown', this._outsideTapHandler);
			this._outsideTapHandler = null;
		}
		this._embedBridge?.stop();
		this._embedBridge = null;
		this._detachTradeReactions?.();
		this._detachTradeReactions = null;
		if (this._livekitVoice) {
			this._livekitVoice.disconnect().catch(() => {});
			this._livekitVoice = null;
		}
		if (this._voiceClient) {
			this._voiceClient.stop();
			this._voiceClient = null;
		}
		this._notifier?.detach();
		this._notifier = null;
		this._notifyWalkCleanup?.();
		this._notifyWalkCleanup = null;
		this._speakWalkCleanup?.();
		this._speakWalkCleanup = null;
		this._setBusy(false);
		clearTimeout(this._walkStopDebounce);
		this._walkStopDebounce = null;
		this._isWalking = false;
		this._walkMovedX = false;
		this._bubbleBuffer = '';
		this._bubbleRafPending = false;
		clearTimeout(this._bubbleClearTimer);
		this._bubbleClearTimer = null;
		this._streamingMsgEl = null;
		this._streamingChatBuffer = '';
		this._streamingChatRafPending = false;
		this._chatAutoScroll = true;
		this._pendingSay = null;
		try {
			this._runtime?.cancel();
			this._runtime?.destroy();
		} catch {}
		try {
			this._avatar?.detach();
		} catch {}
		try {
			this._viewer?.dispose?.();
		} catch {}
		this._mounted = false;
		this._pillActive = false;
		this._runtime = this._viewer = this._scene = this._memory = this._skills = this._avatar = null;
	}

	// --- Public JS API ---

	say(text, opts = {}) {
		if (this._pendingSay) {
			this._pendingSay = { text, opts };
			return;
		}
		this._pendingSay = { text, opts };
		this._drainSayQueue();
	}

	async _drainSayQueue() {
		while (this._pendingSay) {
			const { text, opts } = this._pendingSay;
			this._pendingSay = null;
			try {
				if (!this._runtime) await this._waitForReady();
				this._onStreamChunk();
				protocol.emit({ type: ACTION_TYPES.LOOK_AT, payload: { target: 'user' } });
				protocol.emit({
					type: ACTION_TYPES.EMOTE,
					payload: { trigger: 'curiosity', weight: 0.6 },
				});
				protocol.emit({
					type: ACTION_TYPES.THINK,
					payload: { thought: 'processing your message...' },
				});
				protocol.emit({
					type: ACTION_TYPES.EMOTE,
					payload: { trigger: 'patience', weight: 0.5 },
				});
				await this._runtime.send(text, { voice: opts.voice ?? this.hasAttribute('voice') });
			} catch (err) {
				this._stopWalkAnimation();
				const msg = err?.message?.includes('429')
					? 'Too many requests — try again'
					: err?.message?.includes('busy')
						? 'Still thinking…'
						: 'Connection error';
				this._showBubbleError(msg);
				this._setBusy(false);
				protocol.emit({
					type: ACTION_TYPES.EMOTE,
					payload: { trigger: 'concern', weight: 0.8 },
				});
				this.dispatchEvent(
					new CustomEvent('agent:error', {
						detail: { phase: 'send', error: err },
						bubbles: true,
						composed: true,
					}),
				);
			}
		}
	}

	// Play speak animation — tries 'talk', falls back to 'yes', then 'wave'.
	speak(text, opts = {}) {
		const duration = Math.max(1.5, (text?.split(' ').length ?? 3) * 0.3);
		const sc = this._scene;
		if (!sc) return;
		sc.playAnimationByHint('talk', { duration }) ||
			sc.playAnimationByHint('yes', { duration }) ||
			sc.playAnimationByHint('wave', { duration });
	}

	async ask(text, opts = {}) {
		if (!this._runtime) await this._waitForReady();
		this._onStreamChunk();
		protocol.emit({ type: ACTION_TYPES.LOOK_AT, payload: { target: 'user' } });
		protocol.emit({ type: ACTION_TYPES.EMOTE, payload: { trigger: 'curiosity', weight: 0.6 } });
		protocol.emit({
			type: ACTION_TYPES.THINK,
			payload: { thought: 'processing your message...' },
		});
		protocol.emit({ type: ACTION_TYPES.EMOTE, payload: { trigger: 'patience', weight: 0.5 } });
		try {
			const reply = await this._runtime.send(text, {
				voice: opts.voice ?? this.hasAttribute('voice'),
			});
			return reply?.text || '';
		} catch (err) {
			this._stopWalkAnimation();
			this._clearThoughtBubble();
			this._setBusy(false);
			protocol.emit({
				type: ACTION_TYPES.EMOTE,
				payload: { trigger: 'concern', weight: 0.8 },
			});
			throw err;
		}
	}

	clearConversation() {
		this._runtime?.clearConversation();
	}

	/**
	 * Play a named emote. Tries a fallback hint chain before head-bobbing.
	 * Emote names: 'cheer', 'flinch', 'celebrate'
	 */
	playEmote(name, intensity = 1) {
		const sc = this._scene;
		if (!sc) return false;
		const fallbacks = {
			cheer: ['cheer', 'celebrate', 'wave'],
			flinch: ['flinch', 'defeated', 'concern', 'shake'],
			celebrate: ['celebrate', 'wave'],
		};
		for (const h of fallbacks[name] || [name]) {
			if (sc.playAnimationByHint(h)) return true;
		}
		this._headBob(intensity);
		return false;
	}

	_headBob(intensity = 1) {
		const sc = this._scene;
		if (!sc) return;
		const bone = sc._findBone(['Head', 'head', 'mixamorigHead']);
		if (!bone) return;
		const start = performance.now();
		const origX = bone.rotation.x;
		const tick = () => {
			const t = (performance.now() - start) / 800;
			if (t >= 1) {
				bone.rotation.x = origX;
				sc._removeHook(tick);
				return;
			}
			bone.rotation.x = origX + 0.15 * intensity * Math.sin(t * Math.PI * 3);
			sc.viewer.invalidate();
		};
		sc._addHook(tick);
	}

	async wave(opts) {
		return this._scene?.playAnimationByHint('wave', opts);
	}
	async lookAt(target) {
		return this._scene?.lookAt(target);
	}
	async play(name, opts) {
		return this._scene?.playClipByName(name, opts);
	}

	/**
	 * Combined animation list available to the loaded model.
	 *
	 * Mirrors the heuristic in `home-act2-viewer.listAvailableClips`:
	 *   • If the GLB ships with 3+ non-idle baked clips (e.g. RobotExpressive),
	 *     show only those — manifest clips are Mixamo-retargeted to the canonical
	 *     Avaturn skeleton and won't bind to a foreign rig.
	 *   • Otherwise (humanoid / Avaturn-compatible — CZ, Default, most user
	 *     avatars), prefer manifest defs (rich label/icon/loop) and append any
	 *     extra baked clips not already covered.
	 *
	 * Returned shape is host-friendly: `{ name, label, icon, loop, source }`.
	 * Empty array if no model loaded yet (host should re-request on `op:'clips'`).
	 *
	 * @returns {Array<{name:string, label:string, icon:string, loop:boolean, source:'glb'|'manifest'}>}
	 */
	_listAvailableClips() {
		const sc = this._scene;
		const am = this._viewer?.animationManager;
		const baked = (sc?.clips || []).map((c) => c?.name).filter(Boolean);
		const defs = am?.getAnimationDefs?.() || [];

		const IDLE_RE = /idle/i;
		const bakedNonIdle = baked.filter((n) => !IDLE_RE.test(n));

		// Skeletal mismatch guard: if the GLB has its own rig+clips, manifest
		// retargets won't apply — return baked-only.
		if (bakedNonIdle.length >= 3) {
			return baked.map((name) => ({
				name,
				label: name,
				icon: '✨',
				loop: true,
				source: 'glb',
			}));
		}

		const out = [];
		const seen = new Set();
		for (const def of defs) {
			if (!def?.name || seen.has(def.name)) continue;
			seen.add(def.name);
			out.push({
				name: def.name,
				label: def.label || def.name,
				icon: def.icon || '✨',
				loop: def.loop !== false,
				source: 'manifest',
			});
		}
		for (const name of baked) {
			if (seen.has(name)) continue;
			seen.add(name);
			out.push({ name, label: name, icon: '✨', loop: true, source: 'glb' });
		}
		return out;
	}

	/**
	 * Enable the inline avatar-in-chat layout.
	 * The avatar canvas is visible through a transparent window between the chat
	 * history and the input bar. The avatar walks during LLM streaming and shows
	 * a thought bubble with streaming text above its head.
	 * This is the default state. Call to re-enable after {@link disableAvatarChat}.
	 * @returns {void}
	 */
	enableAvatarChat() {
		this.removeAttribute('avatar-chat');
	}

	/**
	 * Disable the inline avatar-in-chat layout and restore the original
	 * bottom-bar chat layout (messages left, input right, avatar in background).
	 * Walk animation and thought bubble will not fire while disabled.
	 * Equivalent to setting the `avatar-chat="off"` attribute.
	 * @returns {void}
	 */
	disableAvatarChat() {
		this.setAttribute('avatar-chat', 'off');
		this._stopWalkAnimation();
		this._clearThoughtBubble();
	}

	/**
	 * Enable the walk animation during streaming and scrolling.
	 * This is the default state. Call to re-enable after {@link disableAvatarWalk}.
	 * @returns {void}
	 */
	enableAvatarWalk() {
		this.removeAttribute('avatar-walk');
	}

	/**
	 * Disable the walk animation globally.
	 * The avatar will stay in its idle or empathy-layer animations even while
	 * streaming text or scrolling the chat.
	 * Equivalent to setting the `avatar-walk="off"` attribute.
	 * @returns {void}
	 */
	disableAvatarWalk() {
		this.setAttribute('avatar-walk', 'off');
		this._stopWalkAnimation();
	}

	async installSkill(uri) {
		if (!this._skills) throw new Error('Agent not mounted');
		return this._skills.install({ uri });
	}
	uninstallSkill(name) {
		return this._skills?.uninstall(name);
	}
	get skills() {
		return this._skills?.all() || [];
	}
	get memory() {
		return this._memory;
	}
	get manifest() {
		return this._manifest;
	}
	get runtime() {
		return this._runtime;
	}

	setMode(mode) {
		this.setAttribute('mode', mode);
	}
	setPosition(pos, offset) {
		this.setAttribute('position', pos);
		if (offset) this.setAttribute('offset', offset);
	}
	setSize(w, h) {
		this.setAttribute('width', w);
		this.setAttribute('height', h);
	}

	pause() {
		this._runtime?.pause();
	}
	resume() {
		/* viewer resumes via IntersectionObserver */
	}
	destroy() {
		this._teardown();
	}

	/**
	 * Slide the avatar into frame, speak a message, then retreat.
	 * Queued — back-to-back calls wait for the previous to finish.
	 * @param {string} message
	 * @param {{ priority?: 'low'|'normal'|'high', duration?: number }} [opts]
	 */
	notify(message, { priority = 'normal', duration = 6000 } = {}) {
		protocol.emit({ type: ACTION_TYPES.NOTIFY, payload: { message, priority, duration } });
	}

	/**
	 * Trigger an emotion stimulus on the running avatar(s) via the protocol bus.
	 * Trigger names match the avatar's emotion vocabulary:
	 *   'celebration' | 'concern' | 'curiosity' | 'empathy' | 'patience'
	 * Weight is clamped to [0, 1] by the avatar; defaults to 0.7.
	 * No-op if the agent hasn't booted yet.
	 */
	expressEmotion(trigger, weight = 0.7) {
		if (!trigger) return false;
		protocol.emit(ACTION_TYPES.EMOTE, {
			trigger,
			weight: Math.max(0, Math.min(1, Number(weight) || 0)),
			agentId: this._manifest?.id?.agentId,
		});
		return true;
	}

	_waitForReady() {
		if (this._mounted) return Promise.resolve();
		return new Promise((resolve) => {
			const on = () => {
				this.removeEventListener('agent:ready', on);
				resolve();
			};
			this.addEventListener('agent:ready', on);
			if (!this._booting) this._boot();
		});
	}
}

function stripFrontmatter(text) {
	const m = text.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
	return m ? m[1] : text;
}

if (!customElements.get('agent-3d')) {
	customElements.define('agent-3d', Agent3DElement);
}

export { Agent3DElement };
