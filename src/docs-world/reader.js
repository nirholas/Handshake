// Docs World overlays: the section page-list panel and the in-world reader.
//
// Both are real DOM (not textures), so the documentation stays selectable,
// zoomable, screen-reader-visible, and SEO-irrelevant chrome stays out of the
// scene. The reader fetches the SAME markdown the classic docs render
// (/docs/<slug>.md) and pipes it through the shared sanitized renderer, so
// there is exactly one source of documentation content on the platform.

import { renderMarkdown } from '../shared/markdown.js';

const MD_CLASSES = {
	pre: 'dw-code',
	'code:not(pre code)': 'dw-ic',
	table: 'dw-md-table',
	blockquote: 'dw-quote',
};

/** Resolve relative .md links against the current doc so the sanitizer keeps
 * them (it only preserves rooted, http(s), mailto and #hash hrefs). */
function absolutizeMdLinks(md, currentPath) {
	return md.replace(/\]\((?!https?:|mailto:|\/|#)([^)\s]+\.md[^)\s]*)\)/g, (m, rel) => {
		try {
			const abs = new URL(rel, location.origin + '/docs/' + currentPath).pathname;
			return '](' + abs + ')';
		} catch {
			return m;
		}
	});
}

/**
 * @param {{ sections: Array<{title:string, links:Array}>,
 *           onNavigateDoc?: (path: string|null) => void }} opts
 *   onNavigateDoc fires whenever the open doc changes (null = reader closed),
 *   letting main.js keep the URL hash shareable.
 */
export function createOverlays({ sections, onNavigateDoc }) {
	const flatPages = sections.flatMap((s) =>
		s.links.filter((l) => l.path).map((l) => ({ ...l, section: s.title })),
	);

	const panel = document.getElementById('dw-panel');
	const panelTitle = document.getElementById('dw-panel-title');
	const panelList = document.getElementById('dw-panel-list');
	const panelClose = document.getElementById('dw-panel-close');

	const reader = document.getElementById('dw-reader');
	const readerCrumb = document.getElementById('dw-reader-crumb');
	const readerBody = document.getElementById('dw-reader-body');
	const readerClassic = document.getElementById('dw-reader-classic');
	const readerClose = document.getElementById('dw-reader-close');
	const readerPrev = document.getElementById('dw-reader-prev');
	const readerNext = document.getElementById('dw-reader-next');

	let openPath = null;
	let lastFocus = null;

	// ── Section panel ──────────────────────────────────────────────────────────
	function openSection(index) {
		const section = sections[index];
		if (!section) return;
		panelTitle.textContent = section.title;
		panelList.innerHTML = '';
		for (const link of section.links) {
			const a = document.createElement('a');
			a.className = 'dw-panel-link';
			a.textContent = link.label;
			if (link.path) {
				a.href = '/docs/' + link.path;
				// The injected view-transitions shell handles internal links in a
				// document CAPTURE listener, so it would navigate before this
				// handler ever runs. data-no-transition is its designed opt-out.
				a.dataset.noTransition = '1';
				a.addEventListener('click', (e) => {
					e.preventDefault();
					openDoc(link.path);
				});
			} else {
				a.href = link.href;
				a.target = '_blank';
				a.rel = 'noopener';
				a.classList.add('external');
			}
			panelList.appendChild(a);
		}
		lastFocus = document.activeElement;
		panel.hidden = false;
		requestAnimationFrame(() => panel.classList.add('open'));
		panelClose.focus({ preventScroll: true });
	}

	function closeSection() {
		panel.classList.remove('open');
		panel.hidden = true;
		lastFocus?.focus?.({ preventScroll: true });
	}

	// ── Reader ─────────────────────────────────────────────────────────────────
	async function openDoc(path) {
		openPath = path;
		const meta = flatPages.find((p) => p.path === path);
		readerCrumb.textContent = meta ? meta.section + ' / ' + meta.label : path;
		readerClassic.href = '/docs/' + path;
		readerBody.innerHTML =
			'<div class="dw-skeleton"><span></span><span></span><span></span><span class="short"></span></div>';
		reader.hidden = false;
		requestAnimationFrame(() => reader.classList.add('open'));
		readerClose.focus({ preventScroll: true });
		renderPager(path);
		onNavigateDoc?.(path);

		try {
			const res = await fetch('/docs/' + path + '.md');
			if (!res.ok) throw new Error('HTTP ' + res.status);
			const md = await res.text();
			if (openPath !== path) return; // reader moved on while fetching
			readerBody.innerHTML = renderMarkdown(absolutizeMdLinks(md, path), {
				classes: MD_CLASSES,
			});
			readerBody.scrollTop = 0;
			interceptDocLinks();
		} catch (err) {
			if (openPath !== path) return;
			readerBody.innerHTML = '';
			const errBox = document.createElement('div');
			errBox.className = 'dw-error';
			errBox.innerHTML =
				'<p>Could not load this page (' +
				String(err?.message || err).replace(/[<>&]/g, '') +
				').</p>';
			const retry = document.createElement('button');
			retry.type = 'button';
			retry.className = 'dw-btn';
			retry.textContent = 'Retry';
			retry.addEventListener('click', () => openDoc(path));
			const classic = document.createElement('a');
			classic.className = 'dw-btn ghost';
			classic.href = '/docs/' + path;
			classic.textContent = 'Open in classic docs';
			errBox.append(retry, classic);
			readerBody.appendChild(errBox);
		}
	}

	// Keep in-doc navigation inside the world: a link to another doc opens in
	// this reader instead of tearing the visitor out to the classic SPA.
	function interceptDocLinks() {
		for (const a of readerBody.querySelectorAll('a[href]')) {
			const href = a.getAttribute('href') || '';
			const m = href.match(/^\/docs\/(.+?)(?:\.md)?$/);
			if (!m || m[1].startsWith('walk')) continue;
			a.dataset.noTransition = '1'; // keep the view-transitions shell off it
			a.addEventListener('click', (e) => {
				e.preventDefault();
				openDoc(m[1]);
			});
			a.removeAttribute('target');
		}
	}

	function renderPager(path) {
		const idx = flatPages.findIndex((p) => p.path === path);
		const prev = idx > 0 ? flatPages[idx - 1] : null;
		const next = idx >= 0 && idx < flatPages.length - 1 ? flatPages[idx + 1] : null;
		readerPrev.disabled = !prev;
		readerNext.disabled = !next;
		readerPrev.textContent = prev ? '← ' + prev.label : '← Start';
		readerNext.textContent = next ? next.label + ' →' : 'End →';
		readerPrev.onclick = prev ? () => openDoc(prev.path) : null;
		readerNext.onclick = next ? () => openDoc(next.path) : null;
	}

	function closeReader() {
		openPath = null;
		reader.classList.remove('open');
		reader.hidden = true;
		onNavigateDoc?.(null);
	}

	panelClose.addEventListener('click', closeSection);
	readerClose.addEventListener('click', closeReader);
	addEventListener('keydown', (e) => {
		if (e.key !== 'Escape') return;
		if (!reader.hidden) closeReader();
		else if (!panel.hidden) closeSection();
	});

	return {
		openSection,
		closeSection,
		openDoc,
		closeReader,
		get isOpen() {
			return !reader.hidden || !panel.hidden;
		},
		/** Section index that contains a doc path, or -1. */
		sectionIndexForPath(path) {
			return sections.findIndex((s) => s.links.some((l) => l.path === path));
		},
		/** True when `path` is a page in the manifest. Lets a deep link decide
		 * whether to open the reader at all, instead of opening it on an unknown
		 * slug and greeting the visitor with a 404 the moment the world loads. */
		hasPath(path) {
			return flatPages.some((p) => p.path === path);
		},
	};
}
