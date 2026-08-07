// Exit-decision types - the position shape and sentiment read consumed by the
// pure ExitDecisionEngine (`packages/agent-runtime/src/core/ExitDecisionEngine.ts`).
//
// Ported from three.ws `workers/agent-sniper/exit-logic.js`. The Solana original
// worked in lamports; three.ws is EVM-first, so entry/value/peak are `bigint`
// wei. Ratio comparisons are done in float64 internally - safe because a
// stop/take-profit threshold is a *relative* comparison, where float64 error
// (~1e-16) is far below any percentage a strategy would set.
export {};
