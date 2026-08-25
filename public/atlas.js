/**
 * three.ws Atlas: one keystroke to anywhere on the platform.
 * ===========================================================
 *
 * three.ws ships 600+ routes. Before this, the only ways to reach a page were
 * knowing its URL, finding a link to it, or reading the sitemap top to bottom.
 * Every flow therefore started with the same tax: figure out where the flow
 * starts. Atlas removes it. Cmd+K (Ctrl+K on Windows/Linux) anywhere on the
 * site opens a search over every route, and over a curated set of TASKS that
 * answer with ordered steps instead of a link, because "which page do I open to
 * get paid per API call" is a harder question than "where is /receipts".
 *
 * Design decisions worth keeping:
 *
 *   Zero dependencies, one file, no framework. It has to run identically on 250
 *   hand-written HTML pages built by different generations of this codebase.
 *
 *   The index is fetched on FIRST OPEN, never at page load. A visitor who never
 *   presses Cmd+K pays nothing beyond this script. The fetch is also warmed on
 *   the first idle callback so the first open still feels instant.
 *
 *   The empty state is the feature. Opening with an empty box shows where you
 *   have been and what most people are trying to do. A palette that shows
 *   nothing until you type only helps people who already know the answer.
 *
 *   Ranking lives in ./atlas/score.js, DOM-free and unit-tested. See the note
 *   at the top of that file for why.
 *
 * Opt out on a page with <html data-no-atlas> or <meta name="atlas" content="off">.
 * Embeds and iframes opt out automatically.
 */
import { rankPages, rankIntents, highlight } from './atlas/score.js';

(function () {
	'use strict';

	if (window.__twsAtlas) return;

	// Never inside a third-party frame: our keyboard shortcut is not theirs to take.
	try {
		if (window.self !== window.top) return;
	} catch (_) {
		return;
	}
	if (document.documentElement.hasAttribute('data-no-atlas')) return;
	if (document.querySelector('meta[name="atlas"][content="off"]')) return;

	var INDEX_URL = '/atlas-index.json';
	var RECENT_KEY = 'tws:atlas:recent';
	var HINT_KEY = 'tws:atlas:hinted';
	var RECENT_MAX = 6;
	var IS_APPLE = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
	var MOD_LABEL = IS_APPLE ? '⌘' : 'Ctrl';

	var index = null;
	var indexPromise = null;
	var root = null;
	var input = null;
	var listEl = null;
	var countEl = null;
	var footHint = null;
	var rows = [];
	var active = 0;
	var lastFocus = null;
	var open = false;
	var rowSeq = 0;

	// ---------------------------------------------------------------------
	// Styles. Scoped under .tws-atlas so they can never leak into a page, and
	// every token has a literal fallback because a handful of older pages do
	// not load /style.css.
	// ---------------------------------------------------------------------
	var CSS = [
		'.tws-atlas{position:fixed;inset:0;z-index:var(--z-overlay-modal,2147483600);display:flex;',
		'align-items:flex-start;justify-content:center;padding:max(8vh,48px) 16px 16px;',
		'background:rgba(0,0,0,.62);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);',
		'opacity:0;transition:opacity .16s ease;font-family:var(--font-body,ui-sans-serif,system-ui,sans-serif)}',
		'.tws-atlas[data-open]{opacity:1}',
		'.tws-atlas-card{width:min(680px,100%);max-height:min(72vh,640px);display:flex;flex-direction:column;',
		'background:var(--surface-1,#0e0e0e);color:var(--ink,#ececec);',
		'border:1px solid var(--stroke-strong,rgba(255,255,255,.16));border-radius:var(--radius-card,16px);',
		'box-shadow:0 24px 80px rgba(0,0,0,.55);overflow:hidden;',
		'transform:translateY(-8px) scale(.985);transition:transform .16s cubic-bezier(.2,.8,.3,1)}',
		'.tws-atlas[data-open] .tws-atlas-card{transform:none}',

		/* Search row */
		'.tws-atlas-search{display:flex;align-items:center;gap:10px;padding:14px 16px;',
		'border-bottom:1px solid var(--stroke,rgba(255,255,255,.09));flex:0 0 auto}',
		'.tws-atlas-search svg{width:17px;height:17px;flex:0 0 auto;opacity:.55}',
		'.tws-atlas-input{flex:1;min-width:0;background:none;border:0;outline:none;color:inherit;',
		'font:inherit;font-size:16px;line-height:1.4;padding:2px 0}',
		'.tws-atlas-input::placeholder{color:var(--ink-dim,#8b8b8b)}',
		'.tws-atlas-esc{flex:0 0 auto;font-size:10px;letter-spacing:.06em;text-transform:uppercase;',
		'color:var(--ink-dim,#8b8b8b);border:1px solid var(--stroke,rgba(255,255,255,.14));',
		'border-radius:5px;padding:3px 6px;background:none;cursor:pointer;font-family:inherit}',
		'.tws-atlas-esc:hover{color:var(--ink,#ececec);border-color:var(--stroke-strong,rgba(255,255,255,.28))}',

		/* Results */
		'.tws-atlas-list{flex:1 1 auto;overflow-y:auto;overscroll-behavior:contain;padding:6px 0 8px;',
		'scrollbar-width:thin}',
		'.tws-atlas-group{padding:12px 16px 4px;font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;',
		'color:var(--ink-dim,#8b8b8b);font-weight:600}',
		'.tws-atlas-row{display:flex;align-items:flex-start;gap:11px;padding:9px 16px;cursor:pointer;',
		'border-left:2px solid transparent;scroll-margin:56px}',
		'.tws-atlas-row[aria-selected="true"]{background:var(--surface-2,rgba(255,255,255,.06));',
		'border-left-color:var(--ink,#ececec)}',
		'.tws-atlas-row-main{min-width:0;flex:1}',
		'.tws-atlas-row-title{font-size:13.5px;line-height:1.35;color:var(--ink,#ececec);',
		'display:flex;align-items:center;gap:7px;flex-wrap:wrap}',
		'.tws-atlas-row-desc{font-size:11.5px;line-height:1.45;color:var(--ink-dim,#8b8b8b);margin-top:2px;',
		'overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical}',
		'.tws-atlas-row mark{background:none;color:inherit;font-weight:700;text-decoration:underline;',
		'text-decoration-thickness:1px;text-underline-offset:2px}',
		'.tws-atlas-kind{flex:0 0 auto;width:22px;height:22px;margin-top:1px;display:grid;place-items:center;',
		'border:1px solid var(--stroke,rgba(255,255,255,.12));border-radius:6px;font-size:10px;font-weight:700;',
		'color:var(--ink-dim,#8b8b8b);text-transform:uppercase}',
		'.tws-atlas-row[data-kind="intent"] .tws-atlas-kind{border-color:var(--ink,#ececec);color:var(--ink,#ececec)}',
		'.tws-atlas-path{font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);',
		'font-size:10.5px;color:var(--ink-dim,#8b8b8b);flex:0 0 auto}',
		'.tws-atlas-tag{font-size:9.5px;letter-spacing:.05em;text-transform:uppercase;padding:1px 5px;',
		'border:1px solid var(--stroke,rgba(255,255,255,.14));border-radius:999px;color:var(--ink-dim,#8b8b8b)}',

		/* Intent step list */
		'.tws-atlas-steps{list-style:none;margin:7px 0 2px;padding:0;display:grid;gap:5px}',
		'.tws-atlas-step{display:flex;gap:8px;align-items:baseline;font-size:11.5px;line-height:1.45;',
		'color:var(--ink-dim,#8b8b8b)}',
		'.tws-atlas-step b{flex:0 0 auto;width:14px;font-variant-numeric:tabular-nums;font-weight:600;opacity:.7}',
		'.tws-atlas-step a{color:var(--ink,#ececec);text-decoration:underline;text-underline-offset:2px;',
		'text-decoration-color:var(--stroke-strong,rgba(255,255,255,.3))}',
		'.tws-atlas-step a:hover{text-decoration-color:currentColor}',
		'.tws-atlas-step em{font-style:normal;opacity:.65}',

		/* States */
		'.tws-atlas-empty{padding:30px 20px 34px;text-align:center;color:var(--ink-dim,#8b8b8b);font-size:12.5px;',
		'line-height:1.6}',
		'.tws-atlas-empty strong{display:block;color:var(--ink,#ececec);font-size:14px;margin-bottom:6px}',
		'.tws-atlas-empty code{font-family:var(--font-mono,ui-monospace,monospace);font-size:11.5px;',
		'border:1px solid var(--stroke,rgba(255,255,255,.14));border-radius:4px;padding:1px 5px}',
		'.tws-atlas-skel{height:9px;margin:14px 16px;border-radius:4px;',
		'background:linear-gradient(90deg,rgba(255,255,255,.05),rgba(255,255,255,.12),rgba(255,255,255,.05));',
		'background-size:200% 100%;animation:tws-atlas-shimmer 1.1s linear infinite}',
		'@keyframes tws-atlas-shimmer{to{background-position:-200% 0}}',

		/* Footer */
		'.tws-atlas-foot{flex:0 0 auto;display:flex;align-items:center;gap:14px;flex-wrap:wrap;',
		'padding:9px 16px;border-top:1px solid var(--stroke,rgba(255,255,255,.09));',
		'font-size:10.5px;color:var(--ink-dim,#8b8b8b)}',
		'.tws-atlas-foot kbd{font-family:inherit;font-size:10px;border:1px solid var(--stroke,rgba(255,255,255,.16));',
		'border-radius:4px;padding:1px 4px;margin-right:3px;background:var(--surface-2,rgba(255,255,255,.05))}',
		'.tws-atlas-foot a{color:inherit;margin-left:auto;text-decoration:underline;text-underline-offset:2px}',

		/* First-visit hint chip */
		'.tws-atlas-hint{display:flex;align-items:center;gap:9px;padding:9px 13px;',
		'background:var(--surface-1,#0e0e0e);color:var(--ink,#ececec);',
		'border:1px solid var(--stroke-strong,rgba(255,255,255,.18));border-radius:999px;',
		'box-shadow:0 8px 28px rgba(0,0,0,.4);font-size:12px;',
		'font-family:var(--font-body,ui-sans-serif,system-ui,sans-serif);cursor:pointer;',
		'animation:tws-atlas-rise .34s cubic-bezier(.2,.8,.3,1) both}',
		'.tws-atlas-hint kbd{font-family:inherit;font-size:11px;border:1px solid var(--stroke,rgba(255,255,255,.2));',
		'border-radius:5px;padding:2px 6px;background:var(--surface-2,rgba(255,255,255,.06))}',
		'.tws-atlas-hint button{background:none;border:0;color:var(--ink-dim,#8b8b8b);cursor:pointer;',
		'font:inherit;font-size:15px;line-height:1;padding:0 0 0 3px}',
		'.tws-atlas-hint button:hover{color:var(--ink,#ececec)}',
		'@keyframes tws-atlas-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}',

		/* Light theme. The site flips [data-theme] on <html>. */
		'[data-theme="light"] .tws-atlas{background:rgba(255,255,255,.55)}',
		'[data-theme="light"] .tws-atlas-card{background:var(--surface-1,#fff);color:var(--ink,#111);',
		'box-shadow:0 24px 80px rgba(0,0,0,.18)}',
		'[data-theme="light"] .tws-atlas-skel{background:linear-gradient(90deg,rgba(0,0,0,.04),rgba(0,0,0,.1),rgba(0,0,0,.04));background-size:200% 100%}',

		'@media (max-width:560px){',
		'.tws-atlas{padding:0}',
		'.tws-atlas-card{width:100%;max-height:100%;height:100%;border:0;border-radius:0}',
		'.tws-atlas-row-desc{-webkit-line-clamp:2}',
		'}',
		'@media (prefers-reduced-motion:reduce){',
		'.tws-atlas,.tws-atlas-card,.tws-atlas-hint{transition:none;animation:none}',
		'.tws-atlas-skel{animation:none}',
		'}',
	].join('');

	function injectStyles() {
		if (document.getElementById('tws-atlas-css')) return;
		var s = document.createElement('style');
		s.id = 'tws-atlas-css';
		s.textContent = CSS;
		document.head.appendChild(s);
	}

	// ---------------------------------------------------------------------
	// Index loading
	// ---------------------------------------------------------------------
	function loadIndex() {
		if (indexPromise) return indexPromise;
		indexPromise = fetch(INDEX_URL, { credentials: 'omit' })
			.then(function (r) {
				if (!r.ok) throw new Error('atlas index ' + r.status);
				return r.json();
			})
			.then(function (data) {
				index = data;
				// Map path to page tuple once, so recents resolve in O(1).
				index.byPath = Object.create(null);
				for (var i = 0; i < data.pages.length; i++) index.byPath[data.pages[i][0]] = data.pages[i];
				return data;
			})
			.catch(function (err) {
				// Reset so a later open retries rather than being stuck on a
				// transient network failure.
				indexPromise = null;
				throw err;
			});
		return indexPromise;
	}

	// ---------------------------------------------------------------------
	// Recents. Stored as paths; titles are resolved from the index at render
	// time so a renamed page never shows its old name.
	// ---------------------------------------------------------------------
	function readRecents() {
		try {
			var raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
			return Array.isArray(raw) ? raw.filter(function (p) { return typeof p === 'string'; }) : [];
		} catch (_) {
			return [];
		}
	}

	function rememberPath(path) {
		if (!path) return;
		try {
			var list = readRecents().filter(function (p) { return p !== path; });
			list.unshift(path);
			localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
		} catch (_) {
			/* private mode: recents are a nicety, never a hard dependency */
		}
	}

	// ---------------------------------------------------------------------
	// Rendering helpers
	// ---------------------------------------------------------------------
	function el(tag, className, text) {
		var n = document.createElement(tag);
		if (className) n.className = className;
		if (text != null) n.textContent = text;
		return n;
	}

	/** Render `text` into `node` with the query's matched runs wrapped in <mark>. */
	function paintHighlighted(node, text, query) {
		node.textContent = '';
		var runs = query ? highlight(text, query) : [{ t: text, hit: false }];
		for (var i = 0; i < runs.length; i++) {
			if (runs[i].hit) node.appendChild(el('mark', null, runs[i].t));
			else node.appendChild(document.createTextNode(runs[i].t));
		}
	}

	function groupLabel(text) {
		var g = el('div', 'tws-atlas-group', text);
		g.setAttribute('role', 'presentation');
		return g;
	}

	function makeRow(kind) {
		var row = el('div', 'tws-atlas-row');
		row.id = 'tws-atlas-row-' + rowSeq++;
		row.setAttribute('role', 'option');
		row.setAttribute('aria-selected', 'false');
		row.dataset.kind = kind;
		return row;
	}

	function pageRow(page, query) {
		var row = makeRow('page');
		var section = sectionTitle(page[3]);
		row.appendChild(el('span', 'tws-atlas-kind', (section || '?').slice(0, 2)));

		var main = el('div', 'tws-atlas-row-main');
		var title = el('div', 'tws-atlas-row-title');
		var titleText = el('span');
		paintHighlighted(titleText, page[1], query);
		title.appendChild(titleText);
		var path = el('span', 'tws-atlas-path');
		paintHighlighted(path, page[0], query);
		title.appendChild(path);
		if (page[5] & 1) title.appendChild(el('span', 'tws-atlas-tag', 'sign-in'));
		main.appendChild(title);

		if (page[2]) {
			var desc = el('div', 'tws-atlas-row-desc');
			paintHighlighted(desc, page[2], query);
			main.appendChild(desc);
		}
		row.appendChild(main);
		row.dataset.href = page[0];
		return row;
	}

	function intentRow(intent, query) {
		var row = makeRow('intent');
		row.appendChild(el('span', 'tws-atlas-kind', '→'));

		var main = el('div', 'tws-atlas-row-main');
		var title = el('div', 'tws-atlas-row-title');
		var t = el('span');
		paintHighlighted(t, intent.title, query);
		title.appendChild(t);
		title.appendChild(el('span', 'tws-atlas-tag', 'how to'));
		main.appendChild(title);

		if (intent.blurb) main.appendChild(el('div', 'tws-atlas-row-desc', intent.blurb));

		var ol = el('ul', 'tws-atlas-steps');
		for (var i = 0; i < intent.steps.length; i++) {
			var step = intent.steps[i];
			var li = el('li', 'tws-atlas-step');
			li.appendChild(el('b', null, String(i + 1)));
			var body = el('span');
			if (step.to) {
				var a = el('a', null, step.do);
				a.href = step.to;
				// The row's own click handler would double-navigate; let the
				// anchor own its click so Cmd-click and middle-click behave.
				a.addEventListener('click', function (ev) {
					ev.stopPropagation();
					rememberPath(this.getAttribute('href'));
				});
				body.appendChild(a);
			} else {
				body.appendChild(document.createTextNode(step.do));
			}
			if (step.note) {
				body.appendChild(document.createTextNode(' '));
				body.appendChild(el('em', null, '(' + step.note + ')'));
			}
			li.appendChild(body);
			ol.appendChild(li);
		}
		main.appendChild(ol);
		row.appendChild(main);

		// Enter on the intent row follows its first destination, which is always
		// the step that starts the flow.
		for (var j = 0; j < intent.steps.length; j++) {
			if (intent.steps[j].to) {
				row.dataset.href = intent.steps[j].to;
				break;
			}
		}
		return row;
	}

	function sectionTitle(id) {
		if (!index) return '';
		for (var i = 0; i < index.sections.length; i++) {
			if (index.sections[i].id === id) return index.sections[i].title;
		}
		return id;
	}

	// ---------------------------------------------------------------------
	// Result assembly
	// ---------------------------------------------------------------------
	function render(query) {
		listEl.textContent = '';
		rows = [];
		active = 0;

		if (!index) {
			for (var s = 0; s < 5; s++) {
				var sk = el('div', 'tws-atlas-skel');
				sk.style.width = [72, 54, 63, 47, 58][s] + '%';
				listEl.appendChild(sk);
			}
			announce('Loading the index');
			return;
		}

		var q = query.trim();
		if (!q) {
			renderEmptyState();
			return;
		}

		var intents = rankIntents(q, index.intents);
		var pages = rankPages(q, index.pages, { limit: 24 });

		if (intents.length === 0 && pages.length === 0) {
			var none = el('div', 'tws-atlas-empty');
			none.appendChild(el('strong', null, 'Nothing matches "' + q + '"'));
			none.appendChild(
				document.createTextNode('Try a shorter word, or browse the whole map at '),
			);
			var link = el('a', null, '/atlas');
			link.href = '/atlas';
			link.style.color = 'inherit';
			none.appendChild(link);
			none.appendChild(document.createTextNode('.'));
			listEl.appendChild(none);
			announce('No results');
			return;
		}

		if (intents.length) {
			listEl.appendChild(groupLabel('Do this'));
			for (var i = 0; i < intents.length; i++) addRow(intentRow(intents[i].intent, q));
		}

		if (pages.length) {
			listEl.appendChild(groupLabel(intents.length ? 'Pages' : 'Results'));
			for (var p = 0; p < pages.length; p++) addRow(pageRow(pages[p].page, q));
		}

		setActive(0, false);
		announce(rows.length + (rows.length === 1 ? ' result' : ' results'));
	}

	function renderEmptyState() {
		var recents = readRecents()
			.map(function (path) { return index.byPath[path]; })
			.filter(Boolean)
			.slice(0, 5);

		if (recents.length) {
			listEl.appendChild(groupLabel('Recent'));
			for (var i = 0; i < recents.length; i++) addRow(pageRow(recents[i], ''));
		}

		// The starting points every visitor eventually needs, in the order a
		// first-timer needs them. This is the onboarding surface: someone who
		// opens Atlas with no idea what to type still leaves with a next step.
		listEl.appendChild(groupLabel(recents.length ? 'Start here' : 'What do you want to do?'));
		var starters = index.intents.slice(0, 6);
		for (var s = 0; s < starters.length; s++) addRow(intentRow(starters[s], ''));

		setActive(0, false);
		announce(rows.length + ' suggestions. Type to search ' + index.pageCount + ' pages.');
	}

	function addRow(row) {
		row.addEventListener('click', function () {
			go(this.dataset.href, false);
		});
		row.addEventListener('mousemove', function () {
			var i = rows.indexOf(this);
			if (i >= 0 && i !== active) setActive(i, false);
		});
		listEl.appendChild(row);
		rows.push(row);
	}

	function setActive(i, scroll) {
		if (!rows.length) return;
		if (rows[active]) rows[active].setAttribute('aria-selected', 'false');
		active = Math.max(0, Math.min(rows.length - 1, i));
		var row = rows[active];
		row.setAttribute('aria-selected', 'true');
		input.setAttribute('aria-activedescendant', row.id);
		if (scroll !== false) row.scrollIntoView({ block: 'nearest' });
	}

	function announce(text) {
		if (countEl) countEl.textContent = text;
	}

	function go(href, newTab) {
		if (!href) return;
		rememberPath(href);
		if (newTab) {
			window.open(href, '_blank', 'noopener');
			return;
		}
		close();
		window.location.href = href;
	}

	// ---------------------------------------------------------------------
	// Overlay lifecycle
	// ---------------------------------------------------------------------
	function build() {
		injectStyles();
		root = el('div', 'tws-atlas');
		root.setAttribute('role', 'dialog');
		root.setAttribute('aria-modal', 'true');
		root.setAttribute('aria-label', 'Search three.ws');
		root.hidden = true;

		var card = el('div', 'tws-atlas-card');

		var search = el('div', 'tws-atlas-search');
		var icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		icon.setAttribute('viewBox', '0 0 24 24');
		icon.setAttribute('fill', 'none');
		icon.setAttribute('stroke', 'currentColor');
		icon.setAttribute('stroke-width', '2');
		icon.setAttribute('aria-hidden', 'true');
		var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		circle.setAttribute('cx', '11');
		circle.setAttribute('cy', '11');
		circle.setAttribute('r', '7');
		var line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		line.setAttribute('d', 'M20 20l-4-4');
		line.setAttribute('stroke-linecap', 'round');
		icon.appendChild(circle);
		icon.appendChild(line);
		search.appendChild(icon);

		input = el('input', 'tws-atlas-input');
		input.type = 'text';
		input.autocomplete = 'off';
		input.spellcheck = false;
		input.placeholder = 'Search pages, or describe what you want to do';
		input.setAttribute('aria-label', 'Search three.ws');
		input.setAttribute('role', 'combobox');
		input.setAttribute('aria-expanded', 'true');
		input.setAttribute('aria-autocomplete', 'list');
		search.appendChild(input);

		var esc = el('button', 'tws-atlas-esc', 'esc');
		esc.type = 'button';
		esc.setAttribute('aria-label', 'Close search');
		esc.addEventListener('click', close);
		search.appendChild(esc);
		card.appendChild(search);

		listEl = el('div', 'tws-atlas-list');
		listEl.setAttribute('role', 'listbox');
		listEl.setAttribute('aria-label', 'Search results');
		card.appendChild(listEl);
		input.setAttribute('aria-controls', (listEl.id = 'tws-atlas-list'));

		var foot = el('div', 'tws-atlas-foot');
		foot.appendChild(kbdHint('↵', 'open'));
		foot.appendChild(kbdHint('↑↓', 'navigate'));
		foot.appendChild(kbdHint(MOD_LABEL + ' ↵', 'new tab'));
		footHint = el('a', null, 'Browse the full map');
		footHint.href = '/atlas';
		foot.appendChild(footHint);
		card.appendChild(foot);

		// Screen-reader-only result count. Visually hidden rather than absent so
		// the count is announced on every keystroke without any visual noise.
		countEl = el('div');
		countEl.setAttribute('role', 'status');
		countEl.setAttribute('aria-live', 'polite');
		countEl.style.cssText =
			'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap';
		card.appendChild(countEl);

		root.appendChild(card);
		document.body.appendChild(root);

		root.addEventListener('mousedown', function (e) {
			if (e.target === root) close();
		});
		input.addEventListener('input', function () {
			render(input.value);
		});
		input.addEventListener('keydown', onKeydown);
		return root;
	}

	function kbdHint(keys, label) {
		var wrap = el('span');
		wrap.appendChild(el('kbd', null, keys));
		wrap.appendChild(document.createTextNode(label));
		return wrap;
	}

	function onKeydown(e) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			setActive(active + 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			setActive(active - 1);
		} else if (e.key === 'Home' && !input.value) {
			e.preventDefault();
			setActive(0);
		} else if (e.key === 'End' && !input.value) {
			e.preventDefault();
			setActive(rows.length - 1);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			if (rows[active]) go(rows[active].dataset.href, e.metaKey || e.ctrlKey);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			close();
		} else if (e.key === 'Tab') {
			// The card holds exactly three focusables and the list is driven by
			// aria-activedescendant, so keeping focus on the input IS the trap.
			e.preventDefault();
		}
	}

	function show(seed) {
		if (open) return;
		if (!root) build();
		lastFocus = document.activeElement;
		open = true;
		root.hidden = false;
		document.documentElement.style.overflow = 'hidden';
		// Force a frame so the opacity transition actually runs.
		requestAnimationFrame(function () {
			root.setAttribute('data-open', '');
		});
		input.value = seed || '';
		input.focus();
		render(input.value);

		loadIndex().then(
			function () {
				if (open) render(input.value);
			},
			function () {
				if (!open) return;
				listEl.textContent = '';
				var fail = el('div', 'tws-atlas-empty');
				fail.appendChild(el('strong', null, 'Search is offline'));
				fail.appendChild(document.createTextNode('The index did not load. '));
				var a = el('a', null, 'Browse the sitemap instead');
				a.href = '/sitemap';
				a.style.color = 'inherit';
				fail.appendChild(a);
				fail.appendChild(document.createTextNode('.'));
				listEl.appendChild(fail);
				announce('Search index unavailable');
			},
		);
	}

	function close() {
		if (!open || !root) return;
		open = false;
		root.removeAttribute('data-open');
		document.documentElement.style.overflow = '';
		var finish = function () {
			if (!open) root.hidden = true;
		};
		if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
		else setTimeout(finish, 170);
		if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
	}

	// ---------------------------------------------------------------------
	// Global shortcut
	// ---------------------------------------------------------------------
	function isTypingTarget(node) {
		if (!node) return false;
		if (node.isContentEditable) return true;
		var tag = node.tagName;
		return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
	}

	// Cmd/Ctrl+K belongs to Atlas everywhere, so it is claimed in the capture
	// phase before any page can intercept it.
	document.addEventListener(
		'keydown',
		function (e) {
			if (e.defaultPrevented) return;
			var mod = e.metaKey || e.ctrlKey;
			if (!mod || e.altKey) return;
			if (e.key !== 'k' && e.key !== 'K') return;
			e.preventDefault();
			if (open) close();
			else show('');
		},
		true,
	);

	// "/" is the other muscle-memory shortcut, but it is shared: ~20 pages bind
	// it to focus their own search or address field, and the page's field is
	// what a visitor on that page means by "/". This listener therefore runs in
	// the BUBBLE phase (no capture flag) and Atlas is injected last on the page,
	// so every page-level document listener has already had its turn; a page
	// that handled "/" leaves defaultPrevented set and Atlas stands down. In the
	// capture phase Atlas won unconditionally and those page shortcuts were dead
	// on arrival, including the "Press / to focus" hint printed on /airdrops.
	document.addEventListener('keydown', function (e) {
		if (e.defaultPrevented || open) return;
		var mod = e.metaKey || e.ctrlKey;
		// Never steal it from a form.
		if (e.key !== '/' || mod || e.altKey || isTypingTarget(e.target)) return;
		e.preventDefault();
		show('');
	});

	// Any element on any page can open Atlas by declaring itself.
	document.addEventListener('click', function (e) {
		var trigger = e.target.closest && e.target.closest('[data-atlas-open]');
		if (!trigger) return;
		e.preventDefault();
		show(trigger.getAttribute('data-atlas-open') || '');
	});

	// ---------------------------------------------------------------------
	// Discoverability. A shortcut nobody knows about is not a feature, so the
	// first visit gets one dismissible chip. It is shown once ever, mounts into
	// the shared corner stack when that exists so it cannot cover another
	// widget, and never returns after being seen.
	// ---------------------------------------------------------------------
	function maybeHint() {
		try {
			if (localStorage.getItem(HINT_KEY)) return;
		} catch (_) {
			return; // No storage means no way to remember it was dismissed.
		}
		if (window.matchMedia && window.matchMedia('(max-width: 640px)').matches) return; // No hardware keyboard.

		injectStyles();
		var chip = el('div', 'tws-atlas-hint');
		chip.setAttribute('role', 'note');
		chip.dataset.cornerPriority = '30';
		chip.appendChild(el('kbd', null, MOD_LABEL + ' K'));
		chip.appendChild(el('span', null, 'search anything on three.ws'));
		var dismiss = el('button', null, '×');
		dismiss.type = 'button';
		dismiss.setAttribute('aria-label', 'Dismiss');
		chip.appendChild(dismiss);

		var seen = function () {
			try {
				localStorage.setItem(HINT_KEY, '1');
			} catch (_) {
				/* nothing to do */
			}
			if (chip.parentNode) chip.parentNode.removeChild(chip);
		};
		dismiss.addEventListener('click', function (e) {
			e.stopPropagation();
			seen();
		});
		chip.addEventListener('click', function () {
			seen();
			show('');
		});

		if (window.twsCornerStack && typeof window.twsCornerStack.mount === 'function') {
			document.body.appendChild(chip);
			window.twsCornerStack.mount(chip, { priority: 30 });
		} else {
			chip.style.cssText +=
				';position:fixed;right:18px;bottom:18px;z-index:var(--z-corner-stack,2147482500)';
			document.body.appendChild(chip);
		}
		setTimeout(seen, 12000);
	}

	// ---------------------------------------------------------------------
	// Boot
	// ---------------------------------------------------------------------
	function boot() {
		// Remember where the visitor actually is, so Recent reflects browsing and
		// not only palette use.
		rememberPath(location.pathname.replace(/\/+$/, '') || '/');

		// ?atlas / #atlas open it directly, which is what a link in docs or a
		// support reply needs.
		var params = new URLSearchParams(location.search);
		if (params.has('atlas') || location.hash === '#atlas') {
			show(params.get('atlas') || '');
		}

		var warm = function () {
			loadIndex().catch(function () {
				/* prefetch is best-effort; the real open retries and reports */
			});
		};
		if (window.requestIdleCallback) window.requestIdleCallback(warm, { timeout: 4000 });
		else setTimeout(warm, 2500);

		setTimeout(maybeHint, 3500);
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
	else boot();

	window.__twsAtlas = { open: show, close: close, loadIndex: loadIndex };
})();
