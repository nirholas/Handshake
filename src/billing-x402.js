// Billing — x402 subscription keys management.
//
// Renders the signed-in user's x402 subscription keys (AWS Marketplace and
// native), with usage, copy-prefix, rotate (one-shot secret reveal), and
// revoke. Talks to /api/user/x402-subscriptions. Self-contained: no dashboard
// shell, matches the AWS onboarding aesthetic.

const ENDPOINT = '/api/user/x402-subscriptions';

const el = (id) => document.getElementById(id);

// Single-use CSRF token for a state-changing call. Never cached: the server
// consumes the token in the same statement that validates it, so a reused one
// is a guaranteed 403 on the next write. Rotate and revoke both destroy a live
// credential, so the endpoint requires one.
async function csrfToken() {
	try {
		const r = await fetch('/api/csrf-token', { credentials: 'include' });
		if (!r.ok) return null;
		const j = await r.json().catch(() => null);
		return j?.token || j?.data?.token || null;
	} catch {
		return null;
	}
}

// The endpoint answers with three different envelopes: a prose `message` on the
// cases it wants a human to read, an `error_description` on the shared HTTP
// guards (CSRF, method), and a bare code otherwise. Pick the most specific one
// present, and name the two states a generic retry line would misdescribe: a
// stale token is fixed by reloading, a rate limit by waiting.
function failureText(resp, out, fallback) {
	if (resp.status === 403) return 'Your session check expired. Reload the page and try again.';
	if (resp.status === 429) return 'Too many attempts. Wait a minute and try again.';
	return out.message || out.error_description || fallback;
}

// One place to build the write, so rotate and revoke can never drift apart on
// which headers a mutation carries.
async function postAction(body) {
	const token = await csrfToken();
	return fetch(ENDPOINT, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(token ? { 'x-csrf-token': token } : {}),
		},
		credentials: 'include',
		body: JSON.stringify(body),
	});
}

function show(stateId) {
	for (const s of document.querySelectorAll('.state')) s.classList.toggle('active', s.id === stateId);
}

let toastTimer;
function toast(msg, isErr = false) {
	const t = el('toast');
	t.textContent = msg;
	t.classList.toggle('err', isErr);
	t.classList.add('show');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

function esc(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function relTime(iso) {
	if (!iso) return 'never';
	const then = new Date(iso).getTime();
	if (!Number.isFinite(then)) return 'never';
	const diff = Date.now() - then;
	const min = Math.floor(diff / 60000);
	if (min < 1) return 'just now';
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.floor(hr / 24);
	if (day < 30) return `${day}d ago`;
	return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDate(iso) {
	if (!iso) return '—';
	return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function statusPill(status) {
	const labels = { active: 'Active', revoked: 'Revoked', expired: 'Expired' };
	return `<span class="pill ${status}"><span class="dot"></span>${labels[status] || status}</span>`;
}

function cardHTML(sub) {
	const sourceBadge =
		sub.source === 'aws-marketplace'
			? `<span class="badge aws">AWS Marketplace</span>`
			: `<span class="badge native">Native</span>`;
	const trialBadge = sub.isFreeTrial ? `<span class="badge trial">Free trial</span>` : '';
	const isActive = sub.status === 'active';
	const isAws = sub.source === 'aws-marketplace';

	// Revoke is hidden for AWS keys (cancellation must originate in AWS Marketplace).
	const revokeBtn =
		isActive && !isAws
			? `<button class="btn danger" data-action="revoke" data-id="${esc(sub.id)}">Revoke</button>`
			: '';
	const rotateBtn = isActive
		? `<button class="btn" data-action="rotate" data-id="${esc(sub.id)}">Rotate key</button>`
		: '';

	return `
		<div class="card" data-card="${esc(sub.id)}">
			<div class="card-top">
				<div class="card-name">${esc(sub.name)}</div>
				<div class="badges">${sourceBadge}${trialBadge}${statusPill(sub.status)}</div>
			</div>
			<div class="meta-grid">
				<div><div class="label">Key</div><div class="value key-prefix">${esc(sub.keyPrefix)}…</div></div>
				<div><div class="label">Rate limit</div><div class="value">${sub.rateLimitPerMinute}/min</div></div>
				<div><div class="label">Calls</div><div class="value">${sub.usage.granted.toLocaleString()}${sub.usage.denied ? ` · ${sub.usage.denied.toLocaleString()} denied` : ''}</div></div>
				<div><div class="label">Last used</div><div class="value">${esc(relTime(sub.usage.lastSeenAt))}</div></div>
				<div><div class="label">Created</div><div class="value">${esc(fmtDate(sub.createdAt))}</div></div>
			</div>
			<div class="card-actions">
				<button class="btn ghost" data-action="copy-prefix" data-prefix="${esc(sub.keyPrefix)}">Copy prefix</button>
				${rotateBtn}
				${revokeBtn}
			</div>
			<div class="reveal-slot"></div>
		</div>`;
}

function renderReveal(card, token) {
	const slot = card.querySelector('.reveal-slot');
	slot.innerHTML = `
		<div class="reveal">
			<div class="reveal-label">
				<span>New API key</span>
				<button type="button" class="copy" data-copy-token>Copy</button>
			</div>
			<div class="reveal-value" data-token>${esc(token)}</div>
			<div class="reveal-note">Shown once. Store it now — it grants every paid call on this subscription and cannot be retrieved again.</div>
		</div>`;
	const tokenEl = slot.querySelector('[data-token]');
	const copyBtn = slot.querySelector('[data-copy-token]');
	copyBtn.addEventListener('click', async () => {
		await copy(tokenEl.textContent);
		copyBtn.textContent = 'Copied';
		copyBtn.classList.add('copied');
		setTimeout(() => { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, 1800);
	});
}

async function copy(text) {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		const ta = document.createElement('textarea');
		ta.value = text;
		ta.style.position = 'fixed';
		ta.style.opacity = '0';
		document.body.appendChild(ta);
		ta.select();
		try { document.execCommand('copy'); } catch { /* noop */ }
		ta.remove();
		return true;
	}
}

async function load() {
	show('state-loading');
	let resp;
	try {
		resp = await fetch(ENDPOINT, { credentials: 'include' });
	} catch {
		return showError("Couldn't reach the server", 'Check your connection and try again.');
	}
	if (resp.status === 401) {
		location.href = `/login?return=${encodeURIComponent(location.pathname)}`;
		return;
	}
	if (!resp.ok) {
		return showError("Couldn't load your keys", 'Something went wrong on our end. Please retry in a moment.');
	}
	let data;
	try {
		data = await resp.json();
	} catch {
		return showError("Couldn't load your keys", 'We received an unexpected response. Please retry.');
	}

	const subs = Array.isArray(data.subscriptions) ? data.subscriptions : [];
	if (subs.length === 0) {
		show('state-empty');
		return;
	}

	const active = subs.find((s) => s.status === 'active');
	if (active) el('example-prefix').textContent = `${active.keyPrefix}…`;

	el('cards').innerHTML = subs.map(cardHTML).join('');
	show('state-list');
}

function showError(title, body) {
	el('error-title').textContent = title;
	el('error-body').textContent = body;
	show('state-error');
}

async function rotate(id, btn) {
	const card = document.querySelector(`[data-card="${CSS.escape(id)}"]`);
	if (!window.confirm('Rotate this key? The current key stops working immediately and a new one is shown once.')) return;
	setBusy(card, true);
	let resp;
	try {
		resp = await postAction({ action: 'rotate', id });
	} catch {
		setBusy(card, false);
		return toast("Couldn't reach the server", true);
	}
	const out = await resp.json().catch(() => ({}));
	if (!resp.ok) {
		setBusy(card, false);
		return toast(failureText(resp, out, 'Rotation failed. Please try again.'), true);
	}
	const token = out.subscription?.token;
	toast('Key rotated.');
	// Reload to reflect the new subscription row, then reveal the fresh secret
	// on its card.
	await load();
	if (token && out.subscription?.id) {
		const fresh = document.querySelector(`[data-card="${CSS.escape(out.subscription.id)}"]`);
		if (fresh) {
			renderReveal(fresh, token);
			fresh.scrollIntoView({ behavior: 'smooth', block: 'center' });
		}
	}
}

async function revoke(id, btn) {
	const card = document.querySelector(`[data-card="${CSS.escape(id)}"]`);
	if (!window.confirm('Revoke this key permanently? Any integration using it will stop working immediately.')) return;
	setBusy(card, true);
	let resp;
	try {
		resp = await postAction({ action: 'revoke', id });
	} catch {
		setBusy(card, false);
		return toast("Couldn't reach the server", true);
	}
	const out = await resp.json().catch(() => ({}));
	if (!resp.ok) {
		setBusy(card, false);
		return toast(failureText(resp, out, 'Revoke failed. Please try again.'), true);
	}
	toast('Key revoked.');
	await load();
}

function setBusy(card, busy) {
	if (!card) return;
	for (const b of card.querySelectorAll('.btn')) b.disabled = busy;
}

document.addEventListener('click', (e) => {
	const btn = e.target.closest('[data-action]');
	if (!btn) return;
	const action = btn.dataset.action;
	if (action === 'copy-prefix') {
		copy(`${btn.dataset.prefix}…`).then(() => toast('Prefix copied. The full secret is only shown when you rotate.'));
	} else if (action === 'rotate') {
		rotate(btn.dataset.id, btn);
	} else if (action === 'revoke') {
		revoke(btn.dataset.id, btn);
	}
});

el('btn-retry')?.addEventListener('click', load);

load();
