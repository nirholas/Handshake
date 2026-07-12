import { useEffect, useRef, useState } from 'react'
import { createHoodClient, getPortfolio } from 'hoodchain'

/**
 * Local stand-in for a `hoodkit` React hook. `hoodkit` (the SDK's React
 * bindings, Wave 2) has not been built yet in this workspace — see the SDK
 * feedback note in the root README. This hook is intentionally the shape
 * `useHoodPortfolio` from `hoodkit` is expected to have, so upgrading later
 * is a one-line import swap:
 *
 *   - import { useHoodPortfolio } from './useHoodPortfolio.js'
 *   + import { useHoodPortfolio } from 'hoodkit'
 */
const hood = createHoodClient()

export function useHoodPortfolio(owner, { pollMs = 20000 } = {}) {
  const [state, setState] = useState({ status: 'idle', portfolio: null, error: null })
  const timer = useRef(null)

  useEffect(() => {
    if (!owner) {
      setState({ status: 'idle', portfolio: null, error: null })
      return
    }
    let cancelled = false
    setState((s) => ({ ...s, status: 'loading' }))

    async function load() {
      try {
        const portfolio = await getPortfolio(hood, owner, { maxAgeSeconds: 7 * 24 * 3600 })
        if (!cancelled) setState({ status: 'success', portfolio, error: null })
      } catch (error) {
        if (!cancelled) setState({ status: 'error', portfolio: null, error })
      }
    }

    load()
    timer.current = setInterval(load, pollMs)
    return () => {
      cancelled = true
      clearInterval(timer.current)
    }
  }, [owner, pollMs])

  return state
}
