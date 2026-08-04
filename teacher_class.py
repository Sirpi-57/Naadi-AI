"""
NAADI AI — CLASS TAB  (teacher_class.py)
═══════════════════════════════════════════════════════════════════════════

The fourth Blueprint. Home answers "who needs me today". THIS tab answers
"where is the syllabus and how is the group doing" — aggregate, not
individual.

The one deliberate exception is the score distribution, where tapping a
band reveals the names inside it. In a class of 45 that is the whole point:
"eleven students are under 40% in Hydrocarbons" is only actionable once you
know which eleven.

───────────────────────────────────────────────────────────────────────────
COVERAGE AND MASTERY ARE TWO NUMBERS, NEVER ONE

This is the single most important rule in this file, and fusing them was
the biggest defect in the old portal.

    COVERAGE   concepts_attempted / concepts_total
               "6 of 60 concepts done" — HOW FAR THROUGH
    MASTERY    correct / seen on what they HAVE attempted
               "74% right" — HOW WELL

user_progress.overall_mastery averages every concept in a chapter with the
untouched ones counted as ZERO. So a student ten concepts into a sixty
concept chapter, answering at 90%, scores about 15%. Read as "weak" that is
simply false — it means "barely started". The old heatmap bled red for a
class that was doing fine and merely hadn't got there yet.

Every endpoint below returns both, always separately labelled. Nothing in
this file ever averages one into the other.

───────────────────────────────────────────────────────────────────────────
COST

Every endpoint reads the same ~50 student_rollups and computes in memory.
No endpoint here reads user_progress, test_sessions or question_results.
A class of 50 costs 50 reads per view, which is why per_concept and the
signals block were denormalised onto the rollup in the first place.

───────────────────────────────────────────────────────────────────────────
WHY EVERY ROUTE HERE IS UNDER /v2/

teacher_backend.py already owns these paths:

    /api/teacher/class/<key>/overview      (line 553)
    /api/teacher/class/<key>/concepts
    /api/teacher/class/<key>/coverage, /heatmap, /roster, /deck, /tests …

Flask resolves a duplicate rule to whichever blueprint registered FIRST,
and it does so SILENTLY. Registering a second /overview raises nothing —
the route simply never runs, and the client receives the OLD payload with
none of the fields it expects. That failure mode is invisible from every
angle you would normally check: the request returns 200, the server log
shows a hit, and the page renders half-blank with no console error.

Namespacing under /v2/ makes the collision structurally impossible rather
than something to remember. If the old routes are retired later, these can
be renamed back; until then the prefix is what lets both live at once.
"""

from collections import defaultdict

from flask import Blueprint, request, jsonify

from portal_backend import (
    require_auth, require_role, _db, _user, _days_since,
    chapter_meta, SUBJECTS,
)
from teacher_backend import resolve_class, _roster
from teacher_home import class_role_for, _student_brief, _subject_of
from teacher_signals import canon_subject
from studio_syllabus import merged_syllabus, syllabus_coverage

class_bp = Blueprint("teacher_class", __name__)

# ── Sample gates ───────────────────────────────────────────────────────
# A percentage from four questions is not a measurement. Students below
# these floors are reported in their own "not enough data yet" bucket
# rather than being dumped into the 0-20 band, where they would look like
# failures when they are merely new.
MIN_Q_CHAPTER = 15      # before a per-chapter % is shown
MIN_Q_OVERALL = 20      # before an overall % is shown
MIN_Q_FOR_COMPARE = 60  # before first-vs-retake is stated as percentages

BANDS = [(0, 20), (20, 40), (40, 60), (60, 80), (80, 101)]


def _questions_by_chapter(rollup, chapter_ids):
    """{chapter_id: questions answered} for this student, exactly.

    ⚠️  NOT per_chapter.concepts_attempted — THE BUG THIS REPLACES.

    That field counts CONCEPTS TOUCHED:

        concepts_attempted = sum(
            1 for c in cm_all.values()
            if len(c.get("questions_seen", [])) > 0)

    A chapter of 30 concepts caps it at 30 however many questions were
    served, and a concept typically carries three or four. Feeding it to a
    gate written in questions therefore under-counted by roughly 3x: a
    student who had answered ~27 questions across 9 concepts was reported
    as "9 questions answered" and blocked by a 15-question floor they had
    passed long ago. That is why every individual chapter showed an empty
    chart while the combined view — where the same undercounts summed past
    20 — placed the same student happily.

    per_concept holds the real number: `s` is questions seen for that
    concept (len(questions_seen) in the rollup builder), `c` is its
    chapter. No rollup change, no backfill.
    """
    pc = rollup.get("per_concept", {}) or {}
    ids = set(chapter_ids)
    out = {}
    for c in pc.values():
        cid = c.get("c")
        if cid in ids:
            out[cid] = out.get(cid, 0) + int(c.get("s", 0) or 0)
    return out


def _band_label(lo, hi):
    return f"{lo}-{hi if hi <= 100 else 100}%"


def _role(class_key):
    u = getattr(request, "user_doc", None) or _user(request.uid) or {}
    return class_role_for(u, class_key)


def _avg(nums):
    nums = [n for n in nums if n is not None]
    return round(sum(nums) / len(nums), 1) if nums else None


def _class_levels(meta):
    """School years present. Reads either shape (merged or raw metadata)."""
    out = set()
    for m in (meta or {}).values():
        c = str(m.get("class_level", m.get("class", "")) or "").strip()
        if c:
            out.add(c)
    return sorted(out)


def _chapter_filter(meta, subject=None, class_level=None, needs=None):
    """Chapters matching the subject / class-level filter.

    Works on either raw chapter_metadata or a merged_syllabus dict, since
    the merged entries carry both `subject` and `class_level` alongside the
    original `class` key.

    `needs` restricts to one side of the syllabus:
        "opd"    chapters with a question bank      (testing)
        "studio" chapters with reading material     (Concept Studio)
        None     everything
    Reading progress must be measured against the READING syllabus and
    test progress against the TESTING syllabus — measuring one against the
    other is what made a chapter that exists only in the Studio invisible.
    """
    out = {}
    for cid, m in (meta or {}).items():
        if subject and canon_subject(m.get("subject")) != canon_subject(subject):
            continue
        lvl = str(m.get("class_level", m.get("class", "")) or "")
        if class_level and lvl != str(class_level):
            continue
        if needs == "opd" and not m.get("in_opd", True):
            continue
        if needs == "studio" and not m.get("in_studio", False):
            continue
        out[cid] = m
    return out


def _cname(m, cid):
    """Chapter title from either shape."""
    return m.get("chapter_name") or m.get("chapter_title") or cid


def _clevel(m):
    return str(m.get("class_level", m.get("class", "")) or "")


# ═══════════════════════════════════════════════════════════════════════
# 1 · CROSS-SUBJECT PROGRESS  — the three sections
# ═══════════════════════════════════════════════════════════════════════

def _studio_section(roster, meta, subject=None, class_level=None):
    """Concept Studio coverage, measured against the STUDIO syllabus.

    This used to iterate chapter_metadata — the OPD collection — and ask
    how much of it had been read. A chapter with reading material but no
    question bank could therefore never appear, and a student who had
    demonstrably worked through it showed as "0 of 2 students have opened
    at least one".

    Reading is now measured against chapters that HAVE reading material.

    Two averages, because either alone misleads:
      avg_over_all      unopened chapters count as 0 — how far through the
                        material the class is
      avg_over_started  only chapters someone opened — how much they finish
                        once they start
    """
    chs = _chapter_filter(meta, subject, class_level, needs="studio")
    if not chs:
        return None

    per_student_all, per_student_started = [], []
    chapter_totals = defaultdict(list)
    students_touching = 0
    reading_not_marking = 0

    for r in roster:
        sig = r.get("signals", {}) or {}
        sb = sig.get("studio_by_chapter", {}) or {}
        eng = sig.get("studio_engagement", {}) or {}

        vals, started = [], []
        reading_only_somewhere = False
        for cid in chs:
            pct = float(sb.get(cid, 0) or 0)
            vals.append(pct)
            e = eng.get(cid) or {}
            touched = int(e.get("blocks_touched", 0) or 0)
            done = int(e.get("blocks_done", 0) or 0)
            # Opened counts even at 0% complete: a student six blocks into
            # a chapter who has ticked none of them is working, not idle.
            if pct > 0 or touched > 0:
                started.append(pct)
            if touched > 0 and done == 0:
                reading_only_somewhere = True
            chapter_totals[cid].append({"pct": pct, "touched": touched})

        per_student_all.append(sum(vals) / len(vals) if vals else 0.0)
        if started:
            students_touching += 1
            per_student_started.append(sum(started) / len(started))
        if reading_only_somewhere:
            reading_not_marking += 1

    rows = []
    for cid, entries in chapter_totals.items():
        pcts = [e["pct"] for e in entries]
        opened = sum(1 for e in entries if e["pct"] > 0 or e["touched"] > 0)
        m = chs[cid]
        rows.append({
            "chapter_id": cid,
            "chapter_name": _cname(m, cid),
            "subject": canon_subject(m.get("subject")),
            "class_level": _clevel(m),
            "avg_pct": round(sum(pcts) / len(pcts), 1) if pcts else 0.0,
            "students_opened": opened,
            "students_finished": sum(1 for p in pcts if p >= 95),
            "students": len(roster),
            "also_tested": bool(m.get("in_opd", False)),
        })
    rows.sort(key=lambda r: -r["avg_pct"])

    return {
        "chapters_in_scope": len(chs),
        "avg_completion_all": round(_avg(per_student_all) or 0, 1),
        "avg_completion_started": _avg(per_student_started),
        "students_touching": students_touching,
        "students": len(roster),
        "chapters": rows,
        "reading_not_marking": reading_not_marking,
    }


def _opd_section(roster, meta, subject=None, class_level=None):
    """Tests per subject: COVERAGE and MASTERY, never blended, split by year.

    ⚠️  THE /42 PROBLEM THIS SOLVES

    Biology has ~20 class-11 chapters and ~22 class-12 chapters. A class-12
    student who has finished every chapter they have been taught still
    reads as 22/42 = 52% "through Biology" — and looks half-finished
    forever. The class-11 half is not work they have skipped; it is work
    that is not theirs yet.

    So coverage is reported PER CLASS LEVEL, and the subject total is only
    a roll-up of those. A teacher looking at 12-A sees the class-12 row
    first, with class 11 available beside it because NEET students do
    revise both. The merged number is never shown alone.

    COVERAGE  concepts attempted / concepts in the chapter   how far
    MASTERY   correct / seen on what they DID attempt        how well
    """
    out = []
    subs = sorted({canon_subject(m.get("subject")) for m in meta.values()})
    if subject:
        subs = [s for s in subs if s == canon_subject(subject)]

    for sub in subs:
        if sub == "Unassigned":
            continue

        levels = sorted({
            _clevel(m) or "?"
            for cid, m in meta.items()
            if canon_subject(m.get("subject")) == sub and m.get("in_opd", True)
        })

        level_rows = []
        for lvl in levels:
            if class_level and str(lvl) != str(class_level):
                continue
            chs = {cid: m for cid, m in meta.items()
                   if canon_subject(m.get("subject")) == sub
                   and (_clevel(m) or "?") == lvl
                   and m.get("in_opd", True)}
            if not chs:
                continue

            cov_per_student = []
            acc_num = acc_den = 0
            tests_total = 0
            chapters_done = 0
            students_with_data = 0

            for r in roster:
                pc = r.get("per_chapter", {}) or {}
                covs, seen_any = [], False
                for cid in chs:
                    ch = pc.get(cid)
                    if not ch:
                        covs.append(0.0)
                        continue
                    covs.append(float(ch.get("coverage_pct", 0) or 0))
                    tests_total += int(ch.get("tests", 0) or 0)
                    if ch.get("complete"):
                        chapters_done += 1
                    acc = ch.get("accuracy")
                    q = int(ch.get("concepts_attempted", 0) or 0)
                    if acc is not None and q > 0:
                        acc_num += acc * q
                        acc_den += q
                        seen_any = True
                if covs:
                    cov_per_student.append(sum(covs) / len(covs))
                if seen_any:
                    students_with_data += 1

            level_rows.append({
                "class_level": lvl,
                "chapters_total": len(chs),
                "coverage_pct": round(_avg(cov_per_student) or 0, 1),
                "mastery_pct": round(acc_num / acc_den, 1) if acc_den else None,
                "tests_taken": tests_total,
                "chapters_completed": chapters_done,
                "students_with_data": students_with_data,
            })

        if not level_rows:
            continue

        # Subject roll-up, weighted by chapter count so the two years do
        # not each count as half regardless of size.
        tot_ch = sum(r["chapters_total"] for r in level_rows) or 1
        cov = sum(r["coverage_pct"] * r["chapters_total"] for r in level_rows) / tot_ch
        mrows = [r for r in level_rows if r["mastery_pct"] is not None]
        mast = (round(sum(r["mastery_pct"] * r["chapters_total"] for r in mrows)
                      / sum(r["chapters_total"] for r in mrows), 1)
                if mrows else None)

        out.append({
            "subject": sub,
            "chapters_total": tot_ch,
            "coverage_pct": round(cov, 1),
            "mastery_pct": mast,
            "tests_taken": sum(r["tests_taken"] for r in level_rows),
            "chapters_completed": sum(r["chapters_completed"] for r in level_rows),
            "students_with_data": max(
                (r["students_with_data"] for r in level_rows), default=0),
            "students": len(roster),
            "levels": level_rows,
        })
    return out


def _arena_section(roster):
    """NEET Arena: class average per paper, from each student's BEST attempt.

    Best, not latest: an average built from latest attempts punishes the
    student who retried and slipped, which is the opposite of what a
    teacher means by "how did we do on the 2023 paper".

    ⚠️  THE RANGE IS A RANGE OF *BESTS*, NOT OF ALL ATTEMPTS.
    An earlier version rendered this as "lowest 670 · highest 670" for a
    paper one student had sat. Read plainly that says the class scored
    between 670 and 670 — when it actually meant "one student, best 670",
    and that student's weaker attempts had already been discarded.

    So: with one student we emit `single=True` and the client says
    "class best". With several we label it explicitly as best scores. The
    number was never wrong; the sentence around it was.
    """
    papers = defaultdict(lambda: {
        "marks": [], "subjects": defaultdict(list), "students": 0,
        "attempts": 0, "year": None, "paper_code": "", "max": 720,
    })

    for r in roster:
        bp = (r.get("signals", {}) or {}).get("arena_by_paper", {}) or {}
        for key, rec in bp.items():
            p = papers[key]
            p["students"] += 1
            p["attempts"] += int(rec.get("attempts", 1) or 1)
            p["marks"].append(rec.get("marks") or 0)
            p["year"] = rec.get("year")
            p["paper_code"] = rec.get("paper_code", "")
            p["max"] = rec.get("max", 720)
            for s, v in (rec.get("subjects") or {}).items():
                p["subjects"][canon_subject(s)].append(
                    (v.get("marks", 0) or 0, v.get("max", 180)))

    rows = []
    for key, p in papers.items():
        if not p["marks"]:
            continue
        n = len(p["marks"])
        rows.append({
            "paper_key": key,
            "year": p["year"],
            "paper_code": p["paper_code"],
            "max": p["max"],
            "students_attempted": n,
            "total_attempts": p["attempts"],
            "avg_marks": round(sum(p["marks"]) / n),
            "best_marks": max(p["marks"]),
            "lowest_marks": min(p["marks"]),
            # One student cannot have a range. Saying so is the whole fix.
            "single": n == 1,
            "subjects": [
                {"subject": s,
                 "avg": round(sum(m for m, _ in v) / len(v)),
                 "max": v[0][1] if v else 180}
                for s, v in sorted(p["subjects"].items()) if v
            ],
        })
    rows.sort(key=lambda r: (-(r["year"] or 0), r["paper_code"]))

    all_marks = [m for p in papers.values() for m in p["marks"]]
    return {
        "papers": rows,
        "papers_attempted": len(rows),
        "class_avg_marks": round(sum(all_marks) / len(all_marks)) if all_marks else None,
        "students_with_papers": sum(
            1 for r in roster
            if (r.get("signals", {}) or {}).get("arena_by_paper")),
        "students": len(roster),
    }


# ═══════════════════════════════════════════════════════════════════════
# 2 · SUBJECT COMPARISON — first attempts vs retakes
# ═══════════════════════════════════════════════════════════════════════

def _first_vs_retake(roster, subject=None, class_level=None, meta=None):
    """Class average on first attempts vs retakes.

    WEIGHTED BY QUESTION COUNT, not by test. Tests are not the same size —
    a chapter's phases serve different numbers, and the v2/v3 audit ladder
    injects extra questions into later tests. Averaging the PERCENTAGES
    would let a 4-question test move the class number as much as a
    35-question one. So this sums correct answers over questions asked,
    which is what a teacher means by "how did the class do".

    WHY RETAKES SCORE HIGHER — and why that is not good news:
    a retake replays the SAME questions minutes after the student read the
    explanations. A high retake average is short-term recall. It is not
    evidence the material stuck; the v3 audit three tests later is.

    LIMIT: signals.recent_tests holds the last 8 sessions within 45 days,
    so this is a RECENT comparison, not lifetime.
    """
    f_correct = f_qs = 0
    r_correct = r_qs = 0
    f_tests = r_tests = 0

    for r in roster:
        for t in ((r.get("signals", {}) or {}).get("recent_tests") or []):
            if subject and canon_subject(t.get("subject")) != canon_subject(subject):
                continue
            if class_level and meta:
                m = meta.get(t.get("chapter_id"), {}) or {}
                if _clevel(m) != str(class_level):
                    continue
            nq = int(t.get("questions", 0) or 0)
            if nq <= 0:
                continue
            correct = (float(t.get("pct") or 0) / 100.0) * nq
            if t.get("is_retake"):
                r_correct += correct
                r_qs += nq
                r_tests += 1
            else:
                f_correct += correct
                f_qs += nq
                f_tests += 1

    def pct(c, q):
        return round(c / q * 100, 1) if q else None

    # Below this, a percentage is an anecdote with a decimal point.
    enough = f_qs >= MIN_Q_FOR_COMPARE and r_qs >= MIN_Q_FOR_COMPARE

    return {
        "first_avg": pct(f_correct, f_qs) if enough else None,
        "first_tests": f_tests,
        "first_questions": f_qs,
        "retake_avg": pct(r_correct, r_qs) if enough else None,
        "retake_tests": r_tests,
        "retake_questions": r_qs,
        "enough_data": enough,
        "min_questions": MIN_Q_FOR_COMPARE,
        "window_note": "last 8 tests per student, within 45 days",
    }


# ═══════════════════════════════════════════════════════════════════════
# 3 · SCORE DISTRIBUTION  — with names behind the tap
# ═══════════════════════════════════════════════════════════════════════

def _distribution(roster, meta, subject=None, class_level=None,
                  chapter_id=None, mode="tests"):
    """Students bucketed into bands, over the chapters currently in scope.

    TWO MODES, never mixed on one axis:

        mode="tests"    % of questions answered correctly   (OPD)
        mode="reading"  % of the reading material worked through (Studio)

    They are different units answering different questions, so putting
    them in one bar would be meaningless. A toggle lets a teacher ask
    either question of the same class, with the axis relabelled.

    ⚠️  THE FILTER BUG THIS FIXES

    The subject branch used to read per_subject[subject].accuracy — a
    lifetime figure over every chapter in the subject, ignoring the year
    filter entirely. Biology·Class 11 and Biology·Class 12 drew identical
    bars, and both included chapters the teacher had filtered out.
    Accuracy is now recomputed from per_chapter over exactly the chapters
    in scope.
    """
    reading = mode == "reading"
    needs = "studio" if reading else "opd"
    chs = _chapter_filter(meta, subject, class_level, needs=needs)
    if chapter_id:
        one = chs.get(chapter_id) or meta.get(chapter_id)
        chs = {chapter_id: one} if one else {}

    buckets = [{"lo": lo, "hi": hi, "label": _band_label(lo, hi), "students": []}
               for lo, hi in BANDS]
    too_few = []
    # Reading has no "sample size" — a percentage of the chapter is a
    # percentage however little of it was opened — so only the test mode
    # gates. Gating reading would hide the very students it is meant to
    # surface.
    floor = 0 if reading else (MIN_Q_CHAPTER if chapter_id else MIN_Q_OVERALL)

    for r in roster:
        brief = _student_brief(r)
        sig = r.get("signals", {}) or {}

        if reading:
            sb = sig.get("studio_by_chapter", {}) or {}
            eng = sig.get("studio_engagement", {}) or {}
            vals, touched_any = [], False
            for cid in chs:
                pct = float(sb.get(cid, 0) or 0)
                vals.append(pct)
                if pct > 0 or int((eng.get(cid) or {}).get("blocks_touched", 0) or 0) > 0:
                    touched_any = True
            if not vals:
                # No chapters in scope at all. The empty state explains
                # that; listing every student under "hasn't answered
                # enough" would blame them for a content gap.
                continue
            acc = sum(vals) / len(vals)
            if not touched_any and acc <= 0:
                # Never opened anything in scope: a real 0, not missing data.
                acc = 0.0
        else:
            pc = r.get("per_chapter", {}) or {}
            qbc = _questions_by_chapter(r, chs)
            asked = sum(qbc.values())

            # Weight each chapter's accuracy by the QUESTIONS it contributed.
            # sum(acc_i x seen_i) / sum(seen_i) is exactly
            # total_correct / total_seen — weighting by concepts only
            # approximates it, and drifts when chapters differ in how many
            # questions each concept carries.
            num = den = 0
            for cid, q in qbc.items():
                a = (pc.get(cid) or {}).get("accuracy")
                if a is not None and q > 0:
                    num += a * q
                    den += q

            if asked < floor or den <= 0:
                # "Answered too few" and "never started" are different
                # problems needing different conversations, and lumping a
                # student who has answered nothing under "hasn't answered
                # enough" hides the one who never opened the chapter.
                too_few.append({**brief, "sample": asked,
                                "started": asked > 0})
                continue
            acc = num / den

        sample = 0 if reading else sum(_questions_by_chapter(r, chs).values())
        for b in buckets:
            if b["lo"] <= acc < b["hi"]:
                b["students"].append({**brief, "accuracy": round(acc, 1),
                                      "sample": sample})
                break

    for b in buckets:
        b["students"].sort(key=lambda s: s["accuracy"])
        b["count"] = len(b["students"])

    return {
        "mode": mode,
        "bands": buckets,
        "not_enough_data": [s for s in too_few if s.get("started")],
        "not_enough_count": sum(1 for s in too_few if s.get("started")),
        "not_started_data": [s for s in too_few if not s.get("started")],
        "not_started_count": sum(1 for s in too_few if not s.get("started")),
        "min_sample": floor,
        "chapters_counted": len(chs),
        "placed": sum(b["count"] for b in buckets),
    }


# ═══════════════════════════════════════════════════════════════════════
# 4 · STUDIO vs TESTED — same chapter, four states
# ═══════════════════════════════════════════════════════════════════════

def _studio_vs_tested(roster, meta, subject=None, class_level=None):
    """Read vs tested, for chapters that exist in BOTH systems.

    Restricted to the intersection on purpose. A chapter with no question
    bank can only ever report "read only", and a chapter with no reading
    material can only ever report "tested only" — neither is a finding
    about the class, it is a fact about what has been uploaded. Mixing
    those rows in made every row look alarming.

    The client renders ONE SENTENCE per chapter, naming only the states
    that are non-zero. "0 both · 0 read only · 2 tested only · 0 neither"
    is four numbers, three of them zero, and no teacher parses that at a
    glance — so the counts are returned but the sentence is what shows.
    """
    chs = {cid: m for cid, m in
           _chapter_filter(meta, subject, class_level).items()
           if m.get("in_opd", True) and m.get("in_studio", False)}

    rows = []
    for cid, m in chs.items():
        both = read_only = tested_only = neither = 0
        for r in roster:
            sig = r.get("signals", {}) or {}
            sb = sig.get("studio_by_chapter", {}) or {}
            eng = (sig.get("studio_engagement", {}) or {}).get(cid) or {}
            # Read means opened at all, not marked done.
            read = (float(sb.get(cid, 0) or 0) > 0
                    or int(eng.get("blocks_touched", 0) or 0) > 0)
            tested = int(((r.get("per_chapter", {}) or {}).get(cid) or {})
                         .get("tests", 0) or 0) > 0
            if read and tested:
                both += 1
            elif read:
                read_only += 1
            elif tested:
                tested_only += 1
            else:
                neither += 1
        rows.append({
            "chapter_id": cid,
            "chapter_name": _cname(m, cid),
            "subject": canon_subject(m.get("subject")),
            "class_level": _clevel(m),
            "both": both, "read_only": read_only,
            "tested_only": tested_only, "neither": neither,
            "students": len(roster),
            # Sort key: the gap is what a teacher acts on.
            "gap": read_only + tested_only,
        })
    rows.sort(key=lambda r: -r["gap"])
    return rows


# ═══════════════════════════════════════════════════════════════════════
# 5 · ENGAGEMENT
# ═══════════════════════════════════════════════════════════════════════

def _engagement(roster):
    on_streak = broke_streak = never_started = quiet = active_today = 0
    for r in roster:
        cur = int(r.get("streak_current", 0) or 0)
        best = int(r.get("streak_longest", 0) or 0)
        if cur >= 3:
            on_streak += 1
        if best >= 14 and cur == 0:
            broke_streak += 1
        if int(r.get("tests_completed", 0) or 0) == 0:
            never_started += 1
        d = _days_since(r.get("last_active_at"))
        if d is not None and d >= 7:
            quiet += 1
        if r.get("active_today"):
            active_today += 1
    return {
        "students": len(roster),
        "active_today": active_today,
        "on_streak": on_streak,
        "broke_long_streak": broke_streak,
        "never_started": never_started,
        "quiet_7d": quiet,
    }


# ═══════════════════════════════════════════════════════════════════════
# CLASS TEACHER ENDPOINT
# ═══════════════════════════════════════════════════════════════════════

@class_bp.route("/api/teacher/class/<class_key>/v2/overview", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_class
def class_overview(class_key):
    cr = _role(class_key)
    if cr["role"] is None:
        return jsonify({"needs_role": True}), 200

    subject = request.args.get("subject") or None
    class_level = request.args.get("class_level") or None

    roster = _roster(class_key)
    meta = merged_syllabus(chapter_meta())

    # A subject teacher hitting this endpoint is scoped to her subjects
    # server-side. The client never sends the scope; it is derived from the
    # stored role, so a crafted query string cannot widen it.
    if cr["role"] == "subject_teacher" and cr["subjects"]:
        if not subject or canon_subject(subject) not in cr["subjects"]:
            subject = cr["subjects"][0]

    return jsonify({
        "role": cr["role"],
        "subjects": cr["subjects"],
        "filters": {
            "subject": canon_subject(subject) if subject else None,
            "class_level": class_level,
            "available_subjects": sorted(
                {canon_subject(m.get("subject")) for m in meta.values()}),
            "available_class_levels": _class_levels(meta),
        },
        "students": len(roster),
        "studio": _studio_section(roster, meta, subject, class_level),
        # subject was previously dropped here, so picking "Biology" still
        # rendered every subject in the Tests block.
        "opd": _opd_section(roster, meta, subject, class_level),
        "arena": _arena_section(roster),
        "first_vs_retake": _first_vs_retake(roster, subject, class_level, meta),
        "studio_vs_tested": _studio_vs_tested(roster, meta, subject, class_level)[:20],
        "engagement": _engagement(roster),
        # How much of each syllabus exists — so a card that looks empty can
        # say WHY it is empty instead of implying the class did nothing.
        "syllabus": syllabus_coverage(
            _chapter_filter(meta, subject, class_level)),
    })


@class_bp.route("/api/teacher/class/<class_key>/v2/distribution", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_class
def class_distribution(class_key):
    """Score distribution. Separate endpoint because the filters change on
    every tap and the payload carries names, which the overview must not."""
    cr = _role(class_key)
    subject = request.args.get("subject") or None
    class_level = request.args.get("class_level") or None
    chapter_id = request.args.get("chapter_id") or None
    mode = request.args.get("mode") or "tests"
    if mode not in ("tests", "reading"):
        mode = "tests"

    if cr["role"] == "subject_teacher" and cr["subjects"]:
        if not subject or canon_subject(subject) not in cr["subjects"]:
            subject = cr["subjects"][0]

    roster = _roster(class_key)
    meta = merged_syllabus(chapter_meta())

    # Chapters are offered whenever a subject is chosen. With ~20 chapters
    # per subject per year the client groups them by class level rather
    # than rendering one 40-wide scroll strip.
    chapters = []
    if subject:
        # needs="opd" — a reading-only chapter has no test scores, so
        # offering it in this picker guarantees an empty chart and a
        # confused teacher.
        # The picker must follow the mode: offering a reading-only chapter
        # in test mode guarantees an empty chart, and hiding it in reading
        # mode hides the only chapter with anything to show.
        for cid, m in _chapter_filter(meta, subject, class_level,
                                      needs=("studio" if mode == "reading"
                                             else "opd")).items():
            chapters.append({
                "chapter_id": cid,
                "chapter_name": _cname(m, cid),
                "number": m.get("number", m.get("chapter_number", 0)),
                "class_level": _clevel(m),
                "in_studio": bool(m.get("in_studio", False)),
            })
        chapters.sort(key=lambda c: (c["class_level"], c["number"]))

    return jsonify({
        "scope": {
            "subject": canon_subject(subject) if subject else None,
            "class_level": class_level,
            "chapter_id": chapter_id,
            "chapter_name": _cname(meta.get(chapter_id, {}) or {}, chapter_id or ""),
        },
        "chapters": chapters,
        "available_class_levels": _class_levels(
            _chapter_filter(meta, subject,
                            needs=("studio" if mode == "reading" else "opd"))),
        # Reading-only chapters are excluded here. Naming the count lets
        # the client say so, rather than leaving a teacher to wonder why a
        # chapter she can see in the Studio card is missing from this one.
        "reading_only_excluded": len(
            _chapter_filter(meta, subject, class_level, needs="studio")) - len(
            {c for c in _chapter_filter(meta, subject, class_level, needs="studio")
             if (meta.get(c) or {}).get("in_opd", True)}),
        **_distribution(roster, meta, subject, class_level, chapter_id, mode),
    })


# ═══════════════════════════════════════════════════════════════════════
# SUBJECT TEACHER ENDPOINT — her subject, in depth
# ═══════════════════════════════════════════════════════════════════════

@class_bp.route("/api/teacher/class/<class_key>/v2/subject-depth", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_class
def subject_depth(class_key):
    cr = _role(class_key)
    # Must be the MERGED syllabus, not raw chapter_metadata: every helper
    # below reads in_opd / in_studio, and the raw collection has neither.
    meta = merged_syllabus(chapter_meta())

    subject = request.args.get("subject") or None
    if cr["role"] == "subject_teacher" and cr["subjects"]:
        if not subject or canon_subject(subject) not in cr["subjects"]:
            subject = cr["subjects"][0]
    # A class teacher may ask for every subject at once. Previously this
    # silently fell back to SUBJECTS[0], so "All subjects" rendered a
    # picker and nothing else — a dead end on a tab whose whole job is
    # showing where the syllabus is.
    subject = canon_subject(subject) if subject else None
    class_level = request.args.get("class_level") or None

    roster = _roster(class_key)
    chs = _chapter_filter(meta, subject, class_level)

    chapters = []
    for cid, m in chs.items():
        cov, acc_num, acc_den = [], 0, 0
        complete = testing = read_only = not_started = 0
        studio_vals = []
        for r in roster:
            sig = r.get("signals", {}) or {}
            ch = (r.get("per_chapter", {}) or {}).get(cid)
            sb = sig.get("studio_by_chapter", {}) or {}
            eng = (sig.get("studio_engagement", {}) or {}).get(cid) or {}
            spct = float(sb.get(cid, 0) or 0)
            studio_vals.append(spct)

            # "Has read it" means OPENED, not 30% complete. The old floor
            # filed a student six blocks into a sixty-block chapter under
            # "not started" — which is how a chapter someone was visibly
            # working through rendered as "Nobody has started this chapter".
            touched = int(eng.get("blocks_touched", 0) or 0)
            has_read = spct > 0 or touched > 0

            if ch:
                cov.append(float(ch.get("coverage_pct", 0) or 0))
                a = ch.get("accuracy")
                q = int(ch.get("concepts_attempted", 0) or 0)
                if a is not None and q > 0:
                    acc_num += a * q
                    acc_den += q
                if ch.get("complete"):
                    complete += 1
                elif int(ch.get("tests", 0) or 0) > 0:
                    testing += 1
                elif has_read:
                    read_only += 1
                else:
                    not_started += 1
            else:
                cov.append(0.0)
                if has_read:
                    read_only += 1
                else:
                    not_started += 1

        chapters.append({
            "chapter_id": cid,
            "chapter_name": _cname(m, cid),
            "number": m.get("number", m.get("chapter_number", 0)),
            "class_level": _clevel(m),
            "subject": canon_subject(m.get("subject")),
            "in_studio": bool(m.get("in_studio", False)),
            "in_opd": bool(m.get("in_opd", True)),
            "coverage_pct": round(_avg(cov) or 0, 1),
            "mastery_pct": round(acc_num / acc_den, 1) if acc_den else None,
            "studio_pct": round(_avg(studio_vals) or 0, 1),
            "complete": complete, "testing": testing,
            "read_only": read_only, "not_started": not_started,
            "students": len(roster),
        })

    # Weakest first, but only where enough of the class has attempted it —
    # a chapter two students touched is not "the weakest chapter".
    ranked = sorted(
        [c for c in chapters if c["mastery_pct"] is not None
         and (c["complete"] + c["testing"]) >= 3],
        key=lambda c: c["mastery_pct"])

    return jsonify({
        "subject": subject,
        "all_subjects": subject is None,
        "class_level": class_level,
        # So the view can explain a short chapter list — "6 chapters have
        # reading material but no questions yet" — rather than leaving a
        # teacher to wonder where they went.
        "syllabus": syllabus_coverage(
            _chapter_filter(meta, subject, class_level)),
        "available_class_levels": _class_levels(_chapter_filter(meta, subject)),
        "available_subjects": sorted(
            {canon_subject(m.get("subject")) for m in meta.values()}
            - {"Unassigned"}),
        "students": len(roster),
        "chapters": sorted(chapters, key=lambda c: (c["subject"], c["class_level"], c["number"])),
        "weakest": ranked[:8],
        "first_vs_retake": _first_vs_retake(roster, subject, class_level, meta),
        "studio_vs_tested": _studio_vs_tested(roster, meta, subject, class_level)[:20],
        "concepts": _concept_heat(roster, meta, subject, class_level),
    })


def _concept_heat(roster, meta, subject, class_level=None, chapter_id=None):
    """Class-wide concept mastery — the reteach list.

    Built from per_concept, which is on every rollup already: a flat map of
    concept_id -> {n: name, m: mastery, c: chapter_id, s: seen, f: failures}.

    NOT from weak_concepts, which is capped at 10 per student. A concept
    that is moderately weak for the WHOLE class but never cracks anyone's
    personal worst ten would be invisible there — and that concept is
    exactly the one worth a lesson.
    """
    chs = _chapter_filter(meta, subject, class_level)
    agg = {}

    for r in roster:
        for cid, c in (r.get("per_concept", {}) or {}).items():
            ch_id = c.get("c", "")
            if ch_id not in chs:
                continue
            seen = int(c.get("s", 0) or 0)
            if seen <= 0:
                continue
            e = agg.setdefault(cid, {
                "concept_id": cid,
                "concept_name": c.get("n", cid),
                "chapter_id": ch_id,
                "chapter_name": _cname(chs[ch_id], ch_id),
                "mastery_sum": 0.0, "seen_sum": 0,
                "students": 0, "struggling": 0, "failing_repeatedly": 0,
            })
            e["students"] += 1
            e["mastery_sum"] += float(c.get("m", 0) or 0)
            e["seen_sum"] += seen
            if float(c.get("m", 0) or 0) < 50:
                e["struggling"] += 1
            if int(c.get("f", 0) or 0) >= 2:
                e["failing_repeatedly"] += 1

    rows = []
    for e in agg.values():
        n = e.pop("students")
        rows.append({
            **e,
            "students_attempted": n,
            "avg_mastery": round(e.pop("mastery_sum") / n, 1) if n else None,
            "questions_seen": e.pop("seen_sum"),
        })

    # Enough of the class must have met the concept before it is called weak.
    rows = [r for r in rows if r["students_attempted"] >= 3]
    rows.sort(key=lambda r: (r["avg_mastery"] if r["avg_mastery"] is not None else 999))
    return {
        "weakest": rows[:20],
        "total_concepts": len(agg),
        "min_students": 3,
    }


@class_bp.route("/api/teacher/class/<class_key>/v2/chapter/<chapter_id>/concepts",
                methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_class
def chapter_concepts(class_key, chapter_id):
    """Concept heat inside ONE chapter, plus the spread of student scores.

    The spread matters: a 42% chapter average made of everyone at 42 is a
    reteach; the same average made of half at 80 and half at 10 is six
    students who need help. Identical number, opposite response.
    """
    roster = _roster(class_key)
    meta = merged_syllabus(chapter_meta())
    m = meta.get(chapter_id) or {}

    concepts = []
    agg = {}
    for r in roster:
        for cid, c in (r.get("per_concept", {}) or {}).items():
            if c.get("c") != chapter_id:
                continue
            seen = int(c.get("s", 0) or 0)
            if seen <= 0:
                continue
            e = agg.setdefault(cid, {
                "concept_id": cid, "concept_name": c.get("n", cid),
                "mastery_sum": 0.0, "students": 0,
                "struggling": 0, "failing_repeatedly": 0, "seen_sum": 0,
            })
            e["students"] += 1
            e["mastery_sum"] += float(c.get("m", 0) or 0)
            e["seen_sum"] += seen
            if float(c.get("m", 0) or 0) < 50:
                e["struggling"] += 1
            if int(c.get("f", 0) or 0) >= 2:
                e["failing_repeatedly"] += 1

    for e in agg.values():
        n = e["students"]
        concepts.append({
            "concept_id": e["concept_id"],
            "concept_name": e["concept_name"],
            "students_attempted": n,
            "avg_mastery": round(e["mastery_sum"] / n, 1) if n else None,
            "struggling": e["struggling"],
            "failing_repeatedly": e["failing_repeatedly"],
            "questions_seen": e["seen_sum"],
        })
    concepts.sort(key=lambda c: (c["avg_mastery"] if c["avg_mastery"] is not None else 999))

    spread = _distribution(roster, meta, chapter_id=chapter_id)

    # ── What was lost, not just who lost it ────────────────────────────
    # A name badge reading "SIRPI A S" tells a teacher nothing she can act
    # on. false_recoveries carries the base question; failed_bases carries
    # its text. Joining them turns the sharpest signal in the product from
    # a name into a lesson.
    lost = []
    for r in roster:
        ret = r.get("retention", {}) or {}
        bases = {b.get("base_question_id"): b
                 for b in (r.get("failed_bases", []) or [])}
        for fr in (ret.get("false_recoveries", []) or []):
            if fr.get("chapter_id") != chapter_id:
                continue
            bid = fr.get("base_question_id", "")
            b = bases.get(bid) or {}
            cname = ""
            cid_of = fr.get("concept_id") or b.get("concept_id")
            if cid_of:
                pc = (r.get("per_concept", {}) or {}).get(cid_of) or {}
                cname = pc.get("n", "")
            lost.append({
                "student_uid": r.get("uid", ""),
                "student_name": r.get("name", "Student"),
                "concept_name": cname,
                "question_text": (b.get("question_text") or "")[:220],
                "base_question_id": bid,
                "at": fr.get("at", "") or fr.get("failed_at", ""),
            })

    # Group by what was lost, so five students failing one idea reads as
    # one reteach rather than five separate names.
    grouped = {}
    for l in lost:
        k = l["concept_name"] or l["base_question_id"] or "unknown"
        g = grouped.setdefault(k, {
            "concept_name": l["concept_name"],
            "question_text": l["question_text"],
            "students": [],
        })
        g["students"].append(l["student_name"])
        if not g["question_text"] and l["question_text"]:
            g["question_text"] = l["question_text"]
    lost_rows = sorted(grouped.values(), key=lambda g: -len(g["students"]))

    # Questions the class fails most IN THIS CHAPTER. Each one taps
    # through to the full breakdown — stem, every option, how many chose
    # each, and why the wrong ones are wrong. Without this the drill-down
    # ended at "these concepts are weak" with no way to see what the
    # students actually got wrong.
    missed = _missed_questions(roster, meta, None, chapter_id=chapter_id)

    # ── Reading side, per student ──────────────────────────────────────
    # Concept Studio had nothing to drill into: the chapter sheet showed
    # concepts and questions, both of which are TEST data. A teacher who
    # taps the reading bar should see the reading story — who opened it,
    # how far each got, and who is reading without finishing anything.
    readers, not_opened = [], []
    blocks_total = int((m or {}).get("blocks_total", 0) or 0)
    for r in roster:
        sig = r.get("signals", {}) or {}
        pct = float((sig.get("studio_by_chapter", {}) or {}).get(chapter_id, 0) or 0)
        eng = (sig.get("studio_engagement", {}) or {}).get(chapter_id) or {}
        touched = int(eng.get("blocks_touched", 0) or 0)
        done = int(eng.get("blocks_done", 0) or 0)
        blocks_total = max(blocks_total, int(eng.get("blocks_total", 0) or 0))
        brief = _student_brief(r)
        if pct > 0 or touched > 0:
            readers.append({**brief, "pct": round(pct, 1),
                            "blocks_touched": touched, "blocks_done": done})
        else:
            not_opened.append(brief)
    readers.sort(key=lambda s: -s["pct"])

    studio = {
        "has_material": bool((m or {}).get("in_studio", False)) or bool(readers),
        "blocks_total": blocks_total,
        "readers": readers,
        "not_opened": not_opened[:20],
        "not_opened_count": len(not_opened),
        "avg_pct": round(sum(s["pct"] for s in readers) / len(readers), 1)
                   if readers else 0.0,
        # Opened blocks but marked none complete — reading without
        # committing, invisible in any completion percentage.
        "reading_not_marking": sum(
            1 for s in readers if s["blocks_touched"] > 0 and s["blocks_done"] == 0),
    }

    return jsonify({
        "studio": studio,
        "chapter_id": chapter_id,
        "chapter_name": _cname(m, chapter_id),
        "subject": canon_subject(m.get("subject")),
        "class_level": _clevel(m),
        "students": len(roster),
        "concepts": concepts,
        "spread": spread,
        "missed_questions": missed,
        "lost_it": lost_rows,
        "lost_count": len({l["student_name"] for l in lost}),
    })


# ═══════════════════════════════════════════════════════════════════════
# STARTUP GUARD
#
# Flask lets two blueprints claim the same rule and resolves it silently
# to whichever registered FIRST. That cost a debugging session already:
# /overview here was shadowed by teacher_backend.py's older route, the
# request returned 200, the server log showed a hit, and the Class tab
# rendered blank with no error anywhere pointing at the cause.
#
# register_class_routes() is the only supported way to mount this
# blueprint. It verifies at startup that every rule is namespaced, so a
# route added later without the prefix fails immediately and in one line
# rather than silently serving another blueprint's payload.
# ═══════════════════════════════════════════════════════════════════════

def register_class_routes(app):
    """Mount this blueprint, refusing to start if a route could collide.

        from teacher_class import register_class_routes
        register_class_routes(app)

    app.register_blueprint(class_bp) also works and is equivalent, but it
    skips the check below.
    """
    app.register_blueprint(class_bp)

    bad = []
    for rule in app.url_map.iter_rules():
        s = str(rule)
        if s.startswith("/api/teacher/class/") and rule.endpoint.startswith(
                "teacher_class."):
            if "/v2/" not in s:
                bad.append(s)
    if bad:
        raise RuntimeError(
            "teacher_class.py routes must sit under /v2/ or they will "
            "silently collide with teacher_backend.py. Offending: "
            + ", ".join(sorted(set(bad))))
    return app


def _missed_questions(roster, meta, subjects=None, chapter_id=None):
    """Base questions the class fails most, optionally scoped to a chapter.

    Reads `failed_bases` off the rollup — already denormalised, so this
    costs nothing beyond the roster read that has already happened.

    NOTE ON THE OLD "Question text unavailable" BUG: the original version
    looked up questions/{base_question_id}, but base_question_id lives in
    meta_data while the DOCUMENT id is the variation id, so every lookup
    missed. question_text is denormalised onto failed_bases, so it is read
    from there — no extra read, and it cannot drift out of sync.
    """
    agg = {}
    for r in roster:
        for b in (r.get("failed_bases", []) or []):
            cid = b.get("chapter_id", "")
            if chapter_id and cid != chapter_id:
                continue
            sub = canon_subject((meta.get(cid, {}) or {}).get("subject"))
            if subjects and sub not in subjects:
                continue
            bid = b.get("base_question_id") or b.get("concept_id")
            if not bid:
                continue
            e = agg.setdefault(bid, {
                "base_question_id": bid,
                "chapter_id": cid,
                "chapter_name": _cname(meta.get(cid, {}) or {}, cid),
                "subject": sub,
                "concept_name": b.get("concept_name", ""),
                "question_text": b.get("question_text", ""),
                "students": 0, "failures": 0, "names": [],
            })
            e["students"] += 1
            e["failures"] += int(b.get("failures", 0) or 0)
            if not e["question_text"] and b.get("question_text"):
                e["question_text"] = b["question_text"]
            if not e["concept_name"] and b.get("concept_name"):
                e["concept_name"] = b["concept_name"]
            nm = r.get("name", "")
            if nm and len(e["names"]) < 12 and nm not in e["names"]:
                e["names"].append(nm)

    rows = list(agg.values())
    # Inside one chapter a single student failing repeatedly is still worth
    # seeing, so the 2-student floor that applies class-wide is relaxed.
    if not chapter_id:
        rows = [e for e in rows if e["students"] >= 2]
    rows.sort(key=lambda e: (-e["students"], -e["failures"]))
    return rows[:10]


# ═══════════════════════════════════════════════════════════════════════
# QUESTION DETAIL — the wrong-option convergence
#
# The most teachable artefact in the database, and until now it has never
# been on a screen. question_results stores, per student per attempt, both
# `student_answer` and `options_detail`. Tallying the first against the
# second answers the question a teacher actually has:
#
#     not  "22 students got this wrong"
#     but  "22 students all chose option C"
#
# The first is a score. The second is a misconception with a name, and it
# is the difference between "revise this chapter" and "tomorrow I will
# open with why C is wrong".
#
# COST: this reads question_results for the roster and is therefore the
# most expensive call in the file. It is deliberately a SEPARATE endpoint
# behind a tap, never part of a page load, and it is capped.
# ═══════════════════════════════════════════════════════════════════════

MAX_SESSIONS_SCANNED = 400


@class_bp.route("/api/teacher/class/<class_key>/v2/question/<path:base_id>",
                methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_class
def question_detail(class_key, base_id):
    """Full breakdown of one question, including which wrong option won.

    ⚠️  READS test_sessions, NOT a top-level question_results collection.
    An earlier version queried collection("question_results") filtered by
    base_question_id — but that collection does not exist at the top level
    (it is a subcollection under pyq_sessions, for arena papers only), and
    the OPD records inside it carry neither base_question_id nor user_id.
    Every lookup 404'd.

    Everything needed is already on test_sessions.questions[]:
    base_question_id, student_answer, correct_answer, options_detail,
    question_text, explanations, common_mistakes. One read per session,
    no joins.
    """
    roster = _roster(class_key)
    uids = [r["uid"] for r in roster if r.get("uid")]
    names = {r["uid"]: r.get("name", "Student") for r in roster}
    if not uids:
        return jsonify({"error": "No students in this class."}), 404

    question = None
    tally = defaultdict(lambda: {"count": 0, "students": []})
    correct_students = []
    attempts = 0

    try:
        db = _db()
        scanned = 0
        # Firestore caps `in` at 30 values, so a 50-student class needs
        # chunking. Sessions are filtered by student, then the questions
        # array is scanned in memory — far cheaper than any alternative,
        # because the session document is a single read either way.
        for i in range(0, len(uids), 30):
            chunk = uids[i:i + 30]
            for doc in db.collection("test_sessions") \
                    .where("user_id", "in", chunk) \
                    .where("status", "==", "completed") \
                    .limit(MAX_SESSIONS_SCANNED).stream():
                s = doc.to_dict() or {}
                uid = s.get("user_id")
                scanned += 1

                for q in (s.get("questions", []) or []):
                    if q.get("base_question_id") != base_id:
                        continue
                    attempts += 1

                    if question is None:
                        question = {
                            "question_text": q.get("question_text", ""),
                            "correct_answer": str(q.get("correct_answer", "") or "").strip().upper(),
                            "concept_name": q.get("concept_name", "")
                                            or q.get("tested_fact", ""),
                            "difficulty": q.get("difficulty", ""),
                            "explanation": (q.get("detailed_explanation")
                                            or q.get("static_explanation") or ""),
                            "options": [
                                {"id": str(o.get("id", o.get("option_id", ""))).strip().upper(),
                                 "text": o.get("text", o.get("option_text", "")),
                                 "why_wrong": (o.get("explanation")
                                               or o.get("why_wrong", "")),
                                 }
                                for o in (q.get("options_detail", []) or [])
                            ],
                            "common_mistakes": q.get("common_mistakes", []) or [],
                            "ncert_quote": q.get("ncert_page_quote", ""),
                            "chapter_id": s.get("chapter_id", ""),
                        }

                    ans = q.get("student_answer")
                    if isinstance(ans, dict):
                        continue      # matching question; no single option
                    ans = str(ans or "").strip().upper()
                    if not ans:
                        continue

                    nm = names.get(uid)
                    if q.get("is_correct"):
                        if nm and nm not in correct_students:
                            correct_students.append(nm)
                    else:
                        t = tally[ans]
                        t["count"] += 1
                        if nm and nm not in t["students"]:
                            t["students"].append(nm)
    except Exception as e:
        print(f"[question] read failed for {base_id}: {e}")
        return jsonify({"error": "Could not load this question."}), 500

    if question is None:
        return jsonify({
            "error": "Nobody in this class has been served this question yet."
        }), 404

    total_wrong = sum(t["count"] for t in tally.values())
    for o in question["options"]:
        t = tally.get(o["id"])
        o["chose_count"] = t["count"] if t else 0
        o["chose_students"] = (t["students"][:12] if t else [])
        o["is_correct"] = o["id"] == question["correct_answer"]
        o["share_of_wrong"] = (round(t["count"] / total_wrong * 100)
                               if t and total_wrong else 0)

    wrong_sorted = sorted(
        [o for o in question["options"] if not o["is_correct"]],
        key=lambda o: -o["chose_count"])
    top = wrong_sorted[0] if wrong_sorted and wrong_sorted[0]["chose_count"] else None

    return jsonify({
        "base_question_id": base_id,
        **question,
        "attempts": attempts,
        "got_it_right": len(correct_students),
        "right_students": correct_students[:12],
        "got_it_wrong": total_wrong,
        # The headline: not how many failed, but what they agreed on.
        "converged_on": ({"option": top["id"], "count": top["chose_count"],
                          "share": top["share_of_wrong"]} if top else None),
        "capped": scanned >= MAX_SESSIONS_SCANNED,
    })