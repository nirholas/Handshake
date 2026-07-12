// screen-push.js — fire-and-forget push to the agent screen stream for the
// Newsroom Anchor. Mirrors workers/agent-sniper/screen-push.js: every push is
// non-blocking and failures are swallowed so a transport blip never stalls the
// broadcast cadence. Optionally renders a broadcast-style frame with node-canvas
// (lower-third over a desk gradient) when the package is available, falling back
// to a text-only frame otherwise.


const PUSH_URL = process.env.PUSH_URL || 'https://three.ws/api/agent-screen-push';
const AGENT_JWT = process.env.AGENT_JWT;
const AGENT_ID = process.env.AGENT_ID;

const CW = 1280, CH = 720;

// node-canvas is optional. If it isn't installed the worker still pushes
// text-only frames — the client renders the real lower-third + talking avatar,
// so the rendered desk frame is a bonus for non-anchor surfaces (the wall).
let canvasCreate = false;
(async () => {
	try {
		const mod = await import('canvas');
		canvasCreate = mod.createCanvas;
	} catch { /* text-only mode */ }
})();

function wrapLines(ctx, text, maxWidth, maxLines) {
	const words = String(text).split(/\s+/);
	const lines = [];
	let line = '';
	for (const w of words) {
		const test = line ? `${line} ${w}` : w;
		if (ctx.measureText(test).width > maxWidth && line) {
			lines.push(line);
			line = w;
			if (lines.length >= maxLines) return lines;
		} else {
			line = test;
		}
	}
	if (line && lines.length < maxLines) lines.push(line);
	return lines;
}

function renderBroadcastFrame(headline) {
	if (!canvasCreate) return null;
	const canvas = canvasCreate(CW, CH);
	const ctx = canvas.getContext('2d');

	// Studio backdrop
	const bg = ctx.createLinearGradient(0, 0, 0, CH);
	bg.addColorStop(0, '#0a1326');
	bg.addColorStop(1, '#05080f');
	ctx.fillStyle = bg;
	ctx.fillRect(0, 0, CW, CH);

	// Channel mark
	ctx.fillStyle = 'rgba(255,255,255,0.5)';
	ctx.font = '600 22px sans-serif';
	ctx.fillText('three.ws · NEWSROOM', 48, 56);
	ctx.fillStyle = '#ff4d4f';
	ctx.beginPath();
	ctx.arc(CW - 120, 48, 8, 0, Math.PI * 2);
	ctx.fill();
	ctx.fillStyle = 'rgba(255,255,255,0.85)';
	ctx.font = '700 18px sans-serif';
	ctx.fillText('ON AIR', CW - 100, 54);

	// Lower-third band
	const bandY = CH - 220;
	ctx.fillStyle = 'rgba(8,12,24,0.92)';
	ctx.fillRect(0, bandY, CW, 220);
	const accent = ctx.createLinearGradient(0, bandY, 0, bandY + 6);
	accent.addColorStop(0, '#6ea8ff');
	accent.addColorStop(1, '#3b6ed8');
	ctx.fillStyle = accent;
	ctx.fillRect(0, bandY, CW, 6);

	ctx.fillStyle = '#6ea8ff';
	ctx.font = '700 22px sans-serif';
	ctx.fillText('MARKET ANCHOR', 56, bandY + 50);

	ctx.fillStyle = '#ffffff';
	ctx.font = '700 46px sans-serif';
	const lines = wrapLines(ctx, headline, CW - 112, 2);
	lines.forEach((l, i) => ctx.fillText(l, 56, bandY + 110 + i * 56));

	return 'data:image/png;base64,' + canvas.toBuffer('image/png').toString('base64');
}

/**
 * Push a bulletin headline frame. type is 'analysis' so the client's anchor
 * overlay picks it up and speaks the matching script.
 */
export function screenPush(activity, type = 'analysis') {
	if (!AGENT_JWT || !AGENT_ID) return;
	const data = type === 'analysis' ? renderBroadcastFrame(activity) : null;
	const frame = data ? { data, activity, type } : { activity, type };
	fetch(PUSH_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${AGENT_JWT}` },
		body: JSON.stringify({ agentId: AGENT_ID, frame }),
	}).catch(() => {});
}
