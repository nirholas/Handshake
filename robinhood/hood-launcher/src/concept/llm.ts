/**
 * Minimal LLM client supporting both OpenAI and Anthropic — whichever the
 * operator configures via `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`. No proxy
 * of ours sits in between; these are direct calls to each vendor's public
 * REST API. When neither key is set, {@link llmConfigured} is `false` and
 * every concept-engine step that needs an LLM falls back to its documented
 * deterministic/offline behavior instead of throwing.
 */

export interface LlmProvider {
  name: 'openai' | 'anthropic'
  complete(prompt: string, system?: string): Promise<string>
}

export function llmConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY)
}

/** Resolve the operator's configured LLM provider, or `null` if none is set. */
export function resolveLlmProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider | null {
  const preferred = env.CONCEPT_LLM_PROVIDER
  if ((preferred === 'openai' || !preferred) && env.OPENAI_API_KEY) {
    return openaiProvider(env.OPENAI_API_KEY, env.CONCEPT_LLM_MODEL ?? 'gpt-4o-mini')
  }
  if ((preferred === 'anthropic' || !preferred) && env.ANTHROPIC_API_KEY) {
    return anthropicProvider(env.ANTHROPIC_API_KEY, env.CONCEPT_LLM_MODEL ?? 'claude-sonnet-5')
  }
  return null
}

function openaiProvider(apiKey: string, model: string): LlmProvider {
  return {
    name: 'openai',
    async complete(prompt, system) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }],
          temperature: 0.9,
        }),
      })
      if (!res.ok) throw new Error(`OpenAI completion failed: ${res.status} ${await res.text()}`)
      const json = (await res.json()) as { choices: { message: { content: string } }[] }
      return json.choices[0]?.message.content ?? ''
    },
  }
}

function anthropicProvider(apiKey: string, model: string): LlmProvider {
  return {
    name: 'anthropic',
    async complete(prompt, system) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          ...(system ? { system } : {}),
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      if (!res.ok) throw new Error(`Anthropic completion failed: ${res.status} ${await res.text()}`)
      const json = (await res.json()) as { content: { type: string; text?: string }[] }
      return json.content.find((c) => c.type === 'text')?.text ?? ''
    },
  }
}

/** Parse a JSON object out of an LLM response that may be wrapped in markdown code fences. */
export function parseJsonResponse<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fenced ? fenced[1] : text
  return JSON.parse((raw ?? text).trim()) as T
}
