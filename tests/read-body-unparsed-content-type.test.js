// Guards the raw-upload path of readBody (api/_lib/http.js).
//
// server/index.mjs pre-parses only JSON, urlencoded, text/* and
// application/octet-stream. Every other content type (model/gltf-binary from
// the cookbook asset gate, image/*, multipart) reaches a handler unparsed, and
// readBody has to pull those bytes off the request stream itself.
//
// The bug this pins: readBody used to short-circuit to an empty buffer whenever
// `req.complete` was true. `complete` means Node finished RECEIVING the message,
// not that anyone READ it, and Cloud Run's frontend buffers the whole request
// before invoking the container. So in production every unparsed-content-type
// upload arrived fully buffered, tripped that guard, and was discarded unread:
// POST /api/3d/inspect with a real GLB body answered `empty_body`. The correct
// drained-stream signal is `readableEnded`, which only goes true after 'end' has
// actually been emitted to a consumer.

import { describe, it, expect } from 'vitest';
import express from 'express';
import { Readable } from 'node:stream';
import { readBody } from '../api/_lib/http.js';

const BODY_LIMIT = '25mb';
const LIMIT = 32 * 1024 * 1024;

// The same parser stack server/index.mjs installs ahead of every api/ handler.
function bootServer(onRequest) {
	const app = express();
	const captureRawBody = (req, _res, buf) => {
		req.rawBody = buf;
	};
	app.use(express.json({ limit: BODY_LIMIT, verify: captureRawBody }));
	app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT, verify: captureRawBody }));
	app.use(express.text({ type: 'text/*', limit: BODY_LIMIT }));
	app.use(express.raw({ type: 'application/octet-stream', limit: BODY_LIMIT }));
	app.use(onRequest);
	return new Promise((resolve) => {
		const server = app.listen(0, '127.0.0.1', () => resolve(server));
	});
}

// Cloud Run hands the container a request whose body is already fully received.
// Yielding to the event loop before reading reproduces that: `req.complete`
// flips to true while the bytes sit unread in the readable's buffer.
async function postBody(contentType, payload) {
	const server = await bootServer(async (req, res) => {
		await new Promise((r) => setTimeout(r, 50));
		const complete = req.complete;
		try {
			const buf = await readBody(req, LIMIT);
			res.json({ complete, bytes: buf.byteLength, sha: buf.toString('hex').slice(0, 16) });
		} catch (err) {
			res.status(err.status || 500).json({ complete, error: err.message });
		}
	});
	try {
		const { port } = server.address();
		const res = await fetch(`http://127.0.0.1:${port}/`, {
			method: 'POST',
			headers: { 'content-type': contentType },
			body: payload,
		});
		return await res.json();
	} finally {
		await new Promise((r) => server.close(r));
	}
}

describe('readBody with a content type the server does not pre-parse', () => {
	it('reads a fully-buffered GLB upload instead of reporting it empty', async () => {
		// A minimal but real GLB header: magic "glTF", version 2, total length.
		const payload = Buffer.alloc(2048, 7);
		payload.write('glTF', 0, 'ascii');
		payload.writeUInt32LE(2, 4);
		payload.writeUInt32LE(payload.length, 8);

		const out = await postBody('model/gltf-binary', payload);
		expect(out.complete, 'the request should be fully received before the read').toBe(true);
		expect(out.bytes).toBe(payload.length);
		expect(out.sha).toBe(payload.toString('hex').slice(0, 16));
	});

	it('still reconstructs bodies the express parsers did consume', async () => {
		const json = await postBody('application/json', Buffer.from('{"url":"https://example.com/a.glb"}'));
		expect(json.bytes).toBe(35);

		const raw = Buffer.alloc(512, 3);
		const octet = await postBody('application/octet-stream', raw);
		expect(octet.bytes).toBe(raw.length);
	});

	it('enforces the byte limit on an unparsed upload', async () => {
		const server = await bootServer(async (req, res) => {
			await new Promise((r) => setTimeout(r, 50));
			try {
				await readBody(req, 1024);
				res.json({ status: 'read' });
			} catch (err) {
				res.status(err.status || 500).json({ status: err.status });
			}
		});
		try {
			const { port } = server.address();
			const res = await fetch(`http://127.0.0.1:${port}/`, {
				method: 'POST',
				headers: { 'content-type': 'model/gltf-binary' },
				body: Buffer.alloc(64 * 1024, 1),
			});
			expect(res.status).toBe(413);
		} finally {
			await new Promise((r) => server.close(r));
		}
	});

	it('resolves empty rather than hanging when the stream was drained and discarded', async () => {
		// A prior middleware read the stream to its end and kept nothing. 'end'
		// has already fired, so new listeners can never see it.
		const drained = Readable.from([Buffer.from('gone')]);
		drained.resume();
		await new Promise((r) => drained.on('end', r));
		drained.headers = {};
		drained.complete = true;

		const buf = await readBody(drained, LIMIT);
		expect(buf.byteLength).toBe(0);
	});

	it('resolves empty rather than hanging on a destroyed stream', async () => {
		const destroyed = Readable.from([Buffer.from('gone')]);
		destroyed.destroy();
		destroyed.headers = {};

		const buf = await readBody(destroyed, LIMIT);
		expect(buf.byteLength).toBe(0);
	});
});
