// The Sign API console: /api/sign, made watchable.
//
// An API that returns an animation is hard to believe from a JSON blob. This
// console calls the real endpoint (no fixtures, no local compile) and draws what
// came back as the thing it actually is: a performance on a timeline. Every word
// is a block sized by the seconds it occupies, signed blocks and fingerspelled
// blocks read differently, a spelled block shows its letters, and pressing play
// sweeps a playhead across it in lockstep with the avatar at the top of the page
// signing the same text.
//
// So the page teaches the endpoint twice over: developers see the request, the
// response and the copyable curl; everyone else sees why the response is shaped
// the way it is.

import { log } from './shared/log.js';

const $ = (sel, root = document) => root.querySelector(sel);

const SPEEDS = [
	{ label: '0.5×', value: 0.5 },
	{ label: '0.75×', value: 0.75 },
	{ label: '1×', value: 1 },
];

const HANDS = [
	{ label: 'Right', value: 'right' },
	{ label: 'Left', value: 'left' },
];

// Phrases that each demonstrate something different about the compiler: pure
// vocabulary, a name that can only be spelled, digits, and a mix of both.
const EXAMPLES = ['happy to meet you', 'thank you yall', 'my name is ada', 'three ws is good'];

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text != null) node.textContent = text;
	return node;
}

const fmt = (n) => `${n.toFixed(2)}s`;

/** Bytes as the unit a developer reads at a glance. */
function humanBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
	return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function curlFor({ text, hand, speed }) {
	const params = new URLSearchParams({ text });
	if (hand === 'left') params.set('hand', 'left');
	if (speed !== 1) params.set('speed', String(speed));
	return `curl -s "https://three.ws/api/sign?${params}" | jq '.timeline'`;
}

/**
 * Mount the console into `#sl-api-console`.
 *
 * @param {{
 *   sign?: (opts: { text: string, hand: string, speed: number }) => Promise<unknown>,
 *   defaults?: { hand?: string, speed?: number },
 * }} [wiring]
 *   `sign` performs the same utterance on the page's hero avatar, applying the
 *   console's hand and speed to it. Without it the console still works: it just
 *   loses the play-along, and says so instead of offering a dead button.
 */
export function initSignApiConsole({ sign = null, defaults = {} } = {}) {
	const host = $('#sl-api-console');
	if (!host) return null;

	let hand = defaults.hand === 'left' ? 'left' : 'right';
	let speed = SPEEDS.some((s) => s.value === defaults.speed) ? defaults.speed : 1;
	let last = null;
	let playFrame = 0;

	// ── controls ─────────────────────────────────────────────────────────────
	const form = el('form', 'sl-api-form');
	form.setAttribute('novalidate', '');
	const input = el('input', 'sl-input');
	input.type = 'text';
	input.id = 'sl-api-text';
	input.value = EXAMPLES[0];
	input.maxLength = 600;
	input.setAttribute('aria-label', 'Text to compile into a signed utterance');
	input.placeholder = 'text to sign';
	const submit = el('button', 'sl-btn', 'Compile');
	submit.type = 'submit';

	const row = el('div', 'sl-input-row');
	row.append(input, submit);

	const pills = (label, options, current, onPick) => {
		const wrap = el('div', 'sl-setting');
		const id = `sl-api-${label.toLowerCase().replace(/\s+/g, '-')}`;
		const caption = el('span', 'sl-setting-label', label);
		caption.id = id;
		const group = el('div', 'sl-opts');
		group.role = 'group';
		group.setAttribute('aria-labelledby', id);
		for (const option of options) {
			const btn = el('button', 'sl-opt', option.label);
			btn.type = 'button';
			btn.setAttribute('aria-pressed', String(option.value === current));
			btn.addEventListener('click', () => {
				group.querySelectorAll('.sl-opt').forEach((b) => b.setAttribute('aria-pressed', 'false'));
				btn.setAttribute('aria-pressed', 'true');
				onPick(option.value);
			});
			group.append(btn);
		}
		wrap.append(caption, group);
		return wrap;
	};

	const settings = el('div', 'sl-settings');
	settings.append(
		pills('Hand', HANDS, hand, (v) => {
			hand = v;
		}),
		pills('Speed', SPEEDS, speed, (v) => {
			speed = v;
		}),
	);

	const examples = el('div', 'sl-chips');
	for (const phrase of EXAMPLES) {
		const chip = el('button', 'sl-phrase-chip', phrase);
		chip.type = 'button';
		chip.addEventListener('click', () => {
			input.value = phrase;
			run();
		});
		examples.append(chip);
	}

	form.append(row, settings, examples);

	// ── output ───────────────────────────────────────────────────────────────
	const out = el('div', 'sl-api-out');
	out.dataset.state = 'idle';

	const statsRow = el('dl', 'sl-api-stats');
	const timelineWrap = el('div', 'sl-api-timeline-wrap');
	const timeline = el('div', 'sl-api-timeline');
	timeline.role = 'list';
	timeline.setAttribute('aria-label', 'The compiled utterance, word by word');
	const playhead = el('div', 'sl-api-playhead');
	playhead.hidden = true;
	const ruler = el('div', 'sl-api-ruler');
	timelineWrap.append(timeline, playhead, ruler);

	const actions = el('div', 'sl-api-actions');
	const playBtn = el('button', 'sl-btn sl-btn-quiet', '▶ Play it on the avatar');
	playBtn.type = 'button';
	const copyBtn = el('button', 'sl-btn sl-btn-quiet', 'Copy curl');
	copyBtn.type = 'button';
	const openBtn = el('a', 'sl-btn sl-btn-quiet', 'Open raw JSON');
	openBtn.target = '_blank';
	openBtn.rel = 'noopener';
	actions.append(playBtn, copyBtn, openBtn);

	const note = el('p', 'sl-api-note');
	note.setAttribute('aria-live', 'polite');

	const codeWrap = el('details', 'sl-api-code');
	const codeSummary = el('summary', null, 'Request and response');
	const codeBody = el('div', 'sl-api-code-body');
	codeWrap.append(codeSummary, codeBody);

	out.append(statsRow, timelineWrap, actions, note, codeWrap);
	host.append(form, out);

	if (!sign) {
		playBtn.remove();
	}

	// ── rendering ────────────────────────────────────────────────────────────
	function renderStats(data, meta) {
		statsRow.replaceChildren();
		const stats = [
			['Duration', `${data.duration.toFixed(2)}s`],
			['Signed', String(data.signed.length)],
			['Fingerspelled', String(data.spelled.length)],
			['Clip tracks', String(data.clip?.tracks?.length ?? 0)],
			['Response', humanBytes(meta.bytes)],
			['Round trip', `${Math.round(meta.ms)} ms`],
		];
		for (const [term, value] of stats) {
			const box = el('div', 'sl-api-stat');
			box.append(el('dt', null, term), el('dd', null, value));
			statsRow.append(box);
		}
	}

	function renderTimeline(data) {
		timeline.replaceChildren();
		const total = data.duration || 1;
		for (const seg of data.timeline) {
			const span = Math.max(seg.end - seg.start, 0.001);
			const block = el('button', 'sl-api-seg');
			block.type = 'button';
			block.role = 'listitem';
			block.style.flexGrow = String(span);
			block.dataset.kind = seg.signed ? 'signed' : 'spelled';
			block.dataset.start = String(seg.start);
			block.dataset.end = String(seg.end);
			block.setAttribute(
				'aria-label',
				seg.signed
					? `${seg.word}, signed, ${fmt(seg.start)} to ${fmt(seg.end)}. ${seg.gloss}`
					: `${seg.word}, fingerspelled ${seg.letters?.map((l) => l.letter).join('-') ?? ''}, ${fmt(seg.start)} to ${fmt(seg.end)}.`,
			);
			block.title = seg.signed ? seg.gloss : `Fingerspelled: ${seg.word.split('').join('-')}`;

			const label = el('span', 'sl-api-seg-word', seg.word.toLowerCase());
			block.append(label);

			if (seg.letters?.length) {
				const letters = el('span', 'sl-api-seg-letters');
				for (const letter of seg.letters) {
					const cell = el('span', 'sl-api-letter', letter.letter);
					cell.style.flexGrow = String(Math.max(letter.end - letter.start, 0.001));
					cell.dataset.start = String(letter.start);
					cell.dataset.end = String(letter.end);
					letters.append(cell);
				}
				block.append(letters);
			}

			// Clicking one word plays just that word, which is how anyone actually
			// checks whether a single sign looks right.
			block.addEventListener('click', () => {
				input.value = seg.word.toLowerCase();
				run();
			});
			timeline.append(block);
		}

		// A tick per second, so the block widths read as real time.
		ruler.replaceChildren();
		for (let s = 0; s <= Math.floor(total); s++) {
			const tick = el('span', 'sl-api-tick', `${s}s`);
			tick.style.left = `${(s / total) * 100}%`;
			ruler.append(tick);
		}
	}

	function renderCode(url, data, meta) {
		codeBody.replaceChildren();
		const req = el('pre', 'sl-api-pre');
		req.append(el('code', null, `GET ${url}\n\n${curlFor(meta.params)}`));
		// The clip is tens of thousands of numbers; show its shape, not its bytes.
		const preview = {
			...data,
			clip: data.clip
				? {
						name: data.clip.name,
						duration: data.clip.duration,
						blendMode: data.clip.blendMode,
						tracks: `[${data.clip.tracks.length} bone tracks omitted here — ${humanBytes(meta.bytes)} over the wire]`,
					}
				: undefined,
		};
		const res = el('pre', 'sl-api-pre');
		res.append(el('code', null, JSON.stringify(preview, null, 2)));
		codeBody.append(el('h4', 'sl-api-code-h', 'Request'), req, el('h4', 'sl-api-code-h', 'Response'), res);
	}

	function clearPlayhead() {
		cancelAnimationFrame(playFrame);
		playFrame = 0;
		playhead.hidden = true;
		timeline.querySelectorAll('[data-active]').forEach((n) => delete n.dataset.active);
	}

	/** Sweep the playhead across the timeline for `duration` seconds. */
	function startPlayhead(duration) {
		clearPlayhead();
		playhead.hidden = false;
		const startedAt = performance.now();
		const step = () => {
			const t = (performance.now() - startedAt) / 1000;
			if (t >= duration) {
				clearPlayhead();
				return;
			}
			playhead.style.left = `${Math.min(100, (t / duration) * 100)}%`;
			for (const node of timeline.querySelectorAll('.sl-api-seg, .sl-api-letter')) {
				const on = t >= Number(node.dataset.start) && t < Number(node.dataset.end);
				if (on) node.dataset.active = '';
				else delete node.dataset.active;
			}
			playFrame = requestAnimationFrame(step);
		};
		playFrame = requestAnimationFrame(step);
	}

	// ── the request ──────────────────────────────────────────────────────────
	async function run() {
		const text = input.value.trim();
		if (!text) {
			out.dataset.state = 'error';
			note.textContent = 'Type something to compile. Letters, digits and spaces are performed.';
			return;
		}
		clearPlayhead();
		out.dataset.state = 'loading';
		note.textContent = '';
		submit.disabled = true;

		const params = new URLSearchParams({ text });
		if (hand === 'left') params.set('hand', 'left');
		if (speed !== 1) params.set('speed', String(speed));
		const url = `/api/sign?${params}`;

		const started = performance.now();
		try {
			const res = await fetch(url, { headers: { accept: 'application/json' } });
			const raw = await res.text();
			const ms = performance.now() - started;
			let data;
			try {
				data = JSON.parse(raw);
			} catch {
				throw new Error(`the endpoint returned ${res.status} with a non-JSON body`);
			}
			if (!res.ok) {
				throw new Error(data.message || data.error || `HTTP ${res.status}`);
			}
			last = { data, meta: { ms, bytes: new Blob([raw]).size, params: { text, hand, speed } }, url };
			renderStats(data, last.meta);
			renderTimeline(data);
			renderCode(url, data, last.meta);
			openBtn.href = url;
			out.dataset.state = 'ready';
			note.textContent = data.truncated
				? `Truncated at ${data.duration.toFixed(1)}s to stay watchable. Raise max_seconds, or split the text.`
				: `${data.signed.length} signed, ${data.spelled.length} fingerspelled. Click any word to compile it on its own.`;
		} catch (err) {
			log.warn('[sign-api-console] request failed', err?.message);
			out.dataset.state = 'error';
			note.textContent = `${err.message}. The endpoint is public and needs no key, so this is usually a network problem: try again.`;
		} finally {
			submit.disabled = false;
		}
	}

	form.addEventListener('submit', (e) => {
		e.preventDefault();
		run();
	});

	playBtn.addEventListener('click', async () => {
		if (!last || !sign) return;
		playBtn.disabled = true;
		startPlayhead(last.data.duration);
		try {
			await sign({ text: last.data.text, hand, speed });
		} catch (err) {
			note.textContent = `Could not play that on the avatar: ${err?.message || 'the stage is not ready'}.`;
		} finally {
			clearPlayhead();
			playBtn.disabled = false;
		}
	});

	copyBtn.addEventListener('click', async () => {
		if (!last) return;
		try {
			await navigator.clipboard.writeText(curlFor(last.meta.params));
			copyBtn.textContent = 'Copied';
			setTimeout(() => {
				copyBtn.textContent = 'Copy curl';
			}, 1600);
		} catch {
			note.textContent = 'Clipboard blocked by the browser: the curl is in the Request panel below.';
		}
	});

	// Compile the first example immediately: an empty console teaches nothing,
	// and this is one cached GET.
	run();

	return { run, element: host };
}
