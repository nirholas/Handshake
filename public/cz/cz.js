// Hardcoded pre-registered agent id — coordinate with whoever ran the on-chain registration.
const AGENT_ID = 'cz-preview';
const AGENT_NAME = 'CZ Agent';

// --- DOM refs ---
const stepConnect = document.getElementById('step-connect');
const stepSign = document.getElementById('step-sign');
const stepSuccess = document.getElementById('step-success');
const stepError = document.getElementById('step-error');
const btnConnect = document.getElementById('btn-connect');
const btnSign = document.getElementById('btn-sign');
const btnRetry = document.getElementById('btn-retry');
const walletAddrEl = document.getElementById('wallet-addr');
const agentNameDisplay = document.getElementById('agent-name-display');
const snippetScript = document.getElementById('snippet-script');
const snippetTag = document.getElementById('snippet-tag');
const snippetIframe = document.getElementById('snippet-iframe');
const errorMsgEl = document.getElementById('error-msg');

// Wire the preview element. We point at a local body GLB rather than resolving
// agent-id=cz-preview through /api/agents/* so the on-page preview renders
// instantly without depending on whether the cz-preview agent has been seeded
// in the current environment. The embed snippets below still surface the
// agent-id form for users to copy.
document.getElementById('preview').setAttribute('body', '/avatars/cz.glb');
document.getElementById('preview').setAttribute('name', AGENT_NAME);

let _address = null;
let _nonce = null;

function show(step) {
	for (const s of [stepConnect, stepSign, stepSuccess, stepError]) s.classList.add('hidden');
	step.classList.remove('hidden');
}

// --- Connect wallet ---
btnConnect.addEventListener('click', async () => {
	btnConnect.disabled = true;
	btnConnect.textContent = 'Connecting…';
	try {
		_address = await connectWallet();
		walletAddrEl.textContent = _address;

		const nonceRes = await fetch(`/api/cz/claim?address=${encodeURIComponent(_address)}`);
		const nonceData = await nonceRes.json();
		if (!nonceRes.ok) throw new Error(nonceData.error_description || 'Failed to get nonce');
		_nonce = nonceData.nonce;

		show(stepSign);
	} catch (err) {
		showError(err.message);
	} finally {
		btnConnect.disabled = false;
		btnConnect.textContent = 'Connect wallet to claim';
	}
});

// --- Sign and claim ---
btnSign.addEventListener('click', async () => {
	btnSign.disabled = true;
	btnSign.textContent = 'Signing…';
	try {
		const message = claimMessage(_nonce);
		const signature = await signMessage(message, _address);

		const claimRes = await fetch('/api/cz/claim', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ signerAddress: _address, signature, nonce: _nonce }),
		});
		const claimData = await claimRes.json();
		if (!claimRes.ok) throw new Error(claimData.error_description || 'Claim failed');

		if (
			claimData.txPayload &&
			claimData.txPayload.to !== '0x0000000000000000000000000000000000000000'
		) {
			btnSign.textContent = 'Broadcasting…';
			await broadcastTx(claimData.txPayload, _address);
		}

		showSuccess();
	} catch (err) {
		showError(err.message);
	} finally {
		btnSign.disabled = false;
		btnSign.textContent = '⬢ Sign claim transaction';
	}
});

btnRetry.addEventListener('click', () => {
	_address = null;
	_nonce = null;
	show(stepConnect);
});

function claimMessage(nonce) {
	return `Claim CZ Agent\n\nNonce: ${nonce}`;
}

function showSuccess() {
	agentNameDisplay.textContent = AGENT_NAME;
	const origin = location.origin;
	snippetScript.textContent = `<script type="module"\n  src="${origin}/agent-3d/latest/agent-3d.js">\n<\/script>`;
	snippetTag.textContent = `<agent-3d agent-id="${AGENT_ID}" kiosk></agent-3d>`;
	snippetIframe.textContent = `<iframe\n  src="${origin}/agents/${AGENT_ID}/embed"\n  allow="microphone"\n  width="400" height="600">\n</iframe>`;
	show(stepSuccess);
}

function showError(msg) {
	errorMsgEl.textContent = msg;
	show(stepError);
}

// --- Wallet helpers (injected provider; Privy available once loaded on the main app) ---

async function connectWallet() {
	if (!window.ethereum)
		throw new Error('No wallet detected. Install MetaMask or a compatible browser wallet.');
	const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
	if (!accounts?.[0]) throw new Error('No account returned from wallet.');
	return accounts[0];
}

async function signMessage(message, address) {
	// personal_sign encodes message with the Ethereum prefix before signing.
	const msgHex =
		'0x' +
		Array.from(new TextEncoder().encode(message), (b) => b.toString(16).padStart(2, '0')).join(
			'',
		);
	return window.ethereum.request({ method: 'personal_sign', params: [msgHex, address] });
}

async function broadcastTx({ to, data, value }, from) {
	return window.ethereum.request({
		method: 'eth_sendTransaction',
		params: [{ from, to, data, value: value || '0x0' }],
	});
}
