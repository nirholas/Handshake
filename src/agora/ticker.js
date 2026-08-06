import { professionColor, professionLabelFor } from './professions.js';

// The ticker — the HUD that keeps the economy legible without entering the 3D
// scene. Two parts, both bound to /api/agora/pulse:
//   • A compact economy readout: population, tasks completed in 24h, $THREE
//     earned in 24h, and the top earners.
//   • A live narration feed of pulse.recent — claims, completions, payouts,
//     posts — newest on top, each line click-to-focus on its subject (the
//     citizen, or the deliverable on its plinth).
//
// Self-contained: it builds its own DOM into the overlay root, so it doesn't
// depend on the Task 05 page markup having reserved slots.

const THREE_DECIMALS = 6;

function fmtThreeAtomic(atomic) {
	const n = Number(atomic || 0) / 10 ** THREE_DECIMALS;
	if (!Number.isFinite(n) || n <= 0) return '0';
	return compact(n);
}

function compact(n) {
	if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + 'B';
	if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
	if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
	return String(Math.round(n));
}

const KIND_GLYPH = {
	posted_task: '📋', claimed_task: '🤝', completed_task: '✅',
	earned: '🪙', vouched: '⭐', registered: '🌱', slashed: '⚠️',
};

export class Ticker {
	constructor(ctx) {
		this.ctx = ctx;            // { root, onFocusActivity, reducedMotion }
		this.reducedMotion = !!ctx.reducedMotion;
		this._shown = new Set();   // activity ids already in the feed
		this._build();
	}

	_build() {
		const panel = document.createElement('aside');
		panel.className = 'agora-econ-ticker';
		panel.setAttribute('aria-label', 'Agora economy');

		// Economy readout.
		const readout = document.createElement('div');
		readout.className = 'agora-econ-readout';
		readout.innerHTML = `
			<div class="agora-econ-stat" data-k="pop"><span class="agora-econ-stat-v">—</span><span class="agora-econ-stat-l">citizens</span></div>
			<div class="agora-econ-stat" data-k="done"><span class="agora-econ-stat-v">—</span><span class="agora-econ-stat-l">tasks · 24h</span></div>
			<div class="agora-econ-stat" data-k="three"><span class="agora-econ-stat-v">—</span><span class="agora-econ-stat-l">$THREE · 24h</span></div>`;
		this._stat = {
			pop: readout.querySelector('[data-k="pop"] .agora-econ-stat-v'),
			done: readout.querySelector('[data-k="done"] .agora-econ-stat-v'),
			three: readout.querySelector('[data-k="three"] .agora-econ-stat-v'),
		};
		panel.appendChild(readout);

		// Top earners.
		const earners = document.createElement('div');
		earners.className = 'agora-econ-earners';
		earners.innerHTML = `<div class="agora-econ-earners-h">Top earners</div><ol class="agora-econ-earners-list"></ol>`;
		this._earnersList = earners.querySelector('.agora-econ-earners-list');
		panel.appendChild(earners);

		// Live feed.
		const feedWrap = document.createElement('div');
		feedWrap.className = 'agora-econ-feed-wrap';
		feedWrap.innerHTML = `<div class="agora-econ-feed-h">Live activity</div>`;
		const feed = document.createElement('ul');
		feed.className = 'agora-econ-feed';
		feed.setAttribute('aria-live', 'polite');
		feed.setAttribute('aria-label', 'Recent Agora activity');
		feedWrap.appendChild(feed);
		this._feed = feed;
		this._feedEmpty = document.createElement('li');
		this._feedEmpty.className = 'agora-econ-feed-empty';
		this._feedEmpty.textContent = 'Waiting for the economy to stir…';
		feed.appendChild(this._feedEmpty);
		panel.appendChild(feedWrap);

		this.ctx.root.appendChild(panel);
		this._panel = panel;
	}

	setPulse(pulse) {
		if (!pulse) return;
		const pop = pulse.population || {};
		const econ = pulse.economy || {};
		this._stat.pop.textContent = compact(pop.total || 0);
		this._stat.pop.title = `${pop.agents || 0} agents · ${pop.humans || 0} humans · ${pop.active24h || 0} active 24h`;
		this._stat.done.textContent = compact(econ.tasksCompleted24h || 0);
		this._stat.three.textContent = fmtThreeAtomic(econ.threeEarned24hAtomic);
		this._stat.three.title = `${econ.payouts24h || 0} payouts in the last 24h`;

		this._renderEarners(pulse.topEarners || []);
		this._mergeRecent(pulse.recent || []);
	}

	_renderEarners(earners) {
		this._earnersList.innerHTML = '';
		if (!earners.length) {
			const li = document.createElement('li');
			li.className = 'agora-econ-earners-empty';
			li.textContent = 'No earnings yet';
			this._earnersList.appendChild(li);
			return;
		}
		for (const e of earners) {
			const li = document.createElement('li');
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'agora-econ-earner';
			btn.style.setProperty('--accent', professionColor(e.profession));
			btn.innerHTML = `
				<span class="agora-econ-earner-name">${escapeHtml(e.displayName || 'Citizen')}</span>
				<span class="agora-econ-earner-amt">${fmtThreeAtomic(e.earnedThreeAtomic)} $THREE</span>`;
			btn.addEventListener('click', () => this.ctx.onFocusActivity?.({ actor: e.displayName, citizenId: e.id, kind: 'earner' }));
			li.appendChild(btn);
			this._earnersList.appendChild(li);
		}
	}

	// Merge the server's recent list (newest-first) into the feed, prepending
	// only genuinely new ids with an enter animation.
	_mergeRecent(recent) {
		// Oldest → newest so prepending yields newest-on-top.
		for (let i = recent.length - 1; i >= 0; i--) {
			const a = recent[i];
			if (a?.id == null || this._shown.has(a.id)) continue;
			this._shown.add(a.id);
			this._prepend(a);
		}
		// Cap memory + DOM.
		while (this._feed.children.length > 14) {
			const last = this._feed.lastElementChild;
			if (last === this._feedEmpty) break;
			last.remove();
		}
	}

	_prepend(a) {
		if (this._feedEmpty.parentNode) this._feedEmpty.remove();
		const li = document.createElement('li');
		li.className = 'agora-econ-feed-item' + (this.reducedMotion ? '' : ' enter');
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'agora-econ-feed-btn';
		btn.style.setProperty('--accent', professionColor(a.profession));
		const glyph = KIND_GLYPH[a.kind] || '•';
		btn.innerHTML = `
			<span class="agora-econ-feed-glyph" aria-hidden="true">${glyph}</span>
			<span class="agora-econ-feed-text">
				<span class="agora-econ-feed-narr">${escapeHtml(a.narrative || a.kind)}</span>
				${a.rewardLabel ? `<span class="agora-econ-feed-reward">${escapeHtml(a.rewardLabel)}</span>` : ''}
			</span>`;
		btn.addEventListener('click', () => this.ctx.onFocusActivity?.(a));
		li.appendChild(btn);
		this._feed.insertBefore(li, this._feed.firstChild);
		if (!this.reducedMotion) {
			// Trigger the enter transition on the next frame, then clear the class.
			requestAnimationFrame(() => li.classList.remove('enter'));
		}
	}

	// Live prefers-reduced-motion change: newly prepended lines stop sliding in.
	// Anything mid-transition is left to finish rather than snapped.
	setReducedMotion(on) {
		this.reducedMotion = !!on;
	}

	dispose() {
		this._panel?.remove();
		this._shown.clear();
	}
}

function escapeHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => (
		{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
	));
}
