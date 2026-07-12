import { chromium } from 'playwright'

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const page = await browser.newPage()
const errors = []
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text())
})
page.on('pageerror', (err) => errors.push('pageerror: ' + err.message))

await page.goto('http://localhost:5183/', { waitUntil: 'networkidle' })
await page.waitForSelector('text=hoodkit', { timeout: 10000 })
await page.waitForTimeout(8000) // let live quote/launch streams populate

await page.screenshot({ path: '/tmp/pw-check/screenshot-initial.png', fullPage: true })

const priceTexts = await page.$$eval('.tile-price', (els) => els.map((e) => e.textContent))
const launchRows = await page.$$eval('.launch-row', (els) => els.length)
const panelEmpty = await page.$eval('.panel', (el) => el.textContent?.trim().slice(0, 120)).catch(() => null)

console.log('prices rendered:', priceTexts)
console.log('launch rows rendered:', launchRows)
console.log('panel text (if empty state):', panelEmpty)
console.log('console errors:', errors)

await browser.close()
