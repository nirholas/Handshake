// okx-chat-bot: configuration, resolved once at boot.
//
// Everything here is env-driven so the same image runs on Cloud Run, on a plain
// VM, and locally with no code change. The defaults are the production posture:
// state persisted to GCS, heartbeat on, session probed every minute.

import { existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

const num = (v, fallback) => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Pick the AI provider the okx-a2a adapter should spawn for chat replies, and
 * say which transport authenticates it.
 *
 * The adapter does NOT read a reply out of the CLI's stdout, the spawned AI
 * subsession sends the reply itself through the `okx-a2a` CLI and drives the
 * task lifecycle (accept / negotiate / deliver). So the provider must be a
 * genuinely agentic CLI with tool access, not a one-shot completion call.
 *
 * Selection is by credential, because a provider CLI with no key spawns, fails
 * to authenticate, and produces the exact symptom this worker exists to kill:
 * silence on the buyer's side.
 *
 *   OKX_BOT_AI_PROVIDER      pin explicitly (claude | codex | hermes | openclaw)
 *   CLAUDE_CODE_USE_VERTEX=1 → claude on Vertex AI, authenticated by the
 *                              runtime service account through ADC. No secret
 *                              exists to leak, rotate, or forget, and the spend
 *                              lands on the GCP credit pool the platform already
 *                              prefers, so this transport wins over every key.
 *   ANTHROPIC_API_KEY /
 *   CLAUDE_CODE_OAUTH_TOKEN  → claude on api.anthropic.com
 *   OPENAI_API_KEY           → codex
 *
 * A headless host is credentialed by env alone, but a developer host running the
 * stopgap has no key at all: its claude CLI was logged in interactively and keeps
 * the grant in ~/.claude/.credentials.json. Ignoring that file reports
 * `ai_provider_uncredentialed` on a host whose adapter demonstrably authors
 * replies, which is a false red, and a false red trains people to ignore the
 * signal that this worker exists to raise.
 *
 * `credentialed` only answers "is a credential configured". Whether that
 * credential still WORKS is a different question, and on this project both
 * answers have differed: the GCP project's Vertex access and the OpenAI key are
 * each present and each refuse to serve. probeProvider() in provider.js asks the
 * provider itself, and its verdict is what readiness is judged on.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [home] where the CLI keeps an interactive login
 * @returns {{ provider: string, transport: string, reason: string, credentialed: boolean }}
 */
export function resolveProvider(env = process.env, home = env.OKX_BOT_HOME || homedir()) {
	const pinned = (env.OKX_BOT_AI_PROVIDER || '').trim().toLowerCase();
	const onVertex =
		(env.CLAUDE_CODE_USE_VERTEX === '1' || env.CLAUDE_CODE_USE_VERTEX === 'true') &&
		!!(env.ANTHROPIC_VERTEX_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT);
	const hasClaudeKey = !!(env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN);
	const hasClaudeLogin = existsSync(join(home, '.claude', '.credentials.json'));
	const claude = onVertex
		? { transport: 'vertex', reason: 'Vertex AI, authenticated by the runtime service account (no key to rotate)' }
		: hasClaudeKey
			? { transport: 'api-key', reason: 'ANTHROPIC_API_KEY present' }
			: hasClaudeLogin
				? { transport: 'oauth-login', reason: 'claude CLI holds an interactive login' }
				: { transport: 'none', reason: 'no Anthropic credential' };
	const codex = env.OPENAI_API_KEY
		? { transport: 'api-key', reason: 'OPENAI_API_KEY present' }
		: { transport: 'none', reason: 'no OpenAI credential' };

	if (pinned) {
		const t = pinned === 'claude' ? claude : pinned === 'codex' ? codex : { transport: 'external', reason: 'provider supplies its own auth' };
		return {
			provider: pinned,
			transport: t.transport,
			reason: `pinned by OKX_BOT_AI_PROVIDER (${t.reason})`,
			credentialed: t.transport !== 'none',
		};
	}
	if (claude.transport !== 'none') {
		return { provider: 'claude', transport: claude.transport, reason: claude.reason, credentialed: true };
	}
	if (codex.transport !== 'none') {
		return { provider: 'codex', transport: codex.transport, reason: `${codex.reason} (no Anthropic credential)`, credentialed: true };
	}
	return {
		provider: 'claude',
		transport: 'none',
		reason: 'no AI-provider credential found, chat replies will fail until one is set',
		credentialed: false,
	};
}

export function resolveHost(env = process.env) {
	if (env.K_SERVICE) {
		return { label: `cloudrun:${env.K_SERVICE}${env.K_REVISION ? ` (${env.K_REVISION})` : ''}`, durable: true };
	}
	const explicit = (env.OKX_BOT_HOST_LABEL || '').trim();
	if (explicit) return { label: explicit, durable: env.OKX_BOT_HOST_DURABLE === '1' };
	if (env.CODESPACE_NAME) return { label: `codespace:${env.CODESPACE_NAME}`, durable: false };
	return { label: `local:${hostname()}`, durable: false };
}

export function loadConfig(env = process.env) {
	const home = env.OKX_BOT_HOME || homedir();
	const provider = resolveProvider(env, home);
	const host = resolveHost(env);
	return {
		// HOME for both CLIs. Everything durable lands under it:
		//   $home/.okx-agent-task/  daemon state, sqlite, XMTP db, AI workspace
		//   $home/.onchainos/       wallet keyring, session, machine identity
		home,
		port: num(env.PORT, 0),

		agentId: env.OKX_BOT_AGENT_ID || '2632',

		// The XMTP daemon binary the supervisor owns. Overridable so a host that
		// installed it under a different name (or a test that needs a spawn to
		// fail) does not have to patch the supervisor.
		daemonBin: env.OKX_BOT_DAEMON_BIN || 'okx-a2a',

		// Durable state. Cloud Run's filesystem is in-memory and dies with the
		// revision, so the tree above is tarred to GCS and restored on boot.
		// Unset bucket = ephemeral mode (local dev, or a host with a real disk).
		stateBucket: (env.OKX_BOT_STATE_BUCKET || '').trim(),
		stateObject: env.OKX_BOT_STATE_OBJECT || 'okx-chat-bot/state.tar.gz',

		provider: provider.provider,
		providerTransport: provider.transport,
		providerReason: provider.reason,
		providerCredentialed: provider.credentialed,

		// How often the provider's own API is asked whether the credential still
		// works. A configured credential is not a working one: on this project the
		// GCP billing hold and the OpenAI account both answer "denied" to a key
		// that is present and well-formed. Kept slow because it is a real call.
		providerProbeMs: num(env.OKX_BOT_PROVIDER_PROBE_MS, 15 * 60_000),

		// Where this process runs, and whether that place stays up on its own.
		// Reported on every beat so /api/healthz can tell a durable host from a
		// stopgap instead of calling both "online".
		host: host.label,
		hostDurable: host.durable,

		// Where the AI subsession's briefing and skills come from. Baked into the
		// image at /app; regenerated at boot so a redeploy always ships the live
		// catalog rather than whatever the last snapshot happened to contain.
		repoRoot: env.OKX_BOT_REPO_ROOT || '/app',

		heartbeatMs: num(env.OKX_BOT_HEARTBEAT_MS, 30_000),
		sessionProbeMs: num(env.OKX_BOT_SESSION_PROBE_MS, 60_000),
		snapshotMs: num(env.OKX_BOT_SNAPSHOT_MS, 5 * 60_000),
		// A logged-out session needs a human. Alert on the transition, then at most
		// this often while it stays out, so one OTP expiry doesn't page all night.
		alertRepeatMs: num(env.OKX_BOT_ALERT_REPEAT_MS, 6 * 60 * 60_000),
		// Restart backoff for the daemon child, capped.
		restartBaseMs: num(env.OKX_BOT_RESTART_BASE_MS, 2_000),
		restartMaxMs: num(env.OKX_BOT_RESTART_MAX_MS, 60_000),
	};
}

export function paths(cfg) {
	const agentTask = join(cfg.home, '.okx-agent-task');
	return {
		agentTask,
		onchainos: join(cfg.home, '.onchainos'),
		workspace: join(agentTask, 'workspace'),
		skills: join(agentTask, 'workspace', '.claude', 'skills'),
		logs: join(agentTask, 'logs'),
		lock: join(agentTask, 'run', 'daemon.lock'),
	};
}
