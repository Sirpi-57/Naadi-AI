/* ════════════════════════════════════════════════════════════════
   NAADI AI — ARENA DESKTOP ENGINE  (arena-desktop.js)
   ─────────────────────────────────────────────────────────────────
   Desktop-native (≥1024px) presentation for the whole ARENA section
   and the shared test-taking workspace. Mirrors the Concept Studio
   desktop pattern EXACTLY:

     • One IIFE, self-gated with matchMedia('(min-width:1024px)').
     • On a phone: registers ONE idle change-listener and does nothing
       else — no globals reassigned, nothing rendered, no DOM touched.
     • At ≥1024px: captures the mobile entry points, overrides them,
       and RESTORES the originals verbatim if the viewport drops below
       1024px (e.g. window resize / devtools).

   It overrides PRESENTATION ONLY. Every override reuses the mobile
   engine's own state + behaviour globals:
       shadeOmrBubble, jumpToQuestion, toggleMarkForReview,
       setTestSubject, testNav, confirmExitTest, confirmSubmitTest,
       submitPracticeTest, startTestTimer, testState, visibleIndexes,
       paletteStateOf, testSubjects, buildMatchHtml, optionBodyHtml,
       recomputeAir, setReviewFilter, reviewItemHtml, openFlashcard,
       pv2ToggleColleges, pv2ToggleHistGroup, viewPastSession,
       hubStartFullPaper, hubStartCustomTest, beginFullPaperSession,
       setBuilderFilter, toggleBuilderMulti, setChapterSearch,
       toggleChapGroup, clearChapters, ensureChapterTree,
       runPyqFilterPreview, csRingHTML / csAnimateRing / csCountUp,
       escapeHtml / safeHtml / absUrl / fmtTimer / pv2Fmt …

   Nothing in test-engine.js / practice-hub.js is edited. The OMR
   "shade once, locked forever" rule and the bubble internals are
   untouched — we only relocate them from the drawer into a
   persistent side panel. Because renderTestShell / renderTestQuestion
   / openOmrDrawer / openPaletteDrawer are shared, OPD test-taking
   inherits this workspace too (expected + safe; OPD's own results
   renderer renderOpdResults is separate and untouched).
   ════════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    var mql = window.matchMedia('(min-width: 1024px)');

    // Names of the globals we take over. Order doesn't matter.
    var TARGETS = [
        'loadArenaLanding',
        'loadPyqLanding',
        'renderPyqLanding',
        'refreshChapterPicker',
        'setChapterSearch',
        'toggleChapGroup',
        'clearChapters',
        'loadAirRankings',
        'loadPaperLeaderboard',
        'loadPracticeHistory',
        'renderTestResults',
        'renderTestShell',
        'renderTestQuestion',
        'openOmrDrawer',
        'openPaletteDrawer'
    ];

    var originals = {};   // name -> original fn (captured on activate)
    var active = false;

    // ── small local helpers (never leak to global scope) ──
    function esc(s) {
        return (typeof escapeHtml === 'function') ? escapeHtml(s) : String(s == null ? '' : s);
    }
    function safe(s) {
        return (typeof safeHtml === 'function') ? safeHtml(s) : String(s == null ? '' : s);
    }
    function abs(u) {
        return (typeof absUrl === 'function') ? absUrl(u) : u;
    }
    function fmtN(n) {
        return (typeof pv2Fmt === 'function') ? pv2Fmt(n) : Number(n || 0).toLocaleString('en-IN');
    }
    function ring(id, pct, size, stroke) {
        return (typeof csRingHTML === 'function') ? csRingHTML(id, pct, size, stroke) : '';
    }
    function animRing(id) { if (typeof csAnimateRing === 'function') csAnimateRing(id); }

    // ════════════════════════════════════════════════════════════
    // A · NEET ARENA LANDING
    // ════════════════════════════════════════════════════════════
    function adPaperCard(p, mode, attemptMap) {
        var code = esc(String(p.paper_code != null ? p.paper_code : ''));
        var done = attemptMap[p.year + '|' + p.paper_code];
        var donePct = (done && done.max) ? Math.round((done.marks / done.max) * 100) : 0;
        var subjects = (p.subjects || [])
            .map(function (s) { return typeof s === 'string' ? s : (s && (s.name || s.subject)) || ''; })
            .filter(Boolean).join(' · ');
        var chips = '<span class="ad-chip">+4 / −1</span>';
        if (p.mta_questions > 0) chips += '<span class="ad-chip grad">' + p.mta_questions + ' MTA</span>';
        if (done) {
            chips += '<span class="ad-chip best"><i class="fa-solid fa-circle-check"></i> Best ' +
                done.marks + (done.max ? '/' + done.max : '') + ' · ' + donePct + '%' +
                (done.attempts > 1 ? ' · ' + done.attempts + '×' : '') + '</span>';
        }
        var codeS = code.replace(/'/g, "\\'");
        return '<div class="ad-paper ' + (done ? 'done' : '') + '" ' +
            'onclick="hubStartFullPaper(\'' + mode + '\', ' + Number(p.year) + ', \'' + codeS + '\')">' +
            '<div class="ad-paper-top">' +
            '<div class="ad-paper-code">' + (code || '—') + '</div>' +
            '<div style="flex:1;min-width:0;">' +
            '<h4>NEET ' + p.year + ' · Paper ' + code + '</h4>' +
            '<div class="ad-paper-meta">' + esc(p.exam || 'NEET (UG)') + ' · ' + (p.total_questions || 0) + ' questions' +
            (subjects ? ' · ' + esc(subjects) : '') + '</div>' +
            '</div></div>' +
            '<div class="ad-paper-chips">' + chips + '</div>' +
            '</div>';
    }

    function adLoadArenaLanding() {
        var container = document.getElementById('arena-content');
        if (!container) return;
        var switcher = (typeof hubSwitcherHtml === 'function') ? hubSwitcherHtml('arena') : '';
        container.innerHTML = '<div class="ad-switch-hold">' + switcher + '</div>' +
            '<div class="ad-page"><div class="loading-spinner"><div class="spinner"></div> Loading papers...</div></div>';

        Promise.resolve()
            .then(function () {
                if (hubState.arenaPapers) return hubState.arenaPapers;
                return apiCall('/api/arena/papers').then(function (r) { hubState.arenaPapers = r; return r; });
            })
            .then(function (data) {
                return ensureAttemptMap('arena').then(function (attemptMap) {
                    var years = Object.keys((data.by_year) || {}).sort(function (a, b) { return Number(b) - Number(a); });
                    var attemptedCount = Object.keys(attemptMap).length;

                    var rail = '<div class="ad-yearrail"><div class="ad-yearrail-title">Jump to year</div>' +
                        years.map(function (yr) {
                            var n = (data.by_year[yr] || []).length;
                            return '<button onclick="document.getElementById(\'ad-yr-' + yr + '\').scrollIntoView({behavior:\'smooth\',block:\'start\'})">' +
                                'NEET ' + esc(yr) + '<small>' + n + '</small></button>';
                        }).join('') + '</div>';

                    var grid = years.length ? years.map(function (yr) {
                        var cards = (data.by_year[yr] || []).map(function (p) {
                            return adPaperCard(p, 'arena', attemptMap);
                        }).join('');
                        return '<div class="ad-year-block" id="ad-yr-' + esc(yr) + '">' +
                            '<div class="ad-seclabel"><span>NEET ' + esc(yr) + '</span><span class="ln"></span></div>' +
                            '<div class="ad-papers-grid">' + cards + '</div></div>';
                    }).join('') :
                        '<div class="empty-state"><i class="fa-solid fa-file-circle-question"></i>' +
                        '<h3>No papers available yet</h3><p style="margin-top:8px;color:var(--s500);">Full NEET papers will appear here once uploaded.</p></div>';

                    container.innerHTML = '<div class="ad-switch-hold">' + switcher + '</div>' +
                        '<div class="ad-page">' +
                        '<div class="ad-hero">' +
                        '<div>' +
                        '<div class="ad-hero-kicker">NEET Arena · Exam mode</div>' +
                        '<h1>Fight for your rank.</h1>' +
                        '<p>Full papers under real exam conditions — locked OMR answers, a strict timer, ' +
                        'AIR prediction and college cutoffs. Your best attempt counts.</p>' +
                        '<div class="ad-hero-actions">' +
                        '<button class="ad-hero-btn" onclick="navigate(\'arena-history\')"><i class="fa-solid fa-clock-rotate-left"></i> My attempts</button>' +
                        '<button class="ad-hero-btn" onclick="navigate(\'air\')"><i class="fa-solid fa-ranking-star"></i> AIR rankings</button>' +
                        '</div></div>' +
                        '<div class="ad-hero-stats">' +
                        '<div><b>' + (data.total_papers || 0) + '</b><span>Papers</span></div>' +
                        '<div><b>+4 / −1</b><span>Marking</span></div>' +
                        '<div><b>' + attemptedCount + '</b><span>Attempted</span></div>' +
                        '</div></div>' +
                        '<div class="ad-arena-body">' + rail +
                        '<div class="ad-papers-scroll">' + grid + '</div>' +
                        '</div></div>';
                });
            })
            .catch(function (e) {
                container.innerHTML = '<div class="ad-switch-hold">' + switcher + '</div>' +
                    '<div class="ad-page"><div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i>' +
                    '<h3>Could not load Arena</h3><p style="margin-top:8px;color:var(--s500);">' + esc(e.message) + '</p>' +
                    '<button class="btn btn-outline" style="margin-top:16px;min-height:44px;" onclick="hubState.arenaPapers=null;loadArenaLanding()">' +
                    '<i class="fa-solid fa-rotate-right"></i> Retry</button></div></div>';
            });
    }

    // ════════════════════════════════════════════════════════════
    // B · PYQ VAULT — two-pane builder
    // ════════════════════════════════════════════════════════════
    // We reuse the mobile chapter tree + filter preview state and the
    // mobile handler globals. Only the markup differs. The mobile
    // preview writer updateFilterPreviewUI targets #pyq-filter-preview
    // and #pyq-custom-start; we KEEP those same ids so it still works.

    function adChapterPicker() {
        var f = hubState.filters;
        if (!hubState.chapterTree) {
            return '<div class="ad-chap-loading"><div class="spinner"></div> Loading chapter list…</div>';
        }
        var groups = (typeof visibleChapterGroups === 'function') ? visibleChapterGroups() : [];
        var open = hubState._openChapGroups || new Set();
        var selectedCount = f.chapters.length;
        var search = '<div class="ad-chap-search"><i class="fa-solid fa-magnifying-glass"></i>' +
            '<input type="text" id="pyq-chap-search" placeholder="Search chapters…" value="' + esc(hubState.chapterSearch || '') + '" ' +
            'oninput="setChapterSearch(this.value)">' +
            (selectedCount ? '<button class="ad-chap-clear" onclick="clearChapters()">Clear ' + selectedCount + '</button>' : '') +
            '</div>';

        if (!groups || !groups.length) {
            return '<div class="ad-chap">' + search +
                '<p class="ad-chap-empty">No chapters match. Leave chapters unselected to include everything in the class &amp; subject you picked.</p></div>';
        }
        var forceOpen = !!(hubState.chapterSearch || '').trim() || groups.length === 1;
        var body = groups.map(function (g) {
            var key = g.cls + '|' + g.sub;
            var isOpen = forceOpen || open.has(key);
            var selHere = g.chapters.filter(function (c) { return f.chapters.includes(chapKey(g.sub, c)); }).length;
            var chips = g.chapters.map(function (c) {
                var k = chapKey(g.sub, c);
                var escd = k.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                return '<button class="ad-fchip sm ' + (f.chapters.includes(k) ? 'active' : '') + '" ' +
                    'onclick="toggleBuilderMulti(\'chapters\',\'' + escd + '\')">' + esc(c) + '</button>';
            }).join('');
            return '<div class="ad-chap-group ' + (isOpen ? 'open' : '') + '">' +
                '<button class="ad-chap-ghead" onclick="toggleChapGroup(\'' + key + '\')">' +
                '<span class="ad-chap-sub">Class ' + g.cls + ' · ' + esc(g.sub) + '</span>' +
                '<span class="ad-chap-meta">' + (selHere ? '<span class="ad-chap-selpill">' + selHere + '</span>' : '') +
                g.chapters.length + '<i class="fa-solid fa-chevron-down"></i></span></button>' +
                '<div class="ad-chap-chips">' + chips + '</div></div>';
        }).join('');
        return '<div class="ad-chap">' + search + '<div class="ad-chap-scroll">' + body + '</div></div>';
    }

    // Desktop repaint of just the chapter picker box. The mobile
    // refreshChapterPicker / setChapterSearch / toggleChapGroup /
    // clearChapters all write the MOBILE chapterPickerHtml() into
    // #pyq-chap-picker (an id our desktop builder also uses). We override
    // them so the SAME id gets our desktop adChapterPicker() markup, and
    // preserve their side-effects (state mutation + preview refresh).
    function adRefreshChapterPicker() {
        var box = document.getElementById('pyq-chap-picker');
        if (box) box.innerHTML = adChapterPicker();
    }
    function adSetChapterSearch(v) {
        hubState.chapterSearch = v;
        var box = document.getElementById('pyq-chap-picker');
        if (!box) return;
        box.innerHTML = adChapterPicker();
        var inp = document.getElementById('pyq-chap-search');
        if (inp) { inp.focus(); var n = inp.value.length; try { inp.setSelectionRange(n, n); } catch (e) { } }
    }
    function adToggleChapGroup(key) {
        if (!hubState._openChapGroups) hubState._openChapGroups = new Set();
        var s = hubState._openChapGroups;
        if (s.has(key)) s.delete(key); else s.add(key);
        adRefreshChapterPicker();
    }
    function adClearChapters() {
        hubState.filters.chapters = [];
        adRefreshChapterPicker();
        if (typeof runPyqFilterPreview === 'function') runPyqFilterPreview();
    }

    function adBuilderMain() {
        var f = hubState.filters;
        var years = (typeof builderYearOptions === 'function') ? builderYearOptions() : [];
        var chip = function (label, activeC, onclick) {
            return '<button class="ad-fchip ' + (activeC ? 'active' : '') + '" onclick="' + onclick + '">' + label + '</button>';
        };
        var classChips = [
            chip('Any', !f.ncert_class, "setBuilderFilter('ncert_class','')"),
            chip('Class 11', String(f.ncert_class) === '11', "setBuilderFilter('ncert_class','11')"),
            chip('Class 12', String(f.ncert_class) === '12', "setBuilderFilter('ncert_class','12')")
        ].join('');
        var subjectChips = PH_SUBJECTS.map(function (s) {
            return chip(s, f.subjects.includes(s), "toggleBuilderMulti('subjects','" + s + "')");
        }).join('');
        var yearChips = [chip('Any', !f.year, "setBuilderFilter('year','')")]
            .concat(years.map(function (y) { return chip(esc(y), String(f.year) === String(y), "setBuilderFilter('year','" + y + "')"); }))
            .join('');
        var countChips = [10, 20, 30, 45, 60, 90, 180].map(function (n) {
            return chip(String(n), Number(f.count) === n, "setBuilderFilter('count','" + n + "')");
        }).join('');

        return '<div class="ad-builder-main">' +
            '<div class="ad-bgroup"><label>Class</label><div class="ad-chiprow">' + classChips + '</div></div>' +
            '<div class="ad-bgroup"><label>Subject</label><div class="ad-chiprow">' + subjectChips + '</div></div>' +
            '<div class="ad-bgroup"><label>Chapters</label><div id="pyq-chap-picker">' + adChapterPicker() + '</div></div>' +
            '<div class="ad-bgroup"><label>Year <span class="ad-opt">optional</span></label><div class="ad-chiprow">' + yearChips + '</div></div>' +
            '<div class="ad-bgroup" style="margin-bottom:0;"><label>Number of questions</label><div class="ad-chiprow">' + countChips + '</div></div>' +
            '</div>';
    }

    function adBuilderSide() {
        var f = hubState.filters;
        var subjLabel = f.subjects.length ? f.subjects.join(', ') : 'All subjects';
        var classLabel = f.ncert_class ? ('Class ' + f.ncert_class) : 'Class 11 & 12';
        var chapLabel = f.chapters.length ? (f.chapters.length + ' selected') : 'All in scope';
        return '<div class="ad-builder-side">' +
            '<div class="ad-summary">' +
            '<h3>Your custom drill</h3>' +
            '<div class="ad-sum-sub">NEET marking · server-scored · OMR-locked</div>' +
            '<div class="ad-sum-preview" id="pyq-filter-preview">' +
            '<div class="loading-spinner" style="padding:0;"><div class="spinner"></div></div></div>' +
            '<div class="ad-sum-rows">' +
            '<div class="ad-sum-row"><span>Class</span><b>' + esc(classLabel) + '</b></div>' +
            '<div class="ad-sum-row"><span>Subjects</span><b>' + esc(subjLabel) + '</b></div>' +
            '<div class="ad-sum-row"><span>Chapters</span><b>' + esc(chapLabel) + '</b></div>' +
            '<div class="ad-sum-row"><span>Year</span><b>' + (f.year ? esc(f.year) : 'Any') + '</b></div>' +
            '<div class="ad-sum-row"><span>Test size</span><b>' + (Number(f.count) || 20) + ' Qs</b></div>' +
            '</div>' +
            '<button class="ad-start-btn" id="pyq-custom-start" disabled onclick="hubStartCustomTest()">' +
            '<i class="fa-solid fa-play"></i> Start Custom Test</button>' +
            '<p class="ad-fineprint">Custom tests use NEET marking (+4 / −1), are scored server-side, ' +
            'and answers lock once shaded on the OMR sheet.</p>' +
            '</div></div>';
    }

    function adRenderPyqLanding() {
        var container = document.getElementById('pyq-content');
        if (!container) return;
        var switcher = (typeof hubSwitcherHtml === 'function') ? hubSwitcherHtml('pyq') : '';
        var data = hubState.pyqPapers || { by_year: {}, total_papers: 0 };
        var mode = hubState.pyqMode || 'custom';

        var body;
        if (mode === 'papers') {
            var attemptMap = hubState.attemptMap.pyq || {};
            var years = Object.keys(data.by_year || {}).sort(function (a, b) { return Number(b) - Number(a); });
            var grid = years.length ? years.map(function (yr) {
                var cards = (data.by_year[yr] || []).map(function (p) { return adPaperCard(p, 'pyq', attemptMap); }).join('');
                return '<div class="ad-year-block"><div class="ad-seclabel"><span>NEET ' + esc(yr) + '</span><span class="ln"></span></div>' +
                    '<div class="ad-papers-grid">' + cards + '</div></div>';
            }).join('') : '<div class="empty-state"><i class="fa-solid fa-file-circle-question"></i><h3>No papers yet</h3></div>';
            body = grid;
        } else {
            body = '<div class="ad-builder">' + adBuilderMain() + adBuilderSide() + '</div>';
        }

        container.innerHTML = '<div class="ad-switch-hold">' + switcher + '</div>' +
            '<div class="ad-page">' +
            '<div class="ad-hero">' +
            '<div>' +
            '<div class="ad-hero-kicker">PYQ Vault · Question bank</div>' +
            '<h1>Build your own drill.</h1>' +
            '<p>Pick a class, subject and chapters — get a custom NEET-marked test built from every past question. ' +
            'Or browse and attempt any full paper.</p>' +
            '<div class="ad-hero-actions">' +
            '<button class="ad-hero-btn" onclick="navigate(\'pyq-history\')"><i class="fa-solid fa-clock-rotate-left"></i> My custom attempts</button>' +
            '</div></div>' +
            '<div class="ad-hero-stats">' +
            '<div><b>' + (data.total_papers || 0) + '</b><span>Papers</span></div>' +
            '<div><b>Custom</b><span>Builder</span></div>' +
            '<div><b>+4 / −1</b><span>Marking</span></div>' +
            '</div></div>' +
            '<div class="ad-vault-tabs">' +
            '<button class="' + (mode === 'custom' ? 'active' : '') + '" onclick="__adSetVaultMode(\'custom\')">Custom builder</button>' +
            '<button class="' + (mode === 'papers' ? 'active' : '') + '" onclick="__adSetVaultMode(\'papers\')">Browse full papers</button>' +
            '</div>' +
            '<div id="pyq-landing-body">' + body + '</div>' +
            '</div>';

        if (typeof updateFilterPreviewUI === 'function') updateFilterPreviewUI();
    }

    function adLoadPyqLanding() {
        var container = document.getElementById('pyq-content');
        if (!container) return;
        var switcher = (typeof hubSwitcherHtml === 'function') ? hubSwitcherHtml('pyq') : '';
        container.innerHTML = '<div class="ad-switch-hold">' + switcher + '</div>' +
            '<div class="ad-page"><div class="loading-spinner"><div class="spinner"></div> Loading vault...</div></div>';
        Promise.resolve()
            .then(function () {
                if (hubState.pyqPapers) return;
                return apiCall('/api/pyq/papers').then(function (r) { hubState.pyqPapers = r; });
            })
            .then(function () {
                adRenderPyqLanding();
                // ensureChapterTree(), on completion, repaints #pyq-landing-body
                // with the MOBILE customBuilderHtml() (it targets that id
                // directly). So we wait for it and then repaint the DESKTOP
                // builder over the top — now with the chapter tree populated.
                if (typeof ensureChapterTree === 'function') {
                    Promise.resolve(ensureChapterTree()).then(function () {
                        if (hubState.pyqMode !== 'papers') adRenderPyqLanding();
                        if (typeof runPyqFilterPreview === 'function') runPyqFilterPreview(true);
                    });
                }
                if (typeof runPyqFilterPreview === 'function') runPyqFilterPreview(true);
            })
            .catch(function (e) {
                container.innerHTML = '<div class="ad-switch-hold">' + switcher + '</div>' +
                    '<div class="ad-page"><div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i>' +
                    '<h3>Could not load PYQ Vault</h3><p style="margin-top:8px;color:var(--s500);">' + esc(e.message) + '</p>' +
                    '<button class="btn btn-outline" style="margin-top:16px;min-height:44px;" onclick="hubState.pyqPapers=null;loadPyqLanding()">' +
                    '<i class="fa-solid fa-rotate-right"></i> Retry</button></div></div>';
            });
    }

    // Vault sub-mode toggle (desktop only). Kept on window so inline
    // onclick can reach it; removed again on deactivate.
    function adSetVaultMode(m) {
        hubState.pyqMode = m;
        adRenderPyqLanding();
        if (m === 'custom' && typeof runPyqFilterPreview === 'function') runPyqFilterPreview(true);
        if (m === 'papers' && typeof ensureAttemptMap === 'function') {
            ensureAttemptMap('pyq').then(function () { adRenderPyqLanding(); });
        }
    }

    // ════════════════════════════════════════════════════════════
    // C · AIR RANKINGS
    // ════════════════════════════════════════════════════════════
    function adAirChart(attempts) {
        var vals = attempts.map(function (a) { return Number(a.total_marks) || 0; });
        var n = vals.length;
        var maxM = Number(attempts[0] && attempts[0].max_marks) || Math.max.apply(null, vals.concat([1]));
        var max = Math.max.apply(null, [maxM].concat(vals).concat([1]));
        var W = 340, H = 150, L = 34, R = 12, T = 14, B = 118;
        var step = n > 1 ? (W - L - R) / (n - 1) : 0;
        var yOf = function (v) { return B - ((v) / (max || 1)) * (B - T); };
        var pts = vals.map(function (v, i) { return (L + i * step).toFixed(1) + ',' + yOf(v).toFixed(1); });
        var dots = vals.map(function (v, i) {
            return '<circle cx="' + (L + i * step).toFixed(1) + '" cy="' + yOf(v).toFixed(1) + '" r="3.4" fill="#5d92cf"/>';
        }).join('');
        var xl = [0, n - 1].filter(function (v, i, a) { return a.indexOf(v) === i; }).map(function (i) {
            return '<text x="' + (L + i * step).toFixed(1) + '" y="' + (H - 4) + '" class="ad-air-ax" text-anchor="middle">#' + (i + 1) + '</text>';
        }).join('');
        return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet" class="ad-air-chart">' +
            '<defs><linearGradient id="adairlg" x1="0" y1="0" x2="100%" y2="0">' +
            '<stop offset="0%" stop-color="#2f6cb3"/><stop offset="100%" stop-color="#8fd8e6"/></linearGradient></defs>' +
            '<text x="' + (L - 4) + '" y="' + (yOf(max) + 3).toFixed(1) + '" class="ad-air-ax" text-anchor="end">' + max + '</text>' +
            '<text x="' + (L - 4) + '" y="' + (yOf(0) + 3).toFixed(1) + '" class="ad-air-ax" text-anchor="end">0</text>' +
            '<line x1="' + L + '" y1="' + B + '" x2="' + (W - R) + '" y2="' + B + '" stroke="var(--s200)"/>' +
            '<path d="M ' + pts.join(' L ') + '" fill="none" stroke="url(#adairlg)" stroke-width="2.4" stroke-linejoin="round"/>' +
            dots + xl + '</svg>';
    }

    function adAirDetail(attempts) {
        if (!attempts.length) {
            return '<p style="font-size:.82rem;color:var(--s500);line-height:1.6;">No full-paper attempts yet — take a NEET Arena paper to start tracking your rank.</p>';
        }
        var chart = attempts.length >= 2
            ? '<div class="ad-chartcard"><h4>Score progression · ' + attempts.length + ' papers</h4>' + adAirChart(attempts) + '</div>'
            : '';
        var list = attempts.slice().reverse().map(function (a, ri) {
            var idx = attempts.length - ri;
            var air = (a.air_prediction && a.air_prediction.air_mid)
                ? '~' + Number(a.air_prediction.air_mid).toLocaleString('en-IN') : '—';
            var sid = String(a.session_id).replace(/'/g, "\\'");
            return '<button class="ad-att" onclick="viewPastSession(\'arena\',\'' + sid + '\')">' +
                '<span class="ad-att-n">#' + idx + '</span>' +
                '<span class="ad-att-main"><b>' + esc(a.label || ('NEET ' + (a.year || '') + ' ' + (a.paper_code || ''))) + '</b>' +
                '<span>' + (typeof fmtHistoryDate === 'function' ? fmtHistoryDate(a.completed_at) : '') + ' · ' + a.accuracy + '% acc · AIR ' + air + '</span></span>' +
                '<span class="ad-att-score">' + a.total_marks + '<i>/' + a.max_marks + '</i></span>' +
                '<i class="fa-solid fa-chevron-right" style="color:var(--s300);"></i></button>';
        }).join('');
        return chart + '<div class="ad-att-list">' + list + '</div>';
    }

    function adLoadAirRankings() {
        var container = document.getElementById('air-content');
        if (!container) return;
        var switcher = (typeof hubSwitcherHtml === 'function') ? hubSwitcherHtml('air') : '';
        container.innerHTML = '<div class="ad-switch-hold">' + switcher + '</div>' +
            '<div class="ad-page"><div class="loading-spinner"><div class="spinner"></div> Loading rankings...</div></div>';

        Promise.all([
            apiCall('/api/arena/overall-leaderboard'),
            apiCall('/api/arena/history').catch(function () { return { history: [] }; })
        ]).then(function (res) {
            var data = res[0], histData = res[1];
            var entries = data.entries || [];
            var me = data.my_entry;
            var myAttempts = (histData.history || [])
                .filter(function (h) { return h.test_type !== 'custom'; })
                .sort(function (a, b) { return new Date(a.completed_at || 0) - new Date(b.completed_at || 0); });
            var topMarks = entries.length ? Math.max.apply(null, entries.map(function (e) { return Number(e.best_marks) || 0; })) : 0;
            var topAir = entries.map(function (e) { return Number(e.best_air) || 0; }).filter(Boolean).sort(function (a, b) { return a - b; })[0] || 0;

            var rows = entries.map(function (e) {
                var rankCls = e.rank === 1 ? 'gold' : e.rank === 2 ? 'silver' : e.rank === 3 ? 'bronze' : '';
                return '<div class="ad-lb-row ' + (e.is_me ? 'me' : '') + '">' +
                    '<div class="ad-lb-rank ' + rankCls + '">' + e.rank + '</div>' +
                    '<div class="ad-lb-name"><h4>' + esc(e.user_name || 'Student') +
                    (e.is_me ? ' <span class="ad-you-tag">You</span>' : '') + '</h4>' +
                    '<p>' + (e.papers_attempted || 0) + ' papers · ' + (e.total_attempts || 0) + ' attempts</p></div>' +
                    '<div class="ad-lb-cell">' + (e.avg_accuracy || 0) + '%</div>' +
                    '<div class="ad-lb-cell">' + (e.best_air ? '~' + Number(e.best_air).toLocaleString('en-IN') : '—') + '</div>' +
                    '<div class="ad-lb-cell marks"><b>' + e.best_marks + '</b></div>' +
                    '</div>';
            }).join('');

            var lbTable = entries.length ?
                '<div class="ad-lb"><div class="ad-lb-head">' +
                '<span>Rank</span><span>Student</span><span class="r">Avg acc</span><span class="r">Best AIR</span><span class="r">Best marks</span>' +
                '</div>' + rows + '</div>' :
                '<div class="cs2-empty"><i class="fa-solid fa-ranking-star"></i>No rankings yet — they appear after Arena full-paper attempts.</div>';

            var myCard = me ?
                '<div class="ad-mycard"><div class="kicker">Your standing</div>' +
                '<div class="ad-mystats">' +
                '<div><b>#' + me.rank + '</b><span>Rank</span></div>' +
                '<div><b>' + me.best_marks + '</b><span>Best marks</span></div>' +
                '<div><b>' + (me.best_air ? '~' + Number(me.best_air).toLocaleString('en-IN') : '—') + '</b><span>Best AIR</span></div>' +
                '<div><b>' + (me.avg_accuracy || 0) + '%</b><span>Avg acc</span></div>' +
                '</div><p>' + (me.papers_attempted || 0) + ' papers · ' + (me.total_attempts || 0) + ' total attempts</p></div>' :
                '<div class="ad-mycard"><div class="kicker">Your standing</div>' +
                '<p style="font-size:.82rem;color:#94a3b8;line-height:1.6;">You\'re not ranked yet — complete a NEET Arena full paper to enter the AIR rankings.</p>' +
                '<button class="ad-hero-btn" style="margin-top:14px;" onclick="navigate(\'arena\')"><i class="fa-solid fa-bolt"></i> Go to Arena</button></div>';

            var detail = '<div class="ad-chartcard"><h4>Your progression &amp; attempts</h4>' + adAirDetail(myAttempts) + '</div>';

            container.innerHTML = '<div class="ad-switch-hold">' + switcher + '</div>' +
                '<div class="ad-page">' +
                '<div class="ad-hero">' +
                '<div>' +
                '<div class="ad-hero-kicker">AIR Rankings · All-India (NAADI)</div>' +
                '<h1>Overall Arena standings.</h1>' +
                '<p>Ranked by best NEET Arena full-paper score across all students.</p></div>' +
                '<div class="ad-hero-stats">' +
                '<div><b>' + (data.total_participants || 0) + '</b><span>Ranked</span></div>' +
                '<div><b>' + (topMarks || '—') + '</b><span>Top score</span></div>' +
                '<div><b>' + (topAir ? '~' + Number(topAir).toLocaleString('en-IN') : '—') + '</b><span>Best AIR</span></div>' +
                '</div></div>' +
                '<div class="ad-air-body">' +
                '<div><div class="ad-seclabel"><span>Top students</span><span class="ln"></span></div>' + lbTable + '</div>' +
                '<div class="ad-air-side">' + myCard + (me ? detail : '') + '</div>' +
                '</div></div>';
        }).catch(function (e) {
            container.innerHTML = '<div class="ad-switch-hold">' + switcher + '</div>' +
                '<div class="ad-page"><div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i>' +
                '<h3>Could not load rankings</h3><p style="margin-top:8px;color:var(--s500);">' + esc(e.message) + '</p>' +
                '<button class="btn btn-outline" style="margin-top:16px;min-height:44px;" onclick="loadAirRankings()">' +
                '<i class="fa-solid fa-rotate-right"></i> Retry</button></div></div>';
        });
    }

    // ════════════════════════════════════════════════════════════
    // D · PER-PAPER LEADERBOARD
    // ════════════════════════════════════════════════════════════
    function adLbRow(e, mode) {
        var rankCls = e.rank === 1 ? 'gold' : e.rank === 2 ? 'silver' : e.rank === 3 ? 'bronze' : '';
        var marks = mode === 'arena' ? e.best_marks : e.total_marks;
        var sub = mode === 'arena'
            ? 'Best · ' + (e.attempts || 1) + ' attempt' + ((e.attempts || 1) !== 1 ? 's' : '')
            : (e.correct + '✓ ' + e.wrong + '✗ · ' + (typeof fmtLbTime === 'function' ? fmtLbTime(e.time_taken_seconds) : ''));
        var airCell = e.air_prediction ? ('~' + Number(e.air_prediction).toLocaleString('en-IN')) : '—';
        return '<div class="ad-lb-row ' + (e.is_me ? 'me' : '') + '">' +
            '<div class="ad-lb-rank ' + rankCls + '">' + e.rank + '</div>' +
            '<div class="ad-lb-name"><h4>' + esc(e.user_name || 'Student') +
            (e.is_me ? ' <span class="ad-you-tag">You</span>' : '') + '</h4><p>' + esc(sub) + '</p></div>' +
            '<div class="ad-lb-cell">' + (e.accuracy != null ? e.accuracy + '%' : '—') + '</div>' +
            '<div class="ad-lb-cell">' + airCell + '</div>' +
            '<div class="ad-lb-cell marks"><b>' + marks + '</b></div>' +
            '</div>';
    }

    function adLoadPaperLeaderboard(mode, year, paperCode) {
        var container = document.getElementById(mode + '-leaderboard-content');
        if (!container) return;
        container.innerHTML = '<div class="ad-res"><div class="loading-spinner"><div class="spinner"></div> Loading leaderboard...</div></div>';
        apiCall(mode === 'arena' ? '/api/arena/leaderboard/' + year + '/' + paperCode
            : '/api/pyq/leaderboard/' + year + '/' + paperCode)
            .then(function (data) {
                var entries = data.entries || [];
                var meInSlice = entries.some(function (e) { return e.is_me; });
                var myPinned = (!meInSlice && data.my_entry)
                    ? '<div class="ad-seclabel"><span>Your position</span><span class="ln"></span></div>' +
                    '<div class="ad-lb">' + adLbRow(data.my_entry, mode) + '</div>'
                    : '';
                var rows = entries.length
                    ? '<div class="ad-lb"><div class="ad-lb-head"><span>Rank</span><span>Student</span>' +
                    '<span class="r">Accuracy</span><span class="r">AIR</span><span class="r">Marks</span></div>' +
                    entries.map(function (e) { return adLbRow(e, mode); }).join('') + '</div>'
                    : '<div class="empty-state"><i class="fa-solid fa-trophy"></i><h3>No entries yet</h3>' +
                    '<p style="margin-top:8px;color:var(--s500);">Be the first to attempt this paper.</p></div>';
                container.innerHTML = '<div class="ad-res">' +
                    '<button class="ad-res-back" onclick="navigate(\'' + mode + '\')"><i class="fa-solid fa-arrow-left"></i> Back</button>' +
                    '<div class="ad-hero"><div>' +
                    '<div class="ad-hero-kicker">' + (mode === 'arena' ? 'NEET Arena · Best-of-attempts' : 'PYQ Vault') + ' leaderboard</div>' +
                    '<h1>NEET ' + esc(String(data.year != null ? data.year : year)) + ' · Paper ' + esc(String(data.paper_code != null ? data.paper_code : paperCode)) + '</h1>' +
                    '<p>' + (data.total_participants || 0) + ' participant' + ((data.total_participants || 0) !== 1 ? 's' : '') +
                    (mode === 'arena' ? ' · ranked by best attempt' : '') + '</p></div></div>' +
                    myPinned +
                    '<div class="ad-seclabel"><span>Rankings</span><span class="ln"></span></div>' + rows +
                    '</div>';
            })
            .catch(function (e) {
                container.innerHTML = '<div class="ad-res"><button class="ad-res-back" onclick="navigate(\'' + mode + '\')">' +
                    '<i class="fa-solid fa-arrow-left"></i> Back</button>' +
                    '<div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i><h3>Could not load leaderboard</h3>' +
                    '<p style="margin-top:8px;color:var(--s500);">' + esc(e.message) + '</p></div></div>';
            });
    }

    // ════════════════════════════════════════════════════════════
    // E · HISTORY / MY ATTEMPTS
    // ════════════════════════════════════════════════════════════
    function adLoadPracticeHistory(mode) {
        var container = document.getElementById(mode + '-history-content');
        if (!container) return;
        container.innerHTML = '<div class="ad-res"><div class="loading-spinner"><div class="spinner"></div> Loading attempts...</div></div>';
        apiCall(mode === 'arena' ? '/api/arena/history' : '/api/pyq/history')
            .then(function (data) {
                var history = (data.history || []).filter(function (h) {
                    return mode === 'arena' ? h.test_type !== 'custom' : h.test_type === 'custom';
                });
                var groupKey = function (h) {
                    return (h.year && h.paper_code) ? ('p|' + h.year + '|' + h.paper_code) : ('l|' + (h.label || h.session_id));
                };
                var gmap = new Map();
                history.forEach(function (h) {
                    var k = groupKey(h);
                    if (!gmap.has(k)) gmap.set(k, []);
                    gmap.get(k).push(h);
                });
                var groups = Array.from(gmap.values()).map(function (atts) {
                    atts.sort(function (a, b) {
                        return (Number(b.total_marks) || 0) - (Number(a.total_marks) || 0)
                            || (new Date(b.completed_at || 0) - new Date(a.completed_at || 0));
                    });
                    return atts;
                });
                groups.sort(function (ga, gb) {
                    return Math.max.apply(null, gb.map(function (a) { return +new Date(a.completed_at || 0); }))
                        - Math.max.apply(null, ga.map(function (a) { return +new Date(a.completed_at || 0); }));
                });

                var ringIds = [];
                var histRow = function (h, badge, extraCls) {
                    var air = (h.air_prediction && h.air_prediction.air_mid)
                        ? '<span class="ad-chip">AIR ~' + Number(h.air_prediction.air_mid).toLocaleString('en-IN') + '</span>' : '';
                    var type = h.test_type === 'custom'
                        ? '<span class="ad-chip">Custom</span>' : '<span class="ad-chip grad">Full paper</span>';
                    var sid = String(h.session_id).replace(/'/g, "\\'");
                    var scorePct = h.max_marks ? Math.max(0, Math.round((h.total_marks / h.max_marks) * 100)) : 0;
                    var rid = 'ad-hring-' + mode + '-' + ringIds.length;
                    ringIds.push(rid);
                    var chips = (badge || '') + (mode === 'pyq' ? type : '') + air;
                    return '<div class="ad-hist ' + (extraCls || '') + '" onclick="viewPastSession(\'' + mode + '\', \'' + sid + '\')">' +
                        '<div class="ad-ringcell">' + ring(rid, scorePct, 46, 4.5) + '</div>' +
                        '<div style="min-width:0;"><h4>' + esc(h.label || ('NEET ' + (h.year || '') + ' ' + (h.paper_code || ''))) + '</h4>' +
                        '<p>' + (typeof fmtHistoryDate === 'function' ? fmtHistoryDate(h.completed_at) : '') + ' · ' + h.accuracy + '% accuracy</p>' +
                        (chips.trim() ? '<div class="ad-hist-chips" style="margin-top:7px;">' + chips + '</div>' : '') + '</div>' +
                        '<div></div>' +
                        '<div class="ad-hist-score"><b>' + h.total_marks + '</b><span> / ' + h.max_marks + '</span></div>' +
                        '</div>';
                };
                var groupHtml = function (atts, gi) {
                    if (atts.length === 1) return '<div class="ad-hist-group">' + histRow(atts[0]) + '</div>';
                    var best = atts[0], others = atts.slice(1);
                    var gid = 'ad-histg-' + mode + '-' + gi;
                    var badge = '<span class="ad-chip grad"><i class="fa-solid fa-crown"></i> Best of ' + atts.length + '</span>';
                    return '<div class="ad-hist-group">' + histRow(best, badge) +
                        '<button class="ad-hist-toggle" onclick="pv2ToggleHistGroup(\'' + gid + '\', this)">' +
                        '<span class="show">Show ' + others.length + ' earlier attempt' + (others.length !== 1 ? 's' : '') + '</span>' +
                        '<span class="hide">Hide earlier attempts</span><i class="fa-solid fa-chevron-down"></i></button>' +
                        '<div class="ad-hist-more" id="' + gid + '">' + others.map(function (o) { return histRow(o, '', 'sub'); }).join('') + '</div>' +
                        '</div>';
                };
                var rows = groups.map(function (atts, gi) { return groupHtml(atts, gi); }).join('');

                container.innerHTML = '<div class="ad-res">' +
                    '<button class="ad-res-back" onclick="navigate(\'' + mode + '\')"><i class="fa-solid fa-arrow-left"></i> Back</button>' +
                    '<div class="ad-hero"><div>' +
                    '<div class="ad-hero-kicker">' + (mode === 'arena' ? 'NEET Arena' : 'PYQ Vault') + '</div>' +
                    '<h1>My attempts</h1>' +
                    '<p>' + groups.length + ' ' + (mode === 'arena' ? 'paper' : 'test') + (groups.length !== 1 ? 's' : '') +
                    ' · ' + history.length + ' attempt' + (history.length !== 1 ? 's' : '') + '</p></div></div>' +
                    (history.length === 0
                        ? '<div class="cs2-empty"><i class="fa-solid fa-clock-rotate-left"></i>No attempts yet — your completed tests will appear here.</div>'
                        : '<div class="ad-hist-list">' + rows + '</div>') +
                    '</div>';
                ringIds.forEach(function (rid) { animRing(rid); });
            })
            .catch(function (e) {
                container.innerHTML = '<div class="ad-res"><button class="ad-res-back" onclick="navigate(\'' + mode + '\')">' +
                    '<i class="fa-solid fa-arrow-left"></i> Back</button>' +
                    '<div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i><h3>Could not load history</h3>' +
                    '<p style="margin-top:8px;color:var(--s500);">' + esc(e.message) + '</p></div></div>';
            });
    }

    // ════════════════════════════════════════════════════════════
    // F · TEST WORKSPACE — shell / question / OMR / palette
    // Overrides the shared render functions. All state + behaviour
    // globals are reused unchanged.
    // ════════════════════════════════════════════════════════════
    var HAS_PALETTE_MIN = 1201; // palette rail persists at >=1201px

    function adOpdChips() {
        var o = testState.opd || {};
        var chips = [];
        if (o.phase) chips.push('<span class="ph-chip blue">' + esc(o.phase) + '</span>');
        if (o.isMock) chips.push('<span class="ph-chip amber"><i class="fa-solid fa-trophy"></i> Grand Mock</span>');
        if (o.isBonus) chips.push('<span class="ph-chip green"><i class="fa-solid fa-gift"></i> Bonus</span>');
        if (o.isFlex) chips.push('<span class="ph-chip amber">FLEX · remediation</span>');
        if (o.isRetake) chips.push('<span class="ph-chip review">🔁 Retake</span>');
        return chips.join('');
    }

    function adRenderTestShell(container) {
        if (!container) return;
        var subjects = (typeof testSubjects === 'function') ? testSubjects() : [];
        var isOpd = testState.mode === 'opd';
        var showPalette = window.innerWidth >= HAS_PALETTE_MIN;

        var tabs = ['All'].concat(subjects).map(function (s) {
            return '<button class="ad-tw-tab ' + (testState.subjectFilter === s ? 'active' : '') + '" ' +
                'data-subject="' + esc(s) + '" onclick="setTestSubject(\'' + s.replace(/'/g, "\\'") + '\')">' + esc(s) + '</button>';
        }).join('');

        container.innerHTML =
            '<div class="ad-tw ' + (showPalette ? 'has-palette' : 'no-palette') + '" id="ad-tw">' +
            '<div class="ad-tw-head">' +
            '<button class="ad-tw-exit" onclick="confirmExitTest()" aria-label="Exit test"><i class="fa-solid fa-xmark"></i></button>' +
            '<div class="ad-tw-title"><b>' + esc(testState.label) + '</b><span id="te-progress-label"></span></div>' +
            (isOpd ? '<div class="ad-tw-opdchips">' + adOpdChips() + '</div>' : '<div class="ad-tw-tabs">' + tabs + '</div>') +
            '<div class="ad-tw-timer" id="te-timer"><i class="fa-solid fa-stopwatch"></i> --:--</div>' +
            '<button class="ad-tw-palettebtn" onclick="openPaletteDrawer()" aria-label="Question palette"><i class="fa-solid fa-table-cells"></i></button>' +
            '<div class="ad-tw-progtrack"><i id="te-progfill"></i></div>' +
            '</div>' +
            '<div class="ad-tw-body">' +
            '<div class="ad-qcol" id="te-body"></div>' +
            '<div class="ad-omr" id="ad-omr"></div>' +
            (showPalette ? '<div class="ad-palette" id="ad-palette"></div>' : '') +
            '</div></div>';

        if (showPalette) adRenderPalette();
    }

    // Reading-mode question (large) + fills the persistent OMR rail.
    function adRenderTestQuestion() {
        var body = document.getElementById('te-body');
        if (!body) return;
        var q = testState.questions[testState.currentIndex];
        if (!q) return;
        if (typeof teTrackTime === 'function') teTrackTime(q.question_id);
        testState.visited.add(q.question_id);

        var vis = (typeof visibleIndexes === 'function') ? visibleIndexes() : testState.questions.map(function (_, i) { return i; });
        var posInVis = vis.indexOf(testState.currentIndex);
        var progLabel = document.getElementById('te-progress-label');
        if (progLabel) {
            progLabel.textContent = testState.subjectFilter === 'All'
                ? 'Q ' + (testState.currentIndex + 1) + ' of ' + testState.questions.length
                : testState.subjectFilter + ' · ' + (posInVis + 1) + ' of ' + vis.length;
        }

        var answered = testState.answers[q.question_id];
        var isMarked = testState.marked.has(q.question_id);
        var isMatch = !!q.is_match;
        var answeredLabel = answered ? String(answered) : '';

        var qImages = (q.question_image_urls && q.question_image_urls.length
            ? q.question_image_urls
            : (q.question_image_url ? [q.question_image_url] : []))
            .map(function (u) { return '<img src="' + esc(abs(u)) + '" class="te-q-img" alt="Question figure" loading="lazy">'; })
            .join('');

        var optionsHtml = (q.options || []).map(function (opt) {
            return '<div class="te-option ' + (answered && answered === opt.id ? 'committed' : '') + '">' +
                '<div class="te-opt-letter">' + esc(opt.id || '') + '</div>' +
                '<div style="flex:1;min-width:0;">' + (typeof optionBodyHtml === 'function' ? optionBodyHtml(opt) : safe(opt.text || '')) + '</div>' +
                (answered && answered === opt.id ? '<i class="fa-solid fa-lock te-opt-lock"></i>' : '') +
                '</div>';
        }).join('');

        body.innerHTML =
            '<div class="ad-qcard">' +
            '<div class="ad-q-meta">' +
            '<span class="ad-q-num">Q' + (q.question_number != null ? q.question_number : testState.currentIndex + 1) + '</span>' +
            (q.subject ? '<span class="ph-chip blue">' + esc(q.subject) + '</span>' : '') +
            (q.difficulty ? '<span class="ph-chip">' + esc(q.difficulty) + '</span>' : '') +
            (q.is_mta ? '<span class="ph-chip amber">MTA · marks to all</span>' : '') +
            (q.needs_review ? '<span class="ph-chip amber"><i class="fa-solid fa-eye"></i> Needs review</span>' : '') +
            (isMarked ? '<span class="ph-chip review"><i class="fa-solid fa-flag"></i> Review</span>' : '') +
            '</div>' +
            (q.ncert_chapter_name ? '<div class="ad-q-chapter">' + esc(q.ncert_chapter_name) + (q.ncert_class ? ' · Class ' + q.ncert_class : '') + '</div>' : '') +
            '<div class="ad-q-text te-q-text">' + safe(q.question_text || '') + '</div>' +
            qImages +
            (isMatch && typeof buildMatchHtml === 'function' ? buildMatchHtml(q) : '') +
            '<div class="ad-opts te-options">' + optionsHtml + '</div>' +
            (answered
                ? '<div class="ad-q-note locked"><i class="fa-solid fa-lock"></i><span>Answer <b>' + esc(answeredLabel) + '</b> is shaded on your OMR sheet — locked, just like the real exam.</span></div>'
                : '<div class="ad-q-note commit"><i class="fa-solid fa-lightbulb"></i><span>Decide first, then shade the bubble on the OMR panel. Once shaded, it cannot be changed.</span></div>') +
            '</div>';

        // progress fill
        var progFill = document.getElementById('te-progfill');
        if (progFill) {
            var done = Object.keys(testState.answers).length;
            progFill.style.width = ((done / Math.max(1, testState.questions.length)) * 100) + '%';
        }

        adRenderOmrPanel();       // keep the persistent OMR rail in sync
        adSyncPaletteActive();    // highlight current cell in palette rail
        body.scrollTop = 0;
    }

    // The persistent OMR side panel — same bubbles + same shadeOmrBubble
    // handler + same lock semantics as the mobile drawer, just inline.
    function adRenderOmrPanel() {
        var panel = document.getElementById('ad-omr');
        if (!panel) return;
        var q = testState.questions[testState.currentIndex];
        if (!q) { panel.innerHTML = ''; return; }
        var already = testState.answers[q.question_id];
        var isMarked = testState.marked.has(q.question_id);
        var vis = (typeof visibleIndexes === 'function') ? visibleIndexes() : [];
        var posInVis = vis.indexOf(testState.currentIndex);

        // recently answered (reuse the exact mobile .omr-m-* markup)
        var answeredIds = Object.keys(testState.answers);
        var recentRows = answeredIds.slice(-3).map(function (qid) {
            var idx = testState.questions.findIndex(function (x) { return x.question_id === qid; });
            var qq = testState.questions[idx];
            if (!qq) return '';
            var prevAns = testState.answers[qid];
            if (typeof prevAns === 'object') {
                var pairs = Object.keys(prevAns).sort().map(function (k) { return k + '→' + prevAns[k]; }).join(' · ');
                return '<div class="omr-m-row mini"><span class="omr-m-qnum">' + (qq.question_number != null ? qq.question_number : idx + 1) + '</span>' +
                    '<div class="omr-m-bubbles"><span class="omr-m-mapping">' + esc(pairs) + '</span></div>' +
                    '<i class="fa-solid fa-lock omr-m-lockicon"></i></div>';
            }
            var bubbles = (qq.options || []).map(function (o) {
                return '<span class="omr-m-bubble mini ' + (testState.answers[qid] === o.id ? 'filled' : '') + ' locked">' + esc(o.id || '') + '</span>';
            }).join('');
            return '<div class="omr-m-row mini"><span class="omr-m-qnum">' + (qq.question_number != null ? qq.question_number : idx + 1) + '</span>' +
                '<div class="omr-m-bubbles">' + bubbles + '</div><i class="fa-solid fa-lock omr-m-lockicon"></i></div>';
        }).join('');

        var liveBubbles = (q.options || []).map(function (o) {
            return '<button class="omr-m-bubble ' + (already === o.id ? 'filled locked' : (already ? 'locked' : '')) + '" ' +
                'id="omr-bubble-' + esc(o.id || '') + '" ' +
                'onclick="shadeOmrBubble(\'' + String(q.question_id).replace(/'/g, "\\'") + '\', \'' + String(o.id || '').replace(/'/g, "\\'") + '\')">' +
                esc(o.id || '') + '</button>';
        }).join('');

        var answeredCount = Object.keys(testState.answers).length;
        var total = testState.questions.length;

        panel.innerHTML =
            '<div class="ad-omr-inner">' +
            '<div class="ad-omr-title">OMR Answer Sheet</div>' +
            '<div class="ad-omr-instructions">' +
            '<span><i class="fa-solid fa-pen"></i> Darken one bubble completely</span>' +
            '<span><i class="fa-solid fa-ban"></i> No changes once shaded</span></div>' +
            '<div class="ad-omr-livewrap">' +
            '<div class="ad-omr-livenum">Question ' + (q.question_number != null ? q.question_number : testState.currentIndex + 1) + '</div>' +
            '<div class="ad-omr-bubbles omr-m-row live">' + liveBubbles + '</div>' +
            (already
                ? '<p class="ad-omr-note locked"><i class="fa-solid fa-lock"></i> Bubble ' + esc(String(already)) + ' shaded &amp; locked.</p>'
                : '<p class="ad-omr-note">Tap a bubble to shade it. This is permanent — commit like it\'s the real sheet.</p>') +
            '</div>' +
            (recentRows ? '<div class="ad-omr-recent"><div class="ad-omr-recent-label">Recently shaded</div>' + recentRows + '</div>' : '') +
            '</div>' +
            '<div class="ad-omr-actions">' +
            '<button class="ad-actbtn" id="te-prev" onclick="testNav(-1)" ' + (posInVis <= 0 ? 'disabled' : '') + ' aria-label="Previous"><i class="fa-solid fa-chevron-left"></i></button>' +
            '<button class="ad-actbtn ' + (isMarked ? 'marked' : '') + '" id="te-mark" onclick="toggleMarkForReview()" aria-label="Mark for review"><i class="fa-' + (isMarked ? 'solid' : 'regular') + ' fa-flag"></i></button>' +
            '<button class="ad-mark-answer ' + (already ? 'locked' : '') + '" id="te-mark-answer">' +
            (already ? '<i class="fa-solid fa-lock"></i> Locked · ' + esc(String(already)) : '<i class="fa-solid fa-circle-dot"></i> Shade on sheet') + '</button>' +
            '<button class="ad-actbtn" id="te-next" onclick="testNav(1)" ' + (posInVis >= vis.length - 1 ? 'disabled' : '') + ' aria-label="Next"><i class="fa-solid fa-chevron-right"></i></button>' +
            '</div>' +
            '<div style="padding:0 20px 18px;">' +
            '<button class="ad-start-btn ad-omr-submit" style="background:var(--g600);" onclick="confirmSubmitTest()">' +
            '<i class="fa-solid fa-paper-plane"></i> Submit (' + answeredCount + '/' + total + ')</button></div>';

        // The desktop "Shade on sheet" button focuses the first live bubble
        // for keyboard users (mouse users just click the bubble directly).
        var maBtn = document.getElementById('te-mark-answer');
        if (maBtn && !already) {
            maBtn.onclick = function () {
                var first = panel.querySelector('.omr-m-row.live .omr-m-bubble:not(.locked)');
                if (first) first.focus();
                panel.querySelector('.ad-omr-livewrap').scrollIntoView({ block: 'nearest' });
            };
        }
    }

    // ── Palette rail ──
    function adRenderPalette() {
        var panel = document.getElementById('ad-palette');
        if (!panel) return;
        var subjects = (typeof testSubjects === 'function') ? testSubjects() : [];
        var groups = subjects.length ? subjects : ['All'];
        var sections = groups.map(function (sub) {
            var cells = testState.questions.map(function (q, i) {
                if (subjects.length && q.subject !== sub) return '';
                var st = (typeof paletteStateOf === 'function') ? paletteStateOf(q) : '';
                var cur = i === testState.currentIndex ? ' current' : '';
                return '<button class="ad-pcell ' + st + cur + '" data-qi="' + i + '" onclick="jumpToQuestion(' + i + ')">' +
                    (q.question_number != null ? q.question_number : i + 1) + '</button>';
            }).join('');
            return '<div class="ad-palette-sub">' + esc(sub) + '</div><div class="ad-palette-grid">' + cells + '</div>';
        }).join('');

        panel.innerHTML =
            '<div class="ad-palette-title"><i class="fa-solid fa-table-cells"></i> Question palette</div>' +
            '<div class="ad-palette-legend">' +
            '<span><i class="ad-pdot answered"></i> Answered</span>' +
            '<span><i class="ad-pdot unanswered"></i> Not answered</span>' +
            '<span><i class="ad-pdot marked"></i> Marked</span>' +
            '<span><i class="ad-pdot notvisited"></i> Not visited</span></div>' +
            sections;
    }

    // Re-highlight state + current cell without a full palette rebuild
    // (state classes can change as answers get locked).
    function adSyncPaletteActive() {
        var panel = document.getElementById('ad-palette');
        if (!panel) return;
        // Full re-render is cheapest + keeps 4-state colours correct.
        adRenderPalette();
    }

    // openPaletteDrawer override: at >=1201 the rail is always present,
    // so a tap just ensures it's rendered; below that, fall back to the
    // ORIGINAL mobile drawer (captured in originals) so nothing is lost.
    function adOpenPaletteDrawer() {
        if (window.innerWidth >= HAS_PALETTE_MIN) {
            adRenderPalette();
            return;
        }
        if (typeof originals.openPaletteDrawer === 'function') originals.openPaletteDrawer();
    }

    // openOmrDrawer override: the OMR is already a persistent panel, so
    // "Mark Answer" just scrolls/pulses the live row into view. Below
    // 1201 we still have the rail (grid keeps the OMR column), so this
    // is always valid on desktop.
    function adOpenOmrDrawer() {
        var panel = document.getElementById('ad-omr');
        if (!panel) {
            if (typeof originals.openOmrDrawer === 'function') originals.openOmrDrawer();
            return;
        }
        var live = panel.querySelector('.ad-omr-livewrap');
        if (live) {
            live.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            live.animate
                ? live.animate([{ boxShadow: '0 0 0 0 rgba(176,81,122,.5)' }, { boxShadow: '0 0 0 8px rgba(176,81,122,0)' }], { duration: 600 })
                : null;
        }
        var first = panel.querySelector('.ad-omr-livewrap .omr-m-bubble:not(.locked)');
        if (first) first.focus();
    }

    // ════════════════════════════════════════════════════════════
    // G · RESULTS DASHBOARD
    // The mobile renderTestResults builds a tall single column via a set
    // of pure helper builders (pv2InsightsHtml, airCardHtml, …). We reuse
    // EVERY one of those helpers verbatim and just re-flow them into a
    // multi-column dashboard. Category recompute + flashcard modal work
    // unchanged because recomputeAir re-invokes renderTestResults (this
    // override) and openFlashcard is global.
    // ════════════════════════════════════════════════════════════
    function callHelper(name, mode, result) {
        var fn = window[name];
        if (typeof fn !== 'function') return '';
        try { return (name === 'airCardHtml' || name === 'collegeSectionHtml') ? fn(result, mode) : fn(result); }
        catch (e) { return ''; }
    }

    function adRenderTestResults(mode, result, opts) {
        opts = opts || {};
        testState.lastResult = result;
        testState.lastResultMode = mode;
        testState._resultsBackTo = opts.backTo || mode;
        var container = document.getElementById(mode + '-results-content');
        if (!container) return;
        var prevScroll = opts.keepScroll ? window.scrollY : 0;

        var pct = result.max_marks ? Math.round((result.total_marks / result.max_marks) * 100) : 0;
        var ringPct = Math.max(0, Math.min(100, pct));
        var canLeaderboard = result.test_type === 'full_paper' && result.year && result.paper_code;

        var weakHtml = (result.weak_chapters || []).map(function (w) {
            return '<div class="pv2-weak"><i class="fa-solid fa-triangle-exclamation"></i>' +
                '<div style="flex:1;min-width:0;"><h4>' + esc(w.chapter || '') + '</h4>' +
                '<p>' + w.wrong + '✗ vs ' + w.correct + '✓ — revise this in Concept Studio</p></div></div>';
        }).join('');

        // Reuse mobile pure builders for every analytical block.
        var insights = callHelper('pv2InsightsHtml', mode, result);
        var airCard = callHelper('airCardHtml', mode, result);
        var colleges = callHelper('collegeSectionHtml', mode, result);
        var marksBreak = callHelper('pv2MarksBreakdownHtml', mode, result);
        var timeFocus = callHelper('pv2TimeFocusHtml', mode, result);
        var subjectRows = callHelper('pv2SubjectRowsHtml', mode, result);
        var classDiff = callHelper('pv2ClassDiffHtml', mode, result);
        var reviewList = (typeof reviewListHtml === 'function') ? reviewListHtml(result) : '';

        var summaryCol =
            '<div class="ad-scorecard">' +
            '<div class="ad-kicker">' + (mode === 'arena' ? 'NEET Arena' : 'PYQ Vault') + ' · ' +
            (result.test_type === 'full_paper' ? 'Full paper' : 'Custom test') + ' · ' + esc(result.label || 'Results') + '</div>' +
            '<div class="ad-score-top">' + ring('pv2-score-ring', ringPct, 96, 9) +
            '<div class="ad-score-marks"><div class="label">Score</div>' +
            '<div class="big"><span id="pv2-marks-num">' + (opts.keepScroll ? result.total_marks : 0) + '</span><span> / ' + result.max_marks + '</span></div>' +
            '<div class="sub">' + result.accuracy + '% accuracy · ' + (typeof fmtTimer === 'function' ? fmtTimer(result.time_taken_seconds || 0) : '') + ' taken</div></div></div>' +
            '<div class="ad-score-counts">' +
            '<div class="c"><b>' + result.correct_count + '</b><span>Correct</span></div>' +
            '<div class="w"><b>' + result.wrong_count + '</b><span>Wrong</span></div>' +
            '<div class="u"><b>' + result.unattempted_count + '</b><span>Skipped</span></div>' +
            '</div></div>' +
            (airCard || '') +
            (colleges || '');

        var mainCol =
            (insights ? '<div class="ad-card-block">' + insights + '</div>' : '') +
            (marksBreak || '') +
            (timeFocus || '') +
            (subjectRows || classDiff
                ? '<div class="ad-two">' +
                (subjectRows ? '<div>' + subjectRows + '</div>' : '') +
                (classDiff ? '<div>' + classDiff + '</div>' : '') + '</div>'
                : '') +
            (weakHtml
                ? '<div class="ad-seclabel"><span>Weak chapters</span><span class="ln"></span></div>' +
                '<div style="display:flex;flex-direction:column;gap:9px;">' + weakHtml + '</div>'
                : '') +
            '<div class="ad-seclabel"><span>Question review</span><span class="ln"></span></div>' +
            '<div class="ad-rev-filters" id="res-review-filters">' +
            ['all', 'wrong', 'unattempted', 'correct'].map(function (fl) {
                return '<button class="ad-fchip sm ' + (testState._reviewFilter === fl ? 'active' : '') + '" ' +
                    'onclick="setReviewFilter(\'' + mode + '\',\'' + fl + '\')">' + fl.charAt(0).toUpperCase() + fl.slice(1) + '</button>';
            }).join('') + '</div>' +
            '<div class="ad-rev-list" id="res-review-list">' + reviewList + '</div>' +
            '<div style="display:flex;gap:10px;margin-top:22px;">' +
            (canLeaderboard ? '<button class="ad-hero-btn" style="background:var(--g600);border-color:var(--g600);color:#fff;" ' +
                'onclick="navigate(\'' + mode + '-leaderboard\', {year:' + Number(result.year) + ', paper_code:\'' + String(result.paper_code).replace(/'/g, "\\'") + '\'})">' +
                '<i class="fa-solid fa-trophy"></i> Leaderboard</button>' : '') +
            '<button class="ad-start-btn" style="flex:1;" onclick="navigate(\'' + testState._resultsBackTo + '\')">' +
            '<i class="fa-solid fa-arrow-left"></i> Back to ' + (mode === 'arena' ? 'Arena' : 'Vault') + '</button></div>';

        container.innerHTML =
            '<div class="ad-res">' +
            '<button class="ad-res-back" onclick="navigate(\'' + testState._resultsBackTo + '\')"><i class="fa-solid fa-arrow-left"></i> Back</button>' +
            '<div class="ad-res-grid">' +
            '<div class="ad-res-summary">' + summaryCol + '</div>' +
            '<div class="ad-res-main">' + mainCol + '</div>' +
            '</div></div>';

        // animations, exactly like the mobile renderer
        animRing('pv2-score-ring');
        Object.keys(result.subject_breakdown || {}).forEach(function (_, si) { animRing('pv2-subring-' + si); });
        var marksNum = document.getElementById('pv2-marks-num');
        if (marksNum && !opts.keepScroll && typeof csCountUp === 'function') {
            csCountUp(marksNum, Number(result.total_marks) || 0, 900);
        }
        window.scrollTo({ top: prevScroll });
    }

    // ════════════════════════════════════════════════════════════
    // ACTIVATION / DEACTIVATION
    // ════════════════════════════════════════════════════════════
    var overrideMap = {
        loadArenaLanding: adLoadArenaLanding,
        loadPyqLanding: adLoadPyqLanding,
        renderPyqLanding: adRenderPyqLanding,
        refreshChapterPicker: adRefreshChapterPicker,
        setChapterSearch: adSetChapterSearch,
        toggleChapGroup: adToggleChapGroup,
        clearChapters: adClearChapters,
        loadAirRankings: adLoadAirRankings,
        loadPaperLeaderboard: adLoadPaperLeaderboard,
        loadPracticeHistory: adLoadPracticeHistory,
        renderTestResults: adRenderTestResults,
        renderTestShell: adRenderTestShell,
        renderTestQuestion: adRenderTestQuestion,
        openOmrDrawer: adOpenOmrDrawer,
        openPaletteDrawer: adOpenPaletteDrawer
    };

    function activate() {
        if (active) return;
        active = true;
        TARGETS.forEach(function (name) {
            if (!(name in originals)) originals[name] = window[name]; // capture once
            if (typeof overrideMap[name] === 'function') window[name] = overrideMap[name];
        });
        // desktop-only helper for the vault sub-mode toggle
        window.__adSetVaultMode = adSetVaultMode;

        // If a landing/results view is already on screen, repaint it with
        // the desktop layout so a resize into desktop is seamless.
        repaintActiveView();
    }

    function deactivate() {
        if (!active) return;
        active = false;
        TARGETS.forEach(function (name) {
            if (name in originals) window[name] = originals[name]; // restore verbatim
        });
        delete window.__adSetVaultMode;
        repaintActiveView();
    }

    // Repaint whichever Arena/test view is currently active, using
    // whatever (original or override) is now installed. Safe no-op if
    // none is active.
    function repaintActiveView() {
        try {
            var v = function (id) { var el = document.getElementById(id); return el && el.classList.contains('active'); };
            if (v('view-arena') && typeof loadArenaLanding === 'function') loadArenaLanding();
            else if (v('view-pyq') && typeof loadPyqLanding === 'function') loadPyqLanding();
            else if (v('view-air') && typeof loadAirRankings === 'function') loadAirRankings();
            else if ((v('view-arena-history') || v('view-pyq-history'))) {
                var hm = v('view-arena-history') ? 'arena' : 'pyq';
                if (typeof loadPracticeHistory === 'function') loadPracticeHistory(hm);
            }
            else if ((v('view-arena-results') || v('view-pyq-results')) && testState && testState.lastResult) {
                var rm = v('view-arena-results') ? 'arena' : 'pyq';
                if (typeof renderTestResults === 'function' && testState.lastResultMode === rm) {
                    renderTestResults(rm, testState.lastResult, { backTo: testState._resultsBackTo || rm });
                }
            }
            // A live test in progress: rebuild the shell + question in the
            // now-active layout (state is preserved on testState).
            else if ((v('view-arena-test') || v('view-pyq-test') || v('view-opd-test')) && testState && testState.questions && testState.questions.length && !testState.finished) {
                var tm = v('view-opd-test') ? 'opd' : (v('view-arena-test') ? 'arena' : 'pyq');
                var cont = document.getElementById(tm + '-test-content');
                if (cont && typeof renderTestShell === 'function' && typeof renderTestQuestion === 'function') {
                    renderTestShell(cont);
                    renderTestQuestion();
                    if (typeof startTestTimer === 'function') startTestTimer();
                    if (typeof setupTestSwipeNav === 'function') setupTestSwipeNav();
                }
            }
        } catch (e) { /* repaint is best-effort; never throw into the app */ }
    }

    // ── The self-gate. On phones: register ONE idle listener, do
    //    nothing else. At >=1024: activate. Toggle on viewport cross. ──
    function onChange() {
        if (mql.matches) activate();
        else deactivate();
    }
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else if (mql.addListener) mql.addListener(onChange); // older Safari

    // Initial evaluation (deferred so all mobile modules have defined
    // their globals first — this script is loaded after them, but the
    // functions we override may be hoisted/defined already; capture at
    // activate() time regardless).
    if (mql.matches) {
        // If the DOM/other scripts are still parsing, wait a tick.
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', activate, { once: true });
        } else {
            activate();
        }
    }
    // else: phone — nothing happens beyond the idle listener above.

    console.log('Arena desktop layer ready (gated ≥1024px) ✅');
})();