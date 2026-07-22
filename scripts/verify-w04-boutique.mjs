// Real end-to-end verification for W04's $THREE bridge (the boutique): a real
// Chromium browser against a real Vite dev server, a real, freshly-started
// Colyseus WalkRoom wired to real game-token.js settlement, and a real local
// Solana validator (the actual SVM + SPL-token program + RPC — see
// scripts/verify-w04-boutique-setup.mjs for why local instead of the
// public devnet faucet). Nothing here is simulated: a real ed25519 signature
// from a real Keypair, a real broadcast transaction, a real confirmed
// transaction the server re-reads from RPC before granting anything.
//
// The only test-only substitution is WHERE the wallet's signing key lives —
// this script holds the real secret (from the fixture) and signs on request,
// standing in for a browser extension the sandbox can't install. The actual
// cryptographic signature, broadcast, and on-chain settlement are 100% real
// and exercise the production code paths verbatim (boutique-purchase.js,
// WalkRoom._handleBoutiqueQuote/_handleBoutiqueSettle, game-token.js).
//
// Usage: node scripts/verify-w04-boutique-setup.mjs   (once, writes the fixture)
//        node scripts/verify-w04-boutique.mjs

import { chromium } from 'playwright';
import { Connection, Keypair, Transaction, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';

const SCRATCH = '/tmp/claude-1000/-workspaces-three-ws/3af649c2-981d-4e27-bcc7-a1b386bdb681/scratchpad';
const FIXTURE = JSON.parse(readFileSync(`${SCRATCH}/w04-boutique-fixture.json`, 'utf8'));

const BASE = 'http://localhost:3011';
const WS = 'ws://localhost:2592'; // the SECOND WalkRoom instance, wired to GAME_TOKEN_* + the local validator
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump'; // the /play coin world — unrelated to the boutique's own test mint
const URL = `${BASE}/play?coin=${THREE_MINT}&name=three.ws&symbol=three`;
const ITEM_ID = 'dye-gold'; // "Midas" — 250 $THREE, multiplayer/src/cosmetics-catalog.js

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }
function ok(msg) { console.log('OK:', msg); }

async function waitFor(page, fn, { timeout = 20000, interval = 300, label = 'condition', arg } = {}) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const v = await page.evaluate(fn, arg).catch(() => undefined);
		if (v) return v;
		await page.waitForTimeout(interval);
	}
	throw new Error(`timed out waiting for ${label}`);
}

function isBenignSandboxNoise(text) {
	return /favicon|WebGL.*SwiftShader|Autoplay|r2\.dev|\[vite\]|502 \(Bad Gateway\)|401 \(Unauthorized\)|402 \(Payment Required\)|GPU stall|GL Driver Message|app\.github\.dev|WebSocket closed without opened|deprecated parameters for the initialization function|AnimationManager.*failed to load|npc-zauth|429 \(Too Many Requests\)|ERR_CONNECTION_REFUSED|ERR_FAILED|agents\?limit/i.test(text);
}

async function main() {
	const buyerKeypair = Keypair.fromSecretKey(bs58.decode(FIXTURE.buyerSecret));
	console.log('--- buyer wallet:', buyerKeypair.publicKey.toBase58());

	// Pre-flight: read the buyer's REAL $THREE (test-mint) balance from the
	// local validator, straight from RPC — not the fixture file's memory.
	const conn = new Connection(FIXTURE.rpc, 'confirmed');
	const buyerAta = await getAssociatedTokenAddress(new PublicKey(FIXTURE.mint), buyerKeypair.publicKey);
	const preBalance = await conn.getTokenAccountBalance(buyerAta).catch(() => null);
	ok(`Buyer's real on-chain balance before purchase: ${preBalance?.value?.uiAmountString ?? '0'} test-$THREE (mint ${FIXTURE.mint})`);

	const treasuryAta = await getAssociatedTokenAddress(new PublicKey(FIXTURE.mint), new PublicKey(FIXTURE.treasuryPubkey));
	const treasuryBefore = await conn.getTokenAccountBalance(treasuryAta).catch(() => ({ value: { uiAmountString: '0' } }));
	ok(`Treasury's real on-chain balance before purchase: ${treasuryBefore?.value?.uiAmountString ?? '0'} test-$THREE`);

	const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
	const consoleIssues = [];
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	const page = await ctx.newPage();
	page.on('console', (msg) => {
		if (msg.type() === 'error' || msg.type() === 'warning') {
			const text = msg.text();
			if (isBenignSandboxNoise(text)) return;
			consoleIssues.push(`[${msg.type()}] ${text}`);
		}
	});
	page.on('pageerror', (err) => {
		if (isBenignSandboxNoise(err.message)) return;
		consoleIssues.push(`[pageerror] ${err.message}`);
	});

	// Real cryptographic signing, held in this Node process (standing in for a
	// browser wallet extension) — the injected in-page wallet calls out to this
	// exact function with the exact unsigned bytes the app built, and gets back
	// a REAL ed25519 signature from the REAL buyer Keypair. No signature is ever
	// fabricated or skipped.
	await page.exposeFunction('__w04NodeSign', async (unsignedB64) => {
		const raw = Buffer.from(unsignedB64, 'base64');
		const tx = Transaction.from(raw);
		tx.partialSign(buyerKeypair);
		return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
	});

	await page.addInitScript((vars) => {
		window.GAME_SERVER_URL = vars.ws;
		window.GAME_TOKEN_RPC_URL = vars.rpc; // boutique-purchase.js's test-only RPC override
		// A minimal Phantom-shaped wallet: detectSolanaWallet() in
		// src/erc8004/solana-deploy.js matches window.phantom.solana.isPhantom.
		// signTransaction hands the exact unsigned bytes to the real Node signer
		// above and returns a duck-typed "signed" object exposing only the one
		// method boutique-purchase.js actually calls: .serialize().
		window.phantom = {
			solana: {
				isPhantom: true,
				publicKey: { toString: () => vars.buyer, toBase58: () => vars.buyer },
				async connect() { return { publicKey: this.publicKey }; },
				async signTransaction(tx) {
					const unsignedBytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
					const unsignedB64 = btoa(String.fromCharCode(...unsignedBytes));
					const signedB64 = await window.__w04NodeSign(unsignedB64);
					const bin = atob(signedB64);
					const bytes = new Uint8Array(bin.length);
					for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
					return { serialize: () => bytes };
				},
			},
		};
	}, { ws: WS, rpc: FIXTURE.rpc, buyer: FIXTURE.buyerPubkey });

	console.log('--- navigating to', URL);
	await page.goto(URL, { waitUntil: 'domcontentloaded' });
	await waitFor(page, () => window.__CC__?.phase === 'world' && !!window.__CC__?.net?.sessionId, { timeout: 150000, label: 'joined world' });
	ok('Player joined the world on the boutique-wired WalkRoom (phase=world, connected)');

	await waitFor(page, () => !!window.__CC__?.playSystems?.profile, { timeout: 20000, label: 'initial profile' });
	const ownedBefore = await page.evaluate(() => window.__CC__.playSystems.cosmetics?.owned || []);
	ok(`Owned premium cosmetics before purchase: [${ownedBefore.join(', ') || 'none'}]`);
	if (ownedBefore.includes(ITEM_ID)) fail(`test item "${ITEM_ID}" is already owned by this account — pick a fresh buyer/account for a clean proof`);

	// Open the wardrobe (rail button) and find the real locked "Midas" card.
	await page.click('.ps-rail-btn[title="My Cosmetics"]');
	const cardFound = await waitFor(page, (id) => {
		const el = document.querySelector(`.ps-cos-card[aria-label^="Buy Midas"]`);
		return !!el;
	}, { timeout: 10000, label: 'locked Midas card rendered', arg: ITEM_ID });
	if (!cardFound) fail('the locked "Midas" boutique card never rendered in the wardrobe');
	else ok('Wardrobe open — the "Midas" card shows its real $THREE price and is clickable (not a dead end)');
	await page.screenshot({ path: `${SCRATCH}/w04-boutique-01-wardrobe.png` });

	await page.click('.ps-cos-card[aria-label^="Buy Midas"]');

	// Drive the real purchase: connect (already "connected" via our injected
	// wallet) → server prices the quote → real signature → real broadcast →
	// server re-verifies on-chain → grant. Watch the toast stream.
	const finalToast = await waitFor(page, () => {
		const t = document.querySelector('#cc-toast')?.textContent || '';
		return /unlocked|couldn.?t|didn.?t verify|already owned|error|failed/i.test(t) ? t : null;
	}, { timeout: 60000, label: 'purchase to resolve (toast)' });
	console.log('   final toast:', finalToast);
	if (!/unlocked/i.test(finalToast)) fail(`purchase did not resolve to an unlock — toast said: "${finalToast}"`);
	else ok(`Purchase resolved: "${finalToast}"`);

	await page.screenshot({ path: `${SCRATCH}/w04-boutique-02-result-toast.png` });

	const ownedAfter = await waitFor(page, (id) => {
		const owned = window.__CC__?.playSystems?.cosmetics?.owned || [];
		return owned.includes(id) ? owned : null;
	}, { timeout: 15000, label: 'server profile to reflect the new unlock', arg: ITEM_ID });
	if (!ownedAfter) fail('server profile never reflected the new unlock in cosmetics.owned');
	else ok(`Server-authoritative profile now owns: [${ownedAfter.join(', ')}]`);

	const cardNowOwned = await page.evaluate((id) => {
		const el = document.querySelector('.ps-cos-card[aria-label="Equip Midas"]');
		return !!el;
	}, ITEM_ID);
	if (!cardNowOwned) fail('the wardrobe card did not re-render as owned/equippable after the purchase');
	else ok('Wardrobe re-rendered the card as owned + equippable (real server round-trip, no optimistic fake state)');
	await page.screenshot({ path: `${SCRATCH}/w04-boutique-03-owned.png` });

	await browser.close();

	// --- Independently verify the on-chain settlement, straight from RPC -----
	const postBalance = await conn.getTokenAccountBalance(buyerAta).catch(() => null);
	const treasuryAfter = await conn.getTokenAccountBalance(treasuryAta).catch(() => ({ value: { uiAmountString: '0' } }));
	ok(`Buyer's real on-chain balance after purchase: ${postBalance?.value?.uiAmountString ?? '0'} test-$THREE`);
	ok(`Treasury's real on-chain balance after purchase: ${treasuryAfter?.value?.uiAmountString ?? '0'} test-$THREE`);
	const spent = Number(preBalance?.value?.uiAmountString || 0) - Number(postBalance?.value?.uiAmountString || 0);
	const received = Number(treasuryAfter?.value?.uiAmountString || 0) - Number(treasuryBefore?.value?.uiAmountString || 0);
	console.log(`   buyer spent ${spent} test-$THREE; treasury received ${received} test-$THREE (both legs land on the same wallet in this fixture — see setup script)`);
	if (!(spent >= 249.999 && spent <= 250.001)) fail(`expected the buyer to have spent exactly 250 test-$THREE (the Midas price), spent ${spent}`);
	else ok('On-chain delta matches the catalog price exactly — a real 250-token transfer landed, verified independently from RPC (not from the app UI).');

	console.log('\n--- console issues:', consoleIssues.length);
	for (const l of consoleIssues) console.log('   ', l);
	if (consoleIssues.length) fail('console errors/warnings were logged during the run');
}

main().catch((err) => { console.error('SCRIPT ERROR:', err); process.exitCode = 1; });
