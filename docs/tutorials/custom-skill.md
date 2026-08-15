# Build a Custom Skill

By the end of this tutorial you will have a working **weather skill** that an agent can use to answer questions like "What's the weather in Tokyo?", with the agent calling a live API and responding naturally in conversation.

Along the way you'll understand the skill bundle format, how the LLM decides when to invoke your tool, and how to reach back into the agent through the context API.

**Prerequisites:** JavaScript familiarity, a text editor, and a place to host static files (a free GitHub Pages or Vercel account works fine).

---

## What you're building

```
User:  "What's the weather like in Tokyo?"
Agent: [calls get_weather({ city: "Tokyo" })]
Agent: "Tokyo is currently 18°C with overcast skies and light rain.
        Might want to pack an umbrella!"
```

The agent doesn't hardcode weather logic. It reads your skill's tool description, decides when the user is asking about weather, and calls `get_weather`, your handler fetches live data and returns structured results that the agent narrates naturally.

---

## How skills work (two minutes of theory)

A skill is a static file bundle: no server, no build step. It has four parts:

| File | Purpose |
|---|---|
| `manifest.json` | Identity, version, compatibility requirements |
| `SKILL.md` | Instructions injected into the agent's system prompt |
| `tools.json` | Tool schemas the LLM can invoke |
| `handlers.js` | ES module that executes each tool call |

When the runtime loads your skill it:

1. Fetches and validates `manifest.json`
2. Merges your tools from `tools.json` into the LLM's tool list
3. Injects `SKILL.md` into the system prompt as a `<skill>` block
4. Runs `handlers.js` in a **sandboxed Web Worker**, it has no DOM access, no `window`, no direct network; everything goes through the `ctx` API

The sandbox is the key safety primitive. Your handler can't accidentally read cookies or touch page state. All side effects go through `ctx.*` methods that the runtime validates and dispatches.

---

## Step 1: Create the skill directory

```
weather-skill/
├── manifest.json
├── SKILL.md
├── tools.json
└── handlers.js
```

Create the folder and four empty files. Everything below fills them in.

---

## Step 2: Write manifest.json

The manifest declares your skill's identity, what rig types it works with, and what tools it provides. It does **not** embed tool schemas, those live in `tools.json`.

```json
{
  "spec": "skill/0.1",
  "name": "weather",
  "version": "1.0.0",
  "description": "Get current weather conditions and forecasts for any city.",
  "author": "your-wallet-or-name",
  "license": "MIT",
  "tags": ["weather", "api", "real-world"],
  "requires": {
    "rig": ["any"],
    "runtime": ">=0.1.0"
  },
  "provides": {
    "tools": ["get_weather"],
    "triggers": ["weather-query", "temperature-query"]
  }
}
```

Key fields:

- **`spec`**: always `"skill/0.1"` for the current format
- **`provides.tools`**: names that must exactly match function exports in `handlers.js` and entries in `tools.json`
- **`provides.triggers`**: semantic tags for skill discovery; the runtime can surface your skill when a user query matches these
- **`requires.rig`**: which avatar rigs this skill supports; `"any"` works everywhere; use `"mixamo"` if your skill plays Mixamo-specific animation clips
- **`author`**: optional, but used for the `owned-only` trust policy (see the security section)

---

## Step 3: Write SKILL.md

`SKILL.md` is a markdown file with YAML frontmatter. The **runtime injects it verbatim into the agent's system prompt** every time the skill is loaded. Think of it as prompt engineering packaged inside the skill.

```markdown
---
name: weather
description: Get current weather conditions and forecasts for any city.
triggers:
  - weather-query
  - temperature-query
  - outdoor-planning
cost: low
---

# Weather Skill

You have access to live weather data through the `get_weather` tool.

Use `get_weather` whenever the user asks about:
- Current conditions, temperature, or weather in a specific location
- Whether to bring an umbrella, coat, or sunscreen
- What the weather is like anywhere in the world

When you receive weather data, respond conversationally, don't just repeat
the raw fields. Mention conditions, temperature, and any useful context
(e.g. "perfect for a walk" or "might want to stay indoors").

If the user doesn't specify units, use celsius by default.
```

The frontmatter `cost: low` tells the runtime this is a cheap skill to load eagerly. For skills that load heavy assets, use `medium` or `high` to defer loading.

The markdown body is your behavioral contract with the LLM. Write it like you'd write a Claude system prompt, clear, specific about when to invoke the tool, and with guidance on how to present the results.

---

## Step 4: Write tools.json

This is what the LLM actually sees as a callable function. The format follows the Anthropic tool-use schema (also compatible with OpenAI):

```json
{
  "tools": [
    {
      "name": "get_weather",
      "description": "Get current weather conditions and temperature for a specific city. Use this when the user asks about weather, temperature, climate, or what to wear.",
      "input_schema": {
        "type": "object",
        "properties": {
          "city": {
            "type": "string",
            "description": "The city name, e.g. 'Tokyo' or 'New York'"
          },
          "units": {
            "type": "string",
            "enum": ["celsius", "fahrenheit"],
            "default": "celsius",
            "description": "Temperature units"
          }
        },
        "required": ["city"]
      }
    }
  ]
}
```

The `description` field is doing real work here. The LLM reads it to decide **when** to call `get_weather`. Compare:

- **Too vague:** `"Get weather"`: the agent might not connect this to "should I bring a jacket?"
- **Right:** `"Get current weather conditions and temperature for a specific city. Use this when the user asks about weather, temperature, climate, or what to wear."`, the agent knows both the capability and the intent signals

Every hour you spend writing a good tool description pays back in fewer missed invocations.

---

## Step 5: Write handlers.js

The handler is an ES module that exports one function per tool. The function name must match the tool name exactly.

```js
// handlers.js

const WEATHER_API_BASE = 'https://wttr.in';

export async function get_weather({ city, units = 'celsius' }, ctx) {
  try {
    // wttr.in is a free weather API, no key needed.
    // Format string: condition | temperature | wind | precipitation.
    // Pipe, not '+', because %t renders a signed value ("+27°C") and a
    // '+' delimiter would split that sign into its own empty field.
    // Units come from the `m` (metric) / `u` (USCS) flag, not the format
    // string: %f is "feels like", not Fahrenheit.
    const fmt = '%C|%t|%w|%p';
    const unitFlag = units === 'celsius' ? 'm' : 'u';
    const url = `${WEATHER_API_BASE}/${encodeURIComponent(city)}?format=${encodeURIComponent(fmt)}&lang=en&${unitFlag}`;

    const res = await ctx.fetch(url);
    if (!res.ok) {
      return { ok: false, error: `Weather service returned ${res.status}` };
    }

    const text = (await res.text()).trim();
    const [condition, temp, wind, precipitation] = text.split('|');

    return {
      ok: true,
      city,
      condition: condition || 'Unknown',
      temperature: temp || 'N/A',
      wind: wind || 'calm',
      precipitation: precipitation || '0mm',
      summary: `${city}: ${condition}, ${temp}, wind ${wind}`,
    };
  } catch (err) {
    return { ok: false, error: `Failed to fetch weather: ${err.message}` };
  }
}
```

Walk through what's happening:

**`({ city, units = 'celsius' }, ctx)`**: the first argument is the validated parameters object the LLM passed; the second is the context object. Always destructure with defaults for optional params.

**`ctx.fetch(url)`**: this is the only way to make network calls from a handler. It's the worker's native `fetch` with standard CORS rules applied. You can't reach `window.fetch` directly (the handler runs in a Worker with no `window`).

**`{ ok: true, ...data }` / `{ ok: false, error: "..." }`**, the runtime expects this shape. On `ok: false`, the runtime surfaces the error cleanly in the LLM conversation without crashing.

**No imports**: because the handler runs inside a sandboxed Web Worker loaded from a `blob:` URL, there's no module resolution context. You can't `import` external packages. Everything you need must come from `ctx.*` or be self-contained in the file.

---

## Step 6: Host the skill

Skills must be accessible over HTTPS. They're static files, any static host works.

**GitHub Pages (free, permanent URL):**
```bash
cd weather-skill
git init
git add .
git commit -m "add weather skill"
gh repo create weather-skill --public
git push -u origin main
# Then: repo Settings → Pages → Deploy from branch (main, / root)
# Your manifest URL: https://yourusername.github.io/weather-skill/manifest.json
```

**Vercel (fastest):**
```bash
cd weather-skill
npx vercel
# Follow the prompts: done in about 30 seconds
# Your manifest URL: https://weather-skill-abc123.vercel.app/manifest.json
```

**Local testing with ngrok (no deploy needed):**
```bash
# Terminal 1: serve the directory
npx serve .

# Terminal 2: expose it
npx ngrok http 3000
# Copy the https://... URL: use it as your manifest URL
```

One thing to check after deploying: open the manifest URL directly in your browser. You should see raw JSON. If you see an error page or HTML, something's wrong with the hosting setup before you go further.

Also verify that your host is sending CORS headers (`Access-Control-Allow-Origin: *`). GitHub Pages and Vercel do this by default. If you're using a custom server, add the header, the runtime's `fetch` calls will fail silently otherwise.

---

## Step 7: Install the skill in an agent

There are three ways, depending on how you're working.

**In the agent manifest** (the most common path):

```json
{
  "spec": "agent-manifest/0.1",
  "name": "My Agent",
  "skills": [
    {
      "uri": "https://yourusername.github.io/weather-skill/",
      "version": "1.0.0"
    }
  ]
}
```

The `uri` points to the **directory**, not the manifest file. The runtime appends `manifest.json`, `SKILL.md`, `tools.json`, and `handlers.js` automatically. Make sure the URI ends with a trailing slash, the runtime uses it as a base for relative asset resolution.

**In the web component attribute** (comma-separated skill URIs, installed on top of any manifest skills):

```html
<agent-3d
  body="https://three.ws/avatars/michelle.glb"
  brain="claude-sonnet-4-6"
  skills="https://yourusername.github.io/weather-skill/"
></agent-3d>
```

**At runtime via JavaScript:**

```js
const agent = document.querySelector('agent-3d');
await agent.installSkill('https://yourusername.github.io/weather-skill/');
```

---

## Step 8: Test it

With the agent running, type: **"What's the weather in Tokyo?"**

Watch what happens in DevTools → Network: you should see a fetch to `wttr.in` originating from the worker. The agent will receive the structured data back, and respond with something like:

> "Tokyo is currently 18°C with overcast skies and wind at 15 km/h. Looks a bit grey today, maybe a good day for an indoor museum."

If it doesn't invoke the tool:

- **Check the console** for skill load errors. A 404 on any of the four files silently skips the tool registration.
- **Verify the manifest URL** returns valid JSON when opened directly in a browser.
- **Check CORS**: if the browser blocks the `manifest.json` fetch, the skill won't load.
- **Check handler function name**: `get_weather` in `handlers.js` must match `"get_weather"` in `tools.json` and `provides.tools` in `manifest.json`. One character off and the tool silently fails.

If the tool calls but returns an error:

- The wttr.in API is free and generally reliable, but city names need to be recognizable. Try a major city like `London` first.
- Check that the worker can reach `wttr.in`: some corporate networks block unusual hostnames.

---

## Step 9: Improve the tool description

Once you've confirmed the happy path, sharpen the tool description to handle edge cases.

The LLM currently calls `get_weather` when it sees words like "weather" or "temperature." But what about:

- "Should I pack a coat for my trip to Oslo next week?", intent is weather, but the word isn't there
- "Is it a good beach day in Sydney?": the user wants weather but asked about activities

Update `tools.json`:

```json
"description": "Get current weather conditions and temperature for a specific city. Use this when the user asks about: weather, temperature, climate, what to wear, whether to bring an umbrella or coat, or whether conditions are good for an outdoor activity."
```

The description is prompt-engineered. The more precisely it maps the tool's capability to user intent signals, the better the LLM's invocation decisions. Iterate on it the same way you'd iterate on a system prompt.

---

## Step 10: Add a second tool

A skill can export multiple tools. Extend the weather skill with a 3-day forecast.

Add to `tools.json`:

```json
{
  "tools": [
    {
      "name": "get_weather",
      "...": "..."
    },
    {
      "name": "get_forecast",
      "description": "Get a multi-day weather forecast for a city. Use when the user asks about upcoming weather, planning a trip, or what the weather will be like later this week.",
      "input_schema": {
        "type": "object",
        "properties": {
          "city": {
            "type": "string",
            "description": "The city name"
          },
          "days": {
            "type": "integer",
            "minimum": 1,
            "maximum": 3,
            "default": 3,
            "description": "Number of forecast days (wttr.in returns at most 3)"
          }
        },
        "required": ["city"]
      }
    }
  ]
}
```

Add to `manifest.json`'s `provides.tools`: `["get_weather", "get_forecast"]`

Add to `handlers.js`:

```js
export async function get_forecast({ city, days = 3 }, ctx) {
  try {
    // wttr.in supports multi-day forecasts via the JSON API
    const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
    const res = await ctx.fetch(url);
    if (!res.ok) return { ok: false, error: `Forecast service returned ${res.status}` };

    const data = await res.json();
    const forecast = data.weather.slice(0, days).map((day) => ({
      date: day.date,
      maxTemp: `${day.maxtempC}°C`,
      minTemp: `${day.mintempC}°C`,
      description: day.hourly[4]?.weatherDesc?.[0]?.value || 'Unknown',
    }));

    return { ok: true, city, days, forecast };
  } catch (err) {
    return { ok: false, error: `Failed to fetch forecast: ${err.message}` };
  }
}
```

One skill, two tools. The LLM picks `get_weather` for "what's the weather now" and `get_forecast` for "what will the weather be like this week", because the descriptions tell it to.

---

## Step 11: Using the context API

Your handlers have access to the full `ctx` API for more sophisticated skills.

```js
export async function get_weather({ city, units = 'celsius' }, ctx) {
  // Remember the last city the user asked about
  ctx.memory.note('weather-query', { city, timestamp: Date.now() });

  // Read a previously stored preference
  const savedUnits = ctx.memory.read('preferred-units');
  const effectiveUnits = units || savedUnits || 'celsius';

  // While fetching, let the agent speak a status update
  await ctx.speak(`Checking the weather in ${city}...`);

  // Make the network call
  const res = await ctx.fetch(`...`);

  // Store preference for next time
  ctx.memory.write('preferred-units', effectiveUnits);

  return { ok: true, ...data };
}
```

The full context surface:

```
ctx.fetch(url)             : safe network call (CORS applies)
ctx.memory.read(key)       : read a stored value
ctx.memory.write(key, val) : write a value
ctx.memory.note(type, data): append to a timeline (good for history)
ctx.memory.recall(query)   : substring search over notes
ctx.speak(text)            : make the agent say something mid-tool
ctx.listen()               : wait for user voice/text input
ctx.call(toolName, args)   : invoke another tool (cross-skill calls)
ctx.loadGLB(uri)           : load a 3D model
ctx.loadClip(uri)          : load an animation clip
ctx.loadJSON(uri)          : load a JSON file from a URL
ctx.viewer.play(clip)      : play a loaded clip on the avatar
ctx.viewer.setExpression(p): set facial expression preset
ctx.viewer.lookAt(target)  : direct the avatar's gaze
ctx.llm.complete(prompt)   : call the LLM directly (advanced)
ctx.skillBaseURI           : base URL of this skill bundle
```

`ctx.memory.note` is useful for building history without explicit keys, it appends to an internal timeline that you can later query with `ctx.memory.recall('weather')`. Good for tracking what the user has asked about across a session.

`ctx.speak` runs mid-handler, before you return. Use it to give the user feedback when a fetch might take a moment. Don't overdo it, a quick `"Let me check..."` is good; narrating every internal step is annoying.

---

## Step 12: The security model

Understanding the sandbox helps you write handlers that work with it rather than fighting it.

**Handlers run in a Web Worker.** They have no `document`, no `window`, no `localStorage`, no cookies. They cannot read or write page state. This is what makes it safe to load third-party skills.

**`ctx.fetch` is the worker's native `fetch`.** Standard browser CORS rules apply. Cross-origin requests succeed if the target server sends CORS headers (most public APIs do). If you're fetching your own API on a different origin, add `Access-Control-Allow-Origin: *` or a specific origin.

**No imports.** Because handlers load from a `blob:` URL with no base URL context, relative `import` statements silently fail. All logic must be self-contained in `handlers.js`. If you need utilities, inline them.

**`trusted-main-thread` opt-out.** Owner-signed skills that need direct Three.js access can set `"sandboxPolicy": "trusted-main-thread"` in `manifest.json`. This runs the handler in the main thread. Only meaningful for skills that pass the agent's trust policy, default is `owned-only`, which requires `manifest.json`'s `author` to match the agent owner's wallet address.

For the weather skill and most API-integration skills, the default sandbox is all you need.

---

## What to build next

Your weather skill is a template for any external API integration. The pattern is always the same: tool definition → handler that calls an API → return structured data the LLM narrates.

Good skills to build next:

- **Financial data**: token prices, portfolio values, DCA calculations
- **GitHub integration**: open PRs, recent commits, issue status
- **Spotify**: currently playing, queue management
- **Notion / Linear**: read and write tickets or docs
- **Domain knowledge**: a skill that's pure `SKILL.md` with no tools, injecting specialized context (legal, medical, culinary)

Sharing your skill is as simple as posting the manifest URL. Add the topic `3dagent-skill` to your GitHub repo so others can find it, and browse what the community has built on the [Skills Marketplace](/skills).

---

## Recap

You built a weather skill with these four files:

- **`manifest.json`**: declares identity, rig compatibility, and what tools the skill provides
- **`SKILL.md`**: the behavioral contract injected into the LLM's system prompt; tells the agent *when* and *how* to use the tool
- **`tools.json`**: the tool schema the LLM invokes; `input_schema` in Anthropic format; the `description` is prompt-engineered
- **`handlers.js`**: exports one function per tool; runs sandboxed in a Web Worker; all I/O through `ctx.*`

The skill installs via a URI in the agent manifest, runs entirely client-side, and adds new capabilities to any compatible agent without modifying the agent itself. That's the composability primitive: agents are extensible at runtime through content-addressed skill bundles.

## Related

- [Skills system reference](/docs/skills): manifest format, context API, sandboxing, publishing
- [Build a skill with database auth](/docs/tutorials/skill-with-database-auth): the next step up, a skill backed by your own API
- [Build your first agent](/docs/tutorials/first-agent): the agent this skill plugs into
- [Web component reference](/docs/web-component): the `skills` attribute and `installSkill()` method
