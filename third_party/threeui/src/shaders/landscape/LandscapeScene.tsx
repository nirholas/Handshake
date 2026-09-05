import { useEffect, useMemo, useState } from "react";

export const LANDSCAPE_VARIANTS = ["sunrise", "noon", "sunset", "night", "rain", "storm", "snow"] as const;
export type LandscapeVariant = (typeof LANDSCAPE_VARIANTS)[number];

const LANDSCAPE_STATES: Record<LandscapeVariant, { time: string; weather: string; label: string }> = {
  sunrise: { time: "morning", weather: "clear", label: "sunrise" },
  noon: { time: "noon", weather: "clear", label: "noon" },
  sunset: { time: "sunset", weather: "clear", label: "sunset" },
  night: { time: "night", weather: "clear", label: "night" },
  rain: { time: "noon", weather: "rain", label: "rain" },
  storm: { time: "sunset", weather: "storm", label: "storm" },
  snow: { time: "noon", weather: "snow", label: "snow" },
};

export type LandscapeSceneProps = {
  className?: string;
  sourceUrl?: string;
  variant?: LandscapeVariant;
};

export function LandscapeScene({
  className = "",
  sourceUrl = "/landscape.html",
  variant = "sunrise",
}: LandscapeSceneProps) {
  const [ready, setReady] = useState(false);
  const frameSource = useMemo(() => {
    const state = LANDSCAPE_STATES[variant];
    const hashIndex = sourceUrl.indexOf("#");
    const base = hashIndex >= 0 ? sourceUrl.slice(0, hashIndex) : sourceUrl;
    const hash = hashIndex >= 0 ? sourceUrl.slice(hashIndex) : "";
    const separator = base.includes("?") ? "&" : "?";
    return `${base}${separator}variant=${variant}&time=${state.time}&weather=${state.weather}${hash}`;
  }, [sourceUrl, variant]);

  useEffect(() => setReady(false), [frameSource]);

  return (
    <div
      className={`landscape-scene${className ? ` ${className}` : ""}`}
      data-state={ready ? "ready" : "loading"}
      data-variant={variant}
    >
      <iframe
        key={variant}
        className={`landscape-scene__frame${ready ? " is-ready" : ""}`}
        title={`Procedural landscape at ${LANDSCAPE_STATES[variant].label}`}
        src={frameSource}
        sandbox="allow-scripts"
        loading="eager"
        onLoad={() => setReady(true)}
      />
    </div>
  );
}
