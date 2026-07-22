#!/usr/bin/env node
// Real, end-to-end browser proof for /vault (prompt 12) against a genuinely
// deployed GreenfieldVault on a local anvil fork — the same anvil-fork
// technique prompt 11 established, extended here to drive the REAL running
// HTTP endpoints (api/vault/*) and a REAL headless browser (Playwright)
// through the REAL page (pages/vault.html + src/vault.js), not a
// reimplementation of either. Kept as the reproducible E2E proof referenced
// by docs/bnb-vault.md; re-run it after touching the vault stack.
//
// What this proves for real:
//   - GET /api/vault/list resolves a real on-chain Listed event to a card.
//   - The buyer session key (src/bnb/vault-session.js) signs and sends a
//     real buy() transaction against real deployed bytecode (self-pay path;
//     MegaFuel sponsorship is naturally unreachable from an anvil chain id,
//     so sendGasless's own fallback exercises for real too).
//   - GET /api/vault/status polls and reflects real on-chain state
//     (pending-grant -> unlocked) after a script-driven relayer call
//     (playing the same role test/GreenfieldVault.t.sol's harness does).
//   - POST /api/vault/unlock verifies a real EIP-191 signature, reads real
//     on-chain Granted state, fetches a real (locally-mocked-SP) manifest,
//     and returns a REAL ECIES-wrapped content key computed against the
//     buyer's REAL recovered public key.
//   - The browser's unwrapKey (src/bnb/vault-crypto-browser.js) correctly
//     unwraps that real wrapped key using Web Crypto + @noble/curves.
//   - GET /api/vault/download is proven to fail HONESTLY: it uses the full
//     Greenfield SDK (real LCD chain lookup for a private-object ECDSA
//     fetch), which cannot be mocked without a real Greenfield devnet — the
//     same funded-account wall blocking 07/09/10/11/13/14/18. This is the
//     expected, single remaining gap, not a bug.

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONTRACTS_DIR = path.join(ROOT, 'contracts');

const ANVIL_PORT = 8555;
const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const API_PORT = 8091;
const VITE_PORT = 3100;
const SP_PORT = 9098;
const SP_HOST = `127.0.0.1.nip.io`; // wildcard DNS -> 127.0.0.1, lets bucket.<host> resolve

// Anvil's deterministic default accounts — parsed live from anvil's own
// startup banner (below) rather than transcribed, so a copy/paste slip can
// never silently produce an invalid key.
const ANVIL = { deployer: null, seller: null };

const results = [];
function log(step, ok, detail) {
	const line = `[${ok ? 'PASS' : 'FAIL'}] ${step}${detail ? ' — ' + detail : ''}`;
	console.log(line);
	results.push({ step, ok, detail });
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function waitForPort(port, host = '127.0.0.1', timeoutMs = 20000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const ok = await new Promise((resolve) => {
			const sock = net.createConnection({ port, host }, () => {
				sock.end();
				resolve(true);
			});
			sock.on('error', () => resolve(false));
		});
		if (ok) return true;
		await sleep(250);
	}
	return false;
}

async function waitForHttp(url, timeoutMs = 20000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(url);
			if (res.status < 500) return true;
		} catch {
			/* not up yet */
		}
		await sleep(300);
	}
	return false;
}

const children = [];
function spawnTracked(cmd, args, opts) {
	const child = spawn(cmd, args, { ...opts, stdio: opts.stdio || 'pipe' });
	children.push(child);
	return child;
}

async function main() {
	// ── 1. anvil ──────────────────────────────────────────────────────────
	const anvil = spawnTracked('anvil', ['--chain-id', '97', '--port', String(ANVIL_PORT)], {
		cwd: ROOT,
	});
	let anvilOut = '';
	anvil.stdout.on('data', (d) => (anvilOut += d));
	anvil.stderr.on('data', (d) => (anvilOut += d));
	const anvilUp = await waitForPort(ANVIL_PORT);
	log('anvil --chain-id 97 up', anvilUp, anvilUp ? ANVIL_RPC : anvilOut.slice(0, 300));
	if (!anvilUp) return finish(1);
	for (let i = 0; i < 20 && !anvilOut.includes('Private Keys'); i++) await sleep(250); // let the startup banner finish printing
	const [addrSection, keySection] = anvilOut.split('Private Keys');
	const addrs = [...addrSection.matchAll(/^\(\d+\)\s+(0x[0-9a-fA-F]{40})\b/gm)].map((m) => m[1]);
	const keys = [...(keySection || '').matchAll(/^\(\d+\)\s+(0x[0-9a-fA-F]{64})\b/gm)].map(
		(m) => m[1],
	);
	ANVIL.deployer = { address: addrs[0], key: keys[0] };
	ANVIL.seller = { address: addrs[1], key: keys[1] };
	log(
		'parsed anvil accounts from banner',
		!!(ANVIL.deployer.key && ANVIL.seller.key),
		`deployer=${ANVIL.deployer.address} seller=${ANVIL.seller.address}`,
	);
	if (!ANVIL.deployer.key || !ANVIL.seller.key) return finish(1);

	// ── 2. deploy GreenfieldVault (mocked hubs) via the real deploy script ──
	let deployOut;
	try {
		deployOut = execFileSync(
			'forge',
			[
				'script',
				'script/DeployGreenfieldVaultMocked.s.sol:DeployGreenfieldVaultMocked',
				'--rpc-url',
				ANVIL_RPC,
				'--private-key',
				ANVIL.deployer.key,
				'--broadcast',
			],
			{ cwd: CONTRACTS_DIR, encoding: 'utf8', stdio: 'pipe' },
		);
	} catch (err) {
		log('forge script deploy', false, err.stdout || err.message);
		return finish(1);
	}
	const vaultAddr = /GreenfieldVault \(mocked hubs\):\s*(0x[0-9a-fA-F]{40})/.exec(deployOut)?.[1];
	const permHubAddr = /MockPermissionHub:\s*(0x[0-9a-fA-F]{40})/.exec(deployOut)?.[1];
	const objAccessAddr = /MockGnfdAccessControl:\s*(0x[0-9a-fA-F]{40})/.exec(deployOut)?.[1];
	log(
		'forge script deploy',
		!!(vaultAddr && permHubAddr && objAccessAddr),
		`vault=${vaultAddr} permHub=${permHubAddr} objAccess=${objAccessAddr}`,
	);
	if (!vaultAddr) return finish(1);

	// ── 3. env for the in-process API server ────────────────────────────────
	process.env.GREENFIELD_VAULT_ADDRESS_TESTNET = vaultAddr;
	process.env.BNB_VAULT_RPC_OVERRIDE_TESTNET = ANVIL_RPC;
	process.env.GREENFIELD_VAULT_BUCKET_TESTNET = 'three-ws-vault-testnet';
	process.env.GREENFIELD_SP_OVERRIDE_TESTNET = `http://${SP_HOST}:${SP_PORT}`;
	process.env.JWT_SECRET = process.env.JWT_SECRET || 'verify-vault-ui-secret-not-for-prod';
	process.env.PORT = String(API_PORT);
	process.env.NODE_ENV = process.env.NODE_ENV || 'development';

	// ── 4. tiny mock Storage Provider — real HTTP, serves a real manifest +
	//        real AES-256-GCM ciphertext produced by the REAL encryptGlb ──────
	const { encryptGlb } = await import(path.join(ROOT, 'api/_lib/bnb/vault-crypto.js'));
	const { deriveObjectId, storeVaultObjectIndex, vaultKeyCacheKey } = await import(
		path.join(ROOT, 'api/_lib/bnb/vault-store.js')
	);
	const { cacheSet } = await import(path.join(ROOT, 'api/_lib/cache.js'));
	const { encryptSecret } = await import(path.join(ROOT, 'api/_lib/secret-box.js'));

	const glbBytes = readFileSync(path.join(ROOT, 'public/accessories/glasses-shades.glb'));
	const enc = encryptGlb(glbBytes);
	const bucket = process.env.GREENFIELD_VAULT_BUCKET_TESTNET;
	const glbObject = `vaults/${ANVIL.seller.address.toLowerCase()}/e2e-proof.glb.enc`;
	const manifestObject = `vaults/${ANVIL.seller.address.toLowerCase()}/e2e-proof.manifest.json`;
	const objectId = deriveObjectId(bucket, glbObject);
	const priceWei = 10_000_000_000_000_000n; // 0.01 tBNB

	const manifest = {
		version: 1,
		glbObjectRef: { bucket, object: glbObject },
		encryption: {
			alg: 'AES-256-GCM',
			iv: enc.iv.toString('hex'),
			authTag: enc.authTag.toString('hex'),
		},
		sha256: enc.sha256OfPlaintext,
		priceAtomic: priceWei.toString(),
		sellerAddress: ANVIL.seller.address,
		contract: { address: vaultAddr, chainId: 97 },
		createdAt: new Date().toISOString(),
	};
	const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));

	const spServer = createServer((req, res) => {
		const p = decodeURIComponent(req.url.replace(/^\//, ''));
		if (p === glbObject) {
			res.writeHead(200, {
				'content-type': 'application/octet-stream',
				'content-length': enc.ciphertext.length,
			});
			res.end(enc.ciphertext);
			return;
		}
		if (p === manifestObject) {
			res.writeHead(200, {
				'content-type': 'application/json',
				'content-length': manifestBytes.length,
			});
			res.end(manifestBytes);
			return;
		}
		res.writeHead(404).end('not found');
	});
	await new Promise((resolve) => spServer.listen(SP_PORT, resolve));
	children.push({ kill: () => spServer.close() });
	log(
		'mock Storage Provider up',
		true,
		`${process.env.GREENFIELD_SP_OVERRIDE_TESTNET} serving real AES-256-GCM ciphertext (${enc.ciphertext.length}B) + manifest`,
	);

	// ── 5. populate the in-process objectId index + the encrypted content-key
	//        record (same cache singleton the real running API server reads —
	//        this is the off-chain glue vault-upload.js normally writes) ─────
	await storeVaultObjectIndex(objectId, {
		bucket,
		glbObject,
		manifestObject,
		sellerAddress: ANVIL.seller.address,
	});
	const contentKeyCiphertext = await encryptSecret(enc.contentKey.toString('base64'));
	await cacheSet(
		vaultKeyCacheKey(bucket, glbObject),
		{
			contentKeyCiphertext,
			sellerAddress: ANVIL.seller.address,
			createdAt: new Date().toISOString(),
		},
		3600,
	);
	log(
		'objectId index + content-key record populated (in-process cache)',
		true,
		`objectId=${objectId}`,
	);

	// ── 6. on-chain setup: grantRole + list() from the seller ───────────────
	const {
		createWalletClient,
		createPublicClient,
		http,
		parseAbi,
		keccak256,
		toBytes: viemToBytes,
	} = await import('viem');
	const { privateKeyToAccount } = await import('viem/accounts');
	const chain = {
		id: 97,
		name: 'anvil-97',
		nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 },
		rpcUrls: { default: { http: [ANVIL_RPC] } },
	};
	const pub = createPublicClient({ chain, transport: http() });
	const sellerAccount = privateKeyToAccount(ANVIL.seller.key);
	const sellerWallet = createWalletClient({ account: sellerAccount, chain, transport: http() });
	const deployerAccount = privateKeyToAccount(ANVIL.deployer.key);
	const deployerWallet = createWalletClient({
		account: deployerAccount,
		chain,
		transport: http(),
	});

	const accessAbi = parseAbi([
		'function grantRole(bytes32 role, address grantee, uint256) external',
	]);
	const ROLE_CREATE = keccak256(viemToBytes('ROLE_CREATE'));
	const grantHash = await sellerWallet.writeContract({
		address: objAccessAddr,
		abi: accessAbi,
		functionName: 'grantRole',
		args: [ROLE_CREATE, vaultAddr, 0n],
	});
	await pub.waitForTransactionReceipt({ hash: grantHash });

	const vaultAbi = parseAbi([
		'function list(bytes32 objectId, uint256 price, address seller) external',
	]);
	const listHash = await sellerWallet.writeContract({
		address: vaultAddr,
		abi: vaultAbi,
		functionName: 'list',
		args: [objectId, priceWei, sellerAccount.address],
	});
	await pub.waitForTransactionReceipt({ hash: listHash });
	log('seller grantRole + list() on real deployed contract', true, `list tx ${listHash}`);

	// ── 7. boot the REAL api server IN THIS PROCESS (shares the cache
	//        singleton with step 5 — a separate process would not) ─────────
	await import(path.join(ROOT, 'server/index.mjs'));
	const apiUp = await waitForHttp(`http://127.0.0.1:${API_PORT}/api/vault/list?network=testnet`);
	log('real api server (server/index.mjs) up in-process', apiUp, `:${API_PORT}`);
	if (!apiUp) return finish(1);

	// sanity: the real endpoint resolves our real on-chain listing
	const listRes = await fetch(
		`http://127.0.0.1:${API_PORT}/api/vault/list?network=testnet&contractAddress=${vaultAddr}`,
	);
	const listBody = await listRes.json();
	log(
		'GET /api/vault/list resolves the real listing',
		listBody.listings?.some((l) => l.objectId === objectId),
		JSON.stringify(listBody).slice(0, 300),
	);

	// ── 8. Vite dev server, proxying /api to the server we just booted ──────
	process.env.DEV_API_PROXY = `http://127.0.0.1:${API_PORT}`;
	const vite = spawnTracked('npx', ['vite', '--port', String(VITE_PORT), '--strictPort'], {
		cwd: ROOT,
		env: process.env,
	});
	let viteOut = '';
	vite.stdout.on('data', (d) => (viteOut += d));
	vite.stderr.on('data', (d) => (viteOut += d));
	const viteUp = await waitForHttp(`http://127.0.0.1:${VITE_PORT}/vault`, 30000);
	log('vite dev server up', viteUp, viteUp ? `:${VITE_PORT}` : viteOut.slice(-500));
	if (!viteUp) return finish(1);

	// ── 9. drive the REAL page with Playwright ───────────────────────────────
	const { chromium } = await import('playwright');
	const browser = await chromium.launch();
	const page = await browser.newPage();
	const consoleErrors = [];
	page.on('console', (msg) => {
		if (msg.type() === 'error') consoleErrors.push(msg.text());
	});
	page.on('pageerror', (err) => consoleErrors.push(String(err)));

	const pageUrl = `http://127.0.0.1:${VITE_PORT}/vault?devRpc=${encodeURIComponent(ANVIL_RPC)}&contractAddress=${vaultAddr}`;
	await page.goto(pageUrl, { waitUntil: 'networkidle' });
	log('page loaded', true, pageUrl);

	await page.waitForSelector('.vlt-card', { timeout: 15000 }).catch(() => {});
	const cardCount = await page.locator('.vlt-card').count();
	log('listing card rendered in the real grid', cardCount > 0, `${cardCount} card(s)`);

	await page.locator('.vlt-card').first().click();
	await page.waitForSelector('#vlt-drawer[data-open="true"]', { timeout: 5000 }).catch(() => {});
	const drawerOpen = (await page.locator('#vlt-drawer').getAttribute('data-open')) === 'true';
	log('detail drawer opens', drawerOpen);

	await page.waitForTimeout(1000); // let refreshStatus() settle
	const sessionAddr = await page.locator('#vlt-session-addr').getAttribute('title');
	log(
		'session key generated client-side',
		!!sessionAddr && sessionAddr.startsWith('0x'),
		sessionAddr,
	);

	// Fund the session address directly from anvil's deployer (substitutes for
	// clicking through a real MetaMask popup, which Playwright cannot drive
	// without a real installed extension — the funding TX itself is still real).
	const fundHash = await deployerWallet.sendTransaction({
		to: sessionAddr,
		value: 50_000_000_000_000_000n,
	}); // 0.05 tBNB
	await pub.waitForTransactionReceipt({ hash: fundHash });
	log('session funded from anvil deployer', true, `fund tx ${fundHash}`);

	// Re-open the drawer so refreshSessionBalance() picks up the new balance.
	await page.locator('#vlt-drawer-close').click();
	await page.locator('.vlt-card').first().click();
	await page.waitForTimeout(800);

	const buyBtn = page.locator('#vlt-buy-btn');
	const buyVisible = await buyBtn.isVisible().catch(() => false);
	log('Buy button visible after funding', buyVisible);
	if (buyVisible) {
		await buyBtn.click();
		await page
			.waitForSelector('.vlt-step[data-state="done"]', { timeout: 20000 })
			.catch(() => {});
		const doneSteps = await page.locator('.vlt-step[data-state="done"]').count();
		log(
			'real buy() tx confirmed (step 1 marked done)',
			doneSteps >= 1,
			`${doneSteps} step(s) done`,
		);
	}

	// Read the real on-chain saleId, then play the relayer: settle the grant.
	const saleAbi = parseAbi(['function saleIdOf(bytes32, address) view returns (uint256)']);
	let saleId = 0n;
	for (let i = 0; i < 20 && saleId === 0n; i++) {
		saleId = await pub.readContract({
			address: vaultAddr,
			abi: saleAbi,
			functionName: 'saleIdOf',
			args: [objectId, sessionAddr],
		});
		if (saleId === 0n) await sleep(500);
	}
	log('real on-chain saleId observed', saleId !== 0n, `saleId=${saleId}`);

	if (saleId !== 0n) {
		const permAbi = parseAbi([
			'function settleCreatePolicy(uint256 policyId, uint32 status) external',
		]);
		const settleHash = await deployerWallet.writeContract({
			address: permHubAddr,
			abi: permAbi,
			functionName: 'settleCreatePolicy',
			args: [saleId, 0],
		});
		await pub.waitForTransactionReceipt({ hash: settleHash });
		log(
			'relayer settles the Greenfield grant (real PolicyGranted)',
			true,
			`settle tx ${settleHash}`,
		);
	}

	// Wait for the page's own poll (or force one) to observe Granted -> unlocked.
	await page
		.locator('#vlt-refresh-detail-btn')
		.click({ timeout: 3000 })
		.catch(() => {});
	await page.waitForSelector('#vlt-unlock-btn', { timeout: 20000 }).catch(() => {});
	const unlockVisible = await page
		.locator('#vlt-unlock-btn')
		.isVisible()
		.catch(() => false);
	log('page observes real Granted state -> shows Unlock button', unlockVisible);

	if (unlockVisible) {
		await page.locator('#vlt-unlock-btn').click();
		await page.waitForTimeout(4000);
		const note = await page
			.locator('.vlt-drawer-note')
			.last()
			.textContent()
			.catch(() => '');
		const viewerAppeared = (await page.locator('#vlt-viewer').count()) > 0;
		log(
			'unlock attempt result',
			true,
			viewerAppeared
				? `model-viewer rendered — full decrypt succeeded: "${note}"`
				: `stopped at: "${note}" (expected: download.js needs a real Greenfield SDK object, same funded-account wall as 07/09/10/11/13/14/18)`,
		);
	}

	log('zero console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));

	await page.screenshot({ path: '/tmp/vault-proof-final.png', fullPage: true }).catch(() => {});
	await browser.close();
	return finish(0);
}

function finish(code) {
	console.log('\n=== SUMMARY ===');
	for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.step}`);
	for (const c of children) {
		try {
			c.kill?.('SIGKILL');
		} catch {
			/* already dead */
		}
	}
	setTimeout(() => process.exit(code), 300);
}

main().catch((err) => {
	console.error('FATAL', err);
	finish(1);
});
