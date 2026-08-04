"""
NAADI AI — PARENT LEARNING  (parent_learning.py)
═══════════════════════════════════════════════════════════════════════════

WHAT THIS TAB IS FOR, AND HOW IT DIFFERS FROM HOME

Home is TIME-BOUND and carries judgement: this week, the last 4 weeks,
what needs you. Learning is SYLLABUS-BOUND and neutral: where are they in
the course, chapter by chapter, what is done and what is left.

The old version of this tab did neither. Four of its six blocks repeated
Home in a worse form -- a syllabus-coverage bar (Home's reading track,
minus the year split), a subjects chart (Home's subject accuracy), a
weekly time chart, and a "currently working on" card. Its own chapter
list showed ONLY chapters already opened, so it could never answer the
one question a syllabus view exists for: what has not been done yet.

    Home     "is this going all right, and is there anything to say?"
    Learning "has she done Genetics?"

Nothing on Home answers the second, and it is the most common thing a
parent wants to look up.

───────────────────────────────────────────────────────────────────────────
WHAT WAS REMOVED, AND WHY

`mastery` was the headline number on every chapter row and the whole
subject chart, under a subtitle that defined our own invented word
("Mastery is how well the concepts are understood"). It is the blended
metric that was deleted everywhere else. It is not in this file.

The coverage denominator counted chapter_metadata -- the question bank --
as the syllabus, with NO class filter, so class 11 and 12 were summed
against a universe of three chapters. Same pipeline-shown-as-progress
defect the home page had, worse. Reading counts come from the Concept
Studio syllabus here, testing counts from the question bank, and the two
are never added together.

───────────────────────────────────────────────────────────────────────────
THE DIFFICULTY LADDER IS TRANSLATED, NOT NAMED

OPD tracks a chapter through Foundation -> Skill Building -> Mastery ->
NEET Simulation -> Grand Mock -> Endurance. Of those, the student app
shows exactly one ("Grand Mock", a chip in test-engine.js). The other
five are internal names a parent could never discuss with their child.

What the ladder actually encodes is how hard the questions have got, and
that translates with no glossary at all: "working through the basics" ->
"on to harder questions" -> "full-length practice". The internal names do
not appear in any response from this file.

───────────────────────────────────────────────────────────────────────────
BRIDGING THE TWO ID SCHEMES

Concept Studio  {Subject}_{class}_{ChapterName}
Question bank   a different scheme entirely

rollup_signals already solved this by normalising the chapter NAME, the
only field both systems agree on. This file reuses build_studio_index and
match_studio_chapter rather than inventing a second bridge -- two bridges
would drift, and the first symptom would be a chapter showing "no tests
available" while its scores sat in the rollup.

A Studio chapter with no match is NOT an error. It is a chapter with
reading material and no question bank yet, which is a normal state during
content build-out, and it renders as exactly that.

───────────────────────────────────────────────────────────────────────────
NAMESPACE

Every route sits under /api/parent/v2/, and the registrar refuses to
start if one escapes. portal_backend.py owns /api/parent/child/<uid>/...
and Flask resolves duplicate rules to whichever blueprint registered
first, silently.
"""

from datetime import datetime, timezone, timedelta

from flask import Blueprint, jsonify

from portal_backend import (
    _db, _rollup, _pct, _days_since,
    chapter_meta, require_auth, require_role, resolve_child,
    IST_TZ,
)
from teacher_signals import canon_subject
from rollup_signals import build_studio_index, match_studio_chapter
from parent_syllabus import studio_chapters

parent_learning_bp = Blueprint("parent_learning", __name__)


# ═══════════════════════════════════════════════════════════════════════
# GATES AND LIMITS
# ═══════════════════════════════════════════════════════════════════════

MIN_CARDS = 5      # before a recall % is stated
MIN_Q_CHAPTER = 8      # before a chapter accuracy % is stated
OPEN_DAYS = 21     # what counts as "open right now"
MAX_OPEN = 5
TIME_WEEKS = 12
MAX_HISTORY = 10

SUBJECT_ORDER = ["Biology", "Physics", "Chemistry"]


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


def _iso(ts):
    d = _dt(ts)
    return d.isoformat() if d else ""


# ═══════════════════════════════════════════════════════════════════════
# THE DIFFICULTY LADDER, IN PLAIN ENGLISH
# ═══════════════════════════════════════════════════════════════════════

_STAGE_TEXT = {
    "Foundation": "Working through the basic questions",
    "Skill Building": "On to harder questions",
    "Mastery": "Mixed questions, exam style",
    "NEET Simulation": "Full exam-style sets",
    "Grand Mock": "Full-length mock papers",
    "Endurance": "Long practice sets, chapters mixed together",
}


def stage_text(phase):
    """Never returns the internal name. A parent reading 'Skill Building'
    learns nothing and cannot ask their child about it, because the
    student app does not use that word either.

    Public because parent_tests.py needs the same translation. One table,
    imported -- two copies would drift, and the first symptom would be
    the Learning tab and the Tests tab describing the same chapter with
    two different words.
    """
    return _STAGE_TEXT.get(_s(phase, 40), "")


# The private name is kept as an alias so the existing call sites and
# their tests keep working.
_stage_text = stage_text


# ═══════════════════════════════════════════════════════════════════════
# ONE PASS OVER REVISION PROGRESS
#
# Reading percentage, blocks opened vs finished, flashcards, and the last
# active date -- all four from one read, keyed by the Studio chapter id.
# ═══════════════════════════════════════════════════════════════════════

def _scan_studio(uid):
    out = {}
    try:
        for doc in _db().collection("users").document(uid) \
                .collection("revision_progress").stream():
            d = doc.to_dict() or {}
            cid = _s(d.get("chapter_id", "") or doc.id, 200)

            done = set(_seq(d.get("blocks_completed")))
            opened = set(_seq(d.get("blocks_opened")))

            seen = right = 0
            for _, fr in _dict(d.get("flashcard_results")).items():
                fr = _dict(fr)
                seen += _i(fr.get("seen"))
                right += _i(fr.get("correct"))

            out[cid] = {
                "pct": round(_f(d.get("completion_percentage")), 1),
                "blocks_done": len(done),
                # Touched but not finished is a student reading without
                # committing -- invisible in completion_percentage, and
                # the single most useful reading signal we have.
                "blocks_touched": len(done | opened),
                "blocks_total": _i(d.get("total_blocks")),
                "cards_seen": seen,
                "cards_right": right,
                "name": _s(d.get("chapter_name", ""), 160),
                "last_active": _iso(d.get("last_active")),
            }
    except Exception as e:
        print(f"[parent_learning] revision_progress scan failed for {uid}: {e}")
    return out


def _scan_time(uid):
    """Minutes inside tests, by ISO week.

    Deliberately labelled as time inside TESTS, not study time. We do not
    track time spent reading, and inventing it would be a number a parent
    could not check. The old tab got this right and the wording is kept.
    """
    weeks = {}
    try:
        for doc in _db().collection("test_sessions") \
                .where("user_id", "==", uid) \
                .where("status", "==", "completed").stream():
            s = doc.to_dict() or {}
            at = _dt(s.get("completed_at"))
            if at is None:
                continue
            secs = _i(s.get("time_taken_seconds"))
            if not (0 < secs < 3 * 3600):
                continue
            wk = at.astimezone(IST_TZ).strftime("%G-W%V")
            weeks[wk] = weeks.get(wk, 0) + secs
    except Exception as e:
        print(f"[parent_learning] test_sessions scan failed for {uid}: {e}")

    rows = [{"week": k, "label": "W" + k.split("-W")[-1],
             "minutes": round(v / 60)}
            for k, v in sorted(weeks.items())][-TIME_WEEKS:]
    return rows


# ═══════════════════════════════════════════════════════════════════════
# CHAPTER STATE
#
# Five states a parent recognises without a glossary. Never a percentage
# standing in for a state -- "42%" does not tell you whether a chapter has
# been tested at all.
# ═══════════════════════════════════════════════════════════════════════

def _state(reading, opd, has_bank):
    r = _dict(reading)
    o = _dict(opd)
    tests = _i(o.get("tests"))
    read_pct = _f(r.get("pct"))
    blocks_total = _i(r.get("blocks_total"))
    blocks_done = _i(r.get("blocks_done"))
    read_done = read_pct >= 100 or (blocks_total and blocks_done >= blocks_total)
    touched = bool(r) and (read_pct > 0 or _i(r.get("blocks_touched")) > 0)

    if o.get("complete"):
        return "finished"
    if tests > 0:
        return "testing"
    if read_done:
        return "read_only"
    if touched:
        return "reading"
    return "not_started"


STATE_LABEL = {
    "not_started": "Not started",
    "reading": "Reading",
    "read_only": "Read, not tested",
    "testing": "Testing",
    "finished": "Finished",
}


# ═══════════════════════════════════════════════════════════════════════
# THE MAP
# ═══════════════════════════════════════════════════════════════════════

MAP_INFO = (
    "Every chapter in the Concept Studio syllabus, grouped by subject and "
    "school year, in syllabus order. The colour is the chapter's state: "
    "not started, being read, read but not yet tested on, being tested, "
    "or finished. Tap any chapter to see how far through it they are. "
    "Chapters with no colour have not been opened -- that is what is left "
    "to do, and it is the reason the whole syllabus is shown rather than "
    "only the parts already started.")

OPEN_INFO = (
    "The chapters with activity in the last three weeks, and what is "
    "still unfinished in each. This is different from the day-by-day list "
    "on the Home page: that one says what happened, this one says what is "
    "left. A section counts as finished only when the student marks it "
    "done, so these are floors -- someone reading carefully without "
    "tapping will look further behind here than they are.")

TIME_INFO = (
    "Minutes spent inside tests each week. This is not total study time. "
    "We do not track time spent reading, and a number you could not check "
    "would be worse than no number at all. The Home page gives this "
    "week's figure; this is the shape over three months.")

CARDS_INFO = (
    "Concept Studio shows quick recall cards at the end of a section. "
    "This counts how many were shown and how many were answered "
    "correctly. It is practice, not a test, and nothing is graded on it.")


def _build_map(r, meta, syllabus, studio, level):
    idx = build_studio_index(meta)
    per_ch = _dict(r.get("per_chapter"))

    groups = []
    for sub in SUBJECT_ORDER:
        years = sorted(
            {l for (s2, l) in syllabus if s2 == sub},
            key=lambda l: (0, 0) if (level and l == level)
            else (1, -_i(l, 0)))
        for lvl in years:
            chapters = []
            counts = {k: 0 for k in STATE_LABEL}
            for ch in syllabus.get((sub, lvl), []):
                cid = _s(ch.get("id"), 200)
                name = _s(ch.get("name"), 160)
                reading = _dict(studio.get(cid))
                opd_id = match_studio_chapter(cid, name or reading.get("name"), idx)
                opd = _dict(per_ch.get(opd_id)) if opd_id else {}
                has_bank = bool(opd_id)
                st = _state(reading, opd, has_bank)
                counts[st] = counts.get(st, 0) + 1
                chapters.append({
                    "id": cid,
                    "name": name,
                    "number": _i(ch.get("number")),
                    "state": st,
                    "state_label": STATE_LABEL[st],
                    "reading_pct": round(_f(reading.get("pct")), 1) if reading else 0.0,
                    "tests": _i(opd.get("tests")),
                    "total_tests": _i(_dict(meta.get(opd_id)).get("total_tests")),
                    "has_bank": has_bank,
                })
            if not chapters:
                continue
            groups.append({
                "subject": sub,
                "class_level": lvl,
                "label": f"Class {lvl}" if lvl else "Other chapters",
                "is_own_year": bool(level) and lvl == level,
                "total": len(chapters),
                "counts": counts,
                "chapters": chapters,
            })
    return groups


def _open_now(r, meta, syllabus, studio, level):
    """Chapters touched in the last three weeks, stated as what REMAINS."""
    idx = build_studio_index(meta)
    per_ch = _dict(r.get("per_chapter"))
    cutoff = (datetime.now(timezone.utc) - timedelta(days=OPEN_DAYS)).isoformat()

    # Studio id -> (subject, class) so a row can be labelled.
    where = {}
    for (sub, lvl), chs in syllabus.items():
        for ch in chs:
            where[_s(ch.get("id"), 200)] = (sub, lvl, _s(ch.get("name"), 160))

    rows = []
    for cid, sp in _dict(studio).items():
        # _scan_studio builds these dicts, so in production they are
        # well-formed -- but this function is also reachable with a
        # partially-written document, and a chapter row is not worth
        # taking the whole tab down for.
        sp = _dict(sp)
        last = _s(sp.get("last_active", ""), 40)
        if not last or last < cutoff:
            continue
        cid = _s(cid, 200)
        sub, lvl, nm = where.get(cid, ("", "", ""))
        nm = nm or _s(sp.get("name"), 160) or cid
        opd_id = match_studio_chapter(cid, nm, idx)
        opd = _dict(per_ch.get(opd_id)) if opd_id else {}
        total_tests = _i(_dict(meta.get(opd_id)).get("total_tests"))
        rows.append({
            "id": cid,
            "name": nm,
            "subject": sub or canon_subject(_s(cid, 40).split("_")[0]),
            "class_level": lvl,
            "state": _state(sp, opd, bool(opd_id)),
            "blocks_done": _i(sp.get("blocks_done")),
            "blocks_touched": _i(sp.get("blocks_touched")),
            "blocks_total": _i(sp.get("blocks_total")),
            "reading_pct": round(_f(sp.get("pct")), 1),
            "tests": _i(opd.get("tests")),
            "total_tests": total_tests,
            "has_bank": bool(opd_id),
            "last_active": last,
            "days_ago": _days_since(last),
        })
    rows.sort(key=lambda x: x["last_active"], reverse=True)
    return rows[:MAX_OPEN]


# ═══════════════════════════════════════════════════════════════════════
# THE ENDPOINTS
# ═══════════════════════════════════════════════════════════════════════

@parent_learning_bp.route("/api/parent/v2/child/<student_uid>/learning",
                          methods=["GET"])
@require_auth
@require_role("parent")
@resolve_child
def parent_learning_v2(student_uid):
    """One rollup, one cached syllabus, two collection scans."""
    r = _rollup(student_uid) or {}
    meta = chapter_meta() or {}
    syllabus = studio_chapters()
    studio = _scan_studio(student_uid)
    level = _s(r.get("class_level", ""), 8).strip()

    groups = _build_map(r, meta, syllabus, studio, level)

    cards_seen = sum(_i(v.get("cards_seen")) for v in studio.values())
    cards_right = sum(_i(v.get("cards_right")) for v in studio.values())
    cards_ready = cards_seen >= MIN_CARDS

    return jsonify({
        "child": {
            "uid": student_uid,
            "name": r.get("name", "Student"),
            "first_name": (r.get("name", "Your child") or "").split(" ")[0],
            "class_level": level,
        },
        "map": {"groups": groups, "info": MAP_INFO,
                "states": STATE_LABEL},
        "open_now": {"items": _open_now(r, meta, syllabus, studio, level),
                     "info": OPEN_INFO},
        "cards": {
            "seen": cards_seen,
            "right": cards_right,
            "pct": _pct(cards_right, cards_seen) if cards_ready else None,
            "ready": cards_ready,
            "floor": MIN_CARDS,
            "info": CARDS_INFO,
        },
        "time": {"weeks": _scan_time(student_uid), "info": TIME_INFO},
    })


@parent_learning_bp.route(
    "/api/parent/v2/child/<student_uid>/chapter/<path:chapter_id>",
    methods=["GET"])
@require_auth
@require_role("parent")
@resolve_child
def parent_chapter_detail(student_uid, chapter_id):
    """Everything about one chapter, in one place.

    Split from the map endpoint on purpose: putting test history for
    eighty-three chapters into the map payload would make the tab slow to
    open for the sake of the one chapter a parent actually taps.
    """
    cid = _s(chapter_id, 200)
    r = _rollup(student_uid) or {}
    meta = chapter_meta() or {}
    syllabus = studio_chapters()
    idx = build_studio_index(meta)

    name, sub, lvl, number = "", "", "", 0
    for (s2, l2), chs in syllabus.items():
        for ch in chs:
            if _s(ch.get("id"), 200) == cid:
                name, sub, lvl = _s(ch.get("name"), 160), s2, l2
                number = _i(ch.get("number"))
                break
        if name:
            break

    reading = {}
    try:
        for doc in _db().collection("users").document(student_uid) \
                .collection("revision_progress").stream():
            d = doc.to_dict() or {}
            if _s(d.get("chapter_id", "") or doc.id, 200) != cid:
                continue
            done = set(_seq(d.get("blocks_completed")))
            opened = set(_seq(d.get("blocks_opened")))
            seen = right = 0
            for _, fr in _dict(d.get("flashcard_results")).items():
                fr = _dict(fr)
                seen += _i(fr.get("seen"))
                right += _i(fr.get("correct"))
            reading = {
                "pct": round(_f(d.get("completion_percentage")), 1),
                "blocks_done": len(done),
                "blocks_touched": len(done | opened),
                "blocks_total": _i(d.get("total_blocks")),
                "cards_seen": seen,
                "cards_right": right,
                "last_active": _iso(d.get("last_active")),
            }
            name = name or _s(d.get("chapter_name", ""), 160)
            break
    except Exception as e:
        print(f"[parent_learning] chapter reading read failed: {e}")

    opd_id = match_studio_chapter(cid, name, idx)
    opd = _dict(_dict(r.get("per_chapter")).get(opd_id)) if opd_id else {}
    m = _dict(meta.get(opd_id)) if opd_id else {}
    if not sub:
        sub = canon_subject(m.get("subject", "")) if m else ""
    if not lvl:
        lvl = _s(m.get("class", ""), 8).strip()

    history = []
    asked = right = 0
    if opd_id:
        try:
            for doc in _db().collection("test_sessions") \
                    .where("user_id", "==", student_uid) \
                    .where("chapter_id", "==", opd_id) \
                    .where("status", "==", "completed").stream():
                s = doc.to_dict() or {}
                at = _dt(s.get("completed_at"))
                qs = _seq(s.get("questions"))
                n_right = sum(1 for q in qs if _dict(q).get("is_correct"))
                n_asked = len(qs) or _i(s.get("total_questions"))
                # Totals come from EVERY session, not just the ten kept
                # for display -- otherwise a chapter with twenty tests
                # would report the accuracy of its last ten.
                asked += n_asked
                right += n_right
                pct = s.get("percentage")
                history.append({
                    "at": at.isoformat() if at else "",
                    "day": _day(at),
                    "right": n_right,
                    "asked": n_asked,
                    "pct": round(_f(pct), 1) if pct is not None else None,
                })
        except Exception as e:
            print(f"[parent_learning] chapter history read failed: {e}")
        history.sort(key=lambda h: h["at"], reverse=True)
        history = history[:MAX_HISTORY]

    seen = _i(reading.get("cards_seen"))
    right_cards = _i(reading.get("cards_right"))

    # ── WHY `asked` IS NOT READ FROM THE ROLLUP
    #
    # per_chapter carries chapter_name, subject, class, mastery,
    # coverage_pct, concepts_attempted, concepts_total, phase, difficulty,
    # tests, total_tests, last_test_pct, accuracy, complete, status.
    #
    # It does NOT carry a question count. The count lives inside
    # concept_mastery[*].questions_seen and is only ever summed up into
    # per_subject. Reading opd["questions"] therefore returned nothing,
    # every chapter fell below the gate, and a chapter with all eighteen
    # tests taken displayed "18 of 18 tests taken" directly above
    # "0 questions answered -- too few to say how it's going".
    #
    # Counting from the sessions above is exact, needs no rollup rebuild,
    # and is auditable: a parent can add up the rows in the history list
    # and get the same number. It also counts every question actually
    # asked, including repeats, which is what "asked" means in English.
    accuracy = _pct(right, asked) if asked else None
    acc_ready = asked >= MIN_Q_CHAPTER

    return jsonify({
        "id": cid,
        "name": name or cid,
        "number": number,
        "subject": sub,
        "class_level": lvl,
        "state": _state(reading, opd, bool(opd_id)),
        "state_label": STATE_LABEL[_state(reading, opd, bool(opd_id))],
        "reading": {
            "pct": _f(reading.get("pct")),
            "blocks_done": _i(reading.get("blocks_done")),
            "blocks_touched": _i(reading.get("blocks_touched")),
            "blocks_total": _i(reading.get("blocks_total")),
            "last_active": reading.get("last_active", ""),
            "started": bool(reading),
        },
        "cards": {
            "seen": seen, "right": right_cards,
            "pct": _pct(right_cards, seen) if seen >= MIN_CARDS else None,
            "ready": seen >= MIN_CARDS, "floor": MIN_CARDS,
            "info": CARDS_INFO,
        },
        "testing": {
            "has_bank": bool(opd_id),
            "tests": _i(opd.get("tests")),
            "total_tests": _i(m.get("total_tests")),
            "asked": asked,
            "right": right,
            "accuracy": accuracy if acc_ready else None,
            "ready": acc_ready,
            "floor": MIN_Q_CHAPTER,
            "last_pct": opd.get("last_test_pct"),
            # Translated, never named. See the header of this file.
            "stage": _stage_text(opd.get("phase")),
        },
        "history": history,
    })


# ═══════════════════════════════════════════════════════════════════════
# REGISTRATION
# ═══════════════════════════════════════════════════════════════════════

def register_parent_learning_routes(app):
    """Mount this blueprint, refusing to start if a route could collide."""
    app.register_blueprint(parent_learning_bp)

    bad = []
    for rule in app.url_map.iter_rules():
        s = str(rule)
        if not rule.endpoint.startswith("parent_learning."):
            continue
        if not s.startswith("/api/parent/v2/"):
            bad.append(s)
    if bad:
        raise RuntimeError(
            "parent_learning.py routes must sit under /api/parent/v2/ or "
            "they will silently collide with portal_backend.py. Offending: "
            + ", ".join(sorted(set(bad))))
    return app