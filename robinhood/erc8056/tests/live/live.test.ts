/**
 * Live reads against Robinhood Chain mainnet (chain 4663) over the public
 * RPC. Read-only; no keys, no funds. Run with `npm run test:live`.
 *
 * These tests pin the package's semantic claims to the chain itself:
 * every canonical Stock Token implements ERC-8056 with the pending and
 * balances extensions but WITHOUT the conversion extension, and
 * `totalSupplyUI` equals the package's local `trueBalance` math.
 */
import { createPublicClient, http, type Address } from 'viem'
import { robinhood } from 'viem/chains'
import { describe, expect, it } from 'vitest'
import {
  detectErc8056,
  readMultiplierState,
  readUiMultiplier,
  supportsErc8056,
  trueBalance,
  erc8056Abi,
  MULTIPLIER_ONE,
} from '../../src/index.js'

const client = createPublicClient({ chain: robinhood, transport: http() })

/** Canonical Stock Tokens (addresses verified on robinhoodchain.blockscout.com). */
const TOKENS = {
  AAPL: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
  AMZN: '0x12f190a9F9d7D37a250758b26824B97CE941bF54',
  SGOV: '0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5',
  WEEK: '0xc93a8c440CEa26D7445dF01729f193b27965099f',
} as const satisfies Record<string, Address>

/** Multicall3 - definitely not an ERC-8056 implementer. */
const NON_IMPLEMENTER: Address = '0xca11bde05977b3631167028862be2a173976ca11'

describe('live ERC-8056 reads on chain 4663', () => {
  for (const [symbol, address] of Object.entries(TOKENS)) {
    it(`${symbol} implements ERC-8056 with a sane multiplier`, async () => {
      const multiplier = await readUiMultiplier(client, address)
      // Multipliers only move up from 1.0 (reinvested distributions,
      // forward splits observed so far); a reverse split could send one
      // below 1e18, so only assert positivity + a sanity ceiling.
      expect(multiplier).toBeGreaterThan(0n)
      expect(multiplier).toBeLessThan(100n * MULTIPLIER_ONE)
      console.log(`${symbol} uiMultiplier: ${multiplier}`)
    })

    it(`${symbol} reports core + pending + balances extensions via ERC-165, no conversion`, async () => {
      const support = await detectErc8056(client, address)
      expect(support).toEqual({
        supported: true,
        viaErc165: true,
        extensions: { pendingMultiplier: true, conversion: false, balances: true },
      })
    })
  }

  it('SGOV totalSupplyUI matches local trueBalance math bit-for-bit', async () => {
    const [multiplier, totalSupply, totalSupplyUi] = await Promise.all([
      readUiMultiplier(client, TOKENS.SGOV),
      client.readContract({
        address: TOKENS.SGOV,
        abi: [
          {
            type: 'function',
            name: 'totalSupply',
            stateMutability: 'view',
            inputs: [],
            outputs: [{ type: 'uint256' }],
          },
        ] as const,
        functionName: 'totalSupply',
      }),
      client.readContract({
        address: TOKENS.SGOV,
        abi: erc8056Abi,
        functionName: 'totalSupplyUI',
      }),
    ])
    expect(trueBalance({ raw: totalSupply, multiplier })).toBe(totalSupplyUi)
  })

  it('readMultiplierState exposes the last applied corporate action', async () => {
    const state = await readMultiplierState(client, TOKENS.WEEK)
    expect(state.current).toBeGreaterThan(0n)
    // WEEK's last update took effect 2026-06-29T13:30:00Z; once effective,
    // newUIMultiplier equals the active multiplier and pending is null
    // (unless a new action is scheduled between now and this test run).
    if (state.pending === null) {
      expect(state.newMultiplier).toBe(state.current)
    } else {
      expect(state.pending.effectiveAt.getTime()).toBeGreaterThan(Date.now())
    }
  })

  it('supportsErc8056 is false for a non-implementer and never throws', async () => {
    await expect(supportsErc8056(client, NON_IMPLEMENTER)).resolves.toBe(false)
  })
})
