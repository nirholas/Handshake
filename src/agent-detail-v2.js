/**
 * Agent detail — v2 shell behavior.
 *
 * Pure presentation glue for the redesigned layout; all data logic stays in
 * agent-detail.js (which this file never imports or touches). Owns:
 *
 *  - the "Classic layout" link (points at /agents/:id/classic)
 *  - scrollspy on the sticky section nav
 *  - auto-hiding section groups whose cards are all hidden (cards on this
 *    page reveal themselves as real data arrives, so groups follow suit)
 *  - dismissal behavior for the hero "More" actions menu
 */

const agentId =
	new URLSearchParams(location.search).get('id') ||
	location.pathname.match(/\/agents\/([^/]+)/)?.[1] ||
	null;

// ── Classic layout link ──────────────────────────────────────────────────

const classicLink = document.getElementById('adv2-classic-link');
if (classicLink && agentId) {
	classicLink.href = `/agents/${encodeURIComponent(agentId)}/classic`;
}

// ── Section groups: hide the ones with nothing to show ──────────────────
// Every card on this page either always renders or reveals itself when its
// data arrives (hidden attr / display:none until then). A group whose cards
// are ALL hidden is pure chrome — hide it and its nav tab, and re-check on
// every visibility mutation so groups appear the moment content does.

const groups = Array.from(document.querySelectorAll('.adv2-group'));
const tabs = new Map(
	Array.from(document.querySelectorAll('.adv2-tab')).map((t) => [t.dataset.tab, t]),
);

function cardVisible(el) {
	if (el.hidden) return false;
	// Cards toggled via inline style (display:none) rather than [hidden].
	return getComputedStyle(el).display !== 'none';
}

function refreshGroups() {
	for (const group of groups) {
		const cards = group.querySelectorAll('.adv2-grid > *');
		const hasContent = Array.from(cards).some(cardVisible);
		group.classList.toggle('is-empty', !hasContent);
		tabs.get(group.id)?.classList.toggle('is-hidden', !hasContent);
	}
}

refreshGroups();
const visibilityObserver = new MutationObserver(() => {
	// Mutations arrive in bursts while the page hydrates; coalesce per frame.
	if (visibilityObserver._raf) return;
	visibilityObserver._raf = requestAnimationFrame(() => {
		visibilityObserver._raf = 0;
		refreshGroups();
	});
});
const body = document.querySelector('.adv2-body');
if (body) {
	visibilityObserver.observe(body, {
		attributes: true,
		attributeFilter: ['hidden', 'style', 'class'],
		subtree: true,
	});
}

// ── Scrollspy ────────────────────────────────────────────────────────────

let activeTab = null;
function setActiveTab(id) {
	if (activeTab === id) return;
	activeTab = id;
	for (const [tabId, tab] of tabs) tab.classList.toggle('is-active', tabId === id);
}

const spy = new IntersectionObserver(
	(entries) => {
		// Pick the visible group nearest the top of the reading zone.
		const visible = entries
			.filter((e) => e.isIntersecting)
			.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
		if (visible.length) setActiveTab(visible[0].target.id);
	},
	// Reading zone: below the two sticky bars, top half of the viewport.
	{ rootMargin: '-120px 0px -50% 0px' },
);
groups.forEach((g) => spy.observe(g));

// Smooth-scroll tab clicks (native anchor jump as fallback for reduced motion).
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
for (const tab of tabs.values()) {
	tab.addEventListener('click', (e) => {
		const target = document.getElementById(tab.dataset.tab);
		if (!target) return;
		e.preventDefault();
		history.replaceState(null, '', `#${tab.dataset.tab}`);
		setActiveTab(tab.dataset.tab);
		target.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth' });
	});
}

// ── "More" actions menu ──────────────────────────────────────────────────
// Native <details> popover: add light-dismiss (outside click / Escape) and
// close it after choosing an item so it behaves like a real menu.

const more = document.querySelector('.adv2-more');
if (more) {
	document.addEventListener('click', (e) => {
		if (more.open && !more.contains(e.target)) more.open = false;
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && more.open) {
			more.open = false;
			more.querySelector('summary')?.focus();
		}
	});
	more.querySelectorAll('.adv2-more-item').forEach((item) => {
		item.addEventListener('click', () => {
			more.open = false;
		});
	});
}
