---
name: generate-reference-inspired-brand-worlds
description: Generate multiple original brand campaign worlds from a supplied visual reference while controlling how close the new work feels without copying protected signature elements. Use when a user provides a brand identity image, poster, editorial campaign, moodboard, or generated concept and asks for inspired alternatives, several distinct brands in one visual family, a closer-to-reference V2, exact wordmarks inside images, or originality-safe image-generation prompts and outputs.
---

# Generate Reference-Inspired Brand Worlds

Create brand concepts that feel intentionally related to a reference while changing the identity, meaning, subjects, and signature composition. Treat this as an art-direction layer over the available image-generation workflow.

## Start correctly

1. Load and inspect every supplied image before prompting.
2. Label each input explicitly:
   - `Image 1: primary visual-language reference`
   - `Image 2: current concept/content anchor` when revising an existing result
3. Use the available image-generation tool. When the built-in `imagegen` skill is available, load it and follow its save, reference, iteration, and validation rules.
4. Treat a style reference as guidance, not an edit target, unless the user asks to preserve specific pixels.
5. Keep the reference image out of reusable skill assets unless the user owns it and explicitly authorizes redistribution.

## Set the similarity dial

Use the user's language to choose a target. The numbers communicate intent; they are not measurable similarity scores.

- **30% — distant inspiration:** keep only abstract principles such as mood, density, or contrast.
- **50% — recognizable influence:** share medium and emotional tone; change palette, composition, subjects, and type system.
- **70% — adjacent brand family:** share the reference's composition logic, texture, palette relationships, human presence, and wordmark scale while creating new subjects, actions, arrangement, and letterforms. Default here for “not too different from the inspiration.”
- **85% — close art-direction neighbor:** preserve most high-level visual grammar but change at least four signature elements. Do not recreate an exact commercial identity.

If the user says “inspired, not copying,” preserve originality even when they request the 70–85% range.

## Extract visual DNA

Write two short lists before generating.

### Reusable visual grammar

Capture high-level relationships:

- scene density and depth layers
- palette relationships rather than exact swatches
- print, photographic, painterly, woven, or halftone surface
- lighting and emotional temperature
- type scale, weight, contrast, and placement logic
- amount and role of human presence
- rhythm of organic and architectural forms

### Protected signature elements

Do not reproduce:

- exact people, poses, gestures, clothing, or choreography
- exact flower beds, objects, silhouettes, or motif arrangement
- exact foreground-to-background layout or negative-space shape
- source brand name, slogans, logos, or proprietary marks
- distinctive wordmark letterforms
- recognizable pixel-for-pixel composition

When a reference has one famous or unusually distinctive feature, abstract the principle behind it instead of repeating the feature.

## Build a distinct-brand matrix

For a multi-brand set, hold 4–6 constants and vary the brand story.

Shared constants can include:

- aspect ratio
- medium and texture
- palette relationship
- wordmark color, scale, and placement
- scene density
- emotional tone

Vary at least these fields for every brand:

| Field | Requirement |
|---|---|
| Name | New, exact, and legible |
| Meaning | A specific product, mission, or cultural role |
| Environment | A world that expresses the meaning |
| Human ritual | A unique action, not generic posing |
| Signature motif | One memorable brand-specific object or natural system |

The set should read as one art-direction family, not five color swaps and not five unrelated styles.

## Write one prompt per brand

Use one image-generation call per distinct brand. Do not request five different concepts as variants of one prompt.

Use this prompt spine:

```text
Use case: style-transfer
Asset type: 16:9 landscape brand campaign key visual
Primary request: Create an original identity image for "<NAME>" at approximately <DIAL>% similarity to Image 1's high-level visual grammar.
Input images: Image 1 is the primary visual-language reference; Image 2 is the current concept/content anchor when present.
Brand meaning: <specific meaning and promise>
Scene/backdrop: <new world tied to that meaning>
Subject: <new people, action, and brand ritual>
Style/medium: <reference-adjacent medium and tactile surface>
Composition/framing: <shared composition logic with a materially new arrangement>
Color palette: <relationship to the reference, not exact color sampling>
Text (verbatim): "<NAME>"
Typography: <shared scale/placement logic with original letterforms>; render exactly once.
Constraints: preserve the requested similarity range and brand meaning; original scene; no extra text; no watermark.
Avoid: exact source poses, objects, layout, motif arrangement, marks, slogans, and letterforms.
```

For an unusual name, spell it once in the prompt, for example `M-O-S-S-W-E-F-T`, then require the normal wordmark exactly once.

## Revise without losing the concept

When the user asks for a closer V2:

1. Use the original reference as Image 1.
2. Use the current concept as Image 2.
3. Preserve the current name and meaning.
4. Change only the similarity target and the shared visual grammar.
5. Restate all protected signature exclusions.
6. Save as a versioned sibling such as `brand-name-v2.png`; never overwrite V1 by default.

Use a targeted instruction such as:

```text
Move this concept from roughly 40% to 70% similarity to Image 1's high-level visual grammar. Keep the exact brand name, meaning, and core subject from Image 2. Increase the reference-adjacent scene density, print texture, palette relationship, theatrical staging, and wordmark scale. Create new poses, motifs, spatial arrangement, and letterforms. Do not reproduce the source composition.
```

## Validate every output

Inspect each final image and check:

- exact wordmark spelling and one occurrence only
- no extra copy or accidental marks
- brand meaning is visible without explanation
- shared family resemblance across the set
- requested similarity dial is plausible
- at least four signature elements differ from the reference
- each brand differs from the other variants in meaning, ritual, environment, and motif
- correct aspect ratio and usable resolution
- unique file and non-destructive versioning

If one check fails, iterate with one targeted change and re-inspect. Do not rewrite the entire prompt unless the concept itself is wrong.

## Save and hand off

- Persist every requested final asset in the project workspace.
- Keep generated originals in the image tool's default location and copy selected files into the project.
- Use descriptive filenames such as `kintra-movement-collective-v2.png`.
- Report the saved paths, generation mode, similarity dial, concise prompt set, validation result, and whether previous versions were preserved.
- Stage and commit only the new skill or generated assets when working in a dirty repository.

## Worked examples

Read [references/example-prompts.md](references/example-prompts.md) when generating a multi-brand set or a closer-to-reference V2. It contains the MOSSWEFT, KINTRA, NIGHTJAR, TIDETURN, and EMBERHOUSE prompt patterns.

Inspect `assets/examples/` only when visual comparison helps. Those images demonstrate a 70% adjacent-family result and are examples, not templates to copy.
