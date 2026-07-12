/* search.js — offline client-side search over a build-time index.
   Hand-rolled: token-prefix scoring across title, headings, and body.
   No lunr, no CDN. Opens with the "/" key or the Search button. */
(function () {
  'use strict'

  var modal = document.getElementById('search-modal')
  var input = document.getElementById('search-input')
  var results = document.getElementById('search-results')
  var openBtn = document.querySelector('.search-open')
  if (!modal || !input || !results) return

  // index path is relative to the current page depth
  var isHome = document.body.classList.contains('page-home')
  var base = isHome ? 'assets/' : '../assets/'
  var linkBase = isHome ? '' : '../'

  var index = null
  var loading = false
  var active = -1
  var current = []

  function load() {
    if (index || loading) return
    loading = true
    fetch(base + 'search-index.json')
      .then(function (r) { return r.json() })
      .then(function (data) { index = data })
      .catch(function () { index = [] })
      .finally(function () { loading = false; if (modal.hidden === false) run(input.value) })
  }

  function open() {
    modal.hidden = false
    document.body.style.overflow = 'hidden'
    load()
    setTimeout(function () { input.focus(); input.select() }, 10)
  }
  function close() {
    modal.hidden = true
    document.body.style.overflow = ''
    active = -1
  }

  if (openBtn) openBtn.addEventListener('click', open)
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && !isTyping(e.target) && modal.hidden) { e.preventDefault(); open() }
    else if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); modal.hidden ? open() : close() }
    else if (e.key === 'Escape' && !modal.hidden) { close() }
  })
  function isTyping(el) {
    if (!el) return false
    var t = el.tagName
    return t === 'INPUT' || t === 'TEXTAREA' || el.isContentEditable
  }

  modal.addEventListener('click', function (e) { if (e.target === modal) close() })

  input.addEventListener('input', function () { run(input.value) })
  input.addEventListener('keydown', function (e) {
    var items = results.querySelectorAll('a')
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1, items) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1, items) }
    else if (e.key === 'Enter') { if (items[active]) { e.preventDefault(); window.location.href = items[active].getAttribute('href') } else if (items[0]) { window.location.href = items[0].getAttribute('href') } }
  })
  function move(dir, items) {
    if (!items.length) return
    if (active >= 0 && items[active]) items[active].classList.remove('active')
    active = (active + dir + items.length) % items.length
    items[active].classList.add('active')
    items[active].scrollIntoView({ block: 'nearest' })
  }

  function tokenize(s) { return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean) }

  function run(query) {
    active = -1
    var q = query.trim().toLowerCase()
    if (!q) { results.innerHTML = ''; return }
    if (!index) { results.innerHTML = '<li class="search-empty">Loading index…</li>'; return }

    var terms = tokenize(q)
    var scored = []
    for (var i = 0; i < index.length; i++) {
      var doc = index[i]
      var hayTitle = doc.title.toLowerCase()
      var hayHead = doc.headings.join(' ').toLowerCase()
      var hayBody = (doc.description + ' ' + doc.text).toLowerCase()
      var score = 0
      var matchedAll = true
      for (var t = 0; t < terms.length; t++) {
        var term = terms[t]
        var s = 0
        if (hayTitle.indexOf(term) !== -1) s += 12
        if (hayHead.indexOf(term) !== -1) s += 6
        if (hayBody.indexOf(term) !== -1) s += 2
        if (hayTitle.split(/\s+/).some(function (w) { return w.indexOf(term) === 0 })) s += 4
        if (s === 0) matchedAll = false
        score += s
      }
      if (matchedAll && score > 0) scored.push({ doc: doc, score: score })
    }
    scored.sort(function (a, b) { return b.score - a.score })
    current = scored.slice(0, 8)
    render(terms)
  }

  function render(terms) {
    if (!current.length) { results.innerHTML = '<li class="search-empty">No matches. Try another term.</li>'; return }
    results.innerHTML = current
      .map(function (r) {
        var d = r.doc
        var snippet = makeSnippet(d.description + ' — ' + d.text, terms)
        return (
          '<li><a href="' + linkBase + d.slug + '/">' +
          '<span class="sr-section">' + esc(d.index + ' · ' + d.section) + '</span>' +
          '<span class="sr-title">' + hl(d.title, terms) + '</span>' +
          '<span class="sr-snippet">' + snippet + '</span>' +
          '</a></li>'
        )
      })
      .join('')
  }

  function makeSnippet(text, terms) {
    var lower = text.toLowerCase()
    var pos = -1
    for (var i = 0; i < terms.length; i++) { var p = lower.indexOf(terms[i]); if (p !== -1 && (pos === -1 || p < pos)) pos = p }
    if (pos === -1) pos = 0
    var start = Math.max(0, pos - 30)
    var slice = text.slice(start, start + 120)
    return (start > 0 ? '…' : '') + hl(slice, terms) + '…'
  }

  function hl(text, terms) {
    var out = esc(text)
    terms.forEach(function (term) {
      if (!term) return
      var re = new RegExp('(' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig')
      out = out.replace(re, '<mark>$1</mark>')
    })
    return out
  }
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
})()
