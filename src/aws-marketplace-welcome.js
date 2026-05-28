// AWS Marketplace post-registration welcome page.
//
// Receives: ?customer=<id>&trial=<0|1>[&signup=1]
//   - customer  — stable CustomerIdentifier from ResolveCustomer
//   - trial     — "1" when the subscription is a free trial
//   - signup    — "1" when the user has no three.ws account yet
//
// Flow:
//   1. If session cookie is already valid → call /api/aws-marketplace/link, show success.
//   2. If signup=1 (no account) → show Create account tab.
//   3. Otherwise → show Sign in tab (they may already have an account).
//   After auth, call /api/aws-marketplace/link with the customer ID to attach the subscription.

const p = new URLSearchParams(location.search);
const customerId = p.get('customer');
const isTrial = p.get('trial') === '1';
const wantsSignup = p.get('signup') === '1';

const ERROR_MESSAGES = {
	token_expired: 'The AWS Marketplace registration link has expired. Please return to AWS Marketplace and subscribe again.',
	link_failed:   'We could not link your AWS subscription to your account. Please try signing in again or contact support.',
	default:       'We couldn\'t complete your AWS Marketplace subscription setup.',
};

function show(id) {
	document.querySelectorAll('.state').forEach(el => el.classList.remove('active'));
	document.getElementById(id).classList.add('active');
}

function showErr(containerId, msg) {
	const el = document.getElementById(containerId);
	el.textContent = msg;
	el.classList.add('visible');
}

function clearErr(containerId) {
	const el = document.getElementById(containerId);
	el.textContent = '';
	el.classList.remove('visible');
}

async function linkSubscription() {
	const resp = await fetch('/api/aws-marketplace/link', {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ customer: customerId }),
	});
	if (!resp.ok) throw new Error('link_failed');
}

async function issueApiKey() {
	const resp = await fetch('/api/aws-marketplace/issue-key', {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ customer: customerId }),
	});
	if (!resp.ok) return null;
	const data = await resp.json().catch(() => ({}));
	return data.subscription || null;
}

async function linkAndIssue() {
	await linkSubscription();
	// Surface the API key alongside success. Failures here are recoverable —
	// the user can rotate from /api-keys — but log so we notice patterns.
	try {
		return await issueApiKey();
	} catch (err) {
		console.error('[aws-marketplace/welcome] issueApiKey failed', err);
		return null;
	}
}

function renderApiKey(subscription) {
	const note = document.getElementById('already-issued-note');
	// issueApiKey returned null (network/parse error after a successful link):
	// the customer is fully activated but we couldn't surface the plaintext.
	// Direct them to the dashboard where they can mint or rotate a key.
	if (!subscription) {
		note.style.display = '';
		return;
	}
	const panel = document.getElementById('key-panel');

	if (subscription.token) {
		document.getElementById('key-value').textContent = subscription.token;
		panel.style.display = '';
		const btn = document.getElementById('btn-copy-key');
		btn.addEventListener('click', async () => {
			try {
				await navigator.clipboard.writeText(subscription.token);
				btn.textContent = 'Copied';
				btn.classList.add('copied');
				setTimeout(() => {
					btn.textContent = 'Copy';
					btn.classList.remove('copied');
				}, 1800);
			} catch {
				// Clipboard API may be blocked — fall back to text selection.
				const range = document.createRange();
				range.selectNodeContents(document.getElementById('key-value'));
				const sel = window.getSelection();
				sel.removeAllRanges();
				sel.addRange(range);
			}
		});
	} else if (subscription.alreadyIssued) {
		note.style.display = '';
	}
}

function showSuccess(subscription) {
	const sub = document.getElementById('linked-sub');
	if (isTrial) {
		sub.textContent = 'Your free trial is active. Use the API key below to call any x402 endpoint. Billing through AWS begins automatically when the trial ends.';
	}
	renderApiKey(subscription);
	show('state-linked');
}

async function init() {
	// register.js redirects to /aws-marketplace/error?reason=... with NO
	// customer param on token-exchange failures, so the reason check must
	// come before the missing-customer check.
	const reason = p.get('reason');
	if (reason) {
		showErrorPage(reason);
		return;
	}

	if (!customerId) {
		showErrorPage('default');
		return;
	}

	// Check if already signed in.
	let me = null;
	try {
		const resp = await fetch('/api/auth/me', { credentials: 'include' });
		if (resp.ok) me = await resp.json();
	} catch {
		// network error: fall through to auth flow
	}

	if (me?.id) {
		// Already authenticated — link and confirm.
		document.getElementById('link-email').textContent = me.email || me.username || me.id;
		if (isTrial) {
			document.getElementById('trial-banner-link').style.display = '';
		}
		show('state-link');

		document.getElementById('btn-link').addEventListener('click', async () => {
			const btn = document.getElementById('btn-link');
			btn.disabled = true;
			btn.textContent = 'Linking…';
			clearErr('err-link');
			try {
				const sub = await linkAndIssue();
				showSuccess(sub);
			} catch {
				btn.disabled = false;
				btn.textContent = 'Confirm & activate';
				showErr('err-link', ERROR_MESSAGES.link_failed);
			}
		});
		return;
	}

	// Not signed in — show auth form.
	if (isTrial) {
		document.getElementById('trial-banner-auth').style.display = '';
	}
	if (!wantsSignup) {
		// They likely have an account already — default to sign-in tab.
		activateTab('signin');
		document.getElementById('auth-heading').textContent = 'Sign in to activate.';
		document.getElementById('auth-sub').textContent = 'Sign in to your three.ws account to link your AWS Marketplace subscription.';
	}
	show('state-auth');
}

function activateTab(name) {
	const isSignup = name === 'signup';
	document.getElementById('tab-signup').classList.toggle('active', isSignup);
	document.getElementById('tab-signin').classList.toggle('active', !isSignup);
	document.getElementById('form-signup').style.display = isSignup ? '' : 'none';
	document.getElementById('form-signin').style.display = isSignup ? 'none' : '';
}

function showErrorPage(reason) {
	const msg = ERROR_MESSAGES[reason] || ERROR_MESSAGES.default;
	document.getElementById('err-body').textContent = msg;
	show('state-error');
}

async function handleSignup(e) {
	e.preventDefault();
	const btn = document.getElementById('btn-signup');
	btn.disabled = true;
	btn.textContent = 'Creating account…';
	clearErr('err-auth');

	const email = document.getElementById('su-email').value.trim();
	const password = document.getElementById('su-password').value;

	try {
		const resp = await fetch('/api/auth/register', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ email, password }),
		});
		const data = await resp.json().catch(() => ({}));
		if (!resp.ok) throw new Error(data.error || data.message || 'Registration failed');
		const sub = await linkAndIssue();
		showSuccess(sub);
	} catch (err) {
		btn.disabled = false;
		btn.textContent = 'Create account & activate';
		showErr('err-auth', err.message);
	}
}

async function handleSignin(e) {
	e.preventDefault();
	const btn = document.getElementById('btn-signin');
	btn.disabled = true;
	btn.textContent = 'Signing in…';
	clearErr('err-auth');

	const email = document.getElementById('si-email').value.trim();
	const password = document.getElementById('si-password').value;

	try {
		const resp = await fetch('/api/auth/login', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ email, password }),
		});
		const data = await resp.json().catch(() => ({}));
		if (!resp.ok) throw new Error(data.error || data.message || 'Sign in failed');
		const sub = await linkAndIssue();
		showSuccess(sub);
	} catch (err) {
		btn.disabled = false;
		btn.textContent = 'Sign in & activate';
		showErr('err-auth', err.message);
	}
}

document.getElementById('tab-signup').addEventListener('click', () => activateTab('signup'));
document.getElementById('tab-signin').addEventListener('click', () => activateTab('signin'));
document.getElementById('form-signup').addEventListener('submit', handleSignup);
document.getElementById('form-signin').addEventListener('submit', handleSignin);

init();
