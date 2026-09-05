import { useMemo, useState } from "react";
import { createSketchbookDocument } from "./sketchbookDocument.js";

export type SketchbookProps = {
  assetBaseUrl?: string;
  className?: string;
};

export function Sketchbook({
  assetBaseUrl = "/sketchbook/",
  className = "",
}: SketchbookProps) {
  const [ready, setReady] = useState(false);
  const documentSource = useMemo(() => createSketchbookDocument(assetBaseUrl), [assetBaseUrl]);

  return (
    <div className={`sketchbook${className ? ` ${className}` : ""}`} data-state={ready ? "ready" : "loading"}>
      <iframe
        className={`sketchbook__frame${ready ? " is-ready" : ""}`}
        title="Interactive Singapore sketchbook"
        srcDoc={documentSource}
        sandbox="allow-scripts"
        loading="eager"
        onLoad={() => setReady(true)}
      />
    </div>
  );
}
