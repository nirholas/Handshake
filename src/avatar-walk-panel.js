/**
 * Walk-preview panel, shared by /avatars/:id/edit ("Walk" tab) and the Avatar
 * Studio ("Walk" tab).
 *
 * The panel is two things at once:
 *   1. An in-stage locomotion preview. `AvatarWalkPreview` takes over the
 *      editor's existing TalkScene, so every sculpt, colour, garment and
 *      accessory edit shows up in motion without a reload.
 *   2. A handoff into the full /walk page. That leg needs a saved avatar: the
 *      draft endpoint resolves the avatar's private base GLB server-side and
 *      presigns it (see api/avatars/draft/[id].js), which it can only do for a
 *      record the caller owns. An unsaved Studio draft has no such record, so
 *      the button is replaced by an honest "save first" line rather than a
 *      control that would 400.
 *
 * The module owns its own CSS so neither host page has to declare `.ae-walk-*`.
 */

import { AvatarWalkPreview } from './avatar-edit-walk.js';
import { log } from './shared/log.js';

const KEYS = ['W', 'A', 'S', 'D'];

function esc(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

/**
 * Create a walk-preview controller bound to one editor's scene.
 *
 * @param {Object} options
 * @param {() => Object|null} options.getScene - the live TalkScene (null before mount).
 * @param {() => HTMLElement|null} options.getStageEl - the 3D stage container.
 * @param {() => void} options.pauseAmbient - stop the editor's procedural idle layer.
 * @param {() => void} options.resumeAmbient - restart it on exit.
 * @param {string} [options.buttonClass] - host page's button class for the handoff CTA.
 * @param {string} [options.emptyClass] - host page's "waiting for the avatar" class.
 * @param {() => Promise<string>} [options.openWalkUrl] - resolve the /walk URL to
 *   open, given the currently selected environment. Omit it (or return null) and
 *   the handoff CTA is replaced by `saveHint`.
 * @param {string} [options.saveHint] - what to say when the handoff is unavailable.
 */
export function createWalkPanel({
	getScene,
	getStageEl,
	pauseAmbient,
	resumeAmbient,
	buttonClass = 'ae-btn',
	emptyClass = 'ae-empty',
	openWalkUrl = null,
	saveHint = '',
}) {
	let preview = null;
	let statusEl = null;

	function getPreview() {
		if (preview) return preview;
		const scene = getScene();
		if (!scene?.root) return null;
		preview = new AvatarWalkPreview({
			scene,
			stageEl: getStageEl(),
			pauseAmbient,
			resumeAmbient,
		});
		preview.onStatus((msg) => {
			if (statusEl) statusEl.textContent = msg || '';
		});
		return preview;
	}

	function enter() {
		const p = getPreview();
		if (!p || p.active) return;
		p.enter().catch((err) => {
			log.warn('[walk-panel] preview enter failed:', err?.message);
			if (statusEl) statusEl.textContent = `Could not start walk: ${err.message}`;
		});
	}

	function exit() {
		if (preview?.active) preview.exit();
	}

	function render(panel) {
		injectCss();
		if (!getScene()?.root) {
			panel.innerHTML = `<div class="${esc(emptyClass)}">Waiting for avatar to load...</div>`;
			return;
		}
		// Re-rendering would drop the chosen environment, and renderActivePanel
		// re-fires while the Walk tab stays active (a save, an undo). Re-entering
		// locomotion is idempotent, so that is all this branch has to do.
		if (panel.querySelector('.ae-walk')) {
			enter();
			return;
		}

		const kbd = KEYS.map((k) => `<kbd>${k}</kbd>`).join('');
		const cta = openWalkUrl
			? `<button class="${esc(buttonClass)} primary ae-walk-open" type="button">Open in Walk page &rarr;</button>`
			: `<p class="ae-walk-note ae-walk-hint">${esc(saveHint)}</p>`;

		panel.innerHTML = `
			<div class="ae-walk">
				<p class="ae-walk-lede">
					See your avatar in motion. It auto-walks a circle around the stage,
					and you can take over any time with ${kbd} or the arrow keys.
					Every sculpt, outfit, and accessory edit shows up here live.
				</p>

				<label class="ae-walk-field">
					<span class="ae-walk-field-label">Environment</span>
					<select class="ae-walk-select" aria-label="Preview environment">
						<option value="void">Void</option>
					</select>
				</label>

				${cta}
				<p class="ae-walk-note ae-walk-status" role="status" aria-live="polite"></p>
			</div>
		`;

		statusEl = panel.querySelector('.ae-walk-status');
		const envSel = panel.querySelector('.ae-walk-select');
		envSel.addEventListener('change', () => getPreview()?.setEnvironment(envSel.value));
		panel.querySelector('.ae-walk-open')?.addEventListener('click', (e) => {
			openInWalkPage(e.currentTarget, envSel.value);
		});

		enter();

		// Backfill the real environment list once the manifest resolves. Until
		// then the select offers the one environment the runtime always has.
		const p = getPreview();
		p?.listEnvironments().then((envs) => {
			if (!envs || envs.length <= 1) return;
			const current = p.envName || 'void';
			envSel.innerHTML = envs
				.map(
					(e) =>
						`<option value="${esc(e.name)}"${e.name === current ? ' selected' : ''}>${esc(e.label)}</option>`,
				)
				.join('');
		});
	}

	async function openInWalkPage(btn, env) {
		if (!openWalkUrl) return;
		btn.disabled = true;
		if (statusEl) statusEl.textContent = 'Preparing preview...';
		try {
			const url = await openWalkUrl(env);
			if (!url) throw new Error('Could not build the preview link.');
			window.open(url, '_blank', 'noopener');
			if (statusEl) statusEl.textContent = 'Opened in a new tab.';
		} catch (err) {
			if (statusEl) statusEl.textContent = err.message;
		} finally {
			btn.disabled = false;
		}
	}

	return {
		render,
		enter,
		exit,
		get active() {
			return !!preview?.active;
		},
		/** Re-measure the clip stack after a proportion edit moved the hips. */
		remeasureProportions() {
			preview?.remeasureProportions();
		},
	};
}

/* ── styles ──────────────────────────────────────────────────────────────── */

let cssInjected = false;
function injectCss() {
	if (cssInjected || typeof document === 'undefined') return;
	cssInjected = true;
	const style = document.createElement('style');
	style.id = 'ae-walk-css';
	style.textContent = `
		.ae-walk { display: flex; flex-direction: column; gap: 16px; padding: 4px 2px; }
		.ae-walk-lede { margin: 0; font-size: 13px; line-height: 1.6; color: var(--text-2, #a1a1aa); }
		.ae-walk-lede kbd {
			display: inline-block; min-width: 18px; padding: 1px 5px; margin: 0 1px;
			font-family: ui-monospace, 'SF Mono', monospace; font-size: 11px; text-align: center;
			color: var(--text, #fafafa); background: var(--panel-2, #161616);
			border: 1px solid var(--border-2, #2a2a2a); border-bottom-width: 2px; border-radius: 5px;
		}
		.ae-walk-field { display: flex; flex-direction: column; gap: 6px; }
		.ae-walk-field-label {
			font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--text-3, #71717a);
		}
		.ae-walk-select {
			width: 100%; background: var(--panel-2, #161616); border: 1px solid var(--border-2, #2a2a2a);
			border-radius: 8px; color: var(--text, #fafafa); padding: 9px 12px; font-size: 13px;
			font-family: inherit; outline: none; cursor: pointer; transition: border-color 0.15s;
		}
		.ae-walk-select:focus-visible { border-color: var(--accent, #fafafa); }
		.ae-walk-open { align-self: flex-start; }
		.ae-walk-note { margin: 0; font-size: 12px; line-height: 1.5; color: var(--text-3, #71717a); min-height: 16px; }
		.ae-walk-hint { color: var(--text-2, #a1a1aa); }
	`;
	document.head.appendChild(style);
}
