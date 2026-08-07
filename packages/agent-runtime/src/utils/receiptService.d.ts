/**
 * Receipt Service - pure computation for execution receipts.
 *
 * Handles hashing of inputs/outputs and building the receipt payload
 * that will be signed and stored by the server-side tRPC procedure.
 *
 * No DB access or private key operations here - those happen server-side.
 */
export type ReceiptActionType = 'swap' | 'transfer' | 'strategy' | 'a2a_payment' | 'approval' | 'other';
export interface ToolCallRecord {
    toolName: string;
    params: Record<string, unknown>;
    result: unknown;
}
export interface ReceiptPayload {
    agentId: string;
    topicId?: string;
    messageId?: string;
    actionType: ReceiptActionType;
    inputHash: string;
    outputHash: string;
    toolCalls: ToolCallRecord[];
    modelUsed: string;
    modelProvider: string;
    tokensUsed?: number;
    walletAddress: string;
    chainId?: number;
    onChainTxHash?: string;
}
/**
 * Detect whether a set of tool calls produced an on-chain action.
 */
export declare function detectActionType(toolCalls: ToolCallRecord[]): ReceiptActionType | null;
/**
 * SHA-256 of the combined user prompt and agent system prompt snapshot.
 */
export declare function hashInput(userPrompt: string, systemPrompt: string): Promise<string>;
/**
 * SHA-256 of the final AI response text.
 */
export declare function hashOutput(responseText: string): Promise<string>;
/**
 * Build the receipt hash that the agent wallet will sign.
 *
 * Message: id + inputHash + outputHash + onChainTxHash (or empty string)
 * This is the same message that viem's recoverMessageAddress() can verify.
 */
export declare function buildReceiptMessage(receiptId: string, inputHash: string, outputHash: string, onChainTxHash: string | null | undefined): string;
