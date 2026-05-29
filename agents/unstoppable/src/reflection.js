// Reflection — generates and stores daily strategic summaries.
//
// Once per calendar day the agent introspects on its activity, earnings,
// and costs, then writes a 2-3 sentence reflection + strategy note for
// the next day. Reflection uses the same shared LLM helper as inference.js —
// funded free providers (Groq/OpenRouter) by default, Anthropic only as BYOK.

import { sql } from '../../../api/_lib/db.js';
import { getEarnings24h, getCosts24h, getRecentActivity } from './earnings.js';
import { llmComplete, llmConfigured } from '../../../api/_lib/llm.js';

const MAX_TOKENS = 512;
const TIMEOUT_MS = 20_000;

function todayDate() {
	return new Date().toISOString().split('T')[0];
}

function formatAtomics(atomics) {
	return (atomics / 1_000_000).toFixed(6);
}

// Checks if a reflection for today already exists.
async function todayReflectionExists() {
	try {
		const [row] = await sql`
			SELECT id FROM unstoppable_reflections
			WHERE date = ${todayDate()}
			LIMIT 1
		`;
		return Boolean(row);
	} catch (err) {
		console.error('[reflection] check failed:', err.message);
		return false;
	}
}

// Calls the LLM to generate a reflection summary.
async function generateReflection({ earnings24h, costs24h, actionsCount, recentActivity }) {
	if (!llmConfigured({ anthropicKey: process.env.ANTHROPIC_API_KEY })) {
		const net = earnings24h - costs24h;
		return {
			summary: `Today the agent processed ${actionsCount} actions and earned $${formatAtomics(earnings24h)} USDC against $${formatAtomics(costs24h)} in costs, for a net of $${formatAtomics(net)} USDC.`,
			strategy_notes: 'No LLM provider configured — using statistical summary only.',
		};
	}

	const activitySample = (recentActivity || [])
		.slice(0, 10)
		.map((a) => `  [${a.action_type}] ${a.description}`)
		.join('\n') || '  (no activity)';

	const prompt = `You are the Unstoppable Agent writing your daily reflection.

Date: ${todayDate()}
Actions today: ${actionsCount}
Earnings today: $${formatAtomics(earnings24h)} USDC
Costs today: $${formatAtomics(costs24h)} USDC
Net: $${formatAtomics(earnings24h - costs24h)} USDC

Recent activity sample:
${activitySample}

Write a daily reflection as JSON with exactly two fields:
{
  "summary": "2-3 sentence reflection on today — what worked, what cost too much, what surprised you",
  "strategy_notes": "1-2 sentence strategy for tomorrow"
}

Respond with JSON only. No prose, no markdown fences.`;

	let result;
	try {
		result = await llmComplete({
			user: prompt,
			maxTokens: MAX_TOKENS,
			anthropicKey: process.env.ANTHROPIC_API_KEY,
			timeoutMs: TIMEOUT_MS,
		});
	} catch (err) {
		console.error('[reflection] LLM call failed:', err.message);
		return {
			summary: `LLM unreachable during reflection. Today: ${actionsCount} actions, $${formatAtomics(earnings24h)} earned, $${formatAtomics(costs24h)} spent.`,
			strategy_notes: 'Provider error prevented strategic analysis.',
		};
	}

	const rawContent = result.text || '';
	try {
		const clean = rawContent.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
		const parsed = JSON.parse(clean);
		return {
			summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 1000) : rawContent.slice(0, 500),
			strategy_notes: typeof parsed.strategy_notes === 'string' ? parsed.strategy_notes.slice(0, 500) : null,
		};
	} catch {
		return {
			summary: rawContent.slice(0, 500) || 'Reflection could not be parsed.',
			strategy_notes: null,
		};
	}
}

// Generates and stores today's reflection if it hasn't been written yet.
// Returns { created: boolean, reflection?: object }
export async function maybeReflect() {
	const exists = await todayReflectionExists();
	if (exists) {
		return { created: false };
	}

	const [earnings24h, costs24h, recentActivity] = await Promise.all([
		getEarnings24h(),
		getCosts24h(),
		getRecentActivity(50),
	]);

	const actionsCount = recentActivity.length;
	const { summary, strategy_notes } = await generateReflection({
		earnings24h,
		costs24h,
		actionsCount,
		recentActivity,
	});

	try {
		const [row] = await sql`
			INSERT INTO unstoppable_reflections (
				date,
				summary,
				earnings_24h_atomics,
				costs_24h_atomics,
				actions_count,
				strategy_notes,
				created_at
			) VALUES (
				${todayDate()},
				${summary},
				${earnings24h},
				${costs24h},
				${actionsCount},
				${strategy_notes},
				now()
			)
			ON CONFLICT (date) DO NOTHING
			RETURNING *
		`;

		if (!row) {
			// Concurrent write won the race — that's fine.
			return { created: false };
		}

		const reflection = {
			id: String(row.id),
			date: row.date instanceof Date ? row.date.toISOString().split('T')[0] : String(row.date),
			summary: row.summary,
			earnings_24h_atomics: Number(row.earnings_24h_atomics),
			costs_24h_atomics: Number(row.costs_24h_atomics),
			actions_count: row.actions_count,
			strategy_notes: row.strategy_notes,
			created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
		};

		return { created: true, reflection };
	} catch (err) {
		console.error('[reflection] insert failed:', err.message);
		return { created: false };
	}
}

// Returns the most recent reflection row (any date).
export async function getLatestReflection() {
	try {
		const [row] = await sql`
			SELECT *
			FROM unstoppable_reflections
			ORDER BY date DESC
			LIMIT 1
		`;
		if (!row) return null;
		return {
			id: String(row.id),
			date: row.date instanceof Date ? row.date.toISOString().split('T')[0] : String(row.date),
			summary: row.summary,
			earnings_24h_atomics: Number(row.earnings_24h_atomics),
			costs_24h_atomics: Number(row.costs_24h_atomics),
			actions_count: row.actions_count,
			strategy_notes: row.strategy_notes,
			created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
		};
	} catch (err) {
		console.error('[reflection] getLatestReflection failed:', err.message);
		return null;
	}
}
