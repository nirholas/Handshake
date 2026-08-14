// Pump protocol program IDs, well-known accounts, and instruction
// discriminators. Ported from pumpkit @pumpkit/core/src/solana/programs.ts.
//
// Canonical references:
//   - Pump bonding curve program
//   - PumpSwap AMM program
//   - PumpFees program
//
// Discriminators are 8-byte Anchor instruction/event prefixes used to classify
// raw instruction data in webhook + RPC log streams without re-deriving them
// from the IDL on every call.

export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const PUMP_FEE_PROGRAM_ID = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
// three.ws agent-payments program: the on-chain escrow that agent tokens
// receive payments into and that `withdraw` pays out from. Mirrors
// PUMP_AGENT_PAYMENTS_PROGRAM_ID exported by @three-ws/agent-payments; kept here
// so a confirm handler can assert the program ran without importing the SDK.
export const PUMP_AGENT_PAYMENTS_PROGRAM_ID = 'AgenTMiC2hvxGebTsgmsD4HHBa8WEcqGFf87iwRRxLo7';
export const PUMPFUN_FEE_ACCOUNT = 'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJ5GEFDM97zC';
export const PUMPFUN_MIGRATION_AUTHORITY = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export const MONITORED_PROGRAM_IDS = Object.freeze([
	PUMP_PROGRAM_ID,
	PUMP_AMM_PROGRAM_ID,
	PUMP_FEE_PROGRAM_ID,
]);

export const CREATE_V2_DISCRIMINATOR = Buffer.from([0x19, 0xe0, 0x63, 0x50, 0x0d, 0x7a, 0xd8, 0x33]);
export const CREATE_DISCRIMINATOR = Buffer.from([0x18, 0x1e, 0xc8, 0x28, 0x05, 0x1c, 0x07, 0x77]);
export const COMPLETE_EVENT_DISCRIMINATOR = Buffer.from([0xe9, 0x17, 0x0d, 0x1e, 0x0e, 0x10, 0x6c, 0x28]);
export const TRADE_EVENT_DISCRIMINATOR = Buffer.from([0xe4, 0x52, 0xf2, 0xd2, 0xb2, 0x32, 0xd1, 0x09]);

const DISCRIMINATORS = {
	create_v2: CREATE_V2_DISCRIMINATOR,
	create: CREATE_DISCRIMINATOR,
	complete_event: COMPLETE_EVENT_DISCRIMINATOR,
	trade_event: TRADE_EVENT_DISCRIMINATOR,
};

export function matchDiscriminator(data) {
	if (!data || data.length < 8) return null;
	const head = Buffer.isBuffer(data) ? data.subarray(0, 8) : Buffer.from(data).subarray(0, 8);
	for (const [name, disc] of Object.entries(DISCRIMINATORS)) {
		if (head.equals(disc)) return name;
	}
	return null;
}
