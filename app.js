/* Gilman Sales Leads v1 — standalone PWA (state tile map, leads, chain & printer news).
   Reads same-origin sales-leads-data.json (generated daily by /workspace/sales-leads/daily_leads.py).
   Public-source facts only. Offline copy lives in its own IndexedDB database: sales-leads-app. */
(() => {
  const VER = 'v1';
  const STALE_MS = 36 * 60 * 60 * 1000;
  const POLL_MS = 60 * 60 * 1000;
  const FILE = 'sales-leads-data.json';
  const IDB_NAME = 'sales-leads-app';
  const TABS = ['map', 'leads', 'news', 'about'];
  const WIDE = matchMedia('(min-width: 1000px)');
  const NOTICE_FALLBACK = 'Gilman Brothers, The Gilman Brothers Company and its product names (INFINITY®, EAGLECELL®, InSite®, Reveal®, Ryno Board®, Gilco®, MountCor®, Resilient®, ADHERE™) are trademarks or registered trademarks of The Gilman Brothers Company. Other company and brand names are trademarks of their respective owners; listing does not imply endorsement. Product fit is a suggestion. Public-source research for internal sales planning only.';

  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = u => /^https?:\/\//i.test(String(u || '')) ? String(u) : '';

  let data = null, usedOffline = false, staleDemo = false, dbp, poll = null;
  let view = { tab: 'map', region: 'All', size: 'all', metric: 'targets', mapMode: 'tiles', state: '',
    lProduct: 'all', lState: 'all', lTier: 'all', lType: 'all', lEvid: false, nState: 'all', nType: 'all', nSeg: 'all' };

  /* tile map: [state, col, row] — 11 columns x 8 rows */
  const TILES = [['AK',0,0],['ME',10,0],['VT',9,1],['NH',10,1],
    ['WA',0,2],['ID',1,2],['MT',2,2],['ND',3,2],['MN',4,2],['IL',5,2],['WI',6,2],['MI',7,2],['NY',8,2],['RI',9,2],['MA',10,2],
    ['OR',0,3],['NV',1,3],['WY',2,3],['SD',3,3],['IA',4,3],['IN',5,3],['OH',6,3],['PA',7,3],['NJ',8,3],['CT',9,3],
    ['CA',0,4],['UT',1,4],['CO',2,4],['NE',3,4],['MO',4,4],['KY',5,4],['WV',6,4],['VA',7,4],['MD',8,4],['DE',9,4],
    ['AZ',1,5],['NM',2,5],['KS',3,5],['AR',4,5],['TN',5,5],['NC',6,5],['SC',7,5],['DC',8,5],
    ['OK',3,6],['LA',4,6],['MS',5,6],['AL',6,6],['GA',7,6],
    ['HI',0,7],['TX',3,7],['FL',8,7]];
  const REGIONS = ['All', 'Northeast', 'South', 'Midwest', 'West'];
  const SIZES = [['all', 'All sizes'], ['s1_19', '1–19'], ['s20_99', '20–99'], ['s100', '100+']];
  const METRICS = [['targets', 'Target printers (100+ emp.)'], ['census', 'Census: printers & sign shops']];
  const NEWS_TYPES = ['opening', 'remodel', 'acquisition', 'expansion', 'closing', 'other'];
  const TIER_LAB = { A: 'A · rigid / flatbed shown', B: 'B · graphics shown', C: 'C · check site' };



  /* ---------- IndexedDB (separate database; additive only) ---------- */
  function openDB() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(IDB_NAME, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('news')) db.createObjectStore('news', { keyPath: 'id' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return dbp;
  }
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  function tx(store, mode, fn) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode); let out;
      Promise.resolve(fn(t.objectStore(store))).then(v => { out = v; });
      t.oncomplete = () => resolve(out); t.onerror = () => reject(t.error);
    }));
  }
  async function saveSnapshot(payload) {
    try {
      await tx('meta', 'readwrite', s => { s.put({ id: 'file-cache', payload, fetchedAt: new Date().toISOString() }); });
      await tx('news', 'readwrite', s => { for (const n of payload.news || []) if (n && n.id) s.put(n); });
    } catch (e) { console.warn('idb save', e); }
  }
  async function loadSnapshot() {
    try {
      const meta = await tx('meta', 'readonly', s => req(s.get('file-cache')));
      const news = await tx('news', 'readonly', s => req(s.getAll())) || [];
      return { payload: meta && meta.payload, news };
    } catch (e) { return { payload: null, news: [] }; }
  }
  function mergeNews(fileNews, saved) {
    const m = new Map();
    for (const n of saved || []) if (n && n.id) m.set(n.id, n);
    for (const n of fileNews || []) if (n && n.id) m.set(n.id, n);
    const cutoff = Date.now() - 120 * 864e5; // keep four months on the device
    return [...m.values()].filter(n => { const t = Date.parse(n.published_iso); return isFinite(t) && t > cutoff && t < Date.now() + 6 * 36e5; })
      .sort((a, b) => String(b.published_iso).localeCompare(String(a.published_iso)));
  }

  /* ---------- helpers ---------- */
  const states = () => (data && data.census && data.census.states) || [];
  const stateRec = st => states().find(s => s.state === st);
  const printers = () => (data && data.printers) || [];
  const leads = () => (data && data.leads) || [];
  const news = () => (data && data.news) || [];
  function isStale() {
    if (staleDemo) return true;
    const t = data && Date.parse(data.generated_iso);
    if (!t || !isFinite(t)) return true;
    return Date.now() - t > STALE_MS;
  }
  function fmtDate(iso) {
    const d = new Date(iso);
    if (isNaN(+d)) return '—';
    try { return d.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET'; } catch (e) { return iso; }
  }
  const fmtN = n => (n == null || n === '') ? '—' : Number(n).toLocaleString('en-US');
  function censusValue(s) {
    if (!s || !s.core) return 0;
    return view.size === 'all' ? s.core.est : (s.core[view.size] || 0);
  }
  function tileValue(st) {
    const s = stateRec(st);
    if (view.metric === 'targets') return printers().filter(p => p.state === st).length;
    return censusValue(s);
  }
  function inRegion(st) { const s = stateRec(st); return view.region === 'All' || (s && s.region === view.region); }

  /* ---------- rendering ---------- */
  function seg(id, items, cur, attr) {
    const el = $('#' + id); if (!el) return;
    el.innerHTML = items.map(([v, l]) => `<button type="button" data-${attr}="${esc(v)}" class="${v === cur ? 'on' : ''}" aria-pressed="${v === cur}">${esc(l)}</button>`).join('');
  }
  const sizeLab = () => (SIZES.find(z => z[0] === view.size) || [, ''])[1];
  function tileLabel(st, v) {
    const s = stateRec(st);
    return `${s ? s.name : st}: ${view.metric === 'targets' ? v + ' target printers' : fmtN(v) + ' printers & sign shops (' + sizeLab() + ')'}`;
  }
  function renderMap() {
    seg('slMetric', [['targets', 'Printers'], ['census', 'Census']], view.metric, 'metric');
    seg('slRegion', REGIONS.map(r => [r, r === 'All' ? 'All regions' : r]), view.region, 'region');
    seg('slSize', SIZES, view.size, 'size');
    seg('slMapMode', [['tiles', 'Map'], ['list', 'List']], view.mapMode, 'mode');
    const map = $('#slMap'); if (!map) return;
    const vals = TILES.filter(([st]) => inRegion(st)).map(([st]) => tileValue(st));
    const max = Math.max(1, ...vals);
    map.innerHTML = TILES.map(([st, c, r]) => {
      const v = tileValue(st), on = inRegion(st);
      const pct = v ? Math.round(14 + 70 * Math.sqrt(v / max)) : 0;
      const lab = tileLabel(st, v);
      return `<button type="button" class="tile${on ? '' : ' dim'}${view.state === st ? ' sel' : ''}${pct > 50 ? ' hot' : ''}" data-st="${st}" style="grid-column:${c + 1};grid-row:${r + 1};--p:${pct}%" aria-label="${esc(lab)}" title="${esc(lab)}"><b>${st}</b><small>${v ? fmtN(v) : '·'}</small></button>`;
    }).join('');
    const list = $('#slStateList');
    const rows = TILES.map(([st]) => st).filter(inRegion).map(st => ({ st, v: tileValue(st), name: (stateRec(st) || {}).name || st }))
      .sort((a, b) => b.v - a.v || a.name.localeCompare(b.name));
    list.innerHTML = rows.map(r => `<li><button type="button" data-st="${r.st}" class="${view.state === r.st ? 'sel' : ''}"><span class="sl-st">${r.st}</span><span class="sl-nm">${esc(r.name)}</span><span class="sl-v">${r.v ? fmtN(r.v) : '—'}</span><i style="--w:${Math.round(100 * r.v / max)}%"></i></button></li>`).join('');
    const wide = WIDE.matches; // tablets in landscape: map and ranked list side by side
    $('#slMapWrap').hidden = !wide && view.mapMode !== 'tiles';
    list.hidden = !wide && view.mapMode !== 'list';
    $('#slMapMode').hidden = wide;
    $('#slPanHint').hidden = wide || view.mapMode !== 'tiles';
    const tot = vals.reduce((a, b) => a + b, 0);
    const where = view.region === 'All' ? 'the U.S.' : 'the ' + view.region + '.';
    $('#slMapNote').textContent = view.metric === 'targets'
      ? `${tot} target printers (more than 100 employees, wide-format / rigid graphics) in ${where} Tap a state for its card.`
      : `${fmtN(tot)} commercial printing, screen printing and sign manufacturing establishments (${sizeLab()} employees), Census CBP ${data && data.census ? data.census.year : ''}. Tap a state for its card.`;
  }
  function renderCard() {
    const card = $('#slCard'), back = $('#sheetBack');
    const st = view.state;
    if (!st) { card.hidden = true; back.hidden = true; card.innerHTML = ''; document.body.classList.remove('sheet-open'); return; }
    card.hidden = false; back.hidden = false; document.body.classList.add('sheet-open');
    const s = stateRec(st) || { name: st, naics: {}, region: '' };
    const lab = (data && data.census && data.census.naics) || {};
    const rows = ['323111', '323113', '339950'].map(k => { const n = (s.naics || {})[k] || {}; return `<tr><td>${esc(lab[k] || k)} <span class="code">${k}</span></td><td>${fmtN(n.est)}</td><td>${fmtN(n.s1_19)}</td><td>${fmtN(n.s20_99)}</td><td>${fmtN(n.s100)}</td></tr>`; }).join('');
    const ps = printers().filter(p => p.state === st).sort((a, b) => (a.tier || 'Z').localeCompare(b.tier || 'Z') || (parseInt(b.employees) || 0) - (parseInt(a.employees) || 0));
    const ns = news().filter(n => (n.states || []).includes(st)).slice(0, 12);
    card.innerHTML = `
      <div class="grab" aria-hidden="true"></div>
      <div class="card-head"><h2>${esc(s.name)} <span class="reg">${esc(s.region || '')}</span></h2>
        <button type="button" class="ibtn" id="slCardClose" aria-label="Close the state card">✕</button></div>
      <div class="card-body">
        <button type="button" class="btn wide" id="slCardLeads">Show ${esc(st)} leads</button>
        <h4>Census County Business Patterns ${data && data.census ? esc(data.census.year) : ''} · establishments by employee size</h4>
        <div class="table-wrap small"><table class="ctable"><thead><tr><th>Industry (NAICS)</th><th>All</th><th>1–19</th><th>20–99</th><th>100+</th></tr></thead><tbody>${rows}</tbody></table></div>
        <p class="fine">A few size classes are withheld by Census, so rows can add up to less than All.</p>
        ${safeUrl(data && data.census && data.census.source_url) ? `<a class="srclink" href="${esc(data.census.source_url)}" target="_blank" rel="noopener">Source: U.S. Census Bureau CBP ↗</a>` : ''}
        <h4>Target printers in ${esc(st)} (${ps.length})</h4>
        ${ps.length ? `<ul class="plist">${ps.map(p => `<li><div><b>${esc(p.company)}</b> · ${esc(p.city)}, ${esc(p.state)} · ${esc(p.employees)} employees <span class="chip tier-${esc(p.tier)}">${esc(TIER_LAB[p.tier] || p.tier)}</span></div>
          <div class="sub">${p.products && p.products.length ? 'Fit (suggested): ' + esc(p.products.join(', ')) + ' · ' : ''}${p.end_user_count ? p.end_user_count + (p.end_user_count === 1 ? ' evidenced end user · ' : ' evidenced end users · ') : ''}headcount ${esc(p.headcount_exact || '')}</div>
          <div class="links">${safeUrl(p.headcount_url) ? `<a href="${esc(p.headcount_url)}" target="_blank" rel="noopener">Headcount source ↗</a>` : ''}${safeUrl(p.capability_evidence_url) ? `<a href="${esc(p.capability_evidence_url)}" target="_blank" rel="noopener">Capability page ↗</a>` : ''}</div></li>`).join('')}</ul>`
          : `<p class="empty">No printers over 100 employees with verified wide-format / rigid graphics work are listed in ${esc(st)} yet.</p>`}
        <h4>News mentioning ${esc(st)} (${ns.length})</h4>
        ${ns.length ? `<ul class="news small">${ns.map(newsItem).join('')}</ul>` : `<p class="empty">No recent openings, remodels or printer news found for ${esc(st)}.</p>`}
      </div>`;
  }
  function filteredLeads() {
    return leads().filter(l => (view.lProduct === 'all' || l.product === view.lProduct) && (view.lState === 'all' || l.state === view.lState)
      && (view.lTier === 'all' || l.tier === view.lTier) && (view.lType === 'all' || l.end_user_type === view.lType) && (!view.lEvid || l.end_user))
      .sort((a, b) => (b.end_user ? 1 : 0) - (a.end_user ? 1 : 0) || String(a.tier).localeCompare(String(b.tier)) || a.printer.localeCompare(b.printer) || a.product.localeCompare(b.product));
  }
  function fillSel(id, opts, cur, allLab) {
    const el = $('#' + id); if (!el) return;
    const key = opts.join('|');
    if (el.dataset.built !== key) {
      el.innerHTML = `<option value="all">${esc(allLab)}</option>` + opts.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
      el.dataset.built = key;
    }
    el.value = opts.includes(cur) ? cur : 'all';
  }
  const strCls = l => 'str-' + esc(String(l.strength).split(' ')[0].toLowerCase());
  const srcLink = l => safeUrl(l.source_url) ? `<a class="srclink" href="${esc(l.source_url)}" target="_blank" rel="noopener" aria-label="Open source for ${esc(l.printer)}${l.end_user ? ' and ' + esc(l.end_user) : ''}">Source ↗</a>` : '—';
  function renderLeads() {
    const L = leads();
    fillSel('slFProduct', (data && data.products && data.products.filter(p => L.some(l => l.product === p))) || [...new Set(L.map(l => l.product))], view.lProduct, 'All Gilman products');
    fillSel('slFState', [...new Set(L.map(l => l.state))].sort(), view.lState, 'All states');
    fillSel('slFTier', ['A', 'B', 'C'], view.lTier, 'All tiers');
    fillSel('slFType', [...new Set(L.map(l => l.end_user_type).filter(Boolean))].sort(), view.lType, 'All end-user types');
    const ev = $('#slFEvid'); ev.classList.toggle('on', view.lEvid); ev.setAttribute('aria-pressed', String(view.lEvid));
    const rows = filteredLeads();
    $('#slLeadCount').textContent = `${rows.length} rows · ${new Set(rows.map(r => r.printer)).size} printers · ${new Set(rows.filter(r => r.end_user).map(r => r.end_user)).size} end users`;
    const MAX = 300;
    const more = rows.length > MAX ? `Showing ${MAX} of ${rows.length}. Narrow the filters or export CSV for all.` : '';
    $('#slLeadBody').innerHTML = rows.length ? rows.slice(0, MAX).map(l => `<tr>
        <td class="prod">${esc(l.product)}<span class="sug">suggested</span></td>
        <td><b>${esc(l.printer)}</b><div class="sub">${esc(l.state)} · ${esc(l.employees)} emp. · Tier ${esc(l.tier)}</div></td>
        <td>${l.end_user ? `<b>${esc(l.end_user)}</b><div class="sub">${esc(l.end_user_type)}</div>` : '<span class="none">None found yet</span>'}</td>
        <td><span class="chip ${strCls(l)}">${esc(l.strength)}</span></td>
        <td>${srcLink(l)}</td></tr>`).join('') + (more ? `<tr><td colspan="5" class="empty">${more}</td></tr>` : '')
      : `<tr><td colspan="5" class="empty">No leads match these filters.</td></tr>`;
    $('#slLeadCards').innerHTML = rows.length ? rows.slice(0, MAX).map(l => `<li class="lcard">
        <div class="lc-top"><span class="lc-prod">${esc(l.product)}</span><span class="sug">suggested fit</span><span class="chip ${strCls(l)}">${esc(l.strength)}</span></div>
        <div class="lc-row"><span class="lc-k">Printer</span><span><b>${esc(l.printer)}</b><span class="sub"> · ${esc(l.state)} · ${esc(l.employees)} emp. · Tier ${esc(l.tier)}</span></span></div>
        <div class="lc-row"><span class="lc-k">End user</span><span>${l.end_user ? `<b>${esc(l.end_user)}</b><span class="sub"> · ${esc(l.end_user_type)}</span>` : '<span class="none">None found yet</span>'}</span></div>
        <div class="lc-src">${srcLink(l)}</div></li>`).join('') + (more ? `<li class="empty">${more}</li>` : '')
      : `<li class="empty">No leads match these filters.</li>`;
  }
  function filteredNews() {
    return news().filter(n => (view.nState === 'all' || (n.states || []).includes(view.nState)) && (view.nType === 'all' || n.type === view.nType)
      && (view.nSeg === 'all' || n.segment === view.nSeg));
  }
  function newsItem(n) {
    const u = safeUrl(n.url);
    return `<li class="ni"><div class="ni-top"><span class="chip type-${esc(n.type)}">${esc(n.type)}</span><span class="ni-seg">${esc(n.segment)}</span>
      <span class="ni-date">${esc(fmtDate(n.published_iso))}</span></div>
      <div class="ni-title">${u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(n.title)}</a>` : esc(n.title)}</div>
      <div class="sub">${esc(n.source || '')}${(n.states || []).length ? ' · ' + esc(n.states.join(', ')) : ''}${(n.printers || []).length ? ' · printer: ' + esc(n.printers.join(', ')) : ''}${(n.end_users || []).length ? ' · ' + esc(n.end_users.join(', ')) : ''}</div>
      ${(n.linked || []).length ? `<div class="linked">Known link: ${esc(n.linked.slice(0, 3).join(' · '))}</div>` : ''}</li>`;
  }
  function renderNews() {
    const N = news();
    fillSel('slNState', [...new Set(N.flatMap(n => n.states || []))].sort(), view.nState, 'All states');
    fillSel('slNType', NEWS_TYPES.filter(t => N.some(n => n.type === t)), view.nType, 'All types');
    fillSel('slNSeg', [...new Set(N.map(n => n.segment).filter(Boolean))].sort(), view.nSeg, 'All segments');
    const rows = filteredNews();
    $('#slNewsCount').textContent = `${rows.length} of ${N.length} items`;
    $('#slNewsList').innerHTML = rows.length ? rows.slice(0, 250).map(newsItem).join('') : `<li class="empty">No news matches these filters.</li>`;
  }
  function themePref() { try { const t = localStorage.getItem('slaTheme'); return t === 'light' || t === 'dark' ? t : 'auto'; } catch (e) { return 'auto'; } }
  function applyTheme() {
    const p = themePref();
    document.documentElement.dataset.theme = p === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : p;
  }
  function renderAbout() {
    $('#slVersion').textContent = VER;
    $('#slAboutUpdated').textContent = data ? fmtDate(data.generated_iso) : '—';
    seg('slTheme', [['auto', 'Match device'], ['light', 'Light'], ['dark', 'Dark']], themePref(), 'theme');
    $('#slNotice').textContent = (data && data.notice) || NOTICE_FALLBACK;
    if (data && Array.isArray(data.sources)) $('#slSources').innerHTML = data.sources.map(s => `<li>${safeUrl(s.url) ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name)}<div class="sub">${esc(s.use || '')}</div></li>`).join('');
    if (data) $('#slAboutStats').innerHTML = [['Target printers', printers().length], ['Lead rows', leads().length], ['News items', news().length], ['Census year', data.census && data.census.year], ['Stale after', '36 hours'], ['Offline copy', 'Saved on this device']]
      .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  }
  function render() {
    document.body.classList.toggle('stale', !!data && isStale());
    document.body.classList.toggle('offline', !!usedOffline);
    $('#slUpdated').textContent = data ? `Updated ${fmtDate(data.generated_iso)}` : 'Loading…';
    TABS.forEach(t => {
      const b = $(`#tabs [data-tab="${t}"]`); b.classList.toggle('on', view.tab === t); b.setAttribute('aria-selected', String(view.tab === t));
      $('#view-' + t).hidden = view.tab !== t;
    });
    renderAbout();
    if (!data) return;
    renderMap(); renderCard(); renderLeads(); renderNews();
  }

  async function pullFile() {
    usedOffline = false;
    try {
      const res = await fetch(FILE + '?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const payload = await res.json();
      if (!payload || payload.schema !== 'pencil-sales-leads/1' || !Array.isArray(payload.leads)) throw new Error('sales-leads-data.json has an unexpected shape');
      await saveSnapshot(payload);
      const snap = await loadSnapshot();
      data = Object.assign({}, payload, { news: mergeNews(payload.news, snap.news) });
      render();
      return true;
    } catch (e) {
      usedOffline = true;
      const snap = await loadSnapshot();
      if (snap.payload) data = Object.assign({}, snap.payload, { news: mergeNews(snap.payload.news, snap.news) });
      render();
      return false;
    }
  }
  function csvText() {
    const rows = filteredLeads();
    const headers = ['product', 'printer', 'state', 'region', 'employees', 'tier', 'end_user', 'end_user_type', 'strength', 'evidence', 'source_url', 'printer_source_url'];
    const escC = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return { n: rows.length, csv: [headers.join(',')].concat(rows.map(r => headers.map(h => escC(r[h])).join(','))).join('\r\n') };
  }
  const CSV_NAME = 'gilman-sales-leads.csv';
  function csvFile(csv) { try { return new File([csv], CSV_NAME, { type: 'text/csv' }); } catch (e) { return null; } }
  function canShareCsv() {
    const f = csvFile('a');
    try { return !!(f && navigator.canShare && navigator.canShare({ files: [f] })); } catch (e) { return false; }
  }
  /* Export: a blob download (works in Android Chrome and installed PWAs; the file lands in Downloads).
     If the browser cannot download blobs, fall back to the Web Share sheet with the CSV file attached. */
  async function exportCsv(opts = {}) {
    const { n, csv } = csvText();
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    if (!opts.share && 'download' in a) {
      a.href = URL.createObjectURL(blob); a.download = CSV_NAME; a.rel = 'noopener';
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
      toast(`Exported ${n} rows to ${CSV_NAME}`);
      return { n, via: 'download' };
    }
    const f = csvFile(csv);
    if (f && canShareCsv()) {
      try { await navigator.share({ files: [f], title: 'Gilman sales leads' }); return { n, via: 'share' }; }
      catch (e) { if (e && e.name === 'AbortError') return { n, via: 'cancelled' }; }
    }
    window.open(URL.createObjectURL(blob), '_blank');
    return { n, via: 'open' };
  }
  let toastT;
  function toast(msg) {
    const t = $('#toast'); if (!t) return;
    t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2600);
  }

  /* history: every tab change and every open state card is its own history entry, so the Android back button
     (and browser back) closes the card first, then walks back through tabs, instead of leaving the app */
  const histState = () => ({ sla: 1, tab: view.tab, state: view.state || '' });
  function pushHist(replace) {
    const url = '#' + view.tab + (view.state ? '/' + view.state : '');
    try { history[replace ? 'replaceState' : 'pushState'](histState(), '', url); } catch (e) { /* sandboxed */ }
  }
  let pendingBack = false, deferPush = false; // a UI close is stepping back over the card's entry
  function setTab(t, push = true) {
    if (!TABS.includes(t)) t = 'map';
    const changed = t !== view.tab || view.state;
    view.tab = t; view.state = '';
    if (push && changed) { if (pendingBack) deferPush = true; else pushHist(false); }
    render();
    window.scrollTo(0, 0);
  }
  function selectState(st, push = true) {
    const cur = view.state;
    if (!st && cur) {
      // closing the card from the UI: step back over the card's own history entry when it is the current one
      view.state = ''; render();
      if (push && history.state && history.state.sla && history.state.state === cur) { pendingBack = true; history.back(); }
      return;
    }
    if (!st) return;
    view.tab = 'map'; view.state = st;
    if (push) { if (pendingBack) deferPush = true; else pushHist(!!cur); } // switching state-to-state replaces, so one back press always closes the card
    render();
    const c = $('#slCard'); if (c) c.scrollTop = 0;
  }
  function fromHash() {
    const [t, st] = location.hash.slice(1).split('/');
    return { tab: TABS.includes(t) ? t : 'map', state: st && /^[A-Z]{2}$/.test(st) && (!data || stateRec(st)) ? st : '' };
  }
  function bind() {
    $('#slRefresh').addEventListener('click', () => pullFile());
    $('#tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) setTab(b.dataset.tab); });
    const segClick = (id, attr, key, after) => $('#' + id).addEventListener('click', e => { const b = e.target.closest(`button[data-${attr}]`); if (!b) return; view[key] = b.dataset[attr]; if (after) after(); render(); });
    segClick('slRegion', 'region', 'region', () => { if (view.state && !inRegion(view.state)) view.state = ''; });
    segClick('slSize', 'size', 'size', () => { view.metric = 'census'; });
    segClick('slMetric', 'metric', 'metric');
    segClick('slMapMode', 'mode', 'mapMode');
    $('#slTheme').addEventListener('click', e => { const b = e.target.closest('button[data-theme]'); if (!b) return; try { if (b.dataset.theme === 'auto') localStorage.removeItem('slaTheme'); else localStorage.setItem('slaTheme', b.dataset.theme); } catch (err) { /* private mode */ } applyTheme(); render(); });
    const pick = e => { const b = e.target.closest('button[data-st]'); if (b) selectState(view.state === b.dataset.st ? '' : b.dataset.st); };
    $('#slMap').addEventListener('click', pick);
    $('#slStateList').addEventListener('click', pick);
    $('#sheetBack').addEventListener('click', () => selectState(''));
    $('#slCard').addEventListener('click', e => {
      if (e.target.closest('#slCardClose')) selectState('');
      else if (e.target.closest('#slCardLeads')) { view.lState = view.state; view.state = ''; view.tab = 'leads'; pushHist(true); render(); window.scrollTo(0, 0); }
    });
    const sel = (id, key) => $('#' + id).addEventListener('change', e => { view[key] = e.target.value; render(); });
    sel('slFProduct', 'lProduct'); sel('slFState', 'lState'); sel('slFTier', 'lTier'); sel('slFType', 'lType');
    sel('slNState', 'nState'); sel('slNType', 'nType'); sel('slNSeg', 'nSeg');
    $('#slFEvid').addEventListener('click', () => { view.lEvid = !view.lEvid; render(); });
    $('#slExport').addEventListener('click', () => exportCsv());
    const sh = $('#slShare'); sh.hidden = !canShareCsv(); sh.addEventListener('click', () => exportCsv({ share: true }));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && view.state) selectState(''); });
    window.addEventListener('popstate', e => {
      if (pendingBack) { pendingBack = false; if (deferPush) { deferPush = false; pushHist(false); } return; }
      const h = (e.state && e.state.sla) ? e.state : fromHash();
      view.tab = h.tab; view.state = h.state || ''; render();
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (themePref() === 'auto') applyTheme(); });
    WIDE.addEventListener('change', () => render());
    document.addEventListener('visibilitychange', () => { if (!document.hidden && data && isStale()) pullFile(); });
  }
  function boot() {
    applyTheme(); bind();
    const h = fromHash(); view.tab = h.tab;
    // base entry is always a plain tab, so back from a deep-linked card lands in the app, not outside it
    pushHist(true);
    if (h.state) { view.state = h.state; pushHist(false); }
    render(); pullFile();
    poll = setInterval(pullFile, POLL_MS);
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(e => console.warn('sw', e));
  }

  window.SalesLeads = {
    version: VER,
    refresh: pullFile,
    demoStale(on) { staleDemo = !!on; render(); },
    data: () => data,
    view: () => Object.assign({}, view),
    setView(v) { Object.assign(view, v || {}); render(); },
    setTab, selectState, exportCsv, csvText, canShareCsv, filteredLeads, filteredNews, isStale: () => !!data && isStale(),
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
