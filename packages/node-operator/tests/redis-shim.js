/**
 * A minimal in-process Redis-over-REST server that speaks exactly the
 * Upstash REST protocol the platform's api/_lib/redis.js client uses.
 *
 * Three request shapes, all of which the Upstash client emits:
 *   POST /pipeline   body [["set","k","v"],["get","k"]] -> [{result},{result}]
 *   POST /           body ["set","k","v"]               -> {result}
 *   POST /set/k      body ["v"]                         -> {result}
 * Auto-pipelining is on by default in the client, so /pipeline is the shape
 * that actually carries production traffic; a shim that only answered the
 * single-command form failed every command with "unknown command 'pipeline'".
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

	/** Run one `[command, ...args]` array and return its Upstash result envelope. */
	function exec(command) {
		if (!Array.isArray(command) || command.length === 0) {
			return { error: 'ERR empty command' };
		}
		const name = String(command[0]).toLowerCase();
		const handler = handlers[name];
		if (!handler) return { error: `ERR unknown command '${name}'` };
		try {
			return { result: handler(command.slice(1)) };
		} catch (err) {
			return { error: String(err.message || err) };
		}
	}

	/**
	 * The client asks for base64 response encoding by default
	 * (`Upstash-Encoding: base64`) and unconditionally base64-DECODES every
	 * string it gets back. A shim that answers in plain text therefore corrupts
	 * any value that happens to be valid base64: `rpop` returning the job id
	 * "job1" decoded to three bytes of mojibake, so the queue drained into
	 * nothing. Encode string results whenever the header asks for it.
	 */
	function encodeResult(value) {
		if (typeof value === 'string') return Buffer.from(value, 'utf8').toString('base64');
		if (Array.isArray(value)) return value.map(encodeResult);
		return value;
	}

	const server = http.createServer((req, res) => {
		const segments = req.url.split('/').filter(Boolean).map(decodeURIComponent);
		const route = (segments[0] || '').toLowerCase();
		const b64 = String(req.headers['upstash-encoding'] || '').toLowerCase() === 'base64';
		const envelope = (out) => (b64 && out.result !== undefined ? { ...out, result: encodeResult(out.result) } : out);
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			let parsed = null;
			if (body) {
				try {
					parsed = JSON.parse(body);
				} catch { parsed = null; }
			}
			res.setHeader('content-type', 'application/json');

			// The Upstash client batches commands by default (auto-pipelining), so
			// the common case is POST /pipeline with an array OF command arrays.
			// `multi-exec` uses the same shape; this store is single-threaded per
			// request, which is all the atomicity the queue needs.
			if (route === 'pipeline' || route === 'multi-exec') {
				if (!Array.isArray(parsed)) {
					res.writeHead(400);
					res.end(JSON.stringify({ error: 'ERR pipeline body must be an array of commands' }));
					return;
				}
				res.writeHead(200);
				res.end(JSON.stringify(parsed.map((c) => envelope(exec(c)))));
				return;
			}

			// Single command: `POST /` with ["set", key, ...], or the path form
			// `POST /set/key` with the remaining args in the body.
			const command = Array.isArray(parsed)
				? (route ? [route, ...parsed] : parsed)
				: [route, ...segments.slice(1)];
			const out = exec(command);
			res.writeHead(out.error ? 400 : 200);
			res.end(JSON.stringify(envelope(out)));
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
