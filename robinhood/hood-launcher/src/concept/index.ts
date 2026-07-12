import type { LaunchInput } from '../rails/types.js'
import type { HoodNetwork } from 'hoodchain'
import type { LaunchConfig } from '../core/config.js'
import { screenConcept } from './screen.js'
import { checkTickerUniqueness } from './uniqueness.js'
import { resolveLogoUri } from './artwork.js'
import { generateConcept } from './generate.js'

export { screenConcept } from './screen.js'
export { checkDenylist, TRADEMARK_DENYLIST } from './denylist.js'
export { checkTickerUniqueness } from './uniqueness.js'
export { generate3dLogo, resolveLogoUri } from './artwork.js'
export { generateConcept } from './generate.js'
export { llmConfigured, resolveLlmProvider } from './llm.js'

export interface ConceptEngineResult {
  input: LaunchInput
  screening: Awaited<ReturnType<typeof screenConcept>>
  artworkSource: 'operator-supplied' | 'forge-3d'
}

/**
 * The full concept pipeline: (generate if `theme` given, else use the
 * operator-supplied config verbatim) → denylist + LLM safety screen →
 * on-chain ticker uniqueness → artwork resolution → a ready `LaunchInput`.
 *
 * Fully deterministic when `config` already has `name`/`symbol` — zero LLM
 * calls happen in that path (generation is skipped, and screening degrades
 * to denylist-only if no LLM key is configured).
 */
export async function buildConcept(
  network: HoodNetwork,
  config: LaunchConfig,
  opts: { theme?: string; artworkPrompt?: string } = {},
): Promise<ConceptEngineResult> {
  let name = config.name
  let symbol = config.symbol
  let description = config.description

  if (opts.theme) {
    const generated = await generateConcept(opts.theme)
    name = generated.name
    symbol = generated.symbol
    description = generated.description || generated.lore
  }

  const screening = await screenConcept({ name, symbol, description })
  await checkTickerUniqueness(network, symbol)
  const artwork = await resolveLogoUri({
    logoUri: config.logoUri,
    name,
    description,
    artworkPrompt: opts.artworkPrompt,
  })

  const input: LaunchInput = {
    name,
    symbol,
    description,
    logoUri: artwork.logoUri,
    socials: config.socials,
    initialBuyWei: BigInt(Math.round(config.initialBuyEth * 1e18)),
  }

  return { input, screening, artworkSource: artwork.source }
}
