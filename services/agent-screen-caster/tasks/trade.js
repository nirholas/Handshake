/**
 * trade task
 * ----------
 * Drives a Solana DEX/swap UI to execute trades on behalf of an agent.
 * The task accepts a JSON-encoded trade spec as TASK_ARG:
 *
 *   TASK=trade TASK_ARG='{"dex":"jup","inputMint":"So11...","outputMint":"<mint>","amountSol":0.1}' node index.js
 *
 * Supported DEX targets (controlled by spec.dex):
 *   jup      — jup.ag (Jupiter aggregator)
 *   raydium  — raydium.io swap UI
 *   pump     — pump.fun coin page quick-buy
 *
 * The wallet must already be connected in the browser context (injected via
 * storageState or by supplying a WALLET_STORAGE_STATE_PATH env that points to
 * a Playwright storageState JSON exported from a prior authenticated session).
 */

const DEX_URLS = {
	jup:     'https://jup.ag/swap',
	raydium: 'https://raydium.io/swap/',
	pump:    'https://pump.fun/coin',
};

// Selectors — update these if DEX UIs change their DOM structure.
const JUP_SEL = {
	inputAmount:  'input[placeholder*="0.00"], input[data-testid="from-amount"]',
	swapBtn:      'button[data-testid="swap-button"], button:has-text("Swap")',
	confirmBtn:   'button:has-text("Confirm"), button:has-text("Approve")',
};

const PUMP_SEL = {
	buyTab:       'button:has-text("Buy")',
	amountInput:  'input[placeholder*="SOL"], input[name="amount"]',
	buyBtn:       'button:has-text("Place Trade"), button:has-text("Buy")',
};

const RAYDIUM_SEL = {
	inputAmount:  'input[placeholder*="0.00"]',
	swapBtn:      'button:has-text("Swap"), button[class*="swap-btn"]',
};

/**
 * @param {import('../caster.js').AgentScreenCaster} caster
 * @param {string} argStr  JSON-encoded trade spec (see module JSDoc above)
 */
export async function run(caster, argStr) {
	let spec;
	try {
		spec = argStr ? JSON.parse(argStr) : {};
	} catch {
		throw new Error(`TASK_ARG must be valid JSON trade spec, got: ${argStr}`);
	}

	const {
		dex        = 'pump',
		outputMint = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
		amountSol  = 0.01,
		slippageBps = 100,
	} = spec;

	if (!DEX_URLS[dex]) throw new Error(`Unknown dex "${dex}". Valid: ${Object.keys(DEX_URLS).join(', ')}`);

	// Load wallet session state if provided.
	const storagePath = process.env.WALLET_STORAGE_STATE_PATH;
	if (storagePath) {
		const { readFileSync } = await import('fs');
		try {
			const state = JSON.parse(readFileSync(storagePath, 'utf8'));
			await caster.context.addCookies(state.cookies || []);
			if (state.origins) {
				for (const origin of state.origins) {
					await caster.context.addInitScript(({ url, entries }) => {
						if (window.location.origin !== url) return;
						for (const { name, value } of entries) localStorage.setItem(name, value);
					}, { url: origin.origin, entries: origin.localStorage || [] });
				}
			}
			console.log('[trade] wallet storage state loaded from', storagePath);
		} catch (err) {
			console.warn('[trade] could not load wallet storage state:', err.message);
		}
	}

	console.log(`[trade] executing ${dex} trade: ${amountSol} SOL → ${outputMint.slice(0, 8)}…`);

	if (dex === 'pump') {
		await executePumpTrade(caster, outputMint, amountSol);
	} else if (dex === 'jup') {
		await executeJupTrade(caster, outputMint, amountSol, slippageBps);
	} else if (dex === 'raydium') {
		await executeRaydiumTrade(caster, outputMint, amountSol, slippageBps);
	}
}

// ── DEX-specific flows ─────────────────────────────────────────────────────────

async function executePumpTrade(caster, mint, amountSol) {
	const url = `${DEX_URLS.pump}/${mint}`;

	await caster.act('navigate', `Opening pump.fun coin page for ${mint.slice(0, 8)}…`, async () => {
		await caster.page.goto(url, { waitUntil: 'domcontentloaded' });
		await caster.page.waitForTimeout(2500);
	});

	await caster.act('click', 'Switching to Buy tab', async () => {
		const buyTab = await caster.page.$(PUMP_SEL.buyTab);
		if (buyTab) await buyTab.click();
		await caster.page.waitForTimeout(500);
	});

	await caster.act('input', `Entering trade amount: ${amountSol} SOL`, async () => {
		const input = await caster.page.waitForSelector(PUMP_SEL.amountInput, { timeout: 8000 });
		await input.click({ clickCount: 3 });
		await input.fill(String(amountSol));
		await caster.page.waitForTimeout(300);
	});

	await caster.act('trade', `Submitting buy order: ${amountSol} SOL of ${mint.slice(0, 8)}…`, async () => {
		const btn = await caster.page.waitForSelector(PUMP_SEL.buyBtn, { timeout: 8000 });
		await btn.click();
		await caster.page.waitForTimeout(3000);
	});

	await caster.pushActivity([{
		type:    'trade_submitted',
		summary: `Buy order submitted: ${amountSol} SOL → ${mint.slice(0, 8)}… on pump.fun`,
		ts:      Date.now(),
		payload: { dex: 'pump', mint, amountSol },
	}]);
}

async function executeJupTrade(caster, outputMint, amountSol, slippageBps) {
	// SOL → output token on Jupiter. Input is native SOL (So11111...11112).
	const SOL_MINT = 'So11111111111111111111111111111111111111112';
	const url = `${DEX_URLS.jup}/${SOL_MINT}-${outputMint}`;

	await caster.act('navigate', `Opening Jupiter swap: SOL → ${outputMint.slice(0, 8)}…`, async () => {
		await caster.page.goto(url, { waitUntil: 'domcontentloaded' });
		await caster.page.waitForTimeout(3000);
	});

	await caster.act('input', `Entering ${amountSol} SOL`, async () => {
		const input = await caster.page.waitForSelector(JUP_SEL.inputAmount, { timeout: 10_000 });
		await input.click({ clickCount: 3 });
		await input.fill(String(amountSol));
		await caster.page.waitForTimeout(1500); // let quote refresh
	});

	await caster.act('trade', `Initiating swap: ${amountSol} SOL → ${outputMint.slice(0, 8)}…`, async () => {
		const btn = await caster.page.waitForSelector(JUP_SEL.swapBtn, { timeout: 10_000 });
		await btn.click();
		await caster.page.waitForTimeout(2000);

		// Wallet confirmation dialog.
		const confirm = await caster.page.$(JUP_SEL.confirmBtn);
		if (confirm) await confirm.click();
		await caster.page.waitForTimeout(4000);
	});

	await caster.pushActivity([{
		type:    'trade_submitted',
		summary: `Swap submitted: ${amountSol} SOL → ${outputMint.slice(0, 8)}… on Jupiter`,
		ts:      Date.now(),
		payload: { dex: 'jup', outputMint, amountSol, slippageBps },
	}]);
}

async function executeRaydiumTrade(caster, outputMint, amountSol, slippageBps) {
	const SOL_MINT = 'So11111111111111111111111111111111111111112';
	const url = `${DEX_URLS.raydium}?inputCurrency=${SOL_MINT}&outputCurrency=${outputMint}`;

	await caster.act('navigate', `Opening Raydium swap: SOL → ${outputMint.slice(0, 8)}…`, async () => {
		await caster.page.goto(url, { waitUntil: 'domcontentloaded' });
		await caster.page.waitForTimeout(3000);
	});

	await caster.act('input', `Entering ${amountSol} SOL`, async () => {
		const inputs = await caster.page.$$(RAYDIUM_SEL.inputAmount);
		const input  = inputs[0];
		if (!input) throw new Error('Amount input not found on Raydium');
		await input.click({ clickCount: 3 });
		await input.fill(String(amountSol));
		await caster.page.waitForTimeout(1500);
	});

	await caster.act('trade', `Initiating Raydium swap: ${amountSol} SOL → ${outputMint.slice(0, 8)}…`, async () => {
		const btn = await caster.page.waitForSelector(RAYDIUM_SEL.swapBtn, { timeout: 10_000 });
		await btn.click();
		await caster.page.waitForTimeout(4000);
	});

	await caster.pushActivity([{
		type:    'trade_submitted',
		summary: `Swap submitted: ${amountSol} SOL → ${outputMint.slice(0, 8)}… on Raydium`,
		ts:      Date.now(),
		payload: { dex: 'raydium', outputMint, amountSol, slippageBps },
	}]);
}
