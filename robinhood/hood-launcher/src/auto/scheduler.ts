import { HoodLauncher } from '../core/launcher.js'
import type { OperatorConfig } from '../core/config.js'
import { launchConfigSchema, type LaunchConfig } from '../core/config.js'
import { buildConcept } from '../concept/index.js'
import { fetchTrendingNarratives, narrativeToTheme, type Narrative } from './narratives.js'
import { ProposalStore, type PendingProposal } from './proposals.js'
import { ConceptRejectedError, TickerTakenError } from '../errors.js'

export interface AutoConfig {
  autoApprove: boolean
  rail: 'noxa' | 'odyssey' | 'direct'
  odysseyVariant: 'instant' | 'bonding'
  initialBuyEth: number
  directSeedEth: number
  narrativeWindowHours: number
}

export function loadAutoConfig(env: NodeJS.ProcessEnv = process.env): AutoConfig {
  return {
    autoApprove: env.AUTO_APPROVE === '1',
    rail: (env.AUTO_RAIL as AutoConfig['rail']) ?? 'noxa',
    odysseyVariant: (env.AUTO_ODYSSEY_VARIANT as AutoConfig['odysseyVariant']) ?? 'instant',
    initialBuyEth: Number(env.AUTO_INITIAL_BUY_ETH ?? 0),
    directSeedEth: Number(env.AUTO_DIRECT_SEED_ETH ?? 0.01),
    narrativeWindowHours: Number(env.AUTO_NARRATIVE_WINDOW_HOURS ?? 24),
  }
}

/**
 * Watches the three.ws crypto-news digest for trending narratives, proposes
 * a launch for the strongest one not already proposed, and gates execution
 * behind either `AUTO_APPROVE=1` (proposals execute immediately, still
 * subject to every cap in {@link enforceCaps} and to `LIVE=1`) or an
 * operator approval step (`hood-auto approve <id>` / `POST
 * /auto/approve/:id`).
 */
export class AutoScheduler {
  constructor(
    readonly launcher: HoodLauncher,
    private readonly operatorConfig: OperatorConfig,
    private readonly autoConfig: AutoConfig,
    readonly proposals: ProposalStore,
  ) {}

  /** One poll-propose cycle: fetch narratives, pick the freshest un-proposed one, build + record a proposal. */
  async tick(): Promise<PendingProposal | null> {
    const kill = this.launcher.killSwitch.reasonIfEngaged()
    if (kill) return null

    const narratives = await fetchTrendingNarratives(this.autoConfig.narrativeWindowHours)
    const already = new Set(this.proposals.list().map((p) => p.narrativeTitle))
    const candidate = narratives
      .filter((n) => !already.has(n.title))
      .sort((a, b) => b.coverage - a.coverage)[0]
    if (!candidate) return null

    return this.propose(candidate)
  }

  private async propose(narrative: Narrative): Promise<PendingProposal | null> {
    const theme = narrativeToTheme(narrative)

    // Placeholder name/symbol satisfy LaunchConfig's schema shape; buildConcept
    // overwrites both with the LLM-generated concept before anything else runs
    // because `theme` is set (see src/concept/index.ts).
    const draftConfig: LaunchConfig = launchConfigSchema.parse({
      name: 'pending',
      symbol: 'PEND',
      rail: this.autoConfig.rail,
      odysseyVariant: this.autoConfig.odysseyVariant,
      initialBuyEth: this.autoConfig.initialBuyEth,
      ...(this.autoConfig.rail === 'direct'
        ? { direct: { seedEth: this.autoConfig.directSeedEth } }
        : {}),
    })

    let concept
    try {
      concept = await buildConcept(this.operatorConfig.network, draftConfig, { theme })
    } catch (err) {
      if (err instanceof ConceptRejectedError || err instanceof TickerTakenError) {
        // A rejected/collided concept is not an operational failure — skip
        // this narrative silently and let the next tick try another one.
        return null
      }
      throw err
    }

    const finalConfig: LaunchConfig = {
      ...draftConfig,
      name: concept.input.name,
      symbol: concept.input.symbol,
      description: concept.input.description,
      logoUri: concept.input.logoUri,
      socials: concept.input.socials,
    }

    const outcome = await this.launcher.launch(finalConfig, { dryRun: true })
    const proposal = this.proposals.create({
      narrativeTitle: narrative.title,
      theme,
      launchConfig: finalConfig,
      concept: {
        name: concept.input.name,
        symbol: concept.input.symbol,
        description: concept.input.description,
        logoUri: concept.input.logoUri,
        socials: concept.input.socials,
        initialBuyWei: concept.input.initialBuyWei.toString(),
      },
      preflight: outcome.preflight,
    })

    if (this.autoConfig.autoApprove) {
      await this.approve(proposal.id)
    }
    return this.proposals.get(proposal.id)
  }

  /** Execute a pending proposal for real. Requires `LIVE=1` to actually broadcast — otherwise records another dry-run. */
  async approve(id: string): Promise<PendingProposal> {
    const proposal = this.proposals.get(id)
    if (!proposal) throw new Error(`No proposal with id ${id}`)
    if (proposal.status !== 'pending') throw new Error(`Proposal ${id} is already ${proposal.status}`)

    this.proposals.updateStatus(id, 'approved')
    try {
      await this.launcher.launch(proposal.launchConfig, { dryRun: !this.operatorConfig.live })
      this.proposals.updateStatus(id, this.operatorConfig.live ? 'executed' : 'approved')
    } catch (err) {
      this.proposals.updateStatus(id, 'failed')
      throw err
    }
    return this.proposals.get(id) as PendingProposal
  }

  reject(id: string): void {
    this.proposals.updateStatus(id, 'rejected')
  }
}
