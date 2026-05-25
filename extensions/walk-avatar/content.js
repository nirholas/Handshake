// content.js — injected into pages to mount the walking avatar iframe.
// Handles: mounting, dragging, close, SPA navigation survival, postMessage relay.

import { Narrator } from './narrator.js';

(function () {
	'use strict';

	const THREEWS = 'https://three.ws';
	const CONTAINER_ID = '__threews_walk_container__';

	let container = null;
	let iframe = null;
	let mounted = false;

	// Drag state
	let dragging = false;
	let dragOffX = 0, dragOffY = 0;

	function buildEmbedSrc(avatarId, settings) {
		const p = new URLSearchParams();
		if (avatarId) p.set('avatar', avatarId);
		p.set('controls', 'joystick');
		p.set('autoplay', 'true');
		p.set('ground', 'false');
		p.set('orbit', 'false');
		p.set('bg', 'transparent');
		if (settings?.walkSpeed && settings.walkSpeed !== 1) p.set('speed', String(settings.walkSpeed));
		return `${THREEWS}/walk-embed?${p}`;
	}

	function getPosition(pos) {
		const margin = '16px';
		switch (pos) {
			case 'top-left':    return { top: margin, left: margin, bottom: 'auto', right: 'auto' };
			case 'top-right':   return { top: margin, right: margin, bottom: 'auto', left: 'auto' };
			case 'bottom-left': return { bottom: margin, left: margin, top: 'auto', right: 'auto' };
			default:            return { bottom: margin, right: margin, top: 'auto', left: 'auto' };
		}
	}

	function applyPosition(el, pos) {
		const p = getPosition(pos);
		Object.assign(el.style, p);
	}

	function mount(avatarId, settings) {
		if (mounted || document.getElementById(CONTAINER_ID)) {
			// Already mounted — just update avatar if needed
			if (iframe && avatarId) {
				iframe.contentWindow?.postMessage({ type: 'walk:setAvatar', id: avatarId }, THREEWS);
			}
			return;
		}

		const w = settings?.width || 180;
		const h = settings?.height || 260;
		const pos = settings?.position || 'bottom-right';

		container = document.createElement('div');
		container.id = CONTAINER_ID;
		container.style.cssText = `
			position: fixed;
			width: ${w}px;
			height: ${h}px;
			z-index: 2147483647;
			background: transparent;
			border-radius: 12px;
			overflow: hidden;
			pointer-events: auto;
			box-shadow: 0 8px 32px rgba(0,0,0,0.28);
		`;
		applyPosition(container, pos);

		// Drag handle at top of container
		const handle = document.createElement('div');
		handle.style.cssText = `
			position: absolute;
			top: 0; left: 0; right: 0;
			height: 20px;
			cursor: grab;
			z-index: 10;
			background: rgba(0,0,0,0.18);
			backdrop-filter: blur(4px);
			-webkit-backdrop-filter: blur(4px);
		`;

		// Close button
		const closeBtn = document.createElement('button');
		closeBtn.textContent = '×';
		closeBtn.title = 'Close avatar';
		closeBtn.style.cssText = `
			position: absolute;
			top: 2px; right: 4px;
			width: 16px; height: 16px;
			border: 0;
			background: transparent;
			color: rgba(255,255,255,0.7);
			font-size: 13px;
			line-height: 1;
			cursor: pointer;
			padding: 0;
			display: flex;
			align-items: center;
			justify-content: center;
		`;
		closeBtn.addEventListener('click', () => unmount());
		handle.appendChild(closeBtn);

		iframe = document.createElement('iframe');
		iframe.src = buildEmbedSrc(avatarId, settings);
		iframe.title = 'three.ws walking avatar';
		iframe.allow = 'accelerometer; gyroscope';
		iframe.style.cssText = `
			width: 100%;
			height: 100%;
			border: 0;
			background: transparent;
			display: block;
		`;

		container.appendChild(handle);
		container.appendChild(iframe);
		document.body.appendChild(container);
		mounted = true;

		// Drag on handle
		handle.addEventListener('mousedown', startDrag);
		handle.addEventListener('touchstart', startDragTouch, { passive: false });

		// Relay postMessage from iframe to extension background
		window.addEventListener('message', onIframeMessage);
	}

	function unmount() {
		if (!mounted) return;
		window.removeEventListener('message', onIframeMessage);
		if (container && container.parentNode) container.parentNode.removeChild(container);
		container = null;
		iframe = null;
		mounted = false;
	}

	// ── Drag implementation ───────────────────────────────────────────────
	function startDrag(e) {
		if (e.target.tagName === 'BUTTON') return;
		dragging = true;
		const rect = container.getBoundingClientRect();
		dragOffX = e.clientX - rect.left;
		dragOffY = e.clientY - rect.top;
		document.addEventListener('mousemove', onDrag);
		document.addEventListener('mouseup', stopDrag);
		e.preventDefault();
	}

	function onDrag(e) {
		if (!dragging || !container) return;
		const x = Math.max(0, Math.min(window.innerWidth - container.offsetWidth, e.clientX - dragOffX));
		const y = Math.max(0, Math.min(window.innerHeight - container.offsetHeight, e.clientY - dragOffY));
		container.style.left = x + 'px';
		container.style.top = y + 'px';
		container.style.right = 'auto';
		container.style.bottom = 'auto';
	}

	function stopDrag() {
		dragging = false;
		document.removeEventListener('mousemove', onDrag);
		document.removeEventListener('mouseup', stopDrag);
	}

	function startDragTouch(e) {
		if (e.touches.length !== 1) return;
		const t = e.touches[0];
		dragging = true;
		const rect = container.getBoundingClientRect();
		dragOffX = t.clientX - rect.left;
		dragOffY = t.clientY - rect.top;
		document.addEventListener('touchmove', onDragTouch, { passive: false });
		document.addEventListener('touchend', stopDragTouch);
		e.preventDefault();
	}

	function onDragTouch(e) {
		if (!dragging || !container || e.touches.length !== 1) return;
		const t = e.touches[0];
		const x = Math.max(0, Math.min(window.innerWidth - container.offsetWidth, t.clientX - dragOffX));
		const y = Math.max(0, Math.min(window.innerHeight - container.offsetHeight, t.clientY - dragOffY));
		container.style.left = x + 'px';
		container.style.top = y + 'px';
		container.style.right = 'auto';
		container.style.bottom = 'auto';
		e.preventDefault();
	}

	function stopDragTouch() {
		dragging = false;
		document.removeEventListener('touchmove', onDragTouch);
		document.removeEventListener('touchend', stopDragTouch);
	}

	// ── postMessage from iframe ───────────────────────────────────────────
	function onIframeMessage(e) {
		if (!iframe || e.source !== iframe.contentWindow) return;
		const msg = e.data;
		if (!msg || typeof msg !== 'object') return;
		// Re-dispatch as a DOM event on document for any host-page listeners
		try {
			document.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
		} catch {}
	}

	// ── SPA navigation: survive pushState ────────────────────────────────
	(function patchHistory() {
		const orig = history.pushState.bind(history);
		history.pushState = function (...args) {
			orig(...args);
			// Keep avatar alive — do nothing. Container is fixed-position so
			// SPA route changes don't affect it.
		};
	})();

	window.addEventListener('popstate', () => {
		// Avatar survives popstate naturally.
	});

	// ── Narrator ──────────────────────────────────────────────────────────
	let narrator = null;

	function initNarrator(settings) {
		if (!settings?.narrationEnabled) return;
		if (narrator) return;
		narrator = new Narrator({
			getIframe: () => iframe,
			getSession: () => {
				// Session is accessed async but cached here for sync use
				return contentSession;
			},
			getSettings: () => {
				return syncSettings;
			},
		});
		narrator.start();
	}

	// Cache settings/session for narrator access
	let contentSession = null;
	let syncSettings = {};
	chrome.storage.local.get('threews_session', ({ threews_session }) => {
		contentSession = threews_session || null;
	});
	chrome.storage.sync.get(null, (s) => {
		syncSettings = s || {};
	});

	// ── Message listener from background / popup ──────────────────────────
	chrome.runtime.onMessage.addListener((msg) => {
		if (msg.type === 'walk:mount') {
			chrome.storage.sync.get(null, (settings) => {
				syncSettings = settings;
				mount(msg.avatarId || settings.avatarId, settings);
				initNarrator(settings);
			});
		} else if (msg.type === 'walk:unmount') {
			narrator?.stop();
			narrator = null;
			unmount();
		} else if (msg.type === 'walk:setAvatar') {
			if (iframe) {
				iframe.contentWindow?.postMessage({ type: 'walk:setAvatar', id: msg.avatarId }, THREEWS);
			}
		} else if (msg.type === 'walk:setSpeed') {
			if (iframe) {
				iframe.contentWindow?.postMessage({ type: 'walk:config', speed: msg.speed }, THREEWS);
			}
		} else if (msg.type === 'walk:muteNarration') {
			narrator?.mute();
		} else if (msg.type === 'walk:unmuteNarration') {
			narrator?.unmute();
		}
	});
})();
