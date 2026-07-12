#!/usr/bin/env node
import { resolve } from 'node:path'
import { loadOperatorConfig } from '../src/core/config.js'
import { HoodLauncher } from '../src/core/launcher.js'
import { AutoScheduler, loadAutoConfig } from '../src/auto/scheduler.js'
import { ProposalStore } from '../src/auto/proposals.js'

const dataDir = process.env.HOOD_LAUNCHER_DATA_DIR ?? resolve(process.cwd(), '.hood-launcher')

function usage(): never {
  console.log(`hood-auto — Robinhood Chain autonomous launch scheduler

Usage:
  hood-auto tick               run one poll-propose cycle against trending narratives
  hood-auto loop [--interval-minutes N]   run tick on a repeating interval (default 60)
  hood-auto list [--status pending|approved|rejected|executed|failed]
  hood-auto approve <id>
  hood-auto reject <id>

Env: AUTO_APPROVE=1  AUTO_RAIL=noxa|odyssey|direct  AUTO_INITIAL_BUY_ETH  AUTO_DIRECT_SEED_ETH
     MAX_LAUNCHES_PER_DAY  MAX_SEED_USDG  LIVE=1  ACKNOWLEDGE_LAUNCH_RESPONSIBILITY=1
`)
  process.exit(1)
}

function buildScheduler() {
  const operatorConfig = loadOperatorConfig()
  const autoConfig = loadAutoConfig()
  const launcher = new HoodLauncher(operatorConfig, dataDir)
  const proposals = new ProposalStore(dataDir)
  return { scheduler: new AutoScheduler(launcher, operatorConfig, autoConfig, proposals), operatorConfig, autoConfig }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (!command) usage()
  const { scheduler, operatorConfig, autoConfig } = buildScheduler()

  if (command === 'tick') {
    console.log(`network=${operatorConfig.network} autoApprove=${autoConfig.autoApprove} live=${operatorConfig.live}`)
    const proposal = await scheduler.tick()
    console.log(proposal ? JSON.stringify(proposal, null, 2) : 'no new narrative to propose (all covered or none trending)')
    return
  }

  if (command === 'loop') {
    const intervalArgIdx = rest.indexOf('--interval-minutes')
    const intervalMinutes = intervalArgIdx >= 0 ? Number(rest[intervalArgIdx + 1]) : 60
    console.log(`hood-auto loop: polling every ${intervalMinutes}m (Ctrl-C or a KILL file in ${dataDir} to stop)`)
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const kill = scheduler.launcher.killSwitch.reasonIfEngaged()
      if (kill) {
        console.error(`kill switch engaged (${kill}) — exiting loop`)
        return
      }
      try {
        const proposal = await scheduler.tick()
        if (proposal) console.log(`[${new Date().toISOString()}] proposed ${proposal.concept.symbol} (${proposal.status})`)
      } catch (err) {
        console.error(`[${new Date().toISOString()}] tick failed:`, err instanceof Error ? err.message : err)
      }
      await new Promise((r) => setTimeout(r, intervalMinutes * 60_000))
    }
  }

  if (command === 'list') {
    const statusIdx = rest.indexOf('--status')
    const status = statusIdx >= 0 ? (rest[statusIdx + 1] as never) : undefined
    console.log(JSON.stringify(scheduler.proposals.list(status), null, 2))
    return
  }

  if (command === 'approve') {
    const id = rest[0]
    if (!id) usage()
    const result = await scheduler.approve(id)
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (command === 'reject') {
    const id = rest[0]
    if (!id) usage()
    scheduler.reject(id)
    console.log(`rejected ${id}`)
    return
  }

  usage()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
