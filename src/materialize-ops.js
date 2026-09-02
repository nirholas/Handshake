// Materialize operator console: the working queue for physical print jobs.
//
// This page is a client of /api/print/ops/*, never a gate in front of it. Every
// endpoint authorizes on the server, so a hostile operator with devtools gains
// nothing by editing this file; what the page owes the real operator is speed
// and the absence of dead ends. Two rules follow from running real jobs:
//
//   • Every action reports its outcome in the drawer, including refusals. The
//     API returns 409 for an illegal move, and that message is the most useful
//     thing on the page when someone clicks the wrong button.
//   • The queue reloads after every mutation, so what the operator sees is what
//     the database holds. An optimistic UI here would let two operators believe
//     different things about the same physical object.

const shell = document.getElementById('mo-app');
const railEl = document.getElementById('mo-rail');
const tableBody = document.getElementById('mo-rows');
const queueTitle = document.getElementById('mo-queue-title');
const refreshBtn = document.getElementById('mo-refresh');
const updatedEl = document.getElementById('mo-updated');
const drawer = document.getElementById('mo-drawer');
const scrim = document.getElementById('mo-scrim');
const drawerBody = document.getElementById('mo-drawer-body');
const drawerTitle = document.getElementById('mo-drawer-title');
const closeBtn = document.getElementById('mo-close');

// The lanes an operator works, in the order a job moves through them. The
// remaining statuses live behind "All" rather than cluttering the rail: a
// delivered order is history, not work.
const RAIL = [
	{ key: 'work', label: 'Needs action', statuses: ['paid', 'screening', 'submitted', 'printing', 'quality_check'] },
	{ key: 'paid', label: 'Paid', statuses: ['paid'] },
	{ key: 'screening', label: 'Screening', statuses: ['screening'] },
	{ key: 'submitted', label: 'Submitted', statuses: ['submitted'] },
	{ key: 'printing', label: 'Printing', statuses: ['printing'] },
	{ key: 'quality_check', label: 'Quality check', statuses: ['quality_check'] },
	{ key: 'shipped', label: 'Shipped', statuses: ['shipped'] },
	{ key: 'delivered', label: 'Delivered', statuses: ['delivered'] },
	{ key: 'closed', label: 'Closed', statuses: ['rejected', 'canceled', 'refunded'] },
	{ key: 'all', label: 'All orders', statuses: [] },
];

const STATUS_LABEL = {
	created: 'created', quoted: 'quoted', paid: 'paid', screening: 'screening',
	submitted: 'submitted', printing: 'printing', quality_check: 'quality check',
	shipped: 'shipped', delivered: 'delivered', rejected: 'rejected',
	canceled: 'canceled', refunded: 'refunded',
};

let activeLane = RAIL[0];
let counts = {};
let adapters = [];
let openOrderId = null;
let lastFocused = null;

const esc = (v) =>
	String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function statusPill(status) {
	return `<span class="mo-pill" data-status="${esc(status)}">${esc(STATUS_LABEL[status] || status)}</span>`;
}

function shortId(id) {
	return String(id || '').slice(0, 8);
}

function fmtDate(value) {
	if (!value) return 'not yet';
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return 'unknown';
	return d.toISOString().slice(0, 16).replace('T', ' ');
}

function daysSince(value) {
	if (!value) return null;
	const t = new Date(value).getTime();
	if (Number.isNaN(t)) return null;
	return (Date.now() - t) / 86_400_000;
}

// How late a job is against its own recorded lead time. The console shows this
// on the row because "which of these is in trouble" is the question an operator
// opens the page with.
function lateness(order) {
	const elapsed = daysSince(order.submitted_at);
	if (elapsed == null || !order.lead_time_days) return 0;
	return Math.round(elapsed - Number(order.lead_time_days));
}

async function api(path, options = {}) {
	const res = await fetch(`/api/print/ops/${path}`, {
		credentials: 'include',
		...options,
		headers: options.body ? { 'content-type': 'application/json', ...(options.headers || {}) } : options.headers,
	});
	let body = null;
	try {
		body = await res.json();
	} catch {
		body = null;
	}
	if (!res.ok) {
		const err = new Error(body?.error_description || body?.error || `request failed (${res.status})`);
		err.status = res.status;
		throw err;
	}
	return body;
}

// ── the queue ────────────────────────────────────────────────────────────────

function renderRail() {
	railEl.innerHTML = RAIL.map((lane) => {
		const n = lane.statuses.length
			? lane.statuses.reduce((sum, s) => sum + (counts[s] || 0), 0)
			: Object.values(counts).reduce((a, b) => a + b, 0);
		return `<button type="button" class="mo-rail-btn" data-lane="${lane.key}" aria-pressed="${lane.key === activeLane.key}">
			<span>${esc(lane.label)}</span><span class="mo-rail-count">${n}</span>
		</button>`;
	}).join('');
}

function skeletonRows(n = 6) {
	tableBody.innerHTML = `<tr><td colspan="8" style="padding:0">${'<div class="mo-skeleton"></div>'.repeat(n)}</td></tr>`;
}

function emptyState() {
	const message = activeLane.key === 'all'
		? `<strong>No print orders yet</strong>Orders arrive here the moment a buyer pays and the safety screen passes. Nothing to run right now.`
		: `<strong>Nothing in ${esc(activeLane.label.toLowerCase())}</strong>Pick another lane on the left, or open <em>All orders</em> to see the full history.`;
	tableBody.innerHTML = `<tr><td colspan="8"><div class="mo-state">${message}</div></td></tr>`;
}

function errorState(err) {
	const denied = err.status === 403 || err.status === 401;
	const body = denied
		? `<strong>You are not signed in as a fulfillment operator</strong>
			 Sign in with a platform admin wallet, or ask the owner to add your account to <code>PRINT_OPERATORS</code>.
			 Scripts can call this API with an <code>x-ops-secret</code> header instead.`
		: err.status === 503
			? `<strong>The console needs a configured database</strong>This deployment has no <code>DATABASE_URL</code>, so there are no orders to serve.`
			: `<strong>Could not load the queue</strong>${esc(err.message)}`;
	tableBody.innerHTML = `<tr><td colspan="8"><div class="mo-state">${body}</div></td></tr>`;
}

function rowHtml(order) {
	const late = lateness(order);
	return `<tr class="mo-row" tabindex="0" role="button" data-id="${esc(order.id)}"
			aria-selected="${order.id === openOrderId}" aria-label="Order ${esc(shortId(order.id))}, ${esc(order.status)}">
		<td class="mo-mono">${esc(shortId(order.id))}</td>
		<td>${statusPill(order.status)}${late > 0 ? `<span class="mo-late">+${late}d</span>` : ''}</td>
		<td>${esc(order.material_id || 'tbd')}</td>
		<td class="mo-num">${esc(order.quantity ?? 1)}</td>
		<td class="mo-num">${Number(order.price_usdc || 0).toFixed(2)}</td>
		<td>${esc(order.provider || 'unassigned')}</td>
		<td>${esc(order.ship_to_country || '-')}</td>
		<td class="mo-mono">${esc(fmtDate(order.created_at))}</td>
	</tr>`;
}

async function loadQueue() {
	queueTitle.textContent = activeLane.label;
	skeletonRows();
	try {
		const params = new URLSearchParams();
		if (activeLane.statuses.length) params.set('status', activeLane.statuses.join(','));
		params.set('limit', '100');
		const data = await api(`queue?${params.toString()}`);
		counts = data.counts || {};
		adapters = data.adapters || [];
		renderRail();
		updatedEl.textContent = `updated ${new Date().toLocaleTimeString()}`;
		if (!data.orders?.length) return emptyState();
		tableBody.innerHTML = data.orders.map(rowHtml).join('');
	} catch (err) {
		errorState(err);
		updatedEl.textContent = '';
	}
}

// ── the drawer ───────────────────────────────────────────────────────────────

function openDrawer(orderId) {
	lastFocused = document.activeElement;
	openOrderId = orderId;
	drawer.dataset.open = 'true';
	scrim.dataset.open = 'true';
	drawer.setAttribute('aria-hidden', 'false');
	drawerTitle.textContent = `Order ${shortId(orderId)}`;
	drawerBody.innerHTML = `<div class="mo-state">Loading order…</div>`;
	closeBtn.focus();
	loadDetail(orderId);
}

function closeDrawer() {
	openOrderId = null;
	drawer.dataset.open = 'false';
	scrim.dataset.open = 'false';
	drawer.setAttribute('aria-hidden', 'true');
	drawerBody.innerHTML = '';
	if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
	for (const row of tableBody.querySelectorAll('.mo-row')) row.setAttribute('aria-selected', 'false');
}

async function loadDetail(orderId) {
	try {
		const data = await api(`order?id=${encodeURIComponent(orderId)}`);
		drawerBody.innerHTML = detailHtml(data);
		wireDetail(data);
	} catch (err) {
		drawerBody.innerHTML = `<div class="mo-state"><strong>Could not open this order</strong>${esc(err.message)}</div>`;
	}
}

function filesHtml(assets, sourceGlb) {
	const entries = Object.entries(assets || {}).filter(([, url]) => url);
	if (sourceGlb && !entries.some(([k]) => k === 'glb')) entries.push(['source glb', sourceGlb]);
	if (!entries.length) {
		return `<p class="mo-note">No prepared files on this order yet. It cannot be run until the prepare step has written an STL or 3MF.</p>`;
	}
	return `<div class="mo-files">${entries
		.map(([kind, url]) => `<a class="mo-btn" href="${esc(url)}" download target="_blank" rel="noopener">Download ${esc(kind)}</a>`)
		.join('')}</div>`;
}

function shippingHtml(shipping) {
	if (!shipping) return `<p class="mo-note">No shipping address on this order.</p>`;
	const lines = [
		shipping.name,
		shipping.line1,
		shipping.line2,
		[shipping.city, shipping.region, shipping.postal_code].filter(Boolean).join(', '),
		shipping.country,
		shipping.phone,
	].filter(Boolean);
	return `<address style="font-style:normal;font-size:var(--text-md);line-height:1.618">${lines.map(esc).join('<br />')}</address>`;
}

function timelineHtml(events) {
	if (!events?.length) return `<p class="mo-note">No events recorded yet.</p>`;
	return `<ol class="mo-timeline">${[...events]
		.reverse()
		.map(
			(e) => `<li><div>
				<div>${statusPill(e.status)} <span class="mo-timeline-meta">${esc(e.actor)} · ${esc(fmtDate(e.created_at))}</span></div>
				${e.note ? `<p class="mo-timeline-note">${esc(e.note)}</p>` : ''}
			</div></li>`,
		)
		.join('')}</ol>`;
}

function detailHtml({ order, events, webhook_deliveries: deliveries }) {
	const next = order.next || [];
	const configured = adapters.filter((a) => a.configured);
	const canSubmit = order.status === 'screening';
	const late = lateness(order);

	return `
		<section>
			<h3 class="mo-section-title">Job</h3>
			<dl class="mo-kv">
				<dt>Order</dt><dd class="mo-mono">${esc(order.id)}</dd>
				<dt>Status</dt><dd>${statusPill(order.status)}${late > 0 ? `<span class="mo-late">${late} days past lead time</span>` : ''}</dd>
				<dt>Material</dt><dd>${esc(order.material_id || 'not set')}</dd>
				<dt>Quantity</dt><dd class="mo-num">${esc(order.quantity ?? 1)}</dd>
				<dt>Height</dt><dd>${order.target_height_mm ? `${esc(order.target_height_mm)} mm` : 'per quote'}</dd>
				<dt>Price</dt><dd class="mo-num">${Number(order.price_usdc || 0).toFixed(2)} USDC</dd>
				<dt>Lane</dt><dd>${esc(order.provider || 'unassigned')}${order.provider_order_id ? ` · <span class="mo-mono">${esc(order.provider_order_id)}</span>` : ''}</dd>
				<dt>Submitted</dt><dd>${esc(fmtDate(order.submitted_at))}</dd>
				<dt>Tracking</dt><dd>${order.tracking_number ? `${esc(order.tracking_number)}${order.carrier ? ` (${esc(order.carrier)})` : ''}` : 'none'}</dd>
			</dl>
		</section>

		<section>
			<h3 class="mo-section-title">Files for the bureau</h3>
			${filesHtml(order.prepared_asset_urls, order.source_glb_url)}
		</section>

		<section>
			<h3 class="mo-section-title">Ship to</h3>
			${shippingHtml(order.shipping)}
		</section>

		${canSubmit ? `<section>
			<h3 class="mo-section-title">Hand to a lane</h3>
			<div class="mo-field">
				<label for="mo-adapter">Fulfillment lane</label>
				<select class="mo-select" id="mo-adapter">
					<option value="">Route automatically</option>
					${configured.map((a) => `<option value="${esc(a.key)}">${esc(a.label)}</option>`).join('')}
				</select>
			</div>
			<div class="mo-actions" style="margin-top:8px">
				<button type="button" class="mo-btn mo-btn-primary" data-act="submit">Submit to lane</button>
			</div>
		</section>` : ''}

		${['submitted', 'printing', 'quality_check', 'shipped'].includes(order.status) ? `<section>
			<h3 class="mo-section-title">Tracking</h3>
			<div class="mo-inline">
				<div class="mo-field">
					<label for="mo-tracking">Tracking number</label>
					<input class="mo-input" id="mo-tracking" value="${esc(order.tracking_number || '')}" autocomplete="off" />
				</div>
				<div class="mo-field">
					<label for="mo-carrier">Carrier</label>
					<input class="mo-input" id="mo-carrier" value="${esc(order.carrier || '')}" autocomplete="off" />
				</div>
			</div>
			<div class="mo-actions" style="margin-top:8px">
				<button type="button" class="mo-btn mo-btn-primary" data-act="tracking">
					${order.status === 'shipped' ? 'Correct tracking' : 'Save and mark shipped'}
				</button>
			</div>
		</section>` : ''}

		<section>
			<h3 class="mo-section-title">Move this order</h3>
			<div class="mo-field">
				<label for="mo-note">Note for the timeline</label>
				<textarea class="mo-textarea" id="mo-note" maxlength="2000" placeholder="What happened, in the words the next operator needs."></textarea>
			</div>
			<div class="mo-actions" style="margin-top:8px">
				${next
					.filter((s) => s !== 'submitted')
					.map((s) => `<button type="button" class="mo-btn${['rejected', 'canceled', 'refunded'].includes(s) ? ' mo-btn-danger' : ''}"
						data-act="to" data-to="${esc(s)}">Mark ${esc(STATUS_LABEL[s] || s)}</button>`)
					.join('')}
				${next.length === 0 || (next.length === 1 && next[0] === 'submitted')
					? `<p class="mo-note">This order is closed. Nothing further can move it.</p>`
					: ''}
			</div>
			<p class="mo-note" id="mo-result" role="status" aria-live="polite"></p>
			<div id="mo-payout"></div>
		</section>

		<section>
			<h3 class="mo-section-title">Timeline</h3>
			${timelineHtml(events)}
		</section>

		<section>
			<h3 class="mo-section-title">Webhook deliveries</h3>
			${deliveries?.length
				? `<ul class="mo-timeline">${deliveries
						.map((d) => `<li><div><span class="mo-mono">${esc(d.provider)} · ${esc(d.delivery_id.slice(0, 24))}</span>
							<p class="mo-timeline-note">${d.applied ? 'applied' : 'received, no change'} · ${esc(fmtDate(d.received_at))}</p></div></li>`)
						.join('')}</ul>`
				: `<p class="mo-note">No provider callbacks for this order. The manual lane sends none by design.</p>`}
		</section>`;
}

function wireDetail(data) {
	const order = data.order;
	const result = drawerBody.querySelector('#mo-result');
	const payoutEl = drawerBody.querySelector('#mo-payout');

	const say = (message, tone = '') => {
		result.textContent = message;
		if (tone) result.dataset.tone = tone;
		else delete result.dataset.tone;
	};

	const run = async (button, work) => {
		const buttons = [...drawerBody.querySelectorAll('button[data-act]')];
		for (const b of buttons) b.disabled = true;
		button.dataset.busy = 'true';
		say('Working…');
		try {
			const body = await work();
			say(body.message || 'Done.', 'ok');
			if (body.payout) {
				payoutEl.innerHTML = `<p class="mo-payout"><strong>Owner action required.</strong>
					Send <strong>${Number(body.payout.amount_usdc || 0).toFixed(2)} USDC</strong> on Solana to
					<span class="mo-mono">${esc(body.payout.recipient || 'the buyer account')}</span>.
					${esc(body.payout.instruction)}</p>`;
			}
			await loadQueue();
			await loadDetail(order.id);
		} catch (err) {
			say(err.message, 'error');
			for (const b of buttons) b.disabled = false;
			delete button.dataset.busy;
		}
	};

	drawerBody.addEventListener('click', (event) => {
		const button = event.target.closest('button[data-act]');
		if (!button) return;
		const note = drawerBody.querySelector('#mo-note')?.value || '';

		if (button.dataset.act === 'submit') {
			const adapter = drawerBody.querySelector('#mo-adapter')?.value || '';
			return run(button, async () => {
				const body = await api('submit', { method: 'POST', body: JSON.stringify({ order_id: order.id, adapter }) });
				return { message: `Submitted to ${body.adapter}.` };
			});
		}

		if (button.dataset.act === 'tracking') {
			const trackingNumber = drawerBody.querySelector('#mo-tracking')?.value.trim() || '';
			const carrier = drawerBody.querySelector('#mo-carrier')?.value.trim() || '';
			if (!trackingNumber) return say('Enter a tracking number first.', 'error');
			return run(button, async () => {
				const body = await api('tracking', {
					method: 'POST',
					body: JSON.stringify({ order_id: order.id, tracking_number: trackingNumber, carrier, note, ship: order.status !== 'shipped' }),
				});
				return { message: `Order is ${body.order.status}.` };
			});
		}

		if (button.dataset.act === 'to') {
			const to = button.dataset.to;
			// The two moves that end an order get a confirmation. Everything else
			// is reversible by another transition; these are not.
			if ((to === 'refunded' || to === 'canceled') && !window.confirm(`Mark order ${shortId(order.id)} as ${to}? This cannot be undone.`)) return;
			const path = to === 'canceled' ? 'cancel' : to === 'refunded' ? 'refund' : 'transition';
			const payload = to === 'canceled'
				? { order_id: order.id, reason: note }
				: to === 'refunded'
					? { order_id: order.id, note }
					: { order_id: order.id, to, note };
			return run(button, async () => {
				const body = await api(path, { method: 'POST', body: JSON.stringify(payload) });
				return { message: `Order is ${body.order.status}.`, payout: body.payout };
			});
		}
	});
}

// ── events ───────────────────────────────────────────────────────────────────

railEl.addEventListener('click', (event) => {
	const button = event.target.closest('[data-lane]');
	if (!button) return;
	activeLane = RAIL.find((l) => l.key === button.dataset.lane) || RAIL[0];
	renderRail();
	loadQueue();
});

tableBody.addEventListener('click', (event) => {
	const row = event.target.closest('.mo-row');
	if (row) openDrawer(row.dataset.id);
});

tableBody.addEventListener('keydown', (event) => {
	if (event.key !== 'Enter' && event.key !== ' ') return;
	const row = event.target.closest('.mo-row');
	if (!row) return;
	event.preventDefault();
	openDrawer(row.dataset.id);
});

refreshBtn.addEventListener('click', () => loadQueue());
closeBtn.addEventListener('click', closeDrawer);
scrim.addEventListener('click', closeDrawer);

document.addEventListener('keydown', (event) => {
	if (event.key === 'Escape' && openOrderId) closeDrawer();
	// The one shortcut worth having: an operator reloads the queue constantly.
	if (event.key === 'r' && !openOrderId && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
		loadQueue();
	}
});

renderRail();
loadQueue();

// Deep link: the Telegram ops message and the notification bell both link
// straight to one order, which is the whole point of paging someone.
const requested = new URLSearchParams(location.search).get('order');
if (requested) openDrawer(requested);

shell.dataset.ready = 'true';
