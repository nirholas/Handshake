// Client-side wallet authentication for both EVM (SIWE) and Solana (SIWS).
// Loaded as a module from login.html — imports from CDN so it works outside Vite.

// Loaded at runtime from /public via plain `<script src>`. Imports use the
// dynamic form with @vite-ignore so Vite (which forbids static imports of
// files under /public) doesn't try to analyze these URLs at build time.
const { createConnectWalletButton } = await import(/* @vite-ignore */ '/wallet/connect-button.js');
const { createSolanaWalletButton }  = await import(/* @vite-ignore */ '/wallet/connect-button-solana.js');

const params = new URLSearchParams(location.search);
const next   = window.__loginNext || params.get('next') || sessionStorage.getItem('login_redirect') || '/dashboard';
sessionStorage.removeItem('login_redirect');

function setErr(m) {
	const el = document.getElementById('err');
	if (el) { el.textContent = m; el.style.display = 'block'; }
}
function clearErr() {
	const el = document.getElementById('err');
	if (el) el.style.display = 'none';
}

function onSuccess(data) {
	try {
		localStorage.setItem('3dagent:auth-hint', JSON.stringify({
			authed: true,
			name: data?.user?.display_name || '',
			ts: Date.now(),
		}));
	} catch { /* ignore */ }
	location.href = next;
}

// ─── EVM wallet button ────────────────────────────────────────────────────────

const evmMount = document.getElementById('wallet-mount');
if (evmMount) {
	const evmCtrl = createConnectWalletButton(evmMount, {
		verifyUrl: '/api/auth/siwe/verify',
		onSuccess,
	});
	evmCtrl.addEventListener('change', (e) => {
		const { status, error } = e.detail;
		if (status === 'error') {
			const msg = error?.message || 'Sign in failed.';
			setErr(msg === 'user rejected action' ? 'Signature cancelled.' : msg);
		} else {
			clearErr();
		}
	});
}

// ─── Solana wallet button ─────────────────────────────────────────────────────

let solanaCtrl = null;

function mountSolanaButton(preferredWallet = null) {
	const mount = document.getElementById('solana-wallet-mount');
	if (!mount) return;
	if (solanaCtrl) solanaCtrl.disconnect();

	solanaCtrl = createSolanaWalletButton(mount, {
		preferredWallet,
		verifyUrl: '/api/auth/siws/verify',
		onSuccess,
	});
	solanaCtrl.addEventListener('change', (e) => {
		const { status, error } = e.detail;
		if (status === 'error') {
			setErr(error?.message || 'Sign in failed.');
		} else {
			clearErr();
		}
	});
}

mountSolanaButton();

// Wallet hint buttons (Phantom / Backpack / Solflare)
document.querySelectorAll('.wallet-hint-btn').forEach((btn) => {
	btn.addEventListener('click', () => {
		document.querySelectorAll('.wallet-hint-btn').forEach((b) => b.classList.remove('active'));
		btn.classList.add('active');
		mountSolanaButton(btn.dataset.wallet);
	});
});

// ─── Chain tab switcher ───────────────────────────────────────────────────────

document.querySelectorAll('.chain-tab').forEach((tab) => {
	tab.addEventListener('click', () => {
		const chain = tab.dataset.chain;
		document.querySelectorAll('.chain-tab').forEach((t) => t.classList.remove('active'));
		document.querySelectorAll('.chain-panel').forEach((p) => p.classList.remove('active'));
		tab.classList.add('active');
		document.getElementById(`${chain}-panel`)?.classList.add('active');
		clearErr();
	});
});
