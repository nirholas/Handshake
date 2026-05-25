// Library — animations, memory, strategy, voice tabs in one page.
// Hash-driven tab switcher (#tab=animations|memory|strategy|voice).

import { mountShell } from '../shell.js';
import { requireUser, get, esc } from '../api.js';
import { renderAnimations } from './library/animations.js';
import { renderMemory }     from './library/memory.js';
import { renderStrategy }   from './library/strategy.js';
import { renderVoice }      from './library/voice.js';

const TABS = [
	{ key: 'animations', label: 'Animations' },
	{ key: 'memory',     label: 'Memory'     },
	{ key: 'strategy',   label: 'Strategy'   },
	{ key: 'voice',      label: 'Voice'      },
];

const RENDERERS = {
	animations: renderAnimations,
	memory:     renderMemory,
	strategy:   renderStrategy,
	voice:      renderVoice,
};

function readTab() {
	const m = /(?:^|[#&])tab=([a-z]+)/.exec(location.hash || '');
	const t = m?.[1];
	return TABS.some((x) => x.key === t) ? t : 'animations';
}

function writeTab(tab) {
	const hash = `#tab=${tab}`;
	if (location.hash !== hash) history.replaceState(null, '', hash);
}

(async function boot() {
	const main = await mountShell();
	const me = await requireUser();
	if (!me) return;

	main.innerHTML = `
		<h1 class="dn-h1">Library</h1>
		<p class="dn-h1-sub">Animations, memories, strategy notes, and voices your agents can draw on.</p>

		<div class="lib-tabstrip" role="tablist" aria-label="Library sections">
			${TABS.map((t) => `
				<button
					class="dn-tag lib-tab"
					role="tab"
					data-tab="${t.key}"
					aria-controls="tab-body"
					id="tab-${t.key}"
					type="button"
				>${esc(t.label)}</button>
			`).join('')}
		</div>

		<div data-slot="tab-body" id="tab-body" role="tabpanel" aria-labelledby="tab-animations"></div>

		<style>
			.lib-tabstrip {
				position: sticky;
				top: 0;
				z-index: 5;
				display: flex;
				gap: 8px;
				flex-wrap: wrap;
				padding: 12px 0 14px;
				margin-bottom: 6px;
				background: linear-gradient(to bottom, var(--nxt-bg-0) 70%, transparent);
			}
			.lib-tab {
				cursor: pointer;
				border: 1px solid var(--nxt-border, rgba(255,255,255,0.08));
				background: rgba(255,255,255,0.02);
				color: var(--nxt-ink-dim);
				padding: 7px 14px;
				font-size: 13px;
				font-weight: 500;
				border-radius: 999px;
				transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
			}
			.lib-tab:hover { color: var(--nxt-ink); border-color: rgba(255,255,255,0.16); }
			.lib-tab[aria-selected="true"] {
				background: rgba(106, 220, 142, 0.16);
				color: #b3f0c5;
				border-color: rgba(106, 220, 142, 0.45);
			}
			.lib-tabstrip + [data-slot="tab-body"] { min-height: 60vh; }
			.lib-loading {
				display: grid;
				gap: 10px;
				padding: 8px 0;
			}
		</style>
	`;

	const body = main.querySelector('[data-slot="tab-body"]');
	const tabBtns = Array.from(main.querySelectorAll('.lib-tab'));

	function activate(tab) {
		writeTab(tab);
		body.id = 'tab-body';
		body.setAttribute('aria-labelledby', `tab-${tab}`);
		tabBtns.forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false'));
		body.innerHTML = `
			<div class="lib-loading">
				<div class="dn-skeleton" style="height:48px;width:60%;border-radius:8px"></div>
				<div class="dn-skeleton" style="height:140px;border-radius:10px"></div>
				<div class="dn-skeleton" style="height:140px;border-radius:10px"></div>
			</div>
		`;
		const render = RENDERERS[tab];
		Promise.resolve()
			.then(() => render(body, { me }))
			.catch((err) => {
				body.innerHTML = `
					<div class="dn-empty">
						<h3>Couldn’t load this tab</h3>
						<p>${esc(err.message || String(err))}</p>
					</div>
				`;
			});
	}

	tabBtns.forEach((b) => b.addEventListener('click', () => activate(b.dataset.tab)));
	window.addEventListener('hashchange', () => activate(readTab()));

	activate(readTab());
})();
