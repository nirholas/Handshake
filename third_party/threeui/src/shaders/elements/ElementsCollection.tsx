import { lazy, Suspense } from "react";

import type { CondensationBackgroundProps } from "../condensation/CondensationBackground";
import type { ElementVariant, ElementsBackgroundProps } from "./ElementsBackground";
import type { GenerativeTreeProps } from "./GenerativeTree";

export type ElementsVariant = ElementVariant | "condensation" | "generative-tree";

type ElementVariantProps = Omit<ElementsBackgroundProps, "variant"> & {
  variant?: ElementVariant;
};

type CondensationVariantProps = CondensationBackgroundProps & {
  variant: "condensation";
};

type GenerativeTreeVariantProps = GenerativeTreeProps & {
  variant: "generative-tree";
};

export type ElementsCollectionProps = ElementVariantProps | CondensationVariantProps | GenerativeTreeVariantProps;

const ElementVariantRenderer = lazy(() =>
  import("./ElementsBackground").then((module) => ({ default: module.ElementsBackground })),
);

const CondensationVariant = lazy(() =>
  import("../condensation/CondensationBackground").then((module) => ({ default: module.CondensationBackground })),
);

const GenerativeTreeVariant = lazy(() =>
  import("./GenerativeTree").then((module) => ({ default: module.GenerativeTree })),
);

const FALLBACK = <div className="threeui-background elements" />;

export function ElementsCollection(props: ElementsCollectionProps) {
  if (props.variant === "generative-tree") {
    const { variant: _variant, ...variantProps } = props;
    return (
      <Suspense fallback={FALLBACK}>
        <GenerativeTreeVariant {...variantProps} />
      </Suspense>
    );
  }

  if (props.variant === "condensation") {
    const { variant: _variant, ...variantProps } = props;
    return (
      <Suspense fallback={FALLBACK}>
        <CondensationVariant {...variantProps} />
      </Suspense>
    );
  }

  const { variant = "water", ...variantProps } = props;
  return (
    <Suspense fallback={FALLBACK}>
      <ElementVariantRenderer {...variantProps} variant={variant} />
    </Suspense>
  );
}
