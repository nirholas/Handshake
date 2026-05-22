// Solana wallet connect controller + button factory (CDN-compatible).
// Detects Phantom, Backpack, and Solflare via their window injections.
// Implements SIWS (Sign-In with Solana / CAIP-122) using each wallet's
// signMessage() API. Signature is base64-encoded for the server.

const SOLANA_STATES = Object.freeze({
	IDLE: 'idle',
	DETECTING: 'detecting',
	NO_PROVIDER: 'no_provider',
	CONNECTING: 'connecting',
	CONNECTED: 'connected',
	SIGNING: 'signing',
	VERIFYING: 'verifying',
	SUCCESS: 'success',
	ERROR: 'error',
});

const ASYNC_STATES = new Set([
	SOLANA_STATES.DETECTING,
	SOLANA_STATES.CONNECTING,
	SOLANA_STATES.SIGNING,
	SOLANA_STATES.VERIFYING,
]);

// ─── Wallet provider detection ───────────────────────────────────────────────

function detectSolanaProvider(preferredWallet) {
	// Respect explicit preference
	if (preferredWallet === 'phantom')  return window.phantom?.solana  || window.solana || null;
	if (preferredWallet === 'backpack') return window.backpack?.solana || null;
	if (preferredWallet === 'solflare') return window.solflare || null;

	// Auto-detect: prefer Phantom, then Backpack, then Solflare
	if (window.phantom?.solana?.isPhantom)  return window.phantom.solana;
	if (window.solana?.isPhantom)           return window.solana;
	if (window.backpack?.solana)            return window.backpack.solana;
	if (window.solflare?.isSolflare)        return window.solflare;
	return null;
}

function walletInstallUrl(preferredWallet) {
	if (preferredWallet === 'backpack') return 'https://www.backpack.app';
	if (preferredWallet === 'solflare') return 'https://solflare.com';
	return 'https://phantom.app';
}

// ─── SIWS message builder ────────────────────────────────────────────────────

function buildSiwsMessage(address, nonce, { domain, uri, issuedAt, expirationTime, chainId = 'mainnet' }) {
	return [
		`${domain} wants you to sign in with your Solana account:`,
		address,
		'',
		'Sign in to three.ws. This request will not trigger any blockchain transaction or cost any fees.',
		'',
		`URI: ${uri}`,
		'Version: 1',
		`Chain ID: ${chainId}`,
		`Nonce: ${nonce}`,
		`Issued At: ${issuedAt}`,
		`Expiration Time: ${expirationTime}`,
	].join('\n');
}

// ─── Uint8Array → base64 (works without any imports) ─────────────────────────

function toBase64(bytes) {
	return btoa(String.fromCharCode(...bytes));
}

// ─── Controller ──────────────────────────────────────────────────────────────

export class SolanaWalletController extends EventTarget {
	#status = SOLANA_STATES.IDLE;
	#address = null;
	#error = null;
	#opts;
	#provider = null;

	constructor(opts = {}) {
		super();
		this.#opts = {
			preferredWallet: null,        // 'phantom' | 'backpack' | 'solflare' | null (auto)
			nonceUrl: '/api/auth/siws/nonce',
			verifyUrl: '/api/auth/siws/verify',
			chainId: 'mainnet',
			onSuccess: null,
			...opts,
		};
	}

	get state()   { return this.#status; }
	get address() { return this.#address; }
	get error()   { return this.#error; }

	#set(status, patch = {}) {
		this.#status  = status;
		this.#address = patch.address  ?? this.#address;
		this.#error   = patch.error    ?? (status === SOLANA_STATES.ERROR ? this.#error : null);
		this.dispatchEvent(new CustomEvent('change', {
			detail: { status: this.#status, address: this.#address, error: this.#error },
		}));
	}

	async connect() {
		if (this.#status !== SOLANA_STATES.IDLE && this.#status !== SOLANA_STATES.ERROR) return;
		this.#set(SOLANA_STATES.DETECTING);

		const provider = detectSolanaProvider(this.#opts.preferredWallet);
		if (!provider) {
			this.#set(SOLANA_STATES.NO_PROVIDER);
			return;
		}
		this.#provider = provider;
		this.#set(SOLANA_STATES.CONNECTING);

		try {
			const resp = await provider.connect();
			const address = resp.publicKey.toString();
			this.#set(SOLANA_STATES.CONNECTED, { address });
			// Auto-advance to signing
			await this.signAndVerify();
		} catch (e) {
			if (e?.code === 4001 || e?.message?.includes('User rejected')) {
				this.#set(SOLANA_STATES.ERROR, { error: new Error('Connection cancelled.') });
			} else {
				this.#set(SOLANA_STATES.ERROR, { error: e instanceof Error ? e : new Error(String(e)) });
			}
		}
	}

	async signAndVerify() {
		if (this.#status !== SOLANA_STATES.CONNECTED || !this.#provider || !this.#address) return;
		this.#set(SOLANA_STATES.SIGNING);

		try {
			const nonceRes = await fetch(this.#opts.nonceUrl, { credentials: 'include' });
			if (!nonceRes.ok) throw new Error('Failed to get nonce');
			const { nonce, csrf, domain: serverDomain, uri: serverUri } = await nonceRes.json();

			// Prefer server-issued domain/uri so dev frontends proxying /api/*
			// to a different origin still produce messages that match the
			// upstream's domain check.
			const domain       = serverDomain || location.host;
			const uri          = serverUri    || location.origin;
			const issuedAt     = new Date().toISOString();
			const expirationTime = new Date(Date.now() + 5 * 60 * 1000).toISOString();

			const message = buildSiwsMessage(this.#address, nonce, {
				domain, uri, issuedAt, expirationTime,
				chainId: this.#opts.chainId,
			});

			const msgBytes = new TextEncoder().encode(message);
			const { signature } = await this.#provider.signMessage(msgBytes, 'utf8');
			const sigBase64 = toBase64(signature);
			this.#set(SOLANA_STATES.VERIFYING);

			const verifyRes = await fetch(this.#opts.verifyUrl, {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
				body: JSON.stringify({ message, signature: sigBase64 }),
			});
			const data = await verifyRes.json();
			if (!verifyRes.ok) throw new Error(data.error_description || 'Verification failed');

			this.#set(SOLANA_STATES.SUCCESS);
			if (this.#opts.onSuccess) this.#opts.onSuccess(data);
		} catch (e) {
			if (e?.code === 4001 || e?.message?.toLowerCase().includes('rejected')) {
				this.#set(SOLANA_STATES.ERROR, { error: new Error('Signature cancelled.') });
			} else {
				this.#set(SOLANA_STATES.ERROR, { error: e instanceof Error ? e : new Error(String(e)) });
			}
		}
	}

	reset() {
		this.#provider = null;
		this.#address  = null;
		this.#error    = null;
		this.#set(SOLANA_STATES.IDLE);
	}

	disconnect() {
		this.#provider?.disconnect?.().catch(() => {});
		this.reset();
	}
}

// ─── Button factory ───────────────────────────────────────────────────────────

const LABEL_DEFAULTS = {
	[SOLANA_STATES.IDLE]:       'Connect Solana wallet',
	[SOLANA_STATES.DETECTING]:  'Detecting…',
	[SOLANA_STATES.CONNECTING]: 'Connecting…',
	[SOLANA_STATES.SIGNING]:    'Sign in your wallet…',
	[SOLANA_STATES.VERIFYING]:  'Verifying…',
	[SOLANA_STATES.SUCCESS]:    'Signed in',
	[SOLANA_STATES.ERROR]:      'Retry',
	[SOLANA_STATES.NO_PROVIDER]: 'Install Phantom',
};

export function createSolanaWalletButton(mountEl, opts = {}) {
	const labels  = { ...LABEL_DEFAULTS, ...(opts.labels || {}) };
	const ctrl    = new SolanaWalletController(opts);
	const btn     = document.createElement('button');
	btn.type      = 'button';
	btn.className = 'cwb-btn cwb-btn--solana';

	function render({ status, address }) {
		btn.setAttribute('data-state', status);
		btn.disabled = ASYNC_STATES.has(status) || status === SOLANA_STATES.SUCCESS;
		btn.setAttribute('aria-busy', ASYNC_STATES.has(status) ? 'true' : 'false');

		if (status === SOLANA_STATES.CONNECTED && address) {
			btn.textContent = `${address.slice(0, 4)}…${address.slice(-4)} · Solana`;
		} else {
			btn.textContent = labels[status] || status;
		}
	}

	function updateClickHandler(status) {
		btn.onclick = null;
		if (status === SOLANA_STATES.NO_PROVIDER) {
			btn.onclick = () => window.open(walletInstallUrl(opts.preferredWallet), '_blank', 'noopener');
		} else if (status === SOLANA_STATES.IDLE || status === SOLANA_STATES.ERROR) {
			btn.onclick = () => { ctrl.reset(); ctrl.connect(); };
		}
	}

	ctrl.addEventListener('change', (e) => {
		render(e.detail);
		updateClickHandler(e.detail.status);
	});

	render({ status: ctrl.state, address: ctrl.address });
	updateClickHandler(ctrl.state);

	mountEl.innerHTML = '';
	mountEl.appendChild(btn);
	return ctrl;
}

export { SOLANA_STATES };
