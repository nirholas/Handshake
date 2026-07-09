import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { cors, json, error, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { MonetizationService } from '../_lib/services/MonetizationService.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	if (!session && !bearer) return error(res, 401, 'unauthorized', 'sign in required');
	const userId = session?.id ?? bearer.userId;

	const rl = await limits.authedReadIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const service = new MonetizationService(userId);
	const data = await service.getCreatorEconomics();

	// Shape kept backward-compatible (pending_usd/settled_usd/entries) and
	// extended with splits, on-chain license counts, and the withdrawable balance
	// so the creator dashboard renders the full economics surface from one call.
	return json(res, 200, data);
});
