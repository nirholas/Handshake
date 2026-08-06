/**
 * Shared "Validated" badge for ERC-8004 agents — single source of truth for the
 * glTF/schema validation attestation pill, rendered identically wherever an
 * on-chain agent is drawn (profile, marketplace, directory).
 *
 * Backed by a real on-chain ValidationRegistry record read walletlessly through
 * GET /api/erc8004/validation. Five designed states:
 *
 *   pending:        fetching, or a re-validation is in flight (spinner)
 *   validated:      a passing attestation exists (green, links to proof + validator)
 *   failed:         an attestation exists but the model has errors (red, shows the reason)
 *   requested:      a validation request is open on-chain, no verdict yet
 *   not-validated:  registry deployed, nothing requested (owner sees a "Validate" action)
 *
 * When the ValidationRegistry isn't deployed on the agent's chain the badge
 * renders nothing — there's nothing to attest against, so we don't add noise.
 */

import { failureReason } from '../erc8004/validation-report.js';

const STYLE_ID = 'tws-validation-badge-styles';

function esc(s) {
	return String(s == null ? '' : s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

/** Fetch the latest on-chain validation state for an agent. Never throws. */
export async function fetchValidationState(chainId, agentId) {
	try {
		const r = await fetch(
			`/api/erc8004/validation?chainId=${encodeURIComponent(chainId)}&agentId=${encodeURIComponent(agentId)}`,
			{ headers: { accept: 'application/json' } },
		);
		if (!r.ok) return null;
		const data = await r.json();
		return data?.validation || null;
	} catch {
		return null;
	}
}

/**
 * Trigger (or re-trigger) an attestation for the agent. Returns the parsed
 * response, including `request` when the owner still has to open the on-chain
 * validation request (`error: 'validation_request_required'`).
 *
 * @param {number} chainId
 * @param {string|number} agentId
 * @param {string} [glbUrl]
 * @param {string} [requestHash]  Answer this request: set on the retry, after the
 *                                owner's wallet has opened it.
 */
export async function requestValidation(chainId, agentId, glbUrl, requestHash) {
	const r = await fetch('/api/erc8004/validate', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		credentials: 'include',
		body: JSON.stringify({
			chainId,
			agentId: String(agentId),
			...(glbUrl ? { glbUrl } : {}),
			...(requestHash ? { requestHash } : {}),
		}),
	});
	const data = await r.json().catch(() => ({}));
	return { ok: r.ok, status: r.status, ...data };
}

/** Inject the badge stylesheet once. Idempotent and SSR-safe. */
export function ensureValidationBadgeStyles() {
	if (typeof document === 'undefined') return;
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `
.tws-vb{display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border-radius:999px;
	font:600 12px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.01em;
	text-decoration:none;white-space:nowrap;vertical-align:middle;max-width:100%;
	border:1px solid transparent;transition:background .15s ease,border-color .15s ease,transform .15s ease;}
.tws-vb-ico{width:13px;height:13px;flex:none;display:inline-flex;align-items:center;justify-content:center;}
.tws-vb-label{overflow:hidden;text-overflow:ellipsis;}
.tws-vb-sub{opacity:.72;font-weight:500;}
.tws-vb-sub::before{content:"·";margin-right:5px;opacity:.55;}
a.tws-vb{cursor:pointer;}
a.tws-vb:hover{transform:translateY(-1px);}
a.tws-vb:active{transform:translateY(0);}
a.tws-vb:focus-visible{outline:2px solid currentColor;outline-offset:2px;}
.tws-vb--ok{color:#34d399;background:rgba(16,185,129,.12);border-color:rgba(16,185,129,.32);}
a.tws-vb--ok:hover{background:rgba(16,185,129,.2);border-color:rgba(16,185,129,.55);}
.tws-vb--fail{color:#f87171;background:rgba(248,113,113,.12);border-color:rgba(248,113,113,.32);}
a.tws-vb--fail:hover{background:rgba(248,113,113,.2);border-color:rgba(248,113,113,.55);}
.tws-vb--none{color:#94a3b8;background:rgba(148,163,184,.1);border-color:rgba(148,163,184,.26);}
.tws-vb--pending{color:#94a3b8;background:rgba(148,163,184,.1);border-color:rgba(148,163,184,.26);}
.tws-vb-act{margin-left:6px;padding:2px 8px;border-radius:999px;border:1px solid currentColor;
	background:transparent;color:inherit;font:600 11px/1 inherit;cursor:pointer;opacity:.85;
	transition:opacity .15s ease,background .15s ease;}
.tws-vb-act:hover{opacity:1;background:rgba(148,163,184,.16);}
.tws-vb-act:disabled{opacity:.5;cursor:default;}
.tws-vb-spin{width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;
	border-radius:50%;animation:tws-vb-spin .7s linear infinite;}
@keyframes tws-vb-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.tws-vb-spin{animation:none;}}
`;
	(document.head || document.documentElement).appendChild(style);
}

const CHECK_SVG =
	'<svg class="tws-vb-ico" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CROSS_SVG =
	'<svg class="tws-vb-ico" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const DASH_SVG =
	'<svg class="tws-vb-ico" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 8h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

function badgeNode({ variant, label, sub, title, href, icon }) {
	ensureValidationBadgeStyles();
	const cls = `tws-vb tws-vb--${variant}`;
	const inner = `${icon || ''}<span class="tws-vb-label">${esc(label)}</span>${
		sub ? `<span class="tws-vb-sub">${esc(sub)}</span>` : ''
	}`;
	const tpl = document.createElement('template');
	if (href) {
		tpl.innerHTML = `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="${esc(title || label)}">${inner}</a>`;
	} else {
		tpl.innerHTML = `<span class="${cls}" title="${esc(title || label)}" role="img" aria-label="${esc(label)}">${inner}</span>`;
	}
	const node = tpl.content.firstElementChild;
	if (node.tagName === 'A') node.addEventListener('click', (e) => e.stopPropagation());
	return node;
}

/**
 * Render the badge for a resolved validation state. Returns null when there's
 * nothing to show (registry not deployed on this chain).
 *
 * @param {object} state  Response from GET /api/erc8004/validation.
 * @param {object} [opts]
 * @param {boolean} [opts.isOwner=false]  Owner sees a Validate / Re-validate action.
 * @param {() => void} [opts.onRevalidate]  Invoked when the owner clicks the action.
 * @param {string} [opts.failureText]  Pre-resolved failure reason for the failed state.
 */
export function validationBadgeEl(state, opts = {}) {
	if (!state || state.available === false) return null;
	const { isOwner = false, onRevalidate, failureText } = opts;

	let node;
	if (!state.exists && state.openRequests > 0) {
		node = badgeNode({
			variant: 'none',
			label: 'Validation pending',
			sub: state.openRequests > 1 ? `${state.openRequests} requests` : undefined,
			title: 'A validation request is open on-chain, awaiting the validator verdict',
			icon: DASH_SVG,
		});
	} else if (!state.exists) {
		node = badgeNode({
			variant: 'none',
			label: 'Not validated',
			title: 'No on-chain glTF validation attestation yet',
			icon: DASH_SVG,
		});
	} else if (state.passed) {
		node = badgeNode({
			variant: 'ok',
			label: 'Validated',
			sub: 'glTF',
			title: `glTF validation passed${state.validatedAt ? ` · ${new Date(state.validatedAt).toLocaleDateString()}` : ''}${
				state.validator ? ` · validator ${state.validator.slice(0, 6)}…` : ''
			} · view proof →`,
			href: state.proofUrlResolved || state.proofURI || undefined,
			icon: CHECK_SVG,
		});
	} else {
		node = badgeNode({
			variant: 'fail',
			label: 'Validation failed',
			sub: failureText || undefined,
			title: `glTF validation failed${failureText ? `: ${failureText}` : ''} · view report →`,
			href: state.proofUrlResolved || state.proofURI || undefined,
			icon: CROSS_SVG,
		});
	}

	// Owner action — validate (first time) or re-validate (refresh after a GLB
	// update). The agent is registered regardless; this only (re)records proof.
	if (isOwner && onRevalidate) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'tws-vb-act';
		btn.textContent = state.exists ? 'Re-validate' : 'Validate';
		btn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			onRevalidate();
		});
		const wrap = document.createElement('span');
		wrap.style.display = 'inline-flex';
		wrap.style.alignItems = 'center';
		wrap.append(node, btn);
		return wrap;
	}

	return node;
}

/** A standalone pending badge (used while fetching / attesting). */
export function pendingBadgeEl(label = 'Validating…') {
	ensureValidationBadgeStyles();
	const tpl = document.createElement('template');
	tpl.innerHTML = `<span class="tws-vb tws-vb--pending" role="status" aria-live="polite"><span class="tws-vb-spin" aria-hidden="true"></span><span class="tws-vb-label">${esc(label)}</span></span>`;
	return tpl.content.firstElementChild;
}

/**
 * Mount the validation badge into a container: shows a pending pill, fetches the
 * on-chain state, renders the right variant, and (for owners) wires the
 * Validate / Re-validate action with live pending feedback.
 *
 * @param {object} p
 * @param {HTMLElement} p.container  Element to render into (its contents are replaced).
 * @param {number} p.chainId
 * @param {string|number} p.agentId
 * @param {boolean} [p.isOwner=false]
 * @param {string} [p.glbUrl]  Passed through to re-validation (optional — server can resolve).
 * @returns {Promise<void>}
 */
export async function mountValidationBadge({ container, chainId, agentId, isOwner = false, glbUrl }) {
	if (!container || !chainId || agentId == null) return;
	ensureValidationBadgeStyles();

	const render = (node) => {
		container.replaceChildren();
		if (node) container.appendChild(node);
	};

	render(pendingBadgeEl());

	const state = await fetchValidationState(chainId, agentId);
	if (!state) {
		render(null);
		return;
	}

	// For a failing attestation, fetch the pinned report to surface what failed.
	let failureText = '';
	if (state.exists && !state.passed && (state.proofUrlResolved || state.proofURI)) {
		try {
			const r = await fetch(state.proofUrlResolved || state.proofURI);
			if (r.ok) failureText = failureReason(await r.json());
		} catch {
			/* report unreachable — badge still shows the failed state */
		}
	}

	const deferred = (sub, title) =>
		render(
			badgeNode({
				variant: 'none',
				label: 'Validation deferred',
				sub,
				title: title || 'validation could not be recorded',
				icon: DASH_SVG,
			}),
		);

	const onRevalidate = async () => {
		render(pendingBadgeEl(state.exists ? 'Re-validating…' : 'Validating…'));
		try {
			let result = await requestValidation(chainId, agentId, glbUrl);

			// The registry only lets the agent's owner open a validation request, so
			// when the platform validator holds no operator authority the server hands
			// back the exact call to sign. Prompt for it, then answer the request.
			if (result.error === 'validation_request_required' && result.request) {
				render(pendingBadgeEl('Confirm in wallet…'));
				const { openValidationRequest } = await import('../erc8004/validation-request.js');
				try {
					await openValidationRequest(result.request);
				} catch (err) {
					deferred('request not sent', err?.shortMessage || err?.message || 'the wallet declined the request');
					return;
				}
				render(pendingBadgeEl('Validating…'));
				result = await requestValidation(chainId, agentId, glbUrl, result.request.requestHash);
			}

			if (!result.ok) {
				// Surface the ops state inline rather than silently reverting.
				deferred(result.error || `${result.status}`, result.error_description || result.error);
				return;
			}
		} catch {
			/* fall through to a fresh re-fetch */
		}
		await mountValidationBadge({ container, chainId, agentId, isOwner, glbUrl });
	};

	render(validationBadgeEl(state, { isOwner, onRevalidate, failureText }));
}
