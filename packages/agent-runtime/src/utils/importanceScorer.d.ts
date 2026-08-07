/**
 * ImportanceScorer - Progressive context compression based on message importance.
 *
 * Instead of compressing all messages at once when a token threshold is hit,
 * this scorer evaluates each message's importance and enables progressive
 * summarization of less important messages first.
 *
 * Importance factors:
 * 1. Recency - newer messages are more important
 * 2. Role - user messages > tool results > assistant continuations
 * 3. Semantic relevance - messages containing the current query's keywords
 * 4. Tool output value - successful tool results > error results
 * 5. Pinned/bookmarked - user-pinned messages always kept
 */
export interface ImportanceScoredMessage {
    /** The original message */
    message: any;
    /** Importance score (0-1, higher = more important) */
    score: number;
    /** Estimated token count for this message */
    tokens: number;
}
export interface ProgressiveCompressionConfig {
    /**
     * Number of most recent messages to always keep uncompressed.
     * Default: 6
     */
    keepRecentCount?: number;
    /**
     * Target token budget after compression.
     * Messages below importance threshold will be marked for summarization.
     * Default: 0.4 of maxWindowToken
     */
    targetRatio?: number;
}
export declare class ImportanceScorer {
    private config;
    constructor(config?: ProgressiveCompressionConfig);
    /**
     * Score all messages by importance relative to the current conversation context.
     *
     * @param messages - All conversation messages
     * @param currentQuery - The latest user query (for semantic relevance)
     * @returns Scored messages sorted by position (not score)
     */
    scoreMessages(messages: any[], currentQuery?: string): ImportanceScoredMessage[];
    /**
     * Given scored messages and a token budget, identify which messages
     * should be kept verbatim vs. compressed into a summary.
     *
     * @param scored - Output from scoreMessages()
     * @param tokenBudget - Maximum tokens for the final context
     * @returns Object with messages to keep and messages to compress
     */
    partitionForCompression(scored: ImportanceScoredMessage[], tokenBudget: number): {
        toCompress: ImportanceScoredMessage[];
        toKeep: ImportanceScoredMessage[];
    };
    /**
     * Role-based importance score.
     * User messages are highest because they contain the intent.
     */
    private getRoleScore;
    /**
     * Semantic relevance score based on keyword overlap with current query.
     */
    private getSemanticScore;
    /**
     * Content quality signals - longer, more substantive messages score higher.
     */
    private getContentQualityScore;
    /**
     * Extract keywords from text for semantic matching.
     */
    private extractKeywords;
}
