"""
NAADI AI — TEACHER PORTAL · STUDENTS TAB, PAGE 1  (teacher_students.py)
═══════════════════════════════════════════════════════════════════════════

THE ROSTER. Every student in the class, exhaustively, in the same words
Home and Class already use.

───────────────────────────────────────────────────────────────────────────
WHY EVERY ROUTE HERE SITS UNDER /v2/

teacher_backend.py already owns:

    /api/teacher/class/<key>/roster
    /api/teacher/class/<key>/export.csv

Flask does not raise on a duplicate rule. It resolves to whichever
blueprint registered first, returns 200, and serves the other payload.
That failure is silent and it has cost this project days. Every rule in
this file is namespaced, and register_student_routes() asserts it at
import time rather than trusting the next person to remember.

───────────────────────────────────────────────────────────────────────────
THE VOCABULARY IS NOT NEGOTIABLE

Home and Class shipped with these words. This page uses the same ones and
introduces none of its own:

    "Getting right"          correct / seen, gated          (was: Accuracy)
    "How far through"        concepts done / in scope       (was: Coverage)
    "days quiet"             since last_active_at           (was: Inactive Nd)
    "haven't answered enough yet"   below the sample floor
    "haven't started"               zero questions
    finished / testing now / read only / not started   chapter states
    "Needs you today"        has at least one flag
    "Doing well"             no flags, past the floors

Retention is never named. When it fires it is a sentence, produced by
teacher_signals.py, and it reads "Got 6 questions right, then got the
same ideas wrong when asked again later."

───────────────────────────────────────────────────────────────────────────
THE COVERAGE BUG THIS FILE FIXES

teacher_backend._student_metrics() computes coverage as

    sum(per_chapter[*].concepts_attempted) / sum(per_chapter[*].concepts_total)

and per_chapter only contains chapters the student has STARTED. A student
four chapters into eighty-three therefore reports 100% coverage. That is
the exact mirror of the overall_mastery bug: mastery counted untouched
chapters as zero and made a healthy class look like it was failing;
coverage counted them as nonexistent and makes a barely-started student
look finished.

Here the denominator is the syllabus IN SCOPE, and scope depends on who
is looking:

    class teacher    every chapter for the class's year(s)
    subject teacher  only the chapters in the subjects they declared

So a Biology teacher never sees a Physics-shaped hole in a number they
cannot act on, and the class teacher always does.

───────────────────────────────────────────────────────────────────────────
COST

One _roster() call — 50 document reads — plus one cached chapter_meta().
Every other number on this page is already on the rollup. The enriched
roster costs exactly what the old four-column one cost.
"""

import csv
import io

from flask import Blueprint, Response, jsonify, request
from firebase_admin import firestore

from portal_backend import (
    _db, chapter_meta, require_auth, require_role,
    _days_since, _ist_today,
)
from teacher_backend import (
    _roster, _acc, _teacher_pairs, resolve_class, MIN_SAMPLE,
)
from teacher_home import class_role_for
from teacher_signals import (
    flags_for, class_pace_median, canon_subject,
)

students_bp = Blueprint("teacher_students", __name__)

# A student needs to have been asked this many questions before the
# roster will place them in a performance group at all. Same floor the
# rest of the portal uses; imported rather than redeclared so it can
# never drift.
MIN_Q = MIN_SAMPLE

# Below this many days a "quiet" student is just a student who did not
# study on a Sunday.
QUIET_DAYS = 7

# Trend needs a real accuracy at BOTH ends. A student who crossed the
# sample floor this week has not "improved by 40 points"; they have
# simply become measurable.
TREND_MIN_DELTA = 2.0


# ═══════════════════════════════════════════════════════════════════════
# SCOPE — which chapters count, for this teacher
# ═══════════════════════════════════════════════════════════════════════

def _class_levels(roster):
    """The school years actually present in this class.

    Read from the students rather than from the class document: a 12-A
    section occasionally carries a repeating 11th student, and scoping
    their coverage against the 12th syllabus would report them as
    hopelessly behind when they are exactly where they should be.
    """
    out = set()
    for r in roster:
        lv = str(r.get("class_level", "") or "").strip()
        if lv:
            out.add(lv)
    return out


def build_scope(meta, roster, subjects=None):
    """The chapters this teacher's numbers are measured against.

    Returns {chapter_ids: set, concepts: int, chapters: int,
             subjects: [str], by_subject: {sub: {chapters, concepts}}}

    subjects=None or []  →  everything (class teacher)
    subjects=["Biology"] →  Biology only (subject teacher)
    """
    levels = _class_levels(roster)
    want = {canon_subject(s) for s in (subjects or [])}

    ids, concepts = set(), 0
    by_subject = {}
    for cid, m in (meta or {}).items():
        sub = canon_subject(m.get("subject"))
        if want and sub not in want:
            continue
        # An empty level set means we could not tell — count everything
        # rather than silently scoping to nothing.
        lvl = str(m.get("class", "") or "").strip()
        if levels and lvl and lvl not in levels:
            continue
        n = int(m.get("total_concepts", 0) or 0)
        ids.add(cid)
        concepts += n
        b = by_subject.setdefault(sub, {"chapters": 0, "concepts": 0})
        b["chapters"] += 1
        b["concepts"] += n

    return {
        "chapter_ids": ids,
        "chapters": len(ids),
        "concepts": concepts,
        "subjects": sorted(by_subject.keys()),
        "by_subject": by_subject,
    }


# ═══════════════════════════════════════════════════════════════════════
# THE TWO NUMBERS
# ═══════════════════════════════════════════════════════════════════════

def getting_right(r, scope):
    """Correct / seen, restricted to chapters in scope. Gated.

    Returns (pct_or_None, questions_seen). None is a real answer and the
    client renders it as "not enough answered yet", never as 0%.
    """
    per_con = r.get("per_concept", {}) or {}
    ids = scope["chapter_ids"]
    seen = 0
    correct = 0.0
    for c in per_con.values():
        if ids and c.get("c") and c["c"] not in ids:
            continue
        s = int(c.get("s", 0) or 0)
        if not s:
            continue
        seen += s
        # per_concept.m is a percentage. Weight by questions seen rather
        # than averaging percentages built on wildly different samples.
        correct += (c.get("m", 0) or 0) / 100.0 * s
    return _acc(correct, seen), seen


def how_far_through(r, scope):
    """Mean of per_chapter.coverage_pct across the chapters IN SCOPE,
    with chapters the student has never opened counted as zero.

    THIS IS THE SAME ARITHMETIC THE CLASS TAB USES (teacher_class.py,
    _subject_rows). Deliberately, byte for byte in spirit: a teacher who
    reads 66% on the Class tab and something else on this row stops
    trusting both screens, and she is right to.

    It replaces a version that summed per_chapter.concepts_attempted over
    chapter_metadata.total_concepts. That looked more principled and was
    wrong twice over:

      * per_chapter.coverage_pct is computed against `len(cm_all)` --
        the concepts THAT STUDENT has been served -- not against the
        chapter's declared size. The two denominators disagree, so the
        sum could exceed the metadata total and clamp to a flat 100%.
      * chapter_metadata.total_concepts is stale on several chapters,
        and a denominator nobody maintains is not a denominator.

    A consequence worth stating plainly: because coverage_pct measures
    against what the student was served, a touched chapter tends toward
    100% and the real signal in this number is HOW MANY CHAPTERS have
    been opened at all. That is exactly why untouched chapters must
    count as zero -- they are the only thing keeping the number honest.
    """
    per_ch = r.get("per_chapter", {}) or {}
    ids = scope["chapter_ids"]
    if not ids:
        return None, 0, 0

    covs = []
    touched = 0
    for cid in ids:
        ch = per_ch.get(cid)
        if not ch:
            covs.append(0.0)          # never opened -- counts, as zero
            continue
        covs.append(float(ch.get("coverage_pct", 0) or 0))
        touched += 1

    pct = round(sum(covs) / len(covs), 1) if covs else None
    return pct, touched, len(ids)


def chapter_states(r, scope):
    """finished · testing now · read only · not started.

    The same four states, in the same order, with the same words as the
    subject bar on Home (thSubjectCards) and the chapter rows on Class.
    A teacher learns this vocabulary once.
    """
    per_ch = r.get("per_chapter", {}) or {}
    studio = ((r.get("signals") or {}).get("studio_by_chapter") or {})
    ids = scope["chapter_ids"]

    finished = testing = read_only = 0
    seen_ids = set()

    for cid in (ids or set(per_ch.keys()) | set(studio.keys())):
        pc = per_ch.get(cid) or {}
        tested = int(pc.get("tests", 0) or 0) > 0 or \
            int(pc.get("concepts_attempted", 0) or 0) > 0
        read = float(studio.get(cid, 0) or 0) > 0
        if pc.get("complete"):
            finished += 1
            seen_ids.add(cid)
        elif tested:
            testing += 1
            seen_ids.add(cid)
        elif read:
            read_only += 1
            seen_ids.add(cid)

    total = scope["chapters"] or len(seen_ids)
    not_started = max(0, total - len(seen_ids))
    return {
        "finished": finished,
        "testing": testing,
        "read_only": read_only,
        "not_started": not_started,
        "total": total,
    }


def trend_7d(r, current_pct):
    """Change in "getting right" over a week, or None.

    Gated at both ends. accuracy_7d_ago is written by the nightly job
    from the mastery_history subcollection; a student with no history,
    or one who only crossed the sample floor this week, has no trend and
    must not be shown an arrow. The old roster drew this arrow from
    overall_mastery — the blended metric — inside the accuracy column,
    so it read as an accuracy delta and was not one.
    """
    if current_pct is None:
        return None
    prev = r.get("accuracy_7d_ago")
    if prev is None:
        return None
    d = round(current_pct - float(prev), 1)
    return d if abs(d) >= TREND_MIN_DELTA else 0.0


# ═══════════════════════════════════════════════════════════════════════
# ONE ROW
# ═══════════════════════════════════════════════════════════════════════

def _group_of(flags, pct, seen, tests):
    """Which of the three groups this student belongs in.

    Order matters and it is not "worst score first". A flagged student
    is flagged whatever their score; an unmeasurable student is not a
    weak student and must never be sorted into the bottom of the class,
    which is precisely what the old accuracy sort did to every new
    joiner in week one.
    """
    if flags:
        return "needs_you"
    if not tests and not seen:
        return "not_started"
    if pct is None:
        return "not_enough"
    return "fine"


def _row(r, ctx, scope, pairs, today):
    flags = flags_for(r, ctx)
    top = flags[0] if flags else None

    pct, seen = getting_right(r, scope)
    far, chapters_started, chapters_in_scope = how_far_through(r, scope)
    states = chapter_states(r, scope)
    quiet = _days_since(r.get("last_active_at", ""))
    tests = int(r.get("tests_completed", 0) or 0)

    sig = r.get("signals") or {}
    recent = sig.get("recent_tests") or []
    last_test = recent[0].get("at", "") if recent else ""

    arena = sig.get("arena_best") or {}
    best_marks = arena.get("marks") if isinstance(arena, dict) else None

    p = pairs.get(r["uid"]) or {}
    nxt = p.get("next_followup") or ""

    return {
        "uid": r["uid"],
        "roll_no": r.get("roll_no", ""),
        "name": r.get("name", "Student"),
        "initials": r.get("initials", "?"),
        "photo_url": r.get("photo_url", ""),

        # The sentence. Never a badge, never a score.
        "reason": top["text"] if top else "",
        "reason_kind": top["kind"] if top else "",
        "reason_subject": top["subject"] if top else "",
        "severity": top["severity"] if top else 0,
        "other_reasons": [f["text"] for f in flags[1:3]],
        "flag_count": len(flags),
        "flag_kinds": [f["kind"] for f in flags],
        "share_text": top.get("share", "") if top else "",

        "getting_right": pct,
        "questions_answered": seen,
        "trend_7d": trend_7d(r, pct),

        "how_far_through": far,
        "chapters_started": chapters_started,
        "chapters_in_scope": chapters_in_scope,

        "chapters": states,

        "tests": tests,
        "last_test_at": last_test,
        "days_quiet": quiet,
        "best_paper_marks": best_marks,
        "papers_attempted": int(r.get("arena_papers_attempted", 0) or 0),

        "notes": len(p.get("entries") or []),
        "followup_at": nxt,
        "followup_due": bool(nxt and nxt <= today),
        "snoozed": (p.get("snooze_until") or "") > today,

        "group": _group_of(flags, pct, seen, tests),
    }


# ═══════════════════════════════════════════════════════════════════════
# SORTING
#
# Sorting reorders WITHIN a group. It never dissolves the groups — the
# whole point of the grouping is that a student with no data and a
# student with a bad score are different problems, and one sort key
# cannot express both.
# ═══════════════════════════════════════════════════════════════════════

def _nlast(v, desc):
    """Sort key that always parks None at the end, both directions."""
    if v is None:
        return (1, 0)
    return (0, -float(v) if desc else float(v))


SORTS = {
    "urgent":      lambda s: (-s["severity"], -(s["days_quiet"] or 0)),
    "right_asc":   lambda s: _nlast(s["getting_right"], False),
    "right_desc":  lambda s: _nlast(s["getting_right"], True),
    "far_asc":     lambda s: _nlast(s["how_far_through"], False),
    "quiet":       lambda s: (-(s["days_quiet"] if s["days_quiet"] is not None else -1),),
    "tests":       lambda s: (-s["tests"],),
    "name":        lambda s: (s["name"].lower(),),
}
DEFAULT_SORT = "urgent"

SORT_LABELS = [
    ["urgent",     "Most urgent first"],
    ["right_asc",  "Getting right, low to high"],
    ["right_desc", "Getting right, high to low"],
    ["far_asc",    "How far through, least first"],
    ["quiet",      "Quiet the longest"],
    ["tests",      "Tests taken"],
    ["name",       "Name, A to Z"],
]

# Filter ids are flags_for KINDS, so a chip here and a card on Home mean
# exactly the same thing. No second taxonomy.
FILTER_CHIPS = [
    ["",                "Everyone"],
    ["needs_you",       "Needs you today"],
    ["inactive",        "Gone quiet"],
    ["never_started",   "Never started"],
    ["forgetting",      "Forgetting things"],
    ["rushing",         "Rushing"],
    ["read_not_tested", "Read, not tested"],
    ["notes",           "Has notes"],
]


def _passes(s, filt):
    if not filt:
        return True
    if filt == "needs_you":
        return s["group"] == "needs_you"
    if filt == "notes":
        return s["notes"] > 0
    return filt in s["flag_kinds"]


GROUP_ORDER = ["needs_you", "fine", "not_enough", "not_started"]


# ═══════════════════════════════════════════════════════════════════════
# ROUTES
# ═══════════════════════════════════════════════════════════════════════

def _prepare(class_key):
    """Everything both routes need. One _roster(), one chapter_meta()."""
    u = getattr(request, "user_doc", None) or {}
    cr = class_role_for(u, class_key)
    roster = _roster(class_key)
    meta = chapter_meta()

    subjects = cr["subjects"] if cr["role"] == "subject_teacher" else []
    scope = build_scope(meta, roster, subjects)

    ctx = {"meta": meta, "class_pace_median": class_pace_median(roster)}
    pairs = {p.get("student_uid"): p for p in _teacher_pairs(request.uid)}
    today = _ist_today().isoformat()

    rows = [_row(r, ctx, scope, pairs, today) for r in roster]
    return cr, scope, rows


@students_bp.route("/api/teacher/class/<class_key>/v2/roster", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_class
def v2_roster(class_key):
    cr, scope, rows = _prepare(class_key)

    q = (request.args.get("q") or "").strip().lower()
    if q:
        rows = [s for s in rows
                if q in s["name"].lower() or q in str(s["roll_no"]).lower()]

    filt = request.args.get("filter") or ""
    shown = [s for s in rows if _passes(s, filt)]

    sort = request.args.get("sort") or DEFAULT_SORT
    key = SORTS.get(sort, SORTS[DEFAULT_SORT])
    shown.sort(key=key)

    groups = {g: [s for s in shown if s["group"] == g] for g in GROUP_ORDER}

    # Class-relative context the client needs to write honest empty states.
    return jsonify({
        "role": cr["role"],
        "subjects": cr["subjects"],
        "scope": {
            "chapters": scope["chapters"],
            "concepts": scope["concepts"],
            "subjects": scope["subjects"],
            "label": (", ".join(scope["subjects"])
                      if cr["role"] == "subject_teacher" and scope["subjects"]
                      else "All subjects"),
            # chapter_meta() is the OPD syllabus -- chapters that have a
            # question bank. Concept Studio has its own, larger, chapter
            # list. Saying "3 chapters" without that qualifier reads as
            # "the syllabus is three chapters long", which is alarming
            # and wrong. Principle 5: the two syllabi are separate and a
            # chapter in only one of them is a normal state.
            "basis": "with a question bank",
        },
        "groups": [
            {"id": g, "students": groups[g], "count": len(groups[g])}
            for g in GROUP_ORDER
        ],
        "total": len(rows),
        "shown": len(shown),
        "filter": filt,
        "sort": sort,
        "sorts": SORT_LABELS,
        "chips": FILTER_CHIPS,
        "min_questions": MIN_Q,
        "quiet_days": QUIET_DAYS,
    })


# ── CSV ────────────────────────────────────────────────────────────────
#
# This file gets printed and handed to a head of department. It carries a
# header block because a bare table with no class name on it is useless
# three weeks later, and a legend because a blank cell means "we have not
# asked enough questions", not "zero".
#
# What is deliberately NOT in it: guardian name, phone or email. An export
# is a contact reveal for fifty families at once and the audit row that
# makes a single reveal defensible would be meaningless here.

CLASS_COLUMNS = [
    "Roll no", "Name", "Status", "Needs attention", "Also",
    "Getting right %", "Questions answered", "Change vs last week",
    "How far through %", "Chapters started", "Chapters with a question bank",
    "Chapters finished", "Chapters testing now", "Chapters read only",
    "Chapters not started",
    "Tests taken", "Last test", "Days quiet",
    "Best full paper", "Full papers taken",
    "Notes", "Follow-up due",
]

SUBJECT_COLUMNS = [
    "Roll no", "Name", "Status", "Needs attention",
    "Getting right %", "Questions answered",
    "How far through %", "Chapters finished", "Chapters with a question bank",
    "Tests taken", "Last test", "Days quiet",
]

STATUS_TEXT = {
    "needs_you": "Needs you today",
    "fine": "Doing well",
    "not_enough": "Not enough answered yet",
    "not_started": "Has not started",
}


def _n(v):
    """A number, or a BLANK cell. Never a zero standing in for 'unknown'."""
    return "" if v is None else v


def _csv_row(s, columns):
    ch = s["chapters"]
    full = {
        "Roll no": s["roll_no"],
        "Name": s["name"],
        "Status": STATUS_TEXT.get(s["group"], ""),
        "Needs attention": s["reason"],
        "Also": " | ".join(s["other_reasons"]),
        "Getting right %": _n(s["getting_right"]),
        "Questions answered": s["questions_answered"],
        "Change vs last week": _n(s["trend_7d"]),
        "How far through %": _n(s["how_far_through"]),
        "Chapters started": s["chapters_started"],
        "Chapters with a question bank": s["chapters_in_scope"],
        "Chapters finished": ch["finished"],
        "Chapters testing now": ch["testing"],
        "Chapters read only": ch["read_only"],
        "Chapters not started": ch["not_started"],
        "Chapters in scope": ch["total"],
        "Tests taken": s["tests"],
        "Last test": (s["last_test_at"] or "")[:10],
        "Days quiet": _n(s["days_quiet"]),
        "Best full paper": _n(s["best_paper_marks"]),
        "Full papers taken": s["papers_attempted"],
        "Notes": s["notes"],
        "Follow-up due": (s["followup_at"] or "")[:10],
    }
    return [full.get(c, "") for c in columns]


@students_bp.route("/api/teacher/class/<class_key>/v2/roster.csv", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_class
def v2_roster_csv(class_key):
    cr, scope, rows = _prepare(class_key)
    cls = getattr(request, "class_doc", None) or {}

    # ?uids=a,b,c exports only the rows the teacher ticked.
    picked = [u for u in (request.args.get("uids") or "").split(",") if u]
    if picked:
        want = set(picked)
        rows = [s for s in rows if s["uid"] in want]

    sheet = request.args.get("sheet") or "class"
    columns = SUBJECT_COLUMNS if sheet == "subject" else CLASS_COLUMNS

    rows.sort(key=lambda s: (str(s["roll_no"] or "~"), s["name"].lower()))

    buf = io.StringIO()
    w = csv.writer(buf)

    # ── header block ──
    w.writerow(["NAADI AI — class report"])
    w.writerow(["School", cls.get("school_name", "") or cls.get("school_id", "")])
    w.writerow(["Class", cls.get("class_id", "") or class_key])
    w.writerow(["Academic year", cls.get("academic_year", "") or ""])
    w.writerow(["Prepared by", getattr(request, "user_email", "") or ""])
    w.writerow(["Prepared on", _ist_today().isoformat()])
    covering = (", ".join(scope["subjects"])
                if cr["role"] == "subject_teacher" and scope["subjects"]
                else "All subjects")
    w.writerow(["Covering", covering,
                f"{scope['chapters']} chapters",
                f"{scope['concepts']} concepts"])
    w.writerow(["Students", len(rows)])
    w.writerow([])
    w.writerow(["A blank score means we have not asked that student enough "
                "questions yet. It does not mean zero."])
    w.writerow([])

    w.writerow(columns)
    for s in rows:
        w.writerow(_csv_row(s, columns))

    try:
        _db().collection("pii_access_log").add({
            "actor_uid": request.uid,
            "actor_role": "teacher",
            "actor_email": getattr(request, "user_email", ""),
            "class_key": class_key,
            "fields": ["roster_export_v2"],
            "rows": len(rows),
            "sheet": sheet,
            "at": firestore.SERVER_TIMESTAMP,
        })
    except Exception as e:
        # An unlogged export is bad; a failed export is worse for the
        # teacher standing in front of a printer. Log loudly, still serve.
        print(f"[students] export audit write failed for {class_key}: {e}")

    name = (cls.get("class_id", "") or class_key).replace(" ", "_")
    return Response(buf.getvalue(), mimetype="text/csv", headers={
        "Content-Disposition": f'attachment; filename="{name}_report.csv"'})


# ═══════════════════════════════════════════════════════════════════════
# REGISTRATION
# ═══════════════════════════════════════════════════════════════════════

def register_student_routes(app):
    """Register the blueprint and prove, at import time, that nothing here
    shadows a route teacher_backend.py already owns.

    Flask will not tell you. It resolves the duplicate to whoever
    registered first and returns 200 with the wrong body.
    """
    app.register_blueprint(students_bp)

    bad = [str(r) for r in app.url_map.iter_rules()
           if r.endpoint.startswith("teacher_students.") and "/v2/" not in str(r)]
    if bad:
        raise RuntimeError(
            "teacher_students.py routes must sit under /v2/ or they will "
            f"silently shadow teacher_backend.py. Offending: {bad}")

    seen = {}
    for r in app.url_map.iter_rules():
        key = (str(r), tuple(sorted(r.methods - {"HEAD", "OPTIONS"})))
        if key in seen and seen[key] != r.endpoint:
            raise RuntimeError(
                f"Duplicate route {key[0]} registered by both "
                f"{seen[key]} and {r.endpoint}.")
        seen[key] = r.endpoint

    return app