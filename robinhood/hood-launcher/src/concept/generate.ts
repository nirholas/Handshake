import { resolveLlmProvider, parseJsonResponse, llmConfigured } from './llm.js'
import { ConceptRejectedError } from '../errors.js'

export interface GeneratedConcept {
  name: string
  symbol: string
  description: string
  lore: string
}

const GENERATE_SYSTEM_PROMPT = `You invent memecoin concepts for an autonomous launcher on Robinhood Chain.
Given a theme or trending narrative, invent ONE original coin concept: a catchy name, a short
ticker (2-8 letters, no $ prefix), a one-line description, and 2-3 sentences of lore/backstory.
Never name a real private individual. Never use a company/brand name as if the coin WERE that
brand. Respond with ONLY a JSON object: {"name": string, "symbol": string, "description": string, "lore": string}`

/**
 * Generate a coin concept from a theme/narrative using the operator's
 * configured LLM (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`). This is the
 * autonomous-mode entry point — fully deterministic/config-first launches
 * never call this at all.
 *
 * @throws {@link ConceptRejectedError} when no LLM is configured (there is
 * no fabricated fallback for creative generation — that would be fake data).
 */
export async function generateConcept(theme: string): Promise<GeneratedConcept> {
  if (!llmConfigured()) {
    throw new ConceptRejectedError(
      'no LLM configured (set OPENAI_API_KEY or ANTHROPIC_API_KEY) — concept generation requires one; ' +
        'fully deterministic launches should supply name/symbol/description directly instead of calling generateConcept',
      'concept',
    )
  }
  const provider = resolveLlmProvider()
  if (!provider) throw new ConceptRejectedError('LLM provider resolution failed unexpectedly', 'concept')

  const raw = await provider.complete(`Theme: ${theme}`, GENERATE_SYSTEM_PROMPT)
  let concept: GeneratedConcept
  try {
    concept = parseJsonResponse(raw)
  } catch {
    throw new ConceptRejectedError(`LLM concept generation returned unparseable JSON: ${raw.slice(0, 200)}`, 'concept')
  }
  if (!concept.name || !concept.symbol) {
    throw new ConceptRejectedError('LLM concept generation omitted name or symbol', 'concept')
  }
  return {
    ...concept,
    symbol: concept.symbol.replace(/^\$/, '').toUpperCase().slice(0, 12),
  }
}
