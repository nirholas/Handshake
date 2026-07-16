import { createServer } from 'node:http';
import { renderBadge } from './badge.js';
import { buildStatus, buildHistory } from './status.js';
import '../../docs/assets/status-core.js';

const { COMPONENTS } = globalThis.StatusCore;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

const EMBED_JS = `(function () {
  'use strict';
  var script = document.currentScript;
  var origin = new URL(script.src).origin;
  var colors = { operational: '#2da44e', degraded: '#bf8700', down: '#cf222e', unknown: '#6e7781' };
  function paint(el, status, label) {
    el.innerHTML = '';
    var pill = document.createElement('a');
    pill.href = script.getAttribute('data-page') || origin;
    pill.target = '_blank';
    pill.rel = 'noopener';
    pill.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font:500 12px/1.4 system-ui,sans-serif;text-decoration:none;color:inherit;border:1px solid ' + (colors[status] || colors.unknown) + '55;background:' + (colors[status] || colors.unknown) + '14';
    var dot = document.createElement('span');
    dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:' + (colors[status] || colors.unknown);
    var text = document.createElement('span');
    text.textContent = 'Robinhood Chain: ' + label;
    pill.appendChild(dot);
    pill.appendChild(text);
    el.appendChild(pill);
  }
  function refresh() {
    var els = document.querySelectorAll('[data-hood-status]');
    if (!els.length) return;
    fetch(origin + '/api/status')
      .then(function (r) { return r.json(); })
      .then(function (s) {
        els.forEach(function (el) { paint(el, s.overall.status, s.overall.status); });
      })
      .catch(function () {
        els.forEach(function (el) { paint(el, 'unknown', 'unreachable'); });
      });
  }
  refresh();
  setInterval(refresh, 60000);
})();
`;

/**
 * Tiny dependency-free HTTP layer. `ctx` provides live worker state:
 * { store, published, latest, startedAt, config }.
 */
export function createStatusServer(ctx) {
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS).end();
      return;
    }
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }

    try {
      switch (url.pathname) {
        case '/':
        case '/api/status': {
          json(res, 200, buildStatus(ctx));
          return;
        }
        case '/api/history': {
          const body = buildHistory({
            store: ctx.store,
            metric: url.searchParams.get('metric') ?? '',
            window: url.searchParams.get('window') ?? '24h',
          });
          json(res, body.error ? 400 : 200, body);
          return;
        }
        case '/badge.svg': {
          const component = url.searchParams.get('component');
          let status;
          let label;
          if (component) {
            const def = COMPONENTS.find((c) => c.id === component);
            if (!def) {
              json(res, 404, { error: `unknown component "${component}"` });
              return;
            }
            status = ctx.published[component] ?? 'unknown';
            label = url.searchParams.get('label') ?? def.name.toLowerCase();
          } else {
            const s = buildStatus(ctx);
            status = s.overall.status;
            label = url.searchParams.get('label') ?? 'robinhood chain';
          }
          res.writeHead(200, {
            ...CORS,
            'content-type': 'image/svg+xml; charset=utf-8',
            'cache-control': 'max-age=60, s-maxage=60',
          });
          res.end(renderBadge(label, status));
          return;
        }
        case '/embed.js': {
          res.writeHead(200, {
            ...CORS,
            'content-type': 'text/javascript; charset=utf-8',
            'cache-control': 'max-age=3600',
          });
          res.end(EMBED_JS);
          return;
        }
        case '/healthz': {
          json(res, 200, { ok: true, samples: ctx.store.sampleCount() });
          return;
        }
        default:
          json(res, 404, {
            error: 'not found',
            endpoints: ['/api/status', '/api/history?metric=&window=', '/badge.svg', '/embed.js', '/healthz'],
          });
      }
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  });
}

function json(res, code, body) {
  res.writeHead(code, {
    ...CORS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}
