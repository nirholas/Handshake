// Controller for the grind-bounty market page (/vanity/bounties).
//
// Wires the bounty board, the post-a-bounty flow (X25519 keygen + live
// difficulty→price oracle + x402 escrow checkout), the "grind & earn" worker
// pool that claims open bounties (sealing the key to the requester so the worker
// stays secret-blind), and the requester's client-side wallet reveal/open.
//
// All crypto is real (sealed-envelope ECIES, the WASM grinder pool); all money
// rails are real (x402 escrow via window.X402, on-chain payout server-side).

import bs58 from 'bs58';
import { computeRarity, RARITY_TIERS } from '../solana/vanity/rarity.js';
import { validatePattern } from '../solana/vanity/validation.js';
import { grindVanity } from '../solana/vanity/grinder.js';
import {
	generateRecipientKeypair,
	sealToRecipient,
	openSealed,
} from '../solana/vanity/sealed-envelope.js';

const $ = (id) => document.getElementById(id);
const API = '/api/vanity/bounties';
const TIER_COLOR = Object.fromEntries(RARITY_TIERS.map((t) => [t.id, t.accent]));
const USDC = 1_000_000;

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600); }
function usd(atomics) { return '$' + (Number(atomics) / USDC).toFixed(Number(atomics) % USDC === 0 ? 2 : 4); }
function fmtAttempts(n) {
	const v = Number(n) || 0;
	if (v >= 1e15) return v.toExponential(1);
	if (v >= 1e12) return (v / 1e12).toFixed(1) + 'T';
	if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
	if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
	if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
	return v.toLocaleString('en-US');
}
function patternHTML(p) {
	const pre = p?.prefix || '', suf = p?.suffix || '';
	const parts = [];
	if (pre) parts.push(`<span class="hi">${esc(pre)}</span>…`);
	if (suf) parts.push(`…<span class="hi">${esc(suf)}</span>`);
	return parts.join(' ') || '(any)';
}
function timeLeft(ms) {
	const d = ms - Date.now();
	if (d <= 0) return 'expired';
	const s = Math.floor(d / 1000);
	if (s < 60) return `${s}s left`;
	if (s < 3600) return `${Math.floor(s / 60)}m left`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m left`;
	return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h left`;
}

async function api(path, opts) {
	const r = await fetch(`${API}${path}`, opts);
	const ct = r.headers.get('content-type') || '';
	const data = ct.includes('json') ? await r.json().catch(() => ({})) : {};
	if (!r.ok) {
		const e = new Error(data.error_description || data.error || `HTTP ${r.status}`);
		e.status = r.status; e.data = data;
		throw e;
	}
	return data;
}

// ── tabs ─────────────────────────────────────────────────────────────────────
const TABS = ['board', 'post', 'earn', 'open', 'leaderboard'];
const BOUNTY_ID_RE = /^[0-9a-f]{8,32}$/;

function selectTab(name, opts = {}) {
	for (const t of TABS) {
		const btn = $(`tab-${t}`), panel = $(`panel-${t}`);
		const on = t === name;
		btn.setAttribute('aria-selected', on ? 'true' : 'false');
		btn.tabIndex = on ? 0 : -1;
		panel.classList.toggle('show', on);
	}
	if (name === 'board') loadBoard(true);
	if (name === 'leaderboard') loadLeaderboard();
	if (name === 'post') loadPostConfig();
	// A bounty-id hash is a deep link to one card (the API hands out
	// /vanity/bounties#<id> as boardUrl), so it must survive the tab sync.
	if (opts.keepHash && BOUNTY_ID_RE.test(location.hash.slice(1))) return;
	if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
}
TABS.forEach((t) => $(`tab-${t}`).addEventListener('click', () => selectTab(t)));

// Roving-tabindex keyboard navigation, which role="tablist" promises: arrows move
// between tabs, Home/End jump to the ends.
$('tablist').addEventListener('keydown', (e) => {
	const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
	let next = null;
	if (delta) next = TABS[(TABS.indexOf(currentTab()) + delta + TABS.length) % TABS.length];
	else if (e.key === 'Home') next = TABS[0];
	else if (e.key === 'End') next = TABS[TABS.length - 1];
	if (!next) return;
	e.preventDefault();
	selectTab(next);
	$(`tab-${next}`).focus();
});
function currentTab() {
	return TABS.find((t) => $(`tab-${t}`).getAttribute('aria-selected') === 'true') || 'board';
}

// Delegated: the i18n pass rewrites the lede paragraph's innerHTML for
// localized users, which would orphan a listener bound to the link itself.
document.addEventListener('click', (e) => {
	if (!e.target.closest('#lede-earn')) return;
	e.preventDefault();
	selectTab('earn');
});

// A pasted or clicked #<bounty-id> link opens that exact bounty; a #<tab> hash
// switches tabs. Without this, in-page hash links are inert.
window.addEventListener('hashchange', () => {
	const h = location.hash.slice(1);
	if (TABS.includes(h)) selectTab(h);
	else if (BOUNTY_ID_RE.test(h)) openBountyLink(h);
});

// ── stats strip ──────────────────────────────────────────────────────────────
async function loadStats() {
	const strip = $('statstrip');
	try {
		const s = await api('?view=stats');
		strip.innerHTML = [
			['Open bounties', String(s.open ?? 0)],
			['Escrowed', usd(s.openEscrowAtomics ?? 0), true],
			['Filled', String(s.settled ?? 0)],
			['Paid to grinders', usd(s.paidOutAtomics ?? 0), true],
		].map(([k, v, sm]) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v${sm ? ' sm' : ''}">${esc(v)}</div></div>`).join('');
	} catch (e) {
		strip.innerHTML = `<div class="stat" style="flex:1 1 100%"><div class="k">Market stats</div><div class="v sm">${esc(e.message)}</div><button class="ghost small" id="stats-retry" style="margin-top:.5rem">Retry</button></div>`;
		$('stats-retry')?.addEventListener('click', loadStats);
	}
}

// ── board ────────────────────────────────────────────────────────────────────
let boardStatus = 'open', boardSort = 'reward', boardOffset = 0, boardItems = [];
let boardTimer = null;

function statusBtns() {
	for (const [id, st] of [['st-open', 'open'], ['st-settled', 'settled'], ['st-all', 'all']]) {
		$(id).setAttribute('aria-pressed', boardStatus === st ? 'true' : 'false');
		$(id).addEventListener('click', () => { if (boardStatus === st) return; boardStatus = st; loadBoard(true); for (const [i2, s2] of [['st-open', 'open'], ['st-settled', 'settled'], ['st-all', 'all']]) $(i2).setAttribute('aria-pressed', s2 === st ? 'true' : 'false'); });
	}
}
$('sort-select').addEventListener('change', (e) => { boardSort = e.target.value; loadBoard(true); });
$('refresh-board').addEventListener('click', () => loadBoard(true));
$('loadmore-btn').addEventListener('click', () => loadBoard(false));

function bountyCard(b) {
	const tier = b.difficulty?.tier || 'common';
	const color = TIER_COLOR[tier] || '#94a3b8';
	const isOpen = b.status === 'open' && b.expiresAt > Date.now();
	const statusCls = b.status === 'open' ? (isOpen ? 'open' : 'expired') : b.status;
	const statusTxt = b.status === 'open' ? (isOpen ? 'Open · grinding' : 'Expired · awaiting refund') : (b.status === 'settled' ? 'Filled' : b.status === 'refunded' ? 'Refunded' : b.status);
	let actions = '';
	if (isOpen) {
		actions = `<button class="ghost small" data-act="grind" data-id="${esc(b.id)}">Grind this</button>`;
	} else if (b.status === 'settled' && b.payoutTx) {
		actions = `<a class="ghost small" href="https://solscan.io/tx/${esc(b.payoutTx)}" target="_blank" rel="noopener">Payout ↗</a>`;
	} else if (b.status === 'open' && !isOpen) {
		actions = `<button class="ghost small" data-act="refund" data-id="${esc(b.id)}">Refund poster</button>`;
	} else if (b.status === 'refunded' && b.refundTx) {
		actions = `<a class="ghost small" href="https://solscan.io/tx/${esc(b.refundTx)}" target="_blank" rel="noopener">Refund ↗</a>`;
	}
	const winner = b.winnerAddress ? `<span title="winning address">${esc(b.winnerAddress.slice(0, 6))}…${esc(b.winnerAddress.slice(-4))}</span>` : '';
	return `<article class="bcard" data-id="${esc(b.id)}">
		<div class="toprow">
			<div class="reward">${usd(b.amountAtomics)} <small>USDC</small></div>
			<span class="tierbadge" style="background:${color}">${esc(b.difficulty?.tierLabel || tier)}</span>
		</div>
		<div class="pat">${patternHTML(b.pattern)}</div>
		<div class="meta">
			<span>~${fmtAttempts(b.difficulty?.expectedAttempts)} attempts</span>
			${b.label ? `<span>“${esc(b.label)}”</span>` : ''}
			${winner ? `<span>winner ${winner}</span>` : ''}
		</div>
		<div class="statusrow"><span class="dot ${statusCls}"></span><span>${esc(statusTxt)}</span>${isOpen ? `<span class="timer" data-expires="${b.expiresAt}" style="margin-left:auto;color:var(--dim)">${esc(timeLeft(b.expiresAt))}</span>` : ''}</div>
		<div class="btnrow">
			<button class="ghost small" data-act="copy" data-id="${esc(b.id)}">Copy id</button>
			${actions}
		</div>
	</article>`;
}

async function loadBoard(reset) {
	const grid = $('board-grid');
	if (reset) { boardOffset = 0; boardItems = []; grid.innerHTML = Array.from({ length: 6 }, () => '<div class="skel"></div>').join(''); }
	try {
		const data = await api(`?view=board&status=${boardStatus}&sort=${boardSort}&limit=12&offset=${boardOffset}`);
		boardItems = boardItems.concat(data.bounties || []);
		boardOffset += (data.bounties || []).length;
		if (!boardItems.length) {
			grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="glyph">🎯</div><h3>No ${boardStatus === 'open' ? 'open' : ''} bounties yet</h3><p>Be the first to escrow a bounty for a hard vanity address, and a fleet will grind it for you.</p><button class="primary" id="empty-post" style="margin-top:1rem">Post a bounty</button></div>`;
			$('empty-post')?.addEventListener('click', () => selectTab('post'));
			$('loadmore-row').style.display = 'none';
			return;
		}
		grid.innerHTML = boardItems.map(bountyCard).join('');
		$('loadmore-row').style.display = data.hasMore ? 'block' : 'none';
		wireCardActions(grid);
		startTimers();
	} catch (e) {
		grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="glyph">⚠</div><h3>Couldn't load the board</h3><p>${esc(e.message)}</p><button class="ghost" id="board-retry" style="margin-top:1rem">Retry</button></div>`;
		$('board-retry')?.addEventListener('click', () => loadBoard(true));
	}
}

function wireCardActions(scope) {
	scope.querySelectorAll('[data-act]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const id = btn.dataset.id, act = btn.dataset.act;
			if (act === 'copy') { await navigator.clipboard?.writeText(id).catch(() => {}); toast('Bounty id copied'); return; }
			if (act === 'grind') { preferGrind(id); return; }
			if (act === 'refund') { await triggerRefund(id, btn); return; }
		});
	});
}

async function triggerRefund(id, btn) {
	const amount = usd(bountyById(id)?.amountAtomics ?? 0);
	// The server binds the refund to the address recorded when the bounty was
	// funded and ignores any address supplied here, so do not pretend to ask
	// for one: state where the money goes and take a plain yes/no.
	const ok = window.confirm(`Return the ${amount} escrow of expired bounty ${id}?\n\nIt is sent on-chain to the Solana refund address recorded when the bounty was posted. It cannot be redirected anywhere else.`);
	if (!ok) return;
	const label = btn.textContent;
	btn.disabled = true; btn.textContent = 'Refunding…';
	try {
		const r = await api('?action=refund', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bountyId: id }) });
		toast(`Refunded ${usd(r.amountAtomics)} to ${r.refundAddress.slice(0, 6)}… (tx ${r.refundTx.slice(0, 8)}…)`);
		loadBoard(true); loadStats();
	} catch (e) {
		toast(`Refund failed: ${e.message}`);
		btn.disabled = false; btn.textContent = label;
	}
}

function bountyById(id) {
	return boardItems.find((b) => b.id === id) || (linkedBounty?.id === id ? linkedBounty : null);
}

function startTimers() {
	if (boardTimer) clearInterval(boardTimer);
	// Nothing counting down means nothing to tick: don't hold a 1 Hz timer open
	// on a board of settled bounties.
	if (!document.querySelector('.timer[data-expires]')) return;
	boardTimer = setInterval(() => {
		const els = document.querySelectorAll('.timer[data-expires]');
		if (!els.length) { clearInterval(boardTimer); boardTimer = null; return; }
		els.forEach((el) => { el.textContent = timeLeft(Number(el.dataset.expires)); });
	}, 1000);
}

// ── deep-linked bounty (#<id>) ───────────────────────────────────────────────
let linkedBounty = null;

async function openBountyLink(id) {
	selectTab('board', { keepHash: true });
	if (location.hash.slice(1) !== id) history.replaceState(null, '', `#${id}`);
	const wrap = $('linked-bounty');
	wrap.hidden = false;
	wrap.innerHTML = '<div class="skel" style="height:150px"></div>';
	try {
		const { bounty } = await api(`?view=get&id=${encodeURIComponent(id)}`);
		linkedBounty = bounty;
		wrap.innerHTML = `<div class="linkedhead"><span>Linked bounty</span><button class="ghost small" id="linked-clear" type="button">Clear</button></div><div class="grid">${bountyCard(bounty)}</div>`;
		wireCardActions(wrap);
		startTimers();
	} catch (e) {
		linkedBounty = null;
		wrap.innerHTML = `<div class="empty"><div class="glyph">🔗</div><h3>That bounty link didn't resolve</h3><p>${esc(e.message)}</p><button class="ghost" id="linked-clear" style="margin-top:1rem">Back to the board</button></div>`;
	}
	$('linked-clear')?.addEventListener('click', clearBountyLink);
	wrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function clearBountyLink() {
	linkedBounty = null;
	const wrap = $('linked-bounty');
	wrap.hidden = true;
	wrap.innerHTML = '';
	history.replaceState(null, '', '#board');
	$('tab-board').focus();
}

// ── post a bounty ────────────────────────────────────────────────────────────
let postConfig = null;
let lastOracle = null;

async function loadPostConfig() {
	if (postConfig) return applyPostConfig();
	try { postConfig = await api('?view=config'); } catch { postConfig = { payoutConfigured: false }; }
	applyPostConfig();
}
function applyPostConfig() {
	if (postConfig && !postConfig.payoutConfigured) {
		$('payout-warn').style.display = 'block';
	}
	refreshPostState();
}

function readPattern() {
	return {
		prefix: $('post-prefix').value.trim(),
		suffix: $('post-suffix').value.trim(),
		ignoreCase: $('post-ignorecase').checked,
	};
}

let quoteDebounce = null;
function onPatternChange() {
	clearTimeout(quoteDebounce);
	quoteDebounce = setTimeout(updateQuote, 220);
	refreshPostState();
}
['post-prefix', 'post-suffix'].forEach((id) => $(id).addEventListener('input', onPatternChange));
$('post-ignorecase').addEventListener('change', onPatternChange);

async function updateQuote() {
	const p = readPattern();
	const errBox = $('quote-err'); errBox.classList.remove('show');
	if (!p.prefix && !p.suffix) { $('quote-box').style.display = 'none'; lastOracle = null; return; }
	for (const [label, val] of [['prefix', p.prefix], ['suffix', p.suffix]]) {
		if (!val) continue;
		const v = validatePattern(val);
		if (!v.valid) { errBox.textContent = `Invalid ${label}: ${v.errors.join('; ')}`; errBox.classList.add('show'); $('quote-box').style.display = 'none'; lastOracle = null; return; }
	}
	// Local compute for instant feedback; the server oracle confirms the price.
	const rarity = computeRarity(p);
	$('q-tier').textContent = `${rarity.tierLabel} · ${rarity.rarityBits} bits`;
	$('q-tier').style.color = rarity.accent;
	const pct = Math.min(100, (rarity.rarityBits / (6 * 5.86)) * 100);
	$('q-meter').style.width = `${pct}%`;
	$('q-meter').style.background = rarity.accent;
	$('q-attempts').textContent = fmtAttempts(rarity.expectedAttempts);
	$('quote-box').style.display = 'block';
	try {
		const q = await api(`?view=quote&prefix=${encodeURIComponent(p.prefix)}&suffix=${encodeURIComponent(p.suffix)}&ignoreCase=${p.ignoreCase ? 1 : 0}`);
		lastOracle = q.oracle;
		$('q-suggested').textContent = `${usd(q.oracle.suggestedAtomics)} (floor ${usd(q.oracle.floorAtomics)})`;
	} catch {
		lastOracle = null;
		$('q-suggested').textContent = 'price unavailable';
	}
	refreshPostState();
}

$('use-floor').addEventListener('click', () => { if (lastOracle) { $('post-amount').value = (lastOracle.floorAtomics / USDC).toFixed(2); refreshPostState(); } });
$('use-suggested').addEventListener('click', () => { if (lastOracle) { $('post-amount').value = (lastOracle.suggestedAtomics / USDC).toFixed(4); refreshPostState(); } });
$('use-generous').addEventListener('click', () => { if (lastOracle) { $('post-amount').value = (lastOracle.generousAtomics / USDC).toFixed(4); refreshPostState(); } });

// X25519 keygen
$('gen-key').addEventListener('click', () => {
	const kp = generateRecipientKeypair();
	$('post-recipient').value = kp.publicKey;
	$('priv-value').textContent = kp.secretKey;
	$('key-private').style.display = 'block';
	$('saved-chk-wrap').style.display = 'flex';
	$('saved-chk').checked = false;
	window.__bountyPriv = kp.secretKey;
	refreshPostState();
	toast('Key generated. Save the private half!');
});
$('copy-priv').addEventListener('click', async () => { await navigator.clipboard?.writeText($('priv-value').textContent).catch(() => {}); toast('Private key copied'); });
$('download-key').addEventListener('click', () => {
	const blob = new Blob([JSON.stringify({ scheme: 'x25519', publicKey: $('post-recipient').value, secretKey: $('priv-value').textContent, note: 'three.ws grind-bounty sealed-delivery key. Keep the secretKey private; it opens your won wallet.', created: new Date().toISOString() }, null, 2)], { type: 'application/json' });
	const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `three-ws-bounty-key-${Date.now()}.json`; a.click(); URL.revokeObjectURL(a.href);
});
$('post-recipient').addEventListener('input', () => {
	// Pasted an existing key: no private key to show, hide the warning box.
	if ($('post-recipient').value.trim() && !$('priv-value').textContent) { $('saved-chk-wrap').style.display = 'none'; }
	refreshPostState();
});
['post-amount', 'post-expiry', 'post-refund'].forEach((id) => $(id).addEventListener('input', refreshPostState));
$('saved-chk').addEventListener('change', refreshPostState);

function postValidity() {
	const p = readPattern();
	if (!p.prefix && !p.suffix) return { ok: false, hint: 'Add a prefix or suffix.' };
	const amt = parseFloat($('post-amount').value);
	if (!amt || amt <= 0) return { ok: false, hint: 'Enter a bounty amount.' };
	const recipient = $('post-recipient').value.trim();
	if (!recipient) return { ok: false, hint: 'Generate or paste your X25519 key.' };
	if (window.__bountyPriv && !$('saved-chk').checked) return { ok: false, hint: 'Confirm you saved your private key.' };
	if (postConfig && !postConfig.payoutConfigured) return { ok: false, hint: 'Posting is unavailable in this environment.' };
	return { ok: true, amt, recipient, pattern: p };
}
function refreshPostState() {
	const v = postValidity();
	$('post-btn').disabled = !v.ok;
	$('post-hint').textContent = v.ok ? 'Ready. You’ll pay the bounty as escrow.' : v.hint;
}

$('post-btn').addEventListener('click', postBounty);
async function postBounty() {
	const v = postValidity();
	if (!v.ok) return;
	const errBox = $('post-err'), okBox = $('post-ok');
	errBox.classList.remove('show'); okBox.classList.remove('show');
	const amountAtomics = Math.round(v.amt * USDC);
	const expiryHours = Math.max(1, Math.min(720, parseInt($('post-expiry').value, 10) || 48));
	const label = $('post-label').value.trim();
	const refundAddress = $('post-refund').value.trim();
	const params = new URLSearchParams({
		prefix: v.pattern.prefix, suffix: v.pattern.suffix, ignoreCase: v.pattern.ignoreCase ? '1' : '0',
		amount: String(amountAtomics), recipient: v.recipient, expiryHours: String(expiryHours),
	});
	if (label) params.set('label', label);
	if (refundAddress) params.set('refundAddress', refundAddress);

	if (!window.X402?.pay) { errBox.textContent = 'Payment library failed to load. Reload the page and try again.'; errBox.classList.add('show'); return; }
	// Keep the localized label: the i18n pass may have rewritten it, so restoring a
	// hardcoded English string would leave a translated page in English.
	const postLabel = $('post-btn').textContent;
	$('post-btn').disabled = true; $('post-btn').innerHTML = '<span class="spin"></span> Opening checkout…';
	try {
		const out = await window.X402.pay({
			endpoint: `${API}?action=create&${params.toString()}`,
			method: 'POST',
			merchant: 'three.ws Grind-Bounty Market',
			action: `Escrow ${usd(amountAtomics)} bounty`,
		});
		const res = out?.result;
		if (!res?.posted) throw new Error(res?.error_description || 'post did not confirm');
		okBox.innerHTML = `Bounty <span class="mono">${esc(res.bounty.id)}</span> is live! The fleet is grinding <strong>${patternHTML(res.bounty.pattern)}</strong> for ${usd(res.bounty.amountAtomics)}. <br>Keep your X25519 <strong>private key</strong>: it opens the wallet when a worker finds it. <a href="#${esc(res.bounty.id)}" id="goto-board" style="color:var(--accent)">View on the board →</a>`;
		okBox.classList.add('show');
		toast('Bounty posted, escrow funded');
		$('goto-board')?.addEventListener('click', (ev) => { ev.preventDefault(); openBountyLink(res.bounty.id); });
		loadStats();
	} catch (e) {
		if (e?.code !== 'cancelled') { errBox.textContent = `Couldn't post: ${e.message || e}`; errBox.classList.add('show'); }
	} finally {
		$('post-btn').disabled = false; $('post-btn').textContent = postLabel;
		refreshPostState();
	}
}

// ── grind & earn (worker pool) ───────────────────────────────────────────────
let earnAbort = null, earnRunning = false, earnEarned = 0;
// Set by "Grind this" on a board card: the worker pool grinds this bounty ahead
// of the rest of the claimable queue instead of always taking the first one.
let preferredBountyId = null;
function logWork(html, cls = '') { const log = $('worklog'); const line = document.createElement('div'); if (cls) line.className = cls; line.innerHTML = html; log.prepend(line); while (log.children.length > 60) log.lastChild.remove(); }
function setOdo(k, v) { $(`o-${k}`).textContent = v; }

$('earn-start').addEventListener('click', startEarning);
$('earn-stop').addEventListener('click', stopEarning);

function preferGrind(id) {
	preferredBountyId = id;
	const b = bountyById(id);
	const wrap = $('earn-priority');
	wrap.hidden = false;
	wrap.innerHTML = `<span>Priority target: <strong class="mono">${esc(id.slice(0, 10))}…</strong>${b ? ` · ${patternHTML(b.pattern)} · ${usd(b.amountAtomics)}` : ''} is ground before the rest of the queue.</span> <button class="ghost small" id="earn-priority-clear" type="button">Clear</button>`;
	$('earn-priority-clear').addEventListener('click', () => {
		preferredBountyId = null;
		wrap.hidden = true; wrap.innerHTML = '';
		toast('Priority cleared, the queue order is back to normal');
	});
	selectTab('earn');
	if (!earnRunning) $('earn-payout').focus();
	toast(earnRunning ? 'Priority set: this bounty is next in the pool' : 'Priority set: add your payout address and press Start');
}

async function startEarning() {
	const payout = $('earn-payout').value.trim();
	if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(payout)) { toast('Enter a valid Solana payout address'); $('earn-payout').focus(); return; }
	if (earnRunning) return;
	earnRunning = true; earnAbort = new AbortController();
	$('earn-start').disabled = true; $('earn-stop').disabled = false;
	setOdo('status', 'Running'); logWork('<span class="miss">Fetching open bounties…</span>');
	earnLoop(payout).catch((e) => { logWork(`<span class="err">Worker stopped: ${esc(e.message)}</span>`); stopEarning(); });
}
function stopEarning() {
	earnRunning = false;
	try { earnAbort?.abort(); } catch {}
	$('earn-start').disabled = false; $('earn-stop').disabled = true;
	setOdo('status', 'Idle'); setOdo('target', '—'); setOdo('rate', '0/s');
}

async function earnLoop(payout) {
	const maxWorkers = parseInt($('earn-workers').value, 10) || undefined;
	while (earnRunning) {
		let bounties;
		try { ({ bounties } = await api('?view=open&limit=20')); } catch (e) { logWork(`<span class="err">Couldn't fetch bounties: ${esc(e.message)}</span>`); await sleep(4000); continue; }
		const claimable = bounties.filter((b) => b.status === 'open' && b.expiresAt > Date.now());
		let target = claimable[0];
		if (preferredBountyId) {
			const preferred = claimable.find((b) => b.id === preferredBountyId);
			if (preferred) target = preferred;
			else if (claimable.length) {
				logWork(`<span class="miss">Priority bounty ${esc(preferredBountyId.slice(0, 10))}… is no longer claimable, taking the queue instead.</span>`);
				preferredBountyId = null;
				$('earn-priority').hidden = true;
			}
		}
		if (!target) { setOdo('status', 'Waiting'); setOdo('target', 'no open bounties'); logWork('<span class="miss">No open bounties, waiting…</span>'); await sleep(5000); continue; }

		setOdo('status', 'Grinding'); setOdo('target', `${patternText(target.pattern)} · ${usd(target.amountAtomics)}`);
		logWork(`Grinding <strong>${patternHTML(target.pattern)}</strong> for ${usd(target.amountAtomics)} (id ${esc(target.id.slice(0, 8))}…)`);

		let result;
		try {
			result = await grindVanity({
				prefix: target.pattern.prefix || '', suffix: target.pattern.suffix || '', ignoreCase: !!target.pattern.ignoreCase,
				maxWorkers, signal: earnAbort.signal,
				onProgress: ({ attempts, rate }) => { setOdo('attempts', fmtAttempts(attempts)); setOdo('rate', `${fmtAttempts(rate)}/s`); },
			});
		} catch (e) {
			if (e.name === 'AbortError') return;
			logWork(`<span class="err">Grind error: ${esc(e.message)}</span>`); await sleep(1500); continue;
		}
		if (!earnRunning) return;

		// Seal the found secret to the requester BEFORE submitting: the worker
		// never transmits plaintext, so it cannot keep the wallet.
		setOdo('status', 'Claiming');
		logWork(`<span class="win">Found ${esc(result.publicKey.slice(0, 8))}… sealing to the requester and claiming…</span>`);
		let sealed;
		try {
			const bundle = JSON.stringify({ format: 'keypair', secretKeyBase58: bs58Encode(result.secretKey), secretKey: Array.from(result.secretKey), publicKey: result.publicKey });
			sealed = await sealToRecipient(bundle, target.recipient);
		} catch (e) { logWork(`<span class="err">Seal failed: ${esc(e.message)}</span>`); continue; }

		try {
			const claim = await api('?action=claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bountyId: target.id, address: result.publicKey, sealedSecret: sealed, payoutAddress: payout, workerId: workerId() }) });
			if (target.id === preferredBountyId) { preferredBountyId = null; $('earn-priority').hidden = true; }
			if (claim.paid) {
				earnEarned += claim.amountAtomics;
				setOdo('earned', usd(earnEarned));
				logWork(`<span class="win">✓ Paid ${usd(claim.amountAtomics)} → <a href="${esc(claim.explorerUrl)}" target="_blank" rel="noopener" style="color:var(--good)">${esc(claim.payoutTx.slice(0, 10))}…</a></span>`);
				toast(`Earned ${usd(claim.amountAtomics)}!`);
				loadStats();
			} else {
				logWork(`<span class="miss">Won but payout pending: ${esc(claim.reason || 'retry')}</span>`);
			}
		} catch (e) {
			if (e.status === 409) logWork(`<span class="miss">Lost the race, another worker submitted first.</span>`);
			else if (e.status === 422) logWork(`<span class="err">Claim rejected: ${esc(e.message)}</span>`);
			else logWork(`<span class="err">Claim failed: ${esc(e.message)}</span>`);
		}
		setOdo('status', 'Running');
	}
}

function patternText(p) { return [p?.prefix && `${p.prefix}…`, p?.suffix && `…${p.suffix}`].filter(Boolean).join(' ') || '(any)'; }
function workerId() {
	let id = localStorage.getItem('twx_bounty_worker');
	if (!id) { id = 'w_' + Math.random().toString(36).slice(2, 10); localStorage.setItem('twx_bounty_worker', id); }
	return id;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// bs58 encode for the worker's secret-key bundle (sealed-envelope already depends
// on bs58, so the bundler dedupes this to a single chunk).
function bs58Encode(bytes) { return bs58.encode(bytes); }

// ── open my won wallet ───────────────────────────────────────────────────────
$('open-btn').addEventListener('click', openWallet);
async function openWallet() {
	const id = $('open-id').value.trim();
	const priv = $('open-priv').value.trim();
	const errBox = $('open-err'), okBox = $('open-ok');
	errBox.classList.remove('show'); okBox.classList.remove('show');
	if (!/^[0-9a-f]{8,32}$/.test(id)) { errBox.textContent = 'Enter a valid bounty id.'; errBox.classList.add('show'); return; }
	if (!priv) { errBox.textContent = 'Enter your X25519 private key.'; errBox.classList.add('show'); return; }
	const openLabel = $('open-btn').textContent;
	$('open-btn').disabled = true; $('open-btn').innerHTML = '<span class="spin"></span> Revealing…';
	try {
		const r = await api('?action=reveal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bountyId: id }) });
		if (!r.revealed) throw new Error(r.reason || 'not ready');
		// Decrypt entirely client-side: the private key never leaves the browser.
		const plaintext = new TextDecoder().decode(await openSealed(r.sealedSecret, priv));
		const wallet = JSON.parse(plaintext);
		if (wallet.publicKey && wallet.publicKey !== r.address) throw new Error('decrypted key does not match the won address');
		okBox.innerHTML = `<strong style="color:var(--good)">Wallet opened.</strong> This is YOUR address <span class="mono">${esc(r.address)}</span>. The worker who found it never saw this key.
			<div class="keybox" style="border-color:rgba(74,222,128,.35)"><div class="k" style="color:var(--dim);font-size:.7rem;text-transform:uppercase">Secret key (Base58, import into Phantom/Solflare)</div><code style="color:#86efac">${esc(wallet.secretKeyBase58 || '')}</code>
			<button class="ghost small" id="open-copy">Copy secret key</button> <a class="ghost small" href="https://solscan.io/account/${esc(r.address)}" target="_blank" rel="noopener">Explorer ↗</a></div>`;
		okBox.classList.add('show');
		$('open-copy')?.addEventListener('click', async () => { await navigator.clipboard?.writeText(wallet.secretKeyBase58 || '').catch(() => {}); toast('Secret key copied'); });
		toast('Wallet decrypted locally');
	} catch (e) {
		errBox.textContent = e.message?.includes('decrypt') || e.name === 'OperationError' ? 'Decryption failed: that private key does not open this bounty.' : `Couldn't open: ${e.message}`;
		errBox.classList.add('show');
	} finally {
		$('open-btn').disabled = false; $('open-btn').textContent = openLabel;
	}
}

// ── leaderboard ──────────────────────────────────────────────────────────────
async function loadLeaderboard() {
	const el = $('leaderboard');
	el.innerHTML = '<div class="skel" style="height:120px"></div>';
	try {
		const { grinders } = await api('?view=leaderboard&limit=20');
		if (!grinders.length) { el.innerHTML = `<div class="empty"><div class="glyph">🏆</div><h3>No grinders yet</h3><p>Be the first to fill a bounty and top the leaderboard. <button class="primary" id="lb-earn" style="margin-top:1rem">Start grinding</button></p></div>`; $('lb-earn')?.addEventListener('click', () => selectTab('earn')); return; }
		el.innerHTML = `<div class="card" style="padding:0;overflow:hidden">${grinders.map((g, i) => `<div class="kv" style="padding:.8rem 1.1rem;${i === 0 ? 'background:rgba(255,213,79,.06)' : ''}"><span class="k">#${i + 1} <span class="mono" style="color:#ccc">${esc(g.workerId)}</span></span><span class="v" style="color:var(--good)">${usd(g.earnedAtomics)}</span></div>`).join('')}</div>`;
	} catch (e) {
		el.innerHTML = `<div class="empty"><div class="glyph">⚠</div><h3>Couldn't load the leaderboard</h3><p>${esc(e.message)}</p><button class="ghost" id="lb-retry" style="margin-top:1rem">Retry</button></div>`;
		$('lb-retry')?.addEventListener('click', loadLeaderboard);
	}
}

// ── init ─────────────────────────────────────────────────────────────────────
function init() {
	statusBtns();
	loadStats();
	const hash = location.hash.slice(1);
	// A bounty-id hash (#<hex>) deep-links one card; selectTab already loads
	// whichever panel it opens, so never kick off a second board fetch here.
	if (BOUNTY_ID_RE.test(hash)) openBountyLink(hash);
	else selectTab(TABS.includes(hash) ? hash : 'board');
}
init();

// Stop the worker pool when the page is hidden offscreen to free the cores.
document.addEventListener('visibilitychange', () => {
	if (document.hidden && earnRunning) { logWork('<span class="miss">Page hidden, pausing to free your cores.</span>'); stopEarning(); }
});
window.addEventListener('beforeunload', () => { try { earnAbort?.abort(); } catch {} });
