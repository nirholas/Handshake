// Normalizes the assorted error shapes the Mobile Wallet Adapter (MWA) stack
// throws into a single, stable contract the rest of three.ws already speaks:
// Phantom-style `err.code === 4001` for a user decline, plus a machine-readable
// `reason` slug and a human `userMessage` for the UI.
//
// Why not `instanceof` the protocol's error classes? Importing
// @solana-mobile/mobile-wallet-adapter-protocol just to classify an error would
// pull the whole transport into every bundle that touches the wallet. The MWA
// numeric protocol codes and string adapter codes are a stable wire contract
// (see SolanaMobileWalletAdapterProtocolErrorCode / …AdapterErrorCode), so we
// match on the values directly and keep the happy path dependency-free.

// Protocol-level codes (numeric `err.code`) that mean "the user said no".
//   ERROR_AUTHORIZATION_FAILED = -1  (declined the authorize/sign-in sheet)
//   ERROR_NOT_SIGNED           = -3  (declined a sign request)
const USER_DECLINE_PROTOCOL_CODES = new Set([-1, -3]);

// Adapter-level codes (string `err.code`) that mean the same.
const USER_DECLINE_ADAPTER_CODES = new Set([
	'ERROR_ASSOCIATION_CANCELLED', // backed out before the wallet opened
]);

// Adapter codes that map to a distinct, actionable reason.
const ADAPTER_REASON = new Map([
	['ERROR_WALLET_NOT_FOUND', 'WALLET_NOT_FOUND'],
	['ERROR_BROWSER_NOT_SUPPORTED', 'BROWSER_NOT_SUPPORTED'],
	['ERROR_SECURE_CONTEXT_REQUIRED', 'SECURE_CONTEXT_REQUIRED'],
	['ERROR_SESSION_TIMEOUT', 'SESSION_TIMEOUT'],
	['ERROR_SESSION_CLOSED', 'SESSION_TIMEOUT'],
	['ERROR_INVALID_PROTOCOL_VERSION', 'PROTOCOL_MISMATCH'],
]);

const USER_MESSAGES = Object.freeze({
	USER_REJECTED: 'You declined the request in your wallet.',
	WALLET_NOT_FOUND: 'No Seed Vault wallet responded. Open your wallet app and try again.',
	BROWSER_NOT_SUPPORTED: 'This browser cannot reach the Seed Vault. Use the three.ws app on your Seeker.',
	SECURE_CONTEXT_REQUIRED: 'Wallet signing requires a secure (https) connection.',
	SESSION_TIMEOUT: 'The wallet connection timed out. Try again.',
	PROTOCOL_MISMATCH: 'Your wallet app is out of date. Update it and try again.',
	INVALID_REQUEST: 'The wallet rejected the request as malformed.',
	UNKNOWN: 'Wallet signing failed. Try again.',
});

/**
 * A normalized Mobile Wallet Adapter error. `code === 4001` for user declines
 * so existing `err?.code === 4001` call sites (play-auth, the Solana adapter)
 * treat a Seed Vault cancel exactly like a Phantom cancel.
 */
export class MwaError extends Error {
	/**
	 * @param {string} reason  stable slug (USER_REJECTED, WALLET_NOT_FOUND, …)
	 * @param {unknown} [cause] the original error
	 */
	constructor(reason, cause) {
		const userMessage = USER_MESSAGES[reason] || USER_MESSAGES.UNKNOWN;
		super(userMessage);
		this.name = 'MwaError';
		this.reason = reason;
		this.userMessage = userMessage;
		if (reason === 'USER_REJECTED') this.code = 4001;
		if (cause !== undefined) this.cause = cause;
	}
}

function looksLikeUserDecline(err) {
	const code = err?.code;
	if (typeof code === 'number' && USER_DECLINE_PROTOCOL_CODES.has(code)) return true;
	if (typeof code === 'string' && USER_DECLINE_ADAPTER_CODES.has(code)) return true;
	if (code === 4001) return true; // already Phantom-shaped
	const msg = String(err?.message || '');
	return /\b(reject|declin|cancel|denied|dismiss)/i.test(msg);
}

/**
 * Map any MWA / transport error onto a stable MwaError. Idempotent — passing an
 * already-normalized MwaError returns it unchanged.
 *
 * @param {unknown} err
 * @returns {MwaError}
 */
export function normalizeMwaError(err) {
	if (err instanceof MwaError) return err;

	if (looksLikeUserDecline(err)) return new MwaError('USER_REJECTED', err);

	const code = err?.code;
	if (typeof code === 'string' && ADAPTER_REASON.has(code)) {
		return new MwaError(ADAPTER_REASON.get(code), err);
	}
	// Protocol payload errors (ERROR_INVALID_PAYLOADS = -2, TOO_MANY = -5).
	if (code === -2 || code === -5) return new MwaError('INVALID_REQUEST', err);

	return new MwaError('UNKNOWN', err);
}

/**
 * True when the error represents the user actively declining (as opposed to a
 * transport or configuration failure). Lets callers distinguish "user said no"
 * (don't retry, don't alarm) from a real fault.
 * @param {unknown} err
 */
export function isUserRejection(err) {
	if (err instanceof MwaError) return err.reason === 'USER_REJECTED';
	return looksLikeUserDecline(err);
}
