import { lazy, Suspense } from "react";

import type { NeuformBatchEffectProps } from "../neuform-isolated/NeuformBatchEffects";
import type { LaserVariantsProps, ThreeUILaserVariant } from "./LaserVariants";

export type LaserVariant = "matrix-field" | ThreeUILaserVariant;

export type LaserCollectionProps = Omit<NeuformBatchEffectProps, "mode" | "gap" | "strokeWidth"> & {
  variant?: LaserVariant;
};

const MatrixField = lazy(() =>
  import("../neuform-isolated/NeuformBatchEffects").then((module) => ({ default: module.MatrixField })),
);

const ThreeUILaserVariantRenderer = lazy(() =>
  import("./LaserVariants").then((module) => ({ default: module.LaserVariants })),
);

const FALLBACK = <div className="threeui-background laser-variant" />;

export function LaserCollection({ variant = "matrix-field", ...props }: LaserCollectionProps) {
  if (variant !== "matrix-field") {
    const laserProps = props as LaserVariantsProps;

    return (
      <Suspense fallback={FALLBACK}>
        <ThreeUILaserVariantRenderer {...laserProps} variant={variant} />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={FALLBACK}>
      <MatrixField {...props} />
    </Suspense>
  );
}
