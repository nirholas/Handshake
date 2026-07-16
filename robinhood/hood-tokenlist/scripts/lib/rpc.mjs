/**
 * Minimal, resilient JSON-RPC layer for the Robinhood Chain public RPC.
 *
 * The public endpoint rate-limits bursts (HTTP 429) and times out log
 * queries over wide block ranges, so every call here retries with
 * exponential backoff and `getLogsRange` recursively halves a range that
 * the node refuses to serve.
 */

export const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const RETRYABLE = /timed out|too many|rate.?limit|429|502|503|fetch failed|socket|ECONN|network/i

let lastCallAt = 0
/** Minimum spacing between requests to stay under the public rate limit. */
const MIN_SPACING_MS = 120

async function paced() {
  const wait = lastCallAt + MIN_SPACING_MS - Date.now()
  if (wait > 0) await sleep(wait)
  lastCallAt = Date.now()
}

/**
 * Single JSON-RPC call with retry + backoff.
 * @param {string} method
 * @param {unknown[]} params
 * @param {number} tries
 */
export async function rpc(method, params, tries = 6) {
  let lastError
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      await paced()
      const response = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      if (!response.ok) {
        const err = new Error(`HTTP ${response.status} ${response.statusText}`)
        err.retryable = response.status === 429 || response.status >= 500
        throw err
      }
      const data = await response.json()
      if (data.error) {
        const err = new Error(data.error.message || JSON.stringify(data.error))
        err.retryable = RETRYABLE.test(err.message)
        err.rpcError = true
        throw err
      }
      return data.result
    } catch (error) {
      lastError = error
      const retryable = error.retryable || (!error.rpcError && RETRYABLE.test(String(error?.message ?? error)))
      if (!retryable || attempt === tries - 1) throw error
      await sleep(700 * 2 ** attempt)
    }
  }
  throw lastError
}

/**
 * Batched JSON-RPC (one HTTP request, many calls). Falls back to
 * sequential singles if the node rejects batching.
 * @param {{method: string, params: unknown[]}[]} calls
 */
export async function rpcBatch(calls, tries = 6) {
  if (calls.length === 0) return []
  let lastError
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      await paced()
      const response = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params }))),
      })
      if (!response.ok) {
        const err = new Error(`HTTP ${response.status} ${response.statusText}`)
        err.retryable = response.status === 429 || response.status >= 500
        throw err
      }
      const data = await response.json()
      if (!Array.isArray(data)) throw new Error(`batch response is not an array: ${JSON.stringify(data).slice(0, 200)}`)
      const results = new Array(calls.length)
      for (const item of data) {
        if (item.error) {
          const err = new Error(item.error.message || JSON.stringify(item.error))
          if (RETRYABLE.test(err.message)) {
            err.retryable = true
            throw err
          }
          results[item.id] = { error: err }
        } else {
          results[item.id] = { result: item.result }
        }
      }
      return results
    } catch (error) {
      lastError = error
      const retryable = error.retryable || RETRYABLE.test(String(error?.message ?? error))
      if (!retryable || attempt === tries - 1) throw error
      await sleep(700 * 2 ** attempt)
    }
  }
  throw lastError
}

/**
 * eth_getLogs over [fromBlock, toBlock], recursively halving any range the
 * node times out on. Returns logs in ascending block order.
 * @param {{address: string | string[], topics: (string | null)[]}} filter
 * @param {number} fromBlock
 * @param {number} toBlock
 */
export async function getLogsRange(filter, fromBlock, toBlock, depth = 0) {
  try {
    return await rpc(
      'eth_getLogs',
      [{ ...filter, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}` }],
      depth === 0 ? 2 : 3,
    )
  } catch (error) {
    if (depth >= 12 || toBlock - fromBlock < 256) {
      // Last resort: a small range with full retries. If this throws, the
      // whole refresh aborts, which is correct (never ship a partial scan).
      return rpc(
        'eth_getLogs',
        [{ ...filter, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}` }],
        6,
      )
    }
    const mid = Math.floor((fromBlock + toBlock) / 2)
    const left = await getLogsRange(filter, fromBlock, mid, depth + 1)
    const right = await getLogsRange(filter, mid + 1, toBlock, depth + 1)
    return left.concat(right)
  }
}

/**
 * Scan a whole block interval in fixed-size chunks (each chunk internally
 * halves on timeout). Reports progress via the optional callback.
 */
export async function scanLogs(filter, fromBlock, toBlock, { chunkSize = 500_000, onChunk } = {}) {
  const all = []
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, toBlock)
    const logs = await getLogsRange(filter, start, end)
    all.push(...logs)
    if (onChunk) onChunk({ fromBlock: start, toBlock: end, found: logs.length, total: all.length })
  }
  return all
}

/** Latest block number as an integer. */
export async function blockNumber() {
  return parseInt(await rpc('eth_blockNumber', []), 16)
}

/** Block timestamp (seconds) for a block number. */
export async function blockTimestamp(number) {
  const block = await rpc('eth_getBlockByNumber', [`0x${number.toString(16)}`, false])
  if (!block) throw new Error(`block ${number} not found`)
  return parseInt(block.timestamp, 16)
}
