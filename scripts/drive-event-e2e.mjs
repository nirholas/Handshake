// End-to-end driver: joins the real WalkRoom over the wire, walks the event
// landmark tour, and reports what the SERVER sent back at every step.
import { Client } from 'colyseus.js';

const SERVER = process.env.MP_URL || 'ws://localhost:2567';
const PID = process.argv[2] || 'gs_e2e_runner_one';
const NAME = process.argv[3] || 'E2E Runner';

const log = (...a) => console.log('[e2e]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = new Client(SERVER);
const room = await client.joinOrCreate('walk_world', {
	token: '', name: NAME, pid: PID, avatar: '', agent: '',
});
log('joined', room.roomId, 'session', room.sessionId);

let lastQuests = null;
const seen = { complete: [], score: [], board: null, notices: [] };
room.onMessage('quests', (m) => { lastQuests = m; });
room.onMessage('questComplete', (m) => { seen.complete.push(m); log('questComplete:', JSON.stringify(m)); });
room.onMessage('eventScore', (m) => { seen.score.push(m); log('eventScore:', JSON.stringify(m)); });
room.onMessage('eventBoard', (m) => { seen.board = m; });
room.onMessage('notice', (m) => { if (m?.kind === 'quest') { seen.notices.push(m); log('notice:', m.text); } });

await sleep(1500);
room.send('questReq');
await sleep(800);

const eventOffers = (lastQuests?.offers || []).filter((o) => o.event);
log('eventLive flag from server:', lastQuests?.eventLive);
log('event jobs on the board:', eventOffers.map((o) => `${o.id} (${o.title})`).join(', ') || 'NONE');

room.send('questAccept', { id: 'event-landmark-tour' });
await sleep(800);
const activeIds = (lastQuests?.active || []).map((r) => r.id);
log('active after accept:', activeIds.join(', '));

// Walk the tour. Steps stay under the server's 1.2 m teleport clamp and ride at
// the same 15 Hz the real client sends at.
let pos = { x: 0, z: 0 };
async function walkTo(tx, tz, label) {
	log(`walking to ${label} (${tx}, ${tz})`);
	while (Math.hypot(tx - pos.x, tz - pos.z) > 0.4) {
		const dx = tx - pos.x, dz = tz - pos.z;
		const d = Math.hypot(dx, dz);
		const step = Math.min(1.0, d);
		pos = { x: pos.x + (dx / d) * step, z: pos.z + (dz / d) * step };
		room.send('move', { x: pos.x, y: 0, z: pos.z, yaw: Math.atan2(dx, dz), motion: 'run' });
		await sleep(66);
	}
	await sleep(400);
	const run = (lastQuests?.active || []).find((r) => r.id === 'event-landmark-tour');
	if (run) log(`  stage ${run.stage}/${run.objectives.length}`, run.objectives.map((o) => (o.done ? '✔' : o.current ? '▶' : '·')).join(''));
}

await walkTo(0, -12, 'the Totem');
await walkTo(0, 22, "Fortune's Folly");
await walkTo(0, -30, 'the Trading Screen');
await sleep(1500);

room.send('eventBoardReq');
await sleep(2000);
log('eventBoard reply:', JSON.stringify(seen.board, null, 2));

log('RESULT completions:', seen.complete.length, 'scores:', seen.score.length);
await room.leave();
process.exit(seen.complete.length && seen.score.length && seen.board?.ok ? 0 : 1);
