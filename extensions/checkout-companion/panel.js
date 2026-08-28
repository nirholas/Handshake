// The panel: what the companion looks like on someone else's checkout page.
//
// Every design decision here is about not being the thing that ruins a
// purchase. It is anchored, not floating over the pay button. It never takes
// focus, never traps the keyboard, and never blocks a click. It opens collapsed
// to a single line when there is nothing alarming and expands itself only when
// there is a red flag, which is the one case where an interruption is earned.
//
// It is built in a shadow root so a merchant's stylesheet cannot restyle it and
// ours cannot leak onto their page. panel.css styles only the host element.

const SEVERITY_LABEL = { flag: 'Worth checking', notice: 'Good to know', info: 'For reference' };

export function mount({ speak = true } = {}) {
	const host = document.createElement('div');
	host.className = 'threews-checkout-companion';
	host.setAttribute('role', 'complementary');
	host.setAttribute('aria-label', 'three.ws checkout companion');
	const root = host.attachShadow({ mode: 'open' });
	root.innerHTML = template();
	document.body.appendChild(host);

	const $ = (sel) => root.querySelector(sel);
	const card = $('.card');
	const body = $('.body');
	const status = $('.status');
	const toggle = $('.toggle');

	let expanded = false;
	const setExpanded = (next) => {
		expanded = next;
		card.classList.toggle('expanded', expanded);
		toggle.setAttribute('aria-expanded', String(expanded));
		toggle.title = expanded ? 'Collapse' : 'Expand';
	};

	toggle.addEventListener('click', () => setExpanded(!expanded));
	$('.close').addEventListener('click', () => host.remove());
	// Escape closes it, and only when the panel itself has focus: a checkout
	// form uses Escape for its own dialogs and we do not get to steal that.
	root.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') host.remove();
	});

	const api = {
		setState(state, data) {
			card.dataset.state = state;
			if (state === 'reading') {
				status.textContent = 'Reading this page…';
				body.innerHTML = '<p class="muted">Checking the total, the terms, and anything that repeats.</p>';
				return;
			}
			if (state === 'error') {
				status.textContent = 'Could not read this page';
				body.innerHTML = `<p class="muted">${escapeHtml(data?.message || 'The read did not complete.')}</p>${
					data?.code === 'unauthorized'
						? '<p class="muted">Open the extension and connect your three.ws account.</p>'
						: ''
				}`;
				setExpanded(true);
				return;
			}
			render(data);
		},
		destroy() {
			host.remove();
		},
	};

	function render(result) {
		const findings = result?.findings || [];
		const flags = findings.filter((f) => f.severity === 'flag');

		if (!findings.length) {
			status.textContent = 'Nothing unusual on this page';
			body.innerHTML = [
				'<p class="muted">The total matches what you were shown and the page does not describe a repeating charge.</p>',
				redactionNote(result),
			].join('');
			setExpanded(false);
			return;
		}

		status.textContent = flags.length
			? `${flags.length} thing${flags.length === 1 ? '' : 's'} worth checking`
			: `${findings.length} note${findings.length === 1 ? '' : 's'} on this page`;

		body.innerHTML = [
			`<ul class="findings">${findings.map(findingHtml).join('')}</ul>`,
			result.reading_status === 'unavailable'
				? '<p class="muted">The terms were not read this time, so only the amounts were checked.</p>'
				: '',
			redactionNote(result),
		].join('');

		// Expand on a red flag, stay out of the way otherwise. This is the whole
		// interruption policy and it is one line on purpose.
		setExpanded(flags.length > 0);

		if (speak && result.spoken) say(result.spoken);
	}

	function say(line) {
		try {
			if (!('speechSynthesis' in window)) return;
			const utterance = new SpeechSynthesisUtterance(line);
			utterance.rate = 1.02;
			utterance.volume = 0.9;
			window.speechSynthesis.speak(utterance);
		} catch {
			// A tab that refuses speech still shows the panel. The text is the
			// product; the voice is the flourish.
		}
	}

	return api;
}

function findingHtml(f) {
	return [
		`<li class="finding ${escapeHtml(f.severity)}">`,
		`<span class="badge">${escapeHtml(SEVERITY_LABEL[f.severity] || 'Note')}</span>`,
		`<strong>${escapeHtml(f.title)}</strong>`,
		`<p>${escapeHtml(f.detail || '')}</p>`,
		f.evidence ? `<blockquote>${escapeHtml(f.evidence)}</blockquote>` : '',
		'</li>',
	].join('');
}

function redactionNote(result) {
	const n = result?.redactions || 0;
	return `<p class="privacy">${
		n
			? `${n} piece${n === 1 ? '' : 's'} of personal data removed before this page was read.`
			: 'No card, contact, or account details were found in the text read.'
	} Nothing about this page is stored.</p>`;
}

function escapeHtml(value) {
	return String(value ?? '').replace(/[&<>"']/g, (c) => ({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#39;',
	})[c]);
}

function template() {
	return `
<style>
	:host { all: initial; }
	*, *::before, *::after { box-sizing: border-box; }
	.card {
		/* The host is pointer-transparent so the panel can never sit between a
		   person and the button they came to press; the card takes events back
		   for itself only. */
		pointer-events: auto;
		font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
		width: 340px;
		max-width: calc(100vw - 32px);
		background: #ffffff;
		color: #14161a;
		border: 1px solid rgba(16, 18, 22, 0.12);
		border-radius: 14px;
		box-shadow: 0 18px 48px rgba(12, 14, 18, 0.18);
		overflow: hidden;
		transform: translateY(8px);
		opacity: 0;
		animation: rise 260ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
	}
	@keyframes rise { to { transform: translateY(0); opacity: 1; } }
	@media (prefers-reduced-motion: reduce) {
		.card { animation: none; opacity: 1; transform: none; }
	}
	header {
		display: flex; align-items: center; gap: 10px;
		padding: 12px 12px 12px 14px;
		border-bottom: 1px solid rgba(16, 18, 22, 0.08);
	}
	.dot {
		width: 26px; height: 26px; border-radius: 50%; flex: none;
		background: linear-gradient(140deg, #6d5cff, #21d4c2);
	}
	.status { font-weight: 600; flex: 1; min-width: 0; }
	button {
		font: inherit; border: 0; background: transparent; cursor: pointer;
		color: #5b616e; border-radius: 8px; width: 28px; height: 28px; flex: none;
		transition: background 120ms ease, color 120ms ease;
	}
	button:hover { background: rgba(16, 18, 22, 0.06); color: #14161a; }
	button:focus-visible { outline: 2px solid #6d5cff; outline-offset: 2px; }
	.body { display: none; padding: 4px 14px 14px; }
	.card.expanded .body { display: block; }
	.toggle svg { transition: transform 160ms ease; }
	.card.expanded .toggle svg { transform: rotate(180deg); }
	ul.findings { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 12px; }
	.finding { border-left: 3px solid #c9ccd4; padding-left: 10px; }
	.finding.flag { border-left-color: #e0483c; }
	.finding.notice { border-left-color: #e0a03c; }
	.finding strong { display: block; margin-top: 2px; }
	.finding p { margin: 4px 0 0; color: #3d434f; }
	.badge {
		font-size: 11px; font-weight: 600; letter-spacing: 0.02em;
		text-transform: uppercase; color: #6b7280;
	}
	.finding.flag .badge { color: #c23a2f; }
	blockquote {
		margin: 6px 0 0; padding: 6px 8px; font-size: 12.5px; color: #4b5160;
		background: rgba(16, 18, 22, 0.04); border-radius: 6px;
	}
	.muted { color: #5b616e; margin: 8px 0 0; }
	.privacy { font-size: 12px; color: #6b7280; margin: 12px 0 0; }
	@media (prefers-color-scheme: dark) {
		.card { background: #16181d; color: #edeff3; border-color: rgba(255,255,255,0.12); }
		header { border-bottom-color: rgba(255,255,255,0.08); }
		button { color: #9aa1ae; }
		button:hover { background: rgba(255,255,255,0.08); color: #edeff3; }
		.finding p { color: #b9bfca; }
		.muted, .privacy, .badge { color: #9aa1ae; }
		blockquote { background: rgba(255,255,255,0.06); color: #c3c9d4; }
	}
</style>
<div class="card" data-state="reading">
	<header>
		<div class="dot" aria-hidden="true"></div>
		<span class="status">Reading this page…</span>
		<button class="toggle" aria-expanded="false" title="Expand" aria-label="Expand findings">
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
				<path d="M3 5.5 7 9.5 11 5.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
			</svg>
		</button>
		<button class="close" title="Dismiss" aria-label="Dismiss">
			<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
				<path d="M2.5 2.5l7 7m0-7l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
			</svg>
		</button>
	</header>
	<div class="body"></div>
</div>`;
}
