// Is the car moving?
//
// Typing at speed is the one thing every in-car interface guideline agrees on:
// it does not happen. /drive therefore starts in Driving and keeps the keyboard
// away. The honest question is when to let it back.
//
// When the browser can give us a real ground speed we use it: above walking
// pace the surface locks itself back to Driving and closes anything open.
// Below it, the driver may switch to Parked themselves. When there is no speed
// signal at all (permission denied, no GPS, a desktop preview) the toggle is
// simply manual, and it still defaults to Driving.

/** Metres per second. ~10 mph: unambiguously moving, not a slow walk with the phone. */
const MOVING_MPS = 4.5;
/** Below this for STILL_MS and the vehicle is treated as stopped. */
const STILL_MPS = 0.9;
const STILL_MS = 6000;

/**
 * @param {(status: { moving: boolean, speedMps: number|null, source: 'gps'|'none' }) => void} onChange
 * @returns {{ stop: () => void, available: boolean }}
 */
export function watchMotion(onChange, geo = typeof navigator !== 'undefined' ? navigator.geolocation : null) {
	if (!geo?.watchPosition) {
		onChange({ moving: false, speedMps: null, source: 'none' });
		return { stop: () => {}, available: false };
	}

	let stillSince = 0;
	let last = null;
	let watchId = null;

	const emit = (moving, speedMps) => {
		if (last === moving) return;
		last = moving;
		onChange({ moving, speedMps, source: 'gps' });
	};

	watchId = geo.watchPosition(
		(pos) => {
			const speed = typeof pos?.coords?.speed === 'number' && pos.coords.speed >= 0 ? pos.coords.speed : null;
			// A fix with no speed field tells us nothing about motion; leave the
			// current verdict alone rather than guessing from position deltas,
			// which are noisy enough at a standstill to flip the keyboard open.
			if (speed === null) return;
			if (speed >= MOVING_MPS) {
				stillSince = 0;
				emit(true, speed);
				return;
			}
			if (speed <= STILL_MPS) {
				const now = Date.now();
				if (!stillSince) stillSince = now;
				if (now - stillSince >= STILL_MS) emit(false, speed);
			} else {
				stillSince = 0;
			}
		},
		() => {
			// Denied or unavailable: fall back to the manual toggle, which is
			// already the safe default.
			onChange({ moving: false, speedMps: null, source: 'none' });
		},
		{ enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
	);

	return {
		available: true,
		stop() {
			if (watchId !== null) geo.clearWatch(watchId);
			watchId = null;
		},
	};
}
