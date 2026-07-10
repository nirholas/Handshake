# @three-ws/react

React components for embedding [three.ws](https://three.ws) 3D AI agents. Drop a
walking 3D avatar into any React app in two lines — no Three.js, no WebGL setup,
no build config. The 3D runtime lives inside three.ws and renders through a
sandboxed iframe.

```bash
npm install @three-ws/react
```

## Quick start

```jsx
import { Agent3D } from '@three-ws/react';

export default function Page() {
  return <Agent3D agentId="your-agent-id" controls="joystick" />;
}
```

That's it. `<Agent3D>` renders a responsive 3D viewer (default `100%` × `600px`)
that loads your agent's avatar and lets visitors walk it around.

`WalkEmbed` is exported as an alias of `Agent3D` for backwards compatibility:

```jsx
import { WalkEmbed } from '@three-ws/react';
```

## Lifecycle & imperative control

```jsx
import { useRef } from 'react';
import { Agent3D } from '@three-ws/react';

export function Avatar() {
  const ref = useRef(null);

  return (
    <Agent3D
      ref={ref}
      agentId="your-agent-id"
      controls="joystick"
      width={480}
      height={720}
      onLoad={() => console.log('scene ready')}
      onError={(err) => console.error(err)}
    />
  );
}

// Later, drive the live embed:
ref.current.setMotion('walk');     // 'idle' | 'walk' | 'run'
ref.current.setAvatar('av-1234');  // swap avatar live
ref.current.setSpeed(1.5);         // walk-speed multiplier (0.3–3)
ref.current.narrate('Hi there!');  // speech bubble over the avatar
ref.current.setEnvironment('studio');
ref.current.resetPose();
```

## Props

| Prop          | Type                                  | Default        | Description                                            |
|---------------|---------------------------------------|----------------|--------------------------------------------------------|
| `agentId`     | `string` (required)                   | —              | The three.ws agent ID — its avatar is rendered.        |
| `avatarId`    | `string`                              | —              | Override the agent's default avatar.                   |
| `controls`    | `"joystick" \| "keyboard" \| "none"`  | `"joystick"`   | Movement controls.                                     |
| `background`  | `string`                              | transparent    | `"transparent"` or a hex color like `"#1b1b1b"`.       |
| `environment` | `string`                              | `"studio"`     | Environment preset.                                    |
| `autoplay`    | `boolean`                             | `false`        | Autoplay an idle walk loop.                            |
| `ground`      | `boolean`                             | `true`         | Show the shadow ground disc.                           |
| `orbit`       | `boolean`                             | `true`         | Allow orbit drag on desktop.                           |
| `speed`       | `number`                              | `1`            | Walk-speed multiplier (0.3–3), applied once ready.     |
| `width`       | `string \| number`                    | `"100%"`       | Container width (number → px).                         |
| `height`      | `string \| number`                    | `"600px"`      | Container height (number → px).                        |
| `onLoad`      | `() => void`                          | —              | Fires when the 3D scene is ready.                      |
| `onError`     | `(err: Error) => void`                | —              | Fires on load failure.                                 |
| `className`   | `string`                              | —              | CSS class on the wrapper `<div>`.                      |
| `style`       | `React.CSSProperties`                 | —              | Inline styles on the wrapper `<div>`.                  |
| `title`       | `string`                              | three.ws title | Accessible title for the underlying iframe.            |

### Imperative handle (via `ref`)

| Method                    | Description                                  |
|---------------------------|----------------------------------------------|
| `sendMessage(msg)`        | Post an arbitrary message to the embed.      |
| `setAvatar(id)`           | Swap the rendered avatar live.               |
| `setMotion(motion)`       | `"idle" \| "walk" \| "run"`.                 |
| `setEnvironment(env)`     | Switch the environment preset live.          |
| `setSpeed(value)`         | Set the walk-speed multiplier (0.3–3).       |
| `narrate(text)`           | Show a speech bubble above the avatar.       |
| `resetPose()`             | Recenter the avatar on the ground.           |
| `iframe`                  | The underlying `HTMLIFrameElement` (or null).|

## Security

Inbound `postMessage` events are accepted **only** from the three.ws origin and
**only** from this component's own iframe — messages from any other origin or
window are ignored. This is enforced regardless of which `onLoad`/`onError`
handlers you pass.

## TypeScript

Types ship with the package (`Agent3DProps`, `Agent3DHandle`, `Agent3DControls`).
No `@types` install needed.

## Requirements

`react` and `react-dom` `>= 17` are peer dependencies — the package never bundles
its own React.

## Links

- Full docs: <https://three.ws/docs>
- Live embed configurator: <https://three.ws/embed/walk>
- Live player: <https://three.ws/walk-embed>

## License

Apache-2.0 © three.ws
