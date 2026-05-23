# @three-ws/agent-ui

Drop a 3D avatar into your UI and let it react to buttons, inputs, and navigation.

A small Three.js overlay SDK that takes the avatar-stage runtime used by the [three.ws](https://three.ws) demos (`404`, `login`, `3d-home`) and packages it as a drop-in API. The avatar lives on a transparent fullscreen canvas above your DOM, anchored to real elements — it can stand on a card, fall onto a heading, walk over to focus an input, cover its eyes when you type a password, or run off-screen before navigating away.

```bash
npm install @three-ws/agent-ui three
```

## Quick start

```html
<canvas></canvas>
<button id="go" data-agent-action="navigate-on-click">Take me home</button>

<script type="module">
  import { createAgentUI } from '@three-ws/agent-ui';

  const agent = await createAgentUI({
    avatar: '/avatars/cz.glb',
    clipsBase: '/animations/clips/',
    clips: ['idle', 'walk', 'falling'],
  });

  agent.fallOnto(document.getElementById('hero'), {
    onLand: () => {
      agent.fx.dust(document.getElementById('hero'));
      agent.fx.impactPulse(document.getElementById('hero'));
    },
  });

  agent.scan(); // wires any data-agent-action attributes in the page
</script>
```

## Imperative API

```js
agent.play('idle', { loop: true });
agent.play('covereyes', { loop: false, hold: true, onComplete: () => {} });

agent.standOn(formCard, { anchor: 'top-center' });
agent.walkTo(emailInput);
agent.fallOnto(heading, { duration: 1.4 });
agent.runOff('right');
agent.interceptNavigation(homeLink, { direction: 'right', delay: 1100 });

agent.lookAt(450);       // screen-X in pixels
agent.faceFront();

const stopShadow = agent.fx.proximityShadow(heading);
agent.fx.dust(buttonEl);
agent.fx.impactPulse(buttonEl);
```

## Declarative attributes

Mark up the page and call `agent.scan()` once — no per-element JS needed.

```html
<input data-agent-action="track-typing" />
<input data-agent-action="privacy-mode" type="password" />

<a href="/" data-agent-action="navigate-on-click" data-agent-direction="right">Home</a>
<button data-agent-action="react-on-click" data-agent-clip="celebrate">Subscribe</button>

<div class="card" data-agent-action="stand-on"></div>
```

| `data-agent-action`  | Behavior                                                                  |
| -------------------- | ------------------------------------------------------------------------- |
| `stand-on`           | Park the avatar above this element on ready.                              |
| `track-typing`       | On focus, walk to the input, play `lookdown`, follow the caret with yaw.  |
| `privacy-mode`       | On focus, walk to the input, play `covereyes` once and hold.              |
| `navigate-on-click`  | Intercept click, run off-screen, then follow `href`.                      |
| `react-on-click`     | Play `data-agent-clip` once on click.                                     |

## Options

```ts
createAgentUI({
  avatar: '/avatars/cz.glb',
  clipsBase: '/animations/clips/',
  clips: ['idle', 'walk', 'lookdown', 'covereyes', 'falling', 'celebrate'],
  subclips: {
    // Trim a long Mixamo clip down to just the settle frames
    covereyes: { start: 0, end: 48, fps: 30 },
  },
  pixelsPerUnit: 120,
  zIndex: 999,
  parallax: true,
  crossfade: 0.3,
  lights: true,
});
```

## Notes

- **Assets are yours.** The SDK does not bundle the avatar GLB or animation JSONs — point it at whatever you host. The three.ws CDN paths used in the demos are the defaults but every URL is configurable.
- **Three.js is a peer dep** so your bundler de-dupes it. Works with Three r150+.
- **No gsap dep.** All tweens use built-in `requestAnimationFrame` easings.
- **Root motion is locked** automatically so walk-cycle hip translation doesn't drift the avatar off-screen.

## License

Apache-2.0 © three.ws
