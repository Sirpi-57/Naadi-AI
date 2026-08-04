/* ════════════════════════════════════════════════════════════════
   NAADI AI — CLASS TAB  (teacher-class.js)
   ─────────────────────────────────────────────────────────────────
   Loads after teacher-home.js. Takes over the 'class' tab only.

   HOME answers "who needs me today".
   CLASS answers "where is the syllabus and how is the group doing".

   Aggregate by default. The ONE exception is the score distribution,
   where tapping a band reveals the names inside it — because
   "eleven students are under 40% in Hydrocarbons" is only actionable
   once you know which eleven.

   ─────────────────────────────────────────────────────────────────
   COVERAGE AND MASTERY ARE NEVER BLENDED

   Everywhere a chapter or subject appears, two numbers are shown:

       COVERAGE  "6 of 60 concepts done"   how far through
       MASTERY   "74% right"               how well, on what they did

   The old portal fused them, so a student ten concepts into a
   sixty-concept chapter answering at 90% rendered as ~15% and read
   as failing. They were not failing. They had barely started.

   Every label in this file says which number it is showing.
   ════════════════════════════════════════════════════════════════ */

const TCL = {
    data: null,
    subject: null,        // null = all subjects (class teacher only)
    classLevel: null,     // null = 11th and 12th
    view: 'progress',     // progress | distribution | chapters
    dist: null,
    distChapter: null,
    openBand: null,
    distMode: 'tests',
    chapterTab: 'tests',
    openChapterId: null,
    chapterCache: {},
};


/* ── helpers ──────────────────────────────────────────────────── */

/* ── question text: render, don't escape ──────────────────────────
   Chemistry and Physics questions are full of markup:

       (CH<sub>3</sub>)<sub>2</sub>CHCH(CH<sub>3</sub>)&ndash;

   Running that through esc() prints the tags literally, which is what
   the Class tab and the Home most-missed list were both doing.

   shared.js already ships safeHtml() for exactly this and
   concept-studio.js uses it — but it misses a few entities that turn up
   in NEET stems, so tclQ extends it. Sub/sup tags are then re-permitted
   deliberately: they carry meaning in a formula, and stripping them
   turns CH₃ into CH3.

   ONLY for question and explanation text. Names, chapter titles and
   anything a person typed stay on esc(). */

const _TCL_ENT = {
    '&ndash;': '–', '&mdash;': '—', '&minus;': '−', '&prime;': '′',
    '&Prime;': '″', '&rsquo;': '’', '&lsquo;': '‘', '&ldquo;': '“',
    '&rdquo;': '”', '&hellip;': '…', '&nbsp;': ' ', '&harr;': '↔',
    '&uarr;': '↑', '&darr;': '↓', '&ne;': '≠', '&le;': '≤', '&ge;': '≥',
    '&asymp;': '≈', '&equiv;': '≡', '&pi;': 'π', '&theta;': 'θ',
    '&sigma;': 'σ', '&epsilon;': 'ε', '&rho;': 'ρ', '&phi;': 'φ',
    '&omega;': 'ω', '&Delta;': 'Δ', '&sum;': '∑', '&radic;': '√',
    '&frac14;': '¼', '&frac34;': '¾', '&sup1;': '¹', '&deg;': '°',
};

function tclQ(s) {
    if (!s) return '';
    let t = String(s);
    // shared.js handles the common set; fall back gracefully if absent.
    if (typeof safeHtml === 'function') t = safeHtml(t);
    for (const [k, v] of Object.entries(_TCL_ENT)) t = t.split(k).join(v);
    t = t.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

    // Neutralise everything, then restore only the formatting tags that
    // carry meaning in a formula. A stray <script> in question text would
    // otherwise execute inside the teacher's session.
    t = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    t = t.replace(/&lt;(\/?)(sub|sup|b|i|em|strong|br)\s*\/?&gt;/gi,
        (_, slash, tag) => `<${slash}${tag.toLowerCase()}>`);
    return t;
}

/* ── plain-language state sentences ───────────────────────────────
   "0 both · 0 read only · 2 tested only · 0 neither" is four numbers,
   three of them zero, and nobody parses that at a glance. These build
   one sentence naming only what is actually true. */

function tclSplitSentence(r) {
    const bits = [];
    if (r.both) bits.push(`${r.both} read it and tested`);
    if (r.read_only) bits.push(`${r.read_only} read it but haven't tested`);
    if (r.tested_only) bits.push(`${r.tested_only} tested without reading`);
    if (!bits.length) return `Nobody has started this yet.`;
    const tail = r.neither ? ` ${r.neither} haven't touched it.` : '';
    return bits.join(' · ') + '.' + tail;
}

function tclStateSentence(c) {
    const bits = [];
    if (c.complete) bits.push(`${c.complete} finished`);
    if (c.testing) bits.push(`${c.testing} testing now`);
    if (c.read_only) bits.push(`${c.read_only} reading only`);
    if (!bits.length) return `Nobody has started this chapter.`;
    const left = c.not_started
        ? ` · ${c.not_started} not started` : '';
    return bits.join(' · ') + left;
}

/* ── info tooltips ────────────────────────────────────────────────
   Every metric box carries an "i". A teacher should never have to
   guess what a number counts, and a footnote she has to hunt for is
   the same as no explanation at all. Text lives next to the number
   that needs it. */

const TCL_INFO = {
    studio: "Concept Studio is the reading material — the explanations, figures and flashcards, before any test. This shows how much of it the class has worked through. It does not measure test scores.",
    studio_two: "Left: averaged across every chapter in view, counting unopened ones as zero — how far through the material the class is. Right: averaged across only the chapters someone actually opened — how much they finish once they start. A chapter counts as opened once a student starts any concept in it, whether or not they tick it finished.",
    opd: "Two different questions, kept apart on purpose. HOW FAR THROUGH counts concepts attempted out of all concepts in the chapter. GETTING RIGHT counts correct answers out of questions actually answered. A class can be 20% through and getting 80% right — that is a class on track, not a class failing.",
    opd_levels: "Split by school year because a class-12 student can never finish class-11 chapters. Merged together they would always look about half done.",
    arena: "Full past NEET papers, out of 720. Each student's best attempt on each paper is used — a student who retried and slipped is not punished for practising.",
    retake: "A retake replays the SAME questions minutes after the student has read the explanations, so a high retake score is short-term recall, not proof the idea stuck. What proves it stuck is the audit three tests later. Averages are weighted by questions answered, not by number of tests, because tests differ in length.",
    split: "Same chapter, both sides. Read means any progress in Concept Studio. Tested means at least one test taken on that chapter. Reading without testing is often nerves; testing without reading is often guessing.",
    engagement: "Counts, not percentages. A streak is 3+ consecutive days. Quiet means no activity of any kind for 7 days or more.",
    distribution: "Each student placed in a band by how many questions they answer correctly, across the chapters currently filtered. TEST SCORES ONLY — a chapter with reading material but no question bank has nothing to score, so it does not appear here even though it shows in the Studio card. Students who have not answered enough questions yet sit in their own group rather than being shown as low scorers.",
    concepts: "Averaged across the students who have actually met each concept. A concept fewer than 3 students have attempted is not shown — one student's bad day is not a class weakness.",
    lost: "The student answered a question correctly, then failed the same idea when it came back differently worded a few tests later. That pattern usually means the first answer was remembered rather than understood.",
    coverage: "Concepts attempted, out of all concepts in the chapter. How far through — not how well.",
    mastery: "Correct answers out of questions actually answered. How well — on the part they have reached.",
};

function tclInfo(key) {
    const t = TCL_INFO[key];
    if (!t) return '';
    return `<button class="tcl-i" type="button" aria-label="What this means"
    onclick="event.stopPropagation();tclShowInfo('${key}')">i</button>`;
}

function tclShowInfo(key) {
    const t = TCL_INFO[key];
    if (!t) return;
    let el = $('tcl-tip');
    if (!el) {
        el = document.createElement('div');
        el.id = 'tcl-tip';
        el.className = 'tcl-tip';
        el.onclick = () => el.classList.add('hidden');
        document.body.appendChild(el);
    }
    el.innerHTML = `<div class="tcl-tip-box" onclick="event.stopPropagation()">
      <div class="tcl-tip-body">${esc(t)}</div>
      <button class="tcl-tip-x" onclick="document.getElementById('tcl-tip').classList.add('hidden')">Got it</button>
    </div>`;
    el.classList.remove('hidden');
}

/* Plain-language count phrasing. "1 students have sat one" is the kind
   of detail that makes a teacher distrust everything else on the page. */
function tclN(n, one, many) {
    return `${n} ${n === 1 ? one : (many || one + 's')}`;
}



const tclPct = v => (v == null || isNaN(v)) ? '—' : `${Math.round(v)}%`;

function tclSub(s) {
    const k = (s || '').toLowerCase();
    if (k.startsWith('bio')) return 'bio';
    if (k.startsWith('phy')) return 'phy';
    if (k.startsWith('chem')) return 'chem';
    return 'other';
}

// A single bar where the fill is the value. Deliberately not a chart
// library: a teacher reads a bar instantly and reads a chart legend never.
function tclBar(pct, cls) {
    const w = Math.max(0, Math.min(100, pct || 0));
    return `<div class="tcl-bar"><div class="tcl-bar-f ${cls || ''}"
            style="width:${w}%"></div></div>`;
}

function tclStates(c) {
    const tot = Math.max((c.complete || 0) + (c.testing || 0) +
        (c.read_only || 0) + (c.not_started || 0), 1);
    const seg = k => `${((c[k] || 0) / tot * 100).toFixed(1)}%`;
    return `<div class="tcl-states">
      <div class="tcl-seg done" style="width:${seg('complete')}"></div>
      <div class="tcl-seg doing" style="width:${seg('testing')}"></div>
      <div class="tcl-seg read" style="width:${seg('read_only')}"></div>
    </div>`;
}


/* ════════════════════════════════════════════════════════════════
   ENTRY
   ════════════════════════════════════════════════════════════════ */

async function renderClassV2() {
    const body = $('pt-class-body') || $('pt-home-body');
    body.innerHTML = skeleton(2);

    const qs = new URLSearchParams();
    if (TCL.subject) qs.set('subject', TCL.subject);
    if (TCL.classLevel) qs.set('class_level', TCL.classLevel);

    let d;
    try {
        d = await apiCall(
            `/api/teacher/class/${TC.classKey}/v2/overview?${qs.toString()}`);
    } catch (e) {
        body.innerHTML = emptyState('fa-triangle-exclamation',
            "Couldn't load this", e.message || 'Please try again.');
        return;
    }

    if (d.needs_role) {
        body.innerHTML = emptyState('fa-user-gear', 'Pick your role first',
            'Open Home and choose whether you teach a subject or run this class.');
        return;
    }

    TCL.data = d;
    // A subject teacher is scoped server-side; reflect that in the UI so the
    // filter row doesn't offer choices the backend will ignore.
    if (d.role === 'subject_teacher') TCL.subject = d.filters.subject;

    // `tcl-root` is what lets teacher-class.css out-specify the inherited
    // 2-column grid portal-desktop.css forces onto #pt-class-body. Without
    // this class the desktop tier cannot win, and every child of this
    // container gets squashed into a half-width column in source order.
    body.classList.add('tcl-root');

    body.innerHTML = `
    <div class="tcl-toprow">
      ${tclFilters(d)}
      ${tclViewTabs()}
    </div>
    <div id="tcl-view">${tclViewBody(d)}</div>`;
}

function tclViewBody(d) {
    if (TCL.view === 'distribution') return tclDistributionShell();
    if (TCL.view === 'chapters') return tclChaptersView(d);
    return tclProgressView(d);
}


/* ── filters ──────────────────────────────────────────────────── */

function tclFilters(d) {
    const f = d.filters || {};
    const subs = (f.available_subjects || []).filter(s => s !== 'Unassigned');
    const lvls = f.available_class_levels || [];
    const locked = d.role === 'subject_teacher';

    return `
    <div class="tcl-filters">
      ${locked ? `
        <div class="tcl-locked">
          <span class="th-tag ${tclSub(f.subject)}">${esc(f.subject || '')}</span>
          <span>your subject</span>
        </div>
      ` : `
        <div class="tcl-fgroup">
          <button class="tcl-chip ${!TCL.subject ? 'on' : ''}"
            onclick="tclSetSubject(null)">All subjects</button>
          ${subs.map(s => `
            <button class="tcl-chip ${TCL.subject === s ? 'on' : ''}"
              onclick="tclSetSubject('${esc(s)}')">${esc(s)}</button>`).join('')}
        </div>`}
      ${lvls.length > 1 ? `
        <div class="tcl-fgroup">
          <button class="tcl-chip sm ${!TCL.classLevel ? 'on' : ''}"
            onclick="tclSetLevel(null)">All years</button>
          ${lvls.map(l => `
            <button class="tcl-chip sm ${TCL.classLevel === l ? 'on' : ''}"
              onclick="tclSetLevel('${esc(l)}')">Class ${esc(l)}</button>`).join('')}
        </div>` : ''}
    </div>`;
}

function tclViewTabs() {
    const tabs = [['progress', 'Progress'], ['chapters', 'Chapters'],
    ['distribution', 'Who is where']];
    return `<div class="tcl-vtabs">
    ${tabs.map(([k, l]) => `
      <button class="tcl-vtab ${TCL.view === k ? 'on' : ''}" data-v="${k}"
        onclick="tclGoView('${k}')">${l}</button>`).join('')}
  </div>`;
}


/* ════════════════════════════════════════════════════════════════
   VIEW 1 · PROGRESS — the three sections
   ════════════════════════════════════════════════════════════════ */

function tclProgressView(d) {
    return `
    <div class="tcl-grid">
      <div class="tcl-col">
        ${tclStudioBlock(d.studio)}
        ${tclOpdBlock(d.opd)}
      </div>
      <div class="tcl-col">
        ${tclArenaBlock(d.arena)}
        ${tclRetakeBlock(d.first_vs_retake)}
        ${tclEngagementBlock(d.engagement)}
      </div>
    </div>
    ${tclSplitBlock(d.studio_vs_tested, d.syllabus)}`;
}

/* 1a · Concept Studio */
function tclStudioBlock(s) {
    if (!s) return '';
    const top = (s.chapters || []).slice(0, 8);
    return `
    <div class="pt-sec th-sec">
      <div class="tcl-h">
        <div class="pt-sec-title">Concept Studio — how much has been read
          ${tclInfo('studio')}</div>
      </div>
      <div class="pt-sec-sub">
        Measured against the ${tclN(s.chapters_in_scope, 'chapter')} that
        ${s.chapters_in_scope === 1 ? 'has' : 'have'} reading material —
        not the test syllabus.
      </div>
      <div class="tcl-two">
        <div>
          <div class="tcl-big">${tclPct(s.avg_completion_all)}</div>
          <div class="tcl-lbl">of all chapters read ${tclInfo('studio_two')}</div>
        </div>
        <div>
          <div class="tcl-big">${tclPct(s.avg_completion_started)}</div>
          <div class="tcl-lbl">finished, of the ones they opened</div>
        </div>
      </div>
      <div class="th-note" style="margin-top:2px">
        ${s.students_touching} of ${tclN(s.students, 'student')}
        ${s.students_touching === 1 ? 'has' : 'have'} opened at least one.
        ${s.reading_not_marking ? `
          <br>${tclN(s.reading_not_marking, 'student')}
          ${s.reading_not_marking === 1 ? 'is' : 'are'} reading without
          marking anything finished — their progress bar will look
          emptier than their work.` : ''}
      </div>

      ${top.length ? `
        <div class="tcl-rows two-up">
          ${top.map(c => `
            <div class="tcl-row">
              <div class="tcl-row-n">${esc(c.chapter_name)}
                <span class="tcl-row-s">${c.students_opened} opened ·
                  ${c.students_finished} finished${c.also_tested === false
            ? ' · reading only, no test yet' : ''}</span></div>
              ${tclBar(c.avg_pct, 'studio')}
              <div class="tcl-row-v">${tclPct(c.avg_pct)}</div>
            </div>`).join('')}
        </div>
        ${(s.chapters || []).length > 8 ? `
          <div class="th-note">Showing the 8 furthest along of
            ${s.chapters.length}.</div>` : ''}` : ''}
    </div>`;
}

/* 1b · OPD — two numbers, never fused, split by school year */
function tclOpdBlock(rows) {
    if (!rows || !rows.length) return '';
    return `
    <div class="pt-sec th-sec">
      <div class="tcl-h">
        <div class="pt-sec-title">Tests — how far, and how well
          ${tclInfo('opd')}</div>
      </div>
      <div class="pt-sec-sub">
        Two different things. A class can be 20% through the syllabus and
        getting 80% right.
      </div>
      ${rows.filter(r => r.subject !== 'Unassigned').map(r => `
        <div class="tcl-subj">
          <div class="tcl-subj-h">
            <span class="th-tag ${tclSub(r.subject)}">${esc(r.subject)}</span>
            <span class="tcl-subj-meta">${tclN(r.chapters_total, 'chapter')} ·
              ${tclN(r.tests_taken, 'test')} taken</span>
          </div>
          ${(r.levels || []).length > 1 ? `
            <div class="tcl-lvlnote">By school year ${tclInfo('opd_levels')}</div>` : ''}
          ${(r.levels || []).map(lv => `
            <div class="tcl-lvl">
              ${(r.levels || []).length > 1
            ? `<div class="tcl-lvl-h">Class ${esc(lv.class_level)}
             <span>${tclN(lv.chapters_total, 'chapter')}</span></div>` : ''}
              <div class="tcl-metric">
                <div class="tcl-metric-l">How far through</div>
                ${tclBar(lv.coverage_pct, 'cov')}
                <div class="tcl-metric-v">${tclPct(lv.coverage_pct)}</div>
              </div>
              <div class="tcl-metric">
                <div class="tcl-metric-l">Getting right</div>
                ${tclBar(lv.mastery_pct, 'mas')}
                <div class="tcl-metric-v">${tclPct(lv.mastery_pct)}</div>
              </div>
            </div>`).join('')}
        </div>`).join('')}
    </div>`;
}

/* 1c · NEET Arena */
function tclArenaBlock(a) {
    if (!a || !a.papers_attempted) {
        return `<div class="pt-sec th-sec">
        <div class="pt-sec-title">Full NEET papers ${tclInfo('arena')}</div>
        <div class="th-note" style="margin:0">
          Nobody has sat a full paper yet.</div>
      </div>`;
    }
    return `
    <div class="pt-sec th-sec">
      <div class="tcl-h">
        <div class="pt-sec-title">Full NEET papers ${tclInfo('arena')}</div>
      </div>
      <div class="pt-sec-sub">
        Best attempt per paper.
        ${tclN(a.students_with_papers, 'student')} of ${a.students}
        ${a.students_with_papers === 1 ? 'has' : 'have'} sat one.
      </div>
      <div class="tcl-big">${a.class_avg_marks ?? '—'}<span>/720</span></div>
      <div class="tcl-lbl">class average across all papers</div>
      <div class="tcl-rows" style="margin-top:12px">
        ${a.papers.map(p => `
          <div class="tcl-paper">
            <div class="tcl-paper-h">
              <b>${esc(String(p.year || ''))} ${esc(p.paper_code || '')}</b>
              <span>${tclN(p.students_attempted, 'student')}</span>
            </div>
            <div class="tcl-paper-r">
              <span class="tcl-paper-avg">${p.avg_marks}<i>/${p.max}</i></span>
              <span class="tcl-paper-span">
                ${p.single
            // One student has no range. Saying "lowest 670 · highest 670"
            // reads as "the class scored between 670 and 670" when it means
            // "one student, best 670" — and their weaker attempts were
            // already dropped by taking the best.
            ? `class best`
            : `best scores ${p.lowest_marks}–${p.best_marks}`}</span>
            </div>
            ${(p.subjects || []).length ? `
              <div class="tcl-psubs">
                ${p.subjects.map(s => `
                  <span class="tcl-psub ${tclSub(s.subject)}">
                    ${esc(s.subject.slice(0, 4))} ${s.avg}<i>/${s.max}</i>
                  </span>`).join('')}
              </div>` : ''}
          </div>`).join('')}
      </div>
    </div>`;
}

/* 2 · first attempt vs retake */
function tclRetakeBlock(r) {
    if (!r || (!r.first_tests && !r.retake_tests)) return '';

    if (!r.enough_data) {
        // Below the gate, show the counts and refuse the percentages. Two
        // averages built from a handful of questions look authoritative and
        // are noise — and a teacher who acts on them once stops trusting
        // everything else on the page.
        return `
      <div class="pt-sec th-sec">
        <div class="tcl-h">
          <div class="pt-sec-title">First try vs retake ${tclInfo('retake')}</div>
        </div>
        <div class="th-note" style="margin-top:0">
          Not enough yet to compare fairly —
          ${tclN(r.first_questions, 'question')} on first attempts and
          ${tclN(r.retake_questions, 'question')} on retakes.
          This needs at least ${r.min_questions} of each.
        </div>
      </div>`;
    }

    const gap = (r.first_avg != null && r.retake_avg != null)
        ? Math.round(r.retake_avg - r.first_avg) : null;

    return `
    <div class="pt-sec th-sec">
      <div class="tcl-h">
        <div class="pt-sec-title">First try vs retake ${tclInfo('retake')}</div>
      </div>
      <div class="pt-sec-sub">${esc(r.window_note)}.</div>
      <div class="tcl-two">
        <div>
          <div class="tcl-big">${tclPct(r.first_avg)}</div>
          <div class="tcl-lbl">first attempt<br>
            <span class="tcl-sample">${tclN(r.first_questions, 'question')}
              across ${tclN(r.first_tests, 'test')}</span></div>
        </div>
        <div>
          <div class="tcl-big">${tclPct(r.retake_avg)}</div>
          <div class="tcl-lbl">retakes<br>
            <span class="tcl-sample">${tclN(r.retake_questions, 'question')}
              across ${tclN(r.retake_tests, 'test')}</span></div>
        </div>
      </div>
      ${gap != null && gap > 15 ? `
        <div class="th-note">Retakes score ${gap} points higher, which is
          normal — they replay the same questions right after the student
          reads the answer. It is recall, not proof it stuck.</div>` : ''}
      ${gap != null && gap < -5 ? `
        <div class="th-note">Retakes are scoring ${Math.abs(gap)} points
          <b>lower</b> than first attempts. Worth checking whether students
          are retaking without revising first.</div>` : ''}
    </div>`;
}

function tclEngagementBlock(e) {
    if (!e) return '';
    const items = [
        ['active_today', 'active today', false],
        ['on_streak', 'on a streak', false],
        ['broke_long_streak', 'broke a long streak', true],
        ['never_started', 'never taken a test', true],
        ['quiet_7d', 'quiet 7+ days', true],
    ];
    return `
    <div class="pt-sec th-sec">
      <div class="tcl-h">
        <div class="pt-sec-title">Engagement ${tclInfo('engagement')}</div>
      </div>
      <div class="tcl-eng">
        ${items.map(([k, l, warn]) => `
          <div class="tcl-eng-i ${warn && e[k] ? 'warn' : ''}">
            <div class="tcl-eng-v">${e[k] ?? 0}</div>
            <div class="tcl-eng-k">${l}</div>
          </div>`).join('')}
      </div>
    </div>`;
}

/* 4 · studio vs tested — one sentence per chapter */
function tclSplitBlock(rows, syllabus) {
    if (!rows || !rows.length) {
        // Empty here is usually a content gap, not a class that did nothing —
        // so say which, rather than showing a blank card.
        const s = syllabus || {};
        const why = (s.studio_only || s.opd_only)
            ? `${s.both || 0} of ${s.total || 0} chapters have both reading material
         and a question bank. The rest have only one, so there is nothing to
         compare yet.`
            : 'Nothing to compare yet.';
        return `<div class="pt-sec th-sec">
        <div class="tcl-h">
          <div class="pt-sec-title">Read it, or tested on it? ${tclInfo('split')}</div>
        </div>
        <div class="th-note" style="margin:0">${why}</div>
      </div>`;
    }
    return `
    <div class="pt-sec th-sec">
      <div class="tcl-h">
        <div class="pt-sec-title">Read it, or tested on it? ${tclInfo('split')}</div>
      </div>
      <div class="pt-sec-sub">
        Only chapters that have both reading material and a question bank.
        Biggest gaps first.
      </div>
      <div class="tcl-rows two-up">
        ${rows.map(r => `
          <div class="tcl-split">
            <div class="tcl-row-n">${esc(r.chapter_name)}
              <span class="tcl-row-s">${esc(r.subject)} ·
                class ${esc(r.class_level || '—')}</span></div>
            <div class="tcl-splitbar">
              <div class="tcl-seg done" style="flex:${r.both}"></div>
              <div class="tcl-seg read" style="flex:${r.read_only}"></div>
              <div class="tcl-seg doing" style="flex:${r.tested_only}"></div>
              <div class="tcl-seg none" style="flex:${r.neither}"></div>
            </div>
            <div class="tcl-sentence">${esc(tclSplitSentence(r))}</div>
          </div>`).join('')}
      </div>
    </div>`;
}


/* ════════════════════════════════════════════════════════════════
   VIEW 2 · CHAPTERS
   ════════════════════════════════════════════════════════════════ */

function tclChaptersView(d) {
    // No subject picked is a valid view, not a dead end. The class teacher's
    // whole job is spotting that one subject trails the others, which needs
    // them side by side.
    return `<div id="tcl-chapters">${skeleton(1)}</div>`;
}

async function tclLoadChapters() {
    const host = $('tcl-chapters');
    if (!host) return;
    const qs = new URLSearchParams();
    if (TCL.subject) qs.set('subject', TCL.subject);
    if (TCL.classLevel) qs.set('class_level', TCL.classLevel);

    let d;
    try {
        d = await apiCall(
            `/api/teacher/class/${TC.classKey}/v2/subject-depth?${qs.toString()}`);
    } catch (e) {
        host.innerHTML = emptyState('fa-triangle-exclamation',
            "Couldn't load chapters", e.message || '');
        return;
    }

    // Group by subject then class year. With ~83 chapters a flat list is
    // unreadable, and the year split is what stops a class-12 group looking
    // half-finished because class-11 chapters sit unstarted beside them.
    const groups = {};
    for (const c of (d.chapters || [])) {
        const k = `${c.subject || d.subject || ''}|${c.class_level || '?'}`;
        (groups[k] = groups[k] || []).push(c);
    }
    const keys = Object.keys(groups).sort();

    const syl = d.syllabus || {};
    host.innerHTML = `
    ${syl.studio_only ? `
      <div class="pt-sec th-sec">
        <div class="tcl-warnbox">
          <i class="fa-solid fa-circle-info"></i>
          <div><b>${tclN(syl.studio_only, 'chapter')} with reading material
            but no questions yet.</b>
            Students can study ${syl.studio_only === 1 ? 'it' : 'them'} in the
            Studio, but there is nothing to test on, so
            ${syl.studio_only === 1 ? 'it' : 'they'} won't appear in the
            chapter list below.</div>
        </div>
      </div>` : ''}
    ${(d.weakest || []).length ? `
      <div class="pt-sec th-sec">
        <div class="tcl-h">
          <div class="pt-sec-title">Weakest chapters right now</div>
        </div>
        <div class="pt-sec-sub">
          Only chapters at least 3 students have tested on.</div>
        <div class="tcl-rows two-up">
          ${d.weakest.map(c => tclChapterRow(c, true)).join('')}
        </div>
      </div>` : ''}

    ${keys.map(k => {
        const [sub, lvl] = k.split('|');
        const rows = groups[k];
        const done = rows.filter(c => c.complete > 0).length;
        return `
      <div class="pt-sec th-sec">
        <div class="tcl-h">
          <div class="pt-sec-title">
            <span class="th-tag ${tclSub(sub)}">${esc(sub)}</span>
            Class ${esc(lvl)}
          </div>
          <div class="tcl-h-meta">${tclN(rows.length, 'chapter')}</div>
        </div>
        <div class="pt-sec-sub">
          Tap a chapter to see which concepts inside it are weak.</div>
        <div class="tcl-rows two-up">
          ${rows.map(c => tclChapterRow(c)).join('')}
        </div>
      </div>`;
    }).join('')}

    ${!keys.length ? `
      <div class="pt-sec th-sec">
        <div class="th-note" style="margin:0">
          No chapters match this filter yet.</div>
      </div>` : ''}

    <div class="pt-sec th-sec">
      <div class="th-legend">
        <span><i class="th-dot done"></i>finished</span>
        <span><i class="th-dot doing"></i>testing now</span>
        <span><i class="th-dot read"></i>read only</span>
        <span><i class="th-dot none"></i>not started</span>
      </div>
    </div>

    ${(d.concepts?.weakest || []).length ? `
      <div class="pt-sec th-sec">
        <div class="tcl-h">
          <div class="pt-sec-title">Weakest concepts ${tclInfo('concepts')}</div>
        </div>
        <div class="pt-sec-sub">
          Across ${d.concepts.total_concepts} concepts the class has met.</div>
        <div class="tcl-rows two-up">
          ${d.concepts.weakest.slice(0, 16).map(c => `
            <div class="tcl-concept" onclick="tclOpenChapter('${esc(c.chapter_id)}')">
              <div class="tcl-row-n">${esc(c.concept_name)}
                <span class="tcl-row-s">${esc(c.chapter_name)} ·
                  ${tclN(c.students_attempted, 'student')}</span></div>
              ${tclBar(c.avg_mastery, c.avg_mastery < 40 ? 'bad' : 'mas')}
              <div class="tcl-row-v ${c.avg_mastery < 40 ? 'low' : ''}">
                ${tclPct(c.avg_mastery)}</div>
            </div>`).join('')}
        </div>
      </div>` : ''}`;
}

function tclChapterRow(c, compact) {
    // TWO BARS, never one.
    //
    // Reading progress and test performance are different measurements of
    // different material, and a single bar forced them into one number that
    // was true of neither. A chapter can be fully read and untested, or
    // heavily tested with the reading untouched — and a teacher needs to
    // see which.
    //
    // Each bar is its own tap target: reading opens the reading story,
    // tests opens concepts and questions.
    const hasStudio = c.in_studio !== false;
    const hasTests = c.in_opd !== false;
    const readPct = c.studio_pct;
    const testPct = c.mastery_pct;

    return `
    <div class="tcl-ch2 ${!hasTests ? 'reading-only' : ''}">
      <div class="tcl-ch2-head">
        <div class="tcl-row-n">${esc(c.chapter_name)}
          ${compact && c.subject ? `<span class="tcl-row-s">${esc(c.subject)} ·
            class ${esc(c.class_level || '—')}</span>` : ''}</div>
      </div>

      <button class="tcl-track ${hasStudio ? '' : 'off'}"
        ${hasStudio ? `onclick="tclOpenChapter('${esc(c.chapter_id)}','studio')"` : 'disabled'}>
        <span class="tk-lbl">Reading</span>
        <span class="tcl-bar"><span class="tcl-bar-f studio"
          style="width:${hasStudio ? Math.max(0, Math.min(100, readPct || 0)) : 0}%"></span></span>
        <span class="tk-val">${hasStudio ? tclPct(readPct) : 'none yet'}</span>
        ${hasStudio ? '<i class="fa-solid fa-chevron-right tk-go"></i>' : ''}
      </button>

      <button class="tcl-track ${hasTests ? '' : 'off'}"
        ${hasTests ? `onclick="tclOpenChapter('${esc(c.chapter_id)}','tests')"` : 'disabled'}>
        <span class="tk-lbl">Tests</span>
        <span class="tcl-bar"><span class="tcl-bar-f ${testPct != null && testPct < 40 ? 'bad' : 'mas'}"
          style="width:${hasTests ? Math.max(0, Math.min(100, testPct || 0)) : 0}%"></span></span>
        <span class="tk-val ${testPct != null && testPct < 40 ? 'low' : ''}">
          ${hasTests ? tclPct(testPct) : 'none yet'}</span>
        ${hasTests ? '<i class="fa-solid fa-chevron-right tk-go"></i>' : ''}
      </button>

      ${compact ? '' : `<div class="tcl-ch-s">${esc(
        hasTests ? tclStateSentence(c) : tclReadSentence(c))}</div>`}
    </div>`;
}

/* A reading-only chapter cannot be "finished" or "testing" — those states
   need a question bank. It has exactly two: opened, or not. */
function tclReadSentence(c) {
    const opened = (c.complete || 0) + (c.testing || 0) + (c.read_only || 0);
    if (!opened) return 'Nobody has opened this in the Studio yet.';
    const rest = c.not_started ? ` · ${c.not_started} haven't opened it` : '';
    return `${opened} reading it${rest}`;
}

/* ── chapter drill-down: concepts + spread ────────────────────── */

async function tclOpenChapter(chapterId, tab) {
    const sheet = $('pt-sheet');
    $('pt-sheet-title').textContent = 'Chapter';
    $('pt-sheet-body').innerHTML = skeleton(2);
    sheet.classList.remove('hidden');

    let d = TCL.chapterCache[chapterId];
    if (!d) {
        try {
            d = await apiCall(
                `/api/teacher/class/${TC.classKey}/v2/chapter/${encodeURIComponent(chapterId)}/concepts`);
            TCL.chapterCache[chapterId] = d;
        } catch (e) {
            $('pt-sheet-body').innerHTML = emptyState('fa-triangle-exclamation',
                "Couldn't load this", e.message || '');
            return;
        }
    }

    $('pt-sheet-title').textContent = d.chapter_name || 'Chapter';
    TCL.chapterTab = tab || TCL.chapterTab || 'tests';
    TCL.openChapterId = chapterId;
    tclPaintChapter(d);
}

function tclSetChapterTab(t) {
    TCL.chapterTab = t;
    const d = TCL.chapterCache[TCL.openChapterId];
    if (d) tclPaintChapter(d);
}

function tclPaintChapter(d) {
    const tab = TCL.chapterTab || 'tests';
    const st = d.studio || {};
    const hasStudio = !!st.has_material;
    const bands = (d.spread?.bands || []).filter(b => b.count);

    // Reading and tests get their own tab rather than one long scroll.
    // They answer different questions and a teacher arrives with one of
    // them in mind — she tapped a specific bar to get here.
    const tabs = `
    <div class="tcl-sheettabs">
      <button class="${tab === 'reading' ? 'on' : ''}"
        onclick="tclSetChapterTab('reading')">Reading</button>
      <button class="${tab === 'tests' ? 'on' : ''}"
        onclick="tclSetChapterTab('tests')">Tests</button>
    </div>`;

    if (tab === 'reading') {
        $('pt-sheet-body').innerHTML = `
      <div class="th-sheet">
        ${tabs}
        ${!hasStudio ? `
          <div class="pt-sec th-sec">
            <div class="th-note" style="margin:0">
              This chapter has no reading material in Concept Studio yet.
            </div>
          </div>` : `
          <div class="pt-sec th-sec">
            <div class="tcl-h">
              <div class="pt-sec-title">Reading progress ${tclInfo('studio')}</div>
            </div>
            <div class="pt-sec-sub">
              ${tclN(st.readers.length, 'student')} opened it${st.blocks_total
                ? ` · ${tclN(st.blocks_total, 'concept')} in the chapter` : ''}.
            </div>
            <div class="tcl-two">
              <div>
                <div class="tcl-big">${tclPct(st.avg_pct)}</div>
                <div class="tcl-lbl">average, of those who opened it</div>
              </div>
              <div>
                <div class="tcl-big">${st.not_opened_count}</div>
                <div class="tcl-lbl">haven't opened it at all</div>
              </div>
            </div>
            ${st.reading_not_marking ? `
              <div class="th-note">
                ${tclN(st.reading_not_marking, 'student')}
                ${st.reading_not_marking === 1 ? 'has' : 'have'} opened concepts
                but marked none finished — their progress bar reads lower than
                their actual work.</div>` : ''}
          </div>

          ${st.readers.length ? `
            <div class="pt-sec th-sec">
              <div class="pt-sec-title">Who is reading it</div>
              <div class="tcl-rows">
                ${st.readers.map(s => `
                  <div class="tcl-row" onclick="openStudent('${esc(s.uid)}')"
                       style="cursor:pointer">
                    <div class="tcl-row-n">${esc(s.name)}
                      <span class="tcl-row-s">${s.blocks_done} of
                        ${s.blocks_touched} opened concepts marked done</span></div>
                    ${tclBar(s.pct, 'studio')}
                    <div class="tcl-row-v">${tclPct(s.pct)}</div>
                  </div>`).join('')}
              </div>
            </div>` : ''}

          ${st.not_opened_count ? `
            <div class="pt-sec th-sec">
              <div class="pt-sec-title">Haven't opened it</div>
              <div class="tcl-names">
                ${st.not_opened.map(s => `<span>${esc(s.name)}</span>`).join('')}
              </div>
            </div>` : ''}`}
      </div>`;
        return;
    }

    $('pt-sheet-body').innerHTML = tclChapterTestsHTML(d, tabs, bands);
}

function tclChapterTestsHTML(d, tabs, bands) {

    return `
    <div class="th-sheet">
      ${tabs}
      <div class="pt-sec th-sec">
        <div class="tcl-h">
          <div class="pt-sec-title">Concepts in this chapter ${tclInfo('concepts')}</div>
        </div>
        <div class="pt-sec-sub">Weakest first. This is the reteach list.</div>
        ${(d.concepts || []).length ? `
          <div class="tcl-rows two-up">
            ${d.concepts.map(c => `
              <div class="tcl-concept">
                <div class="tcl-row-n">${esc(c.concept_name)}
                  <span class="tcl-row-s">${tclN(c.students_attempted, 'student')} ·
                    ${c.struggling} under 50%${c.failing_repeatedly
            ? ` · ${c.failing_repeatedly} failing repeatedly` : ''}</span></div>
                ${tclBar(c.avg_mastery, c.avg_mastery < 40 ? 'bad' : 'mas')}
                <div class="tcl-row-v ${c.avg_mastery < 40 ? 'low' : ''}">
                  ${tclPct(c.avg_mastery)}</div>
              </div>`).join('')}
          </div>`
            : `<div class="th-note">Nobody has attempted concepts here yet.</div>`}
      </div>

      ${bands.length ? `
        <div class="pt-sec th-sec">
          <div class="tcl-h">
            <div class="pt-sec-title">How the class is spread ${tclInfo('distribution')}</div>
          </div>
          <div class="pt-sec-sub">
            The same average can mean very different things. Tap a bar for names.</div>
          ${tclBands(d.spread, 'sheet')}
        </div>` : ''}

      ${(d.missed_questions || []).length ? `
        <div class="pt-sec th-sec">
          <div class="tcl-h">
            <div class="pt-sec-title">Questions they keep getting wrong</div>
          </div>
          <div class="pt-sec-sub">
            Tap one to see which wrong option the class agreed on.</div>
          ${d.missed_questions.map(q => `
            <div class="th-q" onclick="tclOpenQuestion('${esc(q.base_question_id)}')"
                 style="cursor:pointer">
              <div class="th-q-head">
                ${q.concept_name
                    ? `<span class="th-tag other">${esc(q.concept_name)}</span>` : ''}
                <span class="th-q-n">${tclN(q.students, 'student')}</span>
              </div>
              <div class="th-q-text">${tclQ(q.question_text || 'Question text unavailable')}</div>
              ${(q.names || []).length ? `
                <div class="th-q-who">${q.names.slice(0, 6).map(esc).join(', ')}${q.names.length > 6 ? '…' : ''}</div>` : ''}
              <div class="tcl-qtap">See the full breakdown
                <i class="fa-solid fa-arrow-right"></i></div>
            </div>`).join('')}
        </div>` : ''}

      ${d.lost_count ? `
        <div class="pt-sec th-sec">
          <div class="tcl-h">
            <div class="pt-sec-title">
              ${tclN(d.lost_count, 'student')} lost something they had
              ${tclInfo('lost')}</div>
          </div>
          <div class="pt-sec-sub">
            Answered it right once, then failed the same idea later.</div>
          ${(d.lost_it || []).map(g => `
            <div class="tcl-lost">
              <div class="tcl-lost-h">
                ${esc(g.concept_name || 'This idea')}
                <span class="th-q-n">${tclN(g.students.length, 'student')}</span>
              </div>
              ${g.question_text ? `
                <div class="tcl-lost-q">${tclQ(g.question_text)}</div>` : ''}
              <div class="tcl-names">
                ${g.students.map(n => `<span>${esc(n)}</span>`).join('')}
              </div>
            </div>`).join('')}
        </div>` : ''}
    </div>`;
}


/* ════════════════════════════════════════════════════════════════
   VIEW 3 · DISTRIBUTION — names behind the tap
   ════════════════════════════════════════════════════════════════ */

function tclDistributionShell() {
    return `<div id="tcl-dist">${skeleton(2)}</div>`;
}

async function tclLoadDistribution() {
    const host = $('tcl-dist');
    if (!host) return;
    const qs = new URLSearchParams();
    if (TCL.subject) qs.set('subject', TCL.subject);
    if (TCL.classLevel) qs.set('class_level', TCL.classLevel);
    if (TCL.distChapter) qs.set('chapter_id', TCL.distChapter);
    if (TCL.distMode === 'reading') qs.set('mode', 'reading');

    let d;
    try {
        d = await apiCall(
            `/api/teacher/class/${TC.classKey}/v2/distribution?${qs.toString()}`);
    } catch (e) {
        host.innerHTML = emptyState('fa-triangle-exclamation',
            "Couldn't load this", e.message || '');
        return;
    }
    TCL.dist = d;
    const reading = d.mode === 'reading';

    // Scope label reads left to right exactly like the filters above it.
    const parts = [];
    parts.push(d.scope.subject || 'All subjects');
    if (d.scope.class_level) parts.push(`Class ${d.scope.class_level}`);
    parts.push(d.scope.chapter_name || 'all chapters');
    const scopeLabel = parts.join(' · ');

    // Group by year ONLY when years are mixed — repeating "Class 11" above
    // every chapter when the year filter is already set to Class 11 is
    // noise, and it was the second of two duplicate rows on this screen.
    const byLevel = {};
    for (const c of (d.chapters || [])) {
        (byLevel[c.class_level || '?'] = byLevel[c.class_level || '?'] || []).push(c);
    }
    const levels = Object.keys(byLevel).sort();
    const showLevelHeads = levels.length > 1;

    host.innerHTML = `
    <div class="tcl-modebar">
      <div class="tcl-modes" role="tablist" aria-label="What to measure">
        <button class="tcl-mode ${!reading ? 'on' : ''}"
          onclick="tclSetDistMode('tests')">Test scores</button>
        <button class="tcl-mode ${reading ? 'on' : ''}"
          onclick="tclSetDistMode('reading')">Reading progress</button>
      </div>
    </div>

    ${levels.length ? `
      <div class="tcl-chapsel">
        <div class="tcl-fgroup wrap">
          <button class="tcl-chip sm ${!TCL.distChapter ? 'on' : ''}"
            onclick="tclSetDistChapter(null)">All chapters</button>
          ${levels.map(l => `
            ${showLevelHeads ? `<span class="tcl-chapgrp-h">Class ${esc(l)}</span>` : ''}
            ${byLevel[l].map(c => `
              <button class="tcl-chip sm ${TCL.distChapter === c.chapter_id ? 'on' : ''}"
                onclick="tclSetDistChapter('${esc(c.chapter_id)}')"
                title="${esc(c.chapter_name)}">${esc(c.chapter_name)}</button>`).join('')}
          `).join('')}
        </div>
      </div>` : ''}

    <div class="pt-sec th-sec">
      <div class="tcl-h">
        <div class="pt-sec-title">Who is where — ${esc(scopeLabel)}
          ${tclInfo('distribution')}</div>
      </div>
      <div class="pt-sec-sub">
        ${reading
            ? `How much of the reading material each student has worked through.
         Chapters with no reading material aren't counted.`
            : `Test scores only. Chapters with reading material but no questions
         aren't here — there is nothing to score.`}
        ${d.placed ? ' Tap a bar to see who is in it.' : ''}
      </div>

      ${d.placed
            ? tclBands(d, 'main')
            : tclDistEmpty(d, reading)}

      ${d.not_started_count ? `
        <button class="th-more" onclick="tclToggleBand('none')">
          ${tclN(d.not_started_count, 'student')}
          ${d.not_started_count === 1 ? "hasn't" : "haven't"} started
          ${d.chapters_counted === 1 ? 'this chapter' : 'any of these'}
          <i class="fa-solid fa-chevron-down"></i></button>
        <div class="tcl-bandlist hidden" id="tcl-band-none">
          ${(d.not_started_data || []).map(s => `
            <div class="th-att" onclick="openStudent('${esc(s.uid)}')">
              ${thAvatar(s)}
              <div class="th-att-body">
                <div class="th-att-name">${esc(s.name)}</div>
                <div class="th-att-reason">No questions answered here yet</div>
              </div>
            </div>`).join('')}
        </div>` : ''}

      ${d.not_enough_count ? `
        <button class="th-more" onclick="tclToggleBand('few')">
          ${tclN(d.not_enough_count, 'student')}
          ${d.not_enough_count === 1 ? "hasn't" : "haven't"} answered enough yet
          <i class="fa-solid fa-chevron-down"></i></button>
        <div class="tcl-bandlist hidden" id="tcl-band-few">
          <div class="th-note" style="margin-top:0">
            Under ${d.min_sample} questions answered in
            ${d.chapters_counted === 1 ? 'this chapter' : 'the chapters in view'},
            so a percentage would be guesswork.
            ${d.chapters_counted === 1
                ? `A student can be below this in every chapter separately and still
         clear it across the subject — the questions add up.` : ''}</div>
          ${d.not_enough_data.map(s => `
            <div class="th-att" onclick="openStudent('${esc(s.uid)}')">
              ${thAvatar(s)}
              <div class="th-att-body">
                <div class="th-att-name">${esc(s.name)}</div>
                <div class="th-att-reason">
                  ${tclN(s.sample, 'question')} answered ·
                  needs ${d.min_sample}</div>
              </div>
            </div>`).join('')}
        </div>` : ''}
    </div>`;
}

/* Five empty bars tell a teacher nothing. This says WHY the chart is
   empty, which is almost always "the gate is doing its job" and not
   "the class did nothing". */
function tclDistEmpty(d, reading) {
    if (!d.chapters_counted) {
        return `<div class="th-note" style="margin-top:0">
      No chapters in this filter have ${reading
                ? 'reading material' : 'a question bank'} yet.</div>`;
    }
    if (d.not_enough_count) {
        return `<div class="th-note" style="margin-top:0">
      Nobody has answered ${d.min_sample}+ questions in
      ${d.chapters_counted === 1 ? 'this chapter' : 'these chapters'} yet, so
      there is nothing to place on the chart. The
      ${tclN(d.not_enough_count, 'student')} below
      ${d.not_enough_count === 1 ? 'has' : 'have'} started.
      ${d.chapters_counted === 1
                ? `They may still appear on the chart under "All chapters" — the
           questions from every chapter add up to clear the wider bar.` : ''}
      </div>`;
    }
    return `<div class="th-note" style="margin-top:0">
    Nobody has started ${d.chapters_counted === 1
            ? 'this chapter' : 'these chapters'} yet.</div>`;
}

async function tclSetDistMode(m) {
    TCL.distMode = m;
    // Chapter lists differ between modes, so a chapter selected in one can
    // be absent from the other. Clearing avoids an empty chart with a
    // chip highlighted that is no longer in the list.
    TCL.distChapter = null;
    await tclLoadDistribution();
}

function tclSetDistChapter(cid) {
    TCL.distChapter = cid;
    TCL.openBand = null;
    tclLoadDistribution();
}

function tclBands(d, ns) {
    const bands = d.bands || [];
    const max = Math.max(1, ...bands.map(b => b.count || 0));
    return `
    <div class="tcl-hist">
      ${bands.map((b, i) => `
        <button class="tcl-hbar ${b.count ? '' : 'empty'}
                 ${b.lo < 40 ? 'bad' : b.lo >= 60 ? 'good' : ''}"
          onclick="tclToggleBand('${ns}-${i}')" ${b.count ? '' : 'disabled'}>
          <div class="tcl-hcount">${b.count}</div>
          <div class="tcl-hfill" style="height:${(b.count / max * 100).toFixed(0)}%"></div>
          <div class="tcl-hlabel">${esc(b.label)}</div>
        </button>`).join('')}
    </div>
    ${bands.map((b, i) => `
      <div class="tcl-bandlist hidden" id="tcl-band-${ns}-${i}">
        <div class="tcl-bandhead">${b.count} students at ${esc(b.label)}</div>
        ${b.students.map(s => `
          <div class="th-att" onclick="openStudent('${esc(s.uid)}')">
            ${thAvatar(s)}
            <div class="th-att-body">
              <div class="th-att-name">${esc(s.name)}</div>
              <div class="th-att-reason">Getting ${tclPct(s.accuracy)} right${s.sample
            ? ` · from ${tclN(s.sample, 'question')}` : ''}</div>
            </div>
          </div>`).join('')}
      </div>`).join('')}`;
}

function tclToggleBand(id) {
    const el = $(`tcl-band-${id}`);
    if (!el) return;
    const wasHidden = el.classList.contains('hidden');
    document.querySelectorAll('.tcl-bandlist').forEach(
        e => e.classList.add('hidden'));
    if (wasHidden) el.classList.remove('hidden');
}



/* ════════════════════════════════════════════════════════════════
   QUESTION DETAIL — which wrong option the class agreed on

   The single most teachable artefact in the database. A teacher does
   not need "22 students got this wrong" — that is a score. She needs
   "22 students all chose C", which is a misconception with a name and
   the difference between "revise the chapter" and "tomorrow I open
   with why C is wrong".

   Loaded on tap only: it reads question_results, which is per student
   per attempt and the most expensive query in the tab.
   ════════════════════════════════════════════════════════════════ */

async function tclOpenQuestion(baseId) {
    const sheet = $('pt-sheet');
    $('pt-sheet-title').textContent = 'Question';
    $('pt-sheet-body').innerHTML = skeleton(2);
    sheet.classList.remove('hidden');

    let d;
    try {
        d = await apiCall(
            `/api/teacher/class/${TC.classKey}/v2/question/${encodeURIComponent(baseId)}`);
    } catch (e) {
        $('pt-sheet-body').innerHTML = emptyState('fa-triangle-exclamation',
            "Couldn't load this question", e.message || '');
        return;
    }

    const conv = d.converged_on;
    const opts = (d.options || []).slice().sort((a, b) =>
        (a.id || '').localeCompare(b.id || ''));
    const maxChose = Math.max(1, ...opts.map(o => o.chose_count || 0));

    $('pt-sheet-body').innerHTML = `
    <div class="th-sheet">
      ${conv ? `
        <div class="pt-sec th-sec tcl-converge">
          <div class="tcl-conv-big">${esc(conv.count)}</div>
          <div class="tcl-conv-txt">
            students all chose <b>option ${esc(conv.option)}</b> —
            ${conv.share}% of everyone who got it wrong.
            <span>That agreement is the misconception. Worth opening
              tomorrow's lesson with.</span>
          </div>
        </div>` : ''}

      <div class="pt-sec th-sec">
        ${d.concept_name ? `<div class="tcl-qmeta">
          <span class="th-tag other">${esc(d.concept_name)}</span>
          ${d.difficulty ? `<span class="th-tag">${esc(d.difficulty)}</span>` : ''}
        </div>` : ''}
        <div class="tcl-qfull">${tclQ(d.question_text)}</div>

        <div class="tcl-opts">
          ${opts.map(o => `
            <div class="tcl-opt ${o.is_correct ? 'right' : ''}
                 ${!o.is_correct && o.chose_count === (conv ? conv.count : -1) && o.chose_count ? 'trap' : ''}">
              <div class="tcl-opt-head">
                <span class="tcl-opt-key">${esc(o.id)}</span>
                <span class="tcl-opt-text">${tclQ(o.text)}</span>
                <span class="tcl-opt-n">
                  ${o.is_correct
            ? `<i class="fa-solid fa-check"></i> ${d.got_it_right} right`
            : (o.chose_count ? `${o.chose_count} chose` : '—')}
                </span>
              </div>
              ${(o.chose_count || o.is_correct) ? `
                <div class="tcl-opt-bar">
                  <div style="width:${((o.is_correct ? d.got_it_right : o.chose_count)
                / Math.max(maxChose, d.got_it_right, 1) * 100).toFixed(0)}%"></div>
                </div>` : ''}
              ${o.chose_students && o.chose_students.length ? `
                <div class="tcl-opt-who">${o.chose_students.map(esc).join(', ')}</div>` : ''}
              ${!o.is_correct && o.why_wrong ? `
                <div class="tcl-opt-why">${tclQ(o.why_wrong)}</div>` : ''}
            </div>`).join('')}
        </div>
      </div>

      ${d.explanation ? `
        <div class="pt-sec th-sec">
          <div class="pt-sec-title">Why the answer is ${esc(d.correct_answer)}</div>
          <div class="tcl-qexpl">${tclQ(d.explanation)}</div>
        </div>` : ''}

      ${(d.common_mistakes || []).length ? `
        <div class="pt-sec th-sec">
          <div class="pt-sec-title">Common mistakes on this one</div>
          ${d.common_mistakes.map(m => `
            <div class="tcl-qmis">${tclQ(m)}</div>`).join('')}
        </div>` : ''}

      ${d.ncert_quote ? `
        <div class="pt-sec th-sec">
          <div class="pt-sec-title">From NCERT</div>
          <div class="tcl-qquote">${tclQ(d.ncert_quote)}</div>
        </div>` : ''}

      <div class="pt-sec th-sec">
        <div class="th-note" style="margin:0">
          ${tclN(d.attempts, 'attempt')} in this class ·
          ${d.got_it_right} right, ${d.got_it_wrong} wrong.
          ${d.capped ? ' Showing the most recent attempts only.' : ''}
        </div>
      </div>
    </div>`;
}

/* ════════════════════════════════════════════════════════════════
   NAVIGATION

   Each of these repaints the shell and then loads whichever sub-view
   is open. They are defined once, here, rather than being wrapped
   after the fact — reassigning a function declaration through
   `window` works in a plain script but silently breaks the moment
   this file is bundled or loaded as a module.
   ════════════════════════════════════════════════════════════════ */

async function tclAfterShell() {
    // No subject is a valid scope — the backend returns every chapter
    // grouped by subject and year. The old `&& TCL.subject` guard meant
    // "All subjects" rendered a shell and never fetched anything.
    if (TCL.view === 'chapters') await tclLoadChapters();
    if (TCL.view === 'distribution') await tclLoadDistribution();
}

async function tclSetSubject(s) {
    TCL.subject = s;
    TCL.dist = null;
    TCL.distChapter = null;
    await renderClassV2();
    await tclAfterShell();
}

async function tclSetLevel(l) {
    TCL.classLevel = l;
    TCL.dist = null;
    await renderClassV2();
    await tclAfterShell();
}

async function tclGoView(v) {
    TCL.view = v;
    document.querySelectorAll('.tcl-vtab').forEach(
        b => b.classList.toggle('on', b.dataset.v === v));
    $('tcl-view').innerHTML = tclViewBody(TCL.data);
    await tclAfterShell();
}


/* ════════════════════════════════════════════════════════════════
   TAKEOVER — 'class' only, everything else falls through
   ════════════════════════════════════════════════════════════════ */

(function () {
    const prev = window.renderTeacherTab;
    if (typeof prev !== 'function') return;

    window.renderTeacherTab = async function (tab) {
        if (tab === 'class' && TC.classKey) {
            await renderClassV2();
            await tclAfterShell();
            return;
        }
        return prev(tab);
    };
})();