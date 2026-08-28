# Data safety form answers

Play Console > App content > Data safety. Google cross-checks these answers against the
privacy policy at <https://three.ws/legal/privacy>, and a mismatch is a rejection, so change
both together or neither.

Terms used below are Play's, not ours. **Collected** means the data leaves the device to our
servers. **Shared** means it is transferred to a third party. **Processed ephemerally** means
it is used to service the request and not retained.

## Blocking issue before this form can be submitted

**The live privacy policy does not mention photo or camera data at all.** It documents account
identifiers, uploaded 3D models, on-chain data, usage data, session data and legal acceptance
records (version 2, effective July 16, 2026), and the selfie capture flow predates none of
that: it is simply missing. The declaration below says photos are collected and retained,
because `api/_lib/likeness-store.js` reads capture URLs back out of the stored generation
params, so they persist. A Data safety form that declares photo collection against a privacy
policy that is silent on photos is exactly the mismatch Google rejects.

Draft clause for the owner to review and publish before either store submission. It states
what the code already does and adds no new commitment:

> **Photos you capture or upload.** If you use the selfie flow, the photos you capture (one
> frontal image and up to two optional side angles) are uploaded to our reconstruction service
> and used to build your 3D avatar. They are stored with the generation record so the result
> can be reproduced, re-rigged and re-scored for quality, and they are visible only to your
> account. They are deleted when you delete the generation or your account, subject to the
> retention windows in Section 5. We do not use them to train models, we do not share them
> with advertisers, and we do not derive or store a face template or any other biometric
> identifier from them.

The last sentence is verifiable in code: `api/_lib/likeness-score.js` computes face embeddings
in memory to score likeness and files only the resulting 1 to 5 number, never the embedding,
the crop, or the capture URL.

## Data types

| Play data type | Collected | Shared | Required | Purposes | Notes |
| --- | --- | --- | --- | --- | --- |
| Personal info > Email address | Yes | No | Optional | Account management, app functionality | Only if the user registers with email; wallet-only accounts never provide one |
| Personal info > User IDs | Yes | Yes | Optional | Account management, app functionality | Username, display name, and wallet address. Shared is **Yes** because deploying an agent writes the wallet address to a public blockchain, which is disclosure and cannot be retracted |
| Photos and videos > Photos | Yes | Yes | Optional | App functionality | Selfie captures. Shared is **Yes** because generation is forwarded to upstream model providers named in the privacy policy. Collected only when the user chooses the selfie flow |
| Files and docs > Files and docs | Yes | No | Optional | App functionality | GLB/glTF models the user uploads |
| App activity > Other actions | Yes | No | Optional | App functionality, analytics, fraud prevention | API calls and widget load events, for quota and abuse limits |
| App info and performance > Crash logs | Yes | No | Optional | Analytics | Client error reports posted to `/api/client-errors` |
| Device or other IDs | No | No | | | No advertising ID, no device fingerprinting. Session records store a hashed IP and the user agent, which Play does not classify as a device ID |

Everything not listed is **not collected**: no location, no contacts, no calendar, no SMS, no
call logs, no health data, no financial account or payment information (all value transfer is
on-chain and settled by the user's own wallet), and no audio recordings.

## Security practices

- **Encrypted in transit:** yes. HTTPS everywhere, HSTS with `preload` on the apex.
- **Users can request data deletion:** yes. Deletion is available in-product and at
  <https://three.ws/legal/privacy>. Deleted accounts are soft-deleted for 30 days, then purged.
- **Committed to the Play Families Policy:** not applicable, the app is 18+.
- **Independent security review:** no. Do not claim one.

## Data deletion URL

<https://three.ws/legal/privacy> (Section 5 covers retention and the deletion path).
