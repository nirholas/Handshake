# Add a greeting & first speech line

A silent agent on a page is half an agent. The avatar appears, animates, looks ready — but a visitor lands, glances at it, and isn't sure whether to engage. They look for a chat input. They wonder if the thing is for them.

A greeting fixes all of that in one sentence. The agent introduces itself the moment it's ready. Visitors see who it is and what it's for. They know it's interactive. They know it's responsive. They speak back.

This tutorial covers the greeting flow end to end: waiting for the `agent:ready` event, triggering the first line with `say()`, shaping what the agent says through its instructions, how the browser's audio autoplay rules affect the spoken part, and how to make the greeting accessible to visitors who have audio off.

**What you'll build:**
- An agent that greets every visitor the moment it's ready
- A greeting personality that lives in the agent's instructions, so every greeting fits the brand
- A live transcript region so the greeting is readable, not just audible
- A reusable pattern for text-first greetings versus guaranteed-audible ones
- A clear understanding of browser autoplay rules and how to work with them

**Prerequisites:** A page with the embed working from [Embed in 30 seconds](/tutorials/embed-in-30-seconds). Your agent should already be saved with a brain configured.

---

## Step 1 — The minimal greeting

There is no magic greeting attribute — the greeting is three lines of JavaScript next to your embed. Wait for the element's `agent:ready` event, then hand the agent an opening cue with `say()`:

```html
<script type="module" src="https://three.ws/agent-3d/1.5.2/agent-3d.js"></script>
<agent-3d id="agent" agent-id="YOUR_AGENT_ID" mode="floating" voice eager></agent-3d>

<script>
  const agent = document.getElementById('agent');
  agent.addEventListener('agent:ready', () => {
    agent.say('Hi! Who are you?');
  });
</script>
```

`say(text)` sends the text to the agent's brain as a visitor message. The agent thinks, generates a reply in its own voice — the greeting — and delivers it: the reply streams into the speech bubble above the avatar, lands in the chat thread, drives the talking animation and lip-sync, and (because the element carries the `voice` attribute) is spoken aloud with the agent's TTS voice.

Two things worth knowing about this snippet:

- The cue you pass to `say()` appears in the chat thread as the visitor's message, exactly as if they had typed it. That's why the example uses a natural opener like "Hi! Who are you?" — it reads as the start of a conversation, not as plumbing. (It's the same cue the embed's built-in "Say hi" suggestion chip sends.)
- The boolean `voice` attribute is what makes JS-triggered `say()` calls audible. Without it, the greeting still renders as text and animation — just silently. Messages the visitor types into the chat input are always voiced.

That's a working greeting. The rest of this tutorial is about doing it well rather than doing it at all.

---

## Step 2 — When the greeting fires

`agent:ready` fires once the whole boot pipeline has finished: manifest fetched, GLB body downloaded and rigged, memory loaded, skills installed, brain runtime constructed. Its `detail` carries `{ agent, manifest }`, and the event bubbles and crosses the shadow boundary, so you can also listen at `document` level if you attach the listener before the element boots.

Two timing behaviours matter for greetings:

**The element boots lazily.** By default `<agent-3d>` waits until it is scrolled near the viewport (with a 300px head start) before it downloads anything, which means `agent:ready` — and your greeting — fires when the visitor reaches the agent, not necessarily at page load. For a floating widget that should greet immediately, add the `eager` attribute as in Step 1. For an inline agent halfway down a landing page, lazy is usually what you want: the agent greets when the visitor scrolls to it.

**`say()` waits for readiness on its own.** If you call `say()` before boot finishes, the element holds the message and delivers it once the runtime is up (only the most recent pending message is kept). Listening for `agent:ready` is still the clearest structure — it makes the ordering explicit and gives you a place to hang other on-ready work — but a greeting fired "too early" is not lost.

If you want a beat of breathing room so the visitor has a chance to notice the avatar before it talks:

```js
agent.addEventListener('agent:ready', () => {
  setTimeout(() => agent.say('Hi! Who are you?'), 1500);
});
```

You can also watch boot progress via the `agent:load-progress` event, whose detail is `{ phase, pct }` with phases `manifest`, `body`, `memory`, `skills`, and `brain` — useful if you're rendering your own loading indicator around the embed.

---

## Step 3 — Where the greeting's personality lives

`say()` supplies the cue; the *content* of the greeting comes from the agent's configured personality. There are two places that personality can live, depending on how you embedded.

### Published agents (`agent-id`)

If you embed with `agent-id`, the personality is whatever you saved in the editor at [https://three.ws/create](https://three.ws/create) — open your agent's **Personality** panel and shape the system prompt there. To make greetings consistently on-brand, add explicit greeting guidance to the prompt:

```
When a visitor greets you or asks who you are, introduce yourself in one or
two sentences. Mention your name. Say you can help pick the right Lumen plan.
Invite them to ask anything. Never open with more than two sentences.
```

Save, reload your page, and the same `say('Hi! Who are you?')` cue now produces a greeting that follows your rules — every visitor, phrased freshly each time.

The agent's TTS voice is also part of its saved configuration (the **Voice** panel in the editor), not the embed snippet. One agent, one voice; the greeting uses it like every other line.

### Self-configured embeds (`body` + `brain` + `instructions`)

If you embed a bare GLB instead of a published agent, the element builds the personality from its own attributes. `instructions` is the system prompt, `brain` picks the model (`"free"` resolves to the platform's host-paid free model), and `chat` opts the avatar into the conversational chrome:

```html
<script type="module" src="https://three.ws/agent-3d/1.5.2/agent-3d.js"></script>
<agent-3d
  id="agent"
  body="https://three.ws/avatars/default.glb"
  name="Iris"
  brain="free"
  instructions="You are Iris, the guide for the Lumen productivity app. When a visitor greets you, introduce yourself in one warm sentence and invite them to ask about Lumen. Keep every reply under three sentences."
  chat
  voice
  eager
></agent-3d>

<script>
  const agent = document.getElementById('agent');
  agent.addEventListener('agent:ready', () => {
    agent.say('Hi! Who are you?');
  });
</script>
```

This is a complete, self-contained page — no saved agent required. The `instructions` attribute is only read for these self-configured embeds; on an `agent-id` embed the published personality wins, so edit it in the editor instead.

---

## Step 4 — Tailor the greeting to the visitor

Because the cue is ordinary JavaScript, it can carry whatever context you know at page-load time — and the brain will weave it into the greeting:

```html
<script type="module" src="https://three.ws/agent-3d/1.5.2/agent-3d.js"></script>
<agent-3d id="agent" agent-id="YOUR_AGENT_ID" mode="floating" voice eager></agent-3d>

<script>
  const agent = document.getElementById('agent');

  function greetingCue() {
    const params = new URLSearchParams(location.search);
    const returning = localStorage.getItem('hasVisited') === 'yes';
    if (returning) {
      return "Hi again — I've visited before. Anything new since last time?";
    }
    if (params.get('utm_campaign') === 'launch-2026') {
      return "Hi! I came from the launch announcement. What's new?";
    }
    return 'Hi! Who are you?';
  }

  agent.addEventListener('agent:ready', () => {
    agent.say(greetingCue());
    localStorage.setItem('hasVisited', 'yes');
  });
</script>
```

The pattern is: listen for `agent:ready`, choose a cue in JS, call `say()`. The visitor always gets a greeting, and the greeting reflects what you know about them — the brain handles the phrasing.

If your page logic needs the greeting text back (say, to mirror it into your own UI), use `ask()` instead — it sends the same way but resolves with the reply:

```js
agent.addEventListener('agent:ready', async () => {
  const greeting = await agent.ask('Hi! Who are you?');
  console.log('Agent greeted with:', greeting);
});
```

---

## Step 5 — `speak()` is a gesture, not speech

The element also has a `speak(text)` method, and it's important to be precise about what it does: **`speak()` plays the talking animation, and nothing else.** It sizes the gesture to the length of the text you pass, trying the rig's talk clip and falling back to a nod or a wave — but it does not contact the brain, does not render a speech bubble, and does not produce any audio.

That makes it the wrong tool for a greeting on its own, and the right tool when your page supplies the words and you just want the avatar to visibly "deliver" them — a custom caption, a scripted onboarding line you render yourself:

```html
<agent-3d id="agent" agent-id="YOUR_AGENT_ID" mode="floating" eager></agent-3d>
<div id="caption" role="status" aria-live="polite"
     style="position: fixed; bottom: 460px; right: 24px; max-width: 280px;
            padding: 10px 14px; border-radius: 12px; background: #fff;
            color: #1a1a2e; box-shadow: 0 4px 24px rgba(0,0,0,.2); font: 14px system-ui;">
</div>

<script>
  const agent = document.getElementById('agent');
  const caption = document.getElementById('caption');

  agent.addEventListener('agent:ready', () => {
    const line = "Hi, I'm Iris. Click me if you have a question.";
    caption.textContent = line;   // your page shows the exact words
    agent.speak(line);            // the avatar mouths along, silently
    setTimeout(() => { caption.textContent = ''; }, 6000);
  });
</script>
```

The trade-off is exactness versus life: `speak()` plus your own caption gives you a fixed, word-for-word scripted line with zero LLM involvement; `say()` gives you a living greeting in the agent's voice — bubble, audio, and all — but freshly phrased each time. If you need the audible line to be word-for-word, put the exact sentence in the instructions ("When a visitor greets you, reply with exactly: …") and use `say()`; the model will deliver it near-verbatim, and it stays in the real speech pipeline.

---

## Step 6 — Browser autoplay rules

Here is the most important practical point in this tutorial. Modern browsers do not let websites play audio before the visitor has interacted with the page. The reasons are good — spammy auto-playing ads, suddenly loud tabs — but the rules apply to your agent's spoken greeting too. Chrome and Edge may allow audio if the visitor has engaged with your domain before; Safari and iOS block it on every fresh load until the first tap or keypress.

The saving grace: **the greeting's text always lands.** The reply streams into the speech bubble and the chat thread whether or not the audio was allowed to play, so a greeting fired on `agent:ready` is never wasted — worst case it's read instead of heard.

That gives you two clean patterns. Pick one; don't chain them (the runtime processes one conversational turn at a time, so a second `say()` fired while the greeting is still streaming will surface a "still thinking" notice instead).

**Pattern A — text-first (the default).** Greet on `agent:ready` as in Step 1. On permissive browsers the greeting is spoken; on strict ones it's read. Ship this unless spoken audio is essential to the experience.

**Pattern B — guaranteed-audible.** Hold the greeting until the visitor's first interaction, which unlocks audio everywhere:

```js
const agent = document.getElementById('agent');

const greetOnFirstTouch = () => {
  document.removeEventListener('pointerdown', greetOnFirstTouch);
  document.removeEventListener('keydown', greetOnFirstTouch);
  agent.say('Hi! Who are you?', { voice: true });
};
document.addEventListener('pointerdown', greetOnFirstTouch);
document.addEventListener('keydown', greetOnFirstTouch);
```

The `{ voice: true }` option forces the spoken reply even without the `voice` attribute on the element.

And a few patterns to avoid, even though you'll see them on other sites: don't simulate clicks to trick the autoplay gate (browsers detect it and penalise the page), and don't put a full-page "click to enable audio" wall in front of your content — the visitor's first natural interaction is enough.

---

## Step 7 — Make the greeting accessible

Some visitors have audio off, use a screen reader, have a hearing impairment, or are somewhere they won't enable sound. The embed already covers the basics: the chat thread is an ARIA live log (`role="log"`, `aria-live="polite"`), and the speech bubble is a live status region, so screen readers announce the greeting as it arrives.

Write the greeting instructions with the assumption that someone might read it before they hear it:

- Make it useful as text. "Hi, I'm Iris. Ask me anything about Lumen." reads as well as it sounds. "Hi!" alone reads as a stub.
- Avoid pronunciation asides and pause cues ("Hi. (pause) I'm Iris") — they work in audio and look broken in writing.

If you want a heavier-handed setup — a permanent transcript pane next to the agent — listen for the speech events. `voice:speech-start` fires each time the agent begins speaking a line aloud, with the full text in `event.detail.text`; `voice:speech-end` fires when it finishes:

```html
<div id="transcript" aria-live="polite" style="margin-top: 12px; color:#666; font-size: 0.9rem;">
  <strong>Agent says:</strong> <span id="transcript-text">…</span>
</div>

<script>
  const agent = document.getElementById('agent');
  const out = document.getElementById('transcript-text');

  agent.addEventListener('voice:speech-start', (event) => {
    out.textContent = event.detail.text;
  });
</script>
```

Note these events accompany *spoken* lines — they fire when a reply goes through TTS (the `voice` attribute, `{ voice: true }`, or the built-in chat input). To mirror every reply regardless of audio, listen for `brain:message` and read `event.detail.content` when `event.detail.role === 'assistant'`.

---

## Step 8 — Writing a good greeting

Here is what makes a greeting effective, distilled from watching first-time visitors interact with embeds across many sites. These rules go into the agent's instructions (Step 3), since that's what shapes the actual words.

### Lead with the name

Visitors form an opinion in the first three seconds. "Hi, I'm Iris" does two things at once: it establishes that the agent is a named entity (not a generic chatbot), and it gives the visitor a handle to use ("Iris, can you…"). Both matter.

### State the agent's role

The visitor doesn't know what the agent is for. Tell them.

- "I'm Iris. I can help you pick the right plan."
- "I'm Pip. I'll show you around the games."
- "I'm Chef Olive. Ask me about any recipe."

Specificity beats vagueness. "I can help you" is weaker than "I can help you pick the right plan", which is weaker still than "I can help you decide between Lumen Pro and Lumen Team".

### Invite action

End with an instruction or invitation. Visitors who don't know what to do next, won't.

- "Ask me anything — just type below."
- "Try asking 'what's new this month?'"

### Keep it to one or two sentences

A long greeting feels like a sales pitch. Two short sentences feel like a person. Cap it in the instructions ("Never open with more than two sentences") — models respect explicit limits far better than vague ones.

### A complete example

For a hypothetical online wine merchant called "Bottle Lane", the greeting block of the instructions might read:

```
You are Vincent, Bottle Lane's sommelier. When a visitor greets you or asks
who you are, introduce yourself in one sentence and offer to recommend a
bottle for any occasion — ask what they're celebrating. Never open with more
than two sentences.
```

A typical greeting this produces: "Hi, I'm Vincent. I can recommend a bottle for any occasion — what are you celebrating?" Names the agent. States the value. Invites the visitor to be specific. Reads well aloud and reads well silent.

For a developer tool, same structure, different register: "Hey, I'm Otto. Ask me how to set up a build, or paste a config and I'll review it."

---

## Step 9 — Debugging a silent greeting

If the greeting isn't arriving, work through this checklist in order.

1. **Does the speech bubble show text?** If yes, the greeting is working and only the audio is missing — skip to step 5. If no text appears anywhere, the message isn't reaching the brain — keep going.

2. **Is the agent booting at all?** Open the browser console and the network tab. You should see the manifest and GLB load with 200 status. If the agent ID is wrong, the element falls back to the default avatar rather than erroring — so a *wrong-looking* avatar is your clue. Double-check the ID at [https://three.ws/my-agents](https://three.ws/my-agents). You can also listen for failures: `agent.addEventListener('agent:error', (e) => console.log(e.detail.phase, e.detail.error))`.

3. **Is the element still lazy-loading?** Without `eager`, an off-screen element hasn't booted, so `agent:ready` hasn't fired. Scroll it into view, or add `eager`.

4. **Does the agent have a brain?** A self-configured embed with no `brain` attribute has no model to answer with. Add `brain="free"`. For `agent-id` embeds, confirm a brain is configured on the agent in the editor.

5. **Is voice enabled for JS calls?** `say()` from JavaScript only speaks aloud when the element has the `voice` attribute (or you pass `{ voice: true }`). This is the single most common cause of "text shows, no audio".

6. **Has the visitor interacted with the page yet?** On strict-autoplay browsers (Safari, iOS), audio won't play before the first tap or keypress — the text still shows. See Step 6 for the guaranteed-audible pattern.

7. **Is the tab muted, and is the system volume up?** Genuinely worth checking. Some browsers show "Unmute tab" in the tab's context menu.

In practice, problems are almost always step 5 (missing `voice` attribute) or step 6 (autoplay rules). The embed is conservative on purpose — better a silent, readable greeting than a visitor ambushed by unexpected audio.

---

## What you learned

- The greeting flow is: listen for `agent:ready`, then call `say()` with a natural opening cue
- `say()` routes through the agent's brain, so the greeting's content comes from its personality — the editor's Personality panel for published agents, the `instructions` attribute for self-configured ones
- The `voice` attribute (or `{ voice: true }`) makes JS-triggered replies audible; the text bubble renders either way
- `speak()` is the talking *gesture* only — no brain, no audio — useful when your page supplies the words itself
- Browser autoplay rules can suppress the audio on first load; greet on `agent:ready` for a text-first greeting, or on the first user interaction for a guaranteed-audible one
- `voice:speech-start` / `voice:speech-end` (and `brain:message`) let you mirror the greeting into your own transcript UI
- A good greeting names the agent, states its role, invites action, and stays under two sentences — enforce that in the instructions

A working greeting moves the embed from "decoration" to "interaction", which is the single biggest win you can ship after the basic embed is live.

---

## Next steps

- [Embed in 30 seconds](/tutorials/embed-in-30-seconds) — the foundation embed, if you skipped it
- [Customize size, position and background](/tutorials/customize-appearance) — make the embed match your brand visually
- [Drive the agent with the JavaScript API](/tutorials/js-api-events) — the full method and event reference behind this tutorial
- [Give your agent a personality](/tutorials/agent-personality) — go deeper on the system prompt that shapes every greeting
- [Voice and lip-sync](/tutorials/voice-and-lipsync) — how the spoken side works under the hood
- [Share your agent](/tutorials/share-your-agent) — generate a public URL, QR code, and social previews for the agent itself
