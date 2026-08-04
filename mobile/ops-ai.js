/* ════════════════════════════════════════════════════════════════
   NAADI AI — ADMIN: NIA COST (ops-ai.js)

   A separate module rather than another branch inside ops.js, for the
   same reason teacher_class.py is its own file: ops.js is already 1,300
   lines and a screen that will grow (per-key health, per-school, budget
   alerts) should not grow inside it.

   THE ONE RULE: every number on this screen comes from a rollup that was
   written at call time. Nothing here scans ai_calls. At 50k logged calls
   a scan is 50k reads — about ₹2.60 — every single time somebody taps
   refresh, which is more than a student spends on Nia in a year. A cost
   dashboard that costs more than the thing it measures is worse than no
   dashboard.
   ════════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    var AI = { data: null, students: null, tab: 'students', days: 30 };

    function $$(id) { return document.getElementById(id); }
    function inr(v) { return '₹' + (Number(v) || 0).toFixed(2); }
    function inr4(v) { return '₹' + (Number(v) || 0).toFixed(4); }
    function num(v) { return (Number(v) || 0).toLocaleString('en-IN'); }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /* ── entry point. ops.js calls this from renderScreen(). ────── */
    window.renderAiCost = async function () {
        var el = $$('adm-screen-aicost');
        if (!el) return;
        el.innerHTML = '<div class="adm-skel">Loading Nia usage…</div>';
        try {
            var r = await Promise.all([
                apiCall('/api/admin/ai/overview?days=' + AI.days),
                apiCall('/api/admin/ai/students'),
            ]);
            AI.data = r[0];
            AI.students = r[1];
        } catch (e) {
            el.innerHTML = '<div class="adm-empty"><h3>Could not load</h3><p>' +
                esc(e.message || '') + '</p></div>';
            return;
        }
        paint(el);
    };

    function paint(el) {
        var d = AI.data, s = AI.students;
        var c = d.config || {};
        var students = s.student_count || 0;
        var avg = students ? (s.students || []).reduce(function (a, r) {
            return a + (r.life_cost || 0);
        }, 0) / students : 0;

        el.innerHTML =
            kpis(d, students, avg) +
            configCard(c) +
            trendCard(d) +
            keysCard(d) +
            tablesCard(s);

        wire(el);
        drawTrend(d.trend || []);
    }

    /* ── KPIs ───────────────────────────────────────────────────── */
    function kpis(d, students, avg) {
        function k(v, label, cls) {
            return '<div class="adm-kpi"><div class="adm-kpi-v ' + (cls || '') +
                '">' + v + '</div><div class="adm-kpi-k">' + label + '</div></div>';
        }
        // A projected annual figure is the number that actually decides
        // whether the feature is affordable, so it is shown next to the raw
        // spend rather than left for someone to work out.
        var perYear = avg > 0 ? avg : 0;
        return '<div class="adm-kpis">' +
            k(inr(d.today_cost), 'Spent today') +
            k(inr(d.month_cost), 'This month') +
            k(inr(d.window_cost), 'Last ' + d.window_days + ' days') +
            k(num(d.calls), 'API calls') +
            k(inr4(d.avg_cost_per_call), 'Avg per call') +
            k(d.cache_hit_pct + '%', 'Cache hit rate',
                d.cache_hit_pct >= 40 ? 'good' : 'warn') +
            k(num(students), 'Students using Nia') +
            k(inr(perYear), 'Avg spend / student') +
            (d.errors ? k(num(d.errors), 'Errors', 'bad') : '') +
            '</div>';
    }

    /* ── config: the kill switch lives here ─────────────────────── */
    function configCard(c) {
        function toggle(id, on, label, note) {
            return '<label class="adm-ai-toggle"><input type="checkbox" id="' + id +
                '" ' + (on ? 'checked' : '') + '><span class="adm-ai-tg"></span>' +
                '<span class="adm-ai-tl"><b>' + label + '</b><em>' + note +
                '</em></span></label>';
        }
        function cap(id, val, label) {
            return '<div class="adm-ai-cap"><label for="' + id + '">' + label +
                '</label><input class="adm-input" type="number" min="0" id="' + id +
                '" value="' + (val || 0) + '"></div>';
        }
        return '<div class="adm-card"><h3 class="adm-card-t">Controls</h3>' +
            '<div class="adm-ai-toggles">' +
            toggle('ai-enabled', c.enabled !== false, 'Nia is on',
                'Turn this off to stop all assistant spend immediately. ' +
                'OPD interventions are unaffected.') +
            toggle('ai-paid', !!c.paid_only, 'Premium students only',
                'Free-plan students are pointed to their teachers instead.') +
            '</div><div class="adm-ai-caps">' +
            cap('ai-daily', c.daily_cap, 'Conversations / day') +
            cap('ai-monthly', c.monthly_cap, 'Conversations / month') +
            cap('ai-lifetime', c.lifetime_cap, 'Conversations / lifetime') +
            cap('ai-msgs', c.daily_messages, 'Messages / day (backstop)') +
            cap('ai-tmsgs', c.teacher_monthly_messages, 'Teacher messages / month') +
            cap('ai-maxtok', c.max_tokens, 'Max tokens per answer') +
            '</div>' +
            '<p class="adm-ai-hint"><b>Conversations / day</b> counts new topics. ' +
            'Follow-ups inside a topic are free, so an explanation is never cut ' +
            'off half way. <b>Messages / day</b> is the backstop that makes the ' +
            'first number meaningful \u2014 set it high enough that no honest ' +
            'student reaches it. Students never see a counter; they hear about ' +
            'a cap only when they reach one, and are pointed at Doubts. ' +
            '<b>Teachers</b> have no daily cap at all \u2014 one who hits a limit ' +
            'mid lesson-prep is a support ticket \u2014 only the monthly ceiling ' +
            'above, set high enough to be a tripwire rather than a limit.</p>' +
            '<button class="adm-btn" id="ai-save">Save controls</button>' +
            '<span id="ai-saved" class="adm-ai-saved hidden">Saved</span></div>';
    }

    /* ── trend ──────────────────────────────────────────────────── */
    function trendCard(d) {
        return '<div class="adm-card"><h3 class="adm-card-t">Daily spend' +
            '<span class="adm-card-s">last ' + d.window_days + ' days · ' +
            '₹ per USD ' + d.usd_inr + '</span></h3>' +
            '<div class="adm-ai-trend" id="ai-trend"></div></div>';
    }

    function drawTrend(rows) {
        var el = $$('ai-trend'); if (!el) return;
        if (!rows.length) { el.innerHTML = '<p class="adm-ai-hint">No usage yet.</p>'; return; }
        var max = Math.max.apply(null, rows.map(function (r) { return r.cost_inr; }));
        max = max || 0.0001;
        el.innerHTML = '<div class="adm-ai-bars">' + rows.map(function (r) {
            var h = Math.max(2, Math.round((r.cost_inr / max) * 100));
            return '<div class="adm-ai-bar" title="' + esc(r.date) + ' — ' +
                inr4(r.cost_inr) + ' (' + r.calls + ' calls)">' +
                '<i style="height:' + h + '%"></i></div>';
        }).join('') + '</div>' +
            '<div class="adm-ai-axis"><span>' + esc(rows[0].date) + '</span>' +
            '<span>' + esc(rows[rows.length - 1].date) + '</span></div>';
    }

    /* ── key health ─────────────────────────────────────────────── */
    function keysCard(d) {
        var keys = d.keys || [];
        if (!keys.length) {
            return '<div class="adm-card"><h3 class="adm-card-t">API keys</h3>' +
                '<p class="adm-ai-hint">No DeepSeek key configured — Nia will ' +
                'return a configuration error until one is set.</p></div>';
        }
        var max = Math.max.apply(null, keys.map(function (k) { return k.cost_inr; })) || 0.0001;
        return '<div class="adm-card"><h3 class="adm-card-t">API keys' +
            '<span class="adm-card-s">' + keys.length + ' in pool · ' +
            'spend since last restart</span></h3><div class="adm-twrap">' +
            '<table class="adm-table"><thead><tr><th>Key</th><th>Spend</th>' +
            '<th>Calls</th><th>Errors</th><th>Last</th><th>State</th></tr></thead><tbody>' +
            keys.map(function (k) {
                var w = Math.round((k.cost_inr / max) * 100);
                return '<tr><td class="adm-t-main">#' + k.key_index + '</td>' +
                    '<td><span class="adm-ai-kbar"><i style="width:' + w + '%"></i></span> ' +
                    inr4(k.cost_inr) + '</td><td class="adm-num">' + num(k.calls) +
                    '</td><td class="adm-num">' + num(k.errors) + '</td>' +
                    '<td>' + (k.last_ms ? k.last_ms + ' ms' : '—') + '</td><td>' +
                    (k.cooling ? '<span class="adm-pill warn">Cooling</span>'
                        : k.in_use ? '<span class="adm-pill info">In use</span>'
                            : '<span class="adm-pill good">Ready</span>') +
                    '</td></tr>';
            }).join('') + '</tbody></table></div></div>';
    }

    /* ── students / classes / schools ───────────────────────────── */
    function tablesCard(s) {
        return '<div class="adm-card"><h3 class="adm-card-t">Who is spending' +
            '<span class="adm-card-s">sorted by lifetime spend</span></h3>' +
            '<div class="adm-toolbar">' +
            ['students', 'classes', 'schools'].map(function (t) {
                return '<button class="adm-chip ' + (AI.tab === t ? 'on' : '') +
                    '" data-aitab="' + t + '">' + t[0].toUpperCase() + t.slice(1) +
                    '</button>';
            }).join('') + '</div>' +
            '<div id="ai-table">' + table(s) + '</div></div>';
    }

    function table(s) {
        if (AI.tab === 'classes' || AI.tab === 'schools') {
            var rows = AI.tab === 'classes' ? (s.classes || []) : (s.schools || []);
            var head = AI.tab === 'classes' ? 'Class' : 'School';
            if (!rows.length) return '<p class="adm-ai-hint">Nothing yet.</p>';
            return '<div class="adm-twrap"><table class="adm-table"><thead><tr>' +
                '<th>' + head + '</th><th>Students</th><th>Conversations</th>' +
                '<th>Total</th><th>Avg / student</th></tr></thead><tbody>' +
                rows.map(function (r) {
                    return '<tr><td class="adm-t-main">' +
                        esc(r.class_id || r.school_id || '—') + '</td>' +
                        '<td class="adm-num">' + num(r.students) + '</td>' +
                        '<td class="adm-num">' + num(r.life_convos) + '</td>' +
                        '<td class="adm-num">' + inr(r.life_cost) + '</td>' +
                        '<td class="adm-num">' + inr(r.avg_per_student) + '</td></tr>';
                }).join('') + '</tbody></table></div>';
        }
        var rows2 = s.students || [];
        if (!rows2.length) return '<p class="adm-ai-hint">No student has used Nia yet.</p>';
        return '<div class="adm-twrap"><table class="adm-table"><thead><tr>' +
            '<th>Student</th><th>Today</th><th>Month</th><th>Lifetime</th>' +
            '<th>Spend</th><th>Flags</th></tr></thead><tbody>' +
            rows2.map(function (r) {
                return '<tr class="click" data-uid="' + esc(r.uid) + '">' +
                    '<td><div class="adm-t-main">' + esc(r.name || 'Student') + '</div>' +
                    '<div class="adm-t-sub">' + esc(r.class_id || '—') + ' · ' +
                    esc(r.plan || 'free') + '</div></td>' +
                    '<td class="adm-num">' + num(r.day_convos) + '</td>' +
                    '<td class="adm-num">' + num(r.month_convos) + '</td>' +
                    '<td class="adm-num">' + num(r.life_convos) + '</td>' +
                    '<td class="adm-num">' + inr(r.life_cost) + '</td>' +
                    '<td>' + (r.flags ? '<span class="adm-pill bad">' + r.flags +
                        '</span>' : '—') + '</td></tr>';
            }).join('') + '</tbody></table></div>';
    }

    /* ── wiring ─────────────────────────────────────────────────── */
    function wire(el) {
        el.querySelectorAll('[data-aitab]').forEach(function (b) {
            b.addEventListener('click', function () {
                AI.tab = b.dataset.aitab;
                el.querySelectorAll('[data-aitab]').forEach(function (x) {
                    x.classList.toggle('on', x.dataset.aitab === AI.tab);
                });
                $$('ai-table').innerHTML = table(AI.students);
                bindRows(el);
            });
        });
        bindRows(el);

        var save = $$('ai-save');
        if (save) save.addEventListener('click', async function () {
            save.disabled = true;
            try {
                var body = {
                    enabled: $$('ai-enabled').checked,
                    paid_only: $$('ai-paid').checked,
                    daily_cap: +$$('ai-daily').value,
                    monthly_cap: +$$('ai-monthly').value,
                    lifetime_cap: +$$('ai-lifetime').value,
                    daily_messages: +$$('ai-msgs').value,
                    teacher_monthly_messages: +$$('ai-tmsgs').value,
                    max_tokens: +$$('ai-maxtok').value,
                };
                var r = await apiCall('/api/admin/ai/config', 'POST', body);
                AI.data.config = r.config;
                var tag = $$('ai-saved');
                tag.classList.remove('hidden');
                setTimeout(function () { tag.classList.add('hidden'); }, 2200);
            } catch (e) {
                alert('Could not save: ' + (e.message || ''));
            } finally { save.disabled = false; }
        });
    }

    function bindRows(el) {
        el.querySelectorAll('tr.click[data-uid]').forEach(function (tr) {
            tr.addEventListener('click', function () { drill(tr.dataset.uid); });
        });
    }

    async function drill(uid) {
        var d;
        try { d = await apiCall('/api/admin/ai/student/' + uid); }
        catch (e) { alert('Could not load that student.'); return; }
        var b = d.budget || {};
        var html = '<div class="adm-ai-drill"><h4>Nia usage</h4>' +
            '<div class="adm-kpis">' +
            '<div class="adm-kpi"><div class="adm-kpi-v">' + num(b.day_convos) +
            '</div><div class="adm-kpi-k">Today</div></div>' +
            '<div class="adm-kpi"><div class="adm-kpi-v">' + num(b.month_convos) +
            '</div><div class="adm-kpi-k">This month</div></div>' +
            '<div class="adm-kpi"><div class="adm-kpi-v">' + num(b.life_convos) +
            '</div><div class="adm-kpi-k">Lifetime</div></div>' +
            '<div class="adm-kpi"><div class="adm-kpi-v">' + inr(b.life_cost) +
            '</div><div class="adm-kpi-k">Total spend</div></div></div>' +
            '<h4>Recent conversations</h4>' +
            ((d.conversations || []).length
                ? '<div class="adm-twrap"><table class="adm-table"><thead><tr>' +
                '<th>Question</th><th>Topic</th><th>Msgs</th><th>Cost</th>' +
                '</tr></thead><tbody>' + d.conversations.map(function (c) {
                    return '<tr><td class="adm-t-main">' + esc(c.title) + '</td>' +
                        '<td>' + esc(c.concept_tag || '—') + '</td>' +
                        '<td class="adm-num">' + num(c.msg_count) + '</td>' +
                        '<td class="adm-num">' + inr4(c.cost_inr) + '</td></tr>';
                }).join('') + '</tbody></table></div>'
                : '<p class="adm-ai-hint">No conversations.</p>') + '</div>';

        // Reuse whatever sheet ops.js already provides; fall back to inline.
        if (typeof window.admSheet === 'function') window.admSheet(html);
        else {
            var host = $$('ai-table');
            if (host) host.insertAdjacentHTML('afterbegin', html);
        }
    }
})();