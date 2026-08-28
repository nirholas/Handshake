// Two browser Solana subscriptions had no way to notice they were deaf.
//
// WalletMonitor rotated endpoints only from `onclose`, so a host that accepted
// the socket and then never answered the logsSubscribe left the monitor
// connected, silent and permanently blind: no error, no rotation, no trades. A
// rate-limited node holding a connection open does exactly that.
//
// watchWhaleTrades had the mirror-image problem. It builds its Connection on
// /api/solana-rpc, which is an HTTP-only proxy, so web3.js derived a wsEndpoint
// of wss://<origin>/api/solana-rpc that can never complete a subscribe. The
// feed looked like a quiet market forever.
//
// Both fixes are timing/rotation logic with no network in them, so both are
// pinned here.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A WebSocket stub whose lifecycle the test drives by hand.
class FakeSocket {
	constructor(url) {
		this.url = url;
		this.sent = [];
		this.closed = false;
		this.onopen = null;
		this.onmessage = null;
		this.onerror = null;
		this.onclose = null;
		FakeSocket.created.push(this);
	}
	send(data) { this.sent.push(data); }
	close() {
		if (this.closed) return;
		this.closed = true;
		// Real sockets deliver onclose asynchronously; mirror that so the code
		// under test is exercised the way a browser runs it.
		setTimeout(() => this.onclose?.(), 0);
	}
	/** Simulate the node answering the subscribe request. */
	confirmSubscription(id = 7) {
		this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: 1, result: id }) });
	}
}
FakeSocket.created = [];

describe('WalletMonitor rotates off a socket that never confirms its subscription', () => {
	let realWebSocket;

	beforeEach(() => {
		FakeSocket.created = [];
		realWebSocket = globalThis.WebSocket;
		globalThis.WebSocket = FakeSocket;
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		globalThis.WebSocket = realWebSocket;
	});

	it('opens the next endpoint when the subscribe is never answered', async () => {
		const { WalletMonitor } = await import('../src/pump/wallet-monitor.js');
		const mon = new WalletMonitor('Wa11etAddress1111111111111111111111111111');
		mon.start();

		expect(FakeSocket.created).toHaveLength(1);
		const first = FakeSocket.created[0];
		first.onopen();
		expect(first.sent).toHaveLength(1);
		expect(JSON.parse(first.sent[0]).method).toBe('logsSubscribe');

		// The node accepted the socket and then said nothing at all.
		await vi.advanceTimersByTimeAsync(20_000);

		expect(first.closed).toBe(true);
		expect(FakeSocket.created.length).toBeGreaterThan(1);
		expect(FakeSocket.created[1].url).not.toBe(first.url);
		mon.stop();
	});

	it('leaves a confirmed subscription alone once the deadline passes', async () => {
		const { WalletMonitor } = await import('../src/pump/wallet-monitor.js');
		const mon = new WalletMonitor('Wa11etAddress1111111111111111111111111111');
		mon.start();

		const first = FakeSocket.created[0];
		first.onopen();
		first.confirmSubscription();

		await vi.advanceTimersByTimeAsync(60_000);

		expect(first.closed).toBe(false);
		expect(FakeSocket.created).toHaveLength(1);
		mon.stop();
	});

	it('rotates only once per dead socket, never double-counting the endpoint', async () => {
		const { WalletMonitor } = await import('../src/pump/wallet-monitor.js');
		const mon = new WalletMonitor('Wa11etAddress1111111111111111111111111111');
		mon.start();

		FakeSocket.created[0].onopen();
		await vi.advanceTimersByTimeAsync(20_000);

		// The deadline closed the socket, and the resulting onclose must not
		// advance the endpoint a second time and skip a healthy host.
		const second = FakeSocket.created[1];
		expect(second.url).toBe('wss://solana-rpc.publicnode.com');
		mon.stop();
	});
});

describe('pickWsEndpoint finds a WS host that actually answers', () => {
	it('returns the first endpoint whose socket opens', async () => {
		const { pickWsEndpoint } = await import('../src/pump/pumpkit-whale.js');
		const attempted = [];
		const factory = (url) => {
			attempted.push(url);
			const sock = new FakeSocket(url);
			// The first host refuses; the second one answers.
			setTimeout(() => (attempted.length === 1 ? sock.onerror?.() : sock.onopen?.()), 0);
			return sock;
		};
		const picked = await pickWsEndpoint(['wss://dead.example', 'wss://live.example'], factory);
		expect(picked).toBe('wss://live.example');
		expect(attempted).toEqual(['wss://dead.example', 'wss://live.example']);
	});

	it('returns null when no endpoint answers, so the caller can say the feed is deaf', async () => {
		const { pickWsEndpoint } = await import('../src/pump/pumpkit-whale.js');
		const factory = (url) => {
			const sock = new FakeSocket(url);
			setTimeout(() => sock.onerror?.(), 0);
			return sock;
		};
		expect(await pickWsEndpoint(['wss://a.example', 'wss://b.example'], factory)).toBeNull();
	});

	it('treats a socket that throws on construction as a dead endpoint', async () => {
		const { pickWsEndpoint } = await import('../src/pump/pumpkit-whale.js');
		const factory = (url) => {
			if (url === 'wss://blocked.example') throw new Error('blocked by content security policy');
			const sock = new FakeSocket(url);
			setTimeout(() => sock.onopen?.(), 0);
			return sock;
		};
		expect(await pickWsEndpoint(['wss://blocked.example', 'wss://ok.example'], factory)).toBe('wss://ok.example');
	});
});
