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
const DEFAULT_CONFIG = {
    alwaysIncludeTools: [],
    maxTools: 12,
    minScore: 0.05,
    recencyBoost: 1.5,
};
/**
 * Common stop words to exclude from keyword matching
 */
const STOP_WORDS = new Set([
    'a',
    'an',
    'and',
    'are',
    'as',
    'at',
    'be',
    'by',
    'can',
    'do',
    'for',
    'from',
    'has',
    'have',
    'he',
    'her',
    'his',
    'how',
    'i',
    'if',
    'in',
    'is',
    'it',
    'its',
    'me',
    'my',
    'no',
    'not',
    'of',
    'on',
    'or',
    'our',
    'she',
    'so',
    'that',
    'the',
    'them',
    'then',
    'there',
    'they',
    'this',
    'to',
    'up',
    'us',
    'was',
    'we',
    'what',
    'when',
    'which',
    'who',
    'will',
    'with',
    'you',
    'your',
]);
export class ToolRelevanceScorer {
    config;
    constructor(config) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    /**
     * Score and filter tools based on relevance to the user query and conversation context.
     *
     * @param query - The latest user message / query
     * @param manifests - All available tool manifests
     * @param recentToolCalls - Identifiers of tools recently called in this conversation
     * @returns Filtered and sorted array of tool manifests
     */
    scoreTools(query, manifests, recentToolCalls = []) {
        const queryKeywords = this.extractKeywords(query);
        // If query is too short or generic, return all tools (let LLM decide)
        if (queryKeywords.length === 0) {
            return Object.values(manifests);
        }
        const recentSet = new Set(recentToolCalls);
        const scored = [];
        for (const [identifier, manifest] of Object.entries(manifests)) {
            // Always-include tools get max score
            if (this.config.alwaysIncludeTools.includes(identifier)) {
                scored.push({ manifest, score: Infinity });
                continue;
            }
            let score = this.computeRelevanceScore(queryKeywords, manifest);
            // Boost recently-used tools (they're likely still relevant to the conversation)
            if (recentSet.has(identifier)) {
                score *= this.config.recencyBoost;
            }
            scored.push({ manifest, score });
        }
        // Sort by score descending
        scored.sort((a, b) => b.score - a.score);
        // Filter by minScore and take top maxTools
        return scored
            .filter((s) => s.score >= this.config.minScore || s.score === Infinity)
            .slice(0, this.config.maxTools)
            .map((s) => s.manifest);
    }
    /**
     * Extract meaningful keywords from a text query.
     * Lowercases, removes punctuation, splits on whitespace, and filters stop words.
     */
    extractKeywords(text) {
        return text
            .toLowerCase()
            .replace(/[^\w\s-]/g, ' ')
            .split(/\s+/)
            .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
    }
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
    computeRelevanceScore(queryKeywords, manifest) {
        const identifierTokens = this.extractKeywords(manifest.identifier || '');
        const descriptionTokens = this.extractKeywords(manifest.description || '');
        // Collect API-level tokens
        const apiNameTokens = [];
        const apiDescTokens = [];
        for (const api of manifest.api || []) {
            apiNameTokens.push(...this.extractKeywords(api.name || ''));
            apiDescTokens.push(...this.extractKeywords(api.description || ''));
        }
        // System role is large - sample first 500 chars for keyword matching to keep it fast
        const systemRoleTokens = this.extractKeywords((manifest.systemRole || '').slice(0, 500));
        let score = 0;
        for (const keyword of queryKeywords) {
            // Exact match in identifier (highest signal)
            if (identifierTokens.some((t) => t.includes(keyword) || keyword.includes(t))) {
                score += 3.0;
            }
            // Match in tool description
            if (descriptionTokens.some((t) => t.includes(keyword) || keyword.includes(t))) {
                score += 2.0;
            }
            // Match in API names
            if (apiNameTokens.some((t) => t.includes(keyword) || keyword.includes(t))) {
                score += 2.0;
            }
            // Match in API descriptions
            if (apiDescTokens.some((t) => t.includes(keyword) || keyword.includes(t))) {
                score += 1.0;
            }
            // Match in system role (broad catch)
            if (systemRoleTokens.some((t) => t.includes(keyword) || keyword.includes(t))) {
                score += 0.5;
            }
        }
        // Normalize by query length to avoid bias toward long queries
        return queryKeywords.length > 0 ? score / queryKeywords.length : 0;
    }
}
