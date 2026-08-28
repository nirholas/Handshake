// /seeker: the home screen of the three.ws app on Solana Seeker (and the
// landing page for Seeker owners in a browser).
//
// Boots the Mobile Wallet Adapter wallet (a no-op outside the TWA), signs the
// visitor in through the Seed Vault's one-tap Sign-In With Solana, and then
// shows what is theirs: their agents, and whether the wallet holds the Seeker
// Genesis Token (verified through /api/seeker/verify, a read-only check).

import { isSolanaMobileTwa, isSolanaMobileDevice } from '../solana-mobile/src/seeker-detect.js';
import { isUserRejection } from '../solana-mobile/src/mwa-errors.js';
import { apiFetch } from './api.js';

// The wallet stack (Mobile Wallet Adapter + @solana/web3.js) is ~700 KB. It
// is only needed to sign in, so the home screen loads without it: inside the
// TWA the MWA boot is started immediately (it resumes a remembered session
// silently), everywhere else the stack loads on the first tap of Sign in.
const walletBoot = (typeof window !== 'undefined' && isSolanaMobileTwa())
	? import('../solana-mobile/src/index.js')
	: null;

async function loadAdapter() {
	if (walletBoot) await walletBoot;
	const { SolanaAdapter } = await import('./onchain/adapters/solana.js');
	return new SolanaAdapter();
}

const $ = (id) => document.getElementById(id);

const ui = {
	signIn: $('sign-in'),
	signInLabel: $('sign-in-label'),
	hero: $('hero'),
	heroCta: $('hero-cta'),
	welcomeAddr: $('welcome-addr'),
	mine: $('mine'),
	agents: $('agents'),
	agentsEmpty: $('agents-empty'),
	agentsError: $('agents-error'),
	agentsRetry: $('agents-retry'),
	verify: $('verify'),
	verifyTitle: $('verify-title-text'),
	verifyCopy: $('verify-copy'),
	verifyBtn: $('verify-btn'),
	verifyMsg: $('verify-msg'),
};

const onSeeker = () => {
	try { return isSolanaMobileTwa() || isSolanaMobileDevice(); } catch { return false; }
};

const shorten = (addr) => (addr ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : '');

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// apiFetch carries the session cookie and, on mutations, the x-csrf-token the
// server requires; a plain fetch would be refused by /api/seeker/verify.
//
// apiFetch bounds each ATTEMPT but retries a safe method up to three times, so
// a persistently black-holed edge could still hold the page for a minute. The
// signal here is the whole-call ceiling on top of that: the verify button and
// the agent list both paint a busy state before the call, and once the ceiling
// fires the request rejects and the caller paints its designed error row.
// Mutations get a longer ceiling because /api/seeker/verify reads the chain.
const CALL_TIMEOUT_MS = 20_000;
const MUTATION_TIMEOUT_MS = 45_000;

async function fetchJson(url, { timeout, ...init } = {}) {
	const isMutation = (init.method || 'GET').toUpperCase() !== 'GET';
	const ceiling = timeout ?? (isMutation ? MUTATION_TIMEOUT_MS : CALL_TIMEOUT_MS);
	const res = await apiFetch(url, { credentials: 'include', ...init, signal: AbortSignal.timeout(ceiling) });
	const body = await res.json().catch(() => null);
	return { ok: res.ok, status: res.status, body };
}

// ── Session ────────────────────────────────────────────────────────────────

let user = null;
let signingIn = false;

async function loadSession() {
	// A timed-out or failed session probe means "we cannot prove you are signed
	// in", which is the same paint as signed-out. Swallowing it here keeps the
	// hero from being blocked behind an unhandled rejection.
	let ok = false;
	let body = null;
	try {
		({ ok, body } = await fetchJson('/api/auth/me'));
	} catch (err) {
		console.warn('[seeker] session probe failed', err);
	}
	user = ok ? body?.user || null : null;
	paintSession();
	return user;
}

function paintSession() {
	const signedIn = Boolean(user);
	ui.hero.dataset.signedIn = String(signedIn);
	ui.mine.hidden = !signedIn;
	if (signedIn) {
		const address = user.wallet_address || user.primary_wallet || user.solana_wallet || '';
		const label = address ? shorten(address) : (user.display_name || user.username || user.email || 'Signed in');
		ui.signIn.dataset.state = 'connected';
		ui.signInLabel.textContent = label;
		ui.signIn.setAttribute('aria-label', `Signed in as ${label}. Open account.`);
		ui.welcomeAddr.textContent = label;
	} else {
		ui.signIn.dataset.state = 'idle';
		ui.signInLabel.textContent = onSeeker() ? 'Sign in with Seed Vault' : 'Sign in with wallet';
		ui.signIn.removeAttribute('aria-label');
	}
}

async function signIn() {
	if (signingIn) return;
	if (user) { location.assign('/settings'); return; }
	signingIn = true;
	ui.signIn.dataset.state = 'busy';
	ui.signInLabel.textContent = 'Waiting for Seed Vault';
	ui.heroCta.disabled = true;
	try {
		const adapter = await loadAdapter();
		if (!adapter.isAvailable()) {
			toast(onSeeker()
				? 'Seed Vault did not respond. Open the Seed Vault wallet once, then try again.'
				: 'No Solana wallet found. Install Phantom, or open three.ws in the Seeker app.');
			return;
		}
		await adapter.connect({ ensureLinked: true, cluster: 'mainnet' });
		await loadSession();
		if (user) {
			toast(onSeeker() ? 'Signed in with Seed Vault' : 'Signed in', 'ok');
			loadAgents();
			loadVerification();
		}
	} catch (err) {
		if (!isUserRejection(err) && err?.code !== 'USER_REJECTED') {
			console.error('[seeker] sign-in failed', err);
			toast(err?.userMessage || err?.message || 'Sign-in failed. Try again.');
		}
	} finally {
		signingIn = false;
		ui.heroCta.disabled = false;
		paintSession();
	}
}

// ── Toasts (tiny, page-local, no dependency on the site chrome) ────────────

let toastEl = null;
function toast(message, kind = 'error') {
	if (!toastEl) {
		toastEl = document.createElement('div');
		toastEl.setAttribute('role', 'status');
		toastEl.setAttribute('aria-live', 'polite');
		Object.assign(toastEl.style, {
			position: 'fixed', left: '16px', right: '16px', bottom: 'calc(20px + env(safe-area-inset-bottom, 0px))',
			padding: '12px 14px', borderRadius: '12px', fontSize: '0.9rem', zIndex: 50,
			background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)',
			boxShadow: '0 12px 32px rgba(0,0,0,0.35)', transform: 'translateY(12px)', opacity: '0',
			transition: 'opacity 160ms ease, transform 160ms ease',
		});
		document.body.appendChild(toastEl);
	}
	toastEl.textContent = message;
	toastEl.style.borderColor = kind === 'ok' ? 'var(--green)' : 'var(--border-2)';
	requestAnimationFrame(() => { toastEl.style.opacity = '1'; toastEl.style.transform = 'none'; });
	clearTimeout(toast.timer);
	toast.timer = setTimeout(() => { toastEl.style.opacity = '0'; toastEl.style.transform = 'translateY(12px)'; }, 3600);
}

// ── Your agents ────────────────────────────────────────────────────────────

const MAX_HOME_AGENTS = 8;

async function loadAgents() {
	if (!user) return;
	ui.agentsEmpty.hidden = true;
	ui.agentsError.hidden = true;
	ui.agents.hidden = false;
	ui.agents.setAttribute('aria-busy', 'true');
	let ok = false;
	let body = null;
	try {
		({ ok, body } = await fetchJson('/api/agents'));
	} catch (err) {
		// A ceiling abort throws rather than returning ok:false. Without this the
		// list would stay aria-busy forever with no retry offered.
		console.warn('[seeker] agents load failed', err);
	}
	ui.agents.setAttribute('aria-busy', 'false');
	if (!ok) {
		ui.agents.hidden = true;
		ui.agentsError.hidden = false;
		return;
	}
	const agents = Array.isArray(body?.agents) ? body.agents : [];
	if (agents.length === 0) {
		ui.agents.hidden = true;
		ui.agentsEmpty.hidden = false;
		return;
	}
	ui.agents.innerHTML = agents.slice(0, MAX_HOME_AGENTS).map((a) => {
		const name = escapeHtml(a.name || 'Agent');
		const poster = a.avatar_thumbnail_url ? ` style="background-image:url('${escapeHtml(a.avatar_thumbnail_url)}')"` : '';
		const initial = a.avatar_thumbnail_url ? '' : escapeHtml((a.name || 'A').slice(0, 1).toUpperCase());
		const sub = a.is_published ? 'Published' : 'Draft';
		return `<a class="agent" role="listitem" href="/agents/${escapeHtml(a.id)}" aria-label="${name}, ${sub}">
			<div class="thumb"${poster}>${initial}</div>
			<div class="meta"><span class="name">${name}</span><span class="sub">${sub}</span></div>
		</a>`;
	}).join('');
}

// ── Seeker Genesis Token ───────────────────────────────────────────────────

function paintVerification(status) {
	const verified = Boolean(status?.verified);
	ui.verify.dataset.state = verified ? 'verified' : 'unverified';
	if (verified) {
		const w = status.wallets?.[0];
		const when = w?.verifiedAt ? new Date(w.verifiedAt).toLocaleDateString() : '';
		ui.verifyTitle.textContent = 'Seeker verified';
		ui.verifyCopy.textContent = `Genesis Token found in ${shorten(w?.address || '')}${when ? `, checked ${when}` : ''}.`;
		ui.verifyBtn.textContent = 'Re-check';
	} else {
		ui.verifyTitle.textContent = 'Verify your Seeker';
		ui.verifyCopy.textContent = user
			? 'Prove you own a Seeker with the Genesis Token in your Seed Vault. It is soulbound, so the check is a read, never a transaction.'
			: 'Sign in with Seed Vault first, then we read the Genesis Token from your wallet. No transaction, ever.';
		ui.verifyBtn.textContent = user ? 'Check my wallet' : 'Sign in to verify';
	}
}

async function loadVerification() {
	if (!user) { paintVerification(null); return; }
	try {
		const { ok, body } = await fetchJson('/api/seeker/status');
		paintVerification(ok ? body : null);
	} catch (err) {
		console.warn('[seeker] verification status failed', err);
		paintVerification(null);
	}
}

async function runVerification() {
	if (!user) { signIn(); return; }
	ui.verifyBtn.disabled = true;
	ui.verifyMsg.dataset.kind = '';
	ui.verifyMsg.textContent = 'Reading your wallet…';
	try {
		const { ok, status, body } = await fetchJson('/api/seeker/verify', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({}),
		});
		if (!ok) {
			const reason = status === 503
				? 'Verification is temporarily unavailable.'
				: status === 502
					? 'Solana RPC did not answer. Try again in a moment.'
					: body?.error_description || body?.message || 'Could not verify right now.';
			ui.verifyMsg.dataset.kind = 'error';
			ui.verifyMsg.textContent = reason;
			return;
		}
		paintVerification(body);
		ui.verifyMsg.dataset.kind = body?.verified ? 'ok' : '';
		ui.verifyMsg.textContent = body?.verified
			? 'Verified.'
			: (body?.linkedSolanaWallets?.length
				? 'No Genesis Token in your linked wallet. Sign in with the Seed Vault account that claimed it.'
				: 'No Solana wallet linked yet. Sign in with Seed Vault first.');
	} catch (err) {
		console.error('[seeker] verify failed', err);
		ui.verifyMsg.dataset.kind = 'error';
		ui.verifyMsg.textContent = err?.name === 'TimeoutError'
			? 'Verification took too long to answer. Try again in a moment.'
			: 'Network error. Check your connection and try again.';
	} finally {
		ui.verifyBtn.disabled = false;
	}
}

// ── Boot ───────────────────────────────────────────────────────────────────

ui.signIn.addEventListener('click', signIn);
ui.heroCta.addEventListener('click', signIn);
ui.agentsRetry.addEventListener('click', loadAgents);
ui.verifyBtn.addEventListener('click', runVerification);
window.addEventListener('threews:mwa-ready', paintSession);

paintSession();
loadSession().then(() => {
	loadAgents();
	loadVerification();
});
