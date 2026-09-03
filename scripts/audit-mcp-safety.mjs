#!/usr/bin/env node
// Build gate: every MCP tool's declared safety annotations must match what its
// handler actually does.
//
// Why this gate exists. MCP `annotations` are not decoration: clients read them
// to decide whether to run a tool without asking the user. `readOnlyHint: true`
// means "this does not modify its environment", and a client that trusts it will
// auto-approve the call. three.ws exposes tools that mint on Solana, settle x402
// payments, and write to the database, so a tool that mutates while advertising
// itself read-only converts a client's auto-approve path into an unattended
// state change. That is the protocol-layer version of the confirm-before-you-
// spend rule the money-moving surfaces already follow.
//
// Until now nothing checked those hints. `audit-mcp-golden.mjs` snapshots them,
// which catches a CHANGE to an annotation but never asks whether it was right:
// a tool born mislabeled stays mislabeled, and `--update` bakes in the next one.
//
// What it checks, per tool, from the AST (never from the tool's name -- a
// name-only heuristic flags `vanity_open` and `link_agent`, which are both
// genuinely read-only, and misses `persona_tip`, which spends):
//   1. readOnlyHint: true + evidence the handler mutates            -> FAIL
//   2. handler moves funds or mints + destructiveHint: false        -> FAIL
//      (an irreversible transfer is the definition of destructive)
//   3. annotations missing entirely                                 -> FAIL
//      (destructiveHint defaults to TRUE when omitted, so an unannotated tool
//      is advertised as destructive; that is safe but always unintended)
//
// Evidence is the handler's transitive call closure: `sql` template tags opening
// with insert/update/delete, plus calls to the known transaction-signing and
// payment-settling helpers. Same-module calls are followed to any depth, and a
// call into an imported function is followed one module hop.
//
// Following a CALL is evidence; merely importing a module that could mutate is
// not. That distinction is load-bearing: a dozen genuinely read-only tools share
// one Solana RPC helper, and treating the import as evidence flagged them all.
//
// Cache and telemetry writes are real writes that are not semantic mutations
// (warming a cache on read, recording usage). Those are exempted individually in
// EXEMPTIONS below, each with a reason, so an exemption is a reviewed line in
// this file rather than a silent hole in the gate.
//
// Run: node scripts/audit-mcp-safety.mjs   (exit 1 on any violation)
//      node scripts/audit-mcp-safety.mjs --list   (print every tool + evidence)

import { mcpToolSources } from './lib/mcp-tool-sources.mjs';
import { checkTool, extractTools } from './lib/mcp-safety-check.mjs';

// ---------------------------------------------------------------------------
// Reviewed exemptions
// ---------------------------------------------------------------------------
// A tool listed here keeps `readOnlyHint: true` despite carrying write evidence,
// because the evidence is not the effect the caller receives. Keyed
// `tool:evidence`; every entry states why. Two reviewed categories:
//
// 1. Read-through cache fills: the caller asked for a read and got a read, and
//    the server warmed its own cache on the way. Each write is wrapped
//    non-fatally at the source, so a failed write still returns the read.
// 2. Transaction BUILDERS that broadcast nothing: the handler assembles an
//    unsigned transaction and returns its bytes for a wallet to sign elsewhere.
//    Instruction constructors (umi's `transferSol`, Metaplex's `mintAsset`) read
//    as transfers and mints to the call-closure scan, but calling one appends an
//    instruction to a builder; it moves no funds and touches no chain. Auto-
//    approving such a call is genuinely safe: nothing changes until the owner
//    signs and some OTHER tool broadcasts. Only add an entry here after checking
//    the handler never reaches a send (`sendAndConfirm`, `hedgedSend`) and never
//    signs with a real keypair.
const EXEMPTIONS = new Map([
	[
		'oracle_coin:db-write',
		'scoreCoin(..., { persist: true }) caches the conviction verdict it just computed (upsertConviction/upsertNarrative, both non-fatal) so the next read is warm.',
	],
	[
		'solana_agent_reputation:db-write',
		'ensureWarm() crawls attestations into the cache on a cold read; the caller receives a computed reputation summary.',
	],
	[
		'solana_agent_attestations:db-write',
		'ensureWarm() crawls attestations into the cache on a cold read; the caller receives the attestation list.',
	],
	[
		'solana_agent_passport:db-write',
		'ensureWarm() crawls attestations into the cache on a cold read; the caller receives the passport view.',
	],
	[
		'grade_sim_readiness:db-write',
		'Read-through cache fill (category 1). gradeForCaller() answers from getGrade() when the content hash is already known; on a miss it grades the mesh it just fetched and calls putGrade() to warm sim_readiness_grades. putGrade() wraps its insert in try/catch and returns null on failure, so the caller receives the same grade whether or not the write lands.',
	],
	[
		'prepare_agent_mint:funds-transfer',
		'Builder, not sender (category 2). buildAgentMint() calls umi transferSol() to APPEND the mainnet deploy-fee instruction to the mint builder; the handler signs only with the new asset keypair, serializes to txs_base64 with the caller wallet as a noop fee payer, and returns. It never broadcasts. The sibling that does broadcast, mint_onchain_agent, is annotated readOnlyHint:false + destructiveHint:true.',
	],
]);

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const sources = mcpToolSources();
const violations = [];
const exempted = [];
const rows = [];

for (const relPath of sources) {
	const { parseError, tools } = extractTools(relPath);
	if (parseError) {
		violations.push(`${relPath}: could not parse (${parseError})`);
		continue;
	}
	for (const tool of tools) {
		rows.push({ file: relPath, ...tool });
		const result = checkTool(tool, `${relPath}: ${tool.name}`, EXEMPTIONS);
		violations.push(...result.violations);
		exempted.push(...result.exempted);
	}
}

if (process.argv.includes('--list')) {
	for (const row of rows) {
		const ann = row.annotations.values;
		const flags = `ro=${ann.readOnlyHint ?? '-'} destr=${ann.destructiveHint ?? '-'}`;
		const ev = row.evidence.length ? row.evidence.join(',') : '-';
		const handler = row.hasHandler ? '' : ' (no local handler)';
		console.log(`${row.name.padEnd(30)} ${flags.padEnd(22)} ${ev.padEnd(24)} ${row.file}${handler}`);
	}
}

const toolCount = rows.length;
if (violations.length) {
	for (const violation of violations) console.error(`[audit:mcp-safety] ${violation}`);
	console.error(
		`\n[audit:mcp-safety] ${violations.length} annotation violation(s) across ${toolCount} tools in ${sources.length} files.`,
	);
	process.exit(1);
}

const exemptNote = exempted.length ? `, ${exempted.length} reviewed exemption(s)` : '';
console.log(
	`[audit:mcp-safety] ${toolCount} MCP tool annotations verified against handler behavior across ${sources.length} files${exemptNote}`,
);
