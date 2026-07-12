/**
 * learn-robinhood-chain — static site generator.
 *
 * Renders content/*.md (ordered by content/meta.json) into a fully static site
 * in docs/, ready for GitHub Pages deploy-from-branch. Zero runtime
 * dependencies ship: marked + highlight.js run here, at build time, and the
 * output is plain HTML/CSS/JS with no CDN calls.
 *
 * Run: npm run build
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'
import hljs from 'highlight.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = __dirname
const CONTENT = path.join(ROOT, 'content')
const ASSETS = path.join(ROOT, 'assets')
const OUT = path.join(ROOT, 'docs')

const SITE = {
  title: 'Learn Robinhood Chain',
  tagline: 'From zero to shipping an autonomous agent on Robinhood Chain.',
  repo: 'https://github.com/nirholas/learn-robinhood-chain',
  author: 'nirholas',
  authorUrl: 'https://x.com/nichxbt',
  home: 'https://three.ws',
  rpc: 'https://rpc.mainnet.chain.robinhood.com',
  chainId: 4663,
}

const HLJS_LANGS = new Set(['ts', 'typescript', 'js', 'javascript', 'json', 'bash', 'sh', 'shell', 'solidity', 'html', 'css', 'toml', 'yaml', 'diff'])
const LANG_ALIAS = { ts: 'typescript', js: 'javascript', sh: 'bash', shell: 'bash', text: 'plaintext', '': 'plaintext' }
const LANG_LABEL = { typescript: 'TypeScript', javascript: 'JavaScript', json: 'JSON', bash: 'bash', plaintext: 'text', solidity: 'Solidity', html: 'HTML', css: 'CSS', toml: 'TOML', yaml: 'YAML', diff: 'diff' }

/* ---------- markdown → html ------------------------------------------------ */

function slugifyHeading(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

// Collected per-render for the TOC.
let currentHeadings = []

function makeRenderer() {
  const renderer = new marked.Renderer()

  renderer.code = function (codeOrToken, infostring) {
    const code = typeof codeOrToken === 'object' ? codeOrToken.text : codeOrToken
    const rawLang = (typeof codeOrToken === 'object' ? codeOrToken.lang : infostring) || ''
    const lang = (rawLang.split(/\s+/)[0] || '').toLowerCase()
    const canonical = LANG_ALIAS[lang] ?? (HLJS_LANGS.has(lang) ? lang : 'plaintext')
    let highlighted
    if (canonical !== 'plaintext' && hljs.getLanguage(canonical)) {
      highlighted = hljs.highlight(code, { language: canonical, ignoreIllegals: true }).value
    } else {
      highlighted = escapeHtml(code)
    }
    const label = LANG_LABEL[canonical] ?? canonical
    return (
      `<figure class="code-block" data-lang="${label}">` +
      `<figcaption><span class="code-lang">${label}</span>` +
      `<button class="copy-btn" type="button" aria-label="Copy code to clipboard">Copy</button></figcaption>` +
      `<pre><code class="hljs language-${canonical}">${highlighted}</code></pre>` +
      `</figure>`
    )
  }

  renderer.heading = function (textOrToken, levelArg) {
    let text, level
    if (typeof textOrToken === 'object') {
      level = textOrToken.depth
      text = this.parser.parseInline(textOrToken.tokens)
    } else {
      text = textOrToken
      level = levelArg
    }
    const id = slugifyHeading(text)
    if (level === 2 || level === 3) currentHeadings.push({ level, text: stripTags(text), id })
    return `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section">#</a>${text}</h${level}>`
  }

  renderer.link = function (hrefOrToken, title, text) {
    let href, tokenText
    if (typeof hrefOrToken === 'object') {
      href = hrefOrToken.href
      title = hrefOrToken.title
      tokenText = this.parser.parseInline(hrefOrToken.tokens)
    } else {
      href = hrefOrToken
      tokenText = text
    }
    const external = /^https?:\/\//.test(href) && !href.includes('nirholas.github.io')
    const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : ''
    const t = title ? ` title="${title}"` : ''
    return `<a href="${href}"${t}${attrs}>${tokenText}</a>`
  }

  return renderer
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function stripTags(s) {
  return s.replace(/<[^>]+>/g, '')
}

// :::note / :::warning / :::tip / :::danger / :::info container syntax.
function transformCallouts(md) {
  const titles = { note: 'Note', warning: 'Warning', tip: 'Tip', danger: 'Important', info: 'Info' }
  return md.replace(/^:::(note|warning|tip|danger|info)\s*(.*)$([\s\S]*?)^:::\s*$/gm, (_, type, heading, body) => {
    const title = heading.trim() || titles[type]
    const inner = marked.parse(body.trim())
    return `<div class="callout callout-${type}"><p class="callout-title">${title}</p>${inner}</div>\n`
  })
}

function renderMarkdown(md) {
  currentHeadings = []
  const withCallouts = transformCallouts(md)
  const html = marked.parse(withCallouts)
  return { html, headings: currentHeadings.slice() }
}

/* ---------- page template -------------------------------------------------- */

function readingTime(md) {
  const words = md.replace(/```[\s\S]*?```/g, ' ').split(/\s+/).filter(Boolean).length
  return Math.max(1, Math.round(words / 200))
}

function navList(pages, currentSlug) {
  const sections = []
  let last = null
  for (const p of pages) {
    if (p.section !== last) {
      sections.push({ name: p.section, items: [] })
      last = p.section
    }
    sections[sections.length - 1].items.push(p)
  }
  return sections
    .map((s, si) => {
      const items = s.items
        .map((p, i) => {
          const active = p.slug === currentSlug ? ' class="active" aria-current="page"' : ''
          const num = `<span class="nav-num">${si === 0 ? '' : ''}</span>`
          return `<li><a href="${rel(currentSlug, p.slug)}"${active}><span class="nav-idx">${p.index}</span>${escapeHtml(p.navTitle || p.title)}</a></li>`
        })
        .join('')
      return `<div class="nav-section"><p class="nav-section-title">${escapeHtml(s.name)}</p><ul>${items}</ul></div>`
    })
    .join('')
}

// relative href from one page to another (all pages live at <slug>/)
function rel(fromSlug, toSlug) {
  if (fromSlug === null) return toSlug === 'index' ? './' : `${toSlug}/`
  // from a tutorial page (one dir deep) back up to root
  if (toSlug === 'index') return '../'
  return `../${toSlug}/`
}

function assetHref(fromSlug, file) {
  return fromSlug === null ? `assets/${file}` : `../assets/${file}`
}

function tocHtml(headings) {
  if (headings.length < 2) return ''
  const items = headings
    .map((h) => `<li class="toc-l${h.level}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`)
    .join('')
  return `<nav class="toc" aria-label="On this page"><p class="toc-title">On this page</p><ul>${items}</ul></nav>`
}

function prereqBox(prereqs) {
  if (!prereqs || !prereqs.length) return ''
  const items = prereqs.map((p) => `<li>${marked.parseInline(p)}</li>`).join('')
  return `<aside class="prereq"><p class="prereq-title">Prerequisites</p><ul>${items}</ul></aside>`
}

function buildYouBox(what) {
  if (!what) return ''
  return `<aside class="whatbuild"><p class="whatbuild-title">What you'll build</p><p>${marked.parseInline(what)}</p></aside>`
}

function shell(opts) {
  const { title, description, bodyClass, main, currentSlug, pages, extraHead = '', extraScripts = [] } = opts
  const nav = navList(pages, currentSlug)
  const scripts = ['app.js', ...extraScripts].map((s) => `<script defer src="${assetHref(currentSlug, s)}"></script>`).join('')
  const homeHref = currentSlug === null ? './' : '../'
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="article">
<meta name="theme-color" content="#0b0d10">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%2300c805'/%3E%3Cpath d='M9 22V10h4.4c2.6 0 4.2 1.4 4.2 3.7 0 1.7-.9 2.9-2.4 3.4l2.9 4.9h-2.8l-2.5-4.4h-1.4V22H9zm2.4-6.3h1.8c1.2 0 1.9-.6 1.9-1.7s-.7-1.7-1.9-1.7h-1.8v3.4z' fill='%23000'/%3E%3C/svg%3E">
<link rel="stylesheet" href="${assetHref(currentSlug, 'styles.css')}">
${extraHead}
</head>
<body class="${bodyClass}">
<a class="skip-link" href="#main">Skip to content</a>
<script>(function(){try{var t=localStorage.getItem('theme');if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="${homeHref}">
      <span class="brand-mark" aria-hidden="true">R</span>
      <span class="brand-text">Learn <strong>Robinhood Chain</strong></span>
    </a>
    <div class="topbar-actions">
      <button class="search-open" type="button" aria-label="Search tutorials" aria-keyshortcuts="/">
        <span class="search-open-label">Search</span><kbd>/</kbd>
      </button>
      <a class="ghost-link" href="${SITE.repo}" target="_blank" rel="noopener noreferrer">GitHub</a>
      <button class="theme-toggle" type="button" aria-label="Toggle color theme" title="Toggle theme"></button>
      <button class="menu-toggle" type="button" aria-label="Toggle navigation" aria-expanded="false"></button>
    </div>
  </div>
</header>
<div class="layout">
  <aside class="sidebar" id="sidebar" aria-label="Tutorials">
    <nav class="sidebar-nav">${nav}</nav>
  </aside>
  <div class="sidebar-scrim" hidden></div>
  ${main}
</div>
<div class="search-modal" id="search-modal" hidden role="dialog" aria-modal="true" aria-label="Search">
  <div class="search-panel">
    <input type="search" id="search-input" placeholder="Search tutorials…" autocomplete="off" spellcheck="false" aria-label="Search query">
    <ul class="search-results" id="search-results" aria-live="polite"></ul>
    <p class="search-hint"><kbd>↑</kbd><kbd>↓</kbd> to navigate · <kbd>↵</kbd> to open · <kbd>esc</kbd> to close</p>
  </div>
</div>
${scripts}
</body>
</html>`
}

/* ---------- landing page --------------------------------------------------- */

function landingMain(pages) {
  const sections = []
  let last = null
  for (const p of pages) {
    if (p.section !== last) { sections.push({ name: p.section, items: [] }); last = p.section }
    sections[sections.length - 1].items.push(p)
  }
  const cards = sections
    .map(
      (s) => `
    <section class="curriculum-group">
      <h2 class="curriculum-group-title">${escapeHtml(s.name)}</h2>
      <div class="card-grid">
        ${s.items
          .map(
            (p) => `<a class="tut-card" href="${p.slug}/" data-slug="${p.slug}">
          <span class="tut-card-idx">${p.index}</span>
          <span class="tut-card-check" aria-hidden="true"></span>
          <span class="tut-card-body">
            <span class="tut-card-title">${escapeHtml(p.title)}</span>
            <span class="tut-card-desc">${escapeHtml(p.description)}</span>
            <span class="tut-card-time">${p.time}</span>
          </span>
        </a>`,
          )
          .join('')}
      </div>
    </section>`,
    )
    .join('')

  return `<main class="landing" id="main">
  <section class="hero">
    <div class="hero-inner">
      <p class="eyebrow">Chain ID 4663 · Arbitrum Orbit L2 · ETH gas · ~100ms blocks</p>
      <h1>Build on <span class="grad">Robinhood Chain</span>.</h1>
      <p class="lede">${escapeHtml(SITE.tagline)} Twelve tutorials, each performed on-chain, from your first RPC read to a live autonomous agent — built on the open-source <a href="https://github.com/nirholas/robinhood-chain-sdk">hoodchain</a> SDK.</p>
      <div class="hero-cta">
        <a class="btn btn-primary" href="01-what-is-robinhood-chain/">Start learning</a>
        <a class="btn btn-ghost" href="04-live-price-ticker/">Jump to code</a>
      </div>
      <div class="chain-strip" id="chain-strip" aria-label="Live chain stats">
        <div class="stat"><span class="stat-label">Block height</span><span class="stat-value" id="stat-block">…</span></div>
        <div class="stat"><span class="stat-label">Gas price</span><span class="stat-value" id="stat-gas">…</span></div>
        <div class="stat"><span class="stat-label">AAPL token</span><span class="stat-value" id="stat-aapl">…</span></div>
        <div class="stat"><span class="stat-label">USDG supply</span><span class="stat-value" id="stat-usdg">…</span></div>
      </div>
      <p class="chain-strip-note" id="chain-strip-note">Live from the public RPC in your browser.</p>
    </div>
  </section>
  <div class="curriculum">
    <div class="curriculum-head">
      <h2 class="section-h">The curriculum</h2>
      <button class="reset-progress" type="button" id="reset-progress" hidden>Reset progress</button>
    </div>
    <p class="progress-line"><span id="progress-count">0</span> of ${pages.length} completed · progress is saved in your browser</p>
    ${cards}
  </div>
  <footer class="site-footer">
    <p>Built by <a href="${SITE.authorUrl}" target="_blank" rel="noopener noreferrer">${SITE.author}</a> · <a href="${SITE.home}" target="_blank" rel="noopener noreferrer">three.ws</a></p>
    <p class="disclaimer">Educational material. Stock Tokens are tokenized debt securities (issuer: Robinhood Assets (Jersey) Ltd) and may not be offered, sold, or delivered to US persons. Nothing here is financial advice.</p>
  </footer>
</main>`
}

/* ---------- tutorial page -------------------------------------------------- */

function tutorialMain(page, rendered, prev, next) {
  const toc = tocHtml(rendered.headings)
  const prevLink = prev
    ? `<a class="pager pager-prev" href="../${prev.slug}/"><span class="pager-dir">← Previous</span><span class="pager-title">${escapeHtml(prev.title)}</span></a>`
    : '<span></span>'
  const nextLink = next
    ? `<a class="pager pager-next" href="../${next.slug}/"><span class="pager-dir">Next →</span><span class="pager-title">${escapeHtml(next.title)}</span></a>`
    : '<span></span>'
  return `<main class="doc" id="main" data-slug="${page.slug}">
  <article class="doc-article">
    <nav class="breadcrumb" aria-label="Breadcrumb"><a href="../">Home</a><span aria-hidden="true">/</span><span>${escapeHtml(page.section)}</span></nav>
    <header class="doc-header">
      <h1>${escapeHtml(page.title)}</h1>
      <div class="doc-meta">
        <span class="doc-meta-item">${page.time}</span>
        <span class="doc-meta-sep">·</span>
        <span class="doc-meta-item">${rendered.readMin} min read</span>
        <span class="doc-meta-sep">·</span>
        <label class="done-toggle"><input type="checkbox" class="done-check"> Mark complete</label>
      </div>
    </header>
    ${buildYouBox(page.whatYouBuild)}
    ${prereqBox(page.prerequisites)}
    <div class="doc-body">${rendered.html}</div>
    <nav class="pager-nav" aria-label="Tutorial pagination">${prevLink}${nextLink}</nav>
    <footer class="doc-footer">
      <p>Question or correction? <a href="${SITE.repo}/issues" target="_blank" rel="noopener noreferrer">Open an issue</a>.</p>
      <p>Built by <a href="${SITE.authorUrl}" target="_blank" rel="noopener noreferrer">${SITE.author}</a> · <a href="${SITE.home}" target="_blank" rel="noopener noreferrer">three.ws</a></p>
    </footer>
  </article>
  ${toc}
</main>`
}

/* ---------- search index --------------------------------------------------- */

function plainText(html) {
  return html
    .replace(/<figure class="code-block"[\s\S]*?<\/figure>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/* ---------- build ---------------------------------------------------------- */

async function main() {
  marked.use({ renderer: makeRenderer(), gfm: true, breaks: false })

  const meta = JSON.parse(await fs.readFile(path.join(CONTENT, 'meta.json'), 'utf8'))
  const pages = meta.pages.map((p, i) => ({ ...p, index: String(i + 1).padStart(2, '0') }))

  await fs.rm(OUT, { recursive: true, force: true })
  await fs.mkdir(path.join(OUT, 'assets'), { recursive: true })

  // assets
  for (const file of await fs.readdir(ASSETS)) {
    await fs.copyFile(path.join(ASSETS, file), path.join(OUT, 'assets', file))
  }
  // inline highlight.js theme (build-time → shipped, no CDN)
  const hljsCss = await buildHljsCss()
  await fs.writeFile(path.join(OUT, 'assets', 'hljs.css'), hljsCss)

  const searchDocs = []

  // tutorial pages
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    const md = await fs.readFile(path.join(CONTENT, page.file), 'utf8')
    const rendered = renderMarkdown(md)
    rendered.readMin = readingTime(md)
    const prev = pages[i - 1]
    const next = pages[i + 1]
    const html = shell({
      title: `${page.title} · ${SITE.title}`,
      description: page.description,
      bodyClass: 'page-doc',
      main: tutorialMain(page, rendered, prev, next),
      currentSlug: page.slug,
      pages,
      extraHead: `<link rel="stylesheet" href="../assets/hljs.css">`,
      extraScripts: ['search.js'],
    })
    await fs.mkdir(path.join(OUT, page.slug), { recursive: true })
    await fs.writeFile(path.join(OUT, page.slug, 'index.html'), html)

    searchDocs.push({
      slug: page.slug,
      title: page.title,
      section: page.section,
      index: page.index,
      description: page.description,
      headings: rendered.headings.map((h) => h.text),
      text: plainText(rendered.html).slice(0, 4000),
    })
  }

  // landing
  const landing = shell({
    title: `${SITE.title} — ${SITE.tagline}`,
    description: SITE.tagline + ' Twelve on-chain-verified tutorials for building on Robinhood Chain (chain ID 4663).',
    bodyClass: 'page-home',
    main: landingMain(pages),
    currentSlug: null,
    pages,
    extraHead: '',
    extraScripts: ['ticker.js', 'search.js'],
  })
  await fs.writeFile(path.join(OUT, 'index.html'), landing)

  // search index + manifest for the ticker/progress
  await fs.writeFile(path.join(OUT, 'assets', 'search-index.json'), JSON.stringify(searchDocs))
  await fs.writeFile(
    path.join(OUT, 'assets', 'pages.json'),
    JSON.stringify(pages.map((p) => ({ slug: p.slug, title: p.title, index: p.index }))),
  )
  await fs.writeFile(path.join(OUT, '.nojekyll'), '')

  console.log(`Built ${pages.length} tutorials + landing → docs/`)
}

async function buildHljsCss() {
  // A compact, theme-aware highlight palette matching the site tokens.
  return `/* highlight.js — theme-aware, self-hosted (no CDN) */
.hljs{color:var(--code-fg);background:transparent}
.hljs-comment,.hljs-quote{color:var(--hl-comment);font-style:italic}
.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-section,.hljs-link{color:var(--hl-keyword)}
.hljs-function .hljs-keyword{color:var(--hl-keyword)}
.hljs-string,.hljs-attr,.hljs-template-tag,.hljs-addition,.hljs-regexp{color:var(--hl-string)}
.hljs-number,.hljs-symbol,.hljs-bullet,.hljs-meta{color:var(--hl-number)}
.hljs-title,.hljs-title.function_,.hljs-name{color:var(--hl-title)}
.hljs-type,.hljs-class .hljs-title,.hljs-title.class_,.hljs-built_in{color:var(--hl-type)}
.hljs-variable,.hljs-template-variable,.hljs-property{color:var(--hl-var)}
.hljs-attribute{color:var(--hl-attr)}
.hljs-deletion{color:var(--hl-deletion)}
.hljs-emphasis{font-style:italic}
.hljs-strong{font-weight:600}
`
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
