// @vitest-environment jsdom
//
// Orbit hold in public/model-viewer-meshopt.js: once the user drags (or
// arrow-keys) a camera-controls <model-viewer> to an angle, auto-rotate is
// removed for good so the turntable never spins the model back off the angle
// they chose. Before this, every viewer resumed spinning after
// auto-rotate-delay (0 ms on several surfaces), which read as "the viewer
// won't let me look at the back of the model".
//
// The shim is a classic script with document-delegated listeners, so these
// tests import it once and drive it with synthetic events. jsdom has no
// PointerEvent; MouseEvent carries clientX/clientY and both sides of the
// pointerId comparison come out undefined, which matches.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

function makeViewer(attrs) {
	const mv = document.createElement('model-viewer');
	for (const [k, v] of Object.entries(attrs)) mv.setAttribute(k, v);
	document.body.appendChild(mv);
	return mv;
}

function pointer(type, target, x, y) {
	const e = new MouseEvent(type, { bubbles: true, composed: true, clientX: x, clientY: y });
	target.dispatchEvent(e);
}

function drag(mv, fromX, fromY, toX, toY) {
	pointer('pointerdown', mv, fromX, fromY);
	pointer('pointermove', mv, toX, toY);
	pointer('pointerup', mv, toX, toY);
}

beforeAll(async () => {
	await import('../public/model-viewer-meshopt.js');
});

beforeEach(() => {
	document.body.innerHTML = '';
});

describe('model-viewer orbit hold', () => {
	it('removes auto-rotate after a real drag on a camera-controls viewer', () => {
		const mv = makeViewer({ 'camera-controls': '', 'auto-rotate': '', 'auto-rotate-delay': '0' });
		drag(mv, 10, 10, 60, 10);
		expect(mv.hasAttribute('auto-rotate')).toBe(false);
	});

	it('keeps auto-rotate on a tap without movement', () => {
		const mv = makeViewer({ 'camera-controls': '', 'auto-rotate': '' });
		pointer('pointerdown', mv, 10, 10);
		pointer('pointerup', mv, 10, 10);
		expect(mv.hasAttribute('auto-rotate')).toBe(true);
	});

	it('keeps auto-rotate below the drag threshold', () => {
		const mv = makeViewer({ 'camera-controls': '', 'auto-rotate': '' });
		drag(mv, 10, 10, 12, 12);
		expect(mv.hasAttribute('auto-rotate')).toBe(true);
	});

	it('leaves display-only turntables (no camera-controls) spinning', () => {
		const mv = makeViewer({ 'auto-rotate': '', 'disable-zoom': '', 'disable-pan': '' });
		drag(mv, 10, 10, 80, 10);
		expect(mv.hasAttribute('auto-rotate')).toBe(true);
	});

	it('covers viewers injected after the shim loaded (delegation)', () => {
		const late = makeViewer({ 'camera-controls': '', 'auto-rotate': '' });
		drag(late, 0, 0, 50, 50);
		expect(late.hasAttribute('auto-rotate')).toBe(false);
	});

	it('holds when the drag starts on a child inside the viewer', () => {
		const mv = makeViewer({ 'camera-controls': '', 'auto-rotate': '' });
		const child = document.createElement('div');
		mv.appendChild(child);
		pointer('pointerdown', child, 10, 10);
		pointer('pointermove', mv, 40, 10);
		expect(mv.hasAttribute('auto-rotate')).toBe(false);
	});

	it('stops the turntable on arrow-key orbit of a focused viewer', () => {
		const mv = makeViewer({ 'camera-controls': '', 'auto-rotate': '', tabindex: '0' });
		mv.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, composed: true }));
		expect(mv.hasAttribute('auto-rotate')).toBe(false);
	});

	it('ignores non-arrow keys', () => {
		const mv = makeViewer({ 'camera-controls': '', 'auto-rotate': '' });
		mv.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, composed: true }));
		expect(mv.hasAttribute('auto-rotate')).toBe(true);
	});

	it('strips auto-rotate again if a surface re-adds it after the user took the camera', async () => {
		const mv = makeViewer({ 'camera-controls': '', 'auto-rotate': '' });
		drag(mv, 10, 10, 90, 10);
		expect(mv.hasAttribute('auto-rotate')).toBe(false);
		// marketplace-detail re-adds auto-rotate on viewport re-entry; the user's
		// chosen angle must win.
		mv.setAttribute('auto-rotate', '');
		await new Promise((r) => setTimeout(r, 0));
		expect(mv.hasAttribute('auto-rotate')).toBe(false);
	});

	it('only affects the dragged viewer, not siblings', () => {
		const a = makeViewer({ 'camera-controls': '', 'auto-rotate': '' });
		const b = makeViewer({ 'camera-controls': '', 'auto-rotate': '' });
		drag(a, 10, 10, 70, 10);
		expect(a.hasAttribute('auto-rotate')).toBe(false);
		expect(b.hasAttribute('auto-rotate')).toBe(true);
	});
});
