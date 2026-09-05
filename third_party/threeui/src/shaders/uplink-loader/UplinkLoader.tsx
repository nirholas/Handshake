import { useState, type CSSProperties } from "react";

import uplinkLoaderSource from "./uplink-loader.html?raw";

export type UplinkLoaderProps = {
  className?: string;
  style?: CSSProperties;
};

export function UplinkLoader({ className = "", style }: UplinkLoaderProps) {
  const [ready, setReady] = useState(false);

  return (
    <div
      className={`uplink-loader${className ? ` ${className}` : ""}`}
      data-state={ready ? "ready" : "loading"}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        background: "#030806",
        ...style,
      }}
    >
      <iframe
        title="SYS.LINK uplink progress loader"
        srcDoc={uplinkLoaderSource}
        sandbox="allow-scripts"
        loading="eager"
        onLoad={() => setReady(true)}
        style={{
          position: "absolute",
          inset: 0,
          display: "block",
          width: "100%",
          height: "100%",
          border: 0,
          background: "#030806",
        }}
      />
    </div>
  );
}
