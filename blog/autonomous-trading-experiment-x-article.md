# X Article: the 90-trade autonomous fleet postmortem

Ready-to-publish X Article for **@trythreews**. Built specifically for the X Articles editor (long-form, up to 100,000 characters, rich text). It uses only what X Articles render natively: a title, a cover image, headings, bold/italic, bulleted and numbered lists, block quotes, inline links, and uploaded images. No tables and no code blocks (X Articles render neither cleanly), so every table from the blog has been redrawn as an image or rewritten as text.

> **How to publish this**
> 1. On X, open the composer and choose **Write Article** (requires an eligible Premium+ subscription).
> 2. **Title field:** paste the title below.
> 3. **Cover image:** upload `00-cover.png` (clean dark, green/red only).
> 4. Paste the article body. X's editor keeps `##` / `###` as headings, `**bold**`, lists, and block quotes.
> 5. At each `[IMAGE: file]` marker, click the image button, upload the named file from `blog/x-article-assets/`, paste the caption beneath it, then delete the marker line.
> 6. The ten images are the only manual uploads. Everything else pastes as-is.

Images in `blog/x-article-assets/` (10 total):
`00-cover.png` (cover) · `01-hero.png` · `02-finding.png` · `03-leaderboard.png` · `04-conviction.png` · `05-funnel.png` · `06-paperhands.png` · `07-config.png` · `08-exits.png` · `09-waterfall.png`

---

## TITLE (paste into the X Article title field)

**We gave 11 AI agents real wallets and let them trade for three days. Here are all 90 trades, including the losses.**

## COVER IMAGE

`[IMAGE: 00-cover.png]` upload as the article cover.

---

# ARTICLE BODY (paste everything below this line)

We gave a fleet of AI trading agents their own Solana wallets and real SOL, pointed them at the pump.fun launch firehose, and stopped touching the keyboard.

Three days later, 90 real trades had closed on mainnet. We published every single one, individually graded, with the on-chain receipts. This is the full postmortem: what we built, the exact configuration of every agent, what it did, what it cost us, which agents won, what the 83,000 coins we did *not* buy taught us, and what the losses bought.

The whole record, with the charts, all 90 graded trades, an interactive backtester, and the raw dataset as JSON, lives here: **[three.ws/blog/autonomous-trading-experiment](https://three.ws/blog/autonomous-trading-experiment)**.

> The one-line finding: **win rate is a vanity metric.** The agents that were right *less* often made money, and the agents that were right *more* often lost three times as much. Below is exactly how that happened, in full detail, and what it means for autonomous agents that hold money.

---

## The setup: an A/B fleet with one variable

This is not one bot. It is a controlled A/B test.

Every agent runs the **same execution stack, the same safety firewall, and the same exit ladder**. The only thing that changes between arms is *how an entry gets chosen*. That isolation is the whole point: when one arm outperforms, we know it was the judgment, not the plumbing.

Three families of judgment were in the field:

- **Rules arms.** Frozen, human-tuned filters: market-cap bands, a socials requirement, creator-history checks, position sizing. No learning inside the window. This is the classic "sniper config."
- **Oracle arms.** Entries gated on a conviction model trained on the outcomes of past launches. A coin has to score above a threshold to be bought.
- **LLM arms.** No rulebook at all. Every launch is put in front of a language model that returns a structured verdict: buy or not, a confidence score, and a one-sentence thesis in the model's own words. The thesis is written to a hash-chained ledger right next to the trade.

**Position sizes were deliberately tiny**, from 0.002 to 0.15 SOL per trade. This phase was built to buy information, not profit. Every fill is real money on Solana mainnet with a public transaction signature. Nothing here is paper-traded or simulated after the fact.

**The window:** 20 to 23 July 2026. Source of truth: the three.ws agent-sniper production ledger, real fills only.

---

## The exact A/B design

Here is every arm and every knob. Same firewall, same 30-minute default max hold, same stop discipline. What differs is size, the take-profit and trailing targets, the max hold, and the conviction gate.

`[IMAGE: 07-config.png]`
*Caption: The complete A/B matrix. Eight strategies, eight wallets. "Gate" is the minimum conviction score required to enter; "off" means the arm did not use that mechanism.*

In words:

- **llm-grok** (LLM): 0.01 SOL, take-profit 45%, stop 30%, trail 20%, 30m hold, no gate.
- **llm-auto** (LLM): 0.01 SOL, take-profit 60%, stop 30%, trail 20%, 30m hold, no gate.
- **llm-claude** (LLM): 0.01 SOL, take-profit 60%, stop 30%, trail 20%, 30m hold, no gate.
- **oracle-open** (oracle): 0.008 SOL, no take-profit, stop 30%, no trail, 30m hold, **gate 35**.
- **rules-classic** (rules): 0.002 SOL, take-profit 60%, stop 30%, trail 20%, 30m hold, **gate 55**.
- **rules-proven** (rules): 0.05 SOL, no take-profit, stop 30%, trail 25%, 30m hold, no gate.
- **boost-ride** (rules): 0.01 SOL, take-profit 20%, stop 15%, trail 8%, **4m hold**, no gate.
- **intel-quality** (rules): 0.15 SOL, take-profit 200%, stop 35%, trail 30%, 30m hold, **gate 55**.

Two design choices matter for what follows. **boost-ride** is a fast scalper: tiny targets, a tight 8% trailing stop, and a 4-minute clock. **intel-quality** is the opposite: the biggest size in the fleet (0.15 SOL) chasing a 200% moonshot that has to actually 3x to trigger. Hold those two in mind.

### The safety layer everyone shared

Before any buy, a **trade firewall simulates the sell**. It checks that the position can actually be exited (liquidity, price impact, honeypot behavior) and returns a verdict. Across the 90 trades, the firewall marked **65 as clean allow** and **25 as warn**. That flag carried signal: allow-verdict entries won **34%** of the time, warn-verdict entries only **12%** (both cohorts still finished slightly negative, because entry judgment, not the firewall, was the real bottleneck). Fleet-wide safety bands sit above every arm and fail closed: a coin whose market cap cannot be determined is rejected, never bought blind. Category exclusions are read from the on-chain bonding-curve account, not the feed.

---

## The headline numbers

Here is the honest scorecard, before any spin:

- **90 closed trades**, across **8 strategies** in **8 wallets**.
- **25 wins, 65 losses.** Best single trade +73.9%, worst -99.9%.
- **Fleet net: about -0.103 SOL** on 1.93 SOL deployed. We paid tuition.
- **LLM-judged cohort: 33 trades, net about +0.015 SOL.**
- **Rules cohort: 57 trades, net about -0.118 SOL.**
- **6 of the 7 biggest wins belong to the LLM arms.**

`[IMAGE: 01-hero.png]`
*Caption: The fleet at a glance. 82,994 launches watched, 90 trades closed, 1.93 SOL deployed. The fleet finished down 0.103 SOL; the LLM-judged cohort finished up.*

The fleet as a whole lost money. That is the true number and we are leading with it. But the *distribution* of who lost it, and who did not, is the entire lesson.

---

## The core finding: win rate is a vanity metric

Look at the two cohorts side by side.

- The **LLM cohort** won only **24%** of its trades. Its average win was **+52.3%**; its average loss was just **-10.8%**. Net: **positive.**
- The **rules cohort** won **30%** of its trades, a *higher* strike rate. But its average win was only **+16.2%** and its average loss was **-23.7%**. Net: **three times the loss that the LLM cohort made in profit.**

`[IMAGE: 02-finding.png]`
*Caption: The rules cohort is right more often and still loses. Win rate measures how often you are right. It says nothing about how much you make when you are right or lose when you are wrong.*

The rules arms buy everything mediocre enough to clear a threshold: the ticker trying a little too hard, the week-old narrative, the chart that stairsteps on four wallets. They clip a lot of small wins and eat a few catastrophic losses.

The model does something a threshold filter cannot: it **declines**. Its edge is **not prediction, it is selection**. Fewer entries, a fatter right tail, shallower losses. It says no to launches that a market-cap band has no vocabulary to reject.

> **33 trades is a signal, not a proof.** We are not claiming an LLM has cracked the memecoin market on a three-day, 33-trade sample. We are claiming the *shape* of the result is real and worth scaling. We are widening the sample and we will publish it whether it confirms this or breaks it.

---

## The leaderboard: which agents actually performed best

Eight arms, ranked by net SOL. Only two finished green, and both are LLM-judged.

`[IMAGE: 03-leaderboard.png]`
*Caption: Net SOL by strategy. The two LLM arms are the only green bars. The arm with the best win rate in the whole fleet (boost-ride, 48%) posted the single worst loss.*

Arm by arm, best to worst:

1. **llm-grok**: **+0.019 SOL**, 9 trades, 44% win. The top performer. Tight, selective, and it took its profits. Average win +53.6%, average loss just -4.9%.
2. **llm-auto**: **+0.006 SOL**, 15 trades, 20% win. The other green arm. Won only one trade in five, but its wins were huge (average +64.5%), including the fleet's best single trade at +73.9%.
3. **rules-classic**: **-0.0006 SOL**, 1 trade. Barely traded, barely moved.
4. **llm-claude**: **-0.011 SOL**, 9 trades, 11% win. An LLM arm that landed in the red: proof the "LLM" label is not magic on its own. Its 60% take-profit target was slower to trigger and it caught fewer clean exits in this window.
5. **oracle-open**: **-0.017 SOL**, 14 trades, 7% win. Its conviction gate was set too low (35), which admitted a mediocre band. More on that below.
6. **rules-proven**: **-0.018 SOL**, 5 trades. This is the arm that made the platform's **first fully autonomous trade** (+42.38%, documented at [three.ws/blog/first-autonomous-trade](https://three.ws/blog/first-autonomous-trade)). Over five trades it gave most of that back. One good trade is not a strategy.
7. **boost-ride**: **-0.041 SOL**, 31 trades, **48% win**. The busiest arm and the one that was right most often. It also lost the most. A fast scalper with a 4-minute max hold, it clipped many small wins and got caught in a few launches whose liquidity evaporated in seconds. This one bar is the entire "win rate is a vanity metric" thesis in a single row.
8. **intel-quality**: **-0.041 SOL**, 6 trades, 0% win. The largest position sizing in the fleet (0.15 SOL) with a 200% take-profit target that never triggered. Big size plus a moonshot target plus no wins is the worst combination on the board.

**What separated the winners:** every green arm took profit on a real target and kept its losses shallow. The take-profit exit, not entry genius, is where the money actually showed up.

---

## All 90 trades, best to worst

Here is every closed position on the ledger, ranked by return. The distribution is the story: a handful of fat green wins on the left, a long shallow band of managed losses through the middle, and a short cliff of catastrophic losses on the right.

`[IMAGE: 09-waterfall.png]`
*Caption: All 90 trades ranked by return, from +73.9% to -99.9%. 25 winners, 65 losers. The profit lives in the far-left tail; the damage lives in the far-right cliff.*

**Hold times:** the median position was held about **4 minutes**; the shortest was **5 seconds**, the longest **4.4 days**. Winners exited fast (most take-profits fired inside 90 seconds to 3 minutes). The catastrophic losses fired even faster.

### Every winning trade (all 25)

The top of the tape was almost entirely LLM-judged, and almost entirely clean take-profit exits:

- +73.9% $House, llm-auto, take-profit, 68s
- +71.3% $DEPE, llm-grok, take-profit, 2m
- +65.6% $DUCK, llm-grok, take-profit, 72s
- +63.1% $BLACKHOLE, llm-grok, take-profit, 2m
- +60.8% $WhiteBull, llm-auto, take-profit, 3m
- +58.8% $掌握, llm-auto, take-profit, 84s
- +42.9% $HANU.p, boost-ride, take-profit, 5m
- +42.4% $BITS, rules-proven, timeout, 30m
- +20.9% boost-ride, take-profit, 3m
- +20.4% boost-ride, take-profit, 3m
- +20.4% $BDAG, boost-ride, take-profit, 2m
- +20.2% boost-ride, take-profit, 4m
- +20.0% $FLL, boost-ride, take-profit, 3m
- +18.7% $VFX, boost-ride, take-profit, 3m
- +14.2% $COOK, llm-grok, timeout, 30m
- +12.0% boost-ride, timeout, 4m
- +11.7% boost-ride, timeout, 4m
- +11.3% boost-ride, timeout, 4m
- +10.6% $MCP, llm-claude, trailing-stop, 61s
- +10.4% $TrippleBBL, oracle-open, timeout, 30m
- +7.7% boost-ride, timeout, 4m
- +5.2% boost-ride, timeout, 4m
- +5.0% boost-ride, timeout, 4m
- +4.7% boost-ride, timeout, 4m
- +2.0% $Aevon, boost-ride, timeout, 4m

Six of the seven best trades were LLM calls, every one exited on a take-profit between +45% and +74%. The model logged a one-sentence thesis for each before the outcome existed (all 29 are reproduced verbatim in "The reasoning ledger" below). The model was not predicting the future. It was refusing the obvious traps and letting the exit ladder do the rest.

### Every losing trade (all 65, ranked)

The other 65, least-bad to worst, with the peak each one reached before it closed. Read the bottom of this list against the hold times: the worst boost-ride wipeouts realized -84% to -99.9% in **six to nine seconds**. The stop-loss fired on time; there was simply no one left to sell to. Note also the long clot of -2.5% timeouts in the middle: dozens of positions that never moved and were closed flat by the 30-minute backstop.

- -2.3% $Walter, boost-ride, trailing-stop, 15s
- -2.5% $WET, intel-quality, timeout, 30m
- -2.5% $YES YOU, intel-quality, timeout, 30m
- -2.5% $SADCAT, intel-quality, timeout, 30m
- -2.5% $$DELU, oracle-open, timeout, 30m (peaked +4.2% first)
- -2.5% $test, oracle-open, timeout, 30m
- -2.5% $$RUGHUNTER, llm-auto, timeout, 30m
- -2.5% $JARRETT, oracle-open, timeout, 30m
- -2.5% $Diamond, llm-claude, timeout, 30m
- -2.5% $RCC, llm-auto, timeout, 30m
- -2.5% $Free, oracle-open, timeout, 30m
- -2.5% $SAVIOUR, llm-auto, timeout, 30m
- -2.5% $Jrool, oracle-open, timeout, 30m
- -2.5% $MrSue, oracle-open, timeout, 30m
- -2.5% $MELON, oracle-open, timeout, 30m
- -2.6% $REC, llm-grok, timeout, 30m
- -2.7% $CQUACK, llm-claude, timeout, 30m
- -2.7% $Pink, llm-claude, timeout, 30m
- -2.7% $ROGERS, llm-claude, timeout, 30m
- -2.8% $Pink, llm-auto, timeout, 30m
- -2.8% $Pink, llm-grok, timeout, 30m
- -3.0% $HOME, llm-claude, timeout, 30m
- -3.1% $HOME, llm-auto, timeout, 30m
- -3.7% $birry, llm-claude, timeout, 30m
- -4.1% $Moon, llm-auto, timeout, 30m
- -4.1% $doge, llm-grok, timeout, 30m
- -4.4% $GABRIEL, llm-auto, timeout, 30m
- -4.5% $ANSEM, oracle-open, timeout, 30m
- -4.7% $boss, llm-auto, timeout, 30m
- -5.0% $KYDEN, intel-quality, timeout, 30m
- -5.6% $ROGERS, llm-grok, timeout, 30m
- -6.4% (unnamed), boost-ride, trailing-stop, 2m (peaked +1.9% first)
- -7.1% $Smoke, intel-quality, timeout, 30m
- -7.4% $PJT, oracle-open, timeout, 30m
- -8.0% $Enthuist, intel-quality, timeout, 37.5h
- -8.7% (unnamed), boost-ride, trailing-stop, 19s
- -9.2% $APE, llm-grok, timeout, 30m
- -13.4% $Clouseau, rules-proven, trailing-stop, 2m (peaked +24.8% first)
- -14.3% $Meowpin, rules-proven, trailing-stop, 29s (peaked +28.3% first)
- -15.8% (unnamed), boost-ride, stop-loss, 5s
- -17.4% (unnamed), boost-ride, stop-loss, 7s
- -17.6% $tutu, llm-auto, trailing-stop, 2m (peaked +18.4% first)
- -18.7% $FLIPPENING, oracle-open, timeout, 30m
- -20.1% (unnamed), boost-ride, stop-loss, 8s
- -21.7% $one, llm-claude, trailing-stop, 2m (peaked +1.2% first)
- -21.7% $one, llm-auto, trailing-stop, 2m (peaked +1.2% first)
- -22.0% (unnamed), boost-ride, stop-loss, 18s
- -25.3% $AG, rules-proven, timeout, 32m
- -26.1% $looong, rules-proven, trailing-stop, 46s
- -26.4% $COREY, llm-auto, trailing-stop, 22s
- -28.1% $Dronenald, rules-classic, trailing-stop, 104.9h
- -30.1% $$MRH, boost-ride, stop-loss, 4m (peaked +10.1% first)
- -32.5% $SKE, oracle-open, stop-loss, 29s
- -32.8% $CWARDIN, boost-ride, stop-loss, 3m (peaked +16.8% first)
- -34.3% $BENNER, boost-ride, stop-loss, 3m (peaked +15.9% first)
- -34.4% $AGIGUY, boost-ride, stop-loss, 3m (peaked +15.9% first)
- -35.6% $RWA, boost-ride, stop-loss, 2m (peaked +10.6% first)
- -37.4% $Elon, llm-auto, stop-loss, 23s
- -38.9% $Poze, oracle-open, stop-loss, 63s (peaked +19.3% first)
- -57.4% $Jimothy, oracle-open, stop-loss, 15s
- -78.3% $RACOIN, llm-claude, stop-loss, 2m (peaked +55.0% first)
- -84.3% (unnamed), boost-ride, stop-loss, 6s
- -93.2% (unnamed), boost-ride, stop-loss, 9s
- -98.7% (unnamed), boost-ride, stop-loss, 8s
- -99.9% (unnamed), boost-ride, stop-loss, 3m (peaked +4.6% first)

### The drawdown story: 15 winners that gave it back

Fifteen positions were green at their peak and still closed red, costing the fleet about **0.059 SOL**. The tape is brutal about round-trips:

- $RACOIN peaked **+55.0%**, closed **-78.3%** (a stop that fired into no liquidity).
- $Meowpin peaked **+28.3%**, closed **-14.3%**.
- $Clouseau peaked **+24.8%**, closed **-13.4%**.
- $Poze peaked **+19.3%**, closed **-38.9%**.
- $CWARDIN peaked **+16.8%**, closed **-32.8%**.

This is the exact failure the winners avoided. The green arms did not predict tops; they had a take-profit target and hit it. **$MCP** is the counter-example that proves the point: it peaked +38.6%, and a trailing stop still banked it at **+10.6%** instead of letting it round-trip to zero. The exit ladder, not the entry, decided who kept their gains. (Every clickable on-chain receipt for all 90 is in the [full write-up](https://three.ws/blog/autonomous-trading-experiment).)

---

## The complete exit ledger

Break the 90 trades down by *how they closed*, and the mechanical lesson is unmistakable.

`[IMAGE: 08-exits.png]`
*Caption: Net SOL by exit type. Take-profit is the only category in the black. Stop-loss did the most damage. Everything that is not a take-profit is damage control.*

- **take_profit:** 13 exits, **100% win**, avg +42.8%, net **+0.056 SOL**. The only profitable category in the entire dataset.
- **timeout** (the max-hold backstop): 47 exits, 23% win, avg -0.9%, net **-0.036 SOL**. Roughly breakeven per trade, and by far the most common outcome. Most positions simply ran out the clock near flat.
- **trailing_stop:** 12 exits, 8% win, avg -14.7%, net **-0.037 SOL**. Trailing stops armed below breakeven are a machine for realizing small losses. They only earned their keep on positions already green.
- **stop_loss:** 18 exits, **0% win**, avg -48.0%, net **-0.086 SOL**. The single biggest bleeder, and the proof that a stop is a request, not a guarantee.

### The same story, by entry trigger

Sort by how the trade was *triggered* and the LLM edge shows up again:

- **llm_intel** (LLM-judged entries): 29 trades, 24% win, net **+0.009 SOL.** The only positive trigger.
- **intel_confirmed:** 10 trades, 10% win, net -0.035 SOL.
- **new_mint** (blind minute-zero snipes): 20 trades, 10% win, net -0.036 SOL.
- **graduation_ride** (boost-ride): 31 trades, 48% win, net -0.041 SOL.

---

## The reasoning ledger: every LLM thesis, verbatim

The LLM arms did not just trade. They wrote down *why*, one sentence per decision, to a hash-chained ledger, before the outcome existed. Here are all 29, ranked by how the trade turned out. Read top to bottom: the wins lean on "real two-sided market" and buyer-distribution language; the losses lean on "memetic name" and "narrative." The model's own vocabulary sorts its winners from its losers.

- **+71.3% $DEPE** (llm-grok, confidence 0.8): *"Strong real-market signal with multiple buyers and substantial wallet holding"*
- **+65.6% $DUCK** (llm-grok, confidence 0.7): *"DUCK has a decent market_realness score and a relatively balanced buyer-seller ratio."*
- **+63.1% $BLACKHOLE** (llm-grok, confidence 0.8): *"Genuine two-sided market indicated by high market_realness score."*
- **+60.8% $WhiteBull** (llm-auto, confidence 0.7): *"Moderately real market with diverse buyers warrants a small momentum position."*
- **+58.8% $掌握** (llm-auto, confidence 0.7): *"Genuine two-sided market and moderate market realness score justify a small momentum position."*
- **+14.2% $COOK** (llm-grok, confidence 0.8): *"Strong memetic potential with a catchy name and timely narrative."*
- **+10.6% $MCP** (llm-claude, confidence 0.8): *"MCP Genesis has a reasonably high market_realness score indicating genuine two-sided market activity."*
- **-2.5% $$RUGHUNTER** (llm-auto, confidence 0.8): *"Strong memetic name and timely narrative suggest potential for real momentum."*
- **-2.5% $Diamond** (llm-claude, confidence 0.8): *"Strong memetic name and ticker align with current market sentiment."*
- **-2.5% $RCC** (llm-auto, confidence 0.8): *"Memetic token name and low market cap may attract speculative buyers."*
- **-2.5% $SAVIOUR** (llm-auto, confidence 0.7): *"SAVIOR may have organic demand due to a compelling narrative and the creator's launch history"*
- **-2.6% $REC** (llm-grok, confidence 0.7): *"REC exhibits strong market_realness signals and timely narrative"*
- **-2.7% $CQUACK** (llm-claude, confidence 0.7): *"CQUACK's memetic name and symbol may attract initial speculative interest."*
- **-2.7% $Pink** (llm-claude, confidence 0.8): *"Pink grasshopper has a relatively real market with diverse buyers and sellers."*
- **-2.8% $Pink** (llm-auto, confidence 0.8): *"Pink grasshopper has a relatively real market with diverse buyers and sellers."*
- **-2.8% $Pink** (llm-grok, confidence 0.8): *"Pink grasshopper has a relatively high market realness score indicating genuine two-sided market demand."*
- **-3.0% $HOME** (llm-claude, confidence 0.7): *"Strong memetic quality and timely narrative align with market sentiment."*
- **-3.1% $HOME** (llm-auto, confidence 0.7): *"HOME token has strong memetic quality and a plausible narrative."*
- **-3.7% $birry** (llm-claude, confidence 0.7): *"Strong momentum with genuine market demand"*
- **-4.1% $Moon** (llm-auto, confidence 0.8): *"Memetic quality of 'TO THE MOON' is high and could attract significant attention"*
- **-4.1% $doge** (llm-grok, confidence 0.8): *"Strong memetic potential from 'swole' and 'doge' combination"*
- **-4.7% $boss** (llm-auto, confidence 0.8): *"Strong market realness and diverse buyer base justify a momentum position."*
- **-9.2% $APE** (llm-grok, confidence 0.8): *"A moderate momentum position in APE is worth taking due to a decent two-sided market and a sizable dev buy."*
- **-17.6% $tutu** (llm-auto, confidence 0.7): *"Moderately genuine market_realness and decent buyer distribution justify a momentum position."*
- **-21.7% $one** (llm-claude, confidence 0.7): *"Moderately strong market realness and balanced buyer/seller ratio justify a momentum position."*
- **-21.7% $one** (llm-auto, confidence 0.7): *"Genuine two-sided market and moderate market realness justify a small momentum position."*
- **-26.4% $COREY** (llm-auto, confidence 0.7): *"Genuine two-sided market and moderate market realness score indicate potential for real momentum."*
- **-37.4% $Elon** (llm-auto, confidence 0.7): *"Strong memetic quality and decent market realness justify a small momentum position."*
- **-78.3% $RACOIN** (llm-claude, confidence 0.8): *"RACOIN has a relatively genuine market with diverse buyers and sellers."*

Two things stand out. First, the biggest LLM loss, $RACOIN at -78.3%, was logged at 0.8 confidence with a clean-sounding thesis ("relatively genuine market with diverse buyers"), then round-tripped from +55% to -78% when its liquidity vanished. High confidence is not high safety on this market. Second, three different arms bought **$Pink** within seconds on nearly identical theses: the arms converge on the same coin, which is exactly the correlated-bet risk the A/B design exists to surface.

---

## What went well

**1. The take-profit is where the money is.** It was the *only* net-positive exit category: +0.056 SOL across 13 exits, every one a win. If there is one mechanical takeaway, it is that a defined profit target you actually hit beats "let it ride" on a market where the median coin dies within the hour.

**2. Selection beat prediction.** The LLM arms proved you can win with a 24% strike rate if your winners are five times the size of your losers. That is a fundamentally different, and more robust, way to trade this market than trying to be right more often.

**3. The firewall did its job.** Every one of the 90 entries passed a simulated sell first. The catastrophic losses were liquidity collapses after entry, not honeypots the firewall missed.

**4. Nobody paperhanded.** We audited every exit against each token's full future price history. The fleet left, as far as the tape is concerned, zero SOL on the table (full audit below).

---

## What went wrong

**1. A stop-loss is a request, not a guarantee.** Eighteen positions closed on a stop, none of them green, averaging -48%. Five realized between -78% and -99.9%, several in **under ten seconds**. The stop fired on time; the bonding curve's liquidity was already gone. **Tail defense happens at entry (holder-concentration screening) and in position sizing, not at the exit.** You cannot stop-loss your way out of a coin that has no bids.

**2. Trailing stops armed below breakeven realize small losses.** Twelve trailing-stop exits, net negative, 8% win rate. Under water, a trailing stop just locks in the damage a hair faster.

**3. The conviction gate and the money band never lined up.** Our own conviction model was right and mostly ignored (its own section, below).

**4. The self-improvement loop was silently dead** (its own section, below).

---

## The 83,000 coins we didn't buy

The trades are only half the record. The more interesting dataset is everything the fleet **declined**.

While it was live, the fleet **observed 82,994 launches in three days**, conviction-scored 45,784 of them, watched 42,995 to a labeled outcome, and bought **72**. That is under **1 in 1,000**.

`[IMAGE: 05-funnel.png]`
*Caption: 82,994 launches watched, 72 bought. On a market that is mostly predatory, selectivity is the product, not a side effect.*

Because roughly 43,000 of the skipped coins eventually earned outcome labels, we can test the conviction model at scale, on coins the fleet never touched. Here is the full breakdown of what happened to each band:

- **Unscored** (18,510 coins): 354 graduated, 1,581 pumped, 15,938 rugged, 637 flat. Good outcome: **10.5%**.
- **Conviction 0 to 30** (20,319 coins): 522 graduated, 1,874 pumped, 17,136 rugged, 787 flat. Good outcome: **11.8%**.
- **Conviction 30 to 50** (4,041 coins): 131 graduated, 571 pumped, 3,276 rugged, 63 flat. Good outcome: **17.4%**.
- **Conviction 50+** (71 labeled coins): 9 graduated, 46 pumped, 16 rugged, 0 flat. Good outcome: **77.5%.** About seven times the base rate.

`[IMAGE: 04-conviction.png]`
*Caption: Share of coins that pumped or graduated, by conviction band, across 42,995 labeled outcomes. The 50+ band hit 77.5%, roughly 7x the ~11% base rate. The signal is real and it is sitting in production.*

Now the gut-punch. **How many of the 110 coins that ever crossed conviction 50 did the fleet buy? Zero.**

The reason is painfully mechanical. One arm's gate was set at conviction 35 (too low, it admitted the mediocre 17% band). The other arm's gate was set at 65. The highest score any coin reached in the entire window was 61. **The two gates bracketed the profitable band and covered none of it.** The strict arm could never mathematically fire. Nobody chose this outcome; a config off by a little quietly excluded the best signal we had.

We checked for hindsight bias, because a 77.5% hit rate that only appears after the fact is worthless. Of the 110 coins, 104 have an archived *first* score, and all 104 were already at 50+ the very first time they were ever scored. **The signal was on the board before the outcomes were known.**

---

## The ones that got away, and the fix

The five biggest coins we skipped, and what they looked like at the moment our systems actually observed them:

- **$USOH**: ran to a **$161M** all-time-high market cap (a 73,975x from where we saw it). At observation: quality 43/100, 3 visible buyers.
- **$DOW**: $134M ATH. At observation: quality 36, conviction 20, 3 buyers.
- **$NTFS**: $76M ATH. Quality 43, conviction 21, 3 buyers.
- **$USWR**: $67M ATH. Quality 43, conviction 21, 3 buyers.
- **$VORF**: $25M ATH. Quality 43, conviction 21, 3 buyers.

At the moment we saw them, every one of these was statistically identical to the roughly 36,000 rugs sitting in the same dataset: a handful of buyers, a mediocre quality score. Their runs started *after* our observation window on them had closed.

That is the structural lesson, and it is not fixable with a better threshold: **a minute-zero sniper is blind to every winner whose story starts at minute thirty.** No entry filter, however good, can see a move that has not begun.

So we measured the alternative: a **second look**. If you bought each of the 102 measurable conviction-50 crossings at the close of the candle where they crossed:

- the crossing lands a median of **2 minutes after launch** (still sniper speed, not lagging),
- median capturable upside was **1.23x**; **35% reached 1.5x**, **19% reached 2x**, best **9.6x**,
- **zero** coins had already topped before they crossed,
- but the median crossing coin eventually decays to **0.32x**, so the profit only exists for a strategy that actually *takes* it.

We built that strategy. The sniper now has an **`oracle_crossing` trigger**: a watcher buys a coin the first time it crosses the conviction bar, sells the initial stake into a 1.5x ladder, and keeps a protected moonbag. The formerly-unreachable strict arm is re-armed on it at conviction 50. Its trades will publish exactly like every other trade in this post.

---

## The paperhands audit: did we sell too early?

The obvious criticism of any take-profit strategy is that you clip your winners and miss the moonshots. So we tested it against reality, hard. We checked **every one of the 90 exits** against each token's **full post-exit candle history**.

`[IMAGE: 06-paperhands.png]`
*Caption: Every exit checked against the token's entire future. 0 of 90 tokens trade above our exit today. 0 of 90 ever printed 1.5x our exit afterward. 37 never traded again at all. Total SOL lost to selling early: zero.*

The findings:

- **Where does each coin trade now, versus where we sold?** 0 of 90 are above our exit price. Best case 0.90x, median 0.36x. 37 of 90 are down more than 90% since we left.
- **What was the highest price each token *ever* printed after our exit?** 37 of 90 tokens **never traded again at all** (we were literally the last one out). Of the 53 that kept trading, the median post-exit high was 0.43x our exit, and **not one reached 1.5x.**
- The single closest call in the entire dataset: a trailing stop shook one arm out at +10.6%, and the token later poked 1.38x higher, worth about 0.004 SOL of "regret."

**Total SOL lost to selling too early, across the entire experiment: zero.** The fleet has no paperhands problem. Every sell was vindicated by the tape. The money was lost at entry, and the fix lives on the buy side.

---

## Calibration: the system's confidence carried real signal

Every decision is logged with a self-rated confidence. Sorted by that number, the ordering holds up:

- The **65 higher-confidence decisions** (logged near 0.7) were right about **34%** of the time.
- The **25 lower-confidence decisions** (logged near 0.4) were right about **12%** of the time.

The absolute hit rates are humbling on a market this adversarial. But the *ordering* is the prize: higher confidence really did mean higher hit rate. The LLM arms show the same monotonicity in their own confidence scores (roughly 21% win at 0.7 confidence, 27% at 0.8). That means the signal can be calibrated and sized against, which is the whole point of logging it.

---

## The embarrassing part: green dashboards, zero learning

The fleet is supposed to be self-improving. An optimizer reads each arm's real record every 6 hours and tunes its knobs inside hard safety bounds. After two days of "running," we audited it.

**It had never applied a single change.**

The database driver accepts a dynamic column name in a WHERE position but not in a SET position. The update meant to write each tuned knob threw a syntax error at runtime, every time. That throw was swallowed by an error handler, the audit-log insert was skipped along with it, and the cron kept returning HTTP 200 every 6 hours. Green dashboards, zero learning.

A second loop, meant to feed realized profit-and-loss back into the conviction model, was deployed in code but its scheduler job was never created. It ran exactly zero times.

Both are fixed now. The rule we wrote down and taped to the wall:

> **An autonomous system's health is measured by rows in its audit tables, not by its HTTP status codes.** "The cron returns 200" and "the loop is learning" are unrelated statements. If your self-improving system cannot show you the diffs it applied, assume it applied none.

---

## Don't trust us. Replay it.

The full write-up ships an **interactive backtester**. It holds the real per-minute price history of 77 of the trades and lets you run *your own* exit rules against the fleet's, on the same coins and the same candles.

Load "let winners run" and the result gets *worse*. Load "tight scalper" and the whole loss flips positive. On a market where the median coin dies within the hour, the single biggest lever in your exit policy is refusing to wait for a moonshot that mostly never comes. Thirty seconds, your own hands, real data: **[three.ws/blog/autonomous-trading-experiment](https://three.ws/blog/autonomous-trading-experiment)**.

---

## What we learned, in five lines

1. **Win rate is a vanity metric.** Optimize expectancy (average win times hit rate, minus average loss), not how often you are right.
2. **Selection beats prediction.** The durable edge is declining bad launches, not forecasting good ones.
3. **Stops do not work without liquidity.** Tail risk is managed at entry and in size, never at the exit.
4. **Take profit on a real target.** It was the only net-positive exit category in the whole dataset.
5. **Measure learning by audit rows, not status codes.** A 200 is not a diff.

---

## What's next

The experiment continues, and it changes in three ways:

- **Budgets now flow toward whatever performs.** Capital is reallocated to the arms that earn it, on the fleet's own measured record.
- **The `oracle_crossing` arm is live.** The second-look strategy that would have caught the winners our minute-zero snipers were structurally blind to is now in the field, publishing its trades the same way.
- **The model roster widens.** More frontier LLMs join the cockpit, head to head at equal budgets under identical rails. **Kimi K3 is first in line.** Same size of risk, same exit ladder, different judgment: exactly the A/B design that produced this postmortem.

The next edition of this dataset will also include the fleet's own self-tunings, now that the optimizer is actually writing them.

---

## Why this matters for three.ws

three.ws is a platform where AI agents own real Solana wallets and can be armed to act autonomously. Autonomous agents that hold money are easy to demo and hard to trust. The demo is a language model with a wallet key. The trust problem is everything else.

This experiment is how we earn that trust in public:

- **Every decision every agent made is on a public, hash-chained ledger.** This entire postmortem was generated from that ledger and the position table. We do not get to tell you a story; the receipts do.
- **We publish the losses.** A fleet that only shows you its wins is marketing. A fleet that shows you a -0.103 SOL result, a dead self-improvement loop, and a config bug that excluded its own best signal, is a system you can actually reason about.
- **The architecture generalizes.** Deterministic entry gates, a firewall that simulates the sell before the buy, an exit ladder, and a tamper-evident reasoning ledger are not memecoin-specific. They are the shape of any agent you would trust with a balance.

That is the product: not a bot that promises you gains, but an agent platform whose every autonomous action is measurable, auditable, and published, win or lose. **$THREE holders are watching the same ledger we are.**

---

## Verify everything

- **Full breakdown, all 90 graded trades, charts, backtester, raw JSON:** [three.ws/blog/autonomous-trading-experiment](https://three.ws/blog/autonomous-trading-experiment)
- **The first autonomous trade, decision by decision:** [three.ws/blog/first-autonomous-trade](https://three.ws/blog/first-autonomous-trade)
- **How the sniper is built (entry gates, the trade firewall, the exit ladder):** [three.ws/docs/agent-sniper](https://three.ws/docs/agent-sniper)

Follow **@trythreews** for the next edition. The crossing arm's trades and the wider model roster (Kimi K3 first) publish the same way this did: win or lose, on the ledger, no cherry-picking.
