/**
 * A minimal network spinner. TTY-only: on a pipe or with `--json` it degrades
 * to a single dim status line on stderr (so it never pollutes stdout data).
 */
import { dim } from './ansi.js'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export interface Spinner {
  /** Update the label without interrupting the animation. */
  update: (text: string) => void
  /** Stop and clear the line. */
  stop: () => void
  /** Stop, clear, and print a final dim status to stderr. */
  succeed: (text?: string) => void
  fail: (text?: string) => void
}

/** Start a spinner writing to stderr. Returns a no-op handle when non-TTY. */
export function spinner(text: string): Spinner {
  if (!process.stderr.isTTY) {
    process.stderr.write(dim(text) + '\n')
    return {
      update: () => {},
      stop: () => {},
      succeed: (t) => t && process.stderr.write(dim(t) + '\n'),
      fail: (t) => t && process.stderr.write(dim(t) + '\n'),
    }
  }

  let label = text
  let i = 0
  const render = () => {
    process.stderr.write(`\r\x1b[K${dim(FRAMES[i % FRAMES.length] + ' ' + label)}`)
    i += 1
  }
  render()
  const timer = setInterval(render, 80)

  const clear = () => {
    clearInterval(timer)
    process.stderr.write('\r\x1b[K')
  }
  return {
    update: (t) => {
      label = t
    },
    stop: clear,
    succeed: (t) => {
      clear()
      if (t) process.stderr.write(dim('✓ ' + t) + '\n')
    },
    fail: (t) => {
      clear()
      if (t) process.stderr.write(dim('✗ ' + t) + '\n')
    },
  }
}

/** Run `fn` under a spinner, always clearing it (even on throw). */
export async function withSpinner<T>(text: string, fn: (s: Spinner) => Promise<T>): Promise<T> {
  const s = spinner(text)
  try {
    const result = await fn(s)
    s.stop()
    return result
  } catch (err) {
    s.stop()
    throw err
  }
}
