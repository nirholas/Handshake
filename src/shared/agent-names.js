// Random agent names — the client-side twin of the wordlist namer in
// api/_lib/launcher-sources.js (randomCoin). That module is server-only (it
// sits next to fetch-based launch sources), so the wordlists are mirrored here
// rather than imported; keep the two lists in sync when editing either.
// Dependency-free on purpose: the guest-agent draft mints a name before any
// API or heavy bundle has loaded.

export const ADJECTIVES = [
	'Turbo', 'Cosmic', 'Feral', 'Velvet', 'Quantum', 'Rogue', 'Lucid', 'Hyper',
	'Molten', 'Neon', 'Phantom', 'Atomic', 'Wild', 'Solar', 'Frostbit', 'Electric',
	'Savage', 'Mythic', 'Stellar', 'Chrome', 'Gilded', 'Vapor', 'Radiant', 'Drift',
];

export const NOUNS = [
	'Otter', 'Comet', 'Goblin', 'Yeti', 'Falcon', 'Mantis', 'Kraken', 'Pixel',
	'Nomad', 'Bishop', 'Tiger', 'Sprout', 'Anvil', 'Specter', 'Lotus', 'Bandit',
	'Phoenix', 'Walrus', 'Cobra', 'Maple', 'Raven', 'Bison', 'Koi', 'Hawk',
];

/**
 * A friendly two-word agent name, e.g. "Turbo Otter".
 * @param {() => number} [rand] - injectable RNG for deterministic tests
 * @returns {string}
 */
export function randomAgentName(rand = Math.random) {
	const pick = (arr) => arr[Math.min(arr.length - 1, Math.floor(rand() * arr.length))];
	return `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
}
