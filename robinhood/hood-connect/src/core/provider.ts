/**
 * Minimal EIP-1193 provider surface used by hood-connect. Structural typing
 * keeps the kit compatible with every injected wallet and with viem/wagmi
 * transports without importing either.
 */

/** EIP-1193 `request` arguments. */
export interface Eip1193RequestArguments {
  method: string
  params?: unknown[] | Record<string, unknown>
}

/** An EIP-1193 provider (window.ethereum, an EIP-6963 announced provider, ...). */
export interface Eip1193Provider {
  request(args: Eip1193RequestArguments): Promise<unknown>
  on?(event: string, listener: (...args: never[]) => void): void
  removeListener?(event: string, listener: (...args: never[]) => void): void
}

/** Shape of EIP-1193 provider errors (`code` per EIP-1193/EIP-1474). */
export interface ProviderRpcError extends Error {
  code: number
  data?: unknown
}
