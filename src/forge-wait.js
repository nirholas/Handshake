// Forge — "while it forges" tips (browser client).
//
// While a generation runs, forge.js shows the honest step/progress panel
// (#state-generating). This module adds a quiet, rotating craft tip beneath it,
// so the 10-60s wait teaches instead of just ticking. It is fully decoupled:
// there is no "generation started" event, so it watches the panel's own
// is-hidden class and starts/stops the rotation from that. It never touches the
// progress UI and never fakes progress — it only rotates real, curated content.
//
// Motion-safe: under prefers-reduced-motion it shows a single static tip with no
// timer and no crossfade.

import { FORGE_TIPS, tipOrder } from './shared/forge-tips.js';

const panel = document.getElementById('state-generating');
if (panel && FORGE_TIPS.length) {
	const steps = panel.querySelector('.gen-steps') || panel;
	const anchor = steps.querySelector('.gen-leave-hint');

	const STYLE_ID = 'forge-wait-styles';
	if (!document.getElementById(STYLE_ID)) {
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = `
.forge-wait{margin-top:var(--space-sm);padding:var(--space-sm) var(--space-md);
	background:var(--surface-2);border:1px solid var(--stroke);
	border-radius:var(--radius-md);}
.forge-wait-eyebrow{display:block;font-family:var(--font-mono);font-size:var(--text-2xs);
	letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin-bottom:var(--space-2xs);}
.forge-wait-body{transition:opacity .32s ease;}
.forge-wait-body.is-swapping{opacity:0;}
.forge-wait-tip{margin:0;font-size:var(--text-sm);line-height:var(--leading-normal);color:var(--ink);}
.forge-wait-example{margin:var(--space-2xs) 0 0;font-family:var(--font-mono);
	font-size:var(--text-2xs);color:var(--ink-dim);}
@media (prefers-reduced-motion:reduce){.forge-wait-body{transition:none;}}`;
		document.head.appendChild(style);
	}

	const card = document.createElement('div');
	card.className = 'forge-wait';
	card.setAttribute('aria-live', 'polite');
	card.innerHTML =
		'<span class="forge-wait-eyebrow">// while it forges</span>' +
		'<div class="forge-wait-body"><p class="forge-wait-tip"></p>' +
		'<p class="forge-wait-example" hidden></p></div>';
	if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(card, anchor);
	else steps.appendChild(card);

	const body = card.querySelector('.forge-wait-body');
	const tipEl = card.querySelector('.forge-wait-tip');
	const exEl = card.querySelector('.forge-wait-example');

	const reduceMotion =
		typeof window.matchMedia === 'function' &&
		window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	const ROTATE_MS = 7000;
	let order = tipOrder();
	let pos = 0;
	let timer = null;

	function paint(i) {
		const t = FORGE_TIPS[i];
		tipEl.textContent = t.tip;
		if (t.example) {
			exEl.textContent = `Try: “${t.example}”`;
			exEl.hidden = false;
		} else {
			exEl.textContent = '';
			exEl.hidden = true;
		}
	}

	function advance() {
		pos = (pos + 1) % order.length;
		if (reduceMotion) {
			paint(order[pos]);
			return;
		}
		body.classList.add('is-swapping');
		setTimeout(() => {
			paint(order[pos]);
			body.classList.remove('is-swapping');
		}, 320);
	}

	function start() {
		// Fresh order each run so a repeat generation does not open on the same tip.
		order = tipOrder();
		pos = 0;
		paint(order[0]);
		if (timer) clearInterval(timer);
		if (!reduceMotion) timer = setInterval(advance, ROTATE_MS);
	}

	function stop() {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}

	const isVisible = () => !panel.classList.contains('is-hidden');

	// No "generation started" event exists; the panel toggling is-hidden is the
	// signal. Watch it and start/stop the rotation to match.
	const observer = new MutationObserver(() => {
		if (isVisible()) {
			if (!timer) start();
		} else {
			stop();
		}
	});
	observer.observe(panel, { attributes: true, attributeFilter: ['class'] });

	// Handle the case where a generation is already running at load time.
	if (isVisible()) start();
	else paint(order[0]);
}
