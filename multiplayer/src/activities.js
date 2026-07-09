// Gather & craft activities for the /play coin worlds (W06) — woodcutting, mining
// and cooking, the chop/mine/cook counterpart to WalkRoom's fishing.
//
// The logic lives HERE, not inline in WalkRoom, for two reasons: it keeps the room a
// thin validator-and-replicator (the same split combat.js/vehicles.js use), and it
// is independently unit-testable. Each handler takes the live `room` so it can reach
// the room's authoritative helpers (`_actionOk`, `_grantXp`, `_sendInv`,
// `_questEvent`, `_persistEcon`) and off-schema economy (`econ`) without duplicating
// them — the WalkRoom only has to register the three message handlers.
//
// Authority model is byte-identical to _handleFish: client sends an intent → we
// validate tool + range + cooldown + pack space → roll the yield against the skill
// and the node's difficulty → grant item + XP → reply with `inv`/`notice`. The
// client is pure UI; nothing here trusts a client-sent position or reward.

import { addItem, hasRoomFor, countItem, removeItem } from './economy.js';
import {
	itemLabel, gatherChance, gatherDoubleChance, coalBonusChance, cookBurnChance,
} from './items.js';
import { treeInRange, rockInRange, firepitInRange, rodPickupInRange } from './world-features.js';

// Per-swing cadence on the real clock (ms). The handlers tolerate a profile whose
// `cd` map predates these keys — `now < undefined` is false, so a missing key just
// means "ready now", and the first action arms it.
export const ACTIVITY_COOLDOWN_MS = { chop: 1300, mine: 1500, cook: 900, pickupRod: 8000 };

// The two gather activities differ only in tool, node, resource and the mining-only
// coal bonus — so one config table drives both through the shared core below.
const GATHER = {
	chop: {
		tool: 'axe', skill: 'woodcutting', item: 'wood', inRange: treeInRange,
		toolHint: 'Equip an axe to chop.', rangeHint: 'Move up to a tree to chop.',
		holdText: 'The trunk holds firm.',
	},
	mine: {
		tool: 'pickaxe', skill: 'mining', item: 'stone', inRange: rockInRange, coal: true,
		toolHint: 'Equip a pickaxe to mine.', rangeHint: 'Move up to a rock to mine.',
		holdText: 'The rock holds firm.',
	},
};

// Chop a tree / mine a rock. `type` is 'chop' or 'mine'. Mirrors _handleFish.
export function handleGather(room, client, type) {
	const cfg = GATHER[type];
	if (!cfg) return;
	const player = room.state.players.get(client.sessionId);
	const profile = room.econ.get(client.sessionId);
	if (!player || !profile) return;
	if (!room._actionOk(client.sessionId, type)) return;

	const now = Date.now();
	if (profile.cd && now < profile.cd[type]) return; // mid-swing

	const active = profile.hotbar[profile.activeSlot];
	if (!active || active.item !== cfg.tool) {
		client.send('notice', { kind: 'tool', text: cfg.toolHint });
		return;
	}
	const node = cfg.inRange(player.x, player.z);
	if (!node) {
		client.send('notice', { kind: type, text: cfg.rangeHint });
		return;
	}
	if (!hasRoomFor(profile, cfg.item)) {
		client.send('notice', { kind: 'full', text: 'Your inventory is full.' });
		return;
	}

	if (profile.cd) profile.cd[type] = now + ACTIVITY_COOLDOWN_MS[type];
	const lvl = profile.levels[cfg.skill] || 1;
	const difficulty = node.difficulty || 1;

	if (Math.random() >= gatherChance(lvl, difficulty)) {
		// A swing that bites but yields nothing — a little XP keeps the grind honest.
		room._grantXp(client, profile, cfg.skill, 2);
		client.send('notice', { kind: type, got: 0, node: node.id, text: cfg.holdText });
		return;
	}

	const want = 1 + (Math.random() < gatherDoubleChance(lvl, difficulty) ? 1 : 0);
	const leftover = addItem(profile, cfg.item, want);
	const got = want - leftover;
	if (got <= 0) {
		client.send('notice', { kind: 'full', text: 'Your inventory is full.' });
		return;
	}
	const parts = [`${got > 1 ? got + ' ' : ''}${itemLabel(cfg.item).toLowerCase()}`];
	let xp = Math.round((9 + Math.floor(Math.random() * 5) + lvl * 0.3) * difficulty) * got;
	room._questEvent?.(client, profile, { type: 'collect', item: cfg.item, qty: got });

	// Mining bonus: a chance to also surface coal (subject to pack space).
	if (cfg.coal && hasRoomFor(profile, 'coal') && Math.random() < coalBonusChance(lvl, node.coal || 1)) {
		if (addItem(profile, 'coal', 1) === 0) {
			parts.push(itemLabel('coal').toLowerCase());
			xp += 6;
			room._questEvent?.(client, profile, { type: 'collect', item: 'coal', qty: 1 });
		}
	}

	room._grantXp(client, profile, cfg.skill, xp);
	room._sendInv(client, profile);
	client.send('notice', { kind: type, got, node: node.id, text: `Got ${parts.join(' + ')}.` });
	room._persistEcon(client.sessionId);
}

// Cook a raw fish at a roast pit: consume one raw fish, roll the burn chance against
// cooking skill, and on success add an edible cooked fish (with XP). A burn loses the
// fish — a low-level cook's tax that fades with training. No tool needed; the fire is
// the station.
export function handleCook(room, client) {
	const player = room.state.players.get(client.sessionId);
	const profile = room.econ.get(client.sessionId);
	if (!player || !profile) return;
	if (!room._actionOk(client.sessionId, 'cook')) return;

	const now = Date.now();
	if (profile.cd && now < profile.cd.cook) return;

	if (!firepitInRange(player.x, player.z)) {
		client.send('notice', { kind: 'cook', text: 'Stand by a roast pit to cook.' });
		return;
	}
	if (countItem(profile, 'fish') <= 0) {
		client.send('notice', { kind: 'cook', text: 'You have no raw fish to cook.' });
		return;
	}

	if (profile.cd) profile.cd.cook = now + ACTIVITY_COOLDOWN_MS.cook;
	const lvl = profile.levels.cooking || 1;
	removeItem(profile, 'fish', 1);

	if (Math.random() < cookBurnChance(lvl)) {
		room._grantXp(client, profile, 'cooking', 3); // you learn from a burn, a little
		room._sendInv(client, profile);
		client.send('notice', { kind: 'cook', cooked: 0, text: 'You burned the fish.' });
		room._persistEcon(client.sessionId);
		return;
	}
	if (!hasRoomFor(profile, 'cookedFish')) {
		// The raw fish is already gone; refund it so a full pack can't eat the catch.
		addItem(profile, 'fish', 1);
		if (profile.cd) profile.cd.cook = now; // didn't actually cook — don't burn the cadence
		room._sendInv(client, profile);
		client.send('notice', { kind: 'full', text: 'Your inventory is full.' });
		return;
	}
	addItem(profile, 'cookedFish', 1);
	const xp = 14 + Math.floor(Math.random() * 5) + Math.floor(lvl * 0.3);
	room._grantXp(client, profile, 'cooking', xp);
	room._questEvent?.(client, profile, { type: 'collect', item: 'cookedFish', qty: 1 });
	room._sendInv(client, profile);
	client.send('notice', { kind: 'cook', cooked: 1, text: `Cooked a ${itemLabel('cookedFish').toLowerCase()}.` });
	room._persistEcon(client.sessionId);
}

// Grab a spare rod from a world pickup. No tool or skill gates this (it's a free
// prop, not a resource node) — just proximity, cooldown and pack space. Mirrors
// _handleFish's shape for a non-stackable tool instead of a resource stack.
export function handlePickupRod(room, client) {
	const player = room.state.players.get(client.sessionId);
	const profile = room.econ.get(client.sessionId);
	if (!player || !profile) return;
	if (!room._actionOk(client.sessionId, 'pickupRod')) return;

	const now = Date.now();
	if (profile.cd && now < profile.cd.pickupRod) return;

	const node = rodPickupInRange(player.x, player.z);
	if (!node) {
		client.send('notice', { kind: 'pickupRod', text: 'Move up to a rod stand to pick it up.' });
		return;
	}
	if (!hasRoomFor(profile, 'rod')) {
		client.send('notice', { kind: 'full', text: 'Your inventory is full.' });
		return;
	}

	if (profile.cd) profile.cd.pickupRod = now + ACTIVITY_COOLDOWN_MS.pickupRod;
	addItem(profile, 'rod', 1);
	room._questEvent?.(client, profile, { type: 'collect', item: 'rod', qty: 1 });
	room._sendInv(client, profile);
	client.send('notice', { kind: 'pickupRod', got: 1, node: node.id, text: `Picked up a ${itemLabel('rod').toLowerCase()}.` });
	room._persistEcon(client.sessionId);
}

// Wire the four intents onto a room. Called once from WalkRoom.onCreate — the room's
// only obligation, keeping the gather/craft logic out of the room file entirely.
export function registerActivityHandlers(room) {
	room.onMessage('chop', (client) => handleGather(room, client, 'chop'));
	room.onMessage('mine', (client) => handleGather(room, client, 'mine'));
	room.onMessage('cook', (client) => handleCook(room, client));
	room.onMessage('pickupRod', (client) => handlePickupRod(room, client));
}
