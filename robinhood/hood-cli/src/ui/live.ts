/**
 * Flicker-free live region for `--watch` / `--follow`.
 *
 * Instead of clearing the whole screen each tick (which flickers and destroys
 * scrollback), it repaints only the lines it previously drew: cursor up N,
 * rewrite each line with a clear-to-EOL, and clear any leftover lines when the
 * block shrinks. On a non-TTY it simply appends each frame with a separator so
 * piped output stays readable.
 */
export interface LiveRegion {
  /** Draw a full frame (a multi-line string). Diffs against the last frame. */
  render: (frame: string) => void
  /** Append a line below the live region without disturbing it (event log). */
  log?: (line: string) => void
  /** Restore the cursor and stop. */
  stop: () => void
}

/** Create a live region on stdout. */
export function liveRegion(): LiveRegion {
  const tty = !!process.stdout.isTTY

  if (!tty) {
    let first = true
    return {
      render: (frame) => {
        if (!first) process.stdout.write('\n')
        first = false
        process.stdout.write(frame + '\n')
      },
      stop: () => {},
    }
  }

  let prevLines = 0
  // Hide the cursor while animating; restore on stop / SIGINT.
  process.stdout.write('\x1b[?25l')
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    process.stdout.write('\x1b[?25h')
  }
  process.on('exit', stop)

  const render = (frame: string) => {
    const lines = frame.split('\n')
    let out = ''
    if (prevLines > 0) out += `\x1b[${prevLines}A` // cursor up to the block's top
    for (const line of lines) out += `\r\x1b[K${line}\n`
    // Clear any leftover lines from a taller previous frame.
    for (let i = lines.length; i < prevLines; i++) out += '\r\x1b[K\n'
    // Move the cursor back up over the cleared tail so the next frame lines up.
    const extra = Math.max(0, prevLines - lines.length)
    if (extra > 0) out += `\x1b[${extra}A`
    process.stdout.write(out)
    prevLines = lines.length
  }

  return { render, stop }
}
