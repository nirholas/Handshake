/**
 * Serialization + display helpers shared by both servers.
 *
 * viem returns `bigint` everywhere; MCP tool results are JSON, and
 * `JSON.stringify` throws on bigints. Everything a tool returns to the model
 * goes through {@link toResult}, which stringifies bigints losslessly.
 */

import type { Address } from 'viem'
import { MAINNET_EXPLORER_URL } from 'hoodchain'
import type { HoodNetwork } from 'hoodchain'

const TESTNET_EXPLORER_URL = 'https://explorer.testnet.chain.robinhood.com'

/** Explorer base URL for a network. */
export function explorerUrl(network: HoodNetwork): string {
  return network === 'testnet' ? TESTNET_EXPLORER_URL : MAINNET_EXPLORER_URL
}

/** Explorer address link. */
export function addressLink(network: HoodNetwork, address: string): string {
  return `${explorerUrl(network)}/address/${address}`
}

/** Explorer transaction link. */
export function txLink(network: HoodNetwork, hash: string): string {
  return `${explorerUrl(network)}/tx/${hash}`
}

/** JSON replacer that renders bigints as decimal strings. */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

/** Pretty JSON string with bigint support. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, bigintReplacer, 2)
}

/**
 * Build the MCP tool result payload from a plain JS object. Returns both a
 * human/LLM-readable text block and machine-readable `structuredContent`, both
 * bigint-safe.
 */
export function toResult(value: Record<string, unknown>): {
  content: { type: 'text'; text: string }[]
  structuredContent: Record<string, unknown>
} {
  // Round-trip through the replacer so structuredContent is also bigint-free
  // (the MCP transport JSON-encodes it and would otherwise throw).
  const structured = JSON.parse(JSON.stringify(value, bigintReplacer)) as Record<string, unknown>
  return {
    content: [{ type: 'text', text: toJson(value) }],
    structuredContent: structured,
  }
}

/** Build a standard error tool result (isError) with an actionable hint. */
export function toError(message: string, hint?: string): {
  content: { type: 'text'; text: string }[]
  isError: true
} {
  const text = hint ? `${message}\n\nHint: ${hint}` : message
  return { content: [{ type: 'text', text }], isError: true }
}

/** Round a float to `dp` decimal places, returning a Number (not a string). */
export function round(value: number, dp = 6): number {
  const f = 10 ** dp
  return Math.round(value * f) / f
}

/** Lowercase-compare two addresses. */
export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** Narrow an unknown thrown value to a message string. */
export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return typeof e === 'string' ? e : JSON.stringify(e)
}

/** Type guard for a 0x-prefixed EVM address. */
export function isAddress(value: string): value is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(value)
}
