<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" alt="three.ws" width="88" height="88"></a>
</p>

<h1 align="center">@three-ws/audio-mcp</h1>

<p align="center"><strong>Give a 3D AI agent a voice and a face — text-to-speech, speech-to-text, audio-to-face lipsync, and the motion-capture clip library, from any MCP client.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/audio-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/audio-mcp?logo=npm&color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/audio-mcp?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/audio-mcp?color=339933&logo=node.js">
  <a href="https://registry.modelcontextprotocol.io/?q=io.github.nirholas"><img alt="MCP Registry" src="https://img.shields.io/badge/MCP%20Registry-io.github.nirholas-0ea5e9"></a>
  <a href="https://three.ws"><img alt="three.ws" src="https://img.shields.io/badge/built%20by-three.ws-000"></a>
</p>

---

> A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the three.ws **voice and animation pipeline** over stdio. Make an avatar speak, let users talk back, turn that speech into a per-frame lipsync track, and browse the recorded motion-capture library — everything you need to drive a 3D agent's mouth and movement.

The speech, recognition, and lipsync lanes run on **free NVIDIA NIM** models (Magpie TTS, Riva ASR, Audio2Face-3D), with OpenAI as the paid TTS backstop — the same provider policy as the three.ws platform. No key required to start; point `THREE_WS_BASE` at a deployment and go.

## Install

```bash
npm install @three-ws/audio-mcp
```

Or run with `npx` (no install):

```bash
npx @three-ws/audio-mcp
```

## Quick start

**Claude Code**, one line:

```bash
claude mcp add audio -- npx -y @three-ws/audio-mcp
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `mcp.json`):

```json
{
	"mcpServers": {
		"audio": {
			"command": "npx",
			"args": ["-y", "@three-ws/audio-mcp"]
		}
	}
}
```

Inspect the surface with the MCP Inspector:

```bash
npx -y @modelcontextprotocol/inspector npx @three-ws/audio-mcp
```

## Tools

| Tool                   | Type      | What it does                                                                                                                  |
| ---------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `text_to_speech`       | read-only | Synthesize spoken audio from text; returns a base64 audio data URL plus the real voice/format/mime. Free Magpie, OpenAI backstop. |
| `speech_to_text`       | read-only | Transcribe spoken audio (base64 wav/pcm/flac/ogg) with the free NVIDIA Riva recognizer; returns text, confidence, duration.   |
| `audio_to_face`        | read-only | Turn speech (text you pass, or audio you have) into a per-frame ARKit blendshape lipsync track via Audio2Face-3D.             |
| `motion_capture_clips` | read-only | Browse the motion-capture clip library — recorded face/pose/hand/VMC tracks — with kind filter and cursor pagination.         |
| `motion_capture_clip`  | read-only | Fetch one clip by id including its full per-frame animation track to play back on an avatar.                                  |

All five tools are read-only: they transform input (synthesize/recognize/animate) or read live library data, never mutating platform state. None are idempotent — the audio bytes, transcript, and catalog move between calls.

### Input parameters

**`text_to_speech`** — `text` (required, 1–4096 chars), `voice` (default `nova`), `format` (`mp3`|`opus`|`aac`|`flac`|`wav`|`pcm`, default `mp3`), `model` (OpenAI backstop only), `language` (BCP-47, default `en-US`), `speed` (0.5–2.0, OpenAI lane only).

**`speech_to_text`** — `audio` (required, base64 or `data:` URL), `format` (`wav`|`pcm`|`flac`|`ogg`, default `wav`), `language` (BCP-47, default `en-US`), `sampleRate` (Hz, PCM only), `words` (bool), `model` (advanced).

**`audio_to_face`** — `text` **or** `audio` (one required), `format` (`wav`|`pcm`, audio path), `sampleRate` (PCM only), `voice` / `language` (text path).

**`motion_capture_clips`** — `kind` (`face`|`pose`|`hand`|`vmc`), `include_public` (bool, authenticated only), `limit` (1–100, default 50), `cursor`.

**`motion_capture_clip`** — `id` (required, clip UUID).

## Examples

```jsonc
// text_to_speech
> { "text": "Hello, I'm your three.ws agent.", "voice": "nova" }
{
  "ok": true,
  "voice": "Magpie-Multilingual.EN-US.Aria",
  "model": "magpie-tts-multilingual",
  "format": "wav",
  "mime": "audio/wav",
  "sizeBytes": 274476,
  "audio": "data:audio/wav;base64,UklGR…"
}
```

```jsonc
// audio_to_face (text path — returns audio + the lipsync track together)
> { "text": "Watch my lips move." }
{
  "ok": true,
  "audio": { "base64": "UklGR…", "contentType": "audio/wav", "format": "wav" },
  "animation": {
    "fps": 30,
    "blendShapeNames": ["jawOpen", "mouthClose", "…"],
    "durationSec": 1.9,
    "frames": [ { "t": 0.0, "w": [0.0, 0.1, /* … */] } ]
  }
}
```

A face frame is `{ t, w }`: `t` = seconds from clip start, `w` = weights in the order of `blendShapeNames` (ARKit-52 naming). Play the audio and sample the track by the audio element's `currentTime`.

## Notes on payloads

Audio crosses the wire as base64 (TTS returns it, ASR/A2F accept it). Both the synthesis input (`text`) and the recognition input (`audio`, ~8 MB cap) are bounded by the platform — keep clips to a spoken utterance rather than long recordings. For lipsync on audio you already have, pass `wav`/`pcm` directly; browser-recorded WebM/Opus must be decoded to WAV or PCM first (Riva and Audio2Face do not accept the WebM container).

## Requirements

- **Node.js >= 20.**
- Network access to `https://three.ws` (or your own `THREE_WS_BASE`).

### Environment variables

| Variable              | Required | Default            | Purpose                                                                                          |
| --------------------- | -------- | ------------------ | ------------------------------------------------------------------------------------------------ |
| `THREE_WS_BASE`       | no       | `https://three.ws` | Which deployment to talk to.                                                                      |
| `THREE_WS_API_KEY`    | no       | —                  | Bearer token. Raises the metered TTS/ASR/A2F rate limits and unlocks your own private mocap clips. |
| `THREE_WS_TIMEOUT_MS` | no       | `60000`            | Per-request timeout for the live model calls.                                                     |

## Links

- Homepage: https://three.ws
- Changelog: https://three.ws/changelog
- Issues: https://github.com/nirholas/three.ws/issues
- License: Apache-2.0, see [LICENSE](./LICENSE)

---

<p align="center">
  <sub>
    Part of the <a href="https://three.ws">three.ws</a> SDK suite — 3D AI agents, on-chain identity, and agent payments.<br/>
    <a href="https://three.ws">Website</a> · <a href="https://three.ws/changelog">Changelog</a> · <a href="https://github.com/nirholas/three.ws">GitHub</a>
  </sub>
</p>
