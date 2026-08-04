/* ════════════════════════════════════════════════════════════════
   NAADI AI — PARENT LEARNING  (parent-learning.js)
   ─────────────────────────────────────────────────────────────────
   Loads AFTER portal.js and takes over the Learning tab only.
   Deleting this file restores the old tab exactly.

   WHAT THIS TAB IS FOR

   Home is time-bound and carries judgement: this week, the last four
   weeks, what needs you. This tab is syllabus-bound and neutral:
   where are they in the course, chapter by chapter, what is left.

       Home     "is this going all right?"
       Learning "has she done Genetics?"

   Nothing on Home answers the second, and it is the most common
   thing a parent wants to look up.

   The old version could not answer it either: its chapter list only
   showed chapters ALREADY OPENED, so the one thing a syllabus view
   exists for — what has not been done — was the one thing missing.
   Four of its other five blocks repeated Home in a worse form.

   ─────────────────────────────────────────────────────────────────
   THE MAP CARRIES NO NUMBERS

   Every chapter is a tile, coloured by state. Numbers live in the
   detail panel, which opens on tap. That is what lets the map stay
   dense enough to scan eighty-three chapters and still find the one
   you came for.

   ─────────────────────────────────────────────────────────────────
   LAYOUT

   One render path. The detail panel is ONE component: a docked
   right-hand column above 1024px, a bottom sheet below it. Same
   markup, different CSS — there is no second panel to drift.
   ════════════════════════════════════════════════════════════════ */

const PAL = {
    data: null,
    chapter: null,     // the open chapter detail, or null
    loadingCid: null,  // guards against a slow first tap painting over a fast second
    open: {},          // info panel id -> bool
    filter: { subject: 'all', group: null },
};

const palPct = v => (v == null || isNaN(v)) ? '—' : `${Math.round(v)}%`;

function palN(n, one, many) {
    n = Number(n) || 0;
    return `${n} ${n === 1 ? one : (many || one + 's')}`;
}

function palSubjClass(s) {
    const k = String(s || '').toLowerCase();
    if (k.startsWith('bio')) return 'bio';
    if (k.startsWith('phy')) return 'phy';
    if (k.startsWith('chem')) return 'chem';
    return 'other';
}

/* ── the (i) affordance, same contract as the Home tab ──────────── */

function palInfoBtn(id) {
    return `<button class="pal-i" aria-label="What does this mean?"
      aria-expanded="${PAL.open[id] ? 'true' : 'false'}"
      onclick="palToggleInfo('${id}')"><i class="fa-solid fa-info"></i></button>`;
}

function palInfoPanel(id, text) {
    if (!text) return '';
    return `<div class="pal-info ${PAL.open[id] ? '' : 'hidden'}" id="linfo-${id}">
      <div class="pal-info-h">What this means</div>
      <p>${esc(text)}</p>
    </div>`;
}

function palToggleInfo(id) {
    PAL.open[id] = !PAL.open[id];
    const p = document.getElementById(`linfo-${id}`);
    if (p) p.classList.toggle('hidden', !PAL.open[id]);
    document.querySelectorAll(`.pal-i[onclick*="'${id}'"]`)
        .forEach(b => b.setAttribute('aria-expanded', PAL.open[id] ? 'true' : 'false'));
}

function palHead(id, title, sub, info) {
    return `
    <div class="pal-sec-head">
      <div class="pal-sec-t">
        <div class="pt-sec-title">${esc(title)}</div>
        ${sub ? `<div class="pt-sec-sub">${esc(sub)}</div>` : ''}
      </div>
      ${palInfoBtn(id)}
    </div>
    ${palInfoPanel(id, info)}`;
}


/* ════════════════════════════════════════════════════════════════
   ENTRY
   ════════════════════════════════════════════════════════════════ */

async function renderParentLearningV2() {
    const body = $('pt-learning-body');
    const c = activeChild();
    if (!c) return;

    if (c.consent_revoked) {
        body.innerHTML = emptyState('fa-lock', 'Access turned off',
            `${(c.name || '').split(' ')[0]} has turned off parent access.`);
        return;
    }

    body.classList.add('pal-root');

    const key = `${c.uid}:learning2`;
    if (!PT.cache[key]) {
        body.innerHTML = skeleton(3);
        try {
            PT.cache[key] = await apiCall(`/api/parent/v2/child/${c.uid}/learning`);
        } catch (e) {
            body.innerHTML = emptyState('fa-triangle-exclamation', "Couldn't load this",
                e.message || 'Please try again in a moment.');
            return;
        }
    }

    PAL.data = PT.cache[key];
    palPaint();
}

/* LAYOUT

   Mobile is unchanged: everything stacks, and the detail panel is a
   bottom sheet.

   Desktop was wrong in two ways and both are fixed here.

   The map was a 7fr column beside a 5fr docked panel. With eighty-three
   chapters that meant scrolling the whole page to the top to read the
   panel and back down to pick the next chapter. The map now takes the
   full width and the full height of the viewport with its own internal
   scroll, and the detail is a MODAL over it — so picking a chapter never
   moves the map.

   "Open right now" and "Time inside tests" were stranded in a half-width
   column with dead space beside them. They now sit side by side in a
   full-width row under the map.

   The detail panel is still ONE component. Bottom sheet on a phone,
   centred modal on a laptop — same markup, different CSS. */
function palPaint() {
    const d = PAL.data;
    if (!d) return;
    $('pt-learning-body').innerHTML = `
    <div class="pal-grid">
      <div class="pal-band">
        ${palMap(d.map || {})}
      </div>
      <div class="pal-row">
        ${palOpenNow(d.open_now || {}, d.child || {})}
        ${palTime(d.time || {}, d.cards || {})}
      </div>
      ${palDetail()}
    </div>`;
}


/* ════════════════════════════════════════════════════════════════
   1 · THE SYLLABUS MAP

   The spine of the tab, and the reason it exists. Every chapter in
   the Concept Studio syllabus, in syllabus order, coloured by
   state. A parent scans, finds Genetics, sees it is grey.

   Untouched chapters are deliberately visible. Showing only what
   has been started is what made the old tab unable to answer "what
   is left" — the question a syllabus view is for.
   ════════════════════════════════════════════════════════════════ */

function palMap(m) {
    const groups = m.groups || [];
    if (!groups.length) {
        return `
      <div class="pt-sec pal-sec">
        ${palHead('map', 'The syllabus', '', m.info)}
        ${emptyState('fa-book', 'No syllabus uploaded yet',
            'Chapters appear here once Concept Studio content is added.')}
      </div>`;
    }

    const subjects = [...new Set(groups.map(g => g.subject))];
    const shown = PAL.filter.subject === 'all'
        ? groups : groups.filter(g => g.subject === PAL.filter.subject);

    return `
    <div class="pt-sec pal-sec pal-map">
      ${palHead('map', 'The syllabus',
        'Every chapter, and where they have got to. Tap one for detail.', m.info)}

      <div class="pal-filters" role="tablist">
        <button class="pal-pill ${PAL.filter.subject === 'all' ? 'on' : ''}"
          onclick="palFilter('all')">All subjects</button>
        ${subjects.map(s => `
          <button class="pal-pill ${palSubjClass(s)} ${PAL.filter.subject === s ? 'on' : ''}"
            onclick="palFilter('${esc(s)}')">${esc(s)}</button>`).join('')}
      </div>

      <!-- The scroll region. On desktop the card is the height of the
           viewport and THIS scrolls, so the filters and the legend stay
           put while eighty-three chapters move past them. On a phone it
           has no height limit and the page scrolls as before. -->
      <div class="pal-map-scroll">
        ${shown.map(g => palGroup(g)).join('')}
      </div>

      <div class="pal-legend">
        <span><i class="pal-key finished"></i>finished</span>
        <span><i class="pal-key testing"></i>testing</span>
        <span><i class="pal-key read_only"></i>read, not tested</span>
        <span><i class="pal-key reading"></i>reading</span>
        <span><i class="pal-key not_started"></i>not started</span>
      </div>
    </div>`;
}

function palGroup(g) {
    const c = g.counts || {};
    const done = (c.finished || 0) + (c.testing || 0)
        + (c.read_only || 0) + (c.reading || 0);
    return `
    <div class="pal-group">
      <div class="pal-group-h">
        <div>
          <span class="pal-tag ${palSubjClass(g.subject)}">${esc(g.subject)}</span>
          <b>${esc(g.label)}</b>
          ${g.is_own_year ? '<em>this year</em>' : ''}
        </div>
        <span class="pal-group-n">${done} of ${g.total} opened</span>
      </div>
      <div class="pal-tiles">
        ${(g.chapters || []).map(ch => `
          <button class="pal-tile ${esc(ch.state)}
              ${PAL.chapter && PAL.chapter.id === ch.id ? 'on' : ''}"
            title="${esc(ch.name)} — ${esc(ch.state_label)}"
            onclick="palOpenChapter('${esc(ch.id)}')">
            <span class="pal-tile-n">${ch.number || ''}</span>
            <span class="pal-tile-t">${esc(ch.name)}</span>
          </button>`).join('')}
      </div>
    </div>`;
}

function palFilter(s) {
    PAL.filter.subject = s;
    palPaint();
}


/* ════════════════════════════════════════════════════════════════
   2 · THE CHAPTER DETAIL PANEL

   One component. Docked as a right-hand column on a laptop, a
   bottom sheet on a phone — same markup, different CSS, so there is
   no second panel to fall out of sync.

   The race guard matters: a parent taps two chapters quickly, the
   first request returns second, and without loadingCid the panel
   would settle on the chapter they did NOT ask for. That exact bug
   cost a day on the teacher student sheet.
   ════════════════════════════════════════════════════════════════ */

async function palOpenChapter(cid) {
    const c = activeChild();
    if (!c) return;

    PAL.loadingCid = cid;
    PAL.chapter = { id: cid, loading: true };
    palPaint();

    let detail = null;
    try {
        detail = await apiCall(
            `/api/parent/v2/child/${c.uid}/chapter/${encodeURIComponent(cid)}`);
    } catch (e) {
        detail = { id: cid, error: e.message || 'Could not load this chapter.' };
    }

    if (PAL.loadingCid !== cid) return;   // a later tap won
    PAL.chapter = detail;
    palPaint();
}

function palCloseChapter() {
    PAL.chapter = null;
    PAL.loadingCid = null;
    palPaint();
}

function palDetail() {
    const ch = PAL.chapter;

    // Nothing selected means nothing rendered. The old inline "Tap any
    // chapter" prompt made sense when the panel was a permanently docked
    // column; as a modal it would be an empty box sitting in the layout,
    // and the map's own subtitle already says "Tap one for detail".
    if (!ch) return '';

    const inner = ch.loading ? skeleton(2)
        : ch.error ? `${palDetailHead(ch)}
        ${emptyState('fa-triangle-exclamation', "Couldn't load this chapter",
            ch.error)}`
            : palDetailBody(ch);

    return `
    <div class="pal-backdrop" onclick="palCloseChapter()"></div>
    <div class="pt-sec pal-sec pal-detail" id="pal-detail"
         role="dialog" aria-modal="true" aria-label="Chapter detail">
      ${inner}
    </div>`;
}

function palDetailBody(ch) {
    const r = ch.reading || {}, t = ch.testing || {}, cards = ch.cards || {};
    const hist = ch.history || [];

    return `
      ${palDetailHead(ch)}

      <div class="pal-d-state ${esc(ch.state || '')}">
        <i class="pal-key ${esc(ch.state || '')}"></i>${esc(ch.state_label || '')}
      </div>

      <div class="pal-d-block">
        <div class="pal-d-k">Reading</div>
        ${r.started ? `
          <div class="pal-d-bar">
            <i class="read" style="width:${Math.min(100, r.pct || 0).toFixed(1)}%"></i>
          </div>
          <div class="pal-d-line">
            <b>${palPct(r.pct)}</b> of the notes marked done
          </div>
          ${r.blocks_total ? `
            <div class="pal-d-line quiet">
              ${r.blocks_done} of ${r.blocks_total} sections finished${r.blocks_touched > r.blocks_done
                    ? `, ${r.blocks_touched} opened` : ''}
            </div>` : ''}
          ${r.blocks_touched > r.blocks_done ? `
            <div class="pal-d-note">
              ${r.blocks_touched - r.blocks_done} section${r.blocks_touched - r.blocks_done === 1 ? ' was' : 's were'} opened but
              not marked done. That can mean reading without stopping to
              take it in — or simply forgetting to tap.
            </div>` : ''}
        ` : `<div class="pal-d-line quiet">Not opened yet.</div>`}
      </div>

      <div class="pal-d-block">
        <div class="pal-d-k">Recall cards ${palInfoBtn('cards')}</div>
        ${cards.seen ? `
          <div class="pal-d-line">
            ${cards.ready
                ? `<b>${cards.right} of ${palN(cards.seen, 'card')}</b> answered right`
                : `<b>${palN(cards.seen, 'card')}</b> seen so far — too few to
                 put a figure on yet`}
          </div>` : `<div class="pal-d-line quiet">No cards seen yet.</div>`}
        ${palInfoPanel('cards', cards.info)}
      </div>

      <div class="pal-d-block">
        <div class="pal-d-k">Tests</div>
        ${!t.has_bank ? `
          <div class="pal-d-line quiet">
            Chapter tests for this one aren't ready yet. That's about our
            content, not about ${esc((PAL.data?.child?.first_name) || 'them')}.
          </div>`
            : t.tests ? `
          <div class="pal-d-bar">
            <i class="test" style="width:${t.total_tests
                    ? Math.min(100, (t.tests / t.total_tests) * 100).toFixed(1) : 0}%"></i>
          </div>
          <div class="pal-d-line">
            <b>${t.tests}${t.total_tests ? ` of ${t.total_tests}` : ''}</b>
            tests taken
          </div>
          ${t.ready ? `<div class="pal-d-line quiet">
            ${palPct(t.accuracy)} of questions right, across
            ${palN(t.asked, 'question')}</div>`
                    : `<div class="pal-d-line quiet">
            ${palN(t.asked, 'question')} answered — too few to say how it's
            going</div>`}
          ${t.stage ? `<div class="pal-d-stage">
            <i class="fa-solid fa-signal"></i>${esc(t.stage)}</div>` : ''}
        ` : `<div class="pal-d-line quiet">No tests taken yet.</div>`}
      </div>

      ${hist.length ? `
        <div class="pal-d-block">
          <div class="pal-d-k">How the tests went</div>
          <div class="pal-hist">
            ${hist.map(h => `
              <div class="pal-hrow">
                <span class="pal-hday">${esc(h.day || '')}</span>
                <span class="pal-hmain">${h.right} of ${h.asked} right</span>
                <span class="pal-hpct ${h.pct != null && h.pct < 40 ? 'low' : ''}">
                  ${palPct(h.pct)}</span>
              </div>`).join('')}
          </div>
        </div>` : ''}`;
}

function palDetailHead(ch) {
    return `
    <div class="pal-d-head">
      <div class="pal-d-title">
        ${ch.subject ? `<span class="pal-tag ${palSubjClass(ch.subject)}">${esc(ch.subject)}</span>` : ''}
        <h3>${esc(ch.name || 'Chapter')}</h3>
        ${ch.class_level ? `<span class="pal-d-yr">Class ${esc(ch.class_level)}</span>` : ''}
      </div>
      <button class="pal-close" onclick="palCloseChapter()"
        aria-label="Close chapter detail"><i class="fa-solid fa-xmark"></i></button>
    </div>`;
}


/* ════════════════════════════════════════════════════════════════
   3 · OPEN RIGHT NOW

   Home's day-by-day list says what HAPPENED. This says what is
   LEFT. Different questions, so not a duplicate — and this is the
   one that tells a parent where an unfinished chapter stands.
   ════════════════════════════════════════════════════════════════ */

function palOpenNow(o, child) {
    const rows = o.items || [];
    const who = child.first_name || 'They';

    if (!rows.length) {
        return `
      <div class="pt-sec pal-sec">
        ${palHead('open', 'Open right now', '', o.info)}
        ${emptyState('fa-folder-open', 'Nothing open',
            `${who} hasn't worked on a chapter in the last three weeks.`)}
      </div>`;
    }

    return `
    <div class="pt-sec pal-sec">
      ${palHead('open', 'Open right now', 'And what is still unfinished.', o.info)}
      ${rows.map(c => {
        const blocksLeft = Math.max(0, (c.blocks_total || 0) - (c.blocks_done || 0));
        const testsLeft = Math.max(0, (c.total_tests || 0) - (c.tests || 0));
        const bits = [];
        if (c.blocks_total) {
            bits.push(blocksLeft
                ? `${blocksLeft} of ${c.blocks_total} sections left to read`
                : `all ${c.blocks_total} sections done`);
        }
        if (!c.has_bank) bits.push('no chapter tests yet');
        else if (c.total_tests) {
            bits.push(testsLeft
                ? `${testsLeft} of ${c.total_tests} tests still to take`
                : `all ${c.total_tests} tests done`);
        }
        return `
        <button class="pal-open-row" onclick="palOpenChapter('${esc(c.id)}')">
          <div class="pal-open-main">
            <div class="pal-open-t">
              ${c.subject ? `<span class="pal-tag ${palSubjClass(c.subject)}">${esc(c.subject)}</span>` : ''}
              ${esc(c.name)}
            </div>
            <div class="pal-open-s">${esc(bits.join(' · ') || 'just started')}</div>
          </div>
          <div class="pal-open-r">
            <span class="pal-key ${esc(c.state)}"></span>
            <i class="fa-solid fa-chevron-right"></i>
          </div>
        </button>`;
    }).join('')}
    </div>`;
}


/* ════════════════════════════════════════════════════════════════
   4 · TIME SPENT

   Home gives this week's minutes. This gives the shape over three
   months. A number and a trend are not the same thing, so this is
   not a duplicate — but the caveat is, and it is kept verbatim
   because it was the most honest line on the old tab.
   ════════════════════════════════════════════════════════════════ */

function palTime(t, cards) {
    const weeks = t.weeks || [];
    const max = Math.max(1, ...weeks.map(w => w.minutes || 0));

    return `
    <div class="pt-sec pal-sec">
      ${palHead('time', 'Time inside tests',
        'Not total study time — we do not track time spent reading.', t.info)}
      ${weeks.length ? `
        <div class="pal-bars">
          ${weeks.map(w => `
            <div class="pal-barcol" title="${esc(w.label)} · ${w.minutes} min">
              <div class="pal-bar-track">
                <i style="height:${Math.max(2, (w.minutes / max) * 100).toFixed(1)}%"></i>
              </div>
              <span>${esc(w.label)}</span>
            </div>`).join('')}
        </div>
        <div class="pal-bars-k">Minutes per week · last ${weeks.length} weeks</div>
      ` : emptyState('fa-clock', 'No tests taken yet', '')}

      ${cards.seen ? `
        <div class="pal-cards-line">
          ${cards.ready
                ? `<b>${cards.right} of ${palN(cards.seen, 'recall card')}</b> answered right across all chapters.`
                : `<b>${palN(cards.seen, 'recall card')}</b> seen so far — too few to put a figure on.`}
        </div>` : ''}
    </div>`;
}


/* ════════════════════════════════════════════════════════════════
   TAKEOVER

   portal.js owns renderParentTab. We wrap it: 'learning' comes
   here, everything else falls through untouched. If parent-home.js
   already wrapped it, this wraps that — both tabs are handled and
   neither knows about the other.
   ════════════════════════════════════════════════════════════════ */

document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && PAL.chapter) palCloseChapter();
});


(function () {
    const orig = window.renderParentTab;
    if (typeof orig === 'function') {
        window.renderParentTab = async function (tab) {
            if (tab === 'learning') return renderParentLearningV2();
            return orig(tab);
        };
    }
})();