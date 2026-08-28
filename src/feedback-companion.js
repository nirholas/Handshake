// Talk to the agent in the corner and tell it what is wrong.
// ============================================================================
// The corner companion already walks your pages, reads sections aloud, and
// delivers notifications in person. This is the return channel: the visitor
// tells it what broke, and the report arrives with everything the browser knows
// and the visitor should not have to type.
//
// Why the companion and not a form: people describe a problem to a character.
// They abandon a support form. The avatar is the product's best feedback
// surface precisely because it does not look like paperwork.
//
// What makes a report actionable is the half the visitor never sees:
//
//   route + page title  which surface, by name
//   build sha           WHICH DEPLOY. This one column turns "the avatar page is
//                       blank" into "the avatar page went blank in the deploy
//                       that shipped abc1234", which is the difference between
//                       a mystery and a bisect.
//   console errors      the last few real exceptions, captured as they happened
//   failed requests     the last few non-ok fetches, method + path + status
//   viewport + locale   the two facts behind most "works for me" replies
//
// Two ways in, and the proactive one is the point:
//
//   1. Proactive. When the page actually throws or a request actually fails,
//      the companion turns and asks. That is the only moment the visitor still
//      remembers what they were doing, and the error is already attached. Once
//      per route per session, never in a background tab, and never twice for
//      the same visitor who said no.
//   2. Manual. A small control in the companion chrome, next to the narration
//      and trails toggles, plus window.__walkFeedback.open() for any surface
//      that wants its own entry point.
//
// Nothing here is analytics. It fires on a real failure or a real click, sends
// one request, and stores nothing about the visitor beyond a random per-browser
// key used to thread a follow-up (hashed the moment it reaches the server).

const CLIENT_KEY = '3dagent:feedback-client';
const DRAFT_KEY = '3dagent:feedback-draft';
const DECLINED_KEY = '3dagent:feedback-declined';
const OFFERED_KEY = '3dagent:feedback-offered';
const STYLE_ID = 'walk-companion-feedback-style';

// Long enough that the visitor still knows what they were doing, short enough
// that the error they see offered is the one they just caused.
const OFFER_WINDOW_MS = 20_000;

// ── Context capture ─────────────────────────────────────────────────────────
// The capture layer is @three-ws/witness (packages/witness), a standalone,
// framework-agnostic recorder published for any site to use. It keeps a bounded
// SEMANTIC trace: the sequence of intents plus the failures, with a stable
// selector synthesized for every element touched and no typed value ever held.
//
// That trace is the difference between a report and a reproduction. It compiles
// into a Playwright spec (GET /api/feedback/repro) that is red until the bug is
// fixed, so a sentence a visitor typed arrives as a runnable regression test.
//
// It starts at module load, before the companion finishes mounting, so a page
// that breaks during boot is still recorded.

import { witness } from '../packages/witness/src/index.js';
import { failuresIn, narrate } from '../packages/witness/src/compile.js';

const recorder = witness.start({
	// Our own report endpoint is excluded: a failing report must never become
	// the next report's evidence.
	ignore: (path) => path.startsWith('/api/feedback/'),
});

/** The failures the recorder saw, in the shape the report API already stores. */
export function capturedSignals() {
	const found = failuresIn(witness.trace());
	return {
		errors: [...found.errors].slice(-5),
		failures: [...found.network, ...found.resources].slice(-5),
	};
}

/** The steps a person would read, straight from the same trace the spec compiles from. */
export function capturedSteps() {
	return narrate(witness.trace());
}

// ── Environment facts ───────────────────────────────────────────────────────

let buildShaPromise = null;

function buildSha() {
	if (!buildShaPromise) {
		buildShaPromise = fetch('/build-info.json', { cache: 'force-cache' })
			.then((r) => (r.ok ? r.json() : null))
			.then((info) => info?.commitShort || info?.commit || null)
			.catch(() => null);
	}
	return buildShaPromise;
}

function clientKey() {
	try {
		let key = localStorage.getItem(CLIENT_KEY);
		if (!key) {
			key = crypto.randomUUID();
			localStorage.setItem(CLIENT_KEY, key);
		}
		return key;
	} catch {
		// Private mode, or storage disabled. The report still sends; it just
		// cannot be threaded to a follow-up.
		return null;
	}
}

function readFlag(key) {
	try {
		return JSON.parse(sessionStorage.getItem(key) || '[]');
	} catch {
		return [];
	}
}

function writeFlag(key, value) {
	try {
		sessionStorage.setItem(key, JSON.stringify(value.slice(-20)));
	} catch {
		/* nothing to persist to */
	}
}

async function collectContext() {
	const signals = capturedSignals();
	return {
		route: location.pathname + location.search,
		page_title: document.title || null,
		build_sha: await buildSha(),
		viewport: `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio || 1}`,
		locale: navigator.language || null,
		console_errors: signals.errors,
		failed_requests: signals.failures,
		// The whole recorded session. The server bounds every field again and the
		// compiler turns it into a runnable spec.
		trace: witness.trace(),
	};
}

// ── Transport ───────────────────────────────────────────────────────────────

export async function sendReport(body, { transport = 'text' } = {}) {
	const context = await collectContext();
	const key = clientKey();
	const res = await fetch('/api/feedback/report', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(key ? { 'x-feedback-client': key } : {}),
		},
		credentials: 'same-origin',
		body: JSON.stringify({ ...context, body, transport }),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		const err = new Error(data?.message || 'We could not file that just now.');
		err.status = res.status;
		throw err;
	}
	return data;
}

// ── Panel ───────────────────────────────────────────────────────────────────

function ensureStyles() {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `
.walk-companion-feedback{position:absolute;top:2px;right:132px;z-index:3;width:22px;height:22px;border:none;border-radius:50%;background:rgba(12,14,20,.55);color:rgba(255,255,255,.55);font-size:12px;line-height:1;cursor:pointer;pointer-events:auto;opacity:0;transition:opacity .2s ease,background-color .2s ease,color .2s ease;display:grid;place-items:center;padding:0}
.walk-companion:hover .walk-companion-feedback,.walk-companion:focus-within .walk-companion-feedback{opacity:1}
.walk-companion-feedback:hover{background-color:rgba(122,162,255,.85);color:#fff}
.walk-companion-feedback:focus-visible{outline:2px solid #7aa2ff;outline-offset:2px;opacity:1}
@media (pointer:coarse){.walk-companion-feedback{opacity:1;width:44px;height:44px;top:-9px;right:129px;border:11px solid transparent;background-clip:padding-box}}

/* The companion owns the bottom-right corner (200x280 at right:16 bottom:16,
   148x208 under 520px) and its canvas takes pointer events, so a panel placed
   there looks fine and cannot be clicked. Stand the panel BESIDE the avatar on
   a wide screen (it reads as the avatar holding the form it opened) and stack
   it ABOVE the avatar when there is no room to the left. One z-index above the
   companion so it is never painted under it either. */
.fb-panel{position:fixed;right:232px;bottom:16px;z-index:2147483001;width:min(360px,calc(100vw - 32px));background:rgba(14,16,22,.96);color:#e8ebf2;border:1px solid rgba(122,162,255,.28);border-radius:14px;box-shadow:0 18px 48px rgba(0,0,0,.5);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;opacity:0;transform:translateY(8px) scale(.98);transition:opacity .18s ease,transform .18s ease;will-change:opacity,transform}
.fb-panel[data-open="1"]{opacity:1;transform:none}
@media (prefers-reduced-motion:reduce){.fb-panel{transition:none}}
@media (max-width:720px){.fb-panel{right:16px;left:16px;bottom:306px;width:auto}}
@media (max-width:520px){.fb-panel{right:10px;left:10px;bottom:228px}}
@media (max-height:620px){.fb-panel{bottom:16px;right:232px;left:auto;width:min(320px,calc(100vw - 190px))}}
.fb-head{display:flex;align-items:center;gap:8px;padding:12px 14px 8px}
.fb-title{font-weight:600;font-size:14px;margin:0;flex:1}
.fb-close{width:26px;height:26px;border:none;border-radius:8px;background:transparent;color:rgba(232,235,242,.55);font-size:16px;cursor:pointer;display:grid;place-items:center}
.fb-close:hover{background:rgba(255,255,255,.08);color:#fff}
.fb-close:focus-visible{outline:2px solid #7aa2ff;outline-offset:1px}
.fb-body{padding:0 14px 14px}
.fb-input{width:100%;min-height:88px;max-height:200px;resize:vertical;box-sizing:border-box;padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.28);color:inherit;font:inherit}
.fb-input::placeholder{color:rgba(232,235,242,.38)}
.fb-input:focus{outline:none;border-color:rgba(122,162,255,.7);box-shadow:0 0 0 3px rgba(122,162,255,.18)}
.fb-ctx{margin:10px 0 0;padding:8px 10px;border-radius:8px;background:rgba(122,162,255,.08);border:1px solid rgba(122,162,255,.16);font-size:12px;color:rgba(232,235,242,.66)}
.fb-ctx b{color:rgba(232,235,242,.9);font-weight:600}
.fb-ctx code{font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#9fc0ff;word-break:break-all}
.fb-row{display:flex;gap:8px;align-items:center;margin-top:12px}
.fb-send{flex:1;padding:9px 12px;border:none;border-radius:9px;background:#7aa2ff;color:#0b0d13;font:600 14px/1 system-ui,sans-serif;cursor:pointer;transition:background .15s ease,transform .1s ease}
.fb-send:hover:not(:disabled){background:#96b6ff}
.fb-send:active:not(:disabled){transform:translateY(1px)}
.fb-send:disabled{opacity:.5;cursor:not-allowed}
.fb-send:focus-visible{outline:2px solid #fff;outline-offset:2px}
.fb-mic{width:38px;height:36px;border-radius:9px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.28);color:rgba(232,235,242,.7);cursor:pointer;display:grid;place-items:center;font-size:15px;transition:background .15s ease,color .15s ease}
.fb-mic:hover{background:rgba(255,255,255,.08);color:#fff}
.fb-mic[data-listening="1"]{background:rgba(255,92,92,.22);border-color:rgba(255,92,92,.5);color:#ff8f8f}
.fb-mic:focus-visible{outline:2px solid #7aa2ff;outline-offset:1px}
.fb-note{margin:10px 0 0;font-size:12px;color:rgba(232,235,242,.55)}
.fb-note[data-tone="error"]{color:#ff9b9b}
.fb-note[data-tone="ok"]{color:#8fe0a8}
.fb-steps-toggle{background:none;border:none;padding:0;font:inherit;font-size:12px;color:#9fc0ff;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.fb-steps-toggle:hover{color:#c2d6ff}
.fb-steps-toggle:focus-visible{outline:2px solid #7aa2ff;outline-offset:2px;border-radius:3px}
.fb-steps{margin:8px 0 0;padding:0 0 0 18px;max-height:132px;overflow-y:auto;font-size:11.5px;line-height:1.5;color:rgba(232,235,242,.62)}
.fb-steps li{margin:1px 0}
.fb-privacy{display:block;margin-top:8px;font-size:11px;color:rgba(232,235,242,.45)}
.fb-done{padding:6px 0 2px;text-align:center}
.fb-done p{margin:0 0 4px;font-size:14px}
.fb-done small{color:rgba(232,235,242,.55)}
`;
	document.head.appendChild(style);
}

function escapeHtml(value) {
	return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function speechRecognizer() {
	const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
	if (!Ctor) return null;
	const rec = new Ctor();
	rec.continuous = true;
	rec.interimResults = true;
	rec.lang = navigator.language || 'en-US';
	return rec;
}

function createPanel() {
	ensureStyles();
	const panel = document.createElement('div');
	panel.className = 'fb-panel';
	panel.setAttribute('role', 'dialog');
	panel.setAttribute('aria-modal', 'false');
	panel.setAttribute('aria-label', 'Tell your agent what happened');
	panel.hidden = true;
	panel.innerHTML = `
		<div class="fb-head">
			<h2 class="fb-title">What happened?</h2>
			<button type="button" class="fb-close" aria-label="Close feedback">&times;</button>
		</div>
		<div class="fb-body">
			<label class="fb-note" for="fb-input" style="margin:0 0 6px;display:block">Say it however you like. Your agent passes it straight to the people who can fix it.</label>
			<textarea class="fb-input" id="fb-input" rows="4" placeholder="The download button does nothing on my phone..."></textarea>
			<p class="fb-ctx"></p>
			<div class="fb-row">
				<button type="button" class="fb-mic" aria-label="Dictate instead of typing" title="Dictate instead of typing" hidden>&#127908;</button>
				<button type="button" class="fb-send">Send to the team</button>
			</div>
			<p class="fb-note" role="status" aria-live="polite"></p>
		</div>
	`;
	document.body.appendChild(panel);
	return panel;
}

/**
 * Mount the feedback surface: the chrome control, the panel, and the proactive
 * offer when the page actually breaks.
 *
 * @param {object} opts
 * @param {() => (object|null)} opts.getInstance live WalkCompanion instance.
 * @param {() => (HTMLElement|null)} [opts.getHostEl] companion host element.
 * @returns {{ open:(reason?:string)=>void, close:()=>void, uninstall:()=>void }}
 */
export function installFeedback({ getInstance, getHostEl } = {}) {
	if (typeof document === 'undefined') return { open() {}, close() {}, uninstall() {} };

	const resolveInst = typeof getInstance === 'function' ? getInstance : () => null;
	const resolveHost = () => {
		try {
			return (typeof getHostEl === 'function' ? getHostEl() : resolveInst()?.host) || null;
		} catch {
			return null;
		}
	};

	let panel = null;
	let input = null;
	let ctx = null;
	let note = null;
	let sendBtn = null;
	let micBtn = null;
	let recognizer = null;
	let lastFocus = null;
	let sending = false;
	let sent = false;

	function say(text, tone = '') {
		if (!note) return;
		note.textContent = text;
		if (tone) note.dataset.tone = tone;
		else delete note.dataset.tone;
	}

	// Full transparency about what rides along. A visitor who can see exactly
	// what is attached trusts the channel; one who cannot, does not use it.
	async function renderContext() {
		if (!ctx) return;
		const signals = capturedSignals();
		const sha = await buildSha();
		const steps = capturedSteps();
		const bits = [`<b>Page</b> <code>${location.pathname}</code>`];
		if (sha) bits.push(`<b>Build</b> <code>${sha}</code>`);
		if (signals.errors.length) bits.push(`<b>${signals.errors.length}</b> console error${signals.errors.length > 1 ? 's' : ''}`);
		if (signals.failures.length) bits.push(`<b>${signals.failures.length}</b> failed request${signals.failures.length > 1 ? 's' : ''}`);
		// Naming the step count is what makes the recorder feel like help rather
		// than surveillance: the visitor can see exactly how much was kept, and
		// open it to read every line before they send.
		const stepLine = steps.length
			? `<button type="button" class="fb-steps-toggle" aria-expanded="false">${steps.length} recorded step${steps.length > 1 ? 's' : ''}</button>`
			: '';
		ctx.innerHTML = `Attached automatically: ${bits.join(' &middot; ')}${stepLine ? ` &middot; ${stepLine}` : ''}
			<ol class="fb-steps" hidden>${steps.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ol>
			<span class="fb-privacy">Nothing you typed into a field is recorded, only how much.</span>`;
		const toggle = ctx.querySelector('.fb-steps-toggle');
		const listEl = ctx.querySelector('.fb-steps');
		toggle?.addEventListener('click', () => {
			const open = toggle.getAttribute('aria-expanded') === 'true';
			toggle.setAttribute('aria-expanded', String(!open));
			listEl.hidden = open;
		});
	}

	function stopDictation() {
		if (!recognizer) return;
		try {
			recognizer.stop();
		} catch {
			/* already stopped */
		}
		if (micBtn) micBtn.dataset.listening = '0';
	}

	function startDictation() {
		if (!recognizer) return;
		const base = input.value ? `${input.value} ` : '';
		recognizer.onresult = (event) => {
			let text = '';
			for (let i = event.resultIndex; i < event.results.length; i += 1) {
				text += event.results[i][0].transcript;
			}
			input.value = base + text;
			saveDraft();
		};
		recognizer.onerror = () => {
			stopDictation();
			say('Dictation stopped. Type it instead and we will still get it.', 'error');
		};
		recognizer.onend = () => {
			if (micBtn) micBtn.dataset.listening = '0';
		};
		try {
			recognizer.start();
			micBtn.dataset.listening = '1';
			micBtn.dataset.wasUsed = '1';
			say('Listening. Tap the mic again when you are done.');
		} catch {
			stopDictation();
		}
	}

	function saveDraft() {
		try {
			if (input.value.trim()) localStorage.setItem(DRAFT_KEY, input.value);
			else localStorage.removeItem(DRAFT_KEY);
		} catch {
			/* nothing to persist to */
		}
	}

	function clearDraft() {
		try {
			localStorage.removeItem(DRAFT_KEY);
		} catch {
			/* nothing to clear */
		}
	}

	function ensurePanel() {
		if (panel) return panel;
		panel = createPanel();
		input = panel.querySelector('.fb-input');
		ctx = panel.querySelector('.fb-ctx');
		note = panel.querySelector('.fb-note[role="status"]');
		sendBtn = panel.querySelector('.fb-send');
		micBtn = panel.querySelector('.fb-mic');

		recognizer = speechRecognizer();
		if (recognizer) {
			micBtn.hidden = false;
			micBtn.addEventListener('click', () => {
				if (micBtn.dataset.listening === '1') stopDictation();
				else startDictation();
			});
		}

		panel.querySelector('.fb-close').addEventListener('click', () => close());
		input.addEventListener('input', () => {
			saveDraft();
			sendBtn.disabled = !input.value.trim() || sending;
		});
		input.addEventListener('keydown', (e) => {
			if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
		});
		panel.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				close();
			}
		});
		sendBtn.addEventListener('click', submit);
		return panel;
	}

	async function submit() {
		const body = input.value.trim();
		if (!body || sending) return;
		sending = true;
		sendBtn.disabled = true;
		sendBtn.textContent = 'Sending...';
		stopDictation();
		try {
			const result = await sendReport(body, { transport: micBtn?.dataset.wasUsed === '1' ? 'voice' : 'text' });
			clearDraft();
			input.value = '';
			panel.querySelector('.fb-body').innerHTML = `
				<div class="fb-done">
					<p>Got it. That is on the list.</p>
					<small>${
						result?.replayable
							? 'Your steps came with it, so we can replay exactly what you hit.'
							: 'Every report is read by a person before anything changes.'
					}</small>
				</div>
			`;
			const inst = resolveInst();
			inst?.say?.('Thanks. I passed that on.', { hold: 4000, priority: 1 });
			// The success state replaced the panel's body, so the next open() gets a
			// fresh panel rather than a form whose fields are no longer attached.
			sent = true;
			setTimeout(() => close(), 2600);
		} catch (err) {
			// The draft is deliberately kept: a visitor who typed a paragraph and
			// hit a 503 must not lose it.
			say(err?.message || 'That did not send. Your note is saved, try again in a moment.', 'error');
			sendBtn.textContent = 'Try again';
			sendBtn.disabled = false;
		} finally {
			sending = false;
		}
	}

	function open(seed = '') {
		ensurePanel();
		lastFocus = document.activeElement;
		panel.hidden = false;
		// Force a frame so the transition runs from the hidden state.
		requestAnimationFrame(() => {
			panel.dataset.open = '1';
		});
		if (seed && !input.value) input.value = seed;
		if (!input.value) {
			try {
				input.value = localStorage.getItem(DRAFT_KEY) || '';
			} catch {
				/* no draft to restore */
			}
		}
		sendBtn.disabled = !input.value.trim();
		say('');
		renderContext();
		input.focus();
	}

	function close() {
		if (!panel) return;
		stopDictation();
		delete panel.dataset.open;
		const closing = panel;
		setTimeout(() => {
			if (sent) {
				closing.remove();
				if (panel === closing) panel = null;
				sent = false;
			} else {
				closing.hidden = true;
			}
		}, 180);
		if (lastFocus?.isConnected) lastFocus.focus();
	}

	// ── Chrome control ────────────────────────────────────────────────────────
	function ensureControl() {
		const host = resolveHost();
		if (!host || host.querySelector('.walk-companion-feedback')) return;
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'walk-companion-feedback';
		btn.title = 'Tell your agent what is wrong';
		btn.setAttribute('aria-label', 'Tell your agent what is wrong');
		btn.textContent = '!';
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			open();
		});
		host.appendChild(btn);
	}

	ensureControl();
	// The host is rebuilt on an avatar swap and on a playground round-trip, so
	// the control is re-attached the same way the sibling toggles are.
	const hostWatch = setInterval(ensureControl, 1500);

	// ── Proactive offer ───────────────────────────────────────────────────────
	// The whole value of this feature is asking at the moment of failure. The
	// rules keep it from ever becoming a nag.
	let offerTimer = 0;

	function maybeOffer() {
		if (document.hidden) return;
		if (panel && !panel.hidden) return;
		const route = location.pathname;
		if (readFlag(DECLINED_KEY).includes(route)) return;
		if (readFlag(OFFERED_KEY).includes(route)) return;
		if (!witness.hasFailure({ withinMs: OFFER_WINDOW_MS })) return;

		const inst = resolveInst();
		if (!inst?.say) return;

		writeFlag(OFFERED_KEY, [...readFlag(OFFERED_KEY), route]);
		const shown = inst.say('Something just broke on this page. Want to tell me what you were doing?', {
			hold: 0,
			tone: 'alert',
			priority: 1,
			actions: [
				{
					label: 'Tell it',
					onClick: () => {
						inst.hideBubble?.();
						open();
					},
				},
				{
					label: 'Not now',
					onClick: () => {
						inst.hideBubble?.();
						writeFlag(DECLINED_KEY, [...readFlag(DECLINED_KEY), route]);
					},
				},
			],
		});
		// No bubble to render into (the companion is off, or a delivery owns it).
		// Nothing is lost: the error stays in the buffer and rides along with a
		// manual report.
		if (!shown) writeFlag(OFFERED_KEY, readFlag(OFFERED_KEY).filter((r) => r !== route));
	}

	// The recorder tells us the moment a failure lands. Debounced, because a
	// burst of errors from one broken render is one thing to ask about.
	const unsubscribe = witness.onFailure(() => {
		clearTimeout(offerTimer);
		offerTimer = setTimeout(maybeOffer, 1200);
	});

	return {
		open,
		close,
		uninstall() {
			unsubscribe();
			clearInterval(hostWatch);
			clearTimeout(offerTimer);
			panel?.remove();
			resolveHost()?.querySelector('.walk-companion-feedback')?.remove();
		},
	};
}
