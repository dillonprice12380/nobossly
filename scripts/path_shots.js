// The share image for each public path page (public/img/paths/<slug>.jpg,
// 1200×630): the path, its line, and what its dashboard puts first. Built
// from the same config as the page, so run it again after a path changes.
//
//   node scripts/path_shots.js

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const paths = require('../src/paths');
const pages = require('../src/path_pages');

const OUT = path.join(__dirname, '..', 'public', 'img', 'paths');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  for (const def of paths.MARKETED) {
    const s = pages.summaryOf(def.slug);
    const tiles = s.numbers.slice(0, 4).map((n, i) => `<div class="t${i ? '' : ' lead'}"><span>${esc(n)}</span><b>—</b></div>`).join('');
    const boards = s.boards.slice(0, 2).map(b => `<div class="b"><strong>${esc(b.emoji + ' ' + b.label)}</strong><i></i><i></i><i class="s"></i></div>`).join('');
    const tools = s.tools.slice(0, 4).map(t => `<span>${esc(t.emoji + ' ' + t.label)}</span>`).join('');
    await page.setContent(`<!doctype html><html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Sora:wght@700;800&family=Manrope:wght@500;600;700&display=swap"><style>
      body { margin: 0; width: 1200px; height: 630px; background: #0b3d2e; font-family: Manrope, sans-serif; color: #eafff5; overflow: hidden; position: relative; }
      .txt { position: absolute; left: 68px; top: 70px; width: 540px; }
      .brand { font-family: Sora, sans-serif; font-weight: 800; font-size: 30px; }
      .kick { margin-top: 44px; font-size: 26px; font-weight: 700; color: #34d399; }
      h1 { font-family: Sora, sans-serif; font-size: 44px; line-height: 1.1; margin: 14px 0 0; letter-spacing: -.02em; }
      .card { position: absolute; left: 650px; top: 70px; width: 500px; max-height: 490px; padding-bottom: 14px; border-radius: 20px; background: #f7faf9; color: #0f172a; box-shadow: 0 30px 80px rgba(0,0,0,.45); overflow: hidden; }
      .bar { padding: 16px 22px; font-weight: 700; font-size: 19px; border-bottom: 1px solid #e2e8f0; background: #eef5f2; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 18px 22px 6px; }
      .t { border: 1px solid #dbe4e0; border-radius: 12px; padding: 12px 14px; background: #fff; }
      .t.lead { border-color: #10b981; }
      .t span { display: block; font-size: 15px; color: #64748b; }
      .t b { font-size: 26px; }
      .boards { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 8px 22px; }
      .b { border: 1px dashed #cbd5e1; border-radius: 12px; padding: 12px 14px; }
      .b strong { font-size: 15px; display: block; margin-bottom: 8px; }
      .b i { display: block; height: 9px; border-radius: 6px; background: #e2e8f0; margin: 6px 0; }
      .b i.s { width: 60%; }
      .tools { padding: 10px 22px; display: flex; flex-wrap: wrap; gap: 8px; }
      .tools em { width: 100%; font-style: normal; font-size: 14px; color: #64748b; }
      .tools span { font-size: 15px; padding: 6px 12px; border-radius: 999px; border: 1px solid #dbe4e0; background: #fff; }
    </style></head><body>
      <div class="txt"><div class="brand">NoBossly</div><div class="kick">${esc(def.emoji + ' ' + def.label)}</div><h1>${esc(def.marketing.headline)}</h1></div>
      <div class="card"><div class="bar">${esc(def.emoji)} Your ${esc(pages.wordsFor(def).noun)} dashboard</div><div class="grid">${tiles}</div><div class="boards">${boards}</div><div class="tools"><em>Tools up front</em>${tools}</div></div>
    </body></html>`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: path.join(OUT, def.slug + '.jpg'), type: 'jpeg', quality: 84 });
    console.log('wrote', def.slug + '.jpg');
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
