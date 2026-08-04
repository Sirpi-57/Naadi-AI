/* ════════════════════════════════════════════════════════════════
   NAADI AI — NIA (nia.js)
   Naadi Intelligent Assistant. The student-facing chat.

   THREE THINGS THAT SHAPE THIS FILE

   1. CONTEXT COSTS NOTHING TO TRACK.
      NIA_CTX is a plain object updated by hooks. Navigating home → OPD →
      Studio fires zero requests and zero Firestore reads. The descriptor
      is only ever SENT when the student actually presses send. This is
      why there is no polling anywhere in this file.

   2. THE APP ALREADY KNOWS WHERE THE STUDENT IS.
      An earlier plan used an IntersectionObserver to guess which concept
      was on screen. Reading concept-studio-desktop.js made that
      unnecessary: S.chapterId, S.blockOrder[S.curBlockIdx] and S.curSecId
      are exact, and csdOpenBlock/csdSection are explicit choke points.
      Three one-line hooks beat any amount of scroll-watching.

   3. WE SEND IDs, NEVER PAGE TEXT.
      The server resolves the actual content. Scraped DOM would be
      forgeable, unbounded, full of chrome, and — because it differs on
      every render — would miss the model's prefix cache every single
      time. An ID resolves to byte-identical text, so every student on
      the same concept shares one cached block.
   ════════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    var NIA = {
        open: false,
        convId: null,
        convSurface: null,
        busy: false,
        mounted: false,
        available: false,
        messages: [],
        pendingSelection: '',
        statusTimer: null,
        listOpen: false,
        name: '',
        role: 'student',
    };

    /* ── the context descriptor. IDs only. ─────────────────────── */
    var NIA_CTX = { surface: 'generic' };

    // The teacher portal calls this from goTab(), the student app from
    // navigate(). Same object, same rules — the only difference is which
    // surface names appear.
    window.niaSetContext = function (patch) {
        NIA_CTX = Object.assign({ surface: 'generic' }, patch || {});
        refreshLauncherVisibility();
    };
    window.niaGetContext = function () { return NIA_CTX; };

    // Surfaces where Nia must not be reachable. The server refuses these
    // independently — this only spares the student a button that would
    // fail. Never treat this list as the security boundary.
    var LIVE = ['opd_test', 'arena_test', 'pyq_test', 'test', 'live_test', 'exam'];
    function inLiveTest() { return LIVE.indexOf(NIA_CTX.surface) !== -1; }

    /* ════════════════════════════════════════════════════════════════
       NIA — REVIEW QUESTION REGISTRY (shared by every review surface)
    
       OPD results, Arena and PYQ all render their cards through one of two
       builders. Both register here at BUILD time, so Nia works on all of
       them without any renderer needing to know Nia exists. The first
       version only covered OPD, which is why Arena had no button at all.
    
       WHY THE EXPAND HOOK MATTERS
    
       A results page is a LIST. A student opens Q2, scrolls, opens Q13, then
       types "why did I get this wrong?" without pressing any button. Nia has
       to answer about ONE of them, and silently picking the wrong one is
       worse than saying it cannot tell.
    
       The rule: Nia looks at the LAST QUESTION THE STUDENT EXPANDED, which
       is what they are actually reading. Collapsing that card clears it, so
       Nia never answers about a question that is no longer on screen.
       ════════════════════════════════════════════════════════════════ */
    window.__niaRev = window.__niaRev || {};

    window.niaRegisterReviewQ = function (key, qr) {
        window.__niaRev[key] = qr;
    };

    window.niaReviewContext = function (qr, surface) {
        if (typeof niaSetContext !== 'function') return;
        var opts = (qr.options_detail || qr.options || []).map(function (op) {
            var id = op.id || op.option_id || op.key || '';
            return {
                id: id,
                text: op.text || op.option_text || '',
                is_correct: !!op.is_correct || id === qr.correct_answer
            };
        });
        niaSetContext({
            surface: surface,
            chapter_id: qr.chapter_id || qr.chapter ||
                (typeof opdState !== 'undefined' ? opdState.chapterId : '') || '',
            question: {
                question_text: qr.question_text || '',
                options: opts,
                student_answer: (qr.student_answer && typeof qr.student_answer === 'object')
                    ? '' : (qr.student_answer || ''),
                explanation: qr.static_explanation || qr.explanation || ''
            }
        });
    };

    window.niaRevToggle = function (btn, key, surface) {
        var card = btn.parentElement;
        var opening = !card.classList.contains('open');
        card.classList.toggle('open');
        var qr = window.__niaRev[key];
        if (!qr || typeof niaSetContext !== 'function') return;
        if (opening) {
            window.__niaOpenKey = key;
            niaReviewContext(qr, surface);
        } else if (window.__niaOpenKey === key) {
            window.__niaOpenKey = null;
            niaSetContext({ surface: surface });
        }
    };

    window.opdAskNia = function (key, surface) {
        var qr = (window.__niaRev || {})[key];
        if (!qr) {
            if (typeof ndToast === 'function')
                ndToast('Reopen this question and try again.', 'error');
            return;
        }
        window.__niaOpenKey = key;
        niaReviewContext(qr, surface || 'opd_review');
        if (typeof niaOpen === 'function') niaOpen();
    };


    /* ── helpers ───────────────────────────────────────────────── */
    function $(id) { return document.getElementById(id); }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // The server already sanitises to a whitelist. This is the second pass:
    // a client that trusts a server string absolutely is one server bug
    // away from an injection in a student's session. Same principle as
    // tclQ()/thQ() in the teacher portal.
    var NIA_OK_TAGS = ['sub', 'sup', 'b', 'i', 'em', 'strong', 'br',
        'ul', 'ol', 'li', 'p', 'code'];

    function niaHtml(s) {
        var t = esc(s);
        var re = new RegExp('&lt;(/?)(' + NIA_OK_TAGS.join('|') + ')&gt;', 'gi');
        return t.replace(re, function (_, slash, tag) {
            return '<' + slash + tag.toLowerCase() + '>';
        });
    }

    /* ── APPEND-ONLY STREAM RENDERER ──────────────────────────────
       The previous attempt rebuilt innerHTML from the whole buffer on
       every token, running several regex passes over it each time. That
       is O(n²), and on a long answer it visibly scrambled and dropped
       words: text already on screen kept being re-derived and re-parsed
       while the browser was mid-layout.
  
       This version never touches text it has already committed. A chunk
       of DOM is built once, appended, and left alone forever. Exactly one
       node is ever mutated — the trailing span holding the sentence
       currently being typed.
  
       It pairs with the system prompt, which now asks for real HTML
       instead of Markdown, so committing a finished line is a whitelist
       filter rather than a transformation. Markdown remains handled on
       the server as a fallback for when the model slips. */

    function makeRenderer(target) {
        var done = 0;            // chars of `acc` already committed to DOM
        var live = document.createElement('span');
        live.className = 'nia-tail';
        target.innerHTML = '';
        target.appendChild(live);

        // Hold back a tag or entity opened but not yet closed. With the
        // model writing HTML directly, that is the only partial construct
        // left to worry about.
        function visible(s) {
            // This node is set with textContent, so ANY tag in it would show
            // as literal <b> on screen — not just an unfinished one. Strip
            // them all: this is one line of plain words that gets replaced by
            // properly formatted DOM the moment it completes.
            s = s.replace(/<[^>]*>/g, '').replace(/<[^>]*$/, '');
            return s.replace(/&[a-z#0-9]{0,8};?$/i, function (m) {
                return m.slice(-1) === ';' ? m : '';
            });
        }

        function commit(chunk) {
            if (!chunk.trim()) return;
            var html = niaHtml(chunk)
                .replace(/\n{2,}/g, '<br><br>')
                .replace(/\n/g, '<br>');
            var holder = document.createElement('div');
            holder.innerHTML = html;
            var prev = live.previousElementSibling;
            while (holder.firstChild) {
                var node = holder.firstChild;
                // Consecutive list items arriving on separate lines must extend
                // the previous list, not start a new one.
                if (prev && node.nodeType === 1 && node.tagName === prev.tagName &&
                    (node.tagName === 'UL' || node.tagName === 'OL')) {
                    while (node.firstChild) prev.appendChild(node.firstChild);
                    holder.removeChild(node);
                    continue;
                }
                target.insertBefore(node, live);
                if (node.nodeType === 1) prev = node;
            }
        }

        return {
            push: function (acc) {
                var nl = acc.lastIndexOf('\n');
                if (nl >= done) {
                    commit(acc.slice(done, nl + 1));
                    done = nl + 1;
                }
                live.textContent = visible(acc.slice(done));
            },
            finish: function (finalHtml) {
                target.innerHTML = niaHtml(finalHtml);
            }
        };
    }

    function reduceMotion() {
        return !!(window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    function isDesktop() { return window.innerWidth >= 1024; }

    /* ── loading status.
       Honest, because a sharp 17-year-old notices when a status line
       claims work that is not happening — and it costs you trust for
       nothing. These map to what the request is actually doing. ─────── */
    var STATUS = {
        studio: ['Reading the concept…', 'Working through it…'],
        opd_review: ['Looking at your answer…', 'Working through it…'],
        arena_review: ['Looking at your answer…', 'Working through it…'],
        generic: ['Thinking…', 'Working through it…'],
    };

    /* ════════════════════════════════════════════════════════════
       MOUNT
       ════════════════════════════════════════════════════════════ */

    function mount() {
        if (NIA.mounted || $('nia-root')) return;
        var root = document.createElement('div');
        root.id = 'nia-root';
        root.innerHTML =
            '<button id="nia-fab" class="nia-fab" aria-label="Ask Nia" hidden>' +
            '<span class="nia-fab-mark" aria-hidden="true">' +
            '<span class="nia-pulse"></span></span>' +
            '<span class="nia-fab-txt">Ask Nia</span></button>' +

            '<div id="nia-sel" class="nia-sel" hidden>' +
            '<button type="button" id="nia-sel-btn" class="nia-sel-btn">' +
            '<i class="fa-solid fa-wand-magic-sparkles"></i> Ask Nia about this' +
            '</button></div>' +

            '<div id="nia-scrim" class="nia-scrim" hidden></div>' +

            '<section id="nia-panel" class="nia-panel" role="dialog" hidden ' +
            'aria-label="Nia, your study assistant" aria-modal="false">' +
            '<header class="nia-head">' +
            '<span class="nia-avatar" aria-hidden="true"><span class="nia-pulse"></span></span>' +
            '<span class="nia-head-txt"><b>Nia</b><em id="nia-sub">Naadi Intelligent Assistant</em></span>' +
            '<button id="nia-info" class="nia-icon" aria-label="How Nia works" ' +
            'title="How Nia works"><i class="fa-solid fa-circle-info"></i></button>' +
            '<button id="nia-hist" class="nia-icon" aria-label="Past chats" ' +
            'title="Past chats — everything you have asked before">' +
            '<i class="fa-solid fa-clock-rotate-left"></i></button>' +
            '<button id="nia-new" class="nia-icon" aria-label="New chat" ' +
            'title="New chat — start here when you switch topic">' +
            '<i class="fa-solid fa-pen-to-square"></i></button>' +
            '<button id="nia-close" class="nia-icon" aria-label="Close Nia" ' +
            'title="Close — this chat is saved">' +
            '<i class="fa-solid fa-xmark"></i></button>' +
            '</header>' +

            // Deliberately explains HOW IT BEHAVES and not what is left. A
            // visible allowance makes a student ration questions, which is the
            // opposite of what we want; the mechanics are useful, the tally is
            // not. Same reason there is no counter anywhere else.
            '<div id="nia-help" class="nia-help" hidden></div>' +
            '<div id="nia-list" class="nia-list" hidden></div>' +
            '<div id="nia-body" class="nia-body" aria-live="polite"></div>' +
            '<form id="nia-form" class="nia-form" autocomplete="off">' +
            '<textarea id="nia-input" class="nia-input" rows="1" ' +
            'maxlength="1500"></textarea>' +
            '<button id="nia-send" class="nia-send" type="submit" aria-label="Send">' +
            '<i class="fa-solid fa-arrow-up"></i></button>' +
            '</form>' +
            '<p class="nia-foot" id="nia-foot"></p>' +
            '</section>';
        document.body.appendChild(root);
        NIA.mounted = true;
        wire();
        applyRoleCopy();
        checkState();
    }

    function wire() {
        $('nia-fab').addEventListener('click', function () { openPanel(); });
        $('nia-close').addEventListener('click', closePanel);
        $('nia-scrim').addEventListener('click', closePanel);
        $('nia-new').addEventListener('click', newConversation);
        $('nia-hist').addEventListener('click', toggleHistory);
        $('nia-info').addEventListener('click', toggleHelp);
        $('nia-sel-btn').addEventListener('click', askAboutSelection);
        $('nia-form').addEventListener('submit', onSubmit);

        var input = $('nia-input');
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(e); }
        });
        input.addEventListener('input', function () {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 132) + 'px';
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && NIA.open) closePanel();
        });
        document.addEventListener('mouseup', onSelect);
        document.addEventListener('touchend', onSelect);
        window.addEventListener('resize', refreshLauncherVisibility);
    }

    // The role arrives with /state, AFTER mount. Anything role-dependent
    // written into the initial markup shows a teacher the student's words
    // — which is how "Ask about what you are studying" ended up in the
    // teacher portal.
    function applyRoleCopy() {
        var teacher = NIA.role === 'teacher';
        var input = $('nia-input');
        if (input) {
            input.placeholder = teacher
                ? 'Ask how to teach it…'
                : 'Ask about what you are studying…';
        }
        var foot = $('nia-foot');
        if (foot) {
            foot.textContent = teacher
                ? 'Nia can be wrong. Check anything that matters against NCERT.'
                : 'Nia can be wrong. Check anything that matters against NCERT or '
                + 'ask your teacher.';
        }
    }

    async function checkState() {
        try {
            var d = await apiCall('/api/assistant/state');
            NIA.available = !!d.available;
            NIA.name = d.student_name || '';
            NIA.role = d.role === 'teacher' ? 'teacher' : 'student';
            document.body.classList.toggle('nia-teacher', NIA.role === 'teacher');
            applyRoleCopy();
        } catch (e) { NIA.available = false; }
        refreshLauncherVisibility();
        maybeGreet();
    }

    function refreshLauncherVisibility() {
        var fab = $('nia-fab');
        if (!fab) return;
        var show = NIA.available && !inLiveTest();
        fab.hidden = !show;
        if (!show && NIA.open) closePanel();
        var mob = $('nia-mobile-btn');
        if (mob) mob.hidden = !show;
        if (inLiveTest()) hideSelection();
    }

    /* ── greeting ────────────────────────────────────────────────
       Once per session, never per page. A bubble that speaks every time
       the student navigates is one they learn to ignore — and then they
       ignore it when it has something worth saying.
  
       Name only. No scores, no weak concepts: a greeting that opens with
       a number the student disputes costs more trust than it buys, and
       they did not ask for it. */

    function partOfDay() {
        var h = new Date().getHours();
        if (h < 12) return 'Good morning';
        if (h < 17) return 'Good afternoon';
        return 'Good evening';
    }

    function greetedAlready() {
        try { return sessionStorage.getItem('nia_greeted') === '1'; }
        catch (e) { return false; }   // private mode: greet, do not crash
    }

    function markGreeted() {
        try { sessionStorage.setItem('nia_greeted', '1'); } catch (e) { }
    }

    function maybeGreet() {
        if (!NIA.available || !NIA.name || inLiveTest()) return;
        if (greetedAlready() || NIA.open) return;
        markGreeted();
        var bub = document.createElement('div');
        bub.className = 'nia-greet';
        bub.innerHTML = '<span>' + esc(partOfDay()) + ', <b>' +
            esc(NIA.name) + '</b>!</span>' +
            '<button type="button" aria-label="Dismiss">' +
            '<i class="fa-solid fa-xmark"></i></button>';
        $('nia-root').appendChild(bub);
        function go() { if (bub.parentNode) bub.remove(); }
        bub.querySelector('button').addEventListener('click', function (ev) {
            ev.stopPropagation(); go();
        });
        bub.addEventListener('click', function () { go(); openPanel(); });
        setTimeout(go, 7000);
    }

    /* ════════════════════════════════════════════════════════════
       OPEN / CLOSE
       ════════════════════════════════════════════════════════════ */

    function openPanel(seed) {
        if (!NIA.mounted) mount();
        if (inLiveTest()) return;
        // A conversation carries its context blocks forward, which is right
        // WITHIN a surface and wrong across one. Without this, a student who
        // read a Studio concept, then took a test, then opened the review got
        // an answer about the concept they had been reading an hour earlier.
        // Crossing surfaces starts a fresh conversation; the old one is still
        // in the history list.
        if (NIA.convId && NIA.convSurface &&
            NIA.convSurface !== NIA_CTX.surface) {
            newConversation();
        }
        NIA.open = true;
        var g = $('nia-root').querySelector('.nia-greet');
        if (g) g.remove();
        $('nia-panel').hidden = false;
        $('nia-fab').classList.add('is-open');
        // The scrim is a phone behaviour. On a desktop the panel is a docked
        // column beside the work, and dimming the page the student is asking
        // ABOUT would defeat the entire point of the feature.
        $('nia-scrim').hidden = isDesktop();
        document.body.classList.toggle('nia-locked', !isDesktop());
        if (!NIA.messages.length) renderWelcome();
        setSubtitle();
        if (seed) { $('nia-input').value = seed; }
        setTimeout(function () { $('nia-input').focus(); }, 60);
    }
    window.niaOpen = openPanel;

    function closePanel() {
        NIA.open = false;
        $('nia-panel').hidden = true;
        $('nia-scrim').hidden = true;
        $('nia-fab').classList.remove('is-open');
        document.body.classList.remove('nia-locked');
        NIA.listOpen = false;
        $('nia-list').hidden = true;
        $('nia-help').hidden = true;
        $('nia-info').classList.remove('on');
    }

    function setSubtitle() {
        var el = $('nia-sub'); if (!el) return;
        var s = NIA_CTX.surface;
        if (NIA.role === 'teacher') {
            el.textContent = s === 'teacher_student' ? 'Looking at this student'
                : (s === 'teacher_class' || s === 'teacher_concepts') ? 'Looking at your class'
                    : s === 'teacher_question' ? 'Looking at this question'
                        : 'Teaching assistant';
            return;
        }
        if (s === 'studio' && NIA_CTX.concept_name) {
            el.textContent = 'Reading: ' + NIA_CTX.concept_name;
        } else if (s === 'opd_review' || s === 'arena_review') {
            el.textContent = 'Looking at your test review';
        } else {
            el.textContent = 'Naadi Intelligent Assistant';
        }
    }

    function newConversation() {
        NIA.convId = null;
        NIA.convSurface = null;
        NIA.messages = [];
        NIA.listOpen = false;
        $('nia-list').hidden = true;
        setSubtitle();          // the surface may have changed since we opened
        renderWelcome();
        $('nia-input').focus();
    }

    /* ════════════════════════════════════════════════════════════
       RENDER
       ════════════════════════════════════════════════════════════ */

    function renderWelcome() {
        var s = NIA_CTX.surface;
        var hi = NIA.name ? 'Welcome, <b>' + esc(NIA.name) + '</b>. ' : '';
        var line, chips = [];

        if (NIA.role === 'teacher') {
            if (s === 'teacher_student') {
                line = hi + 'I can see this student\'s record. Ask me what they are ' +
                    'struggling with, or how to teach it to them.';
                chips = ['What are their strengths and weaknesses?',
                    'Which concept should I fix first?',
                    'How do I explain that to them?'];
            } else if (s === 'teacher_class' || s === 'teacher_concepts') {
                line = hi + 'I can see how this class is doing. Ask what they are ' +
                    'collectively stuck on, or how to teach it.';
                chips = ['What is this class weakest on?',
                    'How do I explain that concept?',
                    'Draft me a 40-minute lesson plan'];
            } else if (s === 'teacher_question') {
                line = hi + 'I can see this question. Ask why students pick the ' +
                    'wrong option, or how to teach around it.';
                chips = ['Why do they get this wrong?',
                    'How should I teach this at the board?'];
            } else {
                line = hi + 'Ask me how to teach anything in the NEET syllabus — ' +
                    'explanations, analogies, misconceptions, or a lesson plan.';
                chips = ['How do I explain resonance simply?',
                    'Give me an analogy for buffers',
                    'Draft a 40-minute lesson plan'];
            }
            $('nia-body').innerHTML =
                '<div class="nia-welcome"><span class="nia-w-mark" aria-hidden="true">' +
                '<span class="nia-pulse"></span></span><p>' + line + '</p>' +
                '<div class="nia-chips">' + chips.map(function (c) {
                    return '<button type="button" class="nia-chip" data-q="' +
                        esc(c) + '">' + esc(c) + '</button>';
                }).join('') + '</div></div>';
            $('nia-body').querySelectorAll('.nia-chip').forEach(function (b) {
                b.addEventListener('click', function () { send(b.dataset.q); });
            });
            return;
        }

        if (s === 'studio' && NIA_CTX.concept_name) {
            line = hi + 'I can see you are on <b>' + esc(NIA_CTX.concept_name) +
                '</b>. Ask me anything about it — or highlight a line and tap ' +
                '“Ask Nia about this”.';
            chips = ['Explain this simply', 'What does NEET ask from here?',
                'Give me a memory trick'];
        } else if (s === 'opd_review' || s === 'arena_review') {
            var haveQ = !!(NIA_CTX.question && NIA_CTX.question.question_text);
            line = haveQ
                ? 'I can see the question you just answered, which option you ' +
                'picked and which was right. Ask away.'
                : 'Tap <b>Ask Nia about this question</b> on any question below ' +
                'and I\'ll see exactly what you picked. Or just ask me ' +
                'anything about the topic.';
            chips = haveQ
                ? ['Why is my answer wrong?', 'Explain the correct option',
                    'What concept was this testing?']
                : ['Explain this chapter\'s tricky bits'];
        } else {
            line = hi + 'Ask me anything from Physics, Chemistry or Biology. I know ' +
                'what you are reading, so you can just point at it.';
            chips = ['Explain a concept', 'Help me with a numerical'];
        }
        $('nia-body').innerHTML =
            '<div class="nia-welcome"><span class="nia-w-mark" aria-hidden="true">' +
            '<span class="nia-pulse"></span></span>' +
            '<p>' + line + '</p>' +
            (chips.length ? '<div class="nia-chips">' + chips.map(function (c) {
                return '<button type="button" class="nia-chip" data-q="' +
                    esc(c) + '">' + esc(c) + '</button>';
            }).join('') + '</div>' : '') + '</div>';
        $('nia-body').querySelectorAll('.nia-chip').forEach(function (b) {
            b.addEventListener('click', function () { send(b.dataset.q); });
        });
    }

    function addBubble(role, html, cls) {
        var body = $('nia-body');
        if (body.querySelector('.nia-welcome')) body.innerHTML = '';
        var wrap = document.createElement('div');
        wrap.className = 'nia-msg nia-' + role + (cls ? ' ' + cls : '');
        wrap.innerHTML = role === 'assistant'
            ? '<span class="nia-m-mark" aria-hidden="true"></span>' +
            '<div class="nia-m-txt">' + html + '</div>'
            : '<div class="nia-m-txt">' + html + '</div>';
        body.appendChild(wrap);
        body.scrollTop = body.scrollHeight;
        return wrap.querySelector('.nia-m-txt');
    }

    function startStatus(target) {
        var pool = STATUS[NIA_CTX.surface] || STATUS.generic;
        var i = 0;
        target.innerHTML = '<span class="nia-status">' +
            '<span class="nia-dots"><i></i><i></i><i></i></span>' +
            '<span class="nia-status-t">' + esc(pool[0]) + '</span></span>';
        if (reduceMotion() || pool.length < 2) return;
        NIA.statusTimer = setInterval(function () {
            i = (i + 1) % pool.length;
            var t = target.querySelector('.nia-status-t');
            if (t) t.textContent = pool[i];
        }, 2200);
    }

    function stopStatus() {
        if (NIA.statusTimer) { clearInterval(NIA.statusTimer); NIA.statusTimer = null; }
    }

    /* ════════════════════════════════════════════════════════════
       HISTORY
       ════════════════════════════════════════════════════════════ */

    function helpHtml() {
        var teacher = NIA.role === 'teacher';
        return '<h4>How Nia works</h4><dl>' +
            '<dt><i class="fa-solid fa-pen-to-square"></i> New chat</dt>' +
            '<dd>Start one whenever you switch topic. Keeps answers sharp.</dd>' +
            '<dt><i class="fa-solid fa-comments"></i> Follow-ups</dt>' +
            '<dd>Nia reads the last <b>6 messages</b> of this chat, so you can ' +
            'say \u201cwhy?\u201d or \u201cshow me an example\u201d without ' +
            'repeating yourself.</dd>' +
            '<dt><i class="fa-solid fa-shuffle"></i> Mixing topics</dt>' +
            '<dd>You can, but a chat that wanders gets vaguer \u2014 the older ' +
            'messages are still being read. New topic, new chat.</dd>' +
            '<dt><i class="fa-solid fa-clock-rotate-left"></i> Past chats</dt>' +
            '<dd>Everything is saved. Reopen any chat to carry on.</dd>' +
            (teacher
                ? '<dt><i class="fa-solid fa-shield-halved"></i> What Nia can see</dt>' +
                '<dd>Only your own classes and students. Never guardian contact ' +
                'details, and never a student outside your roster.</dd>'
                : '<dt><i class="fa-solid fa-highlighter"></i> Point at something</dt>' +
                '<dd>Highlight any line on the page and tap <b>Ask Nia about ' +
                'this</b>.</dd>' +
                '<dt><i class="fa-solid fa-lock"></i> During a test</dt>' +
                '<dd>Nia is closed. Ask anything once you have submitted.</dd>') +
            '</dl><p class="nia-help-foot">Nia can be wrong. Check anything that ' +
            'matters against NCERT' + (teacher ? '.' : ' or ask your teacher.') +
            '</p><button type="button" id="nia-help-x" class="nia-help-x">' +
            'Got it</button>';
    }

    function toggleHelp() {
        var el = $('nia-help');
        var show = el.hidden;
        // Rendered on open, not at mount: the role arrives with /state, so
        // anything built at mount showed a teacher the student's copy.
        if (show) {
            el.innerHTML = helpHtml();
            $('nia-help-x').addEventListener('click', toggleHelp);
        }
        el.hidden = !show;
        $('nia-info').classList.toggle('on', show);
        if (show) { NIA.listOpen = false; $('nia-list').hidden = true; }
    }

    async function toggleHistory() {
        NIA.listOpen = !NIA.listOpen;
        $('nia-help').hidden = true;
        $('nia-info').classList.remove('on');
        var el = $('nia-list');
        el.hidden = !NIA.listOpen;
        if (!NIA.listOpen) return;
        el.innerHTML = '<div class="nia-list-empty">Loading…</div>';
        try {
            var d = await apiCall('/api/assistant/conversations');
            var rows = d.conversations || [];
            if (!rows.length) {
                el.innerHTML = '<div class="nia-list-empty">Nothing here yet. ' +
                    'Your conversations will show up as you ask.</div>';
                return;
            }
            el.innerHTML = rows.map(function (c) {
                return '<button type="button" class="nia-list-row" data-id="' +
                    esc(c.conv_id) + '"><b>' + esc(c.title) + '</b>' +
                    (c.concept_tag ? '<em>' + esc(c.concept_tag) + '</em>' : '') +
                    '</button>';
            }).join('');
            el.querySelectorAll('.nia-list-row').forEach(function (b) {
                b.addEventListener('click', function () { loadConversation(b.dataset.id); });
            });
        } catch (e) {
            el.innerHTML = '<div class="nia-list-empty">Could not load those. ' +
                'Try again in a moment.</div>';
        }
    }

    async function loadConversation(id) {
        try {
            var d = await apiCall('/api/assistant/conversation/' + id);
            NIA.convId = id;
            // Adopt the surface the thread was STARTED on. Without this,
            // convSurface stayed null after loading from history, the
            // cross-surface reset never fired, and a chat opened while in
            // Arena kept answering with the OPD context it was created with.
            NIA.convSurface = (d.conversation && d.conversation.surface) || null;
            NIA.messages = d.messages || [];
            NIA.listOpen = false;
            $('nia-list').hidden = true;
            $('nia-body').innerHTML = '';
            if (NIA.convSurface && NIA.convSurface !== NIA_CTX.surface) {
                addSoftNote('This chat was about something else. Ask here and ' +
                    'I will answer in that context — or start a new chat for what ' +
                    'is open now.');
            }
            NIA.messages.forEach(function (m) {
                addBubble(m.role === 'assistant' ? 'assistant' : 'user',
                    niaHtml(m.text));
            });
        } catch (e) { /* leave the current thread alone */ }
    }

    /* ════════════════════════════════════════════════════════════
       SELECTION → "Ask Nia about this"
       ════════════════════════════════════════════════════════════ */

    function onSelect() {
        if (!NIA.mounted || inLiveTest() || !NIA.available) return;
        setTimeout(function () {
            var sel = window.getSelection();
            var txt = sel ? String(sel).trim() : '';
            if (txt.length < 12 || txt.length > 1200) return hideSelection();
            if ($('nia-panel').contains(sel.anchorNode)) return hideSelection();
            NIA.pendingSelection = txt;
            var box = $('nia-sel');
            // Positioning is cosmetic. An earlier version bailed out of the
            // whole feature when getBoundingClientRect was unavailable or
            // returned an empty rect — so a layout quirk silently removed a
            // working button. Place it near the selection when we can, and
            // park it above the launcher when we cannot.
            var placed = false;
            try {
                var range = sel.getRangeAt(0);
                if (range && typeof range.getBoundingClientRect === 'function') {
                    var r = range.getBoundingClientRect();
                    if (r && (r.width || r.height || r.top)) {
                        box.style.top = Math.max(8, r.top - 46) + 'px';
                        box.style.left = Math.max(8, Math.min(
                            r.left + r.width / 2 - 90, window.innerWidth - 195)) + 'px';
                        placed = true;
                    }
                }
            } catch (e) { /* fall through to the anchored position */ }
            if (!placed) {
                box.style.top = 'auto';
                box.style.bottom = '96px';
                box.style.left = 'auto';
                box.style.right = '22px';
            } else {
                box.style.bottom = 'auto';
                box.style.right = 'auto';
            }
            box.hidden = false;
        }, 10);
    }

    function hideSelection() {
        var b = $('nia-sel'); if (b) b.hidden = true;
        NIA.pendingSelection = '';
    }

    function askAboutSelection() {
        var txt = NIA.pendingSelection;
        hideSelection();
        if (!txt) return;
        openPanel();
        send('Explain this: "' + txt + '"');
    }

    /* ════════════════════════════════════════════════════════════
       SEND — streaming
       ════════════════════════════════════════════════════════════ */

    function onSubmit(e) {
        if (e && e.preventDefault) e.preventDefault();
        var v = $('nia-input').value.trim();
        if (v) send(v);
    }

    async function send(text) {
        if (NIA.busy || !text) return;
        // Same rule on send, for the case where they navigated with the
        // panel still open.
        if (NIA.convId && NIA.convSurface && NIA.convSurface !== NIA_CTX.surface) {
            NIA.convId = null;
        }
        NIA.convSurface = NIA_CTX.surface;
        NIA.busy = true;
        $('nia-send').disabled = true;
        var input = $('nia-input');
        input.value = ''; input.style.height = 'auto';

        addBubble('user', niaHtml(text));
        var target = addBubble('assistant', '');
        startStatus(target);

        var streamed = false;
        var renderer = null;
        var acc = '';
        // A request that never delivers a token used to leave the status
        // line cycling indefinitely, which reads as a hang with no cause.
        var stall = setTimeout(function () {
            if (!streamed && NIA.busy) {
                stopStatus();
                target.parentElement.classList.add('nia-soft');
                target.textContent = 'Nia is taking longer than usual. '
                    + 'Try asking again.';
            }
        }, 30000);

        try {
            var token = await getToken();
            var res = await fetch(API_BASE + '/api/assistant/ask', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token,
                },
                body: JSON.stringify({
                    text: text, conv_id: NIA.convId, context: NIA_CTX,
                }),
            });

            // A refusal (cap, safety, live test) comes back as ordinary JSON,
            // not a stream. It is not an error state — it is Nia saying no, and
            // it should read like a sentence, not like a failure.
            var ctype = res.headers.get('content-type') || '';
            if (ctype.indexOf('text/event-stream') === -1) {
                var j = await res.json().catch(function () { return {}; });
                stopStatus();
                target.parentElement.classList.add('nia-soft');
                target.innerHTML = niaHtml(j.error || 'Nia is unavailable right now.');
                if (j.code === 'DAY' || j.code === 'MONTH' || j.code === 'LIFETIME' ||
                    j.code === 'PAID_ONLY' || j.code === 'DISABLED') addDoubtsLink(target);
                return;
            }

            var reader = res.body.getReader();
            var dec = new TextDecoder();
            var buf = '';
            while (true) {
                var chunk = await reader.read();
                if (chunk.done) break;
                buf += dec.decode(chunk.value, { stream: true });
                var parts = buf.split('\n\n');
                buf = parts.pop();
                for (var i = 0; i < parts.length; i++) {
                    var line = parts[i].trim();
                    if (line.indexOf('data:') !== 0) continue;
                    var ev;
                    try { ev = JSON.parse(line.slice(5).trim()); } catch (err) { continue; }

                    if (ev.t === 'meta') {
                        NIA.convId = ev.conv_id || NIA.convId;
                    } else if (ev.t === 'token') {
                        if (!streamed) {
                            stopStatus();
                            renderer = makeRenderer(target);
                            streamed = true;
                        }
                        acc += ev.v;
                        // A bug in the renderer must never swallow the answer. If it
                        // throws, fall back to plain text and keep going — the
                        // student still gets what they asked for, and the console
                        // still gets the error.
                        try {
                            renderer.push(acc);
                        } catch (rerr) {
                            console.error('[nia] render failed, falling back:', rerr);
                            renderer = null;
                            target.textContent = acc;
                        }
                        $('nia-body').scrollTop = $('nia-body').scrollHeight;
                    } else if (ev.t === 'done') {
                        stopStatus();
                        try {
                            if (renderer) renderer.finish(ev.html || acc);
                            else target.innerHTML = niaHtml(ev.html || acc);
                            if (acc) addActions(target, text);
                        } catch (ferr) {
                            console.error('[nia] final render failed:', ferr);
                            target.textContent = acc;
                        }
                        if (ev.soft) addSoftNote(ev.soft);
                    } else if (ev.t === 'note') {
                        addSoftNote(ev.v);
                    } else if (ev.t === 'error') {
                        stopStatus();
                        if (!streamed) {
                            target.parentElement.classList.add('nia-soft');
                            if (ev.v === '__RETRY__') {
                                // The server knows exactly what went wrong and has
                                // logged it. Telling the person about token budgets is
                                // noise they cannot act on — give them the one thing
                                // they can do.
                                offerRetry(target, text);
                            } else {
                                target.innerHTML = niaHtml(ev.v);
                            }
                        }
                    }
                }
            }
            if (!streamed && !target.innerHTML) {
                console.warn('[nia] stream ended with no content and no error event');
                target.parentElement.classList.add('nia-soft');
                offerRetry(target, text);
            }
        } catch (err) {
            stopStatus();
            console.error('[nia] ask failed:', err);
            target.parentElement.classList.add('nia-soft');
            target.textContent = streamed
                ? 'The connection dropped mid-answer.'
                : ('Could not reach Nia \u2014 ' + (err && err.message
                    ? err.message : 'check your connection') + '.');
        } finally {
            clearTimeout(stall);
            stopStatus();
            NIA.busy = false;
            $('nia-send').disabled = false;
            $('nia-body').scrollTop = $('nia-body').scrollHeight;
        }
    }
    window.niaAsk = function (q) { openPanel(); if (q) send(q); };

    function offerRetry(target, question) {
        target.innerHTML = '';
        var p = document.createElement('div');
        p.textContent = 'That one did not come through.';
        target.appendChild(p);
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'nia-doubts-link';
        b.innerHTML = '<i class="fa-solid fa-rotate-right"></i> Try again';
        b.addEventListener('click', function () {
            var msg = target.parentElement;
            var acts = msg.nextElementSibling;
            if (acts && acts.classList.contains('nia-acts')) acts.remove();
            msg.remove();
            send(question);
        });
        target.appendChild(b);
    }

    function addSoftNote(text) {
        var n = document.createElement('div');
        n.className = 'nia-note';
        n.textContent = text;
        $('nia-body').appendChild(n);
        $('nia-body').scrollTop = $('nia-body').scrollHeight;
    }

    // A limit that only says no is a wall. A limit that hands the student
    // to a human is a routing decision — and Doubts is the feature schools
    // actually pay for.
    function addDoubtsLink(target) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'nia-doubts-link';
        b.innerHTML = '<i class="fa-solid fa-comments"></i> Ask your teacher';
        b.addEventListener('click', function () {
            closePanel();
            if (typeof navigate === 'function') navigate('doubts');
        });
        target.appendChild(b);
    }

    /* ════════════════════════════════════════════════════════════
       ANSWER ACTIONS — save, or hand it to a human
  
       Neither of these needed a single backend route. Notebooks already
       exist (/api/notes/*), and a student's teachers already resolve
       server-side by CLASS (/api/doubts/*). Escalation reuses the ordinary
       doubt thread, so a teacher sees it in the inbox they already watch.
  
       Note the scope: teachers come from the student's OWN CLASS, not
       their school. doubts_backend resolves that list itself and rejects
       any teacher_uid outside it — so the picker below is a convenience,
       never the security boundary.
       ════════════════════════════════════════════════════════════ */

    // The answer is always read back off the DOM rather than from the
    // accumulated stream buffer. They can differ — the final 'done' event
    // carries the server's sanitised HTML, which is what the student
    // actually saw — and saving or escalating anything else would send a
    // teacher text the student never read.
    function addActions(target, question) {
        if (!target) return;
        var msg = target.parentElement;                 // .nia-msg
        // AFTER the message, not inside it. .nia-msg is a flex ROW holding
        // the avatar and the text; appending a third child made the actions
        // a flex sibling that took its share of the row and squeezed the
        // answer down to a few pixels — one character per line. As a
        // sibling in the scroll container it cannot affect the text at all.
        if (msg.nextElementSibling &&
            msg.nextElementSibling.classList.contains('nia-acts')) return;
        var row = document.createElement('div');
        row.className = 'nia-acts';
        // A teacher has nobody to escalate to, and no student notebooks.
        // Their copy button is the useful one — lesson plans get pasted.
        row.innerHTML = NIA.role === 'teacher'
            ? '<button type="button" class="nia-act" data-a="copy">' +
            '<i class="fa-solid fa-copy"></i> Copy</button>'
            : '<button type="button" class="nia-act" data-a="note">' +
            '<i class="fa-solid fa-bookmark"></i> Save to notebook</button>' +
            '<button type="button" class="nia-act" data-a="teacher">' +
            '<i class="fa-solid fa-chalkboard-user"></i> Still stuck? Ask a teacher</button>';
        msg.parentNode.insertBefore(row, msg.nextSibling);
        var noteBtn = row.querySelector('[data-a="note"]');
        if (noteBtn) noteBtn.addEventListener('click', function () {
            openNoteSheet(question, target);
        });
        var tchBtn = row.querySelector('[data-a="teacher"]');
        if (tchBtn) tchBtn.addEventListener('click', function () {
            openTeacherSheet(question, target);
        });
        var copyBtn = row.querySelector('[data-a="copy"]');
        if (copyBtn) copyBtn.addEventListener('click', function () {
            var txt = plainText(target.innerHTML);
            var done = function () {
                copyBtn.innerHTML = '<i class="fa-solid fa-check"></i> Copied';
                setTimeout(function () {
                    copyBtn.innerHTML = '<i class="fa-solid fa-copy"></i> Copy';
                }, 1800);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(txt).then(done, function () { });
            } else {
                var ta = document.createElement('textarea');
                ta.value = txt; document.body.appendChild(ta); ta.select();
                try { document.execCommand('copy'); done(); } catch (e2) { }
                ta.remove();
            }
        });
    }

    function sheet(title, bodyHtml) {
        var old = $('nia-sheet');
        if (old) old.remove();
        var el = document.createElement('div');
        el.id = 'nia-sheet';
        el.className = 'nia-sheet';
        el.innerHTML =
            '<div class="nia-sheet-card" role="dialog" aria-label="' + esc(title) + '">' +
            '<header><b>' + esc(title) + '</b>' +
            '<button type="button" class="nia-icon" data-x aria-label="Close">' +
            '<i class="fa-solid fa-xmark"></i></button></header>' +
            '<div class="nia-sheet-body">' + bodyHtml + '</div></div>';
        $('nia-panel').appendChild(el);
        function close() { el.remove(); }
        el.querySelector('[data-x]').addEventListener('click', close);
        el.addEventListener('click', function (ev) {
            if (ev.target === el) close();
        });
        return { el: el, close: close };
    }

    /* ── save to notebook ────────────────────────────────────────
       Stores PLAIN TEXT, not the answer's HTML. The notes screens
       render content their own way and were never built to receive
       <sub> tags; leaking markup into them would be a bug in a
       surface Nia does not own. */

    function plainText(html) {
        var d = document.createElement('div');
        d.innerHTML = html;
        return (d.textContent || '').trim();
    }

    async function openNoteSheet(question, target) {
        var s = sheet('Save to notebook', '<p class="nia-sheet-load">Loading…</p>');
        var books = [];
        try {
            var d = await apiCall('/api/notes/notebooks');
            books = d.notebooks || [];
        } catch (e) {
            s.el.querySelector('.nia-sheet-body').innerHTML =
                '<p class="nia-sheet-msg">Could not load your notebooks.</p>';
            return;
        }
        // The backend caps a student at 6 notebooks and returns 400 past
        // that. Finding out by failing mid-save is a poor first experience,
        // so the option is simply not offered at the ceiling.
        var full = books.length >= 6;
        s.el.querySelector('.nia-sheet-body').innerHTML =
            (books.length
                ? '<div class="nia-nb-list">' + books.map(function (b) {
                    return '<button type="button" class="nia-nb" data-id="' +
                        esc(b.notebook_id) + '"><i class="fa-solid fa-book"></i>' +
                        '<span>' + esc(b.title || 'Notebook') + '</span>' +
                        '<em>' + (b.notes_count || 0) + '</em></button>';
                }).join('') + '</div>'
                : '<p class="nia-sheet-msg">No notebooks yet — make your first one.</p>') +
            (full
                ? '<p class="nia-sheet-msg small">You have all 6 notebooks. Save ' +
                'into one of them.</p>'
                : '<div class="nia-nb-new"><input id="nia-nb-title" ' +
                'placeholder="New notebook name" maxlength="40">' +
                '<button type="button" id="nia-nb-add">Create</button></div>');

        async function save(notebookId) {
            try {
                await apiCall('/api/notes/add', 'POST', {
                    notebook_id: notebookId,
                    content: plainText(target.innerHTML),
                    annotation: String(question || '').slice(0, 200),
                    source_chapter: NIA_CTX.chapter_id || '',
                    color_tag: 'general'
                });
                s.close();
                addSoftNote('Saved to your notebook.');
            } catch (e) {
                s.el.querySelector('.nia-sheet-body').innerHTML =
                    '<p class="nia-sheet-msg">Could not save — ' +
                    esc(e.message || 'try again') + '.</p>';
            }
        }

        s.el.querySelectorAll('.nia-nb').forEach(function (b) {
            b.addEventListener('click', function () { save(b.dataset.id); });
        });
        var add = $('nia-nb-add');
        if (add) add.addEventListener('click', async function () {
            var t = ($('nia-nb-title').value || '').trim();
            if (!t) return;
            add.disabled = true;
            try {
                var r = await apiCall('/api/notes/notebooks', 'POST',
                    { title: t, type: 'custom' });
                await save(r.notebook_id || (r.notebook || {}).notebook_id);
            } catch (e) {
                add.disabled = false;
                s.el.querySelector('.nia-sheet-body').innerHTML =
                    '<p class="nia-sheet-msg">Could not create that notebook.</p>';
            }
        });
    }

    /* ── escalate to a teacher ───────────────────────────────────
       Creates an ordinary doubt thread, so it lands in the inbox the
       teacher already watches. The transcript goes in as the opening
       message with the student's own words LAST, because that is the
       part the teacher needs to read first. */

    async function openTeacherSheet(question, target) {
        var s = sheet('Ask a teacher', '<p class="nia-sheet-load">Loading…</p>');
        var teachers = [];
        try {
            var d = await apiCall('/api/doubts/teachers');
            teachers = d.teachers || [];
            if (!d.approved) {
                s.el.querySelector('.nia-sheet-body').innerHTML =
                    '<p class="nia-sheet-msg">You are not in an approved class yet, ' +
                    'so there is no teacher to write to.</p>';
                return;
            }
        } catch (e) {
            s.el.querySelector('.nia-sheet-body').innerHTML =
                '<p class="nia-sheet-msg">Could not load your teachers.</p>';
            return;
        }
        if (!teachers.length) {
            s.el.querySelector('.nia-sheet-body').innerHTML =
                '<p class="nia-sheet-msg">No teachers are attached to your class ' +
                'yet.</p>';
            return;
        }

        // Nudge the subject teacher for the chapter to the top. The chapter
        // id starts with the subject, e.g. "Chemistry_11_...".
        var subj = String(NIA_CTX.chapter_id || '').split('_')[0].toLowerCase();
        if (subj) {
            teachers.sort(function (a, b) {
                var am = (a.subjects || []).join(' ').toLowerCase().indexOf(subj) >= 0;
                var bm = (b.subjects || []).join(' ').toLowerCase().indexOf(subj) >= 0;
                return (bm ? 1 : 0) - (am ? 1 : 0);
            });
        }

        s.el.querySelector('.nia-sheet-body').innerHTML =
            '<p class="nia-sheet-msg small">Your question and what Nia said go ' +
            'across with it, so your teacher can see what you already tried.</p>' +
            '<div class="nia-tch-list">' + teachers.map(function (t, i) {
                return '<button type="button" class="nia-tch' + (i === 0 ? ' on' : '') +
                    '" data-uid="' + esc(t.uid) + '">' +
                    '<span class="nia-tch-av">' + esc(t.initials || 'T') + '</span>' +
                    '<span class="nia-tch-txt"><b>' + esc(t.name) + '</b>' +
                    '<em>' + esc(t.subject || t.role || '') + '</em></span></button>';
            }).join('') + '</div>' +
            '<textarea id="nia-tch-msg" rows="2" maxlength="600" ' +
            'placeholder="What still is not clear? (optional)"></textarea>' +
            '<button type="button" id="nia-tch-send" class="nia-sheet-go">' +
            'Send to teacher</button>';

        var picked = teachers[0].uid;
        s.el.querySelectorAll('.nia-tch').forEach(function (b) {
            b.addEventListener('click', function () {
                picked = b.dataset.uid;
                s.el.querySelectorAll('.nia-tch').forEach(function (x) {
                    x.classList.toggle('on', x === b);
                });
            });
        });

        $('nia-tch-send').addEventListener('click', async function () {
            var btn = $('nia-tch-send');
            btn.disabled = true;
            // doubts_backend caps a message at 2000 chars. Build to fit rather
            // than let the server silently truncate mid-sentence.
            var mine = ($('nia-tch-msg').value || '').trim();
            var a = plainText(target ? target.innerHTML : '');
            var head = 'I asked Nia: ' + String(question || '').slice(0, 300);
            var tail = mine ? '\n\nWhat I still do not get: ' + mine.slice(0, 400) : '';
            var room = 1900 - head.length - tail.length;
            var body = '\n\nNia said: ' + (a.length > room ? a.slice(0, room) + '…' : a);
            try {
                await apiCall('/api/doubts/thread', 'POST',
                    { teacher_uid: picked, text: head + body + tail });
                s.close();
                addSoftNote('Sent. Your teacher will see it in Doubts.');
            } catch (e) {
                btn.disabled = false;
                s.el.querySelector('.nia-sheet-body').innerHTML =
                    '<p class="nia-sheet-msg">Could not send — ' +
                    esc(e.message || 'try again') + '.</p>';
            }
        });
    }

    /* ════════════════════════════════════════════════════════════
       BOOT
       ════════════════════════════════════════════════════════════ */

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
    } else {
        mount();
    }

    // Exposed for the verification suite. The incremental formatter is the
    // trickiest part of this file and deserves direct unit tests, not only
    // assertions on rendered output.
    window.NIA_DEBUG = NIA;
    window.NIA_DEBUG.makeRenderer = makeRenderer;
})();