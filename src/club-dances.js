// The dance styles the /club stage offers, in menu order.
//
// The paid endpoint (api/x402/dance-tip.js STYLES) owns what each style *is*:
// which clip or clip sequence plays, for how long, and over which audio loop.
// This module owns only what the picker shows, so the browser bundle does not
// have to import a server handler. tests/club-dances.test.js asserts the two
// lists never drift: same keys, same labels, in the same order.
//
// Adding a style: add it to STYLES in api/x402/dance-tip.js (with a `track`
// present in public/club/audio/), map its audio in src/club-audio.js
// TRACK_BY_DANCE, then add the row here.

export const DANCES = [
	{ key: 'twerk', label: 'Pole Twerk' },
	{ key: 'rumba', label: 'Rumba' },
	{ key: 'silly', label: 'Silly' },
	{ key: 'thriller', label: 'Thriller' },
	{ key: 'capoeira', label: 'Capoeira' },
	{ key: 'hiphop', label: 'Hip Hop' },
	{ key: 'offabean', label: 'Offabean' },
	{ key: 'spin', label: 'Spin' },
	{ key: 'climb', label: 'Slow Burn' },
	{ key: 'combo', label: 'Full Combo' },
];

export const DANCE_KEYS = DANCES.map((d) => d.key);

/** Menu label for a style key, or the key itself when it is not offered. */
export function danceLabel(key) {
	return DANCES.find((d) => d.key === key)?.label ?? String(key ?? '');
}
