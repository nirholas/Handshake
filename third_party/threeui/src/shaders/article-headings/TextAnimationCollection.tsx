import { lazy, Suspense } from "react";

import type { ArticleHeadingsProps } from "./ArticleHeadings";
import type { NeuformCraftEffectProps } from "../neuform-isolated/NeuformCraftEffects";
import type { NeuformIsolatedEffectProps } from "../neuform-isolated/NeuformIsolatedEffects";

export type TextAnimationVariant =
  | "article-headings"
  | "neon-sign"
  | "threeui-intro"
  | "particle-wordmark"
  | "audio-wordmark";

type ArticleHeadingsVariantProps = ArticleHeadingsProps & {
  variant?: "article-headings";
};

type NeonTypographyVariantProps = NeuformCraftEffectProps & {
  variant: "neon-sign";
};

type IsolatedTextVariantProps = NeuformIsolatedEffectProps & {
  variant: "threeui-intro" | "particle-wordmark" | "audio-wordmark";
};

export type TextAnimationCollectionProps =
  | ArticleHeadingsVariantProps
  | NeonTypographyVariantProps
  | IsolatedTextVariantProps;

const ArticleHeadingsVariant = lazy(() =>
  import("./ArticleHeadings").then((module) => ({ default: module.ArticleHeadings })),
);

const NeonTypographyVariant = lazy(() =>
  import("../neuform-isolated/NeuformCraftEffects").then((module) => ({ default: module.NeonTypography })),
);

const ThreeUIIntroVariant = lazy(() =>
  import("../neuform-isolated/NeuformIsolatedEffects").then((module) => ({ default: module.ThreeUIIntro })),
);

const ParticleWordmarkVariant = lazy(() =>
  import("../neuform-isolated/NeuformIsolatedEffects").then((module) => ({ default: module.ParticleWordmark })),
);

const AudioWordmarkVariant = lazy(() =>
  import("../neuform-isolated/NeuformIsolatedEffects").then((module) => ({ default: module.AudioWordmark })),
);

const FALLBACK = <div className="threeui-background" style={{ background: "#090909" }} />;

export function TextAnimationCollection(props: TextAnimationCollectionProps) {
  if (props.variant === "neon-sign") {
    const { variant: _variant, ...variantProps } = props;
    return (
      <Suspense fallback={FALLBACK}>
        <NeonTypographyVariant {...variantProps} />
      </Suspense>
    );
  }

  if (props.variant === "threeui-intro") {
    const { variant: _variant, ...variantProps } = props;
    return (
      <Suspense fallback={FALLBACK}>
        <ThreeUIIntroVariant {...variantProps} />
      </Suspense>
    );
  }

  if (props.variant === "particle-wordmark") {
    const { variant: _variant, ...variantProps } = props;
    return (
      <Suspense fallback={FALLBACK}>
        <ParticleWordmarkVariant {...variantProps} />
      </Suspense>
    );
  }

  if (props.variant === "audio-wordmark") {
    const { variant: _variant, ...variantProps } = props;
    return (
      <Suspense fallback={FALLBACK}>
        <AudioWordmarkVariant {...variantProps} />
      </Suspense>
    );
  }

  const { variant: _variant, ...variantProps } = props;
  return (
    <Suspense fallback={FALLBACK}>
      <ArticleHeadingsVariant {...variantProps} />
    </Suspense>
  );
}
