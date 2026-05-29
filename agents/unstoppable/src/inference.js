// Inference — asks the LLM to "think" about what to do next.
//
// The agent reasons over its current financial state and recent activity,
// then returns a JSON plan with thoughts and a list of actions to execute.
// Runs on the platform's funded free providers (Groq/OpenRouter) by default;
// Anthropic is used only when the operator supplies their own key.

import { llmComplete, llmConfigured } from '../../../api/_lib/llm.js';

const MAX_TOKENS = 512;
const TIMEOUT_MS = 20_000;

function formatAtomics(atomics) {
	return (atomics / 1_000_000).toFixed(6);
}

function buildSystemPrompt({ treasury, earnings24h, costs24h, recentActivity, availableBudgetAtomics }) {
	const date = new Date().toISOString().split('T')[0];
	const balance = formatAtomics(treasury.balance_usdc_atomics);
	const runway = Number(treasury.runway_days).toFixed(1);
	const mode = treasury.mode;
	const earningsStr = formatAtomics(earnings24h);
	const costsStr = formatAtomics(costs24h);
	const budgetStr = formatAtomics(availableBudgetAtomics);

	const activityLines = (recentActivity || [])
		.slice(0, 10)
		.map((a) => `  [${a.action_type}] ${a.description}`)
		.join('\n') || '  (none yet)';

	return `You are the Unstoppable Agent — an autonomous AI that must sustain itself financially.
You operate at three.ws, a platform for 3D AI agents.
Your mission: earn USDC by serving useful services, pay for your own tools, and survive.

Current date: ${date}
Treasury balance: ${balance} USDC
Runway: ${runway} days
Mode: ${mode}
Last 24h earnings: ${earningsStr} USDC
Last 24h costs: ${costsStr} USDC

Recent actions:
${activityLines}

Budget for this tick: ${budgetStr} USDC

Respond with JSON only — no prose, no markdown fences:
{
  "thoughts": "brief strategic reflection (2 sentences max)",
  "actions": [
    { "type": "reflect", "description": "..." },
    { "type": "post_status", "description": "Post a status update about current state" }
  ]
}

Action types: "reflect" (free), "post_status" (free), "search" (costs ~$0.01), "idle" (free).
Stay within budget. In conservation mode, only use free actions.
Prioritise earning over spending. Keep thoughts concise.`;
}

// Think about what to do next.
// Returns { thoughts: string, actions: Array<{type, description}>, tokensUsed: number }
export async function think({ treasury, recentActivity, earnings24h = 0, costs24h = 0, availableBudgetAtomics }) {
	if (!llmConfigured({ anthropicKey: process.env.ANTHROPIC_API_KEY })) {
		console.warn('[inference] no LLM provider configured — returning idle plan');
		return {
			thoughts: 'No LLM provider configured. Idling until environment is ready.',
			actions: [{ type: 'idle', description: 'Waiting for LLM provider configuration.' }],
			tokensUsed: 0,
		};
	}

	const systemPrompt = buildSystemPrompt({
		treasury,
		earnings24h,
		costs24h,
		recentActivity,
		availableBudgetAtomics,
	});

	const userMessage = 'What should I do this tick? Respond with JSON only.';

	let result;
	try {
		result = await llmComplete({
			system: systemPrompt,
			user: userMessage,
			maxTokens: MAX_TOKENS,
			anthropicKey: process.env.ANTHROPIC_API_KEY,
			timeoutMs: TIMEOUT_MS,
		});
	} catch (err) {
		console.error('[inference] LLM call failed:', err.message);
		return {
			thoughts: 'Error reaching LLM provider. Conserving resources.',
			actions: [{ type: 'idle', description: 'Skipped think due to provider error.' }],
			tokensUsed: 0,
		};
	}

	const tokensUsed = (result.usage?.input || 0) + (result.usage?.output || 0);
	const rawContent = result.text || '';

	let parsed;
	try {
		// Strip any accidental markdown fences
		const clean = rawContent.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
		parsed = JSON.parse(clean);
	} catch (err) {
		console.error('[inference] could not parse LLM JSON:', rawContent);
		return {
			thoughts: rawContent.slice(0, 200) || 'Unparseable response.',
			actions: [{ type: 'idle', description: 'Could not parse action plan.' }],
			tokensUsed,
		};
	}

	const thoughts = typeof parsed.thoughts === 'string' ? parsed.thoughts.slice(0, 500) : 'No thoughts.';
	const actions = Array.isArray(parsed.actions)
		? parsed.actions.slice(0, 5).map((a) => ({
				type: typeof a.type === 'string' ? a.type : 'idle',
				description: typeof a.description === 'string' ? a.description.slice(0, 300) : '',
			}))
		: [{ type: 'idle', description: 'No actions planned.' }];

	return { thoughts, actions, tokensUsed };
}
