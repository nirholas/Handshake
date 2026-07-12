/**
 * Pure formatting helpers — deterministic, unit-tested, no I/O. Colour is
 * applied by callers, not here, so these stay easy to test.
 */
import { formatUnits, type Address } from 'viem'

/** Format a USD value with thousands separators and adaptive precision. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : abs > 0 ? 6 : 2
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`
}

/** Format a plain number with grouping and a fixed number of decimals. */
export function formatNumber(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return '—'
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

/** Compact large counts: 1234 → "1.23K", 1_200_000 → "1.20M". */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}K`
  return formatNumber(value, abs < 1 && abs > 0 ? 4 : 2)
}

/** Format a signed percentage with an explicit sign, e.g. "+1.24%". */
export function formatPct(fraction: number, decimals = 2): string {
  if (!Number.isFinite(fraction)) return '—'
  const pct = fraction * 100
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toFixed(decimals)}%`
}

/** Abbreviate an address as `0x1234…abcd`. */
export function shortAddress(address: string): string {
  if (!address || address.length < 12) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/** Abbreviate a tx hash as `0x12345678…abcdef12`. */
export function shortHash(hash: string): string {
  if (!hash || hash.length < 20) return hash
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`
}

/** Human duration from seconds: "5s", "3m 20s", "2h 5m", "3d 4h". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) {
    const rem = s % 60
    return rem ? `${m}m ${rem}s` : `${m}m`
  }
  const h = Math.floor(m / 60)
  if (h < 24) {
    const rem = m % 60
    return rem ? `${h}h ${rem}m` : `${h}h`
  }
  const d = Math.floor(h / 24)
  const rem = h % 24
  return rem ? `${d}d ${rem}h` : `${d}d`
}

/** "3m ago" style age string from an age in seconds. */
export function formatAge(ageSeconds: number): string {
  return `${formatDuration(ageSeconds)} ago`
}

/** Format a raw token amount (bigint + decimals) as a trimmed decimal string. */
export function formatTokenAmount(raw: bigint, decimals: number, maxFractionDigits = 6): string {
  const full = formatUnits(raw, decimals)
  const [int, frac = ''] = full.split('.')
  const grouped = BigInt(int ?? '0').toLocaleString('en-US')
  if (!frac) return grouped
  const trimmed = frac.slice(0, maxFractionDigits).replace(/0+$/, '')
  return trimmed ? `${grouped}.${trimmed}` : grouped
}

/** Explorer address URL on Blockscout. */
export function explorerAddressUrl(explorer: string, address: Address | string): string {
  return `${explorer.replace(/\/$/, '')}/address/${address}`
}

/** Explorer tx URL on Blockscout. */
export function explorerTxUrl(explorer: string, hash: string): string {
  return `${explorer.replace(/\/$/, '')}/tx/${hash}`
}

/** Explorer token URL on Blockscout. */
export function explorerTokenUrl(explorer: string, address: Address | string): string {
  return `${explorer.replace(/\/$/, '')}/token/${address}`
}
