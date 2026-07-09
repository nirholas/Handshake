/**
 * Launch Token Modal — Playwright e2e spec.
 *
 * Covers the platform's most important conversion path end to end: the four
 * steps of src/pump/launch-token-modal.js — details form → quote + bonding
 * curve → connect wallet → sign / broadcast / confirm → success share card.
 *
 * Fidelity rules (mirrors tests/e2e/galaxy.spec.js):
 *   • The REAL modal module is imported and driven — nothing about the flow is
 *     re-implemented in the test.
 *   • The launch-quote / launch-prep / launch-confirm endpoints and the Solana
 *     RPC proxy are fulfilled at the Playwright route layer with realistic
 *     payloads (Vite dev proxies /api/* to production, so we must intercept to
 *     stay deterministic and never touch a real chain). The client makes the
 *     real fetches; we assert prep + confirm actually fire with the right body.
 *   • The ONLY stubbed product-external surface is window.solana — an injected
 *     browser extension. Its signTransaction returns a serialized tx exactly
 *     like a real wallet would, so the broadcast path runs for real against the
 *     fulfilled RPC.
 *
 * The launch-prep transaction is a genuine, parseable @solana/web3.js legacy
 * Transaction built in Node — Transaction.from() in the modal deserializes it
 * for real.
 */

import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { Transaction, SystemProgram, Keypair } from '@solana/web3.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const LTM_CSS = resolve(repoRoot, 'src/pump/launch-token-modal.css');

// Deterministic synthetic identities — never a real wallet or a real mint.
const WALLET_ADDR = Keypair.generate().publicKey.toBase58();
const MINT_ADDR = '3wsLaunchE2eSyntheticMint1111111111111111111';
const TX_SIGNATURE = '5e2eLaunchSyntheticSig1111111111111111111111111111111111111111111111111111111111111111';

// A real legacy transaction the modal can deserialize with Transaction.from().
function buildPrepTxBase64() {
	const payer = Keypair.generate();
	const tx = new Transaction();
	tx.feePayer = payer.publicKey;
	tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
	tx.add(
		SystemProgram.transfer({
			fromPubkey: payer.publicKey,
			toPubkey: payer.publicKey,
			lamports: 1,
		}),
	);
	return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

const QUOTE_PAYLOAD = {
	fixed_total_sol: 0.0231,
	initial_buy: { sol: 0.5, protocol_fee_sol: 0.005, tokens_out: 12_500_000 },
	total_sol: 0.5281,
	cluster: 'mainnet',
};

// Install all route fixtures + the wallet stub. Returns a `calls` object the
// tests assert against so we can prove the real prep/confirm fetches fired.
async function installHarness(page, { quote = QUOTE_PAYLOAD } = {}) {
	const calls = { prep: null, confirm: null, broadcast: 0 };
	const txBase64 = buildPrepTxBase64();

	// Pre-accept the Risk Disclosure (public/risk-ack.js gates the sign step of
	// every money flow since 2026-07-03). This spec's subject is the launch flow,
	// not the disclosure dialog — seed the returning-user acceptance record the
	// module reads from localStorage.
	await page.addInitScript(() => {
		window.localStorage.setItem(
			'threews:risk-ack',
			JSON.stringify({ version: 1, acceptedAt: new Date().toISOString(), context: 'e2e' }),
		);
	});

	// Wallet extension stub — the one acceptable mock (external browser code).
	await page.addInitScript((addr) => {
		const pk = { toString: () => addr, toBase58: () => addr };
		window.solana = {
			isPhantom: true,
			isConnected: false,
			publicKey: null,
			async connect() {
				this.isConnected = true;
				this.publicKey = pk;
				return { publicKey: pk };
			},
			async disconnect() {
				this.isConnected = false;
				this.publicKey = null;
			},
			// Real wallets return a signed tx; the modal calls signed.serialize().
			async signTransaction(tx) {
				return { serialize: () => tx.serialize({ requireAllSignatures: false, verifySignatures: false }) };
			},
			on() {},
			removeListener() {},
		};
	}, WALLET_ADDR);

	// SOL price — keep it off the network so the modal's price hints are stable.
	await page.route('**/api.coingecko.com/**', (route) =>
		route.fulfill({ json: { solana: { usd: 150 } } }),
	);

	await page.route('**/api/agents/tokens/launch-quote**', (route) =>
		route.fulfill({ json: quote }),
	);

	await page.route('**/api/agents/tokens/launch-prep', async (route) => {
		calls.prep = JSON.parse(route.request().postData() || '{}');
		await route.fulfill({
			json: { prep_id: 'prep_e2e_1', mint: MINT_ADDR, cluster: 'mainnet', tx_base64: txBase64 },
		});
	});

	await page.route('**/api/agents/tokens/launch-confirm', async (route) => {
		calls.confirm = JSON.parse(route.request().postData() || '{}');
		await route.fulfill({ json: { agent: { token: { mint: MINT_ADDR } } } });
	});

	// Solana RPC proxy — answer JSON-RPC like a node. sendRawTransaction →
	// "sendTransaction" returns a signature; getLatestBlockhash for safety.
	await page.route('**/api/solana-rpc**', async (route) => {
		const body = JSON.parse(route.request().postData() || '{}');
		const reply = (result) =>
			route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result } });
		if (body.method === 'sendTransaction') {
			calls.broadcast += 1;
			return reply(TX_SIGNATURE);
		}
		if (body.method === 'getLatestBlockhash') {
			return reply({
				context: { slot: 1 },
				value: { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 },
			});
		}
		return reply(null);
	});

	// Minimal same-origin host page so the dev server still resolves /src/* module
	// imports and the relative /api/* fetches, without booting the heavy homepage.
	await page.route('**/__e2e/launch-harness', (route) =>
		route.fulfill({
			contentType: 'text/html',
			body: '<!doctype html><html><head><meta charset="utf-8"><title>launch harness</title></head><body></body></html>',
		}),
	);

	return calls;
}

// Open the real modal on the harness page and return once step 1 is painted.
async function openModal(page) {
	await page.goto('http://localhost:3000/__e2e/launch-harness');
	await page.addStyleTag({ path: LTM_CSS });
	await page.evaluate(async () => {
		const mod = await import('/src/pump/launch-token-modal.js');
		window.__ltm = mod.openLaunchTokenModal({
			agentId: 'agent-e2e-1',
			agentName: 'E2E Launch Agent',
			imageUrl: '',
		});
	});
	await expect(page.locator('#ltm-name')).toBeVisible({ timeout: 30_000 });
}

// Step 1 → fill valid details → Preview.
async function fillStep1(page, { name = 'E2E Launch Agent', symbol = 'E2EAG', buy = '0.5' } = {}) {
	await page.fill('#ltm-name', name);
	await page.fill('#ltm-sym', symbol);
	await page.fill('#ltm-buy', buy);
	await page.click('#ltm-s1-next');
}

// Step 2 → wait for the quote breakdown → Continue.
async function passStep2(page) {
	await expect(page.locator('#ltm-chart svg')).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('.ltm-quote-row').first()).toBeVisible({ timeout: 30_000 });
	const next = page.locator('#ltm-s2-next');
	await expect(next).toBeEnabled();
	await next.click();
}

// Step 3 → connect the stubbed wallet → enable Sign & Launch.
async function connectWallet(page) {
	await expect(page.locator('#ltm-connect')).toBeVisible();
	await page.click('#ltm-connect');
	await expect(page.locator('#ltm-ws')).toHaveText('Connected');
	await expect(page.locator('#ltm-launch')).toBeEnabled();
}

test.describe('Launch Token Modal — full flow', () => {
	test.beforeEach(async ({ page }) => {
		page.on('pageerror', (err) => {
			// Vite HMR socket noise on the forwarded Codespace port is not a product bug.
			if (/websocket|hmr|wss:|failed to connect/i.test(err.message)) return;
			throw new Error(`Page error: ${err.message}`);
		});
	});

	test('step 1 rejects a malformed symbol and stays on the form', async ({ page }) => {
		test.setTimeout(120_000);
		await installHarness(page);
		await openModal(page);

		// A non-alphanumeric symbol must be rejected inline; the flow does not advance.
		await page.fill('#ltm-name', 'E2E Launch Agent');
		await page.fill('#ltm-sym', 'A!');
		await page.click('#ltm-s1-next');

		await expect(page.locator('#ltm-sym-err')).toContainText('alphanumeric');
		await expect(page.locator('#ltm-sym')).toHaveClass(/ltm-err/);
		// Still on step 1 — the quote chart never mounted.
		await expect(page.locator('#ltm-chart')).toHaveCount(0);
	});

	test('step 2 renders the cost breakdown and bonding curve chart', async ({ page }) => {
		test.setTimeout(120_000);
		await installHarness(page);
		await openModal(page);
		await fillStep1(page);

		// Bonding curve SVG mounts.
		await expect(page.locator('#ltm-chart svg')).toBeVisible({ timeout: 30_000 });
		// Cost breakdown rows render with a final total.
		const rows = page.locator('.ltm-quote-row');
		await expect(rows.first()).toBeVisible();
		await expect(page.locator('.ltm-q-val.ltm-total')).toBeVisible();
		await expect(page.locator('#ltm-quote')).toContainText('Total SOL needed');
		// Dev-buy line from the quote payload is shown.
		await expect(page.locator('#ltm-quote')).toContainText('Dev buy');
	});

	test('step 3 connects the wallet and arms the launch button', async ({ page }) => {
		test.setTimeout(120_000);
		await installHarness(page);
		await openModal(page);
		await fillStep1(page);
		await passStep2(page);
		await connectWallet(page);

		// Connected address is shown truncated.
		await expect(page.locator('#ltm-wa')).toContainText('…');
	});

	test('step 4 signs, broadcasts, confirms and shows the share card', async ({ page }) => {
		test.setTimeout(120_000);
		const calls = await installHarness(page);
		await openModal(page);
		await fillStep1(page);
		await passStep2(page);
		await connectWallet(page);

		await page.click('#ltm-launch');

		// Success step renders.
		await expect(page.locator('.ltm-success-title')).toBeVisible({ timeout: 30_000 });
		// Mint chip shows the real returned mint.
		await expect(page.locator('#ltm-mint')).toHaveText(MINT_ADDR);
		// Share affordances are wired.
		await expect(page.locator('#ltm-copy-mint')).toBeVisible();
		await expect(page.locator('#ltm-share-x')).toBeVisible();
		// pump.fun link uses the mint (mainnet success card).
		await expect(page.locator('#ltm-pumpfun')).toHaveAttribute(
			'href',
			`https://pump.fun/coin/${MINT_ADDR}`,
		);
		// Share-card canvas drawn.
		await expect(page.locator('#ltm-share')).toBeVisible();

		// The REAL prep + confirm fetches fired with the expected body, and we
		// broadcast exactly once.
		expect(calls.prep).toMatchObject({
			agent_id: 'agent-e2e-1',
			provider: 'pumpfun',
			wallet_address: WALLET_ADDR,
			symbol: 'E2EAG',
		});
		expect(calls.broadcast).toBe(1);
		expect(calls.confirm).toMatchObject({
			prep_id: 'prep_e2e_1',
			tx_signature: TX_SIGNATURE,
			wallet_address: WALLET_ADDR,
		});
	});

	test('a broadcast failure shows specific, actionable copy', async ({ page }) => {
		test.setTimeout(120_000);
		await installHarness(page);
		// Make the RPC reject the send with an insufficient-funds program error.
		await page.route('**/api/solana-rpc**', (route) => {
			const body = JSON.parse(route.request().postData() || '{}');
			if (body.method === 'sendTransaction') {
				return route.fulfill({
					json: {
						jsonrpc: '2.0',
						id: body.id,
						error: { code: -32002, message: 'Transaction simulation failed: insufficient lamports 0, need 5281' },
					},
				});
			}
			return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: null } });
		});
		await openModal(page);
		await fillStep1(page);
		await passStep2(page);
		await connectWallet(page);
		await page.click('#ltm-launch');

		// No generic "Connection error" — the user is told to add SOL.
		await expect(page.locator('#ltm-msg.ltm-err')).toContainText('Not enough SOL', {
			timeout: 30_000,
		});
		// The flow recovered (button re-enabled), not stuck.
		await expect(page.locator('#ltm-launch')).toBeEnabled();
	});
});
