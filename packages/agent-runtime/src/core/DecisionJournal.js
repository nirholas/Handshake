/**
 * DecisionJournal - records every autonomous decision the agent makes,
 * together with the reasoning behind it.
 *
 * The journal is a thin, fire-and-forget writer. It is deliberately decoupled
 * from the database: the caller passes a `sink` that persists the entry (in
 * three.ws this wraps `AgentDecisionJournalModel.create`). This keeps
 * agent-runtime free of a DB dependency and keeps the decision loop testable.
 *
 * Guarantees:
 * - `record()` NEVER throws into the decision path - a failed or slow sink
 *   must not break the agent's reasoning loop.
 * - `record()` is non-blocking: it returns immediately and lets the sink
 *   settle in the background. Errors are logged, not propagated.
 */
import { debuglog } from 'node:util';
const log = debuglog('three-ws-agent-runtime-decision-journal');
export class DecisionJournal {
    sink;
    /**
     * @param sink - Persistence function. When omitted, the journal is a no-op
     *   (useful in tests, dry-runs, or contexts without a DB).
     */
    constructor(sink) {
        this.sink = sink;
    }
    /**
     * Journal a decision. Non-blocking and never throws - safe to call inline
     * from the decision loop.
     */
    record(entry) {
        if (!this.sink)
            return;
        try {
            const result = this.sink(entry);
            if (result && typeof result.then === 'function') {
                result.then(() => { }, (error) => {
                    log('decision journal sink rejected: %O', error);
                });
            }
        }
        catch (error) {
            // A synchronous throw from the sink must not reach the decision path.
            log('decision journal sink threw: %O', error);
        }
    }
}
