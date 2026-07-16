import { encodeFunctionData, parseAbi, toFunctionSelector } from 'viem'
import { describe, expect, it } from 'vitest'
import { erc20Abi, hoodPayRouterAbi } from '../../src/abi.js'
import { buildApproveTx, buildRouterPayTx, buildTransferTx } from '../../src/tx.js'

const TOKEN = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const // real mainnet USDG
const PAY_TO = '0x4022de2D36C334E73C7a108805Cea11C0564f402' as const
const ROUTER = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA' as const
const REF = `0x${'ab'.repeat(32)}` as const
const AMOUNT = 12_500_042n

describe('unsigned tx construction', () => {
  it('buildTransferTx pins the exact ERC-20 transfer calldata', () => {
    const call = buildTransferTx(TOKEN, PAY_TO, AMOUNT)
    expect(call.to).toBe(TOKEN)
    expect(call.value).toBe(0n)
    expect(call.data.slice(0, 10)).toBe('0xa9059cbb') // transfer(address,uint256)
    const reference = encodeFunctionData({
      abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
      functionName: 'transfer',
      args: [PAY_TO, AMOUNT],
    })
    expect(call.data).toBe(reference)
  })

  it('buildApproveTx pins the exact ERC-20 approve calldata', () => {
    const call = buildApproveTx(TOKEN, ROUTER, AMOUNT)
    expect(call.to).toBe(TOKEN)
    expect(call.data.slice(0, 10)).toBe('0x095ea7b3') // approve(address,uint256)
    const reference = encodeFunctionData({
      abi: parseAbi(['function approve(address spender, uint256 amount) returns (bool)']),
      functionName: 'approve',
      args: [ROUTER, AMOUNT],
    })
    expect(call.data).toBe(reference)
  })

  it('buildRouterPayTx targets the router with pay(token, payTo, amount, ref)', () => {
    const call = buildRouterPayTx(ROUTER, TOKEN, PAY_TO, AMOUNT, REF)
    expect(call.to).toBe(ROUTER)
    expect(call.data.slice(0, 10)).toBe(toFunctionSelector('pay(address,address,uint256,bytes32)'))
    const reference = encodeFunctionData({
      abi: parseAbi(['function pay(address token, address payTo, uint256 amount, bytes32 ref)']),
      functionName: 'pay',
      args: [TOKEN, PAY_TO, AMOUNT, REF],
    })
    expect(call.data).toBe(reference)
  })

  it('literal ABIs match their human-readable definitions', () => {
    // Guards the hand-written literal ABIs against drift.
    const readable = parseAbi([
      'function pay(address token, address payTo, uint256 amount, bytes32 ref)',
      'event PaymentReceived(bytes32 indexed ref, address indexed payer, address indexed payTo, address token, uint256 amount)',
    ])
    expect(hoodPayRouterAbi).toMatchObject(JSON.parse(JSON.stringify(readable)))
    const erc20 = parseAbi([
      'function transfer(address to, uint256 amount) returns (bool)',
      'event Transfer(address indexed from, address indexed to, uint256 value)',
    ])
    const names = new Set(erc20Abi.map((item) => item.name))
    for (const item of erc20) expect(names.has(item.name)).toBe(true)
  })
})
