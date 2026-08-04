/* ════════════════════════════════════════════════════════════════
   NAADI AI — DOUBTS (doubts.js)
   ─────────────────────────────────────────────────────────────────
   ONE module, mounted by BOTH shells:
       app.html    → navigate('doubts')      → ndDoubtsMount(el,'student')
       portal.html → goTab('doubts')         → ndDoubtsMount(el,'teacher')

   Depends only on shared.js (apiCall, escapeHtml, ndToast), which
   both shells load first. It never touches shell chrome directly —
   the shells own their own top bars, and they hand this module a
   container plus a badge callback.

   ═════ WHAT THIS IS, AND WHAT IT BECOMES ═════
   Part 1 (this file) ships ONE conversation source: the continuous
   thread with the NAADI team that students already had buried in a
   Profile modal, now given a real home and extended to teachers.

   Part 2 adds student <-> teacher threads. It does that by pushing a
   second entry into DBT_SOURCES and nothing else: the list renderer,
   the chat pane, the composer, the polling and the sequence guard are
   all source-agnostic already. That is the entire reason this file is
   shaped the way it is — resist the urge to special-case 'support'
   anywhere below the adapter.

   ═════ THREE THINGS THAT ARE NOT ACCIDENTS ═════
   1. SEQUENCE GUARD. Opening a thread is async. Two fast taps used to
      paint the first thread's messages into the second thread's pane
      (the same class of bug as loadDrill in teacher-class.js). Every
      open bumps DBT.seq and every await re-checks it before touching
      the DOM.
   2. TIMERS DIE ON UNMOUNT. A poll ticking against a hidden view
      burns quota and can repaint a pane the user has left. Both
      shells call ndDoubtsUnmount() when navigating away.
   3. THE BADGE POLL IS SEPARATE AND LIGHTWEIGHT. It hits
      /api/support/unread (one document read), not the thread list, and
      it runs whether or not the screen is mounted — a student on the
      OPD screen still needs to see that a reply arrived.
   ════════════════════════════════════════════════════════════════ */

'use strict';

const DBT = {
    el: null,             // container element, or null when unmounted
    role: 'student',      // 'student' | 'teacher' — copy tone only
    convos: [],           // flat list; each carries its own source key
    active: null,         // active conversation id, or null
    activeSrc: null,      // active conversation's source key
    messages: [],
    poll: null,           // open-thread poll (8s)
    badgePoll: null,      // unread poll (60s), independent of mounting
    badgeCb: null,        // shell callback: fn(count)
    seq: 0,               // guards overlapping opens
    sending: false,
    loadedOnce: false,
    pending: null,        // a picked-but-not-yet-created conversation
    classKey: '',         // student's class, learned from the teachers call
    approved: false,      // student is in an approved class
    picker: null,         // open picker sheet element
};

/* ── POLL CADENCE ──────────────────────────────────────────────
   Was a flat 8s. Three problems with that, and only the third is
   about money:

     A phone holding a 500ms radio wake every 8 seconds for as long
     as the screen is open is a battery and mobile-data cost the
     student pays, on a plan they may be counting.

     A poll ticking against a backgrounded tab is pure waste — the
     student is not reading it.

     And it is reads: ~450 polls an hour per open thread. Over three
     years that is roughly ₹19 a student, which is real but is by
     far the smallest of the three reasons.

   So: a slower base, nothing at all while hidden, and a back-off
   when the conversation has gone quiet. Sending a message resets to
   the fast cadence, because that is the moment a reply is likely. */
const DBT_POLL_MS = 25000;        // base
const DBT_POLL_IDLE_MS = 60000;   // after DBT_IDLE_AFTER_MS of silence
const DBT_IDLE_AFTER_MS = 120000; // 2 minutes
const DBT_BADGE_MS = 60000;
const DBT_MAX_CHARS = 2000;


/* ════════════════════════════════════════════════════════════════
   CONVERSATION SOURCES

   Each source knows how to list its conversations, open one, and
   send into one. Declaration order here is the order groups appear
   in the list. Part 2 appends a 'teachers' source below this one.
   ════════════════════════════════════════════════════════════════ */

const DBT_SOURCES = {

    support: {
        key: 'support',
        group: 'NAADI team',
        order: 0,

        // Returns [] or a single-element list — the thread with the
        // team is uid-keyed server-side, so there is never more than
        // one, and there may be none until the first message is sent.
        async list() {
            const d = await apiCall('/api/support/tickets');
            const t = (d.tickets || [])[0] || null;
            return [{
                src: 'support',
                id: t ? t.ticket_id : null,     // null == not started yet
                name: 'NAADI team',
                icon: 'fa-headset',
                sub: t && t.last_message
                    ? (t.last_from === 'admin' ? '' : 'You: ') + t.last_message
                    : DBT.role === 'teacher'
                        ? 'Flag content, report a portal problem, ask us anything'
                        : 'App not working? Something confusing? Ask us here',
                at: t ? t.updated_at : null,
                unread: t ? (t.unread_student || 0) : 0,
                status: t ? t.status : null,
            }];
        },

        async open(id) {
            const d = await apiCall(`/api/support/ticket/${id}`);
            return { messages: d.messages || [], ticket: d.ticket || {} };
        },

        // id === null means "no thread yet"; the create endpoint is
        // idempotent on the uid-keyed thread, so a double-tap cannot
        // fork a second conversation.
        async send(id, text) {
            if (!id) {
                const r = await apiCall('/api/support/ticket', 'POST', { text });
                return r.ticket_id;
            }
            await apiCall(`/api/support/ticket/${id}/message`, 'POST', { text });
            return id;
        },

        // A message is "mine" unless the team wrote it.
        mine(m) { return m.from !== 'admin'; },

        // Shown above an empty thread so the first screen is an
        // invitation to act, not a blank box.
        welcome() {
            return DBT.role === 'teacher'
                ? 'Ask us anything about the portal — a number that looks wrong, '
                + 'a chapter that needs fixing, a feature you need. A real person '
                + 'from the NAADI team replies right here, and the whole '
                + 'conversation stays in one place.'
                : 'Ask us anything — a bug, a doubt about how something works, or '
                + 'feedback. A real person from the NAADI team replies right here, '
                + 'and this whole conversation stays in one chat.';
        },

        headSub() { return 'Usually replies within a day'; },
    },

    /* ═══════════════════════════════════════════════════════════════
       PART 2 — student <-> teacher conversations.

       Everything below is a source like the one above. The list
       renderer, chat pane, composer, polling and sequence guard did not
       change to accommodate them; that was the point of the shape.

       Four fields are new, and all four are OPTIONAL, which is why
       `support` above needed no edit:
         roles       which shell shows this source at all
         newAction   a group-level button ("Ask a teacher")
         headActions pane-header buttons (report / resolve)
         notice      a banner above the log (the supervision disclosure)
       plus a per-row `readOnly`, which renders the pane with no composer.
       ═══════════════════════════════════════════════════════════════ */

    // ── STUDENT: one row per teacher who takes their class ──
    teachers: {
        key: 'teachers',
        group: 'My teachers',
        order: 1,
        roles: ['student'],

        async list() {
            const d = await apiCall('/api/doubts/teachers');
            DBT.classKey = d.class_key || '';
            DBT.approved = !!d.approved;
            // A row per teacher whether or not a thread exists, so the
            // student picks a person, not a conversation. id === null
            // means "not started" — the same shape the NAADI row uses.
            return (d.teachers || []).map(t => ({
                src: 'teachers',
                id: t.thread ? t.thread.thread_id : null,
                teacher_uid: t.uid,
                name: t.name,
                icon: t.role === 'class_teacher' ? 'fa-user-tie' : 'fa-chalkboard-user',
                subject: t.subject,
                sub: t.thread && t.thread.last_message
                    ? (t.thread.last_from === 'student' ? 'You: ' : '') + t.thread.last_message
                    : t.subject,
                at: t.thread ? t.thread.updated_at : null,
                unread: t.thread ? t.thread.unread : 0,
                status: t.thread ? t.thread.status : null,
            }));
        },

        async open(id) {
            const d = await apiCall(`/api/doubts/thread/${id}`);
            return { messages: d.messages || [], thread: d.thread || {} };
        },

        async send(id, text, c) {
            if (!id) {
                const r = await apiCall('/api/doubts/thread', 'POST',
                    { teacher_uid: c.teacher_uid, text });
                return r.thread_id;
            }
            await apiCall(`/api/doubts/thread/${id}/message`, 'POST', { text });
            return id;
        },

        mine(m) { return m.from === 'student'; },

        welcome(c) {
            return `Ask ${c && c.name ? c.name : 'your teacher'} about anything `
                + `you are stuck on. Type the question out — the more exactly you `
                + `describe where you got lost, the more useful the answer.`;
        },

        headSub(c) { return (c && c.subject) || 'Teacher'; },

        // Stated in the conversation itself, to both sides, every time.
        // Supervision that is discovered later is worse than no
        // supervision at all.
        notice() {
            return 'Your class teacher can read this conversation. '
                + 'Messages are saved and cannot be deleted.';
        },

        headActions(c) {
            return c && c.id ? [{ icon: 'fa-flag', label: 'Report', fn: 'dbtReport()' }] : [];
        },
    },

    // ── TEACHER: conversations with their students ──
    students: {
        key: 'students',
        group: 'My students',
        order: 1,
        roles: ['teacher'],

        async list() {
            const d = await apiCall('/api/teacher/doubts');
            return (d.threads || []).map(t => ({
                src: 'students',
                id: t.thread_id,
                name: t.student_name,
                icon: 'fa-user',
                subject: `${t.class_id || t.class_key} · ${t.subject}`,
                sub: (t.last_from === 'teacher' ? 'You: ' : '') + (t.last_message || ''),
                at: t.updated_at,
                unread: t.unread,
                status: t.status,
            }));
        },

        async open(id) {
            const d = await apiCall(`/api/doubts/thread/${id}`);
            return { messages: d.messages || [], thread: d.thread || {} };
        },

        async send(id, text, c) {
            if (!id) {
                const r = await apiCall('/api/teacher/doubts/thread', 'POST',
                    { student_uid: c.student_uid, class_key: c.class_key, text });
                return r.thread_id;
            }
            await apiCall(`/api/doubts/thread/${id}/message`, 'POST', { text });
            return id;
        },

        mine(m) { return m.from === 'teacher'; },

        welcome(c) {
            return `Reply to ${c && c.name ? c.name : 'your student'} here. `
                + `The whole conversation stays in one place, so you can see `
                + `what they have already asked.`;
        },

        headSub(c) { return (c && c.subject) || 'Student'; },

        notice() {
            return 'Your class teacher can read this conversation. '
                + 'Messages are saved and cannot be deleted.';
        },

        newAction() {
            return { label: 'Message a student', icon: 'fa-plus', fn: 'dbtPickStudent()' };
        },

        headActions(c) {
            if (!c || !c.id) return [];
            return [
                {
                    icon: c.status === 'resolved' ? 'fa-rotate-left' : 'fa-check',
                    label: c.status === 'resolved' ? 'Reopen' : 'Resolve',
                    fn: 'dbtToggleResolved()'
                },
                { icon: 'fa-flag', label: 'Report', fn: 'dbtReport()' },
            ];
        },
    },

    // ── CLASS TEACHER: read-only oversight of the class ──
    supervise: {
        key: 'supervise',
        group: 'Supervision',
        order: 2,
        roles: ['teacher'],

        async list() {
            const d = await apiCall('/api/teacher/doubts/supervise');
            return (d.threads || []).map(t => ({
                src: 'supervise',
                id: t.thread_id,
                name: `${t.student_name} · ${t.teacher_name}`,
                icon: 'fa-eye',
                subject: `${t.class_id || t.class_key} · ${t.subject}`,
                sub: t.last_message || '',
                at: t.updated_at,
                unread: 0,
                readOnly: true,
                flagged: t.report_count > 0,
            }));
        },

        async open(id) {
            const d = await apiCall(`/api/teacher/doubts/supervise/${id}`);
            return { messages: d.messages || [], thread: d.thread || {} };
        },

        // No send. The route does not exist, and neither does the button.
        mine() { return false; },

        headSub(c) { return (c && c.subject) || 'Read only'; },

        notice() {
            return 'You are reading this as class teacher. You cannot reply, '
                + 'and both people have been told you can see it.';
        },
    },
};

// Only the sources this shell's role should see. A source with no
// `roles` (the NAADI thread) is shown to everyone.
function dbtActiveSources() {
    return Object.values(DBT_SOURCES)
        .filter(s => !s.roles || s.roles.indexOf(DBT.role) !== -1)
        .sort((a, b) => a.order - b.order);
}


/* ════════════════════════════════════════════════════════════════
   HELPERS
   ════════════════════════════════════════════════════════════════ */

function dbtEl(id) { return document.getElementById(id); }

function dbtSrc(key) { return DBT_SOURCES[key] || null; }

function dbtRel(iso) {
    if (!iso) return '';
    const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (isNaN(m)) return '';
    if (m < 2) return 'just now';
    if (m < 60) return `${m}m ago`;
    if (m < 1440) return `${Math.floor(m / 60)}h ago`;
    if (m < 10080) return `${Math.floor(m / 1440)}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// Day dividers in the log. "Today" and "Yesterday" carry more meaning
// than a date for a conversation you are actively having.
function dbtDayLabel(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const today = new Date();
    const strip = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((strip(today) - strip(d)) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function dbtEmpty(icon, title, sub) {
    return `<div class="dbt-empty">
        <i class="fa-solid ${icon}"></i>
        <div class="dbt-empty-t">${escapeHtml(title)}</div>
        <div class="dbt-empty-s">${escapeHtml(sub)}</div>
      </div>`;
}

function dbtSkeleton(n) {
    return Array.from({ length: n || 2 }, () => '<div class="dbt-skel"></div>').join('');
}


/* ════════════════════════════════════════════════════════════════
   MOUNT / UNMOUNT
   ════════════════════════════════════════════════════════════════ */

/**
 * Paint the Doubts screen into `el`.
 * @param {HTMLElement|string} el   container element or its id
 * @param {string} role             'student' | 'teacher' — copy tone only;
 *                                  it grants no permission of any kind.
 */
function ndDoubtsMount(el, role) {
    const node = typeof el === 'string' ? dbtEl(el) : el;
    if (!node) return;

    DBT.el = node;
    DBT.role = role === 'teacher' ? 'teacher' : 'student';
    DBT.active = null;
    DBT.activeSrc = null;
    DBT.messages = [];

    node.innerHTML = `
      <div class="dbt">
        <div class="dbt-split" id="dbt-split">
          <div class="dbt-list" id="dbt-list">${dbtSkeleton(2)}</div>
          <div class="dbt-pane" id="dbt-pane"></div>
        </div>
      </div>`;

    dbtRenderPane();          // desktop shows the empty pane immediately
    dbtLoadList();
}

function ndDoubtsUnmount() {
    dbtStopPoll();
    dbtClosePicker();
    DBT.el = null;
    DBT.active = null;
    DBT.activeSrc = null;
    DBT.messages = [];
}

function dbtStopPoll() {
    if (DBT.poll) { clearTimeout(DBT.poll); DBT.poll = null; }
    if (DBT._visHandler) {
        document.removeEventListener('visibilitychange', DBT._visHandler);
        DBT._visHandler = null;
    }
}

// Called by the composer on a successful send. A reply is most likely
// in the seconds right after the student writes, so the back-off is
// discarded and the fast cadence resumes.
function dbtPollWake() {
    DBT.lastActivity = Date.now();
}

// True while the screen this module painted is still on-screen. Every
// async continuation checks this before writing to the DOM.
function dbtLive() {
    return !!(DBT.el && document.body.contains(DBT.el) && dbtEl('dbt-split'));
}


/* ════════════════════════════════════════════════════════════════
   LIST
   ════════════════════════════════════════════════════════════════ */

async function dbtLoadList() {
    const sources = dbtActiveSources();
    const out = [];

    for (const s of sources) {
        try {
            const rows = await s.list();
            rows.forEach(r => out.push(Object.assign({ src: s.key }, r)));
        } catch (e) {
            // One failing source must not blank the whole screen.
            console.warn(`[doubts] ${s.key} list failed:`, e);
        }
    }

    if (!dbtLive()) return;
    DBT.convos = out;
    DBT.loadedOnce = true;
    dbtRenderList();
    dbtRefreshBadge();
}

function dbtRenderList() {
    const list = dbtEl('dbt-list');
    if (!list) return;

    if (!DBT.convos.length) {
        list.innerHTML = dbtEmpty('fa-comments', "Nothing here yet",
            "Conversations you start will appear in this list.");
        return;
    }

    const sources = dbtActiveSources();
    let html = '';

    for (const s of sources) {
        const rows = DBT.convos.filter(c => c.src === s.key);
        const act = s.newAction ? s.newAction() : null;
        // A group with an action still renders when empty — that button
        // is how a teacher starts their first conversation.
        if (!rows.length && !act) continue;

        html += `<div class="dbt-group">${escapeHtml(s.group)}`;
        if (act) {
            html += `<button class="dbt-newbtn" onclick="${act.fn}">
                       <i class="fa-solid ${escapeHtml(act.icon)}"></i>
                       ${escapeHtml(act.label)}</button>`;
        }
        html += `</div>`;

        html += rows.length ? rows.map(dbtRowHTML).join('')
            : `<p class="dbt-groupnote">No conversations yet.</p>`;
    }

    // A student with no approved class has no teachers to show, and
    // saying so beats an empty panel they cannot act on.
    if (DBT.role === 'student' && !DBT.approved
        && DBT_SOURCES.teachers && !DBT.convos.some(c => c.src === 'teachers')) {
        html += `<div class="dbt-group">My teachers</div>
                 <p class="dbt-groupnote">Once your class is approved, your
                 teachers appear here and you can ask them directly.</p>`;
    }

    list.innerHTML = html;
}

function dbtRowHTML(c) {
    const key = `${c.src}:${c.id || 'new'}`;
    const on = DBT.activeSrc === c.src && DBT.active === c.id;
    const unread = c.unread || 0;
    return `
      <button class="dbt-row ${on ? 'on' : ''}" data-key="${escapeHtml(key)}"
              onclick="dbtOpen('${escapeHtml(c.src)}', ${c.id ? `'${escapeHtml(c.id)}'` : 'null'})">
        <div class="dbt-ico"><i class="fa-solid ${escapeHtml(c.icon || 'fa-comment')}"></i></div>
        <div class="dbt-row-body">
          <div class="dbt-row-top">
            <span class="dbt-row-name">${escapeHtml(c.name)}</span>
            ${c.at ? `<span class="dbt-row-when">${escapeHtml(dbtRel(c.at))}</span>` : ''}
          </div>
          <div class="dbt-row-sub">${escapeHtml(c.sub || '')}</div>
          ${c.subject && c.subject !== c.sub
            ? `<div class="dbt-row-tags"><span class="dbt-pill">${escapeHtml(c.subject)}</span>
                 ${c.status === 'resolved' ? '<span class="dbt-pill">resolved</span>' : ''}
                 ${c.flagged ? '<span class="dbt-pill flag">reported</span>' : ''}</div>`
            : ''}
        </div>
        <em class="dbt-row-unread ${unread ? '' : 'hidden'}">${unread > 99 ? '99+' : unread}</em>
      </button>`;
}


/* ════════════════════════════════════════════════════════════════
   OPEN A CONVERSATION
   ════════════════════════════════════════════════════════════════ */

async function dbtOpen(srcKey, id, seed) {
    const s = dbtSrc(srcKey);
    if (!s) return;

    // `seed` is a conversation that does not exist on the server yet —
    // a teacher picked from the roster. It lives in DBT.pending until
    // the first message creates it.
    DBT.pending = seed || null;
    const mySeq = ++DBT.seq;
    dbtStopPoll();
    DBT.activeSrc = srcKey;
    DBT.active = id;
    DBT.messages = [];

    dbtEl('dbt-split')?.classList.add('chat-open');
    dbtRenderList();                       // repaint .on state
    dbtRenderPane({ loading: true });

    if (!id) {
        // No thread on the server yet. Show the welcome and let the
        // first message create it — nothing to fetch.
        if (DBT.seq !== mySeq || !dbtLive()) return;
        dbtRenderPane();
        dbtFocusInput();
        return;
    }

    let d;
    try {
        d = await s.open(id);
    } catch (e) {
        if (DBT.seq !== mySeq || !dbtLive()) return;
        dbtRenderPane({ error: e.message || 'Could not open this conversation.' });
        return;
    }

    // A second tap landed while we were away — that open owns the pane.
    if (DBT.seq !== mySeq || !dbtLive()) return;

    DBT.messages = d.messages || [];
    dbtRenderPane();
    dbtScrollLog(true);
    dbtFocusInput();

    // Reading clears the badge for this thread.
    const c = DBT.convos.find(x => x.src === srcKey && x.id === id);
    if (c) c.unread = 0;
    dbtRenderList();
    dbtRefreshBadge();

    dbtStartPoll();
}

function dbtBack() {
    dbtStopPoll();
    DBT.active = null;
    DBT.activeSrc = null;
    DBT.messages = [];
    dbtEl('dbt-split')?.classList.remove('chat-open');
    dbtRenderList();
    dbtRenderPane();
    dbtLoadList();          // pick up anything that arrived while reading
}


/* ════════════════════════════════════════════════════════════════
   CHAT PANE
   ════════════════════════════════════════════════════════════════ */

function dbtRenderPane(state) {
    const pane = dbtEl('dbt-pane');
    if (!pane) return;
    state = state || {};

    // Nothing selected. On desktop this is the resting state of the
    // right-hand column; on mobile the pane is hidden anyway.
    if (!DBT.activeSrc) {
        pane.innerHTML = dbtEmpty('fa-comments', 'Pick a conversation',
            DBT.role === 'teacher'
                ? 'Choose a conversation on the left to read it and reply.'
                : 'Choose a conversation on the left to read it and reply.');
        return;
    }

    const s = dbtSrc(DBT.activeSrc);
    const c = DBT.convos.find(x => x.src === DBT.activeSrc && x.id === DBT.active)
        || DBT.pending || {};

    const acts = (s && s.headActions ? s.headActions(c) : []) || [];
    const head = `
      <div class="dbt-pane-head">
        <button class="dbt-back" onclick="dbtBack()" aria-label="Back to conversations">
          <i class="fa-solid fa-arrow-left"></i>
        </button>
        <div class="dbt-head-who">
          <div class="dbt-head-name">${escapeHtml(c.name || (s ? s.group : ''))}</div>
          <div class="dbt-head-sub">${escapeHtml(s && s.headSub ? s.headSub(c) : '')}</div>
        </div>
        ${acts.map(a => `<button class="dbt-headbtn" onclick="${a.fn}"
             title="${escapeHtml(a.label)}" aria-label="${escapeHtml(a.label)}">
             <i class="fa-solid ${escapeHtml(a.icon)}"></i></button>`).join('')}
      </div>`;

    // The disclosure. Rendered above the log, in the conversation, for
    // both people — not in a settings page neither of them will open.
    const notice = s && s.notice
        ? `<div class="dbt-notice"><i class="fa-solid fa-circle-info"></i>
             <span>${escapeHtml(s.notice(c))}</span></div>` : '';

    let body;
    if (state.loading) {
        body = `<div class="dbt-log" id="dbt-log">${dbtSkeleton(3)}</div>`;
    } else if (state.error) {
        body = `<div class="dbt-log" id="dbt-log">${dbtEmpty(
            'fa-triangle-exclamation', "Couldn't open this", state.error)}</div>`;
    } else {
        body = `<div class="dbt-log" id="dbt-log">${dbtLogHTML(s)}</div>`;
    }

    // Read-only means NO composer in the DOM at all. Not a disabled one:
    // a supervisor has no send route, so giving them a box to type into
    // would be a promise the server will not keep.
    const composer = c.readOnly ? `
      <div class="dbt-composer dbt-readonly">
        <i class="fa-solid fa-eye"></i>
        <span>Read only — you are not part of this conversation.</span>
      </div>` : `
      <div class="dbt-composer">
        <div class="dbt-composer-row">
          <textarea class="dbt-input" id="dbt-input" rows="1" maxlength="${DBT_MAX_CHARS}"
                    placeholder="Type your message…"
                    oninput="dbtGrow(this)"
                    onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();dbtSend()}"></textarea>
          <button class="dbt-send" id="dbt-send" onclick="dbtSend()" aria-label="Send message">
            <i class="fa-solid fa-paper-plane"></i>
          </button>
        </div>
        <p class="dbt-note">Messages are saved and can't be deleted.</p>
      </div>`;

    pane.innerHTML = head + notice + body + composer;
}

function dbtLogHTML(s) {
    const welcome = s && s.welcome
        ? dbtBubble({ text: s.welcome(), by_name: s.group, at: '' }, false)
        : '';

    if (!DBT.messages.length) return welcome;

    let html = welcome;
    let lastDay = '';
    for (const m of DBT.messages) {
        const day = dbtDayLabel(m.at);
        if (day && day !== lastDay) {
            html += `<div class="dbt-day">${escapeHtml(day)}</div>`;
            lastDay = day;
        }
        html += dbtBubble(m, s ? s.mine(m) : false);
    }
    return html;
}

function dbtBubble(m, mine) {
    const who = mine ? 'You' : (m.by_name || '');
    const when = m.at ? dbtRel(m.at) : '';
    const meta = (who || when)
        ? `<div class="dbt-msg-meta">${escapeHtml(who)}${who && when ? ' · ' : ''}${escapeHtml(when)}</div>`
        : '';
    return `<div class="dbt-msg ${mine ? 'mine' : ''}">${escapeHtml(m.text || '')}${meta}</div>`;
}

function dbtScrollLog(force) {
    const log = dbtEl('dbt-log');
    if (!log) return;
    // Only auto-scroll when the reader is already at the bottom —
    // yanking them down mid-scroll to read an old message is hostile.
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 40;
    if (force || atBottom) log.scrollTop = log.scrollHeight;
}

function dbtFocusInput() {
    // Desktop only. Focusing on a phone throws the keyboard up over
    // the conversation the moment it opens.
    if (window.innerWidth < 1024) return;
    dbtEl('dbt-input')?.focus();
}

function dbtGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}


/* ════════════════════════════════════════════════════════════════
   SEND
   ════════════════════════════════════════════════════════════════ */

async function dbtSend() {
    if (DBT.sending) return;
    const input = dbtEl('dbt-input');
    const btn = dbtEl('dbt-send');
    if (!input) return;

    const text = (input.value || '').trim();
    if (!text) return;

    const s = dbtSrc(DBT.activeSrc);
    if (!s) return;

    DBT.sending = true;
    if (btn) btn.disabled = true;
    input.value = '';
    dbtGrow(input);

    const mySeq = DBT.seq;
    try {
        const c = DBT.convos.find(x => x.src === DBT.activeSrc && x.id === DBT.active)
            || DBT.pending || {};
        const newId = await s.send(DBT.active, text, c);
        dbtPollWake();   // a reply is most likely right after we write

        if (DBT.seq !== mySeq || !dbtLive()) return;

        // A brand-new thread now has a server id. Adopt it, and adopt
        // it on the list row too, or the next tap would try to create
        // a second one.
        if (newId && newId !== DBT.active) {
            const row = DBT.convos.find(x => x.src === DBT.activeSrc && !x.id
                && (!c.teacher_uid || x.teacher_uid === c.teacher_uid));
            if (row) row.id = newId;
            if (DBT.pending) DBT.pending.id = newId;
            DBT.active = newId;
        }

        const d = await s.open(DBT.active);
        if (DBT.seq !== mySeq || !dbtLive()) return;

        DBT.messages = d.messages || [];
        const log = dbtEl('dbt-log');
        if (log) { log.innerHTML = dbtLogHTML(s); dbtScrollLog(true); }

        dbtStartPoll();
        dbtLoadList();
    } catch (e) {
        // Never silently eat what someone wrote — put it back.
        if (dbtLive() && dbtEl('dbt-input')) {
            dbtEl('dbt-input').value = text;
            dbtGrow(dbtEl('dbt-input'));
        }
        if (typeof ndToast === 'function') ndToast(e.message || 'Message not sent. Try again.', 'error');
        else alert(e.message || 'Message not sent. Try again.');
    } finally {
        DBT.sending = false;
        const b = dbtEl('dbt-send');
        if (b) b.disabled = false;
    }
}


/* ════════════════════════════════════════════════════════════════
   POLL — refresh the open thread every 8s
   ════════════════════════════════════════════════════════════════ */

function dbtStartPoll() {
    dbtStopPoll();
    if (!DBT.active) return;
    const srcKey = DBT.activeSrc, id = DBT.active, mySeq = DBT.seq;
    DBT.lastActivity = Date.now();

    // setTimeout, not setInterval: the delay has to be recomputed
    // between ticks, and setInterval cannot change its own period.
    const schedule = () => {
        if (!DBT.active || DBT.seq !== mySeq) return;
        const quiet = Date.now() - (DBT.lastActivity || 0) > DBT_IDLE_AFTER_MS;
        DBT.poll = setTimeout(tick, quiet ? DBT_POLL_IDLE_MS : DBT_POLL_MS);
    };

    // A hidden tab polls zero times. When it comes back we fire once
    // immediately, so returning to the app never shows a stale thread.
    DBT._visHandler = () => {
        if (document.hidden) {
            if (DBT.poll) { clearTimeout(DBT.poll); DBT.poll = null; }
        } else if (DBT.active === id && DBT.seq === mySeq && !DBT.poll) {
            DBT.lastActivity = Date.now();
            tick();
        }
    };
    document.addEventListener('visibilitychange', DBT._visHandler);

    const tick = async () => {
        // Any of these means this poll is stale — retire it.
        if (!dbtLive() || DBT.seq !== mySeq || DBT.active !== id) return dbtStopPoll();
        if (document.hidden) { DBT.poll = null; return; }

        const s = dbtSrc(srcKey);
        if (!s) return dbtStopPoll();

        try {
            const d = await s.open(id);
            if (!dbtLive() || DBT.seq !== mySeq || DBT.active !== id) return;

            const incoming = d.messages || [];
            if (incoming.length !== DBT.messages.length) {
                // New traffic means the conversation is live again.
                DBT.lastActivity = Date.now();
                DBT.messages = incoming;
                const log = dbtEl('dbt-log');
                if (log) {
                    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 40;
                    log.innerHTML = dbtLogHTML(s);
                    if (stick) log.scrollTop = log.scrollHeight;
                }
                dbtRefreshBadge();
            }
        } catch (e) { /* a dropped poll is not an error worth showing */ }
        finally { schedule(); }
    };

    schedule();
}


/* ════════════════════════════════════════════════════════════════
   PICKERS — choosing who to write to

   A student picks from their own class's teachers; a teacher picks from
   their own class roster. Both lists come from the server already
   scoped, so the sheet only has to render what it is given.
   ════════════════════════════════════════════════════════════════ */

function dbtClosePicker() {
    DBT.picker?.remove();
    DBT.picker = null;
}

function dbtSheet(title, sub, rowsHTML) {
    dbtClosePicker();
    const el = document.createElement('div');
    el.className = 'dbt-sheet-back';
    el.onclick = (e) => { if (e.target === el) dbtClosePicker(); };
    el.innerHTML = `<div class="dbt-sheet" role="dialog" aria-label="${escapeHtml(title)}">
        <div class="dbt-sheet-t">${escapeHtml(title)}</div>
        ${sub ? `<p class="dbt-sheet-s">${escapeHtml(sub)}</p>` : ''}
        <div class="dbt-sheet-body">${rowsHTML}</div>
      </div>`;
    document.body.appendChild(el);
    DBT.picker = el;
    return el;
}

async function dbtPickStudent() {
    dbtSheet('Message a student', 'Loading your class…', dbtSkeleton(3));
    let d;
    try { d = await apiCall('/api/teacher/doubts/students'); }
    catch (e) {
        dbtSheet('Message a student', '', dbtEmpty('fa-triangle-exclamation',
            "Couldn't load your class", e.message || ''));
        return;
    }
    const rows = (d.students || []);
    if (!rows.length) {
        dbtSheet('Message a student', '', dbtEmpty('fa-users',
            'No students yet', 'Approved students in your class appear here.'));
        return;
    }
    dbtSheet('Message a student', 'Pick who to write to.', rows.map(st => `
      <button class="dbt-pick" onclick="dbtStartWithStudent('${escapeHtml(st.uid)}',
              '${escapeHtml(st.name)}', '${escapeHtml(d.class_key)}')">
        <span class="dbt-ini">${escapeHtml(st.initials)}</span>
        <span class="dbt-pick-n">${escapeHtml(st.name)}</span>
      </button>`).join(''));
}

function dbtStartWithStudent(uid, name, classKey) {
    dbtClosePicker();
    dbtOpen('students', null, {
        src: 'students', id: null, student_uid: uid, class_key: classKey,
        name: name, icon: 'fa-user', subject: 'New conversation', unread: 0,
    });
}


/* ════════════════════════════════════════════════════════════════
   RESOLVE + REPORT
   ════════════════════════════════════════════════════════════════ */

async function dbtToggleResolved() {
    const c = DBT.convos.find(x => x.src === DBT.activeSrc && x.id === DBT.active);
    if (!c || !c.id) return;
    const next = c.status === 'resolved' ? 'open' : 'resolved';
    try {
        await apiCall(`/api/teacher/doubts/thread/${c.id}/status`, 'POST', { status: next });
        c.status = next;
        dbtRenderPane();
        dbtRenderList();
        if (typeof ndToast === 'function')
            ndToast(next === 'resolved' ? 'Marked resolved' : 'Reopened', 'success');
    } catch (e) {
        if (typeof ndToast === 'function') ndToast(e.message || 'Could not update', 'error');
    }
}

function dbtReport() {
    const c = DBT.convos.find(x => x.src === DBT.activeSrc && x.id === DBT.active);
    if (!c || !c.id) return;
    dbtSheet('Report this conversation',
        'This goes straight to the NAADI team with the recent messages attached. '
        + 'Nobody in your school is notified, and the conversation is not deleted.',
        `<textarea class="dbt-input" id="dbt-reason" rows="4" maxlength="1000"
            placeholder="What happened? (optional)"></textarea>
         <div class="dbt-sheet-actions">
           <button class="dbt-btn quiet" onclick="dbtClosePicker()">Cancel</button>
           <button class="dbt-btn danger" onclick="dbtSendReport()">Send report</button>
         </div>`);
}

async function dbtSendReport() {
    const c = DBT.convos.find(x => x.src === DBT.activeSrc && x.id === DBT.active);
    if (!c || !c.id) return;
    const reason = (dbtEl('dbt-reason')?.value || '').trim();
    try {
        await apiCall(`/api/doubts/thread/${c.id}/report`, 'POST', { reason });
        dbtClosePicker();
        if (typeof ndToast === 'function')
            ndToast('Reported. The NAADI team will look at this.', 'success');
    } catch (e) {
        if (typeof ndToast === 'function') ndToast(e.message || 'Could not send', 'error');
    }
}


/* ════════════════════════════════════════════════════════════════
   UNREAD BADGE
   Runs independently of the screen: a reply that lands while the
   student is in OPD still has to light the top-bar icon.
   ════════════════════════════════════════════════════════════════ */

/**
 * @param {function(number)} cb  called with the total unread count
 */
function ndDoubtsBadgeStart(cb) {
    if (typeof cb === 'function') DBT.badgeCb = cb;
    ndDoubtsBadgeStop();
    dbtRefreshBadge();
    DBT.badgePoll = setInterval(dbtRefreshBadge, DBT_BADGE_MS);
}

function ndDoubtsBadgeStop() {
    if (DBT.badgePoll) { clearInterval(DBT.badgePoll); DBT.badgePoll = null; }
}

async function dbtRefreshBadge() {
    if (!DBT.badgeCb) return;
    // Two independent counts, one number on the icon. Each is fetched
    // separately so a failure in one never zeroes the other.
    let n = 0;
    try { n += Number((await apiCall('/api/support/unread')).unread || 0); }
    catch (e) { /* cosmetic */ }
    try { n += Number((await apiCall('/api/doubts/unread')).unread || 0); }
    catch (e) { /* cosmetic */ }
    try { DBT.badgeCb(n); } catch (e) { /* cosmetic */ }
}