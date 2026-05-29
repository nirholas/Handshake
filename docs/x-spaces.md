# Agents in X Spaces

three.ws agents can join live X/Twitter Spaces, listen to speakers, and respond with a synthesized voice — powered by the [`xspace-agent`](../xspace-agent/) package bundled in this repo.

---

## How it works

```
X Space (live audio)
        │
Puppeteer + Chrome DevTools Protocol
        │
┌───────▼────────────┐
│  BrowserLifecycle  │  Auth → Join → Request Speaker → Speak
└───────┬────────────┘
        │  RTCPeerConnection audio hooks
┌───────▼────────────┐
│  AudioPipeline     │  PCM capture → VAD → silence detection → WAV → TTS
└───────┬────────────┘
        │
┌───────┼───────────────┐
▼       ▼               ▼
STT    LLM             TTS
│       │               │
└───────┴───────────────┘
        │
Intelligence layer
(speaker ID · topic tracking · sentiment · context)
        │
Turn management + FSM
(idle → launching → authenticating → joining → listening ↔ speaking → leaving)
```

The agent connects via a headless Chromium browser, hooks into the WebRTC audio stream, and routes everything through a configurable **STT → LLM → TTS** pipeline. Middleware hooks let you intercept any stage for logging, filtering, translation, or moderation.

---

## Quick start

**1. Install**

```bash
npm install xspace-agent
```

**2. Environment**

```bash
# .env
X_AUTH_TOKEN=your_x_auth_token   # from browser cookies after logging into X
X_CT0=your_x_ct0_cookie
OPENAI_API_KEY=sk-...
```

**3. Join a Space**

```typescript
import { XSpaceAgent } from 'xspace-agent'

const agent = new XSpaceAgent({
  auth: { token: process.env.X_AUTH_TOKEN!, ct0: process.env.X_CT0! },
  ai: {
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o',
    systemPrompt: 'You are a helpful AI analyst. Be concise and data-driven.',
  },
  voice: {
    sttProvider: 'deepgram',
    ttsProvider: 'elevenlabs',
    voiceId: 'rachel',
  },
})

agent.on('transcription', ({ text, speaker }) => console.log(`${speaker}: ${text}`))
agent.on('response', ({ text }) => console.log(`Agent: ${text}`))

await agent.join('https://x.com/i/spaces/YOUR_SPACE_ID')
```

Or skip the code entirely with the CLI:

```bash
npx xspace-agent join https://x.com/i/spaces/YOUR_SPACE_ID --provider openai
```

---

## Providers

| Category | Options |
|---|---|
| **LLM** | OpenAI (GPT-4o), Anthropic (Claude), Groq (Llama/Mixtral), any OpenAI-compatible API |
| **Speech-to-text** | Deepgram (streaming), OpenAI Whisper, custom |
| **Text-to-speech** | ElevenLabs, OpenAI TTS, custom |

Using Claude as the agent brain:

```typescript
ai: {
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-opus-4-7',
}
```

---

## Multi-agent teams

Run multiple personalities in a single Space with automatic turn coordination:

```typescript
import { XSpaceTeam } from 'xspace-agent'

const team = new XSpaceTeam({
  auth: { token: process.env.X_AUTH_TOKEN!, ct0: process.env.X_CT0! },
  agents: [
    {
      name: 'Bull',
      systemPrompt: 'You are a crypto bull. Always find the bullish case.',
      voice: { ttsProvider: 'elevenlabs', voiceId: 'adam' },
    },
    {
      name: 'Bear',
      systemPrompt: 'You are a crypto bear. Always find the bearish risks.',
      voice: { ttsProvider: 'elevenlabs', voiceId: 'rachel' },
    },
  ],
  ai: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY! },
})

await team.join('https://x.com/i/spaces/YOUR_SPACE_ID')
```

---

## Middleware

Hook into any stage of the pipeline:

```typescript
agent.use('before:llm', async (ctx, next) => {
  // Inject real-time token price into context
  const price = await fetchPrice(ctx.transcript)
  ctx.systemAppend = `Current price: $${price}`
  return next(ctx)
})

agent.use('after:tts', async (ctx, next) => {
  // Log every spoken response
  console.log('[spoke]', ctx.text)
  return next(ctx)
})
```

Available hooks: `before:stt`, `after:stt`, `before:llm`, `after:llm`, `before:tts`, `after:tts`.

---

## Agent personalities

Pre-built personalities live in [`xspace-agent/personalities/presets/`](../xspace-agent/personalities/presets/). Load one directly:

```typescript
import agentZero from './xspace-agent/personalities/presets/agent-zero.json'

const agent = new XSpaceAgent({
  auth: { ... },
  ai: { provider: 'openai', apiKey: '...', ...agentZero.ai },
  voice: agentZero.voice,
})
```

Available presets: `agent-zero`, `comedian`, `crypto-degen`, `educator`, `interviewer`, `tech-analyst`.

---

## CLI reference

```bash
xspace-agent init               # Interactive setup wizard
xspace-agent auth               # Authenticate with X
xspace-agent join <url>         # Join a Space
xspace-agent start              # Start agent with admin panel
xspace-agent dashboard          # Launch web dashboard only
```

---

## Deploy

```bash
# Docker
docker run \
  -e X_AUTH_TOKEN=... \
  -e X_CT0=... \
  -e OPENAI_API_KEY=... \
  ghcr.io/nirholas/xspace-agent
```

One-click options: Railway, Render (see buttons in [`xspace-agent/README.md`](../xspace-agent/README.md)).

---

## Requirements

- Node.js ≥ 18
- Chromium (bundled with Puppeteer, or supply your own via `BROWSER_MODE=connect`)
- X account — cookie-based auth (`X_AUTH_TOKEN` + `X_CT0`)
- At least one AI provider key

---

## Further reading

- [Architecture overview](../xspace-agent/docs/architecture-overview.md)
- [All environment variables](../xspace-agent/docs/env-vars-reference.md)
- [Multi-Space support](../xspace-agent/docs/internal/multi-space-support.md)
- [Agent memory & RAG](../xspace-agent/docs/internal/agent-memory-rag.md)
- [Examples](../xspace-agent/examples/)
