// @vitest-environment jsdom
/**
 * The overlay chrome (apps-sdk/embodiment/overlay.js). Every state the stage can
 * reach has a designed surface, and the chain-state badge cluster renders straight
 * from a real mapChainStateToVisuals() result. Pure DOM, so this runs the shipped
 * module unmodified rather than a stand-in.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mountOverlay } from '../apps-sdk/embodiment/overlay.js';
import { mapChainStateToVisuals } from '../apps-sdk/embodiment/chain-visuals.js';

let container;

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
});

afterEach(() => {
	container.remove();
	vi.useRealTimers();
});

const q = (sel) => container.querySelector(sel);

describe('embodiment overlay: mount + controller', () => {
	it('mounts the documented controller surface', () => {
		const overlay = mountOverlay(container);
		for (const fn of ['setName', 'setState', 'setIdentity', 'destroy']) {
			expect(typeof overlay[fn], `controller.${fn}`).toBe('function');
		}
		expect(overlay.el).toBeInstanceOf(HTMLElement);
		expect(container.contains(overlay.el)).toBe(true);
	});

	it('makes a statically positioned host relative so the chrome can anchor to it', () => {
		container.style.position = 'static';
		mountOverlay(container);
		expect(container.style.position).toBe('relative');
	});

	it('leaves a host that already establishes a containing block alone', () => {
		container.style.position = 'absolute';
		mountOverlay(container);
		expect(container.style.position).toBe('absolute');
	});

	it('opens on the loading skeleton, not a bare canvas', () => {
		mountOverlay(container);
		expect(q('[data-skel]').hidden).toBe(false);
		expect(q('[data-plate]').hidden).toBe(true);
		expect(q('[data-error]').hidden).toBe(true);
	});

	it('injects its stylesheet once into the host document', () => {
		mountOverlay(container);
		const before = document.querySelectorAll('style').length;
		mountOverlay(container);
		expect(document.querySelectorAll('style').length).toBe(before);
	});
});

describe('embodiment overlay: state surfaces', () => {
	it('swaps the skeleton for the name plate once the body is live', () => {
		const overlay = mountOverlay(container);
		overlay.setState('idle', { name: 'Scout' });
		expect(q('[data-skel]').hidden).toBe(true);
		expect(q('[data-plate]').hidden).toBe(false);
		expect(q('[data-name]').textContent).toBe('Scout');
		expect(q('[data-state]').textContent).toBe('Listening');
	});

	it('labels and colors every state the stage machine can emit', () => {
		const overlay = mountOverlay(container);
		const expected = {
			loading: 'Waking up', idle: 'Listening', listening: 'Listening',
			thinking: 'Thinking', speaking: 'Speaking',
		};
		for (const [state, label] of Object.entries(expected)) {
			overlay.setState(state);
			expect(q('[data-state]').textContent, state).toBe(label);
			expect(overlay.el.style.getPropertyValue('--emb-dot'), state).not.toBe('');
		}
	});

	it('pulses the dot only while the body is busy', () => {
		const overlay = mountOverlay(container);
		overlay.setState('speaking');
		expect(overlay.el.classList.contains('emb__pulse')).toBe(true);
		overlay.setState('thinking');
		expect(overlay.el.classList.contains('emb__pulse')).toBe(true);
		overlay.setState('idle');
		expect(overlay.el.classList.contains('emb__pulse')).toBe(false);
	});

	it('shows the emotion glyph while speaking and hides it on a neutral line', () => {
		const overlay = mountOverlay(container);
		overlay.setState('speaking', { emotion: 'joy' });
		expect(q('[data-emotion]').hidden).toBe(false);
		expect(q('[data-emotion]').textContent).toContain('joy');
		overlay.setState('speaking', { emotion: 'neutral' });
		expect(q('[data-emotion]').hidden).toBe(true);
		overlay.setState('idle', { emotion: 'joy' });
		expect(q('[data-emotion]').hidden).toBe(true);
	});

	it('falls back to the raw state name for a state it has no label for', () => {
		const overlay = mountOverlay(container);
		overlay.setState('reconnecting');
		expect(q('[data-state]').textContent).toBe('reconnecting');
	});

	it('keeps the last known name when a transition carries none', () => {
		const overlay = mountOverlay(container);
		overlay.setName('Scout');
		overlay.setState('thinking');
		expect(q('[data-name]').textContent).toBe('Scout');
	});

	it('paints an actionable error card with a working retry', () => {
		const onRetry = vi.fn();
		const overlay = mountOverlay(container, { onRetry });
		overlay.setState('error', { message: 'Could not load this avatar.' });
		expect(q('[data-error]').hidden).toBe(false);
		expect(q('[data-skel]').hidden).toBe(true);
		expect(q('[data-plate]').hidden).toBe(true);
		expect(q('[data-error-msg]').textContent).toBe('Could not load this avatar.');
		q('[data-retry]').click();
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it('does not throw when the error card is retried with no handler wired', () => {
		const overlay = mountOverlay(container);
		overlay.setState('error', { message: 'boom' });
		expect(() => q('[data-retry]').click()).not.toThrow();
	});

	it('clears the error card when a later state recovers', () => {
		const overlay = mountOverlay(container);
		overlay.setState('error', { message: 'boom' });
		overlay.setState('idle', { name: 'Scout' });
		expect(q('[data-error]').hidden).toBe(true);
		expect(q('[data-plate]').hidden).toBe(false);
	});

	it('explains a static rig exactly once, then retires the note', () => {
		vi.useFakeTimers();
		const overlay = mountOverlay(container);
		overlay.setState('idle', { rig: 'fallback' });
		expect(q('[data-note]').hidden).toBe(false);
		expect(q('[data-note]').textContent).toContain('Static rig');

		vi.advanceTimersByTime(6000);
		expect(q('[data-note]').hidden).toBe(true);

		overlay.setState('idle', { rig: 'fallback' });
		expect(q('[data-note]').hidden).toBe(true);
	});

	it('never shows the rig note for a rig that plays the canonical clips', () => {
		const overlay = mountOverlay(container);
		overlay.setState('idle', { rig: 'canonical' });
		expect(q('[data-note]').hidden).toBe(true);
	});
});

describe('embodiment overlay: chain-state badges', () => {
	const visualsFor = (visual) => mapChainStateToVisuals({ visual });

	it('renders the reputation aura, holdings badge and verified nameplate', () => {
		const overlay = mountOverlay(container);
		overlay.setIdentity(visualsFor({
			reputation_tier: 'eminent', holdings_tier: 'gold', muted: false, verified_name: 'scout.sol',
		}));
		expect(q('[data-identity]').hidden).toBe(false);
		expect(q('[data-id-aura]').title).toBe('Reputation: Eminent');
		expect(q('[data-id-badge]').textContent).toContain('Gold holdings');
		expect(q('[data-id-name]').hidden).toBe(false);
		expect(q('[data-id-name]').textContent).toBe('scout.sol');
		expect(overlay.el.style.getPropertyValue('--emb-aura')).toBe('#a78bfa');
		expect(overlay.el.style.getPropertyValue('--emb-cosmetic')).toBe('#f4c542');
	});

	it('hides the nameplate when no verified name resolved', () => {
		const overlay = mountOverlay(container);
		overlay.setIdentity(visualsFor({ reputation_tier: 'trusted', holdings_tier: 'bronze' }));
		expect(q('[data-id-name]').hidden).toBe(true);
		expect(q('[data-identity]').hidden).toBe(false);
	});

	it('marks a muted (unfunded) wallet without hiding the body', () => {
		const overlay = mountOverlay(container);
		overlay.setIdentity(visualsFor({ reputation_tier: 'eminent', holdings_tier: 'none', muted: true }));
		expect(q('[data-id-muted]').hidden).toBe(false);
		expect(q('[data-identity]').classList.contains('emb__identity--muted')).toBe(true);
	});

	it('hides the cluster entirely for a persona with no wallet binding', () => {
		const overlay = mountOverlay(container);
		overlay.setIdentity(visualsFor({ reputation_tier: 'trusted', holdings_tier: 'gold' }));
		overlay.setIdentity(null);
		expect(q('[data-identity]').hidden).toBe(true);
	});

	it('renders a designed cluster even for an identity read that came back empty', () => {
		const overlay = mountOverlay(container);
		overlay.setIdentity(mapChainStateToVisuals({}));
		expect(q('[data-identity]').hidden).toBe(false);
		expect(q('[data-id-badge]').textContent).toContain('No holdings');
		expect(q('[data-id-aura]').title).toBe('Reputation: Unranked');
	});
});

describe('embodiment overlay: teardown', () => {
	it('removes its own DOM and leaves the host container clean', () => {
		const overlay = mountOverlay(container);
		overlay.destroy();
		expect(container.querySelector('.emb')).toBeNull();
	});
});
