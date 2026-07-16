// Clip Director page, turn a real closed trade into shareable cards per surface.
// Populates a trader picker from the live mirror leaderboard, then fetches
// /api/clip-director for the selected agent's most notable close and renders one
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
const CTA_LABEL = { 'fork-this-trade': 'Fork this trade', 'copy-the-agent': 'Copy the agent', 'view-track-record': 'View track record' };

function esc(s) {
	return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadLeaders() {
	try {
		const res = await fetch('/api/mirror/leaderboard?sort=score&limit=40', { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(String(res.status));
		const data = await res.json();
		const leaders = (data?.data?.leaders || []).filter((l) => l.settled > 0);
		if (!leaders.length) {
			agentSel.innerHTML = '<option value="">No agents with closed trades yet</option>';
			renderEmpty('No agent has a closed on-chain trade yet. Clips are minted from real closed round-trips, so the board fills as agents trade.');
			return;
		}
		agentSel.innerHTML = leaders.map((l) =>
			`<option value="${esc(l.agent_id)}">${esc(l.name || 'Unnamed')}: ${l.settled} trade${l.settled === 1 ? '' : 's'}${l.win_rate != null ? `, ${l.win_rate}% win` : ''}</option>`).join('');
		// Deep-link support: ?agent_id=<uuid> preselects.
		const wanted = new URLSearchParams(location.search).get('agent_id');
		if (wanted && leaders.some((l) => l.agent_id === wanted)) agentSel.value = wanted;
		loadClips(agentSel.value);
	} catch {
		agentSel.innerHTML = '<option value="">Could not load leaders</option>';
		renderError('The trader leaderboard is unreachable right now.');
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

function renderError(msg) {
	tradeEl.innerHTML = '';
	resultEl.innerHTML = `
		<div class="cd-error">
			<h3>Could not direct a clip</h3>
			<p>${esc(msg || 'The clip service is unreachable right now.')}</p>
			<button type="button" id="cdRetry">Try again</button>
		</div>`;
	document.getElementById('cdRetry')?.addEventListener('click', () => loadClips(agentSel.value));
}

function renderTrade(agent, trade, proof) {
	const win = trade.is_win !== false;
	const cls = win ? 'win' : 'loss';
	const headline = trade.multiple != null ? `${trade.multiple}x`
		: trade.realized_pnl_sol != null ? `${trade.realized_pnl_sol > 0 ? '+' : ''}${trade.realized_pnl_sol} SOL`
		: trade.pnl_pct != null ? `${trade.pnl_pct}%` : 'closed';
	const sym = trade.symbol || trade.name || (trade.mint ? trade.mint.slice(0, 6) : 'coin');
	tradeEl.innerHTML = `
		<div class="cd-trade">
			<span class="sym">${esc(sym.startsWith('$') ? sym : `$${sym}`)}</span>
			<span class="stat">Result <b class="${cls}">${esc(headline)}</b></span>
			${trade.hold_min != null ? `<span class="stat">Held <b>${trade.hold_min < 60 ? `${trade.hold_min}m` : `${Math.round(trade.hold_min / 60)}h`}</b></span>` : ''}
			${trade.exit_reason ? `<span class="stat">Exit <b>${esc(trade.exit_reason.replace(/_/g, ' '))}</b></span>` : ''}
			${proof ? `<a class="proof" href="${esc(proof)}" target="_blank" rel="noopener noreferrer">On-chain proof ↗</a>` : ''}
		</div>`;
}

function clipCard(surface, label, clip) {
	const gesture = GESTURE_EMOJI[clip.avatar_gesture] || '🎯';
	const copyPayload = `${clip.hook}\n\n${clip.body}\n\n(${CTA_LABEL[clip.cta] || clip.cta} · verifiable on-chain · three.ws)`;
	return `
		<article class="cd-card ${surface}">
			<div class="cd-card-head"><span class="dot"></span>${esc(label)}</div>
			<div class="cd-card-body">
				<div class="cd-hook">${esc(clip.hook)}</div>
				<div class="cd-featstat"><span class="gesture" title="${esc(clip.avatar_gesture)} reaction" aria-hidden="true">${gesture}</span><span class="num">${esc(clip.feature_stat)}</span></div>
				<div class="cd-text">${esc(clip.body)}</div>
				<div class="cd-cta">${esc(CTA_LABEL[clip.cta] || clip.cta)}</div>
				<div class="cd-alt"><b>Alt text.</b> ${esc(clip.alt_text)}</div>
				<button type="button" class="cd-copy" data-payload="${esc(copyPayload)}">Copy ${esc(label.split(' ')[0])} text</button>
			</div>
		</article>`;
}

function renderClips(agent, data) {
	renderTrade(agent, data.trade, data.proof);
	const cards = SURFACES.map(({ key, label }) => {
		const clip = data.clips.find((c) => c.surface === key);
		return clip ? clipCard(key, label, clip) : '';
	}).join('');
	resultEl.innerHTML = `
		<div class="cd-grid">${cards}</div>
		<div class="cd-note"><b>Honest by design.</b> Wins and losses both get a card, always with a verifiable on-chain angle. The number you see is a real closed round-trip, never a screenshot.</div>`;

	for (const btn of resultEl.querySelectorAll('.cd-copy')) {
		btn.addEventListener('click', async () => {
			try {
				await navigator.clipboard.writeText(btn.dataset.payload);
				const original = btn.textContent;
				btn.textContent = 'Copied ✓';
				btn.classList.add('done');
				setTimeout(() => { btn.textContent = original; btn.classList.remove('done'); }, 1600);
			} catch {
				btn.textContent = 'Press Ctrl+C';
			}
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
		if (!data.clips || data.clips.length === 0) return renderEmpty(data.empty);
		renderClips(data.agent, data);
	} catch {
		if (seq !== reqSeq) return;
		renderError('Network error reaching the Clip Director. Check your connection and try again.');
	}
}

agentSel.addEventListener('change', () => loadClips(agentSel.value));
loadLeaders();
