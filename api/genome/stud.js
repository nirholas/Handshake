// GET  /api/genome/stud            — the genetic marketplace: agents listed as
//                                     breedable studs, rarest pedigrees first.
// POST /api/genome/stud             — list/unlist one of YOUR agents as a stud
//                                     and set its $THREE stud fee. (owner-only)
//
// Stud service is what makes a deep pedigree valuable: an owner can let others
// breed with a rare agent for a $THREE fee, and rare-trait carriers command more.

import { getSessionUser, authenticateBearer, extractBearer, hasScope } from '../_lib/auth.js';
import { requireCsrf } from '../_lib/csrf.js';
import { cors, json, method, readJson, wrap, error } from '../_lib/http.js';
import { isUuid } from '../_lib/validate.js';
import { limits } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';
import { breedingPolicy } from '../_lib/genome-agent.js';
import { pedigreeScore, normalizeGenome, genomeFromAgent } from '../_lib/genome.js';

const MAX_STUD_FEE_THREE = 1_000_000;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	if (req.method === 'GET') return listStuds(req, res);

	// POST — owner toggles stud listing.
	const auth = await resolveAuth(req, 'avatars:write');
	if (!auth) return error(res, 401, 'unauthorized', 'sign in to manage stud listings');
	if (!(await requireCsrf(req, res, auth.userId))) return;

	const body = await readJson(req);
	const agentId = String(body.agent_id || body.agentId || '').trim();
	if (!isUuid(agentId)) return error(res, 400, 'validation_error', 'agent_id is required');

	const rl = await limits.genomeStudWrite(auth.userId);
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many stud listing updates, slow down');

	const [row] = await sql`
		select id, user_id, meta from agent_identities where id = ${agentId} and deleted_at is null limit 1
	`;
	if (!row) return error(res, 404, 'not_found', 'agent not found');
	if (row.user_id !== auth.userId) return error(res, 403, 'forbidden', 'you do not own this agent');

	// PATCH semantics, not PUT: an omitted field keeps its stored value. A whole-
	// object read-modify-write meant "set my fee to 40" (a body carrying only
	// stud_fee_three) silently unlisted the agent and re-enabled breeding, because
	// the absent `stud` and `breedable` keys fell back to their bare defaults.
	const current = breedingPolicy(row);
	const policy = {
		breedable: typeof body.breedable === 'boolean' ? body.breedable : current.breedable,
		stud: typeof body.stud === 'boolean' ? body.stud : current.stud,
		stud_fee_three: has(body, 'stud_fee_three') ? clampFee(body.stud_fee_three) : current.stud_fee_three,
	};

	// Write only the genome_breeding subtree. Replacing the whole `meta` document
	// would clobber any key a concurrent write (wallet provisioning, persona save)
	// landed between our SELECT and our UPDATE.
	await sql`
		update agent_identities
		set meta = jsonb_set(coalesce(meta, '{}'::jsonb), '{genome_breeding}', ${JSON.stringify(policy)}::jsonb, true),
		    updated_at = now()
		where id = ${agentId} and user_id = ${auth.userId}
	`;
	return json(res, 200, { agent_id: agentId, genome_breeding: policy });
});

function has(obj, key) {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

// A fee is $THREE, so it is non-negative, finite, and bounded. A junk value
// (null, a string, NaN) reads as "no fee" rather than failing the whole update.
function clampFee(raw) {
	const n = Number(raw);
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(MAX_STUD_FEE_THREE, n));
}

async function listStuds(req, res) {
	const url = new URL(req.url, 'http://x');
	const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 24, 1), 60);
	const rows = await sql`
		select i.id, i.name, i.avatar_id, i.meta, i.skills,
		       a.thumbnail_key as avatar_thumbnail_key
		from agent_identities i
		left join avatars a on a.id = i.avatar_id and a.deleted_at is null
		where i.deleted_at is null and i.is_public = true
		  and (i.meta -> 'genome_breeding' ->> 'stud') = 'true'
		order by i.updated_at desc nulls last
		limit ${limit}
	`;
	const studs = rows.map((r) => {
		const genome = r.meta?.genome ? normalizeGenome(r.meta.genome) : genomeFromAgent({ id: r.id, meta: r.meta, skills: r.skills });
		const pedigree = pedigreeScore(genome);
		return {
			id: r.id,
			name: r.name,
			avatar_id: r.avatar_id,
			generation: genome.generation,
			pedigree,
			stud_fee_three: Math.max(0, Number(r.meta?.genome_breeding?.stud_fee_three) || 0),
			expressed_skills: genome.skills.filter((s) => s.expressed).map((s) => s.skill),
		};
	});
	// Rarest first — depth + emergent talent is what a breeder pays for.
	studs.sort((a, b) => b.pedigree.score - a.pedigree.score);
	return json(res, 200, { studs }, { 'cache-control': 'public, s-maxage=20' });
}

async function resolveAuth(req, requiredScope) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id, source: 'session' };
	const bearer = await authenticateBearer(extractBearer(req));
	if (!bearer) return null;
	if (!hasScope(bearer.scope, requiredScope)) return null;
	return bearer;
}
