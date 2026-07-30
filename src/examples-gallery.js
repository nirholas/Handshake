// /examples: the browsable index of every runnable example that ships in the
// three.ws repository.
//
// Feed: GET /examples.json, mirrored from data/examples.json, which
// scripts/build-examples-index.mjs derives by scanning the repo. That matters
// for trust: the gallery cannot advertise an example that was deleted, and it
// cannot miss one that was added, because nothing here is hand-listed.
//
// Every card is a real artifact with a real way to run it. Three kinds exist,
// and they are genuinely different things rather than a styling choice:
//   html-demo  a single self-contained page, opened at a dev-server URL
//   project    a directory with its own README, run by a shell command
//   package    the examples folder that ships beside an SDK or npm package
//
// The examples are source files in the repo, not hosted routes, so every card
// links to GitHub for the source. Nothing here pretends to be a live demo.

const els = {
	grid: document.querySelector('[data-role="grid"]'),
	loading: document.querySelector('[data-role="loading"]'),
	empty: document.querySelector('[data-role="empty"]'),
	emptySearch: document.querySelector('[data-role="empty-search"]'),
	error: document.querySelector('[data-role="error"]'),
	errorMsg: document.querySelector('[data-role="error-msg"]'),
	search: document.querySelector('[data-role="search"]'),
	sort: document.querySelector('[data-role="sort"]'),
	count: document.querySelector('[data-role="count"]'),
	heroStats: document.querySelector('[data-role="hero-stats"]'),
	clearSearch: document.querySelector('[data-role="clear-search"]'),
	retry: document.querySelector('[data-role="retry"]'),
	chips: document.querySelector('[data-role="chips"]'),
	live: document.querySelector('[data-role="live"]'),
};

const state = { all: [], groups: [], query: '', sort: 'group', group: '' };

const REPO = 'https://github.com/nirholas/three.ws';
const BRANCH = 'main';

function escapeHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const escapeAttr = escapeHtml;
function show(el, on) {
	if (el) el.hidden = !on;
}

/** Screen-reader announcement for filter results, which change silently otherwise. */
function announce(message) {
	if (els.live) els.live.textContent = message;
}

const KIND_LABEL = { 'html-demo': 'Web component demo', project: 'Example project', package: 'Package example' };
const KIND_ICON = { 'html-demo': '🧩', project: '📦', package: '🔌' };

/** A directory path is a tree link on GitHub; a single file is a blob link. */
function sourceUrl(example) {
	const isDir = example.kind !== 'html-demo' && !/\.[a-z0-9]+$/i.test(example.path);
	return `${REPO}/${isDir ? 'tree' : 'blob'}/${BRANCH}/${example.path}`;
}

function readmeUrl(example) {
	return example.readme ? `${REPO}/blob/${BRANCH}/${example.readme}` : null;
}

/**
 * The one line a reader needs to actually run the example. `runKind: 'url'`
 * means "start the dev server and open this path", so it is rendered as a path
 * rather than a link: these files are not served by the production site.
 */
function runLine(example) {
	if (!example.run) return '';
	return example.runKind === 'url' ? `npm run dev  →  ${example.run}` : example.run;
}

function matches(example, query) {
	if (!query) return true;
	const haystack = [example.title, example.description, example.path, example.owner, KIND_LABEL[example.kind]]
		.filter(Boolean)
		.join(' ')
		.toLowerCase();
	return query
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.every((term) => haystack.includes(term));
}

function visible() {
	let list = state.all.filter((e) => matches(e, state.query));
	if (state.group) list = list.filter((e) => e.group === state.group);
	const byTitle = (a, b) => a.title.localeCompare(b.title);
	if (state.sort === 'title') list = [...list].sort(byTitle);
	else if (state.sort === 'files') list = [...list].sort((a, b) => (b.files?.length || 0) - (a.files?.length || 0) || byTitle(a, b));
	else list = [...list].sort((a, b) => a.group.localeCompare(b.group) || byTitle(a, b));
	return list;
}

function card(example) {
	const files = Array.isArray(example.files) ? example.files : [];
	const readme = readmeUrl(example);
	const run = runLine(example);
	return `
		<article class="ex-card">
			<div class="ex-card-top">
				<span class="ex-card-kind" title="${escapeAttr(KIND_LABEL[example.kind] || example.kind)}">
					<span aria-hidden="true">${KIND_ICON[example.kind] || '📄'}</span>
					${escapeHtml(KIND_LABEL[example.kind] || example.kind)}
				</span>
				${example.owner ? `<span class="ex-card-owner">${escapeHtml(example.owner)}</span>` : ''}
			</div>
			<h3 class="ex-card-title">
				<a href="${escapeAttr(sourceUrl(example))}" target="_blank" rel="noopener noreferrer">${escapeHtml(example.title)}</a>
			</h3>
			${example.description ? `<p class="ex-card-desc">${escapeHtml(example.description)}</p>` : ''}
			${
				files.length
					? `<ul class="ex-card-files">${files
							.slice(0, 5)
							.map((f) => `<li><code>${escapeHtml(f)}</code></li>`)
							.join('')}${files.length > 5 ? `<li class="ex-card-more">+${files.length - 5} more</li>` : ''}</ul>`
					: ''
			}
			${
				run
					? `<div class="ex-card-run">
							<code data-role="run" title="${escapeAttr(run)}">${escapeHtml(run)}</code>
							<button type="button" class="ex-copy" data-copy="${escapeAttr(example.run)}" aria-label="Copy the command that runs ${escapeAttr(example.title)}">Copy</button>
						</div>`
					: ''
			}
			<div class="ex-card-actions">
				<a class="ex-btn ex-btn--primary" href="${escapeAttr(sourceUrl(example))}" target="_blank" rel="noopener noreferrer">View source</a>
				${readme ? `<a class="ex-btn ex-btn--ghost" href="${escapeAttr(readme)}" target="_blank" rel="noopener noreferrer">README</a>` : ''}
				<span class="ex-card-path" title="${escapeAttr(example.path)}">${escapeHtml(example.path)}</span>
			</div>
		</article>`;
}

function renderChips() {
	if (!els.chips) return;
	const counts = new Map();
	for (const example of state.all) counts.set(example.group, (counts.get(example.group) || 0) + 1);
	const chip = (value, label, count) =>
		`<button type="button" role="tab" class="ex-chip${state.group === value ? ' is-active' : ''}" aria-selected="${state.group === value}" data-group="${escapeAttr(value)}">${escapeHtml(label)} <span class="ex-chip-n">${count}</span></button>`;
	els.chips.innerHTML = [
		chip('', 'All', state.all.length),
		...state.groups.map((g) => chip(g, g, counts.get(g) || 0)),
	].join('');
}

function render() {
	const list = visible();
	show(els.loading, false);
	show(els.error, false);

	if (!state.all.length) {
		show(els.grid, false);
		show(els.emptySearch, false);
		show(els.empty, true);
		if (els.count) els.count.textContent = '';
		return;
	}
	show(els.empty, false);

	if (!list.length) {
		show(els.grid, false);
		show(els.emptySearch, true);
		if (els.count) els.count.textContent = '0 examples';
		announce('No examples match the current filter.');
		return;
	}

	show(els.emptySearch, false);
	els.grid.innerHTML = list.map(card).join('');
	show(els.grid, true);
	if (els.count) els.count.textContent = `${list.length} of ${state.all.length} examples`;
	announce(`${list.length} examples shown.`);
}

function renderHeroStats(counts) {
	if (!els.heroStats || !counts) return;
	const parts = [`${counts.total} examples`];
	if (counts.html_demos) parts.push(`${counts.html_demos} demos`);
	if (counts.projects) parts.push(`${counts.projects} projects`);
	if (counts.packages) parts.push(`${counts.packages} package sets`);
	els.heroStats.textContent = parts.join(' · ');
}

async function load() {
	show(els.error, false);
	show(els.empty, false);
	show(els.emptySearch, false);
	show(els.grid, false);
	show(els.loading, true);
	try {
		const res = await fetch('/examples.json', { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`the index returned HTTP ${res.status}`);
		const data = await res.json();
		const examples = Array.isArray(data?.examples) ? data.examples : [];
		state.all = examples.filter((e) => e && e.title && e.path);
		state.groups = [...new Set(state.all.map((e) => e.group).filter(Boolean))].sort();
		renderHeroStats(data?.counts);
		renderChips();
		render();
	} catch (err) {
		show(els.loading, false);
		show(els.grid, false);
		if (els.errorMsg) els.errorMsg.textContent = `Could not load the example index: ${err.message}.`;
		show(els.error, true);
	}
}

function bind() {
	let debounce;
	els.search?.addEventListener('input', (e) => {
		clearTimeout(debounce);
		const value = e.target.value;
		debounce = setTimeout(() => {
			state.query = value.trim();
			render();
		}, 120);
	});
	els.sort?.addEventListener('change', (e) => {
		state.sort = e.target.value;
		render();
	});
	els.chips?.addEventListener('click', (e) => {
		const button = e.target.closest('[data-group]');
		if (!button) return;
		state.group = button.dataset.group;
		renderChips();
		render();
	});
	els.clearSearch?.addEventListener('click', () => {
		state.query = '';
		state.group = '';
		if (els.search) els.search.value = '';
		renderChips();
		render();
		els.search?.focus();
	});
	els.retry?.addEventListener('click', load);

	// Copy-to-clipboard on the run command, with the button reporting its own
	// result: a silent copy leaves the reader unsure whether it worked.
	els.grid?.addEventListener('click', async (e) => {
		const button = e.target.closest('.ex-copy');
		if (!button) return;
		const text = button.dataset.copy || '';
		try {
			await navigator.clipboard.writeText(text);
			button.textContent = 'Copied';
			button.classList.add('is-copied');
		} catch {
			button.textContent = 'Press ⌘C';
		}
		setTimeout(() => {
			button.textContent = 'Copy';
			button.classList.remove('is-copied');
		}, 1600);
	});

	// "/" focuses search, the convention the other galleries on this site use.
	document.addEventListener('keydown', (e) => {
		if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
		const tag = document.activeElement?.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
		e.preventDefault();
		els.search?.focus();
		els.search?.select();
	});
}

bind();
load();
