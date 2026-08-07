/**
 * ActionLedger - pure hash-chain primitives for the tamper-evident agent action ledger.
 *
 * Every value movement an agent initiates on-chain is recorded as one append-only row.
 * Each row's `entryHash = sha256(canonicalFields ‖ prevHash)`, so the chain head commits the
 * entire history (Merkle-equivalent): editing or deleting any historical row changes its
 * `entryHash` and breaks every link from that point forward. `verifyChain()` walks a user's
 * ordered rows and reports the exact index at which the chain first breaks.
 *
 * This module is intentionally I/O-free - no DB, no chain, no clock. It contains only the
 * deterministic hashing and verification logic (the part that lifts near-verbatim from the
 * three.ws `economy-ledger.js` hash construction). Storage is supplied by the host: the
 * API layer injects `computeEntryHash` into its locked append so this package never depends on
 * the database layer.
 *
 * Credits: hash-chain construction ported from the three.ws economy master ledger.
 */
/** Genesis link - the `prevHash` of the first entry in a user's chain (seq 1). */
export declare const LEDGER_GENESIS_HASH: string;
/**
 * The canonicalisation field separator, re-exported for audit tooling.
 *
 * Load-bearing and frozen - it is folded into every hash ever written, so changing it would
 * invalidate every existing chain. Exported so an audit bundle can state the exact construction a
 * third party needs in order to re-derive the hashes offline, without that consumer having to
 * hard-code a control character it cannot see.
 */
export declare const LEDGER_FIELD_SEPARATOR = "\0";
/**
 * The canonical field order folded into `entryHash`, in hash order. Purely descriptive - the
 * authority is `canonicalizeEntry`, and `ActionLedger.test.ts` pins the two together so this
 * cannot silently drift.
 */
export declare const LEDGER_CANONICAL_FIELD_ORDER: readonly ["seq", "ts", "userId", "agentId", "event", "target", "amountWei", "valueUsd", "txHash", "reason", "balanceBeforeWei", "balanceAfterWei", "network", "detail"];
/** The kind of value-movement event a ledger row records. */
export type LedgerEvent = 'transfer' | 'failed' | 'blocked' | 'sweep';
/**
 * The canonical, hash-committed fields of a ledger entry. Every field here is folded into
 * `entryHash`; anything not listed (e.g. the surrogate row `id`) is metadata and MUST NOT
 * affect the hash. Nullable fields are hashed as the empty string.
 */
export interface LedgerEntryInput {
    /** Per-user monotonic sequence number, starting at 1. */
    seq: number;
    /** ISO-8601 timestamp of the entry, exactly as stored. */
    ts: string;
    /** Owner (multi-tenant isolation key). */
    userId: string;
    /** Agent that initiated the movement, if known. */
    agentId: string | null;
    event: LedgerEvent;
    /** Recipient / counterparty address, if any. */
    target: string | null;
    /** Amount moved, in wei, as an exact decimal string (never a JS number). */
    amountWei: string | null;
    /** USD value at transfer time, if priced. */
    valueUsd: number | null;
    /** On-chain transaction hash, if the movement produced one. */
    txHash: string | null;
    /** Human-readable reason / provenance for the movement. */
    reason: string | null;
    /** Running balance (wei) before this movement. */
    balanceBeforeWei: string | null;
    /** Running balance (wei) after this movement. */
    balanceAfterWei: string | null;
    /** Network the movement occurred on (e.g. `ethereum`, `base`, `arbitrum`). */
    network: string;
    /** Free-form structured detail - hashed via stable (key-sorted) serialisation. */
    detail: unknown;
}
/** A stored chain row: the committed input plus its recorded links. */
export interface LedgerChainRow extends LedgerEntryInput {
    prevHash: string;
    entryHash: string;
}
/** Result of verifying a chain. */
export interface ChainVerification {
    valid: boolean;
    /** Number of rows inspected. */
    length: number;
    /** 0-based index of the first broken row, or -1 when the chain is intact. */
    brokenAtIndex: number;
    /** `seq` of the first broken row, or null when intact. */
    brokenAtSeq: number | null;
    /** Why the chain broke, or null when intact. */
    reason: string | null;
}
/**
 * Produce the canonical string that gets hashed. Field order is fixed and load-bearing - never
 * reorder it, or previously-written entries will fail verification.
 */
export declare const canonicalizeEntry: (entry: LedgerEntryInput) => string;
/**
 * Compute a row's `entryHash` from its canonical fields and the previous row's hash.
 * `entryHash = sha256(canonical(entry) ‖ SEP ‖ prevHash)`.
 */
export declare const computeEntryHash: (entry: LedgerEntryInput, prevHash: string) => string;
/** Where a windowed walk starts from. */
export interface ChainWindowOptions {
    /**
     * The hash the first row's `prevHash` must equal. Defaults to the genesis hash, which is what
     * makes a walk a whole-chain proof.
     *
     * Pass the previous page's `entryHash` to continue a walk across a page boundary, or the first
     * row's own `prevHash` to check a window's internal consistency without anchoring it.
     */
    anchorHash?: string;
}
/**
 * Verify a *window* of a user's chain. Identical to {@link verifyChain} except that the starting
 * link is caller-supplied, so a page fetched from `seq > 1` can be checked without pretending it
 * begins at genesis.
 *
 * A window anchored to anything other than the genesis hash proves the rows it holds were not
 * altered relative to each other and relative to that anchor; it proves nothing about entries
 * before the anchor. Callers must surface that distinction rather than presenting a window as a
 * whole-chain proof.
 */
export declare const verifyChainWindow: (rows: readonly LedgerChainRow[], options?: ChainWindowOptions) => ChainVerification;
/**
 * Verify a user's ledger chain. `rows` must already be scoped to a single user; they are sorted
 * by `seq` before walking. Returns the exact index/seq of the first break, so a reconcile job can
 * pinpoint tampering. An empty chain is vacuously valid.
 *
 * Detects: a missing genesis link, a broken `prevHash` link between consecutive rows, and any row
 * whose stored `entryHash` does not match a recomputation of its own committed fields.
 */
export declare const verifyChain: (rows: readonly LedgerChainRow[]) => ChainVerification;
/** Per-row outcome of {@link auditChainRows}. */
export interface LedgerRowCheck {
    /** `seq` of the row this check describes. */
    seq: number;
    /** The hash stored on the row. */
    storedHash: string;
    /** The hash recomputed here from the row's own committed fields. */
    computedHash: string;
    /** `storedHash === computedHash` - the row's contents are exactly what was hashed. */
    hashOk: boolean;
    /** The row's `prevHash` matches its predecessor's `entryHash` (or the window anchor). */
    linkOk: boolean;
    /** What this row's `prevHash` was expected to be. */
    expectedPrevHash: string;
}
/**
 * Audit every row independently and report a per-row verdict, rather than stopping at the first
 * break like {@link verifyChain} does. This is what a UI needs in order to mark exactly which
 * entries are intact and which are not - a single break index cannot express that a later row is
 * *also* self-consistent even though its link is orphaned.
 *
 * The walk always continues using each row's own `entryHash` as the next expected link, so one
 * altered row invalidates its own `hashOk` and the following row's `linkOk` without cascading a
 * false failure through the entire remainder of the chain.
 */
export declare const auditChainRows: (rows: readonly LedgerChainRow[], options?: ChainWindowOptions) => LedgerRowCheck[];
/**
 * Find on-chain outbound transactions that were never recorded in the ledger - the
 * key-compromise / breach signal. Pure set difference: any observed outbound tx hash absent from
 * the ledger's recorded tx hashes is unrecorded. Comparison is case-insensitive (tx hashes are
 * hex and casing varies across RPC providers).
 *
 * @param onChainOutbound tx hashes observed on-chain as outbound from the agent's wallet(s)
 * @param ledgerRows      the user's recorded ledger rows
 */
export declare const findUnrecordedOutbound: (onChainOutbound: readonly string[], ledgerRows: readonly Pick<LedgerChainRow, "txHash">[]) => string[];
