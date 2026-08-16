// Agora passport panel — the living passport (Task 07). Clicking (or keyboard-
// activating) a citizen opens this side panel, which fetches /api/agora/passport
// and shows the full record: identity + a derived A–D trust grade, slashable
// stake, status, $THREE earned, tasks done/posted, the live on-chain registry
// block (the chain's truth, reconciled against the projection), the cross-chain
// identity handshake when a citizen proves both an EVM and a Solana identity, and
// a complete activity timeline where every row links its tx + deliverable and a
// completed task can be verified in-browser.
//
// On-chain is the source of truth: where the live `onchain` read disagrees with
// the projection snapshot, the chain wins and the panel says so. Non-modal: the
// world stays interactive behind it. Esc closes; focus moves into the panel on
// open and returns to the trigger on close.

import { professionColor, primaryProfessionKey, citizenProfessionLabel } from './citizen-avatar.js';
import { fetchPassport } from './api.js';
import { renderHandshake, parseIdentityProofs, hasDualIdentity } from './handshake.js';
import { injectTrustSurfaceCss } from './trust-surface.css.js';
import { log } from '../shared/log.js';

const THREE_DECIMALS = 6;
const LAMPORTS_PER_SOL = 1e9;

const fmtThree = (atomic) => {
	const n = Number(atomic || 0) / 10 ** THREE_DECIMALS;
	if (!Number.isFinite(n) || n === 0) return '0';
	if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
	if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
	return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
};
const fmtSol = (lamports) => {
	const n = Number(lamports || 0) / LAMPORTS_PER_SOL;
	if (!Number.isFinite(n) || n === 0) return '0';
	return n.toLocaleString('en-US', { maximumFractionDigits: 3 });
};
const fmtTimeAgo = (iso) => {
	if (!iso) return '';
	const then = new Date(iso).getTime();
	if (!Number.isFinite(then)) return '';
	const s = Math.max(0, (Date.now() - then) / 1000);
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
	{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const shortAddr = (a) => { const s = String(a ?? ''); return s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s; };

function explorerTx(sig, cluster) { return sig ? `https://explorer.solana.com/tx/${sig}${cluster === 'mainnet' ? '' : '?cluster=devnet'}` : null; }
function explorerAddr(a, cluster) { return a ? `https://explorer.solana.com/address/${a}${cluster === 'mainnet' ? '' : '?cluster=devnet'}` : null; }

// Derive an A–D trust grade from an AgenC reputation score — a career-ladder
// readout (reputation ticks up as a citizen completes accepted work), not vanity.
export function reputationGrade(rep) {
	const n = Number(rep) || 0;
	if (n >= 100) return { grade: 'A+', tier: 'a', label: 'Trusted' };
	if (n >= 50) return { grade: 'A', tier: 'a', label: 'Established' };
	if (n >= 25) return { grade: 'B', tier: 'b', label: 'Proven' };
	if (n >= 10) return { grade: 'C', tier: 'c', label: 'Rising' };
	if (n >= 1) return { grade: 'D', tier: 'd', label: 'Newcomer' };
	return { grade: '—', tier: 'new', label: 'Unproven' };
}

const ACTIVITY_LABEL = {
	posted_task: 'Posted a task',
	claimed_task: 'Claimed a task',
	completed_task: 'Completed a task',
	earned: 'Earned',
	slashed: 'Stake slashed',
	vouched: 'Vouched',
	registered: 'Registered on-chain',
};

export class PassportPanel {
	constructor() {
		injectTrustSurfaceCss();
		this._el = this._build();
		document.body.appendChild(this._el);
		this._bodyEl = this._el.querySelector('#agora-passport-body');
		this._titleEl = this._el.querySelector('#agora-passport-title');
		this._trigger = null;       // element to restore focus to on close
		this._reqId = 0;            // guards against out-of-order responses
		this._currentId = null;
		this._onClose = null;
		this._cluster = 'devnet';

		this._el.querySelector('.agora-passport-close').addEventListener('click', () => this.close());
		// Escape stays global (the passport is non-modal — the world is live behind
		// it, so Esc should close it from anywhere); Tab is trapped within the panel
		// only while focus is inside it.
		this._onKey = (e) => { if (e.key === 'Escape' && this.isOpen()) { e.stopPropagation(); this.close(); } };
		document.addEventListener('keydown', this._onKey);
		this._el.addEventListener('keydown', (e) => { if (e.key === 'Tab' && this.isOpen()) this._trapTab(e); });

		// Decoupled open: job-detail actor links + ?citizen= deep-links broadcast
		// this rather than reaching into the world's panel instance.
		this._onOpenEvent = (e) => {
			const d = e.detail || {};
			if (d.agentPda) this.openRef({ agentPda: d.agentPda });
			else if (d.agentId) this.openRef({ agentId: d.agentId });
			else if (d.id) this.open(d.id, { hint: d.hint || null });
		};
		window.addEventListener('agora:open-passport', this._onOpenEvent);

		this._maybeDeepLink();
	}

	_build() {
		const aside = document.createElement('aside');
		aside.id = 'agora-passport';
		aside.className = 'agora-passport';
		aside.setAttribute('role', 'dialog');
		aside.setAttribute('aria-label', 'Citizen passport');
		aside.setAttribute('aria-modal', 'false');
		aside.tabIndex = -1;
		aside.hidden = true;
		aside.innerHTML = `
			<header class="agora-passport-head">
				<h2 id="agora-passport-title">Passport</h2>
				<button class="agora-passport-close" type="button" aria-label="Close passport">
					<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
				</button>
			</header>
			<div id="agora-passport-body" class="agora-passport-body" tabindex="-1"></div>`;
		return aside;
	}

	isOpen() { return !this._el.hidden; }
	get currentId() { return this._currentId; }

	/**
	 * Open the panel for a citizen id and fetch its passport.
	 * @param {string} id citizen id
	 * @param {{ trigger?: HTMLElement, onClose?: Function, hint?: object }} [opts]
	 */
	open(id, opts = {}) {
		return this.openRef({ id }, opts);
	}

	// Open by any passport reference the API accepts (id | agentPda | agentId).
	async openRef(ref, { trigger = null, onClose = null, hint = null } = {}) {
		this._trigger = trigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
		this._onClose = onClose;
		this._currentId = ref.id || null;
		const reqId = ++this._reqId;

		this._el.hidden = false;
		this._el.classList.add('open');
		this._titleEl.textContent = hint?.displayName || 'Passport';
		this._renderLoading(hint);
		this._bodyEl.focus({ preventScroll: true });
		if (ref.id) this._setDeepLink(ref.id);

		try {
			const data = await fetchPassport(ref);
			if (reqId !== this._reqId) return; // superseded by a newer open()
			this._render(data);
		} catch (err) {
			if (reqId !== this._reqId) return;
			log.warn('[agora] passport fetch failed', err?.message);
			const notFound = /404|not.?found/i.test(err?.message || '');
			this._renderError(ref, notFound ? 'This citizen is no longer in the registry.' : (err?.message || 'The registry could not be reached.'));
		}
	}

	close() {
		if (this._el.hidden) return;
		this._el.classList.remove('open');
		this._el.hidden = true;
		this._currentId = null;
		this._clearDeepLink();
		const t = this._trigger;
		const cb = this._onClose;
		this._trigger = null;
		this._onClose = null;
		try { cb?.(); } catch (e) { log.warn('[agora] passport onClose threw', e); }
		if (t && typeof t.focus === 'function') t.focus({ preventScroll: true });
	}

	dispose() {
		document.removeEventListener('keydown', this._onKey);
		window.removeEventListener('agora:open-passport', this._onOpenEvent);
		this._el.remove();
	}

	// ── Renderers ──────────────────────────────────────────────────────────────

	_renderLoading(hint) {
		const accent = hint ? professionColor(primaryProfessionKey(hint)) : '#9fb4cc';
		this._bodyEl.innerHTML = `
			<div class="agora-pp-hero">
				<span class="agora-pp-dot" style="background:${accent}"></span>
				<div>
					<div class="agora-pp-name">${esc(hint?.displayName || 'Loading…')}</div>
					<div class="agora-pp-prof">${esc(citizenProfessionLabel(hint))}</div>
				</div>
			</div>
			<div class="agora-pp-skel" aria-hidden="true">
				${'<div class="agora-pp-skel-row"></div>'.repeat(4)}
			</div>
			<div class="agora-pp-skel" aria-hidden="true" style="margin-top:18px">
				${'<div class="agora-pp-skel-line"></div>'.repeat(3)}
			</div>
			<span class="agora-pp-srhint" role="status">Loading passport…</span>`;
	}

	_renderError(ref, detail) {
		this._bodyEl.innerHTML = `
			<div class="agora-pp-state">
				<div class="agora-pp-state-icon" aria-hidden="true">!</div>
				<p class="agora-pp-state-title">Couldn't load this passport</p>
				<p class="agora-pp-state-detail">${esc(detail)}</p>
				<button class="agora-pp-retry" type="button">Try again</button>
			</div>`;
		this._bodyEl.querySelector('.agora-pp-retry').addEventListener('click', () => this.openRef(ref, { trigger: this._trigger }));
	}

	_render(data) {
		const c = data.citizen || {};
		const onchain = data.onchain || null;
		const accent = professionColor(primaryProfessionKey(c));
		this._cluster = c.agenc?.cluster === 'mainnet' ? 'mainnet' : 'devnet';
		this._titleEl.textContent = c.displayName || 'Passport';

		// On-chain wins for rep/stake/status when present (it's the truth).
		const status = onchain?.status || c.status || 'Idle';
		const reputation = onchain?.reputation ?? c.reputation ?? 0;
		const stake = onchain?.stakeAmount ?? c.stakeLamports;
		const grade = reputationGrade(reputation);
		// Every capability the citizen may claim, but led by the craft it is known
		// for. The API returns the decoded bitmap in bit order, which always opens
		// with Fetcher (the baseline bit every citizen carries), so an Appraiser's
		// passport used to introduce her as a Fetcher under an Appraiser-coloured
		// dot. Hoist the primary; the rest keep their bit order.
		const primaryKey = primaryProfessionKey(c);
		const decoded = (c.professions && c.professions.length) ? c.professions.slice() : [];
		const professions = decoded.length
			? [
				...decoded.filter((p) => p.key === primaryKey),
				...decoded.filter((p) => p.key !== primaryKey),
			].map((p) => p.label)
			: [citizenProfessionLabel(c)];

		const stats = [
			{ label: 'Reputation', value: Number(reputation).toLocaleString('en-US'), sub: grade.label },
			{ label: 'Stake', value: `${fmtSol(stake)}`, sub: 'SOL slashable' },
			{ label: 'Earned', value: `${fmtThree(c.earnedThreeAtomic)}`, sub: '$THREE' },
			{ label: 'Done', value: Number(c.tasksCompleted || 0).toLocaleString('en-US'), sub: 'tasks' },
			{ label: 'Posted', value: Number(c.tasksPosted || 0).toLocaleString('en-US'), sub: 'bounties' },
		];

		const proofs = parseIdentityProofs(onchain?.metadataUri);
		const showHandshake = hasDualIdentity(proofs);

		this._bodyEl.innerHTML = `
			<div class="agora-pp-hero">
				<span class="agora-pp-dot" style="background:${accent}"></span>
				<div class="agora-pp-hero-text">
					<div class="agora-pp-name">${esc(c.displayName || 'Citizen')}</div>
					<div class="agora-pp-prof">${esc(professions.join(' · '))}</div>
				</div>
				<span class="agora-pp-grade agora-grade tier-${grade.tier}" title="Reputation ${esc(String(reputation))} — ${esc(grade.label)}">
					<span class="agora-grade-letter">${esc(grade.grade)}</span>
					<span class="agora-grade-label">${esc(grade.label)}</span>
				</span>
			</div>

			<div class="agora-pp-statusline">
				<span class="agora-status ${statusClass(status)}"><span class="agora-status-dot"></span>${esc(status)}</span>
				${c.kind ? `<span class="agora-pp-chip">${esc(c.kind === 'human' ? 'Human' : 'Agent')}</span>` : ''}
				${c.agenc?.cluster ? `<span class="agora-pp-chip">AgenC · ${esc(c.agenc.cluster)}</span>` : ''}
			</div>

			<div class="agora-pp-stats">
				${stats.map((s) => `
					<div class="agora-pp-stat">
						<div class="agora-pp-stat-value">${esc(s.value)}</div>
						<div class="agora-pp-stat-label">${esc(s.label)}</div>
						<div class="agora-pp-stat-sub">${esc(s.sub)}</div>
					</div>`).join('')}
			</div>

			${onchain ? this._renderOnchain(onchain) : this._renderProjectionNote(c)}

			${showHandshake ? `
				<h3 class="agora-pp-section">Cross-chain identity</h3>
				<div class="agora-handshake-mount"></div>` : ''}

			<h3 class="agora-pp-section">Activity</h3>
			${this._renderActivity(data.activity || [])}`;

		// Mount the cross-chain handshake (DOM-built; can't live in the innerHTML).
		if (showHandshake) {
			const mount = this._bodyEl.querySelector('.agora-handshake-mount');
			if (mount) renderHandshake(mount, { proofs, cluster: this._cluster, expectedAgentPda: c.agenc?.agentPda }).catch((e) => log.warn('[agora] handshake render failed', e?.message));
		}

		// Wire activity row interactions (links carry data-*; closures attach here).
		this._wireActivity();
	}

	_renderOnchain(o) {
		const cluster = this._cluster;
		const rows = [
			['Status', esc(o.status || '—')],
			['Reputation', esc(String(o.reputation ?? 0))],
			['Stake', `${esc(fmtSol(o.stakeAmount))} SOL`],
			['Active tasks', esc(String(o.activeTasks ?? 0))],
		];
		if (o.authority) rows.push(['Authority', `<a class="agora-addr" href="${explorerAddr(o.authority, cluster)}" target="_blank" rel="noopener noreferrer">${esc(shortAddr(o.authority))} ↗</a>`]);
		if (o.endpoint) rows.push(['Endpoint', `<span class="agora-mono-sm">${esc(o.endpoint)}</span>`]);
		return `
			<h3 class="agora-pp-section agora-pp-section-live">On-chain registry <span class="agora-live-dot" title="Live read from the AgenC program"></span></h3>
			<div class="agora-pp-onchain">
				${rows.map(([k, v]) => `<div class="agora-kv"><span class="agora-kv-key">${esc(k)}</span><span class="agora-kv-val">${v}</span></div>`).join('')}
			</div>`;
	}

	_renderProjectionNote(c) {
		const msg = c.agenc?.registered
			? 'Couldn\'t reach the AgenC program for a live read — showing the latest projected snapshot.'
			: 'Not yet registered on the AgenC chain — projection record only.';
		return `<p class="agora-pp-empty">${esc(msg)}</p>`;
	}

	_renderActivity(activity) {
		if (!activity.length) {
			return `<p class="agora-pp-empty">No on-chain activity yet. This citizen is just getting started in the Commons.</p>`;
		}
		const cluster = this._cluster;
		return `<ul class="agora-pp-feed">${activity.slice(0, 25).map((a) => {
			const title = a.narrative || ACTIVITY_LABEL[a.kind] || a.kind;
			const rep = (a.repBefore != null && a.repAfter != null && a.repBefore !== a.repAfter)
				? `<span class="agora-pp-rep">rep ${esc(String(a.repBefore))} → ${esc(String(a.repAfter))}</span>` : '';
			const reward = a.rewardLabel ? `<span class="agora-pp-reward">${esc(String(a.rewardLabel))}</span>` : '';
			const verifiable = /complete/i.test(a.kind || '') && a.deliverableUrl && a.proofHash;
			const links = [];
			if (a.txSignature) links.push(`<a class="agora-tx-link" href="${explorerTx(a.txSignature, cluster)}" target="_blank" rel="noopener noreferrer">tx ↗</a>`);
			if (a.deliverableUrl) links.push(`<a class="agora-tx-link" href="${esc(a.deliverableUrl)}" target="_blank" rel="noopener noreferrer">deliverable ↗</a>`);
			if (verifiable) links.push(`<button class="agora-verify-chip" type="button" data-verify="1" data-task="${esc(a.taskPda || '')}" data-task-id="${esc(a.taskId || '')}" data-proof="${esc(a.proofHash)}" data-url="${esc(a.deliverableUrl)}" data-title="${esc(title)}" data-prof="${esc(a.profession || '')}" data-reward="${esc(a.rewardLabel || '')}" data-amount="${esc(a.amountAtomic || '')}" data-tx="${esc(a.txSignature || '')}">✓ verify</button>`);
			return `<li class="agora-pp-feed-item">
				<span class="agora-pp-feed-kind" data-kind="${esc(a.kind)}"></span>
				<div class="agora-pp-feed-main">
					<div class="agora-pp-feed-title">${esc(title)}</div>
					<div class="agora-pp-feed-meta"><span class="agora-pp-feed-time">${esc(fmtTimeAgo(a.at))}</span>${reward}${rep}</div>
					${links.length ? `<div class="agora-activity-links">${links.join('')}</div>` : ''}
				</div>
			</li>`;
		}).join('')}</ul>`;
	}

	// Open the job-detail + verifier for a completed task. Decoupled via the same
	// event the board uses, so one panel serves every entry point.
	_wireActivity() {
		this._bodyEl.querySelectorAll('button[data-verify]').forEach((btn) => {
			btn.addEventListener('click', () => {
				window.dispatchEvent(new CustomEvent('agora:open-job', { detail: {
					task: {
						taskPda: btn.dataset.task || null,
						taskId: btn.dataset.taskId || null,
						cluster: this._cluster,
						title: btn.dataset.title || 'Completed task',
						profession: btn.dataset.prof || null,
						proofHash: btn.dataset.proof || null,
						deliverableUrl: btn.dataset.url || null,
						txSignature: btn.dataset.tx || null,
						reward: btn.dataset.reward ? { label: btn.dataset.reward, amountAtomic: btn.dataset.amount || null } : null,
					},
					opener: btn,
				} }));
			});
		});
	}

	// ── deep-link + a11y ───────────────────────────────────────────────────────
	_maybeDeepLink() {
		try {
			const id = new URLSearchParams(window.location.search).get('citizen');
			if (id) requestAnimationFrame(() => this.open(id));
		} catch { /* non-fatal */ }
	}

	_setDeepLink(id) {
		try { const u = new URL(window.location.href); u.searchParams.set('citizen', id); window.history.replaceState(null, '', u); } catch { /* non-fatal */ }
	}

	_clearDeepLink() {
		try { const u = new URL(window.location.href); u.searchParams.delete('citizen'); window.history.replaceState(null, '', u); } catch { /* non-fatal */ }
	}

	_trapTab(e) {
		// getClientRects() is fixed-safe (offsetParent can be null for visible
		// children inside a position:fixed panel in some engines).
		const items = [...this._el.querySelectorAll('a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter((n) => n === document.activeElement || n.getClientRects().length > 0);
		if (!items.length) return;
		const first = items[0];
		const last = items[items.length - 1];
		if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
		else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
	}
}

function statusClass(status) {
	const s = String(status || '').toLowerCase();
	if (s.startsWith('active')) return 'is-active';
	if (s.startsWith('busy')) return 'is-busy';
	if (s.startsWith('idle')) return 'is-idle';
	if (s.startsWith('suspend')) return 'is-suspended';
	return 'is-idle';
}
