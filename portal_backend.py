"""
NAADI AI — PORTAL BACKEND  (portal_backend.py)
═══════════════════════════════════════════════════════════════════════════

Parent portal: roles, guards, the student_rollups writer, the parent
invite/claim flow, and every /api/parent/* route.

INTEGRATION — backend.py changes by exactly two lines. See INTEGRATION.md.

DESIGN RULES
  • This module is DECOUPLED. It verifies Firebase tokens itself and gets
    its own firestore handle lazily, so it can be imported anywhere after
    firebase_admin.initialize_app(). backend.py is not modified beyond the
    blueprint registration and four one-line rollup hooks.
  • The client NEVER names the scope it reads. @resolve_child resolves the
    child list from users/{parent_uid}.children[] on every single request.
  • Everything a parent sees is READ-ONLY. No route here writes to a
    student's progress, sessions, or answers.
  • Rollup writes are synchronous and best-effort. At ~1,200 students a
    rollup rebuild is ~4 queries. If it fails, the student's own request
    must still succeed — every hook is wrapped in try/except.
"""

import os
import re
import time
import secrets
from datetime import datetime, timezone, timedelta
from functools import wraps

from flask import Blueprint, request, jsonify
from firebase_admin import firestore, auth as firebase_auth
from rollup_signals import build_signals
# The single flag engine. Pure functions, no imports of its own, so this
# cannot introduce a cycle.
from teacher_signals import flags_for
portal_bp = Blueprint("portal", __name__)

# ═══════════════════════════════════════════════════════════════════════════
# CONFIG
# ═══════════════════════════════════════════════════════════════════════════

# Where claim.html is reachable from a normal browser. The invite email link
# points here. Capacitor apps have no public URL, so this must be the Flask
# host (or wherever you serve the mobile/ folder).
WEB_BASE = os.environ.get("NAADI_WEB_BASE", "http://localhost:5000")

# Firebase "Trigger Email" extension watches this collection.
MAIL_COLLECTION = os.environ.get("NAADI_MAIL_COLLECTION", "mail")

INVITE_TTL_DAYS = 14
INVITE_RESEND_COOLDOWN_MIN = 60

IST_TZ = timezone(timedelta(hours=5, minutes=30))

# Mirrors backend.py exactly. If you change it there, change it here.
SCALE_WEIGHTS = {"studio": 30, "opd": 40, "arena": 30}
DOCTOR_LADDER = [
    {"key": "intern",          "title": "Intern",          "at": 0},
    {"key": "junior_resident", "title": "Junior Resident",  "at": 20},
    {"key": "senior_resident", "title": "Senior Resident",  "at": 40},
    {"key": "registrar",       "title": "Registrar",        "at": 60},
    {"key": "consultant",      "title": "Consultant",       "at": 80},
    {"key": "doctor",          "title": "Doctor",           "at": 95},
]
DEFAULT_TESTS_PER_CHAPTER = 18
PASS_THRESHOLD = 40

# Alert thresholds — the same rules the teacher deck will use later.
INACTIVE_DAYS = 7
LOW_MASTERY = 40
SUBJECTS = ["Biology", "Physics", "Chemistry"]


# ═══════════════════════════════════════════════════════════════════════════
# PRIMITIVES  (self-contained — no imports from backend.py)
# ═══════════════════════════════════════════════════════════════════════════

_db_handle = None

# Set by init_portal(app, require_auth=...). When present, every portal route
# authenticates through backend.py's own decorator — one auth implementation
# for the whole service, not two that can drift apart.
_AUTH_IMPL = None


def _db():
    """Lazy firestore handle. Safe to import this module before init."""
    global _db_handle
    if _db_handle is None:
        _db_handle = firestore.client()
    return _db_handle


def _clean(data):
    """Strip Firestore Sentinels, stringify timestamps. Same as backend.py."""
    if isinstance(data, dict):
        out = {}
        for k, v in data.items():
            if hasattr(v, "__class__") and "Sentinel" in v.__class__.__name__:
                continue
            if hasattr(v, "isoformat"):
                out[k] = v.isoformat()
            elif isinstance(v, (dict, list)):
                out[k] = _clean(v)
            else:
                out[k] = v
        return out
    if isinstance(data, list):
        return [_clean(i) if isinstance(i, (dict, list)) else i for i in data]
    return data


def _pct(correct, total):
    return round(correct / total * 100) if total else 0


def _iso(v):
    """Anything → ISO string or ''. Firestore timestamps, datetimes, strings."""
    if not v:
        return ""
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return str(v)


def _ist_today():
    return datetime.now(IST_TZ).date()


def _rank_for(pct):
    idx = 0
    for i, r in enumerate(DOCTOR_LADDER):
        if pct >= r["at"]:
            idx = i
    return idx


def _mask_phone(p):
    if not p or len(p) < 4:
        return ""
    return p[:2] + "•" * max(0, len(p) - 4) + p[-2:]


def _mask_email(e):
    if not e or "@" not in e:
        return ""
    name, dom = e.split("@", 1)
    head = name[:2] if len(name) > 2 else name[:1]
    return f"{head}{'•' * 4}@{dom}"


def _initials(name):
    parts = [w for w in str(name or "").strip().split() if w]
    return "".join(w[0] for w in parts[:2]).upper() or "?"


def _send_email(to, subject, html):
    """Queue an email for the Firebase Trigger Email extension.

    Never raises — a failed invite email must not 500 the caller. The
    invite row already exists; the resend button covers the failure.
    """
    try:
        _db().collection(MAIL_COLLECTION).add({
            "to": [to],
            "message": {"subject": subject, "html": html},
            "createdAt": firestore.SERVER_TIMESTAMP,
        })
        return True
    except Exception as e:
        print(f"[portal] mail queue failed for {to}: {e}")
        return False


# ═══════════════════════════════════════════════════════════════════════════
# PASSWORD RESET — branded email via the SAME Trigger Email pipe (PUBLIC)
# ═══════════════════════════════════════════════════════════════════════════
# The login screen's "Forgot password?" posts here. We mint the real Firebase
# reset link with the Admin SDK, wrap it in a branded HTML email, and queue it
# through _send_email() — the exact same "Trigger Email" collection the parent
# invites already use. That means the verified sender/deliverability we already
# have solves the spam problem; no new email provider, no backend.py changes.
#
# This route is PUBLIC (the user is logged out) and enumeration-safe: it always
# returns a generic 200 so an attacker can't probe which emails are registered.

_reset_last_sent = {}          # email -> monotonic seconds (light abuse guard)
_RESET_COOLDOWN_SEC = 45


def _reset_email_html(reset_link):
    """Branded, email-client-safe HTML (tables + inline CSS, bulletproof button)."""
    return f"""\
<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#0B1220;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0B1220;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0"
             style="max-width:480px;width:100%;background:#111c30;border-radius:16px;overflow:hidden;border:1px solid #1e2c44;">
        <tr><td style="background:#0f2547;padding:26px 32px;">
          <span style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:bold;color:#ffffff;letter-spacing:.5px;">
            NAADI <span style="color:#7db3ec;">AI</span>
          </span>
          <div style="height:2px;width:120px;background:#ffffff;margin-top:8px;border-radius:2px;opacity:.85;"></div>
        </td></tr>
        <tr><td style="padding:32px;">
          <h1 style="margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:22px;color:#ffffff;">Reset your password</h1>
          <p style="margin:0 0 24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#b9c4d6;">
            We received a request to reset the password for your NAADI AI account. Tap the button below to choose a new one.
          </p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 26px;">
            <tr><td align="center" bgcolor="#2f6cb3" style="border-radius:12px;">
              <a href="{reset_link}" target="_blank"
                 style="display:inline-block;padding:15px 40px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:12px;">
                Reset Password
              </a>
            </td></tr>
          </table>
          <p style="margin:0 0 8px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#7a869c;">
            This link expires in 1 hour. If the button doesn't work, copy and paste this URL into your browser:
          </p>
          <p style="margin:0 0 24px;font-family:Arial,Helvetica,sans-serif;font-size:12px;word-break:break-all;">
            <a href="{reset_link}" target="_blank" style="color:#7db3ec;">{reset_link}</a>
          </p>
          <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:#7a869c;">
            If you didn't request this, you can safely ignore this email — your password won't change.
          </p>
        </td></tr>
        <tr><td style="padding:20px 32px;border-top:1px solid #1e2c44;">
          <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#5f6b81;">
            Where future doctors begin. &nbsp;&#8226;&nbsp; The NAADI AI team
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>"""


@portal_bp.route("/api/auth/reset-password", methods=["POST"])
def auth_reset_password():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()

    if not email or "@" not in email:
        return jsonify({"error": "Please enter a valid email address."}), 400

    generic = {"status": "ok",
               "message": "If an account exists for that email, a reset link is on its way."}

    # light per-email cooldown (also masks timing for enumeration probes)
    now = time.monotonic()
    if now - _reset_last_sent.get(email, 0) < _RESET_COOLDOWN_SEC:
        return jsonify(generic), 200

    try:
        try:
            link = firebase_auth.generate_password_reset_link(email)
        except Exception as ge:
            # Unknown email → don't reveal; return generic success.
            if "NotFound" in type(ge).__name__ or "EMAIL_NOT_FOUND" in str(ge).upper():
                return jsonify(generic), 200
            raise

        ok = _send_email(email, "Reset your NAADI AI password", _reset_email_html(link))
        if not ok:
            return jsonify({"error": "Couldn't send the reset email right now. Please try again shortly."}), 502

        _reset_last_sent[email] = now
        return jsonify(generic), 200

    except Exception as e:
        print(f"[portal] reset-password error for {email}: {type(e).__name__}: {e}")
        return jsonify({"error": "Something went wrong sending the reset email. Please try again."}), 500


# ═══════════════════════════════════════════════════════════════════════════
# AUTH + GUARDS
#
# The client never names the scope it wants. It presents a token; the
# server derives role, children[], and class_keys[] from Firestore.
# ═══════════════════════════════════════════════════════════════════════════

def portal_auth(f):
    """Token verification.

    Delegates to backend.py's require_auth when init_portal() was given it —
    which is the normal case. That matters: if you ever harden require_auth
    (tighter clock skew, revocation checks, failure logging), the portal
    inherits the change instead of quietly running a stale copy.

    The fallback below is a byte-for-byte equivalent, used only when the
    module is imported standalone (tests, scripts, the nightly cron). It
    cannot be dropped: portal_backend must be importable without backend.py,
    or scripts/portal_scripts.py would drag the whole Flask app into a cron.

    Late binding, not a direct import, because backend.py imports THIS module
    at line ~66. A direct `from backend import require_auth` is a circular
    import and Python refuses to start.
    """
    @wraps(f)
    def inner(*a, **kw):
        if _AUTH_IMPL is not None:
            return _AUTH_IMPL(f)(*a, **kw)
        return _fallback_auth(f)(*a, **kw)
    return inner


def _fallback_auth(f):
    @wraps(f)
    def inner(*a, **kw):
        hdr = request.headers.get("Authorization", "")
        if not hdr.startswith("Bearer "):
            return jsonify({"error": "No authorization token provided"}), 401
        token = hdr.split("Bearer ", 1)[1].strip()
        if not token:
            return jsonify({"error": "Empty token", "code": "EMPTY_TOKEN"}), 401
        try:
            try:
                decoded = firebase_auth.verify_id_token(token, clock_skew_seconds=10)
            except TypeError:
                decoded = firebase_auth.verify_id_token(token)
            request.uid = decoded["uid"]
            request.user_email = decoded.get("email", "")
            return f(*a, **kw)
        except firebase_auth.ExpiredIdTokenError:
            return jsonify({"error": "Token expired.", "code": "TOKEN_EXPIRED"}), 401
        except firebase_auth.RevokedIdTokenError:
            return jsonify({"error": "Token revoked.", "code": "TOKEN_REVOKED"}), 401
        except firebase_auth.InvalidIdTokenError as e:
            return jsonify({"error": f"Invalid token: {e}"}), 401
    return inner


# The name we agreed on. `portal_auth` stays as the implementation so a
# reader of backend.py never wonders which decorator is which.
require_auth = portal_auth


def _user(uid):
    d = _db().collection("users").document(uid).get()
    return d.to_dict() if d.exists else None


def require_role(*roles):
    """Role is read from Firestore, never from the request body."""
    def deco(f):
        @wraps(f)
        def inner(*a, **kw):
            u = _user(request.uid) or {}
            role = u.get("role", "student")
            if role not in roles:
                return jsonify({
                    "error": "Not permitted for this account type.",
                    "code": "WRONG_ROLE",
                    "role": role,
                }), 403
            request.role = role
            request.user_doc = u
            return f(*a, **kw)
        return inner
    return deco


def resolve_child(f):
    """403 unless student_uid ∈ users/{parent_uid}.children[].

    This is the single line of defence for the whole parent portal. A forged
    student_uid in the URL dies here, and is logged.
    """
    @wraps(f)
    def inner(student_uid, *a, **kw):
        parent = getattr(request, "user_doc", None) or _user(request.uid) or {}
        children = parent.get("children", []) or []
        if student_uid not in children:
            print(f"[portal] SCOPE VIOLATION parent={request.uid} tried child={student_uid}")
            return jsonify({"error": "Not your child.", "code": "OUT_OF_SCOPE"}), 403

        child = _user(student_uid)
        if not child:
            return jsonify({"error": "Student not found."}), 404
        if child.get("parent_consent", True) is False:
            return jsonify({
                "error": "This student has turned off parent access.",
                "code": "CONSENT_REVOKED",
            }), 403

        request.child_uid = student_uid
        request.child_doc = child
        return f(student_uid, *a, **kw)
    return inner


# ═══════════════════════════════════════════════════════════════════════════
# CHAPTER METADATA CACHE
#
# chapter_metadata is small (a few hundred docs at most) and changes when
# you upload content, not when a student breathes. Cache it for 10 minutes
# so the rollup writer isn't re-reading it on every test submit.
# ═══════════════════════════════════════════════════════════════════════════

_meta_cache = {"at": 0.0, "data": None}
_META_TTL = 600  # seconds


def _active_phase_name(p):
    """Which OPD phase this chapter is sitting in, per opd_engine's order.

    Foundation -> Skill Building -> Mastery -> NEET Simulation -> Grand Mock
    -> Endurance. A teacher seeing "Foundation" after six weeks knows something
    a mastery percentage will never tell them.
    """
    ps = p.get("phase_state", {}) or {}
    order = ["Foundation", "Skill Building", "Mastery", "NEET Simulation",
             "Grand Mock", "Endurance"]
    for name in order:
        if ps.get(name, {}).get("status") != "complete":
            return name if ps.get(name) else ""
    return "Endurance" if ps else ""


def chapter_meta(force=False):
    now = datetime.now(timezone.utc).timestamp()
    if not force and _meta_cache["data"] is not None and now - _meta_cache["at"] < _META_TTL:
        return _meta_cache["data"]

    data = {}
    for doc in _db().collection("chapter_metadata").stream():
        m = doc.to_dict() or {}
        cid = m.get("chapter_id", doc.id)
        data[cid] = {
            "chapter_title": m.get("chapter_title", ""),
            "chapter_number": m.get("chapter_number", 0),
            "subject": m.get("subject", ""),
            "class": str(m.get("class", "")),
            "total_tests": int(m.get("total_tests", DEFAULT_TESTS_PER_CHAPTER) or DEFAULT_TESTS_PER_CHAPTER),
            "total_concepts": int(m.get("total_concepts", 0) or 0),
        }
    _meta_cache.update({"at": now, "data": data})
    return data


def _total_studio_chapters():
    total = 0
    for doc in _db().collection("revision_chapters").stream():
        d = doc.to_dict() or {}
        chs = d.get("chapters", [])
        total += len(chs) if chs else int(d.get("total_chapters", 0) or 0)
    return total


def _total_arena_papers():
    return sum(1 for _ in _db().collection("pyq_papers").stream())


# ═══════════════════════════════════════════════════════════════════════════
# THE ROLLUP WRITER
#
# One denormalised document per student, rebuilt on every meaningful event.
# The parent portal reads it for Home; the teacher portal will read ~50 of
# them for an entire class. Without it, one class dashboard is ~1,800 reads.
#
# ~4 collection queries per rebuild. At 1,200 students and a handful of
# submits per student per day, this is trivially cheap and needs no queue.
# ═══════════════════════════════════════════════════════════════════════════

def _academic_year():
    """India's academic year runs Jun→Mar. Override with NAADI_ACADEMIC_YEAR
    if your schools disagree — this is the one number that decides whether
    2026's 12-A and 2027's 12-A are the same cohort. They are not."""
    override = os.environ.get("NAADI_ACADEMIC_YEAR")
    if override:
        return int(override)
    today = _ist_today()
    return today.year if today.month >= 6 else today.year - 1


def class_key_for(user):
    school = (user.get("school_id") or "").strip()
    section = (user.get("class_id") or "").strip()
    if not school or not section:
        return ""
    return f"{_academic_year()}_{section}"


def rebuild_student_rollup(uid, meta=None):
    """Recompute student_rollups/{uid} from raw collections.

    Idempotent. Safe to call from anywhere. Returns the rollup dict, or
    None if the uid isn't a student.
    """
    user = _user(uid)
    if not user or user.get("role", "student") != "student":
        return None

    meta = meta or chapter_meta()

    # ── OPD / user_progress ────────────────────────────────────────────
    per_chapter = {}
    per_subject = {s: {"mastery_sum": 0.0, "chapters": 0, "seen": 0, "correct": 0,
                       "chapters_total": 0, "tests": 0} for s in SUBJECTS}
    all_concepts = []
    total_seen = total_correct = 0
    tests_completed = 0
    mastery_sum = 0.0
    started_chapters = 0
    pending_interventions = 0
    last_test_at = ""

    for doc in _db().collection("user_progress").where("user_id", "==", uid).stream():
        p = doc.to_dict() or {}
        cid = p.get("chapter_id", "")
        if cid not in meta:
            continue  # deleted chapter must not inflate anything
        subject = meta[cid]["subject"]

        cm = p.get("concept_mastery", {}) or {}
        ch_seen = ch_correct = 0
        for concept_id, c in cm.items():
            seen = len(c.get("questions_seen", []) or [])
            corr = len(c.get("questions_correct", []) or [])
            ch_seen += seen
            ch_correct += corr
            all_concepts.append({
                "concept_id": concept_id,
                "concept_name": c.get("concept_name", concept_id),
                "chapter_id": cid,
                "chapter_name": p.get("chapter_name", "") or meta[cid]["chapter_title"],
                "subject": subject,
                "mastery": round(float(c.get("mastery_score", 0) or 0), 1),
                "status": c.get("status", "not_started"),
                "seen": seen,
                "consecutive_failures": int(c.get("consecutive_concept_failures", 0) or 0),
            })

        total_seen += ch_seen
        total_correct += ch_correct

        done = int(p.get("tests_completed", 0) or 0)
        cap = meta[cid]["total_tests"]
        tests_completed += min(done, cap)

        ch_mastery = float(p.get("overall_mastery", 0) or 0)
        history = p.get("test_history", []) or []
        last_pct = history[-1].get("percentage", 0) if history else None

        lt = _iso(p.get("last_test_date"))
        if lt > last_test_at:
            last_test_at = lt

        if done > 0 or ch_seen > 0:
            started_chapters += 1
            mastery_sum += ch_mastery

        pending_interventions += len(p.get("pending_interventions", []) or [])

        # COVERAGE vs ACCURACY — these were fused, and the fusion was the
        # single biggest defect in the teacher portal.
        #
        # user_progress.overall_mastery averages every concept in the chapter
        # with UNTOUCHED ones counted as zero, so a student halfway through a
        # chapter at 90% accuracy scores ~45%. Read as "weak" that is simply
        # wrong; it mostly means "not finished yet". Both quantities are now
        # published separately. `mastery` stays only for backwards compat.
        cm_all = p.get("concept_mastery", {}) or {}
        concepts_total = len(cm_all) or meta[cid].get("total_concepts", 0)
        concepts_attempted = sum(
            1 for c in cm_all.values() if len(c.get("questions_seen", []) or []) > 0)
        coverage_pct = (round(concepts_attempted / concepts_total * 100, 1)
                        if concepts_total else 0.0)

        per_chapter[cid] = {
            "chapter_name": p.get("chapter_name", "") or meta[cid]["chapter_title"],
            "subject": subject,
            "class": meta[cid]["class"],
            "mastery": round(ch_mastery, 1),
            "coverage_pct": coverage_pct,
            "concepts_attempted": concepts_attempted,
            "concepts_total": concepts_total,
            "phase": _active_phase_name(p),
            "difficulty": p.get("current_difficulty", ""),
            "tests": done,
            "total_tests": cap,
            "last_test_pct": last_pct,
            "accuracy": _pct(ch_correct, ch_seen),
            "complete": bool(p.get("chapter_fully_complete", False)),
            "status": ("complete" if p.get("chapter_fully_complete")
                       else "in_progress" if done > 0
                       else "opened"),
        }

        if subject in per_subject:
            ps = per_subject[subject]
            ps["mastery_sum"] += ch_mastery
            ps["chapters"] += 1 if (done > 0 or ch_seen > 0) else 0
            ps["seen"] += ch_seen
            ps["correct"] += ch_correct
            ps["tests"] += done

    for cid, m in meta.items():
        if m["subject"] in per_subject:
            per_subject[m["subject"]]["chapters_total"] += 1

    subjects_out = {}
    for s, v in per_subject.items():
        subjects_out[s] = {
            "mastery": round(v["mastery_sum"] / v["chapters"], 1) if v["chapters"] else 0,
            "accuracy": _pct(v["correct"], v["seen"]),
            "chapters_done": v["chapters"],
            "chapters_total": v["chapters_total"],
            "tests": v["tests"],
            "questions": v["seen"],
        }

    # ── Concept Studio / revision_progress ─────────────────────────────
    studio_sum = 0.0
    studio_started = 0
    fc_seen = fc_correct = 0
    last_studio_at = ""
    for doc in _db().collection("users").document(uid).collection("revision_progress").stream():
        d = doc.to_dict() or {}
        studio_sum += float(d.get("completion_percentage", 0) or 0)
        studio_started += 1
        for _, r in (d.get("flashcard_results", {}) or {}).items():
            fc_seen += int(r.get("seen", 0) or 0)
            fc_correct += int(r.get("correct", 0) or 0)
        la = _iso(d.get("last_active"))
        if la > last_studio_at:
            last_studio_at = la

    studio_total = _total_studio_chapters()
    studio_pct = round(studio_sum / studio_total, 1) if studio_total else 0.0

    # ── Arena / pyq_sessions ───────────────────────────────────────────
    arena_papers = set()
    best_air = None
    last_arena_score = None
    last_arena_at = ""
    arena_attempts = 0
    for doc in _db().collection("pyq_sessions") \
            .where("user_id", "==", uid) \
            .where("status", "==", "completed").stream():
        s = doc.to_dict() or {}
        sd = s.get("score_data", {}) or {}
        at = _iso(sd.get("completed_at")) or _iso(s.get("completed_at"))
        if at > last_arena_at:
            last_arena_at = at
            last_arena_score = sd.get("total_marks")
        if s.get("arena_session") and s.get("test_type") == "full_paper":
            arena_papers.add((s.get("year"), str(s.get("paper_code"))))
            arena_attempts += 1
            air = _air_number(sd.get("air_prediction"))
            if air and (best_air is None or air < best_air):
                best_air = air

    arena_total = _total_arena_papers()
    arena_pct = round(len(arena_papers) / arena_total * 100, 1) if arena_total else 0.0

    # ── OPD completion percentage ──────────────────────────────────────
    opd_total = sum(m["total_tests"] for m in meta.values())
    opd_pct = round(tests_completed / opd_total * 100, 1) if opd_total else 0.0

    # ── Doctor scale — weights redistributed across sections that exist ─
    live = {"studio": studio_total > 0, "opd": opd_total > 0, "arena": arena_total > 0}
    live_weight = sum(w for k, w in SCALE_WEIGHTS.items() if live[k])
    overall = 0.0
    if live_weight:
        vals = {"studio": studio_pct, "opd": opd_pct, "arena": arena_pct}
        for k, w in SCALE_WEIGHTS.items():
            if live[k]:
                overall += vals[k] * (w / live_weight)
    overall = round(overall, 1)
    rank = DOCTOR_LADDER[max(_rank_for(overall), int(user.get("best_rank_index", 0) or 0))]

    # ── Streak + activity ──────────────────────────────────────────────
    st = user.get("streak", {}) or {}
    streak_current = int(st.get("current", 0) or 0)
    today = _ist_today()
    if st.get("last_date") not in (today.isoformat(), (today - timedelta(days=1)).isoformat()):
        streak_current = 0

    last_active_at = max(last_test_at, last_studio_at, last_arena_at,
                         st.get("last_date", "") or "")

    # ── Rounds (never decreases; retakes count as effort) ──────────────
    rounds = 0
    for coll in ("test_sessions", "pyq_sessions"):
        try:
            rounds += sum(1 for _ in _db().collection(coll)
                          .where("user_id", "==", uid)
                          .where("status", "==", "completed").stream())
        except Exception as e:
            print(f"[portal] rounds count failed on {coll}: {e}")

    # ── Concept ranking ────────────────────────────────────────────────
    attempted = [c for c in all_concepts if c["seen"] > 0]
    weak = sorted(attempted, key=lambda c: c["mastery"])[:10]
    strong = sorted(attempted, key=lambda c: -c["mastery"])[:10]

    # ── Flat concept map, for the teacher's class-wide views ───────────
    # Keys are terse on purpose: at ~300 concepts this is ~20KB, well under
    # the 1MB doc ceiling, and it means a 54-student concept heatmap costs
    # 54 reads instead of 54 × every user_progress doc.
    per_concept = {
        c["concept_id"]: {
            "n": c["concept_name"],
            "m": c["mastery"],
            "c": c["chapter_id"],
            "s": c["seen"],
            "f": c["consecutive_failures"],
        }
        for c in attempted
    }

    # ── Most-failed bases + RETENTION, from one pass over the ladder ───
    #
    # opd_engine grades every base through v1 -> v2 -> v3:
    #   v1 wrong    -> a v2 is owed, and fires on the next test
    #   v2 correct  -> "recovered", and books a v3 AUDIT three tests later
    #   v3 correct  -> confirmed: it actually stuck
    #   v3 wrong    -> FALSE RECOVERY: they had memorised v1's answer
    #
    # That last case is the whole point. v2 reuses v1's options AND its key,
    # minutes after the student read the explanation, so passing it can be
    # recall rather than learning. v3 is differently trapped, so it cannot be
    # passed from memory of v1. No coaching test series can separate those two
    # states, and the number was sitting unused in Firestore.
    failed_bases = []
    audits_confirmed = audits_failed = 0
    v1_wrong = v2_recovered = 0
    false_recoveries = []
    try:
        for doc in _db().collection("base_question_tracking") \
                .where("user_id", "==", uid).stream():
            b = doc.to_dict() or {}
            tf = int(b.get("total_failures", 0) or 0)
            hist = b.get("variation_history", []) or []

            if tf > 0:
                # question_text rides on every history entry, so the teacher's
                # most-failed list never has to resolve a question id.
                qtext = ""
                for h in reversed(hist):
                    if h.get("question_text"):
                        qtext = h["question_text"][:300]
                        break
                failed_bases.append({
                    "base_question_id": b.get("base_question_id", ""),
                    "chapter_id": b.get("chapter_id", ""),
                    "concept_id": b.get("concept_id", ""),
                    "failures": tf,
                    "question_text": qtext,
                })

            saw_v1_wrong = saw_v2_right = False
            for h in hist:
                var = (h.get("variation") or "").lower()
                ok = h.get("result") == "correct"
                # A retake serves the same session back minutes later, so its
                # v3 measures exactly the short-term recall the audit exists to
                # see past. opd_engine refuses to re-grade it; so do we.
                if h.get("is_retake"):
                    continue
                if var == "v1" and not ok:
                    saw_v1_wrong = True
                elif var == "v2" and ok:
                    saw_v2_right = True
                elif var == "v3":
                    if ok:
                        audits_confirmed += 1
                    else:
                        audits_failed += 1
                        false_recoveries.append({
                            "base_question_id": b.get("base_question_id", ""),
                            "chapter_id": b.get("chapter_id", ""),
                            "concept_id": b.get("concept_id", ""),
                            "question_text": (h.get("question_text") or "")[:300],
                        })
            if saw_v1_wrong:
                v1_wrong += 1
                if saw_v2_right:
                    v2_recovered += 1
    except Exception as e:
        print(f"[portal] base tracking read failed for {uid}: {e}")

    failed_bases = sorted(failed_bases, key=lambda b: -b["failures"])[:8]
    failed_retake_count = sum(1 for b in failed_bases if b["failures"] >= 2)

    audits_total = audits_confirmed + audits_failed
    retention = {
        "audits_total": audits_total,
        "audits_confirmed": audits_confirmed,
        "audits_failed": audits_failed,
        # None, never 0. An unaudited student has no retention score, and
        # rendering "0%" would libel them.
        "retention_pct": (round(audits_confirmed / audits_total * 100, 1)
                          if audits_total else None),
        "v1_wrong": v1_wrong,
        "v2_recovered": v2_recovered,
        "recovery_pct": (round(v2_recovered / v1_wrong * 100, 1)
                         if v1_wrong else None),
        "false_recoveries": false_recoveries[:8],
        "false_recovery_count": len(false_recoveries),
    }

    accuracy = _pct(total_correct, total_seen)
    overall_mastery = round(mastery_sum / started_chapters, 1) if started_chapters else 0.0

    # Computed once and used twice: the flag engine reads it, and it is
    # stored on the rollup for the teacher portal.
    _signals = build_signals(uid, meta, per_chapter)

    # ── Alerts ─────────────────────────────────────────────────────────
    # ONE flag engine, teacher_signals.flags_for, for the whole product.
    #
    # There used to be two. Home ran flags_for and spoke English; the
    # rollup ran _alert_flags and wrote "Mastery 34% - below 40%" -- the
    # banned word, on the blended metric that was deleted, with no sample
    # gate. The Students tab and the parent portal both read that second
    # string, so the same child was described two different ways on two
    # screens and one of the descriptions used vocabulary no teacher has.
    #
    # class_pace_median is deliberately absent here: it needs the whole
    # class and this function rebuilds ONE student. The rushing rule
    # therefore does not fire at rollup-write time, only in the teacher
    # portal, which computes the class median properly. Flags stored on
    # the rollup are a documented SUBSET, never a contradiction.
    _flag_input = {
        "tests_completed": tests_completed,
        "_days_since_active": _days_since(last_active_at),
        "retention": retention,
        "failed_retake_count": failed_retake_count,
        "streak_longest": int(st.get("longest", 0) or 0),
        "streak_current": streak_current,
        "signals": _signals,
    }
    _fl = flags_for(_flag_input, {"meta": meta or {}, "class_pace_median": None})
    flags = [f["kind"] for f in _fl]
    reason = _fl[0]["text"] if _fl else ""

    prev = _db().collection("student_rollups").document(uid).get()
    prev_d = prev.to_dict() if prev.exists else {}

    rollup = {
        "uid": uid,
        "name": user.get("name", "Student"),
        "initials": _initials(user.get("name")),
        "photo_url": user.get("photo_url", ""),
        "email": user.get("email", ""),
        "class_level": user.get("class_level", ""),
        "school_id": user.get("school_id", ""),
        "class_id": user.get("class_id", ""),
        # The school's own roll number, set by the student in Profile.
        # The teacher's printed class report sorts on it.
        "roll_no": user.get("roll_no", ""),
        "class_key": class_key_for(user),
        "class_status": user.get("class_status", "unassigned"),
        "guardian_name": user.get("guardian_name", ""),
        "guardian_phone": user.get("guardian_phone", ""),
        "guardian_email": user.get("guardian_email", ""),
        "target_exam": user.get("target_exam", ""),
        "signals": _signals,
        "neet_target_score": user.get("neet_target_score"),
        "neet_target_year": user.get("neet_target_year"),

        "last_active_at": last_active_at,
        "streak_current": streak_current,
        "streak_longest": int(st.get("longest", 0) or 0),

        "doctor_overall": overall,
        "doctor_rank": rank["title"],
        "doctor_rank_key": rank["key"],
        "studio_pct": studio_pct,
        "opd_pct": opd_pct,
        "arena_pct": arena_pct,

        "overall_mastery": overall_mastery,
        "accuracy": accuracy,
        "questions_seen": total_seen,
        "questions_correct": total_correct,
        "tests_completed": tests_completed,
        "rounds_completed": rounds,
        "chapters_started": started_chapters,

        "flashcards_seen": fc_seen,
        "flashcards_correct": fc_correct,
        "studio_chapters_started": studio_started,
        "studio_chapters_total": studio_total,

        "per_subject": subjects_out,
        "per_chapter": per_chapter,
        "per_concept": per_concept,
        "weak_concepts": weak,
        "strong_concepts": strong,
        "failed_bases": failed_bases,
        "retention": retention,
        "failed_retake_count": failed_retake_count,

        # Cheap enough to store, and it saves the teacher's class view from
        # reading 50 study_days subcollections just to draw one number.
        "active_today": _days_since(last_active_at) == 0,

        "pending_interventions_count": pending_interventions,
        "best_air_prediction": best_air,
        "last_arena_score": last_arena_score,
        "arena_papers_attempted": len(arena_papers),
        "arena_papers_total": arena_total,
        "arena_attempts": arena_attempts,

        # Trend baselines are owned by the nightly job. An event-driven
        # writer must never clobber them — it has no idea what "7 days ago"
        # looked like, and would silently reset every trend arrow to zero.
        "mastery_7d_ago": prev_d.get("mastery_7d_ago"),
        "mastery_30d_ago": prev_d.get("mastery_30d_ago"),
        # The roster's week-over-week arrow. It has to ride on ACCURACY,
        # not on overall_mastery: the old arrow was a mastery delta drawn
        # inside the accuracy column, so it read as something it was not.
        "accuracy_7d_ago": prev_d.get("accuracy_7d_ago"),

        "alert_flags": flags,
        "alert_reason": reason,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }

    _db().collection("student_rollups").document(uid).set(rollup, merge=True)
    return rollup


# _alert_flags() lived here. It was the SECOND flag engine: it produced
# "Mastery 34% - below 40%" and "Inactive 7 days" from the blended metric
# that no longer exists, with no sample gate, and the Students tab and the
# parent portal both rendered its output verbatim. teacher_signals.flags_for
# is now the only source of a flag anywhere in the product. Deleted rather
# than deprecated so it cannot come back through a copy-paste.


def _air_number(air):
    """A predicted rank as a single comparable integer, or None.

    Production stores air_prediction as a dict {air_low, air_high, air_mid,
    percentile_approx}; air_mid is the point estimate. Older or simpler
    records may store a bare number. Accept both, reject anything else — a
    dict slipped into a '<' comparison is what took the whole dashboard
    down with a 500.
    """
    if air is None:
        return None
    if isinstance(air, dict):
        air = air.get("air_mid")
    if isinstance(air, bool):        # bool is an int subclass; not a rank
        return None
    return air if isinstance(air, (int, float)) else None


def _days_since(iso_str):
    if not iso_str:
        return None
    try:
        s = iso_str.replace("Z", "+00:00")
        if len(s) == 10:  # bare YYYY-MM-DD (the streak's last_date)
            dt = datetime.fromisoformat(s).replace(tzinfo=IST_TZ)
        else:
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        return max(0, (datetime.now(timezone.utc) - dt).days)
    except Exception:
        return None


# The fields student_rollups mirrors verbatim off users/{uid}. Kept next
# to mirror_identity so the two cannot drift; if a field is added to the
# rollup literal above, it belongs here too.
MIRRORED_IDENTITY = (
    "name", "photo_url", "email", "class_level", "school_id", "class_id",
    "roll_no", "class_status", "guardian_name", "guardian_phone",
    "guardian_email", "target_exam", "neet_target_score", "neet_target_year",
)


def mirror_identity(uid, changed):
    """Push identity edits straight onto the rollup.

    The teacher portal reads student_rollups, never users. Before this
    existed, a student who fixed a misspelled name or a wrong guardian
    number kept showing the old value to their teacher until they
    happened to sit a test and trigger a rebuild -- which for a quiet
    student could be weeks.

    A full rebuild_student_rollup() would be correct and far too
    expensive: it re-reads test_sessions, pyq_sessions and
    revision_progress to recompute numbers that a name change cannot
    have affected. This is ONE merge write of the fields that actually
    changed, and nothing else on the document is touched.

    `changed` is the dict save_account already assembled, so an edit to
    a field the rollup does not mirror costs nothing at all.

    Never raises. A profile save must not fail because a rollup does not
    exist yet -- a student who has not started has no rollup, and that
    is the normal state, not an error.
    """
    patch = {k: v for k, v in (changed or {}).items() if k in MIRRORED_IDENTITY}
    if not patch:
        return False

    # `initials` is DERIVED from name, not copied, so a name change alone
    # would leave the roster avatar showing the old letters. Recomputed
    # with the same function the rollup builder uses, so the two can
    # never disagree.
    if "name" in patch:
        patch["initials"] = _initials(patch["name"])
    try:
        ref = _db().collection("student_rollups").document(uid)
        if not ref.get().exists:
            return False        # no rollup yet; the first build will pick it up
        ref.set(patch, merge=True)
        return True
    except Exception as e:
        print(f"[portal] identity mirror failed for {uid}: {type(e).__name__}: {e}")
        return False


def safe_rebuild(uid):
    """The hook backend.py calls. Never raises, never blocks the student."""
    try:
        rebuild_student_rollup(uid)
    except Exception as e:
        print(f"[portal] rollup rebuild failed for {uid}: {type(e).__name__}: {e}")


def record_study_day(uid, source="unknown"):
    """Writes users/{uid}/study_days/{YYYY-MM-DD}. Called from ping_streak.

    users.streak only stores current/longest/last_date — enough for a
    counter, useless for a 12-week heatmap. This is the missing row.
    """
    try:
        day = _ist_today().isoformat()
        _db().collection("users").document(uid) \
            .collection("study_days").document(day) \
            .set({"date": day,
                  "sources": firestore.ArrayUnion([source]),
                  "at": firestore.SERVER_TIMESTAMP}, merge=True)
    except Exception as e:
        print(f"[portal] study_day write failed for {uid}: {e}")


# ═══════════════════════════════════════════════════════════════════════════
# INVITE + CLAIM
#
# We never email a password. The invite carries a single-use token; the
# parent sets their own password on claim.html. One email = one role.
# ═══════════════════════════════════════════════════════════════════════════

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _invite_email_html(student_name, claim_url):
    return f"""
<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#0f172a;
            padding:32px 20px;color:#e2e8f0;">
  <div style="max-width:520px;margin:0 auto;background:#1e293b;border-radius:16px;
              padding:32px;border:1px solid #334155;">
    <h1 style="font-size:20px;margin:0 0 4px;color:#fff;">NAADI AI</h1>
    <p style="color:#94a3b8;margin:0 0 24px;font-size:14px;">NEET preparation</p>
    <h2 style="font-size:22px;color:#fff;margin:0 0 12px;">
      Track {student_name}'s NEET preparation
    </h2>
    <p style="line-height:1.6;color:#cbd5e1;">
      {student_name} has invited you to the NAADI AI parent portal. You'll be able to
      see chapters studied, tests taken, concept strengths and weaknesses, and
      NEET readiness — all in one place.
    </p>
    <p style="line-height:1.6;color:#cbd5e1;">
      Set your password to get started. This link works once and expires in
      {INVITE_TTL_DAYS} days.
    </p>
    <a href="{claim_url}"
       style="display:inline-block;background:#10b981;color:#04241a;text-decoration:none;
              font-weight:700;padding:14px 28px;border-radius:10px;margin:20px 0;">
      Set your password
    </a>
    <p style="color:#64748b;font-size:12px;line-height:1.6;margin-top:24px;">
      Then open the NAADI AI app and sign in with this email address.<br>
      If you weren't expecting this, ignore it — no account is created until
      you set a password.
    </p>
  </div>
</div>"""


@portal_bp.route("/api/student/parent/invite", methods=["POST"])
@require_auth
def student_send_invite():
    """Student invites a parent. Called from the student's Profile screen.

    Rate-limited to one invite per email per hour. Re-inviting an already
    linked parent is a no-op, not an error.
    """
    uid = request.uid
    user = _user(uid) or {}
    if user.get("role", "student") != "student":
        return jsonify({"error": "Only students can invite a parent."}), 403

    email = (request.json or {}).get("email", "").strip().lower() \
        or (user.get("guardian_email") or "").strip().lower()

    if not EMAIL_RE.match(email):
        return jsonify({"error": "Enter a valid email address."}), 400
    if email == (user.get("email") or "").lower():
        return jsonify({"error": "That's your own email address."}), 400

    # Already linked?
    existing = list(_db().collection("users")
                    .where("role", "==", "parent")
                    .where("email", "==", email).limit(1).stream())
    if existing and uid in (existing[0].to_dict().get("children", []) or []):
        return jsonify({"status": "already_linked", "email": email})

    # Cooldown
    now = datetime.now(timezone.utc)
    recent = _db().collection("parent_invites") \
        .where("student_uid", "==", uid) \
        .where("guardian_email", "==", email) \
        .where("claimed", "==", False).stream()
    for d in recent:
        r = d.to_dict()
        created = r.get("created_at")
        if hasattr(created, "timestamp"):
            age_min = (now.timestamp() - created.timestamp()) / 60
            if age_min < INVITE_RESEND_COOLDOWN_MIN:
                return jsonify({
                    "error": f"An invite was just sent. Try again in "
                             f"{int(INVITE_RESEND_COOLDOWN_MIN - age_min)} minutes.",
                    "code": "COOLDOWN",
                }), 429
        # Supersede the old token
        d.reference.update({"claimed": True, "superseded": True})

    token = secrets.token_urlsafe(24)
    _db().collection("parent_invites").document(token).set({
        "token": token,
        "student_uid": uid,
        "student_name": user.get("name", "your child"),
        "guardian_email": email,
        "claimed": False,
        "created_at": firestore.SERVER_TIMESTAMP,
        "expires_at": now + timedelta(days=INVITE_TTL_DAYS),
    })

    claim_url = f"{WEB_BASE.rstrip('/')}/claim.html?token={token}"
    sent = _send_email(email, f"Track {user.get('name', 'your child')}'s NEET prep on NAADI AI",
                       _invite_email_html(user.get("name", "your child"), claim_url))

    # Keep guardian_email on the student doc in step with what was invited.
    _db().collection("users").document(uid).set(
        {"guardian_email": email, "updated_at": firestore.SERVER_TIMESTAMP}, merge=True)

    return jsonify({"status": "sent", "email": email, "email_queued": sent})


@portal_bp.route("/api/parent/invite/<token>", methods=["GET"])
def invite_lookup(token):
    """PUBLIC — no auth. claim.html calls this to render the child's name."""
    doc = _db().collection("parent_invites").document(token).get()
    if not doc.exists:
        return jsonify({"error": "This invite link is not valid.", "code": "BAD_TOKEN"}), 404

    inv = doc.to_dict()
    if inv.get("claimed"):
        return jsonify({"error": "This invite has already been used.", "code": "CLAIMED"}), 410

    exp = inv.get("expires_at")
    if hasattr(exp, "timestamp") and exp.timestamp() < datetime.now(timezone.utc).timestamp():
        return jsonify({"error": "This invite has expired. Ask your child to resend it.",
                        "code": "EXPIRED"}), 410

    return jsonify({
        "student_name": inv.get("student_name", "your child"),
        "guardian_email": inv.get("guardian_email", ""),
    })


def _new_parent_doc(uid, email, name, student_uid):
    return {
        "uid": uid,
        "email": email,
        "name": name,
        "role": "parent",
        "children": [student_uid],
        "notify_weekly_digest": True,
        "notify_alerts": True,
        "created_at": firestore.SERVER_TIMESTAMP,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }


@portal_bp.route("/api/parent/claim", methods=["POST"])
def parent_claim():
    """PUBLIC — no auth. Creates or extends the parent account.

    One email = one role. A student or teacher address cannot become a
    parent; that collision is silent data loss waiting to happen.
    """
    data = request.json or {}
    token = (data.get("token") or "").strip()
    password = data.get("password") or ""

    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters."}), 400

    ref = _db().collection("parent_invites").document(token)
    doc = ref.get()
    if not doc.exists:
        return jsonify({"error": "This invite link is not valid."}), 404

    inv = doc.to_dict()
    if inv.get("claimed"):
        return jsonify({"error": "This invite has already been used."}), 410

    exp = inv.get("expires_at")
    if hasattr(exp, "timestamp") and exp.timestamp() < datetime.now(timezone.utc).timestamp():
        return jsonify({"error": "This invite has expired."}), 410

    email = inv["guardian_email"]
    student_uid = inv["student_uid"]

    # Does a Firebase Auth account already exist for this email?
    try:
        fb_user = firebase_auth.get_user_by_email(email)
    except firebase_auth.UserNotFoundError:
        fb_user = None

    # Belt and braces: a users/{uid} doc can exist for an email whose Auth
    # record was deleted, or that was created by the BD script and hasn't
    # signed in yet. Creating a fresh parent uid on top of that would orphan
    # the original document and silently give a teacher two identities.
    doc_role, doc_uid = None, None
    for d in _db().collection("users").where("email", "==", email).limit(1).stream():
        doc_role = (d.to_dict() or {}).get("role", "student")
        doc_uid = d.id

    if doc_role and doc_role != "parent":
        return jsonify({
            "error": f"This email is already registered as a {doc_role} account. "
                     f"Please use a different email address for the parent portal.",
            "code": "ROLE_CONFLICT",
        }), 409

    student = _user(student_uid) or {}
    display = student.get("guardian_name") or "Parent"

    if fb_user and doc_role == "parent":
        # Existing parent → just add this child. The password is NOT changed:
        # they already have one, and this invite is about the child, not the
        # account.
        parent_uid = fb_user.uid
        _db().collection("users").document(parent_uid).set({
            "children": firestore.ArrayUnion([student_uid]),
            "updated_at": firestore.SERVER_TIMESTAMP,
        }, merge=True)
        created = False

    elif fb_user:
        # Auth record exists, no Firestore doc (orphan, or a first-time
        # claim after a partial failure). Holding the invite token proves
        # control of the mailbox — the same guarantee a password-reset link
        # gives — so setting the password here is safe.
        parent_uid = fb_user.uid
        try:
            firebase_auth.update_user(parent_uid, password=password)
        except Exception as e:
            print(f"[portal] could not set password for orphaned auth user: {e}")
        _db().collection("users").document(parent_uid).set(
            _new_parent_doc(parent_uid, email, display, student_uid))
        created = True

    else:
        fb_user = firebase_auth.create_user(
            email=email, password=password, display_name=display)
        parent_uid = fb_user.uid
        _db().collection("users").document(parent_uid).set(
            _new_parent_doc(parent_uid, email, display, student_uid))
        created = True

    ref.update({"claimed": True, "claimed_at": firestore.SERVER_TIMESTAMP,
                "parent_uid": parent_uid})

    # Make sure the child has a rollup ready before the parent first opens it.
    safe_rebuild(student_uid)

    return jsonify({
        "status": "ok",
        "email": email,
        "created": created,
        "message": ("Account created. Open the NAADI AI app and sign in."
                    if created else
                    "This child has been added to your existing parent account."),
    })


# ═══════════════════════════════════════════════════════════════════════════
# STUDENT-SIDE LINK MANAGEMENT (consent + unlink)
# ═══════════════════════════════════════════════════════════════════════════

@portal_bp.route("/api/student/parent/links", methods=["GET"])
@require_auth
def student_parent_links():
    uid = request.uid
    parents = []
    for doc in _db().collection("users").where("role", "==", "parent") \
            .where("children", "array_contains", uid).stream():
        p = doc.to_dict()
        parents.append({"uid": doc.id, "name": p.get("name", "Parent"),
                        "email": p.get("email", "")})

    pending = []
    for doc in _db().collection("parent_invites") \
            .where("student_uid", "==", uid) \
            .where("claimed", "==", False).stream():
        i = doc.to_dict()
        pending.append({"email": i.get("guardian_email", ""),
                        "sent_at": _iso(i.get("created_at"))})

    user = _user(uid) or {}
    return jsonify({
        "parents": parents,
        "pending_invites": pending,
        "parent_consent": user.get("parent_consent", True),
    })


@portal_bp.route("/api/student/parent/consent", methods=["POST"])
@require_auth
def student_parent_consent():
    allow = bool((request.json or {}).get("allow", True))
    _db().collection("users").document(request.uid).set(
        {"parent_consent": allow, "updated_at": firestore.SERVER_TIMESTAMP}, merge=True)
    return jsonify({"status": "ok", "parent_consent": allow})


@portal_bp.route("/api/student/parent/unlink", methods=["POST"])
@require_auth
def student_parent_unlink():
    parent_uid = (request.json or {}).get("parent_uid", "")
    if not parent_uid:
        return jsonify({"error": "parent_uid required"}), 400
    _db().collection("users").document(parent_uid).set({
        "children": firestore.ArrayRemove([request.uid]),
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)
    return jsonify({"status": "ok"})


# ═══════════════════════════════════════════════════════════════════════════
# PARENT ROUTES
#
# Every one is @portal_auth → @require_role("parent") → @resolve_child.
# Order matters: auth first, then role, then scope.
# ═══════════════════════════════════════════════════════════════════════════

def _rollup(uid):
    d = _db().collection("student_rollups").document(uid).get()
    if d.exists:
        return _clean(d.to_dict())
    # First open after signup, or a student who predates the backfill.
    r = rebuild_student_rollup(uid)
    return _clean(r) if r else {}


@portal_bp.route("/api/portal/whoami", methods=["GET"])
@require_auth
def whoami():
    """Called by login.html immediately after sign-in to pick a destination.

    Never 404s. A student who signed up but hasn't finished onboarding has
    no users doc yet — that is still a student, and must land in app.html.
    """
    u = _user(request.uid) or {}
    role = u.get("role", "student")
    return jsonify({
        "uid": request.uid,
        "role": role,
        "name": u.get("name", ""),
        "destination": "portal.html" if role in ("parent", "teacher") else "app.html",
    })


@portal_bp.route("/api/parent/me", methods=["GET"])
@require_auth
@require_role("parent")
def parent_me():
    u = request.user_doc
    return jsonify({
        "uid": request.uid,
        "name": u.get("name", "Parent"),
        "email": request.user_email,
        "children_count": len(u.get("children", []) or []),
        "notify_weekly_digest": u.get("notify_weekly_digest", True),
        "notify_alerts": u.get("notify_alerts", True),
    })


@portal_bp.route("/api/parent/children", methods=["GET"])
@require_auth
@require_role("parent")
def parent_children():
    """The swipeable deck. One card per child.

    Cost: 1 rollup read per child. A parent has 1–3 children.
    """
    children = request.user_doc.get("children", []) or []
    cards = []
    for cuid in children:
        child = _user(cuid)
        if not child:
            continue
        if child.get("parent_consent", True) is False:
            cards.append({
                "uid": cuid,
                "name": child.get("name", "Student"),
                "initials": _initials(child.get("name")),
                "consent_revoked": True,
            })
            continue

        r = _rollup(cuid)
        if not r:
            continue

        cards.append({
            "uid": cuid,
            "name": r.get("name", "Student"),
            "initials": r.get("initials", "?"),
            "photo_url": r.get("photo_url", ""),
            "school_id": r.get("school_id", ""),
            "class_id": r.get("class_id", ""),
            "class_level": r.get("class_level", ""),
            # ── the progress bar
            "doctor_overall": r.get("doctor_overall", 0),
            "doctor_rank": r.get("doctor_rank", "Intern"),
            # ── "most important details", exactly three lines
            "last_active_at": r.get("last_active_at", ""),
            "last_active_days": _days_since(r.get("last_active_at", "")),
            "streak_current": r.get("streak_current", 0),
            "accuracy_week": _week_accuracy(cuid),
            # ── the sibling red dot
            "has_alert": bool(r.get("alert_flags")),
            "alert_reason": r.get("alert_reason", ""),
        })

    return jsonify({"children": cards, "total": len(cards)})


def _week_accuracy(uid):
    """Accuracy across tests submitted in the last 7 days. None if no tests
    — an empty week must read as '—', never as 0%."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=7)
    correct = total = 0
    try:
        for doc in _db().collection("test_sessions") \
                .where("user_id", "==", uid) \
                .where("status", "==", "completed").stream():
            s = doc.to_dict() or {}
            at = s.get("completed_at")
            if not (hasattr(at, "timestamp") and at.timestamp() >= cutoff.timestamp()):
                continue
            for q in s.get("questions", []) or []:
                total += 1
                if q.get("is_correct"):
                    correct += 1
    except Exception as e:
        print(f"[portal] week accuracy failed for {uid}: {e}")
    return _pct(correct, total) if total else None


# ── SCREEN 1 · HOME ────────────────────────────────────────────────────────

@portal_bp.route("/api/parent/child/<student_uid>/home", methods=["GET"])
@require_auth
@require_role("parent")
@resolve_child
def parent_home(student_uid):
    """Cost: 1 rollup + ~84 study_day docs + a 7-day session scan."""
    r = _rollup(student_uid)

    idx = _rank_for(r.get("doctor_overall", 0))
    nxt = DOCTOR_LADDER[idx + 1] if idx + 1 < len(DOCTOR_LADDER) else None

    return jsonify({
        "child": {
            "uid": student_uid,
            "name": r.get("name"),
            "initials": r.get("initials"),
            "photo_url": r.get("photo_url", ""),
            "class_level": r.get("class_level", ""),
            "school_id": r.get("school_id", ""),
            "class_id": r.get("class_id", ""),
        },
        "doctor_scale": {
            "overall": r.get("doctor_overall", 0),
            "rank": r.get("doctor_rank", "Intern"),
            "next_rank": nxt["title"] if nxt else None,
            "to_next": round(nxt["at"] - r.get("doctor_overall", 0), 1) if nxt else 0,
            "components": {
                "studio": r.get("studio_pct", 0),
                "opd": r.get("opd_pct", 0),
                "arena": r.get("arena_pct", 0),
            },
            "ladder": [d["title"] for d in DOCTOR_LADDER],
        },
        "streak": {
            "current": r.get("streak_current", 0),
            "longest": r.get("streak_longest", 0),
            "days": _study_day_grid(student_uid, weeks=12),
        },
        "week": _weekly_digest(student_uid),
        "vitals": {
            "tests_completed": r.get("tests_completed", 0),
            "rounds_completed": r.get("rounds_completed", 0),
            "questions_seen": r.get("questions_seen", 0),
            "accuracy": r.get("accuracy", 0),
            "overall_mastery": r.get("overall_mastery", 0),
            "last_active_at": r.get("last_active_at", ""),
            "last_active_days": _days_since(r.get("last_active_at", "")),
        },
        "alerts": _parent_alerts(r),
        "activity": _recent_activity(student_uid, limit=5),
    })


def _study_day_grid(uid, weeks=12):
    """The last N weeks of study days, oldest first. One doc read per active
    day — a maximally diligent student produces 84 reads, twice a week."""
    start = _ist_today() - timedelta(weeks=weeks)
    days = {}
    try:
        for doc in _db().collection("users").document(uid) \
                .collection("study_days").stream():
            d = doc.id
            if d >= start.isoformat():
                days[d] = doc.to_dict().get("sources", [])
    except Exception as e:
        print(f"[portal] study_days read failed: {e}")

    out = []
    cur = start
    today = _ist_today()
    while cur <= today:
        k = cur.isoformat()
        out.append({"date": k, "active": k in days})
        cur += timedelta(days=1)
    return out


def _weekly_digest(uid):
    """This week vs last week. Three tiles, each with a delta."""
    now = datetime.now(timezone.utc)
    this_start = now - timedelta(days=7)
    last_start = now - timedelta(days=14)

    def bucket():
        return {"tests": 0, "correct": 0, "total": 0}

    this_w, last_w = bucket(), bucket()

    try:
        for doc in _db().collection("test_sessions") \
                .where("user_id", "==", uid) \
                .where("status", "==", "completed").stream():
            s = doc.to_dict() or {}
            at = s.get("completed_at")
            if not hasattr(at, "timestamp"):
                continue
            ts = at.timestamp()
            if ts >= this_start.timestamp():
                b = this_w
            elif ts >= last_start.timestamp():
                b = last_w
            else:
                continue
            b["tests"] += 1
            for q in s.get("questions", []) or []:
                b["total"] += 1
                if q.get("is_correct"):
                    b["correct"] += 1
    except Exception as e:
        print(f"[portal] weekly digest failed: {e}")

    blocks_this = 0
    try:
        for doc in _db().collection("users").document(uid) \
                .collection("revision_progress").stream():
            d = doc.to_dict() or {}
            la = d.get("last_active")
            la_iso = _iso(la)
            if la_iso and la_iso >= this_start.isoformat():
                blocks_this += len(d.get("blocks_completed", []) or [])
    except Exception:
        pass

    def delta(a, b):
        if b == 0:
            return None      # no baseline — show no arrow, not "+100%"
        return round((a - b) / b * 100)

    return {
        "tests": {"value": this_w["tests"], "delta": delta(this_w["tests"], last_w["tests"])},
        "blocks": {"value": blocks_this, "delta": None},
        "accuracy": {
            "value": _pct(this_w["correct"], this_w["total"]) if this_w["total"] else None,
            "delta": (delta(_pct(this_w["correct"], this_w["total"]),
                            _pct(last_w["correct"], last_w["total"]))
                      if this_w["total"] and last_w["total"] else None),
        },
    }


def _parent_alerts(r):
    """Parent-facing wording. The teacher deck gets the blunt version; a
    parent gets something they can act on without panicking."""
    # Keyed on teacher_signals FLAG KINDS. The old keys (inactive_7d,
    # mastery_below_40, repeated_failures, many_interventions) belonged to
    # _alert_flags, which is gone -- a parent would have seen an empty
    # alert list forever if these had been left as they were.
    copy = {
        "never_started": ("Hasn't started yet",
                          "No tests taken so far. A short first chapter is the easiest way in."),
        "inactive": ("Quiet for a while",
                     "No study activity in the last week."),
        "low_scores": ("Needs support",
                       "The last few test scores have been low. Going back over the "
                       "chapter will help more than taking another test."),
        "forgetting": ("Answers slipping away",
                       "Questions answered correctly are being missed when they come "
                       "back later. Revisiting those chapters would help."),
        "failed_retakes": ("Same questions again",
                           "A few questions were missed a second time on the retake."),
        "tested_blind": ("Testing without reading",
                         "Tests are being taken before the chapter has been read."),
        "read_not_tested": ("Reading without testing",
                            "Chapters are being read but not tested on. The test is "
                            "what makes it stick."),
        "rushing": ("Going very fast",
                    "Questions are being answered much faster than classmates, which "
                    "usually means guessing."),
        "arena_low": ("Full paper score is low",
                      "The most recent full NEET paper came in low. Worth looking at "
                      "which subject cost the most marks."),
        "streak_broken": ("Streak broke",
                          "A long study streak just ended — worth a gentle nudge."),
    }
    out = []
    for f in r.get("alert_flags", []) or []:
        if f in copy:
            title, body = copy[f]
            out.append({"flag": f, "title": title, "body": body})
    return out


def _recent_activity(uid, limit=5):
    events = []
    try:
        for doc in _db().collection("test_sessions") \
                .where("user_id", "==", uid) \
                .where("status", "==", "completed").stream():
            s = doc.to_dict() or {}
            at = _iso(s.get("completed_at"))
            if not at:
                continue
            pct = s.get("percentage")
            events.append({
                "type": "test",
                "at": at,
                "title": f"Test {s.get('test_num', '')} · {s.get('phase', 'Practice')}",
                "subtitle": f"{pct}%" if pct is not None else "",
                "good": (pct or 0) >= PASS_THRESHOLD,
            })
    except Exception:
        pass

    try:
        for doc in _db().collection("users").document(uid) \
                .collection("revision_progress").stream():
            d = doc.to_dict() or {}
            at = _iso(d.get("last_active"))
            if not at:
                continue
            events.append({
                "type": "studio",
                "at": at,
                "title": d.get("chapter_name") or d.get("chapter_id", "Chapter"),
                "subtitle": f"{d.get('completion_percentage', 0)}% complete",
                "good": True,
            })
    except Exception:
        pass

    events.sort(key=lambda e: e["at"], reverse=True)
    return events[:limit]


# ── SCREEN 2 · LEARNING ────────────────────────────────────────────────────

@portal_bp.route("/api/parent/child/<student_uid>/learning", methods=["GET"])
@require_auth
@require_role("parent")
@resolve_child
def parent_learning(student_uid):
    r = _rollup(student_uid)
    meta = chapter_meta()

    # Studio (revision) progress, per chapter
    studio = {}
    time_by_week = {}
    try:
        for doc in _db().collection("users").document(student_uid) \
                .collection("revision_progress").stream():
            d = doc.to_dict() or {}
            studio[d.get("chapter_id", doc.id)] = {
                "completion": round(float(d.get("completion_percentage", 0) or 0), 1),
                "blocks_done": len(d.get("blocks_completed", []) or []),
                "blocks_total": int(d.get("total_blocks", 0) or 0),
                "last_active": _iso(d.get("last_active")),
                "chapter_name": d.get("chapter_name", ""),
            }
    except Exception as e:
        print(f"[portal] studio read failed: {e}")

    # Time in tests, bucketed by ISO week. Labelled honestly: this is time
    # spent inside tests, not time spent in the app. We do not track the
    # latter, and inventing it would be a lie the parent can't audit.
    try:
        for doc in _db().collection("test_sessions") \
                .where("user_id", "==", student_uid) \
                .where("status", "==", "completed").stream():
            s = doc.to_dict() or {}
            at = s.get("completed_at")
            if not hasattr(at, "isoformat"):
                continue
            wk = at.astimezone(IST_TZ).strftime("%G-W%V")
            time_by_week[wk] = time_by_week.get(wk, 0) + int(s.get("time_taken_seconds", 0) or 0)
    except Exception:
        pass

    # Coverage per subject: done / in-progress / untouched
    coverage = []
    for subj in SUBJECTS:
        chapters = [cid for cid, m in meta.items() if m["subject"] == subj]
        done = in_prog = 0
        for cid in chapters:
            pc = r.get("per_chapter", {}).get(cid)
            sp = studio.get(cid)
            complete = (pc and pc.get("complete")) or (sp and sp["completion"] >= 100)
            touched = bool(pc) or bool(sp)
            if complete:
                done += 1
            elif touched:
                in_prog += 1
        coverage.append({
            "subject": subj,
            "done": done,
            "in_progress": in_prog,
            "untouched": max(0, len(chapters) - done - in_prog),
            "total": len(chapters),
            "mastery": r.get("per_subject", {}).get(subj, {}).get("mastery", 0),
            "accuracy": r.get("per_subject", {}).get(subj, {}).get("accuracy", 0),
        })

    # Chapter rows, grouped by subject
    chapters = []
    for cid, m in meta.items():
        pc = r.get("per_chapter", {}).get(cid, {})
        sp = studio.get(cid, {})
        if not pc and not sp:
            continue
        chapters.append({
            "chapter_id": cid,
            "chapter_name": m["chapter_title"],
            "chapter_number": m["chapter_number"],
            "subject": m["subject"],
            "class": m["class"],
            "mastery": pc.get("mastery", 0),
            "tests": pc.get("tests", 0),
            "total_tests": m["total_tests"],
            "last_test_pct": pc.get("last_test_pct"),
            "accuracy": pc.get("accuracy", 0),
            "studio_completion": sp.get("completion", 0),
            "blocks_done": sp.get("blocks_done", 0),
            "blocks_total": sp.get("blocks_total", 0),
            "status": pc.get("status") or ("studying" if sp else "not_started"),
            "last_active": max(sp.get("last_active", ""), ""),
        })
    chapters.sort(key=lambda c: (c["subject"], c["class"], c["chapter_number"]))

    # "Currently working on"
    current = max(chapters, key=lambda c: c["last_active"] or "", default=None)

    fc_seen = r.get("flashcards_seen", 0)
    fc_correct = r.get("flashcards_correct", 0)

    return jsonify({
        "coverage": coverage,
        "chapters": chapters,
        "current": current,
        "flashcards": {
            "seen": fc_seen,
            "correct": fc_correct,
            "recall_pct": _pct(fc_correct, fc_seen),
        },
        "time_in_tests": [
            {"week": k, "seconds": v, "minutes": round(v / 60)}
            for k, v in sorted(time_by_week.items())
        ][-12:],
        "studio_summary": {
            "chapters_started": r.get("studio_chapters_started", 0),
            "chapters_total": r.get("studio_chapters_total", 0),
            "avg_completion": r.get("studio_pct", 0),
        },
    })


# ── SCREEN 3 · TESTS ───────────────────────────────────────────────────────

@portal_bp.route("/api/parent/child/<student_uid>/tests", methods=["GET"])
@require_auth
@require_role("parent")
@resolve_child
def parent_tests(student_uid):
    meta = chapter_meta()

    log = []
    difficulty = {d: {"correct": 0, "total": 0} for d in ("Easy", "Medium", "Hard")}
    correct = wrong = unattempted = 0
    retakes = 0

    try:
        for doc in _db().collection("test_sessions") \
                .where("user_id", "==", student_uid) \
                .where("status", "==", "completed").stream():
            s = doc.to_dict() or {}
            cid = s.get("chapter_id", "")
            m = meta.get(cid, {})

            answered = 0
            for q in s.get("questions", []) or []:
                d = q.get("difficulty", "Medium")
                if d not in difficulty:
                    difficulty[d] = {"correct": 0, "total": 0}
                if q.get("student_answer") in (None, "", {}):
                    unattempted += 1
                    continue
                answered += 1
                difficulty[d]["total"] += 1
                if q.get("is_correct"):
                    correct += 1
                    difficulty[d]["correct"] += 1
                else:
                    wrong += 1

            if s.get("is_retake"):
                retakes += 1

            log.append({
                "session_id": s.get("session_id", doc.id),
                "chapter_id": cid,
                "chapter_name": m.get("chapter_title", cid),
                "subject": m.get("subject", ""),
                "test_num": s.get("test_num"),
                "phase": s.get("phase", "Practice"),
                "total_questions": s.get("total_questions", 0),
                "answered": answered,
                "score": s.get("score"),
                "percentage": s.get("percentage", 0),
                "passed": (s.get("percentage") or 0) >= PASS_THRESHOLD,
                "is_retake": bool(s.get("is_retake")),
                "time_taken_seconds": s.get("time_taken_seconds", 0),
                "completed_at": _iso(s.get("completed_at")),
            })
    except Exception as e:
        print(f"[portal] tests read failed: {e}")

    log.sort(key=lambda t: t["completed_at"] or "", reverse=True)

    trend = [{"x": i + 1, "y": t["percentage"], "label": t["chapter_name"],
              "at": t["completed_at"]}
             for i, t in enumerate(reversed(log))]

    return jsonify({
        "log": log,
        "trend": trend,
        "pass_threshold": PASS_THRESHOLD,
        "accuracy": {"correct": correct, "wrong": wrong, "unattempted": unattempted},
        "difficulty": [
            {"difficulty": d, "correct": v["correct"], "total": v["total"],
             "accuracy": _pct(v["correct"], v["total"])}
            for d, v in difficulty.items() if v["total"]
        ],
        "retakes": retakes,
        "phase_journey": _phase_journey(student_uid, meta),
    })


def _phase_journey(uid, meta):
    """Which phase is the student in, per chapter they've opened."""
    order = ["Foundation", "Skill Building", "Mastery", "NEET Simulation",
             "Grand Mock", "Bonus Pool"]
    out = []
    for doc in _db().collection("user_progress").where("user_id", "==", uid).stream():
        p = doc.to_dict() or {}
        cid = p.get("chapter_id", "")
        if cid not in meta:
            continue
        state = p.get("phase_state", {}) or {}
        active = None
        for name in order:
            st = state.get(name, {})
            if st.get("status") == "active":
                active = name
                break
        if not active and p.get("chapter_fully_complete"):
            active = "Bonus Pool"
        if p.get("tests_completed", 0) == 0:
            continue
        out.append({
            "chapter_id": cid,
            "chapter_name": meta[cid]["chapter_title"],
            "subject": meta[cid]["subject"],
            "active_phase": active or "Foundation",
            "phases": order,
            "tests_completed": p.get("tests_completed", 0),
            "complete": bool(p.get("chapter_fully_complete")),
        })
    out.sort(key=lambda c: -c["tests_completed"])
    return out


@portal_bp.route("/api/parent/child/<student_uid>/test/<session_id>/review", methods=["GET"])
@require_auth
@require_role("parent")
@resolve_child
def parent_test_review(student_uid, session_id):
    """Wrong-answer review. ONE document read.

    test_sessions.questions[] already carries question_text, options_detail,
    explanations, common_mistakes and ncert_page_quote — the whole review
    payload. No re-hydration from the questions collection needed.

    GATE: completed sessions only. An in-progress session would leak
    questions the student has not yet answered, and the parent could hand
    them over. Every mastery number in the app depends on that not happening.
    """
    doc = _db().collection("test_sessions").document(session_id).get()
    if not doc.exists:
        return jsonify({"error": "Test not found."}), 404

    s = doc.to_dict()
    if s.get("user_id") != student_uid:
        print(f"[portal] SESSION SCOPE VIOLATION parent={request.uid} session={session_id}")
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
            "question_id": q.get("question_id"),
            "question_text": q.get("question_text", ""),
            "question_type": q.get("question_type", "single_correct"),
            "has_image": q.get("has_image", False),
            "image_url": q.get("image_url"),
            "list1": q.get("list1", []),
            "list2": q.get("list2", []),
            "options": q.get("options_detail", []),
            "correct_answer": q.get("correct_answer"),
            "student_answer": q.get("student_answer"),
            "is_correct": q.get("is_correct"),
            "attempted": q.get("student_answer") not in (None, "", {}),
            "difficulty": q.get("difficulty", ""),
            "concept_id": q.get("concept_id", ""),
            "explanation": q.get("detailed_explanation") or q.get("static_explanation", ""),
            "key_points": q.get("key_points", []),
            "common_mistakes": q.get("common_mistakes", []),
            "ncert_page_quote": q.get("ncert_page_quote", ""),
        })

    meta = chapter_meta().get(s.get("chapter_id", ""), {})
    return jsonify({
        "session_id": session_id,
        "chapter_name": meta.get("chapter_title", s.get("chapter_id", "")),
        "subject": meta.get("subject", ""),
        "test_num": s.get("test_num"),
        "phase": s.get("phase", ""),
        "score": s.get("score"),
        "percentage": s.get("percentage", 0),
        "total_questions": s.get("total_questions", 0),
        "completed_at": _iso(s.get("completed_at")),
        "questions": questions,
    })


# ── SCREEN 4 · INSIGHTS ────────────────────────────────────────────────────

@portal_bp.route("/api/parent/child/<student_uid>/insights", methods=["GET"])
@require_auth
@require_role("parent")
@resolve_child
def parent_insights(student_uid):
    r = _rollup(student_uid)
    meta = chapter_meta()

    status_counts = {"mastered": 0, "learning": 0, "struggling": 0, "not_started": 0}
    improvement = []      # per-concept trend lines
    stuck = []
    interventions = []

    for doc in _db().collection("user_progress").where("user_id", "==", student_uid).stream():
        p = doc.to_dict() or {}
        cid = p.get("chapter_id", "")
        if cid not in meta:
            continue
        ch_name = meta[cid]["chapter_title"]

        for concept_id, c in (p.get("concept_mastery", {}) or {}).items():
            m = float(c.get("mastery_score", 0) or 0)
            seen = len(c.get("questions_seen", []) or [])
            if seen == 0:
                status_counts["not_started"] += 1
            elif m >= 80:
                status_counts["mastered"] += 1
            elif m < 50:
                status_counts["struggling"] += 1
            else:
                status_counts["learning"] += 1

            if int(c.get("consecutive_concept_failures", 0) or 0) >= 2:
                stuck.append({
                    "concept_id": concept_id,
                    "concept_name": c.get("concept_name", concept_id),
                    "chapter_id": cid,
                    "chapter_name": ch_name,
                    "failures": int(c.get("consecutive_concept_failures", 0)),
                    "mastery": round(m, 1),
                })

        # concept_mastery_history — the improvement graph, already stored.
        hist = p.get("concept_mastery_history", []) or []
        if hist:
            names = {cid_: c.get("concept_name", cid_)
                     for cid_, c in (p.get("concept_mastery", {}) or {}).items()}
            series = {}
            for snap in hist:
                for concept_id, val in (snap.get("mastery_by_concept", {}) or {}).items():
                    series.setdefault(concept_id, []).append({
                        "test_num": snap.get("test_num"),
                        "mastery": round(float(val or 0), 1),
                        "at": _iso(snap.get("completed_at")),
                    })
            for concept_id, pts in series.items():
                if len(pts) < 2:
                    continue  # a single point is not a trend
                pts.sort(key=lambda x: x["test_num"] or 0)
                improvement.append({
                    "concept_id": concept_id,
                    "concept_name": names.get(concept_id, concept_id),
                    "chapter_id": cid,
                    "chapter_name": ch_name,
                    "subject": meta[cid]["subject"],
                    "points": pts,
                    "delta": round(pts[-1]["mastery"] - pts[0]["mastery"], 1),
                })

        for iv in (p.get("pending_interventions", []) or []):
            interventions.append({
                "chapter_id": cid,
                "chapter_name": ch_name,
                "concept_id": iv.get("concept_id", ""),
                "concept_name": iv.get("concept_name", ""),
                "reason": iv.get("reason", ""),
            })

    # Biggest movers first — a parent scrolling one chart wants the one
    # that changed, not the alphabetically first.
    improvement.sort(key=lambda s: -abs(s["delta"]))

    radar = [{"subject": s,
              "mastery": r.get("per_subject", {}).get(s, {}).get("mastery", 0),
              "accuracy": r.get("per_subject", {}).get(s, {}).get("accuracy", 0)}
             for s in SUBJECTS]

    return jsonify({
        "strengths": r.get("strong_concepts", [])[:5],
        "weaknesses": r.get("weak_concepts", [])[:5],
        "status_distribution": status_counts,
        "improvement": improvement[:20],
        "radar": radar,
        "stuck_concepts": sorted(stuck, key=lambda c: -c["failures"])[:10],
        "interventions": interventions,
        "overall_mastery": r.get("overall_mastery", 0),
        "accuracy": r.get("accuracy", 0),
    })


# ── SCREEN 5 · NEET READINESS ──────────────────────────────────────────────

@portal_bp.route("/api/parent/child/<student_uid>/readiness", methods=["GET"])
@require_auth
@require_role("parent")
@resolve_child
def parent_readiness(student_uid):
    r = _rollup(student_uid)
    child = request.child_doc

    attempts = []
    try:
        for doc in _db().collection("pyq_sessions") \
                .where("user_id", "==", student_uid) \
                .where("status", "==", "completed") \
                .where("arena_session", "==", True) \
                .where("test_type", "==", "full_paper").stream():
            s = doc.to_dict() or {}
            sd = s.get("score_data", {}) or {}
            attempts.append({
                "session_id": s.get("session_id", doc.id),
                "label": s.get("label", ""),
                "year": s.get("year"),
                "paper_code": s.get("paper_code"),
                "total_marks": sd.get("total_marks", 0),
                "max_marks": sd.get("max_marks", 720),
                "accuracy": sd.get("accuracy", 0),
                "air_prediction": _air_number(sd.get("air_prediction")),
                "subject_marks": sd.get("subject_marks", {}),
                "completed_at": _iso(sd.get("completed_at")) or _iso(s.get("completed_at")),
            })
    except Exception as e:
        print(f"[portal] readiness read failed: {e}")

    attempts.sort(key=lambda a: a["completed_at"] or "")

    target = child.get("neet_target_score")
    latest = attempts[-1] if attempts else None

    days_to_neet = None
    year = child.get("neet_target_year")
    if year:
        # NTA hasn't published a date; the first Sunday of May is the
        # historical pattern and is honest enough for a countdown.
        try:
            exam = datetime(int(year), 5, 4, tzinfo=IST_TZ)
            days_to_neet = max(0, (exam - datetime.now(IST_TZ)).days)
        except Exception:
            pass

    return jsonify({
        "attempts": attempts,
        "latest": latest,
        "best_air": r.get("best_air_prediction"),
        "target_score": target,
        "max_score": 720,
        "papers_attempted": r.get("arena_papers_attempted", 0),
        "papers_total": r.get("arena_papers_total", 0),
        "days_to_neet": days_to_neet,
        "target_year": year,
        "sparkline": [a["total_marks"] for a in attempts][-5:],
    })


# ── SCREEN 6 · COMPARISON (off by default, per class) ──────────────────────

@portal_bp.route("/api/parent/child/<student_uid>/comparison", methods=["GET"])
@require_auth
@require_role("parent")
@resolve_child
def parent_comparison(student_uid):
    """Percentile within the section. No other student is ever named.

    Returns 403 unless the class's teacher has switched this on. Percentiles
    are motivating for the top half and quietly corrosive for the bottom.
    """
    r = _rollup(student_uid)
    key = r.get("class_key", "")
    if not key or r.get("class_status") != "approved":
        return jsonify({"error": "Not assigned to a class yet.",
                        "code": "NO_CLASS"}), 404

    cls = _db().collection("classes").document(key).get()
    if not cls.exists or not cls.to_dict().get("settings", {}).get("peer_comparison_enabled"):
        return jsonify({"error": "Class comparison is turned off for this class.",
                        "code": "DISABLED"}), 403

    peers = []
    for doc in _db().collection("student_rollups").where("class_key", "==", key).stream():
        p = doc.to_dict() or {}
        if p.get("class_status") != "approved":
            continue
        peers.append({"uid": doc.id,
                      "mastery": p.get("overall_mastery", 0),
                      "accuracy": p.get("accuracy", 0)})

    if len(peers) < 5:
        return jsonify({"error": "Not enough students in the class yet.",
                        "code": "TOO_FEW"}), 404

    peers.sort(key=lambda p: -p["mastery"])
    rank = next((i + 1 for i, p in enumerate(peers) if p["uid"] == student_uid), None)
    n = len(peers)

    avg_mastery = round(sum(p["mastery"] for p in peers) / n, 1)
    avg_accuracy = round(sum(p["accuracy"] for p in peers) / n, 1)

    return jsonify({
        "rank": rank,
        "total": n,
        "percentile": round((n - rank) / n * 100) if rank else None,
        "child": {"mastery": r.get("overall_mastery", 0), "accuracy": r.get("accuracy", 0)},
        "class_avg": {"mastery": avg_mastery, "accuracy": avg_accuracy},
    })


# ── PROFILE ────────────────────────────────────────────────────────────────

@portal_bp.route("/api/parent/preferences", methods=["POST"])
@require_auth
@require_role("parent")
def parent_preferences():
    data = request.json or {}
    update = {}
    for f in ("notify_weekly_digest", "notify_alerts"):
        if f in data:
            update[f] = bool(data[f])
    if "name" in data:
        update["name"] = str(data["name"]).strip()[:80]
    if not update:
        return jsonify({"error": "Nothing to update."}), 400
    update["updated_at"] = firestore.SERVER_TIMESTAMP
    _db().collection("users").document(request.uid).set(update, merge=True)
    return jsonify({"status": "ok", "updated": sorted(update.keys())})


@portal_bp.route("/api/parent/child/<student_uid>/teacher", methods=["GET"])
@require_auth
@require_role("parent")
@resolve_child
def parent_child_teacher(student_uid):
    """Contact-teacher card. Returns nothing if the class isn't set up."""
    r = _rollup(student_uid)
    key = r.get("class_key", "")
    if not key:
        return jsonify({"teachers": []})
    cls = _db().collection("classes").document(key).get()
    if not cls.exists:
        return jsonify({"teachers": []})
    out = []
    for tuid in cls.to_dict().get("teacher_uids", []) or []:
        t = _user(tuid) or {}
        out.append({"name": t.get("name", "Teacher"), "email": t.get("email", "")})
    return jsonify({"teachers": out, "class_key": key,
                    "school_name": cls.to_dict().get("school_name", "")})


# ═══════════════════════════════════════════════════════════════════════════
# REGISTRATION
# ═══════════════════════════════════════════════════════════════════════════

def init_portal(app, require_auth=None):
    """Attach the portal to YOUR Flask app. One app, one Firestore project,
    one deploy — this registers a Blueprint, it does not create a service.

    Pass backend.py's require_auth so the portal authenticates through the
    exact same code path as every existing student route. Omit it and the
    portal falls back to an equivalent local implementation (used by the
    cron scripts and the test suite, which never load backend.py).
    """
    global _AUTH_IMPL
    if require_auth is not None:
        _AUTH_IMPL = require_auth
    app.register_blueprint(portal_bp)

    # Late import: teacher_backend imports from THIS module, so importing it
    # at the top would be a cycle. Inside the function it resolves cleanly.
    from teacher_backend import init_teacher
    init_teacher(app)

    print(f"[portal] {len(portal_bp.deferred_functions)} parent routes registered "
          f"on {app.name} (auth: {'backend.require_auth' if _AUTH_IMPL else 'local fallback'})")
    return app