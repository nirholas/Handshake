/**
 * WalkNet's event emitter must never throw out of a colyseus callback.
 *
 * The shared WalkRoom broadcasts ~20 message types; walk-net registers a
 * wildcard relay that re-emits everything it doesn't handle explicitly as a
 * 'message' event. `_emit` runs INSIDE colyseus's message dispatch, so an
 * event with no registered bucket must degrade to a no-op: a throw there
 * escapes into the socket's dispatch loop and breaks message handling for the
 * whole room (an uncaught "this._handlers[t] is not iterable" on every frame).
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('colyseus.js', () => ({ Client: class {}, getStateCallbacks: () => () => ({}) }));

const { WalkNet } = await import('../src/walk-net.js');

// The constructor resolves a server URL from meta/env; a bare instance is all
// these tests need (no connect() is called).
function net() {
	return new WalkNet({ url: 'wss://example.invalid' });
}

describe('WalkNet event buckets', () => {
	it('exposes a "message" bucket for the wildcard relay', () => {
		const n = net();
		const seen = [];
		const off = n.on('message', (type, payload) => seen.push([type, payload]));
		n._emit('message', 'game:king', { king: 'abc' });
		expect(seen).toEqual([['game:king', { king: 'abc' }]]);
		off();
		n._emit('message', 'quests', {});
		expect(seen).toHaveLength(1);
	});

	it('emitting an event with no subscribers does not throw', () => {
		const n = net();
		expect(() => n._emit('message', 'floor:beat', { clip: 'x' })).not.toThrow();
		expect(() => n._emit('chat', { text: 'hi' })).not.toThrow();
	});

	it('emitting an unknown event is a no-op, never a throw', () => {
		const n = net();
		expect(() => n._emit('totally-unknown-event', 1, 2)).not.toThrow();
	});

	it('a throwing subscriber cannot break delivery to the others', () => {
		const n = net();
		const got = [];
		n.on('message', () => { throw new Error('boom'); });
		n.on('message', (type) => got.push(type));
		expect(() => n._emit('message', 'inv', {})).not.toThrow();
		expect(got).toEqual(['inv']);
	});

	it('on() still rejects an unknown event name', () => {
		const n = net();
		expect(() => n.on('nope', () => {})).toThrow(/unknown event/);
	});
});
