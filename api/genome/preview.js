// POST /api/genome/preview — predict the offspring of two agents BEFORE breeding.
//
// Derives the child genome deterministically from both parents and a seed (echoed
// back so a subsequent /breed with the same seed produces exactly the previewed
// child — what you see is what you breed). Returns the full trait blend, the real
// ElevenLabs voice settings + voice_id the child would carry (so the UI can play a
// genuine sample via /api/tts/eleven), the bakeable body appearance, the skill
// alleles (expressed + recessive + emergent), recorded mutations, and the pedigree
// tier. Read-only: nothing is minted, no wallet provisioned.

import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { isUuid } from '../_lib/validate.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { deriveGenome, makeSeed } from '../_lib/genome.js';
import {
	loadBreedingAgent,
	agentGenome,
	eligibilityFor,
	publicGenome,
} from '../_lib/genome-agent.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req, 'avatars:write');
	if (!auth) return error(res, 401, 'unauthorized', 'sign in to preview breeding');

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many previews — slow down');

	const body = await readJson(req);
	const parentAId = String(body.parent_a || body.parent_a_agent_id || '').trim();
	const parentBId = String(body.parent_b || body.parent_b_agent_id || '').trim();
	if (!isUuid(parentAId) || !isUuid(parentBId)) {
		return error(res, 400, 'validation_error', 'parent_a and parent_b agent ids are required');
	}
	if (parentAId === parentBId) {
		return error(res, 400, 'validation_error', 'an agent cannot breed with itself');
	}

	const [rowA, rowB] = await Promise.all([loadBreedingAgent(parentAId), loadBreedingAgent(parentBId)]);
	if (!rowA || !rowB) return error(res, 404, 'not_found', 'one or both parents not found');

	const eligA = eligibilityFor(rowA, auth.userId);
	const eligB = eligibilityFor(rowB, auth.userId);
	if (!eligA.allowed) return error(res, 403, 'parent_ineligible', `parent A: ${eligA.reason}`, { parent: 'a', reason: eligA.reason });
	if (!eligB.allowed) return error(res, 403, 'parent_ineligible', `parent B: ${eligB.reason}`, { parent: 'b', reason: eligB.reason });

	const seed = typeof body.seed === 'string' && body.seed ? body.seed.slice(0, 64) : makeSeed();
	const childName = (typeof body.name === 'string' && body.name.trim()) || `${rowA.name} × ${rowB.name}`;
	const child = deriveGenome({ parentA: agentGenome(rowA), parentB: agentGenome(rowB), seed });

	const feeThree = (eligA.fee_three || 0) + (eligB.fee_three || 0);

	return json(res, 200, {
		seed,
		child_name: childName,
		genome: publicGenome(child, childName),
		parents: {
			a: { id: rowA.id, name: rowA.name, cross_owner: eligA.cross_owner, fee_three: eligA.fee_three || 0 },
			b: { id: rowB.id, name: rowB.name, cross_owner: eligB.cross_owner, fee_three: eligB.fee_three || 0 },
		},
		stud_fee_three: feeThree,
		consent_required: eligA.cross_owner || eligB.cross_owner,
	});
});

async function resolveAuth(req, requiredScope) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id, source: 'session' };
	const bearer = await authenticateBearer(extractBearer(req));
	if (!bearer) return null;
	if (!hasScope(bearer.scope, requiredScope)) return null;
	return bearer;
}
