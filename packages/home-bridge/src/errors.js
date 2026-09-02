/**
 * Every failure the bridge surfaces carries a machine-readable `code`, because
 * the UI has to tell "your token is wrong" apart from "your house is offline"
 * and the two need completely different recovery text.
 */
export class HomeBridgeError extends Error {
	constructor(code, message, cause) {
		super(message, cause ? { cause } : undefined);
		this.name = 'HomeBridgeError';
		this.code = code;
	}
}

export const ERR = {
	/** The base URL is not a URL, or is http:// where the page is https://. */
	BAD_URL: 'bad_url',
	/** Home Assistant rejected the access token. */
	AUTH: 'auth',
	/** The instance did not answer at all: wrong host, LAN-only, or offline. */
	UNREACHABLE: 'unreachable',
	/** Connected, but the request failed (unknown service, bad entity, and so on). */
	CALL_FAILED: 'call_failed',
	/** A guarded entity was targeted without an explicit confirmation. */
	NEEDS_CONFIRMATION: 'needs_confirmation',
	/** The `mcp_server` integration is not enabled on this instance. */
	NO_MCP: 'no_mcp',
	/** A method was used before connect(), or after close(). */
	NOT_CONNECTED: 'not_connected',
};
