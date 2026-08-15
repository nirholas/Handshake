// /world-lines — the World Lines discovery surface + creator dashboard.
//
// Four tabs, every state designed:
//   · Near me      — fix-gated, co-located quests you can walk to right now.
//   · Explore      — coarse region roll-up (no coordinates) for browsing the world.
//   · My proofs    — the agent-signed proofs-of-presence you’ve earned, each verifiable.
//   · Create       — place a World Line on one of your IRL pins (auth), see completions.
//
// The completion ceremony (AR + first-class non-AR fallback) lives in
// src/irl/world-line-ar.js and is hosted in a modal here.

import { worldLinesClient as api } from './irl/world-lines-client.js';
import { WorldLineCeremony } from './irl/world-line-ar.js';

const $ = (id) => document.getElementById(id);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── Geolocation ──────────────────────────────────────────────────────────────
const fixState = { lat: null, lng: null, accuracy: null, status: 'idle', error: null };
let _watchId = null;

function startLocation() {
	if (fixState.status === 'watching' || !navigator.geolocation) {
		if (!navigator.geolocation) { fixState.status = 'unsupported'; }
		return;
	}
	fixState.status = 'prompting';
	navigator.geolocation.getCurrentPosition(onFix, onFixError, { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 });
	_watchId = navigator.geolocation.watchPosition(onFix, onFixError, { enableHighAccuracy: true, maximumAge: 4000 });
}
function onFix(pos) {
	fixState.lat = pos.coords.latitude;
	fixState.lng = pos.coords.longitude;
	fixState.accuracy = pos.coords.accuracy;
	const wasReady = fixState.status === 'watching';
	fixState.status = 'watching';
	fixState.error = null;
	if (!wasReady && activeTab === 'near') renderNear();
}
function onFixError(err) {
	fixState.status = 'error';
	fixState.error = err.code === 1 ? 'denied' : 'unavailable';
	if (activeTab === 'near') renderNear();
}
function currentFix() {
	return Number.isFinite(fixState.lat) ? { lat: fixState.lat, lng: fixState.lng, accuracy: fixState.accuracy } : null;
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
// Roving-tabindex tablist per the WAI-ARIA tabs pattern: exactly one tab sits in the
// page tab order, arrows/Home/End move between them, and the selection is mirrored
// into the URL hash so a tab is linkable and the back button walks the tabs.
let activeTab = 'near';
const TABS = ['near', 'explore', 'collectibles', 'create'];
const tabList = document.querySelector('.tabs');

function selectTab(name, { updateHash = true, focusTab = false } = {}) {
	activeTab = name;
	TABS.forEach((t) => {
		const tab = $(`tab-${t}`);
		const on = t === name;
		tab.setAttribute('aria-selected', String(on));
		tab.tabIndex = on ? 0 : -1;
		$(`panel-${t}`).classList.toggle('active', on);
	});
	if (focusTab) $(`tab-${name}`).focus();
	if (updateHash && (location.hash || '').replace('#', '') !== name) {
		history.pushState(null, '', `#${name}`);
	}
	if (name === 'near') { startLocation(); renderNear(); }
	if (name === 'explore') renderExplore();
	if (name === 'collectibles') renderCollectibles();
	if (name === 'create') renderCreate();
}

function syncTabFromHash() {
	const raw = (location.hash || '').replace('#', '');
	// Backing out to the entry the visitor arrived on (no hash) has to land on the
	// default tab, not leave whichever tab they had walked to still selected.
	const name = TABS.includes(raw) ? raw : 'near';
	if (name !== activeTab) selectTab(name, { updateHash: false });
}

TABS.forEach((t) => $(`tab-${t}`).addEventListener('click', () => selectTab(t)));
tabList.addEventListener('keydown', (e) => {
	const i = TABS.indexOf(activeTab);
	let next = null;
	if (e.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length];
	else if (e.key === 'ArrowLeft') next = TABS[(i - 1 + TABS.length) % TABS.length];
	else if (e.key === 'Home') next = TABS[0];
	else if (e.key === 'End') next = TABS[TABS.length - 1];
	if (!next) return;
	e.preventDefault();
	selectTab(next, { focusTab: true });
});
window.addEventListener('popstate', syncTabFromHash);
window.addEventListener('hashchange', syncTabFromHash);

// ── HTML helpers ─────────────────────────────────────────────────────────────
function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function diffChip(d) { return `<span class="chip ${esc(d)}">${esc(cap(d))}</span>`; }
function rewardChip(k) {
	return k === 'three_pool'
		? `<span class="chip reward">◎ $THREE pool</span>`
		: `<span class="chip reward">✦ Collectible</span>`;
}
function distChip(m) {
	if (!Number.isFinite(m)) return '';
	const label = m < 1000 ? `≈ ${m} m away` : `≈ ${(m / 1000).toFixed(1)} km away`;
	return `<span class="chip dist">📍 ${esc(label)}</span>`;
}
function cap(s) { return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1); }
function stateBlock({ ico, title, body, action }) {
	return `<div class="state"><div class="ico">${ico}</div><h3>${esc(title)}</h3><p>${body}</p>${action || ''}</div>`;
}
function skeletons(n = 4) {
	return `<div class="grid">${Array.from({ length: n }, () => '<div class="skel"></div>').join('')}</div>`;
}

// ── Near me ──────────────────────────────────────────────────────────────────
async function renderNear() {
	const el = $('panel-near');
	if (fixState.status === 'unsupported') {
		el.innerHTML = stateBlock({ ico: '🧭', title: 'Location isn’t available', body: 'Your browser can’t share a location, so nearby quests can’t load. Try the <strong>Explore</strong> tab to browse by region.' });
		return;
	}
	if (fixState.status === 'idle' || fixState.status === 'prompting') {
		el.innerHTML = stateBlock({ ico: '📡', title: 'Finding quests around you', body: 'Allow location access so we can show the World Lines within walking distance. Your exact spot never leaves your device.' });
		startLocation();
		return;
	}
	if (fixState.status === 'error') {
		const denied = fixState.error === 'denied';
		el.innerHTML = stateBlock({
			ico: denied ? '🔒' : '⚠️',
			title: denied ? 'Location permission needed' : 'Couldn’t get your location',
			body: denied
				? 'World Lines are a get-up-and-go game — we need your location to show quests you can walk to. Enable location for this site and retry.'
				: 'We couldn’t read a location fix. Step outside or check your signal, then retry.',
			action: '<button class="btn primary" id="near-retry">Retry</button>',
		});
		$('near-retry')?.addEventListener('click', () => { fixState.status = 'idle'; renderNear(); });
		return;
	}
	// status: watching
	el.innerHTML = skeletons();
	const fix = currentFix();
	let data;
	try {
		data = await api.nearby(fix.lat, fix.lng, fix.accuracy);
	} catch (err) {
		if (err.code === 'fix_required') {
			el.innerHTML = stateBlock({ ico: '📡', title: 'Confirming your location', body: 'Hold tight while we verify your position…', action: '<button class="btn" id="near-retry">Retry</button>' });
			$('near-retry')?.addEventListener('click', renderNear);
			return;
		}
		el.innerHTML = stateBlock({ ico: '⚠️', title: 'Couldn’t load quests', body: esc(err.message || 'Network error.'), action: '<button class="btn primary" id="near-retry">Retry</button>' });
		$('near-retry')?.addEventListener('click', renderNear);
		return;
	}
	const quests = data.world_lines || [];
	if (!quests.length) {
		el.innerHTML = stateBlock({
			ico: '🌎', title: 'No World Lines near you yet',
			body: 'Be the first to leave one here — drop a 3D agent on the <a href="/irl">IRL map</a>, then place a World Line on it from the <strong>Create</strong> tab.',
			action: '<button class="btn" id="near-refresh">Refresh</button>',
		});
		$('near-refresh')?.addEventListener('click', renderNear);
		return;
	}
	el.innerHTML = `<div class="grid">${quests.map(questCard).join('')}</div>`;
	quests.forEach((q) => {
		$(`q-${q.id}`)?.addEventListener('click', () => openCeremony(q));
	});
}

function questCard(q) {
	const reached = q.capacity_reached;
	const done = q.completed_by_me;
	const inRange = Number.isFinite(q.distance_m) && q.distance_m <= 80;
	const cta = done
		? '<button class="btn full" disabled>✓ Proof earned</button>'
		: reached
			? '<button class="btn full" disabled>Reward pool full</button>'
			: inRange
				? `<button class="btn primary full" id="q-${q.id}">You’re here — begin</button>`
				: `<button class="btn full" id="q-${q.id}">Travel here to begin</button>`;
	return `
		<article class="card">
			<h3>${esc(q.title)}</h3>
			${q.prompt ? `<p style="color:var(--text-2);margin:0;font-size:14px;line-height:1.45">${esc(q.prompt)}</p>` : ''}
			<div class="meta">
				${distChip(q.distance_m)}
				${diffChip(q.difficulty)}
				${rewardChip(q.reward_kind)}
				${done ? '<span class="chip done">✓ Completed</span>' : ''}
			</div>
			<div class="cta-row">${cta}</div>
		</article>`;
}

// ── Explore (coarse regions) ─────────────────────────────────────────────────
async function renderExplore() {
	const el = $('panel-explore');
	el.innerHTML = skeletons(3);
	let data;
	try {
		data = await api.browseRegions();
	} catch (err) {
		el.innerHTML = stateBlock({ ico: '⚠️', title: 'Couldn’t load regions', body: esc(err.message || 'Network error.'), action: '<button class="btn primary" id="exp-retry">Retry</button>' });
		$('exp-retry')?.addEventListener('click', renderExplore);
		return;
	}
	const regions = data.regions || [];
	if (!regions.length) {
		el.innerHTML = stateBlock({ ico: '🗺️', title: 'No active World Lines anywhere yet', body: 'The map is wide open. Place the first quest from the <strong>Create</strong> tab.' });
		return;
	}
	el.innerHTML = `
		<p style="color:var(--text-2);margin:0 0 14px;font-size:14px">${regions.length} ${regions.length === 1 ? 'region has' : 'regions have'} active quests. Regions are ~5&nbsp;km — coarse on purpose, so browsing never reveals a quest’s exact spot.</p>
		<div style="display:flex;flex-direction:column;gap:10px" id="region-list">
			${regions.map((r) => `
				<div class="region-row" data-region="${esc(r.region_cell)}" role="button" tabindex="0"
						aria-expanded="false" aria-controls="region-detail">
					<div>
						<div style="font-weight:600">${r.quests} ${r.quests === 1 ? 'quest' : 'quests'}</div>
						<div class="rc">region ${esc(r.region_cell)} · ${r.completions || 0} completions</div>
					</div>
					<div class="meta" style="margin:0">${r.hard ? `<span class="chip hard">${r.hard} hard</span>` : ''}<span class="chip">View →</span></div>
				</div>`).join('')}
		</div>
		<div id="region-detail" style="margin-top:16px"></div>`;
	el.querySelectorAll('.region-row').forEach((row) => {
		const open = () => openRegion(row.dataset.region);
		row.addEventListener('click', open);
		row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
	});
}

async function openRegion(region) {
	const host = $('region-detail');
	document.querySelectorAll('.region-row').forEach((row) => {
		const on = row.dataset.region === region;
		row.setAttribute('aria-expanded', String(on));
		row.classList.toggle('open', on);
	});
	host.innerHTML = skeletons(2);
	const heading = `<h3 style="margin:6px 0 12px;font-size:16px">Quests in region <span class="mono">${esc(region)}</span></h3>`;
	let data;
	try {
		data = await api.browseRegion(region);
	} catch (err) {
		host.innerHTML = heading + stateBlock({
			ico: '⚠️', title: 'Couldn’t load this region',
			body: esc(err.message || 'Network error.'),
			action: '<button class="btn primary" id="region-retry">Retry</button>',
		});
		$('region-retry')?.addEventListener('click', () => openRegion(region));
		return;
	}
	const quests = data.quests || [];
	// A region roll-up is a snapshot: its quests can expire or fill between the list
	// being built and this click, so "the region emptied out" is a real state, not a bug.
	if (!quests.length) {
		host.innerHTML = heading + stateBlock({
			ico: '🕓', title: 'Nothing active here right now',
			body: 'Every quest in this region has expired or filled up since the list was built. Try another region, or place one here from the <strong>Create</strong> tab.',
		});
		return;
	}
	host.innerHTML = heading + `
		<div class="grid">
			${quests.map((q) => `
				<article class="card">
					<h3>${esc(q.title)}</h3>
					<div class="meta">${diffChip(q.difficulty)}${rewardChip(q.reward_kind)}<span class="chip">${q.completion_count || 0} done</span>${q.capacity_reached ? '<span class="chip">Full</span>' : ''}</div>
					<p style="color:var(--text-3);font-size:13px;margin:6px 0 0">Travel to this region and open the <strong>Near me</strong> tab to find and complete it in AR.</p>
				</article>`).join('')}
		</div>`;
}

// ── My proofs (collectibles) ─────────────────────────────────────────────────
async function renderCollectibles() {
	const el = $('panel-collectibles');
	el.innerHTML = skeletons(3);
	let data;
	try {
		data = await api.myCollectibles();
	} catch (err) {
		el.innerHTML = stateBlock({ ico: '⚠️', title: 'Couldn’t load your proofs', body: esc(err.message || 'Network error.'), action: '<button class="btn primary" id="col-retry">Retry</button>' });
		$('col-retry')?.addEventListener('click', renderCollectibles);
		return;
	}
	const items = data.collectibles || [];
	if (!items.length) {
		el.innerHTML = stateBlock({ ico: '✦', title: 'No proofs yet', body: 'Complete a World Line and the agent will sign your first proof of presence. Find one on the <strong>Near me</strong> tab.' });
		return;
	}
	el.innerHTML = `<div class="grid">${items.map(collectibleCard).join('')}</div>`;
	items.forEach((c) => {
		$(`verify-${c.proof_id}`)?.addEventListener('click', () => verifyInline(c.proof_id));
	});
}

// A proof is permanent, so its card has to stay readable even when a field is absent:
// `new Date(null)` is the 1970 epoch, which would print a date the holder never earned.
function earnedLabel(v) {
	const d = new Date(v ?? NaN);
	return Number.isNaN(d.getTime()) ? 'Date unknown' : d.toLocaleDateString();
}
function signerLabel(key) {
	const s = String(key || '');
	if (!s) return 'the agent';
	return s.length > 8 ? `${s.slice(0, 8)}…` : s;
}

function collectibleCard(c) {
	return `
		<article class="card collectible">
			<div class="seal">✦</div>
			<h3>${esc(c.name || 'Proof of presence')}</h3>
			<p style="color:var(--text-2);font-size:13px;margin:0 0 4px">${esc(c.world_line_title || 'World Line')}</p>
			<div class="meta">
				${c.difficulty ? diffChip(c.difficulty) : ''}
				<span class="chip">${esc(earnedLabel(c.earned_at))}</span>
			</div>
			<p class="mono">signed by ${esc(signerLabel(c.signer_pubkey))} · area ${esc(c.coarse_cell || 'unknown')}</p>
			<div class="cta-row">
				<button class="btn full" id="verify-${c.proof_id}">Verify signature</button>
			</div>
			<div id="vres-${c.proof_id}"></div>
		</article>`;
}

async function verifyInline(proofId) {
	const host = $(`vres-${proofId}`);
	host.innerHTML = `<p style="color:var(--text-2);font-size:13px;margin:10px 0 0">Re-checking the agent signature…</p>`;
	try {
		const data = await api.verify(proofId);
		host.innerHTML = data.verified
			? `<p style="color:var(--green);font-size:13px;margin:10px 0 0">✓ Genuine — the agent’s signature checks out. <a href="/api/irl/world-lines/verify/${proofId}" target="_blank" rel="noopener">Raw proof ↗</a></p>`
			: `<p style="color:var(--danger);font-size:13px;margin:10px 0 0">✕ Signature did not verify.</p>`;
	} catch (err) {
		host.innerHTML = `<p style="color:var(--danger);font-size:13px;margin:10px 0 0">${esc(err.message || 'Verification failed.')}</p>`;
	}
}

// ── Create + creator dashboard ───────────────────────────────────────────────
async function renderCreate() {
	const el = $('panel-create');
	el.innerHTML = skeletons(2);
	// Auth + pins are read together: /mine returns 401 when signed out.
	let mineData;
	try {
		mineData = await api.mine();
	} catch (err) {
		if (err.status === 401) {
			el.innerHTML = stateBlock({ ico: '🔑', title: 'Sign in to place a World Line', body: 'A World Line is signed by your agent’s wallet, so creating one needs an account. <a href="/login?next=/world-lines">Sign in</a> and come back.' });
			return;
		}
		el.innerHTML = stateBlock({ ico: '⚠️', title: 'Couldn’t load your World Lines', body: esc(err.message || 'Network error.'), action: '<button class="btn primary" id="cre-retry">Retry</button>' });
		$('cre-retry')?.addEventListener('click', renderCreate);
		return;
	}

	const mine = mineData.world_lines || [];
	const heat = mineData.heatmap || [];
	const heatByWl = {};
	heat.forEach((h) => { heatByWl[h.world_line_id] = (heatByWl[h.world_line_id] || 0) + h.completions; });

	// Pins to anchor a quest onto (auth pins).
	let pins = [];
	try {
		const r = await fetch('/api/irl/pins?mine=1', { credentials: 'include' });
		if (r.ok) pins = (await r.json()).pins || [];
	} catch { /* the form handles the no-pin case */ }

	el.innerHTML = `
		<div style="display:grid;gap:24px">
			<div>
				<h2 style="font-size:18px;margin:0 0 12px">Place a World Line</h2>
				${createForm(pins)}
			</div>
			<div>
				<h2 style="font-size:18px;margin:0 0 12px">Your active quests</h2>
				${mine.length ? `<div class="grid">${mine.map((w) => dashCard(w, heatByWl[w.id] || 0)).join('')}</div>`
					: '<p style="color:var(--text-2)">No World Lines yet. Place your first one above.</p>'}
			</div>
		</div>`;
	wireCreateForm();
}

function createForm(pins) {
	if (!pins.length) {
		return `<div class="form-note">You need an IRL pin first — a placed 3D agent to anchor the quest to.
			<a href="/irl">Open the IRL map</a> and drop one, then come back.</div>`;
	}
	return `
		<form class="form" id="wl-form">
			<div class="field">
				<label for="f-pin">Anchor pin (your placed agent)</label>
				<select id="f-pin" required>
					${pins.map((p) => `<option value="${esc(p.id)}" data-agent="${esc(p.agent_id || '')}">${esc(p.avatar_name || p.caption || 'Agent')} · ${esc((p.id || '').slice(0, 8))}</option>`).join('')}
				</select>
				<div class="hint">The quest lands at this agent’s spot. Only the coarse ~1&nbsp;km cell is ever stored on the quest.</div>
			</div>
			<div class="field">
				<label for="f-title">Title</label>
				<input id="f-title" maxlength="80" required placeholder="e.g. Find the lobby greeter" />
			</div>
			<div class="field">
				<label for="f-prompt">What the agent says (spoken aloud in AR)</label>
				<textarea id="f-prompt" rows="2" maxlength="240" placeholder="Welcome, traveler. Tap me to prove you came."></textarea>
			</div>
			<div class="field">
				<label for="f-kind">Challenge</label>
				<select id="f-kind">
					<option value="tap">Tap to meet (presence only)</option>
					<option value="phrase">Say a passphrase</option>
					<option value="quiz">Answer a quiz</option>
				</select>
			</div>
			<div class="field" id="f-phrase-wrap" hidden>
				<label for="f-phrase">Passphrase the visitor must say</label>
				<input id="f-phrase" maxlength="80" placeholder="open sesame" />
			</div>
			<div class="field" id="f-quiz-wrap" hidden>
				<label for="f-question">Quiz question</label>
				<input id="f-question" maxlength="240" placeholder="What year did three.ws launch?" />
				<div class="choices-edit" style="margin-top:8px" id="f-choices">
					<input class="f-choice" maxlength="60" placeholder="Choice 1" />
					<input class="f-choice" maxlength="60" placeholder="Choice 2" />
					<input class="f-choice" maxlength="60" placeholder="Choice 3 (optional)" />
					<input class="f-choice" maxlength="60" placeholder="Choice 4 (optional)" />
				</div>
				<div class="hint" style="margin-top:8px">Correct answer:
					<select id="f-answer"><option value="0">Choice 1</option><option value="1">Choice 2</option><option value="2">Choice 3</option><option value="3">Choice 4</option></select>
				</div>
			</div>
			<div class="field" style="display:flex;gap:12px">
				<div style="flex:1"><label for="f-diff">Difficulty</label>
					<select id="f-diff"><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></div>
				<div style="flex:1"><label for="f-reward">Reward</label>
					<select id="f-reward"><option value="collectible">Collectible proof</option><option value="three_pool">$THREE prize pool</option></select></div>
			</div>
			<div class="field" style="display:flex;gap:12px">
				<div style="flex:1"><label for="f-max">Max completions (blank = unlimited)</label>
					<input id="f-max" type="number" min="1" placeholder="∞" /></div>
				<div style="flex:1"><label for="f-life">Active for (days)</label>
					<input id="f-life" type="number" min="1" max="90" value="30" /></div>
			</div>
			<button type="submit" class="btn primary full" id="f-submit">Place World Line</button>
			<p id="f-msg" style="margin:12px 0 0;font-size:14px"></p>
		</form>`;
}

function wireCreateForm() {
	const form = $('wl-form');
	if (!form) return;
	const kind = $('f-kind');
	const sync = () => {
		$('f-phrase-wrap').hidden = kind.value !== 'phrase';
		$('f-quiz-wrap').hidden = kind.value !== 'quiz';
	};
	kind.addEventListener('change', sync); sync();

	form.addEventListener('submit', async (e) => {
		e.preventDefault();
		const msg = $('f-msg');
		const submit = $('f-submit');
		const pinSel = $('f-pin');
		const opt = pinSel.options[pinSel.selectedIndex];
		const payload = {
			pinId: pinSel.value,
			agentId: opt?.dataset.agent || undefined,
			title: $('f-title').value.trim(),
			prompt: $('f-prompt').value.trim(),
			reward_kind: $('f-reward').value,
			difficulty: $('f-diff').value,
			lifetime_days: Number($('f-life').value) || 30,
		};
		const maxV = Number($('f-max').value);
		if (Number.isInteger(maxV) && maxV > 0) payload.max_completions = maxV;

		const k = $('f-kind').value;
		if (k === 'phrase') payload.challenge = { kind: 'phrase', phrase: $('f-phrase').value.trim() };
		else if (k === 'quiz') {
			const choices = [...document.querySelectorAll('.f-choice')].map((i) => i.value.trim()).filter(Boolean);
			payload.challenge = { kind: 'quiz', question: $('f-question').value.trim(), choices, answer: Number($('f-answer').value) };
		} else payload.challenge = { kind: 'tap' };

		submit.disabled = true; msg.textContent = 'Placing…'; msg.style.color = 'var(--text-2)';
		try {
			await api.create(payload);
			msg.textContent = '✓ World Line placed. Visitors can now find it on the map.';
			msg.style.color = 'var(--green)';
			setTimeout(renderCreate, 900);
		} catch (err) {
			msg.textContent = err.message || 'Could not place the World Line.';
			msg.style.color = 'var(--danger)';
			submit.disabled = false;
		}
	});
}

function dashCard(w, completions) {
	const pct = w.max_completions ? Math.min(100, Math.round((w.completion_count / w.max_completions) * 100)) : null;
	return `
		<article class="card dash-quest">
			<h3>${esc(w.title)}</h3>
			<div class="meta">${diffChip(w.difficulty)}${rewardChip(w.reward_kind)}${w.expired ? '<span class="chip">Expired</span>' : w.hidden ? '<span class="chip">Hidden</span>' : '<span class="chip done">Active</span>'}</div>
			<div style="font-size:13px;color:var(--text-2)">${w.completion_count} ${w.completion_count === 1 ? 'completion' : 'completions'}${w.max_completions ? ` of ${w.max_completions}` : ''}</div>
			${pct != null ? `<div class="bar"><span style="width:${pct}%"></span></div>` : ''}
			<div style="font-size:12px;color:var(--text-3)">Anchored in area <span class="mono">${esc(w.coarse_cell)}</span> — completions are counted by coarse cell only.</div>
		</article>`;
}

// ── Ceremony modal ───────────────────────────────────────────────────────────
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function modalFocusables() {
	return [...$('ceremony-modal').querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
}

let _ceremony = null;
let _ceremonyOpener = null;
async function openCeremony(quest) {
	const fix = currentFix();
	// The fix can be revoked between the card rendering and this tap (permission pulled
	// mid-session). Fall back to the location states rather than silently doing nothing.
	if (!fix) {
		fixState.status = fixState.status === 'watching' ? 'idle' : fixState.status;
		renderNear();
		return;
	}
	// Pull the full quest detail (reveals the AR answer only because we’re co-located).
	let detail = quest;
	try {
		const d = await api.getQuest(quest.id, fix.lat, fix.lng, fix.accuracy);
		if (d?.world_line) detail = { ...quest, ...d.world_line };
	} catch { /* fall back to the list view of the quest */ }

	const host = $('ceremony-host');
	host.innerHTML = '';
	_ceremonyOpener = document.activeElement;
	_ceremony = new WorldLineCeremony({
		worldLine: detail,
		client: api,
		getFix: currentFix,
		avatarUrl: quest.avatar_url || null,
		muted: reduceMotion,
		onGranted: () => { closeCeremony(); renderNear(); },
	}).mount(host);
	$('ceremony-modal').classList.add('open');
	// aria-modal only describes the dialog; the focus has to actually move into it and
	// stay there, or a keyboard user tabs straight back out into the page behind.
	(modalFocusables()[0] || $('ceremony-close')).focus();
}
function closeCeremony() {
	$('ceremony-modal').classList.remove('open');
	if (_ceremony) { _ceremony.destroy(); _ceremony = null; }
	// The opener is gone whenever the grant re-rendered the list; the tab is the
	// nearest stable landmark to hand the keyboard back to.
	const back = _ceremonyOpener?.isConnected ? _ceremonyOpener : $(`tab-${activeTab}`);
	_ceremonyOpener = null;
	back?.focus();
}
$('ceremony-close').addEventListener('click', closeCeremony);
$('ceremony-modal').addEventListener('click', (e) => { if (e.target === $('ceremony-modal')) closeCeremony(); });
$('ceremony-modal').addEventListener('keydown', (e) => {
	if (e.key !== 'Tab') return;
	const items = modalFocusables();
	if (!items.length) return;
	const first = items[0];
	const last = items[items.length - 1];
	if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
	else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('ceremony-modal').classList.contains('open')) closeCeremony(); });

// ── Boot ─────────────────────────────────────────────────────────────────────
// Deep link support: /world-lines#explore etc. The boot selection never writes a
// history entry, so a plain visit leaves the URL clean and the first Back leaves.
const hashTab = (location.hash || '').replace('#', '');
selectTab(TABS.includes(hashTab) ? hashTab : 'near', { updateHash: false });
