/**
 * playFirstMeet — first-encounter celebration sequence for a newly generated avatar.
 *
 * @param {object} opts
 * @param {object} opts.viewer    — SceneController / AgentAvatar (duck-typed: .playClip(name) OR .mixer + .animations). Pass null if no 3D viewer.
 * @param {{ id: string, name: string }} opts.agent
 * @param {() => void} opts.onShare    — called when user clicks "Share"
 * @param {() => void} opts.onContinue — called when user clicks "Continue"
 * @returns {Promise<void>} resolves when user clicks either button
 */
import { log } from './shared/log.js';
import { startTour } from './shared/tour.js';
import { rippleOnce } from './ui-juice.js';
export async function playFirstMeet({ viewer, agent, onShare, onContinue }) {
	const reducedMotion =
		typeof window !== 'undefined' &&
		window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

	// Inject stylesheet(s) once — first-meet's own + the shared game-feel classes.
	if (!document.querySelector('link[data-fm-css]')) {
		const link = document.createElement('link');
		link.rel = 'stylesheet';
		link.href = new URL('./first-meet.css', import.meta.url).href;
		link.dataset.fmCss = '1';
		document.head.appendChild(link);
	}
	if (!document.querySelector('link[data-uj-css]')) {
		const link = document.createElement('link');
		link.rel = 'stylesheet';
		link.href = new URL('./ui-juice.css', import.meta.url).href;
		link.dataset.ujCss = '1';
		document.head.appendChild(link);
	}

	// Build root overlay — a full-screen celebration sequence, not a classic dialog,
	// but acts as a modal region so screen readers treat it as one.
	const subtitleId = `fm-label-${Math.trunc(performance.now())}`;
	const root = document.createElement('div');
	root.className = 'first-meet-root';
	root.setAttribute('role', 'dialog');
	root.setAttribute('aria-modal', 'true');
	root.setAttribute('aria-labelledby', subtitleId);

	// Fade overlay (black → transparent) — decorative, hidden from AT
	const overlay = document.createElement('div');
	overlay.className = 'fm-fade-overlay';
	overlay.setAttribute('aria-hidden', 'true');

	// Subtitle — also serves as the accessible dialog label via aria-labelledby
	const subtitle = document.createElement('div');
	subtitle.className = 'fm-subtitle';
	subtitle.id = subtitleId;
	subtitle.textContent = `Hello, I'm ${agent?.name ?? 'your agent'}.`;

	// Action buttons
	const actions = document.createElement('div');
	actions.className = 'fm-actions';

	const btnShare = document.createElement('button');
	btnShare.className = 'fm-btn fm-btn-share';
	btnShare.textContent = 'Share';

	const btnContinue = document.createElement('button');
	btnContinue.className = 'fm-btn fm-btn-continue';
	btnContinue.textContent = 'Continue';

	actions.appendChild(btnShare);
	actions.appendChild(btnContinue);
	root.appendChild(overlay);
	root.appendChild(subtitle);
	root.appendChild(actions);
	document.body.appendChild(root);

	// ── Helpers ───────────────────────────────────────────────────────────────

	function delay(ms) {
		return new Promise((res) => setTimeout(res, ms));
	}

	// Try to play a wave gesture on the viewer (duck-typed).
	// Order probed:
	//   1. viewer.playClip('Wave') — exact name
	//   2. viewer.playClip('wave') — lowercase
	//   3. viewer.playAnimationByHint?.('wave') — partial name search (SceneController)
	//   4. Scripted bone tilt via viewer.mixer + content skeleton
	//      — bones probed: 'mixamorigRightHand', 'RightHand', 'mixamorigRightArm', 'RightArm'
	function tryWave() {
		if (reducedMotion || !viewer) return;

		// Method 1 & 2: direct clip by name
		if (typeof viewer?.playClip === 'function') {
			if (viewer.playClip('Wave')) return;
			if (viewer.playClip('wave')) return;
		}

		// Method 3: SceneController hint search
		if (typeof viewer?.playAnimationByHint === 'function') {
			if (viewer.playAnimationByHint('wave')) return;
			if (viewer.playAnimationByHint('Wave')) return;
		}

		// Method 4: scripted bone animation if mixer exists
		const mixer = viewer?.mixer;
		const root3d = viewer?.content ?? viewer?.scene;
		if (!mixer || !root3d) return;

		const BONE_NAMES = ['mixamorigRightHand', 'RightHand', 'mixamorigRightArm', 'RightArm'];
		let targetBone = null;
		root3d.traverse?.((obj) => {
			if (targetBone) return;
			if (obj.isBone && BONE_NAMES.includes(obj.name)) targetBone = obj;
		});
		if (!targetBone) return;

		// Simple scripted tilt: raise then return over 1.2s using rAF
		const origZ = targetBone.rotation.z;
		const origX = targetBone.rotation.x;
		const RAISE_Z = 1.2; // radians
		const RAISE_X = -0.5;
		const DURATION = 1200; // ms
		let start = null;

		function animateBone(ts) {
			if (!start) start = ts;
			const t = Math.min((ts - start) / DURATION, 1);
			// Ease in-out cubic
			const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
			const wave = Math.sin(t * Math.PI); // arc: 0 → 1 → 0
			targetBone.rotation.z = origZ + RAISE_Z * wave * ease;
			targetBone.rotation.x = origX + RAISE_X * wave * ease;
			if (t < 1) requestAnimationFrame(animateBone);
			else {
				targetBone.rotation.z = origZ;
				targetBone.rotation.x = origX;
			}
		}
		requestAnimationFrame(animateBone);
	}

	// Spawn CSS confetti: 40–60 spans, random hue/size/rotation/position/duration
	function spawnConfetti() {
		if (reducedMotion) return;
		const count = 40 + Math.floor(Math.random() * 21);
		const pieces = [];
		for (let i = 0; i < count; i++) {
			const span = document.createElement('span');
			span.className = 'fm-confetti-piece';
			const hue = Math.floor(Math.random() * 360);
			const w = 6 + Math.random() * 8;
			const h = 10 + Math.random() * 10;
			const left = Math.random() * 100;
			const duration = 1.4 + Math.random() * 0.8;
			const delay_ = Math.random() * 0.4;
			const rot = Math.floor(Math.random() * 360);
			span.style.cssText = `
				left: ${left}%;
				width: ${w}px;
				height: ${h}px;
				background: hsl(${hue},80%,60%);
				transform: rotate(${rot}deg);
				animation-duration: ${duration}s;
				animation-delay: ${delay_}s;
			`.replace(/\s+/g, ' ');
			root.appendChild(span);
			pieces.push(span);
		}
		// Clean up after 2s
		setTimeout(() => pieces.forEach((p) => p.remove()), 2000);
	}

	// ── Sequence ──────────────────────────────────────────────────────────────

	// t=0.0 — fade overlay out (scene reveal)
	await delay(0);
	requestAnimationFrame(() => overlay.classList.add('fm-faded'));

	// t=0.2 — wave
	await delay(200);
	tryWave();

	// t=0.6 — subtitle fades in
	await delay(400);
	subtitle.classList.add('fm-visible');

	// t=1.4 — confetti burst
	await delay(800);
	spawnConfetti();

	// t=2.2 — buttons fade in, with a single restrained accent ripple as the
	// shared "it's done" beat (reduced-motion → no-op, handled inside rippleOnce).
	await delay(800);
	actions.classList.add('fm-visible');
	rippleOnce(actions);

	// ── Wait for user ─────────────────────────────────────────────────────────

	await new Promise((resolve) => {
		function cleanup() {
			root.remove();
		}

		btnShare.addEventListener('click', () => {
			cleanup();
			onShare?.();
			resolve();
		});

		btnContinue.addEventListener('click', () => {
			cleanup();
			onContinue?.();
			runTour(agent).catch(log.error);
			resolve();
		});
	});
}

// ── Utility ───────────────────────────────────────────────────────────────────

function escHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
	}[c]));
}

// ── Coach-mark tour ───────────────────────────────────────────────────────────
// Powered by src/shared/tour.js — id-namespaced, server-backed persistence.

async function runTour(agent) {
	const TOUR_ID = 'dashboard-first-meet';
	const outcome = await startTour([
		{
			target: '.dnx-hero-card',
			title: 'Your agent is live',
			body: 'Click "Live page" to preview, "Edit" to customize the look, or "Embed wizard" to deploy on any website.',
		},
		{
			target: '#dnx-onboarding, .dnx-ob',
			title: 'Your setup checklist',
			body: 'Complete these steps to unlock your agent\'s full potential — from personality to payments.',
		},
		{
			target: '.dnx-shortcuts-grid, .dnx-quick-card',
			title: 'Quick shortcuts',
			body: 'Shortcuts to your most-used tools. Pin any page from the directory below to customize this section.',
		},
	], {
		id: TOUR_ID,
		onComplete: () => showChecklist(agent),
	});
	if (outcome === 'skipped') showChecklist(agent);
}

// ── Next-steps checklist ──────────────────────────────────────────────────────

function showChecklist(agent) {
	const agentId = agent?.id;
	const shareUrl = agentId ? `${location.origin}/agents/${agentId}` : null;

	const ITEMS = [
		{
			id: 'avatar',
			label: 'Customize your avatar',
			sub: 'Edit look, style, and accessories.',
			href: '/dashboard/avatars',
		},
		{
			id: 'personality',
			label: 'Add personality',
			sub: 'Set system prompt and AI model.',
			href: '/brain',
		},
		{
			id: 'payments',
			label: 'Enable payments',
			sub: 'Charge per message or set a subscription.',
			href: '/dashboard/monetize',
			optional: true,
		},
		{
			id: 'share',
			label: 'Share your agent',
			sub: shareUrl ? shareUrl.replace(/^https?:\/\//, '') : 'Copy the live link.',
			shareUrl,
		},
	];

	function getStored() {
		try { return JSON.parse(localStorage.getItem('threews:checklist') || '{}'); } catch { return {}; }
	}
	function setStored(obj) {
		localStorage.setItem('threews:checklist', JSON.stringify(obj));
	}

	const panel = document.createElement('div');
	panel.className = 'fm-checklist-panel';
	panel.setAttribute('role', 'region');
	panel.setAttribute('aria-label', 'Next steps checklist');

	let paymentsOpen = false;

	function render() {
		const stored = getStored();
		panel.innerHTML = `
			<div class="fm-cl-head">
				<span class="fm-cl-title">Next steps</span>
				<button class="fm-cl-dismiss" type="button" aria-label="Dismiss checklist">×</button>
			</div>
			<ul class="fm-cl-list" role="list">
				${ITEMS.map((item) => {
					const done = !!stored[item.id];
					return `
						<li class="fm-cl-item${done ? ' is-done' : ''}${item.optional ? ' is-optional' : ''}" data-item="${item.id}">
							<span class="fm-cl-check" aria-hidden="true">${done
								? `<svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6.5l2.5 2.5L10 3"/></svg>`
								: ''}</span>
							<div class="fm-cl-content">
								${item.optional ? `
									<button class="fm-cl-toggle" type="button" aria-expanded="${paymentsOpen}">
										${escHtml(item.label)}&nbsp;<span class="fm-cl-opt-tag">optional</span>
										<svg class="fm-cl-chevron${paymentsOpen ? ' open' : ''}" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 3.5l3 3 3-3"/></svg>
									</button>
									<div class="fm-cl-collapse${paymentsOpen ? ' open' : ''}">
										<div class="fm-cl-sub">${escHtml(item.sub)}</div>
										<a class="fm-cl-cta" href="${item.href}" data-action="${item.id}">Set up payments →</a>
									</div>
								` : item.shareUrl ? `
									<span class="fm-cl-label">${escHtml(item.label)}</span>
									<div class="fm-cl-sub fm-cl-mono">${escHtml(item.sub)}</div>
									<button class="fm-cl-copy" type="button" data-action="share" data-url="${escHtml(item.shareUrl)}">Copy link</button>
								` : `
									<a class="fm-cl-label fm-cl-link" href="${item.href}" data-action="${item.id}">${escHtml(item.label)}</a>
									<div class="fm-cl-sub">${escHtml(item.sub)}</div>
								`}
							</div>
						</li>
					`;
				}).join('')}
			</ul>
		`;

		// Dismiss
		panel.querySelector('.fm-cl-dismiss').onclick = () => {
			panel.classList.remove('fm-cl-visible');
			setTimeout(() => panel.remove(), 300);
		};

		// Payments accordion toggle
		const toggle = panel.querySelector('.fm-cl-toggle');
		if (toggle) {
			toggle.onclick = () => {
				paymentsOpen = !paymentsOpen;
				render();
			};
		}

		// Action clicks — mark items done on click-through
		panel.querySelectorAll('[data-action]').forEach((el) => {
			el.addEventListener('click', (e) => {
				const action = el.dataset.action;
				const stored = getStored();

				if (action === 'share') {
					e.preventDefault();
					const url = el.dataset.url;
					if (url) {
						navigator.clipboard?.writeText(url).then(() => {
							el.textContent = 'Copied!';
							setTimeout(() => { el.textContent = 'Copy link'; }, 2000);
						}).catch(() => {
							// Fallback: select text
							el.textContent = url;
							const range = document.createRange();
							range.selectNodeContents(el);
							window.getSelection()?.removeAllRanges();
							window.getSelection()?.addRange(range);
						});
					}
					stored.share = true;
					setStored(stored);
					render();
					return;
				}

				// Mark clicked item done (optimistic)
				if (['avatar', 'personality', 'payments'].includes(action)) {
					stored[action] = true;
					setStored(stored);
				}
				// Let link navigate
			});
		});
	}

	render();
	document.body.appendChild(panel);

	// Animate in on next frame
	requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.add('fm-cl-visible')));
}
