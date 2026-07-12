import { createProgram } from './program.js'
import { presentError } from './output.js'

const program = createProgram()

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
