/* ════════════════════════════════════════════════════════════════
   NAADI AI — OPD DESKTOP LAYER  (opd-desktop.js)
   ─────────────────────────────────────────────────────────────────
   Desktop-native (≥1024px) presentation for the WHOLE OPD section:
   the hub ("Ward Rounds · Case Files"), the chapter / case-file page,
   the results dashboard, past-test analysis, and the V3 intervention
   cascade overlay. Mirrors arena-desktop.js / concept-studio-desktop.js
   EXACTLY:

     • One IIFE, self-gated with matchMedia('(min-width:1024px)').
     • On a phone: registers ONE idle change-listener and does NOTHING
       else — no globals reassigned, nothing rendered, no DOM touched,
       NO #opd-int-overlay created.
     • At ≥1024px: captures the mobile render entry points, overrides
       them, and RESTORES the originals verbatim if the viewport drops
       below 1024px (resize / devtools). Repaints the active view on
       activate + deactivate so a resize is seamless.

   It overrides PRESENTATION ONLY. Every override reuses opd.js's own
   state (opdState), constants (OPD_SUBJECTS / OPD_PHASE_META /
   OPD_JOURNEY_ORDER / OPD_STRONG / OPD_PASS_DEFAULT), pure builders and
   handlers verbatim — exactly the way arena-desktop reused the pv2*
   builders. Nothing in opd.js / test-engine.js / practice-hub.js /
   backend is edited.

   REUSED VERBATIM (never redefined here):
       opdSubjectChapters, opdChapterStarted, opdMatchesFilter,
       opdCaseRowHtml, opdSearchResultsHtml (logic), opdHubHeaderHtml
       fields, toggleOpdSubject/opdSetClass side-effects, opdHeroActionHtml,
       renderOpdJourney, opdConceptsHtml, opdInsightHtml, opdScoreRing,
       opdDeltaChipHtml, opdResultsOutcomeHtml, opdQrStatus,
       buildOpdReviewCard, opdMatchListsHtml, opdSetReviewFilter,
       opdInjectPracticeCta, opdAfterRender/opdSpinRing/opdReveal,
       the entire intervention state machine + AI ladder, and every
       opdState.* field. escapeHtml / safeHtml / absUrl / fmtTimer.

   The in-test screen (shared engine, mode:'opd', view-opd-test) is NOT
   touched here — arena-desktop.js already gives it the desktop
   three-pane workspace. This file is everything AROUND the test.
   ════════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    var mql = window.matchMedia('(min-width: 1024px)');

    // Names of the globals we take over. Order is irrelevant — captured
    // (and restored) as a set on activate/deactivate.
    var TARGETS = [
        'renderOpdHub',
        'opdRenderHubBody',
        'opdSubjectHtml',
        'renderOpdChapter',
        'renderOpdResults',
        'opdIntOverlayEl',
        'renderOpdIntervention',
        'opdIntGoVerify',
        'renderOpdV3Result',
        'renderOpdAIDiagnosis',
        'renderOpdAIQuestionResult',
        'showOpdInterventionSuccess'
    ];

    var originals = {};   // name -> original fn (captured on activate)
    var active = false;

    // ── local helpers (never leak to global scope) ──
    function esc(s) {
        return (typeof escapeHtml === 'function') ? escapeHtml(s) : String(s == null ? '' : s);
    }
    function safe(s) {
        return (typeof safeHtml === 'function') ? safeHtml(s) : String(s == null ? '' : s);
    }
    function fmtT(sec) {
        return (typeof fmtTimer === 'function') ? fmtTimer(sec) : String(sec || 0);
    }
    function afterRender(root) { if (typeof opdAfterRender === 'function') opdAfterRender(root); }
    function reveal(root) { if (typeof opdReveal === 'function') opdReveal(root); }
    function spinRing(root) { if (typeof opdSpinRing === 'function') opdSpinRing(root); }
    function phase(name, extra) {
        return (typeof opdPhaseChip === 'function') ? opdPhaseChip(name, extra) : esc(name || '');
    }

    // ════════════════════════════════════════════════════════════
    // A · HUB — "Ward Rounds · Case Files"
    // Desktop: a wide hero banner, a sticky toolbar (search + filter
    // chips), then subjects as an always-visible 3-column board of
    // cards. Each card carries its head stats + count-up % + progress
    // bar + Class XI/XII toggle and a multi-column case grid inside.
    //
    // We REUSE opdCaseRowHtml verbatim (scoped inside .opddesk-casegrid),
    // and preserve every filter/search/class-toggle/empty/error/locked
    // state. The "accordion" open/closed model is replaced by an
    // always-open board — but opdState.openSubject / classLevel are
    // still honoured so nothing in the shared logic drifts.
    // ════════════════════════════════════════════════════════════

    function odHubHeader() {
        var q = opdState.hubQuery || '';
        var cl = opdState.classLevel || '11';
        var chips = [['all', 'All'], ['active', 'In progress'], ['new', 'Not started'], ['strong', 'Strong']];
        return '' +
            '<div class="opddesk-hero">' +
            '<div class="opddesk-hero-kicker">Ward Rounds · Case Files</div>' +
            '<h1>OPD</h1>' +
            '<p>Adaptive chapter tests — 5-phase journeys with concept interventions.</p>' +
            '</div>' +
            '<div class="opddesk-toolbar">' +
            '<div class="opddesk-classseg" role="tablist" aria-label="Class">' +
            '<span class="opddesk-classseg-ind ' + (cl === '12' ? 'right' : '') + '"></span>' +
            '<button type="button" role="tab" aria-selected="' + (cl === '11') + '" ' +
            'class="' + (cl === '11' ? 'on' : '') + '" onclick="opdSetClass(\'11\')">Class 11</button>' +
            '<button type="button" role="tab" aria-selected="' + (cl === '12') + '" ' +
            'class="' + (cl === '12' ? 'on' : '') + '" onclick="opdSetClass(\'12\')">Class 12</button>' +
            '</div>' +
            '<div class="opddesk-search">' +
            '<i class="fa-solid fa-magnifying-glass"></i>' +
            '<input id="opd-search-input" type="search" inputmode="search" ' +
            'placeholder="Search all chapters…" autocomplete="off" ' +
            'value="' + esc(q) + '" oninput="opdOnSearch(this.value)">' +
            '<button class="opddesk-search-clear ' + (q ? 'show' : '') + '" aria-label="Clear search" ' +
            'onclick="opdClearSearch()"><i class="fa-solid fa-xmark"></i></button>' +
            '</div>' +
            '<div class="opddesk-filters" id="opd-filters">' +
            chips.map(function (c) {
                return '<button class="opd-fchip ' + (opdState.hubFilter === c[0] ? 'on' : '') + '" ' +
                    'onclick="opdSetFilter(\'' + c[0] + '\')">' + c[1] + '</button>';
            }).join('') +
            '</div></div>';
    }

    // One subject CARD (replaces the mobile accordion column). Same data
    // math as the mobile opdSubjectHtml (avg over STARTED chapters), same
    // empty/error/filtered-empty markup, same class toggle behaviour —
    // just laid out as a persistent board card with a case grid.
    function odSubjectCard(s) {
        var chapters = opdSubjectChapters(s.key);
        var started = chapters.filter(opdChapterStarted);
        var pct = started.length
            ? Math.round(started.reduce(function (sum, c) { return sum + ((c.progress && c.progress.overall_mastery) || 0); }, 0) / started.length)
            : 0;
        var cls = opdState.classLevel || '11';
        var other = cls === '11' ? '12' : '11';
        var bs = (opdState.bySubject && opdState.bySubject[s.key]) || {};
        var list = (bs[cls] || []).filter(opdMatchesFilter);
        var counts = { '11': (bs['11'] || []).length, '12': (bs['12'] || []).length };

        var rows;
        if (bs._error) {
            rows = '<div class="opd-empty small"><i class="fa-solid fa-circle-exclamation"></i>' +
                '<h4>Couldn\'t load ' + esc(s.key) + '</h4>' +
                '<button class="btn btn-outline btn-sm" style="min-height:40px;margin-top:10px;" ' +
                'onclick="opdRetryHub()">Retry</button></div>';
        } else if (!counts['11'] && !counts['12']) {
            rows = '<div class="opd-empty small"><i class="fa-solid fa-folder-open"></i>' +
                '<h4>No chapters uploaded yet</h4></div>';
        } else if (!(bs[cls] || []).length) {
            rows = '<div class="opd-empty small"><i class="fa-solid fa-folder-open"></i>' +
                '<h4>No Class ' + cls + ' chapters yet</h4>' +
                '<button class="btn btn-outline btn-sm" style="min-height:40px;margin-top:10px;" ' +
                'onclick="opdSetClass(\'' + other + '\')">View Class ' + other +
                ' (' + counts[other] + ')</button></div>';
        } else if (!list.length) {
            rows = '<div class="opd-empty small"><i class="fa-solid fa-filter-circle-xmark"></i>' +
                '<h4>Nothing here with this filter</h4>' +
                '<button class="btn btn-outline btn-sm" style="min-height:40px;margin-top:10px;" ' +
                'onclick="opdSetFilter(\'all\')">Show all</button></div>';
        } else {
            rows = list.map(function (ch) { return opdCaseRowHtml(ch, s.key); }).join('');
        }

        // Class control is hoisted to the desktop toolbar (odHeaderHtml).
        var toggle = '';

        return '<div class="opddesk-subject" data-subject="' + esc(s.key) + '">' +
            '<div class="opddesk-subject-head">' +
            '<span class="opddesk-subject-icon"><i class="fa-solid ' + esc(s.icon) + '"></i></span>' +
            '<div class="opddesk-subject-title">' +
            '<h3>' + esc(s.key) + ' OPD</h3>' +
            '<em>' + started.length + ' of ' + chapters.length + ' cases opened</em>' +
            '</div>' +
            '<div class="opddesk-subject-pct">' +
            '<b data-count="' + pct + '" data-count-suffix="%">0%</b>' +
            '<em>' + (started.length ? 'avg. mastery' : 'not started') + '</em>' +
            '</div>' +
            '</div>' +
            '<div class="opddesk-subject-bar"><div data-w="' + pct + '" style="width:0"></div></div>' +
            (toggle ? '<div class="opddesk-subject-toggle">' + toggle + '</div>' : '') +
            '<div class="opddesk-casegrid opd-rows">' + rows + '</div>' +
            '</div>';
    }

    // Search results — reuse the exact cross-subject filter logic, laid
    // out in the desktop board. Mirrors opdSearchResultsHtml but with a
    // desktop grid per group.
    function odSearchResults() {
        var q = (opdState.hubQuery || '').trim().toLowerCase();
        var out = '', total = 0;
        OPD_SUBJECTS.forEach(function (s) {
            var hits = opdSubjectChaptersAll(s.key).filter(function (ch) {
                return String(ch.chapter_title || ch.chapter_id || '').toLowerCase().indexOf(q) !== -1
                    && opdMatchesFilter(ch);
            });
            if (!hits.length) return;
            total += hits.length;
            out += '<div class="opddesk-searchgroup">' +
                '<div class="opd-class-label"><i class="fa-solid ' + esc(s.icon) + '"></i> ' + esc(s.key) + '</div>' +
                '<div class="opddesk-casegrid">' + hits.map(function (ch) { return opdCaseRowHtml(ch, s.key, q); }).join('') + '</div>' +
                '</div>';
        });
        if (!total) {
            return '<div class="opd-empty">' +
                '<i class="fa-solid fa-magnifying-glass"></i>' +
                '<h4>No chapters match “' + esc(opdState.hubQuery) + '”</h4>' +
                '<p>Try a shorter word, or clear the filters.</p>' +
                '<button class="btn btn-outline btn-sm" style="min-height:40px;margin-top:12px;" ' +
                'onclick="opdClearSearch()">Clear search</button></div>';
        }
        return '<div class="opddesk-searchcount">' + total + ' chapter' + (total === 1 ? '' : 's') + ' found</div>' +
            '<div class="opddesk-searchwrap">' + out + '</div>';
    }

    function odRenderHubBody() {
        var body = document.getElementById('opd-hub-body');
        if (!body) return;
        opdState.caseCache = {};
        if ((opdState.hubQuery || '').trim()) {
            body.innerHTML = odSearchResults();
        } else {
            body.innerHTML = '<div class="opddesk-board">' +
                OPD_SUBJECTS.map(odSubjectCard).join('') + '</div>';
        }
        afterRender(body);
    }

    function odRenderHub(container) {
        container = container || document.getElementById('opd-content');
        if (!container) return;
        opdState.caseCache = {};

        // Class defaulting is owned by the shared mobile renderer
        // (opdState.classLevel, seeded once in renderOpdHub). The board
        // just reads it.
        if (!opdState._classSeeded) {
            var any12 = OPD_SUBJECTS.some(function (s2) {
                return (((opdState.bySubject || {})[s2.key] || {})['12'] || []).some(opdChapterStarted);
            });
            var has11 = OPD_SUBJECTS.some(function (s2) {
                return (((opdState.bySubject || {})[s2.key] || {})['11'] || []).length;
            });
            opdState.classLevel = any12 ? '12' : (has11 ? '11' : '12');
            opdState._classSeeded = true;
        }

        container.innerHTML = '<div class="opddesk-page opddesk-hub">' +
            odHubHeader() +
            '<div id="opd-hub-body"></div>' +
            '</div>';
        odRenderHubBody();
    }

    // opdSubjectHtml is called by opdSetClass's fallback path only when
    // the col isn't found; on desktop opdSetClass finds .opd-subject-col
    // by attribute — our card uses .opddesk-subject, so opdSetClass's
    // querySelector('.opd-subject-col…') misses and it falls back to
    // opdRenderHubBody() (which is our override). That's correct and
    // repaints the board. We still override opdSubjectHtml so any direct
    // caller gets desktop markup.
    function odSubjectHtml(s) { return odSubjectCard(s); }

    // ════════════════════════════════════════════════════════════
    // B · CHAPTER / CASE-FILE — two-pane.
    // LEFT (sticky): chapter head + stats + the single hero CTA
    //   (opdHeroActionHtml verbatim → full state machine preserved).
    // RIGHT: Test Journey (renderOpdJourney verbatim) + concepts
    //   (opdConceptsHtml) + consultant insight (opdInsightHtml).
    // baseline capture + retake path live in helpers we don't override.
    // ════════════════════════════════════════════════════════════
    function odRenderChapter(data, container) {
        container = container || document.getElementById('opd-chapter-content');
        if (!container) return;
        var ch = data.chapter || {};
        var prog = data.progress || {};

        var heroAction = (typeof opdHeroActionHtml === 'function') ? opdHeroActionHtml(data) : '';
        var journey = (typeof renderOpdJourney === 'function') ? renderOpdJourney(prog, data) : '';
        var concepts = (typeof opdConceptsHtml === 'function') ? opdConceptsHtml(prog) : '';
        var insight = (typeof opdInsightHtml === 'function') ? opdInsightHtml(data) : '';
        var backBar = '<button class="opddesk-backbar" onclick="navigate(\'opd\')">' +
            '<i class="fa-solid fa-chevron-left"></i><span>Back to OPD</span></button>';

        container.innerHTML =
            '<div class="opddesk-page opddesk-chapter">' +
            backBar +
            '<div class="opddesk-chapter-grid">' +

            '<aside class="opddesk-chapter-side">' +
            '<div class="opddesk-chapter-head">' +
            '<h2>' + esc(ch.chapter_title || opdState.chapterId) + '</h2>' +
            '<p>' + (ch.total_concepts || 0) + ' concepts · ' + (ch.total_questions || 0) + ' questions</p>' +
            '<div class="opddesk-chapter-stats">' +
            '<div><b data-count="' + (prog.overall_mastery || 0) + '" data-count-suffix="%">0%</b><span>Mastery</span></div>' +
            '<div><b>' + esc(prog.current_difficulty || 'Easy') + '</b><span>Current level</span></div>' +
            '</div>' +
            '</div>' +
            heroAction +
            '</aside>' +

            '<div class="opddesk-chapter-main">' +
            '<div class="opddesk-seclabel"><i class="fa-solid fa-list-check"></i> Test Journey</div>' +
            '<div class="opd-journey opddesk-journey">' + journey + '</div>' +
            '<div class="opddesk-seclabel"><i class="fa-solid fa-chart-simple"></i> Overall mastery by concept</div>' +
            concepts +
            insight +
            '</div>' +

            '</div></div>';

        afterRender(container);
        var page = container.querySelector('.opddesk-page');
        if (page) reveal(page);
    }

    // ════════════════════════════════════════════════════════════
    // C · RESULTS DASHBOARD + past-test analysis.
    // Two columns: sticky SUMMARY (score hero + #opd-res-outcome host +
    // badges) and MAIN (concept breakdown + degrade note + question
    // review + practice CTA). Reuses opdScoreRing, opdDeltaChipHtml,
    // opdResultsOutcomeHtml, opdQrStatus, buildOpdReviewCard,
    // opdMatchListsHtml verbatim. Covers analysis via the same override.
    //
    // The #opd-res-outcome id is preserved so opdRefreshResultsOutcome /
    // finishOpdInterventions can patch the outcome card in place after
    // the cascade clears the lock.
    // ════════════════════════════════════════════════════════════
    function odRenderResults(results, opts) {
        opts = opts || {};
        var container = document.getElementById(opts.containerId || 'opd-results-content');
        if (!container) return;
        var analysis = !!opts.analysis;
        var passThreshold = results.pass_threshold || (typeof opdPassThreshold === 'function' ? opdPassThreshold() : OPD_PASS_DEFAULT);
        var pct = results.percentage || 0;
        var failed = pct < passThreshold;
        var ph = results.phase || '';
        opdState.reviewFilter = 'all';

        var attempted = analysis
            ? (results.question_results || []).filter(function (qr) {
                return qr.student_answer !== null && qr.student_answer !== undefined && qr.student_answer !== '';
            }).length
            : opdState.lastAnsweredCount;

        var rawTime = Math.max(0, results.time_taken_seconds || 0);
        var tone = pct >= OPD_STRONG ? 'good' : failed ? 'bad' : 'warm';
        var deltaHtml = analysis ? '' : (typeof opdDeltaChipHtml === 'function' ? opdDeltaChipHtml(results, pct) : '');

        var badges = '';
        if (!analysis && (results.is_flex || (results.bonus_pool_added || 0) > 0)) {
            badges = '<div class="opd-res-badges">' +
                (results.is_flex ? '<span class="ph-chip amber"><i class="fa-solid fa-bolt"></i> Flex remediation test</span>' : '') +
                ((results.bonus_pool_added || 0) > 0 ? '<span class="ph-chip green"><i class="fa-solid fa-gift"></i> +' +
                    results.bonus_pool_added + ' to Bonus Pool</span>' : '') +
                '</div>';
        }

        var dateStr = (typeof opdFmtDate === 'function') ? opdFmtDate(opts.completedAt) : '';
        var heroSub = analysis
            ? 'Test ' + results.test_num + (dateStr ? ' · taken ' + dateStr : '')
            : 'Test ' + results.test_num + (results.is_retake ? ' · Retake' : '');

        // Outcome card — identical branch decision to the mobile renderer.
        var outcomeHtml = (analysis && !results.needs_retake)
            ? '' : (typeof opdResultsOutcomeHtml === 'function' ? opdResultsOutcomeHtml(results, passThreshold, analysis) : '');

        // Concept breakdown for THIS test (non-analysis) — reuse the exact
        // mobile filtering + tone logic.
        var conceptHtml = '';
        if (!analysis && (results.concept_breakdown || []).length) {
            var tested = results.concept_breakdown.filter(function (cb) { return (cb.test_total || 0) > 0; });
            var untested = results.concept_breakdown.length - tested.length;
            var META = {
                mastered: { icon: 'fa-circle-check', cls: 'good' },
                learning: { icon: 'fa-circle-half-stroke', cls: 'warm' },
                struggling: { icon: 'fa-circle-exclamation', cls: 'bad' }
            };
            var crows = tested.map(function (cb) {
                var acc = Math.round((cb.test_correct || 0) / cb.test_total * 100);
                var cls = acc >= OPD_STRONG ? 'good' : acc >= 40 ? 'warm' : 'bad';
                var meta = META[cb.status] || { icon: 'fa-circle', cls: '' };
                return '<div class="opd-concept-row ' + cls + '">' +
                    '<span class="opd-concept-icon ' + meta.cls + '"><i class="fa-solid ' + meta.icon + '"></i></span>' +
                    '<div class="opd-concept-main">' +
                    '<div class="opd-concept-name">' + esc(cb.concept_name || cb.concept_id) + '</div>' +
                    '<div class="opd-concept-bar"><i class="' + cls + '" data-w="' + acc + '" style="width:0"></i></div>' +
                    '<div class="opd-concept-foot"><span class="opd-concept-status ' + meta.cls + '">Overall mastery ' + (cb.overall_mastery || 0) + '%</span></div>' +
                    '</div>' +
                    '<span class="opd-concept-pct ' + cls + '">' + cb.test_correct + '/' + cb.test_total + '</span>' +
                    '</div>';
            }).join('');
            conceptHtml = '<div class="opddesk-seclabel"><i class="fa-solid fa-microscope"></i> How you did on this test</div>' +
                '<div class="opd-concepts">' + (crows || '<p style="color:var(--s400);font-size:.82rem;padding:12px;">No concept-level data for this test.</p>') + '</div>' +
                (untested > 0 ? '<p class="opd-subnote">' + untested + ' other concept' + (untested === 1 ? '' : 's') + ' in this chapter weren\'t covered by this test.</p>' : '');
        }

        var qrs = results.question_results || [];
        var degraded = analysis && !opts.rich;
        var degradeNote = degraded ? '<div class="opd-note amber">' +
            '<i class="fa-solid fa-circle-info"></i>' +
            '<div><b>This is the short version</b>' +
            '<p>Crackers, elimination guides, traps and NCERT references are generated with your result ' +
            'the moment you finish a test — they aren\'t stored with the archive. Your answers and ' +
            'explanations are all here. Retake this test to see the full notes again.</p></div></div>' : '';

        var counts = {
            all: qrs.length,
            wrong: qrs.filter(function (q) { return opdQrStatus(q) === 'wrong'; }).length,
            skipped: qrs.filter(function (q) { return opdQrStatus(q) === 'unattempted'; }).length,
            correct: qrs.filter(function (q) { return opdQrStatus(q) === 'correct'; }).length
        };
        var fchips = [['all', 'All', counts.all], ['wrong', 'Wrong', counts.wrong],
        ['skipped', 'Skipped', counts.skipped], ['correct', 'Correct', counts.correct]];

        var reviewFilters = qrs.length ? '<div class="opd-revfilters" id="opd-revfilters">' +
            fchips.filter(function (c) { return c[0] === 'all' || c[2] > 0; }).map(function (c) {
                return '<button class="opd-fchip ' + c[0] + ' ' + (c[0] === 'all' ? 'on' : '') + '" ' +
                    'onclick="opdSetReviewFilter(\'' + c[0] + '\')">' + c[1] + ' <b>' + c[2] + '</b></button>';
            }).join('') + '</div>' : '';

        var reviewList = qrs.map(function (qr, i) { return buildOpdReviewCard(qr, i, degraded); }).join('')
            || '<p style="color:var(--s400);font-size:.82rem;">No question data.</p>';

        var backBar = '<button class="opddesk-backbar" onclick="opdBackToChapter()">' +
            '<i class="fa-solid fa-chevron-left"></i><span>Back to case</span></button>';

        // Summary column — score hero on a dark card (opddesk-res-hero),
        // reusing opdScoreRing (with pass-tick). The ring is recoloured for
        // dark by the CSS, scoped to .opddesk-res-hero.
        var summary =
            '<div class="opddesk-res-hero ' + tone + ' ' + (analysis ? 'archival' : '') + '">' +
            '<div class="opd-res-phase">' + (ph ? phase(ph) : '') + '<span>' + esc(heroSub) + '</span></div>' +
            '<div class="opd-res-ringwrap">' +
            (typeof opdScoreRing === 'function' ? opdScoreRing(pct, passThreshold, tone) : '') +
            '<div class="opd-res-ringinner">' +
            '<b data-count="' + pct + '" data-count-suffix="%">0%</b>' +
            '<span>' + results.score + '/' + results.total + '</span>' +
            '</div></div>' +
            '<div class="opd-res-line">' +
            '<span class="opd-res-passline"><i class="fa-solid fa-flag-checkered"></i> Pass mark ' + passThreshold + '%</span>' +
            deltaHtml +
            '</div>' +
            badges +
            '<div class="opd-res-meta">' +
            '<div><b>' + fmtT(rawTime) + '</b><span>Time taken</span></div>' +
            '<div><b>' + attempted + '/' + results.total + '</b><span>Attempted</span></div>' +
            (!analysis && results.overall_mastery !== undefined
                ? '<div><b>' + results.overall_mastery + '%</b><span>Chapter mastery</span></div>' : '') +
            '</div></div>' +
            '<div id="opd-res-outcome">' + outcomeHtml + '</div>';

        var main =
            conceptHtml +
            degradeNote +
            '<div class="opddesk-seclabel"><i class="fa-solid fa-magnifying-glass-chart"></i> Question-by-question review</div>' +
            reviewFilters +
            '<div id="opd-revlist">' + reviewList + '</div>';

        container.innerHTML =
            '<div class="opddesk-page opddesk-results">' +
            backBar +
            '<div class="opddesk-res-grid">' +
            '<div class="opddesk-res-summary">' + summary + '</div>' +
            '<div class="opddesk-res-main">' + main + '</div>' +
            '</div></div>';

        afterRender(container);
        spinRing(container);
        window.scrollTo({ top: 0 });
    }

    // ════════════════════════════════════════════════════════════
    // D · V3 INTERVENTION CASCADE — re-homed as a centred desktop modal.
    // We override opdIntOverlayEl so the SAME ids are built
    // (#opd-int-overlay / .opd-int-card / #opd-int-rail / #opd-int-content)
    // — opdIntSwap, opdIntRail and every step renderer keep working — but
    // wrapped in an .opddesk-int-modal shell that the gated CSS styles as
    // a wide, centred, two-column card (rail as a real side rail,
    // comfortable reading width). The step logic, intervention_type
    // branches, endpoints, and opdState.intervention* mutations are
    // untouched.
    //
    // The step render OVERRIDES (renderOpdIntervention / opdIntGoVerify /
    // renderOpdV3Result / renderOpdAIDiagnosis / renderOpdAIQuestionResult
    // / showOpdInterventionSuccess) simply DELEGATE to the originals: the
    // overlay's desktop layout comes entirely from CSS scoped inside
    // .opddesk-int-modal, so no markup fork is needed and no branch can be
    // lost. We keep them on the TARGETS list anyway so that (a) the
    // capture/restore contract is symmetric and (b) if a future desktop
    // needs a markup tweak it has a home — but delegating is the safest
    // possible re-home: byte-identical behaviour, CSS-only presentation.
    // ════════════════════════════════════════════════════════════
    function odIntOverlayEl() {
        var el = document.getElementById('opd-int-overlay');
        if (!el) {
            el = document.createElement('div');
            el.id = 'opd-int-overlay';
            el.className = 'opd-int-overlay opddesk-int-modal';
            el.innerHTML = '<div class="opd-int-card">' +
                '<div class="opd-int-rail" id="opd-int-rail"></div>' +
                '<div id="opd-int-content"></div>' +
                '</div>';
            document.body.appendChild(el);
        } else {
            // If the overlay already exists (e.g. built by the mobile
            // builder before a resize into desktop), tag it so the modal
            // CSS applies without rebuilding / losing in-flight content.
            el.classList.add('opddesk-int-modal');
        }
        return el;
    }

    function odRenderIntervention() {
        if (typeof originals.renderOpdIntervention === 'function') originals.renderOpdIntervention();
    }
    function odIntGoVerify() {
        if (typeof originals.opdIntGoVerify === 'function') originals.opdIntGoVerify();
    }
    function odRenderV3Result(result, intervention) {
        if (typeof originals.renderOpdV3Result === 'function') originals.renderOpdV3Result(result, intervention);
    }
    function odRenderAIDiagnosis(diagnosis, intervention, source) {
        if (typeof originals.renderOpdAIDiagnosis === 'function') originals.renderOpdAIDiagnosis(diagnosis, intervention, source);
    }
    function odRenderAIQuestionResult(result, studentAnswer) {
        if (typeof originals.renderOpdAIQuestionResult === 'function') originals.renderOpdAIQuestionResult(result, studentAnswer);
    }
    function odShowInterventionSuccess() {
        if (typeof originals.showOpdInterventionSuccess === 'function') originals.showOpdInterventionSuccess();
    }

    // ════════════════════════════════════════════════════════════
    // ACTIVATION / DEACTIVATION
    // ════════════════════════════════════════════════════════════
    var overrideMap = {
        renderOpdHub: odRenderHub,
        opdRenderHubBody: odRenderHubBody,
        opdSubjectHtml: odSubjectHtml,
        renderOpdChapter: odRenderChapter,
        renderOpdResults: odRenderResults,
        opdIntOverlayEl: odIntOverlayEl,
        renderOpdIntervention: odRenderIntervention,
        opdIntGoVerify: odIntGoVerify,
        renderOpdV3Result: odRenderV3Result,
        renderOpdAIDiagnosis: odRenderAIDiagnosis,
        renderOpdAIQuestionResult: odRenderAIQuestionResult,
        showOpdInterventionSuccess: odShowInterventionSuccess
    };

    // Tag each override with a marker so a resize back to mobile can be
    // verified to have fully restored the originals (originals carry no tag).
    // Non-enumerable, defined once; invisible to the app and to for..in.
    Object.keys(overrideMap).forEach(function (name) {
        try { Object.defineProperty(overrideMap[name], '__opddeskOverride', { value: true }); } catch (e) { }
    });

    function activate() {
        if (active) return;
        active = true;
        TARGETS.forEach(function (name) {
            if (!(name in originals)) originals[name] = window[name]; // capture once, verbatim
            if (typeof overrideMap[name] === 'function') window[name] = overrideMap[name];
        });
        repaintActiveView();
    }

    function deactivate() {
        if (!active) return;
        active = false;
        TARGETS.forEach(function (name) {
            if (name in originals) window[name] = originals[name]; // restore verbatim
        });
        // Drop the desktop modal tag if the overlay exists, so the mobile
        // sheet CSS takes over cleanly after a resize down.
        var ov = document.getElementById('opd-int-overlay');
        if (ov) ov.classList.remove('opddesk-int-modal');
        repaintActiveView();
    }

    // Repaint whichever OPD view is currently active, using whatever
    // (original or override) is now installed, so a viewport cross is
    // seamless. Best-effort; never throws into the app.
    function repaintActiveView() {
        try {
            var isActive = function (id) {
                var el = document.getElementById(id);
                return el && el.classList.contains('active');
            };
            if (isActive('view-opd') && opdState.bySubject && typeof renderOpdHub === 'function') {
                renderOpdHub(document.getElementById('opd-content'));
                requestAnimationFrame(function () { window.scrollTo({ top: opdState.hubScroll || 0 }); });
            } else if (isActive('view-opd-chapter') && opdState.chapterData && typeof renderOpdChapter === 'function') {
                renderOpdChapter(opdState.chapterData, document.getElementById('opd-chapter-content'));
            } else if (isActive('view-opd-results') && opdState.lastResult && typeof renderOpdResults === 'function') {
                renderOpdResults(opdState.lastResult, { containerId: 'opd-results-content' });
            } else if (isActive('view-opd-analysis') && opdState.analysisResults && typeof renderOpdResults === 'function') {
                var ctx = opdState.analysisCtx || {};
                renderOpdResults(opdState.analysisResults, {
                    analysis: true,
                    containerId: 'opd-analysis-content',
                    completedAt: ctx.completedAt || '',
                    rich: !!(opdState.sessionCache && ctx.sessionId && opdState.sessionCache[ctx.sessionId])
                });
                if (typeof opdInjectPracticeCta === 'function') opdInjectPracticeCta('opd-analysis-content', opdState.analysisResults);
            }
            // A live intervention overlay: if it's open, repaint the current
            // step so the modal/sheet layout matches the new viewport. The
            // step renderers read opdState.intStep and re-emit into
            // #opd-int-content, so this is state-preserving.
            var ov = document.getElementById('opd-int-overlay');
            if (ov && ov.classList.contains('open') && opdState.interventions && opdState.interventions.length) {
                if (opdState.intStep === 'verify' && typeof opdIntGoVerify === 'function') {
                    // verify re-reads selectedAnswer=null on entry; safest is to
                    // repaint the review step, which is idempotent, and let the
                    // student re-advance. But to avoid losing a verify screen we
                    // only repaint review when on the review step.
                    if (typeof renderOpdIntervention === 'function') renderOpdIntervention();
                } else if (typeof renderOpdIntervention === 'function') {
                    renderOpdIntervention();
                }
            }
        } catch (e) { /* repaint is best-effort */ }
    }

    // ── The self-gate. On phones: register ONE idle listener and do
    //    nothing else. At ≥1024: activate. Toggle on viewport cross. ──
    function onChange() {
        if (mql.matches) activate();
        else deactivate();
    }
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else if (mql.addListener) mql.addListener(onChange); // older Safari

    if (mql.matches) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', activate, { once: true });
        } else {
            activate();
        }
    }
    // else: phone — nothing happens beyond the idle listener above.

    console.log('OPD desktop layer ready (gated ≥1024px) ✅');
})();