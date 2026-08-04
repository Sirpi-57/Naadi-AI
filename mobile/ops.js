/* ════════════════════════════════════════════════════════════════
   NAADI AI — OPS CONSOLE (ops.js)
   ─────────────────────────────────────────────────────────────────
   Loads only shared.js + this file. The client never claims a role —
   it presents a token and /api/admin/whoami decides. Every screen is
   fetch → render, cached until Refresh, charts destroyed on switch.
   ════════════════════════════════════════════════════════════════ */

const AD = {
  me: null,
  screen: 'overview',
  cache: {},          // screen → payload
  charts: {},         // canvas id → Chart
  students: { q: '', school: '', filter: '', sort: 'mastery', offset: 0, limit: 60, rows: [], total: 0 },
  schoolOpen: null,   // school_id when drilled in
  drawerUid: null,
  ticket: null,       // open ticket id
  ticketStatus: 'open',
  ticketRole: '',     // '' | 'student' | 'teacher' — filtered client-side
  reportStatus: 'open',
  reports: [],
  joinRole: '',
  pollChat: null,
  pollInbox: null,
};

const $ = id => document.getElementById(id);
const esc = s => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? ''));

function fmtDur(secs) {
  secs = Math.round(secs || 0);
  if (!secs) return '—';
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60), s = secs % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function relTime(iso) {
  if (!iso) return '—';
  const then = new Date(iso);
  if (isNaN(then)) return '—';
  const mins = Math.floor((Date.now() - then.getTime()) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d}d ago`;
  return then.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function idleText(days) {
  return days == null ? 'Never' : days === 0 ? 'Today' : `${days}d ago`;
}

function toast(msg) {
  const t = $('adm-toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.add('hidden'), 2600);
}

function skeleton(n) {
  return `<div class="pt-skel" style="padding:0">${'<div></div>'.repeat(n || 3)}</div>`;
}

function emptyState(icon, title, body) {
  return `<div class="pt-empty">
        <i class="fa-solid ${icon}"></i>
        <h3>${esc(title)}</h3><p>${esc(body)}</p>
    </div>`;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function destroyCharts() {
  Object.values(AD.charts).forEach(c => { try { c.destroy(); } catch (e) { } });
  AD.charts = {};
}

function chart(id, cfg) {
  const el = $(id);
  if (!el || typeof Chart === 'undefined') return;
  AD.charts[id] = new Chart(el, cfg);
}

function baseOpts(extraScales) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: Object.assign({
      x: { grid: { display: false }, ticks: { maxTicksLimit: 8, font: { size: 10 } } },
      y: { beginAtZero: true, ticks: { precision: 0, font: { size: 10 } } },
    }, extraScales || {}),
  };
}

function lineChart(id, series, color, fill) {
  chart(id, {
    type: 'line',
    data: {
      labels: series.map(p => p.date.slice(5)),
      datasets: [{
        data: series.map(p => p.count),
        borderColor: color, backgroundColor: fill,
        fill: true, tension: .3, pointRadius: 0, borderWidth: 2,
      }]
    },
    options: baseOpts(),
  });
}

function miniBar(pct) {
  const p = Math.round(pct || 0);
  const cls = p < 35 ? 'bad' : p < 55 ? 'warn' : '';
  return `<div class="adm-mini"><i><b class="${cls}" style="width:${Math.max(2, p)}%"></b></i><span>${p}%</span></div>`;
}


/* ════════════════════════════════════════════════════════════════
   BOOT + NAV
   ════════════════════════════════════════════════════════════════ */

const NAV = [
  { id: 'overview', icon: 'fa-gauge-high', label: 'Overview' },
  { id: 'aicost', icon: 'fa-wand-magic-sparkles', label: 'Nia' },
  { id: 'schools', icon: 'fa-school', label: 'Schools' },
  { id: 'students', icon: 'fa-user-graduate', label: 'Students' },
  { id: 'teachers', icon: 'fa-chalkboard-user', label: 'Teachers' },
  { id: 'parents', icon: 'fa-user-shield', label: 'Parents' },
  { id: 'tests', icon: 'fa-notes-medical', label: 'Tests' },
  { id: 'joining', icon: 'fa-door-open', label: 'Joining' },
  { id: 'payments', icon: 'fa-indian-rupee-sign', label: 'Payments' },
  { id: 'support', icon: 'fa-headset', label: 'Support' },
  { id: 'safety', icon: 'fa-shield-halved', label: 'Safety' },
];

const TITLES = {
  overview: ['Overview', 'The whole platform, right now'],
  aicost: ['Nia', 'Assistant usage and cost'],
  schools: ['Schools', 'Every school, class, and section on NAADI'],
  students: ['Students', 'The global roster — search anyone, open anyone'],
  teachers: ['Teachers', 'Accounts, classes, and approval queues'],
  parents: ['Parents', 'Linked guardian accounts'],
  tests: ['Tests', 'Volume, pace, hardest chapters, most-failed questions'],
  joining: ['Joining', 'Signups and the class-join pipeline'],
  payments: ['Payments', 'Plan mix today; the ledger fills in when payments go live'],
  support: ['Support', 'Student queries — reply like a human, close like a pro'],
};

auth.onAuthStateChanged(async (user) => {
  if (!user) { location.replace('ops-login.html'); return; }
  if (typeof currentUser !== 'undefined') currentUser = user;
  try {
    AD.me = await apiCall('/api/admin/whoami');
  } catch (e) {
    $('adm-boot').classList.add('hidden');
    $('adm-wall-body').textContent = e.message || 'This console is for NAADI administrators only.';
    $('adm-wall').classList.remove('hidden');
    return;
  }
  $('adm-me').textContent = `${AD.me.name} · ${AD.me.email}`;
  $('adm-nav').innerHTML = NAV.map((t, i) => `
        <button class="adm-nav-item ${i === 0 ? 'active' : ''}" data-s="${t.id}" onclick="goScreen('${t.id}')">
          <i class="fa-solid ${t.icon}"></i><span>${t.label}</span>
          <em class="adm-nav-badge hidden" id="adm-badge-${t.id}"></em>
        </button>`).join('');

  $('adm-boot').classList.add('hidden');
  ['adm-side', 'adm-top', 'adm-main'].forEach(id => $(id).classList.remove('hidden'));

  goScreen('overview');
  AD.pollInbox = setInterval(refreshBadges, 30000);
  refreshBadges();
});

function admLogout() {
  auth.signOut().then(() => location.replace('ops-login.html'));
}

function setBadge(id, n) {
  const el = $(`adm-badge-${id}`);
  if (!el) return;
  el.textContent = n > 99 ? '99+' : n;
  el.classList.toggle('hidden', !n);
}

async function refreshBadges() {
  try {
    const inbox = await apiCall('/api/admin/support?status=open');
    setBadge('support', inbox.unread || inbox.open || 0);
  } catch (e) { /* quiet */ }
}

function admNav(open) {
  // Mobile slide-over nav. On desktop these classes exist but have no
  // styles, so calling this is always safe.
  $('adm-side').classList.toggle('open', !!open);
  $('adm-nav-backdrop').classList.toggle('hidden', !open);
}

function goScreen(s) {
  admNav(false);
  AD.screen = s;
  NAV.forEach(t => $(`adm-screen-${t.id}`).classList.toggle('hidden', t.id !== s));
  document.querySelectorAll('.adm-nav-item[data-s]')
    .forEach(b => b.classList.toggle('active', b.dataset.s === s));
  const [t, sub] = TITLES[s];
  $('adm-top-title').textContent = t;
  $('adm-top-sub').textContent = sub;
  window.scrollTo(0, 0);
  destroyCharts();
  if (s !== 'support') stopChatPoll();
  renderScreen(s);
}

function admRefresh() {
  delete AD.cache[AD.screen];
  if (AD.screen === 'students') delete AD.cache.schools;
  if (AD.screen === 'schools') AD.schoolOpen = null;
  const btn = $('adm-refresh');
  btn.classList.add('spin');
  setTimeout(() => btn.classList.remove('spin'), 800);
  destroyCharts();
  renderScreen(AD.screen);
}

async function fetchScreen(s, url) {
  if (!AD.cache[s]) AD.cache[s] = await apiCall(url);
  return AD.cache[s];
}

function renderScreen(s) {
  if (s === 'overview') return renderOverview();
  if (s === 'aicost') return renderAiCost();   // ops-ai.js
  if (s === 'schools') return renderSchools();
  if (s === 'students') return renderStudents();
  if (s === 'teachers') return renderTeachers();
  if (s === 'parents') return renderParents();
  if (s === 'tests') return renderTests();
  if (s === 'joining') return renderJoining();
  if (s === 'payments') return renderPayments();
  if (s === 'support') return renderSupport();
  if (s === 'safety') return renderSafety();
}


/* ════════════════════════════════════════════════════════════════
   OVERVIEW
   ════════════════════════════════════════════════════════════════ */

async function renderOverview() {
  const el = $('adm-screen-overview');
  el.innerHTML = skeleton(3);
  let d;
  try { d = await fetchScreen('overview', '/api/admin/overview'); }
  catch (e) { el.innerHTML = emptyState('fa-triangle-exclamation', "Couldn't load", e.message || ''); return; }

  const c = d.counts;
  const kpi = (v, k, cls, onclick) => `
        <div class="adm-kpi ${onclick ? 'link' : ''}" ${onclick ? `onclick="${onclick}"` : ''}>
          <div class="adm-kpi-v ${cls || ''}">${v}</div>
          <div class="adm-kpi-k">${k}</div>
        </div>`;

  el.innerHTML = `
      <div class="adm-kpis">
        ${kpi(c.students, 'Students', '', `goScreen('students')`)}
        ${kpi(c.teachers, 'Teachers', '', `goScreen('teachers')`)}
        ${kpi(c.parents, 'Parents', '', `goScreen('parents')`)}
        ${kpi(c.schools, 'Schools', '', `goScreen('schools')`)}
        ${kpi(c.classes, 'Classes', '')}
        ${kpi(c.active_today, 'Active today', 'good')}
        ${kpi(c.active_7d, 'Active this week', '')}
        ${kpi(c.tests_completed.toLocaleString('en-IN'), 'Tests taken', '', `goScreen('tests')`)}
        ${kpi(c.questions_answered.toLocaleString('en-IN'), 'Questions answered', '')}
        ${kpi(c.avg_mastery + '%', 'Avg mastery', '')}
        ${kpi(c.at_risk, 'At risk', c.at_risk ? 'bad' : '', `openStudentsFiltered('at_risk')`)}
        ${kpi(c.pending_joins, 'Pending joins', c.pending_joins ? 'warn' : '', `goScreen('joining')`)}
        ${kpi(c.open_tickets, 'Open tickets', c.open_tickets ? 'warn' : '', `goScreen('support')`)}
        ${kpi(fmtDur(d.avg_test_seconds), 'Avg test time', '')}
      </div>

      <div class="adm-grid2">
        <div class="adm-card">
          <div class="adm-card-title">Signups</div>
          <div class="adm-card-sub">New accounts per day, last 30 days.</div>
          <div class="pt-chart"><canvas id="adm-ch-signups"></canvas></div>
        </div>
        <div class="adm-card">
          <div class="adm-card-title">Tests taken</div>
          <div class="adm-card-sub">Completed tests + mock papers per day.</div>
          <div class="pt-chart"><canvas id="adm-ch-tests"></canvas></div>
        </div>
        <div class="adm-card">
          <div class="adm-card-title">Daily active students</div>
          <div class="adm-card-sub">Students whose last activity fell on each day.</div>
          <div class="pt-chart"><canvas id="adm-ch-active"></canvas></div>
        </div>
        <div class="adm-card">
          <div class="adm-card-title">Score distribution</div>
          <div class="adm-card-sub">Every completed test, in 10% bands. Pass line at ${d.pass_threshold}%.</div>
          <div class="pt-chart"><canvas id="adm-ch-scores"></canvas></div>
        </div>
      </div>`;

  lineChart('adm-ch-signups', d.signups_30d, cssVar('--g500') || '#2f6cb3', 'rgba(47,108,179,.12)');
  lineChart('adm-ch-tests', d.tests_30d, cssVar('--green-600') || '#1f9e4a', 'rgba(31,158,74,.10)');
  lineChart('adm-ch-active', d.active_30d, cssVar('--amber') || '#c07c12', 'rgba(192,124,18,.10)');
  chart('adm-ch-scores', {
    type: 'bar',
    data: {
      labels: d.score_hist.map(b => b.bucket),
      datasets: [{
        data: d.score_hist.map(b => b.count),
        backgroundColor: d.score_hist.map((_, i) =>
          i * 10 < d.pass_threshold ? (cssVar('--red') || '#c43d3d')
            : i < 7 ? (cssVar('--amber') || '#c07c12')
              : (cssVar('--green-600') || '#1f9e4a')),
        borderRadius: 4,
      }]
    },
    options: baseOpts(),
  });
}

function openStudentsFiltered(f) {
  AD.students.filter = f;
  AD.students.offset = 0;
  goScreen('students');
}


/* ════════════════════════════════════════════════════════════════
   SCHOOLS
   ════════════════════════════════════════════════════════════════ */

async function renderSchools() {
  const el = $('adm-screen-schools');
  if (AD.schoolOpen) return renderSchoolDrill(el, AD.schoolOpen);
  el.innerHTML = skeleton(3);
  let d;
  try { d = await fetchScreen('schools', '/api/admin/schools'); }
  catch (e) { el.innerHTML = emptyState('fa-triangle-exclamation', "Couldn't load", e.message || ''); return; }

  if (!d.schools.length) {
    el.innerHTML = emptyState('fa-school', 'No schools yet',
      'Schools appear once students set a school code in their profile.');
    return;
  }

  el.innerHTML = `
      <div class="adm-twrap"><table class="adm-table">
        <thead><tr>
          <th>School</th><th>Students</th><th>Approved</th><th>Teachers</th>
          <th>Classes</th><th>Active 7d</th><th>Avg mastery</th><th>Tests</th><th>At risk</th>
        </tr></thead>
        <tbody>
          ${d.schools.map(s => `
            <tr class="click" onclick="openSchool('${esc(s.school_id)}')">
              <td><div class="adm-t-main">${esc(s.school_name)}</div>
                  <div class="adm-t-sub">${esc(s.school_id)}</div></td>
              <td class="adm-num">${s.students}</td>
              <td class="adm-num">${s.approved}</td>
              <td class="adm-num">${s.teachers}</td>
              <td class="adm-num">${s.classes}</td>
              <td class="adm-num">${s.active_7d}</td>
              <td>${miniBar(s.avg_mastery)}</td>
              <td class="adm-num">${s.tests.toLocaleString('en-IN')}</td>
              <td>${s.at_risk ? `<span class="adm-pill bad">${s.at_risk}</span>` : '<span class="adm-pill">0</span>'}</td>
            </tr>`).join('')}
        </tbody>
      </table></div>`;
}

function openSchool(sid) { AD.schoolOpen = sid; renderSchools(); }
function closeSchool() { AD.schoolOpen = null; renderSchools(); }

async function renderSchoolDrill(el, sid) {
  el.innerHTML = skeleton(3);
  let d;
  try { d = await apiCall(`/api/admin/school/${encodeURIComponent(sid)}`); }
  catch (e) { el.innerHTML = emptyState('fa-triangle-exclamation', "Couldn't load", e.message || ''); return; }

  el.innerHTML = `
      <div class="adm-toolbar">
        <button class="adm-btn ghost" onclick="closeSchool()">
          <i class="fa-solid fa-arrow-left"></i> All schools</button>
        <div class="adm-top-title" style="font-size:.98rem">${esc(d.school_name)}</div>
      </div>

      <div class="adm-card">
        <div class="adm-card-title">Classes</div>
        <div class="adm-card-sub">Sections and the teachers who run them.</div>
        ${d.classes.length ? `<div class="adm-twrap"><table class="adm-table">
          <thead><tr><th>Class</th><th>Students</th><th>Avg mastery</th><th>Teachers</th><th>Peer rank</th></tr></thead>
          <tbody>${d.classes.map(c => `
            <tr>
              <td class="adm-t-main">${esc(c.class_id)}</td>
              <td class="adm-num">${c.students}</td>
              <td>${miniBar(c.avg_mastery)}</td>
              <td>${c.teachers.map(t => `<span class="adm-pill info">${esc(t)}</span>`).join(' ') || '—'}</td>
              <td>${c.peer_visibility ? '<span class="adm-pill good">on</span>' : '<span class="adm-pill">off</span>'}</td>
            </tr>`).join('')}</tbody>
        </table></div>` : emptyState('fa-users-slash', 'No classes created', 'Teachers create sections from their portal.')}
      </div>

      <div class="adm-card" style="margin-top:18px">
        <div class="adm-card-title">Students in this school</div>
        <div class="adm-card-sub">Click any row to open the full drill-down.</div>
        ${studentTable(d.students)}
      </div>`;
}


/* ════════════════════════════════════════════════════════════════
   STUDENTS — global roster
   ════════════════════════════════════════════════════════════════ */

const STUDENT_FILTERS = [
  ['', 'All'], ['at_risk', 'At risk'], ['inactive', 'Inactive 7d'],
  ['never_started', 'Never started'], ['unassigned', 'No class'], ['top', 'Top (70%+)'],
];

function studentTable(rows) {
  if (!rows.length) return emptyState('fa-user-slash', 'Nobody matches', 'Loosen the filters.');
  return `<div class="adm-twrap"><table class="adm-table">
      <thead><tr>
        <th>Student</th><th>School · Class</th><th>Mastery</th><th>Accuracy</th>
        <th>Tests</th><th>Questions</th><th>Streak</th><th>Last active</th><th>Status</th>
      </tr></thead>
      <tbody>${rows.map(s => `
        <tr class="click" onclick="openStudent('${esc(s.uid)}')">
          <td><div class="adm-t-main">${esc(s.name)}</div>
              <div class="adm-t-sub">${esc(s.doctor_rank || s.email)}</div></td>
          <td><div class="adm-t-sub" style="margin:0">${esc(s.school_id || '—')} · ${esc(s.class_id || '—')}</div></td>
          <td>${miniBar(s.mastery)}</td>
          <td class="adm-num">${s.accuracy}%</td>
          <td class="adm-num">${s.tests}</td>
          <td class="adm-num">${s.questions.toLocaleString('en-IN')}</td>
          <td class="adm-num">${s.streak}d</td>
          <td>${idleText(s.last_active_days)}</td>
          <td>${s.class_status === 'approved'
      ? '<span class="adm-pill good">approved</span>'
      : `<span class="adm-pill warn">${esc(s.class_status || 'unassigned')}</span>`}</td>
        </tr>`).join('')}</tbody>
    </table></div>`;
}

async function renderStudents() {
  const el = $('adm-screen-students');
  const st = AD.students;

  el.innerHTML = `
      <div class="adm-toolbar">
        <input class="adm-input" id="adm-st-q" placeholder="Search name or email"
               value="${esc(st.q)}" oninput="onStudentSearch(this.value)">
        <select class="adm-select" id="adm-st-school" onchange="onStudentSchool(this.value)"></select>
        ${STUDENT_FILTERS.map(([id, label]) => `
          <button class="adm-chip ${st.filter === id ? 'on' : ''}"
                  onclick="setStudentFilter('${id}')">${label}</button>`).join('')}
        <select class="adm-select" onchange="setStudentSort(this.value)">
          ${[['mastery', 'Mastery ↓'], ['mastery_asc', 'Mastery ↑'], ['accuracy', 'Accuracy'],
    ['tests', 'Tests'], ['last_active', 'Last active'], ['name', 'Name']]
      .map(([v, l]) => `<option value="${v}" ${st.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <button class="adm-btn ghost" onclick="exportStudentsCsv()">
          <i class="fa-solid fa-file-csv"></i> Export</button>
      </div>
      <div id="adm-st-table">${skeleton(3)}</div>
      <div class="adm-pager" id="adm-st-pager"></div>`;

  // School dropdown fills from the schools endpoint (cached).
  try {
    const sch = await fetchScreen('schools', '/api/admin/schools');
    $('adm-st-school').innerHTML = `<option value="">All schools</option>` +
      sch.schools.map(s => `<option value="${esc(s.school_id)}" ${st.school === s.school_id ? 'selected' : ''}>
                ${esc(s.school_name)}</option>`).join('');
  } catch (e) {
    $('adm-st-school').innerHTML = `<option value="">All schools</option>`;
  }

  await loadStudentRows();
}

async function loadStudentRows() {
  const st = AD.students;
  const wrap = $('adm-st-table');
  if (!wrap) return;
  wrap.innerHTML = skeleton(3);
  const p = new URLSearchParams();
  if (st.q) p.set('q', st.q);
  if (st.school) p.set('school', st.school);
  if (st.filter) p.set('filter', st.filter);
  p.set('sort', st.sort);
  p.set('offset', st.offset);
  p.set('limit', st.limit);
  let d;
  try { d = await apiCall(`/api/admin/students?${p}`); }
  catch (e) { wrap.innerHTML = emptyState('fa-triangle-exclamation', "Couldn't load", e.message || ''); return; }
  st.rows = d.students;
  st.total = d.total;
  wrap.innerHTML = studentTable(d.students);
  const from = d.total ? st.offset + 1 : 0;
  const to = st.offset + d.students.length;
  $('adm-st-pager').innerHTML = `
        <span>${from}–${to} of ${d.total}</span>
        <button class="adm-btn ghost" ${st.offset === 0 ? 'disabled' : ''}
                onclick="pageStudents(-1)"><i class="fa-solid fa-chevron-left"></i></button>
        <button class="adm-btn ghost" ${to >= d.total ? 'disabled' : ''}
                onclick="pageStudents(1)"><i class="fa-solid fa-chevron-right"></i></button>`;
}

let _stTimer = null;
function onStudentSearch(v) {
  AD.students.q = v;
  AD.students.offset = 0;
  clearTimeout(_stTimer);
  _stTimer = setTimeout(loadStudentRows, 300);
}
function onStudentSchool(v) { AD.students.school = v; AD.students.offset = 0; loadStudentRows(); }
function setStudentFilter(f) { AD.students.filter = f; AD.students.offset = 0; renderStudents(); }
function setStudentSort(s) { AD.students.sort = s; AD.students.offset = 0; loadStudentRows(); }
function pageStudents(dir) {
  AD.students.offset = Math.max(0, AD.students.offset + dir * AD.students.limit);
  loadStudentRows();
}

function exportStudentsCsv() {
  const rows = AD.students.rows;
  if (!rows.length) return toast('Nothing to export');
  const head = ['name', 'email', 'school_id', 'class_id', 'class_status',
    'mastery', 'accuracy', 'tests', 'questions', 'streak', 'last_active_days'];
  const csv = [head.join(',')].concat(rows.map(r =>
    head.map(k => `"${String(r[k] ?? '').replace(/"/g, '""')}"`).join(','))).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `naadi-students-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  toast(`Exported ${rows.length} rows (this page)`);
}


/* ════════════════════════════════════════════════════════════════
   STUDENT DRAWER — full drill-down
   ════════════════════════════════════════════════════════════════ */

async function openStudent(uid) {
  if (event) event.stopPropagation();
  AD.drawerUid = uid;
  $('adm-drawer-backdrop').classList.remove('hidden');
  $('adm-drawer').classList.remove('hidden');
  $('adm-drawer-title').textContent = 'Student';
  $('adm-drawer-body').innerHTML = skeleton(3);

  let d, t;
  try {
    [d, t] = await Promise.all([
      apiCall(`/api/admin/student/${uid}`),
      apiCall(`/api/admin/student/${uid}/tests`),
    ]);
  } catch (e) {
    $('adm-drawer-body').innerHTML = emptyState('fa-lock', "Can't open this student", e.message || '');
    return;
  }
  if (AD.drawerUid !== uid) return;   // user moved on mid-flight

  const s = d.student, p = d.profile, r = d.rollup;
  $('adm-drawer-title').textContent = s.name || 'Student';

  $('adm-drawer-body').innerHTML = `
      <div class="adm-card">
        <div class="adm-kpis" style="grid-template-columns:repeat(3,1fr)">
          <div class="adm-kpi"><div class="adm-kpi-v">${s.mastery}%</div><div class="adm-kpi-k">Mastery</div></div>
          <div class="adm-kpi"><div class="adm-kpi-v">${s.accuracy}%</div><div class="adm-kpi-k">Accuracy</div></div>
          <div class="adm-kpi"><div class="adm-kpi-v">${s.tests}</div><div class="adm-kpi-k">Tests</div></div>
          <div class="adm-kpi"><div class="adm-kpi-v">${s.streak}d</div><div class="adm-kpi-k">Streak</div></div>
          <div class="adm-kpi"><div class="adm-kpi-v">${fmtDur(t.total_time_seconds)}</div><div class="adm-kpi-k">Time in tests</div></div>
          <div class="adm-kpi"><div class="adm-kpi-v">${r.chapters_started}</div><div class="adm-kpi-k">Chapters</div></div>
        </div>
      </div>

      <div class="adm-card">
        <div class="adm-card-title">Identity</div>
        <div class="adm-kv"><b>Email</b><span>${esc(p.email || '—')}</span></div>
        <div class="adm-kv"><b>School · Class</b><span>${esc(s.school_id || '—')} · ${esc(s.class_id || '—')}
            <span class="adm-pill ${s.class_status === 'approved' ? 'good' : 'warn'}">${esc(s.class_status)}</span></span></div>
        <div class="adm-kv"><b>Doctor rank</b><span>${esc(s.doctor_rank || '—')} (${r.doctor_overall}%)</span></div>
        <div class="adm-kv"><b>Plan</b><span>${esc(p.plan)}</span></div>
        <div class="adm-kv"><b>Target</b><span>${esc(p.target_exam || '—')}</span></div>
        <div class="adm-kv"><b>Joined</b><span>${relTime(p.created_at)}</span></div>
        <div class="adm-kv"><b>Guardian</b><span>${esc(p.guardian_name || '—')}<br>
            ${esc(p.guardian_phone || '')} ${esc(p.guardian_email || '')}</span></div>
        <div class="adm-kv"><b>Parent accounts</b><span>${d.parents.length
      ? d.parents.map(x => `${esc(x.name)} (${esc(x.email)})`).join('<br>') : 'None linked'}</span></div>
        <div class="adm-kv"><b>Parent consent</b><span>${p.parent_consent === false
      ? '<span class="adm-pill bad">revoked</span>' : '<span class="adm-pill good">on</span>'}</span></div>
      </div>

      ${r.weak_concepts.length ? `<div class="adm-card">
        <div class="adm-card-title">Weakest concepts</div>
        <div class="adm-card-sub">Lowest mastery among attempted concepts.</div>
        ${r.weak_concepts.map(w => `
          <div class="adm-kv"><b style="max-width:65%;font-weight:600;color:var(--s700)">${esc(w.n || w.concept_name || w.concept_id)}</b>
            <span>${Math.round(w.m ?? w.mastery ?? 0)}%${(w.f ?? w.consecutive_failures) ? ` · ${w.f ?? w.consecutive_failures}✗ in a row` : ''}</span></div>`).join('')}
      </div>` : ''}

      ${t.pace_outliers.length ? `<div class="adm-card">
        <div class="adm-card-title">Pace flags</div>
        <div class="adm-card-sub">Rushing (&lt;15s/q) and freezing (&gt;150s/q) both look like wrong answers on a score sheet.</div>
        ${t.pace_outliers.map(o => `
          <div class="adm-kv"><b style="font-weight:600;color:var(--s700)">${esc(o.chapter_name)}</b>
            <span><span class="adm-pill ${o.pattern === 'rushing' ? 'warn' : 'bad'}">${o.pattern}</span>
            ${o.seconds_per_question}s/q · ${o.percentage}%</span></div>`).join('')}
      </div>` : ''}

      <div class="adm-card">
        <div class="adm-card-title">Every test</div>
        <div class="adm-card-sub">Click a row for the question-by-question review.</div>
        ${t.log.length ? `<div class="adm-twrap"><table class="adm-table">
          <thead><tr><th>Test</th><th>Score</th><th>Time</th><th>When</th></tr></thead>
          <tbody>${t.log.map(x => `
            <tr class="click" onclick="openReview('${esc(s.uid)}','${esc(x.session_id)}')">
              <td><div class="adm-t-main">${esc(x.chapter_name)}${x.test_num ? ` · T${x.test_num}` : ''}</div>
                  <div class="adm-t-sub">${x.kind === 'mock' ? 'Mock paper' : esc(x.subject || 'Test')}
                    ${x.is_retake ? ' · retake' : ''} · ${x.wrong_count}✗ ${x.skipped_count}○</div></td>
              <td><span class="adm-pill ${x.passed ? 'good' : 'bad'}">${Math.round(x.percentage)}%</span></td>
              <td class="adm-num">${fmtDur(x.time_taken_seconds)}</td>
              <td>${relTime(x.completed_at)}</td>
            </tr>`).join('')}</tbody>
        </table></div>` : emptyState('fa-hourglass-start', 'No tests yet', 'Nothing completed so far.')}
      </div>`;
}

function closeDrawer() {
  AD.drawerUid = null;
  $('adm-drawer-backdrop').classList.add('hidden');
  $('adm-drawer').classList.add('hidden');
}


/* ════════════════════════════════════════════════════════════════
   TEST REVIEW SHEET — question-level depth
   ════════════════════════════════════════════════════════════════ */

async function openReview(uid, sid) {
  if (event) event.stopPropagation();
  $('adm-sheet').classList.remove('hidden');
  $('adm-sheet-title').textContent = 'Review';
  $('adm-sheet-body').innerHTML = skeleton(3);
  let d;
  try { d = await apiCall(`/api/admin/student/${uid}/test/${sid}`); }
  catch (e) {
    $('adm-sheet-body').innerHTML = emptyState('fa-lock', "Can't open this test", e.message || '');
    return;
  }
  $('adm-sheet-title').textContent =
    `${d.chapter_name || 'Test'}${d.test_num ? ` · T${d.test_num}` : ''} — ${Math.round(d.percentage)}%`;

  $('adm-sheet-body').innerHTML = `
      <div class="pt-sec" style="max-width:760px;margin:14px auto 0">
        <div class="pt-tiles">
          <div class="pt-tile"><div class="pt-tile-v">${Math.round(d.percentage)}%</div><div class="pt-tile-k">Score</div></div>
          <div class="pt-tile"><div class="pt-tile-v">${fmtDur(d.time_taken_seconds)}</div><div class="pt-tile-k">Total time</div></div>
          <div class="pt-tile"><div class="pt-tile-v">${d.seconds_per_question || '—'}s</div><div class="pt-tile-k">Per question</div></div>
        </div>
      </div>
      ${d.questions.map(q => {
    const wrong = q.attempted && q.is_correct === false;
    return `
        <div class="pt-q ${q.is_correct ? 'correct' : wrong ? 'wrong' : 'skipped'}"
             style="max-width:760px;margin-left:auto;margin-right:auto">
          <div class="pt-q-head">
            <span class="pt-q-num">Q${q.index}</span>
            ${q.difficulty ? `<span class="adm-pill">${esc(q.difficulty)}</span>` : ''}
            ${q.concept_id ? `<span class="adm-pill info">${esc(q.concept_id)}</span>` : ''}
            <span class="adm-pill ${q.is_correct ? 'good' : wrong ? 'bad' : ''}">
              ${q.is_correct ? 'correct' : wrong ? 'wrong' : 'skipped'}</span>
          </div>
          <div class="pt-q-text">${esc(q.question_text)}</div>
          ${(q.options || []).map((o, i) => {
      const isObj = o && typeof o === 'object';
      const oid = isObj ? (o.id ?? o.option_id ?? String.fromCharCode(65 + i)) : String.fromCharCode(65 + i);
      const txt = isObj ? (o.text ?? o.option_text ?? '') : o;
      const isC = oid === q.correct_answer;
      const isW = oid === q.student_answer && !isC;
      return `<div class="pt-opt ${isC ? 'is-correct' : ''} ${isW ? 'is-chosen-wrong' : ''}">
                <span class="pt-opt-id">${esc(oid)}</span><span>${esc(txt)}</span>
                ${isC ? '<span class="pt-opt-tag" style="color:var(--green-600);font-weight:700;margin-left:auto">Correct</span>' : ''}
                ${isW ? '<span class="pt-opt-tag" style="color:var(--red);font-weight:700;margin-left:auto">Chosen</span>' : ''}
            </div>`;
    }).join('')}
          ${q.explanation ? `<div class="pt-expl"><b>Why</b>${esc(q.explanation)}</div>` : ''}
        </div>`;
  }).join('')}`;
}

function closeSheet() {
  $('adm-sheet').classList.add('hidden');
  $('adm-sheet-body').innerHTML = '';
}


/* ════════════════════════════════════════════════════════════════
   TEACHERS + PARENTS
   ════════════════════════════════════════════════════════════════ */

async function renderTeachers() {
  const el = $('adm-screen-teachers');
  el.innerHTML = skeleton(3);
  let d;
  try { d = await fetchScreen('teachers', '/api/admin/teachers'); }
  catch (e) { el.innerHTML = emptyState('fa-triangle-exclamation', "Couldn't load", e.message || ''); return; }
  if (!d.teachers.length) {
    el.innerHTML = emptyState('fa-chalkboard-user', 'No teachers yet', 'Teacher accounts appear here after signup.');
    return;
  }
  el.innerHTML = `
      <div class="adm-twrap"><table class="adm-table">
        <thead><tr><th>Teacher</th><th>School</th><th>Classes</th><th>Students</th><th>Pending</th><th>Joined</th></tr></thead>
        <tbody>${d.teachers.map(t => `
          <tr>
            <td><div class="adm-t-main">${esc(t.name)}</div>
                <div class="adm-t-sub">${esc(t.email)}</div></td>
            <td>${esc(t.school_id || '—')}</td>
            <td>${t.classes.length ? t.classes.map(c =>
    `<span class="adm-pill info">${esc(c.class_id)} · ${c.students}</span>`).join(' ') : '—'}</td>
            <td class="adm-num">${t.students_total}</td>
            <td>${t.pending_total ? `<span class="adm-pill warn">${t.pending_total}</span>` : '<span class="adm-pill">0</span>'}</td>
            <td>${relTime(t.created_at)}</td>
          </tr>`).join('')}</tbody>
      </table></div>`;
}

async function renderParents() {
  const el = $('adm-screen-parents');
  el.innerHTML = skeleton(3);
  let d;
  try { d = await fetchScreen('parents', '/api/admin/parents'); }
  catch (e) { el.innerHTML = emptyState('fa-triangle-exclamation', "Couldn't load", e.message || ''); return; }
  if (!d.parents.length) {
    el.innerHTML = emptyState('fa-user-shield', 'No parents yet',
      'Parents appear once a student sends an invite and it gets claimed.');
    return;
  }
  el.innerHTML = `
      <div class="adm-twrap"><table class="adm-table">
        <thead><tr><th>Parent</th><th>Children</th><th>Joined</th></tr></thead>
        <tbody>${d.parents.map(p => `
          <tr>
            <td><div class="adm-t-main">${esc(p.name)}</div>
                <div class="adm-t-sub">${esc(p.email)}</div></td>
            <td>${p.children.length ? p.children.map(k =>
    `<span class="adm-pill info" style="cursor:pointer"
                   onclick="openStudent('${esc(k.uid)}')">${esc(k.name)}</span>`).join(' ') : '—'}</td>
            <td>${relTime(p.created_at)}</td>
          </tr>`).join('')}</tbody>
      </table></div>`;
}


/* ════════════════════════════════════════════════════════════════
   TESTS — global analytics
   ════════════════════════════════════════════════════════════════ */

async function renderTests() {
  const el = $('adm-screen-tests');
  el.innerHTML = skeleton(3);
  let d;
  try { d = await fetchScreen('tests', '/api/admin/tests'); }
  catch (e) { el.innerHTML = emptyState('fa-triangle-exclamation', "Couldn't load", e.message || ''); return; }

  el.innerHTML = `
      <div class="adm-kpis">
        <div class="adm-kpi"><div class="adm-kpi-v">${d.totals.tests.toLocaleString('en-IN')}</div>
            <div class="adm-kpi-k">Chapter tests</div></div>
        <div class="adm-kpi"><div class="adm-kpi-v">${d.totals.mocks.toLocaleString('en-IN')}</div>
            <div class="adm-kpi-k">Mock papers</div></div>
        <div class="adm-kpi"><div class="adm-kpi-v">${d.totals.avg_seconds_per_question || '—'}s</div>
            <div class="adm-kpi-k">Avg per question</div></div>
      </div>

      <div class="adm-grid2">
        <div class="adm-card adm-span2">
          <div class="adm-card-title">Test volume</div>
          <div class="adm-card-sub">Completed per day, last 30 days.</div>
          <div class="pt-chart"><canvas id="adm-ch-tvol"></canvas></div>
        </div>

        <div class="adm-card">
          <div class="adm-card-title">By subject</div>
          <div class="adm-card-sub">Volume, average score, average duration.</div>
          <div class="adm-twrap"><table class="adm-table">
            <thead><tr><th>Subject</th><th>Tests</th><th>Avg score</th><th>Avg time</th></tr></thead>
            <tbody>${d.subjects.map(s => `
              <tr><td class="adm-t-main">${esc(s.subject)}</td>
                  <td class="adm-num">${s.tests.toLocaleString('en-IN')}</td>
                  <td>${miniBar(s.avg_pct)}</td>
                  <td class="adm-num">${fmtDur(s.avg_seconds)}</td></tr>`).join('')}</tbody>
          </table></div>
        </div>

        <div class="adm-card">
          <div class="adm-card-title">Hardest chapters</div>
          <div class="adm-card-sub">Lowest average score, minimum 5 attempts. A red row is a content review, not a student problem.</div>
          ${d.hardest_chapters.length ? `<div class="adm-twrap"><table class="adm-table">
            <thead><tr><th>Chapter</th><th>Attempts</th><th>Avg score</th></tr></thead>
            <tbody>${d.hardest_chapters.map(c => `
              <tr><td><div class="adm-t-main">${esc(c.chapter_name)}</div>
                      <div class="adm-t-sub">${esc(c.subject)}</div></td>
                  <td class="adm-num">${c.attempts}</td>
                  <td>${miniBar(c.avg_pct)}</td></tr>`).join('')}</tbody>
          </table></div>` : emptyState('fa-seedling', 'Too early', 'Needs at least 5 attempts on a chapter.')}
        </div>

        <div class="adm-card adm-span2">
          <div class="adm-card-title">Most-failed questions</div>
          <div class="adm-card-sub">When many students fail the same question, check the question before you check the students.</div>
          ${d.most_failed_questions.length ? `<div class="adm-twrap"><table class="adm-table">
            <thead><tr><th>Question</th><th>Chapter</th><th>Concept</th><th>Students</th><th>Total failures</th></tr></thead>
            <tbody>${d.most_failed_questions.map(q => `
              <tr><td class="adm-t-main">${esc(q.base_question_id)}</td>
                  <td>${esc(q.chapter_name)}</td>
                  <td><span class="adm-pill info">${esc(q.concept_id || '—')}</span></td>
                  <td class="adm-num">${q.students}</td>
                  <td class="adm-num">${q.failures}</td></tr>`).join('')}</tbody>
          </table></div>` : emptyState('fa-circle-check', 'Nothing failing repeatedly', 'That is the good outcome.')}
        </div>
      </div>`;

  lineChart('adm-ch-tvol', d.tests_30d, cssVar('--g500') || '#2f6cb3', 'rgba(47,108,179,.12)');
}


/* ════════════════════════════════════════════════════════════════
   JOINING
   ════════════════════════════════════════════════════════════════ */

async function renderJoining() {
  const el = $('adm-screen-joining');
  el.innerHTML = skeleton(3);
  let d;
  try {
    if (!AD.cache.joining) {
      AD.cache.joining = await apiCall(
        `/api/admin/joining${AD.joinRole ? `?role=${AD.joinRole}` : ''}`);
    }
    d = AD.cache.joining;
  }
  catch (e) { el.innerHTML = emptyState('fa-triangle-exclamation', "Couldn't load", e.message || ''); return; }

  el.innerHTML = `
      <div class="adm-grid2">
        <div class="adm-card">
          <div class="adm-card-title">Pending class joins ${d.pending_joins.length
      ? `<span class="adm-pill warn">${d.pending_joins.length}</span>` : ''}</div>
          <div class="adm-card-sub">Students who typed a school + section code and are waiting.
              Teachers approve these too — you're the override.</div>
          ${d.pending_joins.length ? d.pending_joins.map(p => `
            <div class="adm-kv" id="adm-join-${esc(p.request_id)}">
              <b style="font-weight:600;color:var(--s700)">${esc(p.student_name || p.student_uid)}
                <div class="adm-t-sub">${esc(p.requested_school_id)} · ${esc(p.requested_class_id)} · ${relTime(p.created_at)}</div></b>
              <span style="white-space:nowrap">
                <button class="adm-btn no" onclick="resolveJoin('${esc(p.request_id)}','reject')">Reject</button>
                <button class="adm-btn ok" onclick="resolveJoin('${esc(p.request_id)}','approve')">Approve</button>
              </span>
            </div>`).join('')
      : emptyState('fa-circle-check', 'Queue is clear', 'No one is waiting to join a class.')}
        </div>

        <div class="adm-card">
          <div class="adm-card-title">Recent signups</div>
          <div class="adm-card-sub">Latest 60 accounts, newest first.</div>
          <div class="adm-toolbar" style="margin-bottom:10px">
            ${['', 'student', 'teacher', 'parent'].map(r => `
              <button class="adm-chip ${(AD.joinRole || '') === r ? 'on' : ''}"
                onclick="setJoinRole('${r}')">${r || 'All'}</button>`).join('')}
          </div>
          <div class="adm-twrap"><table class="adm-table">
            <thead><tr><th>Account</th><th>Role</th><th>School</th><th>When</th></tr></thead>
            <tbody>${d.recent_signups.map(u => `
              <tr class="${u.role === 'student' ? 'click' : ''}"
                  ${u.role === 'student' ? `onclick="openStudent('${esc(u.uid)}')"` : ''}>
                <td><div class="adm-t-main">${esc(u.name || '—')}</div>
                    <div class="adm-t-sub">${esc(u.email)}</div></td>
                <td><span class="adm-pill ${u.role === 'teacher' ? 'info' : u.role === 'parent' ? '' : 'good'}">${esc(u.role)}</span></td>
                <td>${esc(u.school_id || '—')}${u.class_id ? ' · ' + esc(u.class_id) : ''}</td>
                <td>${relTime(u.created_at)}</td>
              </tr>`).join('')}</tbody>
          </table></div>
        </div>
      </div>`;
}

function setJoinRole(r) {
  AD.joinRole = r;
  delete AD.cache.joining;
  renderJoining();
}

async function resolveJoin(rid, action) {
  try {
    await apiCall(`/api/admin/join/${rid}/resolve`, 'POST', { action });
    toast(action === 'approve' ? 'Approved' : 'Rejected');
    const row = $(`adm-join-${rid}`);
    if (row) row.remove();
    delete AD.cache.joining;
    delete AD.cache.overview;
  } catch (e) {
    toast(e.message || 'Failed');
  }
}


/* ════════════════════════════════════════════════════════════════
   PAYMENTS — scaffold
   ════════════════════════════════════════════════════════════════ */

async function renderPayments() {
  const el = $('adm-screen-payments');
  el.innerHTML = skeleton(3);
  let d;
  try { d = await fetchScreen('payments', '/api/admin/payments'); }
  catch (e) { el.innerHTML = emptyState('fa-triangle-exclamation', "Couldn't load", e.message || ''); return; }

  el.innerHTML = `
      <div class="adm-grid2">
        <div class="adm-card">
          <div class="adm-card-title">Plan mix</div>
          <div class="adm-card-sub">What students are on today.</div>
          <div class="pt-chart"><canvas id="adm-ch-plans"></canvas></div>
        </div>
        <div class="adm-card">
          <div class="adm-card-title">Revenue</div>
          <div class="adm-card-sub">${d.live
      ? 'Captured payments, most recent first.'
      : 'The gateway is not wired yet. This screen already reads the payments collection — the day the first payment doc lands, the ledger fills in on its own.'}</div>
          <div class="adm-kpi" style="max-width:220px">
            <div class="adm-kpi-v">₹${(d.revenue_total || 0).toLocaleString('en-IN')}</div>
            <div class="adm-kpi-k">Total captured</div>
          </div>
        </div>
        <div class="adm-card adm-span2">
          <div class="adm-card-title">Ledger</div>
          ${d.ledger.length ? `<div class="adm-twrap"><table class="adm-table">
            <thead><tr><th>Who</th><th>Plan</th><th>Amount</th><th>Status</th><th>Provider</th><th>When</th></tr></thead>
            <tbody>${d.ledger.map(p => `
              <tr><td><div class="adm-t-main">${esc(p.name || p.uid)}</div></td>
                  <td>${esc(p.plan || '—')}</td>
                  <td class="adm-num">₹${(p.amount || 0).toLocaleString('en-IN')}</td>
                  <td><span class="adm-pill ${['paid', 'captured', 'success'].includes(p.status) ? 'good' : 'warn'}">${esc(p.status)}</span></td>
                  <td>${esc(p.provider || '—')}</td>
                  <td>${relTime(p.created_at)}</td></tr>`).join('')}</tbody>
          </table></div>`
      : emptyState('fa-indian-rupee-sign', 'Payments coming soon',
        'No payment docs yet. Everything on this screen goes live automatically with the gateway.')}
        </div>
      </div>`;

  if (d.plan_mix.length) {
    chart('adm-ch-plans', {
      type: 'doughnut',
      data: {
        labels: d.plan_mix.map(p => p.plan),
        datasets: [{
          data: d.plan_mix.map(p => p.count),
          backgroundColor: ['#2f6cb3', '#1f9e4a', '#c07c12', '#8fa3ba', '#c43d3d'],
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'right', labels: { font: { size: 11 } } } },
      },
    });
  }
}


/* ════════════════════════════════════════════════════════════════
   SUPPORT — inbox + chat
   ════════════════════════════════════════════════════════════════ */

async function renderSupport() {
  const el = $('adm-screen-support');
  el.innerHTML = `
      <div class="adm-split" id="adm-split">
        <div class="adm-tickets">
          <div class="adm-tickets-head">
            ${['open', 'closed', ''].map(s => `
              <button class="adm-chip ${AD.ticketStatus === s ? 'on' : ''}"
                onclick="setTicketStatus('${s}')">${s || 'All'}</button>`).join('')}
          </div>
          <!-- Who is writing. Students and teachers now share this inbox
               and they need different answers, so being able to work one
               queue at a time matters more than it did with one role. -->
          <div class="adm-tickets-head">
            ${[['', 'Everyone'], ['student', 'Students'], ['teacher', 'Teachers']].map(([r, label]) => `
              <button class="adm-chip ${AD.ticketRole === r ? 'on' : ''}"
                onclick="setTicketRole('${r}')">${label}</button>`).join('')}
          </div>
          <div class="adm-tickets-list" id="adm-tickets-list">${skeleton(2)}</div>
        </div>
        <div class="adm-chat" id="adm-chat">
          ${emptyState('fa-headset', 'Pick a conversation',
    'Messages students and teachers send from Doubts land here.')}
        </div>
      </div>`;
  await loadTickets();
  if (AD.ticket) openTicket(AD.ticket);
}

function setTicketStatus(s) {
  AD.ticketStatus = s;
  renderSupport();
}

function setTicketRole(r) {
  AD.ticketRole = r;
  renderSupport();
}

async function loadTickets() {
  const list = $('adm-tickets-list');
  if (!list) return;
  let d;
  try {
    d = await apiCall(`/api/admin/support${AD.ticketStatus ? `?status=${AD.ticketStatus}` : ''}`);
  } catch (e) {
    list.innerHTML = emptyState('fa-triangle-exclamation', "Couldn't load", e.message || '');
    return;
  }
  // The badge always counts the WHOLE inbox. A teacher query hidden
  // behind the Students chip still needs answering, and a badge that
  // moved with the filter would quietly hide it.
  setBadge('support', d.unread || 0);

  const rows = AD.ticketRole
    ? (d.tickets || []).filter(t => (t.role || 'student') === AD.ticketRole)
    : (d.tickets || []);

  if (!rows.length) {
    list.innerHTML = emptyState('fa-inbox', 'Inbox zero',
      AD.ticketRole ? `No ${AD.ticketRole} conversations in this view.`
        : AD.ticketStatus === 'open' ? 'No open queries right now.'
          : 'Nothing here.');
    return;
  }
  list.innerHTML = rows.map(t => `
        <button class="adm-trow ${AD.ticket === t.ticket_id ? 'on' : ''}"
                onclick="openTicket('${esc(t.ticket_id)}')">
          <div class="adm-trow-t">
            <span class="adm-pill ${t.status === 'open' ? 'warn' : ''}">${esc(t.status)}</span>
            ${esc(t.name || t.email || 'Someone')}
            ${t.unread_admin ? `<em class="adm-nav-badge">${t.unread_admin}</em>` : ''}
          </div>
          <div class="adm-trow-s">${t.last_from === 'admin' ? 'You: ' : ''}${esc(t.last_message)}</div>
          <div class="adm-trow-s">${esc(t.school_name || t.school_id || '—')} · ${esc(t.role)} · ${relTime(t.updated_at)}</div>
        </button>`).join('');
}

async function openTicket(tid) {
  AD.ticket = tid;
  document.querySelectorAll('.adm-trow').forEach(b => b.classList.remove('on'));
  const pane = $('adm-chat');
  pane.innerHTML = skeleton(2);
  let d;
  try { d = await apiCall(`/api/admin/support/${tid}`); }
  catch (e) { pane.innerHTML = emptyState('fa-triangle-exclamation', "Couldn't open", e.message || ''); return; }
  if (AD.ticket !== tid) return;

  const t = d.ticket, s = d.student || {}, te = d.teacher || {};
  const split = $('adm-split');
  if (split) split.classList.add('chat-open');

  // Context line. A student and a teacher need completely different
  // facts on screen before you reply, so build the right one rather
  // than a lowest-common-denominator line that helps with neither.
  // The school NAME, not its code. A teacher's user doc carries no
  // school at all — the backend resolves it through their class docs
  // and hands it over here, so this just picks the best label it has.
  const schoolLabel = (...cands) => esc(cands.find(Boolean) || 'no school');

  let ctx;
  if (te.uid) {
    const roles = (te.classes || []).map(c => {
      const label = c.role === 'class_teacher' ? 'class teacher'
        : c.subjects && c.subjects.length ? c.subjects.join(' + ')
          : 'role not set';
      return `${c.class_id || c.class_key} (${label})`;
    }).join(', ');
    ctx = `${schoolLabel(te.school_name, t.school_name, te.school_id, t.school_id)} · teacher · `
      + `${te.class_count || 0} class${te.class_count === 1 ? '' : 'es'}`
      + `${te.students ? ` · ${te.students} students` : ''}`
      + `${roles ? ` · ${esc(roles)}` : ''}`;
  } else {
    ctx = `${schoolLabel(s.school_name, t.school_name, t.school_id)} · ${esc(t.class_id || 'no class')}${s.uid
      ? ` · ${s.mastery}% mastery · ${s.tests} tests · ${idleText(s.last_active_days)}` : ''}`;
  }

  pane.innerHTML = `
      <div class="adm-chat-head">
        <button class="adm-refresh adm-chat-back" onclick="admSupportBack()" aria-label="Back to queries">
          <i class="fa-solid fa-arrow-left"></i>
        </button>
        <div class="adm-chat-who">
          <div class="adm-chat-name">${esc(t.name || t.email)}</div>
          <div class="adm-chat-sub">${ctx}
            · <span class="adm-pill ${t.status === 'open' ? 'warn' : ''}">${esc(t.status)}</span></div>
        </div>
        <div class="adm-chat-actions">
          ${s.uid ? `<button class="adm-btn ghost" onclick="openStudent('${esc(s.uid)}')">
              <i class="fa-solid fa-user"></i> Student</button>` : ''}
          <button class="adm-btn ${t.status === 'open' ? 'ghost' : 'ok'}" id="adm-tk-status"
                  onclick="toggleTicket('${esc(t.ticket_id)}','${t.status === 'open' ? 'closed' : 'open'}')">
            ${t.status === 'open' ? '<i class="fa-solid fa-check"></i> Resolve' : '<i class="fa-solid fa-rotate-left"></i> Reopen'}
          </button>
        </div>
      </div>
      <div class="adm-chat-log" id="adm-chat-log">${chatBubbles(d.messages, t.role)}</div>
      <div class="adm-composer">
        <textarea id="adm-chat-input" placeholder="Reply as the NAADI team…"
                  onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendAdminReply('${esc(t.ticket_id)}')}"></textarea>
        <button class="adm-btn" onclick="sendAdminReply('${esc(t.ticket_id)}')">
          <i class="fa-solid fa-paper-plane"></i></button>
      </div>`;
  scrollChat();
  loadTickets();          // clears the unread badge on the row
  startChatPoll(tid);
}

/* ════════════════════════════════════════════════════════════════
   SAFETY — reports raised from student <-> teacher conversations

   Every report arrives with a snapshot of the messages that prompted
   it, so a reviewer reads what was actually reported rather than what
   the conversation looks like now. The live thread is one click away.
   ════════════════════════════════════════════════════════════════ */

async function renderSafety() {
  const el = $('adm-screen-safety');
  el.innerHTML = `
      <div class="adm-split" id="adm-split">
        <div class="adm-tickets">
          <div class="adm-tickets-head">
            ${[['open', 'Open'], ['reviewed', 'Reviewed'], ['', 'All']].map(([v, l]) => `
              <button class="adm-chip ${AD.reportStatus === v ? 'on' : ''}"
                onclick="setReportStatus('${v}')">${l}</button>`).join('')}
          </div>
          <div class="adm-tickets-list" id="adm-reports-list">${skeleton(2)}</div>
        </div>
        <div class="adm-chat" id="adm-report-pane">
          ${emptyState('fa-shield-halved', 'Nothing selected',
    'Reports raised by a student or a teacher land here.')}
        </div>
      </div>`;
  await loadReports();
}

function setReportStatus(v) { AD.reportStatus = v; renderSafety(); }

async function loadReports() {
  const list = $('adm-reports-list');
  if (!list) return;
  let d;
  try { d = await apiCall(`/api/admin/doubts/reports?status=${AD.reportStatus}`); }
  catch (e) {
    list.innerHTML = emptyState('fa-triangle-exclamation', "Couldn't load", e.message || '');
    return;
  }
  setBadge('safety', d.open || 0);
  AD.reports = d.reports || [];
  if (!AD.reports.length) {
    list.innerHTML = emptyState('fa-shield-halved', 'Nothing reported',
      AD.reportStatus === 'open' ? 'No open reports.' : 'Nothing here.');
    return;
  }
  list.innerHTML = AD.reports.map((r, i) => `
        <button class="adm-trow" onclick="openReport(${i})">
          <div class="adm-trow-t">
            <span class="adm-pill ${r.status === 'open' ? 'warn' : ''}">${esc(r.status)}</span>
            ${esc(r.by_role === 'student' ? r.student_name : r.teacher_name)}
            reported ${esc(r.by_role === 'student' ? 'a teacher' : 'a student')}
          </div>
          <div class="adm-trow-s">${esc(r.reason || 'No reason given')}</div>
          <div class="adm-trow-s">${esc(r.school_name || '—')} · ${esc(r.class_key || '')}
            · ${relTime(r.at)}</div>
        </button>`).join('');
}

async function openReport(i) {
  const r = AD.reports[i];
  const pane = $('adm-report-pane');
  if (!r || !pane) return;
  $('adm-split')?.classList.add('chat-open');
  pane.innerHTML = `
      <div class="adm-chat-head">
        <button class="adm-refresh adm-chat-back" onclick="admReportBack()" aria-label="Back">
          <i class="fa-solid fa-arrow-left"></i>
        </button>
        <div class="adm-chat-who">
          <div class="adm-chat-name">${esc(r.student_name)} &amp; ${esc(r.teacher_name)}</div>
          <div class="adm-chat-sub">${esc(r.school_name || '—')} · ${esc(r.class_key || '')}
            · reported by the ${esc(r.by_role)} · ${relTime(r.at)}</div>
        </div>
        <button class="adm-refresh" onclick="setReportReviewed('${esc(r.report_id)}')">
          ${r.status === 'open' ? 'Mark reviewed' : 'Reopen'}
        </button>
      </div>
      <div class="adm-chat-log">
        <div class="adm-t-sub" style="margin-bottom:10px">
          <b>Reason given:</b> ${esc(r.reason || 'None')}
        </div>
        <div class="adm-t-sub" style="margin-bottom:10px">
          Messages as they were when this was reported:
        </div>
        ${(r.last_messages || []).map(m => `
          <div class="adm-msg ${m.from === 'teacher' ? 'me' : ''}">${esc(m.text)}
            <small>${esc(m.by_name)} · ${esc(m.from)} · ${relTime(m.at)}</small></div>`).join('')
    || '<div class="adm-t-sub">No messages captured.</div>'}
      </div>`;
}

function admReportBack() { $('adm-split')?.classList.remove('chat-open'); }

async function setReportReviewed(rid) {
  const cur = (AD.reports.find(r => r.report_id === rid) || {}).status;
  try {
    await apiCall(`/api/admin/doubts/report/${rid}/status`, 'POST',
      { status: cur === 'open' ? 'reviewed' : 'open' });
    renderSafety();
  } catch (e) { toast(e.message || 'Could not update'); }
}


function chatBubbles(messages, threadRole) {
  if (!messages.length) return '<div class="adm-t-sub" style="text-align:center">No messages yet.</div>';
  return messages.map(m => {
    // by_role landed with the teacher rollout; messages written
    // before it have none, so fall back to the thread's own role
    // rather than guessing or printing nothing.
    const role = m.by_role || (m.from === 'admin' ? 'admin' : (threadRole || ''));
    const tag = role && role !== 'admin' ? ` · ${esc(role)}` : '';
    return `
        <div class="adm-msg ${m.from === 'admin' ? 'me' : ''}">${esc(m.text)}
          <small>${esc(m.by_name)}${tag} · ${relTime(m.at)}</small></div>`;
  }).join('');
}

function scrollChat() {
  const log = $('adm-chat-log');
  if (log) log.scrollTop = log.scrollHeight;
}

async function sendAdminReply(tid) {
  const input = $('adm-chat-input');
  const text = (input.value || '').trim();
  if (!text) return;
  input.value = '';
  try {
    await apiCall(`/api/admin/support/${tid}/message`, 'POST', { text });
    const d = await apiCall(`/api/admin/support/${tid}`);
    const log = $('adm-chat-log');
    if (log && AD.ticket === tid) { log.innerHTML = chatBubbles(d.messages, d.ticket && d.ticket.role); scrollChat(); }
    loadTickets();
  } catch (e) {
    toast(e.message || 'Send failed');
    input.value = text;
  }
}

async function toggleTicket(tid, status) {
  try {
    await apiCall(`/api/admin/support/${tid}/status`, 'POST', { status });
    toast(status === 'closed' ? 'Closed' : 'Reopened');
    openTicket(tid);
  } catch (e) { toast(e.message || 'Failed'); }
}

function startChatPoll(tid) {
  stopChatPoll();
  AD.pollChat = setInterval(async () => {
    if (AD.screen !== 'support' || AD.ticket !== tid) return stopChatPoll();
    try {
      const d = await apiCall(`/api/admin/support/${tid}`);
      const log = $('adm-chat-log');
      if (log && AD.ticket === tid) {
        const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 40;
        log.innerHTML = chatBubbles(d.messages, d.ticket && d.ticket.role);
        if (stick) scrollChat();
      }
    } catch (e) { /* quiet */ }
  }, 8000);
}

function admSupportBack() {
  // Mobile: chat → back to the ticket list. Desktop never shows the
  // button, but the state cleanup is correct there too.
  stopChatPoll();
  AD.ticket = null;
  const split = $('adm-split');
  if (split) split.classList.remove('chat-open');
  const pane = $('adm-chat');
  if (pane) pane.innerHTML = emptyState('fa-headset', 'Pick a conversation',
    'Queries students send from their Profile land here.');
  loadTickets();
}

function stopChatPoll() {
  if (AD.pollChat) { clearInterval(AD.pollChat); AD.pollChat = null; }
}