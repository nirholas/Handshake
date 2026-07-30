#!/usr/bin/env node
// Compile a sentence into a signed animation clip, in Node, with no avatar,
// no renderer, and no network. Run it:
//
//   node example/compile-utterance.mjs "happy to meet you"
//
// Writes the clip next to this file as utterance.clip.json, which you can play
// on any humanoid rig with finger bones (three.ws serves this exact shape from
// its animation library).

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileUtterance, signLookup, signGloss } from '../dist/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const text = process.argv.slice(2).join(' ') || 'happy to meet you';

// The built-in vocabulary. Words it knows are SIGNED; the rest fingerspell.
const signs = signLookup({ dominant: 'Right' });
const { clip, signed, spelled, truncated } = compileUtterance(text, { signs });

console.log(`text     "${text}"`);
console.log(`signed   ${signed.length ? signed.join(', ') : '(none)'}`);
console.log(`spelled  ${spelled.length ? spelled.join(', ') : '(none)'}`);
for (const word of signed) console.log(`  ${word}: ${signGloss(word)}`);
console.log(`clip     ${clip.name}  ${clip.duration.toFixed(2)}s  ${clip.tracks.length} tracks`);
if (truncated) console.log('note     the utterance was capped at maxSeconds');

const out = resolve(here, 'utterance.clip.json');
writeFileSync(out, JSON.stringify(clip, null, '\t'));
console.log(`wrote    ${out}`);
