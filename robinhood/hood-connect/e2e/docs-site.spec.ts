import { createServer, type Server } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test as base, type BrowserContext, type Page } from '@playwright/test'
import dappwright, { MetaMaskWallet } from '@tenkeylabs/dappwright'

/**
 * The docs landing page IS the product demo: its connect button must work
 * for any visitor with a wallet, exactly as it will on GitHub Pages. This
 * spec serves `docs/` as plain static files (like Pages does) and completes
 * the connect + add-chain-4663 flow with the real MetaMask extension.
 */

const DOCS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs')
const PORT = 8899
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
}

let server: Server

const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const [, , context] = await dappwright.bootstrap('', {
      wallet: 'metamask',
      version: MetaMaskWallet.recommendedVersion,
      seed: 'test test test test test test test test test test test junk',
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

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = join(DOCS_ROOT, req.url === '/' ? 'index.html' : (req.url ?? '').split('?')[0]!)
    if (!existsSync(path)) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
    res.end(readFileSync(path))
  })
  await new Promise<void>((resolve) => server.listen(PORT, resolve))
})

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

async function approvePendingRequests(context: BrowserContext, extensionId: string, dapp: Page): Promise<void> {
  const notification = await context.newPage()
  for (let attempt = 0; attempt < 10; attempt++) {
    const connected = await dapp
      .locator('#connect-demo .hcw-address')
      .isVisible()
      .catch(() => false)
    if (connected) break
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

test('docs landing: live stats render and the connect button completes the flow', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage()
  await page.goto(`http://localhost:${PORT}/`)

  // Live chain data straight from the public RPC on a static page.
  await expect(page.locator('#stat-block')).not.toHaveText(/loading|rpc busy/, { timeout: 60_000 })
  await expect(page.locator('#stat-usdg')).toContainText('$', { timeout: 60_000 })

  // The live connect button: discover MetaMask, connect, add 4663, switch.
  await page.locator('#connect-demo button.hcw-primary').click()
  await approvePendingRequests(context, extensionId, page)

  await expect(page.locator('#connect-demo .hcw-address')).toContainText(/0xf39f/i, { timeout: 60_000 })
  await expect(page.locator('#connect-demo .hcw-balances')).toContainText('USDG', { timeout: 60_000 })
  await expect(page.locator('#connect-demo .hcw-msg')).toContainText('Robinhood Chain')

  // The add-network page (button-as-a-service) registers the testnet too.
  await page.goto(`http://localhost:${PORT}/add.html?network=testnet`)
  await page.locator('#add-row button').click()
  const notification = await context.newPage()
  await notification.goto(`chrome-extension://${extensionId}/notification.html`).catch(() => {})
  await notification
    .getByRole('button', { name: /^(Confirm|Approve)$/ })
    .first()
    .click({ timeout: 15_000 })
  await notification.close()
  await expect(page.locator('#add-msg')).toContainText('chain 46630', { timeout: 30_000 })

  await page.screenshot({ path: 'test-results/docs-add-testnet.png', fullPage: false })
})
