import { describe, it, expect, vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any top-level imports of the mocked modules.
// ---------------------------------------------------------------------------

vi.mock('../api/_lib/http.js', () => ({
	cors: () => false,
	method: () => true,
	json: (res, status, body) => {
		res.statusCode = status;
		res.body = body;
	},
	error: (res, status, code, msg) => {
		res.statusCode = status;
		res.body = { error: code, error_description: msg };
	},
	wrap: (fn) => fn,
}));

vi.mock('../src/kol/wallets.js', () => ({
	KOL_WALLETS: [
		{ address: 'FakeWallet1111', label: 'kol-alpha', tags: ['kol'] },
		{ address: 'FakeWallet2222', label: 'whale-desk', tags: ['whale'] },
	],
	isSmartMoney: (addr) => ['FakeWallet1111', 'FakeWallet2222'].includes(addr),
	getWalletMeta: (addr) =>
		addr === 'FakeWallet1111'
			? { address: 'FakeWallet1111', label: 'kol-alpha', tags: ['kol'] }
			: null,
}));

// ---------------------------------------------------------------------------
// Module under test (API handler)
// ---------------------------------------------------------------------------

const { default: tradesHandler } = await import('../api/kol/trades.js');

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function mockRes() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		getHeader(k) {
			return this.headers[k.toLowerCase()];
		},
		end(b) {
			try {
				this.body = JSON.parse(b);
			} catch {
				this.body = b;
			}
		},
	};
}

// ---------------------------------------------------------------------------
// API endpoint shape
// ---------------------------------------------------------------------------

// The platform's own coin, used as the fixture mint because the handler now
// requires a real base58 Solana address before it will fan out to the provider.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

describe('GET /api/kol/trades — endpoint shape', () => {
	it('responds 200 with { mint, trades, wallets } for a valid mint', async () => {
		const req = { headers: {}, method: 'GET', url: `/api/kol/trades?mint=${THREE_MINT}&limit=5` };
		const res = mockRes();
		await tradesHandler(req, res);

		expect(res.statusCode).toBe(200);
		expect(res.body).toMatchObject({
			mint: THREE_MINT,
			trades: expect.any(Array),
			wallets: 2,
		});
	});

	it('trades is an array', async () => {
		const req = { headers: {}, method: 'GET', url: `/api/kol/trades?mint=${THREE_MINT}` };
		const res = mockRes();
		await tradesHandler(req, res);

		expect(Array.isArray(res.body.trades)).toBe(true);
	});

	it('responds 400 when mint query param is missing', async () => {
		const req = { headers: {}, method: 'GET', url: '/api/kol/trades' };
		const res = mockRes();
		await tradesHandler(req, res);

		expect(res.statusCode).toBe(400);
		expect(res.body.error).toBe('validation_error');
	});

	it('responds 400 for a mint that cannot be a Solana address', async () => {
		const req = { headers: {}, method: 'GET', url: '/api/kol/trades?mint=NOT_A_MINT' };
		const res = mockRes();
		await tradesHandler(req, res);

		expect(res.statusCode).toBe(400);
		expect(res.body.error).toBe('validation_error');
		expect(res.body.error_description).toMatch(/base58/);
	});

	it('wallets count matches the KOL_WALLETS stub length', async () => {
		const req = { headers: {}, method: 'GET', url: `/api/kol/trades?mint=${THREE_MINT}` };
		const res = mockRes();
		await tradesHandler(req, res);

		expect(res.body.wallets).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Widget — renderTrades (pure function, no DOM needed)
// ---------------------------------------------------------------------------

const { renderTrades, mountKolTradesWidget } = await import('../src/widgets/kol-trades.js');

describe('renderTrades — pure HTML output', () => {
	it('returns empty-state markup when trades array is empty', () => {
		const html = renderTrades([]);
		expect(html).toContain('kol-trades-empty');
	});

	it('returns empty-state markup when trades is null', () => {
		const html = renderTrades(null);
		expect(html).toContain('kol-trades-empty');
	});

	it('renders a row for each trade', () => {
		const trades = [
			{
				time: new Date().toISOString(),
				side: 'buy',
				wallet: 'WALLETABC1234567890',
				usd: 500,
				source: 'kol',
			},
			{
				time: new Date().toISOString(),
				side: 'sell',
				wallet: 'WALLETXYZ9876543210',
				usd: 250,
				source: 'whale',
			},
		];
		const html = renderTrades(trades);
		expect(html).toContain('kol-trades-row');
		expect(html).toContain('Buy');
		expect(html).toContain('Sell');
		expect(html).toContain('WALLET'); // truncated wallet address
		expect(html).toContain('KOL');
		expect(html).toContain('Whale');
	});

	it('links wallet to Solscan', () => {
		const html = renderTrades([
			{ time: new Date().toISOString(), side: 'buy', wallet: 'SomePubKeyAddr', usd: 100, source: 'kol' },
		]);
		expect(html).toContain('solscan.io/account/SomePubKeyAddr');
	});

	it('escapes HTML in wallet address', () => {
		const html = renderTrades([
			{ time: new Date().toISOString(), side: 'buy', wallet: '<script>bad</script>', usd: 0, source: 'kol' },
		]);
		expect(html).not.toContain('<script>');
		expect(html).toContain('&lt;script&gt;');
	});
});

// ---------------------------------------------------------------------------
// Widget mount — polling + DOM integration (mocked fetch + minimal DOM stub)
// ---------------------------------------------------------------------------

class MockEl {
	constructor(doc) {
		this.children = [];
		this._html = '';
		this.className = '';
		this.textContent = '';
		this.style = { cssText: '' };
		this.ownerDocument = doc;
	}
	get innerHTML() {
		return this._html;
	}
	set innerHTML(v) {
		this._html = v;
	}
	appendChild(child) {
		this.children.push(child);
		return child;
	}
	remove() {}
}

function makeMockDoc() {
	const doc = {};
	doc.createElement = () => new MockEl(doc);
	doc.head = { appendChild() {} };
	return doc;
}

describe('mountKolTradesWidget — renders from mocked fetch', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete global.fetch;
	});

	it('calls /api/kol/trades with the correct mint and limit', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ mint: 'MINT_A', trades: [], wallets: 2 }),
		});

		const doc = makeMockDoc();
		const root = new MockEl(doc);
		root.ownerDocument = doc;

		const ctrl = mountKolTradesWidget(root, { mint: 'MINT_A', limit: 10, refreshMs: 60_000 });
		await new Promise((r) => setTimeout(r, 20));

		expect(global.fetch).toHaveBeenCalledWith(
			expect.stringContaining('mint=MINT_A'),
		);
		expect(global.fetch).toHaveBeenCalledWith(
			expect.stringContaining('limit=10'),
		);

		ctrl.destroy();
	});

	it('renders empty state when API returns no trades', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ mint: 'MINT_B', trades: [], wallets: 2 }),
		});

		const doc = makeMockDoc();
		const root = new MockEl(doc);
		root.ownerDocument = doc;

		const ctrl = mountKolTradesWidget(root, { mint: 'MINT_B', limit: 20, refreshMs: 60_000 });
		await new Promise((r) => setTimeout(r, 20));

		const container = root.children[0];
		expect(container.innerHTML).toContain('kol-trades-empty');

		ctrl.destroy();
	});

	it('renders trade rows when API returns trades', async () => {
		const trade = {
			time: new Date().toISOString(),
			side: 'buy',
			wallet: 'TESTWALLETADDR123456',
			usd: 1234,
			source: 'kol',
		};
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ mint: 'MINT_C', trades: [trade], wallets: 2 }),
		});

		const doc = makeMockDoc();
		const root = new MockEl(doc);
		root.ownerDocument = doc;

		const ctrl = mountKolTradesWidget(root, { mint: 'MINT_C', limit: 20, refreshMs: 60_000 });
		await new Promise((r) => setTimeout(r, 20));

		const container = root.children[0];
		expect(container.innerHTML).toContain('TESTWALLET');
		expect(container.innerHTML).toContain('Buy');

		ctrl.destroy();
	});

	it('does not throw on fetch failure', async () => {
		global.fetch = vi.fn().mockRejectedValue(new Error('network error'));

		const doc = makeMockDoc();
		const root = new MockEl(doc);
		root.ownerDocument = doc;

		const ctrl = mountKolTradesWidget(root, { mint: 'MINT_D', limit: 20, refreshMs: 60_000 });
		await expect(new Promise((r) => setTimeout(r, 20))).resolves.not.toThrow();

		ctrl.destroy();
	});

	it('destroy stops polling', async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ mint: 'MINT_E', trades: [], wallets: 2 }),
		});

		const doc = makeMockDoc();
		const root = new MockEl(doc);
		root.ownerDocument = doc;

		const ctrl = mountKolTradesWidget(root, { mint: 'MINT_E', limit: 20, refreshMs: 50 });
		await new Promise((r) => setTimeout(r, 20));
		const callsBefore = global.fetch.mock.calls.length;

		ctrl.destroy();
		await new Promise((r) => setTimeout(r, 120));
		// No additional calls after destroy
		expect(global.fetch.mock.calls.length).toBe(callsBefore);
	});
});
