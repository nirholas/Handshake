// The one username claim used by every seeder that creates a synthetic account.
//
// Three seeders (api/cron/avaturn-seed-cron.js, api/cron/forge-seed-cron.js,
// api/_lib/circulation.js) each carried a private copy of this helper, and all
// three copies shared the same defect: the "which variants already exist" query
// ended in `limit 100`, so as soon as a base word had 100 or more variants in
// the users table the taken-set came back truncated and the helper handed out a
// name that was already taken. The caller's `on conflict do nothing` insert then
// returned no row and the tick skipped with "user insert conflict". In
// production every sampled OG word was past that ceiling (wolf 101, raven 117,
// fog 336), so the avaturn seeder had stopped producing avatars entirely while
// still reporting ok:true every minute.
//
// Two things make this version correct:
//   1. It asks for exactly the candidate space it iterates (the bare word plus
//      its numbered slots) and asks for all of it, so the taken-set can never be
//      a partial view of the names about to be handed out.
//   2. It compares case-insensitively, matching the actual uniqueness rule in
//      Postgres (`users_username_unique` is a unique index on lower(username)),
//      so an existing "Wolf5" now blocks "wolf5" instead of sailing past the
//      check and failing at insert time.
//
// A claim is a read, not a reservation: two ticks racing on the same second can
// still land on the same name. That is what the caller's unique-index conflict
// handling is for, and it is now the only way a conflict can happen.

import { randomUUID } from 'node:crypto';
import { sql } from './db.js';

// Numbered slots tried before falling back to a random hex suffix. The old
// helpers stopped at 99, which is also where the truncated query stopped being
// able to see the truth; 999 keeps popular words usable for far longer.
const MAX_NUMBERED_SLOT = 999;

// Escape the Postgres regex metacharacters a slugified base word can contain
// (circulation feeds slugs, which carry hyphens).
function escapeRegex(word) {
	return word.replace(/[.*+?^${}()|[\]\\\-]/g, '\\$&');
}

// Claim `word` as a username, skipping to the next free numbered slot.
// Returns the claimed username, or null when `word` is empty.
export async function claimSeedUsername(word) {
	const base = String(word || '').trim().toLowerCase();
	if (!base) return null;

	// Only the bare word and word + up to three digits: a bare prefix match would
	// drag in unrelated longer usernames and inflate the result set without
	// telling us anything about the slots we actually iterate.
	const pattern = `^${escapeRegex(base)}[0-9]{0,3}$`;
	const existing = await sql`
		select lower(username) as username from users where lower(username) ~ ${pattern}
	`;
	const taken = new Set(existing.map((r) => r.username));

	if (!taken.has(base)) return base;
	for (let n = 2; n <= MAX_NUMBERED_SLOT; n++) {
		const candidate = `${base}${n}`;
		if (!taken.has(candidate)) return candidate;
	}
	// Every numbered slot is taken. A random hex suffix keeps the seeder running
	// instead of stalling on an exhausted word.
	return `${base}_${randomUUID().slice(0, 4)}`;
}

// Turn a claimed username back into a display name that reads like a real
// account. Both collision suffixes have to come off before titling: stripping
// digits alone turned "fog_1a2b" into the literal display name "Fog_".
export function seedDisplayName(username) {
	return String(username)
		.replace(/_[0-9a-f]{4}$/, '')
		.replace(/\d+$/, '')
		.replace(/\b\w/g, (c) => c.toUpperCase());
}
