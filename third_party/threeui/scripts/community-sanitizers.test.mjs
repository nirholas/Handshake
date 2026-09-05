import assert from "node:assert/strict";
import { test } from "node:test";

import { sanitizeNeuformIsolatedEffects, sanitizeSectionElementsCss, sanitizeSectionElementsModule } from "./community-sanitizers.mjs";

test("Section Elements module keeps Community renderers and removes Beta and Pro renderers", () => {
  const source = `import { useState } from "react";
const bentoQr = new URL("./assets/bento-11-qr.svg", import.meta.url).href;
const testimonialIllustration = "illustration";

const orbitIcons = [];
function StepsComposition() {}
function FunctionKeysIllustration() {}
function PhoneSyncIllustration() {}
export function WorkflowSection() {}

export function EditorialIntroSection() {}
export function NewsletterFooterSection() {}

function ArrowIcon() {}
export function HeroBannerSection() {}
export function TestimonialWallSection() {}
export function PricingTiersSection() {}
export function ContactPanelSection() {}
export function AgentHarnessSection() {}
export function GenerativeStudioSection() {}
`;

  const result = sanitizeSectionElementsModule(source);
  assert.match(result, /export function EditorialIntroSection/);
  assert.match(result, /export function NewsletterFooterSection/);
  assert.doesNotMatch(result, /WorkflowSection|bento-11-qr|HeroBannerSection|AgentHarnessSection|GenerativeStudioSection/);
});

test("Section Elements styles retain Community sections without Beta, Pro, or restricted font styles", () => {
  const source = `@font-face { font-family: "Section SF"; src: url("./assets/sf-regular.woff2"); }
.section-element { font-family: "Section SF", -apple-system, sans-serif; }
.section-element--workflow {}
.onboarding-steps__head h2,
.editorial-intro h2 {
  color: white;
}
.section-pairing {}

.section-element--testimonial-intro {}
.editorial-intro__copy {}
.newsletter-footer__row {}

@container (max-width: 720px) {
  .section-element--workflow {
    padding-inline: 14px;
  }

  .onboarding-steps__card-inner {
    padding-bottom: 12px;
  }

  .newsletter-footer__row {
    gap: 18px;
  }
}

.hero-banner__copy h2,
.testimonial-wall__head h2 {}
.agent-editor {}
.generative-image {}
`;

  const result = sanitizeSectionElementsCss(source);
  assert.match(result, /\.editorial-intro__copy/);
  assert.match(result, /\.newsletter-footer__row/);
  assert.doesNotMatch(result, /section-element--workflow|onboarding-steps|section-pairing|hero-banner|testimonial-wall|agent-editor|generative-|Section SF|sf-regular/);
});

test("Section Elements sanitizers fail closed when a boundary moves", () => {
  assert.throws(() => sanitizeSectionElementsModule("export function WorkflowSection() {}"), /missing/);
  assert.throws(() => sanitizeSectionElementsCss(".onboarding-steps__head {}"), /missing/);
});

test("Neuform isolation removes Beta Particle Orb and Pro Recursive Erosion", () => {
  const source = `import recursiveErosionSource from "./sources/recursive-erosion.html?raw";
import particleOrbSource from "./sources/synthesis-orb.html?raw";

function PerformanceGauges() {}

/* ------------------------------------------------------------------ *
   Recursive Erosion styles
 * ------------------------------------------------------------------ */
const RECURSIVE_EROSION_DEFAULTS = {};
function transformRecursiveErosionSource() {}

function transformEpiludeWordmarkSource() {}
const EFFECTS = {
  particleOrb: {
    source: particleOrbSource,
  },
  performanceGaugesTachometer: {},
  recursiveErosion: {
    source: recursiveErosionSource,
  },
  threeUIIntro: {},
};
export const ParticleOrbField = createEffectComponent(EFFECTS.particleOrb);
export function RecursiveErosionBackground({}) {
  return recursiveErosionSource;
}
export const ThreeUIIntro = createEffectComponent(EFFECTS.threeUIIntro);
export function GradientCollection() {}
`;

  const result = sanitizeNeuformIsolatedEffects(source);
  assert.match(result, /function PerformanceGauges/);
  assert.match(result, /export const ThreeUIIntro/);
  assert.match(result, /export function GradientCollection/);
  assert.doesNotMatch(result, /particleOrb|synthesis-orb|recursiveErosion|RecursiveErosion|RECURSIVE_EROSION|recursive-erosion/);
});
