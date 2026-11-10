// Product previews for the home page (views/home.ejs), drawn from the real
// pages with sample data: the dashboard, the Money page and the community
// home, plus the image shown when the site is shared (og.jpg).
//
//   node scripts/home_shots.js
//
// It renders each page the way its test does (test/dashboard.js, test/money.js,
// test/community.js write their pages as HTML), then photographs one part of
// each with the browser Playwright installs. Run it again after a page changes.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'img', 'home');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'home-shots-'));
const run = (test, env) => execFileSync(process.execPath, [path.join(ROOT, 'test', test)], { env: Object.assign({}, process.env, env), stdio: 'ignore' });

run('dashboard.js', { DASH_OUT: tmp });
run('money.js', { MONEY_OUT: tmp });
run('community.js', { COMM_OUT: tmp });

// Hide the site chrome; only the product shows.
const CLEAN = `
  .nav, .appnav, .appbar, .site-footer, footer, .dash-customize { display: none !important; }
  * { transition: none !important; animation: none !important; }
  .reveal { opacity: 1 !important; transform: none !important; }
  body { padding: 0 !important; }`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const shoot = async (file, selector, out, { width = 1180, height = 900, scale = 1.5, maxHeight = null } = {}) => {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
    await page.goto('file://' + path.join(tmp, file));
    await page.addStyleTag({ content: CLEAN });
    await page.evaluate(() => document.querySelectorAll('*').forEach(e => { if (getComputedStyle(e).opacity === '0') e.style.opacity = 1; }));
    await page.waitForTimeout(300);
    const el = await page.$(selector);
    if (!el) throw new Error(selector + ' not found in ' + file);
    const box = await el.boundingBox();
    // Tall pages are cropped to their top: that is the part worth showing.
    await page.screenshot({ path: path.join(OUT, out), type: 'jpeg', quality: 82, fullPage: true,
      clip: { x: box.x, y: box.y, width: box.width, height: maxHeight ? Math.min(box.height, maxHeight) : box.height } });
    await page.close();
    console.log('wrote', out);
  };
  await shoot('dash.html', '.dash', 'dashboard.jpg', { maxHeight: 720 });
  await shoot('money.html', '.money-ov', 'money.jpg', { width: 1100 });
  await shoot('home.html', '.ch', 'community.jpg', { maxHeight: 760 });

  // The share image: 1200×630, the name, the line, and the dashboard behind it.
  const og = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  const shot = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(OUT, 'dashboard.jpg')).toString('base64');
  await og.setContent(`<!doctype html><html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Sora:wght@700;800&family=Manrope:wght@500;600&display=swap"><style>
    body { margin: 0; width: 1200px; height: 630px; background: #0b3d2e; font-family: Manrope, sans-serif; color: #eafff5; overflow: hidden; position: relative; }
    .txt { position: absolute; left: 72px; top: 92px; width: 560px; }
    .brand { font-family: Sora, sans-serif; font-weight: 800; font-size: 34px; letter-spacing: -.01em; }
    h1 { font-family: Sora, sans-serif; font-size: 58px; line-height: 1.05; margin: 34px 0 22px; letter-spacing: -.02em; }
    h1 span { color: #34d399; }
    p { font-size: 25px; line-height: 1.4; color: #b7e4d0; margin: 0; }
    .shot { position: absolute; left: 660px; top: 70px; width: 760px; border-radius: 18px; box-shadow: 0 30px 80px rgba(0,0,0,.45); }
  </style></head><body>
    <div class="txt"><div class="brand">NoBossly</div><h1>Build your way out of the <span>9 to 5.</span></h1><p>A free workspace and community for people building a business around a job.</p></div>
    <img class="shot" src="${shot}">
  </body></html>`, { waitUntil: 'networkidle' });
  await og.screenshot({ path: path.join(OUT, 'og.jpg'), type: 'jpeg', quality: 85 });
  console.log('wrote og.jpg');
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
