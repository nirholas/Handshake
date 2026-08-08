// Coverage for the event souvenir drop — the free commemorative wearable every
// attendee of a live /play event keeps forever.
//
// The whole feature rests on two properties that are easy to state and easy to
// break silently, so they are pinned here:
//
//   1. WINDOW + WORLD GATING (multiplayer/src/event-drop.js). The souvenir is
//      claimable only inside [startsAt, endsAt) and only in the world the event
//      config's `link` points at. A drop that leaks outside its window destroys
//      the one thing a souvenir is: proof you were there.
//   2. GRANT IDEMPOTENCY (multiplayer/src/economy.js). A player reconnects,
//      hops rooms, or refreshes ten times during the event and ends up with
//      exactly one copy — and, just as importantly, the souvenir SURVIVES a
//      persistence round-trip, because after the window closes there is no path
//      that could ever re-grant it.
//
// Plus the guards that keep the two economies from bleeding into each other: an
// event item must never appear in the $THREE boutique, and the x402 purchase
// ledger must never be able to mint one.

import { describe, it, expect, beforeEach } from 'vitest';
import {
	parseEventDrop, dropClaimable, eventCoinFromLink,
} from '../multiplayer/src/event-drop.js';
import {
	getCosmetic, canWear, isEventCosmetic, sanitizeLoadout,
} from '../multiplayer/src/cosmetics-catalog.js';
import {
	newProfile, grantCosmetic, equipCosmetic, ownedCosmeticSet,
	mergeOwnedFromLedger, serializeProfile, restoreProfile,
} from '../multiplayer/src/economy.js';
import { boutiqueListings, boutiquePrice } from '../multiplayer/src/shop.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOUVENIR_ID = 'laurel-meetup';
const EVENT_COIN = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const START = Date.parse('2026-08-09T17:00:00Z');
const END = Date.parse('2026-08-09T19:30:00Z');

// A config in the exact shape public/event.json ships.
function eventDoc(over = {}) {
	return {
		id: 'three-first-meetup',
		name: '$THREE First Holders Meetup',
		startsAt: new Date(START).toISOString(),
		endsAt: new Date(END).toISOString(),
		link: `/play?coin=${EVENT_COIN}&name=three.ws&symbol=three`,
		souvenir: { cosmeticId: SOUVENIR_ID },
		...over,
	};
}

describe('event drop config', () => {
	it('reduces a real event config to the drop the server enforces', () => {
		const drop = parseEventDrop(eventDoc());
		expect(drop).toMatchObject({
			eventId: 'three-first-meetup',
			startsAt: START,
			endsAt: END,
			coin: EVENT_COIN,
			cosmeticId: SOUVENIR_ID,
			slot: 'headwear',
		});
	});

	it('reads the target world from the config link, so the drop cannot target another world', () => {
		expect(eventCoinFromLink(`/play?coin=${EVENT_COIN}&name=x`)).toBe(EVENT_COIN);
		expect(eventCoinFromLink('/play?name=x')).toBe('');
		expect(eventCoinFromLink('/play')).toBe('');
		expect(eventCoinFromLink(null)).toBe('');
	});

	it('refuses to drop anything that is not an event-tier cosmetic', () => {
		// A premium boutique item named by a typo must yield NO drop rather than a
		// free Stetson for every attendee.
		expect(parseEventDrop(eventDoc({ souvenir: { cosmeticId: 'hat-cowboy' } }))).toBeNull();
		expect(parseEventDrop(eventDoc({ souvenir: { cosmeticId: 'hat-beanie' } }))).toBeNull();
		expect(parseEventDrop(eventDoc({ souvenir: { cosmeticId: 'nope' } }))).toBeNull();
		expect(parseEventDrop(eventDoc({ souvenir: {} }))).toBeNull();
	});

	it('treats a malformed or souvenir-less config as no drop, never as an error', () => {
		expect(parseEventDrop(null)).toBeNull();
		expect(parseEventDrop({})).toBeNull();
		expect(parseEventDrop(eventDoc({ souvenir: undefined }))).toBeNull();
		expect(parseEventDrop(eventDoc({ startsAt: 'not a date' }))).toBeNull();
		// An end at or before the start is not a window.
		expect(parseEventDrop(eventDoc({ endsAt: new Date(START).toISOString() }))).toBeNull();
		// No link means no world to scope the drop to.
		expect(parseEventDrop(eventDoc({ link: '/play' }))).toBeNull();
	});
});

describe('claim window', () => {
	const drop = parseEventDrop(eventDoc());

	it('opens at startsAt and closes at endsAt', () => {
		expect(dropClaimable(drop, EVENT_COIN, START - 1)).toBe(false);
		expect(dropClaimable(drop, EVENT_COIN, START)).toBe(true);
		expect(dropClaimable(drop, EVENT_COIN, START + 60_000)).toBe(true);
		expect(dropClaimable(drop, EVENT_COIN, END - 1)).toBe(true);
		// Half-open: the instant the event ends, the souvenir is gone for good.
		expect(dropClaimable(drop, EVENT_COIN, END)).toBe(false);
		expect(dropClaimable(drop, EVENT_COIN, END + 1)).toBe(false);
	});

	it('only grants in the event world, even while the event is live', () => {
		expect(dropClaimable(drop, 'SomeOtherMint1111111111111111111111111111', START + 1)).toBe(false);
		expect(dropClaimable(drop, '', START + 1)).toBe(false);
		expect(dropClaimable(drop, undefined, START + 1)).toBe(false);
	});

	it('grants nothing when there is no drop or no usable clock', () => {
		expect(dropClaimable(null, EVENT_COIN, START + 1)).toBe(false);
		expect(dropClaimable(drop, EVENT_COIN, Number.NaN)).toBe(false);
		expect(dropClaimable(drop, EVENT_COIN, undefined)).toBe(false);
	});
});

describe('granting the souvenir', () => {
	let profile;
	beforeEach(() => { profile = newProfile('wallet-under-test'); });

	it('is idempotent: rejoining during the event never duplicates it', () => {
		expect(grantCosmetic(profile, SOUVENIR_ID)).toBe(true);
		// Every subsequent join reports "nothing new", which is what suppresses the
		// second toast and the redundant persist.
		for (let rejoin = 0; rejoin < 10; rejoin++) {
			expect(grantCosmetic(profile, SOUVENIR_ID)).toBe(false);
		}
		expect(profile.cosmetics.owned.filter((id) => id === SOUVENIR_ID)).toHaveLength(1);
	});

	it('cannot be worn before it is granted, and can be right after', () => {
		expect(canWear(SOUVENIR_ID, ownedCosmeticSet(profile))).toBe(false);
		expect(equipCosmetic(profile, SOUVENIR_ID)).toBeNull();

		grantCosmetic(profile, SOUVENIR_ID);
		expect(canWear(SOUVENIR_ID, ownedCosmeticSet(profile))).toBe(true);
		expect(equipCosmetic(profile, SOUVENIR_ID).headwear).toBe(SOUVENIR_ID);
	});

	it('survives a persistence round-trip, equipped and owned', () => {
		grantCosmetic(profile, SOUVENIR_ID);
		equipCosmetic(profile, SOUVENIR_ID);

		// Exactly what the player store writes and reads back on the next join.
		const restored = restoreProfile(JSON.parse(JSON.stringify(serializeProfile(profile))), 'wallet-under-test');
		expect(restored.cosmetics.owned).toContain(SOUVENIR_ID);
		expect(restored.cosmetics.equipped.headwear).toBe(SOUVENIR_ID);
		// And still wearable after the window has long closed — the item is owned,
		// and ownership is not time-scoped.
		expect(canWear(SOUVENIR_ID, ownedCosmeticSet(restored))).toBe(true);
	});

	it('never lets an ungranted player wear it by asserting a loadout', () => {
		// The join-option path: a client claiming to be wearing the souvenir.
		const forged = sanitizeLoadout({ headwear: SOUVENIR_ID }, ownedCosmeticSet(profile));
		expect(forged.headwear).toBe('head-none');

		grantCosmetic(profile, SOUVENIR_ID);
		const honest = sanitizeLoadout({ headwear: SOUVENIR_ID }, ownedCosmeticSet(profile));
		expect(honest.headwear).toBe(SOUVENIR_ID);
	});
});

describe('the souvenir stays out of the shop economy', () => {
	it('is an event-tier item with no price', () => {
		const item = getCosmetic(SOUVENIR_ID);
		expect(item.tier).toBe('event');
		expect(item.price).toBe(0);
		expect(isEventCosmetic(SOUVENIR_ID)).toBe(true);
		expect(isEventCosmetic('hat-cowboy')).toBe(false);
	});

	it('is not listed or priced in the $THREE boutique', () => {
		expect(boutiqueListings().map((l) => l.id)).not.toContain(SOUVENIR_ID);
		// A zero price is what the boutique quote handler rejects on, so a crafted
		// "buy the souvenir" message can never build a purchase transaction.
		expect(boutiquePrice(SOUVENIR_ID)).toBe(0);
	});

	it('cannot be minted through the x402 purchase ledger', () => {
		const profile = newProfile('wallet-under-test');
		// Even if the ledger somehow held the id, the purchase bridge is
		// premium-only, so it grants nothing.
		expect(mergeOwnedFromLedger(profile, [SOUVENIR_ID])).toBe(0);
		expect(ownedCosmeticSet(profile).has(SOUVENIR_ID)).toBe(false);
		// A real purchased premium id still comes through the same call.
		expect(mergeOwnedFromLedger(profile, ['hat-cowboy'])).toBe(1);
	});
});

describe('the shipped event config', () => {
	// The server reads this exact file over HTTP at runtime. A typo in it is a
	// silent no-drop on the night of the event, which is the worst possible time
	// to find out.
	const doc = JSON.parse(
		readFileSync(fileURLToPath(new URL('../public/event.json', import.meta.url)), 'utf8'),
	);

	it('declares a souvenir the server will actually grant', () => {
		const drop = parseEventDrop(doc);
		expect(drop).not.toBeNull();
		expect(isEventCosmetic(drop.cosmeticId)).toBe(true);
		expect(drop.coin).toBeTruthy();
	});

	it('points at a cosmetic whose asset paths are declared', () => {
		const item = getCosmetic(parseEventDrop(doc).cosmeticId);
		expect(item.visual?.prop).toMatch(/^\/accessories\/.+\.glb$/);
		expect(item.thumb).toMatch(/^\/accessories\/thumbs\/.+\.png$/);
	});
});
