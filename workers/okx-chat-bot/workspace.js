// okx-chat-bot: the AI subsession's workspace.
//
// The okx-a2a adapter spawns the AI CLI with cwd set to
// `$HOME/.okx-agent-task/workspace`. Whatever is in that directory IS the
// subsession's world knowledge, so a naive containerisation ships an agent that
// knows nothing about three.ws and improvises answers to paying buyers.
//
// This module rebuilds the workspace on every boot, from the image rather than
// from the restored state snapshot, so a redeploy always ships the current
// catalog and the current skill set:
//
//   CLAUDE.md / AGENTS.md   the chat briefing, generated from OKX_CATALOG
//                           (both names: which one the subsession reads depends
//                            on which AI CLI the adapter spawns)
//   .claude/skills/<name>   the OKX task/chat lifecycle skills plus the 3D
//   .codex/skills/<name>    skills a buyer question lands on
//
// Skills are COPIED, not symlinked: a symlink into /app survives locally but
// points at a path the subsession may not be allowed to traverse, and a copy
// makes the workspace self-contained if the image layout ever moves.

import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildChatBriefing } from '../../api/_lib/okx-chat-briefing.js';
import { log } from './log.js';

// The A2A task/chat lifecycle, our identity and payment surfaces, and the 3D
// skills a buyer question can land on. Kept in sync with the same list in
// scripts/okx-bot-revive.mjs, which stages the identical workspace locally.
export const SKILLS = [
	'okx-agent-chat',
	'okx-agent-task',
	'okx-agent-identity',
	'okx-agent-payments-protocol',
	'okx-agentic-wallet',
	'okx-ai-guide',
	'okx-ai-support',
	'okx-task-watch',
	'create-3d-avatar',
	'generate-3d-model',
	'rig-a-model',
	'embed-three-ws-avatar',
];

/**
 * Write the briefing and stage the skills into the AI workspace.
 *
 * @param {ReturnType<import('./config.js').loadConfig>} cfg
 * @param {ReturnType<import('./config.js').paths>} p
 * @returns {Promise<{ briefingBytes: number, skills: number }>}
 */
export async function buildWorkspace(cfg, p) {
	const briefing = buildChatBriefing();
	await mkdir(p.workspace, { recursive: true });
	await writeFile(join(p.workspace, 'CLAUDE.md'), briefing);
	await writeFile(join(p.workspace, 'AGENTS.md'), briefing);

	const src = join(cfg.repoRoot, '.agents', 'skills');
	const targets = [join(p.workspace, '.claude', 'skills'), join(p.workspace, '.codex', 'skills')];
	let staged = 0;
	if (existsSync(src)) {
		for (const target of targets) {
			await mkdir(target, { recursive: true });
			for (const name of SKILLS) {
				const from = join(src, name);
				if (!existsSync(from)) continue;
				const to = join(target, name);
				await rm(to, { force: true, recursive: true });
				await cp(from, to, { recursive: true, dereference: true });
			}
		}
		staged = SKILLS.filter((n) => existsSync(join(src, n))).length;
	}

	if (staged < SKILLS.length) {
		// Not fatal: chat still answers from the briefing. But without the task
		// skills the subsession improvises on accept/negotiate/deliver envelopes
		// instead of following the protocol, so it must be loud.
		log.warn('workspace staged with missing skills', {
			staged,
			expected: SKILLS.length,
			skillsSrc: src,
		});
	}

	log.info('workspace built', { workspace: p.workspace, briefingBytes: briefing.length, skills: staged });
	return { briefingBytes: briefing.length, skills: staged };
}
