#!/usr/bin/env node
// Open Inference Protocol (OIN) v0.1 conformance runner.
//
// Drives a live OIN node through the whole protocol and verifies every
// signature it produces with the reference verifier (api/_lib/oin-verify.js):
//
//   1. GET /.well-known/oin        -> verify the advertisement signature
//   2. POST /oin/jobs              -> submit a job envelope for an advertised
//                                     capability, check the returned digest
//   3. GET /oin/jobs/:id           -> poll to a terminal state
//   4. verifyResponse(job, res)    -> spec rules 1-5
//   5. verifyOutput(res)           -> spec rule 6, fetch and hash the artifact
//
// This is the tool that proves a node speaks the protocol, whether it is one of
// the platform's own workers or a third-party operator's machine. It fetches
// nothing but the node's own routes and the artifact URL the node signed.
//
// Usage:
//   node scripts/oin-conformance.mjs --node <base-url>
//       [--api-key <bearer>]        credential when the node advertises bearer
//       [--capability <key>]        default: the first advertised capability
//       [--model <name>]            default: the first model of that capability
//       [--input <https url>]       payload reference for input.data
//       [--params <json>]           capability params object
//       [--timeout <seconds>]       poll ceiling, default 180
//       [--no-output-check]         skip rule 6 (do not fetch the artifact)
//       [--json]                    machine-readable transcript
//
// Exit code 0 = every check passed; 1 = a check failed; 2 = usage error.
// Spec: specs/OPEN_INFERENCE_PROTOCOL.md.

import { randomBytes } from 'node:crypto';

import {
	digestJob,
	verifyAdvertisement,
	verifyOutput,
	verifyResponse,
} from '../api/_lib/oin-verify.js';

const DEFAULT_TIMEOUT_S = 180;
const POLL_INTERVAL_MS = 1500;

function usage(exitCode) {
	const msg = `usage: node scripts/oin-conformance.mjs --node <base-url>
              [--api-key <bearer>] [--capability <key>] [--model <name>]
              [--input <https url>] [--params <json>] [--timeout <seconds>]
              [--no-output-check] [--json]`;
	if (exitCode === 0) console.log(msg);
	else console.error(msg);
	process.exit(exitCode);
}

function parseArgs(argv) {
	const args = { outputCheck: true, json: false, timeout: DEFAULT_TIMEOUT_S };
	const rest = [...argv];
	while (rest.length) {
		const flag = rest.shift();
		if (flag === '--node') args.node = rest.shift();
		else if (flag === '--api-key') args.apiKey = rest.shift();
		else if (flag === '--capability') args.capability = rest.shift();
		else if (flag === '--model') args.model = rest.shift();
		else if (flag === '--input') args.input = rest.shift();
		else if (flag === '--params') args.params = rest.shift();
		else if (flag === '--timeout') args.timeout = Number(rest.shift());
		else if (flag === '--no-output-check') args.outputCheck = false;
		else if (flag === '--json') args.json = true;
		else if (flag === '--help' || flag === '-h') usage(0);
		else {
			console.error(`unknown flag: ${flag}`);
			usage(2);
		}
	}
	if (!args.node) usage(2);
	if (!Number.isFinite(args.timeout) || args.timeout <= 0) {
		console.error('--timeout must be a positive number of seconds');
		usage(2);
	}
	args.node = args.node.replace(/\/+$/, '');
	return args;
}

const steps = [];

function record(name, ok, detail) {
	steps.push({ step: name, ok, detail });
	return ok;
}

function report(args, ok) {
	if (args.json) {
		console.log(JSON.stringify({ ok, node: args.node, steps }, null, 2));
		return;
	}
	for (const s of steps) {
		console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${s.step}${s.detail ? `: ${s.detail}` : ''}`);
	}
	console.log(ok ? '\nOIN conformance: PASS' : '\nOIN conformance: FAIL');
}

function authHeaders(args) {
	return args.apiKey ? { Authorization: `Bearer ${args.apiKey}` } : {};
}

async function readJson(res) {
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
	const args = parseArgs(process.argv.slice(2));

	// Step 1: the advertisement, and its signature.
	let advertisement;
	try {
		const res = await fetch(`${args.node}/.well-known/oin`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		advertisement = await readJson(res);
	} catch (err) {
		record('advertisement fetched', false, err?.message || String(err));
		report(args, false);
		return 1;
	}
	record('advertisement fetched', true, `node_id=${advertisement.node_id}`);

	const adVerdict = verifyAdvertisement(advertisement);
	if (!record('advertisement signature verified', adVerdict.ok, adVerdict.verdict + (adVerdict.detail ? ` (${adVerdict.detail})` : ''))) {
		report(args, false);
		return 1;
	}

	// Step 2: pick a capability and submit a job envelope against it.
	const capability = args.capability || advertisement.capabilities[0]?.key;
	const capEntry = advertisement.capabilities.find((c) => c.key === capability);
	if (!capEntry) {
		record('capability advertised', false, `${capability} is not in the advertisement`);
		report(args, false);
		return 1;
	}
	record('capability advertised', true, capability);

	const model = args.model || capEntry.models?.[0];
	if (!args.input) {
		record('job input supplied', false, '--input <https url> is required to run a job');
		report(args, false);
		return 1;
	}

	const job = {
		spec: 'oin/0.1',
		job_id: `j_conf_${randomBytes(8).toString('hex')}`,
		capability,
		created_at: new Date().toISOString(),
		deadline: args.timeout,
		input: { model, data: args.input },
	};
	if (args.params) {
		try {
			job.params = JSON.parse(args.params);
		} catch {
			console.error('--params must be a JSON object');
			return 2;
		}
	}

	let submitted;
	try {
		const res = await fetch(`${args.node}/oin/jobs`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...authHeaders(args) },
			body: JSON.stringify(job),
		});
		submitted = await readJson(res);
		if (res.status !== 202) throw new Error(`expected 202, got ${res.status}: ${JSON.stringify(submitted).slice(0, 200)}`);
	} catch (err) {
		record('job accepted (202)', false, err?.message || String(err));
		report(args, false);
		return 1;
	}
	record('job accepted (202)', true, submitted.job_id);

	// The node echoes the digest it computed; a mismatch here means the two
	// sides disagree on canonicalization, which would fail rule 2 later anyway.
	const expectedDigest = digestJob(job);
	if (!record(
		'node job_digest matches the requester digest',
		submitted.job_digest === expectedDigest,
		submitted.job_digest === expectedDigest ? expectedDigest : `node=${submitted.job_digest} requester=${expectedDigest}`,
	)) {
		report(args, false);
		return 1;
	}

	// Step 3: poll to a terminal state.
	const deadlineMs = Date.now() + args.timeout * 1000;
	let response = null;
	let lastStatus = 'unknown';
	while (Date.now() < deadlineMs) {
		await sleep(POLL_INTERVAL_MS);
		let polled;
		try {
			const res = await fetch(`${args.node}/oin/jobs/${job.job_id}`, { headers: authHeaders(args) });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			polled = await readJson(res);
		} catch (err) {
			record('job polled to a terminal state', false, err?.message || String(err));
			report(args, false);
			return 1;
		}
		lastStatus = polled.status;
		if (polled.status === 'done' || polled.status === 'failed') {
			response = polled;
			break;
		}
	}
	if (!response) {
		record('job polled to a terminal state', false, `still ${lastStatus} after ${args.timeout}s`);
		report(args, false);
		return 1;
	}
	record('job polled to a terminal state', true, response.status);

	// Step 4: rules 1-5, against the advertised key.
	const verdict = verifyResponse(job, response, { expectedPubkey: advertisement.node_pubkey });
	if (!record(
		'signed response verified (spec rules 1-5)',
		verdict.ok,
		verdict.verdict + (verdict.detail ? ` (${verdict.detail})` : ''),
	)) {
		report(args, false);
		return 1;
	}

	// A signed failure is a valid protocol outcome and verifies like any other
	// response, but it is not a passing conformance run: the node did not do the
	// work, so there is no artifact to check.
	if (response.status === 'failed') {
		record('job succeeded', false, `${response.error?.code}: ${response.error?.message}`);
		report(args, false);
		return 1;
	}

	// Step 5: rule 6, the artifact bytes behind the signature.
	if (args.outputCheck) {
		const outVerdict = await verifyOutput(response);
		if (!record(
			'output artifact verified (spec rule 6)',
			outVerdict.ok,
			outVerdict.verdict + (outVerdict.detail ? ` (${outVerdict.detail})` : ` ${outVerdict.bytes} bytes`),
		)) {
			report(args, false);
			return 1;
		}
	} else {
		record('output artifact verified (spec rule 6)', true, 'skipped (verified_unfetched_output)');
	}

	report(args, true);
	return 0;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error(`oin-conformance: ${err?.stack || err}`);
		process.exit(1);
	},
);
