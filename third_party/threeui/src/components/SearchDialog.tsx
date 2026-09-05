import { useEffect, useMemo, useRef, useState } from "react";
import {
  CATALOG_RESULTS,
  catalogResultId,
  catalogResultLabel,
  catalogResultMatchesQuery,
  type CatalogResult,
} from "../data/catalogResults";
import type { ReadyShader } from "../data/shaders";
import { SearchIcon } from "./icons";

type SearchDialogProps = {
  open: boolean;
  initialQuery?: string;
  onClose: () => void;
  onSelect: (id: ReadyShader["id"], variantId?: string) => void;
};

type SearchResultTooltip = {
  result: CatalogResult;
  left: number;
  top: number;
  side: "top" | "bottom";
};

const TOOLTIP_WIDTH = 280;
const TOOLTIP_HEIGHT = 96;
const TOOLTIP_GAP = 10;
const TOOLTIP_DISMISS_DELAY = 180;
const MAX_TOOLTIP_TAGS = 5;

function tooltipId(id: string) {
  return `search-result-tooltip-${id}`;
}

export function SearchDialog({ open, initialQuery = "", onClose, onSelect }: SearchDialogProps) {
  const [query, setQuery] = useState("");
  const [activePreview, setActivePreview] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<SearchResultTooltip | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dismissTimerRef = useRef<number | undefined>(undefined);
  const results = useMemo(
    () => CATALOG_RESULTS.filter((result) => catalogResultMatchesQuery(result, query)),
    [query],
  );

  const cancelDismiss = () => {
    if (dismissTimerRef.current === undefined) return;
    window.clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = undefined;
  };

  const dismissResult = (id: string) => {
    setActivePreview((current) => current === id ? null : current);
    setTooltip((current) => current && catalogResultId(current.result) === id ? null : current);
  };

  const scheduleDismiss = (id: string) => {
    cancelDismiss();
    dismissTimerRef.current = window.setTimeout(() => {
      dismissTimerRef.current = undefined;
      dismissResult(id);
    }, TOOLTIP_DISMISS_DELAY);
  };

  useEffect(() => {
    cancelDismiss();
    if (!open) {
      setActivePreview(null);
      setTooltip(null);
      return;
    }
    setQuery(initialQuery);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [initialQuery, open]);

  useEffect(() => () => cancelDismiss(), []);

  const beginPreview = (id: string) => {
    cancelDismiss();
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) setActivePreview(id);
  };

  const showTooltip = (result: CatalogResult, trigger: HTMLButtonElement) => {
    cancelDismiss();
    const dialog = dialogRef.current;
    if (!dialog) return;
    const triggerRect = trigger.getBoundingClientRect();
    const dialogRect = dialog.getBoundingClientRect();
    const side = triggerRect.top - dialogRect.top >= TOOLTIP_HEIGHT + TOOLTIP_GAP ? "top" : "bottom";
    const halfWidth = Math.min(TOOLTIP_WIDTH, dialogRect.width - 24) / 2;
    const centeredLeft = triggerRect.left + triggerRect.width / 2 - dialogRect.left;
    const left = Math.min(dialogRect.width - halfWidth - 12, Math.max(halfWidth + 12, centeredLeft));
    const top = side === "top"
      ? triggerRect.top - dialogRect.top - TOOLTIP_GAP
      : triggerRect.bottom - dialogRect.top + TOOLTIP_GAP;
    setTooltip({ result, left, top, side });
  };

  if (!open) return null;
  return (
    <>
      <button className="scrim open" aria-label="Close search" onClick={onClose} />
      <div ref={dialogRef} className="dialog card open" role="dialog" aria-modal="true" aria-label="Search verified shaders">
        <div className="field">
          <SearchIcon width={18} height={18} style={{ opacity: 0.6 }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              if (event.key === "Enter" && results[0]) onSelect(results[0].shader.id, results[0].variant?.id);
            }}
            placeholder="Search shaders..."
            autoComplete="off"
            spellCheck={false}
          />
          <kbd>ESC</kbd>
        </div>
        <div className="results" onScroll={() => {
          cancelDismiss();
          setActivePreview(null);
          setTooltip(null);
        }}>
          {results.length ? (
            results.map((result) => {
              const { shader, variant } = result;
              const resultId = catalogResultId(result);
              const label = catalogResultLabel(result);
              const description = variant?.description ?? shader.description;
              const thumbnail = variant?.thumbnail ?? shader.thumbnail;
              const preview = variant?.preview ?? shader.preview ?? `/previews/${shader.id}.webm`;
              return (
                <button
                  key={resultId}
                  aria-label={`${label}: ${description} ${shader.category}, ${shader.runtime}. Tags: ${shader.tags.join(", ")}`}
                  aria-describedby={tooltip && catalogResultId(tooltip.result) === resultId ? tooltipId(resultId) : undefined}
                  onMouseEnter={(event) => {
                    beginPreview(resultId);
                    showTooltip(result, event.currentTarget);
                  }}
                  onMouseLeave={() => scheduleDismiss(resultId)}
                  onFocus={(event) => {
                    beginPreview(resultId);
                    showTooltip(result, event.currentTarget);
                  }}
                  onBlur={() => scheduleDismiss(resultId)}
                  onClick={() => onSelect(shader.id, variant?.id)}
                >
                  <span className="search-result-thumbnail" aria-hidden="true">
                    <img src={thumbnail} alt="" width="320" height="180" decoding="async" />
                    {activePreview === resultId ? (
                      <video
                        className="search-result-preview-video"
                        src={preview}
                        poster={thumbnail}
                        muted
                        loop
                        playsInline
                        autoPlay
                        preload="metadata"
                        tabIndex={-1}
                        onLoadedData={(event) => {
                          event.currentTarget.dataset.ready = "true";
                          void event.currentTarget.play().catch(() => undefined);
                        }}
                      />
                    ) : null}
                  </span>
                </button>
              );
            })
          ) : (
            <div className="empty">No verified shader found.</div>
          )}
        </div>
        {tooltip ? (
          <div
            id={tooltipId(catalogResultId(tooltip.result))}
            className="search-result-tooltip"
            data-side={tooltip.side}
            role="tooltip"
            style={{ left: tooltip.left, top: tooltip.top }}
            onMouseEnter={cancelDismiss}
            onMouseLeave={() => scheduleDismiss(catalogResultId(tooltip.result))}
          >
            <div className="search-result-tooltip-title">
              <strong>{catalogResultLabel(tooltip.result)}</strong>
            </div>
            <div className="search-result-tooltip-tags" aria-label="Tags">
              {tooltip.result.shader.tags.slice(0, MAX_TOOLTIP_TAGS).map((tag) => <span key={tag}>{tag}</span>)}
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
