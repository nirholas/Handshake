// Library surface, for embedding the custody model outside MCP: a web app, a
// script, an agent framework. Everything here is plain web3.js and spl-token.

export {
	assertAgentId,
	seedFor,
	vaultAddress,
	createVaultInstructions,
	approveInstruction,
	revokeInstruction,
	depositInstructions,
	withdrawInstructions,
	delegatedTransferInstructions,
	readVault,
	spendableUnits,
} from './vault.js';

export { DEFAULT_POLICY, normalizePolicy, normalizeHost, evaluateSpend, spentInWindow } from './policy.js';

export {
	USDC_MINT,
	MIN_AGENT_FEE_LAMPORTS,
	connectionFor,
	keypairFrom,
	toPublicKey,
	solBalance,
	mintDecimals,
	tokenProgramFor,
	toBaseUnits,
	fromBaseUnits,
	tokenAccount,
	ataFor,
	txLink,
	accountLink,
} from './solana.js';

export { buildTransaction, sendWithSigners, prepareForWallet, sendSignedBase64 } from './tx.js';

export { probeResource, selectRequirement, requiredUnits, payAndFetch, clusterOf } from './x402.js';

export { agentContext, authorizeSpend, assertDelegated, describeAgent, logSpend } from './agent.js';
