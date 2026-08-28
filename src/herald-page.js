// /herald: the playground for @three-ws/herald (herald-sdk/).
//
// Everything on this page runs the real library against the real rules engine
// in the visitor's own tab. The composer builds a message, the rules panel
// rebuilds the herald with the visitor's rules, and the verdict log prints what
// the engine actually decided, drop reasons included. Signed in, the page also
// subscribes to the delivery rail, so a `curl` from a terminal (or the CLI, or
// a CI job) is delivered here by the same avatar.
//
// The page is deliberately usable signed out: the SDK needs no account, and the
// only thing an account adds is the rail.

import { createHerald, railSource } from '../herald-sdk/src/index.js';

const AUTH_HINT_KEY = '3dagent:auth-hint';

const $ = (sel) => document.querySelector(sel);

const els = {
	text: $('#f-text'),
	from: $('#f-from'),
	url: $('#f-url'),
	tone: $('#f-tone'),
	emote: $('#f-emote'),
	presenter: $('#f-presenter'),
	importance: $('#f-importance'),
	importanceOut: $('#f-importance-out'),
	voice: $('#f-voice'),
	send: $('#f-send'),
	burst: $('#f-burst'),
	demoRun: $('#demo-run'),
	floor: $('#r-floor'),
	floorOut: $('#r-floor-out'),
	rate: $('#r-rate'),
	rateOut: $('#r-rate-out'),
	quiet: $('#r-quiet'),
	focus: $('#r-focus'),
	verdicts: $('#verdicts'),
	stats: $('#stats'),
	railDot: $('#rail-dot'),
	railLabel: $('#rail-label'),
	railKey: $('#rail-key'),
};

let herald = null;
let railStop = null;

// ── The live herald ─────────────────────────────────────────────────────────
// Rebuilt whenever the rules change, because the rules are constructor-level:
// a herald is cheap to build and this keeps the demo honest about what the
// library actually does rather than mutating private state behind the scenes.

function build() {
	herald?.stop();
	railStop = null;

	herald = createHerald({
		presenter: els.presenter.value,
		voice: els.voice.checked ? 'always' : 'off',
		rules: {
			minImportance: Number(els.floor.value),
			maxPerWindow: Number(els.rate.value),
			quietHours: els.quiet.checked ? [22, 7] : null,
			focusOnly: els.focus.checked,
			// The playground is a place to try things: a message you send twice on
			// purpose should be visible as a duplicate within seconds, not held
			// against you for six hours.
			dedupeTtlMs: 30_000,
		},
		onDeliver: (m) => logVerdict('deliver', m.text, `importance ${m.importance}`),
		onHold: (m, reason) => logVerdict('hold', m.text, reason),
		onDrop: (m, reason) => logVerdict('drop', m?.text || '(empty)', reason),
		actionsFor: () => [
			{ label: 'Mute 1 min', title: 'Silence deliveries for a minute', onClick: () => herald.mute(60_000) },
		],
	});

	if (isAuthed()) connectRail();
	renderStats();
}

function isAuthed() {
	try {
		return JSON.parse(localStorage.getItem(AUTH_HINT_KEY) || 'null')?.authed === true;
	} catch {
		return false;
	}
}

// ── The rail ────────────────────────────────────────────────────────────────

function connectRail() {
	if (!('EventSource' in window)) return setRail('off', 'This browser has no EventSource');
	setRail('', 'Connecting…');
	// Same-origin: the SDK's railSource defaults to three.ws, but on a preview
	// origin (or localhost) the stream lives here, not there.
	railStop = herald.source(railSource({ origin: window.location.origin }));

	// EventSource reports readiness through its own events; the source hides the
	// instance, so we probe the endpoint once for an honest label rather than
	// claiming a connection we cannot see.
	fetch('/api/herald/stream', { method: 'HEAD', credentials: 'include' })
		.then((res) => {
			if (res.status === 401) setRail('off', 'Sign in to use your rail');
			else if (res.ok || res.status === 405) setRail('live', 'Listening on your rail');
			else setRail('off', `Rail unavailable (${res.status})`);
		})
		.catch(() => setRail('off', 'Rail unreachable'));
}

function setRail(state, label) {
	els.railDot.className = `dot${state ? ` ${state}` : ''}`;
	els.railLabel.textContent = label;
}

// ── Verdict log + stats ─────────────────────────────────────────────────────

function logVerdict(action, text, why) {
	const row = document.createElement('div');
	row.className = `verdict ${action}`;
	const tag = document.createElement('span');
	tag.className = 'tag';
	tag.textContent = action.toUpperCase();
	const body = document.createElement('span');
	body.textContent = text;
	const reason = document.createElement('span');
	reason.className = 'why';
	reason.textContent = why ? `· ${why}` : '';
	row.append(tag, body, reason);

	if (els.verdicts.firstElementChild?.querySelector('.why')?.textContent?.startsWith('Nothing yet')) {
		els.verdicts.textContent = '';
	}
	els.verdicts.prepend(row);
	while (els.verdicts.children.length > 40) els.verdicts.lastElementChild.remove();
	renderStats();
}

function renderStats() {
	const s = herald.stats();
	const cells = [
		['delivered', s.delivered],
		['held', s.holding],
		['dropped', s.dropped],
		['spoken', s.spoken],
	];
	els.stats.innerHTML = '';
	for (const [label, value] of cells) {
		const cell = document.createElement('div');
		cell.className = 'stat';
		const b = document.createElement('b');
		b.textContent = String(value);
		const span = document.createElement('span');
		span.textContent = label;
		cell.append(b, span);
		els.stats.appendChild(cell);
	}
}

// ── Composer ────────────────────────────────────────────────────────────────

function compose(over = {}) {
	return {
		// A fresh id per send: the playground is for trying the same line twice
		// and watching the dedupe window catch the second one.
		id: `play-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
		text: els.text.value.trim() || 'Deploy is green',
		from: els.from.value.trim() || undefined,
		url: els.url.value.trim() || undefined,
		tone: els.tone.value,
		emote: els.emote.value,
		importance: Number(els.importance.value),
		...over,
	};
}

function send() {
	herald.announce(compose());
}

function burst() {
	const lines = [
		'Build queued',
		'Tests passed',
		'Container pushed',
		'Migration applied',
		'Deploy is green',
	];
	lines.forEach((text, i) => {
		herald.announce(compose({ text, importance: 60 + i * 8, id: `burst-${Date.now()}-${i}` }));
	});
}

// ── Wiring ──────────────────────────────────────────────────────────────────

els.importance.addEventListener('input', () => {
	els.importanceOut.textContent = els.importance.value;
});
els.floor.addEventListener('input', () => {
	els.floorOut.textContent = els.floor.value;
});
els.rate.addEventListener('input', () => {
	els.rateOut.textContent = els.rate.value;
});

for (const control of [els.floor, els.rate, els.quiet, els.focus, els.presenter, els.voice]) {
	control.addEventListener('change', build);
}

els.send.addEventListener('click', send);
els.burst.addEventListener('click', burst);
els.demoRun.addEventListener('click', () => {
	document.getElementById('playground')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	herald.announce({
		id: `hero-${Date.now()}`,
		text: 'This is what an important message looks like',
		from: 'herald',
		importance: 90,
		tone: 'celebrate',
		emote: 'dance',
		url: '/docs/herald',
	});
});

// Enter in the message field sends, because a demo you have to reach for the
// mouse to run is a demo people bounce off.
els.text.addEventListener('keydown', (e) => {
	if (e.key === 'Enter') {
		e.preventDefault();
		send();
	}
});

for (const btn of document.querySelectorAll('.copy')) {
	btn.addEventListener('click', async () => {
		const target = document.querySelector(btn.dataset.copy);
		if (!target) return;
		const text = target.textContent.replace(/^Copy/, '').trim();
		try {
			await navigator.clipboard.writeText(text);
			const original = btn.textContent;
			btn.textContent = 'Copied';
			setTimeout(() => {
				btn.textContent = original;
			}, 1400);
		} catch {
			// Clipboard blocked (permissions, insecure context): select the block
			// so the visitor can copy it themselves rather than being told nothing.
			const range = document.createRange();
			range.selectNodeContents(target);
			const sel = window.getSelection();
			sel.removeAllRanges();
			sel.addRange(range);
			btn.textContent = 'Select + copy';
		}
	});
}

if (!isAuthed()) {
	setRail('off', 'Sign in to use your rail');
	els.railKey.textContent = 'Sign in';
	els.railKey.href = '/login?next=/herald';
}

build();
