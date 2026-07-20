/**
 * Multi-provider LLM client for {@link LlmStrategist}. Bring your own key: the
 * operator picks exactly one of Anthropic Claude, OpenAI, Groq, or OpenRouter
 * via env config (see {@link loadLlmConfig} in ./config.js) and this module
 * speaks that provider's HTTP API directly with `fetch` — no SDK dependency,
 * matching the rest of this package (better-sqlite3, hoodchain, viem, ws are
 * the only runtime deps).
 *
 * The verdict contract is strict on purpose: a strategy that trades real money
 * must never trust free-text from an LLM. Every provider is prompted to return
 * ONLY a JSON object; the response is parsed with a tolerant extractor (finds
 * the first `{...}` blob, so a model that wraps the JSON in a sentence still
 * works) and validated field-by-field. A malformed or missing verdict throws —
 * the caller (LlmStrategist.tick) treats that as "skip this candidate, alert",
 * never as an implicit buy or an implicit skip-silently.
 */

export type LlmProvider = 'anthropic' | 'openai' | 'groq' | 'openrouter'

export interface LlmClientConfig {
  provider: LlmProvider
  apiKey: string
  /** Falls back to a sane per-provider default (see {@link DEFAULT_MODELS}) when unset. */
  model?: string
  /** Abort the request after this many ms. Default 9000. */
  timeoutMs?: number
}

export interface LlmVerdict {
  buy: boolean
  /** Clamped to [0, 1]. */
  confidence: number
  thesis: string
}

/**
 * Default model per provider. Anthropic and OpenRouter defaults are stable
 * (a dated snapshot and an auto-router, respectively). OpenAI/Groq model
 * catalogs move faster — `HOOD_LLM_MODEL` overrides any of these; if a default
 * ever goes stale the provider call fails with a clear "check HOOD_LLM_MODEL"
 * error (see {@link callProvider}) rather than a silent misroute.
 */
const DEFAULT_MODELS: Record<LlmProvider, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'openrouter/auto',
}

const SYSTEM_PROMPT = [
  'You are a risk-averse trading analyst judging a brand-new token launch on Robinhood Chain,',
  'a 24/7 permissionless DEX environment where most launches are worthless or scams.',
  'You will be given real on-chain facts about one launch: its launchpad, whether a buy-then-sell',
  'round trip retains value (a honeypot signal), and what fraction of supply the deployer wallet',
  'still holds (a rug-risk signal). You have no access to socials, team identity, or any off-chain',
  'information — judge only from what is given.',
  '',
  'Reply with ONLY a single JSON object, no prose before or after it, matching exactly:',
  '{"buy": boolean, "confidence": number between 0 and 1, "thesis": "one sentence"}',
  '',
  '"buy" should be true only when the facts given suggest this is unusually clean for a brand-new',
  'launch (high retention, low deployer concentration) — most launches should get buy:false.',
  '"confidence" reflects how sure you are in that judgment given how thin the available signal is.',
].join('\n')

/** Ask the configured LLM to judge a launch brief. Throws on any failure (timeout, HTTP error, malformed verdict). */
export async function judgeLaunch(cfg: LlmClientConfig, brief: string): Promise<LlmVerdict> {
  const model = cfg.model || DEFAULT_MODELS[cfg.provider]
  const timeoutMs = cfg.timeoutMs ?? 9000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const text = await callProvider(cfg.provider, cfg.apiKey, model, brief, controller.signal)
    return parseVerdict(text)
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`hood-traders llm.ts: ${cfg.provider} request timed out after ${timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function callProvider(
  provider: LlmProvider,
  apiKey: string,
  model: string,
  brief: string,
  signal: AbortSignal,
): Promise<string> {
  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: brief }],
      }),
    })
    const body = await res.text()
    if (!res.ok) throw providerError('anthropic', model, res.status, body)
    const data = JSON.parse(body) as { content?: { text?: string }[] }
    const text = data.content?.[0]?.text
    if (!text) throw new Error(`hood-traders llm.ts: anthropic response had no content text: ${body.slice(0, 300)}`)
    return text
  }

  // openai, groq, and openrouter all speak the OpenAI chat-completions shape.
  const { url, extraHeaders } = openAiCompatibleEndpoint(provider)
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: brief },
      ],
    }),
  })
  const body = await res.text()
  if (!res.ok) throw providerError(provider, model, res.status, body)
  const data = JSON.parse(body) as { choices?: { message?: { content?: string } }[] }
  const text = data.choices?.[0]?.message?.content
  if (!text) throw new Error(`hood-traders llm.ts: ${provider} response had no message content: ${body.slice(0, 300)}`)
  return text
}

function openAiCompatibleEndpoint(provider: 'openai' | 'groq' | 'openrouter'): {
  url: string
  extraHeaders: Record<string, string>
} {
  switch (provider) {
    case 'openai':
      return { url: 'https://api.openai.com/v1/chat/completions', extraHeaders: {} }
    case 'groq':
      return { url: 'https://api.groq.com/openai/v1/chat/completions', extraHeaders: {} }
    case 'openrouter':
      return {
        url: 'https://openrouter.ai/api/v1/chat/completions',
        extraHeaders: {
          'HTTP-Referer': 'https://github.com/nirholas/hood-traders',
          'X-Title': 'hood-traders',
        },
      }
  }
}

function providerError(provider: LlmProvider, model: string, status: number, body: string): Error {
  return new Error(
    `hood-traders llm.ts: ${provider} rejected request (HTTP ${status}, model="${model}"). ` +
      `If this is a model-not-found error, set HOOD_LLM_MODEL to a current model id for this provider. ` +
      `Response: ${body.slice(0, 300)}`,
  )
}

/** Extract the first `{...}` blob from `text` and validate it as an {@link LlmVerdict}. Throws on any mismatch. */
export function parseVerdict(text: string): LlmVerdict {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`hood-traders llm.ts: no JSON object found in LLM response: ${text.slice(0, 300)}`)
  let raw: unknown
  try {
    raw = JSON.parse(match[0])
  } catch (err) {
    throw new Error(`hood-traders llm.ts: LLM response JSON did not parse: ${(err as Error).message}`)
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('hood-traders llm.ts: LLM verdict was not a JSON object')
  }
  const v = raw as Record<string, unknown>
  if (typeof v.buy !== 'boolean') {
    throw new Error(`hood-traders llm.ts: LLM verdict missing boolean "buy": ${JSON.stringify(v)}`)
  }
  if (typeof v.thesis !== 'string' || v.thesis.trim().length === 0) {
    throw new Error(`hood-traders llm.ts: LLM verdict missing non-empty "thesis": ${JSON.stringify(v)}`)
  }
  const confidenceRaw = typeof v.confidence === 'number' ? v.confidence : Number(v.confidence)
  if (!Number.isFinite(confidenceRaw)) {
    throw new Error(`hood-traders llm.ts: LLM verdict has non-numeric "confidence": ${JSON.stringify(v)}`)
  }
  const confidence = Math.min(1, Math.max(0, confidenceRaw))
  return { buy: v.buy, confidence, thesis: v.thesis.trim() }
}
