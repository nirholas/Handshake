import { lazy, Suspense } from "react";

import type { RibbonFieldBackgroundProps } from "../ribbon-field/RibbonFieldBackground";
import type { NeuformBatchEffectProps } from "../neuform-isolated/NeuformBatchEffects";
import type { NeuformCraftEffectProps } from "../neuform-isolated/NeuformCraftEffects";
import type { NeuformIsolatedEffectProps } from "../neuform-isolated/NeuformIsolatedEffects";
import {
  PredictiveArcCanvas as PredictiveArcCore,
  type PredictiveArcCanvasProps as PredictiveArcCoreProps,
  type PredictiveArcVariant as PredictiveArcCoreVariant,
} from "./PredictiveArcCanvas";

export type PredictiveArcVariant = PredictiveArcCoreVariant | "ribbon-field" | "void-field" | "halftone-flow" | "amber-halftone";

type RibbonFieldVariantProps = RibbonFieldBackgroundProps & {
  variant: "ribbon-field";
};

type VoidFieldVariantProps = NeuformIsolatedEffectProps & {
  variant: "void-field";
};

type HalftoneFlowVariantProps = NeuformCraftEffectProps & {
  variant: "halftone-flow";
};

type AmberHalftoneVariantProps = NeuformBatchEffectProps & {
  variant: "amber-halftone";
};

export type PredictiveArcCanvasProps =
  | PredictiveArcCoreProps
  | RibbonFieldVariantProps
  | VoidFieldVariantProps
  | HalftoneFlowVariantProps
  | AmberHalftoneVariantProps;

const RibbonFieldVariant = lazy(() =>
  import("../ribbon-field/RibbonFieldBackground").then((module) => ({ default: module.RibbonFieldBackground })),
);

const VoidFieldVariant = lazy(() =>
  import("../neuform-isolated/NeuformIsolatedEffects").then((module) => ({ default: module.VoidField })),
);

const HalftoneFlowVariant = lazy(() =>
  import("../neuform-isolated/NeuformCraftEffects").then((module) => ({ default: module.HalftoneFlow })),
);

const AmberHalftoneVariant = lazy(() =>
  import("../neuform-isolated/NeuformBatchEffects").then((module) => ({ default: module.AmberHalftone })),
);

const FALLBACK = <div className="threeui-background predictive-arc" />;

export function PredictiveArcCanvas(props: PredictiveArcCanvasProps) {
  if (props.variant === "ribbon-field") {
    const { variant: _variant, ...ribbonProps } = props;
    return <Suspense fallback={FALLBACK}><RibbonFieldVariant {...ribbonProps} /></Suspense>;
  }

  if (props.variant === "void-field") {
    const { variant: _variant, ...voidProps } = props;
    return <Suspense fallback={FALLBACK}><VoidFieldVariant {...voidProps} /></Suspense>;
  }

  if (props.variant === "halftone-flow") {
    const { variant: _variant, ...halftoneProps } = props;
    return <Suspense fallback={FALLBACK}><HalftoneFlowVariant {...halftoneProps} /></Suspense>;
  }

  if (props.variant === "amber-halftone") {
    const { variant: _variant, ...amberProps } = props;
    return <Suspense fallback={FALLBACK}><AmberHalftoneVariant {...amberProps} /></Suspense>;
  }

  return <PredictiveArcCore {...props} />;
}
