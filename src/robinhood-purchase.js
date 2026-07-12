// Robinhood Chain purchase flow — mounted on the coin detail page's buy rail.
//
// Real EVM wallet connect (injected provider, matching the existing
// window.ethereum + viem pattern in src/vault.js — this codebase has no
// EIP-6963 discovery layer), chain-switch to 4663 with an EIP-3085
// wallet_addEthereumChain fallback, a live Uniswap v3 QuoterV2 quote, and an
// exactInputSingle swap through SwapRouter02 with user-set slippage. A bridge
// deep-link (LI.FI) covers wallets with no funds on 4663 yet.
//
// Memecoins only: swaps whose OUTPUT is a Stock Token are legally gated (see
// mountStockEligibilityGate below) — this module is never used for that path.

import { createPublicClient, createWalletClient, custom, http, parseUnits, formatUnits, encodeFunctionData } from 'viem';

// viem 2.52 (pinned in package.json) predates the official `robinhood` chain
// export in `viem/chains` (lands 2.55+) — inline chain def, same shape every
// other custom chain in this codebase uses (src/vault.js, src/erc8004/gasless-register.js).
const HOOD_MAINNET = {
	id: 4663,
	name: 'Robinhood Chain',
	nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
	rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
	blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
};

const QUOTER_V2 = '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7';
const SWAP_ROUTER_02 = '0xCaf681a66D020601342297493863E78C959E5cb2';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const FEE_TIERS = [500, 3000, 10000, 100];

const QUOTER_ABI = [
	{
		type: 'function',
		name: 'quoteExactInputSingle',
		stateMutability: 'nonpayable',
		inputs: [
			{
				name: 'params',
				type: 'tuple',
				components: [
					{ name: 'tokenIn', type: 'address' },
					{ name: 'tokenOut', type: 'address' },
					{ name: 'amountIn', type: 'uint256' },
					{ name: 'fee', type: 'uint24' },
					{ name: 'sqrtPriceLimitX96', type: 'uint160' },
				],
			},
		],
		outputs: [
			{ name: 'amountOut', type: 'uint256' },
			{ name: 'sqrtPriceX96After', type: 'uint160' },
			{ name: 'initializedTicksCrossed', type: 'uint32' },
			{ name: 'gasEstimate', type: 'uint256' },
		],
	},
];

const ROUTER_ABI = [
	{
		type: 'function',
		name: 'exactInputSingle',
		stateMutability: 'payable',
		inputs: [
			{
				name: 'params',
				type: 'tuple',
				components: [
					{ name: 'tokenIn', type: 'address' },
					{ name: 'tokenOut', type: 'address' },
					{ name: 'fee', type: 'uint24' },
					{ name: 'recipient', type: 'address' },
					{ name: 'amountIn', type: 'uint256' },
					{ name: 'amountOutMinimum', type: 'uint256' },
					{ name: 'sqrtPriceLimitX96', type: 'uint160' },
				],
			},
		],
		outputs: [{ name: 'amountOut', type: 'uint256' }],
	},
];

const ERC20_ABI = [
	{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
	{ type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
	{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
];

let publicClient;
function getPublicClient() {
	if (!publicClient) publicClient = createPublicClient({ chain: HOOD_MAINNET, transport: http() });
	return publicClient;
}

async function bestQuote(tokenOutAddress, amountInWei) {
	const client = getPublicClient();
	const results = await Promise.allSettled(
		FEE_TIERS.map((fee) =>
			client
				.simulateContract({
					address: QUOTER_V2,
					abi: QUOTER_ABI,
					functionName: 'quoteExactInputSingle',
					args: [{ tokenIn: WETH, tokenOut: tokenOutAddress, amountIn: amountInWei, fee, sqrtPriceLimitX96: 0n }],
				})
				.then((r) => ({ fee, amountOut: r.result[0] })),
		),
	);
	const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
	if (!ok.length) return null;
	return ok.reduce((best, cur) => (cur.amountOut > best.amountOut ? cur : best));
}

async function ensureChain(ethProvider) {
	const hex = `0x${HOOD_MAINNET.id.toString(16)}`;
	try {
		await ethProvider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
	} catch (err) {
		if (err?.code === 4902 || /unrecognized chain|not added/i.test(String(err?.message || ''))) {
			await ethProvider.request({
				method: 'wallet_addEthereumChain',
				params: [
					{
						chainId: hex,
						chainName: HOOD_MAINNET.name,
						nativeCurrency: HOOD_MAINNET.nativeCurrency,
						rpcUrls: HOOD_MAINNET.rpcUrls.default.http,
						blockExplorerUrls: [HOOD_MAINNET.blockExplorers.default.url],
					},
				],
			});
			await ethProvider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
		} else {
			throw err;
		}
	}
}

/**
 * Mount the memecoin buy panel into `container`. `token` = { address, symbol,
 * decimals }. Never used for Stock Tokens — see mountStockEligibilityGate.
 */
export function mountBuyPanel(container, token) {
	container.innerHTML = `
		<div class="rh-buy-panel">
			<h2 class="cv-h2" style="margin: 0 0 1rem">Buy ${token.symbol ? escapeHtml(token.symbol) : ''}</h2>
			<div class="rh-buy-row">
				<label for="rh-buy-amount" style="font-size:0.8125rem;color:var(--cv-text-2)">You pay (ETH)</label>
			</div>
			<input class="rh-buy-input" id="rh-buy-amount" type="number" min="0" step="0.001" placeholder="0.01" inputmode="decimal" />
			<div class="rh-buy-meta"><span>Slippage</span><span id="rh-buy-slippage-val">1.0%</span></div>
			<input class="rh-buy-input" id="rh-buy-slippage" type="range" min="0.1" max="5" step="0.1" value="1" style="padding:0" />
			<button class="rh-buy-btn" id="rh-buy-quote-btn" type="button">Get quote</button>
			<button class="rh-buy-secondary" id="rh-buy-connect-btn" type="button">Connect wallet</button>
			<div class="rh-buy-status" id="rh-buy-status" hidden></div>
		</div>
		<div class="rh-buy-panel" style="margin-top:1rem">
			<p style="font-size:0.8125rem;color:var(--cv-text-2);margin:0 0 0.75rem">No ETH on Robinhood Chain (4663) yet?</p>
			<a class="rh-bridge-link" href="https://jumper.exchange/?toChain=4663&toToken=0x0000000000000000000000000000000000000000" target="_blank" rel="noopener noreferrer">Bridge funds in via LI.FI →</a>
		</div>
	`;

	const status = container.querySelector('#rh-buy-status');
	const amountInput = container.querySelector('#rh-buy-amount');
	const slippageInput = container.querySelector('#rh-buy-slippage');
	const slippageVal = container.querySelector('#rh-buy-slippage-val');
	const quoteBtn = container.querySelector('#rh-buy-quote-btn');
	const connectBtn = container.querySelector('#rh-buy-connect-btn');

	let lastQuote = null;
	let walletClient = null;
	let account = null;

	function setStatus(msg, kind) {
		status.hidden = false;
		status.textContent = msg;
		status.className = `rh-buy-status${kind ? ` ${kind}` : ''}`;
	}

	slippageInput.addEventListener('input', () => {
		slippageVal.textContent = `${Number(slippageInput.value).toFixed(1)}%`;
	});

	quoteBtn.addEventListener('click', async () => {
		const amount = Number(amountInput.value);
		if (!amount || amount <= 0) return setStatus('Enter an amount to quote.', 'error');
		quoteBtn.disabled = true;
		setStatus('Fetching a live Uniswap v3 quote…');
		try {
			const amountInWei = parseUnits(String(amount), 18);
			const quote = await bestQuote(token.address, amountInWei);
			if (!quote) {
				setStatus('No route found for this token — it may not have deep enough liquidity yet.', 'error');
				return;
			}
			lastQuote = { ...quote, amountIn: amountInWei };
			const out = formatUnits(quote.amountOut, token.decimals ?? 18);
			setStatus(`Quote: ${amount} ETH → ${Number(out).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${token.symbol || ''} (fee tier ${quote.fee / 10000}%). Connect a wallet to swap.`);
			quoteBtn.textContent = 'Refresh quote';
		} catch (err) {
			setStatus(`Quote failed: ${err?.shortMessage || err?.message || 'unknown error'}`, 'error');
		} finally {
			quoteBtn.disabled = false;
		}
	});

	connectBtn.addEventListener('click', async () => {
		if (!window.ethereum) {
			setStatus('No injected wallet found — install MetaMask or another EVM wallet extension.', 'error');
			return;
		}
		connectBtn.disabled = true;
		setStatus('Connecting wallet…');
		try {
			await ensureChain(window.ethereum);
			walletClient = createWalletClient({ chain: HOOD_MAINNET, transport: custom(window.ethereum) });
			const [addr] = await walletClient.requestAddresses();
			account = addr;
			connectBtn.textContent = `${addr.slice(0, 6)}…${addr.slice(-4)} — Swap now`;
			setStatus(`Connected on Robinhood Chain (4663) as ${addr}. Get a quote, then click again to swap.`, 'success');
		} catch (err) {
			setStatus(`Wallet connect failed: ${err?.shortMessage || err?.message || 'unknown error'}`, 'error');
		} finally {
			connectBtn.disabled = false;
		}

		// Second click (once connected) executes the swap.
		if (account && lastQuote) {
			connectBtn.onclick = null;
			connectBtn.addEventListener('click', () => executeSwap());
		}
	});

	async function executeSwap() {
		if (!walletClient || !account) return setStatus('Connect a wallet first.', 'error');
		if (!lastQuote) return setStatus('Get a quote first.', 'error');
		const slippageBps = Math.round(Number(slippageInput.value) * 100);
		const amountOutMinimum = (lastQuote.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
		setStatus(`Confirm the swap in your wallet: ${formatUnits(lastQuote.amountIn, 18)} ETH → min ${formatUnits(amountOutMinimum, token.decimals ?? 18)} ${token.symbol || ''} (${(slippageBps / 100).toFixed(1)}% slippage).`);
		try {
			const data = encodeFunctionData({
				abi: ROUTER_ABI,
				functionName: 'exactInputSingle',
				args: [
					{
						tokenIn: WETH,
						tokenOut: token.address,
						fee: lastQuote.fee,
						recipient: account,
						amountIn: lastQuote.amountIn,
						amountOutMinimum,
						sqrtPriceLimitX96: 0n,
					},
				],
			});
			const hash = await walletClient.sendTransaction({
				account,
				to: SWAP_ROUTER_02,
				value: lastQuote.amountIn,
				data,
			});
			setStatus(`Swap submitted: ${hash}`, 'success');
		} catch (err) {
			setStatus(`Swap failed: ${err?.shortMessage || err?.message || 'unknown error'}`, 'error');
		}
	}
}

/**
 * Stock Tokens are display-only at launch (owner decision pending on an
 * in-house buy path). Render an eligibility-gated outbound "Trade on DEX"
 * link with the required legal disclosure instead of a swap panel — the
 * buy path stays cleanly implementable (swap out this function for
 * mountBuyPanel once the operator affirms eligibility) without any other
 * page wiring changing.
 */
export function mountStockEligibilityGate(container, { symbol, dexUrl }) {
	container.innerHTML = `
		<div class="rh-buy-panel rh-eligibility-gate">
			<h2 class="cv-h2" style="margin:0">Trade ${escapeHtml(symbol || '')}</h2>
			<p>
				Stock Tokens are tokenized debt securities issued by Robinhood Assets (Jersey) Ltd
				and may not be offered, sold, or delivered to US persons (extra limits: Canada, UK,
				Switzerland). three.ws does not broker this trade — it links out to the token's
				live Uniswap pool.
			</p>
			${dexUrl ? `<a class="rh-bridge-link" href="${escapeHtml(dexUrl)}" target="_blank" rel="noopener noreferrer">Trade on DEX →</a>` : '<p style="color:var(--cv-text-3);font-size:0.8125rem">No DEX pool found for this token yet.</p>'}
		</div>
	`;
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
