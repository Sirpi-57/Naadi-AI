"""
NAADI AI — PARENT HOME  (parent_home.py)
═══════════════════════════════════════════════════════════════════════════

THE ONE RULE

Every sentence this file produces must be readable by a parent who has
never opened the app, does not know what a "concept" is in our schema,
and has ninety seconds before dinner. That means:

    NO  "Mastery 41%"            — mastery of what, measured how
    NO  "Progress to Doctor 47%" — a rank their child has never heard of
    NO  "Retention 62%"          — our word, not theirs
    NO  "OPD coverage"           — OPD is our internal name for tests

    YES "Sirpi studied on 4 of the last 7 days, up from 2."
    YES "Of 20 ideas we asked again in a different form, 8 came back
         right."

───────────────────────────────────────────────────────────────────────────
THE SECOND RULE: NEVER SHOW OUR PIPELINE AS THEIR PROGRESS

The first version drew its subject bars from chapter_metadata and called
it the syllabus. chapter_metadata is the OPD question bank, not the
syllabus, and during content build-out it holds a fraction of it. A
parent saw "1 of 1 chapters opened" and read "my child has finished
Chemistry", when it meant "one Chemistry chapter has questions written
for it". Physics vanished from the page entirely because it had no
question bank yet -- while the child was reading Physics in Concept
Studio every day.

That is worse than a confusing metric. It is a false reassurance, and it
came from putting our content schedule inside a number about a child.

───────────────────────────────────────────────────────────────────────────
WHICH IS WHY READING AND TESTING ARE TWO TRACKS

Not one number split for display. They come from two different
collections with two different chapter universes and two different
denominators, and cannot share one even in principle:

    READING   revision_chapters/{class}_{subject}
              the full Concept Studio syllabus

    TESTING   chapter_metadata
              chapters that have a question bank

A chapter with reading material and no question bank is a normal state --
Studio content routinely lands first. So every subject renders, always,
and a subject with no question bank yet says so instead of disappearing.

───────────────────────────────────────────────────────────────────────────
WHY EVERY NUMBER IS GATED

teacher_signals.py refuses to speak without a minimum sample, because a
teacher who chases a child who is merely NEW stops trusting the page. A
parent is worse: they cannot see the child in class every day to correct
the impression, and a false alarm at home becomes an argument.

`_ready()` is the same idea. A number that has not earned the right to be
stated is returned as None and rendered as "not enough yet", never as 0%.

───────────────────────────────────────────────────────────────────────────
WHY ACCURACY IS RECENT, NOT LIFETIME

The first version divided every correct answer ever by every question
ever. A student improving sharply this month barely moved it, and it
blended a finished chapter with one started yesterday. The headline
number is now the last 4 weeks against the 4 weeks before, because "up
from 58%" is actionable and "65%" is not. Lifetime stays as a quiet
secondary line.

───────────────────────────────────────────────────────────────────────────
WHY EVERY BLOCK CARRIES `info`

A parent cannot act on a number whose definition they were taught at an
induction they may have missed, or joined after. Every block ships the
plain-English explanation of itself, rendered behind an (i) button. The
copy lives here, beside the arithmetic it describes, so the two cannot
drift apart.

───────────────────────────────────────────────────────────────────────────
PRONOUNS

None. We do not collect the child's pronouns yet, and guessing from a
name is worse than not trying. Copy uses the first name, and "they"
where a pronoun is unavoidable.

───────────────────────────────────────────────────────────────────────────
NAMESPACE

Every route sits under /api/parent/v2/. portal_backend.py already owns
/api/parent/child/<uid>/home, and Flask resolves duplicate rules to
whichever blueprint registered first, silently and with no error. The
guard in register_parent_home_routes() turns that into a startup crash.
"""

from datetime import datetime, timezone, timedelta

from flask import Blueprint, request, jsonify

from portal_backend import (
    _db, _rollup, _user, _pct, _days_since,
    chapter_meta, require_auth, require_role, resolve_child,
    _study_day_grid, PASS_THRESHOLD,
)
from teacher_signals import canon_subject
from parent_syllabus import studio_syllabus, invalidate_studio_syllabus

parent_home_bp = Blueprint("parent_home", __name__)


# ═══════════════════════════════════════════════════════════════════════
# GATES AND LIMITS
# ═══════════════════════════════════════════════════════════════════════

MIN_Q_RECENT = 8      # before a recent accuracy % is stated
MIN_Q_SUBJECT = 8      # before a per-subject accuracy % is stated
MIN_AUDITS = 5      # before a "how much stuck" % is stated
MIN_CONCEPT_Q = 6      # before one idea is named as a weak spot

RECENT_DAYS = 28     # the accuracy window
WEEK_DAYS = 7
MAX_ALERTS_SHOWN = 2      # the rest collapse behind a count
MAX_TALK = 2
MAX_WEEK_ROWS = 8
MAX_LOST = 3
HEAT_WEEKS = 8      # 12 was mostly empty and read as failure
MIN_MINUTES_SHOWN = 10     # below this, "a few minutes" beats "1 minute"

SUBJECT_ORDER = ["Biology", "Physics", "Chemistry"]


# ═══════════════════════════════════════════════════════════════════════
# SMALL HELPERS
# ═══════════════════════════════════════════════════════════════════════

def _first_name(name):
    return (name or "Your child").strip().split(" ")[0] or "Your child"


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


def _ready(count, floor):
    """Enough evidence to state a percentage? 'No' is a real answer."""
    return _i(count) >= floor


def _plural(n, one, many=None):
    n = _i(n)
    return f"{n} {one}" if n == 1 else f"{n} {many or one + 's'}"


def _subject_of(chapter_id, meta):
    m = _dict(_dict(meta).get(chapter_id))
    return canon_subject(m.get("subject", "")) if m else "Unassigned"


def _chapter_name(chapter_id, meta, fallback=""):
    m = _dict(_dict(meta).get(chapter_id))
    return _s(m.get("chapter_title", "") or fallback or chapter_id, 160)


def _dt(ts):
    """Firestore timestamp / datetime / ISO string -> aware datetime or None."""
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


# ═══════════════════════════════════════════════════════════════════════
# THE CONCEPT STUDIO SYLLABUS
#
# The reading track's denominator, and it does NOT come from
# chapter_metadata. Cached with a short TTL for the same reason
# chapter_meta is: a newly uploaded chapter must appear within minutes,
# not at the next restart. A missing TTL here is a parent-visible content
# gap, not an optimisation detail.
# ═══════════════════════════════════════════════════════════════════════

# The loader moved to parent_syllabus.py when the Learning tab needed the
# chapter NAMES as well as the counts. Two readers of one collection is
# how you get two caches that disagree about what the syllabus is -- a
# reading bar reading "9 of 28" beside a map with 27 tiles. One read, one
# cache, both shapes derived from it. The name and shape imported here are
# unchanged, so nothing on this page moved.


def _studio_parts(chapter_id, doc_fields=None):
    """A Studio chapter id is "{Subject}_{class}_{ChapterName}"."""
    d = _dict(doc_fields)
    sub = canon_subject(d.get("subject", ""))
    lvl = _s(d.get("class", ""), 8).strip()
    if sub != "Unassigned" and lvl:
        return sub, lvl
    parts = str(chapter_id or "").split("_")
    if len(parts) >= 2:
        p_sub = canon_subject(parts[0])
        p_lvl = parts[1] if parts[1].isdigit() else ""
        return (sub if sub != "Unassigned" else p_sub), (lvl or p_lvl)
    return sub, lvl


# ═══════════════════════════════════════════════════════════════════════
# ONE PASS OVER TEST SESSIONS
#
# The old home page ran THREE full scans of this collection per load.
# This does it once and returns everything: the 7-day feed, the 7-day and
# prior-week effort buckets, and the two 4-week windows behind the trend.
# ═══════════════════════════════════════════════════════════════════════

def _scan_tests(uid, meta):
    now = datetime.now(timezone.utc)
    wk1 = now - timedelta(days=WEEK_DAYS)
    wk2 = now - timedelta(days=WEEK_DAYS * 2)
    acc1 = now - timedelta(days=RECENT_DAYS)
    acc2 = now - timedelta(days=RECENT_DAYS * 2)

    def bucket():
        return {"tests": 0, "correct": 0, "total": 0, "seconds": 0}

    this_w, last_w = bucket(), bucket()
    recent = {"correct": 0, "total": 0}
    prior = {"correct": 0, "total": 0}
    rows = []
    days_this, days_last = set(), set()

    try:
        for doc in _db().collection("test_sessions") \
                .where("user_id", "==", uid) \
                .where("status", "==", "completed").stream():
            s = doc.to_dict() or {}
            at = _dt(s.get("completed_at"))
            if at is None:
                continue

            qs = _seq(s.get("questions"))
            correct = sum(1 for q in qs if _dict(q).get("is_correct"))

            # ── the accuracy trend windows
            if at >= acc1:
                recent["correct"] += correct
                recent["total"] += len(qs)
            elif at >= acc2:
                prior["correct"] += correct
                prior["total"] += len(qs)

            # ── the effort windows
            if at >= wk1:
                b, days = this_w, days_this
            elif at >= wk2:
                b, days = last_w, days_last
            else:
                continue

            days.add(at.date().isoformat())
            b["tests"] += 1
            b["correct"] += correct
            b["total"] += len(qs)

            secs = _i(s.get("time_taken_seconds"))
            # A six-hour session is an abandoned tab, not study time.
            if 0 < secs < 3 * 3600:
                b["seconds"] += secs

            if b is not this_w:
                continue

            cid = _s(s.get("chapter_id", ""), 200)
            pct = s.get("percentage")
            rows.append({
                "kind": "test",
                "at": at.isoformat(),
                "subject": _subject_of(cid, meta),
                "chapter": _chapter_name(
                    cid, meta, _s(s.get("chapter_name", ""), 160)),
                "right": correct,
                "asked": len(qs) or _i(s.get("total_questions")),
                "pct": round(_f(pct), 1) if pct is not None else None,
                "good": _f(pct) >= PASS_THRESHOLD if pct is not None else True,
            })
    except Exception as e:
        print(f"[parent_home] test_sessions scan failed for {uid}: {e}")

    return {"this": this_w, "last": last_w, "recent": recent, "prior": prior,
            "rows": rows, "days_this": days_this, "days_last": days_last}


# ═══════════════════════════════════════════════════════════════════════
# ONE PASS OVER REVISION PROGRESS
#
# Two jobs from one read: the 7-day reading feed, and the reading-track
# numerator for every subject. Counting reading coverage here rather than
# from signals.studio_by_chapter avoids the id-scheme bridge entirely --
# these documents ARE the Studio ids.
# ═══════════════════════════════════════════════════════════════════════

def _scan_studio(uid):
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=WEEK_DAYS)
    rows, days = [], set()
    opened = {}          # (subject, class) -> chapters opened

    try:
        for doc in _db().collection("users").document(uid) \
                .collection("revision_progress").stream():
            d = doc.to_dict() or {}
            cid = _s(d.get("chapter_id", "") or doc.id, 200)
            pct = _f(d.get("completion_percentage"))
            # Touched counts. A student six blocks in who has marked none
            # done sits at 0% and would otherwise read as "never opened".
            touched = len(set(_seq(d.get("blocks_completed")))
                          | set(_seq(d.get("blocks_opened"))))
            sub, lvl = _studio_parts(cid, d)
            if (pct > 0 or touched > 0) and sub != "Unassigned":
                key = (sub, lvl)
                opened[key] = opened.get(key, 0) + 1

            at = _dt(d.get("last_active"))
            if at is None or at < cutoff:
                continue
            days.add(at.date().isoformat())
            rows.append({
                "kind": "reading",
                "at": at.isoformat(),
                "subject": sub,
                "chapter": _s(d.get("chapter_name", ""), 160) or cid,
                "pct": round(pct, 1),
                "good": True,
            })
    except Exception as e:
        print(f"[parent_home] revision_progress scan failed for {uid}: {e}")

    return {"rows": rows, "days": days, "opened": opened}


# ═══════════════════════════════════════════════════════════════════════
# ONE PASS OVER PYQ SESSIONS
#
# Full NEET papers and custom tests. A full paper mark out of 720 is the
# single most legible number in this product to a NEET parent, and it was
# not on the page at all.
#
# Best AND most recent are both kept, because they answer different
# questions -- the same reason teacher_student._group_papers keeps both.
# ═══════════════════════════════════════════════════════════════════════

def _scan_papers(uid):
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=WEEK_DAYS)
    papers, customs, rows = [], [], []

    try:
        for doc in _db().collection("pyq_sessions") \
                .where("user_id", "==", uid) \
                .where("status", "==", "completed").stream():
            s = doc.to_dict() or {}
            sd = _dict(s.get("score_data"))
            bd = _dict(sd.get("subject_breakdown"))
            is_paper = s.get("test_type") == "full_paper"
            year = _i(s.get("year"), None)
            at = (_dt(sd.get("completed_at")) or _dt(s.get("completed_at"))
                  or _dt(s.get("created_at")))
            marks = sd.get("total_marks")

            label = _s(s.get("label"), 80) or (
                f"NEET {year}" if year else
                ("Full paper" if is_paper else "Custom test"))

            rec = {
                "label": label,
                "year": year,
                "marks": _i(marks, None) if marks is not None else None,
                "max": _i(sd.get("max_marks"), None) or (720 if is_paper else None),
                "correct": _i(sd.get("correct_count"), None),
                "wrong": _i(sd.get("wrong_count"), None),
                "unattempted": _i(sd.get("unattempted_count"), None),
                "subjects": [
                    {"subject": canon_subject(_s(k, 40)),
                     "marks": _i(_dict(v).get("marks"), None),
                     "max": _i(_dict(v).get("max"), None) or 180}
                    for k, v in sorted(bd.items(), key=lambda kv: _s(kv[0]))
                    if isinstance(v, dict)
                ],
                "at": at.isoformat() if at else "",
            }
            (papers if is_paper else customs).append(rec)

            if at and at >= cutoff:
                rows.append({
                    "kind": "paper" if is_paper else "custom",
                    "at": at.isoformat(),
                    "subject": "",
                    "chapter": label,
                    "pct": None,
                    "marks": rec["marks"],
                    "max": rec["max"],
                    "good": True,
                })
    except Exception as e:
        print(f"[parent_home] pyq_sessions scan failed for {uid}: {e}")

    def newest(lst):
        return max(lst, key=lambda x: x["at"] or "") if lst else None

    def best(lst):
        scored = [x for x in lst if x["marks"] is not None]
        return max(scored, key=lambda x: x["marks"]) if scored else None

    return {
        "papers": {"count": len(papers), "last": newest(papers),
                   "best": best(papers)},
        "customs": {"count": len(customs), "last": newest(customs)},
        "rows": rows,
    }


PAPERS_INFO = (
    "A full NEET paper is the real thing: 180 questions across Biology, "
    "Physics and Chemistry, marked out of 720 with negative marking. It "
    "is the closest number here to what the exam itself will produce. "
    "Both the best score and the most recent one are shown, because they "
    "answer different questions -- what they can do on a good day, and "
    "where they are right now. Custom tests are shorter practice sets "
    "the student builds themselves, so they are counted separately and "
    "not mixed into the paper score.")


# ═══════════════════════════════════════════════════════════════════════
# SHOWING UP
# ═══════════════════════════════════════════════════════════════════════

EFFORT_INFO = (
    "Counted over the last 7 days ending today, not from Monday. A day "
    "counts if any reading or any test happened on it. The comparison "
    "with last week counts test days only, because the app keeps just "
    "the most recent reading date for each chapter, so older reading "
    "days cannot be recovered honestly.")


def _effort(r, tests, studio, grid):
    days_this = set(tests["days_this"]) | set(studio["days"])
    mins = round(tests["this"]["seconds"] / 60)

    return {
        "days_this_week": len(days_this),
        "days_last_week": len(tests["days_last"]),
        "streak_current": _i(r.get("streak_current")),
        "streak_longest": _i(r.get("streak_longest")),
        "minutes_this_week": mins,
        # "1 minute inside tests this week" reads as a rounding error and
        # trivialises a real session. Under ten minutes, say it vaguely.
        "minutes_vague": 0 < mins < MIN_MINUTES_SHOWN,
        "tests_this_week": tests["this"]["tests"],
        "tests_last_week": tests["last"]["tests"],
        "grid": grid,
        "window_days": WEEK_DAYS,
        "heat_weeks": HEAT_WEEKS,
        "info": EFFORT_INFO,
    }


# ═══════════════════════════════════════════════════════════════════════
# WHETHER IT IS GOING IN
# ═══════════════════════════════════════════════════════════════════════

ACCURACY_INFO = (
    "The share of questions answered correctly in chapter tests over the "
    "last 4 weeks, next to the same figure for the 4 weeks before it. "
    "Recent rather than all-time, so it moves when things change -- an "
    "all-time average barely shifts even when a student improves "
    "sharply. At least 8 questions must have been answered in the window "
    "before we will state a number at all.")

HOLDING_INFO = (
    "When a question is answered wrongly, the app brings the same idea "
    "back later, worded differently, to check whether it was actually "
    "learned or just remembered for that test. This counts how many of "
    "those re-checks came back right. It is normal for this to be low "
    "early on, and it usually rises as chapters are revisited. It is not "
    "a score anyone is graded on.")


def _understanding(r, tests):
    rc, pr = tests["recent"], tests["prior"]
    seen = _i(r.get("questions_seen"))
    correct = _i(r.get("questions_correct"))

    rc_ready = _ready(rc["total"], MIN_Q_RECENT)
    pr_ready = _ready(pr["total"], MIN_Q_RECENT)
    rc_val = _pct(rc["correct"], rc["total"]) if rc_ready else None
    pr_val = _pct(pr["correct"], pr["total"]) if pr_ready else None

    ret = _dict(r.get("retention"))
    audits = _i(ret.get("audits_total"))
    hold_ready = _ready(audits, MIN_AUDITS)

    return {
        "accuracy": {
            "value": rc_val,
            "asked": rc["total"],
            "right": rc["correct"],
            "ready": rc_ready,
            "floor": MIN_Q_RECENT,
            "window_days": RECENT_DAYS,
            "prior": pr_val,
            "prior_asked": pr["total"],
            "delta": (round(rc_val - pr_val, 1)
                      if rc_val is not None and pr_val is not None else None),
            # Kept, quietly. It answers "over the whole time" without
            # pretending to describe how things are going now.
            "lifetime": _pct(correct, seen) if _ready(seen, MIN_Q_RECENT) else None,
            "lifetime_asked": seen,
            "info": ACCURACY_INFO,
        },
        "holding": {
            "value": ret.get("retention_pct") if hold_ready else None,
            "checked": audits,
            "kept": _i(ret.get("audits_confirmed")),
            "lost": _i(ret.get("audits_failed")),
            "ready": hold_ready,
            "floor": MIN_AUDITS,
            "info": HOLDING_INFO,
        },
    }


# ═══════════════════════════════════════════════════════════════════════
# READING AND TESTING, PER SUBJECT
# ═══════════════════════════════════════════════════════════════════════

SUBJECTS_INFO = (
    "Two separate things, kept apart on purpose. Reading is Concept "
    "Studio: how many chapters of the subject have been opened and read. "
    "Testing is chapter tests: how many of those chapters have been "
    "tested on, and the share of questions answered correctly in them. A "
    "chapter is usually read well before it is tested, and reading alone "
    "rarely sticks -- so the gap between the two bars is the useful "
    "part. Each year is listed separately because NEET examines both "
    "class 11 and class 12, and a chapter revised from the earlier year "
    "is real work that belongs on its own row rather than hidden inside "
    "this year's total. A subject shows no testing bar until its "
    "question bank is ready, which is about our content, not about the "
    "student.")


def _year_label(lvl):
    return f"Class {lvl}" if lvl else "Other chapters"


def _year_sort_key(lvl, own):
    """The student's own year first, then the rest, newest first.

    Their own year is what school is teaching them right now, so it is
    what they will look for. The other year is not an afterthought
    though -- NEET examines both, and class-11 revision done by a
    class-12 student is real work that the first version counted
    towards nothing and rendered nowhere.
    """
    if own and lvl == own:
        return (0, 0)
    try:
        return (1, -int(lvl))
    except (TypeError, ValueError):
        return (2, 0)


def _subjects(r, meta, syllabus, read_counts):
    level = _s(r.get("class_level", ""), 8).strip()
    per_sub = _dict(r.get("per_subject"))
    per_ch = _dict(r.get("per_chapter"))

    # Chapters that have a question bank, per subject AND year. No
    # filtering by the student's year here: both years get their own
    # row, so both need their own counts.
    avail, tested = {}, {}
    for cid, m in _dict(meta).items():
        m = _dict(m)
        sub = canon_subject(m.get("subject", ""))
        if sub == "Unassigned":
            continue
        key = (sub, _s(m.get("class", ""), 8).strip())
        avail[key] = avail.get(key, 0) + 1
        if _i(_dict(per_ch.get(cid)).get("tests")) > 0:
            tested[key] = tested.get(key, 0) + 1

    out = []
    for sub in SUBJECT_ORDER:
        # Every year that exists for this subject anywhere -- syllabus,
        # question bank, or reading the student has actually done. A year
        # they have read in must appear even if no syllabus doc parsed,
        # or their work vanishes.
        years = {l for (s2, l) in syllabus if s2 == sub}
        years |= {l for (s2, l) in avail if s2 == sub}
        years |= {l for (s2, l) in read_counts if s2 == sub}

        rows = []
        for lvl in sorted(years, key=lambda l: _year_sort_key(l, level)):
            r_total = _i(syllabus.get((sub, lvl)))
            r_open = _i(read_counts.get((sub, lvl)))
            r_open = min(r_open, r_total) if r_total else r_open
            a = _i(avail.get((sub, lvl)))
            t = _i(tested.get((sub, lvl)))
            if not (r_total or r_open or a):
                continue
            rows.append({
                "class_level": lvl,
                "label": _year_label(lvl),
                "is_own_year": bool(level) and lvl == level,
                "reading": {
                    "opened": r_open,
                    "total": r_total,
                    "pct": (round(r_open / r_total * 100, 1)
                            if r_total else None),
                },
                "testing": {
                    "tested": t,
                    "available": a,
                    "pct": round(t / a * 100, 1) if a else None,
                },
            })

        asked = _i(_dict(per_sub.get(sub)).get("questions"))
        acc_ready = _ready(asked, MIN_Q_SUBJECT)

        out.append({
            "subject": sub,
            "years": rows,
            # Subject-level totals across both years, so the headline and
            # any caller that wants one number still has one -- without
            # the per-year rows having to be re-added by the caller.
            "reading": {
                "opened": sum(x["reading"]["opened"] for x in rows),
                "total": sum(x["reading"]["total"] for x in rows),
            },
            "testing": {
                "tested": sum(x["testing"]["tested"] for x in rows),
                "available": sum(x["testing"]["available"] for x in rows),
                "accuracy": (_dict(per_sub.get(sub)).get("accuracy")
                             if acc_ready else None),
                "asked": asked,
                "ready": acc_ready,
                "floor": MIN_Q_SUBJECT,
            },
        })
    return out


# ═══════════════════════════════════════════════════════════════════════
# WHAT NEEDS YOU
#
# Same flag engine as the teacher portal, so a parent and a class teacher
# are never told two different stories about the same child.
#
# Two things differ. A parent gets a `do` line, because an alert with no
# next step is a worry rather than help. And ONLY THE FIRST gets one:
# five imperatives handed to a parent become five pressures handed to the
# child, which is the opposite of the point.
# ═══════════════════════════════════════════════════════════════════════

_ALERT_COPY = {
    "never_started": (
        "Hasn't started yet",
        "No tests taken so far.",
        "One short chapter is the easiest way in. Asking which subject "
        "feels least frightening tends to open better than asking why "
        "nothing has been done."),
    "inactive": (
        "Quiet for a while",
        "No study activity in the last week.",
        "Worth finding out what got in the way before assuming it was "
        "avoidance. A forgotten password does this too."),
    "low_scores": (
        "Recent scores are low",
        "The last few test scores have come in low.",
        "Going back over the chapter tends to help more than taking "
        "another test on it."),
    "forgetting": (
        "Answers slipping away",
        "Questions answered right are being missed when the same idea "
        "comes back later.",
        "One way to check this is to ask for the idea explained in their "
        "own words. If that is hard, it was remembered rather than "
        "understood."),
    "failed_retakes": (
        "Same questions again",
        "A few questions were missed a second time on the retake.",
        "These are usually worth sitting with once. Twice wrong tends to "
        "mean a wrong idea rather than carelessness."),
    "tested_blind": (
        "Testing before reading",
        "Tests are being taken before the chapter has been read.",
        "The score will look worse than the effort deserves. Reading "
        "first turns the same hour into a much better one."),
    "read_not_tested": (
        "Reading without testing",
        "Chapters are being read but not tested on.",
        "Reading feels like progress and rarely is on its own. One test "
        "would show whether it landed."),
    "rushing": (
        "Going very fast",
        "Questions are being answered much faster than classmates.",
        "This usually means the question is not being read fully. "
        "Watching one test together shows it quickly."),
    "arena_low": (
        "Full paper score is low",
        "The most recent full NEET paper came in low.",
        "Which subject cost the most marks says more than the total -- "
        "the total is three different problems added together."),
    "streak_broken": (
        "A study run just ended",
        "A long run of daily study has stopped.",
        "Restarting is much harder after a fortnight than after a day, "
        "so this is a good moment for a light nudge."),
}

ALERTS_INFO = (
    "These come from the same checks the school's teachers see, so you "
    "and the class teacher are never told different things about the "
    "same week. Each one needs a minimum amount of activity before it "
    "can appear, so a student who has only just started is never flagged "
    "for being new. Only the first carries a suggestion, on purpose -- a "
    "list of instructions passed on at home becomes pressure rather than "
    "help.")


def _needs_you(r):
    items = []
    for f in _seq(r.get("alert_flags")):
        copy = _ALERT_COPY.get(f)
        if not copy:
            continue
        title, body, do = copy
        items.append({"flag": f, "title": title, "body": body, "do": do})

    visible = [dict(x) for x in items[:MAX_ALERTS_SHOWN]]
    for i, it in enumerate(visible):
        if i > 0:
            it["do"] = ""
    return {
        "visible": visible,
        "hidden": [{"flag": x["flag"], "title": x["title"], "body": x["body"]}
                   for x in items[MAX_ALERTS_SHOWN:]],
        "total": len(items),
        "info": ALERTS_INFO,
    }


# ═══════════════════════════════════════════════════════════════════════
# WORTH ASKING ABOUT
#
# Deduped by chapter. The first version produced two cards carrying an
# identical sentence about the same chapter, under a subtitle claiming
# "not a template" -- which made the page visibly dishonest about itself.
# ═══════════════════════════════════════════════════════════════════════

TALK_INFO = (
    "Written from this student's own answers -- which idea came back "
    "wrong, and in which chapter -- rather than from a list of general "
    "study tips. There are never more than two, they are never about the "
    "same chapter twice, and they are suggestions rather than "
    "instructions.")


def _lost_ideas(r, meta, limit=MAX_LOST):
    ret = _dict(r.get("retention"))
    per_con = _dict(r.get("per_concept"))
    out, seen_ch = [], set()
    for fr in _seq(ret.get("false_recoveries")):
        if len(out) >= limit:
            break
        fr = _dict(fr)
        chid = _s(fr.get("chapter_id", ""), 200)
        if chid in seen_ch:
            continue
        seen_ch.add(chid)
        con = _dict(per_con.get(_s(fr.get("concept_id", ""), 200)))
        out.append({
            "concept": _s(con.get("n", ""), 160) or "an idea in this chapter",
            "chapter": _chapter_name(chid, meta),
            "subject": _subject_of(chid, meta),
        })
    return out


def _weak_ideas(r, meta, limit=MAX_TALK):
    per_con = _dict(r.get("per_concept"))
    scored = []
    for cid, c in per_con.items():
        c = _dict(c)
        asked = _i(c.get("s"))
        if asked < MIN_CONCEPT_Q:
            continue
        chid = _s(c.get("c", ""), 200)
        scored.append({
            "concept": _s(c.get("n", ""), 160) or _s(cid, 160),
            "chapter": _chapter_name(chid, meta),
            "subject": _subject_of(chid, meta),
            "pct": round(_f(c.get("m")), 1),
            "asked": asked,
        })
    scored.sort(key=lambda x: (x["pct"], -x["asked"]))
    out, seen_ch = [], set()
    for w in scored:
        if w["chapter"] in seen_ch:
            continue
        seen_ch.add(w["chapter"])
        out.append(w)
        if len(out) >= limit:
            break
    return out


def _talk_about(r, meta, name, u):
    who = _first_name(name)
    out, used = [], set()

    for l in _lost_ideas(r, meta, limit=MAX_TALK):
        if l["chapter"] in used:
            continue
        used.add(l["chapter"])
        out.append({
            "kind": "lost",
            "title": l["concept"],
            "chapter": l["chapter"],
            "subject": l["subject"],
            "body": (f"{who} answered this correctly once, then missed a "
                     f"differently-worded version of the same idea later. "
                     f"It is in {l['chapter']}. Hearing it explained in "
                     f"their own words is the quickest way to tell whether "
                     f"it has settled."),
        })
        if len(out) >= MAX_TALK:
            break

    if len(out) < MAX_TALK:
        for w in _weak_ideas(r, meta, limit=MAX_TALK):
            if w["chapter"] in used:
                continue
            used.add(w["chapter"])
            out.append({
                "kind": "weak",
                "title": w["concept"],
                "chapter": w["chapter"],
                "subject": w["subject"],
                "body": (f"Asked {_plural(w['asked'], 'time')} in "
                         f"{w['chapter']}, and about {round(w['pct'])}% of "
                         f"those came back right. This one is probably "
                         f"worth a teacher rather than another test."),
            })
            if len(out) >= MAX_TALK:
                break

    if not out:
        acc = _dict(u.get("accuracy"))
        if not acc.get("ready"):
            out.append({
                "kind": "early",
                "title": "Too early to say much",
                "chapter": "",
                "subject": "",
                "body": (f"{who} has answered "
                         f"{_plural(acc.get('asked'), 'question')} in the "
                         f"last 4 weeks. We would rather tell you nothing "
                         f"than guess from that. A few more chapters and "
                         f"this page becomes much more useful."),
            })
    return {"items": out[:MAX_TALK], "info": TALK_INFO}


# ═══════════════════════════════════════════════════════════════════════
# THE HEADLINE
# ═══════════════════════════════════════════════════════════════════════

def _headline(r, name, effort, u, subjects, alert_total):
    who = _first_name(name)
    quiet = _days_since(r.get("last_active_at", ""))
    tests = _i(r.get("tests_completed"))
    read_any = any(_i(_dict(s.get("reading")).get("opened")) for s in subjects)

    if not tests and not effort["days_this_week"] and not read_any:
        return {"tone": "new",
                "sentence": f"{who} hasn't started on NAADI yet."}

    if quiet is not None and quiet >= 7:
        return {"tone": "quiet",
                "sentence": (f"{who} hasn't opened the app in "
                             f"{_plural(quiet, 'day')}.")}

    d, dl = effort["days_this_week"], effort["days_last_week"]
    if d == 0:
        c1 = f"{who} hasn't studied in the last 7 days"
    elif dl and d > dl:
        c1 = f"{who} studied on {_plural(d, 'day')} of the last 7, up from {dl}"
    elif dl and d < dl:
        c1 = f"{who} studied on {_plural(d, 'day')} of the last 7, down from {dl}"
    else:
        c1 = f"{who} studied on {_plural(d, 'day')} of the last 7"

    acc = _dict(u.get("accuracy"))
    c2 = ""
    ready = [s for s in subjects
             if _dict(s.get("testing")).get("ready")
             and _dict(s.get("testing")).get("accuracy") is not None]
    if len(ready) >= 2:
        best = max(ready, key=lambda s: s["testing"]["accuracy"])
        worst = min(ready, key=lambda s: s["testing"]["accuracy"])
        if best["subject"] != worst["subject"] and \
                best["testing"]["accuracy"] - worst["testing"]["accuracy"] >= 12:
            c2 = (f"{best['subject']} is the strongest subject and "
                  f"{worst['subject']} is where the marks are going")
    if not c2 and acc.get("ready"):
        v = round(_f(acc.get("value")))
        dlt = acc.get("delta")
        if dlt is not None and abs(dlt) >= 3:
            c2 = (f"{v}% of questions are coming back right, "
                  f"{'up' if dlt > 0 else 'down'} from "
                  f"{round(_f(acc.get('prior')))}% the month before")
        else:
            c2 = f"{v}% of questions are coming back right"
    if not c2:
        c2 = "there isn't enough answered yet to say how it's going"

    tone = "watch" if alert_total else ("good" if d >= 3 else "steady")
    return {"tone": tone, "sentence": f"{c1}, and {c2}."}


# ═══════════════════════════════════════════════════════════════════════
# THE LAST 7 DAYS
# ═══════════════════════════════════════════════════════════════════════

WEEK_INFO = (
    "Everything from the last 7 days in one list: chapter tests, full "
    "NEET papers, custom tests, and chapters read in Concept Studio. "
    "Newest first. A chapter test shows how many questions came back "
    "right; a paper shows marks; reading shows how far through the "
    "chapter's notes they are.")


def _week_rows(tests, studio, papers):
    rows = list(tests["rows"]) + list(studio["rows"]) + list(papers["rows"])
    rows.sort(key=lambda x: x["at"], reverse=True)
    out = []
    for row in rows[:MAX_WEEK_ROWS]:
        at = _dt(row["at"])
        row = dict(row)
        row["day"] = at.strftime("%A") if at else ""
        if row["kind"] == "test":
            row["detail"] = (f"{row['right']} of {row['asked']} right"
                             if row.get("asked") else "test taken")
        elif row["kind"] in ("paper", "custom"):
            row["detail"] = (f"{row['marks']} of {row['max']} marks"
                             if row.get("marks") is not None and row.get("max")
                             else "completed")
        else:
            row["detail"] = f"{round(_f(row.get('pct')))}% of the notes read"
        out.append(row)
    return out


# ═══════════════════════════════════════════════════════════════════════
# SCHOOL NAME
# ═══════════════════════════════════════════════════════════════════════

def _school_name(r):
    """The school's NAME, not its code. A parent does not know what
    NAADI-CHN-014 is, and it was rendering in the header."""
    key = _s(r.get("class_key", ""), 120)
    if key:
        try:
            doc = _db().collection("classes").document(key).get()
            if doc.exists:
                nm = _s((doc.to_dict() or {}).get("school_name", ""), 120)
                if nm:
                    return nm
        except Exception as e:
            print(f"[parent_home] class read failed: {e}")
    return ""


# ═══════════════════════════════════════════════════════════════════════
# THE ENDPOINT
# ═══════════════════════════════════════════════════════════════════════

@parent_home_bp.route("/api/parent/v2/child/<student_uid>/home",
                      methods=["GET"])
@require_auth
@require_role("parent")
@resolve_child
def parent_home_v2(student_uid):
    """One rollup read, three collection scans, one cached syllabus."""
    r = _rollup(student_uid) or {}
    meta = chapter_meta() or {}
    syllabus = studio_syllabus()

    tests = _scan_tests(student_uid, meta)
    studio = _scan_studio(student_uid)
    papers = _scan_papers(student_uid)
    grid = _study_day_grid(student_uid, weeks=HEAT_WEEKS)

    effort = _effort(r, tests, studio, grid)
    u = _understanding(r, tests)
    subjects = _subjects(r, meta, syllabus, studio["opened"])
    alerts = _needs_you(r)
    name = r.get("name", "Student")

    u["lost"] = _lost_ideas(r, meta)

    return jsonify({
        "child": {
            "uid": student_uid,
            "name": name,
            "first_name": _first_name(name),
            "initials": r.get("initials", "?"),
            "photo_url": r.get("photo_url", ""),
            "class_level": r.get("class_level", ""),
            "class_id": r.get("class_id", ""),
            "school_name": _school_name(r),
        },
        "last_seen": {
            "days": _days_since(r.get("last_active_at", "")),
            "at": r.get("last_active_at", ""),
        },
        "headline": _headline(r, name, effort, u, subjects, alerts["total"]),
        "needs_you": alerts,
        "papers": {**papers["papers"], "customs": papers["customs"],
                   "info": PAPERS_INFO},
        "effort": effort,
        "understanding": u,
        "subjects": {"items": subjects, "info": SUBJECTS_INFO},
        "week": {"items": _week_rows(tests, studio, papers), "info": WEEK_INFO},
        "talk_about": _talk_about(r, meta, name, u),
        "gates": {
            "recent_questions": MIN_Q_RECENT,
            "audits": MIN_AUDITS,
            "concept_questions": MIN_CONCEPT_Q,
        },
    })


@parent_home_bp.route("/api/parent/v2/children", methods=["GET"])
@require_auth
@require_role("parent")
def parent_children_v2():
    """The multi-child deck, without the Doctor ladder.

    A single-child parent never calls this: the header carries the same
    facts, and the deck card was a verbatim repeat of the page below it.
    """
    children = _seq((getattr(request, "user_doc", None) or {}).get("children"))
    cards = []
    for cuid in children:
        child = _user(cuid)
        if not child:
            continue
        if child.get("parent_consent", True) is False:
            cards.append({
                "uid": cuid,
                "name": child.get("name", "Student"),
                "initials": "".join(
                    w[0] for w in (child.get("name") or "S").split()[:2]).upper(),
                "consent_revoked": True,
            })
            continue

        r = _rollup(cuid)
        if not r:
            continue

        seen = _i(r.get("questions_seen"))
        cards.append({
            "uid": cuid,
            "name": r.get("name", "Student"),
            "initials": r.get("initials", "?"),
            "photo_url": r.get("photo_url", ""),
            "class_id": r.get("class_id", ""),
            "class_level": r.get("class_level", ""),
            "last_active_days": _days_since(r.get("last_active_at", "")),
            "streak_current": _i(r.get("streak_current")),
            # Lifetime here, deliberately: the deck is a glance, and a
            # per-child 4-week scan would be one full test_sessions read
            # per sibling on every page load.
            "accuracy": (_pct(_i(r.get("questions_correct")), seen)
                         if _ready(seen, MIN_Q_RECENT) else None),
            "questions_asked": seen,
            "has_alert": bool(_seq(r.get("alert_flags"))),
            "alert_reason": _s(r.get("alert_reason", ""), 200),
        })
    return jsonify({"children": cards, "total": len(cards)})


# ═══════════════════════════════════════════════════════════════════════
# REGISTRATION
# ═══════════════════════════════════════════════════════════════════════

def register_parent_home_routes(app):
    """Mount this blueprint, refusing to start if a route could collide."""
    app.register_blueprint(parent_home_bp)

    bad = []
    for rule in app.url_map.iter_rules():
        s = str(rule)
        if not rule.endpoint.startswith("parent_home."):
            continue
        if not s.startswith("/api/parent/v2/"):
            bad.append(s)
    if bad:
        raise RuntimeError(
            "parent_home.py routes must sit under /api/parent/v2/ or they "
            "will silently collide with portal_backend.py. Offending: "
            + ", ".join(sorted(set(bad))))
    return app