# three.ws-chat

### A fast, light, open chat UI

### Key features:

- 🔌 Multiple providers, plug in your API keys (stored entirely locally) and you're good to go

  - Local models (through Ollama)
  - OpenRouter (which lets you use ALL models across many providers: OpenAI, Anthropic, OSS, 50+ others)
  - OpenAI
  - Anthropic
  - Mistral
  - Groq

- 🛠️ Tool use
  - Check out `server/toolfns/toolfns.go`. You only need to write functions. The function comment is the description the model receives, so it knows what to use. Click the `Sync` button in the web UI to refresh your tools.
- 🖼️ Multimodal input: upload, paste, or share links to images
- 🎨 Image generation using DALL-E 3
- 📝 Multi-shot prompting. Also edit, delete, regenerate messages, whatever. The world is your oyster
- ⚡ Pre-filled responses (where supported by provider)
- 🌐 Support for all available models across all providers
- 🔄 Change model mid-conversation
- 🔐 Sync chats and keys across devices, end-to-end encrypted. Self-hosted, or use our hosted instance.
- 🔗 Conversation sharing (if you choose to share, your conversation has to be stored on an external server for the share link to be made available. Self-hosted share options coming soon. No, I will not view any of your stuff.)
- 🌿 Branching conversation history (like the left-right ChatGPT arrows that you can click to go back to a previous response)

### Privacy:

- Completely private and transparent. All your conversation history and keys are stored entirely locally, and kept only in your browser, on your device.

## 3D in chat: forge models and view them inline

The chat generates and displays real 3D models directly in the conversation. Three pieces work together:

**Forge tools (on by default).** Two client tools are bootstrapped into every fresh conversation:

- `ForgeTextTo3D` runs the free three.ws Forge lane (`POST /api/forge { prompt }`). It returns immediately; the model appears in the thread in roughly 30 to 90 seconds. Ask for "a 3D model of a brass steampunk owl" and the assistant calls it on its own.
- `ForgeAvatar` runs the full text to mesh to auto-rig to avatar-library pipeline (`/api/forge`, `/api/forge?action=rig`, `/api/avatars/from-forge`). Saving to the library requires being signed in; without a session it still returns the rigged model.

Both tools return an `application/model-3d` envelope instead of raw HTML: `{ contentType: 'application/model-3d', content: { glb, job, prompt, preview, eta, rigged, saved_url, status_note, error }, summary }`. The `summary` string is what the LLM reads; the compact `content` object is what renders, so tool results stay cheap in tokens.

**The inline viewer (`src/ModelViewer3D.svelte`).** Any `application/model-3d` tool result renders directly in the message thread (and in the tool split view) as an interactive Three.js viewer: orbit and zoom with damping plus auto-rotate until first interaction, PBR environment lighting, animation playback when the GLB has clips, a skeleton toggle for rigged models (press S), and Download GLB / Viewer / View in AR / Recenter controls. While a forge job is pending it polls `GET /api/forge?job=` and shows the concept preview with a progress bar, then swaps in the model; once resolved, the GLB URL is persisted into the stored message so reloading the conversation renders instantly instead of re-polling. Viewers initialize lazily near the viewport, pause rendering offscreen, dispose all GPU resources on unmount, and recover from WebGL context loss with a reload card.

**GLB links auto-render.** Paste a `.glb` URL into a message (or have the assistant produce one) and a viewer appears under it. Cross-origin models whose host lacks CORS headers are fetched through the same-origin `/api/glb?src=` proxy automatically. Links already rendered by a tool card or an earlier message are not duplicated.

## How to install?

If you don't want to use tools, you don't need to install anything. A hosted instance is available at: https://three.ws/chat

If you want to use tools, proceed below.

## Single binary:

The three.ws-chat tool server is available prebuilt as a single binary. [Download prebuilt package from the releases page.](https://github.com/nirholas/three.ws-chat/releases)

Download the binary for your platform, then run it, which will start the tool server:

```
./three.ws-chat-darwin-amd64
Tool server running at http://localhost:8081
```

Go back to https://three.ws/chat, head over to Settings -> Tool calling, and click the "Refresh tools" button. You should be good to go!

### Building client and server locally:

1. Clone the repository
2. Install and start the client: `npm i && npm run dev`. The client will be accessible at http://localhost:5173
3. Install and start the server: `cd server && go generate ./... && go build && ./server -password foobar`. The server will be accessible at http://localhost:8081. You can plug this into the server address in the chat UI along with the password you selected.
