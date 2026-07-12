/**
 * Human formatting: money, percentages, counts, addresses, ages, token amounts.
 * Colour semantics are deliberately narrow — green/red only ever mean the sign
 * of a number, never decoration.
 */
import { formatUnits, type Address } from 'viem'
import { dim, green, red } from './ui/ansi.js'

/** `315.5` → `$315.50`. Scales precision for sub-dollar values. */
export function usd(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  const digits = abs === 0 ? 2 : abs < 0.01 ? 6 : abs < 1 ? 4 : 2
  return (
    '$' +
    value.toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })
  )
}

/** Plain number with grouping, `maxFrac` decimals. */
export function num(value: number, maxFrac = 4): string {
  if (!Number.isFinite(value)) return '—'
  return value.toLocaleString('en-US', { maximumFractionDigits: maxFrac })
}

/** Compact large counts: `1_234_567` → `1.23M`. */
export function compact(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value)
}

/**
 * Signed percentage, coloured by sign. `pct(0.0123)` → green `+1.23%`.
 * Pass a ratio (0.01 = 1%), not an already-scaled percentage.
 */
export function pct(ratio: number): string {
  if (!Number.isFinite(ratio)) return dim('—')
  const p = ratio * 100
  const sign = p > 0 ? '+' : ''
  const s = `${sign}${p.toFixed(2)}%`
  if (p > 0) return green(s)
  if (p < 0) return red(s)
  return s
}

/** `0x1234…abcd` — the standard middle-truncated address. */
export function shortAddress(address: string): string {
  if (address.length <= 12) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/** Alias with the `Address` type for call-site clarity. */
export function addr(a: Address): string {
  return shortAddress(a)
}

/** Seconds → `3m`, `2h 5m`, `1d 4h`. */
export function age(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const s = Math.floor(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

/** Unix seconds → local ISO-ish timestamp. */
export function timestamp(unixSeconds: number): string {
  if (!unixSeconds) return '—'
  return new Date(unixSeconds * 1000).toISOString().replace('T', ' ').replace('.000Z', 'Z')
}

/**
 * Format a raw token amount for display, trimming trailing zeros and capping
 * significant fractional digits so a `parseUnits('1', 18)` reads as `1`.
 */
export function tokenAmount(raw: bigint, decimals: number, maxFrac = 6): string {
  const full = formatUnits(raw, decimals)
  if (!full.includes('.')) return full
  const [whole, frac] = full.split('.')
  const trimmed = (frac ?? '').slice(0, maxFrac).replace(/0+$/, '')
  return trimmed ? `${whole}.${trimmed}` : (whole as string)
}
