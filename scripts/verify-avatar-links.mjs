// Verify avatar card link wiring across gallery, discover, avatar studio, and legacy redirect.
import { chromium } from 'playwright';

const LAUNCH_ARGS = [
  '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--disable-dev-shm-usage',
];

const results = [];

function record(step, status, detail) {
  results.push({ step, status, detail });
  console.log(`[${status}] ${step}: ${detail}`);
}

async function collectConsole(page, label, sink) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') sink.push(`[${label}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    sink.push(`[${label}] pageerror: ${err.message}`);
  });
}

(async () => {
  const browser = await chromium.launch({ args: LAUNCH_ARGS, headless: true });
  const context = await browser.newContext();
  const errors = [];

  try {
    // ---------------- Step 1: gallery ----------------
    {
      const page = await context.newPage();
      await collectConsole(page, 'gallery', errors);
      await page.goto('http://localhost:3000/gallery/', { waitUntil: 'domcontentloaded' });
      // Wait for real (non-skeleton) cards: <a class="gallery-card-thumb">
      await page.waitForSelector('a.gallery-card-thumb', { timeout: 20000 });
      await page.waitForTimeout(300);
      const data = await page.evaluate(() => {
        const thumb = document.querySelector('a.gallery-card-thumb');
        const name = document.querySelector('.gallery-card-name a');
        return {
          thumbHref: thumb ? thumb.getAttribute('href') : null,
          nameHref: name ? name.getAttribute('href') : null,
        };
      });
      const ok =
        data.thumbHref && data.thumbHref.startsWith('/avatars/') &&
        data.nameHref && data.nameHref.startsWith('/avatars/');
      record('gallery card hrefs', ok ? 'PASS' : 'FAIL', JSON.stringify(data));
      await page.close();
    }

    // ---------------- Step 2: discover ----------------
    {
      const page = await context.newPage();
      await collectConsole(page, 'discover', errors);
      let urlsToTry = [
        'http://localhost:3000/discover/',
        'http://localhost:3000/discover/?source=avatars',
      ];
      let found = null;
      for (const url of urlsToTry) {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        try {
          await page.waitForSelector('.explore-card--avatar', { timeout: 12000 });
          found = url;
          break;
        } catch (_) {
          // try next
        }
      }
      if (!found) {
        record('discover avatar card present', 'FAIL', 'no .explore-card--avatar found on either url');
      } else {
        await page.waitForTimeout(500);
        const data = await page.evaluate(() => {
          const card = document.querySelector('.explore-card--avatar');
          if (!card) return null;
          const thumb = card.querySelector('.explore-card-thumb');
          const name = card.querySelector('.explore-card-name-link');
          return {
            thumbHref: thumb ? thumb.getAttribute('href') : null,
            nameHref: name ? name.getAttribute('href') : null,
          };
        });
        const ok =
          data &&
          data.thumbHref && data.thumbHref.startsWith('/avatars/') &&
          data.nameHref && data.nameHref.startsWith('/avatars/');
        record(`discover card hrefs (via ${found})`, ok ? 'PASS' : 'FAIL', JSON.stringify(data));
        // Save first avatar href for step 3
        if (data && data.thumbHref) {
          global.__firstAvatarHref = data.thumbHref;
        }
      }
      await page.close();
    }

    // ---------------- Step 3: avatar studio page ----------------
    {
      const page = await context.newPage();
      await collectConsole(page, 'avatar-studio', errors);
      const href = global.__firstAvatarHref || '/avatars/b8e1babc-a62a-4058-ae4e-8d09cd4fa07a';
      const url = href.startsWith('http') ? href : `http://localhost:3000${href}`;
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      const title = await page.title();
      const dom = await page.evaluate(() => {
        const actionbar = document.querySelector('.av-actionbar');
        const related = document.querySelector('.av-related');
        let backLink = null;
        if (actionbar) {
          const a = actionbar.querySelector('a[href*="marketplace" i], a[href*="Marketplace" i]');
          backLink = a ? a.getAttribute('href') : null;
          if (!backLink) {
            // fallback: any link whose text mentions marketplace
            const all = Array.from(actionbar.querySelectorAll('a'));
            const hit = all.find((el) => /marketplace/i.test(el.textContent || ''));
            backLink = hit ? hit.getAttribute('href') : null;
          }
        }
        return {
          hasActionbar: !!actionbar,
          hasRelated: !!related,
          backLink,
        };
      });
      const ok =
        /Avatar Studio · three\.ws/.test(title) &&
        dom.hasActionbar &&
        dom.hasRelated &&
        !!dom.backLink;
      record('avatar studio page loads', ok ? 'PASS' : 'FAIL', JSON.stringify({ url, title, ...dom }));
      await page.close();
    }

    // ---------------- Step 4: legacy redirect ----------------
    {
      const page = await context.newPage();
      await collectConsole(page, 'legacy', errors);
      const target = 'http://localhost:3000/discover/avatar/b8e1babc-a62a-4058-ae4e-8d09cd4fa07a';
      await page.goto(target, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(800);
      const finalUrl = page.url();
      const ok = /\/avatars\/b8e1babc-a62a-4058-ae4e-8d09cd4fa07a/.test(finalUrl);
      record('legacy /discover/avatar/:id redirect', ok ? 'PASS' : 'FAIL', finalUrl);
      await page.close();
    }
  } catch (err) {
    record('script error', 'FAIL', err.stack || err.message);
  } finally {
    await browser.close();
  }

  console.log('\n=== SUMMARY ===');
  for (const r of results) console.log(`${r.status} — ${r.step}: ${r.detail}`);
  console.log('\n=== CONSOLE ERRORS ===');
  if (errors.length === 0) console.log('(none)');
  else for (const e of errors) console.log(e);

  const anyFail = results.some((r) => r.status === 'FAIL');
  process.exit(anyFail ? 1 : 0);
})();
