"""
NAADI AI - Complete Backend API
Flask server with Firebase for adaptive NEET preparation.
 
Features:
- v1+v2 regular test pool, v3 intervention reserve
- Dynamic test planning per chapter
- Post-test intervention pop-ups (2nd consecutive failure)
- AI tutor integration (Gemini Flash)
- Session persistence & memory
- Concept-level + Base-level tracking
- Bonus excellence questions
- Complete dashboard with insights
"""
 
import os
 
# ══════════════════════════════════════════════════════════════════
# Load .env into os.environ BEFORE anything reads it.
#
# ORDERING: this MUST stay above the Gemini block further down, which
# calls genai.configure(api_key=os.environ.get("GEMINI_API_KEY", ""))
# at IMPORT time. A load_dotenv() placed any lower leaves Gemini
# configured with an empty key even though os.environ is populated by
# then — and the gates guarding the Gemini calls only check os.environ,
# so they OPEN and every call fails auth silently.
#
# WHY THIS IS MORE THAN ONE LINE — every one of these was reproduced:
#   • load_dotenv() RETURNS False when it finds nothing; it does not
#     raise. Printing "✅ .env loaded" off the back of a try/except
#     ImportError only ever proved the PACKAGE imported. It printed
#     success while nothing had loaded at all.
#   • A UTF-8 BOM (Notepad's plain "UTF-8" Save As) makes the first key
#     literally "\ufeffDEEPSEEK_API_KEY", so load_dotenv returns True
#     and the key is still missing. encoding="utf-8-sig" strips it.
#   • PowerShell's `>` / Set-Content writes UTF-16LE, which raises
#     UnicodeDecodeError inside load_dotenv — not an ImportError, so the
#     old except clause did not catch it and the whole app failed to boot.
#   • load_dotenv defaults to override=False, so a variable already
#     present as an empty string (a stale shell export, VS Code's
#     python.envFile) silently wins over the file. override=True fixes it.
#   • Notepad "Save As" with type "Text Documents" produces .env.txt.
#     The check below names the file it actually found.
# ══════════════════════════════════════════════════════════════════
_ENV_DIR = os.path.dirname(os.path.abspath(__file__))
_ENV_PATH = os.path.join(_ENV_DIR, ".env")
 
 
def _load_env_file():
    """Returns (ok: bool, message: str). Never raises."""
    try:
        from dotenv import load_dotenv
    except ImportError:
        return False, "python-dotenv not installed  ->  pip install python-dotenv"
 
    if not os.path.exists(_ENV_PATH):
        nearby = [f for f in os.listdir(_ENV_DIR) if f.lower().startswith(".env")]
        hint = f"  (found instead: {nearby} — rename it to exactly '.env')" if nearby else ""
        return False, f"no .env at {_ENV_PATH}{hint}"
 
    # utf-8-sig first: it reads plain UTF-8 too, and strips a BOM if present.
    read_ok = False        # did ANY encoding actually decode the file?
    for enc in ("utf-8-sig", "utf-16", "cp1252"):
        try:
            load_dotenv(_ENV_PATH, encoding=enc, override=True)
            read_ok = True
            if os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("GEMINI_API_KEY"):
                return True, f"{_ENV_PATH} (encoding={enc})"
        except (UnicodeDecodeError, UnicodeError):
            continue           # wrong encoding — try the next one
        except Exception as e:
            return False, f"{_ENV_PATH} could not be parsed: {e}"
 
    if read_ok:
        # The file decoded fine — it just has no key by the name we want.
        # List the names it DOES have, so a typo is obvious at a glance.
        try:
            with open(_ENV_PATH, encoding="utf-8-sig", errors="replace") as fh:
                names = [ln.split("=", 1)[0].strip() for ln in fh
                         if "=" in ln and not ln.strip().startswith("#")]
        except Exception:
            names = []
        return False, (f"{_ENV_PATH} was read, but has no DEEPSEEK_API_KEY / GEMINI_API_KEY. "
                       f"Keys found: {names or 'none'} — check the spelling, and drop any "
                       f"'set ' prefix or smart quotes.")
 
    return False, (f"{_ENV_PATH} is not readable as utf-8, utf-16 or cp1252 — "
                   f"re-save it as plain UTF-8.")
 
 
_env_ok, _env_msg = _load_env_file()
print(("✅ .env loaded from " if _env_ok else "⚠️  .env NOT loaded: ") + _env_msg)
 
import json
import math
import re
import random
import asyncio
import time
import hashlib
from datetime import datetime, timezone, timedelta
from functools import wraps
 
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
 
import firebase_admin
from firebase_admin import credentials, firestore, auth as firebase_auth
 
# Optional: Gemini API for AI interventions
try:
    import google.generativeai as genai
    GEMINI_AVAILABLE = True
    genai.configure(api_key=os.environ.get("GEMINI_API_KEY", ""))
except ImportError:
    GEMINI_AVAILABLE = False
 
# ── Boot-time key report ────────────────────────────────────────
# Both keys are read from os.environ. If they're empty you do NOT get an
# error — you get the hardcoded fallback diagnosis instead of Gemini's,
# and the "last_resort" giveaway question instead of a real one. That
# failure looks identical to a working app, so say it out loud at boot.
# Never print the keys themselves — only whether they arrived.
def _key_report(name, consequence):
    v = os.environ.get(name, "")
    if v:
        return f"set (…{v[-4:]}, {len(v)} chars)"
    return f"MISSING — {consequence}"
 
 
print(f"   GEMINI_API_KEY   : {_key_report('GEMINI_API_KEY', 'AI tutor falls back to canned text')}")
print(f"   DEEPSEEK_API_KEY : {_key_report('DEEPSEEK_API_KEY', '/api/ai/analyse will return 503')}")
 
# ──────────────────────────────────────────────
# APP INIT
# ──────────────────────────────────────────────
import opd_engine as _E

app = Flask(__name__, static_folder="mobile", static_url_path="")
# Configure CORS to allow requests from frontend
CORS(app, resources={
    r"/api/*": {
        "origins": "*",  # Allow all origins for development
        "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        "allow_headers": ["Content-Type", "Authorization"],
        "expose_headers": ["Content-Type", "Authorization"],
        "supports_credentials": True
    }
})
 
# Firebase init
SERVICE_ACCOUNT_PATH = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "serviceAccountKey.json")
 
if os.path.exists(SERVICE_ACCOUNT_PATH):
    cred = credentials.Certificate(SERVICE_ACCOUNT_PATH)
    firebase_admin.initialize_app(cred)
else:
    firebase_admin.initialize_app()
 
db = firestore.client()


# ──────────────────────────────────────────────
# AUTH MIDDLEWARE
# ──────────────────────────────────────────────
def require_auth(f):
    """
    Firebase Auth decorator with clock skew tolerance.
    IMPORTANT: Only catches Firebase Auth exceptions.
    All other exceptions are re-raised so Flask handles them properly.
    """
    @wraps(f)
    def decorated_function(*args, **kwargs):
        auth_header = request.headers.get('Authorization', '')

        if not auth_header.startswith('Bearer '):
            return jsonify({"error": "No authorization token provided"}), 401

        # Clean the token — strip whitespace to avoid format errors
        id_token = auth_header.split('Bearer ', 1)[1].strip()

        if not id_token:
            return jsonify({"error": "Empty token", "code": "EMPTY_TOKEN"}), 401

        try:
            # Try with clock_skew_seconds (firebase-admin >= 6.0)
            try:
                decoded_token = firebase_auth.verify_id_token(
                    id_token,
                    clock_skew_seconds=10
                )
            except TypeError:
                # Older SDK - fall back to manual retry
                decoded_token = _verify_token_with_retry(id_token)

            request.uid = decoded_token['uid']
            request.user_email = decoded_token.get('email', '')
            return f(*args, **kwargs)

        except firebase_auth.ExpiredIdTokenError:
            return jsonify({
                "error": "Token expired. Please refresh and try again.",
                "code": "TOKEN_EXPIRED"
            }), 401

        except firebase_auth.RevokedIdTokenError:
            return jsonify({
                "error": "Token revoked. Please sign in again.",
                "code": "TOKEN_REVOKED"
            }), 401

        except firebase_auth.InvalidIdTokenError as e:
            error_msg = str(e)
            if "Token used too early" in error_msg:
                try:
                    time.sleep(3)
                    decoded_token = firebase_auth.verify_id_token(id_token)
                    request.uid = decoded_token['uid']
                    request.user_email = decoded_token.get('email', '')
                    return f(*args, **kwargs)
                except Exception:
                    return jsonify({
                        "error": "Authentication timing error. Please try again.",
                        "code": "CLOCK_SKEW",
                        "retry": True
                    }), 401
            return jsonify({
                "error": f"Invalid token: {error_msg}",
                "code": "INVALID_TOKEN"
            }), 401

        # NOTE: No broad "except Exception" here.
        # Any non-auth exception (Firestore errors, app bugs, etc.)
        # will propagate naturally so Flask returns 500, not 401.
        # This was the root cause: Firestore FieldPath ValueError was
        # being swallowed here and returned as 401 (UNAUTHORIZED).

    return decorated_function

def _verify_token_with_retry(id_token, max_retries=2):
    """
    Fallback: verify token with retry for older firebase-admin versions.
    """
    last_error = None
    
    for attempt in range(max_retries + 1):
        try:
            return firebase_auth.verify_id_token(id_token)
        except firebase_auth.InvalidIdTokenError as e:
            last_error = e
            if "Token used too early" in str(e) and attempt < max_retries:
                time.sleep(2)
                continue
            raise
    
    raise last_error

# ── Parent + Teacher portal ──────────────────────────────────────
from portal_backend import (
    init_portal, safe_rebuild, record_study_day, mirror_identity)
init_portal(app, require_auth=require_auth)

from teacher_home import home_bp
app.register_blueprint(home_bp)

from teacher_class import register_class_routes
register_class_routes(app)

from teacher_students import register_student_routes
register_student_routes(app)

from teacher_student import register_student_page_routes
register_student_page_routes(app)

from teacher_concepts import register_concept_routes
register_concept_routes(app)

# ── Parent Home v2 ───────────────────────────────────────────────
#  Replaces the payload behind the parent portal's Home tab. Mounted
#  here rather than inside init_portal() so that every page module in
#  this app is visible from ONE place: portal_backend owns the parent
#  API, this file owns what is mounted.
#
#  Its routes live under /api/parent/v2/ and the registrar refuses to
#  start if any of them escapes that prefix -- portal_backend already
#  serves /api/parent/child/<uid>/home, and Flask resolves a duplicate
#  rule to whichever blueprint registered first, silently.
#
#  Auth: parent_home imports require_auth from portal_backend, which is
#  an alias for portal_auth. portal_auth reads _AUTH_IMPL at CALL time,
#  and init_portal() above has already set it to this file's
#  require_auth -- so these routes authenticate through the same code
#  path as every student route, without importing backend.py (which
#  would be a cycle).
from parent_home import register_parent_home_routes
register_parent_home_routes(app)

# ── Parent Learning ──────────────────────────────────────────────
#  The syllabus map, the chapter detail panel, and time spent. Same
#  /api/parent/v2/ namespace and the same startup guard as above.
#
#  Mounted after parent_home because both import parent_syllabus, and
#  a single cached read of revision_chapters serves them both -- two
#  readers of one collection is how two caches end up disagreeing
#  about what the syllabus is.
from parent_learning import register_parent_learning_routes
register_parent_learning_routes(app)

# ── Parent Tests ─────────────────────────────────────────────────
#  Three levels: the overview, one chapter, one test in full.
#
#  Mounted after the teacher modules on purpose: parent_tests imports
#  the row shapes from teacher_student rather than writing a second
#  copy of paper grouping, chapter folders and the v1-v2-v3 ladder.
#  Two copies would drift until a teacher and a parent described the
#  same twenty-two attempts differently. teacher_student imports
#  nothing back, so there is no cycle.
from parent_tests import register_parent_tests_routes
register_parent_tests_routes(app)

# ── Parent Insights ──────────────────────────────────────────────
#  The trajectory question: is this heading where it needs to go?
#  Target vs best paper, which ideas are moving which way, the
#  concept level, and what the app has had to step in and rebuild.
#  Same /api/parent/v2/ namespace and the same startup guard.
from parent_insights import register_parent_insights_routes
register_parent_insights_routes(app)

# ── Admin console (admin_backend.py) — same app, same auth, one deploy ──
from admin_backend import init_admin
init_admin(app, require_auth=require_auth)

# ── Doubts: student <-> teacher conversations + class-teacher
#    supervision + safety reports. Own /api/doubts/* namespace; the
#    registrar refuses to start if any rule collides with an existing
#    blueprint, because Flask resolves duplicates silently. ──
from doubts_backend import register_doubt_routes
register_doubt_routes(app)

from ai_gateway import register_assistant_routes
register_assistant_routes(app)

def clean_firestore_data(data):
    """Remove Firestore Sentinels and convert timestamps for JSON serialization."""
    if isinstance(data, dict):
        cleaned = {}
        for key, value in data.items():
            # Skip Sentinel values
            if hasattr(value, '__class__') and 'Sentinel' in value.__class__.__name__:
                continue
            # Convert timestamps
            elif hasattr(value, 'isoformat'):
                cleaned[key] = value.isoformat()
            # Recursively clean nested dicts
            elif isinstance(value, dict):
                cleaned[key] = clean_firestore_data(value)
            # Recursively clean lists
            elif isinstance(value, list):
                cleaned[key] = [clean_firestore_data(item) if isinstance(item, (dict, list)) else item for item in value]
            else:
                cleaned[key] = value
        return cleaned
    elif isinstance(data, list):
        return [clean_firestore_data(item) if isinstance(item, (dict, list)) else item for item in data]
    else:
        return data


# =============================================================================
# CONSTANTS — Mistake-driven adaptive engine (v2)
# =============================================================================

PASS_THRESHOLD = 40  # Minimum test % to unlock the next test

# ──────────────────────────────────────────────
# DEV TOGGLE — chapter/subject access gating
# ──────────────────────────────────────────────
# While content/engine is still being tested, every chapter should be open
# to every user regardless of subscription plan or free_chapters -- no
# "Premium"/locked cards to accidentally click past or misread as a bug.
# Set this back to False to restore the real free/premium gating exactly
# as it was (computed from each user's free_chapters + subscription.plan
# in get_chapters() below) -- flipping this one flag is the entire
# rollback, nothing else needs to change.
DEV_UNLOCK_ALL_CHAPTERS = True

# Phase configuration now lives in opd_engine.PHASE_IDEAL_RATIOS.
#
# max_tests is GONE. It was documented as the exact worst-case bound
# (2 x min_tests) and it was exactly that -- which is precisely why it was
# dead code: a failed v2 escalates to v3 rather than re-queueing, so every v1
# spawns at most one v2, so the queue is always empty by 2 x min_tests and
# phase_completion_status()'s NATURAL branch always fired first. The "forced"
# branch was unreachable => needs_review was never written => bonus_pool_eligible
# was always empty => the Bonus Pool eligibility guard rejected every student
# who ever reached it. opd_engine.prove_no_forced_closure() is that proof, as a
# runnable test rather than a comment.
#
# min_tests is no longer hardcoded either -- opd_engine.solve_min_tests()
# searches it per chapter (pools here range 279..655 v1s and the optimum
# genuinely differs: 3/3/3/5 .. 8/3/3/8).
PHASE_IDEAL_RATIOS = _E.PHASE_IDEAL_RATIOS
PHASE_ORDER = _E.PHASE_ORDER
ENDURANCE = _E.ENDURANCE           # was the "Bonus Pool" phase name
JOURNEY_ORDER = _E.JOURNEY_ORDER
FULL_ORDER = _E.FULL_ORDER
PLAN_VERSION = "v3_concept_stratified"

largest_remainder_split = _E.largest_remainder_split


# =============================================================================
# CHAPTER-LEVEL PLAN: which exact question IDs belong to which phase
# =============================================================================
#
# This runs ONCE per chapter (cached on the progress doc, same for every
# student). It answers "which specific questions belong to Foundation vs
# Skill Building vs ..." using the SAME sequential, ID-level reservation
# pattern used in the corrected qgen Stage F check: Grand Mock claims its
# fixed quota first, then Foundation -> Skill Building -> Mastery ->
# Simulation claim their exact min_tests worth of v1 questions, in order,
# from whatever's left. What's never claimed by any phase falls through
# automatically to Bonus Pool (nothing extra needs to track it -- it's just
# never in seen_question_ids until a student explicitly does bonus work).
#
# Per-student PROGRESS (not this plan) then tracks, separately:
#   - how many tests each phase has actually consumed for that student
#   - that student's personal remediation queue (owed v2s from their mistakes)
# That state lives in progress["phase_state"], initialized in
# get_or_create_progress() and mutated in generate_test() / submit_test().

_normalize_base_id = _E._normalize_base_id
natural_sort_key = _E.natural_sort_key


def compute_content_signature(all_chapter_questions, concepts_summary):
    """Now folds PLAN_VERSION in: an ENGINE change must force a replan even
    when content is byte-identical, or existing students keep the old
    front-loaded reservation forever and never receive the fix."""
    return _E.compute_content_signature(all_chapter_questions, concepts_summary, PLAN_VERSION)


def _fresh_concept_mastery_entry(concept_name):
    return {
        "concept_name": concept_name, "status": "not_started", "mastery_score": 0,
        "questions_seen": [], "questions_correct": [], "questions_wrong": [],
        "needs_retry": False, "consecutive_concept_failures": 0,
        "last_failed_test": None, "base_questions_status": {},
    }


def sync_concept_mastery(concept_mastery, concepts_summary):
    """Non-destructive merge; returns newly-added concept_ids."""
    added = []
    for c in (concepts_summary or []):
        cid = c.get("concept_id")
        if cid and cid not in concept_mastery:
            concept_mastery[cid] = _fresh_concept_mastery_entry(c.get("concept_name", cid))
            added.append(cid)
    return added


def calculate_dynamic_test_plan(all_chapter_questions, concepts_summary=None):
    plan = _E.calculate_dynamic_test_plan(
        all_chapter_questions, concepts_summary, plan_version=PLAN_VERSION, require_v2=True)
    log_chapter_plan(plan)
    return plan


def log_chapter_plan(plan):
    """K1 -- the whole pre-test calculation, in one readable block."""
    cc = plan["content_check"]
    cov = cc.get("concept_coverage", {})
    pc, sur = plan["pool_counts"], plan["surplus"]
    L = []
    L.append("=" * 78)
    L.append("PRE-TEST CALCULATION (runs once per chapter)")
    L.append("=" * 78)
    L.append(f"v1 pool        : Easy {pc['Easy']} | Medium {pc['Medium']} | Hard {pc['Hard']} "
             f"= {sum(pc.values())}")
    L.append(f"concepts       : {cov.get('concepts_total', 0)}")
    L.append(f"v2 companions  : {len(plan['v2_by_base'])} | v3 pool: {len(plan['v3_by_base'])}")
    if cc.get("orphan_v1_no_v2"):
        L.append(f"ORPHAN v1 (v2 missing or unanswerable, EXCLUDED): {cc['orphan_v1_no_v2']}  "
                 f"e.g. {cc.get('orphan_examples')}")
    if cc.get("unanswerable_v1"):
        L.append(f"UNANSWERABLE v1 (options empty, EXCLUDED — would deadlock the phase): "
                 f"{cc['unanswerable_v1']}  e.g. {cc.get('unanswerable_v1_examples')}")
    if cc.get("unanswerable_v2"):
        L.append(f"UNANSWERABLE v2 (options empty -> its v1 excluded): {cc['unanswerable_v2']}  "
                 f"e.g. {cc.get('unanswerable_v2_examples')}")
    if cc.get("unanswerable_v3"):
        L.append(f"UNANSWERABLE v3 (options empty -> popup falls back to review-only): "
                 f"{cc['unanswerable_v3']}  e.g. {cc.get('unanswerable_v3_examples')}")
    L.append(f"min_tests solved: {plan['min_tests_solved']}")
    L.append("")
    L.append(f"{'Phase':<18}{'Tests':>6}{'Q/test':>8}{'E':>5}{'M':>5}{'H':>5}{'v1':>7}{'time':>7}")
    for name in FULL_ORDER:
        p = plan["phases"][name]
        ids = p.get("reserved_v1_ids", [])
        d = {"Easy": 0, "Medium": 0, "Hard": 0}
        for q in ids:
            d[plan["v1_meta"][q]["diff"]] += 1
        L.append(f"{name:<18}{p['min_tests']:>6}{p['q_per_test']:>8}"
                 f"{d['Easy']:>5}{d['Medium']:>5}{d['Hard']:>5}{len(ids):>7}"
                 f"{p['time_minutes']:>6}m")
    jv1 = sum(len(plan["phases"][n].get("reserved_v1_ids", [])) for n in JOURNEY_ORDER)
    L.append("")
    L.append(f"surplus -> {ENDURANCE}: E{sur['Easy']} M{sur['Medium']} H{sur['Hard']} "
             f"= {sum(sur.values())}  | per test {plan['endurance_per_test']} "
             f"x {plan['endurance_tests']} tests")
    L.append(f"STRANDED       : {plan['stranded']} v1  "
             f"({plan['stranded'] / max(1, sum(pc.values())) * 100:.1f}% of pool)")
    L.append("")
    L.append(f"CONCEPT COVERAGE  journey v1 {jv1} / {cov.get('concepts_total', 0)} concepts "
             f"= {jv1 / max(1, cov.get('concepts_total', 1)):.1f} per concept")
    L.append(f"  concepts at zero      : {len(cov.get('concepts_at_zero', []))} "
             f"{cov.get('concepts_at_zero', [])}")
    L.append(f"  concepts below floor {_E.CONCEPT_FLOOR}: {len(cov.get('concepts_below_floor', []))} "
             f"{cov.get('concepts_below_floor', [])}")
    alloc = cov.get("journey_alloc", {})
    tgt = cov.get("targets", {})
    for cid in sorted(alloc, key=lambda c: -alloc[c]):
        L.append(f"    {cid:<22} alloc {alloc[cid]:>3} / target {tgt.get(cid, 0):>3} "
                 f"/ available {plan['concept_weight'].get(cid, 0):>3}")
    if not cc["sufficient"]:
        L.append(f"CONTENT SHORTFALL: {cc['shortfalls']}")
    L.append("=" * 78)
    print("\n".join(L))


def count_regular_questions_by_difficulty(questions_list):
    """
    Kept as a lightweight sanity-check helper (used at chapter-load time to
    log whether the real question pool matches what Fill Gaps was supposed
    to have guaranteed). No longer feeds any allocator -- calculate_dynamic_
    test_plan() now reserves exact IDs directly from the full question list.
    """
    counts = {
        "total_easy_regular": 0, "total_medium_regular": 0,
        "total_hard_regular": 0, "total_v3_questions": 0,
    }
    for q in questions_list:
        meta = q.get("meta_data", {})
        pool = meta.get("pool", "regular")
        difficulty = (meta.get("difficulty") or "").strip().capitalize()
        if pool == "intervention_reserve":
            counts["total_v3_questions"] += 1
        else:
            key = f"total_{difficulty.lower()}_regular"
            if key in counts:
                counts[key] += 1
    return counts


# =============================================================================
# PER-STUDENT PHASE STATE + QUEUE-DRIVEN SELECTION
# =============================================================================
#
# test_plan (above) is the same for every student. phase_state (below) is
# per-student: which phase they're on, how many tests of it they've taken,
# and their personal owed-v2 remediation queue.

get_active_phase = _E.get_active_phase
phase_completion_status = _E.phase_completion_status
build_next_test_selection = _E.build_next_test_selection
process_learning_phase_result = _E.process_learning_phase_result
carry_queue_forward = _E.carry_queue_forward
next_phase_after = _E.next_phase_after
concept_rank_from_mastery = _E.concept_rank_from_mastery


# =============================================================================
# SELECTION DISPATCHER
# =============================================================================

def select_questions_for_test(phase_name, test_plan, progress, all_questions,
                              global_test_num=1):
    """
    Build the question list for the student's next test.

    Endurance is no longer a special case that bypasses the engine -- it is a
    real phase with reserved content and the full v1/v2/v3 cycle, selected by
    the same code path as every other phase. The only difference is that its
    fresh v1s are ordered weakest-concept-first.

    _select_bonus_pool_questions() is GONE. It was unreachable (generate_test
    routed Bonus Pool to generate_bonus_pool_test before the dispatcher ever
    saw it) and it disagreed with the reachable path on question count (25 vs
    BONUS_PER_TEST=15).
    """
    questions_by_id = {q["question_id"]: q for q in all_questions}
    seen = set(progress.get("seen_question_ids", []))
    phase_state_all = progress.setdefault("phase_state", {})
    v3q = progress.setdefault("v3_check_queue", [])

    plan_phase = test_plan["phases"].get(phase_name)
    if plan_phase is None:
        raise ValueError(f"No plan found for phase {phase_name}")

    if phase_name == "Grand Mock":
        # Capstone: exactly the reserved 25, no remediation content, no v3
        # band, no carried queue. Shuffled so option/order effects don't leak.
        ids = plan_phase.get("reserved_question_ids") or plan_phase.get("reserved_v1_ids", [])
        selected = [questions_by_id[q] for q in ids if q in questions_by_id and q not in seen]
        if not selected:
            raise ValueError("No questions available for Grand Mock test.")
        random.shuffle(selected)
        return selected, "Grand Mock", plan_phase["time_minutes"], False, {
            "grand_mock_ids": len(selected),
            "concepts_this_test": sorted({q["meta_data"].get("concept_id", "")
                                          for q in selected}),
        }

    state = phase_state_all.setdefault(
        phase_name, {"tests_taken": 0, "owed_v2": [], "status": "active"})

    concept_rank = None
    if phase_name == ENDURANCE:
        concept_rank = concept_rank_from_mastery(progress.get("concept_mastery", {}))

    selected, is_flex, log_info = build_next_test_selection(
        plan_phase, state, seen, questions_by_id,
        test_plan.get("v2_by_base", {}), test_plan.get("v3_by_base", {}),
        v3q, global_test_num, concept_rank=concept_rank, rng=random)

    if not selected:
        raise ValueError(f"No questions available for {phase_name} test.")
    return selected, phase_name, plan_phase["time_minutes"], is_flex, log_info


def log_test_generation(test_num, phase_name, selected, sel_log, plan, progress):
    """K2 -- every question in this test, why it is here, and pool progress."""
    L = []
    L.append("-" * 78)
    L.append(f"TEST {test_num} GENERATED | phase {phase_name}"
             f"{'  [FLEX]' if sel_log.get('is_flex') else ''}")
    L.append("-" * 78)
    v1m = plan.get("v1_meta", {})
    for i, q in enumerate(selected, 1):
        m = q["meta_data"]
        var = m["variation_number"]
        tag = {1: "v1 fresh", 2: "v2 RETRY", 3: "v3 CHECK"}.get(var, f"v{var}")
        L.append(f"  {i:>2}. {q['question_id']:<38} {tag:<9} "
                 f"{m.get('difficulty',''):<7} {m.get('concept_id','')}")
    d = sel_log.get("difficulty_breakdown", {})
    L.append(f"  mix          : E{d.get('Easy',0)} M{d.get('Medium',0)} H{d.get('Hard',0)}"
             f"  | total {len(selected)}")
    L.append(f"  fresh v1     : {sel_log.get('fresh_v1_used',0)}")
    L.append(f"  owed v2 fired: {sel_log.get('owed_v2_used',0)} {sel_log.get('owed_v2_used_ids',[])}")
    L.append(f"  v2 still queued for next test: {sel_log.get('owed_v2_still_queued',0)}")
    if sel_log.get("owed_v2_dropped"):
        L.append(f"  !! v2 DROPPED (no companion) : {sel_log['owed_v2_dropped']}")
    for c in sel_log.get("v3_checks", []):
        L.append(f"  v3 CHECK     : base {c['base_id']} (recovered at test "
                 f"{c.get('booked_at_test')}, audited now)")
    for d in sel_log.get("v3_checks_dropped", []):
        L.append(f"  v3 audit DROPPED: base {d['base_id']} — {d.get('reason')}")
    L.append(f"  v3 checks queued ahead: {sel_log.get('v3_checks_still_queued',0)}")
    L.append(f"  v1 pool      : {sel_log.get('v1_shown_so_far',0)}/{sel_log.get('v1_total_reserved',0)} shown")
    L.append(f"  concepts here: {len(sel_log.get('concepts_this_test',[]))} "
             f"{sel_log.get('concepts_this_test',[])}")
    cm = progress.get("concept_mastery", {})
    started = sum(1 for c in cm.values() if c.get("status") != "not_started")
    L.append(f"  CONCEPTS COVERED SO FAR: {started}/{len(cm)}")
    print("\n".join(L))


# def get_test_params_dynamic(test_num, test_plan):
#     """Get test parameters based on test number and chapter's test plan."""
#     phases = test_plan["phases"]

#     # Foundation
#     if phases["foundation"]["tests"] > 0 and test_num <= phases["foundation"]["range"][1]:
#         return {
#             "total_questions": 10,
#             "difficulty_mix": {"Easy": 10, "Medium": 0, "Hard": 0},
#             "time_limit_seconds": 8 * 60,
#             "phase": "Foundation",
#             "phase_key": "foundation",
#             "is_mock": False,
#             "is_bonus": False
#         }

#     # Skill Building
#     if phases["skill_building"]["tests"] > 0 and test_num <= phases["skill_building"]["range"][1]:
#         return {
#             "total_questions": 12,
#             "difficulty_mix": {"Easy": 10, "Medium": 2, "Hard": 0},
#             "time_limit_seconds": 10 * 60,
#             "phase": "Skill Building",
#             "phase_key": "skill_building",
#             "is_mock": False,
#             "is_bonus": False
#         }

#     # Mastery
#     if phases["mastery"]["tests"] > 0 and test_num <= phases["mastery"]["range"][1]:
#         return {
#             "total_questions": 15,
#             "difficulty_mix": {"Easy": 6, "Medium": 9, "Hard": 0},
#             "time_limit_seconds": 12 * 60,
#             "phase": "Mastery",
#             "phase_key": "mastery",
#             "is_mock": False,
#             "is_bonus": False
#         }

#     # NEET Simulation
#     if phases["neet_simulation"]["tests"] > 0 and test_num <= phases["neet_simulation"]["range"][1]:
#         return {
#             "total_questions": 18,
#             "difficulty_mix": {"Easy": 4, "Medium": 7, "Hard": 7},
#             "time_limit_seconds": 15 * 60,
#             "phase": "NEET Simulation",
#             "phase_key": "neet_simulation",
#             "is_mock": False,
#             "is_bonus": False
#         }

#     # Bonus Pool
#     if test_num == phases["bonus_pool"]["test_num"]:
#         return {
#             "total_questions": 0,  # Dynamic — calculated at generation time
#             "difficulty_mix": {},  # Dynamic
#             "time_limit_seconds": 0,  # Dynamic — based on question count
#             "phase": "Bonus Pool",
#             "phase_key": "bonus_pool",
#             "is_mock": False,
#             "is_bonus": True
#         }

#     # Grand Mock (last test)
#     if test_num == phases["grand_mock"]["test_num"]:
#         return {
#             "total_questions": 25,
#             "difficulty_mix": {"Easy": 6, "Medium": 13, "Hard": 6},
#             "time_limit_seconds": 20 * 60,
#             "phase": "Grand Mock",
#             "phase_key": "grand_mock",
#             "is_mock": True,
#             "is_bonus": False
#         }

#     # Fallback (shouldn't reach here)
#     return {
#         "total_questions": 15,
#         "difficulty_mix": {"Easy": 5, "Medium": 5, "Hard": 5},
#         "time_limit_seconds": 12 * 60,
#         "phase": "Practice",
#         "phase_key": "practice",
#         "is_mock": False,
#         "is_bonus": False
#     }


# ──────────────────────────────────────────────
# HELPER FUNCTIONS
# ──────────────────────────────────────────────

def get_user_doc(uid):
    """Get user document from Firestore."""
    doc = db.collection("users").document(uid).get()
    return doc.to_dict() if doc.exists else None


def get_or_create_progress(uid, chapter_id):
    """Get or create user_progress document for a chapter."""
    doc_id = f"{uid}_{chapter_id}"
    doc_ref = db.collection("user_progress").document(doc_id)
    doc = doc_ref.get()
    
    if doc.exists:
        return doc.to_dict()
    
    # Get chapter metadata
    meta_doc = db.collection("chapter_metadata").document(chapter_id).get()
    if not meta_doc.exists:
        raise Exception(f"Chapter {chapter_id} not found")
    
    chapter_meta = meta_doc.to_dict()
    concepts = chapter_meta.get("concepts_summary", [])
    
    # Calculate the chapter-level plan (which exact question IDs belong to
    # which phase). Needs the FULL question list now, not just counts, since
    # phases reserve specific IDs, not just difficulty totals.
    all_q_docs = db.collection("questions") \
        .where("meta_data.chapter_id", "==", chapter_id) \
        .stream()
    all_q_list = [q.to_dict() for q in all_q_docs]

    # Sanity-check log only -- doesn't feed the plan anymore
    q_meta = count_regular_questions_by_difficulty(all_q_list)
    print(f"📊 Chapter {chapter_id} question pool: {q_meta}")

    test_plan = calculate_dynamic_test_plan(all_q_list, concepts)

    # Per-student state: which phase they're on, tests taken per phase, and
    # their personal remediation queue. Separate from test_plan (which is
    # the same for every student).
    # fresh_phase_state() seeds Foundation=active and includes Grand Mock and
    # Endurance, so the two hand-written follow-up lines that used to live here
    # (and that silently omitted Endurance) are gone.
    phase_state = _E.fresh_phase_state()

    # Initialize concept mastery
    concept_mastery = {}
    sync_concept_mastery(concept_mastery, concepts)
    
    # Initialize base question tracking (separate collection for clean separation)
    base_tracking_collection = {}
    
    progress = {
        "progress_id": doc_id,
        "user_id": uid,
        "chapter_id": chapter_id,
        "chapter_name": chapter_meta.get("chapter_title", ""),
        
        "tests_completed": 0,
        "test_plan": test_plan,
        "phase_state": phase_state,
        "bonus_pool_eligible": [],  # [{"base_id","reason","phase"}] -- v3-audit failures only
        # Spaced v3 audits: a base whose v2 was CORRECT books its v3 for
        # V3_CHECK_LAG tests later. Global (not per-phase) so an audit booked in
        # Foundation can fire in Skill Building -- crossing a phase boundary is
        # better spacing, and it keeps the band from ever blocking a phase from
        # completing. [{"base_id","due_test","booked_at_test"}]
        "v3_check_queue": [],

        "current_difficulty": "Easy",
        "difficulty_unlock": {
            "easy_unlocked": True,
            "medium_unlocked": False,
            "hard_unlocked": False
        },
        
        "overall_mastery": 0,
        "concept_mastery": concept_mastery,
        
        "seen_question_ids": [],  # All questions seen (v1, v2, v3)
        
        "test_history": [],
        "last_test_date": None,
        
        "next_test_available": True,
        "pending_interventions": [],
        "chapter_fully_complete": False,

        "created_at": firestore.SERVER_TIMESTAMP,
        "updated_at": firestore.SERVER_TIMESTAMP
    }
    
    doc_ref.set(progress)
    return progress


def get_base_tracking(uid, chapter_id, base_question_id):
    """Get or create base question tracking."""
    doc_id = f"{uid}_{chapter_id}_{base_question_id}"
    doc_ref = db.collection("base_question_tracking").document(doc_id)
    doc = doc_ref.get()
    
    if doc.exists:
        return doc.to_dict()
    
    # Create new tracking
    tracking = {
        "tracking_id": doc_id,
        "user_id": uid,
        "chapter_id": chapter_id,
        "base_question_id": base_question_id,
        "concept_id": "",  # Will be set on first encounter
        
        "variation_history": [],
        "consecutive_failures": 0,
        "total_failures": 0,
        "status": "not_seen",
        
        "interventions": [],
        "used_variations": [],
        
        "created_at": firestore.SERVER_TIMESTAMP
    }
    
    doc_ref.set(tracking)
    return tracking


def save_base_tracking(tracking):
    """Save base question tracking."""
    doc_id = tracking["tracking_id"]
    db.collection("base_question_tracking").document(doc_id).set(tracking, merge=True)

def call_ai_diagnosis_sync(uid, concept_id, base_question_id, tracking):
    """
    Synchronous wrapper for AI diagnosis.
    Handles both async and non-async environments.
    """
    if not GEMINI_AVAILABLE:
        return {
            "misconception": "AI diagnosis not available",
            "explanation": "Please review NCERT chapter carefully.",
            "memory_trick": "Practice more questions on this concept."
        }
    
    try:
        import asyncio
        
        # Try to get or create event loop
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # If loop is already running, create a new one
                import nest_asyncio
                nest_asyncio.apply()
                diagnosis = loop.run_until_complete(call_gemini_diagnosis(
                    uid, concept_id, base_question_id, tracking
                ))
            else:
                diagnosis = loop.run_until_complete(call_gemini_diagnosis(
                    uid, concept_id, base_question_id, tracking
                ))
        except RuntimeError:
            # No event loop exists, create new one
            diagnosis = asyncio.run(call_gemini_diagnosis(
                uid, concept_id, base_question_id, tracking
            ))
        
        return diagnosis
    
    except Exception as e:
        print(f"AI diagnosis error: {e}")
        # Fallback
        return {
            "misconception": "Unable to diagnose automatically",
            "explanation": "Please review the concept explanation and examples carefully.",
            "memory_trick": "Focus on understanding the core principle.",
            "error": str(e)
        }

# ════════════════════════════════════════════════════════════════
# DEEPSEEK PROXY  — paste this whole block into backend.py
#
# WHERE: anywhere at top level next to the other @app.route definitions.
#        A good spot is immediately after get_ai_question_for_intervention()
#        ends (just before `def call_ai_question_sync(...)`, ~line 1128),
#        so all the AI-tutor code sits together.
#
# WHY:   so the DeepSeek key lives in the server environment instead of in
#        opd.js, which every device downloads and anyone can read.
#
# DEPENDENCIES: none. Uses urllib from the stdlib, because backend.py does
#        not import `requests` or `httpx` and this must not add a dependency
#        to your deploy.
#
# The frontend calls this through apiCall(), so it arrives with the normal
# Firebase Bearer token and @require_auth works exactly like every other route.
# ════════════════════════════════════════════════════════════════
 
import urllib.request
import urllib.error
 
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
 
# Only these models may be requested. The client cannot ask for anything else.
DEEPSEEK_ALLOWED_MODELS = {"deepseek-chat", "deepseek-reasoner"}
 
 
@app.route("/api/ai/analyse", methods=["POST"])
@require_auth
def ai_analyse_proxy():
    """
    Thin, locked-down proxy to DeepSeek for the OPD intervention tutor.
 
    The client sends {model, messages, temperature, max_tokens, response_format}
    and gets DeepSeek's response JSON back unchanged, so opd.js can keep reading
    data.choices[0].message.content.
 
    This is deliberately NOT a general-purpose relay:
      - requires a valid Firebase token (@require_auth)
      - model must be in DEEPSEEK_ALLOWED_MODELS
      - max_tokens and message size are capped server-side
      - only role/content are forwarded; nothing else is passed through
    """
    api_key = os.environ.get("DEEPSEEK_API_KEY", "")
    if not api_key:
        # 503, not 500: the frontend treats any failure as "DeepSeek unavailable"
        # and falls back to Gemini -> derived -> generic, which is correct here.
        return jsonify({"error": "DeepSeek not configured"}), 503
 
    data = request.json or {}
    messages = data.get("messages", [])
 
    if not isinstance(messages, list) or not messages:
        return jsonify({"error": "messages required"}), 400
    if len(messages) > 8:
        return jsonify({"error": "too many messages"}), 400
 
    # Rebuild the messages ourselves — never forward the client's dict verbatim.
    clean_messages = []
    total_chars = 0
    for m in messages:
        if not isinstance(m, dict):
            return jsonify({"error": "bad message"}), 400
        role = m.get("role")
        content = m.get("content", "")
        if role not in ("system", "user", "assistant"):
            return jsonify({"error": "bad role"}), 400
        if not isinstance(content, str):
            return jsonify({"error": "bad content"}), 400
        total_chars += len(content)
        clean_messages.append({"role": role, "content": content})
 
    if total_chars > 24000:
        return jsonify({"error": "prompt too long"}), 413
 
    model = data.get("model", "deepseek-chat")
    if model not in DEEPSEEK_ALLOWED_MODELS:
        model = "deepseek-chat"
 
    try:
        max_tokens = min(int(data.get("max_tokens", 900)), 1500)
    except (TypeError, ValueError):
        max_tokens = 900
    try:
        temperature = max(0.0, min(float(data.get("temperature", 0.3)), 1.5))
    except (TypeError, ValueError):
        temperature = 0.3
 
    payload = {
        "model": model,
        "messages": clean_messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    # Pass response_format through only when it's the JSON-object mode opd.js asks for.
    rf = data.get("response_format")
    if isinstance(rf, dict) and rf.get("type") == "json_object":
        payload["response_format"] = {"type": "json_object"}
 
    req = urllib.request.Request(
        DEEPSEEK_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
 
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8")
        print(f"✅ DeepSeek analysis for {request.uid} ({model}, {total_chars} chars in)")
        # Return DeepSeek's JSON untouched — opd.js reads choices[0].message.content.
        return app.response_class(body, mimetype="application/json")
 
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:400]
        print(f"❌ DeepSeek HTTP {e.code}: {detail}")
        return jsonify({"error": f"DeepSeek returned {e.code}"}), 502
    except Exception as e:
        print(f"❌ DeepSeek call failed: {e}")
        return jsonify({"error": "DeepSeek unreachable"}), 502


@app.route("/api/intervention/get-ai-question", methods=["POST"])
@require_auth
def get_ai_question_for_intervention():
    """
    Get AI-generated question for intervention.
    Uses Gemini if API key is configured, otherwise uses a structured
    fallback that pulls from existing question bank.
    """
    uid = request.uid
    data = request.json

    concept_id = data.get("concept_id")
    diagnosis = data.get("diagnosis", {})
    chapter_id = data.get("chapter_id", "")

    # Try Gemini first if available and key is set
    if GEMINI_AVAILABLE and os.environ.get("GEMINI_API_KEY", ""):
        try:
            import asyncio
            ai_question = asyncio.run(call_gemini_generate_question(uid, concept_id, diagnosis))
            if ai_question:
                return jsonify({"ai_question": ai_question, "source": "gemini"})
        except Exception as e:
            print(f"Gemini failed, using fallback: {e}")

    # Fallback: pull an unseen question from the existing question bank for this concept
    # This avoids needing Gemini at all
    try:
        progress_doc = db.collection("user_progress") \
            .document(f"{uid}_{concept_id.split('_')[0] if '_' in concept_id else ''}") \
            .get()

        seen_ids = set()
        if progress_doc.exists:
            seen_ids = set(progress_doc.to_dict().get("seen_question_ids", []))

        # Find any unseen question for this concept across all variations
        available = db.collection("questions") \
            .where("meta_data.concept_id", "==", concept_id) \
            .stream()

        fallback_q = None
        for doc in available:
            q = doc.to_dict()
            if q["question_id"] not in seen_ids:
                fallback_q = q
                break

        if fallback_q:
            # Return it in AI question format (strip explanations so student answers blind)
            ai_question = {
                "question_text": fallback_q["content"]["question_text"],
                "options": [
                    {
                        "id": opt["id"],
                        "text": opt["text"],
                        "is_correct": opt.get("is_correct", False)
                    }
                    for opt in fallback_q["content"]["options"]
                ],
                "source": "question_bank_fallback"
            }
            return jsonify({"ai_question": ai_question, "source": "fallback"})

    except Exception as e:
        print(f"Fallback question fetch failed: {e}")

    # Last resort: return a conceptual review question built from diagnosis
    misconception = diagnosis.get("misconception", "this concept")
    fallback_question = {
        "question_text": f"Based on the explanation above, which statement correctly describes {concept_id.replace('_', ' ')}?",
        "options": [
            {"id": "A", "text": diagnosis.get("explanation", "The correct understanding as explained above"), "is_correct": True},
            {"id": "B", "text": f"The opposite of what was explained about {concept_id.replace('_', ' ')}", "is_correct": False},
            {"id": "C", "text": "None of the above statements are accurate", "is_correct": False},
            {"id": "D", "text": misconception if misconception != "this concept" else "A common misconception about this topic", "is_correct": False}
        ],
        "source": "generated_fallback"
    }

    return jsonify({"ai_question": fallback_question, "source": "last_resort"})

def call_ai_question_sync(uid, concept_id, diagnosis):
    """
    Synchronous wrapper for AI question generation.
    """
    if not GEMINI_AVAILABLE:
        return None
    
    try:
        import asyncio
        
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                import nest_asyncio
                nest_asyncio.apply()
                question = loop.run_until_complete(call_gemini_generate_question(
                    uid, concept_id, diagnosis
                ))
            else:
                question = loop.run_until_complete(call_gemini_generate_question(
                    uid, concept_id, diagnosis
                ))
        except RuntimeError:
            question = asyncio.run(call_gemini_generate_question(
                uid, concept_id, diagnosis
            ))
        
        return question
    
    except Exception as e:
        print(f"AI question generation error: {e}")
        return None

def calculate_mastery_score(correct, total):
    """Calculate mastery percentage."""
    if total == 0:
        return 0
    return round((correct / total) * 100)


def get_concepts_needing_retry(progress):
    """Get concepts that need retry (1 recent failure at concept level)."""
    retry_concepts = []
    
    for concept_id, data in progress.get("concept_mastery", {}).items():
        if data.get("needs_retry") and data.get("consecutive_concept_failures", 0) == 1:
            retry_concepts.append(concept_id)
    
    return retry_concepts


def select_balanced_by_concept(questions, count, concept_exposure):
    """Select questions balanced across concepts."""
    # Sort concepts by exposure (least first)
    sorted_concepts = sorted(
        concept_exposure.items(),
        key=lambda x: x[1]
    )
    
    selected = []
    used_concepts = set()
    
    # First pass: one from each concept
    for concept_id, _ in sorted_concepts:
        if len(selected) >= count:
            break
        
        # Find questions from this concept
        concept_questions = [q for q in questions if q["meta_data"]["concept_id"] == concept_id]
        
        if concept_questions and concept_id not in used_concepts:
            selected.append(random.choice(concept_questions))
            used_concepts.add(concept_id)
            questions.remove(selected[-1])
    
    # Second pass: fill remaining
    while len(selected) < count and questions:
        selected.append(random.choice(questions))
        questions.remove(selected[-1])
    
    return selected


# ──────────────────────────────────────────────
# INTERVENTION LOGIC
# ──────────────────────────────────────────────

def count_consecutive_failures_base(tracking):
    """Count consecutive failures for THIS base question.
    Only counts non-retake entries (is_retake: False or missing).
    Retake attempts do not count toward intervention triggering.
    """
    consecutive = 0
    
    for entry in reversed(tracking["variation_history"]):
        # Skip retake entries — they don't count toward intervention
        if entry.get("is_retake", False):
            continue
        if entry["result"] == "wrong":
            consecutive += 1
        else:
            break
    
    return consecutive


def determine_intervention(tracking, test_num, is_retest=False):
    """
    Determine if intervention needed for this base question.
    Rule: 2nd consecutive failure triggers intervention.
    On retest: only v3 explanation, no AI intervention.
    AI intervention limited to once per base question.
    """
    consecutive = count_consecutive_failures_base(tracking)

    if consecutive < 2:
        return None

    # Check if v3 available
    used = tracking.get("used_variations", [])
    ai_already_used = tracking.get("ai_intervention_used", False)

    if "v3" not in used:
        base_id = tracking["base_question_id"]
        v3_question_id = f"{base_id}_v3"
        v3_doc = db.collection("questions").document(v3_question_id).get()

        if v3_doc.exists:
            v3_question = v3_doc.to_dict()

            if v3_question["meta_data"].get("pool") == "intervention_reserve":
                return {
                    "type": "standard_intervention",
                    "trigger": "second_consecutive_failure",
                    "base_question_id": base_id,
                    "concept_id": tracking["concept_id"],
                    "v3_question": v3_question,
                    "test_num": test_num,
                    "is_retest": is_retest
                }

    # No v3 available or v3 already used
    if is_retest:
        # On retest: show v3 explanation only, NO AI intervention
        return {
            "type": "retest_review_only",
            "trigger": "retest_no_ai",
            "base_question_id": tracking["base_question_id"],
            "concept_id": tracking["concept_id"],
            "test_num": test_num,
            "is_retest": True
        }

    if ai_already_used:
        # AI already used once for this base question — just show review
        return {
            "type": "review_only_ai_exhausted",
            "trigger": "ai_already_used",
            "base_question_id": tracking["base_question_id"],
            "concept_id": tracking["concept_id"],
            "test_num": test_num,
            "is_retest": is_retest
        }

    # First time AI intervention
    return {
        "type": "ai_intervention_no_v3",
        "trigger": "second_consecutive_failure_no_v3",
        "base_question_id": tracking["base_question_id"],
        "concept_id": tracking["concept_id"],
        "test_num": test_num,
        "is_retest": is_retest
    }


async def call_gemini_diagnosis(uid, concept_id, base_question_id, tracking):
    """Call Gemini Flash for AI diagnosis."""
    if not GEMINI_AVAILABLE:
        return {
            "misconception": "AI diagnosis not available",
            "explanation": "Please review NCERT",
            "memory_trick": "Practice more questions"
        }
    
    # Build failure context
    failed_variations = [
        v for v in tracking["variation_history"]
        if v["result"] == "wrong"
    ]
    
    # Detect regression
    previous_correct = [
        v for v in tracking["variation_history"]
        if v["result"] == "correct"
    ]
    
    is_regression = len(previous_correct) >= 2
    
    prompt = f"""You are an expert NEET Biology tutor.

Student struggling with concept: {concept_id}
Base Question: {base_question_id}

FAILURE HISTORY:
{json.dumps(failed_variations, indent=2)}

{"REGRESSION DETECTED: Student previously understood this (got it right multiple times) but is now struggling." if is_regression else "Student has consistently struggled with this concept."}

Your Task:
1. Identify the SPECIFIC misconception
2. {"Explain why they're confused NOW despite understanding before" if is_regression else "Explain the concept clearly"}
3. Provide a memorable mnemonic

Respond in JSON format:
{{
    "misconception": "Brief description of confusion",
    "explanation": "Clear 2-3 sentence explanation",
    "memory_trick": "Mnemonic or analogy (1 sentence)",
    {"regression_analysis": "Why regression occurred"" if is_regression else ""}
}}
"""

    try:
        model = genai.GenerativeModel('gemini-1.5-flash')
        response = model.generate_content(prompt)
        diagnosis = json.loads(response.text)
        
        # Log for cost tracking
        db.collection("ai_interventions").add({
            "user_id": uid,
            "concept_id": concept_id,
            "base_question_id": base_question_id,
            "type": "diagnosis",
            "is_regression": is_regression,
            "diagnosis": diagnosis,
            "api_cost": 0.05,
            "timestamp": firestore.SERVER_TIMESTAMP
        })
        
        return diagnosis
    
    except Exception as e:
        print(f"Gemini API error: {e}")
        return {
            "misconception": "Unable to diagnose automatically",
            "explanation": "Please review the concept explanation carefully",
            "memory_trick": "Practice with more examples"
        }


async def call_gemini_generate_question(uid, concept_id, diagnosis):
    """
    Generate custom verification question.
    FIX: Includes history of previously asked questions to prevent repetition.
    """
    if not GEMINI_AVAILABLE:
        return None
    
    # ── FIX 6: Get history of previous AI questions for this concept ──
    previous_questions = []
    try:
        ai_history = db.collection("ai_interventions") \
            .where("user_id", "==", uid) \
            .where("concept_id", "==", concept_id) \
            .where("type", "==", "question_generation") \
            .stream()
        
        for doc in ai_history:
            entry = doc.to_dict()
            q = entry.get("question", {})
            if q.get("question_text"):
                previous_questions.append(q["question_text"][:100])  # First 100 chars
    except Exception as e:
        print(f"Warning: Could not fetch AI question history: {e}")
    
    # Also get v3 questions the student has seen for this concept
    seen_v3_texts = []
    try:
        # Get all base questions for this concept
        concept_questions = db.collection("questions") \
            .where("meta_data.concept_id", "==", concept_id) \
            .where("meta_data.variation_number", "==", 3) \
            .stream()
        
        for doc in concept_questions:
            q = doc.to_dict()
            qt = q.get("content", {}).get("question_text", "")
            if qt:
                seen_v3_texts.append(qt[:100])
    except Exception:
        pass

    # Build exclusion list
    exclusion_block = ""
    all_seen = previous_questions + seen_v3_texts
    if all_seen:
        exclusion_block = f"""
CRITICAL — DO NOT generate questions similar to any of these previously asked questions:
{chr(10).join(f'- "{q}"' for q in all_seen[-10:])}

Your question MUST be substantially different in:
1. The specific fact being tested
2. The scenario/framing
3. The correct answer option
"""

    prompt = f"""Based on this diagnosis:

{json.dumps(diagnosis, indent=2)}

Generate 1 NEET-style MCQ that tests if student understood the correction.

Requirements:
- DIFFERENT from standard questions
- Addresses the misconception directly
- 4 options (A, B, C, D)
- Test a DIFFERENT aspect of the concept than before

{exclusion_block}

Respond in JSON:
{{
    "question_text": "Question (2-3 lines)",
    "options": [
        {{"id": "A", "text": "...", "is_correct": false, "explanation": "why wrong"}},
        {{"id": "B", "text": "...", "is_correct": true, "explanation": "why correct"}},
        {{"id": "C", "text": "...", "is_correct": false, "explanation": "why wrong"}},
        {{"id": "D", "text": "...", "is_correct": false, "explanation": "why wrong"}}
    ]
}}
"""

    try:
        model = genai.GenerativeModel('gemini-1.5-flash')
        response = model.generate_content(prompt)
        
        # Clean response
        response_text = response.text.strip()
        if response_text.startswith("```json"):
            response_text = response_text[7:]
        if response_text.startswith("```"):
            response_text = response_text[3:]
        if response_text.endswith("```"):
            response_text = response_text[:-3]
        
        custom_question = json.loads(response_text.strip())
        
        # Log
        db.collection("ai_interventions").add({
            "user_id": uid,
            "concept_id": concept_id,
            "type": "question_generation",
            "question": custom_question,
            "api_cost": 0.05,
            "timestamp": firestore.SERVER_TIMESTAMP
        })
        
        return custom_question
    
    except Exception as e:
        print(f"Gemini API error: {e}")
        return None


# ──────────────────────────────────────────────
# API ROUTES
# ──────────────────────────────────────────────

# ---- STATIC FILES ----
@app.route("/")
def serve_app():
    return send_from_directory("mobile", "app.html")

@app.route("/static/<path:path>")
def serve_static(path):
    return send_from_directory("static", path)


# ---- USER / AUTH ----
@app.route("/api/user/profile", methods=["GET"])
@require_auth
def get_profile():
    """Get current user profile."""
    user = get_user_doc(request.uid)
    if not user:
        return jsonify({"error": "User not found"}), 404
    return jsonify(user)


@app.route("/api/user/register", methods=["POST"])
@require_auth
def register_user():
    """Register/update user profile after signup."""
    data = request.json
    user_doc = {
        "uid": request.uid,
        "email": request.user_email,
        "name": data.get("name", ""),
        "role": data.get("role", "student"),
        "class_level": data.get("class_level", "12"),
        "target_exam": data.get("target_exam", "NEET 2026"),
        "subscription": {
            "plan": "free",
            "expiry": None,
            "subjects_unlocked": []
        },
        "free_chapters": [
            "the_living_world",
            "biological_classification"
        ],
        "created_at": firestore.SERVER_TIMESTAMP,
        "updated_at": firestore.SERVER_TIMESTAMP
    }
    
    db.collection("users").document(request.uid).set(user_doc, merge=True)
    return jsonify({"status": "ok", "user": user_doc})


# ---- DASHBOARD ----
@app.route("/api/dashboard", methods=["GET"])
@require_auth
def get_dashboard():
    """Get dashboard with insights and AI recommendations."""
    uid = request.uid
    
    print(f"🎯 Dashboard requested for user: {uid}")
    
    try:
        user = get_user_doc(uid)
        
        # Auto-register if user doesn't exist
        if not user:
            print(f"⚠️ User not found, auto-registering: {uid}")
            user_doc = {
                "uid": uid,
                "email": request.user_email,
                "name": request.user_email.split('@')[0] if request.user_email else "Student",
                "role": "student",
                "class_level": "11",
                "target_exam": "NEET 2026",
                "subscription": {
                    "plan": "free",
                    "expiry": None,
                    "subjects_unlocked": []
                },
                "free_chapters": [
                    "the_living_world",
                    "biological_classification"
                ],
                "created_at": firestore.SERVER_TIMESTAMP,
                "updated_at": firestore.SERVER_TIMESTAMP
            }
            db.collection("users").document(uid).set(user_doc)
            user = user_doc
            print(f"✅ User auto-registered: {user['name']}")
        
        # Get all progress
        progress_docs = db.collection("user_progress") \
            .where("user_id", "==", uid) \
            .stream()
        
        chapters_progress = []
        total_tests = 0
        total_questions_attempted = 0
        total_correct = 0
        weak_concepts = []
        strong_concepts = []
        recent_tests = []
        ai_interventions_count = 0
        
        for doc in progress_docs:
            p = doc.to_dict()
            chapter_id = p.get("chapter_id", "")
            tests_done = p.get("tests_completed", 0)
            overall = p.get("overall_mastery", 0)
            
            total_tests += tests_done
            
            # Concept analysis
            for cid, cdata in p.get("concept_mastery", {}).items():
                seen = len(cdata.get("questions_seen", []))
                correct = len(cdata.get("questions_correct", []))
                total_questions_attempted += seen
                total_correct += correct
                
                mastery = cdata.get("mastery_score", 0)
                status = cdata.get("status", "not_started")
                
                if mastery < 50:
                    weak_concepts.append({
                        "concept_id": cid,
                        "concept_name": cdata.get("concept_name", cid),
                        "chapter_id": chapter_id,
                        "chapter_name": p.get("chapter_name", ""),
                        "mastery": mastery,
                        "status": status,
                        "needs_retry": cdata.get("needs_retry", False)
                    })
                elif mastery >= 80:
                    strong_concepts.append({
                        "concept_id": cid,
                        "concept_name": cdata.get("concept_name", cid),
                        "mastery": mastery
                    })
            
            # Recent tests
            for t in p.get("test_history", [])[-3:]:
                recent_tests.append({
                    "chapter_id": chapter_id,
                    "chapter_name": p.get("chapter_name", ""),
                    "test_num": t.get("test_num"),
                    "score": t.get("score"),
                    "total": t.get("total"),
                    "percentage": t.get("percentage"),
                    "completed_at": t.get("completed_at")
                })
            
            chapters_progress.append({
                "chapter_id": chapter_id,
                "chapter_name": p.get("chapter_name", ""),
                "tests_completed": tests_done,
                "total_tests": p.get("total_tests", 18),
                "overall_mastery": overall,
                "current_difficulty": p.get("current_difficulty", "Easy"),
                "next_test_available": p.get("next_test_available", True),
                "pending_interventions": len(p.get("pending_interventions", []))
            })
        
        # Count AI interventions
        ai_count = db.collection("ai_interventions") \
            .where("user_id", "==", uid) \
            .stream()
        ai_interventions_count = sum(1 for _ in ai_count)
        
        # Sort
        recent_tests.sort(key=lambda x: x.get("completed_at", "") or "", reverse=True)
        weak_concepts.sort(key=lambda x: x["mastery"])
        
        overall_accuracy = calculate_mastery_score(total_correct, total_questions_attempted)
        
        # AI Insights
        insights = []
        if weak_concepts:
            insights.append({
                "type": "warning",
                "message": f"⚠️ {len(weak_concepts)} concepts need attention. Focus on {weak_concepts[0]['concept_name']}."
            })
        if overall_accuracy >= 85:
            insights.append({
                "type": "success",
                "message": f"🎉 Excellent! {overall_accuracy}% overall accuracy. Keep it up!"
            })
        if ai_interventions_count > 0:
            insights.append({
                "type": "info",
                "message": f"🤖 AI Tutor helped you {ai_interventions_count} times. Review those concepts."
            })
        
        dashboard = {
            "user": {
                "name": user.get("name", "Student"),
                "class_level": user.get("class_level", ""),
                "plan": user.get("subscription", {}).get("plan", "free"),
                "target_exam": user.get("target_exam", "")
            },
            "stats": {
                "total_tests_completed": total_tests,
                "total_questions_attempted": total_questions_attempted,
                "overall_accuracy": overall_accuracy,
                "chapters_in_progress": len(chapters_progress),
                "concepts_mastered": len(strong_concepts),
                "concepts_struggling": len(weak_concepts),
                "ai_interventions": ai_interventions_count
            },
            "chapters_progress": chapters_progress,
            "weak_concepts": weak_concepts[:10],
            "strong_concepts": strong_concepts[:10],
            "recent_tests": recent_tests[:5],
            "insights": insights
        }
        
        print(f"✅ Dashboard generated successfully")
        return jsonify(dashboard)
        
    except Exception as e:
        print(f"❌ Dashboard error: {type(e).__name__}: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({
            "error": f"Dashboard error: {str(e)}",
            "type": type(e).__name__
        }), 500


def validate_test_unlock(test_number, user_progress, test_history):
    """
    Validate that the student is allowed to take this test.
    Uses BOTH progress flag AND direct score check from test_history.
    """
    # Test 1 is always allowed
    if test_number <= 1:
        return True, None
    
    # --- Check 1: Direct score validation from test_history ---
    if test_history:
        prev_test_num = test_number - 1
        
        # Get ALL attempts for the previous test (could have retakes)
        prev_attempts = [
            t for t in test_history
            if t.get("test_num") == prev_test_num  # ← FIXED: was "test_number"
        ]
        
        if prev_attempts:
            latest_attempt = max(
                prev_attempts,
                key=lambda t: t.get("submitted_at", t.get("completed_at", ""))
            )
            
            latest_score = latest_attempt.get("percentage", 0)
            
            if latest_score < PASS_THRESHOLD:
                return False, (
                    f"Test {prev_test_num} score is {latest_score:.0f}% "
                    f"(need {PASS_THRESHOLD}% to unlock Test {test_number}). "
                    f"Please retake Test {prev_test_num}."
                )
    
    # --- Check 2: Progress flag (secondary/backup check) ---
    next_test_available = user_progress.get("next_test_available", True)
    
    if not next_test_available:
        pending = user_progress.get("pending_interventions", [])
        if pending:
            return False, (
                f"Complete pending interventions before starting Test {test_number}."
            )
        # Reaching here now means a genuine score lock. It used to also catch
        # "you finished the chapter", which is why finishing the Grand Mock
        # locked the student out of the Bonus Pool with a message telling them
        # to retake a test they had already passed.
        last_pct = None
        if test_history:
            last = max(test_history, key=lambda t: t.get("completed_at", ""))
            last_pct = last.get("percentage")
        return False, (
            f"Test {test_number} is locked: your last test scored "
            f"{last_pct if last_pct is not None else 'below'}% "
            f"(need {PASS_THRESHOLD}%). Please retake it."
        )
    
    return True, None

# ---- CHAPTERS ----
@app.route("/api/chapters/<subject>/<class_level>", methods=["GET"])
@require_auth
def get_chapters(subject, class_level):
    """Get list of chapters."""
    uid = request.uid
    user = get_user_doc(uid)
    
    docs = db.collection("chapter_metadata") \
        .where("subject", "==", subject.capitalize()) \
        .where("class", "==", str(class_level)) \
        .stream()
    
    chapters = []
    free_chapters = user.get("free_chapters", []) if user else []
    plan = user.get("subscription", {}).get("plan", "free") if user else "free"
    
    for doc in docs:
        ch = doc.to_dict()
        chapter_id = ch.get("chapter_id", doc.id)
        
        is_free = True if DEV_UNLOCK_ALL_CHAPTERS else (chapter_id in free_chapters)
        is_unlocked = True if DEV_UNLOCK_ALL_CHAPTERS else ((plan == "full_neet") or is_free)
        
        # Get progress
        prog_doc = db.collection("user_progress") \
            .document(f"{uid}_{chapter_id}").get()
        
        progress = None
        if prog_doc.exists:
            p = prog_doc.to_dict()
            progress = {
                "tests_completed": p.get("tests_completed", 0),
                "total_tests": p.get("total_tests", 18),
                "overall_mastery": p.get("overall_mastery", 0),
                "current_difficulty": p.get("current_difficulty", "Easy")
            }
        
        chapters.append({
            "chapter_id": chapter_id,
            "chapter_title": ch.get("chapter_title", ""),
            "chapter_number": ch.get("chapter_number", 0),
            "total_concepts": ch.get("total_concepts", 0),
            "total_questions": ch.get("total_questions", 0),
            "is_free": is_free,
            "is_unlocked": is_unlocked,
            "progress": progress
        })
    
    chapters.sort(key=lambda x: x.get("chapter_number", 0))
    return jsonify(chapters)


# ---- CHAPTER DETAIL WITH INSIGHTS ----
@app.route("/api/chapter/<chapter_id>", methods=["GET"])
@require_auth
def get_chapter_detail(chapter_id):
    """Get detailed chapter info with AI insights."""
    uid = request.uid

    print(f"📖 Chapter detail requested: {chapter_id} for user: {uid}")

    try:
        meta_doc = db.collection("chapter_metadata").document(chapter_id).get()
        if not meta_doc.exists:
            print(f"❌ Chapter not found: {chapter_id}")
            return jsonify({"error": "Chapter not found"}), 404

        meta = meta_doc.to_dict()
        progress = get_or_create_progress(uid, chapter_id)

        meta_clean = clean_firestore_data(meta)
        progress_clean = clean_firestore_data(progress)

        concept_mastery = progress_clean.get("concept_mastery", {})
        total_concepts = len(concept_mastery)
        mastered = sum(1 for c in concept_mastery.values() if c.get("mastery_score", 0) >= 80)
        struggling = sum(1 for c in concept_mastery.values() if c.get("mastery_score", 0) < 50)

        easy_mastered = sum(1 for c in concept_mastery.values() if c.get("mastery_score", 0) >= 80)
        easy_pct = (easy_mastered / total_concepts * 100) if total_concepts > 0 else 0

        medium_ready = easy_pct >= 85

        insights = {
            "mastered_concepts": mastered,
            "struggling_concepts": struggling,
            "easy_mastery_percentage": round(easy_pct),
            "medium_ready": medium_ready,
            "recommendation": ""
        }

        if struggling > 0:
            insights["recommendation"] = f"⚠️ {struggling} concepts need attention. Review before proceeding."
        elif medium_ready and progress_clean.get("current_difficulty") == "Easy":
            insights["recommendation"] = "🎖️ You're ready for Medium difficulty! Complete 1-2 more tests to unlock."
        else:
            insights["recommendation"] = "✅ Great progress! Keep practicing."

        test_plan = progress_clean.get("test_plan", {})
        next_test_num = progress_clean.get("tests_completed", 0) + 1
        phase_state = progress_clean.get("phase_state", {})

        # Phase is now STATE-driven (which phase isn't complete yet for this
        # student), not a fixed test-number range -- since test counts per
        # phase vary per student based on their mistake history.
        phase_name_next = get_active_phase(test_plan, phase_state)

        if phase_name_next == ENDURANCE:
            eligible = progress_clean.get("bonus_pool_eligible", [])
            total_per_test = min(len(eligible), 25)
            time_minutes = max(10, min(25, total_per_test)) if total_per_test > 0 else 10
            mix = {}
        elif phase_name_next == "Grand Mock":
            gm_cfg = test_plan.get("phases", {}).get("Grand Mock", {})
            total_per_test = gm_cfg.get("q_per_test", 25)
            time_minutes = gm_cfg.get("time_minutes", 20)
            mix = gm_cfg.get("ratios", {})
        else:
            cfg = test_plan.get("phases", {}).get(phase_name_next, {})
            total_per_test = cfg.get("q_per_test", 0)
            time_minutes = cfg.get("time_minutes", 0)
            mix = cfg.get("ratios", {})

        test_params = {
            "phase": phase_name_next or "Complete",
            "total_per_test": total_per_test,
            "time_minutes": time_minutes,
            "mix": mix,
            "is_mock": phase_name_next == "Grand Mock",
            "is_bonus": phase_name_next == ENDURANCE,
        }

        # Check if last test was failed (score lock)
        test_history = progress_clean.get("test_history", [])
        last_test = test_history[-1] if test_history else None
        # PASS_THRESHOLD = 40
        last_test_failed = last_test and last_test.get("percentage", 100) < PASS_THRESHOLD

        # Determine locked reason for frontend
        locked_reason = None
        next_test_available = progress_clean.get("next_test_available", True)
        pending_interventions = progress_clean.get("pending_interventions", [])

        if pending_interventions:
            locked_reason = "Complete concept reviews first"
        elif last_test_failed and not next_test_available:
            locked_reason = f"Score {last_test.get('percentage', 0)}% is below {PASS_THRESHOLD}%. Retake test {last_test.get('test_num')} to continue."

        # Compact per-phase progress summary (min/max tests + status) for
        # the frontend to pre-render the guaranteed number of test icons
        # per phase upfront, instead of only showing icons for tests that
        # have already been taken. This is intentionally small (no reserved
        # question IDs, no v2/v3 maps) -- just enough for the UI to know
        # how many slots each phase guarantees and how many are used.
        phase_progress = {}
        for pname in PHASE_ORDER + ["Grand Mock"]:
            cfg = test_plan.get("phases", {}).get(pname, {})
            pstate = phase_state.get(pname, {})
            phase_progress[pname] = {
                "min_tests": cfg.get("min_tests", 0),
                "max_tests": 0,  # deleted from the engine; kept in the payload
                                 # shape so the frontend contract is unchanged
                "tests_taken": pstate.get("tests_taken", 0),
                "status": pstate.get("status", "not_started"),
            }

        print(f"✅ Chapter detail generated successfully")

        return jsonify({
            "chapter": meta_clean,
            "progress": progress_clean,
            "insights": insights,
            "next_test_num": next_test_num,
            "test_params": test_params,
            "phase_progress": phase_progress,
            "next_test_available": next_test_available,
            "locked_reason": locked_reason,
            "last_test_failed": last_test_failed,
            "pass_threshold": PASS_THRESHOLD
        })

    except Exception as e:
        print(f"❌ Chapter detail error: {type(e).__name__}: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({
            "error": f"Error loading chapter: {str(e)}",
            "type": type(e).__name__
        }), 500


def get_retake_session_question_ids(uid, chapter_id):
    """
    Get question IDs from any in_progress retake sessions.
    This prevents the race condition where retake questions could be
    selected for another test if two tabs are open.
    """
    retake_qids = set()
    try:
        retake_sessions = db.collection("test_sessions") \
            .where("user_id", "==", uid) \
            .where("chapter_id", "==", chapter_id) \
            .where("status", "==", "in_progress") \
            .where("is_retake", "==", True) \
            .stream()

        for sess_doc in retake_sessions:
            sess = sess_doc.to_dict()
            for q in sess.get("questions", []):
                retake_qids.add(q["question_id"])
    except Exception as e:
        print(f"Warning: Could not check retake sessions: {e}")

    return retake_qids




# ---- TEST GENERATION (v1+v2 ONLY) ----
def resolve_qgen_image_url(chapter_id, filename):
    """Build a public Firebase Storage URL for a qgen-pipeline image from its
    bare filename. Mirrors the existing pyq_images pattern (_resolve_opt_img)
    but for the qgen_images/{chapter_id}/ folder, where every file in the
    chapter's images folder was uploaded as-is with no renaming."""
    if not filename:
        return None
    if filename.startswith("http"):
        return filename
    import urllib.parse
    encoded_file = urllib.parse.quote(filename, safe="")
    encoded_chapter = urllib.parse.quote(chapter_id, safe="")
    return (
        f"https://firebasestorage.googleapis.com/v0/b/naadi-ai-ec3ed.firebasestorage.app"
        f"/o/qgen_images%2F{encoded_chapter}%2F{encoded_file}?alt=media"
    )


def build_frontend_options(options, chapter_id):
    """Student-facing option list for an active test — id/text/image only.
    Never includes is_correct, why_wrong_explanation, or any answer-revealing
    field; those only get sent back after submission."""
    result = []
    for opt in options:
        entry = {"id": opt.get("id"), "text": opt.get("text", "")}
        if opt.get("has_image"):
            entry["image_url"] = resolve_qgen_image_url(chapter_id, opt.get("image_file", ""))
        result.append(entry)
    return result


def enrich_options_detail(options, chapter_id):
    """Server-side full option list (with is_correct + explanations) used in
    the session record for grading and later shown on the results page."""
    enriched = []
    for opt in options:
        o = dict(opt)
        if o.get("has_image"):
            o["image_url"] = resolve_qgen_image_url(chapter_id, o.get("image_file", ""))
        enriched.append(o)
    return enriched


@app.route("/api/test/generate", methods=["POST"])
@require_auth
def generate_test():
    """
    Generate the student's next test.

    Phase is now STATE-driven (get_active_phase), not test-number-driven --
    a given absolute test_num can be a different phase for different
    students depending on how many flex/remediation tests they've needed.
    Question selection is queue-aware (build_next_test_selection): owed v2s
    from this student's remediation queue go first, then fresh v1s.
    """
    uid = request.uid
    data = request.json
    chapter_id = data.get("chapter_id")

    if not chapter_id:
        return jsonify({"error": "chapter_id required"}), 400

    progress = get_or_create_progress(uid, chapter_id)
    test_num = progress.get("tests_completed", 0) + 1
    test_history = progress.get("test_history", [])

    # ── Score lock validation (unchanged) ──
    is_allowed, error_msg = validate_test_unlock(test_num, progress, test_history)
    if not is_allowed:
        return jsonify({
            "error": error_msg,
            "locked": True,
            "needs_retake": True
        }), 403

    if progress.get("pending_interventions"):
        return jsonify({"error": "Complete pending interventions first"}), 400

    # ── CHECK FOR EXISTING IN_PROGRESS SESSION (page-refresh resume) ──
    existing_sessions = db.collection("test_sessions") \
        .where("user_id", "==", uid) \
        .where("chapter_id", "==", chapter_id) \
        .where("test_num", "==", test_num) \
        .where("status", "==", "in_progress") \
        .limit(1) \
        .stream()

    for sess_doc in existing_sessions:
        sess = sess_doc.to_dict()
        print(f"♻️ Reusing existing session for test {test_num}: {sess['session_id']}")

        frontend_questions = []
        for q in sess.get("questions", []):
            q_doc = db.collection("questions").document(q["question_id"]).get()
            if not q_doc.exists:
                continue
            full_q = q_doc.to_dict()
            content = full_q.get("content", {})
            options = content.get("options", [])
            if not options:
                continue
            frontend_questions.append({
                "question_id": q["question_id"],
                "concept_id": q["concept_id"],
                "concept_name": full_q["meta_data"].get("concept_name", ""),
                "difficulty": q["difficulty"],
                "variation": q.get("variation_number", 1),
                "question_text": content.get("question_text", ""),
                "question_type": content.get("question_type", "single_correct"),
                "has_image": content.get("has_image", False),
                "image_url": resolve_qgen_image_url(chapter_id, content.get("image_file", "")) if content.get("has_image") else None,
                "options": build_frontend_options(options, chapter_id),
                "list1": content.get("list1", []),
                "list2": content.get("list2", []),
                "estimated_time_seconds": full_q["meta_data"].get("estimated_time_seconds", 45)
            })

        phase_name = sess.get("phase", "")
        return jsonify({
            "session_id": sess["session_id"],
            "test_num": test_num,
            "phase": phase_name,
            "is_flex": sess.get("is_flex", False),
            "time_limit_seconds": sess.get("time_limit_seconds", 600),
            "total_questions": len(frontend_questions),
            "questions": frontend_questions,
            "is_mock": phase_name == "Grand Mock",
            "is_bonus": phase_name == ENDURANCE,
            "is_retake": True
        })

    # ── NO EXISTING SESSION — GENERATE FRESH ──
    test_plan = progress.get("test_plan", {})

    # Fetch the chapter's LIVE content once. Needed both to check whether
    # test_plan/concept_mastery have gone stale (content_signature compare,
    # below) and, if they haven't, to select this test's questions further
    # down -- previously that was a second, separate query every single
    # call; now it's fetched once and reused either way.
    all_q_docs = db.collection("questions") \
        .where("meta_data.chapter_id", "==", chapter_id) \
        .stream()
    all_questions = [q.to_dict() for q in all_q_docs]

    chapter_meta_doc = db.collection("chapter_metadata").document(chapter_id).get()
    concepts_summary = chapter_meta_doc.to_dict().get("concepts_summary", []) if chapter_meta_doc.exists else []

    current_signature = compute_content_signature(all_questions, concepts_summary)
    stored_signature = test_plan.get("content_signature") if test_plan else None

    # Recalculate whenever the chapter's actual question/concept ID surface
    # has changed -- a re-upload with new namespacing, a re-run concept-
    # tagging pass, questions added/removed -- not just once on an engine-
    # version string that never fires again after it's been bumped. Refreshes
    # test_plan + phase_state (this student's per-phase progress against the
    # OLD ID surface stops being meaningful once the IDs themselves change)
    # AND concept_mastery (non-destructive merge, see sync_concept_mastery --
    # this is what keeps test_debug_logs/interventions from silently going
    # empty after a restructure).
    if not test_plan or stored_signature != current_signature:
        print(f"⚠️ Content signature changed for {chapter_id} "
              f"({stored_signature!r} -> {current_signature!r}) -- "
              f"recalculating test_plan + resyncing concept_mastery...")
        test_plan = calculate_dynamic_test_plan(all_questions, concepts_summary)

        phase_state = _E.fresh_phase_state()

        concept_mastery = progress.get("concept_mastery", {})
        newly_added = sync_concept_mastery(concept_mastery, concepts_summary)
        if newly_added:
            print(f"   ├─ concept_mastery: added {len(newly_added)} new concept(s): {newly_added}")

        progress["test_plan"] = test_plan
        progress["phase_state"] = phase_state
        progress["concept_mastery"] = concept_mastery
        progress_ref = db.collection("user_progress").document(f"{uid}_{chapter_id}")
        progress_ref.update({
            "test_plan": test_plan,
            "phase_state": phase_state,
            "concept_mastery": concept_mastery,
        })

    phase_state = progress.get("phase_state", {})
    phase_name = get_active_phase(test_plan, phase_state)

    # (removed) the bonus_pool_eligible guard.
    # bonus_pool_eligible was only ever appended to with reason="needs_review",
    # and needs_review was only ever written on a max_tests force-close, which
    # opd_engine.prove_no_forced_closure() shows can never happen. So the list
    # was empty for EVERY student, always, and this guard returned 400
    # unconditionally to anyone who reached the Bonus Pool. Eligibility is now
    # simply "does this phase have unshown reserved content", which the
    # dispatcher answers by itself.

    print(f"\n{'='*60}")
    print(f"📝 GENERATING TEST {test_num} | Phase: {phase_name} | Chapter: {chapter_id} | User: {uid}")
    print(f"{'='*60}")

    # Endurance goes through the SAME dispatcher as every other phase now --
    # reserved content, owed v2s, v3 checks, concept tracking all on. The old
    # generate_bonus_pool_test() swept every unseen question in the chapter and
    # shuffled, which mixed v1 and v2 of the same base into one test (v2 shares
    # v1's options AND answer, so that was a giveaway) and turned concept
    # tracking off for ~70% of the chapter's content.

    seen_question_ids = set(progress.get("seen_question_ids", []))
    retake_session_qids = get_retake_session_question_ids(uid, chapter_id)
    seen_question_ids = seen_question_ids | retake_session_qids

    try:
        selected_questions, phase_name_result, time_minutes, is_flex, sel_log = select_questions_for_test(
            phase_name, test_plan, progress, all_questions, global_test_num=test_num
        )
    except ValueError as e:
        return jsonify({
            "error": str(e),
            "suggestion": f"All questions may have been used. Try {ENDURANCE} or the Grand Mock."
        }), 400

    log_test_generation(test_num, phase_name_result, selected_questions, sel_log, test_plan, progress)

    if phase_name_result != "Grand Mock":

        # ── PERSIST THE DRAINED QUEUE (ROOT-CAUSE FIX) ──────────────────────
        # select_questions_for_test() -> build_next_test_selection() above
        # already removed the owed_v2 entries used by THIS test from
        # progress["phase_state"][phase_name_result] in memory. Without
        # writing that back now, Firestore keeps the stale, undrained queue:
        # the next generation call would reload the same un-drained list,
        # either re-selecting items that were already answered or (once
        # they're marked seen) silently dropping them -- eventually
        # starving selection entirely once the fresh-v1 pool is also
        # exhausted, and preventing phase_completion_status() from ever
        # seeing an empty queue so the phase can advance. Persist immediately.
        db.collection("user_progress").document(f"{uid}_{chapter_id}").update({
            "phase_state": progress.get("phase_state", {}),
            "v3_check_queue": progress.get("v3_check_queue", []),
        })

    # Build frontend questions
    frontend_questions = []
    for q in selected_questions:
        content_data = q.get("content", {})
        options = content_data.get("options", [])
        if not options:
            continue

        frontend_questions.append({
            "question_id": q["question_id"],
            "concept_id": q["meta_data"]["concept_id"],
            "concept_name": q["meta_data"].get("concept_name", ""),
            "difficulty": q["meta_data"]["difficulty"],
            "variation": q["meta_data"]["variation_number"],
            "question_text": content_data.get("question_text", ""),
            "question_type": content_data.get("question_type", "single_correct"),
            "has_image": content_data.get("has_image", False),
            "image_url": resolve_qgen_image_url(chapter_id, content_data.get("image_file", "")) if content_data.get("has_image") else None,
            "options": build_frontend_options(options, chapter_id),
            "list1": content_data.get("list1", []),
            "list2": content_data.get("list2", []),
            "estimated_time_seconds": q["meta_data"].get("estimated_time_seconds", 45)
        })

    if len(frontend_questions) == 0:
        return jsonify({"error": "No valid questions found."}), 400

    time_limit_seconds = time_minutes * 60

    print(f"📊 Selected: {len(frontend_questions)} questions, {time_minutes}min, Phase: {phase_name_result}")

    # Build difficulty mix for the session record
    diff_counts = {"Easy": 0, "Medium": 0, "Hard": 0}
    for q in selected_questions:
        d = q["meta_data"]["difficulty"]
        diff_counts[d] = diff_counts.get(d, 0) + 1

    # Create session
    session_id = f"session_{uid}_{chapter_id}_{test_num}_{int(time.time())}"

    session_data = {
        "session_id": session_id,
        "user_id": uid,
        "chapter_id": chapter_id,
        "test_num": test_num,
        "test_type": "grand_mock" if phase_name_result == "Grand Mock" else (
            "bonus" if phase_name_result == ENDURANCE else "learning"
        ),
        "phase": phase_name_result,
        "is_flex": is_flex,
        "difficulty_mix": diff_counts,
        "time_limit_seconds": time_limit_seconds,
        "total_questions": len(frontend_questions),
        "is_retake": False,
        "retake_count": 0,
        "questions": [
            {
                "question_id": q["question_id"],
                "concept_id": q["meta_data"]["concept_id"],
                "difficulty": q["meta_data"]["difficulty"],
                "base_question_id": q["meta_data"]["base_question_id"],
                "variation_number": q["meta_data"]["variation_number"],
                "tested_fact": q["meta_data"].get("tested_fact", ""),
                "question_type": q["content"].get("question_type", "single_correct"),
                "has_image": q["content"].get("has_image", False),
                "image_url": resolve_qgen_image_url(chapter_id, q["content"].get("image_file", "")) if q["content"].get("has_image") else None,
                "list1": q["content"].get("list1", []),
                "list2": q["content"].get("list2", []),
                "correct_mapping": q["content"].get("correct_mapping", {}),
                "correct_answer": next(
                    (opt["id"] for opt in q["content"]["options"] if opt.get("is_correct")), None
                ),
                "student_answer": None,
                "is_correct": None,
                "static_explanation": q.get("solution", {}).get("static_explanation", ""),
                "detailed_explanation": q.get("solution", {}).get("detailed_explanation", ""),
                "key_points": q.get("solution", {}).get("key_points", []),
                "common_mistakes": q.get("solution", {}).get("common_mistakes", []),
                "source_verbatim": q.get("solution", {}).get("source_verbatim", ""),
                "ncert_page_quote": q.get("solution", {}).get("ncert_page_quote", ""),
                "options_detail": enrich_options_detail(q["content"]["options"], chapter_id),
                "enrichment": q.get("enrichment", {}),
                "question_text": q["content"].get("question_text", "")
            }
            for q in selected_questions
            if q.get("content", {}).get("options")
        ],
        "score": None,
        "started_at": firestore.SERVER_TIMESTAMP,
        "completed_at": None,
        "status": "in_progress"
    }

    db.collection("test_sessions").document(session_id).set(session_data)

    print(f"✅ Test {test_num} ({phase_name_result}) generated: {len(frontend_questions)}Q, {time_minutes}min")

    return jsonify({
        "session_id": session_id,
        "test_num": test_num,
        "phase": phase_name_result,
        "is_flex": is_flex,
        "time_limit_seconds": time_limit_seconds,
        "total_questions": len(frontend_questions),
        "questions": frontend_questions,
        "is_mock": phase_name_result == "Grand Mock",
        "is_bonus": phase_name_result == ENDURANCE,
        "is_retake": False
    })

# generate_bonus_pool_test() DELETED -- Endurance now runs through
# select_questions_for_test() like every other phase. The old function swept
# all unseen questions with a Firestore query, shuffled them, and cut at
# BONUS_PER_TEST=15, giving ~67 sequential untracked random tests for
# Hydrocarbons with no ordering, no v1/v2/v3 cycle and no end condition.


def log_endurance_entry(progress, test_plan, phase_state):
    """K6 + K7 -- the full v1/v2/v3 report at the moment the Grand Mock closes
    and Endurance opens. This is the block to paste back for a whole-chapter
    review."""
    cm = progress.get("concept_mastery", {})
    seen = set(progress.get("seen_question_ids", []))
    pc = test_plan.get("pool_counts", {})
    v1m = test_plan.get("v1_meta", {})

    v1_seen = [q for q in v1m if q in seen]
    v2_seen = [q for q in test_plan.get("v2_by_base", {}).values() if q in seen]
    v3_seen = [q for q in test_plan.get("v3_by_base", {}).values() if q in seen]

    zero = [c for c, d in cm.items() if d.get("status") == "not_started"]
    L = []
    L.append("=" * 78)
    L.append("GRAND MOCK COMPLETE — FULL CHAPTER REPORT")
    L.append("=" * 78)
    L.append(f"{'Phase':<18}{'planned':>9}{'actual':>8}{'flex':>6}{'v1 reserved':>13}")
    for name in JOURNEY_ORDER:
        st = phase_state.get(name, {})
        pp = test_plan["phases"].get(name, {})
        planned = pp.get("min_tests", 0)
        actual = st.get("tests_taken", 0)
        L.append(f"{name:<18}{planned:>9}{actual:>8}{max(0, actual - planned):>6}"
                 f"{len(pp.get('reserved_v1_ids', [])):>13}")
    end = test_plan["phases"].get(ENDURANCE, {})
    L.append(f"{ENDURANCE:<18}{end.get('min_tests', 0):>9}{'—':>8}{'—':>6}"
             f"{len(end.get('reserved_v1_ids', [])):>13}")
    L.append("")
    L.append(f"v1 shown : {len(v1_seen)}/{sum(pc.values())} "
             f"({len(v1_seen) / max(1, sum(pc.values())) * 100:.0f}% of pool)")
    L.append(f"v2 shown : {len(v2_seen)}/{len(test_plan.get('v2_by_base', {}))} "
             f"(only fires on a v1 miss — by design)")
    L.append(f"v3 shown : {len(v3_seen)}/{len(test_plan.get('v3_by_base', {}))} "
             f"(interventions + spaced audits)")
    L.append(f"v3 audits still queued: {len(progress.get('v3_check_queue', []))} -> flow into {ENDURANCE}")
    L.append(f"false recoveries flagged: {len(progress.get('bonus_pool_eligible', []))}")
    L.append("")
    L.append(f"Journey            : {sum(phase_state.get(n, {}).get('tests_taken', 0) for n in JOURNEY_ORDER)} tests")
    L.append(f"Per concept        : {len(v1_seen) / max(1, len(cm)):.1f}")
    L.append(f"Concepts at zero   : {len(zero)} {zero}")
    L.append(f"Stranded           : {test_plan.get('stranded', 0)}")
    L.append(f"{ENDURANCE:<19}: {end.get('min_tests', 0)} tests planned, "
             f"{len(end.get('reserved_v1_ids', []))} v1 reserved")
    L.append("=" * 78)
    print("\n".join(L))


# ---- SUBMIT TEST WITH INTERVENTIONS ----
@app.route("/api/test/submit-with-interventions", methods=["POST"])
@require_auth
def submit_test_with_interventions():
    """
    Submit test and detect interventions needed.
    On retake: record attempts as is_retake=True, skip intervention triggering,
    show direct answer reveal instead.
    """
    uid = request.uid
    data = request.json

    session_id = data.get("session_id")
    answers = data.get("answers", {})
    time_taken = data.get("time_taken_seconds", 0)

    if not session_id:
        return jsonify({"error": "session_id required"}), 400

    session_ref = db.collection("test_sessions").document(session_id)
    session = session_ref.get()
    if not session.exists:
        return jsonify({"error": "Session not found"}), 404

    session_data = session.to_dict()

    if session_data["user_id"] != uid:
        return jsonify({"error": "Unauthorized"}), 403

    if session_data.get("status") == "completed":
        return jsonify({"error": "Test already submitted"}), 400

    chapter_id = session_data["chapter_id"]
    test_num = session_data["test_num"]

    # Determine if this is a retake from the session itself
    is_retake = session_data.get("is_retake", False)

    print(f"📝 Submitting test {test_num} | is_retake: {is_retake}")

    # Grade test
    score = 0
    total = len(session_data["questions"])
    concept_results = {}
    question_results = []

    for i, q in enumerate(session_data["questions"]):
        qid = q["question_id"]
        student_answer = answers.get(qid)
        correct_answer = q["correct_answer"]
        question_type = q.get("question_type", "single_correct")

        if question_type == "match_the_following":
            # student_answer is expected to be a mapping dict (e.g.
            # {"1": "A", "2": "C", ...}), not a single letter.
            correct_mapping = q.get("correct_mapping", {}) or {}
            submitted_mapping = student_answer if isinstance(student_answer, dict) else {}
            is_correct = bool(correct_mapping) and submitted_mapping == correct_mapping
            student_answer = submitted_mapping  # normalize for storage below
        else:
            is_correct = (student_answer.strip().upper() == correct_answer.strip().upper()) if (student_answer and correct_answer) else False

        session_data["questions"][i]["student_answer"] = student_answer
        session_data["questions"][i]["is_correct"] = is_correct

        if is_correct:
            score += 1

        cid = q["concept_id"]
        if cid not in concept_results:
            concept_results[cid] = {"correct": 0, "total": 0, "questions": []}

        concept_results[cid]["total"] += 1
        if is_correct:
            concept_results[cid]["correct"] += 1

        question_text = q.get("question_text", "")
        if not question_text:
            try:
                q_doc = db.collection("questions").document(qid).get()
                if q_doc.exists:
                    question_text = q_doc.to_dict().get("content", {}).get("question_text", "")
            except:
                pass

        concept_results[cid]["questions"].append({
            "question_id": qid,
            "base_question_id": q["base_question_id"],
            "variation_number": q["variation_number"],
            "is_correct": is_correct,
            "student_answer": student_answer,
            "correct_answer": correct_answer,
            "difficulty": q["difficulty"],
            "options_detail": q.get("options_detail", []),
            "static_explanation": q.get("static_explanation", ""),
            "question_text": question_text
        })

        question_results.append({
            "question_id": qid,
            "concept_id": cid,
            "difficulty": q["difficulty"],
            "question_text": question_text,
            "question_type": question_type,
            "tested_fact": q.get("tested_fact", ""),
            "has_image": q.get("has_image", False),
            "image_url": q.get("image_url"),
            "list1": q.get("list1", []),
            "list2": q.get("list2", []),
            "correct_mapping": q.get("correct_mapping", {}),
            "is_correct": is_correct,
            "student_answer": student_answer,
            "correct_answer": correct_answer,
            "static_explanation": q.get("static_explanation", ""),
            "detailed_explanation": q.get("detailed_explanation", ""),
            "key_points": q.get("key_points", []),
            "common_mistakes": q.get("common_mistakes", []),
            "source_verbatim": q.get("source_verbatim", ""),
            "ncert_page_quote": q.get("ncert_page_quote", ""),
            "options_detail": q.get("options_detail", []),
            "enrichment": q.get("enrichment", {})
        })

    percentage = calculate_mastery_score(score, total)

    # Update session
    session_ref.update({
        "questions": session_data["questions"],
        "score": score,
        "percentage": percentage,
        "time_taken_seconds": time_taken,
        "completed_at": firestore.SERVER_TIMESTAMP,
        "status": "completed"
    })

    # Update progress
    progress_ref = db.collection("user_progress").document(f"{uid}_{chapter_id}")
    progress = get_or_create_progress(uid, chapter_id)

    concept_mastery = progress.get("concept_mastery", {})
    interventions_needed = []
    already_flagged_bases = set()
    # Full per-question audit trail for this test -- persisted below so you
    # can see exactly what happened without digging through Firestore by
    # hand: which variation was shown, correct/wrong, the running consecutive-
    # failure count for that base question, and whether an intervention
    # would trigger (even on a retake, where it's computed but not acted on --
    # so you can see the counterfactual too).
    debug_log_entries = []
    # v3s served by the intervention popup. seen_question_ids is built only from
    # session_data["questions"], and a popup v3 never travels through a session --
    # so every seen-check in the engine was blind to it. That let the spaced audit
    # re-serve a v3 the student had already worked through with the tutor:
    # v1 wrong -> v2 wrong -> popup burns the v3 -> student retakes and passes the
    # v2 -> audit booked -> audit fires the same v3 back at them. Declared here,
    # above the grading loop that fills it, because seen_after is assembled much
    # further down and a name bound only there would UnboundLocalError the first
    # time a popup fired.
    interventions_v3_shown = []

    for cid, cresult in concept_results.items():
        if cid not in concept_mastery:
            continue

        cm = concept_mastery[cid]

        for qdata in cresult["questions"]:
            qid = qdata["question_id"]
            base_id = qdata["base_question_id"]
            is_correct = qdata["is_correct"]

            # Update concept-level tracking
            if qid not in cm.get("questions_seen", []):
                cm.setdefault("questions_seen", []).append(qid)

            if is_correct:
                if qid not in cm.get("questions_correct", []):
                    cm.setdefault("questions_correct", []).append(qid)
                # Only reset consecutive failures on non-retake correct answers
                if not is_retake:
                    cm["consecutive_concept_failures"] = 0
                    cm["needs_retry"] = False
            else:
                if qid not in cm.get("questions_wrong", []):
                    cm.setdefault("questions_wrong", []).append(qid)
                # Only increment consecutive failures on non-retake
                if not is_retake:
                    cm["consecutive_concept_failures"] = cm.get("consecutive_concept_failures", 0) + 1
                    cm["needs_retry"] = True
                    cm["last_failed_test"] = test_num

            # Calculate mastery
            total_seen = len(cm.get("questions_seen", []))
            total_correct_count = len(cm.get("questions_correct", []))
            cm["mastery_score"] = calculate_mastery_score(total_correct_count, total_seen)

            # Update base question tracking
            tracking = get_base_tracking(uid, chapter_id, base_id)
            tracking["concept_id"] = cid

            # Mark entry with is_retake flag
            tracking["variation_history"].append({
                "variation": f"v{qdata['variation_number']}",
                "test_num": test_num,
                "result": "correct" if is_correct else "wrong",
                "used_in": "regular_test",
                "is_retake": is_retake,  # KEY FLAG
                "student_answer": qdata.get("student_answer"),
                "correct_answer": qdata["correct_answer"],
                "question_text": qdata.get("question_text", "")
            })

            if f"v{qdata['variation_number']}" not in tracking["used_variations"]:
                tracking["used_variations"].append(f"v{qdata['variation_number']}")

            if not is_correct:
                tracking["total_failures"] += 1
                # consecutive_failures uses updated count_consecutive_failures_base
                # which already skips is_retake entries
                tracking["consecutive_failures"] = count_consecutive_failures_base(tracking)
            else:
                if not is_retake:
                    tracking["consecutive_failures"] = 0

            save_base_tracking(tracking)

            # ── DEBUG AUDIT ENTRY ────────────────────────────────────────
            # Computed even on retake / already-flagged-this-test, so you
            # can see the counterfactual (e.g. "this would have escalated
            # here, but it was a retake so nothing fired").
            debug_intervention_probe = determine_intervention(tracking, test_num, is_retake) if not is_retake else None
            debug_log_entries.append({
                "question_id": qid,
                "base_question_id": base_id,
                "concept_id": cid,
                "concept_name": cm.get("concept_name", cid),
                "variation": f"v{qdata['variation_number']}",
                "difficulty": qdata.get("difficulty", ""),
                "student_answer": qdata.get("student_answer"),
                "correct_answer": qdata.get("correct_answer"),
                "is_correct": is_correct,
                "consecutive_failures_for_base_after_this": tracking.get("consecutive_failures", 0),
                "total_failures_for_base": tracking.get("total_failures", 0),
                "used_variations_so_far": list(tracking.get("used_variations", [])),
                "is_retake": is_retake,
                "would_trigger_intervention": bool(debug_intervention_probe) if not is_retake else None,
                "intervention_type_if_any": debug_intervention_probe.get("type") if debug_intervention_probe else None,
                "already_flagged_this_test_before_this_q": base_id in already_flagged_bases,
            })

            # ── INTERVENTION CHECK: SKIP ON RETAKE ──
            if is_retake:
                continue

            if base_id in already_flagged_bases:
                continue

            intervention = debug_intervention_probe  # reuse -- avoid a second v3 lookup

            if intervention:
                already_flagged_bases.add(base_id)

                original_options = qdata.get("options_detail", [])
                original_correct = qdata["correct_answer"]

                all_options_explanation = []
                for opt in original_options:
                    is_opt_correct = (opt["id"] == original_correct)
                    if is_opt_correct:
                        explanation = opt.get("explanation") or opt.get("why_correct_explanation") or "This is the correct answer."
                    else:
                        explanation = opt.get("why_wrong_explanation") or opt.get("explanation") or "This option is incorrect."

                    all_options_explanation.append({
                        "id": opt.get("id", ""),
                        "text": opt.get("text", ""),
                        "is_correct": is_opt_correct,
                        "explanation": explanation
                    })

                original_static_explanation = qdata.get("static_explanation", "Review this concept carefully.")

                intervention_data = {
                    "concept_id": cid,
                    "concept_name": cm.get("concept_name", cid),
                    "base_question_id": base_id,
                    "intervention_type": intervention["type"],
                    "test_num": test_num,
                    "is_retest": is_retake,
                    "static_explanation": original_static_explanation,
                    "all_options_explanation": all_options_explanation,
                    "original_question_text": qdata.get("question_text", ""),
                    "original_student_answer": qdata.get("student_answer"),
                    "original_correct_answer": qdata.get("correct_answer"),
                    "original_difficulty": qdata.get("difficulty", ""),
                    "original_variation": qdata.get("variation_number", 1),
                    "original_list1": qdata.get("list1", []),
                    "original_list2": qdata.get("list2", []),
                    "variation_history_summary": build_variation_history_summary(tracking)
                }

                if intervention.get("v3_question"):
                    v3_q = intervention["v3_question"]
                    v3_options_clean = []
                    for opt in v3_q.get("content", {}).get("options", []):
                        v3_options_clean.append({
                            "id": opt.get("id", ""),
                            "text": opt.get("text", "")
                        })

                    # About to be SHOWN to the student -> it is seen.
                    interventions_v3_shown.append(v3_q.get("question_id", ""))
                    intervention_data["v3_question"] = {
                        "question_id": v3_q.get("question_id", ""),
                        "question_text": v3_q.get("content", {}).get("question_text", ""),
                        "options": v3_options_clean,
                        "list1": v3_q.get("content", {}).get("list1", []),
                        "list2": v3_q.get("content", {}).get("list2", []),
                        "correct_answer": next(
                            (opt["id"] for opt in v3_q.get("content", {}).get("options", [])
                             if opt.get("is_correct")),
                            None
                        )
                    }

                interventions_needed.append(intervention_data)

        # Update status
        mastery = cm["mastery_score"]
        if mastery >= 80:
            cm["status"] = "mastered"
        elif mastery >= 50:
            cm["status"] = "learning"
        else:
            cm["status"] = "struggling"

        concept_mastery[cid] = cm

    # ── QUEUE / PHASE-STATE UPDATE (learning phases only) ──────────────────
    # Grand Mock and Bonus Pool are static/fixed -- not part of the
    # mistake-driven remediation queue. This runs regardless of is_retake:
    # request_retest() (see below) already rolls back tests_taken and this
    # test's prior tracking entries before a retake is allowed, so the
    # retake's real outcome is meant to count normally, once.
    phase_name_of_test = session_data.get("phase", "")
    phase_state = progress.get("phase_state", {})
    test_plan = progress.get("test_plan", {})
    escalated_bases_this_test = []
    review_flags_this_test = []
    phase_completion_note = None

    if phase_name_of_test in PHASE_ORDER:
        state = phase_state.setdefault(phase_name_of_test, {"tests_taken": 0, "owed_v2": [], "status": "active"})
        plan_phase = test_plan.get("phases", {}).get(phase_name_of_test, {})

        question_grades = [
            {
                "base_question_id": q["base_question_id"],
                "variation_number": q["variation_number"],
                "is_correct": q["is_correct"],
            }
            for q in session_data["questions"]
        ]

        v3q = progress.setdefault("v3_check_queue", [])
        qr = process_learning_phase_result(state, question_grades, v3q, test_num,
                                           is_retake=is_retake)
        escalated_bases_this_test = qr["escalations"]
        review_flags_this_test = qr["review_flags"]

        n_correct = sum(1 for o in qr["outcomes"] if o["result"] == "correct")
        seen_after = (set(progress.get("seen_question_ids", []))
                      | {q["question_id"] for q in session_data["questions"]}
                      | set(interventions_v3_shown))

        print(f"📊 TEST {test_num} RESULT ({phase_name_of_test}) | {n_correct}/{len(qr['outcomes'])} correct")
        for o in qr["outcomes"]:
            print(f"   ├─ base={o['base_id']} {o['variation']} -> {o['result']} -> {o['status']}")
        booked = [o for o in qr["outcomes"] if o["status"] == "closed_recovered"]
        if booked:
            print(f"   ├─ recovered on v2 ({len(booked)}) -> v3 audit booked for test "
                  f"{test_num + _E.V3_CHECK_LAG}: {[b['base_id'] for b in booked]}")
        spent = [o for o in qr["outcomes"] if o["status"] == "audit_already_spent"]
        if spent:
            print(f"   ├─ v3 audit NOT re-graded on retake (first attempt's verdict "
                  f"stands): {[o['base_id'] for o in spent]}")
        if review_flags_this_test:
            print(f"   ├─ !! FALSE RECOVERY caught by v3 audit: {review_flags_this_test} "
                  f"(passed v2, failed the spaced v3 -> flagged for {ENDURANCE} review)")
        if escalated_bases_this_test:
            print(f"   ├─ ESCALATED to pop-up (v3, shown at end of this test): {escalated_bases_this_test}")

        # Difficulty breakdown of this test's outcomes (easy/medium/hard,
        # correct vs wrong), and running totals for the v1/v2 pools so the
        # math (how much of the reserved pool has actually been covered) is
        # visible without cross-referencing every generation log by hand.
        diff_summary = {}
        for q in session_data["questions"]:
            d = q.get("difficulty", "Unknown")
            diff_summary.setdefault(d, {"correct": 0, "wrong": 0})
            diff_summary[d]["correct" if q.get("is_correct") else "wrong"] += 1
        diff_str = ", ".join(f"{d}:{v['correct']}/{v['correct']+v['wrong']}" for d, v in diff_summary.items())
        print(f"   ├─ difficulty breakdown   : {diff_str}")

        v1_total = len(plan_phase.get("reserved_v1_ids", []))
        v1_shown = len([qid for qid in plan_phase.get("reserved_v1_ids", []) if qid in seen_after])
        v2_pool_total = len(test_plan.get("v2_by_base", {}))
        print(f"   ├─ tests_taken in {phase_name_of_test}: {state['tests_taken']}/{plan_phase.get('min_tests')} min "
              f"(no cap — max_tests deleted) | owed v2 queued: {len(state.get('owed_v2', []))}")
        print(f"   ├─ v1 pool progress       : {v1_shown}/{v1_total} shown")
        print(f"   ├─ v3 audits queued ahead : {len(progress.get('v3_check_queue', []))}")
        _cm = progress.get("concept_mastery", {})
        _started = sum(1 for c in _cm.values() if c.get("status") != "not_started")
        print(f"   ├─ CONCEPTS COVERED       : {_started}/{len(_cm)}")

        status, reason = phase_completion_status(plan_phase, state, seen_after)

        # A FAILED test finalises nothing. Below PASS_THRESHOLD the student is
        # required to retake, so this attempt is provisional -- and completing the
        # phase here would carry the owed_v2 tail into the NEXT phase, where
        # request_retest() cannot reach it. request_retest() rewinds this phase's own
        # tests_taken and owed_v2; it has no idea the debt already moved next door.
        #
        # Live case: Test 5 scored 2/11 (18%). Foundation completed anyway and
        # carried 7 owed v2 into Skill Building. The retake then scored 11/11 --
        # every one of those 7 answered correctly -- but the v2s had already moved
        # and fired in Test 6 regardless. The student was re-taught seven things
        # they had just proven they knew, and Skill Building's first test came out
        # 13-Easy/1-Medium instead of its planned 7/7.
        #
        # Holding completion until the attempt stands is both the narrower fix and
        # the more honest rule: nothing is final until it passes.
        if status == "complete" and percentage < PASS_THRESHOLD:
            status = "active"
            print(f"   └─ {phase_name_of_test} pool is spent, but this test scored "
                  f"{percentage:.0f}% (< {PASS_THRESHOLD}%) — holding completion "
                  f"until the retake stands.")

        if status == "complete":
            state["status"] = "complete"
            # K4 -- planned vs actual, and where the tail went.
            planned = plan_phase.get("min_tests", 0)
            actual = state["tests_taken"]
            phase_completion_note = (
                f"{phase_name_of_test} COMPLETE after {actual} tests "
                f"(planned min {planned}, {max(0, actual - planned)} flex): reserved v1 pool spent."
            )
            print(f"   └─ {phase_completion_note}")
            # Tail flows forward instead of forcing a 1-2 question stub test at
            # every phase boundary. Grand Mock is skipped on purpose by
            # next_phase_after(): the capstone must carry zero remediation.
            dest, n_carried = carry_queue_forward(phase_state, phase_name_of_test)
            if n_carried:
                print(f"   └─ carried {n_carried} owed v2 forward -> {dest}")

            next_phase = get_active_phase(test_plan, phase_state)
            if next_phase in phase_state and phase_state[next_phase].get("status") == "not_started":
                phase_state[next_phase]["status"] = "active"
                print(f"   └─ Next phase activated: {next_phase}")

    elif phase_name_of_test == "Grand Mock":
        gm_state = phase_state.setdefault("Grand Mock", {"tests_taken": 0, "owed_v2": [], "status": "active"})
        gm_state["tests_taken"] = gm_state.get("tests_taken", 0) + 1
        gm_state["status"] = "complete"
        next_phase = get_active_phase(test_plan, phase_state)
        # K5 -- what the capstone actually sampled.
        gm_concepts = {q.get("concept_id") for q in session_data.get("questions", [])}
        n_total_concepts = len(progress.get("concept_mastery", {}))
        print(f"📊 TEST {test_num} RESULT (Grand Mock) | complete. Next phase: {next_phase}")
        print(f"   └─ Grand Mock sampled {len(gm_concepts)}/{n_total_concepts} concepts")
        log_endurance_entry(progress, test_plan, phase_state)

    # Only NEEDS_REVIEW items are persisted (used to tag Bonus Pool display).
    # Plain "unused_clean"/"unused_recovered" leftovers reach Bonus Pool
    # automatically via the seen_question_ids exclusion sweep -- no separate
    # tracking needed for those, they just need to not be "seen" yet.
    # needs_review now means something real: a base whose v2 was CORRECT (so the
    # engine closed it as "recovered") but whose spaced v3 audit later FAILED --
    # i.e. the recovery was recall of v1's answer, not learning. Previously this
    # list was fed only by max_tests force-closure, which cannot happen, so it
    # was always empty (and the Bonus Pool guard therefore rejected everyone).
    bonus_pool_eligible = progress.get("bonus_pool_eligible", [])
    for bid in review_flags_this_test:
        bonus_pool_eligible.append({
            "reason": "needs_review", "phase": phase_name_of_test,
            "base_id": bid, "question_id": test_plan.get("v2_by_base", {}).get(bid),
        })
    progress["bonus_pool_eligible"] = bonus_pool_eligible

    # Endurance counts now -- it is a real phase with reserved content, not an
    # optional dumping ground, so the chapter is not "fully complete" until its
    # content is spent too.
    chapter_fully_complete = all(
        phase_state.get(p, {}).get("status") == "complete" for p in FULL_ORDER
    )

    # Calculate overall mastery
    mastery_scores = [c.get("mastery_score", 0) for c in concept_mastery.values()]
    overall_mastery = round(sum(mastery_scores) / len(mastery_scores)) if mastery_scores else 0

    # Update test history
    test_history = progress.get("test_history", [])
    test_history.append({
        "test_num": test_num,
        "score": score,
        "total": total,
        "percentage": percentage,
        "time_taken_seconds": time_taken,
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "session_id": session_id,
        "is_retake": is_retake,
        "phase": session_data.get("phase", phase_name_of_test),
        "is_flex": session_data.get("is_flex", False)
    })

    # Add question IDs back to seen (they were removed on retest request)
    seen_ids = progress.get("seen_question_ids", [])
    for _v3qid in interventions_v3_shown:
        if _v3qid and _v3qid not in seen_ids:
            seen_ids.append(_v3qid)
    for q in session_data["questions"]:
        if q["question_id"] not in seen_ids:
            seen_ids.append(q["question_id"])

    # Lock logic — score check ALWAYS applies, regardless of retake/interventions
    score_too_low = percentage < PASS_THRESHOLD
    has_interventions = not is_retake and len(interventions_needed) > 0

    # Score lock takes priority: even if no interventions, low score = locked
    next_test_locked = score_too_low or has_interventions
    # THE BONUS-POOL 403. `next_test_available` was being ANDed with
    # `chapter_fully_complete`, so submitting the Grand Mock at >=40% with no
    # interventions set it to False -- and validate_test_unlock() reads that
    # same flag as "you are blocked", producing:
    #   "Test 21 is locked. Retake the previous test or complete interventions first."
    # for a student who had done everything correctly. The flag was carrying two
    # unrelated meanings ("blocked" and "nothing left"). It now means only
    # "blocked"; whether anything remains is get_active_phase()'s job, and
    # Endurance IS a legitimate next phase.
    next_test_available = not next_test_locked

    locked_reason = None
    if score_too_low:
        locked_reason = f"Score {percentage}% is below {PASS_THRESHOLD}%. Retake this test to continue."
    elif has_interventions:
        locked_reason = "Complete concept reviews first"

    # Snapshot per-concept mastery at this point in time so the chapter
    # landing page can show a trend ("Elimination reactions: 40% -> 78%")
    # instead of just the current number. One small entry per completed
    # test -- bounded by how many tests a chapter has, not unbounded growth.
    concept_mastery_history = progress.get("concept_mastery_history", [])
    concept_mastery_history.append({
        "test_num": test_num,
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "overall_mastery": overall_mastery,
        "mastery_by_concept": {cid: cm.get("mastery_score", 0) for cid, cm in concept_mastery.items()}
    })

    progress_ref.set({
        "progress_id": f"{uid}_{chapter_id}",
        "user_id": uid,
        "chapter_id": chapter_id,
        "chapter_name": progress.get("chapter_name", ""),
        "tests_completed": test_num,
        "test_plan": progress.get("test_plan", {}),
        "phase_state": phase_state,
        "bonus_pool_eligible": bonus_pool_eligible,
        "current_difficulty": progress.get("current_difficulty", "Easy"),
        "difficulty_unlock": progress.get("difficulty_unlock", {}),
        "overall_mastery": overall_mastery,
        "concept_mastery": concept_mastery,
        "concept_mastery_history": concept_mastery_history,
        "test_history": test_history,
        "seen_question_ids": seen_ids,
        "v3_check_queue": progress.get("v3_check_queue", []),
        "last_test_date": datetime.now(timezone.utc).isoformat(),
        "next_test_available": next_test_available,
        "pending_interventions": [] if is_retake else interventions_needed,
        "chapter_fully_complete": chapter_fully_complete,
        "created_at": progress.get("created_at", firestore.SERVER_TIMESTAMP),
        "updated_at": firestore.SERVER_TIMESTAMP
    }, merge=True)

    concept_breakdown = []
    for cid, cm in concept_mastery.items():
        cr = concept_results.get(cid, {"correct": 0, "total": 0})
        concept_breakdown.append({
            "concept_id": cid,
            "concept_name": cm.get("concept_name", cid),
            "test_correct": cr["correct"],
            "test_total": cr["total"],
            "overall_mastery": cm.get("mastery_score", 0),
            "status": cm.get("status", "not_started"),
            "consecutive_failures": cm.get("consecutive_concept_failures", 0)
        })

    # ── PERSIST + PRINT THE FULL DEBUG AUDIT LOG ────────────────────────────
    # Console output scrolls away and doesn't survive a server restart --
    # this writes the same info to Firestore so it can be reviewed later,
    # e.g. via GET /api/debug/chapter/<chapter_id>/logs.
    db.collection("test_debug_logs").document(session_id).set({
        "session_id": session_id,
        "user_id": uid,
        "chapter_id": chapter_id,
        "test_num": test_num,
        "phase": phase_name_of_test,
        "is_retake": is_retake,
        "score": score,
        "total": total,
        "percentage": percentage,
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "questions": debug_log_entries,
    })

    print(f"\n{'='*70}")
    print(f"🔍 TEST {test_num} DEBUG AUDIT ({phase_name_of_test}) | session={session_id}")
    print(f"{'='*70}")
    for e in debug_log_entries:
        result_icon = "✅" if e["is_correct"] else "❌"
        flags = []
        if e["is_retake"]:
            flags.append("RETAKE(not counted)")
        if e.get("already_flagged_this_test_before_this_q"):
            flags.append("already-flagged-this-test")
        if e.get("would_trigger_intervention"):
            flags.append(f"→ INTERVENTION: {e.get('intervention_type_if_any')}")
        flags_str = f"  [{', '.join(flags)}]" if flags else ""
        print(f"   {result_icon} base={e['base_question_id']:<45} {e['variation']} "
              f"| consec_fail={e['consecutive_failures_for_base_after_this']} "
              f"| used={e['used_variations_so_far']}{flags_str}")
    print(f"{'='*70}\n")

    safe_rebuild(uid)

    return jsonify({
        "session_id": session_id,
        "test_num": test_num,
        "score": score,
        "total": total,
        "percentage": percentage,
        "time_taken_seconds": time_taken,
        "concept_breakdown": concept_breakdown,
        "question_results": question_results,
        "interventions_needed": [] if is_retake else interventions_needed,
        "overall_mastery": overall_mastery,
        "next_test_available": next_test_available,
        "pass_threshold": PASS_THRESHOLD,
        "next_test_locked_reason": locked_reason,
        "is_retake": is_retake,
        "phase": phase_name_of_test,
        "is_flex": session_data.get("is_flex", False),
        # Was len(bonus_additions_this_test) -- a count of every base that
        # closed cleanly, i.e. almost the whole test, surfaced to the student as
        # "added to Bonus Pool". Now it reports what actually needs review: bases
        # that passed their v2 but failed the spaced v3 audit.
        "bonus_pool_added": len(review_flags_this_test),
        "false_recoveries_caught": len(review_flags_this_test),
        "phase_completion_note": phase_completion_note,
        "chapter_fully_complete": chapter_fully_complete
    })

@app.route("/api/debug/chapter/<chapter_id>/logs", methods=["GET"])
@require_auth
def get_test_debug_logs(chapter_id):
    """
    Fetch this user's per-test debug audit logs for a chapter, in test order.
    Answers "why didn't v3 pop up" directly: for every question in every
    test, shows the variation shown, correct/wrong, the running consecutive-
    failure count for that specific base question, and whether an
    intervention would trigger (and what type) -- even on a retake, where
    it's computed but intentionally not acted on, so you can see the
    counterfactual too.

    Query param: ?limit=N (default 10, most recent N tests)
    """
    uid = request.uid
    limit = request.args.get("limit", default=10, type=int)

    try:
        docs = db.collection("test_debug_logs") \
            .where("user_id", "==", uid) \
            .where("chapter_id", "==", chapter_id) \
            .stream()
        logs = [clean_firestore_data(d.to_dict()) for d in docs]
        logs.sort(key=lambda x: x.get("test_num", 0))
        return jsonify({"chapter_id": chapter_id, "logs": logs[-limit:], "total_found": len(logs)})
    except Exception as e:
        print(f"❌ Debug log fetch error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/intervention/clear", methods=["POST"])
@require_auth
def clear_intervention():
    """
    Clear a specific intervention from pending_interventions.
    Used for retest_review_only and review_only_ai_exhausted types
    where no v3 or AI question is submitted — student just acknowledges.
    """
    uid = request.uid
    data = request.json

    base_question_id = data.get("base_question_id")
    chapter_id = data.get("chapter_id")

    if not all([base_question_id, chapter_id]):
        return jsonify({"error": "base_question_id and chapter_id required"}), 400

    progress_ref = db.collection("user_progress").document(f"{uid}_{chapter_id}")
    progress_doc = progress_ref.get()

    if not progress_doc.exists:
        return jsonify({"error": "Progress not found"}), 404

    progress_data = progress_doc.to_dict()
    pending = progress_data.get("pending_interventions", [])
    pending = [p for p in pending if p.get("base_question_id") != base_question_id]
    next_available = len(pending) == 0

    progress_ref.update({
        "pending_interventions": pending,
        "next_test_available": next_available
    })

    return jsonify({
        "status": "ok",
        "remaining_interventions": len(pending),
        "next_test_available": next_available
    })

def build_variation_history_summary(tracking):
    """Build a summary of all variation attempts for context."""
    summary = []
    for entry in tracking.get("variation_history", []):
        summary.append({
            "variation": entry.get("variation", ""),
            "test_num": entry.get("test_num"),
            "result": entry.get("result", ""),
            "student_answer": entry.get("student_answer"),
            "correct_answer": entry.get("correct_answer"),
            "question_text": entry.get("question_text", ""),
            "is_retake": entry.get("is_retake", False)
        })
    return summary

@app.route("/api/test/retest", methods=["POST"])
@require_auth
def request_retest():
    """
    Retest: reuse the exact original session.
    
    FIXES:
    - Type-safe test_num comparison (int vs string)
    - Searches test_sessions collection as primary source (not just test_history)
    - Handles case where test_history entry was already removed by previous retest
    """
    uid = request.uid
    data = request.json
    chapter_id = data.get("chapter_id")
    test_num = data.get("test_num")

    if not chapter_id or test_num is None:
        return jsonify({"error": "chapter_id and test_num required"}), 400

    # Ensure test_num is int for consistent comparison
    test_num = int(test_num)

    progress_ref = db.collection("user_progress").document(f"{uid}_{chapter_id}")
    progress_doc = progress_ref.get()
    if not progress_doc.exists:
        return jsonify({"error": "Progress not found"}), 404

    progress_data = progress_doc.to_dict()

    # ── STRATEGY: Search test_sessions FIRST (most reliable) ──
    original_session_id = None
    original_percentage = 0

    # Method 1: Check test_history (may have been removed by prior retest)
    test_history = progress_data.get("test_history", [])
    target_test = None
    for t in test_history:
        # Type-safe comparison
        if int(t.get("test_num", -1)) == test_num:
            target_test = t
            break

    if target_test:
        original_session_id = target_test.get("session_id")
        original_percentage = target_test.get("percentage", 0)

    # Method 2: If not in history, search test_sessions directly
    if not original_session_id:
        sessions = db.collection("test_sessions") \
            .where("user_id", "==", uid) \
            .where("chapter_id", "==", chapter_id) \
            .where("test_num", "==", test_num) \
            .limit(5) \
            .stream()

        for sess_doc in sessions:
            sess = sess_doc.to_dict()
            sid = sess.get("session_id")
            status = sess.get("status", "")
            pct = sess.get("percentage", 0)
            
            # Prefer completed sessions, but also accept in_progress (prior retest)
            if status == "completed":
                original_session_id = sid
                original_percentage = pct
                break
            elif status == "in_progress" and not original_session_id:
                # This is an already-reset session from a previous retest attempt
                original_session_id = sid
                original_percentage = pct

    if not original_session_id:
        return jsonify({"error": f"No session found for Test {test_num}. Try regenerating the test."}), 404

    # Get original session document
    session_ref = db.collection("test_sessions").document(original_session_id)
    session_doc = session_ref.get()
    if not session_doc.exists:
        return jsonify({"error": "Original session document not found"}), 404

    session_data = session_doc.to_dict()

    # If session is already in_progress (from a prior retest), just return it
    if session_data.get("status") == "in_progress":
        original_question_ids = [q["question_id"] for q in session_data.get("questions", [])]
        
        # Still ensure progress is correct
        progress_ref.update({
            "tests_completed": test_num - 1,
            "next_test_available": True,
            "pending_interventions": []
        })
        
        return jsonify({
            "status": "ok",
            "message": f"Test {test_num} is already reset. Resuming.",
            "test_num": test_num,
            "session_id": original_session_id,
            "question_count": len(original_question_ids)
        })

    # Reset session: clear all student answers, reset score and status
    reset_questions = []
    for q in session_data.get("questions", []):
        q_reset = dict(q)
        q_reset["student_answer"] = None
        q_reset["is_correct"] = None
        reset_questions.append(q_reset)

    session_ref.update({
        "questions": reset_questions,
        "score": None,
        "percentage": None,
        "time_taken_seconds": None,
        "completed_at": None,
        "status": "in_progress",
        "is_retake": True,
        "retake_count": session_data.get("retake_count", 0) + 1
    })

    # Remove failed test from history (type-safe)
    new_history = [t for t in test_history if int(t.get("test_num", -1)) != test_num]

    # ── ROLL BACK PHASE-STATE SIDE EFFECTS OF THE FAILED ATTEMPT ──
    # The failed attempt already incremented phase_state.tests_taken and may
    # have queued v1 misses onto the remediation queue (see
    # process_learning_phase_result in submit_test_with_interventions). Since
    # the retake replays the IDENTICAL question set and its outcome should
    # be the one that counts, we undo those side effects here so nothing
    # double-counts once the retake is submitted.
    phase_name_of_test = session_data.get("phase", "")
    phase_state = progress_data.get("phase_state", {})

    # Endurance is included now: it is a real phase running the same
    # v1/v2/v3 cycle, so its side effects need the same rollback. Under the old
    # code Endurance was "Bonus Pool", ran outside the engine entirely, and had
    # no state to roll back.
    if phase_name_of_test in PHASE_ORDER or phase_name_of_test == ENDURANCE:
        state = phase_state.get(phase_name_of_test)
        if state:
            state["tests_taken"] = max(0, state.get("tests_taken", 0) - 1)
            state["status"] = "active"  # can't have completed on a failed test, but be safe

            # Undo v3 audit bookings this attempt created. A v2 answered
            # correctly in the failed attempt books a spaced v3 audit; the
            # retake re-grades that same v2 and would book it a second time,
            # so the student would see the audit twice. Bookings carry the
            # test they were made at, which makes this exact.
            v3q = progress_data.get("v3_check_queue", [])
            stale = [b for b in v3q if b.get("booked_at_test") == test_num]
            if stale:
                progress_data["v3_check_queue"] = [
                    b for b in v3q if b.get("booked_at_test") != test_num]
                print(f"   ├─ rolled back {len(stale)} v3 audit booking(s) from the failed attempt")

            # Undo queue additions this specific test caused: any base_id
            # whose tracking shows a v1-wrong entry FOR THIS test_num gets
            # removed from owed_v2 (it'll be re-graded fresh on retake).
            # BATCHED: one get_all() round trip instead of one .get() per
            # base question -- this sequential loop was a major source of
            # retake-button lag.
            attempted_base_ids = {q["base_question_id"] for q in session_data.get("questions", [])}
            candidate_base_ids = [bid for bid in attempted_base_ids if bid in state.get("owed_v2", [])]
            removed_from_queue = []
            if candidate_base_ids:
                candidate_refs = [
                    db.collection("base_question_tracking").document(f"{uid}_{chapter_id}_{bid}")
                    for bid in candidate_base_ids
                ]
                docs_by_id = {d.id: d for d in db.get_all(candidate_refs)}
                for bid in candidate_base_ids:
                    tracking_doc = docs_by_id.get(f"{uid}_{chapter_id}_{bid}")
                    if tracking_doc is not None and tracking_doc.exists:
                        t = tracking_doc.to_dict()
                        caused_by_this_test = any(
                            e.get("test_num") == test_num and e.get("variation") == "v1" and e.get("result") == "wrong"
                            for e in t.get("variation_history", [])
                        )
                        if caused_by_this_test:
                            state["owed_v2"].remove(bid)
                            removed_from_queue.append(bid)

            if removed_from_queue:
                print(f"♻️ Retest rollback: removed {removed_from_queue} from {phase_name_of_test} owed_v2 queue")

    elif phase_name_of_test == "Grand Mock":
        gm_state = phase_state.get("Grand Mock")
        if gm_state:
            gm_state["tests_taken"] = max(0, gm_state.get("tests_taken", 0) - 1)
            gm_state["status"] = "active"

    # Strip this test_num's entries from every attempted base question's
    # tracking history, so consecutive-failure counts and variation_history
    # reflect only the retake's real outcome, not a stale duplicate.
    # BATCHED: one get_all() round trip for the reads and one batch.commit()
    # for the writes, instead of a .get()+.set() pair per question -- this
    # was the other major source of retake-button lag.
    unique_base_ids = list({q["base_question_id"] for q in session_data.get("questions", [])})
    if unique_base_ids:
        tracking_refs = {
            bid: db.collection("base_question_tracking").document(f"{uid}_{chapter_id}_{bid}")
            for bid in unique_base_ids
        }
        docs_by_id = {d.id: d for d in db.get_all(list(tracking_refs.values()))}
        write_batch = db.batch()
        any_writes = False
        for bid, ref in tracking_refs.items():
            tracking_doc = docs_by_id.get(ref.id)
            if tracking_doc is None or not tracking_doc.exists:
                continue
            t = tracking_doc.to_dict()
            t["variation_history"] = [e for e in t.get("variation_history", []) if e.get("test_num") != test_num]
            t["consecutive_failures"] = count_consecutive_failures_base(t)
            write_batch.set(ref, t, merge=True)
            any_writes = True
        if any_writes:
            write_batch.commit()

    # Roll back tests_completed, clear pending interventions
    progress_ref.update({
        "tests_completed": test_num - 1,
        "test_history": new_history,
        "phase_state": phase_state,
        # Persist the v3-audit rollback above. Without this the stale bookings
        # survive the retake and the audit fires twice for the same base.
        "v3_check_queue": progress_data.get("v3_check_queue", []),
        "next_test_available": True,
        "pending_interventions": []
    })

    original_question_ids = [q["question_id"] for q in session_data.get("questions", [])]

    return jsonify({
        "status": "ok",
        "message": f"Test {test_num} reset with original questions. Retaking now.",
        "test_num": test_num,
        "session_id": original_session_id,
        "question_count": len(original_question_ids)
    })


# ---- INTERVENTION: SUBMIT v3 ----
@app.route("/api/intervention/submit-v3", methods=["POST"])
@require_auth
def submit_v3_verification():
    """Submit v3 verification answer. Returns full explanations."""
    uid = request.uid
    data = request.json

    base_question_id = data.get("base_question_id")
    student_answer = data.get("answer")
    chapter_id = data.get("chapter_id")
    test_num = data.get("test_num")
    is_retest = data.get("is_retest", False)

    if not all([base_question_id, student_answer, chapter_id]):
        return jsonify({"error": "Missing required fields"}), 400

    # Get v3 question with FULL details (including explanations)
    v3_question_id = f"{base_question_id}_v3"
    v3_doc = db.collection("questions").document(v3_question_id).get()

    if not v3_doc.exists:
        return jsonify({"error": "v3 question not found"}), 404

    v3_question = v3_doc.to_dict()

    correct_answer = None
    for opt in v3_question.get("content", {}).get("options", []):
        if opt.get("is_correct"):
            correct_answer = opt["id"]
            break

    if not correct_answer:
        return jsonify({"error": "Invalid question format"}), 500

    is_correct = (student_answer.strip().upper() == correct_answer.strip().upper()) if (student_answer and correct_answer) else False

    # Build FULL v3 explanation for frontend (ISSUE 3 FIX)
    v3_static_explanation = v3_question.get("solution", {}).get("static_explanation", "")
    v3_detailed_explanation = v3_question.get("solution", {}).get("detailed_explanation", "")

    v3_options_explanation = []
    for opt in v3_question.get("content", {}).get("options", []):
        is_opt_correct = (opt["id"] == correct_answer)
        if is_opt_correct:
            explanation = opt.get("explanation") or opt.get("why_correct_explanation") or "This is the correct answer."
        else:
            explanation = opt.get("why_wrong_explanation") or opt.get("explanation") or "This option is incorrect."

        v3_options_explanation.append({
            "id": opt.get("id", ""),
            "text": opt.get("text", ""),
            "is_correct": is_opt_correct,
            "explanation": explanation
        })

    # Update tracking
    tracking = get_base_tracking(uid, chapter_id, base_question_id)

    tracking["variation_history"].append({
        "variation": "v3",
        "test_num": test_num,
        "result": "correct" if is_correct else "wrong",
        "used_in": "intervention",
        "student_answer": student_answer,
        "correct_answer": correct_answer,
        "question_text": v3_question.get("content", {}).get("question_text", "")
    })

    if "v3" not in tracking["used_variations"]:
        tracking["used_variations"].append("v3")

    if is_correct:
        tracking["consecutive_failures"] = 0
        tracking["status"] = "learning"
        save_base_tracking(tracking)

        # Remove from pending interventions
        progress_ref = db.collection("user_progress").document(f"{uid}_{chapter_id}")
        progress_data = progress_ref.get().to_dict()
        pending = progress_data.get("pending_interventions", [])
        pending = [p for p in pending if p.get("base_question_id") != base_question_id]
        next_available = len(pending) == 0

        progress_ref.update({
            "pending_interventions": pending,
            "next_test_available": next_available
        })

        return jsonify({
            "is_correct": True,
            "message": "Excellent! You've understood the concept.",
            "next_step": "continue_interventions" if pending else "unlock_test",
            "remaining_interventions": len(pending),
            # ISSUE 3 FIX: Return v3 explanations even on correct
            "v3_explanation": {
                "static_explanation": v3_static_explanation,
                "detailed_explanation": v3_detailed_explanation,
                "options_explanation": v3_options_explanation,
                "correct_answer": correct_answer,
                "student_answer": student_answer,
                "question_text": v3_question.get("content", {}).get("question_text", "")
            }
        })

    else:
        # FAILED v3
        tracking["consecutive_failures"] = 3
        tracking["total_failures"] += 1
        tracking["status"] = "struggling"

        # Determine next step based on retest or AI exhaustion
        should_do_ai = not is_retest and not tracking.get("ai_intervention_used", False)

        if should_do_ai:
            next_step = "ai_diagnosis"
        else:
            next_step = "show_explanation_only"

        save_base_tracking(tracking)

        # Build AI diagnosis only if allowed
        diagnosis = None
        if should_do_ai:
            if GEMINI_AVAILABLE and os.environ.get("GEMINI_API_KEY", ""):
                try:
                    import asyncio
                    diagnosis = asyncio.run(call_gemini_diagnosis_enhanced(
                        uid, tracking["concept_id"], base_question_id, tracking, chapter_id
                    ))
                except Exception as e:
                    print(f"Gemini diagnosis failed: {e}")

            if not diagnosis:
                concept_name = tracking.get("concept_id", "this concept").replace("_", " ")
                total_failures = tracking.get("total_failures", 3)
                diagnosis = {
                    "misconception": f"You've answered questions on '{concept_name}' incorrectly {total_failures} time(s). "
                                      f"The core concept may not be fully clear yet.",
                    "explanation": (
                        f"Review the concept explanation carefully. Focus on understanding "
                        f"WHY the correct answer is correct, not just what it is. "
                        f"Look at each option and ask yourself: what biological principle does this test?"
                    ),
                    "memory_trick": (
                        f"For '{concept_name}': try to connect it to something you already know. "
                        f"Think of a real-world example, then map the concept onto it."
                    ),
                    "source": "fallback"
                }

        return jsonify({
            "is_correct": False,
            "next_step": next_step,
            "ai_diagnosis": diagnosis,
            "correct_answer": correct_answer,
            "student_answer": student_answer,
            # ISSUE 3 FIX: Always return v3 explanations
            "v3_explanation": {
                "static_explanation": v3_static_explanation,
                "detailed_explanation": v3_detailed_explanation,
                "options_explanation": v3_options_explanation,
                "correct_answer": correct_answer,
                "student_answer": student_answer,
                "question_text": v3_question.get("content", {}).get("question_text", "")
            },
            "is_retest": is_retest,
            "ai_exhausted": tracking.get("ai_intervention_used", False)
        })


# ---- INTERVENTION: SUBMIT AI QUESTION ----
@app.route("/api/intervention/submit-ai-question", methods=["POST"])
@require_auth
def submit_ai_question():
    """Submit AI-generated custom question. Marks AI as used for this base question."""
    uid = request.uid
    data = request.json

    base_question_id = data.get("base_question_id")
    student_answer = data.get("answer")
    ai_question = data.get("ai_question")
    chapter_id = data.get("chapter_id")

    if not all([base_question_id, student_answer, ai_question, chapter_id]):
        return jsonify({"error": "Missing required fields"}), 400

    # Find correct answer from AI question
    correct_answer = None
    for opt in ai_question.get("options", []):
        if opt.get("is_correct"):
            correct_answer = opt["id"]
            break

    if not correct_answer:
        return jsonify({"error": "Invalid AI question format"}), 500

    is_correct = (student_answer.strip().upper() == correct_answer.strip().upper()) if (student_answer and correct_answer) else False

    # Update tracking
    tracking = get_base_tracking(uid, chapter_id, base_question_id)

    # ISSUE 5: Mark AI intervention as used (once per base question)
    tracking["ai_intervention_used"] = True

    # Log AI question attempt
    tracking.setdefault("interventions", []).append({
        "type": "ai_custom_question",
        "test_num": tracking.get("interventions", [{}])[-1].get("test_num") if tracking.get("interventions") else None,
        "result": "correct" if is_correct else "wrong",
        "student_answer": student_answer,
        "correct_answer": correct_answer,
        "question_text": ai_question.get("question_text", ""),
        "timestamp": datetime.now(timezone.utc).isoformat()
    })

    tracking["variation_history"].append({
        "variation": "ai_custom",
        "test_num": None,
        "result": "correct" if is_correct else "wrong",
        "used_in": "ai_intervention",
        "student_answer": student_answer,
        "correct_answer": correct_answer,
        "question_text": ai_question.get("question_text", "")
    })

    # Build AI question explanation for frontend
    ai_options_explanation = []
    for opt in ai_question.get("options", []):
        ai_options_explanation.append({
            "id": opt.get("id", ""),
            "text": opt.get("text", ""),
            "is_correct": opt.get("is_correct", False),
            "explanation": opt.get("explanation", "")
        })

    if is_correct:
        tracking["consecutive_failures"] = 0
        tracking["status"] = "learning"
        save_base_tracking(tracking)

        # Remove from pending
        progress_ref = db.collection("user_progress").document(f"{uid}_{chapter_id}")
        progress = progress_ref.get().to_dict()

        pending = progress.get("pending_interventions", [])
        pending = [p for p in pending if p.get("base_question_id") != base_question_id]
        next_available = len(pending) == 0

        progress_ref.update({
            "pending_interventions": pending,
            "next_test_available": next_available
        })

        return jsonify({
            "is_correct": True,
            "message": "Excellent! You've mastered this concept.",
            "next_step": "continue_interventions" if pending else "unlock_test",
            "remaining_interventions": len(pending),
            "ai_options_explanation": ai_options_explanation,
            "correct_answer": correct_answer,
            "student_answer": student_answer
        })

    else:
        tracking["consecutive_failures"] = 4
        tracking["status"] = "needs_deep_review"
        save_base_tracking(tracking)

        # Get NCERT reference
        concept_id = tracking.get("concept_id", "")
        ncert_ref = "Review the relevant NCERT chapter section"
        try:
            progress = db.collection("user_progress").document(f"{uid}_{chapter_id}").get().to_dict()
            chapter_id_val = progress.get("chapter_id", "")
            chapter_meta = db.collection("chapter_metadata").document(chapter_id_val).get()
            if chapter_meta.exists:
                concepts = chapter_meta.to_dict().get("concepts_summary", [])
                for c in concepts:
                    if c.get("concept_id") == concept_id:
                        pages = c.get("pages", [])
                        if pages:
                            ncert_ref = f"NCERT pages {', '.join(map(str, pages))}"
                        break
        except Exception as e:
            print(f"Error getting NCERT reference: {e}")

        # Remove from pending
        progress_ref = db.collection("user_progress").document(f"{uid}_{chapter_id}")
        progress = progress_ref.get().to_dict()

        pending = progress.get("pending_interventions", [])
        pending = [p for p in pending if p.get("base_question_id") != base_question_id]
        next_available = len(pending) == 0

        progress_ref.update({
            "pending_interventions": pending,
            "next_test_available": next_available
        })

        return jsonify({
            "is_correct": False,
            "next_step": "force_review",
            "message": "Please revise this concept before continuing.",
            "ncert_reference": ncert_ref,
            "correct_answer": correct_answer,
            "student_answer": student_answer,
            "remaining_interventions": len(pending),
            "recommendation": "Review the concept thoroughly from NCERT, then practice more questions.",
            "ai_options_explanation": ai_options_explanation
        })

async def call_gemini_diagnosis_enhanced(uid, concept_id, base_question_id, tracking, chapter_id):
    """
    Enhanced AI diagnosis that analyzes full v1/v2/v3/AI question history.
    Tells the student exactly WHY they keep getting confused.
    """
    if not GEMINI_AVAILABLE:
        return None

    # Build detailed attempt history
    attempts = []
    for entry in tracking.get("variation_history", []):
        attempts.append({
            "variation": entry.get("variation", ""),
            "result": entry.get("result", ""),
            "student_answer": entry.get("student_answer", ""),
            "correct_answer": entry.get("correct_answer", ""),
            "question_text": entry.get("question_text", "")
        })

    # Get AI intervention history too
    ai_attempts = []
    for entry in tracking.get("interventions", []):
        if entry.get("type") == "ai_custom_question":
            ai_attempts.append({
                "result": entry.get("result", ""),
                "student_answer": entry.get("student_answer", ""),
                "correct_answer": entry.get("correct_answer", ""),
                "question_text": entry.get("question_text", "")
            })

    # Get concept name from chapter metadata
    concept_name = concept_id.replace("_", " ")
    try:
        chapter_meta = db.collection("chapter_metadata").document(chapter_id).get()
        if chapter_meta.exists:
            for c in chapter_meta.to_dict().get("concepts_summary", []):
                if c.get("concept_id") == concept_id:
                    concept_name = c.get("concept_name", concept_name)
                    break
    except:
        pass

    # Detect patterns
    total_attempts = len(attempts) + len(ai_attempts)
    all_wrong = all(a["result"] == "wrong" for a in attempts)
    had_correct_before = any(a["result"] == "correct" for a in attempts)
    is_regression = had_correct_before and attempts[-1]["result"] == "wrong" if attempts else False

    prompt = f"""You are an expert NEET Biology tutor. A student is repeatedly struggling with a specific concept.

CONCEPT: {concept_name} (ID: {concept_id})
BASE QUESTION: {base_question_id}
TOTAL ATTEMPTS: {total_attempts}

=== COMPLETE ATTEMPT HISTORY (v1, v2, v3 variations) ===
{json.dumps(attempts, indent=2)}

=== AI-GENERATED QUESTION ATTEMPTS ===
{json.dumps(ai_attempts, indent=2) if ai_attempts else "None yet"}

=== PATTERN ANALYSIS ===
- All wrong: {all_wrong}
- Had correct answers before: {had_correct_before}
- Regression detected: {is_regression}

YOUR TASK:
Analyze the SPECIFIC pattern across ALL attempts. Look at:
1. What the student chose vs what was correct in EACH attempt
2. Whether the student is making the SAME mistake or DIFFERENT mistakes
3. Whether the student previously understood but is now confused (regression)

Provide your response in JSON format:
{{
    "misconception": "Specific misconception identified from the pattern (1-2 sentences)",
    "pattern_analysis": "Analysis of WHY the student keeps failing — are they confusing two concepts? Misremembering a definition? Applying wrong logic? (2-3 sentences)",
    "explanation": "Clear, simple explanation that directly addresses the identified confusion. Use an analogy if helpful. (3-4 sentences)",
    "memory_trick": "A memorable mnemonic, acronym, or mental image that will help them remember correctly (1-2 sentences)",
    "common_trap": "What trap or distractor keeps catching them, so they can watch out for it (1 sentence)"
    {', "regression_analysis": "Why they understood before but are confused now"' if is_regression else ''}
}}

IMPORTANT: Be specific to their actual wrong answers. Don't give generic advice. Reference the actual options they chose.
"""

    try:
        model = genai.GenerativeModel('gemini-1.5-flash')
        response = model.generate_content(prompt)

        # Clean response text
        response_text = response.text.strip()
        if response_text.startswith("```json"):
            response_text = response_text[7:]
        if response_text.startswith("```"):
            response_text = response_text[3:]
        if response_text.endswith("```"):
            response_text = response_text[:-3]

        diagnosis = json.loads(response_text.strip())

        # Log for cost tracking
        db.collection("ai_interventions").add({
            "user_id": uid,
            "concept_id": concept_id,
            "base_question_id": base_question_id,
            "type": "enhanced_diagnosis",
            "is_regression": is_regression,
            "total_attempts": total_attempts,
            "diagnosis": diagnosis,
            "api_cost": 0.05,
            "timestamp": firestore.SERVER_TIMESTAMP
        })

        return diagnosis

    except Exception as e:
        print(f"Gemini API error: {e}")
        return None

@app.route("/api/intervention/get-full-context", methods=["POST"])
@require_auth
def get_full_intervention_context():
    """Get full question history context for a base question's intervention."""
    uid = request.uid
    data = request.json

    base_question_id = data.get("base_question_id")
    chapter_id = data.get("chapter_id")

    if not all([base_question_id, chapter_id]):
        return jsonify({"error": "Missing required fields"}), 400

    tracking = get_base_tracking(uid, chapter_id, base_question_id)

    # Get all variation questions with full details
    variations = {}
    for var_num in [1, 2, 3]:
        qid = f"{base_question_id}_v{var_num}"
        q_doc = db.collection("questions").document(qid).get()
        if q_doc.exists:
            q = q_doc.to_dict()
            variations[f"v{var_num}"] = {
                "question_id": qid,
                "question_text": q.get("content", {}).get("question_text", ""),
                "options": q.get("content", {}).get("options", []),
                "static_explanation": q.get("solution", {}).get("static_explanation", ""),
                "correct_answer": next(
                    (opt["id"] for opt in q.get("content", {}).get("options", [])
                     if opt.get("is_correct")), None
                )
            }

    return jsonify({
        "base_question_id": base_question_id,
        "concept_id": tracking.get("concept_id", ""),
        "variation_history": tracking.get("variation_history", []),
        "ai_interventions": tracking.get("interventions", []),
        "ai_intervention_used": tracking.get("ai_intervention_used", False),
        "consecutive_failures": tracking.get("consecutive_failures", 0),
        "total_failures": tracking.get("total_failures", 0),
        "variations": variations
    })

# ---- BONUS QUESTIONS ----
@app.route("/api/chapter/<chapter_id>/bonus-questions", methods=["GET"])
@require_auth
def get_bonus_questions(chapter_id):
    """Get bonus pool info (now part of the test sequence)."""
    uid = request.uid
    progress = get_or_create_progress(uid, chapter_id)

    test_plan = progress.get("test_plan", {})
    phase_state = progress.get("phase_state", {})
    active_phase = get_active_phase(test_plan, phase_state)

    if active_phase != ENDURANCE:
        return jsonify({
            "error": f"Complete {active_phase} first",
            "current_phase": active_phase
        }), 400

    # Count available bonus questions
    seen_ids = set(progress.get("seen_question_ids", []))

    v3_docs = db.collection("questions") \
        .where("meta_data.chapter_id", "==", chapter_id) \
        .where("meta_data.pool", "==", "intervention_reserve") \
        .stream()

    v3_unseen = sum(1 for doc in v3_docs if doc.to_dict()["question_id"] not in seen_ids)

    v1v2_docs = db.collection("questions") \
        .where("meta_data.chapter_id", "==", chapter_id) \
        .where("meta_data.pool", "==", "regular") \
        .stream()

    v1v2_unseen = sum(1 for doc in v1v2_docs if doc.to_dict()["question_id"] not in seen_ids)

    return jsonify({
        "v3_unseen": v3_unseen,
        "v1v2_unseen": v1v2_unseen,
        "total_bonus_available": v3_unseen + v1v2_unseen,
        "message": "Bonus Pool is available now."
    })

@app.route("/api/test/session/<session_id>", methods=["GET"])
@require_auth
def get_test_session(session_id):
    """Fetch a completed test session for analysis view."""
    uid = request.uid

    session_doc = db.collection("test_sessions").document(session_id).get()
    if not session_doc.exists:
        return jsonify({"error": "Session not found"}), 404

    session = session_doc.to_dict()

    if session["user_id"] != uid:
        return jsonify({"error": "Unauthorized"}), 403

    # Build question results.
    #
    # This used to return NINE fields per question -- question_id, concept_id,
    # difficulty, question_text, is_correct, student_answer, correct_answer,
    # static_explanation, options_detail -- while generate_test() had already
    # written the full record into this very document. Everything below was
    # sitting in Firestore and simply not handed over, which broke the review
    # screen in four separate ways at once:
    #
    #   * no `enrichment`      -> the one-line cracker, elimination guide,
    #                             confusion pairs, mnemonic and last-day note all
    #                             silently vanished on a re-visit. Students cannot
    #                             retake a passed test, so the review screen IS
    #                             the learning surface -- and it was the one place
    #                             the revision aids were missing.
    #   * `options_detail` only -> the review card reads `options`, so a past test
    #                             showed the question with NO options at all.
    #   * no question_type/list1/list2 -> match questions lost List-I and List-II,
    #                             and `isMatch` was false so opdMatchLetter() could
    #                             not resolve student_answer (a mapping dict) back
    #                             to its option letter -- printing "[object Object]".
    #   * next_test_available hardcoded False, no pass_threshold, no phase
    #                          -> the review screen could not tell a failed test
    #                             from a passed one, so it could not offer a retake.
    #
    # Sending what the document already contains fixes all four. `options` is
    # aliased from options_detail (kept as well, for anything still reading it).
    question_results = []
    for q in session.get("questions", []):
        opts = q.get("options_detail", []) or []
        question_results.append({
            "question_id": q["question_id"],
            "concept_id": q["concept_id"],
            "concept_name": q.get("concept_name", ""),
            "difficulty": q["difficulty"],
            "question_text": q.get("question_text", ""),
            "question_type": q.get("question_type", "single_correct"),
            "variation": q.get("variation_number", 1),
            "base_question_id": q.get("base_question_id", ""),
            "tested_fact": q.get("tested_fact", ""),
            "is_correct": q.get("is_correct"),
            "student_answer": q.get("student_answer"),
            "correct_answer": q["correct_answer"],
            "has_image": q.get("has_image", False),
            "image_url": q.get("image_url"),
            "list1": q.get("list1", []),
            "list2": q.get("list2", []),
            "correct_mapping": q.get("correct_mapping", {}),
            "static_explanation": q.get("static_explanation", ""),
            "detailed_explanation": q.get("detailed_explanation", ""),
            "key_points": q.get("key_points", []),
            "common_mistakes": q.get("common_mistakes", []),
            "source_verbatim": q.get("source_verbatim", ""),
            "ncert_page_quote": q.get("ncert_page_quote", ""),
            "enrichment": q.get("enrichment", {}),
            "options": opts,
            "options_detail": opts,
        })

    pct = session.get("percentage", 0)
    return jsonify({
        "session_id": session_id,
        "test_num": session["test_num"],
        "chapter_id": session["chapter_id"],
        "phase": session.get("phase", ""),
        "is_flex": session.get("is_flex", False),
        "is_retake": session.get("is_retake", False),
        "score": session.get("score", 0),
        "total": session.get("total_questions", 0),
        "percentage": pct,
        "time_taken_seconds": session.get("time_taken_seconds", 0),
        "question_results": question_results,
        "concept_breakdown": [],  # this view is per-test; mastery lives on the chapter page
        "overall_mastery": 0,
        # Real values, not placeholders: the review screen needs them to decide
        # whether to offer a retake for a failed test.
        "pass_threshold": PASS_THRESHOLD,
        "needs_retake": pct < PASS_THRESHOLD,
        "next_test_available": pct >= PASS_THRESHOLD,
    })


# ---- ADMIN: UPLOAD QUESTIONS ----
@app.route("/api/admin/upload-questions", methods=["POST"])
@require_auth
def upload_questions():
    """Upload question bank JSON to Firestore."""
    data = request.json
    
    if not data:
        return jsonify({"error": "No data provided"}), 400
    
    metadata = data.get("metadata", {})
    concepts_summary = data.get("concepts_summary", [])
    questions = data.get("questions", [])
    
    chapter_id = metadata.get("chapter_id", "")
    
    if not chapter_id:
        return jsonify({"error": "chapter_id missing"}), 400
    
    # Save metadata
    chapter_meta = {
        "chapter_id": chapter_id,
        "chapter_title": metadata.get("chapter_title", ""),
        "chapter_number": metadata.get("chapter_number", 1),
        "subject": metadata.get("subject", ""),
        "class": str(metadata.get("class", "11")),
        "total_concepts": metadata.get("total_concepts", 0),
        "total_questions": metadata.get("total_questions", 0),
        "ncert_edition": metadata.get("ncert_edition", ""),
        "concepts_summary": concepts_summary,
        "uploaded_at": firestore.SERVER_TIMESTAMP
    }
    
    db.collection("chapter_metadata").document(chapter_id).set(chapter_meta)
    
    # Set pool tags (v1, v2 = regular, v3 = intervention_reserve)
    batch = db.batch()
    count = 0
    
    for q in questions:
        qid = q.get("question_id", "")
        if not qid:
            continue
        
        # Set pool based on variation
        var_num = q["meta_data"]["variation_number"]
        if var_num in [1, 2]:
            q["meta_data"]["pool"] = "regular"
        elif var_num == 3:
            q["meta_data"]["pool"] = "intervention_reserve"
        
        ref = db.collection("questions").document(qid)
        batch.set(ref, q)
        count += 1
        
        if count % 400 == 0:
            batch.commit()
            batch = db.batch()
    
    if count % 400 != 0:
        batch.commit()
    
    return jsonify({
        "status": "ok",
        "chapter_id": chapter_id,
        "questions_uploaded": count,
        "metadata_saved": True
    })

# ──────────────────────────────────────────────
# STUDY MATERIAL (PDF Library)
# ──────────────────────────────────────────────

@app.route("/api/study/chapters/<subject>/<class_level>", methods=["GET"])
@require_auth
def get_study_chapters(subject, class_level):
    """Get available PDF chapters for a subject/class."""
    try:
        docs = db.collection("subject_pdfs") \
            .where("subject", "==", subject.capitalize()) \
            .where("class_level", "==", str(class_level)) \
            .stream()

        chapters = []
        for doc in docs:
            ch = doc.to_dict()
            chapters.append({
                "chapter_id": ch.get("chapter_id", doc.id),
                "chapter_title": ch.get("chapter_title", ""),
                "chapter_number": ch.get("chapter_number", 0),
                "pdf_url": ch.get("pdf_url", ""),
                "page_count": ch.get("page_count", 0),
                "subject": ch.get("subject", ""),
                "class_level": ch.get("class_level", "")
            })

        chapters.sort(key=lambda x: x.get("chapter_number", 0))
        return jsonify(chapters)

    except Exception as e:
        print(f"Error loading study chapters: {e}")
        return jsonify([])


@app.route("/api/admin/upload-pdf-metadata", methods=["POST"])
@require_auth
def upload_pdf_metadata():
    """
    Register a PDF's metadata in Firestore.
    The actual PDF file should be uploaded to Firebase Storage separately.
    
    Body: {
        "subject": "Biology",
        "class_level": "11",
        "chapter_id": "the_living_world",
        "chapter_title": "The Living World",
        "chapter_number": 1,
        "pdf_url": "https://firebasestorage.googleapis.com/...",
        "page_count": 28
    }
    """
    data = request.json
    if not data:
        return jsonify({"error": "No data provided"}), 400

    required = ["subject", "class_level", "chapter_id", "chapter_title", "pdf_url"]
    for field in required:
        if not data.get(field):
            return jsonify({"error": f"Missing required field: {field}"}), 400

    doc_id = f"{data['subject'].lower()}_{data['class_level']}_{data['chapter_id']}"
    
    pdf_doc = {
        "subject": data["subject"].capitalize(),
        "class_level": str(data["class_level"]),
        "chapter_id": data["chapter_id"],
        "chapter_title": data["chapter_title"],
        "chapter_number": data.get("chapter_number", 0),
        "pdf_url": data["pdf_url"],
        "page_count": data.get("page_count", 0),
        "uploaded_by": request.uid,
        "uploaded_at": firestore.SERVER_TIMESTAMP
    }

    db.collection("subject_pdfs").document(doc_id).set(pdf_doc)

    return jsonify({"status": "ok", "doc_id": doc_id})


# ──────────────────────────────────────────────
# BOOKMARKS
# ──────────────────────────────────────────────

@app.route("/api/study/bookmarks/<chapter_id>", methods=["GET"])
@require_auth
def get_bookmarks(chapter_id):
    """Get user's bookmarks for a chapter."""
    uid = request.uid
    doc_id = f"{uid}_{chapter_id}"
    doc = db.collection("user_bookmarks").document(doc_id).get()

    if doc.exists:
        data = doc.to_dict()
        return jsonify({"bookmarks": data.get("bookmarks", [])})
    
    return jsonify({"bookmarks": []})


@app.route("/api/study/bookmarks", methods=["POST"])
@require_auth
def manage_bookmark():
    """Add or remove a bookmark."""
    uid = request.uid
    data = request.json
    chapter_id = data.get("chapter_id")
    page = data.get("page")
    action = data.get("action", "add")

    if not chapter_id or page is None:
        return jsonify({"error": "chapter_id and page required"}), 400

    doc_id = f"{uid}_{chapter_id}"
    doc_ref = db.collection("user_bookmarks").document(doc_id)
    doc = doc_ref.get()

    bookmarks = []
    if doc.exists:
        bookmarks = doc.to_dict().get("bookmarks", [])

    if action == "add":
        # Add if not already bookmarked
        if not any(b.get("page") == page for b in bookmarks):
            bookmarks.append({
                "page": page,
                "created_at": datetime.now(timezone.utc).isoformat()
            })
    elif action == "remove":
        bookmarks = [b for b in bookmarks if b.get("page") != page]

    doc_ref.set({
        "user_id": uid,
        "chapter_id": chapter_id,
        "bookmarks": bookmarks,
        "updated_at": firestore.SERVER_TIMESTAMP
    })

    return jsonify({"status": "ok", "bookmarks": bookmarks})

# ──────────────────────────────────────────────
# PDF HIGHLIGHTS (Persistent per user per chapter)
# ──────────────────────────────────────────────

@app.route("/api/study/highlights/<chapter_id>", methods=["GET"])
@require_auth
def get_highlights(chapter_id):
    """Get user's highlights for a chapter, optionally filtered by page."""
    uid = request.uid
    page = request.args.get("page", type=int)

    doc_id = f"{uid}_{chapter_id}"
    doc = db.collection("user_highlights").document(doc_id).get()

    if not doc.exists:
        return jsonify({"highlights": []})

    data = doc.to_dict()
    all_highlights = data.get("highlights", [])

    # Filter by page if requested
    if page is not None:
        all_highlights = [h for h in all_highlights if h.get("page") == page]

    return jsonify({"highlights": all_highlights})


@app.route("/api/study/highlights", methods=["POST"])
@require_auth
def manage_highlights():
    """Add or remove a highlight."""
    uid = request.uid
    data = request.json

    chapter_id = data.get("chapter_id")
    action = data.get("action", "add")

    if not chapter_id:
        return jsonify({"error": "chapter_id required"}), 400

    doc_id = f"{uid}_{chapter_id}"
    doc_ref = db.collection("user_highlights").document(doc_id)
    doc = doc_ref.get()

    highlights = []
    if doc.exists:
        highlights = doc.to_dict().get("highlights", [])

    if action == "add":
        highlight = data.get("highlight")
        if not highlight:
            return jsonify({"error": "highlight data required"}), 400

        # Ensure no duplicate
        existing_ids = {h.get("highlight_id") for h in highlights}
        if highlight.get("highlight_id") not in existing_ids:
            highlight["created_at"] = datetime.now(timezone.utc).isoformat()
            highlights.append(highlight)

    elif action == "remove":
        highlight_id = data.get("highlight_id")
        if not highlight_id:
            return jsonify({"error": "highlight_id required"}), 400
        highlights = [h for h in highlights if h.get("highlight_id") != highlight_id]

    elif action == "clear_page":
        page = data.get("page")
        if page is not None:
            highlights = [h for h in highlights if h.get("page") != page]
        else:
            return jsonify({"error": "page number required for clear_page"}), 400

    else:
        return jsonify({"error": f"Unknown action: {action}"}), 400

    doc_ref.set({
        "user_id": uid,
        "chapter_id": chapter_id,
        "highlights": highlights,
        "updated_at": firestore.SERVER_TIMESTAMP
    })

    return jsonify({"status": "ok", "count": len(highlights)})

# ──────────────────────────────────────────────
# REVISION NOTES
# ──────────────────────────────────────────────

@app.route("/api/notes/notebooks", methods=["GET", "POST"])
@require_auth
def manage_notebooks():
    """List or create notebooks."""
    uid = request.uid

    if request.method == "GET":
        docs = db.collection("user_notebooks") \
            .where("user_id", "==", uid) \
            .stream()

        notebooks = []
        for doc in docs:
            nb = doc.to_dict()
            nb["notebook_id"] = doc.id

            # Count notes
            notes_count = 0
            try:
                notes_docs = db.collection("user_notes") \
                    .where("notebook_id", "==", doc.id) \
                    .where("user_id", "==", uid) \
                    .stream()
                notes_count = sum(1 for _ in notes_docs)
            except:
                pass

            nb["notes_count"] = notes_count
            notebooks.append(nb)

        notebooks.sort(key=lambda x: x.get("created_at", "") or "")
        return jsonify({"notebooks": notebooks})

    elif request.method == "POST":
        data = request.json
        title = data.get("title", "").strip()
        nb_type = data.get("type", "custom")

        if not title:
            return jsonify({"error": "Title required"}), 400

        # Check limit (max 6)
        existing = db.collection("user_notebooks") \
            .where("user_id", "==", uid) \
            .stream()
        count = sum(1 for _ in existing)

        if count >= 6:
            return jsonify({"error": "Maximum 6 notebooks allowed"}), 400

        nb_doc = {
            "user_id": uid,
            "title": title,
            "type": nb_type,
            "chapter_id": data.get("chapter_id"),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "updated_at": datetime.now(timezone.utc).isoformat()
        }

        doc_ref = db.collection("user_notebooks").add(nb_doc)
        return jsonify({"status": "ok", "notebook_id": doc_ref[1].id})


@app.route("/api/notes/notebooks/<notebook_id>", methods=["GET", "POST"])
@require_auth
def manage_single_notebook(notebook_id):
    """Get notebook with notes, or delete notebook."""
    uid = request.uid

    if request.method == "POST":
        data = request.json
        action = data.get("action")

        if action == "delete":
            # Delete all notes in this notebook
            notes = db.collection("user_notes") \
                .where("notebook_id", "==", notebook_id) \
                .where("user_id", "==", uid) \
                .stream()

            for note_doc in notes:
                note_doc.reference.delete()

            # Delete notebook
            db.collection("user_notebooks").document(notebook_id).delete()
            return jsonify({"status": "ok"})

        return jsonify({"error": "Unknown action"}), 400

    # GET: return notebook + notes
    nb_doc = db.collection("user_notebooks").document(notebook_id).get()
    if not nb_doc.exists:
        return jsonify({"error": "Notebook not found"}), 404

    nb_data = nb_doc.to_dict()
    if nb_data.get("user_id") != uid:
        return jsonify({"error": "Unauthorized"}), 403

    nb_data["notebook_id"] = notebook_id

    # Get notes
    notes_docs = db.collection("user_notes") \
        .where("notebook_id", "==", notebook_id) \
        .where("user_id", "==", uid) \
        .stream()

    notes = []
    for doc in notes_docs:
        note = doc.to_dict()
        note["note_id"] = doc.id
        notes.append(note)

    # Sort: starred first, then by created_at desc
    notes.sort(key=lambda x: (
        0 if x.get("is_starred") else 1,
        x.get("created_at", "") or ""
    ))
    # Starred first, within each group newest first
    starred = [n for n in notes if n.get("is_starred")]
    unstarred = [n for n in notes if not n.get("is_starred")]
    starred.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    unstarred.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    notes = starred + unstarred

    return jsonify({"notebook": nb_data, "notes": notes})


@app.route("/api/notes/add", methods=["POST"])
@require_auth
def add_note():
    """Add a note to a notebook."""
    uid = request.uid
    data = request.json

    notebook_id = data.get("notebook_id")
    content = data.get("content", "").strip()

    if not notebook_id or not content:
        return jsonify({"error": "notebook_id and content required"}), 400

    # Verify notebook ownership
    nb_doc = db.collection("user_notebooks").document(notebook_id).get()
    if not nb_doc.exists:
        return jsonify({"error": "Notebook not found"}), 404
    if nb_doc.to_dict().get("user_id") != uid:
        return jsonify({"error": "Unauthorized"}), 403

    note_doc = {
        "user_id": uid,
        "notebook_id": notebook_id,
        "content": content,
        "annotation": data.get("annotation"),
        "color_tag": data.get("color_tag", "general"),
        "is_starred": data.get("is_starred", False),
        "source_chapter": data.get("source_chapter"),
        "source_page": data.get("source_page"),
        "created_at": datetime.now(timezone.utc).isoformat()
    }

    doc_ref = db.collection("user_notes").add(note_doc)

    # Update notebook timestamp
    db.collection("user_notebooks").document(notebook_id).update({
        "updated_at": datetime.now(timezone.utc).isoformat()
    })

    return jsonify({"status": "ok", "note_id": doc_ref[1].id})


@app.route("/api/notes/<note_id>", methods=["POST"])
@require_auth
def manage_note(note_id):
    """Delete or star/unstar a note."""
    uid = request.uid
    data = request.json
    action = data.get("action")

    doc_ref = db.collection("user_notes").document(note_id)
    doc = doc_ref.get()

    if not doc.exists:
        return jsonify({"error": "Note not found"}), 404

    note_data = doc.to_dict()
    if note_data.get("user_id") != uid:
        return jsonify({"error": "Unauthorized"}), 403

    if action == "delete":
        doc_ref.delete()
        return jsonify({"status": "ok"})

    elif action == "star":
        doc_ref.update({"is_starred": data.get("is_starred", False)})
        return jsonify({"status": "ok"})

    elif action == "edit":
        new_content = data.get("content", "").strip()
        if not new_content:
            return jsonify({"error": "content required"}), 400
        update_fields = {
            "content": new_content,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        if "annotation" in data:
            update_fields["annotation"] = data.get("annotation")
        if "color_tag" in data:
            update_fields["color_tag"] = data.get("color_tag")
        doc_ref.update(update_fields)
        # Also bump the notebook's updated_at
        db.collection("user_notebooks").document(note_data["notebook_id"]).update({
            "updated_at": datetime.now(timezone.utc).isoformat()
        })
        return jsonify({"status": "ok"})

    return jsonify({"error": "Unknown action"}), 400


@app.route("/api/notes/by-source/<chapter_id>", methods=["GET"])
@require_auth
def get_notes_by_source(chapter_id):
    """Get all notes from a specific source chapter."""
    uid = request.uid

    docs = db.collection("user_notes") \
        .where("user_id", "==", uid) \
        .where("source_chapter", "==", chapter_id) \
        .stream()

    notes = []
    for doc in docs:
        note = doc.to_dict()
        note["note_id"] = doc.id
        notes.append(note)

    notes.sort(key=lambda x: x.get("source_page") or 0)
    return jsonify({"notes": notes})


# ──────────────────────────────────────────────
# AIR LEADERBOARD
# ──────────────────────────────────────────────

@app.route("/api/leaderboard/overall", methods=["GET"])
@require_auth
def leaderboard_overall():
    """Get overall leaderboard ranked by mastery then accuracy."""
    uid = request.uid

    try:
        # Get all users with progress
        all_progress = db.collection("user_progress").stream()

        user_scores = {}  # uid -> aggregated scores

        for doc in all_progress:
            p = doc.to_dict()
            p_uid = p.get("user_id", "")
            if not p_uid:
                continue

            if p_uid not in user_scores:
                user_scores[p_uid] = {
                    "uid": p_uid,
                    "tests_completed": 0,
                    "total_questions": 0,
                    "total_correct": 0,
                    "mastery_sum": 0,
                    "chapter_count": 0
                }

            us = user_scores[p_uid]
            us["tests_completed"] += p.get("tests_completed", 0)

            concept_mastery = p.get("concept_mastery", {})
            for cid, cdata in concept_mastery.items():
                us["total_questions"] += len(cdata.get("questions_seen", []))
                us["total_correct"] += len(cdata.get("questions_correct", []))

            us["mastery_sum"] += p.get("overall_mastery", 0)
            us["chapter_count"] += 1

        # Calculate final scores and get names
        rankings = []
        for p_uid, us in user_scores.items():
            if us["tests_completed"] == 0:
                continue

            accuracy = calculate_mastery_score(us["total_correct"], us["total_questions"])
            overall_mastery = round(us["mastery_sum"] / us["chapter_count"]) if us["chapter_count"] > 0 else 0

            # Get user name
            user_doc = db.collection("users").document(p_uid).get()
            name = "Student"
            if user_doc.exists:
                user_data = user_doc.to_dict()
                name = user_data.get("name", user_data.get("email", "Student"))
                if "@" in name:
                    name = name.split("@")[0]

            rankings.append({
                "uid": p_uid,
                "name": name,
                "tests_completed": us["tests_completed"],
                "total_questions": us["total_questions"],
                "accuracy": accuracy,
                "overall_mastery": overall_mastery,
                "score": overall_mastery * 0.6 + accuracy * 0.4  # Weighted score
            })

        # Sort by weighted score
        rankings.sort(key=lambda x: x["score"], reverse=True)

        # Find current user's rank
        my_rank = None
        for i, r in enumerate(rankings):
            if r["uid"] == uid:
                my_rank = {
                    "rank": i + 1,
                    "name": r["name"],
                    "accuracy": r["accuracy"],
                    "overall_mastery": r["overall_mastery"],
                    "tests_completed": r["tests_completed"]
                }
                break

        return jsonify({
            "rankings": rankings[:50],  # Top 50
            "my_rank": my_rank,
            "my_uid": uid,
            "total_students": len(rankings)
        })

    except Exception as e:
        print(f"Leaderboard error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"rankings": [], "my_rank": None, "my_uid": uid}), 500


@app.route("/api/leaderboard/by-chapter", methods=["GET"])
@require_auth
def leaderboard_by_chapter():
    """Get leaderboard broken down by chapter."""
    uid = request.uid

    try:
        all_progress = db.collection("user_progress").stream()

        user_scores = {}
        for doc in all_progress:
            p = doc.to_dict()
            p_uid = p.get("user_id", "")
            if not p_uid or p.get("tests_completed", 0) == 0:
                continue

            if p_uid not in user_scores:
                user_scores[p_uid] = {
                    "uid": p_uid,
                    "tests_completed": 0,
                    "total_questions": 0,
                    "total_correct": 0,
                    "mastery_sum": 0,
                    "chapter_count": 0,
                    "chapters": []
                }

            us = user_scores[p_uid]
            us["tests_completed"] += p.get("tests_completed", 0)

            concept_mastery = p.get("concept_mastery", {})
            ch_correct = 0
            ch_total = 0
            for cid, cdata in concept_mastery.items():
                seen = len(cdata.get("questions_seen", []))
                correct = len(cdata.get("questions_correct", []))
                us["total_questions"] += seen
                us["total_correct"] += correct
                ch_correct += correct
                ch_total += seen

            us["mastery_sum"] += p.get("overall_mastery", 0)
            us["chapter_count"] += 1

            us["chapters"].append({
                "chapter_id": p.get("chapter_id", ""),
                "chapter_name": p.get("chapter_name", ""),
                "mastery": p.get("overall_mastery", 0),
                "tests": p.get("tests_completed", 0),
                "accuracy": calculate_mastery_score(ch_correct, ch_total)
            })

        rankings = []
        for p_uid, us in user_scores.items():
            if us["tests_completed"] == 0:
                continue

            user_doc = db.collection("users").document(p_uid).get()
            name = "Student"
            if user_doc.exists:
                user_data = user_doc.to_dict()
                name = user_data.get("name", user_data.get("email", "Student"))
                if "@" in name:
                    name = name.split("@")[0]

            accuracy = calculate_mastery_score(us["total_correct"], us["total_questions"])
            overall_mastery = round(us["mastery_sum"] / us["chapter_count"]) if us["chapter_count"] > 0 else 0

            rankings.append({
                "uid": p_uid,
                "name": name,
                "tests_completed": us["tests_completed"],
                "accuracy": accuracy,
                "overall_mastery": overall_mastery,
                "score": overall_mastery * 0.6 + accuracy * 0.4
            })

        rankings.sort(key=lambda x: x["score"], reverse=True)

        my_rank = None
        for i, r in enumerate(rankings):
            if r["uid"] == uid:
                my_rank = {
                    "rank": i + 1,
                    "name": r["name"],
                    "accuracy": r["accuracy"],
                    "overall_mastery": r["overall_mastery"],
                    "tests_completed": r["tests_completed"]
                }
                break

        return jsonify({
            "rankings": rankings[:50],
            "my_rank": my_rank,
            "my_uid": uid,
            "total_students": len(rankings)
        })

    except Exception as e:
        print(f"Chapter leaderboard error: {e}")
        return jsonify({"rankings": [], "my_rank": None, "my_uid": uid}), 500


@app.route("/api/leaderboard/by-accuracy", methods=["GET"])
@require_auth
def leaderboard_by_accuracy():
    """Get leaderboard ranked purely by accuracy."""
    uid = request.uid

    try:
        all_progress = db.collection("user_progress").stream()

        user_scores = {}
        for doc in all_progress:
            p = doc.to_dict()
            p_uid = p.get("user_id", "")
            if not p_uid or p.get("tests_completed", 0) == 0:
                continue

            if p_uid not in user_scores:
                user_scores[p_uid] = {
                    "uid": p_uid,
                    "tests_completed": 0,
                    "total_questions": 0,
                    "total_correct": 0,
                    "mastery_sum": 0,
                    "chapter_count": 0
                }

            us = user_scores[p_uid]
            us["tests_completed"] += p.get("tests_completed", 0)

            for cid, cdata in p.get("concept_mastery", {}).items():
                us["total_questions"] += len(cdata.get("questions_seen", []))
                us["total_correct"] += len(cdata.get("questions_correct", []))

            us["mastery_sum"] += p.get("overall_mastery", 0)
            us["chapter_count"] += 1

        rankings = []
        for p_uid, us in user_scores.items():
            if us["tests_completed"] == 0:
                continue

            user_doc = db.collection("users").document(p_uid).get()
            name = "Student"
            if user_doc.exists:
                user_data = user_doc.to_dict()
                name = user_data.get("name", user_data.get("email", "Student"))
                if "@" in name:
                    name = name.split("@")[0]

            accuracy = calculate_mastery_score(us["total_correct"], us["total_questions"])
            overall_mastery = round(us["mastery_sum"] / us["chapter_count"]) if us["chapter_count"] > 0 else 0

            rankings.append({
                "uid": p_uid,
                "name": name,
                "tests_completed": us["tests_completed"],
                "accuracy": accuracy,
                "overall_mastery": overall_mastery,
                "score": accuracy  # Rank by accuracy only
            })

        rankings.sort(key=lambda x: x["score"], reverse=True)

        my_rank = None
        for i, r in enumerate(rankings):
            if r["uid"] == uid:
                my_rank = {
                    "rank": i + 1,
                    "name": r["name"],
                    "accuracy": r["accuracy"],
                    "overall_mastery": r["overall_mastery"],
                    "tests_completed": r["tests_completed"]
                }
                break

        return jsonify({
            "rankings": rankings[:50],
            "my_rank": my_rank,
            "my_uid": uid,
            "total_students": len(rankings)
        })

    except Exception as e:
        print(f"Accuracy leaderboard error: {e}")
        return jsonify({"rankings": [], "my_rank": None, "my_uid": uid}), 500


# ──────────────────────────────────────────────
# PROFILE ENHANCED
# ──────────────────────────────────────────────

@app.route("/api/user/update-profile", methods=["POST"])
@require_auth
def update_profile():
    """Update user profile fields."""
    uid = request.uid
    data = request.json

    update_fields = {}
    allowed = ["name", "phone", "school", "city", "class_level", "target_exam"]

    for field in allowed:
        if field in data:
            update_fields[field] = data[field]

    if not update_fields:
        return jsonify({"error": "No fields to update"}), 400

    update_fields["updated_at"] = firestore.SERVER_TIMESTAMP

    db.collection("users").document(uid).set(update_fields, merge=True)

    return jsonify({"status": "ok"})


# ──────────────────────────────────────────────
# ACCOUNT  ·  onboarding + profile (additive)
# ──────────────────────────────────────────────
# These three routes are ADDITIVE. /api/user/register, /api/user/profile
# and /api/user/update-profile are untouched and keep working exactly as
# before; nothing that already reads users/{uid} sees a changed shape.
#
# Everything written here is optional except onboarding_completed. A
# student who fills in nothing is a valid student.

# Fields the client is allowed to write to users/{uid}. Anything else in
# the request body is ignored, silently — the client is never trusted to
# name its own Firestore fields.
ACCOUNT_TEXT_FIELDS = [
    "name",
    "photo_url",
    "guardian_name",
    "guardian_phone",
    "guardian_email",
    "school_id",          # identifies the school
    "class_id",           # identifies the section inside it, e.g. "12-A"
    # The school's own roll / admission number. A printed class report is
    # sorted and cross-checked on this, not on the name -- two students
    # called Priya S. in one section is the normal case, not the edge one.
    "roll_no",
    "class_level",        # "11" | "12" | "dropper"
    "dream_college",
    "neet_attempt_number",
    "neet_hall_ticket",
    "onboarding_source",
    "onboarding_source_other",
    "target_exam",
]

ACCOUNT_INT_FIELDS = {
    # field: (min, max)
    "neet_target_year": (2020, 2040),
    "neet_target_score": (0, 720),
}

# Never writable from the client: uid, email, role, subscription,
# free_chapters, created_at. Email lives in Firebase Auth and is the
# login identity; role and subscription decide access.

MAX_TEXT_LEN = 200


@app.route("/api/user/account", methods=["GET"])
@require_auth
def get_account():
    """
    Profile + onboarding state for the current user.

    Auto-creates the document if it is missing, for exactly the same
    reason get_dashboard() does: a user can exist in Firebase Auth and
    not yet in Firestore, and that must not be a 404 the student sees.
    """
    uid = request.uid
    user = get_user_doc(uid)

    if not user:
        user = {
            "uid": uid,
            "email": request.user_email,
            "name": (request.user_email or "Student").split("@")[0],
            "role": "student",
            "class_level": "11",
            "target_exam": "NEET",
            "subscription": {"plan": "free", "expiry": None, "subjects_unlocked": []},
            "free_chapters": ["the_living_world", "biological_classification"],
            "onboarding_completed": False,
            "created_at": firestore.SERVER_TIMESTAMP,
            "updated_at": firestore.SERVER_TIMESTAMP,
        }
        db.collection("users").document(uid).set(user, merge=True)

    out = clean_firestore_data(user)
    out.setdefault("onboarding_completed", False)
    # The auth email is the source of truth, whatever the doc says.
    out["email"] = request.user_email or out.get("email", "")
    return jsonify(out)


@app.route("/api/user/account/save", methods=["POST"])
@require_auth
def save_account():
    """
    Merge whitelisted profile fields into users/{uid}.

    Used by three callers: signup.html (guardian phone + NEET year),
    onboarding.js (source + goals + the completion flag), and profile.js
    (everything else). A field sent as an empty string or null is
    cleared; a field not sent is left alone.
    """
    uid = request.uid
    data = request.json or {}
    update = {}

    for field in ACCOUNT_TEXT_FIELDS:
        if field not in data:
            continue
        value = data[field]
        if value is None:
            update[field] = ""
            continue
        update[field] = str(value).strip()[:MAX_TEXT_LEN]

    for field, (lo, hi) in ACCOUNT_INT_FIELDS.items():
        if field not in data:
            continue
        value = data[field]
        if value in (None, ""):
            update[field] = None
            continue
        try:
            n = int(value)
        except (TypeError, ValueError):
            return jsonify({"error": f"{field} must be a number"}), 400
        if not (lo <= n <= hi):
            return jsonify({"error": f"{field} must be between {lo} and {hi}"}), 400
        update[field] = n

    if "onboarding_completed" in data:
        done = bool(data["onboarding_completed"])
        update["onboarding_completed"] = done
        if done:
            update["onboarded_at"] = firestore.SERVER_TIMESTAMP

    # Guardian phone: store digits only, so the teacher dashboard and any
    # future SMS provider never have to guess at "+91 " prefixes.
    if "guardian_phone" in update and update["guardian_phone"]:
        digits = "".join(ch for ch in update["guardian_phone"] if ch.isdigit())
        if not (10 <= len(digits) <= 15):
            return jsonify({"error": "guardian_phone must be 10-15 digits"}), 400
        update["guardian_phone"] = digits

    # School and section codes are matched against the teacher dashboard,
    # so they are normalised once here rather than at every read site.
    for code in ("school_id", "class_id"):
        if code in update and update[code]:
            update[code] = update[code].upper().replace(" ", "")

    # A roll number pasted off a school register arrives as " 24 ". The
    # printed class report sorts on this field, so it is trimmed once
    # here rather than at every read site.
    if "roll_no" in update:
        update["roll_no"] = str(update["roll_no"] or "").strip()[:16]

    if not update:
        return jsonify({"error": "No fields to update"}), 400

    update["updated_at"] = firestore.SERVER_TIMESTAMP
    db.collection("users").document(uid).set(update, merge=True)

    # The teacher portal reads student_rollups, never users. Without this
    # a corrected name, guardian number or roll number stayed invisible to
    # the teacher until the student next sat a test.
    mirrored = mirror_identity(uid, update)

    return jsonify({"status": "ok", "updated": sorted(update.keys()),
                    "mirrored": mirrored})


@app.route("/api/user/review", methods=["POST"])
@require_auth
def save_review():
    """
    One review per student, overwritable. Kept in its own collection so
    reviews can be read and exported without touching user documents; a
    copy of the star count is mirrored onto users/{uid} so the profile
    screen can render without a second read.
    """
    uid = request.uid
    data = request.json or {}

    try:
        stars = int(data.get("stars", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "stars must be a number"}), 400
    if not (1 <= stars <= 5):
        return jsonify({"error": "stars must be between 1 and 5"}), 400

    text = str(data.get("text", "")).strip()[:600]
    user = get_user_doc(uid) or {}

    db.collection("app_reviews").document(uid).set({
        "uid": uid,
        "name": user.get("name", ""),
        "email": request.user_email,
        "stars": stars,
        "text": text,
        "platform": str(data.get("platform", ""))[:40],
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)

    db.collection("users").document(uid).set({
        "app_review_stars": stars,
        "app_review_text": text,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }, merge=True)

    return jsonify({"status": "ok", "stars": stars})


@app.route("/api/user/stats", methods=["GET"])
@require_auth
def get_user_stats():
    """Get aggregated user stats for profile page."""
    uid = request.uid

    try:
        progress_docs = db.collection("user_progress") \
            .where("user_id", "==", uid) \
            .stream()

        total_tests = 0
        total_questions = 0
        total_correct = 0
        last_dates = []

        for doc in progress_docs:
            p = doc.to_dict()
            total_tests += p.get("tests_completed", 0)

            for cid, cdata in p.get("concept_mastery", {}).items():
                total_questions += len(cdata.get("questions_seen", []))
                total_correct += len(cdata.get("questions_correct", []))

            # Collect test dates for streak
            for t in p.get("test_history", []):
                if t.get("completed_at"):
                    last_dates.append(t["completed_at"])

        accuracy = calculate_mastery_score(total_correct, total_questions)

        # Calculate streak (consecutive days with tests)
        study_streak = 0
        if last_dates:
            dates_set = set()
            for d in last_dates:
                try:
                    if isinstance(d, str):
                        dt = datetime.fromisoformat(d.replace('Z', '+00:00'))
                    else:
                        dt = d
                    dates_set.add(dt.date())
                except:
                    pass

            if dates_set:
                today = datetime.now(timezone.utc).date()
                current = today
                while current in dates_set:
                    study_streak += 1
                    current = current - __import__('datetime').timedelta(days=1)

        return jsonify({
            "total_tests": total_tests,
            "total_questions": total_questions,
            "accuracy": accuracy,
            "study_streak": study_streak
        })

    except Exception as e:
        print(f"Stats error: {e}")
        return jsonify({
            "total_tests": 0,
            "total_questions": 0,
            "accuracy": 0,
            "study_streak": 0
        })


# ─────────────────────────────────────────────────────────────────────────────
# NEET MARKS → AIR LOOKUP TABLE
# Sources:
#   - NTA Official Results 2025: neet.nta.nic.in
#   - Shiksha.com marks-vs-rank analysis (2020-2025)
#   - CollegeDekho NEET marks vs rank (2022-2025)
#   - Careers360 NEET cutoff data
#   - Studocu NEET 2022 official NTA data table
# Each entry: (min_marks, max_marks, approx_air_open, approx_air_close)
# ─────────────────────────────────────────────────────────────────────────────
 
NEET_MARKS_VS_RANK = {
    2025: [
        # (min, max, air_open, air_close)  — based on NTA 2025 result + Shiksha/CollegeDekho
        (686, 720, 1,       1),
        (680, 685, 2,       10),
        (670, 679, 11,      50),
        (660, 669, 51,      100),
        (650, 659, 101,     170),
        (640, 649, 171,     350),
        (630, 639, 351,     700),
        (620, 629, 701,     1260),
        (610, 619, 1261,    3000),
        (600, 609, 3001,    5000),
        (590, 599, 5001,    8000),
        (580, 589, 8001,    11000),
        (570, 579, 11001,   15000),
        (560, 569, 15001,   20000),
        (550, 559, 20001,   25000),
        (540, 549, 25001,   32000),
        (530, 539, 32001,   39522),
        (520, 529, 39523,   47000),
        (510, 519, 47001,   55000),
        (500, 509, 55001,   65000),
        (490, 499, 65001,   75000),
        (480, 489, 75001,   85000),
        (470, 479, 85001,   95000),
        (460, 469, 95001,   105000),
        (450, 459, 105001,  115000),
        (440, 449, 115001,  126000),
        (430, 439, 126001,  138000),
        (420, 429, 138001,  150000),
        (410, 419, 150001,  163000),
        (400, 409, 163001,  177000),
        (380, 399, 177001,  205000),
        (360, 379, 205001,  235000),
        (340, 359, 235001,  265000),
        (320, 339, 265001,  295000),
        (300, 319, 295001,  328000),
        (280, 299, 328001,  362000),
        (260, 279, 362001,  400000),
        (240, 259, 400001,  440000),
        (220, 239, 440001,  480000),
        (200, 219, 480001,  520000),
        (180, 199, 520001,  560000),
        (160, 179, 560001,  595000),
        (144, 159, 595001,  630000),
        (113, 143, 630001,  1200000),
        (0,   112, 1200001, 2200000),
    ],
    2024: [
        # Top score was 720 (17 students). Source: Aakash/Shiksha NTA 2024 data
        (720, 720, 1,       17),
        (710, 719, 18,      100),
        (700, 709, 101,     350),
        (690, 699, 351,     800),
        (680, 689, 801,     1500),
        (670, 679, 1501,    2500),
        (660, 669, 2501,    4000),
        (650, 659, 4001,    6500),
        (640, 649, 6501,    10000),
        (630, 639, 10001,   15000),
        (620, 629, 15001,   21000),
        (610, 619, 21001,   28000),
        (600, 609, 28001,   38000),
        (590, 599, 38001,   50000),
        (580, 589, 50001,   63000),
        (570, 579, 63001,   78000),
        (560, 569, 78001,   93000),
        (550, 559, 93001,   110000),
        (540, 549, 110001,  128000),
        (530, 539, 128001,  148000),
        (520, 529, 148001,  170000),
        (510, 519, 170001,  193000),
        (500, 509, 193001,  218000),
        (480, 499, 218001,  270000),
        (460, 479, 270001,  325000),
        (440, 459, 325001,  385000),
        (420, 439, 385001,  450000),
        (400, 419, 450001,  520000),
        (360, 399, 520001,  620000),
        (320, 359, 620001,  720000),
        (280, 319, 720001,  840000),
        (240, 279, 840001,  970000),
        (200, 239, 970001,  1100000),
        (162, 199, 1100001, 1300000),
        (127, 161, 1300001, 1800000),
        (0,   126, 1800001, 2400000),
    ],
    2023: [
        # Top score 720 (2 students). Source: Shiksha/Studocu NTA 2023 data
        (720, 720, 1,       2),
        (715, 719, 3,       67),
        (710, 714, 68,      200),
        (700, 709, 201,     700),
        (690, 699, 701,     1400),
        (680, 689, 1401,    2500),
        (670, 679, 2501,    4200),
        (660, 669, 4201,    6500),
        (650, 659, 6501,    9500),
        (640, 649, 9501,    14000),
        (630, 639, 14001,   19500),
        (620, 629, 19501,   26500),
        (610, 619, 26501,   35000),
        (600, 609, 35001,   45000),
        (590, 599, 45001,   57000),
        (580, 589, 57001,   70000),
        (570, 579, 70001,   85000),
        (560, 569, 85001,   100000),
        (550, 559, 100001,  116000),
        (540, 549, 116001,  133000),
        (530, 539, 133001,  152000),
        (520, 529, 152001,  172000),
        (510, 519, 172001,  193000),
        (500, 509, 193001,  216000),
        (480, 499, 216001,  265000),
        (460, 479, 265001,  316000),
        (440, 459, 316001,  372000),
        (420, 439, 372001,  430000),
        (400, 419, 430001,  493000),
        (360, 399, 493001,  630000),
        (320, 359, 630001,  780000),
        (280, 319, 780001,  940000),
        (240, 279, 940001,  1100000),
        (200, 239, 1100001, 1270000),
        (137, 199, 1270001, 1500000),
        (107, 136, 1500001, 2000000),
        (0,   106, 2000001, 2400000),
    ],
    2022: [
        # Top score 715 (no perfect score). Source: Studocu official NTA table
        (715, 720, 1,       1),
        (710, 714, 2,       23),
        (700, 709, 24,      204),
        (690, 699, 205,     522),
        (680, 689, 523,     992),
        (670, 679, 993,     1702),
        (660, 669, 1703,    2759),
        (650, 659, 2760,    4170),
        (640, 649, 4171,    6065),
        (630, 639, 6066,    8535),
        (620, 629, 8536,    11464),
        (610, 619, 11465,   15070),
        (600, 609, 15071,   19141),
        (590, 599, 19142,   23733),
        (580, 589, 23734,   28752),
        (570, 579, 28753,   34269),
        (560, 569, 34270,   40262),
        (550, 559, 40263,   46754),
        (540, 549, 46755,   53546),
        (530, 539, 53547,   60855),
        (520, 529, 60856,   68448),
        (510, 519, 68449,   76500),
        (500, 509, 76501,   85032),
        (490, 499, 85033,   93996),
        (480, 489, 93997,   103369),
        (470, 479, 103370,  113233),
        (460, 469, 113234,  123346),
        (450, 459, 123347,  133919),
        (440, 449, 133920,  144916),
        (430, 439, 144917,  156204),
        (420, 429, 156205,  168039),
        (410, 419, 168040,  180312),
        (400, 409, 180313,  193048),
        (380, 399, 193049,  219770),
        (360, 379, 219771,  248480),
        (340, 359, 248481,  278863),
        (320, 339, 278864,  311297),
        (300, 319, 311298,  345964),
        (280, 299, 345965,  380000),
        (260, 279, 380001,  415000),
        (240, 259, 415001,  450000),
        (220, 239, 450001,  490000),
        (200, 219, 490001,  530000),
        (180, 199, 530001,  570000),
        (160, 179, 570001,  610000),
        (117, 159, 610001,  700000),
        (93,  116, 700001,  1534697),
        (0,    92, 1534698, 2200000),
    ],
}
 
# Qualifying cutoff marks by year and category
# Source: NTA official results released alongside NEET scorecards
NEET_QUALIFYING_CUTOFF = {
    2025: {"General": 144, "OBC": 113, "SC": 113, "ST": 113, "EWS": 144},
    2024: {"General": 162, "OBC": 127, "SC": 127, "ST": 127, "EWS": 162},
    2023: {"General": 137, "OBC": 107, "SC": 107, "ST": 107, "EWS": 137},
    2022: {"General": 117, "OBC": 93,  "SC": 93,  "ST": 93,  "EWS": 117},
    2021: {"General": 138, "OBC": 108, "SC": 108, "ST": 108, "EWS": 138},
    2020: {"General": 147, "OBC": 113, "SC": 113, "ST": 113, "EWS": 147},
}
 
# ─────────────────────────────────────────────────────────────────────────────
# COLLEGE PREDICTOR DATA
# AIQ closing ranks for General category — based on MCC NEET counselling data
# Sources: MCC.nic.in seat allotment results, Shiksha/Careers360 college predictors
# ─────────────────────────────────────────────────────────────────────────────
 
COLLEGE_DATA = [
    # (college_name, city, state, closing_air_general, closing_air_obc, closing_air_sc, closing_air_st, type, seats)
    ("AIIMS New Delhi",                     "New Delhi",    "Delhi",            50,      200,    500,    800,    "Government", 107),
    ("AIIMS Jodhpur",                       "Jodhpur",      "Rajasthan",        500,     1500,   3000,   5000,   "Government", 100),
    ("AIIMS Bhopal",                        "Bhopal",       "Madhya Pradesh",   700,     2000,   4000,   6500,   "Government", 100),
    ("AIIMS Patna",                         "Patna",        "Bihar",            900,     2500,   5000,   8000,   "Government", 100),
    ("AIIMS Raipur",                        "Raipur",       "Chhattisgarh",     1100,    3000,   6000,   9000,   "Government", 100),
    ("AIIMS Rishikesh",                     "Rishikesh",    "Uttarakhand",      800,     2200,   4500,   7000,   "Government", 100),
    ("AIIMS Bhubaneswar",                   "Bhubaneswar",  "Odisha",           1300,    3500,   7000,   10000,  "Government", 100),
    ("AIIMS Nagpur",                        "Nagpur",       "Maharashtra",      1500,    4000,   8000,   12000,  "Government", 100),
    ("AIIMS Mangalagiri",                   "Mangalagiri",  "Andhra Pradesh",   1800,    4500,   9000,   13000,  "Government", 100),
    ("AIIMS Gorakhpur",                     "Gorakhpur",    "Uttar Pradesh",    2000,    5000,   10000,  15000,  "Government", 100),
    ("Maulana Azad Medical College",        "New Delhi",    "Delhi",            1500,    4000,   8000,   12000,  "Government", 250),
    ("University College of Medical Sci.",  "New Delhi",    "Delhi",            2000,    5000,   10000,  15000,  "Government", 250),
    ("Lady Hardinge Medical College",       "New Delhi",    "Delhi",            2500,    6000,   12000,  18000,  "Government", 200),
    ("Grant Medical College",               "Mumbai",       "Maharashtra",      4000,    9000,   18000,  25000,  "Government", 195),
    ("Seth GS Medical College",             "Mumbai",       "Maharashtra",      4500,    10000,  20000,  28000,  "Government", 180),
    ("Madras Medical College",              "Chennai",      "Tamil Nadu",       5000,    11000,  22000,  30000,  "Government", 250),
    ("Stanley Medical College",             "Chennai",      "Tamil Nadu",       6000,    13000,  25000,  35000,  "Government", 235),
    ("Kilpauk Medical College",             "Chennai",      "Tamil Nadu",       7000,    15000,  28000,  40000,  "Government", 200),
    ("SMS Medical College",                 "Jaipur",       "Rajasthan",        6000,    13000,  25000,  35000,  "Government", 250),
    ("RNT Medical College",                 "Udaipur",      "Rajasthan",        18000,   35000,  60000,  80000,  "Government", 150),
    ("KGMU",                                "Lucknow",      "Uttar Pradesh",    7000,    15000,  28000,  40000,  "Government", 250),
    ("BHU Institute of Medical Sciences",   "Varanasi",     "Uttar Pradesh",    8000,    17000,  32000,  45000,  "Government", 100),
    ("MLN Medical College",                 "Prayagraj",    "Uttar Pradesh",    20000,   40000,  70000,  90000,  "Government", 150),
    ("GMCH Chandigarh",                     "Chandigarh",   "Punjab",           8000,    17000,  32000,  45000,  "Government", 150),
    ("Osmania Medical College",             "Hyderabad",    "Telangana",        10000,   20000,  38000,  52000,  "Government", 200),
    ("Guntur Medical College",              "Guntur",       "Andhra Pradesh",   15000,   30000,  55000,  75000,  "Government", 200),
    ("BMCRI Bangalore",                     "Bangalore",    "Karnataka",        12000,   25000,  45000,  62000,  "Government", 250),
    ("Mysore Medical College",              "Mysore",       "Karnataka",        18000,   36000,  62000,  85000,  "Government", 200),
    ("Govt Medical College Kozhikode",      "Kozhikode",    "Kerala",           13000,   27000,  48000,  65000,  "Government", 150),
    ("Govt Medical College Trivandrum",     "Trivandrum",   "Kerala",           14000,   28000,  50000,  68000,  "Government", 150),
    ("GMERS Medical College Gandhinagar",   "Gandhinagar",  "Gujarat",          15000,   30000,  55000,  75000,  "Government", 200),
    ("BJ Medical College Ahmedabad",        "Ahmedabad",    "Gujarat",          16000,   32000,  58000,  80000,  "Government", 200),
    ("Coimbatore Medical College",          "Coimbatore",   "Tamil Nadu",       18000,   36000,  62000,  85000,  "Government", 200),
    ("Indira Gandhi Medical College",       "Shimla",       "Himachal Pradesh", 20000,   40000,  70000,  90000,  "Government", 100),
    ("Pt BD Sharma PGIMS",                  "Rohtak",       "Haryana",          12000,   25000,  45000,  62000,  "Government", 200),
    ("ESIC Medical College",                "Hyderabad",    "Telangana",        22000,   42000,  72000,  95000,  "Government", 100),
    ("Nalanda Medical College",             "Patna",        "Bihar",            25000,   48000,  80000,  105000, "Government", 150),
    ("JNMC Wardha (Deemed)",                "Wardha",       "Maharashtra",      35000,   65000,  100000, 130000, "Deemed",     150),
    ("Kasturba Medical College Manipal",    "Manipal",      "Karnataka",        30000,   58000,  90000,  118000, "Private",    250),
    ("Kasturba Medical College Mangalore",  "Mangalore",    "Karnataka",        32000,   62000,  95000,  125000, "Private",    200),
    ("JSS Medical College",                 "Mysore",       "Karnataka",        38000,   70000,  108000, 140000, "Private",    150),
    ("Amrita Institute of Medical Sci.",    "Kochi",        "Kerala",           40000,   75000,  115000, 150000, "Private",    200),
    ("Sri Ramachandra Med College",         "Chennai",      "Tamil Nadu",       45000,   85000,  130000, 165000, "Private",    150),
    ("Christian Medical College Vellore",   "Vellore",      "Tamil Nadu",       500,     1500,   3000,   5000,   "Private",    100),
    ("Armed Forces Medical College",        "Pune",         "Maharashtra",      600,     1800,   3500,   6000,   "Government", 150),
    ("Vardhman Mahavir Medical College",    "New Delhi",    "Delhi",            3000,    7000,   14000,  20000,  "Government", 200),
    ("Atal Bihari Vajpayee AIIMS",          "Bhopal",       "Madhya Pradesh",   700,     2000,   4000,   6500,   "Government", 100),
    ("JIPMER",                              "Puducherry",   "Puducherry",       1000,    2800,   5500,   8500,   "Government", 200),
    ("PGIMER Chandigarh",                   "Chandigarh",   "Punjab",           200,     600,    1200,   2000,   "Government", 60),
    ("Govt Medical College Nagpur",         "Nagpur",       "Maharashtra",      22000,   42000,  72000,  95000,  "Government", 200),
    ("Sanjay Gandhi PGI (MBBS)",            "Lucknow",      "Uttar Pradesh",    9000,    19000,  36000,  50000,  "Government", 100),
    ("Jawaharlal Nehru Medical College",    "Aligarh",      "Uttar Pradesh",    11000,   22000,  42000,  58000,  "Government", 100),
    ("DY Patil Medical College Pune",       "Pune",         "Maharashtra",      55000,   100000, 150000, 180000, "Private",    150),
    ("MGM Medical College Mumbai",          "Mumbai",       "Maharashtra",      60000,   110000, 160000, 190000, "Private",    150),
    ("Sri Siddhartha Medical College",      "Tumkur",       "Karnataka",        50000,   90000,  138000, 170000, "Private",    150),
    ("Saveetha Medical College",            "Chennai",      "Tamil Nadu",       65000,   120000, 170000, 200000, "Private",    150),
    ("Shri Atal Bihari Vajpayee GMC",       "Chhindwara",   "Madhya Pradesh",   30000,   58000,  90000,  118000, "Government", 100),
    ("Govt Medical College Thrissur",       "Thrissur",     "Kerala",           16000,   32000,  58000,  80000,  "Government", 100),
    ("Medical College Thiruvananthapuram",  "Trivandrum",   "Kerala",           15000,   30000,  54000,  73000,  "Government", 160),
    ("Guru Gobind Singh Medical College",   "Faridkot",     "Punjab",           25000,   48000,  80000,  105000, "Government", 100),
    ("GMC Patiala",                         "Patiala",      "Punjab",           20000,   40000,  70000,  92000,  "Government", 150),
    ("Pt JNM Medical College Raipur",       "Raipur",       "Chhattisgarh",     28000,   54000,  88000,  115000, "Government", 100),
    ("Rajendra Institute of Med Sci",       "Ranchi",       "Jharkhand",        35000,   65000,  100000, 130000, "Government", 100),
    ("Gauhati Medical College",             "Guwahati",     "Assam",            35000,   65000,  100000, 132000, "Government", 100),
    ("Assam Medical College",               "Dibrugarh",    "Assam",            40000,   75000,  115000, 150000, "Government", 100),
    ("Silchar Medical College",             "Silchar",      "Assam",            45000,   85000,  130000, 165000, "Government", 80),
    ("Regional Institute of Medical Sci",   "Imphal",       "Manipur",          55000,   100000, 150000, 180000, "Government", 100),
    ("Jawaharlal Nehru IMR Imphal",         "Imphal",       "Manipur",          60000,   110000, 160000, 190000, "Government", 100),
    ("NEIGRIHMS",                           "Shillong",     "Meghalaya",        18000,   36000,  62000,  85000,  "Government", 50),
    ("Nagaland Inst of Med Sci",            "Kohima",       "Nagaland",         26178,   50000,  85000,  110000, "Government", 60),
    ("Indira Gandhi Govt Med College",      "Nagpur",       "Maharashtra",      26000,   50000,  85000,  110000, "Government", 150),
    ("Sri Venkateswara Med College",        "Tirupati",     "Andhra Pradesh",   35000,   65000,  100000, 130000, "Private",    150),
    ("Kurnool Medical College",             "Kurnool",      "Andhra Pradesh",   25000,   48000,  80000,  105000, "Government", 200),
    ("Andhra Medical College",              "Visakhapatnam","Andhra Pradesh",   18000,   36000,  62000,  85000,  "Government", 250),
    ("Chalmeda Anand Rao Inst",             "Karimnagar",   "Telangana",        40000,   75000,  115000, 150000, "Private",    150),
    ("ESIC Medical College Kolkata",        "Kolkata",      "West Bengal",      22000,   42000,  72000,  95000,  "Government", 100),
    ("Medical College Kolkata",             "Kolkata",      "West Bengal",      15000,   30000,  54000,  73000,  "Government", 250),
    ("RG Kar Medical College",              "Kolkata",      "West Bengal",      18000,   36000,  62000,  85000,  "Government", 210),
    ("NRS Medical College",                 "Kolkata",      "West Bengal",      20000,   40000,  70000,  92000,  "Government", 210),
    ("IPGMER Kolkata",                      "Kolkata",      "West Bengal",      10000,   20000,  38000,  52000,  "Government", 100),
    ("GMC Bettiah",                         "Bettiah",      "Bihar",            30000,   58000,  90000,  118000, "Government", 100),
    ("Darbhanga Medical College",           "Darbhanga",    "Bihar",            32000,   62000,  95000,  125000, "Government", 150),
    ("IGIMS Patna",                         "Patna",        "Bihar",            20000,   40000,  70000,  92000,  "Government", 100),
    ("VIMS Bellary",                        "Bellary",      "Karnataka",        22000,   42000,  72000,  95000,  "Government", 150),
    ("KIMS Hubli",                          "Hubli",        "Karnataka",        25000,   48000,  80000,  105000, "Government", 150),
    ("Hassan Institute of Med Sci",         "Hassan",       "Karnataka",        30000,   58000,  90000,  118000, "Government", 100),
    ("Govt Kilpauk Med College Chennai",    "Chennai",      "Tamil Nadu",       7000,    15000,  28000,  40000,  "Government", 200),
    ("Thanjavur Medical College",           "Thanjavur",    "Tamil Nadu",       20000,   40000,  70000,  92000,  "Government", 200),
    ("Tirunelveli Medical College",         "Tirunelveli",  "Tamil Nadu",       22000,   42000,  72000,  95000,  "Government", 200),
    ("Chengalpattu Medical College",        "Chengalpattu", "Tamil Nadu",       25000,   48000,  80000,  105000, "Government", 200),
    ("Pondicherry Inst of Medical Sci",     "Puducherry",   "Puducherry",       35000,   65000,  100000, 130000, "Private",    150),
    ("Mahatma Gandhi Medical College",      "Puducherry",   "Puducherry",       38000,   70000,  108000, 140000, "Private",    150),
    ("SVIMS Tirupati",                      "Tirupati",     "Andhra Pradesh",   22000,   42000,  72000,  95000,  "Government", 100),
    ("GMC Srinagar",                        "Srinagar",     "J&K",              28000,   54000,  88000,  115000, "Government", 100),
    ("GMC Jammu",                           "Jammu",        "J&K",              30000,   58000,  90000,  118000, "Government", 100),
    ("SKIMS Srinagar",                      "Srinagar",     "J&K",              12000,   25000,  45000,  62000,  "Government", 80),
    ("GMCH Guwahati",                       "Guwahati",     "Assam",            38000,   70000,  108000, 140000, "Government", 100),
    ("Shyam Shah Medical College Rewa",     "Rewa",         "Madhya Pradesh",   28000,   54000,  88000,  115000, "Government", 150),
    ("MGM Medical College Indore",          "Indore",       "Madhya Pradesh",   25000,   48000,  80000,  105000, "Government", 200),
    ("GR Medical College Gwalior",          "Gwalior",      "Madhya Pradesh",   30000,   58000,  90000,  118000, "Government", 150),
]
 
 
# ─────────────────────────────────────────────────────────────────────────────
# COLLEGE PREDICTOR — FIRESTORE VERSION
# Reads from Firestore 'neet_colleges' collection.
# Document schema matches neet_colleges_2025_expanded.json
# Falls back to static COLLEGE_DATA if collection is empty.
# ─────────────────────────────────────────────────────────────────────────────

# Most recent counselling year — used when paper year is older (e.g. 2022 paper)
LATEST_COLLEGE_YEAR = 2025


def _get_aiq_closing_rank(college_doc: dict, category: str) -> int:
    """
    Extract the All India Rank closing rank for a given category.
    Prefers aiq_final_2025 (last round) over aiq (round 1).

    Firestore field: aiq        {"UR": 695, "OBC": 1850, "EWS": 1400, "SC": 5200, "ST": 8000}
    Firestore field: aiq_final_2025  {"UR": 1296, "OBC": 2100, ...}
    """
    cat_key_map = {
        "General": "UR",
        "Obc":     "OBC",
        "Ews":     "EWS",
        "Sc":      "SC",
        "St":      "ST",
    }
    # normalise to Title case to match map keys
    cat_norm = category.strip().title()
    cat_key  = cat_key_map.get(cat_norm, "UR")

    final = college_doc.get("aiq_final_2025") or {}
    r1    = college_doc.get("aiq") or {}

    rank = final.get(cat_key) or r1.get(cat_key)
    if rank and isinstance(rank, (int, float)) and rank > 0:
        return int(rank)

    # EWS fallback → use UR if no EWS column
    if cat_key == "EWS":
        rank = final.get("UR") or r1.get("UR")
        if rank and isinstance(rank, (int, float)) and rank > 0:
            return int(rank)

    return 0


def get_college_predictions_from_firestore(air_mid: int, category: str = "General") -> list:
    """
    Fetch college predictions from Firestore 'neet_colleges' collection.
    Returns list of rich dicts for the frontend college card renderer.
    Falls back to legacy get_college_predictions() if Firestore is empty.
    """
    category = category.strip().title()

    try:
        docs = db.collection("neet_colleges").stream()
        raw  = [d.to_dict() for d in docs]
    except Exception as e:
        print(f"[CollegePredictor] Firestore fetch failed: {e}  — using legacy data")
        raw = []

    if not raw:
        return get_college_predictions(air_mid, category)

    # ── TN category mapping (state quota uses different labels) ──
    tn_cat_map = {
        "General": "OC",
        "Obc":     "OBC",
        "Ews":     "OC",   # EWS → OC for TN state quota
        "Sc":      "SC",
        "St":      "ST",
    }
    tn_score_key_map = {
        "General": "score_GN",
        "Obc":     "score_OBC",
        "Ews":     "score_GN",
        "Sc":      "score_SC",
        "St":      "score_ST",
    }

    eligible = []
    for c in raw:
        closing_rank = _get_aiq_closing_rank(c, category)
        if closing_rank <= 0:
            continue

        if air_mid <= closing_rank:
            chance = "High" if air_mid <= closing_rank * 0.7 else "Moderate"

            # TN state quota data (only relevant for TN colleges)
            tn_state_data = None
            tn = c.get("tn_state")
            if isinstance(tn, dict) and tn:
                tn_cat      = tn_cat_map.get(category, "OC")
                score_key   = tn_score_key_map.get(category, "score_GN")
                tn_rank_obj = tn.get(tn_cat)
                tn_score    = tn.get(score_key)
                tn_close    = None
                if isinstance(tn_rank_obj, dict):
                    tn_close = tn_rank_obj.get("close") or tn_rank_obj.get("R1_close")
                if tn_close or tn_score:
                    tn_state_data = {
                        "category":      tn_cat,
                        "closing_rank":  tn_close,
                        "closing_score": tn_score,
                    }

            eligible.append({
                # identity
                "id":           c.get("id", ""),
                "college":      c.get("name", ""),
                "city":         c.get("city", ""),
                "district":     c.get("district", ""),
                "state":        c.get("state", ""),
                "type":         c.get("type", "Govt"),
                "counselling":  c.get("counselling", "MCC_AIQ"),
                "established":  c.get("established"),
                "seats":        c.get("mbbs_seats", 0),
                # cutoff
                "closing_rank": closing_rank,
                "chance":       chance,
                # fees
                "annual_fee_inr": c.get("annual_fee_inr"),
                "mgmt_fee_inr":   c.get("mgmt_fee_inr"),
                # TN state quota context
                "tn_state":     tn_state_data,
                # data quality
                "confidence":   c.get("confidence", "medium"),
                "tags":         c.get("tags", []),
            })

    # Sort: AIIMS/Central first, then State Govt, then Private — within tier by rank
    def _sort_key(x):
        t = x.get("type", "")
        if "AIIMS" in t or "Central" in t:
            tier = 0
        elif "Govt" in t or "State" in t:
            tier = 1
        else:
            tier = 2
        return (tier, x["closing_rank"])

    eligible.sort(key=_sort_key)
    return eligible[:50]


def get_air_from_marks(marks: int, year: int) -> dict:
    """
    Given NEET marks and year, return estimated AIR range.
    Returns dict with air_low, air_high, air_mid, percentile_approx
    """
    year = int(year)
    marks = int(marks)
 
    # Use closest available year if exact year not in table
    available_years = sorted(NEET_MARKS_VS_RANK.keys(), reverse=True)
    use_year = year
    if year not in NEET_MARKS_VS_RANK:
        # Use nearest year
        use_year = min(available_years, key=lambda y: abs(y - year))
 
    table = NEET_MARKS_VS_RANK[use_year]
 
    for (min_m, max_m, air_open, air_close) in table:
        if min_m <= marks <= max_m:
            air_mid = (air_open + air_close) // 2
            # Approx percentile: (total_appeared - air_mid) / total_appeared * 100
            # Total appeared varies by year; approximate with 2.2 million
            total_appeared = 2200000
            percentile = round(((total_appeared - air_mid) / total_appeared) * 100, 2)
            return {
                "air_low": air_open,
                "air_high": air_close,
                "air_mid": air_mid,
                "percentile_approx": percentile,
                "year_used": use_year,
                "marks": marks,
            }
 
    # Fallback for very low scores
    return {
        "air_low": 1500000,
        "air_high": 2200000,
        "air_mid": 1800000,
        "percentile_approx": 10.0,
        "year_used": use_year,
        "marks": marks,
    }
 
 
def get_college_predictions(air_mid: int, category: str = "General") -> list:
    """
    Given estimated AIR and category, return list of colleges the student
    could likely get admission to.
    """
    category = category.strip().title()
    col_map = {
        "General": 1,
        "Obc": 2,
        "Sc": 3,
        "St": 4,
        "Ews": 1,  # EWS roughly similar to General for predictor purposes
    }
    col_idx = col_map.get(category, 1)
 
    eligible = []
    for college in COLLEGE_DATA:
        name, city, state, gen_rank, obc_rank, sc_rank, st_rank, ctype, seats = college
        closing_rank = [gen_rank, obc_rank, sc_rank, st_rank][col_idx - 1]
 
        if air_mid <= closing_rank:
            # Student is likely eligible
            chance = "High" if air_mid <= closing_rank * 0.7 else "Moderate"
            eligible.append({
                "college": name,
                "city": city,
                "state": state,
                "type": ctype,
                "closing_rank": closing_rank,
                "seats": seats,
                "chance": chance,
            })
 
    # Sort: government first, then by closing rank
    eligible.sort(key=lambda x: (0 if x["type"] == "Government" else 1, x["closing_rank"]))
    return eligible[:30]  # Return top 30 matches
 
 
# ─────────────────────────────────────────────────────────────────────────────
# PYQ HELPER: SCORING
# ─────────────────────────────────────────────────────────────────────────────
 
def score_pyq_test(session_data: dict, answers: dict) -> dict:
    """
    Score a PYQ test using NEET marking scheme.
    Returns full scoring breakdown.
    """
    questions = session_data.get("questions", [])
 
    total_marks = 0
    correct_count = 0
    wrong_count = 0
    unattempted_count = 0
 
    subject_breakdown = {}   # {subject: {marks, correct, wrong, unattempted, total}}
    chapter_breakdown = {}   # {chapter: {marks, correct, wrong, unattempted}}
    class_breakdown = {11: {"marks": 0, "correct": 0, "wrong": 0, "total": 0},
                       12: {"marks": 0, "correct": 0, "wrong": 0, "total": 0}}
    difficulty_breakdown = {"Easy": {"correct": 0, "wrong": 0, "total": 0},
                             "Medium": {"correct": 0, "wrong": 0, "total": 0},
                             "Hard": {"correct": 0, "wrong": 0, "total": 0}}
 
    question_results = []
 
    for q in questions:
        qid = q.get("question_id", "")
        subject = q.get("subject", "Unknown")
        chapter = q.get("ncert_chapter_name", "Unknown")
        ncert_class = q.get("ncert_class", 11)
        difficulty = q.get("difficulty", "Medium")
        is_mta = q.get("is_mta", False)
 
        correct_answer = q.get("correct_answer", "")
        student_answer = answers.get(qid, "").strip().upper() if answers.get(qid) else ""
 
        # NEET marking
        neet_marks_config = q.get("neet_marks", {"correct": 4, "incorrect": -1, "unattempted": 0})
 
        if is_mta:
            # MTA = Marks to All — everyone gets full marks
            marks_earned = neet_marks_config.get("correct", 4)
            result = "mta"
        elif not student_answer:
            marks_earned = neet_marks_config.get("unattempted", 0)
            result = "unattempted"
            unattempted_count += 1
        elif student_answer == correct_answer.strip().upper():
            marks_earned = neet_marks_config.get("correct", 4)
            result = "correct"
            correct_count += 1
        else:
            marks_earned = neet_marks_config.get("incorrect", -1)
            result = "wrong"
            wrong_count += 1
 
        total_marks += marks_earned
 
        # Subject breakdown
        if subject not in subject_breakdown:
            subject_breakdown[subject] = {
                "marks": 0, "correct": 0, "wrong": 0,
                "unattempted": 0, "total": 0, "max_marks": 0
            }
        subject_breakdown[subject]["marks"] += marks_earned
        subject_breakdown[subject]["total"] += 1
        subject_breakdown[subject]["max_marks"] += neet_marks_config.get("correct", 4)
        if result == "correct":
            subject_breakdown[subject]["correct"] += 1
        elif result == "wrong":
            subject_breakdown[subject]["wrong"] += 1
        elif result == "unattempted":
            subject_breakdown[subject]["unattempted"] += 1
 
        # Chapter breakdown
        if chapter not in chapter_breakdown:
            chapter_breakdown[chapter] = {
                "marks": 0, "correct": 0, "wrong": 0,
                "unattempted": 0, "total": 0
            }
        chapter_breakdown[chapter]["marks"] += marks_earned
        chapter_breakdown[chapter]["total"] += 1
        if result == "correct":
            chapter_breakdown[chapter]["correct"] += 1
        elif result == "wrong":
            chapter_breakdown[chapter]["wrong"] += 1
        elif result == "unattempted":
            chapter_breakdown[chapter]["unattempted"] += 1
 
        # Class breakdown
        cls = ncert_class if ncert_class in [11, 12] else 11
        class_breakdown[cls]["marks"] += marks_earned
        class_breakdown[cls]["total"] += 1
        if result == "correct":
            class_breakdown[cls]["correct"] += 1
        elif result == "wrong":
            class_breakdown[cls]["wrong"] += 1
 
        # Difficulty breakdown
        diff = difficulty if difficulty in difficulty_breakdown else "Medium"
        difficulty_breakdown[diff]["total"] += 1
        if result == "correct":
            difficulty_breakdown[diff]["correct"] += 1
        elif result == "wrong":
            difficulty_breakdown[diff]["wrong"] += 1
 
        question_results.append({
            "question_id": qid,
            "subject": subject,
            "chapter": chapter,
            "ncert_class": ncert_class,
            "difficulty": difficulty,
            "is_mta": is_mta,
            "student_answer": student_answer,
            "correct_answer": correct_answer,
            "marks_earned": marks_earned,
            "result": result,
            # Full question content for review
            "question_text": q.get("question_text", ""),
            "question_image_url": q.get("question_image_url"),
            "question_image_urls": q.get("question_image_urls", []),
            "question_image_descriptions": q.get("question_image_descriptions", []),
            "options": q.get("options", []),
            "static_explanation": q.get("static_explanation", ""),
            "each_option_explanation": q.get("each_option_explanation", {}),
            "explanation_image_url": q.get("explanation_image_url"),
            "ncert_verbatim": q.get("ncert_verbatim", ""),
            "student_tip": q.get("student_tip", ""),
            "key_concept_summary": q.get("key_concept_summary", ""),
            "common_mistakes": q.get("common_mistakes", []),
            "revision_flashcard": q.get("revision_flashcard", {}),
            "topic_tag": q.get("topic_tag", ""),
        })
 
    # Max possible marks
    total_questions = len(questions)
    max_marks = total_questions * 4  # standard
 
    # Accuracy percentage (only on attempted)
    attempted = correct_count + wrong_count
    accuracy = round((correct_count / attempted * 100) if attempted > 0 else 0, 1)
 
    # Weak chapters = wrong > correct
    weak_chapters = [
        {"chapter": ch, **data}
        for ch, data in chapter_breakdown.items()
        if data["wrong"] > data["correct"] and data["total"] > 0
    ]
    weak_chapters.sort(key=lambda x: x["wrong"] - x["correct"], reverse=True)
 
    return {
        "total_marks": total_marks,
        "max_marks": max_marks,
        "correct_count": correct_count,
        "wrong_count": wrong_count,
        "unattempted_count": unattempted_count,
        "total_questions": total_questions,
        "accuracy": accuracy,
        "subject_breakdown": subject_breakdown,
        "chapter_breakdown": chapter_breakdown,
        "class_breakdown": class_breakdown,
        "difficulty_breakdown": difficulty_breakdown,
        "weak_chapters": weak_chapters[:10],
        "question_results": question_results,
    }
 
 
# ─────────────────────────────────────────────────────────────────────────────
# PYQ ROUTES
# ─────────────────────────────────────────────────────────────────────────────
 
@app.route("/api/pyq/papers", methods=["GET"])
@require_auth
def get_pyq_papers():
    """Get all available PYQ papers grouped by year."""
    try:
        docs = db.collection("pyq_papers").stream()
        papers = []
        for doc in docs:
            p = doc.to_dict()
            papers.append({
                "paper_id": p.get("paper_id", doc.id),
                "year": p.get("year"),
                "paper_code": p.get("paper_code"),
                "exam": p.get("exam", "NEET (UG)"),
                "total_questions": p.get("total_questions", 0),
                "total_uploaded": p.get("total_uploaded", 0),
                "subjects": p.get("subjects", []),
                "chapters": p.get("chapters", []),
                "mta_questions": p.get("mta_questions", 0),
            })
 
        # Sort by year descending, then paper_code
        papers.sort(key=lambda x: (-x.get("year", 0), x.get("paper_code", "")))
 
        # Group by year
        years = {}
        for p in papers:
            yr = str(p["year"])
            if yr not in years:
                years[yr] = []
            years[yr].append(p)
 
        return jsonify({
            "papers": papers,
            "by_year": years,
            "total_papers": len(papers),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500
 
 
@app.route("/api/pyq/papers/<paper_id>", methods=["GET"])
@require_auth
def get_pyq_paper_detail(paper_id):
    """Get metadata for a specific paper."""
    try:
        doc = db.collection("pyq_papers").document(paper_id).get()
        if not doc.exists:
            return jsonify({"error": "Paper not found"}), 404
        return jsonify(doc.to_dict())
    except Exception as e:
        return jsonify({"error": str(e)}), 500
 
 
@app.route("/api/pyq/filter", methods=["POST"])
@require_auth
def filter_pyq_questions():
    """
    Filter questions for a custom test.
    FIX: Suppressed positional argument warning.
    """
    data = request.json or {}
    year = data.get("year")
    paper_code = data.get("paper_code")
    subject = data.get("subject")
    ncert_class = data.get("ncert_class")
    chapter = data.get("chapter")
    limit = min(int(data.get("limit", 500)), 500)

    try:
        query = db.collection("pyq_questions")

        if year:
            query = query.where(filter=firestore.FieldFilter("year", "==", int(year)))
        if paper_code:
            query = query.where(filter=firestore.FieldFilter("paper_code", "==", str(paper_code)))
        if subject:
            query = query.where(filter=firestore.FieldFilter("subject", "==", subject))
        if ncert_class:
            query = query.where(filter=firestore.FieldFilter("ncert_class", "==", int(ncert_class)))
        if chapter:
            query = query.where(filter=firestore.FieldFilter("ncert_chapter_name", "==", chapter))

        docs = query.stream()

        questions = []
        for doc in docs:
            q = doc.to_dict()
            questions.append({
                "question_id": q.get("question_id", doc.id),
                "year": q.get("year"),
                "paper_code": q.get("paper_code"),
                "question_number": q.get("question_number"),
                "subject": q.get("subject"),
                "ncert_class": q.get("ncert_class"),
                "ncert_chapter_name": q.get("ncert_chapter_name"),
                "difficulty": q.get("difficulty"),
                "is_mta": q.get("is_mta", False),
                "has_images": q.get("has_images", False),
            })

        # Sort by question_number within paper
        questions.sort(key=lambda x: (x.get("year", 0), x.get("paper_code", ""), x.get("question_number", 0)))
        questions = questions[:limit]

        return jsonify({
            "questions": questions,
            "total": len(questions),
            "filters_applied": {
                "year": year, "paper_code": paper_code,
                "subject": subject, "ncert_class": ncert_class, "chapter": chapter
            }
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
 
 
@app.route("/api/pyq/session/start", methods=["POST"])
@require_auth
def start_pyq_session():
    """
    Start a PYQ test session.
    FIX: Batch-fetch questions instead of one-by-one (180 calls → 6 calls).
    """
    uid = request.uid
    data = request.json or {}

    question_ids = data.get("question_ids", [])
    test_type = data.get("test_type", "full_paper")
    year = data.get("year")
    paper_code = data.get("paper_code", "")
    label = data.get("label", f"NEET {year} Paper {paper_code}")

    if not question_ids:
        return jsonify({"error": "question_ids required"}), 400

    # ── FIX: Batch fetch using 'in' queries (max 30 per batch) ──
    questions_data = []
    BATCH_SIZE = 30  # Firestore 'in' operator limit

    for i in range(0, len(question_ids), BATCH_SIZE):
        chunk = question_ids[i:i + BATCH_SIZE]
        docs = db.collection("pyq_questions") \
            .where("question_id", "in", chunk) \
            .stream()
        for doc in docs:
            questions_data.append(doc.to_dict())

    if not questions_data:
        return jsonify({"error": "No valid questions found"}), 400

    # Re-sort to match original question_ids order
    qid_order = {qid: idx for idx, qid in enumerate(question_ids)}
    questions_data.sort(key=lambda q: qid_order.get(q.get("question_id", ""), 9999))

    # Build frontend questions (no correct answers)
    frontend_questions = []
    session_questions = []  # Full data stored in session for scoring

    for q in questions_data:
        qid = q.get("question_id", "")
        options = q.get("options", [])

        # Build filename->url map so option image_file filenames can be resolved.
        # Includes both question-level images AND any pre-resolved option image_url values.
        q_img_urls = q.get("question_image_urls", [])
        q_img_files = q.get("question_image_files", [])
        file_to_url = {}
        for fname, furl in zip(q_img_files, q_img_urls):
            if fname and furl:
                file_to_url[fname] = furl

        # Also index any option images that were already resolved to URLs during upload
        for opt in q.get("options", []):
            opt_url = opt.get("image_url")
            opt_file = opt.get("image_file")
            if opt_url and opt_url.startswith("http") and opt_file:
                file_to_url[opt_file] = opt_url

        # Firebase Storage base URL for reconstructing URLs from bare filenames
        # Pattern: pyq_images/{year}/{paper_code}/{filename}
        _q_year = q.get("year", "")
        _q_code = q.get("paper_code", "")

        def _resolve_opt_img(opt, _map=file_to_url, _year=_q_year, _code=_q_code):
            # Prefer already-resolved image_url first
            src = opt.get("image_url") or opt.get("image_file")
            if not src:
                return None
            # Already a full URL — return as-is
            if src.startswith("http"):
                return src
            # Try the filename→URL map (built from question_image_files/urls)
            if src in _map:
                return _map[src]
            # Fallback: reconstruct Firebase Storage public URL from bare filename
            if _year and _code:
                import urllib.parse
                encoded = urllib.parse.quote(src, safe="")
                return (
                    f"https://firebasestorage.googleapis.com/v0/b/naadi-ai-ec3ed.firebasestorage.app"
                    f"/o/pyq_images%2F{_year}%2F{_code}%2F{encoded}?alt=media"
                )
            return None

        frontend_questions.append({
            "question_id": qid,
            "question_number": q.get("question_number"),
            "subject": q.get("subject", ""),
            "ncert_class": q.get("ncert_class"),
            "ncert_chapter_name": q.get("ncert_chapter_name", ""),
            "difficulty": q.get("difficulty", ""),
            "is_mta": q.get("is_mta", False),
            "is_match_question": q.get("is_match_question", False),
            "render_mode": q.get("render_mode", "html"),
            "has_images": q.get("has_images", False),
            "question_text": q.get("question_text", ""),
            "question_image_url": q.get("question_image_url"),
            "question_image_urls": q_img_urls,
            "question_image_descriptions": q.get("question_image_descriptions", []),
            "options": [{
                "id": opt.get("id"),
                "text": opt.get("text"),
                "is_image": opt.get("is_image", False),
                "image_url": _resolve_opt_img(opt),
            } for opt in options],
            "estimated_time_seconds": q.get("estimated_time_seconds", 90),
            "topic_tag": q.get("topic_tag", ""),
        })

        session_questions.append({
            "question_id": qid,
            "question_number": q.get("question_number"),
            "subject": q.get("subject", ""),
            "ncert_class": q.get("ncert_class"),
            "ncert_chapter_name": q.get("ncert_chapter_name", ""),
            "difficulty": q.get("difficulty", ""),
            "is_mta": q.get("is_mta", False),
            "correct_answer": q.get("correct_answer", ""),
            "neet_marks": q.get("neet_marks", {"correct": 4, "incorrect": -1, "unattempted": 0}),
            # Full content for post-test review
            "question_text": q.get("question_text", ""),
            "question_image_url": q.get("question_image_url"),
            "question_image_urls": q_img_urls,
            "question_image_descriptions": q.get("question_image_descriptions", []),
            "options": [{
                "id": opt.get("id"),
                "text": opt.get("text"),
                "is_image": opt.get("is_image", False),
                "image_url": _resolve_opt_img(opt),
            } for opt in options],
            "static_explanation": q.get("static_explanation", ""),
            "each_option_explanation": q.get("each_option_explanation", {}),
            "explanation_image_url": q.get("explanation_image_url"),
            "ncert_verbatim": q.get("ncert_verbatim", ""),
            "student_tip": q.get("student_tip", ""),
            "key_concept_summary": q.get("key_concept_summary", ""),
            "common_mistakes": q.get("common_mistakes", []),
            "revision_flashcard": q.get("revision_flashcard", {}),
            "topic_tag": q.get("topic_tag", ""),
        })

    # Time limit: 3h 20min for full paper, proportional otherwise
    full_paper_seconds = 180 * 60  # 180 minutes = 3 hrs (NEET standard)
    total_q = len(questions_data)
    time_limit = round((total_q / 180) * full_paper_seconds)
    time_limit = max(600, time_limit)  # minimum 10 minutes

    # Sanitize components so session_id never has None/spaces
    _year_s = str(year) if year else "unknown"
    _code_s = str(paper_code).replace(" ", "_") if paper_code else "unknown"
    _type_s = str(test_type).replace(" ", "_") if test_type else "custom"
    session_id = f"pyq_{uid}_{_year_s}_{_code_s}_{_type_s}_{int(time.time())}"

    session_doc = {
        "session_id": session_id,
        "user_id": uid,
        "arena_session": data.get("arena_session", False),
        "year": year,
        "paper_code": str(paper_code),
        "test_type": test_type,
        "label": label,
        "total_questions": total_q,
        "time_limit_seconds": time_limit,
        "questions": session_questions,
        "answers": {},
        "status": "in_progress",
        "started_at": firestore.SERVER_TIMESTAMP,
        "completed_at": None,
        "score_data": None,
    }

    db.collection("pyq_sessions").document(session_id).set(session_doc)

    return jsonify({
        "session_id": session_id,
        "label": label,
        "test_type": test_type,
        "year": year,
        "paper_code": paper_code,
        "total_questions": total_q,
        "time_limit_seconds": time_limit,
        "questions": frontend_questions,
    })
 
 
@app.route("/api/pyq/session/submit", methods=["POST"])
@require_auth
def submit_pyq_session():
    """
    Submit a PYQ test.
    FIXES:
    - Sanitizes dict keys for Firestore compatibility
    - Stores question_results in subcollection to avoid 1MB limit
    """
    uid = request.uid
    data = request.json or {}

    session_id = data.get("session_id")
    answers = data.get("answers", {})
    time_taken = data.get("time_taken_seconds", 0)
    category = data.get("category", "General")

    if not session_id:
        return jsonify({"error": "session_id required"}), 400

    session_ref = db.collection("pyq_sessions").document(session_id)
    session_doc = session_ref.get()

    if not session_doc.exists:
        return jsonify({"error": "Session not found"}), 404

    session = session_doc.to_dict()

    # ── FIXED: define is_arena_session here, before it is used anywhere below ──
    is_arena_session = session.get("arena_session", False)

    if session.get("user_id") != uid:
        return jsonify({"error": "Unauthorized"}), 403

    if session.get("status") == "completed":
        # Already submitted — return saved results
        saved = session.get("score_data", {})
        # Reload question_results from subcollection
        if "question_results" not in saved or not saved["question_results"]:
            saved["question_results"] = load_question_results_from_subcollection(session_id)
        return jsonify(saved)

    year = session.get("year")
    test_type = session.get("test_type", "full_paper")

    # Score the test
    try:
        score_data = score_pyq_test(session, answers)
    except Exception as score_err:
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"Scoring error: {str(score_err)}"}), 500

    # AIR prediction — computed for ALL full paper tests (shown in AIR tab always)
    # College predictions — ONLY for NEET Arena full tests (arena_session flag)
    air_data = None
    college_predictions = []
    college_year_context = None

    if test_type == "full_paper" and year:
        air_data = get_air_from_marks(score_data["total_marks"], year)

        if is_arena_session:
            college_predictions = get_college_predictions_from_firestore(
                air_data["air_mid"], category
            )
            paper_yr = int(year) if year else LATEST_COLLEGE_YEAR
            if paper_yr < LATEST_COLLEGE_YEAR:
                college_year_context = {
                    "paper_year":  paper_yr,
                    "cutoff_year": LATEST_COLLEGE_YEAR,
                    "note": (
                        f"This is a {paper_yr} paper. College options below are based on "
                        f"NEET {LATEST_COLLEGE_YEAR} closing ranks — so you can see where "
                        f"this score would get you if NEET {LATEST_COLLEGE_YEAR} were held today."
                    ),
                }
            else:
                college_year_context = {
                    "paper_year":  paper_yr,
                    "cutoff_year": LATEST_COLLEGE_YEAR,
                    "note": f"College options based on NEET {LATEST_COLLEGE_YEAR} AIQ closing ranks.",
                }

    # Qualifying status
    cutoff_year = year if year in NEET_QUALIFYING_CUTOFF else max(NEET_QUALIFYING_CUTOFF.keys())
    qualifying_marks = NEET_QUALIFYING_CUTOFF.get(cutoff_year, {}).get(category, 144)
    qualifies = score_data["total_marks"] >= qualifying_marks

    # Build full result (returned to frontend)
    result = {
        "session_id": session_id,
        "label": session.get("label", ""),
        "year": year,
        "paper_code": session.get("paper_code", ""),
        "test_type": test_type,
        "category": category,
        "time_taken_seconds": time_taken,
        "time_limit_seconds": session.get("time_limit_seconds", 0),

        # Score
        "total_marks": score_data["total_marks"],
        "max_marks": score_data["max_marks"],
        "correct_count": score_data["correct_count"],
        "wrong_count": score_data["wrong_count"],
        "unattempted_count": score_data["unattempted_count"],
        "total_questions": score_data["total_questions"],
        "accuracy": score_data["accuracy"],
        "qualifies": qualifies,
        "qualifying_marks": qualifying_marks,

        # Breakdowns
        "subject_breakdown": score_data["subject_breakdown"],
        "chapter_breakdown": score_data["chapter_breakdown"],
        "class_breakdown": score_data["class_breakdown"],
        "difficulty_breakdown": score_data["difficulty_breakdown"],
        "weak_chapters": score_data["weak_chapters"],

        # Question-by-question results (sent to frontend, stored separately)
        "question_results": score_data["question_results"],

        # AIR prediction (full paper only)
        "air_prediction": air_data,
        "college_predictions": college_predictions,
        "college_year_context": college_year_context,

        "completed_at": datetime.now(timezone.utc).isoformat(),
    }

    # ── Sanitize nested dict keys for Firestore ──
    def sanitize_for_firestore(obj):
        """Recursively fix all dict keys to be non-empty strings."""
        if isinstance(obj, dict):
            cleaned = {}
            for k, v in obj.items():
                str_key = str(k) if not isinstance(k, str) else k
                if not str_key or str_key.strip() == "":
                    str_key = "_unknown_"
                str_key = str_key.replace(" ", "_").replace("(", "_").replace(")", "_")
                cleaned[str_key] = sanitize_for_firestore(v)
            return cleaned
        elif isinstance(obj, list):
            return [sanitize_for_firestore(item) for item in obj]
        else:
            return obj

    # ── Split: store question_results separately to stay under 1MB ──
    question_results_full = score_data["question_results"]

    # Build a slim version for the main document (no explanations/images)
    slim_question_results = []
    for qr in question_results_full:
        slim_question_results.append({
            "question_id": qr.get("question_id", ""),
            "subject": qr.get("subject", ""),
            "chapter": qr.get("chapter", ""),
            "difficulty": qr.get("difficulty", ""),
            "result": qr.get("result", ""),
            "marks_earned": qr.get("marks_earned", 0),
            "student_answer": qr.get("student_answer", ""),
            "correct_answer": qr.get("correct_answer", ""),
        })

    # Result for Firestore (without heavy question_results)
    result_for_firestore = dict(result)
    result_for_firestore["question_results"] = slim_question_results  # slim version only
    result_for_firestore["question_results_stored_separately"] = True

    safe_result = sanitize_for_firestore(result_for_firestore)
    safe_answers = sanitize_for_firestore(answers)

    # Save main session document (now well under 1MB)
    session_ref.update({
        "answers": safe_answers,
        "status": "completed",
        "score_data": safe_result,
        "completed_at": firestore.SERVER_TIMESTAMP,
        "time_taken_seconds": time_taken,
    })

    # Save full question_results in subcollection (chunked into batches)
    save_question_results_to_subcollection(session_id, question_results_full)

    # Save to leaderboard (full paper only)
    # NOTE: is_arena_session was already set above, right after session was loaded

    if test_type == "full_paper" and year is not None and str(year) != "None" and session.get("paper_code"):
        try:
            user_doc = db.collection("users").document(uid).get()
            user_name = "Student"
            if user_doc.exists:
                ud = user_doc.to_dict()
                user_name = ud.get("name", ud.get("email", "Student").split("@")[0])

            # Save to PYQ leaderboard (always)
            leaderboard_id = f"{year}_{session['paper_code']}"
            leaderboard_entry = {
                "user_id": uid,
                "user_name": user_name,
                "session_id": session_id,
                "year": year,
                "paper_code": session.get("paper_code"),
                "total_marks": score_data["total_marks"],
                "correct": score_data["correct_count"],
                "wrong": score_data["wrong_count"],
                "unattempted": score_data["unattempted_count"],
                "accuracy": score_data["accuracy"],
                "time_taken_seconds": time_taken,
                "category": category,
                "air_prediction": air_data.get("air_mid") if air_data else None,
                "submitted_at": firestore.SERVER_TIMESTAMP,
            }
            db.collection("pyq_leaderboard") \
                .document(leaderboard_id) \
                .collection("entries") \
                .document(uid) \
                .set(leaderboard_entry, merge=True)

            # If Arena session: also save to arena leaderboard (best score logic)
            if is_arena_session:
                arena_lb_id = f"arena_{year}_{session['paper_code']}"
                existing_arena = db.collection("arena_leaderboard") \
                    .document(arena_lb_id) \
                    .collection("entries") \
                    .document(uid).get()

                existing_data = existing_arena.to_dict() if existing_arena.exists else {}
                prev_best = existing_data.get("best_marks", -999)
                new_attempts = existing_data.get("attempts", 0) + 1
                new_best = max(prev_best, score_data["total_marks"])

                arena_entry = {
                    "user_id": uid,
                    "user_name": user_name,
                    "best_marks": new_best,
                    "attempts": new_attempts,
                    "best_time_seconds": time_taken if score_data["total_marks"] >= prev_best else existing_data.get("best_time_seconds", time_taken),
                    "correct": score_data["correct_count"] if score_data["total_marks"] >= prev_best else existing_data.get("correct", 0),
                    "wrong": score_data["wrong_count"] if score_data["total_marks"] >= prev_best else existing_data.get("wrong", 0),
                    "accuracy": score_data["accuracy"] if score_data["total_marks"] >= prev_best else existing_data.get("accuracy", 0),
                    "category": category,
                    "air_prediction": air_data.get("air_mid") if air_data else None,
                    "year": year,
                    "paper_code": session.get("paper_code"),
                    "submitted_at": firestore.SERVER_TIMESTAMP,
                }
                db.collection("arena_leaderboard") \
                    .document(arena_lb_id) \
                    .collection("entries") \
                    .document(uid) \
                    .set(arena_entry)

                # Update overall arena leaderboard
                overall_existing = db.collection("arena_leaderboard_overall").document(uid).get()
                overall_data = overall_existing.to_dict() if overall_existing.exists else {}
                overall_best = overall_data.get("best_marks", -999)
                all_attempts = overall_data.get("total_attempts", 0) + 1
                papers_set = set(overall_data.get("papers_list", []))
                papers_set.add(f"{year}_{session['paper_code']}")

                overall_entry = {
                    "user_id": uid,
                    "user_name": user_name,
                    "best_marks": max(overall_best, score_data["total_marks"]),
                    "total_attempts": all_attempts,
                    "papers_attempted": len(papers_set),
                    "papers_list": list(papers_set),
                    "avg_accuracy": round(
                        (overall_data.get("avg_accuracy", 0) * (all_attempts - 1) + score_data["accuracy"]) / all_attempts, 1
                    ),
                    "best_air": min(
                        overall_data.get("best_air", 9999999),
                        air_data.get("air_mid", 9999999)
                    ) if air_data else overall_data.get("best_air"),
                    "last_attempt_at": firestore.SERVER_TIMESTAMP,
                }
                db.collection("arena_leaderboard_overall").document(uid).set(overall_entry, merge=True)

        except Exception as e:
            print(f"Warning: Could not save leaderboard entry: {e}")

    # Return FULL result to frontend (with all question_results)

    safe_rebuild(uid)
    
    return jsonify(result)
 
def save_question_results_to_subcollection(session_id, question_results):
    """
    Save full question results in chunks to a subcollection.
    Each chunk holds ~30 questions to stay well under 1MB per doc.
    """
    CHUNK_SIZE = 30

    def sanitize_for_firestore(obj):
        if isinstance(obj, dict):
            cleaned = {}
            for k, v in obj.items():
                str_key = str(k) if not isinstance(k, str) else k
                if not str_key or str_key.strip() == "":
                    str_key = "_unknown_"
                str_key = str_key.replace(" ", "_").replace("(", "_").replace(")", "_")
                cleaned[str_key] = sanitize_for_firestore(v)
            return cleaned
        elif isinstance(obj, list):
            return [sanitize_for_firestore(item) for item in obj]
        else:
            return obj

    try:
        for i in range(0, len(question_results), CHUNK_SIZE):
            chunk = question_results[i:i + CHUNK_SIZE]
            chunk_id = f"chunk_{i // CHUNK_SIZE}"
            safe_chunk = sanitize_for_firestore({"questions": chunk})

            db.collection("pyq_sessions") \
                .document(session_id) \
                .collection("question_results") \
                .document(chunk_id) \
                .set(safe_chunk)

        print(f"✅ Saved {len(question_results)} question results in {math.ceil(len(question_results) / CHUNK_SIZE)} chunks")
    except Exception as e:
        print(f"⚠️ Error saving question results subcollection: {e}")


def load_question_results_from_subcollection(session_id):
    """
    Load full question results from subcollection chunks.
    Used when viewing a previously completed session.
    """
    try:
        docs = db.collection("pyq_sessions") \
            .document(session_id) \
            .collection("question_results") \
            .stream()

        all_questions = []
        for doc in docs:
            chunk = doc.to_dict()
            all_questions.extend(chunk.get("questions", []))

        # Sort by question number if available
        all_questions.sort(key=lambda q: q.get("question_number", 0))
        return all_questions
    except Exception as e:
        print(f"⚠️ Error loading question results: {e}")
        return []


@app.route("/api/pyq/session/<session_id>", methods=["GET"])
@require_auth
def get_pyq_session(session_id):
    """Get a completed PYQ session's results — always includes full question_results."""
    uid = request.uid

    doc = db.collection("pyq_sessions").document(session_id).get()
    if not doc.exists:
        return jsonify({"error": "Session not found"}), 404

    session = doc.to_dict()
    if session.get("user_id") != uid:
        return jsonify({"error": "Unauthorized"}), 403

    score_data = session.get("score_data", {})
    if not score_data:
        return jsonify({"error": "No results yet. Test may not be submitted."})

    # Always attempt to load full question_results from subcollection
    full_results = load_question_results_from_subcollection(session_id)
    if full_results:
        score_data["question_results"] = full_results
    elif not score_data.get("question_results"):
        # Fallback: reconstruct slim results from session questions + answers
        session_questions = session.get("questions", [])
        slim = []
        answers_stored = session.get("answers", {})
        for q in session_questions:
            qid = q.get("question_id", "")
            correct = q.get("correct_answer", "")
            student = answers_stored.get(qid, "")
            if q.get("is_mta"):
                result_flag = "mta"
            elif not student:
                result_flag = "unattempted"
            elif student.strip().upper() == correct.strip().upper():
                result_flag = "correct"
            else:
                result_flag = "wrong"

            slim.append({
                "question_id": qid,
                "subject": q.get("subject", ""),
                "chapter": q.get("ncert_chapter_name", ""),
                "ncert_class": q.get("ncert_class"),
                "difficulty": q.get("difficulty", ""),
                "is_mta": q.get("is_mta", False),
                "student_answer": student,
                "correct_answer": correct,
                "marks_earned": q.get("neet_marks", {}).get("correct", 4) if result_flag in ("correct", "mta")
                    else (q.get("neet_marks", {}).get("incorrect", -1) if result_flag == "wrong" else 0),
                "result": result_flag,
                "question_text": q.get("question_text", ""),
                "question_image_url": q.get("question_image_url"),
                "question_image_urls": q.get("question_image_urls", []),
                "question_image_descriptions": q.get("question_image_descriptions", []),
                "options": q.get("options", []),
                "static_explanation": q.get("static_explanation", ""),
                "each_option_explanation": q.get("each_option_explanation", {}),
                "explanation_image_url": q.get("explanation_image_url"),
                "ncert_verbatim": q.get("ncert_verbatim", ""),
                "student_tip": q.get("student_tip", ""),
                "key_concept_summary": q.get("key_concept_summary", ""),
                "common_mistakes": q.get("common_mistakes", []),
                "revision_flashcard": q.get("revision_flashcard", {}),
                "topic_tag": q.get("topic_tag", ""),
            })
        score_data["question_results"] = slim

    return jsonify(score_data)
 
 
@app.route("/api/pyq/history", methods=["GET"])
@require_auth
def get_pyq_history():
    """Get current user's PYQ test history."""
    uid = request.uid
    try:
        docs = db.collection("pyq_sessions") \
            .where("user_id", "==", uid) \
            .where("status", "==", "completed") \
            .stream()
 
        history = []
        for doc in docs:
            s = doc.to_dict()
            score_data = s.get("score_data", {})
            history.append({
                "session_id": s.get("session_id", doc.id),
                "label": s.get("label", ""),
                "year": s.get("year"),
                "paper_code": s.get("paper_code"),
                "test_type": s.get("test_type"),
                "total_marks": score_data.get("total_marks", 0),
                "max_marks": score_data.get("max_marks", 720),
                "accuracy": score_data.get("accuracy", 0),
                "air_prediction": score_data.get("air_prediction"),
                "completed_at": score_data.get("completed_at"),
            })
 
        history.sort(key=lambda x: x.get("completed_at", "") or "", reverse=True)
        return jsonify({"history": history, "total": len(history)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
 
 
@app.route("/api/pyq/leaderboard/<year>/<paper_code>", methods=["GET"])
@require_auth
def get_pyq_leaderboard(year, paper_code):
    """Get leaderboard for a specific paper."""
    uid = request.uid
    leaderboard_id = f"{year}_{paper_code}"
 
    try:
        docs = db.collection("pyq_leaderboard") \
            .document(leaderboard_id) \
            .collection("entries") \
            .stream()
 
        entries = []
        for doc in docs:
            e = doc.to_dict()
            submitted = e.get("submitted_at")
            if hasattr(submitted, "isoformat"):
                submitted = submitted.isoformat()
            entries.append({
                "user_id": e.get("user_id"),
                "user_name": e.get("user_name", "Student"),
                "total_marks": e.get("total_marks", 0),
                "correct": e.get("correct", 0),
                "wrong": e.get("wrong", 0),
                "accuracy": e.get("accuracy", 0),
                "time_taken_seconds": e.get("time_taken_seconds", 0),
                "category": e.get("category", "General"),
                "air_prediction": e.get("air_prediction"),
                "submitted_at": submitted,
                "is_me": e.get("user_id") == uid,
            })
 
        # Sort by marks desc, then accuracy desc, then time asc
        entries.sort(key=lambda x: (-x["total_marks"], -x["accuracy"], x["time_taken_seconds"]))
 
        # Assign ranks
        for i, e in enumerate(entries):
            e["rank"] = i + 1
 
        my_entry = next((e for e in entries if e["is_me"]), None)
 
        return jsonify({
            "year": int(year),
            "paper_code": paper_code,
            "leaderboard_id": leaderboard_id,
            "entries": entries[:50],
            "my_entry": my_entry,
            "total_participants": len(entries),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500
 
 
@app.route("/api/pyq/air-predict", methods=["POST"])
@require_auth
def predict_air():
    """
    Standalone AIR + college predictor endpoint.
    Called by category toggle buttons in Arena results.
    Body: { marks, year, category, arena_only: true/false }
    Colleges only returned when arena_only == true.
    """
    data = request.json or {}
    marks      = int(data.get("marks", 0))
    year       = int(data.get("year", 2025))
    category   = data.get("category", "General")
    arena_only = bool(data.get("arena_only", False))

    air_data = get_air_from_marks(marks, year)

    colleges = []
    college_year_context = None
    if arena_only:
        colleges = get_college_predictions_from_firestore(air_data["air_mid"], category)
        if year < LATEST_COLLEGE_YEAR:
            college_year_context = {
                "paper_year":  year,
                "cutoff_year": LATEST_COLLEGE_YEAR,
                "note": (
                    f"This is a {year} paper. College options below are based on "
                    f"NEET {LATEST_COLLEGE_YEAR} closing ranks — so you can see where "
                    f"this score would get you if NEET {LATEST_COLLEGE_YEAR} were held today."
                ),
            }
        else:
            college_year_context = {
                "paper_year":  year,
                "cutoff_year": LATEST_COLLEGE_YEAR,
                "note": f"College options based on NEET {LATEST_COLLEGE_YEAR} AIQ closing ranks.",
            }

    cutoff_year      = year if year in NEET_QUALIFYING_CUTOFF else max(NEET_QUALIFYING_CUTOFF.keys())
    qualifying_marks = NEET_QUALIFYING_CUTOFF.get(cutoff_year, {}).get(category, 144)

    return jsonify({
        "marks":                marks,
        "year":                 year,
        "category":             category,
        "air_prediction":       air_data,
        "qualifies":            marks >= qualifying_marks,
        "qualifying_marks":     qualifying_marks,
        "college_predictions":  colleges,
        "college_year_context": college_year_context,
    })
 
 
# ─── DEBUG: Token test endpoint (remove after debugging) ───────
@app.route("/api/pyq/token-test", methods=["POST"])
def token_test():
    """Debug endpoint - no auth required, just echoes what token was sent."""
    auth_header = request.headers.get('Authorization', '')
    token_preview = auth_header[:50] if auth_header else 'MISSING'
    token_len = len(auth_header.split('Bearer ')[-1]) if 'Bearer ' in auth_header else 0
    return jsonify({
        "header_preview": token_preview,
        "token_length": token_len,
        "has_bearer": auth_header.startswith('Bearer '),
        "content_type": request.headers.get('Content-Type', ''),
    })

# ──────────────────────────────────────────────
# SERVE ADDITIONAL PAGES
# ──────────────────────────────────────────────

@app.route("/login.html")
def serve_login():
    return send_from_directory("mobile", "login.html")

# ─────────────────────────────────────────────────────────────────────────────
# NEET ARENA ROUTES
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/arena/papers", methods=["GET"])
@require_auth
def get_arena_papers():
    """Get all full NEET papers for Arena."""
    try:
        docs = db.collection("pyq_papers").stream()
        papers = []
        for doc in docs:
            p = doc.to_dict()
            papers.append({
                "paper_id": p.get("paper_id", doc.id),
                "year": p.get("year"),
                "paper_code": p.get("paper_code"),
                "exam": p.get("exam", "NEET (UG)"),
                "total_questions": p.get("total_questions", 0),
                "total_uploaded": p.get("total_uploaded", 0),
                "subjects": p.get("subjects", []),
                "mta_questions": p.get("mta_questions", 0),
            })
        papers.sort(key=lambda x: (-x.get("year", 0), x.get("paper_code", "")))
        years = {}
        for p in papers:
            yr = str(p["year"])
            if yr not in years:
                years[yr] = []
            years[yr].append(p)
        return jsonify({
            "papers": papers,
            "by_year": years,
            "total_papers": len(papers),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/arena/leaderboard/<year>/<paper_code>", methods=["GET"])
@require_auth
def get_arena_leaderboard(year, paper_code):
    """Get leaderboard for a specific arena paper — includes attempt count."""
    uid = request.uid
    leaderboard_id = f"arena_{year}_{paper_code}"

    try:
        docs = db.collection("arena_leaderboard") \
            .document(leaderboard_id) \
            .collection("entries") \
            .stream()

        entries = []
        for doc in docs:
            e = doc.to_dict()
            submitted = e.get("submitted_at")
            if hasattr(submitted, "isoformat"):
                submitted = submitted.isoformat()
            entries.append({
                "user_id": e.get("user_id"),
                "user_name": e.get("user_name", "Student"),
                "total_marks": e.get("best_marks", 0),
                "best_marks": e.get("best_marks", 0),
                "attempts": e.get("attempts", 1),
                "correct": e.get("correct", 0),
                "wrong": e.get("wrong", 0),
                "accuracy": e.get("accuracy", 0),
                "time_taken_seconds": e.get("best_time_seconds", 0),
                "category": e.get("category", "General"),
                "air_prediction": e.get("air_prediction"),
                "submitted_at": submitted,
                "is_me": e.get("user_id") == uid,
            })

        entries.sort(key=lambda x: (-x["best_marks"], -x["accuracy"], x["time_taken_seconds"]))
        for i, e in enumerate(entries):
            e["rank"] = i + 1

        my_entry = next((e for e in entries if e["is_me"]), None)

        return jsonify({
            "year": int(year),
            "paper_code": paper_code,
            "entries": entries[:100],
            "my_entry": my_entry,
            "total_participants": len(entries),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/arena/overall-leaderboard", methods=["GET"])
@require_auth
def get_arena_overall_leaderboard():
    """Get overall AIR leaderboard from NEET Arena full paper attempts."""
    uid = request.uid

    try:
        all_entries = db.collection("arena_leaderboard_overall") \
            .stream()

        entries = []
        for doc in all_entries:
            e = doc.to_dict()
            submitted = e.get("last_attempt_at")
            if hasattr(submitted, "isoformat"):
                submitted = submitted.isoformat()
            entries.append({
                "user_id": e.get("user_id"),
                "user_name": e.get("user_name", "Student"),
                "best_marks": e.get("best_marks", 0),
                "total_attempts": e.get("total_attempts", 0),
                "papers_attempted": e.get("papers_attempted", 0),
                "avg_accuracy": e.get("avg_accuracy", 0),
                "best_air": e.get("best_air"),
                "last_attempt_at": submitted,
                "is_me": e.get("user_id") == uid,
            })

        entries.sort(key=lambda x: (-x["best_marks"], -x["avg_accuracy"]))
        for i, e in enumerate(entries):
            e["rank"] = i + 1

        my_entry = next((e for e in entries if e["is_me"]), None)

        return jsonify({
            "entries": entries[:100],
            "my_entry": my_entry,
            "total_participants": len(entries),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/arena/history", methods=["GET"])
@require_auth
def get_arena_history():
    """Get user's arena test history."""
    uid = request.uid
    try:
        docs = db.collection("pyq_sessions") \
            .where("user_id", "==", uid) \
            .where("status", "==", "completed") \
            .where("test_type", "==", "full_paper") \
            .where("arena_session", "==", True) \
            .stream()

        history = []
        for doc in docs:
            s = doc.to_dict()
            score_data = s.get("score_data", {})
            history.append({
                "session_id": s.get("session_id", doc.id),
                "label": s.get("label", ""),
                "year": s.get("year"),
                "paper_code": s.get("paper_code"),
                "total_marks": score_data.get("total_marks", 0),
                "max_marks": score_data.get("max_marks", 720),
                "accuracy": score_data.get("accuracy", 0),
                "air_prediction": score_data.get("air_prediction"),
                "completed_at": score_data.get("completed_at"),
            })

        history.sort(key=lambda x: x.get("completed_at", "") or "", reverse=True)
        return jsonify({"history": history, "total": len(history)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ─────────────────────────────────────────────────────────────────────────────
# QUICK REVISE — BACKEND ROUTES
# Paste these 7 routes into backend.py just before:
#   if __name__ == "__main__":
# ─────────────────────────────────────────────────────────────────────────────


# ── 1. GET /api/revision/subjects/<class_level> ──────────────────────────────
@app.route("/api/revision/subjects/<int:class_level>", methods=["GET"])
@require_auth
def get_revision_subjects(class_level):
    """
    Returns list of subjects that have revision chapters for this class.
    Queries revision_chapters collection for docs where ncert_class == class_level.
    """
    try:
        docs = db.collection("revision_chapters").stream()
        subjects = []
        for doc in docs:
            data = doc.to_dict()
            if int(data.get("ncert_class", 0)) == class_level:
                subjects.append({
                    "subject": data.get("subject", ""),
                    "ncert_class": data.get("ncert_class"),
                    "total_chapters": data.get("total_chapters", 0),
                    "doc_id": doc.id,
                })
        subjects.sort(key=lambda x: x["subject"])
        return jsonify({"subjects": subjects})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ── 2. GET /api/revision/chapters/<class_level>/<subject> ────────────────────
@app.route("/api/revision/chapters/<int:class_level>/<subject>", methods=["GET"])
@require_auth
def get_revision_chapters(class_level, subject):
    """
    Returns chapter list for picker.
    Reads revision_chapters/{class}_{subject} document's chapters array.
    """
    doc_id = f"{class_level}_{subject}"
    try:
        doc = db.collection("revision_chapters").document(doc_id).get()
        if not doc.exists:
            return jsonify({"chapters": [], "total_chapters": 0})
        data = doc.to_dict()
        chapters = data.get("chapters", [])
        # Convert Firestore timestamps in uploaded_at to ISO strings
        for ch in chapters:
            ts = ch.get("uploaded_at")
            if hasattr(ts, "isoformat"):
                ch["uploaded_at"] = ts.isoformat()
        return jsonify({
            "subject": data.get("subject", subject),
            "ncert_class": data.get("ncert_class", class_level),
            "total_chapters": data.get("total_chapters", len(chapters)),
            "chapters": chapters,
        })
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ── 3. GET /api/revision/chapter/<chapter_id>/meta ───────────────────────────
@app.route("/api/revision/chapter/<chapter_id>/meta", methods=["GET"])
@require_auth
def get_revision_chapter_meta(chapter_id):
    """
    Returns chapter metadata + block_summaries for the journey progress bar.
    chapter_id format: {Subject}_{class}_{ChapterName}  e.g. Physics_12_Atoms
    Source: revision_chapters/{class}_{subject}/chapters/{chapter_id}
    """
    uid = request.uid
    try:
        # Parse chapter_id to find parent doc
        # Expected format: Subject_Class_ChapterName  e.g. "Physics_12_Atoms"
        parts = chapter_id.split("_")
        if len(parts) < 3:
            return jsonify({"error": "Invalid chapter_id format"}), 400
        subject = parts[0]
        ncert_class = parts[1]
        parent_doc_id = f"{ncert_class}_{subject}"

        doc = db.collection("revision_chapters") \
            .document(parent_doc_id) \
            .collection("chapters") \
            .document(chapter_id) \
            .get()

        if not doc.exists:
            return jsonify({"error": "Chapter not found"}), 404

        data = doc.to_dict()

        # Fetch user progress
        prog_doc = db.collection("users") \
            .document(uid) \
            .collection("revision_progress") \
            .document(chapter_id) \
            .get()

        progress = {}
        if prog_doc.exists:
            pd = prog_doc.to_dict()
            # Convert any timestamps
            for k, v in pd.items():
                if hasattr(v, "isoformat"):
                    pd[k] = v.isoformat()
            progress = pd

        # Clean block_summaries
        block_summaries = data.get("block_summaries", [])

        return jsonify({
            "chapter_id": chapter_id,
            "chapter_name": data.get("chapter_name", ""),
            "subject": data.get("subject", ""),
            "ncert_class": data.get("ncert_class"),
            "total_blocks": data.get("total_blocks", 0),
            "tier_a_count": data.get("tier_a_count", 0),
            "tier_b_count": data.get("tier_b_count", 0),
            "total_flashcards": data.get("total_flashcards", 0),
            "hard_cards": data.get("hard_cards", 0),
            "block_order": data.get("block_order", []),
            "priority_queue": data.get("priority_queue", []),
            "block_summaries": block_summaries,
            "stats": data.get("stats", {}),
            "figures": data.get("figures", []),
            "progress": progress,
        })
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ── 4. GET /api/revision/chapter/<chapter_id>/block/<block_id> ───────────────
@app.route("/api/revision/chapter/<chapter_id>/block/<block_id>", methods=["GET"])
@require_auth
def get_revision_block(chapter_id, block_id):
    """
    Returns full block content (L1, L2, L3, concept_map, flowchart).
    Source: revision_chapters/{class}_{subject}/chapters/{chapter_id}/blocks/{block_id}
    """
    try:
        parts = chapter_id.split("_")
        if len(parts) < 3:
            return jsonify({"error": "Invalid chapter_id format"}), 400
        subject = parts[0]
        ncert_class = parts[1]
        parent_doc_id = f"{ncert_class}_{subject}"

        doc = db.collection("revision_chapters") \
            .document(parent_doc_id) \
            .collection("chapters") \
            .document(chapter_id) \
            .collection("blocks") \
            .document(block_id) \
            .get()

        if not doc.exists:
            return jsonify({"error": "Block not found"}), 404

        data = doc.to_dict()

        # Also fetch the flowchart document if it exists
        flowchart_doc = db.collection("revision_chapters") \
            .document(parent_doc_id) \
            .collection("chapters") \
            .document(chapter_id) \
            .collection("flowcharts") \
            .document(block_id) \
            .get()

        if flowchart_doc.exists and not data.get("flowchart"):
            data["flowchart"] = flowchart_doc.to_dict()

        return jsonify(clean_firestore_data(data))
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ── 5. GET /api/revision/chapter/<chapter_id>/flashcards/<block_id> ──────────
@app.route("/api/revision/chapter/<chapter_id>/flashcards/<block_id>", methods=["GET"])
@require_auth
def get_revision_flashcards(chapter_id, block_id):
    """
    Returns all flashcards for a specific block.
    Source: revision_chapters/{class}_{subject}/chapters/{chapter_id}/flashcards/
    filtered by block_id.
    """
    try:
        parts = chapter_id.split("_")
        if len(parts) < 3:
            return jsonify({"error": "Invalid chapter_id format"}), 400
        subject = parts[0]
        ncert_class = parts[1]
        parent_doc_id = f"{ncert_class}_{subject}"

        docs = db.collection("revision_chapters") \
            .document(parent_doc_id) \
            .collection("chapters") \
            .document(chapter_id) \
            .collection("flashcards") \
            .where(filter=firestore.FieldFilter("block_id", "==", block_id)) \
            .stream()

        cards = []
        for doc in docs:
            card = doc.to_dict()
            card["flashcard_id"] = doc.id
            cards.append(clean_firestore_data(card))

        # Sort: Hard first for spaced repetition feel
        diff_order = {"Hard": 0, "Medium": 1, "Easy": 2}
        cards.sort(key=lambda c: diff_order.get(c.get("difficulty", "Medium"), 1))

        return jsonify({"flashcards": cards, "total": len(cards)})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ── 6. POST /api/revision/progress/update ────────────────────────────────────
@app.route("/api/revision/progress/update", methods=["POST"])
@require_auth
def update_revision_progress():
    """
    Updates user's revision progress for a chapter.
    Body: {
        chapter_id, total_blocks,
        action: "complete" | "flashcard_result",
        block_id,
        flashcard_id (optional),
        correct: bool (optional)
    }
    """
    uid = request.uid
    data = request.json or {}

    chapter_id = data.get("chapter_id")
    action = data.get("action")
    block_id = data.get("block_id")
    total_blocks = data.get("total_blocks", 0)
    chapter_name = data.get("chapter_name")  # NEW: lets /api/home deep-link

    if not chapter_id or not action:
        return jsonify({"error": "chapter_id and action required"}), 400

    prog_ref = db.collection("users") \
        .document(uid) \
        .collection("revision_progress") \
        .document(chapter_id)

    prog_doc = prog_ref.get()
    now_iso = datetime.now(timezone.utc).isoformat()

    if prog_doc.exists:
        prog = prog_doc.to_dict()
        # Convert any timestamps stored as Firestore objects back to strings
        for k, v in prog.items():
            if hasattr(v, "isoformat"):
                prog[k] = v.isoformat()
    else:
        prog = {
            "chapter_id": chapter_id,
            "chapter_name": chapter_name or "",
            "blocks_completed": [],
            "current_block_index": 0,
            "flashcard_results": {},
            "total_blocks": total_blocks,
            "started_at": now_iso,
            "last_active": now_iso,
            "completion_percentage": 0.0,
        }

    if action == "complete" and block_id:
        completed = prog.get("blocks_completed", [])
        if block_id not in completed:
            completed.append(block_id)
        prog["blocks_completed"] = completed
        prog["current_block_index"] = data.get("current_block_index",
            prog.get("current_block_index", 0))
        total = total_blocks or prog.get("total_blocks", 1)
        prog["completion_percentage"] = round(len(completed) / max(total, 1) * 100, 1)

    elif action == "flashcard_result":
        flashcard_id = data.get("flashcard_id")
        correct = data.get("correct", False)
        if flashcard_id:
            fc_results = prog.get("flashcard_results", {})
            entry = fc_results.get(flashcard_id, {"seen": 0, "correct": 0, "last_seen": now_iso})
            entry["seen"] = entry.get("seen", 0) + 1
            if correct:
                entry["correct"] = entry.get("correct", 0) + 1
            entry["last_seen"] = now_iso
            fc_results[flashcard_id] = entry
            prog["flashcard_results"] = fc_results

    prog["last_active"] = now_iso
    prog["total_blocks"] = total_blocks or prog.get("total_blocks", 0)
    # Keep the chapter title on the progress doc so the Home screen can
    # deep-link straight into the journey without a second lookup.
    if chapter_name:
        prog["chapter_name"] = chapter_name

    prog_ref.set(prog)

    safe_rebuild(uid)

    return jsonify({
        "status": "ok",
        "completion_percentage": prog.get("completion_percentage", 0),
        "blocks_completed": len(prog.get("blocks_completed", [])),
    })


# ── 7. GET /api/revision/progress/<chapter_id> ───────────────────────────────
@app.route("/api/revision/progress/<chapter_id>", methods=["GET"])
@require_auth
def get_revision_progress(chapter_id):
    """Returns user's progress for this chapter."""
    uid = request.uid
    try:
        doc = db.collection("users") \
            .document(uid) \
            .collection("revision_progress") \
            .document(chapter_id) \
            .get()

        if not doc.exists:
            return jsonify({
                "chapter_id": chapter_id,
                "blocks_completed": [],
                "current_block_index": 0,
                "flashcard_results": {},
                "total_blocks": 0,
                "completion_percentage": 0.0,
            })

        data = doc.to_dict()
        # Convert Firestore timestamps
        for k, v in data.items():
            if hasattr(v, "isoformat"):
                data[k] = v.isoformat()
        return jsonify(data)
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ── 8. GET /api/revision/progress  (batch — Concept Studio v2) ───────────────
@app.route("/api/revision/progress", methods=["GET"])
@require_auth
def get_all_revision_progress():
    """
    Returns the user's revision progress for ALL chapters in one call:
        { "progress": { "<chapter_id>": { ...progress doc... }, ... } }
    Used by the Concept Studio v2 chapter picker to draw progress rings
    without one request per chapter. Additive — the per-chapter route
    (/api/revision/progress/<chapter_id>) is unchanged and still used
    everywhere else.
    """
    uid = request.uid
    try:
        docs = db.collection("users") \
            .document(uid) \
            .collection("revision_progress") \
            .stream()
        out = {}
        for doc in docs:
            d = doc.to_dict() or {}
            # Convert Firestore timestamps to ISO strings (same treatment
            # as the per-chapter route)
            for k, v in d.items():
                if hasattr(v, "isoformat"):
                    d[k] = v.isoformat()
            out[doc.id] = {
                "chapter_id": d.get("chapter_id", doc.id),
                "chapter_name": d.get("chapter_name", ""),
                "blocks_completed": d.get("blocks_completed", []),
                "completion_percentage": d.get("completion_percentage", 0.0),
                "current_block_index": d.get("current_block_index", 0),
                "total_blocks": d.get("total_blocks", 0),
                "last_active": d.get("last_active"),
            }
        return jsonify({"progress": out})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# ──────────────────────────────────────────────
# ADMIN: REPAIR OVERALL LEADERBOARD
# ──────────────────────────────────────────────

@app.route("/api/admin/rebuild-my-leaderboard", methods=["POST"])
@require_auth
def rebuild_my_leaderboard():
    """
    One-time repair: rebuild arena_leaderboard_overall for the calling user
    by re-scanning all their per-paper arena_leaderboard entries.
    Call this once after deploying the is_arena_session fix to correct stale data.
    """
    uid = request.uid
    try:
        # Collect all per-paper arena leaderboard entries for this user
        paper_entries = []
        paper_docs = db.collection("arena_leaderboard").stream()
        for paper_doc in paper_docs:
            entry_ref = paper_doc.reference.collection("entries").document(uid).get()
            if entry_ref.exists:
                paper_entries.append(entry_ref.to_dict())

        if not paper_entries:
            return jsonify({"message": "No arena entries found for this user — nothing to rebuild"}), 200

        best_marks = max(e.get("best_marks", 0) for e in paper_entries)
        total_attempts = sum(e.get("attempts", 1) for e in paper_entries)
        papers_set = set(
            f"{e.get('year')}_{e.get('paper_code')}"
            for e in paper_entries
            if e.get("year") and e.get("paper_code")
        )
        avg_acc = round(
            sum(e.get("accuracy", 0) for e in paper_entries) / len(paper_entries), 1
        )
        air_values = [e.get("air_prediction") for e in paper_entries if e.get("air_prediction")]
        best_air = min(air_values) if air_values else None

        # Get user name
        user_doc = db.collection("users").document(uid).get()
        user_name = "Student"
        if user_doc.exists:
            ud = user_doc.to_dict()
            user_name = ud.get("name", ud.get("email", "Student").split("@")[0])

        rebuilt = {
            "user_id": uid,
            "user_name": user_name,
            "best_marks": best_marks,
            "total_attempts": total_attempts,
            "papers_attempted": len(papers_set),
            "papers_list": list(papers_set),
            "avg_accuracy": avg_acc,
            "best_air": best_air,
            "last_attempt_at": firestore.SERVER_TIMESTAMP,
        }
        db.collection("arena_leaderboard_overall").document(uid).set(rebuilt)

        return jsonify({
            "status": "rebuilt",
            "papers_found": len(paper_entries),
            "best_marks": best_marks,
            "total_attempts": total_attempts,
            "papers_attempted": len(papers_set),
            "avg_accuracy": avg_acc,
            "best_air": best_air,
        })
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500



# ═════════════════════════════════════════════════════════════════════════════
# HOME SCREEN  ·  GET /api/home  +  POST /api/streak/ping
# ─────────────────────────────────────────────────────────────────────────────
# One aggregated call for the mobile Home tab. Replaces what would otherwise be
# four round-trips (/api/dashboard + /api/revision/progress + /api/arena/history
# + /api/user/stats) on a phone's first paint.
#
# DESIGN RULE — nothing on Home can go DOWN:
#   • Every "Progress to Doctor" component is COMPLETION-based, never accuracy.
#     Retakes and bad scores can't pull the bar backwards. (OPD already gates
#     progression on PASS_THRESHOLD, so tests_completed already encodes quality —
#     multiplying by mastery on top would double-penalise the weaker student.)
#   • Arena counts unique papers attempted, not marks. Retakes are neutral.
#   • The rank badge uses a stored HIGH-WATER MARK, so a student is never
#     demoted when you upload new syllabus content and grow the denominator.
#
# All denominators are computed LIVE from whatever content exists right now.
# With one sample chapter and one paper today, and the full syllabus tomorrow,
# the same code works — no constants to bump.
# ═════════════════════════════════════════════════════════════════════════════

# Day boundary for streaks is IST, not UTC: a 1 AM study session must not
# break the chain.
IST_TZ = timezone(timedelta(hours=5, minutes=30))

# Composite weights. Redistributed across whichever sections actually have
# content — an empty section is never counted as a zero.
SCALE_WEIGHTS = {"studio": 30, "opd": 40, "arena": 30}

DOCTOR_LADDER = [
    {"key": "intern",           "title": "Intern",           "at": 0},
    {"key": "junior_resident",  "title": "Junior Resident",  "at": 20},
    {"key": "senior_resident",  "title": "Senior Resident",  "at": 40},
    {"key": "registrar",        "title": "Registrar",        "at": 60},
    {"key": "consultant",       "title": "Consultant",       "at": 80},
    {"key": "doctor",           "title": "Doctor",           "at": 95},
]

DEFAULT_TESTS_PER_CHAPTER = 18


def _ist_today():
    """Today's date in IST as a YYYY-MM-DD string."""
    return datetime.now(IST_TZ).date()


def _rank_index_for(pct):
    """Highest ladder rung whose threshold this percentage has reached."""
    idx = 0
    for i, r in enumerate(DOCTOR_LADDER):
        if pct >= r["at"]:
            idx = i
    return idx


def _read_streak(uid):
    """Returns (current, longest, last_date_str). Current is 0 if the chain
    is already broken (last activity older than yesterday, IST)."""
    user = get_user_doc(uid) or {}
    st = user.get("streak", {}) or {}
    last = st.get("last_date")
    current = int(st.get("current", 0))
    longest = int(st.get("longest", 0))

    today = _ist_today()
    yesterday = today - timedelta(days=1)
    if last not in (today.isoformat(), yesterday.isoformat()):
        current = 0  # chain broken — display 0, don't rewrite the doc here
    return current, longest, last


@app.route("/api/streak/ping", methods=["POST"])
@require_auth
def ping_streak():
    """
    Records ONE study day. Called from the client after a qualifying action:
        studio_block · test_submit · note_saved · study_read
    Merely opening the app does NOT count — that trains a hollow habit and
    the number stops meaning anything within a week.

    Idempotent: many pings on the same IST day only ever count once.
    """
    uid = request.uid
    data = request.json or {}
    source = data.get("source", "unknown")

    try:
        user_ref = db.collection("users").document(uid)
        user = get_user_doc(uid) or {}
        st = user.get("streak", {}) or {}

        today = _ist_today()
        yesterday = today - timedelta(days=1)
        today_s = today.isoformat()
        last = st.get("last_date")
        current = int(st.get("current", 0))
        longest = int(st.get("longest", 0))

        if last == today_s:
            counted = False                     # already banked today
        else:
            current = current + 1 if last == yesterday.isoformat() else 1
            longest = max(longest, current)
            counted = True
            user_ref.set({
                "streak": {
                    "current": current,
                    "longest": longest,
                    "last_date": today_s,
                    "last_source": source,
                }
            }, merge=True)

        record_study_day(uid, source)   # ← portal: feed the streak heatmap
        safe_rebuild(uid)               # ← portal: refresh rollup (keeps "last active" fresh)

        return jsonify({
            "current": current,
            "longest": longest,
            "last_date": today_s if counted else last,
            "counted": counted,
        })
    except Exception as e:
        print(f"Streak ping error: {e}")
        # Streak is cosmetic — never fail the caller's flow over it.
        return jsonify({"current": 0, "longest": 0, "counted": False}), 200


def _home_studio(uid):
    """Concept Studio component + resume card.
    pct = mean completion across every chapter that exists (mean of
    percentages, so it needs only the chapter COUNT — one cheap query,
    no reading every chapter's meta doc)."""
    total_chapters = 0
    for doc in db.collection("revision_chapters").stream():
        d = doc.to_dict() or {}
        chapters = d.get("chapters", [])
        total_chapters += len(chapters) if chapters else int(d.get("total_chapters", 0) or 0)

    sum_pct = 0.0
    resume = None
    latest_active = ""
    for doc in db.collection("users").document(uid).collection("revision_progress").stream():
        d = doc.to_dict() or {}
        pct = float(d.get("completion_percentage", 0) or 0)
        sum_pct += pct

        la = d.get("last_active")
        la = la.isoformat() if hasattr(la, "isoformat") else (la or "")
        if la >= latest_active:
            latest_active = la
            resume = {
                "chapter_id": d.get("chapter_id", doc.id),
                "chapter_name": d.get("chapter_name", ""),
                "completion_percentage": round(pct, 1),
                "current_block_index": int(d.get("current_block_index", 0) or 0),
                "total_blocks": int(d.get("total_blocks", 0) or 0),
                "last_active": la,
            }

    # A fully-finished chapter is worth 100 points, so sum_pct/100 is the
    # number of "chapter-equivalents" covered. Keeps done/total == pct.
    done = round(sum_pct / 100.0, 1)
    pct = (sum_pct / total_chapters) if total_chapters else 0.0

    comp = {
        "available": total_chapters > 0,
        "pct": round(pct, 1),
        "done": done,
        "total": total_chapters,
        "label": "chapters covered",
    }
    return comp, resume


def _home_opd(uid, chapter_meta):
    """OPD component + resume card.
    pct = tests completed / tests available. No mastery scaling: the engine
    already refuses to unlock Test N+1 until Test N clears PASS_THRESHOLD,
    so completion already encodes quality."""
    total_tests = 0
    for cid, meta in chapter_meta.items():
        total_tests += int(meta.get("total_tests", DEFAULT_TESTS_PER_CHAPTER) or DEFAULT_TESTS_PER_CHAPTER)

    done_tests = 0
    resume = None
    latest_at = ""
    focus = []

    for doc in db.collection("user_progress").where("user_id", "==", uid).stream():
        p = doc.to_dict() or {}
        cid = p.get("chapter_id", "")
        if cid not in chapter_meta:
            continue  # chapter was removed — don't let it inflate the numerator
        cap = int(chapter_meta[cid].get("total_tests", DEFAULT_TESTS_PER_CHAPTER) or DEFAULT_TESTS_PER_CHAPTER)
        completed = min(int(p.get("tests_completed", 0) or 0), cap)
        done_tests += completed

        # Focus areas — weakest concepts, enriched with class + subject.
        for concept_id, c in (p.get("concept_mastery", {}) or {}).items():
            m = float(c.get("mastery_score", 0) or 0)
            if m < 50:
                focus.append({
                    "concept_id": concept_id,
                    "concept_name": c.get("concept_name", concept_id),
                    "chapter_id": cid,
                    "chapter_name": p.get("chapter_name", "") or chapter_meta[cid].get("chapter_title", ""),
                    "subject": chapter_meta[cid].get("subject", ""),
                    "class_level": chapter_meta[cid].get("class", ""),
                    "mastery": round(m, 1),
                })

        # Resume card = the chapter with the most recent attempt. A chapter
        # with no attempts is only a fallback (sort key "" loses to any date).
        history = p.get("test_history", []) or []
        last_test = None
        when = ""
        if history:
            latest = max(history, key=lambda t: t.get("completed_at", "") or "")
            when = latest.get("completed_at", "") or ""
            last_test = {
                "num": latest.get("test_num"),
                "percentage": round(float(latest.get("percentage", 0) or 0), 1),
            }

        if resume is not None and when <= latest_at and not (when and not latest_at):
            continue
        latest_at = when

        pending = len(p.get("pending_interventions", []) or [])
        next_num = completed + 1
        next_test = None
        if next_num <= cap:
            next_test = {
                "num": next_num,
                "locked": (not p.get("next_test_available", True)) or pending > 0,
                "pending_interventions": pending,
            }

        resume = {
            "chapter_id": cid,
            "chapter_name": p.get("chapter_name", "") or chapter_meta[cid].get("chapter_title", ""),
            "tests_completed": completed,
            "total_tests": cap,
            "last_test": last_test,
            "next_test": next_test,
        }

    pct = (done_tests / total_tests * 100.0) if total_tests else 0.0
    comp = {
        "available": total_tests > 0,
        "pct": round(pct, 1),
        "done": done_tests,
        "total": total_tests,
        "label": "tests completed",
    }
    focus.sort(key=lambda f: f["mastery"])
    return comp, resume, focus[:5]


def _home_arena(uid):
    """Arena component + resume card. Coverage only — unique papers attempted.
    Retakes neither help nor hurt, and no score is ever surfaced on Home."""
    papers = []
    for doc in db.collection("pyq_papers").stream():
        p = doc.to_dict() or {}
        papers.append({
            "paper_id": p.get("paper_id", doc.id),
            "year": p.get("year"),
            "paper_code": p.get("paper_code"),
        })
    papers.sort(key=lambda x: (-(x.get("year") or 0), str(x.get("paper_code") or "")))
    total = len(papers)

    attempted = set()
    try:
        sessions = db.collection("pyq_sessions") \
            .where("user_id", "==", uid) \
            .where("status", "==", "completed") \
            .where("test_type", "==", "full_paper") \
            .where("arena_session", "==", True) \
            .stream()
        for doc in sessions:
            s = doc.to_dict() or {}
            attempted.add((s.get("year"), str(s.get("paper_code"))))
    except Exception as e:
        print(f"Arena coverage query failed: {e}")

    valid = {(p["year"], str(p["paper_code"])) for p in papers}
    done = len(attempted & valid)

    next_paper = None
    for p in papers:
        if (p["year"], str(p["paper_code"])) not in attempted:
            next_paper = p
            break

    pct = (done / total * 100.0) if total else 0.0
    comp = {
        "available": total > 0,
        "pct": round(pct, 1),
        "done": done,
        "total": total,
        "label": "papers attempted",
    }
    resume = {
        "papers_available": total,
        "papers_attempted": done,
        "next_paper": next_paper,
    }
    return comp, resume


def _home_vitals(uid, chapter_meta):
    """Topbar vitals that are NOT the doctor scale.

    rounds_completed — every test the student has ever SUBMITTED, anywhere:
      OPD (test_sessions) + Arena/PYQ (pyq_sessions). Counted from the session
      collections, not from user_progress.test_history, because a retest
      DELETES its test_history entry (backend.py request_retest) and rolls
      tests_completed back by one — so anything built on those two fields
      SHRINKS when a student asks for a retake. Sessions are never deleted,
      so this counter only ever goes up. A retake is effort; it counts.

    cases_due — chapters the student has opened and not finished. This is a
      worklist, not a score, so it is allowed to move in both directions.
    """
    rounds = 0
    for coll in ("test_sessions", "pyq_sessions"):
        try:
            docs = db.collection(coll) \
                .where("user_id", "==", uid) \
                .where("status", "==", "completed") \
                .stream()
            rounds += sum(1 for _ in docs)
        except Exception as e:
            print(f"Rounds count failed on {coll}: {e}")

    # cases_due doubles as the ward-card headline, and the WEAKEST open case
    # is what "Begin rounds" should take you to. Computing both here means the
    # dashboard no longer needs six /api/chapters/<subject>/<class> calls just
    # to paint one sentence.
    cases_due = 0
    weakest = None
    for doc in db.collection("user_progress").where("user_id", "==", uid).stream():
        p = doc.to_dict() or {}
        cid = p.get("chapter_id")
        if cid not in chapter_meta:
            continue
        mastery = float(p.get("overall_mastery", 0) or 0)
        started = int(p.get("tests_completed", 0) or 0) > 0 or mastery > 0
        if started and mastery < 100:
            cases_due += 1
            if weakest is None or mastery < weakest["mastery"]:
                meta = chapter_meta[cid]
                weakest = {
                    "chapter_id": cid,
                    "chapter_name": p.get("chapter_name", "") or meta.get("chapter_title", ""),
                    "subject": meta.get("subject", ""),
                    "mastery": round(mastery, 1),
                }

    return {"rounds_completed": rounds, "cases_due": cases_due, "weakest_case": weakest}


@app.route("/api/home", methods=["GET"])
@require_auth
def get_home():
    """Everything the mobile Home tab needs, in one call."""
    uid = request.uid
    try:
        user = get_user_doc(uid) or {}

        # Master chapter list (OPD + focus-area enrichment), read once.
        chapter_meta = {}
        for doc in db.collection("chapter_metadata").stream():
            m = doc.to_dict() or {}
            chapter_meta[m.get("chapter_id", doc.id)] = m

        studio_c, studio_r = _home_studio(uid)
        opd_c, opd_r, focus = _home_opd(uid, chapter_meta)
        arena_c, arena_r = _home_arena(uid)

        components = {"studio": studio_c, "opd": opd_c, "arena": arena_c}

        # ── Weight redistribution ──
        # An empty section (no content uploaded) must not be scored as zero,
        # or a student who has finished everything that exists still reads 30%.
        live = [k for k, c in components.items() if c["available"]]
        weight_sum = sum(SCALE_WEIGHTS[k] for k in live) or 1
        overall = 0.0
        for k, c in components.items():
            eff = round(SCALE_WEIGHTS[k] / weight_sum * 100) if c["available"] else 0
            c["weight"] = SCALE_WEIGHTS[k]
            c["effective_weight"] = eff
            if c["available"]:
                overall += c["pct"] * (SCALE_WEIGHTS[k] / weight_sum)
        overall = round(max(0.0, min(100.0, overall)), 1)

        # ── Rank + high-water mark ──
        # Uploading new content grows the denominator, which would silently
        # demote your most loyal students. The badge never goes backwards.
        idx = _rank_index_for(overall)
        best_idx = int(user.get("best_rank_index", 0) or 0)
        if idx > best_idx:
            best_idx = idx
            db.collection("users").document(uid).set(
                {"best_rank_index": best_idx}, merge=True)

        badge_idx = max(idx, best_idx)
        next_rank = DOCTOR_LADDER[idx + 1] if idx + 1 < len(DOCTOR_LADDER) else None

        # ── Stats strip ──
        total_tests = 0
        total_q = 0
        total_correct = 0
        for doc in db.collection("user_progress").where("user_id", "==", uid).stream():
            p = doc.to_dict() or {}
            total_tests += int(p.get("tests_completed", 0) or 0)
            for c in (p.get("concept_mastery", {}) or {}).values():
                total_q += len(c.get("questions_seen", []) or [])
                total_correct += len(c.get("questions_correct", []) or [])

        streak_current, streak_longest, _ = _read_streak(uid)
        vitals = _home_vitals(uid, chapter_meta)

        return jsonify({
            "user": {
                "name": user.get("name", "Student"),
                "class_level": user.get("class_level", ""),
                "plan": user.get("subscription", {}).get("plan", "free"),
                "target_exam": user.get("target_exam", ""),
            },
            "streak": {"current": streak_current, "longest": streak_longest},
            "doctor_scale": {
                "overall": overall,
                "rank": DOCTOR_LADDER[badge_idx],
                "true_rank": DOCTOR_LADDER[idx],
                "next_rank": next_rank,
                "ladder": DOCTOR_LADDER,
                "components": components,
            },
            "resume": {"studio": studio_r, "opd": opd_r, "arena": arena_r},
            "vitals": vitals,
            "ward": {
                "cases_due": vitals["cases_due"],
                "weakest_case": vitals["weakest_case"],
            },
            "focus": focus,
            "stats": {
                "total_tests": total_tests,
                "total_questions": total_q,
                "accuracy": calculate_mastery_score(total_correct, total_q),
                "study_streak": streak_current,
            },
        })
    except Exception as e:
        print(f"Home error: {type(e).__name__}: {e}")
        import traceback; traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ──────────────────────────────────────────────
# RUN
# ──────────────────────────────────────────────
if __name__ == "__main__":
    # Debug: Print all registered routes
    print("\n" + "="*50)
    print("REGISTERED ROUTES:")
    print("="*50)
    for rule in app.url_map.iter_rules():
        print(f"{rule.endpoint:30s} {rule.methods} {rule.rule}")
    print("="*50 + "\n")
    app.run(debug=True, host="0.0.0.0", port=5000)


# python3 -m http.server 5500
# npx localtunnel --port 5000