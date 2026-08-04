"""
NAADI AI — TEACHER PORTAL  (teacher_backend.py)
═══════════════════════════════════════════════════════════════════════════

Second Blueprint on the SAME Flask app, the same Firestore project, the same
deploy. It imports its primitives from portal_backend — one auth path, one
rollup writer, one set of masking helpers.

WHAT MAKES THIS CHEAP
  Every class-wide screen reads student_rollups and nothing else. A 54-student
  heatmap is 54 document reads because per_chapter and per_concept already
  live on the rollup. Computed live it would be ~1,800.

WHAT MAKES THIS SAFE
  @resolve_class checks BOTH directions: the class must be in the teacher's
  class_keys[] AND the teacher must be in the class's teacher_uids[]. A
  one-sided check means editing one document silently grants access.

  school_id and class_id are printed on every student's own profile screen.
  They are identifiers, not credentials. No route gates on them alone.
"""

import csv
import io
import os
from datetime import datetime, timezone, timedelta
from functools import wraps

from flask import Blueprint, request, jsonify, Response
from firebase_admin import firestore

# The single flag engine. Pure functions, no imports of its own.
from teacher_signals import flags_for, class_pace_median

from portal_backend import (
    require_auth, require_role, _db, _user, _clean, _pct, _iso, _initials,
    _days_since, _mask_phone, _mask_email, _ist_today, chapter_meta,
    rebuild_student_rollup, class_key_for, _academic_year, _air_number,
    SUBJECTS, PASS_THRESHOLD, LOW_MASTERY, INACTIVE_DAYS, DOCTOR_LADDER,
)

teacher_bp = Blueprint("teacher", __name__)

DECK_SIZE = 10          # class card + ~8 students + "view all"
MIN_MOVERS = 1          # a deck of pure bad news teaches nobody anything
MOVER_THRESHOLD = 5.0   # mastery points gained over 30d to count as a mover


# ═══════════════════════════════════════════════════════════════════════════
# GUARDS
# ═══════════════════════════════════════════════════════════════════════════

def resolve_class(f):
    """Two-sided check. Both documents must agree, or it's a 403.

    users/{teacher}.class_keys[] is the fast path; classes/{key}.teacher_uids[]
    is the authority. Checking only one means a stray array update on a single
    document quietly hands over a class roster.
    """
    @wraps(f)
    def inner(class_key, *a, **kw):
        teacher = getattr(request, "user_doc", None) or _user(request.uid) or {}
        if class_key not in (teacher.get("class_keys", []) or []):
            print(f"[teacher] SCOPE VIOLATION uid={request.uid} class={class_key}")
            return jsonify({"error": "Not your class.", "code": "OUT_OF_SCOPE"}), 403

        doc = _db().collection("classes").document(class_key).get()
        if not doc.exists:
            return jsonify({"error": "Class not found."}), 404

        cls = doc.to_dict()
        if request.uid not in (cls.get("teacher_uids", []) or []):
            print(f"[teacher] ONE-SIDED CLAIM uid={request.uid} class={class_key}")
            return jsonify({"error": "Not your class.", "code": "OUT_OF_SCOPE"}), 403

        request.class_key = class_key
        request.class_doc = cls
        return f(class_key, *a, **kw)
    return inner


def resolve_student(f):
    """A teacher may read a student only through a class they own.

    Note this reads the ROLLUP's class_key, not the user doc's — the rollup is
    what the roster is built from, so if the two ever disagree, access must
    follow what the teacher can actually see.
    """
    @wraps(f)
    def inner(student_uid, *a, **kw):
        teacher = getattr(request, "user_doc", None) or _user(request.uid) or {}
        keys = teacher.get("class_keys", []) or []

        snap = _db().collection("student_rollups").document(student_uid).get()
        if not snap.exists:
            rebuild_student_rollup(student_uid)
            snap = _db().collection("student_rollups").document(student_uid).get()
        if not snap.exists:
            return jsonify({"error": "Student not found."}), 404

        r = snap.to_dict()
        if r.get("class_key") not in keys or r.get("class_status") != "approved":
            print(f"[teacher] SCOPE VIOLATION uid={request.uid} student={student_uid}")
            return jsonify({"error": "Not your student.", "code": "OUT_OF_SCOPE"}), 403

        request.student_uid = student_uid
        request.student_rollup = _clean(r)
        return f(student_uid, *a, **kw)
    return inner


# ═══════════════════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════════════════

def _roster(class_key):
    """Every approved student in a class. ~50 document reads.

    This is the single query the whole teacher portal is built on.

    uid comes from doc.id, NOT from the document body. The rollup carries a
    `uid` FIELD as well, and the two can drift — a rollup rebuilt under the
    wrong key, or a document copied to seed a test account, leaves a row that
    renders one student's name and links to another's data. Every downstream
    check then passes, because the uid it receives is a real student in this
    teacher's class. The document id is the authority; the field is a copy.
    """
    out = []
    for doc in _db().collection("student_rollups") \
            .where("class_key", "==", class_key).stream():
        r = doc.to_dict() or {}
        if r.get("class_status") != "approved":
            continue
        if r.get("uid") and r["uid"] != doc.id:
            print(f"[teacher] ROLLUP UID MISMATCH doc={doc.id} field={r['uid']} "
                  f"class={class_key} — trusting doc.id")
        r["uid"] = doc.id
        # teacher_signals._rule_inactive and _rule_never_started both read
        # this and NOTHING was setting it, so the highest-severity flag in
        # the product ("Hasn't opened the app in N days", severity 95) was
        # silently dead on every screen. It is derived here, at the single
        # entry point every teacher screen goes through, rather than in
        # three callers that can drift apart.
        r["_days_since_active"] = _days_since(r.get("last_active_at", ""))
        out.append(_clean(r))
    return out


# ═══════════════════════════════════════════════════════════════════════════
# THE THREE METRICS
#
# "Mastery" used to mean three different things in three different places, and
# the version driving the heatmap was not a measure of ability at all. It is
# replaced everywhere by three named quantities that are never blended:
#
#   ACCURACY   correct / seen. How well, when they have actually been asked.
#              Gated on MIN_SAMPLE — below that it is "—", never 0% or 100%.
#   COVERAGE   concepts attempted / concepts in scope. How far along.
#   RETENTION  v3 audit pass rate. Whether it stuck. See portal_backend.
#
# Keeping them apart is what lets a teacher tell "weak here" from "hasn't got
# here yet" — a distinction the product previously could not make.
# ═══════════════════════════════════════════════════════════════════════════

def _quantile(sorted_vals, q):
    """Linear-interpolated quantile. Used for medians on test distributions."""
    if not sorted_vals:
        return 0
    if len(sorted_vals) == 1:
        return round(sorted_vals[0], 1)
    pos = (len(sorted_vals) - 1) * q
    lo, hi = int(pos), min(int(pos) + 1, len(sorted_vals) - 1)
    frac = pos - lo
    return round(sorted_vals[lo] * (1 - frac) + sorted_vals[hi] * frac, 1)


MIN_SAMPLE = 8          # questions seen before an accuracy figure means anything
MIN_AUDITS = 3          # audits before a retention figure means anything


def _acc(correct, seen, floor=MIN_SAMPLE):
    """Accuracy, or None when the sample is too small to claim anything.

    Without this, a concept answered 2/2 ranks as a class strength at 100% and
    one answered 0/1 ranks as its worst weakness. Both were happening.
    """
    if not seen or seen < floor:
        return None
    return round(correct / seen * 100, 1)


def _student_metrics(r):
    """Accuracy / coverage / retention for one student, from the rollup."""
    per_ch = r.get("per_chapter", {}) or {}
    per_con = r.get("per_concept", {}) or {}

    seen = sum(int(c.get("s", 0) or 0) for c in per_con.values())
    # per_concept.m is already a percentage, so weight it by questions seen
    # rather than averaging percentages of wildly different sample sizes.
    correct = sum((c.get("m", 0) or 0) / 100.0 * int(c.get("s", 0) or 0)
                  for c in per_con.values())

    concepts_attempted = sum(int(c.get("concepts_attempted", 0) or 0)
                             for c in per_ch.values())
    concepts_total = sum(int(c.get("concepts_total", 0) or 0)
                         for c in per_ch.values())

    ret = r.get("retention", {}) or {}
    audits = int(ret.get("audits_total", 0) or 0)

    return {
        "accuracy": _acc(correct, seen),
        "questions_seen": seen,
        "coverage_pct": (round(concepts_attempted / concepts_total * 100, 1)
                         if concepts_total else 0.0),
        "concepts_attempted": concepts_attempted,
        "concepts_total": concepts_total,
        "chapters_started": len(per_ch),
        "retention_pct": ret.get("retention_pct") if audits >= MIN_AUDITS else None,
        "audits_total": audits,
        "false_recovery_count": int(ret.get("false_recovery_count", 0) or 0),
    }


# ═══════════════════════════════════════════════════════════════════════════
# TEST INTEGRITY
#
# A student who taps the same option down the page and submits produces a
# score that looks like a bad day and is nothing of the kind. The teacher
# needs to know the difference before they plan a remedial class around it.
#
# Two independent signals, both cheap, both computed from data already on the
# session document:
#   PATTERN  one option chosen for >= 80% of attempted questions
#   SPEED    median time per question far below what the test allows
#
# Neither is an accusation on its own. Reported as "check this", with the
# evidence attached, never as a verdict.
# ═══════════════════════════════════════════════════════════════════════════

SAME_OPTION_SHARE = 0.8     # share of one option that trips the pattern flag
MIN_Q_FOR_PATTERN = 5       # below this, "all B" is a coincidence
FAST_SECONDS_PER_Q = 5      # below this, they cannot have read the question
FAST_SHARE_OF_ALLOWED = 0.25  # or under a quarter of the time the test allows


def _integrity(session, questions=None):
    """Flag a test that looks like it was not actually attempted.

    Returns None when nothing is odd, so callers can `if flags:` cheaply.
    """
    qs = questions if questions is not None else (session.get("questions", []) or [])
    answers = [q.get("student_answer") for q in qs
               if q.get("student_answer") not in (None, "", {})]
    attempted = len(answers)
    total = int(session.get("total_questions", 0) or len(qs) or 0)
    taken = int(session.get("time_taken_seconds", 0) or 0)
    allowed = int(session.get("time_limit_seconds", 0) or 0)

    flags, detail = [], {}

    if attempted >= MIN_Q_FOR_PATTERN:
        counts = {}
        for a in answers:
            key = a if isinstance(a, str) else str(a)
            counts[key] = counts.get(key, 0) + 1
        top_opt, top_n = max(counts.items(), key=lambda kv: kv[1])
        share = top_n / attempted
        if share >= SAME_OPTION_SHARE:
            flags.append("same_option")
            detail["same_option"] = top_opt
            detail["same_option_pct"] = round(share * 100)

    if total and taken:
        per_q = taken / total
        detail["seconds_per_question"] = round(per_q, 1)
        # Two ways to be too fast. The absolute floor catches a 10-question
        # chapter test; the relative one catches a 180-question paper closed
        # in forty minutes, where 13s/question is still nowhere near enough.
        if per_q < FAST_SECONDS_PER_Q:
            flags.append("too_fast")
        elif allowed and taken < allowed * FAST_SHARE_OF_ALLOWED and per_q < 20:
            flags.append("too_fast")
            detail["used_pct"] = round(taken / allowed * 100)

    if not flags:
        return None
    detail["attempted"] = attempted
    detail["total"] = total
    # Both at once is the strong case: same answer every time AND no time to
    # read. One alone is worth a glance, not a conversation.
    detail["severity"] = "high" if len(flags) > 1 else "low"
    detail["flags"] = flags
    return detail


def _mask(r):
    """Contact details are masked at read time, always. The unmasked value
    exists on the rollup, is never serialised by a list endpoint, and is only
    released by /reveal-contact, which writes an audit row first."""
    return {
        "guardian_name": r.get("guardian_name", ""),
        "guardian_phone": _mask_phone(r.get("guardian_phone", "")),
        "guardian_email": _mask_email(r.get("guardian_email", "")),
        "masked": True,
    }


def _card(r):
    """One student card, deck or roster. Never carries contact details.

    Two fields left this payload and are not coming back:

      mastery       the blend of progress and ability. A student ten
                    concepts into sixty answering at 90% scored ~15% on
                    it and read as failing.
      alert_reason  written by the deleted second flag engine. It said
                    "Mastery 34% - below 40%" -- the banned word, on the
                    deleted metric, ungated. Callers take the sentence
                    from teacher_signals.flags_for instead.

    trend_7d now rides on ACCURACY. It was a mastery delta rendered inside
    the accuracy column, so it read as an accuracy change and was not one.
    Gated at both ends: a student who merely crossed the sample floor this
    week has not improved by forty points.
    """
    trend = None
    a7 = r.get("accuracy_7d_ago")
    acc_now = _student_metrics(r).get("accuracy")
    if a7 is not None and acc_now is not None:
        trend = round(acc_now - float(a7), 1)
    return {
        "uid": r["uid"],
        "roll_no": r.get("roll_no", ""),
        "name": r.get("name", "Student"),
        "initials": r.get("initials", "?"),
        "photo_url": r.get("photo_url", ""),
        "tests": r.get("tests_completed", 0),
        "streak": r.get("streak_current", 0),
        "last_active_at": r.get("last_active_at", ""),
        "last_active_days": _days_since(r.get("last_active_at", "")),
        "alert_flags": r.get("alert_flags", []),
        "trend_7d": trend,
        "pending_interventions": r.get("pending_interventions_count", 0),
        # Getting right / how far through / the audit. Never blended.
        **_student_metrics(r),
    }


# Severity order decides who reaches the deck. A student who never started
# outranks one who is merely below 40% — you can still catch the first.
# Mirrors teacher_signals.FLAG severities so the deck and Home order the
# same students the same way. Old keys (inactive_7d, mastery_below_40,
# repeated_failures, many_interventions, declining) belonged to the
# deleted _alert_flags and would have scored every student 0 here.
SEVERITY = {
    "never_started": 100,
    "inactive": 95,
    "low_scores": 85,
    "forgetting": 80,
    "failed_retakes": 70,
    "arena_low": 65,
    "rushing": 60,
    "tested_blind": 50,
    "read_not_tested": 45,
    "streak_broken": 30,
}


def _severity(r):
    flags = r.get("alert_flags", []) or []
    return max((SEVERITY.get(f, 0) for f in flags), default=0)


def _tone(r):
    s = _severity(r)
    return "critical" if s >= 70 else "warning" if s > 0 else "ok"


# ═══════════════════════════════════════════════════════════════════════════
# CLASS LIST
# ═══════════════════════════════════════════════════════════════════════════

@teacher_bp.route("/api/teacher/classes", methods=["GET"])
@require_auth
@require_role("teacher")
def teacher_classes():
    u = request.user_doc
    out = []
    for key in (u.get("class_keys", []) or []):
        doc = _db().collection("classes").document(key).get()
        if not doc.exists:
            continue
        c = doc.to_dict()
        pending = sum(1 for _ in _db().collection("class_join_requests")
                      .where("class_key", "==", key)
                      .where("status", "==", "pending").stream())
        out.append({
            "class_key": key,
            "class_id": c.get("class_id", ""),
            "school_id": c.get("school_id", ""),
            "school_name": c.get("school_name", ""),
            "academic_year": c.get("academic_year"),
            "student_count": c.get("student_count", 0),
            "pending_count": pending,
            "peer_comparison_enabled": c.get("settings", {}).get("peer_comparison_enabled", False),
            "co_teachers": len(c.get("teacher_uids", []) or []),
        })
    prefs = u.get("teacher_prefs", {}) or {}
    return jsonify({
        "name": u.get("name", "Teacher"),
        "email": u.get("email", ""),
        "classes": out,
        "prefs": {
            "weekly_digest": bool(prefs.get("weekly_digest", True)),
            "at_risk_alerts": bool(prefs.get("at_risk_alerts", True)),
            "join_requests": bool(prefs.get("join_requests", True)),
        },
    })


# ═══════════════════════════════════════════════════════════════════════════
# T1 · THE PRIORITY DECK
#
# Not the roster. Fifty-four swipes to find one struggling student is not
# navigation, it is a filing cabinet. This is a curated ~10-card deck the
# server ranks, so the first thing a teacher sees each morning is the thing
# that needs them.
# ═══════════════════════════════════════════════════════════════════════════

@teacher_bp.route("/api/teacher/class/<class_key>/deck", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_class
def teacher_deck(class_key):
    roster = _roster(class_key)
    cls = request.class_doc

    if not roster:
        return jsonify({
            "class_card": _class_card(class_key, cls, []),
            "cards": [],
            "total_students": 0,
            "empty_reason": "No approved students in this class yet.",
        })

    # Triage you cannot clear is a to-do list that never shrinks; the same five
    # cards greet you every morning until you stop opening the screen. A snooze
    # is per-teacher, so a co-teacher's deck is unaffected.
    snoozed = _snoozed_uids(request.uid)

    # The sentence on every card comes from the one flag engine. Computing
    # it here rather than reading the rollup's stored copy means the deck
    # also gets the rushing rule, which needs a class median the rollup
    # writer does not have.
    _ctx = {"meta": chapter_meta(), "class_pace_median": class_pace_median(roster)}
    _reasons = {r["uid"]: flags_for(r, _ctx) for r in roster}

    flagged = sorted([r for r in roster
                      if _reasons.get(r["uid"]) and r["uid"] not in snoozed],
                     key=lambda r: -(_reasons[r["uid"]][0]["severity"]))

    movers = sorted(
        [r for r in roster
         if r.get("accuracy_7d_ago") is not None
         and _student_metrics(r).get("accuracy") is not None
         and _student_metrics(r)["accuracy"] - r["accuracy_7d_ago"] >= MOVER_THRESHOLD],
        key=lambda r: -(_student_metrics(r)["accuracy"] - r["accuracy_7d_ago"]))

    slots = DECK_SIZE - 2                       # class card + "view all"
    keep_movers = min(len(movers), max(MIN_MOVERS, 2) if flagged else 3)
    cards = []

    for r in flagged[: slots - keep_movers]:
        fl = _reasons[r["uid"]]
        c = _card(r)
        c["tone"] = "critical" if fl[0]["severity"] >= 70 else "warning"
        c["reason"] = fl[0]["text"]
        cards.append(c)

    for r in movers[:keep_movers]:
        if any(c["uid"] == r["uid"] for c in cards):
            continue
        c = _card(r)
        c["tone"] = "celebration"
        gain = round(_student_metrics(r)["accuracy"] - r["accuracy_7d_ago"])
        c["reason"] = f"Getting {gain} points more right than last week"
        cards.append(c)

    names = {r["uid"]: r for r in roster}

    # ── Regressions: knew it, then lost it ──────────────────────────────
    # A base they got wrong, recovered on the v2 rephrase, then FAILED on a
    # differently-trapped v3 three tests later. They had memorised v1's answer.
    # This is the highest-value alert in the product and it has never been
    # shown to anyone.
    regressions = []
    for r in roster:
        ret = r.get("retention", {}) or {}
        n_fr = int(ret.get("false_recovery_count", 0) or 0)
        if n_fr >= 2:
            regressions.append({
                "uid": r["uid"], "name": r.get("name", ""),
                "initials": r.get("initials", "?"),
                "count": n_fr,
                "retention_pct": ret.get("retention_pct"),
                "example": ((ret.get("false_recoveries") or [{}])[0]
                            .get("question_text", ""))[:120],
            })
    regressions.sort(key=lambda x: -x["count"])

    return jsonify({
        "class_card": _class_card(class_key, cls, roster),
        "cards": cards,
        "total_students": len(roster),
        "flagged_count": len(flagged),
        "snoozed_count": sum(1 for u in snoozed if u in names),
        "followups": _followups(request.uid, names),
        "regressions": regressions[:6],
    })


def _idle_days(r, default=99):
    """Days since last activity, or `default` if we've never seen them.

    Must not be written as `_days_since(...) or 99`. A student who studied
    TODAY gets 0, and `0 or 99` is 99 — which silently drops every active
    student out of the "active this week" count, always in the same direction.
    """
    d = _days_since(r.get("last_active_at", ""))
    return default if d is None else d


def _class_card(class_key, cls, roster):
    n = len(roster)
    active = sum(1 for r in roster if _idle_days(r) <= 7)
    at_risk = sum(1 for r in roster if r.get("alert_flags"))
    meta = chapter_meta()
    total_chapters = len(meta) or 1

    mets = [_student_metrics(r) for r in roster]

    # Class accuracy is pooled over questions, not averaged over students. An
    # average of percentages lets a student with four questions answered move
    # the class figure as much as one with four hundred.
    acc_vals = [(m["accuracy"], m["questions_seen"]) for m in mets
                if m["accuracy"] is not None]
    seen_tot = sum(w for _, w in acc_vals)
    class_accuracy = (round(sum(a * w for a, w in acc_vals) / seen_tot, 1)
                      if seen_tot else None)

    # Coverage against the WHOLE syllabus, not against chapters they opened.
    # The old figure divided started chapters by total chapters and called it
    # coverage, which counted a chapter the student merely opened as covered.
    con_att = sum(m["concepts_attempted"] for m in mets)
    con_tot = sum(m["concepts_total"] for m in mets)
    class_coverage = round(con_att / con_tot * 100, 1) if con_tot else 0.0

    audits = sum(m["audits_total"] for m in mets)
    confirmed = sum(int((r.get("retention", {}) or {}).get("audits_confirmed", 0) or 0)
                    for r in roster)
    class_retention = round(confirmed / audits * 100, 1) if audits >= MIN_AUDITS else None
    false_recoveries = sum(m["false_recovery_count"] for m in mets)

    pending = sum(1 for _ in _db().collection("class_join_requests")
                  .where("class_key", "==", class_key)
                  .where("status", "==", "pending").stream())

    return {
        "class_key": class_key,
        "class_id": cls.get("class_id", ""),
        "school_name": cls.get("school_name", ""),
        "students": n,
        "active_this_week": active,
        "at_risk": at_risk,
        "pending_approvals": pending,
        "accuracy": class_accuracy,
        "coverage_pct": class_coverage,
        "retention_pct": class_retention,
        "audits_total": audits,
        "false_recoveries": false_recoveries,
        "chapters_total": total_chapters,
        # Kept so nothing that still reads the old key explodes mid-deploy.
        "avg_mastery": round(sum(r.get("overall_mastery", 0) for r in roster) / n, 1) if n else 0,
        "avg_accuracy": class_accuracy or 0,
    }


# ═══════════════════════════════════════════════════════════════════════════
# T2 · CLASS OVERVIEW
# ═══════════════════════════════════════════════════════════════════════════

@teacher_bp.route("/api/teacher/class/<class_key>/overview", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_class
def teacher_overview(class_key):
    """Class vitals, distributions and engagement — all on real metrics."""
    roster = _roster(class_key)
    cls = request.class_doc
    n = len(roster)
    if not n:
        return jsonify({"empty": True, "kpis": _class_card(class_key, cls, [])})

    meta = chapter_meta()
    mets = [_student_metrics(r) for r in roster]

    # ── Accuracy distribution, 20% bands ────────────────────────────────
    # Ten buckets produced ten rotated tick labels that no phone could render.
    # Students without a scoreable sample are counted separately rather than
    # silently dropped into the 0-20 band, which is what made every new class
    # look like it was failing.
    BANDS = [(0, 20, "0-20"), (20, 40, "20-40"), (40, 60, "40-60"),
             (60, 80, "60-80"), (80, 101, "80-100")]
    buckets = [0] * len(BANDS)
    unscored = 0
    for m in mets:
        a = m["accuracy"]
        if a is None:
            unscored += 1
            continue
        for i, (lo, hi, _) in enumerate(BANDS):
            if lo <= a < hi:
                buckets[i] += 1
                break

    scored = sorted(m["accuracy"] for m in mets if m["accuracy"] is not None)
    median_accuracy = _quantile(scored, .5) if scored else None

    # ── Engagement, with a trailing mean ────────────────────────────────
    daily = []
    try:
        for doc in _db().collection("classes").document(class_key) \
                .collection("daily").order_by("date").limit_to_last(30).get():
            d = doc.to_dict() or {}
            daily.append({"date": d.get("date", ""), "active": d.get("active", 0),
                          "tests": d.get("tests", 0)})
    except Exception as e:
        print(f"[teacher] daily rollup read failed for {class_key}: {e}")
    daily.sort(key=lambda d: d["date"])
    for i, d in enumerate(daily):
        w = daily[max(0, i - 6): i + 1]
        d["active_avg7"] = round(sum(x["active"] for x in w) / len(w), 1)

    # ── Per-subject accuracy and coverage ───────────────────────────────
    subj = {}
    for r in roster:
        for cid, c in (r.get("per_chapter", {}) or {}).items():
            m = meta.get(cid)
            if not m:
                continue
            e = subj.setdefault(m["subject"], {
                "subject": m["subject"], "correct": 0.0, "seen": 0,
                "con_att": 0, "con_tot": 0, "students": set(), "tests": 0,
            })
            acc = c.get("accuracy")
            att = int(c.get("concepts_attempted", 0) or 0)
            if acc is not None and att:
                # Weight chapter accuracy by concepts touched — the rollup does
                # not keep per-chapter question counts, and concepts touched is
                # the closest honest proxy for effort in that chapter.
                e["correct"] += acc / 100.0 * att
                e["seen"] += att
            e["con_att"] += att
            e["con_tot"] += int(c.get("concepts_total", 0) or 0)
            e["students"].add(r["uid"])
            e["tests"] += int(c.get("tests", 0) or 0)

    chapters_by_subject = {}
    for m in meta.values():
        chapters_by_subject[m["subject"]] = chapters_by_subject.get(m["subject"], 0) + 1

    subject_rows = []
    for name, e in subj.items():
        subject_rows.append({
            "subject": name,
            "accuracy": _acc(e["correct"], e["seen"], floor=3),
            "coverage_pct": round(e["con_att"] / e["con_tot"] * 100, 1) if e["con_tot"] else 0,
            "students_started": len(e["students"]),
            "chapters_total": chapters_by_subject.get(name, 0),
            "tests": e["tests"],
        })
    subject_rows.sort(key=lambda r: r["subject"])

    # ── Full-paper participation ────────────────────────────────────────
    airs = [r["best_air_prediction"] for r in roster if r.get("best_air_prediction")]
    air_buckets = {"< 10k": 0, "10k-50k": 0, "50k-150k": 0, "> 150k": 0}
    for a in airs:
        if a < 10000: air_buckets["< 10k"] += 1
        elif a < 50000: air_buckets["10k-50k"] += 1
        elif a < 150000: air_buckets["50k-150k"] += 1
        else: air_buckets["> 150k"] += 1

    never_sat = [{"uid": r["uid"], "name": r.get("name", ""),
                  "initials": r.get("initials", "?")}
                 for r in roster if not r.get("arena_papers_attempted")]

    return jsonify({
        "kpis": _class_card(class_key, cls, roster),
        "median_accuracy": median_accuracy,
        "unscored_students": unscored,
        "accuracy_histogram": [{"bucket": BANDS[i][2], "count": c}
                               for i, c in enumerate(buckets)],
        "engagement": daily,
        "subject_rows": subject_rows,
        "air_distribution": [{"band": k, "count": v} for k, v in air_buckets.items()],
        "students_with_mocks": len(airs),
        "papers_participation": {
            "sat": n - len(never_sat), "total": n,
            "never_sat": never_sat[:12], "never_sat_count": len(never_sat),
        },
        "min_sample": MIN_SAMPLE,
    })


@teacher_bp.route("/api/teacher/class/<class_key>/coverage", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_class
def teacher_coverage(class_key):
    """Syllabus coverage as a tree, not a flat list.

    83 chapters across two class levels and three subjects cannot be a scrolling
    list of bars — the old screen truncated at twelve with no indication that it
    had. Subject -> class level -> chapter, so a Biology teacher opens Biology
    and sees 34 chapters, not 83.
    """
    roster = _roster(class_key)
    n = len(roster)
    meta = chapter_meta()
    if not n:
        return jsonify({"tree": [], "students": 0})

    stats = {}
    for r in roster:
        for cid, c in (r.get("per_chapter", {}) or {}).items():
            if cid not in meta:
                continue
            e = stats.setdefault(cid, {"started": 0, "done": 0, "cov": 0.0,
                                       "acc": 0.0, "acc_n": 0, "tests": 0})
            e["started"] += 1
            if c.get("complete"):
                e["done"] += 1
            e["cov"] += float(c.get("coverage_pct", 0) or 0)
            if c.get("accuracy") is not None:
                e["acc"] += c["accuracy"]
                e["acc_n"] += 1
            e["tests"] += int(c.get("tests", 0) or 0)

    tree = {}
    for cid, m in meta.items():
        st = stats.get(cid)
        subject = tree.setdefault(m["subject"], {})
        level = subject.setdefault(m["class"], [])
        level.append({
            "chapter_id": cid,
            "chapter_name": m["chapter_title"],
            "number": m["chapter_number"],
            "started": st["started"] if st else 0,
            "done": st["done"] if st else 0,
            "not_started": n - (st["started"] if st else 0),
            "coverage_pct": round(st["cov"] / st["started"], 1) if st and st["started"] else 0,
            "accuracy": round(st["acc"] / st["acc_n"], 1) if st and st["acc_n"] else None,
            "tests": st["tests"] if st else 0,
        })

    out = []
    for subject in sorted(tree):
        levels = []
        for lvl in sorted(tree[subject]):
            rows = sorted(tree[subject][lvl], key=lambda c: c["number"])
            touched = [c for c in rows if c["started"]]
            levels.append({
                "class_level": lvl,
                "chapters": rows,
                "chapters_total": len(rows),
                "chapters_touched": len(touched),
                "avg_coverage": (round(sum(c["coverage_pct"] for c in touched) / len(touched), 1)
                                 if touched else 0),
            })
        all_rows = [c for l in levels for c in l["chapters"]]
        touched_all = [c for c in all_rows if c["started"]]
        out.append({
            "subject": subject,
            "levels": levels,
            "chapters_total": len(all_rows),
            "chapters_touched": len(touched_all),
            "avg_coverage": (round(sum(c["coverage_pct"] for c in touched_all) / len(touched_all), 1)
                             if touched_all else 0),
        })

    return jsonify({"tree": out, "students": n})


# ═══════════════════════════════════════════════════════════════════════════
# ROSTER FILTERS AND SORTS
#
# Chips are disjoint at the top level. at_risk is a SUPERSET of inactive and
# never_started, so those two are second-level refinements the client only
# offers while "Needs attention" is active — three nested chips returning
# overlapping sets with no explanation was the old behaviour.
# ═══════════════════════════════════════════════════════════════════════════

FILTERS = {
    "at_risk": lambda r: bool(r.get("alert_flags")),
    # "inactive_7d" was an _alert_flags kind. teacher_signals calls it
    # "inactive"; this chip matched nothing after that engine was deleted.
    "inactive": lambda r: "inactive" in (r.get("alert_flags") or []),
    "never_started": lambda r: "never_started" in (r.get("alert_flags") or []),
    "interventions": lambda r: r.get("pending_interventions_count", 0) > 0,
    "top10": None,      # handled after sort
    "movers": None,     # ranked by delta, not by sort
    "slipping": None,   # ditto
}


def _sort_accuracy(r, desc=True):
    """Sort on gated accuracy, with unscored students always LAST.

    A student below the sample floor has no accuracy — not zero. Sorting them
    as 0 would park every new student at the bottom of "weakest first" and put
    them at the top of the teacher's attention list for no reason at all. The
    leading bool in the tuple pushes them past both directions of the sort.
    """
    a = _student_metrics(r)["accuracy"]
    return (a is None, -a if (a is not None and desc) else (a or 0))


SORTS = {
    # Ranked on ACCURACY, never on the old blended mastery. Mastery averaged
    # only the chapters a student had started, so one chapter done perfectly
    # ranked above forty chapters done honestly — the roster was sortable in a
    # way that inverted the truth.
    "accuracy": lambda r: _sort_accuracy(r, desc=True),
    "mastery_asc": lambda r: _sort_accuracy(r, desc=False),
    "coverage": lambda r: -_student_metrics(r)["coverage_pct"],
    "retention": lambda r: ((_student_metrics(r)["retention_pct"] is None),
                            -(_student_metrics(r)["retention_pct"] or 0)),
    "name": lambda r: r.get("name", "").lower(),
    "last_active": lambda r: r.get("last_active_at", ""),
    "tests": lambda r: -r.get("tests_completed", 0),
}

DEFAULT_SORT = "accuracy"


@teacher_bp.route("/api/teacher/class/<class_key>/roster", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_class
def teacher_roster(class_key):
    roster = _roster(class_key)

    q = (request.args.get("q") or "").strip().lower()
    if q:
        roster = [r for r in roster if q in r.get("name", "").lower()]

    filt = request.args.get("filter") or ""
    if filt in FILTERS and FILTERS[filt]:
        roster = [r for r in roster if FILTERS[filt](r)]

    # The only week-over-week figure the rollup keeps is mastery_7d_ago, so
    # Improving/Slipping still ride on it. That is fine for a DELTA — the
    # objection to blended mastery is that it is meaningless as a LEVEL, not
    # that it cannot show movement. An accuracy_7d_ago on the rollup would be
    # a better signal and is the obvious next change.
    delta = lambda r: (r.get("overall_mastery", 0) - r["mastery_7d_ago"]
                       if r.get("mastery_7d_ago") is not None else None)

    if filt == "movers":
        roster = [r for r in roster
                  if delta(r) is not None and delta(r) >= MOVER_THRESHOLD]
        roster.sort(key=lambda r: -delta(r))
    elif filt == "slipping":
        # The mirror of movers. Previously only reachable as a footnote on the
        # Concepts tab, where students had no business being.
        roster = [r for r in roster if delta(r) is not None and delta(r) < 0]
        roster.sort(key=delta)
    else:
        sort = request.args.get("sort") or DEFAULT_SORT
        roster.sort(key=SORTS.get(sort, SORTS[DEFAULT_SORT]))
        if sort == "last_active":
            roster.reverse()

    if filt == "top10":
        # Top by accuracy, and only among students who have a real accuracy —
        # ranking on blended mastery put the student who finished one chapter
        # perfectly above one who has honestly worked through forty.
        roster = sorted(roster, key=lambda r: _sort_accuracy(r, desc=True))
        roster = [r for r in roster
                  if _student_metrics(r)["accuracy"] is not None][:10]

    # Note + snooze markers, so a teacher can see at a glance which students
    # they have already written something about. One query for the whole page.
    pairs = {p.get("student_uid"): p for p in _teacher_pairs(request.uid)}
    today = _ist_today().isoformat()

    students = []
    for r in roster:
        c = _card(r)
        c["contact"] = _mask(r)
        c["tone"] = _tone(r)
        p = pairs.get(r["uid"]) or {}
        entries = p.get("entries") or []
        c["note_count"] = len(entries)
        c["has_open_followup"] = bool(p.get("next_followup"))
        c["followup_due"] = bool(p.get("next_followup")
                                 and p["next_followup"] <= today)
        c["snoozed"] = (p.get("snooze_until") or "") > today
        students.append(c)

    # Sorting is meaningless for movers/slipping — they are ranked by delta.
    return jsonify({
        "students": students,
        "total": len(students),
        "filter": filt,
        "sort_applied": filt not in ("movers", "slipping"),
        "sort": request.args.get("sort") or "mastery",
    })


@teacher_bp.route("/api/teacher/student/<student_uid>/reveal-contact", methods=["POST"])
@require_auth
@require_role("teacher")
@resolve_student
def teacher_reveal_contact(student_uid):
    """Unmask a guardian's phone and email. Writes an audit row FIRST.

    If the write fails, the reveal fails. An unlogged reveal is worse than a
    blocked one — the moment a school asks who looked up a parent's number,
    the answer has to exist.
    """
    r = request.student_rollup
    reason = (request.json or {}).get("reason", "")[:200]

    _db().collection("pii_access_log").add({
        "actor_uid": request.uid,
        "actor_role": "teacher",
        "actor_email": request.user_email,
        "target_student_uid": student_uid,
        "target_student_name": r.get("name", ""),
        "class_key": r.get("class_key", ""),
        "fields": ["guardian_phone", "guardian_email"],
        "reason": reason,
        "ip": request.headers.get("X-Forwarded-For", request.remote_addr or ""),
        "user_agent": request.headers.get("User-Agent", "")[:300],
        "at": firestore.SERVER_TIMESTAMP,
    })

    return jsonify({
        "guardian_name": r.get("guardian_name", ""),
        "guardian_phone": r.get("guardian_phone", ""),
        "guardian_email": r.get("guardian_email", ""),
        "masked": False,
        "logged": True,
    })


@teacher_bp.route("/api/teacher/class/<class_key>/export.csv", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_class
def teacher_export(class_key):
    """Roster CSV. Contact columns are NOT included — an export is a reveal
    for fifty students at once, and the audit row would be meaningless."""
    # RETIRED. This wrote "Mastery %" (the deleted blended metric), "Rank"
    # (doctor_rank, a scale no teacher uses), and raw enum strings like
    # "never_started; mastery_below_40" into a file that gets printed and
    # handed to a head of department. Superseded by /v2/roster.csv, which
    # carries a header block, plain-English sentences, and blanks rather
    # than zeros where there is not enough evidence.
    #
    # Kept as a 410 rather than deleted so a bookmarked URL fails loudly
    # instead of a browser showing a stale cached file.
    return jsonify({
        "error": "This export has been replaced.",
        "use": f"/api/teacher/class/{class_key}/v2/roster.csv",
    }), 410


# ═══════════════════════════════════════════════════════════════════════════
# T4 · CONCEPTS — the diagnostic engine
#
# The heatmap is the reason a school signs. A red column across forty students
# does not mean forty students are weak. It means the chapter was taught badly,
# or the questions are wrong. Nothing else in the product can show that.
# ═══════════════════════════════════════════════════════════════════════════

@teacher_bp.route("/api/teacher/class/<class_key>/heatmap", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_class
def teacher_heatmap(class_key):
    """Students x Chapters, or Students x Concepts within one chapter.

    SCOPE IS MANDATORY. With 83 chapters and 50 students an unscoped grid is
    ~4,000 cells and no arrangement of them is readable. The teacher picks a
    subject and a class level; the default is whatever has been touched in the
    last 30 days, because that is what they are teaching now.

    EVERY CELL IS TWO NUMBERS, not one. Colour is ACCURACY (how well), fill is
    COVERAGE (how far). The old grid used chapter mastery, which counts every
    unreached concept as a zero — so a red cell mostly meant "not finished",
    and a teacher reading it as "weak" reteaches material the class has never
    seen. Splitting them is the whole point of this screen.

    Cost: len(roster) reads. Everything below already lives on the rollup.
    """
    roster = _roster(class_key)
    mode = request.args.get("mode", "chapters")
    chapter_id = request.args.get("chapter_id", "")
    subject = request.args.get("subject", "")
    level = request.args.get("class_level", "")
    scope = request.args.get("scope", "recent")     # recent | all
    meta = chapter_meta()

    # Which chapters the class has actually touched, and which are live.
    touched, recent = set(), set()
    cutoff = (_ist_today() - timedelta(days=30)).isoformat()
    for r in roster:
        for cid, c in (r.get("per_chapter", {}) or {}).items():
            touched.add(cid)
            if (r.get("last_active_at", "") or "")[:10] >= cutoff and c.get("tests", 0):
                recent.add(cid)

    subjects = sorted({meta[c]["subject"] for c in touched if c in meta})
    levels = sorted({meta[c]["class"] for c in touched if c in meta})
    if not subject and subjects:
        subject = subjects[0]

    def in_scope(cid):
        m = meta.get(cid)
        if not m:
            return False
        if subject and m["subject"] != subject:
            return False
        if level and m["class"] != level:
            return False
        if scope == "recent" and recent and cid not in recent:
            return False
        return True

    if mode == "concepts" and chapter_id:
        cols, seen = [], set()
        for r in roster:
            for cid, c in (r.get("per_concept", {}) or {}).items():
                if c.get("c") == chapter_id and cid not in seen:
                    seen.add(cid)
                    cols.append({"id": cid, "label": c.get("n", cid),
                                 "subject": meta.get(chapter_id, {}).get("subject", "")})
        cols.sort(key=lambda c: c["label"])

        def cell(r, col):
            c = (r.get("per_concept", {}) or {}).get(col["id"])
            if not c:
                return None
            seen_n = int(c.get("s", 0) or 0)
            return {"accuracy": _acc(c.get("m", 0) / 100.0 * seen_n, seen_n, floor=3),
                    "seen": seen_n, "coverage": 100 if seen_n else 0}
    else:
        cols = [{"id": cid, "label": meta[cid]["chapter_title"],
                 "subject": meta[cid]["subject"], "class": meta[cid]["class"],
                 "number": meta[cid]["chapter_number"]}
                for cid in touched if in_scope(cid)]
        cols.sort(key=lambda c: (c["class"], c.get("number", 0)))

        def cell(r, col):
            c = (r.get("per_chapter", {}) or {}).get(col["id"])
            if not c:
                return None
            return {"accuracy": c.get("accuracy"),
                    "coverage": c.get("coverage_pct", 0),
                    "tests": c.get("tests", 0),
                    "phase": c.get("phase", "")}

    rows = []
    for r in sorted(roster, key=lambda r: r.get("name", "")):
        m = _student_metrics(r)
        rows.append({
            "uid": r["uid"],
            "name": r.get("name", ""),
            "initials": r.get("initials", "?"),
            "accuracy": m["accuracy"],
            "coverage_pct": m["coverage_pct"],
            "cells": [cell(r, col) for col in cols],
        })

    col_stats = []
    for i, col in enumerate(cols):
        got = [row["cells"][i] for row in rows if row["cells"][i]]
        accs = [g["accuracy"] for g in got if g.get("accuracy") is not None]
        covs = [g.get("coverage", 0) for g in got]
        col_stats.append({
            **col,
            "accuracy": round(sum(accs) / len(accs), 1) if accs else None,
            "coverage": round(sum(covs) / len(covs), 1) if covs else 0,
            "attempted": len(got),
            # Below 50 counted only among students with a REAL accuracy score,
            # so an unstarted class no longer reads as a failing one.
            "weak": sum(1 for a in accs if a < 50),
            "scored": len(accs),
        })

    return jsonify({
        "mode": mode,
        "chapter_id": chapter_id,
        "subject": subject,
        "class_level": level,
        "scope": scope,
        "subjects": subjects,
        "levels": levels,
        "columns": col_stats,
        "rows": rows,
        "students": len(rows),
        "min_sample": MIN_SAMPLE,
    })


@teacher_bp.route("/api/teacher/class/<class_key>/concepts", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_class
def teacher_concepts(class_key):
    """Reteach, strengths, false recoveries and most-failed questions.

    Everything here now ranks on ACCURACY with a sample floor. The old version
    ranked on chapter/concept mastery with no floor, which put concepts
    answered 2/2 at the top of "strongest" and 0/1 at the top of "weakest" —
    exactly what you see when a class is new.
    """
    roster = _roster(class_key)
    n = len(roster)
    meta = chapter_meta()
    if not n:
        return jsonify({"reteach": [], "strengths": [], "failed_questions": [],
                        "false_recoveries": [], "students": 0})

    # ── Per-concept aggregation, weighted by questions seen ─────────────
    agg = {}
    for r in roster:
        for cid, c in (r.get("per_concept", {}) or {}).items():
            seen = int(c.get("s", 0) or 0)
            if not seen:
                continue
            a = agg.setdefault(cid, {
                "concept_name": c.get("n", cid), "chapter_id": c.get("c", ""),
                "seen": 0, "correct": 0.0, "students": 0, "weak_students": 0,
                "stuck": 0,
            })
            a["seen"] += seen
            a["correct"] += (c.get("m", 0) or 0) / 100.0 * seen
            a["students"] += 1
            if seen >= MIN_SAMPLE and (c.get("m", 0) or 0) < 50:
                a["weak_students"] += 1
            if int(c.get("f", 0) or 0) >= 2:
                a["stuck"] += 1

    reteach, strengths = [], []
    for cid, a in agg.items():
        acc = _acc(a["correct"], a["seen"])
        if acc is None:
            continue                     # not enough evidence to claim anything
        ch = meta.get(a["chapter_id"], {})
        row = {
            "concept_id": cid,
            "concept_name": a["concept_name"],
            "chapter_id": a["chapter_id"],
            "chapter_name": ch.get("chapter_title", ""),
            "subject": ch.get("subject", ""),
            "class_level": ch.get("class", ""),
            "accuracy": acc,
            "attempted_by": a["students"],
            "questions_seen": a["seen"],
            "weak_students": a["weak_students"],
            "weak_pct": round(a["weak_students"] / a["students"] * 100) if a["students"] else 0,
            "stuck_students": a["stuck"],
        }
        # Reteach needs real class coverage behind it — a concept two students
        # have reached is a conversation, not a lesson.
        if acc < 60 and a["students"] >= max(3, round(n * 0.3)):
            reteach.append(row)
        elif acc >= 75 and a["students"] >= max(3, round(n * 0.4)):
            strengths.append(row)

    reteach.sort(key=lambda c: (c["accuracy"], -c["weak_pct"]))
    strengths.sort(key=lambda c: -c["accuracy"])

    # ── Most-failed questions, with the actual question text ────────────
    # The text now comes off the rollup's failed_bases, which carries it from
    # base_question_tracking.variation_history. The previous version looked up
    # questions/{base_question_id} — but that id lives in meta_data and the
    # document id is the VARIATION id, so the lookup could never hit and every
    # row rendered "Question text unavailable".
    fq = {}
    for r in roster:
        for b in (r.get("failed_bases", []) or []):
            bid = b.get("base_question_id")
            if not bid:
                continue
            e = fq.setdefault(bid, {
                "base_question_id": bid,
                "chapter_id": b.get("chapter_id", ""),
                "concept_id": b.get("concept_id", ""),
                "question_text": "",
                "students": 0, "failures": 0,
            })
            e["students"] += 1
            e["failures"] += int(b.get("failures", 0) or 0)
            if not e["question_text"] and b.get("question_text"):
                e["question_text"] = b["question_text"]

    failed_questions = sorted(fq.values(), key=lambda e: -e["students"])[:10]
    for e in failed_questions:
        ch = meta.get(e["chapter_id"], {})
        e["chapter_name"] = ch.get("chapter_title", "")
        e["subject"] = ch.get("subject", "")
        e["fail_pct"] = round(e["students"] / n * 100)

    # ── False recoveries: the metric nobody else can compute ────────────
    # A base the student got wrong, then passed on the v2 rephrase, then FAILED
    # three tests later on a differently-trapped v3. They had memorised v1's
    # answer, not learned the idea. Clustered by concept, this is the most
    # precise reteach signal in the product.
    fr = {}
    for r in roster:
        for f in ((r.get("retention", {}) or {}).get("false_recoveries", []) or []):
            cid = f.get("concept_id") or f.get("base_question_id")
            e = fr.setdefault(cid, {
                "concept_id": f.get("concept_id", ""),
                "chapter_id": f.get("chapter_id", ""),
                "question_text": f.get("question_text", ""),
                "students": 0, "names": [],
            })
            e["students"] += 1
            if len(e["names"]) < 6:
                e["names"].append(r.get("name", ""))
    false_recoveries = sorted(fr.values(), key=lambda e: -e["students"])[:8]
    for e in false_recoveries:
        ch = meta.get(e["chapter_id"], {})
        e["chapter_name"] = ch.get("chapter_title", "")
        e["concept_name"] = (agg.get(e["concept_id"], {}) or {}).get("concept_name", "")

    return jsonify({
        "reteach": reteach[:15],
        "strengths": strengths[:10],
        "failed_questions": failed_questions,
        "false_recoveries": false_recoveries,
        "students": n,
        "min_sample": MIN_SAMPLE,
    })


@teacher_bp.route("/api/teacher/student/<student_uid>", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_student
def teacher_student(student_uid):
    r = request.student_rollup
    meta = chapter_meta()
    mets = _student_metrics(r)

    chapters = []
    for cid, pc in (r.get("per_chapter", {}) or {}).items():
        if cid not in meta:
            continue
        chapters.append({"chapter_id": cid,
                         "chapter_name": meta[cid]["chapter_title"],
                         "class_level": meta[cid]["class"], **pc})
    # Weakest ACCURACY first, and only among chapters with enough evidence.
    # Sorting on blended mastery put half-finished chapters at the top, which
    # is where a teacher's eye goes and exactly the wrong place to send it.
    chapters.sort(key=lambda c: (c.get("accuracy") is None,
                                 c.get("accuracy") if c.get("accuracy") is not None else 999))

    # ── Concepts, gated ─────────────────────────────────────────────────
    # weak_concepts / strong_concepts on the rollup are the top and bottom ten
    # by raw accuracy with no sample floor, which is why a class two weeks old
    # shows five concepts at exactly 100% and three at exactly 0%.
    per_con = r.get("per_concept", {}) or {}
    scored = []
    for cid, c in per_con.items():
        seen = int(c.get("s", 0) or 0)
        acc = _acc((c.get("m", 0) or 0) / 100.0 * seen, seen)
        if acc is None:
            continue
        ch = meta.get(c.get("c", ""), {})
        scored.append({"concept_id": cid, "concept_name": c.get("n", cid),
                       "chapter_id": c.get("c", ""),
                       "chapter_name": ch.get("chapter_title", ""),
                       "subject": ch.get("subject", ""),
                       "mastery": acc, "accuracy": acc, "seen": seen,
                       "stuck": int(c.get("f", 0) or 0)})
    weak = sorted(scored, key=lambda c: c["accuracy"])[:6]
    strong = sorted(scored, key=lambda c: -c["accuracy"])[:6]

    # ── Concept Studio vs OPD ───────────────────────────────────────────
    # Did they read the material before failing the test? A student who failed
    # at 0% studio completion needs telling to study; one who failed at 100%
    # needs teaching. Nothing in the portal could tell those apart.
    fc_seen = int(r.get("flashcards_seen", 0) or 0)
    fc_correct = int(r.get("flashcards_correct", 0) or 0)
    studio = {
        "completion_pct": r.get("studio_pct", 0),
        "chapters_started": r.get("studio_chapters_started", 0),
        "flashcards_seen": fc_seen,
        "flashcard_accuracy": _acc(fc_correct, fc_seen, floor=5),
    }

    note = ""
    nd = _db().collection("teacher_notes").document(f"{request.uid}_{student_uid}").get()
    if nd.exists:
        note = nd.to_dict().get("note", "")

    return jsonify({
        "student": _card(r),
        "metrics": mets,
        "retention": r.get("retention", {}),
        "contact": _mask(r),
        "per_subject": r.get("per_subject", {}),
        "chapters": chapters,
        "weak_concepts": weak,
        "strong_concepts": strong,
        "failed_bases": r.get("failed_bases", []),
        "studio": studio,
        "note": note,
        "best_air": r.get("best_air_prediction"),
        "arena_papers": r.get("arena_papers_attempted", 0),
        "min_sample": MIN_SAMPLE,
    })


@teacher_bp.route("/api/teacher/student/<student_uid>/tests", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_student
def teacher_student_tests(student_uid):
    """Every test this student has completed, from BOTH collections.

    The original version read only `test_sessions`. Full papers and NEET Arena
    papers live in `pyq_sessions` — so a teacher could not see that a student
    had sat a mock at all, which is the single thing a NEET teacher most wants
    to know. Both are read here and tagged with `kind`.
    """
    meta = chapter_meta()
    chapter_log, paper_log, custom_log, slow = [], [], [], []

    # ── Chapter tests ──────────────────────────────────────────────────
    for doc in _db().collection("test_sessions") \
            .where("user_id", "==", student_uid) \
            .where("status", "==", "completed").stream():
        s = doc.to_dict() or {}
        m = meta.get(s.get("chapter_id", ""), {})
        qs = s.get("questions", []) or []
        pct = round(float(s.get("percentage") or 0), 1)
        chapter_log.append({
            "integrity": _integrity(s, qs),
            "kind": "chapter",
            "session_id": s.get("session_id", doc.id),
            "title": m.get("chapter_title", s.get("chapter_id", "")) or "Chapter test",
            "chapter_id": s.get("chapter_id", ""),
            "subject": m.get("subject", ""),
            "test_num": s.get("test_num"),
            "phase": s.get("phase", ""),
            "percentage": pct,
            "passed": pct >= PASS_THRESHOLD,
            "is_retake": bool(s.get("is_retake")),
            "wrong_count": sum(1 for q in qs if q.get("is_correct") is False),
            "skipped_count": sum(1 for q in qs if q.get("student_answer") in (None, "", {})),
            "time_taken_seconds": s.get("time_taken_seconds", 0),
            "completed_at": _iso(s.get("completed_at")),
        })

        # Rushing vs freezing. Both look like a wrong answer on a score sheet
        # and are completely different problems.
        #
        # Measured against the time the test ITSELF allows, not against a fixed
        # 15s. opd_engine sets time_minutes per phase against q_per_test, so a
        # Foundation test budgets 48s/question and a NEET Simulation 45s — and
        # a flat threshold reported a student who finished a 10-question test in
        # 30 seconds identically to one who took 20 minutes over a Grand Mock.
        # This is why the old screen called a 94% score "rushing".
        n = len(qs) or 1
        taken = s.get("time_taken_seconds", 0) or 0
        allowed = s.get("time_limit_seconds", 0) or 0
        per_q = taken / n
        budget = (allowed / n) if allowed else None
        if budget and taken:
            ratio = per_q / budget
            # Only call it rushing if they were fast AND it cost them. Fast and
            # correct is a strong student, not a problem to flag.
            if ratio < 0.35 and pct < PASS_THRESHOLD:
                pattern = "rushing"
            elif ratio > 1.6:
                pattern = "freezing"
            else:
                pattern = None
            if pattern:
                slow.append({
                    "session_id": s.get("session_id", doc.id),
                    "chapter_name": m.get("chapter_title", ""),
                    "seconds_per_question": round(per_q),
                    "budget_per_question": round(budget),
                    "pattern": pattern,
                    "percentage": pct,
                })

    # ── Papers: full / arena / custom ──────────────────────────────────
    for doc in _db().collection("pyq_sessions") \
            .where("user_id", "==", student_uid) \
            .where("status", "==", "completed").stream():
        row = _paper_row(doc, meta)
        if row["kind"] == "custom":
            custom_log.append(row)
        else:
            paper_log.append(row)

    for lst in (chapter_log, paper_log, custom_log):
        lst.sort(key=lambda t: t["completed_at"] or "", reverse=True)

    # Score trend — every test, oldest first, so the chart reads left to right.
    trend = sorted(
        [{"at": t["completed_at"], "pct": t["percentage"], "kind": t["kind"],
          "title": t["title"]}
         for t in (chapter_log + paper_log + custom_log) if t["completed_at"]],
        key=lambda t: t["at"])

    return jsonify({
        "log": chapter_log,          # kept: the old key, same meaning
        "papers": paper_log,
        "custom": custom_log,
        "trend": trend,
        "counts": {"chapter": len(chapter_log), "paper": len(paper_log),
                   "custom": len(custom_log)},
        "pace_outliers": slow[:5],
        "pass_threshold": PASS_THRESHOLD,
    })


def _paper_row(doc, meta):
    """One row from `pyq_sessions`.

    pyq documents carry no `percentage` field — the original code read
    s.get("percentage", 0) and so scored every full paper as 0%. The real
    score lives in score_data.total_marks / max_marks.
    """
    s = doc.to_dict() or {}
    sd = s.get("score_data", {}) or {}
    tt = s.get("test_type") or "custom"
    arena = bool(s.get("arena_session"))

    total = sd.get("total_marks")
    mx = sd.get("max_marks") or 0
    pct = round(total / mx * 100, 1) if (total is not None and mx) else 0.0

    if tt == "full_paper":
        kind = "arena" if arena else "paper"
        label = s.get("label") or f"NEET {s.get('year', '')} {s.get('paper_code', '')}".strip()
    else:
        kind = "custom"
        label = s.get("label") or "Custom test"

    return {
        "kind": kind,
        "integrity": _integrity(s),
        "session_id": s.get("session_id", doc.id),
        "title": label or "Paper",
        "year": s.get("year"),
        "paper_code": str(s.get("paper_code") or ""),
        "arena": arena,
        "test_type": tt,
        "percentage": pct,
        "passed": pct >= PASS_THRESHOLD,
        "total_marks": total,
        "max_marks": mx or None,
        "accuracy": sd.get("accuracy"),
        "air": _air_number(sd.get("air_prediction")),
        "wrong_count": sd.get("wrong_count", 0),
        "skipped_count": sd.get("unattempted_count", 0),
        # These four were computed on every paper and thrown away. Marks per
        # subject is the number every NEET teacher in India manages against;
        # class_breakdown tells them whether to revise 11th or 12th; and
        # difficulty_breakdown separates careless from genuinely hard.
        "subject_breakdown": sd.get("subject_breakdown", {}),
        "class_breakdown": sd.get("class_breakdown", {}),
        "difficulty_breakdown": sd.get("difficulty_breakdown", {}),
        "weak_chapters": (sd.get("weak_chapters", []) or [])[:6],
        "qualifies": sd.get("qualifies"),
        "qualifying_marks": sd.get("qualifying_marks"),
        "time_taken_seconds": s.get("time_taken_seconds", 0),
        "time_limit_seconds": s.get("time_limit_seconds", 0),
        "completed_at": _iso(sd.get("completed_at")) or _iso(s.get("completed_at")),
    }


@teacher_bp.route("/api/teacher/student/<student_uid>/test/<session_id>/review", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_student
def teacher_review(student_uid, session_id):
    """Same gate as the parent route: completed sessions only. A teacher is
    not a threat model, but an in-progress session leaks unseen questions and
    there is no reason to build a second door into the same room."""
    # Chapter tests live in test_sessions, papers in pyq_sessions. The old
    # version only looked in the first, so reviewing a full paper 404'd.
    doc = _db().collection("test_sessions").document(session_id).get()
    is_paper = False
    if not doc.exists:
        doc = _db().collection("pyq_sessions").document(session_id).get()
        is_paper = True
    if not doc.exists:
        return jsonify({"error": "Test not found."}), 404
    s = doc.to_dict()
    if s.get("user_id") != student_uid:
        print(f"[teacher] SESSION SCOPE VIOLATION uid={request.uid} session={session_id}")
        return jsonify({"error": "Not this student's test."}), 403
    if s.get("status") != "completed":
        return jsonify({"error": "This test is still in progress.",
                        "code": "IN_PROGRESS"}), 403

    only_wrong = request.args.get("wrong") == "1"
    questions = []
    for i, q in enumerate(s.get("questions", []) or []):
        if only_wrong and q.get("is_correct"):
            continue
        questions.append({
            "index": i + 1,
            "question_text": q.get("question_text", ""),
            "options": q.get("options_detail", []),
            "correct_answer": q.get("correct_answer"),
            "student_answer": q.get("student_answer"),
            "is_correct": q.get("is_correct"),
            "attempted": q.get("student_answer") not in (None, "", {}),
            "difficulty": q.get("difficulty", ""),
            "concept_id": q.get("concept_id", ""),
            "explanation": q.get("detailed_explanation") or q.get("static_explanation", ""),
            "common_mistakes": q.get("common_mistakes", []),
            "ncert_page_quote": q.get("ncert_page_quote", ""),
            "has_image": q.get("has_image", False),
            "image_url": q.get("image_url"),
        })

    all_qs = s.get("questions", []) or []
    wrong_total = sum(1 for q in all_qs if q.get("is_correct") is False)

    if is_paper:
        sd = s.get("score_data", {}) or {}
        mx = sd.get("max_marks") or 0
        tot = sd.get("total_marks")
        title = s.get("label") or f"NEET {s.get('year','')} {s.get('paper_code','')}".strip()
        pct = round(tot / mx * 100, 1) if (tot is not None and mx) else 0.0
    else:
        title = chapter_meta().get(s.get("chapter_id", ""), {}).get("chapter_title", "")
        pct = round(float(s.get("percentage") or 0), 1)

    return jsonify({
        "session_id": session_id,
        "kind": "paper" if is_paper else "chapter",
        "chapter_name": title,          # kept key name: the client renders it as a title
        "title": title,
        "test_num": s.get("test_num"),
        "percentage": pct,
        "total_questions": s.get("total_questions", 0) or len(all_qs),
        "wrong_total": wrong_total,
        "wrong_only": only_wrong,
        "completed_at": _iso(s.get("completed_at")),
        "questions": questions,
    })


@teacher_bp.route("/api/teacher/student/<student_uid>/interventions", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_student
def teacher_interventions(student_uid):
    meta = chapter_meta()
    out = []
    for doc in _db().collection("user_progress") \
            .where("user_id", "==", student_uid).stream():
        p = doc.to_dict() or {}
        cid = p.get("chapter_id", "")
        for iv in (p.get("pending_interventions", []) or []):
            out.append({
                "chapter_id": cid,
                "chapter_name": meta.get(cid, {}).get("chapter_title", cid),
                "concept_id": iv.get("concept_id", ""),
                "concept_name": iv.get("concept_name", ""),
                "base_question_id": iv.get("base_question_id", ""),
                "reason": iv.get("reason", ""),
                "diagnosis": iv.get("diagnosis", ""),
                "created_at": _iso(iv.get("created_at")),
            })
    out.sort(key=lambda i: i["created_at"] or "", reverse=True)
    return jsonify({"interventions": out})


@teacher_bp.route("/api/teacher/student/<student_uid>/note", methods=["POST"])
@require_auth
@require_role("teacher")
@resolve_student
def teacher_note(student_uid):
    """Private to the writing teacher. Co-teachers do not see each other's
    notes, and no parent or student ever does."""
    note = (request.json or {}).get("note", "")[:2000]
    _db().collection("teacher_notes").document(f"{request.uid}_{student_uid}").set({
        "teacher_uid": request.uid,
        "student_uid": student_uid,
        "note": note,
        "updated_at": firestore.SERVER_TIMESTAMP,
    })
    return jsonify({"status": "ok"})


# ═══════════════════════════════════════════════════════════════════════════
# PENDING APPROVALS
#
# Students self-register and type a school code and section by hand. One typo
# and they vanish. This queue turns "the student is invisible and nobody knows
# why" into "a teacher sees a name they don't recognise and rejects it."
# ═══════════════════════════════════════════════════════════════════════════

@teacher_bp.route("/api/teacher/class/<class_key>/pending", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_class
def teacher_pending(class_key):
    out = []
    for doc in _db().collection("class_join_requests") \
            .where("class_key", "==", class_key) \
            .where("status", "==", "pending").stream():
        r = doc.to_dict() or {}
        out.append({
            "request_id": doc.id,
            "student_uid": r.get("student_uid", ""),
            "student_name": r.get("student_name", ""),
            "student_email": r.get("student_email", ""),
            "class_level": r.get("class_level", ""),
            "requested_school_id": r.get("requested_school_id", ""),
            "requested_class_id": r.get("requested_class_id", ""),
            "created_at": _iso(r.get("created_at")),
        })
    out.sort(key=lambda r: r["created_at"] or "", reverse=True)
    return jsonify({"pending": out, "count": len(out)})


@teacher_bp.route("/api/teacher/class/<class_key>/approve", methods=["POST"])
@require_auth
@require_role("teacher")
@resolve_class
def teacher_approve(class_key):
    return _resolve_request(class_key, "approved")


@teacher_bp.route("/api/teacher/class/<class_key>/reject", methods=["POST"])
@require_auth
@require_role("teacher")
@resolve_class
def teacher_reject(class_key):
    return _resolve_request(class_key, "rejected")


def _resolve_request(class_key, status, request_id=None):
    """The ONE place a join request is resolved.

    request_id is passed explicitly by teacher_home.approve_direct, which
    writes the request that should have existed for a student added
    outside the join flow and then hands off to here. One approval code
    path, one audit record, one call to rebuild_student_rollup.
    """
    rid = request_id or (request.json or {}).get("request_id", "")
    if not rid:
        return jsonify({"error": "request_id required"}), 400

    ref = _db().collection("class_join_requests").document(rid)
    doc = ref.get()
    if not doc.exists:
        return jsonify({"error": "Request not found."}), 404

    req = doc.to_dict()
    if req.get("class_key") != class_key:
        return jsonify({"error": "Request is not for this class."}), 403
    if req.get("status") != "pending":
        return jsonify({"error": "Already resolved.", "code": "RESOLVED"}), 409

    student_uid = req["student_uid"]
    ref.update({"status": status, "resolved_by": request.uid,
                "resolved_at": firestore.SERVER_TIMESTAMP})

    _db().collection("users").document(student_uid).set({
        "class_status": status if status == "approved" else "unassigned",
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)

    if status == "approved":
        cls_ref = _db().collection("classes").document(class_key)
        cur = cls_ref.get().to_dict() or {}
        cls_ref.update({"student_count": int(cur.get("student_count", 0)) + 1})

    # The roster reads rollups, so the student is invisible until this runs.
    rebuild_student_rollup(student_uid)

    return jsonify({"status": status, "student_uid": student_uid})


@teacher_bp.route("/api/teacher/class/<class_key>/settings", methods=["POST"])
@require_auth
@require_role("teacher")
@resolve_class
def teacher_settings(class_key):
    data = request.json or {}
    if "peer_comparison_enabled" not in data:
        return jsonify({"error": "Nothing to update."}), 400
    on = bool(data["peer_comparison_enabled"])
    _db().collection("classes").document(class_key).set({
        "settings": {"peer_comparison_enabled": on},
        "settings_updated_by": request.uid,
        "settings_updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)
    return jsonify({"status": "ok", "peer_comparison_enabled": on})


# ═══════════════════════════════════════════════════════════════════════════
# STUDENT SIDE — joining a class
# ═══════════════════════════════════════════════════════════════════════════

@teacher_bp.route("/api/student/class/join", methods=["POST"])
@require_auth
def student_join_class():
    """Called when a student saves school_id + class_id on their profile.

    Never grants access. It files a request. If the class doesn't exist —
    the typo case — the request is still filed against the derived key, so
    a real class created later inherits it, and until then the student sits
    in 'pending' rather than in a silent void.
    """
    uid = request.uid
    user = _user(uid) or {}
    if user.get("role", "student") != "student":
        return jsonify({"error": "Only students join classes."}), 403

    data = request.json or {}
    school = (data.get("school_id") or user.get("school_id") or "").strip().upper().replace(" ", "")
    section = (data.get("class_id") or user.get("class_id") or "").strip().upper().replace(" ", "")

    if not school or not section:
        return jsonify({"error": "School code and section are both required."}), 400

    key = f"{_academic_year()}_{section}"

    existing = list(_db().collection("class_join_requests")
                    .where("student_uid", "==", uid)
                    .where("status", "==", "pending").limit(5).stream())
    for d in existing:
        d.reference.update({"status": "superseded"})

    _db().collection("users").document(uid).set({
        "school_id": school, "class_id": section,
        "class_status": "pending",
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)

    ref = _db().collection("class_join_requests").document()
    ref.set({
        "student_uid": uid,
        "student_name": user.get("name", "Student"),
        "student_email": user.get("email", ""),
        "class_level": user.get("class_level", ""),
        "requested_school_id": school,
        "requested_class_id": section,
        "class_key": key,
        "status": "pending",
        "created_at": firestore.SERVER_TIMESTAMP,
    })

    cls = _db().collection("classes").document(key).get()
    known = cls.exists and cls.to_dict().get("school_id") == school

    return jsonify({
        "status": "pending",
        "class_key": key,
        "class_recognised": known,
        "message": ("Sent to your teacher for approval."
                    if known else
                    "We don't recognise that school code and section yet. "
                    "Double-check them with your teacher — we've saved the request either way."),
    })


@teacher_bp.route("/api/student/class/status", methods=["GET"])
@require_auth
def student_class_status():
    user = _user(request.uid) or {}
    return jsonify({
        "class_status": user.get("class_status", "unassigned"),
        "school_id": user.get("school_id", ""),
        "class_id": user.get("class_id", ""),
        "class_key": class_key_for(user),
    })


# ═══════════════════════════════════════════════════════════════════════════

def init_teacher(app):
    app.register_blueprint(teacher_bp)
    print(f"[teacher] {len(teacher_bp.deferred_functions)} teacher routes registered")
    return app

# ═══════════════════════════════════════════════════════════════════════════
# NOTES · SNOOZE · FOLLOW-UPS
#
# The old note was one textarea on one document, overwritten every save. A
# teacher asked to "keep a reminder of what they have to do" got a field that
# reminds nobody. This replaces it with an append-only timeline where any entry
# can carry a follow-up date, and those dates drive a strip on the Home screen.
#
# Storage stays at teacher_notes/{teacher_uid}_{student_uid} — one document per
# teacher-student pair, private to the writing teacher, holding entries[],
# snooze_until and a denormalised next_followup so Home costs one query.
# ═══════════════════════════════════════════════════════════════════════════

NOTE_MAX = 2000
NOTE_KEEP = 60          # entries retained per student; older ones roll off


def _note_ref(teacher_uid, student_uid):
    return _db().collection("teacher_notes").document(f"{teacher_uid}_{student_uid}")


def _note_doc(teacher_uid, student_uid):
    """Read the pair document, migrating the legacy single `note` string.

    Docs written by the previous version hold {"note": "..."} and no entries.
    Rather than run a migration job, the first read promotes that string to
    entry zero so nobody loses a note they wrote.
    """
    snap = _note_ref(teacher_uid, student_uid).get()
    if not snap.exists:
        return {"entries": [], "snooze_until": "", "next_followup": ""}
    d = snap.to_dict() or {}
    entries = d.get("entries")
    if entries is None:
        legacy = (d.get("note") or "").strip()
        entries = ([{"id": "legacy", "body": legacy,
                     "at": _iso(d.get("updated_at")) or "",
                     "follow_up": "", "done": False}] if legacy else [])
    return {
        "entries": entries,
        "snooze_until": d.get("snooze_until", "") or "",
        "next_followup": d.get("next_followup", "") or "",
    }


def _next_followup(entries):
    """Earliest open follow-up date, or "" — denormalised so the Home screen
    can filter without opening every entry array."""
    open_dates = sorted(e["follow_up"] for e in entries
                        if e.get("follow_up") and not e.get("done"))
    return open_dates[0] if open_dates else ""


@teacher_bp.route("/api/teacher/student/<student_uid>/notes", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_student
def teacher_notes_get(student_uid):
    d = _note_doc(request.uid, student_uid)
    d["entries"] = sorted(d["entries"], key=lambda e: e.get("at", ""), reverse=True)
    d["today"] = _ist_today().isoformat()
    return jsonify(d)


@teacher_bp.route("/api/teacher/student/<student_uid>/notes", methods=["POST"])
@require_auth
@require_role("teacher")
@resolve_student
def teacher_notes_add(student_uid):
    body = (request.json or {}).get("body", "").strip()[:NOTE_MAX]
    follow_up = ((request.json or {}).get("follow_up") or "").strip()[:10]
    if not body:
        return jsonify({"error": "Nothing to save."}), 400

    d = _note_doc(request.uid, student_uid)
    entry = {
        "id": f"n{int(datetime.now(timezone.utc).timestamp() * 1000)}",
        "body": body,
        "at": datetime.now(timezone.utc).isoformat(),
        "follow_up": follow_up,
        "done": False,
    }
    entries = ([entry] + d["entries"])[:NOTE_KEEP]

    r = request.student_rollup
    _note_ref(request.uid, student_uid).set({
        "teacher_uid": request.uid,
        "student_uid": student_uid,
        "student_name": r.get("name", ""),
        "class_key": r.get("class_key", ""),
        "entries": entries,
        "snooze_until": d["snooze_until"],
        "next_followup": _next_followup(entries),
        "updated_at": firestore.SERVER_TIMESTAMP,
    })
    return jsonify({"status": "ok", "entry": entry, "entries": entries})


@teacher_bp.route("/api/teacher/student/<student_uid>/notes/<entry_id>/done",
                  methods=["POST"])
@require_auth
@require_role("teacher")
@resolve_student
def teacher_notes_done(student_uid, entry_id):
    """Close a follow-up. The entry stays — the history is the point."""
    d = _note_doc(request.uid, student_uid)
    hit = False
    for e in d["entries"]:
        if e.get("id") == entry_id:
            e["done"] = True
            hit = True
    if not hit:
        return jsonify({"error": "Note not found."}), 404

    _note_ref(request.uid, student_uid).set({
        "entries": d["entries"],
        "next_followup": _next_followup(d["entries"]),
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)
    return jsonify({"status": "ok", "entries": d["entries"]})


@teacher_bp.route("/api/teacher/student/<student_uid>/snooze", methods=["POST"])
@require_auth
@require_role("teacher")
@resolve_student
def teacher_snooze(student_uid):
    """Hide a student from THIS teacher's deck for N days.

    It does not clear the alert, change the roster, or touch anything the
    student or parent sees. It is a personal 'I have dealt with this' marker.
    """
    days = int((request.json or {}).get("days", 7) or 7)
    days = max(1, min(30, days))
    until = (_ist_today() + timedelta(days=days)).isoformat()

    r = request.student_rollup
    _note_ref(request.uid, student_uid).set({
        "teacher_uid": request.uid,
        "student_uid": student_uid,
        "student_name": r.get("name", ""),
        "class_key": r.get("class_key", ""),
        "snooze_until": until,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)
    return jsonify({"status": "ok", "snooze_until": until, "days": days})


@teacher_bp.route("/api/teacher/student/<student_uid>/unsnooze", methods=["POST"])
@require_auth
@require_role("teacher")
@resolve_student
def teacher_unsnooze(student_uid):
    _note_ref(request.uid, student_uid).set(
        {"snooze_until": "", "updated_at": firestore.SERVER_TIMESTAMP}, merge=True)
    return jsonify({"status": "ok"})


def _teacher_pairs(teacher_uid):
    """Every teacher_notes document this teacher owns. One indexed query on a
    single field — no composite index to provision."""
    try:
        return [d.to_dict() or {} for d in
                _db().collection("teacher_notes")
                .where("teacher_uid", "==", teacher_uid).stream()]
    except Exception as e:
        print(f"[teacher] notes scan failed for {teacher_uid}: {e}")
        return []


def _snoozed_uids(teacher_uid):
    today = _ist_today().isoformat()
    return {p.get("student_uid") for p in _teacher_pairs(teacher_uid)
            if (p.get("snooze_until") or "") > today}


def _followups(teacher_uid, roster_by_uid):
    """Open follow-ups due on or before today, for students in THIS class."""
    today = _ist_today().isoformat()
    out = []
    for p in _teacher_pairs(teacher_uid):
        uid = p.get("student_uid")
        nf = p.get("next_followup") or ""
        if not nf or nf > today or uid not in roster_by_uid:
            continue
        entry = next((e for e in (p.get("entries") or [])
                      if e.get("follow_up") == nf and not e.get("done")), None)
        r = roster_by_uid[uid]
        out.append({
            "uid": uid,
            "name": r.get("name", p.get("student_name", "")),
            "initials": r.get("initials", "?"),
            "due": nf,
            "overdue_days": max(0, (_ist_today() -
                                    datetime.strptime(nf, "%Y-%m-%d").date()).days),
            "note_id": (entry or {}).get("id", ""),
            "body": ((entry or {}).get("body", ""))[:140],
        })
    out.sort(key=lambda f: f["due"])
    return out[:12]


@teacher_bp.route("/api/teacher/class/<class_key>/followups", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_class
def teacher_followups(class_key):
    roster = {r["uid"]: r for r in _roster(class_key)}
    return jsonify({"followups": _followups(request.uid, roster),
                    "today": _ist_today().isoformat()})


# ═══════════════════════════════════════════════════════════════════════════
# CLASS TESTS
#
# The one thing the portal could not answer: "how did my class do on Chapter 4
# Test 2?" Per-student scores existed; nothing aggregated them.
#
# COST. Naively this is one query per student per collection — 100 queries for
# fifty students, every time the tab opens. Two things stop that:
#   1. uids are batched ten at a time into `in` queries (10 queries, not 100)
#   2. the result is cached on classes/{key}/agg/tests for six hours
# A teacher who needs it fresher taps Refresh, which passes ?refresh=1.
# ═══════════════════════════════════════════════════════════════════════════

TESTS_TTL_HOURS = 6
BATCH = 10


def _batches(items, size=BATCH):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def _fresh(iso_str, hours):
    if not iso_str:
        return False
    try:
        then = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
    except Exception:
        return False
    if then.tzinfo is None:
        then = then.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - then) < timedelta(hours=hours)


def _build_class_tests(class_key, roster):
    meta = chapter_meta()
    uids = [r["uid"] for r in roster]
    names = {r["uid"]: r.get("name", "") for r in roster}

    chapters, papers, customs = {}, {}, {}
    distractors = {}

    for batch in _batches(uids):
        for doc in _db().collection("test_sessions") \
                .where("user_id", "in", batch) \
                .where("status", "==", "completed").stream():
            s = doc.to_dict() or {}
            cid = s.get("chapter_id", "")
            if cid not in meta:
                continue
            key = f"{cid}::{s.get('test_num')}"
            e = chapters.setdefault(key, {
                "key": key, "kind": "chapter",
                "chapter_id": cid,
                "title": meta[cid]["chapter_title"],
                "subject": meta[cid]["subject"],
                "test_num": s.get("test_num"),
                "scores": [], "attempts": 0, "integrity": [],
            })
            e["attempts"] += 1
            flags = _integrity(s)
            if flags:
                e["integrity"].append({
                    "uid": s.get("user_id"),
                    "name": names.get(s.get("user_id"), ""),
                    "session_id": s.get("session_id", doc.id),
                    **flags,
                })
            e["scores"].append({"uid": s.get("user_id"),
                                "name": names.get(s.get("user_id"), ""),
                                "pct": round(float(s.get("percentage") or 0), 1),
                                "flagged": bool(flags),
                                "session_id": s.get("session_id", doc.id)})

            # Distractor distribution. Which WRONG option the class converged
            # on is the most useful teaching artefact in this database, and
            # nothing surfaced it. If thirty students picked C, C is a
            # misconception with a name — not thirty careless errors.
            for q in (s.get("questions", []) or []):
                bid = q.get("base_question_id") or q.get("question_id")
                if not bid or q.get("student_answer") in (None, "", {}):
                    continue
                d = distractors.setdefault(bid, {
                    "base_question_id": bid,
                    "concept_id": q.get("concept_id", ""),
                    "chapter_id": cid,
                    "question_text": (q.get("question_text") or "")[:300],
                    "correct_answer": q.get("correct_answer"),
                    "answers": {}, "attempts": 0, "wrong": 0,
                })
                if not d["question_text"] and q.get("question_text"):
                    d["question_text"] = q["question_text"][:300]
                ans = str(q.get("student_answer"))
                d["answers"][ans] = d["answers"].get(ans, 0) + 1
                d["attempts"] += 1
                if q.get("is_correct") is False:
                    d["wrong"] += 1

        for doc in _db().collection("pyq_sessions") \
                .where("user_id", "in", batch) \
                .where("status", "==", "completed").stream():
            row = _paper_row(doc, meta)
            bucket = customs if row["kind"] == "custom" else papers
            key = (f"{row['year']}::{row['paper_code']}"
                   if row["kind"] != "custom" else row["title"])
            e = bucket.setdefault(key, {
                "key": key, "kind": row["kind"],
                "title": row["title"], "arena": row["arena"],
                "year": row["year"], "paper_code": row["paper_code"],
                "max_marks": row["max_marks"],
                "scores": [], "attempts": 0, "integrity": [],
            })
            e["attempts"] += 1
            if row.get("integrity"):
                e["integrity"].append({
                    "uid": doc.to_dict().get("user_id"),
                    "name": names.get(doc.to_dict().get("user_id"), ""),
                    "session_id": row["session_id"],
                    **row["integrity"],
                })
            e["scores"].append({"uid": doc.to_dict().get("user_id"),
                                "name": names.get(doc.to_dict().get("user_id"), ""),
                                "pct": row["percentage"],
                                "marks": row["total_marks"],
                                "air": row["air"],
                                "flagged": bool(row.get("integrity")),
                                "session_id": row["session_id"]})

    def finish(bucket):
        out = []
        for e in bucket.values():
            vals = [s["pct"] for s in e["scores"]]
            if not vals:
                continue
            best = max(e["scores"], key=lambda s: s["pct"])
            e["students"] = len({s["uid"] for s in e["scores"]})
            e["avg"] = round(sum(vals) / len(vals), 1)
            e["median"] = _quantile(sorted(vals), .5)
            e["low"] = round(min(vals), 1)
            e["high"] = round(max(vals), 1)
            e["pass_rate"] = round(
                sum(1 for v in vals if v >= PASS_THRESHOLD) / len(vals) * 100)
            e["below"] = sum(1 for v in vals if v < PASS_THRESHOLD)
            e["top_name"] = best.get("name", "")
            e["flagged_count"] = len(e.get("integrity", []))
            e["scores"] = sorted(e["scores"], key=lambda s: -s["pct"])[:60]
            e["integrity"] = e.get("integrity", [])[:20]
            out.append(e)
        return out

    chapter_rows = sorted(finish(chapters), key=lambda e: e["avg"])
    paper_rows = sorted(finish(papers),
                        key=lambda e: (str(e["year"] or ""), e["paper_code"]),
                        reverse=True)
    custom_rows = sorted(finish(customs), key=lambda e: -e["attempts"])

    # Rank the distractor table by how concentrated the wrong answers are —
    # a question where 80% of the wrong answers landed on one option is a
    # misconception; one where they scattered evenly is just a hard question.
    dtable = []
    for d in distractors.values():
        if d["wrong"] < max(3, round(len(uids) * 0.25)):
            continue
        wrong_only = {k: v for k, v in d["answers"].items()
                      if str(k) != str(d["correct_answer"])}
        if not wrong_only:
            continue
        top_opt, top_n = max(wrong_only.items(), key=lambda kv: kv[1])
        d["top_wrong_option"] = top_opt
        d["top_wrong_count"] = top_n
        d["concentration"] = round(top_n / sum(wrong_only.values()) * 100)
        d["wrong_pct"] = round(d["wrong"] / d["attempts"] * 100) if d["attempts"] else 0
        dtable.append(d)
    dtable.sort(key=lambda d: (-d["wrong"], -d["concentration"]))

    return {
        "built_at": datetime.now(timezone.utc).isoformat(),
        "distractors": dtable[:15],
        "chapter_tests": chapter_rows[:80],
        "papers": paper_rows[:40],
        "custom": custom_rows[:40],
        "counts": {"chapter": len(chapter_rows), "paper": len(paper_rows),
                   "custom": len(custom_rows)},
        "students": len(uids),
    }


@teacher_bp.route("/api/teacher/class/<class_key>/tests", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_class
def teacher_class_tests(class_key):
    ref = _db().collection("classes").document(class_key) \
        .collection("agg").document("tests")
    refresh = request.args.get("refresh") == "1"

    if not refresh:
        snap = ref.get()
        if snap.exists:
            d = snap.to_dict() or {}
            if _fresh(d.get("built_at", ""), TESTS_TTL_HOURS):
                d["cached"] = True
                return jsonify(d)

    roster = _roster(class_key)
    if not roster:
        return jsonify({"chapter_tests": [], "papers": [], "custom": [],
                        "counts": {"chapter": 0, "paper": 0, "custom": 0},
                        "students": 0, "empty": True})

    built = _build_class_tests(class_key, roster)
    try:
        ref.set(built)
    except Exception as e:
        print(f"[teacher] tests agg cache write failed for {class_key}: {e}")
    built["cached"] = False
    return jsonify(built)


# ═══════════════════════════════════════════════════════════════════════════
# THE TEACHER'S OWN AUDIT TRAIL
#
# Every contact reveal is already logged against the teacher's name. Showing
# that log back to them is what makes it read as accountability rather than
# surveillance — and it is the fastest way for a teacher to answer a
# coordinator asking why a parent was called.
# ═══════════════════════════════════════════════════════════════════════════

@teacher_bp.route("/api/teacher/my-access-log", methods=["GET"])
@require_auth
@require_role("teacher")
def teacher_access_log():
    out = []
    try:
        q = _db().collection("pii_access_log") \
            .where("actor_uid", "==", request.uid) \
            .order_by("at", direction=firestore.Query.DESCENDING).limit(50)
        for doc in q.stream():
            d = doc.to_dict() or {}
            out.append({
                "student_name": d.get("target_student_name", ""),
                "fields": d.get("fields", []),
                "class_key": d.get("class_key", ""),
                "at": _iso(d.get("at")),
            })
    except Exception as e:
        # Missing composite index should degrade to an empty list, never a 500
        # on the profile screen.
        print(f"[teacher] access log read failed for {request.uid}: {e}")
        return jsonify({"entries": [], "unavailable": True})
    return jsonify({"entries": out, "unavailable": False})


# ═══════════════════════════════════════════════════════════════════════════
# NOTIFICATION PREFERENCES
# ═══════════════════════════════════════════════════════════════════════════

TEACHER_PREF_KEYS = ("weekly_digest", "at_risk_alerts", "join_requests")


@teacher_bp.route("/api/teacher/prefs", methods=["POST"])
@require_auth
@require_role("teacher")
def teacher_prefs():
    body = request.json or {}
    prefs = {k: bool(body[k]) for k in TEACHER_PREF_KEYS if k in body}
    if not prefs:
        return jsonify({"error": "Nothing to save."}), 400
    _db().collection("users").document(request.uid).set(
        {"teacher_prefs": prefs}, merge=True)
    return jsonify({"status": "ok", "prefs": prefs})