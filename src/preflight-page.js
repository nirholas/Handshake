// /preflight — check whether any x402 seller can actually settle, and verify the
// answer here rather than believing it.
//
// The verification runs in the visitor's browser against the seller's own
// signature. That is the whole point of the page: a status page you have to
// trust is worth nothing, and this one can be checked by anyone who opens
// devtools. The same verify() shipped in @three-ws/x402-preflight runs here, so
// what a reader sees is what their agent would compute.
//
// A cross-origin fetch to a third-party seller may be blocked by that seller's
// CORS policy. That is not our failure to hide: it is reported plainly, with the
// header the seller would need to add, because a silent "unknown" would teach
// people the format is unreliable when the format is fine.

import { verifyPreflight, normalizeOrigin } from '../packages/x402-preflight/src/verify.js';

const PREFLIGHT_PATH = '/.well-known/x402-preflight';

const form = document.getElementById('pf-form');
const input = /** @type {HTMLInputElement} */ (document.getElementById('pf-origin'));
const button = /** @type {HTMLButtonElement} */ (document.getElementById('pf-go'));
const out = document.getElementById('pf-out');

function el(tag, cls, text) {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	if (text != null) n.textContent = String(text);
	return n;
}

function badge(payable) {
	if (payable === true) return el('span', 'pf-badge pf-yes', 'payable');
	if (payable === false) return el('span', 'pf-badge pf-no', 'not payable');
	return el('span', 'pf-badge pf-maybe', 'unknown');
}

// Plain-language rendering of each machine reason. The wire format is for
// agents; a person reading this page deserves the sentence, not the enum.
const REASON_COPY = {
	ok: 'Settling normally.',
	sponsor_below_floor:
		'The seller\'s own fee wallet cannot cover network fees, so nothing you sign can settle. Only the seller can fix this.',
	settlement_degraded: 'Recent settlements are failing. Payments may not complete.',
	facilitator_unreachable: 'The seller cannot reach its settlement facilitator, so it cannot vouch for this rail.',
	network_not_configured: 'The seller does not accept payment on this network.',
	rail_unavailable: 'The payment rail itself is unavailable.',
	unknown: 'The seller could not measure this rail, so it will not claim it works.',
};

function describeSettle(s) {
	if (!s || s.rate == null) return 'no settled payments measured in the window';
	const pct = (s.rate * 100).toFixed(1);
	return `${pct}% of ${s.attempts} attempt${s.attempts === 1 ? '' : 's'} over ${s.window_hours}h (confidence ${s.confidence})`;
}

function renderNetwork(id, n) {
	const row = el('div', 'pf-net');
	row.append(el('span', 'pf-netid', id), badge(n.payable));

	const why = el('div', 'pf-netwhy');
	why.append(el('span', null, REASON_COPY[n.reason] || n.reason));
	why.append(document.createElement('br'));
	why.append(el('span', null, describeSettle(n.settle)));
	if (n.payable !== true && Array.isArray(n.alternates) && n.alternates.length) {
		why.append(document.createElement('br'));
		const alt = el('span', 'pf-alt', `Payable instead on ${n.alternates.join(', ')}`);
		why.append(alt);
	}
	if (n.payable !== true && n.retry_after) {
		why.append(document.createElement('br'));
		why.append(el('span', null, `Seller suggests retrying in ${n.retry_after}s.`));
	}
	row.append(why);
	return row;
}

function renderError(origin, title, detail, hint) {
	const card = el('div', 'pf-card pf-err');
	const head = el('div', 'pf-cardhead');
	head.append(el('span', 'pf-origin', origin), el('span', 'pf-badge pf-no', 'unverified'));
	card.append(head, el('div', 'pf-netwhy', title));
	if (detail) card.append(el('div', 'pf-meta', detail));
	if (hint) card.append(el('div', 'pf-netwhy', hint));
	card.append(el('div', 'pf-net'));
	return card;
}

function renderReport(envelope, verification) {
	const report = envelope.report;
	const card = el('div', 'pf-card');

	const head = el('div', 'pf-cardhead');
	head.append(el('span', 'pf-origin', report.subject));
	const v = el('span', 'pf-verified');
	v.append(el('span', null, '✓'), el('span', null, 'signature verified in your browser'));
	head.append(v);
	card.append(head);

	const secondsLeft = Math.max(0, Math.round((Date.parse(report.expires_at) - Date.now()) / 1000));
	card.append(
		el('div', 'pf-meta', `issuer ${envelope.issuer} · digest ${verification.digest.slice(0, 16)}… · valid ${secondsLeft}s longer`),
	);

	const entries = Object.entries(report.networks || {});
	if (!entries.length) {
		card.append(el('div', 'pf-netwhy', 'This seller publishes an attestation but offers no payment networks.'));
	}
	for (const [id, n] of entries) card.append(renderNetwork(id, n));
	return card;
}

function emptyState() {
	const box = el('div', 'pf-empty');
	box.append(el('strong', null, 'Nothing checked yet.'));
	box.append(document.createElement('br'));
	box.append(
		el(
			'span',
			null,
			'Enter any x402 seller\'s origin above. If it publishes an attestation you will see its signature verified here, network by network.',
		),
	);
	return box;
}

async function check(rawOrigin) {
	const origin = normalizeOrigin(rawOrigin);
	out.replaceChildren(el('div', 'pf-skel'));
	button.disabled = true;
	button.textContent = 'Checking…';

	// A hung seller must not hang the page.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 8000);
	try {
		let res;
		try {
			res = await fetch(`${origin}${PREFLIGHT_PATH}`, {
				headers: { accept: 'application/json' },
				signal: controller.signal,
			});
		} catch (err) {
			const aborted = err?.name === 'AbortError';
			out.replaceChildren(
				renderError(
					origin,
					aborted ? 'The seller did not answer in time.' : 'Could not reach the seller from your browser.',
					err?.message || String(err),
					aborted
						? null
						: 'If the origin is reachable, it is most likely a CORS policy: the seller must send access-control-allow-origin on its preflight response for browsers to read it. Agents calling it server-side are unaffected.',
				),
			);
			return;
		}

		if (!res.ok) {
			out.replaceChildren(
				renderError(
					origin,
					res.status === 404
						? 'This origin does not publish an x402 preflight attestation.'
						: `The seller answered HTTP ${res.status}.`,
					null,
					res.status === 404
						? 'That is not a fault: preflight is opt-in and most x402 sellers have not adopted it yet. It does mean you cannot know whether this one can settle before you pay.'
						: 'A seller that cannot sign an attestation is a seller you should not assume is healthy.',
				),
			);
			return;
		}

		let envelope;
		try {
			envelope = await res.json();
		} catch {
			out.replaceChildren(renderError(origin, 'The seller\'s response was not valid JSON.'));
			return;
		}

		const verification = verifyPreflight(envelope, { subject: origin });
		if (!verification.valid) {
			out.replaceChildren(
				renderError(
					origin,
					`The attestation did not verify: ${verification.reason}.`,
					null,
					verification.reason === 'expired'
						? 'The seller served an attestation that has already expired. Expiry is what stops a healthy report being replayed through an outage, so an expired one carries no assurance at all.'
						: 'The document is signed, but the signature does not match its contents. Treat this seller as unverified.',
				),
			);
			return;
		}

		out.replaceChildren(renderReport(envelope, verification));
	} finally {
		clearTimeout(timer);
		button.disabled = false;
		button.textContent = 'Check';
	}
}

form.addEventListener('submit', (e) => {
	e.preventDefault();
	const value = input.value.trim();
	if (value) check(value);
});

for (const chip of document.querySelectorAll('.pf-chip')) {
	chip.addEventListener('click', () => {
		input.value = chip.dataset.origin || '';
		check(input.value);
	});
}

out.replaceChildren(emptyState());

// Deep link: /preflight?origin=https://example.com checks on load, so the page
// can be linked from an incident report or a status dashboard.
const fromQuery = new URLSearchParams(location.search).get('origin');
if (fromQuery) {
	input.value = fromQuery;
	check(fromQuery);
}
