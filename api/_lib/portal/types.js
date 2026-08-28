// @ts-check
// The two wire shapes Portal is built on. They are contracts: the renderer, the
// GLB exporter, the MCP tool and the published SDK all read them, so a change
// here is a change to every one of those. The prose spec is specs/portal-world.md.

/**
 * @typedef {object} SiteLink
 * @property {string} href absolute http(s) URL
 * @property {string} text the anchor's visible text, trimmed
 * @property {boolean} internal same host as the page it was found on
 */

/**
 * @typedef {object} SiteImage
 * @property {string} src absolute http(s) URL
 * @property {string} alt alternative text, trimmed (may be empty)
 */

/**
 * @typedef {object} SiteSection
 * @property {string} id stable slug, unique within the outline
 * @property {1|2|3} level heading level it was opened by
 * @property {string} heading
 * @property {string} summary first prose of the section, clamped
 * @property {number} words
 * @property {number} paragraphs
 * @property {number} codeBlocks
 * @property {SiteLink[]} links
 * @property {SiteImage[]} images
 */

/**
 * @typedef {object} SiteOutline
 * @property {1} version
 * @property {string} url the URL that was fetched
 * @property {string} canonical the page's own canonical URL, or `url`
 * @property {string} host
 * @property {string} title
 * @property {string} description
 * @property {string|null} siteName
 * @property {string|null} themeColor `#rrggbb`
 * @property {string|null} image og:image
 * @property {string|null} icon
 * @property {string} lang
 * @property {SiteSection[]} sections
 * @property {{internal:number,external:number}} linkCounts
 * @property {number} words
 */

export {};
