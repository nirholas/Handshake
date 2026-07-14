// Coin Clash — token-gated community battle arena (client).
//
// Flow: poll /api/clash/state for the live bracket → render battle cards with a
// tug-of-war bar → "Fight for X" connects the wallet, signs a faction-bound
// challenge, and exchanges it for a war pass (server verifies the signature and
// a live on-chain holding of the coin) → the rally dock opens and every tap is
// batched and flushed to /api/clash/rally as battle power for that faction.
//
// Real data only: factions + records from the API, holdings gated on-chain.
// The tap UI is pure juice; the server clamps taps and caps per-wallet power, so
// the leaderboard reflects an army's effort, not a script.

import { initWalletButton, getConnectedWallet, getConnectedWalletAddress } from './wallet.js';
import { log } from './shared/log.js';
import { updateValue, ring, playRings, setLiveDot } from './ui-juice.js';

const $ = (id) => document.getElementById(id);
const API = '/api/clash';

// ── Local game state ─────────────────────────────────────────────────────────
const game = {
	state: null, // last /state payload
	tab: 'arena',
	ccUnavailable: false, // server answered cc_unconfigured: stop all polling
	pollTimer: null,
	timerRaf: null,
	enlist: null, // { token, symbol, image, warPass, amount, walletPower, cap }
	pendingTaps: 0, // taps accumulated since last flush
	flushing: false,
	flushTimer: null,
	combo: 0,
	comboTimer: null,
};

// ── Small DOM helper ─────────────────────────────────────────────────────────
function el(tag, props = {}, kids = []) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v == null) continue;
		if (k === 'class') n.className = v;
		else if (k === 'text') n.textContent = v;
		else if (k === 'html') n.innerHTML = v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
		else if (k === 'dataset') Object.assign(n.dataset, v);
		else n.setAttribute(k, v);
	}
	for (const kid of [].concat(kids)) {
		if (kid == null) continue;
		n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
	}
	return n;
}

function short(addr) {
	return addr ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : '';
}
function fmtNum(n) {
	n = Math.round(Number(n) || 0);
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return String(n);
}
function fmtTime(ms) {
	const s = Math.max(0, Math.floor(ms / 1000));
	const m = Math.floor(s / 60);
	const r = s % 60;
	if (m >= 60) {
		const h = Math.floor(m / 60);
		return `${h}h ${m % 60}m`;
	}
	return `${m}:${String(r).padStart(2, '0')}`;
}
function fmtUsd(n) {
	n = Number(n) || 0;
	if (n <= 0) return '';
	if (n < 0.01) return '<$0.01';
	return `$${n < 1 ? n.toFixed(3) : n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

async function apiGet(action, params = '') {
	const r = await fetch(`${API}/${action}${params}`, { credentials: 'include' });
	const body = await r.json().catch(() => ({}));
	if (!r.ok) throw Object.assign(new Error(body.error_description || body.error || `HTTP ${r.status}`), { status: r.status, code: body.error });
	return body.data;
}
async function apiPost(action, payload) {
	const r = await fetch(`${API}/${action}`, {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload),
	});
	const body = await r.json().catch(() => ({}));
	if (!r.ok) throw Object.assign(new Error(body.error_description || body.error || `HTTP ${r.status}`), { status: r.status, code: body.error });
	return body.data;
}

// ── Avatar (image or seeded initials) ────────────────────────────────────────
function avatar(side, cls = 'cl-avatar') {
	if (side.image) return el('img', { class: cls, src: side.image, alt: side.symbol || '', loading: 'lazy', referrerpolicy: 'no-referrer' });
	const label = (side.symbol || side.token || '?').replace(/^\$/, '').slice(0, 2).toUpperCase();
	return el('div', { class: `${cls} cl-avatar-ph`, text: label, 'aria-hidden': 'true' });
}

// ── Render: arena ────────────────────────────────────────────────────────────
function renderArena(data) {
	const root = $('cl-arena');
	root.setAttribute('aria-busy', 'false');

	if (!data || (!data.arena?.length && !data.bye)) {
		root.replaceChildren(emptyState());
		return;
	}

	const mine = game.enlist?.token || null;
	const frag = document.createDocumentFragment();

	for (const bt of data.arena) {
		frag.appendChild(battleCard(bt, mine));
	}
	if (data.bye) {
		frag.appendChild(
			el('div', { class: 'cl-bye' }, [
				`${data.bye.symbol || short(data.bye.token)} drew a bye this round — they advance unopposed. Rally them up for the next clash.`,
			]),
		);
	}
	root.replaceChildren(frag);
}

function sideBlock(side, which, mine) {
	const isMine = mine && side.token === mine;
	const rec = side.record || { w: 0, l: 0 };
	return el('div', { class: `cl-side cl-side-${which}` }, [
		avatar(side),
		el('span', { class: 'cl-sym', text: side.symbol || short(side.token) }),
		el('span', { class: 'cl-meta', text: `${fmtNum(side.members)} members${side.priceUsd ? ` · ${fmtUsd(side.priceUsd)}` : ''}` }),
		el('span', { class: 'cl-rec', html: `<b>${rec.w}W</b> · <i>${rec.l}L</i>` }),
		el('button', {
			class: `cl-fight${isMine ? ' is-mine' : ''}`,
			type: 'button',
			text: isMine ? '✓ Your army' : 'Fight',
			dataset: { token: side.token, symbol: side.symbol || '', image: side.image || '' },
			'aria-pressed': isMine ? 'true' : 'false',
			onclick: () => onFight(side),
		}),
	]);
}

function battleCard(bt, mine) {
	const a = bt.a;
	const b = bt.b;
	if (!b) {
		return el('div', { class: 'cl-bye' }, [`${a.symbol || short(a.token)} stands alone this round.`]);
	}
	const aPct = Math.round((bt.aShare ?? 0.5) * 100);
	const center = el('div', { class: 'cl-vs' }, [
		el('div', { class: 'cl-tug' }, [
			el('span', { class: 'cl-tug-fill', style: `width:${aPct}%` }),
			el('span', { class: 'cl-tug-mid' }),
		]),
		el('div', { class: 'cl-powers' }, [
			el('span', { class: 'cl-pa', text: fmtNum(a.power) }),
			el('span', { class: 'cl-vs-label', text: 'VS' }),
			el('span', { class: 'cl-pb', text: fmtNum(b.power) }),
		]),
		el('div', { class: 'cl-mom', html: `momentum <b>×${(a.momentum || 1).toFixed(2)}</b> / <b>×${(b.momentum || 1).toFixed(2)}</b>` }),
	]);
	return el('article', { class: 'cl-battle' }, [sideBlock(a, 'a', mine), center, sideBlock(b, 'b', mine)]);
}

function emptyState() {
	return el('div', { class: 'cl-state' }, [
		el('h2', { text: 'No battles live right now' }),
		el('p', { text: 'Coin Clash needs at least two active coin communities to field a bracket. Check the communities lobby, then come back when the armies muster.' }),
		el('a', { class: 'cl-fight', href: '/communities', text: 'Browse communities →' }),
	]);
}

function errorState(message, onRetry) {
	const node = el('div', { class: 'cl-state' }, [
		el('h2', { text: 'Couldn’t load the arena' }),
		el('p', { text: message || 'Something went wrong reaching the battle server.' }),
		el('button', { class: 'cl-fight', type: 'button', text: 'Try again', onclick: onRetry }),
	]);
	return node;
}

// An absent CoinCommunities key is a deployment state, not something the visitor
// did wrong — every surface says so in plain language instead of surfacing the
// raw `cc_unconfigured` code.
function errorMessage(err, fallback) {
	if (err?.code === 'cc_unconfigured') return 'Community battles aren’t configured on this deployment yet.';
	return err?.message || fallback;
}

// Designed state for that deployment gap: no retry loop (a retry can't conjure
// the missing key), just an explanation and live surfaces to move on to.
function unavailableState() {
	return el('div', { class: 'cl-state' }, [
		el('h2', { text: 'Coin Clash is temporarily unavailable' }),
		el('p', {
			text: 'The community battle service isn’t connected on this deployment yet. The armies will muster as soon as it comes online. In the meantime, the rest of the platform is live.',
		}),
		el('div', { class: 'cl-state-links' }, [
			el('a', { class: 'cl-fight', href: '/launches', text: 'See live launches →' }),
			el('a', { class: 'cl-fight', href: '/markets', text: 'Browse markets →' }),
		]),
	]);
}

// First cc_unconfigured answer wins: kill the 5s poll loop and pin every tab on
// the designed unavailable state, so one page view issues exactly one request.
function markUnavailable() {
	if (game.ccUnavailable) return;
	game.ccUnavailable = true;
	if (game.pollTimer) {
		clearInterval(game.pollTimer);
		game.pollTimer = null;
	}
	setLiveDot($('cl-live'), 'error', 'offline');
	const arena = $('cl-arena');
	arena.replaceChildren(unavailableState());
	arena.setAttribute('aria-busy', 'false');
	$('cl-standings').replaceChildren(unavailableState());
}

// ── Render: standings ────────────────────────────────────────────────────────
async function renderStandings() {
	const root = $('cl-standings');
	if (game.ccUnavailable) {
		// Deployment-wide outage already established: don't issue another
		// request that can only 503 the same way.
		root.replaceChildren(unavailableState());
		return;
	}
	root.replaceChildren(el('div', { class: 'cl-skel' }), el('div', { class: 'cl-skel' }), el('div', { class: 'cl-skel' }));
	let data;
	try {
		data = await apiGet('leaderboard');
	} catch (err) {
		if (err?.code === 'cc_unconfigured') {
			markUnavailable();
			return;
		}
		root.replaceChildren(errorState(errorMessage(err), () => renderStandings()));
		return;
	}
	const board = data?.board || [];
	if (!board.length) {
		root.replaceChildren(
			el('div', { class: 'cl-state' }, [
				el('h2', { text: 'No war record yet' }),
				el('p', { text: 'The first battles haven’t been settled. Enlist, rally, and your faction’s wins will land here.' }),
			]),
		);
		return;
	}
	const frag = document.createDocumentFragment();
	board.forEach((f, i) => {
		// Win rate reads as a "level", so it gets the shared ring gauge (swept by
		// playRings below). Factions with no settled battles show a plain dash.
		const wr = el('span', { class: 'cl-wr' });
		if (f.winRate == null) wr.textContent = '—';
		else wr.innerHTML = ring(f.winRate, { size: 40, stroke: 4 });
		frag.appendChild(
			el('div', { class: 'cl-row' }, [
				el('span', { class: 'cl-rank', text: i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : String(i + 1) }),
				el('div', { class: 'cl-row-id' }, [
					avatar(f),
					el('div', {}, [
						el('span', { class: 'cl-sym', text: f.symbol || short(f.token) }),
						el('small', { text: `${fmtNum(f.members)} members · ${fmtNum(f.power)} lifetime power` }),
					]),
				]),
				el('span', { class: 'cl-wl', html: `<b>${f.w}W</b> · <i>${f.l}L</i>${f.d ? ` · ${f.d}D` : ''}` }),
				wr,
			]),
		);
	});
	root.replaceChildren(frag);
	playRings(root);
}

// ── State polling + round timer ──────────────────────────────────────────────
async function poll() {
	if (game.ccUnavailable) return;
	try {
		const data = await apiGet('state');
		game.state = data;
		$('cl-round-no').textContent = `#${data.epoch}`;
		// Count the army tally to its new value and flash the change as the bracket polls.
		updateValue($('cl-round-armies'), data.factionCount || 0, (n) => String(Math.round(n)));
		if (game.tab === 'arena') renderArena(data);
		// Keep the rally dock's army number in sync with the broader poll.
		if (game.enlist) {
			const side = findSide(data, game.enlist.token);
			if (side) updateValue($('cl-army-power'), side.power, fmtNum);
		}
		setLiveDot($('cl-live'), 'live', 'live');
	} catch (err) {
		if (err?.code === 'cc_unconfigured') {
			markUnavailable();
			log.warn('clash: CoinCommunities unconfigured, polling stopped', err);
			return;
		}
		setLiveDot($('cl-live'), game.state ? 'connecting' : 'error', game.state ? 'reconnecting' : 'offline');
		if (game.tab === 'arena' && !game.state) {
			$('cl-arena').replaceChildren(
				errorState(errorMessage(err), () => poll()),
			);
			$('cl-arena').setAttribute('aria-busy', 'false');
		}
		log.warn('clash state poll failed', err);
	}
}

function findSide(data, token) {
	for (const bt of data?.arena || []) {
		if (bt.a?.token === token) return bt.a;
		if (bt.b?.token === token) return bt.b;
	}
	if (data?.bye?.token === token) return data.bye;
	return null;
}

function startTimer() {
	const tick = () => {
		if (game.state?.endsAt) {
			const left = game.state.endsAt - Date.now();
			$('cl-round-timer').textContent = fmtTime(left);
		}
		game.timerRaf = requestAnimationFrame(() => setTimeout(tick, 500));
	};
	tick();
}

// ── Enlist flow ──────────────────────────────────────────────────────────────
async function ensureWallet() {
	let addr = getConnectedWalletAddress();
	if (addr) return addr;
	const provider = (typeof window !== 'undefined' && window.solana) || null;
	if (!provider) {
		window.open('https://phantom.app/', '_blank', 'noopener');
		return null;
	}
	try {
		const res = await provider.connect();
		return res?.publicKey?.toString?.() || null;
	} catch {
		return null;
	}
}

async function onFight(side) {
	// Already enlisted in this faction → just reopen the dock.
	if (game.enlist?.token === side.token) {
		showRally();
		return;
	}
	const btns = [...document.querySelectorAll(`.cl-fight[data-token="${cssEsc(side.token)}"]`)];
	const setBusy = (t) => btns.forEach((b) => { b.disabled = true; b.textContent = t; });
	const restore = () => btns.forEach((b) => { b.disabled = false; b.textContent = 'Fight'; });

	setBusy('Connecting…');
	const wallet = await ensureWallet();
	if (!wallet) {
		restore();
		toast('Connect a Solana wallet to enlist.', true);
		return;
	}

	try {
		setBusy('Signing…');
		const provider = getConnectedWallet() || window.solana;
		if (!provider?.signMessage) throw new Error('Wallet can’t sign messages.');

		const { message } = await apiPost('enlist', { token: side.token, wallet });
		const encoded = new TextEncoder().encode(message);
		const signed = await provider.signMessage(encoded, 'utf8');
		const sigBytes = signed?.signature ?? signed;
		const bs58 = (await import('bs58')).default;
		const signature = bs58.encode(sigBytes);

		setBusy('Verifying…');
		const res = await apiPost('enlist-verify', { token: side.token, wallet, message, signature });
		if (!res.eligible) {
			restore();
			toast(`You don’t hold ${side.symbol || 'this coin'} — grab some to join its army.`, true);
			return;
		}

		game.enlist = {
			token: side.token,
			symbol: side.symbol || short(side.token),
			image: side.image || '',
			wallet,
			warPass: res.warPass,
			amount: res.amount,
			usd: res.usd,
			walletPower: 0,
			cap: 5000,
		};
		openRallyDock();
		// Refresh "Your army" buttons across the arena.
		if (game.state) renderArena(game.state);
		toast(`Enlisted in ${game.enlist.symbol}. Rally!`, false);
	} catch (err) {
		restore();
		if (err?.code === 4001 || /reject/i.test(err?.message || '')) toast('Signature declined.', true);
		else toast(errorMessage(err, 'Enlistment failed.'), true);
		log.warn('enlist failed', err);
	}
}

function cssEsc(s) {
	return (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
}

// ── Rally dock ───────────────────────────────────────────────────────────────
function openRallyDock() {
	const e = game.enlist;
	$('cl-rally-symbol').textContent = e.symbol;
	$('cl-rally-hold').textContent = e.usd ? `holding ${fmtUsd(e.usd)}` : `holder · ${short(e.wallet)}`;
	const img = $('cl-rally-img');
	if (e.image) {
		img.src = e.image;
		img.style.display = '';
	} else img.style.display = 'none';
	updateRallyStats();
	showRally();
}
function showRally() {
	$('cl-rally').hidden = false;
}
function hideRally() {
	$('cl-rally').hidden = true;
}

function updateRallyStats() {
	const e = game.enlist;
	if (!e) return;
	$('cl-your-power').textContent = fmtNum(e.walletPower);
	$('cl-your-cap').textContent = ` / ${fmtNum(e.cap)}`;
	const pct = Math.min(100, (e.walletPower / e.cap) * 100);
	const fill = $('cl-cap-fill');
	fill.style.width = `${pct}%`;
	fill.classList.toggle('is-full', pct >= 100);
	const side = game.state && findSide(game.state, e.token);
	if (side) updateValue($('cl-army-power'), side.power, fmtNum);
}

// Tap handling — accumulate locally, flush on a cadence.
function onTap() {
	if (!game.enlist) return;
	if (game.enlist.walletPower >= game.enlist.cap) {
		setHint('You’ve hit your power cap for this round — your army carries on without you. 🛡️', 'ok');
		return;
	}
	game.pendingTaps += 1;
	game.combo += 1;

	// Optimistic local bump (server is authoritative on next flush).
	game.enlist.walletPower = Math.min(game.enlist.cap, game.enlist.walletPower + 1);
	updateRallyStats();
	tapJuice();
	scheduleFlush();

	clearTimeout(game.comboTimer);
	const comboEl = $('cl-combo');
	comboEl.textContent = `×${Math.min(99, Math.floor(game.combo / 5) + 1)}`;
	comboEl.classList.toggle('show', game.combo >= 5);
	game.comboTimer = setTimeout(() => {
		game.combo = 0;
		comboEl.classList.remove('show');
	}, 1200);
}

function tapJuice() {
	const tap = $('cl-tap');
	tap.classList.remove('is-hit');
	void tap.offsetWidth; // restart animation
	tap.classList.add('is-hit');
	const pop = el('span', { class: 'cl-pop', text: '+1' });
	tap.appendChild(pop);
	setTimeout(() => pop.remove(), 700);
}

function scheduleFlush() {
	// Flush quickly once a burst settles, or immediately past a batch size.
	if (game.pendingTaps >= 25) return flush();
	if (game.flushTimer) return;
	game.flushTimer = setTimeout(flush, 650);
}

async function flush() {
	clearTimeout(game.flushTimer);
	game.flushTimer = null;
	if (game.flushing || !game.enlist || game.pendingTaps <= 0) return;
	const taps = Math.min(50, game.pendingTaps);
	game.pendingTaps -= taps;
	game.flushing = true;
	try {
		const res = await apiPost('rally', { pass: game.enlist.warPass, taps });
		// Adopt server-authoritative numbers.
		game.enlist.walletPower = res.walletPower;
		game.enlist.cap = res.walletCap;
		if (game.state) {
			const side = findSide(game.state, game.enlist.token);
			if (side) side.power = res.factionPower;
		}
		updateRallyStats();
		if (res.capped) setHint('Power cap reached for this round — well fought, soldier. 🛡️', 'ok');
		else setHint('Tap the target or hold <kbd>Space</kbd> to rally.');
	} catch (err) {
		if (err.status === 401 || err.code === 'pass_invalid') {
			// Pass expired — re-enlist transparently if the wallet is still around.
			setHint('Your war pass expired — re-enlisting…', 'error');
			const token = game.enlist.token;
			game.enlist = null;
			hideRally();
			const live = game.state && findSide(game.state, token);
			if (live) onFight(live);
		} else if (err.status === 429) {
			// Rallying too fast — push the taps back and retry shortly.
			game.pendingTaps += taps;
			setHint('Rallying hard! Pacing your taps…');
			setTimeout(scheduleFlush, 1400);
		} else {
			game.pendingTaps += taps;
			setHint(errorMessage(err, 'Rally failed — retrying.'), 'error');
			setTimeout(scheduleFlush, 1500);
		}
		log.warn('rally flush failed', err);
	} finally {
		game.flushing = false;
		if (game.pendingTaps > 0) scheduleFlush();
	}
}

function setHint(html, kind = '') {
	const h = $('cl-rally-hint');
	h.innerHTML = html;
	h.classList.toggle('is-error', kind === 'error');
	h.classList.toggle('is-ok', kind === 'ok');
}

// Lightweight transient toast reusing the rally hint when the dock is hidden.
let toastTimer = null;
function toast(msg, isError) {
	// If the dock is open, surface it inline; else use a floating banner.
	if (game.enlist && !$('cl-rally').hidden) {
		setHint(msg, isError ? 'error' : 'ok');
		return;
	}
	let bn = $('cl-toast');
	if (!bn) {
		bn = el('div', { id: 'cl-toast' });
		Object.assign(bn.style, {
			position: 'fixed', left: '50%', bottom: '24px', transform: 'translateX(-50%)',
			zIndex: '70', padding: '10px 18px', borderRadius: '999px', maxWidth: '90vw',
			font: '600 13px/1.3 var(--font-body)', boxShadow: 'var(--shadow-3)',
			border: '1px solid var(--stroke-strong)', background: 'color-mix(in srgb, var(--bg-1) 92%, transparent)',
			backdropFilter: 'blur(12px)', textAlign: 'center',
		});
		document.body.appendChild(bn);
	}
	bn.textContent = msg;
	bn.style.color = isError ? 'var(--danger)' : 'var(--success)';
	bn.style.opacity = '1';
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => { bn.style.opacity = '0'; bn.style.transition = 'opacity .3s'; }, 3200);
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
function setTab(tab) {
	game.tab = tab;
	document.querySelectorAll('.cl-tab[data-tab]').forEach((b) => {
		const on = b.dataset.tab === tab;
		b.classList.toggle('active', on);
		b.setAttribute('aria-selected', on ? 'true' : 'false');
	});
	$('cl-arena').hidden = tab !== 'arena';
	$('cl-standings').hidden = tab !== 'standings';
	if (tab === 'arena' && game.state) renderArena(game.state);
	if (tab === 'standings') renderStandings();
}

// ── Ambient particle field ───────────────────────────────────────────────────
function startField() {
	const canvas = $('cl-field');
	if (!canvas || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
	const ctx = canvas.getContext('2d');
	let w, h, parts;
	const resize = () => {
		w = canvas.width = window.innerWidth;
		h = canvas.height = window.innerHeight;
		const count = Math.min(70, Math.floor((w * h) / 26000));
		parts = Array.from({ length: count }, () => ({
			x: Math.random() * w, y: Math.random() * h,
			vx: (Math.random() - 0.5) * 0.25, vy: (Math.random() - 0.5) * 0.25,
			r: Math.random() * 1.6 + 0.4,
		}));
	};
	resize();
	window.addEventListener('resize', resize, { passive: true });
	let raf;
	const draw = () => {
		ctx.clearRect(0, 0, w, h);
		ctx.fillStyle = 'rgba(248,113,113,0.5)';
		for (const p of parts) {
			p.x += p.vx; p.y += p.vy;
			if (p.x < 0 || p.x > w) p.vx *= -1;
			if (p.y < 0 || p.y > h) p.vy *= -1;
			ctx.beginPath();
			ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
			ctx.fill();
		}
		raf = requestAnimationFrame(draw);
	};
	draw();
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) cancelAnimationFrame(raf);
		else draw();
	});
}

// ── Boot ─────────────────────────────────────────────────────────────────────
function boot() {
	initWalletButton();
	startField();

	document.querySelectorAll('.cl-tab[data-tab]').forEach((b) => {
		b.addEventListener('click', () => setTab(b.dataset.tab));
	});

	// Rally interactions.
	const tap = $('cl-tap');
	tap.addEventListener('pointerdown', (e) => { e.preventDefault(); onTap(); });
	$('cl-rally-close').addEventListener('click', () => {
		flush();
		hideRally();
	});
	// Spacebar rallies while the dock is open and focus isn't in a field.
	let spaceHeld = false;
	window.addEventListener('keydown', (e) => {
		if (e.code !== 'Space' && e.key !== ' ') return;
		if ($('cl-rally').hidden) return;
		const t = e.target;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
		e.preventDefault();
		if (!spaceHeld) { spaceHeld = true; onTap(); }
	});
	window.addEventListener('keyup', (e) => {
		if (e.code === 'Space' || e.key === ' ') spaceHeld = false;
	});

	// Re-enlist offer if the wallet changes out from under an active rally.
	window.addEventListener('wallet:changed', (e) => {
		const addr = e.detail?.address || null;
		if (game.enlist && addr && addr !== game.enlist.wallet) {
			game.enlist = null;
			hideRally();
			toast('Wallet switched — enlist again to rally.', false);
			if (game.state) renderArena(game.state);
		}
	});

	// Flush any buffered taps before the tab unloads.
	window.addEventListener('pagehide', () => {
		if (game.enlist && game.pendingTaps > 0) {
			navigator.sendBeacon?.(
				`${API}/rally`,
				new Blob([JSON.stringify({ pass: game.enlist.warPass, taps: Math.min(50, game.pendingTaps) })], { type: 'application/json' }),
			);
		}
	});

	startTimer();
	poll();
	game.pollTimer = setInterval(() => {
		if (!document.hidden) poll();
	}, 5000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
