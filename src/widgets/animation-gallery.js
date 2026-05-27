/**
 * Animation Gallery Widget — a clip browser overlaid on the 3D viewer.
 *
 * Lets visitors tap through every animation clip on a rigged avatar without
 * touching dat.GUI or the full controls chrome. Supports:
 *
 *   - `defaultClip`     — clip name that autoplays on mount
 *   - `loopAll`         — chain clips in order on completion
 *   - `showClipPicker`  — hide the picker UI (used by parent-driven embeds)
 *
 * Parent pages can still send `widget:command` postMessages with
 * `play_clip { name }` to drive playback externally; this widget's UI and
 * external commands coexist.
 */

import { LoopOnce, LoopRepeat } from 'three';

const POLL_INTERVAL_MS = 100;
const POLL_MAX_MS = 8000;

/**
 * @param {import('../viewer.js').Viewer} viewer
 * @param {object} config  Gallery config (see widget-types.js 'animation-gallery').
 * @param {HTMLElement} container  Root container.
 * @returns {Promise<{ destroy: () => void }>}
 */
export async function mountAnimationGallery(viewer, config, container) {
	const state = {
		destroyed: false,
		currentAction: null,
		currentClipName: null,
		finishedHandler: null,
		panel: null,
	};

	// Turntable look-and-feel by default — autoRotate inherited from brand cfg.
	if (viewer.controls && config.autoRotate !== false) {
		viewer.controls.autoRotate = true;
		if (typeof config.rotationSpeed === 'number') {
			viewer.controls.autoRotateSpeed = config.rotationSpeed;
		}
	}

	const clips = await _waitForClips(viewer);
	if (state.destroyed) return _controller(state);
	if (!clips || clips.length === 0) {
		_renderEmpty(container);
		return _controller(state);
	}

	const cleanNames = clips.map((c) => _stripClipIndex(c.name));
	const initialIdx = _pickInitialIndex(cleanNames, config.defaultClip);

	_stopAllActions(viewer);

	if (config.showClipPicker !== false) {
		state.panel = _renderPicker(container, cleanNames, initialIdx, (idx) => {
			_playAt(viewer, clips, idx, config.loopAll, state);
			_highlight(state.panel, idx);
		});
	}

	_playAt(viewer, clips, initialIdx, config.loopAll, state);

	return _controller(state, () => {
		state.destroyed = true;
		_detachFinished(viewer, state);
		if (state.panel) state.panel.remove();
	});
}

// ─── helpers ──────────────────────────────────────────────────────────────

function _controller(state, destroyFn) {
	return {
		destroy:
			destroyFn ||
			(() => {
				state.destroyed = true;
			}),
	};
}

function _waitForClips(viewer) {
	return new Promise((resolve) => {
		const started = Date.now();
		const poll = () => {
			if (viewer?.clips?.length && viewer.mixer) {
				resolve(viewer.clips.slice());
				return;
			}
			if (Date.now() - started > POLL_MAX_MS) {
				resolve([]);
				return;
			}
			setTimeout(poll, POLL_INTERVAL_MS);
		};
		poll();
	});
}

function _stripClipIndex(name) {
	// viewer.js rewrites clip.name to "1. Original". Show the original.
	const m = /^\d+\.\s*(.*)$/.exec(name);
	return m ? m[1] : name;
}

function _pickInitialIndex(cleanNames, defaultClip) {
	if (!defaultClip) return 0;
	const i = cleanNames.findIndex((n) => n === defaultClip);
	return i >= 0 ? i : 0;
}

function _stopAllActions(viewer) {
	if (!viewer?.mixer) return;
	viewer.mixer.stopAllAction();
	const states = viewer.state?.actionStates;
	if (states) {
		for (const k of Object.keys(states)) states[k] = false;
	}
}

function _detachFinished(viewer, state) {
	if (state.finishedHandler && viewer?.mixer) {
		viewer.mixer.removeEventListener('finished', state.finishedHandler);
		state.finishedHandler = null;
	}
}

function _playAt(viewer, clips, idx, loopAll, state) {
	if (!viewer?.mixer || idx < 0 || idx >= clips.length) return;
	_detachFinished(viewer, state);
	_stopAllActions(viewer);

	const clip = clips[idx];
	const action = viewer.mixer.clipAction(clip);
	action.reset();
	action.enabled = true;
	action.setEffectiveTimeScale(1);
	action.setEffectiveWeight(1);
	action.setLoop(loopAll ? LoopOnce : LoopRepeat, loopAll ? 1 : Infinity);
	action.clampWhenFinished = false;
	action.play();

	if (viewer.state?.actionStates) {
		viewer.state.actionStates[clip.name] = true;
	}

	state.currentAction = action;
	state.currentClipName = clip.name;

	if (loopAll) {
		state.finishedHandler = () => {
			if (state.destroyed) return;
			const next = (idx + 1) % clips.length;
			_playAt(viewer, clips, next, loopAll, state);
			if (state.panel) _highlight(state.panel, next);
		};
		viewer.mixer.addEventListener('finished', state.finishedHandler);
	}

	if (viewer.invalidate) viewer.invalidate();
}

function _renderPicker(container, names, initialIdx, onSelect) {
	const panel = document.createElement('div');
	panel.className = 'anim-gallery-panel';
	panel.setAttribute('role', 'listbox');
	panel.setAttribute('aria-label', 'Animation clips');
	panel.setAttribute('aria-activedescendant', `anim-gallery-opt-${initialIdx}`);
	panel.tabIndex = 0;

	const header = document.createElement('div');
	header.className = 'anim-gallery-header';
	header.textContent = `Clips (${names.length})`;
	panel.appendChild(header);

	const list = document.createElement('ul');
	list.className = 'anim-gallery-list';

	names.forEach((name, i) => {
		const li = document.createElement('li');
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'anim-gallery-item';
		btn.id = `anim-gallery-opt-${i}`;
		btn.setAttribute('role', 'option');
		btn.dataset.idx = String(i);
		btn.textContent = name;
		if (i === initialIdx) {
			btn.classList.add('is-active');
			btn.setAttribute('aria-selected', 'true');
		}
		btn.addEventListener('click', () => onSelect(i));
		li.appendChild(btn);
		list.appendChild(li);
	});

	panel.appendChild(list);

	panel.addEventListener('keydown', (ev) => {
		const current = Number(panel.getAttribute('data-current') || initialIdx);
		let next = current;
		switch (ev.key) {
			case 'ArrowDown':
			case 'j':
				next = (current + 1) % names.length;
				break;
			case 'ArrowUp':
			case 'k':
				next = (current - 1 + names.length) % names.length;
				break;
			case 'Home':
				next = 0;
				break;
			case 'End':
				next = names.length - 1;
				break;
			case 'Enter':
			case ' ':
				onSelect(current);
				ev.preventDefault();
				return;
			default:
				return;
		}
		ev.preventDefault();
		onSelect(next);
	});

	container.appendChild(panel);
	_injectStyles();
	return panel;
}

function _highlight(panel, idx) {
	if (!panel) return;
	panel.setAttribute('data-current', String(idx));
	panel.setAttribute('aria-activedescendant', `anim-gallery-opt-${idx}`);
	panel.querySelectorAll('.anim-gallery-item').forEach((btn) => {
		const active = Number(btn.dataset.idx) === idx;
		btn.classList.toggle('is-active', active);
		btn.setAttribute('aria-selected', active ? 'true' : 'false');
		if (active) btn.scrollIntoView({ block: 'nearest' });
	});
}

function _renderEmpty(container) {
	const empty = document.createElement('div');
	empty.className = 'anim-gallery-empty';
	empty.textContent = 'No animation clips on this model.';
	container.appendChild(empty);
	_injectStyles();
}

let _stylesInjected = false;
function _injectStyles() {
	if (_stylesInjected) return;
	_stylesInjected = true;
	const style = document.createElement('style');
	style.textContent = `
		.anim-gallery-panel {
			position: fixed;
			right: 16px;
			top: 16px;
			max-height: calc(100vh - 32px);
			width: 220px;
			background: rgba(10, 10, 10, 0.82);
			backdrop-filter: blur(12px);
			color: #e0e0e0;
			font-family: Inter, system-ui, sans-serif;
			border-radius: 10px;
			box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
			z-index: 10;
			display: flex;
			flex-direction: column;
			overflow: hidden;
		}
		.anim-gallery-header {
			padding: 10px 14px;
			font-size: 13px;
			font-weight: 600;
			letter-spacing: 0.02em;
			text-transform: uppercase;
			opacity: 0.75;
			border-bottom: 1px solid rgba(255, 255, 255, 0.08);
		}
		.anim-gallery-list {
			list-style: none;
			margin: 0;
			padding: 6px 0;
			overflow-y: auto;
		}
		.anim-gallery-list li { margin: 0; padding: 0; }
		.anim-gallery-item {
			width: 100%;
			text-align: left;
			background: transparent;
			border: 0;
			color: inherit;
			padding: 8px 14px;
			cursor: pointer;
			font: inherit;
			font-size: 13px;
			line-height: 1.35;
			transition: background-color 120ms ease;
		}
		.anim-gallery-item:hover {
			background: rgba(255, 255, 255, 0.06);
		}
		.anim-gallery-item.is-active {
			background: rgba(255, 255, 255, 0.22);
			color: #fff;
			box-shadow: inset 3px 0 0 #ffffff;
		}
		.anim-gallery-item:focus-visible {
			outline: 2px solid #ffffff;
			outline-offset: -2px;
		}
		.anim-gallery-empty {
			position: fixed;
			right: 16px;
			top: 16px;
			padding: 10px 14px;
			background: rgba(10, 10, 10, 0.82);
			color: #aaa;
			font-family: Inter, system-ui, sans-serif;
			font-size: 13px;
			border-radius: 8px;
			z-index: 10;
		}
		@media (max-width: 520px) {
			.anim-gallery-panel {
				right: 8px;
				top: auto;
				bottom: 8px;
				width: calc(100% - 16px);
				max-height: 40vh;
			}
		}
	`;
	document.head.appendChild(style);
}
