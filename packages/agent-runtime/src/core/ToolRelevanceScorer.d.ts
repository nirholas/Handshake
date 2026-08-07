/**
 * ToolRelevanceScorer - Pre-filters tools based on semantic relevance to the user query.
 *
 * Instead of dumping all 35+ tool manifests into the LLM system prompt,
 * this scorer ranks tools by relevance and returns only the top-K most relevant ones.
 * This reduces token usage, improves tool selection accuracy, and speeds up inference.
 *
 * Strategy:
 * 1. Keyword extraction from the user query
 * 2. TF-IDF-style scoring against tool descriptions and API names
 * 3. Recency boost for recently-used tools in the conversation
 * 4. Always-include rules for tools marked as essential
 */
interface ToolManifest {
    api?: Array<{
        description?: string;
        name: string;
    }>;
    description?: string;
    humanIntervention?: unknown;
    identifier: string;
    systemRole?: string;
}
export interface ToolRelevanceScorerConfig {
    /**
     * Tools that are always included regardless of relevance score.
     * Useful for critical tools like memory, knowledge base, etc.
     */
    alwaysIncludeTools?: string[];
    /**
     * Maximum number of tools to return after scoring.
     * Default: 12
     */
    maxTools?: number;
    /**
     * Minimum relevance score (0-1) for a tool to be included.
     * Tools below this threshold are excluded even if maxTools isn't reached.
     * Default: 0.05
     */
    minScore?: number;
    /**
     * Boost multiplier for recently-used tools in the conversation.
     * Default: 1.5
     */
    recencyBoost?: number;
}
export declare class ToolRelevanceScorer {
    private config;
    constructor(config?: ToolRelevanceScorerConfig);
    /**
     * Score and filter tools based on relevance to the user query and conversation context.
     *
     * @param query - The latest user message / query
     * @param manifests - All available tool manifests
     * @param recentToolCalls - Identifiers of tools recently called in this conversation
     * @returns Filtered and sorted array of tool manifests
     */
    scoreTools(query: string, manifests: Record<string, ToolManifest>, recentToolCalls?: string[]): ToolManifest[];
    /**
     * Extract meaningful keywords from a text query.
     * Lowercases, removes punctuation, splits on whitespace, and filters stop words.
     */
    private extractKeywords;
    /**
     * Compute a relevance score for a tool manifest against query keywords.
     *
     * Scoring factors:
     * - Tool identifier match (high weight)
     * - Tool description match (medium weight)
     * - API name match (medium weight)
     * - API description match (lower weight)
     * - System role keyword match (lowest weight, but catches domain terms)
     */
    private computeRelevanceScore;
}
export {};
