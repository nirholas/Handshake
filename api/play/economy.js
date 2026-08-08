// GET /api/play/economy
//
// The public, read-only reference for the /play in-game economy: what the general
// store pays and charges, what the $THREE boutique sells, what the wheel can award,
// and the progression constants the whole loop is tuned against.
//
// Every number here is imported from the SAME modules the authoritative multiplayer
// server prices its trades with (multiplayer/src/{shop,items,cosmetics-catalog,
// spin-wheel,economy}.js). Nothing is transcribed into this file, so a price shown
// on /play/economy is the price WalkRoom will actually charge: the reference cannot
// drift from the game because there is only one copy of the numbers.
//
// Static config only: no database, no wallet, no per-player state, no secrets. That
// is why it can be cached hard at the edge and served to anyone without a session.

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { SELL_PRICES, BUY_CATALOG, boutiqueListings } from '../../multiplayer/src/shop.js';
import { itemLabel } from '../../multiplayer/src/items.js';
import { SLOT_LABELS } from '../../multiplayer/src/cosmetics-catalog.js';
import {
	WHEEL_SEGMENTS,
	FREE_SPIN_COOLDOWN_MS,
	SPIN_COST_USD,
	MIN_AVG_LEVEL,
} from '../../multiplayer/src/spin-wheel.js';
import { SKILLS, LEVEL_CAP, INV_SIZE, HOTBAR_SIZE, MAX_STACK } from '../../multiplayer/src/economy.js';
import { COUNTER_REACH } from '../../multiplayer/src/world-features.js';
import { TOKEN_SYMBOL } from '../../multiplayer/src/game-token.js';

// The boutique and paid spins split their $THREE 50/50 between the holder-rewards
// sink and the treasury. Mirrors the `rewardsBps = 5000` default that
// splitTreasuryRewards() applies in game-token.js; surfaced here so the reference
// page can state the split without re-deriving it.
const REWARDS_BPS = 5000;

// Collapse the 20 equal-odds wedges into one row per distinct prize, so the page can
// show real cumulative odds ("4 wedges of 5% = 20%") instead of twenty near-identical
// lines. Odds are summed from each wedge's own oddsPct, never assumed to be uniform,
// so re-weighting the wheel upstream stays correct here automatically.
function summarizePaytable(segments) {
	const rows = new Map();
	for (const seg of segments) {
		const key = `${seg.kind}:${seg.item || ''}:${seg.qty || 0}:${seg.gold || 0}`;
		const row = rows.get(key);
		if (row) {
			row.wedges += 1;
			row.oddsPct += seg.oddsPct;
			continue;
		}
		rows.set(key, {
			kind: seg.kind,
			label: seg.label,
			item: seg.item || null,
			qty: seg.qty || 0,
			gold: seg.gold || 0,
			wedges: 1,
			oddsPct: seg.oddsPct,
		});
	}
	// Cash prizes read as the headline outcomes, so surface them first, richest first.
	// Item prizes then sort by quantity so the table climbs rather than jumping around.
	return [...rows.values()].sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === 'gold' ? -1 : 1;
		if (a.kind === 'gold') return b.gold - a.gold;
		if (a.item !== b.item) return a.item.localeCompare(b.item);
		return a.qty - b.qty;
	});
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const paytable = summarizePaytable(WHEEL_SEGMENTS);

	const body = {
		// Two currencies, kept deliberately separate. The wire format names them
		// explicitly so a client never has to infer which one a price is in.
		currencies: {
			cash: {
				id: 'cash',
				label: 'Cash',
				onchain: false,
				summary:
					'The carried purse. A pure game resource earned by gathering, fishing and combat, spent at the general store. Never on-chain, never a token.',
			},
			token: {
				id: 'token',
				label: TOKEN_SYMBOL,
				onchain: true,
				chain: 'solana',
				summary:
					'The platform coin, spent on-chain from the player’s connected wallet to unlock premium cosmetics and paid spins.',
			},
		},

		generalStore: {
			// Only gathered and looted goods are sellable: tools, weapons, mounts and the
			// starter kit are excluded upstream so no player can dump their kit or farm a
			// buy-then-sell arbitrage. That exclusion is the reason `sell` is short.
			sell: Object.entries(SELL_PRICES).map(([item, price]) => ({
				item,
				label: itemLabel(item),
				price,
			})),
			buy: BUY_CATALOG.map((e) => ({
				item: e.item,
				label: itemLabel(e.item),
				qty: e.qty,
				price: e.price,
				unitPrice: Math.round((e.price / e.qty) * 100) / 100,
			})),
			// Trading is a walk-up action: the server refuses a buy or a sell from
			// anywhere but a counter, same as every other station in the world.
			counterReachM: COUNTER_REACH,
			requiresStandingAtCounter: true,
		},

		bank: {
			summary:
				'Deposit cash with the teller to protect it. Dying drops the carried purse and carried items into a tombstone; banked cash survives, which is the whole risk-versus-reward point of walking to the bank.',
			protectsOnDeath: true,
			// The walk is the price of the protection, so the server enforces it on
			// every trade and transfer rather than trusting the client to only open
			// the panel at the counter. Published because it is a rule a player (and
			// anyone building against this) can otherwise only discover by refusal.
			counterReachM: COUNTER_REACH,
			requiresStandingAtCounter: true,
		},

		boutique: {
			currency: TOKEN_SYMBOL,
			settlement: 'solana',
			rewardsBps: REWARDS_BPS,
			treasuryBps: 10000 - REWARDS_BPS,
			listings: boutiqueListings().map((c) => ({
				...c,
				slotLabel: SLOT_LABELS[c.slot] || c.slot,
			})),
		},

		wheel: {
			freeSpinCooldownMs: FREE_SPIN_COOLDOWN_MS,
			freeSpinCooldownHours: Math.round(FREE_SPIN_COOLDOWN_MS / 3_600_000),
			paidSpinUsd: SPIN_COST_USD,
			minAvgLevel: MIN_AVG_LEVEL,
			wedges: WHEEL_SEGMENTS.length,
			// The roll is uniform across every item prize, so the pack has to have
			// room for all of them before a spin is offered or sold. Stated here
			// because it is the reason a spin can be refused with a full pack.
			requiresRoomForEveryItemPrize: true,
			rewardsBps: REWARDS_BPS,
			treasuryBps: 10000 - REWARDS_BPS,
			paytable,
		},

		progression: {
			skills: SKILLS,
			levelCap: LEVEL_CAP,
			inventorySlots: INV_SIZE,
			hotbarSlots: HOTBAR_SIZE,
			maxStack: MAX_STACK,
		},
	};

	// Pure config: no per-player state and no secrets, so it caches hard at the edge.
	// It only ever changes when the game's own tables change, which ships as a deploy.
	return json(res, 200, body, {
		'cache-control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
	});
});
