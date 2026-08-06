/**
 * ERC-8004 validation report — the canonical, dependency-light shape that both
 * the browser recorder (src/erc8004/validation-recorder.js) and the server
 * attestor (api/_lib/validation-attest.js) hash and pin.
 *
 * One source of truth for "is this GLB valid": the platform's glTF inspector
 * (src/gltf-inspect.js, surfaced as /api/x402/model-check). A GLB that the
 * inspector can parse is structurally valid (zero errors); a GLB that throws is
 * invalid (one error). Optimization suggestions ride along as warnings/infos —
 * they never fail a model.
 *
 * The report is byte-stable for a given build: keys are written in a fixed order
 * so `JSON.stringify` is deterministic, which means `hashReport()` over the
 * pinned bytes reproduces the on-chain `proofHash`. A verifier fetches
 * `proofURI`, re-stringifies, re-hashes, and compares.
 */

import { AbiCoder, keccak256, toUtf8Bytes } from 'ethers';

export const KIND_GLB_SCHEMA = 'glb-schema';

/**
 * The deployed ERC-8004 ValidationRegistry stores a 0..100 `response` score, not
 * a boolean. A glTF schema check is binary, so we write the two extremes and read
 * back through a midpoint threshold. Three-way state, because the registry keeps
 * an unanswered request on chain too:
 *
 *   tag === ''            → requested, no response yet (pending)
 *   response >= threshold → passed
 *   response <  threshold → failed
 */
export const VALIDATION_RESPONSE_PASS = 100;
export const VALIDATION_RESPONSE_FAIL = 0;
export const VALIDATION_RESPONSE_PASS_THRESHOLD = 50;

/**
 * Canonical id for a validation request on the ERC-8004 ValidationRegistry.
 *
 * The registry keys every validation by an opaque bytes32 the requester chooses,
 * so deriving it instead of randomizing it makes the flow idempotent: the same
 * (chain, agent, kind, subject) always maps to the same request, so answering
 * again updates that record in place rather than piling up duplicates, and a
 * different subject always gets its own request.
 *
 * @param {object} p
 * @param {number} p.chainId
 * @param {string|number|bigint} p.agentId
 * @param {string} p.seed  0x-prefixed 32-byte hex identifying what is validated
 *                         (the GLB's sha256 for a model check, the report hash
 *                         when the report itself is the subject).
 * @param {string} [p.kind]
 * @returns {string} 0x-prefixed 32-byte hex.
 */
export function validationRequestHash({ chainId, agentId, seed, kind = KIND_GLB_SCHEMA }) {
	return keccak256(
		AbiCoder.defaultAbiCoder().encode(
			['uint256', 'uint256', 'string', 'bytes32'],
			[BigInt(chainId), BigInt(agentId), kind, seed],
		),
	);
}

/**
 * Map an on-chain `response` score to our boolean pass/fail.
 * @param {number|bigint} response
 * @returns {boolean}
 */
export function responsePassed(response) {
	return Number(response) >= VALIDATION_RESPONSE_PASS_THRESHOLD;
}

/**
 * Score to write for a report's outcome.
 * @param {boolean} passed
 * @returns {number}
 */
export function responseForPassed(passed) {
	return passed ? VALIDATION_RESPONSE_PASS : VALIDATION_RESPONSE_FAIL;
}

// glTF-Validator severity convention, reused so the report reads the same to any
// tool that already understands Khronos reports: 0=Error 1=Warning 2=Info 3=Hint.
export const SEVERITY = { ERROR: 0, WARNING: 1, INFO: 2, HINT: 3 };

const SUGGESTION_SEVERITY = {
	critical: SEVERITY.ERROR,
	warn: SEVERITY.WARNING,
	info: SEVERITY.INFO,
	hint: SEVERITY.HINT,
};

/**
 * Derive a deterministic pass/fail flag from a validation report.
 * Pass = zero errors. Warnings, infos and hints are allowed.
 * @param {{ issues?: { numErrors?: number } }} report
 * @returns {boolean}
 */
export function reportPassed(report) {
	const errs = (report && report.issues && report.issues.numErrors) || 0;
	return errs === 0;
}

/**
 * keccak256 over the canonicalized JSON report, suitable for an on-chain proof.
 * @param {object} report
 * @returns {string} 0x-prefixed 32-byte hex.
 */
export function hashReport(report) {
	return keccak256(toUtf8Bytes(JSON.stringify(report)));
}

/**
 * Build the canonical glb-schema validation report from a glTF inspection.
 *
 * @param {object}  p
 * @param {string}  p.url                       Resolved GLB URL that was validated.
 * @param {string}  [p.sha256]                  sha256 of the exact bytes fetched (independent byte-check).
 * @param {number}  [p.byteLength]              Size of the fetched model in bytes.
 * @param {object}  [p.inspect]                 Output of inspectModel() — null on parse failure.
 * @param {Array<{id:string,severity:string,message:string,estimate?:string}>} [p.suggestions]
 *                                              Output of suggestOptimizations().
 * @param {string|null} [p.error]               Parse error message → records one hard error.
 * @param {string}  p.validatedAt               ISO timestamp the validation ran (caller-supplied; never Date.now() here).
 * @returns {object} Canonical report. `issues.numErrors === 0` ⇒ passing.
 */
export function buildGlbReport({
	url,
	sha256 = null,
	byteLength = null,
	inspect = null,
	suggestions = [],
	error = null,
	validatedAt,
}) {
	const messages = [];

	if (error) {
		messages.push({
			severity: SEVERITY.ERROR,
			code: 'GLB_PARSE_FAILED',
			message: String(error),
			pointer: '',
		});
	}

	for (const s of suggestions) {
		const severity = SUGGESTION_SEVERITY[s.severity] ?? SEVERITY.INFO;
		messages.push({
			severity,
			code: String(s.id || 'SUGGESTION').toUpperCase(),
			message: s.estimate ? `${s.message} (${s.estimate})` : s.message,
			pointer: '',
		});
	}

	const count = (sev) => messages.filter((m) => m.severity === sev).length;

	return {
		kind: KIND_GLB_SCHEMA,
		spec: 'erc-8004/validation/glb-schema@1',
		validatedAt,
		uri: url || '',
		validator: {
			name: 'three.ws glTF inspector',
			tool: '@gltf-transform/core',
			endpoint: '/api/x402/model-check',
		},
		// The byte-check is surfaced INDEPENDENTLY of the pass/fail flag, per spec:
		// a passing schema validation never overrides the sha256 byte identity.
		byteCheck: {
			sha256: sha256 || null,
			byteLength: byteLength ?? (inspect ? inspect.fileSize ?? null : null),
		},
		issues: {
			numErrors: count(SEVERITY.ERROR),
			numWarnings: count(SEVERITY.WARNING),
			numInfos: count(SEVERITY.INFO),
			numHints: count(SEVERITY.HINT),
			messages,
		},
		model: inspect,
	};
}

/**
 * Human-readable one-line reason a report failed (or '' when it passed).
 * @param {object} report
 * @returns {string}
 */
export function failureReason(report) {
	if (reportPassed(report)) return '';
	const errs = report?.issues?.messages?.filter((m) => m.severity === SEVERITY.ERROR) || [];
	if (errs.length === 0) return 'validation failed';
	if (errs.length === 1) return errs[0].message;
	return `${errs.length} errors: ${errs[0].message}`;
}
