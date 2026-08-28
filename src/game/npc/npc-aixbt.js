// AIXBT — the town's intelligence terminal.
//
// Walk up, press E, and aixbt asks what you want to see — a game-style dialogue
// wheel with four reads. You pick one (and, for a scan, type the token), and the
// terminal runs the live aixbt feed for exactly that: momentum movers, narrative
// intel, a macro read, or a single-token scan. Data is the three.ws ⇄ aixbt
// bridge (/api/aixbt/*); the upstream aixbt key stays server-side.
//
// Free at the counter because three.ws already pays aixbt upstream; the paid
// layer lives on the MCP tools (aixbt_intel / aixbt_projects) for other agents.
//
// Self-contained: reuses the .npc-svc-* panel chrome for native look + the
// shared overlay lifecycle, plus a small .aixbt-* stylesheet injected once.

import { aixbtPayHud } from './aixbt-pay-hud.js';

// ── tiny DOM helper (mirrors npc-services.js conventions) ─────────────────────
function el(tag, attrs, kids) {
	const node = document.createElement(tag);
	if (attrs) {
		for (const [k, v] of Object.entries(attrs)) {
			if (v == null || v === false) continue;
			if (k === 'class') node.className = v;
			else if (k === 'text') node.textContent = v;
			else if (k === 'html') node.innerHTML = v;
			else if (k.startsWith('on') && typeof v === 'function')
				node.addEventListener(k.slice(2).toLowerCase(), v);
			else node.setAttribute(k, v === true ? '' : v);
		}
	}
	for (const kid of [].concat(kids || [])) {
		if (kid == null || kid === false) continue;
		node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
	}
	return node;
}

function fmtPct(n) {
	if (n == null || Number.isNaN(Number(n))) return '—';
	const v = Number(n);
	return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}
function fmtUsd(n) {
	if (n == null || Number.isNaN(Number(n))) return '—';
	const v = Number(n);
	if (v >= 1) return '$' + v.toLocaleString(undefined, { maximumFractionDigits: 2 });
	return '$' + v.toLocaleString(undefined, { maximumSignificantDigits: 4 });
}
function scoreBar(label, score) {
	const pct = Math.max(0, Math.min(100, Math.round((Number(score) || 0) * 100)));
	return el('div', { class: 'aixbt-score' }, [
		el('span', { class: 'aixbt-score-k', text: label }),
		el('span', { class: 'aixbt-score-track' }, [
			el('span', { class: 'aixbt-score-fill', style: `width:${pct}%` }),
		]),
		el('span', { class: 'aixbt-score-v', text: score == null ? '—' : pct + '%' }),
	]);
}

const CHAINS = [
	{ value: '', label: 'All chains' },
	{ value: 'solana', label: 'Solana' },
	{ value: 'base', label: 'Base' },
	{ value: 'ethereum', label: 'Ethereum' },
];

// The dialogue wheel. Each choice maps to a live aixbt read. `say` is the
// in-world line aixbt speaks the moment you pick it.
const CHOICES = [
	{
		id: 'movers',
		icon: '📈',
		title: "What's moving?",
		desc: 'Momentum-ranked movers, live',
		say: 'Pulling the movers — highest momentum first.',
	},
	{
		id: 'narratives',
		icon: '📰',
		title: "What's the story?",
		desc: 'Narrative intel forming now',
		say: 'Reading the narratives forming right now.',
	},
	{
		id: 'macro',
		icon: '🌐',
		title: 'Read the market',
		desc: 'Hourly macro context',
		say: 'Here is the macro read — crypto and tradfi.',
	},
	{
		id: 'scan',
		icon: '🔍',
		title: 'Scan a token',
		desc: 'Type a ticker, I dig in',
		say: 'Name the token and I will scan it.',
	},
	{
		id: 'pay',
		icon: '⚡',
		title: 'Watch a live payment',
		desc: 'Real USDC settled on-chain, right now',
		say: 'Watch this — I will pay for a live read, on-chain.',
		wide: true,
	},
];

// The on-chain payment read maps /api/x402-pay's SSE lifecycle to a five-step
// stepper. Each id matches an event the endpoint emits; `done` is the terminal
// settled+confirmed state.
const PAY_STAGES = [
	{ id: 'challenge', label: '402' },
	{ id: 'built', label: 'Sign' },
	{ id: 'verified', label: 'Verify' },
	{ id: 'settled', label: 'Settle' },
	{ id: 'done', label: 'Confirmed' },
];
const fmtUsdc = (micro) => `${((Number(micro) || 0) / 1e6).toFixed(4)} USDC`;
const shortAddr = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : '—');

function injectStyles() {
	if (document.getElementById('aixbt-term-styles')) return;
	const s = document.createElement('style');
	s.id = 'aixbt-term-styles';
	s.textContent = `
	.npc-svc-card.is-aixbt { max-width: 640px; }
	.npc-svc-card.is-aixbt .npc-svc-title { display: flex; align-items: center; gap: 8px; }
	.aixbt-live { display:inline-flex; align-items:center; gap:5px; font-size:10px; font-weight:800; letter-spacing:0.08em; color:#27e0c4; }
	.aixbt-live::before { content:''; width:7px; height:7px; border-radius:50%; background:#27e0c4; box-shadow:0 0 8px #27e0c4; animation:aixbt-pulse 1.6s ease-in-out infinite; }
	@keyframes aixbt-pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }
	/* dialogue wheel */
	.aixbt-ask { font-size:13px; color:var(--cc-text,#e9e9ec); margin:2px 0 12px; }
	.aixbt-menu { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:4px; }
	.aixbt-choice { display:flex; align-items:flex-start; gap:11px; text-align:left; padding:13px 14px; border:1px solid var(--cc-edge, rgba(255,255,255,0.14)); border-radius:var(--cc-radius,6px); background:rgba(255,255,255,0.03); color:var(--cc-text,#e9e9ec); cursor:pointer; transition:border-color .15s ease, background .15s ease, transform .12s ease; }
	.aixbt-choice:hover { border-color:rgba(39,224,196,0.55); background:rgba(39,224,196,0.08); transform:translateY(-1px); }
	.aixbt-choice:active { transform:translateY(0); }
	.aixbt-choice:focus-visible { outline:2px solid #27e0c4; outline-offset:2px; }
	.aixbt-choice-ic { font-size:20px; line-height:1; margin-top:1px; }
	.aixbt-choice-key { position:absolute; }
	.aixbt-choice-body { display:flex; flex-direction:column; min-width:0; gap:3px; }
	.aixbt-choice-t { display:flex; align-items:center; font-weight:800; font-size:14px; letter-spacing:0.01em; }
	.aixbt-choice-d { font-size:11.5px; color:var(--cc-muted,#9a9aa2); line-height:1.35; }
	.aixbt-num { display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; border-radius:3px; font-size:10px; font-weight:800; color:#9ff4e6; background:rgba(39,224,196,0.16); margin-right:6px; flex:0 0 auto; }
	/* the on-chain payment card spans both columns and reads as the showcase */
	.aixbt-choice.is-wide { grid-column:1 / -1; align-items:center; background:linear-gradient(100deg, rgba(39,224,196,0.1), rgba(122,168,255,0.07)); border-color:rgba(39,224,196,0.32); }
	.aixbt-choice.is-wide:hover { border-color:rgba(39,224,196,0.7); background:linear-gradient(100deg, rgba(39,224,196,0.16), rgba(122,168,255,0.12)); }
	.aixbt-choice.is-wide .aixbt-choice-ic { font-size:22px; }
	.aixbt-choice.is-wide .aixbt-num { color:#06201c; background:#27e0c4; }
	/* live payment stepper + receipt */
	.aixbt-pay-head { display:flex; align-items:baseline; justify-content:space-between; gap:10px; margin:14px 0 12px; }
	.aixbt-pay-who { font-size:13px; color:var(--cc-text,#e9e9ec); }
	.aixbt-pay-who b { font-weight:800; }
	.aixbt-pay-amt { font-size:12px; font-weight:800; font-variant-numeric:tabular-nums; color:#9ff4e6; }
	.aixbt-steps { display:flex; gap:7px; margin-bottom:6px; }
	.aixbt-step { flex:1; display:flex; flex-direction:column; align-items:center; gap:5px; font-size:10px; font-weight:800; letter-spacing:0.04em; text-transform:uppercase; color:#5a5a60; }
	.aixbt-step .aixbt-step-dot { width:100%; height:3px; border-radius:2px; background:rgba(255,255,255,0.08); transition:background .2s ease; }
	.aixbt-step.is-active { color:#9a9aa2; }
	.aixbt-step.is-active .aixbt-step-dot { background:rgba(39,224,196,0.5); animation:aixbt-step-pulse 1s ease-in-out infinite; }
	.aixbt-step.is-done { color:var(--cc-text,#e9e9ec); }
	.aixbt-step.is-done .aixbt-step-dot { background:#27e0c4; box-shadow:0 0 8px rgba(39,224,196,0.6); }
	.aixbt-step.is-err .aixbt-step-dot { background:#ff7a8a; box-shadow:0 0 8px rgba(255,122,138,0.5); }
	@keyframes aixbt-step-pulse { 0%,100%{opacity:0.5} 50%{opacity:1} }
	.aixbt-receipt { margin-top:14px; padding-top:13px; border-top:1px solid var(--cc-edge, rgba(255,255,255,0.08)); }
	.aixbt-rrow { display:flex; justify-content:space-between; gap:12px; padding:3px 0; font-size:12.5px; color:var(--cc-muted,#9a9aa2); }
	.aixbt-rrow .aixbt-rv { color:var(--cc-text,#e9e9ec); font-variant-numeric:tabular-nums; }
	.aixbt-rrow a { color:#9ff4e6; text-decoration:none; border-bottom:1px solid rgba(159,244,230,0.4); }
	.aixbt-rrow a:hover { border-bottom-color:#9ff4e6; }
	.aixbt-pay-note { margin-top:11px; font-size:12px; line-height:1.45; color:var(--cc-text,#e9e9ec); }
	.aixbt-pay-note.is-err { color:#ffb4be; }
	/* chips + back + scan form */
	.aixbt-toolbar { display:flex; align-items:center; gap:10px; margin:2px 0 14px; flex-wrap:wrap; }
	.aixbt-back { flex:0 0 auto; border:1px solid var(--cc-edge, rgba(255,255,255,0.14)); background:rgba(255,255,255,0.04); color:var(--cc-text,#e9e9ec); font-weight:700; font-size:12px; border-radius:var(--cc-radius,4px); padding:5px 11px; cursor:pointer; transition:background .15s ease; }
	.aixbt-back:hover { background:rgba(255,255,255,0.09); }
	.aixbt-chips { display:flex; gap:6px; flex-wrap:wrap; }
	.aixbt-chip { border:1px solid var(--cc-edge, rgba(255,255,255,0.14)); background:transparent; color:var(--cc-muted,#9a9aa2); font-size:11.5px; font-weight:700; border-radius:999px; padding:4px 11px; cursor:pointer; transition:all .15s ease; }
	.aixbt-chip:hover { color:var(--cc-text,#e9e9ec); border-color:rgba(255,255,255,0.3); }
	.aixbt-chip.is-on { color:#06201c; background:#27e0c4; border-color:#27e0c4; }
	.aixbt-scan-form { display:flex; gap:8px; margin:2px 0 14px; }
	.aixbt-scan-form .npc-svc-input { margin:0; }
	.aixbt-scan-form .aixbt-token { flex:1 1 auto; }
	.aixbt-scan-form .aixbt-chain { flex:0 0 130px; }
	.aixbt-go { flex:0 0 auto; border:1px solid var(--cc-edge, rgba(255,255,255,0.14)); background:rgba(39,224,196,0.14); color:#9ff4e6; font-weight:800; border-radius:var(--cc-radius,4px); padding:0 16px; cursor:pointer; transition:background .15s ease; }
	.aixbt-go:hover { background:rgba(39,224,196,0.24); }
	.aixbt-go:disabled { opacity:0.5; cursor:default; }
	/* result rows */
	.aixbt-section-h { font-size:11px; font-weight:800; letter-spacing:0.07em; text-transform:uppercase; color:var(--cc-muted,#9a9aa2); margin:16px 0 8px; }
	.aixbt-section-h:first-child { margin-top:4px; }
	.aixbt-row { padding:10px 0; border-top:1px solid var(--cc-edge, rgba(255,255,255,0.08)); }
	.aixbt-row:first-of-type { border-top:0; }
	.aixbt-row-top { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
	.aixbt-tkr { font-weight:800; letter-spacing:0.02em; }
	.aixbt-cat { font-size:10px; font-weight:700; letter-spacing:0.05em; text-transform:uppercase; color:#8fb8ff; background:rgba(120,170,255,0.12); border-radius:3px; padding:1px 6px; }
	.aixbt-chg.up { color:#43d6a0; } .aixbt-chg.down { color:#ff7a8a; } .aixbt-chg.flat { color:var(--cc-muted,#9a9aa2); }
	.aixbt-chg { font-weight:800; font-variant-numeric:tabular-nums; }
	.aixbt-desc { margin:5px 0 0; color:var(--cc-text,#e9e9ec); font-size:13px; line-height:1.45; }
	.aixbt-meta { margin-top:5px; font-size:11px; color:var(--cc-muted,#9a9aa2); display:flex; gap:12px; flex-wrap:wrap; }
	.aixbt-official { color:#43d6a0; }
	.aixbt-scores { margin-top:7px; display:grid; gap:5px; }
	.aixbt-score { display:grid; grid-template-columns:64px 1fr 38px; align-items:center; gap:8px; }
	.aixbt-score-k { font-size:10px; text-transform:uppercase; letter-spacing:0.05em; color:var(--cc-muted,#9a9aa2); }
	.aixbt-score-track { height:5px; border-radius:3px; background:rgba(255,255,255,0.08); overflow:hidden; }
	.aixbt-score-fill { display:block; height:100%; background:linear-gradient(90deg,#27e0c4,#7aa8ff); border-radius:3px; transition:width .4s ease; }
	.aixbt-score-v { font-size:11px; text-align:right; color:var(--cc-text,#e9e9ec); font-variant-numeric:tabular-nums; }
	/* macro grounding */
	.aixbt-ground-sec { margin-top:14px; }
	.aixbt-ground-sec:first-child { margin-top:4px; }
	.aixbt-ground-k { font-size:11px; font-weight:800; letter-spacing:0.06em; text-transform:uppercase; color:#9ff4e6; margin-bottom:6px; }
	.aixbt-ground-p { font-size:13px; line-height:1.5; color:var(--cc-text,#e9e9ec); margin:0 0 6px; }
	.aixbt-ground-list { margin:0; padding-left:18px; }
	.aixbt-ground-list li { font-size:13px; line-height:1.5; color:var(--cc-text,#e9e9ec); margin-bottom:4px; }
	.aixbt-skel { height:54px; border-radius:6px; background:linear-gradient(90deg,rgba(255,255,255,0.05),rgba(255,255,255,0.11),rgba(255,255,255,0.05)); background-size:200% 100%; animation:aixbt-shimmer 1.2s linear infinite; margin-bottom:8px; }
	@keyframes aixbt-shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
	.aixbt-empty, .aixbt-error { color:var(--cc-muted,#9a9aa2); font-size:13px; padding:14px 0; }
	.aixbt-error { color:#ffb4be; }
	.aixbt-setup { margin-top:8px; font-size:12px; color:var(--cc-muted,#9a9aa2); }`;
	document.head.appendChild(s);
}

// ── panel lifecycle (single instance, ESC, overlay click) ─────────────────────
let openPanel = null;

export function isAixbtPanelOpen() {
	return !!openPanel;
}

function closePanel() {
	if (!openPanel) return;
	const { overlay, onKey, opener } = openPanel;
	document.removeEventListener('keydown', onKey, true);
	overlay.classList.remove('is-in');
	const node = overlay;
	setTimeout(() => node.remove(), 180);
	openPanel = null;
	if (opener && typeof opener.focus === 'function') opener.focus();
}

// Bounded: the NPC panel shows a "Loading…" line before every one of these,
// and a stalled upstream used to freeze the panel with no way to recover. The
// abort surfaces through the same catch as any other failure, so the panel
// gets its designed error state instead.
async function fetchJson(path, { timeout = 8000 } = {}) {
	const res = await fetch(path, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
	const body = await res.json().catch(() => null);
	if (!res.ok || !body || body.error) {
		const err = new Error(body?.error_description || `request failed (${res.status})`);
		err.code = body?.error || `http_${res.status}`;
		err.setup = body?.setup;
		throw err;
	}
	return body;
}

// Read an SSE response body, yielding { event, data } per framed chunk — same
// framing /api/x402-pay speaks.
async function* sseEvents(res) {
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
			let event = 'message',
				data = {};
			for (const line of chunk.split('\n')) {
				if (line.startsWith('event:')) event = line.slice(6).trim();
				if (line.startsWith('data:')) {
					try {
						data = JSON.parse(line.slice(5).trim());
					} catch {
						/* ignore */
					}
				}
			}
			yield { event, data };
		}
	}
}

// The on-chain receipt for a settled x402 payment: payer→payee, amount, and the
// Solana tx hash linked out to Solscan so anyone can verify it on-chain.
function renderPaymentReceipt(payment) {
	const tx = payment.tx;
	return el('div', { class: 'aixbt-receipt' }, [
		el('div', { class: 'aixbt-rrow' }, [
			el('span', { text: 'Payer → payee' }),
			el('span', {
				class: 'aixbt-rv',
				text: `${shortAddr(payment.payer)} → ${shortAddr(payment.payTo)}`,
			}),
		]),
		el('div', { class: 'aixbt-rrow' }, [
			el('span', { text: 'Amount · network' }),
			el('span', {
				class: 'aixbt-rv',
				text: `${payment.amount != null ? fmtUsdc(payment.amount) : '—'} · Solana`,
			}),
		]),
		tx
			? el('div', { class: 'aixbt-rrow' }, [
					el('span', { text: 'Transaction' }),
					el('span', { class: 'aixbt-rv' }, [
						el('a', {
							href: `https://solscan.io/tx/${tx}`,
							target: '_blank',
							rel: 'noopener',
							text: `${tx.slice(0, 8)}…${tx.slice(-6)} ↗`,
						}),
					]),
				])
			: null,
		el('div', {
			class: 'aixbt-pay-note',
			text: 'A real USDC micropayment — settled on Solana mainnet, verifiable on-chain.',
		}),
	]);
}

function renderIntel(items) {
	if (!items.length)
		return el('div', { class: 'aixbt-empty', text: 'No fresh narratives for that filter.' });
	return el(
		'div',
		{},
		items.map((i) =>
			el('div', { class: 'aixbt-row' }, [
				el('div', { class: 'aixbt-row-top' }, [
					i.ticker
						? el('span', { class: 'aixbt-tkr', text: `$${i.ticker}` })
						: i.project
							? el('span', { class: 'aixbt-tkr', text: i.project })
							: null,
					i.category ? el('span', { class: 'aixbt-cat', text: i.category }) : null,
				]),
				i.description ? el('p', { class: 'aixbt-desc', text: i.description }) : null,
				el('div', { class: 'aixbt-meta' }, [
					i.observations != null
						? el('span', {
								text: `${i.observations} observation${i.observations === 1 ? '' : 's'}`,
							})
						: null,
					i.official_source
						? el('span', { class: 'aixbt-official', text: '✓ official source' })
						: null,
				]),
			]),
		),
	);
}

function renderProjects(items) {
	if (!items.length)
		return el('div', { class: 'aixbt-empty', text: 'No projects matched that filter.' });
	return el(
		'div',
		{},
		items.map((p) => {
			const chg = p.market?.change_24h;
			const tone = chg == null ? 'flat' : chg > 0 ? 'up' : chg < 0 ? 'down' : 'flat';
			return el('div', { class: 'aixbt-row' }, [
				el('div', { class: 'aixbt-row-top' }, [
					el('span', {
						class: 'aixbt-tkr',
						text: p.ticker ? `$${p.ticker}` : p.name || 'unknown',
					}),
					p.chain ? el('span', { class: 'aixbt-cat', text: p.chain }) : null,
					el('span', { class: `aixbt-chg ${tone}`, text: fmtPct(chg) }),
					p.market?.price_usd != null
						? el('span', { class: 'aixbt-meta', text: fmtUsd(p.market.price_usd) })
						: null,
				]),
				el('div', { class: 'aixbt-scores' }, [
					scoreBar('Spiking', p.scores?.spiking),
					scoreBar('Climbing', p.scores?.climbing),
					scoreBar('Active', p.scores?.active),
				]),
			]);
		}),
	);
}

// Grounding comes back as aixbt-shaped structured context. We render it
// defensively: strings become paragraphs, arrays become bullet lists, nested
// objects become titled sections — never fabricating a field that isn't there.
function humanizeKey(k) {
	return String(k)
		.replace(/[_-]+/g, ' ')
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

function groundingItemText(v) {
	if (v == null) return null;
	if (typeof v === 'string' || typeof v === 'number') return String(v);
	if (typeof v === 'object') {
		return v.description || v.summary || v.text || v.title || v.name || v.headline || null;
	}
	return null;
}

function renderGroundingValue(value) {
	if (value == null) return null;
	if (typeof value === 'string' || typeof value === 'number') {
		return el('p', { class: 'aixbt-ground-p', text: String(value) });
	}
	if (Array.isArray(value)) {
		const texts = value.map(groundingItemText).filter(Boolean);
		if (!texts.length) return null;
		return el(
			'ul',
			{ class: 'aixbt-ground-list' },
			texts.slice(0, 12).map((t) => el('li', { text: t })),
		);
	}
	if (typeof value === 'object') {
		// One level of nesting: render child keys as paragraphs/lists.
		const kids = Object.entries(value)
			.map(([k, v]) => {
				const inner = Array.isArray(v)
					? renderGroundingValue(v)
					: typeof v === 'string' || typeof v === 'number'
						? el('p', { class: 'aixbt-ground-p' }, [
								el('strong', { text: `${humanizeKey(k)}: ` }),
								String(v),
							])
						: null;
				return inner;
			})
			.filter(Boolean);
		return kids.length ? el('div', {}, kids) : null;
	}
	return null;
}

function renderGrounding(grounding) {
	if (grounding == null || (typeof grounding === 'object' && !Object.keys(grounding).length)) {
		return el('div', { class: 'aixbt-empty', text: 'No macro read available right now.' });
	}
	if (typeof grounding === 'string') {
		return el('p', { class: 'aixbt-ground-p', text: grounding });
	}
	const sections = Object.entries(grounding)
		.map(([k, v]) => {
			const rendered = renderGroundingValue(v);
			if (!rendered) return null;
			return el('div', { class: 'aixbt-ground-sec' }, [
				el('div', { class: 'aixbt-ground-k', text: humanizeKey(k) }),
				rendered,
			]);
		})
		.filter(Boolean);
	if (!sections.length)
		return el('div', { class: 'aixbt-empty', text: 'No macro read available right now.' });
	return el('div', {}, sections);
}

// Open aixbt's intelligence terminal. Opens to the dialogue wheel; each choice
// runs the matching live read. Manages its own lifecycle (no return value).
export function openAixbtTerminal(npc, { ui } = {}) {
	injectStyles();
	closePanel();

	const titleId = 'aixbt-term-title';
	const card = el('div', {
		class: 'npc-svc-card is-aixbt',
		role: 'dialog',
		'aria-modal': 'true',
		'aria-labelledby': titleId,
	});
	const overlay = el('div', { class: 'npc-svc-overlay' }, [card]);
	overlay.addEventListener('mousedown', (e) => {
		if (e.target === overlay) closePanel();
	});

	const close = el('button', {
		class: 'npc-svc-close',
		type: 'button',
		'aria-label': 'Close',
		text: '✕',
		onclick: closePanel,
	});
	card.appendChild(
		el('header', { class: 'npc-svc-head' }, [
			el('div', {}, [
				npc?.def?.name ? el('div', { class: 'npc-svc-who', text: npc.def.name }) : null,
				el('h2', { id: titleId, class: 'npc-svc-title' }, [
					'Intelligence Terminal',
					el('span', { class: 'aixbt-live', text: 'LIVE' }),
				]),
			]),
			close,
		]),
	);

	const body = el('div', { class: 'npc-svc-result', style: 'display:block' });
	card.appendChild(body);

	let busy = false;

	function skeleton(label) {
		body.textContent = '';
		body.appendChild(el('div', { class: 'aixbt-section-h', text: label }));
		for (let i = 0; i < 3; i++) body.appendChild(el('div', { class: 'aixbt-skel' }));
	}

	function backBar(extra) {
		return el('div', { class: 'aixbt-toolbar' }, [
			el('button', {
				class: 'aixbt-back',
				type: 'button',
				text: '← Ask again',
				onclick: showMenu,
			}),
			extra || null,
		]);
	}

	function chainChips(active, onPick) {
		return el(
			'div',
			{ class: 'aixbt-chips' },
			CHAINS.map((c) =>
				el('button', {
					class: `aixbt-chip${c.value === active ? ' is-on' : ''}`,
					type: 'button',
					text: c.label,
					onclick: () => {
						if (c.value !== active && !busy) onPick(c.value);
					},
				}),
			),
		);
	}

	function showError(err, retry) {
		body.textContent = '';
		body.appendChild(backBar());
		if (err?.code === 'aixbt_not_configured') {
			body.appendChild(
				el('div', {
					class: 'aixbt-error',
					text: "aixbt isn't connected on this deployment yet.",
				}),
			);
			if (err.setup) body.appendChild(el('div', { class: 'aixbt-setup', text: err.setup }));
			npc?.say?.("My feed isn't wired up here yet.");
		} else if (err?.code === 'aixbt_unauthorized') {
			// Covers both halves of the rejection: a key that expired or was
			// revoked, and a key on a plan below what this read needs.
			body.appendChild(
				el('div', {
					class: 'aixbt-error',
					text: "This deployment's aixbt key was rejected. It has expired, been revoked, or sits below the plan this read needs.",
				}),
			);
			if (err.setup) body.appendChild(el('div', { class: 'aixbt-setup', text: err.setup }));
			npc?.say?.("My key can't reach that one.");
		} else {
			body.appendChild(
				el('div', {
					class: 'aixbt-error',
					text: `Couldn't reach the aixbt feed: ${err.message}`,
				}),
			);
			if (retry)
				body.appendChild(
					el('button', {
						class: 'aixbt-go',
						type: 'button',
						text: 'Retry',
						style: 'margin-top:10px',
						onclick: retry,
					}),
				);
			ui?.toast?.('aixbt feed unavailable', 'warn');
		}
	}

	// ── reads ─────────────────────────────────────────────────────────────────
	async function runMovers(chain) {
		if (busy) return;
		busy = true;
		skeleton('Momentum');
		const qs = new URLSearchParams({ limit: '8' });
		if (chain) qs.set('chain', chain);
		try {
			const { projects = [] } = await fetchJson(`/api/aixbt/projects?${qs}`);
			body.textContent = '';
			body.appendChild(backBar(chainChips(chain, runMovers)));
			body.appendChild(
				el('div', {
					class: 'aixbt-section-h',
					text: chain ? `Momentum · ${chain}` : 'Momentum',
				}),
			);
			body.appendChild(renderProjects(projects));
			npc?.say?.(
				projects.length
					? `Top mover is ${projects[0].ticker ? '$' + projects[0].ticker : projects[0].name}.`
					: 'Quiet on that chain — try another.',
			);
		} catch (err) {
			showError(err, () => runMovers(chain));
		} finally {
			busy = false;
		}
	}

	async function runNarratives(chain) {
		if (busy) return;
		busy = true;
		skeleton('Narratives');
		const qs = new URLSearchParams({ limit: '8' });
		if (chain) qs.set('chain', chain);
		try {
			const { intel = [] } = await fetchJson(`/api/aixbt/intel?${qs}`);
			body.textContent = '';
			body.appendChild(backBar(chainChips(chain, runNarratives)));
			body.appendChild(
				el('div', {
					class: 'aixbt-section-h',
					text: chain ? `Narratives · ${chain}` : 'Narratives',
				}),
			);
			body.appendChild(renderIntel(intel));
			npc?.say?.(
				intel.length
					? `Tracking ${intel.length} narrative${intel.length === 1 ? '' : 's'} right now.`
					: 'No fresh narratives on that filter.',
			);
		} catch (err) {
			showError(err, () => runNarratives(chain));
		} finally {
			busy = false;
		}
	}

	async function runMacro() {
		if (busy) return;
		busy = true;
		skeleton('Macro');
		try {
			const { grounding } = await fetchJson('/api/aixbt/grounding');
			body.textContent = '';
			body.appendChild(backBar());
			body.appendChild(el('div', { class: 'aixbt-section-h', text: 'Market context' }));
			body.appendChild(renderGrounding(grounding));
			npc?.say?.("That's the read across crypto and tradfi.");
		} catch (err) {
			showError(err, runMacro);
		} finally {
			busy = false;
		}
	}

	async function runScan(token, chain) {
		if (busy) return;
		const q = (token || '').trim();
		if (!q) {
			showScan(token, chain);
			return;
		}
		busy = true;
		skeleton(`Scanning ${q.toUpperCase()}`);
		const projQs = new URLSearchParams({ limit: '6', names: q });
		const intelQs = new URLSearchParams({ limit: '6' });
		if (chain) {
			projQs.set('chain', chain);
			intelQs.set('chain', chain);
		}
		try {
			const [projRes, intelRes] = await Promise.all([
				fetchJson(`/api/aixbt/projects?${projQs}`),
				fetchJson(`/api/aixbt/intel?${intelQs}`),
			]);
			const projects = projRes.projects || [];
			// Intel isn't name-filterable upstream; keep items that mention the token.
			const ql = q.toLowerCase();
			const intel = (intelRes.intel || []).filter(
				(i) =>
					(i.ticker && i.ticker.toLowerCase() === ql) ||
					(i.project && i.project.toLowerCase().includes(ql)) ||
					(i.description && i.description.toLowerCase().includes(ql)),
			);
			body.textContent = '';
			body.appendChild(backBar());
			body.appendChild(
				el('div', { class: 'aixbt-section-h', text: `Momentum · ${q.toUpperCase()}` }),
			);
			body.appendChild(renderProjects(projects));
			body.appendChild(
				el('div', { class: 'aixbt-section-h', text: `Narratives · ${q.toUpperCase()}` }),
			);
			body.appendChild(renderIntel(intel));
			npc?.say?.(
				projects.length || intel.length
					? `Here's what I have on ${q.toUpperCase()}.`
					: `Nothing surfacing on ${q.toUpperCase()} yet.`,
			);
		} catch (err) {
			showError(err, () => runScan(q, chain));
		} finally {
			busy = false;
		}
	}

	// ── live on-chain payment (the showcase read) ──────────────────────────────
	// Streams /api/x402-pay's real settlement lifecycle straight into the terminal:
	// the platform pays for its own tools/list MCP call (the simplest paid read) in
	// USDC on Solana, and the confirmed tx is surfaced with a Solscan link. No
	// simulation — if the payer isn't configured the endpoint says so and we relay
	// that honestly.
	async function runPayment() {
		if (busy) return;
		busy = true;
		body.textContent = '';
		body.appendChild(backBar());
		body.appendChild(el('div', { class: 'aixbt-section-h', text: 'Live on-chain payment' }));
		const amtEl = el('span', { class: 'aixbt-pay-amt', text: '— USDC' });
		body.appendChild(
			el('div', { class: 'aixbt-pay-head' }, [
				el('span', {
					class: 'aixbt-pay-who',
					html: '<b>three.ws</b> pays for a live read',
				}),
				amtEl,
			]),
		);
		const stepsEl = el('div', { class: 'aixbt-steps' });
		const tail = el('div', {});
		body.appendChild(stepsEl);
		body.appendChild(tail);

		let amount = null;
		const paint = (activeId, errId = null) => {
			const ai = PAY_STAGES.findIndex((s) => s.id === activeId);
			stepsEl.textContent = '';
			PAY_STAGES.forEach((s, i) => {
				let cls = '';
				if (errId === s.id) cls = 'is-err';
				else if (activeId === 'done' || i < ai) cls = 'is-done';
				else if (i === ai) cls = 'is-active';
				stepsEl.appendChild(
					el('div', { class: `aixbt-step ${cls}` }, [
						el('span', { class: 'aixbt-step-dot' }),
						s.label,
					]),
				);
			});
			if (amount != null) amtEl.textContent = fmtUsdc(amount);
		};

		let active = 'challenge';
		paint(active);
		// Mirror the same lifecycle on the small left-edge HUD so the payment is
		// visible (and lands its receipt) from the corner of the screen even if the
		// player closes this terminal mid-settlement.
		aixbtPayHud.begin();

		let settled = null,
			result = null;
		try {
			const res = await fetch('/api/x402-pay', {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
				body: JSON.stringify({ tool: 'tools/list', args: {} }),
			});
			if (!res.ok || !res.body) {
				const txt = await res.text().catch(() => '');
				let msg = `payment service unavailable (${res.status})`,
					code = null;
				try {
					const j = JSON.parse(txt);
					msg = j.error_description || j.error || msg;
					code = j.error;
				} catch {
					/* ignore */
				}
				const notWired = res.status === 404 || code === 'config_missing';
				throw Object.assign(new Error(msg), {
					code: notWired ? 'pay_not_configured' : `http_${res.status}`,
				});
			}
			for await (const { event, data } of sseEvents(res)) {
				if (event === 'challenge') {
					amount = data.amount;
					active = 'built';
					paint(active);
					aixbtPayHud.setStage(active, amount);
					npc?.say?.('Challenge issued — signing the transfer.');
				} else if (event === 'built') {
					active = 'verified';
					paint(active);
					aixbtPayHud.setStage(active);
					npc?.say?.('Signed. Sent to the facilitator.');
				} else if (event === 'verified') {
					active = 'settled';
					paint(active);
					aixbtPayHud.setStage(active);
					npc?.say?.('Verified — waiting on settlement.');
				} else if (event === 'settled') {
					settled = data;
					active = 'done';
					paint(active);
					aixbtPayHud.setStage(active);
				} else if (event === 'result') {
					result = data;
				} else if (event === 'error') {
					throw new Error(data.error || 'payment failed');
				}
			}
			if (!settled) throw new Error('incomplete response from payment service');
			const payment = { ...(result?.payment || {}), ...settled };
			paint('done');
			tail.appendChild(renderPaymentReceipt(payment));
			aixbtPayHud.settle(payment);
			npc?.say?.('Settled on Solana — open it on Solscan.');
		} catch (err) {
			paint(active, active);
			tail.textContent = '';
			const configErr = err?.code === 'pay_not_configured';
			aixbtPayHud.fail(
				configErr
					? 'Payer not wired up on this deployment.'
					: `Rolled back: ${err.message}. No funds moved.`,
				active,
			);
			tail.appendChild(
				el('div', {
					class: 'aixbt-pay-note is-err',
					text: configErr
						? "The on-chain payer isn't wired up on this deployment yet."
						: `Payment didn't go through: ${err.message}. No funds moved.`,
				}),
			);
			if (!configErr)
				tail.appendChild(
					el('button', {
						class: 'aixbt-go',
						type: 'button',
						text: 'Try again',
						style: 'margin-top:10px',
						onclick: runPayment,
					}),
				);
			npc?.say?.(
				configErr
					? "My wallet isn't funded here yet."
					: 'That one rolled back — wallet unchanged.',
			);
			ui?.toast?.(configErr ? 'x402 payer not configured' : 'x402 payment failed', 'warn');
		} finally {
			busy = false;
		}
	}

	// ── scan sub-form (the "type what you want" step) ──────────────────────────
	function showScan(prevToken, prevChain) {
		body.textContent = '';
		body.appendChild(backBar());
		body.appendChild(el('p', { class: 'aixbt-ask', text: 'Which token should I scan?' }));
		const tokenInput = el('input', {
			class: 'npc-svc-input aixbt-token',
			type: 'text',
			placeholder: 'Token or ticker (e.g. SOL)',
			value: prevToken || '',
		});
		const chainSelect = el(
			'select',
			{ class: 'npc-svc-input aixbt-chain' },
			CHAINS.map((c) =>
				el(
					'option',
					{ value: c.value, selected: c.value === (prevChain || '') ? true : null },
					[c.label],
				),
			),
		);
		const goBtn = el('button', { class: 'aixbt-go', type: 'button', text: 'Scan' });
		// Keep typing out of the world's movement handlers (window-level keydown).
		for (const node of [tokenInput, chainSelect]) {
			node.addEventListener('keydown', (e) => {
				e.stopPropagation();
				if (e.key === 'Enter') {
					e.preventDefault();
					runScan(tokenInput.value, chainSelect.value);
				}
			});
			node.addEventListener('keyup', (e) => e.stopPropagation());
		}
		goBtn.addEventListener('click', () => runScan(tokenInput.value, chainSelect.value));
		body.appendChild(el('div', { class: 'aixbt-scan-form' }, [tokenInput, chainSelect, goBtn]));
		requestAnimationFrame(() => tokenInput.focus());
	}

	// ── the dialogue wheel ─────────────────────────────────────────────────────
	function pick(choice) {
		if (busy) return;
		npc?.say?.(choice.say);
		if (choice.id === 'movers') runMovers('');
		else if (choice.id === 'narratives') runNarratives('');
		else if (choice.id === 'macro') runMacro();
		else if (choice.id === 'scan') showScan('', '');
		else if (choice.id === 'pay') runPayment();
	}

	function showMenu() {
		body.textContent = '';
		body.appendChild(
			el('p', {
				class: 'aixbt-ask',
				text: 'What do you want to see? Pick a read — or press 1–5.',
			}),
		);
		const menu = el(
			'div',
			{ class: 'aixbt-menu' },
			CHOICES.map((c, idx) =>
				el(
					'button',
					{
						class: `aixbt-choice${c.wide ? ' is-wide' : ''}`,
						type: 'button',
						onclick: () => pick(c),
						'aria-label': c.title,
					},
					[
						el('span', { class: 'aixbt-choice-ic', text: c.icon }),
						el('span', { class: 'aixbt-choice-body' }, [
							el('span', { class: 'aixbt-choice-t' }, [
								el('span', { class: 'aixbt-num', text: String(idx + 1) }),
								c.title,
							]),
							el('span', { class: 'aixbt-choice-d', text: c.desc }),
						]),
					],
				),
			),
		);
		body.appendChild(menu);
		requestAnimationFrame(() => {
			const first = menu.querySelector('.aixbt-choice');
			if (first) first.focus();
		});
	}

	// Number-key shortcuts (1–4) while the menu is the active view.
	const onKey = (e) => {
		if (e.key === 'Escape') {
			e.stopPropagation();
			e.preventDefault();
			closePanel();
			return;
		}
		if (busy) return;
		const onMenu = body.querySelector('.aixbt-menu');
		if (onMenu && e.key >= '1' && e.key <= String(CHOICES.length)) {
			e.stopPropagation();
			e.preventDefault();
			pick(CHOICES[Number(e.key) - 1]);
		}
	};

	// Mount + ESC + open to the dialogue wheel.
	const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	document.addEventListener('keydown', onKey, true);
	document.body.appendChild(overlay);
	openPanel = { overlay, onKey, opener };
	requestAnimationFrame(() => {
		overlay.classList.add('is-in');
		showMenu();
	});
}
