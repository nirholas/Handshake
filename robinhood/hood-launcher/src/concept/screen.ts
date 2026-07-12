import { checkDenylist } from './denylist.js'
import { resolveLlmProvider, parseJsonResponse } from './llm.js'
import { ConceptRejectedError } from '../errors.js'

export interface ScreenResult {
  allowed: boolean
  reason: string
  /** Which layer produced the verdict. LLM screening only runs when a key is configured. */
  layer: 'denylist' | 'llm' | 'llm-unavailable'
}

const SCREEN_SYSTEM_PROMPT = `You are a safety screen for an autonomous memecoin launcher on Robinhood Chain.
Given a proposed coin name, ticker, and description, decide if it violates the no-impersonation policy:
- Refuse names/tickers/descriptions built to impersonate a specific real, named PRIVATE individual (not a public figure) without any indication of consent.
- Refuse names that impersonate a specific company, product, or brand as if the coin WERE that brand (vs. commentary/parody about a public trend, which is allowed).
- Public figures, politicians, celebrities, and internet-culture references used as commentary/memes are ALLOWED (this is normal memecoin culture).
- Generic words, jokes, animals, and abstract concepts are always ALLOWED.
Respond with ONLY a JSON object: {"allowed": boolean, "reason": "one sentence"}`

/**
 * Two-layer concept safety screen:
 * 1. {@link checkDenylist} — deterministic, zero-network, always runs.
 * 2. An LLM judgment call for impersonation/trademark nuance the denylist
 *    can't catch — only runs when `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` is
 *    configured. Its absence is reported, not silently skipped.
 *
 * @throws {@link ConceptRejectedError} when either layer rejects the concept.
 */
export async function screenConcept(input: {
  name: string
  symbol: string
  description: string
}): Promise<ScreenResult> {
  checkDenylist(input) // throws on match

  const provider = resolveLlmProvider()
  if (!provider) {
    return { allowed: true, reason: 'no LLM key configured — denylist-only screening applied', layer: 'llm-unavailable' }
  }

  const prompt = `Name: ${input.name}\nTicker: ${input.symbol}\nDescription: ${input.description || '(none)'}`
  const raw = await provider.complete(prompt, SCREEN_SYSTEM_PROMPT)
  let verdict: { allowed: boolean; reason: string }
  try {
    verdict = parseJsonResponse(raw)
  } catch {
    // A malformed LLM response should not silently pass a launch through —
    // fail closed and let the operator retry or fix the prompt/model.
    throw new ConceptRejectedError(`LLM safety screen returned an unparseable response: ${raw.slice(0, 200)}`, 'concept')
  }
  if (!verdict.allowed) {
    throw new ConceptRejectedError(verdict.reason, 'concept')
  }
  return { allowed: true, reason: verdict.reason, layer: 'llm' }
}
