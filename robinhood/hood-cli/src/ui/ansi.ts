/**
 * Chalk-free ANSI styling. Small, dependency-free, and TTY-aware.
 *
 * Colour is enabled when stdout is a TTY, `NO_COLOR` is unset, and the
 * terminal is not `dumb`. `--no-color` (or a non-TTY pipe) forces plain text,
 * so `hood ... --json | jq` and log files stay clean. `FORCE_COLOR=1`
 * overrides the TTY check (the same convention chalk/supports-color use) —
 * used by the docs session-capture script to record a colourised transcript
 * from a piped subprocess.
 */

let colorEnabled = process.env.FORCE_COLOR
  ? process.env.FORCE_COLOR !== '0'
  : !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb'

/** Force colour on or off (wired to the global `--no-color` flag). */
export function setColorEnabled(enabled: boolean): void {
  colorEnabled = enabled
}

/** Whether ANSI colour is currently active. */
export function colorIsEnabled(): boolean {
  return colorEnabled
}

const wrap = (open: number, close: number) => (s: string | number): string =>
  colorEnabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s)

export const bold = wrap(1, 22)
export const dim = wrap(2, 22)
export const italic = wrap(3, 23)
export const underline = wrap(4, 24)

export const red = wrap(31, 39)
export const green = wrap(32, 39)
export const yellow = wrap(33, 39)
export const blue = wrap(34, 39)
export const magenta = wrap(35, 39)
export const cyan = wrap(36, 39)
export const white = wrap(37, 39)
export const gray = wrap(90, 39)

/** The one brand accent — a warm gradient rendered as 256-colour when able. */
export function accent(s: string): string {
  return colorEnabled ? `\x1b[38;5;79m${s}\x1b[39m` : s
}

/** Strip every ANSI escape from a string (for width math and non-TTY output). */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

/** Visible width of a string, ignoring ANSI escapes. */
export function width(s: string): string['length'] {
  return stripAnsi(s).length
}

/** Pad `s` to `len` visible columns (ANSI-aware). */
export function padEnd(s: string, len: number): string {
  const w = width(s)
  return w >= len ? s : s + ' '.repeat(len - w)
}

/** Right-align `s` to `len` visible columns (ANSI-aware). */
export function padStart(s: string, len: number): string {
  const w = width(s)
  return w >= len ? s : ' '.repeat(len - w) + s
}

/** Truncate to `len` visible columns with an ellipsis (ANSI-unaware — use on plain text). */
export function truncate(s: string, len: number): string {
  if (s.length <= len) return s
  if (len <= 1) return s.slice(0, len)
  return s.slice(0, len - 1) + '…'
}
