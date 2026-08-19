// Local state: agent records, guardrail policies, and the append-only spend
// ledger. One JSON file per network, written 0600 inside a 0700 directory,
// because it holds agent secret keys.
//
// It deliberately holds no owner key and no custody: every record here is
// reconstructible from the chain (the vault address is derived from the owner
// pubkey plus the agent id, and the live allowance is read from the token
// account). Losing this file loses the agent's fee key and its history, never
// the owner's money.

import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { STATE_DIR, STATE_FILE, NETWORK } from '../config.js';

const EMPTY = { version: 1, network: NETWORK, agents: {}, ledger: [] };

// Keep the ledger bounded so a long-running agent cannot grow the file without
// limit. 5000 entries is months of traffic and still a small file.
const MAX_LEDGER = 5000;

function ensureDir() {
	mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

export function readState() {
	if (!existsSync(STATE_FILE)) return structuredClone(EMPTY);
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
	} catch (err) {
		throw Object.assign(
			new Error(`state file at ${STATE_FILE} is not valid JSON: ${err.message}. Move it aside to start fresh.`),
			{ code: 'bad_state' },
		);
	}
	return { ...structuredClone(EMPTY), ...parsed, agents: parsed.agents || {}, ledger: parsed.ledger || [] };
}

export function writeState(state) {
	ensureDir();
	const tmp = `${STATE_FILE}.${process.pid}.tmp`;
	const payload = { ...state, ledger: (state.ledger || []).slice(-MAX_LEDGER) };
	writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, STATE_FILE);
	chmodSync(STATE_FILE, 0o600);
	return STATE_FILE;
}

/** Read, mutate, write. The only supported way to change state. */
export function updateState(mutator) {
	const state = readState();
	const result = mutator(state);
	writeState(state);
	return result;
}

export function getAgent(id) {
	const agent = readState().agents[String(id || '').trim()];
	if (!agent) {
		throw Object.assign(
			new Error(`no agent wallet named "${id}". Run list_agent_wallets, or create_agent_wallet to make one.`),
			{ code: 'unknown_agent' },
		);
	}
	return agent;
}

export function listAgents() {
	return Object.values(readState().agents);
}

/** Append one spend decision to the ledger. Called for allows AND denials. */
export function recordSpend(entry) {
	return updateState((state) => {
		const row = { at: new Date().toISOString(), ...entry };
		state.ledger.push(row);
		return row;
	});
}

/** Ledger rows for one agent, newest last. */
export function spendHistory(agentId, { since } = {}) {
	const cutoff = since ? new Date(since).getTime() : 0;
	return readState().ledger.filter(
		(row) => row.agent === agentId && (!cutoff || new Date(row.at).getTime() >= cutoff),
	);
}

export const stateLocation = () => ({ dir: STATE_DIR, file: STATE_FILE, parent: dirname(STATE_FILE) });
