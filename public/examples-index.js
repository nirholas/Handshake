/* The "every example in the repo" half of /examples.
 *
 * The cards above this section are curated runnable snippets. This section is
 * the complete set, fetched from /examples.json, which is mirrored from
 * data/examples.json, which scripts/build-examples-index.mjs derives by
 * scanning the repository. Nothing here is hand-listed, which is the point:
 * an example added or deleted in the repo shows up or disappears on the next
 * build, so the page cannot drift out of sync with what actually ships.
 *
 * These are source files in a git repository, not hosted routes, so every card
 * links to GitHub. Nothing here claims to be a live demo.
 */

const REPO = 'https://github.com/nirholas/three.ws';
const BRANCH = 'main';

const els = {
	root: document.querySelector('[data-role="ex-browse"]'),
	grid: document.querySelector('[data-role="ex-grid"]'),
	search: document.querySelector('[data-role="ex-search"]'),
	chips: document.querySelector('[data-role="ex-chips"]'),
	count: document.querySelector('[data-role="ex-count"]'),
	loading: document.querySelector('[data-role="ex-loading"]'),
	error: document.querySelector('[data-role="ex-error"]'),
	errorMsg: document.querySelector('[data-role="ex-error-msg"]'),
	retry: document.querySelector('[data-role="ex-retry"]'),
	emptySearch: document.querySelector('[data-role="ex-empty-search"]'),
	clear: document.querySelector('[data-role="ex-clear"]'),
	live: document.querySelector('[data-role="ex-live"]'),
};

// The page ships this section's markup; if it is absent the script is loaded on
// a page it was not written for, and doing nothing is the correct behavior.
if (els.root && els.grid) {
	const state = { all: [], groups: [], query: '', group: '' };

	const escapeHtml = (s) =>
		String(s ?? '').replace(
			/[&<>"']/g,
			(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
		);
	const show = (el, on) => {
		if (el) el.hidden = !on;
	};
	const announce = (msg) => {
		if (els.live) els.live.textContent = msg;
	};

	const KIND_LABEL = {
		'html-demo': 'Web component demo',
		project: 'Example project',
		package: 'Package example',
	};

	/** A directory is a tree link on GitHub; a single file is a blob link. */
	const sourceUrl = (ex) =>
		`${REPO}/${/\.[a-z0-9]+$/i.test(ex.path) ? 'blob' : 'tree'}/${BRANCH}/${ex.path}`;

	/**
	 * The one line a reader needs to run it. `runKind: 'url'` means "start the
	 * dev server, then open this path": those files are not served by the
	 * production site, so rendering them as links would be a lie.
	 */
	const runLine = (ex) => (ex.run ? (ex.runKind === 'url' ? `npm run dev  →  ${ex.run}` : ex.run) : '');

	function matches(ex, query) {
		if (!query) return true;
		const haystack = [ex.title, ex.description, ex.path, ex.owner, KIND_LABEL[ex.kind], ex.group]
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
		return state.all
			.filter((ex) => matches(ex, state.query))
			.filter((ex) => !state.group || ex.group === state.group)
			.sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title));
	}

	function card(ex) {
		const files = Array.isArray(ex.files) ? ex.files : [];
		const run = runLine(ex);
		const readme = ex.readme ? `${REPO}/blob/${BRANCH}/${ex.readme}` : null;
		return `
			<article class="exi-card">
				<div class="exi-card-top">
					<span class="exi-kind">${escapeHtml(KIND_LABEL[ex.kind] || ex.kind)}</span>
					${ex.owner ? `<span class="exi-owner">${escapeHtml(ex.owner)}</span>` : ''}
				</div>
				<h3 class="exi-card-title">
					<a href="${escapeHtml(sourceUrl(ex))}" target="_blank" rel="noopener noreferrer">${escapeHtml(ex.title)}</a>
				</h3>
				${ex.description ? `<p class="exi-card-desc">${escapeHtml(ex.description)}</p>` : ''}
				${
					files.length
						? `<ul class="exi-files">${files
								.slice(0, 4)
								.map((f) => `<li><code>${escapeHtml(f)}</code></li>`)
								.join('')}${files.length > 4 ? `<li class="exi-more">+${files.length - 4} more</li>` : ''}</ul>`
						: ''
				}
				${
					run
						? `<div class="exi-run">
								<code title="${escapeHtml(run)}">${escapeHtml(run)}</code>
								<button type="button" class="exi-copy" data-copy="${escapeHtml(ex.run)}" aria-label="Copy the command that runs ${escapeHtml(ex.title)}">Copy</button>
							</div>`
						: ''
				}
				<div class="exi-actions">
					<a class="exi-btn" href="${escapeHtml(sourceUrl(ex))}" target="_blank" rel="noopener noreferrer">View source</a>
					${readme ? `<a class="exi-btn exi-btn--ghost" href="${escapeHtml(readme)}" target="_blank" rel="noopener noreferrer">README</a>` : ''}
					<span class="exi-path" title="${escapeHtml(ex.path)}">${escapeHtml(ex.path)}</span>
				</div>
			</article>`;
	}

	function renderChips() {
		if (!els.chips) return;
		const counts = new Map();
		for (const ex of state.all) counts.set(ex.group, (counts.get(ex.group) || 0) + 1);
		const chip = (value, label, n) =>
			`<button type="button" role="tab" class="exi-chip${state.group === value ? ' is-active' : ''}" aria-selected="${state.group === value}" data-group="${escapeHtml(value)}">${escapeHtml(label)} <span class="exi-chip-n">${n}</span></button>`;
		els.chips.innerHTML = [
			chip('', 'All', state.all.length),
			...state.groups.map((g) => chip(g, g, counts.get(g) || 0)),
		].join('');
	}

	function render() {
		const list = visible();
		show(els.loading, false);
		show(els.error, false);
		if (!list.length) {
			show(els.grid, false);
			show(els.emptySearch, true);
			if (els.count) els.count.textContent = '0 shown';
			announce('No examples match the current filter.');
			return;
		}
		show(els.emptySearch, false);
		els.grid.innerHTML = list.map(card).join('');
		show(els.grid, true);
		if (els.count) els.count.textContent = `${list.length} of ${state.all.length} shown`;
		announce(`${list.length} examples shown.`);
	}

	async function load() {
		show(els.error, false);
		show(els.emptySearch, false);
		show(els.grid, false);
		show(els.loading, true);
		try {
			const res = await fetch('/examples.json', { headers: { accept: 'application/json' } });
			if (!res.ok) throw new Error(`the index returned HTTP ${res.status}`);
			const data = await res.json();
			const examples = Array.isArray(data?.examples) ? data.examples : [];
			state.all = examples.filter((ex) => ex && ex.title && ex.path && ex.group);
			if (!state.all.length) throw new Error('the index is empty');
			state.groups = [...new Set(state.all.map((ex) => ex.group))].sort();
			renderChips();
			render();
		} catch (err) {
			show(els.loading, false);
			show(els.grid, false);
			show(els.emptySearch, false);
			if (els.errorMsg) els.errorMsg.textContent = `Could not load the example index: ${err.message}.`;
			show(els.error, true);
		}
	}

	let debounce;
	els.search?.addEventListener('input', (e) => {
		const value = e.target.value;
		clearTimeout(debounce);
		debounce = setTimeout(() => {
			state.query = value.trim();
			render();
		}, 120);
	});

	els.chips?.addEventListener('click', (e) => {
		const button = e.target.closest('[data-group]');
		if (!button) return;
		state.group = button.dataset.group;
		renderChips();
		render();
	});

	els.clear?.addEventListener('click', () => {
		state.query = '';
		state.group = '';
		if (els.search) els.search.value = '';
		renderChips();
		render();
		els.search?.focus();
	});

	els.retry?.addEventListener('click', load);

	// Copy reports its own result: a silent clipboard write leaves the reader
	// unsure whether anything happened.
	els.grid.addEventListener('click', async (e) => {
		const button = e.target.closest('.exi-copy');
		if (!button) return;
		try {
			await navigator.clipboard.writeText(button.dataset.copy || '');
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

	load();
}
