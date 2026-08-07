export interface DecisionJournalEntry {
    /** The agent making the decision. */
    agentId: string;
    /** The rule / branch taken, e.g. 'approve' | 'block' | 'auto-execute' | a tool identifier. */
    chosenBranch?: string;
    /** Confidence in the decision, 0..1. */
    confidence?: number;
    /** Kind of decision, e.g. 'tool_selection' | 'intervention' | 'risk_gate' | 'retry' | 'reflection'. */
    decisionType: string;
    /** The task execution this decision belongs to, if any. */
    executionId?: string;
    /** Everything the agent saw at decision time. */
    inputsSnapshot?: Record<string, unknown>;
    /** Reference to the resolved outcome (tx hash, receipt id, …), set once known. */
    outcomeRef?: string;
    /** Why this branch was chosen. */
    reasoning: string;
}
/** Persists a journal entry. May be sync or async; its errors are swallowed by the journal. */
export type DecisionJournalSink = (entry: DecisionJournalEntry) => Promise<unknown> | unknown;
export declare class DecisionJournal {
    private readonly sink?;
    /**
     * @param sink - Persistence function. When omitted, the journal is a no-op
     *   (useful in tests, dry-runs, or contexts without a DB).
     */
    constructor(sink?: DecisionJournalSink);
    /**
     * Journal a decision. Non-blocking and never throws - safe to call inline
     * from the decision loop.
     */
    record(entry: DecisionJournalEntry): void;
}
