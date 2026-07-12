#!/usr/bin/env node
/**
 * Reproduces the on-chain verification behind hood402's core design decision:
 * USDG on Robinhood Chain supports EIP-3009 `transferWithAuthorization` via a
 * facet/diamond router (`getFacet(bytes4)`), so the x402 `exact` scheme's
 * gasless EIP-3009 path applies directly — no custom variant needed.
 *
 * Run with `npm run verify:usdg`. Exits non-zero if any check fails, so it
 * can gate a release if USDG's facet registration ever changes.
 */
import { createPublicClient, http } from 'viem'
import { ROBINHOOD_MAINNET, ROBINHOOD_TESTNET } from '../dist/index.js'

const GET_FACET_ABI = [
  {
    type: 'function',
    name: 'getFacet',
    stateMutability: 'view',
    inputs: [{ name: 'selector', type: 'bytes4' }],
    outputs: [{ name: '', type: 'address' }],
  },
]
const DOMAIN_SEPARATOR_ABI = [
  {
    type: 'function',
    name: 'DOMAIN_SEPARATOR',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
]

const TRANSFER_WITH_AUTH_SELECTOR = '0xe3ee160e'
const RECEIVE_WITH_AUTH_SELECTOR = '0xef55bec6'
const AUTHORIZATION_STATE_SELECTOR = '0xe94a0102'
const ZERO = '0x0000000000000000000000000000000000000000'

async function checkNetwork(net) {
  console.log(`\n${net.id} (chain ${net.chainId}) — USDG ${net.usdg}`)
  const client = createPublicClient({ chain: net.chain, transport: http(net.rpcUrl) })

  let ok = true
  for (const [label, selector] of [
    ['transferWithAuthorization', TRANSFER_WITH_AUTH_SELECTOR],
    ['receiveWithAuthorization', RECEIVE_WITH_AUTH_SELECTOR],
    ['authorizationState', AUTHORIZATION_STATE_SELECTOR],
  ]) {
    const facet = await client.readContract({
      address: net.usdg,
      abi: GET_FACET_ABI,
      functionName: 'getFacet',
      args: [selector],
    })
    const registered = facet.toLowerCase() !== ZERO
    console.log(`  getFacet(${label}) -> ${facet} ${registered ? '[OK]' : '[MISSING]'}`)
    if (!registered) ok = false
  }

  const domainSeparator = await client.readContract({
    address: net.usdg,
    abi: DOMAIN_SEPARATOR_ABI,
    functionName: 'DOMAIN_SEPARATOR',
  })
  console.log(`  DOMAIN_SEPARATOR() -> ${domainSeparator}`)
  console.log(`  Expected domain: name="${net.usdgDomain.name}", version="${net.usdgDomain.version}"`)

  return ok
}

const results = await Promise.all([checkNetwork(ROBINHOOD_MAINNET), checkNetwork(ROBINHOOD_TESTNET)])
const allOk = results.every(Boolean)
console.log(`\n${allOk ? 'PASS' : 'FAIL'}: USDG EIP-3009 facet registration ${allOk ? 'confirmed' : 'NOT confirmed'} on both networks.`)
process.exit(allOk ? 0 : 1)
