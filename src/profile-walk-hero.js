// Profile walking-avatar hero — the live, embodied header for a user profile.
//
// Renders the profile owner's primary avatar as a live walking body inside an
// iframe pointed at /walk-embed (the chrome-less embed runtime in
// src/walk-embed.js). The embed autoplays a slow idle wander; the joystick lets
// a visitor take the controls right in the hero. Two CTAs sit beside it:
//
//   • "Say hi"      → opens the owner's REAL chat surface. We never invent an
//                     endpoint: the avatar page (/avatars/:id?view=chat) hosts a
//                     live LLM chat tab, and the agent detail page (/agents/:id)
//                     hosts the live "try it" chat preview. We prefer the avatar
//                     chat (it's the thing rendered in the hero), then fall back
//                     to the agent chat.
//   • "Walk with me"→ opens the full walk experience at /walk/app for the same
//                     body, carrying ?handle so the destination can place the
//                     visitor alongside the owner.
//
// Every state is designed: a loading skeleton until the embed posts walk:ready,
// an error state if it reports a failed avatar load, and a no-avatar empty state
// with a real affordance (create an avatar / view agents) when the owner has no
// embodied body to render. Honors prefers-reduced-motion by not autoplaying the
// wander, and is keyboard- and screen-reader-accessible throughout.

const esc = (s) =>
	String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
const attr = (s) =>
	String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);

let stylesInjected = false;

function injectStyles() {
	if (stylesInjected) return;
	stylesInjected = true;
	const style = document.createElement('style');
	style.id = 'profile-walk-hero-css';
	style.textContent = `
		.pwh {
			--pwh-accent: var(--accent, #ffd700);
			position: relative;
			display: grid;
			grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
			gap: 1.5rem;
			align-items: stretch;
			margin: 0 0 2rem;
			border: 1px solid rgba(255, 255, 255, 0.07);
			border-radius: 18px;
			overflow: hidden;
			background:
				radial-gradient(ellipse at 20% 0%, color-mix(in srgb, var(--pwh-accent) 9%, transparent) 0%, transparent 60%),
				rgba(255, 255, 255, 0.015);
		}

		.pwh-stage {
			position: relative;
			min-height: 380px;
			border-right: 1px solid rgba(255, 255, 255, 0.05);
			background:
				radial-gradient(ellipse at 50% 120%, color-mix(in srgb, var(--pwh-accent) 14%, transparent) 0%, transparent 55%),
				linear-gradient(180deg, rgba(255, 255, 255, 0.02) 0%, transparent 100%);
			overflow: hidden;
		}

		.pwh-frame {
			position: absolute;
			inset: 0;
			width: 100%;
			height: 100%;
			border: 0;
			opacity: 0;
			transition: opacity 0.5s ease;
		}
		.pwh-frame.is-ready { opacity: 1; }

		/* Loading skeleton — a shimmer plinth + a pulsing body silhouette. */
		.pwh-skeleton {
			position: absolute;
			inset: 0;
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: flex-end;
			padding-bottom: 18%;
			gap: 1rem;
			z-index: 2;
		}
		.pwh-skeleton[hidden] { display: none; }
		.pwh-skel-body {
			width: 64px;
			height: 150px;
			border-radius: 32px 32px 18px 18px;
			background: linear-gradient(
				180deg,
				rgba(255, 255, 255, 0.07) 0%,
				rgba(255, 255, 255, 0.03) 100%
			);
			animation: pwh-pulse 1.6s ease-in-out infinite;
		}
		.pwh-skel-disc {
			width: 180px;
			height: 26px;
			border-radius: 50%;
			background: radial-gradient(ellipse at center, rgba(255, 255, 255, 0.06), transparent 70%);
		}
		.pwh-skel-label {
			font-size: 0.7rem;
			letter-spacing: 0.04em;
			color: rgba(255, 255, 255, 0.35);
		}
		@keyframes pwh-pulse {
			0%, 100% { opacity: 0.5; transform: translateY(0); }
			50% { opacity: 0.85; transform: translateY(-4px); }
		}

		/* Empty (no embodied avatar) + error states share the centered layout. */
		.pwh-state {
			position: absolute;
			inset: 0;
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			text-align: center;
			gap: 0.75rem;
			padding: 2rem;
			z-index: 3;
		}
		.pwh-state[hidden] { display: none; }
		.pwh-state-glyph {
			font-size: 2.6rem;
			color: color-mix(in srgb, var(--pwh-accent) 45%, transparent);
			line-height: 1;
		}
		.pwh-state-title {
			font-size: 1rem;
			font-weight: 500;
			color: rgba(255, 255, 255, 0.85);
			margin: 0;
		}
		.pwh-state-text {
			font-size: 0.8rem;
			color: rgba(255, 255, 255, 0.45);
			margin: 0;
			max-width: 30ch;
			line-height: 1.55;
		}
		.pwh-state-cta {
			display: inline-flex;
			align-items: center;
			gap: 0.4rem;
			margin-top: 0.4rem;
			font-size: 0.8rem;
			font-weight: 500;
			padding: 0.5rem 1rem;
			border-radius: 999px;
			border: 1px solid color-mix(in srgb, var(--pwh-accent) 35%, transparent);
			color: color-mix(in srgb, var(--pwh-accent) 90%, white 10%);
			text-decoration: none;
			transition: border-color 0.15s ease, background 0.15s ease;
		}
		.pwh-state-cta:hover {
			border-color: color-mix(in srgb, var(--pwh-accent) 60%, transparent);
			background: color-mix(in srgb, var(--pwh-accent) 10%, transparent);
		}
		.pwh-state-cta:focus-visible {
			outline: 2px solid var(--pwh-accent);
			outline-offset: 2px;
		}

		/* Live pill — sits over the stage once the body is walking. */
		.pwh-live {
			position: absolute;
			top: 0.75rem;
			left: 0.75rem;
			z-index: 4;
			display: inline-flex;
			align-items: center;
			gap: 0.4rem;
			font-size: 0.6rem;
			text-transform: uppercase;
			letter-spacing: 0.12em;
			color: rgba(255, 255, 255, 0.7);
			background: rgba(0, 0, 0, 0.4);
			border: 1px solid rgba(255, 255, 255, 0.1);
			padding: 0.25rem 0.6rem;
			border-radius: 999px;
			backdrop-filter: blur(8px);
			opacity: 0;
			transition: opacity 0.4s ease;
			pointer-events: none;
		}
		.pwh-live.is-ready { opacity: 1; }
		.pwh-live-dot {
			width: 6px;
			height: 6px;
			border-radius: 50%;
			background: #4ade80;
			box-shadow: 0 0 6px rgba(74, 222, 128, 0.9);
			animation: pwh-blink 2s ease-in-out infinite;
		}
		@keyframes pwh-blink {
			0%, 100% { opacity: 1; }
			50% { opacity: 0.35; }
		}

		/* Side panel — title + CTAs. */
		.pwh-side {
			display: flex;
			flex-direction: column;
			justify-content: center;
			gap: 0.75rem;
			padding: 1.75rem 1.75rem 1.75rem 0.5rem;
		}
		.pwh-eyebrow {
			font-size: 0.6rem;
			text-transform: uppercase;
			letter-spacing: 0.16em;
			color: color-mix(in srgb, var(--pwh-accent) 75%, transparent);
			margin: 0;
		}
		.pwh-title {
			font-size: 1.35rem;
			font-weight: 300;
			letter-spacing: -0.02em;
			color: #f5f5f5;
			margin: 0;
			line-height: 1.2;
		}
		.pwh-sub {
			font-size: 0.82rem;
			color: rgba(255, 255, 255, 0.45);
			margin: 0;
			line-height: 1.55;
		}
		.pwh-actions {
			display: flex;
			flex-wrap: wrap;
			gap: 0.5rem;
			margin-top: 0.4rem;
		}
		.pwh-btn {
			display: inline-flex;
			align-items: center;
			gap: 0.45rem;
			font-family: inherit;
			font-size: 0.85rem;
			font-weight: 500;
			padding: 0.55rem 1.15rem;
			border-radius: 999px;
			cursor: pointer;
			text-decoration: none;
			border: 1px solid rgba(255, 255, 255, 0.18);
			background: transparent;
			color: rgba(255, 255, 255, 0.9);
			transition: background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease, transform 0.1s ease;
		}
		.pwh-btn:hover { border-color: rgba(255, 255, 255, 0.4); }
		.pwh-btn:active { transform: translateY(1px); }
		.pwh-btn:focus-visible {
			outline: 2px solid var(--pwh-accent);
			outline-offset: 2px;
		}
		.pwh-btn--primary {
			background: var(--pwh-accent);
			color: #111;
			border-color: var(--pwh-accent);
		}
		.pwh-btn--primary:hover { opacity: 0.88; }
		.pwh-btn svg { width: 15px; height: 15px; }

		@media (max-width: 860px) {
			.pwh {
				grid-template-columns: 1fr;
			}
			.pwh-stage {
				border-right: 0;
				border-bottom: 1px solid rgba(255, 255, 255, 0.05);
				min-height: 340px;
			}
			.pwh-side {
				padding: 1.5rem;
				text-align: center;
				align-items: center;
			}
			.pwh-actions { justify-content: center; }
		}

		@media (max-width: 360px) {
			.pwh-stage { min-height: 300px; }
			.pwh-actions { width: 100%; }
			.pwh-btn { flex: 1 1 auto; justify-content: center; }
		}

		@media (prefers-reduced-motion: reduce) {
			.pwh-frame { transition: none; }
			.pwh-skel-body { animation: none; }
			.pwh-live-dot { animation: none; }
		}
	`;
	document.head.appendChild(style);
}

const prefersReducedMotion = () =>
	typeof window.matchMedia === 'function' &&
	window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Resolve the body to embody. Prefer a real avatar GLB (the owner's primary),
// then an agent (its resolved avatar), so the hero always shows the most
// representative body the owner actually has.
function resolveEmbodiment({ avatars = [], agents = [] }) {
	const avatar = avatars.find((a) => a.model_url) || avatars.find((a) => a.id) || null;
	const agent = agents.find((a) => a.id) || null;
	if (avatar) return { kind: 'avatar', id: avatar.id, name: avatar.name };
	if (agent) return { kind: 'agent', id: agent.id, name: agent.name };
	return null;
}

// The REAL chat surface for this owner. Avatars carry a live LLM chat tab at
// /avatars/:id?view=chat; agents carry the live chat preview at /agents/:id.
function chatHref(embodiment) {
	if (embodiment.kind === 'avatar')
		return `/avatars/${encodeURIComponent(embodiment.id)}?view=chat`;
	return `/agents/${encodeURIComponent(embodiment.id)}#chat`;
}

// The full walk experience for this same body. /walk/app accepts ?avatar= or
// ?agent=; ?handle carries the owner so the destination can co-locate visitors.
function walkHref(embodiment, handle) {
	const key = embodiment.kind === 'avatar' ? 'avatar' : 'agent';
	const params = new URLSearchParams({ [key]: embodiment.id });
	if (handle) params.set('handle', handle);
	return `/walk/app?${params.toString()}`;
}

// Build the chrome-less embed URL for the hero stage. controls=joystick lets a
// visitor drive; autoplay wanders idly — disabled under reduced-motion so the
// body simply stands rather than pacing on its own.
function embedSrc(embodiment) {
	const key = embodiment.kind === 'avatar' ? 'avatar' : 'agent';
	const params = new URLSearchParams({
		[key]: embodiment.id,
		controls: 'joystick',
		env: 'studio',
		ground: 'true',
	});
	params.set('autoplay', prefersReducedMotion() ? 'false' : 'true');
	return `/walk-embed?${params.toString()}`;
}

const ICON_CHAT =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const ICON_WALK =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="13" cy="4" r="2"/><path d="m9 21 2-5 2 2 1 4"/><path d="m5 13 3-3 3 1 2 3"/><path d="M15 11l3 1 1 3"/></svg>';

// Render the no-avatar empty state. Owners get a "create an avatar" affordance;
// visitors get a softer "no body yet" with a link to the owner's agents tab.
function emptyStateHtml({ isOwner, displayName }) {
	if (isOwner) {
		return `
			<div class="pwh-state-glyph" aria-hidden="true">◎</div>
			<p class="pwh-state-title">Give yourself a body</p>
			<p class="pwh-state-text">Upload or generate an avatar to walk live on your profile and across three.ws.</p>
			<a class="pwh-state-cta" href="/create">Create an avatar →</a>`;
	}
	return `
		<div class="pwh-state-glyph" aria-hidden="true">◎</div>
		<p class="pwh-state-title">${esc(displayName)} has no walking body yet</p>
		<p class="pwh-state-text">When they add an avatar, it’ll walk live right here.</p>
		<a class="pwh-state-cta" href="/discover">Explore avatars →</a>`;
}

/**
 * Mount the walking-avatar hero.
 *
 * @param {HTMLElement} mountEl   container the hero replaces its contents into
 * @param {object}      ctx
 * @param {object}      ctx.user        the profile owner (display_name, username)
 * @param {Array}       ctx.avatars     owner's public avatars
 * @param {Array}       ctx.agents      owner's public agents
 * @param {boolean}     ctx.isOwner     viewer owns this profile
 * @param {string}      [ctx.accent]    accent color token for the gradient
 */
export function mountProfileWalkHero(mountEl, ctx) {
	if (!mountEl) return;
	injectStyles();

	const { user, avatars = [], agents = [], isOwner = false, accent } = ctx;
	const displayName = user?.display_name || user?.username || 'This builder';
	const handle = user?.username || '';
	const embodiment = resolveEmbodiment({ avatars, agents });

	const hero = document.createElement('section');
	hero.className = 'pwh';
	hero.setAttribute('aria-label', `${displayName}'s live avatar`);
	if (accent) hero.style.setProperty('--pwh-accent', accent);

	// No embodied body → render the empty state and a single "browse" affordance
	// in the side panel; no iframe, no CTAs that would dead-end.
	if (!embodiment) {
		hero.innerHTML = `
			<div class="pwh-stage">
				<div class="pwh-state">${emptyStateHtml({ isOwner, displayName })}</div>
			</div>
			<div class="pwh-side">
				<p class="pwh-eyebrow">Live avatar</p>
				<h2 class="pwh-title">Nobody’s home… yet</h2>
				<p class="pwh-sub">${
					isOwner
						? 'Add an avatar and it will greet every visitor by walking around right here.'
						: `${esc(displayName)} hasn’t added a walking avatar to their profile.`
				}</p>
			</div>`;
		mountEl.replaceChildren(hero);
		return;
	}

	const chat = chatHref(embodiment);
	const walk = walkHref(embodiment, handle);
	const src = embedSrc(embodiment);
	const bodyName = embodiment.name ? esc(embodiment.name) : esc(displayName);

	hero.innerHTML = `
		<div class="pwh-stage">
			<span class="pwh-live" aria-hidden="true"><span class="pwh-live-dot"></span>Live</span>
			<div class="pwh-skeleton" aria-hidden="true">
				<div class="pwh-skel-body"></div>
				<div class="pwh-skel-disc"></div>
				<div class="pwh-skel-label">Waking up ${bodyName}…</div>
			</div>
			<div class="pwh-state" hidden role="alert">
				<div class="pwh-state-glyph" aria-hidden="true">⚠</div>
				<p class="pwh-state-title">Couldn’t load the avatar</p>
				<p class="pwh-state-text">The 3D body failed to load. You can still chat or open the full walk.</p>
				<a class="pwh-state-cta" href="${attr(walk)}">Open full walk →</a>
			</div>
			<iframe
				class="pwh-frame"
				title="${attr(displayName)}’s avatar walking live — drag to look around, use the joystick to move"
				loading="lazy"
				allow="accelerometer; gyroscope"
				referrerpolicy="no-referrer-when-downgrade"
			></iframe>
		</div>
		<div class="pwh-side">
			<p class="pwh-eyebrow">Live avatar</p>
			<h2 class="pwh-title">Meet ${esc(displayName)}</h2>
			<p class="pwh-sub">${bodyName} is walking live. Drive it with the joystick, say hi, or step into the world together.</p>
			<div class="pwh-actions">
				<a class="pwh-btn pwh-btn--primary" href="${attr(chat)}">${ICON_CHAT}Say hi</a>
				<a class="pwh-btn" href="${attr(walk)}">${ICON_WALK}Walk with me</a>
			</div>
		</div>`;

	mountEl.replaceChildren(hero);

	const frame = hero.querySelector('.pwh-frame');
	const skeleton = hero.querySelector('.pwh-skeleton');
	const livePill = hero.querySelector('.pwh-live');
	const errorState = hero.querySelector('.pwh-state');

	let settled = false;
	let watchdog = 0;
	const teardown = () => {
		clearTimeout(watchdog);
		window.removeEventListener('message', onMessage);
	};
	const showError = () => {
		if (settled) return;
		settled = true;
		teardown();
		skeleton.hidden = true;
		frame.classList.remove('is-ready');
		errorState.hidden = false;
	};
	const showReady = () => {
		if (settled) return;
		settled = true;
		teardown();
		skeleton.hidden = true;
		frame.classList.add('is-ready');
		livePill.classList.add('is-ready');
	};

	// The embed posts walk:ready when the body is loaded and walk:error if the
	// avatar fails. We listen for both; a watchdog covers a silent failure so the
	// skeleton never spins forever.
	function onMessage(e) {
		if (e.source !== frame.contentWindow) return;
		const type = e.data?.type;
		if (type === 'walk:ready') showReady();
		else if (type === 'walk:error') showError();
	}
	window.addEventListener('message', onMessage);

	// If the iframe loaded but never handshook, assume it's up rather than
	// stranding the visitor on the skeleton — the embed always renders a body.
	watchdog = setTimeout(showReady, 12000);

	frame.addEventListener('error', showError, { once: true });
	frame.src = src;
}
