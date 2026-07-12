import { loadConfig } from './config.js'
import { Ledger } from './ledger.js'
import { buildApp } from './server.js'

const config = loadConfig()
const ledger = new Ledger(config.ledgerPath)
const app = buildApp(config, ledger)

const server = app.listen(config.port, () => {
  console.log(
    `hood402-facilitator listening on :${config.port} — signer ${config.signerAddress} — networks: ${[...config.runtimes.keys()].join(', ')}`,
  )
})

function shutdown(signal: string): void {
  console.log(`hood402-facilitator received ${signal}, shutting down`)
  server.close(() => {
    ledger.close()
    process.exit(0)
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
