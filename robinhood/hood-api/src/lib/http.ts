import { ApiError } from './errors.js'

/** Fetch JSON with a hard timeout and a typed upstream error on failure. */
export async function fetchJson<T>(
  url: string,
  opts: { timeoutMs?: number; headers?: Record<string, string>; label?: string } = {},
): Promise<T> {
  const { timeoutMs = 10_000, headers, label = new URL(url).host } = opts
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers, signal: controller.signal })
    if (!res.ok) {
      throw ApiError.upstream(
        `${label} returned HTTP ${res.status}. Upstream may be rate-limited or degraded; retry shortly.`,
        'upstream_http_error',
      )
    }
    return (await res.json()) as T
  } catch (err) {
    if (err instanceof ApiError) throw err
    const reason = (err as Error).name === 'AbortError' ? `timed out after ${timeoutMs}ms` : (err as Error).message
    throw ApiError.upstream(`${label} request failed (${reason}).`, 'upstream_unreachable')
  } finally {
    clearTimeout(timer)
  }
}

/** Run `fn`, falling back to `fallback` if it throws. Logs which path won for observability. */
export async function withFallback<T>(
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
  label: string,
): Promise<T> {
  try {
    return await primary()
  } catch (err) {
    console.warn(`[hood-api] ${label}: primary failed (${(err as Error).message}); using fallback`)
    return fallback()
  }
}
