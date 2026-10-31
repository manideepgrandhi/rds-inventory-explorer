// Headless-Chrome check of the Insights tab: node insights_check.js <report.html> [csv_dir] [shots_dir]
// Covers totals, bars, filters, CSV export (== script CSV), facet click -> filtered Inventory + chip,
// no JS errors, no network. XSS=1: the page is a tampered merge; asserts no injected script ran.
const p = require('puppeteer-core'), path = require('path'), fs = require('fs');
const fails = []; let n = 0; const ok = (c, m) => { n++; if (!c) fails.push(m); };
const sleep = ms => new Promise(x => setTimeout(x, ms));
(async () => {
  const file = path.resolve(process.argv[2]), CSVD = process.argv[3], shots = process.argv[4];
  const b = await p.launch({executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox']});
  const g = await b.newPage(); const errs = [], net = [];
  g.on('pageerror', e => errs.push(e.message)); g.on('console', m => m.type() === 'error' && errs.push(m.text()));
  g.on('dialog', d => { errs.push('dialog: ' + d.message()); d.dismiss(); });
  await g.setRequestInterception(true);
  g.on('request', r => { if (!/^(file|blob|data):/.test(r.url())) net.push(r.url()); if (/^file:/.test(r.url()) && !r.url().startsWith('file://' + file)) net.push(r.url()); r.continue(); });
  await g.evaluateOnNewDocument(() => {
    window.__dl = []; window.__blobOf = {};
    const oc = URL.createObjectURL.bind(URL); URL.createObjectURL = x => { const u = oc(x); window.__blobOf[u] = x; return u; };
    const ck = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__dl.push({name: this.download, href: this.href}); return; } return ck.call(this); };
  });
  await g.setViewport({width: 1440, height: 1000});
  await g.goto('file://' + file + '#tab=insights'); await sleep(250);
  const D = await g.evaluate(() => JSON.parse(document.getElementById('explorer-data').textContent));
  const F = D.insights.findings;
  const st = () => g.evaluate(() => ({
    rows: document.querySelectorAll('#in-table tbody tr').length, shown: (document.getElementById('in-shown') || {}).textContent,
    tb: !document.getElementById('in-toolbar').hidden, bars: document.querySelectorAll('#in-facets .bar').length,
    w: [...document.querySelectorAll('#in-facets .bar i')].map(e => e.style.width), badge: (document.getElementById('tab-insights-n') || {}).textContent}));
  const lastDl = () => g.evaluate(async () => { const d = window.__dl[window.__dl.length - 1]; if (!d) return null;
    return {name: d.name, bytes: Array.from(new Uint8Array(await window.__blobOf[d.href].arrayBuffer()))}; });
  if (process.env.XSS) {
    await g.goto('file://' + file); await sleep(200);
    await g.evaluate(() => { location.hash = '#tab=insights'; }); await sleep(200);
    const s = await st();
    ok(s.rows > 0, 'xss page: findings render');
    const hid = await g.evaluate(() => JSON.parse(document.getElementById('explorer-data').textContent).resources.find(x => /onerror/.test(x.name)).id);
    await g.evaluate(id => { location.hash = '#id=' + encodeURIComponent(id); }, hid); await sleep(200);
    const hostile = await g.evaluate(() => ({pw: window.__pwned || 0, img: document.querySelectorAll('img').length, scripts: document.scripts.length,
      txt: (document.querySelector('#card h2') || {}).textContent || ''}));
    ok(hostile.pw === 0 && hostile.img === 0 && hostile.scripts === 3 && hostile.txt.includes('<img src=x onerror') && hostile.txt.includes('</script>'), 'xss: hostile names shown as text, nothing executed: ' + JSON.stringify(hostile));
    await g.evaluate(() => { location.hash = '#tab=inventory'; }); await sleep(150);
    await g.click('#q'); await g.keyboard.type('img'); await sleep(200);
    ok(await g.evaluate(() => (window.__pwned || 0) === 0 && document.querySelectorAll('img').length === 0), 'xss: search suggestions inert');
  } else {
    const s = await st();
    ok(s.tb && s.bars > 0 && s.badge === String(F.length), 'insights tab, bars and badge: ' + JSON.stringify(s));
    ok(s.w.every(x => /^\d+%$/.test(x)) && s.w.includes('100%'), 'bar widths set via style (CSP-safe)');
    ok(s.rows === F.length, 'findings table has every finding');
    const csp = await g.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]').content);
    ok(/default-src 'none'/.test(csp) && !/unsafe-eval/.test(csp), 'CSP default-src none');
    const ids = new Set(F.map(f => f.check)), all = D.insights.checks.filter(c => !c.skipped).map(c => c.id);
    if (process.env.ALL_CHECKS) ok(all.every(c => ids.has(c)), 'every check fires on the audit fleet: missing ' + all.filter(c => !ids.has(c)).join(','));
    if (shots) await g.screenshot({path: path.join(shots, '01_insights.png'), fullPage: true});
    // full export == script CSV
    await g.click('#in-csv'); await sleep(100);
    let d = await lastDl();
    ok(d && path.basename(file).replace(/\.html$/, '_insights_findings.csv') === d.name, 'findings CSV name: ' + (d && d.name));
    if (CSVD) { const f = fs.readdirSync(CSVD).find(x => /_insights_findings\.csv$/.test(x));
      ok(f && Buffer.compare(fs.readFileSync(path.join(CSVD, f)), Buffer.from(d.bytes)) === 0, 'findings CSV from the page == script CSV, byte for byte'); }
    // severity filter
    await g.select('#if-sev', 'High'); await sleep(100);
    const hi = F.filter(f => f.sev === 'High').length;
    ok((await st()).rows === hi && hi > 0, 'severity filter High: ' + hi);
    await g.click('#in-csv'); await sleep(100); d = await lastDl();
    ok(Buffer.from(d.bytes).toString('utf8').trim().split('\r\n').length === hi + 1, 'filtered CSV export = shown rows');
    await g.select('#if-sev', ''); const c0 = F[0].check; await g.select('#if-check', c0); await sleep(100);
    ok((await st()).rows === F.filter(f => f.check === c0).length, 'check filter');
    const acct = F[0].account; await g.select('#if-account', acct); await sleep(100);
    ok((await st()).rows === F.filter(f => f.check === c0 && f.account === acct).length, 'account filter combines');
    if (shots) await g.screenshot({path: path.join(shots, '02_insights_filtered.png'), fullPage: false});
    await g.click('#iclear'); await sleep(100);
    ok((await st()).rows === F.length, 'clear filters');
    // facet click -> filtered Inventory with chip
    const href = await g.evaluate(() => { const a = document.querySelector('#in-facets [data-facet="engine"] .bar a'); return [a.getAttribute('href'), a.textContent, a.parentNode.querySelector('.n').textContent]; });
    await g.click('#in-facets [data-facet="engine"] .bar a'); await sleep(200);
    const inv = await g.evaluate(() => ({h: decodeURIComponent(location.hash), chip: (document.getElementById('facet-chip') || {}).textContent, rows: document.querySelectorAll('#list tbody tr').length, inv: !document.getElementById('inv-toolbar').hidden}));
    ok(inv.inv && inv.h.includes('f=engine') && inv.chip && inv.chip.includes(href[1]), 'facet click opens Inventory with chip: ' + JSON.stringify(inv));
    ok(inv.rows === Number(href[2]), 'facet count == Inventory rows (' + href[2] + ' vs ' + inv.rows + ')');
    if (shots) await g.screenshot({path: path.join(shots, '03_facet_inventory.png'), fullPage: false});
    await g.click('#facet-clear'); await sleep(150);
    ok(await g.evaluate(() => !document.getElementById('facet-chip') && !/f=/.test(location.hash)), 'chip × clears facet');
    // finding link opens the resource card
    await g.evaluate(() => { location.hash = '#tab=insights'; }); await sleep(150);
    await g.click('#in-table tbody tr a'); await sleep(200);
    ok(await g.evaluate(() => !!document.getElementById('card')), 'finding resource link opens its card');
    // mobile
    await g.setViewport({width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2});
    await g.evaluate(() => { location.hash = '#tab=insights'; }); await sleep(200);
    ok(await g.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, 'insights mobile: no sideways scroll');
    if (shots) await g.screenshot({path: path.join(shots, '04_insights_mobile.png'), fullPage: false});
  }
  ok(errs.length === 0, 'no JS errors: ' + errs.join('; '));
  ok(net.length === 0, 'no network: ' + net.join(' '));
  console.log(JSON.stringify({fails, passed: n - fails.length, total: n}));
  await b.close(); process.exit(fails.length ? 1 : 0);
})().catch(e => { fails.push(String(e && e.stack || e)); console.log(JSON.stringify({fails})); process.exit(1); });
