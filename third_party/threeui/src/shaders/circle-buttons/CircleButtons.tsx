import type { CSSProperties, MouseEventHandler } from "react";

import "./circle-buttons.css";

export type CircleButtonVariant = "play" | "plus" | "mail";
export type CircleButtonMode = "light" | "dark";

export type CircleButtonsProps = {
  variant?: CircleButtonVariant;
  mode?: CircleButtonMode;
  hue?: number;
  saturation?: number;
  brightness?: number;
  ariaLabel?: string;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  onClick?: MouseEventHandler<HTMLButtonElement>;
  className?: string;
  style?: CSSProperties;
};

export const CIRCLE_BUTTON_DEFAULTS = {
  variant: "play",
  mode: "dark",
  hue: 0,
  saturation: 1,
  brightness: 1,
} as const satisfies Required<Pick<CircleButtonsProps, "variant" | "mode" | "hue" | "saturation" | "brightness">>;

const LABELS: Record<CircleButtonVariant, string> = {
  play: "Play",
  plus: "Add",
  mail: "Send mail",
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function CircleIcon({ variant }: { variant: CircleButtonVariant }) {
  if (variant === "play") {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path d="M11.75 8.7c0-1.28 1.4-2.08 2.5-1.43l12 7.3a1.66 1.66 0 0 1 0 2.86l-12 7.3a1.66 1.66 0 0 1-2.5-1.43V8.7Z" />
      </svg>
    );
  }

  if (variant === "plus") {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path d="M16 7v18M7 16h18" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <rect x="5.25" y="7.5" width="21.5" height="17" rx="3.25" />
      <path d="m7.25 10 7.35 5.72a2.26 2.26 0 0 0 2.8 0L24.75 10" />
    </svg>
  );
}

export function CircleButtons({
  variant = CIRCLE_BUTTON_DEFAULTS.variant,
  mode = CIRCLE_BUTTON_DEFAULTS.mode,
  hue = CIRCLE_BUTTON_DEFAULTS.hue,
  saturation = CIRCLE_BUTTON_DEFAULTS.saturation,
  brightness = CIRCLE_BUTTON_DEFAULTS.brightness,
  ariaLabel,
  disabled = false,
  type = "button",
  onClick,
  className,
  style,
}: CircleButtonsProps) {
  const safeVariant = variant === "plus" || variant === "mail" ? variant : "play";
  const safeMode = mode === "light" ? "light" : "dark";
  const stageStyle = {
    "--circle-button-hue": `${clamp(hue, -180, 180)}deg`,
    "--circle-button-saturation": clamp(saturation, 0, 2),
    "--circle-button-brightness": clamp(brightness, 0.35, 1.65),
    ...style,
  } as CSSProperties;

  return (
    <div
      className={`circle-buttons circle-buttons--${safeVariant} circle-buttons--${safeMode}${className ? ` ${className}` : ""}`}
      data-mode={safeMode}
      data-variant={safeVariant}
      style={stageStyle}
    >
      <div className="circle-buttons__atmosphere" aria-hidden="true" />
      <button
        className="circle-button"
        type={type}
        aria-label={ariaLabel ?? LABELS[safeVariant]}
        disabled={disabled}
        onClick={onClick}
      >
        <span className="circle-button__aura" aria-hidden="true" />
        <span className="circle-button__rim" aria-hidden="true" />
        <span className="circle-button__face" aria-hidden="true" />
        <span className="circle-button__details" aria-hidden="true">
          <i /><i /><i /><i />
          <b /><b /><b /><b />
        </span>
        <span className="circle-button__icon">
          <CircleIcon variant={safeVariant} />
        </span>
      </button>
    </div>
  );
}
