# X accounts: which handle is live, and what to do when one is not

three.ws has used two X accounts. This file records their status and what
each surface in the repo should do about it. Read it before posting
anything from an [`x-posts/`](x-posts/README.md) draft, before adding an X
link to a page, and before deciding which handle a meta tag should name.

## Status

| Handle | Role | Status |
| --- | --- | --- |
| [`@trythreews`](https://x.com/trythreews) | Institutional. The platform account. | Live. This is the only handle to link to or post from today. |
| `@nichxbt` | Personal. The founder account. | **Suspended 2026-08-27; appeal #1 denied 2026-09-05; still suspended, re-confirmed by probe 2026-09-06.** Confirmed by X's own notification emails. Do not link to it and do not plan a post from it. Status and filing log: [`x-account-appeal.md`](x-account-appeal.md). |

The suspension is confirmed, not inferred. X emailed the account owner at
06:29 on 2026-08-27: the account "was reported and has been suspended",
citing the **authenticity** policy, which covers inauthentic activity that
undermines the integrity of the platform. An HTTP probe could never have
established this on its own, because x.com serves the same JavaScript shell
with a `200` for a live profile and a suspended one. If the account is
restored, update this table first and the surfaces below second.

Two operational facts from that email, both load-bearing:

- **Creating a replacement account is suspension evasion**, and X says
  plainly it will suspend the new account too. So "spin up a second personal
  handle" is not an available workaround for anything in this file, and the
  quote-tweet rule below is written around that.
- **An X Premium subscription is not cancelled by the suspension** and keeps
  billing until someone cancels it deliberately.

Appeal #1 was denied on 2026-09-05: X says a violation "did take place" and
that it will not overturn the decision. That closes the first filing, not the
route. Refiling through the form is what the documented reinstatements did,
and it is the live next step. The full case, X's own process, the precedents,
the exact text to file, and the order to do it in are in
[`x-account-appeal.md`](x-account-appeal.md). Nothing in this repo should wait
on it.

One wording trap in that denial, because it will be read again later: the
email says "lock", and a locked account normally clears itself through an
on-screen flow at login. This one does not. The public probe still answers
"User is suspended" for user ID `2817123964` (2026-09-06), so the account is
suspended and the lock template is boilerplate. Do not record it as a
downgrade in status, and do not tell anyone the handle is one login away.

The reader-facing version of the status table lives on
[three.ws/community](https://three.ws/community), which lists every channel and the
`$THREE` contract address in one place so a visitor can check a suspicious account
against it. Keep the two in step: this file is for the repo, that section is for the
community, and neither should say something the other contradicts.
[`community.md`](community.md) carries the same list for readers who arrive through
the docs.

## What a suspended handle actually breaks

A suspended account's profile URL and every one of its post URLs serve a
"this account has been suspended" interstitial. That has three distinct
consequences in this repo, and they want three different responses:

1. **Links a visitor clicks now.** These are the only ones that matter to a
   reader today, and they are repointed at a live URL. Card metadata
   (`twitter:creator`, `twitter:site`) and page attribution name
   `@trythreews`; author identity in structured data points at
   [github.com/nirholas](https://github.com/nirholas), which does not
   depend on X at all.
2. **Historical citations.** [`public/launch-week.html`](../public/launch-week.html),
   the archives under [`data/archives/`](../data/archives) and
   [`data/x-archive/`](../data/x-archive), the news feed's archived items,
   and the changelog all cite posts by their URL because that URL is the
   record of what was said and when. Those are left exactly as they are. A
   citation that now resolves to an interstitial is still an accurate
   citation; rewriting it would silently edit the platform's own history to
   match an account status, which is worse than a dead link.
3. **Unposted drafts that assume the account exists.** This is the real
   cost, and it is covered below.

## The two-account playbook, while `@nichxbt` is unavailable

Nine drafts in [`x-posts/`](x-posts/README.md), plus
[`x402-solana-july-roundup-response.md`](x402-solana-july-roundup-response.md)
and [`../marketing/openai-select-partner/social-copy.md`](../marketing/openai-select-partner/social-copy.md),
are written around one pattern: `@trythreews` posts the institutional version, then `@nichxbt`
quote-tweets it twenty to forty minutes later in first person, because an
institutional account cannot credibly say "I built this and here is the
part that broke." That second half is undeliverable right now.

The drafts keep their two-account structure. They are not rewritten,
because the structure is correct and the account may come back, and
because flattening them into single-account copy would destroy the
personal-voice half that is the harder half to write.

Posting one of them today means doing this instead:

- **Post the `@trythreews` half as written.** It stands alone; every draft
  was built so the institutional post is complete on its own.
- **Hold the `@nichxbt` half.** Do not port its copy onto `@trythreews`.
  The personal-voice post reads as a person, and pasting it under the
  platform account produces the exact self-amplifying tone the drafts warn
  against.
- **Do not stand up a new personal account to fill the slot.** A second
  handle for the same person is suspension evasion by X's own definition and
  gets suspended in turn, which costs the appeal as well as the account. If a
  genuinely different person on the team takes the personal-voice slot, use
  their handle verbatim and add it to the status table above; nothing else in
  the drafts changes.

Two drafts have a further wrinkle worth knowing before you open them:
[`osf-issue-reply.md`](x-posts/osf-issue-reply.md) picks between a long and
a short form based on whether the posting account has Premium, which is a
question about a specific account rather than about the copy, and
[`open-source-friday-plan.md`](open-source-friday-plan.md) submits the
handle as a form field to a third party.

## Do not litigate the suspension from `@trythreews`

The suspension was report-driven. Whatever prompted the reports, the account
that answers them publicly becomes the next target, and `@trythreews` is the
platform's only remaining X presence and the one every partner listing links
to. So the platform account does not post about the suspension, does not
name or accuse anyone over it, and does not amplify the post that preceded
it. Announcements continue on their normal cadence as though nothing
happened, which is also true: see the next section.

That restraint is a posture, not a concession. The appeal is the venue for
the argument, and it is a private one.

## The RSS mirror still works

[`/rss/announcements.xml?source=nichxbt`](https://three.ws/rss/announcements.xml?source=nichxbt)
is unaffected as a feed. It is built from the archived JSON in
[`data/x-archive/`](../data/x-archive), not from a live scrape, so it keeps
serving the same items with the same content whatever X does to the
account. Only the per-item links point into the suspended account, which is
case 2 above. The source stays valid; see
[`syndication.md`](syndication.md).

## Referral codes are not the handle

`gmgn.ai/r/nichxbt`, `trade.padre.gg/rk/nichxbt`, and `fomo.family/r/nichxbt`
in [`src/shared/trading-terminals.js`](../src/shared/trading-terminals.js)
reuse the same string as a referral code on three unrelated services. They
have nothing to do with X and are not affected. Do not "fix" them.

Source-file copyright headers (`Copyright (c) 2026 nirholas | x.com/nichxbt
| github.com/nirholas`) across the SDKs are attribution of authorship at a
point in time, not a link a reader is expected to follow. They are left
alone too.
