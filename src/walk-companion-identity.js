// Companion identity — turns the corner avatar from an anonymous mascot into
// "your agent". Non-invasive add-on in the same style as walk-trails /
// click-to-walk: it observes the live walk-sdk instance (never edits the SDK)
// and slots a small identity chip into the companion's host chrome.
//
// What it does:
//   • Guests get an ephemeral agent on the spot — a named draft minted by
//     src/agents/guest-agent.js — with a "Claim →" CTA into /create-agent,
//     which prefills from the draft and POSTs the real agent on signup.
//   • Signed-in visitors get their canonical agent's name (active-agent.js).
//   • A one-time introduction bubble when the companion was auto-summoned.
//   • Reactions to command-palette work: the avatar waves and comments when a
//     ⌘K command (forge / digest / price / ask) completes.

import { ensureGuestAgent } from './agents/guest-agent.js';

const AUTH_HINT_KEY = '3dagent:auth-hint';
const INTRO_KEY = 'tws:companion:introduced';
const AUTO_KEY = 'walk:companion:auto';

function readJson(storage, key) {
	try {
		const raw = storage.getItem(key);
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

function isAuthed() {
	const hint = readJson(localStorage, AUTH_HINT_KEY);
	return !!(hint && hint.authed);
}

function ensureChipStyles() {
	const id = 'walk-companion-identity-style';
	if (document.getElementById(id)) return;
	const s = document.createElement('style');
	s.id = id;
	s.textContent = [
		'.walk-companion-id{position:absolute;bottom:4px;left:50%;transform:translateX(-50%);',
		'display:inline-flex;align-items:center;gap:6px;max-width:calc(100% - 8px);',
		'padding:3px 8px;border-radius:999px;background:rgba(12,14,20,.72);',
		'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);',
		'font:600 10.5px/1.2 "Inter",system-ui,sans-serif;color:#f2f2f2;',
		'letter-spacing:.01em;white-space:nowrap;pointer-events:auto;z-index:3;',
		'border:1px solid rgba(255,255,255,.14);transition:background .15s ease,border-color .15s ease;}',
		'.walk-companion-id:hover{background:rgba(12,14,20,.9);border-color:rgba(255,255,255,.28);}',
		'.walk-companion-id-name{overflow:hidden;text-overflow:ellipsis;}',
		'.walk-companion-id-claim{color:#8ab4ff;text-decoration:none;font-weight:700;}',
		'.walk-companion-id-claim:hover,.walk-companion-id-claim:focus-visible{color:#b7d1ff;text-decoration:underline;}',
		'.walk-companion-id-claim:focus-visible{outline:2px solid #7aa2ff;outline-offset:2px;border-radius:4px;}',
	].join('');
	document.head.appendChild(s);
}

async function resolveIdentity() {
	if (isAuthed()) {
		try {
			// Lazy import: keeps apiFetch/active-agent out of the guest path entirely.
			const mod = await import('./agents/active-agent.js');
			const agent = await mod.getActiveAgent();
			if (agent && agent.name) {
				return { name: agent.name, guest: false, href: agent.id ? `/agent/${agent.id}` : '/dashboard' };
			}
		} catch {
			/* fall through to the hint-name below */
		}
		const hint = readJson(localStorage, AUTH_HINT_KEY);
		return { name: hint?.name ? `${hint.name}’s agent` : 'Your agent', guest: false, href: '/dashboard' };
	}
	const draft = ensureGuestAgent();
	return { name: draft.name, guest: true, href: '/create-agent?from=companion' };
}

function buildChip(identity) {
	const chip = document.createElement('div');
	chip.className = 'walk-companion-id';
	chip.setAttribute('data-walk-block', '');
	const name = document.createElement(identity.guest ? 'span' : 'a');
	name.className = 'walk-companion-id-name';
	name.textContent = identity.name;
	if (!identity.guest) {
		name.href = identity.href;
		name.style.color = 'inherit';
		name.style.textDecoration = 'none';
		name.setAttribute('aria-label', `${identity.name} — open your agent`);
	}
	chip.appendChild(name);
	if (identity.guest) {
		const claim = document.createElement('a');
		claim.className = 'walk-companion-id-claim';
		claim.href = identity.href;
		claim.textContent = 'Claim →';
		claim.setAttribute(
			'aria-label',
			`Claim ${identity.name} — create your account and make this agent real`,
		);
		chip.appendChild(claim);
	}
	return chip;
}

function introduce(instance, identity) {
	let auto = false;
	try {
		auto = localStorage.getItem(AUTO_KEY) === '1' && !sessionStorage.getItem(INTRO_KEY);
	} catch {
		return;
	}
	if (!auto || !identity.guest) return;
	// Let the SDK's own arrival greeting finish before speaking.
	setTimeout(() => {
		if (!instance.mounted) return;
		try {
			sessionStorage.setItem(INTRO_KEY, '1');
			instance._say(`I’m ${identity.name} — your agent. Press ⌘K and put me to work.`);
		} catch {
			/* bubble is decorative — never fatal */
		}
	}, 6500);
}

// React to real work done through the command palette: a wave plus a short
// comment makes the agent feel like it did the job (it did — same session,
// same identity).
const REACTIONS = {
	forge: {
		start: () => 'On it — forging your model…',
		done: () => 'Done — your model is ready ✨',
		failed: () => 'That forge didn’t take — try again in a minute.',
	},
	digest: { done: (d) => `That’s the day in ${d.stories || 'a few'} stories.` },
	price: { done: () => null },
	ask: { done: () => null },
};

function installReactions(getInstance) {
	document.addEventListener('tws:palette-action', (e) => {
		const { action, phase } = e.detail || {};
		const instance = getInstance();
		if (!instance || !instance.mounted) return;
		const line = REACTIONS[action]?.[phase]?.(e.detail);
		try {
			if (phase === 'done') instance.controller?.playWave?.();
			if (line) instance._say(line);
		} catch {
			/* companion mid-swap — skip the flourish */
		}
	});
}

/**
 * Install the identity layer. Follows the live instance across avatar swaps
 * and playground round-trips by re-attaching whenever the host changes.
 * @param {{ getInstance: () => object|null }} opts
 */
export function installIdentity({ getInstance }) {
	ensureChipStyles();
	installReactions(getInstance);

	let chipHost = null;
	let identity = null;
	let resolving = false;
	let introduced = false;

	async function tick() {
		const instance = getInstance();
		const host = instance?.mounted ? instance.host : null;
		if (!host) {
			chipHost = null;
			return;
		}
		if (host === chipHost && host.querySelector('.walk-companion-id')) return;
		if (!identity && !resolving) {
			resolving = true;
			identity = await resolveIdentity().catch(() => null);
			resolving = false;
		}
		if (!identity) return;
		host.querySelector('.walk-companion-id')?.remove();
		host.appendChild(buildChip(identity));
		chipHost = host;
		if (!introduced) {
			introduced = true;
			introduce(instance, identity);
		}
	}

	tick();
	// Host changes are rare (mount, swap, detach) — a slow poll is cheaper and
	// more robust than wiring into SDK internals.
	setInterval(tick, 1200);

	// A sign-in in another tab upgrades the chip in this one.
	window.addEventListener('storage', (e) => {
		if (e.key === AUTH_HINT_KEY) {
			identity = null;
			chipHost = null;
		}
	});
}
