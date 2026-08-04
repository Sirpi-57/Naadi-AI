/* ════════════════════════════════════════════════════════════════
   NAADI AI — PRACTICE HUB (mobile)  practice-hub.js
   NEET Arena · PYQ Vault · AIR Rankings — landings, custom test
   builder, leaderboards, history and the shared segmented switcher.
   The shared OMR test-taking engine + results renderer live in
   test-engine.js. Requires shared.js (apiCall, ndToast, safeHtml,
   escapeHtml) and the view containers in app.html.

   ABSOLUTE CONTRACT RULES (see build spec §1):
     • backend.py is untouched — every call below uses the exact
       field names the desktop app already sends/consumes.
     • Arena attempts  → arena_session:true  + test_type:"full_paper"
     • PYQ attempts    → arena_session:false (custom OR full_paper)
     • AIR Rankings    → /api/arena/overall-leaderboard ONLY.
   ════════════════════════════════════════════════════════════════ */

// ── STATE (one state object per feature, same convention as
//    concept-studio.js) ─────────────────────────────────────────
const hubState = {
    arenaPapers: null,          // cached /api/arena/papers response
    pyqPapers: null,            // cached /api/pyq/papers response
    pyqMode: 'custom',          // 'custom' | 'papers' (PYQ landing sub-tab) — custom is the Vault's identity
    // Best-attempt lookup for paper cards: "year|paper_code" -> {marks, max, attempts}
    // Built client-side from the existing /history endpoints (no backend change).
    attemptMap: { arena: null, pyq: null },
    // Class → Subject → [chapters] tree, discovered ONCE from /api/pyq/filter
    // (subject × class fan-out) and cached. Lets us group the chapter picker
    // 11/12 → Phy/Chem/Bio → chapters WITHOUT renaming anything in the bank.
    chapterTree: null,          // { "11": {Physics:Set, ...}, "12": {...} }
    chapterTreeLoading: false,
    chapterSearch: '',          // live filter text for the chapter picker
    _openChapGroups: null,      // Set of "class|subject" groups expanded
    // Custom test builder filters
    filters: {
        year: '',               // '' = any
        ncert_class: '',        // '' | 11 | 12
        subjects: [],           // multi-select
        chapters: [],           // multi-select
        count: 20,              // requested question count
    },
    matchedQuestions: [],       // last /api/pyq/filter merged result
    matchedTotal: 0,
    filterLoading: false,
    _filterTimer: null,         // debounce handle (~400ms)
    _filterSeq: 0,              // ignore out-of-order responses
};

// NEET reservation category — remembered across tests on this device.
function getPracticeCategory() {
    return localStorage.getItem('NAADI_NEET_CATEGORY') || '';
}
function setPracticeCategory(cat) {
    localStorage.setItem('NAADI_NEET_CATEGORY', cat);
}

// ════════════════════════════════════════════════════════════════
// GENERIC BOTTOM SHEET (there is no existing mobile modal system —
// this small one is shared by the hub AND the test engine).
// ════════════════════════════════════════════════════════════════
function phOpenSheet(innerHtml, opts = {}) {
    phCloseSheet();
    const wrap = document.createElement('div');
    wrap.className = 'ph-sheet-overlay';
    wrap.id = 'ph-sheet-overlay';
    wrap.innerHTML = `<div class="ph-sheet" role="dialog">${innerHtml}</div>`;
    if (!opts.blockDismiss) {
        wrap.addEventListener('click', (e) => {
            if (e.target === wrap) phCloseSheet();
        });
    }
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add('open'));
}
function phCloseSheet() {
    const el = document.getElementById('ph-sheet-overlay');
    if (!el) return;
    el.classList.remove('open');
    setTimeout(() => el.remove(), 200);
}

// ════════════════════════════════════════════════════════════════
// SEGMENTED SWITCHER — rendered at the top of the three LANDING
// screens only (papers list / filter builder / rankings table).
// Drill-down screens (test / results / leaderboard / history)
// intentionally do NOT render it — they go focused/clean, the same
// way the Concept Studio journey hides the shell chrome.
// ════════════════════════════════════════════════════════════════
function hubSwitcherHtml(active) {
    const pill = (key, view, icon, label) => `
        <button class="ph-switch-pill ${active === key ? 'active' : ''}"
            onclick="${active === key ? '' : `navigate('${view}')`}">
            <i class="fa-solid ${icon}"></i> ${label}
        </button>`;
    return `<div class="ph-switch" role="tablist">
        ${pill('arena', 'arena', 'fa-bolt', 'NEET Arena')}
        ${pill('pyq', 'pyq', 'fa-scroll', 'PYQ Vault')}
        ${pill('air', 'air', 'fa-ranking-star', 'AIR')}
    </div>`;
}

// ── Best-attempt lookup, built from the existing /history endpoints.
// Returns { "year|paper_code": {marks, max, attempts} }. Never throws —
// a missing/failed history just yields no badges.
async function ensureAttemptMap(mode) {
    if (hubState.attemptMap[mode]) return hubState.attemptMap[mode];
    const map = {};
    try {
        const data = await apiCall(mode === 'arena' ? '/api/arena/history' : '/api/pyq/history');
        (data.history || []).forEach(h => {
            if (h.year == null || !h.paper_code) return;
            const k = `${h.year}|${h.paper_code}`;
            const prev = map[k];
            const marks = Number(h.total_marks) || 0;
            if (!prev) map[k] = { marks, max: Number(h.max_marks) || 0, attempts: 1 };
            else { prev.attempts += 1; if (marks > prev.marks) { prev.marks = marks; prev.max = Number(h.max_marks) || prev.max; } }
        });
    } catch (_) { /* no badges is fine */ }
    hubState.attemptMap[mode] = map;
    return map;
}

// ── Shared paper-card renderer (Arena + PYQ full-paper browse) ──
function paperCardsByYearHtml(byYear, mode, attemptMap) {
    attemptMap = attemptMap || hubState.attemptMap[mode] || {};
    const years = Object.keys(byYear || {}).sort((a, b) => Number(b) - Number(a));
    if (years.length === 0) {
        return `<div class="empty-state"><i class="fa-solid fa-file-circle-question"></i>
            <h3>No papers available yet</h3>
            <p style="margin-top:8px;color:var(--s500);">Full NEET papers will appear here once uploaded.</p></div>`;
    }
    return years.map(yr => {
        const cards = (byYear[yr] || []).map(p => {
            const code = escapeHtml(String(p.paper_code ?? ''));
            const mta = p.mta_questions > 0
                ? `<span class="cs2-chip year">${p.mta_questions} MTA</span>` : '';
            const subjects = (p.subjects || [])
                .map(s => typeof s === 'string' ? s : (s && (s.name || s.subject)) || '')
                .filter(Boolean).join(' · ');
            const done = attemptMap[`${p.year}|${p.paper_code}`];
            const donePct = done && done.max ? Math.round((done.marks / done.max) * 100) : 0;
            const doneBadge = done
                ? `<span class="pv2-paper-best" title="Your best attempt"><i class="fa-solid fa-circle-check"></i> Best ${done.marks}${done.max ? '/' + done.max : ''} · ${donePct}%${done.attempts > 1 ? ` · ${done.attempts}×` : ''}</span>`
                : '';
            return `<div class="pv2-paper ${done ? 'done' : ''}" onclick="hubStartFullPaper('${mode}', ${Number(p.year)}, '${code.replace(/'/g, "\\'")}')">
                <div class="pv2-paper-code">${code || '—'}</div>
                <div style="flex:1;min-width:0;">
                    <h4>NEET ${p.year} · Paper ${code}</h4>
                    <div class="meta">${escapeHtml(p.exam || 'NEET (UG)')} · ${p.total_questions || 0} questions</div>
                    ${subjects ? `<div class="meta">${escapeHtml(subjects)}</div>` : ''}
                    <div class="chips">
                        <span class="cs2-chip">+4 / −1</span>${mta}${doneBadge}
                    </div>
                </div>
                <i class="fa-solid fa-chevron-right" style="color:var(--s300);flex-shrink:0;font-size:.8rem;"></i>
            </div>`;
        }).join('');
        return `<div>
            <div class="pv2-year"><span class="cs2-micro">NEET ${escapeHtml(yr)}</span><span class="ln"></span></div>
            <div style="display:flex;flex-direction:column;gap:9px;">${cards}</div>
        </div>`;
    }).join('');
}

// ════════════════════════════════════════════════════════════════
// NEET ARENA — LANDING  (view-arena)
// ════════════════════════════════════════════════════════════════
async function loadArenaLanding() {
    const container = document.getElementById('arena-content');
    container.innerHTML = `${hubSwitcherHtml('arena')}
        <div class="pv2-wrap">
            <div class="loading-spinner"><div class="spinner"></div> Loading papers...</div>
        </div>`;
    try {
        if (!hubState.arenaPapers) {
            hubState.arenaPapers = await apiCall('/api/arena/papers');
        }
        const attemptMap = await ensureAttemptMap('arena');
        const data = hubState.arenaPapers;
        const attemptedCount = Object.keys(attemptMap).length;
        container.innerHTML = `${hubSwitcherHtml('arena')}
            <div class="pv2-wrap">
                <div class="pv2-hero">
                    <div class="kicker">NEET Arena · Exam mode</div>
                    <h2>Fight for your rank.</h2>
                    <p>Full papers under real exam conditions — locked OMR answers, strict
                       timer, AIR prediction and college cutoffs. Best attempt counts.</p>
                    <div class="stats">
                        <div><b>${data.total_papers || 0}</b><span>Papers</span></div>
                        <div><b>+4 / −1</b><span>Marking</span></div>
                        <div><b>${attemptedCount}</b><span>Attempted</span></div>
                    </div>
                </div>
                <div class="pv2-actions">
                    <button class="pv2-action" onclick="navigate('arena-history')">
                        <i class="fa-solid fa-clock-rotate-left"></i> My attempts</button>
                    <button class="pv2-action" onclick="navigate('air')">
                        <i class="fa-solid fa-ranking-star"></i> AIR rankings</button>
                </div>
                ${paperCardsByYearHtml(data.by_year, 'arena', attemptMap)}
            </div>`;
    } catch (e) {
        container.innerHTML = `${hubSwitcherHtml('arena')}
            <div class="m-picker-wrap"><div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i>
            <h3>Could not load Arena</h3><p style="margin-top:8px;color:var(--s500);">${escapeHtml(e.message)}</p>
            <button class="btn btn-outline" style="margin-top:16px;min-height:44px;" onclick="hubState.arenaPapers=null;loadArenaLanding()">
                <i class="fa-solid fa-rotate-right"></i> Retry</button></div></div>`;
    }
}

// ════════════════════════════════════════════════════════════════
// PYQ VAULT — LANDING  (view-pyq): full-paper browse + custom builder
// ════════════════════════════════════════════════════════════════
async function loadPyqLanding() {
    const container = document.getElementById('pyq-content');
    container.innerHTML = `${hubSwitcherHtml('pyq')}
        <div class="pv2-wrap">
            <div class="loading-spinner"><div class="spinner"></div> Loading vault...</div>
        </div>`;
    try {
        if (!hubState.pyqPapers) {
            hubState.pyqPapers = await apiCall('/api/pyq/papers');
        }
        renderPyqLanding();
        // Kick off (once) the discovery that powers the grouped chapter picker.
        ensureChapterTree();
        runPyqFilterPreview(true);
    } catch (e) {
        container.innerHTML = `${hubSwitcherHtml('pyq')}
            <div class="m-picker-wrap"><div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i>
            <h3>Could not load PYQ Vault</h3><p style="margin-top:8px;color:var(--s500);">${escapeHtml(e.message)}</p>
            <button class="btn btn-outline" style="margin-top:16px;min-height:44px;" onclick="hubState.pyqPapers=null;loadPyqLanding()">
                <i class="fa-solid fa-rotate-right"></i> Retry</button></div></div>`;
    }
}

function renderPyqLanding() {
    const container = document.getElementById('pyq-content');
    const data = hubState.pyqPapers || { by_year: {}, total_papers: 0 };
    container.innerHTML = `${hubSwitcherHtml('pyq')}
        <div class="pv2-wrap">
            <div class="pv2-hero">
                <div class="kicker">PYQ Vault · Question bank</div>
                <h2>Build your own drill.</h2>
                <p>Pick a class, subject and chapters — get a custom NEET-marked test
                   built from every past question.</p>
                <div class="stats">
                    <div><b>${data.total_papers || 0}</b><span>Papers mined</span></div>
                    <div><b>Custom</b><span>Builder</span></div>
                    <div><b>+4 / −1</b><span>Marking</span></div>
                </div>
            </div>
            <div class="pv2-actions">
                <button class="pv2-action" onclick="navigate('pyq-history')">
                    <i class="fa-solid fa-clock-rotate-left"></i> My custom attempts</button>
            </div>
            <div id="pyq-landing-body">${customBuilderHtml()}</div>
        </div>`;
    updateFilterPreviewUI();
}

// ── Custom test builder ─────────────────────────────────────────
function builderYearOptions() {
    const years = Object.keys((hubState.pyqPapers || {}).by_year || {})
        .sort((a, b) => Number(b) - Number(a));
    return years;
}

// ── Chapter tree discovery ──────────────────────────────────────
// The bank has no chapter→(subject,class) map on the paper metadata, but
// every QUESTION carries subject + ncert_class + ncert_chapter_name. So we
// enumerate it ONCE via /api/pyq/filter (subject × class fan-out, cached),
// producing tree["11"|"12"]["Physics"|...] = Set(chapterNames). Names are
// used verbatim — nothing in the bank is renamed.
const PH_SUBJECTS = ['Physics', 'Chemistry', 'Biology'];
// Some chapter NAMES exist under more than one subject in the bank — a few
// are genuine (e.g. "Thermodynamics" is a chapter in BOTH Physics and
// Chemistry), others are stray mis-tags. Because a selection stored as a bare
// name can't tell those apart, we scope each selected chapter to the subject
// group it was picked from, using a composite key "subject|||chapter".
const CHAP_SEP = '|||';
function chapKey(sub, name) { return `${sub || ''}${CHAP_SEP}${name}`; }
function parseChapKey(k) {
    const i = String(k).indexOf(CHAP_SEP);
    return i < 0 ? { subject: null, chapter: k }          // legacy bare name
        : { subject: k.slice(0, i) || null, chapter: k.slice(i + CHAP_SEP.length) };
}
async function ensureChapterTree() {
    if (hubState.chapterTree || hubState.chapterTreeLoading) return hubState.chapterTree;
    hubState.chapterTreeLoading = true;
    const tree = { '11': {}, '12': {} };
    try {
        const calls = [];
        PH_SUBJECTS.forEach(sub => ['11', '12'].forEach(cls => {
            calls.push(apiCall('/api/pyq/filter', 'POST', {
                subject: sub, ncert_class: Number(cls), limit: 500,
            }).then(r => ({ sub, cls, r })).catch(() => ({ sub, cls, r: { questions: [] } })));
        }));
        const results = await Promise.all(calls);
        results.forEach(({ sub, cls, r }) => {
            const bucket = (tree[cls][sub] = tree[cls][sub] || new Set());
            (r.questions || []).forEach(q => {
                const name = q.ncert_chapter_name;
                if (name) bucket.add(name);
            });
        });
        hubState.chapterTree = tree;
    } catch (_) {
        hubState.chapterTree = tree; // partial/empty tree still renders "all chapters"
    }
    hubState.chapterTreeLoading = false;
    // Re-render if the builder is on screen so chapters populate in place.
    const body = document.getElementById('pyq-landing-body');
    if (body) { body.innerHTML = customBuilderHtml(); updateFilterPreviewUI(); }
    return hubState.chapterTree;
}

// Flattens the tree into visible [class, subject, chapter] rows honoring the
// active Class / Subject filters and the live search text.
function visibleChapterGroups() {
    const f = hubState.filters;
    const tree = hubState.chapterTree;
    if (!tree) return null; // signal "still discovering"
    const q = (hubState.chapterSearch || '').trim().toLowerCase();
    const classes = f.ncert_class ? [String(f.ncert_class)] : ['11', '12'];
    const subjects = f.subjects.length ? f.subjects : PH_SUBJECTS;
    const groups = [];
    classes.forEach(cls => subjects.forEach(sub => {
        const set = (tree[cls] && tree[cls][sub]) || null;
        if (!set || !set.size) return;
        let chaps = Array.from(set).sort((a, b) => a.localeCompare(b));
        if (q) chaps = chaps.filter(c => c.toLowerCase().includes(q));
        if (chaps.length) groups.push({ cls, sub, chapters: chaps });
    }));
    return groups;
}

function chapterPickerHtml() {
    const f = hubState.filters;
    if (!hubState.chapterTree) {
        return `<div class="pv2-chap-loading"><div class="spinner"></div> Loading chapter list…</div>`;
    }
    const groups = visibleChapterGroups();
    const open = hubState._openChapGroups || new Set();
    const selectedCount = f.chapters.length;
    const search = `<div class="pv2-chap-search">
        <i class="fa-solid fa-magnifying-glass"></i>
        <input type="text" id="pyq-chap-search" placeholder="Search chapters…"
            value="${escapeHtml(hubState.chapterSearch || '')}"
            oninput="setChapterSearch(this.value)">
        ${selectedCount ? `<button class="pv2-chap-clear" onclick="clearChapters()">Clear ${selectedCount}</button>` : ''}
    </div>`;

    if (!groups.length) {
        return `${search}<p class="pv2-chap-empty">No chapters match. Leave chapters unselected to include everything in the class &amp; subject you picked.</p>`;
    }
    const forceOpen = !!(hubState.chapterSearch || '').trim() || groups.length === 1;
    const body = groups.map(g => {
        const key = `${g.cls}|${g.sub}`;
        const isOpen = forceOpen || open.has(key);
        const selHere = g.chapters.filter(c => f.chapters.includes(chapKey(g.sub, c))).length;
        const chips = g.chapters.map(c => {
            const key = chapKey(g.sub, c);
            const esc = key.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            return `<button class="ph-fchip sm ${f.chapters.includes(key) ? 'active' : ''}"
                onclick="toggleBuilderMulti('chapters','${esc}')">${escapeHtml(c)}</button>`;
        }).join('');
        return `<div class="pv2-chap-group ${isOpen ? 'open' : ''}">
            <button class="pv2-chap-ghead" onclick="toggleChapGroup('${key}')">
                <span class="pv2-chap-sub">Class ${g.cls} · ${escapeHtml(g.sub)}</span>
                <span class="pv2-chap-meta">${selHere ? `<span class="pv2-chap-selpill">${selHere}</span>` : ''}${g.chapters.length}<i class="fa-solid fa-chevron-down"></i></span>
            </button>
            <div class="pv2-chap-chips">${chips}</div>
        </div>`;
    }).join('');
    return `${search}<div class="pv2-chap-groups">${body}</div>`;
}

function customBuilderHtml() {
    const f = hubState.filters;
    const years = builderYearOptions();
    const chip = (label, active, onclick, extra = '') =>
        `<button class="ph-fchip ${active ? 'active' : ''} ${extra}" onclick="${onclick}">${label}</button>`;

    const yearChips = [chip('Any', !f.year, `setBuilderFilter('year','')`)]
        .concat(years.map(y => chip(escapeHtml(y), String(f.year) === String(y), `setBuilderFilter('year','${y}')`)))
        .join('');

    const classChips = [
        chip('Any', !f.ncert_class, `setBuilderFilter('ncert_class','')`),
        chip('Class 11', String(f.ncert_class) === '11', `setBuilderFilter('ncert_class','11')`),
        chip('Class 12', String(f.ncert_class) === '12', `setBuilderFilter('ncert_class','12')`),
    ].join('');

    const subjectChips = PH_SUBJECTS.map(s =>
        chip(s, f.subjects.includes(s), `toggleBuilderMulti('subjects','${s}')`)).join('');

    const countChips = [10, 20, 30, 45, 60, 90, 180].map(n =>
        chip(String(n), Number(f.count) === n, `setBuilderFilter('count','${n}')`)).join('');

    return `<div class="pv2-builder">
        <div class="pv2-bgroup">
            <label class="cs2-micro">Class</label>
            <div class="ph-fchip-row">${classChips}</div>
        </div>
        <div class="pv2-bgroup">
            <label class="cs2-micro">Subject</label>
            <div class="ph-fchip-row">${subjectChips}</div>
        </div>
        <div class="pv2-bgroup">
            <label class="cs2-micro">Chapters</label>
            <div class="pv2-chap-picker" id="pyq-chap-picker">${chapterPickerHtml()}</div>
        </div>
        <div class="pv2-bgroup">
            <label class="cs2-micro">Year <span class="pv2-lbl-opt">optional</span></label>
            <div class="ph-fchip-row">${yearChips}</div>
        </div>
        <div class="pv2-bgroup">
            <label class="cs2-micro">Number of questions</label>
            <div class="ph-fchip-row">${countChips}</div>
        </div>
        <div class="ph-preview" id="pyq-filter-preview">
            <div class="loading-spinner" style="padding:6px;"><div class="spinner"></div></div>
        </div>
        <button class="btn ph-start-btn" id="pyq-custom-start" disabled onclick="hubStartCustomTest()">
            <i class="fa-solid fa-play"></i> Start Custom Test
        </button>
        <p class="ph-fineprint">Custom tests use NEET marking (+4 / −1). Scored server-side —
            answers lock once shaded on the OMR sheet.</p>
    </div>`;
}

// Re-render ONLY the chapter picker in place (no full rebuild → keeps the
// search input focused while typing).
function refreshChapterPicker() {
    const box = document.getElementById('pyq-chap-picker');
    if (box) box.innerHTML = chapterPickerHtml();
}
function setChapterSearch(v) {
    hubState.chapterSearch = v;
    const box = document.getElementById('pyq-chap-picker');
    if (!box) return;
    box.innerHTML = chapterPickerHtml();
    // restore caret to end of the (re-rendered) input
    const inp = document.getElementById('pyq-chap-search');
    if (inp) { inp.focus(); const n = inp.value.length; inp.setSelectionRange(n, n); }
}
function toggleChapGroup(key) {
    if (!hubState._openChapGroups) hubState._openChapGroups = new Set();
    const s = hubState._openChapGroups;
    if (s.has(key)) s.delete(key); else s.add(key);
    refreshChapterPicker();
}
function clearChapters() {
    hubState.filters.chapters = [];
    refreshChapterPicker();
    runPyqFilterPreview();
}

function setBuilderFilter(key, value) {
    if (key === 'count') hubState.filters.count = Number(value) || 20;
    else hubState.filters[key] = value;
    // year / class change the available chapters; count is harmless — either
    // way a full rebuild keeps the chip rows honest, then re-preview.
    renderPyqLanding();
    runPyqFilterPreview();
}
function toggleBuilderMulti(key, value) {
    const arr = hubState.filters[key];
    const i = arr.indexOf(value);
    if (i >= 0) arr.splice(i, 1); else arr.push(value);
    if (key === 'chapters') {
        // Toggling a chapter must NOT rebuild the whole page (would drop the
        // search box + scroll). Re-render just the picker from state.
        const box = document.getElementById('pyq-chap-picker');
        if (box) refreshChapterPicker(); else renderPyqLanding();
    } else {
        // subject change re-scopes which chapter groups show → rebuild picker
        renderPyqLanding();
    }
    runPyqFilterPreview();
}

// ── Live "N questions match · ~M min" preview ───────────────────
// POST /api/pyq/filter accepts ONE subject / ONE chapter per call, so
// multi-select fans out into one call per (subject × chapter) combo
// (bounded), merged + de-duplicated by question_id. Debounced ~400ms.
function runPyqFilterPreview(immediate = false) {
    clearTimeout(hubState._filterTimer);
    hubState.filterLoading = true;
    updateFilterPreviewUI();
    hubState._filterTimer = setTimeout(async () => {
        const seq = ++hubState._filterSeq;
        const f = hubState.filters;
        const baseBody = () => {
            const b = { limit: 500 };
            if (f.year) b.year = Number(f.year);
            if (f.ncert_class) b.ncert_class = Number(f.ncert_class);
            return b;
        };
        // Selected chapters are subject-scoped pairs. When any are chosen they
        // drive the query precisely (so "Thermodynamics" picked under Physics
        // never pulls Chemistry). Otherwise fall back to subject chips (or all).
        const pairs = (f.chapters || []).map(parseChapKey);
        const bodies = [];
        let clientPairFilter = null;
        if (pairs.length) {
            if (pairs.length <= 9) {
                pairs.forEach(p => {
                    const b = baseBody();
                    if (p.subject) b.subject = p.subject;
                    b.chapter = p.chapter;
                    bodies.push(b);
                });
            } else {
                // Too many combos: query by the distinct subjects, filter pairs client-side.
                const subs = [...new Set(pairs.map(p => p.subject).filter(Boolean))];
                (subs.length ? subs : [null]).forEach(sub => {
                    const b = baseBody();
                    if (sub) b.subject = sub;
                    bodies.push(b);
                });
                clientPairFilter = new Set(pairs.map(p => `${p.subject || ''}${CHAP_SEP}${p.chapter}`));
            }
        } else {
            const subjects = f.subjects.length ? f.subjects : [null];
            subjects.forEach(sub => {
                const b = baseBody();
                if (sub) b.subject = sub;
                bodies.push(b);
            });
        }
        try {
            const responses = await Promise.all(bodies.map(b => apiCall('/api/pyq/filter', 'POST', b)));
            if (seq !== hubState._filterSeq) return; // stale — a newer preview ran
            const seen = new Set();
            let merged = [];
            responses.forEach(r => (r.questions || []).forEach(q => {
                if (!seen.has(q.question_id)) { seen.add(q.question_id); merged.push(q); }
            }));
            if (clientPairFilter && clientPairFilter.size) {
                merged = merged.filter(q =>
                    clientPairFilter.has(`${q.subject || ''}${CHAP_SEP}${q.ncert_chapter_name}`));
            }
            hubState.matchedQuestions = merged;
            hubState.matchedTotal = merged.length;
        } catch (e) {
            if (seq !== hubState._filterSeq) return;
            hubState.matchedQuestions = [];
            hubState.matchedTotal = 0;
            ndToast('Filter preview failed: ' + e.message, 'error');
        }
        hubState.filterLoading = false;
        updateFilterPreviewUI();
    }, immediate ? 0 : 400);
}

function updateFilterPreviewUI() {
    const box = document.getElementById('pyq-filter-preview');
    const startBtn = document.getElementById('pyq-custom-start');
    if (!box) return;
    if (hubState.filterLoading) {
        box.innerHTML = `<div class="loading-spinner" style="padding:6px;"><div class="spinner"></div> Matching questions...</div>`;
        if (startBtn) startBtn.disabled = true;
        return;
    }
    const total = hubState.matchedTotal;
    const testSize = Math.min(Number(hubState.filters.count) || 20, total);
    // Same time formula as the backend: (n/180)×180 min, floor 10 min.
    const mins = Math.max(10, Math.round((testSize / 180) * 180));
    if (total === 0) {
        box.innerHTML = `<i class="fa-solid fa-circle-xmark" style="color:var(--red);"></i>
            <b>0 questions match</b> — loosen your filters.`;
        if (startBtn) startBtn.disabled = true;
    } else {
        box.innerHTML = `<i class="fa-solid fa-circle-check" style="color:var(--green-600);"></i>
            <b>${total} question${total !== 1 ? 's' : ''} match</b>
            · test size ${testSize} · ~${mins} min`;
        if (startBtn) startBtn.disabled = false;
    }
}

// ════════════════════════════════════════════════════════════════
// STARTING TESTS
// ════════════════════════════════════════════════════════════════

// Fisher–Yates, so a custom test isn't always the same leading slice.
function phShuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// PYQ Vault → Custom test. ALWAYS arena_session:false, test_type:"custom".
function hubStartCustomTest() {
    const pool = hubState.matchedQuestions || [];
    if (pool.length === 0) { ndToast('No questions match your filters.', 'warning'); return; }
    const size = Math.min(Number(hubState.filters.count) || 20, pool.length);
    const picked = phShuffle(pool).slice(0, size)
        .sort((a, b) => String(a.subject).localeCompare(String(b.subject))
            || (a.year || 0) - (b.year || 0)
            || (a.question_number || 0) - (b.question_number || 0));
    const ids = picked.map(q => q.question_id);
    const f = hubState.filters;
    const bits = [];
    if (f.year) bits.push(`NEET ${f.year}`);
    // Subjects for the label: chips if set, else inferred from picked chapters.
    let subjects = f.subjects.slice();
    if (!subjects.length) {
        subjects = [...new Set((f.chapters || []).map(k => parseChapKey(k).subject).filter(Boolean))];
    }
    if (subjects.length) bits.push(subjects.join('/'));
    const label = `Custom Test · ${bits.length ? bits.join(' · ') + ' · ' : ''}${size} Qs`;
    navigate('pyq-test', {
        question_ids: ids,
        test_type: 'custom',
        arena_session: false,
        year: f.year ? Number(f.year) : undefined,
        label,
    });
}

// Full-paper attempt from paper cards.
//   mode 'arena' → arena_session:true   (NEET Arena)
//   mode 'pyq'   → arena_session:false  (PYQ Vault full paper)
// Both are full papers, so we ask for the NEET category first (same
// as desktop) — it feeds submit's `category` and the AIR/qualifying/
// college predictions.
function hubStartFullPaper(mode, year, paperCode) {
    showCategorySheet((category) => {
        beginFullPaperSession(mode, year, paperCode, category);
    });
}

function showCategorySheet(onPick) {
    const current = getPracticeCategory();
    const cats = ['General', 'OBC', 'SC', 'ST', 'EWS'];
    const chips = cats.map(c =>
        `<button class="ph-fchip ${current === c ? 'active' : ''}" data-cat="${c}"
            onclick="document.querySelectorAll('#ph-cat-row .ph-fchip').forEach(b=>b.classList.remove('active'));this.classList.add('active');">${c}</button>`
    ).join('');
    phOpenSheet(`
        <div class="ph-sheet-handle"></div>
        <h3 class="ph-sheet-title"><i class="fa-solid fa-id-card"></i> Your NEET category</h3>
        <p class="ph-sheet-sub">Used for qualifying cutoff, AIR estimate and college predictions.
           You can change it later on the results screen.</p>
        <div class="ph-fchip-row" id="ph-cat-row" style="justify-content:center;">${chips}</div>
        <button class="btn ph-start-btn" style="margin-top:16px;" onclick="confirmCategorySheet()">
            <i class="fa-solid fa-check"></i> Continue</button>
    `);
    window._phCategoryCallback = onPick;
}
function confirmCategorySheet() {
    const active = document.querySelector('#ph-cat-row .ph-fchip.active');
    const cat = active ? active.dataset.cat : (getPracticeCategory() || 'General');
    setPracticeCategory(cat);
    phCloseSheet();
    const cb = window._phCategoryCallback;
    window._phCategoryCallback = null;
    if (cb) cb(cat);
}

async function beginFullPaperSession(mode, year, paperCode, category) {
    phOpenSheet(`
        <div class="ph-sheet-handle"></div>
        <div class="loading-spinner" style="padding:24px;"><div class="spinner"></div>
            Preparing NEET ${escapeHtml(String(year))} · Paper ${escapeHtml(String(paperCode))}...</div>
    `, { blockDismiss: true });
    try {
        // Full paper = every question of that year+paper_code, in
        // question_number order (the filter endpoint sorts for us).
        const filtered = await apiCall('/api/pyq/filter', 'POST', {
            year: Number(year),
            paper_code: String(paperCode),
            limit: 500,
        });
        const ids = (filtered.questions || []).map(q => q.question_id);
        if (ids.length === 0) throw new Error('No questions found for this paper.');
        phCloseSheet();
        navigate(mode === 'arena' ? 'arena-test' : 'pyq-test', {
            question_ids: ids,
            test_type: 'full_paper',
            arena_session: mode === 'arena',   // ← THE load-bearing flag
            year: Number(year),
            paper_code: String(paperCode),
            label: `NEET ${year} Paper ${paperCode}`,
            category,
        });
    } catch (e) {
        phCloseSheet();
        ndToast('Could not start paper: ' + e.message, 'error');
    }
}

// ════════════════════════════════════════════════════════════════
// LEADERBOARDS (per paper)
//   arena → GET /api/arena/leaderboard/<year>/<paper_code>
//           (best-of-N: entries carry best_marks + attempts)
//   pyq   → GET /api/pyq/leaderboard/<year>/<paper_code>
// ════════════════════════════════════════════════════════════════
function fmtLbTime(sec) {
    sec = Number(sec) || 0;
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}m ${String(s).padStart(2, '0')}s`;
}

function leaderboardRowHtml(e, mode) {
    const rankCls = e.rank === 1 ? 'gold' : e.rank === 2 ? 'silver' : e.rank === 3 ? 'bronze' : '';
    const marks = mode === 'arena' ? e.best_marks : e.total_marks;
    const sub = mode === 'arena'
        ? `Best attempt · ${e.attempts || 1} attempt${(e.attempts || 1) !== 1 ? 's' : ''} · ${e.accuracy}% acc`
        : `${e.correct}✓ ${e.wrong}✗ · ${e.accuracy}% acc · ${fmtLbTime(e.time_taken_seconds)}`;
    return `<div class="pv2-lb-row ${e.is_me ? 'me' : ''}">
        <div class="pv2-lb-rank ${rankCls}">${e.rank}</div>
        <div style="flex:1;min-width:0;">
            <h4>${escapeHtml(e.user_name || 'Student')} ${e.is_me ? '<span class="ph-you-tag">You</span>' : ''}</h4>
            <p>${sub}</p>
        </div>
        <div class="pv2-lb-marks">
            <b>${marks}</b>
            ${e.air_prediction ? `<span>AIR ~${Number(e.air_prediction).toLocaleString('en-IN')}</span>` : ''}
        </div>
    </div>`;
}

async function loadPaperLeaderboard(mode, year, paperCode) {
    const container = document.getElementById(`${mode}-leaderboard-content`);
    container.innerHTML = `<div class="pv2-wrap" style="padding-top:calc(14px + var(--safe-top));">
        <div class="loading-spinner"><div class="spinner"></div> Loading leaderboard...</div></div>`;
    try {
        const data = await apiCall(mode === 'arena'
            ? `/api/arena/leaderboard/${year}/${paperCode}`
            : `/api/pyq/leaderboard/${year}/${paperCode}`);
        const entries = data.entries || [];
        const meInSlice = entries.some(e => e.is_me);
        const myPinned = (!meInSlice && data.my_entry)
            ? `<div style="margin:16px 4px 10px;"><span class="cs2-micro">Your position</span></div>
               ${leaderboardRowHtml(data.my_entry, mode)}` : '';
        container.innerHTML = `<div class="pv2-wrap" style="padding-top:calc(14px + var(--safe-top));">
            <button class="cs2-back" style="margin-bottom:14px;"
                onclick="navigate('${mode}')"><i class="fa-solid fa-arrow-left"></i> Back</button>
            <div class="pv2-hero">
                <div class="kicker">${mode === 'arena' ? 'NEET Arena · Best-of-attempts' : 'PYQ Vault'} leaderboard</div>
                <h2>NEET ${escapeHtml(String(data.year ?? year))} · Paper ${escapeHtml(String(data.paper_code ?? paperCode))}</h2>
                <p>${data.total_participants || 0} participant${(data.total_participants || 0) !== 1 ? 's' : ''}${mode === 'arena' ? ' · ranked by best attempt' : ''}</p>
            </div>
            ${myPinned}
            <div style="margin:16px 4px 10px;"><span class="cs2-micro">Rankings</span></div>
            ${entries.length === 0
                ? `<div class="empty-state"><i class="fa-solid fa-trophy"></i>
                    <h3>No entries yet</h3><p style="margin-top:8px;color:var(--s500);">Be the first to attempt this paper.</p></div>`
                : `<div style="display:flex;flex-direction:column;gap:8px;">
                    ${entries.map(e => leaderboardRowHtml(e, mode)).join('')}</div>`}
        </div>`;
    } catch (e) {
        container.innerHTML = `<div class="m-picker-wrap">
            <button class="btn btn-outline btn-sm" style="margin-bottom:14px;min-height:44px;"
                onclick="navigate('${mode}')"><i class="fa-solid fa-arrow-left"></i> Back</button>
            <div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i>
            <h3>Could not load leaderboard</h3><p style="margin-top:8px;color:var(--s500);">${escapeHtml(e.message)}</p></div></div>`;
    }
}

// ════════════════════════════════════════════════════════════════
// HISTORY
//   arena → GET /api/arena/history      pyq → GET /api/pyq/history
// Tap → GET /api/pyq/session/<id> → shared results renderer.
// ════════════════════════════════════════════════════════════════
function fmtHistoryDate(iso) {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleDateString('en-IN',
            { day: 'numeric', month: 'short', year: 'numeric' });
    } catch (_) { return ''; }
}

async function loadPracticeHistory(mode) {
    const container = document.getElementById(`${mode}-history-content`);
    container.innerHTML = `<div class="pv2-wrap" style="padding-top:calc(14px + var(--safe-top));">
        <div class="loading-spinner"><div class="spinner"></div> Loading attempts...</div></div>`;
    try {
        const data = await apiCall(mode === 'arena' ? '/api/arena/history' : '/api/pyq/history');
        // Arena = NEET full papers only; PYQ Vault = custom tests only.
        const history = (data.history || []).filter(h =>
            mode === 'arena' ? h.test_type !== 'custom' : h.test_type === 'custom');

        // Group attempts of the SAME test together. Full papers key on
        // year+paper_code; custom tests key on their label.
        const groupKey = (h) => (h.year && h.paper_code)
            ? `p|${h.year}|${h.paper_code}` : `l|${h.label || h.session_id}`;
        const gmap = new Map();
        history.forEach(h => {
            const k = groupKey(h);
            if (!gmap.has(k)) gmap.set(k, []);
            gmap.get(k).push(h);
        });
        // Within a group: best score first. Groups: most-recently-attempted first.
        const groups = Array.from(gmap.values()).map(atts => {
            atts.sort((a, b) => (Number(b.total_marks) || 0) - (Number(a.total_marks) || 0)
                || (new Date(b.completed_at || 0) - new Date(a.completed_at || 0)));
            return atts;
        });
        groups.sort((ga, gb) =>
            Math.max(...gb.map(a => +new Date(a.completed_at || 0)))
            - Math.max(...ga.map(a => +new Date(a.completed_at || 0))));

        const ringIds = [];
        const histCard = (h, badge = '', extraCls = '') => {
            const air = h.air_prediction && h.air_prediction.air_mid
                ? `<span class="cs2-chip">AIR ~${Number(h.air_prediction.air_mid).toLocaleString('en-IN')}</span>` : '';
            const type = h.test_type === 'custom'
                ? '<span class="cs2-chip">Custom</span>'
                : '<span class="cs2-chip grad">Full paper</span>';
            const sid = String(h.session_id).replace(/'/g, "\\'");
            const scorePct = h.max_marks ? Math.max(0, Math.round((h.total_marks / h.max_marks) * 100)) : 0;
            const rid = `pv2-hring-${mode}-${ringIds.length}`;
            ringIds.push(rid);
            const chips = `${badge}${mode === 'pyq' ? type : ''}${air}`;
            return `<div class="pv2-hist ${extraCls}" onclick="viewPastSession('${mode}', '${sid}')">
                ${typeof csRingHTML === 'function' ? csRingHTML(rid, scorePct, 44, 4.5) : ''}
                <div style="flex:1;min-width:0;">
                    <h4>${escapeHtml(h.label || `NEET ${h.year || ''} ${h.paper_code || ''}`)}</h4>
                    <p>${fmtHistoryDate(h.completed_at)} · ${h.accuracy}% accuracy</p>
                    ${chips.trim() ? `<div style="display:flex;gap:5px;margin-top:6px;flex-wrap:wrap;">${chips}</div>` : ''}
                </div>
                <div class="pv2-lb-marks"><b>${h.total_marks}</b><span>/ ${h.max_marks}</span></div>
            </div>`;
        };

        const groupHtml = (atts, gi) => {
            if (atts.length === 1) return histCard(atts[0]);
            const best = atts[0];
            const others = atts.slice(1);
            const gid = `pv2-histg-${mode}-${gi}`;
            const badge = `<span class="cs2-chip grad"><i class="fa-solid fa-crown"></i> Best of ${atts.length}</span>`;
            return `<div class="pv2-hist-group">
                ${histCard(best, badge)}
                <button class="pv2-hist-toggle" onclick="pv2ToggleHistGroup('${gid}', this)">
                    <span class="show">Show ${others.length} earlier attempt${others.length !== 1 ? 's' : ''}</span>
                    <span class="hide">Hide earlier attempts</span>
                    <i class="fa-solid fa-chevron-down"></i>
                </button>
                <div class="pv2-hist-more" id="${gid}">
                    <div class="pv2-hist-more-inner">${others.map(o => histCard(o, '', 'sub')).join('')}</div>
                </div>
            </div>`;
        };

        const rows = groups.map((atts, gi) => groupHtml(atts, gi)).join('');
        container.innerHTML = `<div class="pv2-wrap" style="padding-top:calc(14px + var(--safe-top));">
            <button class="cs2-back" style="margin-bottom:16px;"
                onclick="navigate('${mode}')"><i class="fa-solid fa-arrow-left"></i> Back</button>
            <div class="cs2-micro" style="color:var(--indigo);">${mode === 'arena' ? 'NEET Arena' : 'PYQ Vault'}</div>
            <h2 style="font-family:var(--font-display);font-size:1.3rem;font-weight:800;letter-spacing:-.02em;margin-top:4px;">
                My attempts</h2>
            <p style="color:var(--s500);font-size:.8rem;margin:4px 0 16px;">${groups.length} ${mode === 'arena' ? 'paper' : 'test'}${groups.length !== 1 ? 's' : ''} · ${history.length} attempt${history.length !== 1 ? 's' : ''}</p>
            ${history.length === 0
                ? `<div class="cs2-empty"><i class="fa-solid fa-clock-rotate-left"></i>No attempts yet — your completed tests will appear here.</div>`
                : `<div style="display:flex;flex-direction:column;gap:11px;">${rows}</div>`}
        </div>`;
        if (typeof csAnimateRing === 'function') {
            ringIds.forEach(rid => csAnimateRing(rid));
        }
    } catch (e) {
        container.innerHTML = `<div class="m-picker-wrap">
            <button class="btn btn-outline btn-sm" style="margin-bottom:14px;min-height:44px;"
                onclick="navigate('${mode}')"><i class="fa-solid fa-arrow-left"></i> Back</button>
            <div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i>
            <h3>Could not load history</h3><p style="margin-top:8px;color:var(--s500);">${escapeHtml(e.message)}</p></div></div>`;
    }
}

function pv2ToggleHistGroup(gid, btn) {
    const el = document.getElementById(gid);
    if (el) el.classList.toggle('open');
    btn.classList.toggle('open');
}

async function viewPastSession(mode, sessionId) {
    const container = document.getElementById(`${mode}-results-content`);
    navigate(`${mode}-results`, { loading: true });
    container.innerHTML = `<div class="m-picker-wrap">
        <div class="loading-spinner"><div class="spinner"></div> Loading results...</div></div>`;
    try {
        const result = await apiCall(`/api/pyq/session/${sessionId}`);
        if (result && result.error) throw new Error(result.error);
        renderTestResults(mode, result, { backTo: `${mode}-history` });
    } catch (e) {
        container.innerHTML = `<div class="m-picker-wrap">
            <button class="btn btn-outline btn-sm" style="margin-bottom:14px;min-height:44px;"
                onclick="navigate('${mode}-history')"><i class="fa-solid fa-arrow-left"></i> Back</button>
            <div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i>
            <h3>Could not load results</h3><p style="margin-top:8px;color:var(--s500);">${escapeHtml(e.message)}</p></div></div>`;
    }
}

// ── My private AIR detail (only shown when I tap my own row) ──
function airMiniChart(attempts) {
    const vals = attempts.map(a => Number(a.total_marks) || 0);
    const n = vals.length;
    const maxM = Number(attempts[0] && attempts[0].max_marks) || Math.max(...vals, 1);
    const min = 0, max = Math.max(maxM, ...vals, 1);
    const W = 320, H = 130, L = 34, R = 12, T = 12, B = 100;
    const step = n > 1 ? (W - L - R) / (n - 1) : 0;
    const yOf = v => B - ((v - min) / ((max - min) || 1)) * (B - T);
    const pts = vals.map((v, i) => `${(L + i * step).toFixed(1)},${yOf(v).toFixed(1)}`);
    const dots = vals.map((v, i) =>
        `<circle cx="${(L + i * step).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="3.2" fill="#9fd0e0"/>`).join('');
    const xl = [0, n - 1].filter((v, i, a) => a.indexOf(v) === i).map(i =>
        `<text x="${(L + i * step).toFixed(1)}" y="${H - 4}" class="pv2-air-ax" text-anchor="middle">#${i + 1}</text>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" class="pv2-air-chart">
        <defs><linearGradient id="airlg" x1="0" y1="0" x2="100%" y2="0">
            <stop offset="0%" stop-color="#5d92cf"/><stop offset="100%" stop-color="#8fd8e6"/></linearGradient></defs>
        <text x="${L - 4}" y="${(yOf(max) + 3).toFixed(1)}" class="pv2-air-ax" text-anchor="end">${max}</text>
        <text x="${L - 4}" y="${(yOf(0) + 3).toFixed(1)}" class="pv2-air-ax" text-anchor="end">0</text>
        <line x1="${L}" y1="${B}" x2="${W - R}" y2="${B}" stroke="rgba(255,255,255,.12)"/>
        <path d="M ${pts.join(' L ')}" fill="none" stroke="url(#airlg)" stroke-width="2.2" stroke-linejoin="round"/>
        ${dots}${xl}
    </svg>`;
}

function airMyDetailHtml(attempts) {
    if (!attempts.length) {
        return `<div class="pv2-air-me-inner"><p class="pv2-air-me-empty">
            No full-paper attempts yet — take a NEET Arena paper to start tracking your rank.</p></div>`;
    }
    const list = attempts.slice().reverse().map((a, ri) => {
        const idx = attempts.length - ri; // original attempt number (1-based, chronological)
        const air = a.air_prediction && a.air_prediction.air_mid
            ? `~${Number(a.air_prediction.air_mid).toLocaleString('en-IN')}` : '—';
        const sid = String(a.session_id).replace(/'/g, "\\'");
        return `<button class="pv2-air-att" onclick="viewPastSession('arena','${sid}')">
            <span class="pv2-air-att-n">#${idx}</span>
            <span class="pv2-air-att-main">
                <b>${escapeHtml(a.label || `NEET ${a.year || ''} ${a.paper_code || ''}`)}</b>
                <span>${fmtHistoryDate(a.completed_at)} · ${a.accuracy}% acc · AIR ${air}</span>
            </span>
            <span class="pv2-air-att-score">${a.total_marks}<i>/${a.max_marks}</i></span>
            <i class="fa-solid fa-chevron-right pv2-air-att-caret"></i>
        </button>`;
    }).join('');
    return `<div class="pv2-air-me-inner">
        ${attempts.length >= 2 ? `<div class="pv2-air-me-chartlabel">Score progression · ${attempts.length} papers</div>${airMiniChart(attempts)}` : ''}
        <div class="pv2-air-me-list">${list}</div>
        <p class="pv2-air-me-note"><i class="fa-solid fa-circle-info"></i> Tap any attempt for its full result, AIR &amp; college predictions.</p>
    </div>`;
}

// ════════════════════════════════════════════════════════════════
// AIR RANKINGS  (view-air)
// Data source: GET /api/arena/overall-leaderboard ONLY.
// (/api/leaderboard/overall and its siblings are a legacy system —
//  explicitly out of scope.)
// ════════════════════════════════════════════════════════════════
async function loadAirRankings() {
    const container = document.getElementById('air-content');
    container.innerHTML = `${hubSwitcherHtml('air')}
        <div class="pv2-wrap">
            <div class="loading-spinner"><div class="spinner"></div> Loading rankings...</div>
        </div>`;
    try {
        const [data, histData] = await Promise.all([
            apiCall('/api/arena/overall-leaderboard'),
            apiCall('/api/arena/history').catch(() => ({ history: [] })),
        ]);
        const entries = data.entries || [];
        const me = data.my_entry;
        // My full-paper attempts, oldest → newest, for the progression view.
        const myAttempts = (histData.history || [])
            .filter(h => h.test_type !== 'custom')
            .sort((a, b) => new Date(a.completed_at || 0) - new Date(b.completed_at || 0));
        // Real top-of-board figures (client-derived from the entries we already have).
        const topMarks = entries.length ? Math.max(...entries.map(e => Number(e.best_marks) || 0)) : 0;
        const topAir = entries.map(e => Number(e.best_air) || 0).filter(Boolean).sort((a, b) => a - b)[0] || 0;

        const airRow = (e) => {
            const rankCls = e.rank === 1 ? 'gold' : e.rank === 2 ? 'silver' : e.rank === 3 ? 'bronze' : '';
            const inner = `
                <div class="pv2-lb-rank ${rankCls}">${e.rank}</div>
                <div style="flex:1;min-width:0;">
                    <h4>${escapeHtml(e.user_name || 'Student')} ${e.is_me ? '<span class="ph-you-tag">You</span>' : ''}</h4>
                    <p>${e.papers_attempted || 0} paper${(e.papers_attempted || 0) !== 1 ? 's' : ''}
                       · ${e.total_attempts || 0} attempt${(e.total_attempts || 0) !== 1 ? 's' : ''}
                       · ${e.avg_accuracy || 0}% avg acc</p>
                </div>
                <div class="pv2-lb-marks">
                    <b>${e.best_marks}</b>
                    ${e.best_air ? `<span>AIR ~${Number(e.best_air).toLocaleString('en-IN')}</span>` : ''}
                </div>`;
            if (e.is_me) {
                // Only MY row expands — into my private progression + attempts.
                return `<div class="pv2-air-me-wrap" id="pv2-air-me">
                    <div class="pv2-lb-row me expandable" role="button" tabindex="0"
                        onclick="document.getElementById('pv2-air-me').classList.toggle('open')">
                        ${inner}
                        <i class="fa-solid fa-chevron-down pv2-air-caret"></i>
                    </div>
                    <div class="pv2-air-me-detail">${airMyDetailHtml(myAttempts)}</div>
                </div>`;
            }
            return `<div class="pv2-lb-row">${inner}</div>`;
        };

        const myCard = me ? `
            <div class="pv2-mycard">
                <div class="kicker">Your standing</div>
                <div class="pv2-mystats">
                    <div><b>#${me.rank}</b><span>Rank</span></div>
                    <div><b>${me.best_marks}</b><span>Best marks</span></div>
                    <div><b>${me.best_air ? '~' + Number(me.best_air).toLocaleString('en-IN') : '—'}</b><span>Best AIR</span></div>
                    <div><b>${me.avg_accuracy || 0}%</b><span>Avg acc</span></div>
                </div>
                <p>${me.papers_attempted || 0} papers · ${me.total_attempts || 0} total attempts</p>
            </div>` : `
            <div class="pv2-mycard">
                <div class="kicker">Your standing</div>
                <p style="font-size:.8rem;color:#94a3b8;line-height:1.6;">You're not ranked yet — complete a
                   NEET Arena full paper to enter the AIR rankings.</p>
                <button class="pv2-action" style="margin-top:12px;background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.14);color:#e2e8f0;"
                    onclick="navigate('arena')"><i class="fa-solid fa-bolt" style="color:#9fc3e8;"></i> Go to Arena</button>
            </div>`;

        container.innerHTML = `${hubSwitcherHtml('air')}
            <div class="pv2-wrap">
                <div class="pv2-hero">
                    <div class="kicker">AIR Rankings · All-India (NAADI)</div>
                    <h2>Overall Arena standings.</h2>
                    <p>Ranked by best NEET Arena full-paper score across all students.</p>
                    <div class="stats">
                        <div><b>${data.total_participants || 0}</b><span>Ranked</span></div>
                        <div><b>${topMarks || '—'}</b><span>Top score</span></div>
                        <div><b>${topAir ? '~' + Number(topAir).toLocaleString('en-IN') : '—'}</b><span>Best AIR</span></div>
                    </div>
                </div>
                ${myCard}
                <div style="margin:16px 4px 10px;"><span class="cs2-micro">Top students</span></div>
                ${entries.length === 0
                ? `<div class="cs2-empty"><i class="fa-solid fa-ranking-star"></i>No rankings yet — they appear after Arena full-paper attempts.</div>`
                : `<div style="display:flex;flex-direction:column;gap:9px;">${entries.map(airRow).join('')}</div>`}
            </div>`;
    } catch (e) {
        container.innerHTML = `${hubSwitcherHtml('air')}
            <div class="m-picker-wrap"><div class="empty-state"><i class="fa-solid fa-circle-exclamation"></i>
            <h3>Could not load rankings</h3><p style="margin-top:8px;color:var(--s500);">${escapeHtml(e.message)}</p>
            <button class="btn btn-outline" style="margin-top:16px;min-height:44px;" onclick="loadAirRankings()">
                <i class="fa-solid fa-rotate-right"></i> Retry</button></div></div>`;
    }
}

console.log('Practice Hub (mobile) module loaded ✅');