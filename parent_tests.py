"""
NAADI AI — PARENT TESTS  (parent_tests.py)
═══════════════════════════════════════════════════════════════════════════

WHAT THIS TAB IS FOR

    Home      "is this going all right this week?"
    Learning  "where are they in the syllabus?"
    Tests     "how did the tests actually go, and what did they get wrong?"

This tab owns the ANSWERS. It is the only place in the parent portal
where a parent can look at an actual question their child got wrong and
read why the option they picked was tempting.

───────────────────────────────────────────────────────────────────────────
WHAT THE OLD TAB WAS MISSING

Full NEET papers did not exist on it. `parent_tests` in portal_backend.py
reads test_sessions and never touches pyq_sessions -- so the Home page
now leads with "412 of 720" and there was nowhere in the entire parent
portal to open that paper. That was the largest hole.

Everything else was one flat list. Twenty-two papers plus a hundred
chapter tests is a hundred and twenty-two rows in a single column. The
teacher portal solved exactly this and the parent got none of it.

───────────────────────────────────────────────────────────────────────────
WHY THIS IMPORTS FROM teacher_student.py

Grouping attempts by paper, folding a chapter's twenty-nine tests into
one folder, normalising a question, and reading the v1->v2->v3 ladder are
all already written and already correct there. Writing a second copy for
parents is how the two drift until a teacher and a parent describe the
same twenty-two attempts differently -- the same argument that stopped a
second Studio-to-OPD id bridge being written.

So the ROW SHAPES are shared and only the WORDS are new. teacher_student
imports nothing from here, so there is no cycle.

───────────────────────────────────────────────────────────────────────────
WHAT IS SAID DIFFERENTLY TO A PARENT

  · No phase names. The ladder is translated by parent_learning's
    stage_text -- "Foundation" becomes "working through the basics".
    Five of the six internal names appear nowhere in the student app,
    so a parent could never discuss them with their child.

  · Chapter tests and full papers are never averaged or charted
    together. One is a percentage of twenty questions, the other is
    marks out of 720 with negative marking. A single "score trend"
    across both is a line through two different units.

  · Skipped and wrong are reported separately. Under negative marking
    they are opposite problems: forty left blank is a confidence
    problem, forty answered wrong is a knowledge problem, and they need
    opposite conversations at home.

───────────────────────────────────────────────────────────────────────────
NAMESPACE

Every route sits under /api/parent/v2/ and the registrar refuses to start
if one escapes. portal_backend.py already owns
/api/parent/child/<uid>/tests and /api/parent/child/<uid>/test/<sid>/review,
and Flask resolves duplicate rules to whichever blueprint registered
first, silently.
"""

from flask import Blueprint, jsonify, request

from portal_backend import (
    _db, _rollup, _pct, chapter_meta,
    require_auth, require_role, resolve_child,
    PASS_THRESHOLD,
)
from teacher_signals import canon_subject

# Shared row shapes. See the header for why these are imported rather
# than reimplemented.
from teacher_student import (
    _session_row, _paper_row, _group_papers, _group_chapters,
    _completed, _ladder, _opd_question, _paper_question, _paper_chunks,
    MAX_SESSIONS,
)
from parent_learning import stage_text

parent_tests_bp = Blueprint("parent_tests", __name__)


# ═══════════════════════════════════════════════════════════════════════
# LIMITS
# ═══════════════════════════════════════════════════════════════════════

MIN_Q_SUMMARY = 20     # before the skipped/wrong or difficulty sentence
MIN_Q_BAND = 10     # before one difficulty band is described
MAX_LADDER_IDS = 60     # base ids sent to the ladder lookup per test


# ═══════════════════════════════════════════════════════════════════════
# SMALL HELPERS
# ═══════════════════════════════════════════════════════════════════════

def _i(v, default=0):
    try:
        if isinstance(v, bool):
            return default
        return int(v)
    except (TypeError, ValueError):
        return default


def _s(v, limit=200):
    return "" if v is None else str(v)[:limit]


def _dict(v):
    return v if isinstance(v, dict) else {}


def _seq(v):
    return v if isinstance(v, (list, tuple)) else []


def _first_name(name):
    return (name or "Your child").strip().split(" ")[0] or "Your child"


def _plural(n, one, many=None):
    n = _i(n)
    return f"{n} {one}" if n == 1 else f"{n} {many or one + 's'}"


# ── WHY `wrong` IS ADJUSTED EVERYWHERE BELOW
#
# teacher_student._session_row counts:
#     wrong   = questions where is_correct is False
#     skipped = questions with no student answer
#
# A blank question has is_correct False, so it lands in BOTH. The teacher
# UI prints them side by side and quietly double-counts; for a teacher
# scanning a list that is survivable.
#
# It is not survivable here. A parent reading "12 right, 8 wrong, 1 left
# blank" on a twenty-question test will add it up, get twenty-one, and
# stop trusting the page. So `wrong` means ANSWERED AND WRONG throughout
# this file, and right + wrong + blank always equals the number asked.
def _answered_wrong(row):
    return max(0, _i(row.get("wrong")) - _i(row.get("skipped")))


# ═══════════════════════════════════════════════════════════════════════
# THE SUMMARY STRIP
#
# Two sentences that exist nowhere else in the portal, and a count.
# Deliberately sentences rather than a doughnut: "wrong 61, skipped 4"
# in a pie chart makes a parent do the reading; a sentence does it for
# them, and it is the reading that matters.
# ═══════════════════════════════════════════════════════════════════════

SUMMARY_INFO = (
    "Counted across every chapter test taken. Left blank and answered "
    "wrong are kept apart on purpose: in the real exam a wrong answer "
    "loses a mark and a blank one does not, so they are different habits "
    "with different fixes. Difficulty is the level the app assigned each "
    "question, not our opinion of it afterwards.")


def _blank_sentence(who, wrong, skipped, answered):
    total = wrong + skipped
    if answered < MIN_Q_SUMMARY:
        return ""
    if not total:
        return f"{who} has answered every question, and got them all right."
    share = skipped / (answered + skipped) * 100 if (answered + skipped) else 0
    # "wrong" does not pluralise, so every sentence below counts
    # QUESTIONS and uses "wrong" as the adjective. "58 wrongs" is the
    # kind of thing that makes a page feel machine-written.
    if skipped == 0:
        return (f"{who} attempts everything — nothing has been left blank. "
                f"The {_plural(wrong, 'mistake')} so far are all answers "
                f"that were tried and missed.")
    if share >= 20:
        return (f"{_plural(skipped, 'question')} were left blank, against "
                f"{_plural(wrong, 'question')} answered wrong. Leaving that "
                f"many unanswered usually means running short of time, or "
                f"not wanting to guess.")
    return (f"Mostly answered rather than left blank — "
            f"{_plural(wrong, 'question')} answered wrong, against "
            f"{skipped} not attempted.")


def _difficulty_sentence(who, bands):
    """Bands are Easy / Medium / Hard, each gated on its own sample."""
    ready = {b["level"]: b for b in bands if b["asked"] >= MIN_Q_BAND}
    easy, hard = ready.get("Easy"), ready.get("Hard")
    if not easy or not hard:
        return ""
    if easy["accuracy"] - hard["accuracy"] >= 20:
        return (f"The straightforward questions are going in — "
                f"{round(easy['accuracy'])}% of those come back right, "
                f"against {round(hard['accuracy'])}% of the hard ones. "
                f"That gap is where the marks are.")
    if easy["accuracy"] < 60:
        return (f"Marks are going on the straightforward questions too, "
                f"not only the hard ones — {round(easy['accuracy'])}% of "
                f"the easy ones are coming back right. That usually points "
                f"at the chapter rather than at exam technique.")
    return (f"About the same on easy and hard questions "
            f"({round(easy['accuracy'])}% and {round(hard['accuracy'])}%).")


def _summary(rows, name):
    who = _first_name(name)
    wrong = sum(_answered_wrong(r) for r in rows)
    skipped = sum(_i(r.get("skipped")) for r in rows)
    asked = sum(_i(r.get("questions")) for r in rows)
    answered = max(0, asked - skipped)
    scored = [r["pct"] for r in rows if r.get("pct") is not None]

    return {
        "tests": len(rows),
        "questions": asked,
        "wrong": wrong,
        "skipped": skipped,
        "answered": answered,
        "average": round(sum(scored) / len(scored), 1) if scored else None,
        "ready": answered >= MIN_Q_SUMMARY,
        "floor": MIN_Q_SUMMARY,
        "blank_line": _blank_sentence(who, wrong, skipped, answered),
        "info": SUMMARY_INFO,
    }


def _difficulty(uid, db, meta):
    """Per-band accuracy, read from the same sessions as everything else."""
    bands = {}
    try:
        for doc in _completed("test_sessions", uid, db):
            s = doc.to_dict() or {}
            for q in _seq(s.get("questions")):
                q = _dict(q)
                lvl = _s(q.get("difficulty"), 20) or "Medium"
                b = bands.setdefault(lvl, {"correct": 0, "asked": 0})
                if q.get("student_answer") in (None, "", {}):
                    continue          # a blank is not a difficulty signal
                b["asked"] += 1
                if q.get("is_correct"):
                    b["correct"] += 1
    except Exception as e:
        print(f"[parent_tests] difficulty read failed for {uid}: {e}")

    order = {"Easy": 0, "Medium": 1, "Hard": 2}
    return sorted(
        [{"level": k, "correct": v["correct"], "asked": v["asked"],
          "accuracy": _pct(v["correct"], v["asked"]),
          "ready": v["asked"] >= MIN_Q_BAND}
         for k, v in bands.items() if v["asked"]],
        key=lambda x: order.get(x["level"], 9))


# ═══════════════════════════════════════════════════════════════════════
# PARENT WORDS FOR SHARED ROWS
# ═══════════════════════════════════════════════════════════════════════

PAPERS_INFO = (
    "A full NEET paper is the real thing: 180 questions across all three "
    "subjects, marked out of 720, with a mark lost for every wrong "
    "answer. Attempts at the same paper are grouped together with the "
    "best one on top — open a group to see the earlier tries and how the "
    "score moved. These are never averaged with chapter tests: a "
    "percentage of twenty questions and a mark out of 720 are different "
    "units, and one number across both would mean nothing.")

CUSTOMS_INFO = (
    "Practice sets the student put together themselves. They choose the "
    "chapters and the length, so each is marked out of its own total "
    "rather than 720. Kept apart from the full papers on purpose: a "
    "short self-chosen drill and a full three-hour paper are not the "
    "same test, and on one list the drill looks like a bad paper or the "
    "paper looks like an easy drill.")

FOLDERS_INFO = (
    "One folder per chapter, split by subject and school year, newest "
    "first. The average is across every test in that chapter. Retaking a "
    "test is not a bad sign — the app asks for retakes deliberately, and "
    "they are counted separately so a retaken chapter does not look like "
    "a failing one.")

TEST_INFO = (
    "Every question in this test. Wrong and skipped ones are shown first "
    "because those are the ones worth talking about; the toggle shows all "
    "of them. Under each wrong answer is an explanation of why the option "
    "that was chosen looked right, which is usually more useful than the "
    "correct answer on its own.")

LADDER_INFO = (
    "The app asks the same idea again later, worded differently, to check "
    "whether it was really learned. This is what happened to this "
    "particular idea each time it came back.")


def _folder(f, meta):
    """A chapter folder, said to a parent."""
    m = _dict(_dict(meta).get(f["chapter_id"]))
    return {
        "chapter_id": f["chapter_id"],
        "chapter": f["chapter"],
        "subject": f["subject"],
        "class_level": _s(m.get("class", ""), 8).strip(),
        "tests": f["tests"],
        "retakes": f["retakes"],
        "average": f["average"],
        "last_at": f["last_at"],
        # Translated, never the internal name.
        "stage": stage_text(f.get("furthest_phase")),
        "latest_pct": _dict(f.get("latest")).get("pct"),
    }


def _folder_groups(folders, level):
    """Chapter tests, split by subject and school year.

    Thirty folders in one column tells a parent nothing about shape.
    Split the same way the Learning tab splits its syllabus map --
    subject first, then year with the student's own year on top -- so the
    two tabs describe the same chapters in the same order. A parent who
    has learned one layout already knows the other.
    """
    buckets = {}
    for f in folders:
        buckets.setdefault((f["subject"], f["class_level"]), []).append(f)

    def key(item):
        (sub, lvl), _rows = item
        s_rank = {"Biology": 0, "Physics": 1, "Chemistry": 2}.get(sub, 9)
        if level and lvl == level:
            return (s_rank, 0, 0)
        try:
            return (s_rank, 1, -int(lvl))
        except (TypeError, ValueError):
            return (s_rank, 2, 0)

    out = []
    for (sub, lvl), rows in sorted(buckets.items(), key=key):
        rows.sort(key=lambda f: f["last_at"] or "", reverse=True)
        out.append({
            "subject": sub,
            "class_level": lvl,
            "label": f"Class {lvl}" if lvl else "Year not set",
            "is_own_year": bool(level) and lvl == level,
            "count": sum(_i(f["tests"]) for f in rows),
            "chapters": len(rows),
            "folders": rows,
        })
    return out


def _group_out(g):
    """One paper, with every attempt at it.

    Full NEET papers and self-built practice sets go into SEPARATE
    sections. They are not comparable: one is 180 questions out of 720
    under exam conditions, the other is a short drill the student chose
    the shape of. On one list a 32/40 practice set and a 448/720 paper
    read as two entries on the same scale, and they are not.
    """
    def row(p):
        return {
            "id": p["id"],
            "marks": p["marks"],
            "max": p["max"],
            "at": p["at"],
            "air": p["air"],
            "subjects": p["subjects"],
            "minutes": round(_i(p.get("seconds")) / 60) or None,
        }

    return {
        "key": g["key"],
        "label": g["label"],
        "paper_code": g["paper_code"],
        "is_practice_set": g["kind"] == "custom",
        "attempts": g["attempts"],
        "best": row(g["best"]),
        "others": [row(o) for o in g["others"]],
        "change": g["change"],
        "last_at": g["last_at"],
    }


def _test_row(t):
    """One chapter test in a chapter's list."""
    return {
        "id": t["id"],
        "test_num": t["test_num"],
        "questions": t["questions"],
        "wrong": _answered_wrong(t),
        "skipped": _i(t["skipped"]),
        "right": max(0, _i(t["questions"]) - _i(t["wrong"])),
        "pct": t["pct"],
        "passed": (t["pct"] or 0) >= PASS_THRESHOLD if t["pct"] is not None else None,
        "is_retake": t["is_retake"],
        "minutes": round(_i(t.get("seconds")) / 60) or None,
        "stage": stage_text(t.get("phase")),
        "at": t["at"],
    }


# ═══════════════════════════════════════════════════════════════════════
# LEVEL 1 · THE OVERVIEW
# ═══════════════════════════════════════════════════════════════════════

@parent_tests_bp.route("/api/parent/v2/child/<student_uid>/tests",
                       methods=["GET"])
@require_auth
@require_role("parent")
@resolve_child
def parent_tests_v2(student_uid):
    r = _rollup(student_uid) or {}
    meta = chapter_meta() or {}
    db = _db()

    chapter_rows, paper_rows = [], []
    try:
        for doc in _completed("test_sessions", student_uid, db):
            chapter_rows.append(_session_row(doc, meta))
    except Exception as e:
        print(f"[parent_tests] test_sessions read failed for {student_uid}: {e}")
    try:
        for doc in _completed("pyq_sessions", student_uid, db):
            paper_rows.append(_paper_row(doc, meta))
    except Exception as e:
        print(f"[parent_tests] pyq_sessions read failed for {student_uid}: {e}")

    name = r.get("name", "Student")
    level = _s(r.get("class_level", ""), 8).strip()
    bands = _difficulty(student_uid, db, meta)
    summary = _summary(chapter_rows, name)
    summary["difficulty"] = bands
    summary["difficulty_line"] = _difficulty_sentence(_first_name(name), bands)

    full = [x for x in paper_rows if x["kind"] in ("arena", "paper")]
    customs = [x for x in paper_rows if x["kind"] == "custom"]
    folders = [_folder(f, meta) for f in _group_chapters(chapter_rows)]

    return jsonify({
        "child": {"uid": student_uid, "name": name,
                  "first_name": _first_name(name)},
        "summary": summary,
        # Order is deliberate and matches how the page reads: chapter
        # tests are the weekly work and the thing a parent checks most,
        # so they come first. Full papers are milestones. Practice sets
        # are the student's own extra work and sit last.
        "chapters": {
            "groups": _folder_groups(folders, level),
            "count": len(chapter_rows),
            "chapters": len(folders),
            "info": FOLDERS_INFO,
        },
        "papers": {
            "groups": [_group_out(g) for g in _group_papers(full)],
            "count": len(full),
            "info": PAPERS_INFO,
        },
        "customs": {
            "groups": [_group_out(g) for g in _group_papers(customs)],
            "count": len(customs),
            "info": CUSTOMS_INFO,
        },
        "capped": (len(chapter_rows) >= MAX_SESSIONS
                   or len(paper_rows) >= MAX_SESSIONS),
        "scanned_limit": MAX_SESSIONS,
        "pass_threshold": PASS_THRESHOLD,
    })


# ═══════════════════════════════════════════════════════════════════════
# LEVEL 2 · ONE CHAPTER'S TESTS
# ═══════════════════════════════════════════════════════════════════════

@parent_tests_bp.route(
    "/api/parent/v2/child/<student_uid>/chapter/<path:chapter_id>/tests",
    methods=["GET"])
@require_auth
@require_role("parent")
@resolve_child
def parent_chapter_tests(student_uid, chapter_id):
    meta = chapter_meta() or {}
    db = _db()
    cid = _s(chapter_id, 300)

    rows = []
    try:
        for doc in _completed("test_sessions", student_uid, db):
            row = _session_row(doc, meta)
            if row["chapter_id"] == cid:
                rows.append(row)
    except Exception as e:
        print(f"[parent_tests] chapter tests read failed: {e}")

    rows.sort(key=lambda t: (t["test_num"] or 0, t["at"] or ""), reverse=True)
    scored = [t["pct"] for t in rows if t["pct"] is not None]
    m = _dict(meta.get(cid))

    return jsonify({
        "chapter_id": cid,
        "chapter": (rows[0]["chapter"] if rows
                    else _s(m.get("chapter_title"), 160) or cid),
        "subject": (rows[0]["subject"] if rows
                    else canon_subject(m.get("subject", ""))),
        "count": len(rows),
        "average": round(sum(scored) / len(scored), 1) if scored else None,
        "retakes": sum(1 for t in rows if t["is_retake"]),
        "tests": [_test_row(t) for t in rows],
        "info": FOLDERS_INFO,
        "pass_threshold": PASS_THRESHOLD,
    })


# ═══════════════════════════════════════════════════════════════════════
# LEVEL 3 · ONE TEST IN FULL
# ═══════════════════════════════════════════════════════════════════════

@parent_tests_bp.route(
    "/api/parent/v2/child/<student_uid>/test/<path:session_id>",
    methods=["GET"])
@require_auth
@require_role("parent")
@resolve_child
def parent_test_detail(student_uid, session_id):
    db = _db()
    meta = chapter_meta() or {}
    sid = _s(session_id, 300)

    doc = db.collection("test_sessions").document(sid).get()
    is_paper = False
    if not doc.exists:
        doc = db.collection("pyq_sessions").document(sid).get()
        is_paper = True
    if not doc.exists:
        return jsonify({"error": "That test could not be found."}), 404

    s = doc.to_dict() or {}

    # The same two gates the teacher route uses. resolve_child has already
    # proved this parent owns this child; this proves the SESSION belongs
    # to that child, so a hand-typed id cannot reach another student's
    # paper. An in-progress session is refused because it leaks questions
    # the student has not been shown yet.
    if s.get("user_id") != student_uid:
        print(f"[parent_tests] SESSION SCOPE VIOLATION "
              f"parent={getattr(request, 'uid', '?')} session={sid}")
        return jsonify({"error": "That test belongs to another student."}), 403
    if s.get("status") != "completed":
        return jsonify({"error": "This test is still being taken.",
                        "code": "IN_PROGRESS"}), 403

    show = "all" if request.args.get("show") == "all" else "wrong"

    if is_paper:
        raw = [q for q in (_paper_chunks(sid, db) or _seq(s.get("questions")))
               if isinstance(q, dict)]
        qs = [_paper_question(q, i) for i, q in enumerate(raw)]
        sd = _dict(s.get("score_data"))
        head = _paper_row(doc, meta)
        head["counts"] = {
            "correct": _i(sd.get("correct_count"), None),
            "wrong": _i(sd.get("wrong_count"), None),
            "skipped": _i(sd.get("unattempted_count"), None),
        }
        head["kind"] = "paper"
        head["is_practice_set"] = _s(s.get("test_type"), 30) != "full_paper"
        head["stage"] = ""
    else:
        raw = [q for q in _seq(s.get("questions")) if isinstance(q, dict)]
        qs = [_opd_question(q, i) for i, q in enumerate(raw)]
        row = _session_row(doc, meta)
        head = {
            "kind": "chapter",
            "chapter": row["chapter"],
            "chapter_id": row["chapter_id"],
            "subject": row["subject"],
            "test_num": row["test_num"],
            "pct": row["pct"],
            "at": row["at"],
            "is_retake": row["is_retake"],
            "minutes": round(_i(row.get("seconds")) / 60) or None,
            "stage": stage_text(row.get("phase")),
            "counts": {
                "correct": sum(1 for q in qs if q["result"] == "correct"),
                "wrong": sum(1 for q in qs if q["result"] == "wrong"),
                "skipped": sum(1 for q in qs if q["result"] == "skipped"),
            },
        }
        # The ladder only exists for chapter tests: a full paper is a
        # one-off and its questions are not part of the variation cycle.
        base_ids = {q["base_id"] for q in qs if q.get("base_id")}
        if base_ids:
            lad = _ladder(set(list(base_ids)[:MAX_LADDER_IDS]),
                          student_uid, db)
            for q in qs:
                q["ladder"] = lad.get(q.get("base_id"), [])

    total = len(qs)
    if show == "wrong":
        qs = [q for q in qs if q["result"] in ("wrong", "skipped")]

    return jsonify({
        "id": sid,
        "kind": head["kind"],
        "head": head,
        "questions": qs,
        "shown": len(qs),
        "total": total,
        "show": show,
        "info": TEST_INFO,
        "ladder_info": LADDER_INFO,
        "pass_threshold": PASS_THRESHOLD,
    })


# ═══════════════════════════════════════════════════════════════════════
# REGISTRATION
# ═══════════════════════════════════════════════════════════════════════

def register_parent_tests_routes(app):
    """Mount this blueprint, refusing to start if a route could collide."""
    app.register_blueprint(parent_tests_bp)

    bad = []
    for rule in app.url_map.iter_rules():
        s = str(rule)
        if not rule.endpoint.startswith("parent_tests."):
            continue
        if not s.startswith("/api/parent/v2/"):
            bad.append(s)
    if bad:
        raise RuntimeError(
            "parent_tests.py routes must sit under /api/parent/v2/ or they "
            "will silently collide with portal_backend.py. Offending: "
            + ", ".join(sorted(set(bad))))
    return app