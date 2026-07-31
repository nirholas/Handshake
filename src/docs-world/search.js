// Docs World search: one keystroke from anywhere in the world to any page.
//
// Walking is the point of this surface, but hunting fourteen pavilions for a
// page you can already name is not. `/` or Ctrl/Cmd+K opens a palette over the
// scene that ranks all ~200 documented pages, and each result offers the two
// things a visitor actually wants:
//
//   Enter        read it now (and stand the avatar at its pavilion, so closing
//                the reader leaves you where the page lives)
//   Shift+Enter  walk me there (hand off to the wayfinder and let the world
//                route you, opening the page on arrival)
//
// Ranking is the shared uFuzzy scorer every other three.ws palette uses, so a
// typo ("marketpalce") still finds the page and the highlight ranges come back
// with the match instead of being re-found with a regex.

import { rank, highlight } from '../shared/fuzzy.js';

const RECENT_KEY = 'docs-world:recent';
const RECENT_MAX = 6;
const RESULT_LIMIT = 40;

function readRecent() {
	try {
		const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
		return Array.isArray(raw) ? raw.filter((s) => typeof s === 'string') : [];
	} catch {
		return [];
	}
}

/** Remember a page as recently opened. Newest first, deduped, capped. */
export function rememberRecent(path) {
	try {
		const next = [path, ...readRecent().filter((p) => p !== path)].slice(0, RECENT_MAX);
		localStorage.setItem(RECENT_KEY, JSON.stringify(next));
	} catch {
		/* private mode or a full quota: recents are a convenience, never a gate */
	}
}

/**
 * @param {object} opts
 * @param {Array<{title:string, links:Array}>} opts.sections nav.json sections
 * @param {(page: {path:string, label:string, sectionIndex:number}) => void} opts.onRead
 * @param {(page: {path:string, label:string, sectionIndex:number}) => void} opts.onWalk
 */
export function createSearch({ sections, onRead, onWalk }) {
	const root = document.getElementById('dw-search');
	const input = document.getElementById('dw-search-input');
	const list = document.getElementById('dw-search-results');
	const empty = document.getElementById('dw-search-empty');
	const closeBtn = document.getElementById('dw-search-close');

	// Flat page index: every nav link that resolves to a doc, tagged with the
	// pavilion that holds it so a result can both teleport and route.
	const pages = [];
	sections.forEach((s, sectionIndex) => {
		for (const link of s.links) {
			if (!link.path) continue;
			pages.push({
				path: link.path,
				label: link.label,
				section: s.title,
				sectionIndex,
			});
		}
	});

	const haystack = (p) => p.label + ' ' + p.section + ' ' + p.path;

	let results = [];
	let active = 0;
	let lastFocus = null;

	function defaultResults() {
		// Before a query there is nothing to rank, so show what the visitor has
		// actually opened before, then fill from the top of the manifest. Both are
		// real: no curated "popular pages" list to drift out of date.
		const recent = readRecent()
			.map((path) => pages.find((p) => p.path === path))
			.filter(Boolean);
		const seen = new Set(recent.map((p) => p.path));
		const filler = pages.filter((p) => !seen.has(p.path)).slice(0, 8 - recent.length);
		return [...recent, ...filler].map((item) => ({ item, ranges: [] }));
	}

	function render() {
		list.innerHTML = '';
		empty.hidden = results.length > 0;

		results.forEach((res, i) => {
			const row = document.createElement('div');
			row.className = 'dw-sr' + (i === active ? ' active' : '');
			row.id = 'dw-sr-' + i;
			row.setAttribute('role', 'option');
			row.setAttribute('aria-selected', i === active ? 'true' : 'false');

			const open = document.createElement('button');
			open.type = 'button';
			open.className = 'dw-sr-open';
			// The ranges index the joined haystack, whose first field is the label,
			// so any range that starts inside the label highlights correctly and the
			// rest (section, path) fall past its end and are dropped by `highlight`.
			open.innerHTML =
				'<span class="dw-sr-dot" data-section="' +
				res.item.sectionIndex +
				'"></span><span class="dw-sr-text"><span class="dw-sr-label">' +
				highlight(res.item.label, res.ranges) +
				'</span><span class="dw-sr-section">' +
				escapeHtml(res.item.section) +
				'</span></span>';
			open.addEventListener('click', () => choose(i, false));

			const walk = document.createElement('button');
			walk.type = 'button';
			walk.className = 'dw-sr-walk';
			walk.title = 'Walk me there';
			walk.setAttribute('aria-label', 'Walk to ' + res.item.label);
			walk.textContent = 'Walk';
			walk.addEventListener('click', () => choose(i, true));

			row.append(open, walk);
			row.addEventListener('pointerenter', () => setActive(i));
			list.appendChild(row);
		});

		// Paint the section colours the pavilions use, so a result reads as the
		// same thing the visitor is looking at across the plaza.
		for (const dot of list.querySelectorAll('.dw-sr-dot')) {
			dot.style.background = sectionSwatch(Number(dot.dataset.section));
		}
		syncActiveDescendant();
	}

	// Mirrors world.js sectionColor: a golden-angle hue walk from the docs purple.
	// Kept as CSS here rather than importing three.js Color, so the palette can
	// render before (and without) the scene.
	function sectionSwatch(i) {
		return 'hsl(' + ((262 + i * 137.5) % 360).toFixed(1) + ' 62% 62%)';
	}

	function setActive(i) {
		if (!results.length) return;
		active = Math.max(0, Math.min(results.length - 1, i));
		for (const [n, row] of [...list.children].entries()) {
			row.classList.toggle('active', n === active);
			row.setAttribute('aria-selected', n === active ? 'true' : 'false');
		}
		list.children[active]?.scrollIntoView({ block: 'nearest' });
		syncActiveDescendant();
	}

	function syncActiveDescendant() {
		if (results.length) input.setAttribute('aria-activedescendant', 'dw-sr-' + active);
		else input.removeAttribute('aria-activedescendant');
	}

	function search(q) {
		results = q.trim()
			? rank(q, pages, haystack, { limit: RESULT_LIMIT })
			: defaultResults();
		active = 0;
		render();
	}

	function choose(i, walk) {
		const res = results[i];
		if (!res) return;
		close();
		if (walk) onWalk(res.item);
		else onRead(res.item);
	}

	function open() {
		lastFocus = document.activeElement;
		root.hidden = false;
		input.value = '';
		search('');
		requestAnimationFrame(() => {
			root.classList.add('open');
			input.focus({ preventScroll: true });
		});
	}

	function close() {
		root.classList.remove('open');
		root.hidden = true;
		// Returning focus to the canvas rather than the opener keeps WASD live the
		// instant the palette closes; a focused chip would swallow the keystrokes.
		const canvas = document.getElementById('dw-canvas');
		(canvas || lastFocus)?.focus?.({ preventScroll: true });
	}

	input.addEventListener('input', () => search(input.value));

	input.addEventListener('keydown', (e) => {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			setActive(active + 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			setActive(active - 1);
		} else if (e.key === 'Home') {
			e.preventDefault();
			setActive(0);
		} else if (e.key === 'End') {
			e.preventDefault();
			setActive(results.length - 1);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			choose(active, e.shiftKey);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			close();
		}
	});

	closeBtn.addEventListener('click', close);
	root.addEventListener('pointerdown', (e) => {
		if (e.target === root) close();
	});

	return {
		open,
		close,
		get isOpen() {
			return !root.hidden;
		},
		/** Total pages the palette can reach. Used by the HUD copy and the tests. */
		get size() {
			return pages.length;
		},
	};
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}
