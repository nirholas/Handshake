/**
 * 3D logo generation on the three.ws public "forge free" lane — hood-
 * launcher's differentiator: every autonomously-launched coin ships with a
 * real 3D-rendered GLB logo, generated on the free NVIDIA NIM (Microsoft
 * TRELLIS) lane, no key/auth/payment required.
 *
 * Endpoint shape verified live during this build:
 *   POST https://three.ws/api/forge  { prompt, tier: "draft", path: "image" }
 * returns EITHER a terminal envelope inline (`status:"done"`) or a
 * `job_id` to poll via `GET /api/forge?job=<id>`. The POST can legitimately
 * take 40–90s (it sometimes blocks through the whole generation), so a
 * short client timeout produces false failures — use a generous one.
 */

const FORGE_BASE = process.env.HOOD_LAUNCHER_FORGE_BASE ?? 'https://three.ws'
const POST_TIMEOUT_MS = 90_000
const POLL_INTERVAL_MS = 15_000
const POLL_BUDGET_MS = 5 * 60_000

interface ForgeEnvelope {
  status: 'queued' | 'running' | 'done' | 'error' | string
  job_id: string | null
  glb_url?: string | null
  quality?: { score?: number; valid?: boolean } | null
  error?: string
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export interface Generate3dLogoResult {
  glbUrl: string
  qualityScore: number | null
}

/**
 * Generate a 3D logo GLB from a text prompt on the free forge lane.
 *
 * @throws Error when the lane errors out or the polling budget is exhausted
 * — callers should catch and fall back to {@link resolveLogoUri}'s
 * plain-image path rather than blocking a launch on a GPU lane hiccup.
 */
export async function generate3dLogo(prompt: string): Promise<Generate3dLogoResult> {
  const postRes = await fetchWithTimeout(
    `${FORGE_BASE}/api/forge`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, tier: 'draft', path: 'image' }),
    },
    POST_TIMEOUT_MS,
  )
  if (!postRes.ok) throw new Error(`forge free lane POST failed: ${postRes.status} ${await postRes.text()}`)
  let envelope = (await postRes.json()) as ForgeEnvelope

  const deadline = Date.now() + POLL_BUDGET_MS
  while (envelope.status !== 'done' && envelope.status !== 'error' && Date.now() < deadline) {
    if (!envelope.job_id) break
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    const pollRes = await fetchWithTimeout(
      `${FORGE_BASE}/api/forge?job=${encodeURIComponent(envelope.job_id)}`,
      { method: 'GET' },
      30_000,
    )
    if (!pollRes.ok) throw new Error(`forge free lane poll failed: ${pollRes.status}`)
    envelope = (await pollRes.json()) as ForgeEnvelope
  }

  if (envelope.status === 'error') throw new Error(`forge free lane job failed: ${envelope.error ?? 'unknown error'}`)
  if (envelope.status !== 'done' || !envelope.glb_url) {
    throw new Error(`forge free lane did not complete within ${POLL_BUDGET_MS / 1000}s (last status: ${envelope.status})`)
  }
  return { glbUrl: envelope.glb_url, qualityScore: envelope.quality?.score ?? null }
}

/**
 * Resolve the logo URI a launch will ship with. If `logoUri` is already
 * supplied (operator config or a hand-picked image/IPFS URI), it is used
 * as-is — no forge call, no LLM, zero-cost path. Otherwise a 3D logo is
 * generated from `artworkPrompt` (defaulting to the coin's name+description)
 * on the free forge lane. On any forge failure the caller falls back to a
 * plain data URI placeholder is NEVER used — a failure here is a real
 * failure the caller must handle (e.g. skip the launch, or fall back to an
 * operator-supplied default logo).
 */
export async function resolveLogoUri(input: {
  logoUri?: string | undefined
  name: string
  description: string
  artworkPrompt?: string | undefined
}): Promise<{ logoUri: string; source: 'operator-supplied' | 'forge-3d' }> {
  if (input.logoUri) return { logoUri: input.logoUri, source: 'operator-supplied' }
  const prompt = input.artworkPrompt ?? `minimalist 3D coin logo emblem for "${input.name}": ${input.description}`.trim()
  const { glbUrl } = await generate3dLogo(prompt)
  return { logoUri: glbUrl, source: 'forge-3d' }
}
