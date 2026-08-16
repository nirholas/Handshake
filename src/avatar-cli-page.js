/**
 * /avatar-cli page runtime.
 *
 * Three jobs: replay a real `three-ws-avatar` session in the hero terminal,
 * wire the copy buttons, and drive the live viewer through loading → ready or
 * failed so the section never sits as an empty rectangle.
 *
 * The transcript below is a verbatim capture of the CLI at 0.2.1, not a
 * dramatization. If the CLI's output changes, this should be recaptured.
 */

const PROMPT = '$ ';

/** One terminal line. `kind` maps to a class in avatar-cli.css. */
const TRANSCRIPT = [
	{ kind: 'cmd', text: 'npm install -g @three-ws/avatar-cli' },
	{ kind: 'out', cls: 'dim', text: 'added 2 packages in 1s' },
	{ kind: 'gap' },
	{ kind: 'cmd', text: 'curl -sLO https://three.ws/avatars/michelle.glb' },
	{ kind: 'gap' },
	{
		kind: 'cmd',
		text: 'three-ws-avatar init --owner eip155:1:0x742d35Cc… \\\n    --name "Nicholas" --mesh ./michelle.glb --skeleton mixamo \\\n    --mesh-uri https://three.ws/avatars/michelle.glb --out manifest.json',
	},
	{ kind: 'out', cls: 'ok', text: '✔ wrote /home/you/manifest.json' },
	{ kind: 'out', cls: 'dim', text: '  • id        eip155:1:0x742d35Cc6634C0532925a3b844Bc454e4438f44e' },
	{ kind: 'out', cls: 'dim', text: '  • skeleton  mixamo' },
	{ kind: 'out', cls: 'dim', text: '  • mesh      glb · 830 kB · sha256:28d788538f7b…' },
	{ kind: 'out', cls: 'dim', text: '  › next: three-ws-avatar preview manifest.json' },
	{ kind: 'gap' },
	{ kind: 'cmd', text: 'three-ws-avatar validate manifest.json' },
	{ kind: 'out', cls: 'ok', text: '✔ manifest.json is valid' },
	{ kind: 'gap' },
	{ kind: 'cmd', text: 'three-ws-avatar preview manifest.json' },
	{ kind: 'out', cls: 'c', text: 'Nicholas (eip155:1:0x742d35Cc6634C0532925a3b844Bc454e4438f44e)' },
	{ kind: 'gap' },
	{ kind: 'out', cls: 'dim', text: '› resolver url' },
	{ kind: 'out', text: 'https://three.ws/a/eip155%3A1%3A0x742d35Cc6634C0532925a3b844Bc454e4438f44e' },
	{ kind: 'gap' },
	{ kind: 'out', cls: 'dim', text: '› web component (loader registers <agent-3d>)' },
	{ kind: 'out', text: '<script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>' },
	{
		kind: 'out',
		text: '<agent-3d src="https://three.ws/avatars/michelle.glb" style="width:400px;height:600px"></agent-3d>',
	},
];

const escapeHtml = (s) =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const prefersReducedMotion = () =>
	window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * Keyboard hint for the clipboard fallback. Naming the wrong modifier is worse
 * than naming none, so this reads the platform rather than assuming a Mac.
 */
function copyShortcut() {
	const platform = navigator.userAgentData?.platform || navigator.platform || '';
	return /mac|iphone|ipad|ipod/i.test(platform) ? '⌘C' : 'Ctrl+C';
}

/** Full transcript as static markup, for reduced motion and for replay resets. */
function renderStatic() {
	return TRANSCRIPT.map((line) => {
		if (line.kind === 'gap') return '';
		if (line.kind === 'cmd') {
			return `<span class="p">${PROMPT}</span><span class="c">${escapeHtml(line.text)}</span>`;
		}
		const cls = line.cls ? ` class="${line.cls}"` : '';
		return `<span${cls}>${escapeHtml(line.text)}</span>`;
	}).join('\n');
}

/**
 * Type the transcript out. Commands type character by character; output lines
 * appear whole, the way a real command's output does.
 */
function playTranscript(el, signal) {
	const sleep = (ms) =>
		new Promise((resolve, reject) => {
			const t = setTimeout(resolve, ms);
			signal.addEventListener(
				'abort',
				() => {
					clearTimeout(t);
					reject(new DOMException('aborted', 'AbortError'));
				},
				{ once: true },
			);
		});

	return (async () => {
		// The transcript is real text a screen reader can read, so mark it busy
		// while it is still being written rather than while it is half a line.
		el.setAttribute('aria-busy', 'true');
		el.innerHTML = '';
		let html = '';

		for (const line of TRANSCRIPT) {
			if (signal.aborted) return;

			if (line.kind === 'gap') {
				html += '\n';
				el.innerHTML = html;
				await sleep(160);
				continue;
			}

			if (line.kind === 'cmd') {
				html += `<span class="p">${PROMPT}</span>`;
				let typed = '';
				for (const ch of line.text) {
					typed += ch;
					el.innerHTML = `${html}<span class="c">${escapeHtml(typed)}</span><span class="cli-caret"></span>`;
					el.scrollTop = el.scrollHeight;
					await sleep(ch === '\n' ? 90 : 14);
				}
				html += `<span class="c">${escapeHtml(line.text)}</span>\n`;
				el.innerHTML = html;
				await sleep(280);
				continue;
			}

			const cls = line.cls ? ` class="${line.cls}"` : '';
			html += `<span${cls}>${escapeHtml(line.text)}</span>\n`;
			el.innerHTML = html;
			el.scrollTop = el.scrollHeight;
			await sleep(90);
		}

		el.innerHTML = `${html}<span class="p">${PROMPT}</span><span class="cli-caret"></span>`;
		el.scrollTop = el.scrollHeight;
		el.removeAttribute('aria-busy');
	})().catch((err) => {
		if (err?.name !== 'AbortError') throw err;
	});
}

function initTerminal() {
	const body = document.getElementById('cli-term-body');
	const replay = document.querySelector('.cli-term-replay');
	if (!body) return;

	if (prefersReducedMotion()) {
		body.innerHTML = renderStatic();
		replay?.setAttribute('hidden', '');
		return;
	}

	let controller = null;
	const start = () => {
		controller?.abort();
		controller = new AbortController();
		playTranscript(body, controller.signal);
	};

	// Only start once the terminal is actually on screen, so the animation is
	// not already finished by the time someone scrolls to it.
	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting) {
					start();
					observer.disconnect();
				}
			}
		},
		{ threshold: 0.25 },
	);
	observer.observe(body);

	replay?.addEventListener('click', start);
}

function initCopyButtons() {
	for (const btn of document.querySelectorAll('[data-copy-target]')) {
		btn.addEventListener('click', async () => {
			const target = document.getElementById(btn.dataset.copyTarget);
			if (!target) return;
			const label = btn.querySelector('.cli-copy-label');
			const original = label?.textContent ?? '';
			try {
				await navigator.clipboard.writeText(target.textContent.trim());
				btn.dataset.copied = 'true';
				if (label) label.textContent = 'Copied';
			} catch {
				// Clipboard is unavailable over plain http or when permission is
				// denied. Select the text so the copy is still one keystroke away.
				const range = document.createRange();
				range.selectNodeContents(target);
				const sel = window.getSelection();
				sel?.removeAllRanges();
				sel?.addRange(range);
				if (label) label.textContent = `Press ${copyShortcut()}`;
			}
			setTimeout(() => {
				delete btn.dataset.copied;
				if (label) label.textContent = original;
			}, 1800);
		});
	}
}

/**
 * The live viewer proves the emitted snippet works, so its failure has to be
 * visible rather than silent. Ready means the element upgraded and built a
 * canvas; failed means the loader never registered it.
 */
function initLiveStage() {
	const stage = document.getElementById('live-stage');
	if (!stage) return;
	const el = stage.querySelector('agent-3d');
	if (!el) return;

	const deadline = Date.now() + 15000;

	const poll = () => {
		const upgraded = Boolean(customElements.get('agent-3d'));
		const painted = Boolean(el.shadowRoot?.querySelector('canvas'));

		if (upgraded && painted) {
			stage.dataset.state = 'ready';
			return;
		}
		if (Date.now() > deadline) {
			stage.dataset.state = 'failed';
			return;
		}
		setTimeout(poll, 250);
	};

	poll();
}

function initReveal() {
	const targets = document.querySelectorAll('.cli-section-head, .cli-cmd-card, .cli-gate, .cli-next-card');
	if (prefersReducedMotion()) return;

	for (const node of targets) node.classList.add('cli-reveal');

	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				entry.target.classList.add('is-in');
				observer.unobserve(entry.target);
			}
		},
		{ rootMargin: '0px 0px -8% 0px', threshold: 0.1 },
	);

	for (const node of targets) observer.observe(node);
}

function boot() {
	initTerminal();
	initCopyButtons();
	initLiveStage();
	initReveal();
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
	boot();
}
