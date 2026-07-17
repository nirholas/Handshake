// Daily Forge (/daily) — a new 3D creative challenge every day, with a streak.
//
// The retention loop the platform was missing for its anonymous majority: the
// logged-in streak system (api/_lib/streaks.js) needs an account, so the huge
// no-sign-up forge audience had no reason to come back. This surface gives them
// one — a deterministic daily theme (src/daily/daily-theme.js), a localStorage
// streak (src/daily/creator-streak.js), and a one-minute free generation that
// keeps the flame lit. Every creation also lands in the shared recents so it's
// one tap from AR and the AR Studio.
//
// Self-contained apart from the free forge lane (POST /api/forge, same contract
// as /ar) and the community gallery (/api/forge-gallery). model-viewer is loaded
// by the page via CDN.

import { seedForDate, themeForDate, utcDayKey } from './daily/daily-theme.js';
import {
	loadStreak, milestoneFor, recordDay, saveStreak, streakStatus,
} from './daily/creator-streak.js';
import { createLogger } from './shared/log.js';

const log = createLogger('daily');
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const RECENT_KEY = 'twx_ar_forge_recent'; // shared with /ar + AR Studio
const POLL_MS = 3000;
const MAX_POLL_MS = 300000;

// Stable anonymous forge identity (same key /forge, /ar, and AR Studio use), so
// generations count toward this browser's gallery and streak consistently.
const CLIENT_ID = (() => {
	const KEY = 'forge:cid';
	try {
		let id = localStorage.getItem(KEY);
		if (!id) { id = crypto?.randomUUID?.() || `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; localStorage.setItem(KEY, id); }
		return id;
	} catch { return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }
})();

const today = utcDayKey(new Date());
const theme = themeForDate(new Date());

// ── Render the day ─────────────────────────────────────────────────────────────
document.documentElement.style.setProperty('--theme', theme.accent);
$('theme-day').textContent = `Day ${theme.day} · Daily challenge`;
$('theme-emoji').textContent = theme.emoji;
$('theme-title').textContent = theme.title;
$('theme-hint').textContent = theme.hint;
document.title = `${theme.emoji} ${theme.title} · Daily Forge · three.ws`;

const input = $('prompt');
input.value = seedForDate(new Date());
input.placeholder = `Your take on "${theme.title}"…`;

// Seed chips (tap to fill).
const chips = $('chips');
for (const seed of theme.seeds) {
	const b = document.createElement('button');
	b.type = 'button'; b.className = 'chip'; b.textContent = seed;
	b.addEventListener('click', () => { input.value = seed; forge(seed); });
	chips.appendChild(b);
}

// ── Streak ─────────────────────────────────────────────────────────────────────
function renderStreak() {
	const st = streakStatus(loadStreak(), today);
	const pill = $('streak-pill');
	const pillN = $('streak-pill-n');
	const streakEl = $('streak');
	const n = $('streak-n');
	const sub = $('streak-sub');
	const best = $('streak-best');

	const shown = st.actedToday ? st.current : (st.atRisk ? st.current : 0);
	pillN.textContent = String(shown);
	pill.classList.toggle('zero', shown === 0);
	streakEl.classList.toggle('lit', shown > 0);
	best.textContent = st.best > 1 ? `Best: ${st.best}` : '';

	if (st.actedToday) {
		n.textContent = st.current === 1 ? 'Streak started — day 1' : `${st.current}-day streak 🔥`;
		sub.textContent = 'You forged today. Come back tomorrow to keep it going.';
	} else if (st.atRisk) {
		n.textContent = `${st.current}-day streak at risk`;
		sub.textContent = 'Forge today to keep your streak alive.';
	} else {
		n.textContent = 'Start your streak today';
		sub.textContent = st.best > 0 ? `Your best was ${st.best} days — forge today to begin again.` : 'Forge today’s theme to begin a daily streak.';
	}
}
renderStreak();

// Bump the streak after a real creation; celebrate a milestone.
function bumpStreak() {
	const { state, changed, milestone } = recordDay(loadStreak(), today);
	if (changed) saveStreak(state);
	renderStreak();
	if (milestone) celebrate(milestone, state.current);
}

function celebrate(milestone, current) {
	const emoji = milestone >= 100 ? '👑' : milestone >= 30 ? '🌟' : milestone >= 7 ? '🔥' : '✨';
	$('ms-emoji').textContent = emoji;
	$('ms-title').textContent = `${milestone}-day streak!`;
	$('ms-body').textContent = milestone >= 30
		? `${current} days of daily creation. You're a machine — keep the flame burning.`
		: `You've forged something ${milestone} days running. That's a real habit forming.`;
	$('milestone').classList.remove('hidden');
	try { navigator.vibrate?.([12, 40, 12]); } catch {}
}
$('ms-close').addEventListener('click', () => $('milestone').classList.add('hidden'));
$('milestone').addEventListener('click', (e) => { if (e.target === $('milestone')) $('milestone').classList.add('hidden'); });

// ── Forge flow (free NVIDIA lane) ──────────────────────────────────────────────
const mv = $('mv');
let runSeq = 0;
let elapsedTimer = null;
let current = null; // { glb, prompt }

function overlay(el) {
	['idle', 'working', 'failed'].forEach((id) => $(id).classList.add('hidden'));
	if (el) $(el).classList.remove('hidden');
}
function setBusy(b) {
	const go = $('go');
	go.disabled = b;
	go.innerHTML = b ? 'Forging…' : 'Forge<span aria-hidden="true">✦</span>';
}
function startElapsed() {
	const t0 = Date.now();
	stopElapsed();
	elapsedTimer = setInterval(() => { $('elapsed').textContent = `${Math.round((Date.now() - t0) / 1000)}s`; }, 1000);
}
function stopElapsed() { if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; } $('elapsed').textContent = ''; }
function isHttps(u) { try { return new URL(u).protocol === 'https:'; } catch { return false; } }

async function forge(prompt) {
	prompt = String(prompt || '').trim();
	if (prompt.length < 3) { input.focus(); return; }
	const seq = ++runSeq;
	setBusy(true);
	mv.classList.add('veiled');
	$('actions').classList.add('hidden');
	$('worktitle').textContent = `Forging "${prompt.length > 52 ? `${prompt.slice(0, 49)}…` : prompt}"`;
	$('workmsg').textContent = 'Sending your prompt to the forge.';
	overlay('working');
	startElapsed();

	try {
		const res = await fetch('/api/forge', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-forge-client': CLIENT_ID },
			body: JSON.stringify({ prompt, backend: 'nvidia' }),
		});
		const data = await res.json().catch(() => ({}));
		if (res.status === 503 || data.error === 'unconfigured') throw new Error('The generator is offline right now. Try again in a few minutes.');
		if (res.status === 429 || data.error === 'rate_limited') {
			const secs = Number(data.retry_after) > 0 ? Math.ceil(Number(data.retry_after)) : 15;
			throw new Error(data.message || `The forge is busy — try again in about ${secs}s.`);
		}
		if (!res.ok) throw new Error(data.message || `The generator returned ${res.status}.`);

		let done = data;
		if (!(data.status === 'done' && data.glb_url)) {
			if (!data.job_id) throw new Error('The forge did not accept the job. Try again.');
			$('workmsg').textContent = 'Queued. Sculpting starts in a moment.';
			done = await pollUntilDone(data.job_id, seq);
		}
		if (!done || seq !== runSeq) return;
		stopElapsed();
		remember(prompt, done.glb_url);
		showResult(done.glb_url, prompt);
	} catch (err) {
		if (seq !== runSeq) return;
		stopElapsed();
		setBusy(false);
		$('failmsg').textContent = (err && err.message) || 'Generation failed.';
		overlay('failed');
	}
}

async function pollUntilDone(jobId, seq) {
	const deadline = Date.now() + MAX_POLL_MS;
	for (;;) {
		if (seq !== runSeq) return null;
		if (Date.now() > deadline) throw new Error('Generation timed out. Try a simpler, single-object prompt.');
		await new Promise((r) => setTimeout(r, POLL_MS));
		if (seq !== runSeq) return null;
		const res = await fetch(`/api/forge?job=${encodeURIComponent(jobId)}`, { headers: { 'x-forge-client': CLIENT_ID } });
		const data = await res.json().catch(() => ({}));
		if (data.status === 'done' && data.glb_url) return data;
		if (data.status === 'failed') throw new Error(data.error || 'Generation failed. Try rephrasing the prompt.');
		if (data.status === 'running') $('workmsg').textContent = 'Sculpting geometry and painting textures. Usually under a minute.';
	}
}

function showResult(glbUrl, prompt, { forged = true } = {}) {
	if (!isHttps(glbUrl)) { $('failmsg').textContent = 'The forge returned an invalid model link.'; overlay('failed'); setBusy(false); return; }
	current = { glb: glbUrl, prompt, forged };
	overlay('working');
	$('worktitle').textContent = 'Loading your creation…';
	$('workmsg').textContent = 'Almost there.';
	mv.setAttribute('alt', prompt ? `3D model: ${prompt}` : 'Your 3D creation');
	mv.setAttribute('src', glbUrl);
}

mv.addEventListener('load', () => {
	if (!current || mv.getAttribute('src') !== current.glb) return;
	overlay(null);
	setBusy(false);
	mv.classList.remove('veiled');
	$('actions').classList.remove('hidden');
	$('meta').textContent = current.prompt || 'Your creation';
	$('meta').title = current.prompt || '';
	$('download').href = current.glb;
	$('download').setAttribute('download', `${fileName(current.prompt)}.glb`);
	$('studio-btn').href = `/ar/studio?src=${encodeURIComponent(current.glb)}&title=${encodeURIComponent((current.prompt || '').slice(0, 80))}`;
	if (mv.canActivateAR) $('ar-btn').textContent = '📱 View in your room';
	else $('ar-btn').textContent = '📱 Open AR on your phone';
	// The creation itself is the qualifying action — light the streak now (but not
	// for a deep-linked model the viewer didn't forge themselves).
	if (current.forged) bumpStreak();
});
mv.addEventListener('error', () => {
	if (!current) return;
	setBusy(false);
	$('failmsg').textContent = 'The model was generated but could not be displayed. You can still download the GLB.';
	overlay('failed');
	$('actions').classList.remove('hidden');
	if (current.forged) bumpStreak(); // a real generation happened even if the preview failed
});

function arLink() {
	if (!current) return `${location.origin}/daily`;
	return `${location.origin}/api/ar?src=${encodeURIComponent(current.glb)}&title=${encodeURIComponent((current.prompt || '').slice(0, 80))}`;
}
function fileName(prompt) {
	const s = (prompt || 'daily-forge').replace(/[^a-z0-9]+/gi, '-').slice(0, 48).replace(/^-|-$/g, '');
	return s || 'daily-forge';
}

$('ar-btn').addEventListener('click', () => {
	if (mv.canActivateAR) { try { mv.activateAR(); return; } catch {} }
	window.open(arLink(), '_blank', 'noopener');
});
$('share').addEventListener('click', () => {
	if (!current) return;
	const url = `${location.origin}/viewer?src=${encodeURIComponent(current.glb)}&title=${encodeURIComponent((current.prompt || '').slice(0, 80))}`;
	const payload = { title: `${theme.title} · Daily Forge`, text: `My take on today's Daily Forge theme: ${current.prompt}`, url };
	if (navigator.share) { navigator.share(payload).catch(() => {}); return; }
	navigator.clipboard?.writeText(url).then(() => {
		const b = $('share'); const old = b.textContent; b.textContent = 'Link copied ✓'; setTimeout(() => { b.textContent = old; }, 1600);
	}).catch(() => window.prompt('Copy this link:', url));
});
$('retry').addEventListener('click', () => { overlay('idle'); if (input.value.trim().length >= 3) forge(input.value); else input.focus(); });

function remember(prompt, glb) {
	try {
		const list = (JSON.parse(localStorage.getItem(RECENT_KEY) || '[]') || []).filter((e) => e && e.glb !== glb);
		list.unshift({ prompt: String(prompt).slice(0, 200), glb, ts: Date.now() });
		localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
	} catch {}
}

$('ask').addEventListener('submit', (e) => { e.preventDefault(); forge(input.value); });

// ── Community strip ────────────────────────────────────────────────────────────
(async function loadCommunity() {
	try {
		const res = await fetch('/api/forge-gallery?scope=community&limit=12');
		if (!res.ok) return;
		const data = await res.json();
		const items = (data.creations || [])
			.map((c) => ({ src: c.glb_url || c.glbUrl || '', title: c.prompt || c.title || '', poster: c.preview_image_url || c.previewImageUrl || '' }))
			.filter((c) => c.src && isHttps(c.src))
			.slice(0, 12);
		if (!items.length) return;
		const rail = $('rail');
		rail.innerHTML = items.map((it) => `
			<a href="/viewer?src=${encodeURIComponent(it.src)}&title=${encodeURIComponent(it.title.slice(0, 80))}" title="${esc(it.title)}">
				<span class="thumb">${it.poster ? `<img src="${esc(it.poster)}" alt="" loading="lazy" />` : '<span aria-hidden="true">◆</span>'}</span>
				<span class="cap">${esc(it.title || 'Untitled')}</span>
			</a>`).join('');
		$('rail-wrap').classList.remove('hidden');
	} catch (err) { log.warn('community load failed', err); }
})();

// Deep link: /daily?src=<glb> reopens a shared creation.
(function fromQuery() {
	const q = new URLSearchParams(location.search);
	const src = q.get('src') || '';
	if (src && isHttps(src)) showResult(src, q.get('title') || q.get('prompt') || 'Shared creation', { forged: false });
})();
