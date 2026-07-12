import type { HoodNetwork } from 'hoodchain'
import { explorerApiUrl } from './explorer.js'

/** Standard-JSON-input verification payload for Blockscout's Etherscan-compatible API. */
export interface VerifySourceOptions {
  network: HoodNetwork
  address: `0x${string}`
  contractName: string
  /** Path inside the solc `sources` map, e.g. `"HoodToken.sol"`. */
  sourceFile: string
  standardJsonInput: unknown
  compilerVersion: string
  /** ABI-encoded constructor arguments, hex, no `0x` prefix. Empty string if none. */
  constructorArguments: string
}

export interface VerifyResult {
  submitted: boolean
  guid: string | null
  status: 'pass' | 'pending' | 'fail' | 'already_verified' | 'error'
  message: string
}

/**
 * Submit standard-JSON-input source verification to Blockscout's
 * Etherscan-compatible API (`?module=contract&action=verifysourcecode`,
 * confirmed live on both mainnet and testnet Blockscout during this build),
 * then poll `checkverifystatus` until it resolves.
 */
export async function verifySource(opts: VerifySourceOptions): Promise<VerifyResult> {
  const base = explorerApiUrl(opts.network)
  const body = new URLSearchParams({
    module: 'contract',
    action: 'verifysourcecode',
    addressHash: opts.address,
    contractSourceCode: JSON.stringify(opts.standardJsonInput),
    codeformat: 'solidity-standard-json-input',
    contractName: `${opts.sourceFile}:${opts.contractName}`,
    compilerVersion: opts.compilerVersion,
    constructorArguments: opts.constructorArguments,
  })

  const submitRes = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  const submitJson = (await submitRes.json()) as { status: string; message: string; result: string | null }

  if (submitJson.status !== '1') {
    // Blockscout reports "already verified" as a non-1 status with that message.
    const alreadyVerified = /already verified/i.test(submitJson.result ?? submitJson.message ?? '')
    return {
      submitted: false,
      guid: null,
      status: alreadyVerified ? 'already_verified' : 'error',
      message: submitJson.result ?? submitJson.message,
    }
  }

  const guid = submitJson.result
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((r) => setTimeout(r, 3000))
    const statusRes = await fetch(
      `${base}?module=contract&action=checkverifystatus&guid=${encodeURIComponent(guid ?? '')}`,
    )
    const statusJson = (await statusRes.json()) as { status: string; result: string }
    if (/pass|success|already verified/i.test(statusJson.result)) {
      return { submitted: true, guid, status: 'pass', message: statusJson.result }
    }
    if (/fail/i.test(statusJson.result)) {
      return { submitted: true, guid, status: 'fail', message: statusJson.result }
    }
    // else "Pending in queue" — keep polling.
  }
  return { submitted: true, guid, status: 'pending', message: 'Verification still pending after polling window' }
}
