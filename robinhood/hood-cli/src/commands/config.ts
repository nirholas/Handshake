import { Command } from 'commander'
import { getAddress } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import {
  loadConfig,
  saveConfig,
  setConfigValue,
  redactedConfig,
  defaultKeystorePath,
  CONFIG_KEYS,
  type HoodConfig,
} from '../config.js'
import { writeKeystore, keystoreExists, passwordsMatch } from '../keystore.js'
import { readPassword, confirm } from '../prompt.js'
import { printJson, printHuman } from '../output.js'
import { renderKeyValue } from '../ui/table.js'
import { accent, bold, dim, green } from '../ui/ansi.js'
import { setColorEnabled } from '../ui/ansi.js'
import { guardError, usageError } from '../errors.js'

export function configCommand(): Command {
  const cmd = new Command('config').description('Manage hood-cli settings (rpc, wallet, network)')

  cmd
    .command('set <key> [value]')
    .description(`set a config value (${CONFIG_KEYS.join(', ')}, wallet)`)
    .action(async (key: string, value: string | undefined, _opts, command) => {
      if (command.optsWithGlobals().color === false) setColorEnabled(false)
      const json = !!command.optsWithGlobals().json
      if (key === 'wallet') {
        await setWallet(json, !!command.optsWithGlobals().yes)
        return
      }
      if (value === undefined) throw usageError(`"hood config set ${key}" needs a value.`)
      const config = loadConfig()
      const next = setConfigValue(config, key, value)
      saveConfig(next)
      if (json) printJson({ ok: true, key, value })
      else printHuman(`${green('✓')} ${key} = ${value}`)
    })

  cmd
    .command('get <key>')
    .description('print one config value')
    .action((key: string, _opts, command) => {
      const json = !!command.optsWithGlobals().json
      const view = redactedConfig(loadConfig())
      if (!(key in view)) throw usageError(`Unknown config key "${key}".`, `Valid keys: ${Object.keys(view).join(', ')}.`)
      const value = view[key as keyof typeof view]
      if (json) printJson({ [key]: value })
      else printHuman(String(value ?? dim('unset')))
    })

  cmd
    .command('list')
    .description('print the full config (secrets masked)')
    .action((_opts, command) => {
      const json = !!command.optsWithGlobals().json
      const view = redactedConfig(loadConfig())
      if (json) {
        printJson(view)
        return
      }
      const pairs: [string, string][] = Object.entries(view).map(([k, v]) => [k, v === null ? dim('unset') : String(v)])
      printHuman(`${accent('◈')} ${bold('hood config')}\n${renderKeyValue(pairs, { labelWidth: 14 })}`)
    })

  return cmd
}

export async function setWallet(json: boolean, assumeYes: boolean): Promise<void> {
  const config = loadConfig()
  const keystorePath = config.walletKeystore ?? defaultKeystorePath()

  if (keystoreExists(keystorePath) && !assumeYes) {
    const overwrite = await confirm(`A wallet already exists at ${keystorePath}. Overwrite it?`)
    if (!overwrite) throw guardError('Wallet setup cancelled.')
  }

  const importKey = process.env.ROBINHOOD_CHAIN_IMPORT_KEY
  const privateKey = importKey
    ? ((importKey.startsWith('0x') ? importKey : `0x${importKey}`) as `0x${string}`)
    : generatePrivateKey()
  const account = privateKeyToAccount(privateKey)

  const password = await readPassword('New wallet password (min 8 chars):')
  const confirmPassword = await readPassword('Confirm password:')
  if (!passwordsMatch(password, confirmPassword)) throw guardError('Passwords did not match.')

  writeKeystore(keystorePath, privateKey, getAddress(account.address), password)
  const next: HoodConfig = { ...config, walletKeystore: keystorePath, walletAddress: account.address }
  saveConfig(next)

  const result = { ok: true, address: account.address, keystore: keystorePath, imported: !!importKey }
  if (json) {
    printJson(result)
    return
  }
  printHuman(
    `${green('✓')} Wallet ${result.imported ? 'imported' : 'generated'}: ${bold(account.address)}\n` +
      dim(`  Encrypted keystore: ${keystorePath}`) +
      (result.imported ? '' : `\n${dim('  This is a NEW address — fund it before sending anything.')}`),
  )
}
