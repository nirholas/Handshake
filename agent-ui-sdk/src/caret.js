// Caret-X tracker for <input> elements. Renders a hidden mirror <div> with
// matching typography, copies the prefix-up-to-caret, and measures the rendered
// text width. Works for both text inputs and password inputs (the latter by
// substituting bullet glyphs so width matches what the user sees).

let mirror = null;
function ensureMirror() {
	if (mirror) return mirror;
	mirror = document.createElement('div');
	mirror.setAttribute('aria-hidden', 'true');
	mirror.style.cssText =
		'position:absolute;visibility:hidden;white-space:pre;' +
		'padding:0;margin:0;border:0;pointer-events:none;top:-9999px;left:-9999px;';
	document.body.appendChild(mirror);
	return mirror;
}

export function caretScreenX(input) {
	const m = ensureMirror();
	const cs = getComputedStyle(input);
	m.style.font = cs.font;
	m.style.letterSpacing = cs.letterSpacing;
	m.style.textTransform = cs.textTransform;

	const rect = input.getBoundingClientRect();
	const padL = parseFloat(cs.paddingLeft) || 0;
	const padR = parseFloat(cs.paddingRight) || 0;
	const innerW = rect.width - padL - padR;

	const raw = input.value || '';
	const display = input.type === 'password' ? '•'.repeat(raw.length) : raw;
	const caretIdx = input.selectionStart ?? display.length;
	m.textContent = display.slice(0, caretIdx) || ' ';
	const textW = m.getBoundingClientRect().width;

	const offset = Math.min(textW, innerW);
	return rect.left + padL + offset;
}

/**
 * Track the caret X position on every animation frame while `input` is the
 * "active" target. The caller passes a `getActive()` thunk so the tracker
 * cleanly exits when focus moves to a different input.
 */
export function startCaretTracking(input, onChange, getActive) {
	let raf = 0;
	let lastX = -1;
	(function loop() {
		if (getActive() !== input) return;
		const cx = caretScreenX(input);
		if (cx !== lastX) {
			lastX = cx;
			onChange(cx);
		}
		raf = requestAnimationFrame(loop);
	})();
	return () => cancelAnimationFrame(raf);
}
