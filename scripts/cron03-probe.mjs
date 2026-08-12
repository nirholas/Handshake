// api-cron-03 probe: load each batch handler through its true import graph and
// invoke it with synthetic req/res (the same wiring server/index.mjs uses).
// CRON_SECRET is a session-local value so requireCron passes only when we present it.
process.env.CRON_SECRET = 'cron03-audit-secret';
process.env.DATABASE_URL = 'postgres://postgres:cron03audit@127.0.0.1:5545/cron03';
// Point app origin at loopback so outbound HTTP (forge-smoke, forge-seed submits)
// fails fast instead of hanging on real HTTPS, and keep every spend lane in its
// clean-skip path. No lane is configured here, so no real spend can occur.
process.env.APP_ORIGIN = 'http://127.0.0.1:9';

const files = [
	'api/cron/forge-seed-cron.js',
	'api/cron/forge-smoke.js',
	'api/cron/forge-thumbnail-backfill.js',
	'api/cron/free-model-audit.js',
	'api/cron/garment-catalog-audit.js',
	'api/cron/garment-job-sweep.js',
	'api/cron/gcp-burn-report.js',
	'api/cron/gmgn-seed.js',
	'api/cron/gpu-keepwarm.js',
	'api/cron/intel-learn.js',
];

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		_body: '',
		setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
		getHeader(k) { return this.headers[String(k).toLowerCase()]; },
		writeHead(s, h) { this.statusCode = s; if (h) for (const [k, v] of Object.entries(h)) this.setHeader(k, v); return this; },
		write(c) { this._body += c; },
		end(c) { if (c) this._body += c; this._done(this); },
		json(o) { this._body = JSON.stringify(o); this._done(this); },
	};
}
function makeReq({ method = 'GET', url = '/', headers = {} } = {}) {
	return {
		method,
		url,
		headers,
		socket: { remoteAddress: '127.0.0.1' },
		on() {}, once() {}, removeListener() {},
	};
}

async function call(handler, req) {
	const res = makeRes();
	const done = new Promise((resolve) => { res._done = resolve; });
	try { await handler(req, res); } catch (err) {
		res.statusCode = -1;
		res._body = 'THROW: ' + (err?.message || String(err));
	}
	if (!res.headersSent && !res.writableEnded && res._done) {
		// If handler never ended, wait briefly for async completion.
		await Promise.race([done, new Promise((r) => setTimeout(r, 100))]);
	}
	let parsed = null;
	try { parsed = JSON.parse(res._body); } catch { /* non-JSON */ }
	return { status: res.statusCode, body: parsed ?? res._body.slice(0, 200) };
}

const secret = process.env.CRON_SECRET;
for (const f of files) {
	const mod = await import('/workspaces/three.ws/' + f);
	const handler = mod.default;
	const name = f.replace('api/cron/', '').replace('.js', '');

	// 1. No auth -> must be 401 (fail-closed).
	const noauth = await call(handler, makeReq({ url: `/api/cron/${name}` }));
	// 2. Wrong secret -> 401.
	const wrong = await call(handler, makeReq({ url: `/api/cron/${name}`, headers: { authorization: 'Bearer nope' } }));
	// 3. Valid secret -> success path (200).
	const ok = await call(handler, makeReq({ url: `/api/cron/${name}`, headers: { authorization: `Bearer ${secret}` } }));
	// 4. Wrong method -> 405.
	const m405 = await call(handler, makeReq({ method: 'DELETE', url: `/api/cron/${name}`, headers: { authorization: `Bearer ${secret}` } }));

	const short = (r) => typeof r.body === 'string' ? r.body : JSON.stringify(r.body).slice(0, 160);
	console.log(`\n=== ${name} ===`);
	console.log(`  noauth   -> ${noauth.status} ${short(noauth)}`);
	console.log(`  wrongkey -> ${wrong.status} ${short(wrong)}`);
	console.log(`  authed   -> ${ok.status} ${short(ok)}`);
	console.log(`  method   -> ${m405.status} ${short(m405)}`);
}
process.exit(0);
