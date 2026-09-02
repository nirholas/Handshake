// /materialize/orders/:id: one print order, from quote to doorstep.
//
// Most of an order's life is spent waiting, so the waiting is what this page is
// designed around. The rail shows every step with the real timestamp from the
// order's event log (print_order_events, appended once per transition and never
// mutated), and the step that is happening now says what is happening and what
// happens next, rather than leaving a buyer to guess from a status word.
//
// The page polls while the order is live and stops once it reaches a state that
// no longer changes on its own, so a delivered order sitting open in a tab is
// not a request every ten seconds forever.

import { ORDER_STEPS, formatLeadTime, formatMm, formatUsdc, timelineView } from './materialize-lib.js';

const $ = (id) => document.getElementById(id);

// Live orders are polled; a terminal one is not. The interval is generous
// because the transitions it is watching for are minutes to days apart.
const POLL_MS = 20_000;
const TERMINAL = new Set(['delivered', 'rejected', 'canceled', 'refunded']);

// What the buyer is actually waiting on, in the step's own terms. A status word
// is not an explanation, and "submitted" for three days with no note is how a
// buyer decides an order is lost.
const WAITING_COPY = {
	created: 'The order is open and waiting for payment to settle.',
	quoted: 'Waiting for your USDC payment to land on Solana. The order page updates itself when it does.',
	paid: 'Payment confirmed. The model is being screened against what we can fabricate before it reaches a machine.',
	screening: 'Being screened for fabrication. This is quick, and it happens before anything is sent to the floor.',
	submitted: 'On the print floor queue. Nothing visible happens here until a machine picks it up, which is normal.',
	printing: 'On the machine now. Printing is the longest step and does not report progress from inside the build chamber.',
	quality_check: 'Off the machine, being inspected and finished. If anything failed inspection it is reprinted rather than shipped.',
	shipped: 'In transit. The carrier tracking above updates faster than this page does.',
};

let timer = null;

function orderIdFromPath() {
	const match = location.pathname.match(/\/materialize\/orders\/([0-9a-f-]{36})/i);
	return match ? match[1] : null;
}

function esc(value) {
	return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** A timestamp a person reads, with the exact value on hover. */
function when(iso) {
	if (!iso) return '';
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return '';
	return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

async function load() {
	const id = orderIdFromPath();
	if (!id) return showError('That is not a valid order link.', 'The address should end in the order id you were given at checkout.');

	try {
		const res = await fetch(`/api/print/orders/${id}`, { credentials: 'include' });
		if (res.status === 401) {
			return showError(
				'Sign in to see this order',
				'Orders are visible only to the account that placed them.',
				`<a class="mo-btn" href="/login?next=${encodeURIComponent(location.pathname)}">Sign in</a>`,
			);
		}
		if (res.status === 404) {
			return showError(
				'No such order',
				'This order does not exist, or it belongs to another account. Check the link from your checkout confirmation.',
				'<a class="mo-btn" href="/materialize">Start a new print</a>',
			);
		}
		if (!res.ok) throw new Error(`Request failed (${res.status})`);
		const body = await res.json();
		render(body.order, body.events || []);

		if (!TERMINAL.has(body.order.status)) {
			clearTimeout(timer);
			timer = setTimeout(load, POLL_MS);
		}
	} catch (err) {
		// A failed poll on an order already on screen must not blank it out; only
		// the first load has nothing to fall back to.
		if (!$('mo-main').hidden) {
			clearTimeout(timer);
			timer = setTimeout(load, POLL_MS * 2);
			return;
		}
		showError('This order could not be loaded', `${esc(err.message)} It is safe to reload this page.`, '<button type="button" class="mo-btn" onclick="location.reload()">Try again</button>');
	}
}

function showError(title, message, actions = '') {
	$('mo-loading').hidden = true;
	$('mo-main').hidden = true;
	const box = $('mo-error');
	box.hidden = false;
	box.innerHTML = `<div class="mo-notice"><h2>${esc(title)}</h2><p>${message}</p>${actions ? `<div class="mo-row">${actions}</div>` : ''}</div>`;
}

function render(order, events) {
	$('mo-loading').hidden = true;
	$('mo-error').hidden = true;
	$('mo-main').hidden = false;

	const quote = order.quote || {};
	const materialName = quote.material?.name || order.material_id;

	document.title = `${materialName} print · ${order.status} · three.ws`;
	$('mo-eyebrow').textContent = `Materialize order ${order.id.slice(0, 8)}`;
	$('mo-title').textContent = statusHeadline(order);
	$('mo-sub').textContent = subtitleFor(order);

	$('mo-specs').innerHTML = [
		['Material', materialName],
		['Size', formatMm(order.target_height_mm)],
		['Quantity', String(order.quantity)],
		['Paid', `${formatUsdc(order.price_usdc)} USDC`],
		['Ordered', when(order.created_at)],
		order.ship_to ? ['Going to', `${order.ship_to.city}, ${order.ship_to.country}`] : null,
	]
		.filter(Boolean)
		.map(([k, v]) => `<div class="mo-spec"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
		.join('');

	renderModel(order);
	renderRail(order, events);
	renderShipment(order);
	renderCertificate(order);
}

function statusHeadline(order) {
	const map = {
		created: 'Your print is waiting on payment',
		quoted: 'Your print is waiting on payment',
		paid: 'Paid. Heading into production',
		screening: 'Being screened for fabrication',
		submitted: 'Queued on the print floor',
		printing: 'On the machine now',
		quality_check: 'Printed. Being inspected',
		shipped: 'On its way to you',
		delivered: 'Delivered',
		rejected: 'This order was not fabricated',
		canceled: 'This order was canceled',
		refunded: 'This order was refunded',
	};
	return map[order.status] || 'Your print';
}

function subtitleFor(order) {
	if (order.status === 'delivered') return 'Printed from your model and delivered. The certificate below links the object back to the exact file it was made from.';
	if (TERMINAL.has(order.status)) return 'Nothing further will happen on this order. Any refund is recorded on the timeline below.';
	return `${formatLeadTime(order.lead_time_days)} from the day it was paid. Every step below carries the moment it actually happened.`;
}

function renderModel(order) {
	// The prepared file is the object being printed; the source creation is the
	// best stand-in until preparation has run. Either way the buyer sees the
	// thing, not a placeholder box.
	const stage = $('mo-stage');
	const url = order.quote?.prepared_glb_url || null;
	if (url) return mountViewer(stage, url);
	if (!order.creation_id) return;
	fetch(`/api/forge-creation?id=${encodeURIComponent(order.creation_id)}`, { credentials: 'include' })
		.then((r) => (r.ok ? r.json() : null))
		.then((body) => {
			const glb = body?.creation?.glb_url || body?.glb_url || null;
			if (glb) mountViewer(stage, glb);
		})
		.catch(() => {
			// The empty state already says the print file is being prepared, which
			// is the honest thing to show when the model cannot be fetched.
		});
}

function mountViewer(stage, url) {
	const viewer = document.createElement('model-viewer');
	viewer.setAttribute('src', url);
	viewer.setAttribute('alt', 'The model being printed');
	viewer.setAttribute('camera-controls', '');
	viewer.setAttribute('auto-rotate', '');
	viewer.setAttribute('rotation-per-second', '16deg');
	viewer.setAttribute('interaction-prompt', 'none');
	viewer.setAttribute('shadow-intensity', '0.8');
	viewer.setAttribute('environment-image', 'neutral');
	viewer.setAttribute('exposure', '1.05');
	viewer.setAttribute('reveal', 'auto');
	stage.replaceChildren(viewer);
}

function renderRail(order, events) {
	const view = timelineView(order, events);
	$('mo-branch').innerHTML = view.branch
		? `<div class="mo-branch">
				<h3>${esc(view.branch.label)}</h3>
				<p>${esc(view.branch.event?.note || 'Recorded on this order. If money moved, the refund appears on the timeline.')}</p>
			</div>`
		: '';

	$('mo-rail').innerHTML = view.steps
		.map((step, i) => {
			const mark = step.state === 'done' ? '&#10003;' : String(i + 1);
			return `<li class="mo-step is-${step.state}">
				<span class="mo-dot" aria-hidden="true">${step.state === 'current' ? '' : mark}</span>
				<div>
					<p class="mo-step-label">${esc(step.label)}</p>
					<p class="mo-step-blurb">${esc(step.blurb)}</p>
					${step.at ? `<p class="mo-step-at"><time datetime="${esc(step.at)}" title="${esc(step.at)}">${esc(when(step.at))}</time></p>` : ''}
					${step.note ? `<p class="mo-step-note">${esc(step.note)}</p>` : ''}
				</div>
			</li>`;
		})
		.join('');

	const waiting = WAITING_COPY[order.status];
	$('mo-waiting').hidden = !waiting;
	if (waiting) $('mo-waiting-text').textContent = waiting;
}

function renderShipment(order) {
	const panel = $('mo-ship-panel');
	if (!order.tracking_number) {
		panel.hidden = true;
		return;
	}
	panel.hidden = false;
	const carrier = order.carrier ? esc(order.carrier) : 'Carrier';
	$('mo-ship-row').innerHTML = `<span class="mo-mono">${carrier} · ${esc(order.tracking_number)}</span>
		<button type="button" class="mo-btn" id="mo-copy-tracking">Copy tracking number</button>`;
	$('mo-copy-tracking')?.addEventListener('click', async (e) => {
		try {
			await navigator.clipboard.writeText(order.tracking_number);
			e.target.textContent = 'Copied';
			setTimeout(() => {
				e.target.textContent = 'Copy tracking number';
			}, 1600);
		} catch {
			e.target.textContent = order.tracking_number;
		}
	});
}

function renderCertificate(order) {
	const panel = $('mo-cert-panel');
	const certId = order.certificate_id || order.quote?.certificate_id || null;
	const shipped = ['shipped', 'delivered'].includes(order.status);
	if (!shipped && !certId) {
		panel.hidden = true;
		return;
	}
	panel.hidden = false;
	$('mo-cert-text').textContent = certId
		? 'This print carries a certificate: the hash of the exact file it was made from, its edition number, and an attestation on Solana. The QR on the package insert opens the same page.'
		: 'A certificate is issued when the print ships: the hash of the exact file it was made from, its edition number, and an attestation on Solana.';
	$('mo-cert-row').innerHTML = certId
		? `<a class="mo-btn" href="/cert/${esc(certId)}">Open the certificate</a>`
		: '';
	if (order.payment?.explorer_url) {
		$('mo-cert-row').insertAdjacentHTML(
			'beforeend',
			`<a class="mo-btn" href="${esc(order.payment.explorer_url)}" target="_blank" rel="noopener">See the payment on Solscan</a>`,
		);
	}
}

// Stop polling while the tab is hidden; resume, with an immediate refresh, when
// the buyer comes back to it.
document.addEventListener('visibilitychange', () => {
	if (document.hidden) clearTimeout(timer);
	else load();
});

load();

export { ORDER_STEPS };
