// Clip Director page, turn a real closed trade into shareable cards per surface.
// Populates a trader picker from the live mirror leaderboard (restricted to
// agents that actually have a closed round-trip, since a clip is minted from
// one), then fetches /api/clip-director for the selected agent and renders one
// card per surface (X / Telegram / Feed) with a copyable payload. Every state is
// designed: loading, empty (no closed trades), error, populated.

const agentSel = document.getElementById('cdAgent');
const tradeEl = document.getElementById('cdTrade');
const resultEl = document.getElementById('cdResult');

let reqSeq = 0;

const SURFACES = [
	{ key: 'x', label: 'X / Twitter' },
	{ key: 'telegram', label: 'Telegram' },
	{ key: 'feed', label: 'In-app Feed' },
];
const GESTURE_EMOJI = { celebrate: '🎉', point: '👉', wave: '👋', shrug: '🤷', sweat: '😰' };
// Each CTA the director can pick resolves to a real destination on this site, so
// the call to action on a card is a link the reader can follow, not a label.
const CTA = {
	'fork-this-trade': { label: 'Fork this trade', href: () => '/mirror' },
	'copy-the-agent': { label: 'Copy the agent', href: () => '/mirror' },
	'view-track-record': { label: 'View track record', href: (agentId) => (agentId ? `/agents/${encodeURIComponent(agentId)}` : '/leaderboard') },
};

function esc(s) {
	return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function deepLinkedAgentId() {
	const wanted = (new URLSearchParams(location.search).get('agent_id') || '').trim();
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wanted) ? wanted : '';
}

async function loadLeaders() {
	const wanted = deepLinkedAgentId();
	agentSel.innerHTML = '<option value="">Loading leaders…</option>';
	agentSel.disabled = true;
	try {
		// settled_min=1 is the whole point of this call: a clip needs a closed
		// round-trip, and the composite score does not correlate with having one,
		// so asking for the top N by score and filtering here would (and did) drop
		// every eligible agent off the end of the window.
		const res = await fetch('/api/mirror/leaderboard?sort=score&limit=50&settled_min=1', { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(String(res.status));
		const data = await res.json();
		const leaders = (data?.data?.leaders || []).filter((l) => l.settled > 0);
		const options = leaders.map((l) =>
			`<option value="${esc(l.agent_id)}">${esc(l.name || 'Unnamed')}: ${l.settled} trade${l.settled === 1 ? '' : 's'}${l.win_rate != null ? `, ${l.win_rate}% win` : ''}</option>`);
		// A shared link can point at an agent outside the ranked window (or a
		// private one that never ranks). Honour it rather than dropping the
		// visitor on an empty board; the option gets its real name once the clip
		// loads, and an unknown id lands in the designed error state.
		if (wanted && !leaders.some((l) => l.agent_id === wanted)) {
			options.unshift(`<option value="${esc(wanted)}">Shared agent</option>`);
		}
		if (!options.length) {
			agentSel.innerHTML = '<option value="">No agents with closed trades yet</option>';
			renderEmpty('No agent has a closed on-chain trade yet. Clips are minted from real closed round-trips, so the board fills as agents trade.');
			return;
		}
		agentSel.innerHTML = options.join('');
		agentSel.disabled = false;
		if (wanted) agentSel.value = wanted;
		loadClips(agentSel.value);
	} catch {
		agentSel.innerHTML = '<option value="">Could not load leaders</option>';
		renderError('The trader leaderboard is unreachable right now.', loadLeaders);
	}
}

function skeleton() {
	tradeEl.innerHTML = '';
	resultEl.innerHTML = `<div class="cd-skel" aria-hidden="true">${'<div class="cd-skel-card"></div>'.repeat(3)}</div><span class="sr-only">Directing clips…</span>`;
}

function renderEmpty(msg) {
	tradeEl.innerHTML = '';
	resultEl.innerHTML = `
		<div class="cd-empty">
			<h3>No closed trade to feature</h3>
			<p>${esc(msg || 'This agent has no closed trades yet. Clips are minted from real closed round-trips.')}</p>
			<a href="/leaderboard">See who is trading</a>
		</div>`;
}

// `retry` is what the failed step actually was: retrying the clip fetch when the
// picker never loaded would be a button that does nothing.
function renderError(msg, retry) {
	tradeEl.innerHTML = '';
	resultEl.innerHTML = `
		<div class="cd-error">
			<h3>Could not direct a clip</h3>
			<p>${esc(msg || 'The clip service is unreachable right now.')}</p>
			<button type="button" id="cdRetry">Try again</button>
		</div>`;
	document.getElementById('cdRetry')?.addEventListener('click', retry || (() => loadClips(agentSel.value)));
}

function renderTrade(agent, trade, proof) {
	const win = trade.is_win !== false;
	const cls = win ? 'win' : 'loss';
	const headline = trade.multiple != null ? `${trade.multiple}x`
		: trade.realized_pnl_sol != null ? `${trade.realized_pnl_sol > 0 ? '+' : ''}${trade.realized_pnl_sol} SOL`
		: trade.pnl_pct != null ? `${trade.pnl_pct}%` : 'closed';
	const sym = trade.symbol || trade.name || (trade.mint ? trade.mint.slice(0, 6) : 'coin');
	const who = agent?.id
		? `<a class="who" href="/agents/${encodeURIComponent(agent.id)}">${esc(agent.name || 'This agent')}</a>`
		: `<span class="who">${esc(agent?.name || 'This agent')}</span>`;
	tradeEl.innerHTML = `
		<div class="cd-trade">
			${who}
			<span class="sym">${esc(sym.startsWith('$') ? sym : `$${sym}`)}</span>
			<span class="stat">Result <b class="${cls}">${esc(headline)}</b></span>
			${trade.hold_min != null ? `<span class="stat">Held <b>${trade.hold_min < 60 ? `${trade.hold_min}m` : `${Math.round(trade.hold_min / 60)}h`}</b></span>` : ''}
			${trade.exit_reason ? `<span class="stat">Exit <b>${esc(trade.exit_reason.replace(/_/g, ' '))}</b></span>` : ''}
			${proof ? `<a class="proof" href="${esc(proof)}" target="_blank" rel="noopener noreferrer">On-chain proof ↗</a>` : ''}
		</div>`;
}

function clipCard(surface, label, clip, agentId) {
	const gesture = GESTURE_EMOJI[clip.avatar_gesture] || '🎯';
	const cta = CTA[clip.cta] || { label: clip.cta, href: () => '/leaderboard' };
	const copyPayload = `${clip.hook}\n\n${clip.body}\n\n(${cta.label} · verifiable on-chain · three.ws)`;
	return `
		<article class="cd-card ${surface}">
			<div class="cd-card-head"><span class="dot"></span>${esc(label)}</div>
			<div class="cd-card-body">
				<div class="cd-hook">${esc(clip.hook)}</div>
				<div class="cd-featstat"><span class="gesture" title="${esc(clip.avatar_gesture)} reaction" aria-hidden="true">${gesture}</span><span class="num">${esc(clip.feature_stat)}</span></div>
				<div class="cd-text">${esc(clip.body)}</div>
				<a class="cd-cta" href="${esc(cta.href(agentId))}">${esc(cta.label)} →</a>
				<div class="cd-alt"><b>Alt text.</b> ${esc(clip.alt_text)}</div>
				<button type="button" class="cd-copy" data-payload="${esc(copyPayload)}">Copy ${esc(label.split(' ')[0])} text</button>
			</div>
		</article>`;
}

// navigator.clipboard is unavailable outside a secure context and can be denied
// by permissions policy, so the fallback actually copies (a selected off-screen
// textarea + execCommand) instead of telling the reader to press a key that has
// nothing selected.
function copyText(text) {
	if (navigator.clipboard?.writeText) {
		return navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
	}
	return legacyCopy(text);
}

function legacyCopy(text) {
	const ta = document.createElement('textarea');
	ta.value = text;
	ta.setAttribute('readonly', '');
	ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
	document.body.appendChild(ta);
	ta.select();
	ta.setSelectionRange(0, text.length);
	const ok = document.execCommand('copy');
	ta.remove();
	return ok ? Promise.resolve() : Promise.reject(new Error('copy_unavailable'));
}

function renderClips(agent, data) {
	renderTrade(agent, data.trade, data.proof);
	const cards = SURFACES.map(({ key, label }) => {
		const clip = data.clips.find((c) => c.surface === key);
		return clip ? clipCard(key, label, clip, agent?.id) : '';
	}).join('');
	resultEl.innerHTML = `
		<div class="cd-grid">${cards}</div>
		<div class="cd-note"><b>Honest by design.</b> Wins and losses both get a card, always with a verifiable on-chain angle. The number you see is a real closed round-trip, never a screenshot.</div>`;

	for (const btn of resultEl.querySelectorAll('.cd-copy')) {
		// The label is captured once, before any click can overwrite it: reading it
		// back inside the handler would restore "Copied ✓" on a double click.
		const original = btn.textContent;
		let revert = 0;
		btn.addEventListener('click', async () => {
			clearTimeout(revert);
			try {
				await copyText(btn.dataset.payload);
				btn.textContent = 'Copied ✓';
				btn.classList.add('done');
			} catch {
				btn.textContent = 'Copy blocked by browser';
				btn.classList.remove('done');
			}
			revert = setTimeout(() => { btn.textContent = original; btn.classList.remove('done'); }, 1600);
		});
	}
}

async function loadClips(agentId) {
	if (!agentId) return;
	const seq = ++reqSeq;
	skeleton();
	try {
		const res = await fetch(`/api/clip-director?agent_id=${encodeURIComponent(agentId)}&surface=all`, { headers: { accept: 'application/json' } });
		if (seq !== reqSeq) return;
		if (!res.ok) {
			let msg = `Service returned ${res.status}.`;
			try { const j = await res.json(); if (j?.error_description) msg = j.error_description; } catch { /* keep default */ }
			return renderError(msg);
		}
		const data = await res.json();
		if (seq !== reqSeq) return;
		labelOption(agentId, data.agent?.name);
		if (!data.clips || data.clips.length === 0) return renderEmpty(data.empty);
		renderClips(data.agent, data);
	} catch {
		if (seq !== reqSeq) return;
		renderError('Network error reaching the Clip Director. Check your connection and try again.');
	}
}

// A deep-linked agent enters the picker as "Shared agent" because the ranking
// never carried its name. The clip response does, so the option stops lying as
// soon as the answer lands.
function labelOption(agentId, name) {
	if (!name) return;
	const opt = [...agentSel.options].find((o) => o.value === agentId);
	if (opt && opt.textContent === 'Shared agent') opt.textContent = name;
}

agentSel.addEventListener('change', () => loadClips(agentSel.value));
loadLeaders();
