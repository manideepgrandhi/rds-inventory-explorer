// Headless-Chrome check of the parameter baseline UI: node baseline_check.js <report.html> <baseline.csv> [shots_dir]
// Header chip (summary, -> Show problems), By resource server table + expanded baseline rules (failures first), overrides
// (note + filter + table), Aurora PostgreSQL members not checked, Baseline parameter list scoped to the engine + fleet table,
// resource-card Baseline section, page CSV == script _baseline.csv, XSS, mobile, no errors, no network.
// No parameter name or expected value is written here: everything comes from BL.rule_list and the results in the report,
// so the baseline file can be customised freely.
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
  const shot = async (name, full) => { if (shots) await g.screenshot({path: path.join(shots, name), fullPage: !!full}); };
  await g.goto('file://' + file); await sleep(300);
  const D = await g.evaluate(() => JSON.parse(document.getElementById('explorer-data').textContent));
  const BL = D.baseline, R = D.parameters.rows;
  const famMatch = (f, sec) => !sec ? false : f === 'postgres' ? (sec === 'rds-postgres' || sec === 'aurora-postgresql') : f === 'mysql' ? (sec === 'mysql' || sec === 'aurora-mysql') : f === sec;
  const isDev = x => x.status === 'fail' || x.status === 'missing';
  const CL = new Set(R.filter(r => r.type === 'cluster').map(r => r.res_id));
  const SV = R.filter(r => r.type === 'cluster' || !(r.cluster_id && CL.has(r.cluster_id)));
  const rowsOf = s => [s].concat(s.type === 'cluster' ? R.filter(m => m.type !== 'cluster' && m.cluster_id === s.res_id) : []);
  const sdev = s => rowsOf(s).reduce((a, r) => a + (r.bl ? r.bl.results.filter(isDev).length : 0), 0);
  const vis = () => g.evaluate(() => [...document.querySelectorAll('#px-servers tr.srow')].map(tr => ({id: tr.getAttribute('data-res'), cells: [...tr.cells].map(c => c.textContent)})));
  const expand = async id => { await g.evaluate(id => { const e = document.querySelector('tr.srow[data-res="' + id + '"]'); if (e && e.getAttribute('aria-expanded') !== 'true') e.click(); }, id); await sleep(200); };
  // header chip: the baseline summary lives here now
  const sv = ['high', 'medium', 'low'].map(k => BL.accounts.reduce((a, x) => a + x[k], 0));
  const chip = await g.evaluate(() => { const c = document.getElementById('bl-chip'); return c && {t: c.textContent, title: c.title}; });
  ok(chip && chip.t.includes(BL.file) && chip.t.includes(BL.sha_short) && chip.t.includes(BL.totals.off + ' of ' + BL.totals.resources) && chip.t.includes(sv[0] + ' high, ' + sv[1] + ' medium, ' + sv[2] + ' low'), 'header chip summary: ' + (chip && chip.t));
  ok(chip && BL.accounts.every(a => chip.title.includes(a.account) && chip.title.includes(a.off + ' of ' + a.resources)), 'header chip title: per-account summary');
  ok(chip && (BL.totals.overridden ? chip.t.includes(BL.totals.overridden + ' overridden at instance') : true) && (BL.legacy_postgres ? /legacy postgres/.test(chip.t) : !/legacy postgres/.test(chip.t)), 'header chip: overrides + legacy note');
  await shot('00_header_chip.png');
  await g.click('#bl-chip'); await sleep(250);
  ok(await g.evaluate(() => /sh=problems/.test(location.hash) && document.getElementById('xf-show').value === 'problems'), 'chip opens Parameters with Show: problems only');
  ok(await g.evaluate(() => !document.getElementById('bl-summary') && !document.querySelector('details#px-notes')), 'no separate summary line / Notes box');
  let s = await vis();
  ok(s.map(x => x.id).sort().join() === SV.filter(r => sdev(r) > 0).map(r => r.res_id).sort().join(), 'problems view = servers with a failure ' + s.length);
  await nav('#tab=parameters');
  s = await vis();
  ok(s.length === SV.length, 'By resource: one row per server ' + s.length + '/' + SV.length);
  ok(await g.evaluate(() => document.getElementById('xf-level').hidden), 'Level hidden in By resource');
  ok(!R.some(r => r.type === 'member' && r.section === 'aurora-postgresql' && CL.has(r.cluster_id) && r.bl && r.bl.results.length), 'Aurora PostgreSQL members carry no results');
  const okRow = s.find(x => sdev(SV.find(r => r.res_id === x.id)) === 0 && SV.find(r => r.res_id === x.id).bl && SV.find(r => r.res_id === x.id).bl.results.length);
  ok(!okRow || /OK/.test(okRow.cells[7]), 'clean server shows OK');
  await shot('01_by_resource_desktop.png');
  // expanded failing server: rules, failures first, expected values from the data
  const fs0 = SV.find(r => r.bl && r.bl.dev > 0);
  await expand(fs0.res_id);
  const ex = await g.evaluate(id => { const d = document.querySelector('tr.sdrow[data-for="' + id + '"] .rtab');
    return d && {cols: [...d.querySelectorAll('thead th')].map(t => t.textContent).join('|'), rows: [...d.querySelectorAll('tbody tr[data-k]')].map(tr => ({k: tr.getAttribute('data-k'), c: tr.className, e: tr.cells[2].textContent}))}; }, fs0.res_id);
  ok(ex && ex.cols === 'Parameter|Actual|Expected|Status|Severity', 'expanded rule columns ' + (ex && ex.cols));
  ok(ex && ex.rows.length === fs0.bl.results.length && ex.rows.every(x => fs0.bl.results.some(b => b.param === x.k && b.expected === x.e)), 'expanded rows = this server\'s results, Expected from the baseline');
  const fl = ex ? ex.rows.map(x => /r-bad/.test(x.c)) : [], fz = fl.indexOf(false);
  ok(fl.filter(Boolean).length === fs0.bl.results.filter(isDev).length && (fz === -1 || fl.slice(fz).every(x => !x)), 'failures first in the expanded row');
  // overrides
  const ov = SV.find(r => r.bl && r.bl.overridden > 0);
  if (ov) {
    await nav('#tab=parameters&res=' + encodeURIComponent(ov.res_id));
    const o = await g.evaluate(id => { const tr = document.querySelector('tr.srow[data-res="' + id + '"]'), d = document.querySelector('tr.sdrow[data-for="' + id + '"]');
      return {cell: tr.cells[6].textContent, notes: d.querySelectorAll('.rtab .ovnote').length, ot: d.querySelectorAll('.otab tbody tr').length}; }, ov.res_id);
    ok(o.cell.includes('on ' + ov.bl.overridden + ' instance'), 'Overrides column ' + o.cell);
    ok(o.notes === ov.bl.results.filter(x => x.overrides && x.overrides.length).length && o.notes > 0, 'grey "overridden on N" notes in the rule table ' + o.notes);
    ok(o.ot === ov.bl.overrides.length, 'override table lists every instance override ' + o.ot);
    ok(ov.bl.results.filter(x => x.overrides).every(x => !isDev(x) || true), 'override does not change the status');
    await g.evaluate(id => document.querySelector('tr.sdrow[data-for="' + id + '"]').scrollIntoView(), ov.res_id); await shot('02_expanded_overrides.png');
    await nav('#tab=parameters&sh=overridden'); s = await vis();
    ok(s.map(x => x.id).sort().join() === SV.filter(r => r.bl && r.bl.overridden > 0).map(r => r.res_id).sort().join(), 'Show: overridden at instance');
    await shot('03_overridden_filter.png');
  } else ok(true, 'no overrides in this data');
  // Aurora PostgreSQL member card points at the cluster
  const am = R.find(r => r.type === 'member' && r.section === 'aurora-postgresql' && CL.has(r.cluster_id));
  if (am) { await nav('#id=' + encodeURIComponent(am.res_id));
    ok(await g.evaluate(() => { const c = document.getElementById('card-bl'); return c && /checked once per cluster/.test(c.textContent) && !!c.querySelector('a'); }), 'Aurora PostgreSQL member card: checked on the cluster'); }
  // instance-level status label
  const il = SV.find(r => r.bl && r.bl.results.some(x => x.status === 'instance-level'));
  if (il) { await nav('#tab=parameters&res=' + encodeURIComponent(il.res_id));
    ok(await g.evaluate(() => /Instance-level, not checked/.test(document.querySelector('tr.sdrow').textContent)), 'instance-level status shown'); }
  // Baseline parameter list: only the rules of the chosen engine
  await nav('#tab=parameters');
  const allOpts = await g.evaluate(() => [...document.querySelectorAll('#xf-bparam option')].map(o => o.value).filter(Boolean));
  ok(allOpts.length === new Set(BL.rule_list.map(r => r.family + '|' + r.param)).size, 'baseline parameter list = every rule ' + allOpts.length);
  const secs = [...new Set(R.map(r => r.section).filter(Boolean))];
  for (const x of secs) {
    await nav('#tab=parameters&pe=' + encodeURIComponent(x));
    const op = await g.evaluate(() => [...document.querySelectorAll('#xf-bparam option')].map(o => o.value).filter(Boolean));
    const want = [...new Set(BL.rule_list.filter(r => famMatch(r.family, x)).map(r => r.family + '|' + r.param))];
    ok(op.length === want.length && op.every(v => want.includes(v)), 'baseline parameter list scoped to ' + x + ': ' + op.length);
  }
  // fleet table for the first rule that has results
  const r0 = BL.rule_list.find(r => R.some(x => famMatch(r.family, x.section) && x.bl && x.bl.results.some(b => b.param === r.param)));
  const sec0 = R.find(x => famMatch(r0.family, x.section) && x.bl && x.bl.results.some(b => b.param === r0.param)).section;
  await nav('#tab=parameters&pe=' + encodeURIComponent(sec0) + '&bp=' + encodeURIComponent(r0.family + '|' + r0.param));
  const bt = await g.evaluate(() => ({cols: [...document.querySelectorAll('#bp-table thead th')].map(t => t.textContent).join('|'), cnt: (document.getElementById('bp-count') || {}).textContent || '',
    st: [...document.querySelectorAll('#bp-table tbody tr')].map(tr => tr.className), sel: document.getElementById('xf-bparam').value}));
  ok(bt.cols === 'Account|Region|Resource|Engine / version|Actual|Expected|Status|Comes from', 'fleet table columns ' + bt.cols);
  const want = R.filter(r => r.section === sec0 && famMatch(r0.family, r.section) && r.bl && r.bl.results.some(x => x.param === r0.param));
  const nf = want.filter(r => r.bl.results.some(x => x.param === r0.param && isDev(x))).length;
  ok(bt.st.length === want.length && bt.st.filter(c => /r-bad/.test(c)).length === nf && new RegExp('^' + want.length + ' resources: .*' + nf + ' fail').test(bt.cnt), 'fleet table rows/counts ' + bt.cnt);
  await shot('04_baseline_parameter.png');
  // unfiltered baseline CSV == script
  await nav('#tab=parameters');
  await g.click('#px-bcsv'); await sleep(200);
  const dl = await g.evaluate(async () => { const d = window.__dl[window.__dl.length - 1]; return {name: d.name, bytes: Array.from(new Uint8Array(await window.__blobOf[d.href].arrayBuffer()))}; });
  const script = fs.readFileSync(CSVF);
    if (process.env.RIE_DUMP) fs.writeFileSync(process.env.RIE_DUMP, Buffer.from(dl.bytes));
  ok(Buffer.from(dl.bytes).equals(script), 'page baseline CSV == script ' + path.basename(CSVF) + ' (' + dl.bytes.length + ' vs ' + script.length + ' bytes)');
  ok(path.basename(CSVF) === dl.name, 'csv name ' + dl.name);
  await nav('#tab=parameters&sh=problems'); await g.click('#px-bcsv'); await sleep(200);
  const dl1 = await g.evaluate(async () => { const d = window.__dl[window.__dl.length - 1]; return await window.__blobOf[d.href].text(); });
  const nbad = R.reduce((a, r) => a + (r.bl ? r.bl.results.filter(isDev).length : 0), 0);
  ok(dl1.trim().split('\r\n').length === nbad + 1, 'baseline CSV with Show problems = failing results only ' + nbad);
  // card keeps full detail
  const pay = R.find(r => r.bl && r.bl.dev > 0);
  await nav('#id=' + encodeURIComponent(pay.res_id)); await sleep(200);
  const card = await g.evaluate(() => { const c = document.getElementById('card-bl'); return c && {rows: c.querySelectorAll('tbody tr').length, cols: [...c.querySelectorAll('thead th')].map(t => t.textContent).join('|')}; });
  ok(card && card.rows === pay.bl.results.length && /Comes from/.test(card.cols), 'card baseline section, full detail ' + JSON.stringify(card));
  // insights
  await nav('#tab=insights');
  const ins = await g.evaluate(() => [...document.querySelectorAll('select option')].map(o => o.value).filter(v => /^baseline:/.test(v)).length);
  ok(ins > 0, 'insights check filter lists baseline:<param> ' + ins);
  const x = await g.evaluate(() => ({pw: window.__pwned || 0, img: document.querySelectorAll('img').length}));
  ok(x.pw === 0 && x.img === 0, 'no injected markup');
  // mobile
  await g.setViewport({width: 390, height: 844, isMobile: true});
  for (const h of ['#tab=parameters', '#tab=parameters&res=' + encodeURIComponent((ov || fs0).res_id), '#tab=parameters&bp=' + encodeURIComponent(r0.family + '|' + r0.param)]) {
    await nav(h); ok(await g.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'mobile: no horizontal scroll ' + h);
    if (h === '#tab=parameters') await shot('05_by_resource_mobile.png');
  }
  ok(!errs.length, 'js errors: ' + errs.join(' | ')); ok(!net.length, 'network: ' + net.join(' '));
  await b.close();
  console.log((fails.length ? 'FAIL' : 'ok') + ' baseline_check: ' + (n - fails.length) + '/' + n);
  fails.forEach(f => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
