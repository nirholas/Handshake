function sliceAt(source, marker, label) {
  const index = source.indexOf(marker);
  if (index < 0) throw new Error(`Could not isolate ${label}; missing ${marker}.`);
  return index;
}

function assertIncludes(source, markers, label) {
  for (const marker of markers) {
    if (!source.includes(marker)) throw new Error(`${label} dropped required Community source: ${marker}.`);
  }
}

function assertExcludes(source, markers, label) {
  for (const marker of markers) {
    if (source.includes(marker)) throw new Error(`${label} retained excluded source: ${marker}.`);
  }
}

export function sanitizeSectionElementsModule(source) {
  const workflowStart = sliceAt(source, "\nconst orbitIcons = [", "the Workflow Beta module boundary");
  const communitySectionsStart = sliceAt(source, "\nexport function EditorialIntroSection", "the Community Section Elements module boundary");
  const proStart = sliceAt(source, "\nfunction ArrowIcon()", "the Section Elements Pro module boundary");
  const imports = source.slice(0, workflowStart).replace(/^const bentoQr = .*\n/m, "");
  const result = `${imports.trimEnd()}\n${source.slice(communitySectionsStart, proStart).trimEnd()}\n`;

  assertIncludes(
    result,
    ["EditorialIntroSection", "NewsletterFooterSection"],
    "Section Elements module sanitization",
  );
  assertExcludes(
    result,
    ["WorkflowSection", "bento-11-qr", "HeroBannerSection", "TestimonialWallSection", "PricingTiersSection", "ContactPanelSection", "AgentHarnessSection", "GenerativeStudioSection"],
    "Section Elements module sanitization",
  );
  return result;
}

export function sanitizeSectionElementsCss(source) {
  const withoutFonts = source
    .replace(/@font-face \{[\s\S]*?\}\s*/g, "")
    .replace('"Section SF", -apple-system', "-apple-system");
  const workflowStart = sliceAt(withoutFonts, "\n.section-element--workflow {", "the Workflow Beta style boundary");
  const communitySectionsStart = sliceAt(withoutFonts, "\n.section-element--testimonial-intro {", "the Community Section Elements style boundary");
  const proStart = sliceAt(withoutFonts, "\n.hero-banner__copy h2,", "the Section Elements Pro style boundary");
  const editorialHeading = withoutFonts
    .slice(workflowStart, communitySectionsStart)
    .match(/\n\.onboarding-steps__head h2,\n\.editorial-intro h2 \{[\s\S]*?\n\}/)?.[0]
    .replace("\n.onboarding-steps__head h2,", "");
  if (!editorialHeading) throw new Error("Could not retain the Community editorial heading styles.");
  const communitySections = withoutFonts
    .slice(communitySectionsStart, proStart)
    .replace(/\n  \.section-element--workflow \{[\s\S]*?\n  \}\n/g, "")
    .replace(/\n  \.onboarding-steps__(?:head|card-inner) \{[\s\S]*?\n  \}\n/g, "");
  const result = `${withoutFonts.slice(0, workflowStart).trimEnd()}\n${editorialHeading.trim()}\n${communitySections.trimEnd()}\n`;

  assertIncludes(
    result,
    [".editorial-intro__copy", ".newsletter-footer__row"],
    "Section Elements style sanitization",
  );
  assertExcludes(
    result,
    ["section-element--workflow", "onboarding-steps", "section-pairing", "function-keys", "phone-sync", "hero-banner", "testimonial-wall", "pricing-tiers", "contact-panel", "agent-editor", "agent-harness", "generative-"],
    "Section Elements style sanitization",
  );
  if (/Section SF|sf-(?:bold|light|medium|regular|semibold)\.woff2/.test(result)) {
    throw new Error("Section Elements font sanitization retained a restricted font reference.");
  }
  return result;
}

export function sanitizeNeuformIsolatedEffects(source) {
  const recursiveStart = sliceAt(source, "\n/* ------------------------------------------------------------------ *\n   Recursive Erosion styles", "the Recursive Erosion Pro module boundary");
  const recursiveEnd = sliceAt(source, "\nfunction transformEpiludeWordmarkSource", "the Community effect transforms after Recursive Erosion");
  const result = `${source.slice(0, recursiveStart)}${source.slice(recursiveEnd)}`
    .replace(/^import particleOrbSource from "\.\/sources\/synthesis-orb\.html\?raw";\n/m, "")
    .replace(/^import recursiveErosionSource from "\.\/sources\/recursive-erosion\.html\?raw";\n/m, "")
    .replace(/\n  particleOrb: \{[\s\S]*?\n  \},\n  performanceGaugesTachometer:/, "\n  performanceGaugesTachometer:")
    .replace(/\n  recursiveErosion: \{[\s\S]*?\n  \},\n  threeUIIntro:/, "\n  threeUIIntro:")
    .replace(/^export const ParticleOrbField = createEffectComponent\(EFFECTS\.particleOrb\);\n/m, "")
    .replace(/\nexport function RecursiveErosionBackground\(\{[\s\S]*?\n\}\nexport const ThreeUIIntro/, "\nexport const ThreeUIIntro");

  assertIncludes(result, ["PerformanceGauges", "ThreeUIIntro", "GradientCollection"], "Neuform isolation sanitization");
  assertExcludes(
    result,
    ["particleOrb", "synthesis-orb", "recursiveErosion", "RecursiveErosion", "RECURSIVE_EROSION", "recursive-erosion"],
    "Neuform isolation sanitization",
  );
  return result;
}
