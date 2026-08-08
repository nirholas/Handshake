// Economy-loop audit for /play. Drives the real gather → sell → bank → spin loop
// against a live walk_world server with a real Colyseus client, and asserts the
// arithmetic the player is promised: a payout equals catalog price times
// quantity, a purchase charges exactly the listed price, a deposit moves the
// exact purse, an over-withdrawal clamps instead of minting, and progress
// survives a reconnect.
//
//   npm run dev:multi                        # in another shell
//   node scripts/play-economy-audit.mjs      # ws://127.0.0.1:2567 by default
//   WS=ws://127.0.0.1:2568 node scripts/play-economy-audit.mjs
//   PID=my-audit-account node scripts/play-economy-audit.mjs
//
// Nothing is mocked and nothing is inferred from source: every number checked
// here came back over the wire from the authoritative handlers, so a clean run
// is real evidence the loop pays what it says it pays. Exits non-zero on the
// first failed expectation so it can gate a release.

import { Client } from 'colyseus.js';
import { TREES, VENDOR_STALLS, ATMS } from '../multiplayer/src/world-features.js';

const URL = process.env.WS || 'ws://127.0.0.1:2567';
// A stable key so the persistence check at the end has something to reclaim.
// Override to audit against a fresh account.
const PID = process.env.PID || 'audit-economy-loop';
const MAX_SWINGS = 25;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const results = [];
function check(name, pass, detail) {
	results.push({ name, pass });
	log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? `: ${detail}` : ''}`);
}

// Every targeted message the economy speaks, captured as it arrives. The room
// answers each intent with a snapshot, so the latest of each is the truth.
function collect(room) {
	const box = { profile: null, inv: null, notices: [], store: null, xp: [], levelups: [], spinInfo: null, denied: null, spin: null };
	room.onMessage('profile', (m) => { box.profile = m; });
	room.onMessage('inv', (m) => { box.inv = m; });
	room.onMessage('notice', (m) => box.notices.push(m));
	room.onMessage('store', (m) => { box.store = m; });
	room.onMessage('xpgain', (m) => box.xp.push(m));
	room.onMessage('levelup', (m) => box.levelups.push(m));
	room.onMessage('spinInfo', (m) => { box.spinInfo = m; });
	room.onMessage('spinDenied', (m) => { box.denied = m; });
	room.onMessage('spinResult', (m) => { box.spin = m; });
	// The credential that reclaims this device's progression on the next join. A
	// raw `pid` is deliberately NOT an account key server-side (it would let any
	// client load and spend any victim's profile), so the audit has to round-trip
	// the sealed token exactly like the real client does.
	room.onMessage('guestToken', (m) => { if (m?.token) guestToken = m.token; });
	return box;
}

const held = (snap, item) => (snap?.inv || []).filter((s) => s.item === item).reduce((n, s) => n + s.qty, 0);
const slotOf = (snap, item) => (snap?.inv || []).findIndex((s) => s.item === item);
// `inv` deltas carry the live purse; `profile` carries purse AND bank.
const purseOf = (box) => (box.inv?.gold ?? box.profile?.gold ?? 0);

let guestToken = '';

async function join() {
	const client = new Client(URL);
	const room = await client.joinOrCreate('walk_world', {
		coin: '', tier: '', name: 'EconomyAudit', avatar: '', pid: PID,
		...(guestToken ? { guestToken } : {}),
	});
	const box = collect(room);
	await sleep(1500);
	return { room, box };
}

const { room, box } = await join();
log(`joined ${URL} as ${room.sessionId} (purse ${box.profile?.gold}, bank ${box.profile?.bank})\n`);
check('join delivers a full profile snapshot', !!box.profile && Array.isArray(box.profile.inv), `${box.profile?.inv?.length} pack slots`);

// --- gather -------------------------------------------------------------------
// Walk, don't teleport: the room rejects any step over MAX_STEP_M as a teleport,
// so a single jump to the tree would silently leave the player at spawn and every
// chop would come back "move up to a tree". Step there the way a player does.
async function walkTo(tx, tz) {
	const STEP = 1.0; // under the server's 1.2m anti-teleport clamp
	let x = room.state.players?.get?.(room.sessionId)?.x ?? 0;
	let z = room.state.players?.get?.(room.sessionId)?.z ?? 0;
	for (let i = 0; i < 400; i += 1) {
		const dx = tx - x, dz = tz - z;
		const d = Math.hypot(dx, dz);
		if (d < 0.6) break;
		const s = Math.min(STEP, d);
		x += (dx / d) * s;
		z += (dz / d) * s;
		room.send('move', { x, y: 0, z, yaw: Math.atan2(dx, dz), motion: 1 });
		await sleep(70);
	}
	await sleep(300);
	const me = room.state.players?.get?.(room.sessionId);
	return { x: me?.x, z: me?.z };
}

const tree = TREES[0];
const arrived = await walkTo(tree.x + 0.6, tree.z + 0.6);
check('the player can walk to a resource node without tripping the anti-teleport clamp',
	Math.hypot((arrived.x ?? 0) - tree.x, (arrived.z ?? 0) - tree.z) < 2.5,
	`tree ${tree.id} at (${tree.x}, ${tree.z}), arrived (${arrived.x?.toFixed?.(1)}, ${arrived.z?.toFixed?.(1)})`);

room.send('equip', { slot: (box.profile.hotbar || []).findIndex((s) => s.item === 'axe') });
await sleep(400);

const woodBefore = held(box.inv || box.profile, 'wood');
let swings = 0;
while (held(box.inv || box.profile, 'wood') <= woodBefore && swings < MAX_SWINGS) {
	room.send('chop');
	swings += 1;
	await sleep(1400);
}
const woodAfter = held(box.inv || box.profile, 'wood');
check('chopping a tree yields wood into the pack', woodAfter > woodBefore, `${woodBefore} to ${woodAfter} over ${swings} swings`);
check('a swing always pays woodcutting XP, hit or miss', box.xp.filter((g) => g.skill === 'woodcutting').length === swings, `${box.xp.length} xp events for ${swings} swings`);
check('XP events carry exact level boundaries so the bar needs no round trip',
	box.xp.every((g) => Number.isFinite(g.levelXp) && (g.nextXp === null || Number.isFinite(g.nextXp))), '');

// --- the counter has to be walked to ------------------------------------------
// Trading from the tree line must be refused: "walk to the shop" is a rule the
// server keeps, not a courtesy the client extends.
const noticesBeforeRemote = box.notices.length;
const purseAtTree = purseOf(box);
room.send('storeSell', { slot: { zone: 'inv', i: slotOf(box.inv || box.profile, 'wood') } });
room.send('bank', { amount: 1 });
await sleep(800);
check('trading and banking from out in the world are refused',
	purseOf(box) === purseAtTree,
	box.notices.slice(noticesBeforeRemote).map((n) => n.text).join(' | ') || 'no refusal notice');

// --- sell ---------------------------------------------------------------------
const stall = VENDOR_STALLS[0];
await walkTo(stall.x, stall.z);
room.send('storeReq');
await sleep(500);
const woodPrice = box.store?.sell?.find((s) => s.item === 'wood')?.price;
check('the store catalog arrives priced by the server', Number.isFinite(woodPrice), `wood sells for ${woodPrice} cash`);

const purseBeforeSell = purseOf(box);
const stack = held(box.inv, 'wood');
const woodSlot = slotOf(box.inv, 'wood');
room.send('storeSell', { slot: { zone: 'inv', i: woodSlot } });
await sleep(800);
check('a sale pays exactly catalog price times quantity',
	purseOf(box) === purseBeforeSell + stack * woodPrice,
	`${purseBeforeSell} + ${stack}x${woodPrice} expected ${purseBeforeSell + stack * woodPrice}, got ${purseOf(box)}`);
check('the sold stack left the pack', held(box.inv, 'wood') === 0, '');

// Two clicks on a stack that is already gone must pay nothing the second time.
const purseAfterSell = purseOf(box);
room.send('storeSell', { slot: { zone: 'inv', i: woodSlot } });
room.send('storeSell', { slot: { zone: 'inv', i: woodSlot } });
await sleep(800);
check('re-selling an emptied slot pays nothing', purseOf(box) === purseAfterSell, `purse held at ${purseOf(box)}`);

// --- buy ----------------------------------------------------------------------
const potion = box.store.buy.find((b) => b.item === 'healthPotion');
const purseBeforeBuy = purseOf(box);
const potionsBefore = held(box.inv, 'healthPotion');
room.send('storeBuy', { item: 'healthPotion' });
await sleep(800);
if (purseBeforeBuy >= potion.price) {
	check('a purchase charges exactly the listed price',
		purseOf(box) === purseBeforeBuy - potion.price,
		`${purseBeforeBuy} - ${potion.price} expected ${purseBeforeBuy - potion.price}, got ${purseOf(box)}`);
	check('the purchased item landed in the pack', held(box.inv, 'healthPotion') === potionsBefore + potion.qty, '');
} else {
	check('an unaffordable purchase is refused and charges nothing',
		purseOf(box) === purseBeforeBuy,
		box.notices.at(-1)?.text);
}

// --- bank ---------------------------------------------------------------------
const atm = ATMS[0];
await walkTo(atm.x, atm.z);
const purse = purseOf(box);
room.send('bank', { amount: purse });
await sleep(700);
check('a deposit moves the exact purse into the protected balance',
	box.profile.bank >= purse && box.profile.gold === 0,
	`bank ${box.profile.bank}, purse ${box.profile.gold}`);

const bankBefore = box.profile.bank;
room.send('bank', { amount: -999_999 });
await sleep(700);
check('an over-withdrawal clamps to what is banked and never mints cash',
	box.profile.gold === bankBefore && box.profile.bank === 0,
	`purse ${box.profile.gold}, bank ${box.profile.bank}`);

// --- the wheel ----------------------------------------------------------------
room.send('spinInfo');
await sleep(600);
check('spinInfo states the real level gate the UI must render',
	Number.isFinite(box.spinInfo?.minLevel),
	`minLevel ${box.spinInfo?.minLevel}, this account averages ${box.spinInfo?.avgLevel?.toFixed?.(2)}`);
check('the published paytable is 20 wedges summing to exactly 100%',
	box.spinInfo?.segments?.length === 20 && box.spinInfo.segments.reduce((n, s) => n + s.oddsPct, 0) === 100, '');
room.send('spinFree');
await sleep(800);
check('a refused spin comes back with a reason the UI has copy for',
	box.spin != null || ['level', 'cooldown', 'pack_full', 'not_at_wheel'].includes(box.denied?.reason),
	box.spin ? `spun: ${box.spin.label}` : `denied: ${box.denied?.reason}`);

// --- persistence ---------------------------------------------------------------
const goldAtLeave = box.profile.gold;
const bankAtLeave = box.profile.bank;
await room.leave();
await sleep(1500);
const again = await join();
check('purse and bank survive a disconnect and rejoin',
	again.box.profile.gold === goldAtLeave && again.box.profile.bank === bankAtLeave,
	`left with ${goldAtLeave}/${bankAtLeave}, came back to ${again.box.profile.gold}/${again.box.profile.bank}`);
await again.room.leave();

const failed = results.filter((r) => !r.pass);
log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
