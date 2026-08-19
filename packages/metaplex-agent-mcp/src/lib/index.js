// Library surface for embedding the Genesis-style mint outside MCP (web apps,
// scripts, the three.ws deploy page). Everything here is pure Umi + fetch.

export {
	EIP_8004_REGISTRATION_TYPE,
	jsonDataUri,
	buildAssetMetadata,
	buildRegistrationDoc,
	chainRegistration,
	threeWsRegistration,
	decodeJsonUri,
} from './registration.js';

export {
	buildPlugins,
	buildAgentMint,
	sendAgentMint,
	waitForAsset,
	isAssetPropagationError,
} from './mint.js';

export {
	LAMPORTS_PER_SOL,
	EST_MINT_LAMPORTS,
	EST_REGISTER_LAMPORTS,
	parseSecretKey,
	buildUmi,
	solBalance,
	assetSignerAddress,
	agentLinks,
	txLink,
	toBase58Signature,
} from './solana.js';
