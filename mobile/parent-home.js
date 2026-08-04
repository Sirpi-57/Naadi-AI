/* ════════════════════════════════════════════════════════════════
   NAADI AI — PARENT HOME  (parent-home.js)
   ─────────────────────────────────────────────────────────────────
   Loads AFTER portal.js and takes over the Home tab only. Every
   other parent tab still renders from portal.js untouched, and
   deleting this file restores the old home page exactly.

   WHAT THIS PAGE IS FOR

   A parent has ninety seconds and one question: is this going all
   right, and is there anything I should say tonight. Not: what is
   my child's composite index.

   So the old hero — one ring blending reading progress, test
   progress and mock ability into "Progress to Doctor 47%", on a
   rank ladder that appears nowhere in the student app — is gone.
   In its place, things that are separately true:

       THE PAPER MARK    out of 720. The one number every NEET
                         parent already understands.
       SHOWING UP        days, streak, minutes
       GOING IN          recent accuracy with a trend, and how
                         much survives a reworded question
       READING vs TESTS  two tracks per subject, never merged

   ─────────────────────────────────────────────────────────────────
   THE (i) BUTTON

   Every block carries one. A parent cannot act on a number whose
   definition they were taught at an induction they may have missed,
   or joined after. The copy comes from the server, next to the
   arithmetic it describes, so the two cannot drift apart.

   ─────────────────────────────────────────────────────────────────
   PRONOUNS

   None. We do not collect the child's pronouns yet, and guessing
   from a name is worse than not trying. Copy uses the first name.

   ─────────────────────────────────────────────────────────────────
   LAYOUT

   One render path. On a phone the wrappers are display:contents and
   the blocks flow in source order, which is priority order. At
   >=1024px the same markup becomes a band grid. There is no second
   markup tree to drift.
   ════════════════════════════════════════════════════════════════ */

const PAH = {
  data: null,
  deck: null,      // v2 deck payload, multi-child only
  open: {},        // info panel id -> bool
};

const pahPct = v => (v == null || isNaN(v)) ? '—' : `${Math.round(v)}%`;

function pahN(n, one, many) {
  n = Number(n) || 0;
  return `${n} ${n === 1 ? one : (many || one + 's')}`;
}

function pahSubjClass(s) {
  const k = String(s || '').toLowerCase();
  if (k.startsWith('bio')) return 'bio';
  if (k.startsWith('phy')) return 'phy';
  if (k.startsWith('chem')) return 'chem';
  return 'other';
}

function pahQuiet(days) {
  if (days == null) return 'not yet';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/* ── the (i) affordance ────────────────────────────────────────────
   A button and a panel, not a tooltip: a tooltip is unreachable on a
   phone and unreadable at this length. State lives in PAH.open so a
   panel the parent opened survives a re-render. */

function pahInfoBtn(id) {
  return `<button class="pah-i" aria-label="What does this mean?"
      aria-expanded="${PAH.open[id] ? 'true' : 'false'}"
      onclick="pahToggleInfo('${id}')"><i class="fa-solid fa-info"></i></button>`;
}

function pahInfoPanel(id, text) {
  if (!text) return '';
  return `<div class="pah-info ${PAH.open[id] ? '' : 'hidden'}" id="info-${id}">
      <div class="pah-info-h">What this means</div>
      <p>${esc(text)}</p>
    </div>`;
}

function pahToggleInfo(id) {
  PAH.open[id] = !PAH.open[id];
  const panel = document.getElementById(`info-${id}`);
  if (panel) panel.classList.toggle('hidden', !PAH.open[id]);
  document.querySelectorAll(`.pah-i[onclick*="'${id}'"]`)
    .forEach(b => b.setAttribute('aria-expanded', PAH.open[id] ? 'true' : 'false'));
}

// title + (i) + optional subtitle, in one place so every block's head
// is built identically.
function pahHead(id, title, sub, info) {
  return `
    <div class="pah-sec-head">
      <div class="pah-sec-t">
        <div class="pt-sec-title">${esc(title)}</div>
        ${sub ? `<div class="pt-sec-sub">${esc(sub)}</div>` : ''}
      </div>
      ${pahInfoBtn(id)}
    </div>
    ${pahInfoPanel(id, info)}`;
}


/* ════════════════════════════════════════════════════════════════
   ENTRY
   ════════════════════════════════════════════════════════════════ */

async function renderParentHomeV2() {
  const body = $('pt-home-body');
  const c = activeChild();
  if (!c) return;

  if (c.consent_revoked) {
    body.innerHTML = emptyState('fa-lock', 'Access turned off',
      `${(c.name || '').split(' ')[0]} has turned off parent access.`);
    return;
  }

  body.classList.add('pah-root');

  const key = `${c.uid}:home2`;
  if (!PT.cache[key]) {
    body.innerHTML = skeleton(3);
    try {
      PT.cache[key] = await apiCall(`/api/parent/v2/child/${c.uid}/home`);
    } catch (e) {
      body.innerHTML = emptyState('fa-triangle-exclamation', "Couldn't load this",
        e.message || 'Please try again in a moment.');
      return;
    }
  }

  const d = PT.cache[key];
  PAH.data = d;

  /* ORDER
     Source order IS the mobile order, with one deliberate exception:
     "Worth knowing this week" sits last here (and last on desktop,
     full width), but CSS lifts it to just under the header on a phone.
     Left in source order it would be four screens down — and it is the
     only block that ever asks a parent to do anything. One `order`
     rule, one markup tree, no second render path. */
  body.innerHTML = `
    ${pahHeader(d)}
    <div class="pah-grid">
      <div class="pah-col-main">
        ${pahEffortAndUnderstanding(d)}
        ${pahWeek(d.week || {}, d.child || {})}
      </div>
      <div class="pah-col-side">
        ${pahSubjects(d.subjects || {})}
      </div>
      <div class="pah-band pair">
        ${pahPaper(d.papers || {}, d.child || {})}
        ${pahTalkAbout(d.talk_about || {})}
      </div>
      <div class="pah-band wide">
        ${pahNeedsYou(d.needs_you || {})}
      </div>
    </div>`;
}


/* ════════════════════════════════════════════════════════════════
   HEADER

   Replaces the deck for a single-child parent, which is most of
   them. The old page showed last-active / streak / accuracy on the
   card and then again in two sections below it: the same three
   facts, three times, on one screen.

   School NAME, not school code. "NAADI-CHN-014" meant nothing to
   the person reading it.
   ════════════════════════════════════════════════════════════════ */

function pahHeader(d) {
  const c = d.child || {};
  const h = d.headline || {};
  const meta = [c.school_name, c.class_id && `Class ${c.class_id}`]
    .filter(Boolean).join(' · ');

  return `
    <div class="pah-head tone-${esc(h.tone || 'steady')}">
      <div class="pah-head-id">
        ${c.photo_url
      ? `<img class="pah-av" src="${esc(c.photo_url)}" alt="">`
      : `<div class="pah-av pah-av-i">${esc(c.initials || '?')}</div>`}
        <div class="pah-head-t">
          <h2>${esc(c.name || 'Your child')}</h2>
          <p>${esc(meta || 'No class assigned')} ·
             last studied ${esc(pahQuiet(d.last_seen && d.last_seen.days))}</p>
        </div>
      </div>
      <p class="pah-headline">${esc(h.sentence || '')}</p>
    </div>`;
}


/* ════════════════════════════════════════════════════════════════
   1 · THE FULL PAPER

   180 questions, three subjects, out of 720. The one number on this
   whole page a NEET parent already understands without being taught
   anything — and it was not on the page at all.

   Best AND most recent, because they answer different questions:
   what they can do on a good day, and where they are right now.
   ════════════════════════════════════════════════════════════════ */

function pahPaper(p, child) {
  const who = child.first_name || 'They';
  const last = p.last, best = p.best;
  const customs = p.customs || {};

  if (!last) {
    return `
      <div class="pt-sec pah-sec pah-paper-empty">
        ${pahHead('paper', 'Full NEET paper', '', p.info)}
        <div class="pah-none">
          <i class="fa-solid fa-file-lines"></i>
          <div>
            <b>No full paper yet</b>
            <span>${esc(who)} hasn't sat a complete 720-mark paper. These
              matter most closer to the exam — chapter tests come first.</span>
          </div>
        </div>
        ${customs.count ? `<div class="pah-custom-line">
          ${pahN(customs.count, 'custom test')} taken as well.</div>` : ''}
      </div>`;
  }

  const sameAsBest = best && best.at === last.at;

  return `
    <div class="pt-sec pah-sec pah-paper">
      ${pahHead('paper', 'Full NEET paper', '', p.info)}
      <div class="pah-paper-row">
        <div class="pah-paper-main">
          <div class="pah-paper-k">Most recent · ${esc(last.label || 'Paper')}</div>
          <div class="pah-paper-v">${last.marks == null ? '—' : last.marks}
            <span>of ${last.max || 720}</span></div>
          ${!sameAsBest && best && best.marks != null ? `
            <div class="pah-paper-best">
              Best so far ${best.marks} of ${best.max || 720}
              ${best.label ? `· ${esc(best.label)}` : ''}</div>`
      : `<div class="pah-paper-best">This is their best so far.</div>`}
        </div>
        ${(last.subjects || []).length ? `
          <div class="pah-paper-subs">
            ${last.subjects.map(s => `
              <div class="pah-psub">
                <span class="pah-tag ${pahSubjClass(s.subject)}">${esc(s.subject)}</span>
                <div class="pah-psub-bar">
                  <i style="width:${Math.max(0, Math.min(100,
        ((s.marks || 0) / (s.max || 180)) * 100)).toFixed(1)}%"></i>
                </div>
                <span class="pah-psub-v">${s.marks == null ? '—' : s.marks}<em>/${s.max || 180}</em></span>
              </div>`).join('')}
          </div>` : ''}
      </div>
      <div class="pah-paper-foot">
        ${pahN(p.count, 'full paper')} taken${customs.count
      ? ` · ${pahN(customs.count, 'custom test')}` : ''}
      </div>
    </div>`;
}


/* ════════════════════════════════════════════════════════════════
   2 · WHAT NEEDS YOU

   Same flag engine as the teacher's, so nobody is described two
   different ways on two screens.

   Two shown, the rest collapsed. Only the first carries a
   suggestion — five imperatives handed to a parent become five
   pressures handed to the child, which is the opposite of the
   point.
   ════════════════════════════════════════════════════════════════ */

function pahNeedsYou(n) {
  const list = n.visible || [];
  const hidden = n.hidden || [];

  if (!list.length) {
    return `
      <div class="pt-sec pah-sec pah-calm">
        ${pahHead('alerts', 'Nothing needs you this week', '', n.info)}
        <div class="pt-sec-sub" style="margin:0">
          Nothing has reached a level worth raising. This updates as
          they test.
        </div>
      </div>`;
  }

  return `
    <div class="pt-sec pah-sec pah-needs">
      ${pahHead('alerts', 'Worth knowing this week',
    list.length === 1 ? 'One thing, and it is not an alarm.'
      : 'A couple of things, and they are not alarms.', n.info)}
      ${list.map(a => `
        <div class="pah-alert">
          <div class="pah-alert-t">${esc(a.title)}</div>
          <div class="pah-alert-b">${esc(a.body)}</div>
          ${a.do ? `<div class="pah-alert-do">
            <i class="fa-solid fa-lightbulb"></i>
            <span>${esc(a.do)}</span></div>` : ''}
        </div>`).join('')}
      ${hidden.length ? `
        <button class="pah-more" onclick="pahToggleMore()">
          <span id="pah-more-label">${hidden.length} more</span>
          <i class="fa-solid fa-chevron-down"></i></button>
        <div class="pah-hidden hidden" id="pah-hidden">
          ${hidden.map(a => `
            <div class="pah-alert">
              <div class="pah-alert-t">${esc(a.title)}</div>
              <div class="pah-alert-b">${esc(a.body)}</div>
            </div>`).join('')}
        </div>` : ''}
    </div>`;
}

function pahToggleMore() {
  const box = document.getElementById('pah-hidden');
  const lbl = document.getElementById('pah-more-label');
  if (!box) return;
  const nowHidden = box.classList.toggle('hidden');
  if (lbl) lbl.textContent = nowHidden
    ? `${box.children.length} more` : 'Show fewer';
}


/* ════════════════════════════════════════════════════════════════
   3 · SHOWING UP, AND WHETHER IT'S GOING IN

   Two honest reads side by side instead of one blended one. Kept on
   the same row deliberately: a parent has to be able to see the
   difference between "working hard, not getting it" and "getting
   it, not working" in one glance. Those are opposite problems
   needing opposite responses, and the old page could not tell them
   apart.
   ════════════════════════════════════════════════════════════════ */

function pahEffortAndUnderstanding(d) {
  const e = d.effort || {};
  const u = d.understanding || {};
  const acc = u.accuracy || {};
  const hold = u.holding || {};
  const who = (d.child && d.child.first_name) || 'They';

  const dayDelta = () => {
    const a = e.days_this_week || 0, b = e.days_last_week || 0;
    if (!b) return '';
    if (a === b) return `<span class="pah-delta flat">same as the week before</span>`;
    const up = a > b;
    return `<span class="pah-delta ${up ? 'up' : 'down'}">
        ${up ? '▲' : '▼'} ${Math.abs(a - b)} vs the week before</span>`;
  };

  const mins = e.minutes_vague
    ? '<b>A few minutes</b><span>inside tests</span>'
    : `<b>${pahN(e.minutes_this_week, 'minute')}</b><span>inside tests</span>`;

  const accDelta = () => {
    if (acc.delta == null || Math.abs(acc.delta) < 1) return '';
    const up = acc.delta > 0;
    return `<span class="pah-delta ${up ? 'up' : 'down'}">
        ${up ? '▲' : '▼'} ${Math.abs(Math.round(acc.delta))} points vs
        the 4 weeks before</span>`;
  };

  return `
    <div class="pt-sec pah-sec">
      ${pahHead('effort', "Showing up, and whether it's going in",
    'Two different questions, kept apart on purpose.', e.info)}

      <div class="pah-two">
        <div class="pah-half">
          <div class="pah-half-k">Showing up</div>
          <div class="pah-big">${pahN(e.days_this_week, 'day')}
            <span>of the last ${e.window_days || 7}</span></div>
          ${dayDelta()}
          <div class="pah-mini-rows">
            <div><b>${pahN(e.streak_current, 'day')}</b>
              <span>in a row right now${e.streak_longest
      ? ` · best ${e.streak_longest}` : ''}</span></div>
            <div>${mins}<span>this week</span></div>
            <div><b>${pahN(e.tests_this_week, 'test')}</b>
              <span>taken this week</span></div>
          </div>
        </div>

        <div class="pah-half">
          <div class="pah-half-k">Whether it's going in
            ${pahInfoBtn('acc')}</div>
          ${acc.ready ? `
            <div class="pah-big">${pahPct(acc.value)}
              <span>right, last 4 weeks</span></div>
            ${accDelta()}
            <div class="pah-note">
              ${acc.right} of ${pahN(acc.asked, 'question')} in the window.
              ${acc.lifetime != null
        ? `Over all time, ${pahPct(acc.lifetime)}.` : ''}
            </div>
          ` : `
            <div class="pah-big muted">—<span>not enough asked yet</span></div>
            <div class="pah-note">${pahN(acc.asked, 'question')} answered in
              the last 4 weeks. We'd rather say nothing than guess from that.
            </div>
          `}
          ${pahInfoPanel('acc', acc.info)}
        </div>
      </div>

      <div class="pah-hold-wrap">
        <div class="pah-hold-head">
          <b>Does it stay learned?</b>
          ${pahInfoBtn('hold')}
        </div>
        <p class="pah-hold-how">
          When a question is answered wrongly, the app brings the same idea
          back later, worded differently, to see whether it really stuck.
        </p>
        ${hold.ready ? `
          <div class="pah-hold">
            <div class="pah-hold-b">
              Of ${pahN(hold.checked, 'idea')} asked again this way,
              <b>${hold.kept} came back right</b>.
            </div>
            <div class="pah-hold-v">${pahPct(hold.value)}</div>
          </div>
          <div class="pah-note">It's normal for this to be low early on,
            and it usually rises as chapters get revisited.</div>
        ` : `
          <div class="pah-hold quiet">
            <div class="pah-hold-b">
              Nothing has been re-checked enough times yet. Once a few
              chapters have been revisited, this will tell you how much is
              really sticking.
            </div>
          </div>`}
        ${pahInfoPanel('hold', hold.info)}
      </div>

      ${pahHeat(e.grid || [], e.heat_weeks)}
    </div>`;
}

// Pad the front so column one is a Monday. Without this the week rows
// lie about which day of the week each square is.
function pahHeat(days, weeks) {
  if (!days.length) return '';
  const first = new Date(days[0].date + 'T00:00:00');
  if (isNaN(first)) return '';
  const pad = (first.getDay() + 6) % 7;
  const cells = Array(pad).fill('<i class="pad"></i>')
    .concat(days.map(d =>
      `<i class="${d.active ? 'on' : ''}" title="${esc(d.date)}"></i>`));
  return `<div class="pah-heat-wrap">
      <div class="pah-heat">${cells.join('')}</div>
      <div class="pah-heat-k">Last ${weeks || 8} weeks · each square is a day</div>
    </div>`;
}


/* ════════════════════════════════════════════════════════════════
   4 · THE LAST 7 DAYS

   The old feed said "Test 3 · Practice". A parent cannot open a
   conversation from that, and opening a conversation is the job.
   Now carries full papers and custom tests too, so it is the whole
   week rather than the chapter-test slice of it.
   ════════════════════════════════════════════════════════════════ */

function pahWeek(w, child) {
  const rows = w.items || [];
  const who = child.first_name || 'They';

  if (!rows.length) {
    return `
      <div class="pt-sec pah-sec">
        ${pahHead('week', 'The last 7 days', '', w.info)}
        ${emptyState('fa-hourglass-start', 'Nothing this week',
      `${who} hasn't studied in the last seven days.`)}
      </div>`;
  }

  const icon = k => k === 'reading' ? 'fa-book-open'
    : k === 'paper' ? 'fa-file-lines'
      : k === 'custom' ? 'fa-sliders' : 'fa-list-check';

  const label = k => k === 'reading' ? 'Reading'
    : k === 'paper' ? 'Full paper'
      : k === 'custom' ? 'Custom test' : 'Chapter test';

  return `
    <div class="pt-sec pah-sec">
      ${pahHead('week', 'The last 7 days',
    'What was actually opened, and how it went.', w.info)}
      <div class="pah-week">
        ${rows.map(r => `
          <div class="pah-wrow">
            <div class="pah-wday">${esc(r.day || '')}</div>
            <div class="pah-wmain">
              <div class="pah-wt">
                ${r.subject ? `<span class="pah-tag ${pahSubjClass(r.subject)}">${esc(r.subject)}</span>` : ''}
                ${esc(r.chapter || 'Chapter')}
              </div>
              <div class="pah-ws">
                <i class="fa-solid ${icon(r.kind)}"></i>
                ${esc(label(r.kind))} · ${esc(r.detail || '')}
              </div>
            </div>
            ${r.kind === 'test' && r.pct != null
        ? `<div class="pah-wpct ${r.good ? '' : 'low'}">${pahPct(r.pct)}</div>`
        : r.marks != null
          ? `<div class="pah-wpct">${r.marks}</div>`
          : `<div class="pah-wpct quiet"><i class="fa-solid fa-check"></i></div>`}
          </div>`).join('')}
      </div>
    </div>`;
}


/* ════════════════════════════════════════════════════════════════
   5 · READING AND TESTING, PER SUBJECT

   Two bars, never merged. They come from two different collections
   with two different chapter universes and cannot share a
   denominator even in principle:

       Reading   the Concept Studio syllabus
       Testing   chapters that have a question bank

   The first version drew ONE bar from the question bank and called
   it the syllabus, so "1 of 1 chapters opened" read as "finished
   Chemistry" when it meant "one Chemistry chapter has questions
   written". Physics vanished from the page entirely while the
   student was reading it daily.

   Every subject renders, always. A subject whose question bank
   isn't ready says so, rather than disappearing.
   ════════════════════════════════════════════════════════════════ */

function pahSubjects(s) {
  const subs = s.items || [];
  if (!subs.length) {
    return `
      <div class="pt-sec pah-sec">
        ${pahHead('subjects', 'Reading and testing', '', s.info)}
        ${emptyState('fa-book', 'No chapters opened yet',
      'Subjects appear here once a chapter is started.')}
      </div>`;
  }

  return `
    <div class="pt-sec pah-sec">
      ${pahHead('subjects', 'Reading and testing',
    'Two separate tracks, per subject.', s.info)}
      ${subs.map(x => {
      const t = x.testing || {};
      const years = x.years || [];
      return `
        <div class="pah-subj">
          <div class="pah-subj-n">
            <span class="pah-tag ${pahSubjClass(x.subject)}">${esc(x.subject)}</span>
          </div>

          ${years.length ? years.map(y => pahYearRow(y)).join('')
          : `<div class="pah-subj-f">Nothing uploaded for this subject yet.</div>`}

          <div class="pah-subj-f">
            ${t.available
          ? (t.ready
            ? `${pahPct(t.accuracy)} of questions right, across ${pahN(t.asked, 'question')}`
            : `Not enough questions answered yet to say how it's going`)
          : `Chapter tests for this subject aren't ready yet`}
          </div>
        </div>`;
    }).join('')}
    </div>`;
}

/* One year of one subject: its own reading bar and its own tests bar,
   with its own denominators. Class 11 gets a row of its own rather
   than being folded into this year's total — NEET examines both years,
   and revision of the earlier one is real work that was previously
   counted towards nothing and rendered nowhere. */
function pahYearRow(y) {
  const r = y.reading || {}, t = y.testing || {};
  const w = (n, d) => d ? Math.min(100, (n / d) * 100).toFixed(1) : 0;
  return `
    <div class="pah-year ${y.is_own_year ? 'own' : ''}">
      <div class="pah-year-k">${esc(y.label || '')}${y.is_own_year
      ? '<em>this year</em>' : ''}</div>

      <div class="pah-track">
        <div class="pah-track-k">Reading</div>
        <div class="pah-trbar">
          <i class="read" style="width:${w(r.opened, r.total)}%"></i>
        </div>
        <div class="pah-track-v">${r.total
      ? `${r.opened} of ${r.total}` : `${r.opened || 0}`}</div>
      </div>

      <div class="pah-track">
        <div class="pah-track-k">Tests</div>
        <div class="pah-trbar">
          <i class="test" style="width:${w(t.tested, t.available)}%"></i>
        </div>
        <div class="pah-track-v">${t.available
      ? `${t.tested} of ${t.available}` : '—'}</div>
      </div>
    </div>`;
}


/* ════════════════════════════════════════════════════════════════
   6 · WORTH ASKING ABOUT

   A parent who closes this page having learned "47%" has been given
   nothing. A parent who closes it knowing to ask about osmosis has
   been given the product.

   Two at most, never twice about the same chapter, phrased as
   suggestions. The first version shipped two cards carrying an
   identical sentence about the same chapter, under a subtitle
   claiming "not a template".
   ════════════════════════════════════════════════════════════════ */

function pahTalkAbout(t) {
  const list = t.items || [];
  if (!list.length) return '';
  return `
    <div class="pt-sec pah-sec pah-talk">
      ${pahHead('talk', 'Worth asking about',
    'From their own answers, not a list of study tips.', t.info)}
      ${list.map(x => `
        <div class="pah-talk-i">
          <div class="pah-talk-t">
            ${x.subject ? `<span class="pah-tag ${pahSubjClass(x.subject)}">${esc(x.subject)}</span>` : ''}
            ${esc(x.title)}
          </div>
          <div class="pah-talk-b">${esc(x.body)}</div>
        </div>`).join('')}
    </div>`;
}


/* ════════════════════════════════════════════════════════════════
   THE DECK

   One child: no deck. The header carries the same facts and the old
   card was a verbatim repeat of two sections below it.

   Two or more: the deck stays, because switching between children
   is a real job — but the Doctor bar is gone from the cards too. A
   sibling card now shows the flag SENTENCE rather than a bare red
   dot, so a parent scrolling past learns why.

   The outer classes (.pt-card, .on, #pt-dots) are unchanged, so
   portal.js's swipe handler and onChildSwitch() keep working with
   no edit.
   ════════════════════════════════════════════════════════════════ */

async function renderDeckV2() {
  const wrap = $('pt-deck-wrap');
  if (!wrap) return;

  if (PT.children.length <= 1) {
    wrap.innerHTML = '';
    return;
  }

  if (!PAH.deck) {
    try {
      const d = await apiCall('/api/parent/v2/children');
      PAH.deck = d.children || [];
    } catch (e) {
      PAH.deck = null;
    }
  }

  const byUid = {};
  (PAH.deck || []).forEach(c => { byUid[c.uid] = c; });

  const cards = PT.children.map((c, i) => {
    const v = byUid[c.uid] || c;
    return v.consent_revoked ? pahLockedCard(v, i) : pahCard(v, i);
  }).join('');

  wrap.innerHTML = `
    <div class="pt-deck">
      <div class="pt-deck-track" id="pt-track">${cards}</div>
      <div class="pt-dots" id="pt-dots">
        ${PT.children.map((_, i) =>
    `<div class="pt-dot ${i === PT.activeIdx ? 'on' : ''}"></div>`).join('')}
      </div>
    </div>`;

  const track = $('pt-track');
  let t;
  track.addEventListener('scroll', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const i = Math.round(track.scrollLeft / (track.scrollWidth / PT.children.length));
      if (i !== PT.activeIdx && PT.children[i]) onChildSwitch(i);
    }, 90);
  }, { passive: true });
}

function pahCard(c, i) {
  const idle = c.last_active_days;
  const idleCls = idle == null ? 'muted' : idle >= 7 ? 'bad' : idle >= 3 ? 'warn' : '';
  const idleTxt = idle == null ? '—' : idle === 0 ? 'Today' : `${idle}d ago`;
  const meta = [c.class_id && `Class ${c.class_id}`]
    .filter(Boolean).join(' · ') || 'No class assigned';

  return `
    <div class="pt-card pah-card ${i === PT.activeIdx ? 'on' : ''}"
         onclick="clickChild(${i})">
      <div class="pt-card-head">
        ${avatarHTML(c.photo_url, c.initials)}
        <div style="min-width:0">
          <div class="pt-card-name">${esc(c.name)}</div>
          <div class="pt-card-meta">${esc(meta)}</div>
        </div>
      </div>

      ${c.has_alert && c.alert_reason
      ? `<div class="pah-card-flag">${esc(c.alert_reason)}</div>` : ''}

      <div class="pt-card-lines">
        <div class="pt-line">
          <div class="pt-line-k">Last studied</div>
          <div class="pt-line-v ${idleCls}">${esc(idleTxt)}</div>
        </div>
        <div class="pt-line">
          <div class="pt-line-k">Streak</div>
          <div class="pt-line-v ${c.streak_current ? '' : 'muted'}">${c.streak_current || 0}d</div>
        </div>
        <div class="pt-line">
          <div class="pt-line-k">Getting right</div>
          <div class="pt-line-v ${c.accuracy == null ? 'muted' : ''}">${pahPct(c.accuracy)}</div>
        </div>
      </div>
    </div>`;
}

function pahLockedCard(c, i) {
  return `
    <div class="pt-card locked ${i === PT.activeIdx ? 'on' : ''}"
         onclick="clickChild(${i})">
      <div class="pt-card-head">
        ${avatarHTML(null, c.initials)}
        <div><div class="pt-card-name">${esc(c.name)}</div></div>
      </div>
      <p class="pt-locked-msg">
        <i class="fa-solid fa-lock"></i>
        ${esc((c.name || '').split(' ')[0])} has turned off parent access.
        Only they can turn it back on, from their Profile screen.
      </p>
    </div>`;
}


/* ════════════════════════════════════════════════════════════════
   TAKEOVER

   portal.js owns renderParentTab and renderDeck. Rather than
   editing either, we wrap them: 'home' and the deck go to v2,
   everything else falls through untouched. Deleting this file
   restores the old home page exactly.
   ════════════════════════════════════════════════════════════════ */

(function () {
  const origTab = window.renderParentTab;
  const origDeck = window.renderDeck;

  if (typeof origTab === 'function') {
    window.renderParentTab = async function (tab) {
      if (tab === 'home') return renderParentHomeV2();
      return origTab(tab);
    };
  }

  if (typeof origDeck === 'function') {
    window.renderDeck = function () { return renderDeckV2(); };
  }
})();