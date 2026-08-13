// Consent-first Farcaster memory seeding, as a self-contained panel.
//
// The flow the user walks, and why it is shaped this way: Farcaster has no
// OAuth and we deliberately never ask for a signer, so ownership of the account
// is proved with a wallet the fid has already verified on the protocol. Solana
// leads, because that is the home chain and the wallet our users already have
// connected. Nothing is read into memory until the signature verifies, and the
// same panel that grants consent is the one that revokes it.
//
//   look up  →  review exactly what will be read  →  sign with a verified
//   wallet  →  seeded  →  revoke (deletes every memory the grant produced)
//
// Mounted by src/dashboard-next/pages/agents.js inside the agent persona editor.

import { get, post, del, esc, ApiError } from './api.js';
import { toast } from '../shared/toast.js';

const DIM = 'var(--nxt-ink-dim)';
const INK = 'var(--nxt-ink)';
const DANGER = 'var(--nxt-danger)';

function solanaProvider() {
	return window.phantom?.solana || window.solana || null;
}

// Base64 of an ed25519 signature — the server (verifySiwsSignature) accepts base64.
function bytesToB64(bytes) {
	const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let bin = '';
	for (const b of arr) bin += String.fromCharCode(b);
	return btoa(bin);
}

function ethereumProvider() {
	return window.ethereum || null;
}

function shortAddress(address) {
	const a = String(address || '');
	return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function formatDate(value) {
	if (!value) return null;
	const d = new Date(value);
	return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
}

function messageFor(err) {
	if (err instanceof ApiError) return err.message || err.code;
	return err?.message || 'Something went wrong.';
}

/**
 * Ask the wallet to sign the consent text. Solana signs ed25519 through the
 * injected provider; an EVM verification falls back to personal_sign so a fid
 * that only ever verified an Ethereum address is not locked out.
 */
async function signConsent({ chain, address, message }) {
	if (chain === 'solana') {
		const provider = solanaProvider();
		if (!provider?.signMessage) {
			throw new Error('No Solana wallet found. Install Phantom (phantom.com) and reload.');
		}
		const connected = await provider.connect();
		const active = (connected?.publicKey || provider.publicKey)?.toString();
		if (active && active !== address) {
			throw new Error(`Switch your wallet to ${shortAddress(address)} — that is the wallet this Farcaster account verified.`);
		}
		const signed = await provider.signMessage(new TextEncoder().encode(message), 'utf8');
		return bytesToB64(signed?.signature ?? signed);
	}

	const provider = ethereumProvider();
	if (!provider?.request) throw new Error('No Ethereum wallet found in this browser.');
	const accounts = await provider.request({ method: 'eth_requestAccounts' });
	const active = String(accounts?.[0] || '').toLowerCase();
	if (active && active !== String(address).toLowerCase()) {
		throw new Error(`Switch your wallet to ${shortAddress(address)} — that is the wallet this Farcaster account verified.`);
	}
	return provider.request({ method: 'personal_sign', params: [message, address] });
}

/**
 * Mount the panel into `host` for one agent.
 * Returns a `refresh()` the caller can use to re-read status.
 */
export function mountFarcasterSeed(host, { agentId }) {
	const base = `/api/agents/${encodeURIComponent(agentId)}/memory/seed/farcaster`;
	let challenge = null;

	const render = (html) => {
		host.innerHTML = html;
	};

	const setBusy = (button, busyLabel) => {
		const original = button.textContent;
		button.disabled = true;
		button.setAttribute('aria-busy', 'true');
		button.textContent = busyLabel;
		return () => {
			button.disabled = false;
			button.removeAttribute('aria-busy');
			button.textContent = original;
		};
	};

	const showError = (message) => {
		const slot = host.querySelector('[data-slot="fc-error"]');
		if (slot) {
			slot.textContent = message;
			slot.hidden = false;
		} else {
			toast(message);
		}
	};

	// ── Views ────────────────────────────────────────────────────────────────

	function loadingView() {
		render(`
			<div class="fc-seed" aria-busy="true">
				<div class="fc-skeleton" style="width:60%"></div>
				<div class="fc-skeleton" style="width:85%"></div>
			</div>
		`);
	}

	function errorView(message) {
		render(`
			<div class="fc-seed">
				<div style="font-size:12.5px;color:${DANGER};margin-bottom:8px">${esc(message)}</div>
				<button class="dn-btn" type="button" data-action="fc-retry">Try again</button>
			</div>
		`);
		host.querySelector('[data-action="fc-retry"]').addEventListener('click', refresh);
	}

	function disconnectedView() {
		render(`
			<div class="fc-seed">
				<div style="font-size:12.5px;color:${DIM};margin-bottom:10px">
					Give this agent your Farcaster voice. We read only your <strong style="color:${INK}">public profile and casts</strong>,
					and only after you prove the account is yours by signing with a wallet it has already verified. Nothing is
					stored before you sign, and revoking deletes every memory this created.
				</div>
				<div style="display:grid;grid-template-columns:1fr auto;gap:8px">
					<label style="display:contents">
						<span class="fc-sr-only">Farcaster username or FID</span>
						<input data-slot="fc-handle" type="text" maxlength="64" placeholder="Farcaster username or FID"
							aria-label="Farcaster username or FID" class="fc-input" />
					</label>
					<button class="dn-btn" type="button" data-action="fc-lookup" style="flex-shrink:0">Connect Farcaster</button>
				</div>
				<div data-slot="fc-error" role="alert" hidden style="font-size:12.5px;color:${DANGER};margin-top:8px"></div>
			</div>
		`);

		const input = host.querySelector('[data-slot="fc-handle"]');
		const button = host.querySelector('[data-action="fc-lookup"]');
		button.addEventListener('click', () => lookup(input.value, button));
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				lookup(input.value, button);
			}
		});
	}

	function consentView(data) {
		challenge = data;
		const wallets = [
			...(data.wallets?.solana || []).map((address) => ({ address, chain: 'solana' })),
			...(data.wallets?.ethereum || []).map((address) => ({ address, chain: 'ethereum' })),
		];
		const profile = data.profile || {};
		const picker =
			wallets.length > 1
				? `<label style="display:block;margin-top:10px;font-size:12px;color:${DIM}">
						Sign with
						<select data-slot="fc-wallet" class="fc-input" style="margin-top:4px;width:100%">
							${wallets
								.map(
									(w) =>
										`<option value="${esc(w.address)}" ${w.address === data.address ? 'selected' : ''}>${esc(shortAddress(w.address))} · ${esc(w.chain === 'solana' ? 'Solana' : 'Ethereum')}</option>`,
								)
								.join('')}
						</select>
					</label>`
				: '';

		render(`
			<div class="fc-seed">
				<div class="fc-card">
					<div style="display:flex;align-items:center;gap:10px">
						${profile.pfp_url ? `<img src="${esc(profile.pfp_url)}" alt="" width="36" height="36" loading="lazy" style="border-radius:50%;object-fit:cover;flex-shrink:0" />` : ''}
						<div style="min-width:0">
							<div style="font-size:13px;font-weight:600;color:${INK};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
								${esc(profile.display_name || profile.fname || `FID ${profile.fid}`)}
							</div>
							<div style="font-size:12px;color:${DIM}">@${esc(profile.fname || profile.fid)} · FID ${esc(String(profile.fid))}</div>
						</div>
					</div>
					${profile.bio ? `<div style="font-size:12px;color:${DIM};margin-top:8px">${esc(profile.bio)}</div>` : ''}
				</div>

				<div style="font-size:12.5px;color:${DIM};margin-top:12px">
					<div style="color:${INK};font-weight:600;margin-bottom:4px">What this grants</div>
					<ul style="margin:0;padding-left:18px;display:grid;gap:3px">
						<li>Read your public Farcaster profile and up to ${esc(String(data.cast_limit))} recent casts.</li>
						<li>Store them as this agent's memory, so it can speak from them.</li>
						<li>Nothing else. No posting, no signer, no private data.</li>
					</ul>
					<div style="margin-top:8px">Scope <code style="color:${INK}">${esc(data.scope)}</code></div>
				</div>

				${picker}

				<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
					<button class="dn-btn primary" type="button" data-action="fc-sign">Sign with ${esc(shortAddress(data.address))}</button>
					<button class="dn-btn ghost" type="button" data-action="fc-cancel">Cancel</button>
				</div>
				<div data-slot="fc-error" role="alert" hidden style="font-size:12.5px;color:${DANGER};margin-top:8px"></div>
			</div>
		`);

		host.querySelector('[data-action="fc-cancel"]').addEventListener('click', () => {
			challenge = null;
			disconnectedView();
		});
		host.querySelector('[data-action="fc-sign"]').addEventListener('click', (e) => grant(e.currentTarget));

		const select = host.querySelector('[data-slot="fc-wallet"]');
		if (select) {
			select.addEventListener('change', async () => {
				// The signed text names the wallet, so choosing another one needs a new
				// challenge rather than a re-labelled button.
				try {
					const next = await post(base, {
						intent: 'challenge',
						fid: challenge.profile.fid,
						address: select.value,
					});
					consentView(next);
				} catch (err) {
					showError(messageFor(err));
				}
			});
		}
	}

	function connectedView(status) {
		const consent = status.consent || {};
		const granted = formatDate(consent.granted_at);
		const seeded = formatDate(status.seeded_at || consent.last_seeded_at);

		render(`
			<div class="fc-seed">
				<div class="fc-card">
					<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
						<div style="min-width:0">
							<div style="font-size:13px;font-weight:600;color:${INK}">@${esc(status.fname || status.fid)}</div>
							<div style="font-size:12px;color:${DIM}">FID ${esc(String(status.fid))} · ${esc(String(status.memory_count))} ${status.memory_count === 1 ? 'memory' : 'memories'}${seeded ? ` · seeded ${esc(seeded)}` : ''}</div>
						</div>
						<span class="fc-pill">Consent active</span>
					</div>
					<div style="font-size:12px;color:${DIM};margin-top:8px">
						Proved with ${esc(consent.proof_chain === 'ethereum' ? 'Ethereum' : 'Solana')} wallet
						<code style="color:${INK}">${esc(shortAddress(consent.proof_address))}</code>${granted ? ` on ${esc(granted)}` : ''}.
					</div>
				</div>
				<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
					<button class="dn-btn" type="button" data-action="fc-reseed">Refresh memories</button>
					<button class="dn-btn ghost" type="button" data-action="fc-revoke">Revoke and delete</button>
				</div>
				<div data-slot="fc-error" role="alert" hidden style="font-size:12.5px;color:${DANGER};margin-top:8px"></div>
			</div>
		`);

		host.querySelector('[data-action="fc-reseed"]').addEventListener('click', (e) => reseed(e.currentTarget));
		host.querySelector('[data-action="fc-revoke"]').addEventListener('click', (e) => revoke(e.currentTarget));
	}

	// ── Actions ──────────────────────────────────────────────────────────────

	async function lookup(rawHandle, button) {
		const handle = String(rawHandle || '').trim().replace(/^@/, '');
		if (!handle) {
			showError('Enter a Farcaster username or FID first.');
			return;
		}
		const done = setBusy(button, 'Looking up…');
		try {
			const body = /^\d+$/.test(handle)
				? { intent: 'challenge', fid: Number(handle) }
				: { intent: 'challenge', fname: handle };
			consentView(await post(base, body));
		} catch (err) {
			done();
			if (err instanceof ApiError && err.code === 'no_verified_wallet') {
				showError(
					'That Farcaster account has no verified wallet, so we cannot confirm it is yours. Verify a Solana wallet on Farcaster, then try again.',
				);
				return;
			}
			showError(messageFor(err));
		}
	}

	async function grant(button) {
		if (!challenge) return;
		const done = setBusy(button, 'Waiting for wallet…');
		try {
			const signature = await signConsent({
				chain: challenge.chain,
				address: challenge.address,
				message: challenge.message,
			});
			button.textContent = 'Seeding memories…';
			const result = await post(base, {
				intent: 'grant',
				nonce: challenge.nonce,
				address: challenge.address,
				chain: challenge.chain,
				signature,
			});
			challenge = null;
			toast(`Seeded ${result.seeded} ${result.seeded === 1 ? 'memory' : 'memories'} from ${result.casts_ingested} casts.`);
			await refresh();
		} catch (err) {
			done();
			// A wallet rejection is the user changing their mind, not a failure.
			if (err?.code === 4001 || /user rejected|user denied/i.test(err?.message || '')) {
				showError('Signature declined. Nothing was read or stored.');
				return;
			}
			showError(messageFor(err));
		}
	}

	async function reseed(button) {
		const done = setBusy(button, 'Refreshing…');
		try {
			const result = await post(base, { intent: 'reseed' });
			toast(`Refreshed to ${result.seeded} ${result.seeded === 1 ? 'memory' : 'memories'}.`);
			await refresh();
		} catch (err) {
			done();
			showError(messageFor(err));
		}
	}

	async function revoke(button) {
		const ok = window.confirm(
			'Revoke Farcaster consent? Every memory seeded from your casts will be deleted from this agent.',
		);
		if (!ok) return;
		const done = setBusy(button, 'Deleting…');
		try {
			const result = await del(base);
			toast(`Consent revoked. Deleted ${result.deleted} ${result.deleted === 1 ? 'memory' : 'memories'}.`);
			await refresh();
		} catch (err) {
			done();
			showError(messageFor(err));
		}
	}

	async function refresh() {
		loadingView();
		try {
			const status = await get(base);
			challenge = null;
			if (status.connected) connectedView(status);
			else disconnectedView();
		} catch (err) {
			errorView(messageFor(err));
		}
	}

	ensureStyles();
	refresh();
	return { refresh };
}

// ── Styles ──────────────────────────────────────────────────────────────────

let stylesMounted = false;
function ensureStyles() {
	if (stylesMounted || document.getElementById('fc-seed-styles')) return;
	stylesMounted = true;
	const style = document.createElement('style');
	style.id = 'fc-seed-styles';
	style.textContent = `
		.fc-seed .fc-input {
			padding: 8px 11px; border-radius: 8px; border: 1px solid var(--nxt-stroke);
			background: rgba(255, 255, 255, 0.04); color: var(--nxt-ink);
			font: inherit; font-size: 13px; transition: border-color 140ms ease, box-shadow 140ms ease;
		}
		.fc-seed .fc-input:hover { border-color: var(--nxt-stroke-strong, rgba(255, 255, 255, 0.24)); }
		.fc-seed .fc-input:focus-visible {
			outline: none; border-color: var(--nxt-accent, #6ea8fe);
			box-shadow: 0 0 0 3px rgba(110, 168, 254, 0.25);
		}
		.fc-seed .fc-card {
			border: 1px solid var(--nxt-stroke); border-radius: 10px; padding: 12px;
			background: rgba(255, 255, 255, 0.03);
		}
		.fc-seed .fc-pill {
			font-size: 11px; font-weight: 600; letter-spacing: 0.02em; padding: 3px 8px;
			border-radius: 999px; color: var(--nxt-ok, #4ade80);
			background: color-mix(in srgb, var(--nxt-ok, #4ade80) 14%, transparent);
			border: 1px solid color-mix(in srgb, var(--nxt-ok, #4ade80) 32%, transparent);
		}
		.fc-seed .fc-skeleton {
			height: 12px; border-radius: 6px; margin-bottom: 8px;
			background: linear-gradient(90deg, rgba(255,255,255,0.05), rgba(255,255,255,0.12), rgba(255,255,255,0.05));
			background-size: 200% 100%; animation: fc-shimmer 1.3s ease-in-out infinite;
		}
		.fc-seed .fc-sr-only {
			position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
			overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
		}
		@keyframes fc-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
		@media (prefers-reduced-motion: reduce) {
			.fc-seed .fc-skeleton { animation: none; }
		}
	`;
	document.head.appendChild(style);
}
