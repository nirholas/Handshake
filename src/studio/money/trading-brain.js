/**
 * Trading Brain — visual sniping/trading rules (P4, the centerpiece)
 * =================================================================
 * The brain (P1) reasons; THIS executes. The owner draws their agent's trading
 * behaviour as a connected flow of blocks — trigger → filters → buy → exits →
 * risk — and the agent runs it against the real Solana stack: real launches, real
 * quotes, real slippage, real signatures, real confirmations. No simulated fills,
 * no paper P&L.
 *
 * Two first-class modes, both real:
 *   • Assisted (default) — the agent proposes; the owner confirms each snipe with
 *     one tap. "Scan for matches" (POST /api/trading/scan) surfaces live launches
 *     that fit the rule, each with a live quote + rug/honeypot verdict; confirming
 *     routes through the discretionary trade endpoint, which re-runs every guard.
 *   • Autonomous — arming equips the rule as a real strategy
 *     (POST /api/agents/:id/strategies); the cron fan-out runner fires it within
 *     hard, server-enforced guardrails. Autonomy is explicit, revocable, and
 *     auditable, and a global kill switch halts it instantly.
 *
 * Safety is enforced SERVER-SIDE (api/_lib/agent-trade-guards.js): per-trade cap,
 * daily budget, slippage ceiling, price-impact breaker, max concurrent, kill
 * switch — the UI here only edits them; it can never widen the leash.
 *
 * Every fill writes a trade memory (P2) and emits a market event the avatar reacts
 * to (P5) via studio.emitMarket.
 *
 * Mount: import { mountTradingBrain } from './trading-brain.js';
 *        mountTradingBrain(host, { studio });
 */

import { apiFetch } from '../../api.js';
import {
	emptyRule, normalizeRule, validateRule, ruleToEnglish,
	compileRuleToConfig, configToSniperStrategy,
	PRESETS, applyPreset, matchingPresetId, scoreRisk,
} from './trading-compile.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
	({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');
const fmtSol = (n) => (n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 }));
const fmtUsd = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }));
const fmtPct = (n) => (n == null ? '—' : `${n > 0 ? '+' : ''}${Number(n).toFixed(1)}%`);

// three.ws API errors are flat: { error: "<code>", error_description: "<prose>" }.
// Read the prose the server actually sent so a rejection tells the owner WHY
// (rate limit, kill switch, dead feed) instead of a generic house message.
function apiErrorMessage(payload, fallback) {
	const d = payload?.error_description;
	return typeof d === 'string' && d.trim() ? d : fallback;
}

function relTime(ts) {
	if (!ts) return '';
	const d = Date.now() - new Date(ts).getTime();
	if (d < 60000) return 'just now';
	if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
	if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
	return Math.floor(d / 86400000) + 'd ago';
}

const SOLSCAN = (sig) => `https://solscan.io/tx/${sig}`;
const SOLSCAN_ACCT = (a) => `https://solscan.io/account/${a}`;

export function mountTradingBrain(host, { studio }) {
	if (host.dataset.tbMounted) return null;
	host.dataset.tbMounted = '1';
	return new TradingBrain(host, studio);
}

class TradingBrain {
	constructor(el, studio) {
		this.el = el;
		this.studio = studio;
		this.agentId = studio.agent?.id;

		const bag = studio.agent?.meta?.studio?.trading || {};
		this.rule = normalizeRule(bag.rule || emptyRule());
		this.mode = bag.mode === 'autonomous' ? 'autonomous' : 'assisted';
		this.strategyId = typeof bag.strategyId === 'string' ? bag.strategyId : null;

		this.state = {
			loading: true,
			error: null,
			killed: false,
			equips: [],
			positions: [],
			tradeLimits: null,
			spentTodaySol: null,
			spentTodayUsd: null,
			candidates: null, // null = not scanned; [] = scanned, none
			scanNote: null,
			scanning: false,
			backtest: null,
			backtesting: false,
			saving: false,
			arming: false,
			audit: [],
			dirty: false, // rule changed since last server save
		};

		this._render();
		this._load();
	}

	_q(sel) { return this.el.querySelector(sel); }

	get _armed() {
		return this.state.equips.some((e) => e.strategy_id === this.strategyId && e.active);
	}

	// ── Data ──────────────────────────────────────────────────────────────────

	async _load() {
		this.state.loading = true;
		this._renderBody();
		try {
			const [strat, limits, audit] = await Promise.all([
				this._fetchStrategies(),
				this._fetchLimits(),
				this._fetchAudit(),
			]);
			this.state.killed = strat.killed;
			this.state.equips = strat.equips;
			this.state.positions = strat.positions;
			this.state.tradeLimits = limits.trade_limits;
			this.state.spentTodaySol = limits.spent_today_sol;
			this.state.spentTodayUsd = limits.spent_today_usd;
			this.state.audit = audit;
			this.state.error = null;
		} catch (err) {
			this.state.error = err?.message || 'Could not load the Trading Brain.';
		} finally {
			this.state.loading = false;
			this._renderBody();
			this._startLivePolling();
		}
	}

	async _fetchStrategies() {
		const res = await apiFetch(`/api/agents/${this.agentId}/strategies`);
		if (!res.ok) throw new Error('Could not read trading strategies.');
		const { data } = await res.json();
		return { killed: !!data.killed, equips: data.equips || [], positions: data.positions || [] };
	}

	async _fetchLimits() {
		// Canonical, wallet-independent trade-limits endpoint: returns data.limits as
		// the agent's trade guardrails (works even before a signing wallet exists),
		// plus the live daily spend so the owner sees budget burn against the cap.
		const res = await apiFetch(`/api/agents/${this.agentId}/trade/limits?network=${encodeURIComponent(this.rule.network || 'mainnet')}`);
		if (!res.ok) return { trade_limits: null, spent_today_sol: null, spent_today_usd: null };
		const { data } = await res.json();
		return { trade_limits: data.limits, spent_today_sol: data.spent_today_sol ?? null, spent_today_usd: data.spent_today_usd ?? null };
	}

	async _fetchAudit() {
		const res = await apiFetch(`/api/agents/${this.agentId}/solana/custody?category=trade&limit=50`);
		if (!res.ok) return [];
		const { data } = await res.json();
		return data.items || [];
	}

	// ── Persist rule (local studio meta + backend strategy) ─────────────────────

	_persistMeta() {
		this.studio.patch({ meta: { studio: { trading: { rule: this.rule, mode: this.mode, strategyId: this.strategyId } } } });
		this.studio.emit('trading:change', { mode: this.mode, armed: this._armed });
	}

	async _saveStrategy() {
		const { valid, errors } = validateRule(this.rule);
		if (!valid) {
			this._toast(Object.values(errors)[0], true);
			this._renderBuilder();
			return null;
		}
		this.state.saving = true;
		this._renderActions();
		const config = compileRuleToConfig(this.rule);
		try {
			let strategy;
			if (this.strategyId) {
				const res = await apiFetch(`/api/strategies/${this.strategyId}`, {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ name: this.rule.name, config }),
				});
				if (res.status === 404) { this.strategyId = null; return this._saveStrategy(); }
				if (!res.ok) throw new Error('Could not save the rule.');
				strategy = (await res.json()).data;
			} else {
				const res = await apiFetch('/api/strategies', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						name: this.rule.name,
						description: ruleToEnglish(this.rule),
						config,
					}),
				});
				if (!res.ok) {
					const d = await res.json().catch(() => ({}));
					throw new Error(apiErrorMessage(d, 'Could not save the rule.'));
				}
				strategy = (await res.json()).data;
				this.strategyId = strategy.id;
			}
			this.state.dirty = false;
			this._persistMeta();
			this._toast('Rule saved');
			return strategy;
		} catch (err) {
			this._toast(err.message || 'Save failed', true);
			return null;
		} finally {
			this.state.saving = false;
			this._renderActions();
		}
	}

	// ── Mode + arming ───────────────────────────────────────────────────────────

	async _setMode(mode) {
		if (mode === this.mode) return;
		// Switching to assisted must disarm any live autonomous strategy.
		if (mode === 'assisted' && this._armed) await this._disarm({ silent: true });
		this.mode = mode;
		this._persistMeta();
		this.state.candidates = null;
		this.state.scanNote = null;
		this._renderBody();
	}

	async _arm() {
		// Saving first guarantees the equipped config matches what's on screen.
		const strategy = this.state.dirty || !this.strategyId ? await this._saveStrategy() : { id: this.strategyId };
		if (!strategy) return;
		this.state.arming = true;
		this._renderActions();
		try {
			const res = await apiFetch(`/api/agents/${this.agentId}/strategies`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ strategy_id: this.strategyId, network: this.rule.network }),
			});
			if (!res.ok) throw new Error('Could not arm the agent.');
			await this._refreshStrategies();
			this._toast('Agent armed — it will trade within your guardrails');
			this.studio.emitMarket?.({ type: 'alert' });
			this.studio.emit('trading:change', { mode: this.mode, armed: true });
		} catch (err) {
			this._toast(err.message || 'Arming failed', true);
		} finally {
			this.state.arming = false;
			this._renderBody();
		}
	}

	async _disarm({ silent = false } = {}) {
		this.state.arming = true;
		if (!silent) this._renderActions();
		try {
			const res = await apiFetch(`/api/agents/${this.agentId}/strategies/unequip`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ strategy_id: this.strategyId }),
			});
			if (!res.ok) throw new Error('Could not disarm the agent.');
			await this._refreshStrategies();
			if (!silent) this._toast('Agent disarmed — no new autonomous trades');
			this.studio.emit('trading:change', { mode: this.mode, armed: false });
		} catch (err) {
			if (!silent) this._toast(err.message || 'Disarm failed', true);
		} finally {
			this.state.arming = false;
			if (!silent) this._renderBody();
		}
	}

	async _refreshStrategies() {
		const strat = await this._fetchStrategies().catch(() => null);
		if (strat) {
			this.state.killed = strat.killed;
			this.state.equips = strat.equips;
			this.state.positions = strat.positions;
		}
	}

	// ── Live polling ─────────────────────────────────────────────────────────────
	// Open positions are marked to market server-side by the sniper worker; armed
	// strategies open and close them on their own. Poll while there's something live
	// to watch so unrealized P&L, new fills, exits, and today's spend stay current
	// without a manual reload. Paused while the tab is hidden — no point burning RPC
	// and rate limit on an unseen panel.

	_hasLiveWork() {
		return this._armed || (this.state.positions || []).some((p) => p.status === 'open' || p.status === 'closing');
	}

	_startLivePolling() {
		if (this._poll || this._destroyed) return;
		this._onVis = () => { if (!document.hidden) this._pollTick(true); };
		document.addEventListener('visibilitychange', this._onVis);
		this._poll = setInterval(() => this._pollTick(), 15000);
	}

	async _pollTick(force = false) {
		if (this._destroyed || this._polling) return;
		if (document.hidden && !force) return;
		if (!force && !this._hasLiveWork()) return;
		this._polling = true;
		try {
			const [strat, limits] = await Promise.all([
				this._fetchStrategies().catch(() => null),
				this._fetchLimits().catch(() => null),
			]);
			if (this._destroyed) return;
			let touchedPositions = false;
			let touchedSpent = false;
			if (strat) {
				this.state.killed = strat.killed;
				this.state.equips = strat.equips;
				this.state.positions = strat.positions;
				touchedPositions = true;
			}
			if (limits) {
				this.state.tradeLimits = limits.trade_limits ?? this.state.tradeLimits;
				if (limits.spent_today_sol !== this.state.spentTodaySol || limits.spent_today_usd !== this.state.spentTodayUsd) {
					this.state.spentTodaySol = limits.spent_today_sol;
					this.state.spentTodayUsd = limits.spent_today_usd;
					touchedSpent = true;
				}
			}
			// Re-render only the live regions, and only when not loading (avoid
			// clobbering a mid-flight scan/backtest in another part of the panel).
			if (!this.state.loading) {
				if (touchedPositions) { this._renderPositions(); this._renderHeader(); }
				// Update only the spent line — never re-render the guardrails card on a
				// poll tick, or we'd clobber an input the owner is mid-edit.
				if (touchedSpent) this._renderSpent();
			}
		} finally {
			this._polling = false;
		}
	}

	_stopLivePolling() {
		if (this._poll) { clearInterval(this._poll); this._poll = null; }
		if (this._onVis) { document.removeEventListener('visibilitychange', this._onVis); this._onVis = null; }
	}

	// ── Kill switch ─────────────────────────────────────────────────────────────

	async _toggleKill() {
		const next = !this.state.killed;
		// A true global halt must hit BOTH leashes: the per-owner strategy kill
		// (stops the autonomous cron) and the agent's discretionary kill_switch
		// (stops assisted confirms + the discretionary trade path). Reflect intent
		// immediately — this is a safety control.
		this.state.killed = next;
		this._renderHeader();
		const hdr = { 'content-type': 'application/json' };
		const [k1, k2] = await Promise.allSettled([
			apiFetch(`/api/agents/${this.agentId}/strategies/kill`, { method: 'POST', headers: hdr, body: JSON.stringify({ killed: next }) }),
			apiFetch(`/api/agents/${this.agentId}/trade/limits`, { method: 'PUT', headers: hdr, body: JSON.stringify({ kill_switch: next }) }),
		]);
		const ok1 = k1.status === 'fulfilled' && k1.value.ok;
		const ok2 = k2.status === 'fulfilled' && k2.value.ok;
		if (ok2) { try { const d = await k2.value.json(); if (d?.data?.limits) this.state.tradeLimits = d.data.limits; } catch { /* noop */ } }
		if (ok1 && ok2) {
			this.state.killed = next;
			this._toast(next ? 'Kill switch ON — all trading halted' : 'Kill switch off');
		} else {
			// Fail safe: never report "resumed" unless both leashes confirmed off.
			this.state.killed = true;
			this._toast(next ? 'Kill switch may be only partially applied — kept halted, retry' : 'Could not fully resume — kept halted for safety, retry', true);
		}
		this._renderHeader();
	}

	// ── Guardrails (server-enforced trade limits) ───────────────────────────────

	async _saveGuardrails() {
		const card = this._q('[data-guardrails]');
		if (!card) return;
		const val = (k) => {
			const inp = card.querySelector(`[data-glimit="${k}"]`);
			if (!inp) return undefined;
			const v = inp.value.trim();
			return v === '' ? null : Number(v);
		};
		const patch = {
			per_trade_sol: val('per_trade_sol'),
			daily_budget_sol: val('daily_budget_sol'),
			max_price_impact_pct: val('max_price_impact_pct'),
			max_concurrent: val('max_concurrent'),
		};
		const btn = card.querySelector('[data-action="save-guardrails"]');
		if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
		try {
			const res = await apiFetch(`/api/agents/${this.agentId}/trade/limits`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(patch),
			});
			if (!res.ok) throw new Error('Could not save guardrails.');
			const { data } = await res.json();
			this.state.tradeLimits = data.limits;
			this._renderGuardrails();
			this._toast('Guardrails saved — enforced server-side on every trade');
		} catch (err) {
			this._toast(err.message || 'Save failed', true);
		} finally {
			if (btn) { btn.disabled = false; btn.textContent = 'Save guardrails'; }
		}
	}

	// ── Assisted scan + confirm ─────────────────────────────────────────────────

	async _scan() {
		if (this.state.scanning) return;
		if (this.state.killed) { this._toast('Kill switch is on — turn it off to scan', true); return; }
		this.state.scanning = true;
		this.state.candidates = null;
		this.state.scanNote = null;
		this._renderAssisted();
		try {
			const res = await apiFetch('/api/trading/scan', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ agent_id: this.agentId, config: compileRuleToConfig(this.rule) }),
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(apiErrorMessage(d, 'Scan failed.'));
			}
			const { data } = await res.json();
			this.state.candidates = data.candidates || [];
			this.state.scanNote = data.note || `Scanned ${data.scanned} live launches.`;
			if (this.state.candidates.length) this.studio.emitMarket?.({ type: 'alert' });
		} catch (err) {
			this._toast(err.message || 'Scan failed', true);
			this.state.candidates = [];
		} finally {
			this.state.scanning = false;
			this._renderAssisted();
		}
	}

	async _confirmSnipe(mint) {
		if (this.state.killed) { this._toast('Kill switch is on — turn it off to trade', true); return; }
		const cand = (this.state.candidates || []).find((c) => c.mint === mint);
		if (!cand) return;
		const card = this.el.querySelector(`[data-cand="${CSS.escape(mint)}"]`);
		const btn = card?.querySelector('[data-action="confirm-snipe"]');
		if (btn) { btn.disabled = true; btn.textContent = 'Sniping…'; }
		this.studio.emitMarket?.({ type: 'trade:buy', mint });
		try {
			const res = await apiFetch(`/api/agents/${this.agentId}/solana/trade`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					side: 'buy', mint, solAmount: cand.amount_sol,
					slippageBps: cand.slippage_bps, network: this.rule.network,
				}),
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) {
				throw new Error(apiErrorMessage(payload, 'Snipe rejected.'));
			}
			const d = payload.data || {};
			this.studio.emitMarket?.({ type: 'snipe:filled', mint, amount: cand.amount_sol, signature: d.signature });
			this._writeTradeMemory(cand, d.signature);
			this._toast(`Sniped ${cand.symbol || short(mint)} — ${fmtSol(cand.amount_sol)} SOL`);
			if (card) card.classList.add('tb-cand-done');
			if (btn) { btn.textContent = 'Filled ✓'; }
			// Refresh positions + audit so the fill shows immediately.
			this._refreshStrategies().then(() => this._renderPositions());
			this._fetchAudit().then((a) => { this.state.audit = a; this._renderAudit(); });
		} catch (err) {
			this.studio.emitMarket?.({ type: 'snipe:failed', mint });
			this._toast(err.message || 'Snipe failed', true);
			if (btn) { btn.disabled = false; btn.textContent = 'Confirm snipe'; }
		}
	}

	// Force-close one open position now — the per-position "Sell now" lever. Sells
	// the agent's full holding through the SAME guarded strategy-exit path the
	// autonomous take-profit/stop uses (server-side), so manual and automatic exits
	// can never drift. Selling moves SOL inward, so it works even with the kill
	// switch on — getting out is always allowed.
	async _closePosition(positionId) {
		if (!positionId) return;
		const btn = this.el.querySelector(`[data-action="close-pos"][data-pos="${CSS.escape(positionId)}"]`);
		if (btn) { if (btn.disabled) return; btn.disabled = true; btn.textContent = 'Selling…'; }
		try {
			const res = await apiFetch(`/api/agents/${this.agentId}/strategies/close`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ position_id: positionId }),
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(apiErrorMessage(payload, 'Could not close the position.'));
			const d = payload.data || {};
			const pnl = d.pnl_sol;
			this.studio.emitMarket?.({ type: 'trade:sell', mint: d.mint });
			if (d.reconciled) {
				this._toast(`${d.symbol || 'Position'} was already sold — reconciled`);
			} else {
				const pnlStr = pnl != null ? ` · ${pnl >= 0 ? '+' : ''}${fmtSol(pnl)} SOL` : '';
				this._toast(`Closed ${d.symbol || short(d.mint)}${pnlStr}${d.unconfirmed ? ' (confirming…)' : ''}`);
			}
			// Refresh positions + audit so the close shows immediately; live polling
			// keeps the rest current.
			await this._refreshStrategies();
			this._renderPositions();
			this._fetchAudit().then((a) => { this.state.audit = a; this._renderAudit(); });
		} catch (err) {
			this._toast(err.message || 'Close failed', true);
			if (btn) { btn.disabled = false; btn.textContent = 'Sell now'; }
		}
	}

	async _writeTradeMemory(cand, signature) {
		// Coordinate with P2: record the trade, its rationale, and the outcome so the
		// agent remembers what it did and why. Best-effort — a memory hiccup never
		// blocks a confirmed on-chain trade.
		try {
			await apiFetch('/api/agent-memory', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					agentId: this.agentId,
					entry: {
						type: 'project',
						content: `Sniped ${cand.symbol || cand.name || short(cand.mint)} (${cand.mint}) for ${cand.amount_sol} SOL — ` +
							`matched rule "${this.rule.name}" (${(cand.reasons || []).join(', ')}). ` +
							`Firewall: ${cand.firewall?.verdict || 'n/a'}. tx ${signature || 'pending'}.`,
						tags: ['trade', 'snipe', 'assisted'],
						context: {
							mint: cand.mint, sol: cand.amount_sol, signature: signature || null,
							market_cap_usd: cand.market_cap_usd, reasons: cand.reasons,
						},
						salience: 0.75,
					},
				}),
			});
		} catch { /* non-blocking */ }
	}

	// ── Backtest (historical, honest) ───────────────────────────────────────────

	async _backtest() {
		if (this.state.backtesting) return;
		const { valid, errors } = validateRule(this.rule);
		if (!valid) { this._toast(Object.values(errors)[0], true); return; }
		this.state.backtesting = true;
		this.state.backtest = null;
		this._renderBacktest();
		try {
			const config = compileRuleToConfig(this.rule);
			const strategy = configToSniperStrategy(config, { maxPriceImpactPct: this.state.tradeLimits?.max_price_impact_pct ?? null });
			const res = await apiFetch('/api/sniper/backtest', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ agent_id: this.agentId, strategy, window_days: 30, network: this.rule.network }),
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(apiErrorMessage(d, 'Backtest failed.'));
			}
			const { data } = await res.json();
			this.state.backtest = data;
		} catch (err) {
			this._toast(err.message || 'Backtest failed', true);
			this.state.backtest = { error: err.message };
		} finally {
			this.state.backtesting = false;
			this._renderBacktest();
		}
	}

	// ── Audit export ────────────────────────────────────────────────────────────

	_exportAudit() {
		const rows = this.state.audit || [];
		if (!rows.length) { this._toast('No trades to export yet', true); return; }
		const head = ['date', 'type', 'asset', 'amount_sol', 'usd', 'status', 'reason', 'signature'];
		const csv = [head.join(',')].concat(rows.map((r) => [
			r.created_at, r.category, r.asset || '',
			r.amount_lamports != null ? (Number(r.amount_lamports) / 1e9) : '',
			r.usd ?? '', r.status, (r.reason || '').replace(/,/g, ';'), r.signature || '',
		].join(','))).join('\n');
		const blob = new Blob([csv], { type: 'text/csv' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${this.agentId}-trade-audit.csv`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	// ── Render ──────────────────────────────────────────────────────────────────

	_render() {
		this.el.innerHTML = `
			<section class="tb" aria-labelledby="tb-h">
				<header class="tb-head" data-head></header>
				<div class="tb-body" data-body></div>
			</section>
			<div class="mny-toast tb-toast" data-tbtoast hidden></div>`;
	}

	_renderBody() {
		this._renderHeader();
		const body = this._q('[data-body]');
		if (this.state.loading) { body.innerHTML = `<div class="tb-skel"></div>`; return; }
		if (this.state.error) {
			body.innerHTML = `
				<div class="mny-empty">
					<div class="mny-empty-glyph" aria-hidden="true">⚠</div>
					<h3>Couldn’t load the Trading Brain</h3>
					<p>${esc(this.state.error)}</p>
					<button class="studio-btn studio-btn-ghost" data-action="retry">Try again</button>
				</div>`;
			body.querySelector('[data-action="retry"]')?.addEventListener('click', () => this._load());
			return;
		}
		body.innerHTML = `
			<p class="tb-disclosure">Trading is risky. Coins can go to zero. Your agent only ever spends what you fund and within the guardrails you set below — never more. Past results never guarantee future ones.</p>
			<div class="tb-builder" data-builder></div>
			<div class="tb-guardrails-wrap" data-guardrails-wrap></div>
			<div class="tb-actions" data-actions></div>
			<div class="tb-assisted" data-assisted></div>
			<div class="tb-backtest" data-backtest></div>
			<div class="tb-positions" data-positions></div>
			<div class="tb-audit" data-audit></div>`;
		this._renderBuilder();
		this._renderGuardrails();
		this._renderActions();
		this._renderAssisted();
		this._renderBacktest();
		this._renderPositions();
		this._renderAudit();
		this._bind();
	}

	_renderHeader() {
		const head = this._q('[data-head]');
		if (!head) return;
		const killed = this.state.killed;
		const armed = this._armed;
		head.innerHTML = `
			<div class="tb-title">
				<h3 id="tb-h">Trading Brain</h3>
				<p>Draw how your agent snipes and trades. The brain reasons; this executes — for real, within your guardrails.</p>
			</div>
			<div class="tb-head-controls">
				<div class="tb-mode" role="tablist" aria-label="Trading mode">
					<button class="tb-mode-btn ${this.mode === 'assisted' ? 'is-on' : ''}" role="tab" aria-selected="${this.mode === 'assisted'}" data-action="mode" data-mode="assisted">Assisted</button>
					<button class="tb-mode-btn ${this.mode === 'autonomous' ? 'is-on' : ''}" role="tab" aria-selected="${this.mode === 'autonomous'}" data-action="mode" data-mode="autonomous">Autonomous</button>
				</div>
				${armed ? `<span class="tb-status tb-status-live" title="Autonomous strategy is live">● Armed</span>` : ''}
				<button class="tb-kill ${killed ? 'is-killed' : ''}" data-action="kill" aria-pressed="${killed}" title="Halt all autonomous trading instantly">
					${killed ? 'Killed — resume' : 'Kill switch'}
				</button>
			</div>`;
	}

	// — Visual flow builder —
	_renderBuilder() {
		const host = this._q('[data-builder]');
		if (!host) return;
		const r = this.rule;
		const { errors } = validateRule(r);
		const err = (k) => errors[k] ? `<span class="tb-err">${esc(errors[k])}</span>` : '';
		const field = (label, k, val, attrs = '', suffix = '') => `
			<label class="tb-field">
				<span class="tb-field-l">${esc(label)}</span>
				<span class="tb-input-wrap">
					<input data-rule="${k}" value="${val == null ? '' : esc(val)}" ${attrs} />
					${suffix ? `<span class="tb-suffix">${esc(suffix)}</span>` : ''}
				</span>
			</label>`;
		const num = 'type="number" inputmode="decimal" min="0" step="any"';

		host.innerHTML = `
			<div class="tb-presets" role="group" aria-label="Strategy presets">
				<span class="tb-presets-l">Start from</span>
				<div class="tb-preset-chips">${this._presetsHtml()}</div>
			</div>
			<div class="tb-topline">
				<label class="tb-name">
					<span class="tb-field-l">Rule name</span>
					<input data-rule="name" value="${esc(r.name)}" maxlength="60" placeholder="My sniper" />
				</label>
				${this._riskMeterHtml()}
			</div>
			<div class="tb-flow">
				${this._block('trigger', '◎', 'When', `
					${field('Launched within (min)', 'trigger.max_age_minutes', r.trigger.max_age_minutes, num, 'min')}
				`)}
				${this._connector()}
				${this._block('filters', '⊜', 'And it matches', `
					${field('Min market cap', 'filters.min_market_cap_usd', r.filters.min_market_cap_usd, num, 'USD')}
					${field('Max market cap', 'filters.max_market_cap_usd', r.filters.max_market_cap_usd, num, 'USD')}
					${err('filters.max_market_cap_usd')}
					${field('Min liquidity', 'filters.min_liquidity_sol', r.filters.min_liquidity_sol, num, 'SOL')}
					${field('Creator: max prior launches', 'filters.max_creator_launches', r.filters.max_creator_launches, num)}
					${field('Creator: min graduated', 'filters.min_creator_graduated', r.filters.min_creator_graduated, num)}
					<label class="tb-check"><input type="checkbox" data-rule="filters.require_socials" ${r.filters.require_socials ? 'checked' : ''}/> Must have socials</label>
					<label class="tb-check"><input type="checkbox" data-rule="filters.require_sol_quote" ${r.filters.require_sol_quote ? 'checked' : ''}/> SOL-quoted only</label>
				`)}
				${this._connector()}
				${this._block('buy', '↑', 'Buy', `
					${field('Per-trade size', 'buy.amount_sol', r.buy.amount_sol, num, 'SOL')}
					${err('buy.amount_sol')}
					${field('Max slippage', 'buy.max_slippage_bps', r.buy.max_slippage_bps, num, 'bps')}
				`)}
				${this._connector()}
				${this._block('exits', '⇄', 'Then exit', `
					${field('Take profit', 'exits.take_profit_pct', r.exits.take_profit_pct, num, '%')}
					${field('Stop loss', 'exits.stop_loss_pct', r.exits.stop_loss_pct, num, '%')}
					${err('exits.stop_loss_pct')}
					${field('Trailing stop', 'exits.trailing_stop_pct', r.exits.trailing_stop_pct, num, '%')}
					${field('Max hold', 'exits.max_hold_minutes', r.exits.max_hold_minutes, num, 'min')}
					${err('exits')}
				`)}
				${this._connector()}
				${this._block('risk', '⚖', 'Within limits', `
					${field('Max concurrent positions', 'risk.max_concurrent_positions', r.risk.max_concurrent_positions, num)}
					${field('Cooldown between buys', 'risk.cooldown_minutes', r.risk.cooldown_minutes, num, 'min')}
				`)}
			</div>
			<p class="tb-english"><span aria-hidden="true">🗣</span> ${esc(ruleToEnglish(r))}</p>`;
	}

	_presetsHtml() {
		const active = matchingPresetId(this.rule);
		return PRESETS.map((p) => `
			<button class="tb-preset ${p.id === active ? 'is-on' : ''}" data-action="preset" data-preset="${esc(p.id)}"
				aria-pressed="${p.id === active}" title="${esc(p.tagline)}">
				<span class="tb-preset-name">${esc(p.name)}</span>
				<span class="tb-preset-tag">${esc(p.tagline)}</span>
			</button>`).join('');
	}

	_riskMeterHtml() {
		const { score, label, tone } = scoreRisk(this.rule);
		return `
			<div class="tb-risk tb-risk-${tone}" data-risk title="Aggressiveness scored from your rule — bigger size, deeper stops, wider slippage and fresher targets raise it">
				<div class="tb-risk-top"><span class="tb-risk-l">Risk profile</span><span class="tb-risk-label">${esc(label)}</span></div>
				<div class="tb-risk-track"><div class="tb-risk-fill" style="width:${score}%"></div></div>
			</div>`;
	}

	_renderRiskMeter() {
		const host = this._q('[data-risk]');
		if (!host) return;
		const tmp = document.createElement('div');
		tmp.innerHTML = this._riskMeterHtml().trim();
		const next = tmp.firstElementChild;
		if (next) host.replaceWith(next);
	}

	_applyPreset(id) {
		this.rule = applyPreset(id, { network: this.rule.network });
		this.state.dirty = true;
		this._renderBuilder();
		this._persistMeta();
		this._toast(`Applied "${PRESETS.find((p) => p.id === id)?.name || id}" — tune it, then backtest`);
	}

	// Toggle the active preset chip in place (no re-render) as the rule is edited.
	_syncPresetHighlight() {
		const active = matchingPresetId(this.rule);
		this.el.querySelectorAll('.tb-preset').forEach((btn) => {
			const on = btn.dataset.preset === active;
			btn.classList.toggle('is-on', on);
			btn.setAttribute('aria-pressed', String(on));
		});
	}

	_block(key, glyph, title, inner) {
		return `
			<div class="tb-node tb-node-${key}">
				<div class="tb-node-head"><span class="tb-node-glyph" aria-hidden="true">${glyph}</span><span class="tb-node-title">${esc(title)}</span></div>
				<div class="tb-node-body">${inner}</div>
			</div>`;
	}

	_connector() {
		return `<div class="tb-connector" aria-hidden="true"><span></span></div>`;
	}

	_renderGuardrails() {
		const host = this._q('[data-guardrails-wrap]');
		if (!host) return;
		const t = this.state.tradeLimits || {};
		const v = (x) => (x == null ? '' : x);
		host.innerHTML = `
			<div class="tb-guardrails" data-guardrails>
				<div class="tb-card-head">
					<h4>Guardrails <span class="tb-badge">enforced server-side</span></h4>
					<p>Hard caps the agent can never exceed — checked on every trade, autonomous or assisted. Leave blank for no cap.</p>
				</div>
				<div class="tb-glimits">
					<label class="tb-field"><span class="tb-field-l">Max per trade</span><span class="tb-input-wrap"><input type="number" min="0" step="any" data-glimit="per_trade_sol" value="${v(t.per_trade_sol)}" placeholder="∞"/><span class="tb-suffix">SOL</span></span></label>
					<label class="tb-field"><span class="tb-field-l">Daily budget</span><span class="tb-input-wrap"><input type="number" min="0" step="any" data-glimit="daily_budget_sol" value="${v(t.daily_budget_sol)}" placeholder="∞"/><span class="tb-suffix">SOL</span></span></label>
					<label class="tb-field"><span class="tb-field-l">Max price impact</span><span class="tb-input-wrap"><input type="number" min="0" step="any" data-glimit="max_price_impact_pct" value="${v(t.max_price_impact_pct)}" placeholder="15"/><span class="tb-suffix">%</span></span></label>
					<label class="tb-field"><span class="tb-field-l">Max open positions</span><span class="tb-input-wrap"><input type="number" min="0" step="1" data-glimit="max_concurrent" value="${v(t.max_concurrent)}" placeholder="∞"/></span></label>
				</div>
				<div class="tb-glimits-foot">
					${this._spentHtml(t)}
					<button class="studio-btn studio-btn-ghost" data-action="save-guardrails">Save guardrails</button>
				</div>
			</div>`;
	}

	// Daily budget burn — real spend (mainnet trade custody, 24h window) shown
	// against the daily cap so the owner sees how much leash is left today.
	_spentHtml(limits) {
		const spent = this.state.spentTodaySol;
		if (spent == null) return `<span class="tb-spent"></span>`;
		const budget = limits?.daily_budget_sol;
		const usd = this.state.spentTodayUsd;
		const usdStr = usd != null ? ` · ${fmtUsd(usd)}` : '';
		if (budget == null || !(budget > 0)) {
			return `<span class="tb-spent">Spent today: <b>${fmtSol(spent)} SOL</b>${usdStr}</span>`;
		}
		const pct = Math.max(0, Math.min(100, (spent / budget) * 100));
		const warn = pct >= 90 ? ' is-hot' : pct >= 60 ? ' is-warm' : '';
		return `
			<span class="tb-spent${warn}">
				Spent today: <b>${fmtSol(spent)}</b> / ${fmtSol(budget)} SOL${usdStr}
				<span class="tb-budget-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct.toFixed(0)}" aria-label="Daily budget used">
					<span class="tb-budget-fill" style="width:${pct.toFixed(1)}%"></span>
				</span>
			</span>`;
	}

	// Swap just the spent line in place (used by the live poll) so we never touch
	// the guardrail inputs the owner might be editing.
	_renderSpent() {
		const cur = this._q('.tb-glimits-foot .tb-spent');
		if (!cur) return;
		const tmp = document.createElement('div');
		tmp.innerHTML = this._spentHtml(this.state.tradeLimits || {}).trim();
		const next = tmp.firstElementChild;
		if (next) cur.replaceWith(next);
	}

	_renderActions() {
		const host = this._q('[data-actions]');
		if (!host) return;
		const saving = this.state.saving;
		const arming = this.state.arming;
		const armed = this._armed;
		const modeBtn = this.mode === 'autonomous'
			? (armed
				? `<button class="studio-btn studio-btn-danger" data-action="disarm" ${arming ? 'disabled' : ''}>${arming ? 'Disarming…' : 'Disarm agent'}</button>`
				: `<button class="studio-btn studio-btn-primary" data-action="arm" ${arming ? 'disabled' : ''}>${arming ? 'Arming…' : 'Arm agent'}</button>`)
			: `<button class="studio-btn studio-btn-primary" data-action="scan" ${this.state.scanning ? 'disabled' : ''}>${this.state.scanning ? 'Scanning…' : 'Scan for matches'}</button>`;
		const mac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform || navigator.userAgent || '');
		const mod = mac ? '⌘' : 'Ctrl';
		const runHint = this.mode === 'autonomous' ? `${mod}↵` : `${mod}↵`;
		host.innerHTML = `
			<button class="studio-btn studio-btn-ghost" data-action="save" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save rule'}<kbd class="tb-kbd">${mod}S</kbd></button>
			<button class="studio-btn studio-btn-ghost" data-action="backtest" ${this.state.backtesting ? 'disabled' : ''}>${this.state.backtesting ? 'Backtesting…' : 'Backtest'}<kbd class="tb-kbd">${mod}B</kbd></button>
			${modeBtn.replace('</button>', `<kbd class="tb-kbd">${runHint}</kbd></button>`)}`;
	}

	_renderAssisted() {
		const host = this._q('[data-assisted]');
		if (!host) return;
		if (this.mode !== 'assisted') { host.innerHTML = ''; return; }
		const c = this.state.candidates;
		if (this.state.scanning) { host.innerHTML = `<div class="tb-card-head"><h4>Scanning live launches…</h4></div><div class="tb-skel small"></div>`; return; }
		if (c == null) {
			host.innerHTML = `<div class="tb-hint">Assisted mode: tap <b>Scan for matches</b> to see live launches that fit your rule. Your agent proposes — you confirm each snipe.</div>`;
			return;
		}
		if (!c.length) {
			host.innerHTML = `<div class="tb-card-head"><h4>No matches right now</h4><p>${esc(this.state.scanNote || '')} Loosen a filter and scan again — new coins launch every minute.</p></div>`;
			return;
		}
		host.innerHTML = `
			<div class="tb-card-head"><h4>${c.length} live match${c.length === 1 ? '' : 'es'}</h4><p>${esc(this.state.scanNote || '')} Real quotes, real safety checks. Confirm to snipe with your custodial wallet.</p></div>
			<ul class="tb-cands">${c.map((x) => this._candRow(x)).join('')}</ul>`;
	}

	_candRow(x) {
		const fw = x.firewall || {};
		const fwClass = fw.verdict === 'block' ? 'block' : fw.verdict === 'warn' ? 'warn' : 'ok';
		const fwLabel = fw.verdict === 'block' ? 'Unsafe' : fw.verdict === 'warn' ? 'Caution' : 'Clean';
		const impact = x.quote?.price_impact_pct;
		const blocked = fw.verdict === 'block';
		return `
			<li class="tb-cand" data-cand="${esc(x.mint)}">
				<div class="tb-cand-main">
					<div class="tb-cand-id">
						<b>${esc(x.symbol || x.name || short(x.mint))}</b>
						<a class="tb-cand-link" href="${SOLSCAN_ACCT(esc(x.mint))}" target="_blank" rel="noopener" title="View coin">${esc(short(x.mint))} ↗</a>
					</div>
					<div class="tb-cand-meta">
						${x.age_minutes != null ? `<span>${x.age_minutes}m old</span>` : ''}
						${x.market_cap_usd != null ? `<span>${fmtUsd(x.market_cap_usd)} mc</span>` : ''}
						${x.has_socials ? `<span>socials</span>` : ''}
						${impact != null ? `<span title="Price impact">${impact.toFixed(1)}% impact</span>` : ''}
					</div>
				</div>
				<div class="tb-cand-side">
					<span class="tb-fw tb-fw-${fwClass}" title="${esc((fw.reasons || []).join(' · ') || fwLabel)}">${fwLabel}${fw.score != null ? ` ${fw.score}` : ''}</span>
					<span class="tb-cand-out">${x.quote?.out_ui != null ? `≈ ${Number(x.quote.out_ui).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—'} <i>for ${fmtSol(x.amount_sol)} SOL</i></span>
					<button class="studio-btn ${blocked ? 'studio-btn-ghost' : 'studio-btn-primary'}" data-action="confirm-snipe" data-mint="${esc(x.mint)}" ${blocked ? 'disabled title="Firewall flagged this coin as unsafe"' : ''}>${blocked ? 'Blocked' : 'Confirm snipe'}</button>
				</div>
			</li>`;
	}

	_renderBacktest() {
		const host = this._q('[data-backtest]');
		if (!host) return;
		const b = this.state.backtest;
		if (this.state.backtesting) { host.innerHTML = `<div class="tb-card-head"><h4>Replaying real launch history…</h4></div><div class="tb-skel small"></div>`; return; }
		if (!b) { host.innerHTML = ''; return; }
		if (b.error) { host.innerHTML = `<div class="tb-hint tb-hint-warn">Backtest unavailable: ${esc(b.error)}</div>`; return; }
		if (b.insufficient_data) {
			host.innerHTML = `<div class="tb-card-head"><h4>Backtest — historical, not a guarantee</h4></div><div class="tb-hint">${esc(b.message)}</div>`;
			return;
		}
		const m = b.metrics || {};
		const conf = b.caveats?.confidence || 'low';
		host.innerHTML = `
			<div class="tb-card-head">
				<h4>Backtest <span class="tb-badge tb-badge-${conf}">${esc(conf)} confidence</span></h4>
				<p>Replayed over ${b.sample_size} real labeled launches (last ${b.window_days}d, ${esc(b.network)}). Historical only — never a guarantee of future results.</p>
			</div>
			<div class="tb-bt-grid">
				<div class="tb-bt-stat"><b class="${m.win_rate >= 0.5 ? 'pos' : ''}">${(m.win_rate * 100).toFixed(0)}%</b><span>win rate</span></div>
				<div class="tb-bt-stat"><b class="${m.expected_value_pct >= 0 ? 'pos' : 'neg'}">${fmtPct(m.expected_value_pct)}</b><span>avg ROI / trade</span></div>
				<div class="tb-bt-stat"><b class="${m.net_pnl_sol >= 0 ? 'pos' : 'neg'}">${fmtSol(m.net_pnl_sol)}</b><span>net SOL (${b.sample_size}×${fmtSol(b.stake_sol)})</span></div>
				<div class="tb-bt-stat"><b class="neg">−${fmtSol(m.max_drawdown_sol)}</b><span>max drawdown</span></div>
				<div class="tb-bt-stat"><b>${fmtPct(m.roi_best_pct)}</b><span>best</span></div>
				<div class="tb-bt-stat"><b class="neg">${fmtPct(m.roi_worst_pct)}</b><span>worst</span></div>
			</div>
			${this._distributionHtml(m.outcome_distribution, b.sample_size)}
			${this._sampleTradesHtml(b.sample_hits, b.sample_misses)}
			${b.caveats?.items?.length ? `<details class="tb-caveats"><summary>How this is computed (${b.caveats.items.length} caveats)</summary><ul>${b.caveats.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></details>` : ''}`;
	}

	// A single segmented bar of how the matching launches actually resolved — the
	// honest shape behind the headline win rate (graduated → pumped → flat → rugged).
	_distributionHtml(dist, total) {
		if (!dist || !total) return '';
		const segs = [
			{ k: 'graduated', label: 'Graduated', cls: 'grad' },
			{ k: 'pumped', label: 'Pumped', cls: 'pump' },
			{ k: 'flat', label: 'Flat', cls: 'flat' },
			{ k: 'rugged', label: 'Rugged', cls: 'rug' },
		].map((s) => ({ ...s, n: Number(dist[s.k] || 0) })).filter((s) => s.n > 0);
		if (!segs.length) return '';
		return `
			<div class="tb-dist">
				<div class="tb-dist-l">How ${total} matching launches actually resolved</div>
				<div class="tb-dist-bar" role="img" aria-label="${esc(segs.map((s) => `${s.n} ${s.label}`).join(', '))}">
					${segs.map((s) => `<span class="tb-dist-seg tb-dist-${s.cls}" style="flex:${s.n}" title="${s.label}: ${s.n} (${Math.round((s.n / total) * 100)}%)"></span>`).join('')}
				</div>
				<div class="tb-dist-legend">${segs.map((s) => `<span class="tb-dist-key"><i class="tb-dist-dot tb-dist-${s.cls}"></i>${esc(s.label)} ${Math.round((s.n / total) * 100)}%</span>`).join('')}</div>
			</div>`;
	}

	// A couple of real best/worst sample trades from the replay, so the projection
	// isn't just aggregate numbers — you see the kind of coin it would have taken.
	_sampleTradesHtml(hits, misses) {
		const row = (t, sign) => {
			const roi = t.roi_pct ?? t.roiPct;
			const cls = (roi ?? 0) >= 0 ? 'pos' : 'neg';
			const name = t.symbol || t.name || short(t.mint || '');
			return `<li class="tb-sample-row"><span class="tb-sample-name">${esc(name)}</span><span class="tb-sample-out">${esc(t.outcome || '')}</span><span class="tb-sample-roi ${cls}">${roi == null ? '—' : fmtPct(roi)}</span></li>`;
		};
		const h = (hits || []).slice(0, 3);
		const m = (misses || []).slice(0, 3);
		if (!h.length && !m.length) return '';
		return `
			<details class="tb-samples">
				<summary>Sample trades from the replay</summary>
				<div class="tb-samples-cols">
					${h.length ? `<div><div class="tb-samples-h pos">Best</div><ul class="tb-sample-list">${h.map((t) => row(t, '+')).join('')}</ul></div>` : ''}
					${m.length ? `<div><div class="tb-samples-h neg">Worst</div><ul class="tb-sample-list">${m.map((t) => row(t, '−')).join('')}</ul></div>` : ''}
				</div>
			</details>`;
	}

	_renderPositions() {
		const host = this._q('[data-positions]');
		if (!host) return;
		const pos = this.state.positions || [];
		if (!pos.length) {
			host.innerHTML = `<div class="tb-card-head"><h4>Positions</h4></div><div class="tb-hint">No positions yet. Snipe a match or arm the agent — open and closed positions, with real P&L, land here.</div>`;
			return;
		}
		const open = pos.filter((p) => p.status === 'open' || p.status === 'closing');
		host.innerHTML = `
			<div class="tb-card-head"><h4>Positions <span class="tb-badge">${open.length} open</span></h4></div>
			<ul class="tb-pos">${pos.slice(0, 20).map((p) => this._posRow(p)).join('')}</ul>`;
	}

	_posRow(p) {
		const live = p.status === 'open' || p.status === 'closing';
		// Live positions: mark to market — unrealized P&L is current value vs the SOL
		// staked in. Closed positions: the realized P&L the worker booked at exit.
		let pnl;
		let pnlPct;
		if (live) {
			pnl = (p.value_sol != null && p.entry_sol != null) ? p.value_sol - p.entry_sol : null;
			pnlPct = (pnl != null && p.entry_sol > 0) ? (pnl / p.entry_sol) * 100 : null;
		} else {
			pnl = p.pnl_sol;
			pnlPct = p.pnl_pct;
		}
		const cls = pnlPct == null ? '' : pnlPct >= 0 ? 'pos' : 'neg';
		const pnlText = pnl == null
			? (live ? 'pricing…' : '—')
			: `${pnl >= 0 ? '+' : ''}${fmtSol(pnl)} SOL${pnlPct != null ? ` (${fmtPct(pnlPct)})` : ''}`;
		return `
			<li class="tb-pos-row" data-status="${esc(p.status)}">
				<span class="tb-pos-id"><b>${esc(p.symbol || p.name || short(p.mint))}</b>
					${p.entry_sig ? `<a href="${SOLSCAN(esc(p.entry_sig))}" target="_blank" rel="noopener" title="Entry tx">in ↗</a>` : ''}
					${p.exit_sig ? `<a href="${SOLSCAN(esc(p.exit_sig))}" target="_blank" rel="noopener" title="Exit tx">out ↗</a>` : ''}
				</span>
				<span class="tb-pos-state">${live ? `<span class="tb-pos-live">● ${esc(p.status)}</span>` : esc(p.exit_reason || 'closed')}</span>
				<span class="tb-pos-entry">${fmtSol(p.entry_sol)} SOL in</span>
				<span class="tb-pos-pnl ${cls}" title="${live ? 'Unrealized — marked to live price' : 'Realized at exit'}">${pnlText}</span>
				${p.status === 'open' ? `<button class="studio-btn studio-btn-ghost tb-pos-close" data-action="close-pos" data-pos="${esc(p.id)}" title="Sell the full holding now at a real price">Sell now</button>` : `<span class="tb-pos-close-spacer" aria-hidden="true"></span>`}
			</li>`;
	}

	_renderAudit() {
		const host = this._q('[data-audit]');
		if (!host) return;
		const a = this.state.audit || [];
		host.innerHTML = `
			<div class="tb-card-head">
				<h4>Audit log</h4>
				${a.length ? `<button class="studio-btn studio-btn-ghost tb-export" data-action="export-audit">Export CSV</button>` : ''}
			</div>
			${a.length
				? `<ul class="tb-audit-list">${a.slice(0, 30).map((r) => this._auditRow(r)).join('')}</ul>`
				: `<div class="tb-hint">Every decision and execution is logged here, exportable for your records.</div>`}`;
	}

	_auditRow(r) {
		const sol = r.amount_lamports != null ? Number(r.amount_lamports) / 1e9 : null;
		return `
			<li class="tb-audit-row" data-status="${esc(r.status)}">
				<span class="tb-audit-time">${esc(relTime(r.created_at))}</span>
				<span class="tb-audit-what">${esc(r.reason || r.category)}</span>
				<span class="tb-audit-amt">${sol != null ? `${fmtSol(sol)} ${esc(r.asset || 'SOL')}` : ''}${r.usd != null ? ` · ${fmtUsd(r.usd)}` : ''}</span>
				<span class="tb-audit-status tb-audit-${esc(r.status)}">${esc(r.status)}</span>
				${r.signature ? `<a class="tb-audit-tx" href="${SOLSCAN(esc(r.signature))}" target="_blank" rel="noopener" title="View transaction">↗</a>` : ''}
			</li>`;
	}

	// ── Bind ─────────────────────────────────────────────────────────────────────

	_bind() {
		this.el.addEventListener('click', (e) => {
			const btn = e.target.closest('[data-action]');
			if (!btn) return;
			// This studio is mounted inside the Money panel, which has its own click
			// delegate on a parent node. Stop handled clicks here so a shared action
			// name (e.g. "retry") never double-fires across both delegates.
			e.stopPropagation();
			const a = btn.dataset.action;
			if (a === 'retry') return this._load();
			if (a === 'mode') return this._setMode(btn.dataset.mode);
			if (a === 'kill') return this._toggleKill();
			if (a === 'save') return this._saveStrategy();
			if (a === 'backtest') return this._backtest();
			if (a === 'arm') return this._arm();
			if (a === 'disarm') return this._disarm();
			if (a === 'scan') return this._scan();
			if (a === 'confirm-snipe') return this._confirmSnipe(btn.dataset.mint);
			if (a === 'save-guardrails') return this._saveGuardrails();
			if (a === 'preset') return this._applyPreset(btn.dataset.preset);
			if (a === 'close-pos') return this._closePosition(btn.dataset.pos);
			if (a === 'export-audit') return this._exportAudit();
		});
		// Rule edits — live recompute (English + validation) and debounced meta save.
		this.el.addEventListener('input', (e) => {
			const inp = e.target.closest('[data-rule]');
			if (!inp) return;
			this._applyRuleEdit(inp);
		});
		this.el.addEventListener('change', (e) => {
			const inp = e.target.closest('[data-rule][type="checkbox"]');
			if (!inp) return;
			this._applyRuleEdit(inp);
		});
		// Power-user shortcuts, active only while focus is inside this panel:
		//   ⌘/Ctrl+S save · ⌘/Ctrl+B backtest · ⌘/Ctrl+Enter run (scan or arm).
		this._onKey = (e) => {
			if (!(e.metaKey || e.ctrlKey)) return;
			if (!this.el.contains(document.activeElement) && !this.el.matches(':hover')) return;
			const k = e.key.toLowerCase();
			if (k === 's') { e.preventDefault(); this._saveStrategy(); }
			else if (k === 'b') { e.preventDefault(); this._backtest(); }
			else if (k === 'enter') { e.preventDefault(); this.mode === 'autonomous' ? (this._armed ? null : this._arm()) : this._scan(); }
		};
		document.addEventListener('keydown', this._onKey);
	}

	_applyRuleEdit(inp) {
		const path = inp.dataset.rule.split('.');
		let v;
		if (inp.type === 'checkbox') v = inp.checked;
		else if (path[path.length - 1] === 'name') v = inp.value;
		else v = inp.value === '' ? null : Number(inp.value);
		// Set into this.rule by path.
		let obj = this.rule;
		for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]];
		obj[path[path.length - 1]] = v;
		this.state.dirty = true;
		// Live english + validation refresh without stealing focus: update just the
		// english line, the risk meter, and the preset highlight — not the whole builder.
		const eng = this._q('.tb-english');
		if (eng) eng.innerHTML = `<span aria-hidden="true">🗣</span> ${esc(ruleToEnglish(this.rule))}`;
		this._renderRiskMeter();
		this._syncPresetHighlight();
		clearTimeout(this._metaTimer);
		this._metaTimer = setTimeout(() => this._persistMeta(), 700);
	}

	_toast(msg, isError = false) {
		const t = this._q('[data-tbtoast]');
		if (!t) return;
		t.textContent = msg;
		t.hidden = false;
		t.className = `mny-toast tb-toast ${isError ? 'mny-toast-err' : ''} show`;
		clearTimeout(this._toastTimer);
		this._toastTimer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => { t.hidden = true; }, 300); }, 2800);
	}

	destroy() {
		this._destroyed = true;
		this._stopLivePolling();
		if (this._onKey) { document.removeEventListener('keydown', this._onKey); this._onKey = null; }
		clearTimeout(this._metaTimer);
		clearTimeout(this._toastTimer);
	}
}
