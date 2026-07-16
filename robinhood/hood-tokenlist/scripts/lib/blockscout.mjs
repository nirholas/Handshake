/**
 * Thin Blockscout v2 API client for robinhoodchain.blockscout.com with
 * pacing + retry (the public instance rate-limits bursts).
 */

export const BLOCKSCOUT_BASE = 'https://robinhoodchain.blockscout.com'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let lastCallAt = 0
const MIN_SPACING_MS = 250

async function paced() {
  const wait = lastCallAt + MIN_SPACING_MS - Date.now()
  if (wait > 0) await sleep(wait)
  lastCallAt = Date.now()
}

async function getJson(path, tries = 5) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      await paced()
      const response = await fetch(`${BLOCKSCOUT_BASE}${path}`, {
        headers: { accept: 'application/json' },
      })
      if (response.status === 404) return null
      if (!response.ok) {
        const err = new Error(`Blockscout HTTP ${response.status} for ${path}`)
        err.retryable = response.status === 429 || response.status >= 500
        throw err
      }
      return await response.json()
    } catch (error) {
      const retryable = error.retryable || /fetch failed|socket|ECONN|network/i.test(String(error?.message))
      if (!retryable || attempt === tries - 1) {
        // A single flaky endpoint must not abort a whole refresh. Callers
        // treat null as "unknown", which the inclusion rules count as a
        // failure for that candidate (with the reason logged in the report).
        console.error(`[blockscout] giving up on ${path}: ${error?.message ?? error}`)
        return null
      }
      await sleep(800 * 2 ** attempt)
    }
  }
  return null
}

/**
 * Token metadata: holders count, icon URL, reported symbol/decimals.
 * Returns null when Blockscout does not know the token.
 */
export async function tokenInfo(address) {
  const data = await getJson(`/api/v2/tokens/${address}`)
  if (!data) return null
  return {
    address,
    symbol: data.symbol ?? null,
    name: data.name ?? null,
    decimals: data.decimals != null ? Number(data.decimals) : null,
    holdersCount: data.holders_count != null ? Number(data.holders_count) : null,
    iconUrl: data.icon_url || null,
    reputation: data.reputation ?? null,
  }
}

/** The largest current holder of a token (used for the transfer simulation). */
export async function topHolder(address) {
  const data = await getJson(`/api/v2/tokens/${address}/holders`)
  const first = data?.items?.[0]
  const holder = first?.address_hash ?? first?.address?.hash
  return holder ?? null
}

/**
 * Download a token icon for self-hosting. Returns { bytes, extension } or
 * null when the asset is missing, oversized, or not an image.
 */
export async function downloadIcon(url, { maxBytes = 512 * 1024 } = {}) {
  try {
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok) return null
    const type = (response.headers.get('content-type') || '').toLowerCase()
    const extension = type.includes('svg')
      ? 'svg'
      : type.includes('png')
        ? 'png'
        : type.includes('webp')
          ? 'webp'
          : type.includes('jpeg') || type.includes('jpg')
            ? 'jpg'
            : null
    if (!extension) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength === 0 || buffer.byteLength > maxBytes) return null
    return { bytes: buffer, extension }
  } catch {
    return null
  }
}
