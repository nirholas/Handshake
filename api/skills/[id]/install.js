import { sql } from '../../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../../_lib/auth.js';
import { cors, json, error, method, wrap, rateLimited } from '../../_lib/http.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { limits } from '../../_lib/rate-limit.js';
import { isUuid } from '../../_lib/validate.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,DELETE,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST', 'DELETE'])) return;

	const id = req.query?.id;
	if (!id || !isUuid(id)) return error(res, 404, 'not_found', 'skill not found');

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	const userId = session?.id ?? bearer.userId;

	// Install takes no request body, which made the POST a CORS-*simple* request:
	// any page could fire `fetch(url, {method:'POST', credentials:'include'})` at
	// it with no preflight and silently install skills into a signed-in visitor's
	// account. Every sibling mutation here (rate, publish, mint, review) is
	// preflight-protected by its JSON content-type; this one was not, so it needs
	// the explicit token. Bearer callers are exempt inside requireCsrf.
	if (session && !(await requireCsrf(req, res, userId))) return;

	const rl = await limits.chatUser(userId);
	if (!rl.success) return rateLimited(res, rl);

	const [skill] = await sql`SELECT id, schema_json, content FROM marketplace_skills WHERE id = ${id} AND is_public = true`;
	if (!skill) return error(res, 404, 'not_found', 'skill not found');

	if (req.method === 'POST') {
		// Atomically insert and increment only if the row is new
		await sql`
			WITH ins AS (
				INSERT INTO skill_installs (user_id, skill_id)
				VALUES (${userId}, ${id})
				ON CONFLICT (user_id, skill_id) DO NOTHING
				RETURNING id
			)
			UPDATE marketplace_skills
			SET install_count = install_count + 1
			WHERE marketplace_skills.id = ${id} AND EXISTS (SELECT 1 FROM ins)
		`;
		return json(res, 200, { installed: true, schema_json: skill.schema_json, content: skill.content });
	}

	// DELETE: uninstall
	await sql`
		WITH del AS (
			DELETE FROM skill_installs
			WHERE user_id = ${userId} AND skill_id = ${id}
			RETURNING id
		)
		UPDATE marketplace_skills
		SET install_count = GREATEST(0, install_count - 1)
		WHERE marketplace_skills.id = ${id} AND EXISTS (SELECT 1 FROM del)
	`;
	return json(res, 200, { installed: false });
});
