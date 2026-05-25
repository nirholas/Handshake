// A2A (Agent-to-Agent) x402 transport — server side.
//
// USE-12: Implements the google-a2a/a2a-x402 v0.1 extension. The A2A protocol
// uses JSON-RPC `message/send` calls with task-based state. Payment is
// signalled via the task's `status.state` plus `x402.payment.*` metadata
// fields on the agent reply message — distinct from the HTTP 402 + X-PAYMENT
// dance we use for /api/x402/*.
//
// Wire shape (per spec):
//   • First call (no payment metadata) → reply task with
//       state = 'input-required'
//       message.metadata['x402.payment.status']   = 'payment-required'
//       message.metadata['x402.payment.required'] = PaymentRequirements
//   • Retry with `x402.payment.payload` + `x402.payment.status = payment-submitted`
//     and `taskId` set → server verifies via facilitator, runs handler, settles,
//     replies with state = 'completed' (or 'failed') and
//       message.metadata['x402.payment.status']   = 'payment-completed'
//       message.metadata['x402.payment.receipts'] = [SettlementResponse]
//
// Extension activation: both peers MUST attach
//   `X-A2A-Extensions: https://github.com/google-a2a/a2a-x402/v0.1`
// on their HTTP transport. We emit it on every reply and require it on the
// inbound side per spec (treat-as-disabled-when-absent is opt-in by the
// AgentCard, but our card declares `required: true`).
//
// Verification + settlement reuse the existing facilitator client in
// api/_lib/x402-spec.js so A2A inherits Base / Solana / BSC support, builder
// code echo enforcement, and direct-scheme handling automatically.

import { randomUUID } from 'node:crypto';

import { env } from '../env.js';
import {
	BUILDER_CODE,
	NETWORK_BASE_MAINNET,
	NETWORK_BSC_MAINNET,
	NETWORK_SOLANA_MAINNET,
	X402Error,
	X402_VERSION,
	permit2VariantOf,
	settlePayment,
	verifyPayment,
} from '../x402-spec.js';
import { declareBuilderCodeExtension } from '../x402-builder-code.js';
import { PAYMENT_EVENT_TOPIC as BSC_PAYMENT_EVENT_TOPIC } from '../x402-bsc-direct.js';

export const A2A_X402_EXTENSION_URI = 'https://github.com/google-a2a/a2a-x402/v0.1';
export const A2A_EXTENSIONS_HEADER = 'X-A2A-Extensions';

const NETWORK_ALIASES = {
	base: NETWORK_BASE_MAINNET,
	'base-mainnet': NETWORK_BASE_MAINNET,
	bsc: NETWORK_BSC_MAINNET,
	'bsc-mainnet': NETWORK_BSC_MAINNET,
	solana: NETWORK_SOLANA_MAINNET,
	'solana-mainnet': NETWORK_SOLANA_MAINNET,
};

function resolveNetwork(name) {
	return NETWORK_ALIASES[name] || name;
}

function buildAccept(network, priceAtomics, resourceUrl, payToOverride) {
	const common = {
		scheme: 'exact',
		amount: String(priceAtomics),
		maxTimeoutSeconds: 600,
		resource: resourceUrl,
	};
	if (network === NETWORK_BASE_MAINNET) {
		return {
			...common,
			network: NETWORK_BASE_MAINNET,
			payTo: payToOverride?.base || env.X402_PAY_TO_BASE,
			asset: env.X402_ASSET_ADDRESS_BASE,
			extra: { name: 'USD Coin', version: '2', decimals: 6 },
		};
	}
	if (network === NETWORK_SOLANA_MAINNET) {
		return {
			...common,
			network: NETWORK_SOLANA_MAINNET,
			payTo: payToOverride?.solana || env.X402_PAY_TO_SOLANA,
			asset: env.X402_ASSET_MINT_SOLANA,
			extra: { name: 'USDC', decimals: 6, feePayer: env.X402_FEE_PAYER_SOLANA },
		};
	}
	if (network === NETWORK_BSC_MAINNET) {
		const contract = payToOverride?.bsc || env.X402_PAY_TO_BSC;
		return {
			...common,
			scheme: 'direct',
			network: NETWORK_BSC_MAINNET,
			payTo: contract,
			asset: env.X402_ASSET_ADDRESS_BSC,
			extra: {
				name: 'Binance-Peg USD Coin',
				decimals: 6,
				contract,
				method: 'pay(bytes32)',
				eventTopic: BSC_PAYMENT_EVENT_TOPIC,
			},
		};
	}
	throw new X402Error('unsupported_network', `a2a: unsupported network ${network}`, 500);
}

function buildAccepts({ priceAtomics, networks, resourceUrl, payToOverride }) {
	const out = [];
	for (const name of networks) {
		const net = resolveNetwork(name);
		const baseTo = payToOverride?.base || env.X402_PAY_TO_BASE;
		const solTo = payToOverride?.solana || env.X402_PAY_TO_SOLANA;
		const bscTo = payToOverride?.bsc || env.X402_PAY_TO_BSC;
		if (net === NETWORK_BASE_MAINNET && !baseTo) continue;
		if (net === NETWORK_SOLANA_MAINNET && !solTo) continue;
		if (net === NETWORK_BSC_MAINNET && !bscTo) continue;
		const accept = buildAccept(net, priceAtomics, resourceUrl, payToOverride);
		out.push(accept);
		const sibling = permit2VariantOf(accept);
		if (sibling) out.push(sibling);
	}
	if (!out.length) {
		throw new X402Error(
			'no_payto_configured',
			'a2a: no X402_PAY_TO_* configured for any requested network',
			500,
		);
	}
	return out;
}

function paymentRequiredObject({ resourceUrl, description, mimeType, accepts }) {
	return {
		x402Version: X402_VERSION,
		error: 'Payment required to access this resource',
		resource: { url: resourceUrl, description, mimeType },
		accepts,
	};
}

function agentMessage({ taskId, text, metadata }) {
	return {
		kind: 'message',
		role: 'agent',
		messageId: randomUUID(),
		taskId,
		parts: [{ kind: 'text', text }],
		metadata,
	};
}

function task({ id, state, message, artifacts }) {
	const out = {
		kind: 'task',
		id,
		status: { state, message },
	};
	if (Array.isArray(artifacts) && artifacts.length) out.artifacts = artifacts;
	return out;
}

function jsonrpcResult(id, result) {
	return { jsonrpc: '2.0', id, result };
}

function jsonrpcError(id, code, message, data) {
	const err = { code, message };
	if (data !== undefined) err.data = data;
	return { jsonrpc: '2.0', id, error: err };
}

function readClientPaymentStatus(metadata) {
	const status = metadata?.['x402.payment.status'];
	return typeof status === 'string' ? status : null;
}

function readClientPaymentPayload(metadata) {
	const payload = metadata?.['x402.payment.payload'];
	return payload && typeof payload === 'object' ? payload : null;
}

function encodePaymentHeaderFromPayload(payload) {
	// verifyPayment() decodes the X-PAYMENT header value back to JSON. We
	// re-encode the A2A-supplied payload object to base64-JSON so we can reuse
	// that path without forking the verifier. The spec's payload shape (with
	// `accepted` instead of `paymentRequirements`) is structurally compatible
	// with what selectRequirement() needs once we normalise the field name.
	const normalised = { ...payload };
	if (payload.accepted && !payload.paymentRequirements) {
		normalised.paymentRequirements = payload.accepted;
	}
	if (!normalised.x402Version) normalised.x402Version = X402_VERSION;
	return Buffer.from(JSON.stringify(normalised), 'utf8').toString('base64');
}

function clientAcceptsExtension(headers) {
	// Per the A2A x402 spec: clients activate the extension by listing its URI
	// in the X-A2A-Extensions header. We require it when the AgentCard
	// declared the extension as `required: true`. Header names are
	// case-insensitive — Node lowercases them on `req.headers`.
	const raw = headers['x-a2a-extensions'];
	if (!raw) return false;
	const values = Array.isArray(raw) ? raw : String(raw).split(',');
	for (const v of values) {
		if (v.trim() === A2A_X402_EXTENSION_URI) return true;
	}
	return false;
}

function activateExtensionHeader(res) {
	res.setHeader(A2A_EXTENSIONS_HEADER, A2A_X402_EXTENSION_URI);
}

// Build the agent's payment-required reply. Returned synchronously so callers
// can decide whether to emit it as a JSON-RPC result, an SSE event, or wrap it
// in an A2A `streamingResponse`.
export function buildPaymentRequiredTask({
	taskId = randomUUID(),
	resourceUrl,
	description,
	mimeType = 'application/json',
	priceAtomics,
	networks = ['base', 'solana'],
	payTo,
	prompt = 'Payment required to invoke this skill.',
}) {
	const accepts = buildAccepts({
		priceAtomics,
		networks,
		resourceUrl,
		payToOverride: payTo,
	});
	const required = paymentRequiredObject({ resourceUrl, description, mimeType, accepts });
	const message = agentMessage({
		taskId,
		text: prompt,
		metadata: {
			'x402.payment.status': 'payment-required',
			'x402.payment.required': required,
		},
	});
	return { task: task({ id: taskId, state: 'input-required', message }), accepts, required };
}

function builderCodeForServices(services) {
	const appCode = env.X402_BUILDER_CODE_APP;
	if (!appCode) return null;
	if (Array.isArray(services) && services.length) {
		return declareBuilderCodeExtension({ a: appCode, s: services });
	}
	return declareBuilderCodeExtension({ a: appCode });
}

// Run a single inbound `message/send` JSON-RPC call. The caller owns reading
// the body off the wire — we want `body` parsed and the framework-agnostic
// `req` only for `req.headers` access (extension activation check).
//
// `handler({ taskId, payer, requirement, payload, message })` returns either:
//   • { text, artifacts? } — wrapped in a `completed` task message + artifacts.
//   • A string                — wrapped as the text reply with no artifacts.
//   • undefined / null        — defaults to "Payment settled." text.
//
// Any thrown Error with `.status === 402` re-emits the payment-required task
// (e.g. payment for the wrong network). Other errors become a `failed` task
// with `x402.payment.status = payment-failed`.
export async function handleA2ARequest({
	req,
	body,
	route,
	resourceUrl,
	description,
	mimeType = 'application/json',
	priceAtomics = env.X402_MAX_AMOUNT_REQUIRED,
	networks = ['base', 'solana'],
	payTo,
	services,
	prompt,
	handler,
}) {
	if (!body || typeof body !== 'object') {
		return jsonrpcError(null, -32700, 'Parse error: body must be JSON');
	}
	if (body.jsonrpc !== '2.0') {
		return jsonrpcError(body.id ?? null, -32600, 'Invalid Request: jsonrpc must be "2.0"');
	}
	if (body.method !== 'message/send') {
		return jsonrpcError(body.id ?? null, -32601, `Method not found: ${body.method}`);
	}

	const reqId = body.id ?? null;
	const message = body.params?.message;
	if (!message || typeof message !== 'object') {
		return jsonrpcError(reqId, -32602, 'Invalid params: message is required');
	}

	if (!clientAcceptsExtension(req.headers || {})) {
		const failed = task({
			id: message.taskId || randomUUID(),
			state: 'failed',
			message: agentMessage({
				taskId: message.taskId,
				text: `This agent requires the x402 extension. Send the ${A2A_EXTENSIONS_HEADER} header with ${A2A_X402_EXTENSION_URI}.`,
				metadata: {
					'x402.payment.status': 'payment-rejected',
					'x402.payment.error': 'EXTENSION_REQUIRED',
				},
			}),
		});
		return jsonrpcResult(reqId, failed);
	}

	const status = readClientPaymentStatus(message.metadata);
	const payload = readClientPaymentPayload(message.metadata);

	// First-leg: no payment payload → return the payment-required task.
	if (!payload || status === 'payment-required' || status === null) {
		const built = buildPaymentRequiredTask({
			taskId: message.taskId,
			resourceUrl,
			description,
			mimeType,
			priceAtomics,
			networks,
			payTo,
			prompt,
		});
		return jsonrpcResult(reqId, built.task);
	}

	const taskId = message.taskId || randomUUID();

	// Second-leg: client supplied a payment payload. Verify → run → settle.
	const builderCode = builderCodeForServices(services);
	const paymentHeader = encodePaymentHeaderFromPayload(payload);

	// Reconstruct the same accepts list we advertised on the first leg so the
	// facilitator sees the resource/network/payTo trio it expects.
	let requirements;
	try {
		requirements = buildAccepts({
			priceAtomics,
			networks,
			resourceUrl,
			payToOverride: payTo,
		});
	} catch (err) {
		return jsonrpcResult(
			reqId,
			task({
				id: taskId,
				state: 'failed',
				message: agentMessage({
					taskId,
					text: err.message,
					metadata: {
						'x402.payment.status': 'payment-failed',
						'x402.payment.error': err.code || 'INVALID_CONFIGURATION',
					},
				}),
			}),
		);
	}

	let verified;
	try {
		verified = await verifyPayment({ paymentHeader, requirements, builderCode });
	} catch (err) {
		// 402 from verify → re-issue payment-required (e.g. wrong network).
		if (err instanceof X402Error && err.status === 402) {
			const built = buildPaymentRequiredTask({
				taskId,
				resourceUrl,
				description,
				mimeType,
				priceAtomics,
				networks,
				payTo,
				prompt: err.message,
			});
			return jsonrpcResult(reqId, built.task);
		}
		const receipt = {
			success: false,
			errorReason: err.message,
			network: payload?.accepted?.network || payload?.paymentRequirements?.network || '',
			transaction: '',
		};
		return jsonrpcResult(
			reqId,
			task({
				id: taskId,
				state: 'failed',
				message: agentMessage({
					taskId,
					text: `Payment verification failed: ${err.message}`,
					metadata: {
						'x402.payment.status': 'payment-failed',
						'x402.payment.error': err.code || 'INVALID_PAYMENT',
						'x402.payment.receipts': [receipt],
					},
				}),
			}),
		);
	}

	// Settle BEFORE delivering the work. Prior ordering (deliver → settle)
	// risked the payer receiving the skill result and only then seeing
	// settlement fail in the metadata; for idempotent skills it also meant
	// we did the compute without an on-chain charge to back it. Settle-first
	// inverts the risk: if settlement fails, we refuse the work and the
	// client can retry with a fresh payment. If the handler fails AFTER a
	// successful settle, the payer paid for a failed execution — we surface
	// the settled receipt in the failure response so they have audit proof
	// (and can dispute or retry without re-paying if the failure was ours).
	let settled;
	try {
		settled = await settlePayment({ verified });
	} catch (err) {
		const receipt = {
			success: false,
			errorReason: err.message,
			network: verified.requirement.network,
			transaction: '',
		};
		return jsonrpcResult(
			reqId,
			task({
				id: taskId,
				state: 'failed',
				message: agentMessage({
					taskId,
					text: `Settlement failed: ${err.message}`,
					metadata: {
						'x402.payment.status': 'payment-failed',
						'x402.payment.error': err.code || 'SETTLEMENT_FAILED',
						'x402.payment.receipts': [receipt],
					},
				}),
			}),
		);
	}

	let handlerResult;
	try {
		handlerResult = await handler({
			taskId,
			payer: verified.payer,
			requirement: verified.requirement,
			payload,
			message,
		});
	} catch (err) {
		// Payment is already settled on-chain — surface the settled receipt
		// alongside the handler failure so the payer has proof of charge and
		// can replay/dispute. Status is `payment-settled` (not -failed) since
		// the payment leg succeeded; the failure is execution-side.
		const receipt = {
			success: true,
			transaction: settled.transaction,
			network: settled.network,
			payer: settled.payer || verified.payer || null,
		};
		return jsonrpcResult(
			reqId,
			task({
				id: taskId,
				state: 'failed',
				message: agentMessage({
					taskId,
					text: `Skill execution failed after payment settled: ${err.message}`,
					metadata: {
						'x402.payment.status': 'payment-settled',
						'x402.payment.error': err.code || 'HANDLER_FAILED',
						'x402.payment.receipts': [receipt],
					},
				}),
			}),
		);
	}

	const receipts = [
		{
			success: true,
			transaction: settled.transaction,
			network: settled.network,
			payer: settled.payer || verified.payer || null,
		},
	];

	const text =
		typeof handlerResult === 'string'
			? handlerResult
			: handlerResult?.text || 'Payment settled. Skill executed.';
	const artifacts =
		Array.isArray(handlerResult?.artifacts) && handlerResult.artifacts.length
			? handlerResult.artifacts
			: undefined;

	const completedMessage = agentMessage({
		taskId,
		text,
		metadata: {
			'x402.payment.status': 'payment-completed',
			'x402.payment.receipts': receipts,
			'x402.payment.lifecycle': [
				'payment-required',
				'payment-submitted',
				'payment-verified',
				'payment-completed',
			],
			...(handlerResult?.metadata && typeof handlerResult.metadata === 'object'
				? handlerResult.metadata
				: {}),
		},
	});

	return jsonrpcResult(
		reqId,
		task({ id: taskId, state: 'completed', message: completedMessage, artifacts }),
	);
}

// Compose a Vercel-style HTTP handler around `handleA2ARequest`. POSTs are
// JSON-RPC; GETs return the AgentCard fragment so clients can verify the
// extension declaration without a separate /.well-known fetch.
export function a2aPaidEndpoint(spec) {
	const {
		route,
		description,
		priceAtomics = env.X402_MAX_AMOUNT_REQUIRED,
		networks = ['base', 'solana'],
		mimeType = 'application/json',
		payTo,
		services,
		prompt,
		handler,
		skill,
	} = spec;

	if (!route) throw new Error('a2aPaidEndpoint: route is required');
	if (!description) throw new Error('a2aPaidEndpoint: description is required');
	if (typeof handler !== 'function') {
		throw new Error('a2aPaidEndpoint: handler must be a function');
	}

	return async function a2aHandler(req, res) {
		const origin = req.headers.origin;
		res.setHeader('access-control-allow-origin', origin || '*');
		res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
		res.setHeader(
			'access-control-allow-headers',
			`content-type, authorization, ${A2A_EXTENSIONS_HEADER.toLowerCase()}`,
		);
		res.setHeader('access-control-expose-headers', A2A_EXTENSIONS_HEADER);
		if (req.method === 'OPTIONS') {
			res.statusCode = 204;
			res.end();
			return;
		}

		activateExtensionHeader(res);

		const resourceUrl = `${env.APP_ORIGIN}${route}`;

		if (req.method === 'GET') {
			// Discovery: emit a minimal AgentCard fragment so a client can confirm
			// our extension support before sending a paid message.
			res.statusCode = 200;
			res.setHeader('content-type', 'application/json; charset=utf-8');
			res.setHeader('cache-control', 'public, max-age=300');
			res.end(
				JSON.stringify({
					name: skill?.name || 'three.ws A2A paid skill',
					description,
					url: resourceUrl,
					capabilities: {
						streaming: false,
						pushNotifications: false,
						stateTransitionHistory: false,
						extensions: [
							{
								uri: A2A_X402_EXTENSION_URI,
								description: 'Supports payments using the x402 protocol for on-chain settlement.',
								required: true,
							},
						],
					},
					defaultInputModes: ['application/json'],
					defaultOutputModes: [mimeType],
					skills: skill ? [skill] : [],
				}),
			);
			return;
		}

		if (req.method !== 'POST') {
			res.setHeader('allow', 'GET,POST,OPTIONS');
			res.statusCode = 405;
			res.setHeader('content-type', 'application/json; charset=utf-8');
			res.end(JSON.stringify({ error: 'method_not_allowed' }));
			return;
		}

		let body;
		try {
			body = await readJsonBody(req);
		} catch (err) {
			res.statusCode = err.status || 400;
			res.setHeader('content-type', 'application/json; charset=utf-8');
			res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: err.message } }));
			return;
		}

		const rpcReply = await handleA2ARequest({
			req,
			body,
			route,
			resourceUrl,
			description,
			mimeType,
			priceAtomics,
			networks,
			payTo,
			services,
			prompt,
			handler,
		});

		res.statusCode = 200;
		res.setHeader('content-type', 'application/json; charset=utf-8');
		res.setHeader('cache-control', 'no-store');
		res.end(JSON.stringify(rpcReply));
	};
}

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		const limit = 1_000_000;
		req.on('data', (c) => {
			total += c.length;
			if (total > limit) {
				reject(Object.assign(new Error('payload too large'), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on('end', () => {
			if (!chunks.length) return resolve({});
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch (err) {
				reject(Object.assign(new Error(`invalid JSON: ${err.message}`), { status: 400 }));
			}
		});
		req.on('error', reject);
	});
}
