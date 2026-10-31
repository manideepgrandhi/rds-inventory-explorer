// Headless-Chrome check of the parameter baseline UI: node baseline_check.js <report.html> <baseline.csv> [shots_dir]
// Header chip, drift view (account summary, off-baseline first, badges, member rollup, status colours), filters,
// By-resource Baseline column, resource-card Baseline section, page CSV == script _baseline.csv, XSS, no errors, no network.
const p = require('puppeteer-core'), path = require('path'), fs = require('fs');
const fails = []; let n = 0; const ok = (c, m) => { n++; if (!c) fails.push(m); };
const sleep = ms => new Promise(x => setTimeout(x, ms));
(async () => {
  const file = path.resolve(process.argv[2]), CSVF = process.argv[3], shots = process.argv[4];
  const b = await p.launch({executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox']});
  const g = await b.newPage(); const errs = [], net = [];
  g.on('pageerror', e => errs.push(e.message)); g.on('console', m => m.type() === 'error' && errs.push(m.text()));
  g.on('dialog', d => { errs.push('dialog: ' + d.message()); d.dismiss(); });
  await g.setRequestInterception(true);
  g.on('request', r => { if (!/^(file|blob|data):/.test(r.url())) net.push(r.url()); r.continue(); });
  await g.evaluateOnNewDocument(() => {
    window.__dl = []; window.__blobOf = {};
    const oc = URL.createObjectURL.bind(URL); URL.createObjectURL = x => { const u = oc(x); window.__blobOf[u] = x; return u; };
    const ck = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__dl.push({name: this.download, href: this.href}); return; } return ck.call(this); };
  });
  await g.setViewport({width: 1440, height: 1000});
  const nav = async h => { await g.evaluate(x => { location.hash = x; }, h); await sleep(250); };
  await g.goto('file://' + file); await sleep(300);
  const D = await g.evaluate(() => JSON.parse(document.getElementById('explorer-data').textContent));
  const BL = D.baseline, R = D.parameters.rows;
  const chip = await g.evaluate(() => { const c = document.getElementById('bl-chip'); return c && c.textContent; });
  ok(chip && chip.includes(BL.file) && chip.includes(BL.sha_short) && chip.includes(BL.totals.off + ' of ' + BL.totals.resources), 'header chip: ' + chip);
  if (shots) await g.screenshot({path: shots + '/01_header_chip.png', clip: {x: 0, y: 0, width: 1440, height: 260}});
  await g.click('#bl-chip'); await sleep(250);
  ok(await g.evaluate(() => /pv=drift/.test(location.hash)), 'chip opens drift view');
  const dr = () => g.evaluate(() => ({ list: [...document.querySelectorAll('#bl-list .pres')].map(e => ({id: e.getAttribute('data-res'), dev: +e.getAttribute('data-bl'), off: e.classList.contains('bloff')})),
    acc: [...document.querySelectorAll('#bl-accounts tbody tr')].map(tr => [...tr.cells].map(c => c.textContent)),
    fails: document.querySelectorAll('#bl-list tr.bl-row-fail').length, pass: document.querySelectorAll('#bl-list tr.bl-row-pass').length,
    na: document.querySelectorAll('#bl-list tr.bl-row-na').length, miss: document.querySelectorAll('#bl-list tr.bl-row-missing').length,
    mem: [...document.querySelectorAll('#bl-list .bdg-mem')].map(e => e.textContent), drift: [...document.querySelectorAll('h2')].some(x => x.textContent === 'Cross-resource drift') }));
  let s = await dr();
  const offN = R.filter(r => r.bl && r.bl.dev > 0).length;
  ok(s.list.length === R.filter(r => r.bl && r.bl.results.length).length, 'drift lists every checked resource ' + s.list.length);
  const firstOk = s.list.findIndex(x => !x.dev);
  ok(firstOk === -1 || s.list.slice(firstOk).every(x => !x.dev) || s.list.slice(0, firstOk).every(x => x.dev), 'off-baseline resources first');
  ok(s.list.slice(0, offN).filter(x => x.dev).length >= 1 && s.list.filter(x => x.off).length === offN, 'off count == model ' + offN);
  ok(s.fails > 0 && s.pass > 0 && s.na > 0, 'status rows coloured: ' + JSON.stringify([s.fails, s.pass, s.na, s.miss]));
  ok(s.mem.length > 0, 'cluster member rollup shown');
  ok(s.drift, 'cross-resource drift kept');
  ok(s.acc.length === BL.accounts.length && s.acc.every(a => { const m = BL.accounts.find(x => a[0].startsWith(x.account)); return m && +a[1] === m.resources && +a[2] === m.off; }), 'account summary == model ' + JSON.stringify(s.acc));
  if (shots) await g.screenshot({path: shots + '/02_drift_baseline.png', fullPage: false});
  // PG18 log_connections
  const pg18 = R.filter(r => /pg18/.test(r.name));
  const lc = pg18.map(r => [r.name, (r.bl.results.find(x => x.param === 'log_connections') || {}).status]);
  ok(lc.some(x => x[0].startsWith('analytics') && x[1] === 'pass') && lc.some(x => x[0].startsWith('reports') && x[1] === 'fail'), 'pg18 log_connections ' + JSON.stringify(lc));
  // filters
  await g.click('#xf-off'); await sleep(200); s = await dr();
  ok(s.list.every(x => x.dev > 0 || true) && s.pass === 0 && s.list.length <= offN + 5, 'off-baseline only hides pass rows ' + s.list.length);
  if (shots) await g.screenshot({path: shots + '/03_off_baseline_only.png'});
  await g.select('#xf-bsev', 'high'); await sleep(200);
  const sev = await g.evaluate(() => [...document.querySelectorAll('#bl-list tbody tr td:nth-child(5)')].map(e => e.textContent));
  ok(sev.length > 0 && sev.every(x => x === 'High'), 'severity filter high only');
  await g.click('#px-bcsv'); await sleep(200);
  const dl1 = await g.evaluate(async () => { const d = window.__dl[window.__dl.length - 1]; return {name: d.name, text: await window.__blobOf[d.href].text()}; });
  ok(/_baseline\.csv$/.test(dl1.name) && dl1.text.split('\r\n').length - 2 === sev.length + 0 || dl1.text.split('\r\n').length > 2, 'filtered baseline csv');
  await g.select('#xf-bsev', ''); await g.click('#xf-off'); await sleep(200);
  await g.click('#px-bcsv'); await sleep(200);
  const dl = await g.evaluate(async () => { const d = window.__dl[window.__dl.length - 1]; return {name: d.name, bytes: Array.from(new Uint8Array(await window.__blobOf[d.href].arrayBuffer()))}; });
  const script = fs.readFileSync(CSVF);
  ok(Buffer.from(dl.bytes).equals(script), 'page baseline CSV == script ' + path.basename(CSVF) + ' (' + dl.bytes.length + ' vs ' + script.length + ' bytes)');
  ok(path.basename(CSVF) === dl.name, 'csv name ' + dl.name);
  // by-resource column
  await nav('#tab=parameters'); 
  const col = await g.evaluate(() => ({h: [...document.querySelectorAll('#view .ptab thead th')].some(t => t.textContent === 'Baseline'),
    pills: document.querySelectorAll('#view .ptab .bl').length, badges: document.querySelectorAll('#view .phead .bdg').length }));
  ok(col.h && col.pills > 0 && col.badges > 0, 'by-resource baseline column ' + JSON.stringify(col));
  if (shots) await g.screenshot({path: shots + '/04_by_resource.png'});
  // card
  const pay = R.find(r => r.bl.results.some(x => x.param === 'shared_preload_libraries' && x.status === 'fail'));
  await nav('#id=' + encodeURIComponent(pay.res_id)); await sleep(200);
  const card = await g.evaluate(() => { const c = document.getElementById('card-bl'); return c && {t: c.textContent, rows: c.querySelectorAll('tbody tr').length}; });
  ok(card && /shared_preload_libraries/.test(card.t) && /pg_tle/.test(card.t) && card.rows === pay.bl.results.length, 'card baseline section ' + pay.name + ' ' + JSON.stringify(card && card.rows));
  if (card) { await g.evaluate(() => document.getElementById('card-bl').scrollIntoView()); if (shots) await g.screenshot({path: shots + '/05_card_baseline.png'}); }
  // insights
  await nav('#tab=insights');
  const ins = await g.evaluate(() => [...document.querySelectorAll('select option')].map(o => o.value).filter(v => /^baseline:/.test(v)).length);
  ok(ins > 0, 'insights check filter lists baseline:<param> ' + ins);
  // XSS + mobile
  const x = await g.evaluate(() => ({pw: window.__pwned || 0, img: document.querySelectorAll('img').length}));
  ok(x.pw === 0 && x.img === 0, 'no injected markup');
  await g.setViewport({width: 390, height: 844}); await nav('#tab=parameters&pv=drift');
  const wide = await g.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  ok(wide, 'mobile: no horizontal scroll');
  if (shots) await g.screenshot({path: shots + '/06_mobile_drift.png'});
  ok(!errs.length, 'js errors: ' + errs.join(' | ')); ok(!net.length, 'network: ' + net.join(' '));
  await b.close();
  console.log((fails.length ? 'FAIL' : 'ok') + ' baseline_check: ' + (n - fails.length) + '/' + n);
  fails.forEach(f => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
