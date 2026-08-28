/**
 * The maintainer side of the feedback loop. Admin-only.
 *
 *   GET  /api/feedback?status=open|all|new|accepted|dismissed|fixed
 *          -> clusters (one row per distinct problem) + counts
 *   GET  /api/feedback?cluster=<key>
 *          -> every individual report in that cluster
 *   POST /api/feedback   { cluster? , id?, status, resolution? }
 *          -> move a cluster or a single report through the queue
 *
 * Reads expose raw visitor text and captured user agents, so the gate is the
 * same requireAdmin the rest of the internal surfaces use. There is no
 * secret-header side door here: unlike /api/ops/*, nothing about this needs to
 * be reachable by a script.
 */

import { cors, json, method, readJson, wrap, rateLimited, error } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import { requireAdmin } from '../_lib/admin.js';
import { feedbackStats, listClusters, listReports, setStatus, STATUSES } from '../_lib/feedback/store.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const admin = await requireAdmin(req, res);
	if (!admin) return;

	const rl = await limits.feedbackRead(admin.id || 'admin');
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://localhost');

	if (req.method === 'GET') {
		const cluster = url.searchParams.get('cluster');
		if (cluster) {
			return json(res, 200, { ok: true, cluster, reports: await listReports({ clusterKey: cluster, limit: 100 }) });
		}
		const status = url.searchParams.get('status') || 'open';
		const [clusters, stats] = await Promise.all([listClusters({ status }), feedbackStats()]);
		return json(res, 200, { ok: true, status, stats, clusters });
	}

	const body = await readJson(req, 4_000).catch(() => null);
	const status = typeof body?.status === 'string' ? body.status : '';
	if (!STATUSES.includes(status)) {
		return error(res, 400, 'invalid_status', `status must be one of: ${STATUSES.join(', ')}`);
	}
	const id = typeof body?.id === 'string' ? body.id : null;
	const clusterKey = typeof body?.cluster === 'string' ? body.cluster : null;
	if (!id && !clusterKey) {
		return error(res, 400, 'missing_target', 'Pass either an id or a cluster key.');
	}

	const updated = await setStatus({ id, clusterKey, status, resolution: body?.resolution ?? null });
	return json(res, 200, { ok: true, updated });
});
