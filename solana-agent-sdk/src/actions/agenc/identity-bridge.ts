// Identity bridge between three.ws's existing agent identity systems
// (ERC-8004 + Metaplex Core) and the AgenC coordination protocol's
// 32-byte agentId namespace.
//
// Each external identity is hashed under a namespaced domain string so a
// collision between, say, an ERC-8004 agent #42 and a Metaplex Core asset
// is statistically impossible. The bridge also produces a stable canonical
// id when a three.ws agent record carries multiple identity proofs.
//
// Namespaces (prefixed before the identifier bytes in the SHA-256 input):
//
//   AgenC/three.ws/erc8004/v1\0  | uint256 BE
//   AgenC/three.ws/mpl-core/v1\0 | 32-byte Solana pubkey
//   AgenC/three.ws/handle/v1\0   | UTF-8 lowercased handle
//   AgenC/three.ws/composite/v1\0| canonical JSON of the input descriptor
//
// The `composite` variant is the "canonical" three.ws → AgenC mapping when
// an agent has BOTH an ERC-8004 record and a Metaplex Core asset; it binds
// the two so neither side can be swapped post-hoc without re-registration.

import { PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";

const NS_ERC8004 = "AgenC/three.ws/erc8004/v1\0";
const NS_MPL_CORE = "AgenC/three.ws/mpl-core/v1\0";
const NS_HANDLE = "AgenC/three.ws/handle/v1\0";
const NS_COMPOSITE = "AgenC/three.ws/composite/v1\0";

function sha256(...parts: (string | Buffer | Uint8Array)[]): Uint8Array {
  const h = createHash("sha256");
  for (const p of parts) {
    if (typeof p === "string") h.update(p, "utf8");
    else h.update(p);
  }
  return Uint8Array.from(h.digest());
}

function erc8004IdToBeBytes(id: bigint | number | string): Buffer {
  let n: bigint;
  if (typeof id === "bigint") n = id;
  else if (typeof id === "number") {
    if (!Number.isInteger(id) || id < 0) {
      throw new Error("ERC-8004 agentId must be a non-negative integer");
    }
    n = BigInt(id);
  } else {
    const s = id.trim();
    n = s.startsWith("0x") || s.startsWith("0X") ? BigInt(s) : BigInt(s);
  }
  if (n < 0n) throw new Error("ERC-8004 agentId must be non-negative");
  // ERC-8004's IdentityRegistry uses uint256 — encode as 32-byte big-endian.
  const out = Buffer.alloc(32);
  let cur = n;
  for (let i = 31; i >= 0 && cur > 0n; i--) {
    out[i] = Number(cur & 0xffn);
    cur >>= 8n;
  }
  return out;
}

/** Derive an AgenC 32-byte agentId from an ERC-8004 agent ID (uint256). */
export function bridgeErc8004ToAgenCId(
  erc8004AgentId: bigint | number | string,
): Uint8Array {
  return sha256(NS_ERC8004, erc8004IdToBeBytes(erc8004AgentId));
}

/** Derive an AgenC 32-byte agentId from a Metaplex Core asset pubkey. */
export function bridgeMplCoreToAgenCId(
  assetAddress: PublicKey | string,
): Uint8Array {
  const pk =
    assetAddress instanceof PublicKey
      ? assetAddress
      : new PublicKey(assetAddress);
  return sha256(NS_MPL_CORE, pk.toBytes());
}

/** Derive an AgenC 32-byte agentId from a three.ws agent handle (slug). */
export function bridgeThreewsHandleToAgenCId(handle: string): Uint8Array {
  const norm = handle.trim().toLowerCase();
  if (!norm) throw new Error("handle must be non-empty");
  return sha256(NS_HANDLE, norm);
}

export interface ThreewsAgentIdentityRef {
  /** ERC-8004 IdentityRegistry agentId (uint256). */
  erc8004AgentId?: bigint | number | string | null;
  /** Metaplex Core asset address. */
  mplCoreAsset?: PublicKey | string | null;
  /** three.ws handle / slug (used as last-resort and for metadataUri). */
  handle?: string | null;
}

export interface CanonicalAgenCIdResult {
  agenCAgentId: Uint8Array;
  /** Which identity system was used to derive the canonical id. */
  source: "composite" | "erc8004" | "mpl-core" | "handle";
  /** A stable label that callers can persist alongside the AgenC PDA. */
  label: string;
}

/**
 * Derive the canonical AgenC agentId for a three.ws agent. Selection priority:
 *
 *   1. Both ERC-8004 + Metaplex Core present → composite (binds both proofs)
 *   2. ERC-8004 only                         → ERC-8004 namespace
 *   3. Metaplex Core only                    → mpl-core namespace
 *   4. Handle only                           → handle namespace
 *
 * Throws if none of the three are supplied.
 */
export function getCanonicalThreewsAgenCId(
  ref: ThreewsAgentIdentityRef,
): CanonicalAgenCIdResult {
  const hasErc = ref.erc8004AgentId !== undefined && ref.erc8004AgentId !== null && ref.erc8004AgentId !== "";
  const hasMpl = ref.mplCoreAsset !== undefined && ref.mplCoreAsset !== null && ref.mplCoreAsset !== "";

  if (hasErc && hasMpl) {
    const ercBytes = erc8004IdToBeBytes(ref.erc8004AgentId!);
    const mplPk =
      ref.mplCoreAsset instanceof PublicKey
        ? ref.mplCoreAsset
        : new PublicKey(ref.mplCoreAsset as string);
    const composite = JSON.stringify({
      v: 1,
      erc8004: "0x" + ercBytes.toString("hex"),
      mplCore: mplPk.toBase58(),
    });
    return {
      agenCAgentId: sha256(NS_COMPOSITE, composite),
      source: "composite",
      label: `composite:erc8004=${ref.erc8004AgentId}+mpl=${mplPk.toBase58()}`,
    };
  }

  if (hasErc) {
    return {
      agenCAgentId: bridgeErc8004ToAgenCId(ref.erc8004AgentId!),
      source: "erc8004",
      label: `erc8004:${ref.erc8004AgentId}`,
    };
  }

  if (hasMpl) {
    const pk =
      ref.mplCoreAsset instanceof PublicKey
        ? ref.mplCoreAsset
        : new PublicKey(ref.mplCoreAsset as string);
    return {
      agenCAgentId: bridgeMplCoreToAgenCId(pk),
      source: "mpl-core",
      label: `mpl-core:${pk.toBase58()}`,
    };
  }

  if (ref.handle) {
    return {
      agenCAgentId: bridgeThreewsHandleToAgenCId(ref.handle),
      source: "handle",
      label: `handle:${ref.handle.toLowerCase()}`,
    };
  }

  throw new Error(
    "getCanonicalThreewsAgenCId: no identity supplied (need at least one of erc8004AgentId, mplCoreAsset, handle)",
  );
}

/**
 * Build the `metadataUri` field that three.ws agents should submit when
 * registering on AgenC, pointing back at the canonical agent record so AgenC
 * counterparties can resolve the three.ws identity proofs (ERC-8004 + MPL).
 *
 * Pass `baseUrl` (defaults to "https://three.ws") to point at a staging host.
 */
export function buildThreewsMetadataUri(
  ref: ThreewsAgentIdentityRef,
  baseUrl: string = "https://three.ws",
): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const params = new URLSearchParams();
  if (ref.erc8004AgentId !== undefined && ref.erc8004AgentId !== null && ref.erc8004AgentId !== "") {
    params.set("erc8004", String(ref.erc8004AgentId));
  }
  if (ref.mplCoreAsset) {
    const pk =
      ref.mplCoreAsset instanceof PublicKey
        ? ref.mplCoreAsset
        : new PublicKey(ref.mplCoreAsset as string);
    params.set("mpl", pk.toBase58());
  }
  if (ref.handle) {
    params.set("handle", ref.handle.toLowerCase());
  }
  const query = params.toString();
  return query ? `${trimmed}/.well-known/agent.json?${query}` : `${trimmed}/.well-known/agent.json`;
}

/** Convenience: AgenC agentId as a 64-char lowercase hex string. */
export function agenCAgentIdToHex(id: Uint8Array): string {
  return Buffer.from(id).toString("hex");
}
