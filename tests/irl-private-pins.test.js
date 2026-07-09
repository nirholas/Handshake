// IRL private pins (owner-only visibility) — regression fence.
//
// `published = false` means PRIVATE: the pin renders for its OWNER but is withheld
// from every other reader. This is the only control on /irl that holds against a
// patient attacker — proof-of-presence (IRL_FIX_SECRET) merely raises the cost of a
// geographic sweep, because the fix-token mint trusts caller-supplied coordinates.
// A private pin is not a cost, it is an absence: no sweep, at any budget, returns a
// coordinate the query never selects.
//
// Two guarantees are locked here:
//   1. readVisibility() resolves a placement's visibility, defaulting to PRIVATE
//      whenever IRL_DEFAULT_PRIVATE is set (the pre-launch posture).
//   2. Every query that can return another user's coordinates carries the
//      visibility predicate. A future edit that drops one turns the build RED.

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { readVisibility } from '../api/irl/pins.js';

const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const ORIGINAL = process.env.IRL_DEFAULT_PRIVATE;
afterEach(() => {
	if (ORIGINAL === undefined) delete process.env.IRL_DEFAULT_PRIVATE;
	else process.env.IRL_DEFAULT_PRIVATE = ORIGINAL;
});

describe('readVisibility — the safe default is the one that cannot leak by omission', () => {
	it('defaults to public when IRL_DEFAULT_PRIVATE is unset', () => {
		delete process.env.IRL_DEFAULT_PRIVATE;
		expect(readVisibility({})).toBe('public');
		expect(readVisibility(undefined)).toBe('public');
	});

	it('defaults to private when IRL_DEFAULT_PRIVATE is set', () => {
		for (const on of ['1', 'true', 'TRUE', 'yes', ' Yes ']) {
			process.env.IRL_DEFAULT_PRIVATE = on;
			expect(readVisibility({})).toBe('private');
		}
	});

	it('treats a falsy-looking value as NOT private (no accidental opt-in)', () => {
		for (const off of ['0', 'false', 'no', '']) {
			process.env.IRL_DEFAULT_PRIVATE = off;
			expect(readVisibility({})).toBe('public');
		}
	});

	it('an explicit visibility always wins over the deployment default', () => {
		process.env.IRL_DEFAULT_PRIVATE = '1';
		expect(readVisibility({ visibility: 'public' })).toBe('public');
		delete process.env.IRL_DEFAULT_PRIVATE;
		expect(readVisibility({ visibility: 'private' })).toBe('private');
	});

	it('an unrecognised visibility falls back to the default, never silently public', () => {
		process.env.IRL_DEFAULT_PRIVATE = '1';
		for (const junk of ['unlisted', 'null', '{}', 'true', 'pub']) {
			expect(readVisibility({ visibility: junk })).toBe('private');
		}
	});

	it('normalises case and surrounding whitespace on an explicit value', () => {
		delete process.env.IRL_DEFAULT_PRIVATE;
		expect(readVisibility({ visibility: '  PRIVATE ' })).toBe('private');
		expect(readVisibility({ visibility: 'Public' })).toBe('public');
	});
});

describe('every coordinate-returning read honours pin visibility', () => {
	const pins = src('../api/irl/pins.js');
	const worldLines = src('../api/irl/world-lines.js');

	// The two pins reads that return OTHER users' coordinates must admit a
	// non-public pin only when the caller owns it (by session uuid or device token).
	it('pins.js nearby + room reads gate on published OR owner', () => {
		const ownerAware = pins.match(
			/AND \(published IS NOT FALSE\s*\n\s*OR \(\$\{myId\}::uuid IS NOT NULL AND user_id = \$\{myId\}::uuid\)\s*\n\s*OR \(\$\{myTok\}::text IS NOT NULL AND device_token = \$\{myTok\}::text\)\)/g,
		);
		expect(ownerAware, 'nearby + room reads must both carry the owner-aware predicate').toHaveLength(2);
	});

	// Both public projections must SELECT `published` so the owner's UI can badge a
	// private pin. (The third `WHERE room_id =` read is the room-calibrate path: it
	// returns relative offsets, not a public projection, and refuses unless EVERY pin
	// in the room belongs to the caller — so it is owner-gated and exempt.)
	it('both public pin projections select published', () => {
		const selects = pins.match(/placement_kind, fuzz_radius_m, published/g) ?? [];
		expect(selects).toHaveLength(2);
		expect(pins).toMatch(/visibility:\s+r\.published === false \? 'private' : 'public'/);
	});

	// World Lines is the widest coordinate radius we ship (600 m vs 60 m for pins),
	// so its discovery join is the cheapest private-pin bypass if left unfiltered.
	it('world-lines discovery filters out quests anchored to a private pin', () => {
		expect(worldLines).toMatch(/JOIN irl_pins p ON p\.id = w\.pin_id/);
		expect(worldLines).toContain('AND p.published IS NOT FALSE');
	});

	// Anchoring a quest to a private pin would publish the coordinate the owner
	// marked private. Refuse at creation, not merely at read time.
	it('world-lines refuses to anchor a quest to a private pin', () => {
		expect(worldLines).toContain("SELECT id, user_id, agent_id, lat, lng, published FROM irl_pins");
		expect(worldLines).toMatch(/if \(pin\.published === false\)/);
	});
});

describe('unpublish is private-to-owner, not moderation', () => {
	const privacy = src('../api/irl/privacy.js');

	// The prior implementation set hidden_at, which blanks the pin for the OWNER
	// too — unusable for anyone testing a placement they took out of public view.
	it('PATCH writes published, never hidden_at', () => {
		expect(privacy).toContain('SET published = FALSE');
		expect(privacy).toContain('SET published = TRUE');
		expect(privacy).not.toMatch(/SET hidden_at = NOW\(\)/);
	});

	// Null-guard the SUPPLIED token, not the column: a caller with no device token
	// must match nothing, rather than matching rows whose device_token is empty.
	it('the owner clause null-guards the supplied device token', () => {
		expect(privacy).not.toContain("device_token = ${deviceToken ?? ''}");
		const guarded = privacy.match(/\$\{deviceToken\}::text IS NOT NULL AND device_token = \$\{deviceToken\}::text/g);
		expect(guarded?.length ?? 0).toBeGreaterThanOrEqual(2);
	});

	it('the data summary counts private pins via published, not hidden_at', () => {
		expect(privacy).toContain('COUNT(*) FILTER (WHERE published IS FALSE)::int            AS unpublished');
	});
});
