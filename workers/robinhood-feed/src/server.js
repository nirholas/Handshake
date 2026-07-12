// HTTP + WebSocket server. Fans normalized firehose events out to WS and SSE
// subscribers and keeps a small replay buffer so a fresh subscriber sees recent
// history instead of a blank feed — mirroring the three.ws pump SSE endpoints.
//
// Endpoints:
//   GET  /healthz                  → { ok, uptime, subscribers, buffer, firehose }
//   GET  /recent?kind=&limit=      → JSON snapshot of the replay buffer
//   GET  /events?kinds=launch,...  → SSE stream (text/event-stream)
//   WS   /ws?kinds=launch,...      → same events over a WebSocket
//   GET  /                         → tiny status page

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { config } from './config.js';

const KINDS = ['launch', 'trade', 'graduation'];

function parseKinds(url) {
	const raw = new URL(url, 'http://x').searchParams.get('kinds');
	if (!raw) return new Set(KINDS);
	const want = raw.split(',').map((s) => s.trim()).filter((k) => KINDS.includes(k));
	return new Set(want.length ? want : KINDS);
}

export function createServer(firehose) {
	const startedAt = Date.now();
	const buffer = { launch: [], trade: [], graduation: [] };
	const sseClients = new Set(); // { res, kinds }

	function pushBuffer(kind, data) {
		const arr = buffer[kind];
		if (!arr) return;
		const sig = data.tx_signature || data.signature;
		if (sig && arr.some((e) => (e.tx_signature || e.signature) === sig && e.mint === data.mint)) return;
		arr.unshift(data);
		while (arr.length > config.bufferLimit) arr.pop();
	}

	function recent({ kind = 'all', limit = 20 } = {}) {
		const cap = Math.max(1, Math.min(200, limit | 0 || 20));
		const kinds = kind === 'all' ? KINDS : KINDS.includes(kind) ? [kind] : [];
		const out = [];
		for (const k of kinds) for (const d of buffer[k]) out.push({ kind: k, data: d });
		out.sort((a, b) => (b.data.timestamp || 0) - (a.data.timestamp || 0));
		return out.slice(0, cap);
	}

	// Firehose → buffer + fan-out.
	function onEvent(ev) {
		if (ev.kind !== 'status') pushBuffer(ev.kind, ev.data);
		const line = `data: ${JSON.stringify(ev)}\n\n`;
		for (const c of sseClients) {
			if (ev.kind === 'status' || c.kinds.has(ev.kind)) {
				try { c.res.write(line); } catch { /* dropped below on close */ }
			}
		}
		const msg = JSON.stringify(ev);
		for (const ws of wss.clients) {
			if (ws.readyState !== ws.OPEN) continue;
			if (ev.kind === 'status' || ws._kinds?.has(ev.kind)) {
				try { ws.send(msg); } catch { /* ignore */ }
			}
		}
	}

	const server = http.createServer((req, res) => {
		const { pathname } = new URL(req.url, 'http://x');
		res.setHeader('access-control-allow-origin', '*');

		if (pathname === '/healthz') {
			return json(res, 200, {
				ok: true,
				network: config.network,
				uptime_s: Math.round((Date.now() - startedAt) / 1000),
				subscribers: { sse: sseClients.size, ws: wss.clients.size },
				buffer: { launch: buffer.launch.length, trade: buffer.trade.length, graduation: buffer.graduation.length },
				firehose: firehose.health(),
			});
		}

		if (pathname === '/recent') {
			const sp = new URL(req.url, 'http://x').searchParams;
			return json(res, 200, { events: recent({ kind: sp.get('kind') || 'all', limit: Number(sp.get('limit')) || 20 }) });
		}

		if (pathname === '/events') {
			res.writeHead(200, {
				'content-type': 'text/event-stream',
				'cache-control': 'no-cache, no-transform',
				connection: 'keep-alive',
			});
			const client = { res, kinds: parseKinds(req.url) };
			sseClients.add(client);
			// Replay recent history immediately.
			for (const ev of recent({ kind: 'all', limit: config.bufferLimit }).reverse()) {
				if (client.kinds.has(ev.kind)) res.write(`data: ${JSON.stringify({ ...ev, replay: true })}\n\n`);
			}
			res.write(`data: ${JSON.stringify({ kind: 'status', data: { level: 'info', src: 'sse', message: 'connected' } })}\n\n`);
			const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 20_000);
			req.on('close', () => { clearInterval(ka); sseClients.delete(client); });
			return undefined;
		}

		if (pathname === '/') {
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
			return res.end(statusPage());
		}

		return json(res, 404, { error: 'not found' });
	});

	const wss = new WebSocketServer({ server, path: '/ws' });
	wss.on('connection', (ws, req) => {
		ws._kinds = parseKinds(req.url);
		for (const ev of recent({ kind: 'all', limit: config.bufferLimit }).reverse()) {
			if (ws._kinds.has(ev.kind)) { try { ws.send(JSON.stringify({ ...ev, replay: true })); } catch { /* ignore */ } }
		}
	});

	return { server, onEvent, recent };
}

function json(res, code, body) {
	res.writeHead(code, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
}

function statusPage() {
	return `<!doctype html><html><head><meta charset=utf-8><title>robinhood-feed</title>
<style>body{background:#0b0d10;color:#e6e8eb;font:14px/1.6 ui-monospace,monospace;margin:0;padding:40px;max-width:720px}
h1{font-size:18px;color:#5fd08a}a{color:#7aa2f7}code{background:#161a1f;padding:2px 6px;border-radius:4px}</style></head>
<body><h1>robinhood-feed · Robinhood Chain firehose</h1>
<p>Normalized launches, trades and graduations from NOXA + The Odyssey + Uniswap v3.</p>
<ul>
<li><a href="/healthz">/healthz</a> — status JSON</li>
<li><a href="/recent">/recent</a> — replay-buffer snapshot (<code>?kind=trade&amp;limit=20</code>)</li>
<li><code>/events</code> — SSE stream (<code>?kinds=launch,trade,graduation</code>)</li>
<li><code>/ws</code> — WebSocket stream (same events)</li>
</ul></body></html>`;
}
