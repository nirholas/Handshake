// Forge: "More like this" (browser client).
//
// After a text→3D result lands, forge.js dispatches `forge:model-ready` with the
// prompt that produced it (as `label`). This module reads that prompt and offers
// a compact row of one-tap variations that keep the same subject but restyle its
// material or finish (see ./shared/forge-variations.js). Tapping a chip fires
// `forge:run-prompt`, which forge.js turns into an immediate generation using the
// exact same path as the example chips, so exploring a design space is a single
// tap, with no retyping.
//
// Fully decoupled: no imports from forge.js, no changes to its state. It only
// listens for the public event, reads the public `#prompt`/`#tab-text` elements,
// and dispatches a public event back. Degrades to nothing when the result did
// not come from a text prompt (e.g. photo or sketch mode).

import { deriveVariations } from './shared/forge-variations.js';

const result = document.getElementById('state-result');
if (result) {
	const STYLE_ID = 'mlt-styles';
	if (!document.getElementById(STYLE_ID)) {
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = `
.mlt{display:flex;align-items:center;gap:var(--space-xs);flex-wrap:wrap;
	margin-top:var(--space-sm);padding-top:var(--space-sm);
	border-top:1px solid var(--stroke);animation:mlt-in .38s ease both;}
.mlt-label{font-size:var(--text-2xs);letter-spacing:.09em;text-transform:uppercase;
	color:var(--ink-dim);font-family:var(--font-mono);margin-right:var(--space-3xs);}
.mlt-chip{display:inline-flex;align-items:center;gap:var(--space-2xs);
	font-family:var(--font-body);font-size:var(--text-sm);color:var(--ink);
	background:var(--surface-2);border:1px solid var(--stroke);
	border-radius:var(--radius-pill);padding:var(--space-xs) var(--space-sm);
	min-height:32px;cursor:pointer;transition:background .15s ease,border-color .15s ease,transform .15s ease;}
.mlt-chip:hover{background:var(--surface-3);border-color:var(--stroke-strong);transform:translateY(-1px);}
.mlt-chip:active{transform:translateY(0);}
.mlt-chip:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
.mlt-dot{width:10px;height:10px;border-radius:var(--radius-pill);
	background:var(--dot,#888);box-shadow:0 0 0 1px rgba(255,255,255,.14) inset;flex:none;}
.mlt-reshuffle{display:inline-flex;align-items:center;justify-content:center;
	width:32px;height:32px;color:var(--ink-dim);background:transparent;
	border:1px solid var(--stroke);border-radius:var(--radius-pill);cursor:pointer;
	transition:color .15s ease,border-color .15s ease,transform .3s ease;}
.mlt-reshuffle:hover{color:var(--ink);border-color:var(--stroke-strong);}
.mlt-reshuffle:active{transform:rotate(180deg);}
.mlt-reshuffle:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
@keyframes mlt-in{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:none;}}
@media (prefers-reduced-motion:reduce){
	.mlt{animation:none;}
	.mlt-chip,.mlt-reshuffle{transition:none;}
	.mlt-reshuffle:active{transform:none;}
}`;
		document.head.appendChild(style);
	}

	// Build the row's DOM once and insert it just under the result action bar,
	// above the deeper tool panels (stylize/optimize).
	const row = document.createElement('div');
	row.className = 'mlt is-hidden';
	// role="group" so the aria-label is actually exposed (a label on a bare div is
	// ignored by assistive tech).
	row.setAttribute('role', 'group');
	row.setAttribute('aria-label', 'Generate a variation of this model');
	row.hidden = true;

	const bar = result.querySelector('.result-bar');
	if (bar && bar.parentNode) bar.parentNode.insertBefore(row, bar.nextSibling);
	else result.appendChild(row);

	let currentPrompt = '';

	function isTextMode() {
		const tab = document.getElementById('tab-text');
		// Default to true when the tab is absent, but require it to be selected
		// when present, so photo/sketch results don't offer material restyles.
		return !tab || tab.getAttribute('aria-selected') === 'true';
	}

	function pickVariation(prompt) {
		document.dispatchEvent(new CustomEvent('forge:run-prompt', { detail: { prompt } }));
	}

	function renderChips() {
		const variations = deriveVariations(currentPrompt, { count: 3 });
		if (!variations.length) {
			row.hidden = true;
			row.classList.add('is-hidden');
			return;
		}
		row.innerHTML = '';

		const label = document.createElement('span');
		label.className = 'mlt-label';
		label.textContent = 'More like this';
		row.appendChild(label);

		for (const v of variations) {
			const chip = document.createElement('button');
			chip.type = 'button';
			chip.className = 'mlt-chip';
			chip.title = v.prompt;
			// The visible label is just the material ("Brass"); give assistive tech
			// the action context so tabbing onto it is self-explanatory.
			chip.setAttribute('aria-label', `Re-forge in ${v.label}`);
			chip.innerHTML =
				`<span class="mlt-dot" style="--dot:${v.swatch}" aria-hidden="true"></span>` +
				`<span class="mlt-text"></span>`;
			chip.querySelector('.mlt-text').textContent = v.label;
			chip.addEventListener('click', () => pickVariation(v.prompt));
			row.appendChild(chip);
		}

		const reshuffle = document.createElement('button');
		reshuffle.type = 'button';
		reshuffle.className = 'mlt-reshuffle';
		reshuffle.setAttribute('aria-label', 'Show different variations');
		reshuffle.title = 'Show different variations';
		reshuffle.textContent = '↻';
		reshuffle.addEventListener('click', renderChips);
		row.appendChild(reshuffle);

		row.hidden = false;
		row.classList.remove('is-hidden');
		// Restart the entrance animation on each refresh.
		row.style.animation = 'none';
		void row.offsetWidth;
		row.style.animation = '';
	}

	document.addEventListener('forge:model-ready', (e) => {
		const label = typeof e.detail?.label === 'string' ? e.detail.label.trim() : '';
		if (!label || !isTextMode()) {
			currentPrompt = '';
			row.hidden = true;
			row.classList.add('is-hidden');
			return;
		}
		currentPrompt = label;
		renderChips();
	});
}
