/**
 * GET /api/print/ops/insert-card?cert=<certId>   (or ?order=<orderId>)
 *
 * Everything the operator needs to print the card that goes in the box: the
 * certificate's QR, the model's name, the edition line, the material, and the
 * on-chain proof. Operator-gated because it resolves an ORDER to its
 * certificate, which the public certificate endpoint deliberately will not do.
 *
 * The card itself is rendered by /materialize/insert/:certId, which reads this.
 * The response also carries `insert_url`, the address a fulfillment adapter
 * hands a partner lane so a partner prints the same card we do.
 */

import { cors, json, method, wrap } from '../../_lib/http.js';
import { authorizeOps } from '../../_lib/ops-auth.js';
import { sql } from '../../_lib/db.js';
import { isUuid } from '../../_lib/validate.js';
import {
	getPublicCertificate,
	certificateUrl,
	siteOrigin,
	CERT_ID_RE,
} from '../../_lib/print/certificate.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const auth = await authorizeOps(req);
	if (!auth.ok) return json(res, 403, { error: 'operator authorization required' });

	const url = new URL(req.url, 'http://localhost');
	const orderId = (url.searchParams.get('order') || '').trim();
	let certId = (url.searchParams.get('cert') || '').trim().toLowerCase();

	if (!certId && orderId) {
		if (!isUuid(orderId)) return json(res, 400, { error: 'invalid order id' });
		const [row] = await sql`select id from print_certificates where order_id = ${orderId} limit 1`;
		if (!row) {
			return json(res, 404, {
				error: 'this order has no certificate yet; certificates are issued when an order ships',
			});
		}
		certId = row.id;
	}

	if (!CERT_ID_RE.test(certId)) return json(res, 400, { error: 'invalid certificate id' });

	const certificate = await getPublicCertificate(certId);
	if (!certificate) return json(res, 404, { error: 'certificate not found' });

	const [order] = await sql`
		select id, status, quantity, material_id, tracking_number, carrier, provider
		from print_orders where id = (select order_id from print_certificates where id = ${certId})
		limit 1
	`;

	return json(res, 200, {
		certificate,
		order: order
			? {
					id: order.id,
					status: order.status,
					quantity: order.quantity,
					material_id: order.material_id,
					provider: order.provider,
					tracking_number: order.tracking_number,
					carrier: order.carrier,
				}
			: null,
		insert_url: `${siteOrigin()}/materialize/insert/${certId}`,
		certificate_url: certificateUrl(certId),
		actor: auth.actor,
	});
});
