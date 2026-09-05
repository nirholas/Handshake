import { lazy, Suspense } from "react";

import type { DotMatrixBackgroundProps } from "../dot-matrix/DotMatrixBackground";
import type { EmeraldHorizonBackgroundProps } from "../emerald-horizon/EmeraldHorizonBackground";
import type { NeuformBatchEffectProps } from "../neuform-isolated/NeuformBatchEffects";
import type { NeuformCraftEffectProps } from "../neuform-isolated/NeuformCraftEffects";
import type { NeuformIsolatedEffectProps } from "../neuform-isolated/NeuformIsolatedEffects";
import type { OrbitalSphereBackgroundProps } from "../orbital-sphere/OrbitalSphereBackground";
import type { StructureFlowBackgroundProps } from "./StructureFlowBackground";

export const STRUCTURE_FLOW_VARIANTS = [
  "structure-flow",
  "emerald-horizon",
  "orbital-sphere",
  "dot-matrix",
  "expanse-field",
  "logic-core",
  "dimensional-field",
  "data-field",
  "topology-field",
  "nebula",
  "fluid-field",
  "ember-storm",
  "flux-vortex",
] as const;

export type StructureFlowVariant = (typeof STRUCTURE_FLOW_VARIANTS)[number];

type StructureVariantProps = StructureFlowBackgroundProps & { variant?: "structure-flow" };
type EmeraldVariantProps = EmeraldHorizonBackgroundProps & { variant: "emerald-horizon" };
type OrbitalVariantProps = OrbitalSphereBackgroundProps & { variant: "orbital-sphere" };
type DotMatrixVariantProps = DotMatrixBackgroundProps & { variant: "dot-matrix" };
type IsolatedVariantProps = NeuformIsolatedEffectProps & {
  variant: "expanse-field" | "logic-core" | "dimensional-field" | "data-field" | "topology-field";
};
type CraftVariantProps = NeuformCraftEffectProps & {
  variant: "nebula" | "fluid-field" | "ember-storm";
};
type FluxVariantProps = NeuformBatchEffectProps & { variant: "flux-vortex" };

export type StructureFlowCollectionProps =
  | StructureVariantProps
  | EmeraldVariantProps
  | OrbitalVariantProps
  | DotMatrixVariantProps
  | IsolatedVariantProps
  | CraftVariantProps
  | FluxVariantProps;

const StructureVariant = lazy(() =>
  import("./StructureFlowBackground").then((module) => ({ default: module.StructureFlowBackground })),
);
const EmeraldVariant = lazy(() =>
  import("../emerald-horizon/EmeraldHorizonBackground").then((module) => ({ default: module.EmeraldHorizonBackground })),
);
const OrbitalVariant = lazy(() =>
  import("../orbital-sphere/OrbitalSphereBackground").then((module) => ({ default: module.OrbitalSphereBackground })),
);
const DotMatrixVariant = lazy(() =>
  import("../dot-matrix/DotMatrixBackground").then((module) => ({ default: module.DotMatrixBackground })),
);
const ExpanseVariant = lazy(() =>
  import("../neuform-isolated/NeuformIsolatedEffects").then((module) => ({ default: module.ExpanseField })),
);
const LogicCoreVariant = lazy(() =>
  import("../neuform-isolated/NeuformIsolatedEffects").then((module) => ({ default: module.LogicCoreField })),
);
const DimensionalVariant = lazy(() =>
  import("../neuform-isolated/NeuformIsolatedEffects").then((module) => ({ default: module.DimensionalField })),
);
const DataVariant = lazy(() =>
  import("../neuform-isolated/NeuformIsolatedEffects").then((module) => ({ default: module.DataField })),
);
const TopologyVariant = lazy(() =>
  import("../neuform-isolated/NeuformIsolatedEffects").then((module) => ({ default: module.TopologyField })),
);
const NebulaVariant = lazy(() =>
  import("../neuform-isolated/NeuformCraftEffects").then((module) => ({ default: module.NebulaBackground })),
);
const FluidVariant = lazy(() =>
  import("../neuform-isolated/NeuformCraftEffects").then((module) => ({ default: module.FluidFieldBackground })),
);
const EmberVariant = lazy(() =>
  import("../neuform-isolated/NeuformCraftEffects").then((module) => ({ default: module.EmberStorm })),
);
const FluxVariant = lazy(() =>
  import("../neuform-isolated/NeuformBatchEffects").then((module) => ({ default: module.FluxVortex })),
);

const FALLBACK = <div className="threeui-background" style={{ background: "#050607" }} />;

export function StructureFlowCollection(props: StructureFlowCollectionProps) {
  if (props.variant === "emerald-horizon") {
    const { variant: _variant, ...variantProps } = props;
    return <Suspense fallback={FALLBACK}><EmeraldVariant {...variantProps} /></Suspense>;
  }
  if (props.variant === "orbital-sphere") {
    const { variant: _variant, ...variantProps } = props;
    return <Suspense fallback={FALLBACK}><OrbitalVariant {...variantProps} /></Suspense>;
  }
  if (props.variant === "dot-matrix") {
    const { variant: _variant, ...variantProps } = props;
    return <Suspense fallback={FALLBACK}><DotMatrixVariant {...variantProps} /></Suspense>;
  }
  if (props.variant === "expanse-field") {
    const { variant: _variant, ...variantProps } = props;
    return <Suspense fallback={FALLBACK}><ExpanseVariant {...variantProps} /></Suspense>;
  }
  if (props.variant === "logic-core") {
    const { variant: _variant, ...variantProps } = props;
    return <Suspense fallback={FALLBACK}><LogicCoreVariant {...variantProps} /></Suspense>;
  }
  if (props.variant === "dimensional-field") {
    const { variant: _variant, ...variantProps } = props;
    return <Suspense fallback={FALLBACK}><DimensionalVariant {...variantProps} /></Suspense>;
  }
  if (props.variant === "data-field") {
    const { variant: _variant, ...variantProps } = props;
    return <Suspense fallback={FALLBACK}><DataVariant {...variantProps} /></Suspense>;
  }
  if (props.variant === "topology-field") {
    const { variant: _variant, ...variantProps } = props;
    return <Suspense fallback={FALLBACK}><TopologyVariant {...variantProps} /></Suspense>;
  }
  if (props.variant === "nebula") {
    const { variant: _variant, ...variantProps } = props;
    return <Suspense fallback={FALLBACK}><NebulaVariant {...variantProps} /></Suspense>;
  }
  if (props.variant === "fluid-field") {
    const { variant: _variant, ...variantProps } = props;
    return <Suspense fallback={FALLBACK}><FluidVariant {...variantProps} /></Suspense>;
  }
  if (props.variant === "ember-storm") {
    const { variant: _variant, ...variantProps } = props;
    return <Suspense fallback={FALLBACK}><EmberVariant {...variantProps} /></Suspense>;
  }
  if (props.variant === "flux-vortex") {
    const { variant: _variant, ...variantProps } = props;
    return <Suspense fallback={FALLBACK}><FluxVariant {...variantProps} /></Suspense>;
  }

  const { variant: _variant, ...variantProps } = props;
  return <Suspense fallback={FALLBACK}><StructureVariant {...variantProps} /></Suspense>;
}
