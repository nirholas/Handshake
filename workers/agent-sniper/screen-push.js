// screen-push.js — fire-and-forget push to the agent screen stream.
// All pushes are non-blocking: failures are swallowed so they never
// interrupt trading. Import this in index.js and call screenPush()
// alongside existing log() calls.


const PUSH_URL = process.env.PUSH_URL || 'https://three.ws/api/agent-screen-push';
const AGENT_JWT = process.env.AGENT_JWT;
const AGENT_ID  = process.env.AGENT_ID;

const CW = 1280, CH = 720;
const activityLog = [];

// Try to load node-canvas for rendered terminal frames. Falls back to
// text-only pushes silently if the package isn't installed.
let canvasCreate = false;
(async () => {
	try {
		const mod = await import('canvas');
		canvasCreate = mod.createCanvas;
	} catch {}
})();

function renderTerminalFrame(newLine) {
	if (!canvasCreate) return null;
	activityLog.push(newLine);
	if (activityLog.length > 18) activityLog.shift();

	const canvas = canvasCreate(CW, CH);
	const ctx = canvas.getContext('2d');

	// Background
	ctx.fillStyle = '#06080f';
	ctx.fillRect(0, 0, CW, CH);

	// Header bar
	ctx.fillStyle = '#0d1117';
	ctx.fillRect(0, 0, CW, 48);
	ctx.fillStyle = 'rgba(255,255,255,0.4)';
	ctx.font = '14px monospace';
	ctx.fillText('▶  agent-sniper', 16, 30);
	ctx.fillText(new Date().toISOString().slice(0, 19) + 'Z', CW - 220, 30);

	// Terminal lines
	ctx.font = '24px monospace';
	activityLog.forEach((line, i) => {
		const age = activityLog.length - 1 - i;
		if (age === 0) {
			ctx.fillStyle = '#fff';
		} else if (age < 3) {
			ctx.fillStyle = 'rgba(255,255,255,0.75)';
		} else if (age < 7) {
			ctx.fillStyle = 'rgba(255,255,255,0.45)';
		} else {
			ctx.fillStyle = 'rgba(255,255,255,0.2)';
		}
		ctx.fillText(line.slice(0, 90), 24, 72 + i * 36);
	});

	return 'data:image/png;base64,' + canvas.toBuffer('image/png').toString('base64');
}

// Sanitize a trade PnL payload before it rides along on the frame: keep only
// the known fields, coerce numbers, and drop NaN/∞ so a bad value can never
// reach the viewer's ticker. Returns null when there's nothing usable.
function sanitizePnl(pnl) {
	if (!pnl || typeof pnl !== 'object') return null;
	if (!['scored', 'buy', 'hold', 'exit'].includes(pnl.phase)) return null;
	const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
	const out = { phase: pnl.phase };
	if (typeof pnl.mint === 'string') out.mint = pnl.mint.slice(0, 64);
	if (typeof pnl.symbol === 'string') out.symbol = pnl.symbol.slice(0, 32);
	for (const k of ['solDelta', 'pct', 'realizedUsd', 'unrealizedUsd']) {
		const n = num(pnl[k]);
		if (n !== undefined) out[k] = n;
	}
	return out;
}

export function screenPush(activity, type = 'activity', pnl = null) {
	if (!AGENT_JWT || !AGENT_ID) return;
	const label = `[${type.toUpperCase()}] ${activity}`;
	const data = renderTerminalFrame(label);
	const frame = data ? { data, activity, type } : { activity, type };
	const cleanPnl = sanitizePnl(pnl);
	if (cleanPnl) frame.pnl = cleanPnl;
	fetch(PUSH_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${AGENT_JWT}` },
		body: JSON.stringify({ agentId: AGENT_ID, frame }),
	}).catch(() => {});
}
