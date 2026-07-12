import { ConceptRejectedError } from '../errors.js'

/**
 * Trademarked brands and platforms a launched coin's name/symbol/description
 * must not impersonate. This is deliberately a short, high-confidence,
 * word-boundary-matched list — NOT fuzzy/substring/leetspeak matching.
 * Substring matching on a list like this reliably false-positives on
 * unrelated real words (this workspace hit exactly that bug once: see
 * `docs/` history on the ERC-8004 slur gate — naive substring+leet matching
 * false-flagged 5 of 7 real, legitimate agent names). Extend this list
 * conservatively; every entry should be a term that has no plausible
 * legitimate memecoin meaning on its own.
 */
export const TRADEMARK_DENYLIST: readonly string[] = [
  'robinhood',
  'noxa',
  'the odyssey',
  'uniswap',
  'coinbase',
  'binance',
  'circle',
  'tether',
  'paxos',
  'chainlink',
  'metamask',
  'opensea',
  'pump.fun',
  'pumpfun',
]

/**
 * A named-real-person denylist. hood-launcher refuses to launch a coin whose
 * name/symbol is built around a private individual's real name without
 * their consent baked into the concept (public figures discussed as market
 * narrative — "trump coin"-style commentary tokens — are a documented grey
 * area the LLM screen in {@link screenConcept} handles case-by-case; this
 * list is only for names the operator has explicitly flagged as off-limits).
 * Empty by default — populate via `HOOD_LAUNCHER_PERSON_DENYLIST` (comma
 * separated) for operator-specific restrictions.
 */
export function personDenylist(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.HOOD_LAUNCHER_PERSON_DENYLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function wordBoundaryMatch(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack)
}

/**
 * Checkable, deterministic denylist gate — runs with zero network/LLM calls
 * so it always applies, even in fully offline/deterministic launch mode.
 *
 * @throws {@link ConceptRejectedError} on the first match.
 */
export function checkDenylist(input: { name: string; symbol: string; description: string }, env = process.env): void {
  const terms = [...TRADEMARK_DENYLIST, ...personDenylist(env)]
  const fields: Array<['name' | 'symbol' | 'description', string]> = [
    ['name', input.name],
    ['symbol', input.symbol],
    ['description', input.description],
  ]
  for (const [field, value] of fields) {
    for (const term of terms) {
      if (wordBoundaryMatch(value, term)) {
        throw new ConceptRejectedError(`contains denylisted term "${term}"`, field)
      }
    }
  }
}
