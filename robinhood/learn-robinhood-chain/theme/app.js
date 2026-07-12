/* learn-robinhood-chain — runtime. Zero dependencies. */
(function () {
  "use strict";
  var root = document.documentElement;
  var LS = window.localStorage;

  /* ---------- theme ---------- */
  function applyTheme(t) {
    if (t === "light" || t === "dark") root.setAttribute("data-theme", t);
    else root.removeAttribute("data-theme");
  }
  try {
    applyTheme(LS.getItem("lrc-theme"));
  } catch (e) {}
  function currentTheme() {
    var set = root.getAttribute("data-theme");
    if (set) return set;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  function bindTheme() {
    var btn = document.getElementById("theme-toggle");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var next = currentTheme() === "dark" ? "light" : "dark";
      applyTheme(next);
      try {
        LS.setItem("lrc-theme", next);
      } catch (e) {}
    });
  }

  /* ---------- mobile nav ---------- */
  function bindNav() {
    var menu = document.getElementById("menu-btn");
    var scrim = document.querySelector(".scrim");
    function close() {
      document.body.classList.remove("nav-open");
    }
    if (menu)
      menu.addEventListener("click", function () {
        document.body.classList.toggle("nav-open");
      });
    if (scrim) scrim.addEventListener("click", close);
    document.querySelectorAll(".sidebar a").forEach(function (a) {
      a.addEventListener("click", close);
    });
  }

  /* ---------- copy buttons ---------- */
  var copyIcon =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  var checkIcon =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  function bindCopy() {
    document.querySelectorAll(".copy-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var wrap = btn.closest(".code-wrap");
        var code = wrap && wrap.querySelector("pre");
        if (!code) return;
        var text = code.innerText;
        navigator.clipboard.writeText(text).then(function () {
          btn.classList.add("copied");
          btn.innerHTML = checkIcon + "<span>Copied</span>";
          setTimeout(function () {
            btn.classList.remove("copied");
            btn.innerHTML = copyIcon + "<span>Copy</span>";
          }, 1600);
        });
      });
    });
  }

  /* ---------- progress (localStorage) ---------- */
  function getDone() {
    try {
      return JSON.parse(LS.getItem("lrc-progress") || "[]");
    } catch (e) {
      return [];
    }
  }
  function setDone(arr) {
    try {
      LS.setItem("lrc-progress", JSON.stringify(arr));
    } catch (e) {}
  }
  function markComplete(slug, done) {
    var arr = getDone();
    var i = arr.indexOf(slug);
    if (done && i === -1) arr.push(slug);
    if (!done && i !== -1) arr.splice(i, 1);
    setDone(arr);
  }
  function reflectProgress() {
    var done = getDone();
    document.querySelectorAll("[data-slug]").forEach(function (el) {
      el.classList.toggle("completed", done.indexOf(el.getAttribute("data-slug")) !== -1);
    });
    var counter = document.getElementById("progress-count");
    if (counter) {
      var total = Number(counter.getAttribute("data-total") || "0");
      counter.innerHTML = "<b>" + done.length + "</b> / " + total + " complete";
    }
  }
  function bindComplete() {
    var bar = document.getElementById("complete-bar");
    if (!bar) return;
    var slug = bar.getAttribute("data-slug");
    var btn = bar.querySelector(".check-btn");
    function render() {
      var isDone = getDone().indexOf(slug) !== -1;
      bar.classList.toggle("done", isDone);
      btn.querySelector("span").textContent = isDone ? "Completed" : "Mark complete";
    }
    btn.addEventListener("click", function () {
      var isDone = getDone().indexOf(slug) !== -1;
      markComplete(slug, !isDone);
      render();
      reflectProgress();
    });
    render();
  }

  /* ---------- TOC scroll-spy ---------- */
  function bindToc() {
    var links = document.querySelectorAll(".toc a");
    if (!links.length || !("IntersectionObserver" in window)) return;
    var map = {};
    links.forEach(function (a) {
      map[a.getAttribute("href").slice(1)] = a;
    });
    var visible = new Set();
    var obs = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        });
        var first = null;
        document.querySelectorAll(".doc h2, .doc h3").forEach(function (h) {
          if (!first && visible.has(h.id)) first = h.id;
        });
        links.forEach(function (a) {
          a.classList.toggle("active", a === map[first]);
        });
      },
      { rootMargin: "-70px 0px -70% 0px" }
    );
    document.querySelectorAll(".doc h2[id], .doc h3[id]").forEach(function (h) {
      obs.observe(h);
    });
  }

  /* ---------- search ---------- */
  var SEARCH = { index: null, loaded: false };
  function base() {
    return document.body.getAttribute("data-base") || "";
  }
  function loadIndex() {
    if (SEARCH.loaded) return Promise.resolve(SEARCH.index);
    return fetch(base() + "search-index.json")
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        SEARCH.index = j;
        SEARCH.loaded = true;
        return j;
      })
      .catch(function () {
        return [];
      });
  }
  function esc(s) {
    return s.replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function highlight(text, terms) {
    var out = esc(text);
    terms.forEach(function (t) {
      if (t.length < 2) return;
      out = out.replace(new RegExp("(" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig"), "<mark>$1</mark>");
    });
    return out;
  }
  function score(entry, terms) {
    var s = 0;
    terms.forEach(function (t) {
      if (entry.title.toLowerCase().indexOf(t) !== -1) s += 12;
      if (entry.heading && entry.heading.toLowerCase().indexOf(t) !== -1) s += 6;
      var idx = entry.body.toLowerCase().indexOf(t);
      if (idx !== -1) s += 3;
    });
    return s;
  }
  function snippet(body, terms) {
    var low = body.toLowerCase();
    var pos = -1;
    terms.forEach(function (t) {
      var i = low.indexOf(t);
      if (i !== -1 && (pos === -1 || i < pos)) pos = i;
    });
    if (pos === -1) pos = 0;
    var start = Math.max(0, pos - 40);
    return (start > 0 ? "…" : "") + body.slice(start, start + 150) + "…";
  }
  function runSearch(q) {
    var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    return (SEARCH.index || [])
      .map(function (e) {
        return { e: e, s: score(e, terms) };
      })
      .filter(function (r) {
        return r.s > 0;
      })
      .sort(function (a, b) {
        return b.s - a.s;
      })
      .slice(0, 12)
      .map(function (r) {
        return r.e;
      });
  }
  function bindSearch() {
    var modal = document.getElementById("search-modal");
    var input = document.getElementById("search-input");
    var results = document.getElementById("search-results");
    var opener = document.getElementById("search-open");
    if (!modal || !input) return;
    var sel = -1;
    function open() {
      modal.classList.add("open");
      loadIndex();
      setTimeout(function () {
        input.focus();
      }, 20);
    }
    function close() {
      modal.classList.remove("open");
      input.value = "";
      results.innerHTML = "";
      sel = -1;
    }
    function render(q) {
      var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
      var items = runSearch(q);
      sel = items.length ? 0 : -1;
      results.innerHTML = items
        .map(function (e, i) {
          return (
            '<a class="sr-item' +
            (i === 0 ? " sel" : "") +
            '" href="' +
            base() +
            e.url +
            '">' +
            '<div class="sr-ctx">' +
            esc(e.section) +
            (e.heading ? " › " + highlight(e.heading, terms) : "") +
            "</div>" +
            '<div class="sr-ttl">' +
            highlight(e.title, terms) +
            "</div>" +
            '<div class="sr-snip">' +
            highlight(snippet(e.body, terms), terms) +
            "</div>" +
            "</a>"
          );
        })
        .join("");
    }
    if (opener) opener.addEventListener("click", open);
    input.addEventListener("input", function () {
      render(input.value);
    });
    modal.addEventListener("click", function (e) {
      if (e.target === modal) close();
    });
    input.addEventListener("keydown", function (e) {
      var items = results.querySelectorAll(".sr-item");
      if (e.key === "ArrowDown") {
        e.preventDefault();
        sel = Math.min(sel + 1, items.length - 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        sel = Math.max(sel - 1, 0);
      } else if (e.key === "Enter") {
        if (items[sel]) window.location.href = items[sel].getAttribute("href");
      } else if (e.key === "Escape") {
        close();
      }
      items.forEach(function (it, i) {
        it.classList.toggle("sel", i === sel);
      });
      if (items[sel]) items[sel].scrollIntoView({ block: "nearest" });
    });
    document.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        modal.classList.contains("open") ? close() : open();
      } else if (e.key === "/" && !/input|textarea/i.test(document.activeElement.tagName)) {
        e.preventDefault();
        open();
      }
    });
  }

  /* ---------- live chain stats (landing) ---------- */
  var RPC = "https://rpc.mainnet.chain.robinhood.com";
  function rpc(method, params) {
    return fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params || [] }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        return j.result;
      });
  }
  function setStat(id, val) {
    var el = document.getElementById(id);
    if (!el) return;
    el.classList.remove("loading");
    var prev = el.getAttribute("data-v");
    el.textContent = val;
    if (prev !== null && prev !== val) {
      el.style.color = "var(--accent)";
      setTimeout(function () {
        el.style.color = "";
      }, 320);
    }
    el.setAttribute("data-v", val);
  }
  // AAPL feed on mainnet — latestRoundData() selector 0xfeaf968c, answer is 2nd word (8 decimals)
  var AAPL_FEED = "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0";
  function readAapl() {
    return rpc("eth_call", [{ to: AAPL_FEED, data: "0xfeaf968c" }, "latest"]).then(function (hex) {
      if (!hex || hex === "0x") return null;
      // roundId, answer, startedAt, updatedAt, answeredInRound — answer is word index 1
      var answer = BigInt("0x" + hex.slice(2 + 64, 2 + 128));
      return Number(answer) / 1e8;
    });
  }
  function refreshStats() {
    var strip = document.getElementById("stats-grid");
    if (!strip) return;
    rpc("eth_blockNumber")
      .then(function (h) {
        setStat("stat-block", Number(BigInt(h)).toLocaleString());
      })
      .catch(function () {});
    rpc("eth_gasPrice")
      .then(function (h) {
        var gwei = Number(BigInt(h)) / 1e9;
        setStat("stat-gas", gwei.toFixed(4) + " gwei");
      })
      .catch(function () {});
    readAapl()
      .then(function (px) {
        if (px) setStat("stat-aapl", "$" + px.toFixed(2));
      })
      .catch(function () {});
  }
  function bindStats() {
    if (!document.getElementById("stats-grid")) return;
    refreshStats();
    setInterval(refreshStats, 4000);
  }

  document.addEventListener("DOMContentLoaded", function () {
    bindTheme();
    bindNav();
    bindCopy();
    bindComplete();
    bindToc();
    bindSearch();
    reflectProgress();
    bindStats();
  });
})();
