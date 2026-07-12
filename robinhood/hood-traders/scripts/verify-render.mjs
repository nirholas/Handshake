#!/usr/bin/env node
// One-off verification: load each page in a real headless browser and report
// console errors. Not part of the build/test pipeline — a manual QA pass.
import puppeteer from 'puppeteer'

const pages = process.argv.slice(2)
if (pages.length === 0) {
  console.error('usage: node scripts/verify-render.mjs <url> [url...]')
  process.exit(1)
}

const browser = await puppeteer.launch({ args: ['--no-sandbox'] })
let anyError = false
for (const url of pages) {
  const page = await browser.newPage()
  const errors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  page.on('pageerror', (err) => errors.push(String(err)))
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 20000 })
  await new Promise((r) => setTimeout(r, 1500)) // let async renders settle
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 200))
  console.log(`\n=== ${url} ===`)
  console.log('body preview:', bodyText.replace(/\n+/g, ' | '))
  if (errors.length) {
    anyError = true
    console.log('CONSOLE ERRORS:')
    errors.forEach((e) => console.log('  -', e))
  } else {
    console.log('no console errors')
  }
  await page.close()
}
await browser.close()
process.exit(anyError ? 1 : 0)
