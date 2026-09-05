import { useMemo, useState, type CSSProperties } from "react";
import {
  CATALOG_RESULTS,
  catalogResultId,
  catalogResultLabel,
  catalogResultMatchesQuery,
  createCatalogResults,
} from "../data/catalogResults";
import type { ReadyShader } from "../data/shaders";
import { sortCatalogResultsByPopularity } from "../catalogPresentation.js";
import { BROWSE_CATEGORIES, browseRouteContent } from "../browseTaxonomy.js";
import {
  browseCategoryRoutePath,
  browseTagRoutePath,
  shaderRoutePath,
  STATIC_ROUTE_PATHS,
} from "../routes.js";
import { RECENT_SHADERS } from "./Sidebar";
import "./browse-sort-toggle.css";
import { SearchIcon } from "./icons";

type BrowsePageProps = {
  activeCategory?: ReadyShader["category"];
  activeTag?: string;
  onCategorySelect: (category?: ReadyShader["category"]) => void;
  onSelect: (id: ReadyShader["id"], variantId?: string) => void;
  onTagSelect: (tag: string) => void;
};

const MAX_VISIBLE_TAGS = 3;

const BROWSE_SORT_MODES = [
  { id: "popular", label: "Popular" },
  { id: "recent", label: "Recent" },
] as const;

type BrowseSortMode = (typeof BROWSE_SORT_MODES)[number]["id"];

// Public-safe snapshot of the live Popular ordering. The Community mirror
// keeps the same control without shipping Supabase, auth, keys, or private APIs.
const COMMUNITY_POPULAR_SHADER_IDS = [
  "sylva-hero",
  "meng-to-sketchbook-landing-page",
  "kage-landing-page",
  "complete-shelf-landing-page",
  "predictive-arc",
  "sylva-living-world",
  "structure-flow",
  "koi-studies",
  "japanese-tower",
  "character-carousel",
  "bestsellers-book-showcase",
  "circle-buttons",
  "brand-orbs",
  "energy-orb",
  "crt",
  "temple-night",
  "rectangle-buttons",
] as const;
const COMMUNITY_POPULARITY = Object.fromEntries(COMMUNITY_POPULAR_SHADER_IDS.map((id, index) => [
  id,
  { views: COMMUNITY_POPULAR_SHADER_IDS.length - index, copies: 0 },
]));

export const SITE_TITLE = "Procedural Three.js web design templates for agents";
export const SITE_DESCRIPTION = "Fully customizable. Copyable as prompts.";

const RECENT_SHADER_IDS = new Set<ReadyShader["id"]>(RECENT_SHADERS.map((shader) => shader.id));
const BROWSE_RESULTS = [
  ...createCatalogResults(RECENT_SHADERS),
  ...CATALOG_RESULTS.filter(({ shader }) => !RECENT_SHADER_IDS.has(shader.id)),
];

export function BrowsePage({ activeCategory, activeTag, onCategorySelect, onSelect, onTagSelect }: BrowsePageProps) {
  const [query, setQuery] = useState("");
  const [activePreview, setActivePreview] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<BrowseSortMode>("popular");
  const visibleBrowseResults = useMemo(
    () => sortMode === "recent"
      ? BROWSE_RESULTS
      : sortCatalogResultsByPopularity(BROWSE_RESULTS, COMMUNITY_POPULARITY),
    [sortMode],
  );
  const filteredResults = useMemo(
    () => visibleBrowseResults.filter((result) => (
      (!activeCategory || result.shader.category === activeCategory)
      && (!activeTag || result.shader.tags.includes(activeTag))
      && catalogResultMatchesQuery(result, query)
    )),
    [activeCategory, activeTag, query, visibleBrowseResults],
  );
  const routeResultCount = BROWSE_RESULTS.filter(({ shader }) => (
    (!activeCategory || shader.category === activeCategory)
    && (!activeTag || shader.tags.includes(activeTag))
  )).length;
  const pageContent = browseRouteContent({ browseCategory: activeCategory, browseTag: activeTag }, routeResultCount);

  const beginPreview = (id: string) => {
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) setActivePreview(id);
  };

  return (
    <main className="browse-page" aria-labelledby="browse-title">
      <header className="browse-header">
        <div className="browse-heading-row">
          <div>
            <h1 id="browse-title">{pageContent.heading}</h1>
            <p className="lede">{pageContent.description}</p>
            {activeTag ? (
              <a
                className="browse-active-filter"
                href={STATIC_ROUTE_PATHS.browse}
                onClick={(event) => {
                  event.preventDefault();
                  onCategorySelect();
                }}
              >
                Tagged {activeTag} <span aria-hidden="true">×</span>
              </a>
            ) : null}
          </div>
        </div>
        <div className="browse-controls-row">
          <div className="browse-category-filters" role="group" aria-label="Filter components by category">
            {(BROWSE_CATEGORIES as readonly ReadyShader["category"][]).map((category) => {
              const isActive = activeCategory === category;
              const href = isActive ? STATIC_ROUTE_PATHS.browse : browseCategoryRoutePath(category);
              return (
                <a
                  key={category}
                  aria-current={isActive ? "page" : undefined}
                  href={href}
                  title={isActive ? "Show all categories" : `Filter by ${category}`}
                  onClick={(event) => {
                    event.preventDefault();
                    onCategorySelect(isActive ? undefined : category);
                    setActivePreview(null);
                  }}
                >
                  {category}
                </a>
              );
            })}
          </div>
          <div className="browse-search-controls">
            <label className="browse-filter">
              <SearchIcon />
              <input
                type="search"
                value={query}
                placeholder={`Search ${routeResultCount} components`}
                aria-label={`Search ${routeResultCount} components`}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActivePreview(null);
                }}
              />
            </label>
            <div className="browse-sort-toggle" role="group" aria-label="Sort components">
              {BROWSE_SORT_MODES.map((mode) => (
                <button
                  type="button"
                  key={mode.id}
                  aria-pressed={sortMode === mode.id}
                  onClick={() => {
                    setSortMode(mode.id);
                    setActivePreview(null);
                  }}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      {filteredResults.length ? (
        <div className="browse-grid">
          {filteredResults.map(({ shader, variant }, index) => {
            const result = { shader, variant };
            const resultId = catalogResultId(result);
            const label = catalogResultLabel(result);
            const thumbnail = variant?.thumbnail ?? shader.thumbnail;
            const preview = (
              variant?.preview ?? ("preview" in shader && typeof shader.preview === "string"
                ? shader.preview
                : undefined)
            ) ?? `/previews/${shader.id}.webm`;
            return (
              <article className="browse-item" key={resultId} style={{ "--browse-index": index } as CSSProperties}>
                <a
                  className="browse-item-link"
                  href={shaderRoutePath(shader, variant?.id)}
                  aria-label={`${label}. ${shader.tags.slice(0, MAX_VISIBLE_TAGS).join(", ")}. Community component.`}
                  onPointerEnter={() => beginPreview(resultId)}
                  onPointerLeave={() => setActivePreview(null)}
                  onFocus={() => beginPreview(resultId)}
                  onBlur={() => setActivePreview(null)}
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    onSelect(shader.id, variant?.id);
                  }}
                >
                  <span className="browse-media" aria-hidden="true">
                    <img src={thumbnail} alt="" width="640" height="360" loading={index < 6 ? "eager" : "lazy"} decoding="async" />
                    {activePreview === resultId ? (
                      <video
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
                  <span className="browse-details">
                    <span className="browse-title-row">
                      <strong>{label}</strong>
                    </span>
                  </span>
                </a>
                <nav className="browse-tags" aria-label={`${label} tags`}>
                  {shader.tags.slice(0, MAX_VISIBLE_TAGS).map((tag) => (
                    <a
                      href={browseTagRoutePath(tag)}
                      key={tag}
                      onClick={(event) => {
                        event.preventDefault();
                        onTagSelect(tag);
                        setActivePreview(null);
                      }}
                    >
                      {tag}
                    </a>
                  ))}
                </nav>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="browse-empty" role="status">
          <strong>{query ? `No components match “${query}”.` : "No components match this category."}</strong>
          <span>Try another title, tag, category, or technology.</span>
        </div>
      )}
    </main>
  );
}
