# Make your avatar sign

By the end of this tutorial your avatar will fingerspell any word you type, sign a real vocabulary of everyday words, sign every reply an AI agent gives, and read your own fingerspelling back from your webcam. You will also have a signed phrase you can share as a link and an animated GLB of it on your own machine.

**Prerequisites:** a browser and a webcam for the last step. No account, no install, no code. The optional final section adds signing to your own site with one HTML attribute.

**Time:** about 15 minutes.

---

## What you're building

```
Type a phrase  ──►  the avatar signs it  ──►  share it as a link
       │                                             │
       │                            export it as an animated GLB
       │
       └──►  turn on signed chat  ──►  the agent answers in ASL
                     │
                     └──►  sign back at the camera  ──►  it reads you
```

Two directions, one loop: the avatar signs to you, and you sign to it.

Before anything else, know the one distinction that makes the rest make sense:

| | What it is | Example |
|---|---|---|
| **Fingerspelling** | Spelling a word letter by letter with the manual alphabet | Your name, a URL, a made-up word |
| **A lexical sign** | A word with its own sign: a handshape, a place on the body, a movement | `HELLO`, `THANK`, `HAPPY`, `FRIEND` |

Real signers do both in the same sentence. So does the avatar: words with a sign are signed, everything else spells, all in one continuous motion with no seam between them.

---

## Step 1: Sign your first phrase

Open **[/sign-language](/sign-language)**. An avatar is already signing: it cycles through a few phrases so you see real signing rather than a static pose.

Now make it say something of yours. Click the input box (or just press `/` anywhere on the page), type your name, and press **🤟 Sign it**.

Watch the status line under the avatar. It tells you exactly what happened, for example:

```
signed happy, meet, you · spelled to
```

That line is the whole feature in one sentence: three words had real signs, one got spelled. Try a few things and watch the line change:

- `thank you` (both words sign)
- `42` (numbers have handshapes too)
- your street address (mostly spelling)

**If nothing moves:** you probably have "reduce motion" turned on in your operating system. That is deliberate. Signing is content, not decoration, so the page never auto-plays under that setting, but every button still works. Click **🤟 Sign it** and it signs.

---

## Step 2: Set the speed, the hand, and the face

Under the input are three settings. All three are remembered the next time you visit, so a left-handed signer never has to re-declare themselves.

| Setting | Try this |
|---|---|
| **Speed** | Set `0.5×` and replay your phrase. Full speed is fluent-signer pace; half speed is what you want while learning, and nothing is lost by slowing it |
| **Signing hand** | Switch to **Left-handed**. Replay. The *entire* sign mirrors, not just which hand is up, because signs are described anatomically rather than as fixed coordinates |
| **Avatar** | Switch to **Expressive face**, then sign `what`. Watch the brows |

That last one matters more than it looks. In ASL the face is grammar: raised brows mark a yes/no question, furrowed brows mark a wh-question ("what", "where", "why"). The classic rig is a light model with no facial blendshapes, so it signs the hands correctly and simply has no face to move. The expressive rig carries the full ARKit shape set, so the markers actually show.

---

## Step 3: Browse what it signs, not spells

Scroll to **"It signs these. It doesn't spell them."** Every chip there is a word with a real sign in the avatar's vocabulary. Click one and the avatar performs it; hover it and you get the description of the sign itself, for example FALL: *"Two legs stand on the flat palm, then tip over onto their back."*

Click a few that use two hands (`HAPPY`, `LOVE`, `MEET`, `WANT`) and a few defined by contact (`GOOD`, `KNOW`, `HELP`, `FALL`). The contact ones are worth a second look: the fingertips genuinely land on the palm or the forehead, because contact is solved from where that avatar's hand and head actually are, not from a coordinate that only works on one body.

Another 41 everyday spellings resolve to those same 32 signs, so ordinary sentences work without you memorizing the list: `hi` signs HELLO, `thanks` signs THANK, `everyone` signs Y'ALL, `done` signs FINISH. Everything else fingerspells, which is exactly what a human signer does with a name they have never seen.

The full vocabulary with every gloss is in [the sign language reference](../sign-language.md#what-it-signs-and-what-it-spells).

---

## Step 4: Share a signed phrase as a link

Sign a phrase you like, then click **🔗 Share this phrase**. That copies a link:

```
https://three.ws/sign-language?say=happy+to+meet+you
```

Open it in a new tab. The page loads and signs the phrase on arrival, on whatever avatar the visitor has chosen, at whatever speed they prefer. Nobody needs an account, an app, or an explanation of what they are looking at.

You can also write these by hand. `?say=` takes any text, spaces as `+`.

---

## Step 5: Export a spelled word as an animated GLB

The signing page is for watching. The **[Animation Studio](/pose)** is where you take signing away with you as a file.

1. Open **[/pose](/pose)**.
2. Click **Load avatar** in the top bar and pick any rigged avatar. (The default mannequin has no skinned skeleton, so the animation tools stay locked until a real rig is loaded.)
3. In the **Animation** panel on the right, find the **Spell** box. Type a word and press **🤟 Spell**.

The avatar spells it, and the transport bar appears exactly as it does for a library clip: scrub it, slow it to `0.5×`, stop it. Then click **Export animated GLB** and you get a single self-contained file with the spelling baked onto that avatar's skeleton. It opens in any glTF viewer.

The spelling is built in your browser, deterministically, from a parametric hand model. It is instant, works offline, and nothing is uploaded.

Two things to know:

- The Studio's Spell box **spells only**. It does not use the lexical vocabulary from Step 3. For signs, use [/sign-language](/sign-language) or the `SignSpeaker` API in the reference.
- A rig with no finger bones cannot form handshapes, so the Studio refuses with an explanation rather than playing something wrong. Load an avatar with fingers.

Spelled words are shareable too: `/pose?spell=HELLO` spells that word on arrival.

---

## Step 6: Get signed answers from an AI agent

Open **[/app](/app)** and start a conversation with an agent. In the chat header, click the **🤟** button.

Sign mode is now on. Ask it anything. Every reply is signed on the avatar: library signs where they exist, fingerspelling for the rest, in one continuous performance rather than a stutter of separate words. Click **🤟** again to turn it off.

This is not a special chat mode with its own plumbing. The avatar layer already receives every assistant reply, and signing rides that same event, which is why it works identically in the hosted app and in an avatar embedded on someone else's website.

---

## Step 7: Sign back at it

Now the other direction. In the chat, click the **🎥** button (or use the demo at the bottom of [/sign-language](/sign-language#sl-webcam), which runs the same recognizer).

1. Allow camera access. You get a mirrored self-view, which is how signers expect to see themselves.
2. Fingerspell a word. Good light, hand fully in frame, one letter at a time, and hold the last letter for a beat.
3. Click again to stop. The transcription appears in the message box.

Two honest notes:

- **Your video never leaves your machine.** Your browser converts the camera feed into hand and body landmarks locally, and only those coordinates (numbers, not pixels) are sent for recognition.
- **Expect a 10% to 20% character error rate.** That is the real number for webcam fingerspelling with this model. This is exactly why the text lands in the message box for you to review instead of being sent straight to the agent. Fix it, then send.

If it reads nothing at all, you probably stopped too early: there is a minimum number of frames, below which it tells you to hold the sign a moment longer.

---

## Step 8 (optional): Put a signing avatar on your own site

One attribute. That is the whole integration:

```html
<script type="module" src="https://three.ws/agent-3d/1.5.2/agent-3d.js"></script>

<agent-3d agent-id="your-agent" chat sign-language style="width:400px;height:520px"></agent-3d>
```

Your embedded agent now signs every reply. Toggle it from your own UI whenever you like:

```js
const el = document.querySelector('agent-3d');
el.setAttribute('sign-language', '');   // on
el.removeAttribute('sign-language');    // off
```

Driving it directly from JavaScript, without the chat, takes three lines:

```js
import { SignSpeaker } from './sign-speech.js';

const speaker = new SignSpeaker({ manager: viewer.animationManager });
const { signed, spelled } = await speaker.speak('happy to meet you');
// signed  → ['HAPPY', 'MEET', 'YOU']
// spelled → ['TO']
```

And reading signing from a camera in your own page is the `SignInput` class plus the public `/api/asl-recognition` endpoint. Both are documented in [the reference](../sign-language.md#building-with-it).

---

## Troubleshooting

- **"Load a rigged avatar to fingerspell."** You are still on the built-in mannequin in the Studio. Click **Load avatar**.
- **The avatar refuses to sign at all.** Its skeleton has no finger bones, so handshapes are impossible. The platform refuses rather than faking it. Use a rig with fingers.
- **It signs, but the face never moves.** That rig has no ARKit blendshapes. Switch the **Avatar** setting to **Expressive face** on /sign-language.
- **Nothing plays until I click something.** `prefers-reduced-motion` is on. Every control still works.
- **A word I expected to be signed got spelled.** It has no entry, or the form differs (`ran` where the dictionary has `run`). Spelling is the correct fallback, not a bug.
- **"Sign recognition is not configured."** That deployment has no recognizer configured. Everything except webcam input still works.
- **Signing is too fast to follow.** Use the **Speed** setting. It persists across visits.

---

## What this is, honestly

The avatar signs a core vocabulary of citation-form signs in English word order. That is signed English, not ASL grammar. Real ASL reorders sentences, inflects verbs through space, and carries far more grammar on the face than the markers modeled here. The signs are authored from standard descriptions rather than captured from a specific signer, and growing the vocabulary properly means capture and review with Deaf signers, not more authoring.

None of it replaces a human interpreter. It makes an avatar legible to signers instead of silent, which is a real difference from where most 3D avatars stand today.

---

## Recap

- **[/sign-language](/sign-language)** signs anything you type, with speed, dominant hand, and avatar settings that persist. Words with a sign are signed; the rest fingerspell, in one continuous clip.
- **`?say=`** turns any phrase into a shareable link; the **🔗** chip writes it for you.
- **[/pose](/pose)** spells a word onto your own avatar and exports it as an **animated GLB**, with `?spell=` as its share link.
- **The 🤟 button in [/app](/app)** signs every AI reply, and the `sign-language` attribute does the same on any embedded `<agent-3d>`.
- **The 🎥 button** reads your fingerspelling back to text, with landmarks extracted on-device so video never leaves your machine.

**See also:**

- [docs/sign-language.md](../sign-language.md): the full reference: vocabulary, developer APIs, and how the signing engine works
- [docs/tutorials/animate-your-avatar.md](animate-your-avatar.md): the clip library, retargeting, and animated GLB export in depth
- [docs/web-component.md](../web-component.md): every `<agent-3d>` attribute, including `sign-language`

Primary call to action: open **[/sign-language](/sign-language)** and sign your own name.
