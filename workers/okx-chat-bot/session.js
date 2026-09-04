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

// How long a freshly spawned daemon may go without claiming its lock before the
// silence counts as a failure. Measured boots take ~11s on this host; a cold
// container restoring a state tree first is slower, so the window is generous.
// It only delays the verdict, never the recovery: the supervisor is already
// restarting a child that truly died.
const DAEMON_BOOT_GRACE_MS = 90_000;

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
 * The exact commands that put a working AI credential on the service.
 *
 * A refused credential is the other failure only a human can clear, so it gets
 * the same treatment as an expired session: the fix travels with the status
 * rather than living in a runbook someone has to find. Vertex leads because it
 * is the only option with no secret to mint, rotate or forget, and it bills the
 * GCP credit pool the platform already prefers.
 */
export function providerInstructions(detail = '') {
	return [
		`The provider refused this host's credential: ${detail}`,
		'',
		'1. Preferred (no secret): clear the project billing hold, then',
		'   gcloud run services update okx-chat-bot --region us-central1 \\',
		"     --update-env-vars=CLAUDE_CODE_USE_VERTEX=1,ANTHROPIC_VERTEX_PROJECT_ID=aerial-vehicle-466722-p5,CLOUD_ML_REGION=global",
		'2. Or mint an Anthropic key and put it on the service through Secret Manager:',
		"   printf '%s' \"$ANTHROPIC_API_KEY\" | gcloud secrets create anthropic-api-key --data-file=-",
		'   then add ANTHROPIC_API_KEY=anthropic-api-key:latest to --set-secrets in',
		'   workers/okx-chat-bot/cloudbuild.yaml and redeploy (a hand-patched secret is',
		'   stripped by the next deploy).',
		'3. Or reactivate billing on the OpenAI account behind the openai-api-key secret',
		'   and pin OKX_BOT_AI_PROVIDER=codex.',
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
 * @param {{ code: string, detail: string }} [probe.providerProbe] what the provider's own API answered
 * @param {{ pid: number|null, uptimeMs: number }} [probe.daemonChild] supervisor.stats(), so a daemon
 *   still writing its lock is told apart from one that never came up
 * @returns {{ status: 'ok'|'degraded'|'down'|'unknown', ready: boolean, reason: string, detail: string,
 *   needsHumanLogin: boolean }}
 */
export function classify({ daemon, wallet, agents, providerCredentialed, providerProbe, daemonChild }) {
	const daemonRunning = typeof daemon === 'string' && daemon.startsWith('running');

	if (!daemonRunning) {
		// `okx-a2a daemon status` reads a lock file the daemon writes seconds after
		// it is spawned, so a healthy boot spends a window looking exactly like a
		// dead one. Calling that window `down` paged critical on every single
		// restart and then recovered a minute later, and an alert that cries wolf
		// on every deploy is an alert people learn to skip. A live child inside the
		// grace window is `unknown`: still not ready, but not yet a claim.
		if (daemonChild?.pid && daemonChild.uptimeMs < DAEMON_BOOT_GRACE_MS) {
			return {
				status: 'unknown',
				ready: false,
				reason: 'daemon_starting',
				detail: `okx-a2a was spawned ${Math.round(daemonChild.uptimeMs / 1000)}s ago and has not claimed its lock yet`,
				needsHumanLogin: false,
			};
		}
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
				'author a reply. Set CLAUDE_CODE_USE_VERTEX=1 (preferred: no key to rotate), ANTHROPIC_API_KEY, ' +
				'or OPENAI_API_KEY on the service.',
			needsHumanLogin: false,
		};
	}

	// A configured credential is not a working one. A key the provider refuses
	// looks identical from inside this process to a key that works, right up until
	// a buyer's message arrives and the subsession cannot author a reply, which is
	// the silent failure the whole worker exists to make loud.
	if (providerProbe?.code === 'unauthorized') {
		return {
			status: 'degraded',
			ready: false,
			reason: 'ai_provider_unauthorized',
			detail:
				`chat is delivered but the AI provider refuses this host's credential, so no reply can be authored: ` +
				`${providerProbe.detail}`,
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
