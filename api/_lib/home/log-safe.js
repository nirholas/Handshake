// The one way this lane turns an error into a log line.
//
// Application logs are a different system: a different retention window, a
// different set of readers, and no connection to the account the data belongs
// to. A home detail that reaches them has the longest tail of any leak here, and
// the most common error in the whole lane is the one that names the house:
// `toBridgeError` builds "Could not reach https://home.example.com. If it is
// only on your home network..." for every unreachable instance. Passing
// `err.message` through to a log therefore writes somebody's address into a log
// sink every time their internet wobbles.
//
// A driver error is the same problem from the other direction: Postgres echoes
// bound parameters into constraint-violation messages, and this lane binds a
// home's status detail, which is itself often a bridge error message.
//
// So nothing in the lane logs a raw message. It logs this instead: the code an
// operator can actually act on, plus a message with every URL removed and a
// hard length cap. See docs/home-privacy.md.

/** Any absolute URL, however it is embedded in a sentence. */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi;
/** A bare host:port, which is how a LAN instance is usually written. */
const HOSTPORT_RE = /\b[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{2,5})?\b/gi;
const MAX = 200;

/**
 * A log-safe description of an error.
 *
 * Returns `{ code, detail }`, never a raw message:
 *
 *   * `code` is `err.code` where the error has one (the whole `ERR` vocabulary
 *     does), else `err.name`, else `'unknown'`. This is the field worth
 *     alerting on, and it says nothing about whose house it is.
 *   * `detail` is the message with every URL and bare hostname replaced by
 *     `[host]`, truncated. Present so a genuinely unexpected failure is still
 *     diagnosable; absent when there is nothing left after redaction.
 *
 * @param {unknown} err
 * @returns {{ code: string, detail?: string }}
 */
export function safeError(err) {
	const code = String(
		(err && typeof err === 'object' && ('code' in err ? err.code : null)) ||
			(err && typeof err === 'object' && 'name' in err ? err.name : null) ||
			'unknown',
	).slice(0, 64);

	const raw = err && typeof err === 'object' && 'message' in err ? String(err.message ?? '') : String(err ?? '');
	const detail = raw.replace(URL_RE, '[host]').replace(HOSTPORT_RE, '[host]').trim().slice(0, MAX);
	return detail ? { code, detail } : { code };
}
