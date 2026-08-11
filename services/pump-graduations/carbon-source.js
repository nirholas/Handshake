/**
 * Carbon-backed graduation source.
 * Drop-in alternative to the legacy conn.onLogs subscription in index.js.
 *
 * Interface contract:
 *   const src = new CarbonGraduationSource({ connection });
 *   src.start((ev) => { ... ev: { mint, signature, ts, marketCapUsd } });
 *   src.stop();
 *
 * The `logSubscriber` constructor option overrides the Solana subscription
 * call and is used exclusively by tests to inject a mock stream.
 *
 * Decoding is shared with the legacy source via graduation-event.js, so the
 * two can never disagree about what counts as a graduation.
 *
 * Env (inherited from parent service, no separate env needed):
 *   SOLANA_RPC_URL / SOLANA_WS_URL are consumed by index.js before this
 *   source is instantiated.
 */

import {
	PUMP_PROGRAM_ID,
	SeenSignatures,
	isCandidateEntry,
	parseCompleteEvent,
} from './graduation-event.js';

export class CarbonGraduationSource {
	/**
	 * @param {object} opts
	 * @param {import('@solana/web3.js').Connection} [opts.connection]
	 *   Solana Connection instance (used by the production path).
	 * @param {Function} [opts.logSubscriber]
	 *   Injectable log-subscription function matching Connection.onLogs's
	 *   signature: (programId, handler, commitment) => subscriptionId.
	 *   When provided, `connection` is ignored for subscribing (but may still
	 *   be used externally for enrichment).
	 */
	constructor({ connection, logSubscriber } = {}) {
		this._conn = connection;
		this._logSubscriber = logSubscriber;
		this._subId = null;
		this._seen = new SeenSignatures();
	}

	start(onGraduation) {
		const handler = (entry) => this._handle(entry, onGraduation);
		if (this._logSubscriber) {
			this._subId = this._logSubscriber(PUMP_PROGRAM_ID, handler, 'confirmed');
		} else {
			this._subId = this._conn.onLogs(PUMP_PROGRAM_ID, handler, 'confirmed');
		}
	}

	stop() {
		if (this._conn && this._subId != null) {
			this._conn.removeOnLogsListener(this._subId);
			this._subId = null;
		}
	}

	_handle(entry, onGraduation) {
		if (!isCandidateEntry(entry)) return;
		const parsed = parseCompleteEvent(entry.signature, entry.logs);
		if (!parsed) return;
		if (!this._seen.add(parsed.signature)) return;
		onGraduation({
			mint: parsed.mint,
			signature: parsed.signature,
			ts: parsed.timestamp,
			marketCapUsd: null,
		});
	}
}
