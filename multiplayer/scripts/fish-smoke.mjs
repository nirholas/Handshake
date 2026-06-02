// Headless end-to-end smoke test for the /play fishing slice.
// Joins walk_world, walks to the east pond, casts, and asserts the server
// returns the profile (with a starter rod), a catch/miss notice, and fishing XP.
import { Client } from 'colyseus.js';
import { WalkState } from '../src/schemas.js';
import { FISHING_SPOTS } from '../src/world-features.js';

const SPOT = FISHING_SPOTS[0]; // east pond
const log = (...a) => console.log('[fish-smoke]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const got = { profile: null, notices: [], xp: [], inv: [], levelups: [] };

const client = new Client('ws://localhost:2567');
const room = await client.joinOrCreate('walk_world', { name: 'angler', pid: 'smoke-angler', coin: '' }, WalkState);
log('joined', room.sessionId);

room.onMessage('profile', (m) => { got.profile = m; log('profile: gold', m.gold, 'activeSlot', m.activeSlot, 'hotbar[0]', JSON.stringify(m.hotbar?.[0]), 'fishing', m.skills?.fishing?.level); });
room.onMessage('inv', (m) => { got.inv.push(m); });
room.onMessage('xpgain', (m) => { got.xp.push(m); log('xpgain', m.skill, '+' + m.amount, '-> lvl', m.level, 'xp', m.xp); });
room.onMessage('levelup', (m) => { got.levelups.push(m); log('LEVELUP', m.skill, m.level); });
room.onMessage('notice', (m) => { got.notices.push(m); log('notice', JSON.stringify(m)); });

await sleep(400);

// Walk to the pond in <=1.1m steps (server rejects >1.2m teleports).
let x = 0, z = 0;
const tx = SPOT.x, tz = SPOT.z;
for (let i = 0; i < 80; i++) {
	const dx = tx - x, dz = tz - z;
	const d = Math.hypot(dx, dz);
	if (d <= SPOT.r + 3.0) break; // within cast range
	const step = Math.min(1.1, d);
	x += (dx / d) * step; z += (dz / d) * step;
	room.send('move', { x, y: 0, z, yaw: Math.atan2(dx, dz), motion: 'walk' });
	await sleep(40);
}
room.send('move', { x, y: 0, z, motion: 'idle', yaw: 0 });
log('arrived near pond at', x.toFixed(1), z.toFixed(1), 'spot', SPOT.x, SPOT.z);
await sleep(200);

// Cast several times, respecting the ~1.5s per-cast cooldown.
for (let i = 0; i < 8; i++) {
	room.send('fish');
	await sleep(1700);
}
await sleep(400);

// Assertions.
let ok = true;
const assert = (cond, msg) => { if (!cond) { ok = false; log('FAIL:', msg); } else log('PASS:', msg); };
assert(got.profile, 'received profile snapshot on join');
assert(got.profile?.hotbar?.[0]?.item === 'rod', 'starter rod on hotbar slot 0');
assert(got.profile?.activeSlot === 0, 'rod pre-equipped (activeSlot 0)');
assert(got.notices.some((n) => n.kind === 'fish'), 'received at least one fishing notice');
assert(got.xp.some((g) => g.skill === 'fishing'), 'gained fishing XP');
const caught = got.notices.filter((n) => n.kind === 'fish' && n.caught > 0).length;
const fishInInv = (got.inv.at(-1)?.inv || got.profile?.inv || []).reduce((sum, s) => sum + (s.item === 'fish' ? s.qty : 0), 0);
log(`summary: ${caught} successful casts, ${fishInInv} fish in pack, ${got.xp.length} xp events, ${got.levelups.length} level-ups`);
assert(caught === 0 || fishInInv > 0, 'caught fish landed in the inventory');

room.leave();
await sleep(300);
log(ok ? 'RESULT: ALL PASS' : 'RESULT: FAILURES ABOVE');
process.exit(ok ? 0 : 1);
