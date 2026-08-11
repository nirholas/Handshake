// ── agent-exchange.js ────────────────────────────────────────────────────────
// Two 3D AI avatars buying and selling live crypto intel for real USDC via x402.
// Agent A (seller) hosts /api/x402/crypto-intel. Agent B (buyer) pays $0.01 per
// call through the server-side x402 payer at /api/x402-pay, which probes the 402
// challenge, signs the Solana transfer, replays the request with the payment,
// and streams each step back as SSE events.
//
// The stage strip below mirrors those SSE events one-for-one. It deliberately
// carries no step the server does not report: an x402 purchase of an external
// route verifies and settles inside the paid request itself, so there is no
// separate verify or dispatch signal to show.
//
// Every on-chain confirmation is real: real USDC on Solana mainnet, real Solscan
// link. The avatars are iframed into the page and driven via postMessage.
//
// No mock data. When /api/x402-pay is unconfigured (no funded agent wallet) the
// page shows an honest error state.

import { formatUsdcEq } from './shared/usd-price.js';

// ── Topics ────────────────────────────────────────────────────────────────────
const TOPICS = [
	{ id: 'sol',  label: '◎ SOL'  },
	{ id: 'btc',  label: '₿ BTC'  },
	{ id: 'eth',  label: '⟠ ETH'  },
	{ id: 'bnb',  label: '⬡ BNB'  },
];

// Stage config matches the SSE event names /api/x402-pay emits, one stage per
// event, plus the terminal 'done' the client resolves once the result lands.
// narration: plain-language line shown to the viewer as each stage arrives.
const STAGE_DEFS = [
	{ id: 'challenge',  label: '402 Challenge', narration: 'The intel agent answered with a $0.01 USDC payment challenge. The buyer is building a Solana transaction.' },
	{ id: 'built',      label: 'Sign tx',       narration: 'Transaction signed. Replaying the request with the payment attached…' },
	{ id: 'settled',    label: 'Settle',        narration: 'Settling USDC on Solana mainnet. A real on-chain transfer is confirming.' },
	{ id: 'done',       label: 'Confirmed',     narration: 'Confirmed on-chain. Intel delivered.' },
];

// Terminal failure stage: rendered alongside the flow stages but hidden until
// a payment errors out, times out, or is rejected. It always reflects the final
// failure reason so the viewer sees exactly where the exchange stopped.
const ERROR_STAGE = { id: 'failed', label: 'Failed', narration: 'Payment did not complete. No funds were moved.' };

// How long a single x402-pay request may run before we abort it and surface a
// timeout. The full challenge to settle flow is fast; 30s covers a slow
// facilitator or RPC without leaving the viewer staring at a hung "Paying…"
// button.
const PAY_TIMEOUT_MS = 30000;

// Agent scripts: lines spoken at each stage of the exchange.
const LINES = {
	A: {
		idle:      'I have live crypto intel. $0.01 USDC per signal, settled on-chain.',
		challenge: 'Payment challenge issued. Awaiting your signed transaction…',
		built:     'Transaction received. Verifying and settling now…',
		settled:   'Funds confirmed on-chain. Delivering now.',
		done:      (headline) => `Here's your signal: ${headline}`,
		error:     'Payment failed. No charge made.',
	},
	B: {
		idle:      (topic) => `I need live ${topic.toUpperCase()} intelligence. Initiating payment.`,
		challenge: 'Building and signing the Solana transfer…',
		built:     'Signed. Sending the paid request through.',
		settled:   'Settled. Collecting my intel.',
		done:      (signal) => `Signal received: ${signal.toUpperCase()}. Updating my model.`,
		error:     'Transaction rolled back. Wallet unchanged.',
	},
};

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const els = {
	frameA:    $('frameA'),
	frameB:    $('frameB'),
	labelA:    $('labelA'),
	labelB:    $('labelB'),
	nameA:     $('nameA'),
	nameB:     $('nameB'),
	bubbleA:   $('bubbleA'),
	bubbleAText: $('bubbleAText'),
	bubbleB:   $('bubbleB'),
	bubbleBText: $('bubbleBText'),
	topics:    $('topics'),
	payBtn:    $('payBtn'),
	stages:      $('stages'),
	receipt:     $('receipt'),
	narration:   $('narration'),
	walletState: $('walletState'),
};

// #txTicker and #payBtn both carry data-i18n-html, so the runtime translator
// swaps their innerHTML after first paint and any child captured at init would
// become a detached node that silently stops updating. Resolve these two at use
// time instead of caching them.
const totalUsdc = () => $('totalUsdc');
function setPayLabel(text) {
	const lbl = els.payBtn.querySelector('.lbl');
	if (lbl) lbl.textContent = text;
}

// ── State ─────────────────────────────────────────────────────────────────────
let activeTopic    = 'sol';
let busy           = false;
let sessionTotal   = 0; // USDC in dollars
let agentAReady    = false;
let agentBReady    = false;
const queueA       = [];
const queueB       = [];

// ── Avatar iframe driver ──────────────────────────────────────────────────────
function postToFrame(frame, ready, queue, msg) {
	if (ready) {
		frame.contentWindow?.postMessage(msg, location.origin);
	} else {
		queue.push(msg);
	}
}
function speakA(text) { postToFrame(els.frameA, agentAReady, queueA, { type: 'v1.avatar.speak', text }); }
function speakB(text) { postToFrame(els.frameB, agentBReady, queueB, { type: 'v1.avatar.speak', text }); }
function gestureA(name) { postToFrame(els.frameA, agentAReady, queueA, { type: 'v1.avatar.animation', name }); }
function gestureB(name) { postToFrame(els.frameB, agentBReady, queueB, { type: 'v1.avatar.animation', name }); }
function flushQueue(frame, queue) { while (queue.length) frame.contentWindow?.postMessage(queue.shift(), location.origin); }

window.addEventListener('message', (e) => {
	if (e.data?.type !== 'v1.avatar.ready') return;
	if (e.source === els.frameA.contentWindow) { agentAReady = true; flushQueue(els.frameA, queueA); }
	if (e.source === els.frameB.contentWindow) { agentBReady = true; flushQueue(els.frameB, queueB); }
});
// Resilience: if the avatar never signals ready, flush after 5 s.
setTimeout(() => {
	if (!agentAReady) { agentAReady = true; flushQueue(els.frameA, queueA); }
	if (!agentBReady) { agentBReady = true; flushQueue(els.frameB, queueB); }
}, 5000);

// ── Speech bubbles ────────────────────────────────────────────────────────────
let bubbleATimer, bubbleBTimer;
function sayA(text) {
	els.bubbleAText.textContent = text;
	els.bubbleA.classList.add('show');
	clearTimeout(bubbleATimer);
	bubbleATimer = setTimeout(() => els.bubbleA.classList.remove('show'), 5500);
	speakA(text);
}
function sayB(text) {
	els.bubbleBText.textContent = text;
	els.bubbleB.classList.add('show');
	clearTimeout(bubbleBTimer);
	bubbleBTimer = setTimeout(() => els.bubbleB.classList.remove('show'), 5500);
	speakB(text);
}

// ── Payment stages ────────────────────────────────────────────────────────────
function renderStages() {
	const stageEl = (s, extra = '') =>
		`<div class="stage${extra}" id="stage-${s.id}">` +
		`<span class="si" aria-hidden="true"></span>` +
		`<span>${s.label}</span>` +
		`<span class="sval" id="sval-${s.id}"></span>` +
		`</div>`;
	// Flow stages, then the terminal failure stage (hidden until a payment fails).
	els.stages.innerHTML =
		STAGE_DEFS.map((s) => stageEl(s)).join('') +
		stageEl(ERROR_STAGE, ' stage-terminal');
	hideErrorStage();
}

// The terminal failure stage is only meaningful when something went wrong, so it
// stays out of the flow until showErrorStage() promotes it.
function showErrorStage(reason) {
	const el = $(`stage-${ERROR_STAGE.id}`);
	if (!el) return;
	el.hidden = false;
	el.className = 'stage stage-terminal error';
	const sv = $(`sval-${ERROR_STAGE.id}`);
	if (sv) sv.textContent = reason ? `· ${reason}` : '';
}

function hideErrorStage() {
	const el = $(`stage-${ERROR_STAGE.id}`);
	if (!el) return;
	el.hidden = true;
	el.className = 'stage stage-terminal';
	const sv = $(`sval-${ERROR_STAGE.id}`);
	if (sv) sv.textContent = '';
}

function setStage(id, state, val = '') {
	const el = $(`stage-${id}`);
	if (!el) return;
	el.className = `stage ${state}`;
	const sv = $(`sval-${id}`);
	if (sv) sv.textContent = val ? `· ${val}` : '';
}

function resetStages() {
	for (const s of STAGE_DEFS) setStage(s.id, '');
	hideErrorStage();
	els.receipt.classList.remove('show');
}

// ── Receipt renderer ──────────────────────────────────────────────────────────
// Signal classes are looked up, never interpolated: the signal string comes off
// the wire, and a class name is one of the few places escHtml cannot help.
const SIGNAL_CLASS = { bullish: 'signal-bullish', bearish: 'signal-bearish', neutral: 'signal-neutral' };
const SIGNAL_GLYPH = { bullish: '▲', bearish: '▼', neutral: '→' };

// Solana signatures and addresses are base58. Anything else is not a value we
// will put in an href or a receipt field.
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;
function shortB58(v, head, tail) {
	const s = typeof v === 'string' ? v : '';
	if (!BASE58_RE.test(s)) return 'unavailable';
	return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function renderReceipt(payment, intel) {
	const humanAmount = payment.amount ? Number(payment.amount) / 1e6 : 0.01;
	const amountStr   = `${humanAmount.toFixed(4)} USDC`;
	const usdEqStr    = formatUsdcEq(humanAmount);
	const amount      = usdEqStr ? `${escHtml(amountStr)} <span style="color:rgba(255,255,255,.45);font-size:0.9em">${escHtml(usdEqStr)}</span>` : escHtml(amountStr);
	const payer     = escHtml(shortB58(payment.payer, 8, 4));
	const payTo     = escHtml(shortB58(payment.payTo, 8, 4));
	const tx        = typeof payment.tx === 'string' && BASE58_RE.test(payment.tx) ? payment.tx : null;
	const txShort   = tx ? escHtml(shortB58(tx, 10, 6)) : null;
	const explorer  = tx ? `https://solscan.io/tx/${encodeURIComponent(tx)}` : null;
	const signal    = SIGNAL_CLASS[intel.signal] ? intel.signal : 'neutral';
	const signalCls = SIGNAL_CLASS[signal];
	const signalGlyph = SIGNAL_GLYPH[signal];

	const changeStr = Number.isFinite(intel.change_24h)
		? ` ${intel.change_24h >= 0 ? '+' : ''}${intel.change_24h.toFixed(2)}% 24h`
		: '';
	const priceStr = Number.isFinite(intel.price_usd)
		? ` · $${intel.price_usd >= 100 ? intel.price_usd.toFixed(2) : intel.price_usd.toFixed(4)}`
		: '';

	els.receipt.innerHTML =
		`<div class="r-head">` +
		`<span class="r-badge">` +
		`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>` +
		`Confirmed on-chain · ${amount}</span>` +
		`<span class="r-time">${escHtml(new Date().toLocaleTimeString())}</span>` +
		`</div>` +
		`<div class="r-grid">` +
		`<div class="rf"><span class="k">Payer (buyer agent)</span><span class="v">${payer}</span></div>` +
		`<div class="rf"><span class="k">Payee (intel agent)</span><span class="v">${payTo}</span></div>` +
		`<div class="rf"><span class="k">Network</span><span class="v">Solana mainnet</span></div>` +
		(txShort && explorer
			? `<div class="rf"><span class="k">Transaction</span><span class="v"><a href="${explorer}" target="_blank" rel="noopener">${txShort} ↗</a></span></div>`
			: '') +
		`</div>` +
		`<div class="r-headline">` +
		`<span class="r-signal ${signalCls}">${signalGlyph} ${escHtml(signal.toUpperCase())}</span>` +
		`<strong>${escHtml(String(intel.topic || '').toUpperCase())}</strong>${escHtml(priceStr)}${escHtml(changeStr)} · ` +
		escHtml(intel.headline) +
		(intel.rationale ? `<div class="r-rationale">${escHtml(intel.rationale)}</div>` : '') +
		`</div>`;

	els.receipt.classList.add('show');
}

// ── Narration helpers ─────────────────────────────────────────────────────────

function showEmptyState() {
	els.narration.innerHTML =
		`<div class="nr-pre">` +
		`<span class="nr-kicker">What you'll watch:</span>` +
		`<span>Intel Agent issues a $0.01 USDC challenge</span>` +
		`<span class="nr-arrow">→</span>` +
		`<span>Buyer signs a Solana transaction</span>` +
		`<span class="nr-arrow">→</span>` +
		`<span>x402 verifies &amp; settles on-chain</span>` +
		`<span class="nr-arrow">→</span>` +
		`<span>Live crypto intel delivered</span>` +
		`<span class="nr-arrow">·</span>` +
		`<span>No mocks. Real USDC on Solana mainnet.</span>` +
		`</div>`;
}

function narrate(stageId, extra) {
	const s = STAGE_DEFS.find((d) => d.id === stageId);
	if (!s) return;
	const text = extra ? `${s.narration} ${extra}` : s.narration;
	els.narration.innerHTML =
		`<div class="nr-live">` +
		`<span class="nr-dot" aria-hidden="true"></span>` +
		`<span class="nr-text">${escHtml(text)}</span>` +
		`</div>`;
}

function narrateDone(intelObj, paymentObj) {
	const topic = intelObj?.topic?.toUpperCase() || 'Intel';
	const amount = paymentObj?.amount ? (Number(paymentObj.amount) / 1e6).toFixed(4) : '0.0100';
	const txLink = paymentObj?.tx
		? ` <a href="https://solscan.io/tx/${escHtml(paymentObj.tx)}" target="_blank" rel="noopener">View on Solscan ↗</a>`
		: '';
	els.narration.innerHTML =
		`<div class="nr-done">` +
		`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>` +
		`${escHtml(amount)} USDC settled. ${escHtml(topic)} intelligence delivered.${txLink}` +
		`</div>`;
}

async function checkWallet() {
	try {
		const r = await fetch('/api/x402-pay?balance=1');
		if (!r.ok) return;
		const b = await r.json();
		if (!b.configured) {
			els.walletState.className = 'show ws-unconfigured';
			els.walletState.innerHTML =
				`<div class="ws-head">` +
				`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>` +
				`Demo wallet not configured` +
				`</div>` +
				`<div class="ws-body">` +
				`This demo settles real USDC on Solana mainnet. The agent wallet isn't configured right now, so live settlements are paused. ` +
				`To enable: set <span class="ws-mono">X402_AGENT_SOLANA_SECRET_BASE58</span> and fund the wallet.` +
				`</div>`;
			els.payBtn.disabled = true;
		} else if (typeof b.usdc === 'number' && b.usdc < 0.01) {
			const addr = b.address ? `${b.address.slice(0, 8)}…${b.address.slice(-4)}` : 'unavailable';
			els.walletState.className = 'show ws-low';
			els.walletState.innerHTML =
				`<div class="ws-head">` +
				`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>` +
				`Agent wallet low on USDC` +
				`</div>` +
				`<div class="ws-body">` +
				`The buyer wallet holds ${b.usdc.toFixed(4)} USDC, below the $0.01 minimum for a live settlement. ` +
				`Fund <span class="ws-mono">${escHtml(addr)}</span> with USDC on Solana mainnet to run the demo.` +
				`</div>`;
		}
	} catch {
		// Network failures silently ignored so they never block the page.
	}
}

// ── Main payment flow ─────────────────────────────────────────────────────────
async function doPurchase() {
	if (busy) return;
	busy = true;
	els.payBtn.classList.add('busy');
	els.payBtn.disabled = true;
	setPayLabel('Paying…');
	resetStages();

	// Show "initiating" in the narration region immediately.
	els.narration.innerHTML =
		`<div class="nr-live">` +
		`<span class="nr-dot" aria-hidden="true"></span>` +
		`<span class="nr-text">Initiating payment. Connecting to the x402 endpoint…</span>` +
		`</div>`;

	// Both agents react to the initiation.
	const line = LINES.B.idle(activeTopic);
	sayB(line);
	gestureB('wave');
	await delay(600);
	sayA(LINES.A.idle);

	// settled tracks the on-chain settlement info; intel is the purchased signal.
	// Both are populated from SSE events and merged in the 'result' event handler.
	let settled     = null;
	let intel       = null;
	let activeStage = 'challenge';
	let errored     = false;

	// Abort the request if the whole flow stalls past the timeout. The timer is
	// cleared the moment the stream finishes (success or thrown error).
	const ctrl = new AbortController();
	const timeoutId = setTimeout(() => ctrl.abort(), PAY_TIMEOUT_MS);

	try {
		const res = await fetch('/api/x402-pay', {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
			// `endpoint` selects the showcase-pay branch in api/x402-pay.js, which
			// allowlists it server-side and forwards `body` to the paid route.
			body: JSON.stringify({
				endpoint: '/api/x402/crypto-intel',
				body: { topic: activeTopic },
			}),
			signal: ctrl.signal,
		});

		if (!res.ok || !res.body) {
			const text = await res.text().catch(() => '');
			let msg = 'Payment service unavailable.';
			try { msg = JSON.parse(text).error_description || JSON.parse(text).error || msg; } catch { /* ignore */ }
			throw new Error(msg);
		}

		for await (const { event, data } of sseReader(res)) {
			if (event === 'challenge') {
				setStage('challenge', 'done', `${(Number(data.amount) / 1e6).toFixed(4)} USDC`);
				setStage('built', 'active', 'signing…');
				activeStage = 'built';
				narrate('challenge');
				sayB(LINES.B.challenge);
				sayA(LINES.A.challenge);
			} else if (event === 'built') {
				setStage('built', 'done', `${data.build_ms} ms`);
				setStage('settled', 'active', 'on-chain…');
				activeStage = 'settled';
				narrate('built', `(${data.build_ms} ms)`);
				sayB(LINES.B.built);
				sayA(LINES.A.built);
			} else if (event === 'settled') {
				setStage('settled', 'done', `${data.settle_ms} ms · ${data.tx ? data.tx.slice(0, 8) + '…' : ''}`);
				setStage('done', 'active');
				activeStage = 'done';
				settled = data;
				narrate('settled');
				sayB(LINES.B.settled);
				sayA(LINES.A.settled);
			} else if (event === 'result') {
				// result carries { ok, result: <intelObj>, payment: <paymentObj>, resource, durations }
				if (data.result != null) intel = data.result;
				if (data.payment) settled = { ...settled, ...data.payment };
			} else if (event === 'error') {
				errored = true;
				setStage(activeStage, 'error', data.error || 'failed');
				throw new Error(data.error_description || data.error || 'payment failed');
			}
		}

		if (!intel?.signal || !settled) throw new Error('incomplete response from payment service');

		// ── Success choreography ──────────────────────────────
		setStage('done', 'done', 'confirmed');
		narrateDone(intel, settled);

		gestureB('celebrate');
		await delay(300);
		sayB(LINES.B.done(intel.signal));

		await delay(700);
		sayA(LINES.A.done(intel.headline));
		gestureA('wave');

		// Update session total.
		const paidAmount = settled.amount ? Number(settled.amount) / 1e6 : 0.01;
		sessionTotal += paidAmount;
		const ticker = totalUsdc();
		if (ticker) {
			ticker.textContent = `$${sessionTotal.toFixed(2)}`;
			ticker.classList.add('flash');
			setTimeout(() => ticker.classList.remove('flash'), 600);
		}

		renderReceipt(settled, intel);

		// Send focus to the receipt so keyboard + screen-reader users land on the
		// just-confirmed result instead of staying on the pay button.
		focusReceipt();

	} catch (err) {
		// A timeout surfaces as an AbortError; translate it into a clear reason.
		const timedOut = err?.name === 'AbortError';
		const reason = timedOut
			? `No response in ${Math.round(PAY_TIMEOUT_MS / 1000)}s`
			: (err.message || 'Payment failed');

		// Mark whichever stage was in flight as errored (unless the stream already
		// did), then promote the terminal failure stage with the reason.
		if (!errored) setStage(activeStage, 'error', timedOut ? 'timed out' : 'failed');
		showErrorStage(reason);

		sayA(LINES.A.error);
		sayB(LINES.B.error);
		gestureA('idle');

		const headline = timedOut
			? 'Payment timed out, no funds moved'
			: 'Payment failed, no funds moved';
		const body = timedOut
			? 'The payment service did not respond in time. No USDC left the wallet. Pick a topic and try again.'
			: escHtml(reason);
		els.receipt.innerHTML =
			`<div style="background:rgba(255,79,106,.06);border:1px solid rgba(255,79,106,.22);border-radius:10px;padding:12px 14px;">` +
			`<div style="display:flex;align-items:center;gap:7px;font-weight:700;color:var(--red);font-size:13px;margin-bottom:5px;">` +
			`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>` +
			`${escHtml(headline)}` +
			`</div>` +
			`<div style="font-size:12.5px;color:var(--muted);">${body} ` +
			`<a href="/pay" class="ax-x402-link">Learn about x402 →</a>` +
			`</div>` +
			`</div>`;
		els.receipt.classList.add('show');
		focusReceipt();

		// Reset narration to empty state so the viewer knows they can retry.
		showEmptyState();
	} finally {
		clearTimeout(timeoutId);
		busy = false;
		els.payBtn.classList.remove('busy');
		els.payBtn.disabled = false;
		setPayLabel('Buy intel · $0.01 USDC');
	}
}

// Move keyboard focus to the receipt panel without scrolling the page out from
// under the viewer's eye on the result. The panel is tabindex=-1 in the markup.
function focusReceipt() {
	try { els.receipt.focus({ preventScroll: false }); } catch { /* focus unsupported */ }
}

// ── SSE reader (same pattern as /pay demo) ────────────────────────────────────
async function* sseReader(res) {
	const reader = res.body.getReader();
	const dec = new TextDecoder();
	let buf = '';
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		const chunks = buf.split('\n\n');
		buf = chunks.pop();
		for (const chunk of chunks) {
			if (!chunk.trim()) continue;
			let event = 'message', data = {};
			for (const line of chunk.split('\n')) {
				if (line.startsWith('event:')) event = line.slice(6).trim();
				if (line.startsWith('data:')) {
					try { data = JSON.parse(line.slice(5).trim()); } catch { /* ignore */ }
				}
			}
			yield { event, data };
		}
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function escHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Init ──────────────────────────────────────────────────────────────────────
function buildTopics() {
	for (const t of TOPICS) {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 't-chip' + (t.id === activeTopic ? ' active' : '');
		b.textContent = t.label;
		b.dataset.id = t.id;
		b.setAttribute('aria-pressed', String(t.id === activeTopic));
		b.addEventListener('click', () => {
			if (busy) return;
			activeTopic = t.id;
			els.topics.querySelectorAll('.t-chip').forEach((c) => {
				c.classList.toggle('active', c.dataset.id === activeTopic);
				c.setAttribute('aria-pressed', String(c.dataset.id === activeTopic));
			});
			// Buyer agent reacts to topic change.
			const line = `Switching to ${t.id.toUpperCase()} intel. Ready to buy.`;
			sayB(line);
		});
		els.topics.appendChild(b);
	}
}

function mountAvatars() {
	// Agent A (seller) sits on the left of the arena.
	const aqA = new URLSearchParams();
	aqA.set('model', '/avatars/default.glb');
	aqA.set('bg', 'transparent');
	aqA.set('idle', 'on');
	aqA.set('name', '0');
	aqA.set('animPicker', '0');
	aqA.set('overlayMode', '1');
	els.frameA.src = `/avatar-embed.html?${aqA}`;

	// Agent B (buyer) uses the same setup on the right side.
	const aqB = new URLSearchParams();
	aqB.set('model', '/avatars/default.glb');
	aqB.set('bg', 'transparent');
	aqB.set('idle', 'on');
	aqB.set('name', '0');
	aqB.set('animPicker', '0');
	aqB.set('overlayMode', '1');
	els.frameB.src = `/avatar-embed.html?${aqB}`;
}

function init() {
	buildTopics();
	renderStages();
	mountAvatars();
	showEmptyState();
	checkWallet();

	els.payBtn.addEventListener('click', doPurchase);

	// Opening lines once both avatars are ready (or after timeout).
	setTimeout(() => {
		sayA(LINES.A.idle);
		setTimeout(() => sayB(LINES.B.idle(activeTopic)), 1400);
	}, 2000);
}

init();
