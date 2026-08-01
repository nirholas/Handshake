# The economy solver

The [in-game economy reference](in-game-economy.md) publishes **what** the `/play`
world charges. The solver publishes **what those numbers mean**: the exact expected
cash, XP and goods per hour of every action in the world, at every skill level.

- **Live page:** [three.ws/play/solver](https://three.ws/play/solver)
- **Endpoint:** `GET /api/play/solver`
- **Model:** [`multiplayer/src/rate-model.js`](https://github.com/nirholas/three.ws/blob/main/multiplayer/src/rate-model.js)

---

## Why this is computable at all

Most games make you measure. You grind for an hour, count what you got, and post an
average on a wiki that is stale by the next balance patch.

The `/play` world does not need that, because of how it is built:

- Every yield rule is a **pure function** of your skill level and the node you are
  standing at. `gatherChance`, `gatherDoubleChance`, `coalBonusChance`,
  `cookBurnChance`, `fishCatchChance` and `fishDoubleChance` all live in
  `multiplayer/src/items.js` and take no state beyond their arguments.
- Every swing has a **fixed cadence** the server enforces, in
  `ACTIVITY_COOLDOWN_MS` (`multiplayer/src/activities.js`).
- Every item has **one price**, in `multiplayer/src/shop.js`.

Given those three facts, expected value per hour is arithmetic. There is nothing to
sample and no error bar. The solver does that arithmetic against the same modules
the authoritative server rolls against, so it cannot drift: change a price or a
curve upstream and every rate moves with it on the next request.

---

## What it solves

### Per-node rates

Every tree, rock and pond in the world, priced separately. Nodes differ: a tree's
`difficulty` divides its success chance, a rock also carries a `coal` weight that
raises its bonus-coal odds, and a pond's `quality` multiplies both catch rate and
double-haul odds.

That produces a question the game gives you no way to answer in-world: **is the
harder node worth standing at?** A tougher rock yields less often but drops coal
more readily, and coal is worth three times stone. Only the arithmetic settles it.

The solver settles it, and publishes the answer as a finding.

### The fish-and-cook split

Cooked fish sells for three times raw fish. But cooking consumes a raw fish per
attempt and you cannot fish and cook at the same time, so the real question is how
to divide an hour between them.

Let `R` be fish caught per hour of pure fishing and `C` cooking attempts per hour.
Spending fraction `t` of the hour fishing produces `t·R` fish and consumes
`(1 − t)·C`. Supply meets demand at:

```
t = C / (R + C)
```

At that split nothing queues and nothing idles, and it is the only split where that
is true. Everything else follows: cooked fish per hour, cash per hour, and the
uplift over simply selling raw.

### Payback in playtime

Every store entry priced against the best rate you can actually hold, in minutes
and in swings. Bundles report their per-unit price, because a sticker price on a
stack of twelve is not comparable to one on a single item.

### The wheel, in store prices

Valuing each wedge at what the general store would pay for it turns Fortune's Folly
from a mystery into a number: expected value, standard deviation, and the share of
outcomes that land at or above the mean. On a table with one jackpot wedge, the
average outcome is not the typical one, and the solver says so.

### Combat, per kill

Priced per kill rather than per hour, deliberately. Kill speed depends on your
weapon, your aim and how fast the world respawns, none of which is a constant the
model can honestly assume. So it publishes expected cash per kill (flat gold plus
every loot line at store prices) and lets you supply your own kill rate.

Loot rolls are independent, so the expectations simply add. Mounts have no sell
price and never inflate a cash figure, but their odds are reported.

---

## Two things the model refuses to do

**It never ranks a rate you cannot hold.** Cooking's standalone ceiling is the
largest number in the table, and it is unreachable: it needs thousands of raw fish
an hour delivered by someone who is not you. Every row carries a `sustainable` flag,
unsustainable rows always sort last regardless of size, and payback is never quoted
against one. Ranking a number nobody can hold above one anybody can would make the
whole table advice you cannot follow.

**It never hides its assumptions.** Every response ships the list, because a rate
quoted without its assumptions is a lie:

1. Uninterrupted action, with no walking, travel or downtime.
2. Pack space is available. Every row also reports the exact hour an empty pack
   fills at its rate, so you can see where that assumption breaks.
3. Items are valued at the store sell price. The world has no player market.
4. Skill level is held fixed for the hour, so a sustained session slightly beats the
   number shown for its starting level.
5. Mount drops are reported as odds only.

---

## Exactness

The game's XP award wraps `Math.round` around a uniform integer roll:

```js
const xp = Math.round((9 + Math.floor(Math.random() * 5) + lvl * 0.3) * difficulty) * got;
```

Rounding is not linear, so `E[round(X)] ≠ round(E[X])`. Substituting the mean of the
roll gives an answer that is close and wrong. The model sums over the roll's real
support instead:

```js
function expectedRoundedXp(base, span, level, mult) {
	let total = 0;
	for (let k = 0; k < span; k += 1) total += Math.round((base + k + level * 0.3) * mult);
	return total / span;
}
```

The spans are 5 and 6, so the exact sum costs the same as the shortcut would have.

That claim is pinned by test, not by assertion.
[`tests/rate-model.test.js`](https://github.com/nirholas/three.ws/blob/main/tests/rate-model.test.js)
drives the **real production handlers** (`handleGather`, `handleCook` from
`activities.js`) against a seeded PRNG for 40,000 swings and checks the observed
mean lands inside the sampling interval around the closed form. The simulation is an
independent second implementation: the analytic path reads the probability curves,
the empirical path runs the actual game code, and the two have to meet. Change a
handler without changing the model, or a curve without changing the handler, and it
goes red.

---

## Using the endpoint

```bash
curl -s 'https://three.ws/api/play/solver?level=30&curves=0' | jq '.bestRate, .loop'
```

```json
{
  "label": "Fish pond-west and cook",
  "key": "loop:fish-cook",
  "cashPerHour": 12723.19,
  "attemptsPerHour": 2400
}
{
  "key": "loop:fish-cook",
  "family": "loop",
  "label": "Fish pond-west and cook",
  "fishSharePct": 68.83,
  "cookSharePct": 31.17,
  "cookedPerHour": 1413.69,
  "cashPerHour": 12723.19,
  "rawOnlyCashPerHour": 6825.6,
  "upliftPct": 86.4,
  "sustainable": true
}
```

### Query parameters

| Parameter | Default | Meaning |
| --- | --- | --- |
| `level` | `1` | Skill level to solve at, 1 to 99. Out-of-range values are clamped rather than rejected, and the response sets `levelClamped: true` so you can tell. |
| `curves` | on | Set `curves=0` to drop the 99-level sweep. The sweep is about 20 KB and exists so a client can move a level control without a round trip. |

### Response shape

| Field | What it holds |
| --- | --- |
| `level`, `levelCap` | The solved level, and the game's cap. |
| `activities[]` | Every node in the world at this level: hit rate, units, coal, cash and XP per hour, plus `sustainable`, `requires` and `packHours`. |
| `best` | The top row per family, keyed by `chop`, `mine`, `fish`, `cook`. |
| `bestRate`, `bestXpRate` | The highest cash and XP rates a player can actually hold. Reported separately because they are rarely the same activity. |
| `loop` | The fish-and-cook split, its cash rate, and the uplift over selling raw. |
| `findings[]` | Conclusions derived from the numbers above. Each has `id`, `kind` (`trap`, `reward` or `context`), `title` and `detail`. |
| `payback[]` | Every store entry in minutes and swings at `bestRate`. |
| `wheel` | Expected value, standard deviation, best and worst wedge, and the free lane's daily worth. |
| `combat[]` | Per-kill XP, gold, loot value and mount odds for every mob, with its drop table. |
| `nextLevel` | XP, hours and minutes to the next level at the best XP rate. `null` at the cap. |
| `curves[]` | Per-node `cash` and `xp` arrays of length 99, one entry per level. |
| `assumptions[]`, `method` | The model's own caveats and its audit trail of source modules. |

Cached `public, max-age=300, s-maxage=3600, stale-while-revalidate=86400`. The body
is static config that only changes when the game's tables change, which ships as a
deploy.

---

## Where the code lives

| Piece | File |
| --- | --- |
| The model | `multiplayer/src/rate-model.js` |
| The endpoint | `api/play/solver.js` |
| The page | `pages/play/solver.html`, `src/play-solver.js`, `src/play-solver.css` |
| Model tests, including the simulation cross-check | `tests/rate-model.test.js` |
| Endpoint contract tests | `tests/api/play-solver.test.js` |
| Yield curves the model reads | `multiplayer/src/items.js` |
| Cadences the model divides by | `multiplayer/src/activities.js` |
| Prices the model values yields at | `multiplayer/src/shop.js` |
| Per-node tuning | `multiplayer/src/world-features.js` |

## Next

- **[The in-game economy](in-game-economy.md)** is the raw reference: every catalog,
  gate, settlement path and the JSON wire format.
- **[Earn and spend in /play](tutorials/earn-and-spend-in-play.md)** walks the loop
  by hand, in the world.
- **[three.ws/play/solver](https://three.ws/play/solver)** is the interactive version
  of everything above.
