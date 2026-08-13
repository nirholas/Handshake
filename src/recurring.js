/**
 * /recurring: the product surface for recurring on-chain payments.
 *
 * Two schedule kinds, one lifecycle:
 *   - subscriptions (`/api/agent-subscriptions`) transfer a fixed USDC amount
 *     per period inside a signed ERC-7710 permission.
 *   - DCA strategies (`/api/dca-strategies`) spend the same kind of permission
 *     but swap the result into a token.
 *
 * Everything on this page is driven by real API data. The charge and execution
 * histories come from the ledgers the hourly crons write (subscription_charges
 * and dca_executions), so a failed period shows the reason the cron recorded
 * rather than a generic "something went wrong".
 */

import { apiFetch } from './api.js';

const $ = (id) => document.getElementById(id);

const state = {
	signedIn: true,
	agents: [],
	agentId: '',
	outgoing: null,
	incoming: null,
	dca: null,
	openHistory: new Set(),
	busy: new Set(),
};

const AGENT_KEY = 'recurring:agentId';

// ── Small helpers ───────────────────────────────────────────────────────────

function esc(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

function shortAddr(a) {
	if (!a || a.length < 12) return a || 'unknown';
	return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** Relative time that stays readable in both directions ("in 3h", "5d ago"). */
function relTime(iso) {
	if (!iso) return 'never';
	const ms = new Date(iso).getTime() - Date.now();
	if (!Number.isFinite(ms)) return 'unknown';
	const abs = Math.abs(ms);
	const units = [
		[86400000, 'd'],
		[3600000, 'h'],
		[60000, 'm'],
	];
	for (const [size, label] of units) {
		if (abs >= size) {
			const n = Math.round(abs / size);
			return ms > 0 ? `in ${n}${label}` : `${n}${label} ago`;
		}
	}
	return ms > 0 ? 'in under a minute' : 'just now';
}

function absTime(iso) {
	if (!iso) return '';
	const d = new Date(iso);
	return Number.isFinite(d.getTime()) ? d.toLocaleString() : '';
}

function toast(message, bad = false) {
	const el = document.createElement('div');
	el.className = `toast${bad ? ' bad' : ''}`;
	el.textContent = message;
	$('toasts').appendChild(el);
	requestAnimationFrame(() => el.classList.add('show'));
	setTimeout(() => {
		el.classList.remove('show');
		setTimeout(() => el.remove(), 220);
	}, 3600);
}

/** Read a JSON body whatever the endpoint's envelope is, without throwing. */
async function readBody(res) {
	return res.json().catch(() => ({}));
}

function statusPill(status) {
	const map = {
		active: ['ok', 'Active'],
		paused: ['warn', 'Paused'],
		canceled: ['dim', 'Canceled'],
		cancelled: ['dim', 'Cancelled'],
		expired: ['bad', 'Expired'],
	};
	const [cls, label] = map[status] || ['dim', status || 'unknown'];
	return `<span class="pill ${cls}">${esc(label)}</span>`;
}

function chargeStatusPill(status) {
	const map = {
		success: ['ok', 'Paid'],
		failed: ['bad', 'Failed'],
		aborted: ['warn', 'Stopped'],
		unknown: ['warn', 'Unverified'],
		pending: ['dim', 'Pending'],
	};
	const [cls, label] = map[status] || ['dim', status || 'unknown'];
	return `<span class="pill ${cls}">${esc(label)}</span>`;
}

function stat(k, v, sub) {
	return `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}${
		sub ? ` <small>${esc(sub)}</small>` : ''
	}</div></div>`;
}

function skeleton(n = 2) {
	return `<div class="cards">${'<div class="skel skel-card"></div>'.repeat(n)}</div>`;
}

function emptyState({ icon, title, body, action }) {
	return `<div class="state">
		<div class="icon" aria-hidden="true">${icon}</div>
		<h3>${esc(title)}</h3>
		<p>${body}</p>
		${action ? `<div class="actions">${action}</div>` : ''}
	</div>`;
}

function errorState(message, retryAction) {
	return emptyState({
		icon: '⚠️',
		title: 'Could not load your schedules',
		body: `${esc(message)} Nothing was changed. Try again, and if it keeps failing the API is likely down rather than your schedules.`,
		action: `<button data-retry="${esc(retryAction)}">Try again</button>`,
	});
}

function signedOutState() {
	return emptyState({
		icon: '🔐',
		title: 'Sign in to see your schedules',
		body: 'Recurring payments spend a permission you signed with your own wallet, so they are only visible to the account that created them.',
		action: '<a class="btn" href="/login">Sign in</a>',
	});
}

// ── Data loading ────────────────────────────────────────────────────────────

async function loadAgents() {
	const res = await apiFetch('/api/agents', { allowAnonymous: true });
	if (res.status === 401) {
		state.signedIn = false;
		return;
	}
	const body = await readBody(res);
	state.agents = Array.isArray(body.agents) ? body.agents : [];
	const saved = localStorage.getItem(AGENT_KEY);
	state.agentId =
		saved && state.agents.some((a) => a.id === saved) ? saved : (state.agents[0]?.id ?? '');
}

async function loadOutgoing() {
	state.outgoing = { loading: true };
	renderOutgoing();
	try {
		const res = await apiFetch('/api/agent-subscriptions', { allowAnonymous: true });
		if (res.status === 401) {
			state.signedIn = false;
			state.outgoing = { loading: false, rows: [], summary: null };
		} else if (!res.ok) {
			const body = await readBody(res);
			state.outgoing = { loading: false, error: body.error_description || `HTTP ${res.status}` };
		} else {
			const body = await readBody(res);
			state.outgoing = { loading: false, rows: body.data || [], summary: body.summary || null };
		}
	} catch (err) {
		state.outgoing = { loading: false, error: err.message || 'network error' };
	}
	renderOutgoing();
}

async function loadIncoming() {
	state.incoming = { loading: true };
	renderIncoming();
	try {
		const res = await apiFetch('/api/agent-subscriptions?view=incoming', {
			allowAnonymous: true,
		});
		if (res.status === 401) {
			state.signedIn = false;
			state.incoming = { loading: false, rows: [], summary: null };
		} else if (!res.ok) {
			const body = await readBody(res);
			state.incoming = { loading: false, error: body.error_description || `HTTP ${res.status}` };
		} else {
			const body = await readBody(res);
			state.incoming = { loading: false, rows: body.data || [], summary: body.summary || null };
		}
	} catch (err) {
		state.incoming = { loading: false, error: err.message || 'network error' };
	}
	renderIncoming();
}

async function loadDca() {
	if (!state.agentId) {
		state.dca = { loading: false, rows: [] };
		renderDca();
		return;
	}
	state.dca = { loading: true };
	renderDca();
	try {
		const res = await apiFetch(
			`/api/dca-strategies?agent_id=${encodeURIComponent(state.agentId)}`,
			{ allowAnonymous: true },
		);
		if (res.status === 401) {
			state.signedIn = false;
			state.dca = { loading: false, rows: [] };
		} else if (!res.ok) {
			const body = await readBody(res);
			state.dca = { loading: false, error: body.error_description || `HTTP ${res.status}` };
		} else {
			const body = await readBody(res);
			state.dca = { loading: false, rows: body.data || [] };
		}
	} catch (err) {
		state.dca = { loading: false, error: err.message || 'network error' };
	}
	renderDca();
}

async function loadCharges(id) {
	const res = await apiFetch(`/api/agent-subscriptions?id=${encodeURIComponent(id)}`, {
		allowAnonymous: true,
	});
	if (!res.ok) throw new Error((await readBody(res)).error_description || `HTTP ${res.status}`);
	return (await readBody(res)).data;
}

// ── Rendering ───────────────────────────────────────────────────────────────

function historyTable(charges) {
	if (!charges?.length) {
		return '<p class="muted" style="font-size:12.5px;margin:.5rem 0 0">No charge has run yet. The first one fires on the next hourly tick after the due time.</p>';
	}
	const rows = charges
		.map(
			(c) => `<tr>
				<td>${esc(absTime(c.charged_at))}</td>
				<td>${chargeStatusPill(c.status)}</td>
				<td>${esc(c.amount_display)} <small class="muted">USDC</small></td>
				<td class="reason">${
					c.tx_hash
						? `<span class="mono">${esc(shortAddr(c.tx_hash))}</span>`
						: esc(c.error || c.code || '')
				}</td>
			</tr>`,
		)
		.join('');
	return `<div class="scroll-x"><table>
		<thead><tr><th>When</th><th>Result</th><th>Amount</th><th>Transaction or reason</th></tr></thead>
		<tbody>${rows}</tbody>
	</table></div>`;
}

function subscriptionCard(s, { role }) {
	const open = state.openHistory.has(s.id);
	const busy = state.busy.has(s.id);
	const canPause = role === 'payer' && s.status === 'active';
	const canResume = role === 'payer' && s.status === 'paused';
	const canCancel = role === 'payer' && s.status !== 'canceled';

	const failureNotice =
		s.status === 'paused' && s.last_error
			? `<div class="notice bad"><strong>Paused:</strong> ${esc(s.last_error)}</div>`
			: s.status === 'active' && s.last_error
				? `<div class="notice warn"><strong>Last run failed:</strong> ${esc(s.last_error)} ${
						s.retries_left
							? `${s.retries_left} more attempt${s.retries_left === 1 ? '' : 's'} before it pauses.`
							: ''
					}</div>`
				: '';

	const counterparty =
		role === 'creator'
			? `<div><span class="mk">from</span><span class="mv">${esc(shortAddr(s.payer_address))}</span></div>`
			: `<div><span class="mk">to</span><span class="mv">${esc(shortAddr(s.payee_address))}</span></div>`;

	return `<article class="card" data-sub="${esc(s.id)}">
		<div class="card-top">
			<div>
				<div class="card-title">${esc(s.agent_name || 'Untitled agent')} ${statusPill(s.status)}</div>
				<div class="card-sub">${esc(s.amount_display)} USDC ${esc(s.period_label)}${
					s.chain_id ? ` on chain ${esc(String(s.chain_id))}` : ''
				}</div>
			</div>
			<div class="amount">${esc(s.charged_total_display)} <small>USDC paid</small></div>
		</div>

		<div class="meta">
			<div><span class="mk">next</span><span class="mv">${esc(
				s.status === 'active' ? relTime(s.next_charge_at) : 'not scheduled',
			)}</span></div>
			<div><span class="mk">last</span><span class="mv">${esc(relTime(s.last_charge_at))}</span></div>
			<div><span class="mk">charges</span><span class="mv">${esc(String(s.charges_total))}</span></div>
			${counterparty}
			<div><span class="mk">permission</span><span class="mv">${esc(s.delegation_status || 'unknown')}</span></div>
		</div>

		${failureNotice}

		<div class="actions">
			<button data-act="history" data-id="${esc(s.id)}" aria-expanded="${open}">${
				open ? 'Hide charges' : 'View charges'
			}</button>
			${canPause ? `<button data-act="pause" data-id="${esc(s.id)}"${busy ? ' disabled' : ''}>Pause</button>` : ''}
			${canResume ? `<button class="primary" data-act="resume" data-id="${esc(s.id)}"${busy ? ' disabled' : ''}>Resume</button>` : ''}
			${canCancel ? `<button class="danger" data-act="cancel" data-id="${esc(s.id)}"${busy ? ' disabled' : ''}>Cancel</button>` : ''}
		</div>

		${open ? `<div class="history" data-history="${esc(s.id)}">${historyTable(s.charges)}</div>` : ''}
	</article>`;
}

function renderOutgoing() {
	const body = $('out-body');
	const stats = $('out-stats');
	const o = state.outgoing;

	if (!state.signedIn) {
		stats.classList.add('hidden');
		body.innerHTML = signedOutState();
		$('count-outgoing').textContent = '';
		return;
	}
	if (!o || o.loading) {
		stats.classList.add('hidden');
		body.innerHTML = skeleton(2);
		return;
	}
	if (o.error) {
		stats.classList.add('hidden');
		body.innerHTML = errorState(o.error, 'outgoing');
		return;
	}

	$('count-outgoing').textContent = o.rows.length ? String(o.rows.length) : '';

	if (o.summary && o.rows.length) {
		stats.classList.remove('hidden');
		stats.innerHTML =
			stat('Active schedules', String(o.summary.active), `of ${o.summary.schedules}`) +
			stat('Paid so far', o.summary.paid_total_display, 'USDC') +
			stat('Charges run', String(o.summary.charges_total)) +
			stat('Next charge', relTime(o.summary.next_charge_at));
	} else {
		stats.classList.add('hidden');
	}

	if (!o.rows.length) {
		body.innerHTML = emptyState({
			icon: '🔁',
			title: 'No recurring payments yet',
			body: 'Create one above with a permission you have already signed, or grant a new permission on an agent first. Every schedule you create shows up here with its full charge history.',
		});
		return;
	}

	body.innerHTML = `<div class="cards">${o.rows
		.map((s) => subscriptionCard(s, { role: 'payer' }))
		.join('')}</div>`;
}

function renderIncoming() {
	const body = $('in-body');
	const stats = $('in-stats');
	const i = state.incoming;

	if (!state.signedIn) {
		stats.classList.add('hidden');
		body.innerHTML = signedOutState();
		$('count-incoming').textContent = '';
		return;
	}
	if (!i || i.loading) {
		stats.classList.add('hidden');
		body.innerHTML = skeleton(2);
		return;
	}
	if (i.error) {
		stats.classList.add('hidden');
		body.innerHTML = errorState(i.error, 'incoming');
		return;
	}

	$('count-incoming').textContent = i.rows.length ? String(i.rows.length) : '';

	if (i.summary && i.rows.length) {
		stats.classList.remove('hidden');
		stats.innerHTML =
			stat('Paying schedules', String(i.summary.active), `of ${i.summary.schedules}`) +
			stat('Received', i.summary.received_total_display, 'USDC') +
			stat('Charges received', String(i.summary.charges_total)) +
			stat('Next arrival', relTime(i.summary.next_charge_at));
	} else {
		stats.classList.add('hidden');
	}

	if (!i.rows.length) {
		body.innerHTML = emptyState({
			icon: '📥',
			title: 'Nothing is paying into your agents yet',
			body: 'When a recurring payment is pointed at an agent you own, it appears here with the paying wallet, the amount per period and every charge it has settled.',
			action: '<a class="btn" href="/agents">Open your agents</a>',
		});
		return;
	}

	body.innerHTML = `<div class="cards">${i.rows
		.map((s) => subscriptionCard(s, { role: 'creator' }))
		.join('')}</div>`;
}

function dcaCard(s) {
	const busy = state.busy.has(s.id);
	const last = s.last_execution;
	const notice =
		s.status === 'paused' && s.last_error
			? `<div class="notice bad"><strong>Paused:</strong> ${esc(s.last_error)}</div>`
			: s.last_error
				? `<div class="notice warn"><strong>Last run:</strong> ${esc(s.last_error)}</div>`
				: '';

	return `<article class="card" data-dca="${esc(s.id)}">
		<div class="card-top">
			<div>
				<div class="card-title">USDC into ${esc(s.token_out_symbol)} ${statusPill(s.status)}</div>
				<div class="card-sub">${esc(s.amount_display)} USDC ${esc(s.period_label)} on chain ${esc(
					String(s.chain_id),
				)}, ${esc(String(s.slippage_bps))} bps max slippage</div>
			</div>
			<div class="amount">${esc(String(s.executions_total ?? 0))} <small>swaps filled</small></div>
		</div>

		<div class="meta">
			<div><span class="mk">next</span><span class="mv">${esc(
				s.status === 'active' ? relTime(s.next_execution_at) : 'not scheduled',
			)}</span></div>
			<div><span class="mk">last</span><span class="mv">${esc(relTime(s.last_execution_at))}</span></div>
			${
				last?.tx_hash
					? `<div><span class="mk">last tx</span><span class="mv">${esc(shortAddr(last.tx_hash))}</span></div>`
					: ''
			}
		</div>

		${notice}

		<div class="actions">
			${
				s.status === 'active'
					? `<button data-dact="pause" data-id="${esc(s.id)}"${busy ? ' disabled' : ''}>Pause</button>`
					: ''
			}
			${
				s.status === 'paused'
					? `<button class="primary" data-dact="resume" data-id="${esc(s.id)}"${busy ? ' disabled' : ''}>Resume</button>`
					: ''
			}
			${
				s.status !== 'cancelled'
					? `<button class="danger" data-dact="cancel" data-id="${esc(s.id)}"${busy ? ' disabled' : ''}>Cancel</button>`
					: ''
			}
		</div>
	</article>`;
}

function renderDca() {
	const body = $('dca-body');
	const d = state.dca;

	if (!state.signedIn) {
		body.innerHTML =
			'<p class="muted" style="font-size:12.5px;margin:0">Sign in to see the DCA schedules on your agents.</p>';
		return;
	}
	if (!state.agentId) {
		body.innerHTML =
			'<p class="muted" style="font-size:12.5px;margin:0">Create an agent to run a DCA schedule on it.</p>';
		return;
	}
	if (!d || d.loading) {
		body.innerHTML = skeleton(1);
		return;
	}
	if (d.error) {
		body.innerHTML = errorState(d.error, 'dca');
		return;
	}
	if (!d.rows.length) {
		body.innerHTML = emptyState({
			icon: '📈',
			title: 'No DCA schedule on this agent',
			body: 'A DCA schedule buys a fixed amount of a token on every period out of the same signed permission. Start one from the agent\'s own page, then manage it here.',
			action: `<a class="btn" href="/agents/${esc(state.agentId)}">Open this agent</a>`,
		});
		return;
	}
	body.innerHTML = `<div class="cards">${d.rows.map(dcaCard).join('')}</div>`;
}

// ── Create flow ─────────────────────────────────────────────────────────────

async function loadDelegations() {
	const sel = $('c-delegation');
	const note = $('c-delegation-note');
	const submit = $('c-submit');

	if (!state.agentId) {
		sel.disabled = true;
		sel.innerHTML = '<option value="">Pick an agent first</option>';
		note.textContent = '';
		submit.disabled = true;
		return;
	}

	sel.disabled = true;
	sel.innerHTML = '<option value="">Loading permissions…</option>';
	note.textContent = '';

	let delegations = [];
	try {
		const res = await apiFetch(
			`/api/permissions/list?agentId=${encodeURIComponent(state.agentId)}&status=active`,
			{ allowAnonymous: true },
		);
		if (res.ok) delegations = (await readBody(res)).delegations || [];
	} catch {
		note.textContent = 'Could not load permissions for this agent.';
	}

	const usable = delegations.filter((d) => !d.expiresAt || new Date(d.expiresAt) > new Date());
	if (!usable.length) {
		sel.innerHTML = '<option value="">No active permission on this agent</option>';
		sel.disabled = true;
		submit.disabled = true;
		note.textContent =
			'Grant a spending permission on this agent first. A schedule can only spend inside one you signed.';
		return;
	}

	sel.innerHTML = usable
		.map(
			(d) =>
				`<option value="${esc(d.id)}">${esc(shortAddr(d.delegator))} on chain ${esc(
					String(d.chainId),
				)}, expires ${esc(relTime(d.expiresAt))}</option>`,
		)
		.join('');
	sel.disabled = false;
	submit.disabled = false;
	note.textContent = `${usable.length} active permission${usable.length === 1 ? '' : 's'} available.`;
}

/** USDC has 6 decimals; convert the typed amount to base units without floats. */
function toBaseUnits(input, decimals = 6) {
	const raw = String(input ?? '').trim();
	if (!/^\d*\.?\d*$/.test(raw) || raw === '' || raw === '.') return null;
	const [whole = '0', frac = ''] = raw.split('.');
	if (frac.length > decimals) return null;
	const units = `${whole}${frac.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '');
	return /^\d+$/.test(units) && BigInt(units) > 0n ? units : null;
}

async function createSchedule() {
	const submit = $('c-submit');
	const delegationId = $('c-delegation').value;
	const amount = toBaseUnits($('c-amount').value);
	const periodSeconds = Number($('c-period').value);

	if (!state.agentId || !delegationId) return;
	if (!amount) {
		toast('Enter an amount above zero with at most 6 decimals.', true);
		$('c-amount').focus();
		return;
	}

	submit.disabled = true;
	submit.textContent = 'Creating…';
	try {
		const res = await apiFetch('/api/agent-subscriptions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				agentId: state.agentId,
				delegationId,
				periodSeconds,
				amountPerPeriod: amount,
			}),
		});
		const body = await readBody(res);
		if (!res.ok) {
			toast(body.error_description || `Could not create the schedule (${res.status}).`, true);
			return;
		}
		toast(res.status === 200 ? 'That schedule already exists.' : 'Recurring payment created.');
		await Promise.all([loadOutgoing(), loadIncoming()]);
	} catch (err) {
		toast(err.message || 'Could not reach the API.', true);
	} finally {
		submit.disabled = false;
		submit.textContent = 'Create schedule';
	}
}

// ── Lifecycle actions ───────────────────────────────────────────────────────

async function setSubscriptionStatus(id, action) {
	state.busy.add(id);
	renderOutgoing();
	try {
		const res = await apiFetch(`/api/agent-subscriptions?id=${encodeURIComponent(id)}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action }),
		});
		const body = await readBody(res);
		if (!res.ok) {
			toast(body.error_description || `Could not ${action} the schedule.`, true);
			return;
		}
		toast(action === 'pause' ? 'Schedule paused. No charges until you resume.' : 'Schedule resumed.');
		await Promise.all([loadOutgoing(), loadIncoming()]);
	} catch (err) {
		toast(err.message || 'Could not reach the API.', true);
	} finally {
		state.busy.delete(id);
		renderOutgoing();
	}
}

async function cancelSubscription(id) {
	state.busy.add(id);
	renderOutgoing();
	try {
		const res = await apiFetch(`/api/agent-subscriptions?id=${encodeURIComponent(id)}`, {
			method: 'DELETE',
		});
		const body = await readBody(res);
		if (!res.ok) {
			toast(body.error_description || 'Could not cancel the schedule.', true);
			return;
		}
		toast('Schedule canceled. The signed permission is still yours to revoke separately.');
		await Promise.all([loadOutgoing(), loadIncoming()]);
	} catch (err) {
		toast(err.message || 'Could not reach the API.', true);
	} finally {
		state.busy.delete(id);
		renderOutgoing();
	}
}

async function setDcaStatus(id, action) {
	state.busy.add(id);
	renderDca();
	try {
		const res = await apiFetch(`/api/dca-strategies/${encodeURIComponent(id)}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action }),
		});
		const body = await readBody(res);
		if (!res.ok) {
			toast(body.error_description || `Could not ${action} the strategy.`, true);
			return;
		}
		toast(action === 'pause' ? 'DCA paused. No swaps until you resume.' : 'DCA resumed.');
		await loadDca();
	} catch (err) {
		toast(err.message || 'Could not reach the API.', true);
	} finally {
		state.busy.delete(id);
		renderDca();
	}
}

async function cancelDca(id) {
	state.busy.add(id);
	renderDca();
	try {
		const res = await apiFetch(`/api/dca-strategies/${encodeURIComponent(id)}`, {
			method: 'DELETE',
		});
		const body = await readBody(res);
		if (!res.ok) {
			toast(body.error_description || 'Could not cancel the strategy.', true);
			return;
		}
		toast('DCA strategy canceled.');
		await loadDca();
	} catch (err) {
		toast(err.message || 'Could not reach the API.', true);
	} finally {
		state.busy.delete(id);
		renderDca();
	}
}

async function toggleHistory(id) {
	if (state.openHistory.has(id)) {
		state.openHistory.delete(id);
		renderOutgoing();
		renderIncoming();
		return;
	}
	state.openHistory.add(id);
	renderOutgoing();
	renderIncoming();

	try {
		const detail = await loadCharges(id);
		for (const bucket of [state.outgoing, state.incoming]) {
			const row = bucket?.rows?.find((r) => r.id === id);
			if (row) row.charges = detail.charges;
		}
	} catch (err) {
		toast(err.message || 'Could not load the charge history.', true);
	}
	renderOutgoing();
	renderIncoming();
}

// ── Confirm modal ───────────────────────────────────────────────────────────

let pendingConfirm = null;

function askConfirm(message, onYes) {
	pendingConfirm = onYes;
	$('confirm-body').textContent = message;
	$('confirm-backdrop').classList.add('open');
	$('confirm-no').focus();
}

function closeConfirm() {
	pendingConfirm = null;
	$('confirm-backdrop').classList.remove('open');
}

// ── Wiring ──────────────────────────────────────────────────────────────────

function selectTab(name) {
	const outgoing = name === 'outgoing';
	$('tab-outgoing').setAttribute('aria-selected', String(outgoing));
	$('tab-incoming').setAttribute('aria-selected', String(!outgoing));
	$('view-outgoing').classList.toggle('hidden', !outgoing);
	$('view-incoming').classList.toggle('hidden', outgoing);
	history.replaceState(null, '', outgoing ? location.pathname : `${location.pathname}#incoming`);
}

function wire() {
	$('tab-outgoing').addEventListener('click', () => selectTab('outgoing'));
	$('tab-incoming').addEventListener('click', () => selectTab('incoming'));

	$('c-agent').addEventListener('change', (e) => {
		state.agentId = e.target.value;
		localStorage.setItem(AGENT_KEY, state.agentId);
		$('c-grant-link').href = state.agentId ? `/agents/${state.agentId}` : '/docs/permissions';
		loadDelegations();
		loadDca();
	});
	$('c-submit').addEventListener('click', createSchedule);

	document.addEventListener('click', (e) => {
		const retry = e.target.closest('[data-retry]');
		if (retry) {
			const which = retry.dataset.retry;
			if (which === 'outgoing') loadOutgoing();
			else if (which === 'incoming') loadIncoming();
			else loadDca();
			return;
		}

		const sub = e.target.closest('[data-act]');
		if (sub) {
			const { act, id } = sub.dataset;
			if (act === 'history') toggleHistory(id);
			else if (act === 'pause' || act === 'resume') setSubscriptionStatus(id, act);
			else if (act === 'cancel') {
				askConfirm(
					'This stops every future charge on that recurring payment.',
					() => cancelSubscription(id),
				);
			}
			return;
		}

		const dca = e.target.closest('[data-dact]');
		if (dca) {
			const { dact, id } = dca.dataset;
			if (dact === 'pause' || dact === 'resume') setDcaStatus(id, dact);
			else if (dact === 'cancel') {
				askConfirm('This stops every future swap on that DCA strategy.', () => cancelDca(id));
			}
		}
	});

	$('confirm-no').addEventListener('click', closeConfirm);
	$('confirm-yes').addEventListener('click', () => {
		const fn = pendingConfirm;
		closeConfirm();
		fn?.();
	});
	$('confirm-backdrop').addEventListener('click', (e) => {
		if (e.target === $('confirm-backdrop')) closeConfirm();
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && $('confirm-backdrop').classList.contains('open')) closeConfirm();
	});
}

async function boot() {
	wire();
	if (location.hash === '#incoming') selectTab('incoming');

	await loadAgents();

	const sel = $('c-agent');
	if (!state.signedIn) {
		sel.innerHTML = '<option value="">Sign in to load your agents</option>';
		sel.disabled = true;
		$('c-submit').disabled = true;
	} else if (!state.agents.length) {
		sel.innerHTML = '<option value="">No agents yet</option>';
		sel.disabled = true;
		$('c-submit').disabled = true;
		$('c-delegation-note').innerHTML =
			'Create an agent first, then grant it a spending permission.';
	} else {
		sel.innerHTML = state.agents
			.map(
				(a) =>
					`<option value="${esc(a.id)}"${a.id === state.agentId ? ' selected' : ''}>${esc(
						a.name || a.id,
					)}</option>`,
			)
			.join('');
		$('c-grant-link').href = state.agentId ? `/agents/${state.agentId}` : '/docs/permissions';
		loadDelegations();
	}

	await Promise.all([loadOutgoing(), loadIncoming(), loadDca()]);
}

boot();
