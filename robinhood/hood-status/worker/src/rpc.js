/** Minimal JSON-RPC client over fetch with timing. */

let nextId = 1;

/**
 * @returns {Promise<{ ok: true, result: any, latencyMs: number } | { ok: false, error: string, latencyMs: number|null }>}
 */
export async function rpcCall(url, method, params = [], timeoutMs = 8000) {
  const started = performance.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = performance.now() - started;
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, latencyMs };
    const body = await res.json();
    if (body.error) {
      return { ok: false, error: `RPC error ${body.error.code}: ${body.error.message}`, latencyMs };
    }
    return { ok: true, result: body.result, latencyMs };
  } catch (err) {
    const latencyMs = performance.now() - started;
    const msg = err.name === 'TimeoutError' ? `timeout after ${timeoutMs}ms` : err.message;
    return { ok: false, error: msg, latencyMs };
  }
}

export const hexToNumber = (hex) => (typeof hex === 'string' ? parseInt(hex, 16) : NaN);

export const hexToBigInt = (hex) => BigInt(hex);

/** Decode a 32-byte word at slot index i from an eth_call return blob. */
export function word(data, i) {
  return '0x' + data.slice(2 + i * 64, 2 + (i + 1) * 64);
}

/** Two's-complement int256 decode for Chainlink answers. */
export function decodeInt256(hexWord) {
  const v = BigInt(hexWord);
  const max = 1n << 255n;
  return v >= max ? v - (1n << 256n) : v;
}
