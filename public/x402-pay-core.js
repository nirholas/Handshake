// x402-pay-core.js — browser-native wallet payment core for the three.ws paywall.
//
// The full-page paywall (paywall.html / paywall.js) lists wallet buttons but
// historically dead-ended on click. This module performs the real x402 payment
// flow, driving each wallet button from connect → sign → settle → unlock with
// no fake progress. It mirrors the proven flow already shipped in the drop-in
// modal (public/x402.js): Solana wallets sign a server-prepared SPL transfer
// (via /api/x402-checkout), EVM wallets sign EIP-3009 transferWithAuthorization
// typed data locally. The signed payload is base64-encoded into the X-PAYMENT
// header, the original gated resource is retried, and the unlocked content +
// settlement receipt are returned to the caller.
//
// Loaded as a native ES module (`<script type="module">`); it attaches
// `window.PaywallWallet` for the classic paywall.js controller, and exports its
// pure helpers as named exports so the payment-building logic is unit-testable
// without a browser or a wallet.

// ──────────────────────────────────────────────────────── network helpers ────

// USDC EIP-3009 typed-data domains, keyed by CAIP-2 network id. `version` must
// match the deployed USDC implementation's EIP712 domain version — Base USDC is
// at "2"; signing with the wrong version yields a domain hash the facilitator
// rejects.
export const EVM_NETWORKS = {
	'eip155:8453': { chainId: 8453, name: 'Base', explorer: 'https://basescan.org/tx/' },
	'eip155:84532': {
		chainId: 84532,
		name: 'Base Sepolia',
		explorer: 'https://sepolia.basescan.org/tx/',
	},
	'eip155:42161': { chainId: 42161, name: 'Arbitrum', explorer: 'https://arbiscan.io/tx/' },
	'eip155:10': { chainId: 10, name: 'Optimism', explorer: 'https://optimistic.etherscan.io/tx/' },
};

export function isSolanaNetwork(net) {
	return typeof net === 'string' && (net === 'solana' || net.startsWith('solana:'));
}

export function isEvmNetwork(net) {
	return typeof net === 'string' && net.startsWith('eip155:');
}

// The paywall only signs EIP-3009 transferWithAuthorization for EVM. When the
// server publishes both an EIP-3009 entry and a Permit2 sibling (the
// gas-sponsoring path used by SDK clients), pick the EIP-3009 one — signing
// typed-data against the Permit2 entry builds a payload the facilitator rejects.
export function isEip3009Accept(accept) {
	if (!isEvmNetwork(accept?.network)) return false;
	const m = accept?.extra?.assetTransferMethod;
	return !m || m === 'eip3009';
}

export function explorerUrl(network, tx) {
	if (!tx) return null;
	if (isSolanaNetwork(network)) return `https://solscan.io/tx/${tx}`;
	const meta = EVM_NETWORKS[network];
	return meta ? `${meta.explorer}${tx}` : null;
}

// The x402 spec's canonical atomic-price field is `maxAmountRequired`; our
// server (and many merchants) emit `amount`. We read `amount` everywhere
// downstream, so coerce once at ingestion.
export function normalizeAccept(accept) {
	if (!accept || typeof accept !== 'object') return accept;
	const amount = accept.amount ?? accept.maxAmountRequired;
	return amount != null && accept.amount == null ? { ...accept, amount: String(amount) } : accept;
}

// Resolve the absolute URL of the gated resource to retry after payment. Each
// 402 `accept` entry carries the resource URL server-side; fall back to the
// paywall's `?return=` URL (made absolute) when it doesn't.
export function resolveResourceUrl(accept, fallbackUrl, origin) {
	const base = origin || (typeof location !== 'undefined' ? location.origin : 'https://three.ws');
	const candidate = accept?.resource || fallbackUrl || '/';
	try {
		return new URL(candidate, base).href;
	} catch {
		return new URL('/', base).href;
	}
}

// ─────────────────────────────────────────────────────────── encoding ────────

export function b64encode(obj) {
	const json = JSON.stringify(obj);
	if (typeof Buffer !== 'undefined') return Buffer.from(json, 'utf8').toString('base64');
	return btoa(unescape(encodeURIComponent(json)));
}

export function b64decode(str) {
	if (!str) return null;
	try {
		const bin =
			typeof Buffer !== 'undefined'
				? Buffer.from(str, 'base64').toString('utf8')
				: decodeURIComponent(escape(atob(str)));
		return JSON.parse(bin);
	} catch {
		return null;
	}
}

export function base64ToUint8Array(b64) {
	if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
	const bin = atob(b64);
	const arr = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
	return arr;
}

export function uint8ArrayToBase64(arr) {
	if (typeof Buffer !== 'undefined') return Buffer.from(arr).toString('base64');
	let bin = '';
	for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
	return btoa(bin);
}

export function randomHex(bytes) {
	const arr = new Uint8Array(bytes);
	(globalThis.crypto || crypto).getRandomValues(arr);
	return Array.from(arr)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

export function friendlyError(err) {
	const msg = err?.shortMessage || err?.message || String(err);
	if (/user rejected|user denied|reject|cancell?ed/i.test(msg)) return 'Cancelled in wallet';
	return msg.slice(0, 240);
}

// ───────────────────────────────────────────── pre-flight balance guard ───────
//
// The balance check is a UX guard, NOT a security gate: it spares the buyer from
// signing a transaction that can only fail at settle with an opaque error, and
// lets the UI offer "add funds" instead. It is deliberately fail-open — when the
// balance can't be read (flaky RPC, provider quirk) it returns null and the
// payment proceeds exactly as before. Only a POSITIVE shortfall blocks signing.

// Render an atomic token amount as a trimmed decimal string (BigInt-safe — token
// amounts can exceed Number's safe integer range).
export function formatTokenAmount(atomic, decimals = 6) {
	const neg = BigInt(atomic) < 0n;
	const abs = neg ? -BigInt(atomic) : BigInt(atomic);
	const base = 10n ** BigInt(decimals);
	const whole = abs / base;
	const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
	return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

// Structured insufficient-funds error so the UI can render an actionable state
// (required / current / shortfall + an add-funds CTA) instead of a raw string.
export function insufficientFundsError({ required, balance, accept }) {
	const decimals = Number(accept?.extra?.decimals ?? 6);
	const symbol = accept?.extra?.name || 'USDC';
	const req = BigInt(required);
	const bal = BigInt(balance);
	const shortfall = req > bal ? req - bal : 0n;
	const err = new Error(
		`Not enough ${symbol} — you need ${formatTokenAmount(req, decimals)} ${symbol} but your wallet holds ${formatTokenAmount(bal, decimals)} ${symbol}.`,
	);
	err.code = 'insufficient_funds';
	err.insufficient = {
		symbol,
		decimals,
		network: accept?.network || null,
		asset: accept?.asset || null,
		required: req.toString(),
		requiredFormatted: formatTokenAmount(req, decimals),
		balance: bal.toString(),
		balanceFormatted: formatTokenAmount(bal, decimals),
		shortfall: shortfall.toString(),
		shortfallFormatted: formatTokenAmount(shortfall, decimals),
	};
	return err;
}

// RPC endpoint for the Solana balance read. Overridable via meta tag / global so
// a deployment can point at its own (Helius) RPC instead of the rate-limited
// public one; mirrors the WalletConnect project-id resolution.
function solanaRpcUrl() {
	if (typeof document !== 'undefined') {
		const meta = document.querySelector('meta[name="solana-rpc-url"]');
		if (meta?.content) return meta.content;
	}
	if (typeof window !== 'undefined' && window.SOLANA_RPC_URL) return window.SOLANA_RPC_URL;
	// Last resort: the /api/solana-rpc proxy co-deployed with this script, which
	// fails over across Helius → Alchemy → dRPC → five keyless public lanes, so the
	// balance read survives any single provider (an expired Helius plan included)
	// being down. Resolved from this module's own serving origin, NOT a hardcoded
	// host: as a third-party embed the script is loaded from three.ws (resolves to
	// three.ws); as the first-party app on a preview/dev/tunnel origin it resolves
	// same-origin, so the read never trips that origin's CORS allowlist.
	return scriptOrigin() + '/api/solana-rpc';
}

// Origin that served this module — where its same-deployment /api proxy lives.
function scriptOrigin() {
	try {
		const o = new URL(import.meta.url).origin;
		if (o && o !== 'null') return o;
	} catch {}
	if (typeof location !== 'undefined' && location.origin && location.origin !== 'null') {
		return location.origin;
	}
	return 'https://three.ws';
}

// Sum the owner's SPL balance for `mint`. Returns a BigInt of atomic units, or
// null when the read fails (→ caller proceeds without blocking).
export async function readSolanaTokenBalance({ owner, mint, rpcUrl }) {
	try {
		const res = await fetch(rpcUrl || solanaRpcUrl(), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'getTokenAccountsByOwner',
				params: [owner, { mint }, { encoding: 'jsonParsed' }],
			}),
		});
		if (!res.ok) return null;
		const data = await res.json();
		const accounts = data?.result?.value || [];
		let total = 0n;
		for (const acc of accounts) {
			const amt = acc?.account?.data?.parsed?.info?.tokenAmount?.amount;
			if (amt != null) total += BigInt(amt);
		}
		return total;
	} catch {
		return null;
	}
}

// ERC-20 balanceOf(owner) calldata: selector 0x70a08231 + 32-byte left-padded owner.
export function erc20BalanceOfCalldata(owner) {
	return '0x70a08231' + String(owner).toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

// Read an ERC-20 balance via the connected wallet provider (it IS the RPC for the
// current chain — no external endpoint needed). Returns a BigInt, or null on failure.
export async function readEvmTokenBalance({ provider, token, owner }) {
	try {
		const hex = await provider.request({
			method: 'eth_call',
			params: [{ to: token, data: erc20BalanceOfCalldata(owner) }, 'latest'],
		});
		if (!hex || hex === '0x') return null;
		return BigInt(hex);
	} catch {
		return null;
	}
}

// Throw insufficientFundsError ONLY when a balance was positively read and falls
// short of accept.amount. A null read (inconclusive) never blocks the payment.
export async function assertSufficientBalance({ accept, owner, provider, rpcUrl }) {
	const required = BigInt(accept.amount);
	let balance = null;
	if (isSolanaNetwork(accept.network)) {
		balance = await readSolanaTokenBalance({ owner, mint: accept.asset, rpcUrl });
	} else if (isEvmNetwork(accept.network) && provider) {
		balance = await readEvmTokenBalance({ provider, token: accept.asset, owner });
	}
	if (balance !== null && balance < required) {
		throw insufficientFundsError({ required, balance, accept });
	}
	return balance;
}

// ──────────────────────────────────────────── payment payload builders ────────

// Body for POST /api/x402-checkout?action=prepare. The server returns a
// partially-signed v0 SPL transfer for the buyer's wallet to co-sign.
export function buildPrepareBody(accept, buyer) {
	return { accept: normalizeAccept(accept), buyer };
}

// EIP-3009 transferWithAuthorization typed data for an EVM USDC payment.
// `nowSeconds` is injectable so the build is deterministic under test.
export function buildEip3009TypedData({ accept, payerAddress, chainId, nowSeconds, nonce }) {
	const now = nowSeconds != null ? nowSeconds : Math.floor(Date.now() / 1000);
	const validAfter = 0;
	const validBefore = now + (accept.maxTimeoutSeconds || 600);
	const authNonce = nonce || '0x' + randomHex(32);
	const domain = {
		name: accept.extra?.name || 'USD Coin',
		version: accept.extra?.version || '2',
		chainId,
		verifyingContract: accept.asset,
	};
	const types = {
		EIP712Domain: [
			{ name: 'name', type: 'string' },
			{ name: 'version', type: 'string' },
			{ name: 'chainId', type: 'uint256' },
			{ name: 'verifyingContract', type: 'address' },
		],
		TransferWithAuthorization: [
			{ name: 'from', type: 'address' },
			{ name: 'to', type: 'address' },
			{ name: 'value', type: 'uint256' },
			{ name: 'validAfter', type: 'uint256' },
			{ name: 'validBefore', type: 'uint256' },
			{ name: 'nonce', type: 'bytes32' },
		],
	};
	const message = {
		from: payerAddress,
		to: accept.payTo,
		value: accept.amount,
		validAfter,
		validBefore,
		nonce: authNonce,
	};
	return {
		typedData: { primaryType: 'TransferWithAuthorization', types, domain, message },
		authorization: {
			from: payerAddress,
			to: accept.payTo,
			value: accept.amount,
			// CDP facilitator /verify requires the EIP-3009 time bounds as decimal
			// strings, not JSON numbers — a numeric validAfter/validBefore is
			// rejected with "'paymentPayload' is invalid". The signature is
			// unaffected: uint256 0 and "0" encode to the same 32 bytes.
			validAfter: String(validAfter),
			validBefore: String(validBefore),
			nonce: authNonce,
		},
	};
}

// Assemble the x402 PaymentPayload for an EVM EIP-3009 signature.
export function buildEvmPaymentPayload({ accept, signature, authorization, resourceUrl }) {
	return {
		x402Version: 2,
		scheme: 'exact',
		network: accept.network,
		resource: { url: resourceUrl, mimeType: 'application/json' },
		accepted: accept,
		payload: { signature, authorization },
	};
}

// ──────────────────────────────────────────────────── runtime dependencies ────

let _solanaWeb3 = null;
async function loadSolanaWeb3() {
	if (_solanaWeb3) return _solanaWeb3;
	// Dynamic import keeps the paywall tiny: web3.js is only fetched when a
	// Solana payment is actually attempted. The shared loader tries esm.sh, then
	// jsdelivr and unpkg for the same version, each under a deadline, and throws
	// a typed error naming the hosts when all three are blocked.
	const { loadModule } = await import('./load-module.js');
	try {
		_solanaWeb3 = await loadModule('https://esm.sh/@solana/web3.js@1.95.3?bundle');
	} catch (err) {
		if (err?.code === 'module_unavailable') {
			throw new Error(
				'The Solana wallet component could not be loaded (' + err.hosts.join(', ') + ' unreachable or blocked by this page\'s security policy). Pay with a Base wallet instead; that path needs no third-party code.',
			);
		}
		throw err;
	}
	return _solanaWeb3;
}

async function postJson(url, body) {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		data = { error: 'parse_error', error_description: text.slice(0, 200) };
	}
	if (!res.ok) {
		const err = new Error(data.error_description || data.error || `HTTP ${res.status}`);
		err.status = res.status;
		err.data = data;
		throw err;
	}
	return data;
}

// ───────────────────────────────────────────────────── provider detection ────

export function getSolanaProvider(walletName) {
	if (typeof window === 'undefined') return null;
	if (walletName === 'solflare') {
		// Solflare injects window.solflare; some builds also flag window.solana.
		if (window.solflare?.isSolflare || window.solflare) return window.solflare;
		if (window.solana?.isSolflare) return window.solana;
		return null;
	}
	// Phantom (default Solana wallet).
	if (window.phantom?.solana) return window.phantom.solana;
	if (window.solana?.isPhantom) return window.solana;
	return window.solana || null;
}

// Pick the injected EVM provider matching the requested wallet. EIP-6963 / legacy
// multi-provider environments expose siblings under window.ethereum.providers.
export function getEvmProvider(walletName) {
	if (typeof window === 'undefined') return null;
	const eth = window.ethereum;
	if (!eth) return null;
	const list = Array.isArray(eth.providers) && eth.providers.length ? eth.providers : [eth];
	const pick = (pred) => list.find(pred);
	if (walletName === 'coinbase') {
		return (
			pick((p) => p.isCoinbaseWallet) ||
			window.coinbaseWalletExtension ||
			(eth.isCoinbaseWallet ? eth : null)
		);
	}
	if (walletName === 'metamask') {
		return pick((p) => p.isMetaMask && !p.isCoinbaseWallet) || (eth.isMetaMask ? eth : null);
	}
	// Generic injected fallback.
	return eth;
}

const WALLET_LABELS = {
	phantom: 'Phantom',
	solflare: 'Solflare',
	metamask: 'MetaMask',
	coinbase: 'Coinbase Wallet',
	walletconnect: 'WalletConnect',
};

function walletNotFound(walletName) {
	const label = WALLET_LABELS[walletName] || 'Wallet';
	const err = new Error(
		`${label} not detected. Install the ${label} extension, then reload this page.`,
	);
	err.code = 'wallet_not_found';
	return err;
}

// ──────────────────────────────────────────────────────────────── mobile ──────

// Mobile browsers have no injected wallet extension — the wallet app instead
// reopens the page inside its own in-app browser (where the provider IS
// injected) via a universal link. Detect the mobile case so we deep-link the
// user into their wallet instead of telling them to "install the extension",
// which is meaningless on a phone. `ua` is injectable so this is unit-testable.
export function isMobileBrowser(ua) {
	const s = ua != null ? ua : typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
	return /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|BlackBerry|Opera Mini|IEMobile/i.test(s);
}

// Universal/deep link that reopens `targetUrl` inside the wallet's in-app
// browser. The paywall passes its own page URL so the gated request (carried in
// `?req=`/`?return=`) is preserved and payment completes after the redirect.
export function walletDeeplink(walletName, targetUrl, ref) {
	if (!targetUrl) return null;
	const enc = encodeURIComponent(targetUrl);
	const refQ = ref ? `?ref=${encodeURIComponent(ref)}` : '';
	switch (walletName) {
		case 'phantom':
			return `https://phantom.app/ul/browse/${enc}${refQ}`;
		case 'solflare':
			return `https://solflare.com/ul/v1/browse/${enc}${refQ}`;
		case 'coinbase':
			return `https://go.cb-w.com/dapp?cb_url=${enc}`;
		case 'metamask':
			try {
				const u = new URL(targetUrl);
				return `https://metamask.app.link/dapp/${u.host}${u.pathname}${u.search}`;
			} catch {
				return `https://metamask.app.link/dapp/${enc}`;
			}
		default:
			return null; // WalletConnect already handles mobile via its own modal.
	}
}

// On mobile with no injected provider, navigate to the wallet's in-app browser.
// Returns true if a redirect was initiated (the caller should then stop, since
// the page is unloading). Side-effecting + window-guarded; the pure pieces above
// are what tests exercise.
function initiateMobileRedirect(walletName, label, onStatus) {
	if (typeof window === 'undefined' || !isMobileBrowser()) return false;
	const link = walletDeeplink(walletName, window.location.href, window.location.origin);
	if (!link) return false;
	onStatus?.('connecting', `Opening ${label}…`);
	window.location.href = link;
	return true;
}

// Thrown after a mobile redirect is initiated so the controller can distinguish
// "navigating to the wallet app" from a real failure and suppress the error UI.
function mobileRedirectError() {
	const err = new Error('Opening your wallet app…');
	err.code = 'mobile_redirect';
	return err;
}

// ─────────────────────────────────────────────────────── settle + retry ──────

// Retry the gated resource with the X-PAYMENT proof and return the unlocked
// content plus the decoded settlement receipt.
//
// `request` lets a caller replay a resource that is not a plain GET. A paid
// POST route (the Endpoint Shopper takes its task and budget in a JSON body)
// answers a bodyless GET with a 405, so the buyer would settle on-chain and
// then get nothing back. Callers pass { method, body, headers } to replay the
// exact request that earned the 402. Default stays GET for the paywall page.
async function executePaid({ xPayment, resourceUrl, onStatus, accept, payerAddress, request }) {
	onStatus?.('confirming', 'Unlocking content…');
	const method = String(request?.method || 'GET').toUpperCase();
	const init = {
		method,
		headers: { 'X-PAYMENT': xPayment, Accept: '*/*', ...(request?.headers || {}) },
	};
	if (request?.body != null && method !== 'GET' && method !== 'HEAD') init.body = request.body;
	const res = await fetch(resourceUrl, init);
	const ct = res.headers.get('content-type') || '';
	const text = await res.text();
	let result;
	if (ct.includes('json')) {
		try {
			result = JSON.parse(text);
		} catch {
			result = text;
		}
	} else {
		result = text;
	}
	if (!res.ok) {
		const msg =
			(result && typeof result === 'object' && (result.error_description || result.error)) ||
			`HTTP ${res.status}`;
		throw new Error(msg);
	}
	const payment = b64decode(res.headers.get('x-payment-response')) || {};
	onStatus?.('done', 'Unlocked');
	return {
		ok: true,
		result,
		payment,
		contentType: ct,
		status: res.status,
		network: payment.network || accept?.network || null,
		payer: payment.payer || payerAddress || null,
		transaction: payment.transaction || null,
	};
}

// ────────────────────────────────────────────────────────────── Solana pay ───

export async function paySolana({ accept, resourceUrl, walletName, onStatus, origin, request }) {
	accept = normalizeAccept(accept);
	const apiOrigin = origin || (typeof location !== 'undefined' ? location.origin : '');
	const label = walletName === 'solflare' ? 'Solflare' : 'Phantom';
	const provider = getSolanaProvider(walletName);
	if (!provider || typeof provider.connect !== 'function') {
		if (initiateMobileRedirect(walletName, label, onStatus)) throw mobileRedirectError();
		throw walletNotFound(walletName);
	}

	onStatus?.('connecting', `Opening ${label}…`);
	const conn = await provider.connect();
	const payerAddress = (conn?.publicKey || provider.publicKey)?.toString();
	if (!payerAddress) throw new Error(`${label} did not return a public key`);

	// Pre-flight: don't make the buyer sign a doomed transaction (fail-open).
	onStatus?.('building', 'Checking your balance…');
	await assertSufficientBalance({ accept, owner: payerAddress });

	onStatus?.('building', 'Building payment…');
	const prep = await postJson(
		`${apiOrigin}/api/x402-checkout?action=prepare`,
		buildPrepareBody(accept, payerAddress),
	);

	onStatus?.('signing', `Approve the payment in ${label}…`);
	const txBytes = base64ToUint8Array(prep.tx_base64);
	const web3 = await loadSolanaWeb3();
	const tx = web3.VersionedTransaction.deserialize(txBytes);
	// The wallet adds the buyer's signature; the facilitator's fee-payer signature
	// is added during /settle.
	const signed = await provider.signTransaction(tx);
	const signedB64 = uint8ArrayToBase64(signed.serialize());

	onStatus?.('confirming', 'Settling on-chain…');
	const enc = await postJson(`${apiOrigin}/api/x402-checkout?action=encode`, {
		accept,
		signed_tx_base64: signedB64,
		resource_url: resourceUrl,
	});

	return executePaid({ xPayment: enc.x_payment, resourceUrl, onStatus, accept, payerAddress, request });
}

// ───────────────────────────────────────────────────────────────── EVM pay ───

async function resolveEvmProvider(walletName, onStatus) {
	if (walletName === 'walletconnect') {
		const projectId = getWcProjectId();
		if (!projectId) {
			const err = new Error(
				'WalletConnect is not configured here. Use MetaMask or Coinbase Wallet, or pay with a Solana wallet.',
			);
			err.code = 'wc_unconfigured';
			throw err;
		}
		onStatus?.('connecting', 'Opening WalletConnect…');
		// WalletConnect glue is a public/ runtime asset, not a bundled module.
		// Keep the specifier non-static (+ @vite-ignore) so Vite's import-analysis
		// doesn't try to resolve a /public path at build/test time; the browser
		// loads it from the served URL at runtime only.
		const wcProviderUrl = '/wallet/wc-provider.js';
		const { initWCProvider } = await import(/* @vite-ignore */ wcProviderUrl);
		const wc = await initWCProvider({
			projectId,
			optionalChains: Object.values(EVM_NETWORKS).map((n) => n.chainId),
		});
		await wc.enable();
		return wc;
	}
	const provider = getEvmProvider(walletName);
	if (!provider || typeof provider.request !== 'function') {
		const label = WALLET_LABELS[walletName] || 'wallet';
		if (initiateMobileRedirect(walletName, label, onStatus)) throw mobileRedirectError();
		throw walletNotFound(walletName);
	}
	return provider;
}

function getWcProjectId() {
	if (typeof document !== 'undefined') {
		const meta = document.querySelector('meta[name="x402-wc-project-id"]');
		if (meta?.content) return meta.content;
	}
	if (typeof window !== 'undefined' && window.WALLETCONNECT_PROJECT_ID) {
		return window.WALLETCONNECT_PROJECT_ID;
	}
	return null;
}

export async function payEvm({ accept, resourceUrl, walletName, onStatus, request }) {
	accept = normalizeAccept(accept);
	const meta = EVM_NETWORKS[accept.network];
	if (!meta) throw new Error(`Unsupported EVM network ${accept.network}`);
	const label = WALLET_LABELS[walletName] || 'wallet';

	const eth = await resolveEvmProvider(walletName, onStatus);
	onStatus?.('connecting', `Opening ${label}…`);
	const accounts = await eth.request({ method: 'eth_requestAccounts' });
	const payerAddress = accounts?.[0];
	if (!payerAddress) throw new Error(`${label} did not return an account`);

	// Switch to the required chain if the wallet is elsewhere.
	const currentChainHex = await eth.request({ method: 'eth_chainId' });
	const desiredChainHex = '0x' + meta.chainId.toString(16);
	if (currentChainHex !== desiredChainHex) {
		onStatus?.('connecting', `Switch ${label} to ${meta.name}…`);
		try {
			await eth.request({
				method: 'wallet_switchEthereumChain',
				params: [{ chainId: desiredChainHex }],
			});
		} catch {
			throw new Error(`Switch ${label} to ${meta.name} (${desiredChainHex}) and try again`);
		}
	}

	// Pre-flight: catch an underfunded wallet before the signature prompt (fail-open).
	onStatus?.('signing', 'Checking your balance…');
	await assertSufficientBalance({ accept, owner: payerAddress, provider: eth });

	onStatus?.('signing', `Authorize payment in ${label}…`);
	const { typedData, authorization } = buildEip3009TypedData({
		accept,
		payerAddress,
		chainId: meta.chainId,
	});
	const signature = await eth.request({
		method: 'eth_signTypedData_v4',
		params: [payerAddress, JSON.stringify(typedData)],
	});

	onStatus?.('confirming', 'Settling on-chain…');
	const paymentPayload = buildEvmPaymentPayload({
		accept,
		signature,
		authorization,
		resourceUrl,
	});
	const xPayment = b64encode(paymentPayload);
	return executePaid({ xPayment, resourceUrl, onStatus, accept, payerAddress, request });
}

// ─────────────────────────────────────────────────────────── dispatcher ──────

// Single entry point for the paywall controller. Routes a wallet button to the
// correct chain-specific payer based on the network of the matching `accept`.
export async function pay({ accept, resourceUrl, walletName, onStatus, origin, request }) {
	if (isSolanaNetwork(accept?.network)) {
		return paySolana({ accept, resourceUrl, walletName, onStatus, origin, request });
	}
	if (isEvmNetwork(accept?.network)) {
		return payEvm({ accept, resourceUrl, walletName, onStatus, request });
	}
	throw new Error(`Unsupported network ${accept?.network}`);
}

// Attach to window for the classic paywall.js controller.
if (typeof window !== 'undefined') {
	window.PaywallWallet = Object.freeze({
		pay,
		paySolana,
		payEvm,
		isSolanaNetwork,
		isEvmNetwork,
		isEip3009Accept,
		resolveResourceUrl,
		explorerUrl,
		getSolanaProvider,
		getEvmProvider,
		assertSufficientBalance,
		readSolanaTokenBalance,
		readEvmTokenBalance,
		insufficientFundsError,
		formatTokenAmount,
	});
}
