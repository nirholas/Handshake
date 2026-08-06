export {
	IDENTITY_REGISTRY_ABI,
	REPUTATION_REGISTRY_ABI,
	VALIDATION_REGISTRY_ABI,
	REGISTRY_DEPLOYMENTS,
	agentRegistryId,
} from './abi.js';
export {
	connectWallet,
	eagerConnectWallet,
	ensureWallet,
	disconnectWallet,
	getWalletState,
	getSigner,
	onWalletChange,
	registerAgent,
	buildRegistrationJSON,
	pinFile,
} from './agent-registry.js';
export { RegisterUI } from './register-ui.js';
export { submitReputation, submitFeedback, getReputation, getRecentReviews } from './reputation.js';
export {
	recordValidation,
	getValidations,
	getLatestValidation,
	reportPassed,
	hashReport,
} from './validation-recorder.js';
