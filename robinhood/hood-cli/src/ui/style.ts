/**
 * Chalk-free ANSI styling. Colour is enabled only for real TTYs and disabled
 * when `NO_COLOR` is set, `TERM=dumb`, or `--no-color` was passed (via
 * {@link setColorEnabled}). Colour semantics across the CLI: green/red are
 * reserved for numbers (gains/losses), cyan for links/addresses, yellow for
 * warnings, dim for secondary text.
 */

let colorEnabled =
  Boolean(process.stdout.isTTY) &&
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb'

/** Force colour on/off (honours `--color` / `--no-color`). */
export function setColorEnabled(enabled: boolean): void {
  colorEnabled = enabled
}

/** Whether ANSI colour is currently active. */
export function isColorEnabled(): boolean {
  return colorEnabled
}

const wrap = (open: number, close: number) => (s: string) =>
  colorEnabled ? `\x1b[${open}m${s}\x1b[${close}m` : s

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
export const gray = wrap(90, 39)
export const white = wrap(97, 39)

/** The one accent colour used for headings and the wordmark. */
export const accent = (s: string): string => (colorEnabled ? `\x1b[38;5;84m${s}\x1b[39m` : s)

/** Colour a signed number: positive green, negative red, zero dim. */
export function signColor(value: number, text: string): string {
  if (value > 0) return green(text)
  if (value < 0) return red(text)
  return dim(text)
}

const ANSI_RE = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g

/** Strip ANSI escapes (colour + OSC-8 hyperlinks) from a string. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

/** Visible width of a string, ignoring ANSI escapes. */
export function visibleWidth(s: string): number {
  return [...stripAnsi(s)].length
}

/**
 * An OSC-8 terminal hyperlink where supported, falling back to the label. Only
 * emitted for colour-capable TTYs; plain text otherwise so pipes stay clean.
 */
export function hyperlink(label: string, url: string): string {
  if (!colorEnabled) return label
  return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`
}
