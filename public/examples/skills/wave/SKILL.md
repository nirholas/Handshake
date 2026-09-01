# wave

The starter skill. One tool, ten lines of handler: it plays the built-in `wave`
gesture, then speaks a greeting. Referenced by
[examples/coach-leo/manifest.json](../../coach-leo/manifest.json) and walked
through in the [skills guide](https://three.ws/docs/skills).

| Tool | Use it for |
|---|---|
| `waveAndGreet` | Wave + spoken greeting in one call |

## Why it exists

Every skill bundle has the same four files (`manifest.json`, `tools.json`,
`handlers.js`, `SKILL.md`). This one is intentionally minimal so you can copy
the directory, rename the tool, and have a working custom skill in minutes. The
handler shows the two context calls most skills need:

```js
await ctx.call('wave', {});   // dispatch any built-in or skill tool
await ctx.speak('Hello!');    // TTS through the agent's configured voice
```

## Config

`manifest.config.greeting` sets the default line. Callers can override it per
call with the `greeting` argument.

## Try it

Load Coach Leo (`examples/coach-leo/`) and ask him to say hi, or install the
skill on any agent and call the tool directly:

```js
const el = document.querySelector('agent-3d');
await el.installSkill('/examples/skills/wave/');
```
