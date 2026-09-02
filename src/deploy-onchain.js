/**
 * /deploy-onchain: mint an agent into the Metaplex Agent Registry from the
 * user's own wallet (Phantom / Solflare / Backpack / Seeker), in the exact
 * Genesis-333 shape.
 *
 * The on-chain documents and transaction builders come from
 * @three-ws/metaplex-agent-mcp/lib, the same library behind the published MCP
 * server, so what this page mints is byte-identical to what an agent minting
 * itself over MCP produces. The registration builders are dependency-free and
 * load with the page; umi, mpl-core, and web3.js only load when the user
 * actually deploys.
 *
 * Flow: build both documents live as the form changes → on deploy, build the
 * create(+register) transaction(s) with the wallet as a noop signer → the
 * wallet signs (signAllTransactions) → broadcast IN ORDER through the
 * same-origin RPC proxy, absorbing the create→register propagation race.
 */

import {
	buildAssetMetadata,
	buildRegistrationDoc,
	threeWsRegistration,
	chainRegistration,
	jsonDataUri,
} from '@three-ws/metaplex-agent-mcp/lib/registration';

const $ = (id) => document.getElementById(id);

// Same-origin RPC proxy (public endpoints 403 browser origins). Mirrors
// src/erc8004/solana-deploy.js SOLANA_RPC; kept inline so the initial page
// load stays free of @solana/web3.js.
const RPC_ORIGIN = window.location?.origin || 'https://three.ws';
const RPC = {
	mainnet: `${RPC_ORIGIN}/api/solana-rpc`,
	devnet: `${RPC_ORIGIN}/api/solana-rpc?net=devnet`,
};

/** Injected-wallet detection, same order as src/erc8004/solana-deploy.js. */
function detectSolanaWallet() {
	if (window.threeWsWallet?.isThreeWs) return window.threeWsWallet;
	if (window.solana?.isThreeWs) return window.solana;
	if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
	if (window.solana?.isPhantom) return window.solana;
	if (window.backpack?.solana) return window.backpack.solana;
	if (window.solflare?.isSolflare) return window.solflare;
	return null;
}

const state = {
	network: 'mainnet',
	wallet: null,
	walletAddr: null,
	selectedAgent: null, // { id, name, description, image, model }
	deploying: false,
	previewDoc: 'registration',
};

/* ── Wallet ──────────────────────────────────────────────────────────── */

async function rpcCall(network, method, params) {
	const res = await fetch(RPC[network], {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	if (!res.ok) throw new Error(`rpc ${method} → ${res.status}`);
	const body = await res.json();
	if (body.error) throw new Error(body.error.message || `rpc ${method} failed`);
	return body.result;
}

function short(addr) {
	return addr.length > 12 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

async function refreshBalance() {
	if (!state.walletAddr) return;
	try {
		const result = await rpcCall(state.network, 'getBalance', [state.walletAddr]);
		const sol = (result?.value ?? 0) / 1e9;
		$('do-wallet-balance').textContent = `${sol.toFixed(4)} SOL`;
	} catch {
		$('do-wallet-balance').textContent = 'balance unavailable';
	}
}

function setWalletUi() {
	const connected = Boolean(state.walletAddr);
	$('do-wallet-disconnected').hidden = connected;
	$('do-wallet-connected').hidden = !connected;
	if (connected) {
		$('do-wallet-addr').textContent = short(state.walletAddr);
		$('do-wallet-addr').title = state.walletAddr;
		refreshBalance();
	}
	updateDeployButton();
}

async function connectWallet() {
	const errEl = $('do-wallet-error');
	errEl.hidden = true;
	const provider = detectSolanaWallet();
	if (!provider) {
		$('do-nowallet').hidden = false;
		return;
	}
	try {
		const res = await provider.connect();
		const pk = res?.publicKey || provider.publicKey;
		if (!pk) throw new Error('The wallet connected but did not expose a public key.');
		state.wallet = provider;
		state.walletAddr = pk.toString();
		ensureDefaultCreatorRow();
		setWalletUi();
		renderPreview();
	} catch (err) {
		errEl.textContent =
			err?.code === 4001 || /reject/i.test(err?.message || '')
				? 'Connection request was dismissed in the wallet. Try again when ready.'
				: `Wallet connection failed: ${err?.message || err}`;
		errEl.hidden = false;
	}
}

function disconnectWallet() {
	try {
		state.wallet?.disconnect?.();
	} catch {
		// some providers throw when there is no active session; nothing to undo
	}
	state.wallet = null;
	state.walletAddr = null;
	setWalletUi();
}

/* ── Form model ──────────────────────────────────────────────────────── */

function rows(containerId, selector) {
	return [...$(containerId).querySelectorAll(selector)];
}

function creatorRows() {
	return rows('do-creators', '.do-row')
		.map((row) => ({
			address: row.querySelector('.do-creator-addr').value.trim(),
			percentage: Number(row.querySelector('.do-creator-pct').value),
		}))
		.filter((c) => c.address);
}

function attrRows() {
	return rows('do-attrs', '.do-row')
		.map((row) => ({
			key: row.querySelector('.do-attr-key').value.trim(),
			value: row.querySelector('.do-attr-val').value.trim(),
		}))
		.filter((a) => a.key);
}

function serviceRows() {
	return rows('do-services', '.do-row')
		.map((row) => ({
			name: row.querySelector('.do-svc-name').value.trim(),
			endpoint: row.querySelector('.do-svc-url').value.trim(),
		}))
		.filter((s) => s.name && s.endpoint);
}

function trustList() {
	const raw = $('do-trust').value.split(',').map((t) => t.trim()).filter(Boolean);
	return raw.length ? raw : ['reputation'];
}

/** The full mint parameter set, camelCase, ready for buildAgentMint. */
function mintParams() {
	const creators = creatorRows();
	const defaultSplit =
		creators.length === 0 ||
		(creators.length === 1 && creators[0].address === state.walletAddr && creators[0].percentage === 100);
	return {
		network: state.network,
		creator: state.walletAddr || '11111111111111111111111111111111',
		name: $('do-name').value.trim(),
		description: $('do-desc').value.trim(),
		image: $('do-image').value.trim() || undefined,
		modelUrl: $('do-model').value.trim() || undefined,
		services: serviceRows(),
		active: $('do-active').checked,
		x402Support: $('do-x402').checked,
		threeWsAgentId: state.selectedAgent?.id,
		supportedTrust: trustList(),
		royaltyBasisPoints: Number($('do-royalty').value || 0),
		royaltyCreators: defaultSplit ? undefined : creators,
		verifiedCreator: $('do-verified').checked,
		immutableMetadata: $('do-immutable').checked,
		attributes: attrRows(),
		permanentFreeze: $('do-pfreeze').checked,
		permanentTransfer: $('do-ptransfer').checked,
		permanentBurn: $('do-pburn').checked,
		addBlocker: $('do-addblocker').checked,
		collection: $('do-collection').value.trim() || undefined,
	};
}

function validate(p) {
	if (!p.name) return 'Give your agent a name.';
	if (p.royaltyBasisPoints < 0 || p.royaltyBasisPoints > 10000) return 'Royalty must be between 0 and 10000 basis points.';
	if (p.royaltyCreators) {
		const total = p.royaltyCreators.reduce((sum, c) => sum + c.percentage, 0);
		if (total !== 100) return `Royalty split must sum to 100% (currently ${total}%).`;
	}
	return null;
}

/* ── Live preview ────────────────────────────────────────────────────── */

function previewDocs() {
	const p = mintParams();
	const name = p.name || 'your-agent';
	const registrations = p.threeWsAgentId
		? [threeWsRegistration(p.threeWsAgentId)]
		: [chainRegistration('<asset address, assigned at mint>', p.network)];
	const registration = buildRegistrationDoc({
		name,
		description: p.description,
		image: p.image,
		modelUrl: p.modelUrl,
		services: p.services,
		active: p.active,
		x402Support: p.x402Support,
		registrations,
		supportedTrust: p.supportedTrust,
	});
	const metadata = buildAssetMetadata({
		name,
		image: p.image,
		animationUrl: p.modelUrl,
		attributes: undefined,
	});
	return { p, registration, metadata };
}

function renderPreview() {
	const { p, registration, metadata } = previewDocs();

	$('do-preview-name').textContent = p.name || 'Your agent';
	$('do-preview-desc').textContent =
		p.description || 'Fill in the identity and watch the on-chain documents build themselves.';
	const media = $('do-preview-media');
	if (p.image) {
		media.innerHTML = '';
		const img = document.createElement('img');
		img.src = p.image;
		img.alt = '';
		img.onerror = () => {
			media.innerHTML = `<span class="do-preview-mono">${(p.name || '?').slice(0, 1).toUpperCase()}</span>`;
		};
		media.appendChild(img);
	} else {
		media.innerHTML = `<span class="do-preview-mono">${(p.name || '?').slice(0, 1).toUpperCase()}</span>`;
	}
	const chips = [];
	if (p.modelUrl) chips.push(['3D GLB', true]);
	if (p.x402Support) chips.push(['x402', true]);
	for (const t of p.supportedTrust) chips.push([t, false]);
	chips.push([p.network, p.network === 'mainnet']);
	$('do-preview-chips').innerHTML = chips
		.map(([label, hot]) => `<span${hot ? ' class="hot"' : ''}>${escapeHtml(label)}</span>`)
		.join('');

	const checklist = $('do-genesis-list');
	checklist.querySelector('[data-check="royalty"]').classList.toggle('on', p.royaltyBasisPoints === 500 && !p.royaltyCreators);
	checklist.querySelector('[data-check="verified"]').classList.toggle('on', p.verifiedCreator);
	checklist.querySelector('[data-check="immutable"]').classList.toggle('on', p.immutableMetadata);

	const doc = state.previewDoc === 'registration' ? registration : metadata;
	$('do-json-code').textContent = JSON.stringify(doc, null, 2);

	const bytes = jsonDataUri(registration).length + jsonDataUri(metadata).length;
	$('do-cost').textContent = `~0.007 SOL · ${bytes.toLocaleString()} B on-chain`;

	updateDeployButton();
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function updateDeployButton() {
	const btn = $('do-deploy');
	if (state.deploying) {
		btn.disabled = true;
		btn.textContent = 'Deploying…';
		return;
	}
	if (!state.walletAddr) {
		btn.disabled = true;
		btn.textContent = 'Connect a wallet to deploy';
		return;
	}
	const problem = validate(mintParams());
	btn.disabled = Boolean(problem);
	btn.textContent = problem
		? problem
		: `Deploy on ${state.network === 'devnet' ? 'devnet (free rehearsal)' : 'Solana mainnet'}`;
}

/* ── Row editors ─────────────────────────────────────────────────────── */

function addRow(containerId, html) {
	const row = document.createElement('div');
	row.className = 'do-row';
	row.innerHTML = `${html}<button type="button" class="do-row-del" aria-label="Remove row">×</button>`;
	row.querySelector('.do-row-del').addEventListener('click', () => {
		row.remove();
		renderPreview();
	});
	row.addEventListener('input', renderPreview);
	$(containerId).appendChild(row);
	return row;
}

function addCreatorRow(address = '', percentage = '') {
	addRow(
		'do-creators',
		`<input type="text" class="do-creator-addr" placeholder="Wallet address" value="${escapeHtml(address)}" aria-label="Creator address" />` +
			`<input type="number" class="do-creator-pct do-row-narrow" min="0" max="100" placeholder="%" value="${escapeHtml(percentage)}" aria-label="Creator percentage" />`,
	);
}

function ensureDefaultCreatorRow() {
	if (state.walletAddr && rows('do-creators', '.do-row').length === 0) {
		addCreatorRow(state.walletAddr, 100);
	}
}

/* ── Your three.ws agents ────────────────────────────────────────────── */

async function loadMyAgents() {
	const loading = $('do-agents-loading');
	try {
		const res = await fetch('/api/agents', { credentials: 'include' });
		loading.hidden = true;
		if (res.status === 401) {
			$('do-agents-signedout').hidden = false;
			return;
		}
		if (!res.ok) throw new Error(`agents → ${res.status}`);
		const body = await res.json();
		const agents = (body.agents || []).filter((a) => a?.name);
		if (!agents.length) {
			$('do-agents-empty').hidden = false;
			return;
		}
		const strip = $('do-agents');
		strip.hidden = false;
		for (const a of agents) {
			const deployed = Boolean(a.onchain || a.meta?.sol_mint_address);
			const tile = document.createElement('button');
			tile.type = 'button';
			tile.className = `do-agent-tile${deployed ? ' deployed' : ''}`;
			tile.setAttribute('role', 'option');
			tile.setAttribute('aria-selected', 'false');
			tile.innerHTML =
				(a.avatar_thumbnail_url
					? `<img class="do-agent-thumb" src="${escapeHtml(a.avatar_thumbnail_url)}" alt="" loading="lazy" />`
					: '<span class="do-agent-thumb" aria-hidden="true"></span>') +
				`<span class="do-agent-name">${escapeHtml(a.name)}</span>` +
				`<span class="do-agent-sub">${deployed ? 'already on-chain' : 'ready to deploy'}</span>`;
			tile.addEventListener('click', () => selectAgent(a, tile));
			strip.appendChild(tile);
		}
	} catch {
		loading.hidden = true;
		$('do-agents-signedout').hidden = false;
	}
}

function selectAgent(a, tile) {
	const strip = $('do-agents');
	const already = state.selectedAgent?.id === a.id;
	for (const t of strip.querySelectorAll('.do-agent-tile')) {
		t.classList.remove('selected');
		t.setAttribute('aria-selected', 'false');
	}
	if (already) {
		state.selectedAgent = null;
		renderPreview();
		return;
	}
	state.selectedAgent = { id: a.id };
	tile.classList.add('selected');
	tile.setAttribute('aria-selected', 'true');
	$('do-name').value = (a.name || '').slice(0, 60);
	if (a.description) $('do-desc').value = a.description;
	if (a.avatar_thumbnail_url) $('do-image').value = a.avatar_thumbnail_url;
	if (a.avatar_model_url) $('do-model').value = a.avatar_model_url;
	$('do-name-count').textContent = String($('do-name').value.length);
	renderPreview();
}

/* ── Deploy ──────────────────────────────────────────────────────────── */

function setStage(name, done = []) {
	const list = $('do-stages');
	list.hidden = false;
	for (const li of list.children) {
		li.classList.toggle('active', li.dataset.stage === name);
		li.classList.toggle('done', done.includes(li.dataset.stage));
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function confirmSig(conn, signature) {
	for (let i = 0; i < 45; i++) {
		const { value } = await conn.getSignatureStatuses([signature]);
		const status = value?.[0];
		if (status?.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
		if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return;
		await sleep(2000);
	}
	throw new Error(`Confirmation timed out for ${signature}. Check the explorer before retrying.`);
}

async function deploy() {
	if (state.deploying || !state.wallet || !state.walletAddr) return;
	const p = mintParams();
	const problem = validate(p);
	if (problem) return;

	state.deploying = true;
	updateDeployButton();
	const errEl = $('do-deploy-error');
	errEl.hidden = true;
	$('do-success').hidden = true;
	setStage('build');

	try {
		const [{ createUmi }, umiLib, coreLib, regLib, mintLib, web3] = await Promise.all([
			import('@metaplex-foundation/umi-bundle-defaults'),
			import('@metaplex-foundation/umi'),
			import('@metaplex-foundation/mpl-core'),
			import('@metaplex-foundation/mpl-agent-registry'),
			import('@three-ws/metaplex-agent-mcp/lib/mint'),
			import('@solana/web3.js'),
		]);

		const umi = createUmi(RPC[state.network]).use(coreLib.mplCore()).use(regLib.mplAgentIdentity());
		umi.use(umiLib.signerIdentity(umiLib.createNoopSigner(umiLib.publicKey(state.walletAddr))));

		const mint = mintLib.buildAgentMint(umi, p);
		const asset = mint.assetSigner.publicKey.toString();

		const built = [];
		for (const builder of mint.builders) built.push(await builder.buildAndSign(umi));
		const txs = built.map((t) => {
			const bytes = umi.transactions.serialize(t);
			try {
				return web3.VersionedTransaction.deserialize(bytes);
			} catch {
				return web3.Transaction.from(bytes);
			}
		});

		setStage('sign', ['build']);
		let signed;
		if (typeof state.wallet.signAllTransactions === 'function') {
			signed = await state.wallet.signAllTransactions(txs);
		} else {
			signed = [];
			for (const tx of txs) signed.push(await state.wallet.signTransaction(tx));
		}

		const conn = new web3.Connection(RPC[state.network], 'confirmed');
		const signatures = [];
		for (let i = 0; i < signed.length; i++) {
			setStage(i === 0 ? 'mint' : 'register', i === 0 ? ['build', 'sign'] : ['build', 'sign', 'mint']);
			const raw = signed[i].serialize();
			let sig;
			for (let attempt = 0; ; attempt++) {
				try {
					sig = await conn.sendRawTransaction(raw, { skipPreflight: false });
					break;
				} catch (err) {
					const racey = /Invalid Core Asset|custom program error: 0x4/i.test(err?.message || '');
					if (!racey || attempt >= 4) throw err;
					await sleep(2000);
				}
			}
			await confirmSig(conn, sig);
			signatures.push(sig);
			if (i === 0 && signed.length > 1) {
				// Let the asset account propagate before the register tx simulates.
				for (let tries = 0; tries < 10; tries++) {
					const info = await conn.getAccountInfo(new web3.PublicKey(asset)).catch(() => null);
					if (info) break;
					await sleep(1500);
				}
			}
		}

		setStage('live', ['build', 'sign', 'mint', 'register']);
		const [agentWalletPda] = coreLib.findAssetSignerPda(umi, { asset: umiLib.publicKey(asset) });
		showSuccess({ asset, signatures, agentWallet: agentWalletPda.toString() });
		refreshBalance();
		loadLatest();
	} catch (err) {
		errEl.textContent = friendlyError(err);
		errEl.hidden = false;
		$('do-stages').hidden = true;
	} finally {
		state.deploying = false;
		updateDeployButton();
	}
}

function friendlyError(err) {
	const msg = err?.message || String(err);
	if (/reject|declined|denied|4001/i.test(msg)) return 'The wallet declined the signature. Nothing was spent; deploy again when ready.';
	if (/insufficient|0x1\b/i.test(msg)) return `Not enough SOL on ${state.network} to cover ~0.007 SOL of rent and fees. Fund the wallet and retry.`;
	if (/blockhash|expired/i.test(msg)) return 'The transaction expired before it was signed. Deploy again to rebuild it with a fresh blockhash.';
	return `Deploy failed: ${msg}`;
}

function showSuccess({ asset, signatures, agentWallet }) {
	$('do-out-asset').textContent = asset;
	$('do-out-wallet').textContent = agentWallet || 'derived on first read (see the agent page)';
	const dev = state.network === 'devnet';
	const links = [
		[`https://www.metaplex.com/agents/${asset}`, 'Metaplex agent page', !dev],
		[`https://core.metaplex.com/explorer/${asset}${dev ? '?env=devnet' : ''}`, 'Core explorer', true],
		[`https://solscan.io/account/${asset}${dev ? '?cluster=devnet' : ''}`, 'Solscan', true],
		...signatures.map((s, i) => [
			`https://solscan.io/tx/${s}${dev ? '?cluster=devnet' : ''}`,
			signatures.length > 1 ? (i === 0 ? 'Mint tx' : 'Register tx') : 'Transaction',
			true,
		]),
		['/deployments', 'three.ws feed', true],
	];
	$('do-out-links').innerHTML = links
		.filter(([, , show]) => show)
		.map(([href, label]) => `<a href="${href}" target="_blank" rel="noopener">${label} ↗</a>`)
		.join('');
	$('do-success').hidden = false;
	$('do-success').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ── Latest to land ──────────────────────────────────────────────────── */

async function loadLatest() {
	const strip = $('do-latest-strip');
	try {
		const res = await fetch('/api/deployments?chain=101&network=mainnet&limit=8');
		if (!res.ok) throw new Error(String(res.status));
		const body = await res.json();
		const items = body?.data?.deployments || [];
		if (!items.length) {
			strip.innerHTML = '<p class="do-latest-empty">Quiet on-chain right now. Yours could be next.</p>';
			return;
		}
		strip.innerHTML = items
			.map(
				(d) =>
					`<a class="do-agent-tile" href="https://www.metaplex.com/agents/${escapeHtml(d.agent_id)}" target="_blank" rel="noopener">` +
					(d.image
						? `<img class="do-agent-thumb" src="${escapeHtml(d.image)}" alt="" loading="lazy" />`
						: '<span class="do-agent-thumb" aria-hidden="true"></span>') +
					`<span class="do-agent-name">${escapeHtml(d.name || short(d.agent_id))}</span>` +
					`<span class="do-agent-sub">${d.has_3d ? '3D · ' : ''}${d.x402_support ? 'x402 · ' : ''}${new Date(d.registered_at).toLocaleDateString()}</span>` +
					'</a>',
			)
			.join('');
		// A dead remote thumbnail leaves the tile's layout intact instead of a
		// broken-image glyph. Bound here rather than as an inline onerror: the
		// site CSP has no 'unsafe-inline' in script-src, so an inline handler in
		// this generated markup would never fire in production.
		for (const img of strip.querySelectorAll('img.do-agent-thumb')) {
			img.addEventListener('error', () => {
				img.style.visibility = 'hidden';
			});
		}
	} catch {
		strip.innerHTML = '<p class="do-latest-empty">The live feed is unreachable right now. <a href="/deployments">Open the full feed</a>.</p>';
	}
}

/* ── Wire-up ─────────────────────────────────────────────────────────── */

function init() {
	$('do-connect').addEventListener('click', connectWallet);
	$('do-disconnect').addEventListener('click', disconnectWallet);

	for (const btn of document.querySelectorAll('.do-net-btn')) {
		btn.addEventListener('click', () => {
			state.network = btn.dataset.net;
			for (const b of document.querySelectorAll('.do-net-btn')) {
				b.classList.toggle('active', b === btn);
				b.setAttribute('aria-checked', String(b === btn));
			}
			refreshBalance();
			renderPreview();
		});
	}

	for (const id of ['do-name', 'do-desc', 'do-image', 'do-model', 'do-royalty', 'do-trust', 'do-collection']) {
		$(id).addEventListener('input', renderPreview);
	}
	for (const id of ['do-x402', 'do-active', 'do-verified', 'do-immutable', 'do-pfreeze', 'do-ptransfer', 'do-pburn', 'do-addblocker']) {
		$(id).addEventListener('change', renderPreview);
	}
	$('do-name').addEventListener('input', () => {
		$('do-name-count').textContent = String($('do-name').value.length);
	});

	$('do-add-creator').addEventListener('click', () => addCreatorRow());
	$('do-add-attr').addEventListener('click', () =>
		addRow(
			'do-attrs',
			'<input type="text" class="do-attr-key" placeholder="key" aria-label="Attribute key" />' +
				'<input type="text" class="do-attr-val" placeholder="value" aria-label="Attribute value" />',
		),
	);
	$('do-add-service').addEventListener('click', () =>
		addRow(
			'do-services',
			'<input type="text" class="do-svc-name" placeholder="name (e.g. chat)" aria-label="Service name" />' +
				'<input type="url" class="do-svc-url" placeholder="https://…" aria-label="Service endpoint" />',
		),
	);

	for (const tab of document.querySelectorAll('.do-json-tab')) {
		tab.addEventListener('click', () => {
			state.previewDoc = tab.dataset.doc;
			for (const t of document.querySelectorAll('.do-json-tab')) {
				t.classList.toggle('active', t === tab);
				t.setAttribute('aria-selected', String(t === tab));
			}
			renderPreview();
		});
	}

	document.addEventListener('click', (e) => {
		const btn = e.target.closest('.do-copy');
		if (!btn) return;
		const src = $(btn.dataset.copy);
		if (!src) return;
		navigator.clipboard.writeText(src.textContent).then(() => {
			btn.classList.add('copied');
			btn.textContent = 'copied';
			setTimeout(() => {
				btn.classList.remove('copied');
				btn.textContent = 'copy';
			}, 1400);
		});
	});

	$('do-deploy').addEventListener('click', deploy);
	$('do-again').addEventListener('click', () => {
		$('do-success').hidden = true;
		$('do-stages').hidden = true;
		window.scrollTo({ top: 0, behavior: 'smooth' });
	});

	// Eager wallet reconnect for returning users (Phantom supports this).
	const provider = detectSolanaWallet();
	if (provider?.connect) {
		provider
			.connect({ onlyIfTrusted: true })
			.then((res) => {
				const pk = res?.publicKey || provider.publicKey;
				if (pk) {
					state.wallet = provider;
					state.walletAddr = pk.toString();
					ensureDefaultCreatorRow();
					setWalletUi();
					renderPreview();
				}
			})
			.catch(() => {
				// not yet trusted; the explicit Connect button covers it
			});
	}

	renderPreview();
	loadMyAgents();
	loadLatest();
}

init();
