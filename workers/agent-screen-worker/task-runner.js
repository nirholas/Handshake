/**
 * Task runner for agent-screen-worker.
 *
 * Two modes:
 *   1. Queued tasks — user sends a task from /agent-screen?agentId=X via the
 *      platform UI.  The worker polls GET /api/agent-task, receives the task,
 *      and executes it with Stagehand.
 *
 *   2. Autonomous loop — when no queued task is waiting, the worker falls back
 *      to a neutral idle mission: it sits on the agent's three.ws home presence
 *      and narrates that it is standing by for a task. The idle loop is
 *      deliberately content-agnostic — it never surfaces, scans, ranks, or
 *      narrates third-party tokens or markets. All real work is user-directed
 *      via the queued-task path.
 *
 * Callers: index.js passes { page, context, cfg, push } and runs this forever.
 * push() signature: ({ agentId, page, activity, type }) → Promise<void>
 */

import { z } from 'zod';

const TASK_POLL_MS = 3_000; // how often to check for a user-queued task

// ── main export ───────────────────────────────────────────────────────────────

export async function runTask({ page, cfg, push }) {
	const { agentId, CYCLE_MS } = cfg;

	while (true) {
		// ── Check platform for a queued task first ────────────────────────────
		const queued = await pollForTask(cfg);
		if (queued) {
			await runQueuedTask({ page, cfg, push, task: queued });
			continue; // check for more queued tasks immediately after
		}

		// ── No queued task — run autonomous cycle ─────────────────────────────
		await runAutonomousCycle({ page, cfg, push });
		await sleep(CYCLE_MS);
	}
}

// ── Platform task execution ────────────────────────────────────────────────────

async function pollForTask(cfg) {
	try {
		const url = `${cfg.TASK_URL}?agentId=${encodeURIComponent(cfg.AGENT_ID)}`;
		const res = await fetch(url, {
			headers: { authorization: `Bearer ${cfg.AGENT_JWT}` },
			signal: AbortSignal.timeout(8_000),
		});
		if (!res.ok) return null;
		const j = await res.json();
		return j.task || null; // { text, type, ts }
	} catch {
		return null; // silent — never block the main loop on a network error
	}
}

async function runQueuedTask({ page, cfg, push, task }) {
	const { agentId } = cfg;
	const { text, type: taskType } = task;

	console.log(`[task-runner] executing queued task (${taskType}): ${text}`);

	await push({ agentId, page: null, activity: `Starting task: ${text}`, type: 'analysis' });

	// Navigate to a sensible starting point based on task type
	const startUrl = pickStartUrl(text, taskType);
	try {
		await push({ agentId, page, activity: `Navigating to ${new URL(startUrl).hostname}…`, type: 'activity' });
		await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
		await push({ agentId, page, activity: `Page loaded — beginning task`, type: 'screenshot' });
	} catch (err) {
		await push({ agentId, page: null, activity: `Navigation error: ${err.message}`, type: 'activity' });
	}

	// Execute the task using Stagehand's act() and extract() — natural-language browser control
	const steps = breakTaskIntoSteps(text, taskType);
	for (const step of steps) {
		try {
			await push({ agentId, page: null, activity: step.narration, type: 'analysis' });

			if (step.action === 'act') {
				await page.act({ action: step.instruction });
				await push({ agentId, page, activity: step.narration, type: 'screenshot' });
			} else if (step.action === 'extract') {
				const ResultSchema = z.object({ result: z.string() });
				const extracted = await page.extract({
					instruction: step.instruction,
					schema: ResultSchema,
				});
				if (extracted?.result) {
					await push({
						agentId,
						page,
						activity: `Found: ${extracted.result.slice(0, 240)}`,
						type: 'analysis',
					});
				}
			} else if (step.action === 'observe') {
				await push({ agentId, page, activity: step.narration, type: 'screenshot' });
			}
		} catch (err) {
			await push({ agentId, page: null, activity: `Step failed: ${err.message}`, type: 'activity' });
		}

		await sleep(TASK_POLL_MS);
	}

	await push({ agentId, page, activity: `Task complete: ${text.slice(0, 120)}`, type: 'analysis' });
}

function pickStartUrl(taskText, taskType) {
	const t = taskText.toLowerCase();
	if (t.includes('flight') || t.includes('travel') || t.includes('fly')) {
		return 'https://www.google.com/travel/flights';
	}
	if (t.includes('reddit')) return 'https://www.reddit.com';
	if (t.includes('youtube')) return 'https://www.youtube.com';
	if (t.includes('amazon') || t.includes('buy') || t.includes('shop') || t.includes('price')) {
		return 'https://www.amazon.com';
	}
	if (t.includes('news') || t.includes('latest') || t.includes('today')) {
		return 'https://news.ycombinator.com';
	}
	if (t.includes('stock') || t.includes('market') || t.includes('nasdaq') || t.includes('nyse')) {
		return 'https://finance.yahoo.com';
	}
	if (t.includes('weather')) return 'https://weather.com';
	if (t.includes('recipe') || t.includes('cook') || t.includes('food')) {
		return 'https://www.allrecipes.com';
	}
	return `https://www.google.com/search?q=${encodeURIComponent(taskText)}`;
}

function breakTaskIntoSteps(taskText, taskType) {
	if (taskType === 'research' || taskType === 'general') {
		return [
			{ action: 'observe', narration: `Scanning the page for relevant information`, instruction: taskText },
			{
				action: 'extract',
				narration: 'Extracting key findings',
				instruction: `Extract the most relevant information for this task: "${taskText}". Summarize in 2–3 sentences.`,
			},
		];
	}

	return [
		{ action: 'observe', narration: `Looking for: ${taskText}`, instruction: taskText },
		{
			action: 'act',
			narration: 'Interacting with the page',
			instruction: taskText,
		},
		{
			action: 'extract',
			narration: 'Collecting results',
			instruction: `Based on the task "${taskText}", summarize what was found on this page.`,
		},
	];
}

// ── Autonomous idle cycle ─────────────────────────────────────────────────────
//
// Default behaviour when no user task is queued. Intentionally neutral: the
// agent rests on its three.ws home presence and signals that it is standing by.
// It performs NO market/token discovery and narrates NO third-party assets —
// every real action is user-directed through the queued-task path above.

async function runAutonomousCycle({ page, cfg, push }) {
	const { agentId, HOME_URL } = cfg;

	try {
		// Only (re)navigate home if we've drifted away during a prior task, so the
		// idle loop doesn't reload every cycle and burn bandwidth.
		const onHome = (() => {
			try { return new URL(page.url()).origin === new URL(HOME_URL).origin; }
			catch { return false; }
		})();

		if (!onHome) {
			await push({ agentId, page, activity: 'Returning to three.ws home', type: 'activity' });
			await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
		}

		await push({
			agentId,
			page,
			activity: 'Standing by — send a task to put this agent to work',
			type: 'screenshot',
		});
	} catch (err) {
		console.error('[task] idle cycle error:', err);
		await push({ agentId, page: null, activity: `Error: ${err.message}`, type: 'activity' });
		await sleep(5_000);
	}
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
