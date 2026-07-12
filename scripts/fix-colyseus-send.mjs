// Patches colyseus.js's WebSocketTransport after install to guard send()
// against a socket that is closing or already closed.
//
// WebSocketTransport.send() forwards straight to `this.ws.send(data)` with no
// readyState check. Colyseus itself calls this from Room outbound messages
// (state acks, input, leave-cleanup) that can race a connection teardown —
// a room transition, a tab going to background, or the reconnect/backoff path
// in joinRoomWithTimeout (see src/shared/colyseus-connect.js) all close the
// socket out from under in-flight sends. The browser's native WebSocket.send()
// doesn't throw in that case, it just logs "WebSocket is already in CLOSING or
// CLOSED state." and drops the frame — a warning colyseus.js could avoid
// entirely since it already exposes an `isOpen` getter for exactly this check.
//
// We make send() a no-op when the socket isn't open, matching what already
// happens functionally (the frame is dropped either way) minus the console
// noise.
//
// Idempotent; runs from `postinstall` so it survives `npm ci`.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const repo = dirname(root);

const TARGETS = [
	'node_modules/colyseus.js/build/esm/transport/WebSocketTransport.mjs',
	'node_modules/colyseus.js/build/cjs/transport/WebSocketTransport.js',
	'node_modules/colyseus.js/lib/transport/WebSocketTransport.js',
];

const SEND_CALL = 'send(data) {\n        this.ws.send(data);\n    }';
const MARKER = 'this.ws.readyState === WebSocket.OPEN) this.ws.send(data);';

let patched = 0;
let skipped = 0;

for (const rel of TARGETS) {
	const file = join(repo, rel);
	if (!existsSync(file)) continue;

	let src = readFileSync(file, 'utf8');
	if (src.includes(MARKER)) {
		skipped++;
		continue;
	}
	if (!src.includes(SEND_CALL)) {
		console.warn(`[fix-colyseus-send] no match in ${rel} — colyseus.js internals may have changed`);
		continue;
	}

	src = src.replace(
		SEND_CALL,
		`send(data) {\n        if (${MARKER}\n    }`,
	);
	writeFileSync(file, src);
	patched++;
}

if (patched > 0) {
	console.log(`[fix-colyseus-send] guarded WebSocketTransport.send() in ${patched} file(s)`);
} else if (skipped > 0) {
	console.log('[fix-colyseus-send] already patched');
} else {
	console.log('[fix-colyseus-send] colyseus.js not installed, skipping');
}
