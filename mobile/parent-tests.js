/* ════════════════════════════════════════════════════════════════
   NAADI AI — PARENT TESTS  (parent-tests.js)
   ─────────────────────────────────────────────────────────────────
   Loads AFTER portal.js and takes over the Tests tab only. Deleting
   this file restores the old tab exactly.

   WHAT THIS TAB IS FOR

       Home      is this going all right this week?
       Learning  where are they in the syllabus?
       Tests     how did the tests go, and what did they get wrong?

   This tab owns the ANSWERS. It is the only place a parent can open
   an actual question their child missed and read why the option
   they picked looked right — which is a far more useful thing to
   discuss than the correct answer on its own.

   ─────────────────────────────────────────────────────────────────
   THREE LEVELS, IN PLACE

       1  overview   papers grouped, chapters as folders
       2  chapter    every test in one chapter
       3  test       every question in one test

   In place with a back button, not a bottom sheet. The sheet was
   fine on a phone and wrong on a laptop, where question review is
   long content that wants the whole page. One pattern on both.

   ─────────────────────────────────────────────────────────────────
   WHAT IS NOT HERE

   No phase names — the server translates them. No chart mixing
   chapter percentages with paper marks; they are different units
   and a line through both means nothing. No lifetime doughnut:
   skipped and wrong are separate sentences, because under negative
   marking they are opposite problems.
   ════════════════════════════════════════════════════════════════ */

const PAT = {
    view: 'list',      // list | chapter | test
    data: null,
    chapter: null,
    test: null,
    reqId: 0,          // guards a slow response painting over a fast one
    show: 'wrong',
    openGroups: new Set(),
    openQ: new Set(),
    from: 'list',
    open: {},          // info panel id -> bool
};

const patPct = v => (v == null || isNaN(v)) ? '—' : `${Math.round(v)}%`;

function patN(n, one, many) {
    n = Number(n) || 0;
    return `${n} ${n === 1 ? one : (many || one + 's')}`;
}

function patSubjClass(s) {
    const k = String(s || '').toLowerCase();
    if (k.startsWith('bio')) return 'bio';
    if (k.startsWith('phy')) return 'phy';
    if (k.startsWith('chem')) return 'chem';
    return 'other';
}

const patDay = at => (at || '').slice(0, 10);

/* Question text really does contain (CH<sub>3</sub>)<sub>2</sub> and
   &ndash;. portal.js already ships safeHtml for exactly this, so it is
   reused rather than a fourth copy of the same decode-then-neutralise
   dance being written here. */
const patQ = v => (typeof safeHtml === 'function')
    ? safeHtml((v && typeof v === 'object') ? (v.t || '') : (v || ''))
    : esc((v && typeof v === 'object') ? (v.t || '') : (v || ''));

/* ── the (i) affordance, same contract as Home and Learning ─────── */

function patInfoBtn(id) {
    return `<button class="pat-i" aria-label="What does this mean?"
      aria-expanded="${PAT.open[id] ? 'true' : 'false'}"
      onclick="patToggleInfo('${id}')"><i class="fa-solid fa-info"></i></button>`;
}

function patInfoPanel(id, text) {
    if (!text) return '';
    return `<div class="pat-info ${PAT.open[id] ? '' : 'hidden'}" id="tinfo-${id}">
      <div class="pat-info-h">What this means</div>
      <p>${esc(text)}</p>
    </div>`;
}

function patToggleInfo(id) {
    PAT.open[id] = !PAT.open[id];
    const p = document.getElementById(`tinfo-${id}`);
    if (p) p.classList.toggle('hidden', !PAT.open[id]);
    document.querySelectorAll(`.pat-i[onclick*="'${id}'"]`)
        .forEach(b => b.setAttribute('aria-expanded', PAT.open[id] ? 'true' : 'false'));
}

function patHead(id, title, sub, info) {
    return `
    <div class="pat-sec-head">
      <div class="pat-sec-t">
        <div class="pt-sec-title">${esc(title)}</div>
        ${sub ? `<div class="pt-sec-sub">${esc(sub)}</div>` : ''}
      </div>
      ${patInfoBtn(id)}
    </div>
    ${patInfoPanel(id, info)}`;
}


/* ════════════════════════════════════════════════════════════════
   ENTRY
   ════════════════════════════════════════════════════════════════ */

async function renderParentTestsV2() {
    const body = $('pt-tests-body');
    const c = activeChild();
    if (!c) return;

    if (c.consent_revoked) {
        body.innerHTML = emptyState('fa-lock', 'Access turned off',
            `${(c.name || '').split(' ')[0]} has turned off parent access.`);
        return;
    }

    body.classList.add('pat-root');

    const key = `${c.uid}:tests2`;
    if (!PT.cache[key]) {
        body.innerHTML = skeleton(3);
        try {
            PT.cache[key] = await apiCall(`/api/parent/v2/child/${c.uid}/tests`);
        } catch (e) {
            body.innerHTML = emptyState('fa-triangle-exclamation', "Couldn't load this",
                e.message || 'Please try again in a moment.');
            return;
        }
    }

    PAT.data = PT.cache[key];
    patPaint();
}

function patPaint() {
    $('pt-tests-body').innerHTML =
        PAT.view === 'test' ? patTestView()
            : PAT.view === 'chapter' ? patChapterView()
                : patList();
}


/* ════════════════════════════════════════════════════════════════
   LEVEL 1 · THE OVERVIEW
   ════════════════════════════════════════════════════════════════ */

function patList() {
    const d = PAT.data;
    if (!d) return skeleton(3);

    const p = d.papers || {}, ch = d.chapters || {}, cu = d.customs || {};
    if (!(p.count || ch.count || cu.count)) {
        return emptyState('fa-clipboard-list', 'No tests yet',
            'Nothing has been submitted, so there is nothing to look at here.');
    }

    /* ORDER
       Chapter tests are the weekly work and the thing a parent checks
       most, so they lead. Full papers are milestones. Practice sets are
       the student's own extra work and sit last. */
    return `
    ${d.capped ? `<p class="pat-note">Showing the most recent
       ${d.scanned_limit} tests.</p>` : ''}
    ${patSummary(d.summary || {}, d.child || {})}
    ${patFolders(ch)}
    ${patPapers(p, 'papers', 'Full NEET papers',
        patN(p.count, 'paper') + ' out of 720')}
    ${patPapers(cu, 'customs', 'Practice sets they built themselves',
            patN(cu.count, 'set'))}`;
}


/* ── the summary strip ─────────────────────────────────────────────
   Two sentences that live nowhere else. The old tab put the same
   facts in a doughnut, which made a parent do the reading; the
   reading is the whole value. */

function patSummary(s, child) {
    if (!s.tests) return '';
    return `
    <div class="pt-sec pat-sec">
      ${patHead('summary', 'How the tests are going', '', s.info)}
      <div class="pat-strip">
        <div class="pat-stat">
          <b>${s.tests}</b><span>chapter tests taken</span>
        </div>
        <div class="pat-stat">
          <b>${patPct(s.average)}</b><span>average across them</span>
        </div>
        <div class="pat-stat">
          <b>${s.wrong}</b><span>answered wrong</span>
        </div>
        <div class="pat-stat">
          <b>${s.skipped}</b><span>left blank</span>
        </div>
      </div>
      ${s.blank_line ? `<p class="pat-line">${esc(s.blank_line)}</p>` : ''}
      ${s.difficulty_line ? `<p class="pat-line">${esc(s.difficulty_line)}</p>` : ''}
      ${(s.difficulty || []).length ? `
        <div class="pat-bands">
          ${s.difficulty.map(b => `
            <div class="pat-band">
              <span class="pat-band-k">${esc(b.level)}</span>
              <div class="pat-band-bar">
                <i style="width:${Math.max(0, Math.min(100, b.accuracy || 0)).toFixed(1)}%"></i>
              </div>
              <span class="pat-band-v">${b.ready ? patPct(b.accuracy)
            : `<em>${b.asked} asked</em>`}</span>
            </div>`).join('')}
        </div>` : ''}
    </div>`;
}


/* ── full papers and practice sets ─────────────────────────────────
   Grouped by paper with the best attempt on top and the rest
   collapsed, exactly as the student's own Arena history and the
   teacher's view organise the same attempts. Practice sets the
   student built themselves are folded in here with a tag rather
   than given a third heading — to a parent, a separate section for
   them was more confusing than useful. */

function patPapers(p, id, title, sub) {
    const groups = p.groups || [];
    if (!groups.length) return '';
    return `
    <div class="pt-sec pat-sec">
      ${patHead(id, title, sub, p.info)}
      ${groups.map((g, i) => patGroup(g, id + i)).join('')}
    </div>`;
}


function patGroup(g, gid) {
    const open = PAT.openGroups.has(gid);
    const b = g.best || {};
    return `
    <div class="pat-group">
      <button class="pat-paper best" onclick="patOpenTest('${esc(b.id)}')">
        <div class="pat-paper-m">
          <b>${b.marks == null ? '—' : b.marks}<small>/${b.max || 720}</small></b>
        </div>
        <div class="pat-paper-t">
          <b>${esc(g.label)}
            ${g.attempts > 1 ? `<span class="pat-bestof">best of ${g.attempts}</span>` : ''}
          </b>
          <span>${esc(patDay(b.at))}${g.paper_code ? ` · paper ${esc(g.paper_code)}` : ''}${b.minutes ? ` · ${b.minutes} min` : ''}</span>
        </div>
        ${(b.subjects || []).length ? `
          <div class="pat-sm">
            ${b.subjects.map(s => `<span><b>${s.marks == null ? '—' : s.marks}</b>/${s.max} ${esc(s.subject)}</span>`).join('')}
          </div>` : ''}
        <i class="fa-solid fa-chevron-right pat-go"></i>
      </button>

      ${(g.others || []).length ? `
        <button class="pat-more ${open ? 'on' : ''}" onclick="patToggleGroup('${gid}')">
          <span>${open ? 'Hide' : 'Show'} ${patN(g.others.length, 'earlier attempt')}</span>
          ${g.change != null ? `<em class="${g.change >= 0 ? 'up' : 'down'}">
            ${g.change >= 0 ? '+' : ''}${g.change} marks since the first try</em>` : ''}
          <i class="fa-solid fa-chevron-${open ? 'up' : 'down'}"></i>
        </button>
        ${open ? `<div class="pat-others">
          ${g.others.map(o => `
            <button class="pat-paper sub" onclick="patOpenTest('${esc(o.id)}')">
              <div class="pat-paper-m">
                <b>${o.marks == null ? '—' : o.marks}<small>/${o.max || 720}</small></b>
              </div>
              <div class="pat-paper-t">
                <span>${esc(patDay(o.at))}${o.minutes ? ` · ${o.minutes} min` : ''}</span>
              </div>
              <i class="fa-solid fa-chevron-right pat-go"></i>
            </button>`).join('')}
        </div>` : ''}` : ''}
    </div>`;
}

function patToggleGroup(gid) {
    PAT.openGroups.has(gid) ? PAT.openGroups.delete(gid) : PAT.openGroups.add(gid);
    patPaint();
}


/* ── chapter folders ───────────────────────────────────────────────
   A hundred rows become fifteen. The old tab listed every test in
   one column, newest first, with no way to see a chapter whole. */

function patFolders(ch) {
    const groups = ch.groups || [];
    if (!groups.length) return '';
    return `
    <div class="pt-sec pat-sec">
      ${patHead('folders', 'Chapter tests',
        `${patN(ch.count, 'test')} across ${patN(ch.chapters, 'chapter')}`,
        ch.info)}
      ${groups.map(g => `
        <div class="pat-fgroup">
          <div class="pat-fgroup-h">
            <span class="pat-tag ${patSubjClass(g.subject)}">${esc(g.subject)}</span>
            <b>${esc(g.label)}</b>
            ${g.is_own_year ? '<em>this year</em>' : ''}
            <span class="pat-fgroup-n">${patN(g.count, 'test')}</span>
          </div>
          <div class="pat-folders">
            ${(g.folders || []).map(x => `
              <button class="pat-folder" onclick="patOpenChapter('${esc(x.chapter_id)}')">
                <div class="pat-folder-t">
                  <b>${esc(x.chapter)}</b>
                  <span>${patN(x.tests, 'test')}${x.retakes ? ` · ${x.retakes} retaken` : ''}</span>
                  ${x.stage ? `<em>${esc(x.stage)}</em>` : ''}
                </div>
                <div class="pat-folder-n">
                  <b>${patPct(x.average)}</b><span>average</span>
                </div>
                <i class="fa-solid fa-chevron-right pat-go"></i>
              </button>`).join('')}
          </div>
        </div>`).join('')}
    </div>`;
}


/* ════════════════════════════════════════════════════════════════
   LEVEL 2 · ONE CHAPTER
   ════════════════════════════════════════════════════════════════ */

async function patOpenChapter(cid) {
    const c = activeChild();
    if (!c) return;
    PAT.view = 'chapter';
    PAT.chapter = null;
    patPaint();

    const my = ++PAT.reqId;
    try {
        const d = await apiCall(
            `/api/parent/v2/child/${c.uid}/chapter/${encodeURIComponent(cid)}/tests`);
        if (my !== PAT.reqId) return;    // a later tap won
        PAT.chapter = d;
    } catch (e) {
        if (my !== PAT.reqId) return;
        PAT.chapter = { error: e.message || 'Could not load that chapter.' };
    }
    patPaint();
}

function patChapterView() {
    const c = PAT.chapter;
    const back = `<button class="pat-back" onclick="patBack('list')">
      <i class="fa-solid fa-arrow-left"></i> All tests</button>`;
    if (!c) return back + skeleton(3);
    if (c.error) return back + emptyState('fa-triangle-exclamation',
        "Couldn't load that chapter", esc(c.error));

    const sub = [
        patN(c.count, 'test'),
        c.average != null ? `${Math.round(c.average)}% average` : '',
        c.retakes ? `${c.retakes} retaken` : '',
    ].filter(Boolean).join(' · ');

    return `${back}
    <div class="pt-sec pat-sec">
      ${patHead('chapter', c.chapter || 'Chapter', sub, c.info)}
      <div class="pat-tests">
        ${(c.tests || []).map(t => `
          <button class="pat-test" onclick="patOpenTest('${esc(t.id)}', 'chapter')">
            <div class="pat-test-t">
              <b>Test ${t.test_num == null ? '—' : t.test_num}</b>
              ${t.is_retake ? '<span class="pat-tag retake">retake</span>' : ''}
              <span>${t.right} of ${t.questions} right${t.skipped ? ` · ${t.skipped} left blank` : ''}${t.minutes ? ` · ${t.minutes} min` : ''}</span>
              ${t.stage ? `<em>${esc(t.stage)}</em>` : ''}
            </div>
            <div class="pat-test-n">
              <b class="${t.passed === false ? 'low' : ''}">${patPct(t.pct)}</b>
              <span>${esc(patDay(t.at))}</span>
            </div>
            <i class="fa-solid fa-chevron-right pat-go"></i>
          </button>`).join('')}
      </div>
    </div>`;
}


/* ════════════════════════════════════════════════════════════════
   LEVEL 3 · ONE TEST IN FULL
   ════════════════════════════════════════════════════════════════ */

async function patOpenTest(sid, from, show) {
    const c = activeChild();
    if (!c) return;
    if (from) PAT.from = from;
    if (show) PAT.show = show;
    PAT.view = 'test';
    PAT.test = null;
    PAT.openQ = new Set();
    patPaint();

    const my = ++PAT.reqId;
    try {
        const d = await apiCall(`/api/parent/v2/child/${c.uid}` +
            `/test/${encodeURIComponent(sid)}?show=${PAT.show}`);
        if (my !== PAT.reqId) return;
        PAT.test = d;
    } catch (e) {
        if (my !== PAT.reqId) return;
        PAT.test = { error: e.message || 'Could not load that test.' };
    }
    patPaint();
}

function patSetShow(v) {
    PAT.show = v;
    if (PAT.test && PAT.test.id) patOpenTest(PAT.test.id, null, v);
}

function patBack(to) {
    PAT.view = to;
    if (to === 'list') PAT.chapter = null;
    PAT.test = null;
    patPaint();
}

function patTestView() {
    const t = PAT.test;
    const back = `<button class="pat-back" onclick="patBack('${PAT.from || 'list'}')">
      <i class="fa-solid fa-arrow-left"></i> Back</button>`;
    if (!t) return back + skeleton(4);
    if (t.error) return back + emptyState('fa-triangle-exclamation',
        "Couldn't load that test", esc(t.error));

    const h = t.head || {};
    const isPaper = t.kind === 'paper';
    const title = isPaper ? (h.label || 'Full paper')
        : `Test ${h.test_num == null ? '' : h.test_num} · ${h.chapter || ''}`;
    const cn = h.counts || {};

    return `${back}
    <div class="pt-sec pat-sec">
      <div class="pat-thead">
        <div class="pat-thead-t">
          <h3>${esc(title)}</h3>
          <span>${esc(patDay(h.at))}${h.is_retake ? ' · retake' : ''}${h.minutes ? ` · ${h.minutes} min` : ''}</span>
          ${h.stage ? `<em>${esc(h.stage)}</em>` : ''}
        </div>
        <div class="pat-thead-n">
          ${isPaper
            ? `<b>${h.marks == null ? '—' : h.marks}<small>/${h.max || 720}</small></b>`
            : `<b>${patPct(h.pct)}</b>`}
        </div>
      </div>

      <div class="pat-counts">
        <span class="ok">${cn.correct == null ? '—' : cn.correct} right</span>
        <span class="bad">${cn.wrong == null ? '—' : cn.wrong} wrong</span>
        <span class="skip">${cn.skipped == null ? '—' : cn.skipped} left blank</span>
      </div>

      ${isPaper && (h.subjects || []).length ? `
        <div class="pat-sm wide">${h.subjects.map(s =>
                `<span><b>${s.marks == null ? '—' : s.marks}</b>/${s.max} ${esc(s.subject)}</span>`
            ).join('')}</div>` : ''}

      ${patHead('test', 'The questions', '', t.info)}

      <div class="pat-showtoggle">
        <button class="${t.show === 'wrong' ? 'on' : ''}"
          onclick="patSetShow('wrong')">Wrong &amp; left blank</button>
        <button class="${t.show === 'all' ? 'on' : ''}"
          onclick="patSetShow('all')">Every question</button>
        <span>${t.shown} of ${t.total}</span>
      </div>

      ${(t.questions || []).length
            ? `<div class="pat-qlist">${t.questions.map((q, i) => patQuestion(q, i, t)).join('')}</div>`
            : `<p class="pat-empty">${t.show === 'wrong'
                ? 'Nothing wrong or left blank in this test — every question was answered correctly.'
                : 'This test has no questions stored.'}</p>`}
    </div>`;
}


/* One question, collapsed to its stem. The working opens on tap.

   The single most useful thing on this screen is why_wrong_explanation:
   it says why the option that was chosen looked right, which is the
   actual conversation. The correct answer alone rarely is. */

function patQuestion(q, i, t) {
    const key = String(q.base_id || q.question_id || q.n || i);
    const open = PAT.openQ.has(key);
    const state = q.result === 'correct' ? 'ok'
        : q.result === 'skipped' ? 'skip' : 'bad';
    const icon = state === 'ok' ? 'circle-check'
        : state === 'skip' ? 'circle-minus' : 'circle-xmark';

    const opts = (q.options || []).map(o => {
        const right = String(o.id).toUpperCase() === String(q.correct || '').toUpperCase();
        const mine = String(o.id).toUpperCase() === String(q.answer || '').toUpperCase();
        const cls = ['pat-opt', right ? 'right' : '', (mine && !right) ? 'mine' : '']
            .filter(Boolean).join(' ');
        return `
      <div class="${cls}">
        <span class="pat-optl">${esc(o.id)}</span>
        <div>
          <p>${patQ(o.text)}</p>
          ${(mine && !right && o.why && o.why.t)
                ? `<em class="pat-why">${patQ(o.why)}</em>` : ''}
        </div>
        ${right ? '<i class="fa-solid fa-check"></i>' : ''}
        ${mine ? `<span class="pat-you">${right ? 'chose ✓' : 'chose this'}</span>` : ''}
      </div>`;
    }).join('');

    return `
    <div class="pat-q ${state} ${open ? 'open' : ''}">
      <button class="pat-q-head" onclick="patToggleQ('${esc(key)}')">
        <i class="fa-solid fa-${icon} pat-q-state"></i>
        <div class="pat-q-t">
          <b>Q${q.n}</b>
          <p>${patQ(q.question)}</p>
        </div>
        ${q.marks != null
            ? `<span class="pat-marks ${q.marks > 0 ? 'pos' : q.marks < 0 ? 'neg' : ''}">${q.marks > 0 ? '+' : ''}${q.marks}</span>` : ''}
        <i class="fa-solid fa-chevron-down pat-caret"></i>
      </button>

      ${open ? `
        <div class="pat-q-body">
          ${q.image ? `<img src="${esc(q.image)}" class="pat-qimg" alt="" loading="lazy">` : ''}
          ${opts ? `<div class="pat-opts">${opts}</div>` : ''}
          <div class="pat-ans">
            <span>Chose <b>${esc(q.answer || 'nothing')}</b></span>
            <span>Correct <b>${esc(q.correct || '—')}</b></span>
          </div>
          ${patLadder(q.ladder, t)}
          ${q.explanation && q.explanation.t ? `
            <div class="pat-blk exp"><h5>Why</h5><p>${patQ(q.explanation)}</p></div>` : ''}
          ${(q.mistakes || []).length ? `
            <div class="pat-blk mis"><h5>What people usually get wrong here</h5>
              <ul>${q.mistakes.map(m => `<li>${esc(m)}</li>`).join('')}</ul></div>` : ''}
          ${q.ncert && q.ncert.t ? `
            <div class="pat-blk ncert"><h5>NCERT says</h5>
              <p>${patQ(q.ncert)}</p></div>` : ''}
        </div>` : ''}
    </div>`;
}

function patToggleQ(key) {
    PAT.openQ.has(key) ? PAT.openQ.delete(key) : PAT.openQ.add(key);
    patPaint();
}


/* The same idea, each time it came back.

   This is what makes "answers slipping away" on the Home page
   something a parent can actually look at: right the first time,
   wrong when the same idea returned worded differently. */

function patLadder(steps, t) {
    if (!steps || steps.length < 2) return '';
    return `
    <div class="pat-blk ladder">
      <h5>This idea over time ${patInfoBtn('ladder')}</h5>
      ${patInfoPanel('ladder', t && t.ladder_info)}
      <div class="pat-ladder">
        ${steps.map(s => `
          <div class="pat-step ${s.result === 'correct' ? 'ok' : 'bad'}">
            <b>${s.result === 'correct' ? 'Right' : 'Wrong'}</b>
            ${s.test_num != null ? `<span>Test ${s.test_num}</span>` : ''}
          </div>`).join('<i class="fa-solid fa-arrow-right pat-steparrow"></i>')}
      </div>
    </div>`;
}


/* ════════════════════════════════════════════════════════════════
   TAKEOVER

   Wraps whatever renderParentTab currently is — parent-home.js and
   parent-learning.js have each wrapped it in turn, so all three
   tabs are handled and no file knows about the others.
   ════════════════════════════════════════════════════════════════ */

(function () {
    const orig = window.renderParentTab;
    if (typeof orig === 'function') {
        window.renderParentTab = async function (tab) {
            if (tab === 'tests') {
                // A parent leaving and returning expects the list, not the
                // question they happened to be reading twenty minutes ago.
                if (PAT.view !== 'list' && PT.tab !== 'tests') patBack('list');
                return renderParentTestsV2();
            }
            return orig(tab);
        };
    }
})();