// okx-chat-bot: is the bot actually reachable, and if not, what does a human do?
//
// The failure this worker exists to kill is SILENT: the process stays up, the
// container is healthy, and marketplace chat is simply never delivered because
// the wallet session expired or no XMTP client came online. From the outside
// that is indistinguishable from "nobody messaged us" until OKX's own chat test
// times out at 30 minutes and flags the listing offline, which has happened.
//
// So readiness here is deliberately strict: a bot that cannot receive a message
// is NOT ready, even though the process is perfectly alive.

/** The exact commands a human runs to bring an expired session back. */
export function loginInstructions(loginUrl, authSessionId) {
	const url = loginUrl || 'run `onchainos wallet login --phase init` to mint one';
	const poll = authSessionId
		? `onchainos wallet login --phase poll --session-id ${authSessionId}`
		: 'onchainos wallet login --phase poll --session-id <authSessionId>';
	return [
		`1. Open the login URL and complete the email OTP as claude@three.ws: ${url}`,
		`2. ${poll}`,
		'3. okx-a2a agent refresh --json   (expect agentCount >= 1, activeClients >= 1)',
	];
}

/**
 * Roll the three raw probes into one verdict. Pure, so the state machine is
 * testable without a daemon, a wallet, or a network.
 *
 * @param {object} probe
 * @param {string} probe.daemon        raw `okx-a2a daemon status` line
 * @param {{ loggedIn: boolean, email?: string }|null} probe.wallet  null = CLI failed
 * @param {{ agentCount: number, activeClients: number }} probe.agents
 * @param {boolean} probe.providerCredentialed
 * @returns {{ status: 'ok'|'degraded'|'down'|'unknown', ready: boolean, reason: string, detail: string,
 *   needsHumanLogin: boolean }}
 */
export function classify({ daemon, wallet, agents, providerCredentialed }) {
	const daemonRunning = typeof daemon === 'string' && daemon.startsWith('running');

	if (!daemonRunning) {
		return {
			status: 'down',
			ready: false,
			reason: 'daemon_down',
			detail: `okx-a2a daemon is not running (${daemon || 'no status'}), no marketplace chat is delivered`,
			needsHumanLogin: false,
		};
	}

	if (wallet === null) {
		return {
			status: 'unknown',
			ready: false,
			reason: 'wallet_unreadable',
			detail: 'onchainos wallet status did not answer, session state unknown',
			needsHumanLogin: false,
		};
	}

	if (!wallet.loggedIn) {
		return {
			status: 'down',
			ready: false,
			reason: 'session_logged_out',
			detail:
				'the OKX wallet session is logged out, so every XMTP client is offline and chat is not delivered. ' +
				'Renewing it needs a human email OTP as claude@three.ws.',
			needsHumanLogin: true,
		};
	}

	if (agents.activeClients < 1) {
		return {
			status: 'degraded',
			ready: false,
			reason: 'no_active_client',
			detail:
				`logged in (${agents.agentCount} agent identities) but 0 XMTP clients are serving. ` +
				'The daemon retries every minute; if it stays at zero, read logs/listener.log.',
			needsHumanLogin: false,
		};
	}

	if (!providerCredentialed) {
		return {
			status: 'degraded',
			ready: false,
			reason: 'ai_provider_uncredentialed',
			detail:
				'chat is delivered but no AI-provider credential is configured, so the spawned subsession cannot ' +
				'author a reply. Set ANTHROPIC_API_KEY (preferred) or OPENAI_API_KEY on the service.',
			needsHumanLogin: false,
		};
	}

	return {
		status: 'ok',
		ready: true,
		reason: 'online',
		detail: `${agents.activeClients} XMTP client(s) serving ${agents.agentCount} agent identity(ies)`,
		needsHumanLogin: false,
	};
}
