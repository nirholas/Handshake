# Build Your First three.ws

By the end of this tutorial you will have a live, talking 3D character on a page you can share with anyone. No build tools, no framework, no prior 3D experience required — just a text editor and a browser.

**What you'll build:**
- A 3D avatar loaded in your browser
- An agent with a name and a personality
- The agent responding to text (and optionally voice) messages using Claude
- The finished page hosted somewhere shareable

**Prerequisites:** Basic HTML and JavaScript. You don't need to know Three.js, WebGL, or anything 3D-specific.

---

## Step 1 — Pick a 3D avatar

You need a GLB file — the standard format for 3D models on the web. Here are three ways to get one, ranked by effort:

### Option A: Use the sample avatar (zero effort, recommended for beginners)

There's a hosted sample avatar ready to use. Just copy the URL below and you're done for this step:

```
https://cdn.three.wsmodels/sample-avatar.glb
```

Come back and swap this for your own character later. That's what Step 9 is for.

### Option B: Get a free avatar from Mixamo (~10 minutes)

[Mixamo](https://www.mixamo.com) is Adobe's free library of rigged 3D characters. Hundreds of options, all pre-rigged with animations.

1. Go to [mixamo.com](https://www.mixamo.com) and sign in with a free Adobe account.
2. Click **Characters**, then pick any character you like.
3. Click **Download** and choose **FBX for Unity** from the format dropdown.
4. Convert the FBX to GLB using [gltf-transform](https://gltf-transform.dev):

   ```bash
   npx gltf-transform@latest fbx2glb your-character.fbx your-character.glb
   ```

   This requires Node.js. If you don't have Node.js installed, grab it from [nodejs.org](https://nodejs.org).

### Option C: Generate one from a selfie (~5 minutes)

Go to [https://three.ws/create](https://three.ws/create), upload a photo, and download the resulting GLB.

---

If you're not sure which to pick, use **Option A** and move on. You can always come back.

---

## Step 2 — Create the HTML file

Create a new folder somewhere on your computer. Inside it, create a file called `index.html` and paste this:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My three.ws</title>
  <style>
    body {
      margin: 0;
      background: #0a0a0a;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    agent-3d {
      width: 400px;
      height: 600px;
      border-radius: 16px;
      overflow: hidden;
    }
  </style>
</head>
<body>
  <script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>

  <agent-3d
    body="https://cdn.three.wsmodels/sample-avatar.glb"
    width="400px"
    height="600px"
  ></agent-3d>
</body>
</html>
```

**What each part does:**

- `<script type="module" src="...">` — loads the web component. It self-registers as `<agent-3d>` and bundles everything (Three.js, loaders, the UI chrome). No other dependencies needed.
- `body="..."` — the URL of your GLB file. This is the only required attribute.
- `width` and `height` on the element control the canvas size. The CSS styles above also set the visual shape; both work together.

### Open it in a browser

You need a local server — browsers block some resources when you open files directly from disk. The quickest way:

```bash
# If you have Python 3
python3 -m http.server 8080

# If you have Node.js
npx serve .
```

Then open [http://localhost:8080](http://localhost:8080).

You should see your 3D character appear in the centre of the page. Click and drag to rotate it. Scroll to zoom.

**If the model doesn't appear:**
- Open your browser's developer console (F12) and look for a red error. A CORS or 404 error will name the file it couldn't load.
- If you used your own GLB: make sure the file is in the same folder as `index.html` and the `body=` attribute points to it correctly (e.g., `body="./your-character.glb"`).
- Voice input requires HTTPS. Localhost is fine. If you later deploy to a plain HTTP URL, mic access won't work.

---

## Step 3 — Give the agent a brain

Right now the character just stands there. Let's make it think and talk.

Update the `<agent-3d>` tag to add the `brain` and `instructions` attributes:

```html
<agent-3d
  body="https://cdn.three.wsmodels/sample-avatar.glb"
  brain="claude-sonnet-4-6"
  name="Aria"
  instructions="You are Aria, a friendly and enthusiastic AI guide. You love helping people explore the 3D world. Be concise, warm, and occasionally playful. When someone greets you, wave at them. Keep replies to 2–3 sentences unless asked for more."
  width="400px"
  height="600px"
></agent-3d>
```

**What changed:**

- `brain="claude-sonnet-4-6"` — enables the AI. The value is the Claude model ID to use. `claude-sonnet-4-6` is the recommended default: fast, capable, and cost-effective. You can also use `claude-opus-4-7` for the most capable responses, or `claude-haiku-4-5-20251001` for the fastest.
- `name="Aria"` — the agent's name. This appears in the nameplate overlay and is available to the brain as context.
- `instructions="..."` — the system prompt. This is where you define personality, tone, behavior rules, and anything the agent should know about its context.

When `brain` is set, the built-in chat input and microphone button appear automatically at the bottom of the element. You don't need to build your own UI for basic chat.

Reload the page, type something in the chat input at the bottom, and press Enter. Aria will respond.

> **API key:** For production use you'll want your own Anthropic API key. The platform's free tier provides limited credits without one. Add it as: `api-key="sk-ant-..."`. In practice, proxy the key through your own backend rather than exposing it in client-side HTML.

---

## Step 4 — Create an agent manifest

The `brain` and `instructions` attributes are great for quick setup. For a real agent you want a **manifest** — a small JSON file that defines the agent's complete configuration, including personality, skills, and memory settings.

Create `agent.json` in the same folder as `index.html`:

```json
{
  "spec": "agent-manifest/0.1",
  "name": "Aria",
  "description": "A friendly AI guide who loves 3D",
  "body": {
    "uri": "./your-character.glb",
    "format": "gltf-binary"
  },
  "brain": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "instructions": "You are Aria, a friendly and enthusiastic AI guide. You love helping people explore the 3D world. Be concise, warm, and occasionally playful. When someone greets you, wave at them. When someone loads a model, compliment it. Keep replies to 2–3 sentences unless asked for more.",
    "temperature": 0.8,
    "maxTokens": 1024
  },
  "voice": {
    "tts": { "provider": "browser", "rate": 1.05 },
    "stt": { "provider": "browser", "language": "en-US" }
  },
  "memory": {
    "mode": "local"
  },
  "skills": [
    { "uri": "https://cdn.three.wsskills/wave/" }
  ],
  "version": "0.1.0"
}
```

Then update `index.html` to load from the manifest instead of using inline attributes:

```html
<agent-3d
  manifest="./agent.json"
  width="400px"
  height="600px"
></agent-3d>
```

The manifest approach is cleaner for anything beyond a one-liner: you can version it in git, keep the instructions in one place, and load it by URL from anywhere.

> **Note:** If you used the sample avatar URL, replace `./your-character.glb` in the manifest with `https://cdn.three.wsmodels/sample-avatar.glb`.

---

## Step 5 — Add a custom chat interface (optional)

The built-in chrome is convenient, but you might want a chat panel that matches your page design. Remove the built-in input and build your own:

Add `kiosk` to the element to hide the built-in chrome:

```html
<agent-3d
  manifest="./agent.json"
  kiosk
  width="400px"
  height="600px"
></agent-3d>
```

Then add your own input below the element:

```html
<div style="text-align:center; margin-top: 16px;">
  <input
    id="msg"
    type="text"
    placeholder="Ask Aria something..."
    style="width:300px; padding:10px 14px; border-radius:24px; border:1px solid #333;
           background:#1a1a1a; color:white; font-size:14px; outline:none;"
  >
  <button
    onclick="send()"
    style="padding:10px 18px; margin-left:8px; border-radius:24px;
           background:#6366f1; color:white; border:none; cursor:pointer; font-size:14px;"
  >
    Send
  </button>
</div>

<script>
  const agent = document.querySelector('agent-3d');
  const input = document.getElementById('msg');

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await agent.say(text);
  }

  // Submit on Enter
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') send();
  });

  // Log agent replies to the console (or render them in your own chat log)
  agent.addEventListener('brain:message', e => {
    const { role, content } = e.detail;
    if (role === 'assistant') console.log('Aria:', content);
  });
</script>
```

**The public JS API:**

| Method | What it does |
|--------|--------------|
| `agent.say(text)` | Sends a message and returns the reply. The agent also speaks and animates. |
| `agent.ask(text)` | Same as `say()`, but returns the reply text as a string. |
| `agent.wave()` | Triggers the wave animation directly. |
| `agent.lookAt(target)` | `'camera'`, `'model'`, or `'user'` — the agent turns to look. |
| `agent.play(clipName)` | Plays a named animation clip from the GLB. |
| `agent.clearConversation()` | Resets the conversation history. |
| `agent.expressEmotion(trigger, weight)` | Triggers an emotion blend (`'celebration'`, `'concern'`, `'curiosity'`, `'empathy'`, `'patience'`). |

**Key events:**

| Event | When it fires | `event.detail` |
|-------|--------------|----------------|
| `agent:ready` | Agent fully booted | `{ agent, manifest }` |
| `brain:message` | Each turn of conversation | `{ role, content }` |
| `brain:thinking` | LLM call started | — |
| `skill:tool-called` | Agent used a tool/skill | `{ name, args }` |
| `voice:transcript` | STT produced a transcript | `{ text }` |

---

## Step 6 — Auto-greet on load

Make Aria say hello as soon as the page loads. Add this after the script block from Step 5:

```html
<script>
  agent.addEventListener('agent:ready', async () => {
    // Short pause so the avatar settles in before speaking
    setTimeout(async () => {
      await agent.say('Hello! I\'m Aria. How can I help you today?');
    }, 1200);
  });
</script>
```

Or you can put the greeting instruction directly in the system prompt — simpler and harder to forget:

```
"When the user first loads the page, greet them warmly by name if you know it, otherwise just say hello. Wave while you do it."
```

The LLM will handle this naturally on the first message it receives.

---

## Step 7 — Voice input

The built-in mic button (the 🎙 icon in the chat chrome) already handles voice input. It uses the browser's `SpeechRecognition` API: click once to start listening, click again to stop. The transcript goes to the agent automatically.

If you built a custom chat interface in Step 5 (kiosk mode), add your own mic button:

```html
<button id="mic-btn" onclick="toggleMic()">🎙</button>

<script>
  let listening = false;

  async function toggleMic() {
    const btn = document.getElementById('mic-btn');
    if (listening) {
      listening = false;
      btn.textContent = '🎙';
      return;
    }
    listening = true;
    btn.textContent = '⏹ Stop';

    try {
      // Use the browser's SpeechRecognition API directly
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) { alert('Speech recognition not supported in this browser'); return; }

      const recognition = new SR();
      recognition.lang = 'en-US';
      recognition.onresult = async (e) => {
        const text = e.results[0][0].transcript;
        input.value = text;
        await send();
      };
      recognition.onend = () => {
        listening = false;
        btn.textContent = '🎙';
      };
      recognition.start();
    } catch (err) {
      console.error('Mic failed:', err);
      listening = false;
      btn.textContent = '🎙';
    }
  }
</script>
```

**Reminder:** Microphone access requires HTTPS. This works on localhost without HTTPS, but once you deploy you'll need a proper TLS certificate — all three hosting options in Step 8 provide this automatically.

---

## Step 8 — Host it

Your page is ready. Time to put it on the internet so you can share the URL.

### Option A: Vercel (recommended, 30 seconds)

```bash
npx vercel
```

Follow the prompts. Vercel detects the folder, deploys, and gives you a URL like `aria-agent.vercel.app`. Every time you push changes, it redeploys automatically.

### Option B: Netlify (drag and drop)

Go to [netlify.com](https://netlify.com), sign in, and drag your project folder onto the dashboard. It deploys instantly. URL is something like `random-name.netlify.app`.

### Option C: GitHub Pages (free, git-based)

1. Push your folder to a GitHub repository.
2. Go to the repo **Settings → Pages**.
3. Under "Branch", select `main` and click Save.
4. Your page is live at `https://yourusername.github.io/repo-name`.

All three options are free for personal projects, include HTTPS (required for voice), and take under five minutes. Vercel is the fastest if you haven't used any of them before.

---

## Step 9 — Replace the sample avatar with your own

Once the page is live, swap in your own GLB:

1. Go to [https://three.ws/app](https://three.ws/app)
2. Drag your GLB into the viewer to confirm it loads correctly.
3. Sign up for a free account, then click **Save to Account** to get a hosted URL.
4. Copy that URL.
5. Replace the `body=` attribute in your HTML (or `body.uri` in your manifest) with the new URL.

The platform's hosted storage sends the right CORS headers automatically, so you won't hit cross-origin errors.

---

## What you built

Here's the complete `index.html` all in one place:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My three.ws</title>
  <style>
    body {
      margin: 0;
      background: #0a0a0a;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
  </style>
</head>
<body>
  <script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>

  <agent-3d
    manifest="./agent.json"
    width="400px"
    height="600px"
  ></agent-3d>

  <div style="text-align:center; margin-top: 16px;">
    <input
      id="msg"
      type="text"
      placeholder="Ask Aria something..."
      style="width:300px; padding:10px 14px; border-radius:24px; border:1px solid #333;
             background:#1a1a1a; color:white; font-size:14px; outline:none;"
    >
    <button
      onclick="send()"
      style="padding:10px 18px; margin-left:8px; border-radius:24px;
             background:#6366f1; color:white; border:none; cursor:pointer; font-size:14px;"
    >
      Send
    </button>
  </div>

  <script>
    const agent = document.querySelector('agent-3d');
    const input = document.getElementById('msg');

    async function send() {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      await agent.say(text);
    }

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') send();
    });

    agent.addEventListener('agent:ready', () => {
      setTimeout(() => agent.say('Hello! I\'m Aria. Ask me anything.'), 1200);
    });
  </script>
</body>
</html>
```

And the `agent.json` manifest alongside it.

---

## Next steps

Now that you have a working agent, here's what to explore next:

**Make it smarter:**
- [Skills documentation](../skills.md) — add tools like web search, weather, or a product catalog. Skills are JSON packages that give the agent new capabilities without changing the system prompt.
- [Memory system](../memory.md) — the agent can remember things across conversations using local storage or IPFS.

**Make it permanent:**
- [ERC-8004 registration](../erc8004.md) — register your agent on-chain for a permanent, decentralized identity. Once registered, anyone can load your agent by its on-chain ID: `<agent-three.ws-id="42" chain-id="8453">`.

**Embed it anywhere:**
- [Embedding guide](../embedding.md) — embed Aria as a floating bubble in the corner of any existing website, or as an iframe widget with a single line of code.
- [Web component reference](../web-component.md) — the full attribute, method, and event reference for `<agent-3d>`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Blank page, no errors | Browser opened from disk instead of server | Run `python3 -m http.server 8080` and open `localhost:8080` |
| "Couldn't load agent" | Wrong file path in `body=` or `agent.json` | Check the URL in the console error; verify the GLB file exists |
| Model loads but no chat response | Missing or invalid `brain=` attribute | Confirm the model ID is spelled correctly (e.g., `claude-sonnet-4-6`) |
| Mic button greyed out or silent | Page not on HTTPS | Deploy to Vercel/Netlify, or test on localhost (exempt from HTTPS requirement) |
| CORS error in console | GLB hosted on a different domain without CORS headers | Upload to the platform's hosted storage, or add CORS headers to your server |
| Model looks wrong / T-pose only | GLB missing animations, or wrong rig | Open the file in [the app](https://three.ws/app) to inspect; use a Mixamo-rigged character for best results |
