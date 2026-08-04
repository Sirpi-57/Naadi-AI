"""
NAADI AI — CONCEPT AGGREGATE BUILDER  (concept_stats.py)
═══════════════════════════════════════════════════════════════════════════

Nightly. Builds the class-wide concept and question statistics that the
Concepts tab's Phase 2 blocks read.

    python3 concept_stats.py                 # every class
    python3 concept_stats.py --class 2026_12-A
    python3 concept_stats.py --dry-run

───────────────────────────────────────────────────────────────────────────
WHY AN AGGREGATE AT ALL

Everything on the Concepts tab that comes off student_rollups is live and
costs the 50 reads the teacher portal already pays. Four things cannot be:

  the distractor the class converges on   student_answer + options_detail
  what the class does not know            tested_fact
  the difficulty cliff                    difficulty per question
  did reteaching work                     concept_mastery_history

All four live inside test_sessions.questions[] or user_progress, which for
a class of fifty across eighty-three chapters is roughly 1,500 documents
with embedded arrays plus 4,150 progress documents. That is a perfectly
reasonable nightly job and an impossible page load.

───────────────────────────────────────────────────────────────────────────
DOCUMENT LAYOUT, AND WHY IT IS SPLIT

A class of fifty with eighty-three chapters has on the order of 2,500
concepts and 8,000 questions. One document would blow Firestore's 1 MiB
limit, silently, some time after the pilot grows -- so the split is by
SUBJECT, which is also how the page is browsed:

    class_concept_stats/{class_key}                       meta
    class_concept_stats/{class_key}/concepts/{subject}    concept map
    class_concept_stats/{class_key}/questions/{subject}   question map

Three subjects is seven documents per class. A subject teacher reads
three of them; a class teacher reads the meta doc and nothing else.

Each writer checks its own serialised size and drops its lowest-value
rows if it would exceed the limit, rather than letting the write fail.

───────────────────────────────────────────────────────────────────────────
WHAT IS DELIBERATELY NOT AGGREGATED

Papers (pyq_sessions) carry subject and chapter but NO concept_id, so
Arena data can inform chapter-level weakness and never concept-level.
Including it would mean inventing a concept mapping, and a made-up
mapping is worse than an absent number.
"""

import argparse
import json
import os
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone

import firebase_admin
from firebase_admin import credentials, firestore

# ── Firebase init, BEFORE portal_backend is imported ──────────────────
# This is a standalone script. backend.py calls initialize_app() when it
# is imported by the web app; nothing does it here, so portal_backend's
# _db() reached firestore.client() with no default app and raised
#
#   ValueError: The default Firebase app does not exist.
#
# Same order and same guard as portal_scripts.py, which is the other
# script that runs outside the Flask process.
SERVICE_ACCOUNT_PATH = os.environ.get("FIREBASE_SERVICE_ACCOUNT",
                                      "serviceAccountKey.json")
if not firebase_admin._apps:
    if os.path.exists(SERVICE_ACCOUNT_PATH):
        firebase_admin.initialize_app(credentials.Certificate(SERVICE_ACCOUNT_PATH))
    else:
        firebase_admin.initialize_app()

# Imported AFTER firebase init — portal_backend gets its handle lazily.
from portal_backend import _db, chapter_meta  # noqa: E402

# Firestore's hard limit is 1 MiB. 800 KB leaves room for the field names
# and the timestamp the SDK adds.
MAX_DOC_BYTES = 800_000

# A class-level number needs a class-level sample. One student answering
# eight questions is not the class knowing something.
MIN_CLASS_ANSWERS = 15
MIN_CLASS_STUDENTS = 3

# A distractor is "the one they converge on" only if enough of them chose
# it. Two students picking C is a coincidence.
MIN_CONVERGENCE = 3


def _gates(class_size):
    """Gates scaled to the class, never below every student in it.

    A hard floor of three students hides every number from a class of
    two, which makes the whole analysis unevaluable during a pilot. The
    rule is "everyone, or three, whichever is smaller": with fifty it is
    three and nothing changes; with two it is two, which still refuses a
    finding built on one person.

    The ANSWERS floor never bends -- fifteen questions is fifteen
    questions however few people supplied them -- and the built document
    records which gates were actually used so the page can say so.
    """
    n = max(1, int(class_size or 0) or 1)
    small = n < MIN_CLASS_STUDENTS
    return {"answers": MIN_CLASS_ANSWERS,
            # Below the normal threshold the student gate drops to one
            # and the ANSWERS floor does the work. Requiring every
            # student instead made a class of two stricter than a class
            # of one, because two students studying different chapters
            # share almost no concepts.
            "students": MIN_CLASS_STUDENTS if not small else 1,
            # Convergence is the exception: one student picking an
            # option is not convergence at any class size, so this floor
            # never goes below two.
            "convergence": MIN_CONVERGENCE if not small else 2,
            "small_class": small}

# Gemini's failure string, persisted like any other diagnosis.
DEAD_DIAGNOSIS = "unable to diagnose"

# Ceilings per subject document. Ranked before truncation, so what
# survives is what a teacher would have looked at anyway.
MAX_CONCEPTS = 400
MAX_QUESTIONS = 300
MAX_FACTS_PER_CONCEPT = 6
MAX_MISCONCEPTIONS = 4
MAX_TREND_POINTS = 12


def _now():
    return datetime.now(timezone.utc).isoformat()


def _s(v, limit=200):
    if v is None:
        return ""
    if isinstance(v, str):
        return v[:limit]
    if isinstance(v, (int, float, bool)):
        return str(v)
    if isinstance(v, dict):
        for k in ("explanation", "text", "reason", "detail", "why"):
            if v.get(k):
                return _s(v[k], limit)
        return ""
    if isinstance(v, (list, tuple)):
        return " ".join(x for x in (_s(i, limit) for i in v) if x)[:limit]
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


def _canon(sub):
    s = _s(sub, 40).strip().lower()
    if s.startswith("bio"):
        return "Biology"
    if s.startswith("chem"):
        return "Chemistry"
    if s.startswith("phy"):
        return "Physics"
    return "Unassigned"


def _size(obj):
    try:
        return len(json.dumps(obj, default=str).encode("utf-8"))
    except Exception:
        return MAX_DOC_BYTES + 1


# ═══════════════════════════════════════════════════════════════════════
# THE BUILDER
# ═══════════════════════════════════════════════════════════════════════

class ClassStats:
    """Accumulates every per-question and per-concept fact for one class."""

    def __init__(self, class_key, meta, gates=None):
        self.class_key = class_key
        self.meta = meta or {}
        self.gates = gates or _gates(0)
        # concept_id -> accumulator
        self.concepts = defaultdict(lambda: {
            "name": "", "chapter_id": "", "subject": "Unassigned",
            "students": set(), "answers": 0, "correct": 0,
            "by_difficulty": defaultdict(lambda: {"n": 0, "ok": 0}),
            "facts": defaultdict(lambda: {"n": 0, "wrong": 0}),
            "lost_students": set(),
            "misconceptions": Counter(),
            "misconception_detail": {},
            "trend": defaultdict(lambda: {"sum": 0.0, "n": 0}),
            "types": defaultdict(lambda: {"n": 0, "ok": 0}),
        })
        # base_question_id -> accumulator
        self.questions = defaultdict(lambda: {
            "text": "", "concept_id": "", "chapter_id": "",
            "subject": "Unassigned", "correct_answer": "",
            "asked": 0, "wrong": 0, "students": set(),
            "picks": Counter(), "why": {}, "fact": "", "difficulty": "",
            "type": "single_correct",
        })
        self.sessions = 0
        self.students = 0

    # ── one completed OPD session ─────────────────────────────────────
    def add_session(self, s):
        uid = _s(s.get("user_id"), 80)
        chid = _s(s.get("chapter_id"), 200)
        m = self.meta.get(chid) or {}
        subject = _canon(m.get("subject") or chid.split("_")[0])
        self.sessions += 1

        for q in _seq(s.get("questions")):
            if not isinstance(q, dict):
                continue
            cid = _s(q.get("concept_id"), 200)
            bid = _s(q.get("base_question_id"), 200)
            ok = q.get("is_correct") is True
            ans = _s(q.get("student_answer"), 40)
            diff = _s(q.get("difficulty"), 20) or "Unknown"
            fact = _s(q.get("tested_fact"), 240)
            qtype = _s(q.get("question_type"), 40) or "single_correct"

            if cid:
                c = self.concepts[cid]
                c["name"] = c["name"] or _s(q.get("concept_name"), 160)
                c["chapter_id"] = c["chapter_id"] or chid
                c["subject"] = subject
                c["students"].add(uid)
                c["answers"] += 1
                c["correct"] += 1 if ok else 0
                d = c["by_difficulty"][diff]
                d["n"] += 1
                d["ok"] += 1 if ok else 0
                t = c["types"][qtype]
                t["n"] += 1
                t["ok"] += 1 if ok else 0
                if fact:
                    f = c["facts"][fact]
                    f["n"] += 1
                    f["wrong"] += 0 if ok else 1

            if not bid:
                continue
            qq = self.questions[bid]
            qq["text"] = qq["text"] or _s(q.get("question_text"), 400)
            qq["concept_id"] = qq["concept_id"] or cid
            qq["chapter_id"] = qq["chapter_id"] or chid
            qq["subject"] = subject
            qq["correct_answer"] = qq["correct_answer"] or _s(
                q.get("correct_answer"), 40)
            qq["fact"] = qq["fact"] or fact
            qq["difficulty"] = qq["difficulty"] or diff
            qq["type"] = qtype
            qq["asked"] += 1
            qq["students"].add(uid)
            if not ok:
                qq["wrong"] += 1
                if ans:
                    qq["picks"][ans] += 1
                    # THE POINT OF THIS WHOLE FILE. Every distractor
                    # carries its own why-it-is-wrong in the question
                    # bank, and nothing has ever shown it to a teacher
                    # next to how many students chose it.
                    if ans not in qq["why"]:
                        for o in _seq(q.get("options_detail")):
                            if not isinstance(o, dict):
                                continue
                            if _s(o.get("id"), 8) == ans:
                                qq["why"][ans] = {
                                    "text": _s(o.get("text"), 240),
                                    "why": _s(o.get("explanation"), 400),
                                }
                                break

    # ── a rollup: the v3 audit failures, already denormalised ─────────
    def add_rollup(self, r):
        uid = _s(r.get("uid"), 80)
        ret = r.get("retention") if isinstance(r.get("retention"), dict) else {}
        for fr in _seq(ret.get("false_recoveries")):
            if not isinstance(fr, dict):
                continue
            cid = _s(fr.get("concept_id"), 200)
            if not cid:
                continue
            c = self.concepts[cid]
            c["lost_students"].add(uid)
            if not c["chapter_id"]:
                chid = _s(fr.get("chapter_id"), 200)
                c["chapter_id"] = chid
                c["subject"] = _canon((self.meta.get(chid) or {}).get("subject")
                                      or chid.split("_")[0])
        # per_concept fills in names for concepts no session covered.
        per = r.get("per_concept") if isinstance(r.get("per_concept"), dict) else {}
        for cid, pc in per.items():
            if not isinstance(pc, dict):
                continue
            c = self.concepts[cid]
            if not c["name"]:
                c["name"] = _s(pc.get("n"), 160)
            if not c["chapter_id"]:
                chid = _s(pc.get("c"), 200)
                c["chapter_id"] = chid
                c["subject"] = _canon((self.meta.get(chid) or {}).get("subject")
                                      or chid.split("_")[0])

    # ── an AI diagnosis ───────────────────────────────────────────────
    def add_diagnosis(self, d):
        diag = d.get("diagnosis")
        if not isinstance(diag, dict):
            return
        text = _s(diag.get("misconception"), 400).strip()
        # On a model failure backend.py persists "Unable to diagnose
        # automatically". Rendered naively, a teacher reads that sentence
        # as the finding.
        if not text or DEAD_DIAGNOSIS in text.lower():
            return
        cid = _s(d.get("concept_id"), 200)
        if not cid:
            return
        c = self.concepts[cid]
        key = text[:160].strip().lower()
        c["misconceptions"][key] += 1
        if key not in c["misconception_detail"]:
            c["misconception_detail"][key] = {
                "text": text,
                "explanation": _s(diag.get("explanation"), 600),
                "trick": _s(diag.get("memory_trick"), 300),
            }

    # ── mastery over time, per concept ────────────────────────────────
    def add_progress(self, p):
        for entry in _seq(p.get("concept_mastery_history")):
            if not isinstance(entry, dict):
                continue
            tn = _i(entry.get("test_num"), None)
            if tn is None:
                continue
            by = entry.get("mastery_by_concept")
            if not isinstance(by, dict):
                continue
            for cid, score in by.items():
                v = _i(score, None)
                if v is None:
                    continue
                t = self.concepts[_s(cid, 200)]["trend"][tn]
                t["sum"] += v
                t["n"] += 1

    # ── serialise ─────────────────────────────────────────────────────
    def concept_rows(self, subject):
        out = []
        for cid, c in self.concepts.items():
            if c["subject"] != subject:
                continue
            answers, students = c["answers"], len(c["students"])
            # A percentage below the gate is a coin flip with a decimal
            # point. None is the honest value and the client renders it
            # as "not enough asked yet".
            pct = (round(c["correct"] / answers * 100, 1)
                   if answers >= self.gates["answers"]
                   and students >= self.gates["students"] else None)
            facts = sorted(
                ({"fact": f, "asked": v["n"], "wrong": v["wrong"]}
                 for f, v in c["facts"].items() if v["wrong"] > 0),
                key=lambda x: -x["wrong"])[:MAX_FACTS_PER_CONCEPT]
            mis = [dict(c["misconception_detail"][k], students=n)
                   for k, n in c["misconceptions"].most_common(MAX_MISCONCEPTIONS)]
            trend = sorted(
                ({"test_num": tn, "avg": round(v["sum"] / v["n"], 1)}
                 for tn, v in c["trend"].items() if v["n"]),
                key=lambda x: x["test_num"])[-MAX_TREND_POINTS:]
            diffs = {k: {"asked": v["n"],
                         "pct": (round(v["ok"] / v["n"] * 100, 1)
                                 if v["n"] >= 8 else None)}
                     for k, v in c["by_difficulty"].items()}
            types = {k: {"asked": v["n"],
                         "pct": (round(v["ok"] / v["n"] * 100, 1)
                                 if v["n"] >= 8 else None)}
                     for k, v in c["types"].items()}
            out.append({
                "concept_id": cid,
                "name": c["name"] or cid,
                "chapter_id": c["chapter_id"],
                "chapter": _s((self.meta.get(c["chapter_id"]) or {})
                              .get("chapter_title"), 120) or c["chapter_id"],
                "students": students,
                "answers": answers,
                "pct": pct,
                "lost": len(c["lost_students"]),
                "by_difficulty": diffs,
                "by_type": types,
                "facts": facts,
                "misconceptions": mis,
                "trend": trend,
            })
        # Weakest and most-lost first, so truncation removes the rows a
        # teacher was never going to scroll to.
        out.sort(key=lambda x: (-(x["lost"] or 0),
                                x["pct"] if x["pct"] is not None else 101,
                                -x["answers"]))
        return out[:MAX_CONCEPTS]

    def question_rows(self, subject):
        out = []
        for bid, q in self.questions.items():
            if q["subject"] != subject:
                continue
            if q["asked"] < self.gates["convergence"]:
                continue
            top = None
            if q["picks"]:
                opt, n = q["picks"].most_common(1)[0]
                if n >= self.gates["convergence"]:
                    d = q["why"].get(opt) or {}
                    top = {"option": opt, "students": n,
                           "text": d.get("text", ""), "why": d.get("why", "")}
            out.append({
                "base_id": bid,
                "text": q["text"],
                "concept_id": q["concept_id"],
                "chapter_id": q["chapter_id"],
                "chapter": _s((self.meta.get(q["chapter_id"]) or {})
                              .get("chapter_title"), 120) or q["chapter_id"],
                "correct_answer": q["correct_answer"],
                "asked": q["asked"],
                "wrong": q["wrong"],
                "students": len(q["students"]),
                "wrong_pct": round(q["wrong"] / q["asked"] * 100, 1),
                "picks": dict(q["picks"]),
                "top_wrong": top,
                "fact": q["fact"],
                "difficulty": q["difficulty"],
                "type": q["type"],
            })
        # A trap question is one the class gets wrong more than right.
        out.sort(key=lambda x: (-x["wrong_pct"], -x["asked"]))
        return out[:MAX_QUESTIONS]


def _trim_to_fit(rows, key):
    """Drop lowest-ranked rows until the payload fits.

    Rows arrive already sorted worst-first, so what goes is what a
    teacher would not have scrolled to. Silently failing the write
    instead would leave yesterday's numbers on screen with no way to
    tell.
    """
    dropped = 0
    while rows and _size({key: rows}) > MAX_DOC_BYTES:
        rows.pop()
        dropped += 1
    return rows, dropped


def build_class(class_key, db, meta, dry_run=False):
    t0 = time.time()
    roster = [dict(d.to_dict() or {}, uid=d.id) for d in
              db.collection("student_rollups")
                .where("class_key", "==", class_key).stream()]
    # Gates are decided from the roster, so they have to be read first.
    gates = _gates(len(roster))
    stats = ClassStats(class_key, meta, gates)
    stats.students = len(roster)
    uids = [r["uid"] for r in roster if r.get("uid")]
    if not uids:
        return {"class_key": class_key, "students": 0, "skipped": "no students"}

    for r in roster:
        stats.add_rollup(r)

    # Firestore's `in` takes ten values, so everything keyed on user_id
    # is chunked rather than queried per student.
    def chunks(seq, n=10):
        for i in range(0, len(seq), n):
            yield seq[i:i + n]

    for group in chunks(uids):
        try:
            for d in (db.collection("test_sessions")
                        .where("user_id", "in", group)
                        .where("status", "==", "completed").stream()):
                stats.add_session(d.to_dict() or {})
        except Exception as e:
            print(f"    test_sessions chunk failed: {type(e).__name__}: {e}")
        try:
            for d in (db.collection("ai_interventions")
                        .where("user_id", "in", group)
                        .where("type", "==", "diagnosis").stream()):
                stats.add_diagnosis(d.to_dict() or {})
        except Exception as e:
            # A missing composite index surfaces here and nowhere else.
            print(f"    ai_interventions chunk failed: {type(e).__name__}: {e}")
        try:
            for d in (db.collection("user_progress")
                        .where("user_id", "in", group).stream()):
                stats.add_progress(d.to_dict() or {})
        except Exception as e:
            print(f"    user_progress chunk failed: {type(e).__name__}: {e}")

    subjects = sorted({c["subject"] for c in stats.concepts.values()
                       if c["subject"] != "Unassigned"})
    report = {"class_key": class_key, "students": stats.students,
              "sessions": stats.sessions, "subjects": {}, "gates": gates}

    ref = db.collection("class_concept_stats").document(class_key)
    for sub in subjects:
        crows, cdrop = _trim_to_fit(stats.concept_rows(sub), "concepts")
        qrows, qdrop = _trim_to_fit(stats.question_rows(sub), "questions")
        report["subjects"][sub] = {
            "concepts": len(crows), "questions": len(qrows),
            "dropped": cdrop + qdrop,
            "with_score": sum(1 for c in crows if c["pct"] is not None),
            "with_misconception": sum(1 for c in crows if c["misconceptions"]),
            "with_convergence": sum(1 for q in qrows if q["top_wrong"]),
            "lost": sum(1 for c in crows if c["lost"]),
        }
        if dry_run:
            continue
        ref.collection("concepts").document(sub).set({
            "subject": sub, "concepts": crows,
            "built_at": _now(), "gates": gates,
        })
        ref.collection("questions").document(sub).set({
            "subject": sub, "questions": qrows,
            "built_at": _now(), "min_convergence": gates["convergence"],
        })

    if not dry_run:
        ref.set({
            "class_key": class_key,
            "students": stats.students,
            "sessions_scanned": stats.sessions,
            "subjects": subjects,
            "gates": gates,
            "built_at": _now(),
            "build_seconds": round(time.time() - t0, 1),
            "at": firestore.SERVER_TIMESTAMP,
        }, merge=True)

    report["seconds"] = round(time.time() - t0, 1)
    return report


def main(only=None, dry_run=False):
    db = _db()
    meta = chapter_meta(force=True)
    keys = ([only] if only else
            [d.id for d in db.collection("classes").stream()])
    print(f"{len(keys)} class(es). dry_run={dry_run}\n")

    failed = 0
    for key in keys:
        try:
            rep = build_class(key, db, meta, dry_run)
            if rep.get("skipped"):
                print(f"  {key}: skipped ({rep['skipped']})")
                continue
            g = rep["gates"]
            print(f"  {key}: {rep['students']} students, "
                  f"{rep['sessions']} sessions, {rep['seconds']}s")
            print(f"      gates: {g['answers']} answers · "
                  f"{g['students']} students · "
                  f"{g['convergence']} for convergence"
                  + ("   [SMALL CLASS — real numbers, but they describe "
                     "these students, not a class pattern]"
                     if g["small_class"] else ""))
            for sub, s in rep["subjects"].items():
                print(f"      {sub:10s} {s['concepts']:4d} concepts "
                      f"({s['with_score']} scored, {s['lost']} lost, "
                      f"{s['with_misconception']} diagnosed) · "
                      f"{s['questions']:4d} questions "
                      f"({s['with_convergence']} converging)"
                      + (f" · {s['dropped']} dropped to fit" if s["dropped"] else ""))
        except Exception as e:
            failed += 1
            print(f"  {key}: FAILED {type(e).__name__}: {e}")

    print(f"\n{'=' * 58}\n  {len(keys) - failed} built, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--class", dest="only", default=None)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    sys.exit(main(a.only, a.dry_run))