/* ════════════════════════════════════════════════════════════════
   NAADI AI — LIBRARY DESKTOP LAYER  (libdesk-desktop.js)
   ─────────────────────────────────────────────────────────────────
   Desktop-native (≥1024px) presentation for the WHOLE Library section:
   the Study Material subject/class picker, the chapter list, the
   full-screen PDF reader workspace, the Revision Notes notebook shelf
   and the notebook detail. Third pass in the arena-desktop.js /
   opd-desktop.js pattern, mirrored EXACTLY:

     • One IIFE, self-gated with matchMedia('(min-width:1024px)').
     • On a phone: registers ONE idle change-listener and does NOTHING
       else — no globals reassigned, nothing rendered, no DOM touched,
       no reader shell rebuilt, no notebook DOM touched.
     • At ≥1024px: captures the mobile render entry points, overrides
       them, and RESTORES the originals verbatim if the viewport drops
       below 1024px (resize / devtools). Repaints the active view on
       activate + deactivate so a resize is seamless.

   It overrides PRESENTATION ONLY. Every override reuses study-material.js
   and revision-notes.js's own state (studyState / notesState), constants
   (HIGHLIGHT_COLORS / NOTE_TAGS / NOTE_TAG_META / NOTEBOOK_LIMIT) and
   handlers verbatim. Nothing in study-material.js / revision-notes.js /
   library.js / shared.js / backend.py is edited.

   REUSED VERBATIM (never redefined here):
       renderPdfPage, drawPageHighlights, updateReaderChrome,
       renderSidebarTab, sidebarJump, readerGo, readerZoom,
       openGotoSheet, toggleBookmark, applyReadingMode,
       cycleReadingMode, bindReaderSelection / bindReaderSwipe /
       bindReaderPinch, saveSelectionHighlight, readerAddNote,
       readerCopySelection, offerHighlightDelete, deleteHighlight,
       hideHighlightBar, exitPdfReader, refreshReaderNotes,
       setStudyClass, studyOpenChapter, resumeStudy, studyPct,
       studyProgMap, studyCountMap, noteEntryHtml, noteSourceChipHtml,
       openNoteComposer, openCreateNotebookSheet, confirmDeleteNotebook,
       toggleNoteStar, openNoteEditor, confirmDeleteNote,
       exportNotebookPdf, buildNotebookPdfDoc, deliverPdf,
       escapeHtml / safeHtml / ndToast / apiCall.

   TWO STRUCTURAL INVARIANTS the reader override MUST honour:
     1. applyReadingMode() targets #pdfm-wrap by id and toggles
        .mode-light/.mode-sepia/.mode-dark on it — so our shell keeps
        an element with EXACTLY that id as its outermost node.
     2. renderSidebarTab() writes into #pdfm-sb-body and keys the active
        tab off `.pdfm-sb-tabs button[data-tab]` — so the persistent
        rail reuses those exact ids/classes. Re-homing the drawer is
        therefore a pure structure+CSS change; the renderer is untouched.
     3. renderPdfPage() derives its scale from `stage.clientWidth - 16`,
        so the CENTRE GRID COLUMN width is the zoom baseline. We never
        pass a scale — we just give the stage a comfortable desktop
        column and the page sizes itself.
   ════════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    var mql = window.matchMedia('(min-width: 1024px)');

    // Names of the globals we take over. Order is irrelevant — captured
    // (and restored) as a set on activate/deactivate.
    var TARGETS = [
        'loadStudyMaterial',
        'loadStudyChapters',
        'renderReaderShell',
        'openReaderSidebar',
        'closeReaderSidebar',
        'loadRevisionNotes',
        'renderNotebookDetail'
    ];

    var originals = {};   // name -> original fn (captured on activate)
    var active = false;

    // Desktop-only view state (never leaks into studyState/notesState).
    var ldTagFilter = 'all';

    // ── local helpers (never leak to global scope) ──
    function esc(s) {
        return (typeof escapeHtml === 'function') ? escapeHtml(s) : String(s == null ? '' : s);
    }
    function q(s) {
        return String(s == null ? '' : s).replace(/'/g, "\\'");
    }
    function progMap() {
        return (typeof studyProgMap === 'function') ? studyProgMap() : {};
    }
    function countMap() {
        return (typeof studyCountMap === 'function') ? studyCountMap() : {};
    }
    function pct(e) {
        return (typeof studyPct === 'function') ? studyPct(e) : 0;
    }
    function hlHex(c) {
        var pal = (typeof HIGHLIGHT_COLORS !== 'undefined') ? HIGHLIGHT_COLORS : {};
        return pal[c] || c || '#fde047';
    }

    // ════════════════════════════════════════════════════════════
    // A · SUBJECT / CLASS PICKER  (loadStudyMaterial)
    // Desktop: wide hero + class toggle on one row, the resume card as
    // a full-width banner, subjects as a 3-up board. Every navigate()
    // hook, setStudyClass() call and the intro copy are preserved.
    // ════════════════════════════════════════════════════════════
    function ldLoadStudyMaterial() {
        var container = document.getElementById('study-material-content');
        if (!container) return;

        var cls = studyState.classLevel;
        var prog = progMap();
        var counts = countMap();

        var openedFor = function (subj) {
            return Object.keys(prog).filter(function (k) {
                var e = prog[k];
                return e.subject === subj && Number(e.class_level) === cls;
            }).length;
        };
        var totalFor = function (subj) { return counts[subj + '_' + cls] || 0; };

        // Same three subjects, same live/coming-soon split as mobile.
        var SUBJECTS = [
            { name: 'Biology', icon: '<i class="fa-solid fa-dna"></i>', klass: 'sm-bio', live: true },
            { name: 'Physics', icon: '<i class="fa-solid fa-atom"></i>', klass: 'sm-phy', live: false },
            { name: 'Chemistry', icon: '<i class="fa-solid fa-flask-vial"></i>', klass: 'sm-chem', live: false }
        ];

        var subjCard = function (s, i) {
            var delay = 'animation-delay:' + (0.05 + i * 0.08).toFixed(2) + 's;';
            if (!s.live) {
                return '<div class="sm-subj-card ' + s.klass + ' locked" style="' + delay + '">' +
                    '<div class="sm-subj-ico">' + s.icon + '</div>' +
                    '<div class="sm-subj-info">' +
                    '<h3>' + s.name + '</h3>' +
                    '<p>PDFs being prepared</p>' +
                    '<span class="sm-lock-badge"><i class="fa-solid fa-lock"></i> Coming soon</span>' +
                    '</div></div>';
            }
            var opened = openedFor(s.name), total = totalFor(s.name);
            var p = total ? Math.min(100, Math.round((opened / total) * 100)) : 0;
            var meta = total
                ? (opened ? opened + ' of ' + total + ' chapters opened' : total + ' chapters · NCERT PDFs')
                : 'NCERT chapter PDFs';
            return '<div class="sm-subj-card ' + s.klass + '" style="' + delay + '" ' +
                'onclick="navigate(\'study-chapters\', {subject:\'' + s.name + '\', class_level:' + cls + '})">' +
                '<div class="sm-subj-ico">' + s.icon + '</div>' +
                '<div class="sm-subj-info">' +
                '<h3>' + s.name + '</h3>' +
                '<p>' + meta + '</p>' +
                ((opened && total) ? '<div class="sm-subj-prog"><i style="width:' + p + '%"></i></div>' : '') +
                '</div>' +
                '<i class="fa-solid fa-chevron-right sm-subj-chev"></i>' +
                '</div>';
        };

        // Resume banner — identical data + resumeStudy() hook as mobile.
        var last = (typeof studyLastRead === 'function') ? studyLastRead() : null;
        var continueHtml = (last && last.pdf_url && pct(last) < 100)
            ? '<div class="libdesk-resume">' +
            '<div class="sm-continue" onclick="resumeStudy(\'' + q(last.chapter_id) + '\')">' +
            '<div class="sm-continue-ico"><i class="fa-solid fa-book-open"></i></div>' +
            '<div class="sm-continue-body">' +
            '<span class="sm-continue-k">Continue reading</span>' +
            '<span class="sm-continue-t">' + esc(last.title || 'Chapter') + '</span>' +
            '<div class="sm-continue-bar"><i style="width:' + pct(last) + '%"></i></div>' +
            '<span class="sm-continue-pg">Page ' + last.page + ' of ' + (last.numPages || '—') +
            ' · ' + esc(last.subject || '') + '</span>' +
            '</div>' +
            '<div class="sm-continue-go"><i class="fa-solid fa-arrow-right"></i></div>' +
            '</div></div>'
            : '';

        container.innerHTML =
            '<div class="m-picker-wrap libdesk-wrap sm-landing">' +
            '<div class="libdesk-picker-top">' +
            '<div class="libdesk-hero" style="border-bottom:none;margin-bottom:0;padding-bottom:0;">' +
            '<div class="libdesk-hero-kicker">Library · Study Material</div>' +
            '<h1>Study Material</h1>' +
            '<p>Read NCERT chapter PDFs with highlights, bookmarks and notes that sync to your notebooks.</p>' +
            '</div>' +
            '<div class="libdesk-clswrap">' +
            '<div class="sm-cls-toggle ' + (cls === 12 ? 'two' : '') + '">' +
            '<div class="sm-cls-pill"></div>' +
            '<button class="' + (cls === 11 ? 'on' : '') + '" onclick="setStudyClass(11)">Class 11</button>' +
            '<button class="' + (cls === 12 ? 'on' : '') + '" onclick="setStudyClass(12)">Class 12</button>' +
            '</div></div>' +
            '</div>' +
            continueHtml +
            '<div class="libdesk-sec-label">Subjects</div>' +
            '<div class="libdesk-subjboard">' + SUBJECTS.map(subjCard).join('') + '</div>' +
            '</div>';
    }

    // ════════════════════════════════════════════════════════════
    // B · CHAPTER LIST  (loadStudyChapters)
    // Desktop: sticky back+subject header, resume card, 2-up chapter
    // grid. Reuses the mobile .sm-ch-row markup and studyOpenChapter().
    // Chapter-count caching + every chip is preserved.
    // ════════════════════════════════════════════════════════════
    function ldLoadStudyChapters(subject, classLevel) {
        studyState.subject = subject;
        studyState.classLevel = Number(classLevel) || studyState.classLevel;
        var container = document.getElementById('study-chapters-content');
        if (!container) return Promise.resolve();

        container.innerHTML = '<div class="m-picker-wrap libdesk-wrap">' +
            '<div class="loading-spinner"><div class="spinner"></div> Loading chapters...</div></div>';

        return apiCall('/api/study/chapters/' + subject + '/' + studyState.classLevel)
            .then(function (chapters) {
                studyState.chapters = Array.isArray(chapters) ? chapters : [];

                // Same frontend-only chapter-total cache as mobile.
                try {
                    var counts = countMap();
                    counts[subject + '_' + studyState.classLevel] = studyState.chapters.length;
                    localStorage.setItem('NAADI_STUDY_COUNT', JSON.stringify(counts));
                } catch (_) { }

                var prog = progMap();

                var rows = studyState.chapters.map(function (ch, idx) {
                    var e = prog[ch.chapter_id];
                    var p = pct(e);
                    var done = e && p >= 100;
                    var status = '';
                    if (done) {
                        status = '<span class="sm-ch-chip done"><i class="fa-solid fa-circle-check"></i> Read</span>';
                    } else if (e) {
                        status = '<span class="sm-ch-chip live"><i class="fa-solid fa-book-open-reader"></i> p.' + e.page + '</span>';
                    }
                    var pages = ch.page_count
                        ? '<span class="sm-ch-chip"><i class="fa-solid fa-file-lines"></i> ' + ch.page_count + ' pages</span>' : '';
                    var hl = (ch.highlight_count != null)
                        ? '<span class="sm-ch-chip"><i class="fa-solid fa-highlighter"></i> ' + ch.highlight_count + '</span>' : '';
                    var bm = (ch.bookmark_count != null)
                        ? '<span class="sm-ch-chip"><i class="fa-solid fa-bookmark"></i> ' + ch.bookmark_count + '</span>' : '';
                    var delay = 'animation-delay:' + (0.04 + Math.min(idx, 8) * 0.05).toFixed(2) + 's;';
                    return '<div class="sm-ch-row ' + (done ? 'done' : '') + '" style="' + delay + '" ' +
                        'onclick="studyOpenChapter(' + idx + ')">' +
                        '<div class="sm-ch-num">' + (done ? '<i class="fa-solid fa-check"></i>' : (ch.chapter_number || idx + 1)) + '</div>' +
                        '<div class="sm-ch-info">' +
                        '<h4>' + esc(ch.chapter_title || 'Untitled chapter') + '</h4>' +
                        '<div class="sm-ch-meta">' + status + pages + hl + bm + '</div>' +
                        ((e && !done) ? '<div class="sm-ch-prog"><i style="width:' + p + '%"></i></div>' : '') +
                        '</div>' +
                        '<i class="fa-solid fa-chevron-right sm-ch-chev"></i>' +
                        '</div>';
                }).join('');

                // Featured "Continue" for this subject+class (same filter).
                var continueHtml = '';
                var mine = Object.keys(prog).map(function (id) {
                    var o = {}; for (var k in prog[id]) o[k] = prog[id][k];
                    o.chapter_id = id; return o;
                }).filter(function (e) {
                    return e.subject === subject && Number(e.class_level) === studyState.classLevel &&
                        pct(e) < 100 && e.pdf_url;
                }).sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });

                if (mine.length) {
                    var m = mine[0];
                    continueHtml = '<div class="libdesk-resume">' +
                        '<div class="sm-continue" onclick="resumeStudy(\'' + q(m.chapter_id) + '\')">' +
                        '<div class="sm-continue-ico"><i class="fa-solid fa-book-open"></i></div>' +
                        '<div class="sm-continue-body">' +
                        '<span class="sm-continue-k">Continue</span>' +
                        '<span class="sm-continue-t">Ch ' + (m.chapter_number || '—') + ' · ' + esc(m.title || 'Chapter') + '</span>' +
                        '<div class="sm-continue-bar"><i style="width:' + pct(m) + '%"></i></div>' +
                        '<span class="sm-continue-pg">Resume at page ' + m.page + ' of ' + (m.numPages || '—') + '</span>' +
                        '</div>' +
                        '<div class="sm-continue-go"><i class="fa-solid fa-play"></i></div>' +
                        '</div></div>';
                }

                var opened = Object.keys(prog).filter(function (k) {
                    var x = prog[k];
                    return x.subject === subject && Number(x.class_level) === studyState.classLevel;
                }).length;

                var n = studyState.chapters.length;

                container.innerHTML =
                    '<div class="m-picker-wrap libdesk-wrap sm-chapters">' +
                    '<div class="libdesk-chhead">' +
                    '<button class="libdesk-backbtn" onclick="navigate(\'study-material\')">' +
                    '<i class="fa-solid fa-arrow-left"></i> Subjects</button>' +
                    '<div class="libdesk-chhead-t" style="min-width:0;">' +
                    '<h2>' + esc(subject) + ' — Class ' + studyState.classLevel + '</h2>' +
                    '<p>' + n + ' chapter' + (n !== 1 ? 's' : '') + (opened ? ' · ' + opened + ' opened' : '') + '</p>' +
                    '</div></div>' +
                    (n === 0
                        ? '<div class="empty-state"><i class="fa-solid fa-file-pdf"></i>' +
                        '<h3>No chapters uploaded yet</h3>' +
                        '<p style="margin-top:8px;color:var(--s500);">Class ' + studyState.classLevel + ' ' +
                        esc(subject) + ' PDFs will appear here once uploaded.</p></div>'
                        : continueHtml +
                        '<div class="libdesk-sec-label">All chapters</div>' +
                        '<div class="libdesk-chgrid">' + rows + '</div>') +
                    '</div>';
            })
            .catch(function (e) {
                container.innerHTML = '<div class="m-picker-wrap libdesk-wrap">' +
                    '<button class="libdesk-backbtn" style="margin-bottom:16px;" onclick="navigate(\'study-material\')">' +
                    '<i class="fa-solid fa-arrow-left"></i> Back</button>' +
                    '<div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i>' +
                    '<h3>Could not load chapters</h3>' +
                    '<p style="margin-top:8px;color:var(--s500);">' + esc(e.message) + '</p></div></div>';
            });
    }

    // ════════════════════════════════════════════════════════════
    // C · PDF READER WORKSPACE  (renderReaderShell)
    // The centrepiece. Same DOM contract as the mobile shell — every id
    // and class the untouched handlers depend on is reproduced exactly —
    // but re-flowed into a three-region grid, with the drawer re-homed
    // as an always-visible right rail and a page navigator on the left.
    //
    // openPdfReader() calls: renderReaderShell(container) →
    // applyReadingMode() → bindReaderSelection/Swipe/Pinch() →
    // renderPdfPage(). All four of those run against OUR markup
    // unchanged because we preserve #pdfm-wrap, #pdfm-stage,
    // #pdfm-page-wrap, #pdfm-canvas, #pdfm-hl-layer, #pdfm-text-layer,
    // #pdfm-hl-bar, #pdfm-prev/#pdfm-next/#pdfm-pageind, #pdfm-bm-btn,
    // #pdfm-sb-overlay and #pdfm-sb-body.
    // ════════════════════════════════════════════════════════════
    function ldRenderReaderShell(container) {
        var ch = studyState.chapter || {};
        var colors = (typeof HIGHLIGHT_COLORS !== 'undefined') ? HIGHLIGHT_COLORS : {};

        var swatches = Object.keys(colors).map(function (c) {
            return '<button class="pdfm-hl-swatch" style="background:' + colors[c] + ';" ' +
                'onclick="saveSelectionHighlight(\'' + c + '\')" aria-label="Highlight ' + c + '"></button>';
        }).join('');

        container.innerHTML =
            // #pdfm-wrap MUST stay the outermost node — applyReadingMode
            // toggles .mode-* on it by id.
            '<div class="pdfm-wrap libdesk-reader" id="pdfm-wrap">' +

            // ── Top bar (spans the grid) ──
            '<div class="pdfm-topbar">' +
            '<button class="te-icon-btn" onclick="exitPdfReader()" aria-label="Close reader">' +
            '<i class="fa-solid fa-arrow-left"></i></button>' +
            '<div class="pdfm-title">' +
            '<b>' + esc(ch.chapter_title || 'Chapter') + '</b>' +
            '<span>' + esc(ch.subject || '') + ' · Class ' + esc(String(ch.class_level || '')) + '</span>' +
            '</div>' +
            '<button class="te-icon-btn" id="pdfm-mode-btn" onclick="cycleReadingMode()" aria-label="Reading mode">' +
            '<i class="fa-solid fa-circle-half-stroke"></i></button>' +
            '<button class="te-icon-btn" id="pdfm-bm-btn" onclick="toggleBookmark()" aria-label="Bookmark this page">' +
            '<i class="fa-regular fa-bookmark"></i></button>' +
            '</div>' +

            // ── Left rail: page navigator ──
            '<div class="libdesk-nav" id="libdesk-nav">' +
            '<div class="libdesk-nav-title">Pages</div>' +
            '<div class="libdesk-pglist" id="libdesk-pglist"></div>' +
            '</div>' +

            // ── Centre: the stage (unchanged internals) ──
            '<div class="pdfm-stage" id="pdfm-stage">' +
            '<div class="pdfm-page-wrap" id="pdfm-page-wrap">' +
            '<canvas id="pdfm-canvas"></canvas>' +
            '<div class="pdfm-hl-layer" id="pdfm-hl-layer"></div>' +
            '<div class="pdfm-text-layer" id="pdfm-text-layer"></div>' +
            '</div></div>' +

            // ── Selection action bar (identical handlers) ──
            '<div class="pdfm-hl-bar" id="pdfm-hl-bar">' +
            swatches +
            '<span class="pdfm-hl-bar-div"></span>' +
            '<button class="pdfm-hl-act" onclick="readerAddNote()"><i class="fa-solid fa-note-sticky"></i> Note</button>' +
            '<button class="pdfm-hl-act icon" onclick="readerCopySelection()" aria-label="Copy text"><i class="fa-solid fa-copy"></i></button>' +
            '<button class="pdfm-hl-bar-close" onclick="hideHighlightBar(true)" aria-label="Dismiss">' +
            '<i class="fa-solid fa-xmark"></i></button>' +
            '</div>' +

            // ── Right rail: the re-homed drawer. Same overlay/sidebar
            //    classes + #pdfm-sb-body so renderSidebarTab is untouched.
            //    No onclick-to-close: on desktop it is permanent. ──
            '<div class="pdfm-sidebar-overlay open" id="pdfm-sb-overlay">' +
            '<div class="pdfm-sidebar">' +
            '<div class="pdfm-sb-tabs">' +
            '<button data-tab="highlights" onclick="renderSidebarTab(\'highlights\')"><i class="fa-solid fa-highlighter"></i> Highlights</button>' +
            '<button data-tab="bookmarks" onclick="renderSidebarTab(\'bookmarks\')"><i class="fa-solid fa-bookmark"></i> Bookmarks</button>' +
            '<button data-tab="notes" onclick="renderSidebarTab(\'notes\')"><i class="fa-solid fa-note-sticky"></i> Notes</button>' +
            '</div>' +
            '<div class="pdfm-sb-body" id="pdfm-sb-body"></div>' +
            '</div></div>' +

            // ── Bottom toolbar (spans the grid) ──
            '<div class="pdfm-toolbar">' +
            '<div class="pdfm-tb-group">' +
            '<button class="te-nav-btn" id="pdfm-prev" onclick="readerGo(-1)" aria-label="Previous page">' +
            '<i class="fa-solid fa-chevron-left"></i></button>' +
            '<button class="pdfm-pageind" id="pdfm-pageind" onclick="openGotoSheet()">1 / ' + studyState.numPages + '</button>' +
            '<button class="te-nav-btn" id="pdfm-next" onclick="readerGo(1)" aria-label="Next page">' +
            '<i class="fa-solid fa-chevron-right"></i></button>' +
            '</div>' +
            '<div class="pdfm-tb-group">' +
            '<button class="te-nav-btn" onclick="readerZoom(-1)" aria-label="Zoom out"><i class="fa-solid fa-magnifying-glass-minus"></i></button>' +
            '<button class="te-nav-btn" onclick="readerZoom(1)" aria-label="Zoom in"><i class="fa-solid fa-magnifying-glass-plus"></i></button>' +
            '<button class="pdfm-note-btn" onclick="readerAddNote()" aria-label="Add note"><i class="fa-solid fa-note-sticky"></i><span>Note</span></button>' +
            '</div>' +
            '</div>' +

            '</div>';

        // Paint the persistent rail immediately (mobile only paints on
        // drawer-open). renderSidebarTab is the UNTOUCHED original.
        if (typeof renderSidebarTab === 'function') {
            try { renderSidebarTab('highlights'); } catch (_) { }
        }
        ldRenderPageNav();
    }

    // Page navigator: one row per page, marked with bookmark/highlight
    // indicators, driving the untouched renderPdfPage(). Rebuilt on
    // demand (cheap — a chapter is tens of pages, not thousands).
    function ldRenderPageNav() {
        var list = document.getElementById('libdesk-pglist');
        if (!list) return;
        var n = studyState.numPages || 0;
        var hlPages = {};
        (studyState.highlights || []).forEach(function (h) { hlPages[h.page] = true; });

        var out = '';
        for (var p = 1; p <= n; p++) {
            var marks = '';
            if (studyState.bookmarks && studyState.bookmarks.has(p)) {
                marks += '<i class="fa-solid fa-bookmark bm"></i>';
            }
            if (hlPages[p]) marks += '<i class="fa-solid fa-highlighter hl"></i>';
            out += '<button class="libdesk-pgitem ' + (p === studyState.page ? 'on' : '') + '" ' +
                'onclick="renderPdfPage(' + p + ')">' +
                '<span>Page ' + p + '</span>' +
                (marks ? '<span class="libdesk-pgmarks">' + marks + '</span>' : '') +
                '</button>';
        }
        list.innerHTML = out;

        var on = list.querySelector('.libdesk-pgitem.on');
        if (on && on.scrollIntoView) {
            try { on.scrollIntoView({ block: 'nearest' }); } catch (_) { }
        }
    }

    // openReaderSidebar override: the rail is always visible on desktop,
    // so the top-bar/drawer entry point becomes a tab-switcher. If our
    // rail is somehow absent (e.g. mobile shell still mounted), fall
    // back to the captured ORIGINAL so nothing is lost.
    function ldOpenReaderSidebar(tab) {
        var wrap = document.getElementById('pdfm-wrap');
        if (wrap && wrap.classList.contains('libdesk-reader')) {
            if (typeof renderSidebarTab === 'function') renderSidebarTab(tab || 'highlights');
            return;
        }
        if (typeof originals.openReaderSidebar === 'function') originals.openReaderSidebar(tab);
    }

    // closeReaderSidebar override: a no-op on desktop (the rail is
    // permanent — closing it would strand the tabs). Falls back to the
    // original whenever our shell isn't the one on screen.
    function ldCloseReaderSidebar(e) {
        var wrap = document.getElementById('pdfm-wrap');
        if (wrap && wrap.classList.contains('libdesk-reader')) return;
        if (typeof originals.closeReaderSidebar === 'function') originals.closeReaderSidebar(e);
    }

    // ════════════════════════════════════════════════════════════
    // D · NOTEBOOK SHELF  (loadRevisionNotes)
    // Desktop: proper header with the count pill, a 4-up shelf of
    // spines, add-tile inline. Reuses .nb-card.spine-N + the 6-cap
    // logic + openCreateNotebookSheet() verbatim.
    // ════════════════════════════════════════════════════════════
    function ldLoadRevisionNotes() {
        var container = document.getElementById('revision-notes-content');
        if (!container) return Promise.resolve();

        container.innerHTML = '<div class="m-picker-wrap libdesk-wrap">' +
            '<div class="loading-spinner"><div class="spinner"></div> Loading notebooks...</div></div>';

        return fetchNotebooks(true).then(function (notebooks) {
            notebooks = notebooks || [];
            var limit = (typeof NOTEBOOK_LIMIT !== 'undefined') ? NOTEBOOK_LIMIT : 6;
            var atLimit = notebooks.length >= limit;

            var cards = notebooks.map(function (nb, i) {
                var count = nb.notes_count || 0;
                return '<div class="nb-card spine-' + ((i % 6) + 1) + '" ' +
                    'style="animation-delay:' + (0.04 + i * 0.05).toFixed(2) + 's" ' +
                    'onclick="navigate(\'notebook-detail\', {notebook_id:\'' + q(nb.notebook_id) + '\'})">' +
                    '<div class="nb-card-top">' +
                    '<div class="nb-card-icon"><i class="fa-solid fa-book"></i></div>' +
                    '<i class="fa-solid fa-chevron-right nb-card-go"></i>' +
                    '</div>' +
                    '<h4>' + esc(nb.title || 'Untitled') + '</h4>' +
                    '<p><i class="fa-solid fa-note-sticky"></i> ' + count + ' note' + (count !== 1 ? 's' : '') + '</p>' +
                    '</div>';
            }).join('');

            var addDelay = (0.04 + notebooks.length * 0.05).toFixed(2);
            var addTile = atLimit
                ? '<div class="nb-card add-new disabled" style="animation-delay:' + addDelay + 's">' +
                '<div class="nb-card-top"><div class="nb-card-icon"><i class="fa-solid fa-lock"></i></div></div>' +
                '<h4>Notebook limit reached</h4>' +
                '<p>All ' + limit + ' notebooks in use. Delete one to make room.</p></div>'
                : '<div class="nb-card add-new" style="animation-delay:' + addDelay + 's" ' +
                'onclick="openCreateNotebookSheet()">' +
                '<div class="nb-card-top"><div class="nb-card-icon"><i class="fa-solid fa-plus"></i></div></div>' +
                '<h4>New Notebook</h4>' +
                '<p>Create a fresh notebook</p></div>';

            container.innerHTML =
                '<div class="m-picker-wrap libdesk-wrap">' +
                '<div class="libdesk-headrow libdesk-hero">' +
                '<div>' +
                '<div class="libdesk-hero-kicker">Library · Revision Notes</div>' +
                '<h1>Revision Notes</h1>' +
                '<p>Your personal NEET notebooks — notes saved from any chapter land here.</p>' +
                '</div>' +
                '<span class="nb-count-pill ' + (atLimit ? 'full' : '') + '">' +
                notebooks.length + '/' + limit + ' notebooks</span>' +
                '</div>' +
                (notebooks.length === 0
                    ? '<div class="empty-state" style="margin-bottom:18px;"><i class="fa-solid fa-book"></i>' +
                    '<h3>No notebooks yet</h3>' +
                    '<p style="margin-top:8px;color:var(--s500);">Create your first notebook, or add a note from inside a Study Material chapter.</p></div>'
                    : '') +
                '<div class="nb-grid libdesk-nbshelf">' + cards + addTile + '</div>' +
                '</div>';
        }).catch(function (e) {
            container.innerHTML = '<div class="m-picker-wrap libdesk-wrap">' +
                '<div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i>' +
                '<h3>Could not load notebooks</h3>' +
                '<p style="margin-top:8px;color:var(--s500);">' + esc(e.message) + '</p>' +
                '<button class="btn btn-outline" style="margin-top:16px;min-height:44px;" onclick="loadRevisionNotes()">' +
                '<i class="fa-solid fa-rotate-right"></i> Retry</button></div></div>';
        });
    }

    // ════════════════════════════════════════════════════════════
    // E · NOTEBOOK DETAIL  (renderNotebookDetail)
    // Desktop: sticky summary + Download/Delete on the left, the ruled
    // note stream on the right, with a tag filter built from
    // NOTE_TAG_META. Reuses noteEntryHtml() verbatim, so star / edit /
    // delete / source chips all behave identically, and keeps
    // #nb-export-btn → exportNotebookPdf() exactly as-is.
    // ════════════════════════════════════════════════════════════
    function ldRenderNotebookDetail() {
        var container = document.getElementById('notebook-detail-content');
        if (!container) return;

        var nb = notesState.currentNotebook || {};
        var notes = notesState.currentNotes || [];
        var nid = q(notesState.currentNotebookId);
        var starred = notes.filter(function (n) { return n.is_starred; }).length;
        var fromPdf = notes.filter(function (n) { return n.source_chapter; }).length;

        var meta = (typeof NOTE_TAG_META !== 'undefined') ? NOTE_TAG_META : {};

        // Tag filter — desktop-only affordance over the SAME note list.
        // Only tags actually present are offered.
        var present = {};
        notes.forEach(function (n) {
            present[meta[n.color_tag] ? n.color_tag : 'general'] = true;
        });
        var tagKeys = Object.keys(present);
        var filterHtml = '';
        if (tagKeys.length > 1) {
            filterHtml = '<div class="libdesk-tagfilter">' +
                '<button class="libdesk-tagchip ' + (ldTagFilter === 'all' ? 'on' : '') + '" ' +
                'onclick="__libdeskSetTagFilter(\'all\')">All ' + notes.length + '</button>' +
                tagKeys.map(function (t) {
                    var m = meta[t] || { label: t, icon: 'fa-pen', hex: '#94a3b8' };
                    var c = notes.filter(function (n) {
                        return (meta[n.color_tag] ? n.color_tag : 'general') === t;
                    }).length;
                    return '<button class="libdesk-tagchip ' + (ldTagFilter === t ? 'on' : '') + '" ' +
                        'style="--tag:' + m.hex + ';" onclick="__libdeskSetTagFilter(\'' + t + '\')">' +
                        '<i class="fa-solid ' + m.icon + '"></i> ' + m.label + ' ' + c + '</button>';
                }).join('') +
                '</div>';
        }

        var shown = (ldTagFilter === 'all') ? notes : notes.filter(function (n) {
            return (meta[n.color_tag] ? n.color_tag : 'general') === ldTagFilter;
        });

        // noteEntryHtml is the UNTOUCHED mobile builder.
        var entries = shown.length === 0
            ? (notes.length === 0
                ? '<div class="nb-empty">This notebook is empty — add your first note below, or save one from a Study Material chapter.</div>'
                : '<div class="nb-empty">No notes with this tag.</div>')
            : shown.map(function (n) {
                return (typeof noteEntryHtml === 'function') ? noteEntryHtml(n) : '';
            }).join('');

        container.innerHTML =
            '<div class="m-picker-wrap libdesk-wrap">' +
            '<div class="libdesk-nbdetail">' +

            // Left: sticky summary + actions
            '<div class="libdesk-nbside">' +
            '<button class="libdesk-backbtn" onclick="navigate(\'revision-notes\')">' +
            '<i class="fa-solid fa-arrow-left"></i> All notebooks</button>' +
            '<div class="libdesk-nbsummary">' +
            '<h2>' + esc(nb.title || 'Untitled') + '</h2>' +
            '<p>' + notes.length + ' note' + (notes.length !== 1 ? 's' : '') +
            (starred ? ' · ' + starred + ' starred' : '') + '</p>' +
            '<div class="libdesk-nbstats">' +
            '<div class="libdesk-nbstat"><b>' + notes.length + '</b><span>Notes</span></div>' +
            '<div class="libdesk-nbstat"><b>' + starred + '</b><span>Starred</span></div>' +
            '<div class="libdesk-nbstat"><b>' + fromPdf + '</b><span>From PDF</span></div>' +
            '</div></div>' +
            '<div class="libdesk-nbactions">' +
            '<button class="nb-download-btn" id="nb-export-btn" onclick="exportNotebookPdf()">' +
            '<i class="fa-solid fa-file-arrow-down"></i> Download</button>' +
            '<button class="btn btn-outline btn-sm danger-outline" style="min-height:46px;" ' +
            'onclick="confirmDeleteNotebook(\'' + nid + '\', \'' + q(esc(nb.title || 'Untitled')) + '\', ' + notes.length + ')">' +
            '<i class="fa-solid fa-trash"></i></button>' +
            '</div></div>' +

            // Right: the ruled note stream
            '<div class="libdesk-nbstream">' +
            filterHtml +
            '<div class="nb-page">' +
            '<div class="nb-page-body">' +
            entries +
            '<button class="nb-add-note-inline" onclick="openNoteComposer({ notebookId: \'' + nid + '\' })">' +
            '<i class="fa-solid fa-plus"></i> Add a note</button>' +
            '</div></div></div>' +

            '</div></div>';
    }

    // Desktop-only tag filter setter. Installed on activate, deleted on
    // deactivate (same discipline as arena-desktop's __adSetVaultMode).
    function ldSetTagFilter(tag) {
        ldTagFilter = tag || 'all';
        ldRenderNotebookDetail();
    }

    // ════════════════════════════════════════════════════════════
    // ACTIVATE / DEACTIVATE
    // ════════════════════════════════════════════════════════════
    var overrideMap = {
        loadStudyMaterial: ldLoadStudyMaterial,
        loadStudyChapters: ldLoadStudyChapters,
        renderReaderShell: ldRenderReaderShell,
        openReaderSidebar: ldOpenReaderSidebar,
        closeReaderSidebar: ldCloseReaderSidebar,
        loadRevisionNotes: ldLoadRevisionNotes,
        renderNotebookDetail: ldRenderNotebookDetail
    };

    function activate() {
        if (active) return;
        active = true;
        TARGETS.forEach(function (name) {
            if (!(name in originals)) originals[name] = window[name]; // capture once
            if (typeof overrideMap[name] === 'function') window[name] = overrideMap[name];
        });
        window.__libdeskSetTagFilter = ldSetTagFilter;
        window.__libdeskRenderPageNav = ldRenderPageNav;
        repaintActiveView();
    }

    function deactivate() {
        if (!active) return;
        active = false;
        TARGETS.forEach(function (name) {
            if (name in originals) window[name] = originals[name]; // restore verbatim
        });
        delete window.__libdeskSetTagFilter;
        delete window.__libdeskRenderPageNav;
        ldTagFilter = 'all';
        repaintActiveView();
    }

    // Repaint whichever Library view is currently active, using whatever
    // (original or override) is now installed, so a viewport cross is
    // seamless. Best-effort; never throws into the app.
    function repaintActiveView() {
        try {
            var v = function (id) {
                var el = document.getElementById(id);
                return el && el.classList.contains('active');
            };

            if (v('view-study-material') && typeof loadStudyMaterial === 'function') {
                loadStudyMaterial();
            } else if (v('view-study-chapters') && typeof loadStudyChapters === 'function' && studyState.subject) {
                loadStudyChapters(studyState.subject, studyState.classLevel);
            } else if (v('view-revision-notes') && typeof loadRevisionNotes === 'function') {
                loadRevisionNotes();
            } else if (v('view-notebook-detail') && notesState.currentNotebook && typeof renderNotebookDetail === 'function') {
                renderNotebookDetail();
            } else if (v('view-pdf-reader') && studyState._open && studyState.pdfDoc &&
                typeof renderReaderShell === 'function') {
                // A live reading session: rebuild the shell in the now-active
                // layout and re-render the SAME page. State (page, zoom,
                // highlights, bookmarks, notes) lives on studyState, so
                // nothing is lost across the crossing.
                var cont = document.getElementById('pdf-reader-content');
                if (cont) {
                    renderReaderShell(cont);
                    if (typeof applyReadingMode === 'function') applyReadingMode(studyState.mode);
                    if (typeof bindReaderSelection === 'function') bindReaderSelection();
                    if (typeof bindReaderSwipe === 'function') bindReaderSwipe();
                    if (typeof bindReaderPinch === 'function') bindReaderPinch();
                    if (typeof renderPdfPage === 'function') renderPdfPage(studyState.page);
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

    console.log('Library desktop layer ready (gated ≥1024px) ✅');
})();