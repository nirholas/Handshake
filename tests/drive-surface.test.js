// three.ws Drive: the pure logic behind the car surface.
//
// These three modules decide what the driver can reach and when, so they are
// the parts worth pinning: a regression here is a keyboard that opens at speed
// or a command that silently eats a real question.

import { describe, it, expect, vi } from 'vitest';
import { detectSurface, scaleFor, surfaceProfile, approvalDisposition } from '../src/drive/surface.js';
import { matchDriveCommand, normalize, createDriveInterceptor, commandVocabulary } from '../src/drive/commands.js';
import { watchMotion } from '../src/drive/motion.js';

describe('drive surface detection', () => {
	it('honours an explicit ?surface=', () => {
		expect(detectSurface('?surface=headunit')).toBe('headunit');
		expect(detectSurface('?surface=carplay')).toBe('carplay');
	});

	it('ignores a surface name it does not know', () => {
		expect(detectSurface('?surface=spaceship')).toBe('browser');
	});

	it('scales up for a head unit and down for a short dash', () => {
		expect(scaleFor('headunit', 1920, 1080)).toBeGreaterThan(scaleFor('browser', 1920, 1080));
		expect(scaleFor('browser', 800, 400)).toBeLessThan(1);
		expect(scaleFor('browser', 1280, 720)).toBe(1);
	});

	it('hides the keyboard on the panels where it cannot be reached', () => {
		expect(surfaceProfile('carplay').keyboard).toBe(false);
		expect(surfaceProfile('androidauto').keyboard).toBe(false);
		expect(surfaceProfile('headunit').keyboard).toBe(true);
		expect(surfaceProfile('cradle').keyboard).toBe(true);
	});

	it('knows which panels have a native shell listening', () => {
		expect(surfaceProfile('carplay').native).toBe(true);
		expect(surfaceProfile('browser').native).toBe(false);
	});

	// Android Auto runs the page in a service-hosted web view with no window, so
	// there are no animation frames and nothing to look at. Both flags follow
	// from that one fact, and both change behaviour, so both are pinned.
	it('turns the 3D stage off only where there is no window to draw in', () => {
		expect(surfaceProfile('androidauto').renders3d).toBe(false);
		for (const name of ['carplay', 'headunit', 'cradle', 'browser']) {
			expect(surfaceProfile(name).renders3d).toBe(true);
		}
	});

	it('refuses tap-to-approve where the person cannot see what they are approving', () => {
		expect(surfaceProfile('androidauto').canConfirm).toBe(false);
		for (const name of ['carplay', 'headunit', 'cradle', 'browser']) {
			expect(surfaceProfile(name).canConfirm).toBe(true);
		}
	});
});

// Approving a lock is the one thing in the car that must never quietly happen.
// Both refusals are load-bearing, so both are pinned here rather than left to a
// reading of the UI code.
describe('approving a physical home action', () => {
	it('allows a tap only on a parked car with a screen', () => {
		expect(approvalDisposition(surfaceProfile('headunit'), false)).toBe('approve');
		expect(approvalDisposition(surfaceProfile('cradle'), false)).toBe('approve');
		expect(approvalDisposition(surfaceProfile('carplay'), false)).toBe('approve');
	});

	it('refuses while the car is moving, on every surface', () => {
		for (const name of ['carplay', 'headunit', 'cradle', 'browser']) {
			expect(approvalDisposition(surfaceProfile(name), true)).toBe('moving');
		}
	});

	it('refuses on a surface with nothing to look at, parked or not', () => {
		expect(approvalDisposition(surfaceProfile('androidauto'), false)).toBe('no-screen');
		expect(approvalDisposition(surfaceProfile('androidauto'), true)).toBe('no-screen');
	});

	it('refuses when handed no profile at all rather than defaulting open', () => {
		expect(approvalDisposition(null, false)).toBe('no-screen');
		expect(approvalDisposition(undefined, false)).toBe('no-screen');
	});
});

describe('drive commands', () => {
	it('normalizes filler away', () => {
		expect(normalize('Hey, repeat that, please!')).toBe('repeat that');
		expect(normalize('  OK  Stop.  ')).toBe('stop');
	});

	it('matches the control vocabulary', () => {
		expect(matchDriveCommand('repeat that')).toBe('repeat');
		expect(matchDriveCommand('stop talking')).toBe('hush');
		expect(matchDriveCommand('turn it up')).toBe('louder');
		expect(matchDriveCommand('night mode')).toBe('night');
		expect(matchDriveCommand("i'm parked")).toBe('parked');
	});

	// The whole point of whole-utterance matching: a command word inside a real
	// request must reach the agent, not the local handler.
	it('never swallows a real question that merely contains a command word', () => {
		expect(matchDriveCommand('stop at the next charger')).toBe(null);
		expect(matchDriveCommand('is the traffic quieter on the parkway')).toBe(null);
		expect(matchDriveCommand('repeat the address for the restaurant we passed')).toBe(null);
		expect(matchDriveCommand('what time do we get there')).toBe(null);
	});

	it('interceptor runs the handler and reports the turn as handled', async () => {
		const hush = vi.fn();
		const intercept = createDriveInterceptor({ hush });
		expect(await intercept('stop')).toBe(true);
		expect(hush).toHaveBeenCalledOnce();
	});

	it('interceptor passes an unmatched utterance through to the agent', async () => {
		const hush = vi.fn();
		const intercept = createDriveInterceptor({ hush });
		expect(await intercept('how far to the next charger')).toBe(false);
		expect(hush).not.toHaveBeenCalled();
	});

	it('a matched command with no handler still falls through rather than vanishing', async () => {
		const intercept = createDriveInterceptor({});
		expect(await intercept('repeat that')).toBe(false);
	});

	it('every vocabulary phrase resolves to its own id', () => {
		for (const { id, phrases } of commandVocabulary()) {
			for (const phrase of phrases) expect(matchDriveCommand(phrase)).toBe(id);
		}
	});
});

describe('drive motion', () => {
	const fakeGeo = () => {
		let cb = null;
		return {
			watchPosition(success) {
				cb = success;
				return 7;
			},
			clearWatch: vi.fn(),
			emit(speed) {
				cb({ coords: { speed } });
			},
		};
	};

	it('reports no signal when geolocation is unavailable', () => {
		const seen = [];
		const w = watchMotion((s) => seen.push(s), null);
		expect(w.available).toBe(false);
		expect(seen).toEqual([{ moving: false, speedMps: null, source: 'none' }]);
	});

	it('flips to moving above walking pace', () => {
		const geo = fakeGeo();
		const seen = [];
		watchMotion((s) => seen.push(s), geo);
		geo.emit(12);
		expect(seen.at(-1)).toMatchObject({ moving: true, source: 'gps' });
	});

	it('ignores a fix that carries no speed at all', () => {
		const geo = fakeGeo();
		const seen = [];
		watchMotion((s) => seen.push(s), geo);
		geo.emit(null);
		expect(seen).toHaveLength(0);
	});

	// Stopping at a light must not unlock the keyboard: only a sustained stop does.
	it('needs a sustained stop before it calls the car parked', () => {
		vi.useFakeTimers();
		try {
			const geo = fakeGeo();
			const seen = [];
			watchMotion((s) => seen.push(s), geo);
			geo.emit(15);
			expect(seen.at(-1).moving).toBe(true);
			geo.emit(0);
			expect(seen.at(-1).moving).toBe(true);
			vi.advanceTimersByTime(7000);
			geo.emit(0);
			expect(seen.at(-1).moving).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it('stops the watch it opened', () => {
		const geo = fakeGeo();
		const w = watchMotion(() => {}, geo);
		w.stop();
		expect(geo.clearWatch).toHaveBeenCalledWith(7);
	});
});
