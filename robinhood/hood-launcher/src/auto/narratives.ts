/**
 * Trending-narrative source for autonomous mode: the free three.ws crypto
 * news digest (`GET /api/news/digest`, verified live — no key required),
 * which clusters the last N hours of crypto coverage into narratives with a
 * title, summary, market stance, and tickers.
 */

const NEWS_BASE = process.env.HOOD_LAUNCHER_NEWS_BASE ?? 'https://three.ws'

export interface Narrative {
  title: string
  summary: string
  stance: 'bullish' | 'bearish' | 'neutral' | string
  tickers: string[]
  coverage: number
}

export async function fetchTrendingNarratives(hours = 24, limit = 8): Promise<Narrative[]> {
  const url = `${NEWS_BASE}/api/news/digest?hours=${hours}&limit=${limit}`
  const res = await fetch(url, { headers: { 'User-Agent': 'hood-launcher' } })
  if (!res.ok) throw new Error(`news digest fetch failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { narratives: Narrative[] }
  return body.narratives ?? []
}

/** Turn a narrative into a launch theme string for {@link generateConcept}. */
export function narrativeToTheme(n: Narrative): string {
  return `${n.title} — ${n.summary} (market stance: ${n.stance}${n.tickers.length ? `, related tickers: ${n.tickers.join(', ')}` : ''})`
}
