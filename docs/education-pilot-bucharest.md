# Education Pilot: Sector 1 Bucharest (Draft)

Status: exploratory. A contact has offered a local connection to the office of the deputy mayor of Sector 1, Bucharest (education and schools portfolio). This doc holds the outbound reply and the one-page pilot brief to forward once there is interest.

## The honest position (read before pitching)

- Our signing avatars speak **ASL (American Sign Language)**, not **LSR (Limba Semnelor Române / Romanian Sign Language)**. These are different languages. Never pitch the current feature as an accessibility tool for Romanian deaf students.
- What we can honestly pitch today: 3D learning assistants for regular classes, plus a unique English-learning loop (avatar signs and fingerspells English words; students practice back at a webcam that grades their handshape on-device).
- The signing engine is language-agnostic: signs are authored as data ([src/sign-dictionary.js](../src/sign-dictionary.js)), so LSR is content work, not an engine rewrite. Building LSR credibly requires native LSR signers and educators reviewing every sign; a school partnership is exactly how to get that review.
- Privacy story is strong and real: the practice loop ([/sign-mirror](https://three.ws/sign-mirror)) runs fully on-device with no network call, and the recognition lane uploads hand landmarks only, never video. No accounts are required for any of the learning surfaces.

## Reply draft (send to the contact)

> Hey, thanks for bringing this to me. Yes, we're open to it, and I'd like to explore it seriously.
>
> One thing I want to be upfront about so we set the right expectations with the school: our signing avatars currently speak ASL (American Sign Language), not LSR (Romanian Sign Language). Those are different languages, so I don't want to walk in promising an accessibility tool for deaf students that isn't there yet.
>
> That said, here's what we can do today, and what I'd propose:
>
> **Phase 1 (ready now): a regular-class pilot.** 3D agents as learning assistants, plus an English-learning angle that's genuinely unique: kids type an English word, a 3D avatar signs and fingerspells it, and they can practice signing back at the webcam, which grades their handshape in real time. Privacy-wise it's built for exactly this setting: the camera video never leaves the device, only hand landmark points are processed, and the practice loop runs fully on-device. No accounts needed.
>
> **Phase 2 (co-development): true LSR support for the special-needs group.** Our signing engine is language-agnostic, so adding Romanian Sign Language is content work, not a rebuild. But we won't do it without native LSR signers and educators reviewing every sign. If the school can connect us with LSR-fluent staff or interpreters, we'd build the LSR vocabulary with them. That makes the pilot a real partnership rather than us dropping software on them.
>
> If your contact is open to it, a 30-minute call with whoever runs the education programs would be the right next step. I can put together a one-page brief in advance. And happy to have you make the local connection, that would help a lot.

## One-page pilot brief (forward after interest)

### three.ws education pilot: 3D learning assistants and signing avatars

**What three.ws is.** A web platform for 3D AI agents: animated avatars that talk, teach, and sign, running in any browser with nothing to install. Free to use for the surfaces in this pilot; no student accounts required.

**What we propose.**

*Phase 1: one or two regular classes (4-6 weeks).*

- **3D learning assistants.** A teacher-configured 3D avatar embedded in class materials that students can ask questions in natural language.
- **English + sign language practice.** Students type an English word and a 3D avatar fingerspells and signs it ([three.ws/sign-language](https://three.ws/sign-language), [three.ws/asl-alphabet](https://three.ws/asl-alphabet)). In the mirror room ([three.ws/sign-mirror](https://three.ws/sign-mirror)), the webcam watches the student's hand and grades the handshape live, naming the finger that is wrong. Works on ordinary school laptops.
- **What we measure.** Engagement (voluntary practice time, alphabet completion), teacher-reported usefulness, and a before/after fingerspelling reading test.

*Phase 2: co-developing Romanian Sign Language (LSR) support with the special-needs group.*

- Our signing engine is not tied to any one sign language; vocabularies are authored as data and reviewed by fluent signers.
- With LSR-fluent staff or interpreters from the school, we would author and review an initial LSR vocabulary, giving Romania its first browser-native LSR signing avatar, built with the community that uses it.
- The special-needs group and its educators define the vocabulary priorities; we ship review tools and iterate weekly.

**Privacy and safeguarding.**

- The handshape practice loop runs entirely in the browser: no video frame, landmark, or score is ever uploaded, and there is no network call in the practice loop.
- The optional sign-reading feature uploads anonymous hand landmark coordinates only, never video or images.
- No student accounts, no personal data collection, no ads, no tracking of minors. GDPR posture available on request.

**What we need from the school.**

- 1-2 participating teachers and a 30-minute onboarding call.
- Ordinary laptops or tablets with a webcam and a browser.
- For Phase 2: access to LSR-fluent staff or interpreters for sign review sessions.

**Cost.** The pilot is free. We fund the infrastructure; the school contributes feedback and, in Phase 2, sign-language expertise.

## Next steps checklist

- [ ] Send the reply above to the contact.
- [ ] If interest: schedule the 30-minute call, forward the brief.
- [ ] Phase 2 groundwork: scope an LSR vocabulary format and a signer review flow on top of [src/sign-dictionary.js](../src/sign-dictionary.js) (do not start authoring signs without native signer review lined up).
