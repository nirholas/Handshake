/**
 * /conversions: both sides of the moment a metered trial runs out.
 *
 * Reads GET /api/marketplace/trial-status, which answers from two fixed
 * perspectives: the trials the signed-in user holds, and the trials running on
 * skills their agents sell. Nothing here initiates a payment. The convert CTA
 * links to the agent's own page, where the existing purchase flow shows the
 * amount and destination before anything is signed.
 */

const ENDPOINT = '/api/marketplace/trial-status';
const ROLES = ['buyer', 'seller'];

const els = {
	tabs: /** @type {HTMLButtonElement[]} */ ([]),
	panel: null,
	list: null,
	stats: null,
};

/** Per-role response cache, so flipping the tabs back is instant and quiet. */
const cache = new Map();
/** Guards against a slow first request painting over a newer one. */
let requestSeq = 0;

// ── helpers ───────────────────────────────────────────────────────────────────

function esc(value) {
	return String(value ?? '').replace(
		/[&<>"']/g,
		(ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
	);
}

function plural(n, one, many) {
	return `${n} ${n === 1 ? one : many}`;
}

/**
 * " · started 3h ago", or nothing at all when the server has no timestamp.
 * A trial row that printed the bare word "started" with an empty time after it
 * read like a truncated sentence, which is worse than simply not saying when.
 */
function timeClause(prefix, iso) {
	const rel = relativeTime(iso);
	return rel ? ` · ${prefix} ${esc(rel)}` : '';
}

/** "3 hours ago" without pulling a date library in for one label. */
function relativeTime(iso) {
	if (!iso) return '';
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) return '';
	const mins = Math.round((Date.now() - then) / 60000);
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days}d ago`;
	return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function mintLabel(mint) {
	if (!mint) return '';
	// The platform's own mint is the common case and deserves its ticker.
	if (mint === 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump') return '$THREE';
	return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

function priceHtml(price) {
	if (!price) return '<span class="cv-priceless">No price set</span>';
	return `<span class="cv-price">${esc(price.display)}<small>${esc(mintLabel(price.mint))}</small></span>`;
}

const STATE_PILL = {
	fresh: { cls: 'pill-fresh', label: 'Fresh' },
	'running-low': { cls: 'pill-low', label: 'Running low' },
	exhausted: { cls: 'pill-out', label: 'Trial spent' },
};

/**
 * One sentence for the runs left, used verbatim by both the visible count and
 * the meter's aria-label so the two can never drift. `grant` is null when the
 * seller has since delisted the skill and the size of the original grant is
 * unknowable: saying "1 of 1" there invented a denominator the server never
 * reported, so that case names the remaining runs and stops.
 */
export function runsLeftText(left, grant, wrap = (n) => String(n)) {
	if (left === 0) return 'Every free run spent';
	if (grant) return `${wrap(left)} of ${grant} free ${grant === 1 ? 'run' : 'runs'} left`;
	return `${wrap(left)} free ${left === 1 ? 'run' : 'runs'} left`;
}

/**
 * The runs-left meter. A metered trial that renders as a bare number teaches
 * nothing; pips make "one run left" read at a glance. Capped so a generous
 * grant does not produce a hundred pips.
 */
function meterHtml(remaining, granted) {
	const grantNum = Number(granted);
	const grant = Number.isFinite(grantNum) && grantNum > 0 ? grantNum : null;
	const total = Math.max(1, Math.min(10, grant || Number(remaining) || 1));
	const left = Math.max(0, Math.min(total, Number(remaining) || 0));
	const low = left <= Math.max(1, Math.floor(total / 3));
	const pips = Array.from({ length: total }, (_, i) => {
		const filled = i < left;
		return `<span class="meter-pip${filled ? ' is-left' : ''}${filled && low ? ' is-low' : ''}"></span>`;
	}).join('');
	return `
		<div class="meter${left === 0 ? ' is-spent' : ''}" role="img" aria-label="${esc(runsLeftText(left, grant))}">${pips}</div>
		<div class="meter-count">${runsLeftText(left, grant, (n) => `<strong>${n}</strong>`)}</div>`;
}

// ── renderers ─────────────────────────────────────────────────────────────────

function renderStats(cards) {
	els.stats.innerHTML = cards
		.map(
			(c) => `
			<div class="stat-card${c.tone ? ` is-${c.tone}` : ''}">
				<div class="stat-val">${esc(c.value)}${c.unit ? `<span class="stat-unit">${esc(c.unit)}</span>` : ''}</div>
				<div class="stat-lbl">${esc(c.label)}</div>
				${c.note ? `<div class="stat-note">${esc(c.note)}</div>` : ''}
			</div>`,
		)
		.join('');
}

function renderBuyer(data) {
	const s = data.summary;
	renderStats([
		{ value: s.active, label: 'Active trials' },
		{ value: s.runningLow, label: 'Running low', tone: s.runningLow ? 'hot' : null },
		{ value: s.exhausted, label: 'Spent, ready to buy', tone: s.exhausted ? 'hot' : null },
		{ value: s.fresh, label: 'Barely touched' },
	]);

	if (!data.trials.length) {
		return emptyState({
			icon: '◎',
			title: 'No trials running',
			body: 'Skills with a free trial let you run them a few times before you decide. Browse the marketplace and start one; it shows up here with the runs you have left.',
			cta: { href: '/marketplace', label: 'Browse the marketplace' },
		});
	}

	els.list.innerHTML =
		data.trials
			.map((t) => {
				const pill = STATE_PILL[t.state] || STATE_PILL.fresh;
				const href = skillHref(t.agentUrl, t.skill);
				const cta =
					t.state === 'exhausted'
						? `<a class="btn btn-primary" href="${esc(href)}">Buy it</a>`
						: `<a class="btn" href="${esc(href)}">Open agent</a>`;
				return `
			<article class="cv-row">
				<div class="cv-main">
					<div class="cv-title">
						<span class="cv-skill">${esc(t.skill)}</span>
						<span class="pill ${pill.cls}">${esc(pill.label)}</span>
					</div>
					<div class="cv-agent">from <a href="${esc(t.agentUrl)}">${esc(t.agentName)}</a>${timeClause('started', t.startedAt)}</div>
					${meterHtml(t.trialRemaining, t.trialUses)}
				</div>
				<div class="cv-side">
					${priceHtml(t.price)}
					${cta}
				</div>
			</article>`;
			})
			.join('') + truncationHtml(data);
}

/**
 * Deep-link the row's CTA at the skill it is about. The agent page lists every
 * skill the agent sells, so landing at the top of it left the buyer hunting for
 * the one their trial just ran out on; `?skill=…#pricing` opens on that row.
 */
function skillHref(agentUrl, skill) {
	return `${agentUrl}?skill=${encodeURIComponent(skill)}#pricing`;
}

/**
 * The list is capped server-side. Saying so is the difference between a page
 * that shows part of the truth and a page that quietly lies about how many
 * trials somebody holds.
 */
function truncationHtml(data) {
	if (!data.truncated) return '';
	return `<p class="cv-truncated">Showing the ${data.trials.length} trials closest to converting, of ${esc(data.total)} you hold.</p>`;
}

/** "plus 40 USDC" for every queue currency the headline number leaves out. */
export function otherMintsNote(potentials) {
	if (!Array.isArray(potentials) || potentials.length < 2) return null;
	return `plus ${potentials
		.slice(1)
		.map((p) => `${p.display} ${mintLabel(p.mint)}`.trim())
		.join(', ')}`;
}

function renderSeller(data) {
	const s = data.summary;
	renderStats([
		{ value: s.warmLeads, label: 'Buyers out of free runs', tone: s.warmLeads ? 'hot' : null },
		{ value: s.lastRun, label: 'On their last run' },
		{ value: s.sold, label: 'Converted to sales' },
		{
			value: s.potential.display,
			unit: mintLabel(s.potential.mint),
			label: 'Sitting in the queue',
			tone: 'money',
			// The endpoint totals the queue per mint because atomic amounts from two
			// mints cannot be added; it hands over the largest bucket as the headline
			// and the rest alongside it. Naming the rest is the only way a seller who
			// prices in two currencies sees their whole queue.
			note: otherMintsNote(s.potentials),
		},
	]);

	if (!data.queue.length) {
		return emptyState({
			icon: '◇',
			title: 'No trials running on your skills',
			body: 'Attach a free trial to a priced skill and buyers can run it a few times before paying. Every trial you grant shows up here with how close it is to converting.',
			cta: { href: '/tutorials/sell-a-skill-with-a-trial', label: 'Set up a skill with a trial' },
		});
	}

	els.list.innerHTML = data.queue
		.map((q) => {
			const rate = q.sold + q.activeTrials > 0 ? Math.round(q.conversionRate * 100) : 0;
			return `
			<article class="cv-row">
				<div class="cv-main">
					<div class="cv-title">
						<span class="cv-skill">${esc(q.skill)}</span>
						${q.exhausted ? `<span class="pill pill-out">${esc(plural(q.exhausted, 'buyer waiting', 'buyers waiting'))}</span>` : ''}
					</div>
					<div class="cv-agent">on <a href="/agent/${esc(q.agentId)}">${esc(q.agentName)}</a>${timeClause('last activity', q.lastActivity)}</div>
					<div class="cv-metrics">
						<span class="cv-metric"><b>${esc(q.activeTrials)}</b> ${q.activeTrials === 1 ? 'trial' : 'trials'} running</span>
						<span class="cv-metric${q.lastRun ? ' is-hot' : ''}"><b>${esc(q.lastRun)}</b> on last run</span>
						<span class="cv-metric"><b>${esc(q.sold)}</b> sold</span>
						<span class="cv-metric"><b>${rate}%</b> convert</span>
					</div>
				</div>
				<div class="cv-side">
					${priceHtml(q.price)}
					<a class="btn" href="${esc(q.pricingUrl)}">Edit pricing</a>
				</div>
			</article>`;
		})
		.join('');
}

function emptyState({ icon, title, body, cta }) {
	els.list.innerHTML = `
		<div class="cv-state">
			<div class="cv-state-icon" aria-hidden="true">${esc(icon)}</div>
			<h2>${esc(title)}</h2>
			<p>${esc(body)}</p>
			${cta ? `<a class="btn btn-primary" href="${esc(cta.href)}">${esc(cta.label)}</a>` : ''}
		</div>`;
}

function signedOutState() {
	renderStats([]);
	els.list.innerHTML = `
		<div class="cv-state">
			<div class="cv-state-icon" aria-hidden="true">◔</div>
			<h2>Sign in to see your trials</h2>
			<p>Trials are tied to your account on both sides: the ones you are holding and the ones running on skills your agents sell.</p>
			<a class="btn btn-primary" href="/login?next=${encodeURIComponent(location.pathname + location.search)}">Sign in</a>
		</div>`;
}

function errorState(message, role) {
	renderStats([]);
	els.list.innerHTML = `
		<div class="cv-state is-error">
			<div class="cv-state-icon" aria-hidden="true">⚠</div>
			<h2>Could not load your trials</h2>
			<p>${esc(message)}</p>
			<button class="btn" type="button" id="cv-retry">Try again</button>
		</div>`;
	els.list.querySelector('#cv-retry')?.addEventListener('click', () => load(role, { force: true }));
}

function loadingState() {
	els.panel.setAttribute('aria-busy', 'true');
	els.list.innerHTML = `
		<div class="skeleton skeleton-row"></div>
		<div class="skeleton skeleton-row" style="animation-delay:.12s"></div>
		<div class="skeleton skeleton-row" style="animation-delay:.24s"></div>`;
}

// ── data ──────────────────────────────────────────────────────────────────────

async function load(role, { force = false } = {}) {
	if (!force && cache.has(role)) {
		paint(role, cache.get(role));
		return;
	}
	const seq = ++requestSeq;
	loadingState();

	let res;
	try {
		res = await fetch(`${ENDPOINT}?role=${encodeURIComponent(role)}`, {
			credentials: 'include',
			headers: { Accept: 'application/json' },
		});
	} catch {
		if (seq !== requestSeq) return;
		els.panel.setAttribute('aria-busy', 'false');
		return errorState('The request did not reach the server. Check your connection and try again.', role);
	}
	if (seq !== requestSeq) return;
	els.panel.setAttribute('aria-busy', 'false');

	if (res.status === 401) return signedOutState();
	if (res.status === 429) {
		return errorState('Too many requests from this address. Wait a moment and try again.', role);
	}
	if (!res.ok) {
		let detail = `The server returned HTTP ${res.status}.`;
		try {
			const body = await res.json();
			if (body?.error_description) detail = body.error_description;
		} catch {
			/* a non-JSON error body is still an error; the status carries the meaning */
		}
		return errorState(detail, role);
	}

	let payload;
	try {
		payload = (await res.json())?.data;
	} catch {
		return errorState('The server sent a response this page could not read.', role);
	}
	if (!payload) return errorState('The server sent an empty response.', role);

	cache.set(role, payload);
	paint(role, payload);
}

function paint(role, payload) {
	els.panel.setAttribute('aria-busy', 'false');
	if (role === 'seller') renderSeller(payload);
	else renderBuyer(payload);
}

// ── tabs ──────────────────────────────────────────────────────────────────────

function selectRole(role, { push = true } = {}) {
	if (!ROLES.includes(role)) role = 'buyer';
	for (const tab of els.tabs) {
		const on = tab.dataset.role === role;
		tab.setAttribute('aria-selected', on ? 'true' : 'false');
		tab.tabIndex = on ? 0 : -1;
		if (on) els.panel.setAttribute('aria-labelledby', tab.id);
	}
	if (push) {
		const url = new URL(location.href);
		if (role === 'buyer') url.searchParams.delete('role');
		else url.searchParams.set('role', role);
		history.replaceState({}, '', url);
	}
	load(role);
}

function wireTabs() {
	for (const tab of els.tabs) {
		tab.addEventListener('click', () => selectRole(tab.dataset.role));
	}
	// Arrow-key navigation is what makes a tablist a tablist for keyboard users.
	document.querySelector('.role-switch')?.addEventListener('keydown', (e) => {
		const idx = els.tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
		let next = null;
		if (e.key === 'ArrowRight') next = (idx + 1) % els.tabs.length;
		else if (e.key === 'ArrowLeft') next = (idx - 1 + els.tabs.length) % els.tabs.length;
		else if (e.key === 'Home') next = 0;
		else if (e.key === 'End') next = els.tabs.length - 1;
		if (next === null) return;
		e.preventDefault();
		els.tabs[next].focus();
		selectRole(els.tabs[next].dataset.role);
	});
}

function init() {
	els.tabs = Array.from(document.querySelectorAll('.role-tab'));
	els.panel = document.getElementById('cv-panel');
	els.list = document.getElementById('cv-list');
	els.stats = document.getElementById('cv-stats');
	if (!els.panel || !els.list || !els.stats || !els.tabs.length) return;

	wireTabs();
	selectRole(new URL(location.href).searchParams.get('role') || 'buyer', { push: false });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
