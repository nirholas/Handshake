// End-to-end smoke test for the Coin Communities voxel build server.
//
// Boots nothing itself — point it at a running multiplayer server (default
// ws://localhost:2567). It joins a coin world, then exercises the place/remove
// contract the client relies on:
//   1. a legal place lands in authoritative state.blocks
//   2. a repaint changes the block type in place (no new cell)
//   3. an out-of-bounds place is rejected
//   4. a bad block type is rejected
//   5. a remove deletes the cell
//   6. a second client joining sees the persisted build (rehydration path)
//
// Exit code 0 = all assertions passed.

import { Client } from 'colyseus.js';

const URL = process.env.GAME_SERVER_URL || 'ws://localhost:2567';
const COIN = process.env.SMOKE_COIN || 'So11111111111111111111111111111111111111112';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond) {
	console.log(`${cond ? '  ok ' : 'FAIL '} ${name}`);
	if (!cond) failures++;
}

async function join() {
	const client = new Client(URL);
	const room = await client.joinOrCreate('walk_world', {
		coin: COIN, coinName: 'Wrapped SOL', coinSymbol: 'SOL', name: 'smoke-bot',
	});
	return room;
}

async function main() {
	console.log(`→ ${URL}  coin=${COIN.slice(0, 8)}…`);
	const room = await join();
	await sleep(300); // let initial state sync

	// 1. Legal place at origin, gold (type 8).
	room.send('place', { x: 0, y: 0, z: 0, t: 8 });
	await sleep(250);
	check('legal place lands in state.blocks', room.state.blocks.get('0,0,0')?.t === 8);

	// 2. Repaint the same cell to neon (type 9) — same cell, new type, size unchanged.
	const sizeBeforeRepaint = room.state.blocks.size;
	room.send('place', { x: 0, y: 0, z: 0, t: 9 });
	await sleep(250);
	check('repaint changes type in place', room.state.blocks.get('0,0,0')?.t === 9);
	check('repaint does not grow the world', room.state.blocks.size === sizeBeforeRepaint);

	// 3. Out-of-bounds place (far outside MAX_GRID_XZ=30) is rejected.
	room.send('place', { x: 999, y: 0, z: 0, t: 1 });
	await sleep(200);
	check('out-of-bounds place rejected', !room.state.blocks.has('999,0,0'));

	// 4. Bad block type (>= BLOCK_TYPE_COUNT) is rejected.
	room.send('place', { x: 2, y: 0, z: 2, t: 99 });
	await sleep(200);
	check('bad block type rejected', !room.state.blocks.has('2,0,2'));

	// 5. Non-integer cell rejected.
	room.send('place', { x: 1.5, y: 0, z: 0, t: 1 });
	await sleep(200);
	check('non-integer cell rejected', !room.state.blocks.has('1.5,0,0'));

	// 6. A second client sees the persisted build immediately on join.
	const room2 = await join();
	await sleep(400);
	check('second client sees the persisted block', room2.state.blocks.get('0,0,0')?.t === 9);

	// 7. Remove deletes the cell in authoritative state and propagates to peers.
	room.send('remove', { x: 0, y: 0, z: 0 });
	await sleep(300);
	check('remove deletes cell for sender', !room.state.blocks.has('0,0,0'));
	check('remove propagates to other clients', !room2.state.blocks.has('0,0,0'));

	room.leave();
	room2.leave();
	await sleep(150);

	console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('smoke error:', e?.message ?? e); process.exit(2); });
