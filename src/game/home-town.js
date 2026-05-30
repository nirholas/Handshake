// The flagship town — three.ws's own $THREE community.
//
// Every pump.fun coin gets a 3D world on demand, but the platform's home token
// deserves a permanent, curated home: a town that is always pinned to the top
// of the /play lobby (even when it isn't trending), badged as official, and
// dressed in a fixed signature biome instead of the seed-lottery one. This is
// the front door of the metaverse — the world a first-time visitor should land
// in. Keeping its identity in one module means the lobby card, the deep link,
// and the world dressing all agree on a single source of truth.
//
// `image` is a sensible static fallback (the token's IPFS art); the lobby
// refreshes name/symbol/art/market-cap live from /api/pump/coin so the pinned
// card is never stale. `biome` forces the world archetype — see world-env.js.

export const HOME_TOWN = {
	mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
	name: 'three.ws',
	symbol: 'three',
	image: 'https://ipfs.io/ipfs/bafybeihe22b5sxr3ihnxt7pregfieyteqvubqhik3j3y4bbx243xlqjw3q',
	// The signature look for the home town: the Neon Expanse, whose cyan/magenta
	// neon over deep indigo matches the platform's monochrome-with-accent brand.
	biome: 'alien',
	official: true,
};

/** True when a mint is the flagship $THREE town. */
export const isHomeTown = (mint) => !!mint && mint === HOME_TOWN.mint;
