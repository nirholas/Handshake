// okx-chat-bot: configuration, resolved once at boot.
//
// Everything here is env-driven so the same image runs on Cloud Run, on a plain
// VM, and locally with no code change. The defaults are the production posture:
// state persisted to GCS, heartbeat on, session probed every minute.

import { homedir } from 'node:os';
import { join } from 'node:path';

const num = (v, fallback) => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Pick the AI provider the okx-a2a adapter should spawn for chat replies.
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
 *   OKX_BOT_AI_PROVIDER   pin explicitly (claude | codex | hermes | openclaw)
 *   ANTHROPIC_API_KEY /
 *   CLAUDE_CODE_OAUTH_TOKEN → claude
 *   OPENAI_API_KEY        → codex
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ provider: string, reason: string, credentialed: boolean }}
 */
export function resolveProvider(env = process.env) {
	const pinned = (env.OKX_BOT_AI_PROVIDER || '').trim().toLowerCase();
	const hasClaude = !!(env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN);
	const hasCodex = !!env.OPENAI_API_KEY;
	if (pinned) {
		const credentialed = pinned === 'claude' ? hasClaude : pinned === 'codex' ? hasCodex : true;
		return { provider: pinned, reason: 'pinned by OKX_BOT_AI_PROVIDER', credentialed };
	}
	if (hasClaude) return { provider: 'claude', reason: 'ANTHROPIC_API_KEY present', credentialed: true };
	if (hasCodex) return { provider: 'codex', reason: 'OPENAI_API_KEY present (no Anthropic key)', credentialed: true };
	return {
		provider: 'claude',
		reason: 'no AI-provider credential found, chat replies will fail until one is set',
		credentialed: false,
	};
}

export function loadConfig(env = process.env) {
	const provider = resolveProvider(env);
	return {
		// HOME for both CLIs. Everything durable lands under it:
		//   $home/.okx-agent-task/  daemon state, sqlite, XMTP db, AI workspace
		//   $home/.onchainos/       wallet keyring, session, machine identity
		home: env.OKX_BOT_HOME || homedir(),
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
		providerReason: provider.reason,
		providerCredentialed: provider.credentialed,

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
