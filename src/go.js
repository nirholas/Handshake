// Bounty board — three.ws/go

import { safeUrl } from './safe-url.js';
import { apiFetch } from './api.js';

const API = '/api/bounties';
let currentTab = 'feed';
let currentUser = null;
let feedOffset = 0;
let activeBountyId = null;
let resolveSubmissions = [];
let selectedSubmissionId = null;
let aiRecommendedId = null;

// ── Bootstrap ────────────────────────────────────────────────────────────────

async function init() {
	await loadUser();
	bindTabs();
	bindModals();
	bindCreate();
	bindSubmit();
	bindResolve();
	loadFeed(true);
	loadSidebar();
}

async function loadUser() {
	try {
		const r = await apiFetch('/api/auth/me', { allowAnonymous: true });
		if (r.ok) {
			// /api/auth/me answers { user: {...} }; reading the envelope as the
			// user left the account chip labelled "account" for everyone.
			currentUser = (await r.json())?.user || null;
		}
		if (currentUser) {
			const btn = document.getElementById('user-btn');
			btn.textContent =
				currentUser.display_name || currentUser.email?.split('@')[0] || 'account';
			btn.style.display = '';
			btn.addEventListener('click', () => {
				location.href = '/dashboard';
			});
		}
	} catch {
		// unauthenticated — fine
	}
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

function bindTabs() {
	document.querySelectorAll('.tab-btn').forEach((btn) => {
		btn.addEventListener('click', () => {
			document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
			btn.classList.add('active');
			currentTab = btn.dataset.tab;
			feedOffset = 0;
			loadFeed(true);
		});
	});
}

// ── Feed ─────────────────────────────────────────────────────────────────────

async function loadFeed(reset = false) {
	const el = document.getElementById('feed');
	if (reset) {
		feedOffset = 0;
		el.innerHTML = renderSkeletons(4);
	}

	try {
		const r = await apiFetch(`${API}?tab=${currentTab}&limit=20&offset=${feedOffset}`, {
			allowAnonymous: true,
		});
		const data = await r.json();

		if (reset) el.innerHTML = '';

		if (currentTab === 'feed') {
			renderFeedItems(el, data.feed || []);
		} else if (currentTab === 'submissions') {
			renderSubmissions(el, data.submissions || []);
		} else {
			renderBounties(el, data.bounties || []);
		}

		// Load more
		const existing = el.querySelector('.load-more-btn');
		if (existing) existing.remove();
		const count = (data.feed || data.submissions || data.bounties || []).length;
		if (count === 20) {
			const more = document.createElement('button');
			more.className = 'load-more-btn';
			more.textContent = 'Load more';
			more.addEventListener('click', () => {
				feedOffset += 20;
				more.remove();
				loadFeed(false);
			});
			el.appendChild(more);
		}

		if (!el.children.length) {
			el.innerHTML = renderEmpty();
		}
	} catch (err) {
		el.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><h3>Failed to load</h3><p>${err.message}</p></div>`;
	}
}

function renderFeedItems(el, items) {
	for (const item of items) {
		const div = document.createElement('div');
		if (item._type === 'submission') {
			div.innerHTML = renderSubmissionCard(item);
		} else {
			div.innerHTML = renderBountyCard(item);
		}
		el.appendChild(div.firstElementChild);
	}
}

function renderBounties(el, bounties) {
	for (const b of bounties) {
		const div = document.createElement('div');
		div.innerHTML = renderBountyCard(b);
		el.appendChild(div.firstElementChild);
	}
}

function renderSubmissions(el, subs) {
	for (const s of subs) {
		const div = document.createElement('div');
		div.innerHTML = renderSubmissionCard(s);
		el.appendChild(div.firstElementChild);
	}
}

// ── Card renderers ────────────────────────────────────────────────────────────

function renderBountyCard(b) {
	const statusClass =
		{ open: 'badge-open', resolving: 'badge-resolving', closed: 'badge-closed' }[b.status] ||
		'badge-open';
	const statusLabel = b.status?.toUpperCase() || 'OPEN';
	const reward = b.reward_sol ? `◎ ${parseFloat(b.reward_sol).toFixed(2)} SOL` : '';
	const rewardUsd = b.reward_usd ? `$${parseFloat(b.reward_usd).toFixed(2)}` : '';
	const timeLeft = b.expires_at ? timeLeftStr(b.expires_at) : '';
	const isOwner = currentUser && b.user_id === currentUser.id;
	const canSubmit = currentUser && b.status !== 'closed';
	const initial = (b.username || '?')[0].toUpperCase();

	return `
	<article class="card" data-id="${esc(b.id)}">
		<div class="card-header">
			<span class="badge ${esc(statusClass)}">${esc(statusLabel)}</span>
			<div class="card-meta">
				<div class="card-title">${esc(b.title)}</div>
				${b.description ? `<div class="card-desc">${esc(b.description)}</div>` : ''}
				<div class="card-footer">
					<div class="poster">
						<div class="poster-avatar">${esc(initial)}</div>
						${esc(b.username || 'anon')}
					</div>
					${rewardUsd ? `<div class="reward">${esc(rewardUsd)}</div>` : ''}
					${reward ? `<div class="reward-token">${esc(reward)}</div>` : ''}
					${timeLeft ? `<div class="time-left">${esc(timeLeft)}</div>` : ''}
					<div class="sub-count">
						<svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 9H7m10 0l-4-4m4 4l-4 4M3 4v12"/></svg>
						${b.submission_count || 0} subs.
					</div>
					${canSubmit ? `<button class="submit-btn" data-action="submit" data-id="${esc(b.id)}" data-title="${esc(b.title)}">Submit</button>` : ''}
					${isOwner && b.status !== 'closed' ? `<button class="resolve-btn" data-action="resolve" data-id="${esc(b.id)}">Resolve</button>` : ''}
				</div>
			</div>
		</div>
	</article>`;
}

function renderSubmissionCard(s) {
	const initial = (s.username || '?')[0].toUpperCase();
	const ago = timeAgo(s.created_at);
	const mediaEl =
		s.media_url && isImageUrl(s.media_url)
			? `<img class="sub-media" src="${esc(s.media_url)}" alt="submission media" loading="lazy" />`
			: s.media_url
				? `<a href="${esc(safeUrl(s.media_url))}" target="_blank" rel="noopener noreferrer" class="btn btn-ghost btn-sm" style="display:inline-flex;gap:6px;margin-bottom:8px;">🔗 View proof</a>`
				: '';

	return `
	<article class="card sub-card" data-id="${esc(s.id)}">
		<div class="card-header">
			<span class="badge badge-sub">SUBMISSION</span>
			<div class="card-meta">
				${s.bounty_title ? `<div class="sub-to">To <span>${esc(s.bounty_title)}</span></div>` : ''}
				${s.content ? `<div class="sub-content">${esc(s.content)}</div>` : ''}
				${mediaEl}
				<div class="card-footer">
					<div class="poster">
						<div class="poster-avatar">${esc(initial)}</div>
						${esc(s.username || 'anon')}
					</div>
					<div class="time-left">${esc(ago)}</div>
					${s.status === 'accepted' ? `<span class="badge badge-open" style="font-size:10px;">✓ WINNER</span>` : ''}
					${s.reward_sol ? `<div class="reward">◎ ${parseFloat(s.reward_sol).toFixed(2)} SOL</div>` : ''}
					<button class="like-btn ${s.liked_by_me ? 'liked' : ''}" data-action="like" data-id="${esc(s.id)}" data-bounty="${esc(s.bounty_id)}" aria-pressed="${s.liked_by_me ? 'true' : 'false'}" aria-label="Like submission" style="margin-left:auto;">
						${heartSvg()}
						<span class="like-count">${s.like_count || 0}</span>
					</button>
				</div>
			</div>
		</div>
	</article>`;
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

async function loadSidebar() {
	loadTopBounties();
	loadLeaderboards();
}

async function loadTopBounties() {
	const el = document.getElementById('top-bounties');
	try {
		const r = await apiFetch(`${API}?tab=open&limit=5`, { allowAnonymous: true });
		const { bounties } = await r.json();
		if (!bounties?.length) {
			el.innerHTML =
				'<div class="leaderboard-row" style="color:var(--muted-2);font-size:12px;">No open bounties yet</div>';
			return;
		}
		el.innerHTML = bounties
			.slice(0, 5)
			.map(
				(b, i) => `
			<div class="top-bounty-row">
				<div class="tb-rank">${i + 1}</div>
				<div class="tb-info">
					<div class="tb-title">${esc(b.title)}</div>
					<div class="tb-meta">${esc(b.coin_symbol)} · ${timeLeftStr(b.expires_at)} · ${b.submission_count} subs</div>
				</div>
				${b.reward_usd ? `<div class="tb-reward">$${parseFloat(b.reward_usd).toFixed(0)}</div>` : ''}
			</div>
		`,
			)
			.join('');
	} catch {
		el.innerHTML =
			'<div class="leaderboard-row" style="color:var(--muted-2);font-size:12px;">—</div>';
	}
}

async function loadLeaderboards() {
	// Top earners: users who received the most SOL from resolved bounties
	const earnersEl = document.getElementById('top-earners');
	const spendersEl = document.getElementById('top-spenders');

	try {
		const r = await apiFetch('/api/bounties/leaderboard', { allowAnonymous: true });
		if (r.ok) {
			const { earners, spenders } = await r.json();
			earnersEl.innerHTML = renderLeaderboard(earners);
			spendersEl.innerHTML = renderLeaderboard(spenders);
			return;
		}
	} catch {
		/* fall through to placeholder */
	}

	// Placeholder until leaderboard endpoint exists
	earnersEl.innerHTML =
		'<div class="leaderboard-row" style="color:var(--muted-2);font-size:12px;">Data loading…</div>';
	spendersEl.innerHTML =
		'<div class="leaderboard-row" style="color:var(--muted-2);font-size:12px;">Data loading…</div>';
}

function renderLeaderboard(rows) {
	if (!rows?.length)
		return '<div class="leaderboard-row" style="color:var(--muted-2);font-size:12px;">No data yet</div>';
	const medals = ['gold', 'silver', 'bronze'];
	return rows
		.slice(0, 3)
		.map(
			(r, i) =>
				`
		<div class="leaderboard-row">
			<div class="rank ${medals[i] || ''}">🥇🥈🥉`
					.split('')
					.filter((_, ii) => ii < 2)[i] +
				`</div>
			<div class="lb-info">
				<div class="lb-name">${esc(r.username || shortAddr(r.user_id))}</div>
				<div class="lb-sub">${r.payout_count} payout${r.payout_count !== 1 ? 's' : ''}</div>
			</div>
			<div class="lb-amount">$${parseFloat(r.total_usd || 0).toFixed(2)}</div>
		</div>
	`,
		)
		.join('');
}

// ── Modals ────────────────────────────────────────────────────────────────────

function bindModals() {
	document.querySelectorAll('[data-close]').forEach((btn) => {
		btn.addEventListener('click', () => closeModal(btn.dataset.close));
	});
	document.querySelectorAll('.modal-overlay').forEach((overlay) => {
		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) closeModal(overlay.id);
		});
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape')
			document.querySelectorAll('.modal-overlay.open').forEach((m) => closeModal(m.id));
	});

	// Delegate submit/resolve buttons in feed
	document.getElementById('feed').addEventListener('click', (e) => {
		const btn = e.target.closest('[data-action]');
		if (!btn) return;
		if (!currentUser) {
			location.href = '/login';
			return;
		}
		if (btn.dataset.action === 'like') {
			toggleLike(btn);
			return;
		}
		if (btn.dataset.action === 'submit') {
			openSubmitModal(btn.dataset.id, btn.dataset.title);
		}
		if (btn.dataset.action === 'resolve') {
			openResolveModal(btn.dataset.id);
		}
	});
}

function openModal(id) {
	document.getElementById(id).classList.add('open');
}
function closeModal(id) {
	document.getElementById(id).classList.remove('open');
}

// ── Create bounty ─────────────────────────────────────────────────────────────

function bindCreate() {
	document.getElementById('create-btn').addEventListener('click', () => {
		if (!currentUser) {
			location.href = '/login';
			return;
		}
		openModal('create-modal');
	});

	document.getElementById('create-submit').addEventListener('click', async () => {
		const title = document.getElementById('c-title').value.trim();
		const desc = document.getElementById('c-desc').value.trim();
		const sol = parseFloat(document.getElementById('c-sol').value) || 0;
		const days = parseInt(document.getElementById('c-days').value, 10);
		const errEl = document.getElementById('create-error');

		if (!title) {
			showErr(errEl, 'Title is required');
			return;
		}
		if (!sol) {
			showErr(errEl, 'Set a SOL reward');
			return;
		}
		errEl.style.display = 'none';

		const btn = document.getElementById('create-submit');
		btn.textContent = 'Posting…';
		btn.disabled = true;

		try {
			const r = await apiFetch(API, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					title,
					description: desc || undefined,
					reward_sol: sol,
					expires_in_days: days,
				}),
			});
			const data = await r.json();
			if (!r.ok) throw new Error(data.error_description || data.error || 'failed');
			closeModal('create-modal');
			resetCreateForm();
			toast('Bounty posted!', 'success');
			loadFeed(true);
			loadTopBounties();
		} catch (err) {
			showErr(errEl, err.message);
		} finally {
			btn.textContent = 'Post Bounty';
			btn.disabled = false;
		}
	});
}

function resetCreateForm() {
	['c-title', 'c-desc', 'c-sol'].forEach((id) => {
		document.getElementById(id).value = '';
	});
	document.getElementById('c-days').value = '7';
	document.getElementById('create-error').style.display = 'none';
}

// ── Submit proof ──────────────────────────────────────────────────────────────

function openSubmitModal(bountyId, bountyTitle) {
	activeBountyId = bountyId;
	document.getElementById('submit-bounty-title').textContent = `For: ${bountyTitle}`;
	document.getElementById('s-content').value = '';
	document.getElementById('s-url').value = '';
	document.getElementById('submit-error').style.display = 'none';
	openModal('submit-modal');
}

function bindSubmit() {
	document.getElementById('submit-proof-btn').addEventListener('click', async () => {
		const content = document.getElementById('s-content').value.trim();
		const url = document.getElementById('s-url').value.trim();
		const errEl = document.getElementById('submit-error');

		if (!content && !url) {
			showErr(errEl, 'Add a description or media URL');
			return;
		}
		errEl.style.display = 'none';

		const mediaType = url ? guessMediaType(url) : null;
		const btn = document.getElementById('submit-proof-btn');
		btn.textContent = 'Submitting…';
		btn.disabled = true;

		try {
			const r = await apiFetch(`${API}/${activeBountyId}/submissions`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					content: content || undefined,
					media_url: url || undefined,
					media_type: mediaType,
				}),
			});
			const data = await r.json();
			if (!r.ok) throw new Error(data.error_description || data.error || 'failed');
			closeModal('submit-modal');
			toast('Submission posted!', 'success');
			loadFeed(true);
		} catch (err) {
			showErr(errEl, err.message);
		} finally {
			btn.textContent = 'Submit';
			btn.disabled = false;
		}
	});
}

// ── Resolve ───────────────────────────────────────────────────────────────────

async function openResolveModal(bountyId) {
	activeBountyId = bountyId;
	selectedSubmissionId = null;
	resolveSubmissions = [];
	aiRecommendedId = null;
	document.getElementById('resolve-error').style.display = 'none';
	document.getElementById('r-tx').value = '';
	const summary = document.getElementById('ai-summary');
	summary.style.display = 'none';
	summary.innerHTML = '';
	const judgeBtn = document.getElementById('ai-judge-btn');
	judgeBtn.disabled = false;
	judgeBtn.textContent = '✨ Rank with AI';
	document.getElementById('resolve-subs').innerHTML =
		'<div style="color:var(--muted);font-size:13px;">Loading submissions…</div>';
	openModal('resolve-modal');

	try {
		const r = await apiFetch(`${API}/${bountyId}/submissions?limit=50`, {
			allowAnonymous: true,
		});
		const data = await r.json();
		resolveSubmissions = data.submissions || [];
		renderResolveSubs();
	} catch {
		document.getElementById('resolve-subs').innerHTML =
			'<div style="color:#f87171;font-size:13px;">Failed to load submissions</div>';
	}
}

function renderResolveSubs() {
	const el = document.getElementById('resolve-subs');
	if (!resolveSubmissions.length) {
		el.innerHTML = '<div style="color:var(--muted);font-size:13px;">No submissions yet</div>';
		return;
	}
	el.innerHTML = resolveSubmissions
		.map((s) => {
			const ai = s._ai;
			const isRec = aiRecommendedId && s.id === aiRecommendedId;
			const likes = s.like_count ? `<span class="sp-likes">♥ ${s.like_count}</span>` : '';
			const score = ai
				? `<span class="ai-score" style="--s:${ai.score}">${ai.score}</span>`
				: '';
			const verdict = ai?.verdict ? `<div class="ai-verdict">${esc(ai.verdict)}</div>` : '';
			const recBadge = isRec ? `<div class="sub-pick-rec">★ AI pick</div>` : '';
			return `
		<div class="sub-pick ${s.id === selectedSubmissionId ? 'selected' : ''} ${isRec ? 'recommended' : ''}" data-sid="${esc(s.id)}">
			<div class="sub-pick-head">
				<div class="sub-pick-user">${esc(s.username || 'anon')} · ${timeAgo(s.created_at)}${likes}</div>
				${score}
			</div>
			<div class="sub-pick-content">${esc(s.content || s.media_url || '(media only)')}</div>
			${verdict}
			${recBadge}
		</div>`;
		})
		.join('');

	el.querySelectorAll('.sub-pick').forEach((div) => {
		div.addEventListener('click', () => {
			selectedSubmissionId = div.dataset.sid;
			el.querySelectorAll('.sub-pick').forEach((d) => d.classList.remove('selected'));
			div.classList.add('selected');
		});
	});
}

function bindResolve() {
	document.getElementById('ai-judge-btn').addEventListener('click', runJudge);

	document.getElementById('resolve-submit').addEventListener('click', async () => {
		const errEl = document.getElementById('resolve-error');
		if (!selectedSubmissionId) {
			showErr(errEl, 'Select a winning submission');
			return;
		}
		const tx = document.getElementById('r-tx').value.trim();
		errEl.style.display = 'none';

		const btn = document.getElementById('resolve-submit');
		btn.textContent = 'Confirming…';
		btn.disabled = true;

		try {
			const r = await apiFetch(`${API}/${activeBountyId}/resolve`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					submission_id: selectedSubmissionId,
					tx_hash: tx || undefined,
				}),
			});
			const data = await r.json();
			if (!r.ok) throw new Error(data.error_description || data.error || 'failed');
			closeModal('resolve-modal');
			toast('Winner confirmed!', 'success');
			loadFeed(true);
		} catch (err) {
			showErr(errEl, err.message);
		} finally {
			btn.textContent = 'Confirm Winner';
			btn.disabled = false;
		}
	});
}

// ── Likes ─────────────────────────────────────────────────────────────────────

function heartSvg() {
	return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7.5-4.6-10-9.3C.2 8 2 4.5 5.2 4.5 7 4.5 8.5 5.6 12 8c3.5-2.4 5-3.5 6.8-3.5C22 4.5 23.8 8 22 11.7 19.5 16.4 12 21 12 21z"/></svg>`;
}

async function toggleLike(btn) {
	if (!currentUser) {
		location.href = '/login';
		return;
	}
	const sid = btn.dataset.id;
	const bid = btn.dataset.bounty;
	if (!sid || !bid) return;

	const countEl = btn.querySelector('.like-count');
	const wasLiked = btn.classList.contains('liked');
	const prevCount = parseInt(countEl.textContent, 10) || 0;

	// Optimistic toggle — revert on failure.
	btn.classList.toggle('liked', !wasLiked);
	btn.setAttribute('aria-pressed', String(!wasLiked));
	countEl.textContent = String(Math.max(0, prevCount + (wasLiked ? -1 : 1)));
	btn.disabled = true;

	try {
		const r = await apiFetch(`${API}/${bid}/likes`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ submission_id: sid }),
		});
		const data = await r.json();
		if (!r.ok) throw new Error(data.error_description || data.error || 'failed');
		btn.classList.toggle('liked', !!data.liked);
		btn.setAttribute('aria-pressed', String(!!data.liked));
		countEl.textContent = String(data.like_count);
	} catch (err) {
		btn.classList.toggle('liked', wasLiked);
		btn.setAttribute('aria-pressed', String(wasLiked));
		countEl.textContent = String(prevCount);
		toast(err.message || 'Could not like', 'fail');
	} finally {
		btn.disabled = false;
	}
}

// ── AI judge ──────────────────────────────────────────────────────────────────

async function runJudge() {
	if (!resolveSubmissions.length) {
		toast('No submissions to rank yet');
		return;
	}
	const btn = document.getElementById('ai-judge-btn');
	const banner = document.getElementById('ai-summary');
	const prevLabel = btn.textContent;
	btn.disabled = true;
	btn.textContent = '✨ Judging…';

	try {
		const r = await apiFetch(`${API}/${activeBountyId}/judge`, { method: 'POST' });
		const data = await r.json();
		if (!r.ok) throw new Error(data.error_description || data.error || 'failed');

		const byId = new Map((data.rankings || []).map((x) => [x.submission_id, x]));
		resolveSubmissions = resolveSubmissions
			.map((s) => ({ ...s, _ai: byId.get(s.id) || null }))
			.sort((a, b) => (b._ai?.score ?? -1) - (a._ai?.score ?? -1));

		aiRecommendedId = data.recommended_id || null;
		if (aiRecommendedId) selectedSubmissionId = aiRecommendedId;
		renderResolveSubs();

		banner.style.display = '';
		banner.innerHTML = `<span class="ai-badge">AI</span>${esc(data.summary || 'Ranked by how well each submission fits the task.')} <span class="ai-meta">· ${data.judged_count || resolveSubmissions.length} judged${data.cached ? ' · cached' : ''}</span>`;
		btn.textContent = '✨ Re-rank';
		toast('AI ranked the submissions', 'success');
	} catch (err) {
		const msg = /unavailable/i.test(err.message)
			? 'AI judge is unavailable right now'
			: err.message || 'Judge failed';
		toast(msg, 'fail');
		btn.textContent = prevLabel;
	} finally {
		btn.disabled = false;
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderSkeletons(n) {
	return Array.from(
		{ length: n },
		() => `
		<div class="skel-card">
			<div class="skeleton skel-block" style="width:60px;height:18px;margin-bottom:12px;"></div>
			<div class="skeleton skel-block" style="width:80%;height:16px;"></div>
			<div class="skeleton skel-block" style="width:55%;height:13px;"></div>
			<div class="skeleton skel-block" style="width:40%;height:12px;"></div>
		</div>
	`,
	).join('');
}

function renderEmpty() {
	const label =
		{ feed: 'No bounties yet', open: 'No open bounties', submissions: 'No submissions yet' }[
			currentTab
		] || 'Nothing here yet';
	return `<div class="empty"><div class="empty-icon">🎯</div><h3>${label}</h3><p>Be the first to post a bounty and get community members competing.</p></div>`;
}

function esc(str) {
	if (str == null) return '';
	return String(str)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function timeLeftStr(iso) {
	if (!iso) return '';
	const ms = new Date(iso) - Date.now();
	if (ms <= 0) return 'expired';
	const d = Math.floor(ms / 86400000);
	const h = Math.floor((ms % 86400000) / 3600000);
	if (d > 0) return `${d}d ${h}h left`;
	const m = Math.floor((ms % 3600000) / 60000);
	return `${h}h ${m}m left`;
}

function timeAgo(iso) {
	if (!iso) return '';
	const s = Math.floor((Date.now() - new Date(iso)) / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

function isImageUrl(url) {
	return /\.(jpg|jpeg|png|gif|webp|avif|svg)(\?.*)?$/i.test(url);
}

function guessMediaType(url) {
	if (isImageUrl(url)) return 'image';
	if (/\.(mp4|webm|mov|avi)(\?.*)?$/i.test(url)) return 'video';
	return 'link';
}

function shortAddr(id) {
	if (!id) return 'anon';
	return id.slice(0, 6) + '…' + id.slice(-4);
}

function showErr(el, msg) {
	el.textContent = msg;
	el.style.display = 'block';
}

let toastTimer;
function toast(msg, type = '') {
	const el = document.getElementById('toast');
	el.textContent = msg;
	el.className = `toast${type ? ' ' + type : ''} show`;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		el.classList.remove('show');
	}, 3000);
}

// ── Boot ─────────────────────────────────────────────────────────────────────

init();
