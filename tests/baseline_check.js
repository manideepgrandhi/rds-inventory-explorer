// Headless-Chrome check of the parameter baseline UI: node baseline_check.js <report.html> <baseline.csv> [shots_dir]
// Header chip (-> Show problems), per-account summary, Baseline parameter fleet table + counts, status colours,
// resource-card Baseline section, page CSV == script _baseline.csv, XSS, mobile, no errors, no network.
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
  ok(await g.evaluate(() => /sh=problems/.test(location.hash) && document.getElementById('xf-show').value === 'problems'), 'chip opens Parameters with Show: problems only');
  const sum = await g.evaluate(() => (document.getElementById('bl-summary') || {}).textContent || '');
  ok(sum.includes(BL.file) && BL.accounts.every(a => sum.includes(a.account) && sum.includes(a.off + ' of ' + a.resources)), 'per-account baseline summary line: ' + sum);
  const offN = R.filter(r => r.bl && r.bl.dev > 0).length;
  const shown = await g.evaluate(() => document.querySelectorAll('#view .pres:not(.pgrp)').length);
  ok(shown >= offN, 'problems view lists every off-baseline resource ' + shown + '/' + offN);
  if (shots) await g.screenshot({path: shots + '/02_problems_only.png', fullPage: false});
  // PG18 log_connections
  const pg18 = R.filter(r => /pg18/.test(r.name));
  const lc = pg18.map(r => [r.name, (r.bl.results.find(x => x.param === 'log_connections') || {}).status]);
  ok(lc.some(x => x[0].startsWith('analytics') && x[1] === 'pass') && lc.some(x => x[0].startsWith('reports') && x[1] === 'fail'), 'pg18 log_connections ' + JSON.stringify(lc));
  // Baseline parameter dropdown: grouped by engine, plus Any
  const og = await g.evaluate(() => [...document.querySelectorAll('#xf-bparam optgroup')].map(o => [o.label, o.children.length]));
  const fams = [...new Set(BL.rule_list.map(r => r.family))];
  ok(og.length === fams.length && og.reduce((a, x) => a + x[1], 0) === new Set(BL.rule_list.map(r => r.family + '|' + r.param)).size && await g.evaluate(() => document.querySelector('#xf-bparam option').value === ''), 'baseline parameter list grouped by engine ' + JSON.stringify(og));
  await nav('#tab=parameters&bp=postgres%7Cshared_preload_libraries');
  const bt = await g.evaluate(() => ({cols: [...document.querySelectorAll('#bp-table thead th')].map(t => t.textContent).join('|'), cnt: document.getElementById('bp-count').textContent,
    st: [...document.querySelectorAll('#bp-table tbody tr')].map(tr => tr.className)}));
  ok(bt.cols === 'Account|Region|Resource|Engine / version|Actual|Expected|Status|Comes from', 'fleet table columns ' + bt.cols);
  const want = R.filter(r => r.bl && r.bl.results.some(x => x.param === 'shared_preload_libraries') && /postgres/.test(r.section || ''));
  const bad = (r, k) => (r.values[k] && r.values[k].flag) || r.bl.results.some(x => x.param === k && (x.status === 'fail' || x.status === 'missing'));   // red = baseline fail OR security flag
  const nf = want.filter(r => bad(r, 'shared_preload_libraries')).length;
  ok(bt.st.length === want.length && bt.st.filter(c => /r-bad/.test(c)).length === nf && new RegExp('^' + want.length + ' resources: .*' + nf + ' fail').test(bt.cnt), 'fleet table rows/counts ' + bt.cnt);
  if (shots) await g.screenshot({path: shots + '/03_baseline_parameter.png'});
  // unfiltered baseline CSV == script
  await nav('#tab=parameters');
  ok(await g.evaluate(() => [...document.querySelectorAll('.plegend')].some(e => /fails the baseline/.test(e.textContent))), 'legend explains the colours');
  await g.click('#px-bcsv'); await sleep(200);
  const dl = await g.evaluate(async () => { const d = window.__dl[window.__dl.length - 1]; return {name: d.name, bytes: Array.from(new Uint8Array(await window.__blobOf[d.href].arrayBuffer()))}; });
  const script = fs.readFileSync(CSVF);
  ok(Buffer.from(dl.bytes).equals(script), 'page baseline CSV == script ' + path.basename(CSVF) + ' (' + dl.bytes.length + ' vs ' + script.length + ' bytes)');
  ok(path.basename(CSVF) === dl.name, 'csv name ' + dl.name);
  await nav('#tab=parameters&sh=problems'); await g.click('#px-bcsv'); await sleep(200);
  const dl1 = await g.evaluate(async () => { const d = window.__dl[window.__dl.length - 1]; return await window.__blobOf[d.href].text(); });
  const nbad = R.reduce((a, r) => a + (r.bl ? r.bl.results.filter(x => bad(r, x.param)).length : 0), 0);
  ok(dl1.trim().split('\r\n').length === nbad + 1, 'baseline CSV with Show problems = baseline rows of the red parameters only ' + nbad);
  // status colours in the resource detail
  await nav('#tab=parameters&res=' + encodeURIComponent(R.find(r => r.bl && r.bl.dev > 0).res_id));
  const col = await g.evaluate(() => ({bad: document.querySelectorAll('.pres[data-open=true] tr.r-bad').length, ok: document.querySelectorAll('.pres[data-open=true] .st-ok').length, exp: [...document.querySelectorAll('.pres[data-open=true] .ptab tbody tr')].some(tr => tr.cells[2].textContent.length > 0)}));
  ok(col.bad > 0 && col.ok > 0 && col.exp, 'detail rows coloured, Expected filled ' + JSON.stringify(col));
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
  await g.setViewport({width: 390, height: 844}); await nav('#tab=parameters&bp=postgres%7Crds.force_ssl');
  const wide = await g.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  ok(wide, 'mobile: no horizontal scroll');
  if (shots) await g.screenshot({path: shots + '/06_mobile_baseline_parameter.png'});
  ok(!errs.length, 'js errors: ' + errs.join(' | ')); ok(!net.length, 'network: ' + net.join(' '));
  await b.close();
  console.log((fails.length ? 'FAIL' : 'ok') + ' baseline_check: ' + (n - fails.length) + '/' + n);
  fails.forEach(f => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
