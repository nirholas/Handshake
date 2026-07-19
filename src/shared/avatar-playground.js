/**
 * Avatar playground — a "things to try" chip strip for any living avatar mount.
 *
 * Gesture chips fire real canonical clips on the rig (wave, dance, celebrate),
 * fx chips layer CSS spectacle on the DOM around the WebGL stage (accent pulse,
 * turntable boost) so the moment reads bigger than a clip alone, and accent
 * pills retheme the avatar's glow live. Every chip degrades per rig: a skeleton
 * that can't accept a clip skips to the next candidate, and a rig with no
 * canonical-clip support hides the strip entirely rather than showing dead
 * buttons.
 *
 * Interaction pattern adopted from bowyer.app, whose agent pages pioneered
 * this playground UI on top of three.ws avatars. Credit renders in the strip.
 *
 * Usage:
 *   import { mountAvatarPlayground } from './shared/avatar-playground.js';
 *   const pg = mountAvatarPlayground({ container, handle, fxHost, glowEl });
 *   pg?.dispose();
 */

const STYLE_ID = 'tws-avatar-playground-styles';

/** Semantic actions, most-preferred clip first — degrade across the library per rig. */
const GESTURES = [
	{ id: 'wave', label: 'Wave', clips: ['wave'] },
	{ id: 'dance', label: 'Dance', clips: ['dance', 'av-dance-shuffle', 'av-rap-dance'] },
	{ id: 'celebrate', label: 'Celebrate', clips: ['celebrate', 'av-celebrating', 'av-cheering'] },
	{ id: 'flex', label: 'Flex', clips: ['av-arm-flex', 'av-flexing-arm'] },
	{ id: 'jump', label: 'Jump', clips: ['jump', 'av-superhero-jump'] },
];

const FX = [
	{ id: 'hype', label: 'Hype', clips: ['celebrate', 'av-celebrating', 'av-cheering'], durationMs: 1800 },
	{ id: 'turntable', label: 'Turntable', clips: ['dance', 'av-dance-shuffle'], durationMs: 3600 },
];

const ACCENTS = [
	{ label: 'Violet', value: '#a78bfa' },
	{ label: 'Green', value: '#34d399' },
	{ label: 'Amber', value: '#fbbf24' },
	{ label: 'Cyan', value: '#22d3ee' },
];

function ensurePlaygroundStyles() {
	if (typeof document === 'undefined') return;
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = PLAYGROUND_CSS;
	(document.head || document.documentElement).appendChild(style);
}

/**
 * Mount the playground strip.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.container  Element the strip renders into.
 * @param {{ ready: Promise<boolean>, playGesture(names: string[]): Promise<string|null>, viewer: any }} opts.handle
 *   Return value of mountIdleAvatar. Null-safe: pass null when the avatar fell
 *   back to a still image and no strip is mounted.
 * @param {HTMLElement} [opts.fxHost]  Element that receives fx classes and the
 *   accent CSS variable (typically the avatar wrap).
 * @param {HTMLElement} [opts.glowEl]  Radial glow element to retint with accents.
 * @param {Array<{ label: string, title?: string, onClick(btn: HTMLButtonElement): void }>} [opts.extras]
 *   Host-supplied chips (e.g. "Copy avatar prompt") that don't depend on the
 *   rig. When present the strip renders even for rigs with no gesture support.
 * @returns {{ dispose(): void } | null}
 */
export function mountAvatarPlayground({ container, handle, fxHost = null, glowEl = null, extras = [] } = {}) {
	if (!container || !handle) return null;
	ensurePlaygroundStyles();

	const reducedMotion =
		typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	let disposed = false;
	const timers = new Set();
	const later = (fn, ms) => {
		const t = setTimeout(() => {
			timers.delete(t);
			fn();
		}, ms);
		timers.add(t);
	};

	const strip = document.createElement('div');
	strip.className = 'apg';
	strip.hidden = true;
	strip.setAttribute('role', 'group');
	strip.setAttribute('aria-label', 'Avatar playground');

	const glowOriginal = glowEl ? glowEl.style.background : '';

	const chipBtn = (label, extraClass = '') => {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = `apg-chip ${extraClass}`.trim();
		b.textContent = label;
		b.disabled = true;
		return b;
	};

	const label = document.createElement('span');
	label.className = 'apg-label';
	label.textContent = 'Try:';
	strip.appendChild(label);

	// A single in-flight gesture at a time — chips glow while their clip plays
	// and re-arm when it settles, so mashing buttons can't queue a backlog.
	let busy = false;
	const gestureButtons = [];
	const runGesture = async (btn, clips) => {
		if (busy || disposed) return;
		busy = true;
		btn.classList.add('apg-chip--live');
		try {
			const played = await handle.playGesture(clips);
			if (!disposed && !played) {
				// No candidate could play on this rig — retire the chip honestly
				// instead of leaving a button that silently does nothing.
				btn.disabled = true;
				btn.title = 'Not available on this rig';
			}
		} finally {
			busy = false;
			if (!disposed) later(() => btn.classList.remove('apg-chip--live'), 900);
		}
	};

	for (const g of GESTURES) {
		const btn = chipBtn(g.label);
		btn.addEventListener('click', () => runGesture(btn, g.clips));
		gestureButtons.push(btn);
		strip.appendChild(btn);
	}

	// ── FX chips: CSS spectacle layered around the WebGL stage ────────────────
	const fxButtons = [];
	if (fxHost) {
		for (const fx of FX) {
			const btn = chipBtn(fx.label, 'apg-chip--fx');
			btn.addEventListener('click', () => {
				if (disposed) return;
				runGesture(btn, fx.clips);
				if (reducedMotion) return;
				if (fx.id === 'hype') {
					fxHost.classList.remove('apg-fx-hype');
					// Force a reflow so re-clicking restarts the pulse animation.
					void fxHost.offsetWidth;
					fxHost.classList.add('apg-fx-hype');
					later(() => fxHost.classList.remove('apg-fx-hype'), fx.durationMs);
				} else if (fx.id === 'turntable') {
					const controls = handle.viewer?.controls;
					if (!controls) return;
					const prevSpeed = controls.autoRotateSpeed;
					const prevOn = handle.viewer.state.autoRotate;
					controls.autoRotateSpeed = 14;
					handle.setAutoRotate(true);
					later(() => {
						controls.autoRotateSpeed = prevSpeed;
						handle.setAutoRotate(prevOn);
					}, fx.durationMs);
				}
			});
			fxButtons.push(btn);
			strip.appendChild(btn);
		}
	}

	// ── Accent pills: live retheme of the glow + fx color ─────────────────────
	if (fxHost || glowEl) {
		const pills = document.createElement('span');
		pills.className = 'apg-accents';
		pills.setAttribute('role', 'group');
		pills.setAttribute('aria-label', 'Accent color');
		let active = null;
		for (const a of ACCENTS) {
			const pill = document.createElement('button');
			pill.type = 'button';
			pill.className = 'apg-accent';
			pill.style.setProperty('--apg-pill', a.value);
			pill.setAttribute('aria-label', `${a.label} accent`);
			pill.title = a.label;
			pill.addEventListener('click', () => {
				if (disposed) return;
				const clearing = active === pill;
				pills.querySelectorAll('.apg-accent--on').forEach((p) => p.classList.remove('apg-accent--on'));
				if (clearing) {
					active = null;
					fxHost?.style.removeProperty('--apg-accent');
					if (glowEl) glowEl.style.background = glowOriginal;
					return;
				}
				active = pill;
				pill.classList.add('apg-accent--on');
				fxHost?.style.setProperty('--apg-accent', a.value);
				if (glowEl) {
					glowEl.style.background = `radial-gradient(ellipse 60% 55% at 50% 40%, ${a.value}2e 0%, transparent 70%)`;
				}
			});
			pills.appendChild(pill);
		}
		strip.appendChild(pills);
	}

	// Host-supplied chips — rig-independent, live immediately.
	for (const extra of extras) {
		const btn = chipBtn(extra.label, 'apg-chip--extra');
		btn.disabled = false;
		if (extra.title) btn.title = extra.title;
		btn.addEventListener('click', () => extra.onClick(btn));
		strip.appendChild(btn);
	}

	// Credit where the interaction pattern came from — Bowyer built this
	// playground on top of three.ws avatars first, and credited us in kind.
	const credit = document.createElement('a');
	credit.className = 'apg-credit';
	credit.href = 'https://bowyer.app';
	credit.target = '_blank';
	credit.rel = 'noopener noreferrer';
	credit.textContent = 'pattern: bowyer.app';
	credit.title = 'Playground interaction pattern pioneered by Bowyer, who build with three.ws avatars';
	strip.appendChild(credit);

	container.appendChild(strip);

	// Reveal only for rigs that can actually gesture — a prop or own-clip model
	// keeps the clean hero with no dead chrome. Host extras (rig-independent)
	// still earn the strip; the gesture chips just never appear.
	handle.ready.then((supports) => {
		if (disposed) return;
		if (supports) {
			for (const b of [...gestureButtons, ...fxButtons]) b.disabled = false;
		} else if (extras.length) {
			for (const b of [...gestureButtons, ...fxButtons]) b.remove();
		} else {
			return;
		}
		strip.hidden = false;
		requestAnimationFrame(() => strip.classList.add('apg--in'));
	});

	return {
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const t of timers) clearTimeout(t);
			timers.clear();
			fxHost?.classList.remove('apg-fx-hype');
			fxHost?.style.removeProperty('--apg-accent');
			if (glowEl) glowEl.style.background = glowOriginal;
			strip.remove();
		},
	};
}

const PLAYGROUND_CSS = `
.apg {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
	opacity: 0;
	transform: translateY(4px);
	transition: opacity 0.35s ease, transform 0.35s ease;
}
.apg--in { opacity: 1; transform: none; }
.apg-label {
	font-size: 11px;
	letter-spacing: 0.08em;
	text-transform: uppercase;
	color: var(--ad-muted, #8b8b9e);
}
.apg-chip {
	appearance: none;
	border: 1px solid var(--ad-line, rgba(255, 255, 255, 0.1));
	background: rgba(255, 255, 255, 0.03);
	color: var(--ad-muted, #a1a1b5);
	border-radius: 999px;
	padding: 5px 12px;
	font: inherit;
	font-size: 12px;
	line-height: 1.2;
	cursor: pointer;
	transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease, transform 0.15s ease;
}
.apg-chip:hover:not(:disabled) {
	color: var(--ad-text, #ececf1);
	border-color: rgba(255, 255, 255, 0.22);
	background: rgba(255, 255, 255, 0.06);
}
.apg-chip:active:not(:disabled) { transform: scale(0.96); }
.apg-chip:focus-visible {
	outline: 2px solid var(--apg-accent, var(--ad-violet, #a78bfa));
	outline-offset: 2px;
}
.apg-chip:disabled { opacity: 0.4; cursor: default; }
.apg-chip--live {
	color: var(--apg-accent, var(--ad-violet, #a78bfa));
	border-color: var(--apg-accent, var(--ad-violet, #a78bfa));
	background: color-mix(in srgb, var(--apg-accent, var(--ad-violet, #a78bfa)) 12%, transparent);
}
.apg-chip--fx { border-style: dashed; }
.apg-accents { display: inline-flex; gap: 6px; margin-left: 2px; }
.apg-accent {
	appearance: none;
	width: 18px;
	height: 18px;
	border-radius: 50%;
	border: 1px solid rgba(255, 255, 255, 0.25);
	background: var(--apg-pill);
	cursor: pointer;
	padding: 0;
	transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.apg-accent:hover { transform: scale(1.15); }
.apg-accent:focus-visible { outline: 2px solid var(--apg-pill); outline-offset: 2px; }
.apg-accent--on { box-shadow: 0 0 0 2px var(--ad-bg, #0b0b12), 0 0 0 4px var(--apg-pill); }
.apg-credit {
	margin-left: auto;
	font-size: 10.5px;
	letter-spacing: 0.04em;
	color: var(--ad-muted, #8b8b9e);
	opacity: 0.55;
	text-decoration: none;
	transition: opacity 0.15s ease;
}
.apg-credit:hover { opacity: 1; text-decoration: underline; }
.apg-fx-hype { position: relative; }
.apg-fx-hype::after {
	content: '';
	position: absolute;
	inset: -6%;
	border-radius: inherit;
	pointer-events: none;
	border: 2px solid var(--apg-accent, var(--ad-violet, #a78bfa));
	animation: apg-hype 0.9s ease-out 2;
}
@keyframes apg-hype {
	0% { opacity: 0.9; transform: scale(0.82); }
	100% { opacity: 0; transform: scale(1.12); }
}
@media (prefers-reduced-motion: reduce) {
	.apg { transition: none; }
	.apg-fx-hype::after { animation: none; display: none; }
}
`;
