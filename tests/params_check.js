// Headless-Chrome check of the Parameters tab: node params_check.js <report.html> [csv_dir] [shots_dir]
// Covers the three views, effective values (instance > cluster > default), card <-> group links both ways,
// drift, filters, CSV export (== script CSV), mobile, no JS errors, no network.
// XSS=1: the page is a tampered merge (hostile parameter value); NOTCOL=1: a merge with a file without parameters.
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
  const nav = async h => { await g.evaluate(x => { location.hash = x; }, h); await sleep(200); };
  await g.goto('file://' + file + '#tab=parameters'); await sleep(300);
  const D = await g.evaluate(() => JSON.parse(document.getElementById('explorer-data').textContent));
  const P = D.parameters, R = P.rows;
  const st = () => g.evaluate(() => ({ res: [...document.querySelectorAll('#view .pres')].map(e => e.getAttribute('data-res')),
    vals: document.querySelectorAll('#view .ptab tbody tr').length, tb: !document.getElementById('px-toolbar').hidden,
    shown: (document.getElementById('px-shown') || {}).textContent, notes: (document.getElementById('px-notes') || {}).textContent || '',
    none: !!document.getElementById('px-none') }));
  const lastDl = () => g.evaluate(async () => { const d = window.__dl[window.__dl.length - 1]; if (!d) return null;
    return {name: d.name, text: await window.__blobOf[d.href].text(), bytes: Array.from(new Uint8Array(await window.__blobOf[d.href].arrayBuffer()))}; });
  if (process.env.XSS) {
    const s = await st();
    ok(s.tb && s.res.length > 0, 'xss page: parameters render');
    await g.select('#xf-param', 'password_encryption'); await sleep(150);
    const hostile = await g.evaluate(() => ({pw: window.__pwned || 0, img: document.querySelectorAll('img').length, scripts: document.scripts.length,
      txt: [...document.querySelectorAll('#view code')].map(e => e.textContent).find(t => /onerror/.test(t)) || ''}));
    ok(hostile.pw === 0 && hostile.img === 0 && hostile.scripts === 3 && hostile.txt.includes('<img src=x onerror'), 'xss: hostile parameter value shown as text: ' + JSON.stringify(hostile));
    await g.select('#xf-param', ''); await nav('#tab=parameters&pv=group'); await nav('#tab=parameters&pv=drift');
    ok(await g.evaluate(() => (window.__pwned || 0) === 0 && document.querySelectorAll('img').length === 0), 'xss: group + drift views inert');
  } else if (process.env.NOTCOL) {
    const s = await st();
    ok(/not collected for account 222222222222/.test(s.notes), 'merge note: not collected for account X: ' + s.notes);
    ok(s.res.length === R.length && R.every(r => r.account !== '222222222222'), 'only the collected account has rows');
  } else {
    ok(P.collected && R.length > 0, 'data has parameters');
    let s = await st();
    ok(s.tb && s.res.length === R.length, 'by resource: one block per resource: ' + s.res.length + '/' + R.length);
    ok(s.vals === R.reduce((a, r) => a + Object.keys(r.values).length, 0) - 0 || s.vals > 0, 'by resource: value rows');
    const badge = await g.evaluate(() => document.getElementById('tab-parameters-n').textContent);
    ok(badge === String(R.reduce((a, r) => a + Object.values(r.values).filter(x => x.flag).length, 0)), 'tab badge = flagged values: ' + badge);
    // cluster first, members beneath it, indented
    const ci = s.res.findIndex(x => /cluster:pay-aurora-use1$/.test(x)), mi = s.res.findIndex(x => /db:pay-use1-1$/.test(x));
    ok(ci >= 0 && mi === ci + 1, 'members grouped beneath their cluster');
    ok(await g.evaluate(() => document.querySelector('[data-res$="db:pay-use1-1"]').classList.contains('pmem')), 'member block is indented (pmem)');
    // effective values in the DOM
    const cell = (res, k) => g.evaluate((res, k) => { const t = [...document.querySelectorAll('[data-res$="' + res + '"] .ptab tbody tr')].find(tr => tr.cells[0].textContent === k);
      return t ? [...t.cells].map(c => c.textContent) : null; }, res, k);
    let c = await cell('db:pay-use1-1', 'log_connections');
    ok(c && c[1].startsWith('1') && /instance group/.test(c[4]), 'member: instance group wins: ' + c);
    c = await cell('db:pay-use1-1', 'rds.force_ssl');
    ok(c && c[1].startsWith('0') && /SSL not forced/.test(c[1]) && /cluster group/.test(c[4]), 'member: cluster group when the instance group has no value: ' + c);
    c = await cell('db:pay-use1-1', 'autovacuum');
    ok(c && /engine default/.test(c[4]), 'member: engine default last: ' + c);
    c = await cell('db:pay-use1-1', 'shared_buffers');
    ok(c && /^≈ [\d,]+$/.test(c[2]), 'formula value shows an approximate computed value: ' + c);
    ok(await g.evaluate(() => /global pay-global/.test(document.querySelector('[data-res$="cluster:pay-aurora-use1"] .pmeta').textContent)), 'global cluster membership shown');
    ok(await g.evaluate(() => /pending-reboot/.test(document.querySelector('[data-res$="db:pay-use1-2"] .pmeta').textContent)), 'pending-reboot status shown');
    ok(await g.evaluate(() => /AccessDenied/.test(document.querySelector('[data-res$="db:qa-mysql"]').textContent)), 'unreadable group: per-group error shown');
    ok(await g.evaluate(() => document.querySelectorAll('#view code.nd').length > 0), 'non-default values highlighted');
    ok(await g.evaluate(() => /approximate/.test(document.getElementById('px-notes').textContent) && /option group/.test(document.getElementById('px-notes').textContent)), 'notes: approximate + Oracle option group');
    if (shots) await g.screenshot({path: path.join(shots, '01_by_resource.png'), fullPage: false});
    // full CSV == script CSV
    await g.click('#px-csv'); await sleep(100); let d = await lastDl();
    ok(d && d.name === path.basename(file).replace(/\.html$/, '_parameters.csv'), 'CSV name: ' + (d && d.name));
    if (CSVD) { const f = fs.readdirSync(CSVD).find(x => /_parameters\.csv$/.test(x));
      ok(f && Buffer.compare(fs.readFileSync(path.join(CSVD, f)), Buffer.from(d.bytes)) === 0, 'parameters CSV from the page == script CSV, byte for byte'); }
    // filters
    await g.click('#xf-flag'); await sleep(150); s = await st();
    const flagged = R.filter(r => Object.values(r.values).some(x => x.flag));
    ok(s.res.length === flagged.length && s.vals === flagged.reduce((a, r) => a + Object.values(r.values).filter(x => x.flag).length, 0), 'flagged only');
    await g.click('#px-csv'); await sleep(100); d = await lastDl();
    ok(d.text.trim().split('\r\n').length === s.vals + 1 && !/(^|,)"?[=+@-][A-Za-z(]/m.test(d.text), 'filtered CSV = shown rows, formula-guarded');
    await g.click('#xf-flag'); await g.click('#xf-nondef'); await sleep(150); s = await st();
    ok(s.vals === R.reduce((a, r) => a + Object.values(r.values).filter(x => x.nondef).length, 0), 'non-default only');
    await g.click('#xf-nondef'); await g.select('#xf-account', '222222222222'); await sleep(150); s = await st();
    ok(s.res.length === R.filter(r => r.account === '222222222222').length && s.res.length > 0, 'account filter');
    await g.select('#xf-account', ''); await g.select('#xf-region', 'ap-south-1'); await g.select('#xf-engine', 'aurora-postgresql'); await sleep(150); s = await st();
    ok(s.res.length === R.filter(r => r.region === 'ap-south-1' && r.engine === 'aurora-postgresql').length, 'region + engine filters combine');
    await g.click('#xclear'); await sleep(150);
    const grp = R.find(r => r.name === 'pay-use1-1').instance_group;
    await g.select('#xf-group', grp); await sleep(150); s = await st();
    ok(s.res.length === R.filter(r => r.cluster_group === grp || r.instance_group === grp).length && s.res.length === 2, 'group filter');
    await g.select('#xf-group', ''); await g.select('#xf-param', 'work_mem'); await sleep(150); s = await st();
    ok(s.vals === R.filter(r => r.values.work_mem).length, 'parameter filter');
    await g.click('#xclear'); await sleep(150);
    // card -> group view (link 1) and group view -> card (link 2)
    await nav('#id=' + encodeURIComponent(R.find(r => r.name === 'pay-use1-1').res_id));
    const gl = await g.evaluate(() => [...document.querySelectorAll('#card a.pglink')].map(a => a.getAttribute('data-grp')));
    ok(gl.includes(grp), 'card links to its parameter group: ' + gl);
    await g.click('#card a.pglink[data-grp="' + grp + '"]'); await sleep(250);
    let gv = await g.evaluate(() => ({h: decodeURIComponent(location.hash), rows: document.querySelectorAll('#px-groups tbody tr').length, used: [...document.querySelectorAll('#px-groups tbody a')].map(a => a.textContent), gvals: !!document.getElementById('px-gvals')}));
    ok(/pv=group/.test(gv.h) && gv.rows === 1 && gv.gvals && gv.used.includes('pay-use1-1') && gv.used.includes('pay-use1-2'), 'group view opened from the card, with used-by links: ' + JSON.stringify(gv));
    if (shots) await g.screenshot({path: path.join(shots, '02_group_from_card.png'), fullPage: false});
    await g.evaluate(() => [...document.querySelectorAll('#px-groups tbody a')].find(a => a.textContent === 'pay-use1-2').click()); await sleep(250);
    ok(await g.evaluate(() => !!document.getElementById('card') && /pay-use1-2/.test(document.querySelector('#card h2').textContent)), 'group used-by link opens the instance card');
    const vl = await g.evaluate(() => { const a = [...document.querySelectorAll('#card a')].find(x => x.textContent === 'values'); return a && a.getAttribute('href'); });
    ok(vl && /tab=parameters/.test(vl), 'card has a "values" link to the Parameters tab');
    await g.evaluate(() => [...document.querySelectorAll('#card a')].find(x => x.textContent === 'values').click()); await sleep(250);
    ok(await g.evaluate(() => { const e = document.querySelector('.pres.hlres'); return e && /pay-use1-2$/.test(e.getAttribute('data-res')); }), 'values link highlights the resource');
    // group view: all groups, default flagged; cluster card links to the cluster group
    await nav('#tab=parameters&pv=group');
    gv = await g.evaluate(() => ({rows: document.querySelectorAll('#px-groups tbody tr').length, def: document.querySelectorAll('#px-groups .p-warn').length}));
    ok(gv.rows === P.groups.length && gv.def === P.groups.filter(x => x.is_default).length && gv.def > 0, 'group view: every group, default groups flagged: ' + JSON.stringify(gv));
    if (shots) await g.screenshot({path: path.join(shots, '03_by_group.png'), fullPage: false});
    await g.click('#px-csv'); await sleep(100); d = await lastDl();
    ok(/_parameters_group\.csv$/.test(d.name) && d.text.trim().split('\r\n').length === P.groups.length + 1, 'group CSV');
    await nav('#id=' + encodeURIComponent(R.find(r => r.name === 'pay-aurora-use1').res_id));
    ok(await g.evaluate(() => [...document.querySelectorAll('#card a.pglink')].some(a => /\|cluster\|/.test(a.getAttribute('data-grp')))), 'cluster card links to the cluster parameter group');
    // drift
    await nav('#tab=parameters&pv=drift');
    const dr = await g.evaluate(() => ({rows: document.querySelectorAll('#px-drift tbody tr').length, txt: document.getElementById('px-drift').textContent}));
    ok(dr.rows === P.drift.reduce((a, x) => a + x.values.length, 0) && /work_mem/.test(dr.txt), 'drift view: ' + dr.rows);
    await g.click('#px-csv'); await sleep(100); d = await lastDl();
    ok(/_parameters_drift\.csv$/.test(d.name) && d.text.trim().split('\r\n').length === dr.rows + 1, 'drift CSV');
    if (shots) await g.screenshot({path: path.join(shots, '04_drift.png'), fullPage: false});
    // footer
    ok(await g.evaluate(() => /parameter step [\d.]+ s/.test(document.body.textContent)), 'footer: parameter step time');
    // mobile
    await g.setViewport({width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2});
    for (const h of ['#tab=parameters', '#tab=parameters&pv=group', '#tab=parameters&pv=drift']) { await nav(h);
      ok(await g.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, 'mobile: no sideways scroll ' + h); }
    await nav('#tab=parameters');
    if (shots) await g.screenshot({path: path.join(shots, '05_mobile.png'), fullPage: false});
  }
  ok(errs.length === 0, 'no JS errors: ' + errs.join('; '));
  ok(net.length === 0, 'no network: ' + net.join(' '));
  console.log(JSON.stringify({fails, passed: n - fails.length, total: n}));
  await b.close(); process.exit(fails.length ? 1 : 0);
})().catch(e => { fails.push(String(e && e.stack || e)); console.log(JSON.stringify({fails})); process.exit(1); });
