// Pay-As-You-Learn Tutor — front-end.
//
// Each question is one $0.01 x402 micropayment via window.X402.pay (the shared
// paywall/wallet helper loaded from /x402.js). Answers render with their cost;
// a running session tab persists across reloads (sessionId in localStorage) and
// the session can be closed into an itemized, attested invoice.

const TUTOR_ENDPOINT = '/api/x402/tutor';
const SESSION_ENDPOINT = '/api/tutor/session';
const STORAGE_KEY = 'three-tutor-session-id';

const $ = (id) => document.getElementById(id);
const thread = $('thread');
const empty = $('empty');
const form = $('composer');
const qEl = $('q');
const levelEl = $('level');
const sendBtn = $('send');
const endBtn = $('end-btn');
const qCount = $('q-count');
const tabAmount = $('tab-amount');
const tabCount = $('tab-count');
const scrim = $('scrim');

let sessionId = localStorage.getItem(STORAGE_KEY) || crypto.randomUUID();
localStorage.setItem(STORAGE_KEY, sessionId);
let busy = false;

// ── helpers ──────────────────────────────────────────────────────────────────

function usd(atomics) {
	return '$' + (Number(atomics) / 1_000_000).toFixed(2);
}
function usdFromString(s) {
	const n = Number(s);
	return Number.isFinite(n) ? '$' + n.toFixed(2) : s;
}
function el(tag, cls, html) {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	if (html != null) n.innerHTML = html;
	return n;
}
function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function clearEmpty() {
	if (empty && empty.parentNode) empty.remove();
}
function scrollDown() {
	requestAnimationFrame(() => {
		const h = document.body?.scrollHeight ?? document.documentElement.scrollHeight;
		window.scrollTo({ top: h, behavior: 'smooth' });
	});
}

// The running tab is live data. It is rendered from translated templates held on
// the element's own attributes rather than a data-i18n key, because the i18n pass
// rewrites the text of every keyed element after this module has already run: a
// resumed session would show its real total next to a permanent "0 answers".
let tabTotal = 0;
let tabAnswers = 0;

function answersLabel(count) {
	const attr = count === 1 ? 'data-count-one' : 'data-count-other';
	const template = tabCount.getAttribute(attr) || (count === 1 ? '{n} answer' : '{n} answers');
	return template.replace('{n}', String(count));
}

function renderTab() {
	tabAmount.textContent = usd(tabTotal);
	tabCount.textContent = answersLabel(tabAnswers);
	endBtn.disabled = tabAnswers === 0;
}

function setTab(totalAtomics, count) {
	tabTotal = Number(totalAtomics) || 0;
	tabAnswers = Number(count) || 0;
	renderTab();
}

// Re-render once the catalog lands, and again on every language switch, so the
// count is localized without the catalog ever owning the number itself.
window.addEventListener('i18n:change', renderTab);

// The paywall helper (/x402.js) and this module both load async with no ordering
// guarantee, so an early ask can race ahead of window.X402.pay being defined.
// Wait briefly for it before treating its absence as a real load failure.
function x402Ready() {
	return !!(window.X402 && typeof window.X402.pay === 'function');
}
function waitForX402(timeoutMs = 6000) {
	if (x402Ready()) return Promise.resolve(true);
	return new Promise((resolve) => {
		const start = Date.now();
		const timer = setInterval(() => {
			if (x402Ready()) {
				clearInterval(timer);
				resolve(true);
			} else if (Date.now() - start >= timeoutMs) {
				clearInterval(timer);
				resolve(false);
			}
		}, 120);
	});
}

// ── rendering ──────────────────────────────────────────────────────────────────

function addUser(text) {
	clearEmpty();
	const m = el('div', 'msg user');
	m.append(el('div', 'who', 'You'), el('div', 'bubble', escapeHtml(text)));
	thread.append(m);
	scrollDown();
}

function addTutor(result) {
	const m = el('div', 'msg tutor');
	m.append(el('div', 'who', 'Tutor'));
	const bubble = el('div', 'bubble');
	bubble.append(el('div', null, escapeHtml(result.answer)));

	if (Array.isArray(result.keyPoints) && result.keyPoints.length) {
		const kp = el('div', 'kp');
		kp.append(el('h4', null, 'Key points'));
		const ul = el('ul');
		for (const p of result.keyPoints) ul.append(el('li', null, escapeHtml(p)));
		kp.append(ul);
		bubble.append(kp);
	}
	if (result.example) {
		const ex = el('div', 'ex');
		ex.append(el('pre', null, escapeHtml(result.example)));
		bubble.append(ex);
	}
	if (result.followUp) {
		const fu = el('div', 'followup');
		fu.innerHTML = 'Next: ';
		const b = el('button', null, escapeHtml(result.followUp));
		b.type = 'button';
		b.addEventListener('click', () => { qEl.value = result.followUp; qEl.focus(); autosize(); updateCount(); });
		fu.append(b);
		bubble.append(fu);
	}
	m.append(bubble);

	const meta = el('div', 'meta');
	meta.append(
		el('span', 'cost', usdFromString(result.costThisChargeUsd) + ' · paid'),
		el('span', 'pill', escapeHtml(result.level)),
		el('span', 'pill', escapeHtml(result.model || 'llm')),
	);
	m.append(meta);
	thread.append(m);
	scrollDown();
}

// Placeholder for the answer being generated. Returned so the caller can swap it
// out for the real reply (or drop it) the moment the paid call settles.
function addPending() {
	const m = el('div', 'msg tutor pending');
	m.setAttribute('aria-busy', 'true');
	m.append(el('div', 'who', 'Tutor'));
	const bubble = el('div', 'bubble');
	bubble.append(el('span', 'sk'), el('span', 'sk w80'), el('span', 'sk w60'));
	m.append(bubble);
	const meta = el('div', 'meta');
	meta.append(el('span', null, 'Writing your explanation…'));
	m.append(meta);
	thread.append(m);
	scrollDown();
	return m;
}

function addError(text) {
	clearEmpty();
	const m = el('div', 'msg error');
	m.append(el('div', 'who', 'Payment / error'), el('div', 'bubble', escapeHtml(text)));
	thread.append(m);
	scrollDown();
}

function addHistory(question, costUsd) {
	clearEmpty();
	const m = el('div', 'msg user');
	m.append(el('div', 'who', 'You · earlier'), el('div', 'bubble', escapeHtml(question)));
	const meta = el('div', 'meta');
	meta.append(el('span', 'cost', usdFromString(costUsd) + ' · paid'));
	m.append(meta);
	thread.append(m);
}

// ── send (the paid action) ───────────────────────────────────────────────────

async function ask(question) {
	if (busy) return;
	const text = question.trim();
	if (text.length < 5) return;

	busy = true;
	sendBtn.disabled = true;
	const original = sendBtn.innerHTML;
	sendBtn.innerHTML = '<span class="spin"></span>';
	addUser(text);
	qEl.value = '';
	autosize();
	updateCount();
	const pending = addPending();

	try {
		if (!x402Ready()) {
			// Give the async-loading paywall helper a short grace window before we
			// declare it failed — the first question often beats /x402.js finishing.
			const ready = await waitForX402();
			if (!ready) {
				throw new Error('Payment library failed to load. Refresh and try again.');
			}
		}
		const out = await window.X402.pay({
			endpoint: TUTOR_ENDPOINT,
			method: 'POST',
			body: { sessionId, question: text, level: levelEl.value },
			merchant: 'three.ws Tutor',
			action: 'Explain',
		});
		const result = out?.result;
		if (!out?.ok || !result) {
			throw new Error(out?.error || 'Payment did not complete.');
		}
		// The server may mint a fresh sessionId on the first call.
		if (result.sessionId && result.sessionId !== sessionId) {
			sessionId = result.sessionId;
			localStorage.setItem(STORAGE_KEY, sessionId);
		}
		pending.remove();
		addTutor(result);
		setTab(result.sessionTotal, result.questionCount);
	} catch (err) {
		pending.remove();
		const msg = String(err?.message || err || 'Something went wrong.');
		// A user-cancelled wallet prompt is not an error worth alarming over.
		if (/cancel|reject|denied|closed/i.test(msg)) {
			addError('Payment cancelled. No charge was made, so ask again whenever you are ready.');
		} else {
			addError(msg);
		}
	} finally {
		busy = false;
		sendBtn.disabled = false;
		sendBtn.innerHTML = original;
		qEl.focus();
	}
}

// ── invoice ──────────────────────────────────────────────────────────────────

async function endSession() {
	endBtn.disabled = true;
	try {
		const r = await fetch(SESSION_ENDPOINT, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ sessionId, action: 'end' }),
		});
		if (!r.ok) throw new Error('Could not load invoice');
		const inv = await r.json();
		renderInvoice(inv);
	} catch (err) {
		addError(String(err?.message || err));
		endBtn.disabled = false;
	}
}

// The invoice is a modal dialog, so it has to behave like one for a keyboard
// user: focus moves into it on open, Escape dismisses it, and focus returns to
// the control that opened it rather than being stranded behind the scrim.
let invoiceOpener = null;

function openInvoice() {
	// endSession() disables "End & invoice" before the invoice renders, and the
	// browser drops focus to <body> when the focused element is disabled. <body>
	// is not a restore target, so record it as "nothing to go back to".
	const active = document.activeElement;
	invoiceOpener = active && active !== document.body ? active : null;
	scrim.classList.add('open');
	$('invoice-close').focus();
}

function closeInvoice() {
	if (!scrim.classList.contains('open')) return;
	scrim.classList.remove('open');
	// Closing the session disables "End & invoice", and focusing a disabled button
	// silently drops focus to <body>; fall back to the composer so the keyboard
	// user lands somewhere useful.
	const opener = invoiceOpener;
	const back = opener && opener.isConnected && !opener.disabled ? opener : qEl;
	invoiceOpener = null;
	back.focus();
}

function renderInvoice(inv) {
	const lines = $('invoice-lines');
	lines.innerHTML = '';
	if (!inv.lineItems || !inv.lineItems.length) {
		lines.append(el('p', null, 'No questions in this session.'));
	} else {
		for (const li of inv.lineItems) {
			const line = el('div', 'line');
			line.append(
				el('span', 'n', String(li.n)),
				el('span', 'q', escapeHtml(li.question)),
				el('span', 'c', '$' + Number(li.costUsd).toFixed(2)),
			);
			lines.append(line);
		}
	}
	$('invoice-total').textContent = '$' + Number(inv.totalUsd).toFixed(2);
	$('invoice-attest').textContent = inv.attestation || '';
	openInvoice();

	// A closed session starts fresh next time.
	const fresh = crypto.randomUUID();
	sessionId = fresh;
	localStorage.setItem(STORAGE_KEY, fresh);
	setTab(0, 0);
}

// ── session resume ─────────────────────────────────────────────────────────────

function addNotice(text, retry) {
	clearEmpty();
	const m = el('div', 'msg notice');
	m.append(el('div', 'who', 'Session'));
	const bubble = el('div', 'bubble');
	bubble.append(el('div', null, escapeHtml(text)));
	if (retry) {
		const b = el('button', 'notice-retry', 'Try again');
		b.type = 'button';
		b.addEventListener('click', () => { m.remove(); retry(); });
		bubble.append(b);
	}
	m.append(bubble);
	thread.append(m);
}

async function resume() {
	// Only attempt a resume when there is a real prior session to restore — a
	// freshly-minted id (no server record yet) legitimately returns nothing and
	// must stay silent. A genuine fetch/HTTP failure, by contrast, is surfaced so
	// the user isn't left staring at a blank thread wondering where their history went.
	let r;
	try {
		r = await fetch(`${SESSION_ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`);
	} catch {
		addNotice(
			'Couldn’t reach your previous session, so your history may be temporarily unavailable. You can still ask new questions.',
			resume,
		);
		return;
	}
	// A 5xx/4xx from the session store is a genuine failure worth surfacing. (An
	// unknown id is NOT an error here — the endpoint returns 200 with no line items,
	// handled silently below.)
	if (!r.ok) {
		addNotice(
			'Your previous session is temporarily unavailable (server error). You can still ask new questions.',
			resume,
		);
		return;
	}
	let s;
	try {
		s = await r.json();
	} catch {
		addNotice(
			'Your previous session couldn’t be read back. You can still ask new questions.',
			resume,
		);
		return;
	}
	if (s.status === 'closed' || !s.lineItems || !s.lineItems.length) return;
	for (const li of s.lineItems) addHistory(li.question, li.costUsd);
	setTab(s.totalAtomics, s.questionCount);
	scrollDown();
}

// ── wiring ───────────────────────────────────────────────────────────────────

const Q_MAX = Number(qEl.getAttribute('maxlength')) || 2000;
function autosize() {
	qEl.style.height = 'auto';
	qEl.style.height = Math.min(qEl.scrollHeight, 180) + 'px';
}
function updateCount() {
	if (!qCount) return;
	const len = qEl.value.length;
	qCount.textContent = `${len} / ${Q_MAX}`;
	qCount.classList.toggle('warn', len >= Q_MAX * 0.9 && len < Q_MAX);
	qCount.classList.toggle('max', len >= Q_MAX);
}

qEl.addEventListener('input', () => { autosize(); updateCount(); });
qEl.addEventListener('keydown', (e) => {
	if (e.key === 'Enter' && !e.shiftKey) {
		e.preventDefault();
		form.requestSubmit();
	}
});
form.addEventListener('submit', (e) => {
	e.preventDefault();
	ask(qEl.value);
});
$('suggestions')?.addEventListener('click', (e) => {
	const b = e.target.closest('.suggestion');
	if (b) ask(b.textContent);
});
endBtn.addEventListener('click', endSession);
$('invoice-close').addEventListener('click', closeInvoice);
scrim.addEventListener('click', (e) => { if (e.target === scrim) closeInvoice(); });
document.addEventListener('keydown', (e) => {
	if (e.key === 'Escape') closeInvoice();
});

// ── mobile soft-keyboard: keep the composer above the keyboard ──────────────────
// When the on-screen keyboard opens, some mobile browsers overlay it on top of the
// layout viewport without resizing it, hiding a sticky bottom composer. The
// VisualViewport API reports the actually-visible region; we lift the composer by
// the difference so it stays in view, and keep the caret scrolled into view.
(function initKeyboardAware() {
	const vv = window.visualViewport;
	if (!vv) return; // older browsers: sticky positioning is the graceful fallback
	let raf = 0;
	function apply() {
		raf = 0;
		// How much of the layout viewport is hidden below the visual viewport —
		// i.e. the keyboard's height when open, 0 when closed.
		const hidden = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
		document.documentElement.style.setProperty('--kb-offset', hidden > 60 ? `${hidden}px` : '0px');
	}
	function schedule() {
		if (!raf) raf = requestAnimationFrame(apply);
	}
	vv.addEventListener('resize', schedule);
	vv.addEventListener('scroll', schedule);
	qEl.addEventListener('focus', () => {
		schedule();
		// Let the keyboard settle, then bring the caret into view.
		setTimeout(() => qEl.scrollIntoView({ block: 'nearest' }), 250);
	});
	qEl.addEventListener('blur', () => {
		document.documentElement.style.setProperty('--kb-offset', '0px');
	});
})();

resume();
updateCount();
qEl.focus();
