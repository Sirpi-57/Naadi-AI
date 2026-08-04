/* ════════════════════════════════════════════════════════════════
   NAADI AI — STUDY MATERIAL (mobile)  study-material.js
   PDF library + reader. Screens: subject/class picker → chapter
   list → focused full-screen PDF reader (PDF.js via CDN — pure
   canvas + JS, no native plugin needed in the Capacitor WebView).

   Reader capabilities (spec §4.3):
     • canvas pages, prev/next + swipe (Concept Studio gesture rules)
     • zoom controls (highlights survive zoom — fractional coords)
     • bookmarks   → /api/study/bookmarks
     • highlights  → /api/study/highlights — rects stored as 0–1
       FRACTIONS of the canvas ({x,y,w,h}, isFractional:true). Never
       absolute pixels: pixels break across zoom levels (rule 4).
     • Add Note    → shared composer from revision-notes.js, saved via
       /api/notes/add with source_chapter/source_page set (rule 3:
       user picks an existing notebook, no auto-create-per-chapter)
     • sidebar drawer: Highlights / Bookmarks / Notes
       (notes via /api/notes/by-source/<chapter_id>)
     • reading modes light/sepia/dark, persisted in localStorage
       (display preference only — fine per spec)

   Content scope (rule 5): only Biology has real PDF chapters today —
   Physics/Chemistry are coming-soon ON DESKTOP TOO. Mirrored here.

   Requires shared.js, practice-hub.js (phOpenSheet/phCloseSheet) and
   revision-notes.js (openNoteComposer, loadScriptOnce).
   ════════════════════════════════════════════════════════════════ */

// ── PDF.js CDN (same library desktop uses) ──
const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const HIGHLIGHT_COLORS = {
    // Same palette as desktop's .highlight-color-btn swatches.
    yellow: '#fde047',
    green: '#4ade80',
    pink: '#f472b6',
    blue: '#60a5fa',
};
function highlightHex(color) {
    return HIGHLIGHT_COLORS[color] || color || HIGHLIGHT_COLORS.yellow;
}

// ── STATE ─────────────────────────────────────────────────────────
const studyState = {
    classLevel: 11,
    subject: null,
    chapters: [],               // last-loaded chapter list
    // reader
    chapter: null,              // chapter meta currently open
    loadingTask: null,
    pdfDoc: null,
    page: 1,
    numPages: 0,
    zoom: 1,                    // multiplier on the fit-width base scale
    lastScale: 1,               // absolute PDF.js scale of the last render
    bookmarks: new Set(),       // page numbers
    highlights: [],             // ALL pages' highlights for this chapter
    sourceNotes: [],            // /api/notes/by-source/<chapter_id>
    notebookNames: {},          // notebook_id -> title (for the Notes tab)
    mode: localStorage.getItem('NAADI_READER_MODE') || 'light',
    _renderTask: null,
    _rendering: false,
    _pendingPage: null,
    _selDebounce: null,
    _selHandler: null,
    _open: false,
};

// ════════════════════════════════════════════════════════════════
// LOCAL READING PROGRESS — frontend only (localStorage). No backend,
// no API contract touched. Mirrors the reader-mode persistence that
// already lives in this module. Powers "Continue reading", per-subject
// "x of y opened", and per-chapter progress bars.
//   NAADI_STUDY_PROG  → { [chapter_id]: {page,numPages,title,subject,
//                          class_level,chapter_number,pdf_url,ts} }
//   NAADI_STUDY_COUNT → { "<subject>_<class>": <total chapters> }
// ════════════════════════════════════════════════════════════════
function studyProgMap() {
    try { return JSON.parse(localStorage.getItem('NAADI_STUDY_PROG') || '{}'); } catch (_) { return {}; }
}
function studyCountMap() {
    try { return JSON.parse(localStorage.getItem('NAADI_STUDY_COUNT') || '{}'); } catch (_) { return {}; }
}
function studyPct(e) {
    return (e && e.numPages) ? Math.min(100, Math.round((e.page / e.numPages) * 100)) : 0;
}
function saveStudyProgress() {
    const ch = studyState.chapter;
    if (!ch || !ch.chapter_id) return;
    try {
        const map = studyProgMap();
        map[ch.chapter_id] = {
            page: studyState.page, numPages: studyState.numPages,
            title: ch.chapter_title, subject: ch.subject, class_level: ch.class_level,
            chapter_number: ch.chapter_number, pdf_url: ch.pdf_url, ts: Date.now(),
        };
        localStorage.setItem('NAADI_STUDY_PROG', JSON.stringify(map));
    } catch (_) { /* storage full / disabled — non-critical */ }
}
function studyLastRead() {
    const map = studyProgMap();
    let best = null;
    Object.keys(map).forEach(id => {
        const e = Object.assign({ chapter_id: id }, map[id]);
        if (!best || (e.ts || 0) > (best.ts || 0)) best = e;
    });
    return best;
}
// Reopen a chapter straight into the reader from a "Continue" card,
// reconstructing just enough chapter meta from the stored progress.
function resumeStudy(chapterId) {
    const e = studyProgMap()[chapterId];
    if (!e || !e.pdf_url) { ndToast('Open this chapter from the list once — then it resumes here.', 'info', 2400); return; }
    navigate('pdf-reader', {
        chapter: {
            chapter_id: chapterId, pdf_url: e.pdf_url, chapter_title: e.title,
            subject: e.subject, class_level: e.class_level, chapter_number: e.chapter_number,
            page_count: e.numPages,
        }
    });
}

// ════════════════════════════════════════════════════════════════
// LANDING  (view-study-material) — animated class toggle, a
// "Continue reading" strip, and colour-identity subject cards.
// Biology → real chapters. Physics/Chemistry → coming soon (mirrors
// the actual current content state on desktop too).
// ════════════════════════════════════════════════════════════════
function loadStudyMaterial() {
    const container = document.getElementById('study-material-content');
    const cls = studyState.classLevel;
    const prog = studyProgMap();
    const counts = studyCountMap();

    const openedFor = (subj) => Object.values(prog).filter(e => e.subject === subj && Number(e.class_level) === cls).length;
    const totalFor = (subj) => counts[`${subj}_${cls}`] || 0;

    const SUBJECTS = [
        { name: 'Biology', icon: '<i class="fa-solid fa-dna"></i>', klass: 'sm-bio', live: true },
        { name: 'Physics', icon: '<i class="fa-solid fa-atom"></i>', klass: 'sm-phy', live: false },
        { name: 'Chemistry', icon: '<i class="fa-solid fa-flask-vial"></i>', klass: 'sm-chem', live: false },
    ];

    const subjCard = (s, i) => {
        const delay = `animation-delay:${(0.05 + i * 0.08).toFixed(2)}s;`;
        if (!s.live) {
            return `<div class="sm-subj-card ${s.klass} locked" style="${delay}">
                <div class="sm-subj-ico">${s.icon}</div>
                <div class="sm-subj-info">
                    <h3>${s.name}</h3>
                    <p>PDFs being prepared</p>
                    <span class="sm-lock-badge"><i class="fa-solid fa-lock"></i> Coming soon</span>
                </div>
            </div>`;
        }
        const opened = openedFor(s.name), total = totalFor(s.name);
        const pct = total ? Math.min(100, Math.round((opened / total) * 100)) : 0;
        const meta = total
            ? (opened ? `${opened} of ${total} chapters opened` : `${total} chapters · NCERT PDFs`)
            : 'NCERT chapter PDFs';
        return `<div class="sm-subj-card ${s.klass}" style="${delay}"
            onclick="navigate('study-chapters', {subject:'${s.name}', class_level:${cls}})">
            <div class="sm-subj-ico">${s.icon}</div>
            <div class="sm-subj-info">
                <h3>${s.name}</h3>
                <p>${meta}</p>
                ${(opened && total) ? `<div class="sm-subj-prog"><i style="width:${pct}%"></i></div>` : ''}
            </div>
            <i class="fa-solid fa-chevron-right sm-subj-chev"></i>
        </div>`;
    };

    const last = studyLastRead();
    const continueHtml = (last && last.pdf_url && studyPct(last) < 100) ? `
        <div class="sm-continue" onclick="resumeStudy('${String(last.chapter_id).replace(/'/g, "\\'")}')">
            <div class="sm-continue-ico"><i class="fa-solid fa-book-open"></i></div>
            <div class="sm-continue-body">
                <span class="sm-continue-k">Continue reading</span>
                <span class="sm-continue-t">${escapeHtml(last.title || 'Chapter')}</span>
                <div class="sm-continue-bar"><i style="width:${studyPct(last)}%"></i></div>
                <span class="sm-continue-pg">Page ${last.page} of ${last.numPages || '—'} · ${escapeHtml(last.subject || '')}</span>
            </div>
            <div class="sm-continue-go"><i class="fa-solid fa-arrow-right"></i></div>
        </div>` : '';

    container.innerHTML = `
        <div class="m-picker-wrap sm-landing">
            <div class="sm-hero">
                <h2>Study Material</h2>
                <p>Read NCERT chapter PDFs with highlights, bookmarks and notes that sync to your notebooks.</p>
            </div>
            <div class="sm-cls-toggle ${cls === 12 ? 'two' : ''}">
                <div class="sm-cls-pill"></div>
                <button class="${cls === 11 ? 'on' : ''}" onclick="setStudyClass(11)">Class 11</button>
                <button class="${cls === 12 ? 'on' : ''}" onclick="setStudyClass(12)">Class 12</button>
            </div>
            ${continueHtml}
            <div class="sm-sec-label">Subjects</div>
            <div class="sm-subj-list">
                ${SUBJECTS.map(subjCard).join('')}
            </div>
        </div>`;
}

// Re-render the landing so the toggle pill slides and per-subject
// progress reflects the chosen class. (Legacy callers may still pass a
// second `btn` arg — harmlessly ignored.)
function setStudyClass(cls) {
    studyState.classLevel = cls;
    loadStudyMaterial();
}

// ════════════════════════════════════════════════════════════════
// CHAPTER LIST  (view-study-chapters)
// GET /api/study/chapters/<subject>/<class_level> → bare array.
// ════════════════════════════════════════════════════════════════
async function loadStudyChapters(subject, classLevel) {
    studyState.subject = subject;
    studyState.classLevel = Number(classLevel) || studyState.classLevel;
    const container = document.getElementById('study-chapters-content');
    container.innerHTML = `<div class="m-picker-wrap">
        <div class="loading-spinner"><div class="spinner"></div> Loading chapters...</div></div>`;
    try {
        const chapters = await apiCall(`/api/study/chapters/${subject}/${studyState.classLevel}`);
        studyState.chapters = Array.isArray(chapters) ? chapters : [];

        // Cache the chapter total (frontend only) so the landing can show
        // "x of y opened" without a second API call.
        try {
            const counts = studyCountMap();
            counts[`${subject}_${studyState.classLevel}`] = studyState.chapters.length;
            localStorage.setItem('NAADI_STUDY_COUNT', JSON.stringify(counts));
        } catch (_) { }

        const prog = studyProgMap();

        const rows = studyState.chapters.map((ch, idx) => {
            const e = prog[ch.chapter_id];
            const pct = studyPct(e);
            const done = e && pct >= 100;
            let status = '';
            if (done) status = `<span class="sm-ch-chip done"><i class="fa-solid fa-circle-check"></i> Read</span>`;
            else if (e) status = `<span class="sm-ch-chip live"><i class="fa-solid fa-book-open-reader"></i> p.${e.page}</span>`;
            const pages = ch.page_count ? `<span class="sm-ch-chip"><i class="fa-solid fa-file-lines"></i> ${ch.page_count} pages</span>` : '';
            // Highlight / bookmark counts render only once the backend
            // supplies them on the chapter object (kept for later — no fakes).
            const hl = (ch.highlight_count != null) ? `<span class="sm-ch-chip"><i class="fa-solid fa-highlighter"></i> ${ch.highlight_count}</span>` : '';
            const bm = (ch.bookmark_count != null) ? `<span class="sm-ch-chip"><i class="fa-solid fa-bookmark"></i> ${ch.bookmark_count}</span>` : '';
            const delay = `animation-delay:${(0.04 + Math.min(idx, 8) * 0.05).toFixed(2)}s;`;
            return `<div class="sm-ch-row ${done ? 'done' : ''}" style="${delay}" onclick="studyOpenChapter(${idx})">
                <div class="sm-ch-num">${done ? '<i class="fa-solid fa-check"></i>' : (ch.chapter_number || idx + 1)}</div>
                <div class="sm-ch-info">
                    <h4>${escapeHtml(ch.chapter_title || 'Untitled chapter')}</h4>
                    <div class="sm-ch-meta">${status}${pages}${hl}${bm}</div>
                    ${(e && !done) ? `<div class="sm-ch-prog"><i style="width:${pct}%"></i></div>` : ''}
                </div>
                <i class="fa-solid fa-chevron-right sm-ch-chev"></i>
            </div>`;
        }).join('');

        // Featured "Continue" card — most-recent in-progress chapter in
        // THIS subject + class. Kept on the app's standard blue template.
        let continueHtml = '';
        const mine = Object.keys(prog).map(id => Object.assign({ chapter_id: id }, prog[id]))
            .filter(e => e.subject === subject && Number(e.class_level) === studyState.classLevel && studyPct(e) < 100 && e.pdf_url)
            .sort((a, b) => (b.ts || 0) - (a.ts || 0));
        if (mine.length) {
            const e = mine[0];
            continueHtml = `<div class="sm-continue" onclick="resumeStudy('${String(e.chapter_id).replace(/'/g, "\\'")}')">
                <div class="sm-continue-ico"><i class="fa-solid fa-book-open"></i></div>
                <div class="sm-continue-body">
                    <span class="sm-continue-k">Continue</span>
                    <span class="sm-continue-t">Ch ${e.chapter_number || '—'} · ${escapeHtml(e.title || 'Chapter')}</span>
                    <div class="sm-continue-bar"><i style="width:${studyPct(e)}%"></i></div>
                    <span class="sm-continue-pg">Resume at page ${e.page} of ${e.numPages || '—'}</span>
                </div>
                <div class="sm-continue-go"><i class="fa-solid fa-play"></i></div>
            </div>`;
        }

        const opened = Object.values(prog).filter(x => x.subject === subject && Number(x.class_level) === studyState.classLevel).length;

        container.innerHTML = `<div class="m-picker-wrap sm-chapters">
            <div class="sm-ch-head">
                <button class="sm-back-btn" onclick="navigate('study-material')" aria-label="Back to subjects">
                    <i class="fa-solid fa-arrow-left"></i></button>
                <div class="sm-ch-head-t" style="min-width:0;">
                    <h2><i class="fa-solid fa-book-open"></i> ${escapeHtml(subject)} — Class ${studyState.classLevel}</h2>
                    <p>${studyState.chapters.length} chapter${studyState.chapters.length !== 1 ? 's' : ''}${opened ? ` · ${opened} opened` : ''}</p>
                </div>
            </div>
            ${studyState.chapters.length === 0
                ? `<div class="empty-state"><i class="fa-solid fa-file-pdf"></i>
                    <h3>No chapters uploaded yet</h3>
                    <p style="margin-top:8px;color:var(--s500);">Class ${studyState.classLevel} ${escapeHtml(subject)} PDFs will appear here once uploaded.</p></div>`
                : `${continueHtml}<div class="sm-sec-label">All chapters</div><div class="sm-ch-list">${rows}</div>`}
        </div>`;
    } catch (e) {
        container.innerHTML = `<div class="m-picker-wrap">
            <button class="btn btn-outline btn-sm" style="margin-bottom:16px;min-height:44px;" onclick="navigate('study-material')">
                <i class="fa-solid fa-arrow-left"></i> Back</button>
            <div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i>
            <h3>Could not load chapters</h3><p style="margin-top:8px;color:var(--s500);">${escapeHtml(e.message)}</p></div></div>`;
    }
}

function studyOpenChapter(idx) {
    const ch = studyState.chapters[idx];
    if (!ch || !ch.pdf_url) { ndToast('This chapter has no PDF attached yet.', 'warning'); return; }
    navigate('pdf-reader', { chapter: ch });
}

// ════════════════════════════════════════════════════════════════
// FRACTIONAL COORDINATE HELPERS — pure, unit-tested.
// Highlights persist as 0–1 fractions of the page canvas so they
// redraw correctly at ANY zoom level (rule 4 — never pixels).
// ════════════════════════════════════════════════════════════════
function convertClientRectsToFractional(clientRects, canvasRect) {
    const out = [];
    const cw = canvasRect.width, chh = canvasRect.height;
    if (!cw || !chh) return out;
    for (const r of clientRects) {
        // Clip to the canvas, then normalise.
        const left = Math.max(r.left, canvasRect.left);
        const top = Math.max(r.top, canvasRect.top);
        const right = Math.min(r.right, canvasRect.right);
        const bottom = Math.min(r.bottom, canvasRect.bottom);
        const w = right - left, h = bottom - top;
        if (w <= 1 || h <= 1) continue; // outside the page / zero-size
        out.push({
            x: +((left - canvasRect.left) / cw).toFixed(5),
            y: +((top - canvasRect.top) / chh).toFixed(5),
            w: +(w / cw).toFixed(5),
            h: +(h / chh).toFixed(5),
        });
    }
    return out;
}

function buildHighlightAddPayload(chapterId, highlight) {
    // Exact wire contract for POST /api/study/highlights (action:add).
    return {
        chapter_id: chapterId,
        action: 'add',
        highlight: {
            highlight_id: highlight.highlight_id,
            page: highlight.page,
            color: highlight.color,
            text: highlight.text,
            rects: highlight.rects,
            isFractional: true,
            scale: highlight.scale,
        },
    };
}

function newHighlightId() {
    return `hl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ════════════════════════════════════════════════════════════════
// PDF READER  (view-pdf-reader) — focused full-screen mode.
// ════════════════════════════════════════════════════════════════
async function openPdfReader(chapter) {
    const container = document.getElementById('pdf-reader-content');
    if (!chapter || !chapter.pdf_url) {
        container.innerHTML = readerErrorHtml('No PDF found for this chapter.');
        return;
    }
    // Opening a chapter to read earns the study day (once per IST day).
    if (typeof pingStreak === 'function') pingStreak('study_read');

    // Reset reader state
    closePdfDoc();
    studyState.chapter = chapter;
    studyState.page = 1;
    studyState.zoom = 1;
    studyState.bookmarks = new Set();
    studyState.highlights = [];
    studyState.sourceNotes = [];
    studyState._open = true;

    container.innerHTML = `<div class="loading-spinner" style="padding:calc(80px + var(--safe-top)) 20px;">
        <div class="spinner"></div> Opening ${escapeHtml(chapter.chapter_title || 'chapter')}...</div>`;

    try {
        // 1. PDF.js (lazy, once) — pure JS, works in the Capacitor WebView.
        await loadScriptOnce(PDFJS_URL);
        if (!window.pdfjsLib) throw new Error('PDF library failed to load (check internet).');
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;

        // 2. Document + persisted user data, in parallel.
        studyState.loadingTask = window.pdfjsLib.getDocument({ url: chapter.pdf_url });
        const [pdfDoc, bmRes, hlRes] = await Promise.all([
            studyState.loadingTask.promise,
            apiCall(`/api/study/bookmarks/${chapter.chapter_id}`).catch(() => ({ bookmarks: [] })),
            apiCall(`/api/study/highlights/${chapter.chapter_id}`).catch(() => ({ highlights: [] })),
        ]);
        if (!studyState._open) { try { pdfDoc.destroy(); } catch (_) { } return; } // user exited while loading
        studyState.pdfDoc = pdfDoc;
        studyState.numPages = pdfDoc.numPages;
        studyState.bookmarks = new Set((bmRes.bookmarks || []).map(b => b.page));
        studyState.highlights = hlRes.highlights || [];
        refreshReaderNotes(); // sidebar Notes tab data, in the background

        // Resume where the reader left off last time (localStorage — no
        // backend). Falls back to page 1 for a first-ever open.
        const _saved = studyProgMap()[chapter.chapter_id];
        studyState.page = (_saved && _saved.page)
            ? Math.min(Math.max(1, _saved.page), studyState.numPages) : 1;

        renderReaderShell(container);
        applyReadingMode(studyState.mode);
        bindReaderSelection();
        bindReaderSwipe();
        bindReaderPinch();
        await renderPdfPage(studyState.page);
    } catch (e) {
        container.innerHTML = readerErrorHtml(e.message);
    }
}

function readerErrorHtml(msg) {
    return `<div style="padding:calc(20px + var(--safe-top)) 16px;">
        <button class="btn btn-outline btn-sm" style="margin-bottom:16px;min-height:44px;" onclick="exitPdfReader()">
            <i class="fa-solid fa-arrow-left"></i> Back</button>
        <div class="empty-state"><i class="fa-solid fa-file-circle-exclamation"></i>
        <h3>Could not open PDF</h3><p style="margin-top:8px;color:var(--s500);">${escapeHtml(msg)}</p></div></div>`;
}

async function refreshReaderNotes() {
    const ch = studyState.chapter;
    if (!ch) return;
    try {
        const [notesRes, notebooks] = await Promise.all([
            apiCall(`/api/notes/by-source/${ch.chapter_id}`),
            fetchNotebooks().catch(() => []),
        ]);
        studyState.sourceNotes = notesRes.notes || [];
        studyState.notebookNames = {};
        (notebooks || []).forEach(nb => { studyState.notebookNames[nb.notebook_id] = nb.title; });
        // If the sidebar Notes tab is open, live-refresh it.
        const body = document.getElementById('pdfm-sb-body');
        if (body && body.dataset.tab === 'notes') renderSidebarTab('notes');
    } catch (_) { /* sidebar data is non-critical */ }
}

// ── Shell: sticky top bar · stage · bottom toolbar · overlays ──
function renderReaderShell(container) {
    const ch = studyState.chapter;
    container.innerHTML = `
    <div class="pdfm-wrap" id="pdfm-wrap">
        <div class="pdfm-topbar">
            <button class="te-icon-btn" onclick="exitPdfReader()" aria-label="Close reader">
                <i class="fa-solid fa-arrow-left"></i></button>
            <div class="pdfm-title">
                <b>${escapeHtml(ch.chapter_title || 'Chapter')}</b>
                <span>${escapeHtml(ch.subject || '')} · Class ${escapeHtml(String(ch.class_level || ''))}</span>
            </div>
            <button class="te-icon-btn" id="pdfm-mode-btn" onclick="cycleReadingMode()" aria-label="Reading mode">
                <i class="fa-solid fa-circle-half-stroke"></i></button>
            <button class="te-icon-btn" id="pdfm-bm-btn" onclick="toggleBookmark()" aria-label="Bookmark this page">
                <i class="fa-regular fa-bookmark"></i></button>
            <button class="te-icon-btn" onclick="openReaderSidebar('highlights')" aria-label="Highlights, bookmarks and notes">
                <i class="fa-solid fa-layer-group"></i></button>
        </div>

        <div class="pdfm-stage" id="pdfm-stage">
            <div class="pdfm-page-wrap" id="pdfm-page-wrap">
                <canvas id="pdfm-canvas"></canvas>
                <div class="pdfm-hl-layer" id="pdfm-hl-layer"></div>
                <div class="pdfm-text-layer" id="pdfm-text-layer"></div>
            </div>
        </div>

        <!-- Selection action bar: appears on text selection (debounced on
             selectionchange so it doesn't fight Android's own selection
             handles — it sits above the toolbar, away from the OS bubble).
             Offers Highlight colours, Note (→ composer, prefilled) and Copy. -->
        <div class="pdfm-hl-bar" id="pdfm-hl-bar">
            ${Object.keys(HIGHLIGHT_COLORS).map(c =>
        `<button class="pdfm-hl-swatch" style="background:${HIGHLIGHT_COLORS[c]};"
                    onclick="saveSelectionHighlight('${c}')" aria-label="Highlight ${c}"></button>`).join('')}
            <span class="pdfm-hl-bar-div"></span>
            <button class="pdfm-hl-act" onclick="readerAddNote()"><i class="fa-solid fa-note-sticky"></i> Note</button>
            <button class="pdfm-hl-act icon" onclick="readerCopySelection()" aria-label="Copy text"><i class="fa-solid fa-copy"></i></button>
            <button class="pdfm-hl-bar-close" onclick="hideHighlightBar(true)" aria-label="Dismiss">
                <i class="fa-solid fa-xmark"></i></button>
        </div>

        <div class="pdfm-toolbar">
            <div class="pdfm-tb-group">
                <button class="te-nav-btn" id="pdfm-prev" onclick="readerGo(-1)" aria-label="Previous page">
                    <i class="fa-solid fa-chevron-left"></i></button>
                <button class="pdfm-pageind" id="pdfm-pageind" onclick="openGotoSheet()">1 / ${studyState.numPages}</button>
                <button class="te-nav-btn" id="pdfm-next" onclick="readerGo(1)" aria-label="Next page">
                    <i class="fa-solid fa-chevron-right"></i></button>
            </div>
            <div class="pdfm-tb-group">
                <button class="te-nav-btn" onclick="readerZoom(-1)" aria-label="Zoom out"><i class="fa-solid fa-magnifying-glass-minus"></i></button>
                <button class="te-nav-btn" onclick="readerZoom(1)" aria-label="Zoom in"><i class="fa-solid fa-magnifying-glass-plus"></i></button>
                <button class="pdfm-note-btn" onclick="readerAddNote()" aria-label="Add note"><i class="fa-solid fa-note-sticky"></i><span>Note</span></button>
            </div>
        </div>

        <!-- Sidebar drawer: Highlights / Bookmarks / Notes -->
        <div class="pdfm-sidebar-overlay" id="pdfm-sb-overlay" onclick="closeReaderSidebar(event)">
            <div class="pdfm-sidebar" onclick="event.stopPropagation()">
                <div class="pdfm-sb-tabs">
                    <button data-tab="highlights" onclick="renderSidebarTab('highlights')"><i class="fa-solid fa-highlighter"></i> Highlights</button>
                    <button data-tab="bookmarks" onclick="renderSidebarTab('bookmarks')"><i class="fa-solid fa-bookmark"></i> Bookmarks</button>
                    <button data-tab="notes" onclick="renderSidebarTab('notes')"><i class="fa-solid fa-note-sticky"></i> Notes</button>
                </div>
                <div class="pdfm-sb-body" id="pdfm-sb-body"></div>
            </div>
        </div>
    </div>`;
}

// ── Page rendering (canvas + text layer + highlight overlay) ─────
async function renderPdfPage(pageNum) {
    if (!studyState.pdfDoc) return;
    pageNum = Math.min(Math.max(1, pageNum), studyState.numPages);
    if (studyState._rendering) { studyState._pendingPage = pageNum; return; }
    studyState._rendering = true;
    studyState.page = pageNum;

    try {
        const page = await studyState.pdfDoc.getPage(pageNum);
        const stage = document.getElementById('pdfm-stage');
        const canvas = document.getElementById('pdfm-canvas');
        const textLayer = document.getElementById('pdfm-text-layer');
        if (!stage || !canvas || !textLayer) { studyState._rendering = false; return; }

        // Fit-width base scale × user zoom.
        const baseVp = page.getViewport({ scale: 1 });
        const avail = stage.clientWidth - 16; // stage padding
        const scale = (avail / baseVp.width) * studyState.zoom;
        studyState.lastScale = scale;
        const vp = page.getViewport({ scale });

        // HiDPI canvas
        const outputScale = window.devicePixelRatio || 1;
        canvas.width = Math.floor(vp.width * outputScale);
        canvas.height = Math.floor(vp.height * outputScale);
        canvas.style.width = Math.floor(vp.width) + 'px';
        canvas.style.height = Math.floor(vp.height) + 'px';

        if (studyState._renderTask) { try { studyState._renderTask.cancel(); } catch (_) { } }
        studyState._renderTask = page.render({
            canvasContext: canvas.getContext('2d'),
            viewport: vp,
            transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
        });
        await studyState._renderTask.promise;

        // Text layer (for long-press selection → highlights)
        textLayer.innerHTML = '';
        textLayer.style.width = Math.floor(vp.width) + 'px';
        textLayer.style.height = Math.floor(vp.height) + 'px';
        textLayer.style.setProperty('--scale-factor', String(vp.scale));
        try {
            const textContent = await page.getTextContent();
            await window.pdfjsLib.renderTextLayer({
                textContentSource: textContent,
                textContent: textContent, // legacy param name — harmless dual-pass
                container: textLayer,
                viewport: vp,
                textDivs: [],
            }).promise;
        } catch (_) { /* scanned page with no text layer — highlighting unavailable there */ }

        drawPageHighlights();
        updateReaderChrome();
        saveStudyProgress(); // remember page (localStorage — no backend)
    } catch (e) {
        if (!(e && e.name === 'RenderingCancelledException')) {
            ndToast('Could not render page: ' + (e.message || e), 'error');
        }
    }
    studyState._rendering = false;
    if (studyState._pendingPage && studyState._pendingPage !== studyState.page) {
        const p = studyState._pendingPage;
        studyState._pendingPage = null;
        renderPdfPage(p);
    } else {
        studyState._pendingPage = null;
    }
}

function updateReaderChrome() {
    const ind = document.getElementById('pdfm-pageind');
    if (ind) ind.textContent = `${studyState.page} / ${studyState.numPages}`;
    const prev = document.getElementById('pdfm-prev');
    const next = document.getElementById('pdfm-next');
    if (prev) prev.disabled = studyState.page <= 1;
    if (next) next.disabled = studyState.page >= studyState.numPages;
    const bm = document.getElementById('pdfm-bm-btn');
    if (bm) {
        const on = studyState.bookmarks.has(studyState.page);
        bm.innerHTML = `<i class="fa-${on ? 'solid' : 'regular'} fa-bookmark"></i>`;
        bm.classList.toggle('on', on);
    }
}

async function readerGo(dir) {
    hideHighlightBar(true);
    const next = studyState.page + dir;
    if (next < 1 || next > studyState.numPages) return; // no anim at the ends
    await renderPdfPage(next);
    const stage = document.getElementById('pdfm-stage');
    if (stage) stage.scrollTo({ top: 0 });
    // Directional page-turn: fade + slight slide of the freshly rendered page.
    const wrap = document.getElementById('pdfm-page-wrap');
    if (wrap && studyState.zoom <= 1.01) { // skip while zoomed (page pans)
        wrap.classList.remove('pg-in-fwd', 'pg-in-back');
        void wrap.offsetWidth; // reflow so the animation restarts
        wrap.classList.add(dir > 0 ? 'pg-in-fwd' : 'pg-in-back');
    }
}

function readerZoom(dir) {
    const steps = [0.75, 1, 1.25, 1.5, 2, 2.5, 3];
    let i = steps.findIndex(s => Math.abs(s - studyState.zoom) < 0.01);
    if (i === -1) i = 1;
    i = Math.min(Math.max(0, i + dir), steps.length - 1);
    if (steps[i] === studyState.zoom) return;
    studyState.zoom = steps[i];
    ndToast(`Zoom ${Math.round(studyState.zoom * 100)}%`, 'info', 900);
    renderPdfPage(studyState.page); // highlights redraw from fractions — zoom-safe
}

function openGotoSheet() {
    phOpenSheet(`
        <div class="ph-sheet-handle"></div>
        <h3 class="ph-sheet-title"><i class="fa-solid fa-file-lines"></i> Go to page</h3>
        <input type="number" class="nb-input" id="pdfm-goto-input" min="1" max="${studyState.numPages}"
            value="${studyState.page}" style="text-align:center;font-size:1.1rem;">
        <button class="btn ph-start-btn" style="margin-top:14px;"
            onclick="const v=parseInt(document.getElementById('pdfm-goto-input').value)||1;phCloseSheet();renderPdfPage(v);">
            <i class="fa-solid fa-arrow-right"></i> Go</button>
    `);
}

// ── Swipe navigation (Concept Studio gesture rules; suppressed when
//    zoomed in — a zoomed page pans horizontally — while text is
//    selected, or when a two-finger pinch is in progress) ────────────
function bindReaderSwipe() {
    const stage = document.getElementById('pdfm-stage');
    if (!stage || stage._swipeBound) return;
    stage._swipeBound = true;
    let x0 = 0, y0 = 0, t0 = 0;
    stage.addEventListener('touchstart', (e) => {
        if (e.touches.length > 1) { stage._multiTouch = true; return; } // pinch, not swipe
        const t = e.touches[0];
        x0 = t.clientX; y0 = t.clientY; t0 = Date.now();
    }, { passive: true });
    stage.addEventListener('touchend', (e) => {
        if (stage._multiTouch) { if (e.touches.length === 0) stage._multiTouch = false; return; }
        const t = e.changedTouches[0];
        const dx = t.clientX - x0, dy = t.clientY - y0, dt = Date.now() - t0;
        if (dt < 600 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6) {
            if (studyState.zoom > 1.01) return;                      // panning, not paging
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed) return;                     // mid-selection
            if (e.target.closest('.pdfm-sidebar, .ph-sheet')) return;
            if (dx < 0) readerGo(1); else readerGo(-1);
        }
    }, { passive: true });
}

// ── Pinch-to-zoom (focal point) ────────────────────────────────────
// Two-finger pinch scales the page live via a CSS transform anchored at
// the midpoint BETWEEN the fingers (transform-origin follows the pinch),
// so it grows from wherever you pinch. On release we commit the new zoom,
// re-render crisply, then adjust the scroll so the exact point you were
// pinching stays under your fingers — like a native reader. Highlights
// survive because they're stored as fractions, redrawn at the new zoom.
function bindReaderPinch() {
    const stage = document.getElementById('pdfm-stage');
    const wrap = document.getElementById('pdfm-page-wrap');
    if (!stage || !wrap || stage._pinchBound) return;
    stage._pinchBound = true;
    let startDist = 0, startZoom = 1, ratio = 1, pinching = false;
    let midX = 0, midY = 0; // last pinch midpoint, in client coords
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

    stage.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 2) return;
        pinching = true;
        startDist = dist(e.touches) || 1;
        startZoom = studyState.zoom;
        ratio = 1;
        const m = mid(e.touches); midX = m.x; midY = m.y;
        hideHighlightBar(true);
    }, { passive: true });

    stage.addEventListener('touchmove', (e) => {
        if (!pinching || e.touches.length !== 2) return;
        e.preventDefault(); // stop the WebView pinch-zooming the whole UI
        ratio = Math.min(Math.max(dist(e.touches) / startDist, 0.4), 5);
        const m = mid(e.touches); midX = m.x; midY = m.y;
        // Anchor the visual scale at the pinch point (relative to page-wrap).
        const wr = wrap.getBoundingClientRect();
        wrap.style.transformOrigin = `${midX - wr.left}px ${midY - wr.top}px`;
        wrap.style.transform = `scale(${ratio})`;
    }, { passive: false });

    const commit = async () => {
        if (!pinching) return;
        pinching = false;

        // Focal point as a FRACTION of the canvas (scale-invariant), plus
        // its position inside the stage viewport — captured before re-render.
        const canvas = document.getElementById('pdfm-canvas');
        wrap.style.transform = '';
        wrap.style.transformOrigin = '';
        let z = +(startZoom * ratio).toFixed(3);
        z = Math.min(Math.max(0.75, z), 4); // clamp 75%–400%
        if (!canvas || Math.abs(z - studyState.zoom) <= 0.02) return;

        const cr = canvas.getBoundingClientRect();
        const sr = stage.getBoundingClientRect();
        const fxr = Math.min(Math.max((midX - cr.left) / (cr.width || 1), 0), 1);
        const fyr = Math.min(Math.max((midY - cr.top) / (cr.height || 1), 0), 1);
        const fvx = midX - sr.left; // focal offset within the viewport
        const fvy = midY - sr.top;

        studyState.zoom = z;
        ndToast(`Zoom ${Math.round(z * 100)}%`, 'info', 800);
        await renderPdfPage(studyState.page); // crisp re-render at new zoom

        // Re-anchor: put the same canvas fraction back under the fingers.
        const c2 = document.getElementById('pdfm-canvas');
        if (!c2) return;
        const cr2 = c2.getBoundingClientRect();
        const sr2 = stage.getBoundingClientRect();
        const contentLeft = stage.scrollLeft + (cr2.left - sr2.left);
        const contentTop = stage.scrollTop + (cr2.top - sr2.top);
        stage.scrollLeft = Math.max(0, contentLeft + fxr * cr2.width - fvx);
        stage.scrollTop = Math.max(0, contentTop + fyr * cr2.height - fvy);
    };
    stage.addEventListener('touchend', commit, { passive: true });
    stage.addEventListener('touchcancel', commit, { passive: true });
}

// ════════════════════════════════════════════════════════════════
// BOOKMARKS — POST /api/study/bookmarks { chapter_id, page, action }
// ════════════════════════════════════════════════════════════════
async function toggleBookmark() {
    const ch = studyState.chapter;
    const page = studyState.page;
    const isOn = studyState.bookmarks.has(page);
    try {
        const res = await apiCall('/api/study/bookmarks', 'POST', {
            chapter_id: ch.chapter_id,
            page: page,
            action: isOn ? 'remove' : 'add',
        });
        studyState.bookmarks = new Set((res.bookmarks || []).map(b => b.page));
        updateReaderChrome();
        ndToast(isOn ? 'Bookmark removed' : `Page ${page} bookmarked ✓`, 'success', 1400);
    } catch (e) {
        ndToast('Bookmark failed: ' + e.message, 'error');
    }
}

// ════════════════════════════════════════════════════════════════
// HIGHLIGHTS
// Selection flow: Android long-press selects text in the PDF.js text
// layer → we listen to `selectionchange` with a short debounce (so
// the color bar appears only once the OS handles settle) and show a
// compact color bar pinned ABOVE the bottom toolbar — deliberately
// away from Android's own floating copy/paste bubble so the two
// never overlap. Tap-away / page-turn dismisses it.
// ════════════════════════════════════════════════════════════════
function bindReaderSelection() {
    unbindReaderSelection();
    studyState._selHandler = () => {
        clearTimeout(studyState._selDebounce);
        studyState._selDebounce = setTimeout(() => {
            if (!studyState._open) return;
            const sel = window.getSelection();
            const bar = document.getElementById('pdfm-hl-bar');
            if (!bar) return;
            const inLayer = sel && !sel.isCollapsed && sel.rangeCount > 0 &&
                !!(sel.anchorNode && (sel.anchorNode.parentElement || sel.anchorNode).closest?.('.pdfm-text-layer'));
            bar.classList.toggle('visible', !!inLayer);
        }, 350);
    };
    document.addEventListener('selectionchange', studyState._selHandler);
}
function unbindReaderSelection() {
    if (studyState._selHandler) {
        document.removeEventListener('selectionchange', studyState._selHandler);
        studyState._selHandler = null;
    }
    clearTimeout(studyState._selDebounce);
}

function hideHighlightBar(clearSelection) {
    const bar = document.getElementById('pdfm-hl-bar');
    if (bar) bar.classList.remove('visible');
    if (clearSelection) { try { window.getSelection().removeAllRanges(); } catch (_) { } }
}

async function saveSelectionHighlight(color) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        ndToast('Select some text first (long-press the page).', 'warning');
        return;
    }
    const canvas = document.getElementById('pdfm-canvas');
    if (!canvas) return;
    const range = sel.getRangeAt(0);
    const rects = convertClientRectsToFractional(
        Array.from(range.getClientRects()), canvas.getBoundingClientRect());
    if (rects.length === 0) {
        ndToast("Couldn't map that selection to the page — try selecting again.", 'warning');
        return;
    }
    const highlight = {
        highlight_id: newHighlightId(),
        page: studyState.page,
        color: color,
        text: sel.toString().slice(0, 500),
        rects: rects,
        scale: studyState.lastScale,
    };
    try {
        await apiCall('/api/study/highlights', 'POST',
            buildHighlightAddPayload(studyState.chapter.chapter_id, highlight));
        studyState.highlights.push(Object.assign({ isFractional: true }, highlight));
        hideHighlightBar(true);
        drawPageHighlights();
        ndToast('Highlighted ✓', 'success', 1200);
    } catch (e) {
        ndToast('Could not save highlight: ' + e.message, 'error');
    }
}

// Redraw saved highlights for the current page from their FRACTIONAL
// rects — multiply by the canvas's current CSS size, so any zoom
// level renders them in the right place.
function drawPageHighlights() {
    const layer = document.getElementById('pdfm-hl-layer');
    const canvas = document.getElementById('pdfm-canvas');
    if (!layer || !canvas) return;
    const cw = parseFloat(canvas.style.width) || canvas.clientWidth;
    const chh = parseFloat(canvas.style.height) || canvas.clientHeight;
    layer.style.width = cw + 'px';
    layer.style.height = chh + 'px';

    const pageHls = studyState.highlights.filter(h => h.page === studyState.page);
    layer.innerHTML = pageHls.map(h => {
        const hid = String(h.highlight_id).replace(/'/g, "\\'");
        return (h.rects || []).map(r => {
            if (!h.isFractional) return ''; // legacy pixel data can't be trusted across zooms
            return `<div class="pdfm-hl-rect" style="left:${r.x * cw}px;top:${r.y * chh}px;width:${r.w * cw}px;height:${r.h * chh}px;background:${highlightHex(h.color)};"
                onclick="offerHighlightDelete('${hid}')"></div>`;
        }).join('');
    }).join('');
}

function offerHighlightDelete(highlightId) {
    const h = studyState.highlights.find(x => x.highlight_id === highlightId);
    if (!h) return;
    const hid = String(highlightId).replace(/'/g, "\\'");
    phOpenSheet(`
        <div class="ph-sheet-handle"></div>
        <h3 class="ph-sheet-title"><span class="pdfm-hl-dot" style="background:${highlightHex(h.color)};"></span> Highlight · page ${h.page}</h3>
        <p class="ph-sheet-sub">"${escapeHtml((h.text || '').slice(0, 160))}${(h.text || '').length > 160 ? '…' : ''}"</p>
        <div style="display:flex;gap:10px;margin-top:14px;">
            <button class="btn btn-outline" style="flex:1;min-height:48px;" onclick="phCloseSheet()">Keep</button>
            <button class="btn ph-start-btn danger" style="flex:1;margin-top:0;" onclick="deleteHighlight('${hid}')">
                <i class="fa-solid fa-trash"></i> Remove</button>
        </div>
    `);
}

async function deleteHighlight(highlightId) {
    try {
        await apiCall('/api/study/highlights', 'POST', {
            chapter_id: studyState.chapter.chapter_id,
            action: 'remove',
            highlight_id: highlightId,
        });
        studyState.highlights = studyState.highlights.filter(h => h.highlight_id !== highlightId);
        phCloseSheet();
        drawPageHighlights();
        const body = document.getElementById('pdfm-sb-body');
        if (body && body.dataset.tab === 'highlights') renderSidebarTab('highlights');
        ndToast('Highlight removed.', 'success', 1200);
    } catch (e) {
        ndToast('Could not remove highlight: ' + e.message, 'error');
    }
}

// ════════════════════════════════════════════════════════════════
// ADD NOTE (from the reader) — shared composer, source fields set.
// User picks an existing notebook (or creates one first); no
// auto-create-per-chapter (rule 3).
// ════════════════════════════════════════════════════════════════
function readerAddNote() {
    const sel = window.getSelection();
    const prefill = (sel && !sel.isCollapsed) ? sel.toString().slice(0, 800) : '';
    hideHighlightBar(true);
    openNoteComposer({
        sourceChapter: studyState.chapter.chapter_id,
        sourcePage: studyState.page,
        prefill: prefill,
        onSaved: () => refreshReaderNotes(),
    });
}

// Copy the selected text to the clipboard (with a legacy fallback for
// older WebViews that lack the async clipboard API).
function readerCopySelection() {
    const sel = window.getSelection();
    const text = sel ? sel.toString() : '';
    if (!text) { ndToast('Select some text first.', 'warning'); return; }
    const done = () => { hideHighlightBar(true); ndToast('Copied ✓', 'success', 1200); };
    const fallback = () => {
        try {
            const ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            document.execCommand('copy'); document.body.removeChild(ta); done();
        } catch (_) { ndToast('Could not copy on this device.', 'error'); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else { fallback(); }
}

// ════════════════════════════════════════════════════════════════
// SIDEBAR — Highlights / Bookmarks / Notes
// ════════════════════════════════════════════════════════════════
function openReaderSidebar(tab) {
    const ov = document.getElementById('pdfm-sb-overlay');
    if (!ov) return;
    ov.classList.add('open');
    renderSidebarTab(tab || 'highlights');
}
function closeReaderSidebar(e) {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById('pdfm-sb-overlay')?.classList.remove('open');
}
function sidebarJump(page) {
    document.getElementById('pdfm-sb-overlay')?.classList.remove('open');
    renderPdfPage(page);
}

function renderSidebarTab(tab) {
    const body = document.getElementById('pdfm-sb-body');
    if (!body) return;
    body.dataset.tab = tab;
    document.querySelectorAll('.pdfm-sb-tabs button').forEach(b =>
        b.classList.toggle('active', b.dataset.tab === tab));

    if (tab === 'highlights') {
        const hls = studyState.highlights.slice().sort((a, b) => (a.page || 0) - (b.page || 0));
        body.innerHTML = hls.length === 0
            ? `<div class="pdfm-sb-empty"><i class="fa-solid fa-highlighter"></i>
                Long-press text on a page, then pick a color to make your first highlight.</div>`
            : hls.map(h => {
                const hid = String(h.highlight_id).replace(/'/g, "\\'");
                return `<div class="pdfm-sb-row" onclick="sidebarJump(${h.page})">
                    <span class="pdfm-hl-dot" style="background:${highlightHex(h.color)};"></span>
                    <div style="flex:1;min-width:0;">
                        <p class="pdfm-sb-snippet">${escapeHtml((h.text || '').slice(0, 90))}${(h.text || '').length > 90 ? '…' : ''}</p>
                        <span class="pdfm-sb-meta">Page ${h.page}</span>
                    </div>
                    <button class="pdfm-sb-del" onclick="event.stopPropagation();offerHighlightDelete('${hid}')" aria-label="Delete highlight">
                        <i class="fa-solid fa-trash"></i></button>
                </div>`;
            }).join('');
    } else if (tab === 'bookmarks') {
        const pages = Array.from(studyState.bookmarks).sort((a, b) => a - b);
        body.innerHTML = pages.length === 0
            ? `<div class="pdfm-sb-empty"><i class="fa-solid fa-bookmark"></i>
                Tap the bookmark icon in the top bar to save the page you're reading.</div>`
            : pages.map(p => `<div class="pdfm-sb-row" onclick="sidebarJump(${p})">
                <i class="fa-solid fa-bookmark" style="color:var(--amber);flex-shrink:0;"></i>
                <div style="flex:1;"><p class="pdfm-sb-snippet">Page ${p}</p></div>
                <i class="fa-solid fa-chevron-right" style="color:var(--s300);"></i>
            </div>`).join('');
    } else if (tab === 'notes') {
        const notes = studyState.sourceNotes || [];
        body.innerHTML = notes.length === 0
            ? `<div class="pdfm-sb-empty"><i class="fa-solid fa-note-sticky"></i>
                Notes you save from this chapter (via the Note button) will appear here — and inside their notebook in Revision Notes.</div>`
            : notes.map(n => {
                const meta = NOTE_TAG_META[n.color_tag] || NOTE_TAG_META.general;
                const nbName = studyState.notebookNames[n.notebook_id] || 'Notebook';
                return `<div class="pdfm-sb-row" onclick="sidebarJump(${n.source_page || 1})">
                    <span class="pdfm-hl-dot" style="background:${meta.hex};"></span>
                    <div style="flex:1;min-width:0;">
                        <p class="pdfm-sb-snippet">${n.is_starred ? '<i class="fa-solid fa-star" style="color:var(--amber);font-size:.6rem;"></i> ' : ''}${escapeHtml((n.content || '').slice(0, 90))}${(n.content || '').length > 90 ? '…' : ''}</p>
                        <span class="pdfm-sb-meta"><i class="fa-solid fa-book" style="font-size:.58rem;"></i> ${escapeHtml(nbName)} · p.${n.source_page || '—'}</span>
                    </div>
                </div>`;
            }).join('');
    }
}

// ════════════════════════════════════════════════════════════════
// READING MODES — light / sepia / dark. Display-only preference,
// persisted per-device in localStorage (NAADI_READER_MODE).
// ════════════════════════════════════════════════════════════════
const READER_MODES = ['light', 'sepia', 'dark'];

function applyReadingMode(mode) {
    studyState.mode = READER_MODES.includes(mode) ? mode : 'light';
    localStorage.setItem('NAADI_READER_MODE', studyState.mode);
    const wrap = document.getElementById('pdfm-wrap');
    if (!wrap) return;
    wrap.classList.remove('mode-light', 'mode-sepia', 'mode-dark');
    wrap.classList.add('mode-' + studyState.mode);
}

function cycleReadingMode() {
    const next = READER_MODES[(READER_MODES.indexOf(studyState.mode) + 1) % READER_MODES.length];
    applyReadingMode(next);
    ndToast(`${next[0].toUpperCase() + next.slice(1)} mode`, 'info', 1000);
}

// ════════════════════════════════════════════════════════════════
// EXIT / CLEANUP
// ════════════════════════════════════════════════════════════════
function closePdfDoc() {
    studyState._open = false;
    unbindReaderSelection();
    if (studyState._renderTask) { try { studyState._renderTask.cancel(); } catch (_) { } studyState._renderTask = null; }
    if (studyState.loadingTask) { try { studyState.loadingTask.destroy(); } catch (_) { } studyState.loadingTask = null; }
    studyState.pdfDoc = null;
    studyState._rendering = false;
    studyState._pendingPage = null;
}

function exitPdfReader() {
    const ch = studyState.chapter || {};
    closePdfDoc();
    navigate('study-chapters', {
        subject: ch.subject || studyState.subject || 'Biology',
        class_level: ch.class_level || studyState.classLevel,
    });
}

console.log('Study Material (mobile) module loaded ✅');