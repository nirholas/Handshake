#!/usr/bin/env node
/**
 * hood-pay CLI.
 *
 *   hood-pay link --to 0x… --amount 25 --memo "invoice 7"   hosted payment link
 *   hood-pay reference                                       new router-mode reference
 *   hood-pay verify --to 0x… --amount 25.0042 [--from-block N]  await a payment (read-only)
 *
 * Run `hood-pay <command> --help` for every flag.
 */
import { parseArgs } from 'node:util'

const [, , command, ...rest] = process.argv

function fail(message) {
  console.error(`hood-pay: ${message}`)
  process.exit(1)
}

function printHelp() {
  console.log(`hood-pay - USDG checkout tooling for Robinhood Chain

Usage:
  hood-pay link --to 0x… --amount 25 [--memo "invoice 7"] [--network mainnet|testnet]
                [--reference 0x… --router 0x…]
                [--token-address 0x… --token-symbol SYM --token-decimals N]
                [--base-url https://…/pay.html]
  hood-pay reference
  hood-pay verify --to 0x… --amount 25.0042 [--network mainnet|testnet] [--rpc-url URL]
                  [--reference 0x… --router 0x…] [--payer 0x…]
                  [--from-block N] [--confirmations 30] [--timeout-ms 600000]

Commands:
  link       Print a hosted payment link (and its raw fragment) for a request.
  reference  Generate a fresh 32-byte router-mode reference.
  verify     Watch the chain (read-only) until the payment settles; exits 0 on
             paid, 2 on overpaid, 3 on underpaid, 4 on expired.`)
}

if (!command || command === '--help' || command === '-h' || command === 'help') {
  printHelp()
  process.exit(command ? 0 : 1)
}

const core = await import('../dist/index.js')

if (command === 'reference') {
  console.log(core.newReference())
  process.exit(0)
}

if (command === 'link') {
  const { values } = parseArgs({
    args: rest,
    options: {
      to: { type: 'string' },
      amount: { type: 'string' },
      memo: { type: 'string' },
      network: { type: 'string', default: 'mainnet' },
      reference: { type: 'string' },
      router: { type: 'string' },
      'token-address': { type: 'string' },
      'token-symbol': { type: 'string' },
      'token-decimals': { type: 'string' },
      'base-url': { type: 'string', default: 'https://nirholas.github.io/hood-pay/pay.html' },
    },
  })
  if (!values.to) fail('--to is required')
  if (!values.amount) fail('--amount is required (a decimal like 25 or 12.50, or "dynamic")')
  const request = {
    v: 1,
    network: values.network,
    payTo: values.to,
    amount: values.amount,
  }
  if (values.memo) request.memo = values.memo
  if (values.reference) request.reference = values.reference
  if (values.router) request.router = values.router
  if (values['token-address']) {
    if (!values['token-symbol'] || !values['token-decimals']) {
      fail('--token-address needs --token-symbol and --token-decimals too')
    }
    request.token = {
      address: values['token-address'],
      symbol: values['token-symbol'],
      decimals: Number(values['token-decimals']),
    }
  }
  try {
    const url = core.paymentLinkUrl(request, values['base-url'])
    const fragment = core.encodePaymentRequest(request)
    console.log(url)
    console.error(`\nfragment (host it anywhere): #${fragment}`)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  process.exit(0)
}

if (command === 'verify') {
  const { values } = parseArgs({
    args: rest,
    options: {
      to: { type: 'string' },
      amount: { type: 'string' },
      network: { type: 'string', default: 'mainnet' },
      'rpc-url': { type: 'string' },
      reference: { type: 'string' },
      router: { type: 'string' },
      payer: { type: 'string' },
      'from-block': { type: 'string' },
      confirmations: { type: 'string', default: '30' },
      'timeout-ms': { type: 'string', default: '600000' },
      'token-address': { type: 'string' },
      'token-decimals': { type: 'string' },
    },
  })
  if (!values.to) fail('--to is required')
  if (!values.amount) fail('--amount is required (the exact fingerprinted decimal amount)')
  const verify = await import('../dist/verify/index.js')
  const viem = await import('viem')
  const info = core.networkInfo(values.network)
  const decimals = values['token-decimals'] ? Number(values['token-decimals']) : info.usdg.decimals
  const token = values['token-address'] ?? info.usdg.address
  const expectedRaw = viem.parseUnits(values.amount, decimals)
  const reader = verify.createReader(values.network, values['rpc-url'])
  const fromBlock = values['from-block'] ? BigInt(values['from-block']) : await reader.getBlockNumber()

  const spec = { token, payTo: values.to, expectedRaw }
  if (values.reference) {
    if (!values.router) fail('--reference needs --router (the HoodPayRouter address)')
    spec.reference = values.reference
    spec.router = values.router
  }
  if (values.payer) spec.payer = values.payer

  console.error(
    `watching ${values.network} (chain ${info.chainId}) from block ${fromBlock} for ${values.amount} -> ${values.to} …`,
  )
  const result = await verify.awaitPayment(spec, {
    reader,
    fromBlock,
    confirmations: Number(values.confirmations),
    timeoutMs: Number(values['timeout-ms']),
    onState: (state) => console.error(`status: ${state.status} (received ${state.receivedRaw})`),
  })
  console.log(
    JSON.stringify(
      result,
      (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
      2,
    ),
  )
  const exitCodes = { paid: 0, overpaid: 2, underpaid: 3, expired: 4 }
  process.exit(exitCodes[result.status] ?? 5)
}

fail(`unknown command "${command}" (run hood-pay --help)`)
