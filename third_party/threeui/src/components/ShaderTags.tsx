import { useState } from "react";
import { browseTagRoutePath } from "../routes.js";
import { EllipsisIcon } from "./icons";

const COLLAPSED_TAG_COUNT = 5;

type ShaderTagsProps = {
  tags: readonly string[];
  onSearch: (query: string) => void;
};

export function ShaderTags({ tags, onSearch }: ShaderTagsProps) {
  const [expanded, setExpanded] = useState(false);
  const hasMoreTags = tags.length > COLLAPSED_TAG_COUNT;
  const visibleTags = expanded ? tags : tags.slice(0, COLLAPSED_TAG_COUNT);
  const hiddenTagCount = tags.length - COLLAPSED_TAG_COUNT;

  return (
    <>
      {visibleTags.map((tag) => (
        <a
          className="tag search-tag tag-link"
          aria-label={`Browse components tagged ${tag}`}
          href={browseTagRoutePath(tag)}
          key={tag}
          onClick={(event) => {
            event.preventDefault();
            onSearch(tag);
          }}
        >
          {tag}
        </a>
      ))}
      {hasMoreTags ? (
        <button
          type="button"
          className="tag tag-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? `Hide ${hiddenTagCount} additional tags` : `Show ${hiddenTagCount} additional tags`}
          onClick={() => setExpanded((current) => !current)}
        >
          <EllipsisIcon />
        </button>
      ) : null}
    </>
  );
}
