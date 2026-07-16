import { expect, test as base, type BrowserContext, type Page } from '@playwright/test'
import dappwright, { MetaMaskWallet } from '@tenkeylabs/dappwright'

/**
 * The full onboarding journey in a real browser with the REAL MetaMask
 * extension (downloaded and onboarded by dappwright; no injected mocks):
 *   discover -> connect -> add chain 4663 (EIP-3085) -> switch -> live
 *   balances -> empty-wallet funding options -> live swap quote.
 *
 * The wallet uses a throwaway dev seed (hardhat account 0); it holds nothing
 * on 4663 and nothing here spends funds. All chain data is real mainnet.
 *
 * Under xvfb, Chrome cannot open MetaMask's floating notification window, so
 * pending requests are approved by driving `notification.html` directly (the
 * same UI the popup would show).
 */

const SEED = 'test test test test test test test test test test test junk'
// First account of the seed above (well-known hardhat/anvil dev account).
// Compared lowercase: wallets differ on checksum casing in eth_accounts.
const ADDRESS_PREFIX = '0xf39f'

const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const [, , context] = await dappwright.bootstrap('', {
      wallet: 'metamask',
      version: MetaMaskWallet.recommendedVersion,
      seed: SEED,
      headless: false,
    })
    await use(context)
    await context.close()
  },
  extensionId: async ({ context }, use) => {
    const extensionPage = context.pages().find((p) => p.url().startsWith('chrome-extension://'))
    const match = extensionPage?.url().match(/^chrome-extension:\/\/([a-z]+)\//)
    if (!match) throw new Error('MetaMask extension page not found')
    await use(match[1]!)
  },
})

/**
 * Approve MetaMask's pending requests (connect approval, then the EIP-3085
 * "Add Robinhood Chain" suggestion) until the dApp reports a connection.
 */
async function approvePendingRequests(context: BrowserContext, extensionId: string, dapp: Page): Promise<void> {
  const notification = await context.newPage()
  for (let attempt = 0; attempt < 10; attempt++) {
    const panelText = (await dapp.getByTestId('connect-panel').textContent().catch(() => '')) ?? ''
    if (panelText.toLowerCase().includes(ADDRESS_PREFIX)) break
    await notification.goto(`chrome-extension://${extensionId}/notification.html`).catch(() => {})
    const actionButton = notification.getByRole('button', {
      name: /^(Connect|Confirm|Approve|Switch network)$/,
    })
    try {
      await actionButton.first().click({ timeout: 4000 })
    } catch {
      // No pending request rendered yet; poll again.
    }
    await notification.waitForTimeout(1500)
  }
  await notification.close()
}

test('connect, add Robinhood Chain, read balances, surface funding, quote swap', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto('http://localhost:4173/')

  // The live swap quote renders before any wallet interaction: a real
  // QuoterV2 eth_call on mainnet 4663 through the public RPC.
  await expect(page.getByTestId('swap-quote')).toContainText('WETH', { timeout: 90_000 })

  // 1. Connect. MetaMask is the only wallet, so the button connects
  // directly; hood-connect then hits the 4902 path and suggests the chain
  // via EIP-3085. Approve both prompts in the real MetaMask UI.
  await page.getByRole('button', { name: 'Connect wallet' }).click()
  await approvePendingRequests(context, extensionId, page)

  // 2. Connected pill with the wallet address, on chain 4663 (ensureChain
  // verifies the final chainId before reporting connected).
  await expect(page.getByTestId('connect-panel')).toContainText(/0xf39f/i, { timeout: 60_000 })

  // 3. Live balance bootstrap: fresh wallet, 0 ETH / 0 USDG, empty-wallet
  // state designed with funding options.
  await expect(page.getByTestId('balances')).toContainText('0 ETH', { timeout: 60_000 })
  await expect(page.getByTestId('balances')).toContainText('empty wallet detected')
  await expect(page.getByTestId('balances')).toContainText('Bridge from another chain')

  // 4. Swap step is wired but gated on holding 1 USDG (this wallet has 0).
  await expect(page.getByTestId('swap-needs-funds')).toContainText('needs 1 USDG', { timeout: 30_000 })
  await expect(page.getByTestId('swap-execute')).toBeDisabled()

  await page.screenshot({ path: 'test-results/onboarding-connected.png', fullPage: true })
})
