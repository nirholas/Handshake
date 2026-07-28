# Example skills

Six installable skill bundles for the three.ws agent runtime. Every skill is the
same four files: `manifest.json` (identity, provided tools, config, requirements),
`tools.json` (JSON-Schema tool definitions the model sees), `handlers.js` (the
implementations), and `SKILL.md` (the docs). Copy any of these directories to
build your own skill; [wave/](./wave/) is the intentionally minimal starting point.

## The skills

| Skill | Kind | Tools |
|---|---|---|
| [wave/](./wave/) | Starter | `waveAndGreet`: plays the built-in `wave` gesture, then speaks a greeting. Ten lines of handler. |
| [solana-wallet/](./solana-wallet/) | Primitives | `getAddress`, `getBalance`, `getSplBalances`, `transferSol`, `transferSpl`, `wrapSol`, `unwrapSol`, `getRecentSignatures`. Provides the `ctx.wallet` contract the signing skills consume. |
| [pump-fun/](./pump-fun/) | Read-only market intel | 10 tools (`searchTokens`, `getBondingCurve`, `getTokenHolders`, `getCreatorProfile`, ...) backed by the in-house `/api/pump-fun-mcp` route. |
| [pump-fun-trade/](./pump-fun-trade/) | Signing actions | `quoteTrade`, `buyToken`, `sellToken`, `createToken` via `@pump-fun/pump-swap-sdk`, hard-capped by `manifest.config.maxSpendSol`. |
| [pump-fun-compose/](./pump-fun-compose/) | Agent loops | `researchAndBuy`, `autoSnipe`, `copyTrade`, `rugExitWatch`: compositions over the read and trade skills, with spend caps, `dryRun`, resumable `sessionId`, and `AbortSignal` support. |
| [pump-fun-strategy/](./pump-fun-strategy/) | Strategy DSL | `validateStrategy`, `runStrategy`, `backtestStrategy`: one declarative JSON spec compiled into a live run or a backtest by the same evaluator, so the two cannot drift. |

Each directory's `SKILL.md` is the authoritative doc for that skill: tool
arguments, config keys, safety caps, and wiring.

## Installing a skill on an agent

Reference the skill directory from an agent manifest, as
[examples/coach-leo/manifest.json](../coach-leo/manifest.json) does:

```json
"skills": [{ "uri": "../skills/wave/", "version": "0.1.0" }]
```

Or install it at runtime on a live `<agent-3d>` element (from
[wave/SKILL.md](./wave/SKILL.md)):

```js
const el = document.querySelector('agent-3d');
await el.installSkill('/examples/skills/wave/');
```

## How handlers work

Every exported handler receives `(args, ctx)`. The wave handler in full
([wave/handlers.js](./wave/handlers.js)):

```js
export async function waveAndGreet(args, ctx) {
	await ctx.call('wave', {});
	const greeting = args?.greeting ?? ctx?.skillConfig?.greeting ?? 'Hey there!';
	await ctx.speak(greeting);
	return { ok: true, data: { waved: true, greeting } };
}
```

The host runtime injects the context: `ctx.call` dispatches any built-in or
skill tool, `ctx.speak` runs TTS through the agent's configured voice,
`ctx.skills.invoke('skill.tool', args)` calls sibling skills,
`ctx.wallet` (from the solana-wallet skill) signs, and `ctx.memory` persists
session state. Signing skills never accept keys via tool args.

## Dependency graph

`pump-fun-trade` requires `solana-wallet` (for `ctx.wallet`). `pump-fun-compose`
and `pump-fun-strategy` require both `pump-fun` (read) and `pump-fun-trade`
(sign). `wave` and `pump-fun` stand alone. Requirements are declared in each
`manifest.json` under `requires.skills`.

## Related

- Agents that install these skills: [coach-leo](../coach-leo/), [three-concierge](../three-concierge/), [pump-fun-agent](../pump-fun-agent/).
- Production pump.fun skills consumed by the platform: [pump-fun-skills/](../../pump-fun-skills/).
- Skills guide: https://three.ws/docs/skills
