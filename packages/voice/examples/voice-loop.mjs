// The whole voice loop against the live three.ws endpoints, in one run:
//
//   speak       turns text into a voiced clip         (NVIDIA Magpie TTS)
//   lipsync     turns that clip into ARKit visemes    (NVIDIA Audio2Face-3D)
//   transcribe  turns that clip back into text        (NVIDIA Riva ASR)
//   say         returns voice + face in one round trip
//
// Run:  node examples/voice-loop.mjs
//       TEXT="say this instead" node examples/voice-loop.mjs
//       SAVE_WAV=out.wav node examples/voice-loop.mjs   (also write the clip)
//
// Free and key-free: all three lanes lead with NVIDIA NIM. Nothing is paid and
// nothing is stored server-side. Installed consumers import '@three-ws/voice'
// instead of ../src/index.js.

import { writeFile } from 'node:fs/promises';

import { speak, lipsync, transcribe, say, voices, asrInfo, lipsyncInfo } from '../src/index.js';

const TEXT = process.env.TEXT || 'The quick brown fox jumps over the lazy dog.';

// 0. Probe both lanes first. A UI does exactly this to decide between the server
//    lane and its in-browser fallback.
const [asr, face] = await Promise.all([asrInfo(), lipsyncInfo()]);
console.log(`asr lane:     configured=${asr.configured} encodings=${asr.encodings.join('/')}`);
console.log(`lipsync lane: configured=${face.configured} model=${face.model} ${face.fps} fps ${face.blendshapeFormat}`);

const catalog = await voices();
console.log(`voices:       ${catalog.voices.length} (${catalog.voices.slice(0, 4).map((v) => v.id).join(', ')}, …)`);

// 1. Text → speech. WAV so the same bytes can drive both A2F and Riva below.
console.log(`\nspeak("${TEXT}")`);
const clip = await speak(TEXT, { voice: 'nova', format: 'wav' });
console.log(`  ${clip.blob.size} bytes of ${clip.contentType} from ${clip.model} (voice ${clip.voice})`);
if (process.env.SAVE_WAV) {
	await writeFile(process.env.SAVE_WAV, Buffer.from(await clip.blob.arrayBuffer()));
	console.log(`  written to ${process.env.SAVE_WAV}`);
}

// 2. Speech → face. The track is time-coded in seconds from clip start, so the
//    browser plays `clip` and samples `frames` by the audio element's currentTime.
console.log('\nlipsync(clip)');
const track = await lipsync(clip.blob, { format: 'wav' });
const jaw = track.blendShapeNames.findIndex((n) => /jawopen/i.test(n));
const jawMax = Math.max(...track.frames.map((f) => f.w[jaw] ?? 0));
console.log(`  ${track.frameCount} frames @ ${track.fps} fps over ${track.durationSec.toFixed(2)}s`);
console.log(`  ${track.blendShapeNames.length} blendshapes; JawOpen peaks at ${jawMax.toFixed(3)} (the mouth actually opens)`);

// 3. Speech → text, closing the loop on the exact clip we synthesized.
console.log('\ntranscribe(clip)');
const heard = await transcribe(clip.blob, { format: 'wav', words: true });
console.log(`  "${heard.text}"`);
console.log(`  ${heard.words.length} word timings, ${heard.durationSec.toFixed(2)}s of audio, model ${heard.model}`);

// 4. One round trip instead of two: the server synthesizes and animates that
//    exact audio, so the track and the clip are aligned by construction.
console.log('\nsay("Welcome back.")');
const { audio, animation } = await say('Welcome back.', { voice: 'nova' });
console.log(`  ${audio.blob.size} bytes of ${audio.contentType} (${audio.voiceName})`);
console.log(`  + ${animation.frameCount} aligned face frames @ ${animation.fps} fps`);

console.log('\nHeard, spoke, and moved a face. No key, no payment.');
