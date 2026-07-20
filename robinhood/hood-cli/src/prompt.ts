/**
 * Interactive prompts on the controlling TTY: a yes/no confirm gate and a
 * hidden password reader. Both read from `/dev/tty`-equivalent stdin so they
 * work even when stdout is piped, and both fail closed on a non-interactive
 * stdin (a script must pass explicit flags rather than hang).
 */
import { createInterface } from 'node:readline'
import { bold, dim, yellow } from './ui/ansi.js'
import { guardError } from './errors.js'

/** Whether we can prompt (stdin is a TTY). */
export function canPrompt(): boolean {
  return !!process.stdin.isTTY
}

/**
 * Ask a yes/no question. Returns true only on an explicit yes. On a
 * non-interactive stdin it throws a guard error rather than blocking.
 */
export async function confirm(question: string): Promise<boolean> {
  if (!canPrompt()) {
    throw guardError('Confirmation required but stdin is not a terminal.', 'Re-run in an interactive shell, or pass --yes to skip the prompt.')
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${yellow('?')} ${bold(question)} ${dim('[y/N]')} `, resolve)
    })
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

/**
 * Ask a free-text question, echoing the input (not a secret). Falls back to
 * the env var when provided. Returns `fallback` (default `''`) on an empty
 * answer.
 */
export async function promptLine(question: string, envVar?: string, fallback = ''): Promise<string> {
  const fromEnv = envVar ? process.env[envVar] : undefined
  if (fromEnv) return fromEnv
  if (!canPrompt()) {
    throw guardError('An interactive answer is required.', envVar ? `Set ${envVar} or run in an interactive terminal.` : 'Run in an interactive terminal.')
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${yellow('?')} ${bold(question)} `, resolve)
    })
    const trimmed = answer.trim()
    return trimmed.length > 0 ? trimmed : fallback
  } finally {
    rl.close()
  }
}

/**
 * Read a password without echoing it. Falls back to the env var when provided
 * so automation never has to type into a TTY.
 */
export async function readPassword(label = 'Wallet password:', envVar = 'HOOD_WALLET_PASSWORD'): Promise<string> {
  const fromEnv = process.env[envVar]
  if (fromEnv) return fromEnv
  if (!canPrompt()) {
    throw guardError('A wallet password is required.', `Set ${envVar} or run in an interactive terminal.`)
  }

  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin
    process.stderr.write(`${dim(label)} `)
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    let value = ''
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r' || ch === '') {
          cleanup()
          process.stderr.write('\n')
          resolve(value)
          return
        }
        if (ch === '') {
          // Ctrl-C
          cleanup()
          process.stderr.write('\n')
          reject(guardError('Aborted.'))
          return
        }
        if (ch === '' || ch === '\b') {
          value = value.slice(0, -1)
        } else {
          value += ch
        }
      }
    }
    const cleanup = () => {
      stdin.setRawMode?.(false)
      stdin.pause()
      stdin.removeListener('data', onData)
    }
    stdin.on('data', onData)
  })
}
