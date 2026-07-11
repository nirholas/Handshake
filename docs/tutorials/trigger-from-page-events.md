# Trigger the agent from page events

An agent that just sits in the corner waiting for a click is a chatbot widget with a face. An agent that *reacts* to what the user is actually doing — scrolling past a feature, abandoning a form, returning from a long idle — is a co-pilot. The second one converts. The first one decorates.

This tutorial covers the page-event recipes that turn the agent into a part of the user journey. We'll wire scroll, form, route, idle, and visibility events into agent reactions, and then assemble a four-step onboarding co-pilot that walks a brand-new user through a real product tour.

**What you'll build:**
- An agent that waves when the visitor scrolls past your "How it works" section
- A checkout flow that celebrates on submit and apologises on error
- An SPA where the agent greets you with a context-aware message per route
- An idle re-engagement pattern using the Page Visibility API and real activity tracking
- A four-step onboarding co-pilot that walks new users through the page

**Prerequisites:** You've completed the [first agent tutorial](/tutorials/first-agent) or have an agent mounted on a page. Comfortable with `addEventListener`, `IntersectionObserver`, and `MutationObserver` or browser routing libraries.

---

## Step 1 — Page setup

Every recipe in this tutorial assumes you have an agent on the page. The simplest mount:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Reactive agent</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; line-height: 1.6; }
    section { min-height: 80vh; padding: 80px 10vw; }
    section:nth-child(odd)  { background: #f6f6f8; }
    section:nth-child(even) { background: #fff; }
    h2 { font-size: 2rem; margin: 0 0 16px; letter-spacing: -0.02em; }
  </style>
  <script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>
</head>
<body>
  <section><h2>Hero</h2><p>Headline copy here.</p></section>
  <section id="how-it-works"><h2>How it works</h2><p>Steps.</p></section>
  <section id="pricing"><h2>Pricing</h2><p>Plans.</p></section>
  <section id="cta"><h2>Get started</h2><form id="signup"></form></section>

  <agent-3d
    id="agent"
    agent-id="YOUR_AGENT_ID"
    mode="floating"
    position="bottom-right"
    width="280px"
    height="380px"
  ></agent-3d>

  <script type="module" src="./reactions.js"></script>
</body>
</html>
```

Across this tutorial, `agent` always refers to:

```js
// reactions.js
const agent = document.getElementById('agent');

function whenReady(el) {
  return new Promise((resolve) => {
    if (el._mounted) { resolve(el); return; }
    el.addEventListener('agent:ready', () => resolve(el), { once: true });
  });
}
```

The `whenReady` helper is the same one from the [JS API tutorial](/tutorials/js-api-events). Every reaction below starts by awaiting it.

---

## Step 2 — React to scroll position

The brittle way to detect "user scrolled past section X" is a `scroll` listener that compares `window.scrollY` to a hard-coded number. It breaks on every layout change.

The right way is `IntersectionObserver`. The browser tells you when a target element enters or leaves the viewport, with zero scroll listeners and zero layout reads.

Here's a "wave when you reach the How it works section" reaction:

```js
async function setupScrollWave() {
  await whenReady(agent);

  const target = document.getElementById('how-it-works');
  if (!target) return;

  let waved = false;
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && !waved) {
        waved = true;
        agent.wave();
        agent.speak('This is the part I get excited about. Let me know if anything is unclear.');
        io.disconnect();
      }
    }
  }, { threshold: 0.4 }); // fires when 40% of the section is visible

  io.observe(target);
}
setupScrollWave();
```

A few decisions worth calling out:

- **One-shot.** `waved` and `io.disconnect()` make this fire exactly once. Re-engaging on every visit through the section gets annoying fast.
- **Threshold 0.4.** Picked so the agent doesn't speak the moment a single pixel of the section is visible — the user should be *reading* the section, not catching the first peek.
- **`agent.speak` not `agent.say`.** This is a deterministic line. We don't want the LLM to invent a different reaction each time.

For multiple sections with different scripts:

```js
async function setupSectionTour() {
  await whenReady(agent);

  const cues = {
    'how-it-works': "Here's how it actually works under the hood.",
    'pricing':       "Quick note on pricing — all plans include the full feature set.",
    'cta':           "When you are ready, the signup form is right here.",
  };

  const seen = new Set();
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const id = entry.target.id;
      if (entry.isIntersecting && !seen.has(id)) {
        seen.add(id);
        agent.speak(cues[id]);
      }
    }
  }, { threshold: 0.4 });

  for (const id of Object.keys(cues)) {
    const el = document.getElementById(id);
    if (el) io.observe(el);
  }
}
setupSectionTour();
```

Each section is announced once. The `seen` set prevents re-trigger if the user scrolls back up.

---

## Step 3 — React to form submits

The form-submit reaction is one of the highest-impact patterns. The user did something deliberate — they're at peak attention. A confirmation that feels human (not "Order received") moves the moment from transactional to memorable.

The structure: intercept the submit, run the real API call, branch on success.

```js
async function setupSignupCelebration() {
  await whenReady(agent);
  const form = document.getElementById('signup');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());

    let ok = false;
    try {
      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
      });
      ok = res.ok;
    } catch (err) {
      ok = false;
    }

    if (ok) {
      agent.playEmote('celebrate');
      agent.speak(`You're in, ${data.name || 'friend'}. I will check in on you in a moment.`);
    } else {
      agent.playEmote('flinch');
      agent.speak('Something broke on our side. Give it another go in a second?');
    }
  });
}
setupSignupCelebration();
```

`playEmote` falls through a chain of clip names (`celebrate` → `cheer` → `wave`, or `flinch` → `concern`), so the reaction works regardless of what's baked into the loaded GLB.

The pattern generalises: any form on your page — newsletter signup, contact form, lead capture, checkout — fits the same shape. Real fetch, branch on result, agent reacts.

---

## Step 4 — React to SPA route changes

If you're on Next.js, React Router, Vue Router, or any SPA framework, route changes don't fire `load`. The agent boots once at app start and stays put while the URL changes underneath. Reacting to that is two steps: detect the change, look up a per-route script.

The cleanest universal hook is the browser's `popstate` event combined with patched `pushState` / `replaceState`. Most routers fire `popstate` on back/forward but not on programmatic navigation — patching closes the gap.

```js
function onRouteChange(handler) {
  let last = location.pathname;
  function fire() {
    if (location.pathname === last) return;
    last = location.pathname;
    handler(last);
  }
  window.addEventListener('popstate', fire);
  const orig = { push: history.pushState, replace: history.replaceState };
  history.pushState = function (...args) {
    const r = orig.push.apply(this, args);
    fire();
    return r;
  };
  history.replaceState = function (...args) {
    const r = orig.replace.apply(this, args);
    fire();
    return r;
  };
  // Fire once for the initial route.
  handler(last);
}

async function setupRouteGreetings() {
  await whenReady(agent);

  const scripts = {
    '/':          "Welcome in. Have a look around.",
    '/pricing':   "Pricing is straightforward. Ask me if anything looks fuzzy.",
    '/docs':      "The docs cover the deep cuts. Tell me what you want to learn.",
    '/contact':   "If you reach out from here, a real human will reply.",
  };

  const greeted = new Set();
  onRouteChange((path) => {
    const line = scripts[path];
    if (!line || greeted.has(path)) return;
    greeted.add(path);
    agent.speak(line);
  });
}
setupRouteGreetings();
```

If you're using React Router or Next.js, prefer the framework's own hook (`useEffect` with `usePathname` in App Router, `useRouter().events` in Pages Router, `useLocation` in React Router). The pattern is the same — `whenReady(agent)`, look up the script for the current path, fire `agent.speak`.

The `greeted` set is the polite touch: the agent doesn't re-introduce a page the user has already visited.

---

## Step 5 — Re-engage on idle (the right way)

This is the recipe most often done wrong. The lazy version is a `setTimeout` after page load that fires no matter what the user is doing — including reading the page intently. That feels rude.

The right pattern tracks *real activity* (mouse moves, key presses, scroll), and only re-engages if the user has been inactive for a while *and* the tab is in the foreground (Page Visibility API). It also debounces — no double-fire from quick activity bursts.

```js
async function setupIdleReengagement({ idleMs = 60_000, line = 'Still here? I can help if you got stuck.' } = {}) {
  await whenReady(agent);

  let lastActivity = Date.now();
  let fired = false;

  const bump = () => { lastActivity = Date.now(); fired = false; };
  for (const ev of ['mousemove', 'keydown', 'scroll', 'pointerdown', 'touchstart']) {
    window.addEventListener(ev, bump, { passive: true });
  }

  // Pause the idle timer when the tab is hidden so we don't shout into an empty room.
  let hidden = document.visibilityState === 'hidden';
  document.addEventListener('visibilitychange', () => {
    hidden = document.visibilityState === 'hidden';
    if (!hidden) bump(); // returning to the tab counts as activity
  });

  setInterval(() => {
    if (hidden || fired) return;
    if (Date.now() - lastActivity < idleMs) return;
    fired = true;
    agent.lookAt('user');
    agent.speak(line);
  }, 2_000);
}
setupIdleReengagement({ idleMs: 30_000 });
```

This satisfies every rule worth caring about:

- **Real activity** — every meaningful user event resets the clock.
- **Real visibility** — the agent stays quiet while the tab is in the background.
- **One fire** — `fired` flips true after the line plays, so the agent doesn't keep repeating itself.
- **Two-second cadence** — the `setInterval` polls cheaply rather than blocking on a timeout.

If you want a smarter re-engagement that loops *until* the user does something — say, gently shifting tone over time — you'd reset `fired` only on subsequent activity, and pick a different line for the second and third nudges:

```js
const lines = [
  'Still here? I can help if you got stuck.',
  'Take your time. I am around if you need a hand.',
];
let nudge = 0;
// ...inside the interval, when conditions match:
agent.speak(lines[nudge % lines.length]);
nudge++;
```

The Page Visibility check is non-optional. A repeating speech that fires while the tab is hidden is one of the fastest ways to get your widget muted forever.

---

## Step 6 — A four-step onboarding co-pilot

Now the showpiece. A new user lands on your product page; the agent walks them through four steps tied to real page elements, advances when each step is satisfied, and stays out of the way once the tour is done.

The plan:

1. **Step 0 — Introduce.** The agent says hello and points at the hero CTA.
2. **Step 1 — Scroll.** When the user reaches the features section, agent narrates one feature and waves.
3. **Step 2 — Interact.** When the user clicks the demo button, agent celebrates.
4. **Step 3 — Convert.** When the user fills the signup form, agent fires the celebration sequence and ends the tour.

The page elements:

```html
<section id="hero">
  <h2>Welcome</h2>
  <button id="cta-primary">Try the demo</button>
</section>

<section id="features"><h2>What it does</h2><!-- body --></section>

<section id="demo">
  <h2>Live demo</h2>
  <button id="demo-trigger">Launch interactive demo</button>
</section>

<section id="signup-section">
  <h2>Start your account</h2>
  <form id="onboarding-signup">
    <input name="email" type="email" required placeholder="your@email.com">
    <button type="submit">Create account</button>
  </form>
</section>
```

The co-pilot logic:

```js
async function runOnboarding() {
  await whenReady(agent);

  // Skip the tour if the user has done it before.
  if (localStorage.getItem('threews_tour_complete') === '1') return;

  // Step 0: introduce
  agent.wave();
  agent.speak('Hey, first time here? I will walk you through it in four short steps.');

  // Step 1: scroll to features
  await waitForVisible('#features', 0.4);
  agent.lookAt('user');
  agent.speak('This is the part most people love — every plan ships with the full feature set, no upgrade tricks.');

  // Step 2: click the demo button
  await waitForClick('#demo-trigger');
  agent.playEmote('celebrate');
  agent.speak('Nice. Play with it as long as you like — I will be here when you are ready.');

  // Step 3: complete the signup form
  await waitForFormSubmit('#onboarding-signup');
  agent.playEmote('celebrate');
  agent.speak('That is the whole tour. Check your email for the welcome note.');

  localStorage.setItem('threews_tour_complete', '1');
}

function waitForVisible(selector, threshold = 0.5) {
  return new Promise((resolve) => {
    const target = document.querySelector(selector);
    if (!target) { resolve(); return; }
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          io.disconnect();
          resolve();
          return;
        }
      }
    }, { threshold });
    io.observe(target);
  });
}

function waitForClick(selector) {
  return new Promise((resolve) => {
    const el = document.querySelector(selector);
    if (!el) { resolve(); return; }
    el.addEventListener('click', () => resolve(), { once: true });
  });
}

function waitForFormSubmit(selector) {
  return new Promise((resolve) => {
    const form = document.querySelector(selector);
    if (!form) { resolve(); return; }
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      // Run the real signup request before resolving so the agent's celebration
      // only fires on success.
      const data = Object.fromEntries(new FormData(form).entries());
      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (res.ok) resolve();
      else {
        agent.speak('That signup did not go through. Mind trying once more?');
      }
    }, { once: true });
  });
}

runOnboarding();
```

A few details that make this feel polished instead of mechanical:

- **`localStorage` gate.** Returning users skip the tour entirely. The agent stops being a tour guide and goes back to being a co-pilot.
- **Each step is a real Promise that resolves on a real event** — no timed waits, no "wait 5 seconds and hope". The agent advances exactly when the user does.
- **The signup step gates on the real fetch.** Failed signups don't celebrate; they get an apology and retry.
- **`{ once: true }` everywhere.** Each handler self-cleans after firing, so the agent doesn't speak twice for the same step.

You can extend this pattern indefinitely — five-step tours, six-step tours, branching tours where step 3 depends on which option the user picked in step 2. The discipline is always the same: each step is a Promise, the script is linear `await` after `await`.

---

## Step 7 — Combining the recipes

The recipes in Steps 2 through 5 compose without conflict — they all listen to different events. Mount all of them on one page and the agent gets a full reactive personality:

- Scroll past the features section → narrates one feature
- Submit the signup form → celebrates or apologises
- Change route → context-aware greeting
- Go idle for 30 seconds → gentle re-engagement
- New visitor → four-step onboarding tour

The only thing to watch for is **speech overlap**. If two recipes trigger at the same moment (a route change *and* a scroll-into-view, say), they fire back-to-back and the second one cuts off the first.

The fix is a small speech-queue helper:

```js
const speechQueue = [];
let speechBusy = false;

agent.addEventListener('voice:speech-end', () => {
  speechBusy = false;
  drainQueue();
});

function speak(text, emote) {
  speechQueue.push({ text, emote });
  drainQueue();
}

function drainQueue() {
  if (speechBusy) return;
  const next = speechQueue.shift();
  if (!next) return;
  speechBusy = true;
  if (next.emote) agent.playEmote(next.emote);
  agent.speak(next.text);
}
```

Replace every direct `agent.speak(...)` in your recipes with `speak(...)` and the agent will queue its lines instead of stepping on them. Animations fired alongside still happen instantly — only the spoken track is serialised.

---

## What you learned

The full toolbox for reactive page integration:

- `IntersectionObserver` for scroll milestones — no scroll listeners, no layout reads
- Submit-then-fetch-then-react for form celebrations
- Patched `history.pushState` / `popstate` for SPA route changes
- Activity + visibility tracking for honest idle re-engagement
- Promise-chained onboarding tours with `localStorage` gating
- A speech queue when recipes start to collide

The pattern under all of these is the same: every recipe starts with `whenReady(agent)`, listens to a real browser event, and calls the agent's API in response. No fake timers, no `setTimeout` substitutes for real activity, no progress bars that aren't measuring anything.

## Next steps

- [Drive the agent with the JavaScript API](/tutorials/js-api-events) — every method and event the agent exposes
- [Give your agent a personality](/tutorials/agent-personality) — a system prompt that holds across these reactive moments
- [Use the &lt;agent-3d&gt; web component end-to-end](/tutorials/web-component-end-to-end) — wrap these recipes into framework-friendly components
