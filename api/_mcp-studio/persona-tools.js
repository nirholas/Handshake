// three.ws 3D Studio (free) — embodiment / persona tools.
//
// The layer that turns a generated GLB into a LIVING agent body: a named,
// persistent persona the assistant reuses turn after turn and session after
// session. Three tools:
//
//   create_agent_persona(glb_url, name)  — save a rigged GLB as a named body and
//     get back a stable persona_id + an inline living-body artifact (idles).
//   get_agent_persona(persona_id)         — bring the SAME body back in a fresh
//     session (continuity by id — no sign-in).
//   persona_say(persona_id, text)         — perform a reply: the body lip-syncs
//     the text and shows the matching expression + gesture for this turn.
//
// All FREE and unauthenticated — same posture as the generation tools. The body
// renders inline via the hosted embodiment embed (shared embodimentArtifact), so
// the SAME living body appears in ChatGPT/Claude and on the site. There is NO
// token, wallet, coin, or payment surface anywhere here — a persona is a name and
// a 3D body. (The free-studio catalog test asserts that invariant.)

import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import { limits, clientIp } from '../_lib/rate-limit.js';
import { assertSafePublicUrl } from '../_lib/ssrf-guard.js';
import { isValidGlbHeader, inspectGlb } from '../_lib/glb-inspect.js';
import {
	createPersona,
	getPersona,
	touchPersona,
	personaPublicView,
	isPersonaId,
} from '../_lib/persona-store.js';
import { expressionForText, expressionFor } from '../../src/embodiment/emotion.js';
import { embodimentArtifact, buildEmbedUrl } from '../_lib/embodiment-artifact.js';
import { PERSONA_COMPONENT_URI } from './component.js';

const MAX_GLB_BYTES = 64 * 1024 * 1024;

function toolError(message) {
	return {
		content: [{ type: 'text', text: message }],
		structuredContent: { error: true, message },
		isError: true,
	};
}

async function isPublicHttpsUrl(s) {
	try {
		await assertSafePublicUrl(String(s), { allowHttp: false });
		return true;
	} catch {
		return false;
	}
}

// Fetch a GLB into a Buffer with a hard size cap so a persona's body can be copied
// into durable storage before the provider URL expires. Returns null on any
// failure (caller surfaces a clean message).
async function fetchGlbBuffer(url) {
	try {
		const resp = await fetch(url);
		if (!resp.ok) return null;
		const declared = Number(resp.headers.get('content-length') || 0);
		if (declared && declared > MAX_GLB_BYTES) return null;
		const buf = Buffer.from(await resp.arrayBuffer());
		if (buf.length > MAX_GLB_BYTES) return null;
		return buf;
	} catch {
		return null;
	}
}

// Cheap per-IP burst cap on the two write tools; reads ride the transport cap.
async function guardWrite(req) {
	const rl = await limits.studioPersonaWrite(clientIp(req));
	return rl.success;
}

// ── handlers ──────────────────────────────────────────────────────────────────

async function handleCreatePersona(args, _auth, req) {
	if (!(await guardWrite(req))) return toolError('Too many requests — slow down and try again shortly.');
	const glbUrl = String(args.glb_url || '').trim();
	const name = String(args.name || '').trim();
	if (!name) return toolError('Provide a display name for the agent (1–80 characters).');
	if (!(await isPublicHttpsUrl(glbUrl))) return toolError('Provide a public https URL to a rigged GLB (e.g. one you generated with forge_avatar).');

	const buf = await fetchGlbBuffer(glbUrl);
	if (!buf || !isValidGlbHeader(buf)) {
		return toolError('That URL did not return a valid GLB (binary glTF). Pass a .glb model URL.');
	}
	const info = inspectGlb(buf) || {};

	let record;
	try {
		record = await createPersona({
			name,
			glbUrl,
			glbBuffer: buf,
			voice: args.voice ? String(args.voice).slice(0, 64) : null,
			sourcePrompt: args.source_prompt ? String(args.source_prompt).slice(0, 1000) : null,
			look: {
				rigged: info.isRigged ?? null,
				mesh_count: info.meshCount ?? null,
				animation_count: info.animationCount ?? null,
			},
		});
	} catch {
		return toolError('Could not save this persona right now. Please try again.');
	}
	const persona = personaPublicView(record);

	return {
		content: [
			{
				type: 'text',
				text:
					`Saved "${persona.name}" as a living persona.\n` +
					`Persona ID: ${persona.persona_id}\n` +
					(persona.look?.rigged
						? 'Rig: humanoid — full body animation + lip-sync.\n'
						: 'Rig: static/non-humanoid — falls back to a gentle idle gracefully.\n') +
					'Show the attached view to see the body. Call persona_say with this persona_id to make it ' +
					'speak a reply, or get_agent_persona to bring it back in a future session.',
			},
			embodimentArtifact({ persona, state: 'idle' }),
		],
		structuredContent: { ...persona, status: 'created', embed_url: buildEmbedUrl({ persona, state: 'idle' }) },
	};
}

async function handleGetPersona(args) {
	const id = String(args.persona_id || '').trim();
	if (!isPersonaId(id)) return toolError('That is not a valid persona id.');
	const record = await getPersona(id);
	if (!record) return toolError('No persona found for that id. Create one with create_agent_persona.');
	const persona = personaPublicView(record);
	return {
		content: [
			{
				type: 'text',
				text:
					`Welcome back, ${persona.name}.\n` +
					`Persona ID: ${persona.persona_id}\n` +
					`Turns spoken so far: ${persona.turn_count}.\n` +
					'Show the attached view to see the body; call persona_say to make it speak.',
			},
			embodimentArtifact({ persona, state: 'idle' }),
		],
		structuredContent: { ...persona, status: 'loaded', embed_url: buildEmbedUrl({ persona, state: 'idle' }) },
	};
}

async function handlePersonaSay(args, _auth, req) {
	if (!(await guardWrite(req))) return toolError('Too many requests — slow down and try again shortly.');
	const id = String(args.persona_id || '').trim();
	const text = String(args.text || '').trim();
	if (!isPersonaId(id)) return toolError('That is not a valid persona id.');
	if (!text) return toolError('Provide the reply text the agent is saying this turn.');

	const record = await getPersona(id);
	if (!record) return toolError('No persona found for that id. Create one with create_agent_persona.');

	const expr = args.emotion
		? { ...expressionFor(args.emotion, 0.85) }
		: expressionForText(text);
	const updated = await touchPersona(id).catch(() => null);
	const persona = personaPublicView(updated || record);

	return {
		content: [
			{
				type: 'text',
				text:
					`${persona.name} says it with a ${expr.emotion} expression` +
					(expr.gesture ? ` and a ${expr.gesture} gesture` : '') +
					'. Show the attached view — the body lip-syncs the reply and emotes.',
			},
			embodimentArtifact({
				persona,
				state: 'speaking',
				text,
				emotion: expr.emotion,
				intensity: expr.intensity,
				gesture: expr.gesture,
			}),
		],
		structuredContent: {
			persona_id: persona.persona_id,
			name: persona.name,
			glb_url: persona.glb_url,
			text,
			emotion: expr.emotion,
			intensity: expr.intensity,
			gesture: expr.gesture,
			turn_count: persona.turn_count,
			status: 'spoken',
			embed_url: buildEmbedUrl({
				persona,
				state: 'speaking',
				text,
				emotion: expr.emotion,
				intensity: expr.intensity,
				gesture: expr.gesture,
			}),
		},
	};
}

// ── annotations ───────────────────────────────────────────────────────────────
// create saves a new body (write, non-destructive). get is a pure read. say is a
// render directive that also bumps the persona's turn counter (a write).
const CREATE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const SAY_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

// Apps SDK hosts only render a widget declared on the TOOL descriptor, so each
// persona tool links the registered persona widget (which frames the hosted
// embodiment embed from structuredContent.embed_url). The inline text/html
// artifact stays in content[] for hosts that render inline resources instead.
function personaMeta(invoking, invoked) {
	return {
		'openai/outputTemplate': PERSONA_COMPONENT_URI,
		'openai/toolInvocation/invoking': invoking,
		'openai/toolInvocation/invoked': invoked,
		'openai/widgetAccessible': true,
	};
}

const DEFS = [
	{
		name: 'create_agent_persona',
		title: 'Save a rigged model as a living, persistent agent body',
		description:
			'Turn a generated GLB into a NAMED, persistent agent body — a "persona" the assistant reuses across ' +
			'turns and across sessions. The model is copied into durable storage so the body survives the source ' +
			'URL expiring, then registered under a stable persona_id. The returned view renders the LIVING body ' +
			'inline: it idles between turns, and persona_say makes it lip-sync and emote a reply. The persona_id is ' +
			'the handle — keep it and pass it to get_agent_persona or persona_say later to bring the exact same body ' +
			'back. No sign-in required.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			required: ['glb_url', 'name'],
			properties: {
				glb_url: { type: 'string', format: 'uri', description: 'Public https URL of the rigged GLB to embody (e.g. from forge_avatar).' },
				name: { type: 'string', minLength: 1, maxLength: 80, description: 'A display name for the persona, 1–80 characters.' },
				voice: { type: 'string', maxLength: 64, description: 'Optional voice name to speak with (used for audio-driven lip-sync when available).' },
				source_prompt: { type: 'string', maxLength: 1000, description: 'Optional: the prompt that generated this body, kept as provenance.' },
			},
		},
		annotations: CREATE_ANNOTATIONS,
		_meta: personaMeta('Saving your agent…', 'Your agent is ready'),
		handler: handleCreatePersona,
	},
	{
		name: 'get_agent_persona',
		title: 'Reload a persona by id (continuity across sessions)',
		description:
			'Bring back a previously saved persona by its persona_id — the SAME body and identity, in a fresh ' +
			'session. Returns the persona name, its model, the accumulated turn count, and the inline living-body ' +
			'view. Use this at the start of a conversation when the user returns to a named agent.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			required: ['persona_id'],
			properties: {
				persona_id: { type: 'string', minLength: 8, maxLength: 64, description: 'The persona_id returned by create_agent_persona.' },
			},
		},
		annotations: READ_ANNOTATIONS,
		_meta: personaMeta('Bringing your agent back…', 'Your agent is back'),
		handler: handleGetPersona,
	},
	{
		name: 'persona_say',
		title: 'Speak a reply through a persona — lip-sync + emotion + gesture',
		description:
			'Make a persona PERFORM a reply: the body lip-syncs the text and shows the matching facial expression ' +
			'and body gesture. Pass the persona_id and the exact text the agent is saying this turn; the emotion is ' +
			'detected from the text automatically (or set it explicitly). The returned view animates the body for ' +
			'this turn — show it alongside the reply. This is the turn-by-turn embodiment hook.',
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			required: ['persona_id', 'text'],
			properties: {
				persona_id: { type: 'string', minLength: 8, maxLength: 64, description: 'The persona to speak through.' },
				text: { type: 'string', minLength: 1, maxLength: 2000, description: 'The reply text the agent is saying this turn — drives lip-sync and emotion.' },
				emotion: { type: 'string', enum: ['neutral', 'joy', 'sad', 'angry', 'surprised', 'thinking'], description: 'Optional explicit emotion override; omit to auto-detect from the text.' },
			},
		},
		annotations: SAY_ANNOTATIONS,
		_meta: personaMeta('Performing the reply…', 'Here is your agent'),
		handler: handlePersonaSay,
	},
];

// Schemas for tools/list — strip the handler.
export const PERSONA_TOOL_CATALOG = DEFS.map(({ handler: _h, ...schema }) => schema);
export const PERSONA_DEFS = DEFS;
export const PERSONA_TOOL_NAMES = DEFS.map((d) => d.name);

const ajv = new Ajv({ allErrors: true, useDefaults: true, coerceTypes: true, strict: false });
addFormats(ajv);

// name → { handler, validate } — merged into the dispatcher's tool map.
export const PERSONA_TOOLS = Object.fromEntries(
	DEFS.map(({ name, handler, inputSchema }) => [name, { handler, validate: inputSchema ? ajv.compile(inputSchema) : null }]),
);
