"""
NAADI AI — PARENT INSIGHTS  (parent_insights.py)
═══════════════════════════════════════════════════════════════════════════

    Home      is this going all right this week?
    Learning  where are they in the syllabus?
    Tests     how did the tests go, and what did they get wrong?
    Insights  WHAT IS ACTUALLY HAPPENING INSIDE THE CHAPTERS BEING
              TESTED, AND WHAT DOES THE WHOLE PICTURE ADD UP TO?

───────────────────────────────────────────────────────────────────────────
WHY THE FIRST VERSION OF THIS TAB FAILED

It sliced ONE list of weak ideas three different ways and put all three
on the same screen. "Carbon Classification and Alkane Bonding" appeared
under Slipping, again under Shakiest, and again under Stuck -- three rows
about one idea, each carrying a third of the story. A parent reading that
learns less than from one row carrying all of it.

So: ONE ROW PER CONCEPT, inside its own chapter, holding every fact about
that concept at once. Nothing is listed twice anywhere on this tab.

───────────────────────────────────────────────────────────────────────────
THE ACCURACY BUG THIS FIXES

concept_mastery.questions_seen and .questions_correct are lists of UNIQUE
question ids, and a qid is appended once and never removed. So
len(correct)/len(seen) is not accuracy -- it is a HIGH-WATER MARK. A
question answered right once and wrong four times afterwards still counts
as correct forever. The old tab printed that as "86% right" and it could
only ever go up.

Real accuracy is counted here from test_sessions instead: every question
in every completed session, every attempt including repeats. It is the
same figure the Tests tab reports, so the two tabs can never disagree
about the same chapter.

───────────────────────────────────────────────────────────────────────────
AND THE CONTRADICTION IT EXPLAINS

The old tab could print "missed 3 times in a row - 100% right overall" on
one line. Both numbers were correct: one counted unique questions ever
answered right, the other counted recent attempts. They measure different
things and should never have shared a row. With real accuracy they agree.

───────────────────────────────────────────────────────────────────────────
NO PREDICTED RANK

A rank estimate built from a handful of papers ranged, in real data, from
30 to 2,100,000. A number that unstable tells a parent nothing and
frightens them precisely. It is gone. The paper trend shows marks, which
are real.

───────────────────────────────────────────────────────────────────────────
THE TWO AGGREGATES

Both are FACTS, not forecasts, and both are things a parent can act on
without understanding any chemistry:

  WHEN THE STUDYING HAPPENS  completed_at bucketed by hour, IST. Bedtime
                             is squarely a parent's business in a way
                             that osmosis is not.

  DO RETAKES HELP            first attempts against retakes, from
                             is_retake. Either going back over things
                             works for this student or it does not, and
                             both answers are useful.

Two earlier candidates were cut for being projections dressed as facts: a
syllabus-pace forecast assumes a pace that does not exist, and "did our
re-teaching work" is us marking our own homework.

───────────────────────────────────────────────────────────────────────────
NAMESPACE

Every route sits under /api/parent/v2/ and the registrar refuses to start
if one escapes.
"""

from datetime import datetime, timezone

from flask import Blueprint, jsonify, request

from portal_backend import (
    _db, _rollup, _pct, chapter_meta, _active_phase_name,
    require_auth, require_role, resolve_child, IST_TZ,
)
from teacher_signals import canon_subject

# The same query and the same row shape the teacher portal uses. See the
# note above _papers for why this is imported rather than rewritten.
from teacher_student import _completed, _paper_row

parent_insights_bp = Blueprint("parent_insights", __name__)


# ═══════════════════════════════════════════════════════════════════════
# GATES AND LIMITS
# ═══════════════════════════════════════════════════════════════════════

MIN_Q_CONCEPT = 6      # before an idea is called solid or shaky
MIN_TREND_POINTS = 3      # two points is a coin flip, not a trend
MIN_STUCK = 2      # missed this many times in a row
MIN_RETAKES = 3      # before retakes are said to help, or not
MIN_HOUR_SESSIONS = 10     # before a study-time pattern is claimed
SOLID_AT = 70     # a plain, stated threshold — not a hidden one
SHAKY_UNDER = 45

SUBJECT_ORDER = ["Biology", "Physics", "Chemistry"]
LATE_HOURS = {22, 23, 0, 1, 2, 3}


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


def _f(v, default=0.0):
    try:
        if isinstance(v, bool):
            return default
        return float(v)
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


def _dt(ts):
    if ts is None:
        return None
    if hasattr(ts, "timestamp"):
        try:
            return datetime.fromtimestamp(ts.timestamp(), tz=timezone.utc)
        except Exception:
            return None
    if isinstance(ts, str) and ts:
        try:
            d = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return None


def _day(dt):
    """A readable date, without a platform-specific format code.

    ── THE BUG THIS EXISTS TO PREVENT
    strftime("%-d") is a glibc extension. It renders "1 Mar 2026" on
    Linux and RAISES ValueError on Windows. The dev machine is Windows,
    the loop that built these rows was wrapped in one try/except, so the
    very first paper threw and ALL of them disappeared -- the page said
    "No full paper yet" to a student with twenty-two papers.

    Two lessons, both applied below: never use a %-code that is not in
    the C standard, and never wrap a whole loop in one try when a single
    bad document should not be able to hide every good one.
    """
    if not dt:
        return ""
    d = dt.astimezone(IST_TZ)
    return f"{d.day} {d.strftime('%b %Y')}"


def _hour_label(h):
    if h == 0:
        return "12am"
    if h == 12:
        return "12pm"
    return f"{h % 12}{'am' if h < 12 else 'pm'}"


# ═══════════════════════════════════════════════════════════════════════
# ONE PASS OVER test_sessions
#
# Real per-concept accuracy, per-chapter counts, the hour-of-day pattern
# and the retake comparison -- all from a single read. The old tab read
# only user_progress and inherited its high-water-mark problem.
# ═══════════════════════════════════════════════════════════════════════

def _scan_sessions(uid):
    concepts = {}       # concept_id -> {correct, total, chapter_id}
    chapters = {}       # chapter_id -> {tests, correct, total}
    hours = {}          # 0..23 -> sessions finished in that hour
    first = {"n": 0, "sum": 0.0}
    retake = {"n": 0, "sum": 0.0}
    total_sessions = 0

    try:
        for doc in _db().collection("test_sessions") \
                .where("user_id", "==", uid) \
                .where("status", "==", "completed").stream():
            s = doc.to_dict() or {}
            cid = _s(s.get("chapter_id", ""), 200)
            qs = [q for q in _seq(s.get("questions")) if isinstance(q, dict)]
            if not qs:
                continue
            total_sessions += 1

            # Counted for EVERY session, retake or not: when the
            # studying happens and whether retakes help are both about
            # sessions, not about ideas.
            at = _dt(s.get("completed_at"))
            if at:
                hours[at.astimezone(IST_TZ).hour] = \
                    hours.get(at.astimezone(IST_TZ).hour, 0) + 1

            pct = s.get("percentage")
            if pct is not None:
                bucket = retake if s.get("is_retake") else first
                bucket["n"] += 1
                bucket["sum"] += _f(pct)

            ch = chapters.setdefault(cid, {"tests": 0, "correct": 0, "total": 0})
            ch["tests"] += 1

            # ── RETAKES DO NOT COUNT TOWARDS KNOWING AN IDEA
            #
            # A retake is the SAME questions again, taken straight after
            # the answers were shown. Counting it as evidence that an
            # idea is understood is the same inflation as the high-water
            # mark this file exists to fix -- it just takes one extra
            # step to get there.
            #
            # This is why an idea's figure here can differ from the same
            # chapter's figure on the Tests tab. Tests asks "how did the
            # tests go", and a retake is a test that happened. Insights
            # asks "does this idea stick", and a retake is not evidence
            # of that. Two questions, two denominators, both said out
            # loud in the copy rather than left to be discovered.
            if s.get("is_retake"):
                continue

            for q in qs:
                con = _s(q.get("concept_id", ""), 200)
                if not con:
                    continue
                c = concepts.setdefault(
                    con, {"correct": 0, "total": 0, "chapter_id": cid})
                c["total"] += 1
                ch["total"] += 1
                if q.get("is_correct"):
                    c["correct"] += 1
                    ch["correct"] += 1


    except Exception as e:
        print(f"[parent_insights] test_sessions scan failed for {uid}: {e}")

    return {"concepts": concepts, "chapters": chapters, "hours": hours,
            "first": first, "retake": retake, "sessions": total_sessions}


# ═══════════════════════════════════════════════════════════════════════
# ONE PASS OVER user_progress
#
# Names, the stuck streak, and the per-test history behind the direction
# arrow. No figure from here is ever printed as a percentage -- see the
# accuracy note in the header.
# ═══════════════════════════════════════════════════════════════════════

def _scan_progress(uid, meta):
    names, stuck, trend, chapters, retaught = {}, {}, {}, {}, {}

    try:
        for doc in _db().collection("user_progress") \
                .where("user_id", "==", uid).stream():
            p = doc.to_dict() or {}
            cid = _s(p.get("chapter_id", ""), 200)
            m = _dict(_dict(meta).get(cid))
            if not m:
                continue          # a deleted chapter must not inflate anything

            chapters[cid] = {
                "chapter": _s(p.get("chapter_name", "")
                              or m.get("chapter_title", ""), 160),
                "subject": canon_subject(m.get("subject", "")),
                "class_level": _s(m.get("class", ""), 8).strip(),
                "total_tests": _i(m.get("total_tests")),
                "ladder": _ladder(p),
            }

            for con_id, c in _dict(p.get("concept_mastery")).items():
                c = _dict(c)
                names[con_id] = _s(c.get("concept_name", "") or con_id, 160)
                f = _i(c.get("consecutive_concept_failures"))
                if f >= MIN_STUCK:
                    stuck[con_id] = f

            for iv in _seq(p.get("pending_interventions")):
                con = _s(_dict(iv).get("concept_id", ""), 200)
                if con:
                    retaught[con] = retaught.get(con, 0) + 1

            # Direction only. The stored figure is the one this portal
            # does not state, so it is reduced to up / down / steady here
            # and the number never leaves.
            hist = _seq(p.get("concept_mastery_history"))
            if len(hist) >= MIN_TREND_POINTS:
                series = {}
                for snap in hist:
                    snap = _dict(snap)
                    for con_id, val in _dict(snap.get("mastery_by_concept")).items():
                        series.setdefault(con_id, []).append(
                            (_i(snap.get("test_num")), _f(val)))
                for con_id, pts in series.items():
                    if len(pts) < MIN_TREND_POINTS:
                        continue
                    pts.sort(key=lambda x: x[0])
                    delta = pts[-1][1] - pts[0][1]
                    trend[con_id] = {
                        "direction": ("up" if delta > 2 else
                                      "down" if delta < -2 else "steady"),
                        "tests": len(pts),
                    }
    except Exception as e:
        print(f"[parent_insights] user_progress scan failed for {uid}: {e}")

    return {"names": names, "stuck": stuck, "trend": trend,
            "chapters": chapters, "retaught": retaught}


# ═══════════════════════════════════════════════════════════════════════
# LEVEL 1 · CHAPTERS BEING TESTED
# ═══════════════════════════════════════════════════════════════════════

CHAPTERS_INFO = (
    "Only chapters that have actually been tested on appear here — "
    "reading a chapter is not enough to say anything about the ideas "
    "inside it. They are grouped by subject and school year, the same way "
    "the other tabs group them. The line on each card is the shortest "
    "true thing about that chapter; open one to see every idea in it. "
    "Retakes are left out of these figures: a retake is the same "
    "questions again, so it says how well the answers were remembered "
    "rather than whether the idea stuck. That is why a chapter's "
    "percentage here can differ from the same chapter on the Tests tab, "
    "which counts every test that happened.")


def _chapter_signal(solid, shaky, stuck_n, total):
    """The shortest true sentence about a chapter."""
    if not total:
        return "no ideas measured yet"
    if stuck_n:
        return f"{_plural(stuck_n, 'idea')} stuck"
    if shaky:
        return f"{_plural(shaky, 'idea')} need work"
    if solid and solid == total:
        return "every idea solid"
    if solid >= max(1, total // 2):
        return "going well"
    return "still early"


def _concept_row(con_id, acc, names, stuck, trend, retaught):
    total = _i(acc.get("total"))
    correct = _i(acc.get("correct"))
    pct = _pct(correct, total)
    ready = total >= MIN_Q_CONCEPT
    state = ("solid" if ready and pct >= SOLID_AT else
             "shaky" if ready and pct < SHAKY_UNDER else
             "middling" if ready else "early")
    t = _dict(trend.get(con_id))
    return {
        "concept_id": con_id,
        "concept": names.get(con_id, con_id),
        "asked": total,
        "right": correct,
        # Real accuracy: every attempt, including repeats. Not the
        # high-water mark the old tab printed.
        "accuracy": pct if ready else None,
        "ready": ready,
        "state": state,
        "direction": t.get("direction", ""),
        "trend_tests": _i(t.get("tests")),
        "stuck": _i(stuck.get(con_id)),
        "retaught": _i(retaught.get(con_id)),
    }


def _level1(scan, prog):
    names, stuck = prog["names"], prog["stuck"]
    trend, retaught = prog["trend"], prog["retaught"]

    by_chapter = {}
    for con_id, acc in scan["concepts"].items():
        by_chapter.setdefault(acc["chapter_id"], []).append(
            _concept_row(con_id, acc, names, stuck, trend, retaught))

    cards = []
    for cid, rows in by_chapter.items():
        meta = _dict(prog["chapters"].get(cid))
        if not meta:
            continue
        ch = _dict(scan["chapters"].get(cid))
        solid = sum(1 for r in rows if r["state"] == "solid")
        shaky = sum(1 for r in rows if r["state"] == "shaky")
        stuck_n = sum(1 for r in rows if r["stuck"])
        ready = sum(1 for r in rows if r["ready"])
        cards.append({
            "chapter_id": cid,
            "chapter": meta["chapter"],
            "subject": meta["subject"],
            "class_level": meta["class_level"],
            "tests": _i(ch.get("tests")),
            "ideas": len(rows),
            "ready": ready,
            "solid": solid,
            "shaky": shaky,
            "stuck": stuck_n,
            "accuracy": _pct(_i(ch.get("correct")), _i(ch.get("total")))
            if _i(ch.get("total")) else None,
            "stage": next((x["label"] for x in meta.get("ladder", [])
                           if x["current"]), ""),
            "signal": _chapter_signal(solid, shaky, stuck_n, ready),
            "tone": ("bad" if stuck_n else "warn" if shaky else
                     "good" if solid and solid >= max(1, ready // 2) else "flat"),
        })

    groups = {}
    for c in cards:
        groups.setdefault((c["subject"], c["class_level"]), []).append(c)

    out = []
    for (sub, lvl), rows in groups.items():
        rows.sort(key=lambda c: (-c["stuck"], -c["shaky"], c["chapter"]))
        out.append({"subject": sub, "class_level": lvl,
                    "label": f"Class {lvl}" if lvl else "Year not set",
                    "chapters": rows})
    out.sort(key=lambda g: (SUBJECT_ORDER.index(g["subject"])
                            if g["subject"] in SUBJECT_ORDER else 9,
                            g["class_level"]))
    return out


# ═══════════════════════════════════════════════════════════════════════
# LEVEL 2 · ONE CHAPTER, ONE ROW PER IDEA
# ═══════════════════════════════════════════════════════════════════════

LEVEL2_INFO = (
    "Every idea this chapter has tested, one line each, with everything "
    "known about it together — how many questions on it came back right, "
    "which way it has been moving across tests, and whether it is "
    "currently going wrong repeatedly. Retakes are not counted — the "
    "same questions asked again straight after the answers were shown "
    "say little about whether an idea stuck. Ideas asked fewer than six "
    "times "
    "are listed but not judged. An idea is only ever listed once: the "
    "same idea appearing under three different headings was the main "
    "thing wrong with the old version of this page.")

# ── THE DIFFICULTY LADDER, AS A SCALE
#
# OPD walks a chapter through six stages of increasing difficulty. Five
# of the six names appear NOWHERE in the student app -- only "Grand Mock"
# does, as a chip in test-engine.js -- so a parent reading "Skill
# Building" learns a word they cannot use with their child.
#
# The ladder itself is genuinely useful: it says how hard the questions
# have got, which no percentage does. So the shape is kept, the plain
# label leads, and the engine's own name is carried alongside it -- a
# parent who hears "Mastery" from a teacher or from their child can then
# match it to what they are looking at.
#
# NOTE: the sixth stage was renamed. opd_engine.py line 100 reads
#   ENDURANCE = "Endurance"          # was "Bonus Pool"
# so "Bonus Pool" is the OLD name and is not what the engine writes into
# phase_state today. Using it here would label a stage that never
# matches.
PHASE_ORDER = ["Foundation", "Skill Building", "Mastery",
               "NEET Simulation", "Grand Mock", "Endurance"]

_STAGE_LABEL = {
    "Foundation": "The basics",
    "Skill Building": "Harder questions",
    "Mastery": "Mixed, exam style",
    "NEET Simulation": "Full exam-style sets",
    "Grand Mock": "Full-length mocks",
    "Endurance": "Long mixed sets",
}

LADDER_INFO = (
    "Chapter tests get harder as a chapter goes on. They start on the "
    "basics, move to harder questions, then to mixed exam-style ones, "
    "and finally to full-length papers. This shows how far along that "
    "run this chapter has got — it is about the difficulty of the "
    "questions being asked, not about how well they are being answered. "
    "The smaller name under each step is what the app itself calls that "
    "stage, so it matches what a teacher or the student might say. "
    "A chapter can sit near the start for a long time and that is not a "
    "problem in itself; it means the earlier questions are still doing "
    "their job.")


def _ladder(progress_doc):
    """The stage scale for one chapter, translated, with the current
    step marked. Returns [] when the chapter has no stage recorded."""
    ps = _dict(progress_doc.get("phase_state"))
    if not ps:
        return []
    current = _active_phase_name(progress_doc)
    try:
        at = PHASE_ORDER.index(current)
    except ValueError:
        at = -1
    return [{
        "label": _STAGE_LABEL[name],
        # The engine's own name, shown alongside the plain one.
        "name": name,
        "done": _dict(ps.get(name)).get("status") == "complete",
        "current": name == current,
        "reached": at >= 0 and i <= at,
    } for i, name in enumerate(PHASE_ORDER)]


REPEAT_INFO = (
    "When an idea goes wrong, the app brings it back later worded "
    "differently instead of repeating the same question. 'Held' means it "
    "came back right the next time; 'went again' means it did not. This "
    "is the clearest evidence of whether something has actually been "
    "learned rather than remembered.")


def _level2(cid, scan, prog):
    names, stuck = prog["names"], prog["stuck"]
    trend, retaught = prog["trend"], prog["retaught"]
    meta = _dict(prog["chapters"].get(cid))
    ch = _dict(scan["chapters"].get(cid))

    rows = [_concept_row(con_id, acc, names, stuck, trend, retaught)
            for con_id, acc in scan["concepts"].items()
            if acc["chapter_id"] == cid]

    # Worst first, and an unjudged idea never outranks a real problem.
    order = {"shaky": 0, "middling": 1, "solid": 2, "early": 3}
    rows.sort(key=lambda r: (-r["stuck"], order.get(r["state"], 9),
                             r["accuracy"] if r["accuracy"] is not None else 999))

    return {
        "chapter_id": cid,
        "chapter": meta.get("chapter", cid),
        "subject": meta.get("subject", ""),
        "class_level": meta.get("class_level", ""),
        "tests": _i(ch.get("tests")),
        "accuracy": _pct(_i(ch.get("correct")), _i(ch.get("total")))
        if _i(ch.get("total")) else None,
        "asked": _i(ch.get("total")),
        "ladder": meta.get("ladder", []),
        "ladder_info": LADDER_INFO,
        "ideas": rows,
        "counts": {
            "solid": sum(1 for r in rows if r["state"] == "solid"),
            "shaky": sum(1 for r in rows if r["state"] == "shaky"),
            "stuck": sum(1 for r in rows if r["stuck"]),
            "early": sum(1 for r in rows if r["state"] == "early"),
        },
        "floor": MIN_Q_CONCEPT,
        "solid_at": SOLID_AT,
        "shaky_under": SHAKY_UNDER,
        "info": LEVEL2_INFO,
        "repeat_info": REPEAT_INFO,
    }


# ═══════════════════════════════════════════════════════════════════════
# FULL NEET PAPERS OVER TIME
#
# Marks, not a rank. A rank estimate on real data ranged from 30 to
# 2,100,000 across the same student's papers -- a number that unstable
# frightens a parent precisely and tells them nothing.
#
# The three subject lines are the point: they answer "which subject is
# costing the seat", which nothing else in the portal does.
# ═══════════════════════════════════════════════════════════════════════

PAPERS_INFO = (
    "Every full NEET paper, oldest first, marked out of 720. The three "
    "lines underneath are the subject marks — Biology out of 360, "
    "Physics and Chemistry out of 180 each — because a total can stay "
    "flat while one subject climbs and another falls. There is "
    "deliberately no predicted rank here: rank estimates from a handful "
    "of papers swing so wildly that they mislead more than they tell "
    "you.")


# A full NEET paper is 180 questions: 90 Biology, 45 Physics, 45
# Chemistry, four marks each. teacher_student._paper_row defaults every
# subject's max to 180, which is right for two of the three and wrong for
# Biology -- real data rendered "Biology 345/180". The paper's own stored
# max wins when it has one; this is the fallback.
SUBJECT_MAX = {"Biology": 360, "Physics": 180, "Chemistry": 180}


def _papers(uid):
    """Every full NEET paper, GROUPED BY PAPER.

    ── WHY GROUPED
    Twenty-two attempts in one flat list is unreadable, and worse than
    unreadable: thirteen of them were the same paper, so the "change
    since the first" was measured between two different exams. Attempts
    at NEET 2025 belong next to each other and nowhere near NEET 2024.

    ── WHY THIS DOES NOT FILTER IN THE QUERY
    An earlier version asked Firestore for user_id AND status AND
    test_type. Three equality filters need a composite index; without one
    the query raises. The teacher portal has always read this collection
    with two filters and classified in Python, so this does the same --
    same query, same _paper_row shape, no index to forget.
    """
    rows = []
    try:
        docs = list(_completed("pyq_sessions", uid, _db()))
    except Exception as e:
        print(f"[parent_insights] pyq_sessions query failed for {uid}: {e}")
        docs = []

    for doc in docs:
        # One try PER DOCUMENT. The whole loop used to sit inside a single
        # try, so one paper that failed to render took every other paper
        # down with it and the page reported none at all.
        try:
            # _paper_row's meta argument is unused for pyq_sessions --
            # a paper is not tied to a chapter.
            r = _paper_row(doc, {})
            # arena and paper are both full papers; custom drills are the
            # student's own short sets and belong on the Tests tab.
            if r["kind"] not in ("arena", "paper") or r["marks"] is None:
                continue
            at = _dt(r["at"])
            subs = {x["subject"]: x for x in r["subjects"]}
            rows.append({
                "id": r["id"],
                "marks": r["marks"],
                "max": r["max"] or 720,
                "at": r["at"],
                "day": _day(at),
                "label": r["label"],
                "paper_code": r["paper_code"],
                "year": r["year"],
                "minutes": round(_i(r.get("seconds")) / 60) or None,
                "is_arena": r["kind"] == "arena",
                "subjects": [
                    {"subject": k,
                     "marks": subs[k]["marks"],
                     "max": subs[k]["max"] if subs[k]["max"] not in (None, 180)
                     or k != "Biology" else SUBJECT_MAX[k]}
                    for k in SUBJECT_ORDER if k in subs
                ],
            })
        except Exception as e:
            print(f"[parent_insights] skipped paper {getattr(doc, 'id', '?')}"
                  f" for {uid}: {e}")

    # ── group by the paper itself, not by the attempt
    groups = {}
    for r in rows:
        key = (f"{r['year']}|{r['paper_code']}" if r["year"]
               else r["label"] or "Paper")
        groups.setdefault(key, []).append(r)

    out = []
    for key, pts in groups.items():
        pts.sort(key=lambda x: x["at"] or "")
        marks = [x["marks"] for x in pts]
        first, latest = pts[0], pts[-1]

        # Per subject, first attempt at THIS paper to the latest attempt
        # at THIS paper. Comparing across two different exams, which the
        # flat list did, compares nothing.
        moves = []
        if len(pts) >= 2:
            for sub in SUBJECT_ORDER:
                have = [x for x in pts
                        if any(y["subject"] == sub and y["marks"] is not None
                               for y in x["subjects"])]
                if len(have) < 2:
                    continue

                def g(x, _sub=sub):
                    return next(y for y in x["subjects"] if y["subject"] == _sub)

                a, b = g(have[0]), g(have[-1])
                moves.append({"subject": sub, "first": a["marks"],
                              "latest": b["marks"],
                              "max": b["max"] or SUBJECT_MAX[sub],
                              "change": b["marks"] - a["marks"]})

        title = (f"NEET {first['year']}" if first["year"]
                 else _s(first["label"], 80) or "Paper")
        out.append({
            "key": key,
            "title": title,
            "paper_code": first["paper_code"],
            "year": first["year"],
            "attempts": len(pts),
            "best": max(marks),
            "first": first["marks"],
            "latest": latest["marks"],
            "max": first["max"] or 720,
            "change": latest["marks"] - first["marks"] if len(pts) >= 2 else None,
            "first_at": first["at"],
            "last_at": latest["at"],
            "last_day": latest["day"],
            # Oldest first: a line is read left to right.
            "points": pts,
            "moves": moves,
        })

    out.sort(key=lambda g: g["last_at"] or "", reverse=True)
    return {"groups": out, "count": len(rows), "papers": len(out),
            "best": max((r["marks"] for r in rows), default=None),
            "info": PAPERS_INFO}


# ═══════════════════════════════════════════════════════════════════════
# WHEN THE STUDYING HAPPENS
#
# A fact, not a forecast, and the one thing on these four tabs a parent
# can act on directly. Bedtime is squarely their business in a way that
# osmosis is not.
# ═══════════════════════════════════════════════════════════════════════

HOURS_INFO = (
    "The hour each test was finished, in Indian time, across every test "
    "taken. It says nothing about how long was spent reading — only when "
    "tests were submitted. Shown once at least ten tests exist, because "
    "three tests would describe three evenings rather than a habit.")


def _hours(hours, sessions, name):
    who = _first_name(name)
    ready = sessions >= MIN_HOUR_SESSIONS
    buckets = [{"hour": h, "label": _hour_label(h), "count": _i(hours.get(h)),
                "late": h in LATE_HOURS} for h in range(24)]
    late = sum(b["count"] for b in buckets if b["late"])
    peak = max(buckets, key=lambda b: b["count"]) if sessions else None

    line = ""
    if ready and peak and peak["count"]:
        share = round(late / sessions * 100)
        if share >= 40:
            line = (f"Most of {who}'s testing happens late — {share}% of it "
                    f"after 10pm, with the busiest hour around "
                    f"{peak['label']}. Worth knowing if mornings are hard.")
        elif share >= 15:
            line = (f"The busiest hour is around {peak['label']}, and "
                    f"{share}% of tests are finished after 10pm.")
        else:
            line = (f"The busiest hour is around {peak['label']}, and almost "
                    f"nothing happens after 10pm.")

    return {"buckets": buckets, "sessions": sessions, "late": late,
            "peak_hour": peak["hour"] if peak and peak["count"] else None,
            "ready": ready, "floor": MIN_HOUR_SESSIONS,
            "line": line, "info": HOURS_INFO}


# ═══════════════════════════════════════════════════════════════════════
# DO RETAKES HELP THIS STUDENT
# ═══════════════════════════════════════════════════════════════════════

RETAKE_INFO = (
    "The app asks for a test to be retaken when enough of it went wrong. "
    "This compares the average score on first attempts with the average "
    "on retakes, for this student only. It is not a judgement — some "
    "students gain a lot from going back over things and some do not, "
    "and knowing which is more useful than assuming.")


def _retakes(first, retake, name):
    who = _first_name(name)
    fn, rn = _i(first["n"]), _i(retake["n"])
    ready = rn >= MIN_RETAKES and fn >= MIN_RETAKES
    fa = round(first["sum"] / fn, 1) if fn else None
    ra = round(retake["sum"] / rn, 1) if rn else None

    line = ""
    if ready:
        gain = round(ra - fa)
        if gain >= 8:
            line = (f"Going back over things clearly works for {who} — "
                    f"retaken tests average {round(ra)}% against "
                    f"{round(fa)}% first time.")
        elif gain <= -8:
            line = (f"Retakes come out lower than first attempts "
                    f"({round(ra)}% against {round(fa)}%). That usually "
                    f"means they are being taken too soon after the first "
                    f"one, before anything has been re-read.")
        else:
            line = (f"Retakes land at about the same as first attempts "
                    f"({round(ra)}% against {round(fa)}%).")

    return {"first_avg": fa, "first_n": fn, "retake_avg": ra, "retake_n": rn,
            "ready": ready, "floor": MIN_RETAKES, "line": line,
            "info": RETAKE_INFO}


# ═══════════════════════════════════════════════════════════════════════
# THE ENDPOINTS
# ═══════════════════════════════════════════════════════════════════════

@parent_insights_bp.route("/api/parent/v2/child/<student_uid>/insights",
                          methods=["GET"])
@require_auth
@require_role("parent")
@resolve_child
def parent_insights_v2(student_uid):
    r = _rollup(student_uid) or {}
    meta = chapter_meta() or {}
    name = r.get("name", "Student")

    scan = _scan_sessions(student_uid)
    prog = _scan_progress(student_uid, meta)

    return jsonify({
        "child": {"uid": student_uid, "name": name,
                  "first_name": _first_name(name)},
        "chapters": {"groups": _level1(scan, prog),
                     "tested": len(scan["chapters"]),
                     "info": CHAPTERS_INFO},
        "papers": _papers(student_uid),
        "hours": _hours(scan["hours"], scan["sessions"], name),
        "retakes": _retakes(scan["first"], scan["retake"], name),
    })


@parent_insights_bp.route(
    "/api/parent/v2/child/<student_uid>/insights/chapter/<path:chapter_id>",
    methods=["GET"])
@require_auth
@require_role("parent")
@resolve_child
def parent_insights_chapter(student_uid, chapter_id):
    meta = chapter_meta() or {}
    cid = _s(chapter_id, 300)

    scan = _scan_sessions(student_uid)
    prog = _scan_progress(student_uid, meta)

    if cid not in prog["chapters"]:
        return jsonify({"error": "That chapter could not be found."}), 404

    return jsonify(_level2(cid, scan, prog))


# ═══════════════════════════════════════════════════════════════════════
# REGISTRATION
# ═══════════════════════════════════════════════════════════════════════

def register_parent_insights_routes(app):
    """Mount this blueprint, refusing to start if a route could collide."""
    app.register_blueprint(parent_insights_bp)

    bad = []
    for rule in app.url_map.iter_rules():
        s = str(rule)
        if not rule.endpoint.startswith("parent_insights."):
            continue
        if not s.startswith("/api/parent/v2/"):
            bad.append(s)
    if bad:
        raise RuntimeError(
            "parent_insights.py routes must sit under /api/parent/v2/ or "
            "they will silently collide with portal_backend.py. Offending: "
            + ", ".join(sorted(set(bad))))
    return app