// Headless-Chrome check of the Parameters tab: node params_check.js <report.html> [csv_dir] [shots_dir]
// v2.3 layout: filter row, Show / Level / Baseline parameter, search ('/', Esc), nesting, problems first, detail rows,
// compare panel, card <-> group links both ways, CSV = visible rows (unfiltered == script CSV), hash, mobile, no JS errors, no network.
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
  const sel = async (id, v) => { await g.select(id, v); await sleep(150); };
  const typeQ = async v => { await g.evaluate(() => { const q = document.getElementById('px-q'); q.value = ''; q.focus(); }); if (v) await g.keyboard.type(v); await sleep(200); };
  // what By resource shows: resource panels (data-res, open, problems badge, member?)
  const vis = () => g.evaluate(() => [...document.querySelectorAll('#view .pres')].map(e => ({id: e.getAttribute('data-res'), mem: e.classList.contains('pmem'), hdr: e.classList.contains('pgrp'),
    n: e.querySelector('.pst') ? +e.querySelector('.pst').getAttribute('data-problems') : null, open: e.getAttribute('data-open') === 'true', diff: e.classList.contains('pdiff')})));
  const expand = async id => { await g.evaluate(id => { const e = document.querySelector('.pres[data-res="' + id + '"]'); if (e.getAttribute('data-open') !== 'true') e.querySelector('.prow').click(); }, id); await sleep(150); };
  const rowsOf = id => g.evaluate(id => [...document.querySelectorAll('.pres[data-res="' + id + '"] .ptab tbody tr[data-k]')].map(tr => ({k: tr.getAttribute('data-k'), c: tr.className, cells: [...tr.cells].map(c => c.textContent)})), id);
  if (process.env.XSS) {
    let s = await vis();
    ok(s.length > 0, 'xss page: parameters render');
    await typeQ('onerror'); s = await vis();
    for (const x of s.filter(x => !x.hdr)) await expand(x.id);
    const hostile = await g.evaluate(() => ({pw: window.__pwned || 0, img: document.querySelectorAll('img').length, scripts: document.scripts.length,
      txt: [...document.querySelectorAll('#view code')].map(e => e.textContent).find(t => /onerror/.test(t)) || ''}));
    ok(hostile.pw === 0 && hostile.img === 0 && hostile.scripts === 3 && hostile.txt.includes('<img src=x onerror'), 'xss: hostile parameter value shown as text: ' + JSON.stringify(hostile));
    await nav('#tab=parameters&pv=group&pq=onerror'); await nav('#tab=parameters&bp=postgres%7Cpassword_encryption');
    ok(await g.evaluate(() => (window.__pwned || 0) === 0 && document.querySelectorAll('img').length === 0), 'xss: group + baseline parameter views inert');
  } else if (process.env.NOTCOL) {
    const s = await vis(), notes = await g.evaluate(() => document.getElementById('px-notes').textContent);
    ok(/not collected for account 222222222222/.test(notes), 'merge note: not collected for account X: ' + notes);
    ok(s.filter(x => !x.hdr).length === R.length && R.every(r => r.account !== '222222222222'), 'only the collected account has rows');
  } else {
    ok(P.collected && R.length > 0, 'data has parameters');
    const tb = await g.evaluate(() => [...document.getElementById('px-toolbar').querySelectorAll('input,select')].filter(e => !e.hidden).map(e => e.getAttribute('aria-label')));
    ok(JSON.stringify(tb) === JSON.stringify(['Search parameters', 'Account', 'Region', 'Engine', 'Level', 'Baseline parameter', 'Show']), 'filter row: ' + tb);
    ok(await g.evaluate(() => !document.querySelector('#px-toolbar input[type=checkbox]') && !document.getElementById('xf-group') && !document.getElementById('xf-param') && !document.getElementById('pv-drift')), 'old checkboxes, group/parameter dropdowns and Drift view removed');
    ok(await g.evaluate(() => /red/.test(document.getElementById('px-legend').textContent) && /doesn't apply/.test(document.getElementById('px-legend').textContent)), 'legend');
    const prob = r => { const ks = new Set(Object.keys(r.values)); (r.bl ? r.bl.results : []).forEach(b => ks.add(b.param));
      return [...ks].filter(k => (r.values[k] && r.values[k].flag) || (r.bl && r.bl.results.some(b => b.param === k && (b.status === 'fail' || b.status === 'missing')))).length; };
    let s = await vis();
    ok(s.filter(x => !x.hdr).length === R.length, 'by resource: one panel per resource: ' + s.length + '/' + R.length);
    const badge = await g.evaluate(() => document.getElementById('tab-parameters-n').textContent);
    ok(badge === String(R.reduce((a, r) => a + prob(r), 0)), 'tab badge = problems (baseline fail OR flag, counted once): ' + badge);
    ok(s.every(x => x.hdr || x.n === prob(R.find(r => r.res_id === x.id))), 'status badge per resource = union of baseline failures and flags');
    const ci = s.findIndex(x => /cluster:pay-aurora-use1$/.test(x.id)), mi = s.findIndex(x => /db:pay-use1-1$/.test(x.id));
    ok(ci >= 0 && mi > ci && s[mi].mem, 'members nested beneath their cluster');
    const tops = s.filter(x => !x.mem);
    const score = id => { const r = R.find(x => x.res_id === id); return prob(r) + R.filter(m => m.cluster_id === id).reduce((a, m) => a + prob(m), 0); };
    const sc = tops.map(x => score(x.id)), z = sc.findIndex(x => x === 0);
    ok(z === -1 || sc.slice(z).every(x => x === 0), 'problems sorted first: ' + sc);
    ok(await g.evaluate(() => document.querySelectorAll('.pres .ptab').length === 0), 'rows collapsed until clicked');
    // nesting is collapsible
    await g.evaluate(() => document.querySelector('[data-mt$="cluster:pay-aurora-use1"]').click()); await sleep(150); s = await vis();
    ok(!s.some(x => /db:pay-use1-1$/.test(x.id)), 'member list collapses');
    await g.evaluate(() => document.querySelector('[data-mt$="cluster:pay-aurora-use1"]').click()); await sleep(150);
    // expand a member: Parameter | Actual | Expected | Status | Comes from
    const m1 = R.find(r => r.name === 'pay-use1-1').res_id; await expand(m1);
    ok(await g.evaluate(id => [...document.querySelectorAll('.pres[data-res="' + id + '"] .ptab thead th')].map(t => t.textContent).join('|'), m1) === 'Parameter|Actual|Expected|Status|Comes from', 'detail columns');
    let rs = await rowsOf(m1); const cell = k => (rs.find(x => x.k === k) || {cells: []}).cells;
    ok(cell('log_connections')[1].startsWith('1') && /^Instance group /.test(cell('log_connections')[4]), 'member: instance group wins: ' + cell('log_connections'));
    ok(cell('rds.force_ssl')[1].startsWith('0') && /SSL not forced|Fails/.test(cell('rds.force_ssl')[3]) && /^Cluster group /.test(cell('rds.force_ssl')[4]) && /r-bad/.test(rs.find(x => x.k === 'rds.force_ssl').c), 'member: cluster group value, red: ' + cell('rds.force_ssl'));
    ok(cell('autovacuum')[4] === 'AWS default', 'member: AWS default last: ' + cell('autovacuum'));
    ok(/≈ [\d,]+/.test(cell('shared_buffers')[1]), 'formula value shows an approximate number');
    ok(!rs.some(x => /n\/a|unknown|engine default|system/.test(x.cells.join(' '))), 'plain wording (no n/a / unknown / engine default / system)');
    ok(await g.evaluate(() => /pending reboot/.test(document.querySelector('[data-res$="db:pay-use1-2"] .phead').textContent) && document.querySelector('[data-res$="db:pay-use1-2"]').classList.contains('p-bad') || document.querySelector('[data-res$="db:pay-use1-2"]').classList.contains('p-warn')), 'pending reboot shown (yellow)');
    if (shots) await g.screenshot({path: path.join(shots, '01_by_resource.png'), fullPage: false});
    // compare across clusters
    await g.evaluate(id => document.querySelector('.pres[data-res="' + id + '"] a.cmp[data-cmpk="work_mem"]').click(), m1); await sleep(250);
    const cmp = await g.evaluate(() => { const c = document.querySelector('.cmpbox[data-cmp="work_mem"]'); return c && {t: c.textContent, n: c.querySelectorAll('.cv').length, links: c.querySelectorAll('a').length}; });
    const same = R.filter(r => r.section === R.find(x => x.res_id === m1).section && r.values.work_mem);
    ok(cmp && cmp.links === same.length && cmp.n === new Set(same.map(r => r.values.work_mem.v)).size && /cmp=work_mem/.test(await g.evaluate(() => location.hash)), 'compare panel: work_mem across same-engine resources ' + JSON.stringify(cmp));
    if (shots) await g.screenshot({path: path.join(shots, '02_compare.png'), fullPage: false});
    await g.reload(); await sleep(300);
    ok(await g.evaluate(() => !!document.querySelector('.cmpbox[data-cmp="work_mem"]')), 'hash keeps the open row + compare panel after reload');
    await nav('#tab=parameters');
    // full CSV == script CSV
    await g.click('#px-csv'); await sleep(100); let d = await lastDl();
    ok(d && d.name === path.basename(file).replace(/\.html$/, '_parameters.csv'), 'CSV name: ' + (d && d.name));
    if (CSVD) { const f = fs.readdirSync(CSVD).find(x => /_parameters\.csv$/.test(x));
      ok(f && Buffer.compare(fs.readFileSync(path.join(CSVD, f)), Buffer.from(d.bytes)) === 0, 'unfiltered page CSV == script CSV, byte for byte'); }
    // Show
    const dataRows = async () => { let n = 0; for (const x of (await vis()).filter(x => !x.hdr)) { await expand(x.id); n += (await rowsOf(x.id)).filter(y => Object.keys(R.find(r => r.res_id === x.id).values).includes(y.k)).length; } return n; };
    await sel('#xf-show', 'problems'); s = await vis();
    ok(s.filter(x => !x.hdr).length === R.filter(r => prob(r) > 0).length && /sh=problems/.test(await g.evaluate(() => location.hash)), 'Show problems: resources with a problem only');
    const pr0 = s.find(x => !x.hdr); await expand(pr0.id); rs = await rowsOf(pr0.id);
    ok(rs.length === prob(R.find(r => r.res_id === pr0.id)) && rs.every(x => /r-bad/.test(x.c)), 'Show problems: only red rows, each parameter once');
    let n1 = await dataRows(); await g.click('#px-csv'); await sleep(100); d = await lastDl();
    ok(d.text.trim().split('\r\n').length === n1 + 1 && !/(^|,)"?[=+@-][A-Za-z(]/m.test(d.text), 'CSV = visible rows (problems), formula-guarded: ' + n1);
    if (shots) await g.screenshot({path: path.join(shots, '03_problems_only.png'), fullPage: false});
    await sel('#xf-show', 'changed'); n1 = await dataRows();
    ok(n1 === R.reduce((a, r) => a + Object.values(r.values).filter(x => x.nondef).length, 0), 'Show changed from default: ' + n1);
    await sel('#xf-show', '');
    // Level
    await sel('#xf-level', 'cluster'); s = await vis();
    ok(s.length === R.filter(r => r.type === 'cluster').length && s.every(x => /:cluster:/.test(x.id)), 'Level cluster group: one row per cluster');
    await sel('#xf-level', 'instance'); s = await vis();
    ok(s.filter(x => !x.hdr).length === R.filter(r => r.type !== 'cluster').length && s.filter(x => x.hdr).length === R.filter(r => r.type === 'cluster' && R.some(m => m.cluster_id === r.res_id)).length, 'Level instance group: members under cluster headers + standalone');
    await expand(m1); rs = await rowsOf(m1);
    ok(rs.length > 0 && rs.every(x => !/^Cluster group /.test(x.cells[4])) && !rs.some(x => x.k === 'rds.force_ssl'), 'Level instance group: no cluster-group values on members');
    const dif = R.filter(r => r.type === 'member' && R.some(m => m.cluster_id === r.cluster_id && m.instance_group !== r.instance_group));
    ok(dif.length === 0 || s.some(x => x.diff), 'Level instance group: member whose group differs from its siblings highlighted');
    if (shots) await g.screenshot({path: path.join(shots, '04_level_instance.png'), fullPage: false});
    await sel('#xf-level', '');
    // search: type-ahead, combines with filters, Esc clears, '/' focuses
    await g.click('body'); await g.keyboard.press('/'); await sleep(100);
    ok(await g.evaluate(() => document.activeElement.id === 'px-q'), "'/' focuses the Parameters search");
    await g.keyboard.type('pay-use1'); await sleep(200); s = await vis();
    ok(s.filter(x => !x.hdr).map(x => x.id).sort().join() === R.filter(r => /pay-use1/.test(r.name) || /pay-use1/.test(r.cluster_name || '')).map(r => r.res_id).sort().join(), 'search by resource name: ' + s.length);
    await g.keyboard.press('Escape'); await sleep(200); s = await vis();
    ok(s.filter(x => !x.hdr).length === R.length && await g.evaluate(() => document.getElementById('px-q').value === ''), 'Esc clears the search');
    await typeQ('work_mem'); s = await vis();
    ok(s.filter(x => !x.hdr).length === R.filter(r => r.values.work_mem).length, 'search by parameter name');
    await expand(s.find(x => !x.hdr).id); rs = await rowsOf(s.find(x => !x.hdr).id);
    ok(rs.length === 1 && rs[0].k === 'work_mem', 'search by parameter: only that parameter shown');
    const grpn = R.find(r => r.name === 'pay-use1-1').instance_group;
    await typeQ(grpn.split('|').pop()); s = await vis();
    ok(s.filter(x => !x.hdr).length === R.filter(r => r.instance_group === grpn || r.cluster_group === grpn).length, 'search by parameter group');
    await typeQ('scram'); s = await vis();
    ok(s.filter(x => !x.hdr).length === R.filter(r => Object.values(r.values).some(x => /scram/i.test(x.v || '')) || (r.bl && r.bl.results.some(b => !r.values[b.param] && /scram/i.test(b.actual || '')))).length && s.length > 0, 'search by value');
    await typeQ('work_mem'); await sel('#xf-account', '222222222222'); s = await vis();
    ok(s.filter(x => !x.hdr).length === R.filter(r => r.values.work_mem && r.account === '222222222222').length && /pq=work_mem/.test(await g.evaluate(() => location.hash)) && /pa=222222222222/.test(await g.evaluate(() => location.hash)), 'search + account combine, kept in the hash');
    await sel('#xf-account', ''); await sel('#xf-region', 'ap-south-1'); await sel('#xf-engine', 'aurora-postgresql'); s = await vis();
    ok(s.filter(x => !x.hdr).length === R.filter(r => r.values.work_mem && r.region === 'ap-south-1' && r.engine === 'aurora-postgresql').length, 'search + region + engine combine');
    await g.click('#xclear'); await sleep(150);
    ok(await g.evaluate(() => location.hash === '#tab=parameters' && document.getElementById('px-q').value === ''), 'Clear resets search + filters');
    // Baseline parameter fleet table
    if (D.baseline && D.baseline.applied) {
      await sel('#xf-bparam', 'postgres|rds.force_ssl');
      const bp = await g.evaluate(() => ({cnt: (document.getElementById('bp-count') || {}).textContent, rows: [...document.querySelectorAll('#bp-table tbody tr')].map(tr => ({id: tr.getAttribute('data-res'), c: tr.className, st: tr.cells[6].textContent}))}));
      const exp = R.filter(r => /postgres/.test(r.section || '') && r.bl && r.bl.results.some(b => b.param === 'rds.force_ssl'));
      ok(bp.rows.length === exp.length && bp.cnt.startsWith(exp.length + ' resources: '), 'baseline parameter table: one row per resource ' + bp.cnt);
      const fl = bp.rows.map(x => /r-bad/.test(x.c)), fz = fl.indexOf(false);
      ok(fl.some(Boolean) && (fz === -1 || fl.slice(fz).every(x => !x)), 'baseline parameter table: failures first');
      ok(new RegExp(bp.rows.filter(x => /r-bad/.test(x.c)).length + ' fail').test(bp.cnt), 'counts line matches the red rows');
      if (shots) await g.screenshot({path: path.join(shots, '05_baseline_parameter.png'), fullPage: false});
      await g.click('#px-csv'); await sleep(100); d = await lastDl();
      ok(/_parameters_postgres_rds\.force_ssl\.csv$/.test(d.name) && d.text.trim().split('\r\n').length === bp.rows.length + 1, 'baseline parameter CSV = visible rows ' + d.name);
      await sel('#xf-show', 'problems');
      ok(await g.evaluate(() => [...document.querySelectorAll('#bp-table tbody tr')].every(tr => /r-bad/.test(tr.className))), 'baseline parameter + Show problems');
      await sel('#xf-level', 'cluster');
      ok(await g.evaluate(() => [...document.querySelectorAll('#bp-table tbody tr')].every(tr => /:cluster:/.test(tr.getAttribute('data-res')))), 'baseline parameter + Level cluster');
      await g.reload(); await sleep(300);
      ok(await g.evaluate(() => document.getElementById('xf-bparam').value === 'postgres|rds.force_ssl' && document.getElementById('xf-level').value === 'cluster' && !!document.getElementById('bp-table')), 'baseline parameter kept in the hash');
      await g.click('#xclear'); await sleep(150);
    }
    // card -> group view and group view -> resource, both ways
    await nav('#id=' + encodeURIComponent(m1));
    const gl = await g.evaluate(() => [...document.querySelectorAll('#card a.pglink')].map(a => a.getAttribute('data-grp')));
    ok(gl.includes(grpn), 'card links to its parameter group: ' + gl);
    await g.click('#card a.pglink[data-grp="' + grpn + '"]'); await sleep(250);
    let gv = await g.evaluate(() => ({h: decodeURIComponent(location.hash), rows: document.querySelectorAll('#px-groups tbody tr').length, used: [...document.querySelectorAll('#px-groups tbody a.ulink')].map(a => a.textContent), gvals: !!document.getElementById('px-gvals'),
      cols: [...document.querySelectorAll('#px-groups thead th')].map(t => t.textContent).join('|')}));
    ok(/pv=group/.test(gv.h) && gv.rows === 1 && gv.gvals && gv.used.includes('pay-use1-1') && gv.used.includes('pay-use1-2') && gv.cols === 'Group|Level|Family|Account|Region|Changed|Problems|Used by', 'group view opened from the card: ' + JSON.stringify(gv));
    if (shots) await g.screenshot({path: path.join(shots, '06_group_from_card.png'), fullPage: false});
    await g.evaluate(() => [...document.querySelectorAll('#px-groups tbody a.ulink')].find(a => a.textContent === 'pay-use1-2').click()); await sleep(250);
    ok(await g.evaluate(() => { const e = document.querySelector('.pres.hlres'); return e && /pay-use1-2$/.test(e.getAttribute('data-res')) && e.getAttribute('data-open') === 'true'; }), 'group used-by link opens the resource row in By resource');
    await nav('#id=' + encodeURIComponent(R.find(r => r.name === 'pay-use1-2').res_id));
    await g.evaluate(() => [...document.querySelectorAll('#card a')].find(x => x.textContent === 'values').click()); await sleep(250);
    ok(await g.evaluate(() => { const e = document.querySelector('.pres.hlres'); return e && /pay-use1-2$/.test(e.getAttribute('data-res')); }), 'card "values" link highlights the resource');
    await nav('#tab=parameters&pv=group');
    gv = await g.evaluate(() => ({rows: document.querySelectorAll('#px-groups tbody tr').length, def: document.querySelectorAll('#px-groups .p-warn').length}));
    ok(gv.rows === P.groups.length && gv.def === P.groups.filter(x => x.is_default).length && gv.def > 0, 'group view: every group, default groups flagged: ' + JSON.stringify(gv));
    await sel('#xf-level', 'cluster');
    ok(await g.evaluate(() => document.querySelectorAll('#px-groups tbody tr').length) === P.groups.filter(x => x.kind === 'cluster').length, 'group view + Level cluster');
    await sel('#xf-level', '');
    if (shots) await g.screenshot({path: path.join(shots, '07_by_group.png'), fullPage: false});
    await g.click('#px-csv'); await sleep(100); d = await lastDl();
    ok(/_parameters_group\.csv$/.test(d.name) && d.text.trim().split('\r\n').length === P.groups.length + 1, 'group CSV');
    await nav('#id=' + encodeURIComponent(R.find(r => r.name === 'pay-aurora-use1').res_id));
    ok(await g.evaluate(() => [...document.querySelectorAll('#card a.pglink')].some(a => /\|cluster\|/.test(a.getAttribute('data-grp')))), 'cluster card links to the cluster parameter group');
    ok(await g.evaluate(() => /parameter step [\d.]+ s/.test(document.body.textContent)), 'footer: parameter step time');
    // mobile
    await g.setViewport({width: 390, height: 844, isMobile: true});
    for (const h of ['#tab=parameters', '#tab=parameters&pv=group', '#tab=parameters&bp=postgres%7Crds.force_ssl', '#tab=parameters&res=' + encodeURIComponent(m1) + '&cmp=work_mem']) { await nav(h);
      ok(await g.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, 'mobile: no sideways scroll ' + h); }
    if (shots) await g.screenshot({path: path.join(shots, '08_mobile.png'), fullPage: false});
  }
  ok(errs.length === 0, 'no JS errors: ' + errs.join('; '));
  ok(net.length === 0, 'no network: ' + net.join(' '));
  console.log(JSON.stringify({fails, passed: n - fails.length, total: n}));
  await b.close(); process.exit(fails.length ? 1 : 0);
})().catch(e => { fails.push(String(e && e.stack || e)); console.log(JSON.stringify({fails})); process.exit(1); });
