"""
NAADI AI — TEACHER PORTAL · STUDENTS TAB, PAGE 2  (teacher_student.py)
═══════════════════════════════════════════════════════════════════════════

ONE STUDENT, IN DEPTH.

The roster answers "who do I need to find today". This page answers the
only question that follows: "and what do I say to them."

Everything here is built to survive being read in about ninety seconds by
someone standing in a corridor. If a block does not change what the
teacher says next, it is not on the page.

───────────────────────────────────────────────────────────────────────────
WHAT THE OLD DRILL-DOWN GOT WRONG, AND WHY EACH IS FIXED HERE

1 · STRONGEST AND WEAKEST OVERLAPPED
    teacher_backend.py:1259 took the first 6 of a list sorted ascending
    and the first 6 of the same list sorted descending, with no check
    that the two were disjoint. Fewer than 12 scoreable concepts and the
    same concept appeared in both lists. On the live pilot the ranges
    were "weakest 53% up to 79%" and "strongest 82% down to 66%" — which
    is only possible if they share members.

    Strongest is DELETED, not repaired. A teacher with ninety seconds is
    not looking for good news. What replaces it is the fact the overlap
    was hiding: of 53 concepts touched, only about 11 had been asked
    enough times to judge at all.

2 · "RETENTION 37% · 19 CHECKS"
    Invented vocabulary twice over. The idea is real and valuable — the
    v1→v2→v3 ladder catches a student who passed the retry by recall and
    then lost it — but it reaches the teacher as a sentence, from
    teacher_signals, or not at all.

3 · RAW MARKUP IN QUESTION STEMS
    Question text genuinely contains `<sub>`, `<sup>` and entities:
    (CH<sub>3</sub>)<sub>2</sub>CHCH… A plain escape prints the tags.
    Every question string in this payload is flagged `html: true` so the
    client routes it through tstQ() rather than esc(). Names and chapter
    titles are NOT flagged and stay on esc().

4 · THE SCORE CHART MIXED INCOMPARABLE SCALES
    Chapter tests are a percentage of ten to twenty questions. A full
    NEET paper is a percentage of 720 and lands at 10–20% for a strong
    student. Concatenating them into one line means a student who starts
    attempting mocks appears to collapse. The two series are returned
    separately and are never drawn on one axis.

5 · /tests WAS UNBOUNDED
    No .limit() on either stream, and every test_sessions document
    carries its full questions[] array. Fine for a pilot with two
    students; at eighty-three chapters it is three hundred documents with
    embedded arrays on every open. Bounded here, like teacher_class.py
    already bounds its own scans.

6 · THREE FIELDS THAT WERE ALWAYS EMPTY
    teacher_interventions() read `reason`, `diagnosis` and `created_at`
    off pending_interventions entries. backend.py's intervention_data
    never sets any of them, so the date sort was a no-op and the
    diagnosis never rendered. Meanwhile every entry DOES carry
    original_student_answer, original_correct_answer and
    all_options_explanation — the per-student wrong-answer story, fetched
    and thrown away.

7 · THE AI DIAGNOSIS WAS NEVER SHOWN TO ANYONE
    ai_interventions holds {misconception, explanation, memory_trick}
    written by Gemini per student per concept. Nothing read it. It is
    the single most useful thing in the database for this page.

    CAUTION, and the reason for _usable_diagnosis(): on a model failure
    backend.py persists misconception="Unable to diagnose automatically".
    Rendered naively, a teacher reads that as the diagnosis.

───────────────────────────────────────────────────────────────────────────
ROUTES — all under /v2/, all guarded at import time

    /v2/overview        the page. One rollup read.
    /v2/tests           bounded, split by kind, never one series.
    /v2/misconceptions  lazy. The expensive one; only fetched on tap.
"""

import time
from collections import Counter, defaultdict

from flask import Blueprint, jsonify, request

from portal_backend import (
    _db, chapter_meta, require_auth, require_role, _days_since, _iso,
)
from teacher_backend import (
    _acc, resolve_student, _teacher_pairs, MIN_SAMPLE,
)
from teacher_home import class_role_for
from teacher_signals import flags_for, canon_subject

student_bp = Blueprint("teacher_student_v2", __name__)

# A concept is not judged on fewer than this many questions. Same floor
# as everywhere else, imported rather than redeclared.
MIN_CONCEPT_Q = MIN_SAMPLE

# Hard ceilings. Every one of these exists because the unbounded version
# was fine at two students and would not have been at fifty.
MAX_SESSIONS = 120          # test_sessions scanned for the answer pattern
MAX_TESTS_RETURNED = 40     # per kind
MAX_LOST = 8
MAX_WEAK = 8
MAX_CHAPTERS_PER_SUBJECT = 12

# A distractor is only "the one they keep choosing" if they chose it
# repeatedly. Twice is a coincidence.
MIN_DISTRACTOR_HITS = 3

# Gemini's failure string, persisted by backend.py. Never shown.
DEAD_DIAGNOSIS = "unable to diagnose"


def _text(v, _depth=0):
    """Coerce anything the question bank might hold into a string.

    Mirrors optExplText() in test-engine.js, which exists because these
    fields are genuinely polymorphic: an each_option_explanation value
    arrives as a plain string on some papers, a list on others, and an
    object keyed explanation / text / reason / detail / why on others
    again. Slicing one of those objects is what returned 500 on every
    Arena paper.

    _depth guards a self-referential structure; three levels is far more
    nesting than any of these fields has ever carried.
    """
    if v is None or v == "":
        return ""
    if isinstance(v, str):
        return v
    if _depth > 2:
        return ""
    if isinstance(v, (list, tuple)):
        return " ".join(x for x in (_text(i, _depth + 1) for i in v) if x)
    if isinstance(v, dict):
        for k in ("explanation", "text", "reason", "detail", "why"):
            if v.get(k):
                return _text(v[k], _depth + 1)
        return ""
    return str(v)


def _s(v, limit=200):
    """A string, from anything. Never raises, never returns None."""
    if v is None:
        return ""
    if isinstance(v, str):
        return v[:limit]
    if isinstance(v, (int, float, bool)):
        return str(v)
    return _text(v)[:limit]


def _i(v, default=0):
    """An int, from anything. A field written as "15" or 15.0 or None all
    mean fifteen, nothing, and fifteen -- and none of them should 500."""
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, (int, float)):
        return int(v)
    if isinstance(v, str):
        try:
            return int(float(v.strip()))
        except (ValueError, TypeError, AttributeError):
            return default
    return default


def _seq(v):
    """A list, from anything. `x or []` returns True when x is True, and
    `for m in True` is a TypeError -- which is how a bool in a
    common_mistakes field took down a whole review screen."""
    if isinstance(v, (list, tuple)):
        return list(v)
    if isinstance(v, dict):
        return list(v.values())
    return []


def _opt_why(each, options):
    """id -> explanation text, whatever shape the field arrived in.

    Three shapes exist in production:

      dict keyed by option id     {"A": "...", "B": {...}}
      list parallel to options    ["why a", "why b", ...]
      list of objects             [{"id": "A", "explanation": "..."}, ...]

    Anything else yields an empty map rather than an exception. An
    explanation is a nice-to-have on a review screen; a 500 is not.
    """
    out = {}
    if not each:
        return out

    if isinstance(each, dict):
        for k, v in each.items():
            t = _text(v)
            if t:
                out[_s(k, 8)] = t
        return out

    if isinstance(each, (list, tuple)):
        ids = [_s(o.get("id", "")) if isinstance(o, dict) else ""
               for o in _seq(options)]
        for i, v in enumerate(each):
            # A list of objects carries its own id; a bare list is
            # positional against the options array.
            key = ""
            if isinstance(v, dict):
                key = _s(v.get("id") or v.get("option") or v.get("key") or "", 8)
            if not key:
                key = ids[i] if i < len(ids) and ids[i] else chr(65 + i)
            t = _text(v)
            if t:
                out[key] = t
        return out

    return out


def _option_rows(options, each):
    """Normalise the options array itself, then attach explanations.

    Options are usually [{"id": "A", "text": "..."}] but a few documents
    hold bare strings. Positional letters are assigned in that case,
    which is what the student's renderer effectively shows anyway.
    """
    whys = _opt_why(each, options)
    rows = []
    for i, o in enumerate(_seq(options)):
        if isinstance(o, dict):
            oid = _s(o.get("id") or o.get("option") or chr(65 + i), 8)
            txt = o.get("text", "")
        else:
            oid, txt = chr(65 + i), o
        rows.append({"id": oid, "text": _q(txt),
                     "why": _q(whys.get(oid, ""))})
    return rows


def _q(text):
    """Mark a string as question text.

    The client renders anything flagged this way through tstuQ(), which
    converts entities and re-permits <sub>/<sup>/<b>/<i> and nothing
    else. Names and titles are never flagged and stay on esc().

    Coerces first. EVERY question string in this payload passes through
    here, which makes it the one place worth being defensive: a review
    screen showing an empty explanation is a small loss, one returning
    500 is a dead feature.
    """
    return {"t": _text(text)[:400], "html": True}


# ═══════════════════════════════════════════════════════════════════════
# THE TWO NUMBERS — identical arithmetic to the roster and the Class tab
# ═══════════════════════════════════════════════════════════════════════

def _scope_ids(meta, r, subjects=None):
    """Chapters this student is measured against.

    TWO filters, and both matter.

    THE STUDENT'S YEAR. A class-11 student measured against the class-12
    syllabus reads as hopelessly behind, which is a statement about the
    denominator and not about them.

    THE TEACHER'S SUBJECTS. Page 1 has scoped by role since it shipped;
    this page did not, so a Biology teacher's roster said 43% and the
    student page she opened from it said 67% across all three subjects.
    Same student, two numbers, and no way to tell which was hers.
    """
    lvl = _s(r.get("class_level", "")).strip()
    want = {canon_subject(x) for x in (subjects or [])}
    out = set()
    for cid, m in (meta or {}).items():
        if lvl and _s(m.get("class", "")).strip() not in ("", lvl):
            continue
        if want and canon_subject(m.get("subject")) not in want:
            continue
        out.add(cid)
    return out


def _subject_of(cid, meta):
    """The subject a chapter id belongs to, from EITHER syllabus.

    Concept Studio and OPD have separate chapter collections with
    different id schemes (the project's gotcha 6). chapter_metadata ids
    resolve through meta; Studio ids look like
    Biology_11_ANATOMY_OF_FLOWERING_PLANTS and resolve through their own
    prefix. Filtering Studio ids against a set built from meta removes
    every one of them, which is why the reading block showed a Chemistry
    teacher a list of Biology chapters and no way to tell why.
    """
    m = (meta or {}).get(cid)
    if isinstance(m, dict) and m.get("subject"):
        return canon_subject(m.get("subject"))
    head = _s(cid, 40).split("_")[0] if cid else ""
    return canon_subject(head)


def _pretty_chapter(cid, meta):
    """A chapter's title, or a readable version of a Studio id.

    A Studio id printed raw reads
    "Biology_11_ANATOMY_OF_FLOWERING_PLANTS", which is a database key on
    a teacher's screen. There is no title for it in chapter_metadata, so
    the id is unpacked rather than shown as-is.
    """
    m = (meta or {}).get(cid)
    if isinstance(m, dict) and m.get("chapter_title"):
        return _s(m["chapter_title"], 120)
    raw = _s(cid, 160)
    parts = raw.split("_")
    # Drop a leading Subject_Class_ prefix when it is there.
    if len(parts) > 2 and parts[1].isdigit():
        parts = parts[2:]
    return " ".join(w.capitalize() for w in parts if w) or raw


def _role_of(class_key_or_none, r):
    """The viewing teacher's role for this student's class.

    Returns (role, subjects). A subject teacher sees her subjects; a
    class teacher sees everything; anyone whose role cannot be resolved
    is treated as a class teacher, because failing OPEN on scope while
    the routes still enforce access is better than a blank page.
    """
    u = getattr(request, "user_doc", None) or {}
    key = _s(r.get("class_key", "")) or _s(class_key_or_none)
    if not key:
        return "class_teacher", []
    try:
        cr = class_role_for(u, key)
    except Exception as e:
        print(f"[student] role lookup failed for {key}: {e}")
        return "class_teacher", []
    if cr.get("role") == "subject_teacher":
        return "subject_teacher", [canon_subject(x) for x in (cr.get("subjects") or [])]
    return cr.get("role") or "class_teacher", []


def _visible_flags(flags, role, subjects):
    """A subject teacher sees flags she can act on, plus the ones that
    are not about a subject at all.

    "Hasn't opened the app in 14 days" belongs to every teacher who
    knows the student. "Scored under 40% in the last 4 Chemistry tests"
    belongs to whoever teaches Chemistry, and putting it in a Biology
    teacher's list asks her to fix something that is not hers.
    """
    if role != "subject_teacher" or not subjects:
        return flags
    want = set(subjects)
    return [f for f in flags
            if not f.get("subject") or canon_subject(f["subject"]) in want]


def _other_subjects(meta, r, mine):
    """A one-line footnote about the subjects that are not this
    teacher's.

    Shown, not hidden. A Biology teacher who cannot see that the student
    is failing Chemistry cannot mention it to the class teacher, and
    silence there is a worse failure than a number she cannot act on.
    Deliberately coarse -- a count of chapters started and whether any
    testing is happening, no score.
    """
    if not mine:
        return []
    lvl = _s(r.get("class_level", "")).strip()
    want = set(mine)
    per_ch = r.get("per_chapter") if isinstance(r.get("per_chapter"), dict) else {}
    buckets = {}
    for cid, m in (meta or {}).items():
        sub = canon_subject(m.get("subject"))
        if sub in want:
            continue
        if lvl and _s(m.get("class", "")).strip() not in ("", lvl):
            continue
        b = buckets.setdefault(sub, {"total": 0, "started": 0, "tests": 0})
        b["total"] += 1
        pc = per_ch.get(cid)
        if isinstance(pc, dict):
            b["started"] += 1
            b["tests"] += _i(pc.get("tests"))
    return [{"subject": k, "chapters_total": v["total"],
             "chapters_started": v["started"], "tests": v["tests"]}
            for k, v in sorted(buckets.items())]


def getting_right(r, ids=None):
    """Correct / seen, weighted by questions. Gated. None is an answer."""
    seen, correct = 0, 0.0
    for c in (r.get("per_concept") or {}).values():
        if ids and c.get("c") and c["c"] not in ids:
            continue
        s = int(c.get("s", 0) or 0)
        if not s:
            continue
        seen += s
        correct += (c.get("m", 0) or 0) / 100.0 * s
    return _acc(correct, seen), seen


def how_far_through(r, ids):
    """Mean per_chapter.coverage_pct over chapters in scope, untouched = 0.

    The same arithmetic as teacher_class.py and teacher_students.py. Three
    screens showing three different numbers for one student is how a
    teacher learns to trust none of them.
    """
    per_ch = r.get("per_chapter") or {}
    if not ids:
        return None, 0, 0
    covs = [float((per_ch.get(c) or {}).get("coverage_pct", 0) or 0) for c in ids]
    started = sum(1 for c in ids if per_ch.get(c))
    return round(sum(covs) / len(covs), 1), started, len(ids)


# ═══════════════════════════════════════════════════════════════════════
# WHAT THEY HAVE LOST
# ═══════════════════════════════════════════════════════════════════════

def things_lost(r, meta, ids=None, mine=None):
    """Answered it right on the retry, then failed a differently-worded
    version of the same idea a few tests later.

    Nothing else in this market can see this state, and it is the whole
    argument for the v1→v2→v3 ladder. The old page printed five full
    question stems with raw <sub> tags. A teacher cannot act on a wall of
    stems; she can act on "Loop of Henle, in Human Physiology". So the
    IDEA is named first and the stem is secondary.
    """
    ret = r.get("retention") if isinstance(r.get("retention"), dict) else {}
    per_con = r.get("per_concept") or {}
    out = []
    want = set(mine or [])
    for fr in [x for x in _seq(ret.get("false_recoveries"))
               if isinstance(x, dict)]:
        if len(out) >= MAX_LOST:
            break
        cid = _s(fr.get("concept_id", ""), 200)
        chid = _s(fr.get("chapter_id", ""), 200)
        # A Chemistry teacher cannot act on a Biology idea the student
        # lost, and it was appearing in her list unfiltered.
        if want and _subject_of(chid, meta) not in want:
            continue
        con = per_con.get(cid) or {}
        out.append({
            "concept": con.get("n", "") or "an idea in this chapter",
            "chapter": _pretty_chapter(chid, meta),
            "subject": _subject_of(chid, meta),
            "question": _q(fr.get("question_text", "")),
            "base_id": fr.get("base_question_id", ""),
        })
    return {
        "items": out,
        "count": int(ret.get("audits_failed", 0) or 0),
        "checked": int(ret.get("audits_total", 0) or 0),
    }


# ═══════════════════════════════════════════════════════════════════════
# WHERE THEY ARE WEAKEST
# ═══════════════════════════════════════════════════════════════════════

def weakest(r, meta, ids=None, mine=None):
    """One list. Never two that share members.

    Also reports how many concepts are judgeable at all, which is the
    fact the old overlapping pair was accidentally hiding: a student can
    have "touched" 53 concepts and have been asked enough about 11.
    """
    per_con = r.get("per_concept") if isinstance(r.get("per_concept"), dict) else {}
    want = set(mine or [])
    scored, touched = [], 0
    for cid, c in per_con.items():
        if not isinstance(c, dict):
            continue
        s = _i(c.get("s"))
        if not s:
            continue
        chid = _s(c.get("c", ""), 200)
        # THE BUG. This list was never scoped, so a Chemistry teacher
        # read "Kingdom Protista — Biological Classification" as one of
        # her weak spots.
        if want and _subject_of(chid, meta) not in want:
            continue
        touched += 1
        if s < MIN_CONCEPT_Q:
            continue
        scored.append({
            "concept": _s(c.get("n", ""), 160) or cid,
            "chapter": _pretty_chapter(chid, meta),
            "subject": _subject_of(chid, meta),
            "pct": _pct(c.get("m")) or 0.0,
            "asked": s,
            "chapter_id": chid,
        })

    scored.sort(key=lambda x: (x["pct"], -x["asked"]))
    return {
        "items": scored[:MAX_WEAK],
        "judgeable": len(scored),
        "touched": touched,
        "floor": MIN_CONCEPT_Q,
    }


# ═══════════════════════════════════════════════════════════════════════
# DID THEY READ IT
# ═══════════════════════════════════════════════════════════════════════

def reading(r, ids, meta, mine=None):
    """Counts, not a percentage.

    The old page rendered "Studio read 0% · 4 chapters", which put two
    different denominators on one line: the percentage was against the
    ENTIRE studio syllabus (portal_backend.py:630) while the count was
    chapters started. And completion_percentage only moves when a student
    taps "Mark block done", so a student who reads carefully and never
    taps shows 0%.

    Both problems disappear if the number is a count of chapters rather
    than a percentage of a syllabus nobody agreed on.
    """
    sig = r.get("signals") or {}
    studio = sig.get("studio_by_chapter") or {}
    per_ch = r.get("per_chapter") or {}

    want = set(mine or [])

    def keep(cid):
        # Scoped by SUBJECT, not by membership of `ids`. Studio ids are
        # not in chapter_metadata at all, so an id-set filter would drop
        # every read chapter and report zero reading for everyone.
        return not want or _subject_of(cid, meta) in want

    read_ids = {c for c, v in studio.items()
                if _pct(v) and _pct(v) > 0 and keep(c)}
    tested_ids = {c for c, pc in per_ch.items()
                  if isinstance(pc, dict) and keep(c)
                  and (_i(pc.get("tests")) > 0
                       or _i(pc.get("concepts_attempted")) > 0)}

    both = read_ids & tested_ids
    read_only = read_ids - tested_ids
    tested_only = tested_ids - read_ids

    def names(s):
        # Never a raw database key. A Studio id printed as-is reads
        # "Biology_11_ANATOMY_OF_FLOWERING_PLANTS" on a teacher's screen.
        return [_pretty_chapter(c, meta) for c in sorted(s)][:6]

    return {
        "read": len(read_ids),
        "tested": len(tested_ids),
        "both": len(both),
        "read_not_tested": len(read_only),
        "read_not_tested_names": names(read_only),
        "tested_not_read": len(tested_only),
        "tested_not_read_names": names(tested_only),
        "in_scope": len(ids),
        # Whether we can tell reading from marking at all. See the
        # VISIT-TRACKING patch: without blocks_opened, a chapter only
        # registers as read if the student tapped "Mark block done", so
        # every reading number is a floor and must be worded as one.
        "marks_only": not bool(sig.get("studio_visit_tracking")),
    }


# ═══════════════════════════════════════════════════════════════════════
# BY SUBJECT · CHAPTERS · PACE
# ═══════════════════════════════════════════════════════════════════════

def by_subject(r, ids, meta):
    """Every subject in scope, including the ones never touched.

    A NEET teacher needs to see the Physics-shaped hole. Omitting a
    subject because there is no data makes the hole invisible, which is
    the opposite of what an absence of data means.
    """
    per_ch = r.get("per_chapter") or {}
    per_con = r.get("per_concept") or {}

    buckets = defaultdict(lambda: {"chapters": [], "seen": 0, "correct": 0.0})
    for cid in ids:
        buckets[canon_subject((meta.get(cid) or {}).get("subject"))]["chapters"].append(cid)
    for c in per_con.values():
        chap = meta.get(c.get("c", ""))
        if not chap or c.get("c") not in ids:
            continue
        s = int(c.get("s", 0) or 0)
        if not s:
            continue
        b = buckets[canon_subject(chap.get("subject"))]
        b["seen"] += s
        b["correct"] += (c.get("m", 0) or 0) / 100.0 * s

    out = []
    for sub in sorted(buckets):
        b = buckets[sub]
        chs = b["chapters"]
        covs = [float((per_ch.get(c) or {}).get("coverage_pct", 0) or 0) for c in chs]
        out.append({
            "subject": sub,
            "getting_right": _acc(b["correct"], b["seen"]),
            "questions": b["seen"],
            "how_far_through": round(sum(covs) / len(covs), 1) if covs else None,
            "chapters_started": sum(1 for c in chs if per_ch.get(c)),
            "chapters_total": len(chs),
            "tests": sum(int((per_ch.get(c) or {}).get("tests", 0) or 0) for c in chs),
        })
    return out


def chapters(r, ids, meta):
    """Grouped by subject, weakest first, capped.

    A flat list is readable at four chapters and unreadable at eighty-
    three. Untouched chapters are summarised as a count rather than
    listed — seventy rows of "not started" is not information.
    """
    per_ch = r.get("per_chapter") or {}
    studio = (r.get("signals") or {}).get("studio_by_chapter") or {}

    groups = defaultdict(lambda: {"rows": [], "not_started": 0})
    for cid in ids:
        m = meta.get(cid) or {}
        sub = canon_subject(m.get("subject"))
        pc = per_ch.get(cid)
        read = float(studio.get(cid, 0) or 0) > 0
        if not pc and not read:
            groups[sub]["not_started"] += 1
            continue
        pc = pc or {}
        groups[sub]["rows"].append({
            "chapter_id": cid,
            "chapter": m.get("chapter_title", "") or cid,
            "getting_right": pc.get("accuracy"),
            "how_far_through": float(pc.get("coverage_pct", 0) or 0),
            "tests": int(pc.get("tests", 0) or 0),
            "read": read,
            "state": ("finished" if pc.get("complete") else
                      "testing" if int(pc.get("tests", 0) or 0) else
                      "read_only" if read else "started"),
        })

    out = []
    for sub in sorted(groups):
        g = groups[sub]
        # None sorts last: an unscored chapter is not the weakest one.
        g["rows"].sort(key=lambda x: (x["getting_right"] is None,
                                      x["getting_right"] or 0))
        out.append({
            "subject": sub,
            "rows": g["rows"][:MAX_CHAPTERS_PER_SUBJECT],
            "more": max(0, len(g["rows"]) - MAX_CHAPTERS_PER_SUBJECT),
            "not_started": g["not_started"],
        })
    return out


def pace(r, meta, class_median):
    """Only when it plausibly cost them marks.

    Speed on its own is not a problem — a fast student who scores well is
    a fast student. It is worth a teacher's attention when it is fast AND
    wrong, or slow AND wrong.
    """
    sig = r.get("signals") or {}
    secs = sig.get("pace_seconds_per_q")
    sample = int(sig.get("pace_sample", 0) or 0)
    if not secs or sample < 20 or not class_median:
        return None
    acc, _ = getting_right(r)
    if acc is None or acc >= 55:
        return None
    fast = secs < class_median * 0.6
    slow = secs > class_median * 1.8
    if not (fast or slow):
        return None
    return {
        "seconds": round(secs, 1),
        "class_seconds": round(class_median, 1),
        "getting_right": acc,
        "direction": "fast" if fast else "slow",
    }


# ═══════════════════════════════════════════════════════════════════════
# ROUTE 1 · OVERVIEW
# ═══════════════════════════════════════════════════════════════════════

@student_bp.route("/api/teacher/student/<student_uid>/v2/overview", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_student
def v2_overview(student_uid):
    r = request.student_rollup
    meta = chapter_meta()
    role, mine = _role_of(request.args.get("class_key"), r)
    ids = _scope_ids(meta, r, mine)

    acc, seen = getting_right(r, ids)
    far, started, in_scope = how_far_through(r, ids)

    # class_pace_median needs the whole class and this route has one
    # student, so the pace rule is evaluated against the median the
    # caller passes through from the roster it already loaded. Absent, it
    # simply does not fire — never against an invented threshold.
    try:
        median = float(request.args.get("class_pace") or 0) or None
    except ValueError:
        median = None

    flags = _visible_flags(
        flags_for(r, {"meta": meta, "class_pace_median": median}), role, mine)

    p = ((_teacher_pairs(request.uid) or [])
         and next((x for x in _teacher_pairs(request.uid)
                   if x.get("student_uid") == student_uid), {})) or {}

    return jsonify({
        "uid": student_uid,
        "roll_no": r.get("roll_no", ""),
        "name": r.get("name", "Student"),
        "initials": r.get("initials", "?"),
        "photo_url": r.get("photo_url", ""),
        "class_level": r.get("class_level", ""),

        # What this teacher is looking at, said out loud. Without it a
        # subject teacher reads "22% how far through" as the whole
        # syllabus rather than as her own.
        "role": role,
        "my_subjects": mine,
        "scope_label": (", ".join(mine) if role == "subject_teacher" and mine
                        else "All subjects"),
        "other_subjects": _other_subjects(meta, r, mine),

        "flags": [{"text": f["text"], "kind": f["kind"],
                   "severity": f["severity"], "share": f.get("share", "")}
                  for f in flags],

        "getting_right": acc,
        "questions_answered": seen,
        "how_far_through": far,
        "chapters_started": started,
        "chapters_in_scope": in_scope,
        "tests": int(r.get("tests_completed", 0) or 0),
        "days_quiet": _days_since(r.get("last_active_at", "")),
        "streak": int(r.get("streak_current", 0) or 0),

        "lost": things_lost(r, meta, ids, mine),
        "weakest": weakest(r, meta, ids, mine),
        "reading": reading(r, ids, meta, mine),
        "subjects": by_subject(r, ids, meta),
        "chapters": chapters(r, ids, meta),
        "pace": pace(r, meta, median),

        # Masked until explicitly revealed through the audited route that
        # already exists. This page never carries a real phone number.
        # You built @require_class_teacher on teacher_home.reveal_contact
        # deliberately, and page 2 was calling the older ungated route --
        # so a subject teacher could unmask a guardian's number from here.
        # The server route is what enforces it; this flag stops her being
        # shown a button that will 403.
        "guardian": {
            "name": r.get("guardian_name", "") if role == "class_teacher" else "",
            "has_phone": bool(r.get("guardian_phone")),
            "has_email": bool(r.get("guardian_email")),
            "can_reveal": role == "class_teacher",
            "class_key": _s(r.get("class_key", "")),
        },
        "notes": len(p.get("entries") or []),
        "followup_at": p.get("next_followup", "") or "",
    })


# ═══════════════════════════════════════════════════════════════════════
# ROUTE 2 · TESTS — folders, not a wall
# ═══════════════════════════════════════════════════════════════════════
#
# The old version returned 29 flat rows all reading "Hydrocarbons" and 28
# "papers" that were mostly custom drills. Three faults, all fixed here:
#
#   1 · test_sessions stores `percentage`, NOT `score_percentage`
#       (backend.py:2485). Reading the wrong name made every chapter-test
#       score render as an em-dash.
#
#   2 · pyq_sessions holds THREE different things and they were being
#       counted as one. `test_type` and `arena_session` tell them apart,
#       exactly as get_arena_history already does (backend.py:6833). An
#       8/28 "full NEET paper" was a seven-question custom drill.
#
#   3 · Nothing was grouped. 29 attempts at one chapter and 22 at one
#       paper is a wall, not a signal.
#
# So: chapter FOLDERS and paper GROUPS. Both open into page 3.

PHASE_ORDER = ["Foundation", "Skill Building", "Mastery",
               "NEET Simulation", "Bonus Pool", "Grand Mock"]


def _phase_rank(p):
    try:
        return PHASE_ORDER.index(p)
    except ValueError:
        return -1


def _pct(v):
    """A percentage, or None. Never 0 standing in for 'no score'."""
    try:
        return round(float(v), 1)
    except (TypeError, ValueError):
        return None


def _session_row(doc, meta):
    """One OPD / chapter test, from the fields the session already has."""
    s = doc.to_dict() or {}
    # A dict here would raise "unhashable type" on meta.get(cid), which
    # is exactly what the fuzz found.
    cid = _s(s.get("chapter_id", ""))
    qs = [q for q in _seq(s.get("questions")) if isinstance(q, dict)]
    return {
        "id": _s(s.get("session_id"), 300) or doc.id,
        "chapter_id": cid,
        "chapter": (meta.get(cid) or {}).get("chapter_title", "") or cid,
        "subject": canon_subject((meta.get(cid) or {}).get("subject")),
        "test_num": _i(s.get("test_num"), None),
        # Straight off the document, so the teacher reads the same word
        # the student saw. No new vocabulary invented here.
        "phase": _s(s.get("phase"), 40),
        "test_type": _s(s.get("test_type"), 30) or "learning",
        "is_flex": bool(s.get("is_flex")),
        "is_retake": bool(s.get("is_retake")),
        "retake_count": _i(s.get("retake_count")),
        "questions": _i(s.get("total_questions")) or len(qs),
        "wrong": sum(1 for q in qs if q.get("is_correct") is False),
        "skipped": sum(1 for q in qs
                       if q.get("student_answer") in (None, "", {})),
        # THE BUG. `percentage`, not `score_percentage`.
        "pct": _pct(s.get("percentage")),
        "score": s.get("score"),
        "seconds": _i(s.get("time_taken_seconds")),
        "limit_seconds": _i(s.get("time_limit_seconds")),
        "at": _iso(s.get("completed_at") or s.get("started_at")),
    }


def _paper_row(doc, meta):
    """One full paper or custom drill from pyq_sessions."""
    s = doc.to_dict() or {}
    # `x or {}` keeps a LIST when the field is a list, and .get() then
    # fails. Every container is type-checked, not truthiness-checked.
    sd = s.get("score_data") if isinstance(s.get("score_data"), dict) else {}
    bd = (sd.get("subject_breakdown")
          if isinstance(sd.get("subject_breakdown"), dict) else {})
    is_paper = s.get("test_type") == "full_paper"
    year, code = _i(s.get("year"), None), _s(s.get("paper_code"), 20)
    label = _s(s.get("label"), 80) or (
        f"NEET {year}" if year else
        ("Full paper" if is_paper else "Custom test"))
    return {
        "id": _s(s.get("session_id"), 300) or doc.id,
        "kind": ("arena" if (is_paper and s.get("arena_session"))
                 else "paper" if is_paper else "custom"),
        "label": label,
        "year": year,
        "paper_code": code,
        "marks": _i(sd.get("total_marks"), None),
        "max": _i(sd.get("max_marks"), None) or (720 if is_paper else None),
        "accuracy": _pct(sd.get("accuracy")),
        "air": (_i(sd["air_prediction"].get("air_mid"), None)
                if isinstance(sd.get("air_prediction"), dict) else None),
        "subjects": [
            {"subject": canon_subject(_s(k, 40)),
             "marks": _i(v.get("marks"), None) if isinstance(v, dict) else None,
             "max": (_i(v.get("max"), None) if isinstance(v, dict) else None) or 180}
            for k, v in sorted(bd.items(), key=lambda kv: _s(kv[0]))
        ],
        "seconds": _i(s.get("time_taken_seconds")),
        "at": _iso(s.get("completed_at") or s.get("created_at")),
    }


def _group_papers(rows):
    """Group by paper, best attempt on top.

    The same groupKey and ordering as arena-desktop.js
    adLoadPracticeHistory, so a teacher and a student looking at the same
    twenty-two attempts see them organised the same way.

    One deliberate difference: a student wants their best; a teacher also
    wants to know whether four attempts went 4 -> 13 -> 4 -> 7. So the
    group carries `change`, the delta from first attempt to best.
    """
    buckets = {}
    for r in rows:
        key = (f"p|{r['year']}|{r['paper_code']}"
               if r["year"] and r["paper_code"] else f"l|{r['label']}")
        buckets.setdefault(key, []).append(r)

    out = []
    for key, atts in buckets.items():
        # Best first: highest marks, then most recent.
        atts.sort(key=lambda x: (-(x["marks"] or 0), x["at"] or ""),
                  reverse=False)
        atts.sort(key=lambda x: ((x["marks"] if x["marks"] is not None else -1),
                                 x["at"] or ""), reverse=True)
        best = atts[0]
        first = min(atts, key=lambda x: x["at"] or "")
        change = (None if best["marks"] is None or first["marks"] is None
                  else best["marks"] - first["marks"])
        out.append({
            "key": key,
            "label": best["label"],
            "year": best["year"],
            # Secondary, as a chip -- the code is not the name of the test.
            "paper_code": best["paper_code"],
            "kind": best["kind"],
            "attempts": len(atts),
            "best": best,
            "others": atts[1:],
            "change": change,
            "last_at": max((a["at"] or "") for a in atts),
        })
    out.sort(key=lambda g: g["last_at"], reverse=True)
    return out


def _group_chapters(rows):
    """A folder per chapter. 29 identical rows become one."""
    buckets = {}
    for r in rows:
        buckets.setdefault(r["chapter_id"], []).append(r)

    out = []
    for cid, tests in buckets.items():
        tests.sort(key=lambda t: (t["test_num"] or 0, t["at"] or ""),
                   reverse=True)
        scored = [t["pct"] for t in tests if t["pct"] is not None]
        phases = [t["phase"] for t in tests if t["phase"]]
        furthest = max(phases, key=_phase_rank) if phases else ""
        out.append({
            "chapter_id": cid,
            "chapter": tests[0]["chapter"],
            "subject": tests[0]["subject"],
            "tests": len(tests),
            "retakes": sum(1 for t in tests if t["is_retake"]),
            "flex": sum(1 for t in tests if t["is_flex"]),
            # Blank, not zero, when nothing has been scored.
            "average": round(sum(scored) / len(scored), 1) if scored else None,
            "latest": tests[0],
            "furthest_phase": furthest,
            "last_at": max((t["at"] or "") for t in tests),
        })
    out.sort(key=lambda g: g["last_at"], reverse=True)
    return out


def _completed(collection, uid, db):
    return (db.collection(collection)
              .where("user_id", "==", uid)
              .where("status", "==", "completed")
              .limit(MAX_SESSIONS).stream())


@student_bp.route("/api/teacher/student/<student_uid>/v2/tests", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_student
def v2_tests(student_uid):
    r = request.student_rollup
    meta = chapter_meta()
    role, mine = _role_of(request.args.get("class_key"), r)
    ids = _scope_ids(meta, r, mine)
    db = _db()

    chapter_rows, paper_rows = [], []
    try:
        for doc in _completed("test_sessions", student_uid, db):
            chapter_rows.append(_session_row(doc, meta))
    except Exception as e:
        print(f"[student] test_sessions read failed for {student_uid}: {e}")
    try:
        for doc in _completed("pyq_sessions", student_uid, db):
            paper_rows.append(_paper_row(doc, meta))
    except Exception as e:
        print(f"[student] pyq_sessions read failed for {student_uid}: {e}")

    # Chapter tests belong to a subject, so they are scoped. A FULL
    # PAPER is not: it covers all three subjects and is the student's
    # overall standing, which every teacher who knows them should see.
    if mine:
        chapter_rows = [x for x in chapter_rows if x["chapter_id"] in ids]

    papers = [x for x in paper_rows if x["kind"] in ("arena", "paper")]
    customs = [x for x in paper_rows if x["kind"] == "custom"]

    return jsonify({
        "role": role,
        "my_subjects": mine,
        "chapters": _group_chapters(chapter_rows),
        "papers": _group_papers(papers),
        "customs": _group_papers(customs),
        "counts": {"chapter_tests": len(chapter_rows),
                   "papers": len(papers), "customs": len(customs)},
        "capped": (len(chapter_rows) >= MAX_SESSIONS
                   or len(paper_rows) >= MAX_SESSIONS),
        "scanned_limit": MAX_SESSIONS,
    })


# ═══════════════════════════════════════════════════════════════════════
# ROUTE 2b · ONE CHAPTER'S TESTS  (page 3, level one)
# ═══════════════════════════════════════════════════════════════════════

@student_bp.route("/api/teacher/student/<student_uid>/v2/chapter/"
                  "<path:chapter_id>/tests", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_student
def v2_chapter_tests(student_uid, chapter_id):
    """Every test in one chapter: number, phase, size, flex, retake, score.

    Ordered by test number descending, because the work a teacher is
    asking about is almost always the most recent.
    """
    r = request.student_rollup
    meta = chapter_meta()
    role, mine = _role_of(request.args.get("class_key"), r)
    if mine and chapter_id not in _scope_ids(meta, r, mine):
        # The UI never offers this, but a hand-typed URL must not be a
        # way around the scope the roster enforces.
        return jsonify({"error": "That chapter is not in your subjects."}), 403
    db = _db()
    rows = []
    try:
        for doc in _completed("test_sessions", student_uid, db):
            r = _session_row(doc, meta)
            if r["chapter_id"] == chapter_id:
                rows.append(r)
    except Exception as e:
        print(f"[student] chapter test read failed for {student_uid}: {e}")

    rows.sort(key=lambda t: (t["test_num"] or 0, t["at"] or ""), reverse=True)
    scored = [t["pct"] for t in rows if t["pct"] is not None]
    phases = [t["phase"] for t in rows if t["phase"]]

    return jsonify({
        "chapter_id": chapter_id,
        "chapter": (meta.get(chapter_id) or {}).get("chapter_title", "")
                   or chapter_id,
        "subject": canon_subject((meta.get(chapter_id) or {}).get("subject")),
        "tests": rows,
        "count": len(rows),
        "average": round(sum(scored) / len(scored), 1) if scored else None,
        "furthest_phase": max(phases, key=_phase_rank) if phases else "",
        "phase_order": PHASE_ORDER,
    })


# ═══════════════════════════════════════════════════════════════════════
# ROUTE 3 · MISCONCEPTIONS — the AI text, and the answer they keep picking
# ═══════════════════════════════════════════════════════════════════════

def _usable_diagnosis(d):
    """Gemini's failure string is persisted like any other diagnosis.

    backend.py writes misconception="Unable to diagnose automatically"
    when the model call fails. Rendered without this filter, a teacher
    reads that sentence as the finding.
    """
    if not isinstance(d, dict):
        return False
    m = (d.get("misconception") or "").strip()
    return bool(m) and DEAD_DIAGNOSIS not in m.lower()


@student_bp.route("/api/teacher/student/<student_uid>/v2/misconceptions",
                  methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_student
def v2_misconceptions(student_uid):
    """Two things, both new, both already in the database.

    1 · What the AI worked out. ai_interventions has been storing
        {misconception, explanation, memory_trick} per student per
        concept since the feature shipped, and nothing has ever read it.

    2 · Which wrong answer this student keeps choosing. The class-level
        version exists (teacher_class.py question_detail); the
        per-student one did not. A student who picks the same distractor
        across six questions has one specific wrong model, not six gaps.
    """
    r = request.student_rollup
    meta = chapter_meta()
    per_con = r.get("per_concept") or {}
    db = _db()
    t0 = time.time()

    # ── 1 · the AI's diagnosis ────────────────────────────────────────
    diagnoses = []
    try:
        q = (db.collection("ai_interventions")
               .where("user_id", "==", student_uid)
               .where("type", "==", "diagnosis")
               .limit(60))
        for doc in q.stream():
            d = doc.to_dict() or {}
            diag = d.get("diagnosis") or {}
            if not _usable_diagnosis(diag):
                continue
            cid = d.get("concept_id", "")
            con = per_con.get(cid) or {}
            chap = meta.get(con.get("c", "")) or {}
            diagnoses.append({
                "concept": con.get("n", "") or cid,
                "chapter": chap.get("chapter_title", ""),
                "subject": canon_subject(chap.get("subject")),
                "misconception": (diag.get("misconception") or "")[:400],
                "explanation": (diag.get("explanation") or "")[:600],
                "memory_trick": (diag.get("memory_trick") or "")[:300],
                "asked": int(con.get("s", 0) or 0),
                "pct": con.get("m"),
            })
    except Exception as e:
        # A missing composite index surfaces here and nowhere else.
        print(f"[student] ai_interventions read failed for {student_uid}: {e}")

    diagnoses.sort(key=lambda x: (x["pct"] if x["pct"] is not None else 101))

    # ── 2 · the wrong answer they keep choosing ───────────────────────
    picks = Counter()
    labels = {}
    scanned = 0
    try:
        q = (db.collection("test_sessions")
               .where("user_id", "==", student_uid)
               .where("status", "==", "completed")
               .limit(MAX_SESSIONS))
        for doc in q.stream():
            scanned += 1
            for qn in (doc.to_dict() or {}).get("questions", []) or []:
                if qn.get("is_correct"):
                    continue
                ans = qn.get("student_answer")
                if ans in (None, ""):
                    continue
                opts = qn.get("options_detail") or []
                text = ""
                for o in opts:
                    if o.get("key") == ans or o.get("option") == ans:
                        text = (o.get("text") or "")[:160]
                        break
                key = (text or str(ans))[:160]
                picks[key] += 1
                labels[key] = {
                    "answer": str(ans),
                    "text": text,
                    "chapter": (meta.get(qn.get("chapter_id", "")) or {})
                               .get("chapter_title", ""),
                }
    except Exception as e:
        print(f"[student] answer-pattern scan failed for {student_uid}: {e}")

    repeated = [{
        "answer": labels[k]["answer"],
        "text": _q(labels[k]["text"]),
        "chapter": labels[k]["chapter"],
        "times": n,
    } for k, n in picks.most_common(6) if n >= MIN_DISTRACTOR_HITS]

    return jsonify({
        "diagnoses": diagnoses[:6],
        "diagnoses_total": len(diagnoses),
        "repeated_answers": repeated,
        "sessions_scanned": scanned,
        "min_hits": MIN_DISTRACTOR_HITS,
        "ms": int((time.time() - t0) * 1000),
    })


# ═══════════════════════════════════════════════════════════════════════
# ROUTE 2c · ONE TEST, IN FULL  (page 3, level two)
# ═══════════════════════════════════════════════════════════════════════
#
# WRONG AND SKIPPED FIRST. A teacher opens a test to find out what went
# wrong; 180 correct answers are complete and unscannable. ?show=all
# returns everything, and the payload says which it gave you so a
# filtered list is never mistaken for the whole test.
#
# TWO COLLECTIONS, TWO STORAGE SHAPES. Chapter tests keep their questions
# on the session document. Papers do NOT: submit_pyq_session sets
# question_results_stored_separately and writes the real per-question
# data into a CHUNKED SUBCOLLECTION, thirty per document
# (backend.py:6392). teacher_backend.teacher_review reads
# s.get("questions") for both, so reviewing a paper has always returned a
# header and an empty question list. This assembles from the chunks.

MAX_REVIEW_Q = 200


def _variation(q):
    """v1 / v2 / v3, however this question happens to record it."""
    v = q.get("variation") or q.get("variation_number")
    if v in (None, ""):
        return ""
    v = str(v).lower()
    return v if v.startswith("v") else "v" + v


def _opd_question(q, i):
    return {
        "n": q.get("question_number") or i + 1,
        # All of this is question-bank text: subscripts, entities, the
        # lot. The client routes anything flagged html through tstuQ().
        "question": _q(q.get("question_text", "")),
        # OPD carries the explanation ON each option rather than in a
        # sibling map, so the map is built from the options themselves.
        "options": _option_rows(
            q.get("options_detail"),
            {str((o or {}).get("id", "")): (o or {}).get("explanation")
             for o in _seq(q.get("options_detail")) if isinstance(o, dict)}),
        "correct": q.get("correct_answer"),
        "answer": q.get("student_answer"),
        "result": ("correct" if q.get("is_correct") else
                   "skipped" if q.get("student_answer") in (None, "", {})
                   else "wrong"),
        # THE LADDER. The thing nothing else in this market can show.
        "variation": _variation(q),
        "base_id": q.get("base_question_id", ""),
        "concept_id": q.get("concept_id", ""),
        "tested_fact": q.get("tested_fact", ""),
        "difficulty": q.get("difficulty", ""),
        "explanation": _q(q.get("detailed_explanation")
                          or q.get("static_explanation", "")),
        "key_points": [t for t in (_text(k) for k in
                       _seq(q.get("key_points"))) if t][:6],
        "mistakes": [t for t in (_text(m) for m in
                     _seq(q.get("common_mistakes"))) if t][:6],
        "ncert": _q(q.get("ncert_page_quote") or q.get("source_verbatim", "")),
        "image": q.get("image_url"),
        "type": q.get("question_type", "single_correct"),
        "list1": q.get("list1") or [],
        "list2": q.get("list2") or [],
        "mapping": q.get("correct_mapping") or {},
    }


def _paper_question(qr, i):
    """Mirrors test-engine.js reviewItemHtml, so the teacher's review and
    the student's own describe the same question the same way."""
    each = qr.get("each_option_explanation") or {}
    res = qr.get("result", "")
    return {
        "n": qr.get("question_number") or i + 1,
        "question": _q(qr.get("question_text", "")),
        "options": _option_rows(qr.get("options"), each),
        "correct": qr.get("correct_answer"),
        "answer": qr.get("student_answer"),
        "result": ("correct" if res in ("correct", "mta") else
                   "skipped" if res in ("unattempted", "skipped", "")
                   else "wrong"),
        "is_mta": res == "mta",
        "marks": qr.get("marks_earned"),
        "subject": canon_subject(qr.get("subject")),
        "chapter": qr.get("chapter", ""),
        "difficulty": qr.get("difficulty", ""),
        "explanation": _q(qr.get("static_explanation", "")),
        "key_points": ([_text(qr["key_concept_summary"])]
                       if qr.get("key_concept_summary") else []),
        "mistakes": [t for t in (_text(m) for m in
                     _seq(qr.get("common_mistakes"))) if t][:6],
        "ncert": _q(qr.get("ncert_verbatim", "")),
        "image": qr.get("question_image_url"),
        "type": "single_correct",
        "list1": [], "list2": [], "mapping": {},
        "variation": "", "base_id": "", "concept_id": "", "tested_fact": "",
        "ladder": [],
    }


def _paper_chunks(session_id, db):
    """Reassemble the chunked question_results subcollection, in order."""
    parts = []
    try:
        for d in (db.collection("pyq_sessions").document(session_id)
                    .collection("question_results").stream()):
            c = d.to_dict() or {}
            parts.append((c.get("chunk_index", c.get("index", 0)),
                          _seq(c.get("results") or c.get("question_results"))))
    except Exception as e:
        print(f"[student] question_results chunks failed for {session_id}: {e}")
    parts.sort(key=lambda x: x[0])
    flat = []
    for _, part in parts:
        flat.extend(part)
    return flat


def _ladder(base_ids, student_uid, db):
    """The v1 -> v2 -> v3 history for these ideas, across ALL tests.

    The session records which variation was served. base_question_tracking
    records what happened to that idea over time, which is the story worth
    telling: wrong on v1, passed the retry, failed the audit three tests
    later.

    Retakes are excluded exactly as the rollup excludes them: a retake
    serves the same session back minutes later, so its result measures
    the short-term recall the audit exists to see past.
    """
    out = {}
    if not base_ids:
        return out
    try:
        for doc in (db.collection("base_question_tracking")
                      .where("user_id", "==", student_uid)
                      .limit(400).stream()):
            b = doc.to_dict() or {}
            bid = b.get("base_question_id", "")
            if bid not in base_ids:
                continue
            steps = []
            for h in _seq(b.get("variation_history")):
                if not isinstance(h, dict):
                    continue
                if h.get("is_retake"):
                    continue
                steps.append({
                    "variation": (h.get("variation") or "").lower(),
                    "result": h.get("result", ""),
                    "test_num": h.get("test_num"),
                    "at": _iso(h.get("at") or h.get("created_at")),
                })
            if steps:
                out[bid] = steps
    except Exception as e:
        print(f"[student] ladder read failed for {student_uid}: {e}")
    return out


@student_bp.route("/api/teacher/student/<student_uid>/v2/test/<session_id>",
                  methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_student
def v2_test_detail(student_uid, session_id):
    db = _db()
    meta = chapter_meta()

    doc = db.collection("test_sessions").document(session_id).get()
    is_paper = False
    if not doc.exists:
        doc = db.collection("pyq_sessions").document(session_id).get()
        is_paper = True
    if not doc.exists:
        return jsonify({"error": "That test could not be found."}), 404

    s = doc.to_dict() or {}
    # Same gate as the parent and teacher review routes. A teacher is not
    # a threat model, but an in-progress session leaks unseen questions
    # and there is no reason to build a second door into the same room.
    if s.get("user_id") != student_uid:
        print(f"[student] SESSION SCOPE VIOLATION uid={request.uid} "
              f"session={session_id}")
        return jsonify({"error": "That test belongs to another student."}), 403
    if s.get("status") != "completed":
        return jsonify({"error": "This test is still in progress.",
                        "code": "IN_PROGRESS"}), 403

    role, mine = _role_of(request.args.get("class_key"),
                          request.student_rollup)
    if mine and not is_paper:
        cid = _s(s.get("chapter_id", ""))
        if cid and cid not in _scope_ids(meta, request.student_rollup, mine):
            return jsonify({"error": "That test is not in your subjects."}), 403

    show = request.args.get("show", "wrong")

    if is_paper:
        raw = [q for q in (_paper_chunks(session_id, db)
                           or _seq(s.get("questions"))) if isinstance(q, dict)]
        qs = [_paper_question(q, i) for i, q in enumerate(raw)]
        sd = s.get("score_data") if isinstance(s.get("score_data"), dict) else {}
        head = _paper_row(doc, meta)
        head["counts"] = {"correct": _i(sd.get("correct_count"), None),
                          "wrong": _i(sd.get("wrong_count"), None),
                          "skipped": _i(sd.get("unattempted_count"), None)}

        # A full paper stays VISIBLE to every teacher -- it is the
        # student's overall standing and the total out of 720 is the
        # point of it. But the QUESTIONS and the subject marks narrow to
        # hers: 180 questions across three subjects is not something a
        # Chemistry teacher can review, and two thirds of it was never
        # hers to review anyway.
        if mine:
            want = set(mine)
            qs = [q for q in qs if not q["subject"] or q["subject"] in want]
            head["subjects"] = [x for x in head["subjects"]
                                if x["subject"] in want]
            head["scoped_to"] = sorted(want)
            # Recomputed for the questions she can actually act on. The
            # paper-level correct/wrong/skipped describe all 180.
            head["counts"] = {
                "correct": sum(1 for q in qs if q["result"] == "correct"),
                "wrong": sum(1 for q in qs if q["result"] == "wrong"),
                "skipped": sum(1 for q in qs if q["result"] == "skipped")}
    else:
        raw = [q for q in _seq(s.get("questions")) if isinstance(q, dict)]
        qs = [_opd_question(q, i) for i, q in enumerate(raw)]
        head = _session_row(doc, meta)
        head["counts"] = {
            "correct": sum(1 for q in qs if q["result"] == "correct"),
            "wrong": sum(1 for q in qs if q["result"] == "wrong"),
            "skipped": sum(1 for q in qs if q["result"] == "skipped")}
        lad = _ladder({q["base_id"] for q in qs if q["base_id"]},
                      student_uid, db)
        for q in qs:
            q["ladder"] = lad.get(q["base_id"], [])

    total = len(qs)
    if show != "all":
        qs = [q for q in qs if q["result"] in ("wrong", "skipped")]

    return jsonify({
        "kind": "paper" if is_paper else "opd",
        "head": head,
        "questions": qs[:MAX_REVIEW_Q],
        "shown": len(qs[:MAX_REVIEW_Q]),
        "total": total,
        "show": show,
        # Wrong-first is a default, not a restriction. Said out loud, or a
        # teacher reads a filtered list as the whole test.
        "filtered": show != "all",
    })


# ═══════════════════════════════════════════════════════════════════════
# REGISTRATION
# ═══════════════════════════════════════════════════════════════════════

def register_student_page_routes(app):
    """Register, then prove nothing here shadows an existing rule.

    teacher_backend.py already owns /api/teacher/student/<uid>,
    /tests and /interventions. Flask resolves a duplicate silently to
    whichever blueprint registered first and returns 200 with the wrong
    body, so this is checked rather than remembered.
    """
    app.register_blueprint(student_bp)

    bad = [str(r) for r in app.url_map.iter_rules()
           if r.endpoint.startswith("teacher_student_v2.") and "/v2/" not in str(r)]
    if bad:
        raise RuntimeError(
            "teacher_student.py routes must sit under /v2/ or they will "
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