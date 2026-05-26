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

function showSuccess() {
	const sub = document.getElementById('linked-sub');
	if (isTrial) {
		sub.textContent = 'Your free trial is now active. Usage is metered and billed through AWS once the trial period ends.';
	}
	show('state-linked');
}

async function init() {
	if (!customerId) {
		showErrorPage('default');
		return;
	}

	const reason = p.get('reason');
	if (reason) {
		showErrorPage(reason);
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
				await linkSubscription();
				showSuccess();
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
		await linkSubscription();
		showSuccess();
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
		await linkSubscription();
		showSuccess();
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
