/**
 * Options for token counting and compression threshold calculation
 */
export interface TokenCountOptions {
    /** Model's max context window token count */
    maxWindowToken?: number;
    /** Threshold ratio for triggering compression, default 0.75 */
    thresholdRatio?: number;
}
/** Default max context window (128k tokens) */
export declare const DEFAULT_MAX_CONTEXT = 128000;
/** Default threshold ratio (50% of max context) */
export declare const DEFAULT_THRESHOLD_RATIO = 0.5;
/**
 * Message interface for token counting
 */
export interface TokenCountMessage {
    content?: string | unknown;
    metadata?: {
        usage?: {
            totalOutputTokens?: number;
        };
    } | null;
    role: string;
}
/**
 * Estimate token count for text content using tokenx
 * @param content - Text content or object to estimate tokens for
 * @returns Estimated token count
 */
export declare function estimateTokens(content: string | unknown): number;
/**
 * Calculate total token count for a list of messages
 * - Assistant messages: Use metadata.usage.totalOutputTokens if available (exact value)
 * - User/System messages: Use tokenx estimation
 *
 * @param messages - List of messages to count tokens for
 * @returns Total token count
 */
export declare function calculateMessageTokens(messages: TokenCountMessage[]): number;
/**
 * Calculate the compression threshold based on max context window
 * @param options - Token count options
 * @returns Compression threshold in tokens
 */
export declare function getCompressionThreshold(options?: TokenCountOptions): number;
/**
 * Result of compression check
 */
export interface CompressionCheckResult {
    /** Current total token count */
    currentTokenCount: number;
    /** Whether compression is needed */
    needsCompression: boolean;
    /** Compression threshold */
    threshold: number;
}
/**
 * Check if messages need compression based on token count
 * @param messages - List of messages to check
 * @param options - Token count options
 * @returns Compression check result
 */
export declare function shouldCompress(messages: TokenCountMessage[], options?: TokenCountOptions): CompressionCheckResult;
