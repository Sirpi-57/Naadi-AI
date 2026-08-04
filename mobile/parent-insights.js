/* ════════════════════════════════════════════════════════════════
   NAADI AI — PARENT INSIGHTS  (parent-insights.js)
   ─────────────────────────────────────────────────────────────────
   Loads AFTER portal.js and takes over the Insights tab only.

   WHY THIS WAS REBUILT

   The first version sliced ONE list of weak ideas three ways and put
   all three on the same screen. "Carbon Classification and Alkane
   Bonding" appeared under Slipping, again under Shakiest, and again
   under Stuck — three rows about one idea, each carrying a third of
   the story.

   So: ONE ROW PER IDEA, inside its own chapter, holding every fact
   about it at once. Nothing is listed twice anywhere on this tab.

   ─────────────────────────────────────────────────────────────────
   TWO LEVELS

       1  chapters that have actually been tested, grouped by
          subject and year, each with one true line
       2  one chapter — every idea in it, one row each

   Plus three whole-picture blocks that exist nowhere else: the paper
   trend with its three subject lines, when the studying happens, and
   whether retakes work for this particular student.

   No predicted rank. On real data the estimate ranged from 30 to
   2,100,000 across one student's own papers.
   ════════════════════════════════════════════════════════════════ */

const PIN = {
    view: 'list',    // list | chapter
    data: null,
    chapter: null,
    reqId: 0,        // guards a slow response painting over a fast one
    open: {},
    openPapers: new Set(),    // which paper's line is open
    openAttempts: new Set(),  // and which paper's full attempt list is open
};

const pinPct = v => (v == null || isNaN(v)) ? '—' : `${Math.round(v)}%`;

function pinN(n, one, many) {
    n = Number(n) || 0;
    return `${n} ${n === 1 ? one : (many || one + 's')}`;
}

function pinSubjClass(s) {
    const k = String(s || '').toLowerCase();
    if (k.startsWith('bio')) return 'bio';
    if (k.startsWith('phy')) return 'phy';
    if (k.startsWith('chem')) return 'chem';
    return 'other';
}

/* ── the (i) affordance, same contract as the other three tabs ─── */

function pinInfoBtn(id) {
    return `<button class="pin-i" aria-label="What does this mean?"
      aria-expanded="${PIN.open[id] ? 'true' : 'false'}"
      onclick="pinToggleInfo('${id}')"><i class="fa-solid fa-info"></i></button>`;
}

function pinInfoPanel(id, text) {
    if (!text) return '';
    return `<div class="pin-info ${PIN.open[id] ? '' : 'hidden'}" id="iinfo-${id}">
      <div class="pin-info-h">What this means</div>
      <p>${esc(text)}</p>
    </div>`;
}

function pinToggleInfo(id) {
    PIN.open[id] = !PIN.open[id];
    const p = document.getElementById(`iinfo-${id}`);
    if (p) p.classList.toggle('hidden', !PIN.open[id]);
    document.querySelectorAll(`.pin-i[onclick*="'${id}'"]`)
        .forEach(b => b.setAttribute('aria-expanded', PIN.open[id] ? 'true' : 'false'));
}

function pinHead(id, title, sub, info) {
    return `
    <div class="pin-sec-head">
      <div class="pin-sec-t">
        <div class="pt-sec-title">${esc(title)}</div>
        ${sub ? `<div class="pt-sec-sub">${esc(sub)}</div>` : ''}
      </div>
      ${pinInfoBtn(id)}
    </div>
    ${pinInfoPanel(id, info)}`;
}


/* ════════════════════════════════════════════════════════════════
   ENTRY
   ════════════════════════════════════════════════════════════════ */

async function renderParentInsightsV2() {
    const body = $('pt-insights-body');
    const c = activeChild();
    if (!c) return;

    if (c.consent_revoked) {
        body.innerHTML = emptyState('fa-lock', 'Access turned off',
            `${(c.name || '').split(' ')[0]} has turned off parent access.`);
        return;
    }

    body.classList.add('pin-root');

    const key = `${c.uid}:insights2`;
    if (!PT.cache[key]) {
        body.innerHTML = skeleton(3);
        try {
            PT.cache[key] = await apiCall(`/api/parent/v2/child/${c.uid}/insights`);
        } catch (e) {
            body.innerHTML = emptyState('fa-triangle-exclamation', "Couldn't load this",
                e.message || 'Please try again in a moment.');
            return;
        }
    }

    PIN.data = PT.cache[key];
    pinPaint();
}

function pinPaint() {
    $('pt-insights-body').innerHTML =
        PIN.view === 'chapter' ? pinChapterView() : pinList();
}


/* ════════════════════════════════════════════════════════════════
   LEVEL 1
   ════════════════════════════════════════════════════════════════ */

function pinList() {
    const d = PIN.data;
    if (!d) return skeleton(3);

    const ch = d.chapters || {}, p = d.papers || {};
    if (!(ch.tested || p.count)) {
        return emptyState('fa-chart-simple', 'Nothing to look at yet',
            'This fills in once a few chapter tests have been taken.');
    }

    return `
    <div class="pin-grid">
      <div class="pin-band">
        ${pinChapters(ch)}
      </div>
      <div class="pin-band">
        ${pinPapers(p)}
      </div>
      <div class="pin-band pair">
        ${pinHours(d.hours || {}, d.child || {})}
        ${pinRetakes(d.retakes || {}, d.child || {})}
      </div>
    </div>`;
}


/* ── chapters being tested ─────────────────────────────────────────
   Only chapters with tests behind them. Reading a chapter says
   nothing about the ideas inside it, so a read-but-untested chapter
   would be a card with nothing on it. */

function pinChapters(ch) {
    const groups = ch.groups || [];
    if (!groups.length) {
        return `
      <div class="pt-sec pin-sec">
        ${pinHead('chapters', 'Chapters being tested', '', ch.info)}
        ${emptyState('fa-flask', 'No chapter tested yet',
            'Ideas can only be judged once questions have been asked about them.')}
      </div>`;
    }

    return `
    <div class="pt-sec pin-sec">
      ${pinHead('chapters', 'Chapters being tested',
        `${pinN(ch.tested, 'chapter')} with tests behind them`, ch.info)}
      ${groups.map(g => `
        <div class="pin-cgroup">
          <div class="pin-cgroup-h">
            <span class="pin-tag ${pinSubjClass(g.subject)}">${esc(g.subject)}</span>
            <b>${esc(g.label)}</b>
          </div>
          <div class="pin-cards">
            ${(g.chapters || []).map(c => `
              <button class="pin-card ${esc(c.tone)}"
                onclick="pinOpenChapter('${esc(c.chapter_id)}')">
                <div class="pin-card-t">
                  <b>${esc(c.chapter)}</b>
                  <span class="pin-signal">${esc(c.signal)}</span>
                </div>
                <div class="pin-card-m">
                  ${pinN(c.tests, 'test')} · ${pinN(c.ideas, 'idea')}
                  ${c.accuracy != null ? ` · ${pinPct(c.accuracy)} right` : ''}
                  ${c.stage ? `<em class="pin-stage">${esc(c.stage)}</em>` : ''}
                </div>
                <i class="fa-solid fa-chevron-right pin-go"></i>
              </button>`).join('')}
          </div>
        </div>`).join('')}
    </div>`;
}


/* ── full NEET papers over time ────────────────────────────────────
   Marks, never a rank. The three subject lines are the point: a
   total can sit flat while one subject climbs and another falls,
   and "which subject is costing the seat" is answered nowhere else
   in the portal. */

function pinPapers(p) {
    const groups = p.groups || [];
    if (!groups.length) {
        return `
      <div class="pt-sec pin-sec">
        ${pinHead('papers', 'Full NEET papers over time', '', p.info)}
        ${emptyState('fa-file-lines', 'No full paper yet',
            'These matter most closer to the exam — chapter tests come first.')}
      </div>`;
    }

    const sub = [
        pinN(p.count, 'attempt'),
        `across ${pinN(p.papers, 'paper')}`,
        p.best != null ? `best ${p.best} of 720` : '',
    ].filter(Boolean).join(' · ');

    return `
    <div class="pt-sec pin-sec">
      ${pinHead('papers', 'Full NEET papers over time', sub, p.info)}
      ${groups.map(g => pinPaperGroup(g)).join('')}
    </div>`;
}

/* One paper, closed. Open it for the line and, inside that, a
   collapsible list of every attempt.

   The flat list this replaced ran to twenty-two rows, thirteen of them
   the same exam — so "change since the first" was measured between two
   different papers, which compares nothing. */
function pinPaperGroup(g) {
    const open = PIN.openPapers.has(g.key);
    const attemptsOpen = PIN.openAttempts.has(g.key);
    const code = g.paper_code ? ` · paper ${esc(g.paper_code)}` : '';

    return `
    <div class="pin-pgroup ${open ? 'open' : ''}">
      <button class="pin-pgroup-h" onclick="pinTogglePaper('${esc(g.key)}')"
              aria-expanded="${open ? 'true' : 'false'}">
        <div class="pin-pgroup-t">
          <b>${esc(g.title)}${code}</b>
          <span>${pinN(g.attempts, 'attempt')} · best ${g.best} of
            ${g.max || 720} · last on ${esc(g.last_day || '')}</span>
        </div>
        ${g.change != null ? `
          <span class="pin-pchange ${g.change >= 0 ? 'up' : 'down'}">
            ${g.change >= 0 ? '+' : ''}${g.change}</span>` : ''}
        <i class="fa-solid fa-chevron-down pin-caret"></i>
      </button>

      ${open ? `
        <div class="pin-pgroup-b">
          ${pinLine(g)}

          ${(g.moves || []).length ? `
            <div class="pin-moves">
              ${g.moves.map(m => `
                <div class="pin-move">
                  <span class="pin-tag ${pinSubjClass(m.subject)}">${esc(m.subject)}</span>
                  <div class="pin-move-b">
                    <b>${m.latest}</b><small>/${m.max}</small>
                    <em class="${m.change >= 0 ? 'up' : 'down'}">
                      ${m.change >= 0 ? '+' : ''}${m.change} since the first go</em>
                  </div>
                </div>`).join('')}
            </div>` : ''}

          <button class="pin-more" onclick="pinToggleAttempts('${esc(g.key)}')"
                  aria-expanded="${attemptsOpen ? 'true' : 'false'}">
            <span>${attemptsOpen ? 'Hide' : 'Show'} all
              ${pinN(g.attempts, 'attempt')}</span>
            <i class="fa-solid fa-chevron-${attemptsOpen ? 'up' : 'down'}"></i>
          </button>

          ${attemptsOpen ? `
            <div class="pin-attempts">
              ${g.points.slice().reverse().map(r => `
                <div class="pin-attempt">
                  <div class="pin-attempt-m">
                    <b>${r.marks}</b><small>/${r.max || 720}</small>
                  </div>
                  <div class="pin-attempt-t">
                    <b>${esc(r.day || '')}</b>
                    <span>${r.minutes ? `took ${pinN(r.minutes, 'minute')}`
            : 'time not recorded'}${r.is_arena ? ' · Arena' : ''}</span>
                  </div>
                  ${(r.subjects || []).length ? `
                    <div class="pin-attempt-s">
                      ${r.subjects.map(x => `
                        <span class="pin-ps ${pinSubjClass(x.subject)}">
                          ${esc(x.subject)} <b>${x.marks == null ? '—' : x.marks}</b><em>/${x.max}</em>
                        </span>`).join('')}
                    </div>` : ''}
                </div>`).join('')}
            </div>` : ''}
        </div>` : ''}
    </div>`;
}

function pinTogglePaper(key) {
    PIN.openPapers.has(key) ? PIN.openPapers.delete(key)
        : PIN.openPapers.add(key);
    pinPaint();
}

function pinToggleAttempts(key) {
    PIN.openAttempts.has(key) ? PIN.openAttempts.delete(key)
        : PIN.openAttempts.add(key);
    pinPaint();
}

/* A line, oldest on the left, one point per attempt.

   Points are spaced evenly rather than by true elapsed time: thirteen of
   these attempts fall on four dates, and a real time axis would stack
   them on top of each other into an unreadable smear. The date under
   each point is what carries the timing. */
function pinLine(g) {
    const pts = g.points || [];
    if (pts.length < 2) {
        const only = pts[0];
        return only ? `<p class="pin-line small quiet">Only one attempt so far —
      ${only.marks} of ${only.max || 720} on ${esc(only.day || '')}. A line
      needs a second go before it says anything.</p>` : '';
    }

    const W = 320, HGT = 120, PAD_L = 30, PAD_R = 8, PAD_T = 8, PAD_B = 4;
    const max = g.max || 720;
    const step = (W - PAD_L - PAD_R) / (pts.length - 1);
    const y = m => PAD_T + (1 - Math.max(0, Math.min(m, max)) / max)
        * (HGT - PAD_T - PAD_B);
    const x = i => PAD_L + i * step;

    const d = pts.map((r, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(r.marks).toFixed(1)}`).join(' ');
    const grid = [0, max / 4, max / 2, (max * 3) / 4, max];

    // Too many labels collide; show at most six, always including the ends.
    const every = Math.max(1, Math.ceil(pts.length / 6));

    return `
    <div class="pin-chart">
      <svg viewBox="0 0 ${W} ${HGT + 22}" preserveAspectRatio="none"
           role="img" aria-label="Marks over ${pts.length} attempts">
        ${grid.map(v => `
          <line class="pin-grid-l" x1="${PAD_L}" x2="${W - PAD_R}"
                y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"></line>
          <text class="pin-axis" x="0" y="${(y(v) + 3).toFixed(1)}">${Math.round(v)}</text>
        `).join('')}
        <path class="pin-path" d="${d}"></path>
        ${pts.map((r, i) => `
          <circle class="pin-dot ${r.marks === g.best ? 'best' : ''}"
                  cx="${x(i).toFixed(1)}" cy="${y(r.marks).toFixed(1)}" r="3">
            <title>${esc(r.day || '')} · ${r.marks} of ${max}</title>
          </circle>`).join('')}
        ${pts.map((r, i) => (i % every === 0 || i === pts.length - 1) ? `
          <text class="pin-xlab" x="${x(i).toFixed(1)}" y="${HGT + 14}"
                text-anchor="middle">${esc((r.day || '').replace(/ \d{4}$/, ''))}</text>` : '').join('')}
      </svg>
      <div class="pin-chart-k">Marks out of ${max} · oldest on the left ·
        best ${g.best} highlighted</div>
    </div>`;
}


/* ── when the studying happens ─────────────────────────────────────
   The only thing on these four tabs a parent can act on directly.
   Bedtime is squarely their business in a way that osmosis is not. */

function pinHours(h, child) {
    const buckets = h.buckets || [];
    const max = Math.max(1, ...buckets.map(b => b.count || 0));

    if (!h.ready) {
        return `
      <div class="pt-sec pin-sec">
        ${pinHead('hours', 'When the studying happens', '', h.info)}
        <p class="pin-line quiet">Shown once at least ${h.floor || 10} tests
          have been taken — ${pinN(h.sessions, 'test')} so far. Fewer than
          that would describe a few evenings rather than a habit.</p>
      </div>`;
    }

    return `
    <div class="pt-sec pin-sec">
      ${pinHead('hours', 'When the studying happens',
        'The hour each test was submitted, Indian time.', h.info)}
      ${h.line ? `<p class="pin-line">${esc(h.line)}</p>` : ''}
      <div class="pin-clock">
        ${buckets.map(b => `
          <div class="pin-hr ${b.late ? 'late' : ''} ${b.hour === h.peak_hour ? 'peak' : ''}"
               title="${esc(b.label)} · ${pinN(b.count, 'test')}">
            <i style="height:${((b.count / max) * 100).toFixed(1)}%"></i>
          </div>`).join('')}
      </div>
      <div class="pin-clock-k">
        <span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>11pm</span>
      </div>
      <p class="pin-note">Shaded hours are 10pm to 4am.</p>
    </div>`;
}


/* ── do retakes help THIS student ──────────────────────────────── */

function pinRetakes(r, child) {
    const who = child.first_name || 'They';
    if (!r.ready) {
        return `
      <div class="pt-sec pin-sec">
        ${pinHead('retakes', 'Do retakes help?', '', r.info)}
        <p class="pin-line quiet">Needs at least ${r.floor || 3} of each
          before the comparison means anything —
          ${pinN(r.first_n, 'first attempt')} and
          ${pinN(r.retake_n, 'retake')} so far.</p>
      </div>`;
    }

    const gain = Math.round((r.retake_avg || 0) - (r.first_avg || 0));
    return `
    <div class="pt-sec pin-sec">
      ${pinHead('retakes', 'Do retakes help?',
        `${pinN(r.retake_n, 'retake')} against ${pinN(r.first_n, 'first attempt')}`,
        r.info)}
      <div class="pin-two">
        <div class="pin-half">
          <div class="pin-half-k">First attempt</div>
          <div class="pin-big">${pinPct(r.first_avg)}</div>
        </div>
        <div class="pin-half ${gain >= 0 ? 'up' : 'down'}">
          <div class="pin-half-k">On a retake</div>
          <div class="pin-big">${pinPct(r.retake_avg)}
            <em>${gain >= 0 ? '+' : ''}${gain}</em></div>
        </div>
      </div>
      ${r.line ? `<p class="pin-line">${esc(r.line)}</p>` : ''}
    </div>`;
}


/* ════════════════════════════════════════════════════════════════
   LEVEL 2 · ONE CHAPTER, ONE ROW PER IDEA

   The race guard matters: two quick taps, the first request returns
   second, and without reqId the page settles on the chapter the
   parent did NOT ask for.
   ════════════════════════════════════════════════════════════════ */

async function pinOpenChapter(cid) {
    const c = activeChild();
    if (!c) return;
    PIN.view = 'chapter';
    PIN.chapter = null;
    pinPaint();

    const my = ++PIN.reqId;
    try {
        const d = await apiCall(`/api/parent/v2/child/${c.uid}` +
            `/insights/chapter/${encodeURIComponent(cid)}`);
        if (my !== PIN.reqId) return;
        PIN.chapter = d;
    } catch (e) {
        if (my !== PIN.reqId) return;
        PIN.chapter = { error: e.message || 'Could not load that chapter.' };
    }
    pinPaint();
}

function pinBack() {
    PIN.view = 'list';
    PIN.chapter = null;
    pinPaint();
}

function pinChapterView() {
    const c = PIN.chapter;
    const back = `<button class="pin-back" onclick="pinBack()">
      <i class="fa-solid fa-arrow-left"></i> All chapters</button>`;
    if (!c) return back + skeleton(3);
    if (c.error) return back + emptyState('fa-triangle-exclamation',
        "Couldn't load that chapter", esc(c.error));

    const cn = c.counts || {};
    const sub = [
        pinN(c.tests, 'test'),
        c.accuracy != null ? `${Math.round(c.accuracy)}% of ${pinN(c.asked, 'question')} right` : '',
    ].filter(Boolean).join(' · ');

    return `${back}
    <div class="pt-sec pin-sec">
      <div class="pin-chead">
        <div>
          <span class="pin-tag ${pinSubjClass(c.subject)}">${esc(c.subject)}</span>
          ${c.class_level ? `<span class="pin-yr">Class ${esc(c.class_level)}</span>` : ''}
          <h3>${esc(c.chapter)}</h3>
          <span class="pin-csub">${esc(sub)}</span>
        </div>
        ${pinInfoBtn('level2')}
      </div>
      ${pinInfoPanel('level2', c.info)}

      ${pinLadder(c)}

      <div class="pin-counts">
        ${cn.solid ? `<span class="ok">${cn.solid} solid</span>` : ''}
        ${cn.shaky ? `<span class="bad">${cn.shaky} shaky</span>` : ''}
        ${cn.stuck ? `<span class="warn">${cn.stuck} stuck</span>` : ''}
        ${cn.early ? `<span class="flat">${cn.early} too early to judge</span>` : ''}
      </div>

      <div class="pin-ideas">
        ${(c.ideas || []).map(x => pinIdea(x, c)).join('')}
      </div>
    </div>`;
}

/* How hard the questions have got in this chapter.

   OPD walks a chapter through six stages of rising difficulty. Five of
   the six internal names appear nowhere in the student app, so they are
   translated here — the scale is the useful part, the vocabulary is not.
   It says how hard the questions are, NOT how well they are answered,
   and the (i) copy makes that explicit so a chapter sitting early does
   not read as a chapter going badly. */
function pinLadder(c) {
    const steps = c.ladder || [];
    if (!steps.length) return '';
    return `
    <div class="pin-ladder-wrap">
      <div class="pin-ladder-h">
        <b>How hard the questions have got</b>
        ${pinInfoBtn('ladder')}
      </div>
      <div class="pin-ladder">
        ${steps.map((x, i) => `
          <div class="pin-step ${x.done ? 'done' : ''} ${x.current ? 'now' : ''}
               ${x.reached ? 'reached' : ''}">
            <i></i>
            <span>${esc(x.label)}</span>
            ${x.name ? `<em>${esc(x.name)}</em>` : ''}
          </div>`).join('')}
      </div>
      ${pinInfoPanel('ladder', c.ladder_info)}
    </div>`;
}


/* ONE row, every fact about this idea together. The old tab split
   these across three separate blocks, so the same idea appeared
   three times each carrying a third of the story. */
function pinIdea(x, c) {
    const chips = [];
    if (x.stuck) chips.push(`<span class="pin-chip stuck">missed
    ${pinN(x.stuck, 'time')} in a row</span>`);
    if (x.direction === 'up') chips.push(`<span class="pin-chip up">
    <i class="fa-solid fa-arrow-trend-up"></i> improving</span>`);
    if (x.direction === 'down') chips.push(`<span class="pin-chip down">
    <i class="fa-solid fa-arrow-trend-down"></i> slipping</span>`);
    if (x.retaught) chips.push(`<span class="pin-chip retaught">
    the app rebuilt practice for this</span>`);

    return `
    <div class="pin-idea ${esc(x.state)}">
      <div class="pin-idea-t">
        <b>${esc(x.concept)}</b>
        <span class="pin-state ${esc(x.state)}">${x.state === 'early'
            ? 'too early to judge' : esc(x.state)}</span>
      </div>
      <div class="pin-idea-b">
        <div class="pin-idea-bar">
          <i style="width:${x.ready
            ? Math.max(0, Math.min(100, x.accuracy || 0)).toFixed(1) : 0}%"></i>
        </div>
        <span class="pin-idea-v">${x.ready ? pinPct(x.accuracy)
            : `<em>${x.asked} asked</em>`}</span>
      </div>
      <div class="pin-idea-s">${x.right} of ${pinN(x.asked, 'question')} right${x.trend_tests ? ` · across ${pinN(x.trend_tests, 'test')}` : ''}</div>
      ${chips.length ? `<div class="pin-chips">${chips.join('')}</div>` : ''}
    </div>`;
}


/* ════════════════════════════════════════════════════════════════
   TAKEOVER
   ════════════════════════════════════════════════════════════════ */

(function () {
    const orig = window.renderParentTab;
    if (typeof orig === 'function') {
        window.renderParentTab = async function (tab) {
            if (tab === 'insights') {
                // Coming back to the tab should show the list, not the chapter
                // that happened to be open twenty minutes ago.
                if (PIN.view !== 'list' && PT.tab !== 'insights') pinBack();
                return renderParentInsightsV2();
            }
            return orig(tab);
        };
    }
})();