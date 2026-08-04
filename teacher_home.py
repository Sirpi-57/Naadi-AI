"""
NAADI AI — TEACHER HOME v2  (teacher_home.py)
═══════════════════════════════════════════════════════════════════════════

A THIRD Blueprint on the same Flask app. It does not modify
teacher_backend.py — the existing screens keep working untouched while
this one is tested. Delete-safe: remove the registration line and the app
returns to exactly its previous behaviour.

───────────────────────────────────────────────────────────────────────────
THE TWO READERS

The same class is read by two people with different jobs.

  CLASS TEACHER   owns 11-B. Does not teach them Physics. Her job is to
                  notice that Arjun stopped opening the app, that eight
                  students are stuck in Chemistry while Biology moves
                  fine, and to carry that to the right subject teacher or
                  the right parent. She is a ROUTER, not an instructor.
                  Her page is: names, then subjects, then one pulse.

  SUBJECT TEACHER teaches Chemistry to 11-B and to four other sections.
                  She cannot act on "Arjun is quiet in Biology". Her page
                  is one subject in depth: which chapters are weakest,
                  which question the class is failing and WHICH WRONG
                  OPTION they picked, and which students are struggling
                  in HER subject only.

Same data, same permissions, same components. Different composition. That
is the entire argument for one endpoint with a role branch rather than
two portals.

───────────────────────────────────────────────────────────────────────────
ROLE STORAGE

Firestore has one role: "teacher". That does not change — auth,
require_role and every existing route keep working exactly as they are.

The class-role lives on the teacher's user document, keyed by class:

    users/{uid}.class_roles = {
        "SCHOOL01_11B": {"role": "class_teacher", "subjects": []},
        "SCHOOL01_12A": {"role": "subject_teacher",
                         "subjects": ["Physics", "Chemistry"]},
    }

Keyed by class because the same person is genuinely the class teacher of
11-B and the Physics teacher of 12-A, and a single flat field would force
them to pick one identity for both.

  ⚠️  THIS IS SELF-DECLARED AND THEREFORE UNVERIFIED. Anyone who can
      reach a class can claim to be its class teacher. That is acceptable
      for your pilot and NOT acceptable in production. When you are ready
      to lock it down, set NAADI_ROLES_LOCKED=1 and the POST below starts
      refusing writes for any class that already has a declared class
      teacher — the coordinator assigns it in the admin portal instead.
      No client change is needed; the UI already handles the 403.

───────────────────────────────────────────────────────────────────────────
GUARDIAN CONTACT

Reveal is CLASS TEACHER ONLY, enforced server-side in
require_class_teacher. Three subject teachers independently phoning the
same parent is a mess you cannot un-send. Subject teachers get
"flag to class teacher" instead, which routes the concern to the one
person whose job it is to make that call.
"""

import os
from datetime import datetime, timezone, timedelta
from functools import wraps

from flask import Blueprint, request, jsonify
from firebase_admin import firestore

from portal_backend import (
    require_auth, require_role, _db, _user, _clean, _iso, _initials,
    _days_since, chapter_meta, SUBJECTS,
)
from teacher_backend import (
    resolve_class, resolve_student, _roster,
    # _followups has been reachable only from teacher_deck() -- the OLD
    # home -- since it was written. A reminder a teacher sets on a note
    # was therefore never surfaced anywhere she looks now.
    _followups,
    # The one place a join request is resolved. approve_direct writes the
    # request that should have existed and hands off to it, so there is a
    # single approval path and a single call to rebuild_student_rollup.
    _resolve_request,
)
from teacher_signals import (
    flags_for, class_pace_median, canon_subject, MIN_TESTS, MIN_PACE_Q,
)

home_bp = Blueprint("teacher_home", __name__)

MAX_VISIBLE_FLAGS = 6       # beyond this it is wallpaper, not a to-do list
ROLES_LOCKED = os.environ.get("NAADI_ROLES_LOCKED") == "1"

VALID_ROLES = ("class_teacher", "subject_teacher")


# ═══════════════════════════════════════════════════════════════════════
# ROLE HELPERS
# ═══════════════════════════════════════════════════════════════════════

def class_role_for(user, class_key):
    """This teacher's declared role in this class. Never raises.

    Returns {"role": str|None, "subjects": [str]}. A None role means the
    teacher has not chosen yet and the client must show the picker.
    """
    roles = (user or {}).get("class_roles", {}) or {}
    rec = roles.get(class_key) or {}
    role = rec.get("role")
    if role not in VALID_ROLES:
        role = None
    subs = [canon_subject(s) for s in (rec.get("subjects") or [])]
    subs = [s for s in subs if s != "Unassigned"][:2]
    return {"role": role, "subjects": subs}


def require_class_teacher(f):
    """Gate for anything only the class teacher may do — contact reveal.

    Runs AFTER resolve_class, so scope is already proven; this checks the
    narrower question of which job this teacher holds in that class.
    """
    @wraps(f)
    def inner(class_key, *a, **kw):
        u = getattr(request, "user_doc", None) or _user(request.uid) or {}
        cr = class_role_for(u, class_key)
        if cr["role"] != "class_teacher":
            return jsonify({
                "error": "Only the class teacher can do this.",
                "code": "NOT_CLASS_TEACHER",
            }), 403
        return f(class_key, *a, **kw)
    return inner


@home_bp.route("/api/teacher/class/<class_key>/my-role", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_class
def get_my_role(class_key):
    u = request.user_doc
    cr = class_role_for(u, class_key)

    # Who else holds a role here — so the picker can warn "Priya M is
    # already the class teacher" before a second person claims it.
    taken = {"class_teacher": [], "subjects": {}}
    try:
        for tuid in (request.class_doc.get("teacher_uids", []) or []):
            if tuid == request.uid:
                continue
            t = _user(tuid) or {}
            tcr = class_role_for(t, class_key)
            nm = t.get("name", "A teacher")
            if tcr["role"] == "class_teacher":
                taken["class_teacher"].append(nm)
            for s in tcr["subjects"]:
                taken["subjects"].setdefault(s, []).append(nm)
    except Exception as e:
        print(f"[home] peer role read failed: {e}")

    return jsonify({
        "class_key": class_key,
        "role": cr["role"],
        "subjects": cr["subjects"],
        "needs_setup": cr["role"] is None,
        "locked": ROLES_LOCKED,
        "available_subjects": SUBJECTS,
        "taken": taken,
    })


@home_bp.route("/api/teacher/class/<class_key>/my-role", methods=["POST"])
@require_auth
@require_role("teacher")
@resolve_class
def set_my_role(class_key):
    body = request.get_json(silent=True) or {}
    role = body.get("role")
    subjects = body.get("subjects") or []

    if role not in VALID_ROLES:
        return jsonify({"error": "Pick class teacher or subject teacher."}), 400

    if role == "subject_teacher":
        subjects = [canon_subject(s) for s in subjects]
        subjects = [s for s in subjects if s in SUBJECTS]
        if not subjects:
            return jsonify({"error": "Choose at least one subject."}), 400
        subjects = subjects[:2]     # one or two, per spec
    else:
        subjects = []

    if ROLES_LOCKED:
        return jsonify({
            "error": "Roles are set by your school coordinator.",
            "code": "ROLES_LOCKED",
        }), 403

    try:
        _db().collection("users").document(request.uid).set(
            {"class_roles": {class_key: {
                "role": role,
                "subjects": subjects,
                "set_at": _now_iso(),
            }}}, merge=True)
    except Exception as e:
        print(f"[home] role write failed uid={request.uid}: {e}")
        return jsonify({"error": "Could not save. Please try again."}), 500

    return jsonify({"ok": True, "role": role, "subjects": subjects})


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


# ═══════════════════════════════════════════════════════════════════════
# SHARED COMPUTATION
#
# Both home pages read the SAME roster and the SAME flag engine. Only the
# slicing differs. Computing this once here is what keeps a class of 50 at
# ~50 document reads for either reader.
# ═══════════════════════════════════════════════════════════════════════

def _subject_of(cid, meta):
    return canon_subject((meta.get(cid, {}) or {}).get("subject"))


def _class_context(class_key, roster, meta):
    return {
        "class_pace_median": class_pace_median(roster),
        "meta": meta,
    }


def _student_brief(r):
    """The identity fields every card needs. No contact details — those
    are revealed through a separate, audited, class-teacher-only route."""
    return {
        "uid": r.get("uid", ""),
        "name": r.get("name", "Student"),
        "initials": r.get("initials") or _initials(r.get("name")),
        "photo_url": r.get("photo_url", ""),
        "last_active_at": r.get("last_active_at", ""),
        "days_quiet": _days_since(r.get("last_active_at")),
    }


def _subject_rollup(roster, meta):
    """Per-subject class picture. The three cards on the class teacher's page.

    Each subject reports:
      coverage_pct  what share of the subject's chapters the class has
                    actually finished — averaged per student, so one keen
                    student cannot carry the class average
      avg_pct       class average accuracy in that subject, gated
      behind        how many students are in the bottom band
      states        chapter-state totals, for the stacked bar
    """
    out = {}
    subs = set()
    for cid, m in (meta or {}).items():
        subs.add(canon_subject(m.get("subject")))

    for sub in sorted(subs):
        chapters_total = sum(
            1 for cid, m in meta.items() if canon_subject(m.get("subject")) == sub)
        if not chapters_total:
            continue

        acc_num = acc_den = 0
        cov_sum = 0.0
        cov_n = 0
        states = {"complete": 0, "testing": 0, "read_only": 0, "not_started": 0}
        behind = 0

        for r in roster:
            sig = r.get("signals", {}) or {}
            b = (sig.get("chapters_by_subject", {}) or {}).get(sub)
            if b:
                for k in states:
                    states[k] += int(b.get(k, 0) or 0)
                done = int(b.get("complete", 0) or 0)
                cov_sum += (done / chapters_total * 100) if chapters_total else 0
                cov_n += 1

            ps = (r.get("per_subject", {}) or {}).get(sub) or {}
            seen = int(ps.get("questions", 0) or 0)
            acc = ps.get("accuracy")
            if acc is not None and seen > 0:
                acc_num += acc * seen
                acc_den += seen
                if acc < 40:
                    behind += 1

        out[sub] = {
            "subject": sub,
            "chapters_total": chapters_total,
            "coverage_pct": round(cov_sum / cov_n, 1) if cov_n else 0.0,
            "avg_pct": round(acc_num / acc_den, 1) if acc_den else None,
            "students_behind": behind,
            "states": states,
            "students_with_data": cov_n,
        }
    return out


def _chapter_rollup(roster, meta, subject=None):
    """Per-chapter class picture, optionally scoped to one subject.

    This is the subject teacher's main list and the class teacher's
    drill-down. Sorted by "most students currently mid-chapter" so the
    chapter the class is actually working on floats to the top — there is
    no assigned-chapter field in the system (three subject teachers, no
    single owner of 'what we are doing this week'), so activity is the
    only honest way to infer it.
    """
    rows = {}
    for cid, m in (meta or {}).items():
        sub = canon_subject(m.get("subject"))
        if subject and sub != subject:
            continue
        rows[cid] = {
            "chapter_id": cid,
            "chapter_name": m.get("chapter_title", "") or cid,
            "subject": sub,
            "class_level": m.get("class", ""),
            "number": m.get("chapter_number", 0),
            "complete": 0, "testing": 0, "read_only": 0, "not_started": 0,
            "acc_num": 0.0, "acc_den": 0,
        }

    for r in roster:
        pc = r.get("per_chapter", {}) or {}
        sig = r.get("signals", {}) or {}
        read_only_ids = {c["chapter_id"]
                         for c in (sig.get("studio_read_not_tested") or [])}
        for cid, row in rows.items():
            ch = pc.get(cid)
            if ch and ch.get("complete"):
                row["complete"] += 1
            elif ch and int(ch.get("tests", 0) or 0) > 0:
                row["testing"] += 1
            elif cid in read_only_ids:
                row["read_only"] += 1
            else:
                row["not_started"] += 1

            if ch and ch.get("accuracy") is not None:
                seen = int(ch.get("concepts_attempted", 0) or 0) or 1
                row["acc_num"] += ch["accuracy"] * seen
                row["acc_den"] += seen

    out = []
    n = max(len(roster), 1)
    for row in rows.values():
        row["avg_pct"] = (round(row["acc_num"] / row["acc_den"], 1)
                          if row["acc_den"] else None)
        row.pop("acc_num"), row.pop("acc_den")
        row["active"] = row["testing"]
        row["touched"] = row["complete"] + row["testing"] + row["read_only"]
        row["students"] = n
        out.append(row)

    out.sort(key=lambda r: (-r["active"], -r["touched"], r["number"]))
    return out


# ═══════════════════════════════════════════════════════════════════════
# THE HOME ENDPOINT
# ═══════════════════════════════════════════════════════════════════════

@home_bp.route("/api/teacher/class/<class_key>/home", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_class
def teacher_home(class_key):
    u = request.user_doc
    cls = request.class_doc
    cr = class_role_for(u, class_key)

    if cr["role"] is None:
        # The client shows the picker. We still return the header so the
        # picker can say which class it is about.
        return jsonify({
            "needs_role": True,
            "header": _header(class_key, cls, []),
        })

    roster = _roster(class_key)
    meta = chapter_meta()
    ctx = _class_context(class_key, roster, meta)

    header = _header(class_key, cls, roster)
    header["role"] = cr["role"]
    header["subjects"] = cr["subjects"]
    header["teacher_name"] = u.get("name", "Teacher")

    if cr["role"] == "class_teacher":
        return jsonify(_class_teacher_home(class_key, roster, meta, ctx, header))
    return jsonify(_subject_teacher_home(
        class_key, roster, meta, ctx, header, cr["subjects"]))


def _header(class_key, cls, roster):
    active_week = 0
    for r in roster:
        d = _days_since(r.get("last_active_at"))
        if d is not None and d <= 7:
            active_week += 1

    pending = 0
    try:
        pending = sum(1 for _ in _db().collection("class_join_requests")
                      .where("class_key", "==", class_key)
                      .where("status", "==", "pending").stream())
    except Exception as e:
        print(f"[home] pending count failed: {e}")

    return {
        "class_key": class_key,
        "class_id": cls.get("class_id", ""),
        "school_name": cls.get("school_name", "") or cls.get("school_id", ""),
        "academic_year": cls.get("academic_year"),
        "students": len(roster),
        "active_this_week": active_week,
        "pending_approvals": pending,
    }


# ── CLASS TEACHER ──────────────────────────────────────────────────────

def _class_teacher_home(class_key, roster, meta, ctx, header):
    """Names first, subjects second, one pulse third.

    Deliberately NOT included: the most-missed question and its wrong-option
    split. It is a superb artefact and it is for the subject teacher — the
    class teacher cannot reteach a Chemistry question and putting it here
    would be the same mistake the old portal made, showing people numbers
    they have no way to act on.
    """
    flagged = []
    for r in roster:
        fl = flags_for(r, ctx)
        if not fl:
            continue
        top = fl[0]
        flagged.append({
            **_student_brief(r),
            "reason": top["text"],
            "kind": top["kind"],
            "subject": top["subject"],
            "severity": top["severity"],
            "share_text": _share_line(r, top, header),
            "other_reasons": [f["text"] for f in fl[1:3]],
            "flag_count": len(fl),
        })
    flagged.sort(key=lambda s: -s["severity"])

    # Teacher-raised flags from subject teachers, newest first. These sit
    # alongside the system-generated ones because to her they are the same
    # thing: something that needs her attention today.
    raised = _open_raised_flags(class_key)

    doing_well = sorted(
        [r for r in roster if not flags_for(r, ctx)
         and (r.get("tests_completed") or 0) >= MIN_TESTS],
        key=lambda r: -(r.get("accuracy") or 0))[:8]

    return {
        "needs_role": False,
        "view": "class_teacher",
        "header": header,
        "attention": {
            "visible": flagged[:MAX_VISIBLE_FLAGS],
            "hidden_count": max(0, len(flagged) - MAX_VISIBLE_FLAGS),
            "total": len(flagged),
        },
        "raised_flags": raised,
        # Notes she asked to be reminded about, due on or before today.
        "followups": _followups(request.uid, {r["uid"]: r for r in roster}),
        # Students whose account already claims this school and section
        # but who were never approved, and who have no join request
        # either. Until now they appeared on NO screen at all.
        "awaiting_approval": awaiting_approval(class_key, request.class_doc),
        "subjects": list(_subject_rollup(roster, meta).values()),
        "pulse": _pulse(roster),
        "doing_well": [{**_student_brief(r),
                        "accuracy": r.get("accuracy"),
                        "tests": r.get("tests_completed", 0)} for r in doing_well],
        "quiet_ok": len(roster) - len(flagged),
        "gates": {"min_tests": MIN_TESTS, "min_questions": MIN_PACE_Q},
    }


def _share_line(r, flag, header):
    """The WhatsApp line. Her actual workflow is forwarding this to a
    subject teacher or a parent, so we build the sentence for her rather
    than making her retype a dashboard into a chat window."""
    cls = header.get("class_id", "")
    return f"{r.get('name', 'Student')} ({cls}) {flag.get('share', flag['text'])}"


def _pulse(roster):
    """One honest block. Activity, and the NEET paper picture if it exists."""
    n = max(len(roster), 1)
    active7 = sum(1 for r in roster
                  if (_days_since(r.get("last_active_at")) or 999) <= 7)

    marks, subj_tot, papers = [], {}, 0
    for r in roster:
        a = (r.get("signals", {}) or {}).get("arena_last")
        if not a or a.get("marks") is None:
            continue
        papers += 1
        marks.append(a["marks"])
        for s, v in (a.get("subjects") or {}).items():
            b = subj_tot.setdefault(canon_subject(s), {"sum": 0, "n": 0, "max": v.get("max", 180)})
            b["sum"] += v.get("marks", 0) or 0
            b["n"] += 1

    return {
        "active_this_week": active7,
        "active_pct": round(active7 / n * 100),
        "students": len(roster),
        "papers_attempted_by": papers,
        "avg_paper_marks": round(sum(marks) / len(marks)) if marks else None,
        "paper_subjects": [
            {"subject": s, "avg": round(v["sum"] / v["n"]), "max": v["max"]}
            for s, v in sorted(subj_tot.items()) if v["n"]
        ],
    }


# ── SUBJECT TEACHER ────────────────────────────────────────────────────

def _subject_teacher_home(class_key, roster, meta, ctx, header, subjects):
    """One subject (or two) in depth.

    This is where everything the class teacher should NOT be shown lives:
    the chapter league table, the most-missed question with its wrong-option
    convergence, and the AI-written misconception text.
    """
    subjects = subjects or SUBJECTS[:1]
    primary = subjects[0]

    flagged = []
    for r in roster:
        fl = [f for f in flags_for(r, ctx)
              if not f["subject"] or f["subject"] in subjects]
        if not fl:
            continue
        top = fl[0]
        flagged.append({
            **_student_brief(r),
            "reason": top["text"],
            "kind": top["kind"],
            "subject": top["subject"],
            "severity": top["severity"],
            "other_reasons": [f["text"] for f in fl[1:3]],
        })
    flagged.sort(key=lambda s: -s["severity"])

    per_subject = []
    for sub in subjects:
        chapters = _chapter_rollup(roster, meta, subject=sub)
        weakest = sorted(
            [c for c in chapters if c["avg_pct"] is not None and c["touched"] >= 3],
            key=lambda c: c["avg_pct"])[:6]
        per_subject.append({
            "subject": sub,
            "chapters": chapters[:30],
            "weakest": weakest,
            "summary": _subject_rollup(roster, meta).get(sub, {}),
        })

    return {
        "needs_role": False,
        "view": "subject_teacher",
        "header": header,
        "subjects_taught": subjects,
        "primary_subject": primary,
        "per_subject": per_subject,
        "attention": {
            "visible": flagged[:MAX_VISIBLE_FLAGS],
            "hidden_count": max(0, len(flagged) - MAX_VISIBLE_FLAGS),
            "total": len(flagged),
        },
        "missed_questions": _missed_questions(roster, meta, subjects),
        "misconceptions": _misconceptions(class_key, roster, meta, subjects),
        "gates": {"min_tests": MIN_TESTS, "min_questions": MIN_PACE_Q},
    }


def _missed_questions(roster, meta, subjects):
    """The questions this class fails most, scoped to the subject.

    NOTE ON THE OLD BUG — the previous most-failed list rendered
    "Question text unavailable" for nearly every row. It looked up
    questions/{base_question_id}, but base_question_id lives inside
    meta_data while the DOCUMENT id is the variation id, so the lookup
    missed every time. It is fixed here by not doing the lookup at all:
    question_text is already denormalised onto base_question_tracking's
    variation_history and copied onto the rollup's failed_bases. Zero
    extra reads, and it cannot drift out of sync.
    """
    agg = {}
    for r in roster:
        for b in (r.get("failed_bases", []) or []):
            cid = b.get("chapter_id", "")
            sub = _subject_of(cid, meta)
            if subjects and sub not in subjects:
                continue
            bid = b.get("base_question_id") or b.get("concept_id")
            if not bid:
                continue
            e = agg.setdefault(bid, {
                "base_question_id": bid,
                "chapter_id": cid,
                "chapter_name": (meta.get(cid, {}) or {}).get("chapter_title", ""),
                "subject": sub,
                "question_text": b.get("question_text", ""),
                "students": 0,
                "failures": 0,
                "names": [],
            })
            e["students"] += 1
            e["failures"] += int(b.get("failures", 0) or 0)
            if not e["question_text"] and b.get("question_text"):
                e["question_text"] = b["question_text"]
            if len(e["names"]) < 8:
                e["names"].append(r.get("name", ""))

    rows = [e for e in agg.values() if e["students"] >= 2]
    rows.sort(key=lambda e: (-e["students"], -e["failures"]))
    return rows[:8]


def _misconceptions(class_key, roster, meta, subjects):
    """Gemini's written diagnosis, surfaced to the person who can use it.

    ai_interventions already contains sentences like "confuses the loop of
    Henle with the DCT, and here is the trap that keeps catching them".
    That is a finished thought a teacher can act on in the next lesson, and
    it has never been visible to anyone. Capped hard because this is a
    read-per-student collection and the value is in the top few, not in
    completeness.
    """
    uids = {r["uid"] for r in roster}
    out = []
    try:
        q = _db().collection("ai_interventions") \
            .where("class_key", "==", class_key) \
            .limit(60).stream()
        for doc in q:
            d = doc.to_dict() or {}
            if d.get("user_id") not in uids:
                continue
            cid = d.get("chapter_id", "")
            sub = _subject_of(cid, meta)
            if subjects and sub not in subjects:
                continue
            text = (d.get("misconception") or d.get("pattern_analysis") or "").strip()
            if not text:
                continue
            out.append({
                "concept_name": d.get("concept_name", ""),
                "chapter_name": (meta.get(cid, {}) or {}).get("chapter_title", ""),
                "subject": sub,
                "misconception": text[:400],
                "trap": (d.get("common_trap") or "")[:300],
                "is_regression": bool(d.get("is_regression")),
            })
    except Exception as e:
        print(f"[home] misconception read failed: {e}")

    # Cluster identical diagnoses — five students with the same
    # misconception is a reteach, one student is a conversation.
    grouped = {}
    for m in out:
        k = (m["concept_name"], m["misconception"][:120])
        g = grouped.setdefault(k, {**m, "students": 0})
        g["students"] += 1
    rows = sorted(grouped.values(), key=lambda m: -m["students"])
    return rows[:6]


# ═══════════════════════════════════════════════════════════════════════
# FLAG TO CLASS TEACHER
#
# Closes the loop in the other direction. The class teacher routes to
# subject teachers; this lets a subject teacher route back. Without it the
# multi-teacher setup is just several logins pointed at the same data.
# ═══════════════════════════════════════════════════════════════════════

@home_bp.route("/api/teacher/class/<class_key>/raise-flag", methods=["POST"])
@require_auth
@require_role("teacher")
@resolve_class
def raise_flag(class_key):
    body = request.get_json(silent=True) or {}
    student_uid = (body.get("student_uid") or "").strip()
    note = (body.get("note") or "").strip()[:500]
    if not student_uid or not note:
        return jsonify({"error": "Pick a student and write a short note."}), 400

    # Prove the student is in THIS class before writing anything.
    snap = _db().collection("student_rollups").document(student_uid).get()
    if not snap.exists or (snap.to_dict() or {}).get("class_key") != class_key:
        return jsonify({"error": "Not your student."}), 403

    u = request.user_doc
    cr = class_role_for(u, class_key)
    try:
        _db().collection("teacher_raised_flags").add({
            "class_key": class_key,
            "student_uid": student_uid,
            "student_name": (snap.to_dict() or {}).get("name", ""),
            "raised_by_uid": request.uid,
            "raised_by_name": u.get("name", "A teacher"),
            "raised_by_subjects": cr["subjects"],
            "note": note,
            "status": "open",
            "created_at": firestore.SERVER_TIMESTAMP,
        })
    except Exception as e:
        print(f"[home] raise flag failed: {e}")
        return jsonify({"error": "Could not send. Please try again."}), 500
    return jsonify({"ok": True})


@home_bp.route("/api/teacher/class/<class_key>/raised-flags/<flag_id>/close",
               methods=["POST"])
@require_auth
@require_role("teacher")
@resolve_class
@require_class_teacher
def close_raised_flag(class_key, flag_id):
    try:
        ref = _db().collection("teacher_raised_flags").document(flag_id)
        doc = ref.get()
        if not doc.exists or (doc.to_dict() or {}).get("class_key") != class_key:
            return jsonify({"error": "Not found."}), 404
        ref.set({"status": "closed",
                 "closed_at": firestore.SERVER_TIMESTAMP,
                 "closed_by": request.uid}, merge=True)
    except Exception as e:
        print(f"[home] close flag failed: {e}")
        return jsonify({"error": "Could not close."}), 500
    return jsonify({"ok": True})


def _open_raised_flags(class_key):
    out = []
    try:
        for doc in _db().collection("teacher_raised_flags") \
                .where("class_key", "==", class_key) \
                .where("status", "==", "open").limit(20).stream():
            d = doc.to_dict() or {}
            out.append({
                "id": doc.id,
                "student_uid": d.get("student_uid", ""),
                "student_name": d.get("student_name", ""),
                "note": d.get("note", ""),
                "by": d.get("raised_by_name", "A teacher"),
                "subjects": d.get("raised_by_subjects", []),
                "at": _iso(d.get("created_at")),
            })
    except Exception as e:
        print(f"[home] raised flags read failed: {e}")
    out.sort(key=lambda f: f["at"], reverse=True)
    return out


# ═══════════════════════════════════════════════════════════════════════
# GUARDIAN CONTACT — CLASS TEACHER ONLY
#
# The existing reveal route in teacher_backend allows any teacher on the
# class. This one narrows it, and the client only ever calls this one.
# When you retire the old route, this becomes the single door.
# ═══════════════════════════════════════════════════════════════════════

@home_bp.route("/api/teacher/class/<class_key>/student/<student_uid>/contact",
               methods=["POST"])
@require_auth
@require_role("teacher")
@resolve_class
@require_class_teacher
def reveal_contact(class_key, student_uid):
    snap = _db().collection("student_rollups").document(student_uid).get()
    if not snap.exists or (snap.to_dict() or {}).get("class_key") != class_key:
        return jsonify({"error": "Not your student."}), 403
    r = snap.to_dict() or {}

    fields = [f for f in ("guardian_name", "guardian_phone", "guardian_email")
              if r.get(f)]
    try:
        _db().collection("teacher_access_log").add({
            "teacher_uid": request.uid,
            "teacher_name": (request.user_doc or {}).get("name", ""),
            "class_key": class_key,
            "student_uid": student_uid,
            "student_name": r.get("name", ""),
            "fields": fields,
            "at": firestore.SERVER_TIMESTAMP,
        })
    except Exception as e:
        # The log failing must not silently hand over a phone number.
        print(f"[home] AUDIT WRITE FAILED uid={request.uid} student={student_uid}: {e}")
        return jsonify({"error": "Could not record this access. Try again."}), 500

    return jsonify({
        "guardian_name": r.get("guardian_name", ""),
        "guardian_phone": r.get("guardian_phone", ""),
        "guardian_email": r.get("guardian_email", ""),
    })


# ═══════════════════════════════════════════════════════════════════════
# DRILL-DOWN — one subject's chapters, for the class teacher's tap-through
# ═══════════════════════════════════════════════════════════════════════

@home_bp.route("/api/teacher/class/<class_key>/subject/<subject>", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_class
def subject_detail(class_key, subject):
    subject = canon_subject(subject)
    roster = _roster(class_key)
    meta = chapter_meta()
    ctx = _class_context(class_key, roster, meta)

    chapters = _chapter_rollup(roster, meta, subject=subject)
    strugglers = []
    for r in roster:
        ps = (r.get("per_subject", {}) or {}).get(subject) or {}
        acc = ps.get("accuracy")
        if acc is not None and acc < 40 and int(ps.get("questions", 0) or 0) >= 15:
            strugglers.append({**_student_brief(r), "accuracy": acc,
                               "questions": ps.get("questions", 0)})
    strugglers.sort(key=lambda s: s["accuracy"])

    return jsonify({
        "subject": subject,
        "chapters": chapters,
        "summary": _subject_rollup(roster, meta).get(subject, {}),
        "strugglers": strugglers[:12],
        "missed_questions": _missed_questions(roster, meta, [subject]),
    })


# ═══════════════════════════════════════════════════════════════════════
# STUDENTS ADDED DIRECTLY, WITHOUT A JOIN REQUEST
# ═══════════════════════════════════════════════════════════════════════
#
# THE HOLE THIS FILLS
#
# The join flow is: a student types the class code, which writes a
# class_join_requests document with status "pending"; the teacher
# approves it, which sets users/{uid}.class_status = "approved" and
# rebuilds their rollup.
#
# _roster() reads student_rollups and skips anything whose class_status
# is not "approved" (teacher_backend.py:132), so that approval is what
# makes a student exist to the teacher portal at all.
#
# A student whose school_id and class_id were set ANOTHER way -- edited
# in the console, seeded by a script, or bulk-imported from a school's
# own list -- never gets a join request. So:
#
#   * they are not in the roster, because class_status is "unassigned"
#   * they are not in Pending either, because Pending reads
#     class_join_requests and there is no document for them
#
# They take tests, read chapters, sit an Arena paper, and their rollup is
# rebuilt correctly every time -- and not one screen anywhere mentions
# them. There was no way for a teacher to discover the student existed.
#
# For a school that bulk-imports rather than having fifty students type a
# code, that is not an edge case. It is the normal path.
#
# WHAT APPROVAL DOES
#
# Nothing new. approve_direct_student() writes the join request that
# should have existed and then hands off to the SAME _resolve_request()
# the normal flow uses, so there is one approval code path, one audit
# record, and one place that calls rebuild_student_rollup(). Everything
# the student did before being approved is already in their rollup and
# appears the moment it is rebuilt.


def _pending_uids(class_key):
    """Students who already have a join request waiting."""
    out = set()
    try:
        for d in (_db().collection("class_join_requests")
                       .where("class_key", "==", class_key)
                       .where("status", "==", "pending").stream()):
            uid = (d.to_dict() or {}).get("student_uid")
            if uid:
                out.add(uid)
    except Exception as e:
        print(f"[teacher] pending lookup failed for {class_key}: {e}")
    return out


def awaiting_approval(class_key, cls):
    """Students who look like they belong to this class but were never
    approved, and have no join request either.

    Matched on the school AND the section, both from the class document,
    because class_id alone ("12-A") is not unique across schools.
    """
    school = (cls.get("school_id") or "").strip()
    section = (cls.get("class_id") or "").strip()
    if not school or not section:
        return []

    already = _pending_uids(class_key)
    out = []
    try:
        q = (_db().collection("users")
                  .where("school_id", "==", school)
                  .where("class_id", "==", section)
                  .limit(200).stream())
        for doc in q:
            u = doc.to_dict() or {}
            if u.get("role", "student") != "student":
                continue
            if u.get("class_status") == "approved":
                continue          # already in the roster
            if doc.id in already:
                continue          # already in Pending, through the normal flow

            # Did they do anything before anyone noticed them? A student
            # who has already taken tests is a stronger signal than a
            # blank account, and the teacher should see that before
            # deciding.
            done = {}
            try:
                snap = _db().collection("student_rollups").document(doc.id).get()
                if snap.exists:
                    r = snap.to_dict() or {}
                    done = {
                        "tests": int(r.get("tests_completed", 0) or 0),
                        "questions": int(r.get("questions_seen", 0) or 0),
                        "last_active_at": r.get("last_active_at", ""),
                    }
            except Exception:
                pass

            out.append({
                "student_uid": doc.id,
                "student_name": u.get("name", "") or "Student",
                "student_email": u.get("email", ""),
                "roll_no": u.get("roll_no", ""),
                "class_level": u.get("class_level", ""),
                "class_status": u.get("class_status", "") or "not set",
                "activity": done,
                "source": "added_directly",
            })
    except Exception as e:
        # A missing composite index on school_id + class_id surfaces here.
        print(f"[teacher] awaiting-approval lookup failed for {class_key}: {e}")
        return []

    out.sort(key=lambda x: (-(x["activity"].get("tests") or 0),
                            x["student_name"].lower()))
    return out


@home_bp.route("/api/teacher/class/<class_key>/approve-direct", methods=["POST"])
@require_auth
@require_role("teacher")
@resolve_class
def approve_direct(class_key):
    """Approve a student who never had a join request.

    Writes the request that should have existed, then resolves it through
    the normal path. One approval code path, one audit trail.
    """
    body = request.json or {}
    uid = (body.get("student_uid") or "").strip()
    status = (body.get("status") or "approved").strip()
    if not uid:
        return jsonify({"error": "student_uid required"}), 400
    if status not in ("approved", "rejected"):
        return jsonify({"error": "status must be approved or rejected"}), 400

    cls = getattr(request, "class_doc", None) or {}
    school = (cls.get("school_id") or "").strip()
    section = (cls.get("class_id") or "").strip()

    snap = _db().collection("users").document(uid).get()
    if not snap.exists:
        return jsonify({"error": "That student does not exist."}), 404
    u = snap.to_dict() or {}

    # THE GATE. Without this a teacher could type any uid and pull an
    # arbitrary student into their class. The student's own document has
    # to already claim this school and this section -- approving is
    # confirming a claim the student made, never creating one.
    if u.get("role", "student") != "student":
        return jsonify({"error": "That account is not a student."}), 400
    if (u.get("school_id") or "").strip() != school or \
       (u.get("class_id") or "").strip() != section:
        print(f"[teacher] DIRECT-APPROVE MISMATCH uid={request.uid} "
              f"student={uid} class={class_key}")
        return jsonify({
            "error": "That student's account is not set to this class.",
            "code": "NOT_THIS_CLASS"}), 403
    if u.get("class_status") == "approved":
        return jsonify({"error": "Already approved.", "code": "RESOLVED"}), 409

    ref = _db().collection("class_join_requests").document()
    ref.set({
        "student_uid": uid,
        "student_name": u.get("name", "") or "Student",
        "student_email": u.get("email", ""),
        "class_level": u.get("class_level", ""),
        "requested_school_id": school,
        "requested_class_id": section,
        "class_key": class_key,
        "status": "pending",
        # Says plainly that this did not come from a student typing a
        # code, so the audit trail does not imply one.
        "source": "added_directly",
        "noticed_by": request.uid,
        "created_at": firestore.SERVER_TIMESTAMP,
    })

    # Hand off to the normal path: it sets class_status, bumps the class
    # count, writes the resolution to the request, and -- the part that
    # actually matters -- rebuilds the rollup so everything the student
    # did before today appears at once.
    request.json_override = {"request_id": ref.id}
    return _resolve_request(class_key, status, request_id=ref.id)