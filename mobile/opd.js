/* ════════════════════════════════════════════════════════════════
   NAADI AI — OPD (mobile)  opd.js   [PREMIUM PASS v2]
   The adaptive, phase-based chapter test engine ("case files" in
   the app's medical metaphor). Hub → chapter detail (phase journey)
   → test (shared OMR engine, mode:'opd', in test-engine.js) →
   results (pass-threshold lock, retest, enrichment review cards) →
   intervention cascade.

   Requires shared.js (apiCall, ndToast, safeHtml, escapeHtml),
   practice-hub.js (phOpenSheet / phCloseSheet), concept-studio.js
   (absUrl) and test-engine.js (startOpdTest, fmtTimer). Loaded
   after all of them in app.html.

   ABSOLUTE CONTRACT RULES (build spec §0.5):
     • backend.py is untouched — every request/response field below
       matches the real route definitions, verified line-by-line.
     • Phase names are the REAL backend names (Foundation, Skill
       Building, Mastery, NEET Simulation, Grand Mock, Bonus Pool).
     • phase / is_flex / lock / mastery values are READ from
       responses, never computed or assumed client-side.

   ── v2 CHANGES (frontend only; zero backend edits) ──────────────
   • Case sheet DELETED — it fetched /api/chapter/<id>, summarised
     it, then navigated to a page that fetched the same route again
     and showed it better. One fetch, one tap, one spinner removed.
   • Hub phase strip DELETED — /api/chapters never sends phase_state,
     so it rendered five grey "locked" dashes on every row forever.
     Replaced with fields that endpoint actually returns.
   • Hub mastery % is now honest: averaged over STARTED chapters,
     with an "N of M opened" caption, instead of dividing by all.
   • Chapter banners MERGED into one hero action card — the page now
     resolves to exactly one next action, which kills the duplicate
     red-card bug by construction.
   • Results: the failed-test card and the next_test_locked_reason
     card used to both render (near-identical copy, ~400px apart).
   • opdRetestConfirm no longer hardcodes "40%" — it reads
     pass_threshold like the rest of the file already did.
   • Review aids reordered to the student's read path and collapsed
     behind one disclosure; the why-wrong paragraph is no longer
     printed twice per card.
   • /api/intervention/get-full-context (backend.py:3846 — already
     live, never called by desktop or mobile) is now used to derive
     a REAL, specific pattern diagnosis on the ai_intervention_no_v3
     path, which previously fabricated hardcoded strings client-side
     and labelled them "AI Tutor Analysis".
   ════════════════════════════════════════════════════════════════ */

// ── STATE (one state object per feature, house convention) ──────
const opdState = {
    // Hub
    bySubject: null,            // {Biology:{'11':[..],'12':[..]}, Physics:{..}, Chemistry:{..}}
    caseCache: {},              // chapter_id -> {ch, subject}
    openSubject: null,          // which hub accordion is open
    classLevel: '11',           // '11' | '12' — global, set from the hub toolbar
    hubQuery: '',
    hubFilter: 'all',           // all | active | new | strong
    hubScroll: 0,
    // Chapter
    chapterId: null,
    chapterTitle: '',
    chapterData: null,          // last /api/chapter/<id> response
    // Results
    lastResult: null,           // last submit-with-interventions response
    lastAnsweredCount: 0,       // attempted count captured at submit time
    sessionCache: {},           // session_id -> fresh result (keeps enrichment on re-visit)
    analysisCtx: null,          // {sessionId, testNum, completedAt} for the analysis route
    analysisResults: null,      // last loaded analysis payload — Practice replays it locally
    practice: null,             // {qs, idx, answers, testNum} — client-only, never persisted
    // R2 [3]: baseline for the results delta chip, captured BEFORE the test
    // while test_history is still trustworthy. /api/test/retest DELETES the
    // entry for the test being retaken (new_history = [t for t in
    // test_history if t.test_num != test_num]), and test_history.append()
    // puts a re-taken test at the END of the array — so after a retake the
    // array is neither complete nor ordered by test_num, and reading a
    // baseline out of it at results time is unreliable.
    baseline: null,             // {test_num, percentage, retake} | null
    reviewFilter: 'all',        // all | wrong | skipped | correct
    // Interventions
    interventions: [],
    interventionIndex: 0,
    interventionsFromResults: false,
    intStep: 'review',          // review | verify
    selectedAnswer: null,
    aiQuestion: null,
    _pendingDiagnosis: null,
    _ctxDiagnosis: null,
};

// Real backend phase order: PHASE_ORDER (backend.py:249) + Grand Mock.
const OPD_PHASE_ORDER = ['Foundation', 'Skill Building', 'Mastery', 'NEET Simulation', 'Grand Mock'];
const OPD_JOURNEY_ORDER = OPD_PHASE_ORDER.concat(['Endurance']);
const OPD_PASS_DEFAULT = 40; // fallback only; the live value comes from pass_threshold in responses
const OPD_STRONG = 70;       // display threshold for the "strong" row treatment

// ════════════════════════════════════════════════════════════════
// AI TUTOR CONFIG  ← PUT YOUR DEEPSEEK KEY HERE
// ════════════════════════════════════════════════════════════════
//
//  ⚠️  READ THIS BEFORE YOU PASTE A PRODUCTION KEY  ⚠️
//
//  opd.js is downloaded by every device that opens the app. A key put in
//  `apiKey` below is readable by anyone in about five seconds (devtools →
//  Sources → search "sk-"). DeepSeek keys have no browser-origin restriction,
//  so a leaked key can be used by anyone, billed to you, until you rotate it.
//
//  Two supported modes — switching is ONE line:
//
//   A) DIRECT (key exposed — fine for a throwaway test key):
//        proxy: null,  apiKey: 'sk-...'
//      You'll also need DeepSeek's CORS to accept your app origin. In the
//      Capacitor shell requests come from capacitor://localhost or
//      https://localhost, which some APIs reject.
//
//   B) PROXY  ← THIS IS WHAT IS CONFIGURED BELOW:
//        proxy: '/api/ai/analyse',  apiKey: ''
//      Add one route to backend.py that forwards {messages} to DeepSeek with
//      the key from an env var and returns DeepSeek's JSON back unchanged.
//      In this mode the request goes through apiCall(), so it gets API_BASE,
//      the Firebase ID token and the 401-refresh retry automatically, and the
//      route can sit behind @require_auth like every other route.
//      Set DEEPSEEK_API_KEY in the server environment. Nothing else here
//      changes. (backend.py is untouched by this build itself.)
//
const OPD_AI = {
    enabled: true,

    // ── mode A: direct. Only used when `proxy` below is null.
    //    A key here is shipped to every device — see the warning above.
    apiKey: '',
    endpoint: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',

    // ── mode B: proxy (ACTIVE). The key lives in the server .env as
    //    DEEPSEEK_API_KEY and never reaches this file. `proxy` wins over
    //    `apiKey`, so leave apiKey empty.
    proxy: '/api/ai/analyse',

    // Who writes the verification question that follows the analysis?
    //   'auto'  → the backend's Gemini question normally, but DeepSeek when
    //             the backend falls back to its "last_resort" question, which
    //             is a giveaway (backend.py:1115 builds an MCQ whose correct
    //             option is literally the diagnosis.explanation string).
    //   true    → always DeepSeek
    //   false   → always the backend (Gemini → question bank → last_resort)
    // NOTE: any of these submit through the EXISTING /api/intervention/
    // submit-ai-question route unchanged — it grades against the ai_question
    // object the client echoes back, so a DeepSeek-authored question needs no
    // backend change at all.
    //
    // WAS 'auto'. Changed to true because 'auto' handed the normal case to the
    // backend, and the backend's Gemini prompt (call_gemini_generate_question)
    // is fed the diagnosis dict and NOTHING ELSE — it never sees v1/v2/v3, the
    // options, or which option the student actually chose. It was writing
    // questions from a two-sentence summary of a mistake it had not seen, which
    // is exactly why they came out irrelevant. DeepSeek already holds the full
    // dossier; give the job to the model that has the evidence.
    generateQuestion: true,

    timeoutMs: 25000,
};

function opdDeepSeekReady() {
    if (!OPD_AI.enabled) return false;
    if (OPD_AI.proxy) return true;
    return !!OPD_AI.apiKey && OPD_AI.apiKey !== 'PASTE_DEEPSEEK_KEY_HERE';
}

// Config guard. `proxy` wins over `apiKey`, so leaving a real key in this file
// while a proxy is configured ships a live secret to every device for no
// reason — and if the proxy line is ever removed, the app silently reverts to
// direct mode with that exposed key instead of failing loudly.
(function opdAiConfigCheck() {
    const hasKey = OPD_AI.apiKey && OPD_AI.apiKey !== 'PASTE_DEEPSEEK_KEY_HERE';
    if (OPD_AI.proxy && hasKey) {
        console.warn(
            '[OPD_AI] proxy is set, so apiKey is IGNORED — but it is still shipped in opd.js '
            + 'and readable by anyone. Set apiKey: \'\' and keep the key only in the server .env.');
    }
    if (!OPD_AI.proxy && hasKey) {
        console.warn(
            '[OPD_AI] direct mode: this DeepSeek key is downloaded by every device and is '
            + 'readable in devtools. Fine locally; use the proxy before you ship.');
    }
})();

const OPD_SUBJECTS = [
    { key: 'Biology', icon: 'fa-dna', dept: 'Biology OPD' },
    { key: 'Physics', icon: 'fa-atom', dept: 'Physics OPD' },
    { key: 'Chemistry', icon: 'fa-flask-vial', dept: 'Chemistry OPD' },
];

// Phase chip display. Labels are the REAL backend names; `blurb` is
// static frontend copy so a student knows what a phase asks of them.
const OPD_PHASE_META = {
    'Foundation': { icon: 'fa-seedling', cls: 'foundation', blurb: 'Easy questions — builds your base.' },
    'Skill Building': { icon: 'fa-screwdriver-wrench', cls: 'skill', blurb: 'Mixed difficulty — apply what you learned.' },
    'Mastery': { icon: 'fa-bullseye', cls: 'mastery', blurb: 'Harder questions — prove you own the concept.' },
    'NEET Simulation': { icon: 'fa-bolt', cls: 'neetsim', blurb: 'Exam-pattern questions at exam pace.' },
    'Grand Mock': { icon: 'fa-trophy', cls: 'mock', blurb: 'The full-chapter final. Everything, together.' },
    'Endurance': { icon: 'fa-gift', cls: 'bonus', blurb: 'Optional depth, weakest concepts first. Fully tracked.' },
};

function opdPhaseChip(phase, extraCls) {
    const m = OPD_PHASE_META[phase] || { icon: 'fa-pen-to-square', cls: '' };
    return `<span class="opd-phase-chip ${m.cls} ${extraCls || ''}">
        <i class="fa-solid ${m.icon}"></i> ${escapeHtml(phase || 'Practice')}</span>`;
}

// ════════════════════════════════════════════════════════════════
// MOTION HELPERS — OPD shipped with zero animation of its own.
// Everything below degrades to a no-op under prefers-reduced-motion.
// ════════════════════════════════════════════════════════════════
function opdReduceMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

// Bars render at width:0 with data-w; this fills them on the next
// frame so the CSS transition has something to animate from.
function opdFillBars(root) {
    const scope = root || document;
    const bars = scope.querySelectorAll('[data-w]');
    if (!bars.length) return;
    if (opdReduceMotion()) {
        bars.forEach(b => { b.style.width = b.dataset.w + '%'; b.removeAttribute('data-w'); });
        return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
        bars.forEach((b, i) => {
            b.style.transitionDelay = Math.min(i * 35, 400) + 'ms';
            b.style.width = b.dataset.w + '%';
            b.removeAttribute('data-w');
        });
    }));
}

// Count-up for hero numbers. Reads the target from data-count.
function opdCountUp(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-count]').forEach(el => {
        const target = parseFloat(el.dataset.count) || 0;
        const suffix = el.dataset.countSuffix || '';
        el.removeAttribute('data-count');
        if (opdReduceMotion() || target === 0) { el.textContent = target + suffix; return; }
        const dur = 750, t0 = performance.now();
        const tick = (now) => {
            const p = Math.min(1, (now - t0) / dur);
            const v = Math.round(target * (1 - Math.pow(1 - p, 3))); // easeOutCubic
            el.textContent = v + suffix;
            if (p < 1) requestAnimationFrame(tick);
            else el.textContent = target + suffix;
        };
        requestAnimationFrame(tick);
    });
}

// Staggered entrance for a freshly-rendered container.
function opdReveal(root) {
    if (!root || opdReduceMotion()) return;
    root.classList.add('opd-reveal');
    setTimeout(() => root.classList.remove('opd-reveal'), 1400);
}

function opdAfterRender(root) {
    opdFillBars(root);
    opdCountUp(root);
    opdDrawSparks(root);
}

// ── Inline sparkline (replaces the old `40→55→70%` text run) ──
function opdSparkline(vals) {
    if (!vals || vals.length < 2) return '';
    const w = 62, h = 20, p = 3;
    const min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    const span = Math.max(1, max - min);
    const pts = vals.map((v, i) => {
        const x = p + (i / (vals.length - 1)) * (w - 2 * p);
        const y = h - p - ((v - min) / span) * (h - 2 * p);
        return x.toFixed(1) + ',' + y.toFixed(1);
    });
    const delta = vals[vals.length - 1] - vals[vals.length - 2];
    const cls = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
    const last = pts[pts.length - 1].split(',');
    const arrow = delta > 0 ? 'fa-arrow-trend-up' : delta < 0 ? 'fa-arrow-trend-down' : 'fa-minus';
    return `<span class="opd-spark ${cls}" title="${vals.join(' → ')}%">
        <svg class="opd-spark-svg" viewBox="0 0 ${w} ${h}" aria-hidden="true">
            <polyline class="opd-spark-line" points="${pts.join(' ')}" pathLength="100"></polyline>
            <circle class="opd-spark-dot" cx="${last[0]}" cy="${last[1]}" r="2.3"></circle>
        </svg>
        <b><i class="fa-solid ${arrow}"></i> ${delta > 0 ? '+' : ''}${delta}</b>
    </span>`;
}

function opdDrawSparks(root) {
    if (opdReduceMotion()) return;
    (root || document).querySelectorAll('.opd-spark-svg').forEach((svg, i) => {
        svg.style.animationDelay = Math.min(i * 60, 500) + 'ms';
        svg.classList.add('draw');
    });
}

// ── Score ring with a pass-threshold marker (results hero) ──
function opdScoreRing(pct, threshold, tone) {
    const R = 52, C = 2 * Math.PI * R;
    const dash = (Math.max(0, Math.min(100, pct)) / 100) * C;
    // Threshold tick, drawn at the angle the arc would reach.
    const ang = (Math.max(0, Math.min(100, threshold)) / 100) * 2 * Math.PI - Math.PI / 2;
    const x1 = 64 + (R - 8) * Math.cos(ang), y1 = 64 + (R - 8) * Math.sin(ang);
    const x2 = 64 + (R + 8) * Math.cos(ang), y2 = 64 + (R + 8) * Math.sin(ang);
    return `<svg class="opd-ring ${tone}" viewBox="0 0 128 128" aria-hidden="true">
        <circle class="opd-ring-track" cx="64" cy="64" r="${R}"></circle>
        <circle class="opd-ring-arc" cx="64" cy="64" r="${R}"
            style="stroke-dasharray:${C.toFixed(1)};stroke-dashoffset:${C.toFixed(1)};
                   --opd-ring-to:${(C - dash).toFixed(1)};"></circle>
        <line class="opd-ring-tick" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}"
              x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"></line>
    </svg>`;
}

function opdSpinRing(root) {
    const arc = (root || document).querySelector('.opd-ring-arc');
    if (!arc) return;
    if (opdReduceMotion()) {
        arc.style.strokeDashoffset = arc.style.getPropertyValue('--opd-ring-to');
        return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => arc.classList.add('go')));
}

// Called by test-engine.js when an OPD test starts, so results and
// interventions always know their chapter even on a deep link.
function opdNoteTestContext(o) {
    if (!o) return;
    opdState.chapterId = o.chapterId || opdState.chapterId;
    opdState.chapterTitle = o.chapterTitle || opdState.chapterTitle;
}

// Called by test-engine.js right after a successful OPD submit.
function opdReceiveTestResult(result, answeredCount) {
    opdState.lastResult = result;
    opdState.lastAnsweredCount = answeredCount || 0;
    // Keep the RICH result keyed by session so a later re-visit shows
    // the enrichment cards instead of silently degrading to the
    // reduced /api/test/session/<id> shape.
    if (result && result.session_id) opdState.sessionCache[result.session_id] = result;
    // Interventions fire once, from the fresh results view (desktop:
    // results render first, THEN the pop-up — never on re-visits).
    if (result) result._opdInterventionsShown = false;
}

// The live pass threshold, read from whichever response we last saw.
// Never hardcoded (the retest sheet used to say a literal "40%").
function opdPassThreshold() {
    const d = opdState.chapterData, r = opdState.lastResult;
    return (d && d.pass_threshold) || (r && r.pass_threshold) || OPD_PASS_DEFAULT;
}

// ════════════════════════════════════════════════════════════════
// HUB — subject-wise chapter (case) list.
// Data: 6× GET /api/chapters/<subject>/<class>.
// VERIFIED QUIRK: this endpoint's `progress` has ONLY
// {tests_completed, total_tests, overall_mastery, current_difficulty}
// — no phase_state. The old build rendered a 5-segment phase strip
// from it anyway, so every row of every subject showed five identical
// grey "locked" dashes, permanently. That strip is gone; the row now
// shows only what this endpoint actually returns.
// ════════════════════════════════════════════════════════════════
async function loadOpdHub() {
    const container = document.getElementById('opd-content');
    if (!container) return;

    if (opdState.bySubject) {
        renderOpdHub(container);
        requestAnimationFrame(() => window.scrollTo({ top: opdState.hubScroll || 0 }));
        return;
    }

    // Shell first, skeletons in place of each subject — the old build
    // blocked the whole page on Promise.all behind one text spinner.
    container.innerHTML = `<div class="m-picker-wrap">
        ${opdHubHeaderHtml()}
        <div id="opd-hub-body">${OPD_SUBJECTS.map(opdSubjectSkeletonHtml).join('')}</div>
    </div>`;

    opdState.bySubject = { Biology: {}, Physics: {}, Chemistry: {} };
    let failed = 0;

    await Promise.all(OPD_SUBJECTS.map(async (s) => {
        try {
            const pair = await Promise.all([
                apiCall(`/api/chapters/${s.key}/11`),
                apiCall(`/api/chapters/${s.key}/12`),
            ]);
            opdState.bySubject[s.key] = { '11': pair[0] || [], '12': pair[1] || [] };
        } catch (e) {
            failed++;
            opdState.bySubject[s.key] = { '11': [], '12': [], _error: e.message };
        }
    }));

    if (failed === OPD_SUBJECTS.length) {
        opdState.bySubject = null;
        container.innerHTML = `<div class="m-picker-wrap">
            <div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i>
            <h3>Unable to load case files</h3>
            <p style="margin-top:8px;color:var(--s500);">Check your connection and try again.</p>
            <button class="btn btn-outline" style="margin-top:16px;min-height:48px;" onclick="opdRetryHub()">
                <i class="fa-solid fa-rotate-right"></i> Retry</button></div></div>`;
        return;
    }
    renderOpdHub(container);
}

function opdRetryHub() {
    opdState.bySubject = null;
    loadOpdHub();
}

function opdSubjectSkeletonHtml(s) {
    return `<div class="opd-subject-col skel">
        <div class="opd-subject-head">
            <i class="fa-solid ${s.icon}"></i>
            <span class="opd-subject-name">${s.key} OPD</span>
            <span class="opd-sk opd-sk-pct"></span>
        </div>
        <div class="opd-subject-bar"><div style="width:0"></div></div>
        <div class="opd-subject-body open" style="max-height:none;">
            <div class="opd-subject-inner">
                ${'<div class="opd-sk opd-sk-row"></div>'.repeat(3)}
            </div>
        </div>
    </div>`;
}

// Chapters for the ACTIVE class only. Header counts and avg. mastery
// are derived from this, so "2 of 2 cases opened / 58%" now describes
// the class the student is actually looking at.
function opdSubjectChapters(subjectKey) {
    const s = (opdState.bySubject && opdState.bySubject[subjectKey]) || {};
    return s[opdState.classLevel] || [];
}

// Both classes merged — search stays cross-class on purpose, so typing
// a Class XII chapter name while sitting on XI still finds it.
function opdSubjectChaptersAll(subjectKey) {
    const s = (opdState.bySubject && opdState.bySubject[subjectKey]) || {};
    return (s['11'] || []).concat(s['12'] || []);
}

function opdChapterStarted(ch) {
    const p = ch.progress;
    if (!p) return false;
    return (p.tests_completed || 0) > 0 || (p.overall_mastery || 0) > 0;
}

function opdHubHeaderHtml() {
    const chips = [['all', 'All'], ['active', 'In progress'], ['new', 'Not started'], ['strong', 'Strong']];
    return `<div class="mdash-board" style="margin-bottom:14px;">
            <div class="kicker">Ward Rounds · Case Files</div>
            <h2>OPD</h2>
            <p>Adaptive chapter tests — 5-phase journeys with concept interventions.</p>
        </div>
        <div class="opd-classseg" role="tablist" aria-label="Class">
            <span class="opd-classseg-ind ${opdState.classLevel === '12' ? 'right' : ''}"></span>
            <button type="button" role="tab" aria-selected="${opdState.classLevel === '11'}"
                    class="${opdState.classLevel === '11' ? 'on' : ''}"
                    onclick="opdSetClass('11')">Class 11</button>
            <button type="button" role="tab" aria-selected="${opdState.classLevel === '12'}"
                    class="${opdState.classLevel === '12' ? 'on' : ''}"
                    onclick="opdSetClass('12')">Class 12</button>
        </div>
        <div class="opd-toolbar">
            <div class="opd-search">
                <i class="fa-solid fa-magnifying-glass"></i>
                <input id="opd-search-input" type="search" inputmode="search"
                       placeholder="Search all chapters…" autocomplete="off"
                       value="${escapeHtml(opdState.hubQuery)}"
                       oninput="opdOnSearch(this.value)">
                <button class="opd-search-clear ${opdState.hubQuery ? 'show' : ''}"
                        aria-label="Clear search" onclick="opdClearSearch()">
                    <i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="opd-filters" id="opd-filters">
                ${chips.map(c => `<button class="opd-fchip ${opdState.hubFilter === c[0] ? 'on' : ''}"
                        onclick="opdSetFilter('${c[0]}')">${c[1]}</button>`).join('')}
            </div>
        </div>`;
}

function renderOpdHub(container) {
    container = container || document.getElementById('opd-content');
    if (!container) return;
    opdState.caseCache = {};

    // Class must be settled BEFORE openSubject: opdSubjectChapters()
    // is class-scoped, so seeding in the other order picks the accordion
    // default from the wrong class.
    // Default class (once, globally): XII if the student has progress
    // anywhere in XII, else XI. Only seeded on first paint.
    if (!opdState._classSeeded) {
        const any12 = OPD_SUBJECTS.some(s =>
            ((opdState.bySubject[s.key] || {})['12'] || []).some(opdChapterStarted));
        const has11 = OPD_SUBJECTS.some(s => ((opdState.bySubject[s.key] || {})['11'] || []).length);
        opdState.classLevel = any12 ? '12' : (has11 ? '11' : '12');
        opdState._classSeeded = true;
    }

    // Default-open subject = most chapters with progress in this class.
    if (!opdState.openSubject) {
        let best = 'Biology', bestCount = -1;
        OPD_SUBJECTS.forEach(s => {
            const n = opdSubjectChapters(s.key).filter(opdChapterStarted).length;
            if (n > bestCount) { bestCount = n; best = s.key; }
        });
        opdState.openSubject = best;
    }

    container.innerHTML = `<div class="m-picker-wrap">
        ${opdHubHeaderHtml()}
        <div id="opd-hub-body"></div>
    </div>`;
    opdRenderHubBody();
}

// Re-renders ONLY the list, so the search field never loses focus.
function opdRenderHubBody() {
    const body = document.getElementById('opd-hub-body');
    if (!body) return;
    opdState.caseCache = {};
    body.innerHTML = opdState.hubQuery.trim()
        ? opdSearchResultsHtml()
        : OPD_SUBJECTS.map(s => opdSubjectHtml(s)).join('');
    opdAfterRender(body);
}

function opdMatchesFilter(ch) {
    const m = ch.progress ? (ch.progress.overall_mastery || 0) : 0;
    switch (opdState.hubFilter) {
        case 'active': return opdChapterStarted(ch) && m < OPD_STRONG;
        case 'new': return !opdChapterStarted(ch);
        case 'strong': return m >= OPD_STRONG;
        default: return true;
    }
}

// ── Search: flat, cross-subject, client-side over cached data. ──
function opdSearchResultsHtml() {
    const q = opdState.hubQuery.trim().toLowerCase();
    let out = '', total = 0;
    OPD_SUBJECTS.forEach(s => {
        const hits = opdSubjectChaptersAll(s.key).filter(ch =>
            String(ch.chapter_title || ch.chapter_id || '').toLowerCase().indexOf(q) !== -1
            && opdMatchesFilter(ch));
        if (!hits.length) return;
        total += hits.length;
        out += `<div class="opd-searchgroup">
            <div class="opd-class-label"><i class="fa-solid ${s.icon}"></i> ${s.key}</div>
            ${hits.map(ch => opdCaseRowHtml(ch, s.key, q)).join('')}
        </div>`;
    });
    if (!total) {
        return `<div class="opd-empty">
            <i class="fa-solid fa-magnifying-glass"></i>
            <h4>No chapters match “${escapeHtml(opdState.hubQuery)}”</h4>
            <p>Try a shorter word, or clear the filters.</p>
            <button class="btn btn-outline btn-sm" style="min-height:40px;margin-top:12px;"
                onclick="opdClearSearch()">Clear search</button>
        </div>`;
    }
    return `<div class="opd-searchcount">${total} chapter${total === 1 ? '' : 's'} found</div>` + out;
}

function opdOnSearch(v) {
    opdState.hubQuery = v || '';
    const clear = document.querySelector('.opd-search-clear');
    if (clear) clear.classList.toggle('show', !!opdState.hubQuery);
    opdRenderHubBody();
}

function opdClearSearch() {
    opdState.hubQuery = '';
    const input = document.getElementById('opd-search-input');
    if (input) input.value = '';
    const clear = document.querySelector('.opd-search-clear');
    if (clear) clear.classList.remove('show');
    opdRenderHubBody();
}

function opdSetFilter(k) {
    opdState.hubFilter = k;
    document.querySelectorAll('#opd-filters .opd-fchip').forEach(b =>
        b.classList.toggle('on', (b.getAttribute('onclick') || '').indexOf("'" + k + "'") !== -1));
    opdRenderHubBody();
}

function opdSubjectHtml(s) {
    const chapters = opdSubjectChapters(s.key);
    const started = chapters.filter(opdChapterStarted);
    // HONEST math: average over chapters actually STARTED. The old
    // build divided by ALL chapters, so a student with four 90%
    // chapters out of 44 was greeted with "Biology OPD — 8%".
    const pct = started.length
        ? Math.round(started.reduce((sum, c) => sum + (c.progress.overall_mastery || 0), 0) / started.length)
        : 0;
    const open = opdState.openSubject === s.key;
    const cls = opdState.classLevel;
    const bs = opdState.bySubject[s.key] || {};
    const list = (bs[cls] || []).filter(opdMatchesFilter);
    const counts = { '11': (bs['11'] || []).length, '12': (bs['12'] || []).length };
    const other = cls === '11' ? '12' : '11';

    let rows;
    if (bs._error) {
        rows = `<div class="opd-empty small"><i class="fa-solid fa-circle-exclamation"></i>
            <h4>Couldn't load ${s.key}</h4>
            <button class="btn btn-outline btn-sm" style="min-height:40px;margin-top:10px;"
                onclick="opdRetryHub()">Retry</button></div>`;
    } else if (!counts['11'] && !counts['12']) {
        rows = `<div class="opd-empty small"><i class="fa-solid fa-folder-open"></i>
            <h4>No chapters uploaded yet</h4></div>`;
    } else if (!(bs[cls] || []).length) {
        // Empty for THIS class but populated for the other — point there
        // rather than implying the subject has no content at all.
        rows = `<div class="opd-empty small"><i class="fa-solid fa-folder-open"></i>
            <h4>No Class ${cls} chapters yet</h4>
            <button class="btn btn-outline btn-sm" style="min-height:40px;margin-top:10px;"
                onclick="opdSetClass('${other}')">View Class ${other} (${counts[other]})</button></div>`;
    } else if (!list.length) {
        rows = `<div class="opd-empty small"><i class="fa-solid fa-filter-circle-xmark"></i>
            <h4>Nothing here with this filter</h4>
            <button class="btn btn-outline btn-sm" style="min-height:40px;margin-top:10px;"
                onclick="opdSetFilter('all')">Show all</button></div>`;
    } else {
        rows = list.map(ch => opdCaseRowHtml(ch, s.key)).join('');
    }

    // Class control now lives once in the hub toolbar (opdHubHeaderHtml),
    // matching Concept Studio's picker-level segmented control.
    const toggle = '';

    return `<div class="opd-subject-col ${open ? 'open' : ''}" data-subject="${s.key}">
        <button class="opd-subject-head" onclick="toggleOpdSubject('${s.key}')" aria-expanded="${open}">
            <i class="fa-solid ${s.icon}"></i>
            <span class="opd-subject-name">${s.key} OPD
                <em>${started.length} of ${chapters.length} cases opened</em></span>
            <span class="opd-subject-pct">
                <b data-count="${pct}" data-count-suffix="%">0%</b>
                <em>${started.length ? 'avg. mastery' : 'not started'}</em>
            </span>
            <i class="fa-solid fa-chevron-down opd-subject-chevron ${open ? 'open' : ''}"
               id="opd-chevron-${s.key}"></i>
        </button>
        <div class="opd-subject-bar"><div data-w="${pct}" style="width:0"></div></div>
        <div class="opd-subject-body ${open ? 'open' : ''}" id="opd-body-${s.key}"
             ${open ? 'style="max-height:none;"' : ''}>
            <div class="opd-subject-inner">${toggle}<div class="opd-rows">${rows}</div></div>
        </div>
    </div>`;
}

// Row shows ONLY what /api/chapters actually returns. The old
// 5-segment phase strip is deleted (see block comment above).
function opdCaseRowHtml(ch, subjectKey, highlight) {
    opdState.caseCache[ch.chapter_id] = { ch: ch, subject: subjectKey };
    const prog = ch.progress || null;
    const unlocked = ch.is_unlocked !== false;
    const mastery = prog ? (prog.overall_mastery || 0) : 0;
    const started = opdChapterStarted(ch);
    const num = ch.chapter_number != null ? ch.chapter_number : '';
    const rawTitle = String(ch.chapter_title || ch.chapter_id || '');
    const idEsc = String(ch.chapter_id).replace(/'/g, "\\'");

    let title = escapeHtml(rawTitle);
    if (highlight) {
        const i = rawTitle.toLowerCase().indexOf(highlight);
        if (i >= 0) {
            title = escapeHtml(rawTitle.slice(0, i))
                + '<mark>' + escapeHtml(rawTitle.slice(i, i + highlight.length)) + '</mark>'
                + escapeHtml(rawTitle.slice(i + highlight.length));
        }
    }

    if (!unlocked) {
        return `<div class="opd-case-row locked">
            <span class="opd-case-num"><i class="fa-solid fa-lock"></i></span>
            <div class="opd-case-info"><div class="opd-case-title">${title}</div>
                <div class="opd-case-sub">Locked case</div></div>
        </div>`;
    }

    // Real progress from THIS endpoint: tests_completed / total_tests.
    const done = prog ? (prog.tests_completed || 0) : 0;
    const totalT = prog ? (prog.total_tests || 0) : 0;
    const tPct = totalT ? Math.round(done / totalT * 100) : 0;
    const level = prog && prog.current_difficulty ? prog.current_difficulty : '';
    const strong = mastery >= OPD_STRONG;

    let sub, right;
    if (!started) {
        sub = `<div class="opd-case-sub">Not started</div>`;
        right = `<span class="opd-case-pct new">Start <i class="fa-solid fa-arrow-right"></i></span>`;
    } else {
        sub = `<div class="opd-case-meta">
            <span class="opd-case-bar"><i class="${strong ? 'good' : 'warm'}" data-w="${tPct}" style="width:0"></i></span>
            <span class="opd-case-tests">${done}/${totalT || '—'} tests</span>
            ${level ? `<span class="opd-case-level">${escapeHtml(level)}</span>` : ''}
        </div>`;
        right = strong
            ? `<span class="opd-case-pct good"><i class="fa-solid fa-circle-check"></i> ${mastery}%</span>`
            : `<span class="opd-case-pct warm">${mastery}%</span>`;
    }

    return `<div class="opd-case-row ${started ? 'active' : 'fresh'} ${strong ? 'strong' : ''}"
         onclick="opdOpenCase('${idEsc}')" role="button" tabindex="0">
        <span class="opd-case-num">${num}</span>
        <div class="opd-case-info">
            <div class="opd-case-title">${title}</div>
            ${sub}
        </div>
        ${right}
    </div>`;
}

function toggleOpdSubject(subjectKey) {
    const col = document.querySelector('.opd-subject-col[data-subject="' + subjectKey + '"]');
    const body = document.getElementById('opd-body-' + subjectKey);
    const chevron = document.getElementById('opd-chevron-' + subjectKey);
    if (!body) return;
    const willOpen = !body.classList.contains('open');

    // Height-animated accordion (was an instant display:none/block flip).
    if (willOpen) {
        body.classList.add('open');
        const inner = body.firstElementChild;
        const h = inner ? inner.offsetHeight : 0;
        if (opdReduceMotion()) {
            body.style.maxHeight = 'none';
        } else {
            body.style.maxHeight = '0px';
            void body.offsetHeight; // force reflow so 0px is the real start value
            requestAnimationFrame(() => { body.style.maxHeight = h + 'px'; });
            body.addEventListener('transitionend', function done() {
                body.style.maxHeight = 'none';
                body.removeEventListener('transitionend', done);
            });
        }
        opdFillBars(body);
    } else {
        const inner = body.firstElementChild;
        body.style.maxHeight = (inner ? inner.offsetHeight : 0) + 'px';
        requestAnimationFrame(() => {
            body.style.maxHeight = '0px';
            body.classList.remove('open');
        });
    }
    if (chevron) chevron.classList.toggle('open', willOpen);
    if (col) col.classList.toggle('open', willOpen);
    opdState.openSubject = willOpen ? subjectKey : null;
}

// Global class switch, mirroring Concept Studio's setReviseClass.
// Every subject re-renders, because header counts and avg. mastery are
// class-scoped now — a partial row swap would leave stale percentages.
function opdSetClass(cls) {
    cls = String(cls);
    if (opdState.classLevel === cls) return;
    opdState.classLevel = cls;

    // The toolbar lives OUTSIDE #opd-hub-body, so it isn't repainted by
    // opdRenderHubBody — update it here. Both selectors are handled so
    // the desktop layer's own markup stays in sync.
    document.querySelectorAll('.opd-classseg, .opddesk-classseg').forEach(seg => {
        seg.querySelectorAll('button').forEach(b => {
            const on = (b.getAttribute('onclick') || '').indexOf("'" + cls + "'") !== -1;
            b.classList.toggle('on', on);
            b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        const ind = seg.querySelector('.opd-classseg-ind, .opddesk-classseg-ind');
        if (ind) ind.classList.toggle('right', cls === '12');
    });
    opdRenderHubBody();
}

// Row tap → straight to the chapter page. The old build opened a
// bottom sheet that fetched /api/chapter/<id>, summarised the phase
// rows, and offered a button that navigated to a page which fetched
// the SAME route again and rendered the same data more completely.
function opdOpenCase(chapterId) {
    const entry = opdState.caseCache[chapterId];
    if (!entry) return;
    const ch = entry.ch;
    if (ch.is_unlocked === false) { ndToast('This case is locked.', 'info'); return; }
    opdState.hubScroll = window.scrollY || 0;
    navigate('opd-chapter', {
        chapter_id: chapterId,
        chapter_title: ch.chapter_title || ch.chapter_id,
    });
}

// ════════════════════════════════════════════════════════════════
// CHAPTER DETAIL / CASE VIEW — GET /api/chapter/<id>.
// Order is now: head → the single next action → journey → concepts
// → insight. The old build stacked banners ABOVE the title, so a
// locked chapter greeted you with a red box before you could see
// which chapter you'd opened.
// ════════════════════════════════════════════════════════════════
async function loadOpdChapter(chapterId, chapterTitle) {
    const container = document.getElementById('opd-chapter-content');
    if (!container) return;
    if (!chapterId) {
        container.innerHTML = `<div class="m-picker-wrap"><div class="empty-state">
            <i class="fa-solid fa-circle-exclamation"></i><h3>No case selected</h3>
            <button class="btn btn-outline" style="margin-top:16px;min-height:48px;" onclick="navigate('opd')">
                <i class="fa-solid fa-arrow-left"></i> Back to OPD</button></div></div>`;
        return;
    }
    opdState.chapterId = chapterId;
    if (chapterTitle) opdState.chapterTitle = chapterTitle;

    container.innerHTML = `<div class="m-picker-wrap">
        ${opdBackBarHtml('Back to OPD', "navigate('opd')")}
        <div class="opd-sk opd-sk-head"></div>
        <div class="opd-sk opd-sk-hero"></div>
        ${'<div class="opd-sk opd-sk-row"></div>'.repeat(3)}
    </div>`;

    try {
        const data = await apiCall(`/api/chapter/${chapterId}`);
        opdState.chapterData = data;
        opdState.chapterTitle = (data.chapter && data.chapter.chapter_title) || opdState.chapterTitle || chapterId;
        const tb = document.getElementById('topbar-title');
        if (tb) tb.textContent = opdState.chapterTitle;
        renderOpdChapter(data, container);
    } catch (e) {
        const idEsc = String(chapterId).replace(/'/g, "\\'");
        container.innerHTML = `<div class="m-picker-wrap">
            ${opdBackBarHtml('Back to OPD', "navigate('opd')")}
            <div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i>
            <h3>Error loading case</h3><p style="margin-top:8px;color:var(--s500);">${escapeHtml(e.message)}</p>
            <button class="btn btn-outline" style="margin-top:16px;min-height:48px;"
                onclick="loadOpdChapter('${idEsc}')">
                <i class="fa-solid fa-rotate-right"></i> Retry</button></div></div>`;
    }
}

function opdBackBarHtml(label, action) {
    return `<button class="opd-backbar" onclick="${action}">
        <i class="fa-solid fa-chevron-left"></i><span>${escapeHtml(label)}</span></button>`;
}

// Sum of tests_taken across all 5 real phases (desktop sumTestsTaken).
function opdSumTestsTaken(prog) {
    const ps = (prog && prog.phase_state) || {};
    return OPD_PHASE_ORDER.reduce((s, n) => s + ((ps[n] || {}).tests_taken || 0), 0);
}

// R2 [3]: snapshot the comparison point while the data is still good.
// For a fresh test, that's the highest-numbered test you've completed.
function opdCaptureBaseline(retakeNum) {
    const hist = ((opdState.chapterData || {}).progress || {}).test_history || [];
    if (!hist.length) { opdState.baseline = null; return; }
    if (retakeNum != null) {
        // Retaking: the meaningful baseline is YOUR PREVIOUS ATTEMPT at this
        // same test. Capture it now — the retest route is about to delete it.
        const same = hist.filter(t => t.test_num === Number(retakeNum));
        if (same.length) {
            const last = same[same.length - 1];
            opdState.baseline = { test_num: last.test_num, percentage: last.percentage || 0, retake: true };
            return;
        }
    }
    let best = null;
    hist.forEach(t => { if (!best || (t.test_num || 0) > (best.test_num || 0)) best = t; });
    opdState.baseline = best
        ? { test_num: best.test_num, percentage: best.percentage || 0, retake: false }
        : null;
}

function opdStartNextTest() {
    opdCaptureBaseline(null);
    navigate('opd-test', { chapter_id: opdState.chapterId, chapter_title: opdState.chapterTitle });
}
function opdBackToChapter() {
    navigate('opd-chapter', { chapter_id: opdState.chapterId, chapter_title: opdState.chapterTitle });
}

function renderOpdChapter(data, container) {
    const ch = data.chapter || {};
    const prog = data.progress || {};
    const insights = data.insights || {};

    container.innerHTML = `<div class="m-picker-wrap">
        ${opdBackBarHtml('Back to OPD', "navigate('opd')")}

        <div class="opd-chapter-head">
            <h2>${escapeHtml(ch.chapter_title || opdState.chapterId)}</h2>
            <p>${ch.total_concepts || 0} concepts · ${ch.total_questions || 0} questions</p>
            <div class="opd-chapter-stats">
                <div><b data-count="${prog.overall_mastery || 0}" data-count-suffix="%">0%</b><span>Mastery</span></div>
                <div><b>${escapeHtml(prog.current_difficulty || 'Easy')}</b><span>Current level</span></div>
            </div>
        </div>

        ${opdHeroActionHtml(data)}

        <div class="mdash-section-label" style="padding:0;margin:18px 0 8px;">
            <i class="fa-solid fa-list-check"></i> Test Journey</div>
        <div class="opd-journey">${renderOpdJourney(prog, data)}</div>

        <div class="mdash-section-label" style="padding:0;margin:18px 0 8px;">
            <i class="fa-solid fa-chart-simple"></i> Overall mastery by concept</div>
        ${opdConceptsHtml(prog)}

        ${opdInsightHtml(data)}
    </div>`;

    opdAfterRender(container);
    const wrap = container.querySelector('.m-picker-wrap');
    if (wrap) opdReveal(wrap);
}

// R2 [7b]: backend.py:1852 computes
//     struggling = sum(1 for c in concept_mastery.values()
//                      if c.get("mastery_score", 0) < 50)
// and then says "⚠️ {struggling} concepts need attention." That count includes
// every concept sitting at 0% that has NEVER BEEN TESTED (status
// "not_started") — so a chapter with 20 concepts and 2 tested reports
// "18 concepts need attention". They aren't struggling; they're untouched.
// The rule ignores `status` entirely.
//
// We can't edit backend.py, so we stop repeating a misleading number and
// build the line from the `status` the backend already assigned per concept.
// When real struggling concepts exist we say nothing here at all — the
// "Focus here first" callout above already names the actual concept, which is
// strictly more useful than a count.
function opdInsightHtml(data) {
    const prog = data.progress || {};
    const insights = data.insights || {};
    const cm = prog.concept_mastery || {};
    const vals = Object.keys(cm).map(k => cm[k] || {});
    if (!vals.length) return '';

    const struggling = vals.filter(c => c.status === 'struggling').length;
    const notStarted = vals.filter(c => !c.status || c.status === 'not_started').length;

    // Real struggling concepts -> the focus callout already covers it, accurately.
    if (struggling > 0) return '';

    let body;
    if (insights.medium_ready && (prog.current_difficulty || 'Easy') === 'Easy') {
        // backend's own message, minus the emoji we purged in v2
        body = opdStripEmoji(insights.recommendation)
            || "You're ready for Medium difficulty — a couple more tests will unlock it.";
    } else if (notStarted > 0) {
        body = `Nothing is going wrong. ${notStarted} concept${notStarted === 1 ? " hasn't" : "s haven't"}
            come up in a test yet — they'll appear as you work through the phases.`;
    } else {
        body = opdStripEmoji(insights.recommendation) || 'Good progress. Keep going.';
    }

    return `<div class="opd-note">
        <i class="fa-solid fa-lightbulb"></i>
        <div><b>Consultant's insight</b><p>${safeHtml(body)}</p></div>
    </div>`;
}

// Backend embeds emoji in its copy (⚠️ 🎖️ ✅ 🤖 🎉). v2 purged emoji from OPD.
function opdStripEmoji(str) {
    if (!str) return '';
    return String(str)
        .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

// ── ONE hero card = exactly ONE next action ──────────────────────
// The old build could render a "Pending reviews" banner AND a "Next
// Test Locked" banner AND a start block AND a "Consultant's Insight"
// banner, all in the same red/indigo visual family, stacked above the
// chapter title. Collapsing them here means the duplicate-banner class
// of bug cannot recur.
function opdHeroActionHtml(data) {
    const prog = data.progress || {};
    const params = data.test_params || {};
    const nextTest = data.next_test_num;
    const nextTestAvailable = data.next_test_available !== undefined
        ? data.next_test_available : prog.next_test_available;
    const lockedReason = data.locked_reason || null;
    const lastTestFailed = data.last_test_failed || false;
    const passThreshold = data.pass_threshold || OPD_PASS_DEFAULT;
    const allDone = prog.chapter_fully_complete || false;
    const pending = prog.pending_interventions || [];

    if (pending.length) {
        return `<div class="opd-hero red">
            <div class="opd-hero-tag"><i class="fa-solid fa-clipboard-check"></i> Blocked</div>
            <h3>${pending.length} concept review${pending.length === 1 ? '' : 's'} to clear</h3>
            <p>These are the concepts you missed. Clearing them is what unlocks Test ${nextTest} —
               it takes a couple of minutes.</p>
            <button class="btn ph-start-btn danger" onclick="resumeOpdInterventions()">
                <i class="fa-solid fa-clipboard-check"></i> Start reviews</button>
        </div>`;
    }

    if (allDone) {
        return `<div class="opd-hero green">
            <div class="opd-hero-tag"><i class="fa-solid fa-circle-check"></i> Complete</div>
            <h3>All 5 phases done</h3>
            <p>Journey complete. Endurance practice — ordered by your weakest concepts — sits below.</p>
            <button class="btn btn-outline" style="min-height:48px;" onclick="navigate('opd')">
                <i class="fa-solid fa-notes-medical"></i> Pick the next case</button>
        </div>`;
    }

    if (!nextTestAvailable && lastTestFailed) {
        const hist = prog.test_history || [];
        const lastTest = hist.length ? hist[hist.length - 1] : null;
        const failedNum = lastTest ? lastTest.test_num : (nextTest - 1);
        const gotPct = lastTest ? (lastTest.percentage || 0) : null;
        return `<div class="opd-hero red">
            <div class="opd-hero-tag"><i class="fa-solid fa-lock"></i> Locked</div>
            <h3>Retake Test ${failedNum} to continue</h3>
            <p>${escapeHtml(lockedReason
            || 'You scored ' + (gotPct !== null ? gotPct + '%' : 'below the bar')
            + ' — you need ' + passThreshold + '% to move on. The same questions come back.')}</p>
            <button class="btn ph-start-btn danger" onclick="opdRetestConfirm(null, ${failedNum})">
                <i class="fa-solid fa-rotate-right"></i> Retake Test ${failedNum}</button>
        </div>`;
    }

    if (!nextTestAvailable) {
        return `<div class="opd-hero muted">
            <div class="opd-hero-tag"><i class="fa-solid fa-lock"></i> Locked</div>
            <h3>Next test isn't open yet</h3>
            <p>${escapeHtml(lockedReason || 'Finish the outstanding work on this case first.')}</p>
        </div>`;
    }

    const phase = params.phase;
    const meta = OPD_PHASE_META[phase] || {};
    const isMock = phase === 'Grand Mock';
    const isBonus = phase === 'Endurance';
    return `<div class="opd-hero go">
        <div class="opd-hero-top">
            ${opdPhaseChip(phase)}
            ${meta.blurb ? `<span class="opd-hero-blurb">${escapeHtml(meta.blurb)}</span>` : ''}
        </div>
        <h3>${isBonus ? 'Endurance' : isMock ? 'Grand Mock' : 'Test ' + nextTest}</h3>
        <p class="opd-hero-spec">
            <span><i class="fa-solid fa-list-ol"></i> ${params.total_per_test || '~'} questions</span>
            <span><i class="fa-regular fa-clock"></i> ${params.time_minutes || '~'} min</span>
            ${params.difficulty ? `<span><i class="fa-solid fa-gauge"></i> ${escapeHtml(params.difficulty)}</span>` : ''}
        </p>
        <button class="btn ph-start-btn ${isMock ? 'mock' : ''}" onclick="opdStartNextTest()">
            <i class="fa-solid ${isMock ? 'fa-trophy' : isBonus ? 'fa-gift' : 'fa-play'}"></i>
            ${isBonus ? 'Start Endurance' : isMock ? 'Start the Grand Mock' : 'Start Test ' + nextTest}
        </button>
    </div>`;
}

// Port of the desktop renderTestThumbnails: completed tests grouped
// by the phase the backend tagged them with; the active phase gets
// one interactive next/locked/review tile; remaining guaranteed
// slots (from phase_progress min_tests) render as placeholders with
// correct, never-repeating numbering.
// v2: ONE retake affordance (the hero). The tile badge is now a
// status marker, and every tile clicks through to its analysis — the
// old build had a badge, a "🔁 Required" line AND a banner all firing
// the same retest, with the tile itself going somewhere else.
function renderOpdJourney(prog, data) {
    const testHistory = prog.test_history || [];
    const activePhase = (data.test_params && data.test_params.phase) || null;
    const nextTestNum = data.next_test_num;
    const nextTestAvailable = data.next_test_available;
    const hasPending = (prog.pending_interventions || []).length > 0;
    const passThreshold = data.pass_threshold || OPD_PASS_DEFAULT;
    const phaseProgress = data.phase_progress || {};

    const historyByPhase = {};
    testHistory.forEach(t => {
        const ph = t.phase || 'Foundation'; // fallback for pre-migration entries
        (historyByPhase[ph] = historyByPhase[ph] || []).push(t);
    });
    Object.keys(historyByPhase).forEach(k => historyByPhase[k].sort((a, b) => a.test_num - b.test_num));

    // Running slot cursor for placeholder numbering.
    // v1 BUG (inherited from the desktop port, fixed here): future
    // phases used `dumbStartNum = hist.length + 1`, which is always 1
    // when a phase has no history — so with Foundation showing Tests
    // 1-4, the Mastery placeholders ALSO rendered "Test 1-4", and NEET
    // Simulation "Test 1-3". backend.py numbers test_num globally
    // across the chapter (backend.py:2967), never per phase. The cursor
    // below continues from the highest known test number instead.
    let slotCursor = Math.max(nextTestNum || 0, 0);
    testHistory.forEach(t => { slotCursor = Math.max(slotCursor, t.test_num || 0); });

    let html = '';
    let anySection = false;

    for (const phaseName of OPD_JOURNEY_ORDER) {
        const hist = historyByPhase[phaseName] || [];
        const isActivePhase = activePhase === phaseName;
        const pInfo = phaseProgress[phaseName] || {};
        const minTests = pInfo.min_tests || 0;
        const isFuturePhase = hist.length === 0 && !isActivePhase && phaseName !== 'Bonus Pool' && minTests > 0;
        if (hist.length === 0 && !isActivePhase && !isFuturePhase) continue;
        anySection = true;

        const meta = OPD_PHASE_META[phaseName] || {};
        html += `<div class="opd-journey-phase ${isActivePhase ? 'active' : ''} ${isFuturePhase ? 'future' : ''}">
            <div class="opd-journey-phase-head">
                ${opdPhaseChip(phaseName, isFuturePhase ? 'future' : '')}
                ${isFuturePhase ? '<i class="fa-solid fa-lock opd-journey-lock"></i>' : ''}
                ${isActivePhase ? '<span class="opd-journey-now">You are here</span>' : ''}
                <span class="opd-journey-rule"></span>
            </div>
            ${meta.blurb ? `<p class="opd-journey-blurb">${escapeHtml(meta.blurb)}</p>` : ''}
            <div class="opd-journey-scroll"><div class="opd-journey-row">`;

        hist.forEach(h => {
            const pct = h.percentage || 0;
            const isFailed = pct < passThreshold;
            const tone = pct >= OPD_STRONG ? 'good' : pct >= passThreshold ? 'warm' : 'bad';
            let badge = '';
            if (isFailed) badge = `<span class="opd-tile-badge red">RETAKE</span>`;
            else if (h.is_flex) badge = `<span class="opd-tile-badge amber">FLEX</span>`;
            let label = `Test ${h.test_num}`;
            if (phaseName === 'Bonus Pool') label = 'Bonus';
            else if (phaseName === 'Grand Mock') label = 'Mock';
            const sidEsc = String(h.session_id || '').replace(/'/g, "\\'");
            const atEsc = String(h.completed_at || '').replace(/'/g, "\\'");

            html += `<div class="opd-tilewrap">
                <div class="opd-tile ${tone}" role="button" tabindex="0"
                     onclick="viewOpdTestAnalysis('${sidEsc}', ${h.test_num}, '${atEsc}')">
                    ${badge}
                    <b>${pct}%</b><span>${h.score}/${h.total}</span>
                </div>
                <div class="opd-tile-label">${label}</div>
            </div>`;
        });

        // Interactive tile = the immediate next guaranteed slot for the
        // active phase (rendered BEFORE the placeholders so numbering
        // never repeats).
        if (isActivePhase && phaseName !== 'Bonus Pool') {
            let tile;
            if (hasPending) {
                tile = `<div class="opd-tile lockstate" role="button" tabindex="0" onclick="resumeOpdInterventions()">
                    <span class="opd-tile-badge red">REVIEW</span>
                    <i class="fa-solid fa-clipboard-check"></i></div>`;
            } else if (!nextTestAvailable) {
                tile = `<div class="opd-tile lockstate"><span class="opd-tile-badge red">LOCKED</span>
                    <i class="fa-solid fa-lock"></i></div>`;
            } else {
                const mock = phaseName === 'Grand Mock';
                tile = `<div class="opd-tile next ${mock ? 'mock' : ''}" role="button" tabindex="0"
                     onclick="opdStartNextTest()">
                    <i class="fa-solid ${mock ? 'fa-trophy' : 'fa-play'}"></i></div>`;
            }
            const label = phaseName === 'Grand Mock' ? 'Mock' : `Test ${nextTestNum}`;
            html += `<div class="opd-tilewrap wide">${tile}<div class="opd-tile-label strong">${label}</div></div>`;
        }

        // Placeholder slots for the remaining guaranteed tests. The
        // active phase's interactive tile already occupies one of them,
        // hence the -1 (desktop parity).
        const pendingSlotsTotal = Math.max(0, minTests - hist.length);
        const dumbPendingCount = isFuturePhase ? pendingSlotsTotal : Math.max(0, pendingSlotsTotal - 1);
        for (let p = 0; p < dumbPendingCount; p++) {
            slotCursor++;
            const slotLabel = phaseName === 'Grand Mock' ? 'Mock' : `Test ${slotCursor}`;
            html += `<div class="opd-tilewrap">
                <div class="opd-tile placeholder"></div>
                <div class="opd-tile-label dim">${slotLabel}</div>
            </div>`;
        }

        html += `</div></div></div>`;
    }

    if (activePhase === 'Bonus Pool') {
        html += `<button class="btn btn-outline" style="min-height:48px;margin-top:10px;width:100%;"
            onclick="opdStartNextTest()"><i class="fa-solid fa-gift"></i>
            ${historyByPhase['Bonus Pool'] ? 'More bonus practice' : 'Start Bonus Pool'}</button>`;
    }

    if (!anySection) {
        return `<p style="color:var(--s400);font-size:.84rem;padding:8px 2px;">
            The test journey appears after your first test is generated.</p>`;
    }
    return html;
}

// ── Concept mastery: sorted by what needs attention, with a real
//    sparkline instead of a `40→55→70%` text run, and not-started
//    concepts folded away. ──
function opdConceptsHtml(prog) {
    const masteryHistory = prog.concept_mastery_history || [];
    const entries = Object.entries(prog.concept_mastery || {});
    if (!entries.length) {
        return `<div class="opd-concepts"><p style="color:var(--s400);font-size:.82rem;padding:12px;">
            Concept tracking appears after your first test.</p></div>`;
    }

    const RANK = { struggling: 0, learning: 1, mastered: 2, not_started: 3 };
    const rows = entries.map(pair => {
        const cid = pair[0], cm = pair[1] || {};
        const trendScores = masteryHistory
            .map(h => (h.mastery_by_concept || {})[cid])
            .filter(v => v !== undefined);
        return {
            cid: cid,
            name: cm.concept_name || cid,
            mastery: cm.mastery_score || 0,
            status: cm.status || 'not_started',
            trend: trendScores.slice(-4),
        };
    }).sort((a, b) => {
        const ra = RANK[a.status] !== undefined ? RANK[a.status] : 3;
        const rb = RANK[b.status] !== undefined ? RANK[b.status] : 3;
        if (ra !== rb) return ra - rb;
        return a.mastery - b.mastery;
    });

    const live = rows.filter(r => r.status !== 'not_started');
    const fresh = rows.filter(r => r.status === 'not_started');

    // Focus callout: the single weakest struggling concept.
    const focus = live.filter(r => r.status === 'struggling')[0];
    const focusHtml = focus ? `<div class="opd-focus">
        <i class="fa-solid fa-crosshairs"></i>
        <div><b>Focus here first</b>
            <p>${escapeHtml(focus.name)} — ${focus.mastery}% mastery. It's the concept costing you the most marks.</p></div>
    </div>` : '';

    const META = {
        mastered: { icon: 'fa-circle-check', cls: 'good', label: 'Mastered' },
        learning: { icon: 'fa-circle-half-stroke', cls: 'warm', label: 'Learning' },
        struggling: { icon: 'fa-circle-exclamation', cls: 'bad', label: 'Struggling' },
        not_started: { icon: 'fa-circle', cls: '', label: 'Not started' },
    };
    const rowHtml = (r) => {
        const meta = META[r.status] || META.not_started;
        return `<div class="opd-concept-row ${meta.cls}">
            <span class="opd-concept-icon ${meta.cls}">
                <i class="fa-${r.status === 'not_started' ? 'regular' : 'solid'} ${meta.icon}"></i></span>
            <div class="opd-concept-main">
                <div class="opd-concept-name">${escapeHtml(r.name)}</div>
                <div class="opd-concept-bar"><i class="${meta.cls}" data-w="${r.mastery}" style="width:0"></i></div>
                <div class="opd-concept-foot">
                    <span class="opd-concept-status ${meta.cls}">${meta.label}</span>
                    ${opdSparkline(r.trend)}
                </div>
            </div>
            <span class="opd-concept-pct ${meta.cls}">${r.mastery}%</span>
        </div>`;
    };

    return `${focusHtml}
    <div class="opd-concepts">
        ${live.map(rowHtml).join('')
        || '<p style="color:var(--s400);font-size:.82rem;padding:12px;">Nothing tracked yet.</p>'}
        ${fresh.length ? `<details class="opd-concept-more">
            <summary><i class="fa-solid fa-chevron-right"></i> Not started (${fresh.length})</summary>
            <div>${fresh.map(rowHtml).join('')}</div>
        </details>` : ''}
    </div>`;
}

// ════════════════════════════════════════════════════════════════
// RETEST — POST /api/test/retest {chapter_id, test_num}, then
// straight to the test screen: /api/test/generate finds and reuses
// the reset in_progress session (identical questions). All rollback
// is server-side.
// ════════════════════════════════════════════════════════════════
function opdRetestConfirm(chapterId, testNum, chapterTitle) {
    const cid = chapterId || opdState.chapterId;
    if (!cid || !testNum) return;
    if (chapterTitle) opdState.chapterTitle = chapterTitle;
    const cidEsc = String(cid).replace(/'/g, "\\'");
    // Read the live threshold — this sheet used to hardcode "40%"
    // while every other line in the file read pass_threshold.
    const pt = opdPassThreshold();
    phOpenSheet(`
        <div class="ph-sheet-handle"></div>
        <h3 class="ph-sheet-title"><i class="fa-solid fa-rotate-right" style="color:var(--amber);"></i>
            Retake Test ${testNum}?</h3>
        <p class="ph-sheet-sub">The same questions will appear again. You need at least
            <b>${pt}%</b> to unlock the next test.</p>
        <div style="display:flex;gap:10px;margin-top:14px;">
            <button class="btn btn-outline" style="flex:1;min-height:48px;" onclick="phCloseSheet()">Not now</button>
            <button class="btn ph-start-btn" style="flex:1;margin-top:0;"
                onclick="phCloseSheet();opdDoRetest('${cidEsc}', ${testNum})">
                <i class="fa-solid fa-rotate-right"></i> Retake Test</button>
        </div>
    `);
}

// A blocking overlay for the gaps where a tap fires a slow request but the view
// cannot change yet. Uses the app's own .loading-spinner / .spinner classes so
// it looks like every other wait in the product.
//
// Only worth it where the wait is BOTH slow and invisible. opdStartNextTest()
// deliberately doesn't use this: it navigates synchronously and the test route
// renders its own loader, so there is no dead frame to cover.
function opdBusy(msg) {
    opdBusyDone();
    const el = document.createElement('div');
    el.id = 'opd-busy';
    el.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;' +
        'align-items:center;justify-content:center;background:rgba(255,255,255,.92);' +
        '-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);';
    el.innerHTML = `<div class="loading-spinner" style="padding:0;">
        <div class="spinner"></div>${escapeHtml(msg || 'Working…')}</div>`;
    document.body.appendChild(el);
}

function opdBusyDone() {
    const el = document.getElementById('opd-busy');
    if (el && el.parentNode) el.parentNode.removeChild(el);
}

async function opdDoRetest(chapterId, testNum) {
    opdCaptureBaseline(testNum);   // R2 [3]: grab it BEFORE the server drops it
    // phCloseSheet() has just run, so the student is looking at the results page
    // they were already on. /api/test/retest then spends 2-3s in Firestore --
    // it batch-deletes the old session, rewinds phase_state.tests_taken, strips
    // this test's entries out of every attempted base's tracking history and
    // rolls back its v3 audit bookings. Nothing repaints until the navigate at
    // the end, so the button reads as broken and gets tapped again.
    opdBusy(`Resetting Test ${testNum}…`);
    try {
        const result = await apiCall('/api/test/retest', 'POST', {
            chapter_id: chapterId,
            test_num: Number(testNum),
        });
        if (result.status === 'ok') {
            opdState.chapterId = chapterId;
            navigate('opd-test', { chapter_id: chapterId, chapter_title: opdState.chapterTitle });
        } else {
            ndToast('Error: ' + (result.error || 'Unknown error'), 'error');
        }
    } catch (e) {
        ndToast('Error requesting retest: ' + e.message, 'error');
    } finally {
        // Always, including the navigate path -- an overlay left pinned over a
        // fresh test would be far worse than the lag it was covering.
        opdBusyDone();
    }
}

// Resume pending interventions from the hero — refetches so the list
// is current (desktop resumeInterventions).
async function resumeOpdInterventions() {
    try {
        const data = await apiCall(`/api/chapter/${opdState.chapterId}`);
        opdState.chapterData = data;
        const interventions = (data.progress && data.progress.pending_interventions) || [];
        if (interventions.length > 0) {
            showOpdInterventionSequence(interventions, false);
        } else {
            ndToast('No pending reviews found. You can take the next test!', 'success');
            loadOpdChapter(opdState.chapterId, opdState.chapterTitle);
        }
    } catch (e) {
        ndToast('Error loading reviews: ' + e.message, 'error');
    }
}

// ════════════════════════════════════════════════════════════════
// PAST-TEST ANALYSIS — its own route now (was rendered into the
// chapter container, which left the topbar title and back stack
// pointing at the chapter).
//
// VERIFIED LIMITATION: GET /api/test/session/<id> (backend.py:3932)
// returns only question_id / concept_id / difficulty / question_text
// / is_correct / student_answer / correct_answer / static_explanation
// / options_detail. No enrichment, no key_points, no NCERT quote, no
// phase, no pass_threshold. So the old build silently dropped all
// seven revision aids on a re-visit and never said why. v2 caches the
// rich submit response per session_id and prefers it; when only the
// reduced shape is available it SAYS SO.
// ════════════════════════════════════════════════════════════════
function viewOpdTestAnalysis(sessionId, testNum, completedAt) {
    opdState.analysisCtx = { sessionId: sessionId, testNum: testNum, completedAt: completedAt || '' };
    navigate('opd-analysis', {
        session_id: sessionId, test_num: testNum, completed_at: completedAt || '',
    });
}

async function loadOpdAnalysis(params) {
    params = params || {};
    const container = document.getElementById('opd-analysis-content');
    if (!container) return;
    const ctx = opdState.analysisCtx || {};
    const sessionId = params.session_id || ctx.sessionId;
    const testNum = params.test_num != null ? params.test_num : ctx.testNum;
    const completedAt = params.completed_at || ctx.completedAt || '';

    container.innerHTML = `<div class="m-picker-wrap">
        ${opdBackBarHtml('Back to case', 'opdBackToChapter()')}
        <div class="opd-sk opd-sk-hero"></div>
        ${'<div class="opd-sk opd-sk-row"></div>'.repeat(4)}
    </div>`;

    try {
        let sid = sessionId;
        if (!sid) {
            const data = await apiCall(`/api/chapter/${opdState.chapterId}`);
            const hist = ((data.progress || {}).test_history || []).filter(t => t.test_num === testNum)[0];
            if (!hist || !hist.session_id) throw new Error('Test data not found');
            sid = hist.session_id;
        }
        // Prefer the rich cached result from this session's own submit.
        const cached = opdState.sessionCache[sid];
        const results = cached || await apiCall(`/api/test/session/${sid}`);
        // Stashed so Practice can replay this test without a second fetch and
        // without any server round-trip at all (see opdPracticeStart).
        opdState.analysisResults = results;
        renderOpdResults(results, {
            analysis: true,
            containerId: 'opd-analysis-content',
            completedAt: completedAt,
            rich: !!cached,
        });
        opdInjectPracticeCta('opd-analysis-content', results);
    } catch (e) {
        container.innerHTML = `<div class="m-picker-wrap">
            ${opdBackBarHtml('Back to case', 'opdBackToChapter()')}
            <div class="empty-state">
            <i class="fa-solid fa-circle-exclamation"></i><h3>Could not load analysis</h3>
            <p style="margin-top:8px;color:var(--s500);">${escapeHtml(e.message)}</p>
            <button class="btn btn-outline" style="margin-top:16px;min-height:48px;" onclick="opdBackToChapter()">
                Go Back</button></div></div>`;
    }
}

function opdFmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// ════════════════════════════════════════════════════════════════
// RESULTS — fresh results view (navigate('opd-results')) and the
// shared renderer. Desktop flow preserved: results render FIRST,
// then the intervention sequence fires on top (once).
// ════════════════════════════════════════════════════════════════
function showOpdResultsView(params) {
    params = params || {};
    const container = document.getElementById('opd-results-content');
    if (!container) return;
    const results = opdState.lastResult;
    if (!results) {
        container.innerHTML = `<div class="m-picker-wrap"><div class="empty-state">
            <i class="fa-solid fa-chart-simple"></i><h3>No results to show</h3>
            <p style="margin-top:8px;color:var(--s500);">Finish an OPD test to see its analysis here.</p>
            <button class="btn btn-outline" style="margin-top:16px;min-height:48px;" onclick="navigate('opd')">
                <i class="fa-solid fa-arrow-left"></i> Back to OPD</button></div></div>`;
        return;
    }
    renderOpdResults(results, { containerId: 'opd-results-content' });

    const interventions = results.interventions_needed || [];
    if (params.fresh && interventions.length > 0 && !results._opdInterventionsShown) {
        results._opdInterventionsShown = true;
        showOpdInterventionSequence(interventions, true);
    }
}

function renderOpdResults(results, opts) {
    opts = opts || {};
    const container = document.getElementById(opts.containerId || 'opd-results-content');
    if (!container) return;
    const analysis = !!opts.analysis;
    const passThreshold = results.pass_threshold || opdPassThreshold();
    const pct = results.percentage || 0;
    const failed = pct < passThreshold;
    const phase = results.phase || '';
    opdState.reviewFilter = 'all';

    const attempted = analysis
        ? (results.question_results || []).filter(qr =>
            qr.student_answer !== null && qr.student_answer !== undefined && qr.student_answer !== '').length
        : opdState.lastAnsweredCount;

    const rawTime = Math.max(0, results.time_taken_seconds || 0);
    const tone = pct >= OPD_STRONG ? 'good' : failed ? 'bad' : 'warm';

    const deltaHtml = analysis ? '' : opdDeltaChipHtml(results, pct);

    let badges = '';
    if (!analysis && (results.is_flex || (results.bonus_pool_added || 0) > 0)) {
        badges = `<div class="opd-res-badges">
            ${results.is_flex ? `<span class="ph-chip amber"><i class="fa-solid fa-bolt"></i> Flex remediation test</span>` : ''}
            ${(results.bonus_pool_added || 0) > 0 ? `<span class="ph-chip green"><i class="fa-solid fa-gift"></i>
                +${results.bonus_pool_added} to Bonus Pool</span>` : ''}
        </div>`;
    }

    const dateStr = opdFmtDate(opts.completedAt);
    const heroSub = analysis
        ? `Test ${results.test_num}${dateStr ? ' · taken ' + dateStr : ''}`
        : `Test ${results.test_num}${results.is_retake ? ' · Retake' : ''}`;

    // R2 [4]: the outcome card is now built by opdResultsOutcomeHtml() and
    // lives in its own #opd-res-outcome host, so it can be refreshed in place
    // once the intervention cascade clears the lock.
    // Was `analysis ? ''` -- which blanked the outcome card on the past-test
    // view, so a test you had FAILED showed no retake button. The only route
    // back was: leave, open the chapter, tap the next test, and read the retest
    // prompt that appeared there instead. The retake belongs on the test you
    // failed. On a past view only the failed branch is worth showing -- the
    // "Test N+1 is open" branch would be stale and its button would start the
    // wrong test -- so pass a flag and let opdResultsOutcomeHtml decide.
    const outcomeHtml = (analysis && !results.needs_retake)
        ? '' : opdResultsOutcomeHtml(results, passThreshold, analysis);

    // R2 [5]: backend builds concept_breakdown by iterating EVERY concept in
    // the chapter (backend.py:3037) and defaulting untested ones to
    // {"correct": 0, "total": 0}. So a section headed "How you did on this
    // test" was listing concepts the test never asked about, as "0/0" rows
    // carrying a chapter-wide mastery % and a status colour. Filter to the
    // ones actually tested, and make the numbers about THIS test.
    let conceptHtml = '';
    if (!analysis && (results.concept_breakdown || []).length) {
        const tested = results.concept_breakdown.filter(cb => (cb.test_total || 0) > 0);
        const untested = results.concept_breakdown.length - tested.length;
        const META = {
            mastered: { icon: 'fa-circle-check', cls: 'good' },
            learning: { icon: 'fa-circle-half-stroke', cls: 'warm' },
            struggling: { icon: 'fa-circle-exclamation', cls: 'bad' },
        };
        const rows = tested.map(cb => {
            const acc = Math.round((cb.test_correct || 0) / cb.test_total * 100);
            // tone reflects THIS test's accuracy, not chapter-wide mastery
            const cls = acc >= OPD_STRONG ? 'good' : acc >= 40 ? 'warm' : 'bad';
            const meta = META[cb.status] || { icon: 'fa-circle', cls: '' };
            return `<div class="opd-concept-row ${cls}">
                <span class="opd-concept-icon ${meta.cls}"><i class="fa-solid ${meta.icon}"></i></span>
                <div class="opd-concept-main">
                    <div class="opd-concept-name">${escapeHtml(cb.concept_name || cb.concept_id)}</div>
                    <div class="opd-concept-bar"><i class="${cls}" data-w="${acc}" style="width:0"></i></div>
                    <div class="opd-concept-foot">
                        <span class="opd-concept-status ${meta.cls}">Overall mastery ${cb.overall_mastery || 0}%</span>
                    </div>
                </div>
                <span class="opd-concept-pct ${cls}">${cb.test_correct}/${cb.test_total}</span>
            </div>`;
        }).join('');
        conceptHtml = `<div class="mdash-section-label" style="padding:0;margin:18px 0 8px;">
            <i class="fa-solid fa-microscope"></i> How you did on this test</div>
        <div class="opd-concepts">${rows || `<p style="color:var(--s400);font-size:.82rem;padding:12px;">
            No concept-level data for this test.</p>`}</div>
        ${untested > 0 ? `<p class="opd-subnote">${untested} other concept${untested === 1 ? '' : 's'}
            in this chapter weren't covered by this test.</p>` : ''}`;
    }

    const qrs = results.question_results || [];
    const degraded = analysis && !opts.rich;
    // Honest note — the old build silently dropped every aid here.
    const degradeNote = degraded ? `<div class="opd-note amber">
        <i class="fa-solid fa-circle-info"></i>
        <div><b>This is the short version</b>
            <p>Crackers, elimination guides, traps and NCERT references are generated with your result
               the moment you finish a test — they aren't stored with the archive. Your answers and
               explanations are all here. Retake this test to see the full notes again.</p></div>
    </div>` : '';

    const counts = {
        all: qrs.length,
        wrong: qrs.filter(q => opdQrStatus(q) === 'wrong').length,
        skipped: qrs.filter(q => opdQrStatus(q) === 'unattempted').length,
        correct: qrs.filter(q => opdQrStatus(q) === 'correct').length,
    };
    const fchips = [['all', 'All', counts.all], ['wrong', 'Wrong', counts.wrong],
    ['skipped', 'Skipped', counts.skipped], ['correct', 'Correct', counts.correct]];

    container.innerHTML = `<div class="m-picker-wrap">
        ${opdBackBarHtml('Back to case', 'opdBackToChapter()')}

        <div class="opd-res-hero ${tone} ${analysis ? 'archival' : ''}">
            <div class="opd-res-phase">${phase ? opdPhaseChip(phase) : ''}
                <span>${escapeHtml(heroSub)}</span></div>
            <div class="opd-res-ringwrap">
                ${opdScoreRing(pct, passThreshold, tone)}
                <div class="opd-res-ringinner">
                    <b data-count="${pct}" data-count-suffix="%">0%</b>
                    <span>${results.score}/${results.total}</span>
                </div>
            </div>
            <div class="opd-res-line">
                <span class="opd-res-passline"><i class="fa-solid fa-flag-checkered"></i> Pass mark ${passThreshold}%</span>
                ${deltaHtml}
            </div>
            ${badges}
            <div class="opd-res-meta">
                <div><b>${fmtTimer(rawTime)}</b><span>Time taken</span></div>
                <div><b>${attempted}/${results.total}</b><span>Attempted</span></div>
                ${!analysis && results.overall_mastery !== undefined
            ? `<div><b>${results.overall_mastery}%</b><span>Chapter mastery</span></div>` : ''}
            </div>
        </div>

        <div id="opd-res-outcome">${outcomeHtml}</div>
        ${conceptHtml}
        ${degradeNote}

        <div class="mdash-section-label" style="padding:0;margin:18px 0 8px;">
            <i class="fa-solid fa-magnifying-glass-chart"></i> Question-by-question review</div>
        ${qrs.length ? `<div class="opd-revfilters" id="opd-revfilters">
            ${fchips.filter(c => c[0] === 'all' || c[2] > 0)
                .map(c => `<button class="opd-fchip ${c[0]} ${c[0] === 'all' ? 'on' : ''}"
                    onclick="opdSetReviewFilter('${c[0]}')">${c[1]} <b>${c[2]}</b></button>`).join('')}
        </div>` : ''}
        <div id="opd-revlist">${qrs.map((qr, i) => buildOpdReviewCard(qr, i, degraded)).join('')
        || '<p style="color:var(--s400);font-size:.82rem;">No question data.</p>'}</div>
    </div>`;

    opdAfterRender(container);
    opdSpinRing(container);
    window.scrollTo({ top: 0 });
}

// R2 [3]: rewritten. The v2 version did:
//     prev = idx > 0 ? hist[idx-1] : (idx === -1 ? hist[hist.length-1] : null)
// which produced "vs Test 11" after retaking Test 2, because /api/test/retest
// deletes the retaken entry from test_history, so idx === -1 and the fallback
// grabbed the LAST array element (the highest-numbered test). It also assumed
// test_history is ordered by test_num, which it isn't — append() puts a
// re-taken Test 2 at the end. And with d === 0 it rendered a fa-minus icon
// (a dash) followed by "0%", which reads as "-0%".
// ── ONE outcome card (v2 fixed the duplicate red-card bug here). R2 pulls
//    it out of renderOpdResults so finishOpdInterventions can re-render just
//    this card after the reviews clear the lock. Every lock field is READ
//    from a response, never computed.
function opdResultsOutcomeHtml(results, passThreshold, analysis) {
    const pct = results.percentage || 0;
    const failed = pct < passThreshold;

    // On the past-test view, only the failed branch renders (see caller): the
    // unlock/complete branches describe what happened right after submitting and
    // would be stale here.
    if (failed && analysis) {
        return `<div class="opd-hero red">
            <div class="opd-hero-tag"><i class="fa-solid fa-lock"></i> Below ${passThreshold}%</div>
            <h3>Test ${results.test_num} needs a retake</h3>
            <p>You scored <b>${Math.round(pct)}%</b> and need <b>${passThreshold}%</b> to unlock
               the next test. Read through the questions below — the same ones come back.</p>
            <button class="btn ph-start-btn danger" onclick="opdRetestConfirm(null, ${results.test_num})">
                <i class="fa-solid fa-rotate-right"></i> Retake Test ${results.test_num}</button>
        </div>`;
    }

    if (failed) {
        return `<div class="opd-hero red">
            <div class="opd-hero-tag"><i class="fa-solid fa-lock"></i> Below ${passThreshold}%</div>
            <h3>Test ${results.test_num} needs a retake</h3>
            <p>You need <b>${passThreshold}%</b> to unlock the next test. Work through the
               questions below first — the same ones come back.</p>
            <button class="btn ph-start-btn danger" onclick="opdRetestConfirm(null, ${results.test_num})">
                <i class="fa-solid fa-rotate-right"></i> Retake Test ${results.test_num}</button>
        </div>`;
    }
    if (results.chapter_fully_complete) {
        return `<div class="opd-hero green">
            <div class="opd-hero-tag"><i class="fa-solid fa-trophy"></i> Case closed</div>
            <h3>Chapter complete</h3>
            <p>You've finished every phase of this chapter.</p>
            <button class="btn ph-start-btn" onclick="navigate('opd')">
                <i class="fa-solid fa-notes-medical"></i> Pick the next case</button>
        </div>`;
    }
    if (results.next_test_available) {
        return `<div class="opd-hero go unlock">
            <div class="opd-hero-tag"><i class="fa-solid fa-lock-open"></i> Unlocked</div>
            <h3>Test ${results.test_num + 1} is open</h3>
            ${results._opdJustUnlocked
                ? `<p>All concept reviews cleared — that's what was holding the next test.</p>`
                : results.phase_completion_note
                    ? `<p>${escapeHtml(results.phase_completion_note)}</p>`
                    : `<p>You cleared the ${passThreshold}% bar. Keep the run going.</p>`}
            <button class="btn ph-start-btn" onclick="opdStartNextTest()">
                <i class="fa-solid fa-play"></i> Start Test ${results.test_num + 1}</button>
            <button class="btn btn-outline" style="min-height:48px;margin-top:10px;" onclick="opdBackToChapter()">
                Back to case file</button>
        </div>`;
    }
    if (results.next_test_locked_reason) {
        const pendingCount = (results.interventions_needed || []).length;
        return `<div class="opd-hero muted">
            <div class="opd-hero-tag"><i class="fa-solid fa-lock"></i> Locked</div>
            <h3>Next test isn't open yet</h3>
            <p>${escapeHtml(results.next_test_locked_reason)}</p>
            ${pendingCount ? `<button class="btn ph-start-btn danger" onclick="resumeOpdInterventions()">
                <i class="fa-solid fa-clipboard-check"></i> Complete the reviews</button>`
                : `<button class="btn btn-outline" style="min-height:48px;" onclick="opdBackToChapter()">
                Go to case file</button>`}
        </div>`;
    }
    return '';
}

// R2 [4.2]: after the cascade finishes we refetch the chapter and patch the
// outcome card in place. v2 did `if (interventionsFromResults) return;` and
// left the card exactly as it was rendered at submit time — when
// next_test_available was false BECAUSE the reviews were pending. Firestore
// was right (submit-v3 correct -> backend.py:3494 strips pending_interventions
// and sets next_test_available); only the screen was stale.
async function opdRefreshResultsOutcome() {
    const host = document.getElementById('opd-res-outcome');
    const results = opdState.lastResult;
    if (!host || !results || !opdState.chapterId) return;
    try {
        const data = await apiCall(`/api/chapter/${opdState.chapterId}`);
        opdState.chapterData = data;
        const prog = data.progress || {};
        const wasLocked = !results.next_test_available;
        // READ, never compute.
        results.next_test_available = data.next_test_available !== undefined
            ? data.next_test_available : prog.next_test_available;
        results.next_test_locked_reason = data.locked_reason || null;
        results.chapter_fully_complete = prog.chapter_fully_complete || false;
        results.interventions_needed = prog.pending_interventions || [];
        results._opdJustUnlocked = wasLocked && !!results.next_test_available;
        host.innerHTML = opdResultsOutcomeHtml(results, results.pass_threshold || opdPassThreshold());
        opdReveal(host);
    } catch (e) {
        console.warn('Could not refresh the results outcome:', e.message);
    }
}

function opdBaselineFor(results) {
    // 1. The snapshot taken before this test started — most reliable.
    const b = opdState.baseline;
    if (b && b.percentage !== undefined) {
        if (b.retake && b.test_num === results.test_num) return b;   // previous attempt, same test
        if (!b.retake && b.test_num < results.test_num) return b;    // the test before this one
    }
    // 2. Otherwise: highest test_num STRICTLY LESS than this one. Never
    //    hist[hist.length - 1] — that's what caused the bug.
    const hist = ((opdState.chapterData || {}).progress || {}).test_history || [];
    let best = null;
    hist.forEach(t => {
        if (t.percentage === undefined) return;
        if ((t.test_num || 0) >= results.test_num) return;
        if (!best || t.test_num > best.test_num) best = t;
    });
    return best ? { test_num: best.test_num, percentage: best.percentage || 0, retake: false } : null;
}

function opdDeltaChipHtml(results, pct) {
    const base = opdBaselineFor(results);
    if (!base) return '';   // R2 [3.5]: no baseline -> no chip, rather than a wrong one
    const d = Math.round(pct - (base.percentage || 0));
    const against = base.retake ? 'your last attempt' : `Test ${base.test_num}`;
    if (d > 0) {
        return `<span class="opd-delta up">
            <i class="fa-solid fa-arrow-trend-up"></i> ${d}% better than ${escapeHtml(against)}</span>`;
    }
    if (d < 0) {
        return `<span class="opd-delta down">
            <i class="fa-solid fa-arrow-trend-down"></i> ${Math.abs(d)}% below ${escapeHtml(against)}</span>`;
    }
    return `<span class="opd-delta flat">
        <i class="fa-solid fa-equals"></i> Same as ${escapeHtml(against)}</span>`;
}

// ════════════════════════════════════════════════════════════════
// R3 [2]: MATCH-THE-FOLLOWING in the review card.
// These are ordinary MCQs — List-I/List-II are reference tables and
// `options` holds the four ready-made pairings. backend.py:2576 stores
// student_answer for a match as the MAPPING DICT, so to show "your
// answer" as a letter we map the dict back to the option that produces
// it. The v2 card did safeHtml(String(item)) on list entries, which are
// {id, text} objects — hence "[object Object]" on every row.
// ════════════════════════════════════════════════════════════════
function opdListText(item) {
    if (item == null) return '';
    if (typeof item === 'object') return safeHtml(item.text != null ? item.text : '');
    return safeHtml(String(item));
}
function opdListId(item, i, roman) {
    if (item && typeof item === 'object' && item.id != null) return String(item.id);
    return roman ? (['i', 'ii', 'iii', 'iv', 'v', 'vi'][i] || String(i + 1)) : String(i + 1);
}

function opdParseMatchOption(text, list1, list2) {
    const ids = (arr) => (arr || [])
        .map(x => String((x && x.id != null) ? x.id : x).trim()).filter(Boolean);
    const l1 = ids(list1), l2 = ids(list2);
    if (!l1.length || !l2.length) return null;
    const map = {};
    const re = /\(?\s*([A-Za-z]+)\s*\)?\s*[-–—:=>→]+\s*\(?\s*([A-Za-z]+)\s*\)?/g;
    let m;
    while ((m = re.exec(String(text || '')))) {
        if (l1.indexOf(m[1]) !== -1 && l2.indexOf(m[2]) !== -1) map[m[1]] = m[2];
    }
    return Object.keys(map).length === l1.length ? map : null;
}

function opdSameMapping(a, b) {
    if (!a || !b) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => String(a[k]) === String(b[k]));
}

// student_answer is a mapping dict -> which option letter was that?
function opdMatchLetter(mapping, qr) {
    if (!mapping || typeof mapping !== 'object' || !Object.keys(mapping).length) return null;
    const opts = qr.options_detail || [];
    for (let i = 0; i < opts.length; i++) {
        const m = opdParseMatchOption(opts[i].text, qr.list1, qr.list2);
        if (m && opdSameMapping(m, mapping)) return opts[i].id;
    }
    return null;
}

function opdMatchListsHtml(qr) {
    const left = (qr.list1 || []).map((item, i) => `
        <div class="opd-match-row">
            <span class="opd-match-key">${escapeHtml(opdListId(item, i, false))}</span>
            <span>${opdListText(item)}</span>
        </div>`).join('');
    const right = (qr.list2 || []).map((item, i) => `
        <div class="opd-match-row">
            <span class="opd-match-key alpha">${escapeHtml(opdListId(item, i, true))}</span>
            <span>${opdListText(item)}</span>
        </div>`).join('');
    if (!left && !right) return '';
    return `<div class="opd-match-lists">
        <div class="opd-match-col"><div class="opd-match-title">List-I</div>${left}</div>
        <div class="opd-match-col"><div class="opd-match-title">List-II</div>${right}</div>
    </div>`;
}

function opdQrStatus(qr) {
    if (qr.question_type === 'match_the_following') {
        const sm = (qr.student_answer && typeof qr.student_answer === 'object') ? qr.student_answer : {};
        return Object.keys(sm).length === 0 ? 'unattempted' : (qr.is_correct ? 'correct' : 'wrong');
    }
    return (qr.student_answer === null || qr.student_answer === undefined || qr.student_answer === '')
        ? 'unattempted' : (qr.is_correct ? 'correct' : 'wrong');
}

function opdSetReviewFilter(k) {
    opdState.reviewFilter = k;
    document.querySelectorAll('#opd-revfilters .opd-fchip').forEach(b =>
        b.classList.toggle('on', (b.getAttribute('onclick') || '').indexOf("'" + k + "'") !== -1));
    const map = { wrong: 'wrong', skipped: 'unattempted', correct: 'correct' };
    let shown = 0;
    document.querySelectorAll('#opd-revlist .res-rev-item').forEach(el => {
        const show = k === 'all' || el.classList.contains(map[k]);
        el.style.display = show ? '' : 'none';
        if (show) shown++;
    });
    const list = document.getElementById('opd-revlist');
    let empty = document.getElementById('opd-revempty');
    if (!shown && list) {
        if (!empty) {
            empty = document.createElement('div');
            empty.id = 'opd-revempty';
            empty.className = 'opd-empty small';
            list.appendChild(empty);
        }
        empty.innerHTML = `<i class="fa-solid fa-circle-check"></i><h4>Nothing in this group</h4>`;
    } else if (empty) {
        empty.remove();
    }
}

// ── One review card. v2 reorders the aids to the student's actual
//    read path, promotes the explanation out of <details>, folds the
//    long tail behind one disclosure, and stops printing the
//    why-wrong paragraph twice per card. ──
function buildOpdReviewCard(qr, i, degraded) {
    const isMatch = qr.question_type === 'match_the_following';
    const options = qr.options_detail || [];
    const cardId = `opd_qcard_${i}`;
    const status = opdQrStatus(qr);

    const qImg = qr.has_image && qr.image_url
        ? `<img src="${escapeHtml(absUrl(qr.image_url))}" class="te-q-img" alt="Question figure" loading="lazy">`
        : '';

    let answerLine = '', wrongExpl = '', allOptionsHtml = '';

    const optDisplay = (opt) => opt && opt.image_url
        ? `<img src="${escapeHtml(absUrl(opt.image_url))}" class="opd-opt-img" loading="lazy">`
        : safeHtml((opt && opt.text) || '');

    // R3 [2]: match questions are ordinary MCQs. The only difference is that
    // student_answer arrives as the mapping dict (backend.py:2576), so resolve
    // it back to the option letter and then fall through to the SAME code path
    // as every other question — one answer line, one why-wrong box, one
    // all-options list. v2 had a bespoke branch that printed "[object Object]".
    const matchLists = isMatch ? opdMatchListsHtml(qr) : '';
    let studentId = qr.student_answer;
    if (isMatch) studentId = opdMatchLetter(qr.student_answer, qr);

    {
        const correctOpt = options.filter(o => o.id === qr.correct_answer)[0];
        const studentOpt = options.filter(o => o.id === studentId)[0];

        if (status === 'correct') {
            answerLine = `<span class="opd-ans ok"><i class="fa-solid fa-check"></i>
                Your answer: ${escapeHtml(studentId)}) ${optDisplay(studentOpt)}</span>`;
        } else if (status === 'wrong') {
            answerLine = `<span class="opd-ans nok"><i class="fa-solid fa-xmark"></i>
                ${studentId ? 'Your answer: ' + escapeHtml(studentId) + ') ' + optDisplay(studentOpt)
                    : 'Your answer was incorrect'}</span>
                <span class="opd-ans ok"><i class="fa-solid fa-check"></i>
                Correct: ${escapeHtml(qr.correct_answer || '?')}) ${optDisplay(correctOpt)}</span>`;
        } else {
            answerLine = `<span class="opd-ans skip"><i class="fa-solid fa-forward-step"></i> Skipped</span>
                <span class="opd-ans ok"><i class="fa-solid fa-check"></i>
                Correct: ${escapeHtml(qr.correct_answer || '?')}) ${optDisplay(correctOpt)}</span>`;
        }

        if (status === 'wrong' && studentId) {
            const wrongOpt = options.filter(o => o.id === studentId)[0];
            if (wrongOpt && wrongOpt.why_wrong_explanation) {
                wrongExpl = `<div class="opd-x-box red"><b><i class="fa-solid fa-circle-xmark"></i>
                    Why ${escapeHtml(studentId)} is wrong</b>
                    <p>${safeHtml(wrongOpt.why_wrong_explanation)}</p></div>`;
            }
        }

        if (options.length > 0) {
            allOptionsHtml = options.map(opt => {
                const isCorrect = opt.id === qr.correct_answer;
                // DEDUPE: the student's own wrong option is already
                // explained in the why-wrong box above; the old build
                // printed the identical paragraph again right here.
                const isTheirs = !isCorrect && opt.id === studentId && !!wrongExpl;
                const explanation = isCorrect
                    ? (opt.explanation || opt.why_correct_explanation || 'This is the correct answer.')
                    : (opt.why_wrong_explanation || opt.explanation || 'This option is incorrect.');
                return `<div class="opd-optexpl ${isCorrect ? 'ok' : 'nok'} ${isTheirs ? 'theirs' : ''}">
                    <b>${isCorrect ? '<i class="fa-solid fa-circle-check"></i>' : '<i class="fa-solid fa-xmark"></i>'}
                        ${escapeHtml(opt.id || '')})</b> ${optDisplay(opt)}
                    ${isTheirs
                        ? `<p class="dim"><i class="fa-solid fa-arrow-turn-up"></i> This was your answer — explained above.</p>`
                        : `<p>${safeHtml(explanation)}</p>`}
                </div>`;
            }).join('');
        }
    }

    // ── The read path: cracker → why-wrong → explanation, then
    //    everything else behind one disclosure. The old build put the
    //    NCERT verbatim quote FIRST and buried the explanation in a
    //    <details> while seven aid boxes sat open. ──
    const en = qr.enrichment || {};

    const crackerHtml = en.one_line_cracker
        ? `<div class="opd-cracker"><span class="opd-cracker-tag"><i class="fa-solid fa-bolt"></i> In one line</span>
            <p>${safeHtml(en.one_line_cracker)}</p></div>`
        : '';

    const explHtml = qr.static_explanation
        ? `<div class="opd-x-box plain"><b><i class="fa-solid fa-book-open"></i> Explanation</b>
            <p>${safeHtml(qr.static_explanation)}</p></div>`
        : '';

    const deep = [];
    if (en.elimination_guide) {
        deep.push(`<div class="opd-x-box green"><b><i class="fa-solid fa-list-check"></i> How to eliminate</b>
            <p>${safeHtml(en.elimination_guide)}</p></div>`);
    }
    // MERGED: confusion_pairs + common_mistakes were two separate red
    // boxes saying overlapping things.
    const traps = [];
    if (en.confusion_pairs && en.confusion_pairs.length) {
        traps.push(en.confusion_pairs.map(p => `<div class="opd-confpair">
            <b>${safeHtml(p.this || '')}</b> <em>vs</em> <b>${safeHtml(p.vs || '')}</b>
            <p>${safeHtml(p.key_difference || '')}</p></div>`).join(''));
    }
    if (qr.common_mistakes && qr.common_mistakes.length) {
        traps.push(`<ul class="opd-traplist">${qr.common_mistakes
            .map(m => `<li>${safeHtml(String(m))}</li>`).join('')}</ul>`);
    }
    if (traps.length) {
        deep.push(`<div class="opd-x-box amber"><b><i class="fa-solid fa-triangle-exclamation"></i> Traps to avoid</b>
            ${traps.join('')}</div>`);
    }
    if (qr.key_points && qr.key_points.length) {
        deep.push(`<div class="opd-x-box green checklist"><b><i class="fa-solid fa-bullseye"></i> Key points</b>
            <ul>${qr.key_points.map(k => `<li>${safeHtml(String(k))}</li>`).join('')}</ul></div>`);
    }
    if (en.mnemonic || en.last_day_revision_note) {
        deep.push(`<div class="opd-mnemonic"><span class="opd-mnem-tag"><i class="fa-solid fa-brain"></i> Remember it as</span>
            ${en.mnemonic ? `<blockquote>${safeHtml(en.mnemonic)}</blockquote>` : ''}
            ${en.last_day_revision_note ? `<p>${safeHtml(en.last_day_revision_note)}</p>` : ''}</div>`);
    }
    // NCERT last — it's the proof, not the punchline.
    if (qr.ncert_page_quote || qr.source_verbatim) {
        deep.push(`<div class="opd-ncert"><span class="opd-ncert-tag"><i class="fa-solid fa-book"></i> NCERT says</span>
            <p>${safeHtml(qr.ncert_page_quote || qr.source_verbatim)}</p>
            <footer>Verbatim from NCERT</footer></div>`);
    }
    if (allOptionsHtml) {
        const label = status === 'wrong' ? 'Why the other options fail'
            : status === 'unattempted' ? 'What each option was testing'
                : 'See all option analysis';
        deep.push(`<div class="opd-alloptions">
            <div class="opd-int-secttitle"><i class="fa-solid fa-list"></i> ${label}</div>
            ${allOptionsHtml}</div>`);
    }

    const deepHtml = deep.length ? `<details class="opd-deeper" id="${cardId}">
        <summary><span><i class="fa-solid fa-layer-group"></i> Go deeper</span>
            <i class="fa-solid fa-chevron-down"></i></summary>
        <div class="opd-deeper-body">${deep.join('')}</div>
    </details>` : '';

    const stateIcon = status === 'correct' ? 'fa-circle-check'
        : status === 'wrong' ? 'fa-circle-xmark' : 'fa-circle-minus';

    // Register this question for Nia at BUILD time, so every render path
    // is covered automatically. Keyed by question_id, because the results
    // list and the practice re-run both index from 0.
    const niaKey = 'opd_' + String(qr.question_id || ('idx' + i));
    if (typeof niaRegisterReviewQ === 'function') niaRegisterReviewQ(niaKey, qr);
    const plain = String(qr.question_text || '').replace(/<[^>]*>/g, '').trim();

    return `<div class="res-rev-item ${status} opd-rev-item">
        <button class="res-rev-head" onclick="niaRevToggle(this, '${niaKey}', 'opd_review')">
            <i class="fa-solid ${stateIcon} res-rev-state"></i>
            <div style="flex:1;min-width:0;text-align:left;">
                <h4>Q${i + 1}${qr.difficulty ? ` · ${escapeHtml(qr.difficulty)}` : ''}</h4>
                <p class="opd-rev-snip">${escapeHtml(plain)}</p>
            </div>
            <i class="fa-solid fa-chevron-down res-rev-caret"></i>
        </button>
        <div class="res-rev-body">
            <div class="te-q-text" style="font-size:.9rem;">${safeHtml(qr.question_text || '')}</div>
            ${qImg}
            ${matchLists}
            <div class="opd-ans-block">${answerLine}</div>
            ${crackerHtml}
            ${wrongExpl}
            ${explHtml}
            ${deepHtml}
            <button class="opd-ask-nia" onclick="opdAskNia('${niaKey}', 'opd_review')">
                <i class="fa-solid fa-wand-magic-sparkles"></i> Ask Nia about this question
            </button>
        </div>
    </div>`;
}

// Kept for compatibility: older markup referenced this by id.
function toggleOpdAllOptions(cardId) {
    const el = document.getElementById(cardId);
    if (!el) return;
    if (el.tagName === 'DETAILS') { el.open = !el.open; return; }
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

// ════════════════════════════════════════════════════════════════
// INTERVENTION CASCADE — full-screen mandatory overlay (a dismissible
// sheet would let students skip required reviews). Ports the desktop
// state machine branch-for-branch, per determine_intervention's four
// types:
//   standard_intervention      → v3 question → (fail) AI cascade
//   ai_intervention_no_v3      → AI cascade directly
//   retest_review_only         → acknowledge → /clear
//   review_only_ai_exhausted   → acknowledge → /clear
//
// v2: the review and the verification are two STEPS, not one 1,200px
// scroll. The old build showed the failed question, the history, the
// full explanation AND every option's explanation, and then asked the
// v3 question at the bottom of the same screen — so the student could
// pattern-match against a paragraph they were still looking at.
// ════════════════════════════════════════════════════════════════
function opdIntOverlayEl() {
    let el = document.getElementById('opd-int-overlay');
    if (!el) {
        el = document.createElement('div');
        el.id = 'opd-int-overlay';
        el.className = 'opd-int-overlay';
        el.innerHTML = `<div class="opd-int-card">
            <div class="opd-int-rail" id="opd-int-rail"></div>
            <div id="opd-int-content"></div>
        </div>`;
        document.body.appendChild(el);
    }
    return el;
}

// Cross-fade swap (was six hard innerHTML cuts in a row).
function opdIntSwap(html, after) {
    const content = document.getElementById('opd-int-content');
    if (!content) return;
    const card = document.querySelector('.opd-int-card');
    const paint = () => {
        content.innerHTML = html;
        if (card) card.scrollTop = 0;
        opdAfterRender(content);
        if (!opdReduceMotion()) {
            content.classList.remove('entering');
            void content.offsetWidth;
            content.classList.add('entering');
            setTimeout(() => content.classList.remove('entering'), 400);
        }
        if (after) after();
    };
    if (opdReduceMotion()) { paint(); return; }
    content.classList.add('leaving');
    setTimeout(() => { content.classList.remove('leaving'); paint(); }, 160);
}

function opdIntRail() {
    const rail = document.getElementById('opd-int-rail');
    if (!rail) return;
    const total = opdState.interventions.length;
    const idx = opdState.interventionIndex;
    let segs = '';
    for (let i = 0; i < total; i++) {
        segs += `<span class="opd-int-seg ${i < idx ? 'done' : i === idx ? 'now' : ''}"></span>`;
    }
    rail.innerHTML = `<div class="opd-int-segs">${segs}</div>
        <span class="opd-int-railtext">Concept review ${idx + 1} of ${total}</span>`;
}

function showOpdInterventionSequence(interventions, fromResults) {
    opdState.interventions = interventions || [];
    opdState.interventionIndex = 0;
    opdState.interventionsFromResults = !!fromResults;
    opdState.selectedAnswer = null;
    opdState.aiQuestion = null;
    opdState._pendingDiagnosis = null;
    opdState._ctxDiagnosis = null;
    opdState.intStep = 'review';

    const overlay = opdIntOverlayEl();
    overlay.classList.add('open');
    renderOpdIntervention();
}

function opdCurrentIntervention() {
    return opdState.interventions[opdState.interventionIndex] || null;
}

// R3 [3]: reference blocks the student can peek at on the VERIFY step.
// v2 gave step 2 only a "Remind me" button that navigated back, losing the
// v3 question. These are inline and collapsed, so the question stays on
// screen and peeking is the student's choice.
//   (a) the original question they got wrong — minimised
//   (b) the concept — which IS the original question's own
//       static_explanation (backend.py:2788 sets the intervention's
//       static_explanation to qdata.get("static_explanation"))
function opdIntOriginalRef(intervention, open) {
    if (!intervention.original_question_text) return '';
    return `<details class="opd-deeper" ${open ? 'open' : ''}>
        <summary><span><i class="fa-solid fa-circle-xmark" style="color:var(--red);"></i>
            The question you got wrong</span>
            <i class="fa-solid fa-chevron-down"></i></summary>
        <div class="opd-deeper-body">
            <div class="opd-int-origtext">${safeHtml(intervention.original_question_text)}</div>
            <div class="opd-int-origans">
                <span class="nok"><i class="fa-solid fa-xmark"></i> You: ${escapeHtml(String(intervention.original_student_answer != null ? intervention.original_student_answer : 'Not answered'))}</span>
                <span class="ok"><i class="fa-solid fa-check"></i> Correct: ${escapeHtml(String(intervention.original_correct_answer != null ? intervention.original_correct_answer : '?'))}</span>
            </div>
        </div>
    </details>`;
}

function opdIntConceptRef(intervention, open) {
    const expl = intervention.static_explanation;
    if (!expl) return '';
    return `<details class="opd-deeper" ${open ? 'open' : ''}>
        <summary><span><i class="fa-solid fa-lightbulb" style="color:var(--green-600);"></i>
            The concept</span>
            <i class="fa-solid fa-chevron-down"></i></summary>
        <div class="opd-deeper-body">
            <p style="margin:0;font-size:.84rem;line-height:1.65;color:var(--s700);">${safeHtml(expl)}</p>
        </div>
    </details>`;
}

// ── STEP 1: read ────────────────────────────────────────────────
function renderOpdIntervention() {
    const intervention = opdCurrentIntervention();
    if (!intervention) { finishOpdInterventions(); return; }
    opdState.intStep = 'review';
    opdIntRail();

    const isRetest = intervention.is_retest || false;
    const hist = intervention.variation_history_summary || [];
    const wrongTries = hist.filter(h => h.result === 'wrong' && !h.is_retake);

    // Facts from the payload. Replaces the identical-forever filler
    // line "You've struggled with this concept. Let's review and fix
    // your understanding."
    const facts = [];
    if (wrongTries.length) facts.push(`<span><i class="fa-solid fa-xmark"></i> Missed ${wrongTries.length}×</span>`);
    if (intervention.original_difficulty) facts.push(`<span><i class="fa-solid fa-gauge"></i> ${escapeHtml(intervention.original_difficulty)}</span>`);
    if (intervention.original_variation) facts.push(`<span><i class="fa-solid fa-code-branch"></i> v${escapeHtml(String(intervention.original_variation))}</span>`);

    let originalHtml = '';
    if (intervention.original_question_text) {
        originalHtml = `<div class="opd-int-orig">
            <div class="opd-int-origtag"><i class="fa-solid fa-xmark"></i> The question you missed</div>
            <div class="opd-int-origtext">${safeHtml(intervention.original_question_text)}</div>
            <div class="opd-int-origans">
                <span class="nok"><i class="fa-solid fa-xmark"></i> You: ${escapeHtml(String(intervention.original_student_answer != null ? intervention.original_student_answer : 'Not answered'))}</span>
                <span class="ok"><i class="fa-solid fa-check"></i> Correct: ${escapeHtml(String(intervention.original_correct_answer != null ? intervention.original_correct_answer : '?'))}</span>
            </div>
        </div>`;
    }
    // R3 [3]: v1's own lists, when the missed question was a match.
    const origLists = (intervention.original_list1 || intervention.original_list2)
        ? opdMatchListsHtml({ list1: intervention.original_list1, list2: intervention.original_list2 })
        : '';

    let historyHtml = '';
    if (wrongTries.length > 1) {
        historyHtml = `<div class="opd-int-histwrap">
            <div class="opd-int-histtitle"><i class="fa-solid fa-clock-rotate-left"></i> Your previous attempts</div>
            ${wrongTries.map(h => `<div class="opd-int-histrow"><i class="fa-solid fa-xmark"></i>
                <b>${escapeHtml(String(h.variation || '').toUpperCase())}</b>
                <span>You: ${escapeHtml(String(h.student_answer != null ? h.student_answer : '—'))} · Correct: ${escapeHtml(String(h.correct_answer != null ? h.correct_answer : '—'))}</span>
            </div>`).join('')}
        </div>`;
    }

    let optionsHtml = '';
    if ((intervention.all_options_explanation || []).length > 0) {
        optionsHtml = `<details class="opd-deeper">
            <summary><span><i class="fa-solid fa-list"></i> Understand each option</span>
                <i class="fa-solid fa-chevron-down"></i></summary>
            <div class="opd-deeper-body">${intervention.all_options_explanation.map(opt => `
                <div class="opd-optexpl ${opt.is_correct ? 'ok' : 'nok'}">
                    <b>${opt.is_correct ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-xmark"></i>'}
                        ${escapeHtml(opt.id || '')})</b> ${safeHtml(opt.text || '')}
                    <p>${safeHtml(opt.explanation || '')}</p>
                </div>`).join('')}</div>
        </details>`;
    }

    // The CTA depends on the backend's intervention_type — unchanged.
    // A v3 with no options is UNANSWERABLE, and that is worse than having no v3
    // at all: the verify screen's submit button stays disabled until an option
    // is picked, so there is nothing to submit and nothing to close -- and
    // backend.py's generate_test() refuses to run while pending_interventions is
    // non-empty, so one bad question doc bricks the entire chapter for that
    // student.
    //
    // Why it happens: match_the_following v3s are generated as PURE MAPPING
    // questions (list1, list2 and correct_mapping populated, options: []),
    // while their own v1/v2 carry four options whose text IS the mapping
    // ("A-i, B-iii, C-ii, D-iv"). So the same base is answerable at v1 and v2
    // and not at v3. Rather than special-casing match_the_following, this tests
    // the only thing that actually matters -- can the student pick something? --
    // so ANY malformed v3 (no options, options without ids) degrades the same
    // safe way instead of trapping them.
    const v3Usable = !!(intervention.v3_question
        && (intervention.v3_question.options || []).length
        && (intervention.v3_question.options || []).every(o => o && o.id));
    const v3Broken = intervention.intervention_type === 'standard_intervention' && !v3Usable;

    let cta = '';
    if (v3Usable && intervention.intervention_type === 'standard_intervention') {
        cta = `<button class="btn ph-start-btn" onclick="opdIntGoVerify()">
            <i class="fa-solid fa-flask-vial"></i> I've read this — test me</button>
            <p class="opd-int-ctanote">One question, on the same idea. Get it right and this review is cleared.</p>`;
    } else if (v3Broken) {
        // The same escape hatch retest_review_only already uses: read the
        // explanation, clear, move on. Never trapped.
        cta = `<button class="btn ph-start-btn dark" onclick="opdAcknowledgeAndClear()">
            <i class="fa-solid fa-check"></i> I've reviewed this — continue</button>
            <p class="opd-int-ctanote">No practice question is available for this one, so the
               explanation above is what to work from.</p>`;
    } else if (intervention.intervention_type === 'ai_intervention_no_v3') {
        cta = `<button class="btn ph-start-btn purple" onclick="loadOpdAIDiagnosis()">
            <i class="fa-solid fa-wand-magic-sparkles"></i> Analyse my mistake</button>
            <p class="opd-int-ctanote">You've used every standard variation of this question, so we'll look
               at the pattern across your attempts and build you a fresh one.</p>`;
    } else if (intervention.intervention_type === 'retest_review_only'
        || intervention.intervention_type === 'review_only_ai_exhausted') {
        cta = `<button class="btn ph-start-btn dark" onclick="opdAcknowledgeAndClear()">
            <i class="fa-solid fa-check"></i> I've reviewed this — continue</button>
            <p class="opd-int-ctanote">${intervention.intervention_type === 'retest_review_only'
                ? "This is a retest, so there's no new question — study the explanation above before your next attempt."
                : 'The AI tutor has already been used on this question. The explanations above are what to work from.'}</p>`;
    }

    opdIntSwap(`
        <div class="opd-int-head">
            <div class="opd-int-headtop">
                <span class="opd-int-kicker"><i class="fa-solid fa-book-open-reader"></i> Review</span>
                ${isRetest ? `<span class="ph-chip review"><i class="fa-solid fa-rotate-right"></i> RETEST</span>` : ''}
            </div>
            <h3 class="opd-int-concept">${escapeHtml(intervention.concept_name || intervention.concept_id || '')}</h3>
            ${facts.length ? `<div class="opd-int-facts">${facts.join('')}</div>` : ''}
            <p class="opd-int-why"><i class="fa-solid fa-lock"></i>
                Clearing this is what unlocks your next test.</p>
        </div>
        ${originalHtml}
        ${origLists}
        ${historyHtml}
        <div class="opd-x-box green"><b><i class="fa-solid fa-lightbulb"></i> The concept</b>
            <p>${safeHtml(intervention.static_explanation || 'Please review this concept carefully.')}</p></div>
        ${optionsHtml}
        <div class="opd-int-cta">${cta}</div>
    `);
}

// ── STEP 2: verify ──────────────────────────────────────────────
function opdIntGoVerify() {
    const intervention = opdCurrentIntervention();
    if (!intervention || !intervention.v3_question) return;
    // Belt and braces. The CTA already refuses to route here for an unanswerable
    // v3, but this is the one screen where being wrong strands the student with
    // no submit, no skip and a locked chapter -- so it refuses to render rather
    // than trusting its caller.
    if (!(intervention.v3_question.options || []).length) {
        console.warn('v3 has no options; staying on review:',
            intervention.v3_question.question_id);
        renderOpdIntervention();
        return;
    }
    opdState.intStep = 'verify';
    opdState.selectedAnswer = null;

    const v3q = intervention.v3_question;
    const v3lists = (v3q.list1 || v3q.list2)
        ? opdMatchListsHtml({ list1: v3q.list1, list2: v3q.list2 }) : '';

    const v3opts = (intervention.v3_question.options || []).map(opt => `
        <div class="opd-int-opt" data-id="${escapeHtml(opt.id || '')}"
             onclick="selectOpdV3Option('${String(opt.id || '').replace(/'/g, "\\'")}')">
            <span class="opd-int-optletter">${escapeHtml(opt.id || '')}</span>
            <span>${safeHtml(opt.text || '')}</span>
        </div>`).join('');

    opdIntSwap(`
        <div class="opd-int-head">
            <div class="opd-int-headtop">
                <span class="opd-int-kicker verify"><i class="fa-solid fa-flask-vial"></i> Verify</span>
                <button class="opd-int-back" onclick="renderOpdIntervention()">
                    <i class="fa-solid fa-chevron-left"></i> Back</button>
            </div>
            <h3 class="opd-int-concept">${escapeHtml(intervention.concept_name || intervention.concept_id || '')}</h3>
        </div>
        <div class="opd-int-qbox"><p>${safeHtml(intervention.v3_question.question_text || '')}</p></div>
        ${v3lists}
        ${v3opts}
        <button class="btn ph-start-btn" id="opd-int-submit" disabled onclick="submitOpdV3()">
            <i class="fa-solid fa-check"></i> Submit answer</button>
        <div class="opd-int-refs">
            <div class="opd-int-refs-title"><i class="fa-solid fa-book-open-reader"></i> Need a reminder?</div>
            ${opdIntOriginalRef(intervention, false)}
            ${opdIntConceptRef(intervention, false)}
        </div>
    `);
}

function selectOpdV3Option(optionId) {
    opdState.selectedAnswer = optionId;
    document.querySelectorAll('#opd-int-content .opd-int-opt').forEach(box =>
        box.classList.toggle('selected', box.dataset.id === optionId));
    const btn = document.getElementById('opd-int-submit');
    if (btn) btn.disabled = false;
}

async function submitOpdV3() {
    if (!opdState.selectedAnswer) return;
    const intervention = opdCurrentIntervention();
    opdIntSwap(`<div class="loading-spinner" style="padding:60px 0;"><div class="spinner"></div> Checking your answer...</div>`);

    try {
        const result = await apiCall('/api/intervention/submit-v3', 'POST', {
            base_question_id: intervention.base_question_id,
            answer: opdState.selectedAnswer,
            chapter_id: opdState.chapterId,
            test_num: intervention.test_num,
            is_retest: intervention.is_retest || false,
        });
        opdState.selectedAnswer = null;
        renderOpdV3Result(result, intervention);
    } catch (e) {
        ndToast('Error submitting answer: ' + e.message, 'error');
        opdIntGoVerify();
    }
}

function renderOpdV3Result(result, intervention) {
    const isCorrect = result.is_correct;
    const v3Expl = result.v3_explanation || {};
    const nextStep = result.next_step;

    // The AI diagnosis rides in on the failed-v3 response (Gemini,
    // backend.py:3543); stash it for the tutor step.
    if (result.ai_diagnosis) opdState._pendingDiagnosis = result.ai_diagnosis;

    const optionsHtml = (v3Expl.options_explanation || []).map(opt => `
        <div class="opd-optexpl ${opt.is_correct ? 'ok' : 'nok'}">
            <b>${opt.is_correct ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-xmark"></i>'}
                ${escapeHtml(opt.id || '')})</b> ${safeHtml(opt.text || '')}
            <p>${safeHtml(opt.explanation || '')}</p>
        </div>`).join('');

    // v2: the "AI Tutor Available" box that explained the button
    // sitting directly under it is gone; its line is the button's own
    // caption now.
    let continueHtml;
    if (isCorrect) {
        continueHtml = `<button class="btn ph-start-btn" onclick="showOpdInterventionSuccess()">
            <i class="fa-solid fa-arrow-right"></i> Continue</button>`;
    } else if (nextStep === 'ai_diagnosis' && !intervention.is_retest) {
        continueHtml = `<button class="btn ph-start-btn purple" onclick="proceedToOpdAIDiagnosis()">
            <i class="fa-solid fa-wand-magic-sparkles"></i> Analyse my mistake</button>
            <p class="opd-int-ctanote">You've now seen the explanation twice. Let's look at <em>why</em>
               this one keeps slipping, and try a question built for it.</p>`;
    } else {
        continueHtml = `<button class="btn ph-start-btn dark" onclick="opdClearAndMoveOn()">
            <i class="fa-solid fa-arrow-right"></i> I've reviewed — continue</button>
            <p class="opd-int-ctanote">${intervention.is_retest
                ? 'This is a retest, so study the explanation above thoroughly before your next attempt.'
                : 'AI tutoring was already used for this question — the explanations above are what to work from.'}</p>`;
    }

    opdIntSwap(`
        <div class="opd-int-resulthead ${isCorrect ? 'ok' : 'nok'}">
            <i class="fa-solid ${isCorrect ? 'fa-circle-check' : 'fa-circle-xmark'}"></i>
            <h2>${isCorrect ? 'Correct' : 'Not quite'}</h2>
            <p>${isCorrect
            ? 'You understood the concept. Have a last look below.'
            : 'You: ' + escapeHtml(String(v3Expl.student_answer != null ? v3Expl.student_answer : '?'))
            + ' · Correct: ' + escapeHtml(String(v3Expl.correct_answer != null ? v3Expl.correct_answer : '?'))}</p>
        </div>
        ${v3Expl.static_explanation ? `<div class="opd-x-box green"><b><i class="fa-solid fa-lightbulb"></i> Explanation</b>
            <p>${safeHtml(v3Expl.static_explanation)}</p></div>` : ''}
        ${optionsHtml ? `<details class="opd-deeper" ${isCorrect ? '' : 'open'}>
            <summary><span><i class="fa-solid fa-list"></i> Understand each option</span>
                <i class="fa-solid fa-chevron-down"></i></summary>
            <div class="opd-deeper-body">${optionsHtml}</div></details>` : ''}
        <div class="opd-int-cta">${continueHtml}</div>
    `);
}

async function opdClearAndMoveOn() {
    const intervention = opdCurrentIntervention();
    try {
        await apiCall('/api/intervention/clear', 'POST', {
            base_question_id: intervention.base_question_id,
            chapter_id: opdState.chapterId,
        });
    } catch (e) {
        console.error('Error clearing intervention:', e);
        // Continue anyway — never block the student (desktop parity).
    }
    moveToNextOpdIntervention();
}

// acknowledge for retest_review_only / review_only_ai_exhausted
async function opdAcknowledgeAndClear() {
    await opdClearAndMoveOn();
}

// v2: no more 1500ms auto-advance yanking the screen away.
function showOpdInterventionSuccess() {
    const total = opdState.interventions.length;
    const left = total - opdState.interventionIndex - 1;
    opdIntSwap(`<div class="opd-int-success">
        <i class="fa-solid fa-circle-check"></i>
        <h2>Concept cleared</h2>
        <p>${left > 0
            ? left + ' more review' + (left === 1 ? '' : 's') + ' to go.'
            : "That's the last one — your next test is unlocked."}</p>
        <button class="btn ph-start-btn" onclick="moveToNextOpdIntervention()">
            ${left > 0 ? 'Next review' : 'Done'} <i class="fa-solid fa-arrow-right"></i></button>
    </div>`);
}

// ════════════════════════════════════════════════════════════════
// AI TUTOR
//
// Path A (after a failed v3): submit-v3 already returns a REAL Gemini
// diagnosis (backend.py:3543); we stash and render it.
//
// Path B (ai_intervention_no_v3): the old build called NO api and
// fabricated the diagnosis client-side —
//     misconception: 'Multiple attempts failed — deeper review needed'
// — hardcoded, identical for every student and every concept, and
// presented under a "🤖 AI Tutor Analysis" tag.
//
// v2 calls POST /api/intervention/get-full-context (backend.py:3846),
// a route that already exists and was never wired up, and derives a
// specific diagnosis from the returned variation_history. Every field
// read below is one that route actually returns:
//   base_question_id, concept_id, variation_history[], ai_interventions,
//   ai_intervention_used, consecutive_failures, total_failures,
//   variations{v1,v2,v3}
// and each variation_history entry (backend.py:2709) carries:
//   variation, test_num, result, used_in, is_retake, student_answer,
//   correct_answer, question_text
// It is labelled "Pattern analysis" — because it IS computed from the
// student's real history, not generated. Nothing fabricated is ever
// labelled as AI again.
// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════
// R2 [1]: DEEPSEEK TUTOR
// Builds a dossier of every variation the student attempted (v1/v2/v3 —
// question, the options, the OPTION TEXT they picked, the correct option
// text, pass/fail) and asks DeepSeek to find the pattern across all three.
// Nothing here is fabricated: every fact comes from
// /api/intervention/get-full-context (backend.py:3846).
// ════════════════════════════════════════════════════════════════

function opdAiText(data) {
    const txt = data && data.choices && data.choices[0]
        && data.choices[0].message && data.choices[0].message.content;
    if (!txt) throw new Error('Empty AI response');
    return txt;
}

// Transport. Two modes; see the OPD_AI block at the top of this file.
async function opdAiChat(messages) {
    const payload = {
        model: OPD_AI.model,
        messages: messages,
        temperature: 0.3,
        max_tokens: 900,
        response_format: { type: 'json_object' },
    };

    // ── MODE B: proxy ──
    // Go through apiCall(), NOT a raw fetch: apiCall prefixes API_BASE,
    // attaches the Firebase ID token and auto-retries once on a 401
    // (shared.js:107). A raw fetch here would hit the wrong host in the
    // Capacitor shell AND send the wrong Authorization header, so an
    // @require_auth route would reject it immediately.
    if (OPD_AI.proxy) {
        return opdAiText(await apiCall(OPD_AI.proxy, 'POST', payload));
    }

    // ── MODE A: direct ──
    // Raw fetch, because Authorization must carry the DeepSeek key rather
    // than the Firebase token. The key is in this file and is therefore
    // readable by anyone who opens the app. See the warning at the top.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), OPD_AI.timeoutMs);
    try {
        const res = await fetch(OPD_AI.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + OPD_AI.apiKey,
            },
            signal: ctrl.signal,
            body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error('AI HTTP ' + res.status);
        return opdAiText(await res.json());
    } finally {
        clearTimeout(timer);
    }
}

function opdParseJsonish(txt) {
    let t = String(txt || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try { return JSON.parse(t); } catch (e) { /* fall through */ }
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e2) { } }
    return null;
}

// The v1/v2/v3 record. `variations` gives the questions + options; the
// history gives what the student actually chose each time.
function opdBuildDossier(ctx, intervention) {
    if (!ctx) return null;
    const vars = ctx.variations || {};
    const hist = ctx.variation_history || [];
    const rows = [];
    ['v1', 'v2', 'v3'].forEach(key => {
        const v = vars[key];
        const attempts = hist.filter(h => h && h.variation === key);
        const last = attempts.length ? attempts[attempts.length - 1] : null;
        if (!v && !last) return;
        const opts = (v && v.options) || [];
        const correctId = (v && v.correct_answer) || (last && last.correct_answer) || '';
        const pickId = last ? last.student_answer : null;
        const textOf = (id) => {
            const o = opts.filter(o => o.id === id)[0];
            return o ? o.text : null;
        };
        rows.push({
            variation: key,
            question: (v && v.question_text) || (last && last.question_text) || '',
            options: opts.map(o => `${o.id}) ${o.text}`),
            chose: pickId ? `${pickId}) ${textOf(pickId) || '(text unavailable)'}` : 'left it blank',
            correct: correctId ? `${correctId}) ${textOf(correctId) || '(text unavailable)'}` : 'unknown',
            result: last ? last.result : 'not attempted',
        });
    });
    if (!rows.length) return null;
    return {
        concept: intervention.concept_name || String(ctx.concept_id || '').replace(/_/g, ' '),
        totalFailures: ctx.total_failures || 0,
        consecutive: ctx.consecutive_failures || 0,
        rows: rows,
        reference: (vars.v1 && vars.v1.static_explanation) || intervention.static_explanation || '',
    };
}

const OPD_AI_SYSTEM =
    'You are an experienced NEET tutor in India. A student has now failed the SAME underlying '
    + 'concept across several rewritten versions of one question. You are given every version, the '
    + 'exact option they chose each time, and the correct option. '
    + 'Diagnose the ONE specific thing they believe that is wrong. Be concrete and name the actual '
    + 'biology/physics/chemistry — never generic study advice. Write to the student as "you", in '
    + 'plain, warm, direct English at NEET level. No emoji. No markdown. '
    + 'Reply with ONLY a JSON object, no prose around it, with exactly these keys: '
    + '{"verdict":"partial"|"total",'
    + '"misconception":"the precise wrong belief, 1-2 sentences, naming the concept",'
    + '"root_cause":"what their pattern of choices across the versions reveals, 1-2 sentences",'
    + '"explanation":"what is actually true and why the correct answer is correct, 3-5 sentences",'
    + '"memory_trick":"one concrete, easy way to never get this wrong again, 1-2 sentences"}. '
    + 'Use verdict "partial" if they grasp the topic but confuse one specific distinction; '
    + 'use "total" if the underlying idea has not landed at all.';

function opdDossierPrompt(d) {
    let out = `CONCEPT: ${d.concept}\n`;
    out += `Failed ${d.totalFailures} time(s) in total, ${d.consecutive} in a row.\n\n`;
    d.rows.forEach((r, i) => {
        out += `--- VERSION ${i + 1} (${r.variation}) — ${r.result} ---\n`;
        out += `Question: ${r.question}\n`;
        if (r.options.length) out += `Options:\n  ${r.options.join('\n  ')}\n`;
        out += `The student chose: ${r.chose}\n`;
        out += `Correct answer: ${r.correct}\n\n`;
    });
    if (d.reference) out += `Textbook explanation for reference:\n${d.reference}\n`;
    return out;
}

async function opdDeepSeekAnalyse(ctx, intervention) {
    const dossier = opdBuildDossier(ctx, intervention);
    if (!dossier) return null;
    const txt = await opdAiChat([
        { role: 'system', content: OPD_AI_SYSTEM },
        { role: 'user', content: opdDossierPrompt(dossier) },
    ]);
    const j = opdParseJsonish(txt);
    if (!j || !j.misconception || !j.explanation) return null;
    return {
        // keys the existing backend route reads (it uses diagnosis.misconception
        // and diagnosis.explanation) — shape preserved exactly.
        misconception: j.misconception,
        explanation: j.explanation,
        memory_trick: j.memory_trick || '',
        pattern_analysis: j.root_cause || '',
        _verdict: j.verdict === 'total' ? 'total' : 'partial',
        _dossier: dossier,
        _facts: {
            attempts: dossier.rows.length,
            totalFailures: dossier.totalFailures,
            streak: dossier.consecutive,
            repeated: null,
        },
    };
}

// Optional: let DeepSeek write the verification question. Submits through the
// existing route untouched — submit-ai-question grades against the object the
// client echoes back.
async function opdDeepSeekQuestion(diagnosis) {
    const d = diagnosis._dossier;
    const txt = await opdAiChat([
        {
            role: 'system', content: 'You are a NEET question setter. Write ONE multiple-choice question '
                + 'that tests whether the student has fixed the specific misconception described. It must be '
                + 'answerable only by someone who has corrected it — do not reuse or reword any question they '
                + 'have already seen, and do not put the explanation itself in an option. Exactly 4 options, '
                + 'exactly one correct, all four plausible to someone who still holds the misconception. '
                + 'No emoji, no markdown. Reply with ONLY JSON: '
                + '{"question_text":"...","options":[{"id":"A","text":"...","is_correct":false}, ...]}'
        },
        // v3: send the WHOLE dossier, not a summary of it. opdDossierPrompt
        // renders every version with its options, the option the student
        // actually chose, and the correct one. The old build sent only the
        // misconception text plus a bare list of question stems, throwing away
        // the single most useful signal available — the specific wrong options
        // they reached for. That is what made the generated question drift off
        // the actual mistake.
        {
            role: 'user', content:
                (d ? opdDossierPrompt(d) + '\n' : `CONCEPT: (unavailable)\n\n`)
                + `THEIR MISCONCEPTION: ${diagnosis.misconception}\n`
                + `WHAT IS ACTUALLY TRUE: ${diagnosis.explanation}\n\n`
                + `Write ONE question that traps the SAME misconception in a NEW situation. `
                + `Do not reuse or reword any version above. Look at the option they actually `
                + `chose each time: a student who still holds this misconception must be pulled `
                + `towards a wrong option, and a student who has fixed it must be able to get it right.`
        },
    ]);
    const j = opdParseJsonish(txt);
    if (!j || !j.question_text || !Array.isArray(j.options) || j.options.length < 2) return null;
    if (!j.options.some(o => o.is_correct)) return null;
    return { question_text: j.question_text, options: j.options, source: 'deepseek' };
}

// Path A (student failed v3) and Path B (ai_intervention_no_v3) now run the
// same ladder, so the analysis quality no longer depends on how you got here.
// PRECEDENCE, each labelled truthfully on screen:
//   1. deepseek — sees v1+v2+v3 and every answer the student gave
//   2. ai       — Gemini's diagnosis, which rides in on submit-v3 (backend.py:3543)
//   3. derived  — computed from variation_history (specific, but not written prose)
//   4. generic  — boilerplate, and it says so
function proceedToOpdAIDiagnosis() {
    opdRunTutorAnalysis(opdCurrentIntervention());
}

// kept: the step-1 CTA for ai_intervention_no_v3 calls this by name
function loadOpdAIDiagnosis() {
    opdRunTutorAnalysis(opdCurrentIntervention());
}

async function opdRunTutorAnalysis(intervention) {
    if (!intervention) return;
    const usingAi = opdDeepSeekReady();
    opdIntSwap(`<div class="opd-int-analyse">
        <div class="opd-int-analyse-orb"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
        <h3>${usingAi ? 'Working out what went wrong' : 'Looking at your attempts'}</h3>
        <p id="opd-analyse-step">Reading every version of this question you've seen…</p>
    </div>`);

    // Every path needs the full context: the questions, the options, and what
    // the student actually chose each time.
    let ctx = null;
    try {
        ctx = await apiCall('/api/intervention/get-full-context', 'POST', {
            base_question_id: intervention.base_question_id,
            chapter_id: opdState.chapterId,
        });
        opdState._ctxDiagnosis = ctx;
    } catch (e) {
        console.warn('get-full-context unavailable:', e.message);
    }

    let diagnosis = null, source = null;

    // 1. DeepSeek
    if (usingAi && ctx) {
        const step = document.getElementById('opd-analyse-step');
        if (step) step.textContent = 'Comparing your answers across all three versions…';
        try {
            diagnosis = await opdDeepSeekAnalyse(ctx, intervention);
            if (diagnosis) source = 'deepseek';
        } catch (e) {
            console.warn('DeepSeek analysis failed:', e.message);
        }
    }
    // 2. Gemini (arrives on the failed-v3 response)
    if (!diagnosis && opdState._pendingDiagnosis) {
        diagnosis = opdState._pendingDiagnosis;
        source = 'ai';
    }
    // 3. derived from their real history
    if (!diagnosis && ctx) {
        diagnosis = opdDeriveDiagnosis(ctx, intervention);
        if (diagnosis) source = 'derived';
    }
    // 4. honest generic
    if (!diagnosis) {
        source = 'generic';
        diagnosis = {
            misconception: 'This concept has caught you out more than once, and every standard version of the question is now used up.',
            explanation: intervention.static_explanation
                || 'Work back through the explanation above and make sure you can say why the correct answer is correct.',
            memory_trick: 'Say the rule out loud in your own words, then give yourself one real example of it.',
        };
    }
    // The QUESTION WRITER needs the dossier too, not just the analyser.
    // generateOpdAIQuestion() only calls DeepSeek when diagnosis._dossier
    // exists, and _dossier was attached in exactly one place: opdDeepSeekAnalyse.
    // So rungs 2-4 (Gemini / derived / generic) arrived here with no dossier and
    // silently fell through to the backend's diagnosis-only prompt — meaning any
    // hiccup in the DeepSeek ANALYSIS also quietly downgraded the QUESTION.
    // Two independent failures, one cause. Attach it once, here, for every rung.
    if (diagnosis && !diagnosis._dossier && ctx) {
        diagnosis._dossier = opdBuildDossier(ctx, intervention);
    }

    renderOpdAIDiagnosis(diagnosis, intervention, source);
}

// Derives a specific, TRUE diagnosis from the student's own history.
function opdDeriveDiagnosis(ctx, intervention) {
    if (!ctx) return null;
    const hist = (ctx.variation_history || []).filter(h => h && h.result === 'wrong');
    if (!hist.length) return null;

    const concept = intervention.concept_name
        || String(ctx.concept_id || '').replace(/_/g, ' ')
        || 'this concept';
    const totalFailures = ctx.total_failures || hist.length;
    const streak = ctx.consecutive_failures || 0;

    // Did they keep reaching for the same option?
    const picks = hist.map(h => h.student_answer).filter(a => a !== null && a !== undefined && a !== '');
    const tally = {};
    picks.forEach(p => { tally[p] = (tally[p] || 0) + 1; });
    const ranked = Object.keys(tally).map(k => [k, tally[k]]).sort((a, b) => b[1] - a[1]);
    const repeated = ranked[0];
    const skipped = hist.length - picks.length;

    let misconception, pattern_analysis;
    if (repeated && repeated[1] >= 2) {
        misconception = `You keep landing on option ${repeated[0]}. Across ${hist.length} attempts at `
            + `${concept} you chose it ${repeated[1]} time${repeated[1] === 1 ? '' : 's'} — that's not a slip, `
            + `it's a rule you're applying that doesn't hold here.`;
        pattern_analysis = `A repeated wrong answer means something specific is being remembered wrong, `
            + `not that the whole topic is fuzzy. Work out what makes option ${repeated[0]} look right to `
            + `you, and that's the exact thing to correct.`;
    } else if (skipped >= 2) {
        misconception = `You've left ${concept} unanswered ${skipped} time${skipped === 1 ? '' : 's'}. `
            + `You're not misreading it — you're not committing to it at all.`;
        pattern_analysis = `Skipping repeatedly usually means the first step isn't obvious. Get the `
            + `opening move solid and the rest tends to follow.`;
    } else {
        misconception = `Your answers on ${concept} have moved around — ${picks.join(', ') || 'different options'} `
            + `across ${hist.length} attempts. A different answer each time means you're reconstructing it `
            + `under pressure rather than recalling it.`;
        pattern_analysis = `Scattered answers point at recognition without recall: it looks familiar, but `
            + `there's no fixed rule to fall back on.`;
    }

    const explanation = (ctx.variations && ctx.variations.v1 && ctx.variations.v1.static_explanation)
        || intervention.static_explanation
        || 'Re-read the explanation above and make sure you can justify the correct answer out loud.';

    return {
        misconception: misconception,
        pattern_analysis: pattern_analysis,
        explanation: explanation,
        memory_trick: `Write one sentence that starts "${concept} is the one that…" and finish it in your `
            + `own words. If you can't finish it, that's the gap.`,
        _facts: {
            attempts: hist.length,
            totalFailures: totalFailures,
            streak: streak,
            repeated: (repeated && repeated[1] >= 2) ? repeated[0] : null,
        },
    };
}

function renderOpdAIDiagnosis(diagnosis, intervention, source) {
    if (!diagnosis) {
        diagnosis = {
            misconception: 'This concept needs another pass.',
            explanation: 'Re-read the explanation above carefully before moving on.',
            memory_trick: 'Understand the core principle before you move on.',
        };
        source = 'generic';
    }
    opdState._pendingDiagnosis = diagnosis;

    // Truthful labelling. 'ai' = Gemini wrote it (backend.py:3543).
    // 'derived' = computed from the student's real history.
    // 'generic' = boilerplate, and it says so.
    const tag = source === 'deepseek'
        ? `<span class="opd-int-aitag ai"><i class="fa-solid fa-wand-magic-sparkles"></i> AI tutor · read all 3 versions</span>`
        : source === 'ai'
            ? `<span class="opd-int-aitag ai"><i class="fa-solid fa-wand-magic-sparkles"></i> AI tutor analysis</span>`
            : source === 'derived'
                ? `<span class="opd-int-aitag derived"><i class="fa-solid fa-chart-line"></i> Pattern analysis · from your attempts</span>`
                : `<span class="opd-int-aitag generic"><i class="fa-solid fa-book-open"></i> Study note</span>`;

    // R2 [1.3]: the verdict drives the headline, so "you've mixed up one thing"
    // and "this hasn't landed at all" don't read identically.
    const verdict = diagnosis._verdict;
    const heading = verdict === 'total' ? "Let's rebuild this one from the start"
        : verdict === 'partial' ? "You're close — one thing is off"
            : "Here's what's going wrong";
    const verdictChip = verdict
        ? `<span class="opd-verdict ${verdict}">
             <i class="fa-solid ${verdict === 'total' ? 'fa-arrows-rotate' : 'fa-crosshairs'}"></i>
             ${verdict === 'total' ? 'Concept not landed yet' : 'One specific mix-up'}</span>`
        : '';

    const f = diagnosis._facts;
    const factRow = f ? `<div class="opd-int-facts">
        <span><i class="fa-solid fa-repeat"></i> ${f.attempts} attempts</span>
        ${f.streak ? `<span><i class="fa-solid fa-fire"></i> ${f.streak} in a row</span>` : ''}
        ${f.repeated ? `<span><i class="fa-solid fa-thumbtack"></i> always option ${escapeHtml(String(f.repeated))}</span>` : ''}
    </div>` : '';

    // Primary: misconception + what's actually true. Everything else
    // folds away (the old build stacked up to six boxes).
    const extra = [];
    if (diagnosis.pattern_analysis) {
        extra.push(`<div class="opd-x-box amber"><b><i class="fa-solid fa-chart-simple"></i> What the pattern says</b>
            <p>${safeHtml(diagnosis.pattern_analysis)}</p></div>`);
    }
    if (diagnosis.common_trap) {
        extra.push(`<div class="opd-x-box amber"><b><i class="fa-solid fa-triangle-exclamation"></i> The trap</b>
            <p>${safeHtml(diagnosis.common_trap)}</p></div>`);
    }
    if (diagnosis.regression_analysis) {
        extra.push(`<div class="opd-x-box red"><b><i class="fa-solid fa-clock-rotate-left"></i> Why you forgot it</b>
            <p>${safeHtml(diagnosis.regression_analysis)}</p></div>`);
    }
    if (diagnosis.memory_trick) {
        extra.push(`<div class="opd-mnemonic"><span class="opd-mnem-tag"><i class="fa-solid fa-brain"></i> Make it stick</span>
            <blockquote>${safeHtml(diagnosis.memory_trick)}</blockquote></div>`);
    }

    opdIntSwap(`
        <div class="opd-int-head">
            ${tag}
            <h3 class="opd-int-concept" style="margin-top:10px;">${escapeHtml(heading)}</h3>
            ${verdictChip}
            ${factRow}
        </div>
        <div class="opd-x-box red"><b><i class="fa-solid fa-bullseye"></i> Your misconception</b>
            <p>${safeHtml(diagnosis.misconception || '')}</p></div>
        <div class="opd-x-box green"><b><i class="fa-solid fa-lightbulb"></i> What's actually true</b>
            <p>${safeHtml(diagnosis.explanation || '')}</p></div>
        ${extra.length ? `<details class="opd-deeper">
            <summary><span><i class="fa-solid fa-layer-group"></i> Go deeper</span>
                <i class="fa-solid fa-chevron-down"></i></summary>
            <div class="opd-deeper-body">${extra.join('')}</div></details>` : ''}
        <div class="opd-int-cta" id="opd-int-qslot">
            <div class="opd-int-qloading"><div class="spinner"></div>
                <span>Building you a question that targets this…</span></div>
        </div>
    `, () => generateOpdAIQuestion(intervention, diagnosis));
}

// v2: the AI question is APPENDED below the diagnosis. The old build
// did content.innerHTML = … here, which deleted the analysis at the
// exact moment the student needed it to answer the question about it.
async function generateOpdAIQuestion(intervention, diagnosis) {
    try {
        let aiQuestion = null, qSource = null;

        // R2 [1.7]: OPD_AI.generateQuestion === true -> DeepSeek writes it.
        if (OPD_AI.generateQuestion === true && opdDeepSeekReady() && diagnosis._dossier) {
            try { aiQuestion = await opdDeepSeekQuestion(diagnosis); if (aiQuestion) qSource = 'deepseek'; }
            catch (e) { console.warn('DeepSeek question failed:', e.message); }
        }

        if (!aiQuestion) {
            const response = await apiCall('/api/intervention/get-ai-question', 'POST', {
                concept_id: intervention.concept_id,
                diagnosis: diagnosis,
                chapter_id: opdState.chapterId,
            });
            // NOTE: ai_question.options include is_correct — never shown to
            // the student; the WHOLE object is echoed back on submit (the
            // backend grades against it).
            aiQuestion = response.ai_question;
            // R2 [1.6]: the backend tells us which of its three tiers made this
            // ('gemini' | 'fallback' | 'last_resort' — backend.py:1069/1109/1126)
            // and v2 threw that away, so a giveaway question looked identical to
            // a real one.
            qSource = response.source || (aiQuestion && aiQuestion.source) || 'unknown';

            // 'last_resort' (backend.py:1115) builds an MCQ whose CORRECT option
            // is literally the diagnosis.explanation string the student just
            // read, with "The opposite of..." / "None of the above" as the wrong
            // ones. Passing it clears the intervention for free. Replace it with
            // a real question when we can.
            if (qSource === 'last_resort' && OPD_AI.generateQuestion !== false
                && opdDeepSeekReady() && diagnosis._dossier) {
                try {
                    const better = await opdDeepSeekQuestion(diagnosis);
                    if (better) { aiQuestion = better; qSource = 'deepseek'; }
                } catch (e) { console.warn('DeepSeek question failed:', e.message); }
            }
        }
        if (!aiQuestion) throw new Error('No question available');

        opdState.aiQuestion = aiQuestion;
        opdState.selectedAnswer = null;

        const slot = document.getElementById('opd-int-qslot');
        if (!slot) return;

        const aiOpts = (aiQuestion.options || []).map(opt => `
            <div class="opd-int-opt purple" data-id="${escapeHtml(opt.id || '')}"
                 onclick="selectOpdAIOption('${String(opt.id || '').replace(/'/g, "\\'")}')">
                <span class="opd-int-optletter">${escapeHtml(opt.id || '')}</span>
                <span>${safeHtml(opt.text || '')}</span>
            </div>`).join('');

        // Honest about a weak question rather than dressing it up.
        const qNote = qSource === 'last_resort'
            ? 'A generic check — a targeted question could not be generated right now.'
            : qSource === 'fallback'
                ? 'A fresh question on this concept from the question bank.'
                : 'Built for the mistake above.';

        slot.innerHTML = `
            <div class="opd-int-qhead">
                <span class="opd-int-kicker verify"><i class="fa-solid fa-flask-vial"></i> Verify</span>
                <p>${escapeHtml(qNote)}</p>
            </div>
            <div class="opd-int-qbox purple"><p>${safeHtml(aiQuestion.question_text || '')}</p></div>
            ${aiOpts}
            <button class="btn ph-start-btn purple" id="opd-int-submit" disabled onclick="submitOpdAIAnswer()">
                <i class="fa-solid fa-check"></i> Submit answer</button>`;
        opdReveal(slot);
        if (slot.scrollIntoView) {
            slot.scrollIntoView({ behavior: opdReduceMotion() ? 'auto' : 'smooth', block: 'start' });
        }
    } catch (e) {
        const slot = document.getElementById('opd-int-qslot');
        if (!slot) return;
        slot.innerHTML = `<button class="btn ph-start-btn dark" onclick="moveToNextOpdIntervention()">
            <i class="fa-solid fa-arrow-right"></i> Continue</button>
            <p class="opd-int-ctanote">We couldn't build a custom question right now — the analysis above
               still stands. This concept will come back in a later test.</p>`;
    }
}

function selectOpdAIOption(optionId) {
    opdState.selectedAnswer = optionId;
    document.querySelectorAll('#opd-int-content .opd-int-opt').forEach(box =>
        box.classList.toggle('selected', box.dataset.id === optionId));
    const btn = document.getElementById('opd-int-submit');
    if (btn) btn.disabled = false;
}

async function submitOpdAIAnswer() {
    if (!opdState.selectedAnswer || !opdState.aiQuestion) return;
    const intervention = opdCurrentIntervention();
    const slot = document.getElementById('opd-int-qslot');
    if (slot) slot.innerHTML = `<div class="opd-int-qloading"><div class="spinner"></div><span>Checking…</span></div>`;

    try {
        const result = await apiCall('/api/intervention/submit-ai-question', 'POST', {
            base_question_id: intervention.base_question_id,
            answer: opdState.selectedAnswer,
            ai_question: opdState.aiQuestion,
            chapter_id: opdState.chapterId,
        });
        const studentAnswer = opdState.selectedAnswer;
        opdState.selectedAnswer = null;
        opdState.aiQuestion = null;
        renderOpdAIQuestionResult(result, studentAnswer);
    } catch (e) {
        ndToast('Error: ' + e.message, 'error');
        moveToNextOpdIntervention();
    }
}

function renderOpdAIQuestionResult(result, studentAnswer) {
    const isCorrect = result.is_correct;
    const optionsHtml = (result.ai_options_explanation || []).map(opt => `
        <div class="opd-optexpl ${opt.is_correct ? 'ok' : 'nok'}">
            <b>${opt.is_correct ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-xmark"></i>'}
                ${escapeHtml(opt.id || '')})</b> ${safeHtml(opt.text || '')}
            ${opt.explanation ? `<p>${safeHtml(opt.explanation)}</p>` : ''}
        </div>`).join('');

    const continueHtml = isCorrect
        ? `<button class="btn ph-start-btn" onclick="showOpdInterventionSuccess()">
            <i class="fa-solid fa-arrow-right"></i> Continue</button>`
        : `<div class="opd-x-box amber"><b><i class="fa-solid fa-book-open"></i> Worth a proper sit-down</b>
            <p>${safeHtml(result.ncert_reference || 'Review the relevant NCERT chapter section.')}</p>
            <p class="dim">${safeHtml(result.recommendation || 'This concept will appear again in future tests.')}</p></div>
        <button class="btn ph-start-btn dark" onclick="moveToNextOpdIntervention()">
            <i class="fa-solid fa-arrow-right"></i> I'll review it — continue</button>`;

    opdIntSwap(`
        <div class="opd-int-resulthead ${isCorrect ? 'ok' : 'nok'}">
            <i class="fa-solid ${isCorrect ? 'fa-circle-check' : 'fa-circle-xmark'}"></i>
            <h2>${isCorrect ? 'Correct' : 'Not quite'}</h2>
            <p>You: ${escapeHtml(String(studentAnswer))} · Correct: ${escapeHtml(String(result.correct_answer != null ? result.correct_answer : '?'))}</p>
        </div>
        ${optionsHtml ? `<details class="opd-deeper" ${isCorrect ? '' : 'open'}>
            <summary><span><i class="fa-solid fa-list"></i> Understand each option</span>
                <i class="fa-solid fa-chevron-down"></i></summary>
            <div class="opd-deeper-body">${optionsHtml}</div></details>` : ''}
        <div class="opd-int-cta">${continueHtml}</div>
    `);
}

// ── Sequence advance / finish ──
function moveToNextOpdIntervention() {
    opdState.interventionIndex++;
    opdState.selectedAnswer = null;
    opdState.aiQuestion = null;
    opdState._pendingDiagnosis = null;
    opdState._ctxDiagnosis = null;
    opdState.intStep = 'review';
    if (opdState.interventionIndex < opdState.interventions.length) {
        renderOpdIntervention();
    } else {
        finishOpdInterventions();
    }
}

function finishOpdInterventions() {
    const overlay = document.getElementById('opd-int-overlay');
    if (overlay) overlay.classList.remove('open');
    if (opdState.interventionsFromResults) {
        // Results are already rendered underneath (desktop parity) — but the
        // outcome card was built when the lock was still on. Refresh it.
        opdRefreshResultsOutcome();
        return;
    }
    loadOpdChapter(opdState.chapterId, opdState.chapterTitle);
}

console.log('OPD module (mobile) loaded ✅');


// ════════════════════════════════════════════════════════════════
// PRACTICE — replay a completed test, counting for NOTHING.
//
// Deliberately 100% client-side. There is no endpoint, no session doc, no
// submit. It never touches tests_taken, seen_question_ids, owed_v2, the v3
// audit queue, concept_mastery or the 40% gate -- so there is no path by which
// practising can corrupt a student's real progress or inflate their mastery.
// It can afford to be client-side because /api/test/session/<id> already
// returns correct_answer per question, so grading needs no server.
//
// No score is shown, by design. A percentage would read as a second attempt and
// invite comparison against the real one; this is rehearsal, and it ends where
// the learning is -- the review cards.
//
// Questions AND options are shuffled. The point is retrieval practice: replaying
// the same test in the same order rehearses "the answer to Q4 was C" rather than
// the chemistry. Options are shuffled by display position while keeping their id
// labels, so correct_answer still matches by id and positional memory ("it was
// the last one") is broken too.
// ════════════════════════════════════════════════════════════════

function opdShuffled(arr) {
    const a = (arr || []).slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
}

function opdInjectPracticeCta(containerId, results) {
    const host = document.getElementById(containerId);
    if (!host) return;
    const qrs = (results && results.question_results) || [];
    // Nothing to practise with if the payload came back without options (an
    // older session doc, or a question whose options never generated).
    const usable = qrs.filter(q => ((q.options_detail || q.options || []).length));
    if (!usable.length) return;
    const list = host.querySelector('#opd-revlist');
    if (!list) return;
    const bar = document.createElement('div');
    bar.className = 'opd-hero';
    bar.innerHTML = `
        <div class="opd-hero-tag"><i class="fa-solid fa-repeat"></i> Practice</div>
        <h3>Run these ${usable.length} again</h3>
        <p>Same questions, shuffled order. Nothing is scored and nothing is
           recorded — this changes no progress, no mastery, no locks.</p>
        <button class="btn ph-start-btn dark" onclick="opdPracticeStart()">
            <i class="fa-solid fa-repeat"></i> Practice these again</button>`;
    list.parentNode.insertBefore(bar, list);
}

function opdPracticeStart() {
    const results = opdState.analysisResults;
    if (!results) return;
    // QUESTIONS are shuffled; OPTIONS are deliberately NOT.
    //
    // v1 shuffled option display order while keeping the id labels, which put
    // "C. B. A. D." down the page and a B-C-A-D bubble row on a sheet that is
    // always A-B-C-D. And the alternative -- reassigning the letters so the old
    // C really becomes A -- is worse: correct_answer is an id, and every
    // explanation in the bank is keyed to ids too (why_wrong_explanation lives
    // ON option B; elimination_guide literally says "eliminate A, C, D first").
    // Renaming options would make all of it lie. Option order is part of the
    // content here, not chrome, so it stays put.
    const qs = opdShuffled((results.question_results || [])
        .filter(q => ((q.options_detail || q.options || []).length))
        .map(q => {
            const c = Object.assign({}, q);
            c.options_detail = q.options_detail || q.options || [];
            c.options = c.options_detail;
            return c;
        }));
    if (!qs.length) return;
    opdState.practice = { qs: qs, idx: 0, answers: {}, testNum: results.test_num };
    opdPracticeRender();
}

function opdPracticeSwap(html) {
    const host = document.getElementById('opd-analysis-content');
    if (host) { host.innerHTML = html; window.scrollTo(0, 0); }
}

function opdPracticeRender() {
    const p = opdState.practice;
    if (!p) return;
    if (p.idx >= p.qs.length) { opdPracticeFinish(); return; }
    const q = p.qs[p.idx];
    const picked = p.answers[q.question_id];
    const isMatch = q.question_type === 'match_the_following';

    // Options are DISPLAY ONLY, exactly as in the real test (te-option carries
    // no onclick either). Answering happens on the OMR sheet below. v1 of this
    // screen made the options tappable and skipped the sheet entirely -- which
    // both broke the rehearsal (the real thing is read-then-shade, a deliberate
    // two-step) and, because it tagged the chosen option `sel` while the
    // stylesheet only knows `.opd-int-opt.selected`, gave no visual feedback at
    // all. The tap registered and nothing lit up, so the screen looked broken.
    const opts = (q.options_detail || []).map(opt => `
        <div class="opd-int-opt ${picked === opt.id ? 'selected' : ''}">
            <span class="opd-int-optletter">${escapeHtml(opt.id || '')}</span>
            <span>${opt.image_url
            ? `<img src="${escapeHtml(absUrl(opt.image_url))}" class="opd-opt-img" loading="lazy">`
            : safeHtml(opt.text || '')}</span>
        </div>`).join('');

    // The OMR sheet, reusing the real test's own omr-m-* markup so it reads as
    // the same object. Two deliberate differences: it is inline rather than a
    // slide-up drawer (practice does not need the mode-switch ceremony), and
    // bubbles are never `locked` -- practice is not first-commit-wins, because
    // there is no score to protect and changing your mind is part of thinking.
    const bubbles = (q.options_detail || []).map(opt => `
        <button class="omr-m-bubble ${picked === opt.id ? 'filled' : ''}"
            onclick="opdPracticePick('${String(opt.id || '').replace(/'/g, "\\'")}')">
            ${escapeHtml(opt.id || '')}</button>`).join('');

    opdPracticeSwap(`<div class="m-picker-wrap">
        ${opdBackBarHtml('Back to analysis', 'opdPracticeQuit()')}
        <div class="opd-int-head">
            <div class="opd-int-headtop">
                <span class="opd-int-kicker"><i class="fa-solid fa-repeat"></i>
                    Practice · not scored</span>
                <span class="ph-chip">${p.idx + 1} / ${p.qs.length}</span>
            </div>
            <h3 class="opd-int-concept">${escapeHtml(q.concept_name || q.concept_id || '')}</h3>
        </div>
        <div class="opd-int-qbox"><p>${safeHtml(q.question_text || '')}</p></div>
        ${q.has_image && q.image_url
            ? `<img src="${escapeHtml(absUrl(q.image_url))}" class="te-q-img" loading="lazy">` : ''}
        ${isMatch ? opdMatchListsHtml(q) : ''}
        ${opts}
        <div class="omr-m-sheet" style="margin-top:14px;">
            <div class="omr-m-title">OMR ANSWER SHEET</div>
            <div class="omr-m-instructions">
                <span><i class="fa-solid fa-pen"></i> Shade your answer</span>
                <span><i class="fa-solid fa-rotate-left"></i> Practice — you can change it</span>
            </div>
            <div class="omr-m-row live">
                <span class="omr-m-qnum">${p.idx + 1}</span>
                <div class="omr-m-bubbles">${bubbles}</div>
            </div>
            <p class="omr-m-note">${picked
            ? `<i class="fa-solid fa-check"></i> Shaded <b>${escapeHtml(picked)}</b> — tap another to change it.`
            : 'Tap a bubble to shade it.'}</p>
        </div>
        <div class="opd-int-cta">
            <button class="btn ph-start-btn" id="opd-prac-next" ${picked ? '' : 'disabled'}
                onclick="opdPracticeNext()">
                ${p.idx === p.qs.length - 1
            ? '<i class="fa-solid fa-book-open-reader"></i> See the explanations'
            : '<i class="fa-solid fa-arrow-right"></i> Next'}</button>
            <p class="opd-int-ctanote">No feedback until the end — recall first, check after.</p>
        </div>
    </div>`);
}

function opdPracticePick(optId) {
    const p = opdState.practice;
    if (!p) return;
    // Unlike a real test, practice is NOT first-commit-wins. Changing your mind
    // is part of thinking it through, and there is no score to protect.
    p.answers[p.qs[p.idx].question_id] = optId;
    opdPracticeRender();
}

function opdPracticeNext() {
    const p = opdState.practice;
    if (!p) return;
    p.idx++;
    opdPracticeRender();
}

function opdPracticeQuit() {
    opdState.practice = null;
    const ctx = opdState.analysisCtx || {};
    loadOpdAnalysis({
        session_id: ctx.sessionId, test_num: ctx.testNum,
        completed_at: ctx.completedAt
    });
}

function opdPracticeFinish() {
    const p = opdState.practice;
    if (!p) return;
    // Reuse the real review cards -- same explanations, same enrichment, same
    // everything -- with student_answer swapped for what they just picked. The
    // review screen is where the learning is; practice just walks them to it
    // having actually tried.
    const cards = p.qs.map((q, i) => {
        const c = Object.assign({}, q);
        c.student_answer = p.answers[q.question_id] != null ? p.answers[q.question_id] : null;
        c.is_correct = c.student_answer === q.correct_answer;
        return buildOpdReviewCard(c, i, false);
    }).join('');

    const right = p.qs.filter(q => p.answers[q.question_id] === q.correct_answer).length;
    opdPracticeSwap(`<div class="m-picker-wrap">
        ${opdBackBarHtml('Back to analysis', 'opdPracticeQuit()')}
        <div class="opd-hero">
            <div class="opd-hero-tag"><i class="fa-solid fa-repeat"></i> Practice · not recorded</div>
            <h3>${right} of ${p.qs.length} this time</h3>
            <p>Nothing here was saved — your test result, mastery and locks are
               untouched. Read the explanations below for the ones that caught you.</p>
        </div>
        <div id="opd-revlist">${cards}</div>
        <button class="btn ph-start-btn dark" onclick="opdPracticeStart()">
            <i class="fa-solid fa-repeat"></i> Shuffle and go again</button>
    </div>`);
}