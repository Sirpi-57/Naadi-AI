/* ════════════════════════════════════════════════════════════════
   NAADI AI — HOME (home.js)  ·  v2
   The Home tab. Nothing here is a navigation shortcut — every element
   is live data that deep-links into the exact place the student left
   off.

   Sections (top → bottom):
     1. HERO BAND  — greeting · streak pulse · exam countdown ·
                     Progress to Doctor. ONE dark surface, fused to the
                     navy top bar, using login.html's exact hero grammar
                     (ink #0B1220, 28px drift grid, ECG trace, scrim,
                     masked doctor photo). Home's front door.
     2. Continue   — Concept Studio · OPD · NEET Arena resume cards.
                     Directly under the fold: it is the reason the app
                     was opened.
     3. Focus areas— weakest concepts, deep-linked
     4. Stats strip— streak · accuracy · tests · questions
     5. Quote      — a sign-off, not an interruption between the two
                     highest-intent modules

   DESIGN RULE (deliberate): nothing on Home can go DOWN.
     • Arena resume card shows coverage ("3 of 12 papers"), never a score.
     • Doctor scale components are all completion-based, never accuracy.
     • The rank badge uses a server-side high-water mark, so a student is
       never demoted when new syllabus content grows the denominator.
   A number that drops on a bad day is the number that closes the app.

   ACCESSIBILITY: every tappable is a real <button>, so it is keyboard
   reachable and gets a focus ring. No role="button" divs.

   BACKEND: untouched. Same single GET /api/home, same payload shape,
   same navigate() targets, same phOpenSheet().

   Requires: shared.js (apiCall, ndToast, escapeHtml, pingStreak,
   NEET_EXAM_DATE), quotes.js (nextQuote), practice-hub.js (phOpenSheet).
   ════════════════════════════════════════════════════════════════ */

const homeState = {
    data: null,          // last /api/home payload
    quoteTimer: null,    // 30s rotation interval
    stampTimer: null,    // 60s "updated Nm ago" tick
    fetchedAt: null,     // Date.now() of the last good /api/home
    loading: false,
};

const QUOTE_ROTATE_MS = 30000;

// One place to ask "should this animate?" — the media query is honoured
// by the CSS, but the JS count-up has to check for itself.
function hmStill() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

// ════════════════════════════════════════════════════════════════
// ENTRY — called by navigate('dashboard')
// ════════════════════════════════════════════════════════════════
async function loadHome() {
    const container = document.getElementById('home-content');
    if (!container) return;

    // Paint the shell + skeletons immediately. The quote needs no
    // network, so the student always sees something human on frame one.
    if (!container.dataset.painted) {
        container.innerHTML = homeShellHtml();
        container.dataset.painted = '1';
        paintQuote(false);
    }
    startQuoteRotation();
    startStampTicker();

    if (homeState.loading) return;
    homeState.loading = true;
    setRefreshing(true);
    try {
        const data = await apiCall('/api/home');
        homeState.data = data;
        homeState.fetchedAt = Date.now();
        paintHome(data);
    } catch (e) {
        // The error takes the hero's scale slot, not the body: it's the
        // network that failed, and that slot is where the student was
        // already looking.
        const slot = document.getElementById('hm-scale-slot');
        if (slot) {
            slot.innerHTML = `<div class="hm-scale hm-scale-error">
                <i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i>
                <div class="hm-scale-error-title">Couldn't load your progress</div>
                <div class="hm-scale-error-sub">${escapeHtml(e.message || 'Network error')}</div>
                <button type="button" class="hm-scale-retry" onclick="loadHome()">
                    <i class="fa-solid fa-rotate-right"></i> Retry</button>
            </div>`;
        }
        // Never leave skeletons shimmering forever against a failed call.
        if (!homeState.data) {
            const nameEl = document.getElementById('hm-name');
            if (nameEl) nameEl.textContent = 'Doctor';
            const chips = document.getElementById('hm-chips');
            if (chips) chips.innerHTML = '';
            const body = document.getElementById('hm-body');
            if (body) body.innerHTML = '';
        }
    } finally {
        homeState.loading = false;
        setRefreshing(false);
        paintStamp();
    }
}

// Called from navigate() when leaving Home — stop the timers so they
// don't tick against a hidden view.
function stopHomeTimers() {
    if (homeState.quoteTimer) {
        clearInterval(homeState.quoteTimer);
        homeState.quoteTimer = null;
    }
    if (homeState.stampTimer) {
        clearInterval(homeState.stampTimer);
        homeState.stampTimer = null;
    }
}

// ════════════════════════════════════════════════════════════════
// SHELL — hero band + skeletons
// ════════════════════════════════════════════════════════════════
function homeShellHtml() {
    return `
    <div class="hm-wrap">

        <!-- ── 1. HERO BAND ─────────────────────────────────────── -->
        <div class="hm-hero">
            <div class="hm-hero-grid" aria-hidden="true"></div>
            <svg class="hm-hero-pulse" viewBox="0 0 400 60" preserveAspectRatio="none" aria-hidden="true">
                <path d="M0 30H120L128 30L134 42L144 8L154 52L162 30H180H260C268 30 268 16 278 16
                         C288 16 288 30 296 30H400"/>
            </svg>
            <img class="hm-hero-img" src="assets/doctor-hero.png" alt=""
                 onerror="this.style.display='none'">
            <div class="hm-hero-scrim" aria-hidden="true"></div>

            <div class="hm-hero-inner">
                <div class="hm-greet">
                    <div class="hm-greet-text">
                        <div class="kicker" id="hm-kicker">${greetKicker()}</div>
                        <h2 id="hm-name"><span class="hm-sk on-dark"
                            style="display:inline-block;width:9.5rem;height:1.1rem;border-radius:6px;
                                   vertical-align:middle;"></span></h2>
                    </div>
                    <div class="hm-chips" id="hm-chips">
                        <span class="hm-sk on-dark"
                            style="width:56px;height:32px;border-radius:999px;"></span>
                    </div>
                </div>

                <div id="hm-scale-slot">${scaleSkeletonHtml()}</div>
            </div>
        </div>

        <!-- ── 2-5. BODY ────────────────────────────────────────── -->
        <div class="hm-body">
            <div id="hm-body">${bodySkeletonHtml()}</div>

            <button type="button" class="hm-btn hm-press hm-quote" id="hm-quote"
                    onclick="paintQuote(true)" aria-label="Show another quote">
                <i class="fa-solid fa-quote-left hm-quote-mark" aria-hidden="true"></i>
                <span class="hm-quote-text" id="hm-quote-text"></span>
                <span class="hm-quote-author" id="hm-quote-author"></span>
                <span class="hm-quote-next" aria-hidden="true">Tap for another</span>
            </button>
        </div>
    </div>`;
}

// Skeletons mirror the real geometry, so the arrival of data never jumps
// the page. This replaces the old centred spinner.
function scaleSkeletonHtml() {
    return `
    <div class="hm-scale" aria-hidden="true">
        <div class="hm-scale-head">
            <div class="hm-sk on-dark" style="width:44px;height:44px;border-radius:12px;flex-shrink:0;"></div>
            <div style="flex:1;">
                <div class="hm-sk on-dark" style="width:78px;height:9px;"></div>
                <div class="hm-sk on-dark" style="width:116px;height:13px;margin-top:8px;"></div>
            </div>
            <div class="hm-sk on-dark" style="width:52px;height:22px;"></div>
        </div>
        <div class="hm-sk on-dark" style="height:10px;border-radius:999px;margin:0 9px 16px;"></div>
        <div class="hm-sk on-dark" style="width:64%;height:10px;"></div>
    </div>`;
}

function bodySkeletonHtml() {
    const card = () => `
        <div class="hm-card" style="display:flex;align-items:center;gap:14px;padding:14px;">
            <div class="hm-sk" style="width:46px;height:46px;border-radius:50%;flex-shrink:0;"></div>
            <div style="flex:1;">
                <div class="hm-sk" style="width:64px;height:8px;"></div>
                <div class="hm-sk" style="width:72%;height:13px;margin-top:9px;"></div>
                <div class="hm-sk" style="width:44%;height:9px;margin-top:8px;"></div>
            </div>
        </div>`;
    return `
    <div class="hm-section-label" aria-hidden="true">Continue where you left off</div>
    <div class="hm-resume" aria-hidden="true">${card()}${card()}${card()}</div>`;
}

function paintHome(d) {
    // Greeting
    const nameEl = document.getElementById('hm-name');
    if (nameEl) nameEl.textContent = 'Dr. ' + (d.user?.name || 'Student');
    const kickEl = document.getElementById('hm-kicker');
    if (kickEl) kickEl.textContent = greetKicker();
    paintChips(d);

    document.getElementById('hm-scale-slot').innerHTML = doctorScaleHtml(d.doctor_scale);

    // --i drives the 55ms entry stagger declared in CSS.
    document.getElementById('hm-body').innerHTML = `
        <div class="hm-in" style="--i:0">${resumeSectionHtml(d.resume)}</div>
        <div class="hm-in" style="--i:1">${focusSectionHtml(d.focus)}</div>
        <div class="hm-in" style="--i:2">${statsStripHtml(d.stats)}</div>
        <div class="hm-in" style="--i:3">${stampHtml()}</div>
    `;
    paintStamp();

    // Animate the scale in on the next frame (0 → target).
    requestAnimationFrame(() => {
        const fill = document.getElementById('hm-scale-fill');
        const marker = document.getElementById('hm-scale-marker');
        const pct = Math.max(0, Math.min(100, d.doctor_scale?.overall || 0));
        if (fill) fill.style.width = pct + '%';
        // Inset by the marker's own radius so it can't clip at 0% or 100%.
        if (marker) marker.style.left = `calc(9px + (100% - 18px) * ${pct} / 100)`;
        countUp('hm-scale-pct-num', Math.round(pct));
    });
}

// Time-aware, IST-anchored. "On Duty" was equally true at 3am and 3pm,
// which is another way of saying it said nothing.
function greetKicker() {
    let h;
    try {
        h = Number(new Intl.DateTimeFormat('en-GB', {
            hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata'
        }).format(new Date()));
    } catch (e) {
        h = new Date().getHours();
    }
    if (h < 5) return 'Burning the midnight oil';
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    if (h < 21) return 'Good evening';
    return 'Late shift';
}

// The headline number earns a count-up. Everything else just appears.
function countUp(id, target) {
    const el = document.getElementById(id);
    if (!el) return;
    if (hmStill() || target <= 0) { el.textContent = target; return; }
    const dur = 900, t0 = performance.now();
    const step = (now) => {
        const p = Math.min(1, (now - t0) / dur);
        // easeOutQuint — matches the bar's cubic-bezier(.22,1,.36,1) feel
        el.textContent = Math.round(target * (1 - Math.pow(1 - p, 5)));
        if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

// ── Streak pulse + exam countdown ───────────────────────────────
function paintChips(d) {
    const holder = document.getElementById('hm-chips');
    if (!holder) return;

    const streak = d.streak?.current || 0;
    const chips = [];

    chips.push(`<div class="hm-chip streak ${streak > 0 ? 'live' : ''}" id="hm-streak-chip"
            aria-label="${streak} day study streak">
            <i class="fa-solid fa-heart-pulse" aria-hidden="true"></i>
            <b id="hm-streak-count">${streak}</b>
        </div>`);

    const days = daysToExam();
    if (days !== null && days >= 0) {
        chips.push(`<div class="hm-chip exam" aria-label="${days} days to NEET">
            <i class="fa-solid fa-calendar-day" aria-hidden="true"></i><b>${days}</b><span>days</span>
        </div>`);
    }
    holder.innerHTML = chips.join('');
}

function daysToExam() {
    if (!window.NEET_EXAM_DATE) return null;   // date not announced → chip hidden
    const exam = new Date(NEET_EXAM_DATE + 'T00:00:00+05:30');
    if (isNaN(exam.getTime())) return null;
    const ms = exam.getTime() - Date.now();
    return Math.ceil(ms / 86400000);
}

// ════════════════════════════════════════════════════════════════
// FRESHNESS STAMP — the data is live, so say when it was fetched.
// ════════════════════════════════════════════════════════════════
function stampHtml() {
    return `<button type="button" class="hm-btn hm-press hm-updated" id="hm-updated"
                onclick="loadHome()" aria-label="Refresh your dashboard">
            <i class="fa-solid fa-rotate-right" aria-hidden="true"></i>
            <span id="hm-updated-text">Updated just now</span> · <b>Refresh</b>
        </button>`;
}

function paintStamp() {
    const el = document.getElementById('hm-updated-text');
    if (!el || !homeState.fetchedAt) return;
    const mins = Math.floor((Date.now() - homeState.fetchedAt) / 60000);
    el.textContent = mins < 1 ? 'Updated just now'
        : mins === 1 ? 'Updated 1 min ago'
            : mins < 60 ? `Updated ${mins} mins ago`
                : `Updated ${Math.floor(mins / 60)}h ago`;
}

function setRefreshing(on) {
    document.getElementById('hm-updated')?.classList.toggle('spinning', !!on);
}

function startStampTicker() {
    if (homeState.stampTimer) clearInterval(homeState.stampTimer);
    homeState.stampTimer = setInterval(() => {
        const view = document.getElementById('view-dashboard');
        if (!view || !view.classList.contains('active')) return;
        paintStamp();
    }, 60000);
}

// ════════════════════════════════════════════════════════════════
// QUOTE ROTATOR
// ════════════════════════════════════════════════════════════════
function paintQuote(animate) {
    const card = document.getElementById('hm-quote');
    const textEl = document.getElementById('hm-quote-text');
    const authEl = document.getElementById('hm-quote-author');
    if (!card || !textEl || !authEl) return;

    const q = nextQuote();
    const write = () => {
        textEl.textContent = q.text;
        authEl.textContent = '— ' + q.author;
        card.classList.remove('fading');
    };
    if (animate && !hmStill()) {
        card.classList.add('fading');
        setTimeout(write, 220);           // matches .hm-quote.fading transition
    } else {
        write();
    }
    // Manual tap resets the 30s clock — otherwise it can flip 1s later.
    startQuoteRotation();
}

function startQuoteRotation() {
    if (homeState.quoteTimer) clearInterval(homeState.quoteTimer);
    homeState.quoteTimer = setInterval(() => {
        // Guard: only rotate while Home is the visible view.
        const view = document.getElementById('view-dashboard');
        if (!view || !view.classList.contains('active')) return;
        paintQuoteSilently();
    }, QUOTE_ROTATE_MS);
}

// Rotate without resetting the interval (paintQuote() would recurse).
function paintQuoteSilently() {
    const card = document.getElementById('hm-quote');
    const textEl = document.getElementById('hm-quote-text');
    const authEl = document.getElementById('hm-quote-author');
    if (!card || !textEl || !authEl) return;
    const q = nextQuote();
    if (hmStill()) {
        textEl.textContent = q.text;
        authEl.textContent = '— ' + q.author;
        return;
    }
    card.classList.add('fading');
    setTimeout(() => {
        textEl.textContent = q.text;
        authEl.textContent = '— ' + q.author;
        card.classList.remove('fading');
    }, 220);
}

// ════════════════════════════════════════════════════════════════
// PROGRESS TO DOCTOR (lives inside the hero band)
// ════════════════════════════════════════════════════════════════
const RANK_ICONS = {
    intern: 'fa-user',
    junior_resident: 'fa-user-nurse',
    senior_resident: 'fa-stethoscope',
    registrar: 'fa-notes-medical',
    consultant: 'fa-user-doctor',
    doctor: 'fa-award',
};

function doctorScaleHtml(scale) {
    if (!scale) return '';
    const pct = Math.max(0, Math.min(100, scale.overall || 0));
    const rank = scale.rank || {};
    const next = scale.next_rank;

    // Ticks are inset by the marker's radius so they line up with it.
    // No title= — a hover tooltip is invisible on a phone; the ladder is
    // spelled out in the breakdown sheet instead.
    const ticks = (scale.ladder || []).map(r => `
        <span class="hm-scale-tick ${pct >= r.at ? 'reached' : ''}"
            style="left:calc(9px + (100% - 18px) * ${r.at} / 100)" aria-hidden="true"></span>`).join('');

    const nextLine = next
        ? `${next.at - Math.floor(pct)}% more to <b>${escapeHtml(next.title)}</b>`
        : `Top rank reached — keep it up, doctor.`;

    return `
    <button type="button" class="hm-btn hm-press on-dark hm-scale" onclick="openScaleSheet()"
            aria-label="Progress to Doctor, ${Math.round(pct)} percent — open breakdown">
        <span class="hm-scale-head">
            <span class="hm-scale-badge" aria-hidden="true">
                <i class="fa-solid ${RANK_ICONS[rank.key] || 'fa-user-doctor'}"></i>
            </span>
            <span class="hm-scale-head-info">
                <span class="hm-scale-label">Progress to Doctor</span>
                <span class="hm-scale-rank">${escapeHtml(rank.title || 'Intern')}</span>
            </span>
            <span class="hm-scale-pct"><em id="hm-scale-pct-num">0</em><span>%</span></span>
        </span>

        <span class="hm-scale-track">
            <span class="hm-scale-fill" id="hm-scale-fill" style="width:0%"></span>
            ${ticks}
            <span class="hm-scale-marker" id="hm-scale-marker" style="left:9px"></span>
        </span>

        <span class="hm-scale-foot">
            <span class="hm-scale-next">${nextLine}</span>
            <span class="hm-scale-more">Breakdown <i class="fa-solid fa-chevron-right"></i></span>
        </span>
    </button>`;
}

// Bottom sheet: the rank ladder + the three component bars — so the
// headline number is never an unexplained black box.
function openScaleSheet() {
    const scale = homeState.data?.doctor_scale;
    if (!scale || typeof phOpenSheet !== 'function') return;
    const c = scale.components || {};
    const pct = Math.max(0, Math.min(100, scale.overall || 0));

    // The labels the track's ticks used to hide inside a title=.
    const ladder = (scale.ladder || []).map(r => `
        <span class="hm-ladder-item ${pct >= r.at ? 'reached' : ''}">
            <i class="fa-solid ${pct >= r.at ? 'fa-circle-check' : 'fa-circle'}" aria-hidden="true"></i>
            ${escapeHtml(r.title)} · ${r.at}%
        </span>`).join('');

    const bar = (key, label, icon) => {
        const comp = c[key];
        if (!comp) return '';
        if (!comp.available) {
            return `<div class="hm-comp muted">
                <div class="hm-comp-top"><span><i class="fa-solid ${icon}"></i>${label}</span>
                    <b>Not counted</b></div>
                <p class="hm-comp-note">No content uploaded yet — its weight is shared
                   across the other sections.</p>
            </div>`;
        }
        return `<div class="hm-comp">
            <div class="hm-comp-top">
                <span><i class="fa-solid ${icon}"></i>${label}</span>
                <b>${Math.round(comp.pct)}%</b>
            </div>
            <div class="hm-comp-track"><i style="width:${Math.max(0, Math.min(100, comp.pct))}%"></i></div>
            <p class="hm-comp-note">${comp.done} of ${comp.total} ${escapeHtml(comp.label || '')}
               · weight ${comp.effective_weight}%</p>
        </div>`;
    };

    phOpenSheet(`
        <div class="ph-sheet-handle"></div>
        <div class="hm-sheet">
            <h3>How your scale is built</h3>
            <p class="hm-sheet-sub">Every component counts <b>work done</b>, never your score.
               Retakes and bad days can't pull this bar backwards.</p>
            ${ladder ? `<div class="hm-ladder">${ladder}</div>` : ''}
            ${bar('studio', 'Concept Studio', 'fa-graduation-cap')}
            ${bar('opd', 'OPD', 'fa-notes-medical')}
            ${bar('arena', 'NEET Arena', 'fa-bolt')}
            <button class="btn btn-outline" style="width:100%;min-height:46px;margin-top:6px;"
                onclick="phCloseSheet()">Got it</button>
        </div>`);
}

// ════════════════════════════════════════════════════════════════
// CONTINUE — resume cards
// ════════════════════════════════════════════════════════════════
function resumeSectionHtml(r) {
    r = r || {};
    return `
    <div class="hm-section-label">Continue where you left off</div>
    <div class="hm-resume">
        ${studioResumeHtml(r.studio)}
        ${opdResumeHtml(r.opd)}
        ${arenaResumeHtml(r.arena)}
    </div>`;
}

function emptyResumeHtml(icon, title, copy, cta, onclick, tint) {
    return `<button type="button" class="hm-btn hm-press hm-card hm-resume-card empty" onclick="${onclick}">
        <span class="hm-rc-icon ${tint || ''}" aria-hidden="true"><i class="fa-solid ${icon}"></i></span>
        <span class="hm-rc-body">
            <span class="hm-rc-title">${escapeHtml(title)}</span>
            <span class="hm-rc-sub">${escapeHtml(copy)}</span>
        </span>
        <span class="hm-rc-cta">${escapeHtml(cta)} <i class="fa-solid fa-arrow-right"></i></span>
    </button>`;
}

function studioResumeHtml(s) {
    if (!s || !s.chapter_id) {
        return emptyResumeHtml('fa-graduation-cap', 'Concept Studio',
            'Start your first chapter — block by block.', 'Start',
            `navigate('quick-revise')`);
    }
    const pct = Math.round(s.completion_percentage || 0);
    const cid = String(s.chapter_id).replace(/'/g, "\\'");
    const cname = String(s.chapter_name || 'Chapter').replace(/'/g, "\\'");
    const blk = (s.current_block_index || 0) + 1;
    const tot = s.total_blocks || 0;
    return `
    <button type="button" class="hm-btn hm-press hm-card hm-resume-card"
         onclick="navigate('revise-journey', {chapter_id:'${cid}', chapter_name:'${escapeHtml(cname)}'})">
        <span class="hm-rc-ring" style="--p:${pct}" aria-hidden="true">
            <span>${pct}<i>%</i></span>
        </span>
        <span class="hm-rc-body">
            <span class="hm-rc-kicker">Concept Studio</span>
            <span class="hm-rc-title">${escapeHtml(s.chapter_name || 'Chapter')}</span>
            <span class="hm-rc-sub">${tot ? `Block ${Math.min(blk, tot)} of ${tot}` : 'In progress'}</span>
        </span>
        <span class="hm-rc-go" aria-hidden="true"><i class="fa-solid fa-chevron-right"></i></span>
    </button>`;
}

function opdResumeHtml(o) {
    if (!o || !o.chapter_id) {
        return emptyResumeHtml('fa-notes-medical', 'OPD',
            'Take your first case test.', 'Open OPD', `navigate('opd')`, 'opd');
    }
    const cid = String(o.chapter_id).replace(/'/g, "\\'");
    const cname = String(o.chapter_name || 'Case File').replace(/'/g, "\\'");
    const last = o.last_test;
    const next = o.next_test || {};

    const lastLine = last
        ? `Last: Test ${last.num} · ${Math.round(last.percentage || 0)}%`
        : 'No tests yet';

    const nextChip = next.locked
        ? `<span class="hm-rc-chip locked"><i class="fa-solid fa-lock"></i> Test ${next.num} locked</span>`
        : `<span class="hm-rc-chip open"><i class="fa-solid fa-play"></i> Next: Test ${next.num}</span>`;

    return `
    <button type="button" class="hm-btn hm-press hm-card hm-resume-card"
         onclick="navigate('opd-chapter', {chapter_id:'${cid}', chapter_title:'${escapeHtml(cname)}'})">
        <span class="hm-rc-icon opd" aria-hidden="true"><i class="fa-solid fa-notes-medical"></i></span>
        <span class="hm-rc-body">
            <span class="hm-rc-kicker">OPD</span>
            <span class="hm-rc-title">${escapeHtml(o.chapter_name || 'Case File')}</span>
            <span class="hm-rc-sub">${escapeHtml(lastLine)}</span>
            <span class="hm-rc-chips">${nextChip}</span>
        </span>
        <span class="hm-rc-go" aria-hidden="true"><i class="fa-solid fa-chevron-right"></i></span>
    </button>`;
}

// NOTE: deliberately NO score and NO AIR here. Coverage only —
// "3 of 12 papers attempted". The score lives inside Arena, where the
// student went looking for it.
function arenaResumeHtml(a) {
    if (!a || !a.papers_available) {
        return emptyResumeHtml('fa-bolt', 'NEET Arena',
            'Full papers arrive soon.', 'Open Arena', `navigate('arena')`, 'arena');
    }
    const done = a.papers_attempted || 0;
    const total = a.papers_available;
    const nextLabel = a.next_paper
        ? `Next: NEET ${a.next_paper.year} · Paper ${a.next_paper.paper_code}`
        : 'Every paper attempted — retake any for a better score.';

    return `
    <button type="button" class="hm-btn hm-press hm-card hm-resume-card" onclick="navigate('arena')">
        <span class="hm-rc-icon arena" aria-hidden="true"><i class="fa-solid fa-bolt"></i></span>
        <span class="hm-rc-body">
            <span class="hm-rc-kicker">NEET Arena</span>
            <span class="hm-rc-title">${done} of ${total} paper${total !== 1 ? 's' : ''} attempted</span>
            <span class="hm-rc-sub">${escapeHtml(nextLabel)}</span>
            <span class="hm-rc-chips">
                <span class="hm-rc-chip open"><i class="fa-solid fa-play"></i>
                    ${done ? 'Try the next paper' : 'Try your first paper'}</span>
            </span>
        </span>
        <span class="hm-rc-go" aria-hidden="true"><i class="fa-solid fa-chevron-right"></i></span>
    </button>`;
}

// ════════════════════════════════════════════════════════════════
// FOCUS AREAS (weakest concepts — framed as focus, not failure)
// ════════════════════════════════════════════════════════════════
function focusSectionHtml(focus) {
    if (!focus || !focus.length) {
        return `<div class="hm-section-label">Focus areas</div>
        <div class="hm-card hm-focus-empty">
            <i class="fa-solid fa-circle-check" aria-hidden="true"></i>
            <div>
                <b>Nothing flagged yet.</b>
                <p>Take an OPD test and NAADI will point you at the concepts worth a second look.</p>
            </div>
        </div>`;
    }

    const rows = focus.slice(0, 5).map((f, i) => {
        const cid = String(f.chapter_id || '').replace(/'/g, "\\'");
        const cname = String(f.chapter_name || '').replace(/'/g, "\\'");
        const m = Math.round(f.mastery || 0);
        const meta = [f.class_level ? `Class ${f.class_level}` : '', f.subject, f.chapter_name]
            .filter(Boolean).join(' · ');
        // --m is READ by the CSS: the dot and the % ramp red → amber →
        // green with mastery, so severity is visible before the number
        // is read. It used to be set and never used.
        return `
        <button type="button" class="hm-btn hm-press hm-focus-row ${i > 2 ? 'extra hidden' : ''}"
             style="--m:${m}"
             onclick="navigate('opd-chapter', {chapter_id:'${cid}', chapter_title:'${escapeHtml(cname)}'})">
            <span class="hm-focus-dot" aria-hidden="true"></span>
            <span class="hm-focus-info">
                <span class="hm-focus-name">${escapeHtml(f.concept_name || 'Concept')}</span>
                <span class="hm-focus-meta">${escapeHtml(meta)}</span>
            </span>
            <span class="hm-focus-pct">${m}%</span>
            <i class="fa-solid fa-chevron-right hm-focus-go" aria-hidden="true"></i>
        </button>`;
    }).join('');

    const hasExtra = focus.length > 3;
    return `
    <div class="hm-section-label">Focus areas</div>
    <div class="hm-card hm-focus">
        ${rows}
        ${hasExtra ? `<button type="button" class="hm-btn hm-press hm-focus-toggle" id="hm-focus-toggle"
            onclick="toggleFocusExtra(event)" aria-expanded="false">
            Show ${Math.min(focus.length, 5) - 3} more <i class="fa-solid fa-chevron-down"></i></button>` : ''}
    </div>`;
}

function toggleFocusExtra(ev) {
    ev.stopPropagation();
    const rows = document.querySelectorAll('.hm-focus-row.extra');
    const btn = document.getElementById('hm-focus-toggle');
    const nowHidden = rows.length && rows[0].classList.contains('hidden');
    rows.forEach(r => r.classList.toggle('hidden', !nowHidden));
    if (btn) {
        btn.setAttribute('aria-expanded', String(!!nowHidden));
        btn.innerHTML = nowHidden
            ? `Show less <i class="fa-solid fa-chevron-up"></i>`
            : `Show ${rows.length} more <i class="fa-solid fa-chevron-down"></i>`;
    }
}

// ════════════════════════════════════════════════════════════════
// STATS STRIP
// ════════════════════════════════════════════════════════════════
function statsStripHtml(s) {
    s = s || {};
    const cell = (val, label, icon) => `
        <div class="hm-stat">
            <i class="fa-solid ${icon}" aria-hidden="true"></i>
            <b>${val}</b><span>${label}</span>
        </div>`;
    return `
    <div class="hm-stats">
        ${cell(s.study_streak ?? 0, 'Streak', 'fa-heart-pulse')}
        ${cell((s.accuracy ?? 0) + '%', 'Accuracy', 'fa-bullseye')}
        ${cell(s.total_tests ?? 0, 'Tests', 'fa-file-circle-check')}
        ${cell(s.total_questions ?? 0, 'Questions', 'fa-list-check')}
    </div>`;
}