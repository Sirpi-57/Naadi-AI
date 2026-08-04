"""
NAADI AI — DOUBTS BACKEND (doubts_backend.py)
════════════════════════════════════════════════════════════════════════

Student <-> teacher conversations, plus class-teacher supervision and the
safety layer around both.

The NAADI-team conversation is NOT here. That lives in admin_backend.py
under /api/support/* and is a different shape: one thread per account,
uid-keyed. This file is many-to-many — one student has N threads, one
teacher has up to 50 — which is exactly why it could not reuse that
collection.

════════════════════════════════════════════════════════════════════════
DATA MODEL
    doubt_threads/{thread_id}
        thread_id = "{class_key}__{student_uid}__{teacher_uid}"
        class_key, school_id, school_name, class_id
        student_uid, student_name
        teacher_uid, teacher_name
        teacher_role   "class_teacher" | "subject_teacher" | ""
        subject        snapshot at creation — see below
        status         "open" | "resolved"
        created_at, updated_at, last_message, last_from
        unread_student, unread_teacher
        report_count

    doubt_threads/{thread_id}/messages/{auto}
        from ("student"|"teacher"), by_uid, by_name, text, at

    safety_reports/{auto}
        thread_id, class_key, by_uid, by_role, against_uid, against_role,
        reason, at, status ("open"|"reviewed"), last_messages (snapshot)

════════════════════════════════════════════════════════════════════════
FOUR DECISIONS THAT ARE NOT ARBITRARY

1. THE DOCUMENT ID IS DERIVED, NOT GENERATED.
   "{class_key}__{student_uid}__{teacher_uid}" means a given pair has
   exactly one conversation and the database enforces it. A double tap,
   a retried request, or two devices cannot produce a second thread that
   splits the history in half. Same reasoning as support_tickets being
   keyed by uid.

2. `subject` IS A SNAPSHOT, NOT A LOOKUP.
   Teachers self-declare their subjects and can change them. If the
   thread resolved the subject live, a chemistry doubt asked in July
   would relabel itself as biology in September. What the label meant
   when the conversation started is the true thing.

3. SUPERVISION HAS ITS OWN ROUTES.
   The class teacher's read-only access is not a flag checked inside the
   participant handler. It is a separate URL that has no write sibling.
   Read-only is enforced by routing, so no future edit to a shared
   handler can quietly grant a supervisor the ability to post.

4. SCOPE IS NEVER TAKEN FROM THE REQUEST.
   Every handler resolves class, role and membership from Firestore
   using request.uid. A client may name a thread id; it may never name
   its own permissions. `_access()` is the single place that decides.
"""

import os
from datetime import datetime, timezone
from functools import wraps

from flask import Blueprint, request, jsonify
from firebase_admin import firestore

from portal_backend import (
    _db, _iso, _initials, require_auth, require_role, class_key_for,
)
from teacher_home import class_role_for

doubts_bp = Blueprint("doubts", __name__)

MAX_CHARS = 2000
MAX_MESSAGES = 300
SIDE_STUDENT = "student"
SIDE_TEACHER = "teacher"


# ═══════════════════════════════════════════════════════════════════════
# SMALL HELPERS
# ═══════════════════════════════════════════════════════════════════════

def _now():
    return datetime.now(timezone.utc).isoformat()


def _user(uid):
    if not uid:
        return {}
    try:
        snap = _db().collection("users").document(uid).get()
        return (snap.to_dict() or {}) if snap.exists else {}
    except Exception as e:
        print(f"[doubts] user read failed for {uid}: {e}")
        return {}


_CLASS_CACHE = {}


def _class_doc(key):
    if not key:
        return {}
    if key not in _CLASS_CACHE:
        try:
            snap = _db().collection("classes").document(key).get()
            _CLASS_CACHE[key] = (snap.to_dict() or {}) if snap.exists else {}
        except Exception as e:
            print(f"[doubts] class read failed for {key}: {e}")
            _CLASS_CACHE[key] = {}
    return _CLASS_CACHE[key]


def thread_id(class_key, student_uid, teacher_uid):
    """The one and only way a thread id is formed. See decision 1."""
    return f"{class_key}__{student_uid}__{teacher_uid}"


def _subject_label(cr):
    """What to call this conversation, from a class_role_for() record."""
    if cr.get("role") == "class_teacher":
        return "Class teacher"
    subs = cr.get("subjects") or []
    return " + ".join(subs) if subs else "General"


# ═══════════════════════════════════════════════════════════════════════
# WHO IS IN A CLASS
# ═══════════════════════════════════════════════════════════════════════

def _class_teachers(class_key):
    """Every teacher attached to a class, with their declared role.

    Reads classes/{key}.teacher_uids FIRST, because that is what the rest
    of the portal uses. But that array is written by portal_scripts.py, a
    manual CLI attach step — a teacher onboarded any other way is absent
    from it while still carrying the class in their own class_keys. So
    this unions in a query over users as well.

    Getting this wrong is invisible and total: the student simply sees no
    teachers and has no way to know why.
    """
    uids, seen = [], set()

    for uid in (_class_doc(class_key).get("teacher_uids", []) or []):
        if uid not in seen:
            seen.add(uid)
            uids.append(uid)

    try:
        q = _db().collection("users") \
            .where("class_keys", "array_contains", class_key)
        for doc in q.stream():
            u = doc.to_dict() or {}
            if u.get("role") != "teacher":
                continue
            if doc.id not in seen:
                seen.add(doc.id)
                uids.append(doc.id)
    except Exception as e:
        # An index that does not exist yet must degrade to the
        # teacher_uids list, not to an empty screen.
        print(f"[doubts] teacher fallback query failed for {class_key}: {e}")

    out = []
    for uid in uids:
        u = _user(uid)
        if not u:
            continue
        cr = class_role_for(u, class_key)
        out.append({
            "uid": uid,
            "name": u.get("name") or "Teacher",
            "initials": _initials(u.get("name") or "T"),
            "role": cr.get("role") or "",
            "subjects": cr.get("subjects") or [],
            "subject": _subject_label(cr),
        })

    # Class teacher first, then subject teachers alphabetically. A
    # student looking for "who do I ask about this" reads top-down.
    out.sort(key=lambda t: (t["role"] != "class_teacher", t["name"].lower()))
    return out


def _class_students(class_key):
    """Approved students in a class, from the rollups.

    uid comes from doc.id, never the body field — the two can drift and
    the id is the authority. Same rule as teacher_backend._roster().
    """
    out = []
    try:
        for doc in _db().collection("student_rollups") \
                .where("class_key", "==", class_key).stream():
            r = doc.to_dict() or {}
            if r.get("class_status") != "approved":
                continue
            out.append({
                "uid": doc.id,
                "name": r.get("name") or "Student",
                "initials": r.get("initials") or _initials(r.get("name") or "S"),
            })
    except Exception as e:
        print(f"[doubts] roster read failed for {class_key}: {e}")
    out.sort(key=lambda s: s["name"].lower())
    return out


def _student_class(u):
    """(class_key, approved) for a student user doc."""
    key = ""
    try:
        key = class_key_for(u) or ""
    except Exception:
        key = ""
    return key, (u.get("class_status") == "approved")


# ═══════════════════════════════════════════════════════════════════════
# ACCESS — the single place that decides who may see what
# ═══════════════════════════════════════════════════════════════════════

def _access(t, uid, u):
    """What `uid` may do with thread `t`.

    Returns "student" | "teacher" (participants, read+write),
            "supervisor" (class teacher, READ ONLY),
            or None.

    Nothing here reads the request body. Everything is resolved from the
    thread document and the caller's own user document.
    """
    if not t:
        return None

    if t.get("student_uid") == uid:
        return SIDE_STUDENT
    if t.get("teacher_uid") == uid:
        return SIDE_TEACHER

    # Class teacher of the class this thread belongs to. Read only, and
    # only for that class — a class teacher of 11-B sees nothing in 12-A.
    if (u or {}).get("role") == "teacher":
        key = t.get("class_key", "")
        if key and key in (u.get("class_keys", []) or []):
            if class_role_for(u, key).get("role") == "class_teacher":
                return "supervisor"
    return None


def _load(tid):
    ref = _db().collection("doubt_threads").document(tid)
    snap = ref.get()
    return ref, ((snap.to_dict() or {}) if snap.exists else None)


def _require(tid, allow):
    """(ref, thread, access) or a Flask error tuple.

    `allow` is the set of access levels this route accepts. Supervisors
    are simply absent from `allow` on every write route.
    """
    ref, t = _load(tid)
    if t is None:
        return None, None, None, (jsonify({"error": "Conversation not found."}), 404)
    u = getattr(request, "user_doc", None) or _user(request.uid)
    acc = _access(t, request.uid, u)
    if acc not in allow:
        return None, None, None, (jsonify({"error": "Not your conversation."}), 403)
    return ref, t, acc, None


# ═══════════════════════════════════════════════════════════════════════
# THREAD SHAPE + WRITES
# ═══════════════════════════════════════════════════════════════════════

def _public(tid, t, viewer):
    """The thread as one side sees it. `viewer` picks which unread count
    is 'yours' so no client ever has to work that out."""
    mine_unread = (t.get("unread_student", 0) if viewer == SIDE_STUDENT
                   else t.get("unread_teacher", 0))
    return {
        "thread_id": tid,
        "class_key": t.get("class_key", ""),
        "class_id": t.get("class_id", ""),
        "school_name": t.get("school_name", ""),
        "student_uid": t.get("student_uid", ""),
        "student_name": t.get("student_name", ""),
        "teacher_uid": t.get("teacher_uid", ""),
        "teacher_name": t.get("teacher_name", ""),
        "teacher_role": t.get("teacher_role", ""),
        "subject": t.get("subject", ""),
        "status": t.get("status", "open"),
        "last_message": t.get("last_message", ""),
        "last_from": t.get("last_from", ""),
        "unread": int(mine_unread or 0),
        "unread_student": int(t.get("unread_student", 0) or 0),
        "unread_teacher": int(t.get("unread_teacher", 0) or 0),
        "report_count": int(t.get("report_count", 0) or 0),
        "created_at": _iso(t.get("created_at")),
        "updated_at": _iso(t.get("updated_at")),
    }


def _messages(tid, limit=MAX_MESSAGES):
    out = []
    try:
        for doc in _db().collection("doubt_threads").document(tid) \
                .collection("messages").order_by("at").limit(limit).stream():
            m = doc.to_dict() or {}
            out.append({"from": m.get("from", ""), "by_name": m.get("by_name", ""),
                        "text": m.get("text", ""), "at": _iso(m.get("at"))})
    except Exception as e:
        print(f"[doubts] message read failed for {tid}: {e}")
    return out


def _ensure_thread(class_key, student_uid, teacher_uid):
    """Create the thread if it is not there; return (ref, tid).

    Idempotent by construction — the id is derived, so calling this twice
    writes the same document twice rather than creating two.
    """
    tid = thread_id(class_key, student_uid, teacher_uid)
    ref = _db().collection("doubt_threads").document(tid)
    if ref.get().exists:
        return ref, tid

    su, tu = _user(student_uid), _user(teacher_uid)
    c = _class_doc(class_key)
    cr = class_role_for(tu, class_key)
    now = _now()

    ref.set({
        "class_key": class_key,
        "class_id": c.get("class_id", ""),
        "school_id": c.get("school_id", ""),
        "school_name": c.get("school_name", ""),
        "student_uid": student_uid,
        "student_name": su.get("name") or "Student",
        "teacher_uid": teacher_uid,
        "teacher_name": tu.get("name") or "Teacher",
        "teacher_role": cr.get("role") or "",
        # Snapshot. See decision 2 in the module docstring.
        "subject": _subject_label(cr),
        "status": "open",
        "created_at": now, "updated_at": now,
        "last_message": "", "last_from": "",
        "unread_student": 0, "unread_teacher": 0,
        "report_count": 0,
    })
    return ref, tid


def _add_message(ref, tid, sender, by_uid, by_name, text):
    now = _now()
    ref.collection("messages").add({
        "from": sender, "by_uid": by_uid, "by_name": by_name,
        "text": text, "at": now,
    })
    other = "unread_teacher" if sender == SIDE_STUDENT else "unread_student"
    ref.set({
        "last_message": text[:200], "last_from": sender,
        "updated_at": now,
        # Any new message reopens a resolved conversation. A student who
        # still does not understand should not have to ask twice.
        "status": "open",
        other: firestore.Increment(1),
    }, merge=True)
    return now


def _text_arg():
    t = ((request.json or {}).get("text") or "").strip()[:MAX_CHARS]
    return t


# ═══════════════════════════════════════════════════════════════════════
# STUDENT SIDE
# ═══════════════════════════════════════════════════════════════════════

@doubts_bp.route("/api/doubts/teachers", methods=["GET"])
@require_auth
@require_role("student")
def student_teachers():
    """The teachers this student may write to — their own class, nobody
    else's. One row per teacher, whether or not a thread exists yet."""
    u = request.user_doc
    class_key, approved = _student_class(u)
    if not class_key or not approved:
        return jsonify({"teachers": [], "class_key": "", "approved": False})

    teachers = _class_teachers(class_key)

    # Attach any existing thread so the client shows one row per teacher
    # rather than a teacher list and a separate conversation list.
    for t in teachers:
        tid = thread_id(class_key, request.uid, t["uid"])
        snap = _db().collection("doubt_threads").document(tid).get()
        if snap.exists:
            d = snap.to_dict() or {}
            t["thread"] = _public(tid, d, SIDE_STUDENT)
        else:
            t["thread"] = None

    return jsonify({"teachers": teachers, "class_key": class_key,
                    "approved": True})


@doubts_bp.route("/api/doubts/thread", methods=["POST"])
@require_auth
@require_role("student")
def student_start():
    """Open (or continue) a conversation with one of MY teachers."""
    u = request.user_doc
    class_key, approved = _student_class(u)
    if not class_key or not approved:
        return jsonify({"error": "You are not in an approved class yet."}), 403

    teacher_uid = ((request.json or {}).get("teacher_uid") or "").strip()
    text = _text_arg()
    if not text:
        return jsonify({"error": "Write something first."}), 400

    # The teacher must be in THIS student's class. Resolved server-side —
    # a client naming any other uid gets nothing.
    if teacher_uid not in {t["uid"] for t in _class_teachers(class_key)}:
        return jsonify({"error": "That teacher does not take your class."}), 403

    ref, tid = _ensure_thread(class_key, request.uid, teacher_uid)
    _add_message(ref, tid, SIDE_STUDENT, request.uid,
                 u.get("name") or "Student", text)
    return jsonify({"ok": True, "thread_id": tid})


@doubts_bp.route("/api/doubts/threads", methods=["GET"])
@require_auth
@require_role("student")
def student_threads():
    out = []
    try:
        for doc in _db().collection("doubt_threads") \
                .where("student_uid", "==", request.uid).stream():
            out.append(_public(doc.id, doc.to_dict() or {}, SIDE_STUDENT))
    except Exception as e:
        print(f"[doubts] student thread list failed: {e}")
    out.sort(key=lambda t: t["updated_at"] or "", reverse=True)
    return jsonify({"threads": out})


# ═══════════════════════════════════════════════════════════════════════
# TEACHER SIDE
# ═══════════════════════════════════════════════════════════════════════

@doubts_bp.route("/api/teacher/doubts", methods=["GET"])
@require_auth
@require_role("teacher")
def teacher_threads():
    out = []
    try:
        for doc in _db().collection("doubt_threads") \
                .where("teacher_uid", "==", request.uid).stream():
            out.append(_public(doc.id, doc.to_dict() or {}, SIDE_TEACHER))
    except Exception as e:
        print(f"[doubts] teacher thread list failed: {e}")
    out.sort(key=lambda t: t["updated_at"] or "", reverse=True)
    return jsonify({"threads": out})


@doubts_bp.route("/api/teacher/doubts/students", methods=["GET"])
@require_auth
@require_role("teacher")
def teacher_roster():
    """Students this teacher may open a conversation with. Either side may
    start one — a teacher noticing a struggling student should not have to
    wait to be asked."""
    key = (request.args.get("class_key") or "").strip()
    keys = request.user_doc.get("class_keys", []) or []
    if key and key not in keys:
        return jsonify({"error": "Not your class."}), 403
    key = key or (keys[0] if keys else "")
    if not key:
        return jsonify({"students": [], "class_key": ""})
    return jsonify({"students": _class_students(key), "class_key": key})


@doubts_bp.route("/api/teacher/doubts/thread", methods=["POST"])
@require_auth
@require_role("teacher")
def teacher_start():
    student_uid = ((request.json or {}).get("student_uid") or "").strip()
    key = ((request.json or {}).get("class_key") or "").strip()
    text = _text_arg()
    if not text:
        return jsonify({"error": "Write something first."}), 400

    keys = request.user_doc.get("class_keys", []) or []
    key = key or (keys[0] if keys else "")
    if key not in keys:
        return jsonify({"error": "Not your class."}), 403
    if student_uid not in {s["uid"] for s in _class_students(key)}:
        return jsonify({"error": "That student is not in your class."}), 403

    ref, tid = _ensure_thread(key, student_uid, request.uid)
    _add_message(ref, tid, SIDE_TEACHER, request.uid,
                 request.user_doc.get("name") or "Teacher", text)
    return jsonify({"ok": True, "thread_id": tid})


@doubts_bp.route("/api/teacher/doubts/thread/<tid>/status", methods=["POST"])
@require_auth
@require_role("teacher")
def teacher_status(tid):
    """Resolve or reopen. Participants only — a supervisor reads, and
    that is all a supervisor does."""
    ref, t, acc, err = _require(tid, {SIDE_TEACHER})
    if err:
        return err
    status = ((request.json or {}).get("status") or "").strip()
    if status not in ("open", "resolved"):
        return jsonify({"error": "status must be open or resolved"}), 400
    ref.set({"status": status, "updated_at": _now()}, merge=True)
    return jsonify({"ok": True, "status": status})


# ═══════════════════════════════════════════════════════════════════════
# SHARED — read and write a thread you are IN
# ═══════════════════════════════════════════════════════════════════════

@doubts_bp.route("/api/doubts/thread/<tid>", methods=["GET"])
@require_auth
def read_thread(tid):
    ref, t, acc, err = _require(tid, {SIDE_STUDENT, SIDE_TEACHER})
    if err:
        return err
    ref.set({("unread_student" if acc == SIDE_STUDENT else "unread_teacher"): 0},
            merge=True)
    t[("unread_student" if acc == SIDE_STUDENT else "unread_teacher")] = 0
    return jsonify({"thread": _public(tid, t, acc), "messages": _messages(tid),
                    "access": acc})


@doubts_bp.route("/api/doubts/thread/<tid>/message", methods=["POST"])
@require_auth
def send_message(tid):
    ref, t, acc, err = _require(tid, {SIDE_STUDENT, SIDE_TEACHER})
    if err:
        return err
    text = _text_arg()
    if not text:
        return jsonify({"error": "Write something first."}), 400
    name = (t.get("student_name") if acc == SIDE_STUDENT
            else t.get("teacher_name")) or "Someone"
    at = _add_message(ref, tid, acc, request.uid, name, text)
    return jsonify({"ok": True, "at": at})


# ═══════════════════════════════════════════════════════════════════════
# SUPERVISION — class teacher, READ ONLY
#
# Separate routes with no write sibling. See decision 3.
# ═══════════════════════════════════════════════════════════════════════

@doubts_bp.route("/api/teacher/doubts/supervise", methods=["GET"])
@require_auth
@require_role("teacher")
def supervise_list():
    u = request.user_doc
    keys = [k for k in (u.get("class_keys", []) or [])
            if class_role_for(u, k).get("role") == "class_teacher"]
    if not keys:
        return jsonify({"threads": [], "classes": []})

    out = []
    for key in keys:
        try:
            for doc in _db().collection("doubt_threads") \
                    .where("class_key", "==", key).stream():
                d = doc.to_dict() or {}
                # Your own conversations are not supervision; they are
                # already in your own list and would appear twice.
                if d.get("teacher_uid") == request.uid:
                    continue
                row = _public(doc.id, d, SIDE_TEACHER)
                row["unread"] = 0          # supervision is never "unread"
                out.append(row)
        except Exception as e:
            print(f"[doubts] supervise list failed for {key}: {e}")
    out.sort(key=lambda t: t["updated_at"] or "", reverse=True)
    return jsonify({"threads": out, "classes": keys})


@doubts_bp.route("/api/teacher/doubts/supervise/<tid>", methods=["GET"])
@require_auth
@require_role("teacher")
def supervise_read(tid):
    ref, t, acc, err = _require(tid, {"supervisor"})
    if err:
        return err
    # No unread is cleared and no message is written. Reading here leaves
    # no trace on the conversation, because a supervisor is not in it.
    return jsonify({"thread": _public(tid, t, SIDE_TEACHER),
                    "messages": _messages(tid), "access": "supervisor",
                    "read_only": True})


# ═══════════════════════════════════════════════════════════════════════
# SAFETY — reporting
#
# Available to both participants. Not to a supervisor: a class teacher
# who sees something wrong should act, and has the whole thread in front
# of them to escalate with.
# ═══════════════════════════════════════════════════════════════════════

@doubts_bp.route("/api/doubts/thread/<tid>/report", methods=["POST"])
@require_auth
def report_thread(tid):
    ref, t, acc, err = _require(tid, {SIDE_STUDENT, SIDE_TEACHER})
    if err:
        return err
    reason = ((request.json or {}).get("reason") or "").strip()[:1000]

    against = (t.get("teacher_uid") if acc == SIDE_STUDENT
               else t.get("student_uid"))
    _db().collection("safety_reports").add({
        "thread_id": tid,
        "class_key": t.get("class_key", ""),
        "school_name": t.get("school_name", ""),
        "by_uid": request.uid, "by_role": acc,
        "against_uid": against,
        "against_role": SIDE_TEACHER if acc == SIDE_STUDENT else SIDE_STUDENT,
        "student_name": t.get("student_name", ""),
        "teacher_name": t.get("teacher_name", ""),
        "reason": reason,
        "at": _now(), "status": "open",
        # A snapshot so a reviewer sees what was reported even if the
        # conversation carries on afterwards.
        "last_messages": _messages(tid)[-20:],
    })
    ref.set({"report_count": firestore.Increment(1)}, merge=True)
    return jsonify({"ok": True})


# ═══════════════════════════════════════════════════════════════════════
# BADGE
# ═══════════════════════════════════════════════════════════════════════

@doubts_bp.route("/api/doubts/unread", methods=["GET"])
@require_auth
def unread_count():
    """One number for the nav badge. Role resolved server-side; a client
    cannot ask for the other side's count."""
    u = getattr(request, "user_doc", None) or _user(request.uid)
    role = u.get("role", "")
    n = 0
    try:
        if role == "student":
            field, q = "unread_student", _db().collection("doubt_threads") \
                .where("student_uid", "==", request.uid)
        elif role == "teacher":
            field, q = "unread_teacher", _db().collection("doubt_threads") \
                .where("teacher_uid", "==", request.uid)
        else:
            return jsonify({"unread": 0})
        for doc in q.stream():
            n += int((doc.to_dict() or {}).get(field, 0) or 0)
    except Exception as e:
        print(f"[doubts] unread count failed: {e}")
    return jsonify({"unread": n})


# ═══════════════════════════════════════════════════════════════════════
# ADMIN — the reports queue
# ═══════════════════════════════════════════════════════════════════════

def _require_admin(f):
    @wraps(f)
    def inner(*a, **kw):
        u = getattr(request, "user_doc", None) or _user(request.uid)
        if u.get("role") != "admin":
            return jsonify({"error": "Admins only."}), 403
        return f(*a, **kw)
    return inner


@doubts_bp.route("/api/admin/doubts/reports", methods=["GET"])
@require_auth
@_require_admin
def admin_reports():
    status = request.args.get("status", "open")
    out = []
    try:
        for doc in _db().collection("safety_reports").stream():
            r = doc.to_dict() or {}
            if status in ("open", "reviewed") and r.get("status", "open") != status:
                continue
            r["report_id"] = doc.id
            r["at"] = _iso(r.get("at"))
            out.append(r)
    except Exception as e:
        print(f"[doubts] report list failed: {e}")
    out.sort(key=lambda r: r.get("at") or "", reverse=True)
    return jsonify({"reports": out, "open": sum(1 for r in out
                                                if r.get("status") == "open")})


@doubts_bp.route("/api/admin/doubts/thread/<tid>", methods=["GET"])
@require_auth
@_require_admin
def admin_read_thread(tid):
    _, t = _load(tid)
    if t is None:
        return jsonify({"error": "Conversation not found."}), 404
    return jsonify({"thread": _public(tid, t, SIDE_TEACHER),
                    "messages": _messages(tid)})


@doubts_bp.route("/api/admin/doubts/report/<rid>/status", methods=["POST"])
@require_auth
@_require_admin
def admin_report_status(rid):
    status = ((request.json or {}).get("status") or "").strip()
    if status not in ("open", "reviewed"):
        return jsonify({"error": "status must be open or reviewed"}), 400
    _db().collection("safety_reports").document(rid).set(
        {"status": status, "reviewed_at": _now()}, merge=True)
    return jsonify({"ok": True, "status": status})


# ═══════════════════════════════════════════════════════════════════════
# REGISTRATION
# ═══════════════════════════════════════════════════════════════════════

def register_doubt_routes(app):
    """Attach the Doubts blueprint, refusing to start on a real collision.

    Flask resolves a genuine duplicate silently, to whichever blueprint
    registered first. That failure is invisible at runtime and serves the
    wrong data with no error, so it is worth catching at import.

    WHAT COUNTS AS A COLLISION — and what emphatically does not:

    A rule's identity is (path, METHOD, endpoint), never the path alone.
    Registering the same path twice with different methods is ordinary
    Flask and is all over this codebase:

        @home_bp.route("/api/teacher/class/<class_key>/my-role", methods=["GET"])
        @home_bp.route("/api/teacher/class/<class_key>/my-role", methods=["POST"])

    An earlier version of this function compared str(rule), which is the
    path with the methods stripped off. It therefore read every legitimate
    GET/POST pair in the app as a duplicate and refused to boot. That was
    a bug in the guard, not in the app.

    So: a collision is a (path, method) slot that THIS blueprint has just
    landed in while another endpoint already owned it. Duplicates that
    exist purely between other people's blueprints are not this
    function's business and must not block startup.
    """
    def slots():
        out = {}
        for r in app.url_map.iter_rules():
            for m in (r.methods or set()) - {"HEAD", "OPTIONS"}:
                out.setdefault((str(r), m), set()).add(r.endpoint)
        return out

    before = slots()
    app.register_blueprint(doubts_bp)
    after = slots()

    prefix = doubts_bp.name + "."
    clashes = []
    for (path, method), endpoints in after.items():
        mine = {e for e in endpoints if e.startswith(prefix)}
        others = endpoints - mine
        if mine and others:
            clashes.append(f"{method} {path}  (mine: {sorted(mine)[0]}, "
                           f"already owned by: {sorted(others)[0]})")

    if clashes:
        raise RuntimeError(
            "doubts_backend: route collision on\n  "
            + "\n  ".join(sorted(clashes))
        )

    added = len(set(after) - set(before))
    print(f"[doubts] {added} doubt routes registered")