// The atomic Genesis-style mint: one transaction that creates a Metaplex Core
// asset AND registers its Agent Identity in the Metaplex Agent Registry.
//
// Shape (mirrors the three.ws Genesis 333, verified against the live assets):
//   • asset uri            data: URI of { name, image, animation_url }
//   • Royalties plugin     500 bps to the owner by default, ruleSet None
//   • VerifiedCreators     the signing wallet, verified (it signs this tx)
//   • ImmutableMetadata    on by default
//   • AgentIdentity        data: URI of the EIP-8004 registration document
//
// Every knob is exposed: royalty split, extra creators, attributes, permanent
// delegate plugins, collection membership, a different owner, and full control
// of both JSON documents (or complete URI overrides).

import { create, ruleSet } from '@metaplex-foundation/mpl-core';
import { generateSigner, publicKey as umiPublicKey } from '@metaplex-foundation/umi';
import { registerIdentityV1 } from '@metaplex-foundation/mpl-agent-registry';

import {
	buildAssetMetadata,
	buildRegistrationDoc,
	chainRegistration,
	threeWsRegistration,
	jsonDataUri,
} from './registration.js';

/**
 * Genesis-style plugin list for a Core `create`.
 * @param {object} p
 * @param {string} p.creator base58 wallet that signs the mint (royalty + verified-creator default)
 */
export function buildPlugins({
	creator,
	royaltyBasisPoints = 500,
	royaltyCreators,
	verifiedCreator = true,
	immutableMetadata = true,
	attributes,
	permanentFreeze = false,
	permanentTransfer = false,
	permanentBurn = false,
	addBlocker = false,
} = {}) {
	const plugins = [];
	const bps = Number(royaltyBasisPoints);
	if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
		throw Object.assign(new Error(`royalty_basis_points must be an integer 0..10000 (got ${royaltyBasisPoints})`), {
			code: 'validation_error',
		});
	}
	if (bps > 0) {
		const creators = (royaltyCreators?.length ? royaltyCreators : [{ address: creator, percentage: 100 }]).map(
			(c) => ({ address: umiPublicKey(c.address), percentage: Number(c.percentage) }),
		);
		const total = creators.reduce((sum, c) => sum + c.percentage, 0);
		if (total !== 100) {
			throw Object.assign(new Error(`royalty creator percentages must sum to 100 (got ${total})`), {
				code: 'validation_error',
			});
		}
		plugins.push({ type: 'Royalties', basisPoints: bps, creators, ruleSet: ruleSet('None') });
	}
	if (verifiedCreator) {
		plugins.push({
			type: 'VerifiedCreators',
			signatures: [{ address: umiPublicKey(creator), verified: true }],
		});
	}
	if (immutableMetadata) plugins.push({ type: 'ImmutableMetadata' });
	if (Array.isArray(attributes) && attributes.length) {
		plugins.push({
			type: 'Attributes',
			attributeList: attributes.map((a) => ({ key: String(a.key), value: String(a.value) })),
		});
	}
	if (permanentFreeze) plugins.push({ type: 'PermanentFreezeDelegate', frozen: false });
	if (permanentTransfer) plugins.push({ type: 'PermanentTransferDelegate' });
	if (permanentBurn) plugins.push({ type: 'PermanentBurnDelegate' });
	if (addBlocker) plugins.push({ type: 'AddBlocker' });
	return plugins;
}

/**
 * Assemble the whole mint: documents, URIs, and the single-transaction builder
 * (`create` + `registerIdentityV1`). The caller decides how to sign it:
 * `sendAndConfirm` with a keypair identity, or `buildAndSign` behind a noop
 * signer for the Phantom/Solflare prepare flow.
 *
 * @returns {{ builder, assetSigner, assetMetadata, metadataUri, registration, registrationUri }}
 */
export function buildAgentMint(umi, {
	network,
	creator,
	owner,
	collection,
	name,
	description = '',
	image,
	modelUrl,
	externalUrl,
	metadataAttributes,
	metadataUri,
	services,
	active = true,
	x402Support = false,
	registrations,
	threeWsAgentId,
	supportedTrust,
	registrationUri,
	royaltyBasisPoints,
	royaltyCreators,
	verifiedCreator,
	immutableMetadata,
	attributes,
	permanentFreeze,
	permanentTransfer,
	permanentBurn,
	addBlocker,
} = {}) {
	const assetSigner = generateSigner(umi);
	const assetAddress = assetSigner.publicKey.toString();

	const assetMetadata = metadataUri
		? null
		: buildAssetMetadata({ name, image, animationUrl: modelUrl, description: undefined, externalUrl, attributes: metadataAttributes });
	const uri = metadataUri || jsonDataUri(assetMetadata);

	const regEntries = registrations?.length
		? registrations
		: threeWsAgentId
			? [threeWsRegistration(threeWsAgentId)]
			: [chainRegistration(assetAddress, network)];
	const registration = registrationUri
		? null
		: buildRegistrationDoc({
				name,
				description,
				image,
				modelUrl,
				services,
				active,
				x402Support,
				registrations: regEntries,
				supportedTrust,
			});
	const agentRegistrationUri = registrationUri || jsonDataUri(registration);

	const createArgs = {
		asset: assetSigner,
		name,
		uri,
		plugins: buildPlugins({
			creator,
			royaltyBasisPoints,
			royaltyCreators,
			verifiedCreator,
			immutableMetadata,
			attributes,
			permanentFreeze,
			permanentTransfer,
			permanentBurn,
			addBlocker,
		}),
	};
	if (owner) createArgs.owner = umiPublicKey(owner);
	if (collection) createArgs.collection = umiPublicKey(collection);

	const registerArgs = { asset: assetSigner.publicKey, agentRegistrationUri };
	if (collection) registerArgs.collection = umiPublicKey(collection);

	const builder = create(umi, createArgs).add(registerIdentityV1(umi, registerArgs));

	return { builder, assetSigner, assetMetadata, metadataUri: uri, registration, registrationUri: agentRegistrationUri };
}
