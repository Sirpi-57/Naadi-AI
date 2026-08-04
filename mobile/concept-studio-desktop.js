/* ════════════════════════════════════════════════════════════════
   NAADI AI — CONCEPT STUDIO · DESKTOP WORKSTATION  (engine)
   concept-studio-desktop.js
   ─────────────────────────────────────────────────────────────────
   A desktop-native rebuild of Concept Studio's rendering. This file is
   an ENTIRELY SEPARATE code path from the mobile module:

     • It runs ONLY when the viewport is ≥1024px (a phone / Capacitor
       build never crosses that width, so this code never executes
       there). The whole module is behind that gate — on a narrow
       viewport it registers a single matchMedia listener and does
       nothing else: no globals reassigned, no DOM touched.
     • It does not edit concept-studio.js. It overrides three GLOBAL
       entry points that navigate() calls — loadQuickRevise,
       loadReviseChapters, startRevisionJourney — swapping in the
       desktop renderers while it is active, and restoring the mobile
       originals if the viewport ever drops below the breakpoint.
     • It reuses the app's data layer and contracts unchanged:
       apiCall(), the same /api/revision/* endpoints, the same
       POST /api/revision/progress/update actions, pingStreak(), and
       the same `nd_cs_visited_v1` localStorage store the mobile app
       uses — so a student's progress is identical on either device.

   Pairs with concept-studio-desktop.css (csd- namespace).
   ════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    var MQ = '(min-width: 1024px)';
    var COMPACT_MQ = '(max-width: 1200px)';

    // ── originals we override (captured lazily, so we never depend on
    //    script order beyond concept-studio.js having defined them) ──
    var orig = {};
    var active = false;

    // Local, dependency-free helpers with graceful fallback to the app's
    // globals (which are always present here, but this keeps us robust).
    function esc(s) { return (window.escapeHtml ? window.escapeHtml(s) : String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')); }
    function safe(s) { return (window.safeHtml ? window.safeHtml(s) : esc(s)); }
    function abs(u) {
        if (window.absUrl) return window.absUrl(u);
        if (!u) return '';
        if (/^https?:\/\//i.test(u) || u.indexOf('data:') === 0) return u;
        var base = (typeof API_BASE !== 'undefined' ? API_BASE : '');
        return base + (u.charAt(0) === '/' ? u : '/' + u);
    }
    function api() { return window.apiCall.apply(null, arguments); }
    function toast(m, t) { if (window.ndToast) window.ndToast(m, t); }
    function still() { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }

    function snippet(text, n) {
        if (!text) return '';
        var t = String(text).replace(/<[^>]*>/g, '').trim();
        return t.length > n ? t.slice(0, n - 1).replace(/\s+$/, '') + '…' : t;
    }
    function textLen(o) { try { return JSON.stringify(o || {}).length; } catch (e) { return 0; } }
    function mins(chars) { return Math.max(1, Math.round(chars / 450)); }
    function h(strings) { return strings; } // noop tag placeholder (kept for readability)

    // ════════════════════════════════════════════════════════════
    // STATE  (kept entirely separate from the mobile reviseState)
    // ════════════════════════════════════════════════════════════
    var S = {
        classLevel: 11,
        subject: null,
        chapters: [],
        chapterProgress: {},
        chFilter: 'all',
        chQuery: '',
        // journey
        chapterId: null,
        chapterName: null,
        meta: null,
        blockOrder: [],
        blockSummaries: {},
        blocksCompleted: new Set(),
        loadedBlocks: {},
        curBlockId: null,
        curBlockIdx: 0,
        curSecId: null,
        secOrder: [],
        fc: {},   // blockId -> flashcard state
        ar: {},   // blockId -> assertion-reason state
        q: {},    // question key -> {selected, submitted}
        qIndex: {},
        pyqPager: {}, // blockId -> {items, cur}
        figPager: {}, // blockId -> cur
        doneArmed: false
    };

    // ── shared visited store (same key + shape as the mobile app) ──
    var VKEY = 'nd_cs_visited_v1';
    function vStore() { try { return JSON.parse(localStorage.getItem(VKEY) || '{}') || {}; } catch (e) { return {}; } }
    function vWrite(st) { try { localStorage.setItem(VKEY, JSON.stringify(st)); } catch (e) { } }
    function vAdd(ch, bid, sec) {
        var st = vStore(); st[ch] = st[ch] || {}; st[ch][bid] = st[ch][bid] || [];
        if (st[ch][bid].indexOf(sec) < 0) { st[ch][bid].push(sec); vWrite(st); }
    }
    function vSet(ch, bid) { var st = vStore(); return new Set((st[ch] && st[ch][bid]) || []); }
    function vCount(ch, bid) { return vSet(ch, bid).size; }

    // ════════════════════════════════════════════════════════════
    // SMALL UI PRIMITIVES
    // ════════════════════════════════════════════════════════════
    var _rseq = 0;
    function ring(pct, size, stroke) {
        pct = Math.max(0, Math.min(100, Math.round(pct || 0)));
        var r = (size - stroke) / 2, c = 2 * Math.PI * r, gid = 'csdg' + (++_rseq);
        var empty = pct <= 0;
        var fs = Math.max(11, Math.round(size * 0.3));
        var lbl = empty ? '' :
            '<div class="lbl" style="font-size:' + fs + 'px">' +
            (pct >= 100 ? '<i class="fa-solid fa-check done"></i>'
                : '<span class="num" data-t="' + pct + '">0</span><span class="u">%</span>') + '</div>';
        return '<div class="csd-ring' + (empty ? ' empty' : '') + '" data-pct="' + pct + '" data-c="' + c.toFixed(2) + '" style="width:' + size + 'px;height:' + size + 'px">' +
            '<svg width="' + size + '" height="' + size + '"><defs><linearGradient id="' + gid + '" x1="0%" y1="0%" x2="100%" y2="100%">' +
            '<stop offset="0%" stop-color="#1f5896"/><stop offset="100%" stop-color="#0f6f8c"/></linearGradient></defs>' +
            '<circle class="track" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke-width="' + stroke + '"/>' +
            '<circle class="fill" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke-width="' + stroke + '" stroke="url(#' + gid + ')" stroke-linecap="round" stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + c.toFixed(2) + '"/></svg>' + lbl + '</div>';
    }
    function animateRings(root) {
        (root || document).querySelectorAll('.csd-ring').forEach(function (el) {
            if (el._done) return; el._done = true;
            var pct = Math.min(parseFloat(el.dataset.pct) || 0, 100), c = parseFloat(el.dataset.c);
            var fill = el.querySelector('.fill');
            requestAnimationFrame(function () {
                requestAnimationFrame(function () { if (fill) fill.style.strokeDashoffset = (c * (1 - pct / 100)).toFixed(2); });
            });
            var num = el.querySelector('.num');
            if (num) {
                if (still()) { num.textContent = pct; return; }
                var t0 = performance.now(), dur = 850;
                (function tick(t) {
                    var p = Math.min((t - t0) / dur, 1), e = 1 - Math.pow(1 - p, 3);
                    num.textContent = Math.round(pct * e); if (p < 1) requestAnimationFrame(tick);
                })(t0);
            }
        });
    }

    // ECG pulse — the brand's own trace, revealed left→right by progress.
    function ecg(pct) {
        pct = Math.max(0, Math.min(100, Math.round(pct || 0)));
        var d = 'M0 15 H30 L34 15 L38 4 L44 26 L49 15 H64 C68 15 68 8 73 8 C78 8 78 15 83 15 H132';
        return '<div class="csd-ecg" aria-hidden="true">' +
            '<svg viewBox="0 0 132 30" preserveAspectRatio="none">' +
            '<path class="base" d="' + d + '" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" pathLength="100"/>' +
            '<path class="lead" d="' + d + '" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" pathLength="100" stroke-dasharray="100" stroke-dashoffset="' + (100 - pct) + '"/>' +
            '</svg></div>';
    }

    function seclabel(t) { return '<div class="csd-seclabel"><span class="t">' + esc(t) + '</span><span class="ln"></span></div>'; }

    function skel(n, hgt) {
        var out = '';
        for (var i = 0; i < n; i++) out += '<div class="csd-skel" style="height:' + hgt + 'px;margin-bottom:12px;animation-delay:' + (i * 90) + 'ms"></div>';
        return out;
    }
    function errBox(msg, retry) {
        return '<div class="csd-empty"><i class="fa-solid fa-circle-exclamation"></i><div>' + esc(msg) + '</div>' +
            (retry ? '<button class="csd-btn ghost" onclick="' + retry + '"><i class="fa-solid fa-rotate-right"></i> Try again</button>' : '') + '</div>';
    }

    // accordion
    var _aseq = 0;
    function acc(title, icon, inner) {
        var id = 'csd-acc-' + (++_aseq);
        return '<div class="csd-acc"><button class="head" aria-expanded="false" onclick="csdAcc(this,\'' + id + '\')">' +
            '<i class="fa-solid ' + icon + '"></i><span>' + esc(title) + '</span><i class="fa-solid fa-chevron-down caret"></i></button>' +
            '<div class="body" id="' + id + '" hidden>' + inner + '</div></div>';
    }
    window.csdAcc = function (btn, id) {
        var b = document.getElementById(id); if (!b) return;
        var open = !b.hidden; b.hidden = open; btn.classList.toggle('open', !open); btn.setAttribute('aria-expanded', open ? 'false' : 'true');
    };

    // ════════════════════════════════════════════════════════════
    // 1 · PICKER  (overrides loadQuickRevise)
    // ════════════════════════════════════════════════════════════
    function loadPicker() {
        var c = document.getElementById('quick-revise-content');
        if (!c) return;
        c.innerHTML =
            '<div class="csd"><div class="csd-picker">' +
            '<div class="csd-picker-head"><div>' +
            '<span class="csd-eyebrow" style="color:var(--indigo)">Block by block · Intern Doctor Console</span>' +
            '<h1>Concept Studio</h1>' +
            '<p>One concept at a time, Doctor — the exact definition, the values worth memorising, real NEET questions and figure analysis, woven into a single bench.</p>' +
            '</div>' +
            '<div class="csd-seg" role="tablist" aria-label="Class">' +
            '<button role="tab" class="' + (S.classLevel === 11 ? 'active' : '') + '" onclick="csdSetClass(11)">Class 11</button>' +
            '<button role="tab" class="' + (S.classLevel === 12 ? 'active' : '') + '" onclick="csdSetClass(12)">Class 12</button>' +
            '</div></div>' +
            '<div id="csd-resume-slot"></div>' +
            '<div id="csd-subjects" class="csd-subjects">' + skel(3, 150) + '</div>' +
            '</div></div>';
        loadSubjects(S.classLevel);
        paintResume();
    }
    window.csdSetClass = function (cls) {
        if (S.classLevel === cls) return;
        S.classLevel = cls;
        document.querySelectorAll('.csd-seg button').forEach(function (b) { b.classList.remove('active'); });
        document.querySelectorAll('.csd-seg button')[cls === 11 ? 0 : 1].classList.add('active');
        loadSubjects(cls);
    };

    function paintResume() {
        var slot = document.getElementById('csd-resume-slot'); if (!slot) return;
        api('/api/revision/progress').then(function (all) {
            S.chapterProgress = all.progress || {};
            var p = pickResume(S.chapterProgress);
            if (!p || !document.getElementById('csd-resume-slot')) return;
            var pct = Math.round(p.completion_percentage || 0);
            var done = (p.blocks_completed || []).length, total = p.total_blocks || 0;
            slot.innerHTML =
                '<button class="csd-resume" onclick="csdResume(\'' + esc(p.chapter_id) + '\',\'' + esc((p.chapter_name || '').replace(/'/g, '\\\'')) + '\')">' +
                ring(pct, 52, 5) +
                '<span><span class="csd-eyebrow rs-eyebrow">Pick up where you left off</span>' +
                '<span class="rs-name">' + esc(p.chapter_name) + '</span>' +
                '<span class="rs-sub">' + (total ? done + ' of ' + total + ' concepts done' : pct + '% done') + '</span></span>' +
                '<span class="rs-go"><i class="fa-solid fa-play"></i></span></button>';
            animateRings(slot);
        }).catch(function () { });
    }
    window.csdResume = function (id, name) { navigate('revise-journey', { chapter_id: id, chapter_name: name }); };

    function pickResume(map, restrict) {
        var rows = Object.keys(map || {}).map(function (k) { return map[k]; }).filter(function (p) {
            if (!p || !p.chapter_id || !p.chapter_name) return false;
            if (restrict && !restrict.has(p.chapter_id)) return false;
            var pct = p.completion_percentage || 0; return pct > 0 && pct < 100;
        });
        if (!rows.length) return null;
        rows.sort(function (a, b) { return String(b.last_active || '').localeCompare(String(a.last_active || '')); });
        return rows[0];
    }

    function loadSubjects(cls) {
        var grid = document.getElementById('csd-subjects'); if (!grid) return;
        grid.innerHTML = skel(3, 150);
        var icons = { Biology: 'fa-dna', Physics: 'fa-atom', Chemistry: 'fa-flask-vial' };
        api('/api/revision/subjects/' + cls).then(function (data) {
            var subs = data.subjects || [];
            if (!subs.length) { grid.innerHTML = '<div class="csd-empty" style="grid-column:1/-1"><i class="fa-solid fa-book-open"></i>Class ' + cls + ' revision material appears here once it\'s uploaded.</div>'; return; }
            grid.innerHTML = subs.map(function (s) {
                return '<button class="csd-subject" onclick="csdOpenSubject(\'' + esc(s.subject) + '\',' + cls + ')">' +
                    '<span class="sic"><i class="fa-solid ' + (icons[s.subject] || 'fa-book-open') + '"></i></span>' +
                    '<span><span class="sname">' + esc(s.subject) + '</span>' +
                    '<span class="smeta">' + s.total_chapters + ' chapter' + (s.total_chapters !== 1 ? 's' : '') + '</span></span>' +
                    '<span class="sgo">Open chapters <i class="fa-solid fa-arrow-right"></i></span></button>';
            }).join('');
        }).catch(function (e) {
            grid.innerHTML = '<div style="grid-column:1/-1">' + errBox('Couldn\'t load subjects — ' + e.message, 'csdReloadSubjects()') + '</div>';
        });
    }
    window.csdReloadSubjects = function () { loadSubjects(S.classLevel); };
    window.csdOpenSubject = function (subject, cls) { loadBoard(subject, cls); };

    // ════════════════════════════════════════════════════════════
    // 2 · CHAPTER BOARD  (overrides loadReviseChapters)
    // ════════════════════════════════════════════════════════════
    function loadBoard(subject, cls) {
        S.subject = subject; S.classLevel = cls; S.chFilter = 'all'; S.chQuery = '';
        var c = document.getElementById('quick-revise-content'); if (!c) return;
        c.innerHTML =
            '<div class="csd"><div class="csd-board">' +
            '<div class="csd-board-top"><button class="csd-back" onclick="csdBackToPicker()"><i class="fa-solid fa-arrow-left"></i> Subjects</button></div>' +
            '<h1>' + esc(subject) + '</h1><div class="csd-board-sub">Class ' + cls + '</div>' +
            '<div style="margin-top:22px">' + skel(4, 96) + '</div></div></div>';
        Promise.all([
            api('/api/revision/chapters/' + cls + '/' + subject),
            api('/api/revision/progress').catch(function () { return { progress: {} }; })
        ]).then(function (res) {
            var chapters = (res[0].chapters) || [];
            S.chapters = chapters;
            S.chapterProgress = res[1].progress || {};
            var ids = new Set(chapters.map(function (x) { return x.chapter_id; }));
            var resume = pickResume(S.chapterProgress, ids);
            paintBoard(subject, cls, resume);
        }).catch(function (e) {
            c.querySelector('.csd-board').insertAdjacentHTML('beforeend', errBox('Couldn\'t load chapters — ' + e.message, 'csdOpenSubject(\'' + esc(subject) + '\',' + cls + ')'));
        });
    }
    window.csdBackToPicker = function () { loadPicker(); };

    function chapCounts() {
        var inprog = 0, notstarted = 0, done = 0;
        S.chapters.forEach(function (ch) {
            var p = S.chapterProgress[ch.chapter_id]; var pct = p ? (p.completion_percentage || 0) : 0;
            if (pct >= 100) done++; else if (pct > 0) inprog++; else notstarted++;
        });
        return { all: S.chapters.length, inprog: inprog, notstarted: notstarted, done: done };
    }

    function paintBoard(subject, cls, resume) {
        var c = document.getElementById('quick-revise-content'); if (!c) return;
        var ct = chapCounts();
        var filters = [
            { id: 'all', label: 'All', n: ct.all },
            { id: 'inprog', label: 'In progress', n: ct.inprog },
            { id: 'notstarted', label: 'Not started', n: ct.notstarted },
            { id: 'done', label: 'Done', n: ct.done }
        ].filter(function (x) { return x.id === 'all' || x.n > 0; });

        var resumeHtml = '';
        if (resume) {
            var pct = Math.round(resume.completion_percentage || 0), dn = (resume.blocks_completed || []).length, tt = resume.total_blocks || 0;
            resumeHtml = '<button class="csd-resume" style="margin:0 0 22px" onclick="csdResume(\'' + esc(resume.chapter_id) + '\',\'' + esc((resume.chapter_name || '').replace(/'/g, '\\\'')) + '\')">' +
                ring(pct, 52, 5) + '<span><span class="csd-eyebrow rs-eyebrow">Resume</span><span class="rs-name">' + esc(resume.chapter_name) + '</span>' +
                '<span class="rs-sub">' + (tt ? dn + ' of ' + tt + ' concepts done' : pct + '% done') + '</span></span>' +
                '<span class="rs-go"><i class="fa-solid fa-play"></i></span></button>';
        }

        c.innerHTML =
            '<div class="csd"><div class="csd-board">' +
            '<div class="csd-board-top"><button class="csd-back" onclick="csdBackToPicker()"><i class="fa-solid fa-arrow-left"></i> Subjects</button></div>' +
            '<h1>' + esc(subject) + '</h1><div class="csd-board-sub">Class ' + cls + ' · ' + S.chapters.length + ' chapters</div>' +
            resumeHtml +
            '<div class="csd-board-controls">' +
            (filters.length > 1 ? '<div class="csd-filter" role="tablist">' + filters.map(function (f) {
                return '<button role="tab" data-f="' + f.id + '" class="' + (S.chFilter === f.id ? 'active' : '') + '" onclick="csdFilter(\'' + f.id + '\')">' + f.label + '<span class="n">' + f.n + '</span></button>';
            }).join('') + '</div>' : '<div></div>') +
            (S.chapters.length > 8 ? '<div class="csd-search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" placeholder="Search chapters" aria-label="Search chapters" oninput="csdSearch(this.value)"></div>' : '') +
            '</div>' +
            '<div class="csd-chapters" id="csd-chapters"></div>' +
            '</div></div>';
        renderChapters();
    }
    window.csdFilter = function (id) {
        S.chFilter = id;
        document.querySelectorAll('.csd-filter button').forEach(function (b) { b.classList.toggle('active', b.dataset.f === id); });
        renderChapters();
    };
    window.csdSearch = function (v) { S.chQuery = (v || '').trim().toLowerCase(); renderChapters(); };

    function renderChapters() {
        var host = document.getElementById('csd-chapters'); if (!host) return;
        var q = S.chQuery, f = S.chFilter;
        var list = S.chapters.map(function (ch, i) { return { ch: ch, i: i }; }).filter(function (o) {
            var ch = o.ch;
            if (q && String(ch.chapter_name || '').toLowerCase().indexOf(q) < 0) return false;
            if (f === 'all') return true;
            var p = S.chapterProgress[ch.chapter_id]; var pct = p ? (p.completion_percentage || 0) : 0;
            if (f === 'done') return pct >= 100;
            if (f === 'inprog') return pct > 0 && pct < 100;
            if (f === 'notstarted') return pct === 0;
            return true;
        });
        if (!list.length) { host.innerHTML = '<div class="csd-empty" style="grid-column:1/-1"><i class="fa-solid fa-filter"></i>' + (q ? 'No chapters match “' + esc(q) + '”.' : 'Nothing in this filter yet.') + '</div>'; return; }
        host.innerHTML = list.map(function (o) {
            var ch = o.ch, p = S.chapterProgress[ch.chapter_id];
            var pct = p ? (p.completion_percentage || 0) : 0, done = p ? (p.blocks_completed || []).length : 0;
            var bits = [ch.total_blocks + ' concept' + (ch.total_blocks !== 1 ? 's' : '')];
            if (pct > 0) bits.push(done + '/' + ch.total_blocks + ' done');
            else if (ch.total_flashcards) bits.push(ch.total_flashcards + ' flashcards');
            if (ch.pyq_linked_blocks > 0) bits.push(ch.pyq_linked_blocks + ' PYQ');
            return '<button class="csd-chapter ' + (pct >= 100 ? 'done' : '') + '" onclick="csdOpenChapter(' + o.i + ')">' +
                ring(pct, 52, 5) +
                '<span><span class="cname">' + esc(ch.chapter_name) + '</span>' +
                '<span class="cmeta">' + bits.join(' · ') + '</span>' +
                (ch.tier_a_count > 0 ? '<span class="ctags"><span class="csd-chip star"><i class="fa-solid fa-star"></i>' + ch.tier_a_count + ' must-know</span></span>' : '') +
                '</span></button>';
        }).join('');
        animateRings(host);
    }
    window.csdOpenChapter = function (i) {
        var ch = S.chapters[i]; if (!ch) return;
        navigate('revise-journey', { chapter_id: ch.chapter_id, chapter_name: ch.chapter_name });
    };

    // ════════════════════════════════════════════════════════════
    // 3 · JOURNEY WORKSTATION  (overrides startRevisionJourney)
    // ════════════════════════════════════════════════════════════
    var SECTIONS = {
        understand: { icon: 'fa-book-open', title: 'Understand', desc: 'Definition, values, the exam tip' },
        visual: { icon: 'fa-diagram-project', title: 'Visual map', desc: 'Where it sits · the process' },
        apply: { icon: 'fa-flask', title: 'Apply it', desc: 'Spot it, then solve it' },
        traps: { icon: 'fa-triangle-exclamation', title: 'NEET traps', desc: 'The mistake + A–R drill' },
        cards: { icon: 'fa-layer-group', title: 'Flashcards', desc: 'Full recall — hardest first' },
        pyq: { icon: 'fa-scroll', title: 'Past questions', desc: 'Real NEET + practice' },
        figures: { icon: 'fa-image', title: 'Figures', desc: 'NCERT diagrams, decoded' },
        recap: { icon: 'fa-user-doctor', title: "NAADI's recap", desc: 'Before you go' }
    };

    function startJourney(chapterId, chapterName) {
        S.chapterId = chapterId; S.chapterName = chapterName;
        S.loadedBlocks = {}; S.fc = {}; S.ar = {}; S.q = {}; S.qIndex = {}; S.pyqPager = {}; S.figPager = {};

        // Reveal the app shell (navigate() hid it for the mobile full-screen
        // journey; on desktop we own the viewport with a fixed workstation,
        // so the hidden shell is harmless — but we make sure our overlay is
        // present). Render the fixed workstation directly to <body> region
        // via the journey container.
        var c = document.getElementById('revise-journey-content'); if (!c) return;
        removeOverlays();
        c.innerHTML = '<div id="csd-station"><div class="csd-top"></div>' +
            '<div class="csd-chart"></div>' +
            '<div class="csd-center"><div class="csd-center-scroll"><div class="csd-inner">' + skel(6, 60) + '</div></div></div>' +
            '<div class="csd-spine"></div></div>';

        Promise.all([
            api('/api/revision/chapter/' + chapterId + '/meta'),
            api('/api/revision/progress/' + chapterId)
        ]).then(function (r) {
            var meta = r[0], prog = r[1];
            S.meta = meta;
            S.blockOrder = meta.block_order || [];
            S.blockSummaries = {};
            (meta.block_summaries || []).forEach(function (s) { S.blockSummaries[s.block_id] = s; });
            S.blocksCompleted = new Set(prog.blocks_completed || []);
            var firstIncomplete = S.blockOrder.findIndex(function (bid) { return !S.blocksCompleted.has(bid); });
            S.curBlockIdx = firstIncomplete >= 0 ? firstIncomplete : 0;
            renderStation();
            openBlock(S.curBlockIdx, true);
        }).catch(function (e) {
            var inner = document.querySelector('#csd-station .csd-inner');
            if (inner) inner.innerHTML = errBox('Couldn\'t load this chapter — ' + e.message, 'csdRetryJourney()');
        });
    }
    window.csdRetryJourney = function () { startJourney(S.chapterId, S.chapterName); };

    function headerStats() {
        var total = S.blockOrder.length, done = S.blocksCompleted.size;
        var pct = total ? Math.round(done / total * 100) : 0;
        var tierARemaining = (S.meta && S.meta.tier_a_count || 0) - Array.from(S.blocksCompleted).filter(function (bid) {
            var s = S.blockSummaries[bid]; return s && s.tier === 'A';
        }).length;
        return { total: total, done: done, pct: pct, tierARemaining: Math.max(0, tierARemaining) };
    }

    // ── the top bar + left chart (persistent chrome) ──
    function renderStation() {
        var st = document.getElementById('csd-station'); if (!st) return;
        var meta = S.meta || {}, hs = headerStats();
        st.querySelector('.csd-top').innerHTML =
            '<button class="csd-iconbtn" aria-label="Back to chapters" onclick="csdExitJourney()"><i class="fa-solid fa-arrow-left"></i></button>' +
            '<button class="csd-iconbtn csd-chart-toggle" id="csd-chart-toggle" aria-label="Hide concept chart" aria-pressed="false" onclick="csdToggleChart()"><i class="fa-solid fa-table-columns"></i></button>' +
            '<div class="ct-mid"><div class="ct-title">' + esc(meta.chapter_name || S.chapterName || 'Chapter') + '</div>' +
            '<div class="ct-sub">' + esc(meta.subject || '') + (meta.ncert_class ? ' · Class ' + esc(String(meta.ncert_class)) : '') + '</div></div>' +
            '<div class="csd-pulse">' + ecg(hs.pct) + '<span class="pv">' + hs.pct + '<span class="u">%</span></span></div>';
        renderChart();
        applyChartState();
    }
    window.csdExitJourney = function () {
        if (typeof niaSetContext === 'function') niaSetContext({ surface: 'generic' });
        removeOverlays(); navigate('quick-revise'); if (S.subject) setTimeout(function () { loadBoard(S.subject, S.classLevel); }, 0);
    };

    // ── collapsible case chart (desktop only) — remembers the preference ──
    function applyChartState() {
        if (S.chartCollapsed === undefined) { try { S.chartCollapsed = localStorage.getItem('nd_csd_chart_collapsed') === '1'; } catch (e) { S.chartCollapsed = false; } }
        var st = document.getElementById('csd-station'); if (!st) return;
        st.classList.toggle('chart-collapsed', !!S.chartCollapsed);
        var btn = document.getElementById('csd-chart-toggle');
        if (btn) {
            btn.setAttribute('aria-label', S.chartCollapsed ? 'Show concept chart' : 'Hide concept chart');
            btn.setAttribute('aria-pressed', S.chartCollapsed ? 'true' : 'false');
            btn.classList.toggle('on', !!S.chartCollapsed);
        }
    }
    window.csdToggleChart = function () {
        S.chartCollapsed = !S.chartCollapsed;
        try { localStorage.setItem('nd_csd_chart_collapsed', S.chartCollapsed ? '1' : '0'); } catch (e) { }
        applyChartState();
    };

    function renderChart() {
        var chart = document.querySelector('#csd-station .csd-chart'); if (!chart) return;
        var hs = headerStats();
        var rows = S.blockOrder.map(function (bid, i) {
            var s = S.blockSummaries[bid] || {};
            var isDone = S.blocksCompleted.has(bid), isCur = i === S.curBlockIdx, isA = s.tier === 'A';
            var opened = vCount(S.chapterId, bid);
            var tags = '';
            if (isA) tags += '<span class="csd-chip star"><i class="fa-solid fa-star"></i>Must know</span>';
            if (isCur) tags += '<span class="rhere">Working here</span>';
            else if (!isDone && opened > 0) tags += '<span class="rhere" style="color:var(--s400)">' + opened + ' opened</span>';
            return '<button class="csd-round ' + (isDone ? 'done ' : '') + (isCur ? 'active-block ' : '') + (isA ? 'tier-a' : '') + '" onclick="csdOpenBlock(' + i + ')" aria-label="Concept ' + (i + 1) + ': ' + esc(s.heading || bid) + '">' +
                '<span class="idx">' + (isDone ? '<i class="fa-solid fa-check"></i>' : (i + 1)) + '</span>' +
                '<span><span class="rtitle">' + esc(s.heading || bid.replace(/_/g, ' ')) + '</span>' +
                (tags ? '<span class="rtags">' + tags + '</span>' : '') + '</span></button>';
        }).join('');
        chart.innerHTML =
            '<div class="csd-chart-head">' +
            '<div class="ch-eyebrow"><span class="csd-eyebrow">Case chart</span></div>' +
            '<div class="ch-stat">' + ring(hs.pct, 46, 5) +
            '<div class="txt"><strong>' + hs.done + ' of ' + hs.total + '</strong><br>concepts done</div></div>' +
            (hs.tierARemaining > 0 ? '<div class="ch-must"><i class="fa-solid fa-star"></i> ' + hs.tierARemaining + ' must-know left</div>' : '') +
            '</div>' +
            '<div class="csd-rounds csd-scroll"><div class="csd-rounds-label csd-eyebrow">Concepts in order</div>' + rows + '</div>';
        animateRings(chart);
    }

    // ── load a block into the workstation ──
    window.csdOpenBlock = function (i) { openBlock(i, false); };
    function openBlock(idx, initial) {
        if (idx < 0 || idx >= S.blockOrder.length) return;
        S.curBlockIdx = idx; S.doneArmed = false;
        var bid = S.blockOrder[idx];
        // refresh chart active state
        renderChart();
        var inner = document.querySelector('#csd-station .csd-inner');
        if (inner && !initial) inner.innerHTML = skel(5, 60);

        var cached = S.loadedBlocks[bid];
        var work = cached ? Promise.resolve(cached) : Promise.all([
            api('/api/revision/chapter/' + S.chapterId + '/block/' + bid),
            api('/api/revision/chapter/' + S.chapterId + '/flashcards/' + bid)
        ]).then(function (r) { var d = r[0]; d._flashcards = (r[1].flashcards) || []; S.loadedBlocks[bid] = d; return d; });

        work.then(function (data) {
            if (!S.fc[bid]) S.fc[bid] = fcInit(data._flashcards || []);
            renderBlock(bid, data, idx);
        }).catch(function (e) {
            var innr = document.querySelector('#csd-station .csd-inner');
            if (innr) innr.innerHTML = errBox('Couldn\'t load this concept — ' + e.message, 'csdOpenBlock(' + idx + ')');
        });
    }

    // decide which teaching angles a block actually carries
    function blockSections(bid, data) {
        var L1 = data.layer1 || {}, L2 = data.layer2 || {}, L3 = data.layer3 || {};
        var summary = S.blockSummaries[bid] || {};
        var isA = data.tier === 'A' || summary.tier === 'A';
        var cards = data._flashcards || [];
        var pyq = data.pyq_links || {};
        var matched = pyq.matched_questions || [], variants = pyq.variants || [];
        var figs = data.linked_figure_details || [];
        var cm = data.concept_map || {}, fc = data.flowchart || {};
        var secs = [];
        secs.push({ id: 'understand', desc: snippet(L1.exact_definition || L1.precision_statement || SECTIONS.understand.desc, 42), mins: mins(textLen(L1)) });
        if (cm.node_label || (fc.nodes || []).length) secs.push({ id: 'visual', desc: (fc.nodes || []).length ? (fc.title || 'The process, step by step') : 'Where this sits', mins: 1 });
        if (Object.keys(L2).length) secs.push({ id: 'apply', desc: snippet(L2.application_principle || SECTIONS.apply.desc, 42), mins: mins(textLen(L2)) });
        if (isA || L3.the_trap || (L3.assertion_reason_pair || {}).assertion) secs.push({ id: 'traps', danger: true, desc: L3.the_trap ? snippet(L3.the_trap, 42) : 'The A–R drill NEET loves', mins: mins(textLen(L3)) });
        if (cards.length) secs.push({ id: 'cards', desc: SECTIONS.cards.desc, mins: Math.max(1, Math.round(cards.length * 0.4)), count: cards.length });
        if (matched.length || variants.length) secs.push({ id: 'pyq', desc: (matched.length ? matched.length + ' real' : '') + (matched.length && variants.length ? ' · ' : '') + (variants.length ? variants.length + ' practice' : ''), mins: Math.max(1, matched.length + variants.length), count: matched.length + variants.length });
        if (figs.length) secs.push({ id: 'figures', desc: SECTIONS.figures.desc, mins: Math.max(1, figs.length), count: figs.length });
        return secs;
    }

    function buildRecap(data) {
        var L1 = data.layer1 || {}, L2 = data.layer2 || {}, L3 = data.layer3 || {}, pyq = data.pyq_links || {};
        var items = [];
        if ((L1.critical_conditions || []).length) items.push({ icon: 'fa-triangle-exclamation', title: 'Watch out for', plain: '<ul>' + L1.critical_conditions.map(function (c) { return '<li>' + safe(c) + '</li>'; }).join('') + '</ul>' });
        if (L1.neet_one_liner) items.push({ icon: 'fa-lightbulb', title: 'Exam tip', plain: safe(L1.neet_one_liner) });
        if (L2.comparison_trap) items.push({ icon: 'fa-xmark', title: 'Common trap', danger: true, plain: safe(L2.comparison_trap) });
        if (L2.examiner_angle) items.push({ icon: 'fa-bullseye', title: "Examiner's angle", plain: safe(L2.examiner_angle) });
        if (L3.the_trap) items.push({ icon: 'fa-skull-crossbones', title: 'The trap', danger: true, plain: safe(L3.the_trap) });
        if ((pyq.years_appeared || []).length) items.push({ icon: 'fa-scroll', title: 'Asked in NEET', plain: 'NEET ' + esc(pyq.years_appeared.join(' and ')) + ' — ' + (pyq.matched_questions || []).length + ' real question' + ((pyq.matched_questions || []).length !== 1 ? 's' : '') + ' on this concept.' });
        return items;
    }

    function renderBlock(bid, data, idx) {
        var inner = document.querySelector('#csd-station .csd-inner'); if (!inner) return;
        var summary = S.blockSummaries[bid] || {};
        var isA = data.tier === 'A' || summary.tier === 'A';
        var importance = summary.neet_importance || data.neet_importance || '';
        var isDone = S.blocksCompleted.has(bid);
        var title = (data.layer1 || {}).headline || summary.heading || bid.replace(/_/g, ' ');
        var precision = (data.layer1 || {}).precision_statement || '';
        var secs = blockSections(bid, data);
        var recap = buildRecap(data);
        if (recap.length) secs.push({ id: 'recap', desc: recap.length + ' things NEET tests here', mins: 1 });
        S.secOrder = secs.map(function (s) { return s.id; });
        S.curBlockId = bid;
        S.curSecId = secs.length ? secs[0].id : null;

        var hs = headerStats();
        var allDone = hs.total > 0 && hs.done >= hs.total;

        var tags = '';
        if (isA) tags += '<span class="csd-chip star"><i class="fa-solid fa-star"></i>Must know</span>';
        if (importance === 'high' && !isA) tags += '<span class="csd-chip grad">High priority</span>';
        if (isDone) tags += '<span class="csd-chip done"><i class="fa-solid fa-check"></i>Done</span>';

        inner.innerHTML =
            (allDone ? '<div class="csd-celebrate"><div class="ico"><i class="fa-solid fa-trophy"></i></div><h3>Chapter complete</h3><p>All ' + hs.total + ' concepts covered, Doctor. Revisit any concept on the left to keep it sharp.</p></div>' : '') +
            '<div class="csd-bhead">' +
            (tags ? '<div class="btags">' + tags + '</div>' : '') +
            '<h1>' + safe(title) + '</h1>' +
            (precision ? '<div class="precision">' + safe(precision) + '</div>' : '') +
            (recap.length ? '<div class="csd-teaser"><span class="ava"><i class="fa-solid fa-user-doctor"></i></span><span>I found <strong>' + recap.length + ' thing' + (recap.length !== 1 ? 's' : '') + '</strong> NEET likes to test here — they\'re waiting in the recap when you\'re ready.</span></div>' : '') +
            '</div>' +
            // center section switcher — wrapping panels (always visible on desktop)
            '<div class="csd-strip" id="csd-strip"></div>' +
            '<div id="csd-pane" class="csd-swap"></div>' +
            // inline actions — only shown when the right spine is hidden (≤1200px)
            '<div class="csd-inline-actions" id="csd-inline-actions"></div>';

        renderSpine(bid, secs, data);
        renderStrip(bid, secs);
        renderInlineActions(bid, idx);
        openSection(bid, S.curSecId, true);
        var scroll = document.querySelector('#csd-station .csd-center-scroll'); if (scroll) scroll.scrollTop = 0;
    }

    // ── right rail: the section spine + block actions ──
    function renderSpine(bid, secs, data) {
        var spine = document.querySelector('#csd-station .csd-spine'); if (!spine) return;
        var visited = vSet(S.chapterId, bid);
        var stations = secs.map(function (s) {
            var m = SECTIONS[s.id];
            var seen = visited.has(s.id);
            return '<button class="csd-station ' + (s.id === S.curSecId ? 'active ' : '') + (s.danger ? 'danger ' : '') + (s.id === 'recap' ? 'recap ' : '') + (seen ? 'visited' : '') + '" data-sec="' + s.id + '" onclick="csdSection(\'' + s.id + '\')">' +
                '<span class="sic"><i class="fa-solid ' + m.icon + '"></i></span>' +
                '<span><span class="stt"><span class="t">' + m.title + '</span>' +
                (s.count ? '<span class="scount">' + s.count + '</span>' : '') +
                '<span class="m">' + s.mins + ' min</span></span>' +
                '<span class="sd">' + esc(s.desc || m.desc) + '</span></span></button>';
        }).join('');
        spine.innerHTML =
            '<div class="csd-spine-scroll"><div class="csd-spine-label csd-eyebrow">This concept</div>' + stations + '</div>' +
            spineFoot(bid);
        wireBlockActions();
    }

    function spineFoot(bid) {
        var idx = S.curBlockIdx, total = S.blockOrder.length;
        var opened = vCount(S.chapterId, bid), totalSecs = S.secOrder.length;
        var isDone = S.blocksCompleted.has(bid);
        var pct = totalSecs ? Math.round(opened / totalSecs * 100) : 0;
        return '<div class="csd-spine-foot">' +
            '<div class="csd-opened"><span>' + opened + ' of ' + totalSecs + ' opened</span><span class="bar"><i style="width:' + pct + '%"></i></span></div>' +
            '<div class="csd-blocknav">' +
            '<button ' + (idx === 0 ? 'disabled' : '') + ' onclick="csdOpenBlock(' + (idx - 1) + ')"><i class="fa-solid fa-arrow-left"></i> Prev</button>' +
            '<button ' + (idx >= total - 1 ? 'disabled' : '') + ' onclick="csdOpenBlock(' + (idx + 1) + ')">Next <i class="fa-solid fa-arrow-right"></i></button>' +
            '</div>' +
            '<button class="csd-done-btn ' + (isDone ? 'done-state' : '') + '" id="csd-done" ' + (isDone ? 'disabled' : '') + ' onclick="csdMarkDone()">' +
            (isDone ? '<i class="fa-solid fa-circle-check"></i> Concept completed' : '<i class="fa-solid fa-circle-check"></i> Mark concept done') + '</button>' +
            '</div>';
    }

    function renderStrip(bid, secs) {
        var strip = document.getElementById('csd-strip'); if (!strip) return;
        strip.innerHTML = secs.map(function (s) {
            var m = SECTIONS[s.id];
            return '<button data-sec="' + s.id + '" class="' + (s.id === S.curSecId ? 'active' : '') + '" onclick="csdSection(\'' + s.id + '\')"><i class="fa-solid ' + m.icon + '"></i>' + m.title + '</button>';
        }).join('');
    }
    function renderInlineActions(bid, idx) {
        var el = document.getElementById('csd-inline-actions'); if (!el) return;
        var total = S.blockOrder.length, isDone = S.blocksCompleted.has(bid);
        el.innerHTML =
            '<button class="csd-btn ghost" ' + (idx === 0 ? 'disabled' : '') + ' onclick="csdOpenBlock(' + (idx - 1) + ')"><i class="fa-solid fa-arrow-left"></i> Prev</button>' +
            '<button class="csd-done-btn" style="flex:1" id="csd-done-inline" ' + (isDone ? 'disabled' : '') + ' onclick="csdMarkDone()">' + (isDone ? '<i class="fa-solid fa-circle-check"></i> Completed' : '<i class="fa-solid fa-circle-check"></i> Mark concept done') + '</button>' +
            '<button class="csd-btn ghost" ' + (idx >= total - 1 ? 'disabled' : '') + ' onclick="csdOpenBlock(' + (idx + 1) + ')">Next <i class="fa-solid fa-arrow-right"></i></button>';
    }
    function wireBlockActions() { /* handlers are inline; hook kept for symmetry */ }

    // ── switch the active teaching angle (instant, in-pane) ──
    window.csdSection = function (secId) { openSection(S.curBlockId, secId, false); };
    function openSection(bid, secId, initial) {
        if (!bid) bid = S.curBlockId;
        var data = S.loadedBlocks[bid]; if (!data) return;
        S.curSecId = secId;
        vAdd(S.chapterId, bid, secId);

        // Nia reads along. IDs only — the server resolves the actual
        // text, so this cannot be forged and stays byte-identical across
        // students on the same concept, which is what makes the model's
        // prefix cache hit.
        if (typeof niaSetContext === 'function') {
            niaSetContext({
                surface: 'studio',
                chapter_id: S.chapterId,
                concept_id: bid,
                concept_name: (S.blockSummaries[bid] || {}).title
                    || (S.blockSummaries[bid] || {}).name || '',
                section_id: secId
            });
        }
        var pane = document.getElementById('csd-pane'); if (!pane) return;
        pane.classList.remove('csd-swap'); void pane.offsetWidth; pane.classList.add('csd-swap');
        pane.innerHTML = sectionBody(bid, secId, data);
        // update active states
        document.querySelectorAll('#csd-station .csd-station[data-sec], #csd-strip button[data-sec]').forEach(function (el) {
            el.classList.toggle('active', el.dataset.sec === secId);
        });
        // mark visited tick + opened bar
        var stn = document.querySelector('#csd-station .csd-station[data-sec="' + secId + '"]');
        if (stn) stn.classList.add('visited');
        refreshOpened(bid);
        afterSection(bid, secId);
        var scroll = document.querySelector('#csd-station .csd-center-scroll');
        if (scroll && !initial) { if (scroll.scrollTo) scroll.scrollTo({ top: 0, behavior: still() ? 'auto' : 'smooth' }); else scroll.scrollTop = 0; }
        animateRings(pane);
    }
    function refreshOpened(bid) {
        var opened = vCount(S.chapterId, bid), total = S.secOrder.length, pct = total ? Math.round(opened / total * 100) : 0;
        var wrap = document.querySelector('#csd-station .csd-opened');
        if (wrap) { wrap.querySelector('span').textContent = opened + ' of ' + total + ' opened'; wrap.querySelector('.bar i').style.width = pct + '%'; }
    }
    function afterSection(bid, secId) {
        /* flashcard keys are bound when the popup opens; nothing to do here */
    }

    function sectionBody(bid, secId, data) {
        var m = SECTIONS[secId] || { icon: 'fa-book', title: secId, desc: '' };
        var head = '<div class="csd-sectitle ' + (secId === 'traps' ? 'danger' : '') + '"><span class="si"><i class="fa-solid ' + m.icon + '"></i></span>' +
            '<div><h2>' + m.title + '</h2><div class="sh">' + esc(m.desc) + '</div></div></div>';
        var body;
        switch (secId) {
            case 'understand': body = renderUnderstand(bid, data); break;
            case 'visual': body = renderVisual(data); break;
            case 'apply': body = renderApply(bid, data.layer2 || {}); break;
            case 'traps': body = renderTraps(bid, data.layer3 || {}); break;
            case 'cards': body = renderCards(bid); break;
            case 'pyq': body = renderPyq(bid, data.pyq_links || {}); break;
            case 'figures': body = renderFigures(bid, data.linked_figure_details || []); break;
            case 'recap': body = renderRecap(buildRecap(data)); break;
            default: body = '<div class="csd-empty">Nothing here yet.</div>';
        }
        return head + body;
    }

    // ════════════════════════════════════════════════════════════
    // SECTION RENDERERS
    // ════════════════════════════════════════════════════════════

    // UNDERSTAND — two-column: reading | figure + checkpoint + source
    function renderUnderstand(bid, data) {
        var L1 = data.layer1 || {};
        if (!Object.keys(L1).length) return '<div class="csd-empty"><i class="fa-solid fa-book-open"></i>No teaching notes for this concept yet.</div>';
        var main = '';
        if (L1.exact_definition) main += '<div class="csd-block">' + seclabel('Definition') + '<div class="csd-def">' + safe(L1.exact_definition) + '</div></div>';
        if ((L1.critical_conditions || []).length) main += '<div class="csd-block">' + seclabel('Watch out for') + '<div class="csd-ticks">' + L1.critical_conditions.map(function (c) { return '<div class="csd-tick warn">' + safe(c) + '</div>'; }).join('') + '</div></div>';
        if ((L1.named_values || []).length) main += '<div class="csd-block"><div class="csd-plate"><span class="tag"><i class="fa-solid fa-tag"></i> Named values — commit these</span><div class="csd-values">' + L1.named_values.map(function (v) { return '<span class="csd-value">' + safe(v) + '</span>'; }).join('') + '</div></div></div>';
        if (L1.formula_block) main += '<div class="csd-block"><div class="csd-plate"><span class="tag"><i class="fa-solid fa-square-root-variable"></i> Formula</span><div class="csd-formula">' + safe(L1.formula_block) + '</div></div></div>';
        if (L1.neet_one_liner) main += '<div class="csd-block"><div class="csd-insider"><span class="tag"><i class="fa-solid fa-lightbulb"></i> NEET tip</span>' + safe(L1.neet_one_liner) + '</div></div>';

        var side = '';
        var figs = data.linked_figure_details || [];
        if (figs.length && figs[0].image_url) {
            side += '<button class="csd-figjump" onclick="csdSection(\'figures\')"><img src="' + abs(figs[0].image_url) + '" alt=""><span><span class="fj-t">See the figure' + (figs.length > 1 ? 's (' + figs.length + ')' : '') + '</span><span class="fj-s">' + esc(snippet(figs[0].name || figs[0].label || 'NCERT figure', 40)) + '</span></span><i class="fa-solid fa-arrow-right" style="color:var(--s400)"></i></button>';
        }
        var cards = data._flashcards || [];
        if (cards.length) {
            var c0 = cards[0];
            side += '<div class="csd-recall"><div class="csd-eyebrow">Checkpoint · say it back</div><div class="q">' + safe(c0.front || c0.question || '') + '</div>' +
                '<button class="csd-btn ghost" id="csd-recall-btn" onclick="csdRecall()"><i class="fa-solid fa-eye"></i> Show answer</button>' +
                '<div class="a" id="csd-recall-a" hidden>' + safe(c0.back || c0.answer || '') + '</div></div>';
        }
        // NCERT source
        var pages = data.source_pages || [], pageUrls = data.page_urls || {};
        var pageList = pages.length ? pages : Object.keys(pageUrls).map(function (k) { return parseInt(k.replace('page_', '').replace('.png', ''), 10); }).filter(function (n) { return !isNaN(n); }).sort(function (a, b) { return a - b; });
        if (pageList.length && Object.keys(pageUrls).length) {
            side += '<button class="csd-source" onclick="csdOpenPages(\'' + bid + '\')"><i class="fa-solid fa-book-open"></i> NCERT page' + (pageList.length !== 1 ? 's ' + pageList[0] + '–' + pageList[pageList.length - 1] : ' ' + pageList[0]) + '<i class="fa-solid fa-up-right-and-down-left-from-center" style="margin-left:auto;color:var(--s400)"></i></button>';
        }
        if (!side) return main;
        return '<div class="csd-split"><div>' + main + '</div><div class="side">' + side + '</div></div>';
    }
    window.csdRecall = function () { var a = document.getElementById('csd-recall-a'), b = document.getElementById('csd-recall-btn'); if (a) a.hidden = false; if (b) b.remove(); };

    // VISUAL — concept map + flowchart (desktop canvas)
    function renderVisual(data) {
        var cm = data.concept_map || {}, fc = data.flowchart || {};
        var html = '';
        if (cm.node_label) {
            var kids = cm.child_nodes || [];
            var rels = (cm.key_relationships || []).map(function (r) {
                return '<div class="csd-rel"><span class="fr">' + esc(r.from || '') + '</span><span class="rl">' + esc(r.relation || '→') + '</span><span class="to">' + esc(r.to || '') + '</span></div>';
            }).join('');
            html += '<div class="csd-block">' + seclabel('Concept map') + '<div class="csd-map">' +
                (cm.parent_node ? '<span class="csd-map-node parent">' + esc(cm.parent_node) + '</span><span class="csd-map-link"></span>' : '') +
                '<span class="csd-map-node root">' + esc(cm.node_label) + '</span>' +
                (kids.length ? '<span class="csd-map-link"></span><span class="csd-map-fan">' + kids.map(function (k) { return '<span class="csd-map-child">' + esc(k) + '</span>'; }).join('') + '</span>' : '') +
                '</div>' +
                (rels ? '<div style="margin-top:18px"><div class="csd-eyebrow" style="margin-bottom:9px">Key relationships</div><div class="csd-rels">' + rels + '</div></div>' : '') +
                (cm.one_liner ? '<div class="csd-callout" style="margin-top:16px"><span class="co-tag"><i class="fa-solid fa-pen"></i> In one line</span>' + esc(cm.one_liner) + '</div>' : '') +
                '</div>';
        }
        if ((fc.nodes || []).length) {
            html += '<div class="csd-block">' + seclabel(esc(fc.title || 'Process flow')) + '<div class="csd-flow">' + flowchartSVG(fc) + '</div></div>';
        }
        return html || '<div class="csd-empty"><i class="fa-solid fa-diagram-project"></i>No visual map for this concept.</div>';
    }

    // desktop flowchart — larger nodes, real labels, wrapping, decisions
    function wrapLabel(text, maxChars, maxLines) {
        var words = String(text || '').trim().split(/\s+/), lines = [], cur = '';
        for (var i = 0; i < words.length; i++) {
            var w = words[i];
            if (!cur.length) { cur = w; continue; }
            if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
            else { lines.push(cur); cur = w; if (lines.length === maxLines - 1) break; }
        }
        if (cur) lines.push(cur);
        if (lines.length > maxLines) lines.length = maxLines;
        return lines;
    }
    function nodeSVG(x, y, w, label, isDecision, fs) {
        var lines = wrapLabel(label, Math.floor(w / (fs * 0.55)), 3);
        var lh = fs * 1.3, hh = Math.max(52, lines.length * lh + 26);
        var fill = isDecision ? '#eef4fa' : '#ffffff', stroke = isDecision ? '#5d92cf' : '#e6ebf2', color = isDecision ? '#1f5896' : '#334155';
        var cx = x + w / 2, y0 = y + hh / 2 - ((lines.length - 1) * lh) / 2;
        var text = lines.map(function (ln, i) { return '<tspan x="' + cx + '" y="' + (y0 + i * lh).toFixed(1) + '">' + esc(ln) + '</tspan>'; }).join('');
        return {
            h: hh, svg: '<g><rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + hh.toFixed(1) + '" rx="14" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5"/>' +
                '<text text-anchor="middle" dominant-baseline="central" font-family="DM Sans, sans-serif" font-size="' + fs + '" font-weight="' + (isDecision ? 700 : 500) + '" fill="' + color + '">' + text + '</text></g>'
        };
    }
    function flowchartSVG(fc) {
        var nodes = fc.nodes || [], edges = fc.edges || [];
        if (!nodes.length) return '';
        if ((fc.chart_type || 'linear') === 'comparison') return comparisonSVG(fc, nodes);
        var W = 520, NW = 380, GY = 40, FS = 15, x = (W - NW) / 2, cx = W / 2, y = 10, tops = [], bots = [], body = '';
        nodes.forEach(function (n) {
            var dec = n.type === 'decision', r = nodeSVG(x, y, NW, (n.label || n.id || '').trim(), dec, FS);
            tops.push(y); bots.push(y + r.h); body += r.svg; y += r.h + GY;
        });
        var H = y - GY + 10;
        function edge(fi, ti) { return '<line x1="' + cx + '" y1="' + bots[fi] + '" x2="' + cx + '" y2="' + (tops[ti] - 7) + '" stroke="#94a3b8" stroke-width="1.6" marker-end="url(#csd-arrow)"/>'; }
        var eh = '';
        if (edges.length) eh = edges.map(function (e) { var fi = nodes.findIndex(function (n) { return n.id === e.from; }), ti = nodes.findIndex(function (n) { return n.id === e.to; }); return (fi < 0 || ti < 0 || fi === ti) ? '' : edge(fi, ti); }).join('');
        else eh = nodes.slice(0, -1).map(function (_, i) { return edge(i, i + 1); }).join('');
        return '<svg width="100%" viewBox="0 0 ' + W + ' ' + H.toFixed(1) + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="' + esc(fc.title || 'Process flow') + '" style="max-width:560px;margin:0 auto;display:block">' +
            '<defs><marker id="csd-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="#94a3b8" stroke-width="1.6" stroke-linecap="round"/></marker></defs>' + eh + body + '</svg>';
    }
    function comparisonSVG(fc, nodes) {
        var labels = fc.column_labels || fc.columns || [fc.left_label, fc.right_label].filter(Boolean);
        var has = Array.isArray(labels) && labels.length >= 2;
        var mid = Math.ceil(nodes.length / 2), cols = [nodes.slice(0, mid), nodes.slice(mid)];
        var W = 540, NW = 250, GAP = 12, GY = 16, FS = 13, xs = [GAP, W - NW - GAP], headH = has ? 40 : 0, maxY = 0, body = '';
        cols.forEach(function (col, ci) {
            var y = headH ? headH + 14 : 10;
            if (has) body += '<rect x="' + xs[ci] + '" y="8" width="' + NW + '" height="32" rx="11" fill="' + (ci === 0 ? '#eef4fa' : '#e8f3f6') + '"/><text x="' + (xs[ci] + NW / 2) + '" y="24.5" text-anchor="middle" dominant-baseline="central" font-family="DM Sans" font-size="13" font-weight="700" fill="' + (ci === 0 ? '#1f5896' : '#0f6f8c') + '">' + esc(snippet(labels[ci], 26)) + '</text>';
            col.forEach(function (n) { var r = nodeSVG(xs[ci], y, NW, (n.label || n.id || '').trim(), false, FS); body += r.svg; y += r.h + GY; });
            maxY = Math.max(maxY, y);
        });
        var H = maxY - GY + 10;
        return '<svg width="100%" viewBox="0 0 ' + W + ' ' + H.toFixed(1) + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="' + esc(fc.title || 'Comparison') + '" style="max-width:560px;margin:0 auto;display:block">' + body + '</svg>';
    }

    // APPLY
    function renderApply(bid, L2) {
        if (!L2 || !Object.keys(L2).length) return '<div class="csd-empty"><i class="fa-solid fa-flask"></i>No application notes for this concept.</div>';
        var html = '';
        if (L2.application_principle) html += '<div class="csd-block"><div class="csd-lead"><span class="csd-eyebrow">The principle</span><p>' + safe(L2.application_principle) + '</p></div></div>';

        var ws = L2.worked_scenario || {};
        var scenario = '';
        if (ws.setup || ws.answer) {
            var steps = ws.approach || [];
            var gated = !!(steps.length || ws.answer) && !!ws.setup;
            var solution =
                '<div class="csd-steps">' + steps.map(function (s, i) {
                    return '<div class="csd-step"><div class="rail"><div class="n">' + (i + 1) + '</div>' + (i < steps.length - 1 ? '<div class="l"></div>' : '') + '</div><div class="txt">' + safe(s) + '</div></div>';
                }).join('') + '</div>' +
                (ws.answer ? '<div class="csd-answer"><i class="fa-solid fa-check"></i><span>' + safe(ws.answer) + '</span></div>' : '') +
                (ws.watch_for ? '<div class="csd-watch"><i class="fa-solid fa-triangle-exclamation"></i><span><b>Careful —</b> ' + safe(ws.watch_for) + '</span></div>' : '');
            scenario = seclabel('Worked scenario') + '<div class="csd-scenario">' +
                (ws.setup ? '<div class="setup">' + safe(ws.setup) + '</div>' : '') +
                (gated ? '<button class="csd-try" id="csd-try" onclick="csdReveal()"><i class="fa-solid fa-pen-to-square"></i> Try it yourself, then reveal the steps</button><div id="csd-work" hidden>' + solution + '</div>' : solution) +
                '</div>';
        }
        var cues = '';
        if ((L2.identification_cues || []).length) {
            cues = seclabel('Spot it by') + '<div class="csd-cues">' + L2.identification_cues.map(function (c, i) { return '<div class="csd-cue"><span class="n">' + (i + 1) + '</span><span>' + safe(c) + '</span></div>'; }).join('') + '</div>';
        }
        if (scenario && cues) html += '<div class="csd-block"><div class="csd-split"><div>' + scenario + '</div><div class="side">' + cues + '</div></div></div>';
        else if (scenario) html += '<div class="csd-block">' + scenario + '</div>';
        else if (cues) html += '<div class="csd-block">' + cues + '</div>';

        if (L2.comparison_trap) html += '<div class="csd-block"><div class="csd-danger"><span class="tag"><i class="fa-solid fa-xmark"></i> Comparison trap</span>' + safe(L2.comparison_trap) + '</div></div>';
        if (L2.examiner_angle) html += '<div class="csd-block">' + acc('How the examiner will ask it', 'fa-bullseye', '<div class="csd-prose">' + safe(L2.examiner_angle) + '</div>') + '</div>';
        return html || '<div class="csd-empty"><i class="fa-solid fa-flask"></i>No application notes for this concept.</div>';
    }
    window.csdReveal = function () { var w = document.getElementById('csd-work'), b = document.getElementById('csd-try'); if (w) w.hidden = false; if (b) b.remove(); };

    // TRAPS — the_trap + assertion/reason drill
    var AR_OPTIONS = [
        { id: 'A', short: 'Both true — R explains A', full: 'Both A and R are true, and R is the correct explanation of A' },
        { id: 'B', short: 'Both true — R does not explain A', full: 'Both A and R are true, but R is NOT the correct explanation of A' },
        { id: 'C', short: 'A true, R false', full: 'A is true, but R is false' },
        { id: 'D', short: 'A false, R true', full: 'A is false, but R is true' }
    ];
    function resolveAR(ar) {
        var raw = String(ar.correct_answer || '').trim(); if (!raw) return null;
        if (/^[ABCD]$/i.test(raw)) return raw.toUpperCase();
        if (/^\([ABCD]\)$/i.test(raw)) return raw.charAt(1).toUpperCase();
        var norm = function (s) { return String(s).toLowerCase().replace(/[^a-z]/g, ''); }, n = norm(raw);
        for (var i = 0; i < AR_OPTIONS.length; i++) if (norm(AR_OPTIONS[i].full) === n || norm(AR_OPTIONS[i].short) === n) return AR_OPTIONS[i].id;
        var hits = AR_OPTIONS.filter(function (o) { return n.indexOf(norm(o.full)) >= 0 || norm(o.full).indexOf(n) >= 0; });
        return hits.length === 1 ? hits[0].id : null;
    }
    function renderTraps(bid, L3) {
        if (!L3 || !Object.keys(L3).length) return '<div class="csd-empty"><i class="fa-solid fa-shield"></i>No traps recorded — stay sharp anyway.</div>';
        var html = '';
        if (L3.the_trap) html += '<div class="csd-block"><div class="csd-danger hard"><span class="tag"><i class="fa-solid fa-skull-crossbones"></i> The trap</span>' + safe(L3.the_trap) + '</div></div>';
        var ar = L3.assertion_reason_pair || {};
        if (ar.assertion && ar.reason) {
            var correct = resolveAR(ar);
            var plate = '<div class="csd-ar-plate"><div class="row"><b>ASSERTION (A)</b>' + safe(ar.assertion) + '</div><div class="row"><b>REASON (R)</b>' + safe(ar.reason) + '</div></div>';
            if (!correct) {
                html += '<div class="csd-block">' + seclabel('Assertion–Reason · NEET favourite') + plate + (ar.explanation ? '<div class="csd-callout"><span class="co-tag"><i class="fa-solid fa-circle-info"></i> How it works</span>' + safe(ar.explanation) + '</div>' : '') + '</div>';
            } else {
                if (!S.ar[bid]) S.ar[bid] = { selected: null, submitted: false };
                html += '<div class="csd-block">' + seclabel('Assertion–Reason · NEET favourite') + plate +
                    '<div class="csd-opts" role="radiogroup" aria-label="Assertion reason options">' + AR_OPTIONS.map(function (o) {
                        return '<button class="csd-opt two" id="csd-ar-' + o.id + '" role="radio" aria-checked="false" onclick="csdArSel(\'' + o.id + '\')"><span class="key">' + o.id + '</span><span class="ot"><span class="o-short">' + o.short + '</span><span class="o-full">' + o.full + '</span></span></button>';
                    }).join('') + '</div>' +
                    '<button class="csd-btn primary csd-check" id="csd-ar-submit" disabled onclick="csdArSubmit()">Check answer</button>' +
                    '<div class="csd-reveal" id="csd-ar-reveal" style="display:none"><div class="csd-callout good"><span class="co-tag"><i class="fa-solid fa-check"></i> Correct answer: ' + correct + '</span>' + (ar.explanation ? safe(ar.explanation) : '') + '</div><button class="csd-btn ghost" onclick="csdArRetry()"><i class="fa-solid fa-rotate-right"></i> Try again</button></div>' +
                    '</div>';
            }
        }
        return html || '<div class="csd-empty"><i class="fa-solid fa-shield"></i>No traps recorded for this concept.</div>';
    }
    window.csdArSel = function (id) {
        var st = S.ar[S.curBlockId]; if (!st || st.submitted) return; st.selected = id;
        document.querySelectorAll('[id^="csd-ar-"]').forEach(function (el) { if (/^csd-ar-[ABCD]$/.test(el.id)) { el.classList.remove('sel'); el.setAttribute('aria-checked', 'false'); } });
        var el = document.getElementById('csd-ar-' + id); if (el) { el.classList.add('sel'); el.setAttribute('aria-checked', 'true'); }
        document.getElementById('csd-ar-submit').disabled = false;
    };
    window.csdArSubmit = function () {
        var bid = S.curBlockId, st = S.ar[bid]; if (!st || !st.selected || st.submitted) return;
        var ar = ((S.loadedBlocks[bid] || {}).layer3 || {}).assertion_reason_pair || {}, correct = resolveAR(ar);
        if (!correct) return; st.submitted = true;
        AR_OPTIONS.forEach(function (o) {
            var el = document.getElementById('csd-ar-' + o.id); if (!el) return; el.classList.add('locked'); el.classList.remove('sel');
            if (o.id === correct) el.classList.add('correct'); else if (o.id === st.selected) el.classList.add('wrong');
        });
        var sub = document.getElementById('csd-ar-submit'); if (sub) sub.style.display = 'none';
        var rev = document.getElementById('csd-ar-reveal'); if (rev) rev.style.display = 'grid';
    };
    window.csdArRetry = function () {
        var bid = S.curBlockId; S.ar[bid] = { selected: null, submitted: false };
        var pane = document.getElementById('csd-pane'); if (pane) { pane.innerHTML = sectionBody(bid, 'traps', S.loadedBlocks[bid]); }
    };

    // FLASHCARDS
    var DIFF_RANK = { hard: 0, medium: 1, easy: 2 };
    function fcInit(cards) {
        var all = (cards || []).slice();
        var order = all.map(function (c, i) { return i; }).sort(function (a, b) {
            var ra = DIFF_RANK[String(all[a].difficulty || 'medium').toLowerCase()]; if (ra == null) ra = 1;
            var rb = DIFF_RANK[String(all[b].difficulty || 'medium').toLowerCase()]; if (rb == null) rb = 1;
            return ra - rb || a - b;
        });
        return { allCards: all, order: order, pos: 0, flipped: false, results: {}, hist: [], requeued: new Set() };
    }
    function renderCards(bid) {
        var st = S.fc[bid]; var cards = st ? st.allCards : [];
        if (!cards || !cards.length) return '<div class="csd-empty"><i class="fa-solid fa-layer-group"></i>No flashcards for this concept.</div>';
        return '<div id="csd-fc-wrap">' + fcInlineHTML(bid) + '</div>';
    }
    // inline: a dark "deck" launcher — clicking it pops up the study modal.
    function fcInlineHTML(bid) {
        var st = S.fc[bid]; var total = st.allCards.length;
        if (st.pos >= st.order.length) return fcDoneHTML(bid, false);
        var studied = Object.keys(st.results).length;
        var segs = st.order.map(function (_, i) { var s = st.hist[i]; return '<div class="csd-fc-seg ' + (s === true ? 'ok' : s === false ? 'no' : '') + '"></div>'; }).join('');
        return '<button class="csd-fc-launch" onclick="csdFcOpen()" aria-label="Open flashcards in a focused view">' +
            '<span class="fl-ic"><i class="fa-solid fa-layer-group"></i></span>' +
            '<span class="fl-main"><span class="fl-t">Flip through ' + total + ' card' + (total !== 1 ? 's' : '') + '</span>' +
            '<span class="fl-s">' + (studied ? studied + ' of ' + total + ' studied — tap to continue' : 'Hardest first · full recall — tap to start') + '</span>' +
            '<span class="csd-fc-segs mini">' + segs + '</span></span>' +
            '<span class="fl-go"><i class="fa-solid fa-play"></i></span></button>';
    }
    function fcDoneHTML(bid, inModal) {
        var st = S.fc[bid]; var total = st.allCards.length;
        var missed = Object.keys(st.results).filter(function (k) { return !st.results[k]; }).map(Number);
        var correct = total - missed.length, pct = total ? Math.round(correct / total * 100) : 0;
        return '<div class="csd-fc-doneview' + (inModal ? ' on-dark' : '') + '">' + ring(pct, 100, 8) +
            '<h3>All ' + total + ' card' + (total !== 1 ? 's' : '') + ' done</h3>' +
            '<p>' + correct + ' of ' + total + ' landed' + (missed.length ? ' — ' + missed.length + ' still shaky' : ' — clean sweep, Doctor') + '</p><div class="dv-actions">' +
            (missed.length ? '<button class="csd-fc-btn got" onclick="csdFcMissed()"><i class="fa-solid fa-bolt"></i> Practise the ' + missed.length + ' I missed</button>' : '') +
            '<button class="csd-fc-btn" onclick="csdFcRestart()"><i class="fa-solid fa-rotate-right"></i> Go through all ' + total + ' again</button>' +
            (inModal ? '<button class="csd-fc-btn" onclick="csdFcClose()"><i class="fa-solid fa-check"></i> Done</button>' : '') +
            '</div></div>';
    }
    // the flip card itself — both faces dark, content scrolls so it can't spill.
    function fcCardHTML(bid) {
        var st = S.fc[bid]; if (!st) return ''; var order = st.order, pos = st.pos;
        var ci = order[pos], c = st.allCards[ci];
        var diff = c.difficulty || 'Medium', diffCls = String(diff).toLowerCase() === 'hard' ? 'danger' : '';
        var typeLabel = c.card_type === 'fill_blank' ? 'Fill blank' : c.card_type === 'mcq' ? 'MCQ' : (c.card_type || 'concept').replace(/_/g, ' ');
        var segs = order.map(function (_, i) { var s = st.hist[i]; return '<div class="csd-fc-seg ' + (i === pos ? 'cur' : '') + ' ' + (s === true ? 'ok' : s === false ? 'no' : '') + '"></div>'; }).join('');
        return '<div class="csd-fc">' +
            '<div class="csd-fc-progress"><div class="csd-fc-segs">' + segs + '</div><div class="csd-fc-count">' + (pos + 1) + ' / ' + order.length + '</div></div>' +
            '<div class="csd-fc-scene" id="csd-fc-scene" onclick="csdFcFlip()" role="button" tabindex="0" aria-label="Flashcard — activate to reveal the answer">' +
            '<div class="csd-fc-inner ' + (st.flipped ? 'flipped' : '') + '" id="csd-fc-inner">' +
            '<div class="csd-fc-face csd-fc-front"><div class="csd-fc-pills"><span class="csd-chip ' + diffCls + '">' + esc(String(diff)) + '</span><span class="csd-chip ghost">' + esc(typeLabel) + '</span></div>' +
            '<div class="csd-fc-q"><div class="fc-scrollc">' + safe(c.front || c.question || '') + '</div></div><div class="csd-fc-hint"><i class="fa-regular fa-hand-pointer"></i> Click or press Space to reveal</div></div>' +
            '<div class="csd-fc-face csd-fc-back"><div class="csd-fc-albl">Answer</div><div class="csd-fc-ans"><div class="fc-scrollc"><div>' + safe(c.back || c.answer || '') + '</div>' +
            (c.common_mistake ? '<div class="csd-fc-mis"><strong>Common mistake:</strong> ' + safe(c.common_mistake) + '</div>' : '') + '</div></div></div>' +
            '</div></div>' +
            '<div class="csd-fc-actions" style="' + (st.flipped ? '' : 'visibility:hidden') + '" id="csd-fc-actions">' +
            '<button class="csd-fc-btn got" onclick="event.stopPropagation();csdFcGot()"><i class="fa-solid fa-check"></i> Got it</button>' +
            '<button class="csd-fc-btn" onclick="event.stopPropagation();csdFcRetry()"><i class="fa-solid fa-rotate-right"></i> Review again</button></div>' +
            '</div>';
    }

    // ── popup modal ──
    window.csdFcOpen = function () {
        var bid = S.curBlockId, st = S.fc[bid]; if (!st) return;
        if (st.pos >= st.order.length) S.fc[bid] = fcInit(st.allCards); // finished → start fresh
        var el = document.getElementById('csd-fc-modal'); if (el) el.remove();
        el = document.createElement('div'); el.className = 'csd-fc-modal'; el.id = 'csd-fc-modal';
        el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Flashcards');
        el.innerHTML = '<div class="csd-fc-backdrop" onclick="csdFcClose()"></div>' +
            '<div class="csd-fc-dialog"><button class="csd-fc-x" aria-label="Close flashcards" onclick="csdFcClose()"><i class="fa-solid fa-xmark"></i></button>' +
            '<div id="csd-fc-modalbody"></div></div>';
        document.body.appendChild(el);
        requestAnimationFrame(function () { el.classList.add('in'); });
        fcModalPaint();
        document.addEventListener('keydown', fcModalKeys);
    };
    window.csdFcClose = function () {
        var el = document.getElementById('csd-fc-modal'); document.removeEventListener('keydown', fcModalKeys); if (!el) return;
        el.classList.remove('in'); setTimeout(function () { if (el && el.parentNode) el.remove(); }, 220);
        var bid = S.curBlockId, w = document.getElementById('csd-fc-wrap'); if (w) { w.innerHTML = fcInlineHTML(bid); animateRings(w); }
    };
    function fcModalKeys(e) {
        var bid = S.curBlockId, st = S.fc[bid]; if (!document.getElementById('csd-fc-modal') || !st) return;
        if (e.key === 'Escape') { e.preventDefault(); window.csdFcClose(); return; }
        if (st.pos >= st.order.length) return;
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); window.csdFcFlip(); }
        else if (st.flipped && e.key === 'ArrowLeft') { e.preventDefault(); window.csdFcGot(); }
        else if (st.flipped && e.key === 'ArrowRight') { e.preventDefault(); window.csdFcRetry(); }
    }
    function fcModalPaint() {
        var body = document.getElementById('csd-fc-modalbody'); if (!body) return;
        var bid = S.curBlockId, st = S.fc[bid];
        body.innerHTML = (st.pos >= st.order.length) ? fcDoneHTML(bid, true) : fcCardHTML(bid);
        animateRings(body);
    }
    // repaint whichever surface is showing (modal if open, else the inline deck)
    function fcRerender(bid) {
        if (document.getElementById('csd-fc-modal')) { fcModalPaint(); return; }
        var w = document.getElementById('csd-fc-wrap'); if (w) { w.innerHTML = fcInlineHTML(bid); animateRings(w); }
    }
    window.csdFcFlip = function () {
        var bid = S.curBlockId, st = S.fc[bid]; if (!st || st.pos >= st.order.length) return; st.flipped = !st.flipped;
        var inner = document.getElementById('csd-fc-inner'); if (inner) inner.classList.toggle('flipped', st.flipped);
        var act = document.getElementById('csd-fc-actions'); if (act) act.style.visibility = st.flipped ? 'visible' : 'hidden';
    };
    function syncFc(bid, ci, correct) {
        var st = S.fc[bid], card = st && st.allCards[ci];
        api('/api/revision/progress/update', 'POST', {
            chapter_id: S.chapterId, chapter_name: S.chapterName || '', total_blocks: S.blockOrder.length,
            action: 'flashcard_result', block_id: bid, current_block_index: S.curBlockIdx,
            flashcard_id: (card && card.flashcard_id) || (bid + '_card_' + ci), correct: !!correct
        }).catch(function () { });
    }
    window.csdFcGot = function () { var bid = S.curBlockId, st = S.fc[bid]; if (!st || st.pos >= st.order.length) return; var ci = st.order[st.pos]; st.results[ci] = true; st.hist[st.pos] = true; syncFc(bid, ci, true); st.pos++; st.flipped = false; fcRerender(bid); };
    window.csdFcRetry = function () { var bid = S.curBlockId, st = S.fc[bid]; if (!st || st.pos >= st.order.length) return; var ci = st.order[st.pos]; st.results[ci] = false; st.hist[st.pos] = false; syncFc(bid, ci, false); if (!st.requeued.has(ci)) { st.requeued.add(ci); st.order.push(ci); } st.pos++; st.flipped = false; fcRerender(bid); };
    window.csdFcRestart = function () { var bid = S.curBlockId; S.fc[bid] = fcInit(S.fc[bid].allCards); fcRerender(bid); };
    window.csdFcMissed = function () { var bid = S.curBlockId, st = S.fc[bid]; var missed = Object.keys(st.results).filter(function (k) { return !st.results[k]; }).map(Number); if (!missed.length) return; missed.forEach(function (i) { delete st.results[i]; }); st.order = missed; st.pos = 0; st.flipped = false; st.hist = []; st.requeued = new Set(); fcRerender(bid); };

    // PYQ
    function renderPyq(bid, pyq) {
        var matched = pyq.matched_questions || [], variants = pyq.variants || [];
        if (!matched.length && !variants.length) return '<div class="csd-empty"><i class="fa-solid fa-scroll"></i>No past questions for this concept.</div>';
        if (!S.pyqPager[bid]) {
            var items = [];
            matched.forEach(function (q, i) { items.push({ kind: 'real', q: q, key: 'real_' + bid + '_' + i }); });
            if (matched.length && variants.length) items.push({ kind: 'divider' });
            variants.forEach(function (v, i) { items.push({ kind: 'variant', q: v, key: 'var_' + bid + '_' + i }); });
            items.push({ kind: 'result' });
            items.forEach(function (it) { if (it.key) S.qIndex[it.key] = { correct: String(it.q.correct_answer || '').trim().toUpperCase(), kind: it.kind }; });
            S.pyqPager[bid] = { items: items, cur: 0, nReal: matched.length, nVar: variants.length };
        }
        var years = pyq.years_appeared || [];
        return '<div id="csd-pyq">' +
            (years.length ? '<div class="csd-prose" style="margin-bottom:16px;color:var(--s500);font-size:.88rem">This concept was asked in <strong>NEET ' + esc(years.join(', ')) + '</strong> — ' + matched.length + ' real question' + (matched.length !== 1 ? 's' : '') + (variants.length ? ' and ' + variants.length + ' practice variant' + (variants.length !== 1 ? 's' : '') : '') + '.</div>' : '') +
            '<div id="csd-pyq-inner">' + pyqInner(bid) + '</div></div>';
    }
    function pyqDots(bid) {
        var pg = S.pyqPager[bid];
        var out = pg.items.map(function (it, i) {
            var cls = i === pg.cur ? 'cur' : '';
            if (it.kind === 'divider') return '<div class="csd-pyq-dot div" title="Practice variants start here"><i class="fa-solid fa-dumbbell" style="font-size:.6rem"></i></div>';
            if (it.kind === 'result') return '<div class="csd-pyq-dot ' + cls + '" onclick="csdPyqJump(' + i + ')" title="Results"><i class="fa-solid fa-flag-checkered" style="font-size:.6rem"></i></div>';
            var st = S.q[it.key];
            if (st && st.submitted) { var ok = st.selected === (S.qIndex[it.key] || {}).correct; cls = (ok ? 'ok' : 'no') + (i === pg.cur ? ' cur' : ''); }
            var num = pg.items.slice(0, i + 1).filter(function (x) { return x.key; }).length;
            return '<button class="csd-pyq-dot ' + cls + '" onclick="csdPyqJump(' + i + ')">' + num + '</button>';
        }).join('');
        return '<div class="csd-pyq-index" id="csd-pyq-index">' + out + '</div>';
    }
    function pyqInner(bid) {
        return pyqDots(bid) + '<div id="csd-pyq-body">' + pyqItem(bid) + '</div>';
    }
    window.csdPyqJump = function (i) {
        var bid = S.curBlockId, pg = S.pyqPager[bid]; if (!pg || i < 0 || i >= pg.items.length) return;
        pg.cur = i;
        var wrap = document.getElementById('csd-pyq-inner');
        if (wrap) { wrap.innerHTML = pyqInner(bid); animateRings(wrap); }
    };
    function pyqItem(bid) {
        var pg = S.pyqPager[bid], it = pg.items[pg.cur];
        var navHtml = '<div class="csd-pyq-nav"><button class="csd-btn ghost" ' + (pg.cur === 0 ? 'disabled' : '') + ' onclick="csdPyqJump(' + (pg.cur - 1) + ')"><i class="fa-solid fa-arrow-left"></i> Prev</button>' +
            '<button class="csd-btn primary" ' + (pg.cur >= pg.items.length - 1 ? 'disabled' : '') + ' onclick="csdPyqJump(' + (pg.cur + 1) + ')">Next <i class="fa-solid fa-arrow-right"></i></button></div>';
        if (it.kind === 'divider') return '<div class="csd-divider-slide"><div class="dv-ico"><i class="fa-solid fa-dumbbell"></i></div><h3>That was the real thing</h3><p>You\'ve seen all ' + pg.nReal + ' question' + (pg.nReal !== 1 ? 's' : '') + ' NEET actually asked here. Next: ' + pg.nVar + ' practice variant' + (pg.nVar !== 1 ? 's' : '') + ', same idea from a fresh angle.</p><span class="csd-chip grad">Practice ahead — not past papers</span></div>' + navHtml;
        if (it.kind === 'result') return pyqResult(bid) + navHtml;
        return questionItem(it) + navHtml;
    }
    function questionItem(item) {
        var q = item.q, key = item.key;
        if (!S.q[key]) S.q[key] = { selected: null, submitted: false };
        var st = S.q[key], options = q.options || [], correct = (S.qIndex[key] || {}).correct || '';
        var tags = item.kind === 'real'
            ? (q.year ? '<span class="csd-chip year"><i class="fa-solid fa-scroll"></i>NEET ' + esc(String(q.year)) + '</span>' : '<span class="csd-chip year">Real NEET</span>') + (q.difficulty ? '<span class="csd-chip">' + esc(q.difficulty) + '</span>' : '') + (q.revision_priority === 'critical' ? '<span class="csd-chip star">Critical</span>' : '')
            : '<span class="csd-chip grad"><i class="fa-solid fa-dumbbell"></i>Practice variant</span>' + (q.variant_type ? '<span class="csd-chip">' + esc((q.variant_type || '').replace(/_/g, ' ')) + '</span>' : '');
        var opts = options.map(function (o) {
            var cls = 'csd-opt';
            if (st.submitted) { cls += ' locked'; if (o.id === correct) cls += ' correct'; else if (o.id === st.selected) cls += ' wrong'; }
            else if (o.id === st.selected) cls += ' sel';
            return '<button class="' + cls + '" id="csd-q-' + key + '-' + o.id + '" role="radio" aria-checked="' + (o.id === st.selected) + '" ' + (st.submitted ? 'disabled' : '') + ' onclick="csdQSel(\'' + key + '\',\'' + o.id + '\')"><span class="key">' + esc(o.id) + '</span><span class="ot">' + safe(o.text) + '</span></button>';
        }).join('');
        var reveal = '';
        if (item.kind === 'real') {
            reveal = '<div class="csd-callout good"><span class="co-tag"><i class="fa-solid fa-check"></i> Answer: ' + esc(q.correct_answer || '?') + '</span>' + (q.student_tip ? safe(q.student_tip) : '') + '</div>' +
                (q.static_explanation ? acc('Full step-by-step explanation', 'fa-list-ol', '<div class="csd-prose">' + safe(q.static_explanation) + '</div>') : '') +
                ((q.alternate_question_forms || []).length ? '<div class="csd-callout"><span class="co-tag"><i class="fa-solid fa-shuffle"></i> NEET also asks this as</span><div class="csd-ticks" style="margin-top:6px">' + q.alternate_question_forms.map(function (a) { return '<div class="csd-tick">' + safe(a) + '</div>'; }).join('') + '</div></div>' : '');
        } else {
            reveal = '<div class="csd-callout good"><span class="co-tag"><i class="fa-solid fa-check"></i> Answer: ' + esc(q.correct_answer || '?') + '</span></div>' +
                ((q.solution_steps || []).length ? '<div class="csd-scenario" style="margin-top:6px"><div class="csd-steps">' + q.solution_steps.map(function (s, i) { return '<div class="csd-step"><div class="rail"><div class="n">' + (i + 1) + '</div>' + (i < q.solution_steps.length - 1 ? '<div class="l"></div>' : '') + '</div><div class="txt">' + safe(s) + '</div></div>'; }).join('') + '</div></div>' : '');
        }
        return '<div class="csd-q-tags">' + tags + '</div><div class="csd-q-text">' + safe(q.question_text || '') + '</div>' +
            '<div class="csd-opts" role="radiogroup">' + opts + '</div>' +
            '<button class="csd-btn primary csd-check" id="csd-q-check-' + key + '" ' + (st.selected && !st.submitted ? '' : 'disabled') + ' ' + (st.submitted ? 'style="display:none"' : '') + ' onclick="csdQSubmit(\'' + key + '\')">Check answer</button>' +
            '<div class="csd-reveal" id="csd-q-reveal-' + key + '" ' + (st.submitted ? '' : 'style="display:none"') + '>' + reveal + '</div>';
    }
    window.csdQSel = function (key, id) {
        var st = S.q[key]; if (!st || st.submitted) return; st.selected = id;
        document.querySelectorAll('[id^="csd-q-' + key + '-"]').forEach(function (el) { el.classList.remove('sel'); el.setAttribute('aria-checked', 'false'); });
        var el = document.getElementById('csd-q-' + key + '-' + id); if (el) { el.classList.add('sel'); el.setAttribute('aria-checked', 'true'); }
        var b = document.getElementById('csd-q-check-' + key); if (b) b.disabled = false;
    };
    window.csdQSubmit = function (key) {
        var st = S.q[key]; if (!st || !st.selected || st.submitted) return; st.submitted = true;
        var correct = (S.qIndex[key] || {}).correct || '';
        document.querySelectorAll('[id^="csd-q-' + key + '-"]').forEach(function (el) {
            var id = el.id.replace('csd-q-' + key + '-', ''); el.classList.add('locked'); el.classList.remove('sel'); el.disabled = true;
            if (id === correct) el.classList.add('correct'); else if (id === st.selected) el.classList.add('wrong');
        });
        var b = document.getElementById('csd-q-check-' + key); if (b) b.style.display = 'none';
        var r = document.getElementById('csd-q-reveal-' + key); if (r) r.style.display = 'grid';
        // refresh the index dots so this question shows correct/wrong
        var bid = S.curBlockId, dotsEl = document.getElementById('csd-pyq-index');
        if (dotsEl && S.pyqPager[bid]) dotsEl.outerHTML = pyqDots(bid);
    };
    function pyqScore(bid) {
        var pg = S.pyqPager[bid]; if (!pg) return { done: 0, right: 0, total: 0, wrong: [] };
        var qs = pg.items.filter(function (i) { return i.key; }), right = 0, done = 0, wrong = [];
        qs.forEach(function (i) { var st = S.q[i.key]; if (st && st.submitted) { done++; if (st.selected === (S.qIndex[i.key] || {}).correct) right++; else wrong.push(i.key); } });
        return { done: done, right: right, total: qs.length, wrong: wrong };
    }
    function pyqResult(bid) {
        var s = pyqScore(bid);
        if (s.done === 0) return '<div class="csd-fc-doneview"><div class="dv-ico" style="width:58px;height:58px;border-radius:16px;display:grid;place-items:center;background:var(--csd-grad-soft);color:var(--g600);font-size:1.3rem"><i class="fa-solid fa-scroll"></i></div><h3>That\'s all ' + s.total + '</h3><p>You skipped past without answering — no score to show. Worth a real attempt: this is exactly how NEET asks it.</p><button class="csd-btn ghost" onclick="csdPyqJump(0)"><i class="fa-solid fa-rotate-left"></i> Start from the first question</button></div>';
        var pct = Math.round(s.right / s.done * 100);
        return '<div class="csd-fc-doneview">' + ring(pct, 96, 8) + '<h3>' + s.right + ' of ' + s.done + ' correct</h3><p>' + (s.wrong.length === 0 ? (s.done === s.total ? 'Clean sweep across every question, Doctor.' : 'Everything you attempted, right.') : s.wrong.length + ' to look at again' + (s.done < s.total ? ' · ' + (s.total - s.done) + ' unattempted' : '')) + '</p><div class="dv-actions">' +
            (s.wrong.length ? '<button class="csd-btn primary" onclick="csdPyqRetryWrong()"><i class="fa-solid fa-rotate-right"></i> Retry the ' + s.wrong.length + ' I missed</button>' : '') + '</div></div>';
    }
    window.csdPyqRetryWrong = function () {
        var bid = S.curBlockId, s = pyqScore(bid); if (!s.wrong.length) return;
        s.wrong.forEach(function (k) { S.q[k] = { selected: null, submitted: false }; });
        var pg = S.pyqPager[bid], first = pg.items.findIndex(function (i) { return i.key === s.wrong[0]; });
        if (first >= 0) csdPyqJump(first);
    };

    // FIGURES
    function renderFigures(bid, figs) {
        if (!figs || !figs.length) return '<div class="csd-empty"><i class="fa-solid fa-image"></i>No figures linked to this concept.</div>';
        if (S.figPager[bid] == null) S.figPager[bid] = 0;
        var cur = Math.min(S.figPager[bid], figs.length - 1);
        var dots = figs.length > 1 ? '<div class="csd-pyq-index">' + figs.map(function (f, i) { return '<button class="csd-pyq-dot ' + (i === cur ? 'cur' : '') + '" onclick="csdFigJump(' + i + ')">' + (i + 1) + '</button>'; }).join('') + '</div>' : '';
        return '<div id="csd-fig-body">' + dots + figureItem(bid, figs[cur], cur) + '</div>';
    }
    window.csdFigJump = function (i) { var bid = S.curBlockId; S.figPager[bid] = i; var pane = document.getElementById('csd-pane'); var data = S.loadedBlocks[bid]; if (pane) { pane.querySelector('#csd-fig-body').outerHTML = renderFigures(bid, data.linked_figure_details || []); } };
    function figureItem(bid, fig, fi) {
        var a = fig.image_analysis || {};
        var comps = a.labeled_components || [], angles = a.neet_question_angles || [], cross = a.cross_chapter_links || [], nums = a.numerical_relationships || [];
        var hasCoords = comps.some(function (c) { return c && c.x != null && c.y != null; });
        var hotspots = hasCoords ? '<div style="position:absolute;inset:12px">' + comps.map(function (c, i) { return (c.x == null || c.y == null) ? '' : '<button class="csd-hot" id="csd-hot-' + fi + '-' + i + '" style="left:' + c.x + '%;top:' + c.y + '%" onclick="csdFigLabel(' + fi + ',' + i + ')">' + (i + 1) + '</button>'; }).join('') + '</div>' : '';
        var pin = fig.image_url ? '<div class="csd-fig-pin"><div class="csd-fig-holder"><img src="' + abs(fig.image_url) + '" alt="' + esc(fig.name || fig.label || 'Figure') + '" onclick="csdFigOpen(' + fi + ')">' + hotspots + '</div><div class="csd-fig-zoom"><i class="fa-solid fa-up-right-and-down-left-from-center"></i> Click the figure to open full screen</div></div>' : '';
        var info =
            '<div class="csd-q-tags"><span class="csd-chip grad">' + esc(fig.label || 'Figure') + '</span>' + (fig.name ? '<span class="csd-chip ghost">' + esc(snippet(fig.name, 40)) + '</span>' : '') + '</div>' +
            (a.suggested_flashcard_front ? '<div class="csd-callout" style="margin-bottom:14px"><span class="co-tag"><i class="fa-solid fa-eye"></i> Before you read on</span>' + safe(a.suggested_flashcard_front) + '</div>' : '') +
            (a.concept_illustrated ? '<div class="csd-prose" style="margin-bottom:16px">' + safe(a.concept_illustrated) + '</div>' : '') +
            (comps.length ? '<div class="csd-block">' + seclabel('Labeled components · ' + comps.length) + comps.map(function (c, i) { return '<button class="csd-comp" id="csd-comp-' + fi + '-' + i + '" style="margin-bottom:8px" onclick="csdFigLabel(' + fi + ',' + i + ')"><span class="lbl">' + esc(c.label) + '</span><span class="cm">' + safe(c.meaning) + '</span></button>'; }).join('') + '</div>' : '') +
            (a.process_description ? '<div class="csd-block">' + acc('Step-by-step process', 'fa-list-ol', '<div class="csd-prose">' + safe(a.process_description) + '</div>') + '</div>' : '') +
            (angles.length ? '<div class="csd-block"><div class="csd-insider"><span class="tag"><i class="fa-solid fa-bullseye"></i> NEET asks this figure as</span><div class="csd-ticks" style="margin-top:6px">' + angles.map(function (x) { return '<div class="csd-tick">' + safe(x) + '</div>'; }).join('') + '</div></div></div>' : '') +
            (a.common_misconception ? '<div class="csd-block"><div class="csd-danger"><span class="tag"><i class="fa-solid fa-xmark"></i> Common misconception</span>' + safe(a.common_misconception) + '</div></div>' : '') +
            (nums.length ? '<div class="csd-block">' + acc('Key numbers & equations', 'fa-square-root-variable', '<div class="csd-numbers">' + nums.map(function (n) { return '<div class="row">' + safe(n) + '</div>'; }).join('') + '</div>') + '</div>' : '') +
            (cross.length ? '<div class="csd-block"><div class="csd-eyebrow" style="margin-bottom:8px">Also shows up in</div><div style="display:flex;flex-wrap:wrap;gap:6px">' + cross.map(function (c) { return '<span class="csd-chip ghost">' + esc(c) + '</span>'; }).join('') + '</div></div>' : '');
        if (!pin) return info;
        return '<div class="csd-fig">' + pin + '<div>' + info + '</div></div>';
    }
    window.csdFigLabel = function (fi, i) {
        document.querySelectorAll('[id^="csd-comp-' + fi + '-"],[id^="csd-hot-' + fi + '-"]').forEach(function (el) { el.classList.remove('active'); });
        var a = document.getElementById('csd-comp-' + fi + '-' + i), b = document.getElementById('csd-hot-' + fi + '-' + i);
        if (a) a.classList.add('active'); if (b) b.classList.add('active');
    };
    window.csdFigOpen = function (fi) {
        var figs = (S.loadedBlocks[S.curBlockId] || {}).linked_figure_details || [];
        var items = figs.filter(function (f) { return f.image_url; }).map(function (f) { return { url: f.image_url, caption: f.name || f.label || 'Figure' }; });
        var start = Math.max(0, items.findIndex(function (i) { return i.url === (figs[fi] || {}).image_url; }));
        if (items.length) lightbox(items, start, 'Figure');
    };

    // RECAP
    function renderRecap(items) {
        if (!items.length) return '<div class="csd-empty"><i class="fa-solid fa-user-doctor"></i>Nothing to recap for this concept.</div>';
        return '<div class="csd-recap"><div class="csd-recap-head"><span class="ava"><i class="fa-solid fa-user-doctor"></i></span><span><div class="csd-eyebrow re">Before you go</div><div class="rt">' + items.length + ' things NEET tests here</div></span></div>' +
            items.map(function (m) { return '<div class="csd-recap-item ' + (m.danger ? 'bad' : '') + '"><span class="ric"><i class="fa-solid ' + m.icon + '"></i></span><span><div class="rit">' + esc(m.title) + '</div><div class="rib">' + m.plain + '</div></span></div>'; }).join('') +
            '</div>';
    }

    // ── NCERT pages + lightbox ──
    window.csdOpenPages = function (bid) {
        var data = S.loadedBlocks[bid] || {}, pageUrls = data.page_urls || {}, sourcePages = data.source_pages || [];
        var pages = sourcePages.length ? sourcePages : Object.keys(pageUrls).map(function (k) { return parseInt(k.replace('page_', '').replace('.png', ''), 10); }).filter(function (n) { return !isNaN(n); }).sort(function (a, b) { return a - b; });
        var items = pages.map(function (p) { return { url: pageUrls['page_' + p + '.png'] || '', caption: 'NCERT page ' + p }; }).filter(function (i) { return i.url; });
        if (!items.length) { toast('No NCERT scans for this concept.', 'error'); return; }
        lightbox(items, 0, 'NCERT source');
    };
    var LB = { items: [], cur: 0, zoom: 1 };
    function lightbox(items, start, title) {
        LB.items = items; LB.cur = start || 0; LB.zoom = 1;
        var el = document.getElementById('csd-lb'); if (el) el.remove();
        el = document.createElement('div'); el.className = 'csd-lb'; el.id = 'csd-lb'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true');
        el.innerHTML = '<div class="csd-lb-head"><span class="t" id="csd-lb-title"></span>' +
            '<button onclick="csdLbZoom(-1)" aria-label="Zoom out"><i class="fa-solid fa-magnifying-glass-minus"></i></button>' +
            '<button onclick="csdLbZoom(1)" aria-label="Zoom in"><i class="fa-solid fa-magnifying-glass-plus"></i></button>' +
            '<button onclick="csdLbClose()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>' +
            '<div class="csd-lb-stage"><img id="csd-lb-img" alt="" ondblclick="csdLbZoom(0)"></div>' +
            '<div class="csd-lb-foot" id="csd-lb-foot"></div>';
        document.body.appendChild(el);
        requestAnimationFrame(function () { el.classList.add('in'); });
        lbPaint(); document.addEventListener('keydown', lbKeys);
    }
    function lbPaint() {
        var it = LB.items[LB.cur]; if (!it) return;
        var img = document.getElementById('csd-lb-img'), t = document.getElementById('csd-lb-title'), foot = document.getElementById('csd-lb-foot');
        if (img) { img.src = abs(it.url); img.alt = it.caption || 'Figure'; img.style.width = (LB.zoom * (LB.zoom > 1 ? 100 : 70)) + '%'; }
        if (t) t.textContent = it.caption || '';
        if (foot) foot.innerHTML = LB.items.length > 1 ? '<button onclick="csdLbGo(-1)" ' + (LB.cur === 0 ? 'disabled' : '') + ' aria-label="Previous"><i class="fa-solid fa-arrow-left"></i></button><span>' + (LB.cur + 1) + ' / ' + LB.items.length + '</span><button onclick="csdLbGo(1)" ' + (LB.cur >= LB.items.length - 1 ? 'disabled' : '') + ' aria-label="Next"><i class="fa-solid fa-arrow-right"></i></button>' : '';
    }
    window.csdLbGo = function (d) { var n = LB.cur + d; if (n < 0 || n >= LB.items.length) return; LB.cur = n; LB.zoom = 1; lbPaint(); };
    window.csdLbZoom = function (d) { var z = LB.zoom; LB.zoom = d === 0 ? (z > 1 ? 1 : 2.2) : Math.min(4, Math.max(1, z + d * 0.5)); lbPaint(); };
    window.csdLbClose = function () { var el = document.getElementById('csd-lb'); document.removeEventListener('keydown', lbKeys); if (!el) return; el.classList.remove('in'); setTimeout(function () { el.remove(); }, 220); };
    function lbKeys(e) { if (!document.getElementById('csd-lb')) return; if (e.key === 'Escape') window.csdLbClose(); else if (e.key === 'ArrowRight') window.csdLbGo(1); else if (e.key === 'ArrowLeft') window.csdLbGo(-1); }

    // ── mark concept done (same POST contract as mobile) ──
    window.csdMarkDone = function () {
        var bid = S.curBlockId;
        var btn = document.getElementById('csd-done'), btn2 = document.getElementById('csd-done-inline');
        if (S.blocksCompleted.has(bid)) return;
        var opened = vCount(S.chapterId, bid);
        if (opened === 0 && !S.doneArmed) {
            S.doneArmed = true;
            [btn, btn2].forEach(function (b) { if (b) { b.classList.add('warn-state'); b.innerHTML = '<i class="fa-solid fa-circle-question"></i> Nothing opened — mark done anyway?'; } });
            setTimeout(function () {
                if (S.doneArmed) { S.doneArmed = false;[btn, btn2].forEach(function (b) { if (b) { b.classList.remove('warn-state'); b.innerHTML = '<i class="fa-solid fa-circle-check"></i> Mark concept done'; } }); }
            }, 4000);
            return;
        }
        S.doneArmed = false;
        S.blocksCompleted.add(bid);
        var idx = S.blockOrder.indexOf(bid);
        var nextIncomplete = S.blockOrder.findIndex(function (b) { return !S.blocksCompleted.has(b); });
        [btn, btn2].forEach(function (b) { if (b) { b.disabled = true; b.classList.remove('warn-state'); b.classList.add('done-state'); b.innerHTML = '<i class="fa-solid fa-circle-check"></i> Concept completed'; } });
        api('/api/revision/progress/update', 'POST', {
            chapter_id: S.chapterId, action: 'complete', chapter_name: S.chapterName || '',
            block_id: bid, current_block_index: nextIncomplete >= 0 ? nextIncomplete : idx + 1, total_blocks: S.blockOrder.length
        }).then(function () { if (window.pingStreak) window.pingStreak('studio_block'); }).catch(function () { toast('Couldn\'t save progress — check your connection.', 'error'); });

        renderStation(); // refresh chart + ECG
        var hs = headerStats();
        var nextSummary = nextIncomplete >= 0 ? (S.blockSummaries[S.blockOrder[nextIncomplete]] || {}) : null;
        successMoment({
            title: hs.done >= hs.total ? 'Chapter complete!' : 'Concept done',
            sub: hs.done >= hs.total ? 'All ' + hs.total + ' concepts covered. Great work, Doctor.' : (nextSummary ? 'Next up: ' + snippet(nextSummary.heading || 'the next concept', 40) : hs.done + ' of ' + hs.total + ' done'),
            onEnd: function () { if (nextIncomplete >= 0) openBlock(nextIncomplete, false); else openBlock(idx, false); }
        });
    };
    function successMoment(o) {
        var s = document.createElement('div'); s.className = 'csd-success'; s.setAttribute('role', 'status');
        s.innerHTML = '<div class="ck"><i class="fa-solid fa-check"></i></div><h3>' + esc(o.title) + '</h3><p>' + esc(o.sub) + '</p><span class="sk">Continue <i class="fa-solid fa-arrow-right"></i></span>';
        document.body.appendChild(s);
        var fired = false, go = function () { if (fired) return; fired = true; s.remove(); if (o.onEnd) o.onEnd(); };
        s.addEventListener('click', go); setTimeout(go, 1700);
    }

    function removeOverlays() {
        document.removeEventListener('keydown', fcModalKeys);
        ['csd-lb', 'csd-success', 'csd-fc-modal'].forEach(function (id) { var el = document.getElementById(id); if (el) el.remove(); });
    }

    // ════════════════════════════════════════════════════════════
    // ACTIVATION — install/uninstall the desktop path at the breakpoint
    // ════════════════════════════════════════════════════════════
    function install() {
        if (active) return; active = true;
        ['loadQuickRevise', 'loadReviseChapters', 'startRevisionJourney'].forEach(function (fn) {
            if (typeof window[fn] === 'function' && !orig[fn]) orig[fn] = window[fn];
        });
        window.loadQuickRevise = loadPicker;
        window.loadReviseChapters = function (subject, cls) { loadBoard(subject, cls); };
        window.startRevisionJourney = function (id, name) { startJourney(id, name); };

        // If we're activating while a Studio view is already on screen, redraw it.
        var q = document.getElementById('view-quick-revise'), j = document.getElementById('view-revise-journey');
        if (j && j.classList.contains('active') && S.chapterId) startJourney(S.chapterId, S.chapterName);
        else if (q && q.classList.contains('active')) loadPicker();
    }
    function uninstall() {
        if (!active) return; active = false;
        removeOverlays();
        ['loadQuickRevise', 'loadReviseChapters', 'startRevisionJourney'].forEach(function (fn) {
            if (orig[fn]) window[fn] = orig[fn];
        });
        // Hand the current Studio view back to the mobile renderers.
        var q = document.getElementById('view-quick-revise'), j = document.getElementById('view-revise-journey');
        if (j && j.classList.contains('active') && S.chapterId && window.startRevisionJourney) window.startRevisionJourney(S.chapterId, S.chapterName);
        else if (q && q.classList.contains('active') && window.loadQuickRevise) window.loadQuickRevise();
    }

    var mql = window.matchMedia(MQ);
    function onChange(e) { if (e.matches) install(); else uninstall(); }
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else if (mql.addListener) mql.addListener(onChange); // older Safari

    // On load: only engage the desktop path if we're already wide. On a
    // phone this is false → nothing below runs, nothing is overridden.
    if (mql.matches) {
        // Wait until concept-studio.js has defined the originals. It loads
        // before this script (see app.html), so they exist synchronously;
        // the check is belt-and-suspenders for unusual load orders.
        if (typeof window.startRevisionJourney === 'function') install();
        else document.addEventListener('DOMContentLoaded', install);
    }

    console.log('Concept Studio · desktop workstation ready (engages ≥1024px)');
})();