/**
 * Avatar rigging panel, shared by /avatars/:id/edit ("Animate" tab) and the
 * Avatar Studio edit mode ("Rig" tab).
 *
 * A static (un-rigged) mesh can't play the pre-baked animation library: it has
 * no skeleton to drive. This panel turns such a mesh into an animation-ready
 * avatar by routing it through the platform's auto-rig backend (the model-rig
 * worker on the GCP pipeline, or a Replicate rerig model) via the existing
 * regenerate API.
 *
 * Flow (client side of the documented REGENERATE.md contract):
 *   1. POST /api/avatars/regenerate { sourceAvatarId, mode: 'rerig' }  → jobId
 *   2. Poll GET /api/avatars/regenerate-status?jobId=…  until done|failed
 *   3. On done → fetch resultGlbUrl, canonicalize bones, register it as a new
 *      owned avatar (parent = source) via saveRemoteGlbToAccount.
 *   4. Hand the new rigged avatar back to the editor via onRigged().
 *
 * Non-destructive by design: rigging produces a new sibling avatar so the
 * original static mesh is never overwritten.
 */

import { saveRemoteGlbToAccount } from './account.js';
import { log } from './shared/log.js';
import { classifyRig } from './shared/rig-classify.js';

const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // auto-rig backends finish well within 5 min

// ── Rig status ─────────────────────────────────────────────────────────

/**
 * Derive a human-meaningful rig status from an avatar's source_meta. The
 * reconstruct pipeline stamps is_rigged / skeleton_joint_count when it
 * inspects a delivered GLB (api/_lib/glb-inspect.js); uploads that were never
 * inspected leave it unknown. Thin adapter over the shared classifier
 * (src/shared/rig-classify.js) — kept for back-compat with this module's
 * callers, which expect the { rigged, known, jointCount } shape.
 * @returns {{ rigged: boolean, known: boolean, jointCount: number|null }}
 */
export function getRigStatus(avatar) {
	const { rigged, known, jointCount } = classifyRig(avatar);
	return { rigged, known, jointCount };
}

// /api/config is small and stable for the session — fetch once.
let _riggingAvailable = null;
async function isRiggingAvailable() {
	if (_riggingAvailable !== null) return _riggingAvailable;
	try {
		const r = await fetch('/api/config', { credentials: 'omit' });
		const j = await r.json();
		_riggingAvailable = j?.features?.avatarRigging === true;
	} catch (err) {
		log.warn('[rig] config probe failed; assuming rigging unavailable', err?.message);
		_riggingAvailable = false;
	}
	return _riggingAvailable;
}

// ── Panel ──────────────────────────────────────────────────────────────

/**
 * Mount the rig panel into a container.
 * @param {Object} options
 * @param {HTMLElement} options.container
 * @param {Object} options.avatar - the avatar being edited
 * @param {(newAvatar: Object) => void} options.onRigged - called with the new rigged avatar
 * @param {string} [options.buttonClass] - host page's button class, so the
 *   action button inherits the surrounding editor's chrome. Defaults to the
 *   avatar editor's `ae-btn`; Avatar Studio passes `as-btn`.
 */
export function renderRigPanel({ container, avatar, onRigged, buttonClass = 'ae-btn' }) {
	injectRigCss();
	const status = getRigStatus(avatar);
	const state = { phase: 'idle', message: null, progress: 0, jobId: null };
	let cancelled = false;
	let pollTimer = null;

	function setState(patch) {
		Object.assign(state, patch);
		paint();
	}

	function cleanup() {
		cancelled = true;
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = null;
	}

	async function startRigging() {
		setState({ phase: 'submitting', message: 'Submitting your model to the rigging backend…', progress: 0.05 });
		let jobId;
		try {
			const res = await fetch('/api/avatars/regenerate', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ sourceAvatarId: avatar.id, mode: 'rerig' }),
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				const msg =
					res.status === 501
						? "Auto-rigging isn't enabled on this deployment yet."
						: body.error_description || body.error || `Couldn't start rigging (${res.status}).`;
				setState({ phase: 'error', message: msg });
				return;
			}
			jobId = body.jobId;
		} catch (err) {
			setState({ phase: 'error', message: err?.message || 'Network error starting the rig job.' });
			return;
		}
		setState({ phase: 'rigging', message: 'Building skeleton and binding skin weights…', progress: 0.2, jobId });
		pollUntilDone(jobId, Date.now());
	}

	function pollUntilDone(jobId, startedAt) {
		if (cancelled) return;
		pollTimer = setTimeout(async () => {
			if (cancelled) return;
			if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
				setState({ phase: 'error', message: 'Rigging is taking longer than expected. Try again in a few minutes.' });
				return;
			}
			let body;
			try {
				const r = await fetch(`/api/avatars/regenerate-status?jobId=${encodeURIComponent(jobId)}`, {
					credentials: 'include',
				});
				body = await r.json().catch(() => ({}));
				if (!r.ok) throw new Error(body.error_description || body.error || `status ${r.status}`);
			} catch (err) {
				// Transient poll failure — keep waiting, surface only on timeout.
				log.warn('[rig] status poll failed; retrying', err?.message);
				pollUntilDone(jobId, startedAt);
				return;
			}

			if (body.status === 'failed') {
				setState({ phase: 'error', message: body.error || 'The rigging backend could not rig this model.' });
				return;
			}
			if (body.status === 'done' && body.resultGlbUrl) {
				await materialize(body.resultGlbUrl);
				return;
			}
			// queued | running | rigging — nudge the progress bar forward and keep polling.
			const elapsed = (Date.now() - startedAt) / POLL_TIMEOUT_MS;
			setState({ progress: Math.min(0.9, 0.2 + elapsed * 0.7) });
			pollUntilDone(jobId, startedAt);
		}, POLL_INTERVAL_MS);
	}

	async function materialize(glbUrl) {
		setState({ phase: 'saving', message: 'Saving your rigged, animation-ready avatar…', progress: 0.95 });
		try {
			const newAvatar = await saveRemoteGlbToAccount(glbUrl, {
				name: `${avatar.name || 'Avatar'} (rigged)`,
				visibility: avatar.visibility || 'private',
				tags: Array.from(new Set([...(avatar.tags || []), 'rigged'])),
				source: 'upload',
				source_meta: {
					rigged_from: avatar.id,
					parent_avatar_id: avatar.id,
					is_rigged: true,
					rig_provider: 'auto-rig',
				},
			});
			setState({ phase: 'done', message: null, progress: 1 });
			onRigged?.(newAvatar);
		} catch (err) {
			const code = err?.code;
			const msg =
				code === 'not_signed_in'
					? 'Your session expired. Sign in again and retry.'
					: err?.message || 'Rigging finished but saving the result failed. Try again.';
			setState({ phase: 'error', message: msg });
		}
	}

	function paint() {
		container.innerHTML = '';
		container.appendChild(buildView());
	}

	function buildView() {
		const root = document.createElement('div');
		root.className = 'ae-rig';

		// Busy phases share one progress view.
		if (['submitting', 'rigging', 'saving'].includes(state.phase)) {
			root.appendChild(busyView(state));
			return root;
		}
		if (state.phase === 'done') {
			root.appendChild(doneView());
			return root;
		}
		root.appendChild(statusView());
		if (state.phase === 'error' && state.message) root.appendChild(errorView(state.message));
		root.appendChild(actionView());
		return root;
	}

	function statusView() {
		const el = document.createElement('div');
		el.className = 'ae-rig-status';
		const rigged = status.rigged;
		const dotClass = rigged ? 'ok' : status.known ? 'warn' : 'unknown';
		const label = rigged
			? 'Animation-ready'
			: status.known
				? 'Static mesh'
				: 'Rig status unknown';
		const detail = rigged
			? status.jointCount
				? `This avatar has a skeleton (${status.jointCount} joints) and can play the animation library.`
				: 'This avatar already has a skeleton and can play the animation library.'
			: status.known
				? 'This is a static mesh — no skeleton, so it can’t walk, wave, or emote. Rig it to unlock animations.'
				: 'We haven’t detected a skeleton on this model. Rig it to make sure it can animate.';
		el.innerHTML = `
			<div class="ae-rig-pill ${dotClass}">
				<span class="ae-rig-dot"></span>${label}
			</div>
			<p class="ae-rig-detail">${detail}</p>
		`;
		return el;
	}

	function actionView() {
		const el = document.createElement('div');
		el.className = 'ae-rig-action';

		if (status.rigged) {
			// Already rigged — offer a (clearly secondary) re-rig for broken/partial rigs.
			const note = document.createElement('p');
			note.className = 'ae-rig-note';
			note.textContent = 'Already animation-ready. You only need to re-rig if animations look broken.';
			el.appendChild(note);
		}

		const btn = document.createElement('button');
		btn.className = `${buttonClass} ${status.rigged ? '' : 'primary'}`.trim();
		btn.textContent = status.rigged ? 'Re-rig anyway' : 'Rig this model';
		el.appendChild(btn);

		// Gate the action on backend availability — checked lazily so the panel
		// paints instantly. If unavailable, swap in an honest disabled state.
		isRiggingAvailable().then((available) => {
			if (cancelled) return;
			if (!available) {
				btn.disabled = true;
				btn.textContent = 'Auto-rigging unavailable';
				const hint = document.createElement('p');
				hint.className = 'ae-rig-note';
				hint.textContent =
					'Auto-rigging isn’t enabled on this deployment. Upload an already-rigged GLB to animate it.';
				el.appendChild(hint);
			} else {
				btn.addEventListener('click', startRigging);
			}
		});

		return el;
	}

	function busyView(s) {
		const el = document.createElement('div');
		el.className = 'ae-rig-busy';
		const pct = Math.round((s.progress || 0) * 100);
		el.innerHTML = `
			<div class="ae-rig-spinner" aria-hidden="true"></div>
			<p class="ae-rig-busy-msg">${s.message || 'Working…'}</p>
			<div class="ae-rig-bar"><div class="ae-rig-bar-fill" style="width:${pct}%"></div></div>
			<p class="ae-rig-busy-hint">Rigging usually takes 30–90 seconds. You can keep editing other tabs.</p>
		`;
		return el;
	}

	function doneView() {
		const el = document.createElement('div');
		el.className = 'ae-rig-done';
		el.innerHTML = `
			<div class="ae-rig-pill ok"><span class="ae-rig-dot"></span>Rigged</div>
			<p class="ae-rig-detail">Your model now has a skeleton and is loading in the editor. It can play the full animation library.</p>
		`;
		return el;
	}

	function errorView(message) {
		const el = document.createElement('div');
		el.className = 'ae-rig-error';
		el.textContent = message;
		return el;
	}

	paint();
	return { unmount: cleanup };
}

/* ── styles ──────────────────────────────────────────────────────────────── */

// The panel is mounted by two different editors, so it owns its own chrome
// rather than assuming the host page declared `.ae-rig-*`. Every token carries
// a literal fallback: Avatar Studio does not define `--warn`, and a spinner
// that silently loses its keyframes reads as a hung job.
let rigCssInjected = false;
function injectRigCss() {
	if (rigCssInjected || typeof document === 'undefined') return;
	rigCssInjected = true;
	const style = document.createElement('style');
	style.id = 'ae-rig-css';
	style.textContent = `
		.ae-rig { display: flex; flex-direction: column; gap: 16px; padding: 4px 2px; }
		.ae-rig-pill {
			display: inline-flex; align-items: center; gap: 8px; align-self: flex-start;
			padding: 5px 12px; border-radius: 999px; font-size: 12px; font-weight: 600;
			letter-spacing: 0.01em; border: 1px solid var(--border-2, #2a2a2a); color: var(--text-2, #a1a1aa);
		}
		.ae-rig-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-3, #71717a); }
		.ae-rig-pill.ok { color: #34d399; border-color: rgba(52, 211, 153, 0.35); }
		.ae-rig-pill.ok .ae-rig-dot { background: #34d399; box-shadow: 0 0 8px rgba(52, 211, 153, 0.6); }
		.ae-rig-pill.warn { color: var(--warn, #f59e0b); border-color: color-mix(in srgb, var(--warn, #f59e0b) 35%, transparent); }
		.ae-rig-pill.warn .ae-rig-dot { background: var(--warn, #f59e0b); }
		.ae-rig-pill.unknown { color: var(--text-3, #71717a); }
		.ae-rig-detail { margin: 0; font-size: 13px; line-height: 1.5; color: var(--text-2, #a1a1aa); }
		.ae-rig-action { display: flex; flex-direction: column; gap: 10px; }
		.ae-rig-action button { align-self: flex-start; }
		.ae-rig-note { margin: 0; font-size: 12px; line-height: 1.5; color: var(--text-3, #71717a); }
		.ae-rig-error {
			font-size: 13px; line-height: 1.5; color: var(--danger, #f43f5e);
			padding: 10px 12px; border: 1px solid rgba(244, 63, 94, 0.3);
			border-radius: 10px; background: rgba(244, 63, 94, 0.06);
		}
		.ae-rig-busy { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 28px 8px; text-align: center; }
		.ae-rig-spinner {
			width: 28px; height: 28px; border-radius: 50%;
			border: 3px solid var(--border-2, #2a2a2a); border-top-color: var(--text, #fafafa);
			animation: ae-rig-spin 0.9s linear infinite;
		}
		@keyframes ae-rig-spin { to { transform: rotate(360deg); } }
		@media (prefers-reduced-motion: reduce) { .ae-rig-spinner { animation-duration: 2.4s; } }
		.ae-rig-busy-msg { margin: 0; font-size: 14px; font-weight: 600; color: var(--text, #fafafa); }
		.ae-rig-busy-hint { margin: 0; font-size: 12px; color: var(--text-3, #71717a); }
		.ae-rig-bar { width: 100%; height: 6px; border-radius: 999px; background: var(--panel-2, #161616); overflow: hidden; }
		.ae-rig-bar-fill { height: 100%; background: var(--text, #fafafa); border-radius: 999px; transition: width 0.4s ease; }
		.ae-rig-done { display: flex; flex-direction: column; gap: 14px; padding: 8px 2px; }
	`;
	document.head.appendChild(style);
}
