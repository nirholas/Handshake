/* app.js — theme toggle, copy buttons, mobile nav, progress, TOC scrollspy.
   No dependencies, no CDN. Progressive enhancement over the static HTML. */
(function () {
  'use strict'

  /* ---- theme --------------------------------------------------------- */
  var root = document.documentElement
  var toggle = document.querySelector('.theme-toggle')
  if (toggle) {
    toggle.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light'
      root.setAttribute('data-theme', next)
      try { localStorage.setItem('theme', next) } catch (e) {}
    })
  }

  /* ---- copy buttons -------------------------------------------------- */
  document.querySelectorAll('.copy-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var fig = btn.closest('.code-block')
      var code = fig ? fig.querySelector('code') : null
      if (!code) return
      var text = code.innerText
      var done = function () {
        btn.textContent = 'Copied'
        btn.classList.add('copied')
        setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('copied') }, 1600)
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done) })
      } else {
        fallbackCopy(text, done)
      }
    })
  })
  function fallbackCopy(text, cb) {
    var ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy'); cb() } catch (e) {}
    document.body.removeChild(ta)
  }

  /* ---- mobile nav ---------------------------------------------------- */
  var menu = document.querySelector('.menu-toggle')
  var scrim = document.querySelector('.sidebar-scrim')
  function closeNav() { document.body.classList.remove('nav-open'); if (menu) menu.setAttribute('aria-expanded', 'false') }
  if (menu) {
    menu.addEventListener('click', function () {
      var open = document.body.classList.toggle('nav-open')
      menu.setAttribute('aria-expanded', String(open))
    })
  }
  if (scrim) scrim.addEventListener('click', closeNav)
  document.querySelectorAll('.sidebar-nav a').forEach(function (a) { a.addEventListener('click', closeNav) })

  /* ---- progress (localStorage) -------------------------------------- */
  var KEY = 'lrc:done'
  function getDone() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]') } catch (e) { return [] }
  }
  function setDone(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)) } catch (e) {}
  }
  function markDone(slug, done) {
    var list = getDone()
    var i = list.indexOf(slug)
    if (done && i === -1) list.push(slug)
    if (!done && i !== -1) list.splice(i, 1)
    setDone(list)
  }

  // doc page: wire the "mark complete" checkbox
  var main = document.querySelector('.doc[data-slug]')
  if (main) {
    var slug = main.getAttribute('data-slug')
    var check = document.querySelector('.done-check')
    if (check) {
      check.checked = getDone().indexOf(slug) !== -1
      check.addEventListener('change', function () { markDone(slug, check.checked) })
    }
  }

  // landing page: reflect progress on cards
  var cards = document.querySelectorAll('.tut-card[data-slug]')
  if (cards.length) {
    var done = getDone()
    var count = 0
    cards.forEach(function (card) {
      if (done.indexOf(card.getAttribute('data-slug')) !== -1) { card.classList.add('done'); count++ }
    })
    var counter = document.getElementById('progress-count')
    if (counter) counter.textContent = String(count)
    var reset = document.getElementById('reset-progress')
    if (reset) {
      if (count > 0) reset.hidden = false
      reset.addEventListener('click', function () {
        setDone([])
        cards.forEach(function (c) { c.classList.remove('done') })
        if (counter) counter.textContent = '0'
        reset.hidden = true
      })
    }
  }

  /* ---- TOC scrollspy ------------------------------------------------- */
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.toc a'))
  if (tocLinks.length && 'IntersectionObserver' in window) {
    var map = {}
    tocLinks.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a })
    var visible = new Set()
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) visible.add(e.target.id); else visible.delete(e.target.id)
      })
      tocLinks.forEach(function (a) { a.classList.remove('active') })
      var first = tocLinks.find(function (a) { return visible.has(a.getAttribute('href').slice(1)) })
      if (first) first.classList.add('active')
    }, { rootMargin: '-80px 0px -70% 0px' })
    Object.keys(map).forEach(function (id) {
      var el = document.getElementById(id)
      if (el) obs.observe(el)
    })
  }
})()
