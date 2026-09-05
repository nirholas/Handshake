import { useState, type CSSProperties } from "react";

const KOI_STUDIES_SOURCE_URL = "/synthralos-halftone.html";

export type KoiStudiesProps = {
  className?: string;
  style?: CSSProperties;
};

export function KoiStudies({ className = "", style }: KoiStudiesProps) {
  const [ready, setReady] = useState(false);

  return (
    <div
      className={`threeui-background koi-studies${className ? ` ${className}` : ""}`}
      aria-label="Interactive stack of three Japanese koi studies"
      data-state={ready ? "ready" : "loading"}
      style={{
        position: "relative",
        overflow: "hidden",
        background: "#10100e",
        pointerEvents: "auto",
        ...style,
      }}
    >
      <iframe
        title="Koi Studies — Interactive Card Stack"
        src={KOI_STUDIES_SOURCE_URL}
        sandbox="allow-scripts"
        allow="autoplay"
        loading="eager"
        onLoad={() => setReady(true)}
        style={{
          position: "absolute",
          inset: 0,
          display: "block",
          width: "100%",
          height: "100%",
          border: 0,
          background: "#10100e",
        }}
      />
    </div>
  );
}
