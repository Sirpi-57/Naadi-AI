/* ════════════════════════════════════════════════════════════════
   NAADI AI — CONCEPT STUDIO v3 (mobile)  concept-studio.js
   ─────────────────────────────────────────────────────────────────
   v3 rework. Same journey, tightened:

     Picker (resume card + subjects)
       → Chapter list (sticky head · filter · search · resume)
       → Chapter home (THE SPINE — blocks as stations)
       → Block overview (THE SPINE — sections as stations)
       → Focused full-screen layers, each ending in a "Next: …" CTA
         so a block reads as a sequence, not a hub-and-spoke.

   What changed from v2 (frontend only — the backend is untouched):
     1.  Every layer has a footer CTA; layers swap in place.
     2.  "NAADI's briefing" is no longer a section (it duplicated six
         fields from Understand/Apply/Traps and spoiled the traps
         before the concept was taught). It is now a RECAP card at the
         bottom of the block — same content, reinforcement not repeat.
     3.  Section order: Understand → Visual → Apply → Traps →
         Flashcards → PYQ → Figures. NCERT pages demoted to a source
         link at the foot of Understand.
     4.  `visited` persists in localStorage — progress no longer lies.
     5.  Flashcards: "Review again" actually re-queues; hard cards
         first; swipe + haptics; "practise the ones you missed".
     6.  PYQ: real/variant divider, result card, honest correct-answer
         lookup via an index (not a scan of every pager in state).
     7.  Chapter home: the spine reaches up a level; the redundant
         hero collapses into the sticky head.
     8.  One nav grammar (.cs2-head) + skeletons instead of spinners.
     9.  Every tappable is a real <button> with a focus ring.
    10.  Chapter list: resume, filter, search, no wall of "0%".
    11.  Visual map: palette vars in the SVG, wrapped labels, no
         "Option A/B" placeholders, tap-to-focus.
    12.  Figures: pinch-zoom lightbox, sticky figure + synced labels.
    13.  Worked answers gated behind "try it first"; A–R answer
         resolution is defensive (hides the drill rather than guess).

   Requires concept-studio-v2.css (loaded after styles-mobile.css)
   and shared.js (apiCall, ndToast, safeHtml, escapeHtml).

   API contracts — IDENTICAL to v2, nothing on the backend changed:
     GET  /api/revision/subjects/<class>
     GET  /api/revision/chapters/<class>/<subject>
     GET  /api/revision/chapter/<id>/meta
     GET  /api/revision/progress/<id>
     GET  /api/revision/progress            (batch)
     GET  /api/revision/chapter/<id>/block/<bid>
     GET  /api/revision/chapter/<id>/flashcards/<bid>
     POST /api/revision/progress/update     (complete / flashcard_result)
   ════════════════════════════════════════════════════════════════ */

// ── STATE ─────────────────────────────────────────────────────────
const reviseState = {
    classLevel: 11,
    subject: null,
    chapters: [],
    chapterProgress: {},        // chapter_id -> progress doc
    currentChapterId: null,
    currentChapterName: null,
    chapterMeta: null,
    blockOrder: [],
    blockSummaries: {},
    blocksCompleted: new Set(),
    currentBlockIndex: 0,
    loadedBlocks: {},
    visited: {},                // blockId -> Set(sectionId), backed by localStorage
    _fcState: {},               // blockId -> {allCards, order, pos, flipped, results, requeued}
    arState: {},                // blockId -> {selected, submitted}
    qState: {},                 // item key -> {selected, submitted}
    qIndex: {},                 // item key -> {correct, kind}  ← no more pager scans
    pagers: {},                 // pagerKey -> {items, cur, render}
    chFilter: 'all',            // chapter-list filter
    chQuery: '',                // chapter-list search
    secOrder: [],               // current block's section ids, for the layer CTA
    curBlockId: null,
    curSecId: null,
    doneArmed: false,           // two-tap guard on "Mark done" with 0 sections read
};
let _csRingSeq = 0;

// ════════════════════════════════════════════════════════════════
// SMALL UTILITIES
// ════════════════════════════════════════════════════════════════

// Prefix relative backend URLs (figures / NCERT page images) with
// API_BASE so they load when the UI isn't served by the Flask server.
function absUrl(u) {
    if (!u) return '';
    if (/^https?:\/\//i.test(u) || u.startsWith('data:')) return u;
    return API_BASE + (u.startsWith('/') ? u : '/' + u);
}

function csSnippet(text, n) {
    if (!text) return '';
    const t = String(text).replace(/<[^>]*>/g, '').trim();
    return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

// One place to ask "should this animate?" — mirrors home.js's hmStill().
function csStill() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

// Haptics. Silent no-op where unsupported (all of iOS Safari, most desktop).
function csHaptic(ms) {
    try { if (navigator.vibrate && !csStill()) navigator.vibrate(ms || 8); } catch (_) { }
}

// Rough read-time estimate for a station's content, in whole minutes.
function csMins(chars) {
    // Dense study content, not prose: ~450 serialised chars ≈ a minute of
    // real reading. Calibrated so the numbers actually differ between
    // sections — a station list where everything says "1 min" is telling
    // the student nothing.
    return Math.max(1, Math.round(chars / 450));
}

function csTextLen(obj) {
    try { return JSON.stringify(obj || {}).length; } catch (_) { return 0; }
}

// ── skeletons (replaces every .loading-spinner in this module) ───
function csSkel(n, h, r) {
    let out = '';
    for (let i = 0; i < n; i++) {
        out += `<div class="cs2-skel" style="height:${h}px;border-radius:${r || 16}px;animation-delay:${i * 90}ms"></div>`;
    }
    return `<div class="cs2-skel-wrap">${out}</div>`;
}

function csErr(msg, retryFn) {
    return `<div class="cs2-empty">
        <i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i>
        ${escapeHtml(msg || 'Something went wrong')}
        ${retryFn ? `<div style="margin-top:16px;">
            <button type="button" class="cs2-ghost-btn" onclick="${retryFn}">
                <i class="fa-solid fa-rotate-right"></i> Retry</button></div>` : ''}
    </div>`;
}

// ════════════════════════════════════════════════════════════════
// VISITED — persisted so a returning student's progress is real
// ════════════════════════════════════════════════════════════════
const CS_VISIT_KEY = 'nd_cs_visited_v1';

function csVisitStore() {
    try { return JSON.parse(localStorage.getItem(CS_VISIT_KEY) || '{}') || {}; }
    catch (_) { return {}; }
}

function csVisitWrite(store) {
    try {
        // Keep the store from growing without bound: newest 40 chapters.
        const keys = Object.keys(store);
        if (keys.length > 40) keys.slice(0, keys.length - 40).forEach(k => delete store[k]);
        localStorage.setItem(CS_VISIT_KEY, JSON.stringify(store));
    } catch (_) { /* private mode / quota — visits simply stay session-level */ }
}

// Hydrate reviseState.visited for one chapter from localStorage.
function csVisitLoad(chapterId) {
    const store = csVisitStore();
    const forCh = store[chapterId] || {};
    const out = {};
    Object.keys(forCh).forEach(bid => { out[bid] = new Set(forCh[bid] || []); });
    return out;
}

function csVisitAdd(chapterId, blockId, secId) {
    if (!reviseState.visited[blockId]) reviseState.visited[blockId] = new Set();
    if (reviseState.visited[blockId].has(secId)) return;
    reviseState.visited[blockId].add(secId);
    const store = csVisitStore();
    if (!store[chapterId]) store[chapterId] = {};
    store[chapterId][blockId] = [...reviseState.visited[blockId]];
    csVisitWrite(store);
}

// How many sections a block has had opened — used on the chapter spine
// before the block is even fetched.
function csVisitCount(chapterId, blockId) {
    const s = (reviseState.visited && reviseState.visited[blockId])
        || (csVisitLoad(chapterId)[blockId]);
    return s ? s.size : 0;
}

// ════════════════════════════════════════════════════════════════
// PROGRESS RING — SVG gradient ring + animated count-up
// A 0% ring draws a dashed track and NO label: a subject list should
// not open with a column of twenty zeros.
// ════════════════════════════════════════════════════════════════
function csRingHTML(id, pct, size, stroke, showLabel) {
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    _csRingSeq++;
    const gid = `csg${_csRingSeq}`;
    const fs = Math.max(10, Math.round(size * 0.27));
    const empty = !(pct > 0);
    const wantLabel = showLabel !== false && !empty;
    const label = wantLabel ? `
        <div class="pct" style="font-size:${fs}px">
            ${pct >= 100
            ? '<i class="fa-solid fa-check done-ico" aria-hidden="true"></i>'
            : `<span class="num">0</span><span style="font-size:.6em;margin-left:1px;">%</span>`}
        </div>` : '';
    return `<div class="cs2-ring${empty ? ' empty' : ''}" id="${id}" data-pct="${pct}" data-c="${c}"
        style="width:${size}px;height:${size}px;" role="img"
        aria-label="${pct >= 100 ? 'Complete' : Math.round(pct) + ' percent complete'}">
        <svg width="${size}" height="${size}" aria-hidden="true">
            <defs><linearGradient id="${gid}" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#1f5896"/><stop offset="100%" stop-color="#0f6f8c"/>
            </linearGradient></defs>
            <circle class="track" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}" fill="none"/>
            <circle class="fill" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}" fill="none"
                stroke="url(#${gid})" stroke-dasharray="${c}" stroke-dashoffset="${c}"/>
        </svg>${label}</div>`;
}

function csAnimateRing(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const pct = Math.min(parseFloat(el.dataset.pct) || 0, 100);
    const c = parseFloat(el.dataset.c);
    const fill = el.querySelector('.fill');
    requestAnimationFrame(() => requestAnimationFrame(() => {
        if (fill) fill.style.strokeDashoffset = c * (1 - pct / 100);
    }));
    const num = el.querySelector('.num');
    if (num) csCountUp(num, Math.round(pct));
}

function csCountUp(el, target, dur) {
    dur = dur || 850;
    if (csStill()) { el.textContent = target; return; }
    const t0 = performance.now();
    function tick(t) {
        const p = Math.min((t - t0) / dur, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(target * eased);
        if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
}

// ════════════════════════════════════════════════════════════════
// RESUME — derived entirely from the batch progress endpoint, which
// already carries chapter_name + last_active. Zero extra calls.
// ════════════════════════════════════════════════════════════════
function csPickResume(progressMap, restrictIds) {
    const rows = Object.values(progressMap || {}).filter(p => {
        if (!p || !p.chapter_id || !p.chapter_name) return false;
        if (restrictIds && !restrictIds.has(p.chapter_id)) return false;
        const pct = p.completion_percentage || 0;
        return pct > 0 && pct < 100;
    });
    if (!rows.length) return null;
    rows.sort((a, b) => String(b.last_active || '').localeCompare(String(a.last_active || '')));
    return rows[0];
}

function csResumeCardHTML(p) {
    if (!p) return '';
    const pct = Math.round(p.completion_percentage || 0);
    const done = (p.blocks_completed || []).length;
    const total = p.total_blocks || 0;
    return `<button type="button" class="cs2-resume" id="cs2-resume-card"
        onclick="csResumeGo('${escapeHtml(p.chapter_id)}','${escapeHtml(p.chapter_name)}')">
        ${csRingHTML('cs2-resume-ring', pct, 44, 4.5)}
        <span class="rs-info">
            <span class="cs2-micro">Pick up where you left off</span>
            <span class="rs-name">${escapeHtml(p.chapter_name)}</span>
            <span class="rs-sub">${total ? `${done} of ${total} concepts done` : `${pct}% done`}</span>
        </span>
        <span class="rs-go"><i class="fa-solid fa-play" aria-hidden="true"></i></span>
    </button>`;
}

function csResumeGo(chapterId, chapterName) {
    csHaptic(10);
    navigate('revise-journey', { chapter_id: chapterId, chapter_name: chapterName });
}

// ════════════════════════════════════════════════════════════════
// PICKER — Class → Subject
// ════════════════════════════════════════════════════════════════
async function loadQuickRevise() {
    const container = document.getElementById('quick-revise-content');
    if (!container) return;
    container.innerHTML = `
        <div class="cs2-picker">
            <div class="cs2-picker-kicker">
                <span class="cs2-micro cs2-grad-text" style="-webkit-text-fill-color:initial;color:var(--indigo);">Block by block</span>
            </div>
            <h1>Concept Studio</h1>
            <p class="cs2-picker-sub" id="cs2-picker-sub">One concept at a time — with flashcards, real NEET questions and figure analysis woven in.</p>
            <div id="cs2-resume-slot"></div>
            <div class="cs2-seg" role="tablist" aria-label="Class">
                <button type="button" role="tab" aria-selected="${reviseState.classLevel === 11}"
                    class="${reviseState.classLevel === 11 ? 'active' : ''}" onclick="setReviseClass(11, this)">Class 11</button>
                <button type="button" role="tab" aria-selected="${reviseState.classLevel === 12}"
                    class="${reviseState.classLevel === 12 ? 'active' : ''}" onclick="setReviseClass(12, this)">Class 12</button>
            </div>
            <div id="revise-subjects-grid" class="cs2-subjects">${csSkel(3, 80)}</div>
        </div>`;
    loadReviseSubjects(reviseState.classLevel);
    csPaintResume();
}

// Fire-and-forget: the resume card is a bonus, never a blocker.
async function csPaintResume() {
    const slot = document.getElementById('cs2-resume-slot');
    if (!slot) return;
    try {
        const all = await apiCall('/api/revision/progress');
        reviseState.chapterProgress = all.progress || {};
        const p = csPickResume(reviseState.chapterProgress);
        if (!p || !document.getElementById('cs2-resume-slot')) return;
        slot.innerHTML = csResumeCardHTML(p);
        csAnimateRing('cs2-resume-ring');
        // With a live resume card the marketing subtitle has done its job.
        const sub = document.getElementById('cs2-picker-sub');
        if (sub) sub.remove();
    } catch (_) { /* endpoint absent or offline — the picker is fine without it */ }
}

function setReviseClass(cls, btn) {
    if (reviseState.classLevel === cls) return;
    reviseState.classLevel = cls;
    csHaptic(6);
    document.querySelectorAll('.cs2-seg button').forEach(b => {
        b.classList.remove('active'); b.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active'); btn.setAttribute('aria-selected', 'true');
    loadReviseSubjects(cls);
}

async function loadReviseSubjects(classLevel) {
    const grid = document.getElementById('revise-subjects-grid');
    if (!grid) return;
    grid.innerHTML = csSkel(3, 80);
    try {
        const data = await apiCall(`/api/revision/subjects/${classLevel}`);
        const subjects = data.subjects || [];
        const icons = { 'Biology': 'fa-dna', 'Physics': 'fa-atom', 'Chemistry': 'fa-flask-vial' };
        if (subjects.length === 0) {
            grid.innerHTML = `<div class="cs2-empty" style="grid-column:1/-1;"><i class="fa-solid fa-book-open" aria-hidden="true"></i>
                Class ${classLevel} revision material will appear here once uploaded.</div>`;
            return;
        }
        grid.innerHTML = subjects.map(s => `
            <button type="button" class="cs2-subject-card" onclick="loadReviseChapters('${escapeHtml(s.subject)}', ${classLevel})">
                <span class="cs2-subject-icon"><i class="fa-solid ${icons[s.subject] || 'fa-book-open'}" aria-hidden="true"></i></span>
                <span style="flex:1;min-width:0;text-align:left;">
                    <span class="sc-name">${escapeHtml(s.subject)}</span>
                    <span class="sc-meta">${s.total_chapters} chapter${s.total_chapters !== 1 ? 's' : ''}</span>
                </span>
                <i class="fa-solid fa-chevron-right" style="color:var(--s300);font-size:.8rem;" aria-hidden="true"></i>
            </button>`).join('');
    } catch (e) {
        grid.innerHTML = `<div style="grid-column:1/-1;">${csErr('Could not load subjects — ' + e.message, `loadReviseSubjects(${classLevel})`)}</div>`;
    }
}

// ════════════════════════════════════════════════════════════════
// CHAPTER LIST — sticky head · resume · filter · search
// ════════════════════════════════════════════════════════════════
async function loadReviseChapters(subject, classLevel) {
    reviseState.subject = subject;
    reviseState.classLevel = classLevel;
    reviseState.chFilter = 'all';
    reviseState.chQuery = '';
    const container = document.getElementById('quick-revise-content');
    if (!container) return;
    csHaptic(6);
    container.innerHTML = `
        <div class="cs2-listview">
            ${csChapHeadHTML(subject, classLevel, '')}
            <div style="padding:16px;">${csSkel(6, 74)}</div>
        </div>`;
    try {
        const data = await apiCall(`/api/revision/chapters/${classLevel}/${subject}`);
        const chapters = data.chapters || [];
        reviseState.chapters = chapters;

        // Progress for the rings — one batch call if the endpoint is
        // deployed; otherwise the original per-chapter fan-out.
        let progressMap = {};
        try {
            const all = await apiCall('/api/revision/progress');
            progressMap = all.progress || {};
        } catch (_) {
            await Promise.all(chapters.map(async ch => {
                try { progressMap[ch.chapter_id] = await apiCall(`/api/revision/progress/${ch.chapter_id}`); }
                catch (__) { progressMap[ch.chapter_id] = null; }
            }));
        }
        reviseState.chapterProgress = progressMap;

        const ids = new Set(chapters.map(c => c.chapter_id));
        const resume = csPickResume(progressMap, ids);

        container.innerHTML = `
            <div class="cs2-listview">
                ${csChapHeadHTML(subject, classLevel, `${chapters.length} chapters`)}
                <div class="cs2-listbody">
                    ${resume ? `<div style="margin-bottom:14px;">${csResumeCardHTML(resume)}</div>` : ''}
                    ${csChapFilterHTML()}
                    ${chapters.length > 12 ? `
                    <div class="cs2-search">
                        <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                        <input type="search" id="cs2-ch-search" placeholder="Search chapters"
                            aria-label="Search chapters" oninput="csChapSearch(this.value)">
                    </div>` : ''}
                    <div class="cs2-chapters" id="cs2-chapter-rows"></div>
                </div>
            </div>`;
        csRenderChapterRows();
        if (resume) csAnimateRing('cs2-resume-ring');
    } catch (e) {
        container.innerHTML = `
            <div class="cs2-listview">
                ${csChapHeadHTML(subject, classLevel, '')}
                <div class="cs2-listbody">${csErr('Could not load chapters — ' + e.message,
            `loadReviseChapters('${escapeHtml(subject)}',${classLevel})`)}</div>
            </div>`;
    }
}

// One nav grammar: the sticky .cs2-head, same as chapter home and the
// block overview. The old .cs2-back pill is gone.
function csChapHeadHTML(subject, classLevel, sub) {
    return `<div class="cs2-head">
        <button type="button" class="cs2-head-btn" onclick="loadQuickRevise()" aria-label="Back to subjects">
            <i class="fa-solid fa-arrow-left" aria-hidden="true"></i>
        </button>
        <div class="cs2-head-mid">
            <div class="cs2-head-title">${escapeHtml(subject)}</div>
            <div class="cs2-head-sub">Class ${classLevel}${sub ? ' · ' + escapeHtml(sub) : ''}</div>
        </div>
    </div>`;
}

function csChapCounts() {
    let inprog = 0, notstarted = 0, done = 0;
    reviseState.chapters.forEach(ch => {
        const p = reviseState.chapterProgress[ch.chapter_id];
        const pct = p ? (p.completion_percentage || 0) : 0;
        if (pct >= 100) done++; else if (pct > 0) inprog++; else notstarted++;
    });
    return { all: reviseState.chapters.length, inprog, notstarted, done };
}

function csChapFilterHTML() {
    const c = csChapCounts();
    const f = [
        { id: 'all', label: 'All', n: c.all },
        { id: 'inprog', label: 'In progress', n: c.inprog },
        { id: 'notstarted', label: 'Not started', n: c.notstarted },
        { id: 'done', label: 'Done', n: c.done },
    ].filter(x => x.id === 'all' || x.n > 0);
    if (f.length <= 1) return '';
    return `<div class="cs2-filter" role="tablist" aria-label="Filter chapters">
        ${f.map(x => `<button type="button" role="tab" data-f="${x.id}"
            aria-selected="${reviseState.chFilter === x.id}"
            class="${reviseState.chFilter === x.id ? 'active' : ''}"
            onclick="csChapFilter('${x.id}')">${x.label}<span class="n">${x.n}</span></button>`).join('')}
    </div>`;
}

function csChapFilter(id) {
    reviseState.chFilter = id;
    csHaptic(5);
    document.querySelectorAll('.cs2-filter button').forEach(b => {
        const on = b.dataset.f === id;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    csRenderChapterRows();
}

function csChapSearch(v) {
    reviseState.chQuery = (v || '').trim().toLowerCase();
    csRenderChapterRows();
}

function csRenderChapterRows() {
    const host = document.getElementById('cs2-chapter-rows');
    if (!host) return;
    const q = reviseState.chQuery;
    const f = reviseState.chFilter;

    const list = reviseState.chapters
        .map((ch, idx) => ({ ch, idx }))
        .filter(({ ch }) => {
            if (q && !String(ch.chapter_name || '').toLowerCase().includes(q)) return false;
            if (f === 'all') return true;
            const p = reviseState.chapterProgress[ch.chapter_id];
            const pct = p ? (p.completion_percentage || 0) : 0;
            if (f === 'done') return pct >= 100;
            if (f === 'inprog') return pct > 0 && pct < 100;
            if (f === 'notstarted') return pct === 0;
            return true;
        });

    if (!list.length) {
        host.innerHTML = `<div class="cs2-empty"><i class="fa-solid fa-filter" aria-hidden="true"></i>
            ${q ? 'No chapters match that search.' : 'Nothing in this filter yet.'}</div>`;
        return;
    }

    host.innerHTML = list.map(({ ch, idx }) => {
        const prog = reviseState.chapterProgress[ch.chapter_id];
        const pct = prog ? (prog.completion_percentage || 0) : 0;
        const done = prog ? (prog.blocks_completed || []).length : 0;
        // Chip diet: one chip, max. Everything countable lives on the
        // meta line, where it reads as a sentence instead of confetti.
        const bits = [`${ch.total_blocks} concept${ch.total_blocks !== 1 ? 's' : ''}`];
        if (pct > 0) bits.push(`${done}/${ch.total_blocks} done`);
        else if (ch.total_flashcards) bits.push(`${ch.total_flashcards} flashcards`);
        if (ch.pyq_linked_blocks > 0) bits.push(`${ch.pyq_linked_blocks} PYQ`);
        return `<button type="button" class="cs2-chapter-row ${pct >= 100 ? 'done' : ''}" onclick="csOpenChapter(${idx})">
            ${csRingHTML(`cs2-chring-${idx}`, pct, 44, 4.5)}
            <span style="flex:1;min-width:0;text-align:left;">
                <span class="ch-name">${escapeHtml(ch.chapter_name)}</span>
                <span class="meta">${bits.join(' · ')}</span>
                ${ch.tier_a_count > 0 ? `<span class="chips">
                    <span class="cs2-chip grad"><i class="fa-solid fa-star" style="font-size:.55rem;" aria-hidden="true"></i>${ch.tier_a_count} must-know</span>
                </span>` : ''}
            </span>
            <i class="fa-solid fa-chevron-right" style="color:var(--s300);flex-shrink:0;font-size:.8rem;" aria-hidden="true"></i>
        </button>`;
    }).join('');

    list.forEach(({ idx }) => csAnimateRing(`cs2-chring-${idx}`));
}

function csOpenChapter(idx) {
    const ch = reviseState.chapters[idx];
    if (!ch) return;
    csHaptic(8);
    navigate('revise-journey', { chapter_id: ch.chapter_id, chapter_name: ch.chapter_name });
}

// ════════════════════════════════════════════════════════════════
// JOURNEY INIT
// ════════════════════════════════════════════════════════════════
async function startRevisionJourney(chapterId, chapterName) {
    reviseState.currentChapterId = chapterId;
    reviseState.currentChapterName = chapterName;
    reviseState.loadedBlocks = {}; reviseState._fcState = {};
    reviseState.arState = {}; reviseState.qState = {}; reviseState.qIndex = {};
    reviseState.pagers = {};
    // v3: visits are read back from localStorage, not wiped. A student
    // who read six sections yesterday sees six ticks today.
    reviseState.visited = csVisitLoad(chapterId);
    csRemoveLayer(true);
    const container = document.getElementById('revise-journey-content');
    if (!container) return;
    container.innerHTML = `<div class="cs2-home">
        <div class="cs2-head grad">
            <button type="button" class="cs2-head-btn" onclick="navigate('quick-revise')" aria-label="Back to chapters">
                <i class="fa-solid fa-arrow-left" aria-hidden="true"></i></button>
            <div class="cs2-head-mid">
                <div class="cs2-head-title">${escapeHtml(chapterName || 'Chapter')}</div>
                <div class="cs2-head-sub">Loading…</div>
            </div>
        </div>
        <div style="padding:16px;">${csSkel(7, 66)}</div>
    </div>`;
    try {
        // Always re-fetch progress on entry — never trust stale local state
        const [meta, progress] = await Promise.all([
            apiCall(`/api/revision/chapter/${chapterId}/meta`),
            apiCall(`/api/revision/progress/${chapterId}`),
        ]);
        reviseState.chapterMeta = meta;
        reviseState.blockOrder = meta.block_order || [];
        reviseState.blocksCompleted = new Set(progress.blocks_completed || []);
        reviseState.currentBlockIndex = progress.current_block_index || 0;
        reviseState.blockSummaries = {};
        (meta.block_summaries || []).forEach(s => { reviseState.blockSummaries[s.block_id] = s; });
        renderChapterHome();
    } catch (e) {
        container.innerHTML = `<div class="cs2-home">
            <div class="cs2-head grad">
                <button type="button" class="cs2-head-btn" onclick="navigate('quick-revise')" aria-label="Back to chapters">
                    <i class="fa-solid fa-arrow-left" aria-hidden="true"></i></button>
                <div class="cs2-head-mid"><div class="cs2-head-title">${escapeHtml(chapterName || 'Chapter')}</div></div>
            </div>
            ${csErr('Could not load chapter — ' + e.message,
            `startRevisionJourney('${escapeHtml(chapterId)}','${escapeHtml(chapterName || '')}')`)}
        </div>`;
    }
}

function journeyHeaderStats() {
    const meta = reviseState.chapterMeta || {};
    const total = reviseState.blockOrder.length;
    const done = reviseState.blocksCompleted.size;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const tierARemaining = (meta.tier_a_count || 0) - [...reviseState.blocksCompleted].filter(bid => {
        const s = reviseState.blockSummaries[bid]; return s && s.tier === 'A';
    }).length;
    return { total, done, pct, tierARemaining };
}

// ════════════════════════════════════════════════════════════════
// CHAPTER HOME — the SPINE reaches up a level
//
// v2 stacked a celebrate banner, a hero ring card and a Continue card
// on top of a plain list, and stated the same fact four times before
// the student saw a single block. v3: the ring lives in the sticky
// head (which is also the visual continuity from the chapter row you
// just tapped), one stat line, then the spine — the same metaphor the
// block screen uses. Continue is a sticky bottom bar.
// ════════════════════════════════════════════════════════════════
function renderChapterHome() {
    csRemoveLayer(true);
    const container = document.getElementById('revise-journey-content');
    if (!container) return;
    const meta = reviseState.chapterMeta || {};
    const { total, done, pct, tierARemaining } = journeyHeaderStats();
    const allDone = total > 0 && done >= total;
    const firstIncomplete = reviseState.blockOrder.findIndex(bid => !reviseState.blocksCompleted.has(bid));
    const continueIdx = firstIncomplete >= 0 ? firstIncomplete : 0;
    const continueSummary = reviseState.blockSummaries[reviseState.blockOrder[continueIdx]] || {};

    const rows = reviseState.blockOrder.map((bid, i) => {
        const s = reviseState.blockSummaries[bid] || {};
        const isDone = reviseState.blocksCompleted.has(bid);
        const isCurrent = !allDone && i === continueIdx;
        const opened = csVisitCount(reviseState.currentChapterId, bid);
        const prev = csBlockPreview(bid, s);
        const isA = s.tier === 'A';
        const rich = csBlockRich(bid, s);
        // Tier is the one field the payload always carries, so it does the
        // colour work: a must-know block should look different from across
        // the room, not require you to find a 10px star.
        return `<button type="button" class="cs2-station cs2-bst ${isDone ? 'done' : ''} ${isCurrent ? 'current' : ''} ${isA ? 'tier-a' : ''}"
            onclick="csOpenBlockByIndex(${i})"
            aria-label="Block ${i + 1}: ${escapeHtml(s.heading || bid)}${isA ? ', must know' : ''}${isDone ? ' (done)' : ''}">
            <span class="dot"></span>
            <span class="st-ico">${isDone ? '<i class="fa-solid fa-check" aria-hidden="true"></i>' : i + 1}</span>
            <span class="st-info">
                <span class="st-title">${escapeHtml(s.heading || bid.replace(/_/g, ' '))}</span>
                ${prev ? `<span class="st-prev">${escapeHtml(prev)}</span>` : ''}
                <span class="st-tags">
                    ${isA ? '<span class="cs2-chip star"><i class="fa-solid fa-star" style="font-size:.5rem;" aria-hidden="true"></i>Must know</span>' : ''}
                    ${rich}
                    ${isCurrent ? '<span class="st-here">You are here</span>'
                : (!isDone && opened > 0) ? `<span class="st-here soft">${opened} opened</span>` : ''}
                </span>
            </span>
            <i class="fa-solid ${isDone ? 'fa-circle-check' : 'fa-chevron-right'} st-chev" aria-hidden="true"></i>
        </button>`;
    }).join('');

    container.innerHTML = `
        <div class="cs2-home">
            <div class="cs2-head grad">
                <button type="button" class="cs2-head-btn" onclick="navigate('quick-revise')" aria-label="Back to chapters">
                    <i class="fa-solid fa-arrow-left" aria-hidden="true"></i>
                </button>
                <div class="cs2-head-mid">
                    <div class="cs2-head-title">${escapeHtml(meta.chapter_name || reviseState.currentChapterName || '')}</div>
                    <div class="cs2-head-sub">${escapeHtml(meta.subject || '')}${meta.ncert_class ? ' · Class ' + escapeHtml(String(meta.ncert_class)) : ''}</div>
                </div>
                ${csRingHTML('cs2-home-ring', pct, 38, 4, false)}
            </div>

            ${allDone ? `
            <div class="cs2-celebrate">
                <div class="ico"><i class="fa-solid fa-trophy" aria-hidden="true"></i></div>
                <h3>Chapter complete</h3>
                <p>All ${total} concepts done. Revisit any block below to keep it fresh, Doctor.</p>
            </div>` : `
            <div class="cs2-statline">
                <strong>${done} of ${total}</strong> concepts done${tierARemaining > 0
            ? ` · <span class="ta"><i class="fa-solid fa-star" aria-hidden="true"></i> ${tierARemaining} must-know left</span>` : ''}
            </div>`}

            <div class="cs2-spine" id="cs2-chapter-spine">${rows}</div>
        </div>

        ${!allDone ? `
        <div class="cs2-done-wrap">
            <button type="button" class="cs2-done-btn" onclick="csOpenBlockByIndex(${continueIdx})">
                <i class="fa-solid fa-play" style="font-size:.72rem;" aria-hidden="true"></i>
                ${done > 0 ? 'Continue' : 'Start'} · ${escapeHtml(csSnippet(continueSummary.heading || `Block ${continueIdx + 1}`, 28))}
            </button>
        </div>` : ''}`;
    csAnimateRing('cs2-home-ring');
    window.scrollTo({ top: 0 });
}

// Read a count off a summary object without knowing which name the
// ingestion used. Returns null when nothing plausible is there, and the
// chip simply doesn't render.
function csNum(o, keys) {
    for (const k of keys) {
        const v = o[k];
        if (typeof v === 'number' && v > 0) return v;
        if (Array.isArray(v) && v.length) return v.length;
    }
    return null;
}

// What's actually inside a block, for the chapter list. Once a block has
// been opened we know for certain (it's cached); before that we probe the
// summary. Either way the row only ever claims what it can back up.
function csBlockRich(bid, s) {
    const loaded = reviseState.loadedBlocks[bid];
    let pyq, cards, figs;
    if (loaded) {
        const p = loaded.pyq_links || {};
        pyq = (p.matched_questions || []).length + (p.variants || []).length || null;
        cards = (loaded._flashcards || []).length || null;
        figs = (loaded.linked_figure_details || []).length || null;
    } else {
        pyq = csNum(s, ['pyq_count', 'pyq_linked', 'pyq_questions', 'matched_pyq', 'total_pyq', 'pyq_links']);
        cards = csNum(s, ['flashcard_count', 'total_flashcards', 'card_count', 'flashcards']);
        figs = csNum(s, ['figure_count', 'total_figures', 'linked_figures', 'figures']);
    }
    const out = [];
    if (pyq) out.push(`<span class="cs2-chip year"><i class="fa-solid fa-scroll" style="font-size:.5rem;" aria-hidden="true"></i>${pyq} PYQ</span>`);
    if (cards) out.push(`<span class="cs2-chip"><i class="fa-solid fa-layer-group" style="font-size:.5rem;" aria-hidden="true"></i>${cards}</span>`);
    if (figs) out.push(`<span class="cs2-chip"><i class="fa-solid fa-image" style="font-size:.5rem;" aria-hidden="true"></i>${figs}</span>`);
    return out.join('');
}

// A preview line for a chapter-spine row. The meta summary shape isn't
// guaranteed, so this reads every field it might plausibly be under and
// degrades to nothing rather than to boilerplate. Once a block has been
// loaded we have the real precision statement, so prefer that.
function csBlockPreview(bid, s) {
    const loaded = reviseState.loadedBlocks[bid];
    if (loaded) {
        const L1 = loaded.layer1 || {};
        const t = L1.precision_statement || L1.exact_definition;
        if (t) return csSnippet(t, 88);
    }
    const t = s.precision_statement || s.summary || s.one_liner || s.description || s.preview;
    if (t) return csSnippet(t, 88);
    if (s.tier === 'A') return 'Must-know — NEET tests this one directly';
    if (s.neet_importance === 'high') return 'High-priority concept';
    return '';
}

function csOpenBlockByIndex(i) {
    if (i < 0 || i >= reviseState.blockOrder.length) return;
    reviseState.currentBlockIndex = i;
    csHaptic(8);
    loadBlock(i);
}

// ════════════════════════════════════════════════════════════════
// BLOCK — load + overview (the SPINE)
// ════════════════════════════════════════════════════════════════
async function loadBlock(idx) {
    const blockId = reviseState.blockOrder[idx];
    const container = document.getElementById('revise-journey-content');
    if (!container) return;
    csRemoveLayer(true);
    reviseState.doneArmed = false;
    container.innerHTML = `<div class="cs2-block">
        <div class="cs2-head grad d2">
            <button type="button" class="cs2-head-btn" onclick="renderChapterHome()" aria-label="Back to block list">
                <i class="fa-solid fa-arrow-left" aria-hidden="true"></i></button>
            <div class="cs2-head-mid">
                <div class="cs2-head-title">${escapeHtml(reviseState.currentChapterName || '')}</div>
                <div class="cs2-head-sub">Block ${idx + 1} of ${reviseState.blockOrder.length}</div>
            </div>
        </div>
        <div style="padding:22px 18px;">${csSkel(1, 74, 12)}<div style="height:14px"></div>${csSkel(6, 62)}</div>
    </div>`;
    try {
        let blockData = reviseState.loadedBlocks[blockId];
        if (!blockData) {
            const [bd, fd] = await Promise.all([
                apiCall(`/api/revision/chapter/${reviseState.currentChapterId}/block/${blockId}`),
                apiCall(`/api/revision/chapter/${reviseState.currentChapterId}/flashcards/${blockId}`),
            ]);
            blockData = bd; blockData._flashcards = fd.flashcards || [];
            reviseState.loadedBlocks[blockId] = blockData;
        }
        if (!reviseState._fcState[blockId]) reviseState._fcState[blockId] = csFcInit(blockData._flashcards || []);
        renderBlockOverview(blockId, blockData, idx);
    } catch (e) {
        container.innerHTML = `<div class="cs2-block">
            <div class="cs2-head grad d2">
                <button type="button" class="cs2-head-btn" onclick="renderChapterHome()" aria-label="Back to block list">
                    <i class="fa-solid fa-arrow-left" aria-hidden="true"></i></button>
                <div class="cs2-head-mid"><div class="cs2-head-title">${escapeHtml(reviseState.currentChapterName || '')}</div></div>
            </div>
            ${csErr('Could not load this block — ' + e.message, `loadBlock(${idx})`)}
        </div>`;
    }
}

// Section catalogue. Note what is NOT here any more:
//   • naadi  — the briefing duplicated six fields from the sections
//              below it and spoiled the traps before the concept was
//              taught. It is now the RECAP card at the foot of the
//              block, which is where a briefing earns its keep.
//   • pages  — NCERT source scans are reference material, not teaching
//              material. They no longer compete for a station; they
//              open from a source link at the foot of Understand.
//
// The order is the pedagogy: define it → see its shape → use it →
// learn how it's twisted → recall it → meet it in the real exam →
// read the figure.
const CS_SECTIONS = {
    understand: { icon: 'fa-book-open', title: 'Understand' },
    visual: { icon: 'fa-diagram-project', title: 'Visual map' },
    apply: { icon: 'fa-flask', title: 'Apply it' },
    traps: { icon: 'fa-triangle-exclamation', title: 'NEET traps' },
    cards: { icon: 'fa-layer-group', title: 'Flashcards' },
    pyq: { icon: 'fa-scroll', title: 'Past questions' },
    figures: { icon: 'fa-image', title: 'Figures' },
};

function csBlockSections(blockId, data) {
    const L1 = data.layer1 || {}, L2 = data.layer2 || {}, L3 = data.layer3 || {};
    const summary = reviseState.blockSummaries[blockId] || {};
    const isTierA = data.tier === 'A' || summary.tier === 'A';
    const cards = data._flashcards || [];
    const pyq = data.pyq_links || {};
    const matched = pyq.matched_questions || [];
    const variants = pyq.variants || [];
    const figs = data.linked_figure_details || [];
    const cm = data.concept_map || {}, fc = data.flowchart || {};

    const secs = [];

    secs.push({
        id: 'understand',
        prev: csSnippet(L1.exact_definition || L1.precision_statement || 'The definition, the values that matter, the exam tip', 90),
        count: null,
        mins: csMins(csTextLen(L1)),
    });
    if (cm.node_label || (fc.nodes || []).length > 0) secs.push({
        id: 'visual',
        prev: [cm.node_label ? 'Where this sits in the bigger picture' : '',
        (fc.nodes || []).length ? (fc.title || 'The process, step by step') : ''].filter(Boolean).join(' · '),
        count: null,
        mins: 1,
    });
    if (Object.keys(L2).length) secs.push({
        id: 'apply',
        prev: csSnippet(L2.application_principle || 'How NEET makes you use this concept', 90),
        count: (L2.worked_scenario && (L2.worked_scenario.setup || L2.worked_scenario.answer)) ? 'worked example' : null,
        mins: csMins(csTextLen(L2)),
    });
    if (isTierA || L3.the_trap || (L3.assertion_reason_pair || {}).assertion) secs.push({
        id: 'traps', danger: true,
        prev: L3.the_trap ? csSnippet(L3.the_trap, 90) : 'The assertion–reason drill NEET loves',
        count: (L3.assertion_reason_pair || {}).assertion ? 'A–R drill' : null,
        mins: csMins(csTextLen(L3)),
    });
    if (cards.length > 0) secs.push({
        id: 'cards',
        prev: 'Full-screen recall — hardest cards first',
        count: `${cards.length}`,
        mins: Math.max(1, Math.round(cards.length * 0.4)),
    });
    if (matched.length > 0 || variants.length > 0) secs.push({
        id: 'pyq',
        prev: `${matched.length ? `${matched.length} real NEET question${matched.length !== 1 ? 's' : ''}` : ''}${matched.length && variants.length ? ' · ' : ''}${variants.length ? `${variants.length} practice variant${variants.length !== 1 ? 's' : ''}` : ''}${(pyq.years_appeared || []).length ? ` · ${pyq.years_appeared.join(', ')}` : ''}`,
        count: `${matched.length + variants.length}`,
        mins: Math.max(1, matched.length + variants.length),
    });
    if (figs.length > 0) secs.push({
        id: 'figures',
        prev: 'NCERT figures, decoded label by label',
        count: `${figs.length}`,
        mins: Math.max(1, figs.length),
    });
    return secs;
}

function renderBlockOverview(blockId, data, idx) {
    const container = document.getElementById('revise-journey-content');
    if (!container) return;
    const summary = reviseState.blockSummaries[blockId] || {};
    const isTierA = data.tier === 'A' || summary.tier === 'A';
    const importance = summary.neet_importance || data.neet_importance || '';
    const isDone = reviseState.blocksCompleted.has(blockId);
    const title = (data.layer1 || {}).headline || summary.heading || blockId.replace(/_/g, ' ');
    const precision = (data.layer1 || {}).precision_statement || '';
    const total = reviseState.blockOrder.length;
    const { pct } = journeyHeaderStats();
    const visited = reviseState.visited[blockId] || new Set();
    const secs = csBlockSections(blockId, data);
    const briefing = csBuildBriefing(data);

    reviseState.curBlockId = blockId;
    reviseState.secOrder = secs.map(s => s.id);

    const stations = secs.map(s => {
        const meta = CS_SECTIONS[s.id];
        const seen = visited.has(s.id);
        return `<button type="button" class="cs2-station ${seen ? 'visited' : ''} ${s.danger ? 'st-danger' : ''}"
            id="cs2-st-${s.id}" onclick="csOpenSection('${blockId}','${s.id}')"
            aria-label="${meta.title}${seen ? ' (opened)' : ''}">
            <span class="dot"></span>
            <span class="st-ico"><i class="fa-solid ${meta.icon}" aria-hidden="true"></i></span>
            <span class="st-info">
                <span class="st-title">${meta.title}
                    ${s.count ? `<span class="cs2-count">${escapeHtml(s.count)}</span>` : ''}
                    <span class="cs2-mins">${s.mins} min</span>
                </span>
                <span class="st-prev">${escapeHtml(s.prev || '')}</span>
            </span>
            <i class="fa-solid ${seen ? 'fa-circle-check' : 'fa-chevron-right'} st-chev" aria-hidden="true"></i>
        </button>`;
    }).join('');

    container.innerHTML = `
        <div class="cs2-block">
            <div class="cs2-head grad d2">
                <button type="button" class="cs2-head-btn" onclick="renderChapterHome()" aria-label="Back to block list">
                    <i class="fa-solid fa-arrow-left" aria-hidden="true"></i>
                </button>
                <div class="cs2-head-mid">
                    <div class="cs2-head-title">${escapeHtml(reviseState.currentChapterName || (reviseState.chapterMeta || {}).chapter_name || '')}</div>
                    <div class="cs2-head-sub">Block ${idx + 1} of ${total}</div>
                    <div class="cs2-head-bar"><i id="cs2-blk-bar" style="width:${pct}%;"></i></div>
                </div>
            </div>

            <div class="cs2-block-hero">
                <div class="tags">
                    ${isTierA ? '<span class="cs2-chip star"><i class="fa-solid fa-star" style="font-size:.55rem;" aria-hidden="true"></i>Must know</span>' : ''}
                    ${importance === 'high' && !isTierA ? '<span class="cs2-chip grad">High priority</span>' : ''}
                    ${isDone ? '<span class="cs2-chip grad"><i class="fa-solid fa-check" style="font-size:.6rem;" aria-hidden="true"></i>Done</span>' : ''}
                </div>
                <h1>${safeHtml(title)}</h1>
                ${precision ? `<div class="precision">${safeHtml(precision)}</div>` : ''}
                ${briefing.length ? `<div class="cs2-teaser">
                    <i class="fa-solid fa-user-doctor" aria-hidden="true"></i>
                    <span>I found <strong>${briefing.length} thing${briefing.length !== 1 ? 's' : ''}</strong> NEET likes to test here — I'll recap them at the end.</span>
                </div>` : ''}
            </div>

            <div class="cs2-spine" id="cs2-spine">${stations}</div>

            ${briefing.length ? csRecapHTML(briefing) : ''}

            <div class="cs2-blocknav">
                <button type="button" onclick="csOpenBlockByIndex(${idx - 1})" ${idx === 0 ? 'disabled' : ''}>
                    <i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Previous
                </button>
                <button type="button" onclick="csOpenBlockByIndex(${idx + 1})" ${idx >= total - 1 ? 'disabled' : ''}>
                    Next block <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>
                </button>
            </div>
        </div>

        <div class="cs2-done-wrap">
            <button type="button" class="cs2-done-btn ${isDone ? 'done-state' : ''}" id="rev-done-${blockId}"
                onclick="markNewBlockDone('${blockId}')" ${isDone ? 'disabled' : ''}>
                ${isDone
            ? '<i class="fa-solid fa-check-circle" aria-hidden="true"></i> Block completed'
            : '<i class="fa-solid fa-circle-check" aria-hidden="true"></i> Mark block done'}
            </button>
        </div>`;
    csSetupBlockSwipe(idx, total);
    window.scrollTo({ top: 0 });
}

// The briefing, reborn: same six fields, but AFTER the sections, where
// re-reading them is spaced repetition instead of a spoiler.
function csRecapHTML(items) {
    return `<div class="cs2-recap">
        <div class="rc-head">
            <span class="rc-ava"><i class="fa-solid fa-user-doctor" aria-hidden="true"></i></span>
            <span>
                <span class="cs2-micro">Before you go</span>
                <span class="rc-title">NAADI's recap — ${items.length} thing${items.length !== 1 ? 's' : ''} NEET tests here</span>
            </span>
        </div>
        ${items.map(m => `
        <div class="rc-item ${m.danger ? 'bad' : ''}">
            <i class="fa-solid ${m.icon}" aria-hidden="true"></i>
            <div>
                <div class="rc-it-title">${m.title}</div>
                <div class="rc-it-body">${m.plain}</div>
            </div>
        </div>`).join('')}
    </div>`;
}

function csSetupBlockSwipe(idx, total) {
    const el = document.querySelector('.cs2-block');
    if (!el || el._swipeBound) return;
    el._swipeBound = true;
    let x0 = 0, y0 = 0, t0 = 0;
    el.addEventListener('touchstart', e => {
        const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; t0 = Date.now();
    }, { passive: true });
    el.addEventListener('touchend', e => {
        const t = e.changedTouches[0];
        const dx = t.clientX - x0, dy = t.clientY - y0, dt = Date.now() - t0;
        if (dt < 600 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6) {
            if (e.target.closest('.cs2-flow-wrap')) return;
            if (dx < 0 && idx < total - 1) csOpenBlockByIndex(idx + 1);
            else if (dx > 0 && idx > 0) csOpenBlockByIndex(idx - 1);
        }
    }, { passive: true });
}

function csRefreshStations(blockId) {
    const visited = reviseState.visited[blockId] || new Set();
    visited.forEach(sec => {
        const st = document.getElementById(`cs2-st-${sec}`);
        if (st && !st.classList.contains('visited')) {
            st.classList.add('visited');
            const chev = st.querySelector('.st-chev');
            if (chev) chev.className = 'fa-solid fa-circle-check st-chev';
        }
    });
}

// ════════════════════════════════════════════════════════════════
// SECTION LAYER — full-screen, one idea per screen, and ALWAYS a way
// forward. v2 made the student close the layer, find the next station
// and tap it: eight sections cost sixteen taps. v3 swaps the layer
// content in place and ends every screen with "Next: …".
// ════════════════════════════════════════════════════════════════
function csSecBody(blockId, secId) {
    const data = reviseState.loadedBlocks[blockId] || {};
    switch (secId) {
        case 'understand': return csRenderUnderstand(blockId, data);
        case 'visual': return csRenderVisual(data);
        case 'apply': return csRenderApply(blockId, data.layer2 || {});
        case 'traps': return csRenderTraps(blockId, data.layer3 || {});
        case 'cards': return csRenderFlashcards(blockId);
        case 'pyq': return csRenderPyq(blockId, data.pyq_links || {});
        case 'figures': return csRenderFigures(blockId, data.linked_figure_details || []);
        default: return '<div class="cs2-empty">Nothing here yet.</div>';
    }
}

function csLayerFootHTML(blockId, secId) {
    const order = reviseState.secOrder || [];
    const i = order.indexOf(secId);
    const next = i >= 0 && i < order.length - 1 ? order[i + 1] : null;
    const nextMeta = next ? CS_SECTIONS[next] : null;
    return `<div class="cs2-layer-foot">
        <button type="button" class="ghost" onclick="csCloseLayer()">
            <i class="fa-solid fa-list-ul" aria-hidden="true"></i> Block
        </button>
        ${next
            ? `<button type="button" class="primary" onclick="csGoNextSection('${blockId}','${secId}')">
                 Next: ${nextMeta.title} <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>
               </button>`
            : `<button type="button" class="primary" onclick="csCloseLayer()">
                 <i class="fa-solid fa-check" aria-hidden="true"></i> That's the block
               </button>`}
    </div>`;
}

function csOpenSection(blockId, secId) {
    const data = reviseState.loadedBlocks[blockId];
    if (!data) return;
    csHaptic(8);
    csVisitAdd(reviseState.currentChapterId, blockId, secId);
    reviseState.curBlockId = blockId;
    reviseState.curSecId = secId;

    const meta = CS_SECTIONS[secId] || { icon: 'fa-book', title: secId };
    const blockTitle = (data.layer1 || {}).headline
        || (reviseState.blockSummaries[blockId] || {}).heading
        || blockId.replace(/_/g, ' ');
    const dark = secId === 'cards';
    const body = csSecBody(blockId, secId);
    const existing = document.getElementById('cs2-layer');

    // Already open → swap in place. No close/open flicker, no lost scroll
    // position on the screen underneath, and the "Next:" CTA feels like
    // turning a page rather than reopening a menu.
    if (existing) {
        existing.classList.toggle('dark', dark);
        const t = existing.querySelector('.cs2-layer-title .t');
        const s = existing.querySelector('.cs2-layer-title .s');
        if (t) t.textContent = meta.title;
        if (s) s.textContent = csSnippet(blockTitle, 48);
        const lb = document.getElementById('cs2-layer-body');
        if (lb) {
            lb.classList.remove('swap'); void lb.offsetWidth;
            lb.innerHTML = body + csLayerFootHTML(blockId, secId);
            lb.classList.add('swap');
            lb.scrollTo({ top: 0 });
        }
        csRefreshStations(blockId);
        csAfterSectionRender(blockId, secId);
        return;
    }

    const layer = document.createElement('div');
    layer.className = 'cs2-layer' + (dark ? ' dark' : '');
    layer.id = 'cs2-layer';
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    layer.setAttribute('aria-label', meta.title);
    layer.innerHTML = `
        <div class="cs2-layer-head">
            <button type="button" class="cs2-head-btn" onclick="csCloseLayer()" aria-label="Close">
                <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
            </button>
            <div class="cs2-layer-title">
                <div class="t">${meta.title}</div>
                <div class="s">${escapeHtml(csSnippet(blockTitle, 48))}</div>
            </div>
        </div>
        <div class="cs2-layer-body" id="cs2-layer-body">${body}${csLayerFootHTML(blockId, secId)}</div>`;
    document.body.appendChild(layer);
    requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('in')));
    csSetupLayerDismiss(layer);
    csRefreshStations(blockId);
    csAfterSectionRender(blockId, secId);
}

function csGoNextSection(blockId, secId) {
    const order = reviseState.secOrder || [];
    const i = order.indexOf(secId);
    if (i < 0 || i >= order.length - 1) return csCloseLayer();
    csOpenSection(blockId, order[i + 1]);
}

// Per-section wiring that needs the DOM to exist.
function csAfterSectionRender(blockId, secId) {
    if (secId === 'cards') csFcBindGestures(blockId);
}

// The chevron-down implied swipe-to-dismiss in v2 and didn't deliver it.
function csSetupLayerDismiss(layer) {
    const body = layer.querySelector('.cs2-layer-body');
    if (!body) return;
    let y0 = 0, t0 = 0, atTop = false;
    body.addEventListener('touchstart', e => {
        y0 = e.touches[0].clientY; t0 = Date.now(); atTop = body.scrollTop <= 0;
    }, { passive: true });
    body.addEventListener('touchend', e => {
        const dy = e.changedTouches[0].clientY - y0;
        if (atTop && dy > 90 && Date.now() - t0 < 600) csCloseLayer();
    }, { passive: true });
}

function csCloseLayer() {
    const layer = document.getElementById('cs2-layer');
    if (!layer) return;
    csHaptic(5);
    layer.classList.remove('in');
    layer.classList.add('out');
    setTimeout(() => layer.remove(), 320);
}

function csRemoveLayer(instant) {
    const layer = document.getElementById('cs2-layer');
    if (layer) { if (instant) layer.remove(); else csCloseLayer(); }
    const s = document.getElementById('cs2-success');
    if (s && instant) s.remove();
    const lb = document.getElementById('cs2-lightbox');
    if (lb && instant) lb.remove();
}

function csSecLabel(text) {
    return `<div class="cs2-sec-label"><span class="cs2-micro">${text}</span><span class="ln"></span></div>`;
}

// A real accordion, so the one expandable thing in a heavily designed
// screen isn't a raw <details> in the browser's own styling.
let _csAccSeq = 0;
function csAcc(title, icon, inner) {
    _csAccSeq++;
    const id = `cs2-acc-${_csAccSeq}`;
    return `<div class="cs2-acc">
        <button type="button" class="acc-head" aria-expanded="false" aria-controls="${id}"
            onclick="csAccToggle(this,'${id}')">
            <i class="fa-solid ${icon}" aria-hidden="true"></i>
            <span>${title}</span>
            <i class="fa-solid fa-chevron-down caret" aria-hidden="true"></i>
        </button>
        <div class="acc-body" id="${id}" hidden>${inner}</div>
    </div>`;
}

function csAccToggle(btn, id) {
    const body = document.getElementById(id);
    if (!body) return;
    const open = !body.hidden;
    body.hidden = open;
    btn.setAttribute('aria-expanded', open ? 'false' : 'true');
    btn.classList.toggle('open', !open);
    csHaptic(4);
}

// ════════════════════════════════════════════════════════════════
// THE BRIEFING CONTENT — no longer a section, only the recap
// ════════════════════════════════════════════════════════════════
function csBuildBriefing(data) {
    const L1 = data.layer1 || {}, L2 = data.layer2 || {}, L3 = data.layer3 || {};
    const pyq = data.pyq_links || {};
    const items = [];
    if ((L1.critical_conditions || []).length > 0) items.push({
        icon: 'fa-triangle-exclamation', title: 'Watch out for',
        plain: `<ul class="rc-ul">${L1.critical_conditions.map(c => `<li>${safeHtml(c)}</li>`).join('')}</ul>`,
    });
    if (L1.neet_one_liner) items.push({
        icon: 'fa-lightbulb', title: 'Exam tip', plain: safeHtml(L1.neet_one_liner),
    });
    if (L2.comparison_trap) items.push({
        icon: 'fa-xmark', title: 'Common trap', danger: true, plain: safeHtml(L2.comparison_trap),
    });
    if (L2.examiner_angle) items.push({
        icon: 'fa-bullseye', title: "Examiner's angle", plain: safeHtml(L2.examiner_angle),
    });
    if (L3.the_trap) items.push({
        icon: 'fa-skull-crossbones', title: 'The trap', danger: true, plain: safeHtml(L3.the_trap),
    });
    if ((pyq.years_appeared || []).length > 0) items.push({
        icon: 'fa-scroll', title: 'Asked in NEET',
        plain: `NEET ${escapeHtml(pyq.years_appeared.join(' and '))} — ${(pyq.matched_questions || []).length} real question${(pyq.matched_questions || []).length !== 1 ? 's' : ''} on this concept.`,
    });
    return items;
}

// ════════════════════════════════════════════════════════════════
// UNDERSTAND — layer 1 (+ figure jump, source link, checkpoint)
// ════════════════════════════════════════════════════════════════
function csRenderUnderstand(blockId, data) {
    const L1 = data.layer1 || {};
    if (!L1 || !Object.keys(L1).length)
        return '<div class="cs2-empty"><i class="fa-solid fa-book-open" aria-hidden="true"></i>No understand content for this block.</div>';
    let html = '';
    if (L1.exact_definition) {
        html += `<div class="cs2-sec">${csSecLabel('Definition')}
            <div class="cs2-def">${safeHtml(L1.exact_definition)}</div></div>`;
    }
    if ((L1.critical_conditions || []).length > 0) {
        html += `<div class="cs2-sec">${csSecLabel('Watch out for')}
            <div class="cs2-tick-list">
                ${L1.critical_conditions.map(c => `<div class="cs2-tick warn">${safeHtml(c)}</div>`).join('')}
            </div></div>`;
    }
    if ((L1.named_values || []).length > 0) {
        html += `<div class="cs2-sec">${csSecLabel('Named values')}
            <div class="cs2-values">
                ${L1.named_values.map(v => `<span class="cs2-value">${safeHtml(v)}</span>`).join('')}
            </div></div>`;
    }
    if (L1.formula_block) {
        html += `<div class="cs2-sec">${csSecLabel('Formula')}
            <div class="cs2-formula">${safeHtml(L1.formula_block)}</div></div>`;
    }
    if (L1.neet_one_liner) {
        html += `<div class="cs2-sec">
            <div class="cs2-callout"><span class="co-tag"><i class="fa-solid fa-lightbulb" aria-hidden="true"></i> NEET tip</span>
            ${safeHtml(L1.neet_one_liner)}</div></div>`;
    }

    // The figure teaches better than the paragraph does. If the block has
    // one, offer it here rather than making the student find it later.
    const figs = data.linked_figure_details || [];
    if (figs.length && figs[0].image_url) {
        html += `<div class="cs2-sec">
            <button type="button" class="cs2-figjump" onclick="csOpenSection('${blockId}','figures')">
                <img src="${absUrl(figs[0].image_url)}" alt="" aria-hidden="true">
                <span>
                    <span class="fj-t">See the figure${figs.length > 1 ? `s (${figs.length})` : ''}</span>
                    <span class="fj-s">${escapeHtml(csSnippet(figs[0].name || figs[0].label || 'NCERT figure', 46))}</span>
                </span>
                <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>
            </button></div>`;
    }

    // Checkpoint: one card, right where the reading ends. Turns a page
    // that was read into a page that was learned.
    const cards = data._flashcards || [];
    if (cards.length) {
        const c = cards[0];
        html += `<div class="cs2-sec">
            <div class="cs2-recall">
                <div class="cs2-micro">Checkpoint · say it back</div>
                <div class="q">${safeHtml(c.front || c.question || '')}</div>
                <button type="button" class="cs2-ghost-btn" id="cs2-recall-btn" onclick="csRecallShow('${blockId}')">
                    <i class="fa-solid fa-eye" aria-hidden="true"></i> Show answer
                </button>
                <div class="a" id="cs2-recall-a" hidden aria-live="polite">${safeHtml(c.back || c.answer || '')}</div>
            </div></div>`;
    }

    // NCERT source scans: reference, not a station.
    const pages = data.source_pages || [];
    const pageUrls = data.page_urls || {};
    const pageList = pages.length ? pages
        : Object.keys(pageUrls).map(k => parseInt(k.replace('page_', '').replace('.png', ''), 10)).filter(n => !isNaN(n)).sort((a, b) => a - b);
    if (pageList.length && Object.keys(pageUrls).length) {
        html += `<div class="cs2-sec">
            <button type="button" class="cs2-source" onclick="csOpenPages('${blockId}')">
                <i class="fa-solid fa-book-open" aria-hidden="true"></i>
                <span>Source · NCERT page${pageList.length !== 1 ? 's' : ''} ${pageList.length > 1
                ? `${pageList[0]}–${pageList[pageList.length - 1]}` : pageList[0]}</span>
                <i class="fa-solid fa-up-right-and-down-left-from-center" aria-hidden="true"></i>
            </button></div>`;
    }
    return html || '<div class="cs2-empty"><i class="fa-solid fa-book-open" aria-hidden="true"></i>No understand content for this block.</div>';
}

function csRecallShow(blockId) {
    const a = document.getElementById('cs2-recall-a');
    const b = document.getElementById('cs2-recall-btn');
    if (a) a.hidden = false;
    if (b) b.remove();
    csHaptic(6);
}

// ════════════════════════════════════════════════════════════════
// APPLY — layer 2
// Order changed: recognise it (cues) BEFORE you solve it (worked
// scenario). And the worked answer no longer sits face-up next to the
// question it is the answer to.
// ════════════════════════════════════════════════════════════════
function csRenderApply(blockId, L2) {
    if (!L2 || !Object.keys(L2).length)
        return '<div class="cs2-empty"><i class="fa-solid fa-flask" aria-hidden="true"></i>No application content for this block.</div>';
    let html = '';

    // 1 — THE PRINCIPLE. Not a box. This is the one sentence the whole
    //     screen hangs off, so it gets to look like a headline instead of
    //     the first of five identical grey rectangles.
    if (L2.application_principle) {
        html += `<div class="cs2-sec">
            <div class="cs2-lead">
                <span class="cs2-micro">The principle</span>
                <p>${safeHtml(L2.application_principle)}</p>
            </div></div>`;
    }

    // 2 — SPOT IT BY. Numbered cards, laid out to be scanned in two
    //     seconds, not read. This moved above the worked scenario:
    //     recognise the question before you try to solve it.
    if ((L2.identification_cues || []).length > 0) {
        html += `<div class="cs2-sec">${csSecLabel('Spot it by')}
            <div class="cs2-cues">
                ${L2.identification_cues.map((c, i) => `<div class="cs2-cue">
                    <span class="n">${i + 1}</span><span class="t">${safeHtml(c)}</span>
                </div>`).join('')}
            </div></div>`;
    }

    // 3 — THE WORKED SCENARIO. The centrepiece, and the only long read on
    //     the screen — with the solution behind a tap.
    const ws = L2.worked_scenario || {};
    if (ws.setup || ws.answer) {
        const steps = ws.approach || [];
        const gated = !!(steps.length || ws.answer) && !!ws.setup;
        const solution = `
            ${steps.map((step, i) => `
                <div class="cs2-step">
                    <div class="rail"><div class="n">${i + 1}</div>${i < steps.length - 1 ? '<div class="l"></div>' : ''}</div>
                    <div class="txt">${safeHtml(step)}</div>
                </div>`).join('')}
            ${ws.answer ? `<div class="cs2-answer"><i class="fa-solid fa-check" style="margin-top:3px;" aria-hidden="true"></i><span>${safeHtml(ws.answer)}</span></div>` : ''}
            ${ws.watch_for ? `<div class="cs2-watch"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span><b>Careful —</b> ${safeHtml(ws.watch_for)}</span></div>` : ''}`;
        html += `<div class="cs2-sec">${csSecLabel('Worked scenario')}
            <div class="cs2-scenario">
                ${ws.setup ? `<div class="setup">${safeHtml(ws.setup)}</div>` : ''}
                ${gated ? `
                <button type="button" class="cs2-try-btn" id="cs2-try-${blockId}" onclick="csRevealWork('${blockId}')">
                    <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i> Try it yourself, then reveal the steps
                </button>
                <div id="cs2-work-${blockId}" hidden aria-live="polite">${solution}</div>`
                : solution}
            </div>
        </div>`;
    }

    // 4 — THE TRAP. Dark plate. The one thing here that costs marks should
    //     not share a container with the four that don't.
    if (L2.comparison_trap) {
        html += `<div class="cs2-sec">
            <div class="cs2-trap-plate soft">
                <span class="tp-tag"><i class="fa-solid fa-xmark" aria-hidden="true"></i> Comparison trap</span>
                ${safeHtml(L2.comparison_trap)}
            </div></div>`;
    }

    // 5 — EXAMINER'S ANGLE. Genuinely secondary — useful once, not worth a
    //     screenful of vertical space every visit. Folded away.
    if (L2.examiner_angle) {
        html += `<div class="cs2-sec">${csAcc("How the examiner will ask it", 'fa-bullseye',
            `<div class="cs2-prose">${safeHtml(L2.examiner_angle)}</div>`)}</div>`;
    }
    return html || '<div class="cs2-empty"><i class="fa-solid fa-flask" aria-hidden="true"></i>No application content for this block.</div>';
}

function csRevealWork(blockId) {
    const w = document.getElementById(`cs2-work-${blockId}`);
    const b = document.getElementById(`cs2-try-${blockId}`);
    if (w) w.hidden = false;
    if (b) b.remove();
    csHaptic(8);
}

// ════════════════════════════════════════════════════════════════
// TRAPS — layer 3 (+ Assertion–Reason drill)
// ════════════════════════════════════════════════════════════════
const CS_AR_OPTIONS = [
    { id: 'A', short: 'Both true — R explains A', full: 'Both A and R are true, and R is the correct explanation of A' },
    { id: 'B', short: 'Both true — R does not explain A', full: 'Both A and R are true, but R is NOT the correct explanation of A' },
    { id: 'C', short: 'A true, R false', full: 'A is true, but R is false' },
    { id: 'D', short: 'A false, R true', full: 'A is false, but R is true' },
];

// v2 string-matched the backend's phrasing against a hardcoded map and,
// on a miss, fell back to correct_answer.charAt(0) — which cheerfully
// marks a student wrong on a phrasing change. v3 returns null when it
// cannot be sure, and the caller hides the drill rather than guess.
function csResolveAR(ar) {
    const raw = String(ar.correct_answer || '').trim();
    if (!raw) return null;
    if (/^[ABCD]$/i.test(raw)) return raw.toUpperCase();
    if (/^\([ABCD]\)$/i.test(raw)) return raw.charAt(1).toUpperCase();
    const norm = s => String(s).toLowerCase().replace(/[^a-z]/g, '');
    const n = norm(raw);
    for (const o of CS_AR_OPTIONS) if (norm(o.full) === n || norm(o.short) === n) return o.id;
    // Last resort: an unambiguous substring match against exactly one option.
    const hits = CS_AR_OPTIONS.filter(o => n.includes(norm(o.full)) || norm(o.full).includes(n));
    if (hits.length === 1) return hits[0].id;
    console.warn('[Concept Studio] Unrecognised assertion–reason answer, drill hidden:', raw);
    return null;
}

function csRenderTraps(blockId, L3) {
    if (!L3 || !Object.keys(L3).length)
        return '<div class="cs2-empty"><i class="fa-solid fa-shield" aria-hidden="true"></i>No traps recorded for this block — stay sharp anyway.</div>';
    let html = '';
    if (L3.the_trap) {
        html += `<div class="cs2-sec">
            <div class="cs2-trap-plate">
                <span class="tp-tag"><i class="fa-solid fa-skull-crossbones" aria-hidden="true"></i> The trap</span>
                ${safeHtml(L3.the_trap)}
            </div></div>`;
    }
    const ar = L3.assertion_reason_pair || {};
    if (ar.assertion && ar.reason) {
        const correctId = csResolveAR(ar);
        const plate = `<div class="cs2-ar-plate">
                <div class="row"><b>ASSERTION (A)</b><br>${safeHtml(ar.assertion)}</div>
                <div class="row"><b>REASON (R)</b><br>${safeHtml(ar.reason)}</div>
            </div>`;
        if (!correctId) {
            // Can't grade it honestly → present it as reading, not a quiz.
            html += `<div class="cs2-sec">${csSecLabel('Assertion–Reason · NEET favourite')}
                ${plate}
                ${ar.explanation ? `<div class="cs2-callout" style="margin-top:12px;">
                    <span class="co-tag"><i class="fa-solid fa-circle-info" aria-hidden="true"></i> How it works</span>
                    ${safeHtml(ar.explanation)}</div>` : ''}
            </div>`;
        } else {
            if (!reviseState.arState[blockId]) reviseState.arState[blockId] = { selected: null, submitted: false };
            const arId = `revAR-${blockId}`;
            html += `<div class="cs2-sec">${csSecLabel('Assertion–Reason · NEET favourite')}
                ${plate}
                <div id="${arId}-opts" role="radiogroup" aria-label="Assertion reason options">
                    ${CS_AR_OPTIONS.map(opt => `
                    <button type="button" class="cs2-opt two" id="${arId}-opt-${opt.id}" role="radio" aria-checked="false"
                        onclick="revSelectAR('${blockId}','${opt.id}')">
                        <span class="key">${opt.id}</span>
                        <span class="ot">
                            <span class="o-short">${opt.short}</span>
                            <span class="o-full">${opt.full}</span>
                        </span>
                    </button>`).join('')}
                </div>
                <button type="button" class="cs2-check-btn" id="${arId}-submit" onclick="revSubmitAR('${blockId}')" disabled>Check answer</button>
                <div class="cs2-reveal" id="${arId}-reveal" style="display:none;" aria-live="polite">
                    <div class="cs2-callout"><span class="co-tag"><i class="fa-solid fa-check" aria-hidden="true"></i> Correct answer: ${escapeHtml(correctId)}</span>
                    ${ar.explanation ? safeHtml(ar.explanation) : ''}</div>
                    <button type="button" class="cs2-ghost-btn" style="margin-top:12px;" onclick="revRetryAR('${blockId}')">
                        <i class="fa-solid fa-rotate-right" aria-hidden="true"></i> Try again
                    </button>
                </div>
            </div>`;
        }
    }
    return html || '<div class="cs2-empty"><i class="fa-solid fa-shield" aria-hidden="true"></i>No traps recorded for this block.</div>';
}

function revSelectAR(blockId, optId) {
    const state = reviseState.arState[blockId];
    if (!state || state.submitted) return;
    state.selected = optId;
    csHaptic(5);
    const arId = `revAR-${blockId}`;
    document.querySelectorAll(`[id^="${arId}-opt-"]`).forEach(el => {
        el.classList.remove('sel'); el.setAttribute('aria-checked', 'false');
    });
    const el = document.getElementById(`${arId}-opt-${optId}`);
    if (el) { el.classList.add('sel'); el.setAttribute('aria-checked', 'true'); }
    const btn = document.getElementById(`${arId}-submit`);
    if (btn) btn.disabled = false;
}

function revSubmitAR(blockId) {
    const state = reviseState.arState[blockId];
    if (!state || !state.selected || state.submitted) return;
    const blockData = reviseState.loadedBlocks[blockId];
    const ar = (blockData && blockData.layer3 && blockData.layer3.assertion_reason_pair) || {};
    const correctId = csResolveAR(ar);
    if (!correctId) return;
    state.submitted = true;
    csHaptic(state.selected === correctId ? 12 : [8, 40, 8]);
    const arId = `revAR-${blockId}`;
    document.querySelectorAll(`[id^="${arId}-opt-"]`).forEach(el => {
        const id = el.id.replace(`${arId}-opt-`, '');
        el.classList.add('locked'); el.classList.remove('sel');
        if (id === correctId) el.classList.add('correct');
        else if (id === state.selected) el.classList.add('wrong');
    });
    const btn = document.getElementById(`${arId}-submit`);
    if (btn) { btn.disabled = true; btn.style.display = 'none'; }
    const reveal = document.getElementById(`${arId}-reveal`);
    if (reveal) reveal.style.display = 'block';
}

function revRetryAR(blockId) {
    reviseState.arState[blockId] = { selected: null, submitted: false };
    const data = reviseState.loadedBlocks[blockId] || {};
    const lb = document.getElementById('cs2-layer-body');
    if (!lb) return;
    lb.innerHTML = csRenderTraps(blockId, data.layer3 || {}) + csLayerFootHTML(blockId, 'traps');
    lb.scrollTo({ top: 0, behavior: 'smooth' });
}

// ════════════════════════════════════════════════════════════════
// PAGER ENGINE — one item per screen with segmented progress
// ════════════════════════════════════════════════════════════════
function csInitPager(key, items, render) {
    reviseState.pagers[key] = { items, cur: 0, render };
}

function csPagerHTML(key) {
    const pg = reviseState.pagers[key];
    if (!pg) return '';
    return `
        <div class="cs2-pg-top">
            <div class="cs2-pg-segs" id="cs2-segs-${key}" role="progressbar"
                aria-valuemin="1" aria-valuemax="${pg.items.length}" aria-valuenow="${pg.cur + 1}">
                ${pg.items.map((_, i) => `<div class="cs2-pg-seg ${i <= pg.cur ? 'on' : ''}"></div>`).join('')}
            </div>
            <div class="cs2-pg-count" id="cs2-cnt-${key}">${pg.cur + 1} / ${pg.items.length}</div>
        </div>
        <div class="cs2-pg-body" id="cs2-body-${key}">${pg.render(pg.items[pg.cur], pg.cur)}</div>
        <div class="cs2-pg-nav" id="cs2-nav-${key}">
            <button type="button" onclick="csPgGo('${key}',-1)" ${pg.cur === 0 ? 'disabled' : ''} aria-label="Previous">
                <i class="fa-solid fa-arrow-left" aria-hidden="true"></i></button>
            <button type="button" class="primary" onclick="csPgGo('${key}',1)" ${pg.cur >= pg.items.length - 1 ? 'disabled' : ''}>
                Next <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
        </div>`;
}

function csPgGo(key, dir) {
    const pg = reviseState.pagers[key];
    if (!pg) return;
    const next = pg.cur + dir;
    if (next < 0 || next >= pg.items.length) return;
    pg.cur = next;
    csHaptic(5);
    const body = document.getElementById(`cs2-body-${key}`);
    if (body) {
        body.classList.remove('back');
        void body.offsetWidth; // restart animation
        if (dir < 0) body.classList.add('back');
        body.innerHTML = pg.render(pg.items[pg.cur], pg.cur);
    }
    csPgSync(key);
    const lb = document.getElementById('cs2-layer-body');
    if (lb) lb.scrollTo({ top: 0, behavior: 'smooth' });
}

function csPgJump(key, i) {
    const pg = reviseState.pagers[key];
    if (!pg || i < 0 || i >= pg.items.length) return;
    csPgGo(key, i - pg.cur);
}

function csPgSync(key) {
    const pg = reviseState.pagers[key];
    if (!pg) return;
    const segs = document.getElementById(`cs2-segs-${key}`);
    if (segs) {
        [...segs.children].forEach((s, i) => s.classList.toggle('on', i <= pg.cur));
        segs.setAttribute('aria-valuenow', pg.cur + 1);
    }
    const cnt = document.getElementById(`cs2-cnt-${key}`);
    if (cnt) cnt.textContent = `${pg.cur + 1} / ${pg.items.length}`;
    const nav = document.getElementById(`cs2-nav-${key}`);
    if (nav) {
        nav.children[0].disabled = pg.cur === 0;
        nav.children[1].disabled = pg.cur >= pg.items.length - 1;
    }
}

// ════════════════════════════════════════════════════════════════
// PYQ — real NEET questions, then a divider you cannot miss, then the
// AI variants, then a result card. v2 shuffled real and generated
// questions into one undifferentiated pager: the one line in this app
// that must never blur is which questions actually came from NEET.
// ════════════════════════════════════════════════════════════════
function csRenderPyq(blockId, pyqLinks) {
    const matched = pyqLinks.matched_questions || [];
    const variants = pyqLinks.variants || [];
    if (!matched.length && !variants.length)
        return '<div class="cs2-empty"><i class="fa-solid fa-scroll" aria-hidden="true"></i>No past questions for this block.</div>';

    const items = [];
    matched.forEach((q, i) => items.push({ kind: 'real', q, key: `real_${blockId}_${i}` }));
    if (matched.length && variants.length) items.push({ kind: 'divider' });
    variants.forEach((v, i) => items.push({ kind: 'variant', q: v, key: `var_${blockId}_${i}` }));
    items.push({ kind: 'result', blockId });

    // Index every question's answer up front. v2 hunted for the correct
    // answer by scanning every pager in global state on each submit.
    items.forEach(it => {
        if (it.key) reviseState.qIndex[it.key] = {
            correct: String((it.q.correct_answer || '')).trim().toUpperCase(),
            kind: it.kind,
            pagerKey: `pyq-${blockId}`,
        };
    });

    const pagerKey = `pyq-${blockId}`;
    csInitPager(pagerKey, items, item => csRenderPyqItem(item, matched.length, variants.length));
    const years = pyqLinks.years_appeared || [];
    return `
        ${years.length ? `<div class="cs2-prose" style="margin-bottom:16px;color:var(--s500);font-size:.82rem;">
            This concept was asked in <strong style="color:var(--cs-ink);">NEET ${escapeHtml(years.join(', '))}</strong> — ${matched.length} real question${matched.length !== 1 ? 's' : ''}${variants.length ? ` and ${variants.length} practice variant${variants.length !== 1 ? 's' : ''}` : ''}.
        </div>` : ''}
        ${csPagerHTML(pagerKey)}`;
}

function csRenderPyqItem(item, nReal, nVar) {
    if (item.kind === 'divider') {
        return `<div class="cs2-divider-slide">
            <div class="dv-ico"><i class="fa-solid fa-dumbbell" aria-hidden="true"></i></div>
            <h3>That was the real thing</h3>
            <p>You've seen all ${nReal} question${nReal !== 1 ? 's' : ''} NEET actually asked on this concept.
               Next up: ${nVar} practice variant${nVar !== 1 ? 's' : ''} written to drill the same idea from a different angle.</p>
            <span class="cs2-chip grad">Practice variants ahead — not past papers</span>
        </div>`;
    }
    if (item.kind === 'result') return csPyqResultHTML(item.blockId);
    return csRenderQuestionItem(item);
}

function csPyqScore(blockId) {
    const pg = reviseState.pagers[`pyq-${blockId}`];
    if (!pg) return { done: 0, right: 0, total: 0, wrongKeys: [] };
    const qs = pg.items.filter(i => i.key);
    let right = 0, done = 0; const wrongKeys = [];
    qs.forEach(i => {
        const st = reviseState.qState[i.key];
        if (st && st.submitted) {
            done++;
            const c = (reviseState.qIndex[i.key] || {}).correct;
            if (st.selected === c) right++; else wrongKeys.push(i.key);
        }
    });
    return { done, right, total: qs.length, wrongKeys };
}

function csPyqResultHTML(blockId) {
    const { done, right, total, wrongKeys } = csPyqScore(blockId);
    if (done === 0) {
        return `<div class="cs2-fc-doneview light">
            <div class="dv-ico plain"><i class="fa-solid fa-scroll" aria-hidden="true"></i></div>
            <h3>That's all ${total}</h3>
            <p>You skipped past them without answering — no score to show. Worth a real attempt: this is exactly how NEET will ask it.</p>
            <button type="button" class="cs2-ghost-btn" onclick="csPgJump('pyq-${blockId}',0)">
                <i class="fa-solid fa-rotate-left" aria-hidden="true"></i> Start from the first question</button>
        </div>`;
    }
    const pct = Math.round((right / done) * 100);
    const ringId = `cs2-pyqring-${blockId}`;
    setTimeout(() => csAnimateRing(ringId), 60);
    return `<div class="cs2-fc-doneview light">
        <div style="display:flex;justify-content:center;">${csRingHTML(ringId, pct, 92, 8)}</div>
        <h3>${right} of ${done} correct</h3>
        <p>${wrongKeys.length === 0
            ? (done === total ? 'Clean sweep across every question, Doctor.' : 'Everything you attempted, right.')
            : `${wrongKeys.length} to look at again${done < total ? ` · ${total - done} unattempted` : ''}`}</p>
        <div class="dv-actions">
            ${wrongKeys.length ? `<button type="button" class="cs2-check-btn" onclick="csPyqRetryWrong('${blockId}')">
                <i class="fa-solid fa-rotate-right" aria-hidden="true"></i> Retry the ${wrongKeys.length} I missed</button>` : ''}
            <button type="button" class="cs2-ghost-btn" onclick="csCloseLayer()">
                <i class="fa-solid fa-list-ul" aria-hidden="true"></i> Back to the block</button>
        </div>
    </div>`;
}

function csPyqRetryWrong(blockId) {
    const { wrongKeys } = csPyqScore(blockId);
    if (!wrongKeys.length) return;
    wrongKeys.forEach(k => { reviseState.qState[k] = { selected: null, submitted: false }; });
    const pg = reviseState.pagers[`pyq-${blockId}`];
    if (!pg) return;
    const first = pg.items.findIndex(i => i.key === wrongKeys[0]);
    csHaptic(8);
    if (first >= 0) csPgJump(`pyq-${blockId}`, first);
}

function csRenderQuestionItem(item) {
    const q = item.q;
    const key = item.key;
    if (!reviseState.qState[key]) reviseState.qState[key] = { selected: null, submitted: false };
    const st = reviseState.qState[key];
    const options = q.options || [];
    const correct = (reviseState.qIndex[key] || {}).correct || '';

    const tags = item.kind === 'real'
        ? `${q.year ? `<span class="cs2-chip year"><i class="fa-solid fa-scroll" style="font-size:.55rem;" aria-hidden="true"></i>NEET ${escapeHtml(String(q.year))}</span>` : '<span class="cs2-chip year">Real NEET</span>'}
           ${q.difficulty ? `<span class="cs2-chip">${escapeHtml(q.difficulty)}</span>` : ''}
           ${q.revision_priority === 'critical' ? '<span class="cs2-chip star">Critical</span>' : ''}`
        : `<span class="cs2-chip grad"><i class="fa-solid fa-dumbbell" style="font-size:.55rem;" aria-hidden="true"></i>Practice variant</span>
           ${q.variant_type ? `<span class="cs2-chip">${escapeHtml((q.variant_type || '').replace(/_/g, ' '))}</span>` : ''}`;

    const opts = options.map(opt => {
        let cls = 'cs2-opt';
        if (st.submitted) {
            cls += ' locked';
            if (opt.id === correct) cls += ' correct';
            else if (opt.id === st.selected) cls += ' wrong';
        } else if (opt.id === st.selected) cls += ' sel';
        return `<button type="button" class="${cls}" id="csq-${key}-${opt.id}" role="radio"
            aria-checked="${opt.id === st.selected}" ${st.submitted ? 'disabled' : ''}
            onclick="csQSel('${key}','${opt.id}')">
            <span class="key">${escapeHtml(opt.id)}</span><span class="ot">${safeHtml(opt.text)}</span>
        </button>`;
    }).join('');

    let reveal = '';
    if (item.kind === 'real') {
        reveal = `
            <div class="cs2-callout"><span class="co-tag"><i class="fa-solid fa-check" aria-hidden="true"></i> Answer: ${escapeHtml(q.correct_answer || '?')}</span>
                ${q.student_tip ? safeHtml(q.student_tip) : ''}</div>
            ${q.static_explanation ? csAcc('Full step-by-step explanation', 'fa-list-ol',
            `<div class="cs2-prose">${safeHtml(q.static_explanation)}</div>`) : ''}
            ${(q.alternate_question_forms || []).length ? `
            <div class="cs2-callout" style="margin-top:10px;">
                <span class="co-tag"><i class="fa-solid fa-shuffle" aria-hidden="true"></i> NEET also asks this as</span>
                <div class="cs2-tick-list" style="margin-top:4px;">
                    ${q.alternate_question_forms.map(a => `<div class="cs2-tick" style="font-size:.82rem;">${safeHtml(a)}</div>`).join('')}
                </div>
            </div>` : ''}`;
    } else {
        reveal = `
            <div class="cs2-callout"><span class="co-tag"><i class="fa-solid fa-check" aria-hidden="true"></i> Answer: ${escapeHtml(q.correct_answer || '?')}</span></div>
            ${(q.solution_steps || []).length ? `
            <div class="cs2-scenario" style="margin-top:10px;">
                ${q.solution_steps.map((s, i) => `
                <div class="cs2-step">
                    <div class="rail"><div class="n">${i + 1}</div>${i < q.solution_steps.length - 1 ? '<div class="l"></div>' : ''}</div>
                    <div class="txt">${safeHtml(s)}</div>
                </div>`).join('')}
            </div>` : ''}`;
    }

    return `
        <div class="cs2-q-tags">${tags}</div>
        <div class="cs2-q-text">${safeHtml(q.question_text || '')}</div>
        <div role="radiogroup" aria-label="Answer options">${opts}</div>
        <button type="button" class="cs2-check-btn" id="csq-check-${key}" onclick="csQSubmit('${key}')"
            ${st.selected && !st.submitted ? '' : 'disabled'} ${st.submitted ? 'style="display:none;"' : ''}>Check answer</button>
        <div class="cs2-reveal" id="csq-reveal-${key}" aria-live="polite" ${st.submitted ? '' : 'style="display:none;"'}>${reveal}</div>`;
}

function csQSel(key, optId) {
    const st = reviseState.qState[key];
    if (!st || st.submitted) return;
    st.selected = optId;
    csHaptic(5);
    document.querySelectorAll(`[id^="csq-${key}-"]`).forEach(el => {
        el.classList.remove('sel'); el.setAttribute('aria-checked', 'false');
    });
    const el = document.getElementById(`csq-${key}-${optId}`);
    if (el) { el.classList.add('sel'); el.setAttribute('aria-checked', 'true'); }
    const btn = document.getElementById(`csq-check-${key}`);
    if (btn) btn.disabled = false;
}

function csQSubmit(key) {
    const st = reviseState.qState[key];
    if (!st || !st.selected || st.submitted) return;
    st.submitted = true;
    const correct = (reviseState.qIndex[key] || {}).correct || '';
    csHaptic(st.selected === correct ? 12 : [8, 40, 8]);
    document.querySelectorAll(`[id^="csq-${key}-"]`).forEach(el => {
        const id = el.id.replace(`csq-${key}-`, '');
        el.classList.add('locked'); el.classList.remove('sel');
        el.disabled = true;
        if (id === correct) el.classList.add('correct');
        else if (id === st.selected) el.classList.add('wrong');
    });
    const btn = document.getElementById(`csq-check-${key}`);
    if (btn) btn.style.display = 'none';
    const reveal = document.getElementById(`csq-reveal-${key}`);
    if (reveal) reveal.style.display = 'block';
}

// ════════════════════════════════════════════════════════════════
// FLASHCARDS — full-screen dark takeover
//
// Two v2 promises the code did not keep, both fixed here:
//   • the station said "hard cards first" and the deck was unsorted;
//   • the button said "Review again" and the card never came back.
// The deck is now a queue: "Review again" pushes the card to the end,
// once, so it is genuinely reviewed again before you leave.
// ════════════════════════════════════════════════════════════════
const CS_DIFF_RANK = { hard: 0, medium: 1, easy: 2 };

// Plain-text length, for deciding how big a card's type can be.
function csPlainLen(s) {
    return String(s || '').replace(/<[^>]*>/g, '').trim().length;
}

// A flashcard that scrolls is not a flashcard. Fit the type to the
// content instead of fixing the type and letting the content overflow.
function csFitCls(len) {
    if (len <= 80) return 'fs-xl';
    if (len <= 160) return 'fs-l';
    if (len <= 300) return 'fs-m';
    if (len <= 500) return 'fs-s';
    if (len <= 800) return 'fs-xs';
    return 'fs-xxs';
}

function csFcInit(cards) {
    const all = (cards || []).slice();
    // Hardest first — decreasing difficulty is how you spend attention
    // while you still have it. Stable within a difficulty band.
    const order = all.map((c, i) => i).sort((a, b) => {
        const ra = CS_DIFF_RANK[String(all[a].difficulty || 'medium').toLowerCase()] ?? 1;
        const rb = CS_DIFF_RANK[String(all[b].difficulty || 'medium').toLowerCase()] ?? 1;
        return ra - rb || a - b;
    });
    return { allCards: all, order, pos: 0, flipped: false, results: {}, hist: [], requeued: new Set() };
}

function csRenderFlashcards(blockId) {
    const state = reviseState._fcState[blockId];
    const cards = state ? state.allCards : [];
    if (!cards || cards.length === 0)
        return '<div class="cs2-empty" style="color:#64748b;"><i class="fa-solid fa-layer-group" style="color:#334155;" aria-hidden="true"></i>No flashcards for this block.</div>';
    return `<div id="cs2-fc-${blockId}">${csFcHTML(blockId)}</div>`;
}

function csFcHTML(blockId) {
    const state = reviseState._fcState[blockId];
    if (!state) return '';
    const { allCards, order, pos, results, flipped, requeued, hist } = state;
    const total = allCards.length;

    // ── completion view ──
    if (pos >= order.length) {
        const missed = Object.keys(results).filter(k => !results[k]).map(Number);
        const correct = total - missed.length;
        const pct = total ? Math.round((correct / total) * 100) : 0;
        const ringId = `cs2-fcring-${blockId}`;
        setTimeout(() => csAnimateRing(ringId), 60);
        return `<div class="cs2-fc-doneview">
            <div style="display:flex;justify-content:center;">${csRingHTML(ringId, pct, 96, 8)}</div>
            <h3>All ${total} card${total !== 1 ? 's' : ''} done</h3>
            <p>${correct} of ${total} landed${missed.length ? ` — ${missed.length} still shaky` : ' — clean sweep, Doctor'}</p>
            <div class="dv-actions">
                ${missed.length ? `<button type="button" class="cs2-fc-btn got" onclick="revFcPractiseMissed('${blockId}')">
                    <i class="fa-solid fa-bolt" aria-hidden="true"></i> Practise the ${missed.length} I missed</button>` : ''}
                <button type="button" class="cs2-fc-restart" onclick="revRestartCards('${blockId}')">
                    <i class="fa-solid fa-rotate-right" aria-hidden="true"></i> Go through all ${total} again</button>
            </div>
        </div>`;
    }

    const ci = order[pos];
    const c = allCards[ci];
    const diff = c.difficulty || 'Medium';
    const diffCls = String(diff).toLowerCase() === 'hard' ? 'hard' : String(diff).toLowerCase() === 'easy' ? 'easy' : '';
    const typeLabel = c.card_type === 'fill_blank' ? 'Fill blank'
        : c.card_type === 'mcq' ? 'MCQ'
            : (c.card_type || 'concept').replace(/_/g, ' ');
    const isSecondLook = requeued.has(ci) && order.indexOf(ci) < pos;
    // The back is sized against everything on it, not just the answer.
    const backFit = csFitCls(csPlainLen(c.back || c.answer) + csPlainLen(c.common_mistake) + 40);

    return `
        <div class="cs2-pg-top">
            <div class="cs2-pg-segs" role="progressbar" aria-valuemin="1" aria-valuemax="${order.length}" aria-valuenow="${pos + 1}">
                ${order.map((_, i) => {
        const st = hist[i];
        return `<div class="cs2-pg-seg ${i === pos ? 'cur' : ''} ${st === true ? 'ok' : st === false ? 'no' : ''}"></div>`;
    }).join('')}
            </div>
            <div class="cs2-pg-count">${pos + 1} / ${order.length}</div>
        </div>
        <div class="cs2-fc-stage" id="cs2-fc-stage-${blockId}">
            <div class="cs2-fc-scene" onclick="revFlipCard('${blockId}')" role="button" tabindex="0"
                aria-label="Flashcard — activate to reveal the answer">
                <div class="cs2-fc-inner ${flipped ? 'flipped' : ''}" id="cs2-fc-inner-${blockId}">
                    <div class="cs2-fc-face cs2-fc-front">
                        <div class="cs2-fc-pills">
                            <span class="cs2-fc-pill ${diffCls}">${escapeHtml(String(diff))}</span>
                            <span class="cs2-fc-pill">${escapeHtml(typeLabel)}</span>
                            ${isSecondLook ? '<span class="cs2-fc-pill again"><i class="fa-solid fa-rotate-right" style="font-size:.5rem;" aria-hidden="true"></i> Second look</span>' : ''}
                        </div>
                        <div class="cs2-fc-q ${csFitCls(csPlainLen(c.front || c.question))}"><div class="fq-in">${safeHtml(c.front || c.question || '')}</div></div>
                        <div class="cs2-fc-hint"><i class="fa-regular fa-hand-pointer" aria-hidden="true"></i> Tap to reveal</div>
                    </div>
                    <div class="cs2-fc-face cs2-fc-back">
                        <div class="cs2-fc-albl">Answer</div>
                        <div class="cs2-fc-ans ${backFit}"><div class="fq-in">${safeHtml(c.back || c.answer || '')}</div></div>
                        ${c.common_mistake ? `<div class="cs2-fc-mis ${backFit}"><strong style="color:#fecaca;">Common mistake:</strong> ${safeHtml(c.common_mistake)}</div>` : ''}
                        <div class="cs2-fc-swipehint"><i class="fa-solid fa-arrows-left-right" aria-hidden="true"></i> swipe left if you got it · right to review again</div>
                    </div>
                </div>
            </div>
            <div class="cs2-fc-actions" id="cs2-fc-actions-${blockId}" style="${flipped ? '' : 'visibility:hidden;'}">
                <button type="button" class="cs2-fc-btn got" onclick="revFcGot('${blockId}');event.stopPropagation();">
                    <i class="fa-solid fa-check" aria-hidden="true"></i> Got it
                </button>
                <button type="button" class="cs2-fc-btn" onclick="revFcRetry('${blockId}');event.stopPropagation();">
                    <i class="fa-solid fa-rotate-right" aria-hidden="true"></i> Review again
                </button>
            </div>
        </div>`;
}

function csFcRerender(blockId) {
    const wrap = document.getElementById(`cs2-fc-${blockId}`);
    if (wrap) { wrap.innerHTML = csFcHTML(blockId); csFcBindGestures(blockId); }
}

// Swipe + keyboard. A full-screen dark card that only answers to taps
// reads like a 2016 app.
function csFcBindGestures(blockId) {
    const stage = document.getElementById(`cs2-fc-stage-${blockId}`);
    if (!stage || stage._bound) return;
    stage._bound = true;
    let x0 = 0, y0 = 0, t0 = 0, dragging = false;
    const inner = () => document.getElementById(`cs2-fc-inner-${blockId}`);

    stage.addEventListener('touchstart', e => {
        const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; t0 = Date.now(); dragging = true;
    }, { passive: true });

    stage.addEventListener('touchmove', e => {
        const st = reviseState._fcState[blockId];
        if (!dragging || !st || !st.flipped) return;
        const dx = e.touches[0].clientX - x0;
        const el = inner();
        if (el && Math.abs(dx) > 8) {
            el.style.transition = 'none';
            el.style.transform = `rotateY(180deg) translateX(${-dx * 0.4}px) rotate(${-dx * 0.02}deg)`;
            // Tint the drag so the direction reads before you commit to it.
            el.classList.toggle('drag-got', dx < -20);
            el.classList.toggle('drag-again', dx > 20);
        }
    }, { passive: true });

    stage.addEventListener('touchend', e => {
        dragging = false;
        const st = reviseState._fcState[blockId];
        const el = inner();
        if (el) {
            el.style.transition = ''; el.style.transform = '';
            el.classList.remove('drag-got', 'drag-again');
        }
        if (!st || !st.flipped) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - x0, dy = t.clientY - y0;
        if (Date.now() - t0 < 700 && Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.4) {
            // Left = got it, right = review again (your call, not the
            // Tinder convention — flip the comparison to swap them back).
            if (dx < 0) revFcGot(blockId); else revFcRetry(blockId);
        }
    }, { passive: true });

    if (!stage._keys) {
        stage._keys = true;
        stage.addEventListener('keydown', e => {
            const st = reviseState._fcState[blockId];
            if (!st) return;
            if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); revFlipCard(blockId); }
            else if (st.flipped && e.key === 'ArrowLeft') { e.preventDefault(); revFcGot(blockId); }
            else if (st.flipped && e.key === 'ArrowRight') { e.preventDefault(); revFcRetry(blockId); }
        });
    }
}

function revFlipCard(blockId) {
    const state = reviseState._fcState[blockId];
    if (!state || state.pos >= state.order.length) return;
    state.flipped = !state.flipped;
    csHaptic(6);
    const inner = document.getElementById(`cs2-fc-inner-${blockId}`);
    if (inner) inner.classList.toggle('flipped', state.flipped);
    const actions = document.getElementById(`cs2-fc-actions-${blockId}`);
    if (actions) actions.style.visibility = state.flipped ? 'visible' : 'hidden';
}

// Sync one flashcard result to the backend
// (POST /api/revision/progress/update, action:"flashcard_result").
// Fire-and-forget: a failed sync never blocks the study flow.
function syncFlashcardResult(blockId, cardIndex, correct) {
    const state = reviseState._fcState[blockId];
    const card = state && state.allCards && state.allCards[cardIndex];
    apiCall('/api/revision/progress/update', 'POST', {
        chapter_id: reviseState.currentChapterId,
        chapter_name: reviseState.currentChapterName || '',
        total_blocks: reviseState.blockOrder.length,
        action: 'flashcard_result',
        block_id: blockId,
        current_block_index: reviseState.currentBlockIndex,
        flashcard_id: (card && card.flashcard_id) || `${blockId}_card_${cardIndex}`,
        correct: !!correct,
    }).catch(e => console.warn('Flashcard result sync failed (non-blocking):', e.message));
}

function revFcGot(blockId) {
    const state = reviseState._fcState[blockId];
    if (!state || state.pos >= state.order.length) return;
    const ci = state.order[state.pos];
    state.results[ci] = true;
    state.hist[state.pos] = true;
    syncFlashcardResult(blockId, ci, true);
    csHaptic(12);
    state.pos++; state.flipped = false;
    csFcRerender(blockId);
}

function revFcRetry(blockId) {
    const state = reviseState._fcState[blockId];
    if (!state || state.pos >= state.order.length) return;
    const ci = state.order[state.pos];
    state.results[ci] = false;
    state.hist[state.pos] = false;
    syncFlashcardResult(blockId, ci, false);
    csHaptic(6);
    // The button says "Review again" — so review it again. Once, at the
    // end of the deck, not on an endless loop.
    if (!state.requeued.has(ci)) { state.requeued.add(ci); state.order.push(ci); }
    state.pos++; state.flipped = false;
    csFcRerender(blockId);
}

function revRestartCards(blockId) {
    const state = reviseState._fcState[blockId];
    if (!state) return;
    reviseState._fcState[blockId] = csFcInit(state.allCards);
    csHaptic(8);
    csFcRerender(blockId);
}

function revFcPractiseMissed(blockId) {
    const state = reviseState._fcState[blockId];
    if (!state) return;
    const missed = Object.keys(state.results).filter(k => !state.results[k]).map(Number);
    if (!missed.length) return;
    missed.forEach(i => { delete state.results[i]; });
    state.order = missed;
    state.pos = 0;
    state.flipped = false;
    state.hist = [];
    state.requeued = new Set();
    csHaptic(10);
    csFcRerender(blockId);
}

// ════════════════════════════════════════════════════════════════
// VISUAL MAP — concept map + flowchart
// ════════════════════════════════════════════════════════════════
function csRenderVisual(data) {
    const cm = data.concept_map || {}; const fc = data.flowchart || {};
    let html = '';
    if (cm.node_label) {
        const kids = cm.child_nodes || [];
        const rels = (cm.key_relationships || []).map(r => `
            <div class="cs2-rel">
                <span class="fr">${escapeHtml(r.from || '')}</span>
                <span class="rl">${escapeHtml(r.relation || '→')}</span>
                <span class="to">${escapeHtml(r.to || '')}</span>
            </div>`).join('');
        html += `<div class="cs2-sec">${csSecLabel('Concept map')}
            <div class="cs2-map">
                ${cm.parent_node ? `<div class="cs2-map-row">
                    <span class="cs2-map-node parent" data-node="${escapeHtml(cm.parent_node)}">${escapeHtml(cm.parent_node)}</span>
                </div><div class="cs2-map-link"></div>` : ''}
                <div class="cs2-map-row">
                    <span class="cs2-map-node root" data-node="${escapeHtml(cm.node_label)}">${escapeHtml(cm.node_label)}</span>
                </div>
                ${kids.length ? `<div class="cs2-map-link"></div>
                <div class="cs2-map-fan">
                    ${kids.map(c => `<span class="cs2-map-child">${escapeHtml(c)}</span>`).join('')}
                </div>` : ''}
            </div>
            ${rels ? `<div style="margin-top:16px;">
                <div class="cs2-micro" style="margin-bottom:8px;">Key relationships</div>
                <div class="cs2-rels" id="cs2-rels">${rels}</div>
            </div>` : ''}
            ${cm.one_liner ? `<div class="cs2-callout" style="margin-top:14px;"><span class="co-tag"><i class="fa-solid fa-pen" aria-hidden="true"></i> In one line</span>${escapeHtml(cm.one_liner)}</div>` : ''}
        </div>`;
    }
    if ((fc.nodes || []).length > 0) {
        html += `<div class="cs2-sec">${csSecLabel(escapeHtml(fc.title || 'Process flow'))}
            <div class="cs2-flow-wrap">${buildFlowchartSVG(fc)}</div>
        </div>`;
    }
    if (!html) return '<div class="cs2-empty"><i class="fa-solid fa-diagram-project" aria-hidden="true"></i>No visualization data for this block.</div>';
    return html;
}

// ── flowchart SVG ────────────────────────────────────────────────
// v2 hardcoded six hex colours inside a stylesheet whose stated rule is
// "one accent, palette vars only", sized 190px nodes into a 560 viewBox
// (≈8px text on a phone), never wrapped a label, and printed the words
// "Option A" / "Option B" when a comparison chart arrived without
// column names. All four are fixed below.
function csWrapLabel(text, maxChars, maxLines) {
    const words = String(text || '').trim().split(/\s+/);
    const lines = []; let cur = '';
    for (const w of words) {
        if (!cur.length) { cur = w; continue; }
        if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
        else { lines.push(cur); cur = w; if (lines.length === maxLines - 1) break; }
    }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) lines.length = maxLines;
    const used = lines.join(' ').length;
    if (used < String(text || '').trim().length) {
        lines[lines.length - 1] = csSnippet(lines[lines.length - 1] + ' …', maxChars + 1);
    }
    return lines;
}

function csNodeSVG(x, y, w, label, isDecision, fontSize) {
    const lines = csWrapLabel(label, Math.floor(w / (fontSize * 0.54)), 3);
    const lh = fontSize * 1.28;
    const h = Math.max(46, lines.length * lh + 22);
    const fill = isDecision ? 'var(--cs-grad-soft-solid)' : 'var(--cs-card)';
    const stroke = isDecision ? 'var(--g400)' : 'var(--cs-line)';
    const color = isDecision ? 'var(--indigo)' : 'var(--s700)';
    const cx = x + w / 2;
    const y0 = y + h / 2 - ((lines.length - 1) * lh) / 2;
    const text = lines.map((ln, i) =>
        `<tspan x="${cx}" y="${(y0 + i * lh).toFixed(1)}">${escapeHtml(ln)}</tspan>`).join('');
    return {
        h, svg: `<g class="cs2-node"><rect x="${x}" y="${y}" width="${w}" height="${h.toFixed(1)}" rx="12"
            fill="${fill}" stroke="${stroke}" stroke-width="1.4"/>
        <text text-anchor="middle" dominant-baseline="central" font-family="var(--font-body, sans-serif)"
            font-size="${fontSize}" font-weight="${isDecision ? '700' : '500'}" fill="${color}">${text}</text></g>`
    };
}

function buildFlowchartSVG(fc) {
    const nodes = fc.nodes || []; const edges = fc.edges || [];
    const chartType = fc.chart_type || 'linear';
    if (nodes.length === 0) return '';
    if (chartType === 'comparison') return buildComparisonFlowchart(fc, nodes);

    // Sized for a phone: a 340-wide viewBox means the 12.5px label really
    // renders at ~12.5px, instead of being scaled down to ~8px.
    const SVG_W = 340, NODE_W = 250, GAP_Y = 34, FS = 12.5;
    const x = (SVG_W - NODE_W) / 2, cx = SVG_W / 2;
    let y = 8; const tops = [], bots = []; let body = '';
    nodes.forEach(n => {
        const isDecision = n.type === 'decision';
        const { h, svg } = csNodeSVG(x, y, NODE_W, (n.label || n.id || '').trim(), isDecision, FS);
        tops.push(y); bots.push(y + h); body += svg;
        y += h + GAP_Y;
    });
    const svgH = y - GAP_Y + 8;
    const drawEdge = (fi, ti) => `<line x1="${cx}" y1="${bots[fi]}" x2="${cx}" y2="${tops[ti] - 6}"
        stroke="var(--s300)" stroke-width="1.5" marker-end="url(#cs2-fc-arrow)"/>`;
    let edgesHTML = '';
    if (edges.length > 0) {
        edgesHTML = edges.map(e => {
            const fi = nodes.findIndex(n => n.id === e.from); const ti = nodes.findIndex(n => n.id === e.to);
            if (fi < 0 || ti < 0 || fi === ti) return '';
            return drawEdge(fi, ti);
        }).join('');
    } else {
        edgesHTML = nodes.slice(0, -1).map((_, i) => drawEdge(i, i + 1)).join('');
    }
    return `<svg width="100%" viewBox="0 0 ${SVG_W} ${svgH.toFixed(1)}" xmlns="http://www.w3.org/2000/svg"
        role="img" aria-label="${escapeHtml(fc.title || 'Process flow diagram')}" style="min-width:300px;max-width:420px;margin:0 auto;display:block;">
        <defs><marker id="cs2-fc-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M2 1L8 5L2 9" fill="none" stroke="var(--s300)" stroke-width="1.5" stroke-linecap="round"/></marker></defs>
        ${edgesHTML}${body}</svg>`;
}

function buildComparisonFlowchart(fc, nodes) {
    // Only label the columns if the data actually says what they are.
    // "Option A" / "Option B" is a placeholder, and a placeholder shipped
    // to a student reads as an unfinished product.
    const labels = fc.column_labels || fc.columns ||
        [fc.left_label, fc.right_label].filter(Boolean);
    const hasLabels = Array.isArray(labels) && labels.length >= 2;
    const mid = Math.ceil(nodes.length / 2);
    const cols = [nodes.slice(0, mid), nodes.slice(mid)];
    const SVG_W = 344, NODE_W = 160, GAP = 8, GAP_Y = 14, FS = 10.5;
    const xs = [GAP, SVG_W - NODE_W - GAP];
    const headH = hasLabels ? 32 : 0;
    let maxY = 0; let body = '';
    cols.forEach((col, ci) => {
        let y = headH ? headH + 12 : 8;
        if (hasLabels) {
            body += `<rect x="${xs[ci]}" y="6" width="${NODE_W}" height="26" rx="9"
                fill="${ci === 0 ? 'var(--cs-grad-soft-solid)' : 'var(--cs-teal-soft-solid)'}"/>
                <text x="${xs[ci] + NODE_W / 2}" y="19.5" text-anchor="middle" dominant-baseline="central"
                    font-family="var(--font-body, sans-serif)" font-size="11" font-weight="700"
                    fill="${ci === 0 ? 'var(--g600)' : 'var(--indigo)'}">${escapeHtml(csSnippet(labels[ci], 22))}</text>`;
        }
        col.forEach(n => {
            const { h, svg } = csNodeSVG(xs[ci], y, NODE_W, (n.label || n.id || '').trim(), false, FS);
            body += svg; y += h + GAP_Y;
        });
        maxY = Math.max(maxY, y);
    });
    const svgH = maxY - GAP_Y + 8;
    return `<svg width="100%" viewBox="0 0 ${SVG_W} ${svgH.toFixed(1)}" xmlns="http://www.w3.org/2000/svg"
        role="img" aria-label="${escapeHtml(fc.title || 'Comparison diagram')}" style="min-width:300px;max-width:420px;margin:0 auto;display:block;">
        ${body}</svg>`;
}

// ════════════════════════════════════════════════════════════════
// LIGHTBOX — a real one: pinch-zoom, double-tap, pan, page nav.
// v2's "tap to zoom" toggled a max-height class. On a full NCERT page
// of body text that is not a zoom, it is a taller thumbnail.
// ════════════════════════════════════════════════════════════════
const csLbState = { items: [], cur: 0, zoom: 1, title: '' };

function csLightbox(items, startIdx, title) {
    csLbState.items = items; csLbState.cur = startIdx || 0; csLbState.zoom = 1; csLbState.title = title || '';
    let el = document.getElementById('cs2-lightbox');
    if (el) el.remove();
    el = document.createElement('div');
    el.className = 'cs2-lb';
    el.id = 'cs2-lightbox';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML = `
        <div class="cs2-lb-head">
            <button type="button" class="cs2-head-btn" onclick="csLbClose()" aria-label="Close viewer">
                <i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
            <div class="cs2-lb-title" id="cs2-lb-title"></div>
            <button type="button" class="cs2-head-btn" onclick="csLbZoom(-1)" aria-label="Zoom out">
                <i class="fa-solid fa-magnifying-glass-minus" aria-hidden="true"></i></button>
            <button type="button" class="cs2-head-btn" onclick="csLbZoom(1)" aria-label="Zoom in">
                <i class="fa-solid fa-magnifying-glass-plus" aria-hidden="true"></i></button>
        </div>
        <div class="cs2-lb-stage" id="cs2-lb-stage">
            <img id="cs2-lb-img" alt="" ondblclick="csLbZoom(0)">
        </div>
        <div class="cs2-lb-foot" id="cs2-lb-foot"></div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));
    csLbPaint();
    document.addEventListener('keydown', csLbKeys);
}

function csLbPaint() {
    const it = csLbState.items[csLbState.cur];
    if (!it) return;
    const img = document.getElementById('cs2-lb-img');
    const t = document.getElementById('cs2-lb-title');
    const foot = document.getElementById('cs2-lb-foot');
    if (img) { img.src = absUrl(it.url); img.alt = it.caption || 'Figure'; img.style.width = (csLbState.zoom * 100) + '%'; }
    if (t) t.textContent = it.caption || csLbState.title;
    if (foot) {
        foot.innerHTML = csLbState.items.length > 1 ? `
            <button type="button" onclick="csLbGo(-1)" ${csLbState.cur === 0 ? 'disabled' : ''} aria-label="Previous">
                <i class="fa-solid fa-arrow-left" aria-hidden="true"></i></button>
            <span class="lb-count">${csLbState.cur + 1} / ${csLbState.items.length}</span>
            <button type="button" onclick="csLbGo(1)" ${csLbState.cur >= csLbState.items.length - 1 ? 'disabled' : ''} aria-label="Next">
                <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>` : '';
    }
}

function csLbGo(d) {
    const n = csLbState.cur + d;
    if (n < 0 || n >= csLbState.items.length) return;
    csLbState.cur = n; csLbState.zoom = 1;
    csHaptic(5);
    const stage = document.getElementById('cs2-lb-stage');
    if (stage) stage.scrollTo({ top: 0, left: 0 });
    csLbPaint();
}

function csLbZoom(d) {
    const z = csLbState.zoom;
    csLbState.zoom = d === 0 ? (z > 1 ? 1 : 2.4) : Math.min(4, Math.max(1, z + d * 0.6));
    csHaptic(4);
    const img = document.getElementById('cs2-lb-img');
    if (img) img.style.width = (csLbState.zoom * 100) + '%';
}

function csLbKeys(e) {
    if (!document.getElementById('cs2-lightbox')) return;
    if (e.key === 'Escape') csLbClose();
    else if (e.key === 'ArrowRight') csLbGo(1);
    else if (e.key === 'ArrowLeft') csLbGo(-1);
}

function csLbClose() {
    const el = document.getElementById('cs2-lightbox');
    document.removeEventListener('keydown', csLbKeys);
    if (!el) return;
    el.classList.remove('in');
    setTimeout(() => el.remove(), 240);
}

// ════════════════════════════════════════════════════════════════
// NCERT PAGES — no longer a station; opens from Understand
// ════════════════════════════════════════════════════════════════
function csOpenPages(blockId) {
    const data = reviseState.loadedBlocks[blockId] || {};
    const pageUrls = data.page_urls || {};
    const sourcePages = data.source_pages || [];
    const pages = sourcePages.length ? sourcePages
        : Object.keys(pageUrls).map(k => parseInt(k.replace('page_', '').replace('.png', ''), 10))
            .filter(n => !isNaN(n)).sort((a, b) => a - b);
    const items = pages
        .map(pg => ({ url: pageUrls[`page_${pg}.png`] || '', caption: `NCERT page ${pg}` }))
        .filter(i => i.url);
    if (!items.length) { ndToast('No NCERT page scans for this block.', 'error'); return; }
    csHaptic(8);
    csLightbox(items, 0, 'NCERT source');
}

// ════════════════════════════════════════════════════════════════
// FIGURES — one figure per page, figure pinned while labels scroll
// ════════════════════════════════════════════════════════════════
function csRenderFigures(blockId, figDetails) {
    if (!figDetails || !figDetails.length)
        return '<div class="cs2-empty"><i class="fa-solid fa-image" aria-hidden="true"></i>No figures linked to this block.</div>';
    const pagerKey = `figs-${blockId}`;
    csInitPager(pagerKey, figDetails, (fig, fi) => csRenderFigureItem(blockId, fig, fi));
    return csPagerHTML(pagerKey);
}

function csFigOpen(blockId, fi) {
    const figs = (reviseState.loadedBlocks[blockId] || {}).linked_figure_details || [];
    const items = figs.filter(f => f.image_url).map(f => ({
        url: f.image_url, caption: f.name || f.label || 'Figure',
    }));
    const start = Math.max(0, items.findIndex(i => i.url === (figs[fi] || {}).image_url));
    if (!items.length) return;
    csHaptic(8);
    csLightbox(items, start, 'Figure');
}

function csRenderFigureItem(blockId, fig, fi) {
    const a = fig.image_analysis || {};
    const components = a.labeled_components || [];
    const angles = a.neet_question_angles || [];
    const crossLinks = a.cross_chapter_links || [];
    const nums = a.numerical_relationships || [];
    const hasCoords = components.some(c => c && c.x != null && c.y != null);

    // If the analysis ever carries coordinates, the labels belong ON the
    // figure — that is how figure questions are actually asked. Until
    // then, the figure stays pinned while the labels scroll past it, and
    // tapping a label highlights its marker or its row.
    const hotspots = hasCoords ? `<div class="cs2-hotspots">
        ${components.map((c, i) => (c.x == null || c.y == null) ? '' : `
        <button type="button" class="cs2-hot" id="cs2-hot-${blockId}-${fi}-${i}"
            style="left:${c.x}%;top:${c.y}%;" onclick="csFigLabel('${blockId}',${fi},${i})"
            aria-label="${escapeHtml(c.label || '')}">${i + 1}</button>`).join('')}
    </div>` : '';

    return `
        <div class="cs2-q-tags">
            <span class="cs2-chip grad">${escapeHtml(fig.label || 'Figure')}</span>
            ${fig.name ? `<span class="cs2-chip">${escapeHtml(csSnippet(fig.name, 36))}</span>` : ''}
        </div>

        ${a.suggested_flashcard_front ? `<div class="cs2-figq">
            <span class="cs2-micro">Before you read on</span>
            <div>${safeHtml(a.suggested_flashcard_front)}</div>
        </div>` : ''}

        ${fig.image_url ? `<div class="cs2-fig-pin">
            <div class="cs2-fig-img">
                <div class="fig-holder">
                    <img src="${absUrl(fig.image_url)}" alt="${escapeHtml(fig.name || fig.label || 'Figure')}"
                        id="cs2-fig-img-${blockId}-${fi}" onclick="csFigOpen('${blockId}',${fi})">
                    ${hotspots}
                </div>
                <button type="button" class="fig-zoom" onclick="csFigOpen('${blockId}',${fi})">
                    <i class="fa-solid fa-up-right-and-down-left-from-center" aria-hidden="true"></i> Tap to open full screen
                </button>
            </div>
        </div>` : ''}

        ${a.concept_illustrated ? `<div class="cs2-prose" style="margin-bottom:14px;">${safeHtml(a.concept_illustrated)}</div>` : ''}

        ${components.length ? `<div class="cs2-sec">${csSecLabel(`Labeled components · ${components.length}`)}
            ${components.map((c, i) => `<button type="button" class="cs2-comp" id="cs2-comp-${blockId}-${fi}-${i}"
                onclick="csFigLabel('${blockId}',${fi},${i})">
                <span class="lbl">${escapeHtml(c.label)}</span><span class="cm">${safeHtml(c.meaning)}</span>
            </button>`).join('')}
        </div>` : ''}

        ${a.process_description ? `<div class="cs2-sec">${csAcc('Step-by-step process', 'fa-list-ol',
        `<div class="cs2-prose">${safeHtml(a.process_description)}</div>`)}</div>` : ''}

        ${angles.length ? `<div class="cs2-sec">
            <div class="cs2-callout"><span class="co-tag"><i class="fa-solid fa-bullseye" aria-hidden="true"></i> NEET asks this figure as</span>
                <div class="cs2-tick-list" style="margin-top:4px;">
                    ${angles.map(x => `<div class="cs2-tick" style="font-size:.83rem;">${safeHtml(x)}</div>`).join('')}
                </div>
            </div></div>` : ''}

        ${a.common_misconception ? `<div class="cs2-sec">
            <div class="cs2-callout danger"><span class="co-tag"><i class="fa-solid fa-xmark" aria-hidden="true"></i> Common misconception</span>
            ${safeHtml(a.common_misconception)}</div></div>` : ''}

        ${nums.length ? `<div class="cs2-sec">${csAcc('Key numbers & equations', 'fa-square-root-variable',
            `<div class="cs2-numbers">${nums.map(n => `<div class="row">${safeHtml(n)}</div>`).join('')}</div>`)}
        </div>` : ''}

        ${crossLinks.length ? `<div class="cs2-sec">
            <div class="cs2-micro" style="margin-bottom:7px;">Also shows up in</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;">
                ${crossLinks.map(cl => `<span class="cs2-chip flat">${escapeHtml(cl)}</span>`).join('')}
            </div></div>` : ''}`;
}

// Tapping a label lights up its row and, where coordinates exist, its
// marker on the pinned figure.
function csFigLabel(blockId, fi, i) {
    const scope = `${blockId}-${fi}`;
    document.querySelectorAll(`[id^="cs2-comp-${scope}-"], [id^="cs2-hot-${scope}-"]`)
        .forEach(el => el.classList.remove('active'));
    document.getElementById(`cs2-comp-${scope}-${i}`)?.classList.add('active');
    document.getElementById(`cs2-hot-${scope}-${i}`)?.classList.add('active');
    csHaptic(5);
}

// ════════════════════════════════════════════════════════════════
// MARK BLOCK DONE — same API contract
// ════════════════════════════════════════════════════════════════
async function markNewBlockDone(blockId) {
    const btn = document.getElementById(`rev-done-${blockId}`);
    if (!btn || btn.disabled) return;

    // A block marked done without a single section opened makes every
    // ring in the app a lie. One soft nudge, then the student's call.
    const opened = (reviseState.visited[blockId] || new Set()).size;
    if (opened === 0 && !reviseState.doneArmed) {
        reviseState.doneArmed = true;
        btn.classList.add('warn-state');
        btn.innerHTML = '<i class="fa-solid fa-circle-question" aria-hidden="true"></i> Nothing opened yet — mark done anyway?';
        csHaptic(10);
        setTimeout(() => {
            if (reviseState.doneArmed && document.body.contains(btn)) {
                reviseState.doneArmed = false;
                btn.classList.remove('warn-state');
                btn.innerHTML = '<i class="fa-solid fa-circle-check" aria-hidden="true"></i> Mark block done';
            }
        }, 4000);
        return;
    }
    reviseState.doneArmed = false;
    btn.classList.remove('warn-state');
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;margin:0 auto;border-color:rgba(255,255,255,.4);border-top-color:#fff;"></div>';
    reviseState.blocksCompleted.add(blockId);
    const idx = reviseState.blockOrder.indexOf(blockId);
    const nextIncomplete = reviseState.blockOrder.findIndex(bid => !reviseState.blocksCompleted.has(bid));
    try {
        await apiCall('/api/revision/progress/update', 'POST', {
            chapter_id: reviseState.currentChapterId, action: 'complete',
            // chapter_name is persisted on the progress doc so the Home screen
            // can deep-link straight back into this journey with no extra call.
            chapter_name: reviseState.currentChapterName || '',
            block_id: blockId,
            current_block_index: nextIncomplete >= 0 ? nextIncomplete : idx + 1,
            total_blocks: reviseState.blockOrder.length,
        });
        // Completing a block earns the study day (once per IST day).
        if (typeof pingStreak === 'function') pingStreak('studio_block');
    } catch (e) {
        console.error('Progress save failed:', e);
        ndToast('Could not save progress — check your connection.', 'error');
    }
    btn.classList.add('done-state');
    btn.innerHTML = '<i class="fa-solid fa-check-circle" aria-hidden="true"></i> Block completed';
    csHaptic([14, 50, 20]);

    // update the header chapter bar immediately
    const { pct, done, total } = journeyHeaderStats();
    const bar = document.getElementById('cs2-blk-bar');
    if (bar) bar.style.width = pct + '%';

    const nextSummary = nextIncomplete >= 0
        ? (reviseState.blockSummaries[reviseState.blockOrder[nextIncomplete]] || {}) : null;
    csSuccessMoment({
        title: done >= total ? 'Chapter complete!' : 'Block done',
        sub: done >= total
            ? `All ${total} concepts covered. Great work, Doctor.`
            : nextSummary ? `Next up: ${csSnippet(nextSummary.heading || 'the next block', 40)}` : `${done} of ${total} concepts done`,
        onEnd: () => { if (nextIncomplete >= 0) csOpenBlockByIndex(nextIncomplete); else renderChapterHome(); },
    });
}

// v2 froze the screen for 1200ms and then moved you somewhere without
// asking. Same celebration, but tapping it goes now, and it says where
// it is taking you.
function csSuccessMoment({ title, sub, onEnd }) {
    const s = document.createElement('div');
    s.className = 'cs2-success'; s.id = 'cs2-success';
    s.setAttribute('role', 'status');
    s.innerHTML = `
        <div class="ck"><i class="fa-solid fa-check" aria-hidden="true"></i></div>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(sub)}</p>
        <button type="button" class="sk">Continue <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>`;
    document.body.appendChild(s);
    let fired = false;
    const go = () => {
        if (fired) return; fired = true;
        s.remove();
        if (typeof onEnd === 'function') onEnd();
    };
    s.addEventListener('click', go);
    setTimeout(go, 1600);
}

console.log('Concept Studio v3 (mobile) module loaded ✅');