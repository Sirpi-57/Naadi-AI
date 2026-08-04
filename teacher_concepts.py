"""
NAADI AI — TEACHER PORTAL · CONCEPTS TAB  (teacher_concepts.py)
═══════════════════════════════════════════════════════════════════════════

Concept-level, not student-level. Where the class is weak, what exactly is
confusing about it, and what to say in the lesson.

───────────────────────────────────────────────────────────────────────────
TWO PHASES, DELIBERATELY SEPARATE ROUTES

PHASE 1 · /v2/concepts/overview
    Everything that comes off student_rollups. The ranked weak list, the
    heat grid, concepts nobody has reached, the concepts the class HAD
    AND LOST, read-but-not-learned. One _roster() call -- fifty reads,
    the same fifty the rest of the portal already pays for.

PHASE 2 · /v2/concepts/insights
    Everything that needs test_sessions.questions[] or user_progress:
    the distractor the class converges on, the misconception clusters,
    what the class does not know stated as sentences, the difficulty
    cliff, whether reteaching worked. Read from the nightly aggregate
    written by concept_stats.py.

    A MISSING AGGREGATE IS A NORMAL STATE, not an error. The route
    returns `built: false` with an explanation and the page says so.
    Silently rendering an empty insights panel would read as "the class
    has no misconceptions", which is the opposite of the truth.

PHASE 1B · /v2/concepts/<concept_id>/brief
    The teaching brief. Assembles what the question bank already knows
    into something she could teach from. No new data, no generation --
    every field exists and none of it has ever reached a teacher.

───────────────────────────────────────────────────────────────────────────
ROLES

Subject teacher   her subjects, everywhere, including a 403 on a
                  hand-typed concept outside them.
Class teacher     a cross-subject summary and no concept depth. She
                  cannot reteach a concept; she can raise it with
                  whoever does. Four blocks, and padding it would mean
                  inventing metrics.

───────────────────────────────────────────────────────────────────────────
VOCABULARY

The same words as Home, Class and Students. "Getting right", never
accuracy or mastery. A concept below the sample gate has NO score, and
the client renders that as "not enough asked yet" -- never as 0%, which
is what made the old heatmap bleed red across a class doing fine.
"""

from collections import defaultdict

from flask import Blueprint, jsonify, request

from portal_backend import _db, chapter_meta, require_auth, require_role
from teacher_backend import _roster, resolve_class
from teacher_home import class_role_for
from teacher_signals import canon_subject

concepts_bp = Blueprint("teacher_concepts", __name__)

# A concept is not judged for the CLASS on fewer than this. Higher than
# the per-student floor of 8 on purpose: a class number pooled from three
# students who each saw five questions is not a class number.
MIN_CLASS_ANSWERS = 15
MIN_CLASS_STUDENTS = 3


def _student_gate(class_size):
    """How many students must have answered before a concept is scored.

    THE PILOT PROBLEM. A hard floor of three hides EVERYTHING from a
    class of two, which is not a gate doing its job -- it is a page that
    cannot be evaluated until the pilot grows, and a teacher who is told
    nothing learns nothing.

    My first attempt at this required EVERY student in the class, which
    tested worse than the hard floor it replaced: two students studying
    different chapters share almost no concepts, so a class of two
    scored ZERO while a class of one scored seventeen. A gate that gets
    stricter as the class grows from one to two is not a gate, it is an
    accident.

    So below the normal threshold the student gate drops to ONE and the
    ANSWERS floor does the work instead. Fifteen questions is fifteen
    questions however few people supplied them, and every row carries
    how many students are behind it, so "62% of 22 answers, 1 student"
    is a true and complete statement.

    What must not happen is showing that number as though it were a
    class pattern -- which is why the payload also sets small_class and
    the page says so at the top. A labelled small sample is honest; a
    hidden one is useless; a silently lowered one is the worst of the
    three.

    A FLAT THREE WAS STILL WRONG. In a class of exactly three it means
    every single student must have answered the same concept -- 100%
    participation -- which is not a reliability guard, it is a coverage
    guard, and it left a real 3-student pilot with ONE judgeable concept
    out of fifty-three.

    In a class of fifty, three students is six per cent. The threshold
    only means what it was meant to mean once the class is big enough
    for three to be a sample rather than a census. So:

        10 or more students   3   a small fraction, as intended
        3 to 9                2   more than one person, still reachable
        1 to 2                1   the answers floor does the work

    The 15-answer floor never moves at any of these.
    """
    n = int(class_size or 0)
    if n <= 0:
        return 1
    if n >= 10:
        return MIN_CLASS_STUDENTS
    return 2 if n >= MIN_CLASS_STUDENTS else 1

# "The class had it and lost it" needs more than one student, or it is
# one student's bad afternoon.
MIN_LOST_STUDENTS = 2

# Ranked lists. A teacher scrolls ten things, not four hundred.
TOP_WEAK = 12
TOP_LOST = 8
TOP_QUESTIONS = 10
TOP_FACTS = 10
CLASS_TEACHER_TOP = 3


def _s(v, limit=200):
    if v is None:
        return ""
    if isinstance(v, str):
        return v[:limit]
    if isinstance(v, (int, float, bool)):
        return str(v)
    return str(v)[:limit]


def _i(v, default=0):
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, (int, float)):
        return int(v)
    if isinstance(v, str):
        try:
            return int(float(v.strip()))
        except (ValueError, TypeError):
            return default
    return default


def _seq(v):
    if isinstance(v, (list, tuple)):
        return list(v)
    if isinstance(v, dict):
        return list(v.values())
    return []


def _pretty_chapter(cid, meta):
    """A title, or a readable version of a Studio-style id.

    A Studio id printed raw reads Biology_11_ANATOMY_OF_FLOWERING_PLANTS,
    which is a database key on a teacher's screen.
    """
    m = (meta or {}).get(cid)
    if isinstance(m, dict) and m.get("chapter_title"):
        return _s(m["chapter_title"], 120)
    parts = _s(cid, 160).split("_")
    if len(parts) > 2 and parts[1].isdigit():
        parts = parts[2:]
    return " ".join(w.capitalize() for w in parts if w) or _s(cid, 160)


def _subject_of(cid, meta):
    m = (meta or {}).get(cid)
    if isinstance(m, dict) and m.get("subject"):
        return canon_subject(m.get("subject"))
    return canon_subject(_s(cid, 40).split("_")[0])


# ═══════════════════════════════════════════════════════════════════════
# ROLE
# ═══════════════════════════════════════════════════════════════════════

def _role(class_key):
    u = getattr(request, "user_doc", None) or {}
    try:
        cr = class_role_for(u, class_key)
    except Exception as e:
        print(f"[concepts] role lookup failed for {class_key}: {e}")
        return "class_teacher", []
    if cr.get("role") == "subject_teacher":
        return "subject_teacher", [canon_subject(x)
                                   for x in (cr.get("subjects") or [])]
    return cr.get("role") or "class_teacher", []


def _in_scope(subject, mine):
    return not mine or canon_subject(subject) in set(mine)


# ═══════════════════════════════════════════════════════════════════════
# PHASE 1 · everything the rollups already know
# ═══════════════════════════════════════════════════════════════════════

def build_concepts(roster, meta, mine, levels, gate=None):
    """Pool per_concept across the class into one row per concept.

    per_concept is on every rollup already, so this is arithmetic over
    data the portal has loaded rather than a second read. weak_concepts
    is deliberately NOT used: it is capped at ten per student, so a
    concept moderately weak for the whole class but never in anyone's
    personal worst ten is invisible there.
    """
    gate = gate if gate is not None else _student_gate(len(roster))
    acc = defaultdict(lambda: {
        "name": "", "chapter_id": "", "answers": 0, "correct": 0.0,
        "students": 0, "below": 0, "lost": set(), "failures": 0,
    })

    for r in roster:
        per = r.get("per_concept") if isinstance(r.get("per_concept"), dict) else {}
        for cid, c in per.items():
            if not isinstance(c, dict):
                continue
            seen = _i(c.get("s"))
            if not seen:
                continue
            chid = _s(c.get("c"), 200)
            if not _in_scope(_subject_of(chid, meta), mine):
                continue
            a = acc[cid]
            a["name"] = a["name"] or _s(c.get("n"), 160)
            a["chapter_id"] = a["chapter_id"] or chid
            a["answers"] += seen
            pct = c.get("m")
            try:
                a["correct"] += float(pct or 0) / 100.0 * seen
            except (TypeError, ValueError):
                pass
            a["students"] += 1
            a["failures"] += _i(c.get("f"))
            try:
                if float(pct or 0) < 50:
                    a["below"] += 1
            except (TypeError, ValueError):
                pass

        # The v3 audit failures, already denormalised onto the rollup.
        ret = r.get("retention") if isinstance(r.get("retention"), dict) else {}
        for fr in _seq(ret.get("false_recoveries")):
            if not isinstance(fr, dict):
                continue
            cid = _s(fr.get("concept_id"), 200)
            chid = _s(fr.get("chapter_id"), 200)
            if not cid or not _in_scope(_subject_of(chid, meta), mine):
                continue
            a = acc[cid]
            a["lost"].add(_s(r.get("uid"), 80))
            a["chapter_id"] = a["chapter_id"] or chid

    rows = []
    for cid, a in acc.items():
        answers = a["answers"]
        # Blank, not zero. A percentage from four pooled answers is a coin
        # flip with a decimal point.
        pct = (round(a["correct"] / answers * 100, 1)
               if answers >= MIN_CLASS_ANSWERS
               and a["students"] >= gate else None)
        rows.append({
            "concept_id": cid,
            "name": a["name"] or cid,
            "chapter_id": a["chapter_id"],
            "chapter": _pretty_chapter(a["chapter_id"], meta),
            "subject": _subject_of(a["chapter_id"], meta),
            "getting_right": pct,
            "answers": answers,
            "students": a["students"],
            "students_below_half": a["below"],
            "lost_students": len(a["lost"]),
            "failures": a["failures"],
        })
    return rows


def unreached(roster, meta, mine, levels):
    """Concepts nobody in the class has answered a single question on.

    This is coverage, not weakness -- what is AHEAD. A page that only
    shows what has gone wrong cannot tell a teacher what she has not
    started.
    """
    touched = set()
    for r in roster:
        per = r.get("per_concept") if isinstance(r.get("per_concept"), dict) else {}
        for cid, c in per.items():
            if isinstance(c, dict) and _i(c.get("s")):
                touched.add(cid)

    by_chapter = defaultdict(lambda: {"total": 0, "missing": []})
    for chid, m in (meta or {}).items():
        if not isinstance(m, dict):
            continue
        if not _in_scope(canon_subject(m.get("subject")), mine):
            continue
        if levels and _s(m.get("class")).strip() not in ("", *levels):
            continue
        for c in _seq(m.get("concepts_summary")):
            if not isinstance(c, dict):
                continue
            cid = _s(c.get("concept_id"), 200)
            if not cid:
                continue
            b = by_chapter[chid]
            b["total"] += 1
            if cid not in touched:
                b["missing"].append(_s(c.get("concept_name"), 160) or cid)

    out = []
    for chid, b in by_chapter.items():
        if not b["missing"]:
            continue
        out.append({
            "chapter_id": chid,
            "chapter": _pretty_chapter(chid, meta),
            "subject": _subject_of(chid, meta),
            "total": b["total"],
            "not_reached": len(b["missing"]),
            "examples": sorted(b["missing"])[:5],
        })
    out.sort(key=lambda x: -x["not_reached"])
    return out


def not_tested(roster, meta, mine, levels):
    """Chapters in scope that NO student has taken a single test on.

    A class teacher cannot reteach a concept, but "nobody in 12-A has
    been tested on Thermodynamics all term" is exactly her business and
    nothing else in the portal says it.

    Distinguished from "read but not tested": this counts chapters with
    no testing at all, whether or not anyone has read them.
    """
    tested = set()
    read = set()
    for r in roster:
        per_ch = r.get("per_chapter") if isinstance(r.get("per_chapter"), dict) else {}
        for chid, pc in per_ch.items():
            if isinstance(pc, dict) and (_i(pc.get("tests")) > 0
                                         or _i(pc.get("concepts_attempted")) > 0):
                tested.add(chid)
        sig = r.get("signals") if isinstance(r.get("signals"), dict) else {}
        studio = sig.get("studio_by_chapter")
        if isinstance(studio, dict):
            for chid, v in studio.items():
                try:
                    if float(v or 0) > 0:
                        read.add(chid)
                except (TypeError, ValueError):
                    pass

    out = []
    for chid, m in (meta or {}).items():
        if not isinstance(m, dict):
            continue
        sub_name = canon_subject(m.get("subject"))
        if not _in_scope(sub_name, mine):
            continue
        if levels and _s(m.get("class")).strip() not in ("", *levels):
            continue
        if chid in tested:
            continue
        out.append({
            "chapter_id": chid,
            "chapter": _pretty_chapter(chid, meta),
            "subject": sub_name,
            # Read but never tested is a sharper signal than untouched.
            "has_been_read": chid in read,
        })
    out.sort(key=lambda x: (not x["has_been_read"], x["subject"], x["chapter"]))
    return out


def read_not_learned(roster, meta, mine):
    """Chapters the class has READ where the concepts are still weak.

    Chapter-level and stated as such -- reading is not tracked per
    concept, and pretending otherwise would be a made-up number. The
    distinction still matters: a class failing with nothing read needs
    telling to read, one failing having read it needs teaching.
    """
    read = defaultdict(int)
    weak = defaultdict(lambda: {"sum": 0.0, "n": 0})
    for r in roster:
        sig = r.get("signals") if isinstance(r.get("signals"), dict) else {}
        studio = sig.get("studio_by_chapter")
        if isinstance(studio, dict):
            for chid, v in studio.items():
                try:
                    if float(v or 0) > 0 and _in_scope(
                            _subject_of(chid, meta), mine):
                        read[chid] += 1
                except (TypeError, ValueError):
                    pass
        per_ch = r.get("per_chapter") if isinstance(r.get("per_chapter"), dict) else {}
        for chid, pc in per_ch.items():
            if not isinstance(pc, dict):
                continue
            acc = pc.get("accuracy")
            if acc is None or not _in_scope(_subject_of(chid, meta), mine):
                continue
            try:
                weak[chid]["sum"] += float(acc)
                weak[chid]["n"] += 1
            except (TypeError, ValueError):
                pass

    out = []
    for chid, n in read.items():
        w = weak.get(chid)
        if not w or w["n"] < MIN_LOST_STUDENTS:
            continue
        avg = round(w["sum"] / w["n"], 1)
        if avg >= 55:
            continue
        out.append({
            "chapter_id": chid,
            "chapter": _pretty_chapter(chid, meta),
            "subject": _subject_of(chid, meta),
            "students_read": n,
            "getting_right": avg,
        })
    out.sort(key=lambda x: x["getting_right"])
    return out


@concepts_bp.route("/api/teacher/class/<class_key>/v2/concepts/overview",
                   methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_class
def v2_concepts_overview(class_key):
    role, mine = _role(class_key)
    roster = _roster(class_key)
    meta = chapter_meta()
    levels = {_s(r.get("class_level")).strip() for r in roster
              if _s(r.get("class_level")).strip()}

    gate = _student_gate(len(roster))
    lost_gate = max(1, min(MIN_LOST_STUDENTS, len(roster)))
    small = len(roster) < MIN_CLASS_STUDENTS

    rows = build_concepts(roster, meta, mine, levels, gate)
    scored = [c for c in rows if c["getting_right"] is not None]
    scored.sort(key=lambda c: (c["getting_right"], -c["answers"]))
    lost = sorted([c for c in rows if c["lost_students"] >= lost_gate],
                  key=lambda c: -c["lost_students"])

    # The class teacher gets a cross-subject summary and no depth.
    by_subject = defaultdict(lambda: {"judgeable": 0, "weak": 0, "lost": 0,
                                      "not_reached": 0, "not_tested": 0,
                                      "concepts": 0})
    for c in rows:
        b = by_subject[c["subject"]]
        b["concepts"] += 1
        if c["getting_right"] is not None:
            b["judgeable"] += 1
            if c["getting_right"] < 50:
                b["weak"] += 1
        if c["lost_students"] >= lost_gate:
            b["lost"] += 1

    nt = not_tested(roster, meta, mine, levels)
    un = unreached(roster, meta, mine, levels)
    for u in un:
        by_subject[u["subject"]]["not_reached"] += u["not_reached"]

    for x in nt:
        by_subject[x["subject"]]["not_tested"] = \
            by_subject[x["subject"]].get("not_tested", 0) + 1

    subjects = [dict(v, subject=k,
                     weakest=[c for c in scored if c["subject"] == k
                              ][:CLASS_TEACHER_TOP])
                for k, v in sorted(by_subject.items())]

    return jsonify({
        "role": role,
        "my_subjects": mine,
        "scope_label": (", ".join(mine) if role == "subject_teacher" and mine
                        else "All subjects"),
        "students": len(roster),

        # The spine.
        "weakest": scored[:TOP_WEAK],
        # The same rows, unranked, for the grid toggle. One payload, two
        # presentations -- a second endpoint would drift.
        "all_concepts": rows,
        "lost": lost[:TOP_LOST],
        "unreached": un[:12],
        # A class teacher's own question: what is nobody being tested on?
        "not_tested": nt[:24],
        "not_tested_total": len(nt),
        "read_not_learned": read_not_learned(roster, meta, mine)[:8],
        "subjects": subjects,

        # The gates ACTUALLY applied, not the constants. The page shows
        # these, so a teacher can see why something is or is not there.
        "gates": {"answers": MIN_CLASS_ANSWERS, "students": gate,
                  "lost_students": lost_gate,
                  "normal_students": MIN_CLASS_STUDENTS},
        # Too few people for any of this to be a CLASS pattern. The
        # numbers are real; what they describe is two students.
        "small_class": small,
        "counts": {"concepts": len(rows), "judgeable": len(scored),
                   "weak": sum(1 for c in scored if c["getting_right"] < 50)},
    })


# ═══════════════════════════════════════════════════════════════════════
# PHASE 2 · read the nightly aggregate
# ═══════════════════════════════════════════════════════════════════════

@concepts_bp.route("/api/teacher/class/<class_key>/v2/concepts/insights",
                   methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_class
def v2_concepts_insights(class_key):
    """The four things that need more than the rollups.

    Returns `built: false` when concept_stats.py has not run. That is a
    normal state on a fresh install and it must SAY so -- an empty
    insights panel reads as "this class has no misconceptions", which is
    the opposite of the truth.
    """
    role, mine = _role(class_key)
    if role != "subject_teacher":
        # A class teacher cannot reteach a concept. Rather than show her
        # depth she cannot act on, this says whose job it is.
        return jsonify({"built": True, "role": role, "for_class_teacher": True,
                        "note": "Concept detail is on the subject teacher's "
                                "page. Raise a concept with them from the "
                                "summary."})

    subject = canon_subject(request.args.get("subject") or (mine[0] if mine else ""))
    if not _in_scope(subject, mine):
        return jsonify({"error": "That subject is not yours."}), 403

    db = _db()
    ref = db.collection("class_concept_stats").document(class_key)
    meta_doc = ref.get()
    if not meta_doc.exists:
        return jsonify({
            "built": False, "subject": subject,
            "why": "The nightly concept analysis has not run for this class yet.",
        })

    head = meta_doc.to_dict() or {}
    try:
        cdoc = ref.collection("concepts").document(subject).get()
        qdoc = ref.collection("questions").document(subject).get()
    except Exception as e:
        print(f"[concepts] aggregate read failed for {class_key}/{subject}: {e}")
        return jsonify({"built": False, "subject": subject,
                        "why": "The concept analysis could not be read."})

    concepts = _seq((cdoc.to_dict() or {}).get("concepts")) if cdoc.exists else []
    questions = _seq((qdoc.to_dict() or {}).get("questions")) if qdoc.exists else []
    concepts = [c for c in concepts if isinstance(c, dict)]
    questions = [q for q in questions if isinstance(q, dict)]

    if not concepts and not questions:
        return jsonify({
            "built": False, "subject": subject,
            "built_at": _s(head.get("built_at"), 40),
            "why": f"The analysis ran but found no {subject} test data yet.",
        })

    # ── B2 · misconception clusters ──
    misconceptions = []
    for c in concepts:
        for m in _seq(c.get("misconceptions")):
            if not isinstance(m, dict) or not m.get("text"):
                continue
            misconceptions.append({
                "concept": _s(c.get("name"), 160),
                "concept_id": _s(c.get("concept_id"), 200),
                "chapter": _s(c.get("chapter"), 120),
                "students": _i(m.get("students")),
                "text": _s(m.get("text"), 400),
                "explanation": _s(m.get("explanation"), 600),
                "trick": _s(m.get("trick"), 300),
                "getting_right": c.get("pct"),
            })
    misconceptions.sort(key=lambda m: -m["students"])

    # ── B1 · the distractor the class converges on ──
    converging = [q for q in questions if isinstance(q.get("top_wrong"), dict)]
    converging.sort(key=lambda q: -_i((q.get("top_wrong") or {}).get("students")))

    # ── B4 · what the class does not know, as sentences ──
    facts = []
    for c in concepts:
        for f in _seq(c.get("facts")):
            if not isinstance(f, dict) or not f.get("fact"):
                continue
            raw_fact = _s(f.get("fact"), 240)
            facts.append({
                # Question-bank prose: C<sub>n</sub>H<sub>2n</sub> is real.
                "fact": _q(raw_fact),
                "concept": _s(c.get("name"), 160),
                "concept_id": _s(c.get("concept_id"), 200),
                "chapter": _s(c.get("chapter"), 120),
                "wrong": _i(f.get("wrong")), "asked": _i(f.get("asked")),
                # The questions that test this fact, so the row can be
                # opened into them. Matched on the fact string, which the
                # aggregate records on every question.
                "base_ids": [_s(q.get("base_id"), 200) for q in questions
                             if _s(q.get("fact"), 240) == raw_fact][:4],
            })
    facts.sort(key=lambda f: -f["wrong"])

    # ── B5 · the difficulty cliff ──
    cliff = []
    for c in concepts:
        d = c.get("by_difficulty")
        if not isinstance(d, dict):
            continue
        e = (d.get("Easy") or {}).get("pct")
        h = ((d.get("Hard") or {}).get("pct")
             or (d.get("Medium") or {}).get("pct"))
        if e is None or h is None:
            continue
        try:
            drop = round(float(e) - float(h), 1)
        except (TypeError, ValueError):
            continue
        if drop < 25:
            continue
        cliff.append({"concept": _s(c.get("name"), 160),
                      "concept_id": _s(c.get("concept_id"), 200),
                      "chapter": _s(c.get("chapter"), 120),
                      "easy": e, "hard": h, "drop": drop,
                      "hard_label": "Hard" if (d.get("Hard") or {}).get("pct")
                                    is not None else "Medium"})
    cliff.sort(key=lambda x: -x["drop"])

    # ── B6 · trap questions ──
    traps = [q for q in questions if q.get("wrong_pct") is not None
             and _i(q.get("students")) >= MIN_CLASS_STUDENTS
             and float(q["wrong_pct"]) >= 60]

    # ── B8 · did reteaching work ──
    trends = [{"concept": _s(c.get("name"), 160),
               "concept_id": _s(c.get("concept_id"), 200),
               "chapter": _s(c.get("chapter"), 120),
               "points": _seq(c.get("trend"))}
              for c in concepts if len(_seq(c.get("trend"))) >= 3]
    trends.sort(key=lambda t: (t["points"][-1].get("avg", 0)
                               if isinstance(t["points"][-1], dict) else 0))

    return jsonify({
        "built": True, "role": role, "subject": subject,
        "available_subjects": mine,
        "built_at": _s(head.get("built_at"), 40),
        "students": _i(head.get("students")),
        "sessions_scanned": _i(head.get("sessions_scanned")),
        "misconceptions": misconceptions[:8],
        "converging": converging[:TOP_QUESTIONS],
        "facts": facts[:TOP_FACTS],
        "cliff": cliff[:6],
        "traps": traps[:TOP_QUESTIONS],
        "trends": trends[:6],
        "min_convergence": _i((qdoc.to_dict() or {}).get("min_convergence"), 3)
                           if qdoc.exists else 3,
    })


# ═══════════════════════════════════════════════════════════════════════
# ONE QUESTION, ON DEMAND
# ═══════════════════════════════════════════════════════════════════════

@concepts_bp.route("/api/teacher/class/<class_key>/v2/concepts/"
                   "question/<path:base_id>", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_class
def v2_concept_question(class_key, base_id):
    """Every option of one question, with how many students chose each.

    LAZY ON PURPOSE. Storing every option's wording and rationale in the
    nightly aggregate would multiply its size for data a teacher opens
    two or three of per visit. The aggregate keeps the COUNTS; the
    WORDING comes from the question bank when she asks for it, and the
    two are joined here on the option id.
    """
    role, mine = _role(class_key)
    db = _db()
    meta = chapter_meta()

    try:
        # base_question_id lives in meta_data, not at the top level --
        # the same nesting that broke the brief. A top-level query
        # matches nothing and every row 404s.
        docs = list(db.collection("questions")
                      .where("meta_data.base_question_id", "==", base_id)
                      .limit(6).stream())
    except Exception as e:
        print(f"[concepts] question read failed for {base_id}: {e}")
        return jsonify({"error": "Could not load that question."}), 500
    if not docs:
        return jsonify({"error": "That question is no longer in the bank."}), 404

    # v1 is the one the class saw first; later variations are the audit.
    raw = sorted((d.to_dict() or {} for d in docs),
                 key=lambda x: _i((x.get("meta_data") or {})
                                  .get("variation_number"), 9))
    q = raw[0]
    md = q.get("meta_data") if isinstance(q.get("meta_data"), dict) else {}
    con = q.get("content") if isinstance(q.get("content"), dict) else {}
    sol = q.get("solution") if isinstance(q.get("solution"), dict) else {}
    chid = _s(md.get("chapter_id"), 200)
    subject = _subject_of(chid, meta)
    if not _in_scope(subject, mine):
        return jsonify({"error": "That question is not in your subjects."}), 403

    picks, stat = {}, {}
    try:
        qdoc = (db.collection("class_concept_stats").document(class_key)
                  .collection("questions").document(subject).get())
        if qdoc.exists:
            for row in _seq((qdoc.to_dict() or {}).get("questions")):
                if isinstance(row, dict) and _s(row.get("base_id"), 200) == base_id:
                    picks = (row.get("picks")
                             if isinstance(row.get("picks"), dict) else {})
                    stat = row
                    break
    except Exception as e:
        print(f"[concepts] question stats read failed for {base_id}: {e}")

    opts = [o for o in _seq(con.get("options")) if isinstance(o, dict)]
    correct = next((_s(o.get("id"), 8) for o in opts if o.get("is_correct")), "")
    total_wrong = sum(_i(v) for v in picks.values())
    asked = _i(stat.get("asked"), None)
    right = (asked - _i(stat.get("wrong"))) if asked is not None else None

    def _opt(o):
        oid = _s(o.get("id"), 8)
        wrong_n = _i(picks.get(oid))
        return {
            "id": oid,
            "text": _q(o.get("text")),
            "why": _q(o.get("why_wrong_explanation") or o.get("explanation")
                      or o.get("why_correct_explanation")),
            "is_correct": oid == correct,
            # `picks` records only WRONG answers, so the correct
            # option's count is derived rather than looked up.
            "picked": right if oid == correct else wrong_n,
            "share": (round(wrong_n / total_wrong * 100)
                      if total_wrong and oid != correct else None),
        }

    return jsonify({
        "base_id": base_id,
        "concept": _s(md.get("concept_name"), 160),
        "concept_id": _s(md.get("concept_id"), 200),
        "chapter": _pretty_chapter(chid, meta),
        "subject": subject,
        "fact": _q(md.get("tested_fact")),
        "difficulty": _s(md.get("difficulty") or q.get("difficulty"), 20),
        "question": _q(con.get("question_text")),
        "correct": correct,
        "explanation": _q(sol.get("detailed_explanation")
                          or sol.get("static_explanation")),
        "options": [_opt(o) for o in opts],
        "asked": asked,
        "wrong": _i(stat.get("wrong"), None),
        "students": _i(stat.get("students"), None),
        "has_stats": bool(stat),
        "variations": len(raw),
    })


# ═══════════════════════════════════════════════════════════════════════
# THE TEACHING BRIEF
# ═══════════════════════════════════════════════════════════════════════

def _q(text):
    """Question-bank text: entities and <sub>/<sup> are real. Flagged so
    the client routes it through its markup-safe renderer."""
    return {"t": _s(text, 800), "html": True}


@concepts_bp.route("/api/teacher/class/<class_key>/v2/concepts/"
                   "<path:concept_id>/brief", methods=["GET"])
@require_auth
@require_role("teacher")
@resolve_class
def v2_concept_brief(class_key, concept_id):
    """Everything the question bank knows about one concept, assembled
    into something a teacher could teach from.

    No new data and nothing generated. detailed_explanation, key_points,
    ncert_page_quote, common_mistakes and the per-option explanations
    have all been in the bank since the questions were uploaded, and none
    of them has ever reached a teacher.
    """
    role, mine = _role(class_key)
    db = _db()
    meta = chapter_meta()

    try:
        docs = list(db.collection("questions")
                      .where("meta_data.concept_id", "==", concept_id)
                      .limit(40).stream())
    except Exception as e:
        print(f"[concepts] brief read failed for {concept_id}: {e}")
        return jsonify({"error": "Could not load that concept."}), 500

    if not docs:
        return jsonify({"error": "No questions found for that concept."}), 404

    raw = [d.to_dict() or {} for d in docs]
    md = raw[0].get("meta_data") if isinstance(raw[0].get("meta_data"), dict) else {}
    chid = _s(md.get("chapter_id"), 200)
    subject = _subject_of(chid, meta)

    # A hand-typed concept id must not be a way past the scope the rest
    # of the tab enforces.
    if not _in_scope(subject, mine):
        return jsonify({"error": "That concept is not in your subjects."}), 403

    # THE DOCUMENT IS NESTED, and I read every field off the top level.
    #
    #   meta_data { concept_id, concept_name, variation_number, tested_fact }
    #   content   { question_text, question_type, options[], list1, list2 }
    #   solution  { static_explanation, detailed_explanation, key_points,
    #               common_mistakes, ncert_page_quote, source_verbatim }
    #
    # So the brief rendered a concept name, a v1 chip and nothing else:
    # no stem, no options, and "Answer —" because there is no top-level
    # correct_answer at all. The correct option is the one flagged
    # is_correct inside content.options, exactly as backend.py:3371
    # finds it at grading time.
    facts, points, mistakes, ncert, questions = [], [], [], [], []
    for q in raw:
        qmd = q.get("meta_data") if isinstance(q.get("meta_data"), dict) else {}
        con = q.get("content") if isinstance(q.get("content"), dict) else {}
        sol = q.get("solution") if isinstance(q.get("solution"), dict) else {}

        f = _s(qmd.get("tested_fact"), 240)
        if f and f not in facts:
            facts.append(f)
        for k in _seq(sol.get("key_points")):
            t = _s(k, 240)
            if t and t not in points:
                points.append(t)
        for m in _seq(sol.get("common_mistakes")):
            t = _s(m if isinstance(m, str) else (m or {}).get("text"), 240)
            if t and t not in mistakes:
                mistakes.append(t)
        n = _s(sol.get("ncert_page_quote") or sol.get("source_verbatim"), 600)
        if n and n not in ncert:
            ncert.append(n)

        opts = [o for o in _seq(con.get("options")) if isinstance(o, dict)]
        correct = next((_s(o.get("id"), 8) for o in opts if o.get("is_correct")), "")

        questions.append({
            "base_id": _s(q.get("base_question_id")
                          or qmd.get("base_question_id"), 200),
            "variation": _i(qmd.get("variation_number"), None),
            "difficulty": _s(qmd.get("difficulty") or q.get("difficulty"), 20),
            "question": _q(con.get("question_text")),
            "correct": correct,
            "explanation": _q(sol.get("detailed_explanation")
                              or sol.get("static_explanation")),
            # Every distractor's own why-it-is-wrong. The correct option
            # uses `explanation`; the wrong ones use why_wrong_explanation
            # and fall back to `explanation` -- the same order
            # backend.py:3389 uses when it builds this for a student.
            "options": [{
                "id": _s(o.get("id"), 8),
                "text": _q(o.get("text")),
                "why": _q(o.get("why_wrong_explanation")
                          or o.get("explanation")
                          or o.get("why_correct_explanation")),
            } for o in opts],
        })

    # ── how the class actually answered these ──
    # From the nightly aggregate, keyed by base_question_id. Absent
    # aggregate means absent counts, never an error: the brief is
    # useful without them and must not depend on a job having run.
    stats = {}
    try:
        qdoc = (db.collection("class_concept_stats").document(class_key)
                  .collection("questions").document(subject).get())
        if qdoc.exists:
            for q in _seq((qdoc.to_dict() or {}).get("questions")):
                if isinstance(q, dict) and q.get("base_id"):
                    stats[_s(q["base_id"], 200)] = q
    except Exception as e:
        print(f"[concepts] brief stats read failed for {class_key}: {e}")

    for q in questions:
        st = stats.get(q["base_id"])
        if not st:
            continue
        picks = st.get("picks") if isinstance(st.get("picks"), dict) else {}
        total_wrong = sum(_i(v) for v in picks.values())
        q["asked"] = _i(st.get("asked"), None)
        q["wrong"] = _i(st.get("wrong"), None)
        q["students"] = _i(st.get("students"), None)
        q["wrong_pct"] = st.get("wrong_pct")
        # Per option: how many chose it, and what share of the wrong
        # answers that was. The correct option's count is the ones who
        # got it right, so it is reported separately.
        for o in q["options"]:
            n = _i(picks.get(o["id"]))
            o["picked"] = n
            o["share"] = (round(n / total_wrong * 100)
                          if total_wrong and o["id"] != q["correct"] else None)
        q["has_stats"] = True

    # Worst first when we know, then by variation. A teacher opening a
    # brief wants the question they are losing marks on, not question 1.
    questions.sort(key=lambda x: (-(x.get("wrong_pct") or 0),
                                  x["variation"] or 99,
                                  {"Easy": 0, "Medium": 1, "Hard": 2}
                                  .get(x["difficulty"], 3)))

    return jsonify({
        "concept_id": concept_id,
        "name": _s(md.get("concept_name"), 160) or concept_id,
        "chapter_id": chid,
        "chapter": _pretty_chapter(chid, meta),
        "subject": subject,
        # tested_fact is question-bank prose and really does contain
        # C<sub>n</sub>H<sub>2n</sub>. Rendering it through esc() printed
        # the tags on screen.
        "what_it_tests": [_q(f) for f in facts[:8]],
        "key_points": [_q(k) for k in points[:8]],
        "common_mistakes": [_q(m) for m in mistakes[:8]],
        "ncert": [_q(n) for n in ncert[:3]],
        "questions": questions[:12],
        "question_count": len(raw),
        "has_stats": any(q.get("has_stats") for q in questions),
    })


# ═══════════════════════════════════════════════════════════════════════
# REGISTRATION
# ═══════════════════════════════════════════════════════════════════════

def register_concept_routes(app):
    """Register, then prove nothing here shadows an existing rule.

    teacher_backend.py already owns /api/teacher/class/<key>/concepts.
    Flask resolves a duplicate silently to whichever blueprint registered
    first and serves the wrong payload with a 200.
    """
    app.register_blueprint(concepts_bp)

    bad = [str(r) for r in app.url_map.iter_rules()
           if r.endpoint.startswith("teacher_concepts.") and "/v2/" not in str(r)]
    if bad:
        raise RuntimeError(
            "teacher_concepts.py routes must sit under /v2/ or they will "
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