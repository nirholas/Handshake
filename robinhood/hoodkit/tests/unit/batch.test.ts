import { describe, expect, it, vi } from 'vitest'
import { plan, createBatcher, type ContractRead } from '../../src/batch/index.js'
import type { HoodClient } from 'hoodchain'

const dummyAbi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

function fakeClientWithMulticall(handler: (contracts: readonly ContractRead[]) => unknown[]) {
  const multicall = vi.fn(async ({ contracts }: { contracts: readonly ContractRead[] }) => handler(contracts))
  const client = { public: { multicall } } as unknown as HoodClient
  return { client, multicall }
}

describe('plan()', () => {
  it('returns results in input order and never rejects on a single failing read', async () => {
    const { client } = fakeClientWithMulticall((contracts) =>
      contracts.map((c, i) =>
        i === 1
          ? { status: 'failure', error: new Error('reverted') }
          : { status: 'success', result: BigInt(i) },
      ),
    )
    const reads: ContractRead[] = [
      { address: '0x1', abi: dummyAbi, functionName: 'balanceOf', args: ['0xa'] },
      { address: '0x2', abi: dummyAbi, functionName: 'balanceOf', args: ['0xb'] },
      { address: '0x3', abi: dummyAbi, functionName: 'balanceOf', args: ['0xc'] },
    ]
    const results = await plan(client, reads)
    expect(results[0]).toEqual({ status: 'success', result: 0n })
    expect(results[1]?.status).toBe('failure')
    expect(results[2]).toEqual({ status: 'success', result: 2n })
  })

  it('chunks reads exceeding maxBatchSize into multiple multicall round-trips', async () => {
    const { client, multicall } = fakeClientWithMulticall((contracts) => contracts.map((_, i) => ({ status: 'success', result: i })))
    const reads: ContractRead[] = Array.from({ length: 250 }, (_, i) => ({
      address: `0x${i}`,
      abi: dummyAbi,
      functionName: 'balanceOf',
      args: ['0xa'],
    }))
    const results = await plan(client, reads, { maxBatchSize: 100 })
    expect(multicall).toHaveBeenCalledTimes(3) // 100 + 100 + 50
    expect(results).toHaveLength(250)
  })

  it('returns an empty array for an empty read list without calling multicall', async () => {
    const { client, multicall } = fakeClientWithMulticall(() => [])
    const results = await plan(client, [])
    expect(results).toEqual([])
    expect(multicall).not.toHaveBeenCalled()
  })
})

describe('createBatcher()', () => {
  it('coalesces reads enqueued in the same tick into one multicall', async () => {
    const { client, multicall } = fakeClientWithMulticall((contracts) => contracts.map((_, i) => ({ status: 'success', result: BigInt(i * 10) })))
    const batcher = createBatcher(client)

    const [a, b, c] = await Promise.all([
      batcher.call<bigint>({ address: '0x1', abi: dummyAbi, functionName: 'balanceOf', args: ['0xa'] }),
      batcher.call<bigint>({ address: '0x2', abi: dummyAbi, functionName: 'balanceOf', args: ['0xb'] }),
      batcher.call<bigint>({ address: '0x3', abi: dummyAbi, functionName: 'balanceOf', args: ['0xc'] }),
    ])

    expect(multicall).toHaveBeenCalledTimes(1)
    expect([a, b, c]).toEqual([0n, 10n, 20n])
  })

  it('call() throws on a failed read; callSafe() returns the failure status', async () => {
    const { client } = fakeClientWithMulticall((contracts) =>
      contracts.map(() => ({ status: 'failure', error: new Error('boom') })),
    )
    const batcher = createBatcher(client)

    await expect(batcher.call({ address: '0x1', abi: dummyAbi, functionName: 'balanceOf', args: ['0xa'] })).rejects.toThrow('boom')

    const safe = await batcher.callSafe({ address: '0x1', abi: dummyAbi, functionName: 'balanceOf', args: ['0xa'] })
    expect(safe.status).toBe('failure')
  })

  it('separate ticks produce separate multicall calls', async () => {
    const { client, multicall } = fakeClientWithMulticall((contracts) => contracts.map(() => ({ status: 'success', result: 1n })))
    const batcher = createBatcher(client)

    await batcher.call({ address: '0x1', abi: dummyAbi, functionName: 'balanceOf', args: ['0xa'] })
    await batcher.call({ address: '0x2', abi: dummyAbi, functionName: 'balanceOf', args: ['0xb'] })

    expect(multicall).toHaveBeenCalledTimes(2)
  })
})
