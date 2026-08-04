"""
NAADI AI — ADMIN CONSOLE BACKEND  (admin_backend.py)
═══════════════════════════════════════════════════════════════════════════

The whole-platform view: every student, teacher, parent, school, class,
test, join request, and support conversation — plus a payments scaffold
that fills in the day payments go live.

INTEGRATION — backend.py changes by exactly three lines, in the same
place init_portal() is called:

    from admin_backend import init_admin
    init_admin(app, require_auth=require_auth)

One Flask app, one Firestore project, one deploy. This registers a
Blueprint; it does not create a second service.

DESIGN RULES (inherited from portal_backend, same spirit)
  • The client never names its scope. Role is read from Firestore on
    every request; the admin role can never be set from a request body.
  • Everything analytical is READ-ONLY. The only writes are: support
    replies, ticket status, join approve/reject (mirrors the teacher's
    own flow), and the one-time role promotion during bootstrap.
  • Heavy scans use .select() field masks and a short in-process cache
    so the Overview screen doesn't re-read the world on every refresh.

ADMIN BOOTSTRAP — two ways to mint the first admin:
  1. .env:      NAADI_ADMIN_EMAILS=you@x.com,cofounder@x.com
                Any signed-in user whose email is on this list is
                promoted to role="admin" in Firestore on first contact
                with /api/admin/whoami. Remove the env entry afterwards
                if you want Firestore to be the only source of truth.
  2. CLI:       python admin_backend.py grant you@x.com
                (needs FIREBASE_SERVICE_ACCOUNT / default credentials,
                 same as backend.py)

SUPPORT DATA MODEL
  support_tickets/{tid}:            tid IS the uid — one thread per account
      uid, name, email, role, school_id, class_id, subject, status
      ("open"|"closed"), created_at, updated_at, last_message,
      last_from ("student"|"admin"), unread_admin, unread_student
  support_tickets/{tid}/messages/{auto}:
      from ("student"|"admin"), by_name, by_role, text, at (ISO)

  `from` is a SIDE, not a role — see SIDE_USER / SIDE_ADMIN below. Any
  signed-in non-admin account writes as SIDE_USER ("student"), which is
  what lets TEACHERS use this exact collection, these exact routes and
  this exact inbox with no migration and no second code path. The
  writer's real role travels in `role` on the thread and `by_role` on
  each message; the console reads those to label the conversation.
  Parents are out of scope by product decision — nothing blocks them at
  the route level, they simply have no entry point in the parent portal.
"""

import os
import sys
from datetime import datetime, timezone, timedelta
from functools import wraps
from collections import defaultdict

from flask import Blueprint, request, jsonify
from firebase_admin import firestore, auth as firebase_auth

# Everything auth/data-shaped is inherited from the portal module so the
# admin console authenticates and reads through the exact same code paths
# as the parent and teacher portals. portal_backend late-binds to
# backend.py's require_auth once init_portal() has run.
from portal_backend import (
    _db, _iso, _initials, chapter_meta, require_auth, PASS_THRESHOLD,
    class_key_for,
)

admin_bp = Blueprint("admin", __name__)

IST_TZ = timezone(timedelta(hours=5, minutes=30))

ADMIN_EMAILS = {
    e.strip().lower()
    for e in os.environ.get("NAADI_ADMIN_EMAILS", "").split(",")
    if e.strip()
}


# ═══════════════════════════════════════════════════════════════════════════
# GUARD
# ═══════════════════════════════════════════════════════════════════════════

def _user(uid):
    d = _db().collection("users").document(uid).get()
    return d.to_dict() if d.exists else None


def require_admin(f):
    """role == "admin" in Firestore, with the env-list bootstrap escape
    hatch. The promotion is written back so the env entry can be removed
    once the first admin exists."""
    @wraps(f)
    def inner(*a, **kw):
        u = _user(request.uid) or {}
        role = u.get("role", "student")
        if role != "admin":
            email = (u.get("email") or getattr(request, "user_email", "") or "").lower()
            if email and email in ADMIN_EMAILS:
                _db().collection("users").document(request.uid).set(
                    {"role": "admin", "uid": request.uid, "email": email,
                     "name": u.get("name", email.split("@")[0].title())},
                    merge=True)
                role = "admin"
                print(f"[admin] bootstrap-promoted {email} ({request.uid}) to admin")
            else:
                return jsonify({"error": "Not permitted for this account type.",
                                "code": "WRONG_ROLE", "role": role}), 403
        request.role = role
        request.user_doc = u
        return f(*a, **kw)
    return inner


# ═══════════════════════════════════════════════════════════════════════════
# SMALL HELPERS + SCAN CACHES
# ═══════════════════════════════════════════════════════════════════════════

def _now():
    return datetime.now(timezone.utc)


def _iso_date(v):
    """Anything Firestore stored under completed_at/created_at → 'YYYY-MM-DD'
    or ''. Sessions carry BOTH server timestamps and ISO strings (both flows
    exist in backend.py), so normalise through text."""
    s = _iso(v)
    return s[:10] if len(s) >= 10 else ""


def _days_since(v):
    s = _iso(v)
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return max(0, (_now() - dt).days)
    except ValueError:
        return None


def _count(query, fallback_iter=None):
    """Server-side count aggregation with a stream fallback for older SDKs."""
    try:
        res = query.count().get()
        return int(res[0][0].value)
    except Exception:
        it = fallback_iter if fallback_iter is not None else query.stream()
        return sum(1 for _ in it)


_cache = {}
_CACHE_TTL = 60  # seconds — the console polls; the world doesn't change that fast


def _cached(key, builder):
    now = _now().timestamp()
    hit = _cache.get(key)
    if hit and now - hit[0] < _CACHE_TTL:
        return hit[1]
    data = builder()
    _cache[key] = (now, data)
    return data


def _all_users():
    """One users scan, field-masked, cached. Feeds overview, teachers,
    parents, schools and joining without four separate walks."""
    def build():
        out = []
        q = _db().collection("users").select(
            ["uid", "name", "email", "role", "school_id", "class_id",
             "class_status", "class_keys", "children", "created_at",
             "subscription", "class_level", "parent_consent"])
        for doc in q.stream():
            u = doc.to_dict() or {}
            u["uid"] = u.get("uid") or doc.id
            out.append(u)
        return out
    return _cached("users", build)


def _all_rollups():
    """student_rollups is already the per-student summary the portals are
    built on — the admin roster rides the same rails."""
    def build():
        out = []
        for doc in _db().collection("student_rollups").stream():
            r = doc.to_dict() or {}
            r["uid"] = r.get("uid") or doc.id
            out.append(r)
        return out
    return _cached("rollups", build)


def _all_classes():
    def build():
        out = []
        for doc in _db().collection("classes").stream():
            c = doc.to_dict() or {}
            c["class_key"] = doc.id
            out.append(c)
        return out
    return _cached("classes", build)


def _scan_sessions():
    """Every completed test session, field-masked to the analytics columns.
    At early scale this is one cheap sweep; the cache keeps the console's
    polling honest. pyq (mock paper) sessions ride along, tagged."""
    def build():
        rows = []
        for coll, kind in (("test_sessions", "test"), ("pyq_sessions", "mock")):
            try:
                q = _db().collection(coll) \
                    .where("status", "==", "completed") \
                    .select(["user_id", "chapter_id", "percentage",
                             "time_taken_seconds", "completed_at", "total_questions"])
                for doc in q.stream():
                    s = doc.to_dict() or {}
                    rows.append({
                        "kind": kind,
                        "user_id": s.get("user_id", ""),
                        "chapter_id": s.get("chapter_id", ""),
                        "pct": s.get("percentage") or 0,
                        "secs": s.get("time_taken_seconds") or 0,
                        "nq": s.get("total_questions") or 0,
                        "date": _iso_date(s.get("completed_at")),
                    })
            except Exception as e:
                print(f"[admin] session scan failed on {coll}: {e}")
        return rows
    return _cached("sessions", build)


def _series_last_days(dates, n=30):
    """[(date, count)] for the last n days, zero-filled, oldest first."""
    today = _now().astimezone(IST_TZ).date()
    counts = defaultdict(int)
    for d in dates:
        if d:
            counts[d] += 1
    out = []
    for i in range(n - 1, -1, -1):
        day = (today - timedelta(days=i)).isoformat()
        out.append({"date": day, "count": counts.get(day, 0)})
    return out


# ═══════════════════════════════════════════════════════════════════════════
# WHOAMI
# ═══════════════════════════════════════════════════════════════════════════

@admin_bp.route("/api/admin/whoami", methods=["GET"])
@require_auth
@require_admin
def admin_whoami():
    u = request.user_doc
    return jsonify({
        "uid": request.uid,
        "name": u.get("name", "Admin"),
        "email": u.get("email", getattr(request, "user_email", "")),
        "role": "admin",
    })


# ═══════════════════════════════════════════════════════════════════════════
# OVERVIEW — the whole platform on one screen
# ═══════════════════════════════════════════════════════════════════════════

@admin_bp.route("/api/admin/overview", methods=["GET"])
@require_auth
@require_admin
def admin_overview():
    users = _all_users()
    rollups = _all_rollups()
    classes = _all_classes()
    sessions = _scan_sessions()

    by_role = defaultdict(int)
    plan_mix = defaultdict(int)
    signup_dates = []
    for u in users:
        by_role[u.get("role", "student")] += 1
        signup_dates.append(_iso_date(u.get("created_at")))
        if u.get("role", "student") == "student":
            plan_mix[(u.get("subscription") or {}).get("plan") or "free"] += 1

    schools = {r.get("school_id") for r in rollups if r.get("school_id")}
    schools |= {c.get("school_id") for c in classes if c.get("school_id")}

    active_today = active_7d = 0
    mastery_sum = mastery_n = 0
    tests_total = questions_total = 0
    at_risk = 0
    for r in rollups:
        d = _days_since(r.get("last_active_at"))
        if d is not None:
            if d == 0:
                active_today += 1
            if d <= 7:
                active_7d += 1
        m = r.get("overall_mastery")
        if m is not None:
            mastery_sum += m
            mastery_n += 1
        tests_total += int(r.get("tests_completed", 0) or 0)
        questions_total += int(r.get("questions_seen", 0) or 0)
        if (r.get("overall_mastery") or 0) < 35 and (r.get("tests_completed") or 0) >= 3:
            at_risk += 1

    score_hist = [0] * 10
    durations = []
    for s in sessions:
        b = min(9, int((s["pct"] or 0) // 10))
        score_hist[b] += 1
        if s["secs"]:
            durations.append(s["secs"])

    open_tickets = _count(
        _db().collection("support_tickets").where("status", "==", "open"))
    pending_joins = _count(
        _db().collection("class_join_requests").where("status", "==", "pending"))

    return jsonify({
        "counts": {
            "students": by_role.get("student", 0),
            "teachers": by_role.get("teacher", 0),
            "parents": by_role.get("parent", 0),
            "admins": by_role.get("admin", 0),
            "schools": len(schools),
            "classes": len(classes),
            "tests_completed": tests_total,
            "questions_answered": questions_total,
            "active_today": active_today,
            "active_7d": active_7d,
            "at_risk": at_risk,
            "open_tickets": open_tickets,
            "pending_joins": pending_joins,
            "avg_mastery": round(mastery_sum / mastery_n) if mastery_n else 0,
        },
        "signups_30d": _series_last_days(signup_dates),
        "tests_30d": _series_last_days([s["date"] for s in sessions]),
        "active_30d": _series_last_days(
            [_iso_date(r.get("last_active_at")) for r in rollups]),
        "score_hist": [{"bucket": f"{i*10}–{i*10+9}", "count": c}
                       for i, c in enumerate(score_hist)],
        "plan_mix": [{"plan": k, "count": v} for k, v in sorted(plan_mix.items())],
        "avg_test_seconds": round(sum(durations) / len(durations)) if durations else 0,
        "pass_threshold": PASS_THRESHOLD,
    })


# ═══════════════════════════════════════════════════════════════════════════
# SCHOOLS
# ═══════════════════════════════════════════════════════════════════════════

def _school_name(school_id, classes):
    for c in classes:
        if c.get("school_id") == school_id and c.get("school_name"):
            return c["school_name"]
    return school_id


@admin_bp.route("/api/admin/schools", methods=["GET"])
@require_auth
@require_admin
def admin_schools():
    rollups = _all_rollups()
    classes = _all_classes()
    users = _all_users()

    agg = defaultdict(lambda: {"students": 0, "approved": 0, "active_7d": 0,
                               "mastery_sum": 0, "mastery_n": 0, "tests": 0,
                               "at_risk": 0})
    for r in rollups:
        sid = r.get("school_id") or "—"
        a = agg[sid]
        a["students"] += 1
        if r.get("class_status") == "approved":
            a["approved"] += 1
        d = _days_since(r.get("last_active_at"))
        if d is not None and d <= 7:
            a["active_7d"] += 1
        m = r.get("overall_mastery")
        if m is not None:
            a["mastery_sum"] += m
            a["mastery_n"] += 1
        a["tests"] += int(r.get("tests_completed", 0) or 0)
        if (m or 0) < 35 and (r.get("tests_completed") or 0) >= 3:
            a["at_risk"] += 1

    teachers_by_school = defaultdict(set)
    classes_by_school = defaultdict(int)
    for c in classes:
        sid = c.get("school_id") or "—"
        classes_by_school[sid] += 1
        for t in (c.get("teacher_uids") or []):
            teachers_by_school[sid].add(t)
    # Teachers whose classes haven't been created yet still belong somewhere.
    for u in users:
        if u.get("role") == "teacher" and u.get("school_id"):
            teachers_by_school[u["school_id"]].add(u["uid"])

    out = []
    for sid, a in agg.items():
        out.append({
            "school_id": sid,
            "school_name": _school_name(sid, classes),
            "students": a["students"],
            "approved": a["approved"],
            "teachers": len(teachers_by_school.get(sid, ())),
            "classes": classes_by_school.get(sid, 0),
            "active_7d": a["active_7d"],
            "avg_mastery": round(a["mastery_sum"] / a["mastery_n"]) if a["mastery_n"] else 0,
            "tests": a["tests"],
            "at_risk": a["at_risk"],
        })
    out.sort(key=lambda s: -s["students"])
    return jsonify({"schools": out, "count": len(out)})


@admin_bp.route("/api/admin/school/<school_id>", methods=["GET"])
@require_auth
@require_admin
def admin_school(school_id):
    rollups = [r for r in _all_rollups() if r.get("school_id") == school_id]
    classes = [c for c in _all_classes() if c.get("school_id") == school_id]
    users = {u["uid"]: u for u in _all_users()}

    cls_out = []
    for c in classes:
        members = [r for r in rollups if r.get("class_key") == c["class_key"]
                   and r.get("class_status") == "approved"]
        mn = [r.get("overall_mastery") for r in members
              if r.get("overall_mastery") is not None]
        cls_out.append({
            "class_key": c["class_key"],
            "class_id": c.get("class_id", c["class_key"]),
            "students": len(members),
            "avg_mastery": round(sum(mn) / len(mn)) if mn else 0,
            "teachers": [users.get(t, {}).get("name", t)
                         for t in (c.get("teacher_uids") or [])],
            "peer_visibility": bool(c.get("peer_visibility")),
        })
    cls_out.sort(key=lambda c: c["class_id"])

    return jsonify({
        "school_id": school_id,
        "school_name": _school_name(school_id, classes),
        "classes": cls_out,
        "students": [_roster_row(r) for r in
                     sorted(rollups, key=lambda r: -(r.get("overall_mastery") or 0))],
    })


# ═══════════════════════════════════════════════════════════════════════════
# STUDENTS — global roster + full drill-down
# ═══════════════════════════════════════════════════════════════════════════

def _roster_row(r):
    return {
        "uid": r["uid"],
        "name": r.get("name", "Student"),
        "initials": r.get("initials") or _initials(r.get("name")),
        "email": r.get("email", ""),
        "school_id": r.get("school_id", ""),
        "class_id": r.get("class_id", ""),
        "class_status": r.get("class_status", "unassigned"),
        "mastery": round(r.get("overall_mastery") or 0),
        "accuracy": round(r.get("accuracy") or 0),
        "tests": int(r.get("tests_completed", 0) or 0),
        "questions": int(r.get("questions_seen", 0) or 0),
        "streak": int(r.get("streak_current", 0) or 0),
        "doctor_rank": r.get("doctor_rank", ""),
        "last_active_days": _days_since(r.get("last_active_at")),
        "plan": r.get("plan", ""),
    }


_FILTERS = {
    "at_risk": lambda r: (r.get("overall_mastery") or 0) < 35
                         and (r.get("tests_completed") or 0) >= 3,
    "inactive": lambda r: (_days_since(r.get("last_active_at")) or 999) >= 7,
    "never_started": lambda r: (r.get("tests_completed") or 0) == 0,
    "unassigned": lambda r: r.get("class_status") != "approved",
    "top": lambda r: (r.get("overall_mastery") or 0) >= 70,
}

_SORTS = {
    "mastery": lambda r: -(r.get("overall_mastery") or 0),
    "mastery_asc": lambda r: (r.get("overall_mastery") or 0),
    "accuracy": lambda r: -(r.get("accuracy") or 0),
    "tests": lambda r: -(r.get("tests_completed") or 0),
    "last_active": lambda r: (_days_since(r.get("last_active_at"))
                              if _days_since(r.get("last_active_at")) is not None else 999),
    "name": lambda r: (r.get("name") or "").lower(),
}


@admin_bp.route("/api/admin/students", methods=["GET"])
@require_auth
@require_admin
def admin_students():
    rows = list(_all_rollups())

    school = request.args.get("school", "").strip()
    if school:
        rows = [r for r in rows if r.get("school_id") == school]

    flt = request.args.get("filter", "")
    if flt in _FILTERS:
        rows = [r for r in rows if _FILTERS[flt](r)]

    q = request.args.get("q", "").strip().lower()
    if q:
        rows = [r for r in rows
                if q in (r.get("name") or "").lower()
                or q in (r.get("email") or "").lower()]

    rows.sort(key=_SORTS.get(request.args.get("sort", "mastery"), _SORTS["mastery"]))

    total = len(rows)
    offset = max(0, int(request.args.get("offset", 0) or 0))
    limit = min(200, max(1, int(request.args.get("limit", 60) or 60)))
    return jsonify({
        "total": total,
        "offset": offset,
        "students": [_roster_row(r) for r in rows[offset:offset + limit]],
    })


@admin_bp.route("/api/admin/student/<uid>", methods=["GET"])
@require_auth
@require_admin
def admin_student(uid):
    u = _user(uid)
    if not u:
        return jsonify({"error": "Student not found."}), 404
    snap = _db().collection("student_rollups").document(uid).get()
    r = snap.to_dict() if snap.exists else {}
    r["uid"] = uid

    parents = []
    try:
        for d in _db().collection("users") \
                .where("children", "array_contains", uid).stream():
            p = d.to_dict() or {}
            parents.append({"uid": d.id, "name": p.get("name", ""),
                            "email": p.get("email", "")})
    except Exception as e:
        print(f"[admin] parent lookup failed for {uid}: {e}")

    weak = [{"concept_id": k, **v} for k, v in (r.get("weak_concepts") or {}).items()] \
        if isinstance(r.get("weak_concepts"), dict) else (r.get("weak_concepts") or [])

    return jsonify({
        "student": _roster_row(r) if r else {"uid": uid, "name": u.get("name", "")},
        "profile": {
            "email": u.get("email", ""),
            "class_level": u.get("class_level", ""),
            "target_exam": u.get("target_exam", ""),
            "plan": (u.get("subscription") or {}).get("plan", "free"),
            "created_at": _iso(u.get("created_at")),
            "guardian_name": u.get("guardian_name", ""),
            "guardian_phone": u.get("guardian_phone", ""),
            "guardian_email": u.get("guardian_email", ""),
            "parent_consent": u.get("parent_consent", True),
        },
        "parents": parents,
        "rollup": {
            "doctor_overall": r.get("doctor_overall", 0),
            "doctor_rank": r.get("doctor_rank", ""),
            "studio_pct": r.get("studio_pct", 0),
            "opd_pct": r.get("opd_pct", 0),
            "arena_pct": r.get("arena_pct", 0),
            "streak_current": r.get("streak_current", 0),
            "streak_longest": r.get("streak_longest", 0),
            "chapters_started": r.get("chapters_started", 0),
            "rounds_completed": r.get("rounds_completed", 0),
            "weak_concepts": weak[:10] if isinstance(weak, list) else [],
        },
    })


@admin_bp.route("/api/admin/student/<uid>/tests", methods=["GET"])
@require_auth
@require_admin
def admin_student_tests(uid):
    """The full test log for one student — score, duration, pace read —
    same shape the teacher portal proved, plus mock papers."""
    meta = chapter_meta()
    log, slow = [], []
    for coll, kind in (("test_sessions", "test"), ("pyq_sessions", "mock")):
        try:
            for doc in _db().collection(coll) \
                    .where("user_id", "==", uid) \
                    .where("status", "==", "completed").stream():
                s = doc.to_dict() or {}
                m = meta.get(s.get("chapter_id", ""), {})
                qs = s.get("questions", []) or []
                secs = s.get("time_taken_seconds", 0) or 0
                row = {
                    "kind": kind,
                    "session_id": s.get("session_id", doc.id),
                    "chapter_name": m.get("chapter_title",
                                          s.get("paper_name",
                                                s.get("chapter_id", ""))),
                    "subject": m.get("subject", ""),
                    "test_num": s.get("test_num"),
                    "phase": s.get("phase", ""),
                    "percentage": s.get("percentage", 0),
                    "passed": (s.get("percentage") or 0) >= PASS_THRESHOLD,
                    "is_retake": bool(s.get("is_retake")),
                    "total_questions": s.get("total_questions", len(qs)),
                    "wrong_count": sum(1 for q in qs if q.get("is_correct") is False),
                    "skipped_count": sum(1 for q in qs
                                         if q.get("student_answer") in (None, "", {})),
                    "time_taken_seconds": secs,
                    "completed_at": _iso(s.get("completed_at")),
                }
                log.append(row)
                n = len(qs) or (s.get("total_questions") or 1)
                per_q = secs / n if secs else 0
                if per_q and (per_q < 15 or per_q > 150):
                    slow.append({"session_id": row["session_id"],
                                 "chapter_name": row["chapter_name"],
                                 "seconds_per_question": round(per_q),
                                 "pattern": "rushing" if per_q < 15 else "freezing",
                                 "percentage": row["percentage"]})
        except Exception as e:
            print(f"[admin] tests scan failed on {coll} for {uid}: {e}")

    log.sort(key=lambda t: t["completed_at"] or "", reverse=True)
    total_secs = sum(t["time_taken_seconds"] for t in log)
    return jsonify({"log": log, "pace_outliers": slow[:6],
                    "total_time_seconds": total_secs,
                    "pass_threshold": PASS_THRESHOLD})


@admin_bp.route("/api/admin/student/<uid>/test/<session_id>", methods=["GET"])
@require_auth
@require_admin
def admin_test_review(uid, session_id):
    """Question-by-question review. Completed sessions only — an
    in-progress session leaks unseen questions, admin or not."""
    doc = _db().collection("test_sessions").document(session_id).get()
    coll = "test_sessions"
    if not doc.exists:
        doc = _db().collection("pyq_sessions").document(session_id).get()
        coll = "pyq_sessions"
    if not doc.exists:
        return jsonify({"error": "Test not found."}), 404
    s = doc.to_dict()
    if s.get("user_id") != uid:
        return jsonify({"error": "Session does not belong to this student."}), 403
    if s.get("status") != "completed":
        return jsonify({"error": "This test is still in progress.",
                        "code": "IN_PROGRESS"}), 403

    questions = []
    for i, q in enumerate(s.get("questions", []) or []):
        questions.append({
            "index": i + 1,
            "question_text": q.get("question_text", ""),
            "options": q.get("options_detail", []) or q.get("options", []),
            "correct_answer": q.get("correct_answer"),
            "student_answer": q.get("student_answer"),
            "is_correct": q.get("is_correct"),
            "attempted": q.get("student_answer") not in (None, "", {}),
            "difficulty": q.get("difficulty", ""),
            "concept_id": q.get("concept_id", ""),
            "explanation": q.get("detailed_explanation") or q.get("static_explanation", ""),
        })

    meta = chapter_meta().get(s.get("chapter_id", ""), {})
    secs = s.get("time_taken_seconds", 0) or 0
    n = len(questions) or 1
    return jsonify({
        "session_id": session_id,
        "collection": coll,
        "chapter_name": meta.get("chapter_title", s.get("paper_name", "")),
        "test_num": s.get("test_num"),
        "percentage": s.get("percentage", 0),
        "total_questions": s.get("total_questions", len(questions)),
        "time_taken_seconds": secs,
        "seconds_per_question": round(secs / n) if secs else 0,
        "completed_at": _iso(s.get("completed_at")),
        "questions": questions,
    })


# ═══════════════════════════════════════════════════════════════════════════
# TEACHERS + PARENTS
# ═══════════════════════════════════════════════════════════════════════════

@admin_bp.route("/api/admin/teachers", methods=["GET"])
@require_auth
@require_admin
def admin_teachers():
    users = _all_users()
    classes = _all_classes()
    rollups = _all_rollups()

    size = defaultdict(int)
    for r in rollups:
        if r.get("class_status") == "approved" and r.get("class_key"):
            size[r["class_key"]] += 1

    pending = defaultdict(int)
    try:
        for d in _db().collection("class_join_requests") \
                .where("status", "==", "pending") \
                .select(["class_key"]).stream():
            pending[(d.to_dict() or {}).get("class_key", "")] += 1
    except Exception as e:
        print(f"[admin] pending scan failed: {e}")

    by_teacher = defaultdict(list)
    for c in classes:
        for t in (c.get("teacher_uids") or []):
            by_teacher[t].append(c)

    out = []
    for u in users:
        if u.get("role") != "teacher":
            continue
        cls = by_teacher.get(u["uid"], [])
        out.append({
            "uid": u["uid"],
            "name": u.get("name", ""),
            "email": u.get("email", ""),
            "school_id": u.get("school_id", "")
                         or (cls[0].get("school_id", "") if cls else ""),
            "classes": [{"class_key": c["class_key"],
                         "class_id": c.get("class_id", c["class_key"]),
                         "students": size.get(c["class_key"], 0),
                         "pending": pending.get(c["class_key"], 0)} for c in cls],
            "students_total": sum(size.get(c["class_key"], 0) for c in cls),
            "pending_total": sum(pending.get(c["class_key"], 0) for c in cls),
            "created_at": _iso(u.get("created_at")),
        })
    out.sort(key=lambda t: -t["students_total"])
    return jsonify({"teachers": out, "count": len(out)})


@admin_bp.route("/api/admin/parents", methods=["GET"])
@require_auth
@require_admin
def admin_parents():
    users = _all_users()
    names = {u["uid"]: u.get("name", "") for u in users}
    out = []
    for u in users:
        if u.get("role") != "parent":
            continue
        kids = u.get("children", []) or []
        out.append({
            "uid": u["uid"],
            "name": u.get("name", ""),
            "email": u.get("email", ""),
            "children": [{"uid": k, "name": names.get(k, k)} for k in kids],
            "created_at": _iso(u.get("created_at")),
        })
    out.sort(key=lambda p: -len(p["children"]))
    return jsonify({"parents": out, "count": len(out)})


# ═══════════════════════════════════════════════════════════════════════════
# JOINING — signups + class join pipeline (with admin resolve)
# ═══════════════════════════════════════════════════════════════════════════

@admin_bp.route("/api/admin/joining", methods=["GET"])
@require_auth
@require_admin
def admin_joining():
    users = sorted(_all_users(),
                   key=lambda u: _iso(u.get("created_at")) or "", reverse=True)
    role = request.args.get("role", "")
    if role:
        users = [u for u in users if u.get("role", "student") == role]

    recent = [{
        "uid": u["uid"], "name": u.get("name", ""), "email": u.get("email", ""),
        "role": u.get("role", "student"), "school_id": u.get("school_id", ""),
        "class_id": u.get("class_id", ""),
        "class_status": u.get("class_status", ""),
        "created_at": _iso(u.get("created_at")),
    } for u in users[:60]]

    pending = []
    try:
        for d in _db().collection("class_join_requests") \
                .where("status", "==", "pending").stream():
            r = d.to_dict() or {}
            pending.append({
                "request_id": d.id,
                "student_uid": r.get("student_uid", ""),
                "student_name": r.get("student_name", ""),
                "requested_school_id": r.get("requested_school_id",
                                             r.get("school_id", "")),
                "requested_class_id": r.get("requested_class_id",
                                            r.get("class_id", "")),
                "class_key": r.get("class_key", ""),
                "created_at": _iso(r.get("created_at")),
            })
    except Exception as e:
        print(f"[admin] join scan failed: {e}")
    pending.sort(key=lambda p: p["created_at"] or "", reverse=True)

    return jsonify({"recent_signups": recent, "pending_joins": pending})


@admin_bp.route("/api/admin/join/<request_id>/resolve", methods=["POST"])
@require_auth
@require_admin
def admin_resolve_join(request_id):
    """Mirror of the teacher's approve/reject, with admin authority.
    Same writes, so the student lands in exactly the same state."""
    action = (request.json or {}).get("action", "")
    if action not in ("approve", "reject"):
        return jsonify({"error": "action must be approve or reject"}), 400

    ref = _db().collection("class_join_requests").document(request_id)
    snap = ref.get()
    if not snap.exists:
        return jsonify({"error": "Request not found."}), 404
    req = snap.to_dict() or {}
    if req.get("status") != "pending":
        return jsonify({"error": "Already resolved.", "status": req.get("status")}), 409

    status = "approved" if action == "approve" else "rejected"
    ref.set({"status": status, "resolved_by": request.uid,
             "resolved_by_role": "admin",
             "resolved_at": firestore.SERVER_TIMESTAMP}, merge=True)
    _db().collection("users").document(req.get("student_uid", "")).set({
        "class_status": status if status == "approved" else "unassigned",
    }, merge=True)
    _cache.pop("users", None)
    return jsonify({"ok": True, "status": status})


# ═══════════════════════════════════════════════════════════════════════════
# TESTS — global analytics
# ═══════════════════════════════════════════════════════════════════════════

@admin_bp.route("/api/admin/tests", methods=["GET"])
@require_auth
@require_admin
def admin_tests():
    sessions = _scan_sessions()
    meta = chapter_meta()

    by_subject = defaultdict(lambda: {"n": 0, "pct": 0.0, "secs": 0})
    by_chapter = defaultdict(lambda: {"n": 0, "pct": 0.0})
    durations = []
    for s in sessions:
        m = meta.get(s["chapter_id"], {})
        subj = m.get("subject") or ("Mock papers" if s["kind"] == "mock" else "Other")
        b = by_subject[subj]
        b["n"] += 1
        b["pct"] += s["pct"]
        b["secs"] += s["secs"]
        if s["kind"] == "test" and s["chapter_id"]:
            c = by_chapter[s["chapter_id"]]
            c["n"] += 1
            c["pct"] += s["pct"]
        if s["secs"] and s["nq"]:
            durations.append(s["secs"] / s["nq"])

    subjects = [{
        "subject": k, "tests": v["n"],
        "avg_pct": round(v["pct"] / v["n"]) if v["n"] else 0,
        "avg_seconds": round(v["secs"] / v["n"]) if v["n"] else 0,
    } for k, v in sorted(by_subject.items(), key=lambda kv: -kv[1]["n"])]

    hardest = [{
        "chapter_id": cid,
        "chapter_name": meta.get(cid, {}).get("chapter_title", cid),
        "subject": meta.get(cid, {}).get("subject", ""),
        "attempts": v["n"],
        "avg_pct": round(v["pct"] / v["n"]),
    } for cid, v in by_chapter.items() if v["n"] >= 5]
    hardest.sort(key=lambda c: c["avg_pct"])

    failed = defaultdict(lambda: {"students": 0, "failures": 0,
                                  "chapter_id": "", "concept_id": ""})
    try:
        for doc in _db().collection("base_question_tracking") \
                .select(["base_question_id", "chapter_id", "concept_id",
                         "total_failures"]).stream():
            b = doc.to_dict() or {}
            tf = int(b.get("total_failures", 0) or 0)
            if tf < 1:
                continue
            f = failed[b.get("base_question_id", doc.id)]
            f["students"] += 1
            f["failures"] += tf
            f["chapter_id"] = b.get("chapter_id", "")
            f["concept_id"] = b.get("concept_id", "")
    except Exception as e:
        print(f"[admin] base tracking scan failed: {e}")

    most_failed = [{
        "base_question_id": qid,
        "chapter_name": meta.get(v["chapter_id"], {}).get("chapter_title",
                                                          v["chapter_id"]),
        "concept_id": v["concept_id"],
        "students": v["students"],
        "failures": v["failures"],
    } for qid, v in failed.items()]
    most_failed.sort(key=lambda q: (-q["students"], -q["failures"]))

    return jsonify({
        "tests_30d": _series_last_days([s["date"] for s in sessions]),
        "totals": {"tests": sum(1 for s in sessions if s["kind"] == "test"),
                   "mocks": sum(1 for s in sessions if s["kind"] == "mock"),
                   "avg_seconds_per_question": round(sum(durations) / len(durations))
                   if durations else 0},
        "subjects": subjects,
        "hardest_chapters": hardest[:12],
        "most_failed_questions": most_failed[:15],
        "pass_threshold": PASS_THRESHOLD,
    })


# ═══════════════════════════════════════════════════════════════════════════
# PAYMENTS — scaffold. Fills in the day payments go live.
# ═══════════════════════════════════════════════════════════════════════════

@admin_bp.route("/api/admin/payments", methods=["GET"])
@require_auth
@require_admin
def admin_payments():
    """Reads the (future) `payments` collection: expected docs
    {uid, name, amount, currency, plan, status, provider, created_at}.
    Today it returns the plan mix from user docs and an empty ledger,
    so the console screen is already wired when the gateway lands."""
    users = _all_users()
    plan_mix = defaultdict(int)
    for u in users:
        if u.get("role", "student") == "student":
            plan_mix[(u.get("subscription") or {}).get("plan") or "free"] += 1

    ledger, revenue = [], 0
    try:
        for doc in _db().collection("payments") \
                .order_by("created_at", direction=firestore.Query.DESCENDING) \
                .limit(100).stream():
            p = doc.to_dict() or {}
            amt = p.get("amount", 0) or 0
            if p.get("status") in (None, "paid", "captured", "success"):
                revenue += amt
            ledger.append({
                "id": doc.id, "uid": p.get("uid", ""), "name": p.get("name", ""),
                "amount": amt, "currency": p.get("currency", "INR"),
                "plan": p.get("plan", ""), "status": p.get("status", "paid"),
                "provider": p.get("provider", ""),
                "created_at": _iso(p.get("created_at")),
            })
    except Exception:
        pass  # collection doesn't exist yet — that is the expected state

    return jsonify({
        "live": bool(ledger),
        "revenue_total": revenue,
        "plan_mix": [{"plan": k, "count": v} for k, v in sorted(plan_mix.items())],
        "ledger": ledger,
    })


# ═══════════════════════════════════════════════════════════════════════════
# SUPPORT — student queries, admin inbox, chat both ways
# ═══════════════════════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════════
# WHERE A SCHOOL ACTUALLY LIVES
#
# There is no schools collection. The readable school NAME exists in
# exactly one place: classes/{class_key}.school_name.
#
# Students carry school_id + class_id on their own user doc, so their
# id resolves directly and only the name needs a class lookup.
#
# TEACHERS CARRY NEITHER. A teacher's user doc has class_keys and
# nothing else — their school is reachable only THROUGH a class
# document. That is why every teacher thread read "no school": the
# thread snapshotted u.get("school_id") at creation, which for a
# teacher is "" and always was.
#
# So this resolves from the class doc first and treats the user doc as
# the fallback, not the other way round.
# ═══════════════════════════════════════════════════════════════════

_CLASS_CACHE = {}


def _class_doc(key):
    """Read classes/{key}, memoised. Small, hot, and read up to twice
    per support thread view."""
    if not key:
        return {}
    if key not in _CLASS_CACHE:
        try:
            snap = _db().collection("classes").document(key).get()
            _CLASS_CACHE[key] = (snap.to_dict() or {}) if snap.exists else {}
        except Exception as e:
            print(f"[admin] class read failed for {key}: {e}")
            _CLASS_CACHE[key] = {}
    return _CLASS_CACHE[key]


def _school_of(u):
    """(school_id, school_name) for any user doc, whatever their role.

    Never raises and never returns None — a missing school must degrade
    to an empty string, not break a support reply."""
    u = u or {}

    # Teachers: class_keys. Students: derive the one key from
    # school_id + class_id through the shared helper, so this can never
    # drift from how the rest of the system builds that key.
    keys = list(u.get("class_keys", []) or [])
    if not keys:
        try:
            k = class_key_for(u)
        except Exception:
            k = ""
        if k:
            keys = [k]

    for key in keys:
        c = _class_doc(key)
        if c.get("school_name") or c.get("school_id"):
            return (c.get("school_id") or u.get("school_id") or "",
                    c.get("school_name") or "")

    # No class document reachable. Keep whatever id the user doc has, so
    # the console still shows something true — just not the pretty name.
    return (u.get("school_id") or "", "")


def _heal_school(ref, t, uid):
    """Resolve a thread's school from live data and write it back once.

    Read-time repair on purpose. Threads created before this fix have
    school_id="" baked in, and a write-time-only fix would leave every
    existing teacher conversation reading "no school" forever. Doing it
    here fixes them the first time anyone opens them: no backfill
    script, one extra write per thread ever."""
    if t.get("school_name"):
        return t
    sid, sname = _school_of(_user(uid) or {})
    if not sid and not sname:
        return t
    t = dict(t)
    t["school_id"] = sid or t.get("school_id", "")
    t["school_name"] = sname
    try:
        ref.set({"school_id": t["school_id"], "school_name": sname}, merge=True)
    except Exception as e:
        print(f"[admin] school heal failed for {uid}: {e}")
    return t


def _ticket_public(tid, t):
    return {
        "ticket_id": tid,
        "subject": t.get("subject", ""),
        "status": t.get("status", "open"),
        "uid": t.get("uid", ""),
        "name": t.get("name", ""),
        "email": t.get("email", ""),
        "role": t.get("role", "student"),
        "school_id": t.get("school_id", ""),
        "school_name": t.get("school_name", ""),
        "class_id": t.get("class_id", ""),
        "last_message": t.get("last_message", ""),
        "last_from": t.get("last_from", "student"),
        "unread_admin": int(t.get("unread_admin", 0) or 0),
        "unread_student": int(t.get("unread_student", 0) or 0),
        "created_at": _iso(t.get("created_at")),
        "updated_at": _iso(t.get("updated_at")),
    }


# `from` is a SIDE, not a role. It has exactly two values:
#
#     SIDE_USER  = "student"   the account that owns the thread
#     SIDE_ADMIN = "admin"     the NAADI team
#
# The literal is "student" for historical reasons and is deliberately
# NOT renamed: every message document written since launch carries it,
# and the unread counters key off it. A teacher writing in now takes
# SIDE_USER too, which is what makes the teacher thread work with zero
# migration. Who actually wrote is carried separately in `by_role`.
SIDE_USER = "student"
SIDE_ADMIN = "admin"


def _add_message(tid, sender, by_name, text, by_role=""):
    now = datetime.now(timezone.utc).isoformat()
    ref = _db().collection("support_tickets").document(tid)
    ref.collection("messages").add({
        "from": sender, "by_name": by_name, "by_role": by_role,
        "text": text, "at": now,
    })
    unread = "unread_admin" if sender == SIDE_USER else "unread_student"
    ref.set({
        "last_message": text[:200], "last_from": sender,
        "updated_at": now, "status": "open",
        unread: firestore.Increment(1),
    }, merge=True)
    return now


def _messages(tid, limit=200):
    out = []
    for doc in _db().collection("support_tickets").document(tid) \
            .collection("messages").order_by("at").limit(limit).stream():
        m = doc.to_dict() or {}
        out.append({"from": m.get("from", SIDE_USER),
                    "by_name": m.get("by_name", ""),
                    # Pre-dates by_role -> "", and the console falls back
                    # to the thread's own role. Never guess here.
                    "by_role": m.get("by_role", ""),
                    "text": m.get("text", ""), "at": _iso(m.get("at"))})
    return out


# ── Student (and any signed-in user) side ────────────────────────────────
#
# MODEL: one continuous conversation per account, keyed by uid — chat
# with memory, not a ticket pile. status open/closed still marks
# "resolved", and _add_message flips it back to open on any new
# message, so a student writing into a closed thread reopens it on
# its own. Early per-query tickets (random hex ids) are merged into
# the uid thread the first time it is touched, then marked closed.

def _ensure_thread(uid):
    """Create (and backfill) the uid-keyed conversation. Returns the doc
    ref. Safe to call on every access — it no-ops once the doc exists."""
    ref = _db().collection("support_tickets").document(uid)
    if ref.get().exists:
        return ref

    u = _user(uid) or {}
    now = datetime.now(timezone.utc).isoformat()

    # Pull messages out of any legacy per-query tickets for this user.
    legacy_msgs, earliest = [], now
    try:
        for doc in _db().collection("support_tickets") \
                .where("uid", "==", uid).stream():
            if doc.id == uid:
                continue
            t = doc.to_dict() or {}
            earliest = min(earliest, _iso(t.get("created_at")) or now)
            for m in _db().collection("support_tickets").document(doc.id) \
                    .collection("messages").order_by("at").stream():
                legacy_msgs.append(m.to_dict() or {})
            _db().collection("support_tickets").document(doc.id).set(
                {"status": "closed", "migrated_to": uid,
                 "updated_at": now}, merge=True)
    except Exception as e:
        print(f"[admin] legacy merge failed for {uid}: {e}")

    legacy_msgs.sort(key=lambda m: _iso(m.get("at")) or "")
    last = legacy_msgs[-1] if legacy_msgs else {}
    ref.set({
        "uid": uid,
        "name": u.get("name", ""),
        "email": u.get("email", ""),
        "role": u.get("role", "student"),
        # Resolved, not copied: a teacher's user doc has no school_id.
        "school_id": _school_of(u)[0],
        "school_name": _school_of(u)[1],
        "class_id": u.get("class_id", ""),
        "subject": "Support conversation",
        "status": "open" if legacy_msgs else "closed",
        "created_at": earliest, "updated_at": _iso(last.get("at")) or now,
        "last_message": (last.get("text") or "")[:200],
        "last_from": last.get("from", "student"),
        "unread_admin": sum(1 for m in legacy_msgs
                            if m.get("from") == "student"),
        "unread_student": 0,
    })
    for m in legacy_msgs:
        ref.collection("messages").add(m)
    if legacy_msgs:
        print(f"[admin] merged {len(legacy_msgs)} legacy messages into "
              f"unified thread for {uid}")
    return ref


@admin_bp.route("/api/support/tickets", methods=["GET"])
@require_auth
def support_my_tickets():
    """Returns the user's unified conversation (as a 1-element list, so
    the response shape survives the ticket→chat transition), merging
    legacy per-query tickets on first contact."""
    ref = _db().collection("support_tickets").document(request.uid)
    snap = ref.get()
    if not snap.exists:
        # Only materialise a thread if there is legacy history to fold in;
        # otherwise the first real message creates it.
        legacy = list(_db().collection("support_tickets")
                      .where("uid", "==", request.uid).limit(1).stream())
        if legacy:
            ref = _ensure_thread(request.uid)
            snap = ref.get()
    out = []
    if snap.exists:
        t = snap.to_dict() or {}
        # Hide bare shells with no messages ever
        if t.get("last_message") or t.get("status") == "open":
            out.append(_ticket_public(request.uid, t))
    unread = sum(t["unread_student"] for t in out)
    return jsonify({"tickets": out, "unread": unread})


@admin_bp.route("/api/support/ticket", methods=["POST"])
@require_auth
def support_create():
    """First message of the conversation — or any message, really: the
    endpoint is idempotent on the uid-keyed thread, so double-taps and
    old clients can never fork a second conversation."""
    data = request.json or {}
    text = (data.get("text") or "").strip()[:2000]
    if not text:
        return jsonify({"error": "Write something first."}), 400
    u = _user(request.uid) or {}
    role = u.get("role", "student")
    ref = _ensure_thread(request.uid)
    sid, sname = _school_of(u)
    ref.set({
        "name": u.get("name", ""),
        "email": u.get("email", getattr(request, "user_email", "")),
        "role": role,
        "school_id": sid,
        "school_name": sname,
        "class_id": u.get("class_id", ""),
    }, merge=True)
    _add_message(request.uid, SIDE_USER,
                 u.get("name") or role.title(), text, by_role=role)
    return jsonify({"ok": True, "ticket_id": request.uid})


@admin_bp.route("/api/support/unread", methods=["GET"])
@require_auth
def support_unread():
    """One document read, for the top-bar badge.

    The badge polls on a timer for every signed-in user, so it must not
    go anywhere near the legacy-merge scan in /api/support/tickets. A
    user with no thread yet is the common case and costs one miss."""
    snap = _db().collection("support_tickets").document(request.uid).get()
    if not snap.exists:
        return jsonify({"unread": 0, "status": None, "has_thread": False})
    t = snap.to_dict() or {}
    return jsonify({
        "unread": int(t.get("unread_student", 0) or 0),
        "status": t.get("status", "open"),
        "has_thread": bool(t.get("last_message")),
    })


@admin_bp.route("/api/support/ticket/<tid>", methods=["GET"])
@require_auth
def support_thread(tid):
    ref = _db().collection("support_tickets").document(tid)
    snap = ref.get()
    if not snap.exists:
        return jsonify({"error": "Not found."}), 404
    t = snap.to_dict() or {}
    if t.get("uid") != request.uid:
        return jsonify({"error": "Not your ticket."}), 403
    ref.set({"unread_student": 0}, merge=True)
    return jsonify({"ticket": _ticket_public(tid, t), "messages": _messages(tid)})


@admin_bp.route("/api/support/ticket/<tid>/message", methods=["POST"])
@require_auth
def support_reply(tid):
    snap = _db().collection("support_tickets").document(tid).get()
    if not snap.exists:
        return jsonify({"error": "Not found."}), 404
    t = snap.to_dict() or {}
    if t.get("uid") != request.uid:
        return jsonify({"error": "Not your ticket."}), 403
    text = ((request.json or {}).get("text") or "").strip()[:2000]
    if not text:
        return jsonify({"error": "Write something first."}), 400
    u = _user(request.uid) or {}
    role = u.get("role", "student")
    at = _add_message(tid, SIDE_USER,
                      u.get("name") or role.title(), text, by_role=role)
    return jsonify({"ok": True, "at": at})


# ── Admin side ───────────────────────────────────────────────────────────

@admin_bp.route("/api/admin/support", methods=["GET"])
@require_auth
@require_admin
def admin_support_inbox():
    status = request.args.get("status", "")
    q = _db().collection("support_tickets")
    if status in ("open", "closed"):
        q = q.where("status", "==", status)
    out = [_ticket_public(doc.id, doc.to_dict() or {}) for doc in q.stream()]
    out.sort(key=lambda t: t["updated_at"] or "", reverse=True)
    return jsonify({"tickets": out,
                    "unread": sum(t["unread_admin"] for t in out),
                    "open": sum(1 for t in out if t["status"] == "open")})


@admin_bp.route("/api/admin/support/<tid>", methods=["GET"])
@require_auth
@require_admin
def admin_support_thread(tid):
    ref = _db().collection("support_tickets").document(tid)
    snap = ref.get()
    if not snap.exists:
        return jsonify({"error": "Not found."}), 404
    t = snap.to_dict() or {}
    ref.set({"unread_admin": 0}, merge=True)

    role = t.get("role", "student")
    uid = t.get("uid", "")

    # Repair the school on the way past. Threads opened before the fix
    # carry school_id="" — for teachers, always, since their user doc
    # never had one to copy.
    t = _heal_school(ref, t, uid)

    # The details next to the chat: who is this, where do they study or
    # teach, how are they doing — so a reply never starts from zero
    # context. Students and teachers each get their own block; the
    # console renders whichever one is populated.
    r, teach = {}, {}

    if role == "student":
        rs = _db().collection("student_rollups").document(uid).get()
        if rs.exists:
            rr = rs.to_dict() or {}
            rr["uid"] = uid
            r = _roster_row(rr)
        # OUTSIDE the rollup check on purpose. A student who has not
        # taken a test yet has no rollup, but they still have a school,
        # and "no school" on their conversation would be a lie. The
        # rollup only supplies an id anyway; the readable name lives on
        # the class doc.
        r["school_name"] = t.get("school_name") or _school_of(_user(uid) or {})[1]

    elif role == "teacher":
        teach = _teacher_context(uid)

    return jsonify({"ticket": _ticket_public(tid, t),
                    "student": r, "teacher": teach,
                    "messages": _messages(tid)})


def _teacher_context(uid):
    """Who this teacher is, for the panel beside their conversation.

    Best-effort and never raises: a missing class document must not turn
    a support reply into a 500. Roles are read from the SAME self-declared
    users/{uid}.class_roles map teacher_home.py writes, so what the
    console shows is exactly what the teacher chose."""
    u = _user(uid) or {}
    keys = u.get("class_keys", []) or []
    roles = u.get("class_roles", {}) or {}

    classes, students = [], 0
    for key in keys[:6]:
        rec = roles.get(key) or {}
        subs = [s for s in (rec.get("subjects") or []) if s]
        c = _class_doc(key)
        count = int(c.get("student_count", 0) or 0)
        students += count
        classes.append({
            "class_key": key,
            "class_id": c.get("class_id", "") or key,
            "school_name": c.get("school_name", ""),
            "role": rec.get("role") or "",
            "subjects": subs,
            "students": count,
        })

    sid, sname = _school_of(u)
    return {
        "uid": uid,
        "name": u.get("name", ""),
        "email": u.get("email", ""),
        # Resolved through the class docs — a teacher user doc has no
        # school_id of its own, which is the whole reason this exists.
        "school_id": sid,
        "school_name": sname,
        "classes": classes,
        "class_count": len(keys),
        "students": students,
    }


@admin_bp.route("/api/admin/support/<tid>/message", methods=["POST"])
@require_auth
@require_admin
def admin_support_reply(tid):
    snap = _db().collection("support_tickets").document(tid).get()
    if not snap.exists:
        return jsonify({"error": "Not found."}), 404
    text = ((request.json or {}).get("text") or "").strip()[:2000]
    if not text:
        return jsonify({"error": "Write something first."}), 400
    at = _add_message(tid, SIDE_ADMIN,
                      request.user_doc.get("name", "NAADI team"), text,
                      by_role="admin")
    return jsonify({"ok": True, "at": at})


@admin_bp.route("/api/admin/support/<tid>/status", methods=["POST"])
@require_auth
@require_admin
def admin_support_status(tid):
    status = (request.json or {}).get("status", "")
    if status not in ("open", "closed"):
        return jsonify({"error": "status must be open or closed"}), 400
    ref = _db().collection("support_tickets").document(tid)
    if not ref.get().exists:
        return jsonify({"error": "Not found."}), 404
    ref.set({"status": status,
             "updated_at": datetime.now(timezone.utc).isoformat()}, merge=True)
    return jsonify({"ok": True, "status": status})


# ═══════════════════════════════════════════════════════════════════════════
# INIT + CLI
# ═══════════════════════════════════════════════════════════════════════════

def init_admin(app, require_auth=None):
    """Attach the admin console to YOUR Flask app. `require_auth` is
    accepted for signature symmetry with init_portal but auth already
    flows through portal_backend's late-bound decorator, which
    init_portal wired to backend.py's implementation."""
    app.register_blueprint(admin_bp)
    print(f"[admin] {len(admin_bp.deferred_functions)} admin routes registered "
          f"on {app.name} "
          f"(bootstrap emails: {len(ADMIN_EMAILS) or 'none — use the CLI'})")
    return app


def _cli_grant(email):
    """python admin_backend.py grant someone@x.com"""
    import firebase_admin
    from firebase_admin import credentials
    sa = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "serviceAccountKey.json")
    if not firebase_admin._apps:
        if os.path.exists(sa):
            firebase_admin.initialize_app(credentials.Certificate(sa))
        else:
            firebase_admin.initialize_app()
    email = email.strip().lower()
    hit = None
    for d in _db().collection("users").where("email", "==", email).limit(1).stream():
        hit = d
    if not hit:
        print(f"No user with email {email}. They must sign up first "
              f"(any role), then run this again.")
        return 1
    _db().collection("users").document(hit.id).set({"role": "admin"}, merge=True)
    print(f"✅ {email} ({hit.id}) is now an admin.")
    return 0


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "grant":
        sys.exit(_cli_grant(sys.argv[2]))
    print(__doc__)