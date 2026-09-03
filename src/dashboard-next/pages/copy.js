// dashboard-next — Copy Trading.
//
// The copier's command center for non-custodial copy trading:
//   1. Intents inbox  — pending copies (leader traded → sized order to act on).
//   2. Your copies    — active/paused subscriptions, with pause/resume/stop + edit link.
//   3. History        — acted / dismissed / skipped / expired intents.
// Every number is real, from /api/copy/*. The copier executes each trade from
// their own wallet; we never take custody.

import { mountShell } from '../shell.js';
import { requireUser, get, post, del, esc, relTime } from '../api.js';
import { errorStateHTML, ensureStateKitStyles, attachRetry } from '../../shared/state-kit.js';
import { gmgnAddressUrl } from '../../shared/trading-terminals.js';
import { mountAlphaDripPanel, formatDelay } from '../../alpha-drip-panel.js';

const SKIP_LABEL = {
	below_mcap_floor: 'Below your market-cap floor',
	above_mcap_ceiling: 'Above your market-cap ceiling',
	dev_heavy: 'Dev holds too much supply',
	low_liquidity: 'Liquidity too thin',
	honeypot: 'Flagged as a honeypot',
	safety_unknown: 'Coin safety unconfirmed',
	below_oracle_threshold: 'Oracle conviction too low',
	below_min_order: 'Sized below your minimum',
	daily_budget_spent: 'Daily budget used up',
	max_open_copies: 'Open-copies cap reached',
	sizing_unavailable: 'Could not size (no balance)',
	drip_capacity_cap: 'Your tier\'s size cap left the order below your minimum',
};

const fmtSol = (n) => {
	const v = Number(n) || 0;
	return `${v.toFixed(v >= 1 ? 2 : 3)} ◎`;
};
const sizingLabel = (s) =>
	s.sizing_rule === 'fixed' ? `${Number(s.fixed_sol)} SOL fixed`
	: s.sizing_rule === 'multiplier' ? `${Number(s.multiplier)}× leader`
	: `${Number(s.pct_balance)}% of wallet`;

function pumpUrl(mint) { return `https://pump.fun/coin/${encodeURIComponent(mint)}`; }

const STYLE = `
<style>
.cp-wrap { display: grid; gap: 20px; }
.cp-sec { border: 1px solid var(--nxt-stroke); background: var(--nxt-bg-2); border-radius: var(--nxt-radius); padding: 18px; }
.cp-sec-h { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.cp-sec-h h2 { font-size: 16px; margin: 0; }
.cp-sec-h .cp-count { font-size: 12px; color: var(--nxt-ink-dim); font-variant-numeric: tabular-nums; }
.cp-empty { color: var(--nxt-ink-dim); font-size: 13px; padding: 18px 0; text-align: center; }
.cp-item { display: grid; grid-template-columns: 36px 1fr auto; gap: 12px; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--nxt-stroke); }
.cp-item:last-child { border-bottom: 0; }
.cp-av { width: 36px; height: 36px; border-radius: 9px; object-fit: cover; background: var(--nxt-bg-2); border: 1px solid var(--nxt-stroke); }
.cp-mid { min-width: 0; }
.cp-title { font-weight: 600; font-size: 14px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.cp-sub { font-size: 12px; color: var(--nxt-ink-dim); margin-top: 2px; }
.cp-sub a { color: var(--nxt-ink-dim); text-decoration: none; border-bottom: 1px dotted var(--nxt-stroke-strong); }
.cp-sub a:hover { color: var(--nxt-ink); }
.cp-side { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.cp-amt { font-variant-numeric: tabular-nums; font-weight: 700; font-size: 15px; }
.cp-tag { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--nxt-stroke); color: var(--nxt-ink-dim); }
.cp-tag.buy { color: var(--nxt-success); border-color: color-mix(in srgb, var(--nxt-success) 40%, transparent); }
.cp-tag.sell { color: var(--nxt-warn); border-color: color-mix(in srgb, var(--nxt-warn) 40%, transparent); }
.cp-tag.on { color: var(--nxt-success); }
.cp-tag.paused { color: var(--nxt-warn); }
.cp-tripped { color: var(--nxt-warn); margin-top: 4px; line-height: 1.45; }
.cp-sub-err { color: var(--nxt-danger); margin-top: 4px; line-height: 1.45; }
.cp-tag.skipped, .cp-tag.expired, .cp-tag.dismissed { color: var(--nxt-ink-dim); }
.cp-tag.acted { color: var(--nxt-success); }
.cp-btn { font-size: 12px; padding: 5px 12px; border-radius: var(--nxt-radius-sm); border: 1px solid var(--nxt-stroke); background: var(--nxt-bg-2); color: var(--nxt-ink); cursor: pointer; text-decoration: none; transition: border-color .14s, transform .14s; white-space: nowrap; }
.cp-btn:hover { border-color: var(--nxt-stroke-strong); transform: translateY(-1px); }
.cp-btn.primary { background: var(--nxt-accent); color: #061018; border-color: transparent; }
.cp-btn.ghost { background: transparent; }
.cp-skeleton { height: 56px; border-radius: 10px; background: var(--nxt-bg-2); animation: cp-pulse 1.4s ease infinite; }
@keyframes cp-pulse { 0%,100% { opacity: .55 } 50% { opacity: 1 } }
.cp-note { font-size: 12px; color: var(--nxt-ink-dim); margin: 0 0 14px; }
.cp-locked { opacity: .92; }
.cp-lock-coin { letter-spacing: .18em; color: var(--nxt-ink-dim); font-weight: 700; }
.cp-countdown { font-variant-numeric: tabular-nums; color: var(--nxt-ink-dim); transition: color .2s ease; }
.cp-locked:hover .cp-countdown { color: var(--nxt-ink); }
.cp-oracle { display: inline-flex; }
.cp-ob { display: inline-flex; align-items: center; gap: 3px; background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 2px 7px; text-decoration: none; font-size: 11px; transition: border-color .12s; }
.cp-ob:hover { border-color: rgba(255,255,255,0.22); }
.cp-ob-score { font-weight: 700; font-variant-numeric: tabular-nums; }
.cp-ob-tier { font-size: 8.5px; text-transform: uppercase; letter-spacing: .06em; opacity: .8; }
.cp-stats { display: flex; gap: 2px; margin-bottom: 16px; border-radius: var(--nxt-radius); overflow: hidden; border: 1px solid var(--nxt-stroke); }
.cp-stat { flex: 1; display: flex; flex-direction: column; align-items: center; padding: 10px 8px; background: var(--nxt-bg-2); gap: 2px; }
.cp-stat-val { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
.cp-stat-lbl { font-size: 11px; color: var(--nxt-ink-dim); white-space: nowrap; }
.cp-stat-detail { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; background: var(--nxt-stroke); border-radius: 50%; font-size: 9px; color: var(--nxt-ink-dim); cursor: help; }
.cp-stat-sol .cp-stat-val { color: var(--nxt-accent); }
.cp-hint { display: block; font-size: var(--text-2xs, 11px); color: var(--nxt-ink-dim); margin-top: 4px; line-height: 1.4; }

/* smart money directory */
.sm-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 14px; }
.sm-chips { display: inline-flex; gap: 4px; flex-wrap: wrap; }
.sm-chip { font-size: 12px; padding: 4px 11px; border-radius: 999px; border: 1px solid var(--nxt-stroke); background: var(--nxt-bg-2); color: var(--nxt-ink-dim); cursor: pointer; transition: border-color .14s, color .14s, background .14s; white-space: nowrap; }
.sm-chip:hover { border-color: var(--nxt-stroke-strong); color: var(--nxt-ink); }
.sm-chip.is-active { background: var(--nxt-accent); color: #061018; border-color: transparent; }
.sm-spacer { flex: 1 1 auto; }
.sm-search { font-size: 12px; padding: 5px 10px; border-radius: var(--nxt-radius-sm); border: 1px solid var(--nxt-stroke); background: var(--nxt-bg-2); color: var(--nxt-ink); min-width: 150px; }
.sm-search:focus { outline: none; border-color: var(--nxt-accent); }
.sm-sort { font-size: 12px; padding: 5px 8px; border-radius: var(--nxt-radius-sm); border: 1px solid var(--nxt-stroke); background: var(--nxt-bg-2); color: var(--nxt-ink); cursor: pointer; }
.sm-item { display: grid; grid-template-columns: 38px 1fr auto; gap: 12px; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--nxt-stroke); }
.sm-item:last-child { border-bottom: 0; }
.sm-av { width: 38px; height: 38px; border-radius: 10px; object-fit: cover; background: var(--nxt-bg-2); border: 1px solid var(--nxt-stroke); display: grid; place-items: center; font-weight: 700; font-size: 14px; color: var(--nxt-ink-dim); overflow: hidden; }
.sm-av img { width: 100%; height: 100%; object-fit: cover; }
.sm-mid { min-width: 0; }
.sm-name { font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.sm-name a { color: inherit; text-decoration: none; }
.sm-name a:hover { color: var(--nxt-accent); }
.sm-mono { font-variant-numeric: tabular-nums; font-feature-settings: "tnum"; }
.sm-tw { font-size: 12px; color: var(--nxt-ink-dim); text-decoration: none; }
.sm-tw:hover { color: var(--nxt-accent); }
.sm-tags { display: inline-flex; gap: 5px; flex-wrap: wrap; margin-top: 4px; }
.sm-tag { font-size: 10px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--nxt-stroke); color: var(--nxt-ink-dim); text-transform: capitalize; }
.sm-tag.smart_money { color: #34d399; border-color: color-mix(in srgb, #34d399 38%, transparent); }
.sm-tag.kol { color: #c084fc; border-color: color-mix(in srgb, #c084fc 38%, transparent); }
.sm-tag.launchpad { color: #60a5fa; border-color: color-mix(in srgb, #60a5fa 38%, transparent); }
.sm-tag.sniper { color: #fbbf24; border-color: color-mix(in srgb, #fbbf24 38%, transparent); }
.sm-tag.chain { color: var(--nxt-ink-dim); text-transform: uppercase; letter-spacing: .04em; }
.sm-stats { display: flex; gap: 16px; align-items: baseline; justify-content: flex-end; }
.sm-metric { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; }
.sm-metric-val { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
.sm-metric-val.pos { color: var(--nxt-success); }
.sm-metric-lbl { font-size: 10px; color: var(--nxt-ink-dim); text-transform: uppercase; letter-spacing: .04em; }
.sm-track { font-size: 12px; padding: 6px 13px; border-radius: var(--nxt-radius-sm); border: 1px solid var(--nxt-stroke); background: var(--nxt-bg-2); color: var(--nxt-ink); text-decoration: none; white-space: nowrap; transition: border-color .14s, transform .14s; }
.sm-track:hover { border-color: var(--nxt-stroke-strong); transform: translateY(-1px); }
.sm-more { display: flex; justify-content: center; margin-top: 14px; }
@media (max-width: 640px) { .sm-item { grid-template-columns: 38px 1fr; } .sm-stats { grid-column: 1 / -1; justify-content: flex-start; padding-left: 50px; } }

@media (max-width: 560px) { .cp-item { grid-template-columns: 1fr; } .cp-side { justify-content: flex-start; } .cp-av { display: none; } .cp-stats { flex-wrap: wrap; } .cp-stat { min-width: 45%; } }

/* Narrow: let the smart-money search claim its own row so controls never overflow */
@media (max-width: 520px) { .sm-search { flex: 1 1 100%; min-width: 0; } .sm-spacer { display: none; } }

/* Interaction states — pressed, disabled, and keyboard focus rings on every control */
.cp-btn:active, .sm-track:active { transform: translateY(0); }
.cp-btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }
.cp-btn:focus-visible, .sm-track:focus-visible, .sm-chip:focus-visible, .cp-ob:focus-visible,
.cp-sub a:focus-visible, .sm-name a:focus-visible, .sm-tw:focus-visible {
	outline: 2px solid var(--nxt-accent); outline-offset: 2px; border-radius: var(--nxt-radius-sm);
}
.sm-search:focus-visible, .sm-sort:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 1px; }
.cp-stat-detail:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 2px; }
.cp-sec { transition: border-color .16s ease; }
.cp-item { transition: opacity .2s ease; }

/* Honor reduced-motion: kill the skeleton pulse and hover lifts */
@media (prefers-reduced-motion: reduce) {
	.cp-skeleton { animation: none; }
	.cp-btn, .sm-track, .sm-chip, .cp-item { transition: none; }
	.cp-btn:hover, .sm-track:hover { transform: none; }
}
</style>`;

// One countdown interval for the whole page; a re-render replaces it rather
// than stacking a second ticker on the same rows.
let _countdownTimer = null;

function img(e) { return e.leader_image || e.leader_avatar || '/favicon.ico'; }
function traderHref(agentId) { return `/trader/${encodeURIComponent(agentId)}`; }

function intentRow(e) {
	if (e.locked) return lockedIntentRow(e);
	const isBuy = e.direction === 'buy';
	const amount = isBuy ? `<span class="cp-amt">${fmtSol(e.planned_sol)}</span>` : `<span class="cp-tag sell">Exit your copy</span>`;
	const proof = e.leader_buy_sig ? `<a href="https://solscan.io/tx/${esc(e.leader_buy_sig)}" target="_blank" rel="noopener">leader tx ↗</a>` : '';
	const mintAttr = e.mint ? ` data-oracle-mint="${esc(e.mint)}"` : '';
	return `
	<div class="cp-item" data-id="${esc(e.id)}"${mintAttr}>
		<img loading="lazy" decoding="async" class="cp-av" src="${esc(img(e))}" alt="" data-fallback="invisible" />
		<div class="cp-mid">
			<div class="cp-title">
				<span class="cp-tag ${isBuy ? 'buy' : 'sell'}">${isBuy ? 'BUY' : 'SELL'}</span>
				${esc(e.symbol || e.name || 'coin')}
				<span class="cp-oracle"></span>
				<span class="cp-sub" style="margin:0">via <a href="${traderHref(e.leader_agent_id)}">${esc(e.leader_name || 'trader')}</a></span>
			</div>
			<div class="cp-sub">${relTime(e.created_at)} · ${proof}</div>
		</div>
		<div class="cp-side">
			${amount}
			<a class="cp-btn primary" href="${pumpUrl(e.mint)}" target="_blank" rel="noopener" data-act="open" aria-label="${isBuy ? 'Buy' : 'Sell'} ${esc(e.symbol || 'coin')} on pump.fun (opens in a new tab)">${isBuy ? 'Buy now ↗' : 'Sell ↗'}</a>
			<button type="button" class="cp-btn" data-act="acted" aria-label="Mark ${esc(e.symbol || 'coin')} intent as copied">Mark copied</button>
			<button type="button" class="cp-btn ghost" data-act="dismissed" aria-label="Dismiss ${esc(e.symbol || 'coin')} intent">Dismiss</button>
		</div>
	</div>`;
}

/**
 * An intent this copier's $THREE tier has not reached yet. The leader and the
 * fact that they fired are shown — the coin and the size are not, because that
 * is precisely what the leader's release ladder sells. It unlocks in place: the
 * countdown reaches zero and the next poll renders the real row.
 */
function lockedIntentRow(e) {
	const tier = e.drip_tier ? e.drip_tier.charAt(0).toUpperCase() + e.drip_tier.slice(1) : null;
	const held = e.drip_delay_sec ? `held ${formatDelay(e.drip_delay_sec)} on this trader's ladder` : 'held on this trader\'s ladder';
	return `
	<div class="cp-item cp-locked" data-id="${esc(e.id)}" data-unlocks-at="${esc(e.unlocks_at || '')}">
		<img loading="lazy" decoding="async" class="cp-av" src="${esc(img(e))}" alt="" data-fallback="invisible" />
		<div class="cp-mid">
			<div class="cp-title">
				<span class="cp-tag">LOCKED</span>
				<span class="cp-lock-coin" aria-label="Coin hidden until release">•••••</span>
				<span class="cp-sub" style="margin:0">via <a href="${traderHref(e.leader_agent_id)}">${esc(e.leader_name || 'trader')}</a></span>
			</div>
			<div class="cp-sub">${tier ? `${esc(tier)} seat · ` : ''}${held} · <a href="/docs/alpha-drip">why?</a></div>
		</div>
		<div class="cp-side">
			<span class="cp-amt cp-countdown" data-countdown role="timer" aria-live="off">${esc(formatDelay(e.unlocks_in_sec || 0))}</span>
			<a class="cp-btn ghost" href="/three-token" aria-label="Hold more $THREE to unlock this trader's signal sooner">Unlock sooner</a>
		</div>
	</div>`;
}

/**
 * Tick every locked row's countdown, and reload the inbox the moment one hits
 * zero so the real intent replaces it without the copier touching anything.
 */
function startCountdowns(host, reload) {
	const timer = setInterval(() => {
		const rows = Array.from(host.querySelectorAll('.cp-locked[data-unlocks-at]'));
		if (!rows.length) { clearInterval(timer); return; }
		let due = false;
		for (const row of rows) {
			const at = Date.parse(row.dataset.unlocksAt || '');
			const left = Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : 0;
			const cell = row.querySelector('[data-countdown]');
			if (cell) cell.textContent = formatDelay(left);
			if (left <= 0) due = true;
		}
		if (due) { clearInterval(timer); reload(); }
	}, 1000);
	return timer;
}

function subRow(s) {
	const paused = s.status === 'paused';
	// A subscription the drawdown breaker paused was not paused by this user, so
	// the row has to say what happened — "Paused" alone reads as their own doing.
	const tripped = paused && s.paused_reason === 'leader_drawdown_breach';
	const ddLimit = s.max_drawdown_pct == null ? null : Number(s.max_drawdown_pct);
	return `
	<div class="cp-item" data-sub="${esc(s.id)}">
		<img loading="lazy" decoding="async" class="cp-av" src="${esc(img(s))}" alt="" data-fallback="invisible" />
		<div class="cp-mid">
			<div class="cp-title">
				<a href="${traderHref(s.leader_agent_id)}" style="color:inherit;text-decoration:none">${esc(s.leader_name || 'trader')}</a>
				<span class="cp-tag ${paused ? 'paused' : 'on'}">${tripped ? 'Auto-paused' : paused ? 'Paused' : '● Active'}</span>
			</div>
			<div class="cp-sub">${esc(sizingLabel(s))} · cap ${Number(s.per_trade_cap_sol)} ◎ · ${Number(s.daily_budget_sol)} ◎/day · ${Number(s.pending_count) || 0} pending${ddLimit ? ` · stop at ${ddLimit}% DD` : ''}${s.min_oracle_score != null ? ` · Oracle ≥${s.min_oracle_score}` : ''}${s.telegram_chat_id ? ' · TG alerts on' : ''}</div>
			${tripped ? `<div class="cp-sub cp-tripped">This trader fell past your ${ddLimit}% drawdown limit, so new copies stopped. Exits you're already in still arrive. Resume once they recover, or widen the limit on their profile.</div>` : ''}
			<div class="cp-sub cp-sub-err" data-sub-err hidden></div>
		</div>
		<div class="cp-side">
			<button type="button" class="cp-btn" data-sub-act="${paused ? 'active' : 'paused'}" aria-label="${paused ? 'Resume' : 'Pause'} copying ${esc(s.leader_name || 'trader')}">${paused ? 'Resume' : 'Pause'}</button>
			<a class="cp-btn ghost" href="${traderHref(s.leader_agent_id)}">Edit</a>
			<button type="button" class="cp-btn ghost" data-sub-act="stopped" aria-label="Stop copying ${esc(s.leader_name || 'trader')}">Stop</button>
		</div>
	</div>`;
}

function earningsSection(earnings) {
	const items = (earnings && earnings.items) || [];
	const owing = items.filter((i) => i.fee_sol > 0);
	if (!owing.length) return '';
	const total = Number(earnings.total_fee_owed_sol) || 0;
	const rows = owing.map((i) => `
		<div class="cp-item" data-earn-sub="${esc(i.subscription_id)}">
			<img loading="lazy" decoding="async" class="cp-av" src="${esc(i.leader_image || '/favicon.ico')}" alt="" data-fallback="invisible" />
			<div class="cp-mid">
				<div class="cp-title">${esc(i.leader_name || 'trader')}</div>
				<div class="cp-sub">${fmtSol(i.cumulative_profit_sol)} profit copied · ${(i.perf_fee_bps / 100).toFixed(0)}% fee</div>
			</div>
			<div class="cp-side">
				<span class="cp-amt">${fmtSol(i.fee_sol)}</span>
				<button class="cp-btn primary" data-settle="${esc(i.subscription_id)}" data-fee-usd="${esc(String(i.fee_usd || ''))}" aria-label="Settle performance fee">Settle in $THREE</button>
			</div>
		</div>`).join('');
	return `
		<section class="cp-sec" id="cp-earn">
			<div class="cp-sec-h"><h2>Performance fees owed</h2><span class="cp-count">${fmtSol(total)}</span></div>
			<p class="cp-note">Charged only on gains above your all-time peak. 80% goes to the trader, 15% to treasury, 5% to $THREE holders. Settlement ratchets your high-water mark so the same profit is never billed twice.</p>
			<div id="cp-earn-rows">${rows}</div>
			<div id="cp-earn-status" style="display:none;font-size:12px;color:var(--nxt-ink-dim);padding:10px 0"></div>
		</section>`;
}

function historyStats(hist) {
	if (!hist.length) return '';
	const acted = hist.filter((e) => e.status === 'acted');
	const skipped = hist.filter((e) => e.status === 'skipped');
	const dismissed = hist.filter((e) => e.status === 'dismissed');
	const solDeployed = acted.reduce((s, e) => s + (Number(e.planned_sol) || 0), 0);

	const skipReasons = {};
	for (const e of skipped) {
		const k = e.skip_reason || 'unknown';
		skipReasons[k] = (skipReasons[k] || 0) + 1;
	}
	const skipBreakdown = Object.entries(skipReasons)
		.sort((a, b) => b[1] - a[1])
		.map(([r, n]) => `${SKIP_LABEL[r] || r} (${n})`)
		.join(', ');

	return `
	<div class="cp-stats">
		<div class="cp-stat">
			<span class="cp-stat-val">${acted.length}</span>
			<span class="cp-stat-lbl">Acted</span>
		</div>
		<div class="cp-stat cp-stat-sol">
			<span class="cp-stat-val">${fmtSol(solDeployed)}</span>
			<span class="cp-stat-lbl">Deployed</span>
		</div>
		<div class="cp-stat">
			<span class="cp-stat-val">${skipped.length}</span>
			<span class="cp-stat-lbl">Skipped${skipped.length && skipBreakdown ? ` <span class="cp-stat-detail" tabindex="0" role="img" aria-label="Skip reasons: ${esc(skipBreakdown)}" title="${esc(skipBreakdown)}">?</span>` : ''}</span>
		</div>
		<div class="cp-stat">
			<span class="cp-stat-val">${dismissed.length}</span>
			<span class="cp-stat-lbl">Dismissed</span>
		</div>
	</div>`;
}

function historyRow(e) {
	const status = e.status;
	const label = status === 'skipped' ? (SKIP_LABEL[e.skip_reason] || 'Skipped') : status[0].toUpperCase() + status.slice(1);
	return `
	<div class="cp-item">
		<img loading="lazy" decoding="async" class="cp-av" src="${esc(img(e))}" alt="" data-fallback="invisible" />
		<div class="cp-mid">
			<div class="cp-title">${esc(e.symbol || e.name || 'coin')} <span class="cp-sub" style="margin:0">via ${esc(e.leader_name || 'trader')}</span></div>
			<div class="cp-sub">${relTime(e.created_at)} · ${e.direction === 'buy' && e.planned_sol ? fmtSol(e.planned_sol) : e.direction}</div>
		</div>
		<div class="cp-side"><span class="cp-tag ${status}">${esc(label)}</span></div>
	</div>`;
}

const CP_TIER_COLOR = { prime: '#c084fc', strong: '#34d399', lean: '#fbbf24', watch: '#94a3b8', avoid: '#f87171' };

async function enrichIntentOracle(container) {
	if (!container) return;
	const rows = container.querySelectorAll('[data-oracle-mint]');
	if (!rows.length) return;
	const mints = [...new Set([...rows].map((r) => r.dataset.oracleMint).filter(Boolean))];
	if (!mints.length) return;
	try {
		const r = await fetch(`/api/oracle/batch?mints=${mints.map(encodeURIComponent).join(',')}&network=mainnet`);
		if (!r.ok) return;
		const { results = {} } = await r.json();
		for (const row of rows) {
			const mint = row.dataset.oracleMint;
			const d = results[mint];
			if (!d || d.score == null) continue;
			const badge = row.querySelector('.cp-oracle');
			if (!badge || badge.hasChildNodes()) continue;
			const color = CP_TIER_COLOR[d.tier] || '#94a3b8';
			badge.innerHTML = `<a class="cp-ob" href="/oracle/coin/${encodeURIComponent(mint)}" title="Oracle conviction: ${d.score} (${d.tier})">
				<span class="cp-ob-score" style="color:${color}">${d.score}</span>
				<span class="cp-ob-tier" style="color:${color}">${d.tier}</span>
			</a>`;
		}
	} catch { /* non-fatal */ }
}

function discoverRow(t) {
	const wr = t.win_rate != null ? `${Math.round(t.win_rate * 100)}% WR` : null;
	const pnlSol = t.realized_pnl_sol;
	const pnlStr = pnlSol != null ? fmtSol(pnlSol) : null;
	const imgSrc = t.image || '/favicon.ico';
	const meta = [
		t.closed_positions != null ? `${t.closed_positions} closed` : null,
		wr, pnlStr ? `${pnlStr} PnL` : null,
		t.score != null ? `Score ${Math.round(t.score)}` : null,
	].filter(Boolean).join(' · ');
	return `
	<div class="cp-item">
		<img loading="lazy" decoding="async" class="cp-av" src="${esc(imgSrc)}" alt="" data-fallback="invisible" />
		<div class="cp-mid">
			<div class="cp-title"><a href="/trader/${esc(t.agent_id)}" style="color:inherit;text-decoration:none">${esc(t.agent_name || 'agent')}</a></div>
			<div class="cp-sub">${esc(meta)}</div>
		</div>
		<div class="cp-side">
			<a class="cp-btn primary" href="/trader/${esc(t.agent_id)}">Copy →</a>
		</div>
	</div>`;
}

async function loadDiscover(host, copiedIds) {
	const el = host.querySelector('#cp-discover-rows');
	if (!el) return;
	try {
		const data = await get('/api/sniper/leaderboard?limit=20&sort=score');
		const board = (data.leaderboard || []).filter((t) => !copiedIds.has(t.agent_id)).slice(0, 5);
		if (!board.length) {
			const sec = host.querySelector('#cp-discover');
			if (sec) sec.remove();
			return;
		}
		el.innerHTML = board.map(discoverRow).join('');
	} catch {
		const sec = host.querySelector('#cp-discover');
		if (sec) sec.remove();
	}
}

async function loadAndRender(host) {
	let subs, pending, history, earnings;
	try {
		[subs, pending, history, earnings] = await Promise.all([
			get('/api/copy/subscriptions').then((r) => r.subscriptions || []),
			get('/api/copy/executions?status=pending').then((r) => r.executions || []),
			get('/api/copy/executions?status=all&limit=40').then((r) => r.executions || []),
			get('/api/copy/earnings').then((r) => r).catch(() => ({ items: [], total_fee_owed_sol: 0 })),
		]);
	} catch {
		ensureStateKitStyles();
		host.innerHTML = `<div class="cp-sec">${errorStateHTML({
			title: "Couldn't load your copies",
			body: 'We had trouble reaching the copy-trading service. Check your connection and try again.',
		})}</div>`;
		attachRetry(host, () => loadAndRender(host));
		return;
	}

	const hist = history.filter((e) => e.status !== 'pending');

	host.innerHTML = `
		<div class="cp-wrap">
			<section class="cp-sec">
				<div class="cp-sec-h"><h2>Intents to act on</h2><span class="cp-count">${pending.length}</span></div>
				<p class="cp-note">When a trader you copy makes a move, a sized intent appears here. You execute it from your own wallet, then mark it copied.</p>
				<div id="cp-pending">${pending.length ? pending.map(intentRow).join('') : `<div class="cp-empty">No intents waiting. Follow a trader on the <a href="/leaderboard" style="color:var(--nxt-accent)">leaderboard</a> to start.</div>`}</div>
			</section>

			<section class="cp-sec">
				<div class="cp-sec-h"><h2>Your copies</h2><span class="cp-count">${subs.filter((s) => s.status !== 'stopped').length}</span></div>
				<div id="cp-subs">${subs.filter((s) => s.status !== 'stopped').length ? subs.filter((s) => s.status !== 'stopped').map(subRow).join('') : `<div class="cp-empty">You're not copying anyone yet. <a href="/leaderboard" style="color:var(--nxt-accent)">Find a trader →</a></div>`}</div>
			</section>

			${earningsSection(earnings)}

			<section class="cp-sec" id="cp-drip" hidden>
				<div class="cp-sec-h"><h2>Your signal release</h2></div>
				<p class="cp-note">Price the latency of your own calls: $THREE holders in higher tiers see your intent first, everyone else after the delay you set. The trade still lands in your public track record either way.</p>
				<div id="cp-drip-panel"></div>
			</section>

			<section class="cp-sec">
				<div class="cp-sec-h"><h2>History</h2><span class="cp-count">${hist.length}</span></div>
				${historyStats(hist)}
				<div id="cp-history">${hist.length ? hist.map(historyRow).join('') : `<div class="cp-empty">Nothing yet.</div>`}</div>
			</section>

			<section class="cp-sec" id="cp-discover">
				<div class="cp-sec-h"><h2>Discover traders</h2><a class="cp-btn ghost" href="/leaderboard" style="font-size:12px">Full leaderboard →</a></div>
				<p class="cp-note">Top performers on the sniper leaderboard, ranked by score. Copy any trader in one click.</p>
				<div id="cp-discover-rows"><div class="cp-skeleton"></div><div class="cp-skeleton" style="margin-top:4px"></div><div class="cp-skeleton" style="margin-top:4px"></div></div>
			</section>
		</div>`;

	// Enrich pending intent rows with Oracle conviction badges
	enrichIntentOracle(host.querySelector('#cp-pending'));

	// Locked intents count down in place and reload themselves on release.
	if (_countdownTimer) clearInterval(_countdownTimer);
	_countdownTimer = startCountdowns(host, () => loadAndRender(host));

	// Leader side: price your own signal. The panel renders nothing (and the
	// section stays hidden) unless somebody is actually copying one of your agents.
	const dripHost = host.querySelector('#cp-drip-panel');
	if (dripHost) {
		mountAlphaDripPanel(dripHost).then(() => {
			const section = host.querySelector('#cp-drip');
			if (section) section.hidden = !dripHost.innerHTML.trim();
		});
	}

	// Discover section: load top leaderboard traders the user isn't copying yet
	const copiedIds = new Set(subs.filter((s) => s.status !== 'stopped').map((s) => s.leader_agent_id));
	loadDiscover(host, copiedIds);

	// Intent actions
	host.querySelector('#cp-pending')?.addEventListener('click', async (e) => {
		const btn = e.target.closest('[data-act]');
		if (!btn) return;
		const action = btn.dataset.act;
		const row = btn.closest('[data-id]');
		const id = row?.dataset.id;
		if (action === 'open') return; // anchor handles navigation; intent stays until explicitly marked
		btn.disabled = true;
		try {
			await post('/api/copy/executions', { id, action });
			row.style.opacity = '0.4';
			setTimeout(() => loadAndRender(host), 250);
		} catch { btn.disabled = false; }
	});

	// Subscription actions
	host.querySelector('#cp-subs')?.addEventListener('click', async (e) => {
		const btn = e.target.closest('[data-sub-act]');
		if (!btn) return;
		const row = btn.closest('[data-sub]');
		const id = row?.dataset.sub;
		const next = btn.dataset.subAct;
		const errEl = row?.querySelector('[data-sub-err]');
		if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
		btn.disabled = true;
		try {
			if (next === 'stopped') await del(`/api/copy/subscriptions?id=${encodeURIComponent(id)}`);
			else await post('/api/copy/subscriptions', { id, status: next });
			loadAndRender(host);
		} catch (err) {
			// A resume the breaker refuses is the common case here, and swallowing it
			// left the button looking broken. Say why it did not take.
			btn.disabled = false;
			if (errEl) {
				errEl.textContent = err?.message || 'Could not change this subscription.';
				errEl.hidden = false;
			}
		}
	});

	// Performance fee settlement
	host.querySelector('#cp-earn')?.addEventListener('click', async (e) => {
		const btn = e.target.closest('[data-settle]');
		if (!btn) return;
		const subId = btn.dataset.settle;
		const statusEl = host.querySelector('#cp-earn-status');
		const setStatus = (msg) => { statusEl.style.display = msg ? 'block' : 'none'; statusEl.textContent = msg; };
		btn.disabled = true;
		try {
			await payWithCopyFee(subId, setStatus);
			setStatus('Fee settled. Reloading…');
			setTimeout(() => loadAndRender(host), 1200);
		} catch (err) {
			setStatus(`Payment failed: ${err.message || 'unknown error'}. Try again.`);
			btn.disabled = false;
		}
	});
}

const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

async function payWithCopyFee(subscriptionId, onStatus = () => {}) {
	// 1. Request the charge quote from the server
	onStatus('Getting quote…');
	const charge = await post('/api/copy/settle-fee', { subscription_id: subscriptionId });
	if (charge.nothing_to_settle) throw new Error('Nothing to settle right now.');
	if (!charge.quote || !charge.legs || !charge.memo) throw new Error('Invalid quote received.');

	// 2. Load Solana SDK lazily
	onStatus('Preparing transaction…');
	const [{ Connection, PublicKey, Transaction, TransactionInstruction }, { getAssociatedTokenAddressSync, createTransferInstruction, createAssociatedTokenAccountIdempotentInstruction }] =
		await Promise.all([import('@solana/web3.js'), import('@solana/spl-token')]);

	const wallet = window.solana;
	if (!wallet) throw Object.assign(new Error('No wallet found. Install Phantom.'), { code: 'no_wallet' });
	if (!wallet.isConnected) await wallet.connect();
	const payer = wallet.publicKey;
	if (!payer) throw new Error('Wallet has no public key.');

	const rpc = window.__solanaRpc || `${location.origin}/api/solana-rpc`;
	const connection = new Connection(rpc, 'confirmed');

	// 3. Build the $THREE SPL transfer + memo transaction
	const mint = new PublicKey(charge.mint);
	const fromAta = getAssociatedTokenAddressSync(mint, payer);
	const tx = new Transaction();
	for (const leg of charge.legs) {
		const owner = new PublicKey(leg.address);
		const destAta = getAssociatedTokenAddressSync(mint, owner, true);
		tx.add(createAssociatedTokenAccountIdempotentInstruction(payer, destAta, owner, mint));
		tx.add(createTransferInstruction(fromAta, destAta, payer, BigInt(leg.atomics)));
	}
	tx.add(new TransactionInstruction({
		keys: [],
		programId: new PublicKey(MEMO_PROGRAM_ID),
		data: new TextEncoder().encode(charge.memo),
	}));
	const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
	tx.feePayer = payer;
	tx.recentBlockhash = blockhash;

	// 4. Sign and send
	onStatus('Waiting for wallet signature…');
	const signature = await wallet.sendTransaction(tx, connection);
	onStatus('Confirming on-chain…');
	await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');

	// 5. Settle — server verifies and ratchets the HWM
	onStatus('Recording settlement…');
	const settled = await post('/api/copy/settle-fee', { quoteToken: charge.quote, tx_signature: signature });
	if (!settled.ok) throw new Error(settled.error_description || 'Settlement failed on server.');
	return settled;
}

// ── Smart Money directory ─────────────────────────────────────────────────────
// Curated top wallets from gmgn.ai's smart-money taxonomy (SOL + BSC), served by
// /api/copy/smart-wallets. These are external on-chain wallets — not three.ws
// agents — so the action is to watch their live trades, not auto-subscribe. We
// surface them so copiers can vet ecosystem-proven traders before mirroring.

const SM_CATS = [
	{ key: '', label: 'All' },
	{ key: 'smart_money', label: 'Smart money' },
	{ key: 'kol', label: 'KOL' },
	{ key: 'launchpad', label: 'Launchpad' },
	{ key: 'sniper', label: 'Sniper' },
];
const SM_CHAINS = [
	{ key: '', label: 'All chains' },
	{ key: 'sol', label: 'Solana' },
	{ key: 'bsc', label: 'BSC' },
];
const SM_SORTS = [
	{ key: 'score', label: 'Top ranked' },
	{ key: 'profit', label: 'Most profit (30d)' },
	{ key: 'pnl', label: 'Best multiple' },
	{ key: 'winrate', label: 'Win rate' },
	{ key: 'followers', label: 'Most followed' },
];
const SM_PAGE = 12;

function fmtUsd(n) {
	const v = Number(n) || 0;
	const a = Math.abs(v);
	if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
	if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
	if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
	return `$${v.toFixed(0)}`;
}
function fmtMult(n) { return n == null ? '—' : `${Number(n).toFixed(1)}×`; }
function fmtWr(n) { return n == null ? '—' : `${Math.round(Number(n) * 100)}%`; }
function shortAddr(a) { return a ? `${a.slice(0, 4)}…${a.slice(-4)}` : ''; }
function explorerUrl(w) {
	return w.chain === 'bsc'
		? `https://bscscan.com/address/${w.address}`
		: `https://solscan.io/account/${w.address}`;
}
function gmgnUrl(w) { return gmgnAddressUrl(w.address, w.chain); }
function initial(w) {
	const ch = (w.name || w.address || '').replace(/[^a-zA-Z0-9]/g, '')[0];
	return (ch || '?').toUpperCase();
}

function smartRow(w) {
	const handle = w.twitter_username
		? `<a class="sm-tw" href="https://x.com/${esc(w.twitter_username)}" target="_blank" rel="noopener">@${esc(w.twitter_username)}</a>`
		: `<span class="sm-tw sm-mono">${esc(shortAddr(w.address))}</span>`;
	const fallback = esc(initial(w));
	const avatar = w.avatar
		? `<img src="${esc(w.avatar)}" alt="" loading="lazy" data-fallback="text" data-fallback-text="${fallback}" />`
		: fallback;
	const tags = [
		...w.categories.map((c) => `<span class="sm-tag ${esc(c)}">${esc(c.replace('_', ' '))}</span>`),
		`<span class="sm-tag chain">${esc(w.chain)}</span>`,
	].join('');
	const title = w.name ? esc(w.name) : `<span class="sm-mono">${esc(shortAddr(w.address))}</span>`;
	return `
	<div class="sm-item">
		<div class="sm-av">${avatar}</div>
		<div class="sm-mid">
			<div class="sm-name"><a href="${esc(gmgnUrl(w))}" target="_blank" rel="noopener">${title}</a> ${handle}</div>
			<div class="sm-tags">${tags}</div>
		</div>
		<div class="sm-stats">
			<div class="sm-metric"><span class="sm-metric-val pos">${fmtUsd(w.realized_profit_30d_usd)}</span><span class="sm-metric-lbl">PnL 30d</span></div>
			<div class="sm-metric"><span class="sm-metric-val">${fmtMult(w.pnl_30d)}</span><span class="sm-metric-lbl">Multiple</span></div>
			<div class="sm-metric"><span class="sm-metric-val">${fmtWr(w.win_rate_30d)}</span><span class="sm-metric-lbl">Win</span></div>
			<a class="sm-track" href="${esc(gmgnUrl(w))}" target="_blank" rel="noopener" title="Watch this wallet's live trades">Track ↗</a>
		</div>
	</div>`;
}

async function mountSmartMoney(host) {
	const state = { chain: '', category: '', sort: 'score', q: '', offset: 0, total: 0, rows: [] };
	let searchTimer;

	host.innerHTML = `
		<section class="cp-sec">
			<div class="cp-sec-h">
				<h2>Smart money</h2>
				<span class="cp-count" id="sm-count"></span>
			</div>
			<p class="cp-note">Ecosystem-proven wallets from gmgn.ai's smart-money taxonomy — ranked by 30-day realized profit across Solana and BSC. Vet a trader's live history before you mirror them.</p>
			<div class="sm-controls">
				<div class="sm-chips" id="sm-cat" role="group" aria-label="Filter wallets by category">${SM_CATS.map((c) => `<button type="button" class="sm-chip ${c.key === '' ? 'is-active' : ''}" data-cat="${c.key}" aria-pressed="${c.key === '' ? 'true' : 'false'}">${c.label}</button>`).join('')}</div>
				<span class="sm-spacer"></span>
				<div class="sm-chips" id="sm-chain" role="group" aria-label="Filter wallets by chain">${SM_CHAINS.map((c) => `<button type="button" class="sm-chip ${c.key === '' ? 'is-active' : ''}" data-chain="${c.key}" aria-pressed="${c.key === '' ? 'true' : 'false'}">${c.label}</button>`).join('')}</div>
				<input class="sm-search" id="sm-q" type="search" placeholder="Search name, @handle, address" aria-label="Search smart-money wallets by name, handle, or address" autocomplete="off" spellcheck="false" />
				<select class="sm-sort" id="sm-sort" aria-label="Sort wallets">${SM_SORTS.map((s) => `<option value="${s.key}">${s.label}</option>`).join('')}</select>
			</div>
			<div id="sm-rows"><div class="cp-skeleton"></div><div class="cp-skeleton" style="margin-top:4px"></div><div class="cp-skeleton" style="margin-top:4px"></div></div>
			<div class="sm-more" id="sm-more"></div>
		</section>`;

	const rowsEl = host.querySelector('#sm-rows');
	const moreEl = host.querySelector('#sm-more');
	const countEl = host.querySelector('#sm-count');

	async function load(append) {
		if (!append) {
			state.offset = 0;
			rowsEl.innerHTML = `<div class="cp-skeleton"></div><div class="cp-skeleton" style="margin-top:4px"></div>`;
			moreEl.innerHTML = '';
		}
		const qs = new URLSearchParams({ sort: state.sort, limit: String(SM_PAGE), offset: String(state.offset) });
		if (state.chain) qs.set('chain', state.chain);
		if (state.category) qs.set('category', state.category);
		if (state.q) qs.set('q', state.q);
		let data;
		try {
			data = await get(`/api/copy/smart-wallets?${qs.toString()}`);
		} catch {
			rowsEl.innerHTML = `<div class="cp-empty">Couldn't load smart-money wallets. <button class="cp-btn" id="sm-retry">Retry</button></div>`;
			rowsEl.querySelector('#sm-retry')?.addEventListener('click', () => load(false));
			return;
		}
		state.total = data.total || 0;
		const rows = data.wallets || [];
		const html = rows.length ? rows.map(smartRow).join('') : (append ? '' : `<div class="cp-empty">No wallets match these filters.</div>`);
		if (append) rowsEl.insertAdjacentHTML('beforeend', html);
		else rowsEl.innerHTML = html;
		state.offset += rows.length;
		countEl.textContent = state.total ? `${state.total.toLocaleString()} wallets` : '';
		moreEl.innerHTML = data.has_more
			? `<button class="cp-btn" id="sm-load">Load more (${(state.total - state.offset).toLocaleString()} left)</button>`
			: '';
		moreEl.querySelector('#sm-load')?.addEventListener('click', () => load(true));
	}

	host.querySelector('#sm-cat').addEventListener('click', (e) => {
		const btn = e.target.closest('[data-cat]');
		if (!btn) return;
		host.querySelectorAll('#sm-cat .sm-chip').forEach((b) => { const on = b === btn; b.classList.toggle('is-active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
		state.category = btn.dataset.cat;
		load(false);
	});
	host.querySelector('#sm-chain').addEventListener('click', (e) => {
		const btn = e.target.closest('[data-chain]');
		if (!btn) return;
		host.querySelectorAll('#sm-chain .sm-chip').forEach((b) => { const on = b === btn; b.classList.toggle('is-active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
		state.chain = btn.dataset.chain;
		load(false);
	});
	host.querySelector('#sm-sort').addEventListener('change', (e) => { state.sort = e.target.value; load(false); });
	host.querySelector('#sm-q').addEventListener('input', (e) => {
		clearTimeout(searchTimer);
		const v = e.target.value.trim();
		searchTimer = setTimeout(() => { state.q = v; load(false); }, 250);
	});

	load(false);
}

async function main() {
	const root = await mountShell();
	await requireUser();
	root.innerHTML = `
		${STYLE}
		<header style="margin-bottom:20px">
			<h1 class="dn-h1" style="margin:0">Copy Trading</h1>
			<p class="dn-h1-sub" style="margin:0">Mirror proven traders — non-custodially, on your terms. You sign every trade.</p>
		</header>
		<div id="cp-host">
			<div class="cp-wrap"><div class="cp-skeleton"></div><div class="cp-skeleton" style="height:120px"></div></div>
		</div>
		<div id="cp-smart" style="margin-top:20px"></div>`;
	await loadAndRender(root.querySelector('#cp-host'));
	mountSmartMoney(root.querySelector('#cp-smart'));
}

main();
