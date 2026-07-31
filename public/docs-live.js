// Live Docs — the runner.
//
// Turns the static code samples on every three.ws documentation page into
// things a reader can edit and run without leaving the page:
//
//   • an `html` sample containing <agent-3d> renders a real, animated avatar in
//     a sandboxed frame, from exactly the markup printed above it;
//   • a `curl` sample becomes a real request against the live API, with status,
//     latency, response size and a pretty-printed body;
//   • a `js` sample runs in a sandboxed module frame with its console captured.
//
// Every sample stays editable: change the prompt, the avatar URL, the query
// string, press ⌘/Ctrl+Enter, and the doc answers with the real thing. That is
// the whole point — a reader evaluating three.ws should never have to set up a
// project to find out whether the platform does what the page claims.
//
// All decisions about what may run live in docs-live-core.js and are unit
// tested; this file is the DOM, the network call and the presentation.
//
// Mounted by docs/index.html after each page render:
//     import('/docs-live.js').then(m => m.enhance(contentEl))
// enhance() is idempotent per block and safe to call on every navigation.

import {
	applyPlaceholders,
	assessRequest,
	buildPreviewDoc,
	buildScriptDoc,
	classifyBlock,
	findPlaceholders,
	formatBytes,
	formatDuration,
	formatResponseBody,
	isSecretName,
	parseCurl,
	runLabel,
	statusTone,
} from './docs-live-core.js';

const MARK = 'docsLiveReady';
const HINT_KEY = 'tws:docs-live-hint';
const REQUEST_TIMEOUT_MS = 20_000;
const SCRIPT_TIMEOUT_MS = 15_000;

// Placeholder values a reader types. Secrets stay in memory for the tab's life
// and are never written to storage; everything else survives a reload so an
// agent id typed on one page still applies on the next.
const secretValues = new Map();
const STORE_PREFIX = 'tws:docs-live:';

function readValue(name) {
	if (isSecretName(name)) return secretValues.get(name) || '';
	try {
		return sessionStorage.getItem(STORE_PREFIX + name) || '';
	} catch {
		return '';
	}
}

function writeValue(name, value) {
	if (isSecretName(name)) {
		secretValues.set(name, value);
		return;
	}
	try {
		sessionStorage.setItem(STORE_PREFIX + name, value);
	} catch {
		/* private mode — the value still applies for this run */
	}
}

// ── Icons ────────────────────────────────────────────────────────────────────

const I = {
	play: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="currentColor"><path d="M8 5.6v12.8a1 1 0 0 0 1.53.85l10-6.4a1 1 0 0 0 0-1.7l-10-6.4A1 1 0 0 0 8 5.6Z"/></svg>',
	edit: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
	reset: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
	close: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
	spark: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="currentColor"><path d="M12 2.6 13.8 8l5.6.2-4.4 3.4 1.5 5.4L12 13.9 7.5 17l1.5-5.4L4.6 8.2 10.2 8 12 2.6Z"/></svg>',
};

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Attach runners to every runnable sample inside `root`.
 * @param {ParentNode} root
 * @returns {number} how many blocks became runnable
 */
export function enhance(root) {
	const scope = root || document;
	let count = 0;
	scope.querySelectorAll('pre > code').forEach((code) => {
		const pre = code.parentElement;
		if (!pre || pre.dataset[MARK]) return;
		pre.dataset[MARK] = '1';
		if (optedOut(pre)) return;

		const source = code.textContent || '';
		const lang = languageOf(code);
		const verdict = classifyBlock({ lang, code: source });
		if (!verdict) return;

		mountRunner({ pre, code, lang, source, verdict });
		count += 1;
	});
	if (count) showHintOnce(scope);
	return count;
}

// An author opts a block out with an HTML comment on the line above it:
//     <!-- live:off -->
function optedOut(pre) {
	let node = pre.previousSibling;
	let hops = 0;
	while (node && hops < 3) {
		if (node.nodeType === 8 && /live\s*:\s*off/i.test(node.nodeValue || '')) return true;
		if (node.nodeType === 1 || (node.nodeType === 3 && node.nodeValue.trim())) break;
		node = node.previousSibling;
		hops += 1;
	}
	return false;
}

function languageOf(code) {
	const cls = code.className || '';
	const match = cls.match(/language-([a-z0-9+#-]+)/i);
	return match ? match[1].toLowerCase() : '';
}

// ── Runner shell ─────────────────────────────────────────────────────────────

function mountRunner({ pre, code, lang, source, verdict }) {
	const wrap = document.createElement('div');
	wrap.className = `dlive dlive-${verdict.kind}`;
	pre.parentNode.insertBefore(wrap, pre);

	const bar = document.createElement('div');
	bar.className = 'dlive-bar';

	const label = verdict.kind === 'preview' ? 'Live preview' : verdict.kind === 'script' ? 'Runnable' : requestChip(verdict.request);
	bar.innerHTML = `
		<span class="dlive-badge" title="This sample runs for real, right here">${I.spark}<span>${escapeHtml(label)}</span></span>
		<span class="dlive-bar-spacer"></span>
		<button type="button" class="dlive-btn dlive-edit" title="Edit this sample, then run it">${I.edit}<span>Edit</span></button>
		<button type="button" class="dlive-btn dlive-reset" title="Restore the sample as published" hidden>${I.reset}<span>Reset</span></button>
		<button type="button" class="dlive-btn dlive-run dlive-btn-primary">${I.play}<span></span></button>`;
	wrap.appendChild(bar);

	// The published <pre> becomes the display half of an editor pair. The
	// textarea is created lazily so a reader who never edits pays nothing.
	const stage = document.createElement('div');
	stage.className = 'dlive-stage';
	pre.parentNode.insertBefore(stage, pre);
	stage.appendChild(pre);
	pre.classList.add('dlive-pre');

	const fields = document.createElement('div');
	fields.className = 'dlive-fields';
	fields.hidden = true;
	wrap.appendChild(stage);
	wrap.appendChild(fields);

	const panel = document.createElement('div');
	panel.className = 'dlive-panel';
	panel.hidden = true;
	panel.setAttribute('aria-live', 'polite');
	wrap.appendChild(panel);

	const state = {
		kind: verdict.kind,
		lang,
		original: source,
		current: source,
		editor: null,
		armed: false,
		busy: false,
		fields,
		panel,
		stage,
		pre,
		code,
		wrap,
	};

	const runBtn = bar.querySelector('.dlive-run');
	const editBtn = bar.querySelector('.dlive-edit');
	const resetBtn = bar.querySelector('.dlive-reset');

	setRunLabel(runBtn, state);
	renderFields(state, runBtn);

	editBtn.addEventListener('click', () => toggleEditor(state, editBtn, resetBtn, runBtn));
	resetBtn.addEventListener('click', () => resetSource(state, editBtn, resetBtn, runBtn));
	runBtn.addEventListener('click', () => run(state, runBtn));
}

function requestChip(request) {
	const verdict = assessRequest(request, { origin: location.origin });
	if (!verdict.ok) return 'Reference only';
	return `${request.method} · live API`;
}

function setRunLabel(btn, state) {
	const request = state.kind === 'request' ? parseCurl(state.current) : null;
	const span = btn.querySelector('span');
	if (state.kind === 'request') {
		const verdict = request ? assessRequest(request, { origin: location.origin }) : { ok: false, reason: 'That is no longer a curl command.' };
		btn.disabled = !verdict.ok;
		btn.title = verdict.ok ? 'Send this request to the live three.ws API' : verdict.reason;
		span.textContent = verdict.ok ? runLabel(state.kind, request) : 'Not runnable';
		return;
	}
	btn.disabled = false;
	btn.title = state.kind === 'preview' ? 'Render this markup in a sandboxed frame' : 'Run this script in a sandboxed frame';
	span.textContent = runLabel(state.kind, null);
}

// ── Editing ──────────────────────────────────────────────────────────────────

function toggleEditor(state, editBtn, resetBtn, runBtn) {
	if (state.editor) {
		commitEditor(state, editBtn, resetBtn, runBtn);
		return;
	}
	const ta = document.createElement('textarea');
	ta.className = 'dlive-editor';
	ta.value = state.current;
	ta.spellcheck = false;
	ta.setAttribute('aria-label', 'Editable code sample');
	ta.rows = Math.min(28, Math.max(4, state.current.split('\n').length + 1));
	ta.addEventListener('input', () => {
		state.current = ta.value;
		autoGrow(ta);
		setRunLabel(runBtn, state);
		renderFields(state, runBtn);
	});
	ta.addEventListener('keydown', (e) => {
		if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
			e.preventDefault();
			run(state, runBtn);
		}
		if (e.key === 'Escape') {
			e.preventDefault();
			commitEditor(state, editBtn, resetBtn, runBtn);
		}
		if (e.key === 'Tab') {
			// A code editor that tabs to the next button is not a code editor.
			e.preventDefault();
			const { selectionStart: s, selectionEnd: end, value } = ta;
			ta.value = `${value.slice(0, s)}\t${value.slice(end)}`;
			ta.selectionStart = ta.selectionEnd = s + 1;
			state.current = ta.value;
		}
	});

	state.pre.hidden = true;
	state.stage.appendChild(ta);
	state.editor = ta;
	autoGrow(ta);
	ta.focus();

	editBtn.querySelector('span').textContent = 'Done';
	editBtn.classList.add('dlive-btn-active');
	resetBtn.hidden = false;
}

function commitEditor(state, editBtn, resetBtn, runBtn) {
	if (!state.editor) return;
	state.current = state.editor.value;
	state.editor.remove();
	state.editor = null;
	state.pre.hidden = false;
	repaint(state);
	editBtn.querySelector('span').textContent = 'Edit';
	editBtn.classList.remove('dlive-btn-active');
	resetBtn.hidden = state.current === state.original;
	setRunLabel(runBtn, state);
	renderFields(state, runBtn);
}

function resetSource(state, editBtn, resetBtn, runBtn) {
	state.current = state.original;
	if (state.editor) {
		state.editor.value = state.original;
		autoGrow(state.editor);
	}
	repaint(state);
	resetBtn.hidden = true;
	setRunLabel(runBtn, state);
	renderFields(state, runBtn);
}

// Re-render the display half from the edited source, re-highlighting with the
// docs page's own highlight.js when it is available so an edited sample keeps
// the typography of the published one.
function repaint(state) {
	state.code.textContent = state.current;
	state.code.className = state.lang ? `language-${state.lang}` : '';
	if (window.hljs && state.lang && window.hljs.getLanguage(state.lang)) {
		try {
			state.code.innerHTML = window.hljs.highlight(state.current, { language: state.lang }).value;
		} catch {
			/* the plain-text render above is already correct */
		}
	}
}

function autoGrow(ta) {
	ta.style.height = 'auto';
	ta.style.height = `${Math.min(560, ta.scrollHeight + 2)}px`;
}

// ── Placeholder fields ───────────────────────────────────────────────────────

function renderFields(state, runBtn) {
	if (state.kind !== 'request') return;
	const request = parseCurl(state.current);
	const slots = request ? findPlaceholders(request) : [];
	if (!slots.length) {
		state.fields.hidden = true;
		state.fields.innerHTML = '';
		return;
	}

	const existing = new Set([...state.fields.querySelectorAll('input')].map((i) => i.name));
	const wanted = new Set(slots.map((s) => s.name));
	if (existing.size === wanted.size && [...wanted].every((n) => existing.has(n))) return;

	state.fields.hidden = false;
	state.fields.innerHTML = `
		<p class="dlive-fields-hint">Fill these in and the request runs with your values. ${slots.some((s) => s.secret) ? 'Secrets stay in this tab and are never stored.' : ''}</p>
		<div class="dlive-fields-grid">
			${slots
				.map(
					(s) => `<label class="dlive-field">
						<span>${escapeHtml(s.name)}</span>
						<input name="${escapeAttr(s.name)}" type="${s.secret ? 'password' : 'text'}"
							autocomplete="off" spellcheck="false"
							placeholder="${s.secret ? 'your value, kept in this tab' : 'your value'}"
							value="${escapeAttr(readValue(s.name))}" />
					</label>`,
				)
				.join('')}
		</div>`;

	state.fields.querySelectorAll('input').forEach((input) => {
		input.addEventListener('input', () => writeValue(input.name, input.value));
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				run(state, runBtn);
			}
		});
	});
}

function collectValues(state) {
	const values = {};
	state.fields.querySelectorAll('input').forEach((input) => {
		if (input.value) values[input.name] = input.value;
	});
	return values;
}

// ── Running ──────────────────────────────────────────────────────────────────

async function run(state, btn) {
	if (state.busy || btn.disabled) return;
	if (state.kind === 'preview') return runPreview(state);
	if (state.kind === 'script') return runScript(state, btn);
	return runRequest(state, btn);
}

function runPreview(state) {
	const doc = buildPreviewDoc(state.current, { origin: location.origin, theme: currentTheme() });
	openPanel(state, `
		<div class="dlive-panel-head">
			<span class="dlive-chip dlive-chip-ok">Rendering</span>
			<span class="dlive-meta">Sandboxed frame · scripts only, no access to this page</span>
			<button type="button" class="dlive-btn dlive-panel-close" aria-label="Close preview">${I.close}</button>
		</div>
		<div class="dlive-frame-wrap"><div class="dlive-skeleton" aria-hidden="true"></div></div>`);

	const host = state.panel.querySelector('.dlive-frame-wrap');
	const frame = document.createElement('iframe');
	frame.className = 'dlive-frame';
	frame.setAttribute('sandbox', 'allow-scripts');
	frame.setAttribute('title', 'Live preview of this code sample');
	frame.setAttribute('loading', 'lazy');
	frame.srcdoc = doc;
	frame.addEventListener('load', () => {
		host.querySelector('.dlive-skeleton')?.remove();
		state.panel.querySelector('.dlive-chip').textContent = 'Live';
	});
	host.appendChild(frame);
}

function runScript(state, btn) {
	state.busy = true;
	btn.classList.add('is-busy');
	openPanel(state, `
		<div class="dlive-panel-head">
			<span class="dlive-chip dlive-chip-run">Running</span>
			<span class="dlive-meta">Sandboxed module frame · console captured</span>
			<button type="button" class="dlive-btn dlive-panel-close" aria-label="Close output">${I.close}</button>
		</div>
		<div class="dlive-console" role="log"></div>`);

	const out = state.panel.querySelector('.dlive-console');
	const frame = document.createElement('iframe');
	frame.setAttribute('sandbox', 'allow-scripts');
	frame.style.display = 'none';
	frame.srcdoc = buildScriptDoc(state.current, { origin: location.origin });

	let settled = false;
	const finish = (note) => {
		if (settled) return;
		settled = true;
		state.busy = false;
		btn.classList.remove('is-busy');
		window.removeEventListener('message', onMessage);
		clearTimeout(timer);
		frame.remove();
		const chip = state.panel.querySelector('.dlive-chip');
		if (chip) {
			chip.textContent = note;
			chip.className = `dlive-chip ${note === 'Timed out' ? 'dlive-chip-warn' : 'dlive-chip-ok'}`;
		}
		if (!out.childElementCount) {
			out.innerHTML = '<div class="dlive-line dlive-line-muted">Ran with no console output.</div>';
		}
	};

	const onMessage = (event) => {
		const data = event.data;
		if (!data || data.__docsLive !== true) return;
		if (event.source !== frame.contentWindow) return;
		if (data.level === 'done') return finish('Finished');
		const line = document.createElement('div');
		line.className = `dlive-line dlive-line-${data.level}`;
		line.textContent = data.text;
		out.appendChild(line);
	};

	window.addEventListener('message', onMessage);
	const timer = setTimeout(() => finish('Timed out'), SCRIPT_TIMEOUT_MS);
	state.panel.appendChild(frame);
}

async function runRequest(state, btn) {
	const parsed = parseCurl(state.current);
	if (!parsed) return;
	const request = applyPlaceholders(parsed, collectValues(state));
	const verdict = assessRequest(request, { origin: location.origin });

	if (!verdict.ok) {
		openPanel(state, errorPanel('Not runnable', verdict.reason));
		return;
	}

	// A non-GET sample is armed on the first click and sent on the second. The
	// docs runner is the one place on the site where a reader can fire a write
	// without having meant to, so the second click is the consent.
	if (verdict.confirm && !state.armed) {
		state.armed = true;
		btn.classList.add('dlive-btn-warn');
		btn.querySelector('span').textContent = `Confirm ${request.method}`;
		openPanel(state, `
			<div class="dlive-panel-head">
				<span class="dlive-chip dlive-chip-warn">Confirm</span>
				<span class="dlive-meta">${escapeHtml(request.method)} ${escapeHtml(verdict.url)}</span>
				<button type="button" class="dlive-btn dlive-panel-close" aria-label="Cancel">${I.close}</button>
			</div>
			<p class="dlive-note">This writes to the live API. Click <strong>Confirm ${escapeHtml(request.method)}</strong> to send it, or close this to cancel.</p>`);
		state.panel.querySelector('.dlive-panel-close').addEventListener('click', () => disarm(state, btn), { once: true });
		return;
	}
	disarm(state, btn);

	state.busy = true;
	btn.classList.add('is-busy');
	openPanel(state, `
		<div class="dlive-panel-head">
			<span class="dlive-chip dlive-chip-run">Sending</span>
			<span class="dlive-meta">${escapeHtml(request.method)} ${escapeHtml(verdict.url)}</span>
			<button type="button" class="dlive-btn dlive-panel-close" aria-label="Close response">${I.close}</button>
		</div>
		<div class="dlive-skeleton dlive-skeleton-lines" aria-hidden="true"></div>`);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	const started = performance.now();

	try {
		const headers = { ...request.headers };
		// The reader's three.ws session must not silently authorize a sample.
		// Docs requests are anonymous unless the sample itself carries a key.
		const res = await fetch(verdict.url, {
			method: request.method,
			headers,
			body: request.body == null ? undefined : request.body,
			credentials: 'omit',
			signal: controller.signal,
		});
		const text = await res.text();
		const ms = performance.now() - started;
		renderResponse(state, { res, text, ms, url: verdict.url, method: request.method });
	} catch (err) {
		const aborted = err && err.name === 'AbortError';
		openPanel(
			state,
			errorPanel(
				aborted ? 'Timed out' : 'Request failed',
				aborted
					? `No response in ${formatDuration(REQUEST_TIMEOUT_MS)}. The endpoint may be cold or rate limited.`
					: `${String(err && err.message ? err.message : err)}. If this is a cross-origin call the endpoint may not send CORS headers; copy the command and run it in a terminal.`,
			),
		);
	} finally {
		clearTimeout(timer);
		state.busy = false;
		btn.classList.remove('is-busy');
	}
}

function disarm(state, btn) {
	if (!state.armed) return;
	state.armed = false;
	btn.classList.remove('dlive-btn-warn');
	setRunLabel(btn, state);
}

function renderResponse(state, { res, text, ms, url, method }) {
	const contentType = res.headers.get('content-type') || '';
	const body = formatResponseBody(text, { contentType });
	const tone = statusTone(res.status);
	const bytes = new TextEncoder().encode(text).byteLength;

	const headerRows = [...res.headers.entries()]
		.map(([k, v]) => `<div class="dlive-hrow"><span>${escapeHtml(k)}</span><span>${escapeHtml(v)}</span></div>`)
		.join('');

	openPanel(state, `
		<div class="dlive-panel-head">
			<span class="dlive-chip dlive-chip-${tone}">${res.status} ${escapeHtml(res.statusText || '')}</span>
			<span class="dlive-meta">${escapeHtml(method)} ${escapeHtml(url)}</span>
			<span class="dlive-stats">${formatDuration(ms)} · ${formatBytes(bytes)}</span>
			<button type="button" class="dlive-btn dlive-panel-close" aria-label="Close response">${I.close}</button>
		</div>
		${res.status === 402 ? '<p class="dlive-note">This endpoint is paid (x402). The 402 body describes the price and how to settle it.</p>' : ''}
		<pre class="dlive-out"><code class="language-${escapeAttr(body.language)}">${escapeHtml(body.text)}</code></pre>
		${headerRows ? `<details class="dlive-headers"><summary>Response headers</summary>${headerRows}</details>` : ''}`);

	const out = state.panel.querySelector('.dlive-out code');
	if (out && window.hljs && window.hljs.getLanguage(body.language)) {
		try {
			out.innerHTML = window.hljs.highlight(body.text, { language: body.language }).value;
		} catch {
			/* the escaped text above is already correct */
		}
	}
}

function errorPanel(title, message) {
	return `
		<div class="dlive-panel-head">
			<span class="dlive-chip dlive-chip-err">${escapeHtml(title)}</span>
			<button type="button" class="dlive-btn dlive-panel-close" aria-label="Close">${I.close}</button>
		</div>
		<p class="dlive-note">${escapeHtml(message)}</p>`;
}

function openPanel(state, html) {
	state.panel.innerHTML = html;
	state.panel.hidden = false;
	const close = state.panel.querySelector('.dlive-panel-close');
	if (close) {
		close.addEventListener('click', () => {
			state.panel.hidden = true;
			state.panel.innerHTML = '';
		});
	}
}

function currentTheme() {
	return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

// ── One-time hint ────────────────────────────────────────────────────────────

// The badge alone does not tell a first-time reader that anything on the page
// is interactive. One dismissible line, once per browser, does.
function showHintOnce(scope) {
	try {
		if (localStorage.getItem(HINT_KEY)) return;
	} catch {
		return; // no storage — do not nag on every navigation
	}
	const first = (scope.querySelector ? scope : document).querySelector('.dlive');
	if (!first || document.querySelector('.dlive-hint')) return;

	const hint = document.createElement('div');
	hint.className = 'dlive-hint';
	hint.setAttribute('role', 'note');
	hint.innerHTML = `
		<span class="dlive-hint-icon">${I.spark}</span>
		<span>Samples on this page are live. Press <kbd>Edit</kbd>, change anything, then <kbd>${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}</kbd>+<kbd>Enter</kbd> to run it for real.</span>
		<button type="button" class="dlive-hint-close" aria-label="Dismiss">${I.close}</button>`;
	first.parentNode.insertBefore(hint, first);
	hint.querySelector('.dlive-hint-close').addEventListener('click', () => {
		hint.remove();
		try {
			localStorage.setItem(HINT_KEY, '1');
		} catch {
			/* dismissed for this view */
		}
	});
}

// ── Escaping ─────────────────────────────────────────────────────────────────

function escapeHtml(text) {
	return String(text == null ? '' : text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function escapeAttr(text) {
	return escapeHtml(text).replace(/"/g, '&quot;');
}

export default { enhance };
