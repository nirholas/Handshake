// /materialize/insert/:certId — the card that goes in the box.
//
// An operator opens this at the shipping step, prints it on card stock, and
// drops it in with the object. Everything on the card is what a buyer needs
// months later with no receipt and no email: the model's name, its edition, the
// certificate number, and a QR that resolves to the full proof at /cert/<id>.
//
// The endpoint behind it is operator-gated (api/print/ops/insert-card.js). This
// page is a rendering tool, never the security boundary: an unauthorized
// operator gets a designed refusal here because the server refused, not because
// the page decided to hide something.
//
// Real endpoint only:
//   GET /api/print/ops/insert-card?cert=<certId>  → { certificate, order, insert_url }

import { apiFetch } from './api.js';
import { createLogger } from './shared/log.js';

const log = createLogger('print-insert');
const CERT_ID_RE = /^[0-9a-f]{24}$/;

const root = () => document.getElementById('pi-root');

function esc(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function announce(message) {
	const el = document.getElementById('pi-live');
	if (el) el.textContent = message;
}

export function certIdFromPath(pathname = window.location.pathname) {
	const m = String(pathname || '').match(/^\/materialize\/insert\/([0-9a-f]{24})\/?$/i);
	return m ? m[1].toLowerCase() : null;
}

export function titleFromPrompt(prompt) {
	const raw = String(prompt || '').trim().replace(/\s+/g, ' ');
	if (!raw) return 'three.ws print';
	const clipped = raw.length > 52 ? `${raw.slice(0, 51).trimEnd()}…` : raw;
	return clipped.charAt(0).toUpperCase() + clipped.slice(1);
}

export function editionLine(cert) {
	return cert.edition_of ? `Edition ${cert.edition_no} of ${cert.edition_of}` : `Edition ${cert.edition_no}, open edition`;
}

function formatDate(value) {
	if (!value) return null;
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return null;
	return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Group the certificate id in fours so a human can read it off card stock. */
export function groupId(id) {
	return String(id || '').replace(/(.{4})(?=.)/g, '$1 ');
}

function renderStatus(message, { retry = false } = {}) {
	const host = root();
	if (!host) return;
	host.innerHTML = `<div class="pi-status">${esc(message)}</div>
		${retry ? '<div class="pi-toolbar" style="margin-top:16px"><button class="pi-btn pi-btn--primary" type="button" id="pi-retry">Try again</button></div>' : ''}`;
	host.setAttribute('aria-busy', 'false');
	document.getElementById('pi-retry')?.addEventListener('click', () => void load());
	announce(message);
}

function renderCard(payload) {
	const host = root();
	if (!host) return;
	const cert = payload.certificate;
	const title = cert.creation?.prompt_withheld ? 'three.ws print' : titleFromPrompt(cert.creation?.prompt);
	document.title = `Insert · ${cert.id} · three.ws`;

	const facts = [
		['Certificate', groupId(cert.id)],
		['Material', cert.material_label || cert.material_id || 'As ordered'],
		['Printed', formatDate(cert.printed_at) || 'On the ship date'],
		[
			'On-chain proof',
			cert.solana_signature
				? `${cert.network === 'mainnet' ? 'Solana' : 'Solana devnet'} · ${cert.solana_signature.slice(0, 12)}…`
				: 'Attestation pending',
		],
	];

	host.innerHTML = `
		<div class="pi-toolbar">
			<button class="pi-btn pi-btn--primary" type="button" id="pi-print">Print this card</button>
			<a class="pi-btn" href="${esc(cert.certificate_url)}" target="_blank" rel="noopener">Open the certificate</a>
			<p class="pi-toolbar-note">
				A5 landscape on card stock. Print, fold nothing, drop it in the box with the object.
				${payload.order ? `Order ${esc(payload.order.id)} (${esc(payload.order.status)}).` : ''}
			</p>
		</div>
		<article class="pi-card">
			<div class="pi-mark">
				<p class="pi-wordmark">three.ws</p>
				<p class="pi-kicker">Certificate of authenticity</p>
			</div>
			<div class="pi-body">
				<h1>${esc(title)}</h1>
				<p class="pi-edition">${esc(editionLine(cert))}</p>
				<dl class="pi-facts">
					${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
				</dl>
			</div>
			<div class="pi-qr-block">
				${
					cert.qr_url
						? `<img class="pi-qr" src="${esc(cert.qr_url)}" alt="QR code to this certificate" />`
						: '<div class="pi-qr" style="border:0.3mm dashed #999;display:flex;align-items:center;justify-content:center;font-size:2.6mm;color:#666">QR pending</div>'
				}
				<p class="pi-qr-caption">${esc(cert.certificate_url.replace(/^https?:\/\//, ''))}</p>
			</div>
			<div class="pi-foot">
				<span>Scan the code to see the original model, its lineage, and the transaction that attests this object's exact bytes.</span>
				<code>SHA-256 ${esc(cert.glb_sha256.slice(0, 16))}…</code>
			</div>
		</article>`;
	host.setAttribute('aria-busy', 'false');
	document.getElementById('pi-print')?.addEventListener('click', () => window.print());
	announce(`Insert card for certificate ${cert.id}, ${editionLine(cert)}.`);
}

async function load() {
	const id = certIdFromPath();
	if (!id || !CERT_ID_RE.test(id)) {
		renderStatus('That is not a certificate number. Open this page from an order in the operator console.');
		return;
	}
	try {
		const res = await apiFetch(`/api/print/ops/insert-card?cert=${encodeURIComponent(id)}`);
		if (res.status === 403 || res.status === 401) {
			renderStatus('Operator authorization required. Sign in as a platform admin, or present the ops secret.');
			return;
		}
		if (res.status === 404) {
			renderStatus('No certificate with that number. Certificates are issued when an order ships.');
			return;
		}
		if (!res.ok) throw new Error(`insert-card request failed: ${res.status}`);
		const payload = await res.json();
		if (!payload?.certificate) throw new Error('certificate missing from response');
		renderCard(payload);
	} catch (err) {
		log.error('insert card load failed', err);
		renderStatus('Could not load the insert card. The connection failed on the way here.', { retry: true });
	}
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', () => void load());
	} else {
		void load();
	}
}
