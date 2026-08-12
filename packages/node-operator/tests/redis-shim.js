/**
 * A minimal in-process Redis-over-REST server that speaks exactly the
 * Upstash REST protocol the platform's api/_lib/redis.js client uses
 * (POST {url}/{command}/{key} with a JSON-array body of the remaining args,
 * responding { result } / { error }).
 *
 * It implements only the commands the inference-node queue needs
 * (get/set/rpush/rpop/del/expire), which is the point: this shim exists so
 * `npm run e2e` can prove the full register -> job -> signed-result loop on
 * a bare laptop with no Upstash account, no Docker, and no network beyond
 * the model download. Production uses real Upstash; the client library
 * cannot tell the difference because the wire format is identical.
 */

import http from 'node:http';

export function createRedisShim() {
	// key -> { value: string, expiresAt?: number } | { list: string[], expiresAt?: number }
	const store = new Map();

	function live(key) {
		const e = store.get(key);
		if (!e) return null;
		if (e.expiresAt && Date.now() > e.expiresAt) { store.delete(key); return null; }
		return e;
	}

	const handlers = {
		get([key]) { return live(key)?.value ?? null; },
		set([key, value, ...rest]) {
			const entry = { value: String(value) };
			const exIdx = rest.findIndex((a) => String(a).toLowerCase() === 'ex');
			if (exIdx >= 0) entry.expiresAt = Date.now() + Number(rest[exIdx + 1]) * 1000;
			store.set(key, entry);
			return 'OK';
		},
		rpush([key, ...values]) {
			let e = live(key);
			if (!e || !Array.isArray(e.list)) { e = { list: [] }; store.set(key, e); }
			e.list.push(...values.map(String));
			return e.list.length;
		},
		rpop([key]) {
			const e = live(key);
			if (!e || !Array.isArray(e.list) || e.list.length === 0) return null;
			return e.list.pop();
		},
		del([...keys]) {
			let n = 0;
			for (const k of keys) if (store.delete(k)) n++;
			return n;
		},
		expire([key, seconds]) {
			const e = live(key);
			if (!e) return 0;
			e.expiresAt = Date.now() + Number(seconds) * 1000;
			return 1;
		},
	};

	const server = http.createServer((req, res) => {
		const segments = req.url.split('/').filter(Boolean).map(decodeURIComponent);
		const command = (segments[0] || '').toLowerCase();
		const args = segments.slice(1);
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			let cmdArgs = args;
			if (body) {
				try {
					const parsed = JSON.parse(body);
					if (Array.isArray(parsed)) cmdArgs = parsed;
				} catch { /* keep path args */ }
			}
			const handler = handlers[command];
			res.setHeader('content-type', 'application/json');
			if (!handler) {
				res.writeHead(400);
				res.end(JSON.stringify({ error: `ERR unknown command '${command}'` }));
				return;
			}
			try {
				res.writeHead(200);
				res.end(JSON.stringify({ result: handler(cmdArgs) }));
			} catch (err) {
				res.writeHead(400);
				res.end(JSON.stringify({ error: String(err.message || err) }));
			}
		});
	});

	return {
		/** Start listening on an ephemeral port; resolves with the base URL. */
		async listen() {
			await new Promise((r) => server.listen(0, '127.0.0.1', r));
			const { port } = server.address();
			return `http://127.0.0.1:${port}`;
		},
		async close() {
			await new Promise((r) => server.close(r));
		},
		/** Test introspection: raw view of a key. */
		_peek(key) { return live(key); },
	};
}
