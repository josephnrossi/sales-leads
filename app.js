/* Gilman Sales Leads v3: B2B smart lead finder. One row per company, ranked by a transparent Fit Score,
   matched to the best Gilman product, with a verification badge and opportunity signals.
   Reads same-origin sales-leads-data.json (built daily by /workspace/sales-leads/v3/build_v3.py).
   Public company facts only. Offline copy lives in its own IndexedDB database: sales-leads-app (never deleted). */
(() => {
  const VER = 'v3';
  const STALE_MS = 36 * 60 * 60 * 1000;
  const POLL_MS = 60 * 60 * 1000;
  const FILE = 'sales-leads-data.json';
  const IDB_NAME = 'sales-leads-app';
  const TABS = ['leads', 'map', 'signals', 'about'];
  const PAGE = 40;
  const NOTICE_FALLBACK = 'Gilman Brothers, The Gilman Brothers Company and its product names (INFINITY®, EAGLECELL®, InSite®, Reveal®, Ryno Board®, Gilco®, MountCor®, Resilient®) are trademarks or registered trademarks of The Gilman Brothers Company. Other company and brand names are trademarks of their respective owners; listing does not imply endorsement. Product fit is a suggestion. Public-source research for internal sales planning only.';
  const OEM_FALLBACK = 'Printer and cutter brand names (EFI, VUTEk, Durst, HP, Canon, Fujifilm, Zünd, Kongsberg, MultiCam, Colex and others) are trademarks of their respective owners. No OEM endorsement is implied.';
  const TYPES = [['all', 'All buyers'], ['printer', 'Printers'], ['oem', 'Display makers'], ['retailer', 'Retailers'], ['equipment_oem', 'Equipment partners']];
  const TYPE_LAB = { printer: 'Printer / converter', oem: 'OEM · fabricator / display maker', retailer: 'Retailer / brand', equipment_oem: 'Equipment OEM (channel partner)' };
  const TYPE_SHORT = { printer: 'Printer', oem: 'Display maker', retailer: 'Retailer', equipment_oem: 'Equip. partner' };
  const MINS = [0, 40, 50, 60, 70];
  const SIGS = [['all', 'All'], ['news', 'News'], ['social', 'Social']];
  const CAT_LAB = { install: 'Install', rollout: 'Rollout', pop: 'POP / display', tradeshow: 'Trade show', sustain: 'Sustainability', hiring: 'Hiring', growth: 'Growth', opening: 'Opening', remodel: 'Remodel', expansion: 'Expansion', acquisition: 'Acquisition', closing: 'Closing', other: 'News' };
  const TILES = [['AK',0,0],['ME',10,0],['VT',9,1],['NH',10,1],
    ['WA',0,2],['ID',1,2],['MT',2,2],['ND',3,2],['MN',4,2],['IL',5,2],['WI',6,2],['MI',7,2],['NY',8,2],['RI',9,2],['MA',10,2],
    ['OR',0,3],['NV',1,3],['WY',2,3],['SD',3,3],['IA',4,3],['IN',5,3],['OH',6,3],['PA',7,3],['NJ',8,3],['CT',9,3],
    ['CA',0,4],['UT',1,4],['CO',2,4],['NE',3,4],['MO',4,4],['KY',5,4],['WV',6,4],['VA',7,4],['MD',8,4],['DE',9,4],
    ['AZ',1,5],['NM',2,5],['KS',3,5],['AR',4,5],['TN',5,5],['NC',6,5],['SC',7,5],['DC',8,5],
    ['OK',3,6],['LA',4,6],['MS',5,6],['AL',6,6],['GA',7,6],
    ['HI',0,7],['TX',3,7],['FL',8,7]];
  const REGION = { Northeast: 'CT ME MA NH RI VT NJ NY PA', Midwest: 'IL IN MI OH WI IA KS MN MO NE ND SD', South: 'DE DC FL GA MD NC SC VA WV AL KY MS TN AR LA OK TX', West: 'AZ CO ID MT NV NM UT WY AK CA HI OR WA' };
  const regionOf = st => Object.keys(REGION).find(r => REGION[r].split(' ').includes(st)) || '';

  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = u => /^https?:\/\//i.test(String(u || '')) ? String(u) : '';
  const ext = (u, label, cls = 'src') => safeUrl(u) ? `<a class="${cls}" href="${esc(u)}" target="_blank" rel="noopener">${label}</a>` : '';

  let data = null, usedOffline = false, staleDemo = false, dbp, poll = null;
  let view = { tab: 'leads', type: 'all', q: '', product: 'all', state: 'all', region: 'all', min: 0, ver: false, max: PAGE, open: '', sig: 'all', filters: false };

  /* ---------- IndexedDB (separate database; additive only, never deleted) ---------- */
  function openDB() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(IDB_NAME, 1);
      r.onupgradeneeded = () => { const db = r.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('news')) db.createObjectStore('news', { keyPath: 'id' }); };
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
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
  async function saveSnapshot(payload) { try { await tx('meta', 'readwrite', s => { s.put({ id: 'file-cache', payload, fetchedAt: new Date().toISOString() }); }); } catch (e) { console.warn('idb save', e); } }
  async function loadSnapshot() { try { const m = await tx('meta', 'readonly', s => req(s.get('file-cache'))); return m && m.payload; } catch (e) { return null; } }

  /* ---------- data helpers ---------- */
  const companies = () => (data && data.companies) || [];
  const byId = id => companies().find(c => c.id === id);
  const signals = () => (data && data.signals) || [];
  const isV3 = () => Array.isArray(data && data.companies);
  function isStale() { if (staleDemo) return true; const t = data && Date.parse(data.generated_iso); return !t || !isFinite(t) || Date.now() - t > STALE_MS; }
  function fmtDate(iso) { const d = new Date(iso); if (isNaN(+d)) return '—';
    return d.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET'; }
  const shortDate = s => { const d = new Date(String(s).slice(0, 10) + 'T12:00:00'); return isNaN(+d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }); };
  const scoreCls = s => s >= 70 ? 'hi' : s >= 50 ? 'md' : 'lo';
  const badgeHtml = b => `<span class="vb vb-${esc((b || 'Unverified').toLowerCase())}">${b === 'Verified' ? '✓ ' : b === 'Partial' ? '◐ ' : '○ '}${esc(b || 'Unverified')}</span>`;
  const sizeTxt = c => c.type === 'printer' || c.type === 'oem' ? (c.size.employees ? `${Number(c.size.employees).toLocaleString()} emp.` : '') : (c.size.label || '').replace(' employees', ' emp.');

  function filtered() {
    const q = view.q.trim().toLowerCase();
    return companies().filter(c => (view.type === 'all' ? c.type !== 'equipment_oem' : c.type === view.type)
      && (view.product === 'all' || (c.best && c.best.product === view.product))
      && (view.state === 'all' || c.state === view.state)
      && (view.region === 'all' || regionOf(c.state) === view.region)
      && c.score >= view.min && (!view.ver || c.verification.badge === 'Verified')
      && (!q || c.name.toLowerCase().includes(q) || (c.best && c.best.product.toLowerCase().includes(q)) || (c.state || '').toLowerCase() === q));
  }
  function activeFilters() { return (view.product !== 'all') + (view.state !== 'all') + (view.region !== 'all') + (view.min > 0) + view.ver; }

  /* ---------- leads ---------- */
  function card(c, i) {
    const loc = [c.city, c.state].filter(Boolean).join(', ');
    return `<li class="lcard" data-open="${esc(c.id)}" tabindex="0" role="button" aria-label="${esc(c.name)}, Fit Score ${c.score}">
      <div class="lc-top"><span class="rank">${i + 1}</span><div class="lc-name"><h3>${esc(c.name)}</h3>
        <div class="lc-meta"><span class="tp tp-${esc(c.type)}">${esc(TYPE_SHORT[c.type] || c.type)}</span>${loc ? `<span>${esc(loc)}</span>` : ''}${sizeTxt(c) ? `<span>${esc(sizeTxt(c))}</span>` : ''}</div></div>
        <div class="score sc-${scoreCls(c.score)}" aria-hidden="true"><b>${c.score}</b><small>fit</small></div></div>
      <div class="lc-prod"><span class="prod">${esc(c.best ? c.best.product : '')}</span>${badgeHtml(c.verification.badge)}</div>
      <p class="lc-why">${esc(c.why[0] || '')}</p></li>`;
  }
  function renderLeads() {
    const types = TYPES.map(([k, l]) => `<button type="button" data-type="${k}" class="${view.type === k ? 'on' : ''}" aria-pressed="${view.type === k}">${l}</button>`).join('');
    $('#slTypeSeg').innerHTML = types;
    const prods = [...new Set(companies().map(c => c.best && c.best.product).filter(Boolean))];
    fillSel('slFProduct', prods.map(p => [p, p]), view.product, 'All products');
    fillSel('slFState', [...new Set(companies().map(c => c.state).filter(Boolean))].sort().map(s => [s, s]), view.state, 'All states');
    fillSel('slFRegion', Object.keys(REGION).map(r => [r, r]), view.region, 'All regions');
    fillSel('slFMin', MINS.slice(1).map(m => [String(m), m + '+']), view.min ? String(view.min) : 'all', 'Any score');
    $('#slFVer').classList.toggle('on', view.ver); $('#slFVer').setAttribute('aria-pressed', view.ver);
    $('#slFilters').hidden = !view.filters; $('#slFBtn').setAttribute('aria-expanded', view.filters);
    const n = activeFilters(); $('#slFCount').textContent = n ? ` · ${n}` : '';
    if ($('#slQ').value !== view.q) $('#slQ').value = view.q;
    const rows = filtered();
    const ver = rows.filter(c => c.verification.badge === 'Verified').length;
    $('#slCount').textContent = `${rows.length} leads · ${ver} verified · ranked by Fit Score`;
    $('#slList').innerHTML = rows.length ? rows.slice(0, view.max).map((c, i) => card(c, i)).join('') + (rows.length > view.max ? `<li class="more"><button type="button" class="btn wide" data-more>Show ${Math.min(PAGE, rows.length - view.max)} more</button></li>` : '')
      : '<li class="empty">No leads match these filters. Lower the minimum score or reset filters.</li>';
  }
  function fillSel(id, opts, cur, allLab) {
    const el = $('#' + id);
    el.innerHTML = `<option value="all">${esc(allLab)}</option>` + opts.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`).join('');
  }

  /* ---------- detail sheet ---------- */
  const resIcon = r => r === 'pass' ? '✓' : r === 'fail' ? '✗' : r === 'partial' ? '◐' : '–';
  function detail(c) {
    const loc = [c.city, c.state].filter(Boolean).join(', ');
    const b = c.best || {};
    const factors = c.factors.map(f => `<li><div class="fx"><span>${esc(f.label)}</span><b>${f.pts}/${f.max}</b></div><div class="bar"><i style="width:${Math.round(100 * f.pts / f.max)}%"></i></div><div class="sub">${esc(f.why)}</div></li>`).join('');
    const eqRow = (lab, arr) => `<div class="eqrow"><span class="eqk">${lab}</span>${arr.length ? arr.map(x => `<a class="eq eq-${x.conf === 'confirmed' ? 'c' : x.conf === 'dated' ? 'd' : 'l'}" href="${esc(safeUrl(x.url))}" target="_blank" rel="noopener" title="${esc(x.conf)}${x.year ? ' · ' + x.year : ''}"><b>${esc(x.brand === 'Zund' ? 'Zünd' : x.brand)}</b> ${esc(x.model)}<i>${x.conf === 'confirmed' ? '✓' : x.conf === 'dated' ? x.year : '~'}</i></a>`).join('') : '<span class="eq eq-n">Not yet found</span>'}</div>`;
    let rel = '';
    if (c.type === 'printer' || c.type === 'oem') {
      rel += `<h4>Equipment</h4><div class="eqchips">${eqRow('Prints', c.equipment.printers)}${eqRow('Cuts', c.equipment.cutters)}</div><p class="fine">✓ confirmed · ~ likely · year = dated (before 2020)</p>`;
      if (c.end_users.length) rel += `<h4>Retail / brand work</h4><ul class="rel">${c.end_users.map(e => { const r = companies().find(x => x.type === 'retailer' && x.name === e.name); return `<li>${r ? `<button type="button" class="lnk" data-open="${esc(r.id)}">${esc(e.name)}</button>` : esc(e.name)}<span class="sub">${esc(e.evidence)}${e.specific ? '' : ' · homepage only'}</span>${ext(e.url, 'Source ↗')}</li>`; }).join('')}</ul>`;
    }
    if (c.type === 'retailer') {
      if (c.printers.length) rel += `<h4>Buys POP through</h4><ul class="rel">${c.printers.map(p => `<li><button type="button" class="lnk" data-open="${esc(p.id)}">${esc(p.name)}</button><span class="sub">${esc(p.evidence)} · fit ${p.score} · ${esc(p.badge)}</span>${ext(p.url, 'Proof ↗')}</li>`).join('')}</ul>`;
      else if (c.route_via) rel += `<h4>Route through</h4><p class="fine">${esc(c.route_note)}</p><ul class="rel">${c.route_via.map(p => `<li><button type="button" class="lnk" data-open="${esc(p.id)}">${esc(p.name)}</button><span class="sub">${esc(p.state)} · fit ${p.score}</span></li>`).join('')}</ul>`;
    }
    if (c.type === 'equipment_oem' && c.installed_at && c.installed_at.length) rel += `<h4>Installed at lead shops</h4><ul class="rel">${c.installed_at.map(n => { const x = companies().find(y => y.name === n); return `<li>${x ? `<button type="button" class="lnk" data-open="${esc(x.id)}">${esc(n)}</button>` : esc(n)}</li>`; }).join('')}</ul>`;
    const sigs = (c.signals || []).length ? `<h4>Signals</h4><ul class="rel">${c.signals.map(s => `<li><span class="cat">${esc(CAT_LAB[s.cat] || s.cat)}</span> ${esc(shortDate(s.date))} · ${esc(s.platform)}<div class="sub">${esc(s.fit)}</div>${ext(s.url, 'Post ↗')}</li>`).join('')}</ul>` : '';
    const soc = Object.entries(c.social || {}).map(([k, v]) => { const u = k === 'x' ? `https://x.com/${v.handle}` : k === 'linkedin' ? `https://www.linkedin.com/company/${v.handle}/` : k === 'instagram' ? `https://www.instagram.com/${v.handle}/` : k === 'facebook' ? `https://www.facebook.com/${v.handle}` : k === 'youtube' ? `https://www.youtube.com/${v.handle}` : k === 'tiktok' ? `https://www.tiktok.com/${v.handle}` : '';
      return `<a class="soc" href="${esc(u)}" target="_blank" rel="noopener" title="${esc(v.how)}${v.last_post ? ' · last post ' + v.last_post : ''}">${esc({ x: 'X', linkedin: 'LinkedIn', instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube', tiktok: 'TikTok' }[k])}${k === 'x' && v.active === false ? ' (inactive)' : ''}</a>`; }).join('');
    const checks = c.verification.checks.map(k => `<li class="ck ck-${esc(k.result)}"><span class="ci">${resIcon(k.result)}</span><div><b>${esc(k.what)}</b><div class="sub">${esc(k.detail)}${k.date ? ' · ' + esc(k.date) : ''}</div></div>${ext(k.url, '↗', 'src sq')}</li>`).join('');
    return `<div class="sh-head"><button type="button" class="ibtn" data-close aria-label="Close">←</button>
        <div class="sh-t"><h2>${esc(c.name)}</h2><div class="lc-meta"><span class="tp tp-${esc(c.type)}">${esc(TYPE_LAB[c.type])}</span>${loc ? `<span>${esc(loc)}</span>` : ''}${c.size.label ? `<span>${esc(c.size.label)}</span>` : ''}</div></div>
        <div class="score big sc-${scoreCls(c.score)}"><b>${c.score}</b><small>fit</small></div></div>
      <div class="sh-body">
        ${c.rename_note ? `<p class="note">${esc(c.rename_note.note)} ${ext(c.rename_note.url, 'Source ↗')}</p>` : ''}
        <h4>Why this lead</h4><ul class="why">${c.why.map(w => `<li>${esc(w)}</li>`).join('')}</ul>
        <div class="bestbox"><div class="bb-h"><span>Best Gilman product</span>${ext(b.url, b.product ? esc(b.product) + ' ↗' : '', 'prod big')}</div>
          <p><b>${esc(b.why_fit || '')}.</b> ${esc(b.value_prop || '')}</p>
          ${b.proof ? `<p class="proof">Proof: ${ext(b.proof.url, esc(b.proof.title) + ' ↗')} <span class="sub">(${esc(b.proof.why)})</span></p>` : ''}
          ${b.alt && b.alt.length ? `<p class="sub">Also fits: ${b.alt.map(esc).join(', ')}</p>` : ''}</div>
        ${rel}${sigs}
        <h4>Verification ${badgeHtml(c.verification.badge)}</h4><p class="fine">${esc(c.verification.summary)}</p><ul class="checks">${checks}</ul>
        ${soc ? `<h4>Official accounts</h4><div class="socs">${soc}</div>` : `<h4>Official accounts</h4><p class="fine">${c.social_checked ? 'None found: no official account is linked from the company site or verified.' : 'Not checked yet for this company.'}</p>`}
        <details class="fxd"><summary>Score breakdown</summary><ul class="factors">${factors}</ul></details>
        ${c.website ? `<p>${ext(c.website, 'Company website ↗', 'btn wide')}</p>` : ''}
      </div>`;
  }
  function openLead(id, push = true) {
    const c = id && byId(id);
    view.open = c ? id : '';
    const sh = $('#slSheet');
    if (!c) { sh.hidden = true; $('#sheetBack').hidden = true; document.body.classList.remove('sheet-open'); if (push) pushHist(); return; }
    sh.innerHTML = detail(c); sh.hidden = false; $('#sheetBack').hidden = false; document.body.classList.add('sheet-open'); sh.scrollTop = 0;
    if (push) pushHist();
    const f = sh.querySelector('[data-close]'); if (f) f.focus({ preventScroll: true });
  }

  /* ---------- map ---------- */
  function renderMap() {
    const min = view.min || 50; $('#slMapMin').textContent = min;
    const cnt = {}; companies().filter(c => c.score >= min && c.state && c.type !== 'equipment_oem').forEach(c => { cnt[c.state] = (cnt[c.state] || 0) + 1; });
    const max = Math.max(1, ...Object.values(cnt));
    $('#slMap').innerHTML = TILES.map(([st, x, y]) => { const n = cnt[st] || 0; const lv = n ? Math.min(4, 1 + Math.floor(3 * n / max)) : 0;
      return `<button type="button" class="tile lv${lv}" style="grid-column:${x + 1};grid-row:${y + 1}" data-st="${st}" aria-label="${st}: ${n} leads"><b>${st}</b><span>${n || ''}</span></button>`; }).join('');
    $('#slLegend').innerHTML = `<span class="tile lv0">0</span><span class="tile lv1">few</span><span class="tile lv4">most (${max})</span>`;
  }

  /* ---------- signals ---------- */
  function renderSignals() {
    $('#slSigSeg').innerHTML = SIGS.map(([k, l]) => `<button type="button" data-sig="${k}" class="${view.sig === k ? 'on' : ''}" aria-pressed="${view.sig === k}">${l}</button>`).join('');
    const rows = signals().filter(s => view.sig === 'all' || s.kind === view.sig);
    $('#slSigCount').textContent = `${rows.length} signals tied to a lead or target chain`;
    $('#slSigList').innerHTML = rows.slice(0, 120).map(s => `<li class="sig"><div class="sg-top"><span class="cat c-${esc(s.type)}">${esc(CAT_LAB[s.type] || s.type)}</span><span class="sub">${esc(shortDate(s.date))} · ${esc(s.source)}</span></div>
      <a class="sg-t" href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener">${esc(s.title)}</a>${s.fit ? `<div class="sub">${esc(s.fit)}</div>` : ''}
      <div class="sg-co">${s.companies.map(x => `<button type="button" class="chip" data-open="${esc(x.id)}">${esc(x.name)}</button>`).join('')}</div></li>`).join('') || '<li class="empty">No signals yet.</li>';
  }

  /* ---------- about ---------- */
  function themePref() { try { const t = localStorage.getItem('slaTheme'); return t === 'light' || t === 'dark' ? t : 'auto'; } catch (e) { return 'auto'; } }
  function applyTheme() { const p = themePref(); document.documentElement.dataset.theme = p === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : p; }
  function renderAbout() {
    $('#slVersion').textContent = VER; $('#slAboutUpdated').textContent = data ? fmtDate(data.generated_iso) : '—';
    const m = (data && data.verification_meta) || { counts: {}, by_type: {} };
    $('#slAboutStats').innerHTML = [['Companies', m.companies], ['Verified', m.counts.Verified || 0], ['Partial', m.counts.Partial || 0], ['Unverified', m.counts.Unverified || 0], ['Removed', m.removed || 0], ['Checked', m.checked || '—']].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
    const sc = (data && data.scoring) || {};
    $('#slBadges').innerHTML = sc.badges ? `<ul class="legend-l">${Object.entries(sc.badges).map(([k, v]) => `<li>${badgeHtml(k)} ${esc(v)}</li>`).join('')}</ul><p class="fine">${esc(m.method || '')} ${esc(m.distributors || '')}</p>` : '';
    const tbl = (t, rows) => rows ? `<h4>${t}</h4><ul class="formula">${rows.map(([k, l, mx]) => `<li><b>${mx}</b><span>${esc(l)}</span></li>`).join('')}</ul>` : '';
    $('#slScoring').innerHTML = tbl('Printers and display makers', sc.printer) + tbl('Retailers / brands', sc.retailer) + tbl('Equipment OEMs', sc.equipment_oem) + '<p class="fine">Scores add to 100. Social signals carry only 5 points so a quiet account never sinks a strong shop.</p>';
    const rm = (data && data.removed) || [];
    $('#slRemovedN').textContent = rm.length;
    $('#slRemoved').innerHTML = rm.map(r => `<li><b>${esc(r.name)}</b> <span class="sub">${esc(r.reason)}</span> ${ext(r.url, 'Source ↗')}</li>`).join('');
    const tp = themePref();
    $('#slTheme').innerHTML = [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<button type="button" data-theme="${k}" class="${tp === k ? 'on' : ''}">${l}</button>`).join('');
    $('#slNotice').textContent = (data && data.notice) || NOTICE_FALLBACK;
    $('#slOemNotice').textContent = (data && data.equipment_notice) || OEM_FALLBACK;
  }

  /* ---------- render / load ---------- */
  function render() {
    document.body.classList.toggle('stale', !!data && isStale());
    document.body.classList.toggle('offline', usedOffline);
    $('#slUpdated').textContent = data ? 'Updated ' + fmtDate(data.generated_iso) : 'Loading…';
    TABS.forEach(t => { $('#view-' + t).hidden = view.tab !== t; const b = $(`#tabs button[data-tab="${t}"]`); b.classList.toggle('on', view.tab === t); b.setAttribute('aria-selected', view.tab === t); });
    if (!data) return;
    if (!isV3()) { $('#slList').innerHTML = '<li class="empty">This data file has no v3 company list yet. Pull to refresh after the next daily update.</li>'; renderAbout(); return; }
    if (view.tab === 'leads') renderLeads();
    if (view.tab === 'map') renderMap();
    if (view.tab === 'signals') renderSignals();
    if (view.tab === 'about') renderAbout();
  }
  async function pullFile() {
    try {
      const r = await fetch(FILE + '?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (!d || d.schema !== 'pencil-sales-leads/1') throw new Error('bad schema');
      data = d; usedOffline = false; saveSnapshot(d);
    } catch (e) {
      const snap = await loadSnapshot();
      if (snap && !data) { data = snap; usedOffline = true; } else if (data) usedOffline = true;
    }
    render(); if (view.open) openLead(view.open, false);
  }

  /* ---------- CSV ---------- */
  const CSV_NAME = 'gilman-sales-leads-v3.csv';
  function csvText() {
    const q = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const head = ['rank', 'company', 'type', 'city', 'state', 'size', 'fit_score', 'verification', 'best_product', 'why_1', 'why_2', 'proof_url', 'website'];
    const rows = filtered().map((c, i) => [i + 1, c.name, TYPE_LAB[c.type], c.city, c.state, c.size.label, c.score, c.verification.badge, c.best && c.best.product, c.why[0], c.why[1], c.best && c.best.proof && c.best.proof.url, c.website]);
    return { csv: [head, ...rows].map(r => r.map(q).join(',')).join('\n') + '\n', n: rows.length };
  }
  async function exportCsv() {
    const { csv, n } = csvText();
    const blob = new Blob([csv], { type: 'text/csv' });
    let file = null; try { file = new File([csv], CSV_NAME, { type: 'text/csv' }); } catch (e) { /* old Safari */ }
    if (file && navigator.canShare && navigator.share && navigator.canShare({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ files: [file], title: CSV_NAME }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    if ('download' in a) { a.href = URL.createObjectURL(blob); a.download = CSV_NAME; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); toast(`Exported ${n} leads`); }
  }
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, 2200); }

  /* ---------- history ---------- */
  function hashFor() { return '#' + view.tab + (view.open ? '/' + view.open : ''); }
  function pushHist(replace) { const h = hashFor(); if (location.hash === h) return; try { history[replace ? 'replaceState' : 'pushState']({ tab: view.tab, open: view.open }, '', h); } catch (e) { /* file:// */ } }
  function setTab(t, push = true) { if (!TABS.includes(t)) t = 'leads'; view.tab = t; view.open = ''; openLead('', false); render(); if (push) pushHist(); window.scrollTo(0, 0); }
  function fromHash() { const [t, id] = location.hash.replace('#', '').split('/'); view.tab = TABS.includes(t) ? t : 'leads'; view.open = id || ''; }

  function bind() {
    $('#slRefresh').addEventListener('click', () => pullFile().then(() => toast('Up to date')));
    $('#tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) setTab(b.dataset.tab); });
    $('#slTypeSeg').addEventListener('click', e => { const b = e.target.closest('button[data-type]'); if (!b) return; view.type = b.dataset.type; view.max = PAGE; render(); });
    $('#slSigSeg').addEventListener('click', e => { const b = e.target.closest('button[data-sig]'); if (!b) return; view.sig = b.dataset.sig; render(); });
    $('#slFBtn').addEventListener('click', () => { view.filters = !view.filters; render(); });
    let qt; $('#slQ').addEventListener('input', e => { clearTimeout(qt); qt = setTimeout(() => { view.q = e.target.value; view.max = PAGE; render(); }, 120); });
    const sel = (id, key, num) => $('#' + id).addEventListener('change', e => { const v = e.target.value; view[key] = num ? (v === 'all' ? 0 : +v) : v; view.max = PAGE; render(); });
    sel('slFProduct', 'product'); sel('slFState', 'state'); sel('slFRegion', 'region'); sel('slFMin', 'min', true);
    $('#slFVer').addEventListener('click', () => { view.ver = !view.ver; view.max = PAGE; render(); });
    $('#slFReset').addEventListener('click', () => { Object.assign(view, { product: 'all', state: 'all', region: 'all', min: 0, ver: false, q: '', type: 'all', max: PAGE }); render(); });
    $('#slExport').addEventListener('click', () => exportCsv());
    const opener = e => { const m = e.target.closest('[data-more]'); if (m) { view.max += PAGE; render(); return; }
      if (e.target.closest('a')) return; const o = e.target.closest('[data-open]'); if (o) openLead(o.dataset.open); };
    $('#slList').addEventListener('click', opener); $('#slSigList').addEventListener('click', opener);
    $('#slList').addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-open]')) { e.preventDefault(); openLead(e.target.dataset.open); } });
    $('#slSheet').addEventListener('click', e => { if (e.target.closest('[data-close]')) { history.length > 1 && history.state && history.state.open ? history.back() : openLead(''); return; } opener(e); });
    $('#sheetBack').addEventListener('click', () => openLead(''));
    $('#slMap').addEventListener('click', e => { const b = e.target.closest('[data-st]'); if (!b) return; view.state = b.dataset.st; view.min = view.min || 50; view.type = 'all'; view.filters = true; setTab('leads'); });
    $('#slTheme').addEventListener('click', e => { const b = e.target.closest('button[data-theme]'); if (!b) return; try { if (b.dataset.theme === 'auto') localStorage.removeItem('slaTheme'); else localStorage.setItem('slaTheme', b.dataset.theme); } catch (err) { /* private mode */ } applyTheme(); render(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && view.open) openLead(''); });
    window.addEventListener('popstate', () => { fromHash(); render(); openLead(view.open, false); });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (themePref() === 'auto') applyTheme(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && data && isStale()) pullFile(); });
  }
  function boot() {
    staleDemo = /[?&]stale=1/.test(location.search);
    fromHash(); bind(); render(); pushHist(true);
    loadSnapshot().then(s => { if (s && !data) { data = s; render(); if (view.open) openLead(view.open, false); } });
    pullFile();
    poll = setInterval(() => { if (!document.hidden) pullFile(); }, POLL_MS);
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
    window.SalesLeads = { version: VER, data: () => data, view: () => ({ ...view }), setView: v => { Object.assign(view, v); render(); }, setTab, openLead, filtered, csvText, byId };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
