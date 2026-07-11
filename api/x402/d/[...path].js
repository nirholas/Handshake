// GET /api/x402/d/<family>/<id>/<metric>  (and /d/<family>/<metric> for the
// no-id families: global, fear-greed, gas) — the datapoint fabric.
//
// Hundreds of thousands of standalone paid endpoints served by this ONE
// route: every (family, id, metric) triple from the registry
// (api/_lib/market-data/datapoints.js) is its own individually addressable,
// individually priced x402 resource. $0.0005 USDC per datapoint by default
// (X402_PRICE_DATAPOINT_<FAMILY> to override per family), USDC on Solana or
// Base. Free catalog: GET /api/x402/d.
//
// Flow: the path is parsed and validated BEFORE any 402 — a resource that
// cannot exist (unknown family/metric, malformed id) answers 404/422 without
// ever asking for payment. A valid path gets the standard paid-endpoint dance
// from a per-(family,metric) instance; the concrete resource URL (with the
// id) is baked into the challenge via resourceUrlBuilder. Unknown ids and
// upstream outages throw AFTER verify but BEFORE settle — never charged.

import { paidEndpoint } from '../../_lib/x402-paid-endpoint.js';
import { buildBazaarSchema } from '../../_lib/x402-spec.js';
import { installAccessControl } from '../../_lib/x402/access-control.js';
import { withService } from '../../_lib/x402/bazaar-helpers.js';
import { priceFor } from '../../_lib/x402-prices.js';
import { env } from '../../_lib/env.js';
import {
	DATAPOINT_FAMILIES,
	DATAPOINT_DEFAULT_ATOMICS,
	datapointDescription,
	parseDatapointPath,
	readDatapoint,
} from '../../_lib/market-data/datapoints.js';

const PREFIX = '/api/x402/d/';

// One paidEndpoint instance per (family, metric) — ~50 total, built lazily.
// The id varies per request and reaches the handler through req.url; the
// challenge's resource URL tracks the actual request path.
const _instances = new Map();

function instanceFor(parsed) {
	const key = `${parsed.family}/${parsed.metric}`;
	let inst = _instances.get(key);
	if (inst) return inst;

	const { family, metric, metricDef, familyDef } = parsed;
	const origin = env.APP_ORIGIN || 'https://three.ws';
	const routePattern = familyDef.describeId
		? `${PREFIX}${family}/{id}/${metric}`
		: `${PREFIX}${family}/${metric}`;
	const priceAtomics = priceFor(`datapoint-${family}`, DATAPOINT_DEFAULT_ATOMICS);
	const description = datapointDescription({ family, metric, priceAtomics });
	const inputSchema = { type: 'object', properties: {} };

	inst = paidEndpoint({
		route: routePattern,
		method: 'GET',
		priceAtomics,
		networks: ['solana', 'base'],
		description,
		resourceUrlBuilder: (req) => `${origin}${(req.url || routePattern).split('?')[0]}`,
		bazaar: {
			description,
			useCases: ['single-value agent reads', 'spreadsheet/oracle feeds', 'micro-billing per datapoint'],
			input: { type: 'query', example: {}, schema: inputSchema },
			output: {
				type: 'json',
				example: {
					family,
					...(familyDef.describeId ? { id: '<id>' } : {}),
					metric,
					label: metricDef.label,
					unit: metricDef.unit,
					value: 12345.67,
					as_of: '2026-07-11T00:00:00.000Z',
					source: 'three.ws market-data',
				},
			},
			schema: buildBazaarSchema({ method: 'GET', queryParamsSchema: inputSchema }),
		},
		service: withService({
			serviceName: 'three.ws Datapoints',
			tags: ['crypto', 'market-data', 'datapoint', family],
		}),
		accessControl: installAccessControl({ requiredScope: 'x402:bypass' }),
		async handler({ req }) {
			const segments = (req.url || '')
				.split('?')[0]
				.slice(PREFIX.length)
				.split('/')
				.filter(Boolean);
			return readDatapoint(parseDatapointPath(segments));
		},
	});
	_instances.set(key, inst);
	return inst;
}

function sendJson(res, status, obj) {
	res.statusCode = status;
	if (typeof res.setHeader === 'function') {
		res.setHeader('content-type', 'application/json; charset=utf-8');
		res.setHeader('access-control-allow-origin', '*');
	}
	res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
	const pathname = (req.url || '').split('?')[0];
	const segments = pathname.startsWith(PREFIX)
		? pathname.slice(PREFIX.length).split('/').filter(Boolean)
		: [];

	// Validate the path shape BEFORE issuing a 402 — nobody should be asked to
	// pay for a resource that cannot exist.
	let parsed;
	try {
		parsed = parseDatapointPath(segments);
	} catch (err) {
		return sendJson(res, err.status || 404, {
			error: err.code || 'not_found',
			message: err.message,
			catalog: '/api/x402/d',
			families: Object.keys(DATAPOINT_FAMILIES),
		});
	}

	return instanceFor(parsed)(req, res);
}
