"""
NAADI AI — TEACHER FLAG ENGINE  (teacher_signals.py)
═══════════════════════════════════════════════════════════════════════════

THE ONE RULE

Every string this file produces must be readable by a teacher who has
never opened the app, never read a manual, and has forty seconds between
periods. That means:

    NO  "Retention 48%"          — she does not know what retention is
    NO  "Mastery below threshold" — threshold of what, set by whom
    NO  "3 false recoveries"      — this is our word, not hers
    NO  "OPD coverage 22%"        — OPD is our product's name for tests

    YES "Got 6 questions right, then got them wrong when asked again"
    YES "Scored under 40% in his last 4 Chemistry tests"
    YES "Answering in 19 seconds per question — the class takes 47"

The sentence IS the alert. There is no severity badge to decode, no
colour scale to learn, no composite score. If a teacher cannot act on the
sentence alone, the flag should not exist.

───────────────────────────────────────────────────────────────────────────
WHY FLAGS ARE GATED AND CAPPED

Two failure modes destroy a dashboard like this, and both are quiet:

1.  FIRING TOO EARLY. A student three days into the app has one test and
    a 30%. A naive threshold flags them as failing. The teacher chases a
    child who is simply new, loses trust in the page, and stops opening
    it. So every rule below carries a minimum sample, and NOTHING fires
    without it. `_ready()` is the gate.

2.  FIRING TOO OFTEN. In week one of a rollout, half a class trips some
    threshold. Twenty-five name cards is not a to-do list, it is wallpaper.
    So the class teacher's page caps visible flags and states the count
    behind them — and when the count is high, that is a CLASS problem
    that belongs in the subject cards, not twenty-five individual cards.

───────────────────────────────────────────────────────────────────────────
SEVERITY

An integer, 0-100, used only for ORDERING. It is never shown to a teacher.
Ordering is by how time-critical the intervention is, not by how bad the
number looks: a student who has silently stopped opening the app for two
weeks outranks a student who is present and scoring 38%, because the
second one is visible in class every day and the first one is not.
"""

# ── Gates ──────────────────────────────────────────────────────────────
MIN_TESTS = 3           # before any score-based sentence
MIN_PACE_Q = 20         # before any pace sentence
INACTIVE_DAYS = 7       # before "hasn't opened"
LOW_SCORE = 40          # the "under 40%" line
CLASS_PACE_FLOOR = 0.55  # flag at <55% of the class's own median pace

# Subjects are matched loosely because chapter_metadata has historically
# stored "Biology", "biology" and "BIO" in the same collection.
_SUBJECT_ALIASES = {
    "bio": "Biology", "biology": "Biology", "botany": "Biology",
    "zoology": "Biology",
    "phy": "Physics", "physics": "Physics",
    "chem": "Chemistry", "chemistry": "Chemistry",
}


def canon_subject(s):
    """Normalise a subject string. Unknown/blank → 'Unassigned'."""
    if not s:
        return "Unassigned"
    return _SUBJECT_ALIASES.get(str(s).strip().lower(), str(s).strip())


def _first_name(name):
    return (name or "Student").strip().split(" ")[0] or "Student"


def _ready(sig, kind):
    """Is there enough evidence for this KIND of claim?

    Returning False is a real answer — 'we have not asked this student
    enough questions to say' — and it is always the right answer when the
    alternative is a confident sentence built on two data points.
    """
    if not sig:
        return False
    if kind == "score":
        return (sig.get("tests_in_window") or 0) >= MIN_TESTS
    if kind == "pace":
        return (sig.get("pace_sample") or 0) >= MIN_PACE_Q
    return True


# ═══════════════════════════════════════════════════════════════════════
# THE RULES
#
# Each returns a flag dict or None:
#   {text, severity, subject, kind, share}
#
#   text      the sentence the teacher reads. Complete, with the number in it.
#   subject   which subject teacher this routes to, or "" for the class teacher.
#   kind      stable id, for filtering and for the subject-teacher view.
#   share     a one-line version for WhatsApp, with the student's full name.
# ═══════════════════════════════════════════════════════════════════════

def _rule_never_started(r, sig, ctx):
    if (r.get("tests_completed") or 0) > 0:
        return None
    days = r.get("_days_since_active")
    if days is not None and days < 3:
        return None          # just signed up; not a problem yet
    return {
        "kind": "never_started",
        "severity": 88,
        "subject": "",
        "text": "Has not taken a single test yet.",
        "share": "has not taken a single test on NAADI yet.",
    }


def _rule_inactive(r, sig, ctx):
    days = r.get("_days_since_active")
    if days is None or days < INACTIVE_DAYS:
        return None
    # Inactivity outranks a bad score: a student in the room scoring 38%
    # is visible to the teacher every day. One who has quietly stopped
    # opening the app is not, and nobody else will notice.
    sev = 95 if days >= 14 else 82
    return {
        "kind": "inactive",
        "severity": sev,
        "subject": "",
        "text": f"Hasn't opened the app in {days} days.",
        "share": f"has not opened NAADI in {days} days.",
    }


def _rule_low_streak(r, sig, ctx):
    if not _ready(sig, "score"):
        return None
    streak = sig.get("recent_low_streak") or 0
    if streak < 3:
        return None
    sub = canon_subject(sig.get("low_streak_subject"))
    where = f" {sub}" if sub != "Unassigned" else ""
    return {
        "kind": "low_scores",
        "severity": 78 + min(streak, 6),
        "subject": sub if sub != "Unassigned" else "",
        "text": f"Scored under {LOW_SCORE}% in the last {streak}{where} tests.",
        "share": f"scored under {LOW_SCORE}% in the last {streak}{where} tests.",
    }


def _rule_rushing(r, sig, ctx):
    """Answering far faster than the class.

    Compared against the CLASS's own median, not a fixed constant. A
    number like '20 seconds is too fast' is wrong for a one-mark recall
    question and wrong again for a numerical — but a student at a third
    of what their own classmates take, on the same material, is a real
    signal in any subject.
    """
    if not _ready(sig, "pace"):
        return None
    mine = sig.get("pace_seconds_per_q")
    med = ctx.get("class_pace_median")
    if mine is None or not med or med <= 0:
        return None
    if mine >= med * CLASS_PACE_FLOOR:
        return None
    return {
        "kind": "rushing",
        "severity": 70,
        "subject": "",
        "text": (f"Answering in {mine:.0f} seconds per question — "
                 f"the class takes {med:.0f}."),
        "share": (f"is answering in {mine:.0f}s per question vs the class "
                  f"average of {med:.0f}s — may be guessing."),
    }


def _rule_forgetting(r, sig, ctx):
    """The v3 audit failure, said in English.

    This is the product's sharpest signal and it has never been legible.
    'False recovery' means: the student got a question wrong, was shown
    the explanation, got a near-identical question right minutes later,
    and then failed a differently-trapped version of the same idea three
    tests on. They memorised an answer; they did not learn an idea.

    A teacher does not need the mechanism. She needs the sentence.
    """
    ret = r.get("retention", {}) or {}
    n = int(ret.get("false_recovery_count", 0) or 0)
    if n < 3:
        return None
    subs = set()
    for fr in (ret.get("false_recoveries", []) or [])[:6]:
        cid = fr.get("chapter_id", "")
        s = canon_subject((ctx.get("meta", {}).get(cid, {}) or {}).get("subject"))
        if s != "Unassigned":
            subs.add(s)
    sub = subs.pop() if len(subs) == 1 else ""
    return {
        "kind": "forgetting",
        "severity": 72,
        "subject": sub,
        "text": (f"Got {n} questions right, then got the same ideas wrong "
                 f"when asked again later."),
        "share": (f"answered {n} questions correctly but failed them when "
                  f"re-asked later — likely memorising, not understanding."),
    }


def _rule_tested_blind(r, sig, ctx):
    n = int(sig.get("tested_without_reading") or 0)
    if n < 3:
        return None
    return {
        "kind": "tested_blind",
        "severity": 60,
        "subject": "",
        "text": f"Took tests in {n} chapters without opening the study material.",
        "share": (f"has taken tests in {n} chapters without reading the "
                  f"study material first."),
    }


def _rule_read_not_tested(r, sig, ctx):
    """Studies and won't test. Usually anxiety, occasionally a blocked account.

    Nobody else in the market can see this state at all, and it is the one
    where a teacher's five-minute conversation has the highest return.
    """
    n = int(sig.get("studio_read_not_tested_count") or 0)
    if n < 3:
        return None
    names = [c["chapter_name"] for c in
             (sig.get("studio_read_not_tested") or [])[:2] if c.get("chapter_name")]
    tail = f" ({', '.join(names)}…)" if names else ""
    subs = {canon_subject(c.get("subject"))
            for c in (sig.get("studio_read_not_tested") or [])}
    subs.discard("Unassigned")
    return {
        "kind": "read_not_tested",
        "severity": 58,
        "subject": subs.pop() if len(subs) == 1 else "",
        "text": f"Read {n} chapters but hasn't taken a test on any of them{tail}.",
        "share": (f"has read {n} chapters in the study material but not "
                  f"taken a single test on them."),
    }


def _rule_failed_retakes(r, sig, ctx):
    n = int(r.get("failed_retake_count", 0) or 0)
    if n < 2:
        return None
    return {
        "kind": "failed_retakes",
        "severity": 64,
        "subject": "",
        "text": f"Got {n} questions wrong again on the retake.",
        "share": f"failed {n} questions a second time on retaking them.",
    }


def _rule_arena_low(r, sig, ctx):
    """Full-paper score, with the subject split a NEET teacher manages against."""
    a = sig.get("arena_last")
    if not a or a.get("marks") is None:
        return None
    marks = a["marks"]
    mx = a.get("max_marks") or 720
    if mx and marks > mx * 0.35:
        return None
    subs = a.get("subjects") or {}
    worst = ""
    if subs:
        try:
            k = min(subs, key=lambda s: subs[s].get("marks", 999))
            worst = f" — {canon_subject(k)} {subs[k]['marks']}/{subs[k].get('max', 180)}"
        except Exception:
            worst = ""
    yr = f" ({a['year']} paper)" if a.get("year") else ""
    return {
        "kind": "arena_low",
        "severity": 66,
        "subject": canon_subject(min(subs, key=lambda s: subs[s].get("marks", 999)))
                   if subs else "",
        "text": f"Scored {marks}/{mx} on the full paper{yr}{worst}.",
        "share": f"scored {marks}/{mx} on the {a.get('year', '')} full paper{worst}.",
    }


def _rule_broke_streak(r, sig, ctx):
    longest = int(r.get("streak_longest", 0) or 0)
    current = int(r.get("streak_current", 0) or 0)
    if longest < 14 or current > 0:
        return None
    return {
        "kind": "streak_broken",
        "severity": 45,
        "subject": "",
        "text": f"Broke a {longest}-day daily streak.",
        "share": f"has broken a {longest}-day study streak.",
    }


RULES = [
    _rule_inactive,
    _rule_never_started,
    _rule_low_streak,
    _rule_forgetting,
    _rule_rushing,
    _rule_arena_low,
    _rule_failed_retakes,
    _rule_tested_blind,
    _rule_read_not_tested,
    _rule_broke_streak,
]


def flags_for(rollup, ctx):
    """All flags for one student, most urgent first.

    ctx carries class-relative context the rules need:
        class_pace_median   the class's own median seconds-per-question
        meta                chapter_meta(), for chapter → subject
    """
    sig = rollup.get("signals") or {}
    out = []
    for rule in RULES:
        try:
            f = rule(rollup, sig, ctx)
            if f:
                f["subject"] = canon_subject(f["subject"]) if f["subject"] else ""
                out.append(f)
        except Exception as e:
            print(f"[flags] rule {rule.__name__} failed: {e}")
    out.sort(key=lambda f: -f["severity"])
    return out


def class_pace_median(rollups):
    """Median seconds-per-question across students with a real sample.

    Median, not mean: one student who left a tab open for two hours drags
    a mean far enough to hide everyone who is actually rushing.
    """
    vals = sorted(
        (r.get("signals", {}) or {}).get("pace_seconds_per_q")
        for r in rollups
        if ((r.get("signals", {}) or {}).get("pace_sample") or 0) >= MIN_PACE_Q
        and (r.get("signals", {}) or {}).get("pace_seconds_per_q")
    )
    vals = [v for v in vals if v]
    if len(vals) < 5:
        return None          # too few to define a class norm
    mid = len(vals) // 2
    return vals[mid] if len(vals) % 2 else round((vals[mid - 1] + vals[mid]) / 2, 1)