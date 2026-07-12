import { describe, it, expect } from 'vitest'
import { encodeAbiParameters } from 'viem'
import { ODYSSEY_BONDING_CONSTANTS, ODYSSEY_SELECTORS } from '../../src/rails/addresses.js'

/**
 * Proves the Odyssey rail's calldata against REAL historical transactions.
 * Neither Odyssey factory publishes a verified ABI on Blockscout, so every
 * selector and argument layout here was recovered by decoding real txs
 * (see `robinhood/hood-launcher`'s README "Rails shipped vs excluded" for
 * the full decode trail, including a survey of all 47 on-chain
 * `TokenCreated` emissions that found FOUR distinct create selectors on the
 * bonding factory — two of them requiring an off-chain backend ECDSA
 * signature this rail cannot produce). `0x56f698a3` is the only variant
 * proven simple, unsigned, and reproducible byte-for-byte from real txs, so
 * it's the one this rail ships. Every constant below was fetched directly
 * from `eth_getTransactionByHash` on mainnet 4663 during this build.
 */
describe('Odyssey instant-factory create calldata', () => {
  it('reproduces the real CeoCat (CEOCAT) instant-create tx, msg.value == buyAmount', () => {
    // Real tx: 0x8a21d7f33ed34422f7c68e138dbc3cf97f7e9185552f8e4497a83885a1245f8c
    // to: 0xD7601cEe401306fdea5833c6898181D9c770F800 (instantFactory), value 0.03 ETH
    const REAL_CALLDATA = '0x548eb31b000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000006a94d74f430000000000000000000000000000000000000000000000000000000000000000000643656f4361740000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000643454f4341540000000000000000000000000000000000000000000000000000'
    const built =
      ODYSSEY_SELECTORS.instantCreate +
      encodeAbiParameters(
        [{ type: 'string' }, { type: 'string' }, { type: 'uint256' }],
        ['CeoCat', 'CEOCAT', 30000000000000000n],
      ).slice(2)
    expect(built.toLowerCase()).toBe(REAL_CALLDATA.toLowerCase())
  })

  it('reproduces the real Deadend (DEADEND) instant-create tx with a zero initial buy', () => {
    // Real tx: 0x4da9887c9634ed9c56aba2665cdfbac40ed8fd30d370f46fc6777cbd87df9e9e, value 0
    const REAL_CALLDATA = '0x548eb31b000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000744656164656e6400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000744454144454e4400000000000000000000000000000000000000000000000000'
    const built =
      ODYSSEY_SELECTORS.instantCreate +
      encodeAbiParameters([{ type: 'string' }, { type: 'string' }, { type: 'uint256' }], ['Deadend', 'DEADEND', 0n]).slice(2)
    expect(built.toLowerCase()).toBe(REAL_CALLDATA.toLowerCase())
  })
})

describe('Odyssey bonding-factory create calldata', () => {
  it('reproduces the real "test ai" (TESTAI) bonding create tx', () => {
    // Real tx: 0xd1404ae204c947d8a3f2cbc516fdc4903d3097580e74501cdd2d1de74c386ff3
    // to: 0xEb3FeeD2716cF0eEAda05B22e67424794e1f5a80 (bondingCurveFactory), value 0
    const REAL_CALLDATA = '0x56f698a3000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000006f05b59d3b2000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000007746573742061690000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000065445535441490000000000000000000000000000000000000000000000000000'
    const built =
      ODYSSEY_SELECTORS.bondingCreate +
      encodeAbiParameters(
        [{ type: 'string' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint256' }],
        ['test ai', 'TESTAI', ODYSSEY_BONDING_CONSTANTS.threshold, ODYSSEY_BONDING_CONSTANTS.reserved],
      ).slice(2)
    expect(built.toLowerCase()).toBe(REAL_CALLDATA.toLowerCase())
  })

  it('reproduces the real Sofia (SOFIA) bonding create tx — proves the trailing constants recur', () => {
    // Real tx: 0xd024b90b425e4eb7be45c96435d22fdeeef9d1a57ec90c95a635f39ef32ef971
    const REAL_CALLDATA = '0x56f698a3000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000006f05b59d3b2000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005536f6669610000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005534f464941000000000000000000000000000000000000000000000000000000'
    const built =
      ODYSSEY_SELECTORS.bondingCreate +
      encodeAbiParameters(
        [{ type: 'string' }, { type: 'string' }, { type: 'uint256' }, { type: 'uint256' }],
        ['Sofia', 'SOFIA', ODYSSEY_BONDING_CONSTANTS.threshold, ODYSSEY_BONDING_CONSTANTS.reserved],
      ).slice(2)
    expect(built.toLowerCase()).toBe(REAL_CALLDATA.toLowerCase())
  })
})

describe('Odyssey bonding-factory buy calldata shape', () => {
  it('matches the real buy tx argument layout: buy(address token, uint256 minTokensOut)', () => {
    // Real tx: 0xf3bd87ab66517420996e02b72c4c8c9401e8006af7b5b063aa0eb15481749afe, value 0.000439816283231174 ETH
    const REAL_CALLDATA = '0xcce7ec13000000000000000000000000edd60ab7a13b98233ef0d5d108215a88a9ab6fcd0000000000000000000000000000000000000000000000000000003f0a4252f6'
    const built =
      ODYSSEY_SELECTORS.bondingBuy +
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }],
        ['0xEdD60AB7a13B98233ef0D5D108215a88a9aB6fcd', 270_755_058_422n],
      ).slice(2)
    expect(built.toLowerCase()).toBe(REAL_CALLDATA.toLowerCase())
  })
})
