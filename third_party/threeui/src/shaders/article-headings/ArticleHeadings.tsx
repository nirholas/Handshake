import { useEffect, useRef } from "react";
import { startArticleHeadingDecode } from "./articleHeadingDecode";

export type ArticleHeadingsProps = {
  mode?: "dark" | "light";
  duration?: number;
  stagger?: number;
  scrambleLength?: number;
  preserveChance?: number;
  tailChance?: number;
  className?: string;
};

export const ARTICLE_HEADINGS_DEFAULTS = {
  mode: "dark",
  duration: 560,
  stagger: 140,
  scrambleLength: 10,
  preserveChance: 0.3,
  tailChance: 0.18,
} as const;

export function ArticleHeadings({ mode = ARTICLE_HEADINGS_DEFAULTS.mode, className = "", ...props }: ArticleHeadingsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const safeMode = mode === "light" ? "light" : "dark";
  const options = { ...ARTICLE_HEADINGS_DEFAULTS, ...props };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    return startArticleHeadingDecode(root, options);
  }, [options.duration, options.preserveChance, options.scrambleLength, options.stagger, options.tailChance]);

  return (
    <div
      ref={rootRef}
      className={`article-headings-component article-headings-component--${safeMode}${className ? ` ${className}` : ""}`}
      data-mode={safeMode}
    >
      <div className="article-headings-component__header">
        <span>FIELD NOTES</span>
        <span>02 ENTRIES</span>
      </div>
      <article className="article-headings-component__entry">
        <span className="article-headings-component__index">01</span>
        <h2 data-article-heading>Context Is Infrastructure, Not a Prompt</h2>
        <span className="article-headings-component__meta">SYSTEMS NOTE · 8 MIN</span>
      </article>
      <article className="article-headings-component__entry">
        <span className="article-headings-component__index">02</span>
        <h2 data-article-heading>The Last Mile Is Verification</h2>
        <span className="article-headings-component__meta">FIELD GUIDE · 11 MIN</span>
      </article>
    </div>
  );
}
