// Byte-exact Genesis-333 reproduction.
//
// The fixtures below are the LIVE on-chain URIs of three.ws Genesis #332
// ("mao", Core asset 9Mx9XgSHRJrgqS77t8hTtDPYtX995M87Wi7TRKgkQ3Vy), read from
// mainnet. The builders must reproduce them byte for byte from their decoded
// fields; if a refactor reorders a key or changes serialization, these tests
// fail before a mint ever ships a drifted shape. Offline: no RPC, no fetch.
//
// Run: node --test packages/metaplex-agent-mcp/test/genesis-shape.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	buildAssetMetadata,
	buildRegistrationDoc,
	threeWsRegistration,
	chainRegistration,
	jsonDataUri,
	decodeJsonUri,
	EIP_8004_REGISTRATION_TYPE,
} from '../src/lib/registration.js';
import { buildPlugins } from '../src/lib/mint.js';

// Asset metadata URI of Genesis #332, verbatim from the asset account.
const MAO_METADATA_URI =
	'data:application/json;base64,eyJuYW1lIjoibWFvIiwiaW1hZ2UiOiJodHRwczovL3B1Yi0yNTM0ZTkyMWJmOWM0MzE0YWRkY2Q0ZDhhNmU5OGI3Yi5yMi5kZXYvdGh1bWIvN2I5MWIwNmUtNDE5My00NjEwLTg5MmUtNmRmZTM0OTM5ZWI2LnBuZyIsImFuaW1hdGlvbl91cmwiOiJodHRwczovL3B1Yi0yNTM0ZTkyMWJmOWM0MzE0YWRkY2Q0ZDhhNmU5OGI3Yi5yMi5kZXYvdS82YTQ1ZmMwNi0wNWEyLTQxNmQtYjA5Yy1jZGU5ZTg1NTNjOWQvZHJhZnQtd3N6cjNuL21wa3A4MWNzLmdsYiJ9';

// Agent Identity registration URI of Genesis #332, verbatim from the
// AgentIdentity plugin on the asset.
const MAO_REGISTRATION_URI =
	'data:application/json;base64,eyJ0eXBlIjoiaHR0cHM6Ly9laXBzLmV0aGVyZXVtLm9yZy9FSVBTL2VpcC04MDA0I3JlZ2lzdHJhdGlvbi12MSIsIm5hbWUiOiJtYW8iLCJkZXNjcmlwdGlvbiI6InRocmVlLndzIEdlbmVzaXMgIzMzMiIsImltYWdlIjoiaHR0cHM6Ly9wdWItMjUzNGU5MjFiZjljNDMxNGFkZGNkNGQ4YTZlOThiN2IucjIuZGV2L3RodW1iLzdiOTFiMDZlLTQxOTMtNDYxMC04OTJlLTZkZmUzNDkzOWViNi5wbmciLCJtb2RlbCI6eyJ1cmkiOiJodHRwczovL3B1Yi0yNTM0ZTkyMWJmOWM0MzE0YWRkY2Q0ZDhhNmU5OGI3Yi5yMi5kZXYvdS82YTQ1ZmMwNi0wNWEyLTQxNmQtYjA5Yy1jZGU5ZTg1NTNjOWQvZHJhZnQtd3N6cjNuL21wa3A4MWNzLmdsYiJ9LCJhY3RpdmUiOnRydWUsIng0MDJTdXBwb3J0Ijp0cnVlLCJyZWdpc3RyYXRpb25zIjpbeyJhZ2VudElkIjoiN2I5MWIwNmUtNDE5My00NjEwLTg5MmUtNmRmZTM0OTM5ZWI2IiwiYWdlbnRSZWdpc3RyeSI6Imh0dHBzOi8vdGhyZWUud3MifV0sInN1cHBvcnRlZFRydXN0IjpbInJlcHV0YXRpb24iXX0=';

test('asset metadata rebuilds Genesis #332 byte for byte', async () => {
	const decoded = await decodeJsonUri(MAO_METADATA_URI);
	assert.ok(decoded, 'fixture must decode');
	const rebuilt = buildAssetMetadata({
		name: decoded.name,
		image: decoded.image,
		animationUrl: decoded.animation_url,
	});
	assert.equal(jsonDataUri(rebuilt), MAO_METADATA_URI);
});

test('registration document rebuilds Genesis #332 byte for byte', async () => {
	const decoded = await decodeJsonUri(MAO_REGISTRATION_URI);
	assert.ok(decoded, 'fixture must decode');
	assert.equal(decoded.type, EIP_8004_REGISTRATION_TYPE);
	const rebuilt = buildRegistrationDoc({
		name: decoded.name,
		description: decoded.description,
		image: decoded.image,
		modelUrl: decoded.model.uri,
		active: decoded.active,
		x402Support: decoded.x402Support,
		registrations: [threeWsRegistration(decoded.registrations[0].agentId)],
		supportedTrust: decoded.supportedTrust,
	});
	assert.equal(jsonDataUri(rebuilt), MAO_REGISTRATION_URI);
});

test('default registration entry points at the chain registry', () => {
	assert.deepEqual(chainRegistration('SoMeAsset', 'mainnet'), {
		agentId: 'SoMeAsset',
		agentRegistry: 'solana:101:metaplex',
	});
	assert.deepEqual(chainRegistration('SoMeAsset', 'devnet'), {
		agentId: 'SoMeAsset',
		agentRegistry: 'solana:103:metaplex',
	});
});

test('default plugins are the Genesis set: royalties, verified creator, immutable metadata', () => {
	const creator = 'WWW3eeR7LjgCNSCnC4qmSfLfQZgxHF9ZvqhD8NbKrPV';
	const plugins = buildPlugins({ creator });
	assert.deepEqual(plugins.map((p) => p.type), ['Royalties', 'VerifiedCreators', 'ImmutableMetadata']);
	const royalties = plugins[0];
	assert.equal(royalties.basisPoints, 500);
	assert.equal(royalties.creators.length, 1);
	assert.equal(royalties.creators[0].address.toString(), creator);
	assert.equal(royalties.creators[0].percentage, 100);
	const verified = plugins[1];
	assert.equal(verified.signatures[0].address.toString(), creator);
	assert.equal(verified.signatures[0].verified, true);
});

test('plugin knobs work: zero royalty, attributes, permanent delegates, add blocker', () => {
	const creator = 'WWW3eeR7LjgCNSCnC4qmSfLfQZgxHF9ZvqhD8NbKrPV';
	const plugins = buildPlugins({
		creator,
		royaltyBasisPoints: 0,
		verifiedCreator: false,
		immutableMetadata: false,
		attributes: [{ key: 'platform', value: 'three.ws' }],
		permanentFreeze: true,
		permanentTransfer: true,
		permanentBurn: true,
		addBlocker: true,
	});
	assert.deepEqual(
		plugins.map((p) => p.type),
		['Attributes', 'PermanentFreezeDelegate', 'PermanentTransferDelegate', 'PermanentBurnDelegate', 'AddBlocker'],
	);
	assert.deepEqual(plugins[0].attributeList, [{ key: 'platform', value: 'three.ws' }]);
});

test('royalty splits must sum to 100', () => {
	const creator = 'WWW3eeR7LjgCNSCnC4qmSfLfQZgxHF9ZvqhD8NbKrPV';
	assert.throws(
		() => buildPlugins({ creator, royaltyCreators: [{ address: creator, percentage: 60 }] }),
		/sum to 100/,
	);
});

test('decodeJsonUri handles data: URIs offline and rejects junk', async () => {
	assert.deepEqual(await decodeJsonUri(jsonDataUri({ a: 1 })), { a: 1 });
	assert.equal(await decodeJsonUri('data:application/json;base64'), null);
	assert.equal(await decodeJsonUri('ipfs://nope'), null);
	assert.equal(await decodeJsonUri(''), null);
});
