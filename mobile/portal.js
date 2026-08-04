/* ════════════════════════════════════════════════════════════════
   NAADI AI — PARENT PORTAL (portal.js)
   ─────────────────────────────────────────────────────────────────
   Loads only shared.js + this file. None of the student bundles
   (opd.js, test-engine.js, concept-studio.js…) are shipped here —
   a parent's phone has no reason to download a test engine.

   The client NEVER sends a class id, school id, or its own role.
   It sends a token. The server resolves scope. Every fetch below
   can be replayed with a forged uid and will 403.
   ════════════════════════════════════════════════════════════════ */

const PT = {
  role: null,
  me: null,
  children: [],
  activeIdx: 0,
  tab: 'home',
  cache: {},        // `${uid}:${tab}` → payload
  charts: {},       // canvas id → Chart instance
  tabs: [],         // set at boot; parent and teacher differ
};

const LAST_CHILD_KEY = 'NAADI_LAST_CHILD';

// ── tiny helpers ──────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => escapeHtml(s == null ? '' : String(s));

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
  return then.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function pctText(v) { return v == null ? '—' : `${Math.round(v)}%`; }

function skeleton(n) {
  return `<div class="pt-skel">${'<div></div>'.repeat(n || 3)}</div>`;
}

function emptyState(icon, title, body) {
  return `<div class="pt-empty">
        <i class="fa-solid ${icon}"></i>
        <h3>${esc(title)}</h3>
        <p>${esc(body)}</p>
    </div>`;
}

function avatarHTML(photo, initials, cls) {
  return photo
    ? `<div class="pt-avatar ${cls || ''}"><img src="${esc(photo)}" alt=""></div>`
    : `<div class="pt-avatar ${cls || ''}">${esc(initials || '?')}</div>`;
}

// A student with zero data must see an honest blank, never a chart of noise.
function hasData(arr) { return Array.isArray(arr) && arr.length > 0; }


/* ════════════════════════════════════════════════════════════════
   BOOT
   ════════════════════════════════════════════════════════════════ */

auth.onAuthStateChanged(async (user) => {
  if (!user) { location.replace('login.html'); return; }
  currentUser = user;

  try {
    const me = await apiCall('/api/portal/whoami');
    PT.role = me.role;

    if (me.role === 'student') {
      location.replace('app.html');
      return;
    }
    if (me.role !== 'parent' && me.role !== 'teacher') {
      showWall("This isn't your door", 'This portal is for parents and teachers.');
      return;
    }

    if (me.role === 'teacher') {
      await bootTeacher();          // teacher.js
    } else {
      PT.tabs = PARENT_TABS;
      renderTabbar();
      PT.me = await apiCall('/api/parent/me');
      $('pt-user-name').textContent = PT.me.name || 'Parent';
      await loadDeck();
    }

    $('pt-boot').classList.add('hidden');
    $('pt-topbar').classList.remove('hidden');
    $('pt-main').classList.remove('hidden');
    $('pt-tabbar').classList.remove('hidden');

  } catch (e) {
    console.error(e);
    showWall("We couldn't load your portal", e.message || 'Please try again in a moment.');
  }
});

function showWall(title, body) {
  $('pt-boot').classList.add('hidden');
  $('pt-wall').querySelector('h2').textContent = title;
  $('pt-wall-body').textContent = body;
  $('pt-wall').classList.remove('hidden');
}

function portalLogout() {
  localStorage.removeItem(LAST_CHILD_KEY);
  auth.signOut().then(() => location.replace('login.html'));
}


/* ════════════════════════════════════════════════════════════════
   THE DECK
   Card 1 on open = last-viewed child. Siblings with an active alert
   carry a red dot, so a parent scrolling past sees the flag without
   having to open every card.
   ════════════════════════════════════════════════════════════════ */

async function loadDeck() {
  const d = await apiCall('/api/parent/children');
  PT.children = d.children || [];

  if (!PT.children.length) {
    $('pt-deck-wrap').innerHTML = emptyState('fa-user-slash', 'No children linked',
      'Ask your child to send you an invite from their Profile screen.');
    return;
  }

  // Last-viewed child leads. Not the eldest, not the one in trouble —
  // a parent checking on Arun twice a day should not have to swipe.
  const last = localStorage.getItem(LAST_CHILD_KEY);
  const li = PT.children.findIndex(c => c.uid === last);
  if (li > 0) PT.children.unshift(PT.children.splice(li, 1)[0]);

  PT.activeIdx = 0;
  renderDeck();
  await renderTab('home');
}

function activeChild() { return PT.children[PT.activeIdx]; }

function renderDeck() {
  const single = PT.children.length === 1;
  const cards = PT.children.map((c, i) => c.consent_revoked ? lockedCard(c, i) : childCard(c, i)).join('');

  $('pt-deck-wrap').innerHTML = `
      <div class="pt-deck">
        <div class="pt-deck-track ${single ? 'single' : ''}" id="pt-track">${cards}</div>
        <div class="pt-dots ${single ? 'hidden' : ''}" id="pt-dots">
          ${PT.children.map((_, i) => `<div class="pt-dot ${i === 0 ? 'on' : ''}"></div>`).join('')}
        </div>
      </div>`;

  if (!single) {
    const track = $('pt-track');
    let t;
    track.addEventListener('scroll', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const i = Math.round(track.scrollLeft / (track.scrollWidth / PT.children.length));
        if (i !== PT.activeIdx && PT.children[i]) onChildSwitch(i);
      }, 90);
    }, { passive: true });
  }
}

function childCard(c, i) {
  const idle = c.last_active_days;
  const idleCls = idle == null ? 'muted' : idle >= 7 ? 'bad' : idle >= 3 ? 'warn' : '';
  const idleTxt = idle == null ? '—' : idle === 0 ? 'Today' : `${idle}d ago`;

  const meta = [c.school_id, c.class_id && `Class ${c.class_id}`]
    .filter(Boolean).join(' · ') || 'No class assigned';

  return `
    <div class="pt-card ${i === PT.activeIdx ? 'on' : ''}" onclick="clickChild(${i})">
      ${c.has_alert ? '<div class="pt-card-dot" title="Needs attention"></div>' : ''}
      <div class="pt-card-head">
        ${avatarHTML(c.photo_url, c.initials)}
        <div style="min-width:0">
          <div class="pt-card-name">${esc(c.name)}</div>
          <div class="pt-card-meta">${esc(meta)}</div>
        </div>
      </div>

      <div class="pt-bar-wrap">
        <div class="pt-bar-top">
          <span>Progress to Doctor</span>
          <b>${esc(c.doctor_rank)} · ${Math.round(c.doctor_overall)}%</b>
        </div>
        <div class="pt-bar"><i style="width:${Math.max(2, c.doctor_overall)}%"></i></div>
      </div>

      <div class="pt-card-lines">
        <div class="pt-line">
          <div class="pt-line-k">Last active</div>
          <div class="pt-line-v ${idleCls}">${esc(idleTxt)}</div>
        </div>
        <div class="pt-line">
          <div class="pt-line-k">Streak</div>
          <div class="pt-line-v ${c.streak_current ? '' : 'muted'}">${c.streak_current || 0}d</div>
        </div>
        <div class="pt-line">
          <div class="pt-line-k">This week</div>
          <div class="pt-line-v ${c.accuracy_week == null ? 'muted' : ''}">${pctText(c.accuracy_week)}</div>
        </div>
      </div>
    </div>`;
}

function lockedCard(c, i) {
  return `
    <div class="pt-card locked ${i === PT.activeIdx ? 'on' : ''}" onclick="clickChild(${i})">
      <div class="pt-card-head">
        ${avatarHTML(null, c.initials)}
        <div><div class="pt-card-name">${esc(c.name)}</div></div>
      </div>
      <p class="pt-locked-msg">
        <i class="fa-solid fa-lock"></i>
        ${esc(c.name.split(' ')[0])} has turned off parent access.
        Only they can turn it back on, from their Profile screen.
      </p>
    </div>`;
}

// Desktop-only: the deck is a click-to-select grid at >=1024px. On a
// phone the deck still swipes, so this is a strict no-op there and tap
// behaviour is unchanged.
function clickChild(i) {
  if (window.matchMedia('(min-width: 1024px)').matches) onChildSwitch(i);
}

async function onChildSwitch(i) {
  if (i === PT.activeIdx) return;
  PT.activeIdx = i;
  const c = activeChild();
  localStorage.setItem(LAST_CHILD_KEY, c.uid);
  document.querySelectorAll('#pt-dots .pt-dot')
    .forEach((d, k) => d.classList.toggle('on', k === i));
  document.querySelectorAll('#pt-track > .pt-card')
    .forEach((el, k) => el.classList.toggle('on', k === i));
  destroyCharts();
  await renderTab(PT.tab);
}


/* ════════════════════════════════════════════════════════════════
   TABS
   ════════════════════════════════════════════════════════════════ */

const ALL_SCREENS = ['home', 'learning', 'tests', 'insights',
  'class', 'students', 'concepts', 'doubts', 'profile'];

const PARENT_TABS = [
  { id: 'home', icon: 'fa-house-medical', label: 'Home' },
  { id: 'learning', icon: 'fa-graduation-cap', label: 'Learning' },
  { id: 'tests', icon: 'fa-notes-medical', label: 'Tests' },
  { id: 'insights', icon: 'fa-chart-line', label: 'Insights' },
  { id: 'profile', icon: 'fa-user', label: 'Profile' },
];

function renderTabbar() {
  // Sidebar brand: .dsk-only is display:none in styles-mobile.css,
  // so this only ever paints in the >=1024px desktop shell.
  const brand = `<div class="pt-side-brand dsk-only">
          <div class="pt-logo"><i class="fa-solid fa-brain"></i></div>
          <b>NAADI <span>AI</span></b>
        </div>`;
  // A tab marked `dsk: true` renders .dsk-only: styles-mobile.css hides
  // it, doubts.css reveals it inside its >=1024px query. That is how
  // Doubts becomes a sidebar row on desktop while the phone's bottom bar
  // stays at five tabs and reaches it from the top-bar icon instead.
  // The tab is still a real member of PT.tabs, so goTab('doubts') works
  // on both — only the nav button's visibility differs.
  $('pt-tabbar').innerHTML = brand + PT.tabs.map((t, i) => `
        <button class="mnav-item ${i === 0 ? 'active' : ''}${t.dsk ? ' dsk-only' : ''}"
                data-tab="${t.id}" onclick="goTab('${t.id}')">
          <i class="fa-solid ${t.icon}"></i><span>${t.label}</span>
          <em class="mnav-badge hidden" id="badge-${t.id}"></em>
        </button>`).join('');
}

function setBadge(tab, n) {
  const el = $(`badge-${tab}`);
  if (!el) return;
  el.textContent = n > 99 ? '99+' : n;
  el.classList.toggle('hidden', !n);
}

function goTab(tab) {
  if (!PT.tabs.some(t => t.id === tab)) return;
  PT.tab = tab;
  ALL_SCREENS.forEach(t => $(`screen-${t}`)?.classList.toggle('hidden', t !== tab));
  document.querySelectorAll('.mnav-item')
    .forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  window.scrollTo(0, 0);
  destroyCharts();
  // An 8s thread poll must never tick against a hidden screen.
  if (tab !== 'doubts' && typeof ndDoubtsUnmount === 'function') ndDoubtsUnmount();

  // Tell Nia which teacher surface this is. Costs nothing — the
  // descriptor is only ever SENT when the teacher presses send. The
  // server re-checks every class_key and student_uid against the
  // teacher's own roster, so this is a hint, never the boundary.
  if (PT.role === 'teacher' && typeof niaSetContext === 'function') {
    const NIA_T = {
      home: 'teacher_home', class: 'teacher_class',
      students: 'teacher_class', concepts: 'teacher_concepts',
    };
    niaSetContext({
      surface: NIA_T[tab] || 'teacher_home',
      class_key: (typeof TH !== 'undefined' && TH.data
        && TH.data.header ? TH.data.header.class_key : '')
        || (typeof TC !== 'undefined' && TC.classKey ? TC.classKey : ''),
      student_uid: (tab === 'students' && typeof TSU !== 'undefined')
        ? (TSU.uid || '') : '',
    });
  }
  renderTab(tab);
}

async function renderTab(tab) {
  if (PT.role === 'teacher') return renderTeacherTab(tab);   // teacher.js
  return renderParentTab(tab);
}

async function renderParentTab(tab) {
  const c = activeChild();
  if (!c && tab !== 'profile') return;

  if (tab === 'profile') return renderProfile();
  if (c.consent_revoked) {
    $(`pt-${tab}-body`).innerHTML = emptyState('fa-lock', 'Access turned off',
      `${c.name.split(' ')[0]} has turned off parent access.`);
    return;
  }

  const body = $(`pt-${tab}-body`);
  const key = `${c.uid}:${tab}`;

  if (!PT.cache[key]) {
    body.innerHTML = skeleton(tab === 'home' ? 3 : 2);
    try {
      PT.cache[key] = await fetchTab(tab, c.uid);
    } catch (e) {
      body.innerHTML = emptyState('fa-triangle-exclamation', "Couldn't load this",
        e.message || 'Please pull down and try again.');
      return;
    }
  }

  const d = PT.cache[key];
  if (tab === 'home') renderHome(d);
  if (tab === 'learning') renderLearning(d);
  if (tab === 'tests') renderTests(d);
  if (tab === 'insights') renderInsights(d);
}

async function fetchTab(tab, uid) {
  const base = `/api/parent/child/${uid}`;
  if (tab === 'home') return apiCall(`${base}/home`);
  if (tab === 'learning') return apiCall(`${base}/learning`);
  if (tab === 'tests') return apiCall(`${base}/tests`);
  if (tab === 'insights') {
    // Insights and readiness are two screens' worth of data on one tab.
    const [ins, rdy] = await Promise.all([
      apiCall(`${base}/insights`),
      apiCall(`${base}/readiness`)
    ]);
    return { ...ins, readiness: rdy };
  }
}


/* ════════════════════════════════════════════════════════════════
   SCREEN 1 · HOME
   ════════════════════════════════════════════════════════════════ */

function renderHome(d) {
  const g = d.doctor_scale;
  const w = d.week;

  $('pt-home-body').innerHTML = `
      ${d.alerts.length ? `<div class="pt-sec">
        <div class="pt-sec-title">Needs attention</div>
        <div class="pt-sec-sub">Worth a conversation, not an alarm.</div>
        ${d.alerts.map(a => `
          <div class="pt-alert">
            <i class="fa-solid fa-circle-exclamation"></i>
            <div>
              <div class="pt-alert-t">${esc(a.title)}</div>
              <div class="pt-alert-b">${esc(a.body)}</div>
            </div>
          </div>`).join('')}
      </div>` : ''}

      <div class="pt-sec">
        <div class="pt-sec-title">Progress to Doctor</div>
        <div class="pt-sec-sub">Concept Studio, practice tests and mock papers, combined.</div>
        <div class="pt-gauge">
          ${ringHTML(g.overall)}
          <div>
            <div class="pt-rank">${esc(g.rank)}</div>
            <div class="pt-rank-next">${g.next_rank
      ? `${g.to_next}% more to reach <b>${esc(g.next_rank)}</b>`
      : 'Top of the ladder.'}</div>
            <div class="pt-comp">
              <span class="pt-chip">Studio ${Math.round(g.components.studio)}%</span>
              <span class="pt-chip">Tests ${Math.round(g.components.opd)}%</span>
              <span class="pt-chip">Mocks ${Math.round(g.components.arena)}%</span>
            </div>
          </div>
        </div>
      </div>

      <div class="pt-sec">
        <div class="pt-streak-head">
          <span class="pt-flame">${d.streak.current}</span>
          <div>
            <div class="pt-sec-title" style="margin:0">day streak</div>
            <div class="pt-sec-sub" style="margin:0">Longest: ${d.streak.longest} days</div>
          </div>
        </div>
        ${heatmapHTML(d.streak.days)}
      </div>

      <div class="pt-sec">
        <div class="pt-sec-title">This week</div>
        <div class="pt-sec-sub">Compared with the week before.</div>
        <div class="pt-tiles">
          ${tile(w.tests.value, 'Tests', w.tests.delta)}
          ${tile(w.blocks.value, 'Blocks', w.blocks.delta)}
          ${tile(w.accuracy.value == null ? '—' : w.accuracy.value + '%', 'Accuracy', w.accuracy.delta)}
        </div>
      </div>

      <div class="pt-sec">
        <div class="pt-sec-title">Recent activity</div>
        <div class="pt-sec-sub"></div>
        ${hasData(d.activity) ? d.activity.map(a => `
          <div class="pt-feed-row">
            <div class="pt-feed-ico ${a.good ? '' : 'bad'}">
              <i class="fa-solid ${a.type === 'test' ? 'fa-notes-medical' : 'fa-book-open'}"></i>
            </div>
            <div style="min-width:0">
              <div class="pt-feed-t">${esc(a.title)}</div>
              <div class="pt-feed-s">${esc(a.subtitle)}</div>
            </div>
            <div class="pt-feed-when">${esc(relTime(a.at))}</div>
          </div>`).join('')
      : emptyState('fa-hourglass-start', 'Nothing yet',
        'Activity will appear here once your child starts studying.')}
      </div>`;
}

function tile(value, label, delta) {
  let d = '';
  if (delta != null) {
    const cls = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
    const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '—';
    d = `<div class="pt-delta ${cls}">${arrow} ${Math.abs(delta)}%</div>`;
  }
  return `<div class="pt-tile">
        <div class="pt-tile-v">${esc(value)}</div>
        <div class="pt-tile-k">${esc(label)}</div>${d}
    </div>`;
}

function ringHTML(pct) {
  const R = 42, C = 2 * Math.PI * R;
  const off = C - (Math.max(0, Math.min(100, pct)) / 100) * C;
  return `<div class="pt-ring">
      <svg width="96" height="96" viewBox="0 0 96 96">
        <circle cx="48" cy="48" r="${R}" fill="none" stroke="var(--s200)" stroke-width="8"/>
        <circle cx="48" cy="48" r="${R}" fill="none" stroke="var(--g500)" stroke-width="8"
                stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${off}"/>
      </svg>
      <div class="pt-ring-txt">${Math.round(pct)}<span>%</span></div>
    </div>`;
}

function heatmapHTML(days) {
  if (!hasData(days)) return '';
  // Pad the front so the first column starts on a Monday — otherwise the
  // week rows lie about which day of the week each square is.
  const first = new Date(days[0].date + 'T00:00:00');
  const pad = (first.getDay() + 6) % 7;
  const cells = Array(pad).fill('<i class="future"></i>')
    .concat(days.map(d => `<i class="${d.active ? 'on' : ''}" title="${d.date}"></i>`));
  return `<div class="pt-heat">${cells.join('')}</div>`;
}


/* ════════════════════════════════════════════════════════════════
   SCREEN 2 · LEARNING
   ════════════════════════════════════════════════════════════════ */

function renderLearning(d) {
  const anything = d.chapters.length > 0;

  $('pt-learning-body').innerHTML = `
      <div class="pt-sec">
        <div class="pt-sec-title">Syllabus coverage</div>
        <div class="pt-sec-sub">Chapters finished, started, and not yet opened.</div>
        ${d.coverage.map(c => `
          <div class="pt-cov">
            <div class="pt-cov-top">
              <b>${esc(c.subject)}</b>
              <span>${c.done + c.in_progress} / ${c.total} chapters</span>
            </div>
            <div class="pt-cov-bar">
              <i class="done" style="width:${c.total ? c.done / c.total * 100 : 0}%"></i>
              <i class="prog" style="width:${c.total ? c.in_progress / c.total * 100 : 0}%"></i>
            </div>
          </div>`).join('')}
        <div class="pt-cov-legend">
          <span><b style="background:var(--green-600)"></b>Finished</span>
          <span><b style="background:var(--g400)"></b>In progress</span>
          <span><b style="background:var(--s200)"></b>Not started</span>
        </div>
      </div>

      ${d.current ? `<div class="pt-sec">
        <div class="pt-sec-title">Currently working on</div>
        <div class="pt-sec-sub">${esc(d.current.subject)} · Class ${esc(d.current.class)}</div>
        <div class="pt-row" style="cursor:default">
          <div class="pt-row-main">
            <div class="pt-row-t">${esc(d.current.chapter_name)}</div>
            <div class="pt-row-s">
              ${d.current.tests} of ${d.current.total_tests} tests ·
              ${Math.round(d.current.studio_completion)}% of notes read
            </div>
          </div>
          <div class="pt-row-r"><div class="pt-pct">${Math.round(d.current.mastery)}%</div></div>
        </div>
      </div>` : ''}

      <div class="pt-sec">
        <div class="pt-sec-title">Subjects</div>
        <div class="pt-sec-sub">Mastery is how well the concepts are understood, not how much is done.</div>
        <div class="pt-chart"><canvas id="ch-subject"></canvas></div>
      </div>

      <div class="pt-sec">
        <div class="pt-sec-title">Chapters</div>
        <div class="pt-sec-sub">Only chapters your child has opened.</div>
        ${anything ? d.chapters.map(c => `
          <div class="pt-row" style="cursor:default">
            <div class="pt-row-main">
              <div class="pt-row-t">${esc(c.chapter_name)}</div>
              <div class="pt-row-s">
                ${esc(c.subject)} · ${c.tests}/${c.total_tests} tests
                ${c.blocks_total ? ` · ${c.blocks_done}/${c.blocks_total} blocks` : ''}
              </div>
            </div>
            <div class="pt-row-r">
              <div class="pt-pct">${Math.round(c.mastery)}%</div>
              <div class="pt-mini"><i style="width:${c.mastery}%"></i></div>
            </div>
          </div>`).join('')
      : emptyState('fa-book', 'No chapters opened yet',
        "Once your child starts a chapter, it'll show up here.")}
      </div>

      <div class="pt-sec">
        <div class="pt-sec-title">Flashcard recall</div>
        <div class="pt-sec-sub">${d.flashcards.seen} cards seen · ${d.flashcards.correct} recalled correctly</div>
        ${d.flashcards.seen
      ? `<div class="pt-chart" style="height:160px"><canvas id="ch-flash"></canvas></div>`
      : emptyState('fa-clone', 'No flashcards yet', 'Flashcards appear after a Concept Studio block.')}
      </div>

      <div class="pt-sec">
        <div class="pt-sec-title">Time in tests</div>
        <div class="pt-sec-sub">
          Minutes spent inside tests each week. This is <em>not</em> total study time —
          we don't track time spent reading, and pretending otherwise would be a number
          you couldn't check.
        </div>
        ${hasData(d.time_in_tests)
      ? `<div class="pt-chart"><canvas id="ch-time"></canvas></div>`
      : emptyState('fa-clock', 'No tests taken yet', '')}
      </div>`;

  // ── charts
  const subs = d.coverage.filter(c => c.mastery > 0 || c.accuracy > 0);
  if (subs.length) {
    chart('ch-subject', {
      type: 'bar',
      data: {
        labels: subs.map(s => s.subject),
        datasets: [
          { label: 'Mastery', data: subs.map(s => s.mastery), backgroundColor: cssVar('--g500'), borderRadius: 5 },
          { label: 'Accuracy', data: subs.map(s => s.accuracy), backgroundColor: cssVar('--s300'), borderRadius: 5 },
        ]
      },
      options: baseOpts({ y: { max: 100, ticks: { callback: v => v + '%' } } })
    });
  } else {
    $('ch-subject')?.closest('.pt-chart')?.replaceWith(
      htmlToNode(emptyState('fa-chart-simple', 'No test data yet', '')));
  }

  if (d.flashcards.seen) {
    chart('ch-flash', {
      type: 'doughnut',
      data: {
        labels: ['Recalled', 'Missed'],
        datasets: [{
          data: [d.flashcards.correct, d.flashcards.seen - d.flashcards.correct],
          backgroundColor: [cssVar('--green-600'), cssVar('--s200')],
          borderWidth: 0
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '68%',
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } }
      }
    });
  }

  if (hasData(d.time_in_tests)) {
    chart('ch-time', {
      type: 'bar',
      data: {
        labels: d.time_in_tests.map(t => t.week.split('-W')[1] ? 'W' + t.week.split('-W')[1] : t.week),
        datasets: [{
          label: 'Minutes', data: d.time_in_tests.map(t => t.minutes),
          backgroundColor: cssVar('--g400'), borderRadius: 5
        }]
      },
      options: baseOpts({}, false)
    });
  }
}


/* ════════════════════════════════════════════════════════════════
   SCREEN 3 · TESTS
   ════════════════════════════════════════════════════════════════ */

function renderTests(d) {
  const a = d.accuracy;
  const attempted = a.correct + a.wrong;

  $('pt-tests-body').innerHTML = `
      <div class="pt-sec">
        <div class="pt-sec-title">Score trend</div>
        <div class="pt-sec-sub">Every test, in order. The dashed line is the ${d.pass_threshold}% pass mark.</div>
        ${hasData(d.trend)
      ? '<div class="pt-chart tall"><canvas id="ch-trend"></canvas></div>'
      : emptyState('fa-chart-line', 'No tests yet', 'The trend appears after the first test.')}
      </div>

      ${attempted ? `
      <div class="pt-sec">
        <div class="pt-sec-title">Answer breakdown</div>
        <div class="pt-sec-sub">Across every test taken.</div>
        <div class="pt-chart" style="height:170px"><canvas id="ch-acc"></canvas></div>
      </div>` : ''}

      ${hasData(d.difficulty) ? `
      <div class="pt-sec">
        <div class="pt-sec-title">By difficulty</div>
        <div class="pt-sec-sub">Where the questions get hard.</div>
        <div class="pt-chart"><canvas id="ch-diff"></canvas></div>
      </div>` : ''}

      ${hasData(d.phase_journey) ? `
      <div class="pt-sec">
        <div class="pt-sec-title">Journey through each chapter</div>
        <div class="pt-sec-sub">Foundation builds recall. Mastery and Simulation build exam speed.</div>
        ${d.phase_journey.slice(0, 5).map(p => `
          <div style="margin-bottom:18px">
            <div class="pt-row-t" style="margin-bottom:2px">${esc(p.chapter_name)}</div>
            <div class="pt-phase">
              ${p.phases.map(ph => {
        const ai = p.phases.indexOf(p.active_phase);
        const i = p.phases.indexOf(ph);
        const cls = p.complete ? 'done' : i < ai ? 'done' : i === ai ? 'active' : '';
        return `<div class="pt-phase-n ${cls}">
                            <div class="pt-phase-d"></div>${esc(ph.replace(' ', '\n'))}
                          </div>`;
      }).join('')}
            </div>
          </div>`).join('')}
      </div>` : ''}

      ${d.retakes ? `<div class="pt-sec">
        <div class="pt-sec-title">Retakes</div>
        <div class="pt-sec-sub">
          ${d.retakes} ${d.retakes === 1 ? 'test' : 'tests'} retaken. Retaking is how mastery
          is built — the app asks for it deliberately, and it is not a bad sign.
        </div>
      </div>` : ''}

      <div class="pt-sec">
        <div class="pt-sec-title">Every test</div>
        <div class="pt-sec-sub">Tap any test to see the questions and explanations.</div>
        ${hasData(d.log) ? d.log.map(t => `
          <button class="pt-row" onclick="openReview('${esc(t.session_id)}')">
            <div class="pt-row-main">
              <div class="pt-row-t">${esc(t.chapter_name)}</div>
              <div class="pt-row-s">
                Test ${t.test_num} · ${esc(t.phase)} · ${esc(relTime(t.completed_at))}
                ${t.is_retake ? ' <span class="pt-chip-sm retake">Retake</span>' : ''}
              </div>
            </div>
            <div class="pt-row-r">
              <div class="pt-pct">${Math.round(t.percentage)}%</div>
              <span class="pt-chip-sm ${t.passed ? 'pass' : 'fail'}">
                ${t.passed ? 'Passed' : 'Below ' + d.pass_threshold + '%'}
              </span>
            </div>
          </button>`).join('')
      : emptyState('fa-notes-medical', 'No tests yet',
        'Test results, question by question, will appear here.')}
      </div>`;

  if (hasData(d.trend)) {
    chart('ch-trend', {
      type: 'line',
      data: {
        labels: d.trend.map(p => p.x),
        datasets: [{
          data: d.trend.map(p => p.y),
          borderColor: cssVar('--g500'),
          backgroundColor: 'rgba(47,108,179,.10)',
          fill: true, tension: .32, pointRadius: 3,
          pointBackgroundColor: cssVar('--g600')
        }]
      },
      options: {
        ...baseOpts({ y: { max: 100, ticks: { callback: v => v + '%' } } }, false),
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { title: ctx => d.trend[ctx[0].dataIndex].label } }
        }
      },
      plugins: [passLine(d.pass_threshold)]
    });
  }

  if (attempted) {
    chart('ch-acc', {
      type: 'doughnut',
      data: {
        labels: ['Correct', 'Wrong', 'Not attempted'],
        datasets: [{
          data: [a.correct, a.wrong, a.unattempted],
          backgroundColor: [cssVar('--green-600'), cssVar('--red'), cssVar('--s200')],
          borderWidth: 0
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '66%',
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } }
      }
    });
  }

  if (hasData(d.difficulty)) {
    chart('ch-diff', {
      type: 'bar',
      data: {
        labels: d.difficulty.map(x => x.difficulty),
        datasets: [{
          label: 'Accuracy',
          data: d.difficulty.map(x => x.accuracy),
          backgroundColor: d.difficulty.map(x =>
            x.difficulty === 'Easy' ? cssVar('--green-600')
              : x.difficulty === 'Medium' ? cssVar('--amber') : cssVar('--red')),
          borderRadius: 5
        }]
      },
      options: baseOpts({ y: { max: 100, ticks: { callback: v => v + '%' } } }, false)
    });
  }
}


/* ── Wrong-answer review sheet ──────────────────────────────────────
   Only completed tests reach here — the server refuses in-progress
   sessions, because showing a parent an unanswered question hands the
   student the paper before the exam. */

let sheetState = { sessionId: null, wrongOnly: false };

async function openReview(sessionId) {
  sheetState = { sessionId, wrongOnly: false };
  $('pt-sheet').classList.remove('hidden');
  $('pt-sheet-body').innerHTML = skeleton(3);
  history.pushState({ sheet: true }, '');
  await loadReview();
}

function closeSheet() {
  $('pt-sheet').classList.add('hidden');
  if (history.state?.sheet) history.back();
}

async function toggleWrongOnly(on) {
  sheetState.wrongOnly = on;
  await loadReview();
}

async function loadReview() {
  const c = activeChild();
  const q = sheetState.wrongOnly ? '?wrong=1' : '';
  try {
    const d = await apiCall(
      `/api/parent/child/${c.uid}/test/${sheetState.sessionId}/review${q}`);

    $('pt-sheet-title').textContent =
      `${d.chapter_name} · Test ${d.test_num} · ${Math.round(d.percentage)}%`;

    $('pt-sheet-body').innerHTML = `
          <div class="pt-seg">
            <button class="${!sheetState.wrongOnly ? 'on' : ''}" onclick="toggleWrongOnly(false)">
              All ${d.total_questions}
            </button>
            <button class="${sheetState.wrongOnly ? 'on' : ''}" onclick="toggleWrongOnly(true)">
              Only mistakes
            </button>
          </div>
          ${d.questions.length
        ? d.questions.map(questionHTML).join('')
        : emptyState('fa-circle-check', 'No mistakes', 'Every question was answered correctly.')}`;
  } catch (e) {
    $('pt-sheet-body').innerHTML = emptyState('fa-lock', "Can't show this test",
      e.message || 'This test is not available for review.');
  }
}

function questionHTML(q) {
  const cls = !q.attempted ? 'skipped' : q.is_correct ? 'correct' : 'wrong';
  const tag = !q.attempted ? '<span class="pt-chip-sm neutral">Skipped</span>'
    : q.is_correct ? '<span class="pt-chip-sm pass">Correct</span>'
      : '<span class="pt-chip-sm fail">Wrong</span>';

  // options_detail carries the full option dict from the question bank:
  // id, text, is_correct, and why_wrong_explanation. That last field is
  // the single most useful thing on this screen — it says why the answer
  // the student picked was tempting, which is the actual conversation.
  const opts = (q.options || []).map(o => {
    const id = o.id || o.option_id || '';
    const text = o.text || o.option_text || '';
    const isRight = o.is_correct === true || id === q.correct_answer;
    const isChosen = id === q.student_answer;
    let k = '', t = '';
    if (isRight) { k = 'is-correct'; t = '<span class="pt-opt-tag" style="color:var(--green-600)">Correct</span>'; }
    if (isChosen && !isRight) { k = 'is-chosen-wrong'; t = '<span class="pt-opt-tag" style="color:var(--red)">Chose this</span>'; }

    const why = (isChosen && !isRight && o.why_wrong_explanation)
      ? `<div class="pt-opt-why">${safeHtml(o.why_wrong_explanation)}</div>` : '';

    return `<div class="pt-opt ${k}">
            <span class="pt-opt-id">${esc(id)}</span>
            <span>${safeHtml(text)}${why}</span>${t}
        </div>`;
  }).join('');

  return `
    <div class="pt-q ${cls}">
      <div class="pt-q-head">
        <span class="pt-q-num">Q${q.index}</span>
        ${q.difficulty ? `<span class="pt-chip-sm neutral">${esc(q.difficulty)}</span>` : ''}
        <span style="margin-left:auto">${tag}</span>
      </div>
      <div class="pt-q-text">${safeHtml(q.question_text)}</div>
      ${q.has_image && q.image_url ? `<img src="${esc(q.image_url)}" alt=""
            style="margin-top:10px;border-radius:9px;width:100%">` : ''}
      ${opts}
      ${q.explanation ? `<div class="pt-expl"><b>Why</b>${safeHtml(q.explanation)}</div>` : ''}
      ${hasData(q.common_mistakes) ? `<div class="pt-mist">
          <b>Common mistakes</b>
          <ul>${q.common_mistakes.map(m => `<li>${safeHtml(m)}</li>`).join('')}</ul>
        </div>` : ''}
      ${q.ncert_page_quote ? `<div class="pt-ncert">${safeHtml(q.ncert_page_quote)}</div>` : ''}
    </div>`;
}


/* ════════════════════════════════════════════════════════════════
   SCREEN 4 · INSIGHTS + READINESS
   ════════════════════════════════════════════════════════════════ */

function renderInsights(d) {
  const r = d.readiness;
  const sd = d.status_distribution;
  const anyConcepts = d.strengths.length || d.weaknesses.length;

  $('pt-insights-body').innerHTML = `
      ${anyConcepts ? `
      <div class="pt-sec">
        <div class="pt-sec-title">Strongest concepts</div>
        <div class="pt-sec-sub">Where understanding is solid.</div>
        ${d.strengths.map(c => concBar(c, cssVar('--green-600'))).join('')
      || emptyState('fa-seedling', 'Too early to say', '')}
      </div>

      <div class="pt-sec">
        <div class="pt-sec-title">Weakest concepts</div>
        <div class="pt-sec-sub">Where a conversation, or a teacher, would help most.</div>
        ${d.weaknesses.map(c => concBar(c, cssVar('--red'))).join('')}
      </div>` : `<div class="pt-sec">${emptyState('fa-brain', 'No concept data yet',
        'Concept strengths appear after the first few tests.')}</div>`}

      ${d.stuck_concepts.length ? `<div class="pt-sec">
        <div class="pt-sec-title">Stuck on these</div>
        <div class="pt-sec-sub">Missed repeatedly. The app has already flagged them for review.</div>
        ${d.stuck_concepts.map(c => `
          <div class="pt-row" style="cursor:default">
            <div class="pt-row-main">
              <div class="pt-row-t">${esc(c.concept_name)}</div>
              <div class="pt-row-s">${esc(c.chapter_name)} · missed ${c.failures} times in a row</div>
            </div>
            <div class="pt-row-r"><div class="pt-pct">${Math.round(c.mastery)}%</div></div>
          </div>`).join('')}
      </div>` : ''}

      ${(sd.mastered + sd.learning + sd.struggling) ? `<div class="pt-sec">
        <div class="pt-sec-title">Where every concept stands</div>
        <div class="pt-sec-sub"></div>
        <div class="pt-chart" style="height:170px"><canvas id="ch-status"></canvas></div>
      </div>` : ''}

      ${d.improvement.length ? `<div class="pt-sec">
        <div class="pt-sec-title">Improvement over time</div>
        <div class="pt-sec-sub">The five concepts that changed most, test by test.</div>
        <div class="pt-chart tall"><canvas id="ch-improve"></canvas></div>
      </div>` : ''}

      ${d.radar.some(x => x.mastery > 0) ? `<div class="pt-sec">
        <div class="pt-sec-title">Subject balance</div>
        <div class="pt-sec-sub">A lopsided shape is the most useful thing on this screen.</div>
        <div class="pt-chart tall"><canvas id="ch-radar"></canvas></div>
      </div>` : ''}

      <div class="pt-label">NEET readiness</div>

      <div class="pt-sec">
        <div class="pt-sec-title">Predicted rank</div>
        <div class="pt-sec-sub">
          ${r.papers_attempted
      ? `Based on ${r.papers_attempted} of ${r.papers_total} full papers.
               A prediction from few papers is a rough one.`
      : 'No full mock papers attempted yet.'}
        </div>
        ${r.latest ? `
          <div class="pt-tiles">
            <div class="pt-tile">
              <div class="pt-tile-v">${r.latest.total_marks}</div>
              <div class="pt-tile-k">Last score</div>
            </div>
            <div class="pt-tile">
              <div class="pt-tile-v">${r.best_air ? r.best_air.toLocaleString('en-IN') : '—'}</div>
              <div class="pt-tile-k">Best AIR</div>
            </div>
            <div class="pt-tile">
              <div class="pt-tile-v">${r.days_to_neet ?? '—'}</div>
              <div class="pt-tile-k">Days to NEET</div>
            </div>
          </div>
          ${r.target_score ? `
            <div style="margin-top:18px">
              <div class="pt-cov-top">
                <b>Against the ${r.target_score} target</b>
                <span>${r.latest.total_marks} / 720</span>
              </div>
              <div class="pt-bar" style="background:var(--s200);position:relative">
                <i style="width:${r.latest.total_marks / 720 * 100}%"></i>
                <span style="position:absolute;top:-3px;bottom:-3px;
                             left:${r.target_score / 720 * 100}%;width:2px;background:var(--s900)"></span>
              </div>
              <div class="pt-sec-sub" style="margin-top:8px">
                The vertical mark is the target score.
              </div>
            </div>` : ''}
          ${r.attempts.length > 1 ? '<div class="pt-chart" style="margin-top:16px"><canvas id="ch-mock"></canvas></div>' : ''}
        ` : emptyState('fa-flag-checkered', 'No mock papers yet',
        'Full-paper attempts unlock the rank prediction.')}
      </div>

      ${d.interventions.length ? `<div class="pt-sec">
        <div class="pt-sec-title">Where the app stepped in</div>
        <div class="pt-sec-sub">Concepts NAADI flagged and re-taught automatically.</div>
        ${d.interventions.map(i => `
          <div class="pt-feed-row">
            <div class="pt-feed-ico"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
            <div style="min-width:0">
              <div class="pt-feed-t">${esc(i.concept_name || i.concept_id)}</div>
              <div class="pt-feed-s">${esc(i.chapter_name)}</div>
            </div>
          </div>`).join('')}
      </div>` : ''}`;

  // ── charts
  if (sd.mastered + sd.learning + sd.struggling) {
    chart('ch-status', {
      type: 'doughnut',
      data: {
        labels: ['Mastered', 'Learning', 'Struggling', 'Not started'],
        datasets: [{
          data: [sd.mastered, sd.learning, sd.struggling, sd.not_started],
          backgroundColor: [cssVar('--green-600'), cssVar('--g400'),
          cssVar('--red'), cssVar('--s200')],
          borderWidth: 0
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '64%',
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } }
      }
    });
  }

  if (d.improvement.length) {
    // Five lines is the ceiling. Six is spaghetti.
    const top = d.improvement.slice(0, 5);
    const palette = [cssVar('--g500'), cssVar('--green-600'), cssVar('--amber'),
    cssVar('--purple'), cssVar('--red')];
    const maxLen = Math.max(...top.map(s => s.points.length));
    chart('ch-improve', {
      type: 'line',
      data: {
        labels: Array.from({ length: maxLen }, (_, i) => `Test ${i + 1}`),
        datasets: top.map((s, i) => ({
          label: s.concept_name,
          data: s.points.map(p => p.mastery),
          borderColor: palette[i],
          backgroundColor: palette[i],
          tension: .3, pointRadius: 2.5, fill: false, borderWidth: 2
        }))
      },
      options: {
        ...baseOpts({ y: { max: 100, ticks: { callback: v => v + '%' } } }),
        plugins: {
          legend: {
            position: 'bottom',
            labels: { boxWidth: 9, font: { size: 10 }, padding: 8 }
          }
        }
      }
    });
  }

  if (d.radar.some(x => x.mastery > 0)) {
    chart('ch-radar', {
      type: 'radar',
      data: {
        labels: d.radar.map(x => x.subject),
        datasets: [{
          label: 'Mastery',
          data: d.radar.map(x => x.mastery),
          borderColor: cssVar('--g500'),
          backgroundColor: 'rgba(47,108,179,.16)',
          pointBackgroundColor: cssVar('--g600')
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          r: {
            min: 0, max: 100, ticks: { stepSize: 25, font: { size: 9 } },
            pointLabels: { font: { size: 11 } }
          }
        },
        plugins: { legend: { display: false } }
      }
    });
  }

  if (r.attempts && r.attempts.length > 1) {
    chart('ch-mock', {
      type: 'line',
      data: {
        labels: r.attempts.map((a, i) => a.label || `Paper ${i + 1}`),
        datasets: [{
          label: 'Marks',
          data: r.attempts.map(a => a.total_marks),
          borderColor: cssVar('--purple'),
          backgroundColor: 'rgba(21,94,99,.12)',
          fill: true, tension: .3, pointRadius: 3
        }]
      },
      options: baseOpts({ y: { max: 720 } }, false)
    });
  }
}

function concBar(c, color) {
  return `<div class="pt-conc">
        <div class="pt-conc-n" title="${esc(c.chapter_name)}">${esc(c.concept_name)}</div>
        <div class="pt-conc-bar"><i style="width:${c.mastery}%;background:${color}"></i></div>
        <div class="pt-conc-v">${Math.round(c.mastery)}%</div>
    </div>`;
}


/* ════════════════════════════════════════════════════════════════
   SCREEN 5 · PROFILE
   ════════════════════════════════════════════════════════════════ */

async function renderProfile() {
  const body = $('pt-profile-body');
  body.innerHTML = skeleton(2);

  let teachers = { teachers: [] };
  const c = activeChild();
  if (c && !c.consent_revoked) {
    try { teachers = await apiCall(`/api/parent/child/${c.uid}/teacher`); } catch (e) { /* optional */ }
  }

  body.innerHTML = `
      <div class="pt-sec">
        <div class="pt-sec-title">${esc(PT.me.name)}</div>
        <div class="pt-sec-sub">${esc(PT.me.email)}</div>
        <button class="pt-btn ghost" style="padding:0;margin-top:4px"
                onclick="resetPassword()">Change password</button>
      </div>

      <div class="pt-sec">
        <div class="pt-sec-title">Children</div>
        <div class="pt-sec-sub">Linked from the invites you accepted.</div>
        ${PT.children.map(ch => `
          <div class="pt-feed-row">
            ${avatarHTML(ch.photo_url, ch.initials).replace('pt-avatar', 'pt-feed-ico')
      .replace('<img', '<img style="width:100%;height:100%;object-fit:cover;border-radius:9px"')}
            <div style="min-width:0">
              <div class="pt-feed-t">${esc(ch.name)}</div>
              <div class="pt-feed-s">${ch.consent_revoked
      ? 'Access turned off by student'
      : esc([ch.school_id, ch.class_id].filter(Boolean).join(' · ') || 'No class')}</div>
            </div>
          </div>`).join('')}
      </div>

      ${teachers.teachers.length ? `<div class="pt-sec">
        <div class="pt-sec-title">Class teacher</div>
        <div class="pt-sec-sub">${esc(teachers.school_name || '')}</div>
        ${teachers.teachers.map(t => `
          <div class="pt-feed-row">
            <div class="pt-feed-ico"><i class="fa-solid fa-chalkboard-user"></i></div>
            <div style="min-width:0">
              <div class="pt-feed-t">${esc(t.name)}</div>
              <div class="pt-feed-s">${esc(t.email)}</div>
            </div>
            <a class="pt-feed-when" href="mailto:${esc(t.email)}"
               style="color:var(--g600);font-weight:700">Email</a>
          </div>`).join('')}
      </div>` : ''}

      <div class="pt-sec">
        <div class="pt-sec-title">Notifications</div>
        <div class="pt-sec-sub">We'll never email more than once a week unless something needs you.</div>
        <div class="pt-prof-row">
          <div>
            <div class="pt-prof-t">Weekly digest</div>
            <div class="pt-prof-s">A Sunday summary: tests, accuracy, one weakness, one win.</div>
          </div>
          <label class="pt-switch">
            <input type="checkbox" id="sw-digest" ${PT.me.notify_weekly_digest ? 'checked' : ''}
                   onchange="savePrefs()">
            <span></span>
          </label>
        </div>
        <div class="pt-prof-row">
          <div>
            <div class="pt-prof-t">Alerts</div>
            <div class="pt-prof-s">Only when something changes: a week of inactivity, a sharp drop.</div>
          </div>
          <label class="pt-switch">
            <input type="checkbox" id="sw-alerts" ${PT.me.notify_alerts ? 'checked' : ''}
                   onchange="savePrefs()">
            <span></span>
          </label>
        </div>
      </div>

      <div class="pt-sec">
        <div class="pt-sec-title">About what you can see</div>
        <div class="pt-sec-sub" style="margin:0">
          This portal is read-only. Nothing you do here changes your child's tests,
          answers, or progress. Your child can turn off your access at any time from
          their own Profile screen, and we will tell you if they do.
        </div>
      </div>

      <div style="text-align:center;padding:22px">
        <button class="pt-btn ghost" onclick="portalLogout()">Log out</button>
      </div>`;
}

async function savePrefs() {
  try {
    await apiCall('/api/parent/preferences', 'POST', {
      notify_weekly_digest: $('sw-digest').checked,
      notify_alerts: $('sw-alerts').checked,
    });
    PT.me.notify_weekly_digest = $('sw-digest').checked;
    PT.me.notify_alerts = $('sw-alerts').checked;
    ndToast('Saved', 'success');
  } catch (e) {
    ndToast(e.message || 'Could not save', 'error');
  }
}

function resetPassword() {
  auth.sendPasswordResetEmail(PT.me.email)
    .then(() => ndToast('Password reset link sent to your email', 'success'))
    .catch(e => ndToast(e.message, 'error'));
}


/* ════════════════════════════════════════════════════════════════
   CHART PLUMBING
   ════════════════════════════════════════════════════════════════ */

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function htmlToNode(html) {
  const t = document.createElement('div');
  t.innerHTML = html;
  return t.firstElementChild;
}

function baseOpts(scales, legend = true) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: { grid: { display: false }, ticks: { font: { size: 10 } } },
      y: {
        beginAtZero: true, grid: { color: 'rgba(148,163,184,.16)' },
        ticks: { font: { size: 10 } }, ...(scales.y || {})
      },
    },
    plugins: {
      legend: legend
        ? { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } }
        : { display: false }
    },
  };
}

// The pass line is the single most important reference on the score chart.
// Chart.js has no built-in annotation without a plugin, so: draw it.
function passLine(threshold) {
  return {
    id: 'passline',
    afterDatasetsDraw(c) {
      const { ctx, chartArea, scales } = c;
      const y = scales.y.getPixelForValue(threshold);
      ctx.save();
      ctx.strokeStyle = cssVar('--red');
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(chartArea.left, y);
      ctx.lineTo(chartArea.right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = cssVar('--red');
      ctx.font = '600 9px DM Sans, sans-serif';
      ctx.fillText(`${threshold}% pass`, chartArea.left + 4, y - 4);
      ctx.restore();
    }
  };
}

function chart(id, cfg, plugins) {
  const el = $(id);
  if (!el) return;
  if (PT.charts[id]) PT.charts[id].destroy();
  if (cfg.plugins) { plugins = cfg.plugins; delete cfg.plugins; }
  PT.charts[id] = new Chart(el, plugins ? { ...cfg, plugins } : cfg);
}

function destroyCharts() {
  Object.values(PT.charts).forEach(c => { try { c.destroy(); } catch (e) { } });
  PT.charts = {};
}


/* ════════════════════════════════════════════════════════════════
   ANDROID BACK BUTTON
   Closes the sheet, then walks home, then leaves. Same pattern as
   onboarding.js — a hardware back that exits the app from the Tests
   tab feels broken.
   ════════════════════════════════════════════════════════════════ */

window.addEventListener('popstate', () => {
  if (!$('pt-sheet').classList.contains('hidden')) {
    $('pt-sheet').classList.add('hidden');
    return;
  }
  const first = PT.tabs[0]?.id || 'home';
  if (PT.tab !== first) {
    goTab(first);
    history.pushState({ tab: first }, '');
  }
});
history.replaceState({ tab: 'home' }, '');