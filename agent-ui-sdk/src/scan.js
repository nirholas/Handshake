// Declarative scanner: reads `data-agent-*` attributes from a root element
// and wires the corresponding behaviors. Lets a static HTML page describe its
// avatar interactions without writing JS.
//
// Supported actions:
//   data-agent-action="stand-on"          — park the avatar here on ready
//   data-agent-action="track-typing"      — focus walks to + caret tracking
//   data-agent-action="privacy-mode"      — focus walks to + covereyes (once+hold)
//   data-agent-action="navigate-on-click" — runOff before following href
//   data-agent-action="react-on-click"    — play a clip on click
//
// Optional per-element attributes:
//   data-agent-direction="left|right"     — runOff direction (default right)
//   data-agent-clip="<clipName>"          — clip to play
//   data-agent-anchor="<anchorName>"      — anchor for walkTo target
//   data-agent-delay="<ms>"               — pre-navigation delay
//   data-agent-loop="true|false"          — loop flag for react-on-click clip
//   data-agent-hold="true|false"          — clampWhenFinished for react clip

import { startCaretTracking, caretScreenX } from './caret.js';

export function scan(root, agent) {
	const cleanups = [];
	let activeInput = null;
	let stopTracking = null;

	function clearTracking() {
		stopTracking?.();
		stopTracking = null;
		activeInput = null;
	}

	const els = root.querySelectorAll('[data-agent-action]');
	els.forEach((el) => {
		const action = el.dataset.agentAction;
		const dir    = el.dataset.agentDirection === 'left' ? 'left' : 'right';
		const clip   = el.dataset.agentClip;
		const anchor = el.dataset.agentAnchor;
		const delay  = el.dataset.agentDelay ? parseInt(el.dataset.agentDelay, 10) : undefined;
		const loop   = el.dataset.agentLoop === 'true';
		const hold   = el.dataset.agentHold === 'true';

		switch (action) {
			case 'stand-on': {
				agent.whenReady(() => agent.standOn(el, anchor ? { anchor } : undefined));
				break;
			}
			case 'track-typing': {
				const onFocus = async () => {
					clearTracking();
					await agent.walkTo(el, anchor ? { anchor } : undefined);
					agent.play('lookdown', { loop: true });
					activeInput = el;
					stopTracking = startCaretTracking(el, (cx) => agent.lookAt(cx), () => activeInput);
				};
				const onBlur = () => { clearTracking(); agent.faceFront(); };
				const reaim = () => { if (activeInput === el) agent.lookAt(caretScreenX(el)); };
				el.addEventListener('focus', onFocus);
				el.addEventListener('blur', onBlur);
				el.addEventListener('input', reaim);
				el.addEventListener('keyup', reaim);
				el.addEventListener('click', reaim);
				cleanups.push(() => {
					el.removeEventListener('focus', onFocus);
					el.removeEventListener('blur', onBlur);
					el.removeEventListener('input', reaim);
					el.removeEventListener('keyup', reaim);
					el.removeEventListener('click', reaim);
				});
				break;
			}
			case 'privacy-mode': {
				const onFocus = async () => {
					clearTracking();
					await agent.walkTo(el, anchor ? { anchor } : undefined);
					agent.play(clip || 'covereyes', { loop: false, hold: true });
					agent.faceFront();
				};
				const onBlur = () => agent.play('idle', { loop: true });
				el.addEventListener('focus', onFocus);
				el.addEventListener('blur', onBlur);
				cleanups.push(() => {
					el.removeEventListener('focus', onFocus);
					el.removeEventListener('blur', onBlur);
				});
				break;
			}
			case 'navigate-on-click': {
				cleanups.push(agent.interceptNavigation(el, { direction: dir, delay }));
				break;
			}
			case 'react-on-click': {
				const onClick = () => {
					if (!clip) return;
					agent.play(clip, { loop, hold });
				};
				el.addEventListener('click', onClick);
				cleanups.push(() => el.removeEventListener('click', onClick));
				break;
			}
		}
	});

	return () => { cleanups.forEach((fn) => fn()); clearTracking(); };
}
