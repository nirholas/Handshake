/**
 * Receipt Service - pure computation for execution receipts.
 *
 * Handles hashing of inputs/outputs and building the receipt payload
 * that will be signed and stored by the server-side tRPC procedure.
 *
 * No DB access or private key operations here - those happen server-side.
 */
/** Canonical on-chain actions - any tool result containing these indicates on-chain activity */
const ON_CHAIN_ACTION_TOOLS = new Set([
    'sendPayment',
    'executeSwap',
    'executeStrategy',
    'sendA2APayment',
    'approveToken',
    'bridgeAsset',
    'depositToProtocol',
    'withdrawFromProtocol',
]);
/**
 * Detect whether a set of tool calls produced an on-chain action.
 */
export function detectActionType(toolCalls) {
    for (const tc of toolCalls) {
        if (tc.toolName === 'sendPayment' || tc.toolName === 'sendA2APayment')
            return 'transfer';
        if (tc.toolName === 'executeSwap')
            return 'swap';
        if (tc.toolName === 'executeStrategy')
            return 'strategy';
        if (tc.toolName === 'approveToken')
            return 'approval';
        if (ON_CHAIN_ACTION_TOOLS.has(tc.toolName))
            return 'other';
    }
    return null;
}
async function sha256Hex(data) {
    const buf = new TextEncoder().encode(data);
    const hashBuf = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hashBuf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}
/**
 * SHA-256 of the combined user prompt and agent system prompt snapshot.
 */
export async function hashInput(userPrompt, systemPrompt) {
    return sha256Hex(userPrompt + '\x00' + systemPrompt);
}
/**
 * SHA-256 of the final AI response text.
 */
export async function hashOutput(responseText) {
    return sha256Hex(responseText);
}
/**
 * Build the receipt hash that the agent wallet will sign.
 *
 * Message: id + inputHash + outputHash + onChainTxHash (or empty string)
 * This is the same message that viem's recoverMessageAddress() can verify.
 */
export function buildReceiptMessage(receiptId, inputHash, outputHash, onChainTxHash) {
    return `${receiptId}:${inputHash}:${outputHash}:${onChainTxHash ?? ''}`;
}
