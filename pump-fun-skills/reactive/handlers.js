// Closure — one instance per skill install (trusted-main-thread, loaded once).
let WS_URL = 'wss://pumpportal.fun/api/data';

// Test-only: override the WS endpoint without touching production code.
export function _setWsUrl(url) {
	WS_URL = url;
}

let _socket = null;
let _intervalId = null;
let _reconnectTimer = null;
let _reconnectAttempts = 0;
let _protocol = null;
let _buffer = [];
let _enabled = false;

const MAX_ATTEMPTS = 10;
const WINDOW_MS = 2000;

function _emit(type, payload) {
	_protocol?.emit({ type, payload, sourceSkill: 'pump-fun-reactive' });
}

function _flush() {
	const batch = _buffer.splice(0);

	const migration = batch.find((e) => e.txType === 'migrate');
	if (migration) {
		const name = migration.name || migration.mint?.slice(0, 6) || 'Token';
		_emit('gesture', { name: 'celebrate', duration: 1.5 });
		_emit('emote', { trigger: 'celebration', weight: 0.95 });
		_emit('speak', { text: `${name} graduated!`, sentiment: 0.9 });
		return;
	}

	const creates = batch.filter((e) => e.txType === 'create');

	// Check for big initial buy — supersedes count-based branch.
	const loudest = creates.reduce(
		(max, e) => (e.solAmount > (max?.solAmount ?? 0) ? e : max),
		null,
	);
	if (loudest && loudest.solAmount > 5) {
		const name = loudest.name || loudest.mint?.slice(0, 6) || 'Token';
		_emit('emote', { trigger: 'curiosity', weight: 0.9 });
		_emit('speak', {
			text: `${name} just opened with a ${loudest.solAmount.toFixed(2)} SOL buy.`,
			sentiment: 0.5,
		});
		return;
	}

	const count = creates.length;
	if (count === 0) {
		_emit('emote', { trigger: 'patience', weight: 0.4 });
	} else if (count <= 2) {
		_emit('emote', { trigger: 'curiosity', weight: 0.6 });
		_emit('look-at', { target: 'user' });
	} else if (count <= 9) {
		_emit('gesture', { name: 'wave', duration: 1.0 });
		_emit('emote', { trigger: 'curiosity', weight: 0.85 });
	} else {
		_emit('gesture', { name: 'wave', duration: 1.0 });
		_emit('emote', { trigger: 'celebration', weight: 0.7 });
		_emit('speak', {
			text: `Pump.fun is on fire — ${count} new launches in 2 seconds.`,
			sentiment: 0.6,
		});
	}
}

function _connect() {
	const ws = new WebSocket(WS_URL);
	_socket = ws;

	ws.addEventListener('open', () => {
		_reconnectAttempts = 0;
		ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
		ws.send(JSON.stringify({ method: 'subscribeMigration' }));
		// Start the flush interval only after the connection is open so the first
		// window begins after messages can actually arrive. Guard against restarts
		// on reconnect — the interval persists across dropped connections.
		if (_intervalId === null) {
			_intervalId = setInterval(_flush, WINDOW_MS);
		}
	});

	ws.addEventListener('message', (evt) => {
		try {
			_buffer.push(JSON.parse(evt.data));
		} catch {
			// malformed frame — ignore
		}
	});

	ws.addEventListener('close', () => {
		if (!_enabled) return; // disabled — don't reconnect
		_scheduleReconnect();
	});
}

function _scheduleReconnect() {
	if (_reconnectAttempts >= MAX_ATTEMPTS) return;
	const delay = Math.min(1000 * 2 ** _reconnectAttempts, 30_000);
	_reconnectAttempts++;
	_reconnectTimer = setTimeout(_connect, delay);
}

export async function enable_live_reactions(_args, ctx) {
	if (_enabled) {
		return { ok: true, already: true };
	}
	_enabled = true;
	_protocol = ctx.protocol;
	_buffer = [];
	_reconnectAttempts = 0;
	_connect();
	return { ok: true, started: true };
}

export async function disable_live_reactions(_args, _ctx) {
	if (_reconnectTimer !== null) {
		clearTimeout(_reconnectTimer);
		_reconnectTimer = null;
	}
	if (_socket !== null) {
		_socket.close();
		_socket = null;
	}
	if (_intervalId !== null) {
		clearInterval(_intervalId);
		_intervalId = null;
	}
	_buffer = [];
	_protocol = null;
	_enabled = false;
	return { ok: true, stopped: true };
}
