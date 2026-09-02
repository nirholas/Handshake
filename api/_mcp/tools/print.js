// Materialize MCP tools: the print lane, discoverable the same way generation is.
//
// An agent that just generated a model has no way to learn it can also have the
// thing manufactured unless the print lane is in the same tool list the
// generation lane is in. These two tools close that gap:
//
//   print_analyze  is this mesh printable at all, and at what size
//   print_quote    what would it cost, in what material, shipped where
//
// Both are free and keyless, which is why they live here rather than behind a
// payment. Neither one places an order or moves money: ordering is
// POST /api/x402/print-order, which is an x402 settlement an agent performs
// deliberately, with the address and the exact total in front of it. A tool
// that could silently commit a caller to a physical shipment has no business
// being a read-only lookup, so the quote tool returns the signed token and
// stops there.
//
// The fabrication gate runs inside the quote endpoint these tools call, so a
// refusal reaches the agent here, before any price exists, with the category
// and the policy link rather than a bare error. See
// api/_lib/print/gate.js and docs/materialize.md#content-policy.

import { limits } from '../../_lib/rate-limit.js';
import { loadMeshFromUrl, MeshIoError } from '../../_lib/print/mesh-io.js';
import { analyzeMesh } from '../../_lib/print/analyze.js';
import {
	loadCatalog,
	materialFits,
	publicCatalog,
	quotePrint,
	signQuote,
} from '../../_lib/print/quote.js';
import { loadLineage, runFabricationGate } from '../../_lib/print/gate.js';
import { getPublicCreation } from '../../_lib/forge-store.js';
import { createHash } from 'node:crypto';

function rpcError(code, message, data) {
	const e = new Error(message);
	e.code = code;
	e.data = data;
	return e;
}

// Both tools read a caller-supplied model and compute a deterministic answer:
// same file, same report, same price. destructiveHint defaults to true when
// omitted, so it is set explicitly.
const PRINT_ANNOTATIONS = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
};

/** The same report hash the HTTP quote endpoint binds into a token. */
function reportHashOf(report) {
	return createHash('sha256')
		.update(JSON.stringify([report.version, report.volume_cm3, report.bbox_mm, report.min_wall_mm, report.triangles]))
		.digest('hex')
		.slice(0, 32);
}

/**
 * Resolve the model an agent named: a three.ws creation, or any public GLB.
 * @returns {Promise<{ url: string, creationId: string|null, prompt: string }>}
 */
async function resolveModel(args) {
	if (args.creation_id) {
		const creation = await getPublicCreation({ id: String(args.creation_id) });
		if (!creation) throw rpcError(-32602, 'no finished public creation with that id');
		if (!creation.glb_url) throw rpcError(-32602, 'that creation has no finished model yet');
		return { url: creation.glb_url, creationId: creation.id, prompt: creation.prompt || '' };
	}
	if (args.glb_url) return { url: String(args.glb_url), creationId: null, prompt: '' };
	throw rpcError(-32602, 'pass creation_id or glb_url');
}

/** Load and analyze, translating the typed mesh errors into MCP errors. */
async function reportFor(url) {
	try {
		const mesh = await loadMeshFromUrl(url);
		return await analyzeMesh(mesh, { sourceUrl: url });
	} catch (err) {
		if (err instanceof MeshIoError) throw rpcError(-32602, `${err.code}: ${err.message}`);
		throw err;
	}
}

/**
 * Run the fabrication gate over the same subject the HTTP lane reads. Throws
 * the refusal as an MCP error carrying the category and the policy link, so an
 * agent can tell "this is not printable" from "we will not print this".
 */
async function assertPrintable({ creationId, prompt, note, report }) {
	const lineage = await loadLineage(creationId);
	const gate = await runFabricationGate({
		stage: 'quote',
		lineageText: lineage.text || prompt,
		buyerNote: typeof note === 'string' ? note : '',
		analysis: report,
	});
	if (gate.verdict === 'refuse') {
		throw rpcError(-32000, gate.message, {
			reason: 'fabrication_refused',
			category: gate.category,
			allowed: gate.allowed,
			policy_url: gate.policy_url,
		});
	}
	return gate;
}

function summarizeReport(report) {
	const b = report.bbox_mm;
	const lines = [
		`Printability score ${report.score}/100.`,
		`${report.manifold ? 'Closed solid' : 'Not a closed solid, it will be reconstructed before printing'}, ${report.shells} ${report.shells === 1 ? 'body' : 'separate bodies'}, ${report.triangles} triangles.`,
		`Bounding box ${b.x} x ${b.y} x ${b.z} mm at the model's own scale. Volume ${report.volume_cm3} cm3.`,
		report.min_wall_mm === null
			? 'Thinnest wall could not be measured (the surface has nothing behind it).'
			: `Thinnest wall ${report.min_wall_mm} mm at this size.`,
	];
	if (report.recommended_min_height_mm) {
		const r = report.recommended_min_height_mm;
		lines.push(
			`Minimum print height for the detail to survive: resin ${r.resin} mm, SLS nylon ${r.sls_nylon} mm, full colour ${r.full_color} mm.`,
		);
	}
	for (const d of report.deductions) lines.push(`  ${d.id} (-${d.points}): ${d.detail}`);
	return lines.join('\n');
}

function summarizeQuote(quote) {
	const lines = [
		`${quote.material.name}, ${quote.targetHeightMm} mm tall, quantity ${quote.quantity}, shipping to ${quote.country}.`,
	];
	for (const line of quote.lines) {
		lines.push(`  ${line.label}: ${line.amount} ${quote.currency}${line.detail ? ` (${line.detail})` : ''}`);
	}
	lines.push(`Total ${quote.total} ${quote.currency} on ${quote.chain}, about ${quote.leadTimeDays} days to arrive.`);
	if (quote.quoteOnRequest) {
		lines.push('This material is quote-on-request: the figure is an estimate and cannot be checked out until an engineer confirms it.');
	} else {
		lines.push('Order it with POST /api/x402/print-order, passing this token and a shipping address.');
	}
	return lines.join('\n');
}

export const toolDefs = [
	{
		name: 'print_analyze',
		title: 'Check whether a 3D model can be printed',
		annotations: PRINT_ANNOTATIONS,
		description:
			'Measure a 3D model for real-world manufacturing: whether it is a closed solid, how many separate ' +
			'bodies it contains, how many holes it has, its thinnest wall, its exact volume, and a 0-100 ' +
			'printability score with named reasons. Also returns, per material, the smallest height the model ' +
			'can be printed at and still hold its detail. Free, keyless, and read-only: nothing is ordered. ' +
			'Pass a three.ws creation_id or any public glb_url.',
		inputSchema: {
			type: 'object',
			properties: {
				creation_id: { type: 'string', description: 'A three.ws forge creation id.' },
				glb_url: { type: 'string', format: 'uri', description: 'Public https URL of a .glb file, instead of a creation id.' },
			},
			additionalProperties: false,
		},
		async handler(args, auth) {
			const rl = await limits.mcpPrintAnalyze(auth.userId || auth.rateKey);
			if (!rl.success) {
				throw rpcError(-32000, 'rate_limited', { retry_after: Math.ceil((rl.reset - Date.now()) / 1000) });
			}
			const model = await resolveModel(args);
			const report = await reportFor(model.url);
			await assertPrintable({ creationId: model.creationId, prompt: model.prompt, note: '', report });
			const fits = materialFits({ report, catalog: loadCatalog() });
			return {
				content: [{ type: 'text', text: summarizeReport(report) }],
				structuredContent: { source_url: model.url, report, fits },
			};
		},
	},
	{
		name: 'print_quote',
		title: 'Price a real 3D print and get a signed quote',
		annotations: PRINT_ANNOTATIONS,
		description:
			'Price a physical print of a 3D model: an itemized quote in USDC (build setup, material with the ' +
			'exact volume it was computed from, finish, quantity break, shipping) plus a signed quote token ' +
			'valid for 24 hours. Materials, size limits and lead times come from GET /api/print/catalog. This ' +
			'tool does NOT place an order and moves no money: settle the token at POST /api/x402/print-order ' +
			'when you have a shipping address. Free and keyless.',
		inputSchema: {
			type: 'object',
			properties: {
				creation_id: { type: 'string', description: 'A three.ws forge creation id.' },
				glb_url: { type: 'string', format: 'uri', description: 'Public https URL of a .glb file, instead of a creation id.' },
				material_id: { type: 'string', description: 'Material id from the catalog, e.g. resin-standard. Omit to list what fits.' },
				finish_id: { type: 'string', description: 'Optional finish id from that material.' },
				target_height_mm: { type: 'number', minimum: 1, maximum: 1000, description: 'Printed height in millimetres.' },
				quantity: { type: 'integer', minimum: 1, maximum: 500, default: 1, description: 'How many. Price breaks at 5 and 20.' },
				country: { type: 'string', minLength: 2, maxLength: 2, description: 'ISO 3166-1 alpha-2 destination, for shipping.' },
				hollow: { type: 'boolean', description: 'Hollow the solid where it is geometrically safe. Lowers the price.' },
				note: { type: 'string', maxLength: 500, description: 'Optional note about the intended object. Read by the fabrication safety gate.' },
			},
			additionalProperties: false,
		},
		async handler(args, auth) {
			const rl = await limits.mcpPrintQuote(auth.userId || auth.rateKey);
			if (!rl.success) {
				throw rpcError(-32000, 'rate_limited', { retry_after: Math.ceil((rl.reset - Date.now()) / 1000) });
			}
			const model = await resolveModel(args);
			const report = await reportFor(model.url);
			await assertPrintable({ creationId: model.creationId, prompt: model.prompt, note: args.note, report });

			const catalog = loadCatalog();
			const fits = materialFits({ report, catalog });
			if (!args.material_id) {
				// No material chosen yet: answer with what this mesh can be made of
				// rather than an error, so an agent can pick and call again.
				return {
					content: [
						{
							type: 'text',
							text: `${summarizeReport(report)}\n\nMaterials that fit this mesh: ${fits
								.filter((f) => f.ok)
								.map((f) => f.materialId)
								.join(', ') || 'none at any size'}\nCall again with material_id, target_height_mm and country for a price.`,
						},
					],
					structuredContent: { source_url: model.url, report, fits, catalog: publicCatalog(catalog), quote: null, token: null },
				};
			}

			const priced = quotePrint({
				report,
				materialId: String(args.material_id),
				finishId: args.finish_id ? String(args.finish_id) : null,
				targetHeightMm: Number(args.target_height_mm),
				quantity: Number(args.quantity) || 1,
				country: args.country,
				hollow: Boolean(args.hollow),
				holderDiscountBps: 0,
				catalog,
			});

			if (!priced.ok) {
				// A constraint rejection is guidance, not a failure: it names the
				// measured number, the required number and the fix.
				return {
					content: [{ type: 'text', text: `Cannot print it that way: ${priced.rejection.message}` }],
					structuredContent: { source_url: model.url, report, fits, quote: null, rejection: priced.rejection, token: null },
				};
			}

			const token = priced.quote.quoteOnRequest
				? null
				: signQuote(priced.quote, {
						reportHash: reportHashOf(report),
						sourceUrl: model.url,
						creationId: model.creationId,
					});

			return {
				content: [{ type: 'text', text: summarizeQuote(priced.quote) }],
				structuredContent: {
					source_url: model.url,
					report,
					quote: priced.quote,
					token,
					order_endpoint: '/api/x402/print-order',
					expires_in_seconds: token ? catalog.pricing.quoteTtlSeconds : null,
				},
			};
		},
	},
];
