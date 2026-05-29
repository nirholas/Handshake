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
	requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
}

function setTab(totalAtomics, count) {
	tabAmount.textContent = usd(totalAtomics);
	tabCount.textContent = `${count} answer${count === 1 ? '' : 's'}`;
	endBtn.disabled = count === 0;
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
		b.addEventListener('click', () => { qEl.value = result.followUp; qEl.focus(); autosize(); });
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

	try {
		if (!window.X402 || typeof window.X402.pay !== 'function') {
			throw new Error('Payment library failed to load. Refresh and try again.');
		}
		const out = await window.X402.pay({
			endpoint: TUTOR_ENDPOINT,
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
		addTutor(result);
		setTab(result.sessionTotal, result.questionCount);
	} catch (err) {
		const msg = String(err?.message || err || 'Something went wrong.');
		// A user-cancelled wallet prompt is not an error worth alarming over.
		if (/cancel|reject|denied|closed/i.test(msg)) {
			addError('Payment cancelled — no charge. Ask again when ready.');
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
	scrim.classList.add('open');

	// A closed session starts fresh next time.
	const fresh = crypto.randomUUID();
	sessionId = fresh;
	localStorage.setItem(STORAGE_KEY, fresh);
	setTab(0, 0);
}

// ── session resume ─────────────────────────────────────────────────────────────

async function resume() {
	try {
		const r = await fetch(`${SESSION_ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`);
		if (!r.ok) return;
		const s = await r.json();
		if (s.status === 'closed' || !s.lineItems || !s.lineItems.length) return;
		for (const li of s.lineItems) addHistory(li.question, li.costUsd);
		setTab(s.totalAtomics, s.questionCount);
		scrollDown();
	} catch {
		// Resume is best-effort.
	}
}

// ── wiring ───────────────────────────────────────────────────────────────────

function autosize() {
	qEl.style.height = 'auto';
	qEl.style.height = Math.min(qEl.scrollHeight, 180) + 'px';
}

qEl.addEventListener('input', autosize);
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
$('invoice-close').addEventListener('click', () => scrim.classList.remove('open'));
scrim.addEventListener('click', (e) => { if (e.target === scrim) scrim.classList.remove('open'); });

resume();
qEl.focus();
