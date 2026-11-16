const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const api = async (url, opts = {}) => {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

const STATUSES = [
  ['none', '— Track…'], ['saved', '★ Saved'], ['applied', 'Applied'], ['interview', 'Interviewing'],
  ['offer', 'Offer 🎉'], ['rejected', 'Rejected'], ['withdrawn', 'Withdrawn'], ['hidden', 'Not interested'],
];
const CAT_LABEL = { content: 'Content', marketing: 'Marketing', ux: 'UX/UI' };
const MODE_LABEL = { remote: '🏠 Remote', hybrid: '🔀 Hybrid', onsite: '🏢 In-person', unknown: '❔ Type not stated' };

let jobs = [];
let meta = {};
let searchHits = null; // Map id -> score when a search is active
let focus = null; // { ids:Set, label } for dream-company results

// ---------- filter state (remembered per browser) ----------
const DEFAULTS = { sort: 'best', modes: ['remote', 'hybrid', 'onsite', 'unknown'], region: 'ontario', remoteCanada: true, city: '', cats: ['content', 'marketing', 'ux'], terms: ['Winter 2027', 'Summer 2027', '8mo', 'other'], hasSalary: false, minPay: 0, hideBlocked: true, company: '', dreamOnly: false };
let F = { ...DEFAULTS };
try { F = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('ih-filters') || '{}') }; } catch {}
const saveF = () => { try { localStorage.setItem('ih-filters', JSON.stringify(F)); } catch {} };

function syncFilterUI() {
  $('#sortSel').value = F.sort === 'relevance' && !searchHits ? 'best' : F.sort;
  $$('input[name=mode]').forEach((i) => (i.checked = F.modes.includes(i.value)));
  $$('input[name=cat]').forEach((i) => (i.checked = F.cats.includes(i.value)));
  $$('input[name=term]').forEach((i) => (i.checked = F.terms.includes(i.value)));
  $$('#regionSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === F.region));
  $('#remoteCanada').checked = F.remoteCanada;
  $('#hasSalary').checked = F.hasSalary;
  $('#minPay').value = F.minPay;
  $('#minPayVal').textContent = `$${F.minPay}`;
  $('#hideBlocked').checked = F.hideBlocked;
  $('#dreamOnly').checked = F.dreamOnly;
  $('#citySel').value = F.city;
  $('#companySel').value = F.company;
}

// ---------- predicates ----------
const termTags = (j) => {
  const t = new Set((j.term?.terms || []).filter((x) => x === 'Winter 2027' || x === 'Summer 2027'));
  if (j.term?.eightMonth) t.add('8mo');
  if (!t.size) t.add('other');
  return t;
};
const userAdded = (j) => ['manual', 'linkedin', 'indeed'].includes(j.source);

function passes(j) {
  if (j.app?.status === 'hidden') return false;
  if (focus) return focus.ids.has(j.id);
  if (F.hideBlocked && j.eligibility?.status === 'blocked') return false;
  if (!F.modes.includes(j.workMode || 'unknown')) return false;
  const L = j.location || {};
  const unknownLoc = !L.isCanada && (L.country === 'UNKNOWN' || L.country === 'REMOTE?');
  if (F.region === 'ontario') {
    const ok = L.isOntario || (F.remoteCanada && j.workMode === 'remote' && L.isCanada) || (userAdded(j) && unknownLoc);
    if (!ok) return false;
  } else if (F.region === 'canada') {
    if (!L.isCanada && !unknownLoc) return false;
  }
  if (F.city && !(L.cities || []).includes(F.city)) return false;
  const cats = j.categories?.length ? j.categories : ['other'];
  if (!cats.some((c) => F.cats.includes(c))) return false;
  if (![...termTags(j)].some((t) => F.terms.includes(t))) return false;
  if ((F.hasSalary || F.minPay > 0) && !j.salary) return false;
  if (F.minPay > 0 && j.salary.hourlyMax < F.minPay) return false;
  if (F.company && j.company !== F.company) return false;
  if (F.dreamOnly && !j.dream) return false;
  if (searchHits && !searchHits.has(j.id)) return false;
  return true;
}

const SORTS = {
  relevance: (a, b) => (searchHits.get(b.id) || 0) - (searchHits.get(a.id) || 0),
  best: (a, b) => b.rank - a.rank,
  salaryAsc: (a, b) => (a.salary ? a.salary.hourlyMin : Infinity) - (b.salary ? b.salary.hourlyMin : Infinity) || b.rank - a.rank,
  salaryDesc: (a, b) => (b.salary ? b.salary.hourlyMax : -1) - (a.salary ? a.salary.hourlyMax : -1) || b.rank - a.rank,
  newest: (a, b) => String(b.postedAt || b.firstSeen).localeCompare(String(a.postedAt || a.firstSeen)),
  deadline: (a, b) => String(a.app?.deadline || a.deadline || '9999').localeCompare(String(b.app?.deadline || b.deadline || '9999')),
};

// ---------- rendering ----------
const fmtDate = (d) => {
  if (!d) return '';
  const x = new Date(d);
  return isNaN(x) ? String(d) : x.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: x.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
};
const daysLeft = (d) => {
  if (!d) return null;
  const n = Math.ceil((new Date(d) - new Date()) / 864e5);
  return Number.isFinite(n) ? n : null;
};
const statusSelect = (j, cls = '') => `<select class="status ${cls} status-${esc(j.app?.status || 'none')}" data-id="${esc(j.id)}" aria-label="Application status">${STATUSES.map(([v, l]) => `<option value="${v}" ${v === (j.app?.status || 'none') ? 'selected' : ''}>${l}</option>`).join('')}</select>`;

function eligTag(j) {
  const e = j.eligibility || {};
  const tip = esc((e.reasons || []).join('\n'));
  if (e.status === 'blocked') return `<span class="tag blocked" title="${tip}">⛔ Not eligible</span>`;
  if (e.status === 'warn') return `<span class="tag warn" title="${tip}">⚠ Check eligibility</span>`;
  return `<span class="tag ok" title="${tip || 'No citizenship/PR requirement found'}">✓ Permit-friendly</span>`;
}

function card(j) {
  const L = j.location || {};
  const deadline = j.app?.deadline || j.deadline;
  const dl = daysLeft(deadline);
  const hit = searchHits?.get(j.id);
  const terms = [...(j.term?.terms || [])].filter((t) => /202[6-8]/.test(t));
  return `<article class="card ${j.active === false ? 'inactive' : ''}" data-id="${esc(j.id)}">
    <div>
      <h3 class="open" data-id="${esc(j.id)}">${esc(j.title)}</h3>
      <div class="co">${esc(j.company)}${j.active === false ? ' · <em>posting closed</em>' : ''}</div>
    </div>
    <div class="score" title="${hit != null ? 'Search relevance' : 'How well this job matches your resume (embedding similarity)'}">
      <b>${hit != null ? hit : j.match ?? '–'}<small style="font-size:12px">%</small></b><span>${hit != null ? 'relevance' : 'resume match'}</span>
      <div class="bar"><i style="width:${Math.min(100, hit ?? j.match ?? 0)}%"></i></div>
    </div>
    <div class="meta">
      <span>📍 ${esc(L.display)}</span>
      <span>${MODE_LABEL[j.workMode] || MODE_LABEL.unknown}</span>
      ${j.salary ? `<span class="salary" title="${esc(j.salary.raw || '')}  (~$${j.salary.hourlyMin}–${j.salary.hourlyMax}/hr CAD)">💰 ${esc(j.salary.text)}</span>` : '<span class="muted">💰 Pay not listed</span>'}
      ${terms.length || j.term?.durationMonths ? `<span>🗓 ${esc(terms.join(', '))}${j.term?.durationMonths ? ` · ${j.term.durationMonths}-month` : ''}</span>` : ''}
      ${deadline ? `<span class="${dl != null && dl <= 7 ? 'status-interview' : ''}">⏳ Apply by ${esc(fmtDate(deadline))}${dl != null && dl >= 0 ? ` (${dl}d)` : ''}</span>` : ''}
      ${j.postedAt ? `<span class="muted">Posted ${esc(fmtDate(j.postedAt))}</span>` : ''}
    </div>
    <div class="tags">
      ${(j.categories || []).map((c) => `<span class="tag ${c}">${CAT_LABEL[c]}</span>`).join('')}
      ${eligTag(j)}
      ${L.isOntario ? '<span class="tag">Ontario</span>' : ''}
      ${j.dream ? '<span class="tag dream">✦ Dream</span>' : ''}
      <span class="tag" title="Source">${esc(j.source)}</span>
    </div>
    ${j.snippet ? `<p class="snippet">${esc(j.snippet)}</p>` : ''}
    <div class="actions">
      <a class="btn small primary" href="${esc(j.applyUrl || j.url)}" target="_blank" rel="noopener">Apply ↗</a>
      <button class="btn small open" data-id="${esc(j.id)}">Details</button>
      <button class="btn small similar" data-id="${esc(j.id)}">Similar jobs</button>
      <span class="spacer"></span>
      ${statusSelect(j)}
    </div>
  </article>`;
}

function render() {
  const visible = jobs.filter(passes).sort(SORTS[F.sort] || SORTS.best);
  const list = $('#list');
  if (focus) {
    list.innerHTML = `<div class="panel" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><strong>✦ ${esc(focus.label)}</strong><span class="muted">Filters are paused for dream-company results. Ineligible roles are shown with a ⛔ badge.</span><button class="link" id="clearFocus">Back to all jobs</button></div>`;
  } else list.innerHTML = '';
  list.insertAdjacentHTML('beforeend', visible.length ? visible.slice(0, 400).map(card).join('') : `<div class="empty-state"><p><strong>No jobs match these filters.</strong></p><p>Try "Canada" or "All" locations, tick "Other student roles", or click <b>Refresh all</b> to crawl again.</p></div>`);
  $('#resultCount').textContent = `${visible.length} job${visible.length === 1 ? '' : 's'}`;
  renderStats();
}

function renderStats() {
  const count = (s) => jobs.filter((j) => j.app?.status === s).length;
  const tracked = jobs.filter((j) => j.app?.status && !['none', 'hidden'].includes(j.app.status));
  const core = jobs.filter((j) => j.categories?.length && j.location?.isOntario && j.eligibility?.status !== 'blocked').length;
  $('#stats').innerHTML = [
    [jobs.length, 'jobs crawled'], [core, 'core in Ontario'], [count('saved'), 'saved'], [count('applied'), 'applied'], [count('interview'), 'interviews'],
  ].map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join('');
  $('#trackCount').textContent = tracked.length || '';
  const last = meta.lastCrawl ? `Last crawl ${new Date(meta.lastCrawl).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}` : 'Never crawled';
  $('#refreshBtn').title = last;
  const b = $('#ragBadge');
  b.textContent = meta.hasOpenAI ? '● Semantic RAG on' : meta.openaiError ? '⚠ Keyword search (OpenAI unavailable)' : meta.hasKey ? '○ Keyword search (embeddings pending)' : '○ Keyword search (add OpenAI key)';
  b.title = meta.openaiError || (meta.hasOpenAI ? 'OpenAI embeddings + BM25 hybrid search' : '');
  b.classList.toggle('on', !!meta.hasOpenAI);
}

function fillSelects() {
  const cities = [...new Set(jobs.flatMap((j) => (j.location?.isOntario ? j.location.cities : []) || []))].sort();
  const otherCities = [...new Set(jobs.flatMap((j) => (!j.location?.isOntario ? j.location?.cities : []) || []))].sort();
  $('#citySel').innerHTML = `<option value="">Any city</option><optgroup label="Ontario">${cities.map((c) => `<option>${esc(c)}</option>`).join('')}</optgroup><optgroup label="Elsewhere in Canada">${otherCities.map((c) => `<option>${esc(c)}</option>`).join('')}</optgroup>`;
  const cos = [...new Set(jobs.map((j) => j.company).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $('#companySel').innerHTML = `<option value="">All companies</option>${cos.map((c) => `<option>${esc(c)}</option>`).join('')}`;
  syncFilterUI();
}

// ---------- tracker ----------
function renderTracker() {
  const tracked = jobs.filter((j) => j.app?.status && !['none', 'hidden'].includes(j.app.status))
    .sort((a, b) => String(b.app.updatedAt || '').localeCompare(String(a.app.updatedAt || '')));
  const stages = ['saved', 'applied', 'interview', 'offer', 'rejected'];
  $('#pipeline').innerHTML = stages.map((s) => `<div class="stat"><b class="status-${s}">${tracked.filter((j) => j.app.status === s).length}</b><span>${STATUSES.find((x) => x[0] === s)[1].replace('★ ', '')}</span></div>`).join('');
  $('#trackEmpty').hidden = tracked.length > 0;
  $('#trackBody').innerHTML = tracked.map((j) => `<tr>
    <td><a href="${esc(j.applyUrl || j.url)}" target="_blank" rel="noopener">${esc(j.title)}</a><div class="muted" style="font-size:12px">${esc(j.location?.display || '')}${j.active === false ? ' · closed' : ''}</div></td>
    <td>${esc(j.company)}</td>
    <td>${statusSelect(j)}</td>
    <td>${esc(j.app.appliedAt || '')}</td>
    <td><input type="date" class="deadline" data-id="${esc(j.id)}" value="${esc((j.app.deadline || j.deadline || '').slice(0, 10))}" /></td>
    <td><textarea class="notes" data-id="${esc(j.id)}" placeholder="Contacts, interview dates…">${esc(j.app.notes || '')}</textarea></td>
    <td><button class="link open" data-id="${esc(j.id)}">View</button></td>
  </tr>`).join('');
}

// ---------- data ----------
async function load() {
  const data = await api('/api/jobs');
  jobs = data.jobs;
  meta = data.meta;
  fillSelects();
  render();
  renderTracker();
}

async function updateApp(id, patch) {
  const updated = await api(`/api/jobs/${encodeURIComponent(id)}/app`, { method: 'PATCH', body: patch });
  const i = jobs.findIndex((j) => j.id === id);
  if (i >= 0) jobs[i] = updated;
  renderStats();
  renderTracker();
  return updated;
}

// ---------- detail ----------
async function openDetail(id, showSimilar = false) {
  const dlg = $('#detail');
  const body = $('#detailBody');
  body.innerHTML = '<p class="muted">Loading…</p>';
  if (!dlg.open) dlg.showModal();
  const j = await api(`/api/jobs/${encodeURIComponent(id)}`);
  const e = j.eligibility || {};
  body.innerHTML = `
    <div><button class="btn small close-x" id="closeDetail">✕</button>
    <h2>${esc(j.title)}</h2><div class="co">${esc(j.company)} · ${esc(j.location?.display)}</div></div>
    <div class="tags">${(j.categories || []).map((c) => `<span class="tag ${c}">${CAT_LABEL[c]}</span>`).join('')}${eligTag(j)}<span class="tag">${MODE_LABEL[j.workMode]}</span>${j.salary ? `<span class="tag">💰 ${esc(j.salary.text)}</span>` : ''}<span class="tag">Match ${j.match ?? '–'}%</span></div>
    ${(e.reasons || []).length ? `<div class="panel" style="padding:10px 14px"><strong>Work-permit check</strong><ul class="reasons">${e.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>` : ''}
    ${j.location?.isCanada && !userAddedCheck(j) ? `<p class="muted" style="margin:0">💡 Found this outside WaterlooWorks? Submit it to Co-operative and Experiential Education as an <b>arranged (self-sourced) co-op job</b> so it counts as a work term under your co-op permit.</p>` : ''}
    <div class="row">
      <label style="flex:1 1 160px">Status ${statusSelect(j, 'detail-status')}</label>
      <label style="flex:1 1 160px">Deadline <input type="date" class="deadline" data-id="${esc(j.id)}" value="${esc((j.app?.deadline || j.deadline || '').slice(0, 10))}" /></label>
    </div>
    <label>Notes <textarea class="notes" data-id="${esc(j.id)}" rows="2" placeholder="Referral contact, cover letter angle…">${esc(j.app?.notes || '')}</textarea></label>
    <div class="actions" style="margin:0"><a class="btn primary" href="${esc(j.applyUrl || j.url)}" target="_blank" rel="noopener">Apply ↗</a><a class="btn" href="${esc(j.url)}" target="_blank" rel="noopener">View posting</a><button class="btn" id="simBtn">Find similar jobs</button><span class="spacer"></span><button class="link" id="delJob" style="color:var(--bad)">Remove</button></div>
    <div id="simBox"></div>
    <div class="detail-desc">${esc(j.description || 'No description captured.')}</div>`;
  $('#closeDetail').onclick = () => dlg.close();
  $('#simBtn').onclick = () => loadSimilar(j.id);
  $('#delJob').onclick = async () => {
    if (!confirm('Remove this posting from your hub?')) return;
    await api(`/api/jobs/${encodeURIComponent(j.id)}`, { method: 'DELETE' });
    dlg.close();
    load();
  };
  if (showSimilar) loadSimilar(j.id);
}
const userAddedCheck = (j) => j.source === 'manual' && /waterlooworks/i.test(j.url || '');

async function loadSimilar(id) {
  const box = $('#simBox');
  box.innerHTML = '<p class="muted">Finding similar postings…</p>';
  const { mode, results } = await api(`/api/similar/${encodeURIComponent(id)}`);
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const items = results.map((r) => ({ ...r, j: byId.get(r.id) })).filter((r) => r.j && r.j.app?.status !== 'hidden');
  box.innerHTML = `<strong>Similar jobs</strong> <span class="muted">(${mode === 'semantic' ? 'embedding similarity' : 'keyword similarity'})</span>
    <div class="sim-list">${items.map((r) => `<div class="sim-item open" data-id="${esc(r.id)}"><span><b>${esc(r.j.title)}</b> · ${esc(r.j.company)} <span class="muted">· ${esc(r.j.location?.display || '')}</span></span><span class="muted">${r.score}%</span></div>`).join('') || '<p class="muted">Nothing similar yet.</p>'}</div>`;
}

// ---------- background tasks (crawl / dream company) ----------
let pollTimer = null;
async function pollTask(onDone) {
  clearTimeout(pollTimer);
  const t = await api('/api/task');
  $('#taskBox').hidden = false;
  $('#taskLabel').textContent = t.running ? t.label + '…' : t.error ? `Failed: ${t.error}` : t.result?.message || `${t.label}: done`;
  $('#taskSpin').classList.toggle('done', !t.running);
  const pre = $('#taskLog');
  pre.textContent = t.log.join('\n');
  pre.scrollTop = pre.scrollHeight;
  $('#refreshBtn').disabled = t.running;
  $('#dreamForm button[type=submit]').disabled = t.running;
  if (t.running) pollTimer = setTimeout(() => pollTask(onDone), 1000);
  else onDone?.(t);
}

$('#refreshBtn').onclick = async () => {
  try {
    await api('/api/crawl', { method: 'POST' });
    pollTask(() => load());
  } catch (e) {
    alert(e.message);
  }
};

$('#dreamForm').onsubmit = async (ev) => {
  ev.preventDefault();
  const company = $('#dreamInput').value.trim();
  if (!company) return;
  try {
    await api('/api/dream', { method: 'POST', body: { company, includeAll: $('#dreamAll').checked } });
    pollTask(async (t) => {
      await load();
      if (t.result?.ids?.length) {
        focus = { ids: new Set(t.result.ids), label: `${t.result.ids.length} role(s) at ${t.result.company}` };
        switchTab('browse');
        render();
      }
    });
  } catch (e) {
    alert(e.message);
  }
};
$('#taskClose').onclick = () => ($('#taskBox').hidden = true);

// ---------- search ----------
$('#searchForm').onsubmit = async (ev) => {
  ev.preventDefault();
  const q = $('#searchInput').value.trim();
  if (!q) return clearSearch();
  $('#searchMode').textContent = 'Searching…';
  try {
    const { mode, results } = await api(`/api/search?q=${encodeURIComponent(q)}`);
    searchHits = new Map(results.map((r) => [r.id, r.score]));
    $('#searchMode').textContent = mode === 'hybrid' ? '· ranked by semantic + keyword similarity' : '· keyword match (add an OpenAI key for semantic search)';
    $('#clearSearch').hidden = false;
    if (!$('#sortSel').querySelector('[value=relevance]')) $('#sortSel').insertAdjacentHTML('afterbegin', '<option value="relevance">Search relevance</option>');
    F.sort = 'relevance';
    $('#sortSel').value = 'relevance';
    render();
  } catch (e) {
    $('#searchMode').textContent = `Search failed: ${e.message}`;
  }
};
function clearSearch() {
  searchHits = null;
  $('#searchInput').value = '';
  $('#searchMode').textContent = '';
  $('#clearSearch').hidden = true;
  $('#sortSel').querySelector('[value=relevance]')?.remove();
  if (F.sort === 'relevance') F.sort = 'best';
  syncFilterUI();
  render();
}
$('#clearSearch').onclick = clearSearch;

// ---------- filter events ----------
const groupVals = (name) => $$(`input[name=${name}]`).filter((i) => i.checked).map((i) => i.value);
$('#filters').addEventListener('change', (e) => {
  const t = e.target;
  if (t.name === 'mode') F.modes = groupVals('mode');
  else if (t.name === 'cat') F.cats = groupVals('cat');
  else if (t.name === 'term') F.terms = groupVals('term');
  else if (t.id === 'sortSel') F.sort = t.value;
  else if (t.id === 'remoteCanada') F.remoteCanada = t.checked;
  else if (t.id === 'citySel') F.city = t.value;
  else if (t.id === 'hasSalary') F.hasSalary = t.checked;
  else if (t.id === 'hideBlocked') F.hideBlocked = t.checked;
  else if (t.id === 'companySel') F.company = t.value;
  else if (t.id === 'dreamOnly') F.dreamOnly = t.checked;
  if (F.sort !== 'relevance') saveF();
  render();
});
$('#minPay').oninput = (e) => {
  F.minPay = Number(e.target.value);
  $('#minPayVal').textContent = `$${F.minPay}`;
  saveF();
  render();
};
$('#regionSeg').onclick = (e) => {
  const v = e.target.dataset?.v;
  if (!v) return;
  F.region = v;
  saveF();
  syncFilterUI();
  render();
};
$('#resetFilters').onclick = () => {
  F = { ...DEFAULTS };
  saveF();
  syncFilterUI();
  render();
};

// ---------- delegated actions ----------
document.addEventListener('click', (e) => {
  const open = e.target.closest('.open');
  if (open?.dataset.id) return openDetail(open.dataset.id);
  const sim = e.target.closest('.similar');
  if (sim) return openDetail(sim.dataset.id, true);
  if (e.target.id === 'clearFocus') {
    focus = null;
    render();
  }
});
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.classList.contains('status')) {
    await updateApp(t.dataset.id, { status: t.value });
    t.className = `status status-${t.value}`;
    if (t.value === 'hidden') render();
  } else if (t.classList.contains('deadline')) {
    updateApp(t.dataset.id, { deadline: t.value });
  }
});
let noteTimer;
document.addEventListener('input', (e) => {
  if (!e.target.classList.contains('notes')) return;
  clearTimeout(noteTimer);
  const { id } = e.target.dataset;
  const v = e.target.value;
  noteTimer = setTimeout(() => updateApp(id, { notes: v }), 600);
});

// ---------- tabs ----------
function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  ['browse', 'tracker', 'add'].forEach((id) => ($('#' + id).hidden = id !== name));
  if (name === 'tracker') renderTracker();
}
$$('.tab').forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));

// ---------- add posting ----------
$('#addForm').onsubmit = async (ev) => {
  ev.preventDefault();
  const fd = Object.fromEntries(new FormData(ev.target));
  const msg = $('#addMsg');
  msg.textContent = 'Adding…';
  try {
    const j = await api('/api/import', { method: 'POST', body: fd });
    msg.textContent = `Added "${j.title}" (${j.company || 'unknown company'}).`;
    ev.target.reset();
    await load();
  } catch (e) {
    msg.textContent = `⚠ ${e.message}`;
  }
};

// ---------- profile ----------
$('#profileBtn').onclick = async () => {
  const p = await api('/api/profile');
  $('#profileText').value = p.text;
  $('#profileDlg').showModal();
};
$('#profileSave').onclick = async (e) => {
  e.preventDefault();
  $('#profileSave').disabled = true;
  try {
    await api('/api/profile', { method: 'PUT', body: { text: $('#profileText').value } });
    $('#profileDlg').close();
    await load();
  } catch (err) {
    alert(err.message);
  } finally {
    $('#profileSave').disabled = false;
  }
};

// resume a running task (e.g. after page reload)
api('/api/task').then((t) => t.running && pollTask(() => load()));
load();
