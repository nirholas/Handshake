// /tty — the live panel that proves the claim on the page.
//
// It opens the same HTTP stream `curl three.ws/tty` opens and paints what comes
// back. Nothing is pre-rendered and nothing is faked: if the endpoint breaks,
// this panel breaks with it, which is the point of showing it.
//
// The parser handles exactly the subset of ANSI the renderer emits (SGR colour,
// cursor-up, cursor visibility). A general terminal emulator would be a large
// dependency to prove a small claim.

const ESC = '\x1b';

const screen = document.getElementById('screen');
const statusEl = document.getElementById('stream-status');
const playBtn = document.getElementById('btn-play');
const spinBtn = document.getElementById('btn-spin');
const colorBtn = document.getElementById('btn-color');

/** xterm-256 to rgb: 16 base colours, a 6x6x6 cube, then a 24-step grey ramp. */
const BASE_16 = [
	[0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16],
	[36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
	[102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67],
	[59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255],
];
const CUBE_STEPS = [0, 95, 135, 175, 215, 255];

function ansi256ToRgb(index) {
	if (index < 16) return BASE_16[index];
	if (index < 232) {
		const n = index - 16;
		return [CUBE_STEPS[Math.floor(n / 36) % 6], CUBE_STEPS[Math.floor(n / 6) % 6], CUBE_STEPS[n % 6]];
	}
	const v = 8 + (index - 232) * 10;
	return [v, v, v];
}

const rgbCss = ([r, g, b]) => `rgb(${r},${g},${b})`;

/**
 * Turn one frame of SGR-coloured text into HTML.
 *
 * Cells are coalesced into a span per colour run, matching how the renderer
 * emits escapes only on change. A span per character would be ~2000 nodes per
 * frame and would drop the frame rate on its own.
 */
function frameToHtml(text) {
	let html = '';
	let fg = null;
	let bg = null;
	let open = false;
	let buffer = '';

	const flush = () => {
		if (!buffer) return;
		const safe = buffer.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		if (fg || bg) {
			const style = `${fg ? `color:${rgbCss(fg)};` : ''}${bg ? `background:${rgbCss(bg)};` : ''}`;
			html += `<span style="${style}">${safe}</span>`;
		} else {
			html += safe;
		}
		buffer = '';
	};

	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (ch !== ESC) {
			buffer += ch;
			open = true;
			continue;
		}
		const match = /^\x1b\[([0-9;]*)m/.exec(text.slice(i));
		if (!match) {
			// Any other CSI sequence (cursor moves, visibility) is consumed and
			// ignored: the panel redraws whole frames, so cursor motion is noise.
			const skip = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(text.slice(i));
			i += (skip ? skip[0].length : 1) - 1;
			continue;
		}
		flush();
		const params = match[1].split(';').filter((p) => p !== '');
		if (!params.length || params[0] === '0') { fg = null; bg = null; }
		for (let p = 0; p < params.length; p += 1) {
			if (params[p] === '38' && params[p + 1] === '5') { fg = ansi256ToRgb(Number(params[p + 2])); p += 2; }
			else if (params[p] === '48' && params[p + 1] === '5') { bg = ansi256ToRgb(Number(params[p + 2])); p += 2; }
			else if (params[p] === '38' && params[p + 1] === '2') { fg = [+params[p + 2], +params[p + 3], +params[p + 4]]; p += 4; }
			else if (params[p] === '48' && params[p + 1] === '2') { bg = [+params[p + 2], +params[p + 3], +params[p + 4]]; p += 4; }
		}
		i += match[0].length - 1;
	}
	flush();
	return open ? html : '';
}

const state = { spin: true, color: true, controller: null, running: false };

function setStatus(text) {
	if (statusEl) statusEl.textContent = text;
}

function rowsForViewport() {
	return window.innerWidth < 720 ? 26 : 30;
}

function colsForViewport() {
	if (!screen) return 76;
	// Measure one monospace character rather than assuming a ratio: font size is
	// set in CSS and changes at the mobile breakpoint.
	const probe = document.createElement('span');
	probe.textContent = '0'.repeat(50);
	probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
	screen.appendChild(probe);
	const charWidth = probe.getBoundingClientRect().width / 50;
	probe.remove();
	const usable = screen.clientWidth - 28;
	if (!charWidth || !usable) return 76;
	return Math.max(30, Math.min(140, Math.floor(usable / charWidth)));
}

function stop() {
	if (state.controller) state.controller.abort();
	state.controller = null;
	state.running = false;
	if (playBtn) playBtn.textContent = 'Run it';
	setStatus('stopped');
}

async function run() {
	stop();
	const controller = new AbortController();
	state.controller = controller;
	state.running = true;
	if (playBtn) playBtn.textContent = 'Stop';
	setStatus('connecting');

	const params = new URLSearchParams({
		w: String(colsForViewport()),
		h: String(rowsForViewport()),
		fps: '16',
		frames: '400',
		spin: state.spin ? '0.9' : '0',
		color: state.color ? 'ansi256' : 'mono',
	});
	// Landing here from /tty/<id> in a browser carries the avatar through, so the
	// panel shows the model the visitor actually asked for rather than the default.
	const asked = new URLSearchParams(location.search).get('avatar');
	if (asked) params.set('avatar', asked);

	try {
		const res = await fetch(`/api/tty?${params}`, { signal: controller.signal });
		if (!res.ok || !res.body) throw new Error(`stream unavailable (${res.status})`);
		setStatus('streaming');

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let pending = '';

		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			pending += decoder.decode(value, { stream: true });
			// Frames are separated by the cursor-up sequence the renderer writes
			// before each one. Keep only the last complete frame in the buffer: if
			// the tab was backgrounded and frames piled up, catching up beats
			// replaying a queue in fast-forward.
			const parts = pending.split(/\x1b\[\d+A/);
			if (parts.length > 1) {
				const latest = parts[parts.length - 2];
				pending = parts[parts.length - 1];
				const html = frameToHtml(latest);
				if (html) screen.innerHTML = html;
			}
		}
		setStatus('done');
	} catch (err) {
		if (err.name === 'AbortError') return;
		setStatus('unavailable');
		screen.textContent = `Could not reach the render stream: ${err.message}\n\nThe command still works from a terminal:\n\n  $ curl three.ws/tty`;
	} finally {
		if (state.controller === controller) {
			state.controller = null;
			state.running = false;
			if (playBtn) playBtn.textContent = 'Run it';
		}
	}
}

if (playBtn) {
	playBtn.addEventListener('click', () => (state.running ? stop() : run()));
}
if (spinBtn) {
	spinBtn.addEventListener('click', () => {
		state.spin = !state.spin;
		spinBtn.setAttribute('aria-pressed', String(state.spin));
		if (state.running) run();
	});
}
if (colorBtn) {
	colorBtn.addEventListener('click', () => {
		state.color = !state.color;
		colorBtn.setAttribute('aria-pressed', String(state.color));
		if (state.running) run();
	});
}

for (const button of document.querySelectorAll('[data-copy-target]')) {
	button.addEventListener('click', async () => {
		const source = document.getElementById(button.dataset.copyTarget);
		if (!source) return;
		try {
			await navigator.clipboard.writeText(source.textContent.trim());
			button.textContent = 'Copied';
			button.dataset.copied = 'true';
			setTimeout(() => {
				button.textContent = 'Copy';
				delete button.dataset.copied;
			}, 1600);
		} catch {
			// Clipboard access can be denied outright. Selecting the text is a real
			// fallback, not a message telling the user to do it themselves.
			const range = document.createRange();
			range.selectNodeContents(source);
			const selection = window.getSelection();
			selection.removeAllRanges();
			selection.addRange(range);
			button.textContent = 'Select and copy';
			setTimeout(() => { button.textContent = 'Copy'; }, 2200);
		}
	});
}

// Stop the stream when the tab is hidden. A backgrounded tab holding an open
// render stream is pure server cost for frames nobody sees.
document.addEventListener('visibilitychange', () => {
	if (document.hidden && state.running) stop();
});

window.addEventListener('beforeunload', stop);

// Autoplay only where it is cheap and wanted: a real pointer, a wide viewport,
// and no reduced-motion preference.
const wantsMotion = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (wantsMotion && window.innerWidth >= 720) {
	run();
} else {
	setStatus('press run');
	screen.textContent = '  $ curl three.ws/tty';
}
