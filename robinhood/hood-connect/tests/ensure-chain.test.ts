import { describe, expect, it } from 'vitest'
import { robinhood } from 'viem/chains'
import {
  ChainAddRejectedError,
  ChainSwitchRejectedError,
  ConnectionRejectedError,
  ensureChain,
  type EnsureChainState,
} from '../src/index.js'
import { cooperativeWallet, rpcError, scriptedProvider } from './harness/mock-provider.js'

const ADDRESS = '0x00000000000000000000000000000000000004d7'

function collect(): { states: string[]; onState: (state: EnsureChainState) => void } {
  const states: string[] = []
  return { states, onState: (state) => states.push(state.status) }
}

describe('ensureChain state machine', () => {
  it('already on 4663: connects without switching', async () => {
    const wallet = cooperativeWallet({ address: ADDRESS, chainId: robinhood.id })
    const { states, onState } = collect()

    const result = await ensureChain(wallet, { onState })
    expect(result).toEqual({ address: ADDRESS, chainId: robinhood.id })
    expect(states).toEqual(['connecting', 'connected'])
    expect(wallet.calls.map((c) => c.method)).not.toContain('wallet_switchEthereumChain')
  })

  it('chain known to wallet: connect then switch', async () => {
    const wallet = cooperativeWallet({ address: ADDRESS, chainId: 1, knownChains: [1, robinhood.id] })
    const { states, onState } = collect()

    const result = await ensureChain(wallet, { onState })
    expect(result.chainId).toBe(robinhood.id)
    expect(states).toEqual(['connecting', 'switching', 'connected'])
    expect(wallet.calls.map((c) => c.method)).not.toContain('wallet_addEthereumChain')
  })

  it('chain unknown (4902): add, wallet auto-switches', async () => {
    const wallet = cooperativeWallet({ address: ADDRESS, chainId: 1, knownChains: [1], autoSwitchOnAdd: true })
    const { states, onState } = collect()

    const result = await ensureChain(wallet, { onState })
    expect(result.chainId).toBe(robinhood.id)
    expect(states).toEqual(['connecting', 'switching', 'adding', 'connected'])
    expect(wallet.calls.map((c) => c.method)).toContain('wallet_addEthereumChain')
  })

  it('chain unknown (4902): add without auto-switch, then explicit switch', async () => {
    const wallet = cooperativeWallet({ address: ADDRESS, chainId: 1, knownChains: [1], autoSwitchOnAdd: false })
    const { states, onState } = collect()

    const result = await ensureChain(wallet, { onState })
    expect(result.chainId).toBe(robinhood.id)
    expect(states).toEqual(['connecting', 'switching', 'adding', 'switching', 'connected'])
    const methods = wallet.calls.map((c) => c.method)
    expect(methods.filter((m) => m === 'wallet_switchEthereumChain')).toHaveLength(2)
  })

  it("MetaMask's nested -32603/4902 wrapping still routes to the add path", async () => {
    const wallet = cooperativeWallet({ address: ADDRESS, chainId: 1, knownChains: [1] })
    wallet.set('wallet_switchEthereumChain', (args) => {
      const target = Number.parseInt((args.params as [{ chainId: string }])[0].chainId, 16)
      if (target === robinhood.id) {
        throw rpcError(-32603, 'Internal JSON-RPC error.', { originalError: { code: 4902 } })
      }
      return null
    })
    // After the add, the wallet switches itself.
    wallet.set('wallet_addEthereumChain', () => {
      wallet.set('eth_chainId', () => '0x1237')
      return null
    })

    const { states, onState } = collect()
    const result = await ensureChain(wallet, { onState })
    expect(result.chainId).toBe(robinhood.id)
    expect(states).toContain('adding')
  })

  it('user rejects the connection (4001)', async () => {
    const wallet = scriptedProvider({
      eth_requestAccounts: rpcError(4001, 'User rejected the request.'),
    })
    const { states, onState } = collect()

    await expect(ensureChain(wallet, { onState })).rejects.toBeInstanceOf(ConnectionRejectedError)
    expect(states).toEqual(['connecting', 'error'])
  })

  it('user rejects the switch (4001)', async () => {
    const wallet = cooperativeWallet({ address: ADDRESS, chainId: 1, knownChains: [1, robinhood.id] })
    wallet.set('wallet_switchEthereumChain', () => {
      throw rpcError(4001, 'User rejected the request.')
    })
    const { states, onState } = collect()

    const failure = await ensureChain(wallet, { onState }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ChainSwitchRejectedError)
    expect((failure as ChainSwitchRejectedError).rejectedByUser).toBe(true)
    expect(states).toEqual(['connecting', 'switching', 'error'])
  })

  it('user rejects the add (4001)', async () => {
    const wallet = cooperativeWallet({ address: ADDRESS, chainId: 1, knownChains: [1] })
    wallet.set('wallet_addEthereumChain', () => {
      throw rpcError(4001, 'User rejected the request.')
    })
    const { states, onState } = collect()

    const failure = await ensureChain(wallet, { onState }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ChainAddRejectedError)
    expect((failure as ChainAddRejectedError).rejectedByUser).toBe(true)
    expect(states).toEqual(['connecting', 'switching', 'adding', 'error'])
  })

  it('wallet refuses the add for non-user reasons', async () => {
    const wallet = cooperativeWallet({ address: ADDRESS, chainId: 1, knownChains: [1] })
    wallet.set('wallet_addEthereumChain', () => {
      throw rpcError(-32602, 'Invalid chain parameters.')
    })

    const failure = await ensureChain(wallet).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ChainAddRejectedError)
    expect((failure as ChainAddRejectedError).rejectedByUser).toBe(false)
  })

  it('user rejects the post-add switch', async () => {
    const wallet = cooperativeWallet({ address: ADDRESS, chainId: 1, knownChains: [1], autoSwitchOnAdd: false })
    let addDone = false
    wallet.set('wallet_addEthereumChain', () => {
      addDone = true
      return null
    })
    wallet.set('wallet_switchEthereumChain', () => {
      if (addDone) throw rpcError(4001, 'User rejected the request.')
      throw rpcError(4902, 'Unrecognized chain ID.')
    })

    const failure = await ensureChain(wallet).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ChainSwitchRejectedError)
    expect((failure as ChainSwitchRejectedError).rejectedByUser).toBe(true)
  })

  it('wallet claims success but stays on the wrong chain', async () => {
    const wallet = scriptedProvider({
      eth_requestAccounts: () => [ADDRESS],
      eth_chainId: () => '0x1',
      wallet_switchEthereumChain: () => null,
    })

    const failure = await ensureChain(wallet).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ChainSwitchRejectedError)
    expect((failure as Error).message).toMatch(/on chain 1, not 4663/)
  })

  it('wallet returns an empty account list', async () => {
    const wallet = scriptedProvider({ eth_requestAccounts: () => [] })
    await expect(ensureChain(wallet)).rejects.toThrow(/no accounts/i)
  })

  it('targets the testnet when asked', async () => {
    const wallet = cooperativeWallet({ address: ADDRESS, chainId: 1, knownChains: [1] })
    const result = await ensureChain(wallet, { network: 'testnet' })
    expect(result.chainId).toBe(46630)
    const addCall = wallet.calls.find((c) => c.method === 'wallet_addEthereumChain')
    expect((addCall!.params as [{ chainId: string }])[0].chainId).toBe('0xb626')
  })
})
