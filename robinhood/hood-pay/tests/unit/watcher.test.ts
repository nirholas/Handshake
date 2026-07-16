import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { awaitPayment, checkPayment, type ChainReader, type WatchSpec } from '../../src/verify/watcher.js'

/**
 * Deterministic in-memory chain for exercising the watcher state machine:
 * blocks advance on demand, logs live in blocks, and a "reorg" replaces a
 * block's hash (and drops its logs) exactly like a real chain would.
 * The live suite (tests/live) runs the same watcher against real mainnet
 * USDG transfers and an anvil fork; this suite pins the state machine.
 */
class FakeChain implements ChainReader {
  head = 0n
  private hashes = new Map<bigint, Hex>()
  private logs: Array<{
    address: Address
    eventName: 'Transfer' | 'PaymentReceived'
    blockNumber: bigint
    logIndex: number
    txHash: Hex
    args: Record<string, unknown>
  }> = []

  private hashFor(block: bigint, generation = 0): Hex {
    return `0x${(block * 1000n + BigInt(generation)).toString(16).padStart(64, '0')}` as Hex
  }

  mineTo(height: bigint) {
    for (let b = this.head + 1n; b <= height; b++) this.hashes.set(b, this.hashFor(b))
    this.head = height
  }

  addTransfer(block: bigint, token: Address, from: Address, to: Address, value: bigint, logIndex = 0) {
    this.mineTo(block > this.head ? block : this.head)
    this.logs.push({
      address: token,
      eventName: 'Transfer',
      blockNumber: block,
      logIndex,
      txHash: `0x${block.toString(16).padStart(8, '0')}${logIndex.toString(16).padStart(56, '0')}` as Hex,
      args: { from, to, value },
    })
  }

  addRouterPayment(block: bigint, router: Address, ref: Hex, payer: Address, payTo: Address, token: Address, amount: bigint, logIndex = 0) {
    this.mineTo(block > this.head ? block : this.head)
    this.logs.push({
      address: router,
      eventName: 'PaymentReceived',
      blockNumber: block,
      logIndex,
      txHash: `0x${block.toString(16).padStart(8, '0')}${(logIndex + 500).toString(16).padStart(56, '0')}` as Hex,
      args: { ref, payer, payTo, token, amount },
    })
  }

  /** Reorg `block` out: new hash, logs in it vanish from the canonical chain. */
  reorg(block: bigint) {
    this.hashes.set(block, this.hashFor(block, 1))
    this.logs = this.logs.filter((log) => log.blockNumber !== block)
  }

  async getBlockNumber() {
    return this.head
  }

  async getBlock({ blockNumber }: { blockNumber: bigint }) {
    return { hash: this.hashes.get(blockNumber) ?? null }
  }

  async getLogs(args: {
    address: Address
    event: { name: string }
    args?: Record<string, unknown>
    fromBlock: bigint
    toBlock: bigint
  }) {
    return this.logs
      .filter((log) => {
        if (log.address.toLowerCase() !== args.address.toLowerCase()) return false
        if (log.eventName !== args.event.name) return false
        if (log.blockNumber < args.fromBlock || log.blockNumber > args.toBlock) return false
        for (const [key, expected] of Object.entries(args.args ?? {})) {
          if (expected === undefined) continue
          if (String(log.args[key]).toLowerCase() !== String(expected).toLowerCase()) return false
        }
        return true
      })
      .map((log) => ({
        transactionHash: log.txHash,
        logIndex: log.logIndex,
        blockNumber: log.blockNumber,
        blockHash: this.hashFor(log.blockNumber),
        args: log.args,
      }))
  }
}

const TOKEN = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address
const ROUTER = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA' as Address
const MERCHANT = '0x4022de2D36C334E73C7a108805Cea11C0564f402' as Address
const BUYER = '0x2d4d2A025b10C09BDbd794B4FCe4F7ea8C7d7bB4' as Address
const OTHER = '0x0000000000000000000000000000000000000BEB' as Address
const REF = `0x${'11'.repeat(32)}` as Hex
const EXPECTED = 12_500_042n

const directSpec: WatchSpec = { token: TOKEN, payTo: MERCHANT, expectedRaw: EXPECTED }
const fast = { confirmations: 5, pollIntervalMs: 5, timeoutMs: 1500 }

describe('direct mode (amount fingerprint)', () => {
  it('settles paid on an exact confirmed match and ignores other amounts', async () => {
    const chain = new FakeChain()
    chain.mineTo(10n)
    chain.addTransfer(11n, TOKEN, OTHER, MERCHANT, 99_000_000n) // someone else's payment
    chain.addTransfer(12n, TOKEN, BUYER, MERCHANT, EXPECTED)
    chain.mineTo(20n) // deep enough to confirm
    const result = await checkPayment(directSpec, { reader: chain, fromBlock: 11n, confirmations: 5 })
    expect(result.status).toBe('paid')
    expect(result.receivedRaw).toBe(EXPECTED)
    expect(result.payer).toBe(BUYER)
    expect(result.transfers).toHaveLength(1)
  })

  it('stays pending while the match is above the confirmation depth', async () => {
    const chain = new FakeChain()
    chain.mineTo(10n)
    chain.addTransfer(11n, TOKEN, BUYER, MERCHANT, EXPECTED)
    chain.mineTo(13n) // only 2 deep, need 5
    const result = await checkPayment(directSpec, { reader: chain, fromBlock: 11n, confirmations: 5 })
    expect(result.status).toBe('pending')
    expect(result.receivedRaw).toBe(0n)
  })

  it('awaitPayment resolves once the transfer gains depth', async () => {
    const chain = new FakeChain()
    chain.mineTo(10n)
    const promise = awaitPayment(directSpec, { reader: chain, fromBlock: 10n, ...fast })
    chain.addTransfer(12n, TOKEN, BUYER, MERCHANT, EXPECTED)
    setTimeout(() => chain.mineTo(20n), 30)
    const result = await promise
    expect(result.status).toBe('paid')
  })

  it('a reorged-out transfer never counts (log vanishes below depth)', async () => {
    const chain = new FakeChain()
    chain.mineTo(10n)
    chain.addTransfer(12n, TOKEN, BUYER, MERCHANT, EXPECTED)
    chain.reorg(12n) // dropped before it ever had 5 confirmations
    chain.mineTo(30n)
    const result = await checkPayment(directSpec, { reader: chain, fromBlock: 10n, confirmations: 5 })
    expect(result.status).toBe('pending')
  })

  it('a log whose block hash changed after scanning is dropped by the re-check', async () => {
    const chain = new FakeChain()
    chain.mineTo(10n)
    chain.addTransfer(12n, TOKEN, BUYER, MERCHANT, EXPECTED)
    chain.mineTo(30n)
    // Simulate the block being replaced but the (stale) log still indexed:
    const original = chain.getLogs.bind(chain)
    chain.getLogs = async (args) => {
      const logs = await original(args)
      chain.reorg(12n) // hash flips between getLogs and getBlock
      return logs
    }
    const result = await checkPayment(directSpec, { reader: chain, fromBlock: 10n, confirmations: 5 })
    expect(result.status).toBe('pending')
  })

  it('with a known payer, under- and overpayment are detected and summed', async () => {
    const chain = new FakeChain()
    chain.mineTo(10n)
    chain.addTransfer(11n, TOKEN, BUYER, MERCHANT, 5_000_000n)
    chain.mineTo(20n)
    const spec: WatchSpec = { ...directSpec, payer: BUYER }
    const under = await checkPayment(spec, { reader: chain, fromBlock: 10n, confirmations: 5 })
    expect(under.status).toBe('underpaid')
    expect(under.receivedRaw).toBe(5_000_000n)

    chain.addTransfer(21n, TOKEN, BUYER, MERCHANT, 10_000_000n, 1)
    chain.mineTo(30n)
    const over = await checkPayment(spec, { reader: chain, fromBlock: 10n, confirmations: 5 })
    expect(over.status).toBe('overpaid')
    expect(over.receivedRaw).toBe(15_000_000n)
    expect(over.overageRaw).toBe(15_000_000n - EXPECTED)
  })

  it('expires when nothing arrives before the timeout', async () => {
    const chain = new FakeChain()
    chain.mineTo(10n)
    const result = await awaitPayment(directSpec, { reader: chain, fromBlock: 10n, confirmations: 5, pollIntervalMs: 5, timeoutMs: 60 })
    expect(result.status).toBe('expired')
  })

  it('an underpayment at timeout reports underpaid, not expired', async () => {
    const chain = new FakeChain()
    chain.mineTo(10n)
    chain.addTransfer(11n, TOKEN, BUYER, MERCHANT, 1_000_000n)
    chain.mineTo(20n)
    const spec: WatchSpec = { ...directSpec, payer: BUYER }
    const result = await awaitPayment(spec, { reader: chain, fromBlock: 10n, confirmations: 5, pollIntervalMs: 5, timeoutMs: 100 })
    expect(result.status).toBe('underpaid')
  })
})

describe('router mode (reference attribution)', () => {
  const routerSpec: WatchSpec = { ...directSpec, reference: REF, router: ROUTER }

  it('matches by reference regardless of amount and sums partial payments', async () => {
    const chain = new FakeChain()
    chain.mineTo(10n)
    chain.addRouterPayment(11n, ROUTER, REF, BUYER, MERCHANT, TOKEN, 5_000_000n)
    chain.addRouterPayment(12n, ROUTER, REF, BUYER, MERCHANT, TOKEN, 7_500_042n, 1)
    chain.addRouterPayment(13n, ROUTER, `0x${'22'.repeat(32)}` as Hex, OTHER, MERCHANT, TOKEN, 9_000_000n) // other invoice
    chain.mineTo(25n)
    const result = await checkPayment(routerSpec, { reader: chain, fromBlock: 10n, confirmations: 5 })
    expect(result.status).toBe('paid')
    expect(result.receivedRaw).toBe(EXPECTED)
    expect(result.transfers).toHaveLength(2)
    expect(result.reference).toBe(REF)
  })

  it('ignores same-reference events for a different token', async () => {
    const chain = new FakeChain()
    chain.mineTo(10n)
    chain.addRouterPayment(11n, ROUTER, REF, BUYER, MERCHANT, OTHER, EXPECTED)
    chain.mineTo(25n)
    const result = await checkPayment(routerSpec, { reader: chain, fromBlock: 10n, confirmations: 5 })
    expect(result.status).toBe('pending')
  })

  it('requires the router address', async () => {
    await expect(
      awaitPayment({ ...directSpec, reference: REF }, { reader: new FakeChain(), fromBlock: 0n, ...fast }),
    ).rejects.toThrow(/router/)
  })

  it('emits onState transitions in order', async () => {
    const chain = new FakeChain()
    chain.mineTo(10n)
    const states: string[] = []
    const promise = awaitPayment(routerSpec, {
      reader: chain,
      fromBlock: 10n,
      ...fast,
      onState: (state) => states.push(state.status),
    })
    setTimeout(() => {
      chain.addRouterPayment(12n, ROUTER, REF, BUYER, MERCHANT, TOKEN, 5_000_000n)
      chain.mineTo(20n)
    }, 20)
    setTimeout(() => {
      chain.addRouterPayment(21n, ROUTER, REF, BUYER, MERCHANT, TOKEN, 7_500_042n, 1)
      chain.mineTo(30n)
    }, 60)
    const result = await promise
    expect(result.status).toBe('paid')
    expect(states).toEqual(['pending', 'underpaid', 'paid'])
  })
})
