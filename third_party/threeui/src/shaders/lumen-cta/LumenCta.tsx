import type { CSSProperties, MouseEventHandler } from "react";

import "./lumen-cta.css";

export type LumenCtaVariant = "primary" | "ghost";
export type LumenCtaMode = "light" | "dark";

export type LumenCtaProps = {
  variant?: LumenCtaVariant;
  mode?: LumenCtaMode;
  label?: string;
  ring?: boolean;
  hue?: number;
  saturation?: number;
  brightness?: number;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  onClick?: MouseEventHandler<HTMLButtonElement>;
  className?: string;
  style?: CSSProperties;
};

export const LUMEN_CTA_DEFAULTS = {
  variant: "primary",
  mode: "dark",
  label: "Get your card",
  ring: true,
  hue: 0,
  saturation: 1,
  brightness: 1,
} as const satisfies Required<
  Pick<LumenCtaProps, "variant" | "mode" | "label" | "ring" | "hue" | "saturation" | "brightness">
>;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function LumenCta({
  variant = LUMEN_CTA_DEFAULTS.variant,
  mode = LUMEN_CTA_DEFAULTS.mode,
  label = LUMEN_CTA_DEFAULTS.label,
  ring = LUMEN_CTA_DEFAULTS.ring,
  hue = LUMEN_CTA_DEFAULTS.hue,
  saturation = LUMEN_CTA_DEFAULTS.saturation,
  brightness = LUMEN_CTA_DEFAULTS.brightness,
  disabled = false,
  type = "button",
  onClick,
  className = "",
  style,
}: LumenCtaProps) {
  const safeVariant: LumenCtaVariant = variant === "ghost" ? "ghost" : "primary";
  const safeMode: LumenCtaMode = mode === "light" ? "light" : "dark";

  return (
    <div
      className={`lumen-cta lumen-cta--${safeMode}${className ? ` ${className}` : ""}`}
      data-variant={safeVariant}
      style={
        {
          "--lumen-cta-hue": `${clamp(hue, -180, 180)}deg`,
          "--lumen-cta-saturation": clamp(saturation, 0, 2),
          "--lumen-cta-brightness": clamp(brightness, 0.35, 1.65),
          ...style,
        } as CSSProperties
      }
    >
      <button
        className={`lumen-cta__button${safeVariant === "ghost" ? " lumen-cta__button--ghost" : ""}`}
        type={type}
        disabled={disabled}
        onClick={onClick}
      >
        {label}
        {ring ? <i className="lumen-cta__ring" aria-hidden="true" /> : null}
      </button>
    </div>
  );
}
