# Getting @nichxbt back: the appeal packet

`@nichxbt` (X user ID `2817123964`) was suspended on 2026-08-27. X's email, sent
06:29 that morning, says the account "was reported and has been suspended"
for "violating our rules against authenticity", and warns that creating a new
account is evasion and that an X Premium subscription keeps billing. The
suspension is confirmed independently: X's public user endpoint answers
`"User is suspended"` for the handle.

**Appeal #1 was denied on 2026-09-05.** X reviewed it, said a violation "did
take place", cited the authenticity rules again, and declined to overturn the
lock. That is a decision on the first filing, not the end of the route:
section 3 shows that most documented reinstatements came after several spaced
filings, and several of them came after a denial worded exactly like this one.
The live next step is refiling, per section 6 step 5.

Two things in that denial are worth reading carefully before anyone acts on
it. First, it says **"lock"** where the original said "suspend", and it invites
the owner to "resolve the violations by logging into your account and
completing the on-screen instructions", which is X's standard copy for a
*locked* account that clears itself through a verification flow. Second, that
is not the state the account is actually in: the public probe still answers
`"User is suspended"` for user ID `2817123964` as of 2026-09-06. The
remediation sentence is boilerplate in a template, not an unlock path that
someone has failed to click. Log in and look anyway, because it costs one
minute and it is the only way to see the account-level screen X actually
serves, but do not plan around finding a self-serve fix there.

This file is the whole case in one place: what X's own process is, what the
documented successful appeals had in common, what got other people denied,
the exact text to submit, and the order to do things in. It was assembled on
2026-08-27 from primary sources where they were reachable and from first-hand
accounts where they were not. Every claim carries its source. Where a source
is a marketing blog rather than a first-hand account, it is marked as such.

The status table that the rest of the repo reads is in
[`x-accounts.md`](x-accounts.md). Update that file when this one changes the
facts.

## 1. What this suspension is, and is not

**The category is wrong for the account, and that is the case.** X's
authenticity rules cover impersonation, fake or duplicate accounts, bulk or
automated activity, engagement pods, coordinated campaigns, and purchased
engagement. The email cites that family, and "was reported" says the trigger
was user reports rather than a detection sweep. None of the listed behaviours
describes the account:

| Fact | Evidence on file |
| --- | --- |
| Real person, real company, twelve-year-old account | User ID `2817123964` is in the ID range X issued in late 2014. The oldest post in the archive is 2021-07-03, the newest 2026-05-09 ([`data/archives/nichxbt_tweets_2026-05-10.json`](../data/archives/nichxbt_tweets_2026-05-10.json)). |
| Identity is corroborated by third parties, not just by us | Same person and company named by IBM, AWS, OpenAI, Google Cloud, and Alibaba Cloud partner listings (every one linked from `/community` and the blog), by the public GitHub organisation, and by the live product at three.ws. |
| Manual posting cadence, no volume pattern | 207 own posts across the archive. The busiest month in the last year was February 2026 at 23 posts; most months are under 20. The busiest single day on record is 13 posts, on launch day. |
| No X app, no API posting, from either account | The repository contains X integration code, and none of it was ever put into service. The "connect your X account" OAuth lane answers `501 not_configured` on production (checked 2026-08-28 at `/api/auth/x/connect`), so no user has ever posted through a three.ws app. The changelog-to-X lane was retired on 2026-07-18 and its state file ([`data/changelog-x-state.json`](../data/changelog-x-state.json)) was committed once, in a single sweep, with no tweet IDs and no thread: nothing was ever posted through it. The `nichxbt` archive was a one-time read of the public profile in May, not an API integration. Where that code names an account at all it names `@trythreews`. |
| Not an engagement scheme | The product's "share on X" buttons open the standard `x.com/intent` composer with the user's own text and do not tag `@nichxbt` ([`pages/create-next.html`](../pages/create-next.html), [`api/trade-share.js`](../api/trade-share.js)). Users who connect their own X account post under their own OAuth grant, in their own name. |
| Reach was organic and pre-dates the company | The two most-viewed posts are from 2024 and 2025 (3.0M and 7.9M views) and have nothing to do with three.ws. |

So the appeal is not "please forgive me", it is "the cited rule does not apply,
here is how you can check". That framing matters because the one piece of
quantitative data anyone has published on X appeals found policy-specific
appeals reinstated at roughly 2.5 times the rate of generic ones
([YRS, 198 cases, Jan 2024 to Jun 2026](https://youreputationsolution.com/blog/recover-suspended-twitter-account/);
a reputation-services vendor, so treat the number as indicative).

**What it is not: the March 2026 spam-filter bug.** That wave was a
detection sweep, reverted in bulk within a day (Nikita Bier, 2026-03-13:
"99% of those suspensions were reverted today. For about 12 hours, a new spam
filter had falsely tagged subset of accounts",
[x.com/nikitabier/status/2032279113743155634](https://x.com/nikitabier/status/2032279113743155634)).
This suspension is report-driven and individual. It will not lift on its own,
and nobody should wait for that.

## 2. X's own process, from X's own pages

`help.x.com` refuses automated readers, so every quote below is from Wayback
Machine captures of the live pages taken between June and August 2026, which
agree with each other across captures. Local copies of each captured page are
in the research notes listed at the end.

**The policy page is one page now.** The old platform-manipulation,
ban-evasion, and deceptive-identities pages all redirect into
[help.x.com/en/rules-and-policies/authenticity](https://help.x.com/en/rules-and-policies/authenticity)
(dated "April 2025"). Its headline rule is the sentence the email paraphrases:
"You may not engage in inauthentic activity that undermines the integrity of
X." Everything it lists as a violation is one of: unauthorized automation
("as a user you are ultimately responsible for third-party applications you
may authorize"), fake personas, impersonation, multiple coordinated accounts,
ban evasion, account compromise, content spam (bulk replies, copypasta,
hashtag abuse, link-only posting), engagement spam (buying or trading
engagement, follow churn, engagement pods, indiscriminate following,
mass false reporting), scams, manipulated media, and malicious URLs.

**How X says it enforces this policy, verbatim:** "For severe violations,
accounts will be permanently suspended at first detection. If the offense is
an isolated incident or first offense, we may take a number of actions ranging
from requiring deletion of one or more posts to temporarily locking
account(s). In the case of a violation centering around the use of multiple
accounts, you may be asked to choose one account to keep." And: "If you
believe we made a mistake, you can submit an appeal."

**What X says about mistaken suspensions**, on the suspended-accounts page:
"Most of the accounts we suspend are suspended because they are spammy, or
just plain fake ... Sometimes a real person's account gets suspended by
mistake, and in those cases we'll work with the person to make sure the
account is unsuspended." The appeal text in section 5 deliberately uses that
framing.

**The form**, [help.x.com/en/forms/account-access/appeals](https://help.x.com/en/forms/account-access/appeals),
read from its form definition (captured 2026-07-29):

- Login is required, and the form is explicitly built to accept a logged-in
  *suspended* session (`logInRequired: true`, user role `suspended`). X's
  instruction: "First, log in to the account that is suspended. Then, open a
  new browser tab and file an appeal."
- Three visible fields plus a CAPTCHA. **Username** (must include the `@`
  and must match the logged-in account). **Email** ("This is where we'll
  contact you"; must match the account). **Description of the problem**, with
  the help text "Tell us if you're having a problem accessing your account,
  or why you don't believe you violated the X Rules." There is no phone
  field. The description has a minimum length and no published maximum.
- After submission: "We've received your request. We'll review, and take
  further action if appropriate. In some cases, we may send an email with
  more information." Check spam folders.

**Appeal limits and response time: X publishes neither.** No X page says one
appeal, says you may appeal again, or gives a cooldown or an SLA. The "one
shot" and "every two days" rules circulating online are third-party guidance.
The only X timing statement is on the reporting page: reports "are typically
resolved within a few days ... and may take thirty days." Working assumption:
the first submission is the one a human is most likely to read, so it must be
right, and later submissions are allowed but must not look like spam.

**"Was reported" is not a defined tier.** X uses that framing on the
suspended-accounts page ("We may suspend an account if it has been reported
to us as violating our X Rules ... temporarily or, in some cases,
permanently"). The email does not say "permanently suspended", which is the
wording X's notices page reserves for its "most severe enforcement action".
A "permanent" suspension is still appealable: "Violators can appeal permanent
suspensions if they believe we made an error."

**Evasion is a listed violation of this exact policy**, with wide reach:
"creating new accounts; imitating a suspended account to replace it;
repurposing an already-existing account; and having someone else operate an
account on your behalf" are all prohibited, and "X reserves the right to also
suspend any other account we believe the same account holder or entity may be
operating ... regardless of when the other account was created." That last
clause is why `@trythreews` must stay clean and separate: it is an existing
account the same person operates.

**Premium buys nothing here, and X says so.** From the Premium FAQ: "Premium
subscribers receive dedicated support for subscription-specific issues,
only." "Will subscribers receive preference when receiving account support?
... The X Rules won't apply differently to subscribers." "Policy enforcement
issues and reports by subscribers will continue to be handled by existing
enforcement teams, under the current review process." The `@Premium` DM
channel needs a working account anyway. Subscriptions are "non-refundable
... That includes subscriptions linked to X accounts that have been
suspended," so whether to keep paying is a money decision, not an appeal
decision. Premium Business "Priority Support" exists but its documented scope
is onboarding, affiliates, billing, and impersonation, and X's own forum
reply on 2026-08-14 to a suspended Premium+ user simply pointed back at the
Help Center.

**What the automated answers look like.** The in-app banner is the same in
2023 and 2026: "Your account is suspended. After careful review we
determined your account broke the X Rules. Your account is permanently in
read-only mode ... If you think we got this wrong, you can submit an appeal."
A rejection that arrives within minutes, at any hour, is automated; every
documented human decision took days. One 2026 rejection variant says "you can
resolve the violations by logging into your account and completing the
on-screen instructions" when no such instructions exist; Petryshyn's winning
appeal was the one that answered that email's logic directly.

**A "restored" email is not restoration.** Through mid-2026 X's automated
system has sent "Our automated systems have determined there was no violation
and have restored your account" to accounts that stayed suspended, some at
thirty appeals ([developer forum, 2026-06-16](https://devcommunity.x.com/t/restoration-emails-for-suspended-accounts-inauthentic-behaviors-are-false-accounts-do-not-get-restored-suspension-is-not-lifted-as-email-indicates/268394)).
If that email arrives, log out everywhere, request a password reset, log back
in, and only then decide whether it worked.

**How often appeals succeed, from X's own DSA reports.** For EU users in
April to June 2025, complaints against account suspensions were overturned
at roughly 10 to 16 percent by country (Germany 1,636 of 15,404; France 1,348
of 10,029; Spain 761 of 4,492), with median handling of 2.5 to 7.5 days
([transparency.x.com](https://transparency.x.com/dsa-transparency-report-2025-october.html)).
That is the base rate a generic appeal faces. The whole point of this packet
is to not be a generic appeal.

## 3. What the successful appeals had in common

The closest precedents are report-driven suspensions of real accounts, which
is this case. Then the first-hand appeal write-ups, with the text they used
where they gave it.

**Report-driven suspensions that were reversed:**

| Case | What X said | What got it reversed | Time |
| --- | --- | --- | --- |
| [@itscruxia, 2026-08-06](https://devcommunity.x.com/t/app-still-suspended-after-the-owning-account-was-reinstated-on-appeal-app-id-33278893/274182) | "inauthentic behaviours" "following a user report" | One appeal through the form. | Same day. The nearest match to this case on the record: a user-report authenticity suspension of a real account, reversed on the first filing. |
| [Monad, 2026-04-28](https://www.crowdfundinsider.com/2026/04/276090-social-media-platform-x-suspends-official-account-of-l1-blockchain-project-monad/) (1.2M followers) | generic; co-founder said "system error, no abnormal activity or API misuse" | "Multiple channels have now been used to contact the X platform support team" plus a public "free Monad" push. | About 24 hours. |
| [GMGN and BullX, June 2025](https://www.cryptopolitan.com/x-restores-elizaos-founder-account/) | none; BullX said on Discord it had been "mass reported" | GMGN: "actively appealing the decision, in close communication with X." | Weeks. Same sweep that took Pump.fun and Alon down for a day. |
| [Never Back Down PAC, 2023-08-23](https://www.foxnews.com/politics/x-suspends-desantis-pacs-account-hours-debate.amp) | X afterwards: "our automated systems incorrectly picked it up as spam"; allies alleged coordinated mass reporting | Tagged Musk publicly. | Hours. The one case where X put in writing that a reported account was a false positive. |
| [January 2024 journalist sweep](https://www.nbcnews.com/tech/social-media/x-temporary-ban-journalist-accounts-raises-alarm-rcna133084) | Musk: "We do sweeps for spam/scam accounts and sometimes real accounts get caught up in them" | Appeals returned only a "buggy response"; press and public outcry did it. | Hours. |
| Counter-case: [a writing business, mass-reported, Jan 2025](https://devcommunity.x.com/t/1-5-years-since-business-accounts-permanent-suspension-after-being-mass-reported/268672) | permanent suspension | Appeals auto-denied in minutes for 18 months; DMs to X accounts returned canned links. | Never. Small account, no audience, no press. This is what the form path looks like with nothing behind it. |

The split is stark: reported accounts with an audience or a company behind
them come back in hours to weeks; a reported account with neither can sit
for years. `@nichxbt` is in the first group, and the appeal should make that
obvious in its first two sentences.

**First-hand appeal write-ups:**

| Case | Policy cited | What they did | Result |
| --- | --- | --- | --- |
| [Tony Gasparro, April 2026](https://tonygasparro.com/blog/x-account-suspended-inauthentic-behavior/) | "inauthentic behaviors", read-only | Day 0 appeal auto-denied. Days 1 to 2: completed government-ID plus selfie verification through Persona when X offered it at login. Then re-appealed every 3 to 5 days, each one "calm, clear, slightly reworded", stating: manual activity, no automation, Premium+ subscriber, ID verified, willing to remove anything flagged. | Restored day 13, silently, no email. |
| [Vadym Petryshyn (Postory)](https://postory.io/blog/twitter-suspended-appeal) | unstated; author believes reply volume read as spam | Five appeals over a month, each rewritten so it was not a repeat. The one that worked argued the practical point: "how can I fix anything while suspended? I can't see my posts, I can't delete anything, I can't access the account at all. Restore my access and I will fix it." | Restored within an hour of that appeal. Reach stayed limited for eight more days. |
| [Pump.fun and Alon, June 2025](https://coingape.com/pump-fun-and-founder-return-to-x-following-account-suspension/) | none shown; part of a ~20-account crypto sweep | No public appeal; no statement. | Restored in about 24 hours. Shows crypto-adjacent sweeps get reversed quietly when the accounts are plainly real. |
| [Bankr, October 2025](https://www.theblock.co/post/374119/bankr-back-live-x) | none given | Community tagged X product leads under `#FreeBankr`. | Restored within hours. X never explained either direction. |
| [Dean Phillips campaign, 2023](https://www.cbsnews.com/colorado/news/twitter-suspends-rep-dean-phillips-campaign-account-2024-presidential-bid/) | generic | Press coverage. | Restored; mechanism never disclosed. |
| [Karen Selick, 2022](https://karenselick.substack.com/p/twitter-has-restored-my-account-after) | told in March the decision was permanent and could not be appealed | Re-appealed months later saying she did not understand the suspension. | Restored by July. A "cannot appeal" reply is not final. |
| [Ken Klippenstein, Sept to Oct 2024](https://www.kenklippenstein.com/p/elon-musk-accepts-defeat) | "permanently suspended" | His own appeals did nothing. Reinstated 2024-10-13 after a New York Times story and Musk posting "I've asked X Safety to unsuspend him." | Restored after 17 days, by executive intervention, not by the form. |
| [@Rainmaker1973, May 2026](https://x.com/nikitabier/status/2059285953815199899) | inauthentic behaviour | Public thread. Nikita Bier replied in public with the actual trigger (re-uploading others' videos with cropped watermarks to game creator payouts). | Not restored. Shows the risk of the public route: if there is a real trigger, the Head of Product will say what it was, in public. |

Patterns that hold across every case that gave detail:

1. **Short and specific beats long and general.** Name the handle, the date,
   and the exact rule from the email. Say in one or two sentences why it does
   not apply. Ask for a human review. Stop.
2. **Identity verification is the single strongest move for an authenticity
   suspension**, because it answers the charge directly. If X offers ID
   verification at login (it did for Gasparro), complete it before appealing.
   If it does not, say in the appeal that you will.
3. **Say what you are willing to do.** "Willing to remove anything flagged"
   and "restore access and I will fix it" both appear in winning appeals. It
   costs nothing and it reads as cooperative to a reviewer who has just seen a
   hundred angry ones.
4. **Persistence worked, hostility did not.** Every success that took more
   than one attempt spaced them days apart and reworded each one. Nobody who
   reported success sent identical text repeatedly or filed within 24 hours of
   a denial.
5. **Reinstatement is often silent.** Check by logging in, not by waiting for
   an email.
6. **X's own staff say repeat filings do not change the automated answer;
   they reach the eventual human.** A developer-relations staffer on X's
   forum, June 2026: "Automated restoration emails without actual
   reinstatement usually indicate the appeal was rejected by the system.
   Multiple appeals won't change the outcome, wait for a manual review"
   ([devcommunity](https://devcommunity.x.com/t/suspended-for-inauthentic-behavior-even-though-i-am-a-real-user-getting-automated-restoration-emails-looped/269327)).
   Read together with the successes: spaced, reworded filings are how people
   stayed in the queue until a person looked, not a lever in themselves. The
   tell that a person looked is the email opening "Our support team" rather
   than "Our automated systems".

## 4. What got people denied

Collected from the same sources plus the failure threads. Each is something a
real appeal did.

- **Creating a second account.** Ends the appeal and gets both suspended.
- **Filing again inside 24 hours of an automatic denial**, or resubmitting the
  identical text. Reads as spam to the system that judges spam.
- **Arguing about the reporters, the motive, or the post that preceded it.**
  Converts a category error into a content dispute, which a support queue
  cannot decide in your favour.
- **Threatening legal action, or an angry tone.** Listed as a rejection
  trigger by every guide and never present in a successful case.
- **A generic "I didn't do anything, please help."** The one quantified
  dataset puts these at less than half the reinstatement rate.
- **Novel-length appeals.** Reviewers skim. Anything past four short
  paragraphs is unread.
- **Letting other people mass-email support on your behalf.** The Bankr
  campaign was public tagging by a community, not a support flood; guides list
  third-party appeals as a rejection trigger.
- **Changing the account's email, phone, or handle during the process.** The
  form matches what you enter against the record. Worse, one June 2026 case
  reports that changing the username and un-liking old posts to "clean up" is
  what tripped the inauthentic flag in the first place
  ([devcommunity](https://devcommunity.x.com/t/restoration-emails-for-suspended-accounts-inauthentic-behaviors-are-false-accounts-do-not-get-restored-suspension-is-not-lifted-as-email-indicates/268394)).
- **Mass-deleting old posts.** Petryshyn, first-hand: "Removing hundreds of
  old posts can worsen the case." Bulk deletion is itself a pattern the
  classifier reads as inauthentic. Do not touch the timeline.
- **Referencing the suspended account from another account's bio, or calling
  X out from an alt.** Both listed as appeal-killers by Postory, and both
  look like evasion under the policy's "imitating a suspended account" and
  "having someone else operate an account on your behalf" clauses.
- **Resuming full activity the moment it comes back.** A restored 2015
  account reported being re-suspended "if I so much as breathe on the
  account". Both first-hand successes had reach suppressed for about eight
  days after restoration. Ramp up over a week.

## 5. The appeal text, as filed

**Filed 2026-08-28 at 06:26** through the form, logged in as `@nichxbt`,
handle and email pre-filled by X. The form answered: "Thank you! We've
received your request. We'll review, and take further action if appropriate.
In some cases, we may send an email with more information to the address you
provided." This is the text that was submitted, verbatim:

> My account @nichxbt was suspended on August 27, 2026 for "violating our
> rules against authenticity" after being reported. I believe a real person's
> account was suspended by mistake. I have held this account since 2014 and
> post from it by hand; it has never used automation or engagement services,
> and it has never been used to spam or deceive anyone. It is where I share
> the open-source 3D and AI software I build and stay in touch with people I
> have known for over a decade. I am the founder of three.ws
> (github.com/nirholas/three.ws), and my identity is public and verifiable
> through our published partner listings with IBM, AWS, OpenAI and Google
> Cloud. I am glad to complete government-ID verification or any other check
> you need. Please have a person re-review the account and restore access.

Seven sentences. Rule, why it does not apply, what the account is for,
verifiable identity, an offer of the one check that answers an authenticity
charge directly, one ask.

**Two things an earlier draft said that this one deliberately does not.**
The draft claimed the account had "never used multiple accounts"; the same
person operates `@trythreews`, which X permits (up to ten accounts for
distinct purposes) but which makes a flat "never" falsifiable in one click,
and a false statement in an appeal is the one thing that can turn a mistaken
suspension into an upheld one. The draft also offered to "remove any post
you identify", which reads as though a post is expected to exist; it became
an offer of any further check instead. Every remaining claim is one the
owner can stand behind if asked: the year, manual posting, no automation or
engagement services, the company, the partner listings, the offer to verify.

**Why the appeal says nothing about the company account.** X's ban-evasion
clause lets it link any account "the same account holder or entity may be
operating", and its Head of Product has said that automation on one account
suspends "all associated accounts" ([2026-02-14](https://x.com/nikitabier/status/2022496540275937525)).
That would matter if `@trythreews` posted through an API app, because a
reviewer who linked the two would find it. It does not: no X developer app
was ever configured or used from three.ws, on either account (see the table
in section 1; verified against production on 2026-08-28). So there is nothing
to pre-empt, and volunteering the company account would only invite a
reviewer to link two accounts that X has no reason to look at together.

## Filing log

Every contact with X about this suspension, in order. Append to it; never
rewrite an earlier line.

| When | What | Result |
| --- | --- | --- |
| 2026-08-27 06:29 | X emails: account "was reported and has been suspended" for "violating our rules against authenticity". | Suspension confirmed; public user endpoint answers "User is suspended". |
| 2026-08-28 06:26 | Appeal #1 filed through the form with the text in section 5. | Form acknowledged receipt. Awaiting review. Next check: log in daily; earliest refiling if silent or auto-denied: 2026-08-31. |
| 2026-09-05 04:25 | X emails the decision on appeal #1: "a violation of our Rules did take place", "Violating our Rules against authenticity", "we will not overturn our decision to lock your account". Adds that functionality can be restored by "logging into your account and completing the on-screen instructions". | Denied. Eight days from filing, so a human review rather than the documented same-day auto-denial: appeal #2 must carry a new fact, not the same text. See section 6 step 5. |
| 2026-09-06 | Public probe re-run against both handles from a datacenter IP. | `@nichxbt` (id `2817123964`) still answers `"User is suspended"`; control `@trythreews` answers `200` and live. The denial's "lock" wording did not come with a change of state. X's own syndication endpoint rate-limits this IP (`429`), so the probe went through a public mirror of the same endpoint. |

## 6. The order of operations

1. **Create nothing.** Do not open a new account under any name, do not let
   anyone operate one "for" the founder, and do not post about the suspension
   from `@trythreews`. Premium can stay or go; X says it makes no difference
   to enforcement and refunds nothing, so that is purely a billing call.
2. **Log in as `@nichxbt` on desktop.** If X shows an identity-verification
   prompt, complete it (government ID plus selfie, via Persona). This is the
   highest-value single step for an authenticity case.
3. **File the appeal through the form.** Done, 2026-08-28 06:26; see the
   filing log. Keep the confirmation screenshot.
4. **Wait a full 72 hours.** An automatic denial inside the first day is the
   documented norm and is not the end. What arrived instead was a denial on
   day 8 (2026-09-05), which is the slower human-review path.
5. **If denied or silent after 72 hours: refile, reworded, with one new
   fact.** The new fact is ID verification if it completed after the first
   filing, otherwise a specific pointer such as the account's 2014 creation
   or a partner listing URL. Do not resend the same text. Every 3 to 5 days,
   never sooner. **This is where the case stands now.** Appeal #1 was denied,
   so appeal #2 is due, and the single highest-value new fact remains a
   completed ID verification (step 2); if that is already done, lead with it
   and say so in the first line.
6. **Check by logging in, not by waiting for email.** Restoration was silent
   in the best-documented case. A "restored" email that does not restore
   access is a known 2026 bug: log out, reset password, log in again.
7. **After restoration:** change the password, enable 2FA, and post lightly
   for a week. Gasparro's reach stayed suppressed for about eight days after
   reinstatement; Petryshyn's for eight. Do not resume the previous cadence on
   day one, and do not use any third-party posting tool on this account.
   (There is no developer app tied to this account, so the separate
   app-reinstatement step that 2026 cases needed does not apply.)

## 7. Escalation, if the form path stalls

In order of documented effectiveness for a US-based founder:

1. **The form, again, with new evidence** (section 6, step 5). Every
   documented reinstatement of an inauthentic-behaviour suspension in 2026
   went through the form, most after several spaced filings. Reddit's
   r/twitterhelp survey of successful cases, as summarised by PiunikaWeb
   (2026-04-26), converges on about five appeals spaced roughly 48 hours
   apart, calm, each explicitly asking for manual review, continuing even
   after a "cannot be restored" reply
   ([PiunikaWeb](https://piunikaweb.com/2026/04/26/x-twitter-suspended-account-recovery-tips/)).
2. **A public thread that reaches X's Head of Product.** This is the only
   route with documented reversals of individual suspensions that the form
   did not fix (Klippenstein 2024; the March 2026 wave; Bankr). Nikita Bier
   reads replies to his posts and pulls the internal record, and he answers
   in public. That is also the risk: in the Rainmaker1973 case he named the
   real trigger for everyone to see. Run it from a personal or community
   account, never from `@trythreews` (see [x-accounts.md](x-accounts.md)). Tag
   `@nikitabier` with the handle, the date, the email's wording, and proof of
   ID verification. `@Support` and `@Safety` do not answer individual cases
   in any documented 2025 to 2026 instance, and the Better Business Bureau
   lists 5,945 of 6,042 complaints against X Corp as unanswered.
3. **Executive email, once, after two weeks.** Elliott Advocacy's verified
   contact list (updated 2026-05-14): Head of Product `nbier@twitter.com`,
   VP Product `kcoleman@x.com`, Head of the Americas `monique@x.com`
   ([elliott.org](https://www.elliott.org/company-contacts/twitter/)). One
   email, the appeal text plus the ID-verification screenshot, sent only
   after the form path has had two weeks and at least three filings.
4. **A data-access request, for the record rather than the result.** In the
   EU, an Article 15 GDPR request forced X to disclose an automated
   classifier as the real trigger, but only under litigation (Mekić v. X,
   Amsterdam, 2024). From the US, a CCPA "right to know" through
   `help.x.com/en/forms/privacy/request-account-info/me` has no documented
   case of returning enforcement history. File it anyway; it costs nothing
   and dates the request.
5. **EU Digital Services Act, only if physically in the EU when using X.**
   The rights attach to location, not citizenship or account settings. Article
   20 gives an internal complaint with human review; Article 21 gives a
   certified out-of-court body. Three facts most guides get wrong: X states
   on its own DSA page that it "is not bound by any decision made by a
   certified out-of-court dispute settlement body"; the Appeals Centre Europe
   does **not** cover X (User Rights in Berlin and ADROIT in Malta do); and
   no body has published a single X reinstatement through this route. Of
   14,000 suspension disputes the Appeals Centre received in its first year,
   fewer than 150 got a full review because platforms did not hand over the
   material ([RTE, 2026-05-28](https://www.rte.ie/news/2026/0528/1575608-social-media-complaints/)).
   Leverage at best; not available from the US.
6. **Legal.** The premise most articles rely on is dead: X's US consumer
   Terms dropped arbitration on 2024-11-15 and now send disputes to state or
   federal courts in Wichita or Tarrant County, Texas
   ([x.com/en/tos](https://x.com/en/tos)), so there is no "make them pay AAA
   fees" lever. On the merits, Ryan v. X Corp (N.D. Cal., 2024-12-09)
   dismissed every theory under Section 230 plus the "for any or no reason"
   clause, and the platform win streak on account-termination suits is
   described as "effectively unbroken"
   ([Goldman](https://blog.ericgoldman.org/archives/2024/12/suspended-twitter-user-loses-lawsuit-due-to-section-230-ryan-v-x.htm)).
   The one public demand letter to X Corp at the Bastrop address went
   unanswered. The single crypto counter-example, ElizaOS, was restored in
   December 2025, six months after filing a federal antitrust suit over its
   June 2025 suspension, with no settlement announced and no causal link
   established ([Cryptopolitan](https://www.cryptopolitan.com/x-restores-elizaos-founder-account/)). Small claims is a Premium-refund play, not a reinstatement
   play. This route ends every goodwill path above it; do not open it.
7. **There is no AI "second review".** Grok is upstream of suspensions (X
   uses it as a classifier), not an appeal lane. Asking `@grok` returns the
   Help Center steps.

## 8. What stays true regardless of outcome

The platform's announcements do not depend on this account. The changelog
publishes to Telegram straight from each deploy, `@trythreews` is verified as
an organisation with 9.1K followers, and every partner listing already points
at the company rather than the person. The account is worth recovering for
its history and its reach, and the recovery should be run carefully because
there is one clean shot at it, but nothing operational is waiting on it.

## Research notes

Primary X pages were read from Wayback Machine captures (June to August 2026)
because `help.x.com` blocks non-browser requests; the captures were consistent
across dates. First-hand appeal accounts, X's DSA transparency reports, the
X developer forum threads, and the executive-contact list are linked inline.
Where a source is a vendor blog rather than a first-hand account or an X
page, the text says so. Nothing in this file is quoted from a source that
could not be opened.
