// The deployer. A static page that mints a real agent on Solana.
//
// It shares its builders with the MCP server one directory over
// (../../src/lib), so an agent minting itself over MCP and a person minting
// here produce byte-identical assets: same Genesis-333 plugin set, same
// EIP-8004 registration document, same data: URIs.
//
// Signing has two paths and no third: an injected wallet signs the built
// transactions, or a wallet created in this browser signs them with a key that
// never leaves the tab. Nothing is ever sent to a server, because there is no
// server.

import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { signerIdentity, createNoopSigner, publicKey as umiPublicKey } from '@metaplex-foundation/umi';
import { mplCore, findAssetSignerPda } from '@metaplex-foundation/mpl-core';
import { mplAgentIdentity } from '@metaplex-foundation/mpl-agent-registry';
import { Connection, PublicKey, VersionedTransaction, Transaction } from '@solana/web3.js';

import { buildAgentMint, sendAgentMint } from '../../src/lib/mint.js';
import {
	buildAssetMetadata,
	buildRegistrationDoc,
	chainRegistration,
	jsonDataUri,
} from '../../src/lib/registration.js';
import { toBase58Signature } from '../../src/lib/solana.js';
import { resolveEndpoint, validateRpc, saveCustomRpc, customRpc, rpcCall } from './rpc.js';
import {
	detectInjected,
	HostedWallet,
	hostedWalletExists,
	hostedWalletAddress,
	forgetHostedWallet,
	backupBlob,
} from './wallet.js';
import { browseAvatars, importAvatar, recentDeployments } from './threews.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (a) => (a && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MINT_COST_SOL = 0.007;

const state = {
	network: 'devnet',
	endpoint: null,
	endpointSource: 'none',
	wallet: null, // { kind: 'injected'|'hosted', address, provider?, hosted? }
	source: 'custom',
	previewDoc: 'registration',
	pickerCursor: '',
	deploying: false,
};

/* ── Umi ──────────────────────────────────────────────────────────────── */

function umiFor(endpoint) {
	return createUmi(endpoint).use(mplCore()).use(mplAgentIdentity());
}

/** A umi instance that can build (but not necessarily send) without an endpoint. */
function previewUmi() {
	return umiFor(state.endpoint || 'https://api.devnet.solana.com');
}

/* ── Theme ────────────────────────────────────────────────────────────── */

$('theme-toggle').addEventListener('click', () => {
	const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
	document.documentElement.setAttribute('data-theme', next);
	try {
		localStorage.setItem('map.theme', next);
	} catch {
		// private mode: the choice just does not persist
	}
});

/* ── Copy buttons ─────────────────────────────────────────────────────── */

document.addEventListener('click', (e) => {
	const btn = e.target.closest('.copy');
	if (!btn) return;
	const src = $(btn.dataset.copy);
	if (!src) return;
	navigator.clipboard.writeText(src.textContent.trim()).then(() => {
		const original = btn.textContent;
		btn.textContent = 'Copied';
		btn.classList.add('done');
		setTimeout(() => {
			btn.textContent = original;
			btn.classList.remove('done');
		}, 1400);
	});
});

/* ── Network + RPC ────────────────────────────────────────────────────── */

async function applyNetwork(network) {
	state.network = network;
	for (const btn of document.querySelectorAll('.net-btn')) {
		const on = btn.dataset.net === network;
		btn.classList.toggle('active', on);
		btn.setAttribute('aria-checked', String(on));
	}
	$('rail-net').textContent = network === 'devnet' ? 'Devnet (rehearsal)' : 'Solana mainnet';
	$('rail-rpc').textContent = 'Checking endpoint…';
	$('airdrop-btn').hidden = !(network === 'devnet' && state.wallet);

	const { endpoint, source } = await resolveEndpoint(network);
	state.endpoint = endpoint;
	state.endpointSource = source;
	$('rail-rpc').textContent =
		source === 'custom'
			? `Your endpoint: ${new URL(endpoint).host}`
			: source === 'threews'
				? 'three.ws public proxy'
				: source === 'public'
					? 'Solana public devnet'
					: 'No endpoint available. Add your own to continue.';
	if (state.wallet) refreshBalance();
	render();
}

$('rpc-btn').addEventListener('click', () => {
	$('rpc-modal-net').textContent = state.network;
	$('rpc-input').value = customRpc(state.network);
	$('rpc-error').hidden = true;
	$('rpc-ok').hidden = true;
	$('rpc-modal').showModal();
});

$('rpc-save').addEventListener('click', async () => {
	const url = $('rpc-input').value.trim();
	$('rpc-error').hidden = true;
	$('rpc-ok').hidden = true;
	if (!url) {
		$('rpc-error').textContent = 'Paste an endpoint URL first.';
		$('rpc-error').hidden = false;
		return;
	}
	$('rpc-save').disabled = true;
	$('rpc-save').textContent = 'Verifying…';
	const result = await validateRpc(url, state.network);
	$('rpc-save').disabled = false;
	$('rpc-save').textContent = 'Verify and save';
	if (!result.ok) {
		$('rpc-error').textContent = result.message;
		$('rpc-error').hidden = false;
		return;
	}
	saveCustomRpc(state.network, url);
	$('rpc-ok').textContent = `${result.message} Using it for ${state.network}.`;
	$('rpc-ok').hidden = false;
	await applyNetwork(state.network);
	setTimeout(() => $('rpc-modal').close(), 900);
});

$('rpc-clear').addEventListener('click', async () => {
	saveCustomRpc(state.network, '');
	$('rpc-input').value = '';
	await applyNetwork(state.network);
	$('rpc-modal').close();
});

for (const btn of document.querySelectorAll('.net-btn')) {
	btn.addEventListener('click', () => applyNetwork(btn.dataset.net));
}

/* ── Wallet ───────────────────────────────────────────────────────────── */

function renderWalletChoices() {
	const injected = detectInjected();
	$('injected-list').innerHTML = injected
		.map(
			(w, i) =>
				`<button type="button" class="choice" data-injected="${i}">` +
				`<span class="choice-ic" aria-hidden="true">${esc(w.label.slice(0, 1))}</span>` +
				`<span class="choice-body"><strong>${esc(w.label)}</strong><small>Detected in this browser</small></span></button>`,
		)
		.join('');
	for (const btn of $('injected-list').querySelectorAll('[data-injected]')) {
		btn.addEventListener('click', () => connectInjected(injected[Number(btn.dataset.injected)]));
	}
	$('no-wallet-hint').hidden = injected.length > 0;

	const exists = hostedWalletExists();
	$('unlock-wallet-btn').hidden = !exists;
	$('create-wallet-btn').hidden = exists;
	if (exists) $('unlock-wallet-sub').textContent = `Wallet ${short(hostedWalletAddress())} is stored in this browser.`;
}

async function connectInjected(entry) {
	$('wallet-error').hidden = true;
	try {
		const res = await entry.provider.connect();
		const pk = res?.publicKey || entry.provider.publicKey;
		if (!pk) throw new Error('The wallet connected but gave no address.');
		setWallet({ kind: 'injected', label: entry.label, address: pk.toString(), provider: entry.provider });
	} catch (err) {
		showWalletError(
			/reject|denied|4001/i.test(err?.message || '')
				? 'The wallet dismissed the request. Try again when you are ready.'
				: `Could not connect: ${err?.message || err}`,
		);
	}
}

function setWallet(wallet) {
	state.wallet = wallet;
	$('wallet-choices').hidden = true;
	$('wallet-connected').hidden = false;
	$('wallet-status').textContent = 'Connected';
	$('wallet-kind').textContent = wallet.kind === 'hosted' ? 'This browser' : wallet.label;
	$('wallet-address').textContent = short(wallet.address);
	$('wallet-address').title = wallet.address;
	$('wallet-manage-btn').hidden = wallet.kind !== 'hosted';
	$('airdrop-btn').hidden = state.network !== 'devnet';
	refreshBalance();
	render();
}

function showWalletError(message) {
	$('wallet-error').textContent = message;
	$('wallet-error').hidden = false;
}

$('disconnect-btn').addEventListener('click', () => {
	try {
		state.wallet?.provider?.disconnect?.();
	} catch {
		// providers may throw with no active session; nothing to undo
	}
	state.wallet = null;
	$('wallet-choices').hidden = false;
	$('wallet-connected').hidden = true;
	$('wallet-status').textContent = 'Not connected';
	renderWalletChoices();
	render();
});

async function refreshBalance() {
	if (!state.wallet || !state.endpoint) {
		$('wallet-balance').textContent = '';
		return;
	}
	try {
		const result = await rpcCall(state.endpoint, 'getBalance', [state.wallet.address]);
		const sol = (result?.value ?? 0) / 1e9;
		state.balance = sol;
		$('wallet-balance').textContent = `${sol.toFixed(4)} SOL`;
		const short_ = sol < MINT_COST_SOL;
		$('funding-warn').hidden = !short_;
		if (short_) {
			$('funding-warn').textContent =
				state.network === 'devnet'
					? `This wallet holds ${sol.toFixed(4)} SOL. A mint costs about ${MINT_COST_SOL} SOL. Use "Get devnet SOL" above, it is free.`
					: `This wallet holds ${sol.toFixed(4)} SOL. A mint costs about ${MINT_COST_SOL} SOL. Send some SOL to ${state.wallet.address} and it will update here.`;
		}
	} catch {
		$('wallet-balance').textContent = 'balance unavailable';
	}
	render();
}

$('airdrop-btn').addEventListener('click', async () => {
	if (!state.wallet || !state.endpoint) return;
	const btn = $('airdrop-btn');
	btn.disabled = true;
	btn.textContent = 'Requesting…';
	try {
		await rpcCall(state.endpoint, 'requestAirdrop', [state.wallet.address, 1_000_000_000]);
		for (let i = 0; i < 12; i++) {
			await sleep(2000);
			await refreshBalance();
			if ((state.balance || 0) > 0) break;
		}
	} catch (err) {
		showWalletError(
			`The devnet faucet declined: ${err?.message || err}. Faucets rate-limit hard; wait a minute, or use https://faucet.solana.com with your address.`,
		);
	} finally {
		btn.disabled = false;
		btn.textContent = 'Get devnet SOL';
	}
});

/* ── Hosted wallet flows ──────────────────────────────────────────────── */

function openModal(html) {
	$('wallet-modal-body').innerHTML = html;
	$('wallet-modal').showModal();
	return $('wallet-modal-body');
}

$('create-wallet-btn').addEventListener('click', () => {
	const body = openModal(`
		<h3>Create a wallet</h3>
		<p>This makes a real Solana wallet inside your browser. The secret key is encrypted with the passphrase you choose and stored only on this device. We never see it: this page has no server.</p>
		<label class="field"><span class="label">Passphrase</span><input type="password" id="m-pass" autocomplete="new-password" placeholder="At least 8 characters" /></label>
		<label class="field"><span class="label">Confirm passphrase</span><input type="password" id="m-pass2" autocomplete="new-password" /></label>
		<p class="danger-note">If you lose this passphrase or clear your browser data, the wallet and anything in it are gone. You will get a backup file in the next step. Keep it.</p>
		<p class="error" id="m-err" role="alert" hidden></p>
		<div class="modal-actions">
			<button type="button" class="btn btn-ghost" id="m-import">I have a secret key</button>
			<button type="button" class="btn btn-primary" id="m-create">Create wallet</button>
		</div>`);

	body.querySelector('#m-create').addEventListener('click', async () => {
		const pass = body.querySelector('#m-pass').value;
		const pass2 = body.querySelector('#m-pass2').value;
		const err = body.querySelector('#m-err');
		if (pass.length < 8) return fail(err, 'Use at least 8 characters.');
		if (pass !== pass2) return fail(err, 'The two passphrases do not match.');
		const wallet = await HostedWallet.create(previewUmi(), pass);
		showBackup(wallet);
	});

	body.querySelector('#m-import').addEventListener('click', () => openImport());
});

function fail(el, message) {
	el.textContent = message;
	el.hidden = false;
}

function openImport() {
	const body = openModal(`
		<h3>Import a wallet</h3>
		<p>Paste a base58 secret key (or a JSON byte array). It is encrypted with your passphrase and stored only in this browser.</p>
		<label class="field"><span class="label">Secret key</span><input type="password" id="m-secret" autocomplete="off" placeholder="base58 secret key" /></label>
		<label class="field"><span class="label">Passphrase to encrypt it</span><input type="password" id="m-pass" autocomplete="new-password" placeholder="At least 8 characters" /></label>
		<p class="error" id="m-err" role="alert" hidden></p>
		<div class="modal-actions"><button type="button" class="btn btn-primary" id="m-go">Import</button></div>`);

	body.querySelector('#m-go').addEventListener('click', async () => {
		const err = body.querySelector('#m-err');
		const pass = body.querySelector('#m-pass').value;
		if (pass.length < 8) return fail(err, 'Use at least 8 characters.');
		try {
			const wallet = await HostedWallet.importSecret(previewUmi(), body.querySelector('#m-secret').value, pass);
			$('wallet-modal').close();
			setWallet({ kind: 'hosted', address: wallet.address, hosted: wallet });
			renderWalletChoices();
		} catch (e) {
			fail(err, e.message);
		}
	});
}

function showBackup(wallet) {
	const secret = wallet.exportSecretKey();
	const body = openModal(`
		<h3>Back this up now</h3>
		<p>This secret key IS the wallet. Anyone who has it controls the agent you are about to mint and anything it holds.</p>
		<div class="secret-box" id="m-secret-text">${esc(secret)}</div>
		<div class="modal-actions" style="justify-content:flex-start">
			<button type="button" class="btn btn-ghost btn-sm copy" data-copy="m-secret-text">Copy</button>
			<button type="button" class="btn btn-ghost btn-sm" id="m-download">Download backup file</button>
		</div>
		<p class="danger-note" style="margin-top:16px">Store it somewhere only you can reach: a password manager, not a chat window. This page cannot recover it for you.</p>
		<label class="check" style="margin-top:16px"><input type="checkbox" id="m-ack" /> <span>I saved it somewhere safe</span></label>
		<div class="modal-actions"><button type="button" class="btn btn-primary" id="m-done" disabled>Use this wallet</button></div>`);

	body.querySelector('#m-download').addEventListener('click', () => {
		const url = URL.createObjectURL(backupBlob(wallet.address, secret));
		const a = document.createElement('a');
		a.href = url;
		a.download = `solana-wallet-${wallet.address.slice(0, 8)}.json`;
		a.click();
		URL.revokeObjectURL(url);
	});
	body.querySelector('#m-ack').addEventListener('change', (e) => {
		body.querySelector('#m-done').disabled = !e.target.checked;
	});
	body.querySelector('#m-done').addEventListener('click', () => {
		$('wallet-modal').close();
		setWallet({ kind: 'hosted', address: wallet.address, hosted: wallet });
		renderWalletChoices();
	});
}

$('unlock-wallet-btn').addEventListener('click', () => {
	const body = openModal(`
		<h3>Unlock your wallet</h3>
		<p>Wallet <code>${esc(short(hostedWalletAddress()))}</code> is stored in this browser. Enter the passphrase you set when you created it.</p>
		<label class="field"><span class="label">Passphrase</span><input type="password" id="m-pass" autocomplete="current-password" /></label>
		<p class="error" id="m-err" role="alert" hidden></p>
		<div class="modal-actions">
			<button type="button" class="btn btn-ghost" id="m-forget">Forget this wallet</button>
			<button type="button" class="btn btn-primary" id="m-unlock">Unlock</button>
		</div>`);

	const unlock = async () => {
		const err = body.querySelector('#m-err');
		try {
			const wallet = await HostedWallet.unlock(previewUmi(), body.querySelector('#m-pass').value);
			$('wallet-modal').close();
			setWallet({ kind: 'hosted', address: wallet.address, hosted: wallet });
		} catch (e) {
			fail(err, e.message);
		}
	};
	body.querySelector('#m-unlock').addEventListener('click', unlock);
	body.querySelector('#m-pass').addEventListener('keydown', (e) => {
		if (e.key === 'Enter') unlock();
	});
	body.querySelector('#m-forget').addEventListener('click', () => {
		if (!confirm('Remove this wallet from the browser? Without your backup the key is gone for good.')) return;
		forgetHostedWallet();
		$('wallet-modal').close();
		renderWalletChoices();
	});
});

$('wallet-manage-btn').addEventListener('click', () => {
	const wallet = state.wallet?.hosted;
	if (!wallet) return;
	const body = openModal(`
		<h3>Your wallet</h3>
		<p>Address <code>${esc(wallet.address)}</code></p>
		<div class="modal-actions" style="justify-content:flex-start">
			<button type="button" class="btn btn-ghost btn-sm" id="m-reveal">Reveal secret key</button>
			<button type="button" class="btn btn-ghost btn-sm" id="m-download">Download backup</button>
		</div>
		<div id="m-secret-wrap" hidden><div class="secret-box" id="m-secret-text"></div></div>
		<p class="danger-note" style="margin-top:16px">Import this key into Phantom or Solflare any time to use the same wallet there.</p>`);

	body.querySelector('#m-reveal').addEventListener('click', () => {
		body.querySelector('#m-secret-text').textContent = wallet.exportSecretKey();
		body.querySelector('#m-secret-wrap').hidden = false;
	});
	body.querySelector('#m-download').addEventListener('click', () => {
		const url = URL.createObjectURL(backupBlob(wallet.address, wallet.exportSecretKey()));
		const a = document.createElement('a');
		a.href = url;
		a.download = `solana-wallet-${wallet.address.slice(0, 8)}.json`;
		a.click();
		URL.revokeObjectURL(url);
	});
});

/* ── Source toggle + three.ws import ──────────────────────────────────── */

for (const btn of document.querySelectorAll('.seg-btn')) {
	btn.addEventListener('click', () => {
		state.source = btn.dataset.source;
		for (const b of document.querySelectorAll('.seg-btn')) {
			b.classList.toggle('active', b === btn);
			b.setAttribute('aria-checked', String(b === btn));
		}
		$('source-custom').hidden = state.source !== 'custom';
		$('source-threews').hidden = state.source !== 'threews';
		if (state.source === 'threews' && !$('avatar-picker').dataset.loaded) loadPicker();
	});
}

async function loadPicker(append = false) {
	const picker = $('avatar-picker');
	if (!append) picker.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
	try {
		const { items, cursor } = await browseAvatars({ limit: 8, cursor: append ? state.pickerCursor : '' });
		state.pickerCursor = cursor;
		if (!append) picker.innerHTML = '';
		if (!items.length && !append) {
			picker.innerHTML = '<p class="hint">No three.ws avatars available right now. Paste a link above, or use your own URLs.</p>';
			return;
		}
		for (const item of items) {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'picker-item';
			btn.innerHTML =
				`<img src="${esc(item.image)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />` +
				`<span>${esc(item.name)}</span>`;
			btn.addEventListener('click', () => applyAvatar(item, btn));
			picker.appendChild(btn);
		}
		picker.dataset.loaded = '1';
		$('picker-more').hidden = !cursor;
	} catch {
		picker.innerHTML = '<p class="hint">Could not reach three.ws just now. Paste an avatar link above, or use your own URLs.</p>';
	}
}

$('picker-more').addEventListener('click', () => loadPicker(true));

function applyAvatar(item, btn) {
	for (const el of $('avatar-picker').querySelectorAll('.picker-item')) el.classList.remove('selected');
	if (btn) btn.classList.add('selected');
	state.imported = item;
	if (!$('f-name').value.trim()) $('f-name').value = item.name.slice(0, 60);
	if (!$('f-description').value.trim() && item.description) $('f-description').value = item.description;
	$('f-image').value = item.image;
	$('f-model').value = item.modelUrl;
	$('name-count').textContent = String($('f-name').value.length);
	render();
}

$('import-btn').addEventListener('click', async () => {
	const err = $('import-error');
	err.hidden = true;
	$('import-btn').disabled = true;
	try {
		applyAvatar(await importAvatar($('f-threews').value), null);
	} catch (e) {
		err.textContent = e.message;
		err.hidden = false;
	} finally {
		$('import-btn').disabled = false;
	}
});

/* ── Repeating rows ───────────────────────────────────────────────────── */

function addRow(containerId, html) {
	const row = document.createElement('div');
	row.className = 'row';
	row.innerHTML = `${html}<button type="button" class="row-del" aria-label="Remove">&times;</button>`;
	row.querySelector('.row-del').addEventListener('click', () => {
		row.remove();
		render();
	});
	row.addEventListener('input', render);
	$(containerId).appendChild(row);
	return row;
}

$('add-service').addEventListener('click', () =>
	addRow(
		'services-rows',
		'<input type="text" class="svc-name" placeholder="Name, e.g. chat" aria-label="Service name" />' +
			'<input type="url" class="svc-url" placeholder="https://…" aria-label="Service endpoint" />',
	),
);
$('add-creator').addEventListener('click', () =>
	addRow(
		'creators-rows',
		'<input type="text" class="cr-addr" placeholder="Wallet address" aria-label="Recipient address" />' +
			'<input type="number" class="cr-pct narrow" min="0" max="100" placeholder="%" aria-label="Share" />',
	),
);
$('add-attr').addEventListener('click', () =>
	addRow(
		'attrs-rows',
		'<input type="text" class="at-key" placeholder="key" aria-label="Attribute key" />' +
			'<input type="text" class="at-val" placeholder="value" aria-label="Attribute value" />',
	),
);

const rowValues = (containerId, map) => [...$(containerId).querySelectorAll('.row')].map(map);

/* ── Form model ───────────────────────────────────────────────────────── */

function params() {
	const creators = rowValues('creators-rows', (r) => ({
		address: r.querySelector('.cr-addr').value.trim(),
		percentage: Number(r.querySelector('.cr-pct').value),
	})).filter((c) => c.address);
	const trust = $('f-trust').value.split(',').map((t) => t.trim()).filter(Boolean);

	return {
		network: state.network,
		creator: state.wallet?.address || '11111111111111111111111111111111',
		owner: $('f-owner').value.trim() || undefined,
		collection: $('f-collection').value.trim() || undefined,
		name: $('f-name').value.trim(),
		description: $('f-description').value.trim(),
		image: $('f-image').value.trim() || undefined,
		modelUrl: $('f-model').value.trim() || undefined,
		services: rowValues('services-rows', (r) => ({
			name: r.querySelector('.svc-name').value.trim(),
			endpoint: r.querySelector('.svc-url').value.trim(),
		})).filter((s) => s.name && s.endpoint),
		active: $('f-active').checked,
		x402Support: $('f-x402').checked,
		supportedTrust: trust.length ? trust : ['reputation'],
		royaltyBasisPoints: Number($('f-royalty').value || 0),
		royaltyCreators: creators.length ? creators : undefined,
		verifiedCreator: $('p-verified').checked,
		immutableMetadata: $('p-immutable').checked,
		attributes: rowValues('attrs-rows', (r) => ({
			key: r.querySelector('.at-key').value.trim(),
			value: r.querySelector('.at-val').value.trim(),
		})).filter((a) => a.key),
		permanentFreeze: $('p-freeze').checked,
		permanentTransfer: $('p-transfer').checked,
		permanentBurn: $('p-burn').checked,
		addBlocker: $('p-addblocker').checked,
		metadataUri: $('f-metadata-uri').value.trim() || undefined,
		registrationUri: $('f-registration-uri').value.trim() || undefined,
	};
}

function problemWith(p) {
	if (!p.name) return 'Name your agent to continue';
	if (!Number.isInteger(p.royaltyBasisPoints) || p.royaltyBasisPoints < 0 || p.royaltyBasisPoints > 10000) {
		return 'Royalty must be between 0 and 10000 bps';
	}
	if (p.royaltyCreators) {
		const total = p.royaltyCreators.reduce((sum, c) => sum + c.percentage, 0);
		if (total !== 100) return `Royalty shares total ${total}%, they must total 100%`;
	}
	if (!state.wallet) return 'Connect a wallet first';
	if (!state.endpoint) return 'Add an RPC endpoint to continue';
	if (typeof state.balance === 'number' && state.balance < MINT_COST_SOL) return 'Not enough SOL to cover the mint';
	return null;
}

/* ── Render ───────────────────────────────────────────────────────────── */

function render() {
	const p = params();
	const name = p.name || 'Your agent';

	$('preview-name').textContent = name;
	$('preview-desc').textContent = p.description || 'Fill in the form and watch exactly what lands on-chain.';
	$('preview-initial').textContent = (p.name || 'A').slice(0, 1).toUpperCase();
	// Toggle, never replace: rebuilding this node mid-render would orphan the
	// element the next render writes into, which silently killed the preview.
	const img = $('preview-img');
	if (p.image && img.dataset.src !== p.image) {
		img.dataset.src = p.image;
		img.src = p.image;
		img.hidden = false;
		$('preview-initial').hidden = true;
		img.onerror = () => {
			img.hidden = true;
			img.dataset.src = '';
			$('preview-initial').hidden = false;
		};
	} else if (!p.image) {
		img.hidden = true;
		img.dataset.src = '';
		$('preview-initial').hidden = false;
	}

	const chips = [];
	if (p.modelUrl) chips.push(['3D body', true]);
	if (p.x402Support) chips.push(['x402', true]);
	if (p.services.length) chips.push([`${p.services.length} service${p.services.length > 1 ? 's' : ''}`, true]);
	for (const t of p.supportedTrust) chips.push([t, false]);
	chips.push([state.network, state.network === 'mainnet']);
	$('preview-chips').innerHTML = chips.map(([l, on]) => `<span${on ? ' class="on"' : ''}>${esc(l)}</span>`).join('');

	const registration = buildRegistrationDoc({
		name,
		description: p.description,
		image: p.image,
		modelUrl: p.modelUrl,
		services: p.services,
		active: p.active,
		x402Support: p.x402Support,
		registrations: [chainRegistration('<assigned when it mints>', p.network)],
		supportedTrust: p.supportedTrust,
	});
	const metadata = buildAssetMetadata({ name, image: p.image, animationUrl: p.modelUrl });
	$('json-out').firstElementChild.textContent = JSON.stringify(
		state.previewDoc === 'registration' ? registration : metadata,
		null,
		2,
	);

	const bytes = jsonDataUri(registration).length + jsonDataUri(metadata).length;
	$('cost-line').textContent = `~${MINT_COST_SOL} SOL · ${bytes.toLocaleString()} bytes on-chain`;
	$('royalty-pct').textContent = `${(p.royaltyBasisPoints / 100).toFixed(p.royaltyBasisPoints % 100 ? 2 : 0)}%`;

	const btn = $('deploy-btn');
	if (state.deploying) {
		btn.disabled = true;
		btn.textContent = 'Deploying…';
	} else {
		const problem = problemWith(p);
		btn.disabled = Boolean(problem);
		btn.textContent = problem || `Deploy on ${state.network === 'devnet' ? 'devnet' : 'mainnet'}`;
	}
}

for (const id of ['f-name', 'f-description', 'f-image', 'f-model', 'f-royalty', 'f-trust', 'f-collection', 'f-owner', 'f-metadata-uri', 'f-registration-uri']) {
	$(id).addEventListener('input', render);
}
for (const id of ['f-x402', 'f-active', 'p-verified', 'p-immutable', 'p-freeze', 'p-transfer', 'p-burn', 'p-addblocker']) {
	$(id).addEventListener('change', render);
}
$('f-name').addEventListener('input', () => {
	$('name-count').textContent = String($('f-name').value.length);
});
for (const tab of document.querySelectorAll('.tab')) {
	tab.addEventListener('click', () => {
		state.previewDoc = tab.dataset.doc;
		for (const t of document.querySelectorAll('.tab')) {
			t.classList.toggle('active', t === tab);
			t.setAttribute('aria-selected', String(t === tab));
		}
		render();
	});
}

/* ── Deploy ───────────────────────────────────────────────────────────── */

function setStage(active, done = []) {
	$('stages').hidden = false;
	for (const li of $('stages').children) {
		li.classList.toggle('active', li.dataset.stage === active);
		li.classList.toggle('done', done.includes(li.dataset.stage));
	}
}

async function deploy() {
	const p = params();
	if (state.deploying || problemWith(p)) return;

	state.deploying = true;
	render();
	$('deploy-error').hidden = true;
	$('success').hidden = true;
	setStage('build');

	try {
		const umi = umiFor(state.endpoint);
		const isHosted = state.wallet.kind === 'hosted';
		umi.use(
			signerIdentity(
				isHosted ? state.wallet.hosted.signer(umi) : createNoopSigner(umiPublicKey(state.wallet.address)),
			),
		);

		const mint = buildAgentMint(umi, p);
		const asset = mint.assetSigner.publicKey.toString();
		let signatures;

		if (isHosted) {
			setStage('mint', ['build']);
			({ signatures } = await sendAgentMint(umi, mint, { toBase58Signature }));
		} else {
			const built = [];
			for (const builder of mint.builders) built.push(await builder.buildAndSign(umi));
			const txs = built.map((tx) => {
				const bytes = umi.transactions.serialize(tx);
				try {
					return VersionedTransaction.deserialize(bytes);
				} catch {
					return Transaction.from(bytes);
				}
			});

			setStage('sign', ['build']);
			const provider = state.wallet.provider;
			const signed =
				typeof provider.signAllTransactions === 'function'
					? await provider.signAllTransactions(txs)
					: await Promise.all(txs.map((tx) => provider.signTransaction(tx)));

			const conn = new Connection(state.endpoint, 'confirmed');
			signatures = [];
			for (let i = 0; i < signed.length; i++) {
				setStage(i === 0 ? 'mint' : 'register', ['build', 'sign', ...(i ? ['mint'] : [])]);
				const sig = await sendWithRetry(conn, signed[i].serialize());
				await confirmSignature(conn, sig);
				signatures.push(sig);
				if (i === 0 && signed.length > 1) await waitForAccount(conn, asset);
			}
		}

		setStage('done', ['build', 'sign', 'mint', 'register']);
		const [walletPda] = findAssetSignerPda(umi, { asset: umiPublicKey(asset) });
		showSuccess(asset, walletPda.toString(), signatures);
		refreshBalance();
		loadRecent();
	} catch (err) {
		$('deploy-error').textContent = explain(err);
		$('deploy-error').hidden = false;
		$('stages').hidden = true;
	} finally {
		state.deploying = false;
		render();
	}
}

async function sendWithRetry(conn, raw) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await conn.sendRawTransaction(raw, { skipPreflight: false });
		} catch (err) {
			// A just-minted asset can lag the node simulating the register tx, which
			// the identity program reports as InvalidCoreAsset. It clears in seconds.
			const racey = /Invalid Core Asset|custom program error: 0x4/i.test(err?.message || '');
			if (!racey || attempt >= 4) throw err;
			await sleep(2000);
		}
	}
}

async function confirmSignature(conn, signature) {
	for (let i = 0; i < 45; i++) {
		const { value } = await conn.getSignatureStatuses([signature]);
		const status = value?.[0];
		if (status?.err) throw new Error(`The network rejected the transaction: ${JSON.stringify(status.err)}`);
		if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return;
		await sleep(2000);
	}
	throw new Error(`Timed out waiting for ${signature} to confirm. Check the explorer before trying again.`);
}

async function waitForAccount(conn, address) {
	for (let i = 0; i < 10; i++) {
		if (await conn.getAccountInfo(new PublicKey(address)).catch(() => null)) return;
		await sleep(1500);
	}
}

function explain(err) {
	const msg = err?.message || String(err);
	if (/reject|denied|declined|4001/i.test(msg)) return 'You dismissed the signature request. Nothing was spent.';
	if (/insufficient|0x1\b/i.test(msg)) return `Not enough SOL for the mint (about ${MINT_COST_SOL} SOL). Top the wallet up and try again.`;
	if (/blockhash|expired/i.test(msg)) return 'The transaction expired before it was signed. Press deploy again to rebuild it.';
	if (/403|forbidden/i.test(msg)) return 'The RPC endpoint refused the request. Add your own endpoint with "Use my own RPC".';
	return `Deploy failed: ${msg}`;
}

function showSuccess(asset, agentWallet, signatures) {
	$('out-asset').textContent = asset;
	$('out-wallet').textContent = agentWallet;
	const dev = state.network === 'devnet';
	const links = [
		!dev && [`https://www.metaplex.com/agents/${asset}`, 'Metaplex page'],
		[`https://core.metaplex.com/explorer/${asset}${dev ? '?env=devnet' : ''}`, 'Core explorer'],
		[`https://solscan.io/account/${asset}${dev ? '?cluster=devnet' : ''}`, 'Solscan'],
		...signatures.map((s, i) => [
			`https://solscan.io/tx/${s}${dev ? '?cluster=devnet' : ''}`,
			signatures.length > 1 ? (i === 0 ? 'Mint transaction' : 'Registration') : 'Transaction',
		]),
	].filter(Boolean);
	$('out-links').innerHTML = links
		.map(([href, label]) => `<a href="${href}" target="_blank" rel="noopener">${esc(label)}</a>`)
		.join('');
	$('success').hidden = false;
	$('success').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('deploy-btn').addEventListener('click', deploy);
$('again-btn').addEventListener('click', () => {
	$('success').hidden = true;
	$('stages').hidden = true;
	$('f-name').value = '';
	$('f-description').value = '';
	$('name-count').textContent = '0';
	render();
	document.querySelector('.app-head').scrollIntoView({ behavior: 'smooth' });
});

/* ── Recent deployments ───────────────────────────────────────────────── */

async function loadRecent() {
	const row = $('recent-row');
	try {
		const items = (await recentDeployments(8)).slice(0, 8);
		if (!items.length) {
			row.innerHTML = '<p class="recent-empty">Nothing has landed in the last stretch. Yours could be next.</p>';
			return;
		}
		row.innerHTML = items
			.map(
				(d) =>
					`<a class="recent-card" href="https://www.metaplex.com/agents/${esc(d.asset)}" target="_blank" rel="noopener">` +
					(d.image
						? `<img src="${esc(d.image)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />`
						: '<img alt="" />') +
					`<span class="recent-meta"><strong>${esc(d.name)}</strong>` +
					`<small>${d.has3d ? '3D · ' : ''}${d.x402 ? 'x402 · ' : ''}${new Date(d.at).toLocaleDateString()}</small></span></a>`,
			)
			.join('');
	} catch {
		row.innerHTML =
			'<p class="recent-empty">The live feed is unreachable right now. <a href="https://three.ws/deployments" target="_blank" rel="noopener">Open it on three.ws</a>.</p>';
	}
}

/* ── Boot ─────────────────────────────────────────────────────────────── */

renderWalletChoices();
render();
applyNetwork('devnet');
loadRecent();

// Reconnect a wallet the visitor already trusted, without prompting.
for (const entry of detectInjected()) {
	entry.provider
		?.connect?.({ onlyIfTrusted: true })
		.then((res) => {
			const pk = res?.publicKey || entry.provider.publicKey;
			if (pk && !state.wallet) setWallet({ kind: 'injected', label: entry.label, address: pk.toString(), provider: entry.provider });
		})
		.catch(() => {
			// not previously trusted; the visitor can click Connect
		});
}
