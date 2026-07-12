/**
 * Program construction, separated from `cli.ts`'s execution so tests can
 * introspect the option/command wiring without triggering a real parse (and
 * its network calls) as a side effect of importing the module.
 */
import { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { priceCommand } from './commands/price.js'
import { stocksCommand } from './commands/stocks.js'
import { coinsCommand } from './commands/coins.js'
import { launchesCommand } from './commands/launches.js'
import { portfolioCommand } from './commands/portfolio.js'
import { txCommand } from './commands/tx.js'
import { tokenCommand } from './commands/token.js'
import { watchCommand } from './commands/watch.js'
import { swapCommand } from './commands/swap.js'
import { transferCommand } from './commands/transfer.js'
import { faucetCommand } from './commands/faucet.js'
import { deployTokenCommand } from './commands/deploy-token.js'
import { configCommand } from './commands/config.js'

function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string }
  return pkg.version
}

/** Build the fully-wired `hood` commander program (does not parse or run). */
export function createProgram(): Command {
  const program = new Command()

  program
    .name('hood')
    .description('The command-line toolkit for Robinhood Chain (4663) — instant reads, guarded writes.')
    .version(readVersion(), '-v, --version')
    .option('--json', 'machine-readable JSON output')
    .option('--network <net>', 'mainnet | testnet', 'mainnet')
    .option('--rpc <url>', 'override the RPC endpoint')
    .option('--verbose', 'show raw error causes')
    .option('--yes', 'skip interactive confirmation on writes (still requires --execute)')
    .option('--acknowledge-eligibility', 'affirm Stock Token acquisition eligibility (non-US/CA/UK/CH)')
    .option('--no-color', 'disable ANSI colour')
    .showHelpAfterError('(run `hood --help` for usage)')
    .configureOutput({
      outputError: (str, write) => write(str),
    })

  program.addCommand(priceCommand())
  program.addCommand(stocksCommand())
  program.addCommand(coinsCommand())
  program.addCommand(launchesCommand())
  program.addCommand(portfolioCommand())
  program.addCommand(txCommand())
  program.addCommand(tokenCommand())
  program.addCommand(watchCommand())
  program.addCommand(swapCommand())
  program.addCommand(transferCommand())
  program.addCommand(faucetCommand())
  program.addCommand(deployTokenCommand())
  program.addCommand(configCommand())

  return program
}
