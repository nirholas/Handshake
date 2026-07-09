// Service-catalog descriptor — the single written-once listing for this
// service. api/wk.js derives its /.well-known/x402.json resource entry from
// this file via api/_lib/service-catalog/index.js (toBazaarDiscovery), and
// the OKX storefront projection reads the same record (toOkxCatalog).
// Contract: specs/service-catalog.md. Do not re-add a hand-written mirror
// for this route in api/wk.js — edit this descriptor instead.
//
// Re-listed per the 2026-07-08 storefront cleanup (prompt 18) — see
// api/x402/mint-to-mesh.js for the header note superseding the prior
// "internal-use only" de-listing.

export default {
	slug: 'mint-to-mesh',
	title: 'Mint to Mesh',
	category: '3d',
	useCase: 'Mint to Mesh — pass any Solana SPL token mint, get back a binary glTF (GLB) cube themed and colored from that token\'s own on-chain Metaplex metadata, ready to render.',
	path: '/api/x402/mint-to-mesh',
	method: 'GET',
	free: false,
	status: 'live',
	priceAtomics: '1000',
	acceptsBuilder: 'standard',
	serviceName: 'three.ws Mint to Mesh',
	tags: ['3d', 'gltf', 'solana', 'token', 'render'],
	description: 'Mint to Mesh — pass any Solana SPL token mint, get back a binary glTF (GLB) cube themed and colored from that token\'s own on-chain Metaplex metadata, ready to render. The cube carries the token image as a baseColor texture when one is exposed, and asset.extras carry the full on-chain metadata (name, symbol, description) for downstream introspection. Useful for in-game items, leaderboards, NFT-of-token, and AR previews. Pay-per-call in USDC on Base or Solana.',
	input: {
		mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
	},
	inputSchema: {
		type: 'object',
		required: ['mint'],
		properties: {
			mint: {
				type: 'string',
				minLength: 32,
				maxLength: 44,
				description: 'Base58 SPL mint address on Solana mainnet.',
			},
		},
	},
	// Mirrors buildMesh()'s return in api/x402/mint-to-mesh.js. The base64 GLB is
	// truncated to a recognizable magic-bytes stub — a full model would bloat the
	// discovery doc for no ranking benefit.
	outputExample: {
		mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
		theme: {
			name: 'three.ws',
			symbol: 'THREE',
			color: '#7c5cff',
			imageUrl: 'https://cdn.three.ws/tokens/three.png',
			hasImage: true,
		},
		glb: {
			mimeType: 'model/gltf-binary',
			bytes: 18432,
			base64: 'Z2xURgIAAAA…',
		},
	},
	storefronts: ['x402scan'],
};
