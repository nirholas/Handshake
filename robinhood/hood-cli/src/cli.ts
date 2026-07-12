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
import { presentError } from './output.js'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string }

const program = new Command()

program
  .name('hood')
  .description('The command-line toolkit for Robinhood Chain (4663) — instant reads, guarded writes.')
  .version(pkg.version, '-v, --version')
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

program.exitOverride((err) => {
  // commander's own usage/version/help exits — let them through as-is.
  if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
    process.exit(0)
  }
  process.exitCode = 2
  throw err
})

process.on('unhandledRejection', (err) => {
  process.exitCode = presentError(err, { json: process.argv.includes('--json'), verbose: process.argv.includes('--verbose') })
})

try {
  await program.parseAsync(process.argv)
} catch (err) {
  if (process.exitCode === undefined) {
    process.exitCode = presentError(err, { json: process.argv.includes('--json'), verbose: process.argv.includes('--verbose') })
  }
}
