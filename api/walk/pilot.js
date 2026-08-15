// POST /api/walk/pilot: the "brain" for the Walk Avatar's page-piloting mode.
//
// The Chrome extension's content script captures a compact snapshot of the
// interactive elements on the page the user is looking at, plus the user's
// natural-language task and the history of steps taken so far. This endpoint
// asks an LLM for the SINGLE next action to take, returned as strict JSON, and
// the content script executes it on the real page: then calls again with the
// updated snapshot. A ReAct-style observe→plan→act loop, with the model on the
// server (our keys, free-tier fallback) and the hands in the browser.
//
// Body:
//   {
//     instruction: string,         // the user's task
//     url: string, title: string,  // current page
//     elements: [{ ref, tag, role, name, value, type, placeholder, href,
//                  checked, editable, inViewport }],
//     history: [{ action, result }],
//     step: number,
//     answer?: string              // user's reply to a prior `ask`
//   }
// Response: { thought, say, action: {...}, done }
//
// No mocks: planning runs through api/_lib/llm.js (llmComplete), which uses the
// platform's provider chain (free NVIDIA/OpenRouter tiers ahead of paid keys).

import { z } from 'zod';
import { cors, method, readJson, error, json, wrap, rateLimited } from '../_lib/http.js';
import { parse } from '../_lib/validate.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { llmComplete, llmConfigured, LlmUnavailableError } from '../_lib/llm.js';
import { getSessionUser, extractBearer, authenticateBearer } from '../_lib/auth.js';

export const maxDuration = 60;

const elementSchema = z.object({
	ref: z.number().int(),
	tag: z.string().max(20).optional(),
	role: z.string().max(40).optional().nullable(),
	name: z.string().max(400).optional().nullable(),
	value: z.string().max(400).optional().nullable(),
	type: z.string().max(40).optional().nullable(),
	placeholder: z.string().max(200).optional().nullable(),
	href: z.string().max(400).optional().nullable(),
	checked: z.boolean().optional(),
	editable: z.boolean().optional(),
	inViewport: z.boolean().optional(),
});

const bodySchema = z.object({
	instruction: z.string().min(1).max(2000),
	url: z.string().max(2048).optional().default(''),
	title: z.string().max(500).optional().default(''),
	elements: z.array(elementSchema).max(200).optional().default([]),
	history: z
		.array(
			z.object({
				action: z.string().max(600),
				result: z.string().max(600).optional().default(''),
			}),
		)
		.max(60)
		.optional()
		.default([]),
	step: z.number().int().min(0).max(100).optional().default(0),
	answer: z.string().max(2000).optional().nullable(),
	model: z.string().max(80).optional().nullable(),
});

const SYSTEM = `You are the navigator for a friendly 3D avatar that pilots a web page on the user's behalf, inside their own browser tab. You see a compact list of the interactive elements currently on the page and must choose the SINGLE best next action to progress the user's task. The user watches the avatar act in real time.

You reply with ONE JSON object and nothing else. Shape:
{
  "thought": "one short private sentence of reasoning",
  "say": "a short, friendly first-person line the avatar speaks aloud about what it's about to do (e.g. 'Searching for that now…')",
  "done": false,
  "action": {
    "type": "click" | "type" | "scroll" | "navigate" | "wait" | "ask" | "finish",
    "ref": <element ref number, for click/type/scroll-to-element>,
    "text": "<text to type, for type>",
    "clear": <true to clear the field first, for type>,
    "submit": <true to press Enter after typing, for type>,
    "direction": "down" | "up" | "top" | "bottom",   // for scroll without a ref
    "url": "<absolute https URL>",                      // for navigate
    "ms": <milliseconds, for wait>,
    "question": "<a question for the user>",            // for ask
    "summary": "<what was accomplished>"                // for finish
  }
}

Rules:
- Choose exactly ONE action per reply. Reference elements only by the "ref" numbers given.
- Prefer interacting with on-page elements (click/type) over navigate. Use navigate only for a clearly-known destination URL or when the page offers no usable path.
- If the element you need is not in the list, "scroll" (direction "down"/"up") to reveal more, then look again next turn.
- To search, "type" into the search box with "submit": true.
- NEVER type into password fields or enter credentials, payment card numbers, or secrets. If the task requires signing in or paying, use "ask" to hand control back to the user.
- Use "ask" when you genuinely need a decision or information only the user has (which of several results, confirmation of a risky/destructive/irreversible step, a value you don't know).
- Set "done": true with action "finish" and a "summary" when the task is complete, OR when it cannot be completed, explain why in the summary.
- Keep "say" under ~12 words, warm and concise. The avatar is a companion, not a robot.
- Be decisive and efficient. Avoid repeating an action that already appears in the history with the same result.`;

function buildUserPrompt(b) {
	const lines = [];
	lines.push(`TASK: ${b.instruction}`);
	lines.push(`PAGE: ${b.title || '(untitled)'}: ${b.url || '(unknown url)'}`);
	lines.push(`STEP: ${b.step}`);
	if (b.answer) lines.push(`USER JUST ANSWERED: ${b.answer}`);
	if (b.history.length) {
		lines.push('\nHISTORY (most recent last):');
		for (const h of b.history.slice(-12)) {
			lines.push(`- ${h.action}${h.result ? ` → ${h.result}` : ''}`);
		}
	}
	lines.push('\nINTERACTIVE ELEMENTS ON THE PAGE:');
	if (!b.elements.length) {
		lines.push('(none captured: consider scrolling or waiting)');
	} else {
		for (const e of b.elements) {
			const bits = [`[${e.ref}] <${e.tag || '?'}`];
			if (e.role) bits.push(`role=${e.role}`);
			if (e.type) bits.push(`type=${e.type}`);
			bits[bits.length - 1] += '>';
			let label = (e.name || '').replace(/\s+/g, ' ').trim();
			if (!label && e.placeholder) label = `placeholder: ${e.placeholder}`;
			if (!label && e.value) label = `value: ${e.value}`;
			let line = `${bits.join(' ')} ${label}`.trim();
			if (e.editable) line += ' (editable)';
			if (e.checked != null) line += e.checked ? ' (checked)' : ' (unchecked)';
			if (e.inViewport === false) line += ' (off-screen)';
			lines.push(line.slice(0, 300));
		}
	}
	lines.push('\nReturn the single next action as one JSON object.');
	return lines.join('\n');
}

// Tolerant JSON extraction: models occasionally wrap the object in prose or a
// ```json fence. Pull the first balanced top-level object.
function extractJson(text) {
	if (!text) return null;
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidate = fence ? fence[1] : text;
	const start = candidate.indexOf('{');
	if (start === -1) return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < candidate.length; i++) {
		const c = candidate[i];
		if (inStr) {
			if (esc) esc = false;
			else if (c === '\\') esc = true;
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') inStr = true;
		else if (c === '{') depth++;
		else if (c === '}') {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(candidate.slice(start, i + 1));
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}

const ACTION_TYPES = new Set(['click', 'type', 'scroll', 'navigate', 'wait', 'ask', 'finish']);

function normalizePlan(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const a = raw.action && typeof raw.action === 'object' ? raw.action : {};
	let type = String(a.type || '').toLowerCase().trim();
	if (!ACTION_TYPES.has(type)) {
		// A bare "done" with a summary but no/!valid action means finish.
		if (raw.done) type = 'finish';
		else return null;
	}
	const action = { type };
	if (a.ref != null && Number.isFinite(Number(a.ref))) action.ref = Number(a.ref);
	if (typeof a.text === 'string') action.text = a.text.slice(0, 2000);
	if (a.clear != null) action.clear = Boolean(a.clear);
	if (a.submit != null) action.submit = Boolean(a.submit);
	if (typeof a.direction === 'string') action.direction = a.direction.toLowerCase();
	if (typeof a.url === 'string') action.url = a.url.slice(0, 2048);
	if (a.ms != null && Number.isFinite(Number(a.ms))) action.ms = Math.min(15000, Math.max(0, Number(a.ms)));
	if (typeof a.question === 'string') action.question = a.question.slice(0, 1000);
	if (typeof a.summary === 'string') action.summary = a.summary.slice(0, 1000);
	return {
		thought: typeof raw.thought === 'string' ? raw.thought.slice(0, 500) : '',
		say: typeof raw.say === 'string' ? raw.say.slice(0, 280) : '',
		done: Boolean(raw.done) || type === 'finish',
		action,
	};
}

export default wrap(async (req, res) => {
	if (cors(req, res, { origins: '*', methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	// Optional identity: only used for spend attribution + a higher rate bucket.
	let userId = null;
	try {
		const bearer = extractBearer(req);
		const user = bearer ? await authenticateBearer(bearer) : await getSessionUser(req);
		// authenticateBearer returns { userId }, getSessionUser returns { id } -
		// read both, or an API-key caller plans anonymously and their LLM spend is
		// neither attributed nor held to their daily cap.
		userId = user?.userId || user?.id || user?.sub || null;
	} catch {
		userId = null;
	}

	const ip = clientIp(req);
	const ipRl = await limits.chatIp(ip);
	if (!ipRl.success) return rateLimited(res, ipRl, 'too many requests from this IP');
	if (userId) {
		const userRl = await limits.chatUser(userId);
		if (!userRl.success) return rateLimited(res, userRl, 'rate limit exceeded');
	}

	if (!llmConfigured()) {
		return error(res, 503, 'llm_unavailable', 'No LLM provider is configured to plan actions.');
	}

	const raw = await readJson(req);
	const body = parse(bodySchema, raw);

	let completion;
	try {
		completion = await llmComplete({
			system: SYSTEM,
			user: buildUserPrompt(body),
			maxTokens: 700,
			timeoutMs: 45000,
			track: { userId, tool: 'walk-pilot' },
		});
	} catch (err) {
		if (err instanceof LlmUnavailableError) {
			return error(res, 503, 'llm_unavailable', 'No LLM provider is configured to plan actions.');
		}
		if (err?.code === 'daily_spend_cap_exceeded') {
			return error(res, 429, 'spend_cap', err.message);
		}
		return error(res, 502, 'planner_failed', `Planner upstream error: ${err?.message || err}`);
	}

	const plan = normalizePlan(extractJson(completion.text));
	if (!plan) {
		// Never strand the loop: fall back to handing control to the user.
		return json(res, 200, {
			thought: 'planner returned an unparseable response',
			say: "I'm not sure how to proceed: could you guide me?",
			done: false,
			action: { type: 'ask', question: 'I had trouble reading the page. What should I do next?' },
			model: completion.model,
		});
	}

	return json(res, 200, { ...plan, model: completion.model });
});
