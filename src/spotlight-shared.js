/**
 * Rendering pieces shared by /spotlight and /spotlight/:id.
 *
 * Both surfaces draw the same entry: the same 3D stage, the same upvote button
 * with the same optimistic-free settle, the same monogram fallback for an agent
 * with no public avatar. Keeping them here means a card and a detail page can
 * never disagree about what an entry looks like or what a vote does.
 */

import { apiFetch } from './api.js';

const AGENT_3D_LOADER = 'https://three.ws/agent-3d/latest/agent-3d.js';

export function el(tag, props = {}, children = []) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v == null || v === false) continue;
		if (k === 'class') node.className = v;
		else if (k === 'text') node.textContent = v;
		else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
		else node.setAttribute(k, v === true ? '' : String(v));
	}
	for (const child of [].concat(children)) {
		if (child != null) node.append(child);
	}
	return node;
}

// The API answers errors as { error, error_description } (api/_lib/http.js).
// Reading `error.message` instead, which is the shape most JSON APIs use, threw
// away every server-side validation message and replaced it with a bare status
// code, so a builder was told "the submission returned 400" instead of "the
// headline needs at least 3 characters". One reader, used everywhere.
export function errorMessage(payload, fallback) {
	return payload?.error_description || payload?.error?.message || fallback;
}

export function entryPath(entry) {
	return `/spotlight/${entry.id}`;
}

export function relativeTime(iso) {
	const then = new Date(iso).getTime();
	if (!Number.isFinite(then)) return '';
	const mins = Math.round((Date.now() - then) / 60000);
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days}d ago`;
	return new Date(then).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

// Deterministic hue from the agent id: the same agent keeps the same monogram
// colour on every card, in every session, without storing anything.
function hueOf(id) {
	let h = 0;
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
	return h;
}

export function monogram(agent) {
	const hue = hueOf(agent.id || agent.name || 'agent');
	const initials = (agent.name || '?')
		.split(/\s+/)
		.slice(0, 2)
		.map((w) => w[0])
		.join('')
		.toUpperCase();
	const node = el('div', { class: 'sp-mono', 'aria-hidden': 'true', text: initials });
	node.style.background = `linear-gradient(140deg, hsl(${hue} 62% 26%), hsl(${(hue + 48) % 360} 55% 14%))`;
	return node;
}

let agent3dRequested = false;
function loadAgent3d() {
	if (agent3dRequested) return;
	agent3dRequested = true;
	const s = document.createElement('script');
	s.type = 'module';
	s.src = AGENT_3D_LOADER;
	document.head.appendChild(s);
}

// Hide the still only once <agent-3d> has painted a canvas of its own. There is
// no documented ready event on the component, and a canvas in the DOM is the one
// signal that means the model is genuinely on screen. Give up after a bounded
// wait and leave the still in place, which is the correct outcome when the GLB
// never arrives.
function revealWhenPainted(viewer, still) {
	let settled = false;
	const painted = () =>
		Boolean(viewer.querySelector('canvas') || viewer.shadowRoot?.querySelector('canvas'));
	const done = () => {
		if (settled) return;
		settled = true;
		observer.disconnect();
		clearTimeout(timer);
		still.classList.add('is-hidden');
	};
	const observer = new MutationObserver(() => {
		if (painted()) done();
	});
	observer.observe(viewer, { childList: true, subtree: true });
	const timer = setTimeout(() => observer.disconnect(), 15000);
	if (painted()) done();
}

/**
 * The 3D stage. `eager: true` mounts the viewer immediately (the detail page,
 * where the stage IS the page); the default waits for the stage to scroll into
 * view, because below-the-fold WebGL on a browse page costs a visitor real
 * frames for something they may never reach.
 */
export function stageFor(entry, { badge = null, eager = false } = {}) {
	const stage = el('div', { class: 'sp-stage' });
	if (badge) stage.append(el('span', { class: 'sp-stage-badge', text: badge }));

	// The still goes in first and stays until the 3D viewer has actually painted.
	// A GLB can fail for reasons this page does not control (a cold CDN, a blocked
	// origin, no WebGL on the device), and a silently empty hero is the worst
	// version of that failure.
	const still = entry.agent.thumbnail
		? el('img', {
				class: 'sp-stage-still',
				src: entry.agent.thumbnail,
				alt: `${entry.agent.name} avatar`,
				loading: eager ? 'eager' : 'lazy',
				decoding: 'async',
			})
		: monogram(entry.agent);
	stage.append(still);

	if (!entry.agent.glb_url) return stage;

	const mount = () => {
		loadAgent3d();
		const viewer = el('agent-3d', {
			body: entry.agent.glb_url,
			autorotate: 'true',
			'camera-controls': 'true',
			'aria-label': `${entry.agent.name} in 3D`,
		});
		stage.append(viewer);
		revealWhenPainted(viewer, still);
	};

	if (eager || !('IntersectionObserver' in window)) {
		mount();
	} else {
		const io = new IntersectionObserver(
			(entries, obs) => {
				if (entries.some((e) => e.isIntersecting)) {
					obs.disconnect();
					mount();
				}
			},
			{ rootMargin: '200px' },
		);
		io.observe(stage);
	}
	return stage;
}

/**
 * The upvote toggle. Never optimistic: the count and pressed state settle on
 * what the server returns, so two tabs, a double click and a lost request all
 * converge on the same truth instead of drifting apart.
 *
 * `onVoted` is called with the mutated entry after a successful toggle, which is
 * how the page's headline totals stay in step without a refetch.
 */
export function voteButton(entry, { announce = () => {}, onVoted = () => {}, large = false } = {}) {
	const count = el('span', { class: 'sp-vote-count', text: String(entry.vote_count) });
	const btn = el(
		'button',
		{
			type: 'button',
			class: large ? 'sp-vote sp-vote-lg' : 'sp-vote',
			'aria-pressed': String(Boolean(entry.voted_by_me)),
			'aria-label': `Upvote ${entry.title}`,
			title: 'Upvote',
		},
		[el('span', { class: 'sp-vote-caret', 'aria-hidden': 'true', text: '▲' }), count],
	);

	btn.addEventListener('click', async (event) => {
		event.preventDefault();
		event.stopPropagation();
		btn.classList.add('is-busy');
		try {
			const res = await apiFetch('/api/spotlight/vote', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id: entry.id }),
				allowAnonymous: true,
			});
			if (res.status === 401) {
				location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
				return;
			}
			const data = await res.json().catch(() => null);
			if (!res.ok) {
				announce(errorMessage(data, 'the vote did not go through'));
				return;
			}
			entry.vote_count = data.vote_count;
			entry.voted_by_me = data.voted;
			count.textContent = String(data.vote_count);
			btn.setAttribute('aria-pressed', String(data.voted));
			announce(
				`${data.voted ? 'Upvoted' : 'Removed your upvote from'} ${entry.title}. ${data.vote_count} total.`,
			);
			onVoted(entry);
		} catch {
			announce('the vote did not go through; check your connection');
		} finally {
			btn.classList.remove('is-busy');
		}
	});

	return btn;
}
