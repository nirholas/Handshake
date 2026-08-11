/**
 * Agent token plan panel: the agent's coin before the coin exists.
 *
 * An agent token is the economic object an agent becomes. Until it mints, that
 * object had nowhere to live: the launch form collected a name and a ticker,
 * threw them away on cancel, and the profile showed a bare "Launch agent token"
 * button that said nothing about what would launch. This panel is the missing
 * half: the saved configuration, rendered on the profile, owned by the agent.
 *
 * Three audiences, three renders:
 *   - owner, no plan      → the designer: name, ticker, story, and mechanics.
 *   - owner, saved plan   → the same form plus readiness, cost, and a free
 *                           devnet rehearsal that compiles and simulates the
 *                           real launch transaction without broadcasting it.
 *   - visitor, ready plan → a quiet "coming: $TICKER" card. Drafts stay private;
 *                           the API never sends them to a visitor.
 *
 * Once the coin mints, the plan flips to `launched` and this panel steps aside:
 * the live market chip and launch history on the same card take over.
 *
 * Backed by GET/PUT /api/agents/tokens/plan and POST /api/agents/tokens/plan-dry-run.
 */

const API = '/api/agents/tokens';
const STYLE_ID = 'tws-agent-token-plan-styles';

function esc(s) {
	return String(s == null ? '' : s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

function fmtSol(n) {
	const v = Number(n) || 0;
	if (v === 0) return '0 SOL';
	if (v < 0.001) return `${v.toFixed(6).replace(/0+$/, '')} SOL`;
	return `${v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} SOL`;
}

function fmtPct(bps) {
	const v = Number(bps) || 0;
	return `${(v / 100).toFixed(v % 100 === 0 ? 0 : 1)}%`;
}

const VERDICT_COPY = {
	would_succeed: {
		tone: 'ok',
		title: 'Rehearsal passed',
		body: 'The launch transaction compiled and the cluster executed it end to end. Nothing was broadcast and nothing was minted.',
	},
	funding_required: {
		tone: 'warn',
		title: 'Rehearsal passed, wallet unfunded',
		body: 'The transaction is valid; the launch wallet just cannot cover it yet on this cluster. Fund it and rerun.',
	},
	would_fail: {
		tone: 'err',
		title: 'Rehearsal failed on chain',
		body: 'The cluster rejected the launch. The program logs below say why.',
	},
	compile_failed: {
		tone: 'err',
		title: 'Transaction would not build',
		body: 'The launch could not even be assembled, so a real launch would have died at signing time.',
	},
	rpc_unavailable: {
		tone: 'warn',
		title: 'Cluster unreachable',
		body: 'The transaction built correctly, but the RPC endpoint did not answer the simulation. Try again shortly.',
	},
};

const STYLES = `
.atp { margin-top: 14px; border-top: 1px solid var(--ad-line, rgba(255,255,255,.08)); padding-top: 14px; }
.atp-eyebrow { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--ad-muted, rgba(231,233,238,.55)); margin-bottom: 8px; }
.atp-skel { height: 54px; border-radius: 10px; background: linear-gradient(90deg, rgba(255,255,255,.04), rgba(255,255,255,.09), rgba(255,255,255,.04)); background-size: 200% 100%; animation: atp-shimmer 1.2s linear infinite; }
@keyframes atp-shimmer { from { background-position: 200% 0 } to { background-position: -200% 0 } }
@media (prefers-reduced-motion: reduce) { .atp-skel { animation: none } }
.atp-note { font-size: 12.5px; line-height: 1.5; color: var(--ad-muted, rgba(231,233,238,.55)); margin: 0; }
.atp-err { font-size: 12.5px; color: #ff8f8f; margin: 0 0 8px; }

.atp-summary { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 12px; }
.atp-ticker { font-size: 15px; font-weight: 600; letter-spacing: .02em; color: var(--ad-text, #e7e9ee); }
.atp-name { font-size: 13px; color: var(--ad-muted, rgba(231,233,238,.55)); }
.atp-pill { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(255,255,255,.14); color: var(--ad-muted, rgba(231,233,238,.6)); }
.atp-pill.ready { border-color: rgba(87,199,133,.4); color: #7fdca6; }
.atp-pill.draft { border-color: rgba(255,193,94,.4); color: #ffc15e; }
.atp-desc { font-size: 12.5px; line-height: 1.55; color: var(--ad-muted, rgba(231,233,238,.62)); margin: 8px 0 0; }
.atp-facts { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 10px; font-size: 12px; color: var(--ad-muted, rgba(231,233,238,.55)); }
.atp-facts b { font-weight: 600; color: var(--ad-text, #e7e9ee); }

.atp-form { display: grid; gap: 10px; margin-top: 6px; }
.atp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.atp-field { display: grid; gap: 4px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--ad-muted, rgba(231,233,238,.55)); }
.atp-field input, .atp-field select, .atp-field textarea {
	font: inherit; font-size: 13px; text-transform: none; letter-spacing: normal;
	color: var(--ad-text, #e7e9ee); background: rgba(255,255,255,.04);
	border: 1px solid rgba(255,255,255,.12); border-radius: 8px; padding: 7px 9px; width: 100%;
	transition: border-color .12s ease, background .12s ease;
}
.atp-field textarea { resize: vertical; min-height: 58px; }
.atp-field input:hover, .atp-field select:hover, .atp-field textarea:hover { border-color: rgba(255,255,255,.22); }
.atp-field input:focus-visible, .atp-field select:focus-visible, .atp-field textarea:focus-visible {
	outline: 2px solid var(--ad-cyan, #57c7ff); outline-offset: 1px; border-color: transparent;
}
.atp-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.atp-btn {
	font: inherit; font-size: 12.5px; cursor: pointer; border-radius: 8px; padding: 7px 12px;
	border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.05);
	color: var(--ad-text, #e7e9ee); transition: background .12s ease, border-color .12s ease, transform .08s ease;
}
.atp-btn:hover:not(:disabled) { background: rgba(255,255,255,.1); border-color: rgba(255,255,255,.28); }
.atp-btn:active:not(:disabled) { transform: translateY(1px); }
.atp-btn:focus-visible { outline: 2px solid var(--ad-cyan, #57c7ff); outline-offset: 2px; }
.atp-btn:disabled { opacity: .5; cursor: not-allowed; }
.atp-btn.primary { border-color: rgba(87,199,255,.45); background: rgba(87,199,255,.14); }
.atp-btn.primary:hover:not(:disabled) { background: rgba(87,199,255,.22); }
.atp-status { font-size: 12px; margin: 0; color: var(--ad-muted, rgba(231,233,238,.55)); }
.atp-status.ok { color: #7fdca6; }
.atp-status.err { color: #ff8f8f; }

.atp-checks { list-style: none; margin: 6px 0 0; padding: 0; display: grid; gap: 3px; font-size: 12px; }
.atp-checks li { color: var(--ad-muted, rgba(231,233,238,.6)); }
.atp-checks li.block { color: #ff8f8f; }
.atp-checks li.warn { color: #ffc15e; }

.atp-verdict { margin-top: 10px; border: 1px solid rgba(255,255,255,.1); border-radius: 10px; padding: 10px 12px; }
.atp-verdict.ok { border-color: rgba(87,199,133,.35); }
.atp-verdict.warn { border-color: rgba(255,193,94,.35); }
.atp-verdict.err { border-color: rgba(255,143,143,.35); }
.atp-verdict-title { font-size: 12.5px; font-weight: 600; color: var(--ad-text, #e7e9ee); }
.atp-verdict-body { font-size: 12px; line-height: 1.5; color: var(--ad-muted, rgba(231,233,238,.6)); margin: 4px 0 0; }
.atp-logs { margin: 8px 0 0; }
.atp-logs summary { font-size: 11.5px; cursor: pointer; color: var(--ad-muted, rgba(231,233,238,.55)); }
.atp-logs summary:focus-visible { outline: 2px solid var(--ad-cyan, #57c7ff); outline-offset: 2px; border-radius: 4px; }
.atp-logs pre { margin: 6px 0 0; padding: 8px; max-height: 190px; overflow: auto; font-size: 11px; line-height: 1.45;
	background: rgba(0,0,0,.28); border-radius: 8px; color: var(--ad-muted, rgba(231,233,238,.6)); white-space: pre-wrap; word-break: break-word; }
`;

function injectStyles(doc) {
	if (!doc || doc.getElementById(STYLE_ID)) return;
	const el = doc.createElement('style');
	el.id = STYLE_ID;
	el.textContent = STYLES;
	doc.head.appendChild(el);
}

/**
 * Read-only summary of a plan, for anyone.
 * @param {object} plan shaped plan from the API
 */
export function planSummaryHTML(plan) {
	if (!plan) return '';
	const launched = plan.status === 'launched';
	const pillClass = launched ? 'ready' : plan.readiness?.ready ? 'ready' : 'draft';
	const pillText = launched ? 'Launched' : plan.readiness?.ready ? 'Ready to launch' : 'Draft';
	const facts = [
		`<span>Pairing <b>${esc(plan.quote_currency === 'usdc' ? 'USDC' : 'SOL')}</b></span>`,
		plan.coin_type === 'agent'
			? `<span>Buyback <b>${esc(fmtPct(plan.buyback_bps))}</b></span>`
			: `<span>Type <b>${esc(plan.coin_type)}</b></span>`,
		plan.quote_currency === 'usdc'
			? `<span>Dev buy <b>${esc(String(plan.usdc_buy_in))} USDC</b></span>`
			: `<span>Dev buy <b>${esc(fmtSol(plan.sol_buy_in))}</b></span>`,
		`<span>Network <b>${esc(plan.network)}</b></span>`,
	].join('');
	const mintLink = launched && plan.mint && plan.network === 'mainnet'
		? `<p class="atp-note" style="margin-top:8px"><a href="/launches/${esc(plan.mint)}">View the coin this plan became &rarr;</a></p>`
		: '';
	return `
		<div class="atp-summary">
			<span class="atp-ticker">$${esc(plan.symbol || '?')}</span>
			<span class="atp-name">${esc(plan.name || 'Untitled coin')}</span>
			<span class="atp-pill ${pillClass}">${esc(pillText)}</span>
		</div>
		${plan.description ? `<p class="atp-desc">${esc(plan.description)}</p>` : ''}
		<div class="atp-facts">${facts}</div>
		${mintLink}`;
}

/** Blockers and warnings as a readable checklist. */
function checksHTML(readiness) {
	if (!readiness) return '';
	const rows = [
		...(readiness.blockers || []).map((b) => `<li class="block">${esc(b)}</li>`),
		...(readiness.warnings || []).map((w) => `<li class="warn">${esc(w)}</li>`),
	];
	if (!rows.length) return `<ul class="atp-checks"><li>Everything this launch needs is set.</li></ul>`;
	return `<ul class="atp-checks">${rows.join('')}</ul>`;
}

/** The last dry-run verdict, rendered. */
export function verdictHTML(result) {
	if (!result) return '';
	const copy = VERDICT_COPY[result.verdict];
	if (!copy) return '';
	const lines = [];
	if (result.tx_bytes != null) lines.push(`Transaction ${result.tx_bytes} bytes of the 1232 Solana allows`);
	if (result.simulation?.units_consumed != null) lines.push(`${result.simulation.units_consumed} compute units`);
	if (result.mint_preview) lines.push(`rehearsal mint ${result.mint_preview.slice(0, 6)}…`);
	const logs = result.simulation?.logs || [];
	const logBlock = logs.length
		? `<details class="atp-logs"><summary>Cluster logs (${logs.length})</summary><pre>${esc(logs.join('\n'))}</pre></details>`
		: '';
	const simError = result.simulation?.error
		? `<p class="atp-verdict-body">${esc(result.simulation.error)}</p>`
		: '';
	const compileError = result.compile_error
		? `<p class="atp-verdict-body">${esc(result.compile_error)}</p>`
		: '';
	return `
		<div class="atp-verdict ${copy.tone}">
			<div class="atp-verdict-title">${esc(copy.title)}</div>
			<p class="atp-verdict-body">${esc(copy.body)}</p>
			${compileError}${simError}
			${lines.length ? `<p class="atp-verdict-body">${esc(lines.join(' · '))}</p>` : ''}
			${logBlock}
		</div>`;
}

function editorHTML(plan, network) {
	const p = plan || {};
	const sel = (v, want) => (v === want ? ' selected' : '');
	return `
		<form class="atp-form" novalidate>
			<div class="atp-grid">
				<label class="atp-field">Coin name
					<input name="name" maxlength="32" value="${esc(p.name || '')}" placeholder="Ada's Ledger" autocomplete="off" />
				</label>
				<label class="atp-field">Ticker
					<input name="symbol" maxlength="10" value="${esc(p.symbol || '')}" placeholder="ADA" autocomplete="off" />
				</label>
			</div>
			<label class="atp-field">What the coin is for
				<textarea name="description" maxlength="280" placeholder="One or two lines a holder would read before buying.">${esc(p.description || '')}</textarea>
			</label>
			<div class="atp-grid">
				<label class="atp-field">Image URL
					<input name="image_url" type="url" value="${esc(p.image_url || '')}" placeholder="https://…" autocomplete="off" />
				</label>
				<label class="atp-field">Website
					<input name="website" type="url" value="${esc(p.website || '')}" placeholder="https://…" autocomplete="off" />
				</label>
			</div>
			<div class="atp-grid">
				<label class="atp-field">Coin type
					<select name="coin_type">
						<option value="agent"${sel(p.coin_type, 'agent')}>Agent coin (buyback bound)</option>
						<option value="regular"${sel(p.coin_type, 'regular')}>Regular coin</option>
						<option value="mayhem"${sel(p.coin_type, 'mayhem')}>Mayhem mode</option>
					</select>
				</label>
				<label class="atp-field">Paired with
					<select name="quote_currency">
						<option value="sol"${sel(p.quote_currency, 'sol')}>SOL</option>
						<option value="usdc"${sel(p.quote_currency, 'usdc')}>USDC</option>
					</select>
				</label>
				<label class="atp-field">Buyback share
					<input name="buyback_bps" type="number" min="0" max="10000" step="100" value="${esc(String(p.buyback_bps ?? 0))}" />
				</label>
			</div>
			<div class="atp-grid">
				<label class="atp-field">Dev buy (SOL)
					<input name="sol_buy_in" type="number" min="0" max="50" step="0.01" value="${esc(String(p.sol_buy_in ?? 0))}" />
				</label>
				<label class="atp-field">Dev buy (USDC)
					<input name="usdc_buy_in" type="number" min="0" max="1000000" step="1" value="${esc(String(p.usdc_buy_in ?? 0))}" />
				</label>
			</div>
			<div class="atp-actions">
				<button type="submit" class="atp-btn primary" data-act="save">Save plan</button>
				<button type="button" class="atp-btn" data-act="dry-run">Rehearse on devnet</button>
				<p class="atp-status" data-role="status" role="status" aria-live="polite"></p>
			</div>
		</form>
		<p class="atp-note">Saving costs nothing and mints nothing. The rehearsal builds the real launch transaction and asks Solana devnet to execute it without broadcasting, so you see what would happen before any money moves. Launching on ${esc(network)} is a separate, deliberate step.</p>`;
}

/**
 * Mount the plan panel.
 *
 * @param {HTMLElement} host mount node (appended to, never cleared)
 * @param {{ agentId: string, isOwner?: boolean, network?: string, onReveal?: () => void }} opts
 * @returns {{ destroy: () => void, refresh: () => Promise<void> }}
 */
export function mountAgentTokenPlan(host, opts = {}) {
	const { agentId, isOwner = false, network = 'mainnet', onReveal } = opts;
	if (!host || !agentId) return { destroy() {}, refresh: async () => {} };

	injectStyles(host.ownerDocument || document);
	const root = (host.ownerDocument || document).createElement('div');
	root.className = 'atp';
	root.innerHTML = `<div class="atp-eyebrow">Agent token</div><div class="atp-skel" aria-hidden="true"></div>`;
	host.appendChild(root);

	const controller = new AbortController();
	let destroyed = false;
	let state = { plan: null, isOwner, launchWallet: null };

	function setStatus(text, kind) {
		const el = root.querySelector('[data-role="status"]');
		if (!el) return;
		el.textContent = text || '';
		el.className = `atp-status${kind ? ' ' + kind : ''}`;
	}

	function readForm() {
		const form = root.querySelector('form');
		if (!form) return null;
		const v = (n) => form.elements[n]?.value ?? '';
		return {
			agent_id: agentId,
			network,
			name: v('name').trim(),
			symbol: v('symbol').trim().toUpperCase(),
			description: v('description').trim(),
			image_url: v('image_url').trim(),
			website: v('website').trim(),
			coin_type: v('coin_type'),
			quote_currency: v('quote_currency'),
			buyback_bps: Number(v('buyback_bps')) || 0,
			sol_buy_in: Number(v('sol_buy_in')) || 0,
			usdc_buy_in: Number(v('usdc_buy_in')) || 0,
		};
	}

	function render() {
		if (destroyed) return;
		const { plan } = state;

		// Visitor with nothing to show: leave no empty shell behind.
		if (!state.isOwner && !plan) {
			root.remove();
			return;
		}

		if (!state.isOwner) {
			root.innerHTML =
				`<div class="atp-eyebrow">Agent token</div>` +
				planSummaryHTML(plan) +
				(plan.status === 'launched'
					? ''
					: `<p class="atp-note" style="margin-top:8px">This coin is configured but has not launched yet. Nothing has been minted.</p>`);
			onReveal?.();
			return;
		}

		root.innerHTML =
			`<div class="atp-eyebrow">Agent token</div>` +
			(plan ? planSummaryHTML(plan) : `<p class="atp-note">This agent has no coin yet. Design one here: it saves as a plan on its record, and nothing mints until you choose to launch.</p>`) +
			(plan ? checksHTML(plan.readiness) : '') +
			(plan?.status === 'launched' ? '' : editorHTML(plan, network)) +
			verdictHTML(plan?.last_dry_run);

		if (plan?.cost_estimate && plan.status !== 'launched') {
			const note = (host.ownerDocument || document).createElement('p');
			note.className = 'atp-note';
			note.textContent = `Estimated launch cost: ${fmtSol(plan.cost_estimate.total_sol)} in rent and fees${plan.cost_estimate.dev_buy_usdc ? ` plus ${plan.cost_estimate.dev_buy_usdc} USDC for the dev buy` : ''}.`;
			root.appendChild(note);
		}
		onReveal?.();
	}

	async function load() {
		try {
			const r = await fetch(
				`${API}/plan?agent_id=${encodeURIComponent(agentId)}&network=${encodeURIComponent(network)}`,
				{ credentials: 'include', signal: controller.signal },
			);
			if (!r.ok) throw new Error(`plan request failed (${r.status})`);
			const j = await r.json();
			state = {
				plan: j.plan || null,
				isOwner: !!j.is_owner || isOwner,
				launchWallet: j.launch_wallet || null,
			};
			render();
		} catch (err) {
			if (destroyed || err?.name === 'AbortError') return;
			if (!isOwner) {
				root.remove();
				return;
			}
			root.innerHTML =
				`<div class="atp-eyebrow">Agent token</div>` +
				`<p class="atp-err">Could not load this agent's token plan.</p>` +
				`<button type="button" class="atp-btn" data-act="retry">Try again</button>`;
		}
	}

	async function save() {
		const body = readForm();
		if (!body) return;
		setStatus('Saving…');
		try {
			const r = await fetch(`${API}/plan`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				credentials: 'include',
				signal: controller.signal,
				body: JSON.stringify(body),
			});
			const j = await r.json().catch(() => ({}));
			if (!r.ok) throw new Error(j.error_description || j.error || 'Save failed');
			state.plan = j.plan || null;
			render();
			setStatus(
				state.plan?.readiness?.ready ? 'Saved. This plan is ready to launch.' : 'Saved as a draft.',
				'ok',
			);
		} catch (err) {
			if (err?.name === 'AbortError') return;
			setStatus(err.message || 'Save failed', 'err');
		}
	}

	async function dryRun() {
		// Rehearse exactly what is on screen: save first so the server simulates
		// the same configuration the owner is looking at.
		const body = readForm();
		if (!body) return;
		setStatus('Saving, then rehearsing on devnet…');
		try {
			const saveRes = await fetch(`${API}/plan`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				credentials: 'include',
				signal: controller.signal,
				body: JSON.stringify({ ...body, network: 'devnet' }),
			});
			const saved = await saveRes.json().catch(() => ({}));
			if (!saveRes.ok) throw new Error(saved.error_description || saved.error || 'Save failed');

			const r = await fetch(`${API}/plan-dry-run`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'include',
				signal: controller.signal,
				body: JSON.stringify({ agent_id: agentId, network: 'devnet' }),
			});
			const j = await r.json().catch(() => ({}));
			if (!r.ok && j?.code !== 'plan_not_ready') {
				throw new Error(j.error_description || j.error || 'Rehearsal failed to run');
			}
			if (j?.code === 'plan_not_ready') {
				state.plan = j.plan || state.plan;
				render();
				setStatus('Finish the checklist above, then rehearse again.', 'err');
				return;
			}
			state.plan = j.plan || state.plan;
			render();
			setStatus('Rehearsal complete. Nothing was broadcast.', 'ok');
		} catch (err) {
			if (err?.name === 'AbortError') return;
			setStatus(err.message || 'Rehearsal failed to run', 'err');
		}
	}

	root.addEventListener('click', (e) => {
		const btn = e.target.closest?.('[data-act]');
		if (!btn) return;
		const act = btn.dataset.act;
		if (act === 'retry') {
			root.innerHTML = `<div class="atp-eyebrow">Agent token</div><div class="atp-skel" aria-hidden="true"></div>`;
			load();
		} else if (act === 'dry-run') {
			btn.disabled = true;
			dryRun().finally(() => {
				const live = root.querySelector('[data-act="dry-run"]');
				if (live) live.disabled = false;
			});
		}
	});
	root.addEventListener('submit', (e) => {
		e.preventDefault();
		const btn = root.querySelector('[data-act="save"]');
		if (btn) btn.disabled = true;
		save().finally(() => {
			const live = root.querySelector('[data-act="save"]');
			if (live) live.disabled = false;
		});
	});

	load();

	return {
		destroy() {
			destroyed = true;
			controller.abort();
			root.remove();
		},
		refresh: load,
	};
}
