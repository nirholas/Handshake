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
import { estimateTokens } from './tokenCounter.js';
const DEFAULT_CONFIG = {
    keepRecentCount: 6,
    targetRatio: 0.4,
};
export class ImportanceScorer {
    config;
    constructor(config) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    /**
     * Score all messages by importance relative to the current conversation context.
     *
     * @param messages - All conversation messages
     * @param currentQuery - The latest user query (for semantic relevance)
     * @returns Scored messages sorted by position (not score)
     */
    scoreMessages(messages, currentQuery) {
        const totalMessages = messages.length;
        const queryKeywords = currentQuery ? this.extractKeywords(currentQuery) : [];
        return messages.map((message, index) => {
            let score = 0;
            // Factor 1: Recency (0-0.15)
            // Linear boost from oldest to newest - kept small so role importance dominates
            const recencyScore = totalMessages > 1 ? (index / (totalMessages - 1)) * 0.15 : 0.15;
            score += recencyScore;
            // Factor 2: Role importance (0-0.25)
            score += this.getRoleScore(message);
            // Factor 3: Semantic relevance to current query (0-0.25)
            if (queryKeywords.length > 0) {
                score += this.getSemanticScore(message, queryKeywords);
            }
            // Factor 4: Content quality signals (0-0.1)
            score += this.getContentQualityScore(message);
            // Factor 5: Pinned / bookmarked (override)
            if (message.metadata?.pinned || message.extra?.pinned) {
                score = 1.0; // Max importance - never compress
            }
            // Factor 6: System messages are always critical
            if (message.role === 'system') {
                score = 1.0;
            }
            const tokens = estimateTokens(message.content);
            return { message, score: Math.min(score, 1.0), tokens };
        });
    }
    /**
     * Given scored messages and a token budget, identify which messages
     * should be kept verbatim vs. compressed into a summary.
     *
     * @param scored - Output from scoreMessages()
     * @param tokenBudget - Maximum tokens for the final context
     * @returns Object with messages to keep and messages to compress
     */
    partitionForCompression(scored, tokenBudget) {
        const toKeep = [];
        const toCompress = [];
        // Always keep the most recent N messages
        const recentCutoff = Math.max(0, scored.length - this.config.keepRecentCount);
        // First pass: always-keep messages (recent + pinned + system)
        let usedTokens = 0;
        for (let i = 0; i < scored.length; i++) {
            const item = scored[i];
            const isRecent = i >= recentCutoff;
            const isPinned = item.score >= 1.0;
            if (isRecent || isPinned) {
                toKeep.push(item);
                usedTokens += item.tokens;
            }
        }
        // Second pass: fill remaining budget with highest-importance older messages
        const candidates = scored
            .slice(0, recentCutoff)
            .filter((item) => item.score < 1.0)
            .sort((a, b) => b.score - a.score); // highest importance first
        for (const candidate of candidates) {
            if (usedTokens + candidate.tokens <= tokenBudget) {
                toKeep.push(candidate);
                usedTokens += candidate.tokens;
            }
            else {
                toCompress.push(candidate);
            }
        }
        // Sort toKeep back to conversation order
        toKeep.sort((a, b) => scored.indexOf(a) - scored.indexOf(b));
        return { toCompress, toKeep };
    }
    /**
     * Role-based importance score.
     * User messages are highest because they contain the intent.
     */
    getRoleScore(message) {
        switch (message.role) {
            case 'user': {
                return 0.25;
            }
            case 'assistant': {
                // Short assistant messages (acknowledgments) are less important
                const content = typeof message.content === 'string' ? message.content : '';
                return content.length > 200 ? 0.2 : 0.1;
            }
            case 'tool': {
                // Successful tool results are more valuable than errors
                const isError = message.content?.includes('"error"') || message.content?.includes('"blocked"');
                return isError ? 0.05 : 0.15;
            }
            default: {
                return 0.1;
            }
        }
    }
    /**
     * Semantic relevance score based on keyword overlap with current query.
     */
    getSemanticScore(message, queryKeywords) {
        const content = typeof message.content === 'string' ? message.content : '';
        if (!content)
            return 0;
        // Sample first 500 chars of content for performance
        const contentLower = content.slice(0, 500).toLowerCase();
        let matches = 0;
        for (const keyword of queryKeywords) {
            if (contentLower.includes(keyword)) {
                matches++;
            }
        }
        // Normalize: 3+ keyword matches = max score
        return Math.min(matches / 3, 1) * 0.25;
    }
    /**
     * Content quality signals - longer, more substantive messages score higher.
     */
    getContentQualityScore(message) {
        const content = typeof message.content === 'string' ? message.content : '';
        // Messages with code blocks or structured data are higher quality
        const hasCode = content.includes('```') || content.includes('`');
        const hasStructuredData = content.includes('{') && content.includes('}');
        const isSubstantive = content.length > 100;
        let score = 0;
        if (hasCode)
            score += 0.04;
        if (hasStructuredData)
            score += 0.03;
        if (isSubstantive)
            score += 0.03;
        return score;
    }
    /**
     * Extract keywords from text for semantic matching.
     */
    extractKeywords(text) {
        return text
            .toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter((w) => w.length > 2);
    }
}
