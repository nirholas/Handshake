import {
  discoverWallets,
  ensureChain,
  type Eip1193Provider,
  type Eip6963ProviderDetail,
} from 'hood-connect'
import { decodeFunctionResult, encodeFunctionData, formatUnits, parseUnits, type Address, type Hex } from 'viem'
import { erc20Abi } from '../abi.js'
import { explorerTxUrl, networkInfo } from '../networks.js'
import {
  requestRawAmount,
  requestToken,
  validatePaymentRequest,
  type PaymentRequest,
} from '../request.js'
import { buildApproveTx, buildRouterPayTx, buildTransferTx, type UnsignedCall } from '../tx.js'
import { ensureStyles } from './styles.js'

/**
 * The embeddable hood-pay checkout. One div + one call (or one script tag,
 * via the IIFE build). The widget NEVER holds keys, never custodies funds,
 * and never decides amounts from the DOM at settlement time - it only
 * builds unsigned calls for the buyer's own wallet to approve, and the
 * merchant's verifier re-checks everything on-chain.
 */

/** What `onSuccess` receives after the payment transaction is mined. */
export interface CheckoutReceipt {
  txHash: Hex
  payer: Address
  /** Raw token units paid (decimal string - JSON-safe). */
  amountRaw: string
  /** Display amount, e.g. `"12.5"`. */
  amount: string
  tokenSymbol: string
  network: 'mainnet' | 'testnet'
  reference?: Hex
  explorerUrl: string
}

/** Merchant-facing widget configuration. */
export interface CheckoutConfig {
  /** Merchant receiving address. */
  payTo: string
  /** Decimal amount (`"12.50"`) or `"dynamic"` for buyer-entered amounts. */
  amount: string
  /** `'mainnet'` (default) or `'testnet'`. */
  network?: 'mainnet' | 'testnet'
  /** Override the payment token (default: USDG on the chosen network). */
  token?: { address: string; symbol: string; decimals: number }
  /** Shown to the buyer. Off-chain only. */
  memo?: string
  /** Router-mode reference (32-byte hex). Requires `router`. */
  reference?: string
  /** HoodPayRouter address (router mode). */
  router?: string
  onSuccess?: (receipt: CheckoutReceipt) => void
  onError?: (error: Error) => void
  /** Observer for every state transition (analytics, custom UI hooks). */
  onStateChange?: (state: CheckoutState) => void
}

/** Every observable widget state. */
export type CheckoutState =
  | { step: 'review' }
  | { step: 'discovering' }
  | { step: 'choose-wallet'; wallets: number }
  | { step: 'connecting'; wallet: string }
  | { step: 'insufficient'; balance: string; needed: string }
  | { step: 'approving' }
  | { step: 'paying' }
  | { step: 'confirming'; txHash: Hex }
  | { step: 'success'; receipt: CheckoutReceipt }
  | { step: 'error'; message: string; recoverable: boolean }

/** Handle returned by {@link mountCheckout}. */
export interface CheckoutHandle {
  /** The validated request this checkout renders. */
  request: PaymentRequest
  /** Unmount and remove all DOM/listeners. */
  destroy(): void
}

/**
 * Validate a raw config into `{ request, callbacks }`. Exported for unit
 * tests and for the payment-link page, which builds configs from URL data.
 */
export function validateCheckoutConfig(config: unknown): {
  request: PaymentRequest
  onSuccess?: (receipt: CheckoutReceipt) => void
  onError?: (error: Error) => void
  onStateChange?: (state: CheckoutState) => void
} {
  if (typeof config !== 'object' || config === null) throw new TypeError('checkout config must be an object')
  const c = config as Record<string, unknown>
  for (const key of ['onSuccess', 'onError', 'onStateChange'] as const) {
    if (c[key] !== undefined && typeof c[key] !== 'function') {
      throw new TypeError(`${key} must be a function`)
    }
  }
  const request = validatePaymentRequest({
    v: 1,
    network: c.network ?? 'mainnet',
    payTo: c.payTo,
    amount: c.amount,
    token: c.token,
    memo: c.memo,
    reference: c.reference,
    router: c.router,
  })
  const out: ReturnType<typeof validateCheckoutConfig> = { request }
  if (c.onSuccess) out.onSuccess = c.onSuccess as (receipt: CheckoutReceipt) => void
  if (c.onError) out.onError = c.onError as (error: Error) => void
  if (c.onStateChange) out.onStateChange = c.onStateChange as (state: CheckoutState) => void
  return out
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

async function readUint(provider: Eip1193Provider, to: Address, data: Hex, fn: 'balanceOf' | 'allowance'): Promise<bigint> {
  const raw = (await provider.request({ method: 'eth_call', params: [{ to, data }, 'latest'] })) as Hex
  return decodeFunctionResult({ abi: erc20Abi, functionName: fn, data: raw }) as bigint
}

async function sendCall(provider: Eip1193Provider, from: Address, call: UnsignedCall): Promise<Hex> {
  return (await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from, to: call.to, data: call.data, value: '0x0' }],
  })) as Hex
}

interface MinimalReceipt {
  status: Hex
  blockNumber: Hex
}

async function waitForReceipt(provider: Eip1193Provider, hash: Hex, timeoutMs = 120_000): Promise<MinimalReceipt> {
  const startedAt = Date.now()
  for (;;) {
    const receipt = (await provider.request({
      method: 'eth_getTransactionReceipt',
      params: [hash],
    })) as MinimalReceipt | null
    if (receipt?.blockNumber) return receipt
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for the transaction to mine')
    await new Promise((r) => setTimeout(r, 700))
  }
}

function messageFor(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: number }).code
    if (code === 4001) return 'You rejected the request in your wallet.'
    const message = (error as { message?: string }).message
    if (typeof message === 'string' && message.length > 0) return message.split('\n')[0]!.slice(0, 200)
  }
  return String(error)
}

/** Mount a checkout into `el` (element or selector). */
export function mountCheckout(el: HTMLElement | string, config: CheckoutConfig): CheckoutHandle {
  const host = typeof el === 'string' ? document.querySelector<HTMLElement>(el) : el
  if (!host) throw new TypeError(`mountCheckout: no element matches ${String(el)}`)
  const { request, onSuccess, onError, onStateChange } = validateCheckoutConfig(config)
  const info = networkInfo(request.network)
  const token = requestToken(request)
  ensureStyles(host.ownerDocument)

  const root = host.ownerDocument.createElement('div')
  root.className = 'hoodpay'
  host.replaceChildren(root)

  let destroyed = false
  let dynamicAmount = ''

  const emit = (state: CheckoutState) => {
    if (!destroyed) onStateChange?.(state)
  }

  const h = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = host.ownerDocument.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  const header = () => {
    const head = h('div', 'hoodpay-head')
    const brand = h('span', 'hoodpay-brand')
    brand.append('hood', Object.assign(h('b'), { textContent: 'pay' }))
    const net = h('span', 'hoodpay-net', request.network === 'testnet' ? 'testnet 46630' : 'chain 4663')
    net.dataset.net = request.network
    head.append(brand, net)
    return head
  }

  const summaryRows = () => {
    const dl = h('dl')
    const row = (label: string, value: string) => {
      const div = h('div', 'hoodpay-row')
      div.append(h('dt', undefined, label), h('dd', undefined, value))
      return div
    }
    dl.append(row('To', shortAddress(request.payTo)), row('Token', `${token.symbol} (${token.decimals} decimals)`))
    if (request.reference) dl.append(row('Reference', shortAddress(request.reference)))
    return dl
  }

  const statusLine = (text: string, spinning: boolean) => {
    const box = h('div', 'hoodpay-status')
    if (spinning) box.append(h('span', 'hoodpay-spin'))
    box.append(h('span', undefined, text))
    return box
  }

  function renderReview() {
    root.replaceChildren(header())
    if (request.amount === 'dynamic') {
      root.append(h('span', 'hoodpay-label', `Amount (${token.symbol})`))
      const input = h('input', 'hoodpay-input') as HTMLInputElement
      input.type = 'text'
      input.inputMode = 'decimal'
      input.placeholder = '10.00'
      input.value = dynamicAmount
      input.setAttribute('aria-label', `Amount in ${token.symbol}`)
      input.addEventListener('input', () => {
        dynamicAmount = input.value.trim()
      })
      root.append(input)
    } else {
      const amount = h('div', 'hoodpay-amount', request.amount)
      amount.append(Object.assign(h('small'), { textContent: token.symbol }))
      root.append(amount)
    }
    if (request.memo) root.append(h('p', 'hoodpay-memo', request.memo))
    root.append(summaryRows())
    const button = h('button', 'hoodpay-btn', request.amount === 'dynamic' ? 'Pay' : `Pay ${request.amount} ${token.symbol}`)
    button.type = 'button'
    button.addEventListener('click', () => void start())
    root.append(button)
    root.append(h('p', 'hoodpay-fine', 'Non-custodial. Your wallet signs; funds go straight to the merchant.'))
    emit({ step: 'review' })
  }

  function renderWalletChoice(wallets: Eip6963ProviderDetail[]) {
    root.replaceChildren(header(), h('p', 'hoodpay-memo', 'Choose a wallet to pay with'))
    const list = h('div', 'hoodpay-wallets')
    list.setAttribute('role', 'list')
    for (const wallet of wallets) {
      const button = h('button', 'hoodpay-wallet')
      button.type = 'button'
      const icon = h('img') as HTMLImageElement
      icon.src = wallet.info.icon
      icon.alt = ''
      button.append(icon, h('span', undefined, wallet.info.name))
      button.addEventListener('click', () => void connectAndPay(wallet))
      list.append(button)
    }
    root.append(list)
    const back = h('button', 'hoodpay-btn secondary', 'Back')
    back.type = 'button'
    back.addEventListener('click', renderReview)
    root.append(back)
    emit({ step: 'choose-wallet', wallets: wallets.length })
  }

  function renderBusy(text: string, state: CheckoutState) {
    root.replaceChildren(header())
    if (request.memo) root.append(h('p', 'hoodpay-memo', request.memo))
    root.append(statusLine(text, true))
    emit(state)
  }

  function renderInsufficient(balanceRaw: bigint, neededRaw: bigint) {
    const balance = formatUnits(balanceRaw, token.decimals)
    const needed = formatUnits(neededRaw, token.decimals)
    root.replaceChildren(header())
    const box = h('div', 'hoodpay-status hoodpay-err-box')
    box.append(
      h('span', 'hoodpay-warnc', '!'),
      h(
        'span',
        undefined,
        `Not enough ${token.symbol}: you hold ${balance}, this payment needs ${needed}.`,
      ),
    )
    root.append(box)
    const hint = h('p', 'hoodpay-fine')
    if (request.network === 'testnet') {
      const a = h('a', undefined, 'Get testnet funds from the faucet')
      a.setAttribute('href', 'https://faucet.testnet.chain.robinhood.com/')
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
      hint.append(a)
    } else {
      hint.textContent = 'Fund your wallet with USDG on Robinhood Chain, then try again.'
    }
    root.append(hint)
    const retry = h('button', 'hoodpay-btn secondary', 'Try again')
    retry.type = 'button'
    retry.addEventListener('click', renderReview)
    root.append(retry)
    emit({ step: 'insufficient', balance, needed })
  }

  function renderError(message: string, recoverable = true) {
    root.replaceChildren(header())
    const box = h('div', 'hoodpay-status hoodpay-err-box')
    box.append(h('span', 'hoodpay-err', '×'), h('span', undefined, message))
    root.append(box)
    if (recoverable) {
      const retry = h('button', 'hoodpay-btn secondary', 'Try again')
      retry.type = 'button'
      retry.addEventListener('click', renderReview)
      root.append(retry)
    }
    emit({ step: 'error', message, recoverable })
    onError?.(new Error(message))
  }

  function renderSuccess(receipt: CheckoutReceipt) {
    root.replaceChildren(header())
    const wrap = h('div', 'hoodpay-status')
    wrap.append(h('span', 'hoodpay-check', '✓'))
    const col = h('div')
    col.append(h('div', 'hoodpay-ok', `Paid ${receipt.amount} ${receipt.tokenSymbol}`))
    const link = h('a', undefined, 'View receipt on Blockscout')
    link.setAttribute('href', receipt.explorerUrl)
    link.setAttribute('target', '_blank')
    link.setAttribute('rel', 'noopener noreferrer')
    col.append(link)
    wrap.append(col)
    root.append(wrap, summaryRows())
    emit({ step: 'success', receipt })
    onSuccess?.(receipt)
  }

  function resolveRawAmount(): bigint {
    if (request.amount !== 'dynamic') return requestRawAmount(request)
    if (!/^(0|[1-9]\d{0,11})(\.\d{1,18})?$/.test(dynamicAmount)) {
      throw new RangeError('Enter the amount as a plain decimal, e.g. 10.00')
    }
    const raw = parseUnits(dynamicAmount, token.decimals)
    if (raw <= 0n) throw new RangeError('Amount must be greater than zero')
    return raw
  }

  async function start() {
    let rawAmount: bigint
    try {
      rawAmount = resolveRawAmount()
    } catch (error) {
      renderError(messageFor(error))
      return
    }
    renderBusy('Looking for wallets…', { step: 'discovering' })
    const wallets = await discoverWallets()
    if (destroyed) return
    if (wallets.length === 0) {
      renderError('No wallet found. Install an EIP-6963 wallet (MetaMask, Rabby, …) and reload.', true)
      return
    }
    if (wallets.length === 1) void connectAndPay(wallets[0]!, rawAmount)
    else renderWalletChoice(wallets)
  }

  async function connectAndPay(wallet: Eip6963ProviderDetail, precomputedRaw?: bigint) {
    try {
      const rawAmount = precomputedRaw ?? resolveRawAmount()
      renderBusy(`Connecting ${wallet.info.name}…`, { step: 'connecting', wallet: wallet.info.name })
      const { address: payer } = await ensureChain(wallet.provider, { network: request.network })
      if (destroyed) return

      const balance = await readUint(
        wallet.provider,
        token.address,
        encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [payer] }),
        'balanceOf',
      )
      if (balance < rawAmount) {
        renderInsufficient(balance, rawAmount)
        return
      }

      let payCall: UnsignedCall
      if (request.reference && request.router) {
        const allowance = await readUint(
          wallet.provider,
          token.address,
          encodeFunctionData({ abi: erc20Abi, functionName: 'allowance', args: [payer, request.router] }),
          'allowance',
        )
        if (allowance < rawAmount) {
          renderBusy(`Approve ${token.symbol} in your wallet (1 of 2)…`, { step: 'approving' })
          const approveHash = await sendCall(wallet.provider, payer, buildApproveTx(token.address, request.router, rawAmount))
          renderBusy('Waiting for the approval to mine…', { step: 'approving' })
          const approveReceipt = await waitForReceipt(wallet.provider, approveHash)
          if (approveReceipt.status !== '0x1') throw new Error('The approval transaction reverted.')
        }
        payCall = buildRouterPayTx(request.router, token.address, request.payTo, rawAmount, request.reference)
        renderBusy('Confirm the payment in your wallet (2 of 2)…', { step: 'paying' })
      } else {
        payCall = buildTransferTx(token.address, request.payTo, rawAmount)
        renderBusy('Confirm the payment in your wallet…', { step: 'paying' })
      }

      const txHash = await sendCall(wallet.provider, payer, payCall)
      renderBusy('Payment sent - waiting for confirmation…', { step: 'confirming', txHash })
      const receipt = await waitForReceipt(wallet.provider, txHash)
      if (receipt.status !== '0x1') throw new Error('The payment transaction reverted.')

      const checkoutReceipt: CheckoutReceipt = {
        txHash,
        payer,
        amountRaw: rawAmount.toString(),
        amount: formatUnits(rawAmount, token.decimals),
        tokenSymbol: token.symbol,
        network: request.network,
        explorerUrl: explorerTxUrl(request.network, txHash),
      }
      if (request.reference) checkoutReceipt.reference = request.reference
      renderSuccess(checkoutReceipt)
    } catch (error) {
      if (!destroyed) renderError(messageFor(error))
    }
  }

  renderReview()
  void info // network resolved eagerly above so bad configs fail at mount

  return {
    request,
    destroy() {
      destroyed = true
      root.remove()
    },
  }
}
