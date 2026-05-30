#!/usr/bin/env node
// Pin a token image + metadata descriptor to pump.fun's IPFS endpoint and print
// the resulting metadataUri. This is the descriptor a create-coin tx points at.
//
// Usage:
//   node scripts/pump-upload-metadata.mjs <imagePath> [--name "..."] [--symbol "..."] \
//        [--description "..."] [--twitter url] [--telegram url] [--website url] [--show-name]
//
// Name/symbol default to empty strings (a "no name / no ticker" coin).

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
	const positional = [];
	const opts = {};
	const flags = new Set(['show-name']);
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith('--')) {
			const key = a.slice(2);
			if (flags.has(key)) opts[key] = true;
			else opts[key] = argv[++i];
		} else {
			positional.push(a);
		}
	}
	return { positional, opts };
}

const { positional, opts } = parseArgs(process.argv.slice(2));
const imagePath = positional[0];
if (!imagePath) {
	console.error('Usage: node scripts/pump-upload-metadata.mjs <imagePath> [--name ..] [--symbol ..] [--description ..] [--show-name]');
	process.exit(1);
}
if (!fs.existsSync(imagePath)) {
	console.error(`Image not found: ${imagePath}`);
	process.exit(1);
}

const name = opts.name ?? '';
const symbol = opts.symbol ?? '';
const description = opts.description ?? '';

const bytes = fs.readFileSync(imagePath);
const ext = path.extname(imagePath).toLowerCase();
const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
	: ext === '.gif' ? 'image/gif'
	: ext === '.webp' ? 'image/webp'
	: 'image/png';

const form = new FormData();
form.append('file', new Blob([bytes], { type: mime }), path.basename(imagePath));
form.append('name', name);
form.append('symbol', symbol);
form.append('description', description);
form.append('twitter', opts.twitter ?? '');
form.append('telegram', opts.telegram ?? '');
form.append('website', opts.website ?? '');
form.append('showName', opts['show-name'] ? 'true' : 'false');

console.error('Uploading to pump.fun IPFS…');
console.error('  image:   ', imagePath, `(${bytes.length} bytes, ${mime})`);
console.error('  name:    ', JSON.stringify(name));
console.error('  symbol:  ', JSON.stringify(symbol));
console.error('  showName:', opts['show-name'] ? 'true' : 'false');

const r = await fetch('https://pump.fun/api/ipfs', { method: 'POST', body: form });
if (!r.ok) {
	console.error(`Upload failed: ${r.status} ${await r.text().catch(() => '')}`);
	process.exit(1);
}
const json = await r.json();
const uri = json.metadataUri || json.metadata_uri || json.uri;
if (!uri) {
	console.error('No metadataUri in response:', JSON.stringify(json));
	process.exit(1);
}
console.error('  image uri:', json.metadata?.image || json.image || '(in descriptor)');
console.log(uri);
