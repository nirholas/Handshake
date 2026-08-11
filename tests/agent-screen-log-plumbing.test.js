/**
 * Activity-log plumbing between /api/agent-screen-push and
 * /api/agent-screen-stream.
 *
 * Both halves shipped a bug that made a live caster's narration invisible while
 * every component reported success, found by running
 * services/agent-screen-caster against production on 2026-08-11:
 *
 *   1. Write side: the push endpoint logged EVERY frame, including the
 *      pixels-only screenshots a caster emits every FRAME_INTERVAL_MS. Those
 *      blank entries evicted the agent's real narration from the 50-entry log
 *      within seconds.
 *   2. Read side: the Upstash REST client deserializes JSON responses, so a log
 *      entry read back with lrange arrives as an object. Running JSON.parse over
 *      it threw, every entry was dropped, and the stream sent `entries: []` while
 *      also suppressing the database backfill that would have filled the panel.
 *      Viewer reactions were read the same way and never fanned out.
 */

import { describe, it, expect } from 'vitest';
import { shouldLogEntry } from '../api/agent-screen-push.js';
import { parseRedisRecord } from '../api/agent-screen-stream.js';

describe('shouldLogEntry', () => {
	it('logs an entry that carries readable narration', () => {
		expect(shouldLogEntry({ activity: 'Navigating to pump.fun' })).toBe(true);
	});

	it('drops a pixels-only screenshot push', () => {
		expect(shouldLogEntry({ activity: '' })).toBe(false);
		expect(shouldLogEntry({})).toBe(false);
	});

	it('keeps a structured ride-along even with no activity text', () => {
		expect(shouldLogEntry({ activity: '', pnl: { phase: 'exit', pct: 12 } })).toBe(true);
		expect(shouldLogEntry({ activity: '', meta: { glbUrl: 'https://three.ws/a.glb' } })).toBe(true);
		expect(shouldLogEntry({ activity: '', mm: { type: 'mm_defend', floorSol: 1 } })).toBe(true);
	});
});

describe('parseRedisRecord', () => {
	it('accepts the already-deserialized object the Upstash client returns', () => {
		const entry = { ts: 1, activity: 'Reading the board', type: 'analysis' };
		expect(parseRedisRecord(entry)).toEqual(entry);
	});

	it('accepts a raw JSON string from a client without auto-deserialization', () => {
		expect(parseRedisRecord('{"ts":2,"activity":"Buying","type":"trade"}')).toEqual({
			ts: 2, activity: 'Buying', type: 'trade',
		});
	});

	it('returns null for values no viewer could render', () => {
		expect(parseRedisRecord('not json')).toBeNull();
		expect(parseRedisRecord(null)).toBeNull();
		expect(parseRedisRecord(undefined)).toBeNull();
		expect(parseRedisRecord(42)).toBeNull();
	});

	it('survives a mixed list without losing the decodable entries', () => {
		const raw = [{ ts: 3, activity: 'a' }, 'not json', '{"ts":4,"activity":"b"}', null];
		const entries = raw.map(parseRedisRecord).filter(Boolean);
		expect(entries.map((e) => e.activity)).toEqual(['a', 'b']);
	});
});
