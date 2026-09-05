import { useEffect, useMemo, useState } from "react";

export const TOWER_COUNTRIES = ["japan", "china", "vietnam", "thailand", "cambodia", "turkey"] as const;
export type TowerCountry = (typeof TOWER_COUNTRIES)[number];

const COUNTRY_LABELS: Record<TowerCountry, string> = {
  japan: "Japanese tenshu",
  china: "Chinese pagoda",
  vietnam: "Vietnamese tháp",
  thailand: "Thai prang",
  cambodia: "Khmer prasat",
  turkey: "Ottoman mosque",
};

export type JapaneseTowerLandscapeProps = {
  className?: string;
  sourceUrl?: string;
  country?: TowerCountry;
};

export function JapaneseTowerLandscape({
  className = "",
  sourceUrl = "/japanese-tower.html",
  country = "japan",
}: JapaneseTowerLandscapeProps) {
  const [ready, setReady] = useState(false);
  const frameSource = useMemo(() => {
    const hashIndex = sourceUrl.indexOf("#");
    const base = hashIndex >= 0 ? sourceUrl.slice(0, hashIndex) : sourceUrl;
    const hash = hashIndex >= 0 ? sourceUrl.slice(hashIndex) : "";
    return `${base}${base.includes("?") ? "&" : "?"}country=${country}${hash}`;
  }, [country, sourceUrl]);

  useEffect(() => setReady(false), [frameSource]);

  return (
    <div
      className={`japanese-tower-landscape${className ? ` ${className}` : ""}`}
      data-state={ready ? "ready" : "loading"}
    >
      <iframe
        key={country}
        className={`japanese-tower-landscape__frame${ready ? " is-ready" : ""}`}
        title={`${COUNTRY_LABELS[country]} in a procedural landscape`}
        src={frameSource}
        sandbox="allow-scripts"
        loading="eager"
        onLoad={() => setReady(true)}
      />
    </div>
  );
}
