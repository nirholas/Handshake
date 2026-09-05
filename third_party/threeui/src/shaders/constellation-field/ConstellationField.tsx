import type { ComponentType } from "react";

import {
  ConstellationField as ConstellationFieldRenderer,
  ConnectivityGraph,
  DefenseLines,
  GatewayFlow,
  InterfaceLines,
  ParticleDrift,
  ParticleNetwork,
  TopoField,
  type NeuformBatchEffectProps,
} from "../neuform-isolated/NeuformBatchEffects";

export type ConstellationFieldVariant =
  | "constellation-field"
  | "particle-drift"
  | "particle-network"
  | "gateway-flow"
  | "connectivity-graph"
  | "interface-lines"
  | "defense-lines"
  | "topo-field";

export type ConstellationFieldProps = NeuformBatchEffectProps & {
  variant?: ConstellationFieldVariant;
};

const VARIANT_COMPONENTS: Record<ConstellationFieldVariant, ComponentType<NeuformBatchEffectProps>> = {
  "constellation-field": ConstellationFieldRenderer,
  "particle-drift": ParticleDrift,
  "particle-network": ParticleNetwork,
  "gateway-flow": GatewayFlow,
  "connectivity-graph": ConnectivityGraph,
  "interface-lines": InterfaceLines,
  "defense-lines": DefenseLines,
  "topo-field": TopoField,
};

export function ConstellationField({ variant = "constellation-field", ...props }: ConstellationFieldProps) {
  const Variant = VARIANT_COMPONENTS[variant];
  return <Variant {...props} />;
}
