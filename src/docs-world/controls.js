// Docs World input: one module that turns keyboard, mouse, and touch into
// { move, look, run, interact } for the frame loop.
//
// Desktop: WASD / arrows to walk, Shift to run, drag to orbit, wheel to zoom,
// E / Enter to open the nearest pavilion, C to cycle the camera, Esc handled
// by the overlays themselves.
// Touch: a virtual joystick owns the lower-left corner; dragging anywhere
// else orbits the camera; a short tap raycasts (handled by main.js via the
// onTap callback so taps and orbit drags never fight).

const TAP_MAX_MS = 350;
const TAP_MAX_PX = 12;
const LOOK_SPEED = 0.0052;
const PITCH_MIN = 0.08;
const PITCH_MAX = 1.25;
const DIST_MIN = 4;
const DIST_MAX = 16;

export function createControls(canvas, { onTap, onInteract, onCycleCamera } = {}) {
	const keys = new Set();
	const move = { x: 0, z: 0 };
	// yaw starts at PI so the spawn view looks across the plaza toward the ring:
	// the player spawns at +z with the camera outside them, beacon behind.
	const orbit = { yaw: Math.PI, pitch: 0.42, dist: 8.5 };
	const joystick = { active: false, id: null, baseX: 0, baseY: 0, x: 0, y: 0 };

	// ── Keyboard ───────────────────────────────────────────────────────────────
	function isTypingTarget(e) {
		const t = e.target;
		return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
	}
	addEventListener('keydown', (e) => {
		if (isTypingTarget(e)) return;
		const k = e.key.toLowerCase();
		keys.add(k);
		if (k === 'e' || k === 'enter') onInteract?.();
		if (k === 'c') onCycleCamera?.();
		if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
	});
	addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
	addEventListener('blur', () => keys.clear());

	// ── Pointer orbit + tap ────────────────────────────────────────────────────
	let dragging = false;
	let dragMoved = 0;
	let downAt = 0;
	let lastX = 0;
	let lastY = 0;
	let orbitPointer = null;

	canvas.addEventListener('pointerdown', (e) => {
		// Touch in the joystick zone belongs to the joystick.
		if (e.pointerType === 'touch' && inJoystickZone(e)) {
			joystick.active = true;
			joystick.id = e.pointerId;
			joystick.baseX = e.clientX;
			joystick.baseY = e.clientY;
			joystick.x = 0;
			joystick.y = 0;
			canvas.setPointerCapture(e.pointerId);
			return;
		}
		dragging = true;
		orbitPointer = e.pointerId;
		dragMoved = 0;
		downAt = performance.now();
		lastX = e.clientX;
		lastY = e.clientY;
		canvas.setPointerCapture(e.pointerId);
	});

	canvas.addEventListener('pointermove', (e) => {
		if (joystick.active && e.pointerId === joystick.id) {
			const R = 52;
			const dx = e.clientX - joystick.baseX;
			const dy = e.clientY - joystick.baseY;
			const d = Math.hypot(dx, dy) || 1;
			const clamped = Math.min(d, R);
			joystick.x = (dx / d) * (clamped / R);
			joystick.y = (dy / d) * (clamped / R);
			return;
		}
		if (!dragging || e.pointerId !== orbitPointer) return;
		const dx = e.clientX - lastX;
		const dy = e.clientY - lastY;
		dragMoved += Math.abs(dx) + Math.abs(dy);
		lastX = e.clientX;
		lastY = e.clientY;
		orbit.yaw -= dx * LOOK_SPEED;
		orbit.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, orbit.pitch + dy * LOOK_SPEED));
	});

	function endPointer(e) {
		if (joystick.active && e.pointerId === joystick.id) {
			joystick.active = false;
			joystick.id = null;
			joystick.x = 0;
			joystick.y = 0;
			return;
		}
		if (e.pointerId !== orbitPointer) return;
		const wasTap = dragMoved < TAP_MAX_PX && performance.now() - downAt < TAP_MAX_MS;
		dragging = false;
		orbitPointer = null;
		if (wasTap) onTap?.(e);
	}
	canvas.addEventListener('pointerup', endPointer);
	canvas.addEventListener('pointercancel', endPointer);

	canvas.addEventListener(
		'wheel',
		(e) => {
			e.preventDefault();
			orbit.dist = Math.max(DIST_MIN, Math.min(DIST_MAX, orbit.dist + e.deltaY * 0.01));
		},
		{ passive: false },
	);

	function inJoystickZone(e) {
		const r = canvas.getBoundingClientRect();
		return e.clientX - r.left < r.width * 0.42 && e.clientY - r.top > r.height * 0.5;
	}

	return {
		orbit,
		joystick,
		/** Screen-space movement vector, |v| <= 1. x: right, z: forward. */
		readMove() {
			let x = 0;
			let z = 0;
			if (keys.has('w') || keys.has('arrowup')) z += 1;
			if (keys.has('s') || keys.has('arrowdown')) z -= 1;
			if (keys.has('a') || keys.has('arrowleft')) x -= 1;
			if (keys.has('d') || keys.has('arrowright')) x += 1;
			if (x || z) {
				const n = Math.hypot(x, z);
				move.x = x / n;
				move.z = z / n;
			} else if (joystick.active) {
				move.x = joystick.x;
				move.z = -joystick.y;
			} else {
				move.x = 0;
				move.z = 0;
			}
			return move;
		},
		get run() {
			return keys.has('shift') || (joystick.active && Math.hypot(joystick.x, joystick.y) > 0.92);
		},
	};
}
