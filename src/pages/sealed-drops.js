// Controller for the sealed wallet drops surface.
//
// Two entry points share this module:
//   • /vanity-wallet … (the "Send a sealed gift" composer — mounted when
//     #drop-create exists): builds the create flow (asset/amount, vanity, seal
//     mode, message/theme, expiry, reclaim address), pays the x402 create fee,
//     and shows the shareable link + QR + OG card.
//   • /drop/:id (the claim page — mounted when #drop-claim exists): loads the
//     drop, renders the gift, and on claim opens the SEALED envelope ENTIRELY
//     CLIENT-SIDE (with the claim key from the URL fragment in bearer mode, or
//     the recipient's pasted X25519 private key in direct mode), then offers
//     import / download / sweep. three.ws never sees the plaintext.
//
// All crypto is real: ECIES sealed-envelope (openSealed), SHA-256 claim-token
// derivation (drop-protocol), X25519 keygen. All money rails are real: x402 for
// the create fee, on-chain funding + reclaim server-side.
//
// STATUS (verified 2026-07-10): the backend this controller talks to is real
// and complete — api/vanity/drops.js (914 lines, create/claim/reveal/reclaim),
// the OG card generator at api/og/sealed-drop.js, and the crypto modules this
// file imports (src/solana/vanity/sealed-envelope.js,
// src/solana/vanity/drop-protocol.js) are all fully built. What's missing is
// every HTML page: no page anywhere has a `#drop-create`, `#drop-claim`, or
// `#drop-mine` element, so `boot()` below finds nothing to mount into.
// `/vanity-wallet` (public/vanity-wallet.html) is a same-named but unrelated
// existing page (Solana vanity ADDRESS grinding) — it does not contain a gift
// composer and was never meant to conflict with this feature; a dedicated
// entry point (and a `/drop/:id` claim page, routed the same way `/coin/:mint`
// rewrites to coin.html in vercel.json) still needs to be built. This needs
// careful, unhurried page-building — precise markup for ~30 element ids this
// file already expects (grep `$\\('dc-` here), a real private-key-handling UX
// review, and QR/share-card wiring — not a rushed pass, since a mistake here
// risks a user's actual funds/keys.

import bs58 from 'bs58';
import {
	generateRecipientKeypair,
	openSealedText,
	parseX25519Key,
} from '../solana/vanity/sealed-envelope.js';
import { deriveClaimToken, hashClaimToken } from '../solana/vanity/drop-protocol.js';

const API = '/api/vanity/drops';
const $ = (id) => document.getElementById(id);

export function esc(s) {
	return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function shortAddr(a) { const s = String(a || ''); return s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s; }
function assetLabel(a) { return a === 'THREE' ? '$THREE' : String(a || ''); }
function timeLeft(ms) {
	const d = ms - Date.now();
	if (d <= 0) return 'expired';
	const s = Math.floor(d / 1000);
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
	return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

async function api(path, opts) {
	const r = await fetch(`${API}${path}`, opts);
	const ct = r.headers.get('content-type') || '';
	const data = ct.includes('json') ? await r.json().catch(() => ({})) : {};
	if (!r.ok) {
		const e = new Error(data.error_description || data.error || `HTTP ${r.status}`);
		e.status = r.status; e.data = data;
		throw e;
	}
	return data;
}

function toast(msg) {
	let t = $('drop-toast');
	if (!t) { t = document.createElement('div'); t.id = 'drop-toast'; t.className = 'drop-toast'; document.body.appendChild(t); }
	t.textContent = msg; t.classList.add('show');
	clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

// ── shared: open a sealed envelope client-side and render the recovered key ────

function renderOpenedWallet(container, wallet, address) {
	const mnemonic = wallet.format === 'mnemonic' ? wallet.mnemonic : null;
	const cliJson = JSON.stringify(wallet.secretKey);
	container.innerHTML = `
		<div class="okbox show" role="status">🔓 Wallet opened in your browser. three.ws never saw this secret.</div>
		${mnemonic ? `<label class="fl">Seed phrase (import into Phantom / Solflare)</label><div class="keybox"><code id="op-mn">${esc(mnemonic)}</code><button class="ghost small" data-copy="op-mn">Copy phrase</button></div>` : ''}
		<label class="fl">Secret key (Base58)</label>
		<div class="keybox"><code id="op-sk">${esc(wallet.secretKeyBase58 || '')}</code><button class="ghost small" data-copy="op-sk">Copy key</button></div>
		<div class="row" style="margin-top:.8rem">
			<button class="ghost small" id="op-dl">Download Solana CLI JSON</button>
			<a class="ghost small" href="https://solscan.io/account/${esc(address)}" target="_blank" rel="noopener">View address on Solscan ↗</a>
		</div>
		<p class="note" style="margin-top:.8rem">Import the seed phrase or secret key into your wallet to take custody. Keep it private — it controls the funds.</p>`;
	container.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
		await navigator.clipboard?.writeText($(b.dataset.copy)?.textContent || '').catch(() => {});
		toast('Copied');
	}));
	$('op-dl')?.addEventListener('click', () => {
		const blob = new Blob([cliJson], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a'); a.href = url; a.download = `${address.slice(0, 8)}.json`; a.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	});
}

// ════════════════════════════════════════════════════════════════════════════
// CREATE flow  (#drop-create present)
// ════════════════════════════════════════════════════════════════════════════

function mountCreate() {
	const root = $('drop-create');
	if (!root) return;
	let config = null;
	let directKeypair = null; // { publicKey, secretKey } when the composer generates a recipient key

	const els = {
		asset: $('dc-asset'), amount: $('dc-amount'), seal: () => root.querySelector('input[name="dc-seal"]:checked')?.value || 'claim-time',
		directWrap: $('dc-direct-wrap'), recipient: $('dc-recipient'), genKey: $('dc-genkey'),
		prefix: $('dc-prefix'), suffix: $('dc-suffix'), format: $('dc-format'),
		message: $('dc-message'), theme: $('dc-theme'), sender: $('dc-sender'),
		expiry: $('dc-expiry'), reclaim: $('dc-reclaim'),
		btn: $('dc-submit'), hint: $('dc-hint'), err: $('dc-err'), result: $('dc-result'),
	};

	api('?view=config').then((c) => {
		config = c;
		if (!c.fundingConfigured) {
			els.hint.textContent = 'Sealed drops are unavailable in this environment (funding wallet not configured).';
			els.btn.disabled = true;
		} else {
			els.hint.textContent = `You’ll pay a $${c.createFeeUsd} create fee. The gift amount is funded on-chain into a fresh wallet.`;
		}
	}).catch(() => { els.hint.textContent = 'Could not load drop config — reload the page.'; });

	function syncSeal() {
		const mode = els.seal();
		els.directWrap.style.display = mode === 'direct' ? '' : 'none';
		root.querySelector('#dc-bearer-note').style.display = mode === 'claim-time' ? '' : 'none';
	}
	root.querySelectorAll('input[name="dc-seal"]').forEach((r) => r.addEventListener('change', syncSeal));
	syncSeal();

	els.genKey?.addEventListener('click', () => {
		directKeypair = generateRecipientKeypair();
		els.recipient.value = directKeypair.publicKey;
		const note = $('dc-genkey-note');
		note.innerHTML = `Generated. <strong>Give the recipient this private key</strong> — it is the ONLY way to open the gift:<br><code class="mono" style="word-break:break-all;color:#fcd34d">${esc(directKeypair.secretKey)}</code> <button class="ghost small" id="dc-copy-priv">Copy private key</button>`;
		note.style.display = '';
		$('dc-copy-priv')?.addEventListener('click', async () => { await navigator.clipboard?.writeText(directKeypair.secretKey).catch(() => {}); toast('Private key copied — share it securely'); });
	});

	els.btn?.addEventListener('click', submit);

	async function submit() {
		els.err.classList.remove('show');
		const asset = els.asset.value;
		const amount = els.amount.value.trim();
		const sealMode = els.seal();
		if (!amount || !(Number(amount) > 0)) { return showErr('Enter a gift amount greater than 0.'); }

		const bodyObj = {
			asset, amount, sealMode,
			prefix: els.prefix.value.trim(), suffix: els.suffix.value.trim(),
			format: els.format.value,
			expiryHours: String(Math.max(1, parseInt(els.expiry.value, 10) || 168)),
		};
		if (els.message.value.trim()) bodyObj.message = els.message.value.trim();
		if (els.theme.value) bodyObj.theme = els.theme.value;
		if (els.sender.value.trim()) bodyObj.senderLabel = els.sender.value.trim();
		if (els.reclaim.value.trim()) bodyObj.reclaimAddress = els.reclaim.value.trim();
		bodyObj.senderTag = localSenderTag();

		if (sealMode === 'direct') {
			const rk = els.recipient.value.trim();
			if (!rk) return showErr('Direct seal needs the recipient’s X25519 public key — paste it or generate a key pair.');
			try { parseX25519Key(rk, 'recipient'); } catch { return showErr('That recipient key is not a valid X25519 public key.'); }
			bodyObj.recipientPubKey = rk;
		}

		if (!window.X402?.pay) return showErr('Payment library failed to load — reload the page.');
		els.btn.disabled = true; const label = els.btn.textContent; els.btn.innerHTML = '<span class="spin"></span> Opening checkout…';
		try {
			const out = await window.X402.pay({
				endpoint: `${API}?action=create`,
				method: 'POST',
				body: bodyObj,
				merchant: 'three.ws Sealed Wallet Drops',
				action: `Create a ${esc(amount)} ${assetLabel(asset)} sealed gift`,
			});
			const res = out?.result;
			if (!res?.created) throw new Error(res?.error_description || res?.error || 'create did not confirm');
			renderCreated(res, sealMode, directKeypair);
			toast('Sealed drop created & funded');
		} catch (e) {
			showErr(e.message || 'Create failed.');
		} finally {
			els.btn.disabled = false; els.btn.textContent = label;
		}
	}

	function renderCreated(res, sealMode, dkp) {
		const id = res.drop.id;
		const claimUrl = res.claimUrl; // bearer: includes #k=…
		const shareUrl = res.shareUrl;
		const fundTx = res.funding?.tx;
		els.result.innerHTML = `
			<div class="okbox show">🎁 Your sealed drop is live and funded on-chain.</div>
			<div class="kv"><span class="k">Address</span><span class="v mono">${esc(shortAddr(res.drop.address))}</span></div>
			<div class="kv"><span class="k">Funded</span><span class="v">${esc(res.drop.amount)} ${assetLabel(res.drop.asset)}</span></div>
			${fundTx ? `<div class="kv"><span class="k">Funding tx</span><span class="v"><a class="mono" href="https://solscan.io/tx/${esc(fundTx)}" target="_blank" rel="noopener">${esc(fundTx.slice(0, 10))}… ↗</a></span></div>` : ''}
			<label class="fl" style="margin-top:1rem">Share this claim link</label>
			<div class="keybox"><code id="dc-link">${esc(claimUrl)}</code>
				<div class="row" style="margin-top:.5rem">
					<button class="primary small" id="dc-copylink">Copy link</button>
					<button class="ghost small" id="dc-share">Share…</button>
					<a class="ghost small" href="${esc(claimUrl)}" target="_blank" rel="noopener">Open claim page ↗</a>
				</div>
			</div>
			<div class="qrwrap" id="dc-qr" aria-label="Claim QR code"></div>
			${sealMode === 'claim-time'
				? `<div class="warnbox show" style="margin-top:.8rem">⚠️ The link contains the only key that opens this wallet. Anyone with the full link can claim it once. Send it privately. three.ws cannot recover it.</div>`
				: `<div class="okbox show" style="margin-top:.8rem">Sealed to the recipient’s key. Only they can open it — even with the link, no one else can.</div>`}
			<details style="margin-top:.8rem"><summary>Reclaim &amp; manage</summary>
				<p class="note">If this gift isn’t claimed before it expires (${timeLeft(res.drop.expiresAt)}), you can reclaim the funds. Your drops are remembered in this browser under <a href="/vanity-wallet#mine">My drops</a>.</p>
			</details>`;
		// QR rendered from the FULL claim link (with fragment) — client-side so the
		// claim key in the fragment is never sent to a server to make the QR.
		renderQr($('dc-qr'), claimUrl);
		$('dc-copylink')?.addEventListener('click', async () => { await navigator.clipboard?.writeText(claimUrl).catch(() => {}); toast('Claim link copied'); });
		$('dc-share')?.addEventListener('click', async () => {
			if (navigator.share) { try { await navigator.share({ title: 'A sealed gift for you', text: res.drop.message || 'Claim your sealed wallet', url: claimUrl }); } catch { /* cancelled */ } }
			else { await navigator.clipboard?.writeText(claimUrl).catch(() => {}); toast('Link copied (share not supported here)'); }
		});
		rememberDrop(id);
		els.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
	}

	function showErr(m) { els.err.textContent = m; els.err.classList.add('show'); }
}

// ════════════════════════════════════════════════════════════════════════════
// CLAIM flow  (#drop-claim present)
// ════════════════════════════════════════════════════════════════════════════

function dropIdFromPath() {
	const m = location.pathname.match(/\/drop\/([0-9a-f]{24})/);
	if (m) return m[1];
	const q = new URLSearchParams(location.search).get('id');
	return /^[0-9a-f]{24}$/.test(q || '') ? q : null;
}
function claimSecretFromFragment() {
	const m = location.hash.match(/[#&]k=([1-9A-HJ-NP-Za-km-z]+)/);
	return m ? m[1] : null;
}

async function mountClaim() {
	const root = $('drop-claim');
	if (!root) return;
	const id = dropIdFromPath();
	const stage = $('dc-stage');
	if (!id) { renderClaimError(stage, 'No drop in the link', 'This claim link is missing its drop id. Ask the sender for the original link.'); return; }

	stage.innerHTML = skeletonCard();
	let info;
	try {
		info = await api(`?view=get&id=${id}`);
	} catch (e) {
		if (e.status === 404) return renderClaimError(stage, 'Drop not found', 'This drop doesn’t exist. Check the link, or it may have been a typo.');
		return renderClaimError(stage, 'Couldn’t load this drop', e.message);
	}
	const drop = info.drop;
	if (!drop) return renderClaimError(stage, 'Drop not found', 'This drop doesn’t exist.');

	renderGiftHeader(stage, drop);

	if (drop.status === 'claimed') return renderAlreadyClaimed(stage, drop);
	if (drop.status === 'reclaimed') return renderReclaimed(stage, drop);
	if (info.expired) return renderExpired(stage, drop);

	// Claimable. Branch on seal mode.
	if (info.sealMode === 'claim-time') return renderBearerClaim(stage, drop, id);
	return renderDirectClaim(stage, drop, id);
}

function renderGiftHeader(stage, drop) {
	const themeGlyph = { default: '🎁', birthday: '🎂', congrats: '🎉', thanks: '🙏', welcome: '👋', tip: '⚡' }[drop.theme] || '🎁';
	stage.innerHTML = `
		<div class="gift theme-${esc(drop.theme || 'default')}">
			<div class="gift-glyph" aria-hidden="true">${themeGlyph}</div>
			${drop.senderLabel ? `<div class="gift-from">From <strong>${esc(drop.senderLabel)}</strong></div>` : ''}
			<div class="gift-amount">${esc(drop.amount)} <span>${assetLabel(drop.asset)}</span></div>
			${drop.message ? `<div class="gift-msg">“${esc(drop.message)}”</div>` : ''}
			<div class="gift-addr mono">${esc(shortAddr(drop.address))}</div>
			<div class="gift-badge">🔒 End-to-end sealed · only you can open it</div>
		</div>
		<div id="dc-action"></div>`;
}

function renderBearerClaim(stage, drop, id) {
	const action = $('dc-action');
	const secret = claimSecretFromFragment();
	if (!secret) {
		action.innerHTML = `
			<div class="warnbox show">This is a bearer gift — the claim key lives in the link itself. Your link is missing the <code>#k=…</code> part. Ask the sender to re-send the FULL link (it’s long and ends in <code>#k=…</code>).</div>`;
		return;
	}
	action.innerHTML = `
		<button class="primary big" id="dc-claimbtn">Claim this gift</button>
		<p class="note" id="dc-claimnote">Claiming opens the sealed wallet right here in your browser. three.ws never sees the key.</p>
		<div id="dc-opened"></div>`;
	$('dc-claimbtn').addEventListener('click', () => claimBearer(id, secret));
}

async function claimBearer(id, secretB58) {
	const btn = $('dc-claimbtn'); const note = $('dc-claimnote'); const opened = $('dc-opened');
	btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Claiming…';
	try {
		// Derive the one-time claim token from the secret in the link (client-side).
		const secretBytes = bs58.decode(secretB58);
		const claimToken = deriveClaimToken(id, secretBytes);
		const res = await api('?action=claim', {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id, claimToken }),
		});
		if (!res.claimed) throw new Error(res.reason || 'claim did not confirm');
		// Open the sealed envelope ENTIRELY client-side with the claim secret.
		const plaintext = await openSealedText(res.sealedSecret, secretB58);
		const wallet = JSON.parse(plaintext);
		note.textContent = 'Claimed. Your wallet is below — import it to take custody.';
		renderOpenedWallet(opened, wallet, res.address);
		btn.style.display = 'none';
	} catch (e) {
		btn.disabled = false; btn.innerHTML = 'Claim this gift';
		if (e.status === 409) { note.innerHTML = `<span style="color:#fca5a5">This gift was already claimed.</span>`; btn.style.display = 'none'; }
		else if (e.status === 403) { note.innerHTML = `<span style="color:#fca5a5">This claim link’s key is wrong — use the original full link.</span>`; }
		else { note.innerHTML = `<span style="color:#fca5a5">Couldn’t claim: ${esc(e.message)}</span>`; }
	}
}

function renderDirectClaim(stage, drop, id) {
	const action = $('dc-action');
	action.innerHTML = `
		<div class="okbox show">This gift was sealed to your encryption key. Paste your X25519 <strong>private key</strong> to open it — it stays in your browser.</div>
		<label class="fl">Your X25519 private key</label>
		<input class="t" id="dc-priv" type="password" autocomplete="off" placeholder="Base58 / Base64url / hex private key" />
		<button class="primary big" id="dc-openbtn" style="margin-top:.7rem">Open my gift</button>
		<p class="note" id="dc-opennote">three.ws never receives this key. The decrypt happens locally.</p>
		<div id="dc-opened"></div>`;
	$('dc-openbtn').addEventListener('click', () => claimDirect(id, drop));
}

async function claimDirect(id, drop) {
	const priv = $('dc-priv').value.trim();
	const note = $('dc-opennote'); const opened = $('dc-opened'); const btn = $('dc-openbtn');
	if (!priv) { note.innerHTML = '<span style="color:#fca5a5">Paste your private key first.</span>'; return; }
	btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Opening…';
	try {
		// Mark the gift claimed (atomic) + fetch the sealed envelope, then open it
		// locally. In direct mode the envelope is also fetchable via reveal, but
		// claim records the "opened" state and is exactly-once.
		const res = await api('?action=claim', {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id }),
		}).catch(async (e) => {
			// If already claimed, fall back to reveal so the rightful key-holder can
			// still open it (the envelope is useless without their private key).
			if (e.status === 409) return api('?action=reveal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
			throw e;
		});
		const env = res.sealedSecret;
		const plaintext = await openSealedText(env, priv);
		const wallet = JSON.parse(plaintext);
		if (wallet.secretKeyBase58 && res.address) {
			const kpAddr = bs58.encode(bs58.decode(wallet.secretKeyBase58).slice(32));
			if (kpAddr !== res.address) throw new Error('decrypted key does not match the gift address');
		}
		note.textContent = 'Opened. Import the wallet below to take custody.';
		renderOpenedWallet(opened, wallet, res.address || drop.address);
		btn.style.display = 'none';
	} catch (e) {
		btn.disabled = false; btn.innerHTML = 'Open my gift';
		note.innerHTML = `<span style="color:#fca5a5">${esc(e.message?.includes('decrypt') || e.name === 'OperationError' ? 'That key can’t open this gift — wrong private key.' : (e.message || 'Open failed.'))}</span>`;
	}
}

function renderAlreadyClaimed(stage, drop) {
	$('dc-action').innerHTML = `<div class="statebox claimed"><div class="se-glyph">✅</div><h3>Already claimed</h3><p>This gift has already been opened${drop.claimedAt ? ` on ${new Date(drop.claimedAt).toLocaleDateString()}` : ''}. There’s nothing left to claim.</p><a class="ghost" href="https://solscan.io/account/${esc(drop.address)}" target="_blank" rel="noopener">View the wallet ↗</a></div>`;
}
function renderReclaimed(stage, drop) {
	$('dc-action').innerHTML = `<div class="statebox reclaimed"><div class="se-glyph">↩️</div><h3>Returned to sender</h3><p>This gift expired unclaimed, so the funds were reclaimed by the sender. Reach out to them if you were expecting it.</p></div>`;
}
function renderExpired(stage, drop) {
	$('dc-action').innerHTML = `<div class="statebox expired"><div class="se-glyph">⌛</div><h3>This gift expired</h3><p>It wasn’t claimed in time, so it can no longer be opened. The sender can reclaim the funds. Ask them to send a fresh drop.</p></div>`;
}
function renderClaimError(stage, title, msg) {
	stage.innerHTML = `<div class="statebox error"><div class="se-glyph">⚠️</div><h3>${esc(title)}</h3><p>${esc(msg)}</p><a class="ghost" href="/vanity-wallet">Create your own sealed drop →</a></div>`;
}
function skeletonCard() {
	return `<div class="gift skel-gift" aria-hidden="true"><div class="skel-line w40"></div><div class="skel-line w70 big"></div><div class="skel-line w50"></div></div><p class="note" style="text-align:center">Loading your gift…</p>`;
}

// ── local "my drops" memory (so a sender can find drops to reclaim) ───────────

const TAG_KEY = 'twx_drop_sender_tag';
const MINE_KEY = 'twx_my_drops';
function localSenderTag() {
	let t = localStorage.getItem(TAG_KEY);
	if (!t) { t = 'st_' + bs58.encode(crypto.getRandomValues(new Uint8Array(12))); localStorage.setItem(TAG_KEY, t); }
	return t;
}
function rememberDrop(id) {
	try {
		const list = JSON.parse(localStorage.getItem(MINE_KEY) || '[]');
		if (!list.includes(id)) { list.unshift(id); localStorage.setItem(MINE_KEY, JSON.stringify(list.slice(0, 100))); }
	} catch { /* ignore */ }
}

async function mountMine() {
	const root = $('drop-mine');
	if (!root) return;
	const list = $('dm-list');
	const tag = localStorage.getItem(TAG_KEY);
	if (!tag) { list.innerHTML = `<div class="empty"><div class="glyph">🎁</div><h3>No drops yet</h3><p>Sealed gifts you create will appear here so you can reclaim any that expire unclaimed.</p></div>`; return; }
	list.innerHTML = `<div class="skel" style="height:90px"></div>`;
	let drops = [];
	try { ({ drops } = await api(`?view=mine&senderTag=${encodeURIComponent(tag)}`)); }
	catch (e) { list.innerHTML = `<div class="errbox show">Couldn’t load your drops: ${esc(e.message)}</div>`; return; }
	if (!drops.length) { list.innerHTML = `<div class="empty"><div class="glyph">🎁</div><h3>No drops yet</h3><p>Sealed gifts you create will appear here.</p></div>`; return; }
	list.innerHTML = drops.map(mineRow).join('');
	list.querySelectorAll('[data-reclaim]').forEach((b) => b.addEventListener('click', () => reclaim(b.dataset.reclaim, b)));
	list.querySelectorAll('[data-copy-link]').forEach((b) => b.addEventListener('click', async () => { await navigator.clipboard?.writeText(`${location.origin}/drop/${b.dataset.copyLink}`).catch(() => {}); toast('Share link copied'); }));
}

function mineRow(d) {
	const expired = d.status === 'funded' && d.expiresAt && Date.now() > d.expiresAt;
	const statusLabel = d.status === 'claimed' ? 'Claimed' : d.status === 'reclaimed' ? 'Reclaimed' : expired ? 'Expired' : 'Unclaimed';
	const statusClass = d.status === 'claimed' ? 'claimed' : d.status === 'reclaimed' ? 'reclaimed' : expired ? 'expired' : 'open';
	return `<div class="minerow">
		<div>
			<div class="mr-amt">${esc(d.amount)} ${assetLabel(d.asset)}</div>
			<div class="mr-meta mono">${esc(shortAddr(d.address))} · <span class="dot ${statusClass}"></span>${statusLabel}${d.status === 'funded' && !expired ? ` · ${timeLeft(d.expiresAt)} left` : ''}</div>
		</div>
		<div class="mr-actions">
			${d.status === 'funded' && !expired ? `<button class="ghost small" data-copy-link="${esc(d.id)}">Copy link</button>` : ''}
			${expired ? `<button class="primary small" data-reclaim="${esc(d.id)}">Reclaim funds</button>` : ''}
		</div>
	</div>`;
}

async function reclaim(id, btn) {
	const reclaimAddr = prompt('Reclaim the funds to which Solana address?');
	if (!reclaimAddr) return;
	btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Reclaiming…';
	try {
		const res = await api('?action=reclaim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, reclaimAddress: reclaimAddr.trim() }) });
		if (!res.reclaimed) throw new Error(res.reason || 'reclaim did not confirm');
		toast('Funds reclaimed');
		btn.outerHTML = res.reclaimTx && res.reclaimTx !== 'empty' ? `<a class="ghost small" href="${esc(res.explorerUrl)}" target="_blank" rel="noopener">Reclaimed ↗</a>` : `<span class="note">Reclaimed (was empty)</span>`;
	} catch (e) {
		btn.disabled = false; btn.innerHTML = 'Reclaim funds';
		toast(e.message || 'Reclaim failed');
	}
}

// ── QR helper (lazy-loads qrcode) ─────────────────────────────────────────────

let _qrcodeMod = null;
async function renderQr(container, text) {
	if (!container) return;
	try {
		if (!_qrcodeMod) _qrcodeMod = (await import('qrcode')).default;
		const svg = await _qrcodeMod.toString(text, { type: 'svg', margin: 1, width: 200, color: { dark: '#000', light: '#fff' } });
		container.innerHTML = `<div class="qrbox">${svg}</div><span class="qrcap">Scan to claim</span>`;
	} catch {
		container.innerHTML = `<span class="qrcap">QR unavailable — share the link above.</span>`;
	}
}

// ── boot ──────────────────────────────────────────────────────────────────────

function boot() {
	mountCreate();
	mountClaim();
	mountMine();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

export { deriveClaimToken, hashClaimToken };
