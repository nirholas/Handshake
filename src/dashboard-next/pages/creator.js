// dashboard-next — Creator Studio.
//
// The supply-side proof surface: creators set prices, watch real earnings, wire
// payouts, track the royalty ledger on-chain, and see per-skill analytics — all
// from live /api/* endpoints. No mock figures anywhere.
//
// Where this sits next to /dashboard/monetize: Monetize is the billing/withdrawal
// hub. Creator Studio is the *seller's* cockpit — dynamic pricing rules, the
// buyer-facing $THREE-holder price ladder, the pending→settling→settled royalty
// ledger, per-skill conversion, and a guided "become a creator → first sale"
// path instrumented as the creator funnel.

import { mountShell } from '../shell.js';
import { requireUser, get, post, put, del, esc, relTime, ApiError } from '../api.js';
import { errorStateHTML, ensureStateKitStyles } from '../../shared/state-kit.js';
import { trackFunnelStep, ANALYTICS_EVENTS } from '../../analytics.js';
import {
	TIER_LADDER,
	usdcToAtomic,
	atomicToUsdc,
	buyerPriceLadder,
	validatePrice,
	validateRule,
	effectivePriceNow,
	groupLedgerByStatus,
	ledgerToCsv,
	railLabel,
	funnelStage,
} from './creator-helpers.js';
// Chain identity lives in one place for the whole platform: the ledger stores
// CAIP-2 ids ('solana:5eykt4Us…', 'eip155:8453') and this module owns the
// id → label and id → explorer mapping, so a Base settlement never links to a
// Solana explorer. Pure string/data code, safe in the browser bundle.
import { networkLabel, revenueTxUrl } from '../../../api/_lib/x402/revenue-networks.js';

const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const SKILL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

const PERIODS = [
	{ key: '7d', label: 'Last 7 days', days: 7 },
	{ key: '30d', label: 'Last 30 days', days: 30 },
	{ key: '90d', label: 'Last 90 days', days: 90 },
	{ key: 'all', label: 'All time', days: 365 },
];

const RULE_LABELS = {
	first_n_purchases: 'First N buyers',
	after_n_purchases: 'After N buyers',
	time_window: 'Time window',
};

const STATE = {
	me: null,
	agents: [],
	agentId: null,
	period: '30d',
	prices: [],
	rules: [], // pricing rules for the selected agent (all skills)
	wallet: null,
	withdrawals: [],
	earnings: null, // { pending_usd, settled_usd, entries }
	analytics: null,
	firstSaleFired: false,
};

(async function boot() {
	try {
		const main = await mountShell();
		STATE.me = await requireUser();

		injectStyles();
		main.innerHTML = `
			<div class="cs-head">
				<div>
					<h1 class="dn-h1">Creator Studio</h1>
					<p class="dn-h1-sub">Set prices, watch real earnings, and get paid. This is where creators make money.</p>
				</div>
				<div class="cs-head-controls">
					<div data-slot="agent-selector"></div>
					<select data-slot="period" class="cs-select" aria-label="Analytics period">
						${PERIODS.map((p) => `<option value="${p.key}"${p.key === STATE.period ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}
					</select>
				</div>
			</div>
			<div data-slot="content" class="cs-content"></div>
		`;

		const host = main.querySelector('[data-slot="content"]');
		const selectorHost = main.querySelector('[data-slot="agent-selector"]');
		const periodSel = main.querySelector('[data-slot="period"]');
		renderSkeleton(host);

		const agentsResp = await safe(() => get('/api/agents?limit=100'));
		STATE.agents = agentsResp?.agents || [];
		STATE.agentId = STATE.agents[0]?.id || null;

		renderAgentSelector(selectorHost, host);
		periodSel.addEventListener('change', async () => {
			STATE.period = periodSel.value;
			renderSkeleton(host);
			await loadAndRender(host);
		});

		// Funnel step 1 — the creator showed up. The rest of the funnel
		// (price set → payout wired → first sale) fires from the panels below.
		trackFunnelStep('creator', ANALYTICS_EVENTS.CREATOR_ONBOARDING_STARTED, {
			agent_count: STATE.agents.length,
		});

		await loadAndRender(host);
	} catch (err) {
		if (err instanceof ApiError && err.status === 401) {
			const ret = encodeURIComponent(location.pathname + location.search);
			location.href = `/login?return=${ret}`;
			return;
		}
		throw err;
	}
})();

async function safe(fn) {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof ApiError && err.status === 401) throw err;
		return null;
	}
}

// ── Agent selector ───────────────────────────────────────────────────────────

function renderAgentSelector(host, contentHost) {
	if (!STATE.agents.length) {
		host.innerHTML = `<a class="dn-btn primary" href="/dashboard/agents">Create your first agent</a>`;
		return;
	}
	host.innerHTML = `
		<select data-slot="agent-select" class="cs-select" aria-label="Select agent">
			${STATE.agents.map((a) => `<option value="${esc(a.id)}"${a.id === STATE.agentId ? ' selected' : ''}>${esc(a.name || a.slug || 'Unnamed agent')}</option>`).join('')}
		</select>`;
	host.querySelector('[data-slot="agent-select"]').addEventListener('change', async (e) => {
		STATE.agentId = e.target.value;
		renderSkeleton(contentHost);
		await loadAndRender(contentHost);
	});
}

// ── Data loading ─────────────────────────────────────────────────────────────

async function loadAndRender(host) {
	if (!STATE.agents.length) {
		// Royalties are AUTHOR-scoped, not agent-scoped: a marketplace skill author
		// earns on every paid /api/x402/skill-call whether or not they ever
		// registered an agent. Load the author ledger BEFORE the agent gate so a
		// creator who is already being paid never hits a "create an agent" wall
		// standing between them and their own money.
		const earnings = await safe(() => get('/api/users/me/earnings'));
		STATE.earnings = earnings || { pending_usd: 0, settled_usd: 0, entries: [] };
		host.innerHTML = '';
		if ((STATE.earnings.entries || []).length) {
			host.appendChild(renderAuthorOnlyIntro());
			host.appendChild(renderRoyaltyLedger());
		} else {
			host.appendChild(renderNoAgents());
		}
		return;
	}

	const agentId = STATE.agentId;
	const periodMeta = PERIODS.find((p) => p.key === STATE.period) || PERIODS[1];
	const days = periodMeta.days;

	const [prices, rulesResp, wallet, withdrawalsResp, earnings, analytics] = await Promise.all([
		safe(() => get(`/api/monetization/prices?agent_id=${encodeURIComponent(agentId)}`)),
		safe(() => get(`/api/agents/${encodeURIComponent(agentId)}/pricing-rules`)),
		safe(() => get(`/api/monetization/wallet?agent_id=${encodeURIComponent(agentId)}`)),
		safe(() => get(`/api/monetization/withdrawals?agent_id=${encodeURIComponent(agentId)}&limit=50`)),
		// /api/users/me/earnings, not /api/users/earnings: the bare path is
		// swallowed by the /api/users/([^/]+) catch-all above it in vercel.json
		// and answers "user not found" for a user literally named "earnings",
		// which safe() then discards, leaving the panel silently empty.
		safe(() => get('/api/users/me/earnings')),
		safe(() => get(`/api/creators/skill-analytics?agent_id=${encodeURIComponent(agentId)}&days=${days}`)),
	]);

	// If literally everything failed, this is a service problem — say so once.
	if (!prices && !wallet && !earnings && !analytics) {
		ensureStateKitStyles();
		host.innerHTML = errorStateHTML({
			title: "Couldn't load your Creator Studio",
			body: 'We had trouble reaching the creator services. Check your connection and try again.',
		});
		host.querySelector('[data-sk-retry]')?.addEventListener('click', () => {
			renderSkeleton(host);
			loadAndRender(host);
		});
		return;
	}

	STATE.prices = prices?.prices || [];
	STATE.rules = rulesResp?.data?.rules || [];
	STATE.wallet = wallet?.resolved || null;
	STATE.withdrawals = withdrawalsResp?.withdrawals || [];
	STATE.balance = withdrawalsResp?.balance || null;
	STATE.earnings = earnings || { pending_usd: 0, settled_usd: 0, entries: [] };
	STATE.analytics = analytics?.data || null;

	const hasSale = Number(STATE.balance?.earned_usdc || 0) > 0 || (STATE.earnings.entries || []).length > 0;
	const hasPayout = Boolean(STATE.wallet?.solana_address || STATE.wallet?.evm_address);

	// Fire the first-sale funnel step once, when we first observe a settled sale.
	if (hasSale && !STATE.firstSaleFired) {
		STATE.firstSaleFired = true;
		trackFunnelStep('creator', ANALYTICS_EVENTS.CREATOR_FIRST_SALE, {
			agent_id: agentId,
			revenue_usd: Number(STATE.balance?.earned_usdc || 0),
		});
	}

	host.innerHTML = '';
	host.appendChild(renderOnboarding({ hasPayout, hasSale }));
	host.appendChild(renderEarningsHero());
	host.appendChild(renderPriceEditor(host));
	host.appendChild(renderSkillAnalytics());
	host.appendChild(renderPayoutPanel(host));
	host.appendChild(renderRoyaltyLedger());
	host.appendChild(renderWithdrawals(host));
}

// ── Onboarding path ──────────────────────────────────────────────────────────

function renderOnboarding({ hasPayout, hasSale }) {
	const stage = funnelStage({
		agentCount: STATE.agents.length,
		priceCount: STATE.prices.length,
		hasPayout,
		hasSale,
	});
	const wrap = document.createElement('div');
	if (stage === 'earning') {
		// Fully ramped — celebrate, don't nag.
		wrap.className = 'dn-panel cs-onboard cs-onboard-done';
		wrap.innerHTML = `
			<div class="cs-onboard-badge">✓</div>
			<div>
				<div class="dn-panel-title">You're a paid creator</div>
				<div class="dn-panel-sub">Prices set, payout wired, and real sales landing. Add more priced skills to grow your take.</div>
			</div>`;
		return wrap;
	}

	const steps = [
		{ key: 'set_price', title: 'Set your first price', body: 'Charge USDC for a skill your agent already does.', done: STATE.prices.length > 0, cta: { label: 'Set a price', action: 'scroll-price' } },
		{ key: 'configure_payout', title: 'Add a payout wallet', body: 'Tell us where to send your earnings.', done: hasPayout, cta: { label: 'Add wallet', action: 'scroll-payout' } },
		{ key: 'first_sale', title: 'Make your first sale', body: 'Embed your agent or share its skills to earn.', done: hasSale, cta: { label: 'Get installs', href: '/dashboard/widgets' } },
	];
	const doneCount = steps.filter((s) => s.done).length;

	wrap.className = 'dn-panel cs-onboard';
	wrap.innerHTML = `
		<div class="cs-onboard-head">
			<div class="dn-panel-title">Become a paid creator</div>
			<div class="cs-onboard-progress">${doneCount} of ${steps.length} done</div>
		</div>
		<div class="cs-steps">
			${steps.map((s, i) => `
				<div class="cs-step${s.done ? ' done' : ''}${s.key === stage ? ' active' : ''}">
					<div class="cs-step-num">${s.done ? '✓' : i + 1}</div>
					<div class="cs-step-body">
						<div class="cs-step-title">${esc(s.title)}</div>
						<div class="cs-step-sub">${esc(s.body)}</div>
					</div>
					${!s.done ? (s.cta.href
						? `<a class="dn-btn" href="${esc(s.cta.href)}">${esc(s.cta.label)}</a>`
						: `<button class="dn-btn" data-action="${esc(s.cta.action)}">${esc(s.cta.label)}</button>`) : ''}
				</div>`).join('')}
		</div>`;

	wrap.querySelector('[data-action="scroll-price"]')?.addEventListener('click', () => {
		document.querySelector('[data-panel="price-editor"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
	});
	wrap.querySelector('[data-action="scroll-payout"]')?.addEventListener('click', () => {
		document.querySelector('[data-panel="payout"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
	});
	return wrap;
}

// ── Earnings hero ────────────────────────────────────────────────────────────

function renderEarningsHero() {
	// Unsettled = not yet in the author's wallet. 'settling' rows are claimed by
	// an in-flight redeem pass, so counting only 'pending' understated what the
	// author is still owed.
	const pending = Number(STATE.earnings?.pending_usd || 0) + Number(STATE.earnings?.settling_usd || 0);
	const earned = Number(STATE.balance?.earned_usdc || 0);
	const withdrawn = Number(STATE.balance?.withdrawn_usdc || 0);
	const available = Number(STATE.balance?.available_usdc || 0);

	const wrap = document.createElement('div');
	wrap.className = 'cs-hero';
	wrap.appendChild(heroCard({ title: 'Available to withdraw', value: usd(available), sub: 'Settled balance, minus inflight', accent: 'good' }));
	wrap.appendChild(heroCard({ title: 'Total earned', value: usd(earned), sub: 'Lifetime, after platform fees' }));
	wrap.appendChild(heroCard({ title: 'Withdrawn', value: usd(withdrawn), sub: 'Paid out to your wallet' }));
	wrap.appendChild(heroCard({ title: 'Pending royalties', value: usd(pending), sub: pending > 0 ? 'Settling to your wallet on-chain' : 'No unsettled royalties', accent: 'accent' }));
	return wrap;
}

function heroCard({ title, value, sub, accent }) {
	const color = accent === 'good' ? 'var(--nxt-success)' : accent === 'warn' ? 'var(--nxt-warn)' : accent === 'accent' ? 'var(--nxt-accent-strong)' : 'var(--nxt-ink)';
	const el = document.createElement('div');
	el.className = 'dn-panel cs-hero-card';
	el.innerHTML = `
		<div class="dn-panel-title">${esc(title)}</div>
		<div class="cs-hero-value" style="color:${color}">${esc(value)}</div>
		<div class="dn-panel-sub">${esc(sub)}</div>`;
	return el;
}

// ── Price editor (base price + $THREE ladder + dynamic rules) ─────────────────

function renderPriceEditor(host) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.dataset.panel = 'price-editor';

	function paint() {
		panel.innerHTML = `
			<div class="cs-panel-head">
				<div>
					<div class="dn-panel-title">Skill pricing</div>
					<div class="dn-panel-sub">Charge USDC per call. $THREE holders see an automatic discount — preview it below.</div>
				</div>
				<button class="dn-btn primary" data-action="add">+ Price a skill</button>
			</div>
			<div data-slot="list"></div>`;
		const list = panel.querySelector('[data-slot="list"]');
		const priced = STATE.prices.filter((p) => p.gate_type !== 'nft');

		if (!priced.length) {
			list.innerHTML = `
				<div class="dn-empty">
					<h3>No priced skills yet</h3>
					<p>Pick a skill your agent performs and put a price on it. You keep the revenue minus the platform fee.</p>
				</div>`;
		} else {
			list.innerHTML = priced.map((p) => priceCard(p)).join('');
		}

		panel.querySelector('[data-action="add"]').addEventListener('click', () => openPriceModal(null, () => { reloadAgentPricing(host); }));
		list.querySelectorAll('[data-action="edit"]').forEach((b) => b.addEventListener('click', () => {
			const skill = b.dataset.skill;
			const price = STATE.prices.find((p) => (p.skill_name || p.skill) === skill);
			openPriceModal(price, () => reloadAgentPricing(host));
		}));
		list.querySelectorAll('[data-action="rules"]').forEach((b) => b.addEventListener('click', () => {
			openRulesModal(b.dataset.skill, () => reloadAgentPricing(host));
		}));
		list.querySelectorAll('[data-action="delete"]').forEach((b) => b.addEventListener('click', async () => {
			const skill = b.dataset.skill;
			b.disabled = true; b.textContent = 'Removing…';
			try {
				await del(`/api/monetization/prices?agent_id=${encodeURIComponent(STATE.agentId)}&skill_name=${encodeURIComponent(skill)}`);
				toast('Skill price removed');
				await reloadAgentPricing(host);
			} catch (err) {
				toast(err?.message || 'Delete failed', true);
				b.disabled = false; b.textContent = 'Remove';
			}
		}));
	}

	paint();
	return panel;
}

function priceCard(p) {
	const skill = p.skill_name || p.skill || 'unnamed';
	const base = Number(p.price_usdc ?? atomicToUsdc(p.amount_atomic) ?? 0);
	const rules = STATE.rules.filter((r) => r.skill_name === skill && r.is_active !== false);
	const saleCount = saleCountForSkill(skill);
	const effective = effectivePriceNow({ basePriceUsdc: base, rules, saleCount });
	const ladder = buyerPriceLadder(effective.priceUsdc);
	const active = p.is_active !== false;

	const ruleNote = effective.source !== 'base'
		? `<span class="cs-tag accent" title="A dynamic pricing rule is active right now">${esc(RULE_LABELS[effective.source] || 'Rule')} active</span>`
		: '';

	return `
		<div class="cs-price-card">
			<div class="cs-price-top">
				<div class="cs-price-name">${esc(skill)} ${active ? '' : '<span class="cs-tag muted">paused</span>'} ${ruleNote}</div>
				<div class="cs-price-actions">
					<button class="dn-btn" data-action="edit" data-skill="${esc(skill)}">Edit</button>
					<button class="dn-btn" data-action="rules" data-skill="${esc(skill)}">Rules${rules.length ? ` · ${rules.length}` : ''}</button>
					<button class="dn-btn danger" data-action="delete" data-skill="${esc(skill)}">Remove</button>
				</div>
			</div>
			<div class="cs-price-figures">
				<div><span class="cs-fig-label">List price</span><span class="cs-fig-value">${usd(base)}</span></div>
				<div><span class="cs-fig-label">Effective now</span><span class="cs-fig-value">${usd(effective.priceUsdc)}</span></div>
				<div><span class="cs-fig-label">Confirmed sales</span><span class="cs-fig-value">${saleCount}</span></div>
			</div>
			<div class="cs-ladder" aria-label="Buyer-facing price by $THREE holder tier">
				${ladder.map((t) => `
					<div class="cs-ladder-cell" title="${esc(t.label)} holders${t.discountBps ? ` save ${(t.discountBps / 100).toFixed(0)}%` : ''}">
						<span class="cs-ladder-tier">${esc(t.label)}</span>
						<span class="cs-ladder-price">${usd(t.price)}</span>
						<span class="cs-ladder-disc">${t.discountBps ? `−${(t.discountBps / 100).toFixed(0)}%` : 'full'}</span>
					</div>`).join('')}
			</div>
		</div>`;
}

function openPriceModal(existing, onSaved) {
	const isEdit = Boolean(existing);
	const skill = existing ? (existing.skill_name || existing.skill) : '';
	const price = existing ? Number(existing.price_usdc ?? atomicToUsdc(existing.amount_atomic) ?? 0) : '';
	const active = existing ? existing.is_active !== false : true;

	const overlay = modal(`
		<div class="cs-modal-title">${isEdit ? 'Edit price' : 'Price a skill'}</div>
		<label class="cs-field">
			<span class="cs-label">Skill name</span>
			<input data-f="skill" type="text" maxlength="64" class="cs-input" value="${esc(skill)}" ${isEdit ? 'readonly' : 'placeholder="e.g. generate_report"'} />
			<span class="cs-hint" data-h="skill"></span>
		</label>
		<label class="cs-field">
			<span class="cs-label">Price per call (USDC)</span>
			<input data-f="price" type="number" min="0" step="0.000001" class="cs-input" value="${esc(String(price))}" placeholder="0.05" />
			<span class="cs-hint" data-h="price"></span>
		</label>
		<div class="cs-ladder-preview" data-slot="ladder"></div>
		<label class="cs-check">
			<input data-f="active" type="checkbox" ${active ? 'checked' : ''} />
			<span>Active — buyers can call this skill</span>
		</label>
		<div class="cs-error" data-slot="err"></div>
		<div class="cs-modal-actions">
			<button class="dn-btn ghost" data-action="cancel">Cancel</button>
			<button class="dn-btn primary" data-action="save">${isEdit ? 'Save' : 'Add price'}</button>
		</div>
	`);

	const skillEl = overlay.querySelector('[data-f="skill"]');
	const priceEl = overlay.querySelector('[data-f="price"]');
	const activeEl = overlay.querySelector('[data-f="active"]');
	const errEl = overlay.querySelector('[data-slot="err"]');
	const ladderEl = overlay.querySelector('[data-slot="ladder"]');
	const skillHint = overlay.querySelector('[data-h="skill"]');
	const priceHint = overlay.querySelector('[data-h="price"]');

	function paintLadder() {
		const v = validatePrice(priceEl.value);
		if (!v.ok) { ladderEl.innerHTML = `<div class="cs-ladder-note">Enter a price to preview what each $THREE tier pays.</div>`; return; }
		ladderEl.innerHTML = `
			<div class="cs-ladder-note">What buyers pay by $THREE tier:</div>
			<div class="cs-ladder">${buyerPriceLadder(v.value).map((t) => `
				<div class="cs-ladder-cell">
					<span class="cs-ladder-tier">${esc(t.label)}</span>
					<span class="cs-ladder-price">${usd(t.price)}</span>
					<span class="cs-ladder-disc">${t.discountBps ? `−${(t.discountBps / 100).toFixed(0)}%` : 'full'}</span>
				</div>`).join('')}</div>`;
	}
	priceEl.addEventListener('input', () => {
		const v = validatePrice(priceEl.value);
		priceHint.textContent = v.ok ? '' : v.error;
		paintLadder();
	});
	paintLadder();
	(isEdit ? priceEl : skillEl).focus();

	overlay.querySelector('[data-action="save"]').addEventListener('click', async () => {
		errEl.textContent = '';
		const name = skillEl.value.trim();
		if (!SKILL_NAME_RE.test(name)) { skillHint.textContent = 'Letters, numbers, _ or -, up to 64 chars.'; return; }
		const v = validatePrice(priceEl.value);
		if (!v.ok) { priceHint.textContent = v.error; return; }

		const btn = overlay.querySelector('[data-action="save"]');
		btn.disabled = true; btn.textContent = 'Saving…';
		try {
			await put('/api/monetization/prices', {
				agent_id: STATE.agentId,
				skill_name: name,
				price_usdc: v.value,
				gate_type: 'price',
			});
			// Toggle active state if the owner unchecked it (PUT re-activates by default).
			if (!activeEl.checked) {
				await del(`/api/monetization/prices?agent_id=${encodeURIComponent(STATE.agentId)}&skill_name=${encodeURIComponent(name)}`);
			}
			const isFirst = STATE.prices.length === 0;
			trackFunnelStep('creator', ANALYTICS_EVENTS.CREATOR_PRICE_SET, {
				agent_id: STATE.agentId,
				skill: name,
				price_usdc: v.value,
				gate_type: 'price',
				is_first: isFirst,
			});
			overlay.close();
			toast(isEdit ? 'Price updated' : 'Skill priced');
			onSaved();
		} catch (err) {
			errEl.textContent = err?.body?.error_description || err?.message || 'Save failed';
			btn.disabled = false; btn.textContent = isEdit ? 'Save' : 'Add price';
		}
	});
}

// ── Dynamic pricing rules modal ──────────────────────────────────────────────

function openRulesModal(skill, onSaved) {
	const overlay = modal(`
		<div class="cs-modal-title">Pricing rules · ${esc(skill)}</div>
		<div class="dn-panel-sub" style="margin-bottom:14px">Rules override the list price by priority. First match wins; otherwise buyers pay the list price.</div>
		<div data-slot="rules"></div>
		<div class="cs-rule-form">
			<div class="cs-modal-subtitle">Add a rule</div>
			<label class="cs-field">
				<span class="cs-label">Type</span>
				<select data-f="type" class="cs-input">
					<option value="first_n_purchases">First N buyers (intro price)</option>
					<option value="after_n_purchases">After N buyers (raise price)</option>
					<option value="time_window">Time window (limited promo)</option>
				</select>
			</label>
			<div class="cs-rule-grid">
				<label class="cs-field" data-slot="threshold-field">
					<span class="cs-label">Threshold (N buyers)</span>
					<input data-f="threshold" type="number" min="1" step="1" class="cs-input" placeholder="10" />
				</label>
				<label class="cs-field" data-slot="start-field" hidden>
					<span class="cs-label">Start</span>
					<input data-f="start" type="datetime-local" class="cs-input" />
				</label>
				<label class="cs-field" data-slot="end-field" hidden>
					<span class="cs-label">End</span>
					<input data-f="end" type="datetime-local" class="cs-input" />
				</label>
				<label class="cs-field">
					<span class="cs-label">Rule price (USDC)</span>
					<input data-f="price" type="number" min="0" step="0.000001" class="cs-input" placeholder="0.01" />
				</label>
			</div>
			<div class="cs-error" data-slot="err"></div>
			<button class="dn-btn primary" data-action="add-rule">Add rule</button>
		</div>
		<div class="cs-modal-actions">
			<button class="dn-btn ghost" data-action="cancel">Done</button>
		</div>
	`);

	const typeEl = overlay.querySelector('[data-f="type"]');
	const thrField = overlay.querySelector('[data-slot="threshold-field"]');
	const startField = overlay.querySelector('[data-slot="start-field"]');
	const endField = overlay.querySelector('[data-slot="end-field"]');
	const errEl = overlay.querySelector('[data-slot="err"]');
	const rulesHost = overlay.querySelector('[data-slot="rules"]');

	function paintRules() {
		const rules = STATE.rules.filter((r) => r.skill_name === skill);
		rulesHost.innerHTML = rules.length
			? `<table class="cs-table"><thead><tr><th scope="col">Type</th><th scope="col">Condition</th><th scope="col" style="text-align:right">Price</th><th scope="col">Status</th><th scope="col"><span class="cs-sr-only">Actions</span></th></tr></thead><tbody>${rules.map(ruleRow).join('')}</tbody></table>`
			: `<div class="cs-rule-empty">No rules yet — buyers pay the list price.</div>`;
		rulesHost.querySelectorAll('[data-action="del-rule"]').forEach((b) => b.addEventListener('click', async () => {
			b.disabled = true;
			try {
				await del(`/api/agents/${encodeURIComponent(STATE.agentId)}/pricing-rules/${encodeURIComponent(b.dataset.id)}?rule_id=${encodeURIComponent(b.dataset.id)}`);
				STATE.rules = STATE.rules.filter((r) => r.id !== b.dataset.id);
				toast('Rule removed');
				paintRules();
				onSaved();
			} catch (err) { toast(err?.message || 'Failed', true); b.disabled = false; }
		}));
	}

	typeEl.addEventListener('change', () => {
		const t = typeEl.value;
		thrField.hidden = t === 'time_window';
		startField.hidden = t !== 'time_window';
		endField.hidden = t !== 'time_window';
		errEl.textContent = '';
	});
	paintRules();

	overlay.querySelector('[data-action="add-rule"]').addEventListener('click', async () => {
		errEl.textContent = '';
		const rule = {
			rule_type: typeEl.value,
			threshold: overlay.querySelector('[data-f="threshold"]').value,
			price_usdc: overlay.querySelector('[data-f="price"]').value,
			start_at: overlay.querySelector('[data-f="start"]').value || null,
			end_at: overlay.querySelector('[data-f="end"]').value || null,
		};
		const v = validateRule(rule);
		if (!v.ok) { errEl.textContent = v.error; return; }

		// Base price must exist for rules to resolve — guard with a clear message.
		const base = STATE.prices.find((p) => (p.skill_name || p.skill) === skill);
		if (!base) { errEl.textContent = 'Set a list price for this skill first.'; return; }

		const btn = overlay.querySelector('[data-action="add-rule"]');
		btn.disabled = true; btn.textContent = 'Adding…';
		try {
			const resp = await post(`/api/agents/${encodeURIComponent(STATE.agentId)}/pricing-rules?id=${encodeURIComponent(STATE.agentId)}`, {
				skill_name: skill,
				currency_mint: base.currency_mint || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
				chain: base.chain || 'solana',
				...v.payload,
			});
			if (resp?.data?.rule) STATE.rules.push(resp.data.rule);
			toast('Rule added');
			paintRules();
			onSaved();
		} catch (err) {
			errEl.textContent = err?.body?.error_description || err?.message || 'Failed to add rule';
		}
		btn.disabled = false; btn.textContent = 'Add rule';
	});
}

function ruleRow(r) {
	const cond = r.rule_type === 'time_window'
		? `${r.start_at ? shortDate(r.start_at) : '…'} → ${r.end_at ? shortDate(r.end_at) : '…'}`
		: `N = ${esc(String(r.threshold ?? '—'))}`;
	return `
		<tr>
			<td>${esc(RULE_LABELS[r.rule_type] || r.rule_type)}</td>
			<td>${cond}</td>
			<td style="text-align:right">${usd(atomicToUsdc(r.price_amount))}</td>
			<td>${r.is_active === false ? '<span class="cs-tag muted">off</span>' : '<span class="cs-tag good">on</span>'}</td>
			<td style="text-align:right"><button class="dn-btn danger cs-btn-xs" data-action="del-rule" data-id="${esc(r.id)}">Delete</button></td>
		</tr>`;
}

// ── Per-skill analytics ──────────────────────────────────────────────────────

function renderSkillAnalytics() {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	const a = STATE.analytics;
	const bySkill = a?.by_skill || [];
	const summary = a?.summary || {};

	panel.innerHTML = `
		<div class="cs-panel-head">
			<div>
				<div class="dn-panel-title">Per-skill analytics</div>
				<div class="dn-panel-sub">Calls, unique buyers, and success rate over the selected period.</div>
			</div>
			${bySkill.length ? `<div class="cs-summary">${Number(summary.total_calls || 0).toLocaleString()} calls · ${Number(summary.unique_users || 0).toLocaleString()} buyers</div>` : ''}
		</div>
		<div data-slot="body"></div>`;
	const body = panel.querySelector('[data-slot="body"]');
	if (!bySkill.length) {
		body.innerHTML = `<div class="dn-empty"><h3>No skill usage yet</h3><p>Once buyers start calling your priced skills, conversion and volume show up here.</p></div>`;
		return panel;
	}
	body.innerHTML = `
		<div style="overflow-x:auto">
			<table class="cs-table">
				<thead><tr>
					<th scope="col">Skill</th>
					<th scope="col" style="text-align:right">Calls</th>
					<th scope="col" style="text-align:right">Buyers</th>
					<th scope="col" style="text-align:right">Success</th>
					<th scope="col" style="text-align:right">Avg latency</th>
				</tr></thead>
				<tbody>
					${bySkill.map((s) => `
						<tr>
							<td>${esc(s.skill_name)}</td>
							<td style="text-align:right">${Number(s.total_calls || 0).toLocaleString()}</td>
							<td style="text-align:right">${Number(s.unique_users || 0).toLocaleString()}</td>
							<td style="text-align:right">${rate(s.success_rate_pct)}</td>
							<td style="text-align:right">${s.avg_execution_ms != null ? `${Number(s.avg_execution_ms).toLocaleString()} ms` : '—'}</td>
						</tr>`).join('')}
				</tbody>
			</table>
		</div>`;
	return panel;
}

// ── Payout wallet ────────────────────────────────────────────────────────────

function renderPayoutPanel(host) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	panel.dataset.panel = 'payout';
	const w = STATE.wallet || {};
	const evm = w.evm_address || '';
	const sol = w.solana_address || '';
	const preferred = w.preferred_network || 'solana';

	panel.innerHTML = `
		<div class="cs-panel-head">
			<div>
				<div class="dn-panel-title">Payout wallet</div>
				<div class="dn-panel-sub">Where your settled USDC lands. You control these wallets.</div>
			</div>
		</div>
		<div class="cs-form-grid">
			<label class="cs-field">
				<span class="cs-label">Solana address</span>
				<input data-f="sol" type="text" class="cs-input cs-mono" value="${esc(sol)}" placeholder="Base58 address…" />
				<span class="cs-hint" data-h="sol"></span>
			</label>
			<label class="cs-field">
				<span class="cs-label">EVM address (Base)</span>
				<input data-f="evm" type="text" class="cs-input cs-mono" value="${esc(evm)}" placeholder="0x…" />
				<span class="cs-hint" data-h="evm"></span>
			</label>
		</div>
		<div class="cs-payout-row">
			<label class="cs-field" style="margin:0;flex:1;min-width:160px">
				<span class="cs-label">Preferred network</span>
				<select data-f="net" class="cs-input">
					<option value="solana"${preferred === 'solana' ? ' selected' : ''}>Solana</option>
					<option value="base"${preferred === 'base' ? ' selected' : ''}>Base (EVM)</option>
				</select>
			</label>
			<button class="dn-btn primary" data-action="save">Save payout wallet</button>
		</div>
		<div class="cs-error" data-slot="err"></div>`;

	const solEl = panel.querySelector('[data-f="sol"]');
	const evmEl = panel.querySelector('[data-f="evm"]');
	const netEl = panel.querySelector('[data-f="net"]');
	const errEl = panel.querySelector('[data-slot="err"]');
	const solHint = panel.querySelector('[data-h="sol"]');
	const evmHint = panel.querySelector('[data-h="evm"]');

	solEl.addEventListener('input', () => { const v = solEl.value.trim(); solHint.textContent = v && !SOLANA_ADDR_RE.test(v) ? 'Invalid Solana address' : ''; });
	evmEl.addEventListener('input', () => { const v = evmEl.value.trim(); evmHint.textContent = v && !EVM_ADDR_RE.test(v) ? 'Invalid EVM address' : ''; });

	panel.querySelector('[data-action="save"]').addEventListener('click', async () => {
		errEl.textContent = '';
		const solV = solEl.value.trim();
		const evmV = evmEl.value.trim();
		if (solV && !SOLANA_ADDR_RE.test(solV)) { errEl.textContent = 'Invalid Solana address.'; return; }
		if (evmV && !EVM_ADDR_RE.test(evmV)) { errEl.textContent = 'Invalid EVM address.'; return; }
		if (!solV && !evmV) { errEl.textContent = 'Enter at least one wallet address.'; return; }
		const btn = panel.querySelector('[data-action="save"]');
		btn.disabled = true; btn.textContent = 'Saving…';
		try {
			await put('/api/monetization/wallet', {
				agent_id: STATE.agentId,
				solana_address: solV || undefined,
				evm_address: evmV || undefined,
				preferred_network: netEl.value,
			});
			trackFunnelStep('creator', ANALYTICS_EVENTS.CREATOR_PAYOUT_CONFIGURED, { agent_id: STATE.agentId, network: netEl.value });
			toast('Payout wallet saved');
			await reloadAgentPricing(host);
		} catch (err) {
			errEl.textContent = err?.body?.error_description || err?.message || 'Save failed';
			btn.disabled = false; btn.textContent = 'Save payout wallet';
		}
	});
	return panel;
}

// ── Royalty ledger (pending / settling / settled) ────────────────────────────

function renderRoyaltyLedger() {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	const entries = STATE.earnings?.entries || [];
	const { totals } = groupLedgerByStatus(entries);

	panel.innerHTML = `
		<div class="cs-panel-head">
			<div>
				<div class="dn-panel-title">Royalty ledger</div>
				<div class="dn-panel-sub">Every sale, from pending to on-chain settled. This is your real money trail.</div>
			</div>
			${entries.length ? `<button class="dn-btn" data-action="export">Export CSV</button>` : ''}
		</div>
		<div class="cs-ledger-totals">
			${ledgerTotal('Pending', totals.pending, 'warn')}
			${ledgerTotal('Settling', totals.settling, 'accent')}
			${ledgerTotal('Settled', totals.settled, 'good')}
			${totals.failed > 0 ? ledgerTotal('Failed', totals.failed, 'bad') : ''}
		</div>
		<div data-slot="body"></div>`;

	const body = panel.querySelector('[data-slot="body"]');
	if (!entries.length) {
		body.innerHTML = `<div class="dn-empty"><h3>No royalties yet</h3><p>When buyers pay for your skills, each sale appears here and settles to your wallet automatically.</p></div>`;
	} else {
		const sorted = entries.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 100);
		body.innerHTML = `
			<div style="overflow-x:auto">
				<table class="cs-table">
					<thead><tr><th scope="col">When</th><th scope="col">Skill</th><th scope="col">Rail</th><th scope="col">Agent</th><th scope="col" style="text-align:right">Amount</th><th scope="col">Status</th></tr></thead>
					<tbody>${sorted.map(ledgerRow).join('')}</tbody>
				</table>
			</div>
			${entries.length > 100 ? `<div class="cs-ledger-more">Showing latest 100 of ${entries.length}. Export CSV for the full history.</div>` : ''}`;
	}

	panel.querySelector('[data-action="export"]')?.addEventListener('click', () => {
		const csv = ledgerToCsv(entries, { networkLabel });
		downloadCsv(csv, `creator-royalties-${STATE.agentId?.slice(0, 8) || 'all'}.csv`);
		toast('Royalty history exported');
	});
	return panel;
}

function ledgerTotal(label, usdVal, accent) {
	const color = accent === 'good' ? 'var(--nxt-success)' : accent === 'warn' ? 'var(--nxt-warn)' : accent === 'bad' ? 'var(--nxt-danger)' : 'var(--nxt-accent-strong)';
	return `<div class="cs-ledger-total"><span class="cs-fig-label">${esc(label)}</span><span class="cs-fig-value" style="color:${color}">${usd(usdVal)}</span></div>`;
}

function ledgerRow(e) {
	const tag = {
		settled: '<span class="cs-tag good">Settled</span>',
		settling: '<span class="cs-tag accent">Settling</span>',
		failed: '<span class="cs-tag bad">Failed</span>',
	}[e.status] || '<span class="cs-tag warn">Pending</span>';
	// Per-call x402 rows carry the settlement transaction, so the amount links
	// straight to the explorer: the author can verify their own payout on-chain
	// instead of trusting this table. Rows with no tx (in-app calls awaiting the
	// redeem leg) render the plain amount.
	// Both a transaction AND its chain are required: revenueTxUrl falls back to
	// the platform default chain for an unknown network, so linking a tx whose
	// chain we do not know would point an EVM settlement at a Solana explorer.
	const txUrl = e.tx_hash && e.network ? revenueTxUrl(e.tx_hash, e.network) : null;
	const amount = usd(Number(e.price_usd || 0));
	const amountCell = txUrl
		? `<a href="${esc(txUrl)}" target="_blank" rel="noopener" title="View this settlement on the explorer">${amount}</a>`
		: amount;
	const chain = e.network ? networkLabel(e.network) : '';
	return `
		<tr>
			<td style="white-space:nowrap;color:var(--nxt-ink-dim)">${esc(relTime(e.created_at))}</td>
			<td>${esc(e.skill_name || e.kind || '(removed)')}</td>
			<td style="color:var(--nxt-ink-dim)">${esc(railLabel(e.source))}${chain ? ` · ${esc(chain)}` : ''}</td>
			<td style="color:var(--nxt-ink-dim)">${esc(e.agent_name || 'Direct call')}</td>
			<td style="text-align:right">${amountCell}</td>
			<td>${tag}</td>
		</tr>`;
}

// ── Withdrawals ──────────────────────────────────────────────────────────────

function renderWithdrawals(host) {
	const panel = document.createElement('div');
	panel.className = 'dn-panel';
	const ws = STATE.withdrawals || [];
	const available = Number(STATE.balance?.available_usdc || 0);

	panel.innerHTML = `
		<div class="cs-panel-head">
			<div>
				<div class="dn-panel-title">Withdrawals</div>
				<div class="dn-panel-sub">Move settled USDC to your payout wallet. Minimum $1.00.</div>
			</div>
			<button class="dn-btn primary" data-action="withdraw"${available < 1 ? ' disabled title="Minimum withdrawal is $1.00"' : ''}>Withdraw ${usd(available)}</button>
		</div>
		<div data-slot="body"></div>`;

	const body = panel.querySelector('[data-slot="body"]');
	if (!ws.length) {
		body.innerHTML = `<div class="cs-withdraw-empty">No withdrawals yet. Your available balance is <strong>${usd(available)}</strong>.</div>`;
	} else {
		body.innerHTML = `
			<div style="overflow-x:auto">
				<table class="cs-table">
					<thead><tr><th scope="col">Requested</th><th scope="col">Chain</th><th scope="col" style="text-align:right">Amount</th><th scope="col">Status</th><th scope="col">Tx</th></tr></thead>
					<tbody>${ws.map(withdrawalRow).join('')}</tbody>
				</table>
			</div>`;
	}

	panel.querySelector('[data-action="withdraw"]').addEventListener('click', () => openWithdrawModal(available, host));
	return panel;
}

function withdrawalRow(w) {
	const tag = {
		completed: '<span class="cs-tag good">Completed</span>',
		processing: '<span class="cs-tag accent">Processing</span>',
		failed: '<span class="cs-tag bad">Failed</span>',
	}[w.status] || '<span class="cs-tag warn">Pending</span>';
	let tx = '<span style="color:var(--nxt-ink-fade)">—</span>';
	if (w.tx_hash) {
		const url = w.chain === 'base' ? `https://basescan.org/tx/${encodeURIComponent(w.tx_hash)}` : `https://solscan.io/tx/${encodeURIComponent(w.tx_hash)}`;
		tx = `<a href="${url}" target="_blank" rel="noopener" class="cs-link">view</a>`;
	}
	return `
		<tr>
			<td style="white-space:nowrap;color:var(--nxt-ink-dim)">${esc(relTime(w.requested_at))}</td>
			<td style="color:var(--nxt-ink-dim)">${esc(w.chain || '—')}</td>
			<td style="text-align:right">${usd(Number(w.amount_usdc || 0))}</td>
			<td>${tag}</td>
			<td>${tx}</td>
		</tr>`;
}

function openWithdrawModal(available, host) {
	const overlay = modal(`
		<div class="cs-modal-title">Withdraw earnings</div>
		<div class="dn-panel-sub" style="margin-bottom:14px">Available now: <strong>${usd(available)}</strong>. Funds go to your configured payout wallet.</div>
		<label class="cs-field">
			<span class="cs-label">Amount (USDC)</span>
			<input data-f="amt" type="number" min="1" step="0.01" class="cs-input" value="${available >= 1 ? available.toFixed(2) : ''}" placeholder="${available.toFixed(2)}" />
			<span class="cs-hint">Leave blank to withdraw everything available.</span>
		</label>
		<div class="cs-error" data-slot="err"></div>
		<div class="cs-modal-actions">
			<button class="dn-btn ghost" data-action="cancel">Cancel</button>
			<button class="dn-btn primary" data-action="go">Withdraw</button>
		</div>
	`);
	const amtEl = overlay.querySelector('[data-f="amt"]');
	const errEl = overlay.querySelector('[data-slot="err"]');
	overlay.querySelector('[data-action="go"]').addEventListener('click', async () => {
		errEl.textContent = '';
		const raw = amtEl.value.trim();
		let amount = raw === '' ? null : Number(raw);
		if (amount !== null && (!Number.isFinite(amount) || amount < 1)) { errEl.textContent = 'Minimum withdrawal is $1.00.'; return; }
		if (amount !== null && amount > available) { errEl.textContent = `You can withdraw at most ${usd(available)}.`; return; }
		const btn = overlay.querySelector('[data-action="go"]');
		btn.disabled = true; btn.textContent = 'Requesting…';
		try {
			await post('/api/monetization/withdrawals', { agent_id: STATE.agentId, amount_usdc: amount });
			overlay.close();
			toast('Withdrawal requested');
			await reloadAgentPricing(host);
		} catch (err) {
			errEl.textContent = err?.body?.error_description || err?.message || 'Withdrawal failed';
			btn.disabled = false; btn.textContent = 'Withdraw';
		}
	});
}

// ── Shared helpers ───────────────────────────────────────────────────────────

async function reloadAgentPricing(host) {
	renderSkeleton(host);
	await loadAndRender(host);
}

// Shown to an author who earns skill royalties but has no agent yet: their
// money first, the upsell second. The rest of Creator Studio (pricing rules,
// payouts, per-agent analytics) genuinely needs an agent, so it stays behind
// the link rather than rendering half-empty panels.
function renderAuthorOnlyIntro() {
	const el = document.createElement('div');
	el.className = 'dn-panel';
	const { totals } = groupLedgerByStatus(STATE.earnings?.entries || []);
	const earned = totals.pending + totals.settling + totals.settled;
	el.innerHTML = `
		<div class="dn-panel-title">You're earning skill royalties</div>
		<div class="dn-panel-sub">
			You've earned ${esc(usd(earned))} from calls to skills you published to the marketplace.
			Every paid call routes your share straight to your wallet.
			Create an agent to unlock pricing rules, payouts, and per-skill analytics.
		</div>
		<a class="dn-btn primary" href="/dashboard/agents" style="margin-top:14px">Create an agent</a>`;
	return el;
}

function renderNoAgents() {
	const el = document.createElement('div');
	el.className = 'dn-panel';
	el.innerHTML = `
		<div class="dn-empty">
			<h3>Create an agent to start earning</h3>
			<p>Creator Studio is where your agents make money. Spin one up, price a skill, and watch the revenue land.</p>
			<a class="dn-btn primary" href="/dashboard/agents" style="margin-top:14px">Create an agent</a>
		</div>`;
	return el;
}

function saleCountForSkill(skill) {
	// Confirmed-sale count drives first_n / after_n rule evaluation. It comes
	// from the real per-skill call ledger behind /api/creators/skill-analytics.
	const row = (STATE.analytics?.by_skill || []).find((s) => s.skill_name === skill);
	return Number(row?.total_calls || 0);
}

function usd(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return '$0.00';
	const decimals = v !== 0 && Math.abs(v) < 0.01 ? 6 : Math.abs(v) < 1 ? 4 : 2;
	return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: decimals })}`;
}

function rate(pct) {
	const v = Number(pct);
	if (!Number.isFinite(v)) return '—';
	const color = v >= 95 ? 'var(--nxt-success)' : v >= 80 ? 'var(--nxt-warn)' : 'var(--nxt-danger)';
	return `<span style="color:${color}">${v.toFixed(0)}%</span>`;
}

function shortDate(s) {
	const d = new Date(s);
	if (isNaN(d)) return String(s).slice(5, 10);
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function downloadCsv(csv, filename) {
	const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url; a.download = filename;
	document.body.appendChild(a); a.click(); a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function modal(innerHTML) {
	const prevFocus = document.activeElement;
	const overlay = document.createElement('div');
	overlay.className = 'cs-overlay';
	overlay.innerHTML = `<div role="dialog" aria-modal="true" class="cs-modal">${innerHTML}</div>`;
	document.body.appendChild(overlay);
	const dialog = overlay.querySelector('.cs-modal');

	// Label the dialog by its own heading so screen readers announce it on open.
	const titleEl = dialog.querySelector('.cs-modal-title');
	if (titleEl) {
		if (!titleEl.id) titleEl.id = `cs-modal-title-${Math.random().toString(36).slice(2, 8)}`;
		dialog.setAttribute('aria-labelledby', titleEl.id);
	}

	const close = () => {
		overlay.remove();
		document.removeEventListener('keydown', onKey);
		if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
	};
	const onKey = (e) => {
		if (e.key === 'Escape') { close(); return; }
		if (e.key === 'Tab') trapTab(e, dialog);
	};
	document.addEventListener('keydown', onKey);
	overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
	overlay.querySelectorAll('[data-action="cancel"]').forEach((b) => b.addEventListener('click', close));
	overlay.close = close;
	const focusable = dialog.querySelector('input,select,button,textarea');
	focusable?.focus();
	return overlay;
}

// Keep keyboard focus inside an open dialog (WAI-ARIA modal pattern).
function trapTab(e, container) {
	const nodes = [...container.querySelectorAll(
		'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
	)].filter((el) => el.offsetParent !== null);
	if (!nodes.length) return;
	const first = nodes[0];
	const last = nodes[nodes.length - 1];
	if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
	else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

let toastTimer = null;
function toast(msg, isError = false) {
	let host = document.querySelector('.cs-toast');
	if (!host) {
		host = document.createElement('div');
		host.className = 'cs-toast';
		host.setAttribute('role', 'status');
		host.setAttribute('aria-live', 'polite');
		document.body.appendChild(host);
	}
	host.textContent = msg;
	host.style.borderColor = isError ? 'var(--nxt-danger)' : 'var(--nxt-stroke-strong)';
	host.classList.add('show');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => host.classList.remove('show'), 2600);
}

function renderSkeleton(host) {
	host.innerHTML = `
		<div class="cs-hero">${Array.from({ length: 5 }, () => `<div class="dn-panel cs-hero-card"><div class="dn-skeleton" style="height:14px;width:60%;border-radius:6px"></div><div class="dn-skeleton" style="height:28px;width:80%;border-radius:6px;margin:10px 0"></div><div class="dn-skeleton" style="height:12px;width:70%;border-radius:6px"></div></div>`).join('')}</div>
		<div class="dn-panel"><div class="dn-skeleton" style="height:220px;width:100%;border-radius:10px"></div></div>
		<div class="dn-panel"><div class="dn-skeleton" style="height:140px;width:100%;border-radius:10px"></div></div>`;
}

// ── Styles ───────────────────────────────────────────────────────────────────

let stylesInjected = false;
function injectStyles() {
	if (stylesInjected) return;
	stylesInjected = true;
	const css = `
		.cs-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:8px}
		.cs-head-controls{display:flex;gap:10px;flex-wrap:wrap}
		.cs-content{display:flex;flex-direction:column;gap:18px}
		.cs-select,.cs-input{background:var(--nxt-bg-1);border:1px solid var(--nxt-stroke);color:var(--nxt-ink);border-radius:var(--nxt-radius-sm,10px);padding:9px 12px;font-size:13.5px;font-family:inherit}
		.cs-select:focus,.cs-input:focus{outline:none;border-color:var(--nxt-stroke-strong);box-shadow:0 0 0 3px var(--nxt-accent-soft)}
		.cs-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
		.cs-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}
		.cs-summary{font-size:12.5px;color:var(--nxt-ink-dim);font-variant-numeric:tabular-nums}
		.cs-hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px}
		.cs-hero-card{display:flex;flex-direction:column;gap:4px}
		.cs-hero-value{font-size:26px;font-weight:700;letter-spacing:-0.02em;font-variant-numeric:tabular-nums;margin:4px 0 2px}
		.cs-chart{position:relative;width:100%;height:240px}
		/* Onboarding */
		.cs-onboard-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
		.cs-onboard-progress{font-size:12.5px;color:var(--nxt-ink-dim)}
		.cs-onboard-done{display:flex;align-items:center;gap:14px}
		.cs-onboard-badge{width:40px;height:40px;border-radius:50%;background:rgba(74,222,128,0.15);color:var(--nxt-success);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
		.cs-steps{display:flex;flex-direction:column;gap:10px}
		.cs-step{display:flex;align-items:center;gap:14px;padding:12px 14px;border:1px solid var(--nxt-stroke);border-radius:var(--nxt-radius-sm,10px);transition:border-color .2s,background .2s}
		.cs-step.active{border-color:var(--nxt-stroke-strong);background:var(--nxt-accent-soft)}
		.cs-step.done{opacity:0.72}
		.cs-step-num{width:26px;height:26px;border-radius:50%;background:var(--nxt-bg-1);border:1px solid var(--nxt-stroke);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;flex-shrink:0}
		.cs-step.done .cs-step-num{background:rgba(74,222,128,0.15);color:var(--nxt-success);border-color:transparent}
		.cs-step-body{flex:1;min-width:0}
		.cs-step-title{font-weight:600;font-size:14px}
		.cs-step-sub{font-size:12.5px;color:var(--nxt-ink-dim);margin-top:2px}
		/* Price cards */
		.cs-price-card{border:1px solid var(--nxt-stroke);border-radius:var(--nxt-radius-sm,10px);padding:14px;margin-bottom:12px}
		.cs-price-card:last-child{margin-bottom:0}
		.cs-price-top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}
		.cs-price-name{font-weight:600;font-size:14.5px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
		.cs-price-actions{display:flex;gap:6px;flex-wrap:wrap}
		.cs-price-figures{display:flex;gap:24px;flex-wrap:wrap;margin-bottom:12px}
		.cs-fig-label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--nxt-ink-fade)}
		.cs-fig-value{display:block;font-size:18px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:2px}
		.cs-ladder{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}
		.cs-ladder-cell{background:var(--nxt-bg-1);border:1px solid var(--nxt-stroke);border-radius:8px;padding:8px 6px;text-align:center;display:flex;flex-direction:column;gap:2px}
		.cs-ladder-tier{font-size:10.5px;text-transform:uppercase;letter-spacing:0.04em;color:var(--nxt-ink-fade)}
		.cs-ladder-price{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}
		.cs-ladder-disc{font-size:10.5px;color:var(--nxt-ink-dim)}
		.cs-ladder-preview{margin:12px 0}
		.cs-ladder-note{font-size:12px;color:var(--nxt-ink-dim);margin-bottom:8px}
		/* Ledger */
		.cs-ledger-totals{display:flex;gap:28px;flex-wrap:wrap;margin-bottom:16px}
		.cs-ledger-total{display:flex;flex-direction:column}
		.cs-ledger-more,.cs-withdraw-empty,.cs-rule-empty{font-size:13px;color:var(--nxt-ink-dim);padding:12px 0}
		/* Table */
		.cs-table{width:100%;border-collapse:collapse;font-size:13px}
		.cs-table th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--nxt-ink-fade);font-weight:600;padding:0 12px 10px;border-bottom:1px solid var(--nxt-stroke)}
		.cs-table td{padding:11px 12px;border-bottom:1px solid var(--nxt-stroke);vertical-align:middle}
		.cs-table tbody tr:last-child td{border-bottom:none}
		.cs-table tbody tr:hover{background:var(--nxt-accent-soft)}
		/* Tags */
		.cs-tag{display:inline-block;padding:2px 8px;border-radius:var(--nxt-radius-pill,999px);font-size:11px;font-weight:600;border:1px solid var(--nxt-stroke)}
		.cs-tag.good{color:var(--nxt-success);background:rgba(74,222,128,0.12);border-color:transparent}
		.cs-tag.warn{color:var(--nxt-warn);background:rgba(255,165,0,0.12);border-color:transparent}
		.cs-tag.accent{color:var(--nxt-accent-strong);background:var(--nxt-accent-soft);border-color:transparent}
		.cs-tag.bad{color:var(--nxt-danger);background:rgba(255,0,0,0.1);border-color:transparent}
		.cs-tag.muted{color:var(--nxt-ink-fade)}
		.cs-link{color:var(--nxt-accent-strong);font-size:12px}
		.cs-btn-xs{padding:4px 9px;font-size:11.5px}
		/* Forms */
		.cs-form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
		.cs-field{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
		.cs-label{font-size:12.5px;color:var(--nxt-ink-dim);font-weight:500}
		.cs-hint{font-size:11.5px;color:var(--nxt-warn);min-height:14px}
		.cs-check{display:flex;align-items:center;gap:10px;font-size:13px;cursor:pointer;margin-bottom:14px}
		.cs-check input{width:16px;height:16px;accent-color:var(--nxt-accent-strong)}
		.cs-payout-row{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap;margin-top:6px}
		.cs-error{color:var(--nxt-danger);font-size:12.5px;min-height:16px;margin:6px 0}
		/* Modal */
		.cs-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:1000;padding:20px}
		.cs-modal{background:var(--nxt-bg-1);border:1px solid var(--nxt-stroke-strong);border-radius:var(--nxt-radius,14px);padding:24px;width:100%;max-width:520px;max-height:88vh;overflow-y:auto}
		.cs-modal-title{font-size:17px;font-weight:600;margin-bottom:16px}
		.cs-modal-subtitle{font-size:13px;font-weight:600;margin-bottom:10px}
		.cs-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}
		.cs-rule-form{border-top:1px solid var(--nxt-stroke);margin-top:16px;padding-top:16px}
		.cs-rule-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
		/* Toast */
		.cs-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);background:var(--nxt-bg-1);border:1px solid var(--nxt-stroke-strong);color:var(--nxt-ink);padding:12px 20px;border-radius:var(--nxt-radius-sm,10px);font-size:13.5px;z-index:1100;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;box-shadow:0 8px 30px rgba(0,0,0,0.4)}
		.cs-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
		.cs-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
			.cs-price-card{transition:border-color .15s ease}
			.cs-price-card:hover{border-color:var(--nxt-stroke-strong)}
			.cs-ladder-cell{transition:border-color .15s ease,background .15s ease}
			.cs-ladder-cell:hover{border-color:var(--nxt-stroke-strong)}
			@media(max-width:640px){.cs-ladder{grid-template-columns:repeat(2,1fr)}.cs-price-figures{gap:16px}}
			@media(prefers-reduced-motion:reduce){.cs-step,.cs-toast,.cs-price-card,.cs-ladder-cell{transition:none}}
	`;
	const style = document.createElement('style');
	style.textContent = css;
	document.head.appendChild(style);
}
