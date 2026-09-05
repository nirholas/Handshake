import { lazy, Suspense } from "react";

import type { BellFieldBackgroundProps } from "../bell-field/BellFieldBackground";
import type { NeuformBatchEffectProps } from "../neuform-isolated/NeuformBatchEffects";
import type { NeuformIsolatedEffectProps } from "../neuform-isolated/NeuformIsolatedEffects";
import type { StreamConvergenceBackgroundProps } from "../stream-convergence/StreamConvergenceBackground";

export type PortalFieldVariant =
  | "portal-field"
  | "flow-field"
  | "cloud-field"
  | "bell-field"
  | "stream-convergence";

type PortalVariantProps = NeuformBatchEffectProps & {
  variant?: "portal-field";
};

type FlowVariantProps = NeuformBatchEffectProps & {
  variant: "flow-field";
};

type CloudVariantProps = NeuformIsolatedEffectProps & {
  variant: "cloud-field";
};

type BellVariantProps = BellFieldBackgroundProps & {
  variant: "bell-field";
};

type StreamVariantProps = StreamConvergenceBackgroundProps & {
  variant: "stream-convergence";
};

export type PortalFieldCollectionProps =
  | PortalVariantProps
  | FlowVariantProps
  | CloudVariantProps
  | BellVariantProps
  | StreamVariantProps;

const PortalVariant = lazy(() =>
  import("../neuform-isolated/NeuformBatchEffects").then((module) => ({ default: module.PortalField })),
);

const FlowVariant = lazy(() =>
  import("../neuform-isolated/NeuformBatchEffects").then((module) => ({ default: module.FlowField })),
);

const CloudVariant = lazy(() =>
  import("../neuform-isolated/NeuformIsolatedEffects").then((module) => ({ default: module.CloudField })),
);

const BellVariant = lazy(() =>
  import("../bell-field/BellFieldBackground").then((module) => ({ default: module.BellFieldBackground })),
);

const StreamVariant = lazy(() =>
  import("../stream-convergence/StreamConvergenceBackground").then((module) => ({ default: module.StreamConvergenceBackground })),
);

const FALLBACK = <div className="threeui-background portal-field" />;

export function PortalFieldCollection(props: PortalFieldCollectionProps) {
  if (props.variant === "flow-field") {
    const { variant: _variant, ...variantProps } = props;
    return <Suspense fallback={FALLBACK}><FlowVariant {...variantProps} /></Suspense>;
  }

  if (props.variant === "cloud-field") {
    const { variant: _variant, ...variantProps } = props;
    return <Suspense fallback={FALLBACK}><CloudVariant {...variantProps} /></Suspense>;
  }

  if (props.variant === "bell-field") {
    const { variant: _variant, ...variantProps } = props;
    return <Suspense fallback={FALLBACK}><BellVariant {...variantProps} /></Suspense>;
  }

  if (props.variant === "stream-convergence") {
    const { variant: _variant, ...variantProps } = props;
    return <Suspense fallback={FALLBACK}><StreamVariant {...variantProps} /></Suspense>;
  }

  const { variant: _variant, ...variantProps } = props;
  return <Suspense fallback={FALLBACK}><PortalVariant {...variantProps} /></Suspense>;
}
