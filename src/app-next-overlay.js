// UX preview overlay for /app-next — re-skins /src/app.js without touching it.

import { getMe, readAuthHint, saveRemoteGlbToAccount } from './account.js';

const STORAGE_HINT_KEY = 'nxt:first-hint-dismissed';
const CHIP_ROTATE_MS = 9000;
const IDLE_HIDE_MS = 5000;
const AGENT_BUBBLE_MS = 6000;

// Suggested chat prompts — animation primers + agent questions. Each prompt's
// optional `clip` plays the matching animation alongside the chat reply, so
// "Wave at me!" actually triggers the wave clip when the agent answers.
const CHAT_PROMPTS = [
	{ text: 'Wave at me!', icon: '👋', clip: 'av-waving' },
	{ text: 'Do a superhero jump', icon: '🦸', clip: 'av-superhero-jump' },
	{ text: 'Show me a dance', icon: '🥊', clip: 'boxer-dance' },
	{ text: 'Flex for me', icon: '💪', clip: 'av-flex-arm' },
	{ text: 'Brag and clap', icon: '👏', clip: 'av-brag-and-clap' },
	{ text: 'Who are you?', icon: '👤' },
	{ text: 'What can you do?', icon: '✨' },
	{ text: 'Tell me about three.ws', icon: '🌐' },
	{ text: 'Why are you embodied?', icon: '🧠' },
	{ text: 'Sneak walk away', icon: '🚶', clip: 'av-walk-crouching' },
];
const VISIBLE_CHIPS = 3;

const ICON_OVERRIDES = {
	idle: '🧍',
	lookdown: '👀',
	covereyes: '🙈',
	facepalm: '🤦',
	'av-waving': '👋',
	'av-superhero-jump': '🦸',
	'boxer-dance': '🥊',
	'av-brag-and-clap': '👏',
	'av-flex-arm': '💪',
	'av-walk-crouching': '🚶',
	'av-idle-breath': '🧘',
	'av-waiting': '🕰️',
};

// Camera preset framings, all expressed relative to the avatar's bounding box.
// Each entry maps to (cameraOffset, targetOffset) computed at preset time.
const CAMERA_PRESETS = {
	face: { framePadding: 0.6, heightFrac: 0.92, distFrac: 1.5, targetY: 0.92 },
	body: { framePadding: 1.25, heightFrac: 0.55, distFrac: 2.6, targetY: 0.5 },
	wide: { framePadding: 1.9, heightFrac: 0.5, distFrac: 4.0, targetY: 0.45 },
	hero: { framePadding: 1.55, heightFrac: 0.3, distFrac: 3.2, targetY: 0.55 },
};

document.addEventListener('DOMContentLoaded', boot);

function boot() {
	wireExploreMenu();
	wireUserMenu();
	wireFirstHint();
	wireKeyboardShortcuts();
	wirePrimaryCTA();
	wireAnimationSheet();
	wireChatDock();
	wireShare();
	wireFullscreen();
	wireCameraPresets();
	wireHelp();
	wireAutoHide();
	wireDeployMirror();
	wireVisitorCard();
	wirePosterSkeleton();

	waitForViewer().then((viewer) => {
		if (!viewer) {
			console.warn('[nxt] viewer never appeared — stage polish skipped');
			return;
		}
		polishStage(viewer);
		startChatChipRotation(viewer);
		startCameraDrift(viewer);
		hookAgentBubble();
		applyCameraPreset('body'); // initial framing
	});

	refreshAuthState();
	window.addEventListener('storage', (e) => {
		if (e.key === 'nxt-auth-touch' || e.key?.startsWith('auth')) refreshAuthState();
	});
}

// ── Viewer wait ───────────────────────────────────────────────────────────

function waitForViewer(timeoutMs = 15000) {
	return new Promise((resolve) => {
		const started = Date.now();
		const tick = () => {
			const v = window.VIEWER?.viewer;
			if (v && v.scene && v.renderer && v.controls) return resolve(v);
			if (Date.now() - started > timeoutMs) return resolve(null);
			setTimeout(tick, 120);
		};
		tick();
	});
}

function waitForAgent(timeoutMs = 15000) {
	return new Promise((resolve) => {
		const started = Date.now();
		const tick = () => {
			const a = window.VIEWER?.agent;
			if (a && typeof a._send === 'function' && a.panel) return resolve(a);
			if (Date.now() - started > timeoutMs) return resolve(null);
			setTimeout(tick, 150);
		};
		tick();
	});
}

// ── Stage polish ──────────────────────────────────────────────────────────

function polishStage(viewer) {
	try {
		viewer.state.transparentBg = true;
		viewer.updateBackground();
	} catch (err) {
		console.warn('[nxt] could not set transparent canvas', err);
	}
}

// ── Camera idle drift ─────────────────────────────────────────────────────

function startCameraDrift(viewer) {
	if (!viewer.controls) return;

	let userInteracted = false;
	let resumeTimer = null;

	const enableDrift = () => {
		viewer.state.autoRotate = true;
		viewer.controls.autoRotate = true;
		viewer.controls.autoRotateSpeed = 0.35;
		viewer.invalidate?.();
	};

	const pauseDrift = () => {
		viewer.state.autoRotate = false;
		viewer.controls.autoRotate = false;
		userInteracted = true;
		clearTimeout(resumeTimer);
		resumeTimer = setTimeout(() => {
			if (userInteracted) {
				userInteracted = false;
				enableDrift();
			}
		}, 10000);
	};

	enableDrift();
	viewer.controls.addEventListener('start', pauseDrift);
}

// ── Camera presets ────────────────────────────────────────────────────────

function applyCameraPreset(name) {
	const viewer = window.VIEWER?.viewer;
	if (!viewer || !viewer.content || !viewer.controls || !viewer.defaultCamera) return;
	const preset = CAMERA_PRESETS[name];
	if (!preset) return;

	const THREE = window.THREE;
	if (!THREE) return;

	const box = new THREE.Box3().setFromObject(viewer.content);
	const size = box.getSize(new THREE.Vector3());
	const center = box.getCenter(new THREE.Vector3());
	if (!isFinite(size.length()) || size.length() === 0) return;

	const fovRad = viewer.defaultCamera.fov * (Math.PI / 180);
	const fittingHeight = size.y * preset.framePadding;
	const baseDist = fittingHeight / 2 / Math.tan(fovRad / 2);
	const dist = baseDist * (preset.distFrac / 2.6);

	const targetY = box.min.y + size.y * preset.targetY;
	const camY = box.min.y + size.y * preset.heightFrac;
	const target = new THREE.Vector3(center.x, targetY, center.z);
	const pos = new THREE.Vector3(center.x + dist * 0.12, camY, center.z + dist);

	if (typeof viewer._tweenCamera === 'function') {
		viewer._tweenCamera(pos, target, 500);
	} else {
		viewer.defaultCamera.position.copy(pos);
		viewer.controls.target.copy(target);
		viewer.controls.update();
		viewer.invalidate?.();
	}
	updatePresetActive(name);
}

function updatePresetActive(name) {
	document.querySelectorAll('.nxt-preset').forEach((btn) => {
		btn.classList.toggle('is-active', btn.dataset.preset === name);
	});
}

function wireCameraPresets() {
	document.querySelectorAll('.nxt-preset').forEach((btn) => {
		btn.addEventListener('click', () => applyCameraPreset(btn.dataset.preset));
	});
}

// ── Chat chip rotation ────────────────────────────────────────────────────

function startChatChipRotation(viewer) {
	const chipsEl = document.getElementById('nxt-chat-chips');
	if (!chipsEl) return;

	let pool = CHAT_PROMPTS.slice();
	let cursor = Math.floor(Math.random() * pool.length);

	const render = () => {
		const available = new Set((viewer.animationManager?.getAnimationDefs?.() || []).map((d) => d.name));
		const filtered = pool.filter((p) => !p.clip || available.size === 0 || available.has(p.clip));
		const showPool = filtered.length >= VISIBLE_CHIPS ? filtered : pool;
		chipsEl.innerHTML = '';
		for (let i = 0; i < VISIBLE_CHIPS; i++) {
			const prompt = showPool[(cursor + i) % showPool.length];
			const chip = document.createElement('button');
			chip.type = 'button';
			chip.className = 'nxt-chat-chip';
			chip.setAttribute('role', 'listitem');
			chip.dataset.text = prompt.text;
			if (prompt.clip) chip.dataset.clip = prompt.clip;
			chip.innerHTML =
				`<span class="nxt-chat-chip__icon">${escHtml(prompt.icon || '✨')}</span>` +
				`<span>${escHtml(prompt.text)}</span>`;
			chip.addEventListener('click', () => sendChat(prompt.text, prompt.clip));
			chipsEl.appendChild(chip);
		}
	};

	render();
	let rotateTimer = setInterval(() => {
		cursor = (cursor + VISIBLE_CHIPS) % pool.length;
		render();
	}, CHIP_ROTATE_MS);

	// Pause rotation when the chat dock is focused/hovered
	const dock = document.getElementById('nxt-chat-dock');
	if (dock) {
		const stop = () => {
			if (rotateTimer) {
				clearInterval(rotateTimer);
				rotateTimer = null;
			}
		};
		const start = () => {
			if (!rotateTimer) {
				rotateTimer = setInterval(() => {
					cursor = (cursor + VISIBLE_CHIPS) % pool.length;
					render();
				}, CHIP_ROTATE_MS);
			}
		};
		dock.addEventListener('mouseenter', stop);
		dock.addEventListener('mouseleave', start);
		dock.addEventListener('focusin', stop);
		dock.addEventListener('focusout', start);
	}
}

// ── Chat dock — input + send wires through NichAgent ──────────────────────

function wireChatDock() {
	const input = document.getElementById('nxt-chat-input');
	const form = document.getElementById('nxt-chat-form');
	const mic = document.getElementById('nxt-chat-mic');
	if (!form || !input) return;

	form.addEventListener('submit', (e) => {
		e.preventDefault();
		const text = input.value.trim();
		if (!text) return;
		sendChat(text);
		input.value = '';
	});

	// Pin chat-active class while input is focused or NichAgent panel is open.
	input.addEventListener('focus', () => document.body.classList.add('nxt-chat-active'));
	input.addEventListener('blur', () => {
		setTimeout(() => {
			if (!document.activeElement?.closest('.nxt-chat-dock, .nich-panel')) {
				document.body.classList.remove('nxt-chat-active');
			}
		}, 100);
	});

	// Push-to-talk via spacebar (NichAgent's mic toggle covers the actual recognition).
	if (mic && 'webkitSpeechRecognition' in window) {
		mic.hidden = false;
		mic.addEventListener('click', () => triggerMicToggle(mic));
		document.addEventListener('keydown', (e) => {
			if (e.code !== 'Space') return;
			if (e.target.matches('input, textarea, [contenteditable="true"]')) return;
			e.preventDefault();
			triggerMicToggle(mic);
		});
	}
}

async function triggerMicToggle(micEl) {
	const agent = await waitForAgent(8000);
	if (!agent) return;
	const agentMicBtn = agent.panel?.querySelector('.nich-mic');
	if (!agentMicBtn) {
		toast('Voice not available in this browser.');
		return;
	}
	agentMicBtn.click();
	micEl.classList.toggle('is-recording');
}

async function sendChat(text, optionalClip) {
	const agent = await waitForAgent(8000);
	if (!agent) {
		toast('Agent loading… try again in a moment.');
		return;
	}

	// Open the panel so the user sees the conversation thread.
	const panelHidden = agent.panel.style.display === 'none';
	if (panelHidden && typeof agent._togglePanel === 'function') {
		agent._togglePanel();
	}
	document.body.classList.add('nxt-chat-active');

	// Optionally fire the matching animation alongside the chat reply.
	if (optionalClip) {
		const viewer = window.VIEWER?.viewer;
		const mgr = viewer?.animationManager;
		if (mgr && typeof mgr.ensureLoaded === 'function') {
			mgr.ensureLoaded(optionalClip)
				.then(() => mgr.play(optionalClip))
				.catch(() => {});
		}
	}

	const agentInput = agent.panel.querySelector('.nich-input');
	if (agentInput) {
		agentInput.value = text;
		// _send reads the input, pushes the user message, and dispatches to skills/LLM.
		try {
			agent._send();
		} catch (err) {
			console.warn('[nxt] chat send failed', err);
		}
	}
}

// ── Agent speech bubble ───────────────────────────────────────────────────

function hookAgentBubble() {
	const bubble = document.getElementById('nxt-agent-bubble');
	const textEl = document.getElementById('nxt-agent-bubble-text');
	if (!bubble || !textEl) return;

	let hideTimer = null;

	const showReply = (text) => {
		if (!text) return;
		textEl.textContent = text;
		bubble.hidden = false;
		clearTimeout(hideTimer);
		hideTimer = setTimeout(() => {
			bubble.hidden = true;
		}, AGENT_BUBBLE_MS);
	};

	// ACTION_TYPES.SPEAK resolves to 'speak' (lowercase) — match the actual value.
	const protocol = window.VIEWER?.agent_protocol;
	if (protocol && typeof protocol.on === 'function') {
		protocol.on('speak', (action) => {
			const t = action?.payload?.text;
			if (t) showReply(t);
		});
	}
}

// ── Animation sheet ───────────────────────────────────────────────────────

function wireAnimationSheet() {
	const btn = document.getElementById('nxt-anim-btn');
	const sheet = document.getElementById('nxt-anim-sheet');
	const closeBtn = document.getElementById('nxt-anim-sheet-close');
	const search = document.getElementById('nxt-anim-search');
	const grid = document.getElementById('nxt-anim-grid');
	if (!btn || !sheet || !grid) return;

	let rendered = false;

	const open = () => {
		sheet.hidden = false;
		sheet.setAttribute('aria-hidden', 'false');
		btn.setAttribute('aria-expanded', 'true');
		if (!rendered) {
			renderGrid().then(() => {
				rendered = true;
			});
		}
		setTimeout(() => search?.focus(), 60);
	};

	const close = () => {
		sheet.hidden = true;
		sheet.setAttribute('aria-hidden', 'true');
		btn.setAttribute('aria-expanded', 'false');
	};

	btn.addEventListener('click', () => {
		if (sheet.hidden) open();
		else close();
	});

	closeBtn?.addEventListener('click', close);

	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && !sheet.hidden) close();
	});

	document.addEventListener('pointerdown', (e) => {
		if (sheet.hidden) return;
		if (sheet.contains(e.target) || btn.contains(e.target)) return;
		close();
	});

	search?.addEventListener('input', filterGrid);

	async function renderGrid() {
		const viewer = await waitForViewer();
		if (!viewer) {
			grid.innerHTML = '<div class="nxt-anim-empty">Viewer not ready — reload to try again.</div>';
			return;
		}
		await pollForClips(viewer);
		const defs = viewer.animationManager.getAnimationDefs();
		if (!defs || defs.length === 0) {
			grid.innerHTML = '<div class="nxt-anim-empty">This avatar has no animations.</div>';
			return;
		}

		grid.innerHTML = '';
		const activeName = viewer.animationManager.currentName;
		for (const def of defs) {
			const card = document.createElement('button');
			card.type = 'button';
			card.className = 'nxt-anim-card';
			card.dataset.name = def.name;
			card.setAttribute('aria-pressed', activeName === def.name ? 'true' : 'false');
			const icon = ICON_OVERRIDES[def.name] || def.icon || '✨';
			const label = def.label || prettify(def.name);
			card.innerHTML =
				`<span class="nxt-anim-card__icon">${escHtml(icon)}</span>` +
				`<span>${escHtml(label)}</span>`;
			card.addEventListener('click', () => {
				playClip(viewer, def.name);
				grid.querySelectorAll('.nxt-anim-card').forEach((c) => {
					c.setAttribute('aria-pressed', c.dataset.name === def.name ? 'true' : 'false');
				});
			});
			grid.appendChild(card);
		}

		// Chain through any existing onChange so we don't clobber a viewer subscriber.
		const prevOnChange = viewer.animationManager.onChange;
		viewer.animationManager.onChange = (...args) => {
			try { prevOnChange?.(...args); } catch (e) { console.warn('[nxt] prior onChange threw', e); }
			const current = viewer.animationManager.currentName;
			grid.querySelectorAll('.nxt-anim-card').forEach((c) => {
				c.setAttribute('aria-pressed', c.dataset.name === current ? 'true' : 'false');
			});
		};
	}

	function filterGrid() {
		const q = (search?.value || '').trim().toLowerCase();
		const cards = grid.querySelectorAll('.nxt-anim-card');
		let visible = 0;
		cards.forEach((c) => {
			const hay = (c.textContent + ' ' + c.dataset.name).toLowerCase();
			const match = !q || hay.includes(q);
			c.style.display = match ? '' : 'none';
			if (match) visible++;
		});
		grid.querySelectorAll('.nxt-anim-empty[data-search]').forEach((n) => n.remove());
		if (visible === 0) {
			const empty = document.createElement('div');
			empty.className = 'nxt-anim-empty';
			empty.dataset.search = '1';
			empty.textContent = `No clips matching "${q}".`;
			grid.appendChild(empty);
		}
	}
}

function pollForClips(viewer, timeoutMs = 12000) {
	return new Promise((resolve) => {
		const started = Date.now();
		const tick = () => {
			const defs = viewer.animationManager?.getAnimationDefs?.() || [];
			if (defs.length > 0) return resolve(defs);
			if (Date.now() - started > timeoutMs) return resolve([]);
			setTimeout(tick, 300);
		};
		tick();
	});
}

function playClip(viewer, name) {
	const mgr = viewer.animationManager;
	if (!mgr) return;
	const defs = mgr.getAnimationDefs();
	const def = defs.find((d) => d.name === name);
	if (!def) return;
	mgr.ensureLoaded(name)
		.then(() => mgr.play(name))
		.catch((err) => console.warn('[nxt] clip play failed', name, err));
}

// ── Share / embed popover ─────────────────────────────────────────────────

function wireShare() {
	const btn = document.getElementById('nxt-share-btn');
	const pop = document.getElementById('nxt-share-popover');
	const closeBtn = document.getElementById('nxt-share-close');
	const urlEl = document.getElementById('nxt-share-url');
	const embedEl = document.getElementById('nxt-share-embed');
	const urlCopyBtn = document.getElementById('nxt-share-url-copy');
	const embedCopyBtn = document.getElementById('nxt-share-embed-copy');
	if (!btn || !pop) return;

	const refresh = () => {
		const baseUrl = location.origin + '/app';
		const params = new URLSearchParams();
		const agentId = new URLSearchParams(location.search).get('agent');
		if (agentId) {
			params.set('agent', agentId);
		} else {
			const currentModelUrl = window.VIEWER?.app?._currentModelUrl;
			if (currentModelUrl && !currentModelUrl.includes('/avatars/cz.glb')) {
				params.set('model', currentModelUrl);
			}
		}
		const share = params.toString() ? `${baseUrl}?${params.toString()}` : baseUrl;
		urlEl.value = share;

		const kiosk = share + (share.includes('?') ? '&' : '?') + 'kiosk=1';
		embedEl.value =
			`<iframe src="${kiosk}" width="540" height="720" ` +
			`style="border:0;border-radius:18px;overflow:hidden" ` +
			`allow="autoplay;microphone;camera"></iframe>`;
	};

	const open = () => {
		refresh();
		pop.hidden = false;
		btn.setAttribute('aria-expanded', 'true');
	};

	const close = () => {
		pop.hidden = true;
		btn.setAttribute('aria-expanded', 'false');
	};

	btn.addEventListener('click', () => (pop.hidden ? open() : close()));
	closeBtn?.addEventListener('click', close);

	document.addEventListener('pointerdown', (e) => {
		if (pop.hidden) return;
		if (pop.contains(e.target) || btn.contains(e.target)) return;
		close();
	});

	const copy = async (textEl, copyBtn) => {
		const text = textEl.value;
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			textEl.select();
			document.execCommand?.('copy');
		}
		copyBtn.textContent = 'Copied ✓';
		copyBtn.classList.add('is-copied');
		setTimeout(() => {
			copyBtn.textContent = 'Copy';
			copyBtn.classList.remove('is-copied');
		}, 1800);
	};

	urlCopyBtn?.addEventListener('click', () => copy(urlEl, urlCopyBtn));
	embedCopyBtn?.addEventListener('click', () => copy(embedEl, embedCopyBtn));

	// Social share buttons
	const twitterBtn = document.getElementById('nxt-share-twitter');
	const farcasterBtn = document.getElementById('nxt-share-farcaster');
	const telegramBtn = document.getElementById('nxt-share-telegram');

	const shareText = () => {
		const app = window.VIEWER?.app;
		const name = app?.identity?.name;
		return name
			? `Meet ${name} — an embodied AI agent on @threews_`
			: 'Check out this embodied AI agent on @threews_';
	};

	const shareUrl = () => urlEl?.value || location.href;

	twitterBtn?.addEventListener('click', () => {
		const url = `https://x.com/intent/tweet?text=${encodeURIComponent(shareText())}&url=${encodeURIComponent(shareUrl())}`;
		window.open(url, '_blank', 'noopener,noreferrer,width=600,height=400');
	});

	farcasterBtn?.addEventListener('click', () => {
		const url = `https://warpcast.com/~/compose?text=${encodeURIComponent(shareText() + ' ' + shareUrl())}`;
		window.open(url, '_blank', 'noopener,noreferrer,width=600,height=600');
	});

	telegramBtn?.addEventListener('click', () => {
		const url = `https://t.me/share/url?url=${encodeURIComponent(shareUrl())}&text=${encodeURIComponent(shareText())}`;
		window.open(url, '_blank', 'noopener,noreferrer,width=600,height=400');
	});
}

// ── Fullscreen ────────────────────────────────────────────────────────────

function wireFullscreen() {
	const btn = document.getElementById('nxt-fullscreen-btn');
	if (!btn) return;
	const toggle = () => {
		if (!document.fullscreenElement) {
			document.documentElement.requestFullscreen?.().catch(() => {
				toast('Fullscreen blocked by browser.');
			});
		} else {
			document.exitFullscreen?.();
		}
	};
	btn.addEventListener('click', toggle);
}

// ── Header menus ──────────────────────────────────────────────────────────

function wireExploreMenu() {
	const btn = document.getElementById('nxt-more-btn');
	const menu = document.getElementById('nxt-more-menu');
	if (!btn || !menu) return;

	const positionMenu = () => {
		const r = btn.getBoundingClientRect();
		const rightOffset = window.innerWidth - r.right;
		const minEdge = 12;
		menu.style.top = `${r.bottom + 6}px`;
		menu.style.right = `${Math.max(minEdge, rightOffset)}px`;
		menu.style.left = '';
		if (rightOffset < minEdge) {
			menu.style.right = `${minEdge}px`;
		}
	};

	const close = () => {
		menu.hidden = true;
		btn.setAttribute('aria-expanded', 'false');
	};

	btn.addEventListener('click', (e) => {
		e.stopPropagation();
		if (menu.hidden) {
			positionMenu();
			menu.hidden = false;
			btn.setAttribute('aria-expanded', 'true');
		} else {
			close();
		}
	});

	document.addEventListener('pointerdown', (e) => {
		if (menu.hidden) return;
		if (menu.contains(e.target) || btn.contains(e.target)) return;
		close();
	});

	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && !menu.hidden) close();
	});

	window.addEventListener('resize', () => {
		if (!menu.hidden) close();
	});
}

function wireUserMenu() {
	const btn = document.getElementById('nav-user-btn');
	const menu = document.getElementById('nav-user-menu');
	if (!btn || !menu) return;

	const close = () => {
		menu.hidden = true;
		btn.setAttribute('aria-expanded', 'false');
	};

	btn.addEventListener('click', (e) => {
		e.stopPropagation();
		if (menu.hidden) {
			menu.hidden = false;
			btn.setAttribute('aria-expanded', 'true');
		} else {
			close();
		}
	});

	document.addEventListener('pointerdown', (e) => {
		if (menu.hidden) return;
		if (menu.contains(e.target) || btn.contains(e.target)) return;
		close();
	});
}

// ── Auth state + primary CTA ──────────────────────────────────────────────

async function refreshAuthState() {
	const signinEl = document.getElementById('nav-sign-in');
	const userWrap = document.getElementById('nav-user-wrap');
	const userLabel = document.getElementById('nav-user-label');
	const profileLink = document.getElementById('nav-my-profile-link');
	const primary = document.getElementById('nxt-primary');
	const primaryLabel = document.getElementById('nxt-primary-label');

	// Hint paints synchronously; getMe() then confirms.
	const hint = readAuthHint?.();
	if (hint?.username && userLabel) {
		userLabel.textContent = hint.username;
	}

	let me = null;
	try {
		me = await getMe();
	} catch {
		me = null;
	}

	if (me?.username) {
		if (signinEl) signinEl.hidden = true;
		if (userWrap) userWrap.hidden = false;
		if (userLabel) userLabel.textContent = me.username;
		if (profileLink) profileLink.href = `/profile/${encodeURIComponent(me.username)}`;
		if (primaryLabel) primaryLabel.textContent = 'Save to account';
		if (primary) primary.dataset.mode = 'save';
	} else {
		if (signinEl) signinEl.hidden = false;
		if (userWrap) userWrap.hidden = true;
		if (primaryLabel) primaryLabel.textContent = 'Sign in to save';
		if (primary) primary.dataset.mode = 'signin';
	}
}

function wirePrimaryCTA() {
	const primary = document.getElementById('nxt-primary');
	const primaryLabel = document.getElementById('nxt-primary-label');
	if (!primary) return;

	// Outside the closure so a second save can cancel the previous revert.
	let revertTimer = null;

	primary.addEventListener('click', async () => {
		const mode = primary.dataset.mode || 'signin';
		if (mode !== 'save') {
			location.href = '/login?next=' + encodeURIComponent(location.pathname);
			return;
		}

		const viewer = window.VIEWER?.viewer;
		const app = window.VIEWER?.app;
		const source = app?._currentLocalFile || app?._currentModelUrl;
		if (!viewer || !source) {
			toast('Nothing to save yet — load a model first.');
			return;
		}

		const original = 'Save to account';
		if (revertTimer) {
			clearTimeout(revertTimer);
			revertTimer = null;
		}
		if (primaryLabel) primaryLabel.textContent = 'Saving…';
		primary.disabled = true;
		try {
			const meta = {
				name: app?._currentModelName || 'Avatar',
			};
			if (app?._currentLocalFile) {
				meta.source = 'upload';
				if (app._currentLocalFile.name) {
					meta.source_meta = { original_filename: app._currentLocalFile.name };
				}
			}
			const res = await saveRemoteGlbToAccount(source, meta);
			if (res?.id) {
				if (primaryLabel) primaryLabel.textContent = 'Saved ✓';
				toast(`Saved to your account.`, `/avatars/${res.id}`);
			} else {
				throw new Error('save failed');
			}
		} catch (err) {
			console.warn('[nxt] save failed', err);
			if (primaryLabel) primaryLabel.textContent = original;
			const code = err.data?.error || err.code || '';
			const detail = err.data?.error_description || err.message || '';
			if (code === 'plan_limit_count' || code === 'plan_limit_storage') {
				toast('Avatar limit reached — delete old avatars or upgrade your plan.');
			} else if (err.status === 401 || code === 'not_signed_in') {
				toast('Session expired — please sign in again.');
			} else if (err.status === 413 || code === 'plan_limit_size') {
				toast('File too large for your plan.');
			} else if (err.status === 429) {
				toast('Too many uploads — wait a moment and try again.');
			} else if (detail) {
				toast(`Save failed — ${detail}`);
			} else {
				toast('Save failed — try again.');
			}
		} finally {
			revertTimer = setTimeout(() => {
				revertTimer = null;
				if (primaryLabel && primaryLabel.textContent === 'Saved ✓') {
					primaryLabel.textContent = original;
				}
				primary.disabled = false;
			}, 2400);
		}
	});
}

// ── Deploy on-chain mirror ────────────────────────────────────────────────
//
// /src/app.js owns the canonical deploy CTA via #deploy-onchain-btn — it sets
// .href, .hidden, and the inner [data-state-label] (e.g. "Deployed ✓ base").
// We mirror that state into two visible Next surfaces:
//
//   • #nxt-deploy-btn        — pill in the secondary action bar
//   • #nxt-share-deploy      — row inside the Share/Embed popover
//
// A MutationObserver on the source keeps the mirrors in sync as app.js
// re-runs _refreshDeployButton (e.g. after the agent record is fetched and
// the deployed state is known).

function wireDeployMirror() {
	const src = document.getElementById('deploy-onchain-btn');
	if (!src) return;

	const targets = [
		{
			btn: document.getElementById('nxt-deploy-btn'),
			label: document.getElementById('nxt-deploy-label'),
			subEl: null,
			divider: null,
		},
		{
			btn: document.getElementById('nxt-share-deploy'),
			label: document.getElementById('nxt-share-deploy-label'),
			subEl: document.getElementById('nxt-share-deploy-sub'),
			divider: document.getElementById('nxt-share-deploy-divider'),
		},
	].filter((t) => t.btn);

	if (!targets.length) return;

	const sync = () => {
		const hidden = src.hidden || src.hasAttribute('hidden');
		const href = src.getAttribute('href') || '';
		const target = src.getAttribute('target') || '';
		const rel = src.getAttribute('rel') || '';
		const title = src.getAttribute('title') || '';
		const aria = src.getAttribute('aria-label') || '';
		const labelText =
			src.querySelector('[data-state-label]')?.textContent?.trim() ||
			src.textContent?.trim() ||
			'Deploy on-chain';
		const isDeployed = src.classList.contains('is-deployed') || /Deployed/i.test(labelText);

		for (const t of targets) {
			t.btn.hidden = hidden;
			if (t.divider) t.divider.hidden = hidden;

			if (href) t.btn.setAttribute('href', href);
			else t.btn.removeAttribute('href');

			if (target) t.btn.setAttribute('target', target);
			else t.btn.removeAttribute('target');

			if (rel) t.btn.setAttribute('rel', rel);
			else t.btn.removeAttribute('rel');

			if (title) t.btn.setAttribute('title', title);
			if (aria) t.btn.setAttribute('aria-label', aria);

			t.btn.classList.toggle('is-deployed', isDeployed);
			if (t.label) t.label.textContent = labelText;
			if (t.subEl) {
				t.subEl.textContent = isDeployed
					? 'This agent is live on-chain. Open the block explorer to verify.'
					: "Register this agent's identity on ERC-8004 — anyone can find and embed it.";
			}
		}
	};

	sync();

	// Re-run whenever app.js re-paints the source button.
	const obs = new MutationObserver(sync);
	obs.observe(src, {
		attributes: true,
		attributeFilter: ['href', 'hidden', 'target', 'rel', 'title', 'aria-label', 'class'],
		childList: true,
		subtree: true,
		characterData: true,
	});

	// If the user clicks the share-popover row while the popover is open, dismiss
	// it so the navigation feels intentional. (Anchor navigation handles the rest.)
	const shareRow = document.getElementById('nxt-share-deploy');
	const pop = document.getElementById('nxt-share-popover');
	if (shareRow && pop) {
		shareRow.addEventListener('click', () => {
			pop.hidden = true;
			document.getElementById('nxt-share-btn')?.setAttribute('aria-expanded', 'false');
		});
	}
}

// ── Toast ─────────────────────────────────────────────────────────────────

let toastTimer = null;
function toast(message, href) {
	const el = document.getElementById('nxt-toast');
	if (!el) return;
	el.innerHTML = href
		? `${escHtml(message)} <a href="${escHtml(href)}">View →</a>`
		: escHtml(message);
	el.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		el.hidden = true;
	}, 4200);
}

// ── First-visit hint ──────────────────────────────────────────────────────

function wireFirstHint() {
	const hint = document.getElementById('nxt-first-hint');
	const close = document.getElementById('nxt-first-hint-close');
	if (!hint || !close) return;
	try {
		if (localStorage.getItem(STORAGE_HINT_KEY) === '1') return;
	} catch {}
	hint.hidden = false;
	const dismiss = () => {
		hint.hidden = true;
		try {
			localStorage.setItem(STORAGE_HINT_KEY, '1');
		} catch {}
	};
	close.addEventListener('click', dismiss);
	setTimeout(dismiss, 14000);
}

// ── Help overlay ──────────────────────────────────────────────────────────

function wireHelp() {
	const help = document.getElementById('nxt-help');
	const closeBtn = document.getElementById('nxt-help-close');
	if (!help) return;

	const open = () => {
		help.hidden = false;
	};
	const close = () => {
		help.hidden = true;
	};

	closeBtn?.addEventListener('click', close);
	document.addEventListener('keydown', (e) => {
		if (e.target.matches('input, textarea, select, [contenteditable="true"]')) return;
		if (e.key === '?' || (e.shiftKey && e.key === '/')) {
			e.preventDefault();
			help.hidden ? open() : close();
		} else if (e.key === 'Escape' && !help.hidden) {
			close();
		}
	});
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────

function wireKeyboardShortcuts() {
	document.addEventListener('keydown', (e) => {
		// Allow shortcuts inside the chat input only for Esc (which blurs).
		const inField = e.target.matches('input, textarea, select, [contenteditable="true"]');
		if (inField) {
			if (e.key === 'Escape') {
				e.target.blur();
				document.body.classList.remove('nxt-chat-active');
			}
			return;
		}
		if (e.metaKey || e.ctrlKey || e.altKey) return;

		switch (e.key) {
			case 'a':
			case 'A':
				e.preventDefault();
				document.getElementById('nxt-anim-btn')?.click();
				break;
			case 'u':
			case 'U':
				e.preventDefault();
				document.getElementById('file-input')?.click();
				break;
			case 's':
			case 'S':
				e.preventDefault();
				document.getElementById('nxt-share-btn')?.click();
				break;
			case 'f':
			case 'F':
				e.preventDefault();
				document.getElementById('nxt-fullscreen-btn')?.click();
				break;
			case '/':
				if (!e.shiftKey) {
					e.preventDefault();
					document.getElementById('nxt-chat-input')?.focus();
				}
				break;
			case '1':
				e.preventDefault();
				applyCameraPreset('face');
				break;
			case '2':
				e.preventDefault();
				applyCameraPreset('body');
				break;
			case '3':
				e.preventDefault();
				applyCameraPreset('wide');
				break;
			case '4':
				e.preventDefault();
				applyCameraPreset('hero');
				break;
		}
	});
}

// ── Auto-hide chrome on idle ──────────────────────────────────────────────

function wireAutoHide() {
	let idleTimer = null;
	let hasInteracted = false;

	const arm = () => {
		document.body.classList.remove('nxt-chrome-hidden');
		clearTimeout(idleTimer);
		// Don't hide chrome at all until the user has actually engaged with the page —
		// otherwise the bottom bar disappears before they've had a chance to read it.
		if (!hasInteracted) return;
		idleTimer = setTimeout(() => {
			if (document.body.classList.contains('nxt-chat-active')) return;
			if (anyPanelOpen()) return;
			document.body.classList.add('nxt-chrome-hidden');
		}, IDLE_HIDE_MS);
	};

	const markInteracted = () => {
		hasInteracted = true;
		arm();
	};

	['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((evt) =>
		window.addEventListener(evt, markInteracted, { passive: true }),
	);
	// mousemove arms but doesn't count as engagement on its own (cursor lands on the
	// page from another tab without intent).
	window.addEventListener('mousemove', arm, { passive: true });
}

function anyPanelOpen() {
	const ids = ['nxt-anim-sheet', 'nxt-share-popover', 'nxt-help', 'nxt-more-menu', 'nav-user-menu'];
	for (const id of ids) {
		const el = document.getElementById(id);
		if (el && !el.hidden) return true;
	}
	const nichPanel = document.querySelector('.nich-panel');
	if (nichPanel && nichPanel.style.display !== 'none') return true;
	return false;
}

// ── Visitor card + mobile strip ──────────────────────────────────────

function wireVisitorCard() {
	const agentId = new URLSearchParams(location.search).get('agent');
	if (!agentId) return;

	fetchAgentPublic(agentId).then((agent) => {
		if (!agent) return;
		populateVisitorCard(agent);
		populateMobileStrip(agent);
		updatePageTitle(agent);
	});
}

async function fetchAgentPublic(agentId) {
	try {
		const resp = await fetch(`/api/agents/${agentId}`);
		if (!resp.ok) return null;
		const data = await resp.json();
		return data.agent || null;
	} catch {
		return null;
	}
}

function populateVisitorCard(agent) {
	const card = document.getElementById('nxt-visitor-card');
	if (!card) return;

	const nameEl = document.getElementById('nxt-visitor-name');
	const descEl = document.getElementById('nxt-visitor-desc');
	const skillsEl = document.getElementById('nxt-visitor-skills');
	const avatarEl = document.getElementById('nxt-visitor-avatar');
	const statusEl = document.getElementById('nxt-visitor-status');

	if (nameEl) nameEl.textContent = agent.name || 'Agent';

	if (descEl) {
		descEl.textContent = agent.description || 'An embodied AI agent on three.ws';
	}

	if (agent.avatar_thumbnail_url && avatarEl) {
		const img = document.createElement('img');
		img.src = agent.avatar_thumbnail_url;
		img.alt = agent.name || 'Agent avatar';
		img.className = 'nxt-visitor-card__avatar-img';
		img.loading = 'eager';
		const shimmer = avatarEl.querySelector('.nxt-visitor-card__avatar-shimmer');
		if (shimmer) shimmer.remove();
		avatarEl.appendChild(img);
	}

	if (statusEl && agent.is_registered) {
		statusEl.innerHTML = 'On-chain <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
	}

	const skills = agent.skills || [];
	if (skills.length && skillsEl) {
		skillsEl.hidden = false;
		skillsEl.innerHTML = skills
			.slice(0, 6)
			.map((s) => `<span class="nxt-visitor-card__skill">${escHtml(s)}</span>`)
			.join('');
	}

	const shareBtn = document.getElementById('nxt-visitor-share');
	if (shareBtn) {
		shareBtn.addEventListener('click', () => {
			document.getElementById('nxt-share-btn')?.click();
		});
	}

	getMe()
		.then((me) => {
			if (!me) card.hidden = false;
		})
		.catch(() => {
			card.hidden = false;
		});
}

function populateMobileStrip(agent) {
	const strip = document.getElementById('nxt-mobile-agent-strip');
	if (!strip) return;

	const nameEl = document.getElementById('nxt-mobile-name');
	const descEl = document.getElementById('nxt-mobile-desc');
	const avatarEl = document.getElementById('nxt-mobile-avatar');

	if (nameEl) nameEl.textContent = agent.name || 'Agent';
	if (descEl) descEl.textContent = agent.description || '';

	if (agent.avatar_thumbnail_url && avatarEl) {
		avatarEl.style.backgroundImage = `url(${agent.avatar_thumbnail_url})`;
		avatarEl.style.backgroundSize = 'cover';
		avatarEl.style.backgroundPosition = 'center top';
	}

	const shareBtn = document.getElementById('nxt-mobile-share');
	if (shareBtn) {
		shareBtn.addEventListener('click', () => {
			if (navigator.share) {
				navigator.share({
					title: `${agent.name || 'Agent'} — three.ws`,
					text: `Meet ${agent.name || 'this agent'} — an embodied AI agent on three.ws`,
					url: location.href,
				}).catch(() => {});
			} else {
				document.getElementById('nxt-share-btn')?.click();
			}
		});
	}

	strip.hidden = false;
}

function updatePageTitle(agent) {
	if (!agent?.name) return;
	document.title = `${agent.name} — three.ws`;
	const metaDesc = document.querySelector('meta[name="description"]');
	if (metaDesc && agent.description) {
		metaDesc.setAttribute('content', agent.description);
	}
}

// ── Poster skeleton ──────────────────────────────────────────────────

function wirePosterSkeleton() {
	const agentId = new URLSearchParams(location.search).get('agent');
	if (!agentId) return;

	const skeleton = document.getElementById('nxt-poster-skeleton');
	if (!skeleton) return;

	skeleton.hidden = false;

	waitForViewer().then(() => {
		skeleton.classList.add('nxt-poster-skeleton--fading');
		setTimeout(() => {
			skeleton.hidden = true;
		}, 700);
	});
}

// ── Helpers ───────────────────────────────────────────────────────────────

function escHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#39;',
	})[ch]);
}

function prettify(name) {
	return String(name)
		.replace(/^av-/, '')
		.replace(/[-_]/g, ' ')
		.replace(/\b\w/g, (c) => c.toUpperCase());
}
