/* ════════════════════════════════════════════════════════════════
   NAADI AI — ONBOARDING DECK (onboarding.js)  ·  v2
   ─────────────────────────────────────────────────────────────────
   Shown once, immediately after signup, before the app shell. Also
   replayable from Profile → "Take the tour again" (?replay=1), in
   which case nothing is written and Done returns to the app.

   Eleven slides:
      1  Welcome            (nameplate: Dr. <name>)
      2  Concept Studio
      3  OPD
      4  NEET Arena
      5  PYQ Vault
      6  Library
      7  Why it works       (pedagogy)
      8  Coverage           (audited numbers only — see COVERAGE_AUDIT)
      9  Where did you hear about us?   ← answer
     10  Your goals                     ← answer, skippable
     11  Enter                (nameplate reprise)

   Slides 9 and 10 are the only ones that collect anything. Both can
   be left blank; every field reappears in Profile. A global Skip in
   the header exits the deck at any point and still marks the tour as
   seen, so a student is never trapped in it.

   v2 — navigation. A tour is a thing you flick through, not a thing
   you scroll. Three ways to move, all going through onbGoTo():
       · the pill,
       · a horizontal swipe (the slide follows the thumb, with
         resistance at the two ends so the deck feels finite),
       · ← / → on a keyboard.
   Vertical scrolling is left alone: `touch-action: pan-y` on the
   shell means the browser keeps vertical gestures, and we only
   claim a gesture once it is clearly horizontal.

   Copy, slide order, payload and API contract are unchanged from v1.

   Requires: shared.js (auth, apiCall, ndToast, escapeHtml).
   Artwork:  assets/onboarding/onb-*.png — optional. If a file is
             missing the slide falls back to a gradient icon tile, so
             the deck is never broken by a missing asset.
   ════════════════════════════════════════════════════════════════ */

// ════════════════════════════════════════════════════════════════
// COVERAGE_AUDIT — slide 8's numbers.
// Only put a subject in here once you have actually run the audit for
// it. Every figure on that slide is rendered from this object, with
// its own scope line, so nothing on screen can outrun the evidence.
// Add Physics and Chemistry after they are audited; the slide will
// pick them up with no other change.
// ════════════════════════════════════════════════════════════════
const COVERAGE_AUDIT = {
    headline: { value: '97.8%', label: 'of NEET Biology questions were answered directly by NAADI content.' },
    scope: 'Audited 23 June 2026 against the NEET 2025 Biology re-exam: '
        + '90 questions, 33 chapters. 88 direct hits, 2 covered with different framing, 0 misses. '
        + 'Physics and Chemistry audits are in progress.',
};

const ART_DIR = 'assets/onboarding/';

// How far the thumb must travel before a swipe counts, and how far a
// flick must travel per millisecond to count without the distance.
const SWIPE_DISTANCE = 56;   // px
const SWIPE_VELOCITY = 0.45; // px/ms

// ── Attribution options (slide 9) ────────────────────────────────
// `wide` rows take the whole grid width. Everything with a label short
// enough to sit in half a phone stays in half a phone.
const SOURCES = [
    { id: 'instagram', label: 'Instagram', icon: 'fa-brands fa-instagram' },
    { id: 'facebook', label: 'Facebook', icon: 'fa-brands fa-facebook-f' },
    { id: 'youtube', label: 'YouTube', icon: 'fa-brands fa-youtube' },
    { id: 'google_ads', label: 'Google ad', icon: 'fa-brands fa-google' },
    { id: 'linkedin', label: 'LinkedIn', icon: 'fa-brands fa-linkedin-in' },
    { id: 'friend', label: 'A friend', icon: 'fa-solid fa-user-group' },
    { id: 'school_outreach', label: 'NAADI team visited my school', icon: 'fa-solid fa-school', wide: true },
    { id: 'other', label: 'Somewhere else', icon: 'fa-solid fa-ellipsis', wide: true },
];

// ── State ────────────────────────────────────────────────────────
const onbState = {
    index: 0,
    name: 'Doctor',
    replay: new URLSearchParams(location.search).get('replay') === '1',
    saving: false,
    answers: {
        onboarding_source: '',
        onboarding_source_other: '',
        guardian_phone: '',
        neet_target_year: '',
        neet_target_score: '',
        dream_college: '',
    },
};

// ════════════════════════════════════════════════════════════════
// SLIDES
// ════════════════════════════════════════════════════════════════
function onbSlides() {
    const name = escapeHtml(onbState.name);

    return [
        // ── 1 · Welcome ──────────────────────────────────────────
        {
            id: 'welcome',
            cta: 'Show me around',
            html: `
                ${plateHtml(name, 'NEET Aspirant')}
                <h1 class="onb-title">Every doctor <span class="accent">started exactly here.</span></h1>
                <p class="onb-sub">A name, a syllabus, and a long way to go. From today, NAADI walks
                    that distance with you — one concept at a time. All the best, ${name}.</p>`,
        },

        // ── 2 · Concept Studio ───────────────────────────────────
        {
            id: 'studio',
            art: 'onb-studio.png',
            icon: 'fa-solid fa-graduation-cap',
            eyebrow: 'Concept Studio',
            title: 'Learn a chapter the way it is <span class="accent">actually tested.</span>',
            sub: 'A chapter is not a pile of pages. It is a set of concepts, and NEET asks about them one by one.',
            points: [
                ['fa-solid fa-diagram-project', 'Concept-wise chapters', 'Every chapter is split into the concepts NEET actually asks about.'],
                ['fa-solid fa-layer-group', 'Flashcards, tagged', 'Each card is tied to the concept it tests, so you always know what you just got wrong.'],
                ['fa-solid fa-link', 'Every concept, its PYQ', 'Concepts carry the past-year question they produced — and its variants.'],
                ['fa-solid fa-sitemap', 'Flowcharts for recall', 'Built to be remembered under exam pressure, not to look pretty.'],
            ],
        },

        // ── 3 · OPD ──────────────────────────────────────────────
        {
            id: 'opd',
            art: 'onb-opd.png',
            icon: 'fa-solid fa-notes-medical',
            eyebrow: 'OPD',
            title: 'Learn by <span class="accent">being tested,</span> like a real ward round.',
            sub: 'In the OPD you see cases, not chapters. Your mistakes decide what comes next.',
            points: [
                ['fa-solid fa-route', 'Your path is yours alone', 'Two students who open the same chapter get different journeys through it.'],
                ['fa-solid fa-crosshairs', 'Tracking at concept level', 'Not "72% in Genetics" — which idea inside Genetics broke, and where.'],
                ['fa-solid fa-wand-magic-sparkles', 'AI that names the mistake', 'It explains the misconception, then re-tests the same idea from a new angle.'],
                ['fa-solid fa-chart-line', 'Analysis after every case', 'Concept by concept, question by question, with the time you spent on each.'],
            ],
        },

        // ── 4 · NEET Arena ───────────────────────────────────────
        {
            id: 'arena',
            art: 'onb-arena.png',
            icon: 'fa-solid fa-bolt',
            eyebrow: 'NEET Arena',
            title: 'Sit the real paper, <span class="accent">before the real day.</span>',
            sub: 'Full-length papers on a real OMR sheet, against a real clock.',
            points: [
                ['fa-solid fa-file-lines', 'Full NEET papers', 'The whole paper, the whole duration, the same OMR bubbles you will fill in the hall.'],
                ['fa-solid fa-magnifying-glass-chart', 'Results worth reading', 'Score ring, subject accuracy, per-question timing, and the traps you fell for.'],
                ['fa-solid fa-ranking-star', 'All India Rank', 'Where you stand against every NAADI student who sat the same paper.'],
                ['fa-solid fa-building-columns', 'College prediction', 'What your score would have opened, based on the paper you just sat.'],
            ],
        },

        // ── 5 · PYQ Vault ────────────────────────────────────────
        {
            id: 'pyq',
            art: 'onb-pyq.png',
            icon: 'fa-solid fa-vault',
            eyebrow: 'PYQ Vault',
            title: 'Build the <span class="accent">exact test</span> you need today.',
            sub: 'Every past-year question, sorted and cross-matched. You choose the shape of the paper.',
            points: [
                ['fa-solid fa-sliders', 'Any combination', 'Class × subject × chapter. One chapter or twelve — the test is assembled for you.'],
                ['fa-solid fa-shuffle', 'Cross-matched across years', 'The same concept, asked five different ways across five different papers.'],
                ['fa-solid fa-clipboard-check', 'Same engine, same analysis', 'A custom test is graded exactly like an Arena paper. Nothing is a lesser test.'],
            ],
        },

        // ── 6 · Library ──────────────────────────────────────────
        {
            id: 'library',
            art: 'onb-library.png',
            icon: 'fa-solid fa-book-open',
            eyebrow: 'Library',
            title: 'Your material and your notes, <span class="accent">in one place.</span>',
            sub: 'Everything you read and everything you wrote, together — because that is how you revise.',
            points: [
                ['fa-solid fa-highlighter', 'Highlight as you read', 'Mark what matters. It stays marked when you come back at 1 a.m. in March.'],
                ['fa-solid fa-pen-to-square', 'Notes you actually find again', 'Notebooks per subject, per chapter. Saved the moment you write them.'],
                ['fa-solid fa-download', 'Take it offline', 'Download study material and read it without a signal.'],
            ],
        },

        // ── 7 · Pedagogy ─────────────────────────────────────────
        {
            id: 'pedagogy',
            art: 'onb-pedagogy.png',
            icon: 'fa-solid fa-brain',
            eyebrow: 'Why this works',
            title: 'Built around <span class="accent">how memory actually behaves.</span>',
            sub: 'Rereading a chapter feels like studying. Retrieving it is studying. NAADI is built on the second one.',
            points: [
                ['fa-solid fa-rotate-right', 'Retrieve, then revise', 'Active recall and spaced revision are the two most-replicated findings in learning science.'],
                ['fa-solid fa-screwdriver-wrench', 'Correct the concept, not the chapter', 'A wrong answer points at one broken idea. You fix that idea, not the whole chapter.'],
                ['fa-solid fa-fingerprint', 'A path that adapts to you', 'The next question you see is chosen because of the last one you missed.'],
                ['fa-solid fa-arrow-trend-up', 'Progress that never falls', 'Progress to Doctor counts what you have completed. A bad day cannot take it away.'],
            ],
        },

        // ── 8 · Coverage (audited numbers only) ──────────────────
        {
            id: 'coverage',
            art: 'onb-outcome.png',
            icon: 'fa-solid fa-user-doctor',
            eyebrow: 'What we can prove',
            title: 'We check our content <span class="accent">against the real paper.</span>',
            sub: 'After every NEET, we take the paper apart question by question and ask one thing: was the answer already in NAADI?',
            custom: `
                <div class="onb-stat">
                    <div class="onb-stat-num">${COVERAGE_AUDIT.headline.value}</div>
                    <div class="onb-stat-label">${escapeHtml(COVERAGE_AUDIT.headline.label)}</div>
                    <div class="onb-stat-scope">${escapeHtml(COVERAGE_AUDIT.scope)}</div>
                </div>
                <ul class="onb-points">
                    <li class="onb-point">
                        <div class="onb-point-ico"><i class="fa-solid fa-arrow-trend-up"></i></div>
                        <div class="onb-point-txt"><strong>Progress to Doctor never goes down</strong>
                            It measures what you have completed, so effort only ever adds up.</div>
                    </li>
                </ul>
                <p class="onb-help">Coverage is what we can measure. Your rank is what you build with it.</p>`,
        },

        // ── 9 · Attribution ──────────────────────────────────────
        {
            id: 'source',
            eyebrow: 'One quick question',
            title: 'How did you <span class="accent">find us?</span>',
            sub: 'It helps us reach the students who are still searching.',
            custom: `
                <div class="onb-choices">
                    ${SOURCES.map(s => `
                        <button type="button" class="onb-choice${s.wide ? ' onb-choice-wide' : ''}"
                            data-src="${s.id}" onclick="onbPickSource('${s.id}')">
                            <span class="onb-choice-ico"><i class="${s.icon}"></i></span>
                            <span class="onb-choice-label">${escapeHtml(s.label)}</span>
                            <span class="onb-radio"></span>
                        </button>`).join('')}
                </div>
                <div class="form-group onb-other-wrap" id="onb-other-wrap" style="display:none;">
                    <label class="form-label" for="onb-other">Tell us where</label>
                    <div class="form-input-wrap">
                        <input type="text" class="form-input" id="onb-other" maxlength="80"
                            placeholder="A coaching centre, a magazine, a poster…"
                            style="padding-left:14px;" oninput="onbState.answers.onboarding_source_other=this.value">
                    </div>
                </div>`,
            cta: 'Next',
        },

        // ── 10 · Goals ───────────────────────────────────────────
        {
            id: 'goals',
            eyebrow: 'Your target',
            title: 'What are you <span class="accent">aiming at?</span>',
            sub: 'Leave any of this blank if you are not sure yet. You can set it later in your profile, and change it as often as you like.',
            custom: `
                <div class="onb-fields">
                    <div>
                        <label class="onb-field-label" for="onb-guardian-phone">Parent / Guardian mobile</label>
                        <div class="form-input-wrap">
                            <input type="tel" class="form-input" id="onb-guardian-phone" inputmode="tel"
                                maxlength="15" placeholder="10-digit mobile" style="padding-left:14px;"
                                oninput="onbState.answers.guardian_phone=this.value">
                        </div>
                        <p class="onb-help">So we can keep your parent in the loop on your progress.</p>
                    </div>
                    <div>
                        <label class="onb-field-label">NEET year</label>
                        <div class="onb-chips" id="onb-year-chips">
                            ${onbYearOptions().map(y => `
                                <button type="button" class="onb-chip" data-year="${y}"
                                    onclick="onbPickYear('${y}')">${y}</button>`).join('')}
                        </div>
                    </div>
                    <div>
                        <label class="onb-field-label" for="onb-score">Target score</label>
                        <div class="form-input-wrap">
                            <input type="number" class="form-input" id="onb-score" min="0" max="720"
                                inputmode="numeric" placeholder="out of 720" style="padding-left:14px;"
                                oninput="onbState.answers.neet_target_score=this.value">
                        </div>
                    </div>
                    <div>
                        <label class="onb-field-label" for="onb-college">Dream college</label>
                        <div class="form-input-wrap">
                            <input type="text" class="form-input" id="onb-college" maxlength="120"
                                placeholder="AIIMS Delhi, CMC Vellore, JIPMER…" style="padding-left:14px;"
                                oninput="onbState.answers.dream_college=this.value">
                        </div>
                        <p class="onb-help">Write it down. It is easier to walk towards a place with a name.</p>
                    </div>
                </div>`,
            cta: 'Next',
        },

        // ── 11 · Enter ───────────────────────────────────────────
        {
            id: 'enter',
            cta: onbState.replay ? 'Back to the app' : 'Enter NAADI',
            ctaIcon: 'fa-solid fa-stethoscope',
            html: `
                ${plateHtml(name, 'Intern · Day one')}
                <h1 class="onb-title">The ward is open, <span class="accent">Doctor.</span></h1>
                <p class="onb-sub">Nobody clears NEET in a day, and nobody clears it without starting one.
                    Open Concept Studio, finish one concept, and let the streak begin.</p>
                <p class="onb-help">Everything in this tour lives in the app. Your profile is behind the badge
                    in the top-right corner.</p>`,
        },
    ];
}

function plateHtml(name, role) {
    return `
        <div class="onb-plate">
            <div class="onb-plate-name">
                <span class="onb-plate-dr">Dr.</span>
                <span>${name}</span>
            </div>
            <div class="onb-plate-role">${escapeHtml(role)}</div>
            <div class="onb-plate-rule"></div>
        </div>`;
}

function onbYearOptions() {
    const y = new Date().getFullYear();
    return [y, y + 1, y + 2, y + 3];
}

// ════════════════════════════════════════════════════════════════
// RENDER
// ════════════════════════════════════════════════════════════════
function onbRender() {
    const slides = onbSlides();
    const stage = document.getElementById('onb-stage');
    const rail = document.getElementById('onb-rail');

    rail.innerHTML = slides.map(() => `<span class="onb-vert"></span>`).join('');
    rail.setAttribute('aria-valuemin', '1');
    rail.setAttribute('aria-valuemax', String(slides.length));

    // .onb-slide-inner is the block that gets vertically centred. The
    // slide itself stays a flex column so an over-tall slide (large OS
    // font scale) still scrolls from its true top rather than clipping.
    stage.innerHTML = slides.map((s, i) => `
        <section class="onb-slide" id="onb-slide-${i}" aria-hidden="${i === 0 ? 'false' : 'true'}"
                 role="group" aria-roledescription="slide" aria-label="${i + 1} of ${slides.length}">
            <div class="onb-slide-inner">
                ${s.art || s.icon ? artHtml(s) : ''}
                ${s.eyebrow ? `<div class="onb-eyebrow">${escapeHtml(s.eyebrow)}</div>` : ''}
                ${s.title ? `<h1 class="onb-title">${s.title}</h1>` : ''}
                ${s.sub ? `<p class="onb-sub">${escapeHtml(s.sub)}</p>` : ''}
                ${s.points ? `<ul class="onb-points">${s.points.map(pointHtml).join('')}</ul>` : ''}
                ${s.custom || ''}
                ${s.html || ''}
            </div>
        </section>`).join('');

    onbBindGestures(stage);
    onbGoTo(0, true);
}

function artHtml(s) {
    // The <img> hides itself if the artwork has not been added yet and
    // reveals the gradient tile behind it. No broken-image icon, ever.
    const fallback = `<div class="onb-art-fallback"><i class="${s.icon}"></i></div>`;
    if (!s.art) return `<div class="onb-art">${fallback}</div>`;
    return `
        <div class="onb-art">
            <img src="${ART_DIR}${s.art}" alt="" loading="lazy" draggable="false"
                 onload="this.parentNode.querySelector('.onb-art-fallback')?.remove()"
                 onerror="this.remove()">
            ${fallback}
        </div>`;
}

function pointHtml(p) {
    return `
        <li class="onb-point">
            <div class="onb-point-ico"><i class="${p[0]}"></i></div>
            <div class="onb-point-txt"><strong>${escapeHtml(p[1])}</strong>${escapeHtml(p[2])}</div>
        </li>`;
}

// ════════════════════════════════════════════════════════════════
// NAVIGATION
// ════════════════════════════════════════════════════════════════
function onbGoTo(next, silent) {
    const slides = onbSlides();
    const total = slides.length;
    next = Math.max(0, Math.min(total - 1, next));

    document.querySelectorAll('.onb-slide').forEach((el, i) => {
        // Park every inactive slide on the side it belongs to, so a slide
        // always leaves the way the student is travelling.
        el.style.setProperty('--onb-enter', i < next ? '-24px' : '24px');
        el.style.removeProperty('--onb-drag');
        el.classList.remove('dragging');
        el.classList.toggle('active', i === next);
        el.setAttribute('aria-hidden', i === next ? 'false' : 'true');
        if (i !== next) el.scrollTop = 0;
    });

    document.querySelectorAll('.onb-vert').forEach((v, i) => {
        v.classList.toggle('done', i < next);
        v.classList.toggle('here', i === next);
    });

    const rail = document.getElementById('onb-rail');
    if (rail) rail.setAttribute('aria-valuenow', String(next + 1));

    document.getElementById('onb-back').hidden = next === 0;
    document.getElementById('onb-skip').style.visibility = next === total - 1 ? 'hidden' : '';

    const s = slides[next];
    document.getElementById('onb-cta-label').textContent = s.cta || 'Next';
    document.getElementById('onb-cta-icon').className = s.ctaIcon || 'fa-solid fa-arrow-right';

    onbState.index = next;
    document.getElementById(`onb-slide-${next}`).scrollTop = 0;

    // Repaint the answers the student already gave, so going back and
    // forward never loses a selection.
    if (s.id === 'source') onbPaintSource();
    if (s.id === 'goals') onbPaintGoals();
}

function onbNext() {
    const total = onbSlides().length;
    if (onbState.index === total - 1) return onbFinish();
    onbGoTo(onbState.index + 1);
}

function onbBack() { onbGoTo(onbState.index - 1); }

function onbSkipAll() {
    // Jump to the last slide rather than leaving outright: the student
    // still gets the send-off, and Done still writes the flag.
    onbGoTo(onbSlides().length - 1);
}

// ════════════════════════════════════════════════════════════════
// GESTURES — swipe and keyboard
// ════════════════════════════════════════════════════════════════
function onbBindGestures(stage) {
    let startX = 0, startY = 0, startT = 0;
    let axis = null;            // null → undecided, 'x' → ours, 'y' → the browser's
    let active = null;
    let pointerId = null;

    const isTypingTarget = (el) => !!el?.closest?.('input, textarea, select, [contenteditable="true"]');

    stage.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (isTypingTarget(e.target)) return;
        if (onbState.saving) return;

        pointerId = e.pointerId;
        startX = e.clientX;
        startY = e.clientY;
        startT = performance.now();
        axis = null;
        active = document.getElementById(`onb-slide-${onbState.index}`);
    });

    stage.addEventListener('pointermove', (e) => {
        if (e.pointerId !== pointerId || !active) return;

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        if (axis === null) {
            if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
            axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
            if (axis === 'x') active.classList.add('dragging');
        }
        if (axis !== 'x') return;

        // Resistance at the two ends: the deck is finite, and it should
        // feel finite rather than silently refusing the gesture.
        const atStart = onbState.index === 0 && dx > 0;
        const atEnd = onbState.index === onbSlides().length - 1 && dx < 0;
        const shift = (atStart || atEnd) ? dx / 3.2 : dx;

        active.style.setProperty('--onb-drag', `${shift}px`);
    }, { passive: true });

    const release = (e) => {
        if (e.pointerId !== pointerId || !active) return;

        const slide = active;
        const dx = e.clientX - startX;
        const flick = Math.abs(dx) / Math.max(1, performance.now() - startT);

        pointerId = null;
        active = null;
        slide.classList.remove('dragging');
        slide.style.removeProperty('--onb-drag');

        if (axis !== 'x') return;
        if (Math.abs(dx) < SWIPE_DISTANCE && flick < SWIPE_VELOCITY) return;
        if (Math.abs(dx) < 14) return; // a flick still needs to be a movement

        if (dx < 0) {
            // Swiping left on the final slide is not a way to submit.
            if (onbState.index < onbSlides().length - 1) onbGoTo(onbState.index + 1);
        } else if (onbState.index > 0) {
            onbGoTo(onbState.index - 1);
        }
    };

    stage.addEventListener('pointerup', release);
    stage.addEventListener('pointercancel', release);
}

document.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, select')) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); onbNext(); }
    if (e.key === 'ArrowLeft' && onbState.index > 0) { e.preventDefault(); onbBack(); }
});

// ════════════════════════════════════════════════════════════════
// ANSWERS
// ════════════════════════════════════════════════════════════════
function onbPickSource(id) {
    onbState.answers.onboarding_source = id;
    if (id !== 'other') onbState.answers.onboarding_source_other = '';
    onbPaintSource();
    if (id === 'other') setTimeout(() => document.getElementById('onb-other')?.focus(), 120);
}

function onbPaintSource() {
    document.querySelectorAll('.onb-choice[data-src]').forEach(el => {
        const on = el.dataset.src === onbState.answers.onboarding_source;
        el.classList.toggle('selected', on);
        el.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const wrap = document.getElementById('onb-other-wrap');
    if (wrap) wrap.style.display = onbState.answers.onboarding_source === 'other' ? '' : 'none';
    const other = document.getElementById('onb-other');
    if (other) other.value = onbState.answers.onboarding_source_other || '';
}

function onbPickYear(y) {
    // Tapping the selected year again clears it — the field is optional
    // and there must be a way back to "not sure yet".
    onbState.answers.neet_target_year = (onbState.answers.neet_target_year === y) ? '' : y;
    onbPaintGoals();
}

function onbPaintGoals() {
    document.querySelectorAll('.onb-chip[data-year]').forEach(el => {
        const on = el.dataset.year === String(onbState.answers.neet_target_year);
        el.classList.toggle('selected', on);
        el.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const phone = document.getElementById('onb-guardian-phone');
    const score = document.getElementById('onb-score');
    const college = document.getElementById('onb-college');
    if (phone) phone.value = onbState.answers.guardian_phone || '';
    if (score) score.value = onbState.answers.neet_target_score || '';
    if (college) college.value = onbState.answers.dream_college || '';
}

// ════════════════════════════════════════════════════════════════
// FINISH
// ════════════════════════════════════════════════════════════════
async function onbFinish() {
    if (onbState.replay) { window.location.href = 'app.html'; return; }
    if (onbState.saving) return;

    onbState.saving = true;
    const cta = document.getElementById('onb-cta');
    cta.disabled = true;
    document.getElementById('onb-cta-label').textContent = 'Opening the ward…';

    const a = onbState.answers;
    const payload = { onboarding_completed: true };
    if (a.onboarding_source) payload.onboarding_source = a.onboarding_source;
    if (a.onboarding_source === 'other' && a.onboarding_source_other.trim()) {
        payload.onboarding_source_other = a.onboarding_source_other.trim();
    }
    if (a.neet_target_year) payload.neet_target_year = Number(a.neet_target_year);
    if (a.neet_target_score !== '' && !isNaN(Number(a.neet_target_score))) {
        payload.neet_target_score = Number(a.neet_target_score);
    }
    if (a.dream_college.trim()) payload.dream_college = a.dream_college.trim();
    // Guardian phone moved here from signup, where it was a required field on
    // an already-long form. Optional now, like everything else on this slide,
    // and editable later in Profile. Only sent when it looks like a real number.
    {
        const digits = (a.guardian_phone || '').replace(/\D/g, '');
        if (digits.length >= 10 && digits.length <= 15) payload.guardian_phone = a.guardian_phone.trim();
    }

    try {
        await apiCall('/api/user/account/save', 'POST', payload);
    } catch (e) {
        // Never trap a new student behind a failed write. The flag below
        // is local; the server flag is retried the next time they open
        // Profile and save anything.
        console.warn('Onboarding save failed:', e);
    }

    onbMarkSeenLocally();
    window.location.href = 'app.html';
}

function onbMarkSeenLocally() {
    try {
        const uid = auth.currentUser?.uid;
        if (uid) localStorage.setItem('naadi_onb_' + uid, '1');
    } catch (e) { /* private mode — the server flag still holds */ }
}

// ════════════════════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════════════════════
auth.onAuthStateChanged(async (user) => {
    if (!user) { window.location.href = 'login.html'; return; }

    currentUser = user;
    idToken = await user.getIdToken();

    // displayName is set by signup.html before the redirect, so this is
    // almost always a hit. The API call is the fallback for a student
    // who somehow lands here without one.
    let name = user.displayName;
    if (!name) {
        try {
            const acct = await apiCall('/api/user/account');
            name = acct.name;
        } catch (e) { /* fall through to the default */ }
    }
    onbState.name = (name || 'Doctor').trim().split(/\s+/)[0];

    onbRender();
});

// Hardware back button (Android / Capacitor) walks the deck, not the
// browser history.
window.addEventListener('popstate', () => {
    if (onbState.index > 0) { history.pushState(null, ''); onbBack(); }
});
history.pushState(null, '');