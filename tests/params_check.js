// Headless-Chrome check of the Parameters tab: node params_check.js <report.html> [csv_dir] [shots_dir]
// v2.4 layout: flat By resource table (one row per server), Show / Engine / Baseline parameter filters, search ('/', Esc),
// failures first, expand -> baseline rules + all collected parameters, card <-> group links both ways,
// CSV = visible rows (unfiltered == script CSV), hash, mobile, no JS errors, no network.
// Nothing here knows an expected parameter value: everything is derived from the report data.
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
  const P = D.parameters, R = P.rows, BLON = !!(D.baseline && D.baseline.applied);
  // servers = clusters + rows that are not members of a listed cluster
  const CL = new Set(R.filter(r => r.type === 'cluster').map(r => r.res_id));
  const SV = R.filter(r => r.type === 'cluster' || !(r.cluster_id && CL.has(r.cluster_id)));
  const rowsOf = s => [s].concat(s.type === 'cluster' ? R.filter(m => m.type !== 'cluster' && m.cluster_id === s.res_id) : []);
  const dev = r => r.bl ? r.bl.results.filter(b => b.status === 'fail' || b.status === 'missing').length : 0;
  const sdev = s => BLON ? rowsOf(s).reduce((a, r) => a + dev(r), 0) : 0;
  const lastDl = () => g.evaluate(async () => { const d = window.__dl[window.__dl.length - 1]; if (!d) return null;
    return {name: d.name, text: await window.__blobOf[d.href].text(), bytes: Array.from(new Uint8Array(await window.__blobOf[d.href].arrayBuffer()))}; });
  const sel = async (id, v) => { await g.select(id, v); await sleep(150); };
  const typeQ = async v => { await g.evaluate(() => { const q = document.getElementById('px-q'); q.value = ''; q.focus(); }); if (v) await g.keyboard.type(v); await sleep(200); };
  const vis = () => g.evaluate(() => [...document.querySelectorAll('#px-servers tr.srow')].map(tr => ({id: tr.getAttribute('data-res'), open: tr.getAttribute('aria-expanded') === 'true',
    fails: (tr.querySelector('.fails') || {getAttribute: () => '0,0,0'}).getAttribute('data-fails').split(',').map(Number), cells: [...tr.cells].map(c => c.textContent)})));
  const expand = async id => { await g.evaluate(id => { const e = document.querySelector('tr.srow[data-res="' + id + '"]'); if (e.getAttribute('aria-expanded') !== 'true') e.click(); }, id); await sleep(150); };
  const showAll = async id => { await g.evaluate(id => { const d = document.querySelector('tr.sdrow[data-for="' + id + '"] .allp'); if (d && d.getAttribute('aria-expanded') !== 'true') d.click(); }, id); await sleep(150); };
  const ids = s => s.map(x => x.id).sort().join();
  if (process.env.XSS) {
    let s = await vis();
    ok(s.length > 0, 'xss page: parameters render');
    await typeQ('onerror'); s = await vis();
    for (const x of s) { await expand(x.id); await showAll(x.id); }
    const hostile = await g.evaluate(() => ({pw: window.__pwned || 0, img: document.querySelectorAll('img').length, scripts: document.scripts.length,
      txt: [...document.querySelectorAll('#view code')].map(e => e.textContent).find(t => /onerror/.test(t)) || ''}));
    ok(hostile.pw === 0 && hostile.img === 0 && hostile.scripts === 3 && hostile.txt.includes('<img src=x onerror'), 'xss: hostile parameter value shown as text: ' + JSON.stringify(hostile));
    const r0 = D.baseline && D.baseline.rule_list && D.baseline.rule_list[0];
    await nav('#tab=parameters&pv=group&pq=onerror'); if (r0) await nav('#tab=parameters&bp=' + encodeURIComponent(r0.family + '|' + r0.param));
    ok(await g.evaluate(() => (window.__pwned || 0) === 0 && document.querySelectorAll('img').length === 0), 'xss: group + baseline parameter views inert');
  } else if (process.env.NOTCOL) {
    const s = await vis(), notes = await g.evaluate(() => [...document.querySelectorAll('#px-notes')].map(e => e.textContent).join(' '));
    ok(/not collected for account 222222222222/.test(notes), 'merge note: not collected for account X: ' + notes);
    ok(s.length === SV.length && R.every(r => r.account !== '222222222222'), 'only the collected account has rows');
  } else {
    ok(P.collected && R.length > 0, 'data has parameters');
    const tb = await g.evaluate(() => [...document.getElementById('px-toolbar').querySelectorAll('input,select')].filter(e => !e.hidden).map(e => e.getAttribute('aria-label')));
    ok(JSON.stringify(tb) === JSON.stringify(['Search parameters', 'Account', 'Region', 'Engine', ...(R.some(r => r.global) ? ['Global cluster'] : []), ...(BLON ? ['Baseline parameter'] : []), 'Show']), 'filter row (Level hidden in By resource): ' + tb);
    ok(await g.evaluate(() => !document.querySelector('.cmp,.cmpbox') && !/cmp=/.test(location.hash)), 'compare links removed');
    ok(await g.evaluate(() => /fails the baseline/.test(document.getElementById('px-legend').textContent) && /doesn't apply/.test(document.getElementById('px-legend').textContent)), 'one-line legend');
    let s = await vis();
    ok(s.length === SV.length && ids(s) === SV.map(r => r.res_id).sort().join(), 'by resource: one row per server: ' + s.length + '/' + SV.length);
    ok(await g.evaluate(() => [...document.querySelectorAll('#px-servers thead th')].map(t => t.textContent).join('|')) === 'Server|Engine / version|Account|Region|Global cluster|Parameter group|Fails (H/M/L)|Overrides|Status', 'server columns');
    const badge = await g.evaluate(() => document.getElementById('tab-parameters-n').textContent);
    ok(badge === String(BLON ? R.reduce((a, r) => a + dev(r), 0) : 0), 'tab badge = baseline failures: ' + badge);
    const key = f => f[0] * 1e6 + f[1] * 1e3 + f[2], ks = s.map(x => key(x.fails));
    ok(ks.every((k, i) => i === 0 || ks[i - 1] >= k), 'failures first (high, medium, low): ' + ks);
    ok(s.every(x => (sdev(SV.find(r => r.res_id === x.id)) > 0) === /fail/.test(x.cells[8])), 'status column = fail count or OK');
    ok(await g.evaluate(() => document.querySelectorAll('tr.sdrow').length === 0), 'rows collapsed until clicked');
    // expand a cluster with members
    const c1 = SV.find(r => r.type === 'cluster' && rowsOf(r).length > 1) || SV[0];
    await expand(c1.res_id);
    ok(await g.evaluate(id => !!document.querySelector('tr.sdrow[data-for="' + id + '"]'), c1.res_id), 'click expands the server');
    await showAll(c1.res_id);
    const vt = await g.evaluate(id => document.querySelectorAll('tr.sdrow[data-for="' + id + '"] .vtab tbody tr, tr.sdrow[data-for="' + id + '"] .vtab + .empty').length, c1.res_id);
    ok(vt === rowsOf(c1).reduce((a, r) => a + Object.keys(r.values).length, 0), 'Show all collected parameters: every value of the cluster and its members ' + vt);
    const fromTxt = await g.evaluate(id => [...document.querySelectorAll('tr.sdrow[data-for="' + id + '"] .vtab tbody tr')].map(tr => tr.cells[2].textContent), c1.res_id);
    ok(fromTxt.every(t => /^(Instance group |Cluster group |AWS default|—)/.test(t)), 'Comes from wording');
    ok(await g.evaluate(() => /≈ [\d,]+/.test(document.getElementById('view').textContent)) || !R.some(r => Object.values(r.values).some(v => v.approx != null)), 'formula value shows an approximate number');
    if (shots) await g.screenshot({path: path.join(shots, '01_by_resource.png'), fullPage: false});
    await g.reload(); await sleep(300);
    // full CSV == script CSV
    await nav('#tab=parameters');
    await g.click('#px-csv'); await sleep(100); let d = await lastDl();
    ok(d && d.name === path.basename(file).replace(/\.html$/, '_parameters.csv'), 'CSV name: ' + (d && d.name));
    if (CSVD) { const f = fs.readdirSync(CSVD).find(x => /_parameters\.csv$/.test(x));
      ok(f && Buffer.compare(fs.readFileSync(path.join(CSVD, f)), Buffer.from(d.bytes)) === 0, 'unfiltered page CSV == script CSV, byte for byte');
    if (process.env.RIE_DUMP) fs.writeFileSync(process.env.RIE_DUMP, Buffer.from(d.bytes)); }
    // Show
    await sel('#xf-show', 'problems'); s = await vis();
    ok(ids(s) === SV.filter(r => sdev(r) > 0).map(r => r.res_id).sort().join() && /sh=problems/.test(await g.evaluate(() => location.hash)), 'Show problems: servers with a failure only');
    await g.click('#px-csv'); await sleep(100); d = await lastDl();
    const nprob = SV.filter(r => sdev(r) > 0).reduce((a, s0) => a + rowsOf(s0).reduce((x, r) => x + Object.keys(r.values).filter(k => r.bl && r.bl.results.some(b => b.param === k && (b.status === 'fail' || b.status === 'missing'))).length, 0), 0);
    ok(d.text.trim().split('\r\n').length === nprob + 1 && !/(^|,)"?[=+@-][A-Za-z(]/m.test(d.text), 'CSV = failing values of the visible servers, formula-guarded: ' + nprob);
    await sel('#xf-show', 'changed'); s = await vis();
    ok(ids(s) === SV.filter(r => rowsOf(r).some(x => Object.values(x.values).some(v => v.nondef))).map(r => r.res_id).sort().join(), 'Show changed from default');
    await sel('#xf-show', 'overridden'); s = await vis();
    ok(ids(s) === SV.filter(r => r.bl && r.bl.overridden > 0).map(r => r.res_id).sort().join(), 'Show overridden at instance');
    await sel('#xf-show', '');
    // engine: Aurora PostgreSQL and RDS PostgreSQL listed separately
    const eng = await g.evaluate(() => [...document.querySelectorAll('#xf-engine option')].map(o => [o.value, o.textContent]));
    const secs = [...new Set(R.map(r => r.section).filter(Boolean))];
    ok(secs.every(x => eng.some(e => e[0] === x)), 'engine dropdown lists each engine section ' + JSON.stringify(eng));
    for (const x of secs) { await sel('#xf-engine', x); s = await vis();
      ok(ids(s) === SV.filter(r => r.section === x).map(r => r.res_id).sort().join(), 'engine filter ' + x); }
    await sel('#xf-engine', '');
    // search: type-ahead, combines with filters, Esc clears, '/' focuses
    await g.click('body'); await g.keyboard.press('/'); await sleep(100);
    ok(await g.evaluate(() => document.activeElement.id === 'px-q'), "'/' focuses the Parameters search");
    const nm = SV[SV.length - 1].name; await g.keyboard.type(nm); await sleep(200); s = await vis();
    ok(s.some(x => x.id === SV[SV.length - 1].res_id), 'search by server name: ' + nm);
    await g.keyboard.press('Escape'); await sleep(200); s = await vis();
    ok(s.length === SV.length && await g.evaluate(() => document.getElementById('px-q').value === ''), 'Esc clears the search');
    const someK = Object.keys(R.find(r => Object.keys(r.values).length).values)[0];
    await typeQ(someK); s = await vis();
    ok(SV.filter(r => rowsOf(r).some(x => someK in x.values)).every(r => s.some(x => x.id === r.res_id)), 'search by parameter name ' + someK);
    const acc = R[0].account; await sel('#xf-account', acc); s = await vis();
    ok(s.every(x => SV.find(r => r.res_id === x.id).account === acc) && /pa=/.test(await g.evaluate(() => location.hash)) && /pq=/.test(await g.evaluate(() => location.hash)), 'search + account combine, kept in the hash');
    await g.click('#xclear'); await sleep(150);
    ok(await g.evaluate(() => location.hash === '#tab=parameters' && document.getElementById('px-q').value === ''), 'Clear resets search + filters');
    // card -> group view and group view -> resource, both ways
    const m = R.find(r => r.type === 'member' && r.instance_group) || R.find(r => r.instance_group);
    await nav('#id=' + encodeURIComponent(m.res_id));
    const grpn = m.instance_group;
    const gl = await g.evaluate(() => [...document.querySelectorAll('#card a.pglink')].map(a => a.getAttribute('data-grp')));
    ok(gl.includes(grpn), 'card links to its parameter group: ' + gl);
    await g.click('#card a.pglink[data-grp="' + grpn + '"]'); await sleep(250);
    const users = P.groups.find(x => x.gid === grpn).used_by.map(u => u.name);
    let gv = await g.evaluate(() => ({h: decodeURIComponent(location.hash), rows: document.querySelectorAll('#px-groups tbody tr').length, used: [...document.querySelectorAll('#px-groups tbody a.ulink')].map(a => a.textContent), gvals: !!document.getElementById('px-gvals'),
      cols: [...document.querySelectorAll('#px-groups thead th')].map(t => t.textContent).join('|'), lv: !document.getElementById('xf-level').hidden}));
    ok(/pv=group/.test(gv.h) && gv.rows === 1 && gv.gvals && users.every(u => gv.used.includes(u)) && gv.cols === 'Group|Level|Family|Account|Region|Changed|Problems|Used by' && gv.lv, 'group view opened from the card (Level shown): ' + JSON.stringify(gv));
    await g.evaluate(n => [...document.querySelectorAll('#px-groups tbody a.ulink')].find(a => a.textContent === n).click(), m.name); await sleep(250);
    ok(await g.evaluate(() => { const e = document.querySelector('tr.srow.hlres'); return e && e.getAttribute('aria-expanded') === 'true'; }) && SV.length > 0, 'group used-by link opens its server row in By resource');
    await nav('#tab=parameters&pv=group');
    gv = await g.evaluate(() => ({rows: document.querySelectorAll('#px-groups tbody tr').length, def: document.querySelectorAll('#px-groups .p-warn').length}));
    ok(gv.rows === P.groups.length && gv.def === P.groups.filter(x => x.is_default).length, 'group view: every group, default groups flagged: ' + JSON.stringify(gv));
    await sel('#xf-level', 'cluster');
    ok(await g.evaluate(() => document.querySelectorAll('#px-groups tbody tr').length) === P.groups.filter(x => x.kind === 'cluster').length, 'group view + Level cluster');
    await sel('#xf-level', '');
    if (shots) await g.screenshot({path: path.join(shots, '07_by_group.png'), fullPage: false});
    await g.click('#px-csv'); await sleep(100); d = await lastDl();
    ok(/_parameters_group\.csv$/.test(d.name) && d.text.trim().split('\r\n').length === P.groups.length + 1, 'group CSV');
    const cl = R.find(r => r.type === 'cluster');
    if (cl) { await nav('#id=' + encodeURIComponent(cl.res_id));
      ok(await g.evaluate(() => [...document.querySelectorAll('#card a.pglink')].some(a => /\|cluster\|/.test(a.getAttribute('data-grp')))), 'cluster card links to the cluster parameter group'); }
    ok(await g.evaluate(() => /parameter step [\d.]+ s/.test(document.body.textContent)), 'footer: parameter step time');
    // mobile
    await g.setViewport({width: 390, height: 844, isMobile: true});
    for (const h of ['#tab=parameters', '#tab=parameters&pv=group', '#tab=parameters&res=' + encodeURIComponent(c1.res_id)]) { await nav(h);
      ok(await g.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, 'mobile: no sideways scroll ' + h); }
    if (shots) await g.screenshot({path: path.join(shots, '08_mobile.png'), fullPage: false});
  }
  ok(errs.length === 0, 'no JS errors: ' + errs.join('; '));
  ok(net.length === 0, 'no network: ' + net.join(' '));
  console.log(JSON.stringify({fails, passed: n - fails.length, total: n}));
  await b.close(); process.exit(fails.length ? 1 : 0);
})().catch(e => { fails.push(String(e && e.stack || e)); console.log(JSON.stringify({fails})); process.exit(1); });
