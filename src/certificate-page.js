// /cert/:certId: the certificate of authenticity for one Materialize print.
//
// This is the page a QR code on a physical box resolves to, so it is built for
// a stranger on a phone: no session, no chrome to click through, and the proof
// itself rendered inline rather than behind a link to somebody else's explorer.
// A verifier who never trusts three.ws can hash the file, read the memo string
// on this page, and confirm the two agree without leaving it.
//
// /cert with no id is the lookup: the same page, asking for a certificate
// number, because someone holding a card is much likelier to type its id than
// to find this route any other way.
//
// Real endpoint only:
//   GET /api/print/certs/:id  → { certificate }

import { apiFetch } from './api.js';
import { createLogger } from './shared/log.js';

const log = createLogger('certificate-page');
const CERT_ID_RE = /^[0-9a-f]{24}$/;

const root = () => document.getElementById('ct-root');
const live = () => document.getElementById('ct-live');

function esc(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function announce(message) {
	const el = live();
	if (el) el.textContent = message;
}

/** The certificate id in the path, or null when this is the lookup view. */
export function certIdFromPath(pathname = window.location.pathname) {
	const m = String(pathname || '').match(/^\/cert\/([0-9a-f]{24})\/?$/i);
	return m ? m[1].toLowerCase() : null;
}

/** A short, human title for a model, derived from its prompt. */
export function titleFromPrompt(prompt) {
	const raw = String(prompt || '').trim().replace(/\s+/g, ' ');
	if (!raw) return 'Untitled model';
	const clipped = raw.length > 64 ? `${raw.slice(0, 63).trimEnd()}…` : raw;
	return clipped.charAt(0).toUpperCase() + clipped.slice(1);
}

export function formatBytes(n) {
	if (!Number.isFinite(n) || n <= 0) return null;
	const units = ['B', 'KB', 'MB', 'GB'];
	let value = n;
	let i = 0;
	while (value >= 1024 && i < units.length - 1) {
		value /= 1024;
		i += 1;
	}
	return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatDate(value) {
	if (!value) return null;
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return null;
	return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/** "Edition 3 of 25", or "Edition 3" for an open series. */
export function editionLine(cert) {
	if (!cert) return '';
	return cert.edition_of ? `Edition ${cert.edition_no} of ${cert.edition_of}` : `Edition ${cert.edition_no}`;
}

function stage(cert) {
	const creation = cert.creation;
	const glb = creation?.glb_url;
	const poster = creation?.preview_image_url;
	const badge = `<div class="ct-edition"><strong>${esc(String(cert.edition_no))}</strong><span>${
		cert.edition_of ? `of ${esc(String(cert.edition_of))}` : 'open edition'
	}</span></div>`;

	if (glb) {
		return `<div class="ct-stage">
			<model-viewer src="${esc(glb)}"${poster ? ` poster="${esc(poster)}"` : ''}
				alt="The 3D model this print was made from"
				camera-controls auto-rotate auto-rotate-delay="600" rotation-per-second="20deg"
				interaction-prompt="when-focused" shadow-intensity="0.5" exposure="0.95"
				environment-image="neutral"></model-viewer>
			${badge}
		</div>`;
	}
	if (poster) {
		return `<div class="ct-stage"><img src="${esc(poster)}" alt="The model this print was made from" />${badge}</div>`;
	}
	// The source model was deleted or was never a stored creation. The
	// certificate is still fully valid: the hash and the attestation are what it
	// proves, and they are on this page.
	return `<div class="ct-stage"><div class="ct-stage-empty">
		The original model is no longer hosted here. The hash and the on-chain proof below still
		verify the object you are holding.
	</div>${badge}</div>`;
}

function lineage(cert) {
	const c = cert.creation;
	if (!c) {
		return `<div class="ct-card">
			<h2>Lineage</h2>
			<p class="ct-note">This print was made from a model uploaded directly, not generated on three.ws, so it carries no prompt lineage. Its bytes are still hashed and attested below.</p>
		</div>`;
	}
	const body = c.prompt_withheld
		? `<p class="ct-note">This model is private. Its prompt stays with its creator; the certificate, the hash, and the attestation are public.</p>`
		: `<p class="ct-fact-prompt ct-code">${esc(c.prompt || 'No prompt recorded.')}</p>`;
	const links = [];
	if (c.model_url) links.push(`<a class="ct-btn" href="${esc(c.model_url)}">Open the original model</a>`);
	if (c.parent_creation_id) {
		links.push(`<a class="ct-btn" href="/m/${esc(c.parent_creation_id)}">See what it was refined from</a>`);
	}
	const creator = c.creator_display_name || c.creator_username;
	return `<div class="ct-card">
		<h2>Lineage</h2>
		${body}
		${
			c.refine_instruction
				? `<p class="ct-note">Refined with: ${esc(c.refine_instruction)}</p>`
				: ''
		}
		${creator ? `<p class="ct-note">Forged by ${esc(creator)}${c.creator_username ? ` (@${esc(c.creator_username)})` : ''}.</p>` : ''}
		${links.length ? `<div class="ct-actions" style="margin-top:12px">${links.join('')}</div>` : ''}
	</div>`;
}

function facts(cert) {
	const rows = [
		['Certificate', cert.id],
		['Edition', editionLine(cert)],
		['Material', cert.material_label || cert.material_id || 'Recorded on the order'],
		['Printed', formatDate(cert.printed_at) || 'Unrecorded'],
	];
	const size = formatBytes(Number(cert.glb_bytes));
	if (size) rows.push(['Model size', size]);
	return `<div class="ct-card">
		<h2>The object</h2>
		<dl class="ct-facts">
			${rows
				.map(
					([k, v]) =>
						`<div class="ct-fact"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`,
				)
				.join('')}
		</dl>
	</div>`;
}

function proof(cert) {
	const attested = Boolean(cert.solana_signature);
	const network = cert.network === 'mainnet' ? 'Solana mainnet' : 'Solana devnet';
	const state = attested
		? `<span class="ct-proof-state"><span class="ct-dot"></span>Attested on ${esc(network)}${
				cert.attested_at ? ` on ${esc(formatDate(cert.attested_at) || '')}` : ''
			}</span>`
		: `<span class="ct-proof-state"><span class="ct-dot ct-dot--pending"></span>Attestation in flight. The certificate is issued and its hash is final; the transaction is retried until it lands.</span>`;

	return `<div class="ct-card">
		<h2>On-chain proof</h2>
		${state}
		<h2 style="margin-top:20px">Memo payload (signed verbatim)</h2>
		<code class="ct-code" id="ct-memo">${esc(cert.memo || '')}</code>
		<h2 style="margin-top:20px">SHA-256 of the model</h2>
		<code class="ct-code" id="ct-hash">${esc(cert.glb_sha256)}</code>
		${
			cert.print_asset_sha256
				? `<h2 style="margin-top:20px">SHA-256 of the ${esc(String(cert.print_asset_kind || 'print').toUpperCase())} sent to the printer</h2>
					<code class="ct-code">${esc(cert.print_asset_sha256)}</code>`
				: ''
		}
		<div class="ct-actions">
			${
				attested
					? `<a class="ct-btn ct-btn--primary" href="${esc(cert.explorer_url)}" target="_blank" rel="noopener">View the transaction</a>`
					: ''
			}
			<button class="ct-btn" type="button" id="ct-copy-memo">Copy the memo</button>
			<button class="ct-btn" type="button" id="ct-copy-link">Copy this certificate link</button>
		</div>
		${
			attested
				? `<p class="ct-note">Signature: <span class="ct-code" style="display:inline;padding:2px 6px">${esc(cert.solana_signature)}</span></p>`
				: ''
		}
	</div>`;
}

function verifySection(cert) {
	const glb = cert.creation?.glb_url;
	return `<div class="ct-card">
		<h2>Verify these bytes yourself</h2>
		<ol class="ct-steps">
			<li>Download the model this print was made from${
				glb ? `: <a class="ct-btn" style="margin-left:6px" href="${esc(glb)}" download>Download the GLB</a>` : '.'
			}</li>
			<li>Hash it: <code>shasum -a 256 model.glb</code> (macOS/Linux) or <code>certutil -hashfile model.glb SHA256</code> (Windows).</li>
			<li>Compare the result to the SHA-256 above. They match, byte for byte, or this is not the model that was printed.</li>
			<li>Read the same hash back off the chain: open the transaction and read its memo instruction. The memo string above is exactly what was signed.</li>
		</ol>
		<p class="ct-note">
			Nothing in this check depends on three.ws staying online. The hash is in the transaction,
			the transaction is on ${esc(cert.network === 'mainnet' ? 'Solana mainnet' : 'Solana devnet')},
			and the file is yours.
		</p>
	</div>`;
}

function qrCard(cert) {
	if (!cert.qr_url) return '';
	return `<div class="ct-card">
		<h2>The code on the box</h2>
		<img class="ct-qr" src="${esc(cert.qr_url)}" alt="QR code linking to this certificate" width="132" height="132" loading="lazy" />
		<p class="ct-note">This is the code printed on the package insert. It resolves here.</p>
	</div>`;
}

function renderCertificate(cert) {
	const host = root();
	if (!host) return;
	const title = cert.creation?.prompt_withheld
		? 'A private model'
		: titleFromPrompt(cert.creation?.prompt);
	document.title = `${title} · ${editionLine(cert)} · three.ws`;

	host.innerHTML = `
		<a class="ct-back" href="/materialize">← Materialize</a>
		<p class="ct-kicker"><span class="ct-dot${cert.solana_signature ? '' : ' ct-dot--pending'}"></span>Certificate of authenticity</p>
		<h1 class="ct-title">${esc(title)}</h1>
		<p class="ct-sub">
			A physical print made on three.ws. ${esc(editionLine(cert))}, printed
			${esc(formatDate(cert.printed_at) || 'on the date recorded on the order')}, with the exact bytes
			that were printed hashed and attested on Solana.
		</p>
		<div class="ct-grid">
			<div>
				${stage(cert)}
				${lineage(cert)}
			</div>
			<div>
				${facts(cert)}
				${proof(cert)}
				${qrCard(cert)}
				${verifySection(cert)}
			</div>
		</div>`;
	host.setAttribute('aria-busy', 'false');

	wireCopy('ct-copy-memo', () => cert.memo || '', 'Memo copied');
	wireCopy('ct-copy-link', () => cert.certificate_url || window.location.href, 'Link copied');
	announce(`${title}, ${editionLine(cert)}.`);
}

function wireCopy(id, read, okLabel) {
	const btn = document.getElementById(id);
	if (!btn) return;
	btn.addEventListener('click', async () => {
		const original = btn.textContent;
		try {
			await navigator.clipboard.writeText(read());
			btn.textContent = okLabel;
			announce(okLabel);
		} catch {
			// Clipboard is blocked (insecure context, denied permission). Select the
			// text instead so the copy is one keystroke away rather than impossible.
			const target = document.getElementById(id === 'ct-copy-memo' ? 'ct-memo' : 'ct-hash');
			if (target) {
				const range = document.createRange();
				range.selectNodeContents(target);
				const sel = window.getSelection();
				sel?.removeAllRanges();
				sel?.addRange(range);
			}
			btn.textContent = 'Selected, press copy';
		}
		setTimeout(() => {
			btn.textContent = original;
		}, 1800);
	});
}

function renderLookup(message = '') {
	const host = root();
	if (!host) return;
	document.title = 'Certificate of Authenticity · three.ws';
	host.innerHTML = `
		<a class="ct-back" href="/materialize">← Materialize</a>
		<p class="ct-kicker"><span class="ct-dot"></span>Provenance</p>
		<h1 class="ct-title">Check a certificate</h1>
		<p class="ct-sub">
			Every physical print made on three.ws ships with a certificate: the model it was printed
			from, its edition number, the SHA-256 of the exact bytes that went to the printer, and a
			Solana transaction attesting them. Scan the code on the box, or type the certificate
			number printed beside it.
		</p>
		<form class="ct-lookup" id="ct-lookup">
			<input class="ct-input" id="ct-lookup-input" name="cert" inputmode="latin"
				autocomplete="off" spellcheck="false" maxlength="24"
				placeholder="24-character certificate number" aria-label="Certificate number" />
			<button class="ct-btn ct-btn--primary" type="submit">Open certificate</button>
		</form>
		<p class="ct-message" id="ct-lookup-message" role="alert">${esc(message)}</p>`;
	host.setAttribute('aria-busy', 'false');

	const form = document.getElementById('ct-lookup');
	const input = document.getElementById('ct-lookup-input');
	const msg = document.getElementById('ct-lookup-message');
	form?.addEventListener('submit', (e) => {
		e.preventDefault();
		const value = String(input?.value || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '');
		if (!CERT_ID_RE.test(value)) {
			if (msg) msg.textContent = 'A certificate number is 24 characters, digits and the letters a to f.';
			input?.focus();
			return;
		}
		window.location.assign(`/cert/${value}`);
	});
	input?.focus();
}

function renderError(title, body, { retry = false } = {}) {
	const host = root();
	if (!host) return;
	host.innerHTML = `
		<a class="ct-back" href="/materialize">← Materialize</a>
		<h1 class="ct-title">${esc(title)}</h1>
		<p class="ct-sub">${esc(body)}</p>
		<div class="ct-actions">
			${retry ? '<button class="ct-btn ct-btn--primary" type="button" id="ct-retry">Try again</button>' : ''}
			<a class="ct-btn" href="/cert">Check another certificate</a>
			<a class="ct-btn" href="/materialize">About Materialize</a>
		</div>`;
	host.setAttribute('aria-busy', 'false');
	document.getElementById('ct-retry')?.addEventListener('click', () => {
		void load();
	});
	announce(title);
}

async function load() {
	const id = certIdFromPath();
	if (!id) {
		renderLookup();
		return;
	}
	try {
		const res = await apiFetch(`/api/print/certs/${encodeURIComponent(id)}`);
		if (res.status === 404) {
			renderError(
				'No certificate with that number',
				'Check the number printed on the card, or scan the code on the box again. Certificates are issued when an order ships.',
			);
			return;
		}
		if (!res.ok) throw new Error(`certificate request failed: ${res.status}`);
		const body = await res.json();
		if (!body?.certificate) throw new Error('certificate missing from response');
		renderCertificate(body.certificate);
	} catch (err) {
		log.error('certificate load failed', err);
		renderError(
			'Could not load this certificate',
			'The connection failed on the way here. The certificate itself is unaffected.',
			{ retry: true },
		);
	}
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', () => void load());
	} else {
		void load();
	}
}
