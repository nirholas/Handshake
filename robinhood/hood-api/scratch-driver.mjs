import { chromium } from 'playwright'
import { writeFile } from 'node:fs/promises'

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const consoleMsgs = []

async function checkViewport(width, height, label) {
  const page = await browser.newPage({ viewport: { width, height } })
  page.on('console', (msg) => consoleMsgs.push(`[${label}] ${msg.type()}: ${msg.text()}`))
  page.on('pageerror', (err) => consoleMsgs.push(`[${label}] pageerror: ${err.message}`))

  await page.goto('http://localhost:4321/index.html', { waitUntil: 'networkidle' })
  await page.waitForTimeout(3000) // allow live RPC fetches to settle

  await page.screenshot({ path: `/tmp/claude-1000/-workspaces-three-ws/4060c41a-4b63-4d32-a0f0-18a266c9b40f/scratchpad/docs-${label}.png`, fullPage: true })

  const tiles = await page.evaluate(() => ({
    block: document.getElementById('tile-block')?.textContent,
    gas: document.getElementById('tile-gas')?.textContent,
    aapl: document.getElementById('tile-aapl')?.textContent,
    tsla: document.getElementById('tile-tsla')?.textContent,
    status: document.getElementById('chain-status-text')?.textContent,
  }))
  console.log(`[${label}] tiles:`, tiles)

  if (label === 'desktop') {
    // expand a free endpoint card and a paid endpoint card
    const freeDetails = await page.$('#free-endpoints details')
    await freeDetails.click()
    await page.waitForTimeout(500)
    const freeResp = await page.$eval('#free-endpoints .resp', (el) => el.textContent)
    console.log('[desktop] first free endpoint response (first 200 chars):', freeResp.slice(0, 200))

    const paidDetails = await page.$('#paid-endpoints details')
    await paidDetails.click()
    await page.waitForTimeout(300)
    const paidResp = await page.$eval('#paid-endpoints .resp', (el) => el.textContent)
    console.log('[desktop] first paid endpoint response (first 200 chars):', paidResp.slice(0, 200))

    // x402 tab switch
    const tabBtns = await page.$$('.tab-btn')
    await tabBtns[1].click()
    await page.waitForTimeout(200)
    const activePanel = await page.$eval('.tabpanel.active', (el) => el.getAttribute('data-tab'))
    console.log('[desktop] active tab after click:', activePanel)

    await page.screenshot({ path: `/tmp/claude-1000/-workspaces-three-ws/4060c41a-4b63-4d32-a0f0-18a266c9b40f/scratchpad/docs-desktop-expanded.png`, fullPage: true })
  }

  await page.close()
}

await checkViewport(1440, 900, 'desktop')
await checkViewport(375, 812, 'mobile')

await writeFile(
  '/tmp/claude-1000/-workspaces-three-ws/4060c41a-4b63-4d32-a0f0-18a266c9b40f/scratchpad/docs-console.log',
  consoleMsgs.join('\n'),
)
console.log('console messages:', consoleMsgs.length)
consoleMsgs.forEach((m) => console.log(m))

await browser.close()
