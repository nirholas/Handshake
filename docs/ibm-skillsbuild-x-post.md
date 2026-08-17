# IBM SkillsBuild badge post: getting an @IBM reply

Draft copy for the X post announcing the **Getting Started with Cybersecurity** badge
(IBM SkillsBuild, issued 2026-06-08) and tying it to the three.ws team.

Badge: https://www.credly.com/badges/b7ea921a-ce3d-4f4d-bfac-38f95276d361
Share link (the one to paste): https://www.credly.com/badges/b7ea921a-ce3d-4f4d-bfac-38f95276d361/twitter

## What actually earns the reply

Derived from a 500-tweet scrape of @IBM's timeline (2026-06-17 to 2026-08-17). IBM
replied 14 times in that window. Every reply was one short line of praise on a badge
post, never on a product take or a news comment:

| IBM's reply | Date | Views on the reply |
|---|---|---|
| "Great work! Keep learning!" | 2026-06-17 | 897 |
| "Wonderful work!" | 2026-06-27 | 150 |
| "Awesome work!" | 2026-06-29 | 119 |
| "Nicely done!" | 2026-07-01 | 106 |
| "Thanks so much!" (x5) | 2026-06-17 | 43-293 |

The posts that drew them share four traits. Keep all four:

1. **`@IBM` is mentioned by handle**, not written as plain text. That mention is the
   trigger their social listening keys on.
2. **A `credly.com/badges/<uuid>/twitter` link plus `via @credly`.** The verified-badge
   URL is what separates a claim from a credential.
3. **Short, positive, first-person.** Every replied-to post was under about 200
   characters of human text. Long posts and product opinions got nothing.

What kills the reply: promo language in the main post, more than one outbound link, or
burying the `@IBM` mention below the fold.

### Hashtags do not help, on this evidence

An earlier draft of this doc claimed IBM's own hashtags improved the odds. That was an
inference, not a measurement, and the data does not support it:

- 32 of 231 non-IBM posts in the timeline (14%) carried any hashtag.
- Of the 9 distinct posts IBM plausibly replied to, **1 carried hashtags**, and they were
  `#IBM115` / `#HappyBirthdayIBM`: event tags on a birthday wish, not program tags.
- Of the 31 Credly-badge posts in the timeline, only 4 used hashtags at all.

So the branded-tag theory has no support here, and it runs against X's own guidance that
hashtags no longer feed distribution. The `@IBM` mention is a strictly stronger signal
anyway: it lands the post in IBM's mentions, which a hashtag search does not. **Ship with
zero hashtags.**

### Link in the post, or link in the reply?

Weak evidence, stated as weak. Bucketing the timeline pool by shape and matching against
the inferred reply parents:

| Post shape | Pool | Inferred replies | Rate |
|---|---|---|---|
| Narrative, no link | 23 | 2 | 9% |
| Credly boilerplate + link | 29 | 1 | 3% |
| Narrative + link | 2 | 0 | 0% |

That leans toward no-link, but it rests on 3 badge replies total, and the parent linkage
is inferred from timestamp order because the scrape does not record reply targets. Treat
it as "the link does not appear to be required," not as "the link hurts."

The reason to keep the link anyway: it is the one-click proof a community manager needs
before typing "Great work!". The reason it is safe to drop: the badge certificate image
carries the verify URL and a QR code, so the proof is visible without any link at all.

## Recommended: two-part post

The main tweet stays inside the exact shape IBM replies to. The three.ws story goes in
the self-reply, where it reaches everyone who opens the post but does not dilute the
pattern match on the tweet IBM's team sees.

**Tweet 1** (attach the badge certificate image, 187 characters). Human copy leads, link
sits at the end, no hashtags:

```
View my verified achievement from @IBM

Cybersecurity is a skill everyone should hold. Sharpening the security fundamentals behind everything we ship.

https://www.credly.com/badges/b7ea921a-ce3d-4f4d-bfac-38f95276d361/twitter via @credly
```

Set image alt text to `IBM SkillsBuild certificate: Getting Started with Cybersecurity,
issued June 8 2026`. It is an accessibility requirement and it restates the badge name
for anyone who cannot load the image.

**Tweet 2** (self-reply, 239 characters). This is where the three.ws link goes: the main
post already spent its link on Credly, and a reply carries a link without costing the
parent any reach.

Do not enumerate product surfaces here. Naming wallets, payments or API endpoints turns
a credential post into a product pitch, which is the shape IBM never replied to once in
the scrape, and it advertises the attack surface in the same breath as saying the team
is still learning to defend it.

```
Security is not a feature you bolt on at the end. It is the part of the work users never see and always depend on. That is the standard we hold three.ws to.

More of the team is going through the SkillsBuild track.

https://three.ws
```

Shorter alternate, 195 characters:

```
Security is not a feature you bolt on at the end. It is a habit, and habits are built one fundamental at a time.

More of the team is going through the SkillsBuild track.

https://three.ws
```

## Variant A: single post, three.ws named up front

Use if the goal is brand reach over reply odds. 255 characters.

```
View my verified achievement from @IBM.

https://www.credly.com/badges/b7ea921a-ce3d-4f4d-bfac-38f95276d361/twitter via @credly

Getting Started with Cybersecurity, complete. Strengthening the three.ws team one credential at a time: safer agents, safer wallets, safer users.

#IBMSkillsBuild #Cybersecurity
```

## Variant B: pure boilerplate, maximum reply odds

The literal IBM/Credly share text with nothing added but the tags. 108 characters. The
highest-probability version, and the one with the least to say.

```
View my verified achievement from @IBM.

https://www.credly.com/badges/b7ea921a-ce3d-4f4d-bfac-38f95276d361/twitter via @credly

#IBMSkillsBuild #Cybersecurity
```

## Posting notes

- **Attach the badge PNG.** Only 72 of 500 scraped tweets carried media; badge art makes
  the post legible in a quote or a screenshot.
- **Timing:** every IBM reply in the scrape landed on a weekday. The badge posts that got
  one were published in the morning US Eastern window.
- **One link only.** A second URL splits the crawl and drops the Credly card.
- **Do not quote-tweet @IBM** to announce it. Every replied-to post in the scrape was an
  original tweet, not a quote.
- If the reply does land, answer it once, briefly. Two of IBM's threads continued after
  the earner replied.
