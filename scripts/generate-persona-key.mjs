#!/usr/bin/env node
// Generate an ES256 (P-256) keypair for signing Persona Hub tokens.
//
// Run once per environment. The private key goes into the deployment's env as
// PERSONA_JWKS_PRIVATE_KEY_PEM; the public key is auto-derived from it at
// runtime (jose's exportJWK on the private CryptoKey emits the public JWK
// fields), so PERSONA_JWKS_PUBLIC_KEY_PEM is optional and only needed if you
// want to override what's published at /.well-known/jwks.json.
//
// Usage:
//   node scripts/generate-persona-key.mjs
//   node scripts/generate-persona-key.mjs --kid persona-2026-05
//
// Output is written to stdout as a copy-pasteable block. Nothing is written
// to disk: review the values, paste them into the deployment's env, redeploy.

import { generateKeyPair, exportPKCS8, exportSPKI, exportJWK } from 'jose';

const args = process.argv.slice(2);
const kid =
	args.find((a) => a.startsWith('--kid='))?.split('=')[1] ||
	(args.includes('--kid') ? args[args.indexOf('--kid') + 1] : null) ||
	`persona-${new Date().toISOString().slice(0, 10)}`;

const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
const privatePem = await exportPKCS8(privateKey);
const publicPem = await exportSPKI(publicKey);
const jwk = await exportJWK(publicKey);

const escaped = (pem) => pem.trimEnd().replace(/\n/g, '\\n');

console.log('# Paste into the Cloud Run service env (or .env.local for dev):');
console.log('# ─────────────────────────────────────────────────');
console.log(`PERSONA_JWKS_KID=${kid}`);
console.log(`PERSONA_JWKS_PRIVATE_KEY_PEM="${escaped(privatePem)}"`);
console.log(`# Optional — derived from private key if omitted:`);
console.log(`# PERSONA_JWKS_PUBLIC_KEY_PEM="${escaped(publicPem)}"`);
console.log('');
console.log('# Verification (after deploy):');
console.log('# curl https://three.ws/.well-known/jwks.json');
console.log('');
console.log('# Public JWK (what /.well-known/jwks.json will publish):');
console.log(JSON.stringify({ ...jwk, alg: 'ES256', use: 'sig', kid }, null, 2));
